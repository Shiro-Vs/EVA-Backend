import { sql } from 'kysely';
import { formatISO, parseISO } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { checkPreviewToken, makePreviewToken } from '../infra/preview.js';
import { ts, type Ctx } from './context.js';
import { activeAccount, insertOperation } from './operations.js';

const m = (v: bigint | string) => (typeof v === 'bigint' ? formatMoney(v) : formatMoney(parseMoney(v, { allowNegative: true })));

export interface ReconcileInput { realBalance: string; asOf?: string }

async function plan(ctx: Ctx, accountId: string, i: ReconcileInput) {
  const acc = await one<{ name: string; type: string }>(ctx.trx, sql<{ name: string; type: string }>`select name, type from account where owner_id = ${ctx.ownerId} and id = ${accountId}`);
  if (!acc) throw notFound('Account');
  const asOf = i.asOf ? parseISO(i.asOf) : ctx.today;
  if (asOf > ctx.today) throw unprocessable('FUTURE_DATE_NOT_ALLOWED', 'La fecha no puede ser posterior a hoy');
  const real = parseMoney(i.realBalance, { allowNegative: true });
  if (acc.type === 'credit' && real > 0n) throw unprocessable('VALIDATION_ERROR', 'En una tarjeta de crédito el saldo real es la deuda y se indica en negativo');
  if (acc.type !== 'credit' && real < 0n) throw unprocessable('VALIDATION_ERROR', 'El saldo real no puede ser negativo');
  const reg = await one<{ b: string }>(ctx.trx, sql<{ b: string }>`
    select coalesce(sum(e.amount), 0.00) as b from account_entry e join financial_operation o on o.id = e.operation_id and o.owner_id = e.owner_id
    where e.owner_id = ${ctx.ownerId} and e.account_id = ${accountId} and o.occurred_on <= ${formatISO(asOf)}::date`);
  const registered = parseMoney(reg!.b, { allowNegative: true });
  return { acc, asOf, real, registered, difference: real - registered };
}

const inputsOf = (accountId: string, i: ReconcileInput) => ({ accountId, realBalance: m(i.realBalance), asOf: i.asOf ?? null });

/** Compara el saldo real con el registrado a una fecha y muestra qué revisar ANTES de ajustar (RN-CO01). */
export async function previewReconciliation(ctx: Ctx, accountId: string, i: ReconcileInput) {
  await activeAccount(ctx, accountId);
  const p = await plan(ctx, accountId, i);
  const recent = await rows<{ id: string; occurred_on: string; kind: string; description: string; status: string; amount: string }>(ctx.trx, sql`
    select o.id, o.occurred_on, o.kind, o.description, o.status, e.amount
    from account_entry e join financial_operation o on o.id = e.operation_id and o.owner_id = e.owner_id
    where e.owner_id = ${ctx.ownerId} and e.account_id = ${accountId} and o.occurred_on <= ${formatISO(p.asOf)}::date
    order by o.occurred_on desc, o.created_at desc limit 15`);
  return {
    account: { id: accountId, name: p.acc.name }, asOf: formatISO(p.asOf), registeredBalance: m(p.registered), realBalance: m(p.real), difference: m(p.difference),
    status: p.difference === 0n ? 'matched' : 'difference',
    review: recent.map((r) => ({ operationId: r.id, date: r.occurred_on, kind: r.kind, description: r.description, status: r.status, amount: m(r.amount) })),
    note: p.difference === 0n
      ? 'El saldo coincide: se registra la conciliación sin ajuste.'
      : 'Antes de ajustar, revisa y corrige los movimientos recientes. Si la diferencia no se explica, el ajuste queda en una línea propia: no es ingreso ni gasto de consumo.',
    previewToken: makePreviewToken(ctx.previewSecret, { scope: 'account.reconcile', ownerId: ctx.ownerId, inputs: inputsOf(accountId, i), state: { registered: m(p.registered) } }, ctx.nowMs),
  };
}

export async function reconcile(ctx: Ctx, accountId: string, i: ReconcileInput & { reason?: string; previewToken: string }) {
  await activeAccount(ctx, accountId);
  const p = await plan(ctx, accountId, i);
  checkPreviewToken(ctx.previewSecret, i.previewToken, { scope: 'account.reconcile', ownerId: ctx.ownerId, inputs: inputsOf(accountId, i), state: { registered: m(p.registered) } }, ctx.nowMs);
  const reason = i.reason?.trim();
  if (p.difference !== 0n && !reason) throw unprocessable('VALIDATION_ERROR', 'Indica el motivo del ajuste');
  let opId: string | null = null;
  if (p.difference !== 0n) {
    opId = await insertOperation(ctx, { kind: 'adjustment', date: p.asOf, description: `Ajuste de conciliación: ${reason}`, concept: 'reconciliation', source: 'manual' }, [{ accountId, amount: p.difference }]);
  }
  const r = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into reconciliation (owner_id, account_id, as_of, registered_balance, real_balance, difference, adjustment_operation_id, reason, created_by)
    values (${ctx.ownerId}, ${accountId}, ${formatISO(p.asOf)}, ${m(p.registered)}, ${m(p.real)}, ${m(p.difference)}, ${opId}, ${reason ?? null}, ${ctx.actorId}) returning id`);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'account.reconcile', entityType: 'account', entityId: accountId, reason: reason ?? null,
    changes: { asOf: formatISO(p.asOf), before: m(p.registered), real: m(p.real), difference: m(p.difference), operationId: opId } });
  return getReconciliation(ctx, r!.id);
}

interface RecRow { id: string; account_id: string; as_of: string; registered_balance: string; real_balance: string; difference: string; adjustment_operation_id: string | null; reason: string | null; created_at: unknown }

const view = (r: RecRow) => ({
  id: r.id, accountId: r.account_id, asOf: r.as_of, registeredBefore: m(r.registered_balance), realBalance: m(r.real_balance), difference: m(r.difference),
  // Saldo antes y después del ajuste, tal como se conservan (RN-CO02).
  balanceAfter: m(parseMoney(r.registered_balance, { allowNegative: true }) + parseMoney(r.difference, { allowNegative: true })),
  adjustmentOperationId: r.adjustment_operation_id, reason: r.reason, adjusted: r.adjustment_operation_id !== null, createdAt: ts(r.created_at),
});

export async function getReconciliation(ctx: Ctx, id: string) {
  const r = await one<RecRow>(ctx.trx, sql<RecRow>`select id, account_id, as_of, registered_balance, real_balance, difference, adjustment_operation_id, reason, created_at from reconciliation where owner_id = ${ctx.ownerId} and id = ${id}`);
  if (!r) throw notFound('Reconciliation');
  return view(r);
}

export async function listReconciliations(ctx: Ctx, accountId: string) {
  const a = await one(ctx.trx, sql`select 1 from account where owner_id = ${ctx.ownerId} and id = ${accountId}`);
  if (!a) throw notFound('Account');
  const r = await rows<RecRow>(ctx.trx, sql<RecRow>`select id, account_id, as_of, registered_balance, real_balance, difference, adjustment_operation_id, reason, created_at from reconciliation where owner_id = ${ctx.ownerId} and account_id = ${accountId} order by created_at desc, id`);
  return r.map(view);
}
