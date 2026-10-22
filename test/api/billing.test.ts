import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { makeApi, type Api } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount, createContact, createService, joinSeat } from '../helpers/scenarios.js';

const api = makeApi();
afterAll(async () => { await api.app.close(); await pool.end(); });
const at = (iso: string) => api.setNow(new Date(`${iso}T17:00:00Z`));

/** Vista previa + cobro. Devuelve la respuesta del cobro (o la de la vista previa si no es válida). */
async function pay(token: string, body: Record<string, unknown>, key?: string) {
  const pv = await api.post(token, '/receipts/preview', body);
  expect(pv.status, JSON.stringify(pv.body)).toBe(200);
  if (!pv.body.previewToken) return { ...pv, invalidPreview: true as const };
  return api.post(token, '/receipts', { ...body, previewToken: pv.body.previewToken }, key ? { 'idempotency-key': key } : {});
}

async function chargesOf(token: string, seatId: string) {
  return (await api.get(token, `/seats/${seatId}`)).body.charges as Array<any>;
}

/** Usuario con BCP, y un servicio con un participante de cuota fija que ingresa el día de renovación (cargo completo). */
async function world(opts: { quota?: string; serviceName?: string; capacity?: number } = {}) {
  at('2026-10-07');
  const u = await api.newUser();
  const bcp = await createAccount(api, u.token, 'BCP', '200.00');
  const svc = await createService(api, u.token, { name: opts.serviceName ?? 'Netflix', capacity: opts.capacity ?? 4 });
  const ana = await createContact(api, u.token, 'Ana');
  const seat = await joinSeat(api, u.token, svc.id, ana.id, { quota: opts.quota ?? '20.00' });
  expect(seat.status, JSON.stringify(seat.body)).toBe(201);
  at('2026-10-12');
  return { u, bcp, svc, ana, seat: seat.body, charge: seat.body.charges[0] };
}
const balance = async (token: string, id: string) => (await api.get(token, `/accounts/${id}`)).body.balance;

describe('A06 · dos cobros parciales a un cargo', () => {
  it('pendiente 10 → 0; dos ingresos reales y ninguno por las aplicaciones', async () => {
    const w = await world();
    const base = { contactId: w.ana.id, accountId: w.bcp.id, receivedOn: '2026-10-12' };
    const r1 = await pay(w.u.token, { ...base, amount: '10.00', allocations: [{ obligationId: w.charge.obligationId, amount: '10.00' }] });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    let c = (await chargesOf(w.u.token, w.seat.id))[0];
    expect(c).toMatchObject({ pending: '10.00', applied: '10.00', paymentStatus: 'partial' });
    const r2 = await pay(w.u.token, { ...base, amount: '10.00', allocations: [{ obligationId: w.charge.obligationId, amount: '10.00' }] });
    expect(r2.status).toBe(201);
    c = (await chargesOf(w.u.token, w.seat.id))[0];
    expect(c).toMatchObject({ pending: '0.00', applied: '20.00', paymentStatus: 'paid' });
    expect(await balance(w.u.token, w.bcp.id)).toBe('220.00'); // 200 + 10 + 10
    const entries = (await api.get(w.u.token, `/accounts/${w.bcp.id}/entries`)).body.items;
    expect(entries.filter((e: any) => e.kind === 'income')).toHaveLength(2); // las aplicaciones no crean ingresos
    expect(r1.body.receipt.operationId).not.toBe(r2.body.receipt.operationId);
  });
});

