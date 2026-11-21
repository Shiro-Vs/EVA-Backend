import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';

const api = makeApi();
afterAll(async () => { await api.app.close(); await pool.end(); });

const mkAccount = async (token: string, name: string, type: string, opening?: string) => {
  const r = await api.post(token, '/accounts', { name, type, ...(opening ? { openingBalance: { amount: opening } } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};

describe('autenticación (corte 1.5)', () => {
  it('sin token o con token inválido → 401 con formato uniforme', async () => {
    const r1 = await api.call({ method: 'GET', url: '/v1/me' });
    expect(r1.status).toBe(401);
    expect(r1.body.error).toMatchObject({ code: 'UNAUTHENTICATED', requestId: expect.any(String) });
    const r2 = await api.call({ method: 'GET', url: '/v1/me', token: 'abc.def.ghi' });
    expect(r2.status).toBe(401);
  });

  it('el perfil se crea en el primer acceso y el propietario sale del token', async () => {
    const u = await api.newUser('Ana Admin');
    const r = await api.get(u.token, '/me');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: u.id, displayName: 'Ana Admin', timezone: 'America/Lima', currency: 'PEN', defaultFreeDays: 0, exitDaysLimit: null });
    expect(r.headers.etag).toBe('"1"');
  });

  it('PATCH /me exige If-Match y detecta versión obsoleta', async () => {
    const u = await api.newUser();
    const me = (await api.get(u.token, '/me')).body;
    const noHeader = await api.call({ method: 'PATCH', url: '/v1/me', token: u.token, body: { defaultFreeDays: 7 } });
    expect(noHeader.status).toBe(428);
    const ok = await api.patch(u.token, '/me', { defaultFreeDays: 7, exitDaysLimit: 7 }, me.version);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ defaultFreeDays: 7, exitDaysLimit: 7, version: 2 });
    const stale = await api.patch(u.token, '/me', { defaultFreeDays: 3 }, me.version);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT_VERSION');
  });

  it('rechaza campos desconocidos y valores inválidos con VALIDATION_ERROR', async () => {
    const u = await api.newUser();
    const me = (await api.get(u.token, '/me')).body;
    const r = await api.patch(u.token, '/me', { defaultFreeDays: -1, foo: 1 }, me.version);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect(r.body.error.details.length).toBeGreaterThan(0);
  });

  it('PATCH /me permite actualizar nombre y foto de perfil (avatarDataUrl) y quitarla', async () => {
    const u = await api.newUser('Ana');
    const me = (await api.get(u.token, '/me')).body;
    expect(me.avatarUrl).toBeNull();
    const img = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const bad = await api.patch(u.token, '/me', { avatarDataUrl: 'https://evil.test/x.svg' }, me.version);
    expect(bad.status).toBe(422);
    const up = await api.patch(u.token, '/me', { displayName: 'Ana María', avatarDataUrl: img }, me.version);
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ displayName: 'Ana María', avatarUrl: img });
    const cleared = await api.patch(u.token, '/me', { avatarDataUrl: null }, up.body.version);
    expect(cleared.status).toBe(200);
    expect(cleared.body.avatarUrl).toBeNull();
  });
});

