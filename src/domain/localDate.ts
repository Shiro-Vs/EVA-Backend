// Fecha local sin hora ni zona: días enteros desde 1970-01-01 (02 §3).
// Date solo se usa aquí, en UTC, como calculadora de calendario; nunca en reglas de negocio.
export type LocalDate = number;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export class DateError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysInMonth = (y: number, m1: number) => new Date(Date.UTC(y, m1, 0)).getUTCDate(); // m1: 1..12

export function fromYMD(y: number, m1: number, d: number): LocalDate {
  if (m1 < 1 || m1 > 12 || d < 1 || d > daysInMonth(y, m1)) throw new DateError(`Fecha inexistente: ${y}-${m1}-${d}`);
  return Math.floor(Date.UTC(y, m1 - 1, d) / 86_400_000);
}

export function toYMD(ld: LocalDate): { y: number; m: number; d: number } {
  const dt = new Date(ld * 86_400_000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function parseISO(text: string): LocalDate {
  const m = ISO_RE.exec(text);
  if (!m) throw new DateError(`Fecha inválida (se espera YYYY-MM-DD): "${text}"`);
  return fromYMD(Number(m[1]), Number(m[2]), Number(m[3]));
}

export function formatISO(ld: LocalDate): string {
  const { y, m, d } = toYMD(ld);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export const addDays = (ld: LocalDate, n: number): LocalDate => ld + n;
export const diffDays = (a: LocalDate, b: LocalDate): number => a - b; // a − b

/** Fecha local de hoy en una zona IANA (p. ej. America/Lima). */
export function todayIn(timeZone: string, now: Date = new Date()): LocalDate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return parseISO(parts);
}
