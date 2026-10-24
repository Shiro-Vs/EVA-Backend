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
  const bcp = await createAccount(api, u.token, 'BCP', '500.00', 'bank', '2026-09-01');
  return { u, bcp };
}
type W = Awaited<ReturnType<typeof world>>;
const reconcile = async (w: W, body: Record<string, unknown>, accountId = w.bcp.id) => {
  const pv = await api.post(w.u.token, `/accounts/${accountId}/reconciliation/preview`, body);
  if (pv.status !== 200) return pv;
  return api.post(w.u.token, `/accounts/${accountId}/reconciliation`, { ...body, previewToken: pv.body.previewToken });
};

describe('Conciliación (RN-CO01…CO03, D-22)', () => {
  it('muestra la diferencia y qué revisar; si no se explica, registra un ajuste con motivo y saldo antes y después', async () => {
    const w = await world();
    await api.post(w.u.token, '/operations', { kind: 'expense', accountId: w.bcp.id, amount: '40.00', date: '2026-10-05', description: 'Mercado' });
    const pv = await api.post(w.u.token, `/accounts/${w.bcp.id}/reconciliation/preview`, { realBalance: '440.00' });
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body).toMatchObject({ registeredBalance: '460.00', realBalance: '440.00', difference: '-20.00', status: 'difference' });
    expect(pv.body.review[0]).toMatchObject({ description: 'Mercado', amount: '-40.00' }); // primero revisar los movimientos
    expect(await balance(w.u.token, w.bcp.id)).toBe('460.00'); // la vista previa no cambia nada

    expect((await api.post(w.u.token, `/accounts/${w.bcp.id}/reconciliation`, { realBalance: '440.00', previewToken: pv.body.previewToken })).body.error.code).toBe('VALIDATION_ERROR'); // falta el motivo
    const r = await api.post(w.u.token, `/accounts/${w.bcp.id}/reconciliation`, { realBalance: '440.00', reason: 'Comisión de mantenimiento', previewToken: pv.body.previewToken });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ registeredBefore: '460.00', realBalance: '440.00', difference: '-20.00', balanceAfter: '440.00', adjusted: true, reason: 'Comisión de mantenimiento' });
    expect(await balance(w.u.token, w.bcp.id)).toBe('440.00');

    // El ajuste es una operación propia: ni ingreso ni gasto de consumo.
    const op = (await api.get(w.u.token, `/operations/${r.body.adjustmentOperationId}`)).body;
    expect(op).toMatchObject({ kind: 'adjustment', concept: 'reconciliation', occurredOn: '2026-10-12' });
    expect(op.description).toContain('Comisión de mantenimiento');
    expect((await api.get(w.u.token, '/operations?kind=adjustment')).body.items).toHaveLength(1);
    expect((await api.get(w.u.token, '/operations?kind=expense')).body.items.map((o: any) => o.description)).toEqual(['Mercado']);
    expect((await api.get(w.u.token, `/accounts/${w.bcp.id}/reconciliations`)).body.items).toHaveLength(1);
  });

  it('si el saldo coincide se registra la conciliación sin ajuste', async () => {
    const w = await world();
    const r = await reconcile(w, { realBalance: '500.00' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ difference: '0.00', adjusted: false, adjustmentOperationId: null, balanceAfter: '500.00' });
    expect((await api.get(w.u.token, '/operations?kind=adjustment')).body.items).toHaveLength(0);
  });

  it('un ajuste a favor (el saldo real es mayor) también queda separado', async () => {
    const w = await world();
    const r = await api.post(w.u.token, `/accounts/${w.bcp.id}/reconciliation`, { realBalance: '512.50', reason: 'Interés ganado', previewToken: (await api.post(w.u.token, `/accounts/${w.bcp.id}/reconciliation/preview`, { realBalance: '512.50' })).body.previewToken });
    expect(r.body).toMatchObject({ difference: '12.50', balanceAfter: '512.50' });
    expect(await balance(w.u.token, w.bcp.id)).toBe('512.50');
    const income = (await api.get(w.u.token, '/operations?kind=income')).body.items;
    expect(income).toHaveLength(0); // no es un ingreso ganado
  });

  it('compara a una fecha pasada y el ajuste lleva esa fecha', async () => {
    const w = await world();
    await api.post(w.u.token, '/operations', { kind: 'expense', accountId: w.bcp.id, amount: '100.00', date: '2026-10-10' });
    const pv = await api.post(w.u.token, `/accounts/${w.bcp.id}/reconciliation/preview`, { realBalance: '495.00', asOf: '2026-10-01' });
    expect(pv.body).toMatchObject({ asOf: '2026-10-01', registeredBalance: '500.00', difference: '-5.00' }); // el gasto del 10 todavía no cuenta
    const r = await api.post(w.u.token, `/accounts/${w.bcp.id}/reconciliation`, { realBalance: '495.00', asOf: '2026-10-01', reason: 'Comisión', previewToken: pv.body.previewToken });
    expect((await api.get(w.u.token, `/operations/${r.body.adjustmentOperationId}`)).body.occurredOn).toBe('2026-10-01');
    expect(await balance(w.u.token, w.bcp.id)).toBe('395.00');
    expect((await api.post(w.u.token, `/accounts/${w.bcp.id}/reconciliation/preview`, { realBalance: '1.00', asOf: '2026-12-01' })).body.error.code).toBe('FUTURE_DATE_NOT_ALLOWED');
  });

  it('una tarjeta se concilia con su deuda en negativo; vista previa caduca si cambió el saldo', async () => {
    const w = await world();
    const card = await createAccount(api, w.u.token, 'Tarjeta', '-100.00', 'credit', '2026-09-01');
    expect((await api.post(w.u.token, `/accounts/${card.id}/reconciliation/preview`, { realBalance: '100.00' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await api.post(w.u.token, `/accounts/${w.bcp.id}/reconciliation/preview`, { realBalance: '-5.00' })).body.error.code).toBe('VALIDATION_ERROR');
    const pv = await api.post(w.u.token, `/accounts/${card.id}/reconciliation/preview`, { realBalance: '-130.00' });
    expect(pv.body).toMatchObject({ registeredBalance: '-100.00', difference: '-30.00' });
    await api.post(w.u.token, '/operations', { kind: 'expense', accountId: card.id, amount: '10.00', date: '2026-10-10' }); // cambia el saldo registrado
    const stale = await api.post(w.u.token, `/accounts/${card.id}/reconciliation`, { realBalance: '-130.00', reason: 'x', previewToken: pv.body.previewToken });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('PREVIEW_STALE');
    expect((await api.get((await api.newUser()).token, `/accounts/${card.id}/reconciliations`)).status).toBe(404);
  });
});
