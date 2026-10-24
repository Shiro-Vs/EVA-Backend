import { createHash } from 'node:crypto';
import { z } from 'zod';
import { loanExtraction } from './bankLoan.js';
import { isoDate, money, optText } from './captureBase.js';
import { parseISO } from './localDate.js';

// Esquema de salida de la extracción (07 §6). El servidor lo valida antes de proponer nada: lo que no cumpla → `Fallido`.
const text = optText;

export const extractedMovement = z.object({
  direction: z.enum(['income', 'expense', 'transfer']),
  amount: money.nullable().optional().transform((v) => v ?? null),
  currency: z.string().length(3).default('PEN'),
  occurredOn: isoDate.nullable().optional().transform((v) => v ?? null),
  /** Hora local 24 h (HH:MM); el modelo puede devolver HH:MM:SS y se recorta. */
  occurredTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'hora HH:MM').nullable().optional().transform((v) => (v ? v.slice(0, 5) : null)),
  /** Se conserva tal cual, incluido el asterisco con que Yape trunca el apellido: indica que el nombre está incompleto. */
  counterparty: text,
  channel: text,
  operationId: text,
  concept: text,
  suggestedCategory: text,
  items: z.array(z.object({ concept: z.string().max(200).default(''), amount: money.nullable().optional().transform((v) => v ?? null) })).max(50).default([]),
});

export const extractionSchema = z.object({
  documentType: z.enum(['payment_receipt', 'bank_statement', 'loan_schedule', 'loan_summary', 'card_statement', 'other']),
  isTransaction: z.boolean(),
  confidence: z.number().min(0).max(1).default(0),
  movements: z.array(extractedMovement).max(100).default([]),
  /** Presente solo en documentos de préstamo (resumen, cronograma, estado de cuenta). */
  loan: loanExtraction.nullable().optional().transform((v) => v ?? null),
  missingFields: z.array(z.string().max(60)).max(30).default([]),
  warnings: z.array(z.string().max(300)).max(30).default([]),
});
export type Extraction = z.infer<typeof extractionSchema>;
export type ExtractedMovement = z.infer<typeof extractedMovement>;

/** Dirección de recepción: `gastos.{nombre}-{hash3}@dominio`. No depende del nombre una vez creada; `rotation` la cambia al rotar (07 §3). */
export function inboxAddressFor(ownerId: string, displayName: string, domain: string, rotation: number): string {
  const slug = displayName.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'usuario';
  const hash3 = createHash('sha256').update(`${ownerId}:${rotation}`).digest('hex').slice(0, 3);
  return `gastos.${slug}-${hash3}@${domain.toLowerCase()}`;
}

/** Huella del contenido normalizado: reentregas exactas dan la misma (RN-DU01). */
export function contentHash(parts: { bytes?: Buffer | null; text?: string | null; subject?: string | null }): string {
  const h = createHash('sha256');
  if (parts.bytes && parts.bytes.length > 0) h.update(parts.bytes);
  h.update('\u0000');
  h.update((parts.text ?? '').replace(/\s+/g, ' ').trim());
  h.update('\u0000');
  h.update((parts.subject ?? '').trim());
  return h.digest('hex');
}

/** Días entre dos fechas locales (valor absoluto). */
export function dayDistance(a: string, b: string): number {
  return Math.abs(parseISO(a) - parseISO(b));
}

const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** Minutos entre dos momentos locales (fecha + HH:MM). */
export function minutesApart(dateA: string, timeA: string, dateB: string, timeB: string): number {
  return Math.abs((parseISO(dateA) - parseISO(dateB)) * 1440 + toMinutes(timeA) - toMinutes(timeB));
}

/**
 * Posible coincidencia entre dos registros (RN-DU02): mismo identificador de operación, o mismo importe + misma cuenta/canal
 * con diferencia ≤ ventana. Importe y día iguales NO bastan para descartar: solo se advierte.
 */
export function duplicateReason(
  a: { amount: string | null; occurredOn: string | null; occurredTime?: string | null; operationRef: string | null; accountId: string | null; channel?: string | null },
  b: { amount: string | null; occurredOn: string | null; occurredTime?: string | null; operationRef: string | null; accountId: string | null; channel?: string | null },
  windowDays = 1,
): 'operation_ref' | 'amount_account_window' | null {
  if (a.operationRef && b.operationRef && a.operationRef === b.operationRef) return 'operation_ref';
  if (!a.amount || !b.amount || a.amount !== b.amount || !a.occurredOn || !b.occurredOn) return null;
  const sameWhere = (a.accountId && b.accountId && a.accountId === b.accountId) || (a.channel && b.channel && a.channel.toLowerCase() === b.channel.toLowerCase());
  if (!sameWhere) return null;
  // Con hora en ambos, la ventana se mide en minutos (24 h reales); si falta alguna, por días.
  if (a.occurredTime && b.occurredTime) return minutesApart(a.occurredOn, a.occurredTime, b.occurredOn, b.occurredTime) <= windowDays * 1440 ? 'amount_account_window' : null;
  return dayDistance(a.occurredOn, b.occurredOn) <= windowDays ? 'amount_account_window' : null;
}

/** Qué falta para poder aceptar (RN-CA06). La categoría puede faltar. */
export function missingForAccept(p: { direction: string; amount: string | null; occurredOn: string | null; accountId: string | null; toAccountId: string | null; currency: string }): string[] {
  const out: string[] = [];
  if (!p.accountId) out.push('accountId');
  if (!p.amount || Number(p.amount) <= 0) out.push('amount');
  if (!p.occurredOn) out.push('occurredOn');
  if (p.currency !== 'PEN') out.push('currency');
  if (p.direction === 'transfer' && (!p.toAccountId || p.toAccountId === p.accountId)) out.push('toAccountId');
  return out;
}
