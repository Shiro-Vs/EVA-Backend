import { sql } from 'kysely';
import { availability, validateAllocations, type AllocationIssue } from '../domain/allocation.js';
import { formatISO } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { checkPreviewToken, makePreviewToken } from '../infra/preview.js';
import type { Ctx } from './context.js';
import { ts } from './context.js';
import { activeAccount, insertOperation, resolveDate } from './operations.js';
import { syncAllSubscriptions } from './sync.js';

export interface ReceiptInput {
  contactId: string;
  accountId: string;
  amount: string;
  receivedOn?: string;
  note?: string;
  allocations: Array<{ obligationId: string; amount: string }>;
  /** undefined → por defecto al único servicio de las aplicaciones; null → dejar como crédito libre. */
  reserveRemainder?: { subscriptionId: string } | null;
}

interface PendingRow { obligation_id: string; pending_amount: string; contact_id: string; due_date: string; subscription_id: string }

interface Plan {
  amount: bigint; receivedOn: number; allocations: Array<{ obligationId: string; amount: bigint; pending: bigint }>;
  issues: AllocationIssue[]; remainder: bigint; reserveTo: string | null; balanceAfter: bigint;
}

const normalized = (i: ReceiptInput) => ({
  contactId: i.contactId, accountId: i.accountId, amount: formatMoney(parseMoney(i.amount)), receivedOn: i.receivedOn ?? null,
  allocations: i.allocations.map((a) => ({ obligationId: a.obligationId, amount: formatMoney(parseMoney(a.amount)) })),
  reserveRemainder: i.reserveRemainder === undefined ? 'default' : i.reserveRemainder,
});

/** Valida y bloquea. Las obligaciones se bloquean en orden de ID antes de leer su pendiente (A28a). */
async function buildPlan(ctx: Ctx, i: ReceiptInput): Promise<Plan> {
  await syncAllSubscriptions(ctx);
  const amount = parseMoney(i.amount);
  if (amount <= 0n) throw unprocessable('VALIDATION_ERROR', 'El importe debe ser positivo');
  const receivedOn = resolveDate(ctx, i.receivedOn);

  const contact = await one(ctx.trx, sql`select 1 as ok from contact where owner_id = ${ctx.ownerId} and id = ${i.contactId}`);
  if (!contact) throw notFound('Contact');
  await activeAccount(ctx, i.accountId);

  const ids = [...new Set(i.allocations.map((a) => a.obligationId))].sort();
  let pendings: PendingRow[] = [];
  if (ids.length > 0) {
    const locked = await rows<{ id: string }>(ctx.trx, sql<{ id: string }>`
      select id from receivable_obligation where owner_id = ${ctx.ownerId} and id = any(${ids}::uuid[]) order by id for update`);
    if (locked.length !== ids.length) throw notFound('Obligation');
    pendings = await rows<PendingRow>(ctx.trx, sql<PendingRow>`
      select b.obligation_id, b.pending_amount, b.contact_id, mc.due_date, c.subscription_id
      from v_obligation_balance b join member_charge mc on mc.obligation_id = b.obligation_id
      join billing_cycle c on c.id = mc.cycle_id and c.owner_id = mc.owner_id
      where b.owner_id = ${ctx.ownerId} and b.obligation_id = any(${ids}::uuid[])`);
    if (pendings.length !== ids.length) throw unprocessable('OBLIGATION_NOT_PAYABLE', 'One of the charges is cancelled or not payable');
    if (pendings.some((p) => p.contact_id !== i.contactId)) throw unprocessable('ALLOCATION_CONTACT_MISMATCH', 'The receipt and the charge belong to different contacts');
  }
  const byId = new Map(pendings.map((p) => [p.obligation_id, p]));
  const allocations = i.allocations.map((a) => ({ obligationId: a.obligationId, amount: parseMoney(a.amount), pending: parseMoney(byId.get(a.obligationId)?.pending_amount ?? '0') }));
  const issues = validateAllocations(amount, allocations);

  const applied = allocations.reduce((s, a) => s + a.amount, 0n);
  const remainder = amount - applied;

  // RN-R06: por defecto el sobrante queda reservado para el próximo cargo del mismo servicio (si es uno solo).
  let reserveTo: string | null = null;
  if (remainder > 0n) {
    if (i.reserveRemainder) reserveTo = i.reserveRemainder.subscriptionId;
    else if (i.reserveRemainder === undefined) {
      const subs = new Set(pendings.map((p) => p.subscription_id));
      if (subs.size === 1) reserveTo = [...subs][0]!;
    }
    if (reserveTo) {
      const ok = await one(ctx.trx, sql`select 1 as ok from subscription where owner_id = ${ctx.ownerId} and id = ${reserveTo} and status <> 'archived'`);
      if (!ok) throw notFound('Subscription');
    }
  }
  const bal = await one<{ balance: string }>(ctx.trx, sql<{ balance: string }>`select coalesce(sum(amount), 0.00) as balance from account_entry where owner_id = ${ctx.ownerId} and account_id = ${i.accountId}`);
  return { amount, receivedOn, allocations, issues, remainder, reserveTo, balanceAfter: parseMoney(bal!.balance, { allowNegative: true }) + amount };
}

