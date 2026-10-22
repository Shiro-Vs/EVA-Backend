import { afterAll, describe, expect, it } from 'vitest';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';

const api = makeApi();
afterAll(async () => { await api.app.close(); await pool.end(); });

const netflix = {
  name: 'Netflix', provider: 'Netflix', mode: 'shared', capacity: 4, announcedPrice: '45.00',
  interval: { unit: 'month', count: 1 }, startDate: '2026-10-07', nextPaymentDate: '2026-11-07',
};

async function create(token: string, over: Record<string, unknown> = {}, confirm = false) {
  const body = { ...netflix, ...over };
  const pv = await api.post(token, '/subscriptions/preview', body);
  expect(pv.status, JSON.stringify(pv.body)).toBe(200);
  return api.post(token, '/subscriptions', { ...body, previewToken: pv.body.previewToken, ...(confirm ? { confirmCalendarMismatch: true } : {}) });
}

describe('vista previa de servicio (A01, RN-C03, RN-P03)', () => {
  it('coincide el calendario y sugiere la cuota (45 / 4 → 12.00)', async () => {
    const u = await api.newUser();
    const r = await api.post(u.token, '/subscriptions/preview', { ...netflix, occupiedSeats: 4 });
    expect(r.status).toBe(200);
    expect(r.body.calendar).toEqual({ ok: true, expectedNextPayment: '2026-11-07', diffDays: 0 });
    expect(r.body.suggestedQuota).toMatchObject({ amount: '12.00', occupiedSeats: 4 });
    expect(r.body.cycles).toEqual([
      { seq: 1, startDate: '2026-10-07', endDate: '2026-11-07' },
      { seq: 2, startDate: '2026-11-07', endDate: '2026-12-07' },
    ]);
    expect(r.body.baseDays).toBe(30);
    const alone = await api.post(u.token, '/subscriptions/preview', netflix);
    expect(alone.body.suggestedQuota.amount).toBe('45.00');
  });

  it('avisa cuando el proveedor informa otra fecha', async () => {
    const u = await api.newUser();
    const r = await api.post(u.token, '/subscriptions/preview', { ...netflix, nextPaymentDate: '2026-11-09' });
    expect(r.body.calendar).toEqual({ ok: false, expectedNextPayment: '2026-11-07', diffDays: 2 });
  });
});

describe('alta de servicio (corte 2.3)', () => {
  it('crea servicio, términos, ciclos 1 y 2 y la plaza del administrador', async () => {
    const u = await api.newUser();
    const r = await create(u.token);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      name: 'Netflix', mode: 'shared', capacity: 4, occupiedSeats: 1, status: 'active', currency: 'PEN',
      terms: { announcedPrice: '45.00', interval: { unit: 'month', count: 1 }, anchor: '2026-10-07' }, // coincide con lo calculado: el ancla conserva el día original (D-02)
      currentCycle: { seq: 1, startDate: '2026-10-07', endDate: '2026-11-07', announcedPrice: '45.00', baseDays: 30 },
      nextCycle: { seq: 2, startDate: '2026-11-07', endDate: '2026-12-07' },
    });
  });

  it('exige previewToken y que las entradas coincidan con la vista previa', async () => {
    const u = await api.newUser();
    const none = await api.post(u.token, '/subscriptions', { ...netflix, previewToken: 'x'.repeat(20) });
    expect(none.body.error.code).toBe('PREVIEW_INVALID');
    const pv = await api.post(u.token, '/subscriptions/preview', netflix);
    const changed = await api.post(u.token, '/subscriptions', { ...netflix, announcedPrice: '50.00', previewToken: pv.body.previewToken });
    expect(changed.status).toBe(422);
    expect(changed.body.error.code).toBe('PREVIEW_MISMATCH');
    const otherUser = await api.newUser();
    const stolen = await api.post(otherUser.token, '/subscriptions', { ...netflix, previewToken: pv.body.previewToken });
    expect(stolen.body.error.code).toBe('PREVIEW_INVALID');
  });

  it('el token de vista previa caduca a los 10 minutos → PREVIEW_STALE', async () => {
    const u = await api.newUser();
    const pv = await api.post(u.token, '/subscriptions/preview', netflix);
    api.setNow(new Date('2026-10-12T17:11:00Z'));
    const late = await api.post(u.token, '/subscriptions', { ...netflix, previewToken: pv.body.previewToken });
    api.setNow(new Date('2026-10-12T17:00:00Z'));
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('PREVIEW_STALE');
  });

  it('una fecha distinta exige confirmación explícita (RN-C03); con ella prevalece la del proveedor', async () => {
    const u = await api.newUser();
    const blocked = await create(u.token, { nextPaymentDate: '2026-11-09' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('CALENDAR_MISMATCH_UNCONFIRMED');
    expect(blocked.body.error.details).toMatchObject({ expectedNextPayment: '2026-11-07', diffDays: 2 });
    const ok = await create(u.token, { nextPaymentDate: '2026-11-09' }, true);
    expect(ok.status).toBe(201);
    expect(ok.body.currentCycle).toMatchObject({ startDate: '2026-10-07', endDate: '2026-11-09' });
    expect(ok.body.nextCycle.startDate).toBe('2026-11-09');
    expect(ok.body.nextCycle.endDate).toBe('2026-12-09'); // el ancla pasa a ser el 9
  });

  it('un servicio personal tiene capacidad 1 y rechaza fechas incoherentes', async () => {
    const u = await api.newUser();
    const personal = await create(u.token, { mode: 'personal', capacity: 5, name: 'ChatGPT' });
    expect(personal.body).toMatchObject({ mode: 'personal', capacity: 1 });
    const bad = await api.post(u.token, '/subscriptions/preview', { ...netflix, nextPaymentDate: '2026-10-01' });
    expect(bad.status).toBe(422);
  });

  it('ancla 31: febrero vence el 28 y marzo vuelve al 31 (D-02)', async () => {
    const u = await api.newUser();
    api.setNow(new Date('2026-02-10T17:00:00Z'));
    const r = await create(u.token, { name: 'Plan fin de mes', startDate: '2026-01-31', nextPaymentDate: '2026-02-28' });
    expect(r.status, JSON.stringify(r.body)).toBe(201); // 28-feb coincide con lo calculado: no pide confirmación
    expect(r.body.currentCycle).toMatchObject({ startDate: '2026-01-31', endDate: '2026-02-28' });
    // El ancla conserva el día 31: el ciclo que empieza el 28-feb termina el 31-mar, no el 28.
    expect(r.body.nextCycle).toMatchObject({ startDate: '2026-02-28', endDate: '2026-03-31' });
    api.setNow(new Date('2026-10-12T17:00:00Z'));
  });

  it('las preferencias de otra cuenta ajena devuelven 404', async () => {
    const u1 = await api.newUser();
    const u2 = await api.newUser();
    const acc = (await api.post(u1.token, '/accounts', { name: 'BCP', type: 'bank' })).body;
    const r = await create(u2.token, { preferredAccountId: acc.id });
    expect(r.status).toBe(404);
  });
});

