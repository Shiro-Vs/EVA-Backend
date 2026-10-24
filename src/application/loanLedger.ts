import { sql } from 'kysely';
import {
  accruedInPeriod, buildSchedule, interestForPeriod, lateFee, periodEnds, proposeAllocation, type ChargeDraft, type InterestBase, type InterestMode, type Pending, type Terms,
} from '../domain/loanSchedule.js';
import { formatISO, parseISO, type LocalDate } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { checkPreviewToken, makePreviewToken } from '../infra/preview.js';
import { ts, type Ctx } from './context.js';
import { activeAccount, insertOperation, resolveDate, reverseOperationCore } from './operations.js';

const m = (v: bigint | string) => (typeof v === 'bigint' ? formatMoney(v) : formatMoney(parseMoney(v)));
const pctToBp = (text: string) => { const [w, f = ''] = text.split('.'); return Number(w) * 100 + Number((f + '00').slice(0, 2)); };
const bpToPct = (bp: number) => `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, '0')}`;

export interface LedgerInput {
  direction: 'lent' | 'borrowed';
  contactId?: string | null;
  counterpartyName?: string | null;
  principal: string;
  openedOn?: string;
  /** Cuenta por la que se movió el dinero. Si se omite, no se registra el movimiento (el dinero no pasó por tus cuentas). */
  accountId?: string | null;
  interest: { mode: InterestMode; amount?: string | null; ratePercent?: string | null; base?: InterestBase };
  repayment: { kind: 'installments' | 'final_date' | 'open'; installments?: number; firstDueDate?: string; finalDate?: string };
  paymentOrder?: 'capital_first' | 'interest_first';
  earlyPayoff?: 'keep' | 'accrued';
  note?: string | null;
}

// ───────────────────────── Creación ─────────────────────────

function termsOf(ctx: Ctx, i: LedgerInput): Terms {
  const principal = parseMoney(i.principal);
  if (principal <= 0n) throw unprocessable('VALIDATION_ERROR', 'El capital debe ser positivo');
  const opened = i.openedOn ? parseISO(i.openedOn) : ctx.today;
  if (opened > ctx.today) throw unprocessable('FUTURE_DATE_NOT_ALLOWED', 'La fecha no puede ser posterior a hoy');
  const mode = i.interest.mode;
  const fixedAmount = mode === 'fixed' ? parseMoney(i.interest.amount ?? '0') : null;
  const rateBp = mode === 'percent' ? pctToBp(i.interest.ratePercent ?? '0') : null;
  if (mode === 'fixed' && (fixedAmount ?? 0n) <= 0n) throw unprocessable('INTEREST_REQUIRED', 'Indica el importe fijo de interés por período');
  if (mode === 'percent' && (rateBp ?? 0) <= 0) throw unprocessable('INTEREST_REQUIRED', 'Indica el porcentaje de interés por período');
  const r = i.repayment;
  let firstDue: LocalDate | null = null; let finalDate: LocalDate | null = null;
  if (r.kind === 'installments') {
    if (!r.installments || !r.firstDueDate) throw unprocessable('REPAYMENT_REQUIRED', 'Indica la cantidad de cuotas y la fecha de la primera');
    firstDue = parseISO(r.firstDueDate);
    if (firstDue <= opened) throw unprocessable('REPAYMENT_DATES', 'La primera cuota debe vencer después del inicio del préstamo');
  } else if (r.kind === 'final_date') {
    if (!r.finalDate) throw unprocessable('REPAYMENT_REQUIRED', 'Indica la fecha final');
    finalDate = parseISO(r.finalDate);
    if (finalDate <= opened) throw unprocessable('REPAYMENT_DATES', 'La fecha final debe ser posterior al inicio del préstamo');
  }
  return { principal, mode, fixedAmount, rateBp, base: i.interest.base ?? 'original', kind: r.kind, installments: r.kind === 'installments' ? r.installments! : null, firstDue, finalDate, opened };
}

async function checkParties(ctx: Ctx, i: LedgerInput) {
  if (i.direction === 'lent') {
    if (!i.contactId) throw unprocessable('VALIDATION_ERROR', 'Un préstamo otorgado necesita el contacto que lo recibe');
  } else if (!i.contactId && !i.counterpartyName?.trim()) {
    throw unprocessable('VALIDATION_ERROR', 'Indica de quién lo recibiste: un contacto o el nombre de la entidad');
  }
  if (i.contactId) {
    const c = await one<{ name: string; status: string }>(ctx.trx, sql<{ name: string; status: string }>`select name, status from contact where owner_id = ${ctx.ownerId} and id = ${i.contactId}`);
    if (!c) throw notFound('Contact');
    if (c.status !== 'active') throw unprocessable('CONTACT_ARCHIVED', 'El contacto está archivado');
    return c.name;
  }
  return i.counterpartyName!.trim();
}

const draftJson = (d: ChargeDraft) => ({ concept: d.concept, installmentNo: d.installmentNo, periodNo: d.periodNo, dueDate: d.due === null ? null : formatISO(d.due), amount: m(d.amount) });
const inputsOf = (i: LedgerInput) => ({
  ...i, principal: m(i.principal), contactId: i.contactId ?? null, counterpartyName: i.counterpartyName?.trim() ?? null, accountId: i.accountId ?? null, openedOn: i.openedOn ?? null,
  paymentOrder: i.paymentOrder ?? 'capital_first', earlyPayoff: i.earlyPayoff ?? 'keep', note: undefined,
});

