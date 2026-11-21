import { sql } from 'kysely';
import { cycleEnd } from '../domain/calendar.js';
import { cardWindow } from '../domain/card.js';
import { formatISO, parseISO } from '../domain/localDate.js';
import { formatMoney, parseMoney, splitEqual } from '../domain/money.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { ts, type Ctx } from './context.js';
import { createOperation } from './operations.js';

const m = (v: string) => formatMoney(parseMoney(v));

async function creditAccount(ctx: Ctx, accountId: string, requireActive = false) {
  const a = await one<{ id: string; type: string; name: string; status: string }>(ctx.trx, sql<{ id: string; type: string; name: string; status: string }>`
    select id, type, name, status from account where owner_id = ${ctx.ownerId} and id = ${accountId}`);
  if (!a) throw notFound('Account');
  if (a.type !== 'credit') throw unprocessable('NOT_CREDIT_ACCOUNT', 'Esta cuenta no es una tarjeta de crédito');
  if (requireActive && a.status !== 'active') throw unprocessable('ACCOUNT_ARCHIVED', 'La cuenta está archivada');
  return a;
}

// ───────────────────────── Configuración de la tarjeta ─────────────────────────

export interface CreditDetailsInput { creditLine?: string | null; cutoffDay: number; dueDay: number }

interface DetailsRow { credit_line: string | null; cutoff_day: number; due_day: number; version: number }

export async function getCreditDetails(ctx: Ctx, accountId: string) {
  await creditAccount(ctx, accountId);
  const d = await one<DetailsRow>(ctx.trx, sql<DetailsRow>`select credit_line, cutoff_day, due_day, version from credit_account_details where owner_id = ${ctx.ownerId} and account_id = ${accountId}`);
  return d ? { creditLine: d.credit_line === null ? null : m(d.credit_line), cutoffDay: d.cutoff_day, dueDay: d.due_day, version: d.version } : null;
}

/** La línea de crédito es un dato informativo: no es dinero propio y no entra en ningún saldo (RN-AC05). */
export async function putCreditDetails(ctx: Ctx, accountId: string, i: CreditDetailsInput) {
  await creditAccount(ctx, accountId, true);
  if (i.creditLine !== undefined && i.creditLine !== null && parseMoney(i.creditLine) <= 0n) {
    throw unprocessable('VALIDATION_ERROR', 'La línea de crédito debe ser positiva');
  }
  await sql`
    insert into credit_account_details (account_id, owner_id, credit_line, cutoff_day, due_day)
    values (${accountId}, ${ctx.ownerId}, ${i.creditLine ? m(i.creditLine) : null}, ${i.cutoffDay}, ${i.dueDay})
    on conflict (account_id) do update set credit_line = excluded.credit_line, cutoff_day = excluded.cutoff_day, due_day = excluded.due_day`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'card.configure', entityType: 'account', entityId: accountId, changes: { cutoffDay: i.cutoffDay, dueDay: i.dueDay } });
  return getCreditDetails(ctx, accountId);
}

// ───────────────────────── Estados de cuenta ─────────────────────────

export interface StatementInput { cutoffDate: string; dueDate: string; periodTotal: string; minimumPayment: string; totalBalance?: string | null; note?: string | null }

interface StRow {
  id: string; account_id: string; cutoff_date: string; due_date: string; period_total: string; minimum_payment: string; total_balance: string | null; note: string | null;
  status: string; void_reason: string | null; created_at: unknown;
}
interface PayRow { id: string; operation_id: string; occurred_on: string; amount: string }

async function paymentsOf(ctx: Ctx, statementId: string, accountId: string) {
  return rows<PayRow>(ctx.trx, sql<PayRow>`
    select p.id, p.operation_id, o.occurred_on, e.amount
    from card_statement_payment p join financial_operation o on o.id = p.operation_id and o.owner_id = p.owner_id
    join account_entry e on e.operation_id = o.id and e.owner_id = o.owner_id and e.account_id = ${accountId} and e.amount > 0
    where p.owner_id = ${ctx.ownerId} and p.statement_id = ${statementId} and p.status = 'active' and o.status = 'confirmed' order by o.occurred_on, p.created_at`);
}

