import { sql } from 'kysely';
import {
  checkSchedule, factsFromLoan, KIND_OF_DOCTYPE, LOAN_CORE_FACTS, normalizeFact, type DocKind, type FactIn, type LoanFactKey, type LoanInstallmentIn,
} from '../domain/bankLoan.js';
import { extractionSchema } from '../domain/capture.js';
import { formatISO } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { checkPreviewToken, makePreviewToken } from '../infra/preview.js';
import { ts, type Ctx } from './context.js';
import type { Deduction } from './goals.js';
import { activeAccount, createOperation, requireOwned, reverseOperationCore } from './operations.js';

const m = (v: string | bigint) => (typeof v === 'bigint' ? formatMoney(v) : formatMoney(parseMoney(v)));
const mOpt = (v: string | null) => (v === null ? null : m(v));

// ───────────────────────── Préstamo ─────────────────────────

export interface BankLoanInput { name: string; entity?: string | null; accountId?: string | null; note?: string | null }
interface LoanRow { id: string; name: string; entity: string | null; account_id: string | null; note: string | null; status: string; version: number; created_at: unknown }
const loanSel = sql`select id, name, entity, account_id, note, status, version, created_at from bank_loan`;

async function loadLoan(ctx: Ctx, id: string, lock = false) {
  const l = await one<LoanRow>(ctx.trx, lock ? sql<LoanRow>`${loanSel} where owner_id = ${ctx.ownerId} and id = ${id} for update` : sql<LoanRow>`${loanSel} where owner_id = ${ctx.ownerId} and id = ${id}`);
  if (!l) throw notFound('BankLoan');
  return l;
}

export async function createBankLoan(ctx: Ctx, i: BankLoanInput) {
  if (i.accountId) await requireOwned(ctx, 'account', i.accountId);
  const l = await one<LoanRow>(ctx.trx, sql<LoanRow>`
    insert into bank_loan (owner_id, name, entity, account_id, note) values (${ctx.ownerId}, ${i.name.trim()}, ${i.entity?.trim() || null}, ${i.accountId ?? null}, ${i.note?.trim() || null})
    returning id, name, entity, account_id, note, status, version, created_at`);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'bank_loan.create', entityType: 'bank_loan', entityId: l!.id });
  return getBankLoan(ctx, l!.id);
}

