import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { formatISO } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { checkPreviewToken, makePreviewToken } from '../infra/preview.js';
import type { Ctx } from './context.js';
import { getSeat } from './seats.js';
import { syncSubscription } from './sync.js';

export interface QuotaChangeInput {
  newQuota: string;
  /** Inicio de un ciclo futuro (decisión 2 confirmada: la cuota solo cambia al inicio de un ciclo). */
  effectiveFrom: string;
  /** `per_renewal`: cada diferencia vence al inicio de su ciclo. `lump`: todas vencen hoy (RN-Q02). */
  mode: 'per_renewal' | 'lump';
  reason: string;
}

interface SeatInfo { id: string; subscription_id: string; is_owner: boolean; end_date: string | null; label: string; contact_id: string | null; contact_name: string | null }

interface ChargeRow {
  obligation_id: string; cycle_id: string; seq: number; start_date: string; end_date: string; quota_snapshot: string; pending: string; applied: string;
}

export interface Plan {
  seat: SeatInfo;
  termsId: string; oldQuota: bigint; newQuota: bigint; freeDays: number | null;
  items: Array<{ obligationId: string; cycleId: string; seq: number; start: string; end: string; amount: bigint; dueDate: string; pendingBefore: bigint; pendingAfter: bigint; creditFreed: bigint }>;
}

async function buildPlan(ctx: Ctx, seatId: string, i: QuotaChangeInput): Promise<Plan> {
  const seat = await one<SeatInfo>(ctx.trx, sql<SeatInfo>`
    select s.id, s.subscription_id, m.is_owner, s.end_date, s.label, m.contact_id, c.name as contact_name
    from seat s join membership m on m.id = s.membership_id and m.owner_id = s.owner_id
    left join contact c on c.id = m.contact_id and c.owner_id = m.owner_id
    where s.owner_id = ${ctx.ownerId} and s.id = ${seatId}`);
  if (!seat) throw notFound('Seat');
  if (seat.is_owner) throw unprocessable('QUOTA_OWNER_SEAT', 'Your own seat has no quota');
  if (seat.end_date) throw unprocessable('SEAT_ENDED', 'The seat has already ended');
  await syncSubscription(ctx, seat.subscription_id);

  const today = formatISO(ctx.today);
  if (i.effectiveFrom <= today) throw unprocessable('EFFECTIVE_DATE_PAST', 'The new quota can only start at a future cycle', { today });
  const starts = (await rows<{ start_date: string }>(ctx.trx, sql<{ start_date: string }>`
    select start_date from billing_cycle where owner_id = ${ctx.ownerId} and subscription_id = ${seat.subscription_id} and start_date > ${today}::date order by start_date`)).map((r) => r.start_date);
  if (!starts.includes(i.effectiveFrom)) {
    throw unprocessable('EFFECTIVE_DATE_NOT_CYCLE_START', 'The new quota can only start at the beginning of a cycle', { availableDates: starts });
  }

  const later = await one(ctx.trx, sql`select 1 from seat_terms where owner_id = ${ctx.ownerId} and seat_id = ${seatId} and valid_from >= ${i.effectiveFrom}::date`);
  if (later) throw unprocessable('QUOTA_CHANGE_EXISTS', 'There is already a quota change on or after that date');
  const cur = await one<{ id: string; quota: string; free_days_threshold: number | null }>(ctx.trx, sql<{ id: string; quota: string; free_days_threshold: number | null }>`
    select id, quota, free_days_threshold from seat_terms
    where owner_id = ${ctx.ownerId} and seat_id = ${seatId} and valid_from < ${i.effectiveFrom}::date and (valid_to is null or valid_to > ${i.effectiveFrom}::date)`);
  if (!cur) throw unprocessable('NO_QUOTA_AT_DATE', 'The seat has no quota defined at that date');
  const oldQuota = parseMoney(cur.quota);
  const newQuota = parseMoney(i.newQuota);
  if (newQuota === oldQuota) throw unprocessable('QUOTA_UNCHANGED', 'The new quota equals the current one');

  // Cargos ya emitidos de ciclos con inicio ≥ fecha efectiva: se ajustan en `nueva − cuota con que se emitieron` (RN-Q01, D-19).
  const charges = await rows<ChargeRow>(ctx.trx, sql<ChargeRow>`
    select b.obligation_id, c.id as cycle_id, c.seq, c.start_date, c.end_date, mc.quota_snapshot, b.pending_amount as pending, b.applied_total as applied
    from member_charge mc
    join v_obligation_balance b on b.obligation_id = mc.obligation_id
    join billing_cycle c on c.id = mc.cycle_id and c.owner_id = mc.owner_id
    where mc.owner_id = ${ctx.ownerId} and mc.seat_id = ${seatId} and mc.status = 'issued' and mc.mode = 'full_cycle'
      and c.start_date >= ${i.effectiveFrom}::date
    order by c.start_date`);
  const items: Plan['items'] = [];
  for (const c of charges) {
    const amount = newQuota - parseMoney(c.quota_snapshot);
    if (amount === 0n) continue;
    const pendingBefore = parseMoney(c.pending);
    const raw = pendingBefore + amount;
    // Si baja la cuota y el cargo ya estaba cobrado, el exceso aplicado vuelve a ser crédito libre del contacto (decisión 3).
    items.push({
      obligationId: c.obligation_id, cycleId: c.cycle_id, seq: c.seq, start: c.start_date, end: c.end_date, amount,
      dueDate: i.mode === 'per_renewal' ? c.start_date : today,
      pendingBefore, pendingAfter: raw < 0n ? 0n : raw, creditFreed: raw < 0n ? -raw : 0n,
    });
  }
  return { seat, termsId: cur.id, oldQuota, newQuota, freeDays: cur.free_days_threshold, items };
}

