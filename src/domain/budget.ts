// Períodos y niveles de aviso de un presupuesto (05 §4). Lógica pura sobre días enteros.
import { daysInMonth, fromYMD, toYMD, type LocalDate } from './localDate.js';

export type BudgetPeriod = 'weekly' | 'monthly' | 'yearly';

export interface Period { start: LocalDate; end: LocalDate } // end inclusive

/** Semana de lunes a domingo. El 1-ene-1970 fue jueves: el lunes de una fecha es d − ((d + 3) mod 7). */
const mondayOf = (d: LocalDate) => d - (((d + 3) % 7) + 7) % 7;

/** Período que contiene `date`: mes calendario, semana de lunes a domingo o año calendario. */
export function periodOf(date: LocalDate, kind: BudgetPeriod): Period {
  const { y, m } = toYMD(date);
  if (kind === 'weekly') { const s = mondayOf(date); return { start: s, end: s + 6 }; }
  if (kind === 'yearly') return { start: fromYMD(y, 1, 1), end: fromYMD(y, 12, 31) };
  return { start: fromYMD(y, m, 1), end: fromYMD(y, m, daysInMonth(y, m)) };
}

export const previousPeriod = (p: Period, kind: BudgetPeriod): Period => periodOf(p.start - 1, kind);
export const nextPeriod = (p: Period, kind: BudgetPeriod): Period => periodOf(p.end + 1, kind);

/** Del primer período al que contiene `until`, en orden cronológico (máximo `cap` períodos). */
export function periodsFrom(first: LocalDate, until: LocalDate, kind: BudgetPeriod, cap = 600): Period[] {
  const out: Period[] = [];
  let p = periodOf(first, kind);
  while (p.start <= until && out.length < cap) { out.push(p); p = nextPeriod(p, kind); }
  return out;
}

export interface Level { percent: number | null; reached: number[]; level: number | null; exceeded: boolean }

/** Cuánto del límite disponible se consumió y qué avisos se cruzaron (en céntimos). Los avisos no bloquean nada. */
export function levelOf(spent: bigint, available: bigint, thresholds: number[]): Level {
  if (available <= 0n) return { percent: null, reached: spent > 0n ? thresholds.slice().sort((a, b) => a - b) : [], level: spent > 0n ? Math.max(0, ...thresholds) || null : null, exceeded: spent > 0n };
  const reached = thresholds.filter((t) => spent * 100n >= BigInt(t) * available).sort((a, b) => a - b);
  return { percent: Number((spent * 1000n) / available) / 10, reached, level: reached.length ? reached[reached.length - 1]! : null, exceeded: spent > available };
}

/** Arrastre al siguiente período: solo el saldo no gastado POSITIVO, con tope opcional; el exceso nunca se arrastra como deuda (RN-BU05, D-28). */
export function carryOver(available: bigint, spent: bigint, cap: bigint | null): bigint {
  const left = available - spent;
  if (left <= 0n) return 0n;
  return cap !== null && left > cap ? cap : left;
}