export async function patchBankLoan(ctx: Ctx, id: string, version: number, p: { name?: string; entity?: string | null; accountId?: string | null; note?: string | null; status?: 'active' | 'closed' }) {
  const l = await loadLoan(ctx, id, true);
  if (l.version !== version) throw conflict('VERSION_CONFLICT', 'El préstamo cambió; recárgalo');
  if (p.accountId) await requireOwned(ctx, 'account', p.accountId);
  const has = (k: keyof typeof p) => k in p;
  await sql`
    update bank_loan set name = ${p.name?.trim() ?? l.name}, entity = ${has('entity') ? p.entity?.trim() || null : l.entity}, account_id = ${has('accountId') ? p.accountId ?? null : l.account_id},
      note = ${has('note') ? p.note?.trim() || null : l.note}, status = ${p.status ?? l.status} where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'bank_loan.update', entityType: 'bank_loan', entityId: id });
  return getBankLoan(ctx, id);
}

// ───────────────────────── Datos, cuotas y calendario ─────────────────────────

interface FactRow { key: LoanFactKey; value: string; as_of: string | null; origin: 'document' | 'user'; document_id: string | null; confirmed_at: unknown }
const currentFacts = (ctx: Ctx, loanId: string) => rows<FactRow>(ctx.trx, sql<FactRow>`
  select key, value, as_of::text as as_of, origin, document_id, confirmed_at from bank_loan_fact where owner_id = ${ctx.ownerId} and loan_id = ${loanId} and superseded_at is null order by key`);

interface InstRow {
  id: string; no: number; due_date: string; principal: string | null; interest: string | null; insurance: string | null; fees: string | null; total: string;
  status: 'scheduled' | 'paid' | 'superseded'; origin: 'document' | 'user'; document_id: string | null; paid_amount: string; paid_on: string | null;
}
const liveInstallments = (ctx: Ctx, loanId: string, lock = false) => rows<InstRow>(ctx.trx, lock
  ? sql<InstRow>`select id, no, due_date::text as due_date, principal, interest, insurance, fees, total, status, origin, document_id, paid_amount, paid_on::text as paid_on from bank_loan_installment where owner_id = ${ctx.ownerId} and loan_id = ${loanId} and status <> 'superseded' order by no for update`
  : sql<InstRow>`select id, no, due_date::text as due_date, principal, interest, insurance, fees, total, status, origin, document_id, paid_amount, paid_on::text as paid_on from bank_loan_installment where owner_id = ${ctx.ownerId} and loan_id = ${loanId} and status <> 'superseded' order by no`);

const instView = (i: InstRow, today: string) => {
  const paid = parseMoney(i.paid_amount); const total = parseMoney(i.total);
  const done = i.status === 'paid';
  // «Vencida» solo informa: nunca genera mora ni recalcula nada (RN-B07).
  const state = done ? 'paid' : paid > 0n ? (i.due_date < today ? 'partial_overdue' : 'partial') : i.due_date < today ? 'overdue' : 'upcoming';
  return {
    id: i.id, number: i.no, dueDate: i.due_date, principal: mOpt(i.principal), interest: mOpt(i.interest), insurance: mOpt(i.insurance), fees: mOpt(i.fees), total: m(i.total),
    paidAmount: m(i.paid_amount), remaining: m(total > paid ? total - paid : 0n), paidOn: i.paid_on, late: done && i.paid_on !== null && i.paid_on > i.due_date,
    state, origin: i.origin, documentId: i.document_id,
  };
};

export async function getBankLoan(ctx: Ctx, id: string) {
  const l = await loadLoan(ctx, id);
  const today = formatISO(ctx.today);
  const facts = await currentFacts(ctx, id);
  const inst = await liveInstallments(ctx, id);
  const pays = await rows<{ id: string; installment_id: string | null; operation_id: string; amount: string; paid_on: string; principal: string | null; interest: string | null; insurance: string | null; fees: string | null; note: string | null; status: string }>(ctx.trx, sql`
    select id, installment_id, operation_id, amount, paid_on::text as paid_on, principal, interest, insurance, fees, note, status from bank_loan_payment where owner_id = ${ctx.ownerId} and loan_id = ${id} order by paid_on desc, created_at desc, id`);
  const docs = await rows<{ id: string; kind: string; document_id: string | null; summary: unknown; confirmed_at: unknown }>(ctx.trx, sql`
    select id, kind, document_id, summary, confirmed_at from bank_loan_document where owner_id = ${ctx.ownerId} and loan_id = ${id} order by confirmed_at desc, id`);
  const known = new Set(facts.map((f) => f.key));
  const active = pays.filter((p) => p.status === 'active');
  const scheduled = inst.reduce((a, i) => a + parseMoney(i.total), 0n);
  const remaining = inst.reduce((a, i) => { const t = parseMoney(i.total); const p = parseMoney(i.paid_amount); return a + (t > p ? t - p : 0n); }, 0n);
  const next = inst.find((i) => i.status !== 'paid');
  const live = inst.map((i) => instView(i, today));
  return {
    id: l.id, name: l.name, entity: l.entity, accountId: l.account_id, note: l.note, status: l.status, version: l.version, createdAt: ts(l.created_at),
    facts: facts.map((f) => ({ key: f.key, value: f.value, asOf: f.as_of, origin: f.origin, documentId: f.document_id, confirmedAt: ts(f.confirmed_at) })),
    // Lo que aún no se conoce: informativo, nunca bloquea registrar un pago (RN-B04).
    pending: LOAN_CORE_FACTS.filter((k) => !known.has(k)),
    installments: live,
    nextDue: next ? { number: next.no, dueDate: next.due_date, remaining: m(parseMoney(next.total) - parseMoney(next.paid_amount) > 0n ? parseMoney(next.total) - parseMoney(next.paid_amount) : 0n) } : null,
    totals: { scheduled: m(scheduled), paid: m(active.reduce((a, p) => a + parseMoney(p.amount), 0n)), remainingScheduled: m(remaining), overdue: live.filter((i) => i.state === 'overdue' || i.state === 'partial_overdue').length },
    payments: pays.map((p) => ({ id: p.id, installmentId: p.installment_id, operationId: p.operation_id, amount: m(p.amount), paidOn: p.paid_on, principal: mOpt(p.principal), interest: mOpt(p.interest), insurance: mOpt(p.insurance), fees: mOpt(p.fees), note: p.note, status: p.status })),
    documents: docs.map((d) => ({ id: d.id, kind: d.kind, documentId: d.document_id, summary: d.summary, confirmedAt: ts(d.confirmed_at) })),
    warnings: checkSchedule(inst.map(toIn), { principal: facts.find((f) => f.key === 'principal')?.value ?? null, installmentsCount: Number(facts.find((f) => f.key === 'installments_count')?.value ?? 0) || null }),
  };
}

const toIn = (i: InstRow): LoanInstallmentIn => ({ number: i.no, dueDate: i.due_date, principal: mOpt(i.principal), interest: mOpt(i.interest), insurance: mOpt(i.insurance), fees: mOpt(i.fees), total: m(i.total) });

export async function listBankLoans(ctx: Ctx, status?: string) {
  const ls = await rows<LoanRow>(ctx.trx, sql<LoanRow>`${loanSel} where owner_id = ${ctx.ownerId} and (${status ?? null}::text is null or status = ${status ?? null}) order by status, created_at desc, id`);
  return Promise.all(ls.map(async (l) => {
    const d = await getBankLoan(ctx, l.id);
    return { id: d.id, name: d.name, entity: d.entity, status: d.status, nextDue: d.nextDue, remainingScheduled: d.totals.remainingScheduled, overdue: d.totals.overdue, pending: d.pending };
  }));
}

// ───────────────────────── Cambios: documento o manual → vista previa → confirmar ─────────────────────────

export interface ChangeInput {
  documentId?: string;
  kind?: DocKind;
  /** Correcciones del usuario a lo leído, o datos manuales. */
  facts?: Array<{ key: LoanFactKey; value: string; asOf?: string | null }>;
  installments?: LoanInstallmentIn[];
}

interface Plan {
  kind: DocKind; documentId: string | null;
  facts: Array<FactIn & { origin: 'document' | 'user' }>;
  installments: Array<LoanInstallmentIn & { origin: 'document' | 'user' }> | null;
}

const sameRow = (a: LoanInstallmentIn, b: LoanInstallmentIn) =>
  a.number === b.number && a.dueDate === b.dueDate && a.principal === b.principal && a.interest === b.interest && a.insurance === b.insurance && a.fees === b.fees && a.total === b.total;

const normRow = (r: LoanInstallmentIn): LoanInstallmentIn => ({ ...r, principal: r.principal === null ? null : m(r.principal), interest: r.interest === null ? null : m(r.interest), insurance: r.insurance === null ? null : m(r.insurance), fees: r.fees === null ? null : m(r.fees), total: m(r.total) });

async function planOf(ctx: Ctx, i: ChangeInput): Promise<Plan> {
  let kind: DocKind;
  let docFacts: FactIn[] = [];
  let docRows: LoanInstallmentIn[] | null = null;
  if (i.documentId) {
    if (!i.kind) throw unprocessable('VALIDATION_ERROR', 'Indica el tipo de documento (kind)');
    const d = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`select id from source_document where owner_id = ${ctx.ownerId} and id = ${i.documentId}`);
    if (!d) throw notFound('Document');
    const run = await one<{ raw: unknown }>(ctx.trx, sql<{ raw: unknown }>`select raw from extraction_run where owner_id = ${ctx.ownerId} and document_id = ${i.documentId} and status = 'ok' order by created_at desc, id desc limit 1`);
    const parsed = run ? extractionSchema.safeParse(run.raw) : null;
    if (!parsed?.success || !parsed.data.loan) throw unprocessable('NO_LOAN_DATA', 'El documento no trae datos de un préstamo');
    // Los tipos de documento no son intercambiables (RN-B03).
    if (KIND_OF_DOCTYPE[parsed.data.documentType] !== i.kind) throw unprocessable('DOCUMENT_KIND_MISMATCH', `El documento es de tipo ${parsed.data.documentType} y no puede usarse como ${i.kind}`);
    kind = i.kind;
    docFacts = factsFromLoan(kind, parsed.data.loan);
    if (kind === 'schedule') docRows = parsed.data.loan.installments.map(normRow);
    if (kind !== 'schedule' && i.installments) throw unprocessable('VALIDATION_ERROR', 'Solo un cronograma aporta cuotas');
    if (kind === 'schedule' && i.facts?.length) throw unprocessable('VALIDATION_ERROR', 'Un cronograma no aporta datos del préstamo: usa el resumen o corrígelos aparte');
  } else {
    if (!i.facts?.length && !i.installments?.length) throw unprocessable('VALIDATION_ERROR', 'No hay nada que cambiar');
    kind = i.installments?.length ? 'schedule' : 'summary';
  }

  // Datos: lo que escribe el usuario manda sobre lo leído y queda marcado como suyo si difiere (RN-B03).
  const facts = new Map<LoanFactKey, FactIn & { origin: 'document' | 'user' }>();
  for (const f of docFacts) {
    const v = normalizeFact(f.key, f.value);
    if (v !== null) facts.set(f.key, { key: f.key, value: v, asOf: f.asOf, origin: 'document' });
  }
  for (const f of i.facts ?? []) {
    const v = normalizeFact(f.key, f.value);
    if (v === null) throw unprocessable('INVALID_FACT', `Valor inválido para ${f.key}`, { key: f.key });
    const prev = facts.get(f.key);
    facts.set(f.key, { key: f.key, value: v, asOf: f.asOf ?? prev?.asOf ?? null, origin: prev && prev.value === v ? 'document' : 'user' });
  }
  let installments: Plan['installments'] = null;
  if (docRows || i.installments) {
    const base = (i.installments ? i.installments.map(normRow) : docRows!);
    installments = base.map((r) => ({ ...r, origin: i.documentId && docRows?.some((d) => sameRow(d, r)) ? ('document' as const) : ('user' as const) }));
    if (!i.documentId) installments = installments.map((r) => ({ ...r, origin: 'user' as const }));
  }
  return { kind, documentId: i.documentId ?? null, facts: [...facts.values()], installments };
}

type Change = 'new' | 'changed' | 'same' | 'locked' | 'removed';

async function diffOf(ctx: Ctx, loanId: string, plan: Plan) {
  const cur = await currentFacts(ctx, loanId);
  const factDiff = plan.facts.map((f) => {
    const c = cur.find((x) => x.key === f.key);
    const change: Change = !c ? 'new' : c.value === f.value && (c.as_of ?? null) === (f.asOf ?? null) ? 'same' : 'changed';
    return { key: f.key, current: c?.value ?? null, incoming: f.value, asOf: f.asOf, origin: f.origin, change };
  });
  const live = await liveInstallments(ctx, loanId);
  let instDiff: Array<Record<string, unknown>> = [];
  if (plan.installments) {
    const incomingNos = new Set(plan.installments.map((r) => r.number));
    instDiff = plan.installments.map((r) => {
      const c = live.find((x) => x.no === r.number);
      let change: Change = 'new';
      if (c) {
        const same = sameRow(toIn(c), r);
        // Una cuota con pagos no se toca: la reprogramación no borra lo pagado (RN-B06).
        change = same ? 'same' : c.status === 'paid' || parseMoney(c.paid_amount) > 0n ? 'locked' : 'changed';
      }
      return { number: r.number, current: c ? instView(c, formatISO(ctx.today)) : null, incoming: { dueDate: r.dueDate, principal: r.principal, interest: r.interest, insurance: r.insurance, fees: r.fees, total: r.total }, origin: r.origin, change };
    });
    for (const c of live) if (!incomingNos.has(c.no)) instDiff.push({ number: c.no, current: instView(c, formatISO(ctx.today)), incoming: null, origin: c.origin, change: c.status === 'paid' || parseMoney(c.paid_amount) > 0n ? 'locked' : 'removed' });
    instDiff.sort((a, b) => (a.number as number) - (b.number as number));
  }
  // Coherencia del cronograma resultante: lo bloqueado se queda como está.
  let warnings: ReturnType<typeof checkSchedule> = [];
  if (plan.installments) {
    const result = new Map<number, LoanInstallmentIn>();
    for (const c of live) if (c.status === 'paid' || parseMoney(c.paid_amount) > 0n) result.set(c.no, toIn(c));
    for (const r of plan.installments) if (!result.has(r.number)) result.set(r.number, { number: r.number, dueDate: r.dueDate, principal: r.principal, interest: r.interest, insurance: r.insurance, fees: r.fees, total: r.total });
    const f = (k: LoanFactKey) => plan.facts.find((x) => x.key === k)?.value ?? cur.find((x) => x.key === k)?.value ?? null;
    warnings = checkSchedule([...result.values()], { principal: f('principal'), installmentsCount: Number(f('installments_count') ?? 0) || null });
    // Las filas del propio documento se revisan una a una, incluidas las repetidas.
    warnings = [...checkSchedule(plan.installments, { principal: f('principal'), installmentsCount: Number(f('installments_count') ?? 0) || null }).filter((w) => w.code === 'DUPLICATE_NUMBER' || w.code === 'ROW_SUM_MISMATCH'), ...warnings.filter((w) => w.code !== 'DUPLICATE_NUMBER' && w.code !== 'ROW_SUM_MISMATCH')];
  }
  return { facts: factDiff, installments: instDiff, warnings };
}

const stateOf = async (ctx: Ctx, loanId: string) => {
  const l = await loadLoan(ctx, loanId);
  const inst = await liveInstallments(ctx, loanId);
  return { version: l.version, facts: (await currentFacts(ctx, loanId)).map((f) => `${f.key}=${f.value}@${f.as_of}`), inst: inst.map((i) => `${i.id}:${i.status}:${i.paid_amount}`) };
};

export async function previewChange(ctx: Ctx, loanId: string, i: ChangeInput) {
  await loadLoan(ctx, loanId);
  const plan = await planOf(ctx, i);
  const diff = await diffOf(ctx, loanId, plan);
  const changes = diff.facts.filter((f) => f.change !== 'same').length + diff.installments.filter((r) => r.change !== 'same').length;
  const token = makePreviewToken(ctx.previewSecret, { scope: 'bankloan.change', ownerId: ctx.ownerId, inputs: { loanId, i }, state: await stateOf(ctx, loanId) }, ctx.nowMs);
  return { kind: plan.kind, documentId: plan.documentId, ...diff, hasChanges: changes > 0, requiresAcknowledge: diff.warnings.length > 0, previewToken: token };
}

export async function applyChange(ctx: Ctx, loanId: string, i: ChangeInput & { previewToken: string; acknowledgeWarnings?: boolean }) {
  await loadLoan(ctx, loanId, true);
  const { previewToken, acknowledgeWarnings, ...input } = i;
  checkPreviewToken(ctx.previewSecret, previewToken, { scope: 'bankloan.change', ownerId: ctx.ownerId, inputs: { loanId, i: input }, state: await stateOf(ctx, loanId) }, ctx.nowMs);
  const plan = await planOf(ctx, input);
  const diff = await diffOf(ctx, loanId, plan);
  if (diff.warnings.length > 0 && !acknowledgeWarnings) throw unprocessable('SCHEDULE_WARNINGS', 'El documento tiene datos incoherentes: revísalos o confirma que quieres guardarlo así', { warnings: diff.warnings });
  const at = new Date(ctx.nowMs).toISOString();

  for (const f of plan.facts) {
    const c = diff.facts.find((x) => x.key === f.key)!;
    if (c.change === 'same') continue;
    await sql`update bank_loan_fact set superseded_at = ${at} where owner_id = ${ctx.ownerId} and loan_id = ${loanId} and key = ${f.key} and superseded_at is null`.execute(ctx.trx);
    await sql`insert into bank_loan_fact (owner_id, loan_id, key, value, as_of, origin, document_id, confirmed_at) values (${ctx.ownerId}, ${loanId}, ${f.key}, ${f.value}, ${f.asOf}, ${f.origin}, ${plan.documentId}, ${at})`.execute(ctx.trx);
  }
  if (plan.installments) {
    for (const r of diff.installments) {
      const no = r.number as number;
      if (r.change === 'same' || r.change === 'locked') continue;
      const old = r.current as { id: string } | null;
      if (old) await sql`update bank_loan_installment set status = 'superseded' where owner_id = ${ctx.ownerId} and id = ${old.id}`.execute(ctx.trx);
      if (r.change === 'removed') continue;
      const inc = plan.installments.find((x) => x.number === no)!;
      await sql`
        insert into bank_loan_installment (owner_id, loan_id, no, due_date, principal, interest, insurance, fees, total, origin, document_id)
        values (${ctx.ownerId}, ${loanId}, ${no}, ${inc.dueDate}, ${inc.principal}, ${inc.interest}, ${inc.insurance}, ${inc.fees}, ${inc.total}, ${inc.origin}, ${plan.documentId})`.execute(ctx.trx);
    }
  }
  const summary = {
    facts: diff.facts.filter((f) => f.change !== 'same').map((f) => ({ key: f.key, change: f.change })),
    installments: diff.installments.filter((r) => r.change !== 'same').map((r) => ({ number: r.number, change: r.change })),
    warnings: diff.warnings.map((w) => w.code),
  };
  await sql`insert into bank_loan_document (owner_id, loan_id, kind, document_id, summary, confirmed_at) values (${ctx.ownerId}, ${loanId}, ${plan.kind}, ${plan.documentId}, ${JSON.stringify(summary)}::jsonb, clock_timestamp())`.execute(ctx.trx);
  await sql`update bank_loan set updated_at = ${at} where owner_id = ${ctx.ownerId} and id = ${loanId}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'bank_loan.change', entityType: 'bank_loan', entityId: loanId, changes: { kind: plan.kind, facts: summary.facts.length, installments: summary.installments.length } });
  return getBankLoan(ctx, loanId);
}

