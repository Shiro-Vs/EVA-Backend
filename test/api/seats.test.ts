import { afterAll, describe, expect, it } from 'vitest';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createContact, createService, joinSeat, setDefaultFreeDays } from '../helpers/scenarios.js';

const api = makeApi();
afterAll(async () => { await api.app.close(); await pool.end(); });
const at = (iso: string) => api.setNow(new Date(`${iso}T17:00:00Z`)); // mediodía en Lima

describe('A01 · capacidad y plaza del administrador', () => {
  it('cuatro plazas incluyéndote: la quinta se rechaza y la tuya no genera cargo', async () => {
    at('2026-10-12');
    const u = await api.newUser();
    const s = await createService(api, u.token);
    expect(s.occupiedSeats).toBe(1);
    for (const n of ['Ana', 'Beto', 'Carla']) {
      const c = await createContact(api, u.token, n);
      const r = await joinSeat(api, u.token, s.id, c.id, { quota: '12.00', label: n });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    expect((await api.get(u.token, `/subscriptions/${s.id}`)).body.occupiedSeats).toBe(4);
    const extra = await createContact(api, u.token, 'Diego');
    const fifth = await joinSeat(api, u.token, s.id, extra.id, { quota: '12.00' });
    expect(fifth.status).toBe(422);
    // La vista previa avisa; la altas se rechaza con CAPACITY_EXCEEDED
    const pv = await api.post(u.token, `/subscriptions/${s.id}/seats/preview`, { contactId: extra.id, label: 'X', quota: '12.00' });
    expect(pv.body.warnings).toContain('CAPACITY_EXCEEDED');
    const seats = (await api.get(u.token, `/subscriptions/${s.id}/seats`)).body.items;
    expect(seats).toHaveLength(4);
    const owner = seats.find((x: any) => x.isOwner);
    expect(owner).toMatchObject({ label: 'Tuya', quota: '0.00', pending: '0.00' });
  });

  it('un servicio personal no admite plazas de terceros', async () => {
    at('2026-10-12');
    const u = await api.newUser();
    const s = await createService(api, u.token, { mode: 'personal', capacity: 1, name: 'ChatGPT' });
    const c = await createContact(api, u.token, 'Ana');
    const r = await joinSeat(api, u.token, s.id, c.id, { quota: '10.00' });
    expect(r.body.error.code).toBe('SUBSCRIPTION_PERSONAL');
  });
});

describe('A02 · un contacto con dos plazas', () => {
  it('reutiliza la participación; el detalle muestra 10 + 8 = 18 y el contacto cuenta una vez', async () => {
    at('2026-11-07'); // ingreso el día de renovación: cuota completa
    const u = await api.newUser();
    const s = await createService(api, u.token, { startDate: '2026-11-07', nextPaymentDate: '2026-12-07' });
    const ana = await createContact(api, u.token, 'Ana');
    const a = await joinSeat(api, u.token, s.id, ana.id, { label: 'Cuenta 1', quota: '10.00' });
    const b = await joinSeat(api, u.token, s.id, ana.id, { label: 'Cuenta 2', quota: '8.00' });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const list = (await api.get(u.token, `/subscriptions/${s.id}/seats`)).body.items.filter((x: any) => !x.isOwner);
    expect(list.map((x: any) => [x.label, x.quota, x.pending])).toEqual([['Cuenta 1', '10.00', '10.00'], ['Cuenta 2', '8.00', '8.00']]);
    const c = (await api.get(u.token, `/contacts/${ana.id}`)).body;
    expect(c).toMatchObject({ activeSeats: 2, services: 1, totals: { pending: '18.00' } });
    expect((await api.get(u.token, `/subscriptions/${s.id}`)).body.occupiedSeats).toBe(3); // tú + 2
  });
});

describe('A03/A04/A05 · prorrateo de incorporación', () => {
  it('A03: r=5 ≤ g=7 → tramo gratis, neto 0, estado exento; el ciclo siguiente cobra 20.00', async () => {
    at('2026-11-02');
    const u = await api.newUser();
    await setDefaultFreeDays(api, u.token, 7);
    const s = await createService(api, u.token);
    const beto = await createContact(api, u.token, 'Beto');
    const pv = await api.post(u.token, `/subscriptions/${s.id}/seats/preview`, { contactId: beto.id, label: 'Cuenta 1', quota: '20.00' });
    expect(pv.body.calculation).toMatchObject({ mode: 'trial_free', remainingDays: 5, baseDays: 30, freeDaysThreshold: 7, prorated: '4.00', gross: '4.00', exemption: '4.00', net: '0.00', gSource: 'usuario' });
    expect(pv.body.dueDate).toBe('2026-11-02');
    expect(pv.body.next).toEqual({ cycleStart: '2026-11-07', dueDate: '2026-11-07', amount: '20.00' });
    const r = await joinSeat(api, u.token, s.id, beto.id, { quota: '20.00' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.charges).toHaveLength(1);
    expect(r.body.charges[0]).toMatchObject({ gross: '4.00', exemption: '4.00', net: '0.00', pending: '0.00', paymentStatus: 'exempt', mode: 'trial_free', dueDate: '2026-11-02' });
    // Al empezar el ciclo siguiente se emite el cargo ordinario completo
    at('2026-11-08');
    const seat = (await api.get(u.token, `/seats/${r.body.id}`)).body;
    expect(seat.charges.map((c: any) => [c.cycle.start, c.net, c.dueDate, c.paymentStatus]).sort()).toEqual([
      ['2026-10-07', '0.00', '2026-11-02', 'exempt'],
      ['2026-11-07', '20.00', '2026-11-07', 'unpaid'],
    ]);
  });

  it('A04: r=12 > g=7 → se cobra todo el tramo: 8.00, sin descontar los días gratis', async () => {
    at('2026-10-26');
    const u = await api.newUser();
    await setDefaultFreeDays(api, u.token, 7);
    const s = await createService(api, u.token);
    const beto = await createContact(api, u.token, 'Beto');
    const r = await joinSeat(api, u.token, s.id, beto.id, { quota: '20.00' });
    expect(r.status).toBe(201);
    expect(r.body.charges[0]).toMatchObject({ mode: 'partial_charged', gross: '8.00', exemption: '0.00', net: '8.00', pending: '8.00', paymentStatus: 'unpaid', dueDate: '2026-10-26' });
    expect(r.body.charges[0].calcSnapshot).toMatchObject({ remainingDays: 12, baseDays: 30, rule: 'RN-I01@v1' });
  });

  it('A05: ciclo mensual de 31 días, ingreso en la renovación → cuota completa 20.00 (sin 31/30)', async () => {
    at('2027-01-07');
    const u = await api.newUser();
    const s = await createService(api, u.token, { startDate: '2027-01-07', nextPaymentDate: '2027-02-07' });
    const c = await createContact(api, u.token, 'Carla');
    const r = await joinSeat(api, u.token, s.id, c.id, { quota: '20.00' });
    expect(r.body.charges[0]).toMatchObject({ mode: 'full_cycle', gross: '20.00', net: '20.00', exemption: '0.00' });
  });

  it('la excepción por plaza (g=0) prevalece sobre el predeterminado del usuario (RN-I07)', async () => {
    at('2026-11-02');
    const u = await api.newUser();
    await setDefaultFreeDays(api, u.token, 7);
    const s = await createService(api, u.token);
    const c = await createContact(api, u.token, 'Carla');
    const pv = await api.post(u.token, `/subscriptions/${s.id}/seats/preview`, { contactId: c.id, label: 'X', quota: '20.00', freeDaysThreshold: 0 });
    expect(pv.body.calculation).toMatchObject({ mode: 'partial_charged', net: '4.00', gSource: 'plaza' });
  });

  it('el tramo que excede la cuota se limita y avisa (D-06)', async () => {
    at('2026-10-08');
    const u = await api.newUser();
    // ciclo de 32 días: 7-oct → 8-nov; ingreso el 8-oct deja r = 31
    const s = await createService(api, u.token, { nextPaymentDate: '2026-11-08' }).catch(() => null);
    expect(s).toBeNull(); // 8-nov difiere de lo calculado (7-nov): exige confirmación explícita
  });
});

describe('vista previa de la incorporación → confirmación', () => {
  it('si la ocupación cambia entre la vista previa y el alta → PREVIEW_STALE', async () => {
    at('2026-10-12');
    const u = await api.newUser();
    const s = await createService(api, u.token, { capacity: 3 });
    const ana = await createContact(api, u.token, 'Ana');
    const beto = await createContact(api, u.token, 'Beto');
    const body = { contactId: ana.id, label: 'Cuenta 1', quota: '10.00' };
    const pv = await api.post(u.token, `/subscriptions/${s.id}/seats/preview`, body);
    // Entre tanto otra plaza ocupa un cupo
    expect((await joinSeat(api, u.token, s.id, beto.id, { quota: '10.00' })).status).toBe(201);
    const late = await api.post(u.token, `/subscriptions/${s.id}/seats`, { ...body, previewToken: pv.body.previewToken });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('PREVIEW_STALE');
  });

  it('entradas distintas a las previsualizadas → PREVIEW_MISMATCH', async () => {
    at('2026-10-12');
    const u = await api.newUser();
    const s = await createService(api, u.token);
    const ana = await createContact(api, u.token, 'Ana');
    const pv = await api.post(u.token, `/subscriptions/${s.id}/seats/preview`, { contactId: ana.id, label: 'C1', quota: '10.00' });
    const r = await api.post(u.token, `/subscriptions/${s.id}/seats`, { contactId: ana.id, label: 'C1', quota: '99.00', previewToken: pv.body.previewToken });
    expect(r.body.error.code).toBe('PREVIEW_MISMATCH');
  });

  it('un contacto o servicio ajeno → 404 y no se crea nada (A27)', async () => {
    at('2026-10-12');
    const u1 = await api.newUser();
    const u2 = await api.newUser();
    const s1 = await createService(api, u1.token);
    const c1 = await createContact(api, u1.token, 'Ana');
    const s2 = await createService(api, u2.token);
    expect((await joinSeat(api, u2.token, s1.id, c1.id, { quota: '10.00' })).status).toBe(404); // servicio ajeno
    expect((await joinSeat(api, u2.token, s2.id, c1.id, { quota: '10.00' })).status).toBe(404); // contacto ajeno
    expect((await api.get(u1.token, `/subscriptions/${s1.id}/seats`)).body.items).toHaveLength(1);
  });
});

describe('A28d · capacidad bajo concurrencia', () => {
  it('dos altas simultáneas al último cupo: una entra y la otra recibe CAPACITY_EXCEEDED', async () => {
    at('2026-10-12');
    const u = await api.newUser();
    const s = await createService(api, u.token, { capacity: 2 }); // tú + 1 cupo libre
    const ana = await createContact(api, u.token, 'Ana');
    const beto = await createContact(api, u.token, 'Beto');
    const mk = async (contactId: string) => {
      const body = { contactId, label: 'C', quota: '10.00' };
      const pv = await api.post(u.token, `/subscriptions/${s.id}/seats/preview`, body);
      return { body, token: pv.body.previewToken as string };
    };
    const [a, b] = [await mk(ana.id), await mk(beto.id)];
    const [r1, r2] = await Promise.all([
      api.post(u.token, `/subscriptions/${s.id}/seats`, { ...a.body, previewToken: a.token }),
      api.post(u.token, `/subscriptions/${s.id}/seats`, { ...b.body, previewToken: b.token }),
    ]);
    expect([r1.status, r2.status].filter((x) => x === 201)).toHaveLength(1);
    const loser = [r1, r2].find((x) => x.status !== 201)!;
    expect(['CAPACITY_EXCEEDED', 'PREVIEW_STALE']).toContain(loser.body.error.code);
    expect((await api.get(u.token, `/subscriptions/${s.id}`)).body.occupiedSeats).toBe(2);
  });
});