const state = (p: Plan, i: ReceiptInput) => ({ pendings: p.allocations.map((a) => [a.obligationId, formatMoney(a.pending)]).sort(), account: i.accountId, reserveTo: p.reserveTo });

const issueJson = (x: AllocationIssue) => {
  switch (x.code) {
    case 'EXCEEDS_RECEIPT': return { code: 'EXCEEDS_RECEIPT', available: formatMoney(x.available), requested: formatMoney(x.requested) };
    case 'EXCEEDS_OBLIGATION': return { code: 'EXCEEDS_OBLIGATION', obligationId: x.obligationId, pending: formatMoney(x.pending), requested: formatMoney(x.requested) };
    default: return { ...x };
  }
};

export async function previewReceipt(ctx: Ctx, i: ReceiptInput) {
  const p = await buildPlan(ctx, i);
  const applied = p.allocations.reduce((s, a) => s + a.amount, 0n);
  return {
    valid: p.issues.length === 0,
    issues: p.issues.map(issueJson),
    summary: { received: formatMoney(p.amount), applied: formatMoney(applied), remainder: formatMoney(p.remainder), reservedTo: p.reserveTo },
    allocations: p.allocations.map((a) => ({ obligationId: a.obligationId, amount: formatMoney(a.amount), pendingBefore: formatMoney(a.pending), pendingAfter: formatMoney(a.pending - a.amount) })),
    account: { id: i.accountId, balanceAfter: formatMoney(p.balanceAfter) },
    singleIncome: true,
    ...(p.issues.length === 0 ? { previewToken: makePreviewToken(ctx.previewSecret, { scope: 'receipt.create', ownerId: ctx.ownerId, inputs: normalized(i), state: state(p, i) }, ctx.nowMs) } : {}),
  };
}

