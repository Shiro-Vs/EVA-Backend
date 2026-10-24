import { afterAll, describe, expect, it } from 'vitest';
import { cardWindow } from '../../src/domain/card.js';
import { parseISO } from '../../src/domain/localDate.js';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount } from '../helpers/scenarios.js';

const api = makeApi();
afterAll(async () => { await api.app.close(); await pool.end(); });
const at = (iso: string) => api.setNow(new Date(`${iso}T17:00:00Z`));
const balance = async (token: string, id: string) => (await api.get(token, `/accounts/${id}`)).body.balance as string;

/** BCP con 500.00 y una tarjeta con 100.00 de deuda (saldo inicial −100.00). */
async function world() {
  at('2026-10-12');
  const u = await api.newUser();
  const bcp = await createAccount(api, u.token, 'BCP', '500.00');
  const card = await createAccount(api, u.token, 'Tarjeta', '-100.00', 'credit');
  return { u, bcp, card };
}
type W = Awaited<ReturnType<typeof world>>;
const payCard = async (w: W, amount: string) => (await api.post(w.u.token, '/operations', { kind: 'transfer', accountId: w.bcp.id, toAccountId: w.card.id, amount, date: '2026-10-11' })).body;

describe('A19 · compra con tarjeta y pago de la tarjeta (RN-MV04)', () => {
  it('la compra sube la deuda; pagar la tarjeta la baja sin repetir el gasto', async () => {
    const w = await world();
    const buy = await api.post(w.u.token, '/operations', { kind: 'expense', accountId: w.card.id, amount: '47.00', date: '2026-10-10', description: 'Netflix' });
    expect(buy.status, JSON.stringify(buy.body)).toBe(201);
    expect(await balance(w.u.token, w.card.id)).toBe('-147.00');
    const pay = await payCard(w, '47.00');
    expect(pay.kind).toBe('transfer');
    expect(await balance(w.u.token, w.card.id)).toBe('-100.00');
    expect(await balance(w.u.token, w.bcp.id)).toBe('453.00');
    const expenses = (await api.get(w.u.token, '/operations?kind=expense')).body.items;
    expect(expenses).toHaveLength(1); // el gasto de Netflix aparece UNA sola vez
    expect(expenses[0]).toMatchObject({ description: 'Netflix', amount: '-47.00' });
  });
});

describe('Configuración de la tarjeta (RN-T01, RN-AC05)', () => {
  it('línea, corte y pago; la línea disponible no es dinero propio', async () => {
    const w = await world();
    expect((await api.post(w.u.token, `/accounts/${w.bcp.id}/credit-details`, { cutoffDay: 20, dueDay: 10 })).body.error.code).toBe('NOT_CREDIT_ACCOUNT');
    expect((await api.get(w.u.token, `/accounts/${w.card.id}/credit-details`)).body).toEqual({ configured: false });
    expect((await api.post(w.u.token, `/accounts/${w.card.id}/credit-details`, { cutoffDay: 32, dueDay: 10 })).body.error.code).toBe('VALIDATION_ERROR');
    const r = await api.post(w.u.token, `/accounts/${w.card.id}/credit-details`, { creditLine: '1000.00', cutoffDay: 20, dueDay: 10 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ creditLine: '1000.00', cutoffDay: 20, dueDay: 10 });
    expect((await api.get(w.u.token, `/accounts/${w.card.id}`)).body.credit).toMatchObject({ creditLine: '1000.00', used: '100.00', available: '900.00' });
    await api.post(w.u.token, '/operations', { kind: 'expense', accountId: w.card.id, amount: '47.00', date: '2026-10-10' });
    expect((await api.get(w.u.token, `/accounts/${w.card.id}`)).body.credit).toMatchObject({ used: '147.00', available: '853.00' });
    expect((await api.get(w.u.token, '/summary')).body.balance.net).toBe('353.00'); // 500 − 147: la línea no suma
    // Reconfigurar reemplaza los datos.
    expect((await api.post(w.u.token, `/accounts/${w.card.id}/credit-details`, { cutoffDay: 15, dueDay: 5 })).body).toMatchObject({ creditLine: null, cutoffDay: 15, dueDay: 5 });
  });
});

