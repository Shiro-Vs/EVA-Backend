import { afterAll, describe, expect, it } from 'vitest';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount, createContact, createService, joinSeat } from '../helpers/scenarios.js';

const api = makeApi();
afterAll(async () => { await api.app.close(); await pool.end(); });
const at = (iso: string) => api.setNow(new Date(`${iso}T17:00:00Z`));

const chargesOf = async (token: string, seatId: string) => (await api.get(token, `/seats/${seatId}`)).body.charges as Array<any>;
const byStart = (charges: any[], start: string) => charges.find((c) => c.cycle.start === start);
const cyclesOf = async (token: string, subId: string) => ((await api.get(token, `/subscriptions/${subId}/cycles`)).body.items as Array<any>).slice().sort((a, b) => a.startDate.localeCompare(b.startDate));

/** Netflix de 45.00 (ciclos 7-oct, 7-nov, …) y Ana con cuota 20.00 desde el primer día. */
async function world() {
  at('2026-10-07');
  const u = await api.newUser();
  const bcp = await createAccount(api, u.token, 'BCP', '200.00');
  const svc = await createService(api, u.token);
  const ana = await createContact(api, u.token, 'Ana');
  const seat = await joinSeat(api, u.token, svc.id, ana.id, { quota: '20.00' });
  expect(seat.status, JSON.stringify(seat.body)).toBe(201);
  at('2026-10-12');
  return { u, bcp, svc, ana, seat: seat.body as any };
}

const preview = (token: string, subId: string, body: Record<string, unknown>) => api.post(token, `/subscriptions/${subId}/calendar-changes/preview`, body);
async function change(token: string, subId: string, body: Record<string, unknown>) {
  const pv = await preview(token, subId, body);
  if (pv.status !== 200) return pv;
  return api.post(token, `/subscriptions/${subId}/calendar-changes`, { ...body, previewToken: pv.body.previewToken });
}