describe('cuentas y operaciones (corte 1.3, 1.4)', () => {
  it('saldo inicial como apertura; el saldo es la suma de asientos', async () => {
    const u = await api.newUser();
    const bcp = await mkAccount(u.token, 'BCP', 'bank', '200.00');
    expect(bcp.balance).toBe('200.00');
    const efectivo = await mkAccount(u.token, 'Efectivo', 'cash');
    expect(efectivo.balance).toBe('0.00');
    const tarjeta = await mkAccount(u.token, 'Tarjeta', 'credit', '-100.00');
    expect(tarjeta.balance).toBe('-100.00');
    const list = await api.get(u.token, '/accounts');
    expect(list.body.items.map((a: any) => a.name).sort()).toEqual(['BCP', 'Efectivo', 'Tarjeta']);
  });

  it('valida el signo del saldo inicial según el tipo de cuenta', async () => {
    const u = await api.newUser();
    const credit = await api.post(u.token, '/accounts', { name: 'T', type: 'credit', openingBalance: { amount: '50.00' } });
    const bank = await api.post(u.token, '/accounts', { name: 'B', type: 'bank', openingBalance: { amount: '-50.00' } });
    expect(credit.status).toBe(422);
    expect(bank.status).toBe(422);
  });

  it('una transferencia mueve el saldo entre cuentas y no es ingreso ni gasto (A19, paso 2)', async () => {
    const u = await api.newUser();
    const bcp = await mkAccount(u.token, 'BCP', 'bank', '200.00');
    const tarjeta = await mkAccount(u.token, 'Tarjeta', 'credit', '-147.00');
    const r = await api.post(u.token, '/operations', { kind: 'transfer', accountId: bcp.id, toAccountId: tarjeta.id, amount: '47.00', description: 'Pago de tarjeta' });
    expect(r.status).toBe(201);
    expect(r.body.entries.map((e: any) => e.amount).sort()).toEqual(['-47.00', '47.00']);
    expect((await api.get(u.token, `/accounts/${bcp.id}`)).body.balance).toBe('153.00');
    expect((await api.get(u.token, `/accounts/${tarjeta.id}`)).body.balance).toBe('-100.00');
  });

  it('ingreso y gasto; el historial de la cuenta trae el saldo acumulado', async () => {
    const u = await api.newUser();
    const a = (await api.post(u.token, '/accounts', { name: 'BCP', type: 'bank', openingBalance: { amount: '200.00', date: '2026-10-01' } })).body;
    await api.post(u.token, '/operations', { kind: 'expense', accountId: a.id, amount: '47.00', date: '2026-10-10' });
    await api.post(u.token, '/operations', { kind: 'income', accountId: a.id, amount: '10.25', date: '2026-10-11' });
    const e = await api.get(u.token, `/accounts/${a.id}/entries`);
    expect(e.body.items.map((x: any) => [x.amount, x.balanceAfter])).toEqual([['10.25', '163.25'], ['-47.00', '153.00'], ['200.00', '200.00']]);
    expect(e.body.nextCursor).toBeNull();
  });

  it('no se permite fecha futura ni cuenta archivada ni importe no positivo', async () => {
    const u = await api.newUser();
    const a = await mkAccount(u.token, 'BCP', 'bank', '10.00');
    const fut = await api.post(u.token, '/operations', { kind: 'income', accountId: a.id, amount: '5.00', date: '2026-10-13' });
    expect(fut.body.error.code).toBe('FUTURE_DATE_NOT_ALLOWED');
    const zero = await api.post(u.token, '/operations', { kind: 'income', accountId: a.id, amount: '0.00' });
    expect(zero.body.error.code).toBe('VALIDATION_ERROR');
    const arch = await api.post(u.token, `/accounts/${a.id}/archive`);
    expect(arch.body.warnings).toEqual(['ACCOUNT_HAS_BALANCE']);
    const onArch = await api.post(u.token, '/operations', { kind: 'income', accountId: a.id, amount: '5.00' });
    expect(onArch.body.error.code).toBe('ACCOUNT_ARCHIVED');
  });

  it('revertir crea la operación contraria y no borra evidencia (RN-V05)', async () => {
    const u = await api.newUser();
    const a = await mkAccount(u.token, 'BCP', 'bank', '100.00');
    const op = (await api.post(u.token, '/operations', { kind: 'expense', accountId: a.id, amount: '30.00' })).body;
    expect((await api.get(u.token, `/accounts/${a.id}`)).body.balance).toBe('70.00');
    const rev = await api.post(u.token, `/operations/${op.id}/reverse`, { reason: 'Error de digitación' });
    expect(rev.status).toBe(201);
    expect(rev.body).toMatchObject({ kind: 'reversal', reversalOfId: op.id, reason: 'Error de digitación' });
    expect((await api.get(u.token, `/accounts/${a.id}`)).body.balance).toBe('100.00');
    expect((await api.get(u.token, `/operations/${op.id}`)).body.status).toBe('reversed');
    const again = await api.post(u.token, `/operations/${op.id}/reverse`, { reason: 'otra vez' });
    expect(again.body.error.code).toBe('ALREADY_REVERSED');
    const entries = (await api.get(u.token, `/accounts/${a.id}/entries`)).body.items;
    expect(entries).toHaveLength(3); // apertura + gasto + reversión: nada se borró
  });

  it('PATCH de cuenta con control de versión y una sola cuenta predeterminada', async () => {
    const u = await api.newUser();
    const a = await mkAccount(u.token, 'BCP', 'bank');
    const b = await mkAccount(u.token, 'Efectivo', 'cash');
    const p1 = await api.patch(u.token, `/accounts/${a.id}`, { isDefault: true }, a.version);
    expect(p1.body.isDefault).toBe(true);
    const p2 = await api.patch(u.token, `/accounts/${b.id}`, { isDefault: true, name: 'Caja' }, b.version);
    expect(p2.status).toBe(200);
    const list = (await api.get(u.token, '/accounts')).body.items;
    expect(list.filter((x: any) => x.isDefault).map((x: any) => x.name)).toEqual(['Caja']);
    const stale = await api.patch(u.token, `/accounts/${a.id}`, { name: 'X' }, a.version);
    expect(stale.body.error.code).toBe('CONFLICT_VERSION');
  });
});

