import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseISO } from './localDate.js';

// Esquema de salida de la extracción (07 §6). El servidor lo valida antes de proponer nada: lo que no cumpla → `Fallido`.
const money = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'importe decimal con punto y hasta 2 decimales');
const text = z.string().trim().max(300).nullable().optional().transform((v) => (v ? v : null));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => { try { parseISO(s); return true; } catch { return false; } }, 'fecha inexistente');

export const extractedMovement = z.object({
  direction: z.enum(['income', 'expense', 'transfer']),
  amount: money.nullable().optional().transform((v) => v ?? null),
  currency: z.string().length(3).default('PEN'),
  occurredOn: isoDate.nullable().optional().transform((v) => v ?? null),
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

/**
 * Posible coincidencia entre dos registros (RN-DU02): mismo identificador de operación, o mismo importe + misma cuenta/canal
 * con diferencia ≤ ventana. Importe y día iguales NO bastan para descartar: solo se advierte.
 */
export function duplicateReason(
  a: { amount: string | null; occurredOn: string | null; operationRef: string | null; accountId: string | null; channel?: string | null },
  b: { amount: string | null; occurredOn: string | null; operationRef: string | null; accountId: string | null; channel?: string | null },
  windowDays = 1,
): 'operation_ref' | 'amount_account_window' | null {
  if (a.operationRef && b.operationRef && a.operationRef === b.operationRef) return 'operation_ref';
  if (!a.amount || !b.amount || a.amount !== b.amount || !a.occurredOn || !b.occurredOn) return null;
  const sameWhere = (a.accountId && b.accountId && a.accountId === b.accountId) || (a.channel && b.channel && a.channel.toLowerCase() === b.channel.toLowerCase());
  return sameWhere && dayDistance(a.occurredOn, b.occurredOn) <= windowDays ? 'amount_account_window' : null;
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
