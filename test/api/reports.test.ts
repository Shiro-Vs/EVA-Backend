import { afterAll, describe, expect, it } from 'vitest';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount, createContact, createService, joinSeat } from '../helpers/scenarios.js';

const api = makeApi();
afterAll(async () => { await api.app.close(); await pool.end(); });
const at = (iso: string) => api.setNow(new Date(`${iso}T17:00:00Z`));

/** Septiembre de 2026: BCP 1000 y Efectivo 200 desde el 1 de agosto; hoy es 12 de octubre. */
async function world() {
  at('2026-10-12');
  const u = await api.newUser();
  const bcp = await createAccount(api, u.token, 'BCP', '1000.00', 'bank', '2026-08-01');
  const cash = await createAccount(api, u.token, 'Efectivo', '200.00', 'cash', '2026-08-01');
  const tree = (await api.get(u.token, '/categories')).body.items as any[];
  const cat = (n: string) => tree.find((c) => c.name === n);
  const op = async (kind: string, accountId: string, amount: string, date: string, extra: Record<string, unknown> = {}) => {
    const r = await api.post(u.token, '/operations', { kind, accountId, amount, date, ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  };
  return { u, bcp, cash, cat, op };
}
const live = async (token: string, qs = 'month=2026-09') => {
  const r = await api.get(token, `/reports/monthly?${qs}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const line = (d: any, type: string) => d.flow.lines.find((l: any) => l.type === type);

describe('Resumen mensual: dos vistas que no se duplican (08 §1)', () => {
  it('flujo de dinero y resultado por conceptos con los mismos datos', async () => {
    const w = await world();
    await w.op('income', w.bcp.id, '3000.00', '2026-09-05', { description: 'Sueldo' });
    await w.op('expense', w.bcp.id, '800.00', '2026-09-06', { categoryId: w.cat('Hogar').id, description: 'Alquiler' });
    await w.op('expense', w.cash.id, '50.00', '2026-09-10', { description: 'Menú' });
    await w.op('transfer', w.bcp.id, '100.00', '2026-09-12', { toAccountId: w.cash.id });
    await w.op('expense', w.bcp.id, '70.00', '2026-10-02', { description: 'Fuera de mes' });
    const d = await live(w.u.token);

    expect(d).toMatchObject({ live: true, period: { month: '2026-09', from: '2026-09-01', to: '2026-09-30' }, rulesVersion: 'reports@1', savedVersions: [], differsFromLatestSaved: null });
    // Cuentas: apertura y cierre propios
    expect(d.accounts.map((a: any) => [a.name, a.opening, a.closing])).toEqual([['BCP', '1000.00', '3100.00'], ['Efectivo', '200.00', '250.00']]);
    // Flujo: la transferencia entra y sale sin ser ingreso ni gasto; cuadra con los saldos
    expect(d.flow).toMatchObject({ opening: '1200.00', totalIn: '3100.00', totalOut: '950.00', net: '2150.00', closing: '3350.00', reconciles: true });
    expect(line(d, 'income')).toMatchObject({ in: '3000.00', out: '0.00' });
    expect(line(d, 'expense')).toMatchObject({ in: '0.00', out: '850.00' });
    expect(line(d, 'transfer')).toMatchObject({ in: '100.00', out: '100.00', net: '0.00' });
    // Resultado: sin la transferencia (RN-RP01)
    expect(d.results.income.total).toBe('3000.00');
    expect(d.results.consumption.total).toBe('850.00');
    expect(d.results.consumption.byCategory).toEqual([{ name: 'Hogar', total: '800.00', count: 1, percent: 94.1 }, { name: 'Sin categoría', total: '50.00', count: 1, percent: 5.8 }]);
    expect(d.results.net).toBe('2150.00');
    expect(d.other.transfers).toEqual({ in: '100.00', out: '100.00' });
    expect(d.notes.some((n: string) => n.includes('1 gastos sin categoría'))).toBe(true);
  });

  it('filtra por cuenta y la transferencia queda como entrada o salida de esa cuenta; sigue cuadrando', async () => {
    const w = await world();
    await w.op('transfer', w.bcp.id, '100.00', '2026-09-12', { toAccountId: w.cash.id });
    await w.op('expense', w.cash.id, '30.00', '2026-09-13');
    const d = await live(w.u.token, `month=2026-09&accountIds=${w.cash.id}`);
    expect(d.filters.accounts).toEqual(['Efectivo']);
    expect(d.flow).toMatchObject({ opening: '200.00', closing: '270.00', reconciles: true });
    expect(d.other.transfers).toEqual({ in: '100.00', out: '0.00' });
    expect(d.results.consumption.total).toBe('30.00');
  });

  it('la compra con tarjeta es un solo gasto y pagarla después no lo repite (RN-RP02, A19)', async () => {
    const w = await world();
    const card = (await api.post(w.u.token, '/accounts', { name: 'Visa', type: 'credit', openingBalance: { amount: '0.00', date: '2026-08-01' } })).body;
    await w.op('expense', card.id, '300.00', '2026-09-03', { description: 'Zapatillas' });
    await w.op('transfer', w.bcp.id, '300.00', '2026-09-20', { toAccountId: card.id });
    const d = await live(w.u.token);
    expect(d.results.consumption.total).toBe('300.00');
    expect(d.other.cardPayments).toBe('300.00');
    expect(line(d, 'card_payment')).toMatchObject({ in: '300.00', out: '300.00' });
    expect(d.flow.reconciles).toBe(true);
  });

  it('un ajuste de saldo va en su línea y no es ingreso (RN-RP06)', async () => {
    const w = await world();
    const pv = await api.post(w.u.token, `/accounts/${w.cash.id}/reconciliation/preview`, { realBalance: '180.00', asOf: '2026-09-15' });
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    await api.post(w.u.token, `/accounts/${w.cash.id}/reconciliation`, { realBalance: '180.00', asOf: '2026-09-15', previewToken: pv.body.previewToken, reason: 'Conteo' });
    const d = await live(w.u.token);
    expect(line(d, 'adjustment')).toMatchObject({ out: '20.00' });
    expect(d.other.adjustments).toBe('-20.00');
    expect(d.results.consumption.total).toBe('0.00');
    expect(d.flow.reconciles).toBe(true);
  });

  it('un movimiento revertido no suma en el resultado y la reversión va en su línea (RN-RP06)', async () => {
    const w = await world();
    const bad = await w.op('expense', w.bcp.id, '99.00', '2026-09-08', { description: 'Error' });
    await w.op('expense', w.bcp.id, '10.00', '2026-09-09');
    await api.post(w.u.token, `/operations/${bad.id}/reverse`, { reason: 'Error', date: '2026-09-09' });
    const d = await live(w.u.token);
    expect(d.results.consumption.total).toBe('10.00');
    expect(line(d, 'reversal')).toMatchObject({ in: '99.00' });
    expect(d.other.reversals).toEqual({ reversed: 1, reversalEntries: 1 });
    expect(d.flow.reconciles).toBe(true);
  });

  it('un pago de préstamo bancario separa el costo financiero del capital (RN-RP03, A20)', async () => {
    const w = await world();
    const loan = (await api.post(w.u.token, '/bank-loans', { name: 'Personal' })).body;
    const body = { accountId: w.bcp.id, amount: '100.00', paidOn: '2026-09-15', principal: '70.00', interest: '20.00', insurance: '5.00', fees: '3.00' };
    const pv = await api.post(w.u.token, `/bank-loans/${loan.id}/payments/preview`, body);
    await api.post(w.u.token, `/bank-loans/${loan.id}/payments`, { ...body, previewToken: pv.body.previewToken });
    const d = await live(w.u.token);
    expect(d.results.financialCosts).toMatchObject({ total: '28.00', bankInterest: '20.00', bankInsurance: '5.00', bankFees: '3.00' });
    expect(d.other.loans.capitalOut).toBe('72.00'); // 70 de capital + 2 sin desglosar
    expect(d.results.consumption.total).toBe('0.00');
    expect(d.notes.some((n: string) => n.includes('sin desglose completo'))).toBe(true);
    expect(d.results.net).toBe('-28.00');
    expect(line(d, 'loan')).toMatchObject({ out: '100.00' });
  });

  it('servicios compartidos: pago real menos cobros, aparte del consumo (RN-RP04, A07)', async () => {
    at('2026-10-07');
    const u = await api.newUser();
    const bcp = await createAccount(api, u.token, 'BCP', '500.00', 'bank', '2026-09-01');
    const svc = await createService(api, u.token, { announcedPrice: '45.00' });
    const ana = await createContact(api, u.token, 'Ana');
    const seat = await joinSeat(api, u.token, svc.id, ana.id, { quota: '20.00' });
    at('2026-10-12');
    const cur = (await api.get(u.token, `/subscriptions/${svc.id}`)).body.currentCycle ?? (await api.get(u.token, `/subscriptions/${svc.id}/cycles`)).body.items[0];
    await api.post(u.token, `/billing-cycles/${cur.id}/supplier-payment`, { accountId: bcp.id, amount: '47.00', paidOn: '2026-10-10' });
    const body = { contactId: ana.id, accountId: bcp.id, amount: '20.00', receivedOn: '2026-10-11', allocations: [{ obligationId: seat.body.charges[0].obligationId, amount: '20.00' }] };
    const pv = await api.post(u.token, '/receipts/preview', body);
    if (pv.status === 200 && pv.body.previewToken) await api.post(u.token, '/receipts', { ...body, previewToken: pv.body.previewToken });
    const d = (await api.get(u.token, '/reports/monthly?month=2026-10')).body;
    expect(d.results.sharedServices.paidToSuppliers).toBe('47.00');
    expect(d.results.consumption.total).toBe('0.00'); // el pago al proveedor NO es gasto de consumo
    expect(d.results.income.total).toBe('0.00'); // el cobro NO es ingreso ganado
    expect(d.flow.reconciles).toBe(true);
    expect(line(d, 'service_payment')).toMatchObject({ out: '47.00' });
  });

  it('el detalle de movimientos es opcional', async () => {
    const w = await world();
    await w.op('expense', w.bcp.id, '10.00', '2026-09-09', { description: 'Café' });
    expect((await live(w.u.token)).operations).toBeUndefined();
    const d = await live(w.u.token, 'month=2026-09&detail=1');
    expect(d.operations).toEqual([expect.objectContaining({ date: '2026-09-09', account: 'BCP', description: 'Café', amount: '-10.00', type: 'expense' })]);
  });

  it('valida el mes, el futuro y la propiedad de las cuentas', async () => {
    const w = await world();
    const o = await world();
    expect((await api.get(w.u.token, '/reports/monthly?month=2026-13')).status).toBe(422);
    expect((await api.get(w.u.token, '/reports/monthly')).status).toBe(422);
    expect((await api.get(w.u.token, '/reports/monthly?month=2026-11')).body.error.code).toBe('FUTURE_DATE_NOT_ALLOWED');
    expect((await api.get(w.u.token, `/reports/monthly?month=2026-09&accountIds=${o.bcp.id}`)).status).toBe(404);
  });
});

describe('A25 · versiones guardadas y corrección posterior (RN-RM01…RM04)', () => {
  it('una corrección posterior cambia la vista viva y genera otra versión sin borrar la anterior', async () => {
    const w = await world();
    await w.op('income', w.bcp.id, '3000.00', '2026-09-05', { description: 'Sueldo' });
    const exp = await w.op('expense', w.bcp.id, '800.00', '2026-09-06', { description: 'Alquiler' });

    const v1 = await api.post(w.u.token, '/reports/monthly/snapshots', { month: '2026-09' });
    expect(v1.status, JSON.stringify(v1.body)).toBe(201);
    expect(v1.body).toMatchObject({ period: '2026-09', version: 1, unchanged: false, previousVersion: null, rulesVersion: 'reports@1' });
    expect(v1.body.data.results.consumption.total).toBe('800.00');

    // Sin cambios: no se crea otra versión.
    const same = await api.post(w.u.token, '/reports/monthly/snapshots', { month: '2026-09' });
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ version: 1, unchanged: true, id: v1.body.id });
    expect((await live(w.u.token)).differsFromLatestSaved).toBe(false);

    // Corrección posterior: el alquiler se registró mal (era 750).
    const fix = await api.post(w.u.token, `/operations/${exp.id}/correct`, { amount: '750.00', reason: 'Monto equivocado', previewToken: (await api.post(w.u.token, `/operations/${exp.id}/correct/preview`, { amount: '750.00' })).body.previewToken });
    expect(fix.status, JSON.stringify(fix.body)).toBeLessThan(300);
    const now = await live(w.u.token);
    expect(now.differsFromLatestSaved).toBe(true);
    expect(now.results.consumption.total).toBe('750.00');
    expect(now.savedVersions.map((s: any) => s.version)).toEqual([1]);

    const v2 = await api.post(w.u.token, '/reports/monthly/snapshots', { month: '2026-09' });
    expect(v2.status).toBe(201);
    expect(v2.body).toMatchObject({ version: 2, previousVersion: 1, unchanged: false });
    expect(v2.body.data.results.consumption.total).toBe('750.00');

    // La versión 1 se conserva intacta.
    const old = (await api.get(w.u.token, `/reports/snapshots/${v1.body.id}`)).body;
    expect(old).toMatchObject({ version: 1 });
    expect(old.data.results.consumption.total).toBe('800.00');
    const list = (await api.get(w.u.token, '/reports/monthly/snapshots?month=2026-09')).body.items;
    expect(list.map((s: any) => s.version).sort()).toEqual([1, 2]);
    expect((await live(w.u.token)).differsFromLatestSaved).toBe(false);
  });

  it('las versiones son inmutables en la base y privadas por usuario', async () => {
    const w = await world();
    await w.op('expense', w.bcp.id, '5.00', '2026-09-09');
    const v = (await api.post(w.u.token, '/reports/monthly/snapshots', { month: '2026-09' })).body;
    await expect(pool.query('update report_snapshot set data = \'{}\' where id = $1', [v.id])).rejects.toThrow(/REPORT_SNAPSHOT_IMMUTABLE/);
    await expect(pool.query('delete from report_snapshot where id = $1', [v.id])).rejects.toThrow(/REPORT_SNAPSHOT_IMMUTABLE/);
    const o = await world();
    expect((await api.get(o.u.token, `/reports/snapshots/${v.id}`)).status).toBe(404);
    expect((await api.get(o.u.token, '/reports/monthly/snapshots')).body.items).toEqual([]);
  });

  it('cuentas y detalle distintos son informes distintos, con su propia numeración', async () => {
    const w = await world();
    await w.op('expense', w.bcp.id, '5.00', '2026-09-09');
    const all = (await api.post(w.u.token, '/reports/monthly/snapshots', { month: '2026-09' })).body;
    const one = (await api.post(w.u.token, '/reports/monthly/snapshots', { month: '2026-09', accountIds: [w.bcp.id] })).body;
    expect(all.version).toBe(1);
    expect(one.version).toBe(1);
    expect(all.id).not.toBe(one.id);
  });
});

describe('PDF del resumen', () => {
  it('genera un PDF del resumen vivo y de una versión guardada', async () => {
    const w = await world();
    await w.op('income', w.bcp.id, '3000.00', '2026-09-05', { description: 'Sueldo' });
    await w.op('expense', w.bcp.id, '800.00', '2026-09-06', { categoryId: w.cat('Hogar').id, description: 'Alquiler' });
    const liveRes = await api.app.inject({ method: 'GET', url: '/v1/reports/monthly/pdf?month=2026-09&detail=1', headers: { authorization: `Bearer ${w.u.token}` } });
    expect(liveRes.statusCode).toBe(200);
    expect(liveRes.headers['content-type']).toBe('application/pdf');
    expect(liveRes.headers['content-disposition']).toContain('resumen-2026-09.pdf');
    expect(liveRes.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(liveRes.rawPayload.length).toBeGreaterThan(1500);

    const snap = (await api.post(w.u.token, '/reports/monthly/snapshots', { month: '2026-09' })).body;
    const snapRes = await api.app.inject({ method: 'GET', url: `/v1/reports/snapshots/${snap.id}/pdf`, headers: { authorization: `Bearer ${w.u.token}` } });
    expect(snapRes.statusCode).toBe(200);
    expect(snapRes.headers['content-disposition']).toContain('resumen-2026-09-v1.pdf');
    expect(snapRes.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const o = await world();
    const denied = await api.app.inject({ method: 'GET', url: `/v1/reports/snapshots/${snap.id}/pdf`, headers: { authorization: `Bearer ${o.u.token}` } });
    expect(denied.statusCode).toBe(404);
  });
});