// ───────────────────────── Pagos reales ─────────────────────────

export interface PaymentInput {
  accountId: string; amount: string; paidOn?: string; installmentNumber?: number; note?: string; documentId?: string;
  principal?: string | null; interest?: string | null; insurance?: string | null; fees?: string | null;
  goalDeductions?: Deduction[]; acceptReserveShortfall?: boolean;
}

async function paymentPlan(ctx: Ctx, loanId: string, i: PaymentInput) {
  const loan = await loadLoan(ctx, loanId);
  if (loan.status !== 'active') throw unprocessable('LOAN_CLOSED', 'El préstamo está cerrado');
  await activeAccount(ctx, i.accountId);
  const amount = parseMoney(i.amount);
  if (amount <= 0n) throw unprocessable('VALIDATION_ERROR', 'El importe debe ser positivo');
  const paidOn = i.paidOn ?? formatISO(ctx.today);
  if (paidOn > formatISO(ctx.today)) throw unprocessable('FUTURE_DATE_NOT_ALLOWED', 'La fecha de pago no puede ser posterior a hoy');
  // El desglose es opcional; lo que se informe no puede superar el pago (RN-B04, RN-B08).
  const parts = [i.principal, i.interest, i.insurance, i.fees];
  const known = parts.reduce((a, p) => a + (p ? parseMoney(p) : 0n), 0n);
  if (known > amount) throw unprocessable('BREAKDOWN_EXCEEDS_PAYMENT', 'El desglose supera el importe pagado');
  let inst: InstRow | null = null;
  if (i.installmentNumber !== undefined) {
    inst = (await liveInstallments(ctx, loanId)).find((x) => x.no === i.installmentNumber) ?? null;
    if (!inst) throw notFound('Installment');
    if (inst.status === 'paid') throw unprocessable('INSTALLMENT_PAID', 'Esa cuota ya está pagada');
  }
  const before = inst ? parseMoney(inst.paid_amount) : 0n;
  const after = before + amount;
  const settled = inst ? after >= parseMoney(inst.total) : false;
  return { loan, amount, paidOn, inst, before, after, settled, known };
}

