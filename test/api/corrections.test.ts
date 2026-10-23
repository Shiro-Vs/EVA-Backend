import { afterAll, describe, expect, it } from 'vitest';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount, createContact, createService, joinSeat } from '../helpers/scenarios.js';

const api = makeApi();
afterAll(async () => { await api.app.close(); await pool.end(); });
const at = (iso: string) => api.setNow(new Date(`${iso}T17:00:00Z`));
const balance = async (token: string, id: string) => (await api.get(token, `/accounts/${id}`)).body.balance as string;

/** Ana debe 20.00 en Netflix y 10.00 en Spotify; BCP con 200.00 y Efectivo con 50.00. */
async function world() {
  at('2026-10-07');
  const u = await api.newUser();
  const bcp = await createAccount(api, u.token, 'BCP', '200.00');
  const cash = await createAccount(api, u.token, 'Efectivo', '50.00', 'cash');
  const netflix = await createService(api, u.token, { name: 'Netflix' });
  const spotify = await createService(api, u.token, { name: 'Spotify' });
  const ana = await createContact(api, u.token, 'Ana');
  const sn = await joinSeat(api, u.token, netflix.id, ana.id, { quota: '20.00' });
  const ss = await joinSeat(api, u.token, spotify.id, ana.id, { quota: '10.00' });
  expect(sn.status, JSON.stringify(sn.body)).toBe(201);
  expect(ss.status, JSON.stringify(ss.body)).toBe(201);
  at('2026-10-12');
  return { u, bcp, cash, netflix, spotify, ana, nCharge: sn.body.charges[0], sCharge: ss.body.charges[0] };
}
type W = Awaited<ReturnType<typeof world>>;

async function payThirty(w: W) {
  const body = { contactId: w.ana.id, accountId: w.bcp.id, amount: '30.00', allocations: [{ obligationId: w.nCharge.obligationId, amount: '20.00' }, { obligationId: w.sCharge.obligationId, amount: '10.00' }] };
  const pv = await api.post(w.u.token, '/receipts/preview', body);
  expect(pv.body.valid, JSON.stringify(pv.body)).toBe(true);
  const r = await api.post(w.u.token, '/receipts', { ...body, previewToken: pv.body.previewToken });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { receipt: { id: string; operationId: string; version: number } };
}
const pending = async (w: W, obligationId: string) => {
  const r = await pool.query(`select pending_amount::text as p from v_obligation_balance where obligation_id = $1`, [obligationId]);
  return r.rows[0].p as string;
};

