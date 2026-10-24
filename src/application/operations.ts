import { sql } from 'kysely';
import { formatISO, parseISO } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { impactOf } from './budgets.js';
import { assertActiveCategory } from './categories.js';
import { autoClassify, decisionsOf } from './classification.js';
import { applyDeductions, reserveConflict, validateDeductions, type Deduction } from './goals.js';
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
  /** Si el egreso usa dinero reservado para metas: de qué metas se descuenta (RN-GO04). */
  goalDeductions?: Deduction[];
  /** …o se acepta que lo reservado quede por encima del saldo. */
  acceptReserveShortfall?: boolean;
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
  o: { kind: 'income' | 'expense' | 'transfer' | 'adjustment'; date: number; description?: string; contactId?: string | null; categoryId?: string | null; source?: string; concept?: 'ordinary' | 'loan_disbursement' | 'loan_payment' | 'reconciliation' },
  entries: Array<{ accountId: string; amount: bigint }>,
) {
  const op = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into financial_operation (owner_id, kind, occurred_on, description, contact_id, category_id, source, concept, created_by)
    values (${ctx.ownerId}, ${o.kind}, ${formatISO(o.date)}, ${o.description ?? ''}, ${o.contactId ?? null}, ${o.categoryId ?? null}, ${o.source ?? 'manual'}, ${o.concept ?? 'ordinary'}, ${ctx.actorId})
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
  if (i.categoryId) await assertActiveCategory(ctx, i.categoryId);

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
  // Un egreso que se come dinero reservado para una meta se decide ANTES de confirmar (RN-GO04).
  let deductions: Deduction[] = [];
  if (i.kind !== 'income') {
    const reserved = await reserveConflict(ctx, i.accountId, amount);
    if (reserved) {
      if (i.goalDeductions && i.goalDeductions.length > 0) {
        await validateDeductions(ctx, i.accountId, reserved.eaten, i.goalDeductions, reserved.goals);
        deductions = i.goalDeductions;
      } else if (!i.acceptReserveShortfall) {
        throw unprocessable('GOAL_RESERVE_CONFLICT', 'Este gasto usa dinero reservado para una meta: elige de qué meta se descuenta o acepta el faltante', { accountId: i.accountId, eaten: formatMoney(reserved.eaten), goals: reserved.goals });
      }
    }
  }
  const id = await insertOperation(ctx, { kind: i.kind, date, description: i.description, contactId: i.contactId, categoryId: i.categoryId }, entries);
  if (deductions.length > 0) await applyDeductions(ctx, i.accountId, id, deductions);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: `operation.${i.kind}`, entityType: 'financial_operation', entityId: id, changes: { amount: formatMoney(amount) } });
  // Sin categoría elegida, mandan las reglas del usuario (RN-CL04): `assign` la fija y `suggest` solo la propone.
  const classification = !i.categoryId && i.kind !== 'transfer'
    ? await autoClassify(ctx, id, { accountId: i.accountId, direction: i.kind, amount, text: i.description ?? '' })
    : null;
  const created = await getOperation(ctx, id);
  // Avisos de presupuesto: informan, nunca bloquean el gasto (RN-BU01).
  const budgetImpact = i.kind === 'expense' ? await impactOf(ctx, created.category?.id ?? null, date) : [];
  return { ...created, classification, budgetImpact };
}

