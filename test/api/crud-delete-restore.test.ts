import { afterAll, describe, expect, it } from 'vitest';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount, createContact, createService, joinSeat } from '../helpers/scenarios.js';

const api = makeApi();
afterAll(async () => { await api.app.close(); await pool.end(); });
const at = (iso: string) => api.setNow(new Date(`${iso}T17:00:00Z`));

describe('CRUD completo: eliminar con validaciones y restaurar', () => {
  it('Servicios: elimina limpio sin historial; bloquea con SUBSCRIPTION_IN_USE si tiene pagos o participantes; archiva y restaura', async () => {
    at('2026-10-10');
    const u = await api.newUser();
    const acc = await createAccount(api, u.token, 'BCP', '200.00');
    const emptySvc = await createService(api, u.token, { name: 'Servicio Erróneo' });
    const delOk = await api.post(u.token, `/subscriptions/${emptySvc.id}/delete`, {});
    expect(delOk.status, JSON.stringify(delOk.body)).toBe(200);
    expect(delOk.body).toEqual({ id: emptySvc.id, deleted: true });
    expect((await api.get(u.token, `/subscriptions/${emptySvc.id}`)).status).toBe(404);

    // Servicio con participante no se puede eliminar ni archivar; tras baja se puede archivar y restaurar.
    const used = await createService(api, u.token, { name: 'Netflix' });
    const ana = await createContact(api, u.token, 'Ana');
    await joinSeat(api, u.token, used.id, ana.id, { quota: '15.00' });
    const delUsed = await api.post(u.token, `/subscriptions/${used.id}/delete`, {});
    expect(delUsed.status).toBe(409);
    expect(delUsed.body.error.code).toBe('SUBSCRIPTION_IN_USE');

    // Servicio personal con pago al proveedor: no se borra, sí se archiva y restaura, y archivado no acepta pago al proveedor.
    const personal = await createService(api, u.token, { name: 'Spotify', mode: 'personal', capacity: 1 });
    const detail = (await api.get(u.token, `/subscriptions/${personal.id}`)).body;
    const pay = await api.post(u.token, `/billing-cycles/${detail.currentCycle.id}/supplier-payment`, { accountId: acc.id, amount: '20.00' });
    expect(pay.status).toBe(201);
    expect((await api.post(u.token, `/subscriptions/${personal.id}/delete`, {})).body.error.code).toBe('SUBSCRIPTION_IN_USE');

    const arch = await api.post(u.token, `/subscriptions/${personal.id}/archive`, {});
    expect(arch.status).toBe(200);
    expect(arch.body.status).toBe('archived');
    expect((await api.post(u.token, `/billing-cycles/${detail.nextCycle.id}/supplier-payment`, { accountId: acc.id, amount: '20.00' })).body.error.code).toBe('SUBSCRIPTION_ARCHIVED');

    const rest = await api.post(u.token, `/subscriptions/${personal.id}/restore`, {});
    expect(rest.status).toBe(200);
    expect(rest.body.status).toBe('active');
  });

  it('Cuentas y Contactos: eliminan sin historial, bloquean en uso, archivan y restauran', async () => {
    at('2026-10-10');
    const u = await api.newUser();
    const emptyAcc = await createAccount(api, u.token, 'Vacía', '0.00');
    expect((await api.post(u.token, `/accounts/${emptyAcc.id}/delete`, {})).body).toEqual({ id: emptyAcc.id, deleted: true });
    expect((await api.get(u.token, `/accounts/${emptyAcc.id}`)).status).toBe(404);

    const usedAcc = await createAccount(api, u.token, 'Con saldo', '50.00');
    expect((await api.post(u.token, `/accounts/${usedAcc.id}/delete`, {})).body.error.code).toBe('ACCOUNT_IN_USE');
    const archAcc = await api.post(u.token, `/accounts/${usedAcc.id}/archive`, {});
    expect(archAcc.body.account.status).toBe('archived');
    expect((await api.patch(u.token, `/accounts/${usedAcc.id}`, { name: 'Editada' }, archAcc.body.account.version)).body.error.code).toBe('ACCOUNT_ARCHIVED');
    const restAcc = await api.post(u.token, `/accounts/${usedAcc.id}/restore`, {});
    expect(restAcc.body.status).toBe('active');

    const emptyContact = await createContact(api, u.token, 'Temporal');
    expect((await api.post(u.token, `/contacts/${emptyContact.id}/delete`, {})).body).toEqual({ id: emptyContact.id, deleted: true });
    expect((await api.get(u.token, `/contacts/${emptyContact.id}`)).status).toBe(404);

    const usedContact = await createContact(api, u.token, 'Beto');
    await api.post(u.token, '/operations', { kind: 'expense', accountId: usedAcc.id, amount: '10.00', date: '2026-10-10', contactId: usedContact.id });
    expect((await api.post(u.token, `/contacts/${usedContact.id}/delete`, {})).body.error.code).toBe('CONTACT_IN_USE');
    expect((await api.post(u.token, `/contacts/${usedContact.id}/archive`, {})).body.contact.status).toBe('archived');
    expect((await api.post(u.token, `/contacts/${usedContact.id}/restore`, {})).body.status).toBe('active');
  });

  it('Préstamos bancarios, Metas y Presupuestos: eliminan según historial', async () => {
    at('2026-10-10');
    const u = await api.newUser();
    const acc = await createAccount(api, u.token, 'BCP', '500.00');

    // Préstamo bancario vacío se elimina; con pago se bloquea.
    const bl = (await api.post(u.token, '/bank-loans', { name: 'Borrador' })).body;
    expect((await api.post(u.token, `/bank-loans/${bl.id}/delete`, {})).body).toEqual({ id: bl.id, deleted: true });

    const bl2 = (await api.post(u.token, '/bank-loans', { name: 'Auto' })).body;
    const pv = (await api.post(u.token, `/bank-loans/${bl2.id}/payments/preview`, { accountId: acc.id, amount: '50.00', paidOn: '2026-10-10' })).body;
    expect((await api.post(u.token, `/bank-loans/${bl2.id}/payments`, { accountId: acc.id, amount: '50.00', paidOn: '2026-10-10', previewToken: pv.previewToken })).status).toBe(201);
    expect((await api.post(u.token, `/bank-loans/${bl2.id}/delete`, {})).body.error.code).toBe('BANK_LOAN_IN_USE');

    // Meta sin reservas se elimina; con reservas se bloquea.
    const g1 = (await api.post(u.token, '/goals', { name: 'Error', targetAmount: '100.00' })).body;
    expect((await api.post(u.token, `/goals/${g1.id}/delete`, {})).body).toEqual({ id: g1.id, deleted: true });
    const g2 = (await api.post(u.token, '/goals', { name: 'Viaje', targetAmount: '100.00' })).body;
    await api.post(u.token, `/goals/${g2.id}/reserve`, { accountId: acc.id, amount: '20.00' });
    expect((await api.post(u.token, `/goals/${g2.id}/delete`, {})).body.error.code).toBe('GOAL_IN_USE');

    // Presupuesto se elimina directamente.
    const b = (await api.post(u.token, '/budgets', { name: 'Prueba', period: 'monthly', limit: '300.00' })).body;
    expect((await api.post(u.token, `/budgets/${b.id}/delete`, {})).body).toEqual({ id: b.id, deleted: true });
    expect((await api.get(u.token, `/budgets/${b.id}`)).status).toBe(404);
  });
});