export async function previewLoan(ctx: Ctx, i: LedgerInput) {
  const party = await checkParties(ctx, i);
  const t = termsOf(ctx, i);
  if (i.accountId) await activeAccount(ctx, i.accountId);
  const drafts = buildSchedule(t);
  const sum = (c: ChargeDraft['concept']) => drafts.filter((d) => d.concept === c).reduce((a, d) => a + d.amount, 0n);
  return {
    direction: i.direction, party, principal: m(t.principal), openedOn: formatISO(t.opened),
    interest: { mode: t.mode, amount: t.fixedAmount === null ? null : m(t.fixedAmount), ratePercent: t.rateBp === null ? null : bpToPct(t.rateBp), base: t.base, perPeriod: t.kind === 'open' ? m(interestForPeriod(t, t.principal)) : undefined },
    repayment: i.repayment, schedule: drafts.map(draftJson),
    totals: { principal: m(sum('principal')), interest: m(sum('interest')), toPay: m(sum('principal') + sum('interest')) },
    disbursement: i.accountId ? { accountId: i.accountId, kind: i.direction === 'lent' ? 'out' : 'in', amount: m(t.principal) } : null,
    note: i.repayment.kind === 'open' ? 'Sin fecha de devolución: el interés se devenga mes a mes y aparece al consultar.' : undefined,
    previewToken: makePreviewToken(ctx.previewSecret, { scope: 'loan.create', ownerId: ctx.ownerId, inputs: inputsOf(i), state: null }, ctx.nowMs),
  };
}

export async function createLoan(ctx: Ctx, i: LedgerInput & { previewToken: string }) {
  const { previewToken, ...input } = i;
  const party = await checkParties(ctx, input);
  const t = termsOf(ctx, input);
  checkPreviewToken(ctx.previewSecret, previewToken, { scope: 'loan.create', ownerId: ctx.ownerId, inputs: inputsOf(input), state: null }, ctx.nowMs);
  if (input.accountId) await activeAccount(ctx, input.accountId);
  const drafts = buildSchedule(t);

  const loan = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into loan (owner_id, contact_id, direction, principal, opened_on, origin, engine, interest_mode, interest_amount, interest_rate_bp, interest_base,
                      repayment_kind, installments, first_due_date, final_date, payment_order, early_payoff, account_id, counterparty_name, note)
    values (${ctx.ownerId}, ${input.contactId ?? null}, ${input.direction}, ${m(t.principal)}, ${formatISO(t.opened)}, 'manual', 'ledger', ${t.mode},
            ${t.fixedAmount === null ? null : m(t.fixedAmount)}, ${t.rateBp}, ${t.base}, ${t.kind}, ${t.installments}, ${t.firstDue === null ? null : formatISO(t.firstDue)},
            ${t.finalDate === null ? null : formatISO(t.finalDate)}, ${input.paymentOrder ?? 'capital_first'}, ${input.earlyPayoff ?? 'keep'}, ${input.accountId ?? null},
            ${input.contactId ? null : input.counterpartyName!.trim()}, ${input.note?.trim() || null}) returning id`);
  if (input.accountId) {
    // El capital que entra o sale NO es ingreso ganado ni gasto de consumo (RN-MV05): se marca como desembolso.
    const op = await insertOperation(ctx, {
      kind: input.direction === 'lent' ? 'expense' : 'income', date: t.opened, description: input.direction === 'lent' ? `Préstamo a ${party}` : `Préstamo de ${party}`,
      contactId: input.contactId ?? null, concept: 'loan_disbursement',
    }, [{ accountId: input.accountId, amount: input.direction === 'lent' ? -t.principal : t.principal }]);
    await sql`update loan set disbursement_operation_id = ${op} where owner_id = ${ctx.ownerId} and id = ${loan!.id}`.execute(ctx.trx);
  }
  for (const d of drafts) await insertCharge(ctx, loan!.id, d);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'loan.create', entityType: 'loan', entityId: loan!.id, changes: { direction: input.direction, principal: m(t.principal), charges: drafts.length } });
  return getLedgerLoan(ctx, loan!.id);
}

async function insertCharge(ctx: Ctx, loanId: string, d: { concept: 'principal' | 'interest' | 'late_fee'; due: LocalDate | null; amount: bigint; installmentNo?: number | null; periodNo?: number | null; sourceChargeId?: string | null; note?: string | null }) {
  const r = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into loan_charge (owner_id, loan_id, concept, installment_no, period_no, due_date, amount, source_charge_id, note)
    values (${ctx.ownerId}, ${loanId}, ${d.concept}, ${d.installmentNo ?? null}, ${d.periodNo ?? null}, ${d.due === null ? null : formatISO(d.due)}, ${m(d.amount)}, ${d.sourceChargeId ?? null}, ${d.note ?? null}) returning id`);
  return r!.id;
}

// ───────────────────────── Lectura ─────────────────────────

interface LoanRow {
  id: string; contact_id: string | null; contact_name: string | null; counterparty_name: string | null; direction: 'lent' | 'borrowed'; principal: string; opened_on: string; status: string;
  interest_mode: InterestMode; interest_amount: string | null; interest_rate_bp: number | null; interest_base: InterestBase | null; repayment_kind: 'installments' | 'final_date' | 'open';
  installments: number | null; first_due_date: string | null; final_date: string | null; payment_order: 'capital_first' | 'interest_first'; early_payoff: 'keep' | 'accrued';
  account_id: string | null; note: string | null; created_at: unknown; engine: string; closed_reason: string | null;
}
interface ChargeRow { id: string; concept: 'principal' | 'interest' | 'late_fee'; installment_no: number | null; period_no: number | null; due_date: string | null; amount: string; status: string; source_charge_id: string | null; note: string | null; paid: string }

const loanSel = sql`
  select l.id, l.contact_id, c.name as contact_name, l.counterparty_name, l.direction, l.principal, l.opened_on, l.status, l.interest_mode, l.interest_amount, l.interest_rate_bp, l.interest_base,
         l.repayment_kind, l.installments, l.first_due_date, l.final_date, l.payment_order, l.early_payoff, l.account_id, l.note, l.created_at, l.engine, l.closed_reason
  from loan l left join contact c on c.id = l.contact_id and c.owner_id = l.owner_id`;

