import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const unprocessable = (code: string, message: string, details?: unknown) => new AppError(422, code, message, details);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);

export function fromZod(err: ZodError): AppError {
  return new AppError(
    422,
    'VALIDATION_ERROR',
    'Request validation failed',
    err.issues.map((i) => ({ field: i.path.join('.'), issue: i.code, message: i.message })),
  );
}

// Códigos que los disparadores de la base lanzan con RAISE EXCEPTION (12 §3, §7).
const DB_CODES = new Set([
  'OPERATION_TRANSFER_UNBALANCED',
  'OPERATION_INCOME_NOT_POSITIVE',
  'OPERATION_EXPENSE_NOT_NEGATIVE',
  'OPERATION_SINGLE_ENTRY_REQUIRED',
  'ALLOCATION_RECEIPT_NOT_ACTIVE',
  'ALLOCATION_CONTACT_MISMATCH',
  'ALLOCATION_EXCEEDS_RECEIPT',
  'ALLOCATION_EXCEEDS_OBLIGATION',
]);
const DB_TO_API: Record<string, string> = {
  ALLOCATION_EXCEEDS_RECEIPT: 'OVER_ALLOCATION',
  ALLOCATION_EXCEEDS_OBLIGATION: 'OVER_ALLOCATION',
};

/** Traduce errores de PostgreSQL a errores de API; devuelve null si no corresponde. */
export function fromDatabase(err: unknown): AppError | null {
  const e = err as { code?: string; message?: string; constraint?: string };
  if (!e || typeof e.message !== 'string') return null;
  const hit = [...DB_CODES].find((c) => e.message!.includes(c));
  if (hit) return new AppError(422, DB_TO_API[hit] ?? hit, hit);
  // Una FK compuesta que no encuentra su fila = referencia a algo inexistente o de otro propietario (A27): no revelar cuál.
  if (e.code === '23503') return new AppError(404, 'NOT_FOUND', 'Referenced resource not found');
  if (e.code === '23P01') return new AppError(409, 'CONCURRENT_UPDATE', 'Conflicting concurrent change; retry');
  if (e.code === '40001' || e.code === '40P01') return new AppError(409, 'CONCURRENT_UPDATE', 'Conflicting concurrent change; retry');
  return null;
}