/** Estado de pago derivado de los pagos vinculados (no se guarda). */
async function statementView(ctx: Ctx, s: StRow) {
  const pays = await paymentsOf(ctx, s.id, s.account_id);
  const paid = pays.reduce((a, p) => a + parseMoney(p.amount), 0n);
  const total = parseMoney(s.period_total);
  const remaining = total > paid ? total - paid : 0n;
  const today = formatISO(ctx.today);
  const status = s.status === 'void' ? 'void' : remaining === 0n ? 'paid' : paid > 0n ? 'partial' : 'unpaid';
  return {
    id: s.id, accountId: s.account_id, cutoffDate: s.cutoff_date, dueDate: s.due_date, periodTotal: m(s.period_total), minimumPayment: m(s.minimum_payment),
    totalBalance: s.total_balance === null ? null : m(s.total_balance), note: s.note, status, voidReason: s.void_reason, createdAt: ts(s.created_at),
    paid: formatMoney(paid), remaining: formatMoney(remaining), minimumCovered: paid >= parseMoney(s.minimum_payment),
    overdue: s.status === 'active' && remaining > 0n && s.due_date < today,
    // «Pago total del período» NO es toda la deuda: el saldo total solo se muestra si el banco lo informó (RN-T03).
    payments: pays.map((p) => ({ id: p.id, operationId: p.operation_id, occurredOn: p.occurred_on, amount: m(p.amount) })),
  };
}

const stBase = sql`select id, account_id, cutoff_date, due_date, period_total, minimum_payment, total_balance, note, status, void_reason, created_at from card_statement`;

export async function createStatement(ctx: Ctx, accountId: string, i: StatementInput) {
  await creditAccount(ctx, accountId, true);
  const cutoff = parseISO(i.cutoffDate);
  const due = parseISO(i.dueDate);
  if (due < cutoff) throw unprocessable('STATEMENT_DATES', 'La fecha límite de pago no puede ser anterior a la fecha de corte');
  if (cutoff > ctx.today) throw unprocessable('FUTURE_DATE_NOT_ALLOWED', 'El corte aún no ocurrió');
  const periodTotal = parseMoney(i.periodTotal);
  const minimumPayment = parseMoney(i.minimumPayment);
  if (periodTotal <= 0n) throw unprocessable('VALIDATION_ERROR', 'El total del período debe ser positivo');
  if (minimumPayment > periodTotal) throw unprocessable('VALIDATION_ERROR', 'El pago mínimo no puede superar el total del período');
  const dup = await one(ctx.trx, sql`select 1 from card_statement where owner_id = ${ctx.ownerId} and account_id = ${accountId} and cutoff_date = ${i.cutoffDate}::date and status = 'active'`);
  if (dup) throw conflict('STATEMENT_EXISTS', 'Ya registraste el estado de cuenta de ese corte');
  const r = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into card_statement (owner_id, account_id, cutoff_date, due_date, period_total, minimum_payment, total_balance, note)
    values (${ctx.ownerId}, ${accountId}, ${i.cutoffDate}, ${i.dueDate}, ${m(i.periodTotal)}, ${m(i.minimumPayment)}, ${i.totalBalance ? m(i.totalBalance) : null}, ${i.note?.trim() || null}) returning id`);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'card.statement', entityType: 'card_statement', entityId: r!.id, changes: { cutoffDate: i.cutoffDate, periodTotal: m(i.periodTotal) } });
  return getStatement(ctx, r!.id);
}

export async function getStatement(ctx: Ctx, id: string) {
  const s = await one<StRow>(ctx.trx, sql<StRow>`${stBase} where owner_id = ${ctx.ownerId} and id = ${id}`);
  if (!s) throw notFound('Statement');
  return statementView(ctx, s);
}

export async function listStatements(ctx: Ctx, accountId: string) {
  await creditAccount(ctx, accountId);
  const r = await rows<StRow>(ctx.trx, sql<StRow>`${stBase} where owner_id = ${ctx.ownerId} and account_id = ${accountId} order by cutoff_date desc, created_at desc`);
  const out = [];
  for (const s of r) out.push(await statementView(ctx, s));
  return out;
}

export async function voidStatement(ctx: Ctx, id: string, reason: string) {
  const s = await one<StRow>(ctx.trx, sql<StRow>`${stBase} where owner_id = ${ctx.ownerId} and id = ${id} for update`);
  if (!s) throw notFound('Statement');
  if (s.status === 'void') throw unprocessable('ALREADY_VOID', 'El estado de cuenta ya está anulado');
  await sql`update card_statement set status = 'void', void_reason = ${reason.trim()} where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await sql`update card_statement_payment set status = 'removed' where owner_id = ${ctx.ownerId} and statement_id = ${id} and status = 'active'`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'card.statement_void', entityType: 'card_statement', entityId: id, reason: reason.trim() });
  return getStatement(ctx, id);
}