describe('Estados de cuenta (RN-T02/T03)', () => {
  const stmt = { cutoffDate: '2026-09-20', dueDate: '2026-10-10', periodTotal: '80.00', minimumPayment: '20.00', totalBalance: '300.00' };

  it('corte y pago distintos; el pago total del período no es toda la deuda; los pagos vinculados no repiten el gasto', async () => {
    const w = await world();
    const s = await api.post(w.u.token, `/accounts/${w.card.id}/statements`, stmt);
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(s.body).toMatchObject({ periodTotal: '80.00', totalBalance: '300.00', status: 'unpaid', remaining: '80.00', overdue: true, minimumCovered: false });

    const p1 = await payCard(w, '30.00');
    const linked = await api.post(w.u.token, `/card-statements/${s.body.id}/payments`, { operationId: p1.id });
    expect(linked.status, JSON.stringify(linked.body)).toBe(201);
    expect(linked.body).toMatchObject({ status: 'partial', paid: '30.00', remaining: '50.00', minimumCovered: true, overdue: true });
    expect((await api.post(w.u.token, `/card-statements/${s.body.id}/payments`, { operationId: p1.id })).body.error.code).toBe('PAYMENT_ALREADY_LINKED');
    const expense = (await api.post(w.u.token, '/operations', { kind: 'expense', accountId: w.card.id, amount: '5.00', date: '2026-10-10' })).body;
    expect((await api.post(w.u.token, `/card-statements/${s.body.id}/payments`, { operationId: expense.id })).body.error.code).toBe('NOT_A_CARD_PAYMENT');
    const toBcp = (await api.post(w.u.token, '/operations', { kind: 'transfer', accountId: w.card.id, toAccountId: w.bcp.id, amount: '1.00', date: '2026-10-10' })).body;
    expect((await api.post(w.u.token, `/card-statements/${s.body.id}/payments`, { operationId: toBcp.id })).body.error.code).toBe('NOT_A_CARD_PAYMENT');

    const p2 = await payCard(w, '50.00');
    const done = await api.post(w.u.token, `/card-statements/${s.body.id}/payments`, { operationId: p2.id });
    expect(done.body).toMatchObject({ status: 'paid', paid: '80.00', remaining: '0.00', overdue: false });
    // Pagar el estado NO paga toda la deuda: la tarjeta sigue debiendo lo demás (saldo −100 −5 −1 +80 = −26... según el banco: 300 de saldo total).
    expect(done.body.totalBalance).toBe('300.00');

    // Quitar un vínculo reabre el saldo del estado; el dinero ya se movió y no se toca.
    const rm = await api.post(w.u.token, `/card-statement-payments/${linked.body.payments[0].id}/remove`, {});
    expect(rm.body).toMatchObject({ status: 'partial', paid: '50.00' });
    expect((await api.get(w.u.token, `/accounts/${w.card.id}/statements`)).body.items).toHaveLength(1);
  });

  it('validaciones: fechas, corte futuro, uno por corte y anular libera los pagos', async () => {
    const w = await world();
    const url = `/accounts/${w.card.id}/statements`;
    expect((await api.post(w.u.token, url, { ...stmt, dueDate: '2026-09-01' })).body.error.code).toBe('STATEMENT_DATES');
    expect((await api.post(w.u.token, url, { ...stmt, cutoffDate: '2026-10-20', dueDate: '2026-11-10' })).body.error.code).toBe('FUTURE_DATE_NOT_ALLOWED');
    expect((await api.post(w.u.token, `/accounts/${w.bcp.id}/statements`, stmt)).body.error.code).toBe('NOT_CREDIT_ACCOUNT');
    const s = (await api.post(w.u.token, url, stmt)).body;
    expect((await api.post(w.u.token, url, stmt)).body.error.code).toBe('STATEMENT_EXISTS');
    const p = await payCard(w, '30.00');
    await api.post(w.u.token, `/card-statements/${s.id}/payments`, { operationId: p.id });
    const v = await api.post(w.u.token, `/card-statements/${s.id}/void`, { reason: 'Lo cargué mal' });
    expect(v.body).toMatchObject({ status: 'void', paid: '0.00' });
    expect((await api.post(w.u.token, `/card-statements/${s.id}/void`, { reason: 'otra' })).body.error.code).toBe('ALREADY_VOID');
    // Con el estado anulado se puede registrar el correcto y vincular el mismo pago.
    const s2 = (await api.post(w.u.token, url, { ...stmt, periodTotal: '90.00' })).body;
    expect((await api.post(w.u.token, `/card-statements/${s2.id}/payments`, { operationId: p.id })).status).toBe(201);
    expect((await api.post(w.u.token, `/card-statements/${s.id}/payments`, { operationId: p.id })).body.error.code).toBe('ALREADY_VOID');
    expect((await api.get(w.u.token, `/card-statements/${s.id}`)).status).toBe(200);
    expect((await api.get((await api.newUser()).token, `/card-statements/${s.id}`)).status).toBe(404);
  });
});