async function loadLoan(ctx: Ctx, id: string, forUpdate = false): Promise<LoanRow> {
  if (forUpdate) await sql`select 1 from loan where owner_id = ${ctx.ownerId} and id = ${id} for update`.execute(ctx.trx);
  const l = await one<LoanRow>(ctx.trx, sql<LoanRow>`${loanSel} where l.owner_id = ${ctx.ownerId} and l.id = ${id}`);
  if (!l) throw notFound('Loan');
  return l;
}

const termsFromRow = (l: LoanRow): Terms => ({
  principal: parseMoney(l.principal), mode: l.interest_mode, fixedAmount: l.interest_amount === null ? null : parseMoney(l.interest_amount), rateBp: l.interest_rate_bp,
  base: l.interest_base ?? 'original', kind: l.repayment_kind, installments: l.installments, firstDue: l.first_due_date ? parseISO(l.first_due_date) : null,
  finalDate: l.final_date ? parseISO(l.final_date) : null, opened: parseISO(l.opened_on),
});

const chargesOf = (ctx: Ctx, loanId: string) => rows<ChargeRow>(ctx.trx, sql<ChargeRow>`
  select c.id, c.concept, c.installment_no, c.period_no, c.due_date, c.amount, c.status, c.source_charge_id, c.note,
         coalesce((select sum(a.amount) from loan_allocation a join loan_payment p on p.id = a.payment_id where a.charge_id = c.id and p.status = 'active'), 0.00) as paid
  from loan_charge c where c.owner_id = ${ctx.ownerId} and c.loan_id = ${loanId} order by c.due_date nulls last, c.installment_no nulls last, case c.concept when 'principal' then 0 when 'interest' then 1 else 2 end, c.period_no nulls last, c.created_at, c.id`);

/** Principal en el que se basa el interés de un período de un préstamo sin fecha (capital + capitalizado − abonos a capital hasta el inicio del período). */
async function principalOutstandingAt(ctx: Ctx, l: LoanRow, asOf: LocalDate) {
  const r = await one<{ total: string; paid: string }>(ctx.trx, sql<{ total: string; paid: string }>`
    select coalesce(sum(c.amount), 0.00) as total,
           coalesce((select sum(a.amount) from loan_allocation a join loan_payment p on p.id = a.payment_id join loan_charge cc on cc.id = a.charge_id
                      where cc.loan_id = ${l.id} and cc.concept = 'principal' and p.status = 'active' and p.paid_on <= ${formatISO(asOf)}::date), 0.00) as paid
    from loan_charge c where c.owner_id = ${ctx.ownerId} and c.loan_id = ${l.id} and c.concept = 'principal' and c.status = 'active'`);
  return parseMoney(r!.total) - parseMoney(r!.paid);
}

/** Interés mensual de un préstamo sin fecha final: se crea al cumplirse cada período, de forma idempotente. */
async function accrueOpen(ctx: Ctx, l: LoanRow) {
  if (l.engine !== 'ledger' || l.repayment_kind !== 'open' || l.interest_mode === 'none' || l.status !== 'open') return;
  const t = termsFromRow(l);
  const done = new Set((await rows<{ period_no: number }>(ctx.trx, sql<{ period_no: number }>`select period_no from loan_charge where loan_id = ${l.id} and concept = 'interest' and status <> 'void'`)).map((x) => x.period_no));
  const ends = periodEnds(t.opened, 1200);
  for (let j = 1; j <= ends.length && ends[j - 1]! <= ctx.today; j++) {
    if (done.has(j)) continue;
    const start = j === 1 ? t.opened : ends[j - 2]!;
    const base = t.base === 'original' ? t.principal : await principalOutstandingAt(ctx, l, start);
    const interest = interestForPeriod(t, base);
    if (interest > 0n) await insertCharge(ctx, l.id, { concept: 'interest', due: ends[j - 1]!, amount: interest, periodNo: j });
  }
}

const chargeView = (c: ChargeRow, today: string) => {
  const paid = parseMoney(c.paid);
  const pending = c.status === 'active' ? parseMoney(c.amount) - paid : 0n;
  return {
    id: c.id, concept: c.concept, installmentNo: c.installment_no, periodNo: c.period_no, dueDate: c.due_date, amount: m(c.amount), paid: m(paid), pending: m(pending),
    status: c.status, sourceChargeId: c.source_charge_id, note: c.note, overdue: c.status === 'active' && pending > 0n && c.due_date !== null && c.due_date < today,
  };
};

export async function getLedgerLoan(ctx: Ctx, id: string) {
  let l = await loadLoan(ctx, id, true);
  await accrueOpen(ctx, l);
  l = await loadLoan(ctx, id);
  const today = formatISO(ctx.today);
  const cs = await chargesOf(ctx, id);
  const view = cs.map((c) => chargeView(c, today));
  const sum = (concept: string, f: (v: (typeof view)[number]) => string) => view.filter((v) => v.concept === concept && v.status !== 'void').reduce((a, v) => a + parseMoney(f(v)), 0n);
  const payments = await rows<{ id: string; operation_id: string; paid_on: string; amount: string; unapplied: string; kind: string; status: string; reason: string | null }>(ctx.trx, sql`
    select id, operation_id, paid_on, amount, unapplied, kind, status, reason from loan_payment where owner_id = ${ctx.ownerId} and loan_id = ${id} order by paid_on desc, created_at desc`);
  const credit = payments.filter((p) => p.status === 'active').reduce((a, p) => a + parseMoney(p.unapplied), 0n);
  const pendingCharges = view.filter((v) => v.status === 'active' && parseMoney(v.pending) > 0n && v.dueDate !== null).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
  const pendingTotal = view.filter((v) => v.status === 'active').reduce((a, v) => a + parseMoney(v.pending), 0n);
  return {
    id: l.id, engine: 'ledger' as const, direction: l.direction, contactId: l.contact_id, contactName: l.contact_name ?? l.counterparty_name, counterpartyName: l.counterparty_name,
    principal: m(l.principal), openedOn: l.opened_on, origin: 'manual', status: l.status === 'open' && pendingTotal === 0n && cs.length > 0 ? 'closed' : l.status, pending: m(pendingTotal),
    terms: {
      interestMode: l.interest_mode, interestAmount: l.interest_amount === null ? null : m(l.interest_amount), interestRatePercent: l.interest_rate_bp === null ? null : bpToPct(l.interest_rate_bp),
      interestBase: l.interest_base, repaymentKind: l.repayment_kind, installments: l.installments, firstDueDate: l.first_due_date, finalDate: l.final_date, paymentOrder: l.payment_order, earlyPayoff: l.early_payoff,
    },
    note: l.note, conversion: null, createdAt: ts(l.created_at), closedReason: l.closed_reason,
    totals: {
      principalPending: m(sum('principal', (v) => v.pending)), interestPending: m(sum('interest', (v) => v.pending)), feesPending: m(sum('late_fee', (v) => v.pending)),
      principalPaid: m(sum('principal', (v) => v.paid)), interestPaid: m(sum('interest', (v) => v.paid)), feesPaid: m(sum('late_fee', (v) => v.paid)), // costo financiero = interés + mora pagados
      financialCost: m(sum('interest', (v) => v.paid) + sum('late_fee', (v) => v.paid)),
    },
    nextDue: pendingCharges[0] ? { dueDate: pendingCharges[0].dueDate, amount: m(pendingCharges.filter((c) => c.dueDate === pendingCharges[0]!.dueDate).reduce((a, c) => a + parseMoney(c.pending), 0n)) } : null,
    credit: m(credit), charges: view,
    components: [],
    payments: payments.map((p) => ({ id: p.id, operationId: p.operation_id, paidOn: p.paid_on, amount: m(p.amount), unapplied: m(p.unapplied), kind: p.kind, status: p.status, reason: p.reason })),
  };
}

