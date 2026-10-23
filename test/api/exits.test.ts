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
  return r.body;
}

async function setLimit(token: string, days: number | null) {
  const me = (await api.get(token, '/me')).body;
  expect((await api.patch(token, '/me', { exitDaysLimit: days }, me.version)).status).toBe(200);
}

async function world(startDate: string, nextPaymentDate: string, quota = '20.00') {
  at(startDate);
  const u = await api.newUser();
  const bcp = await createAccount(api, u.token, 'BCP', '200.00', 'bank', startDate);
  const svc = await createService(api, u.token, { startDate, nextPaymentDate });
  const ana = await createContact(api, u.token, 'Ana');
  const seat = await joinSeat(api, u.token, svc.id, ana.id, { quota });
  expect(seat.status, JSON.stringify(seat.body)).toBe(201);
  return { u, bcp, svc, ana, seat: seat.body as any };
}

const preview = (token: string, seatId: string) => api.post(token, `/seats/${seatId}/exit/preview`, {});
async function exit(token: string, seatId: string, reason = 'Se va') {
  const pv = await preview(token, seatId);
  if (pv.status !== 200) return pv;
  return api.post(token, `/seats/${seatId}/exit`, { reason, previewToken: pv.body.previewToken });
}
async function supplierPays(w: { u: { token: string }; svc: { id: string }; bcp: { id: string } }, cycleStart: string, amount = '45.00') {
  const cycles = (await api.get(w.u.token, `/subscriptions/${w.svc.id}/cycles`)).body.items as any[];
  const c = cycles.find((x) => x.startDate === cycleStart);
  const r = await api.post(w.u.token, `/billing-cycles/${c.id}/supplier-payment`, { accountId: w.bcp.id, amount, paidOn: cycleStart });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

describe('A10 · baja con el ciclo pagado al proveedor y anticipos futuros (RN-X01/X02/X05)', () => {
  it('termina el ciclo sin devolverlo; los 5 ciclos siguientes se cancelan y se programa una devolución de 100.00', async () => {
    const w = await world('2026-01-04', '2026-02-04');
    await api.post(w.u.token, `/subscriptions/${w.svc.id}/cycles/generate`, { ahead: 6 });
    const charges = await chargesOf(w.u.token, w.seat.id);
    expect(charges).toHaveLength(7);
    await pay(w.u.token, { contactId: w.ana.id, accountId: w.bcp.id, amount: '140.00', allocations: charges.map((c) => ({ obligationId: c.obligationId, amount: '20.00' })) });
    at('2026-02-15');
    await supplierPays(w, '2026-02-04');
    const balanceBefore = (await api.get(w.u.token, `/accounts/${w.bcp.id}`)).body.balance;

    const pv = await preview(w.u.token, w.seat.id);
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body).toMatchObject({ mode: 'finish_cycle', reasonCode: 'SUPPLIER_PAID', requestedOn: '2026-02-15', effectiveOn: '2026-03-04', currentCharge: null, loan: null });
    expect(pv.body.voidedCharges).toHaveLength(5);
    expect(pv.body.refunds.total).toBe('100.00');

    const r = await api.post(w.u.token, `/seats/${w.seat.id}/exit`, { reason: 'Se muda', previewToken: pv.body.previewToken });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.seat.endDate).toBe('2026-03-04');
    expect(r.body.seat.voidedCharges).toHaveLength(5);
    const left = await chargesOf(w.u.token, w.seat.id);
    expect(left.map((c) => [c.cycle.start, c.paymentStatus])).toEqual([['2026-02-04', 'paid'], ['2026-01-04', 'paid']]);
    expect((await api.get(w.u.token, `/contacts/${w.ana.id}/statement`)).body.totals.pending).toBe('0.00');

    // El dinero real aún NO salió: la devolución está programada (RN-X06).
    const refunds = (await api.get(w.u.token, '/refunds?status=planned')).body.items;
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ amount: '100.00', status: 'planned', operationId: null });
    expect((await api.get(w.u.token, `/accounts/${w.bcp.id}`)).body.balance).toBe(balanceBefore);
    expect((await api.get(w.u.token, `/contacts/${w.ana.id}/credit`)).body.total).toBe('0.00');

    // Salida real: egreso desde la cuenta.
    const paid = await api.post(w.u.token, `/refunds/${refunds[0].id}/pay`, { accountId: w.bcp.id });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body).toMatchObject({ status: 'paid' });
    expect(paid.body.operationId).toBeTruthy();
    expect(Number((await api.get(w.u.token, `/accounts/${w.bcp.id}`)).body.balance)).toBe(Number(balanceBefore) - 100);
    expect((await api.post(w.u.token, `/refunds/${refunds[0].id}/pay`, { accountId: w.bcp.id })).body.error.code).toBe('REFUND_NOT_PLANNED');

    // No se puede dar de baja dos veces; la plaza deja de contar cuando llega su fecha final.
    expect((await preview(w.u.token, w.seat.id)).body.error.code).toBe('SEAT_ALREADY_ENDING');
    expect((await api.get(w.u.token, `/subscriptions/${w.svc.id}/seats`)).body.items.map((s: any) => s.label)).toContain('Cuenta 1');
    at('2026-03-05');
    expect((await api.get(w.u.token, `/subscriptions/${w.svc.id}/seats`)).body.items.map((s: any) => s.label)).not.toContain('Cuenta 1');
    const cn = await pool.query(`select status from membership where owner_id = $1 and contact_id = $2`, [w.u.id, w.ana.id]);
    expect(cn.rows[0].status).toBe('ending');
  });
});