async function pay(token: string, body: Record<string, unknown>) {
  const pv = await api.post(token, '/receipts/preview', body);
  expect(pv.body.valid, JSON.stringify(pv.body)).toBe(true);
  const r = await api.post(token, '/receipts', { ...body, previewToken: pv.body.previewToken });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

describe('Desplazar o adelantar la renovación (RN-C07/C08/C10, D-05)', () => {
  it('el proveedor mueve la renovación del 7 al 10 de nov: el ciclo se alarga, el cargo emitido conserva su monto y su vencimiento se corre', async () => {
    const w = await world();
    await api.post(w.u.token, `/subscriptions/${w.svc.id}/cycles/generate`, { ahead: 1 }); // el ciclo 2 ya tiene su cargo de 20.00
    const body = { kind: 'shift_renewal', newDate: '2026-11-10', reason: 'El proveedor movió la renovación' };
    const pv = await preview(w.u.token, w.svc.id, body);
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body).toMatchObject({ amountsUnchanged: true, currentCycle: { oldEnd: '2026-11-07', newEnd: '2026-11-10' } });
    expect(pv.body.futureCycles[0]).toMatchObject({ old: { start: '2026-11-07', end: '2026-12-07' }, new: { start: '2026-11-10', end: '2026-12-10' }, hasCharges: true });

    const r = await api.post(w.u.token, `/subscriptions/${w.svc.id}/calendar-changes`, { ...body, previewToken: pv.body.previewToken });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const cycles = await cyclesOf(w.u.token, w.svc.id);
    expect(cycles.map((c) => [c.startDate, c.endDate])).toEqual([['2026-10-07', '2026-11-10'], ['2026-11-10', '2026-12-10']]);
    const charges = await chargesOf(w.u.token, w.seat.id);
    expect(charges).toHaveLength(2);
    expect(byStart(charges, '2026-10-07')).toMatchObject({ net: '20.00', dueDate: '2026-10-07' });
    expect(byStart(charges, '2026-11-10')).toMatchObject({ net: '20.00', dueDate: '2026-11-10', pending: '20.00' }); // mismo monto, vencimiento movido

    // Los ciclos siguientes parten del nuevo ancla (día 10).
    at('2026-12-11');
    const later = await cyclesOf(w.u.token, w.svc.id);
    expect(later.map((c) => c.startDate)).toEqual(['2026-10-07', '2026-11-10', '2026-12-10', '2027-01-10']);
    expect(byStart(await chargesOf(w.u.token, w.seat.id), '2026-12-10')).toMatchObject({ net: '20.00' });

    const hist = (await api.get(w.u.token, `/subscriptions/${w.svc.id}/calendar-changes`)).body.items;
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ kind: 'shift_renewal', oldCurrentEnd: '2026-11-07', newCurrentEnd: '2026-11-10', reason: 'El proveedor movió la renovación' });
  });

  it('renovación adelantada al 2 de nov: nadie paga dos veces ni recibe devolución por los días recortados (D-05)', async () => {
    const w = await world();
    await pay(w.u.token, { contactId: w.ana.id, accountId: w.bcp.id, amount: '20.00', allocations: [{ obligationId: w.seat.charges[0].obligationId, amount: '20.00' }] });
    const r = await change(w.u.token, w.svc.id, { kind: 'advance_renewal', newDate: '2026-11-02', reason: 'Renové antes' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await cyclesOf(w.u.token, w.svc.id)).map((c) => [c.startDate, c.endDate])).toEqual([['2026-10-07', '2026-11-02'], ['2026-11-02', '2026-12-02']]);
    expect(byStart(await chargesOf(w.u.token, w.seat.id), '2026-10-07')).toMatchObject({ net: '20.00', applied: '20.00', pending: '0.00', paymentStatus: 'paid' });
    expect((await api.get(w.u.token, `/contacts/${w.ana.id}/credit`)).body.total).toBe('0.00'); // sin devolución ni crédito
    expect((await api.get(w.u.token, `/accounts/${w.bcp.id}`)).body.balance).toBe('220.00');
  });

  it('un ajuste de cuota "por renovación" acompaña la nueva fecha del ciclo', async () => {
    const w = await world();
    await api.post(w.u.token, `/subscriptions/${w.svc.id}/cycles/generate`, { ahead: 1 });
    const c2 = byStart(await chargesOf(w.u.token, w.seat.id), '2026-11-07');
    await pay(w.u.token, { contactId: w.ana.id, accountId: w.bcp.id, amount: '20.00', allocations: [{ obligationId: c2.obligationId, amount: '20.00' }] });
    const q = await api.post(w.u.token, `/seats/${w.seat.id}/quota-change/preview`, { newQuota: '22.00', effectiveFrom: '2026-11-07', mode: 'per_renewal', reason: 'Subió' });
    expect((await api.post(w.u.token, `/seats/${w.seat.id}/quota-change`, { newQuota: '22.00', effectiveFrom: '2026-11-07', mode: 'per_renewal', reason: 'Subió', previewToken: q.body.previewToken })).status).toBe(200);
    expect(byStart(await chargesOf(w.u.token, w.seat.id), '2026-11-07')).toMatchObject({ pending: '2.00', dueDate: '2026-11-07' });
    expect((await change(w.u.token, w.svc.id, { kind: 'shift_renewal', newDate: '2026-11-10', reason: 'Movió' })).status).toBe(201);
    expect(byStart(await chargesOf(w.u.token, w.seat.id), '2026-11-10')).toMatchObject({ pending: '2.00', dueDate: '2026-11-10' });
  });

  it('validaciones de fecha y de dirección', async () => {
    const w = await world();
    const code = async (b: Record<string, unknown>) => (await preview(w.u.token, w.svc.id, b)).body.error?.code;
    expect(await code({ kind: 'shift_renewal', newDate: '2026-10-12', reason: 'x' })).toBe('NEW_DATE_NOT_FUTURE');
    expect(await code({ kind: 'shift_renewal', newDate: '2026-11-07', reason: 'x' })).toBe('NEW_DATE_UNCHANGED');
    expect(await code({ kind: 'advance_renewal', newDate: '2026-11-20', reason: 'x' })).toBe('ADVANCE_NOT_EARLIER');
    expect(await code({ kind: 'shift_renewal', newDate: 'mañana', reason: 'x' })).toBe('VALIDATION_ERROR');
    expect(await code({ kind: 'reactivate', renewalDate: '2026-12-04', reason: 'x' })).toBe('SUBSCRIPTION_NOT_SUSPENDED');
  });

  it('la vista previa caduca si el calendario cambió entre verla y aplicarla', async () => {
    const w = await world();
    const body = { kind: 'shift_renewal', newDate: '2026-11-10', reason: 'x' };
    const pv = await preview(w.u.token, w.svc.id, body);
    expect((await change(w.u.token, w.svc.id, { kind: 'shift_renewal', newDate: '2026-11-12', reason: 'otro' })).status).toBe(201);
    const stale = await api.post(w.u.token, `/subscriptions/${w.svc.id}/calendar-changes`, { ...body, previewToken: pv.body.previewToken });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('PREVIEW_STALE');
  });
});