// ───────────────────────── Pagos ─────────────────────────

export interface PaymentInput {
  amount: string; accountId: string; paidOn?: string;
  allocations?: Array<{ chargeId: string; amount: string }>;
  /** Qué hacer si sobra dinero tras aplicar: conservarlo como saldo a favor (RN-L11). Por defecto se rechaza. */
  onRemainder?: 'keep';
}

interface PayPlan {
  loan: LoanRow; amount: bigint; paidOn: LocalDate; allocations: Array<{ chargeId: string; amount: bigint; pending: bigint }>; remainder: bigint; proposed: boolean;
  issues: Array<{ code: string; chargeId?: string }>; pendings: Array<[string, string]>;
}

async function pendingItems(ctx: Ctx, loanId: string) {
  const cs = await chargesOf(ctx, loanId);
  return cs.filter((c) => c.status === 'active').map((c) => ({ row: c, pending: parseMoney(c.amount) - parseMoney(c.paid) })).filter((x) => x.pending > 0n);
}

async function buildPayPlan(ctx: Ctx, loanId: string, i: PaymentInput): Promise<PayPlan> {
  let loan = await loadLoan(ctx, loanId, true);
  if (loan.engine !== 'ledger') throw unprocessable('LOAN_NOT_LEDGER', 'Este préstamo viene de una deuda de servicios: se cobra con un cobro normal');
  if (loan.status !== 'open') throw unprocessable('LOAN_NOT_OPEN', 'El préstamo no está abierto');
  await accrueOpen(ctx, loan);
  loan = await loadLoan(ctx, loanId);
  const amount = parseMoney(i.amount);
  if (amount <= 0n) throw unprocessable('VALIDATION_ERROR', 'El importe debe ser positivo');
  const paidOn = resolveDate(ctx, i.paidOn);
  await activeAccount(ctx, i.accountId);
  const items = await pendingItems(ctx, loanId);
  const byId = new Map(items.map((x) => [x.row.id, x]));
  const issues: PayPlan['issues'] = [];
  let allocations: PayPlan['allocations'];
  let remainder: bigint;
  let proposed = false;
  if (i.allocations && i.allocations.length > 0) {
    const seen = new Set<string>();
    allocations = i.allocations.map((a) => {
      const it = byId.get(a.chargeId);
      const amt = parseMoney(a.amount);
      if (!it) issues.push({ code: 'CHARGE_NOT_PAYABLE', chargeId: a.chargeId });
      else if (amt > it.pending) issues.push({ code: 'EXCEEDS_CHARGE', chargeId: a.chargeId });
      if (seen.has(a.chargeId)) issues.push({ code: 'DUPLICATE_CHARGE', chargeId: a.chargeId });
      seen.add(a.chargeId);
      return { chargeId: a.chargeId, amount: amt, pending: it?.pending ?? 0n };
    });
    const applied = allocations.reduce((a, x) => a + x.amount, 0n);
    if (applied > amount) issues.push({ code: 'EXCEEDS_PAYMENT' });
    remainder = amount - applied;
  } else {
    proposed = true;
    const pend: Pending[] = items.map((x) => ({ id: x.row.id, concept: x.row.concept, installmentNo: x.row.installment_no, due: x.row.due_date ? parseISO(x.row.due_date) : null, pending: x.pending }));
    const p = proposeAllocation(pend, amount, loan.payment_order);
    allocations = p.allocations.map((a) => ({ chargeId: a.id, amount: a.amount, pending: byId.get(a.id)!.pending }));
    remainder = p.remainder;
  }
  if (remainder > 0n && i.onRemainder !== 'keep') issues.push({ code: 'REMAINDER' });
  return { loan, amount, paidOn, allocations, remainder, proposed, issues, pendings: items.map((x) => [x.row.id, m(x.pending)] as [string, string]) };
}

const payInputs = (loanId: string, i: PaymentInput) => ({
  loanId, amount: m(i.amount), accountId: i.accountId, paidOn: i.paidOn ?? null,
  allocations: i.allocations ? i.allocations.map((a) => [a.chargeId, m(a.amount)]).sort() : null, onRemainder: i.onRemainder ?? null,
});

