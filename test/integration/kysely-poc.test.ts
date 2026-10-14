import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/kysely.js';
import { pool } from '../helpers/db.js';

const db = createDb(pool);
afterAll(() => pool.end());

// Prueba de concepto de T-03: Kysely + migraciones SQL a mano.
describe('T-03: Kysely sobre el esquema SQL', () => {
  it('transacción tipada: saldo = suma de asientos, dinero como cadena exacta', async () => {
    const owner = randomUUID();
    const result = await db.transaction().execute(async (trx) => {
      await trx.insertInto('user_profile').values({ id: owner, display_name: 'PoC' }).execute();
      const acc = await trx.insertInto('account').values({ owner_id: owner, name: 'BCP', type: 'bank' }).returning('id').executeTakeFirstOrThrow();
      const op = await trx
        .insertInto('financial_operation')
        .values({ owner_id: owner, kind: 'opening', occurred_on: '2026-10-12', created_by: owner, contact_id: null })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.insertInto('account_entry').values({ owner_id: owner, operation_id: op.id, account_id: acc.id, amount: '200.10' }).execute();
      const bal = await trx.selectFrom('v_account_balance').select('balance').where('account_id', '=', acc.id).executeTakeFirstOrThrow();
      await sql`set constraints all immediate`.execute(trx);
      // Se deshace para no dejar datos: lanzar fuerza el rollback.
      throw Object.assign(new Error('rollback'), { bal: bal.balance });
    }).catch((e) => e);

    expect(result.message).toBe('rollback');
    expect(result.bal).toBe('200.10'); // sin 200.10000000000001
  });

  it('la clave foránea compuesta rechaza referenciar datos de otro propietario', async () => {
    const [u1, u2] = [randomUUID(), randomUUID()];
    const err = await db.transaction().execute(async (trx) => {
      await trx.insertInto('user_profile').values([{ id: u1, display_name: 'U1' }, { id: u2, display_name: 'U2' }]).execute();
      const contact = await trx.insertInto('contact').values({ owner_id: u1, name: 'Ana' }).returning('id').executeTakeFirstOrThrow();
      try {
        await trx
          .insertInto('financial_operation')
          .values({ owner_id: u2, kind: 'income', occurred_on: '2026-10-12', created_by: u2, contact_id: contact.id })
          .execute();
        return null;
      } catch (e) {
        // Tras un error PostgreSQL deja la transacción abortada: el COMMIT de Kysely equivale a ROLLBACK.
        return e as { code?: string };
      }
    });
    expect(err?.code).toBe('23503');
    const persisted = await db.selectFrom('user_profile').select('id').where('id', 'in', [u1, u2]).execute();
    expect(persisted).toHaveLength(0);
  });
});
