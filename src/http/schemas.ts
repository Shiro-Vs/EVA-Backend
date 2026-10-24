import { z } from 'zod';

export const uuid = z.uuid();
export const isoTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Se espera HH:MM (24 horas)');
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Se espera YYYY-MM-DD');
/** Importe positivo con hasta 2 decimales, como cadena (13 §1). */
export const money = z.string().regex(/^\d+(\.\d{1,2})?$/, 'Importe inválido: use una cadena decimal como "20.00"');
export const signedMoney = z.string().regex(/^-?\d+(\.\d{1,2})?$/, 'Importe inválido');
const text = (max = 120) => z.string().trim().min(1).max(max);
const optText = (max = 200) => z.string().trim().max(max).nullish();

export const intervalSchema = z.object({ unit: z.enum(['day', 'week', 'month', 'year']), count: z.number().int().min(1).max(120) }).strict();

export const profilePatch = z.object({
  displayName: text(80).optional(),
  defaultFreeDays: z.number().int().min(0).max(365).optional(),
  exitDaysLimit: z.number().int().min(0).max(365).nullable().optional(),
}).strict();

export const accountCreate = z.object({
  name: text(60),
  type: z.enum(['bank', 'savings', 'cash', 'wallet', 'credit']),
  institution: optText(60).transform((v) => v ?? undefined),
  color: optText(20).transform((v) => v ?? undefined),
  icon: optText(40).transform((v) => v ?? undefined),
  isDefault: z.boolean().optional(),
  excludeFromTotal: z.boolean().optional(),
  openingBalance: z.object({ amount: signedMoney, date: isoDate.optional() }).strict().optional(),
}).strict();

export const accountPatch = z.object({
  name: text(60).optional(), color: optText(20), icon: optText(40), isDefault: z.boolean().optional(), excludeFromTotal: z.boolean().optional(),
}).strict();

export const operationCreate = z.object({
  kind: z.enum(['income', 'expense', 'transfer']),
  accountId: uuid,
  toAccountId: uuid.optional(),
  amount: money,
  date: isoDate.optional(),
  time: isoTime.optional(),
  description: z.string().trim().max(200).optional(),
  categoryId: uuid.nullish(),
  contactId: uuid.nullish(),
  goalDeductions: z.array(z.object({ goalId: uuid, amount: money }).strict()).max(20).optional(),
  acceptReserveShortfall: z.boolean().optional(),
}).strict();

export const reverseBody = z.object({ reason: text(200), date: isoDate.optional() }).strict();

export const contactCreate = z.object({
  name: text(80), phone: optText(30), email: optText(120), color: optText(20), notes: optText(500),
}).strict();
export const contactPatch = contactCreate.partial();

export const subscriptionBody = z.object({
  name: text(60),
  provider: optText(60),
  mode: z.enum(['personal', 'shared']),
  capacity: z.number().int().min(1).max(50),
  announcedPrice: money,
  interval: intervalSchema,
  startDate: isoDate,
  nextPaymentDate: isoDate,
  preferredAccountId: uuid.nullish(),
  color: optText(20),
  icon: optText(40),
  categoryId: uuid.nullish(),
}).strict();

export const subscriptionPreview = subscriptionBody.extend({ occupiedSeats: z.number().int().min(1).max(50).optional() }).strict();
export const subscriptionCreate = subscriptionBody.extend({ confirmCalendarMismatch: z.boolean().optional(), previewToken: z.string().min(10) }).strict();
export const subscriptionPatch = z.object({
  name: text(60).optional(), provider: optText(60), color: optText(20), icon: optText(40), preferredAccountId: uuid.nullish(), categoryId: uuid.nullish(),
}).strict();

export const generateBody = z.object({ ahead: z.number().int().min(1).max(12) }).strict();