export async function previewPayment(ctx: Ctx, loanId: string, i: PaymentInput) {
  const p = await buildPayPlan(ctx, loanId, i);
  const cs = new Map((await chargesOf(ctx, loanId)).map((c) => [c.id, c]));
  const bal = await one<{ b: string }>(ctx.trx, sql<{ b: string }>`select coalesce(sum(amount), 0.00) as b from account_entry where owner_id = ${ctx.ownerId} and account_id = ${i.accountId}`);
  const delta = p.loan.direction === 'lent' ? p.amount : -p.amount;
  const valid = p.issues.length === 0;
  return {
    valid, issues: p.issues, proposedByServer: p.proposed,
    summary: { amount: m(p.amount), applied: m(p.amount - p.remainder), remainder: m(p.remainder), direction: p.loan.direction === 'lent' ? 'in' : 'out', accountBalanceAfter: m(parseMoney(bal!.b, { allowNegative: true }) + delta) },
    allocations: p.allocations.map((a) => ({ chargeId: a.chargeId, concept: cs.get(a.chargeId)?.concept, installmentNo: cs.get(a.chargeId)?.installment_no ?? null, dueDate: cs.get(a.chargeId)?.due_date ?? null, amount: m(a.amount), pendingBefore: m(a.pending), pendingAfter: m(a.pending - a.amount) })),
    ...(valid ? { previewToken: makePreviewToken(ctx.previewSecret, { scope: 'loan.payment', ownerId: ctx.ownerId, inputs: payInputs(loanId, i), state: { pendings: p.pendings, alloc: p.allocations.map((a) => [a.chargeId, m(a.amount)]) } }, ctx.nowMs) } : {}),
  };
}

