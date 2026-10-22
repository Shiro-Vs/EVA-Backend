import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadEnv } from '../../src/config/env.js';

export const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });

/** Ejecuta `fn` dentro de una transacción que SIEMPRE se deshace. */
export async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    return await fn(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

/** Intenta una operación sin abortar la transacción; devuelve el error de PostgreSQL (o null). */
export async function attempt(c: pg.PoolClient, fn: () => Promise<unknown>) {
  await c.query('savepoint attempt');
  try {
    await fn();
    await c.query('release savepoint attempt');
    return null;
  } catch (e) {
    await c.query('rollback to savepoint attempt');
    return e as pg.DatabaseError;
  }
}

/** Fuerza la evaluación de los disparadores diferidos (equivale a confirmar la transacción). */
export const flush = (c: pg.PoolClient) => c.query('set constraints all immediate');

const id = () => randomUUID();

export async function mkUser(c: pg.PoolClient, name = 'U') {
  const userId = id();
  await c.query('insert into user_profile (id, display_name) values ($1, $2)', [userId, name]);
  return userId;
}

export async function mkContact(c: pg.PoolClient, owner: string, name = 'Ana') {
  const contactId = id();
  await c.query('insert into contact (id, owner_id, name) values ($1, $2, $3)', [contactId, owner, name]);
  return contactId;
}

export async function mkAccount(c: pg.PoolClient, owner: string, type = 'bank', name = 'BCP') {
  const accountId = id();
  await c.query('insert into account (id, owner_id, name, type) values ($1, $2, $3, $4)', [accountId, owner, name, type]);
  return accountId;
}

/** Operación + un asiento. `amount` firmado. */
export async function mkOperation(
  c: pg.PoolClient,
  owner: string,
  account: string,
  kind: 'income' | 'expense' | 'opening' | 'adjustment',
  amount: string,
  contact: string | null = null,
) {
  const opId = id();
  await c.query(
    `insert into financial_operation (id, owner_id, kind, occurred_on, contact_id, created_by)
     values ($1, $2, $3, '2026-10-12', $4, $2)`,
    [opId, owner, kind, contact],
  );
  await c.query('insert into account_entry (owner_id, operation_id, account_id, amount) values ($1, $2, $3, $4)', [
    owner,
    opId,
    account,
    amount,
  ]);
  return opId;
}

export async function mkSubscription(c: pg.PoolClient, owner: string, capacity = 4, mode = 'shared') {
  const subId = id();
  await c.query(
    `insert into subscription (id, owner_id, name, mode, capacity) values ($1, $2, 'Netflix', $3, $4)`,
    [subId, owner, mode, capacity],
  );
  return subId;
}

export async function mkCycle(
  c: pg.PoolClient,
  owner: string,
  subscription: string,
  seq: number,
  start: string,
  end: string,
) {
  const cycleId = id();
  await c.query(
    `insert into billing_cycle (id, owner_id, subscription_id, seq, start_date, end_date, terms_snapshot)
     values ($1, $2, $3, $4, $5, $6, '{"announcedPrice":"45.00"}')`,
    [cycleId, owner, subscription, seq, start, end],
  );
  return cycleId;
}

export async function mkSeat(c: pg.PoolClient, owner: string, subscription: string, contact: string, label = 'Cuenta 1') {
  const membershipId = id();
  const seatId = id();
  await c.query(
    `insert into membership (id, owner_id, subscription_id, contact_id, start_date) values ($1, $2, $3, $4, '2026-10-07')`,
    [membershipId, owner, subscription, contact],
  );
  await c.query(
    `insert into seat (id, owner_id, membership_id, subscription_id, label, start_date) values ($1, $2, $3, $4, $5, '2026-10-07')`,
    [seatId, owner, membershipId, subscription, label],
  );
  return { membershipId, seatId };
}

/** Cargo ordinario. Devuelve el ID de la obligación. */
export async function mkCharge(
  c: pg.PoolClient,
  owner: string,
  contact: string,
  seat: string,
  cycle: string,
  gross = '20.00',
  exemption = '0.00',
) {
  const obligationId = id();
  await c.query(
    `insert into receivable_obligation (id, owner_id, contact_id, kind) values ($1, $2, $3, 'subscription_charge')`,
    [obligationId, owner, contact],
  );
  await c.query(
    `insert into member_charge (obligation_id, owner_id, contact_id, seat_id, cycle_id, due_date, quota_snapshot,
                                gross_amount, exemption_amount, mode, calc_snapshot)
     values ($1, $2, $3, $4, $5, '2026-10-07', 20.00, $6, $7, 'full_cycle', '{}')`,
    [obligationId, owner, contact, seat, cycle, gross, exemption],
  );
  return obligationId;
}

/** Cobro: un ingreso real + el recibo. */
export async function mkReceipt(c: pg.PoolClient, owner: string, contact: string, account: string, amount: string) {
  const opId = await mkOperation(c, owner, account, 'income', amount, contact);
  const receiptId = id();
  await c.query(
    `insert into receipt (id, owner_id, contact_id, operation_id, amount, received_on)
     values ($1, $2, $3, $4, $5, '2026-10-12')`,
    [receiptId, owner, contact, opId, amount],
  );
  return { receiptId, opId };
}

export async function allocate(c: pg.PoolClient, owner: string, receipt: string, obligation: string, amount: string) {
  await c.query(
    `insert into payment_allocation (owner_id, receipt_id, obligation_id, amount, created_by) values ($1, $2, $3, $4, $1)`,
    [owner, receipt, obligation, amount],
  );
}

export const DEV_SECRET = 'test-secret-test-secret-test-secret-123';
export const testEnv = () =>
  loadEnv({ DATABASE_URL: process.env.TEST_DATABASE_URL, AUTH_MODE: 'dev', AUTH_DEV_SECRET: DEV_SECRET, LOG_LEVEL: 'silent' });