export const listQuery = z.object({
  status: z.enum(['active', 'archived', 'suspended']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export const decodeCursor = (c?: string): number => {
  if (!c) return 0;
  const n = Number(Buffer.from(c, 'base64url').toString('utf8'));
  return Number.isInteger(n) && n >= 0 ? n : 0;
};

export const seatBody = z.object({
  contactId: uuid,
  label: z.string().trim().min(1).max(40),
  joinDate: isoDate.optional(),
  quota: money,
  freeDaysThreshold: z.number().int().min(0).max(365).nullish(),
}).strict();
export const seatCreate = seatBody.extend({ previewToken: z.string().min(10) }).strict();

export const courtesyBody = z.object({
  kind: z.enum(['cycles', 'until_date', 'permanent']),
  cycles: z.number().int().min(1).max(60).optional(),
  untilDate: isoDate.optional(),
  reason: text(200),
  debtHandling: z.enum(['keep', 'convert']).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.kind === 'cycles' && v.cycles === undefined) ctx.addIssue({ code: 'custom', path: ['cycles'], message: 'Indica cuántos ciclos' });
  if (v.kind === 'until_date' && v.untilDate === undefined) ctx.addIssue({ code: 'custom', path: ['untilDate'], message: 'Indica la fecha final' });
});

export const quotaChangeBody = z.object({
  newQuota: money,
  effectiveFrom: isoDate,
  mode: z.enum(['per_renewal', 'lump']),
  reason: text(200),
}).strict();
export const quotaChangeCreate = quotaChangeBody.extend({ previewToken: z.string().min(10) }).strict();

const reasonText = text(200);
export const calendarChangeBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('shift_renewal'), newDate: isoDate, reason: reasonText }).strict(),
  z.object({ kind: z.literal('advance_renewal'), newDate: isoDate, reason: reasonText }).strict(),
  z.object({ kind: z.literal('change_interval'), interval: intervalSchema, reason: reasonText }).strict(),
  z.object({ kind: z.literal('suspend'), reason: reasonText }).strict(),
  z.object({ kind: z.literal('reactivate'), renewalDate: isoDate, reason: reasonText }).strict(),
]);
export const calendarChangeCreate = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('shift_renewal'), newDate: isoDate, reason: reasonText, previewToken: z.string().min(10) }).strict(),
  z.object({ kind: z.literal('advance_renewal'), newDate: isoDate, reason: reasonText, previewToken: z.string().min(10) }).strict(),
  z.object({ kind: z.literal('change_interval'), interval: intervalSchema, reason: reasonText, previewToken: z.string().min(10) }).strict(),
  z.object({ kind: z.literal('suspend'), reason: reasonText, previewToken: z.string().min(10) }).strict(),
  z.object({ kind: z.literal('reactivate'), renewalDate: isoDate, reason: reasonText, previewToken: z.string().min(10) }).strict(),
]);

const percent = z.string().regex(/^\d+(\.\d{1,2})?$/, 'Porcentaje inválido: use una cadena como "5" o "5.25"');
export const loanBody = z.object({
  direction: z.enum(['lent', 'borrowed']),
  contactId: uuid.nullish(),
  counterpartyName: optText(80),
  principal: money,
  openedOn: isoDate.optional(),
  accountId: uuid.nullish(),
  interest: z.object({ mode: z.enum(['none', 'fixed', 'percent']), amount: money.nullish(), ratePercent: percent.nullish(), base: z.enum(['original', 'pending']).optional() }).strict(),
  repayment: z.object({ kind: z.enum(['installments', 'final_date', 'open']), installments: z.number().int().min(1).max(360).optional(), firstDueDate: isoDate.optional(), finalDate: isoDate.optional() }).strict(),
  paymentOrder: z.enum(['capital_first', 'interest_first']).optional(),
  earlyPayoff: z.enum(['keep', 'accrued']).optional(),
  note: optText(200),
}).strict();
export const loanCreate = loanBody.extend({ previewToken: z.string().min(10) }).strict();
export const loanPaymentBody = z.object({
  amount: money, accountId: uuid, paidOn: isoDate.optional(),
  allocations: z.array(z.object({ chargeId: uuid, amount: money }).strict()).max(200).optional(), onRemainder: z.literal('keep').optional(),
}).strict();
export const loanPaymentCreate = loanPaymentBody.extend({ previewToken: z.string().min(10) }).strict();
export const loanPayoffBody = z.object({ accountId: uuid, paidOn: isoDate.optional() }).strict();
export const loanPayoffCreate = loanPayoffBody.extend({ previewToken: z.string().min(10) }).strict();
export const lateFeeBody = z.object({ mode: z.enum(['fixed', 'percent']), amount: money.nullish(), ratePercent: percent.nullish() }).strict();
export const lateFeeCreate = lateFeeBody.extend({ previewToken: z.string().min(10) }).strict();
export const tokenOnly = z.object({ previewToken: z.string().min(10) }).strict();