const inputsOf = (seatId: string, i: QuotaChangeInput) => ({ seatId, newQuota: formatMoney(parseMoney(i.newQuota)), effectiveFrom: i.effectiveFrom, mode: i.mode });
const fingerprint = (p: Plan) => ({ terms: p.termsId, charges: p.items.map((x) => `${x.obligationId}:${x.pendingBefore}`) });

function planJson(p: Plan, i: QuotaChangeInput) {
  const sum = (f: (x: Plan['items'][number]) => bigint) => p.items.reduce((a, x) => a + f(x), 0n);
  const m = (v: bigint) => formatMoney(v);
  return {
    seat: { id: p.seat.id, label: p.seat.label, contact: p.seat.contact_id ? { id: p.seat.contact_id, name: p.seat.contact_name } : null },
    effectiveFrom: i.effectiveFrom, mode: i.mode, oldQuota: m(p.oldQuota), newQuota: m(p.newQuota),
    adjustments: p.items.map((x) => ({
      obligationId: x.obligationId, cycle: { id: x.cycleId, seq: x.seq, start: x.start, end: x.end },
      amount: m(x.amount), dueDate: x.dueDate, pendingBefore: m(x.pendingBefore), pendingAfter: m(x.pendingAfter), creditFreed: m(x.creditFreed),
    })),
    totals: { adjustment: m(sum((x) => x.amount)), pendingBefore: m(sum((x) => x.pendingBefore)), pendingAfter: m(sum((x) => x.pendingAfter)), creditFreed: m(sum((x) => x.creditFreed)) },
    futureCyclesNote: 'Los ciclos que aún no tienen cargo se emitirán con la cuota nueva, sin ajuste.',
  };
}

/** Plan del cambio de cuota sin token: lo usa el cambio de precio, que agrupa varias plazas. */
export async function quotaChangeState(ctx: Ctx, seatId: string, i: QuotaChangeInput) {
  const p = await buildPlan(ctx, seatId, i);
  return { plan: p, json: planJson(p, i), fingerprint: fingerprint(p) };
}

export async function previewQuotaChange(ctx: Ctx, seatId: string, i: QuotaChangeInput) {
  const st = await quotaChangeState(ctx, seatId, i);
  return { ...st.json, previewToken: makePreviewToken(ctx.previewSecret, { scope: 'seat.quota_change', ownerId: ctx.ownerId, inputs: inputsOf(seatId, i), state: st.fingerprint }, ctx.nowMs) };
}

