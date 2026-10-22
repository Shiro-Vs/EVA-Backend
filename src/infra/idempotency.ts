import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { unprocessable } from '../http/errors.js';
import { inTx, one, type DB, type Trx } from './db/db.js';

export interface StoredResponse {
  status: number;
  body: unknown;
}

/** JSON canónico (claves ordenadas) para comparar cuerpos de petición. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
  );
}
const hashOf = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');

export function readKey(header: string | string[] | undefined): string {
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) throw unprocessable('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
  if (key.length < 8 || key.length > 128) throw unprocessable('VALIDATION_ERROR', 'Idempotency-Key must be 8–128 characters');
  return key;
}

interface Row {
  endpoint: string;
  request_hash: string;
  response_status: number;
  response_body: unknown;
}

/**
 * Ejecuta `fn` una sola vez por (propietario, clave). Un reintento con la misma clave y el mismo cuerpo devuelve la
 * respuesta guardada sin repetir efectos; con otro cuerpo → 422 IDEMPOTENCY_KEY_REUSED (13 §1.1).
 * La respuesta se guarda en la MISMA transacción que los efectos: o ambos o ninguno.
 */
export async function runIdempotent(
  db: DB,
  p: { ownerId: string; key: string; endpoint: string; request: unknown },
  fn: (trx: Trx) => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  const requestHash = hashOf(p.request);
  const lookup = (c: DB | Trx) =>
    one<Row>(c, sql<Row>`select endpoint, request_hash, response_status, response_body from idempotency_record where owner_id = ${p.ownerId} and key = ${p.key}`);

  const replay = (r: Row) => {
    if (r.request_hash !== requestHash || r.endpoint !== p.endpoint) {
      throw unprocessable('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used with a different request');
    }
    return { status: r.response_status, body: r.response_body, replayed: true };
  };

  const existing = await lookup(db);
  if (existing) return replay(existing);

  return inTx(db, async (trx) => {
      // Serializa peticiones simultáneas con la misma clave: la segunda espera y luego ve el registro.
      await sql`select pg_advisory_xact_lock(hashtextextended(${p.ownerId + ':' + p.key}, 0))`.execute(trx);
      const again = await lookup(trx);
      if (again) return replay(again);

      const res = await fn(trx);
      await sql`
        insert into idempotency_record (owner_id, key, endpoint, request_hash, response_status, response_body)
        values (${p.ownerId}, ${p.key}, ${p.endpoint}, ${requestHash}, ${res.status}, ${JSON.stringify(res.body)}::jsonb)
      `.execute(trx);
    return { ...res, replayed: false };
  });
}