describe('A11 · baja temprana con el ciclo sin pagar al proveedor, y la igualdad (RN-X03/X04, D-01)', () => {
  const setup = async () => {
    const w = await world('2026-04-04', '2026-05-04');
    await pay(w.u.token, { contactId: w.ana.id, accountId: w.bcp.id, amount: '20.00', allocations: [{ obligationId: w.seat.charges[0].obligationId, amount: '20.00' }] });
    await setLimit(w.u.token, 7);
    return w;
  };

  it('a) el 8-abr (u = 4 < 7): cobro 3.00, devolución 17.00, efectiva hoy', async () => {
    const w = await setup();
    at('2026-04-08');
    const pv = await preview(w.u.token, w.seat.id);
    expect(pv.body).toMatchObject({ mode: 'immediate', reasonCode: 'EARLY_EXIT', usedDays: 4, exitDaysLimit: 7, effectiveOn: '2026-04-08' });
    expect(pv.body.currentCharge).toMatchObject({ netBefore: '20.00', chargeAfter: '3.00', adjustment: '-17.00' });
    expect(pv.body.refunds.total).toBe('17.00');
    const r = await api.post(w.u.token, `/seats/${w.seat.id}/exit`, { reason: 'Cambia de plan', previewToken: pv.body.previewToken });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(byStart(await chargesOf(w.u.token, w.seat.id), '2026-04-04')).toMatchObject({ adjustments: '-17.00', applied: '3.00', pending: '0.00', paymentStatus: 'paid' });
    expect((await api.get(w.u.token, '/refunds')).body.items[0]).toMatchObject({ amount: '17.00', status: 'planned' });
    expect((await api.get(w.u.token, `/seats/${w.seat.id}`)).body.endDate).toBe('2026-04-08');
    expect((await api.get(w.u.token, `/subscriptions/${w.svc.id}`)).body.occupiedSeats).toBe(1);
  });

  it('b) el 11-abr (u = 7 = L): la igualdad termina el ciclo, sin devolución', async () => {
    const w = await setup();
    at('2026-04-11');
    const pv = await preview(w.u.token, w.seat.id);
    expect(pv.body).toMatchObject({ mode: 'finish_cycle', reasonCode: 'LIMIT_REACHED', usedDays: 7, effectiveOn: '2026-05-04', currentCharge: null });
    expect(pv.body.refunds.total).toBe('0.00');
  });

  it('c) el 8-abr con el proveedor ya pagado: termina el ciclo (tiene prioridad); sin límite definido también', async () => {
    const w = await setup();
    at('2026-04-08');
    await supplierPays(w, '2026-04-04');
    expect((await preview(w.u.token, w.seat.id)).body).toMatchObject({ mode: 'finish_cycle', reasonCode: 'SUPPLIER_PAID', supplierPaid: true, effectiveOn: '2026-05-04' });

    const w2 = await world('2026-04-04', '2026-05-04');
    at('2026-04-06');
    expect((await preview(w2.u.token, w2.seat.id)).body).toMatchObject({ mode: 'finish_cycle', reasonCode: 'NO_LIMIT_DEFINED' });
  });

  it('la vista previa caduca si cambió el estado; tu propia plaza no se retira', async () => {
    const w = await setup();
    at('2026-04-08');
    const pv = await preview(w.u.token, w.seat.id);
    await supplierPays(w, '2026-04-04'); // cambia el estado (y el modo) entre la vista previa y la baja
    const stale = await api.post(w.u.token, `/seats/${w.seat.id}/exit`, { reason: 'x', previewToken: pv.body.previewToken });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('PREVIEW_STALE');
    const own = (await api.get(w.u.token, `/subscriptions/${w.svc.id}/seats`)).body.items.find((x: any) => x.isOwner);
    expect((await preview(w.u.token, own.id)).body.error.code).toBe('EXIT_OWNER_SEAT');
  });

  it('una devolución programada se puede cancelar (el dinero vuelve a ser crédito libre) o hacerse a mano', async () => {
    const w = await setup();
    at('2026-04-08');
    expect((await exit(w.u.token, w.seat.id)).status).toBe(200);
    const [rf] = (await api.get(w.u.token, '/refunds')).body.items;
    expect((await api.get(w.u.token, `/contacts/${w.ana.id}/credit`)).body.total).toBe('0.00'); // reservada para devolver
    const c = await api.post(w.u.token, `/refunds/${rf.id}/cancel`, { reason: 'Prefiere dejarlo como saldo' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect((await api.get(w.u.token, `/contacts/${w.ana.id}/credit`)).body).toMatchObject({ total: '17.00', free: '17.00' });
    expect((await api.post(w.u.token, `/refunds/${rf.id}/cancel`, { reason: 'otra vez' })).body.error.code).toBe('REFUND_NOT_PLANNED');
    const receiptId = rf.receiptId;
    expect((await api.post(w.u.token, '/refunds', { receiptId, amount: '20.00', reason: 'Demasiado' })).body.error.code).toBe('REFUND_EXCEEDS_FREE_CREDIT');
    const manual = await api.post(w.u.token, '/refunds', { receiptId, amount: '5.00', reason: 'Parte en efectivo' });
    expect(manual.status, JSON.stringify(manual.body)).toBe(201);
    expect((await api.get(w.u.token, `/contacts/${w.ana.id}/credit`)).body.free).toBe('12.00');
  });
});

describe('A12 · retiro con deuda: préstamo con detalle y reingreso (RN-X07/X09)', () => {
  it('debe marzo 20.00 y abril 10.00 → un préstamo de 30.00 con 2 componentes; la deuda total no cambia y no hay operaciones nuevas', async () => {
    const w = await world('2026-03-04', '2026-04-04');
    at('2026-04-05');
    const charges = await chargesOf(w.u.token, w.seat.id);
    expect(charges).toHaveLength(2);
    const apr = byStart(charges, '2026-04-04');
    await pay(w.u.token, { contactId: w.ana.id, accountId: w.bcp.id, amount: '10.00', allocations: [{ obligationId: apr.obligationId, amount: '10.00' }] });
    expect((await api.get(w.u.token, `/contacts/${w.ana.id}/statement`)).body.totals.pending).toBe('30.00');
    const ops = async () => (await pool.query(`select count(*)::int as n from financial_operation where owner_id = $1`, [w.u.id])).rows[0].n;
    const opsBefore = await ops();

    at('2026-04-10');
    const pv = await preview(w.u.token, w.seat.id);
    expect(pv.body.loan.total).toBe('30.00');
    expect(pv.body.loan.components.map((c: any) => c.amount)).toEqual(['20.00', '10.00']);
    const r = await api.post(w.u.token, `/seats/${w.seat.id}/exit`, { reason: 'Se retira', previewToken: pv.body.previewToken });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.loanId).toBeTruthy();

    const loan = (await api.get(w.u.token, `/loans/${r.body.loanId}`)).body;
    expect(loan).toMatchObject({ principal: '30.00', pending: '30.00', status: 'open', origin: 'debt_conversion', conversion: { trigger: 'exit' } });
    expect(loan.components).toHaveLength(2);
    expect(loan.components.map((c: any) => [c.amount, c.pending]).sort()).toEqual([['10.00', '10.00'], ['20.00', '20.00']]);
    expect(loan.components.every((c: any) => c.originObligationId && c.concept.includes('Netflix'))).toBe(true);
    const after = await chargesOf(w.u.token, w.seat.id);
    expect(after.map((c) => [c.pending, c.converted, c.paymentStatus])).toEqual([['0.00', '10.00', 'converted'], ['0.00', '20.00', 'converted']]);
    const st = (await api.get(w.u.token, `/contacts/${w.ana.id}/statement`)).body;
    expect(st.totals.pending).toBe('30.00'); // 30.00 antes y después: no se duplica
    expect(st.loans).toHaveLength(1);
    expect(await ops()).toBe(opsBefore); // ningún ingreso ni egreso ficticio

    // Reingreso (RN-X09): parte sin deuda del servicio; el préstamo sigue aparte.
    at('2026-04-12');
    const again = await joinSeat(api, w.u.token, w.svc.id, w.ana.id, { quota: '20.00', label: 'Cuenta 2' });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.charges).toHaveLength(1);
    expect((await api.get(w.u.token, `/contacts/${w.ana.id}/statement`)).body.totals.pending).toBe('45.00'); // 30.00 préstamo + 15.00 del tramo nuevo
    const mem = await pool.query(`select status from membership where owner_id = $1 and contact_id = $2`, [w.u.id, w.ana.id]);
    expect(mem.rows.map((x: any) => x.status)).toEqual(['active']);

    // El préstamo se paga con un cobro normal repartido entre sus componentes y se cierra solo.
    const received = await pay(w.u.token, {
      contactId: w.ana.id, accountId: w.bcp.id, amount: '30.00', reserveRemainder: null,
      allocations: loan.components.map((c: any) => ({ obligationId: c.obligationId, amount: c.pending })),
    });
    expect(received.availability.unapplied).toBe('0.00');
    expect((await api.get(w.u.token, `/loans/${r.body.loanId}`)).body).toMatchObject({ status: 'closed', pending: '0.00' });
    expect((await api.get(w.u.token, `/loans?contactId=${w.ana.id}`)).body.items).toHaveLength(1);
  });

  it('si queda pendiente y a la vez hay crédito de ciclos futuros, avisa y deja elegir (REFUND_AND_DEBT)', async () => {
    const w = await world('2026-03-04', '2026-04-04');
    await api.post(w.u.token, `/subscriptions/${w.svc.id}/cycles/generate`, { ahead: 1 });
    at('2026-04-05');
    const charges = await chargesOf(w.u.token, w.seat.id);
    const future = byStart(charges, '2026-05-04');
    expect(future).toBeUndefined(); // sin cargo por adelantado todavía; se emite el del ciclo de abril
    const apr = byStart(charges, '2026-04-04');
    await api.post(w.u.token, `/subscriptions/${w.svc.id}/cycles/generate`, { ahead: 1 });
    const next = byStart(await chargesOf(w.u.token, w.seat.id), '2026-05-04');
    await pay(w.u.token, { contactId: w.ana.id, accountId: w.bcp.id, amount: '20.00', allocations: [{ obligationId: next.obligationId, amount: '20.00' }] });
    const pv = await preview(w.u.token, w.seat.id);
    expect(pv.body.warnings).toContain('REFUND_AND_DEBT');
    expect(pv.body.refunds.total).toBe('20.00');
    expect(pv.body.loan.total).toBe('40.00'); // marzo y abril sin pagar
    expect(apr.pending).toBe('20.00');
  });
});
