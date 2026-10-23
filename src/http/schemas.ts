import { z } from 'zod';

export const uuid = z.uuid();
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
  description: z.string().trim().max(200).optional(),
  categoryId: uuid.nullish(),
  contactId: uuid.nullish(),
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
}).strict();

export const subscriptionPreview = subscriptionBody.extend({ occupiedSeats: z.number().int().min(1).max(50).optional() }).strict();
export const subscriptionCreate = subscriptionBody.extend({ confirmCalendarMismatch: z.boolean().optional(), previewToken: z.string().min(10) }).strict();
export const subscriptionPatch = z.object({
  name: text(60).optional(), provider: optText(60), color: optText(20), icon: optText(40), preferredAccountId: uuid.nullish(),
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