export async function createReceipt(ctx: Ctx, i: ReceiptInput & { previewToken?: string }) {
  const p = await buildPlan(ctx, i);
  if (p.issues.length > 0) {
    const first = p.issues[0]!;
    throw unprocessable(first.code === 'EXCEEDS_RECEIPT' || first.code === 'EXCEEDS_OBLIGATION' ? 'OVER_ALLOCATION' : 'VALIDATION_ERROR', 'The allocation is not valid', p.issues.map(issueJson));
  }
  checkPreviewToken(ctx.previewSecret, i.previewToken, { scope: 'receipt.create', ownerId: ctx.ownerId, inputs: normalized(i), state: state(p, i) }, ctx.nowMs);

  // UN solo ingreso real; el reparto no crea ingresos adicionales (RN-R01).
  const opId = await insertOperation(ctx, { kind: 'income', date: p.receivedOn, description: i.note?.trim() || 'Cobro', contactId: i.contactId }, [{ accountId: i.accountId, amount: p.amount }]);
  const rec = await one<{ id: string; version: number }>(ctx.trx, sql<{ id: string; version: number }>`
    insert into receipt (owner_id, contact_id, operation_id, amount, received_on, note)
    values (${ctx.ownerId}, ${i.contactId}, ${opId}, ${formatMoney(p.amount)}, ${formatISO(p.receivedOn)}, ${i.note ?? null}) returning id, version`);
  const created: Array<{ id: string; obligationId: string; amount: string }> = [];
  for (const a of p.allocations) {
    const r = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
      insert into payment_allocation (owner_id, receipt_id, obligation_id, amount, created_by)
      values (${ctx.ownerId}, ${rec!.id}, ${a.obligationId}, ${formatMoney(a.amount)}, ${ctx.actorId}) returning id`);
    created.push({ id: r!.id, obligationId: a.obligationId, amount: formatMoney(a.amount) });
  }
  if (p.remainder > 0n && p.reserveTo) {
    await sql`insert into credit_reservation (owner_id, receipt_id, target_subscription_id, amount) values (${ctx.ownerId}, ${rec!.id}, ${p.reserveTo}, ${formatMoney(p.remainder)})`.execute(ctx.trx);
  }
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'receipt.create', entityType: 'receipt', entityId: rec!.id,
    changes: { amount: formatMoney(p.amount), allocations: created.length, remainder: formatMoney(p.remainder), reservedTo: p.reserveTo } });
  const av = await receiptAvailability(ctx, rec!.id);
  return {
    receipt: { id: rec!.id, amount: formatMoney(p.amount), operationId: opId, status: 'active', version: rec!.version },
    allocations: created, availability: av, account: { id: i.accountId, balanceAfter: formatMoney(p.balanceAfter) },
  };
}

async function receiptAvailability(ctx: Ctx, receiptId: string) {
  const a = await one<{ received: string; applied: string; refunded: string; reserved: string }>(ctx.trx, sql<{ received: string; applied: string; refunded: string; reserved: string }>`
    select received, applied, refunded, reserved from v_receipt_availability where owner_id = ${ctx.ownerId} and receipt_id = ${receiptId}`);
  const v = availability({ received: parseMoney(a!.received), applied: parseMoney(a!.applied), refunded: parseMoney(a!.refunded), reserved: parseMoney(a!.reserved) });
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, formatMoney(x as bigint)])) as Record<string, string>;
}

export async function getReceipt(ctx: Ctx, id: string) {
  const r = await one<{ id: string; contact_id: string; operation_id: string; amount: string; received_on: string; note: string | null; status: string; version: number; created_at: unknown }>(ctx.trx,
    sql`select id, contact_id, operation_id, amount, received_on, note, status, version, created_at from receipt where owner_id = ${ctx.ownerId} and id = ${id}`);
  if (!r) throw notFound('Receipt');
  const allocs = await rows<{ id: string; obligation_id: string; amount: string; origin: string; status: string; released_reason: string | null }>(ctx.trx,
    sql`select id, obligation_id, amount, origin, status, released_reason from payment_allocation where owner_id = ${ctx.ownerId} and receipt_id = ${id} order by created_at, id`);
  const resv = await rows<{ id: string; target_subscription_id: string; amount: string; status: string }>(ctx.trx,
    sql`select id, target_subscription_id, amount, status from credit_reservation where owner_id = ${ctx.ownerId} and receipt_id = ${id} order by created_at, id`);
  return {
    id: r.id, contactId: r.contact_id, operationId: r.operation_id, amount: formatMoney(parseMoney(r.amount)), receivedOn: r.received_on, note: r.note, status: r.status, version: r.version, createdAt: ts(r.created_at),
    allocations: allocs.map((a) => ({ id: a.id, obligationId: a.obligation_id, amount: formatMoney(parseMoney(a.amount)), origin: a.origin, status: a.status, releasedReason: a.released_reason })),
    reservations: resv.map((x) => ({ id: x.id, subscriptionId: x.target_subscription_id, amount: formatMoney(parseMoney(x.amount)), status: x.status })),
    availability: await receiptAvailability(ctx, id),
  };
}

/** Crédito del contacto separado en libre y reservado, por servicio (RN-R09). */
export async function contactCredit(ctx: Ctx, contactId: string) {
  const c = await one(ctx.trx, sql`select 1 as ok from contact where owner_id = ${ctx.ownerId} and id = ${contactId}`);
  if (!c) throw notFound('Contact');
  const rs = await rows<{ receipt_id: string; unapplied: string; reserved: string; free: string }>(ctx.trx, sql`
    select receipt_id, unapplied, reserved, free from v_receipt_availability where owner_id = ${ctx.ownerId} and contact_id = ${contactId} and unapplied > 0 order by receipt_id`);
  const resv = await rows<{ id: string; receipt_id: string; subscription_id: string; subscription_name: string; amount: string }>(ctx.trx, sql`
    select r.id, r.receipt_id, r.target_subscription_id as subscription_id, s.name as subscription_name, r.amount
    from credit_reservation r join subscription s on s.id = r.target_subscription_id and s.owner_id = r.owner_id
    join receipt rc on rc.id = r.receipt_id and rc.owner_id = r.owner_id
    where r.owner_id = ${ctx.ownerId} and rc.contact_id = ${contactId} and r.status = 'active' order by r.created_at`);
  const sum = (k: 'unapplied' | 'reserved' | 'free') => formatMoney(rs.reduce((a, r) => a + parseMoney(r[k]), 0n));
  return {
    contactId, total: sum('unapplied'), reserved: sum('reserved'), free: sum('free'),
    receipts: rs.map((r) => ({ receiptId: r.receipt_id, unapplied: formatMoney(parseMoney(r.unapplied)), reserved: formatMoney(parseMoney(r.reserved)), free: formatMoney(parseMoney(r.free)) })),
    reservations: resv.map((x) => ({ id: x.id, receiptId: x.receipt_id, subscriptionId: x.subscription_id, subscriptionName: x.subscription_name, amount: formatMoney(parseMoney(x.amount)) })),
  };
}

/** Cambia el destino de una reserva: no mueve dinero ni crea ingreso (RN-R06, A09). */
export async function moveReservation(ctx: Ctx, id: string, toSubscriptionId: string) {
  const r = await one<{ id: string; status: string; target_subscription_id: string; receipt_id: string; amount: string }>(ctx.trx, sql<{ id: string; status: string; target_subscription_id: string; receipt_id: string; amount: string }>`
    select id, status, target_subscription_id, receipt_id, amount from credit_reservation where owner_id = ${ctx.ownerId} and id = ${id} for update`);
  if (!r) throw notFound('Reservation');
  if (r.status !== 'active') throw unprocessable('RESERVATION_NOT_ACTIVE', 'The reservation is not active');
  const sub = await one(ctx.trx, sql`select 1 as ok from subscription where owner_id = ${ctx.ownerId} and id = ${toSubscriptionId} and status <> 'archived'`);
  if (!sub) throw notFound('Subscription');
  if (r.target_subscription_id !== toSubscriptionId) {
    await sql`update credit_reservation set target_subscription_id = ${toSubscriptionId} where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
    await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'reservation.move', entityType: 'credit_reservation', entityId: id, changes: { from: r.target_subscription_id, to: toSubscriptionId } });
  }
  return { id, receiptId: r.receipt_id, subscriptionId: toSubscriptionId, amount: formatMoney(parseMoney(r.amount)), status: 'active' };
}

