import { afterAll, describe, expect, it } from 'vitest';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount } from '../helpers/scenarios.js';

const api = makeApi();
afterAll(async () => { await api.app.close(); await pool.end(); });
const at = (iso: string) => api.setNow(new Date(`${iso}T17:00:00Z`));
const balance = async (token: string, id: string) => (await api.get(token, `/accounts/${id}`)).body.balance as string;

async function world() {
  at('2026-10-12');
  const u = await api.newUser();
  const bcp = await createAccount(api, u.token, 'BCP', '3000.00', 'bank', '2026-01-01');
  const tree = (await api.get(u.token, '/categories')).body.items as any[];
  return { u, bcp, cat: (n: string) => tree.find((c) => c.name === n) };
}
type W = Awaited<ReturnType<typeof world>>;
const tpl = async (w: W, over: Record<string, unknown> = {}) => {
  const r = await api.post(w.u.token, '/recurring/templates', {
    name: 'Alquiler', kind: 'expense', accountId: w.bcp.id, amount: '800.00', categoryId: w.cat('Hogar').id, interval: { unit: 'month', count: 1 }, startDate: '2026-10-01', ...over,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
const pending = async (w: W, within = 30) => (await api.get(w.u.token, `/recurring/pending?within=${within}`)).body;

describe('Recurrencias: proponen, no registran (RN-RE01…RE03)', () => {
  it('una plantilla genera la ocurrencia vencida y la próxima, pero NO mueve ninguna cuenta', async () => {
    const w = await world();
    const t = await tpl(w);
    expect(t).toMatchObject({ name: 'Alquiler', status: 'active', nextDue: '2026-11-01' });
    const p = await pending(w);
    expect(p.due.map((o: any) => [o.dueDate, o.amount, o.status])).toEqual([['2026-10-01', '800.00', 'pending']]);
    expect(p.upcoming.map((u: any) => [u.name, u.dueDate])).toEqual([['Alquiler', '2026-11-01']]);
    expect(await balance(w.u.token, w.bcp.id)).toBe('3000.00'); // sin confirmación, las cuentas no cambian
    expect((await pending(w)).due).toHaveLength(1); // generar de nuevo es idempotente
    expect((await api.get(w.u.token, '/summary')).body.recurring).toEqual({ pending: 1 });
  });

  it('confirmar registra el movimiento real; no se decide dos veces', async () => {
    const w = await world();
    await tpl(w);
    const occ = (await pending(w)).due[0];
    const c = await api.post(w.u.token, `/recurring/occurrences/${occ.id}/confirm`, {});
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.operation).toMatchObject({ kind: 'expense', description: 'Alquiler', occurredOn: '2026-10-01' });
    expect(c.body.operation.category.name).toBe('Hogar');
    expect(c.body.occurrence).toMatchObject({ status: 'confirmed', operationId: c.body.operation.id });
    expect(await balance(w.u.token, w.bcp.id)).toBe('2200.00');
    expect((await api.post(w.u.token, `/recurring/occurrences/${occ.id}/confirm`, {})).body.error.code).toBe('OCCURRENCE_DECIDED');
    expect((await pending(w)).due).toHaveLength(0);
  });

  it('cada mes aparece su ocurrencia; se puede omitir, reabrir y confirmar con importe o cuenta corregidos', async () => {
    const w = await world();
    const t = await tpl(w);
    at('2026-11-02');
    const [occ] = (await pending(w)).due;
    expect(occ.dueDate).toBe('2026-10-01'); // la de octubre sigue sin decidir
    expect((await pending(w)).due.map((o: any) => o.dueDate)).toEqual(['2026-10-01', '2026-11-01']);
    const nov = (await pending(w)).due[1];
    const sk = await api.post(w.u.token, `/recurring/occurrences/${nov.id}/skip`, { note: 'Este mes no pagué' });
    expect(sk.body).toMatchObject({ status: 'skipped', note: 'Este mes no pagué' });
    expect(await balance(w.u.token, w.bcp.id)).toBe('3000.00');
    expect((await api.post(w.u.token, `/recurring/occurrences/${nov.id}/reopen`, {})).body.status).toBe('pending');
    const other = await createAccount(api, w.u.token, 'Efectivo', '2000.00', 'cash', '2026-01-01');
    const c = await api.post(w.u.token, `/recurring/occurrences/${nov.id}/confirm`, { amount: '850.00', accountId: other.id, date: '2026-11-02' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(await balance(w.u.token, other.id)).toBe('1150.00');
    expect(await balance(w.u.token, w.bcp.id)).toBe('3000.00');
    expect((await api.get(w.u.token, `/recurring/templates/${t.id}`)).body.occurrences.map((o: any) => [o.dueDate, o.status])).toEqual([['2026-11-01', 'confirmed'], ['2026-10-01', 'pending']]);
    expect((await api.post(w.u.token, `/recurring/occurrences/${nov.id}/reopen`, {})).body.error.code).toBe('OCCURRENCE_NOT_REOPENABLE');
  });

  it('el día del mes se conserva (31 → 28 → 31) y un ingreso recurrente confirma como ingreso', async () => {
    const w = await world();
    at('2026-03-31');
    await tpl(w, { name: 'Sueldo', kind: 'income', amount: '2500.00', startDate: '2026-01-31', categoryId: null });
    expect((await pending(w, 0)).due.map((o: any) => o.dueDate)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    const o = (await pending(w, 0)).due[2];
    const c = await api.post(w.u.token, `/recurring/occurrences/${o.id}/confirm`, {});
    expect(c.body.operation).toMatchObject({ kind: 'income', occurredOn: '2026-03-31' });
    expect(await balance(w.u.token, w.bcp.id)).toBe('5500.00');
  });

  it('pausar no propone nada y reanudar no inunda con lo ocurrido durante la pausa', async () => {
    const w = await world();
    const t = await tpl(w, { startDate: '2026-10-12', interval: { unit: 'week', count: 1 } });
    expect((await pending(w, 0)).due).toHaveLength(1);
    expect((await api.post(w.u.token, `/recurring/templates/${t.id}/pause`, {})).body.status).toBe('paused');
    at('2026-11-30'); // siete semanas después
    expect((await pending(w, 0)).due).toHaveLength(1); // nada nuevo mientras está en pausa
    const r = await api.post(w.u.token, `/recurring/templates/${t.id}/resume`, {});
    expect(r.body.status).toBe('active');
    const due = (await pending(w, 0)).due.map((o: any) => o.dueDate);
    expect(due[0]).toBe('2026-10-12');
    expect(due.slice(1)).toEqual(['2026-11-30']); // retoma desde hoy
    expect((await api.get(w.u.token, '/recurring/templates?status=paused')).body.items).toHaveLength(0);
  });

  it('una fecha final detiene las propuestas', async () => {
    const w = await world();
    await tpl(w, { startDate: '2026-08-01', endDate: '2026-09-15' });
    expect((await pending(w, 60)).due.map((o: any) => o.dueDate)).toEqual(['2026-08-01', '2026-09-01']);
    expect((await pending(w, 60)).upcoming).toHaveLength(0);
    expect((await api.post(w.u.token, '/recurring/templates', { name: 'x', kind: 'expense', accountId: w.bcp.id, amount: '1.00', interval: { unit: 'month', count: 1 }, startDate: '2026-10-01', endDate: '2026-09-01' })).body.error.code).toBe('RECURRING_DATES');
  });

  it('cambiar el calendario vuelve a proponer solo lo pendiente y conserva lo ya decidido', async () => {
    const w = await world();
    const t = await tpl(w, { startDate: '2026-09-01' });
    const [sep] = (await pending(w, 0)).due;
    await api.post(w.u.token, `/recurring/occurrences/${sep.id}/confirm`, {}); // septiembre confirmado
    const ed = await api.patch(w.u.token, `/recurring/templates/${t.id}`, { amount: '900.00', startDate: '2026-10-05' }, t.version);
    expect(ed.status, JSON.stringify(ed.body)).toBe(200);
    expect(ed.body.amount).toBe('900.00');
    const dues = (await pending(w, 0)).due;
    expect(dues.map((o: any) => [o.dueDate, o.amount])).toEqual([['2026-10-05', '900.00']]);
    expect((await api.get(w.u.token, `/recurring/templates/${t.id}`)).body.occurrences.map((o: any) => o.status).sort()).toEqual(['confirmed', 'pending']);
    expect((await api.patch(w.u.token, `/recurring/templates/${t.id}`, { name: 'otra' }, t.version)).body.error.code).toBe('CONFLICT_VERSION');
  });
});

describe('Movimientos que ya existen (RN-RE04)', () => {
  it('vincular cumple la ocurrencia sin crear otro movimiento; informa diferencias; un movimiento solo cumple una', async () => {
    const w = await world();
    await tpl(w);
    const op = (await api.post(w.u.token, '/operations', { kind: 'expense', accountId: w.bcp.id, amount: '780.00', date: '2026-10-03', description: 'Pago del alquiler (recibo)' })).body;
    const before = (await pool.query(`select count(*)::int as n from financial_operation where owner_id = $1`, [w.u.id])).rows[0].n;
    const occ = (await pending(w)).due[0];
    const l = await api.post(w.u.token, `/recurring/occurrences/${occ.id}/link`, { operationId: op.id });
    expect(l.status, JSON.stringify(l.body)).toBe(200);
    expect(l.body).toMatchObject({ warnings: ['AMOUNT_DIFFERS', 'DATE_DIFFERS'], expectedAmount: '800.00', actualAmount: '780.00', expectedDate: '2026-10-01', actualDate: '2026-10-03' });
    expect(l.body.occurrence).toMatchObject({ status: 'confirmed', operationId: op.id });
    expect((await pool.query(`select count(*)::int as n from financial_operation where owner_id = $1`, [w.u.id])).rows[0].n).toBe(before); // no se creó ningún movimiento
    expect(await balance(w.u.token, w.bcp.id)).toBe('2220.00');

    at('2026-11-02');
    const nov = (await pending(w)).due[0];
    expect((await api.post(w.u.token, `/recurring/occurrences/${nov.id}/link`, { operationId: op.id })).body.error.code).toBe('OPERATION_ALREADY_LINKED');
    const income = (await api.post(w.u.token, '/operations', { kind: 'income', accountId: w.bcp.id, amount: '800.00', date: '2026-11-01' })).body;
    expect((await api.post(w.u.token, `/recurring/occurrences/${nov.id}/link`, { operationId: income.id })).body.error.code).toBe('OPERATION_MISMATCH');
  });

  it('si se revierte el movimiento, la ocurrencia se puede reabrir', async () => {
    const w = await world();
    await tpl(w);
    const occ = (await pending(w)).due[0];
    const c = await api.post(w.u.token, `/recurring/occurrences/${occ.id}/confirm`, {});
    expect((await api.post(w.u.token, `/recurring/occurrences/${occ.id}/reopen`, {})).body.error.code).toBe('OCCURRENCE_NOT_REOPENABLE'); // el movimiento sigue vigente
    await api.post(w.u.token, `/operations/${c.body.operation.id}/reverse`, { reason: 'Error' });
    const r = await api.post(w.u.token, `/recurring/occurrences/${occ.id}/reopen`, {});
    expect(r.body).toMatchObject({ status: 'pending', operationId: null });
    expect(await balance(w.u.token, w.bcp.id)).toBe('3000.00');
  });

  it('validaciones: una tarjeta no recibe ingresos, privacidad', async () => {
    const w = await world();
    const card = await createAccount(api, w.u.token, 'Tarjeta', '-10.00', 'credit', '2026-01-01');
    expect((await api.post(w.u.token, '/recurring/templates', { name: 'x', kind: 'income', accountId: card.id, amount: '10.00', interval: { unit: 'month', count: 1 }, startDate: '2026-10-01' })).body.error.code).toBe('VALIDATION_ERROR');
    const t = await tpl(w);
    expect((await api.get((await api.newUser()).token, `/recurring/templates/${t.id}`)).status).toBe(404);
  });
});