export async function getOperation(ctx: Ctx, id: string) {
  const op = await one<{ id: string; kind: string; occurred_on: string; description: string; status: string; reversal_of_id: string | null; reason: string | null; version: number; created_at: unknown; contact_id: string | null; category_id: string | null; category_name: string | null; concept: string }>(
    ctx.trx, sql`select o.id, o.kind, o.occurred_on, o.description, o.status, o.reversal_of_id, o.reason, o.version, o.created_at, o.contact_id, o.category_id, o.concept, c.name as category_name
      from financial_operation o left join category c on c.id = o.category_id and c.owner_id = o.owner_id where o.owner_id = ${ctx.ownerId} and o.id = ${id}`);
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
    concept: op.concept, contactId: op.contact_id, category: op.category_id ? { id: op.category_id, name: op.category_name } : null, classificationTrail: await decisionsOf(ctx, id),
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

export interface OperationListQuery {
  status?: 'confirmed' | 'reversed'; kind?: 'income' | 'expense' | 'transfer' | 'adjustment' | 'reversal' | 'opening'; accountId?: string; categoryId?: string;
  uncategorized?: boolean; from?: string; to?: string; q?: string; limit: number; offset: number;
}

/** Movimientos con filtros. «Sin categoría» excluye cobros y devoluciones: no se clasifican como ingreso ganado (RN-CL08). */
export async function listOperations(ctx: Ctx, q: OperationListQuery) {
  const r = await rows<{
    id: string; kind: string; occurred_on: string; description: string; status: string; category_id: string | null; category_name: string | null; contact_id: string | null; concept: string;
    account_id: string | null; to_account_id: string | null; amount: string | null; is_receipt: boolean; is_refund: boolean; is_supplier: boolean;
  }>(ctx.trx, sql`
    select o.id, o.kind, o.occurred_on, o.description, o.status, o.category_id, c.name as category_name, o.contact_id, o.concept,
      (select e.account_id from account_entry e where e.operation_id = o.id order by e.amount limit 1) as account_id,
      (select e.account_id from account_entry e where e.operation_id = o.id order by e.amount desc limit 1) as to_account_id,
      case when o.kind = 'transfer' then (select max(e.amount) from account_entry e where e.operation_id = o.id)
           else (select sum(e.amount) from account_entry e where e.operation_id = o.id) end as amount,
      exists(select 1 from receipt r where r.operation_id = o.id) as is_receipt,
      exists(select 1 from refund f where f.operation_id = o.id) as is_refund,
      exists(select 1 from supplier_payment s where s.operation_id = o.id) as is_supplier
    from financial_operation o left join category c on c.id = o.category_id and c.owner_id = o.owner_id
    where o.owner_id = ${ctx.ownerId}
      and (${q.status ?? null}::text is null or o.status = ${q.status ?? null})
      and (${q.kind ?? null}::text is null or o.kind = ${q.kind ?? null})
      and (${q.categoryId ?? null}::uuid is null or o.category_id = ${q.categoryId ?? null})
      and (${q.from ?? null}::date is null or o.occurred_on >= ${q.from ?? null}::date)
      and (${q.to ?? null}::date is null or o.occurred_on <= ${q.to ?? null}::date)
      and (${q.q ?? null}::text is null or o.description ilike '%' || ${q.q ?? null} || '%')
      and (${q.accountId ?? null}::uuid is null or exists(select 1 from account_entry e where e.operation_id = o.id and e.account_id = ${q.accountId ?? null}))
      and (${q.uncategorized ? true : null}::boolean is null or (o.category_id is null and o.kind in ('income','expense') and o.status = 'confirmed'
           and not exists(select 1 from receipt r where r.operation_id = o.id) and not exists(select 1 from refund f where f.operation_id = o.id)))
    order by o.occurred_on desc, o.created_at desc, o.id limit ${q.limit + 1} offset ${q.offset}`);
  const page = r.slice(0, q.limit);
  return {
    items: page.map((x) => ({
      id: x.id, kind: x.kind, concept: x.concept, occurredOn: x.occurred_on, description: x.description, status: x.status,
      category: x.category_id ? { id: x.category_id, name: x.category_name } : null, contactId: x.contact_id,
      accountId: x.account_id, toAccountId: x.kind === 'transfer' ? x.to_account_id : null, amount: formatMoney(parseMoney(x.amount ?? '0', { allowNegative: true })),
      links: { receipt: x.is_receipt, refund: x.is_refund, supplierPayment: x.is_supplier },
    })),
    nextCursor: r.length > q.limit ? Buffer.from(String(q.offset + q.limit)).toString('base64url') : null,
  };
}