/** Vincula un pago de la tarjeta (una transferencia hacia ella) a un estado de cuenta. No crea ninguna operación nueva. */
export async function linkPayment(ctx: Ctx, statementId: string, operationId: string) {
  const s = await one<StRow>(ctx.trx, sql<StRow>`${stBase} where owner_id = ${ctx.ownerId} and id = ${statementId} for update`);
  if (!s) throw notFound('Statement');
  if (s.status !== 'active') throw unprocessable('ALREADY_VOID', 'El estado de cuenta está anulado');
  const op = await one<{ kind: string; status: string }>(ctx.trx, sql<{ kind: string; status: string }>`select kind, status from financial_operation where owner_id = ${ctx.ownerId} and id = ${operationId}`);
  if (!op) throw notFound('Operation');
  const toCard = await one(ctx.trx, sql`select 1 from account_entry where owner_id = ${ctx.ownerId} and operation_id = ${operationId} and account_id = ${s.account_id} and amount > 0`);
  if (op.kind !== 'transfer' || op.status !== 'confirmed' || !toCard) throw unprocessable('NOT_A_CARD_PAYMENT', 'Solo una transferencia confirmada hacia esta tarjeta cuenta como su pago');
  const used = await one(ctx.trx, sql`select 1 from card_statement_payment where owner_id = ${ctx.ownerId} and operation_id = ${operationId} and status = 'active'`);
  if (used) throw conflict('PAYMENT_ALREADY_LINKED', 'Ese pago ya está vinculado a un estado de cuenta');
  await sql`insert into card_statement_payment (owner_id, statement_id, operation_id) values (${ctx.ownerId}, ${statementId}, ${operationId})`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'card.payment_link', entityType: 'card_statement', entityId: statementId, changes: { operationId } });
  return getStatement(ctx, statementId);
}

export async function unlinkPayment(ctx: Ctx, paymentId: string) {
  const p = await one<{ statement_id: string; status: string }>(ctx.trx, sql<{ statement_id: string; status: string }>`select statement_id, status from card_statement_payment where owner_id = ${ctx.ownerId} and id = ${paymentId} for update`);
  if (!p) throw notFound('Payment');
  if (p.status !== 'active') throw unprocessable('ALREADY_REMOVED', 'El vínculo ya se quitó');
  await sql`update card_statement_payment set status = 'removed' where owner_id = ${ctx.ownerId} and id = ${paymentId}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'card.payment_unlink', entityType: 'card_statement', entityId: p.statement_id });
  return getStatement(ctx, p.statement_id);
}

// ───────────────────────── Compras en cuotas ─────────────────────────

export interface InstallmentInput { amount: string; installments: number; firstDueDate: string; description?: string; categoryId?: string | null; date?: string }

interface PlanRow { id: string; account_id: string; operation_id: string; description: string; principal: string; installments: number; first_due_date: string; status: string; created_at: unknown }

async function planView(ctx: Ctx, p: PlanRow) {
  const items = await rows<{ number: number; due_date: string; amount: string }>(ctx.trx, sql`select number, due_date, amount from card_installment where owner_id = ${ctx.ownerId} and plan_id = ${p.id} order by number`);
  const today = formatISO(ctx.today);
  const upcoming = p.status === 'active' ? items.filter((x) => x.due_date >= today) : [];
  return {
    id: p.id, accountId: p.account_id, operationId: p.operation_id, description: p.description, principal: m(p.principal), installments: p.installments,
    firstDueDate: p.first_due_date, status: p.status, createdAt: ts(p.created_at),
    schedule: items.map((x) => ({ number: x.number, dueDate: x.due_date, amount: m(x.amount) })),
    upcomingTotal: formatMoney(upcoming.reduce((a, x) => a + parseMoney(x.amount), 0n)),
  };
}

/** Compra en cuotas con la tarjeta: UN gasto por el total (sube la deuda) y un calendario de cuotas informativo (RN-T04). */
export async function createInstallmentPurchase(ctx: Ctx, accountId: string, i: InstallmentInput) {
  await creditAccount(ctx, accountId, true);
  const op = await createOperation(ctx, { kind: 'expense', accountId, amount: i.amount, date: i.date, description: i.description, categoryId: i.categoryId });
  const principal = parseMoney(i.amount);
  const plan = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into card_installment_plan (owner_id, account_id, operation_id, description, principal, installments, first_due_date)
    values (${ctx.ownerId}, ${accountId}, ${op.id}, ${i.description?.trim() ?? ''}, ${formatMoney(principal)}, ${i.installments}, ${i.firstDueDate}) returning id`);
  const first = parseISO(i.firstDueDate);
  const parts = splitEqual(principal, i.installments);
  let due = first;
  for (let n = 1; n <= i.installments; n++) {
    await sql`insert into card_installment (owner_id, plan_id, number, due_date, amount) values (${ctx.ownerId}, ${plan!.id}, ${n}, ${formatISO(due)}, ${formatMoney(parts[n - 1]!)})`.execute(ctx.trx);
    due = cycleEnd(due, first, { unit: 'month', count: 1 }); // mismo día del mes (el último si no existe)
  }
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'card.installment_purchase', entityType: 'card_installment_plan', entityId: plan!.id, changes: { principal: formatMoney(principal), installments: i.installments } });
  const row = await one<PlanRow>(ctx.trx, sql<PlanRow>`select * from card_installment_plan where owner_id = ${ctx.ownerId} and id = ${plan!.id}`);
  return { ...(await planView(ctx, row!)), operation: op };
}

