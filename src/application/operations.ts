import { sql } from 'kysely';
import { formatISO, parseISO } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import type { Ctx } from './context.js';
import { ts } from './context.js';

export interface CreateOperationInput {
  kind: 'income' | 'expense' | 'transfer';
  accountId: string;
  toAccountId?: string;
  amount: string;
  date?: string;
  description?: string;
  categoryId?: string | null;
  contactId?: string | null;
}

/** Cuenta activa del propietario, bloqueada para escritura. */
export async function activeAccount(ctx: Ctx, id: string) {
  const a = await one<{ id: string; status: string; type: string; currency: string }>(ctx.trx, sql<{ id: string; status: string; type: string; currency: string }>`
    select id, status, type, currency from account where owner_id = ${ctx.ownerId} and id = ${id} for share`);
  if (!a) throw notFound('Account');
  if (a.status !== 'active') throw unprocessable('ACCOUNT_ARCHIVED', 'The account is archived');
  return a;
}

/** Verifica que la fila exista y sea del propietario; si no, 404 (no se revela si pertenece a otro). */
export async function requireOwned(ctx: Ctx, table: 'contact' | 'category' | 'account', id: string) {
  const r = await one(ctx.trx, sql`select 1 as ok from ${sql.table(table)} where owner_id = ${ctx.ownerId} and id = ${id}`);
  if (!r) throw notFound(table);
}

export function resolveDate(ctx: Ctx, date?: string) {
  const d = date ? parseISO(date) : ctx.today;
  if (d > ctx.today) throw unprocessable('FUTURE_DATE_NOT_ALLOWED', 'La fecha no puede ser posterior a hoy');
  return d;
}

