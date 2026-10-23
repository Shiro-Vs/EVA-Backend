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

async function world(startDate: string, nextPaymentDate: string) {
  at(startDate);
  const u = await api.newUser();
  const bcp = await createAccount(api, u.token, 'BCP', '200.00', 'bank', startDate);
  const svc = await createService(api, u.token, { startDate, nextPaymentDate });
  return { u, bcp, svc };
}
async function addSeat(w: { u: { token: string }; svc: { id: string } }, name: string, quota = '20.00') {
  const c = await createContact(api, w.u.token, name);
  const s = await joinSeat(api, w.u.token, w.svc.id, c.id, { quota });
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  return { contact: c, seat: s.body as any };
}

describe('A13 · de compartido a individual (RN-X08)', () => {
  it('efectivo en el siguiente corte; Ana pasa su deuda a un préstamo y se programa la devolución de 40.00 de Beto', async () => {
    const w = await world('2026-03-04', '2026-04-04');
    const ana = await addSeat(w, 'Ana');
    const beto = await addSeat(w, 'Beto');
    await api.post(w.u.token, `/subscriptions/${w.svc.id}/cycles/generate`, { ahead: 2 });
    const betoCharges = await chargesOf(w.u.token, beto.seat.id);
    expect(betoCharges).toHaveLength(3);
    await pay(w.u.token, { contactId: beto.contact.id, accountId: w.bcp.id, amount: '60.00', allocations: betoCharges.map((c) => ({ obligationId: c.obligationId, amount: '20.00' })) });

    at('2026-03-15'); // se pide el día 15; el corte es el 4
    const pv = await api.post(w.u.token, `/subscriptions/${w.svc.id}/switch-to-individual/preview`, {});
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body).toMatchObject({ requestedOn: '2026-03-15', effectiveOn: '2026-04-04', modeAfter: 'personal', totals: { voidedCharges: 4, refunds: '40.00', loan: '20.00' } });
    expect(pv.body.seats).toHaveLength(2);

    const r = await api.post(w.u.token, `/subscriptions/${w.svc.id}/switch-to-individual`, { reason: 'Ya no lo comparto', previewToken: pv.body.previewToken });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.subscription).toMatchObject({ mode: 'personal', capacity: 1 });
    expect(r.body.refundIds).toHaveLength(1);
    expect(r.body.loanIds).toHaveLength(1);

    // Hasta el corte siguen ahí, pero nadie más puede entrar.
    expect((await api.get(w.u.token, `/subscriptions/${w.svc.id}/seats`)).body.items.filter((s: any) => !s.isOwner)).toHaveLength(2);
    const other = await createContact(api, w.u.token, 'Carla');
    expect((await joinSeat(api, w.u.token, w.svc.id, other.id, { quota: '10.00' })).body.error.code).toBe('SUBSCRIPTION_PERSONAL');

    const loan = (await api.get(w.u.token, `/loans?contactId=${ana.contact.id}`)).body.items[0];
    expect(loan).toMatchObject({ principal: '20.00', conversion: { trigger: 'individual_switch' } });
    expect((await api.get(w.u.token, `/contacts/${ana.contact.id}/statement`)).body.totals.pending).toBe('20.00');
    const refunds = (await api.get(w.u.token, '/refunds?status=planned')).body.items;
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ amount: '40.00', contact: { name: 'Beto' } });
    expect((await api.get(w.u.token, `/seats/${beto.seat.id}`)).body.voidedCharges).toHaveLength(2); // el historial se conserva

    at('2026-04-05');
    expect((await api.get(w.u.token, `/subscriptions/${w.svc.id}/seats`)).body.items.filter((s: any) => !s.isOwner)).toHaveLength(0);
    expect((await api.post(w.u.token, `/subscriptions/${w.svc.id}/switch-to-individual/preview`, {})).body.error.code).toBe('SUBSCRIPTION_PERSONAL');
    // Se registran por separado: solicitud (audit), efectividad (fecha de la plaza) y devolución real (cuando se pague).
    const ev = await pool.query(`select changes from audit_event where owner_id = $1 and action = 'subscription.switch_individual'`, [w.u.id]);
    expect(ev.rows[0].changes).toMatchObject({ requestedOn: '2026-03-15', effectiveOn: '2026-04-04' });
  });

  it('sin plazas de terceros solo cambia el modo', async () => {
    const w = await world('2026-03-04', '2026-04-04');
    const pv = await api.post(w.u.token, `/subscriptions/${w.svc.id}/switch-to-individual/preview`, {});
    expect(pv.body.seats).toEqual([]);
    const r = await api.post(w.u.token, `/subscriptions/${w.svc.id}/switch-to-individual`, { reason: 'x', previewToken: pv.body.previewToken });
    expect(r.status).toBe(200);
    expect(r.body.subscription.mode).toBe('personal');
  });
});