export const recurringCreate = z.object({
  name: text(80), kind: z.enum(['income', 'expense']), accountId: uuid, amount: money, categoryId: uuid.nullish(), contactId: uuid.nullish(), description: z.string().trim().max(200).optional(),
  interval: intervalSchema, startDate: isoDate, endDate: isoDate.nullish(),
}).strict();
export const recurringPatch = z.object({
  name: text(80).optional(), accountId: uuid.optional(), amount: money.optional(), categoryId: uuid.nullish(), contactId: uuid.nullish(), description: z.string().trim().max(200).optional(),
  interval: intervalSchema.optional(), startDate: isoDate.optional(), endDate: isoDate.nullish(),
}).strict();
export const recurringListQuery = z.object({ status: z.enum(['active', 'paused', 'archived']).default('active') });
export const recurringPendingQuery = z.object({ within: z.coerce.number().int().min(0).max(90).default(7) });
export const occurrenceConfirm = z.object({
  amount: money.optional(), accountId: uuid.optional(), date: isoDate.optional(), description: z.string().trim().max(200).optional(), categoryId: uuid.nullish(),
  goalDeductions: z.array(z.object({ goalId: uuid, amount: money }).strict()).max(20).optional(), acceptReserveShortfall: z.boolean().optional(),
}).strict();
export const occurrenceSkip = z.object({ note: z.string().trim().max(200).optional() }).strict();
export const occurrenceLink = z.object({ operationId: uuid }).strict();

export const reconcileBody = z.object({ realBalance: signedMoney, asOf: isoDate.optional() }).strict();
export const reconcileCreate = reconcileBody.extend({ reason: z.string().trim().max(200).optional(), previewToken: z.string().min(10) }).strict();

export const goalCreate = z.object({ name: text(80), targetAmount: money, targetDate: isoDate.nullish(), icon: optText(40), color: optText(20), note: optText(200) }).strict();
export const goalPatch = z.object({ name: text(80).optional(), targetAmount: money.optional(), targetDate: isoDate.nullish(), icon: optText(40), color: optText(20), note: optText(200) }).strict();
export const goalMoney = z.object({ accountId: uuid, amount: money, note: z.string().trim().max(200).optional() }).strict();
export const goalLink = z.object({ operationId: uuid }).strict();
export const goalListQuery = z.object({ status: z.enum(['active', 'archived']).default('active') });

export const budgetCreate = z.object({
  name: text(80),
  categoryId: uuid.nullish(),
  includeSubcategories: z.boolean().optional(),
  period: z.enum(['weekly', 'monthly', 'yearly']),
  limit: money,
  thresholds: z.array(z.number().int().min(1).max(1000)).max(6).optional(),
  rollover: z.boolean().optional(),
  rolloverCap: money.nullish(),
  sharedView: z.enum(['origin_cycle', 'receipt_date']).optional(),
  startsOn: isoDate.optional(),
}).strict();
export const budgetPatch = z.object({
  name: text(80).optional(), includeSubcategories: z.boolean().optional(), limit: money.optional(), thresholds: z.array(z.number().int().min(1).max(1000)).max(6).optional(),
  rollover: z.boolean().optional(), rolloverCap: money.nullish(), sharedView: z.enum(['origin_cycle', 'receipt_date']).optional(),
}).strict();
export const budgetQuery = z.object({ date: isoDate.optional(), status: z.enum(['active', 'archived']).optional() });
export const budgetHistoryQuery = z.object({ count: z.coerce.number().int().min(1).max(24).default(6) });