async function writePayment(ctx: Ctx, p: PayPlan, accountId: string, kind: 'regular' | 'payoff', note: string) {
  const l = p.loan;
  // Un pago es UN movimiento real (RN-MV07); el capital que se devuelve no es gasto de consumo (RN-MV05).
  const op = await insertOperation(ctx, {
    kind: l.direction === 'lent' ? 'income' : 'expense', date: p.paidOn, description: note, contactId: l.contact_id, concept: 'loan_payment',
  }, [{ accountId, amount: l.direction === 'lent' ? p.amount : -p.amount }]);
  const pay = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into loan_payment (owner_id, loan_id, operation_id, paid_on, amount, unapplied, kind) values (${ctx.ownerId}, ${l.id}, ${op}, ${formatISO(p.paidOn)}, ${m(p.amount)}, ${m(p.remainder)}, ${kind}) returning id`);
  for (const a of p.allocations) {
    if (a.amount > 0n) await sql`insert into loan_allocation (owner_id, payment_id, charge_id, amount) values (${ctx.ownerId}, ${pay!.id}, ${a.chargeId}, ${m(a.amount)})`.execute(ctx.trx);
  }
  return { paymentId: pay!.id, operationId: op };
}

export async function createPayment(ctx: Ctx, loanId: string, body: PaymentInput & { previewToken: string }) {
  const { previewToken, ...i } = body;
  const p = await buildPayPlan(ctx, loanId, i);
  if (p.issues.length > 0) throw unprocessable(p.issues[0]!.code === 'REMAINDER' ? 'PAYMENT_REMAINDER' : 'OVER_ALLOCATION', 'The allocation is not valid', p.issues);
  checkPreviewToken(ctx.previewSecret, previewToken, { scope: 'loan.payment', ownerId: ctx.ownerId, inputs: payInputs(loanId, i), state: { pendings: p.pendings, alloc: p.allocations.map((a) => [a.chargeId, m(a.amount)]) } }, ctx.nowMs);
  const w = await writePayment(ctx, p, i.accountId, 'regular', p.loan.direction === 'lent' ? 'Pago de préstamo recibido' : 'Pago de préstamo');
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'loan.payment', entityType: 'loan', entityId: loanId, changes: { amount: m(p.amount), paymentId: w.paymentId, remainder: m(p.remainder) } });
  return { paymentId: w.paymentId, operationId: w.operationId, loan: await getLedgerLoan(ctx, loanId) };
}

export async function reversePayment(ctx: Ctx, paymentId: string, reason: string) {
  const p = await one<{ id: string; loan_id: string; operation_id: string; status: string }>(ctx.trx, sql<{ id: string; loan_id: string; operation_id: string; status: string }>`
    select id, loan_id, operation_id, status from loan_payment where owner_id = ${ctx.ownerId} and id = ${paymentId} for update`);
  if (!p) throw notFound('Payment');
  if (p.status !== 'active') throw unprocessable('ALREADY_REVERSED', 'El pago ya está revertido');
  await sql`select 1 from loan where owner_id = ${ctx.ownerId} and id = ${p.loan_id} for update`.execute(ctx.trx);
  const reversalId = await reverseOperationCore(ctx, p.operation_id, reason.trim(), undefined, { allowLinked: true });
  await sql`update loan_payment set status = 'reversed', reason = ${reason.trim()} where owner_id = ${ctx.ownerId} and id = ${paymentId}`.execute(ctx.trx);
  await sql`update loan set status = 'open', closed_reason = null where owner_id = ${ctx.ownerId} and id = ${p.loan_id} and status = 'closed'`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'loan.payment_reverse', entityType: 'loan', entityId: p.loan_id, reason: reason.trim(), changes: { paymentId, reversalId } });
  return getLedgerLoan(ctx, p.loan_id);
}

// ───────────────────────── Pago anticipado (RN-L08) ─────────────────────────

interface PayoffLine { chargeId: string; concept: string; dueDate: string | null; pending: bigint; settle: bigint; action: 'full' | 'prorated' | 'void' }

async function buildPayoff(ctx: Ctx, loanId: string) {
  let loan = await loadLoan(ctx, loanId, true);
  if (loan.engine !== 'ledger') throw unprocessable('LOAN_NOT_LEDGER', 'Este préstamo viene de una deuda de servicios: se cobra con un cobro normal');
  if (loan.status !== 'open') throw unprocessable('LOAN_NOT_OPEN', 'El préstamo no está abierto');
  await accrueOpen(ctx, loan);
  loan = await loadLoan(ctx, loanId);
  const t = termsFromRow(loan);
  const items = await pendingItems(ctx, loanId);
  const ends = periodEnds(t.opened, 1200);
  const lines: PayoffLine[] = [];
  const extra: Array<{ amount: bigint; periodNo: number }> = []; // devengo parcial de un préstamo sin fecha
  for (const it of items) {
    const c = it.row;
    if (c.concept !== 'interest' || loan.early_payoff === 'keep') { lines.push({ chargeId: c.id, concept: c.concept, dueDate: c.due_date, pending: it.pending, settle: it.pending, action: 'full' }); continue; }
    // «Solo el devengado»: el interés de períodos ya cumplidos se debe completo; el del período en curso se prorrateó por días (base 30); los futuros se anulan.
    const j = c.period_no!;
    const start = j === 1 ? t.opened : ends[j - 2]!;
    const end = ends[j - 1]!;
    if (end <= ctx.today) { lines.push({ chargeId: c.id, concept: c.concept, dueDate: c.due_date, pending: it.pending, settle: it.pending, action: 'full' }); continue; }
    if (start >= ctx.today) { lines.push({ chargeId: c.id, concept: c.concept, dueDate: c.due_date, pending: it.pending, settle: 0n, action: 'void' }); continue; }
    const base = t.base === 'original' ? t.principal : await principalOutstandingAt(ctx, loan, start);
    const accrued = accruedInPeriod(t, base, ctx.today - start);
    const paid = parseMoney(c.paid);
    const settle = accrued > paid ? accrued - paid : 0n;
    lines.push({ chargeId: c.id, concept: c.concept, dueDate: c.due_date, pending: it.pending, settle: settle > it.pending ? it.pending : settle, action: 'prorated' });
  }
  if (loan.early_payoff === 'accrued' && t.kind === 'open' && t.mode !== 'none') {
    const doneNos = (await chargesOf(ctx, loanId)).filter((c) => c.concept === 'interest' && c.status !== 'void').map((c) => c.period_no ?? 0);
    const next = Math.max(0, ...doneNos) + 1;
    const start = next === 1 ? t.opened : ends[next - 2]!;
    if (start < ctx.today) {
      const base = t.base === 'original' ? t.principal : await principalOutstandingAt(ctx, loan, start);
      const accrued = accruedInPeriod(t, base, ctx.today - start);
      if (accrued > 0n) extra.push({ amount: accrued, periodNo: next });
    }
  }
  const total = lines.reduce((a, l) => a + l.settle, 0n) + extra.reduce((a, x) => a + x.amount, 0n);
  return { loan, lines, extra, total };
}

export async function previewPayoff(ctx: Ctx, loanId: string, i: { accountId: string; paidOn?: string }) {
  const p = await buildPayoff(ctx, loanId);
  await activeAccount(ctx, i.accountId);
  const paidOn = resolveDate(ctx, i.paidOn);
  return {
    mode: p.loan.early_payoff, total: m(p.total), paidOn: formatISO(paidOn),
    lines: [
      ...p.lines.map((l) => ({ chargeId: l.chargeId, concept: l.concept, dueDate: l.dueDate, pending: m(l.pending), settle: m(l.settle), action: l.action })),
      ...p.extra.map((x) => ({ chargeId: null, concept: 'interest', dueDate: formatISO(ctx.today), pending: '0.00', settle: m(x.amount), action: 'accrued_now' })),
    ],
    note: p.loan.early_payoff === 'keep' ? 'Se paga el interés acordado completo.' : 'Se paga solo el interés devengado hasta hoy (prorrateo diario, base 30).',
    previewToken: makePreviewToken(ctx.previewSecret, { scope: 'loan.payoff', ownerId: ctx.ownerId, inputs: { loanId, accountId: i.accountId, paidOn: i.paidOn ?? null }, state: p.lines.map((l) => [l.chargeId, m(l.settle), l.action]) }, ctx.nowMs),
  };
}

export async function payoff(ctx: Ctx, loanId: string, body: { accountId: string; paidOn?: string; previewToken: string }) {
  const p = await buildPayoff(ctx, loanId);
  checkPreviewToken(ctx.previewSecret, body.previewToken, { scope: 'loan.payoff', ownerId: ctx.ownerId, inputs: { loanId, accountId: body.accountId, paidOn: body.paidOn ?? null }, state: p.lines.map((l) => [l.chargeId, m(l.settle), l.action]) }, ctx.nowMs);
  await activeAccount(ctx, body.accountId);
  const paidOn = resolveDate(ctx, body.paidOn);
  const allocations: PayPlan['allocations'] = [];
  for (const l of p.lines) {
    if (l.action === 'void') { await sql`update loan_charge set status = 'void' where owner_id = ${ctx.ownerId} and id = ${l.chargeId}`.execute(ctx.trx); continue; }
    if (l.action === 'prorated') {
      // El cargo queda en lo devengado: lo ya pagado más lo que se liquida ahora.
      const paid = parseMoney((await one<{ paid: string }>(ctx.trx, sql<{ paid: string }>`select coalesce(sum(a.amount), 0.00) as paid from loan_allocation a join loan_payment pp on pp.id = a.payment_id where a.charge_id = ${l.chargeId} and pp.status = 'active'`))!.paid);
      if (paid + l.settle === 0n) await sql`update loan_charge set status = 'void' where owner_id = ${ctx.ownerId} and id = ${l.chargeId}`.execute(ctx.trx);
      else await sql`update loan_charge set amount = ${m(paid + l.settle)}, note = 'Interés devengado hasta el pago anticipado' where owner_id = ${ctx.ownerId} and id = ${l.chargeId}`.execute(ctx.trx);
    }
    if (l.settle > 0n) allocations.push({ chargeId: l.chargeId, amount: l.settle, pending: l.settle });
  }
  for (const x of p.extra) {
    const id = await insertCharge(ctx, loanId, { concept: 'interest', due: ctx.today, amount: x.amount, periodNo: x.periodNo, note: 'Interés devengado hasta el pago anticipado' });
    allocations.push({ chargeId: id, amount: x.amount, pending: x.amount });
  }
  if (p.total <= 0n) throw unprocessable('NOTHING_TO_PAY', 'No hay nada que pagar');
  const plan: PayPlan = { loan: p.loan, amount: p.total, paidOn, allocations, remainder: 0n, proposed: false, issues: [], pendings: [] };
  const w = await writePayment(ctx, plan, body.accountId, 'payoff', p.loan.direction === 'lent' ? 'Cancelación anticipada de préstamo recibido' : 'Cancelación anticipada de préstamo');
  await sql`update loan set status = 'closed', closed_reason = 'Pago anticipado' where owner_id = ${ctx.ownerId} and id = ${loanId}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'loan.payoff', entityType: 'loan', entityId: loanId, changes: { total: m(p.total), mode: p.loan.early_payoff } });
  return { paymentId: w.paymentId, operationId: w.operationId, loan: await getLedgerLoan(ctx, loanId) };
}

