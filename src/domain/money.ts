// Dinero en céntimos enteros (bigint). Nunca punto flotante (02 §2, 04 §1).
export type Cents = bigint;

export class MoneyError extends Error {
  constructor(public readonly code: 'INVALID_MONEY' | 'DIVISION_BY_ZERO', message: string) {
    super(message);
  }
}

/** ceil(a / b) para a ≥ 0 y b > 0. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new MoneyError('DIVISION_BY_ZERO', 'El divisor debe ser positivo');
  if (a < 0n) throw new MoneyError('INVALID_MONEY', 'ceilDiv no admite dividendos negativos');
  return (a + b - 1n) / b;
}

/** Redondea hacia arriba a sol entero: 701n → 800n. */
export const ceilToSol = (c: Cents): Cents => ceilDiv(c, 100n) * 100n;

const MONEY_RE = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

/** "20.00" → 2000n. Rechaza más de 2 decimales, notación científica y espacios. */
export function parseMoney(text: string, opts: { allowNegative?: boolean } = {}): Cents {
  const m = MONEY_RE.exec(text);
  if (!m) throw new MoneyError('INVALID_MONEY', `Importe inválido: "${text}"`);
  const [, sign, whole, frac = ''] = m;
  if (sign && !opts.allowNegative) throw new MoneyError('INVALID_MONEY', 'El importe no puede ser negativo');
  const cents = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0') || '0');
  return sign ? -cents : cents;
}

/** 2000n → "20.00". */
export function formatMoney(c: Cents): string {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  const s = `${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

/**
 * Reparte `total` en partes proporcionales a `weights` sin crear ni perder céntimos.
 * Mayor resto; desempate por índice ascendente (D-04).
 */
export function distribute(total: Cents, weights: bigint[]): Cents[] {
  if (total < 0n) throw new MoneyError('INVALID_MONEY', 'No se reparte un total negativo');
  if (weights.length === 0) return [];
  if (weights.some((w) => w < 0n)) throw new MoneyError('INVALID_MONEY', 'Los pesos no pueden ser negativos');
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum === 0n) throw new MoneyError('DIVISION_BY_ZERO', 'La suma de pesos es cero');

  const parts = weights.map((w) => (total * w) / sum);
  const rems = weights.map((w, i) => ({ i, rem: (total * w) % sum }));
  let left = total - parts.reduce((a, b) => a + b, 0n);

  rems.sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (const r of rems) {
    if (left === 0n) break;
    parts[r.i] = parts[r.i]! + 1n;
    left -= 1n;
  }
  return parts;
}

export const splitEqual = (total: Cents, n: number): Cents[] => distribute(total, Array<bigint>(n).fill(1n));