describe('A16 · regalo permanente a quien ya debe (RN-K01/K02/K04)', () => {
  async function debtor() {
    const w = await world('2026-03-04', '2026-04-04');
    const beto = await addSeat(w, 'Beto');
    at('2026-04-10');
    const charges = await chargesOf(w.u.token, beto.seat.id);
    await pay(w.u.token, { contactId: beto.contact.id, accountId: w.bcp.id, amount: '20.00', allocations: [{ obligationId: byStart(charges, '2026-04-04').obligationId, amount: '20.00' }] });
    return { ...w, beto };
  }

  it('obliga a elegir qué hacer con la deuda anterior', async () => {
    const w = await debtor();
    const body = { kind: 'permanent', reason: 'Regalo' };
    const pv = await api.post(w.u.token, `/seats/${w.beto.seat.id}/courtesies/preview`, body);
    expect(pv.body).toMatchObject({ existingDebt: '20.00', debtChoiceRequired: true, debtOptions: ['keep', 'convert'] });
    const r = await api.post(w.u.token, `/seats/${w.beto.seat.id}/courtesies`, body);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('DEBT_HANDLING_REQUIRED');
    expect(r.body.error.details).toMatchObject({ existingDebt: '20.00' });
  });

  it('mantener: la deuda de 20.00 queda intacta y los cargos nuevos salen en 0.00 con exención = bruto', async () => {
    const w = await debtor();
    const r = await api.post(w.u.token, `/seats/${w.beto.seat.id}/courtesies`, { kind: 'permanent', reason: 'Regalo', debtHandling: 'keep' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ debtHandling: 'keep', loanId: null });
    at('2026-05-05');
    const charges = await chargesOf(w.u.token, w.beto.seat.id);
    expect(byStart(charges, '2026-03-04')).toMatchObject({ pending: '20.00', paymentStatus: 'unpaid' });
    expect(byStart(charges, '2026-05-04')).toMatchObject({ gross: '20.00', exemption: '20.00', net: '0.00', mode: 'courtesy', paymentStatus: 'exempt' });
    expect((await api.get(w.u.token, `/contacts/${w.beto.contact.id}/statement`)).body.totals.pending).toBe('20.00');
  });

  it('convertir: nace un préstamo de 20.00 y la deuda del servicio queda en 0.00, sin condonar nada', async () => {
    const w = await debtor();
    const ops = async () => (await pool.query(`select count(*)::int as n from financial_operation where owner_id = $1`, [w.u.id])).rows[0].n;
    const before = await ops();
    const r = await api.post(w.u.token, `/seats/${w.beto.seat.id}/courtesies`, { kind: 'permanent', reason: 'Regalo', debtHandling: 'convert' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.loanId).toBeTruthy();
    const loan = (await api.get(w.u.token, `/loans/${r.body.loanId}`)).body;
    expect(loan).toMatchObject({ principal: '20.00', pending: '20.00', conversion: { trigger: 'courtesy_choice' } });
    expect(byStart(await chargesOf(w.u.token, w.beto.seat.id), '2026-03-04')).toMatchObject({ pending: '0.00', converted: '20.00', paymentStatus: 'converted' });
    expect((await api.get(w.u.token, `/contacts/${w.beto.contact.id}/statement`)).body.totals.pending).toBe('20.00'); // sigue debiendo lo mismo
    expect(await ops()).toBe(before); // sin ingreso ni egreso ficticio
  });
});

describe('Conversión manual de deuda en préstamo (RN-X07)', () => {
  it('convierte dos cargos pendientes en un préstamo; no cambia la deuda total y no se repite', async () => {
    const w = await world('2026-03-04', '2026-04-04');
    const ana = await addSeat(w, 'Ana');
    at('2026-04-05');
    const charges = await chargesOf(w.u.token, ana.seat.id);
    const ids = charges.map((c) => c.obligationId);
    const pv = await api.post(w.u.token, `/contacts/${ana.contact.id}/debt-conversion/preview`, { obligationIds: ids });
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body).toMatchObject({ total: '40.00', totalDebtBefore: '40.00', totalDebtAfter: '40.00' });
    expect(pv.body.components).toHaveLength(2);

    const r = await api.post(w.u.token, `/contacts/${ana.contact.id}/debt-conversion`, { obligationIds: ids, reason: 'Acordamos pagarlo en cuotas', previewToken: pv.body.previewToken });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ principal: '40.00', conversion: { trigger: 'manual' } });
    expect((await api.get(w.u.token, `/contacts/${ana.contact.id}/statement`)).body.totals.pending).toBe('40.00');

    const again = await api.post(w.u.token, `/contacts/${ana.contact.id}/debt-conversion/preview`, { obligationIds: ids });
    expect(again.body.error.code).toBe('NOTHING_TO_CONVERT');
    const comp = await api.post(w.u.token, `/contacts/${ana.contact.id}/debt-conversion/preview`, { obligationIds: [r.body.components[0].obligationId] });
    expect(comp.body.error.code).toBe('NOT_CONVERTIBLE');
  });

  it('la vista previa caduca si cambió lo pendiente, y no se mezcla con otro contacto ni con otro usuario', async () => {
    const w = await world('2026-03-04', '2026-04-04');
    const ana = await addSeat(w, 'Ana');
    const beto = await addSeat(w, 'Beto');
    at('2026-04-05');
    const anaIds = (await chargesOf(w.u.token, ana.seat.id)).map((c) => c.obligationId);
    const pv = await api.post(w.u.token, `/contacts/${ana.contact.id}/debt-conversion/preview`, { obligationIds: anaIds });
    await pay(w.u.token, { contactId: ana.contact.id, accountId: w.bcp.id, amount: '5.00', allocations: [{ obligationId: anaIds[anaIds.length - 1], amount: '5.00' }] });
    const stale = await api.post(w.u.token, `/contacts/${ana.contact.id}/debt-conversion`, { obligationIds: anaIds, reason: 'x', previewToken: pv.body.previewToken });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('PREVIEW_STALE');

    const betoIds = (await chargesOf(w.u.token, beto.seat.id)).map((c) => c.obligationId);
    expect((await api.post(w.u.token, `/contacts/${ana.contact.id}/debt-conversion/preview`, { obligationIds: betoIds })).body.error.code).toBe('OBLIGATION_CONTACT_MISMATCH');
    const stranger = await api.newUser();
    expect((await api.post(stranger.token, `/contacts/${ana.contact.id}/debt-conversion/preview`, { obligationIds: anaIds })).status).toBe(404);
  });
});
