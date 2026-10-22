import { afterAll, describe, expect, it } from 'vitest';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount, createContact, createService, joinSeat } from '../helpers/scenarios.js';

const api = makeApi();
afterAll(async () => { await api.app.close(); await pool.end(); });
const at = (iso: string) => api.setNow(new Date(`${iso}T17:00:00Z`));

describe('estado de cuenta del contacto (A02, RN-P01)', () => {
  it('Ana con dos plazas (10 + 8): dos líneas, total 18, por servicio y plaza', async () => {
    at('2026-10-07');
    const u = await api.newUser();
    const svc = await createService(api, u.token);
    const ana = await createContact(api, u.token, 'Ana');
    await joinSeat(api, u.token, svc.id, ana.id, { label: 'Cuenta 1', quota: '10.00' });
    await joinSeat(api, u.token, svc.id, ana.id, { label: 'Cuenta 2', quota: '8.00' });
    at('2026-10-12');
    const st = (await api.get(u.token, `/contacts/${ana.id}/statement`)).body;
    expect(st.contact).toEqual({ id: ana.id, name: 'Ana' });
    expect(st.totals).toMatchObject({ pending: '18.00', overdue: '18.00', creditFree: '0.00', creditReserved: '0.00' });
    expect(st.services).toHaveLength(1);
    const netflix = st.services[0];
    expect(netflix.seats.map((s: any) => [s.label, s.quota, s.pending])).toEqual([['Cuenta 1', '10.00', '10.00'], ['Cuenta 2', '8.00', '8.00']]);
    expect(netflix.charges.map((c: any) => [c.seatLabel, c.net, c.paymentStatus, c.overdue]).sort()).toEqual([['Cuenta 1', '10.00', 'unpaid', true], ['Cuenta 2', '8.00', 'unpaid', true]]);
    expect(st.loans).toEqual([]);
  });

  it('con un pago parcial muestra parcial y el crédito reservado; el texto para compartir es discreto', async () => {
    at('2026-10-07');
    const u = await api.newUser();
    const bcp = await createAccount(api, u.token);
    const svc = await createService(api, u.token);
    const ana = await createContact(api, u.token, 'Ana');
    const seat = (await joinSeat(api, u.token, svc.id, ana.id, { label: 'Cuenta 1', quota: '20.00' })).body;
    at('2026-10-12');
    const body = { contactId: ana.id, accountId: bcp.id, amount: '30.00', allocations: [{ obligationId: seat.charges[0].obligationId, amount: '12.00' }] };
    const pv = await api.post(u.token, '/receipts/preview', body);
    expect((await api.post(u.token, '/receipts', { ...body, previewToken: pv.body.previewToken })).status).toBe(201);
    const st = (await api.get(u.token, `/contacts/${ana.id}/statement`)).body;
    expect(st.totals).toMatchObject({ pending: '8.00', creditReserved: '18.00' });
    expect(st.services[0].charges[0]).toMatchObject({ paymentStatus: 'partial', applied: '12.00', pending: '8.00' });
    expect(st.shareText).toBe('Hola Ana, este es tu estado de cuenta:\n• Netflix · Cuenta 1: S/ 8.00 (venció el 7 oct)\nTotal pendiente: S/ 8.00');
  });

  it('al día: el texto lo dice y un contacto ajeno responde 404', async () => {
    at('2026-10-12');
    const u = await api.newUser();
    const ana = await createContact(api, u.token, 'Ana');
    const st = (await api.get(u.token, `/contacts/${ana.id}/statement`)).body;
    expect(st.shareText).toBe('Hola Ana, estás al día. ¡Gracias!');
    const other = await api.newUser();
    expect((await api.get(other.token, `/contacts/${ana.id}/statement`)).status).toBe(404);
  });

  it('el pendiente total de la lista de contactos coincide con el estado de cuenta', async () => {
    at('2026-10-07');
    const u = await api.newUser();
    const svc = await createService(api, u.token);
    const ana = await createContact(api, u.token, 'Ana');
    await joinSeat(api, u.token, svc.id, ana.id, { quota: '10.00' });
    at('2026-10-12');
    const list = (await api.get(u.token, '/contacts')).body.items;
    expect(list[0].totals.pending).toBe('10.00');
    expect(list[0]).toMatchObject({ activeSeats: 1, services: 1 });
  });
});
