import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { baseDays, cycleEnd, generateCycles, verifyCalendar, type Interval, type TermsVersion } from '../../src/domain/calendar.js';
import { DateError, daysInMonth, formatISO, fromYMD, parseISO, toYMD, todayIn } from '../../src/domain/localDate.js';

const d = parseISO;
const iso = formatISO;
const MONTH: Interval = { unit: 'month', count: 1 };

/** Encadena `n` fines de ciclo partiendo de `start`, con ancla fija. */
function chain(start: string, anchor: string, iv: Interval, n: number): string[] {
  const out: string[] = [];
  let s = d(start);
  for (let i = 0; i < n; i++) {
    s = cycleEnd(s, d(anchor), iv);
    out.push(iso(s));
  }
  return out;
}

describe('LocalDate', () => {
  it('ida y vuelta y validación estricta', () => {
    expect(iso(d('2026-10-07'))).toBe('2026-10-07');
    expect(toYMD(fromYMD(2028, 2, 29))).toEqual({ y: 2028, m: 2, d: 29 });
    expect(() => parseISO('2026-02-29')).toThrow(DateError);
    expect(() => parseISO('2026-13-01')).toThrow(DateError);
    expect(() => parseISO('07/10/2026')).toThrow(DateError);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(d('2026-11-07') - d('2026-10-07')).toBe(31);
  });
  it('todayIn usa la zona horaria del propietario (Lima = UTC−5)', () => {
    const lateUtc = new Date('2026-10-13T03:30:00Z'); // en Lima son las 22:30 del día 12
    expect(iso(todayIn('America/Lima', lateUtc))).toBe('2026-10-12');
    expect(iso(todayIn('UTC', lateUtc))).toBe('2026-10-13');
  });
});

