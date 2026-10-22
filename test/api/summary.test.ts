import { afterAll, describe, expect, it } from 'vitest';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount, createContact, createService, joinSeat } from '../helpers/scenarios.js';

const api = makeApi();
afterAll(async () => { await api.app.close(); await pool.end(); });
const at = (iso: string) => api.setNow(new Date(`${iso}T17:00:00Z`));

describe('GET /summary (inicio y cabeceras)', () => {
  it('un usuario nuevo ve todo en cero', async () => {
    at('2026-10-12');
    const u = await api.newUser();
    const s = (await api.get(u.token, '/summary')).body;
    expect(s).toMatchObject({
      asOf: '2026-10-12', balance: { net: '0.00', accounts: 0 },
      receivable: { pending: '0.00', overdue: '0.00', debtors: 0, creditFree: '0.00', creditReserved: '0.00' },
      subscriptions: { active: 0, currentCycleTotal: '0.00' }, recent: [],
    });
  });

  it('saldo total (cuenta de crédito resta), por cobrar, compromisos y actividad reciente', async () => {
    at('2026-10-07');
    const u = await api.newUser();
    const bcp = await createAccount(api, u.token, 'BCP', '200.00');
    await api.post(u.token, '/accounts', { name: 'Efectivo', type: 'cash', openingBalance: { amount: '50.00', date: '2026-10-01' } });
    const card = (await api.post(u.token, '/accounts', { name: 'Tarjeta', type: 'credit', openingBalance: { amount: '-100.00', date: '2026-10-01' } })).body;
    const hidden = (await api.post(u.token, '/accounts', { name: 'Ahorros aparte', type: 'savings', excludeFromTotal: true, openingBalance: { amount: '999.00', date: '2026-10-01' } })).body;
    expect(hidden.excludeFromTotal).toBe(true);
    const svc = await createService(api, u.token);
    const ana = await createContact(api, u.token, 'Ana');
    const beto = await createContact(api, u.token, 'Beto');
    await joinSeat(api, u.token, svc.id, ana.id, { quota: '10.00' });
    await joinSeat(api, u.token, svc.id, beto.id, { label: 'Cuenta 2', quota: '8.00' });
    at('2026-10-12');
    await api.post(u.token, '/operations', { kind: 'expense', accountId: bcp.id, amount: '12.50', description: 'Almuerzo', date: '2026-10-11' });
    await api.post(u.token, '/operations', { kind: 'transfer', accountId: bcp.id, toAccountId: card.id, amount: '10.00', date: '2026-10-12' });

    const s = (await api.get(u.token, '/summary')).body;
    expect(s.balance).toEqual({ net: '137.50', accounts: 3 }); // BCP 177.50 + efectivo 50.00 + tarjeta −90.00; sin la cuenta excluida
    expect(s.receivable).toMatchObject({ pending: '18.00', overdue: '18.00', debtors: 2 });
    expect(s.subscriptions).toEqual({ active: 1, currentCycleTotal: '45.00' });
    expect(s.recent.map((r: any) => [r.kind, r.description, r.amount])).toEqual([
      ['transfer', '', '10.00'], ['transfer', '', '-10.00'], ['expense', 'Almuerzo', '-12.50'],
    ]);
    expect(s.recent.every((r: any) => r.kind !== 'opening')).toBe(true);
  });

  it('los datos de otro usuario no aparecen', async () => {
    at('2026-10-12');
    const a = await api.newUser();
    const b = await api.newUser();
    await createAccount(api, a.token, 'BCP', '500.00');
    expect((await api.get(b.token, '/summary')).body.balance.net).toBe('0.00');
  });
});
