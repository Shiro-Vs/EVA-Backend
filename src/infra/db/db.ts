import { Kysely, PostgresDialect, sql, type RawBuilder, type Transaction } from 'kysely';
import pg from 'pg';
import { fromDatabase } from '../../http/errors.js';

// `date` de PostgreSQL llega como 'YYYY-MM-DD' (sin conversión a Date ni zona horaria): 02 §3.
pg.types.setTypeParser(1082, (v) => v);

// Las consultas son SQL parametrizado (plantilla `sql`): los tipos de fila se declaran en cada caso de uso.
export type DB = Kysely<any>;
export type Trx = Transaction<any>;

export const createKysely = (pool: pg.Pool): DB => new Kysely<any>({ dialect: new PostgresDialect({ pool }) });

/** Ejecuta `fn` en una transacción. Evalúa los disparadores diferidos antes de confirmar y traduce errores de la base. */
export async function inTx<T>(db: DB, fn: (trx: Trx) => Promise<T>): Promise<T> {
  try {
    return await db.transaction().execute(async (trx) => {
      const result = await fn(trx);
      await sql`set constraints all immediate`.execute(trx);
      return result;
    });
  } catch (err) {
    throw fromDatabase(err) ?? err;
  }
}

export async function rows<T>(trx: DB | Trx, query: RawBuilder<T>): Promise<T[]> {
  return (await query.execute(trx)).rows;
}

export async function one<T>(trx: DB | Trx, query: RawBuilder<T>): Promise<T | undefined> {
  return (await rows<T>(trx, query))[0];
}