describe('cycleEnd: casos dorados 04 §10.4 (D-02)', () => {
  it('ancla 31, mensual, desde 31-ene-2026', () => {
    expect(chain('2026-01-31', '2026-01-31', MONTH, 4)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  });
  it('ancla 30, mensual, desde 30-ene-2026', () => {
    expect(chain('2026-01-30', '2026-01-30', MONTH, 2)).toEqual(['2026-02-28', '2026-03-30']);
  });
  it('ancla 31 en año bisiesto', () => {
    expect(chain('2028-01-31', '2028-01-31', MONTH, 2)).toEqual(['2028-02-29', '2028-03-31']);
  });
  it('anual con ancla 29-feb', () => {
    expect(chain('2028-02-29', '2028-02-29', { unit: 'year', count: 1 }, 4)).toEqual(['2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
  });
  it('semanal y personalizados', () => {
    expect(chain('2026-10-07', '2026-10-07', { unit: 'week', count: 1 }, 2)).toEqual(['2026-10-14', '2026-10-21']);
    expect(chain('2026-10-01', '2026-10-01', { unit: 'day', count: 15 }, 2)).toEqual(['2026-10-16', '2026-10-31']);
    expect(chain('2026-01-31', '2026-01-31', { unit: 'month', count: 2 }, 2)).toEqual(['2026-03-31', '2026-05-31']);
  });
  it('el cálculo parte del ancla: no deriva a 28 después de febrero', () => {
    const ends = chain('2026-01-31', '2026-01-31', MONTH, 3);
    expect(ends[2]).toBe('2026-04-30'); // no "28-abr"
  });
  it('rechaza intervalos inválidos', () => {
    expect(() => cycleEnd(d('2026-10-07'), d('2026-10-07'), { unit: 'month', count: 0 })).toThrow(RangeError);
  });
  it('propiedad: el fin es posterior al inicio y el día nunca excede el mes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2020, max: 2040 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }),
        fc.integer({ min: 1, max: 31 }), fc.integer({ min: 1, max: 12 }), fc.constantFrom('day', 'week', 'month', 'year'),
        (y, m, dd, anchorDay, count, unit) => {
          const start = fromYMD(y, m, dd);
          const anchor = fromYMD(2026, 1, anchorDay);
          const end = cycleEnd(start, anchor, { unit, count } as Interval);
          expect(end).toBeGreaterThan(start);
          const e = toYMD(end);
          expect(e.d).toBeLessThanOrEqual(daysInMonth(e.y, e.m));
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe('baseDays (04 §4, D-03)', () => {
  it('mensual 30, semanal 7, anual y personalizado = días reales del ciclo', () => {
    expect(baseDays(MONTH, d('2026-01-07'), d('2026-02-07'))).toBe(30);
    expect(baseDays({ unit: 'week', count: 1 }, d('2026-10-07'), d('2026-10-14'))).toBe(7);
    expect(baseDays({ unit: 'year', count: 1 }, d('2028-01-01'), d('2029-01-01'))).toBe(366);
    expect(baseDays({ unit: 'year', count: 1 }, d('2026-01-01'), d('2027-01-01'))).toBe(365);
    expect(baseDays({ unit: 'month', count: 2 }, d('2026-01-31'), d('2026-03-31'))).toBe(59);
  });
});

describe('verifyCalendar (RN-C03)', () => {
  it('coincide', () => {
    expect(verifyCalendar(d('2026-10-07'), d('2026-11-07'), MONTH)).toMatchObject({ ok: true, diffDays: 0 });
    expect(verifyCalendar(d('2026-10-07'), d('2026-10-14'), { unit: 'week', count: 1 }).ok).toBe(true);
  });
  it('difiere: informa la diferencia en días', () => {
    const v = verifyCalendar(d('2026-10-07'), d('2026-11-09'), MONTH);
    expect(v.ok).toBe(false);
    expect(v.diffDays).toBe(2);
    expect(verifyCalendar(d('2026-10-07'), d('2026-10-14'), MONTH).diffDays).toBe(-24);
  });
});

describe('generateCycles (RN-C01, RN-C11)', () => {
  const terms: TermsVersion[] = [
    { validFrom: d('2026-10-07'), validTo: null, announcedPrice: 4500n, interval: MONTH, anchor: d('2026-11-07') },
  ];
  const base = { terms, firstStart: d('2026-10-07'), firstEnd: d('2026-11-07') };

  it('crea el ciclo en curso y uno futuro', () => {
    const out = generateCycles({ ...base, existing: [], today: d('2026-10-12') });
    expect(out.map((c) => [c.seq, iso(c.start), iso(c.end)])).toEqual([
      [1, '2026-10-07', '2026-11-07'],
      [2, '2026-11-07', '2026-12-07'],
    ]);
    expect(out[0]!.termsSnapshot).toMatchObject({ announcedPrice: 4500n, baseDays: 30 });
  });

  it('es idempotente: con los ciclos ya persistidos no devuelve nada (M05)', () => {
    const first = generateCycles({ ...base, existing: [], today: d('2026-10-12') });
    const again = generateCycles({ ...base, existing: first.map(({ seq, start, end }) => ({ seq, start, end })), today: d('2026-10-12') });
    expect(again).toEqual([]);
  });

  it('avanza con el tiempo sin dejar huecos ni solapes (M04)', () => {
    const t0 = generateCycles({ ...base, existing: [], today: d('2026-10-12') });
    const t1 = generateCycles({ ...base, existing: t0, today: d('2027-01-20') });
    const all = [...t0, ...t1];
    for (let i = 1; i < all.length; i++) expect(all[i]!.start).toBe(all[i - 1]!.end);
    expect(all.map((c) => c.seq)).toEqual(all.map((_, i) => i + 1));
    expect(all.at(-1)!.start).toBeGreaterThan(d('2027-01-20'));
  });

  it('con ancla 31 los ciclos siguen la fecha real del proveedor', () => {
    const t: TermsVersion[] = [{ validFrom: d('2026-01-31'), validTo: null, announcedPrice: 1000n, interval: MONTH, anchor: d('2026-02-28') }];
    // El proveedor informó 28-feb como siguiente pago: el ancla pasa a ser el 28.
    const out = generateCycles({ terms: t, firstStart: d('2026-01-31'), firstEnd: d('2026-02-28'), existing: [], today: d('2026-02-10') });
    expect(out.map((c) => iso(c.end))).toEqual(['2026-02-28', '2026-03-28']);
  });

  it('propiedad: sin huecos ni solapes para cualquier "hoy"', () => {
    fc.assert(
      fc.property(fc.integer({ min: d('2026-10-01'), max: d('2030-12-31') }), fc.integer({ min: 1, max: 3 }), (today, ahead) => {
        const out = generateCycles({ ...base, existing: [], today, ahead });
        for (let i = 1; i < out.length; i++) expect(out[i]!.start).toBe(out[i - 1]!.end);
        expect(out.every((c) => c.end > c.start)).toBe(true);
        expect(out.filter((c) => c.start > today).length).toBeGreaterThanOrEqual(ahead);
      }),
      { numRuns: 300 },
    );
  });
});
