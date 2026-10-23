import { sql } from 'kysely';
import { paymentStatus } from '../domain/allocation.js';
import { formatISO, parseISO } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import type { Ctx } from './context.js';
import { consumeCourtesy, coveringCourtesy } from './courtesy-core.js';

const m = (v: string) => formatMoney(parseMoney(v, { allowNegative: true }));

export interface NewCharge {
  contactId: string;
  seatId: string;
  cycleId: string;
  dueDate: number;
  quota: bigint;
  gross: bigint;
  exemption: bigint;
  mode: 'full_cycle' | 'trial_free' | 'partial_charged' | 'courtesy' | 'manual';
  snapshot: Record<string, unknown>;
}

/** Crea la obligación por cobrar y su cargo (un cargo por plaza y ciclo: UNIQUE en la base, RN-CH01). */
export async function insertCharge(ctx: Ctx, c: NewCharge): Promise<string> {
  const o = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into receivable_obligation (owner_id, contact_id, kind) values (${ctx.ownerId}, ${c.contactId}, 'subscription_charge') returning id`);
  await sql`
    insert into member_charge (obligation_id, owner_id, contact_id, seat_id, cycle_id, due_date, quota_snapshot, gross_amount, exemption_amount, mode, calc_snapshot)
    values (${o!.id}, ${ctx.ownerId}, ${c.contactId}, ${c.seatId}, ${c.cycleId}, ${formatISO(c.dueDate)}, ${formatMoney(c.quota)},
            ${formatMoney(c.gross)}, ${formatMoney(c.exemption)}, ${c.mode}, ${JSON.stringify(c.snapshot)}::jsonb)`.execute(ctx.trx);
  return o!.id;
}

/**
 * Aplica automáticamente las reservas activas del contacto para este servicio al cargo recién emitido (RN-R07, D-09).
 * Cada aplicación queda marcada origin='reservation' para poder deshacerla.
 */
export async function applyReservations(ctx: Ctx, obligationId: string, contactId: string, subscriptionId: string) {
  const resv = await rows<{ id: string; receipt_id: string; amount: string }>(ctx.trx, sql<{ id: string; receipt_id: string; amount: string }>`
    select r.id, r.receipt_id, r.amount from credit_reservation r
    join receipt rc on rc.id = r.receipt_id and rc.owner_id = r.owner_id
    where r.owner_id = ${ctx.ownerId} and rc.contact_id = ${contactId} and rc.status = 'active'
      and r.target_subscription_id = ${subscriptionId} and r.status = 'active' and r.amount > 0
    order by r.created_at, r.id for update of r`);
  for (const r of resv) {
    const pend = await one<{ pending_amount: string }>(ctx.trx, sql<{ pending_amount: string }>`select pending_amount from v_obligation_balance where obligation_id = ${obligationId}`);
    const pending = parseMoney(pend?.pending_amount ?? '0');
    if (pending <= 0n) break;
    const have = parseMoney(r.amount);
    const take = have < pending ? have : pending;
    await sql`
      insert into payment_allocation (owner_id, receipt_id, obligation_id, amount, origin, created_by)
      values (${ctx.ownerId}, ${r.receipt_id}, ${obligationId}, ${formatMoney(take)}, 'reservation', ${ctx.actorId})`.execute(ctx.trx);
    const left = have - take;
    await sql`update credit_reservation set amount = ${formatMoney(left)}, status = ${left === 0n ? 'consumed' : 'active'} where id = ${r.id} and owner_id = ${ctx.ownerId}`.execute(ctx.trx);
    await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'allocation.auto_apply', entityType: 'receipt', entityId: r.receipt_id, changes: { obligationId, amount: formatMoney(take) } });
  }
}

/**
 * Emite los cargos ordinarios que faltan: ciclos ya iniciados (o marcados por adelantado) × plazas de terceros (RN-CH01, D-08).
 * Idempotente. El cargo del ciclo en que ingresa una plaza lo crea el alta (con prorrateo), no esta función.
 */
export async function emitCharges(ctx: Ctx, subscriptionId: string): Promise<number> {
  const sub = await one<{ status: string }>(ctx.trx, sql<{ status: string }>`select status from subscription where owner_id = ${ctx.ownerId} and id = ${subscriptionId}`);
  if (!sub || sub.status !== 'active') return 0;
  const today = formatISO(ctx.today);
  const todo = await rows<{ seat_id: string; contact_id: string; cycle_id: string; start_date: string; end_date: string; quota: string }>(ctx.trx, sql`
    select s.id as seat_id, m.contact_id, c.id as cycle_id, c.start_date, c.end_date, st.quota
    from billing_cycle c
    join seat s on s.subscription_id = c.subscription_id and s.owner_id = c.owner_id
    join membership m on m.id = s.membership_id and m.owner_id = s.owner_id and not m.is_owner
    join seat_terms st on st.seat_id = s.id and st.owner_id = s.owner_id
         and st.valid_from <= c.start_date and (st.valid_to is null or st.valid_to > c.start_date)
    where c.owner_id = ${ctx.ownerId} and c.subscription_id = ${subscriptionId}
      and (c.start_date <= ${today}::date or c.emit_charges)
      and s.start_date <= c.start_date
      and (s.end_date is null or s.end_date > c.start_date)
      and not exists (select 1 from member_charge mc where mc.seat_id = s.id and mc.cycle_id = c.id)
    order by c.start_date, s.created_at`);

  for (const t of todo) {
    const quota = parseMoney(t.quota);
    // Cortesía (RN-K02): el cargo se emite completo con exención igual al bruto; nunca queda neto negativo (RN-K05).
    const courtesy = await coveringCourtesy(ctx, t.seat_id, t.start_date);
    const obligationId = await insertCharge(ctx, {
      contactId: t.contact_id, seatId: t.seat_id, cycleId: t.cycle_id, dueDate: parseISO(t.start_date),
      quota, gross: quota, exemption: courtesy ? quota : 0n, mode: courtesy ? 'courtesy' : 'full_cycle',
      snapshot: { mode: courtesy ? 'courtesy' : 'full_cycle', quota: formatMoney(quota), rule: 'RN-CH02@v1', cycle: { start: t.start_date, end: t.end_date }, ...(courtesy ? { courtesyId: courtesy.id } : {}) },
    });
    if (courtesy) await consumeCourtesy(ctx, courtesy.id);
    await applyReservations(ctx, obligationId, t.contact_id, subscriptionId);
  }
  return todo.length;
}

interface ChargeRow {
  obligation_id: string; seat_id: string; seat_label: string; contact_id: string; contact_name: string;
  cycle_id: string; cycle_start: string; cycle_end: string; due_date: string; mode: string; calc_snapshot: unknown;
  issued_amount: string; gross_amount: string; exemption_amount: string; adjustments_total: string; applied_total: string; converted_total: string; pending_amount: string;
  subscription_id: string; subscription_name: string;
}

export const chargeView = (r: ChargeRow, todayIso: string) => {
  const issued = parseMoney(r.issued_amount), adj = parseMoney(r.adjustments_total, { allowNegative: true });
  const applied = parseMoney(r.applied_total), conv = parseMoney(r.converted_total);
  const pending = parseMoney(r.pending_amount);
  return {
    obligationId: r.obligation_id, subscriptionId: r.subscription_id, subscriptionName: r.subscription_name,
    seatId: r.seat_id, seatLabel: r.seat_label, contactId: r.contact_id, contactName: r.contact_name,
    cycle: { id: r.cycle_id, start: r.cycle_start, end: r.cycle_end },
    dueDate: r.due_date, mode: r.mode,
    gross: m(r.gross_amount), exemption: m(r.exemption_amount), net: m(r.issued_amount), adjustments: m(r.adjustments_total),
    applied: m(r.applied_total), converted: m(r.converted_total), pending: m(r.pending_amount),
    paymentStatus: paymentStatus({ issued, adjustments: adj, applied, converted: conv }),
    overdue: r.due_date < todayIso && pending > 0n,
    calcSnapshot: r.calc_snapshot,
  };
};

const chargeBase = sql`
  select b.obligation_id, s.id as seat_id, s.label as seat_label, mc.contact_id, ct.name as contact_name,
         c.id as cycle_id, c.start_date as cycle_start, c.end_date as cycle_end, d.effective_due_date as due_date, mc.mode, mc.calc_snapshot,
         b.issued_amount, mc.gross_amount, mc.exemption_amount, b.adjustments_total, b.applied_total, b.converted_total, b.pending_amount,
         sub.id as subscription_id, sub.name as subscription_name
  from v_obligation_balance b
  join member_charge mc on mc.obligation_id = b.obligation_id
  join v_charge_due d on d.obligation_id = b.obligation_id
  join seat s on s.id = mc.seat_id and s.owner_id = mc.owner_id
  join billing_cycle c on c.id = mc.cycle_id and c.owner_id = mc.owner_id
  join subscription sub on sub.id = c.subscription_id and sub.owner_id = c.owner_id
  join contact ct on ct.id = mc.contact_id and ct.owner_id = mc.owner_id`;

export async function listCharges(ctx: Ctx, where: ReturnType<typeof sql>) {
  const today = formatISO(ctx.today);
  const r = await rows<ChargeRow>(ctx.trx, sql<ChargeRow>`${chargeBase} where b.owner_id = ${ctx.ownerId} and ${where} order by c.start_date desc, s.created_at`);
  return r.map((x) => chargeView(x, today));
}
