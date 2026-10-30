import { afterAll, describe, expect, it } from 'vitest';
import { purgeDeletedUsers } from '../../src/application/account.js';
import type { IdentityAdmin } from '../../src/infra/auth/admin.js';
import { createSupabaseAdmin } from '../../src/infra/auth/admin.js';
import { createHeuristicExtractor } from '../../src/infra/capture/heuristic.js';
import { createMemoryStore } from '../../src/infra/capture/files.js';
import { createKysely } from '../../src/infra/db/db.js';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount, createContact, createService, joinSeat } from '../helpers/scenarios.js';

const files = createMemoryStore();
const deleted: string[] = [];
const identity: IdentityAdmin = { async deleteUser(id) { deleted.push(id); return true; } };
const api = makeApi({ files, identity, extractor: createHeuristicExtractor() });
afterAll(async () => { await api.app.close(); await pool.end(); });
api.setNow(new Date('2026-10-12T17:00:00Z'));

const PHRASE = 'ELIMINAR MI CUENTA';
const preview = async (token: string) => (await api.get(token, '/me/deletion/preview')).body;
const del = (token: string, body: unknown) => api.call({ method: 'POST', url: '/v1/me/deletion', token, body });
const ownerTables = async () => (await pool.query<{ t: string }>(`
  select c.relname as t from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'owner_id' and not a.attisdropped
  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1`)).rows.map((r) => r.t);
const rowsOf = async (userId: string) => {
  const out: Record<string, number> = {};
  for (const t of await ownerTables()) { const n = (await pool.query(`select count(*)::int as n from "${t}" where owner_id = $1`, [userId])).rows[0].n as number; if (n > 0) out[t] = n; }
  return out;
};