describe('A07 · un ingreso repartido entre tres servicios', () => {
  it('una operación +50.00, tres aplicaciones que suman 50.00 y el mismo recibo en cada servicio', async () => {
    at('2026-10-07');
    const u = await api.newUser();
    const bcp = await createAccount(api, u.token, 'BCP', '200.00');
    const ana = await createContact(api, u.token, 'Ana');
    const seats: Array<{ seatId: string; obligationId: string }> = [];
    for (const [name, quota] of [['Netflix', '20.00'], ['Spotify', '20.00'], ['YouTube', '10.00']] as const) {
      const svc = await createService(api, u.token, { name });
      const s = await joinSeat(api, u.token, svc.id, ana.id, { quota });
      expect(s.status).toBe(201);
      seats.push({ seatId: s.body.id, obligationId: s.body.charges[0].obligationId });
    }
    at('2026-10-12');
    const r = await pay(u.token, {
      contactId: ana.id, accountId: bcp.id, amount: '50.00',
      allocations: [{ obligationId: seats[0]!.obligationId, amount: '20.00' }, { obligationId: seats[1]!.obligationId, amount: '20.00' }, { obligationId: seats[2]!.obligationId, amount: '10.00' }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.allocations.map((a: any) => a.amount)).toEqual(['20.00', '20.00', '10.00']);
    expect(r.body.availability).toMatchObject({ received: '50.00', applied: '50.00', unapplied: '0.00', free: '0.00' });
    expect(await balance(u.token, bcp.id)).toBe('250.00');
    const entries = (await api.get(u.token, `/accounts/${bcp.id}/entries`)).body.items.filter((e: any) => e.kind === 'income');
    expect(entries).toHaveLength(1);
    expect(entries[0].amount).toBe('50.00');
    for (const s of seats) expect((await chargesOf(u.token, s.seatId))[0].paymentStatus).toBe('paid');
    expect((await api.get(u.token, `/contacts/${ana.id}`)).body.totals.pending).toBe('0.00');
    const rec = (await api.get(u.token, `/receipts/${r.body.receipt.id}`)).body;
    expect(rec.allocations).toHaveLength(3);
  });
});

describe('A08 (parte a) · anticipo de varios ciclos', () => {
  it('60.00 por adelantado cubren los tres ciclos emitidos; el sobrante es 0', async () => {
    const w = await world();
    const gen = await api.post(w.u.token, `/subscriptions/${w.svc.id}/cycles/generate`, { ahead: 2 });
    expect(gen.status).toBe(200);
    const charges = (await chargesOf(w.u.token, w.seat.id)).slice().reverse();
    expect(charges.map((c: any) => [c.cycle.start, c.net])).toEqual([['2026-10-07', '20.00'], ['2026-11-07', '20.00'], ['2026-12-07', '20.00']]);
    const r = await pay(w.u.token, {
      contactId: w.ana.id, accountId: w.bcp.id, amount: '60.00',
      allocations: charges.map((c: any) => ({ obligationId: c.obligationId, amount: '20.00' })),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.availability).toMatchObject({ unapplied: '0.00', reserved: '0.00' });
    expect((await chargesOf(w.u.token, w.seat.id)).every((c: any) => c.paymentStatus === 'paid')).toBe(true);
  });

  it('sin ciclos adelantados solo existe el cargo del ciclo en curso (D-08)', async () => {
    const w = await world();
    expect(await chargesOf(w.u.token, w.seat.id)).toHaveLength(1);
  });
});

describe('A09 · sobrante reservado, trasladado y aplicado solo', () => {
  it('30.00 sobre un cargo de 20.00 → reserva de 10.00 para Netflix; trasladarla no toca el dinero', async () => {
    const w = await world();
    const spotify = await createService(api, w.u.token, { name: 'Spotify' });
    const r = await pay(w.u.token, { contactId: w.ana.id, accountId: w.bcp.id, amount: '30.00', allocations: [{ obligationId: w.charge.obligationId, amount: '20.00' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.availability).toMatchObject({ received: '30.00', applied: '20.00', unapplied: '10.00', reserved: '10.00', free: '0.00' });
    const before = await balance(w.u.token, w.bcp.id);
    const credit = (await api.get(w.u.token, `/contacts/${w.ana.id}/credit`)).body;
    expect(credit).toMatchObject({ total: '10.00', reserved: '10.00', free: '0.00' });
    expect(credit.reservations[0]).toMatchObject({ subscriptionName: 'Netflix', amount: '10.00' });

    const mv = await api.post(w.u.token, `/credit-reservations/${credit.reservations[0].id}/move`, { subscriptionId: spotify.id });
    expect(mv.status, JSON.stringify(mv.body)).toBe(200);
    const after = (await api.get(w.u.token, `/contacts/${w.ana.id}/credit`)).body;
    expect(after).toMatchObject({ total: '10.00', reserved: '10.00' }); // el crédito total no cambia
    expect(after.reservations[0].subscriptionName).toBe('Spotify');
    expect(await balance(w.u.token, w.bcp.id)).toBe(before); // saldo de la cuenta sin cambio
    expect((await api.get(w.u.token, `/receipts/${r.body.receipt.id}`)).body.amount).toBe('30.00');
    const n = await pool.query(`select count(*)::int as n from audit_event where owner_id = $1 and action = 'reservation.move'`, [w.u.id]);
    expect(n.rows[0].n).toBe(1);
  });

  it('al emitirse el siguiente cargo la reserva se aplica sola y se puede deshacer (D-09)', async () => {
    const w = await world();
    const r = await pay(w.u.token, { contactId: w.ana.id, accountId: w.bcp.id, amount: '30.00', allocations: [{ obligationId: w.charge.obligationId, amount: '20.00' }] });
    expect(r.body.availability.reserved).toBe('10.00');

    at('2026-11-08'); // empieza el ciclo 2: se emite el cargo de 20.00
    const charges = await chargesOf(w.u.token, w.seat.id);
    const next = charges.find((c: any) => c.cycle.start === '2026-11-07');
    expect(next).toMatchObject({ net: '20.00', applied: '10.00', pending: '10.00', paymentStatus: 'partial' });
    const rec = (await api.get(w.u.token, `/receipts/${r.body.receipt.id}`)).body;
    expect(rec.allocations.map((a: any) => [a.origin, a.amount, a.status]).sort()).toEqual([['manual', '20.00', 'active'], ['reservation', '10.00', 'active']]);
    expect(rec.reservations.find((x: any) => x.status === 'consumed')).toBeTruthy();

    // Deshacer: la aplicación se libera y la reserva vuelve
    const auto = rec.allocations.find((a: any) => a.origin === 'reservation');
    const undo = await api.post(w.u.token, `/allocations/${auto.id}/release`, { reason: 'Prefiero aplicarlo a mano' });
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
    expect(undo.body.reservationId).toBeTruthy();
    const again = (await chargesOf(w.u.token, w.seat.id)).find((c: any) => c.cycle.start === '2026-11-07');
    expect(again).toMatchObject({ applied: '0.00', pending: '20.00', paymentStatus: 'unpaid' });
    expect((await api.get(w.u.token, `/contacts/${w.ana.id}/credit`)).body).toMatchObject({ total: '10.00', reserved: '10.00' });
    const twice = await api.post(w.u.token, `/allocations/${auto.id}/release`, { reason: 'otra vez' });
    expect(twice.body.error.code).toBe('ALREADY_RELEASED');
  });

  it('sin reserva explícita y con varios servicios el sobrante queda como crédito libre', async () => {
    const w = await world();
    const r = await pay(w.u.token, { contactId: w.ana.id, accountId: w.bcp.id, amount: '35.00', allocations: [{ obligationId: w.charge.obligationId, amount: '20.00' }], reserveRemainder: null });
    expect(r.body.availability).toMatchObject({ unapplied: '15.00', reserved: '0.00', free: '15.00' });
  });
});

describe('validación del reparto (RN-R04)', () => {
  it('no se puede aplicar más que el pendiente ni más que el cobro → OVER_ALLOCATION', async () => {
    const w = await world();
    const base = { contactId: w.ana.id, accountId: w.bcp.id };
    const more = { ...base, amount: '60.00', allocations: [{ obligationId: w.charge.obligationId, amount: '25.00' }] };
    const pv = await api.post(w.u.token, '/receipts/preview', more);
    expect(pv.body.valid).toBe(false);
    expect(pv.body.issues[0]).toMatchObject({ code: 'EXCEEDS_OBLIGATION', pending: '20.00', requested: '25.00' });
    expect(pv.body.previewToken).toBeUndefined();
    const create = await api.post(w.u.token, '/receipts', { ...more, previewToken: 'x'.repeat(24) });
    expect(create.status).toBe(422);
    expect(create.body.error.code).toBe('OVER_ALLOCATION');

    const over = await api.post(w.u.token, '/receipts', { ...base, amount: '10.00', allocations: [{ obligationId: w.charge.obligationId, amount: '15.00' }], previewToken: 'x'.repeat(24) });
    expect(over.body.error.code).toBe('OVER_ALLOCATION');
    expect(await balance(w.u.token, w.bcp.id)).toBe('200.00'); // nada se registró
  });

  it('cobro y cargo de distinto contacto → ALLOCATION_CONTACT_MISMATCH', async () => {
    const w = await world();
    const beto = await createContact(api, w.u.token, 'Beto');
    const r = await api.post(w.u.token, '/receipts/preview', { contactId: beto.id, accountId: w.bcp.id, amount: '20.00', allocations: [{ obligationId: w.charge.obligationId, amount: '20.00' }] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('ALLOCATION_CONTACT_MISMATCH');
  });

  it('importe no positivo, fecha futura y cuenta archivada se rechazan', async () => {
    const w = await world();
    const base = { contactId: w.ana.id, accountId: w.bcp.id, allocations: [] as unknown[] };
    expect((await api.post(w.u.token, '/receipts/preview', { ...base, amount: '0.00' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await api.post(w.u.token, '/receipts/preview', { ...base, amount: '5.00', receivedOn: '2026-10-13' })).body.error.code).toBe('FUTURE_DATE_NOT_ALLOWED');
    await api.post(w.u.token, `/accounts/${w.bcp.id}/archive`);
    expect((await api.post(w.u.token, '/receipts/preview', { ...base, amount: '5.00' })).body.error.code).toBe('ACCOUNT_ARCHIVED');
  });

  it('un cobro sin aplicaciones es un anticipo: queda como crédito libre o reservado', async () => {
    const w = await world();
    const r = await pay(w.u.token, { contactId: w.ana.id, accountId: w.bcp.id, amount: '40.00', allocations: [], reserveRemainder: { subscriptionId: w.svc.id } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.availability).toMatchObject({ received: '40.00', applied: '0.00', reserved: '40.00', free: '0.00' });
  });
});

describe('vista previa → confirmación del cobro', () => {
  it('si el pendiente cambia entre la vista previa y la confirmación → PREVIEW_STALE', async () => {
    const w = await world();
    const body = { contactId: w.ana.id, accountId: w.bcp.id, amount: '5.00', allocations: [{ obligationId: w.charge.obligationId, amount: '5.00' }] };
    const pv = await api.post(w.u.token, '/receipts/preview', body);
    expect((await pay(w.u.token, { contactId: w.ana.id, accountId: w.bcp.id, amount: '10.00', allocations: [{ obligationId: w.charge.obligationId, amount: '10.00' }] })).status).toBe(201);
    const late = await api.post(w.u.token, '/receipts', { ...body, previewToken: pv.body.previewToken });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('PREVIEW_STALE');
  });
});

describe('A22 (parte E1) · aceptación repetida', () => {
  it('la misma Idempotency-Key no duplica el cobro: un recibo, una operación, saldo +20 una vez', async () => {
    const w = await world();
    const body = { contactId: w.ana.id, accountId: w.bcp.id, amount: '20.00', allocations: [{ obligationId: w.charge.obligationId, amount: '20.00' }] };
    const key = randomUUID();
    const pv = await api.post(w.u.token, '/receipts/preview', body);
    const send = () => api.post(w.u.token, '/receipts', { ...body, previewToken: pv.body.previewToken }, { 'idempotency-key': key });
    const r1 = await send();
    const r2 = await send(); // reintento (doble toque, pérdida de conexión): mismo cuerpo, mismo token, misma clave
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body.receipt.id).toBe(r1.body.receipt.id);
    expect(r2.headers['idempotency-replayed']).toBe('true');
    expect(await balance(w.u.token, w.bcp.id)).toBe('220.00');
    const n = await pool.query(`select count(*)::int as n from receipt where owner_id = $1`, [w.u.id]);
    expect(n.rows[0].n).toBe(1);
  });
});

describe('A28a · sobreaplicación concurrente', () => {
  it('dos cobros simultáneos de 15.00 sobre un cargo de 20.00: uno entra, el otro OVER_ALLOCATION; pendiente 5.00', async () => {
    const w = await world();
    const body = { contactId: w.ana.id, accountId: w.bcp.id, amount: '15.00', allocations: [{ obligationId: w.charge.obligationId, amount: '15.00' }] };
    const [pa, pb] = [await api.post(w.u.token, '/receipts/preview', body), await api.post(w.u.token, '/receipts/preview', body)];
    const [ra, rb] = await Promise.all([
      api.post(w.u.token, '/receipts', { ...body, previewToken: pa.body.previewToken }),
      api.post(w.u.token, '/receipts', { ...body, previewToken: pb.body.previewToken }),
    ]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([201, 422]);
    expect([ra, rb].find((x) => x.status === 422)!.body.error.code).toBe('OVER_ALLOCATION');
    expect((await chargesOf(w.u.token, w.seat.id))[0]).toMatchObject({ pending: '5.00', applied: '15.00' });
    expect(await balance(w.u.token, w.bcp.id)).toBe('215.00'); // el perdedor no dejó ingreso
  });
});

describe('A27 · aislamiento en cobros', () => {
  it('no se aplica un cobro a una obligación de otro usuario', async () => {
    const w = await world();
    const u2 = await api.newUser();
    const acc2 = await createAccount(api, u2.token, 'BCP 2', '10.00');
    const c2 = await createContact(api, u2.token, 'Ana 2');
    const r = await api.post(u2.token, '/receipts/preview', { contactId: c2.id, accountId: acc2.id, amount: '5.00', allocations: [{ obligationId: w.charge.obligationId, amount: '5.00' }] });
    expect(r.status).toBe(404);
    expect((await api.get(u2.token, `/receipts/${randomUUID()}`)).status).toBe(404);
    expect((await api.post(u2.token, '/receipts/preview', { contactId: w.ana.id, accountId: acc2.id, amount: '5.00', allocations: [] })).status).toBe(404);
    expect(await balance(u2.token, acc2.id)).toBe('10.00');
  });
});

describe('A14 · pago al proveedor', () => {
  it('registrado el 10 con renovación el 7: el calendario no cambia; saldo 200 → 153 (A01)', async () => {
    const w = await world();
    const cur = (await api.get(w.u.token, `/subscriptions/${w.svc.id}`)).body.currentCycle;
    const r = await api.post(w.u.token, `/billing-cycles/${cur.id}/supplier-payment`, { accountId: w.bcp.id, amount: '47.00', paidOn: '2026-10-10' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ supplierPayment: { amount: '47.00', announcedPrice: '45.00', paidOn: '2026-10-10' }, cycle: { startDate: '2026-10-07', endDate: '2026-11-07' }, calendarUnchanged: true });
    expect(await balance(w.u.token, w.bcp.id)).toBe('153.00');
    const sub = (await api.get(w.u.token, `/subscriptions/${w.svc.id}`)).body;
    expect(sub.currentCycle).toMatchObject({ startDate: '2026-10-07', endDate: '2026-11-07' });
    expect(sub.nextCycle.startDate).toBe('2026-11-07');
  });

  it('un ciclo admite un solo pago activo; tras revertirlo se puede registrar otro', async () => {
    const w = await world();
    const cur = (await api.get(w.u.token, `/subscriptions/${w.svc.id}`)).body.currentCycle;
    const first = await api.post(w.u.token, `/billing-cycles/${cur.id}/supplier-payment`, { accountId: w.bcp.id, amount: '47.00' });
    const dup = await api.post(w.u.token, `/billing-cycles/${cur.id}/supplier-payment`, { accountId: w.bcp.id, amount: '47.00' });
    expect(dup.body.error.code).toBe('SUPPLIER_PAYMENT_EXISTS');
    const rev = await api.post(w.u.token, `/supplier-payments/${first.body.supplierPayment.id}/reverse`, { reason: 'Monto equivocado' });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    expect(await balance(w.u.token, w.bcp.id)).toBe('200.00');
    const again = await api.post(w.u.token, `/billing-cycles/${cur.id}/supplier-payment`, { accountId: w.bcp.id, amount: '46.00' });
    expect(again.status).toBe(201);
    expect(await balance(w.u.token, w.bcp.id)).toBe('154.00');
    // La operación del pago no se puede revertir por la vía genérica
    const generic = await api.post(w.u.token, `/operations/${again.body.operationId}/reverse`, { reason: 'x' });
    expect(generic.body.error.code).toBe('OPERATION_LINKED');
  });

  it('con tarjeta de crédito el pago aumenta la deuda de la tarjeta (A19, paso 1)', async () => {
    const w = await world();
    const card = await api.post(w.u.token, '/accounts', { name: 'Tarjeta', type: 'credit', openingBalance: { amount: '-100.00', date: '2026-10-01' } });
    const cur = (await api.get(w.u.token, `/subscriptions/${w.svc.id}`)).body.currentCycle;
    const r = await api.post(w.u.token, `/billing-cycles/${cur.id}/supplier-payment`, { accountId: card.body.id, amount: '47.00' });
    expect(r.status).toBe(201);
    expect(await balance(w.u.token, card.body.id)).toBe('-147.00');
    // Pagar la tarjeta desde BCP es una transferencia: reduce banco y deuda sin repetir el gasto
    await api.post(w.u.token, '/operations', { kind: 'transfer', accountId: w.bcp.id, toAccountId: card.body.id, amount: '47.00' });
    expect(await balance(w.u.token, card.body.id)).toBe('-100.00');
    expect(await balance(w.u.token, w.bcp.id)).toBe('153.00');
  });

  it('rechaza fecha futura, importe cero y ciclo ajeno', async () => {
    const w = await world();
    const cur = (await api.get(w.u.token, `/subscriptions/${w.svc.id}`)).body.currentCycle;
    expect((await api.post(w.u.token, `/billing-cycles/${cur.id}/supplier-payment`, { accountId: w.bcp.id, amount: '47.00', paidOn: '2026-10-20' })).body.error.code).toBe('FUTURE_DATE_NOT_ALLOWED');
    expect((await api.post(w.u.token, `/billing-cycles/${cur.id}/supplier-payment`, { accountId: w.bcp.id, amount: '0.00' })).body.error.code).toBe('VALIDATION_ERROR');
    const other = await api.newUser();
    const acc = await createAccount(api, other.token);
    expect((await api.post(other.token, `/billing-cycles/${cur.id}/supplier-payment`, { accountId: acc.id, amount: '10.00' })).status).toBe(404);
  });
});

describe('A18 · costo previsto vs según cobros', () => {
  /** Ana con dos plazas (10 + 8), Beto y Carla con `q`; cobros: Beto q, Carla q y Ana 6.00. Pago real 47. */
  async function netflixCost(q: string, anaPays: string) {
    at('2026-10-07');
    const u = await api.newUser();
    const bcp = await createAccount(api, u.token);
    const svc = await createService(api, u.token, { capacity: 5 });
    const [ana, beto, carla] = [await createContact(api, u.token, 'Ana'), await createContact(api, u.token, 'Beto'), await createContact(api, u.token, 'Carla')];
    const a1 = (await joinSeat(api, u.token, svc.id, ana.id, { label: 'Cuenta 1', quota: '10.00' })).body;
    await joinSeat(api, u.token, svc.id, ana.id, { label: 'Cuenta 2', quota: '8.00' });
    const b = (await joinSeat(api, u.token, svc.id, beto.id, { quota: q })).body;
    const c = (await joinSeat(api, u.token, svc.id, carla.id, { quota: q })).body;
    at('2026-10-12');
    const cycle = (await api.get(u.token, `/subscriptions/${svc.id}`)).body.currentCycle;
    await pay(u.token, { contactId: beto.id, accountId: bcp.id, amount: q, allocations: [{ obligationId: b.charges[0].obligationId, amount: q }] });
    await pay(u.token, { contactId: carla.id, accountId: bcp.id, amount: q, allocations: [{ obligationId: c.charges[0].obligationId, amount: q }] });
    await pay(u.token, { contactId: ana.id, accountId: bcp.id, amount: anaPays, allocations: [{ obligationId: a1.charges[0].obligationId, amount: anaPays }] });
    const before = (await api.get(u.token, `/subscriptions/${svc.id}/cost-summary`)).body;
    await api.post(u.token, `/billing-cycles/${cycle.id}/supplier-payment`, { accountId: bcp.id, amount: '47.00', paidOn: '2026-10-10' });
    const after = (await api.get(u.token, `/subscriptions/${svc.id}/cost-summary`)).body;
    return { before, after, cycleId: cycle.id, u, svc };
  }

  it('pago 47, exigibles 36, cobrados 24 → previsto 11, según cobros 23, pendiente 12', async () => {
    const { before, after } = await netflixCost('9.00', '6.00');
    expect(before).toMatchObject({ actualPaid: null, estimated: true, expectedFromOthers: '36.00', receivedFromOthers: '24.00', projectedCost: '9.00', costByCollections: '21.00' });
    expect(after).toMatchObject({ announcedPrice: '45.00', actualPaid: '47.00', expectedFromOthers: '36.00', receivedFromOthers: '24.00', pendingFromOthers: '12.00', projectedCost: '11.00', costByCollections: '23.00', surplus: '0.00', estimated: false });
  });

  it('pago 47, exigibles 34, cobrados 24 → previsto 13, según cobros 23, pendiente 10 (A18)', async () => {
    const { after } = await netflixCost('8.00', '8.00');
    expect(after).toMatchObject({ expectedFromOthers: '34.00', receivedFromOthers: '24.00', pendingFromOthers: '10.00', projectedCost: '13.00', costByCollections: '23.00' });
  });

  it('el detalle del ciclo trae cargos, pago y costo juntos', async () => {
    const { u, cycleId } = await netflixCost('9.00', '6.00');
    const d = (await api.get(u.token, `/billing-cycles/${cycleId}`)).body;
    expect(d.charges).toHaveLength(4); // 2 plazas de Ana + Beto + Carla; la tuya no genera cargo
    expect(d.supplierPayment).toMatchObject({ amount: '47.00' });
    expect(d.costSummary.projectedCost).toBe('11.00');
  });
});
