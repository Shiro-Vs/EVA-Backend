import { afterAll, describe, expect, it } from 'vitest';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount } from '../helpers/scenarios.js';

const api = makeApi();
afterAll(async () => { await api.app.close(); await pool.end(); });
const at = (iso: string) => api.setNow(new Date(`${iso}T17:00:00Z`));
const balance = async (token: string, id: string) => (await api.get(token, `/accounts/${id}`)).body.balance as string;

async function world(opening = '100.00') {
  at('2026-10-12');
  const u = await api.newUser();
  const bcp = await createAccount(api, u.token, 'BCP', opening, 'bank', '2026-08-01');
  return { u, bcp };
}
type W = Awaited<ReturnType<typeof world>>;
const goal = async (w: W, over: Record<string, unknown> = {}) => {
  const r = await api.post(w.u.token, '/goals', { name: 'Viaje', targetAmount: '1000.00', ...over });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
const reserve = (w: W, goalId: string, amount: string, accountId = w.bcp.id) => api.post(w.u.token, `/goals/${goalId}/reserve`, { accountId, amount });
const opCount = async (w: W) => (await pool.query(`select count(*)::int as n from financial_operation where owner_id = $1 and kind <> 'opening'`, [w.u.id])).rows[0].n;

describe('A21 · reserva para una meta (RN-GO02/GO03)', () => {
  it('BCP con 100.00 y 30.00 reservados: saldo 100, reservado 30, libre 70 y ninguna operación', async () => {
    const w = await world();
    const g = await goal(w);
    const before = await opCount(w);
    const r = await reserve(w, g.id, '30.00');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ saved: '30.00', remaining: '970.00', percent: 3, achieved: false });
    expect(r.body.accounts).toEqual([{ accountId: w.bcp.id, name: 'BCP', reserved: '30.00', accountBalance: '100.00', overReserved: false }]);
    expect(await balance(w.u.token, w.bcp.id)).toBe('100.00'); // el saldo no se mueve
    expect(await opCount(w)).toBe(before); // y no se creó ninguna operación
    const ov = (await api.get(w.u.token, '/goals/overview')).body;
    expect(ov.accounts[0]).toMatchObject({ name: 'BCP', total: '100.00', reserved: '30.00', free: '70.00', overReserved: false });
    expect(ov.totals).toEqual({ total: '100.00', reserved: '30.00', free: '70.00' });
  });

  it('no se reserva más de lo libre, ni en una tarjeta de crédito, ni en una meta archivada', async () => {
    const w = await world();
    const g = await goal(w);
    await reserve(w, g.id, '30.00');
    const over = await reserve(w, g.id, '80.00');
    expect(over.body.error.code).toBe('INSUFFICIENT_FREE_BALANCE');
    expect(over.body.error.details).toMatchObject({ free: '70.00', requested: '80.00' });
    const card = await createAccount(api, w.u.token, 'Tarjeta', '-50.00', 'credit', '2026-08-01');
    expect((await reserve(w, g.id, '10.00', card.id)).body.error.code).toBe('GOAL_ACCOUNT_TYPE');
    await api.post(w.u.token, `/goals/${g.id}/archive`, {});
    expect((await reserve(w, g.id, '10.00')).body.error.code).toBe('GOAL_ARCHIVED');
    // Mientras la meta está archivada, su ahorro ya no bloquea el saldo libre ni los gastos.
    expect((await api.get(w.u.token, '/goals/overview')).body.accounts[0]).toMatchObject({ reserved: '0.00', free: '100.00', overReserved: false });
    expect((await api.post(w.u.token, `/goals/${g.id}/restore`, {})).body.status).toBe('active');
    expect((await api.get(w.u.token, '/goals/overview')).body.accounts[0]).toMatchObject({ reserved: '30.00', free: '70.00', overReserved: false });
  });

  it('liberar devuelve el dinero a libre; no se libera más de lo reservado', async () => {
    const w = await world();
    const g = await goal(w);
    await reserve(w, g.id, '50.00');
    const rel = await api.post(w.u.token, `/goals/${g.id}/release`, { accountId: w.bcp.id, amount: '20.00' });
    expect(rel.body.saved).toBe('30.00');
    expect((await api.post(w.u.token, `/goals/${g.id}/release`, { accountId: w.bcp.id, amount: '31.00' })).body.error.code).toBe('RELEASE_EXCEEDS_RESERVED');
    const detail = (await api.get(w.u.token, `/goals/${g.id}`)).body;
    expect(detail.contributions.map((c: any) => [c.kind, c.amount])).toEqual([['release', '-20.00'], ['reserve', '50.00']]);
  });

  it('avance con lo reservado: meta cumplida y fecha objetivo', async () => {
    const w = await world('2000.00');
    const g = await goal(w, { targetAmount: '500.00', targetDate: '2026-12-31' });
    expect(g).toMatchObject({ daysLeft: 80, achieved: false, percent: 0 });
    expect((await reserve(w, g.id, '500.00')).body).toMatchObject({ achieved: true, percent: 100, remaining: '0.00' });
    expect((await api.post(w.u.token, '/goals', { name: 'x', targetAmount: '10.00', targetDate: '2026-10-01' })).body.error.code).toBe('GOAL_DATE_PAST');
    const ed = await api.patch(w.u.token, `/goals/${g.id}`, { targetAmount: '800.00', name: 'Viaje a Cusco' }, g.version);
    expect(ed.body).toMatchObject({ name: 'Viaje a Cusco', targetAmount: '800.00', percent: 62.5, achieved: false });
    expect((await api.patch(w.u.token, `/goals/${g.id}`, { name: 'otra' }, g.version)).body.error.code).toBe('CONFLICT_VERSION');
  });
});