describe('Compras en cuotas (RN-T04)', () => {
  it('un gasto por el total y un calendario que suma el total; el día se conserva (31 → 28 → 31)', async () => {
    const w = await world();
    const r = await api.post(w.u.token, `/accounts/${w.card.id}/installment-purchases`, { amount: '100.00', installments: 3, firstDueDate: '2026-11-28', description: 'Laptop' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.schedule.map((x: any) => [x.dueDate, x.amount])).toEqual([['2026-11-28', '33.34'], ['2026-12-28', '33.33'], ['2027-01-28', '33.33']]);
    expect(r.body).toMatchObject({ principal: '100.00', upcomingTotal: '100.00', status: 'active' });
    expect(await balance(w.u.token, w.card.id)).toBe('-200.00'); // −100 de apertura −100 de la compra: un solo gasto
    expect((await api.get(w.u.token, '/operations?kind=expense')).body.items).toHaveLength(1);

    const end = await api.post(w.u.token, `/accounts/${w.card.id}/installment-purchases`, { amount: '90.00', installments: 3, firstDueDate: '2027-01-31' });
    expect(end.body.schedule.map((x: any) => x.dueDate)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31']);
    expect((await api.post(w.u.token, `/accounts/${w.card.id}/installment-purchases`, { amount: '90.00', installments: 1, firstDueDate: '2027-01-31' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await api.post(w.u.token, `/accounts/${w.bcp.id}/installment-purchases`, { amount: '90.00', installments: 3, firstDueDate: '2027-01-31' })).body.error.code).toBe('NOT_CREDIT_ACCOUNT');

    const list = (await api.get(w.u.token, `/accounts/${w.card.id}/installment-plans`)).body.items;
    expect(list).toHaveLength(2);
    const c = await api.post(w.u.token, `/installment-plans/${r.body.id}/cancel`, {});
    expect(c.body).toMatchObject({ status: 'cancelled', upcomingTotal: '0.00' });
    expect((await api.post(w.u.token, `/installment-plans/${r.body.id}/cancel`, {})).body.error.code).toBe('ALREADY_CANCELLED');
  });
});

describe('Asesor de tarjeta (RN-T06)', () => {
  it('ordena por días hasta pagar según corte y pago; es solo aritmética de fechas', async () => {
    const w = await world();
    const b = await createAccount(api, w.u.token, 'Otra tarjeta', '0.00', 'credit');
    await api.post(w.u.token, `/accounts/${w.card.id}/credit-details`, { creditLine: '1000.00', cutoffDay: 20, dueDay: 10 });
    await api.post(w.u.token, `/accounts/${b.id}/credit-details`, { cutoffDay: 5, dueDay: 25 });
    const r = await api.get(w.u.token, '/cards/advisor');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.best).toMatchObject({ name: 'Otra tarjeta', cutoffDate: '2026-11-05', dueDate: '2026-11-25', daysToCutoff: 24, daysToPay: 44 });
    expect(r.body.cards[1]).toMatchObject({ name: 'Tarjeta', cutoffDate: '2026-10-20', dueDate: '2026-11-10', daysToCutoff: 8, daysToPay: 29, debt: '100.00', available: '900.00' });
    // Una compra el día del corte entra en ese estado de cuenta; al día siguiente, en el próximo.
    expect((await api.get(w.u.token, '/cards/advisor?date=2026-10-20')).body.cards.find((c: any) => c.name === 'Tarjeta').cutoffDate).toBe('2026-10-20');
    expect((await api.get(w.u.token, '/cards/advisor?date=2026-10-21')).body.cards.find((c: any) => c.name === 'Tarjeta').cutoffDate).toBe('2026-11-20');
  });

  it('calendario puro: días 29–31 se ajustan al último día del mes y el pago cae después del corte', () => {
    const w = cardWindow(parseISO('2026-02-10'), 31, 5);
    expect(w).toMatchObject({ daysToCutoff: 18, daysToPay: 23 }); // corte 28-feb, pago 5-mar
    const y = cardWindow(parseISO('2026-12-31'), 31, 15);
    expect(y.daysToPay).toBe(15); // corte 31-dic, pago 15-ene
  });
});
