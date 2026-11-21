import { sql } from 'kysely';
import { formatISO } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { ts, type Ctx } from './context.js';
import { activeAccount, insertOperation, resolveDate, reverseOperationCore } from './operations.js';

/** Programa una devolución sin validar (la usan procesos que ya liberaron el crédito, como la baja). RN-X06: aún no sale dinero. */
export async function insertPlannedRefund(ctx: Ctx, o: { receiptId: string; contactId: string; amount: bigint; reason: string }): Promise<string> {
  const r = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into refund (owner_id, receipt_id, contact_id, amount, planned_on, reason)
    values (${ctx.ownerId}, ${o.receiptId}, ${o.contactId}, ${formatMoney(o.amount)}, ${formatISO(ctx.today)}, ${o.reason}) returning id`);
  return r!.id;
}

interface RefundRow {
  id: string; receipt_id: string; contact_id: string; contact_name: string; amount: string; status: string; planned_on: string | null;
  operation_id: string | null; reason: string; created_at: unknown;
}

const view = (r: RefundRow) => ({
  id: r.id, receiptId: r.receipt_id, contact: { id: r.contact_id, name: r.contact_name }, amount: formatMoney(parseMoney(r.amount)), status: r.status,
  plannedOn: r.planned_on, operationId: r.operation_id, reason: r.reason, createdAt: ts(r.created_at),
});

const base = sql`
  select f.id, f.receipt_id, f.contact_id, c.name as contact_name, f.amount, f.status, f.planned_on, f.operation_id, f.reason, f.created_at
  from refund f join contact c on c.id = f.contact_id and c.owner_id = f.owner_id`;

export async function listRefunds(ctx: Ctx, status?: string, contactId?: string) {
  const r = await rows<RefundRow>(ctx.trx, sql<RefundRow>`
    ${base} where f.owner_id = ${ctx.ownerId}
      and (${status ?? null}::text is null or f.status = ${status ?? null})
      and (${contactId ?? null}::uuid is null or f.contact_id = ${contactId ?? null})
    order by f.created_at desc, f.id`);
  return r.map(view);
}

async function getRefund(ctx: Ctx, id: string) {
  const r = await one<RefundRow>(ctx.trx, sql<RefundRow>`${base} where f.owner_id = ${ctx.ownerId} and f.id = ${id}`);
  if (!r) throw notFound('Refund');
  return view(r);
}

/** Devolución manual de crédito libre de un cobro (RN-X06: solo se programa; la salida real es otro paso). */
export async function createRefund(ctx: Ctx, i: { receiptId: string; amount: string; reason: string }) {
  const amount = parseMoney(i.amount);
  if (amount <= 0n) throw unprocessable('VALIDATION_ERROR', 'The amount must be positive');
  const rc = await one<{ contact_id: string }>(ctx.trx, sql<{ contact_id: string }>`
    select contact_id from receipt where owner_id = ${ctx.ownerId} and id = ${i.receiptId} and status = 'active' for update`);
  if (!rc) throw notFound('Receipt');
  const av = await one<{ free: string }>(ctx.trx, sql<{ free: string }>`select free from v_receipt_availability where owner_id = ${ctx.ownerId} and receipt_id = ${i.receiptId}`);
  const free = parseMoney(av?.free ?? '0');
  if (amount > free) throw unprocessable('REFUND_EXCEEDS_FREE_CREDIT', 'The amount exceeds the free credit of the receipt', { free: formatMoney(free), requested: formatMoney(amount) });
  const id = await insertPlannedRefund(ctx, { receiptId: i.receiptId, contactId: rc.contact_id, amount, reason: i.reason.trim() });
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'refund.plan', entityType: 'refund', entityId: id, reason: i.reason.trim(), changes: { amount: formatMoney(amount) } });
  return getRefund(ctx, id);
}

/** Registra la salida real: una operación de egreso desde la cuenta elegida (RN-X06). */
export async function payRefund(ctx: Ctx, id: string, i: { accountId: string; paidOn?: string; note?: string }) {
  const f = await one<{ id: string; contact_id: string; amount: string; status: string; contact_name: string }>(ctx.trx, sql<{ id: string; contact_id: string; amount: string; status: string; contact_name: string }>`
    select f.id, f.contact_id, f.amount, f.status, c.name as contact_name from refund f join contact c on c.id = f.contact_id and c.owner_id = f.owner_id
    where f.owner_id = ${ctx.ownerId} and f.id = ${id} for update of f`);
  if (!f) throw notFound('Refund');
  if (f.status !== 'planned') throw unprocessable('REFUND_NOT_PLANNED', 'Only a planned refund can be paid');
  await activeAccount(ctx, i.accountId);
  const date = resolveDate(ctx, i.paidOn);
  const amount = parseMoney(f.amount);
  const op = await insertOperation(ctx, { kind: 'expense', date, description: i.note?.trim() || `Devolución a ${f.contact_name}`, contactId: f.contact_id }, [{ accountId: i.accountId, amount: -amount }]);
  await sql`update refund set status = 'paid', operation_id = ${op} where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'refund.pay', entityType: 'refund', entityId: id, changes: { amount: formatMoney(amount), operationId: op } });
  return getRefund(ctx, id);
}

/** Cancela una devolución programada: el dinero vuelve a contar como crédito libre del contacto. */
export async function cancelRefund(ctx: Ctx, id: string, reason: string) {
  const f = await one<{ status: string }>(ctx.trx, sql<{ status: string }>`select status from refund where owner_id = ${ctx.ownerId} and id = ${id} for update`);
  if (!f) throw notFound('Refund');
  if (f.status !== 'planned') throw unprocessable('REFUND_NOT_PLANNED', 'Only a planned refund can be cancelled');
  await sql`update refund set status = 'cancelled' where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'refund.cancel', entityType: 'refund', entityId: id, reason });
  return getRefund(ctx, id);
}

/** Revierte una devolución ya pagada: crea la reversión de la salida de cuenta y devuelve el dinero al crédito libre del cobro. */
export async function reverseRefund(ctx: Ctx, id: string, reason: string) {
  const f = await one<{ status: string; amount: string; operation_id: string | null }>(ctx.trx, sql<{ status: string; amount: string; operation_id: string | null }>`
    select status, amount, operation_id from refund where owner_id = ${ctx.ownerId} and id = ${id} for update`);
  if (!f) throw notFound('Refund');
  if (f.status !== 'paid' || !f.operation_id) throw unprocessable('REFUND_NOT_PAID', 'Only a paid refund can be reversed');
  const reversalId = await reverseOperationCore(ctx, f.operation_id, reason, undefined, { allowLinked: true });
  await sql`update refund set status = 'cancelled' where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'refund.reverse', entityType: 'refund', entityId: id, reason, changes: { amount: formatMoney(parseMoney(f.amount)), operationId: f.operation_id, reversalOperationId: reversalId } });
  return getRefund(ctx, id);
}