describe('idempotencia (13 §1.1; A22 parte E1)', () => {
  it('la misma clave y cuerpo devuelve la misma respuesta y el saldo cambia una sola vez', async () => {
    const u = await api.newUser();
    const a = await mkAccount(u.token, 'BCP', 'bank', '100.00');
    const key = randomUUID();
    const body = { kind: 'income', accountId: a.id, amount: '25.00' };
    const r1 = await api.post(u.token, '/operations', body, { 'idempotency-key': key });
    const r2 = await api.post(u.token, '/operations', body, { 'idempotency-key': key });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body).toEqual(r1.body);
    expect(r2.headers['idempotency-replayed']).toBe('true');
    expect((await api.get(u.token, `/accounts/${a.id}`)).body.balance).toBe('125.00');
  });

  it('la misma clave con otro cuerpo → IDEMPOTENCY_KEY_REUSED; sin clave → IDEMPOTENCY_KEY_REQUIRED', async () => {
    const u = await api.newUser();
    const a = await mkAccount(u.token, 'BCP', 'bank', '100.00');
    const key = randomUUID();
    await api.post(u.token, '/operations', { kind: 'income', accountId: a.id, amount: '25.00' }, { 'idempotency-key': key });
    const reused = await api.post(u.token, '/operations', { kind: 'income', accountId: a.id, amount: '26.00' }, { 'idempotency-key': key });
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const none = await api.call({ method: 'POST', url: '/v1/operations', token: u.token, body: { kind: 'income', accountId: a.id, amount: '1.00' } });
    expect(none.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('una petición fallida no guarda la clave: se puede reintentar corregida', async () => {
    const u = await api.newUser();
    const a = await mkAccount(u.token, 'BCP', 'bank', '100.00');
    const key = randomUUID();
    const bad = await api.post(u.token, '/operations', { kind: 'income', accountId: a.id, amount: '5.00', date: '2027-01-01' }, { 'idempotency-key': key });
    expect(bad.status).toBe(422);
    const good = await api.post(u.token, '/operations', { kind: 'income', accountId: a.id, amount: '5.00', date: '2026-10-12' }, { 'idempotency-key': key });
    // Otro cuerpo con la misma clave tras un fallo: el fallo no dejó registro, así que se acepta.
    expect(good.status).toBe(201);
  });

  it('dos peticiones idénticas simultáneas producen un solo efecto (A28b)', async () => {
    const u = await api.newUser();
    const a = await mkAccount(u.token, 'BCP', 'bank', '0.00');
    const key = randomUUID();
    const body = { kind: 'income', accountId: a.id, amount: '40.00' };
    const [r1, r2] = await Promise.all([
      api.post(u.token, '/operations', body, { 'idempotency-key': key }),
      api.post(u.token, '/operations', body, { 'idempotency-key': key }),
    ]);
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(r1.body.id).toBe(r2.body.id);
    expect((await api.get(u.token, `/accounts/${a.id}`)).body.balance).toBe('40.00');
  });
});

describe('aislamiento entre usuarios (A27)', () => {
  it('U2 no puede leer, operar ni referenciar datos de U1: 404 y ninguna fila creada', async () => {
    const u1 = await api.newUser('U1');
    const u2 = await api.newUser('U2');
    const acc1 = await mkAccount(u1.token, 'BCP U1', 'bank', '500.00');
    const ct1 = (await api.post(u1.token, '/contacts', { name: 'Ana de U1' })).body;
    const acc2 = await mkAccount(u2.token, 'BCP U2', 'bank', '10.00');

    expect((await api.get(u2.token, `/accounts/${acc1.id}`)).status).toBe(404);
    expect((await api.get(u2.token, `/accounts/${acc1.id}/entries`)).status).toBe(404);
    expect((await api.get(u2.token, `/contacts/${ct1.id}`)).status).toBe(404);

    const op = await api.post(u2.token, '/operations', { kind: 'income', accountId: acc1.id, amount: '1.00' });
    expect(op.status).toBe(404);
    const withForeignContact = await api.post(u2.token, '/operations', { kind: 'income', accountId: acc2.id, amount: '1.00', contactId: ct1.id });
    expect(withForeignContact.status).toBe(404);
    const transfer = await api.post(u2.token, '/operations', { kind: 'transfer', accountId: acc2.id, toAccountId: acc1.id, amount: '1.00' });
    expect(transfer.status).toBe(404);

    // Nada cambió
    expect((await api.get(u1.token, `/accounts/${acc1.id}`)).body.balance).toBe('500.00');
    expect((await api.get(u2.token, `/accounts/${acc2.id}`)).body.balance).toBe('10.00');
    expect((await api.get(u2.token, '/accounts')).body.items).toHaveLength(1);
    expect((await api.get(u2.token, '/contacts')).body.items).toHaveLength(0);
  });
});

describe('contactos', () => {
  it('CRUD, versión y archivado', async () => {
    const u = await api.newUser();
    const c = (await api.post(u.token, '/contacts', { name: '  Ana  ', phone: '999111222' })).body;
    expect(c).toMatchObject({ name: 'Ana', activeSeats: 0, totals: { pending: '0.00', overdue: '0.00', creditFree: '0.00', creditReserved: '0.00' } });
    const p = await api.patch(u.token, `/contacts/${c.id}`, { name: 'Ana María', notes: 'Prima' }, c.version);
    expect(p.body).toMatchObject({ name: 'Ana María', notes: 'Prima', phone: '999111222', version: 2 });
    const stale = await api.patch(u.token, `/contacts/${c.id}`, { name: 'X' }, 1);
    expect(stale.status).toBe(409);
    const arch = await api.post(u.token, `/contacts/${c.id}/archive`);
    expect(arch.body.contact.status).toBe('archived');
    expect((await api.get(u.token, '/contacts?status=active')).body.items).toHaveLength(0);
  });
});