/** Inserta una operación y sus asientos. Usado también por cobros y pagos al proveedor. */
export async function insertOperation(
  ctx: Ctx,
  o: { kind: 'income' | 'expense' | 'transfer'; date: number; description?: string; contactId?: string | null; categoryId?: string | null; source?: string },
  entries: Array<{ accountId: string; amount: bigint }>,
) {
  const op = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into financial_operation (owner_id, kind, occurred_on, description, contact_id, category_id, source, created_by)
    values (${ctx.ownerId}, ${o.kind}, ${formatISO(o.date)}, ${o.description ?? ''}, ${o.contactId ?? null}, ${o.categoryId ?? null}, ${o.source ?? 'manual'}, ${ctx.actorId})
    returning id`);
  for (const e of entries) {
    await sql`insert into account_entry (owner_id, operation_id, account_id, amount) values (${ctx.ownerId}, ${op!.id}, ${e.accountId}, ${formatMoney(e.amount)})`.execute(ctx.trx);
  }
  return op!.id;
}

export async function createOperation(ctx: Ctx, i: CreateOperationInput) {
  const amount = parseMoney(i.amount);
  if (amount <= 0n) throw unprocessable('VALIDATION_ERROR', 'El importe debe ser positivo');
  const date = resolveDate(ctx, i.date);
  const from = await activeAccount(ctx, i.accountId);
  if (i.contactId) await requireOwned(ctx, 'contact', i.contactId);
  if (i.categoryId) await requireOwned(ctx, 'category', i.categoryId);

  let entries: Array<{ accountId: string; amount: bigint }>;
  if (i.kind === 'transfer') {
    if (!i.toAccountId) throw unprocessable('VALIDATION_ERROR', 'toAccountId es obligatorio en una transferencia');
    if (i.toAccountId === i.accountId) throw unprocessable('VALIDATION_ERROR', 'Las cuentas de origen y destino deben ser distintas');
    const to = await activeAccount(ctx, i.toAccountId);
    if (to.currency !== from.currency) throw unprocessable('CURRENCY_MISMATCH', 'Las cuentas tienen monedas distintas');
    entries = [{ accountId: i.accountId, amount: -amount }, { accountId: i.toAccountId, amount }];
  } else {
    entries = [{ accountId: i.accountId, amount: i.kind === 'income' ? amount : -amount }];
  }
  const id = await insertOperation(ctx, { kind: i.kind, date, description: i.description, contactId: i.contactId, categoryId: i.categoryId }, entries);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: `operation.${i.kind}`, entityType: 'financial_operation', entityId: id, changes: { amount: formatMoney(amount) } });
  return getOperation(ctx, id);
}

export async function getOperation(ctx: Ctx, id: string) {
  const op = await one<{ id: string; kind: string; occurred_on: string; description: string; status: string; reversal_of_id: string | null; reason: string | null; version: number; created_at: unknown }>(
    ctx.trx, sql`select id, kind, occurred_on, description, status, reversal_of_id, reason, version, created_at from financial_operation where owner_id = ${ctx.ownerId} and id = ${id}`);
  if (!op) throw notFound('Operation');
  const es = await rows<{ account_id: string; amount: string }>(ctx.trx, sql`select account_id, amount from account_entry where owner_id = ${ctx.ownerId} and operation_id = ${id} order by amount`);
  // A qué registro pertenece (un cobro, un pago al proveedor o una devolución): esos se corrigen por su propio registro.
  const links = await one<{ receipt_id: string | null; supplier_payment_id: string | null; refund_id: string | null }>(ctx.trx, sql`
    select (select id from receipt where operation_id = ${id}) as receipt_id,
           (select id from supplier_payment where operation_id = ${id}) as supplier_payment_id,
           (select id from refund where operation_id = ${id}) as refund_id`);
  return {
    links: { receiptId: links?.receipt_id ?? null, supplierPaymentId: links?.supplier_payment_id ?? null, refundId: links?.refund_id ?? null },
    id: op.id, kind: op.kind, occurredOn: op.occurred_on, description: op.description, status: op.status,
    reversalOfId: op.reversal_of_id, reason: op.reason, version: op.version, createdAt: ts(op.created_at),
    entries: es.map((e) => ({ accountId: e.account_id, amount: formatMoney(parseMoney(e.amount, { allowNegative: true })) })),
  };
}

/**
 * Crea la operación contraria y marca la original como revertida; nunca borra evidencia (RN-V05).
 * Usado por la ruta pública (que rechaza operaciones ligadas a otros registros) y por los flujos que revierten sus propios registros.
 */
export async function reverseOperationCore(ctx: Ctx, id: string, reason: string, date?: string, opts: { allowLinked?: boolean } = {}) {
  const op = await one<{ id: string; kind: string; status: string }>(ctx.trx, sql<{ id: string; kind: string; status: string }>`
    select id, kind, status from financial_operation where owner_id = ${ctx.ownerId} and id = ${id} for update`);
  if (!op) throw notFound('Operation');
  if (op.status === 'reversed' || op.kind === 'reversal') throw unprocessable('ALREADY_REVERSED', 'The operation is already reversed or is itself a reversal');

  if (!opts.allowLinked) {
    const linked = await one<{ n: string }>(ctx.trx, sql<{ n: string }>`
      select (select count(*) from receipt where operation_id = ${id}) + (select count(*) from supplier_payment where operation_id = ${id}) + (select count(*) from refund where operation_id = ${id}) as n`);
    if (Number(linked?.n ?? 0) > 0) throw unprocessable('OPERATION_LINKED', 'This operation backs a receipt, refund or supplier payment: reverse that record instead');
  }

  const es = await rows<{ account_id: string; amount: string }>(ctx.trx, sql`select account_id, amount from account_entry where owner_id = ${ctx.ownerId} and operation_id = ${id}`);
  const d = resolveDate(ctx, date);
  const rev = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into financial_operation (owner_id, kind, occurred_on, description, reversal_of_id, reason, created_by)
    values (${ctx.ownerId}, 'reversal', ${formatISO(d)}, ${'Reversión de ' + id}, ${id}, ${reason}, ${ctx.actorId}) returning id`);
  for (const e of es) {
    await sql`insert into account_entry (owner_id, operation_id, account_id, amount) values (${ctx.ownerId}, ${rev!.id}, ${e.account_id}, ${formatMoney(-parseMoney(e.amount, { allowNegative: true }))})`.execute(ctx.trx);
  }
  await sql`update financial_operation set status = 'reversed' where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'operation.reverse', entityType: 'financial_operation', entityId: id, reason });
  return rev!.id;
}

export async function reverseOperation(ctx: Ctx, id: string, reason: string, date?: string) {
  return getOperation(ctx, await reverseOperationCore(ctx, id, reason, date));
}
