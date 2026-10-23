import { afterAll, describe, expect, it } from 'vitest';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount, createContact, createService, joinSeat } from '../helpers/scenarios.js';

const api = makeApi();
afterAll(async () => { await api.app.close(); await pool.end(); });
const at = (iso: string) => api.setNow(new Date(`${iso}T17:00:00Z`));

const chargesOf = async (token: string, seatId: string) => (await api.get(token, `/seats/${seatId}`)).body.charges as Array<any>;
const byStart = (charges: any[], start: string) => charges.find((c) => c.cycle.start === start);

async function pay(token: string, body: Record<string, unknown>) {
  const pv = await api.post(token, '/receipts/preview', body);
  expect(pv.body.valid, JSON.stringify(pv.body)).toBe(true);
  const r = await api.post(token, '/receipts', { ...body, previewToken: pv.body.previewToken });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

/** Netflix de 45.00 con Ana, Beto y Carla a 12.00 (cuota sugerida con 4 plazas: ceil(45/4) = 12). */
async function world() {
  at('2026-10-07');
  const u = await api.newUser();
  const bcp = await createAccount(api, u.token, 'BCP', '200.00');
  const svc = await createService(api, u.token);
  const people: Record<string, { contact: any; seat: any }> = {};
  for (const n of ['Ana', 'Beto', 'Carla']) {
    const contact = await createContact(api, u.token, n);
    const r = await joinSeat(api, u.token, svc.id, contact.id, { quota: '12.00', label: n });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    people[n] = { contact, seat: r.body };
  }
  at('2026-10-12');
  return { u, bcp, svc, ...people } as { u: any; bcp: any; svc: any; Ana: any; Beto: any; Carla: any };
}

const body = (w: any, over: Record<string, unknown> = {}) => ({ newPrice: '52.00', effectiveFrom: '2026-11-07', mode: 'per_renewal', reason: 'Subió Netflix', ...over });
const preview = (w: any, b: Record<string, unknown>) => api.post(w.u.token, `/subscriptions/${w.svc.id}/price-change/preview`, b);
async function change(w: any, b: Record<string, unknown>) {
  const pv = await preview(w, b);
  if (pv.status !== 200) return pv;
  return api.post(w.u.token, `/subscriptions/${w.svc.id}/price-change`, { ...b, previewToken: pv.body.previewToken });
}

describe('Cambio de precio del proveedor (RN-Q03/Q04, D-19)', () => {
  it('propone la cuota sugerida y las diferencias, pero solo cambia las cuotas que el administrador confirma', async () => {
    const w = await world();
    await api.post(w.u.token, `/subscriptions/${w.svc.id}/cycles/generate`, { ahead: 1 }); // ciclo 11-nov con cargos de 12.00
    const ana = byStart(await chargesOf(w.u.token, w.Ana.seat.id), '2026-11-07');
    await pay(w.u.token, { contactId: w.Ana.contact.id, accountId: w.bcp.id, amount: '12.00', allocations: [{ obligationId: ana.obligationId, amount: '12.00' }] });

    // 1) Propuesta: nada cambia por sí solo.
    const pv = await preview(w, body(w));
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body).toMatchObject({ oldPrice: '45.00', newPrice: '52.00', occupiedSeats: 4, suggestedQuota: { amount: '13.00', formula: 'ceil(52.00 / 4)' }, totals: { adjustment: '0.00', creditFreed: '0.00' } });
    expect(pv.body.seats.map((s: any) => [s.label, s.currentQuota, s.proposedQuota, s.newQuota])).toEqual([['Ana', '12.00', '13.00', null], ['Beto', '12.00', '13.00', null], ['Carla', '12.00', '13.00', null]]);
    expect(pv.body.cyclesAffected.map((c: any) => c.start)).toEqual(['2026-11-07']);

    // 2) El administrador confirma 13.00 para Ana y Beto; Carla conserva 12.00.
    const confirm = body(w, { quotas: [{ seatId: w.Ana.seat.id, quota: '13.00' }, { seatId: w.Beto.seat.id, quota: '13.00' }, { seatId: w.Carla.seat.id, quota: '12.00' }] });
    const pv2 = await preview(w, confirm);
    expect(pv2.body.totals.adjustment).toBe('2.00');
    expect(pv2.body.seats.find((s: any) => s.label === 'Carla').newQuota).toBeNull(); // igual a la actual: sin cambio
    const r = await api.post(w.u.token, `/subscriptions/${w.svc.id}/price-change`, { ...confirm, previewToken: pv2.body.previewToken });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.subscription.terms).toMatchObject({ announcedPrice: '45.00' }); // hoy sigue vigente el precio anterior

    const after = async (n: 'Ana' | 'Beto' | 'Carla') => byStart(await chargesOf(w.u.token, w[n].seat.id), '2026-11-07');
    expect(await after('Ana')).toMatchObject({ net: '12.00', adjustments: '1.00', applied: '12.00', pending: '1.00' }); // el anticipo no congeló el precio
    expect(await after('Beto')).toMatchObject({ adjustments: '1.00', pending: '13.00' });
    expect(await after('Carla')).toMatchObject({ adjustments: '0.00', pending: '12.00' });

    // 3) Versiones de precio y ciclos con el precio nuevo desde la fecha efectiva.
    const terms = (await api.get(w.u.token, `/subscriptions/${w.svc.id}/terms`)).body.items;
    expect(terms.map((t: any) => [t.validFrom, t.validTo, t.announcedPrice])).toEqual([['2026-10-07', '2026-11-07', '45.00'], ['2026-11-07', null, '52.00']]);
    const cycles = (await api.get(w.u.token, `/subscriptions/${w.svc.id}/cycles`)).body.items as any[];
    expect(cycles.find((c) => c.startDate === '2026-11-07').announcedPrice).toBe('52.00');
    expect(cycles.find((c) => c.startDate === '2026-10-07').announcedPrice).toBe('45.00');

    at('2026-12-08'); // los ciclos nuevos nacen con el precio y las cuotas nuevas, sin ajuste
    expect(byStart(await chargesOf(w.u.token, w.Ana.seat.id), '2026-12-07')).toMatchObject({ net: '13.00', adjustments: '0.00' });
    expect(byStart(await chargesOf(w.u.token, w.Carla.seat.id), '2026-12-07')).toMatchObject({ net: '12.00' });
    expect((await api.get(w.u.token, `/subscriptions/${w.svc.id}`)).body.terms).toMatchObject({ announcedPrice: '52.00' });
  });

  it('solo cambia el precio si no se confirma ninguna cuota (RN-Q04: el precio no mueve cuotas solo)', async () => {
    const w = await world();
    const r = await change(w, body(w));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.totals).toEqual({ adjustment: '0.00', creditFreed: '0.00' });
    for (const n of ['Ana', 'Beto', 'Carla'] as const) expect((await api.get(w.u.token, `/seats/${w[n].seat.id}`)).body.scheduledQuota).toBeNull();
    // Volver a cambiar el precio en la misma fecha reemplaza la versión (sin apilar versiones).
    const again = await change(w, body(w, { newPrice: '55.00' }));
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const terms = (await api.get(w.u.token, `/subscriptions/${w.svc.id}/terms`)).body.items;
    expect(terms.map((t: any) => [t.validFrom, t.announcedPrice])).toEqual([['2026-10-07', '45.00'], ['2026-11-07', '55.00']]);
  });

  it('si una cuota baja y ya estaba cobrada, el exceso vuelve como crédito libre', async () => {
    const w = await world();
    await api.post(w.u.token, `/subscriptions/${w.svc.id}/cycles/generate`, { ahead: 1 });
    const ana = byStart(await chargesOf(w.u.token, w.Ana.seat.id), '2026-11-07');
    await pay(w.u.token, { contactId: w.Ana.contact.id, accountId: w.bcp.id, amount: '12.00', allocations: [{ obligationId: ana.obligationId, amount: '12.00' }] });
    const r = await change(w, body(w, { newPrice: '40.00', quotas: [{ seatId: w.Ana.seat.id, quota: '10.00' }] }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.creditFreed).toBe('2.00');
    expect((await api.get(w.u.token, `/contacts/${w.Ana.contact.id}/credit`)).body).toMatchObject({ total: '2.00', free: '2.00' });
  });

  it('validaciones: fecha, precio igual, plaza ajena, token distinto y cambio ya programado', async () => {
    const w = await world();
    const code = async (b: Record<string, unknown>) => (await preview(w, b)).body.error?.code;
    expect(await code(body(w, { effectiveFrom: '2026-10-07' }))).toBe('EFFECTIVE_DATE_PAST');
    expect(await code(body(w, { effectiveFrom: '2026-11-15' }))).toBe('EFFECTIVE_DATE_NOT_CYCLE_START');
    expect(await code(body(w, { newPrice: '45.00' }))).toBe('PRICE_UNCHANGED');
    expect(await code(body(w, { quotas: [{ seatId: '00000000-0000-4000-8000-000000000001', quota: '13.00' }] }))).toBe('SEAT_NOT_IN_PROPOSAL');
    expect(await code(body(w, { newPrice: 'mucho' }))).toBe('VALIDATION_ERROR');

    // El token es de ESTA propuesta: confirmar otras cuotas distintas a las vistas se rechaza.
    const pv = await preview(w, body(w, { quotas: [{ seatId: w.Ana.seat.id, quota: '13.00' }] }));
    const other = await api.post(w.u.token, `/subscriptions/${w.svc.id}/price-change`, { ...body(w, { quotas: [{ seatId: w.Ana.seat.id, quota: '14.00' }] }), previewToken: pv.body.previewToken });
    expect(other.body.error.code).toBe('PREVIEW_MISMATCH');

    // Un cambio de cuota ya programado en esa fecha bloquea a esa plaza.
    const qp = await api.post(w.u.token, `/seats/${w.Beto.seat.id}/quota-change/preview`, { newQuota: '14.00', effectiveFrom: '2026-11-07', mode: 'per_renewal', reason: 'x' });
    expect((await api.post(w.u.token, `/seats/${w.Beto.seat.id}/quota-change`, { newQuota: '14.00', effectiveFrom: '2026-11-07', mode: 'per_renewal', reason: 'x', previewToken: qp.body.previewToken })).status).toBe(200);
    const locked = (await preview(w, body(w))).body.seats.find((s: any) => s.label === 'Beto');
    expect(locked.locked).toBe(true);
    expect(await code(body(w, { quotas: [{ seatId: w.Beto.seat.id, quota: '13.00' }] }))).toBe('QUOTA_CHANGE_EXISTS');
  });

  it('un ciclo ya pagado al proveedor desde esa fecha bloquea el cambio; con una fecha posterior sí se puede', async () => {
    const w = await world();
    await api.post(w.u.token, `/subscriptions/${w.svc.id}/cycles/generate`, { ahead: 2 });
    const cycles = (await api.get(w.u.token, `/subscriptions/${w.svc.id}/cycles`)).body.items as any[];
    const c2 = cycles.find((c) => c.startDate === '2026-11-07');
    const sp = await api.post(w.u.token, `/billing-cycles/${c2.id}/supplier-payment`, { accountId: w.bcp.id, amount: '45.00', paidOn: '2026-10-12' });
    expect(sp.status, JSON.stringify(sp.body)).toBe(201);
    const blocked = await preview(w, body(w));
    expect(blocked.body.error.code).toBe('PRICE_CHANGE_BLOCKED');
    expect(blocked.body.error.details.cycles[0]).toMatchObject({ start: '2026-11-07' });
    const later = await change(w, body(w, { effectiveFrom: '2026-12-07' }));
    expect(later.status, JSON.stringify(later.body)).toBe(200);
    const terms = (await api.get(w.u.token, `/subscriptions/${w.svc.id}/terms`)).body.items;
    expect(terms.map((t: any) => t.validFrom)).toEqual(['2026-10-07', '2026-12-07']);
    expect((await pool.query(`select count(*)::int as n from audit_event where owner_id = $1 and action = 'subscription.price_change'`, [w.u.id])).rows[0].n).toBe(1);
  });

  it('convive con un desplazamiento de renovación posterior (los términos quedan coherentes)', async () => {
    const w = await world();
    expect((await change(w, body(w))).status).toBe(200);
    // El proveedor mueve la renovación del 7 al 10 de nov: el límite del ciclo coincide con el cambio de precio.
    const cc = await api.post(w.u.token, `/subscriptions/${w.svc.id}/calendar-changes/preview`, { kind: 'shift_renewal', newDate: '2026-11-10', reason: 'Movió' });
    expect(cc.status, JSON.stringify(cc.body)).toBe(200);
    const done = await api.post(w.u.token, `/subscriptions/${w.svc.id}/calendar-changes`, { kind: 'shift_renewal', newDate: '2026-11-10', reason: 'Movió', previewToken: cc.body.previewToken });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    const terms = (await api.get(w.u.token, `/subscriptions/${w.svc.id}/terms`)).body.items;
    expect(terms.map((t: any) => [t.validFrom, t.validTo, t.announcedPrice])).toEqual([['2026-10-07', '2026-11-10', '45.00'], ['2026-11-10', null, '52.00']]);
    const cycles = (await api.get(w.u.token, `/subscriptions/${w.svc.id}/cycles`)).body.items as any[];
    expect(cycles.map((c) => [c.startDate, c.announcedPrice]).sort()).toEqual([['2026-10-07', '45.00'], ['2026-11-10', '52.00']]);
  });
});