describe('ciclos: generación perezosa e idempotente (A28c, RN-C11)', () => {
  it('avanzar el reloj genera los ciclos que faltan, sin huecos ni duplicados', async () => {
    const u = await api.newUser();
    const s = (await create(u.token)).body;
    api.setNow(new Date('2027-01-20T17:00:00Z'));
    const cycles = (await api.get(u.token, `/subscriptions/${s.id}/cycles`)).body.items.slice().reverse();
    api.setNow(new Date('2026-10-12T17:00:00Z'));
    expect(cycles.map((c: any) => c.seq)).toEqual(cycles.map((_: any, i: number) => i + 1));
    for (let i = 1; i < cycles.length; i++) expect(cycles[i].startDate).toBe(cycles[i - 1].endDate);
    expect(cycles.at(-1).startDate > '2027-01-20').toBe(true);
    expect(cycles.at(-2).startDate <= '2027-01-20').toBe(true);
  });

  it('dos generaciones simultáneas producen un único conjunto de ciclos', async () => {
    const u = await api.newUser();
    const s = (await create(u.token)).body;
    const [a, b] = await Promise.all([
      api.post(u.token, `/subscriptions/${s.id}/cycles/generate`, { ahead: 3 }),
      api.post(u.token, `/subscriptions/${s.id}/cycles/generate`, { ahead: 3 }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const list = (await api.get(u.token, `/subscriptions/${s.id}/cycles`)).body.items;
    expect(list).toHaveLength(4); // en curso + 3 por adelantado
    expect(new Set(list.map((c: any) => c.startDate)).size).toBe(4);
    expect(a.body.created + b.body.created).toBe(2); // 1 ya existía; los otros 2 se crean una sola vez
  });

  it('generar por adelantado es idempotente con la misma clave', async () => {
    const u = await api.newUser();
    const s = (await create(u.token)).body;
    const key = 'clave-fija-12345678';
    const r1 = await api.post(u.token, `/subscriptions/${s.id}/cycles/generate`, { ahead: 2 }, { 'idempotency-key': key });
    const r2 = await api.post(u.token, `/subscriptions/${s.id}/cycles/generate`, { ahead: 2 }, { 'idempotency-key': key });
    expect(r2.body).toEqual(r1.body);
    expect(r1.body.created).toBe(1);
  });

  it('un servicio ajeno responde 404', async () => {
    const u1 = await api.newUser();
    const u2 = await api.newUser();
    const s = (await create(u1.token)).body;
    expect((await api.get(u2.token, `/subscriptions/${s.id}`)).status).toBe(404);
    expect((await api.get(u2.token, `/subscriptions/${s.id}/cycles`)).status).toBe(404);
    expect((await api.post(u2.token, `/subscriptions/${s.id}/cycles/generate`, { ahead: 1 })).status).toBe(404);
  });
});

describe('lista, edición y archivado', () => {
  it('lista con ocupación; PATCH con versión; archivar', async () => {
    const u = await api.newUser();
    const s = (await create(u.token)).body;
    const list = (await api.get(u.token, '/subscriptions')).body.items;
    expect(list).toHaveLength(1);
    expect(list[0].occupiedSeats).toBe(1);
    const p = await api.patch(u.token, `/subscriptions/${s.id}`, { name: 'Netflix Premium', color: '#E50914' }, s.version);
    expect(p.body).toMatchObject({ name: 'Netflix Premium', color: '#E50914' });
    expect((await api.patch(u.token, `/subscriptions/${s.id}`, { name: 'X' }, s.version)).status).toBe(409);
    const arch = await api.post(u.token, `/subscriptions/${s.id}/archive`);
    expect(arch.body.status).toBe('archived');
    expect((await api.get(u.token, '/subscriptions')).body.items).toHaveLength(0);
  });
});
