// Cálculo de préstamos (06 §2, RN-L02…L23, D-20/D-21). Lógica pura sobre céntimos y días enteros.
import { cycleEnd } from './calendar.js';
import { type LocalDate } from './localDate.js';
import { ceilDiv, splitEqual, type Cents } from './money.js';

export type InterestMode = 'none' | 'fixed' | 'percent';
export type InterestBase = 'original' | 'pending';

export interface Terms {
  principal: Cents;
  mode: InterestMode;
  /** Importe fijo por período (modo `fixed`). */
  fixedAmount: Cents | null;
  /** % por período en puntos básicos: 5 % = 500 (modo `percent`). */
  rateBp: number | null;
  base: InterestBase;
  kind: 'installments' | 'final_date' | 'open';
  installments: number | null;
  firstDue: LocalDate | null;
  finalDate: LocalDate | null;
  opened: LocalDate;
}

export interface ChargeDraft {
  concept: 'principal' | 'interest';
  due: LocalDate | null;
  amount: Cents;
  installmentNo: number | null;
  periodNo: number | null;
}

const MONTH = { unit: 'month', count: 1 } as const;

/** Interés de UN período completo: simple, sobre la base elegida; hacia arriba al céntimo (RN-L20, D-20). */
export function interestForPeriod(t: Pick<Terms, 'mode' | 'fixedAmount' | 'rateBp'>, base: Cents): Cents {
  if (t.mode === 'none') return 0n;
  if (t.mode === 'fixed') return t.fixedAmount ?? 0n;
  return ceilDiv(base * BigInt(t.rateBp ?? 0), 10_000n);
}

/** Fin de cada período mensual contado desde `start` (mismo día del mes; el último si no existe). */
export function periodEnds(start: LocalDate, count: number): LocalDate[] {
  const out: LocalDate[] = [];
  let cur = start;
  for (let i = 0; i < count; i++) { cur = cycleEnd(cur, start, MONTH); out.push(cur); }
  return out;
}

/** Cuántos períodos mensuales hacen falta desde `start` para llegar a `end` (mínimo 1). */
export function periodsUntil(start: LocalDate, end: LocalDate): number {
  let n = 0; let cur = start;
  do { cur = cycleEnd(cur, start, MONTH); n++; } while (cur < end && n < 1200);
  return n;
}

/**
 * Cargos acordados desde el inicio. En un plan de cuotas cada cuota lleva su capital y su interés; con fecha final hay un solo
 * capital y un interés por cada período mensual; sin fecha solo hay capital (el interés se devenga mes a mes al consultar).
 */
export function buildSchedule(t: Terms): ChargeDraft[] {
  const out: ChargeDraft[] = [];
  if (t.kind === 'installments') {
    const n = t.installments ?? 1;
    const first = t.firstDue!;
    const parts = splitEqual(t.principal, n);
    let due = first;
    let outstanding = t.principal;
    for (let i = 1; i <= n; i++) {
      out.push({ concept: 'principal', due, amount: parts[i - 1]!, installmentNo: i, periodNo: null });
      const base = t.base === 'original' ? t.principal : outstanding;
      const interest = interestForPeriod(t, base);
      if (interest > 0n) out.push({ concept: 'interest', due, amount: interest, installmentNo: i, periodNo: i });
      outstanding -= parts[i - 1]!;
      due = cycleEnd(due, first, MONTH);
    }
    return out;
  }
  if (t.kind === 'final_date') {
    const fin = t.finalDate!;
    out.push({ concept: 'principal', due: fin, amount: t.principal, installmentNo: 1, periodNo: null });
    if (t.mode !== 'none') {
      const k = periodsUntil(t.opened, fin);
      const ends = periodEnds(t.opened, k);
      ends.forEach((end, idx) => {
        const interest = interestForPeriod(t, t.principal);
        if (interest > 0n) out.push({ concept: 'interest', due: end > fin ? fin : end, amount: interest, installmentNo: null, periodNo: idx + 1 });
      });
    }
    return out;
  }
  out.push({ concept: 'principal', due: null, amount: t.principal, installmentNo: null, periodNo: null });
  return out;
}

/** Interés devengado hasta `asOf` dentro de un período en curso, prorrateo diario base 30 (RN-L22, D-20). Hacia arriba al céntimo. */
export function accruedInPeriod(t: Pick<Terms, 'mode' | 'fixedAmount' | 'rateBp'>, base: Cents, daysElapsed: number): Cents {
  if (daysElapsed <= 0) return 0n;
  const full = interestForPeriod(t, base);
  const days = BigInt(Math.min(daysElapsed, 30));
  return ceilDiv(full * days, 30n);
}

export interface Pending {
  id: string;
  concept: 'principal' | 'interest' | 'late_fee';
  installmentNo: number | null;
  due: LocalDate | null;
  pending: Cents;
}

const ORDER = {
  capital_first: { principal: 0, interest: 1, late_fee: 2 },
  interest_first: { interest: 0, principal: 1, late_fee: 2 },
} as const;

/**
 * Propuesta de reparto de un pago: lo más antiguo primero y, dentro de cada cuota, el orden elegido (capital→interés por defecto,
 * RN-L06). Es solo una propuesta: el administrador elige a qué se aplica (RN-L05). Devuelve también el sobrante.
 */
export function proposeAllocation(items: Pending[], amount: Cents, order: 'capital_first' | 'interest_first'): { allocations: Array<{ id: string; amount: Cents }>; remainder: Cents } {
  const rank = ORDER[order];
  const sorted = [...items].filter((x) => x.pending > 0n).sort((a, b) =>
    (a.due ?? Number.MAX_SAFE_INTEGER) - (b.due ?? Number.MAX_SAFE_INTEGER) || (a.installmentNo ?? 0) - (b.installmentNo ?? 0) || rank[a.concept] - rank[b.concept] || a.id.localeCompare(b.id));
  const allocations: Array<{ id: string; amount: Cents }> = [];
  let left = amount;
  for (const it of sorted) {
    if (left <= 0n) break;
    const take = it.pending < left ? it.pending : left;
    allocations.push({ id: it.id, amount: take });
    left -= take;
  }
  return { allocations, remainder: left };
}

/** Mora personal por período vencido: importe fijo o % sobre la parte vencida (RN-L23, D-21). Hacia arriba al céntimo. */
export function lateFee(mode: 'fixed' | 'percent', amount: Cents | null, rateBp: number | null, overduePending: Cents): Cents {
  if (mode === 'fixed') return amount ?? 0n;
  return ceilDiv(overduePending * BigInt(rateBp ?? 0), 10_000n);
}
