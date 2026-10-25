import { randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { runDueBackups } from '../../src/application/backups.js';
import { createMemoryStore } from '../../src/infra/capture/files.js';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount, createContact, createService, joinSeat } from '../helpers/scenarios.js';

const files = createMemoryStore();
const api = makeApi({ files });
afterAll(async () => { await api.app.close(); await pool.end(); });
const at = (iso: string, time = '17:00') => api.setNow(new Date(`${iso}T${time}:00Z`));
const put = (token: string, body: unknown) => api.call({ method: 'PUT' as never, url: '/v1/preferences', token, body });
const fileOf = async (id: string) => (await pool.query<{ file_key: string }>('select file_key from backup where id = $1', [id])).rows[0]!.file_key;

/** Un usuario con datos de varios módulos: cuentas, movimientos, un servicio compartido y un préstamo bancario. */
async function world() {
  at('2026-10-12');
  const u = await api.newUser('Rosa');
  const bcp = await createAccount(api, u.token, 'BCP', '1000.00', 'bank', '2026-09-01');
  const cash = await createAccount(api, u.token, 'Efectivo', '200.00', 'cash', '2026-09-01');
  const op = async (kind: string, accountId: string, amount: string, date: string, extra: Record<string, unknown> = {}) => {
    const r = await api.post(u.token, '/operations', { kind, accountId, amount, date, ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  };
  await op('income', bcp.id, '3000.00', '2026-10-01', { description: 'Sueldo' });
  await op('expense', bcp.id, '800.00', '2026-10-02', { description: 'Alquiler' });
  await op('transfer', bcp.id, '100.00', '2026-10-03', { toAccountId: cash.id });
  const ana = await createContact(api, u.token, 'Ana');
  const svc = await createService(api, u.token, { announcedPrice: '45.00' });
  await joinSeat(api, u.token, svc.id, ana.id, { quota: '20.00' });
  const loan = (await api.post(u.token, '/bank-loans', { name: 'Personal' })).body;
  const chg = { installments: [{ number: 1, dueDate: '2026-11-01', principal: '80.00', interest: '20.00', insurance: null, fees: null, total: '100.00' }] };
  const pv = await api.post(u.token, `/bank-loans/${loan.id}/changes/preview`, chg);
  await api.post(u.token, `/bank-loans/${loan.id}/changes`, { ...chg, previewToken: pv.body.previewToken });
  const balances = async () => Object.fromEntries(((await api.get(u.token, '/accounts')).body.items as any[]).map((a) => [a.name, a.balance]));
  return { u, bcp, cash, ana, svc, loan, op, balances };
}
const backup = async (token: string, note?: string) => {
  const r = await api.post(token, '/backups', note ? { note } : {});
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
const restore = async (token: string, id: string, mode: 'replace' | 'merge') => {
  const pv = await api.post(token, `/backups/${id}/restore/preview`, { mode });
  expect(pv.status, JSON.stringify(pv.body)).toBe(200);
  return { pv: pv.body, r: await api.post(token, `/backups/${id}/restore`, { mode, previewToken: pv.body.previewToken }) };
};
const countOps = async (userId: string) => (await pool.query('select count(*)::int as n from financial_operation where owner_id = $1', [userId])).rows[0].n as number;

describe('Crear y verificar un respaldo (RN-BK01, BK05, BK08)', () => {
  it('guarda filas por tabla y saldos por cuenta, con hash de integridad', async () => {
    const w = await world();
    const b = await backup(w.u.token, 'Antes de probar');
    expect(b).toMatchObject({ kind: 'manual', formatVersion: 1, encrypted: false, note: 'Antes de probar' });
    expect(b.schemaVersion).toMatch(/^\d{4}_.+\.sql$/);
    expect(b.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.tables.account).toBe(2);
    expect(b.tables.financial_operation).toBeGreaterThanOrEqual(5);
    expect(b.tables.bank_loan).toBe(1);
    expect(b.tables.audit_event).toBeUndefined(); // bitácora, claves de idempotencia y consumo no se respaldan
    expect(b.balances[w.bcp.id]).toBe('3100.00');
    expect(b.balances[w.cash.id]).toBe('300.00');
    const list = (await api.get(w.u.token, '/backups')).body.items;
    expect(list.map((x: any) => x.id)).toEqual([b.id]);
    const dl = await api.app.inject({ method: 'GET', url: `/v1/backups/${b.id}/download`, headers: { authorization: `Bearer ${w.u.token}` } });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toContain('eva-respaldo-2026-10-12.eva-backup');
    expect(dl.rawPayload.length).toBe(b.sizeBytes);
  });

  it('un archivo alterado se rechaza por integridad', async () => {
    const w = await world();
    const b = await backup(w.u.token);
    const key = await fileOf(b.id);
    const parsed = JSON.parse(gunzipSync(await files.get(key)).toString('utf8'));
    parsed.data = parsed.data.replace('Sueldo', 'Sueldo!');
    await files.put(key, gzipSync(Buffer.from(JSON.stringify(parsed))));
    const pv = await api.post(w.u.token, `/backups/${b.id}/restore/preview`, { mode: 'replace' });
    expect(pv.status).toBe(422);
    expect(pv.body.error.code).toBe('BACKUP_CORRUPT');
  });

  it('es privado por usuario: no se ve, no se descarga, no se restaura ni se importa el de otro', async () => {
    const w = await world();
    const b = await backup(w.u.token);
    const other = await api.newUser();
    expect((await api.get(other.token, `/backups/${b.id}`)).status).toBe(404);
    expect((await api.post(other.token, `/backups/${b.id}/restore/preview`, { mode: 'replace' })).status).toBe(404);
    expect((await api.get(other.token, '/backups')).body.items).toEqual([]);
    const bytes = await files.get(await fileOf(b.id));
    const imp = await api.post(other.token, '/backups/import', { contentBase64: bytes.toString('base64') });
    expect(imp.status).toBe(422);
    expect(imp.body.error.code).toBe('BACKUP_OTHER_OWNER');
  });

  it('eliminar un respaldo borra su archivo', async () => {
    const w = await world();
    const b = await backup(w.u.token);
    const key = await fileOf(b.id);
    expect((await api.post(w.u.token, `/backups/${b.id}/delete`)).body).toMatchObject({ deleted: true });
    await expect(files.get(key)).rejects.toThrow();
    expect((await api.get(w.u.token, `/backups/${b.id}`)).status).toBe(404);
  });
});

describe('A26 · restaurar un respaldo (RN-BK06, BK07)', () => {
  it('reemplazar: los saldos coinciden con los del respaldo, hay copia de recuperación y no se crea nada nuevo', async () => {
    const w = await world();
    const before = await w.balances();
    const opsBefore = await countOps(w.u.id);
    const b = await backup(w.u.token);

    // Después del respaldo: otro gasto, una reversión, una cuenta y un contacto nuevos.
    const extra = await w.op('expense', w.bcp.id, '60.00', '2026-10-05', { description: 'Cena' });
    await w.op('income', w.cash.id, '15.00', '2026-10-06');
    await api.post(w.u.token, `/operations/${extra.id}/reverse`, { reason: 'Error' });
    await createAccount(api, w.u.token, 'Yape', '10.00', 'wallet', '2026-10-01');
    await createContact(api, w.u.token, 'Luis');
    expect(await w.balances()).not.toEqual(before);

    const { pv, r } = await restore(w.u.token, b.id, 'replace');
    expect(pv).toMatchObject({ mode: 'replace', valid: true, recoveryCopy: true });
    expect(pv.report.find((x: any) => x.table === 'account')).toMatchObject({ inBackup: 2, current: 3, willRemove: 3 });
    expect(pv.warnings.some((x: string) => x.includes('no crea ingresos ni gastos nuevos'))).toBe(true);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ restored: true, mode: 'replace', balancesMatch: true });

    expect(await w.balances()).toEqual(before); // saldos idénticos a los del respaldo
    expect(await countOps(w.u.id)).toBe(opsBefore); // ningún movimiento nuevo ni reactivado
    expect((await api.get(w.u.token, '/contacts')).body.items.map((c: any) => c.name)).toEqual(['Ana']);
    expect((await api.get(w.u.token, `/bank-loans/${w.loan.id}`)).body.installments).toHaveLength(1);

    // La copia de recuperación previa existe y contiene el estado de ANTES de restaurar.
    const rec = (await api.get(w.u.token, `/backups/${r.body.recoveryBackupId}`)).body;
    expect(rec).toMatchObject({ kind: 'recovery' });
    expect(rec.tables.account).toBe(3);
    // Se puede volver atrás restaurando la copia de recuperación.
    const back = await restore(w.u.token, rec.id, 'replace');
    expect(back.r.status, JSON.stringify(back.r.body)).toBe(200);
    expect((await api.get(w.u.token, '/contacts')).body.items.map((c: any) => c.name).sort()).toEqual(['Ana', 'Luis']);
  });

  it('lo revertido sigue revertido y los asientos siguen siendo inmutables después de restaurar', async () => {
    const w = await world();
    const bad = await w.op('expense', w.bcp.id, '99.00', '2026-10-04', { description: 'Error' });
    await api.post(w.u.token, `/operations/${bad.id}/reverse`, { reason: 'Error' });
    const b = await backup(w.u.token);
    await w.op('expense', w.bcp.id, '1.00', '2026-10-07');
    await restore(w.u.token, b.id, 'replace');
    expect((await api.get(w.u.token, `/operations/${bad.id}`)).body.status).toBe('reversed');
    await expect(pool.query('update account_entry set amount = 1 where owner_id = $1', [w.u.id])).rejects.toThrow(/immutable|mutation|forbid/i);
    await expect(pool.query('delete from account_entry where owner_id = $1', [w.u.id])).rejects.toThrow();
  });

  it('no toca los datos de otros usuarios', async () => {
    const w = await world();
    const o = await world();
    const otherBalances = await o.balances();
    const b = await backup(w.u.token);
    await w.op('expense', w.bcp.id, '5.00', '2026-10-08');
    await restore(w.u.token, b.id, 'replace');
    expect(await o.balances()).toEqual(otherBalances);
    expect((await api.get(o.u.token, '/contacts')).body.items).toHaveLength(1);
  });

  it('incorporar lo que falta: agrega lo ausente y conserva lo actual sin sobrescribir', async () => {
    const w = await world();
    const cat = (await api.post(w.u.token, '/categories', { name: 'Mascotas' })).body;
    const b = await backup(w.u.token);
    // Se pierde la categoría (borrado directo en la base) y se registra algo nuevo después del respaldo.
    await pool.query('delete from category where id = $1', [cat.id]);
    const late = await w.op('expense', w.bcp.id, '7.00', '2026-10-09', { description: 'Posterior' });
    const { pv, r } = await restore(w.u.token, b.id, 'merge');
    expect(pv.report.find((x: any) => x.table === 'category')).toMatchObject({ willAdd: 1 });
    expect(pv.report.find((x: any) => x.table === 'financial_operation').alreadyThere).toBeGreaterThan(0);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ mode: 'merge', balancesMatch: null });
    expect(r.body.inserted.category).toBe(1);
    expect(((await api.get(w.u.token, '/categories')).body.items as any[]).some((c) => c.name === 'Mascotas')).toBe(true);
    expect((await api.get(w.u.token, `/operations/${late.id}`)).status).toBe(200); // lo posterior se conserva
    // Repetir no duplica nada.
    const again = await restore(w.u.token, b.id, 'merge');
    expect(again.r.body.inserted.category).toBe(0);
    expect(again.r.body.inserted.financial_operation).toBe(0);
  });

  it('exige la vista previa vigente: si los datos cambian después, se pide revisarla de nuevo', async () => {
    const w = await world();
    const b = await backup(w.u.token);
    const pv = await api.post(w.u.token, `/backups/${b.id}/restore/preview`, { mode: 'replace' });
    await w.op('expense', w.bcp.id, '3.00', '2026-10-09');
    const r = await api.post(w.u.token, `/backups/${b.id}/restore`, { mode: 'replace', previewToken: pv.body.previewToken });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PREVIEW_STALE');
    const noToken = await api.post(w.u.token, `/backups/${b.id}/restore`, { mode: 'replace', previewToken: 'x'.repeat(20) });
    expect(noToken.status).toBe(422);
  });

  it('un respaldo de un esquema más nuevo se rechaza con un mensaje claro; uno anterior se migra (RN-BK09)', async () => {
    const w = await world();
    const b = await backup(w.u.token);
    const bytes = await files.get(await fileOf(b.id));
    const edit = (fn: (p: any) => void) => { const p = JSON.parse(gunzipSync(bytes).toString('utf8')); fn(p); return gzipSync(Buffer.from(JSON.stringify(p))).toString('base64'); };
    const newer = await api.post(w.u.token, '/backups/import', { contentBase64: edit((p) => { p.manifest.schemaVersion = '9999_futuro.sql'; }) });
    expect(newer.body.error.code).toBe('BACKUP_NEWER_SCHEMA');
    const fmt = await api.post(w.u.token, '/backups/import', { contentBase64: edit((p) => { p.manifest.formatVersion = 99; }) });
    expect(fmt.body.error.code).toBe('BACKUP_NEWER_FORMAT');
    // Esquema anterior con una columna que ya no existe: se ignora al insertar.
    const older = await api.post(w.u.token, '/backups/import', {
      contentBase64: edit((p) => {
        p.manifest.schemaVersion = '0101_antiguo.sql';
        const d = JSON.parse(p.data);
        for (const row of d.tables.contact) row.columna_que_ya_no_existe = 'x';
        p.data = JSON.stringify(d);
        p.manifest.dataHash = require('node:crypto').createHash('sha256').update(p.data).digest('hex');
        p.manifest.tables.contact.columns.push('columna_que_ya_no_existe');
      }),
    });
    expect(older.status, JSON.stringify(older.body)).toBe(201);
    expect(older.body).toMatchObject({ kind: 'imported', schemaVersion: '0101_antiguo.sql' });
    const { pv, r } = await restore(w.u.token, older.body.id, 'replace');
    expect(pv.warnings.some((x: string) => x.includes('esquema anterior'))).toBe(true);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('restaurar a mano: descargar el archivo y volver a importarlo', async () => {
    const w = await world();
    const before = await w.balances();
    const b = await backup(w.u.token);
    const bytes = await files.get(await fileOf(b.id));
    await w.op('expense', w.bcp.id, '10.00', '2026-10-09');
    const imp = await api.post(w.u.token, '/backups/import', { contentBase64: bytes.toString('base64') });
    expect(imp.status).toBe(201);
    const { r } = await restore(w.u.token, imp.body.id, 'replace');
    expect(r.body.balancesMatch).toBe(true);
    expect(await w.balances()).toEqual(before);
    expect((await api.post(w.u.token, '/backups/import', { contentBase64: Buffer.from('no es un respaldo').toString('base64') })).body.error.code).toBe('BACKUP_CORRUPT');
  });
});

describe('Cifrado en reposo (RN-BK05)', () => {
  it('con clave el archivo no se puede leer sin ella y restaura bien con ella', async () => {
    const store = createMemoryStore();
    const key = randomBytes(32).toString('hex');
    const enc = makeApi({ files: store, env: { BACKUP_ENCRYPTION_KEY: key } });
    enc.setNow(new Date('2026-10-12T17:00:00Z'));
    const u = await enc.newUser();
    const acc = await createAccount(enc, u.token, 'BCP', '100.00', 'bank', '2026-09-01');
    const b = (await enc.post(u.token, '/backups', {})).body;
    expect(b.encrypted).toBe(true);
    const bytes = await store.get((await pool.query('select file_key from backup where id = $1', [b.id])).rows[0].file_key);
    expect(bytes.subarray(0, 7).toString()).toBe('EVAENC1');
    expect(bytes.toString('utf8')).not.toContain('BCP');
    expect(() => gunzipSync(bytes)).toThrow();
    const pv = await enc.post(u.token, `/backups/${b.id}/restore/preview`, { mode: 'replace' });
    expect(pv.status).toBe(200);
    // Otro servidor con el mismo almacenamiento pero SIN la clave no puede abrirlo.
    const plain = makeApi({ files: store });
    plain.setNow(new Date('2026-10-12T17:00:00Z'));
    const denied = await plain.post(u.token, `/backups/${b.id}/restore/preview`, { mode: 'replace' });
    expect(denied.body.error.code).toBe('BACKUP_KEY_REQUIRED');
    void acc;
    await enc.app.close(); await plain.app.close();
  });

  it('una clave mal formada impide arrancar la configuración', () => {
    expect(() => makeApi({ env: { BACKUP_ENCRYPTION_KEY: 'corta' } })).toThrow(/BACKUP_ENCRYPTION_KEY/);
  });
});

describe('Copias automáticas (RN-BK03, BK04)', () => {
  const env = (now: Date, only: string[]) => ({ db: (api.app as any).db ?? undefined, now: () => now, timeZone: 'America/Lima', previewSecret: 'x'.repeat(40), backup: { files, key: null }, only });
  void env;
  async function runner(userId: string, now: Date) {
    const { createKysely } = await import('../../src/infra/db/db.js');
    return runDueBackups({ db: createKysely(pool), now: () => now, timeZone: 'America/Lima', previewSecret: 'x'.repeat(40), backup: { files, key: null }, only: [userId] });
  }

  it('crea la copia cuando toca, no antes, y conserva solo las últimas según la retención', async () => {
    const w = await world();
    await put(w.u.token, { backup: { frequency: 'weekly', keep: 1 } });
    const d0 = new Date('2026-10-12T17:00:00Z');
    expect((await runner(w.u.id, d0))[0]).toMatchObject({ created: true, pruned: 0 });
    expect((await runner(w.u.id, new Date('2026-10-15T17:00:00Z')))[0]).toMatchObject({ created: false }); // aún no pasa una semana
    const second = (await runner(w.u.id, new Date('2026-10-20T17:00:00Z')))[0]!;
    expect(second).toMatchObject({ created: true, pruned: 1 }); // keep = 1: la anterior se elimina DESPUÉS de verificar la nueva
    const autos = (await api.get(w.u.token, '/backups')).body.items.filter((x: any) => x.kind === 'auto');
    expect(autos.map((x: any) => x.id)).toEqual([second.backupId]);
  });

  it('las copias manuales no se podan y «apagado» no genera nada', async () => {
    const w = await world();
    await backup(w.u.token);
    await put(w.u.token, { backup: { frequency: 'monthly', keep: 2 } });
    expect((await runner(w.u.id, new Date('2026-10-12T17:00:00Z')))[0]).toMatchObject({ created: true });
    expect((await runner(w.u.id, new Date('2026-10-30T17:00:00Z')))[0]).toMatchObject({ created: false }); // mensual: 18 días no bastan
    await put(w.u.token, { backup: { frequency: 'off', keep: 2 } });
    expect((await runner(w.u.id, new Date('2027-02-01T17:00:00Z')))[0]).toMatchObject({ created: false });
    expect((await api.get(w.u.token, '/backups')).body.items.map((x: any) => x.kind).sort()).toEqual(['auto', 'manual']);
  });

  it('el trabajo diario exige su secreto y no existe si no se configura', async () => {
    const none = await api.call({ method: 'POST', url: '/jobs/daily', headers: { 'x-cron-secret': 'cualquiera-cualquiera' } });
    expect(none.status).toBe(404);
    const a = makeApi({ files, env: { CRON_SECRET: 'secreto-del-trabajo-1234' } });
    expect((await a.call({ method: 'POST', url: '/jobs/daily', headers: { 'x-cron-secret': 'incorrecto-incorrecto' } })).status).toBe(401);
    expect((await a.call({ method: 'POST', url: '/jobs/daily' })).status).toBe(401);
    await a.app.close();
  });
});
