// Cobros, aplicaciones y crédito (04 §7; RN-R01…R09).
import { type Cents } from './money.js';

export interface ReceiptAvailability {
  received: Cents;
  applied: Cents;
  refunded: Cents;
  reserved: Cents;
  unapplied: Cents; // received − applied − refunded
  free: Cents; // unapplied − reserved
}

export function availability(i: { received: Cents; applied: Cents; refunded: Cents; reserved: Cents }): ReceiptAvailability {
  const unapplied = i.received - i.applied - i.refunded;
  return { ...i, unapplied, free: unapplied - i.reserved };
}

export interface AllocationRequest {
  obligationId: string;
  amount: Cents;
  pending: Cents; // pendiente actual de la obligación
}

export type AllocationIssue =
  | { code: 'NON_POSITIVE'; obligationId: string }
  | { code: 'EXCEEDS_OBLIGATION'; obligationId: string; pending: Cents; requested: Cents }
  | { code: 'DUPLICATE_OBLIGATION'; obligationId: string }
  | { code: 'EXCEEDS_RECEIPT'; available: Cents; requested: Cents };

/**
 * Valida un reparto contra el importe disponible del cobro (RN-R04). Devuelve los problemas (vacío = válido).
 * `available` = lo que el cobro todavía puede aplicar (unapplied).
 */
export function validateAllocations(available: Cents, requests: AllocationRequest[]): AllocationIssue[] {
  const issues: AllocationIssue[] = [];
  const seen = new Set<string>();
  let sum = 0n;
  for (const r of requests) {
    if (seen.has(r.obligationId)) issues.push({ code: 'DUPLICATE_OBLIGATION', obligationId: r.obligationId });
    seen.add(r.obligationId);
    if (r.amount <= 0n) issues.push({ code: 'NON_POSITIVE', obligationId: r.obligationId });
    else if (r.amount > r.pending) issues.push({ code: 'EXCEEDS_OBLIGATION', obligationId: r.obligationId, pending: r.pending, requested: r.amount });
    sum += r.amount > 0n ? r.amount : 0n;
  }
  if (sum > available) issues.push({ code: 'EXCEEDS_RECEIPT', available, requested: sum });
  return issues;
}

export interface Suggestible {
  obligationId: string;
  pending: Cents;
  dueDate: number; // LocalDate
  createdAt: number;
}

/** Sugerencia no obligatoria (D-10): vencimiento más antiguo primero; asigna min(pendiente, restante). */
export function suggestAllocation(amount: Cents, items: Suggestible[]): Array<{ obligationId: string; amount: Cents }> {
  const sorted = [...items].sort((a, b) => a.dueDate - b.dueDate || a.createdAt - b.createdAt);
  let left = amount;
  const out: Array<{ obligationId: string; amount: Cents }> = [];
  for (const it of sorted) {
    if (left <= 0n) break;
    if (it.pending <= 0n) continue;
    const take = left < it.pending ? left : it.pending;
    out.push({ obligationId: it.obligationId, amount: take });
    left -= take;
  }
  return out;
}

export type PaymentStatus = 'exempt' | 'unpaid' | 'partial' | 'paid' | 'converted';

/** Estado de pago derivado (RN-CH05); no se almacena. */
export function paymentStatus(i: { issued: Cents; adjustments: Cents; applied: Cents; converted: Cents }): PaymentStatus {
  const total = i.issued + i.adjustments;
  const pending = total - i.applied - i.converted;
  if (total === 0n) return 'exempt';
  if (i.converted > 0n && pending === 0n) return 'converted';
  if (pending === 0n) return 'paid';
  if (i.applied === 0n) return 'unpaid';
  return 'partial';
}
