import { afterAll, describe, expect, it } from 'vitest';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount, createContact, createService, joinSeat } from '../helpers/scenarios.js';

const api = makeApi();
afterAll(async () => { await api.app.close(); await pool.end(); });
const at = (iso: string) => api.setNow(new Date(`${iso}T17:00:00Z`));

async function pay(token: string, body: Record<string, unknown>) {
  const pv = await api.post(token, '/receipts/preview', body);
  expect(pv.status, JSON.stringify(pv.body)).toBe(200);
  expect(pv.body.valid, JSON.stringify(pv.body)).toBe(true);
  const r = await api.post(token, '/receipts', { ...body, previewToken: pv.body.previewToken });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r;
}
const chargesOf = async (token: string, seatId: string) => (await api.get(token, `/seats/${seatId}`)).body.charges as Array<any>;
const byStart = (charges: any[], start: string) => charges.find((c) => c.cycle.start === start);

/** Netflix de 45.00 (ciclos 7-oct, 7-nov, 7-dic, 7-ene) y Ana con cuota 20.00 desde el primer día. */
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

const courtesy = (token: string, seatId: string, body: Record<string, unknown>) => api.post(token, `/seats/${seatId}/courtesies`, body);

describe('Cortesías (RN-K01–K05)', () => {
  it('por 2 ciclos: rige desde el SIGUIENTE ciclo, el ciclo en curso no se toca y luego se vuelve a cobrar', async () => {
    const w = await world();
    const pv = await api.post(w.u.token, `/seats/${w.seat.id}/courtesies/preview`, { kind: 'cycles', cycles: 2, reason: 'Regalo de cumpleaños' });
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body).toMatchObject({ startsOn: '2026-11-07', debtPolicy: 'keep', existingDebt: '20.00' });
    const r = await courtesy(w.u.token, w.seat.id, { kind: 'cycles', cycles: 2, reason: 'Regalo de cumpleaños' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ kind: 'cycles', cyclesTotal: 2, cyclesUsed: 0, status: 'active', startsOn: '2026-11-07' });

    // El ciclo en curso sigue cobrándose y la deuda anterior no desaparece (RN-K04).
    expect(byStart(await chargesOf(w.u.token, w.seat.id), '2026-10-07')).toMatchObject({ net: '20.00', pending: '20.00', paymentStatus: 'unpaid', mode: 'full_cycle' });

    at('2026-11-08');
    const c2 = byStart(await chargesOf(w.u.token, w.seat.id), '2026-11-07');
    expect(c2).toMatchObject({ gross: '20.00', exemption: '20.00', net: '0.00', pending: '0.00', paymentStatus: 'exempt', mode: 'courtesy' });
    at('2026-12-08');
    expect(byStart(await chargesOf(w.u.token, w.seat.id), '2026-12-07')).toMatchObject({ net: '0.00', paymentStatus: 'exempt', mode: 'courtesy' });
    const list = (await api.get(w.u.token, `/seats/${w.seat.id}/courtesies`)).body.items;
    expect(list[0]).toMatchObject({ cyclesUsed: 2, status: 'ended' });

    at('2027-01-08'); // se acabó la cortesía: vuelve el cobro normal
    expect(byStart(await chargesOf(w.u.token, w.seat.id), '2027-01-07')).toMatchObject({ net: '20.00', paymentStatus: 'unpaid', mode: 'full_cycle' });
    // El costo de la cortesía no se reparte entre los demás (RN-K03): el pendiente del contacto solo suma lo cobrable.
    const st = (await api.get(w.u.token, `/contacts/${w.ana.id}/statement`)).body;
    expect(st.totals.pending).toBe('40.00'); // 20 del ciclo 1 + 20 del ciclo 4
  });

  it('permanente hasta que se quita: terminarla reanuda el cobro de los ciclos aún sin emitir', async () => {
    const w = await world();
    const r = await courtesy(w.u.token, w.seat.id, { kind: 'permanent', reason: 'Familiar' });
    expect(r.status).toBe(201);
    at('2026-11-08');
    expect(byStart(await chargesOf(w.u.token, w.seat.id), '2026-11-07')).toMatchObject({ net: '0.00', mode: 'courtesy' });
    const end = await api.post(w.u.token, `/courtesies/${r.body.id}/end`, {});
    expect(end.status, JSON.stringify(end.body)).toBe(200);
    expect(end.body.status).toBe('ended');
    at('2026-12-08');
    const charges = await chargesOf(w.u.token, w.seat.id);
    expect(byStart(charges, '2026-11-07')).toMatchObject({ net: '0.00', mode: 'courtesy' }); // lo ya eximido se conserva
    expect(byStart(charges, '2026-12-07')).toMatchObject({ net: '20.00', mode: 'full_cycle' });
    expect((await api.post(w.u.token, `/courtesies/${r.body.id}/end`, {})).body.error.code).toBe('COURTESY_NOT_ACTIVE');
  });

  it('hasta una fecha: cubre los ciclos que empiezan hasta ese día', async () => {
    const w = await world();
    const r = await courtesy(w.u.token, w.seat.id, { kind: 'until_date', untilDate: '2026-12-07', reason: 'Prueba' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    at('2026-12-08');
    const charges = await chargesOf(w.u.token, w.seat.id);
    expect(byStart(charges, '2026-11-07')).toMatchObject({ mode: 'courtesy' });
    expect(byStart(charges, '2026-12-07')).toMatchObject({ mode: 'courtesy' });
    at('2027-01-08');
    expect(byStart(await chargesOf(w.u.token, w.seat.id), '2027-01-07')).toMatchObject({ mode: 'full_cycle', net: '20.00' });
  });

  it('un ciclo emitido por adelantado y sin cobros se exime; con cobros se rechaza sin condonar nada', async () => {
    const w = await world();
    expect((await api.post(w.u.token, `/subscriptions/${w.svc.id}/cycles/generate`, { ahead: 1 })).status).toBe(200);
    expect(byStart(await chargesOf(w.u.token, w.seat.id), '2026-11-07')).toMatchObject({ net: '20.00' });
    const ok = await courtesy(w.u.token, w.seat.id, { kind: 'cycles', cycles: 1, reason: 'Regalo' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.cyclesUsed).toBe(1);
    expect(byStart(await chargesOf(w.u.token, w.seat.id), '2026-11-07')).toMatchObject({ net: '0.00', mode: 'courtesy', paymentStatus: 'exempt' });

    const w2 = await world();
    await api.post(w2.u.token, `/subscriptions/${w2.svc.id}/cycles/generate`, { ahead: 1 });
    const next = byStart(await chargesOf(w2.u.token, w2.seat.id), '2026-11-07');
    await pay(w2.u.token, { contactId: w2.ana.id, accountId: w2.bcp.id, amount: '10.00', allocations: [{ obligationId: next.obligationId, amount: '10.00' }] });
    const bad = await courtesy(w2.u.token, w2.seat.id, { kind: 'cycles', cycles: 1, reason: 'Regalo' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('COURTESY_CHARGE_ALREADY_APPLIED');
    expect(byStart(await chargesOf(w2.u.token, w2.seat.id), '2026-11-07')).toMatchObject({ net: '20.00', applied: '10.00' });
  });

  it('validaciones: una sola cortesía vigente, no aplica a tu plaza y la fecha final no precede al siguiente ciclo', async () => {
    const w = await world();
    expect((await courtesy(w.u.token, w.seat.id, { kind: 'permanent', reason: 'Una' })).status).toBe(201);
    expect((await courtesy(w.u.token, w.seat.id, { kind: 'permanent', reason: 'Dos' })).body.error.code).toBe('COURTESY_ALREADY_ACTIVE');

    const own = (await api.get(w.u.token, `/subscriptions/${w.svc.id}/seats`)).body.items.find((x: any) => x.isOwner);
    expect((await courtesy(w.u.token, own.id, { kind: 'permanent', reason: 'Yo' })).body.error.code).toBe('COURTESY_OWNER_SEAT');

    const w2 = await world();
    expect((await courtesy(w2.u.token, w2.seat.id, { kind: 'until_date', untilDate: '2026-10-20', reason: 'x' })).body.error.code).toBe('COURTESY_UNTIL_BEFORE_START');
    expect((await courtesy(w2.u.token, w2.seat.id, { kind: 'cycles', reason: 'x' })).body.error.code).toBe('VALIDATION_ERROR');
    const other = await api.newUser();
    expect((await courtesy(other.token, w2.seat.id, { kind: 'permanent', reason: 'x' })).status).toBe(404);
  });
});

/** A08 · parte b: tres ciclos prepagados y la cuota sube a 22.00 desde el ciclo 2, "por renovación". */
async function prepaid() {
  const w = await world();
  expect((await api.post(w.u.token, `/subscriptions/${w.svc.id}/cycles/generate`, { ahead: 2 })).status).toBe(200);
  const charges = await chargesOf(w.u.token, w.seat.id);
  expect(charges).toHaveLength(3);
  await pay(w.u.token, {
    contactId: w.ana.id, accountId: w.bcp.id, amount: '60.00',
    allocations: charges.map((c) => ({ obligationId: c.obligationId, amount: '20.00' })),
  });
  return w;
}
const change = async (token: string, seatId: string, body: Record<string, unknown>) => {
  const pv = await api.post(token, `/seats/${seatId}/quota-change/preview`, body);
  if (pv.status !== 200) return pv;
  return api.post(token, `/seats/${seatId}/quota-change`, { ...body, previewToken: pv.body.previewToken });
};

describe('A08b · cambio de cuota (RN-Q01–Q04, D-19)', () => {
  it('por renovación: +2.00 en cada ciclo futuro prepagado; Ana debe 4.00 y el anticipo no congeló el precio', async () => {
    const w = await prepaid();
    const body = { newQuota: '22.00', effectiveFrom: '2026-11-07', mode: 'per_renewal', reason: 'Subió Netflix' };
    const pv = await api.post(w.u.token, `/seats/${w.seat.id}/quota-change/preview`, body);
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body).toMatchObject({ oldQuota: '20.00', newQuota: '22.00', totals: { adjustment: '4.00', pendingBefore: '0.00', pendingAfter: '4.00', creditFreed: '0.00' } });
    expect(pv.body.adjustments.map((a: any) => [a.cycle.start, a.amount, a.dueDate])).toEqual([['2026-11-07', '2.00', '2026-11-07'], ['2026-12-07', '2.00', '2026-12-07']]);

    const r = await api.post(w.u.token, `/seats/${w.seat.id}/quota-change`, { ...body, previewToken: pv.body.previewToken });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.creditFreed).toBe('0.00');
    const charges = await chargesOf(w.u.token, w.seat.id);
    expect(byStart(charges, '2026-10-07')).toMatchObject({ pending: '0.00', adjustments: '0.00', paymentStatus: 'paid' });
    expect(byStart(charges, '2026-11-07')).toMatchObject({ net: '20.00', adjustments: '2.00', applied: '20.00', pending: '2.00', paymentStatus: 'partial' });
    expect(byStart(charges, '2026-12-07')).toMatchObject({ adjustments: '2.00', pending: '2.00' });
    expect((await api.get(w.u.token, `/contacts/${w.ana.id}/statement`)).body.totals.pending).toBe('4.00'); // no 6.00 ni 44.00

    const seat = (await api.get(w.u.token, `/seats/${w.seat.id}`)).body;
    expect(seat.quota).toBe('20.00'); // hoy sigue vigente la anterior
    expect(seat.scheduledQuota).toEqual({ quota: '22.00', from: '2026-11-07' });

    // Un ciclo nuevo se emite ya con la cuota nueva, sin ajuste (D-19).
    at('2027-01-08');
    expect(byStart(await chargesOf(w.u.token, w.seat.id), '2027-01-07')).toMatchObject({ net: '22.00', adjustments: '0.00', pending: '22.00' });
    expect((await api.get(w.u.token, `/seats/${w.seat.id}`)).body.quota).toBe('22.00');
  });

  it('"junta": todas las diferencias vencen en la fecha del cambio y el vencimiento efectivo lo refleja', async () => {
    const w = await prepaid();
    const r = await change(w.u.token, w.seat.id, { newQuota: '22.00', effectiveFrom: '2026-11-07', mode: 'lump', reason: 'Subió' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.adjustments.map((a: any) => a.dueDate)).toEqual(['2026-10-12', '2026-10-12']);
    const c2 = byStart(await chargesOf(w.u.token, w.seat.id), '2026-11-07');
    expect(c2).toMatchObject({ pending: '2.00', dueDate: '2026-10-12', overdue: false });
    at('2026-10-13');
    expect(byStart(await chargesOf(w.u.token, w.seat.id), '2026-11-07')).toMatchObject({ overdue: true });
    expect((await api.get(w.u.token, `/contacts/${w.ana.id}`)).body.totals).toMatchObject({ pending: '4.00', overdue: '4.00' });
  });

  it('si la cuota baja, lo cobrado de más vuelve como crédito libre del contacto (decisión 3)', async () => {
    const w = await prepaid();
    const r = await change(w.u.token, w.seat.id, { newQuota: '15.00', effectiveFrom: '2026-11-07', mode: 'per_renewal', reason: 'Bajó el precio' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.creditFreed).toBe('10.00');
    const charges = await chargesOf(w.u.token, w.seat.id);
    expect(byStart(charges, '2026-11-07')).toMatchObject({ adjustments: '-5.00', applied: '15.00', pending: '0.00', paymentStatus: 'paid' });
    expect(byStart(charges, '2026-12-07')).toMatchObject({ adjustments: '-5.00', applied: '15.00', pending: '0.00' });
    expect((await api.get(w.u.token, `/contacts/${w.ana.id}/credit`)).body).toMatchObject({ total: '10.00', free: '10.00', reserved: '0.00' });
    expect(await (async () => (await api.get(w.u.token, `/accounts/${w.bcp.id}`)).body.balance)()).toBe('260.00'); // el dinero ya estaba en la cuenta; no se mueve
  });

  it('solo al inicio de un ciclo futuro, una vez por fecha, y la vista previa caduca si cambia el estado', async () => {
    const w = await prepaid();
    const base = { newQuota: '22.00', mode: 'per_renewal', reason: 'x' };
    expect((await change(w.u.token, w.seat.id, { ...base, effectiveFrom: '2026-11-15' })).body.error.code).toBe('EFFECTIVE_DATE_NOT_CYCLE_START');
    expect((await change(w.u.token, w.seat.id, { ...base, effectiveFrom: '2026-10-07' })).body.error.code).toBe('EFFECTIVE_DATE_PAST');
    expect((await change(w.u.token, w.seat.id, { ...base, newQuota: '20.00', effectiveFrom: '2026-11-07' })).body.error.code).toBe('QUOTA_UNCHANGED');

    const body = { ...base, effectiveFrom: '2026-11-07' };
    const pv = await api.post(w.u.token, `/seats/${w.seat.id}/quota-change/preview`, body);
    // Mientras tanto Ana paga algo más → el estado cambia y el token caduca.
    await api.post(w.u.token, `/subscriptions/${w.svc.id}/cycles/generate`, { ahead: 3 });
    const stale = await api.post(w.u.token, `/seats/${w.seat.id}/quota-change`, { ...body, previewToken: pv.body.previewToken });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('PREVIEW_STALE');

    expect((await change(w.u.token, w.seat.id, body)).status).toBe(200);
    expect((await change(w.u.token, w.seat.id, { ...body, newQuota: '25.00' })).body.error.code).toBe('QUOTA_CHANGE_EXISTS');
    const n = await pool.query(`select count(*)::int as n from audit_event where owner_id = $1 and action = 'seat.quota_change'`, [w.u.id]);
    expect(n.rows[0].n).toBe(1);
  });

  it('una cortesía vigente no recibe ajustes de cuota', async () => {
    const w = await world();
    await api.post(w.u.token, `/subscriptions/${w.svc.id}/cycles/generate`, { ahead: 1 });
    expect((await courtesy(w.u.token, w.seat.id, { kind: 'cycles', cycles: 1, reason: 'Regalo' })).status).toBe(201);
    const r = await change(w.u.token, w.seat.id, { newQuota: '22.00', effectiveFrom: '2026-11-07', mode: 'per_renewal', reason: 'Subió' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.adjustments).toEqual([]);
    expect(byStart(await chargesOf(w.u.token, w.seat.id), '2026-11-07')).toMatchObject({ net: '0.00', adjustments: '0.00', paymentStatus: 'exempt' });
  });
});