describe('Varias metas por cuenta y aviso de sobrerreserva (RN-GO05, D-30)', () => {
  it('Σ reservado puede igualar el saldo; si un gasto lo deja por debajo, se avisa', async () => {
    const w = await world();
    const a = await goal(w, { name: 'A' });
    const b = await goal(w, { name: 'B' });
    await reserve(w, a.id, '60.00');
    await reserve(w, b.id, '40.00');
    expect((await api.get(w.u.token, '/goals/overview')).body.accounts[0]).toMatchObject({ reserved: '100.00', free: '0.00', overReserved: false });
    // Gastar 20 usa dinero reservado: hay que decidir antes de confirmar.
    const spend = { kind: 'expense', accountId: w.bcp.id, amount: '20.00', date: '2026-10-12', description: 'Taxi' };
    const conflict = await api.post(w.u.token, '/operations', spend);
    expect(conflict.status).toBe(422);
    expect(conflict.body.error.code).toBe('GOAL_RESERVE_CONFLICT');
    expect(conflict.body.error.details.eaten).toBe('20.00');
    expect(conflict.body.error.details.goals.map((g: any) => [g.name, g.reserved])).toEqual([['A', '60.00'], ['B', '40.00']]);
    expect(await balance(w.u.token, w.bcp.id)).toBe('100.00'); // nada se registró

    // Aceptar el faltante: el gasto se registra y lo reservado queda por encima del saldo (con aviso).
    const accepted = await api.post(w.u.token, '/operations', { ...spend, acceptReserveShortfall: true });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    const ov = (await api.get(w.u.token, '/goals/overview')).body.accounts[0];
    expect(ov).toMatchObject({ total: '80.00', reserved: '100.00', free: '-20.00', overReserved: true });
    expect((await api.get(w.u.token, `/goals/${a.id}`)).body.accounts[0].overReserved).toBe(true);
  });

  it('descontar de las metas elegidas deja todo consistente', async () => {
    const w = await world();
    const a = await goal(w, { name: 'A' });
    const b = await goal(w, { name: 'B' });
    await reserve(w, a.id, '60.00');
    await reserve(w, b.id, '40.00');
    const spend = { kind: 'expense', accountId: w.bcp.id, amount: '30.00', date: '2026-10-12', description: 'Laptop' };
    expect((await api.post(w.u.token, '/operations', { ...spend, goalDeductions: [{ goalId: a.id, amount: '10.00' }] })).body.error.code).toBe('GOAL_DEDUCTION_INSUFFICIENT');
    expect((await api.post(w.u.token, '/operations', { ...spend, goalDeductions: [{ goalId: b.id, amount: '50.00' }] })).body.error.code).toBe('GOAL_DEDUCTION_EXCEEDS');
    const ok = await api.post(w.u.token, '/operations', { ...spend, goalDeductions: [{ goalId: a.id, amount: '20.00' }, { goalId: b.id, amount: '10.00' }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(await balance(w.u.token, w.bcp.id)).toBe('70.00');
    expect((await api.get(w.u.token, `/goals/${a.id}`)).body).toMatchObject({ saved: '40.00' });
    expect((await api.get(w.u.token, `/goals/${b.id}`)).body).toMatchObject({ saved: '30.00' });
    expect((await api.get(w.u.token, '/goals/overview')).body.accounts[0]).toMatchObject({ total: '70.00', reserved: '70.00', free: '0.00', overReserved: false });
    const hist = (await api.get(w.u.token, `/goals/${a.id}`)).body.contributions;
    expect(hist[0]).toMatchObject({ kind: 'spend', amount: '-20.00', operationId: ok.body.id });
  });

  it('un gasto con dinero libre no pide nada; una transferencia que saca dinero reservado sí', async () => {
    const w = await world('300.00');
    const g = await goal(w);
    await reserve(w, g.id, '100.00');
    expect((await api.post(w.u.token, '/operations', { kind: 'expense', accountId: w.bcp.id, amount: '200.00', date: '2026-10-12' })).status).toBe(201); // usa solo lo libre
    const other = await createAccount(api, w.u.token, 'Efectivo', '0.00', 'cash', '2026-08-01');
    const t = await api.post(w.u.token, '/operations', { kind: 'transfer', accountId: w.bcp.id, toAccountId: other.id, amount: '10.00', date: '2026-10-12' });
    expect(t.body.error.code).toBe('GOAL_RESERVE_CONFLICT');
  });
});

describe('Transferencias de ahorro vinculadas (RN-GO02)', () => {
  it('lo transferido a la cuenta de ahorro queda reservado para la meta; una transferencia solo se vincula una vez', async () => {
    const w = await world('500.00');
    const savings = await createAccount(api, w.u.token, 'Ahorros', '0.00', 'savings', '2026-08-01');
    const g = await goal(w);
    const t = (await api.post(w.u.token, '/operations', { kind: 'transfer', accountId: w.bcp.id, toAccountId: savings.id, amount: '200.00', date: '2026-10-12' })).body;
    const r = await api.post(w.u.token, `/goals/${g.id}/link-transfer`, { operationId: t.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.saved).toBe('200.00');
    expect(r.body.accounts[0]).toMatchObject({ name: 'Ahorros', reserved: '200.00', accountBalance: '200.00' });
    expect((await api.get(w.u.token, '/goals/overview')).body.accounts.find((a: any) => a.name === 'Ahorros')).toMatchObject({ total: '200.00', reserved: '200.00', free: '0.00' });
    expect((await api.post(w.u.token, `/goals/${g.id}/link-transfer`, { operationId: t.id })).body.error.code).toBe('TRANSFER_ALREADY_LINKED');
    const e = (await api.post(w.u.token, '/operations', { kind: 'expense', accountId: w.bcp.id, amount: '5.00', date: '2026-10-12' })).body;
    expect((await api.post(w.u.token, `/goals/${g.id}/link-transfer`, { operationId: e.id })).body.error.code).toBe('NOT_A_TRANSFER');
    expect((await api.get((await api.newUser()).token, `/goals/${g.id}`)).status).toBe(404);
  });
});
