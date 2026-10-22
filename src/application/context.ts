import type { LocalDate } from '../domain/localDate.js';
import type { Trx } from '../infra/db/db.js';

/** Contexto de un caso de uso: siempre el propietario sale del token, nunca del cuerpo (09 §2). */
export interface Ctx {
  trx: Trx;
  ownerId: string;
  actorId: string;
  today: LocalDate;
  nowMs: number; // reloj inyectable (token de vista previa)
  previewSecret: string;
}

export const iso = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d));
export const ts = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d));