describe('A24 · corregir un cobro aplicado a dos deudas (RN-V02/V04/V05)', () => {
  it('30.00 → 25.00: vista de efectos, el usuario elige 20 + 5, reversión + nueva operación y ninguna devolución', async () => {
    const w = await world();
    const old = await payThirty(w);
    expect(await balance(w.u.token, w.bcp.id)).toBe('230.00');

    // Si no se elige el reparto, el anterior (20 + 10) ya no cabe en 25.00: la vista previa lo señala.
    const bad = await api.post(w.u.token, `/receipts/${old.receipt.id}/correct/preview`, { amount: '25.00' });
    expect(bad.status, JSON.stringify(bad.body)).toBe(200);
    expect(bad.body.valid).toBe(false);
    expect(bad.body.issues[0].code).toBe('EXCEEDS_RECEIPT');
    expect(bad.body.previewToken).toBeUndefined();

    const fix = { amount: '25.00', allocations: [{ obligationId: w.nCharge.obligationId, amount: '20.00' }, { obligationId: w.sCharge.obligationId, amount: '5.00' }] };
    const pv = await api.post(w.u.token, `/receipts/${old.receipt.id}/correct/preview`, fix);
    expect(pv.body.valid, JSON.stringify(pv.body)).toBe(true);
    expect(pv.body.effects.accounts).toEqual([{ accountId: w.bcp.id, name: 'BCP', balanceBefore: '230.00', balanceAfter: '225.00', delta: '-5.00' }]);
    expect(pv.body.effects.releasedAllocations.map((a: any) => a.amount).sort()).toEqual(['10.00', '20.00']);
    expect(pv.body.effects.rebuiltAllocations.map((a: any) => [a.amount, a.pendingBefore, a.pendingAfter]).sort()).toEqual([['20.00', '20.00', '0.00'], ['5.00', '10.00', '5.00']]);
    expect(pv.body.willCreate).toEqual({ reversal: true, receipt: true });
    expect(await balance(w.u.token, w.bcp.id)).toBe('230.00'); // la vista previa no cambia nada

    const r = await api.post(w.u.token, `/receipts/${old.receipt.id}/correct`, { ...fix, reason: 'Anoté mal el importe', previewToken: pv.body.previewToken });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.receipt.amount).toBe('25.00');
    expect(r.body.replacedReceiptId).toBe(old.receipt.id);

    expect(await balance(w.u.token, w.bcp.id)).toBe('225.00');
    expect((await api.get(w.u.token, `/receipts/${old.receipt.id}`)).body.status).toBe('reversed');
    expect(await pending(w, w.nCharge.obligationId)).toBe('0.00');
    expect(await pending(w, w.sCharge.obligationId)).toBe('5.00');
    // Evidencia: la operación original queda revertida, existe la reversión y la nueva; ninguna devolución.
    const ops = await pool.query(`select kind, status from financial_operation where owner_id = $1 and kind in ('income','reversal') order by created_at`, [w.u.id]);
    expect(ops.rows.map((x: any) => `${x.kind}:${x.status}`)).toEqual(['income:reversed', 'reversal:confirmed', 'income:confirmed']);
    expect((await api.get(w.u.token, '/refunds')).body.items).toHaveLength(0);
    const ev = await pool.query(`select reason from audit_event where owner_id = $1 and action = 'receipt.correct'`, [w.u.id]);
    expect(ev.rows[0].reason).toBe('Anoté mal el importe');
    // El cobro nuevo ya no se puede corregir con el viejo y el viejo no se vuelve a corregir.
    expect((await api.post(w.u.token, `/receipts/${old.receipt.id}/correct/preview`, { amount: '24.00' })).body.error.code).toBe('ALREADY_REVERSED');
  });

  it('cambiar de cuenta y de fecha conserva el reparto y mueve los saldos', async () => {
    const w = await world();
    const old = await payThirty(w);
    const body = { accountId: w.cash.id, receivedOn: '2026-10-10' };
    const pv = await api.post(w.u.token, `/receipts/${old.receipt.id}/correct/preview`, body);
    expect(pv.body.valid, JSON.stringify(pv.body)).toBe(true);
    expect(pv.body.effects.accounts.map((a: any) => [a.name, a.delta]).sort()).toEqual([['BCP', '-30.00'], ['Efectivo', '30.00']]);
    expect((await api.post(w.u.token, `/receipts/${old.receipt.id}/correct`, { ...body, reason: 'Fue en efectivo', previewToken: pv.body.previewToken })).status).toBe(201);
    expect(await balance(w.u.token, w.bcp.id)).toBe('200.00');
    expect(await balance(w.u.token, w.cash.id)).toBe('80.00');
    expect(await pending(w, w.nCharge.obligationId)).toBe('0.00');
    expect(await pending(w, w.sCharge.obligationId)).toBe('0.00');
    expect((await api.post(w.u.token, `/receipts/${old.receipt.id}/correct/preview`, {})).body.error.code).toBe('ALREADY_REVERSED');
  });

  it('la vista previa caduca si el estado cambió, y no se corrige un cobro con devoluciones', async () => {
    const w = await world();
    const old = await payThirty(w);
    const fix = { amount: '25.00', allocations: [{ obligationId: w.nCharge.obligationId, amount: '20.00' }, { obligationId: w.sCharge.obligationId, amount: '5.00' }] };
    const pv = await api.post(w.u.token, `/receipts/${old.receipt.id}/correct/preview`, fix);
    // Confirmar un reparto distinto del que se vio se rechaza.
    const other = { ...fix, allocations: [{ obligationId: w.nCharge.obligationId, amount: '20.00' }, { obligationId: w.sCharge.obligationId, amount: '4.00' }] };
    const wrong = await api.post(w.u.token, `/receipts/${old.receipt.id}/correct`, { ...other, reason: 'x', previewToken: pv.body.previewToken });
    expect(wrong.body.error.code).toBe('PREVIEW_MISMATCH');
    // Si el cobro cambió entre la vista previa y la aplicación (aquí, su nota), la vista previa caduca.
    const rcp = (await api.get(w.u.token, `/receipts/${old.receipt.id}`)).body;
    expect((await api.patch(w.u.token, `/receipts/${old.receipt.id}`, { note: 'Yape' }, rcp.version)).status).toBe(200);
    const stale = await api.post(w.u.token, `/receipts/${old.receipt.id}/correct`, { ...fix, reason: 'x', previewToken: pv.body.previewToken });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('PREVIEW_STALE');

    const extra = { contactId: w.ana.id, accountId: w.bcp.id, amount: '1.00', allocations: [] as unknown[] };
    const epv = await api.post(w.u.token, '/receipts/preview', extra);
    await api.post(w.u.token, '/receipts', { ...extra, previewToken: epv.body.previewToken });

    // Con un crédito libre se puede programar una devolución; entonces ese cobro ya no se corrige.
    const credit = (await api.get(w.u.token, `/contacts/${w.ana.id}/credit`)).body;
    const rec = credit.receipts[0].receiptId;
    expect((await api.post(w.u.token, '/refunds', { receiptId: rec, amount: '1.00', reason: 'Sobrante' })).status).toBe(201);
    const blocked = await api.post(w.u.token, `/receipts/${rec}/correct/preview`, { amount: '2.00' });
    expect(blocked.body.error.code).toBe('RECEIPT_HAS_REFUNDS');
  });
});

