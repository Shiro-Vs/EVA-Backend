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

    // Vista previa y borrado forzado con conversión de deudas pendientes a préstamo.
    const prev = await api.post(u.token, `/subscriptions/${used.id}/delete/preview`, {});
    expect(prev.status).toBe(200);
    expect(prev.body.isEmpty).toBe(false);
    expect(prev.body.impact.participants).toBe(1);
    expect(prev.body.pendingDebts).toHaveLength(1);
    expect(prev.body.pendingDebts[0].contactName).toBe('Ana');
    expect(Number(prev.body.totalPendingDebt)).toBeGreaterThan(0);
    const expectedDebt = prev.body.totalPendingDebt;

    // Sin indicar qué hacer con la deuda pendiente, force falla con UNPAID_HANDLING_REQUIRED.
    const missingOpt = await api.post(u.token, `/subscriptions/${used.id}/delete`, { force: true });
    expect(missingOpt.status).toBe(422);
    expect(missingOpt.body.error.code).toBe('UNPAID_HANDLING_REQUIRED');

    // Con convert_to_loan: borra el servicio y crea el préstamo por la deuda pendiente.
    const forceConv = await api.post(u.token, `/subscriptions/${used.id}/delete`, { force: true, unpaidHandling: 'convert_to_loan' });
    expect(forceConv.status, JSON.stringify(forceConv.body)).toBe(200);
    expect(forceConv.body.deleted).toBe(true);
    expect(forceConv.body.convertedLoans).toHaveLength(1);
    expect(forceConv.body.convertedLoans[0].principal).toBe(expectedDebt);
    expect((await api.get(u.token, `/subscriptions/${used.id}`)).status).toBe(404);
    const anaLoans = await api.get(u.token, `/loans?contactId=${ana.id}`);
    expect(anaLoans.status).toBe(200);
    expect(anaLoans.body.items).toHaveLength(1);
    expect(anaLoans.body.items[0].pending).toBe(expectedDebt);

    // Con discard: borra el servicio y descarta la deuda pendiente sin crear préstamo.
    const used2 = await createService(api, u.token, { name: 'Disney+' });
    const luis = await createContact(api, u.token, 'Luis');
    await joinSeat(api, u.token, used2.id, luis.id, { quota: '12.00' });
    const forceDiscard = await api.post(u.token, `/subscriptions/${used2.id}/delete`, { force: true, unpaidHandling: 'discard' });
    expect(forceDiscard.status, JSON.stringify(forceDiscard.body)).toBe(200);
    expect(forceDiscard.body).toEqual({ id: used2.id, deleted: true });
    expect((await api.get(u.token, `/subscriptions/${used2.id}`)).status).toBe(404);
    expect((await api.get(u.token, `/loans?contactId=${luis.id}`)).body.items).toHaveLength(0);

    // Borrado forzado en servicio personal con pago al proveedor: mantiene el saldo de la cuenta intacto.
    const accBefore = (await api.get(u.token, `/accounts/${acc.id}`)).body.balance;
    const forcePersonal = await api.post(u.token, `/subscriptions/${personal.id}/delete`, { force: true });
    expect(forcePersonal.status, JSON.stringify(forcePersonal.body)).toBe(200);
    expect((await api.get(u.token, `/subscriptions/${personal.id}`)).status).toBe(404);
    expect((await api.get(u.token, `/accounts/${acc.id}`)).body.balance).toBe(accBefore);
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

    // Vista previa y borrado forzado de cuenta con movimientos: desaparece de /accounts pero los movimientos muestran accountDeleted=true.
    const expense = (await api.post(u.token, '/operations', { kind: 'expense', accountId: usedAcc.id, amount: '15.00', date: '2026-10-10', description: 'Café' })).body;
    const accPrev = await api.post(u.token, `/accounts/${usedAcc.id}/delete/preview`, {});
    expect(accPrev.status).toBe(200);
    expect(accPrev.body.isEmpty).toBe(false);
    expect(accPrev.body.usage.movimientos).toBe(2);
    const forceAcc = await api.post(u.token, `/accounts/${usedAcc.id}/delete`, { force: true });
    expect(forceAcc.status, JSON.stringify(forceAcc.body)).toBe(200);
    expect(forceAcc.body).toEqual({ id: usedAcc.id, deleted: true });
    expect((await api.get(u.token, `/accounts/${usedAcc.id}`)).status).toBe(404);
    expect((await api.get(u.token, '/accounts')).body.items).toEqual([]);
    const opAfter = (await api.get(u.token, `/operations/${expense.id}`)).body;
    expect(opAfter.entries[0]).toMatchObject({ accountId: usedAcc.id, accountName: 'Con saldo', accountDeleted: true });
    const listAfter = (await api.get(u.token, '/operations?kind=expense')).body.items;
    expect(listAfter[0]).toMatchObject({ accountName: 'Con saldo', accountDeleted: true });

    const activeAcc = await createAccount(api, u.token, 'Activa', '50.00');
    const emptyContact = await createContact(api, u.token, 'Temporal');
    expect((await api.post(u.token, `/contacts/${emptyContact.id}/delete`, {})).body).toEqual({ id: emptyContact.id, deleted: true });
    expect((await api.get(u.token, `/contacts/${emptyContact.id}`)).status).toBe(404);

    const usedContact = await createContact(api, u.token, 'Beto');
    await api.post(u.token, '/operations', { kind: 'expense', accountId: activeAcc.id, amount: '10.00', date: '2026-10-10', contactId: usedContact.id });
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