export const creditDetails = z.object({ creditLine: money.nullish(), cutoffDay: z.number().int().min(1).max(31), dueDay: z.number().int().min(1).max(31) }).strict();
export const statementCreate = z.object({
  cutoffDate: isoDate, dueDate: isoDate, periodTotal: money, minimumPayment: money, totalBalance: money.nullish(), note: optText(200),
}).strict();
export const statementPayment = z.object({ operationId: uuid }).strict();
export const installmentPurchase = z.object({
  amount: money, installments: z.number().int().min(2).max(60), firstDueDate: isoDate, description: z.string().trim().max(200).optional(), categoryId: uuid.nullish(), date: isoDate.optional(),
}).strict();
export const advisorQuery = z.object({ date: isoDate.optional() });

export const categoryCreate = z.object({ name: text(60), parentId: uuid.nullish(), icon: optText(40), color: optText(20) }).strict();
export const categoryPatch = z.object({ name: text(60).optional(), icon: optText(40), color: optText(20) }).strict();
export const categoryListQuery = z.object({ status: z.enum(['active', 'archived']).optional() });

const ruleFields = {
  name: text(80),
  priority: z.number().int().min(0).max(100000).optional(),
  accountId: uuid.nullish(),
  direction: z.enum(['income', 'expense']).nullish(),
  amountMin: money.nullish(),
  amountMax: money.nullish(),
  textContains: optText(80),
  action: z.enum(['assign', 'suggest']),
  categoryId: uuid,
};
export const ruleCreate = z.object(ruleFields).strict();
export const rulePatch = z.object(ruleFields).partial().strict();
export const ruleListQuery = z.object({ status: z.enum(['active', 'archived']).optional() });
export const classificationSuggest = z.object({ accountId: uuid, direction: z.enum(['income', 'expense']), amount: money, text: z.string().trim().max(200).optional() }).strict();
export const classificationApplyPreview = z.object({ from: isoDate.optional(), to: isoDate.optional() }).strict();
export const classificationApply = classificationApplyPreview.extend({ previewToken: z.string().min(10) }).strict();

