import { describe, expect, it } from 'vitest';
import { checkSchedule, factsFromLoan, loanExtraction, normalizeFact, type LoanInstallmentIn } from '../../src/domain/bankLoan.js';
import { extractionSchema } from '../../src/domain/capture.js';

const row = (n: number, due: string, over: Partial<LoanInstallmentIn> = {}): LoanInstallmentIn => ({ number: n, dueDate: due, principal: '80.00', interest: '15.00', insurance: '3.00', fees: '2.00', total: '100.00', ...over });

describe('Coherencia del cronograma (RN-B08)', () => {
  it('un cronograma coherente no genera advertencias', () => {
    expect(checkSchedule([row(1, '2026-11-01'), row(2, '2026-12-01'), row(3, '2027-01-01')], { principal: '240.00', installmentsCount: 3 })).toEqual([]);
  });
  it('señala la suma de una fila que no cuadra, sin corregirla', () => {
    const w = checkSchedule([row(1, '2026-11-01', { total: '101.00' })], {});
    expect(w).toEqual([expect.objectContaining({ code: 'ROW_SUM_MISMATCH', installmentNo: 1 })]);
  });
  it('si faltan componentes no puede comprobar la suma y no inventa', () => {
    expect(checkSchedule([row(1, '2026-11-01', { insurance: null, total: '120.00' })], {})).toEqual([]);
  });
  it('detecta numeración con huecos (página incompleta), repetidas y fechas desordenadas', () => {
    const codes = (rows: LoanInstallmentIn[]) => checkSchedule(rows, {}).map((w) => w.code);
    expect(codes([row(1, '2026-11-01'), row(3, '2027-01-01')])).toContain('GAP_IN_NUMBERING');
    expect(codes([row(1, '2026-11-01'), row(1, '2026-12-01')])).toContain('DUPLICATE_NUMBER');
    expect(codes([row(1, '2026-12-01'), row(2, '2026-11-01')])).toContain('DATES_NOT_ASCENDING');
  });
  it('compara con la cantidad de cuotas y con el capital declarados', () => {
    const rows = [row(1, '2026-11-01'), row(2, '2026-12-01')];
    expect(checkSchedule(rows, { installmentsCount: 3 }).map((w) => w.code)).toContain('COUNT_MISMATCH');
    expect(checkSchedule(rows, { principal: '200.00' }).map((w) => w.code)).toContain('PRINCIPAL_SUM_MISMATCH');
    expect(checkSchedule(rows, { principal: '160.00', installmentsCount: 2 })).toEqual([]);
  });
});

describe('Datos del préstamo', () => {
  it('normaliza importes, enteros, fechas y porcentajes; rechaza lo inválido', () => {
    expect(normalizeFact('principal', '10000')).toBe('10000.00');
    expect(normalizeFact('principal', '10000.5')).toBe('10000.50');
    expect(normalizeFact('principal', '10,000.00')).toBeNull();
    expect(normalizeFact('tea', '18.5')).toBe('18.5');
    expect(normalizeFact('tea', '18,5')).toBeNull();
    expect(normalizeFact('term_months', '24')).toBe('24');
    expect(normalizeFact('term_months', '0')).toBeNull();
    expect(normalizeFact('first_due_date', '2026-02-30')).toBeNull();
    expect(normalizeFact('loan_number', '  ABC-123 ')).toBe('ABC-123');
  });
  it('cada tipo de documento aporta solo lo suyo (RN-B03)', () => {
    const l = loanExtraction.parse({ principal: '5000.00', tea: '20', outstandingBalance: '4200.00', asOf: '2026-10-01', installments: [] });
    expect(factsFromLoan('summary', l).map((f) => f.key)).toEqual(['principal', 'tea']);
    expect(factsFromLoan('statement', l)).toEqual([{ key: 'outstanding_balance', value: '4200.00', asOf: '2026-10-01' }]);
    expect(factsFromLoan('schedule', l)).toEqual([]);
  });
  it('el esquema de extracción acepta "loan" y rechaza cuotas con importes mal formados', () => {
    const base = { documentType: 'loan_schedule', isTransaction: false, movements: [] };
    expect(extractionSchema.safeParse({ ...base, loan: { installments: [{ number: 1, dueDate: '2026-11-01', total: '100.00' }] } }).success).toBe(true);
    expect(extractionSchema.safeParse({ ...base, loan: { installments: [{ number: 1, dueDate: '2026-11-01', total: '100,00' }] } }).success).toBe(false);
    expect(extractionSchema.safeParse({ ...base, loan: { tea: '18,5%' } }).success).toBe(false);
    expect(extractionSchema.safeParse(base).success).toBe(true);
  });
});
