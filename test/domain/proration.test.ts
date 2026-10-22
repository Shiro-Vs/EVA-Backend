import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { proratedJoin, JoinError, suggestedQuota } from '../../src/domain/proration.js';
import { formatMoney, parseMoney } from '../../src/domain/money.js';
import { parseISO as d } from '../../src/domain/localDate.js';

// Ciclo estándar 7-oct → 7-nov (31 días), base mensual 30. `r` días restantes ⇒ ingreso = fin − r.
const START = d('2026-10-07');
const END = d('2026-11-07');
const join = (r: number, quota: string, g: number, end = END, base = 30) =>
  proratedJoin({ quota: parseMoney(quota), cycleStart: START, cycleEnd: end, joinDate: end - r, freeDaysThreshold: g, baseDays: base });

describe('proratedJoin: tabla 04 §10.1 (cuota 20, base 30, g 7)', () => {
  const table: Array<[r: number, prorated: string, mode: string, net: string]> = [
    [1, '1.00', 'trial_free', '0.00'],
    [5, '4.00', 'trial_free', '0.00'], // A03
    [7, '5.00', 'trial_free', '0.00'], // igualdad con el umbral
    [8, '6.00', 'partial_charged', '6.00'],
    [12, '8.00', 'partial_charged', '8.00'], // A04
    [15, '10.00', 'partial_charged', '10.00'],
    [30, '20.00', 'partial_charged', '20.00'],
  ];
  it.each(table)('r=%i → prorrateo %s, %s, neto %s', (r, prorated, mode, net) => {
    const j = join(r, '20.00', 7);
    expect(formatMoney(j.prorated)).toBe(prorated);
    expect(j.mode).toBe(mode);
    expect(formatMoney(j.net)).toBe(net);
    expect(j.remainingDays).toBe(r);
    expect(j.dueDate).toBe(END - r); // vence el día del ingreso (RN-I05)
  });

  it('tramo gratis: exención = bruto, nunca negativo (A03)', () => {
    const j = join(5, '20.00', 7);
    expect([j.gross, j.exemption, j.net]).toEqual([400n, 400n, 0n]);
  });

  it('r=31 con un ciclo de 32 días: prorrateo 21 → tope 20 + advertencia (D-06)', () => {
    const j = join(31, '20.00', 7, END + 1);
    expect(formatMoney(j.prorated)).toBe('21.00');
    expect(formatMoney(j.gross)).toBe('20.00');
    expect(j.warnings).toEqual(['TRAMO_EXCEDE_CICLO']);
    expect(formatMoney(j.net)).toBe('20.00');
  });

  it('ingreso en la renovación: ciclo completo, sin 31/30 (A05)', () => {
    const j = proratedJoin({ quota: 2000n, cycleStart: d('2027-01-07'), cycleEnd: d('2027-02-07'), joinDate: d('2027-01-07'), freeDaysThreshold: 7, baseDays: 30 });
    expect(j.mode).toBe('full_cycle');
    expect(formatMoney(j.net)).toBe('20.00');
    expect(j.prorated).toBe(0n);
    expect(j.warnings).toEqual([]);
  });
});

describe('proratedJoin: tabla 04 §10.2', () => {
  it('otras cuotas y frecuencias', () => {
    expect(formatMoney(join(12, '10.00', 7).net)).toBe('4.00');
    expect(formatMoney(join(10, '12.00', 7).net)).toBe('4.00');
    expect(formatMoney(join(10, '11.50', 7).net)).toBe('4.00'); // 3.83 ↑
    expect(formatMoney(join(8, '7.00', 2).net)).toBe('2.00'); // 1.87 ↑
    expect(formatMoney(join(29, '9.00', 7).net)).toBe('9.00'); // 8.7 ↑ = cuota
  });
  it('semanal (B=7)', () => {
    const j = proratedJoin({ quota: 500n, cycleStart: d('2026-10-07'), cycleEnd: d('2026-10-14'), joinDate: d('2026-10-11'), freeDaysThreshold: 2, baseDays: 7 });
    expect(j.remainingDays).toBe(3);
    expect(formatMoney(j.net)).toBe('3.00');
  });
  it('anual con base = días reales del ciclo (D-03)', () => {
    const mk = (cs: string, ce: string, jd: string) =>
      proratedJoin({ quota: 12000n, cycleStart: d(cs), cycleEnd: d(ce), joinDate: d(jd), freeDaysThreshold: 30, baseDays: d(ce) - d(cs) });
    const a = mk('2026-01-01', '2027-01-01', '2026-09-23'); // r = 100, 365 días
    expect(a.remainingDays).toBe(100);
    expect(formatMoney(a.net)).toBe('33.00');
    const b = mk('2028-01-01', '2029-01-01', '2028-09-23'); // r = 100, 366 días
    expect(b.remainingDays).toBe(100);
    expect(formatMoney(b.net)).toBe('33.00');
  });
});

describe('proratedJoin: errores', () => {
  it('fecha fuera del ciclo', () => {
    expect(() => join(0, '20.00', 7)).toThrow(JoinError);
    expect(() => proratedJoin({ quota: 2000n, cycleStart: START, cycleEnd: END, joinDate: START - 1, freeDaysThreshold: 7, baseDays: 30 })).toThrow(/ciclo vigente/);
  });
});

describe('proratedJoin: propiedades', () => {
  const arb = fc.record({
    quota: fc.bigInt({ min: 0n, max: 100_000n }),
    r: fc.integer({ min: 1, max: 30 }),
    g: fc.integer({ min: 0, max: 40 }),
  });
  it('0 ≤ neto ≤ cuota y bruto ≤ cuota siempre', () => {
    fc.assert(
      fc.property(arb, ({ quota, r, g }) => {
        const j = join(r, formatMoney(quota), g);
        expect(j.net >= 0n && j.net <= quota).toBe(true);
        expect(j.gross <= quota).toBe(true);
        expect(j.net).toBe(j.gross - j.exemption);
      }),
      { numRuns: 2000 },
    );
  });
  it('el cobro es monótono no decreciente en r (con g=0)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 100_000n }), (quota) => {
        let prev = -1n;
        for (let r = 1; r <= 30; r++) {
          const net = join(r, formatMoney(quota), 0).net;
          expect(net >= prev).toBe(true);
          prev = net;
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('suggestedQuota: tabla 04 §10.3 (D-07)', () => {
  it.each([
    ['45.00', 4, '12.00'], ['45.00', 5, '9.00'], ['47.00', 4, '12.00'], ['30.00', 3, '10.00'], ['17.99', 3, '6.00'], ['45.00', 1, '45.00'],
  ])('precio %s entre %i plazas → %s', (price, seats, expected) => {
    expect(formatMoney(suggestedQuota(parseMoney(price), seats))).toBe(expected);
  });
  it('rechaza cero plazas', () => {
    expect(() => suggestedQuota(4500n, 0)).toThrow(RangeError);
  });
});