// ───────────────────────── Mora (RN-L10, RN-L23, D-21) ─────────────────────────

export interface LateFeeInput { mode: 'fixed' | 'percent'; amount?: string | null; ratePercent?: string | null }

async function buildFees(ctx: Ctx, loanId: string, i: LateFeeInput) {
  let loan = await loadLoan(ctx, loanId, true);
  if (loan.engine !== 'ledger') throw unprocessable('LOAN_NOT_LEDGER', 'Este préstamo viene de una deuda de servicios');
  if (loan.status !== 'open') throw unprocessable('LOAN_NOT_OPEN', 'El préstamo no está abierto');
  await accrueOpen(ctx, loan);
  loan = await loadLoan(ctx, loanId);
  if (i.mode === 'fixed' && parseMoney(i.amount ?? '0') <= 0n) throw unprocessable('INTEREST_REQUIRED', 'Indica el importe fijo de la mora por período');
  if (i.mode === 'percent' && pctToBp(i.ratePercent ?? '0') <= 0) throw unprocessable('INTEREST_REQUIRED', 'Indica el porcentaje de mora por período');
  const existing = new Set((await rows<{ source_charge_id: string; period_no: number }>(ctx.trx, sql<{ source_charge_id: string; period_no: number }>`
    select source_charge_id, period_no from loan_charge where loan_id = ${loanId} and concept = 'late_fee' and status <> 'void'`)).map((x) => `${x.source_charge_id}:${x.period_no}`));
  const out: Array<{ sourceChargeId: string; periodNo: number; overdue: bigint; fee: bigint; periodEnd: string }> = [];
  for (const it of await pendingItems(ctx, loanId)) {
    const c = it.row;
    if (c.concept === 'late_fee' || !c.due_date || c.due_date >= formatISO(ctx.today)) continue;
    const ends = periodEnds(parseISO(c.due_date), 120);
    for (let j = 1; j <= ends.length && ends[j - 1]! <= ctx.today; j++) {
      if (existing.has(`${c.id}:${j}`)) continue;
      const fee = lateFee(i.mode, i.amount ? parseMoney(i.amount) : null, i.ratePercent ? pctToBp(i.ratePercent) : null, it.pending);
      if (fee > 0n) out.push({ sourceChargeId: c.id, periodNo: j, overdue: it.pending, fee, periodEnd: formatISO(ends[j - 1]!) });
    }
  }
  return { loan, fees: out };
}

const feeInputs = (loanId: string, i: LateFeeInput) => ({ loanId, mode: i.mode, amount: i.amount ? m(i.amount) : null, ratePercent: i.ratePercent ?? null });

export async function previewLateFees(ctx: Ctx, loanId: string, i: LateFeeInput) {
  const p = await buildFees(ctx, loanId, i);
  return {
    count: p.fees.length, total: m(p.fees.reduce((a, f) => a + f.fee, 0n)),
    items: p.fees.map((f) => ({ sourceChargeId: f.sourceChargeId, periodNo: f.periodNo, periodEnd: f.periodEnd, overduePending: m(f.overdue), fee: m(f.fee) })),
    note: 'La mora se calcula aquí y solo se aplica si la confirmas. Nada se cobra solo.',
    previewToken: makePreviewToken(ctx.previewSecret, { scope: 'loan.late_fees', ownerId: ctx.ownerId, inputs: feeInputs(loanId, i), state: p.fees.map((f) => [f.sourceChargeId, f.periodNo, m(f.fee)]) }, ctx.nowMs),
  };
}

export async function applyLateFees(ctx: Ctx, loanId: string, body: LateFeeInput & { previewToken: string }) {
  const { previewToken, ...i } = body;
  const p = await buildFees(ctx, loanId, i);
  checkPreviewToken(ctx.previewSecret, previewToken, { scope: 'loan.late_fees', ownerId: ctx.ownerId, inputs: feeInputs(loanId, i), state: p.fees.map((f) => [f.sourceChargeId, f.periodNo, m(f.fee)]) }, ctx.nowMs);
  for (const f of p.fees) await insertCharge(ctx, loanId, { concept: 'late_fee', due: ctx.today, amount: f.fee, periodNo: f.periodNo, sourceChargeId: f.sourceChargeId, note: `Mora del período ${f.periodNo}` });
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'loan.late_fees', entityType: 'loan', entityId: loanId, changes: { count: p.fees.length, total: m(p.fees.reduce((a, f) => a + f.fee, 0n)) } });
  return getLedgerLoan(ctx, loanId);
}

// ───────────────────────── Capitalización (RN-L09) ─────────────────────────