export const operationListQuery = z.object({
  status: z.enum(['confirmed', 'reversed']).optional(),
  kind: z.enum(['income', 'expense', 'transfer', 'adjustment', 'reversal', 'opening']).optional(),
  accountId: uuid.optional(),
  categoryId: uuid.optional(),
  uncategorized: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export const operationPatch = z.object({
  description: z.string().trim().max(200).optional(),
  categoryId: uuid.nullable().optional(),
  contactId: uuid.nullable().optional(),
}).strict();
export const receiptPatch = z.object({ note: z.string().trim().max(200).nullable().optional() }).strict();

export const operationCorrection = z.object({ amount: money.optional(), accountId: uuid.optional(), toAccountId: uuid.optional(), date: isoDate.optional() }).strict();
export const operationCorrectionCreate = operationCorrection.extend({ reason: text(200), previewToken: z.string().min(10) }).strict();

export const receiptCorrection = z.object({
  amount: money.optional(),
  accountId: uuid.optional(),
  receivedOn: isoDate.optional(),
  allocations: z.array(z.object({ obligationId: uuid, amount: money }).strict()).max(100).optional(),
  reserveRemainder: z.object({ subscriptionId: uuid }).strict().nullable().optional(),
}).strict();
export const receiptCorrectionCreate = receiptCorrection.extend({ reason: text(200), previewToken: z.string().min(10) }).strict();
export const receiptReverseCreate = z.object({ reason: text(200), previewToken: z.string().min(10) }).strict();

export const priceChangeBody = z.object({
  newPrice: money,
  effectiveFrom: isoDate,
  mode: z.enum(['per_renewal', 'lump']),
  reason: text(200),
  quotas: z.array(z.object({ seatId: uuid, quota: money }).strict()).max(50).optional(),
}).strict();
export const priceChangeCreate = priceChangeBody.extend({ previewToken: z.string().min(10) }).strict();

export const debtConversionPreview = z.object({ obligationIds: z.array(uuid).min(1).max(100) }).strict();
export const debtConversionCreate = debtConversionPreview.extend({ reason: text(200), previewToken: z.string().min(10) }).strict();

export const exitPreviewBody = z.object({ reason: text(200).optional() }).strict();
export const exitBody = z.object({ reason: text(200) }).strict();
export const exitCreate = exitBody.extend({ previewToken: z.string().min(10) }).strict();

export const refundCreate = z.object({ receiptId: uuid, amount: money, reason: text(200) }).strict();
export const refundPay = z.object({ accountId: uuid, paidOn: isoDate.optional(), note: z.string().trim().max(200).optional() }).strict();
export const refundListQuery = z.object({ status: z.enum(['planned', 'paid', 'cancelled']).optional(), contactId: uuid.optional() });
export const loanListQuery = z.object({ contactId: uuid.optional() });

export const receiptBody = z.object({
  contactId: uuid,
  accountId: uuid,
  amount: money,
  receivedOn: isoDate.optional(),
  note: z.string().trim().max(200).optional(),
  allocations: z.array(z.object({ obligationId: uuid, amount: money }).strict()).max(100),
  reserveRemainder: z.object({ subscriptionId: uuid }).strict().nullable().optional(),
}).strict();
export const receiptCreate = receiptBody.extend({ previewToken: z.string().min(10) }).strict();

export const supplierBody = z.object({ accountId: uuid, amount: money, paidOn: isoDate.optional(), note: z.string().trim().max(200).optional() }).strict();
export const reasonBody = z.object({ reason: z.string().trim().min(1).max(200) }).strict();
export const moveBody = z.object({ subscriptionId: uuid }).strict();

// ---------- Captura asistida (Entrega 4) ----------
export const captureDocumentCreate = z.object({
  origin: z.enum(['photo', 'pdf', 'text']),
  mime: z.string().trim().min(3).max(100).optional(),
  filename: z.string().trim().max(200).optional(),
  contentBase64: z.string().min(4).optional(),
  text: z.string().trim().min(1).max(100_000).optional(),
  subject: z.string().trim().max(200).optional(),
  sender: z.string().trim().max(200).optional(),
}).strict().refine((v) => v.contentBase64 || v.text, { message: 'Envía el archivo (contentBase64) o el texto', path: ['contentBase64'] })
  .refine((v) => v.origin === 'text' || v.contentBase64, { message: 'Una foto o PDF requiere contentBase64', path: ['contentBase64'] });
export const captureInboundEmail = z.object({
  to: z.string().trim().min(3).max(200),
  from: z.string().trim().max(200).optional(),
  subject: z.string().trim().max(300).optional(),
  text: z.string().max(200_000).optional(),
  messageId: z.string().trim().max(300).optional(),
  attachments: z.array(z.object({ filename: z.string().max(200).optional(), mime: z.string().max(100), contentBase64: z.string().min(4) }).strict()).max(10).optional(),
}).strict();
export const captureDocsQuery = z.object({ status: z.enum(['received', 'proposed', 'failed', 'discarded', 'no_transaction']).optional() });
export const captureProposalsQuery = z.object({ status: z.enum(['pending', 'accepted', 'linked', 'discarded']).default('pending') });
export const proposalPatch = z.object({
  direction: z.enum(['income', 'expense', 'transfer']).optional(), amount: money.nullable().optional(), occurredOn: isoDate.nullable().optional(), occurredTime: isoTime.nullable().optional(),
  accountId: uuid.nullable().optional(), toAccountId: uuid.nullable().optional(), categoryId: uuid.nullable().optional(), contactId: uuid.nullable().optional(),
  description: z.string().trim().max(200).nullable().optional(),
}).strict();
export const proposalAccept = z.object({
  previewToken: z.string().min(10), acknowledgeDuplicates: z.boolean().optional(),
  goalDeductions: z.array(z.object({ goalId: uuid, amount: money }).strict()).max(20).optional(), acceptReserveShortfall: z.boolean().optional(),
}).strict();
export const proposalBatch = z.object({
  items: z.array(z.object({ id: uuid, previewToken: z.string().min(10), acknowledgeDuplicates: z.boolean().optional() }).strict()).min(1).max(50),
}).strict();
export const proposalLink = z.object({ operationId: uuid }).strict();
export const proposalUndo = z.object({ reason: text(200) }).strict();
export const senderRuleCreate = z.object({ sender: text(200), accountId: uuid.nullish(), categoryId: uuid.nullish(), contactId: uuid.nullish() }).strict();
export const capturePurge = z.object({ olderThanDays: z.number().int().min(1).max(3650).optional() }).strict();
