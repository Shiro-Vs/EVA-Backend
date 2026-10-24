import { z } from 'zod';
import { isoDate, money, optText } from './captureBase.js';

// Préstamos bancarios (06 §3). Solo datos CONFIRMADOS por documento o por el usuario; lo desconocido queda pendiente, nunca estimado (RN-B01).

const pct = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'porcentaje con punto, p. ej. 18.5');
const optMoney = money.nullable().optional().transform((v) => v ?? null);
const optDate = isoDate.nullable().optional().transform((v) => v ?? null);

export const loanInstallmentIn = z.object({
  number: z.number().int().min(1).max(600),
  dueDate: isoDate,
  principal: optMoney, interest: optMoney, insurance: optMoney, fees: optMoney,
  total: money,
});
export type LoanInstallmentIn = z.infer<typeof loanInstallmentIn>;

/** Lo que el modelo puede leer de un documento de préstamo. Todo es opcional: lo que no consta es null y queda pendiente. */
export const loanExtraction = z.object({
  entity: optText, loanNumber: optText,
  principal: optMoney,
  tea: pct.nullable().optional().transform((v) => v ?? null),
  tcea: pct.nullable().optional().transform((v) => v ?? null),
  termMonths: z.number().int().min(1).max(600).nullable().optional().transform((v) => v ?? null),
  installmentsCount: z.number().int().min(1).max(600).nullable().optional().transform((v) => v ?? null),
  disbursedOn: optDate, firstDueDate: optDate, monthlyPayment: optMoney, outstandingBalance: optMoney, asOf: optDate,
  installments: z.array(loanInstallmentIn).max(600).default([]),
});
export type LoanExtraction = z.infer<typeof loanExtraction>;

export const LOAN_FACT_KEYS = ['principal', 'tea', 'tcea', 'term_months', 'installments_count', 'disbursed_on', 'first_due_date', 'monthly_payment', 'outstanding_balance', 'loan_number'] as const;
export type LoanFactKey = (typeof LOAN_FACT_KEYS)[number];
/** Datos que conviene conocer; su ausencia se muestra como pendiente y nunca bloquea registrar un pago real (RN-B04). */
export const LOAN_CORE_FACTS: LoanFactKey[] = ['principal', 'tea', 'term_months', 'first_due_date'];

const MONEY_FACTS = new Set<LoanFactKey>(['principal', 'monthly_payment', 'outstanding_balance']);
const DATE_FACTS = new Set<LoanFactKey>(['disbursed_on', 'first_due_date']);
const INT_FACTS = new Set<LoanFactKey>(['term_months', 'installments_count']);

/** Valida y normaliza el valor de un dato. Devuelve null si no es válido. */
export function normalizeFact(key: LoanFactKey, value: string): string | null {
  const v = value.trim();
  if (MONEY_FACTS.has(key)) {
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(v)) return null;
    const [i, d = ''] = v.split('.');
    return `${i}.${d.padEnd(2, '0')}`;
  }
  if (DATE_FACTS.has(key)) return isoDate.safeParse(v).success ? v : null;
  if (INT_FACTS.has(key)) return /^\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= 600 ? String(Number(v)) : null;
  if (key === 'tea' || key === 'tcea') return pct.safeParse(v).success ? v : null;
  return v.length > 0 && v.length <= 60 ? v : null;
}

export type DocKind = 'summary' | 'schedule' | 'statement';
/** Tipos de documento no intercambiables (RN-B03). */
export const KIND_OF_DOCTYPE: Record<string, DocKind | undefined> = { loan_summary: 'summary', loan_schedule: 'schedule', bank_statement: 'statement' };

export interface FactIn { key: LoanFactKey; value: string; asOf: string | null }

/** Datos que aporta cada tipo de documento: el resumen, las condiciones; el estado de cuenta, el saldo; el cronograma, solo cuotas. */
export function factsFromLoan(kind: DocKind, l: LoanExtraction): FactIn[] {
  const out: FactIn[] = [];
  const add = (key: LoanFactKey, v: string | number | null, asOf: string | null = null) => { if (v !== null && String(v) !== '') out.push({ key, value: String(v), asOf }); };
  if (kind === 'summary') {
    add('principal', l.principal); add('tea', l.tea); add('tcea', l.tcea); add('term_months', l.termMonths); add('installments_count', l.installmentsCount);
    add('disbursed_on', l.disbursedOn); add('first_due_date', l.firstDueDate); add('monthly_payment', l.monthlyPayment); add('loan_number', l.loanNumber);
  }
  if (kind === 'statement') add('outstanding_balance', l.outstandingBalance, l.asOf);
  return out;
}

export interface ScheduleWarning { code: string; message: string; installmentNo?: number }

const cents = (v: string) => { const [i, d = ''] = v.split('.'); return BigInt(i! + d.padEnd(2, '0').slice(0, 2)); };
const fmt = (c: bigint) => `${c / 100n}.${String(c % 100n).padStart(2, '0')}`;

/** Señala lo incoherente ANTES de confirmar (RN-B08). No corrige ni inventa nada. */
export function checkSchedule(rows: LoanInstallmentIn[], facts: { principal?: string | null; installmentsCount?: number | null }): ScheduleWarning[] {
  const w: ScheduleWarning[] = [];
  const seen = new Set<number>();
  for (const r of rows) {
    if (seen.has(r.number)) w.push({ code: 'DUPLICATE_NUMBER', message: `La cuota ${r.number} aparece más de una vez`, installmentNo: r.number });
    seen.add(r.number);
    const parts = [r.principal, r.interest, r.insurance, r.fees];
    if (parts.every((p) => p !== null)) {
      const sum = parts.reduce((a, p) => a + cents(p!), 0n);
      if (sum !== cents(r.total)) w.push({ code: 'ROW_SUM_MISMATCH', message: `En la cuota ${r.number}, capital + interés + seguro + comisiones (${fmt(sum)}) no coincide con el total (${r.total})`, installmentNo: r.number });
    }
  }
  const sorted = [...rows].sort((a, b) => a.number - b.number);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!; const b = sorted[i]!;
    if (b.number !== a.number && b.dueDate <= a.dueDate) w.push({ code: 'DATES_NOT_ASCENDING', message: `La cuota ${b.number} vence el ${b.dueDate}, no después de la cuota ${a.number}`, installmentNo: b.number });
  }
  const nums = [...seen].sort((a, b) => a - b);
  if (nums.length > 0 && (nums[0] !== 1 || nums[nums.length - 1] !== nums.length)) w.push({ code: 'GAP_IN_NUMBERING', message: 'Faltan cuotas en la numeración: puede haber una página incompleta o ilegible' });
  if (facts.installmentsCount && nums.length > 0 && nums.length !== facts.installmentsCount) w.push({ code: 'COUNT_MISMATCH', message: `El préstamo declara ${facts.installmentsCount} cuotas y el cronograma trae ${nums.length}` });
  if (facts.principal && rows.length > 0 && rows.every((r) => r.principal !== null)) {
    const total = rows.reduce((a, r) => a + cents(r.principal!), 0n);
    if (total !== cents(facts.principal)) w.push({ code: 'PRINCIPAL_SUM_MISMATCH', message: `La suma del capital de las cuotas (${fmt(total)}) no coincide con el capital del préstamo (${facts.principal})` });
  }
  return w;
}
