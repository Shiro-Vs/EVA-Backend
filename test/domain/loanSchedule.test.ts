import { describe, expect, it } from 'vitest';
import { accruedInPeriod, buildSchedule, interestForPeriod, lateFee, periodsUntil, proposeAllocation, type Pending, type Terms } from '../../src/domain/loanSchedule.js';
import { formatISO, parseISO } from '../../src/domain/localDate.js';
import { formatMoney, parseMoney } from '../../src/domain/money.js';

const c = (v: string) => parseMoney(v);
const base: Terms = { principal: c('1000.00'), mode: 'percent', fixedAmount: null, rateBp: 500, base: 'original', kind: 'installments', installments: 4, firstDue: parseISO('2026-11-12'), finalDate: null, opened: parseISO('2026-10-12') };
const rows = (t: Terms) => buildSchedule(t).map((d) => [d.concept, d.due === null ? null : formatISO(d.due), formatMoney(d.amount)]);

describe('interés por período (RN-L20, D-20)', () => {
  it('simple sobre la base, hacia arriba al céntimo', () => {
    expect(formatMoney(interestForPeriod(base, c('100.01')))).toBe('5.01'); // 5.0005 → 5.01
    expect(formatMoney(interestForPeriod({ mode: 'none', fixedAmount: null, rateBp: null }, c('100.00')))).toBe('0.00');
    expect(formatMoney(interestForPeriod({ mode: 'fixed', fixedAmount: c('50.00'), rateBp: null }, c('999.00')))).toBe('50.00');
  });

  it('devengo parcial: prorrateo diario base 30, tope de un período (RN-L22)', () => {
    expect(formatMoney(accruedInPeriod(base, c('1000.00'), 10))).toBe('16.67'); // 50 × 10 / 30
    expect(formatMoney(accruedInPeriod(base, c('1000.00'), 45))).toBe('50.00'); // no pasa del período completo
    expect(accruedInPeriod(base, c('1000.00'), 0)).toBe(0n);
  });
});

describe('cronograma acordado', () => {
  it('cuotas con interés sobre el capital original', () => {
    expect(rows(base)).toEqual([
      ['principal', '2026-11-12', '250.00'], ['interest', '2026-11-12', '50.00'],
      ['principal', '2026-12-12', '250.00'], ['interest', '2026-12-12', '50.00'],
      ['principal', '2027-01-12', '250.00'], ['interest', '2027-01-12', '50.00'],
      ['principal', '2027-02-12', '250.00'], ['interest', '2027-02-12', '50.00'],
    ]);
  });

  it('con base «pendiente» el interés baja a medida que se amortiza', () => {
    const interest = buildSchedule({ ...base, base: 'pending' }).filter((d) => d.concept === 'interest').map((d) => formatMoney(d.amount));
    expect(interest).toEqual(['50.00', '37.50', '25.00', '12.50']);
  });

  it('el capital se reparte sin perder céntimos', () => {
    const total = buildSchedule({ ...base, principal: c('100.00'), installments: 3, mode: 'none' }).reduce((a, d) => a + d.amount, 0n);
    expect(formatMoney(total)).toBe('100.00');
    expect(rows({ ...base, principal: c('100.00'), installments: 3, mode: 'none' }).map((r) => r[2])).toEqual(['33.34', '33.33', '33.33']);
  });

  it('con fecha final: un capital y un interés por cada período mensual', () => {
    const t: Terms = { ...base, kind: 'final_date', installments: null, firstDue: null, finalDate: parseISO('2026-12-12') };
    expect(periodsUntil(t.opened, t.finalDate!)).toBe(2);
    expect(rows(t)).toEqual([['principal', '2026-12-12', '1000.00'], ['interest', '2026-11-12', '50.00'], ['interest', '2026-12-12', '50.00']]);
  });

  it('sin fecha: solo el capital; el interés se devenga al consultar', () => {
    expect(rows({ ...base, kind: 'open', installments: null, firstDue: null })).toEqual([['principal', null, '1000.00']]);
  });

  it('el día del mes se conserva (31 → 28 → 31)', () => {
    const t: Terms = { ...base, mode: 'none', installments: 3, firstDue: parseISO('2027-01-31'), opened: parseISO('2026-12-31') };
    expect(rows(t).map((r) => r[1])).toEqual(['2027-01-31', '2027-02-28', '2027-03-31']);
  });
});

describe('reparto de un pago (RN-L05/L06)', () => {
  const item = (id: string, concept: Pending['concept'], due: string | null, no: number | null, pending: string): Pending => ({ id, concept, installmentNo: no, due: due ? parseISO(due) : null, pending: c(pending) });
  const items = [item('i2', 'interest', '2026-12-12', 2, '50.00'), item('p2', 'principal', '2026-12-12', 2, '250.00'), item('i1', 'interest', '2026-11-12', 1, '50.00'), item('p1', 'principal', '2026-11-12', 1, '250.00')];

  it('lo más antiguo primero; dentro de la cuota, capital y luego interés', () => {
    const r = proposeAllocation(items, c('320.00'), 'capital_first');
    expect(r.allocations.map((a) => [a.id, formatMoney(a.amount)])).toEqual([['p1', '250.00'], ['i1', '50.00'], ['p2', '20.00']]);
    expect(r.remainder).toBe(0n);
  });

  it('con «interés primero» cambia el orden dentro de la cuota', () => {
    const r = proposeAllocation(items, c('100.00'), 'interest_first');
    expect(r.allocations.map((a) => [a.id, formatMoney(a.amount)])).toEqual([['i1', '50.00'], ['p1', '50.00']]);
  });

  it('el sobrante se devuelve y la suma de partes iguala el pago', () => {
    const r = proposeAllocation(items, c('1000.00'), 'capital_first');
    expect(formatMoney(r.allocations.reduce((a, x) => a + x.amount, 0n) + r.remainder)).toBe('1000.00');
    expect(formatMoney(r.remainder)).toBe('400.00'); // lo pendiente total es 600.00
  });
});

describe('mora personal (RN-L23, D-21)', () => {
  it('importe fijo o porcentaje sobre lo vencido, hacia arriba', () => {
    expect(formatMoney(lateFee('fixed', c('5.00'), null, c('200.00')))).toBe('5.00');
    expect(formatMoney(lateFee('percent', null, 333, c('100.00')))).toBe('3.33');
    expect(formatMoney(lateFee('percent', null, 333, c('100.10')))).toBe('3.34'); // 3.3333 → 3.34
  });
});