export async function previewPayment(ctx: Ctx, loanId: string, i: PaymentInput) {
  const p = await paymentPlan(ctx, loanId, i);
  const bal = await one<{ b: string }>(ctx.trx, sql<{ b: string }>`select coalesce(sum(amount),0) as b from account_entry where owner_id = ${ctx.ownerId} and account_id = ${i.accountId}`);
  const b = parseMoney(bal!.b, { allowNegative: true });
  const { goalDeductions: _g, acceptReserveShortfall: _a, ...norm } = i;
  void _g; void _a;
  const token = makePreviewToken(ctx.previewSecret, { scope: 'bankloan.payment', ownerId: ctx.ownerId, inputs: { loanId, i: norm }, state: { v: p.loan.version, inst: p.inst ? `${p.inst.id}:${p.inst.paid_amount}:${p.inst.status}` : null } }, ctx.nowMs);
  return {
    amount: m(p.amount), paidOn: p.paidOn, account: { id: i.accountId, before: m(b), after: m(b - p.amount) },
    installment: p.inst ? { number: p.inst.no, dueDate: p.inst.due_date, total: m(p.inst.total), paidBefore: m(p.before), paidAfter: m(p.after), settles: p.settled, late: p.settled && p.paidOn > p.inst.due_date } : null,
    unallocated: m(p.amount - p.known), note: 'El pago no genera mora ni recalcula el cronograma: un cambio de calendario solo entra con un documento nuevo que confirmes.',
    previewToken: token,
  };
}