/** Un usuario con datos de casi todo: movimientos, servicio compartido, captura con archivo, respaldo, exportación, análisis guardado y préstamo bancario. */
async function world() {
  const u = await api.newUser('Rosa');
  const bcp = await createAccount(api, u.token, 'BCP', '1000.00', 'bank', '2026-09-01');
  await api.post(u.token, '/operations', { kind: 'expense', accountId: bcp.id, amount: '25.00', date: '2026-10-05', description: 'Café' });
  const svc = await createService(api, u.token, { announcedPrice: '45.00' });
  const ana = await createContact(api, u.token, 'Ana');
  await joinSeat(api, u.token, svc.id, ana.id, { quota: '20.00' });
  await api.post(u.token, '/bank-loans', { name: 'Personal' });
  await api.post(u.token, '/reports/monthly/snapshots', { month: '2026-10' });
  await api.post(u.token, '/capture/documents', { origin: 'photo', mime: 'image/png', contentBase64: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') });
  await api.post(u.token, '/backups', {});
  await api.post(u.token, '/exports', { from: '2026-10-01', to: '2026-10-12', sections: ['accounts'], level: 'summary', format: 'csv' });
  await api.post(u.token, '/analysis', { scope: { from: '2026-10-01', to: '2026-10-12' }, question: 'Resumen', save: true }); // sin modelo: falla, no deja nada
  return { u, bcp };
}

describe('Eliminar mi cuenta y mis datos (09 §8)', () => {
  it('la vista previa dice qué se borrará, sin borrar nada', async () => {
    const w = await world();
    const p = await preview(w.u.token);
    expect(p).toMatchObject({ confirmPhrase: PHRASE });
    expect(p.tables).toMatchObject({ account: 1, contact: 1, financial_operation: 2, bank_loan: 1, backup: 1, export_job: 1, source_document: 1, report_snapshot: 1 });
    expect(p.totalRows).toBeGreaterThan(15);
    expect(p.files).toBe(3); // original de captura, respaldo y exportación
    expect(p.warnings.join(' ')).toContain('no se puede deshacer');
    expect((await api.get(w.u.token, '/accounts')).body.items).toHaveLength(1);
  });

  it('exige la frase exacta y la vista previa vigente', async () => {
    const w = await world();
    const p = await preview(w.u.token);
    const bad = await del(w.u.token, { previewToken: p.previewToken, confirm: 'borrar' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('CONFIRMATION_MISMATCH');
    expect((await del(w.u.token, { previewToken: 'x'.repeat(30), confirm: PHRASE })).status).toBe(422);
    await api.post(w.u.token, '/operations', { kind: 'expense', accountId: w.bcp.id, amount: '1.00', date: '2026-10-06' });
    const stale = await del(w.u.token, { previewToken: p.previewToken, confirm: PHRASE });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('PREVIEW_STALE');
    expect((await api.get(w.u.token, '/accounts')).body.items).toHaveLength(1); // nada se borró
  });

  it('elimina TODOS los datos y archivos, avisa al proveedor de identidad y deja intacto a otro usuario', async () => {
    const w = await world();
    const o = await world();
    const otherRows = await rowsOf(o.u.id);
    const otherBalance = (await api.get(o.u.token, `/accounts/${o.bcp.id}`)).body.balance;
    expect(Object.keys(await rowsOf(w.u.id)).length).toBeGreaterThan(10);
    const keysBefore = (await pool.query<{ k: string }>(`select file_key as k from source_document where owner_id = $1 and file_key is not null union all select file_key from backup where owner_id = $1 union all select file_key from export_job where owner_id = $1 and file_key is not null`, [w.u.id])).rows.map((r) => r.k);
    expect(keysBefore).toHaveLength(3);

    const p = await preview(w.u.token);
    const r = await del(w.u.token, { previewToken: p.previewToken, confirm: ` ${PHRASE.toLowerCase()} ` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ deleted: true, files: 3, identityDeleted: true });
    expect(deleted).toContain(w.u.id);

    // Ni una fila en NINGUNA tabla con propietario (incluidas las protegidas como inmutables) ni el perfil.
    expect(await rowsOf(w.u.id)).toEqual({});
    expect((await pool.query('select count(*)::int as n from user_profile where id = $1', [w.u.id])).rows[0].n).toBe(0);
    for (const k of keysBefore) await expect(files.get(k)).rejects.toThrow();

    // El otro usuario no se tocó.
    expect(await rowsOf(o.u.id)).toEqual(otherRows);
    expect((await api.get(o.u.token, `/accounts/${o.bcp.id}`)).body.balance).toBe(otherBalance);
  });

  it('un token todavía vigente no recrea un perfil vacío', async () => {
    const w = await world();
    const p = await preview(w.u.token);
    await del(w.u.token, { previewToken: p.previewToken, confirm: PHRASE });
    const again = await api.get(w.u.token, '/me');
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe('ACCOUNT_DELETED');
    expect((await api.get(w.u.token, '/accounts')).status).toBe(401);
    expect((await pool.query('select count(*)::int as n from user_profile where id = $1', [w.u.id])).rows[0].n).toBe(0);
  });

  it('las tablas inmutables vuelven a estar protegidas tras el borrado', async () => {
    const w = await world();
    const o = await world();
    const p = await preview(w.u.token);
    await del(w.u.token, { previewToken: p.previewToken, confirm: PHRASE });
    await expect(pool.query('update account_entry set amount = 1 where owner_id = $1', [o.u.id])).rejects.toThrow();
    await expect(pool.query('delete from account_entry where owner_id = $1', [o.u.id])).rejects.toThrow();
    await expect(pool.query('delete from audit_event where owner_id = $1', [o.u.id])).rejects.toThrow();
    await expect(pool.query('delete from report_snapshot where owner_id = $1', [o.u.id])).rejects.toThrow();
  });

  it('la marca de cuenta eliminada solo guarda el identificador y se borra a los 7 días', async () => {
    const w = await world();
    const p = await preview(w.u.token);
    await del(w.u.token, { previewToken: p.previewToken, confirm: PHRASE });
    const cols = (await pool.query(`select column_name from information_schema.columns where table_name = 'deleted_user' order by 1`)).rows.map((r) => r.column_name);
    expect(cols).toEqual(['deleted_at', 'id']); // sin nombre ni correo
    const db = createKysely(pool);
    expect(await purgeDeletedUsers(db, new Date('2026-10-14T00:00:00Z'))).toBe(0);
    expect((await pool.query('select count(*)::int as n from deleted_user where id = $1', [w.u.id])).rows[0].n).toBe(1);
    expect(await purgeDeletedUsers(db, new Date('2026-10-20T00:00:00Z'))).toBeGreaterThanOrEqual(1);
    expect((await pool.query('select count(*)::int as n from deleted_user where id = $1', [w.u.id])).rows[0].n).toBe(0);
  });
});

describe('Proveedor de identidad (Supabase Auth)', () => {
  it('usa la clave de servicio solo en el servidor y trata 404 como ya eliminado', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mk = (status: number) => createSupabaseAdmin({ url: 'https://p.supabase.co/', serviceKey: 'service-key-secreta-123', fetchFn: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('', { status }); }) as typeof fetch });
    expect(await mk(200).deleteUser('abc')).toBe(true);
    expect(calls[0]!.url).toBe('https://p.supabase.co/auth/v1/admin/users/abc');
    expect(calls[0]!.init.method).toBe('DELETE');
    expect(await mk(404).deleteUser('abc')).toBe(true);
    expect(await mk(500).deleteUser('abc')).toBe(false);
    const down = createSupabaseAdmin({ url: 'https://p.supabase.co', serviceKey: 'service-key-secreta-123', fetchFn: (async () => { throw new Error('red'); }) as typeof fetch });
    expect(await down.deleteUser('abc')).toBe(false);
  });

  it('sin clave de servicio el borrado de datos igual funciona y lo informa', async () => {
    const a = makeApi({ files: createMemoryStore() });
    a.setNow(new Date('2026-10-12T17:00:00Z'));
    const u = await a.newUser();
    await createAccount(a, u.token);
    const p = (await a.get(u.token, '/me/deletion/preview')).body;
    const r = await a.call({ method: 'POST', url: '/v1/me/deletion', token: u.token, body: { previewToken: p.previewToken, confirm: PHRASE } });
    expect(r.body).toMatchObject({ deleted: true, identityDeleted: false });
    await a.app.close();
  });
});