export async function listInstallmentPlans(ctx: Ctx, accountId: string) {
  await creditAccount(ctx, accountId);
  const r = await rows<PlanRow>(ctx.trx, sql<PlanRow>`select * from card_installment_plan where owner_id = ${ctx.ownerId} and account_id = ${accountId} order by created_at desc, id`);
  const out = [];
  for (const p of r) out.push(await planView(ctx, p));
  return out;
}

export async function cancelInstallmentPlan(ctx: Ctx, id: string) {
  const p = await one<PlanRow>(ctx.trx, sql<PlanRow>`select * from card_installment_plan where owner_id = ${ctx.ownerId} and id = ${id} for update`);
  if (!p) throw notFound('Plan');
  if (p.status === 'cancelled') throw unprocessable('ALREADY_CANCELLED', 'El plan ya está cancelado');
  await sql`update card_installment_plan set status = 'cancelled' where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'card.installment_cancel', entityType: 'card_installment_plan', entityId: id });
  return planView(ctx, { ...p, status: 'cancelled' });
}

// ───────────────────────── Asesor de tarjeta (RN-T06) ─────────────────────────

/** Qué tarjeta conviene usar hoy: la que da más días hasta pagar la compra, según corte y pago configurados. Solo matemática de fechas. */
export async function advisor(ctx: Ctx, date?: string) {
  const on = date ? parseISO(date) : ctx.today;
  const cards = await rows<{ id: string; name: string; institution: string | null; credit_line: string | null; cutoff_day: number; due_day: number; balance: string }>(ctx.trx, sql`
    select a.id, a.name, a.institution, d.credit_line, d.cutoff_day, d.due_day, coalesce(b.balance, 0.00) as balance
    from account a join credit_account_details d on d.account_id = a.id and d.owner_id = a.owner_id
    left join v_account_balance b on b.account_id = a.id and b.owner_id = a.owner_id
    where a.owner_id = ${ctx.ownerId} and a.status = 'active' and a.type = 'credit'`);
  const list = cards.map((c) => {
    const w = cardWindow(on, c.cutoff_day, c.due_day);
    const used = parseMoney(c.balance, { allowNegative: true });
    const owed = used < 0n ? -used : 0n;
    return {
      accountId: c.id, name: c.name, institution: c.institution, cutoffDate: formatISO(w.cutoff), dueDate: formatISO(w.due), daysToCutoff: w.daysToCutoff, daysToPay: w.daysToPay,
      debt: formatMoney(owed), available: c.credit_line === null ? null : formatMoney(parseMoney(c.credit_line) - owed),
    };
  }).sort((a, b) => b.daysToPay - a.daysToPay || a.name.localeCompare(b.name));
  return { date: formatISO(on), best: list[0] ?? null, cards: list, note: 'Solo compara fechas de corte y pago configuradas; no recomienda endeudarse.' };
}