export async function createPayment(ctx: Ctx, loanId: string, i: PaymentInput & { previewToken: string }) {
  const { previewToken, goalDeductions, acceptReserveShortfall, ...norm } = i;
  const p = await paymentPlan(ctx, loanId, i);
  checkPreviewToken(ctx.previewSecret, previewToken, { scope: 'bankloan.payment', ownerId: ctx.ownerId, inputs: { loanId, i: norm }, state: { v: p.loan.version, inst: p.inst ? `${p.inst.id}:${p.inst.paid_amount}:${p.inst.status}` : null } }, ctx.nowMs);
  const op = await createOperation(ctx, {
    kind: 'expense', accountId: i.accountId, amount: m(p.amount), date: p.paidOn, concept: 'loan_payment',
    description: p.inst ? `Cuota ${p.inst.no} · ${p.loan.name}` : `Pago · ${p.loan.name}`,
    ...(goalDeductions ? { goalDeductions } : {}), ...(acceptReserveShortfall ? { acceptReserveShortfall: true } : {}),
  });
  const pay = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into bank_loan_payment (owner_id, loan_id, installment_id, operation_id, amount, paid_on, principal, interest, insurance, fees, note)
    values (${ctx.ownerId}, ${loanId}, ${p.inst?.id ?? null}, ${op.id}, ${m(p.amount)}, ${p.paidOn}, ${i.principal ?? null}, ${i.interest ?? null}, ${i.insurance ?? null}, ${i.fees ?? null}, ${i.note?.trim() || null}) returning id`);
  if (p.inst) {
    await sql`update bank_loan_installment set paid_amount = ${m(p.after)}, paid_on = ${p.paidOn}, status = ${p.settled ? 'paid' : 'scheduled'} where owner_id = ${ctx.ownerId} and id = ${p.inst.id}`.execute(ctx.trx);
  }
  if (i.documentId) {
    const d = await one(ctx.trx, sql`select 1 as ok from source_document where owner_id = ${ctx.ownerId} and id = ${i.documentId}`);
    if (!d) throw notFound('Document');
    await sql`insert into evidence_link (owner_id, document_id, operation_id) values (${ctx.ownerId}, ${i.documentId}, ${op.id}) on conflict do nothing`.execute(ctx.trx);
  }
  await sql`update bank_loan set updated_at = ${new Date(ctx.nowMs).toISOString()} where owner_id = ${ctx.ownerId} and id = ${loanId}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'bank_loan.pay', entityType: 'bank_loan_payment', entityId: pay!.id, changes: { amount: m(p.amount) } });
  return { paymentId: pay!.id, operation: op, loan: await getBankLoan(ctx, loanId) };
}