describe('A15 · suspensión y reactivación (RN-C08/C09)', () => {
  it('se suspende, no se emite nada mientras tanto y se reactiva con renovación el 4 de dic sin cobrar días extra', async () => {
    const w = await world();
    const sp = await preview(w.u.token, w.svc.id, { kind: 'suspend', reason: 'Olvidé pagar' });
    expect(sp.status, JSON.stringify(sp.body)).toBe(200);
    expect(sp.body).toMatchObject({ statusAfter: 'suspended', amountsUnchanged: true });
    expect(sp.body.removedCycles).toHaveLength(1);
    expect((await change(w.u.token, w.svc.id, { kind: 'suspend', reason: 'Olvidé pagar' })).status).toBe(201);
    // El ciclo ya pagado sigue en curso; no queda ninguno futuro.
    expect((await api.get(w.u.token, `/subscriptions/${w.svc.id}`)).body).toMatchObject({ status: 'suspended', currentCycle: { startDate: '2026-10-07' }, nextCycle: null });
    expect(await cyclesOf(w.u.token, w.svc.id)).toHaveLength(1);

    at('2026-11-20'); // pasó la renovación del 7: no se genera ciclo ni cargo
    expect((await api.get(w.u.token, `/subscriptions/${w.svc.id}`)).body).toMatchObject({ status: 'suspended', currentCycle: null, nextCycle: null });
    expect(await chargesOf(w.u.token, w.seat.id)).toHaveLength(1);
    expect(await cyclesOf(w.u.token, w.svc.id)).toHaveLength(1);
    const other = await createContact(api, w.u.token, 'Beto');
    expect((await joinSeat(api, w.u.token, w.svc.id, other.id, { quota: '10.00' })).body.error.code).toBe('SUBSCRIPTION_SUSPENDED');
    expect((await preview(w.u.token, w.svc.id, { kind: 'shift_renewal', newDate: '2026-12-01', reason: 'x' })).body.error.code).toBe('SUBSCRIPTION_SUSPENDED');
    expect((await preview(w.u.token, w.svc.id, { kind: 'reactivate', renewalDate: '2026-10-07', reason: 'x' })).body.error.code).toBe('REACTIVATE_DATE_INVALID');

    const re = { kind: 'reactivate', renewalDate: '2026-12-04', reason: 'Pagué y reactivé' };
    const pv = await preview(w.u.token, w.svc.id, re);
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body).toMatchObject({ statusAfter: 'active', currentCycle: { oldEnd: '2026-11-07', newEnd: '2026-12-04' } });
    const r = await api.post(w.u.token, `/subscriptions/${w.svc.id}/calendar-changes`, { ...re, previewToken: pv.body.previewToken });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.subscription.status).toBe('active');
    expect((await cyclesOf(w.u.token, w.svc.id))[0]).toMatchObject({ startDate: '2026-10-07', endDate: '2026-12-04' });
    // El hueco del 7-nov al 4-dic no genera cargo extra: sigue habiendo un solo cargo de 20.00.
    expect(await chargesOf(w.u.token, w.seat.id)).toHaveLength(1);

    at('2026-12-05');
    const charges = await chargesOf(w.u.token, w.seat.id);
    expect(charges.map((c) => [c.cycle.start, c.net, c.dueDate])).toEqual([['2026-12-04', '20.00', '2026-12-04'], ['2026-10-07', '20.00', '2026-10-07']]);
    expect((await cyclesOf(w.u.token, w.svc.id)).map((c) => c.startDate)).toEqual(['2026-10-07', '2026-12-04', '2027-01-04']);

    const hist = (await api.get(w.u.token, `/subscriptions/${w.svc.id}/calendar-changes`)).body.items.map((x: any) => x.kind);
    expect(hist).toEqual(['reactivate', 'suspend']);
    expect((await preview(w.u.token, w.svc.id, { kind: 'reactivate', renewalDate: '2027-02-04', reason: 'x' })).body.error.code).toBe('SUBSCRIPTION_NOT_SUSPENDED');
  });

  it('no se suspende si un ciclo futuro ya tiene cargos: hay que deshacerlos antes', async () => {
    const w = await world();
    await api.post(w.u.token, `/subscriptions/${w.svc.id}/cycles/generate`, { ahead: 1 });
    const r = await preview(w.u.token, w.svc.id, { kind: 'suspend', reason: 'x' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('CALENDAR_CHANGE_BLOCKED');
    expect(r.body.error.details.cycles[0]).toMatchObject({ start: '2026-11-07' });
  });
});

