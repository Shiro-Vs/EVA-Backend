import { sql } from 'kysely';
import { formatISO, parseISO } from '../domain/localDate.js';
import { ceilDiv, formatMoney, parseMoney } from '../domain/money.js';
import { notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { checkPreviewToken, makePreviewToken } from '../infra/preview.js';
import { ts, type Ctx } from './context.js';
import { convertDebtToLoan, type ConversionTrigger } from './loans.js';
import { insertPlannedRefund } from './refunds.js';
import { getSeat } from './seats.js';
import { syncSubscription } from './sync.js';

/** `finish_cycle`: la persona termina el ciclo en curso. `immediate`: la baja es hoy con cobro proporcional (RN-X02/X03). */
export type ExitMode = 'finish_cycle' | 'immediate';
export type ExitCode = 'SUPPLIER_PAID' | 'NO_LIMIT_DEFINED' | 'LIMIT_REACHED' | 'EARLY_EXIT' | 'FORCED_CYCLE_END';

export interface ExitOptions {
  /** Fuerza terminar el ciclo (cambio a individual: se ejecuta en el siguiente corte, RN-X08). */
  forceFinishCycle?: boolean;
  trigger?: ConversionTrigger;
}

interface SeatInfo { id: string; label: string; subscription_id: string; membership_id: string; start_date: string; end_date: string | null; is_owner: boolean; contact_id: string | null; contact_name: string | null }
interface CycleInfo { id: string; start_date: string; end_date: string; terms_snapshot: { baseDays: number } }
interface ChargeInfo {
  obligation_id: string; cycle_id: string; start_date: string; end_date: string; mode: string; quota_snapshot: string;
  issued: string; adjustments: string; applied: string; pending: string;
}
interface Alloc { id: string; receipt_id: string; amount: string }

interface ReleaseStep { allocationId: string; receiptId: string; amount: bigint; reapply: bigint }

/** Libera aplicaciones, las más recientes primero, hasta cubrir `excess`; si una libera de más, el resto se vuelve a aplicar. */
export function planRelease(allocs: Array<{ id: string; receiptId: string; amount: bigint }>, excess: bigint): ReleaseStep[] {
  const steps: ReleaseStep[] = [];
  let left = excess;
  for (const a of allocs) {
    if (left <= 0n) break;
    if (a.amount > left) { steps.push({ allocationId: a.id, receiptId: a.receiptId, amount: a.amount, reapply: a.amount - left }); left = 0n; }
    else { steps.push({ allocationId: a.id, receiptId: a.receiptId, amount: a.amount, reapply: 0n }); left -= a.amount; }
  }
  return steps;
}

interface Plan {
  seat: SeatInfo;
  cycle: CycleInfo;
  mode: ExitMode;
  code: ExitCode;
  usedDays: number;
  limit: number | null;
  supplierPaid: boolean;
  effectiveOn: string;
  current: { obligationId: string; net: bigint; target: bigint; adjustment: bigint } | null;
  voids: ChargeInfo[];
  releases: Array<{ obligationId: string; steps: ReleaseStep[] }>;
  refunds: Map<string, bigint>;
  debt: Array<{ obligationId: string; start: string; end: string; pending: bigint }>;
  fingerprint: unknown;
}

const money = (v: string) => parseMoney(v, { allowNegative: true });

async function buildPlan(ctx: Ctx, seatId: string, opts: ExitOptions): Promise<Plan> {
  const seat = await one<SeatInfo>(ctx.trx, sql<SeatInfo>`
    select s.id, s.label, s.subscription_id, s.membership_id, s.start_date, s.end_date, m.is_owner, m.contact_id, c.name as contact_name
    from seat s join membership m on m.id = s.membership_id and m.owner_id = s.owner_id
    left join contact c on c.id = m.contact_id and c.owner_id = m.owner_id
    where s.owner_id = ${ctx.ownerId} and s.id = ${seatId}`);
  if (!seat) throw notFound('Seat');
  if (seat.is_owner) throw unprocessable('EXIT_OWNER_SEAT', 'Your own seat cannot be removed');
  if (seat.end_date) throw unprocessable('SEAT_ALREADY_ENDING', 'The seat already has an exit date', { endDate: seat.end_date });
  await syncSubscription(ctx, seat.subscription_id);

  const today = formatISO(ctx.today);
  const cycle = await one<CycleInfo>(ctx.trx, sql<CycleInfo>`
    select id, start_date, end_date, terms_snapshot from billing_cycle
    where owner_id = ${ctx.ownerId} and subscription_id = ${seat.subscription_id} and start_date <= ${today}::date and end_date > ${today}::date`);
  if (!cycle) throw unprocessable('NO_CURRENT_CYCLE', 'There is no current cycle (is the subscription suspended?)');

  const paid = await one(ctx.trx, sql`select 1 from supplier_payment where owner_id = ${ctx.ownerId} and cycle_id = ${cycle.id} and status = 'active'`);
  const prof = await one<{ exit_days_limit: number | null }>(ctx.trx, sql<{ exit_days_limit: number | null }>`select exit_days_limit from user_profile where id = ${ctx.ownerId}`);
  const limit = prof!.exit_days_limit;
  const from = seat.start_date > cycle.start_date ? seat.start_date : cycle.start_date;
  const usedDays = ctx.today - parseISO(from);

  let mode: ExitMode; let code: ExitCode;
  if (opts.forceFinishCycle) { mode = 'finish_cycle'; code = 'FORCED_CYCLE_END'; }
  else if (paid) { mode = 'finish_cycle'; code = 'SUPPLIER_PAID'; } // RN-X02: tiene prioridad sobre la salida temprana
  else if (limit === null) { mode = 'finish_cycle'; code = 'NO_LIMIT_DEFINED'; }
  else if (usedDays < limit) { mode = 'immediate'; code = 'EARLY_EXIT'; } // RN-X03: u < L
  else { mode = 'finish_cycle'; code = 'LIMIT_REACHED'; } // la igualdad termina el ciclo
  const effectiveOn = mode === 'immediate' ? today : cycle.end_date;

  const charges = await rows<ChargeInfo>(ctx.trx, sql<ChargeInfo>`
    select b.obligation_id, c.id as cycle_id, c.start_date, c.end_date, mc.mode, mc.quota_snapshot,
           b.issued_amount as issued, b.adjustments_total as adjustments, b.applied_total as applied, b.pending_amount as pending
    from member_charge mc
    join v_obligation_balance b on b.obligation_id = mc.obligation_id
    join billing_cycle c on c.id = mc.cycle_id and c.owner_id = mc.owner_id
    where mc.owner_id = ${ctx.ownerId} and mc.seat_id = ${seatId} and mc.status = 'issued' order by c.start_date, b.obligation_id`);
  if (charges.length > 0) {
    await rows(ctx.trx, sql`select id from receivable_obligation where owner_id = ${ctx.ownerId} and id = any(${charges.map((c) => c.obligation_id).sort()}::uuid[]) order by id for update`);
  }
  const allocsOf = async (obligationId: string) => (await rows<Alloc>(ctx.trx, sql<Alloc>`
    select id, receipt_id, amount from payment_allocation where owner_id = ${ctx.ownerId} and obligation_id = ${obligationId} and status = 'active' order by created_at desc, id`))
    .map((a) => ({ id: a.id, receiptId: a.receipt_id, amount: parseMoney(a.amount) }));

  // Ciclos posteriores al actual: se cancelan y todo lo aplicado se libera (RN-X05: los anticipos siempre se devuelven).
  const voids = charges.filter((c) => c.start_date >= cycle.end_date);
  const releases: Plan['releases'] = [];
  for (const v of voids) {
    const allocs = await allocsOf(v.obligation_id);
    if (allocs.length > 0) releases.push({ obligationId: v.obligation_id, steps: planRelease(allocs, allocs.reduce((a, x) => a + x.amount, 0n)) });
  }

  // Ciclo en curso: en baja inmediata el cargo baja a `ceil_sol(Q × u / B)` y lo cobrado de más se libera (RN-X04).
  let current: Plan['current'] = null;
  const cur = charges.find((c) => c.cycle_id === cycle.id);
  const remaining = charges.filter((c) => c.start_date < cycle.end_date);
  const pendingAfter = new Map<string, bigint>(remaining.map((c) => [c.obligation_id, parseMoney(c.pending)]));
  if (mode === 'immediate' && cur) {
    const base = parseMoney(cur.issued) + money(cur.adjustments);
    const prorated = ceilDiv(parseMoney(cur.quota_snapshot) * BigInt(usedDays), BigInt(cycle.terms_snapshot.baseDays) * 100n) * 100n;
    const target = prorated < base ? prorated : base;
    current = { obligationId: cur.obligation_id, net: base, target, adjustment: target - base };
    const applied = parseMoney(cur.applied);
    const excess = applied > target ? applied - target : 0n;
    if (excess > 0n) releases.push({ obligationId: cur.obligation_id, steps: planRelease(await allocsOf(cur.obligation_id), excess) });
    pendingAfter.set(cur.obligation_id, target > applied ? target - applied : 0n);
  }

  const refunds = new Map<string, bigint>();
  for (const r of releases) for (const s of r.steps) refunds.set(s.receiptId, (refunds.get(s.receiptId) ?? 0n) + s.amount - s.reapply);

  const debt = remaining
    .map((c) => ({ obligationId: c.obligation_id, start: c.start_date, end: c.end_date, pending: pendingAfter.get(c.obligation_id) ?? 0n }))
    .filter((d) => d.pending > 0n);

  const fingerprint = { mode, effectiveOn, cycle: cycle.id, charges: charges.map((c) => `${c.obligation_id}:${c.pending}:${c.applied}:${c.adjustments}`) };
  return { seat, cycle, mode, code, usedDays, limit, supplierPaid: !!paid, effectiveOn, current, voids, releases, refunds, debt, fingerprint };
}

const inputsOf = (seatId: string, opts: ExitOptions) => ({ seatId, forceFinishCycle: !!opts.forceFinishCycle, trigger: opts.trigger ?? 'exit' });

function previewJson(p: Plan, ctx: Ctx) {
  const m = (v: bigint) => formatMoney(v);
  const refundTotal = [...p.refunds.values()].reduce((a, x) => a + x, 0n);
  const loanTotal = p.debt.reduce((a, d) => a + d.pending, 0n);
  const warnings: string[] = [];
  if (refundTotal > 0n && loanTotal > 0n) warnings.push('REFUND_AND_DEBT'); // se puede cancelar la devolución y aplicar el crédito al préstamo
  return {
    seat: { id: p.seat.id, label: p.seat.label, contact: p.seat.contact_id ? { id: p.seat.contact_id, name: p.seat.contact_name } : null },
    requestedOn: formatISO(ctx.today),
    effectiveOn: p.effectiveOn,
    mode: p.mode,
    reasonCode: p.code,
    usedDays: p.usedDays,
    exitDaysLimit: p.limit,
    supplierPaid: p.supplierPaid,
    currentCycle: { id: p.cycle.id, start: p.cycle.start_date, end: p.cycle.end_date },
    currentCharge: p.current ? { obligationId: p.current.obligationId, netBefore: m(p.current.net), chargeAfter: m(p.current.target), adjustment: m(p.current.adjustment) } : null,
    voidedCharges: p.voids.map((v) => ({ obligationId: v.obligation_id, cycle: { start: v.start_date, end: v.end_date }, net: m(parseMoney(v.issued)), applied: m(parseMoney(v.applied)) })),
    refunds: { total: m(refundTotal), items: [...p.refunds.entries()].map(([receiptId, amount]) => ({ receiptId, amount: m(amount) })) },
    loan: loanTotal > 0n ? { total: m(loanTotal), components: p.debt.map((d) => ({ obligationId: d.obligationId, cycle: { start: d.start, end: d.end }, amount: m(d.pending) })) } : null,
    warnings,
  };
}

/** Plan de baja sin token: lo usan flujos que agrupan varias bajas (cambio a individual). */
export async function exitPreviewState(ctx: Ctx, seatId: string, opts: ExitOptions) {
  const p = await buildPlan(ctx, seatId, opts);
  return { json: previewJson(p, ctx), fingerprint: p.fingerprint, effectiveOn: p.effectiveOn };
}

export async function previewExit(ctx: Ctx, seatId: string, opts: ExitOptions = {}) {
  const p = await buildPlan(ctx, seatId, opts);
  return { ...previewJson(p, ctx), previewToken: makePreviewToken(ctx.previewSecret, { scope: 'seat.exit', ownerId: ctx.ownerId, inputs: inputsOf(seatId, opts), state: p.fingerprint }, ctx.nowMs) };
}

/** Ejecuta la baja de forma atómica (RN-X01…X07). Reutilizable por el cambio a individual con `forceFinishCycle`. */
export async function executeExit(ctx: Ctx, seatId: string, reason: string, previewToken: string | undefined, opts: ExitOptions = {}) {
  const p = await buildPlan(ctx, seatId, opts);
  if (previewToken !== undefined) {
    checkPreviewToken(ctx.previewSecret, previewToken, { scope: 'seat.exit', ownerId: ctx.ownerId, inputs: inputsOf(seatId, opts), state: p.fingerprint }, ctx.nowMs);
  }
  const why = reason.trim();
  const today = formatISO(ctx.today);

  if (p.current && p.current.adjustment < 0n) {
    await sql`
      insert into charge_adjustment (owner_id, obligation_id, amount, kind, due_date, reason, created_by)
      values (${ctx.ownerId}, ${p.current.obligationId}, ${formatMoney(p.current.adjustment)}, 'early_exit', ${today}, ${`Baja inmediata: ${why}`}, ${ctx.actorId})`.execute(ctx.trx);
  }
  for (const r of p.releases) {
    for (const s of r.steps) {
      await sql`
        update payment_allocation set status = 'released', released_reason = ${`Baja: ${why}`}, released_at = now()
        where owner_id = ${ctx.ownerId} and id = ${s.allocationId}`.execute(ctx.trx);
      if (s.reapply > 0n) {
        await sql`
          insert into payment_allocation (owner_id, receipt_id, obligation_id, amount, origin, created_by)
          values (${ctx.ownerId}, ${s.receiptId}, ${r.obligationId}, ${formatMoney(s.reapply)}, 'system', ${ctx.actorId})`.execute(ctx.trx);
      }
    }
  }
  for (const v of p.voids) {
    await sql`
      update member_charge set status = 'void', void_reason = ${`Baja de la plaza: ${why}`}, voided_at = now()
      where owner_id = ${ctx.ownerId} and obligation_id = ${v.obligation_id}`.execute(ctx.trx);
  }
  const refundIds: string[] = [];
  for (const [receiptId, amount] of p.refunds) {
    if (amount > 0n) refundIds.push(await insertPlannedRefund(ctx, { receiptId, contactId: p.seat.contact_id!, amount, reason: `Baja de ${p.seat.label}: ${why}` }));
  }

  // Lo que sigue pendiente pasa a un préstamo con detalle (RN-X07). El pendiente se relee de la base ya con los cambios aplicados.
  const stillOwed = await rows<{ obligation_id: string }>(ctx.trx, sql<{ obligation_id: string }>`
    select b.obligation_id from member_charge mc join v_obligation_balance b on b.obligation_id = mc.obligation_id
    where mc.owner_id = ${ctx.ownerId} and mc.seat_id = ${seatId} and mc.status = 'issued' and b.pending_amount > 0`);
  const loan = await convertDebtToLoan(ctx, { contactId: p.seat.contact_id!, obligationIds: stillOwed.map((x) => x.obligation_id), trigger: opts.trigger ?? 'exit', reason: `Baja de ${p.seat.label}: ${why}` });

  await sql`update seat set end_date = ${p.effectiveOn}::date where owner_id = ${ctx.ownerId} and id = ${seatId}`.execute(ctx.trx);
  const active = await one<{ n: string }>(ctx.trx, sql<{ n: string }>`select count(*) as n from seat where owner_id = ${ctx.ownerId} and membership_id = ${p.seat.membership_id} and end_date is null`);
  if (Number(active!.n) === 0) {
    const ended = p.effectiveOn <= today;
    await sql`
      update membership set status = ${ended ? 'ended' : 'ending'}, end_date = ${ended ? p.effectiveOn : null}, scheduled_end_date = ${ended ? null : p.effectiveOn}, end_reason = ${why}
      where owner_id = ${ctx.ownerId} and id = ${p.seat.membership_id}`.execute(ctx.trx);
  }
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'seat.exit', entityType: 'seat', entityId: seatId, reason: why,
    changes: { requestedOn: today, effectiveOn: p.effectiveOn, mode: p.mode, code: p.code, voided: p.voids.length, refunds: refundIds.length, loanId: loan?.id ?? null } });

  return {
    ...previewJson(p, ctx),
    executedAt: ts(new Date(ctx.nowMs)),
    refundIds,
    loanId: loan?.id ?? null,
    seat: await getSeat(ctx, seatId),
  };
}