export async function reversePayment(ctx: Ctx, paymentId: string, reason: string) {
  const p = await one<{ id: string; loan_id: string; installment_id: string | null; operation_id: string; amount: string; status: string }>(ctx.trx, sql`
    select id, loan_id, installment_id, operation_id, amount, status from bank_loan_payment where owner_id = ${ctx.ownerId} and id = ${paymentId} for update`);
  if (!p) throw notFound('BankLoanPayment');
  if (p.status !== 'active') throw unprocessable('ALREADY_REVERSED', 'El pago ya fue revertido');
  await reverseOperationCore(ctx, p.operation_id, reason, undefined, { allowLinked: true });
  await sql`update bank_loan_payment set status = 'reversed' where owner_id = ${ctx.ownerId} and id = ${paymentId}`.execute(ctx.trx);
  if (p.installment_id) {
    const i = await one<{ paid_amount: string; total: string }>(ctx.trx, sql`select paid_amount, total from bank_loan_installment where owner_id = ${ctx.ownerId} and id = ${p.installment_id} for update`);
    const left = parseMoney(i!.paid_amount) - parseMoney(p.amount);
    const after = left > 0n ? left : 0n;
    const lastPay = await one<{ paid_on: string }>(ctx.trx, sql`select max(paid_on)::text as paid_on from bank_loan_payment where owner_id = ${ctx.ownerId} and installment_id = ${p.installment_id} and status = 'active' and id <> ${paymentId}`);
    await sql`update bank_loan_installment set paid_amount = ${m(after)}, status = ${after >= parseMoney(i!.total) ? 'paid' : 'scheduled'}, paid_on = ${after === 0n ? null : lastPay?.paid_on ?? null} where owner_id = ${ctx.ownerId} and id = ${p.installment_id}`.execute(ctx.trx);
  }
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'bank_loan.reverse_payment', entityType: 'bank_loan_payment', entityId: paymentId, reason });
  return getBankLoan(ctx, p.loan_id);
}