/** Libera una aplicación (deshacer). Si venía de una reserva, la reserva se restituye (RN-R07). */
export async function releaseAllocation(ctx: Ctx, id: string, reason: string) {
  const a = await one<{ id: string; receipt_id: string; obligation_id: string; amount: string; origin: string; status: string }>(ctx.trx, sql<{ id: string; receipt_id: string; obligation_id: string; amount: string; origin: string; status: string }>`
    select id, receipt_id, obligation_id, amount, origin, status from payment_allocation where owner_id = ${ctx.ownerId} and id = ${id} for update`);
  if (!a) throw notFound('Allocation');
  if (a.status !== 'active') throw unprocessable('ALREADY_RELEASED', 'The allocation is already released');
  await sql`update payment_allocation set status = 'released', released_reason = ${reason}, released_at = now() where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  let restored: string | null = null;
  if (a.origin === 'reservation') {
    const sub = await one<{ subscription_id: string }>(ctx.trx, sql<{ subscription_id: string }>`
      select c.subscription_id from member_charge mc join billing_cycle c on c.id = mc.cycle_id and c.owner_id = mc.owner_id
      where mc.owner_id = ${ctx.ownerId} and mc.obligation_id = ${a.obligation_id}`);
    if (sub) {
      const r = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
        insert into credit_reservation (owner_id, receipt_id, target_subscription_id, amount) values (${ctx.ownerId}, ${a.receipt_id}, ${sub.subscription_id}, ${formatMoney(parseMoney(a.amount))}) returning id`);
      restored = r!.id;
    }
  }
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'allocation.release', entityType: 'payment_allocation', entityId: id, reason, changes: { amount: formatMoney(parseMoney(a.amount)), restoredReservation: restored } });
  return { id, status: 'released', reservationId: restored, availability: await receiptAvailability(ctx, a.receipt_id) };
}