/** Libera aplicaciones (las más recientes primero) hasta que el cargo deje de estar sobrepagado; el exceso queda como crédito libre. */
async function releaseExcess(ctx: Ctx, obligationId: string, excess: bigint): Promise<void> {
  const allocs = await rows<{ id: string; receipt_id: string; amount: string }>(ctx.trx, sql<{ id: string; receipt_id: string; amount: string }>`
    select id, receipt_id, amount from payment_allocation
    where owner_id = ${ctx.ownerId} and obligation_id = ${obligationId} and status = 'active' order by created_at desc, id for update`);
  let left = excess;
  for (const a of allocs) {
    if (left <= 0n) break;
    const amt = parseMoney(a.amount);
    await sql`
      update payment_allocation set status = 'released', released_reason = 'Cuota reducida: el exceso vuelve a crédito libre', released_at = now()
      where owner_id = ${ctx.ownerId} and id = ${a.id}`.execute(ctx.trx);
    if (amt > left) {
      await sql`
        insert into payment_allocation (owner_id, receipt_id, obligation_id, amount, origin, created_by)
        values (${ctx.ownerId}, ${a.receipt_id}, ${obligationId}, ${formatMoney(amt - left)}, 'system', ${ctx.actorId})`.execute(ctx.trx);
      left = 0n;
    } else {
      left -= amt;
    }
  }
}

/** Escribe el cambio de cuota ya validado (nueva versión de la cuota, ajustes y crédito liberado). */
export async function commitQuotaChange(ctx: Ctx, seatId: string, i: QuotaChangeInput, p: Plan) {
  await sql`update seat_terms set valid_to = ${i.effectiveFrom}::date where owner_id = ${ctx.ownerId} and id = ${p.termsId}`.execute(ctx.trx);
  await sql`
    insert into seat_terms (owner_id, seat_id, valid_from, quota, free_days_threshold, reason, created_by)
    values (${ctx.ownerId}, ${seatId}, ${i.effectiveFrom}, ${formatMoney(p.newQuota)}, ${p.freeDays}, ${i.reason.trim()}, ${ctx.actorId})`.execute(ctx.trx);

  const groupId = i.mode === 'lump' ? randomUUID() : null;
  let creditFreed = 0n;
  for (const x of p.items) {
    await sql`
      insert into charge_adjustment (owner_id, obligation_id, amount, kind, due_date, group_id, reason, created_by)
      values (${ctx.ownerId}, ${x.obligationId}, ${formatMoney(x.amount)}, 'quota_change', ${x.dueDate}, ${groupId}, ${i.reason.trim()}, ${ctx.actorId})`.execute(ctx.trx);
    if (x.creditFreed > 0n) {
      await releaseExcess(ctx, x.obligationId, x.creditFreed);
      creditFreed += x.creditFreed;
    }
  }
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'seat.quota_change', entityType: 'seat', entityId: seatId, reason: i.reason.trim(),
    changes: { from: formatMoney(p.oldQuota), to: formatMoney(p.newQuota), effectiveFrom: i.effectiveFrom, mode: i.mode, adjusted: p.items.length, creditFreed: formatMoney(creditFreed) } });
  return { creditFreed, adjustments: p.items.map((x) => ({ obligationId: x.obligationId, cycleId: x.cycleId, amount: formatMoney(x.amount), dueDate: x.dueDate })) };
}

export async function applyQuotaChange(ctx: Ctx, seatId: string, i: QuotaChangeInput & { previewToken: string }) {
  const p = await buildPlan(ctx, seatId, i);
  checkPreviewToken(ctx.previewSecret, i.previewToken, { scope: 'seat.quota_change', ownerId: ctx.ownerId, inputs: inputsOf(seatId, i), state: fingerprint(p) }, ctx.nowMs);
  const r = await commitQuotaChange(ctx, seatId, i, p);
  return { seat: await getSeat(ctx, seatId), adjustments: r.adjustments, creditFreed: formatMoney(r.creditFreed) };
}