describe('Revertir un cobro (RN-V05)', () => {
  it('anula el ingreso y las deudas vuelven a quedar pendientes; revertir no es devolver dinero', async () => {
    const w = await world();
    const old = await payThirty(w);
    const pv = await api.post(w.u.token, `/receipts/${old.receipt.id}/reverse/preview`, {});
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body.effects.accounts[0]).toMatchObject({ balanceBefore: '230.00', balanceAfter: '200.00', delta: '-30.00' });
    expect(pv.body.effects.obligationsAfter.map((o: any) => o.pendingAfter).sort()).toEqual(['10.00', '20.00']);
    const r = await api.post(w.u.token, `/receipts/${old.receipt.id}/reverse`, { reason: 'Se registró dos veces', previewToken: pv.body.previewToken });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'reversed' });
    expect(await balance(w.u.token, w.bcp.id)).toBe('200.00');
    expect(await pending(w, w.nCharge.obligationId)).toBe('20.00');
    expect((await api.get(w.u.token, `/contacts/${w.ana.id}/statement`)).body.totals.pending).toBe('30.00');
    expect((await api.get(w.u.token, '/refunds')).body.items).toHaveLength(0);
    expect((await api.post(w.u.token, `/receipts/${old.receipt.id}/reverse/preview`, {})).body.error.code).toBe('ALREADY_REVERSED');
  });
});

