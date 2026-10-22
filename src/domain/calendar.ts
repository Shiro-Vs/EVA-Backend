// Calendario de ciclos (04 §2, §4). Ciclo = [inicio, fin): inicio incluido, fin excluido.
import { daysInMonth, diffDays, fromYMD, isLeap, toYMD, type LocalDate } from './localDate.js';

export interface Interval {
  unit: 'day' | 'week' | 'month' | 'year';
  count: number; // ≥ 1
}

export interface TermsVersion {
  validFrom: LocalDate;
  validTo: LocalDate | null; // excluido
  announcedPrice: bigint;
  interval: Interval;
  anchor: LocalDate; // última fecha confirmada por el proveedor
}

export interface CyclePlan {
  seq: number;
  start: LocalDate;
  end: LocalDate;
  termsSnapshot: { announcedPrice: bigint; interval: Interval; anchor: LocalDate; baseDays: number };
}

/** Fin del ciclo que empieza en `start`. Para meses/años se calcula desde el ancla (no desde la fecha anterior): D-02. */
export function cycleEnd(start: LocalDate, anchor: LocalDate, iv: Interval): LocalDate {
  if (!Number.isInteger(iv.count) || iv.count < 1) throw new RangeError('El intervalo debe ser un entero ≥ 1');
  switch (iv.unit) {
    case 'day':
      return start + iv.count;
    case 'week':
      return start + 7 * iv.count;
    case 'month': {
      const s = toYMD(start);
      const idx = s.m - 1 + iv.count;
      const y = s.y + Math.floor(idx / 12);
      const m1 = (idx % 12) + 1;
      return fromYMD(y, m1, Math.min(toYMD(anchor).d, daysInMonth(y, m1)));
    }
    case 'year': {
      const s = toYMD(start);
      const a = toYMD(anchor);
      const y = s.y + iv.count;
      const d = a.m === 2 && a.d === 29 && !isLeap(y) ? 28 : a.d;
      return fromYMD(y, a.m, d);
    }
  }
}

/** Base de prorrateo B (04 §4): mensual 30, semanal 7, resto = días reales del ciclo. */
export function baseDays(iv: Interval, start: LocalDate, end: LocalDate): number {
  if (iv.unit === 'month' && iv.count === 1) return 30;
  if (iv.unit === 'week' && iv.count === 1) return 7;
  return diffDays(end, start);
}

export interface CalendarCheck {
  ok: boolean;
  expected: LocalDate;
  diffDays: number; // informado − esperado
}

/** Verificación del alta (RN-C03): inicio + intervalo debe coincidir con el siguiente pago informado. */
export function verifyCalendar(start: LocalDate, nextPayment: LocalDate, iv: Interval): CalendarCheck {
  const expected = cycleEnd(start, start, iv);
  return { ok: expected === nextPayment, expected, diffDays: diffDays(nextPayment, expected) };
}

const termsAt = (terms: TermsVersion[], d: LocalDate): TermsVersion => {
  const t = terms.find((x) => d >= x.validFrom && (x.validTo === null || d < x.validTo));
  if (!t) throw new RangeError('No hay términos vigentes para la fecha del ciclo');
  return t;
};

export interface ExistingCycle {
  seq: number;
  start: LocalDate;
  end: LocalDate;
}

/**
 * Devuelve SOLO los ciclos nuevos necesarios para que existan el ciclo en curso y `ahead` ciclos futuros.
 * Idempotente: llamarla de nuevo con los ciclos ya persistidos devuelve [] (RN-C11).
 */
export function generateCycles(input: {
  terms: TermsVersion[];
  firstStart: LocalDate;
  firstEnd: LocalDate;
  existing: ExistingCycle[];
  today: LocalDate;
  ahead?: number;
}): CyclePlan[] {
  const ahead = input.ahead ?? 1;
  const out: CyclePlan[] = [];
  const all: ExistingCycle[] = [...input.existing].sort((a, b) => a.start - b.start);
  const mk = (seq: number, start: LocalDate, end: LocalDate): CyclePlan => {
    const t = termsAt(input.terms, start);
    return { seq, start, end, termsSnapshot: { announcedPrice: t.announcedPrice, interval: t.interval, anchor: t.anchor, baseDays: baseDays(t.interval, start, end) } };
  };

  if (all.length === 0) {
    const first = mk(1, input.firstStart, input.firstEnd);
    out.push(first);
    all.push({ seq: 1, start: first.start, end: first.end });
  }

  const futureCount = () => all.filter((c) => c.start > input.today).length;
  let guard = 0;
  while (futureCount() < ahead || all[all.length - 1]!.end <= input.today) {
    if (++guard > 2000) throw new RangeError('Demasiados ciclos por generar: revisa las fechas del servicio');
    const last = all[all.length - 1]!;
    const t = termsAt(input.terms, last.end);
    const next = mk(last.seq + 1, last.end, cycleEnd(last.end, t.anchor, t.interval));
    out.push(next);
    all.push({ seq: next.seq, start: next.start, end: next.end });
  }
  return out;
}
