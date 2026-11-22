// Calendario de una tarjeta de crédito (06 §4, RN-T02/T06). Lógica pura sobre días enteros.
import { daysInMonth, fromYMD, toYMD, type LocalDate } from './localDate.js';

const clamp = (y: number, m: number, d: number): LocalDate => fromYMD(y, m, Math.min(d, daysInMonth(y, m)));
const nextMonth = (y: number, m: number) => (m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 });

/** Primer corte que cae en o después de `date`: una compra hecha el día del corte entra en ese estado de cuenta. */
export function nextCutoff(date: LocalDate, cutoffDay: number): LocalDate {
  const { y, m } = toYMD(date);
  const same = clamp(y, m, cutoffDay);
  if (same >= date) return same;
  const n = nextMonth(y, m);
  return clamp(n.y, n.m, cutoffDay);
}

/** Próxima fecha límite de pago en o después de `date` (días 29–31 se ajustan al último día del mes). */
export function nextDueDate(date: LocalDate, dueDay: number): LocalDate {
  const { y, m } = toYMD(date);
  const same = clamp(y, m, dueDay);
  if (same >= date) return same;
  const n = nextMonth(y, m);
  return clamp(n.y, n.m, dueDay);
}

/** Fecha límite de pago de un corte: el primer día `dueDay` estrictamente posterior al corte (corte ≠ pago). */
export function dueAfter(cutoff: LocalDate, dueDay: number): LocalDate {
  const { y, m } = toYMD(cutoff);
  const same = clamp(y, m, dueDay);
  if (same > cutoff) return same;
  const n = nextMonth(y, m);
  return clamp(n.y, n.m, dueDay);
}

export interface CardWindow { cutoff: LocalDate; due: LocalDate; daysToCutoff: number; daysToPay: number }

/** Qué estado de cuenta recibe una compra hecha en `date` y cuántos días hay hasta pagarla. */
export function cardWindow(date: LocalDate, cutoffDay: number, dueDay: number): CardWindow {
  const cutoff = nextCutoff(date, cutoffDay);
  const due = dueAfter(cutoff, dueDay);
  return { cutoff, due, daysToCutoff: cutoff - date, daysToPay: due - date };
}
