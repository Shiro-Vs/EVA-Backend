import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { availability, paymentStatus, suggestAllocation, validateAllocations } from '../../src/domain/allocation.js';
import { costSummary } from '../../src/domain/costs.js';
import { formatMoney } from '../../src/domain/money.js';

describe('availability', () => {
  it('crédito libre = recibido − aplicado − devuelto − reservado (RN-R09)', () => {
    expect(availability({ received: 3000n, applied: 2000n, refunded: 0n, reserved: 1000n })).toEqual({
      received: 3000n, applied: 2000n, refunded: 0n, reserved: 1000n, unapplied: 1000n, free: 0n,
    });
    expect(availability({ received: 3000n, applied: 2000n, refunded: 400n, reserved: 0n }).free).toBe(600n);
  });
});

describe('validateAllocations (RN-R04)', () => {
  const ok = [{ obligationId: 'a', amount: 2000n, pending: 2000n }, { obligationId: 'b', amount: 2000n, pending: 4000n }];
  it('un reparto válido no tiene problemas (A07)', () => {
    expect(validateAllocations(5000n, [...ok, { obligationId: 'c', amount: 1000n, pending: 1000n }])).toEqual([]);
  });
  it('la suma no puede superar lo disponible (A28a)', () => {
    expect(validateAllocations(3000n, ok)).toEqual([{ code: 'EXCEEDS_RECEIPT', available: 3000n, requested: 4000n }]);
  });
  it('una aplicación no puede superar el pendiente', () => {
    expect(validateAllocations(9000n, [{ obligationId: 'a', amount: 2500n, pending: 2000n }])).toEqual([
      { code: 'EXCEEDS_OBLIGATION', obligationId: 'a', pending: 2000n, requested: 2500n },
    ]);
  });
  it('importes no positivos y obligaciones repetidas', () => {
    const issues = validateAllocations(9000n, [{ obligationId: 'a', amount: 0n, pending: 100n }, { obligationId: 'a', amount: 50n, pending: 100n }]);
    expect(issues.map((i) => i.code).sort()).toEqual(['DUPLICATE_OBLIGATION', 'NON_POSITIVE']);
  });
});

describe('suggestAllocation (D-10)', () => {
  it('vencimiento más antiguo primero, sin exceder pendiente ni importe', () => {
    const r = suggestAllocation(2500n, [
      { obligationId: 'late', pending: 1200n, dueDate: 30, createdAt: 1 },
      { obligationId: 'old', pending: 800n, dueDate: 10, createdAt: 1 },
      { obligationId: 'mid', pending: 1000n, dueDate: 20, createdAt: 1 },
    ]);
    expect(r).toEqual([{ obligationId: 'old', amount: 800n }, { obligationId: 'mid', amount: 1000n }, { obligationId: 'late', amount: 700n }]);
  });
  it('propiedad: Σ ≤ importe y cada parte ≤ pendiente', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 100_000n }),
        fc.array(fc.record({ pending: fc.bigInt({ min: 0n, max: 50_000n }), dueDate: fc.integer({ min: 0, max: 60 }) }), { maxLength: 10 }),
        (amount, items) => {
          const its = items.map((x, i) => ({ obligationId: `o${i}`, pending: x.pending, dueDate: x.dueDate, createdAt: i }));
          const out = suggestAllocation(amount, its);
          expect(out.reduce((a, b) => a + b.amount, 0n) <= amount).toBe(true);
          for (const o of out) expect(o.amount <= its.find((x) => x.obligationId === o.obligationId)!.pending).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('paymentStatus (RN-CH05)', () => {
  it.each([
    ['sin importe', { issued: 0n, adjustments: 0n, applied: 0n, converted: 0n }, 'exempt'],
    ['sin pagos', { issued: 2000n, adjustments: 0n, applied: 0n, converted: 0n }, 'unpaid'],
    ['pago parcial', { issued: 2000n, adjustments: 0n, applied: 1000n, converted: 0n }, 'partial'],
    ['pagado', { issued: 2000n, adjustments: 0n, applied: 2000n, converted: 0n }, 'paid'],
    ['subida de cuota con ajuste (A08b)', { issued: 2000n, adjustments: 200n, applied: 2000n, converted: 0n }, 'partial'], // subida de cuota (A08b)
    ['convertido a préstamo', { issued: 2000n, adjustments: 0n, applied: 500n, converted: 1500n }, 'converted'],
  ] as const)('%s', (_name, input, expected) => {
    expect(paymentStatus({ ...input })).toBe(expected);
  });
});

describe('costSummary (A18, RN-F04…F08)', () => {
  it('pago 47, exigibles 34, cobrados 24 → previsto 13, según cobros 23, pendiente 10', () => {
    const c = costSummary({ announcedPrice: 4500n, actualPaid: 4700n, expectedFromOthers: 3400n, receivedFromOthers: 2400n });
    expect([c.projectedCost, c.costByCollections, c.pendingFromOthers, c.surplus, c.estimated]).toEqual([1300n, 2300n, 1000n, 0n, false]);
  });
  it('ejemplo del presupuesto: pago 47, exigibles 36, cobrados 24 → 11 / 23 / 12', () => {
    const c = costSummary({ announcedPrice: 4500n, actualPaid: 4700n, expectedFromOthers: 3600n, receivedFromOthers: 2400n });
    expect([formatMoney(c.projectedCost), formatMoney(c.costByCollections), formatMoney(c.pendingFromOthers)]).toEqual(['11.00', '23.00', '12.00']);
  });
  it('sin pago real usa el precio anunciado y lo marca como estimado', () => {
    const c = costSummary({ announcedPrice: 4500n, actualPaid: null, expectedFromOthers: 3600n, receivedFromOthers: 0n });
    expect(c.estimated).toBe(true);
    expect(c.projectedCost).toBe(900n);
    expect(c.costByCollections).toBe(4500n);
  });
  it('costo negativo se muestra como excedente (D-12)', () => {
    const c = costSummary({ announcedPrice: 4500n, actualPaid: 4500n, expectedFromOthers: 5000n, receivedFromOthers: 5000n });
    expect(c.projectedCost).toBe(-500n);
    expect(c.surplus).toBe(500n);
  });
});