describe('Cambiar la frecuencia (RN-C07)', () => {
  it('de mensual a anual desde la próxima renovación; los ciclos futuros sin cargos se regeneran', async () => {
    const w = await world();
    const body = { kind: 'change_interval', interval: { unit: 'year', count: 1 }, reason: 'Pasé al plan anual' };
    const pv = await preview(w.u.token, w.svc.id, body);
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body.futureCycles[0]).toMatchObject({ new: { start: '2026-11-07', end: '2027-11-07' } });
    expect((await change(w.u.token, w.svc.id, body)).status).toBe(201);
    expect((await api.get(w.u.token, `/subscriptions/${w.svc.id}`)).body.terms.interval).toEqual({ unit: 'month', count: 1 }); // rige desde la renovación
    at('2026-11-08');
    expect((await api.get(w.u.token, `/subscriptions/${w.svc.id}`)).body.terms.interval).toEqual({ unit: 'year', count: 1 });
    const cycles = await cyclesOf(w.u.token, w.svc.id);
    expect(cycles.map((c) => [c.startDate, c.endDate])).toEqual([['2026-10-07', '2026-11-07'], ['2026-11-07', '2027-11-07'], ['2027-11-07', '2028-11-07']]);
    expect(byStart(await chargesOf(w.u.token, w.seat.id), '2026-11-07')).toMatchObject({ net: '20.00' });
    expect((await preview(w.u.token, w.svc.id, body)).body.error.code).toBe('INTERVAL_UNCHANGED');
  });

  it('se rechaza si ya hay cargos en ciclos futuros', async () => {
    const w = await world();
    await api.post(w.u.token, `/subscriptions/${w.svc.id}/cycles/generate`, { ahead: 1 });
    const r = await preview(w.u.token, w.svc.id, { kind: 'change_interval', interval: { unit: 'year', count: 1 }, reason: 'x' });
    expect(r.body.error.code).toBe('CALENDAR_CHANGE_BLOCKED');
  });
});
