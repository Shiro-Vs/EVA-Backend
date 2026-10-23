import { sql } from 'kysely';
import { formatISO, parseISO } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { checkPreviewToken, makePreviewToken } from '../infra/preview.js';
import type { Ctx } from './context.js';
import { activeAccount, getOperation, insertOperation, requireOwned, resolveDate, reverseOperationCore } from './operations.js';
import { buildPlan as buildReceiptPlan, getReceipt, issueJson, writeReceipt, type ReceiptInput } from './receipts.js';

const m = (v: bigint) => formatMoney(v);

async function balanceOf(ctx: Ctx, accountId: string) {
  const r = await one<{ b: string }>(ctx.trx, sql<{ b: string }>`select coalesce(sum(amount), 0.00) as b from account_entry where owner_id = ${ctx.ownerId} and account_id = ${accountId}`);
  return parseMoney(r!.b, { allowNegative: true });
}
async function accountName(ctx: Ctx, accountId: string) {
  const r = await one<{ name: string }>(ctx.trx, sql<{ name: string }>`select name from account where owner_id = ${ctx.ownerId} and id = ${accountId}`);
  return r?.name ?? '';
}
/** Efecto neto sobre cada cuenta de revertir lo viejo y registrar lo nuevo. */
async function accountEffects(ctx: Ctx, delta: Map<string, bigint>) {
  const out = [];
  for (const [accountId, d] of [...delta.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const before = await balanceOf(ctx, accountId);
    out.push({ accountId, name: await accountName(ctx, accountId), balanceBefore: m(before), balanceAfter: m(before + d), delta: m(d) });
  }
  return out;
}
const addTo = (map: Map<string, bigint>, key: string, v: bigint) => map.set(key, (map.get(key) ?? 0n) + v);

// ───────────────────────── RN-V01: campos sin efecto financiero ─────────────────────────

export interface OperationPatch { description?: string; categoryId?: string | null; contactId?: string | null }

/** Corrige descripción, categoría o contacto de una operación confirmada. No toca saldos ni aplicaciones. */
export async function patchOperation(ctx: Ctx, id: string, version: number, p: OperationPatch) {
  const op = await one<{ kind: string; status: string; description: string; category_id: string | null; contact_id: string | null; version: number }>(ctx.trx, sql`
    select kind, status, description, category_id, contact_id, version from financial_operation where owner_id = ${ctx.ownerId} and id = ${id} for update`);
  if (!op) throw notFound('Operation');
  if (op.version !== version) throw conflict('CONFLICT_VERSION', 'The operation was modified; reload and retry');
  if (op.kind === 'reversal' || op.status === 'reversed') throw unprocessable('OPERATION_NOT_EDITABLE', 'A reversed operation or a reversal cannot be edited: the evidence stays as it was');

  if (p.categoryId) await requireOwned(ctx, 'category', p.categoryId);
  if (p.contactId) await requireOwned(ctx, 'contact', p.contactId);
  if (p.contactId !== undefined && p.contactId !== op.contact_id) {
    const linked = await one<{ n: string }>(ctx.trx, sql<{ n: string }>`
      select (select count(*) from receipt where operation_id = ${id}) + (select count(*) from supplier_payment where operation_id = ${id}) + (select count(*) from refund where operation_id = ${id}) as n`);
    if (Number(linked?.n ?? 0) > 0) throw unprocessable('OPERATION_LINKED', 'The contact of a receipt, refund or supplier payment cannot be changed');
  }
  const next = {
    description: p.description === undefined ? op.description : p.description.trim(),
    category_id: p.categoryId === undefined ? op.category_id : p.categoryId,
    contact_id: p.contactId === undefined ? op.contact_id : p.contactId,
  };
  await sql`
    update financial_operation set description = ${next.description}, category_id = ${next.category_id}, contact_id = ${next.contact_id}
    where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'operation.edit', entityType: 'financial_operation', entityId: id,
    changes: { before: { description: op.description, categoryId: op.category_id, contactId: op.contact_id }, after: { description: next.description, categoryId: next.category_id, contactId: next.contact_id } } });
  return getOperation(ctx, id);
}

/** Corrige la nota de un cobro (y la descripción de su ingreso); sin efecto financiero. */
export async function patchReceipt(ctx: Ctx, id: string, version: number, p: { note?: string | null }) {
  const r = await one<{ operation_id: string; note: string | null; status: string; version: number }>(ctx.trx, sql`
    select operation_id, note, status, version from receipt where owner_id = ${ctx.ownerId} and id = ${id} for update`);
  if (!r) throw notFound('Receipt');
  if (r.version !== version) throw conflict('CONFLICT_VERSION', 'The receipt was modified; reload and retry');
  if (r.status !== 'active') throw unprocessable('OPERATION_NOT_EDITABLE', 'A reversed receipt cannot be edited');
  const note = p.note === undefined ? r.note : (p.note?.trim() || null);
  await sql`update receipt set note = ${note} where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await sql`update financial_operation set description = ${note ?? 'Cobro'} where owner_id = ${ctx.ownerId} and id = ${r.operation_id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'receipt.edit', entityType: 'receipt', entityId: id, changes: { before: r.note, after: note } });
  return getReceipt(ctx, id);
}

// ───────────────────────── RN-V02: corregir fecha, cuenta o importe de una operación ─────────────────────────

export interface OperationCorrection { amount?: string; accountId?: string; toAccountId?: string; date?: string }

interface OpPlan {
  op: { id: string; kind: 'income' | 'expense' | 'transfer'; occurred_on: string; description: string; contact_id: string | null; category_id: string | null; source: string; version: number };
  oldFrom: string; oldTo: string | null; oldAmount: bigint; oldDate: string;
  newFrom: string; newTo: string | null; newAmount: bigint; newDate: string;
}

async function buildOpPlan(ctx: Ctx, id: string, i: OperationCorrection): Promise<OpPlan> {
  const op = await one<OpPlan['op'] & { status: string }>(ctx.trx, sql`
    select id, kind, status, occurred_on, description, contact_id, category_id, source, version from financial_operation where owner_id = ${ctx.ownerId} and id = ${id} for update`);
  if (!op) throw notFound('Operation');
  if (op.status === 'reversed' || (op.kind as string) === 'reversal') throw unprocessable('ALREADY_REVERSED', 'The operation is already reversed or is itself a reversal');
  if (!['income', 'expense', 'transfer'].includes(op.kind)) throw unprocessable('NOT_CORRECTABLE', 'This kind of operation cannot be corrected');
  const linked = await one<{ n: string }>(ctx.trx, sql<{ n: string }>`
    select (select count(*) from receipt where operation_id = ${id}) + (select count(*) from supplier_payment where operation_id = ${id}) + (select count(*) from refund where operation_id = ${id}) as n`);
  if (Number(linked?.n ?? 0) > 0) throw unprocessable('OPERATION_LINKED', 'This operation backs a receipt, refund or supplier payment: correct that record instead');

  const es = await rows<{ account_id: string; amount: string }>(ctx.trx, sql`select account_id, amount from account_entry where owner_id = ${ctx.ownerId} and operation_id = ${id} order by amount`);
  let oldFrom: string; let oldTo: string | null = null; let oldAmount: bigint;
  if (op.kind === 'transfer') {
    oldFrom = es.find((e) => parseMoney(e.amount, { allowNegative: true }) < 0n)!.account_id;
    oldTo = es.find((e) => parseMoney(e.amount, { allowNegative: true }) > 0n)!.account_id;
    oldAmount = parseMoney(es.find((e) => parseMoney(e.amount, { allowNegative: true }) > 0n)!.amount);
  } else {
    oldFrom = es[0]!.account_id;
    const raw = parseMoney(es[0]!.amount, { allowNegative: true });
    oldAmount = raw < 0n ? -raw : raw;
  }
  const newAmount = i.amount === undefined ? oldAmount : parseMoney(i.amount);
  if (newAmount <= 0n) throw unprocessable('VALIDATION_ERROR', 'The amount must be positive');
  const newFrom = i.accountId ?? oldFrom;
  const newTo = op.kind === 'transfer' ? (i.toAccountId ?? oldTo) : null;
  if (op.kind !== 'transfer' && i.toAccountId) throw unprocessable('VALIDATION_ERROR', 'toAccountId only applies to transfers');
  const from = await activeAccount(ctx, newFrom);
  if (newTo) {
    if (newTo === newFrom) throw unprocessable('VALIDATION_ERROR', 'The source and destination accounts must differ');
    const to = await activeAccount(ctx, newTo);
    if (to.currency !== from.currency) throw unprocessable('CURRENCY_MISMATCH', 'The accounts have different currencies');
  }
  const newDate = i.date === undefined ? op.occurred_on : formatISO(resolveDate(ctx, i.date));
  if (newAmount === oldAmount && newFrom === oldFrom && newTo === oldTo && newDate === op.occurred_on) throw unprocessable('NO_CHANGES', 'Nothing changes: the amount, account and date are the same');
  return { op: op as OpPlan['op'], oldFrom, oldTo, oldAmount, oldDate: op.occurred_on, newFrom, newTo, newAmount, newDate };
}

const opDelta = (p: OpPlan) => {
  const d = new Map<string, bigint>();
  if (p.op.kind === 'transfer') { addTo(d, p.oldFrom, p.oldAmount); addTo(d, p.oldTo!, -p.oldAmount); addTo(d, p.newFrom, -p.newAmount); addTo(d, p.newTo!, p.newAmount); }
  else {
    const sign = p.op.kind === 'income' ? 1n : -1n;
    addTo(d, p.oldFrom, -sign * p.oldAmount); // se revierte lo anterior
    addTo(d, p.newFrom, sign * p.newAmount); // y se registra lo nuevo
  }
  for (const [k, v] of d) if (v === 0n) d.delete(k);
  return d;
};
const opInputs = (id: string, i: OperationCorrection) => ({ id, amount: i.amount === undefined ? null : formatMoney(parseMoney(i.amount)), accountId: i.accountId ?? null, toAccountId: i.toAccountId ?? null, date: i.date ?? null });

async function opPreviewJson(ctx: Ctx, p: OpPlan) {
  return {
    operation: { id: p.op.id, kind: p.op.kind, description: p.op.description },
    before: { amount: m(p.oldAmount), accountId: p.oldFrom, toAccountId: p.oldTo, date: p.oldDate },
    after: { amount: m(p.newAmount), accountId: p.newFrom, toAccountId: p.newTo, date: p.newDate },
    effects: { accounts: await accountEffects(ctx, opDelta(p)) },
    willCreate: { reversal: true, operation: true },
    note: 'Se revierte la operación original y se registra una nueva, en una sola transacción. No se registra ninguna devolución de dinero.',
  };
}

export async function previewOperationCorrection(ctx: Ctx, id: string, i: OperationCorrection) {
  const p = await buildOpPlan(ctx, id, i);
  return { ...(await opPreviewJson(ctx, p)), previewToken: makePreviewToken(ctx.previewSecret, { scope: 'operation.correct', ownerId: ctx.ownerId, inputs: opInputs(id, i), state: { version: p.op.version } }, ctx.nowMs) };
}

export async function applyOperationCorrection(ctx: Ctx, id: string, body: OperationCorrection & { reason: string; previewToken: string }) {
  const { reason, previewToken, ...i } = body;
  const p = await buildOpPlan(ctx, id, i);
  checkPreviewToken(ctx.previewSecret, previewToken, { scope: 'operation.correct', ownerId: ctx.ownerId, inputs: opInputs(id, i), state: { version: p.op.version } }, ctx.nowMs);
  const reversalId = await reverseOperationCore(ctx, id, reason.trim());
  const entries = p.op.kind === 'transfer'
    ? [{ accountId: p.newFrom, amount: -p.newAmount }, { accountId: p.newTo!, amount: p.newAmount }]
    : [{ accountId: p.newFrom, amount: p.op.kind === 'income' ? p.newAmount : -p.newAmount }];
  const newId = await insertOperation(ctx, { kind: p.op.kind, date: parseISO(p.newDate), description: p.op.description, contactId: p.op.contact_id, categoryId: p.op.category_id, source: p.op.source }, entries);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'operation.correct', entityType: 'financial_operation', entityId: id, reason: reason.trim(),
    changes: { replacedBy: newId, reversalId, from: { amount: m(p.oldAmount), accountId: p.oldFrom, date: p.oldDate }, to: { amount: m(p.newAmount), accountId: p.newFrom, date: p.newDate } } });
  return { reversalId, operation: await getOperation(ctx, newId), effects: (await opPreviewJson(ctx, p)).effects };
}


// ───────────────────────── RN-V02/V04/V05: corregir o revertir un cobro ─────────────────────────

export interface ReceiptCorrection {
  amount?: string;
  accountId?: string;
  receivedOn?: string;
  allocations?: Array<{ obligationId: string; amount: string }>;
  reserveRemainder?: { subscriptionId: string } | null;
}

interface OldReceipt {
  id: string; contactId: string; contactName: string; operationId: string; amount: bigint; receivedOn: string; note: string | null; version: number; accountId: string;
  allocations: Array<{ id: string; obligationId: string; amount: bigint; origin: string }>;
}

async function loadReceipt(ctx: Ctx, id: string): Promise<OldReceipt> {
  const r = await one<{ id: string; contact_id: string; contact_name: string; operation_id: string; amount: string; received_on: string; note: string | null; status: string; version: number }>(ctx.trx, sql`
    select r.id, r.contact_id, c.name as contact_name, r.operation_id, r.amount, r.received_on, r.note, r.status, r.version
    from receipt r join contact c on c.id = r.contact_id and c.owner_id = r.owner_id
    where r.owner_id = ${ctx.ownerId} and r.id = ${id} for update of r`);
  if (!r) throw notFound('Receipt');
  if (r.status !== 'active') throw unprocessable('ALREADY_REVERSED', 'The receipt is already reversed');
  const refunds = await one<{ n: string }>(ctx.trx, sql<{ n: string }>`select count(*) as n from refund where owner_id = ${ctx.ownerId} and receipt_id = ${id} and status in ('planned','paid')`);
  if (Number(refunds!.n) > 0) throw unprocessable('RECEIPT_HAS_REFUNDS', 'This receipt has refunds: cancel the planned ones first (a paid refund cannot be undone from here)');
  const acc = await one<{ account_id: string }>(ctx.trx, sql<{ account_id: string }>`select account_id from account_entry where owner_id = ${ctx.ownerId} and operation_id = ${r.operation_id} limit 1`);
  const al = await rows<{ id: string; obligation_id: string; amount: string; origin: string }>(ctx.trx, sql`
    select id, obligation_id, amount, origin from payment_allocation where owner_id = ${ctx.ownerId} and receipt_id = ${id} and status = 'active' order by created_at, id`);
  return {
    id, contactId: r.contact_id, contactName: r.contact_name, operationId: r.operation_id, amount: parseMoney(r.amount), receivedOn: r.received_on, note: r.note, version: r.version,
    accountId: acc!.account_id, allocations: al.map((a) => ({ id: a.id, obligationId: a.obligation_id, amount: parseMoney(a.amount), origin: a.origin })),
  };
}

const grouped = (allocs: OldReceipt['allocations']) => {
  const g = new Map<string, bigint>();
  for (const a of allocs) addTo(g, a.obligationId, a.amount);
  return [...g.entries()].map(([obligationId, amount]) => ({ obligationId, amount: m(amount) }));
};

const receiptInputs = (id: string, i: ReceiptCorrection) => ({
  id, amount: i.amount === undefined ? null : formatMoney(parseMoney(i.amount)), accountId: i.accountId ?? null, receivedOn: i.receivedOn ?? null,
  allocations: i.allocations === undefined ? null : i.allocations.map((a) => [a.obligationId, formatMoney(parseMoney(a.amount))]).sort(),
  reserve: i.reserveRemainder === undefined ? 'default' : i.reserveRemainder,
});
const oldState = (o: OldReceipt) => ({ version: o.version, allocations: o.allocations.map((a) => `${a.id}:${m(a.amount)}`) });

async function releaseAndReverse(ctx: Ctx, o: OldReceipt, reason: string) {
  await sql`
    update payment_allocation set status = 'released', released_reason = ${`Corrección: ${reason}`}, released_at = now()
    where owner_id = ${ctx.ownerId} and receipt_id = ${o.id} and status = 'active'`.execute(ctx.trx);
  await sql`update credit_reservation set status = 'released' where owner_id = ${ctx.ownerId} and receipt_id = ${o.id} and status = 'active'`.execute(ctx.trx);
  const reversalId = await reverseOperationCore(ctx, o.operationId, reason, undefined, { allowLinked: true });
  await sql`update receipt set status = 'reversed' where owner_id = ${ctx.ownerId} and id = ${o.id}`.execute(ctx.trx);
  return reversalId;
}

export async function previewReceiptReversal(ctx: Ctx, id: string) {
  const o = await loadReceipt(ctx, id);
  const delta = new Map<string, bigint>(); addTo(delta, o.accountId, -o.amount);
  const released = grouped(o.allocations);
  const pend = await rows<{ obligation_id: string; pending: string }>(ctx.trx, sql`
    select obligation_id, pending_amount as pending from v_obligation_balance where owner_id = ${ctx.ownerId} and obligation_id = any(${released.map((r) => r.obligationId)}::uuid[])`);
  return {
    receipt: { id, contact: { id: o.contactId, name: o.contactName }, amount: m(o.amount), accountId: o.accountId, receivedOn: o.receivedOn },
    effects: {
      accounts: await accountEffects(ctx, delta),
      releasedAllocations: released,
      obligationsAfter: released.map((r) => ({ obligationId: r.obligationId, pendingAfter: m(parseMoney(pend.find((x) => x.obligation_id === r.obligationId)?.pending ?? '0') + parseMoney(r.amount)) })),
    },
    willCreate: { reversal: true, receipt: false },
    note: 'Revertir no es devolver dinero: el ingreso se anula y las deudas vuelven a quedar pendientes. La evidencia se conserva.',
    previewToken: makePreviewToken(ctx.previewSecret, { scope: 'receipt.reverse', ownerId: ctx.ownerId, inputs: { id }, state: oldState(o) }, ctx.nowMs),
  };
}

export async function applyReceiptReversal(ctx: Ctx, id: string, reason: string, previewToken: string) {
  const o = await loadReceipt(ctx, id);
  checkPreviewToken(ctx.previewSecret, previewToken, { scope: 'receipt.reverse', ownerId: ctx.ownerId, inputs: { id }, state: oldState(o) }, ctx.nowMs);
  const reversalId = await releaseAndReverse(ctx, o, reason.trim());
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'receipt.reverse', entityType: 'receipt', entityId: id, reason: reason.trim(), changes: { amount: m(o.amount), reversalId } });
  return { id, status: 'reversed', reversalId, receipt: await getReceipt(ctx, id) };
}

function correctedInput(o: OldReceipt, i: ReceiptCorrection): ReceiptInput {
  return {
    contactId: o.contactId, accountId: i.accountId ?? o.accountId, amount: i.amount ?? m(o.amount), receivedOn: i.receivedOn ?? o.receivedOn, note: o.note ?? undefined,
    allocations: i.allocations ?? grouped(o.allocations), reserveRemainder: i.reserveRemainder,
  };
}

async function receiptCorrectionPlan(ctx: Ctx, id: string, i: ReceiptCorrection) {
  const o = await loadReceipt(ctx, id);
  const input = correctedInput(o, i);
  const changed = parseMoney(input.amount) !== o.amount || input.accountId !== o.accountId || input.receivedOn !== o.receivedOn || i.allocations !== undefined || i.reserveRemainder !== undefined;
  if (!changed) throw unprocessable('NO_CHANGES', 'Nothing changes: the amount, account, date and allocations are the same');
  const plan = await buildReceiptPlan(ctx, input, { excludeReceiptId: id });
  return { o, input, plan };
}

export async function previewReceiptCorrection(ctx: Ctx, id: string, i: ReceiptCorrection) {
  const { o, input, plan } = await receiptCorrectionPlan(ctx, id, i);
  const delta = new Map<string, bigint>(); addTo(delta, o.accountId, -o.amount); addTo(delta, input.accountId, plan.amount);
  for (const [k, v] of delta) if (v === 0n) delta.delete(k);
  const applied = plan.allocations.reduce((a, x) => a + x.amount, 0n);
  const valid = plan.issues.length === 0;
  return {
    valid,
    issues: plan.issues.map(issueJson),
    receipt: { id, contact: { id: o.contactId, name: o.contactName } },
    before: { amount: m(o.amount), accountId: o.accountId, receivedOn: o.receivedOn },
    after: { amount: m(plan.amount), accountId: input.accountId, receivedOn: formatISO(plan.receivedOn) },
    effects: {
      accounts: await accountEffects(ctx, delta),
      releasedAllocations: grouped(o.allocations),
      rebuiltAllocations: plan.allocations.map((a) => ({ obligationId: a.obligationId, amount: m(a.amount), pendingBefore: m(a.pending), pendingAfter: m(a.pending - a.amount) })),
      remainder: m(plan.amount - applied), reservedTo: plan.reserveTo,
    },
    willCreate: { reversal: true, receipt: true },
    note: 'Se anula el cobro original y se registra uno nuevo con el reparto que elijas, en una sola transacción. No se registra ninguna devolución de dinero.',
    ...(valid ? { previewToken: makePreviewToken(ctx.previewSecret, { scope: 'receipt.correct', ownerId: ctx.ownerId, inputs: receiptInputs(id, i), state: { old: oldState(o), pendings: plan.allocations.map((a) => [a.obligationId, m(a.pending)]).sort() } }, ctx.nowMs) } : {}),
  };
}

export async function applyReceiptCorrection(ctx: Ctx, id: string, body: ReceiptCorrection & { reason: string; previewToken: string }) {
  const { reason, previewToken, ...i } = body;
  const { o, input, plan } = await receiptCorrectionPlan(ctx, id, i);
  if (plan.issues.length > 0) {
    const first = plan.issues[0]!;
    throw unprocessable(first.code === 'EXCEEDS_RECEIPT' || first.code === 'EXCEEDS_OBLIGATION' ? 'OVER_ALLOCATION' : 'VALIDATION_ERROR', 'The allocation is not valid', plan.issues.map(issueJson));
  }
  checkPreviewToken(ctx.previewSecret, previewToken, { scope: 'receipt.correct', ownerId: ctx.ownerId, inputs: receiptInputs(id, i), state: { old: oldState(o), pendings: plan.allocations.map((a) => [a.obligationId, m(a.pending)]).sort() } }, ctx.nowMs);

  const reversalId = await releaseAndReverse(ctx, o, reason.trim());
  const fresh = await buildReceiptPlan(ctx, input); // ya sin lo aplicado por el cobro anterior
  if (fresh.issues.length > 0) throw unprocessable('OVER_ALLOCATION', 'The allocation is not valid', fresh.issues.map(issueJson));
  const created = await writeReceipt(ctx, input, fresh);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'receipt.correct', entityType: 'receipt', entityId: id, reason: reason.trim(),
    changes: { replacedBy: created.receipt.id, reversalId, from: { amount: m(o.amount), accountId: o.accountId, receivedOn: o.receivedOn }, to: { amount: m(fresh.amount), accountId: input.accountId } } });
  return { reversalId, replacedReceiptId: id, ...created };
}