describe('Corregir una operación (RN-V02/V05) y campos sin efecto financiero (RN-V01)', () => {
  it('un gasto de 50.00 en BCP pasa a 40.00 en Efectivo: revierte y registra la nueva', async () => {
    const w = await world();
    const op = (await api.post(w.u.token, '/operations', { kind: 'expense', accountId: w.bcp.id, amount: '50.00', date: '2026-10-10', description: 'Mercado' })).body;
    expect(await balance(w.u.token, w.bcp.id)).toBe('150.00');
    const fix = { amount: '40.00', accountId: w.cash.id };
    const pv = await api.post(w.u.token, `/operations/${op.id}/correct/preview`, fix);
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body.effects.accounts.map((a: any) => [a.name, a.delta]).sort()).toEqual([['BCP', '50.00'], ['Efectivo', '-40.00']]);
    const r = await api.post(w.u.token, `/operations/${op.id}/correct`, { ...fix, reason: 'Pagué menos y en efectivo', previewToken: pv.body.previewToken });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.operation).toMatchObject({ kind: 'expense', description: 'Mercado', occurredOn: '2026-10-10' });
    expect(await balance(w.u.token, w.bcp.id)).toBe('200.00');
    expect(await balance(w.u.token, w.cash.id)).toBe('10.00');
    expect((await api.get(w.u.token, `/operations/${op.id}`)).body.status).toBe('reversed');
    expect((await api.post(w.u.token, `/operations/${op.id}/correct/preview`, fix)).body.error.code).toBe('ALREADY_REVERSED');
  });

  it('una transferencia se corrige de importe y destino; sin cambios o ligada a un cobro se rechaza', async () => {
    const w = await world();
    const tr = (await api.post(w.u.token, '/operations', { kind: 'transfer', accountId: w.bcp.id, toAccountId: w.cash.id, amount: '30.00', date: '2026-10-11' })).body;
    const none = await api.post(w.u.token, `/operations/${tr.id}/correct/preview`, { amount: '30.00' });
    expect(none.body.error.code).toBe('NO_CHANGES');
    const pv = await api.post(w.u.token, `/operations/${tr.id}/correct/preview`, { amount: '20.00' });
    expect(pv.body.effects.accounts.map((a: any) => [a.name, a.delta]).sort()).toEqual([['BCP', '10.00'], ['Efectivo', '-10.00']]);
    expect((await api.post(w.u.token, `/operations/${tr.id}/correct`, { amount: '20.00', reason: 'Eran 20', previewToken: pv.body.previewToken })).status).toBe(201);
    expect(await balance(w.u.token, w.bcp.id)).toBe('180.00');
    expect(await balance(w.u.token, w.cash.id)).toBe('70.00');

    const old = await payThirty(w);
    expect((await api.post(w.u.token, `/operations/${old.receipt.operationId}/correct/preview`, { amount: '10.00' })).body.error.code).toBe('OPERATION_LINKED');
  });

  it('editar descripción o nota no toca saldos; usa la versión y no edita evidencia revertida', async () => {
    const w = await world();
    const op = (await api.post(w.u.token, '/operations', { kind: 'income', accountId: w.bcp.id, amount: '15.00', date: '2026-10-10', description: 'Venta' })).body;
    const before = await balance(w.u.token, w.bcp.id);
    const ok = await api.patch(w.u.token, `/operations/${op.id}`, { description: 'Venta de usados', contactId: w.ana.id }, op.version);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.description).toBe('Venta de usados');
    expect(await balance(w.u.token, w.bcp.id)).toBe(before);
    const stale = await api.patch(w.u.token, `/operations/${op.id}`, { description: 'otra' }, op.version);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT_VERSION');
    expect((await api.post(w.u.token, `/operations/${op.id}/reverse`, { reason: 'x' })).status).toBe(201);
    const rev = (await api.get(w.u.token, `/operations/${op.id}`)).body;
    expect((await api.patch(w.u.token, `/operations/${op.id}`, { description: 'tarde' }, rev.version)).body.error.code).toBe('OPERATION_NOT_EDITABLE');

    const w2 = await world();
    const old = await payThirty(w2);
    const rcp = (await api.get(w2.u.token, `/receipts/${old.receipt.id}`)).body;
    const edited = await api.patch(w2.u.token, `/receipts/${old.receipt.id}`, { note: 'Yape de Ana' }, rcp.version);
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.note).toBe('Yape de Ana');
    expect((await api.get(w2.u.token, `/operations/${old.receipt.operationId}`)).body.description).toBe('Yape de Ana');
    // Cambiar el contacto de la operación de un cobro no está permitido.
    const opv = (await api.get(w2.u.token, `/operations/${old.receipt.operationId}`)).body;
    // La operación sabe a qué registro pertenece y el contacto lista sus cobros (para llegar a corregirlos).
    expect(opv.links).toEqual({ receiptId: old.receipt.id, supplierPaymentId: null, refundId: null });
    const list = (await api.get(w2.u.token, `/contacts/${w2.ana.id}/receipts`)).body.items;
    expect(list[0]).toMatchObject({ id: old.receipt.id, amount: '30.00', status: 'active', note: 'Yape de Ana', free: '0.00' });
    const other = await createContact(api, w2.u.token, 'Beto');
    expect((await api.patch(w2.u.token, `/operations/${old.receipt.operationId}`, { contactId: other.id }, opv.version)).body.error.code).toBe('OPERATION_LINKED');
  });
});
