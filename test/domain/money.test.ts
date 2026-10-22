import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ceilDiv, ceilToSol, distribute, formatMoney, MoneyError, parseMoney, splitEqual } from '../../src/domain/money.js';

describe('dinero en céntimos', () => {
  it('parseMoney y formatMoney son inversos y exactos', () => {
    expect(parseMoney('20.00')).toBe(2000n);
    expect(parseMoney('20')).toBe(2000n);
    expect(parseMoney('0.5')).toBe(50n);
    expect(parseMoney('10.25')).toBe(1025n);
    expect(formatMoney(1025n)).toBe('10.25');
    expect(formatMoney(5n)).toBe('0.05');
    expect(formatMoney(-14700n)).toBe('-147.00');
  });

  it('rechaza formatos inválidos (M12)', () => {
    for (const bad of ['', '1.234', '1e3', ' 1', '1,5', '--1', '.5', 'abc', '1.']) {
      expect(() => parseMoney(bad), bad).toThrow(MoneyError);
    }
    expect(() => parseMoney('-1')).toThrow(MoneyError); // sin allowNegative
    expect(parseMoney('-100.00', { allowNegative: true })).toBe(-10000n);
  });

  it('ceilDiv y ceilToSol', () => {
    expect(ceilDiv(7n, 2n)).toBe(4n);
    expect(ceilDiv(8n, 2n)).toBe(4n);
    expect(ceilDiv(0n, 5n)).toBe(0n);
    expect(ceilToSol(701n)).toBe(800n);
    expect(ceilToSol(700n)).toBe(700n);
    expect(ceilToSol(1n)).toBe(100n);
    expect(ceilToSol(0n)).toBe(0n);
    expect(() => ceilDiv(1n, 0n)).toThrow(MoneyError);
  });

  it('distribute: casos dorados 04 §10.6 (D-04)', () => {
    expect(distribute(1000n, [1n, 1n, 1n])).toEqual([334n, 333n, 333n]);
    expect(distribute(1000n, [1n, 2n])).toEqual([333n, 667n]);
    expect(distribute(1n, [1n, 1n])).toEqual([1n, 0n]);
    expect(distribute(0n, [3n, 4n])).toEqual([0n, 0n]);
    expect(splitEqual(1000n, 3)).toEqual([334n, 333n, 333n]);
  });

  it('distribute: ejemplo de S/ 10.00 entre 3', () => {
    expect(splitEqual(1000n, 3).map(formatMoney)).toEqual(['3.34', '3.33', '3.33']);
  });

  it('propiedad: Σ distribute = total, nunca negativo, determinista', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.array(fc.bigInt({ min: 0n, max: 1000n }), { minLength: 1, maxLength: 12 }).filter((w) => w.some((x) => x > 0n)),
        (total, weights) => {
          const parts = distribute(total, weights);
          expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
          expect(parts.every((p) => p >= 0n)).toBe(true);
          expect(distribute(total, weights)).toEqual(parts);
        },
      ),
      { numRuns: 1500 },
    );
  });

  it('propiedad: ceilToSol es múltiplo de 100, ≥ el valor y < valor + 100', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1_000_000_000n }), (c) => {
        const r = ceilToSol(c);
        expect(r % 100n).toBe(0n);
        expect(r >= c).toBe(true);
        expect(r - c < 100n).toBe(true);
      }),
      { numRuns: 1500 },
    );
  });
});