async function buildCapitalization(ctx: Ctx, loanId: string) {
  let loan = await loadLoan(ctx, loanId, true);
  if (loan.engine !== 'ledger') throw unprocessable('LOAN_NOT_LEDGER', 'Este préstamo viene de una deuda de servicios');
  if (loan.status !== 'open') throw unprocessable('LOAN_NOT_OPEN', 'El préstamo no está abierto');
  await accrueOpen(ctx, loan);
  loan = await loadLoan(ctx, loanId);
  const items = (await pendingItems(ctx, loanId)).filter((x) => x.row.concept === 'interest' && parseMoney(x.row.paid) === 0n && x.row.due_date !== null && x.row.due_date <= formatISO(ctx.today));
  const total = items.reduce((a, x) => a + x.pending, 0n);
  return { loan, items, total };
}

export async function previewCapitalization(ctx: Ctx, loanId: string) {
  const p = await buildCapitalization(ctx, loanId);
  if (p.total <= 0n) throw unprocessable('NOTHING_TO_CAPITALIZE', 'No hay interés vencido y sin pagar para capitalizar');
  return {
    total: m(p.total), items: p.items.map((x) => ({ chargeId: x.row.id, periodNo: x.row.period_no, dueDate: x.row.due_date, amount: m(x.pending) })),
    note: 'El interés pasa a capital una sola vez y desde entonces genera interés. Solo ocurre si lo confirmas.',
    previewToken: makePreviewToken(ctx.previewSecret, { scope: 'loan.capitalize', ownerId: ctx.ownerId, inputs: { loanId }, state: p.items.map((x) => [x.row.id, m(x.pending)]) }, ctx.nowMs),
  };
}

export async function capitalize(ctx: Ctx, loanId: string, previewToken: string) {
  const p = await buildCapitalization(ctx, loanId);
  if (p.total <= 0n) throw unprocessable('NOTHING_TO_CAPITALIZE', 'No hay interés vencido y sin pagar para capitalizar');
  checkPreviewToken(ctx.previewSecret, previewToken, { scope: 'loan.capitalize', ownerId: ctx.ownerId, inputs: { loanId }, state: p.items.map((x) => [x.row.id, m(x.pending)]) }, ctx.nowMs);
  for (const x of p.items) await sql`update loan_charge set status = 'capitalized' where owner_id = ${ctx.ownerId} and id = ${x.row.id}`.execute(ctx.trx);
  const due = p.loan.final_date ? parseISO(p.loan.final_date) : null;
  const principalId = await insertCharge(ctx, loanId, { concept: 'principal', due, amount: p.total, note: 'Interés capitalizado' });
  await sql`insert into loan_capitalization (owner_id, loan_id, capitalized_on, amount, principal_charge_id, created_by) values (${ctx.ownerId}, ${loanId}, ${formatISO(ctx.today)}, ${m(p.total)}, ${principalId}, ${ctx.actorId})`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'loan.capitalize', entityType: 'loan', entityId: loanId, changes: { amount: m(p.total), charges: p.items.length } });
  return getLedgerLoan(ctx, loanId);
}

// ───────────────────────── Cancelar ─────────────────────────

/** Anula un préstamo recién registrado por error: solo si no tiene pagos. Revierte el desembolso. */
export async function cancelLoan(ctx: Ctx, loanId: string, reason: string) {
  const l = await loadLoan(ctx, loanId, true);
  if (l.engine !== 'ledger') throw unprocessable('LOAN_NOT_LEDGER', 'Este préstamo viene de una deuda de servicios');
  if (l.status !== 'open') throw conflict('LOAN_NOT_OPEN', 'El préstamo no está abierto');
  const pays = await one<{ n: string }>(ctx.trx, sql<{ n: string }>`select count(*) as n from loan_payment where owner_id = ${ctx.ownerId} and loan_id = ${loanId} and status = 'active'`);
  if (Number(pays!.n) > 0) throw unprocessable('LOAN_HAS_PAYMENTS', 'El préstamo ya tiene pagos: revierte primero esos pagos');
  const disb = await one<{ disbursement_operation_id: string | null }>(ctx.trx, sql<{ disbursement_operation_id: string | null }>`select disbursement_operation_id from loan where owner_id = ${ctx.ownerId} and id = ${loanId}`);
  if (disb?.disbursement_operation_id) await reverseOperationCore(ctx, disb.disbursement_operation_id, reason.trim(), undefined, { allowLinked: true });
  await sql`update loan_charge set status = 'void' where owner_id = ${ctx.ownerId} and loan_id = ${loanId} and status = 'active'`.execute(ctx.trx);
  await sql`update loan set status = 'cancelled', closed_reason = ${reason.trim()} where owner_id = ${ctx.ownerId} and id = ${loanId}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'loan.cancel', entityType: 'loan', entityId: loanId, reason: reason.trim() });
  return getLedgerLoan(ctx, loanId);
}

/** Ids de préstamos del libro (para listados). */
export async function ledgerLoanIds(ctx: Ctx, contactId?: string) {
  return (await rows<{ id: string }>(ctx.trx, sql<{ id: string }>`
    select id from loan where owner_id = ${ctx.ownerId} and engine = 'ledger' and (${contactId ?? null}::uuid is null or contact_id = ${contactId ?? null}) order by opened_on desc, created_at desc`)).map((r) => r.id);
}

/** Pendiente de los préstamos del libro por dirección, para el resumen. */
export async function ledgerTotals(ctx: Ctx) {
  const r = await rows<{ direction: string; pending: string }>(ctx.trx, sql<{ direction: string; pending: string }>`
    select l.direction, coalesce(sum(c.amount - coalesce(a.paid, 0)), 0.00) as pending
    from loan l join loan_charge c on c.loan_id = l.id and c.owner_id = l.owner_id and c.status = 'active'
    left join lateral (select sum(al.amount) as paid from loan_allocation al join loan_payment p on p.id = al.payment_id where al.charge_id = c.id and p.status = 'active') a on true
    where l.owner_id = ${ctx.ownerId} and l.engine = 'ledger' and l.status = 'open' group by l.direction`);
  const get = (d: string) => parseMoney(r.find((x) => x.direction === d)?.pending ?? '0');
  return { lentPending: m(get('lent')), borrowedPending: m(get('borrowed')) };
}
