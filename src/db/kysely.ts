import { Kysely, PostgresDialect, type ColumnType, type Generated } from 'kysely';
import type pg from 'pg';

/** `numeric` llega como cadena desde `pg`: así nunca pasa por coma flotante (02 §2). */
type Money = ColumnType<string, string, string>;
type Uuid = string;

// Prueba de concepto (tarea 0.4): subconjunto de tablas. Los tipos completos se generan en la entrega 1.
export interface Database {
  user_profile: { id: Uuid; display_name: string; version: Generated<number> };
  contact: { id: Generated<Uuid>; owner_id: Uuid; name: string; status: Generated<string> };
  account: { id: Generated<Uuid>; owner_id: Uuid; name: string; type: string };
  financial_operation: {
    id: Generated<Uuid>; owner_id: Uuid; kind: string; occurred_on: string; created_by: Uuid; contact_id: Uuid | null;
  };
  account_entry: { id: Generated<Uuid>; owner_id: Uuid; operation_id: Uuid; account_id: Uuid; amount: Money };
  v_account_balance: { owner_id: Uuid; account_id: Uuid; balance: string };
}

export const createDb = (pool: pg.Pool) => new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
export type Db = Kysely<Database>;
