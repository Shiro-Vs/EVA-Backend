import { afterAll, describe, expect, it } from 'vitest';
import { outsideQuiet } from '../../src/application/dashboard.js';
import { CARD_IDS, completeCards, resolvePreferences } from '../../src/domain/preferences.js';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount, createContact, createService, joinSeat } from '../helpers/scenarios.js';

const api = makeApi();
afterAll(async () => { await api.app.close(); await pool.end(); });
const at = (iso: string, time = '17:00') => api.setNow(new Date(`${iso}T${time}:00Z`)); // Lima = UTC−5

const put = (token: string, body: unknown) => api.call({ method: 'PUT' as never, url: '/v1/preferences', token, body });

describe('Preferencias (RN-PA01, 09 §7, RN-SE02)', () => {
  it('sin guardar nada devuelve los valores por defecto del panel y de los avisos', async () => {
    at('2026-10-12');
    const u = await api.newUser();
    const p = (await api.get(u.token, '/preferences')).body;
    expect(p.dashboard.cards.map((c: any) => c.id)).toEqual([...CARD_IDS]);
    expect(p.dashboard.cards.filter((c: any) => c.enabled).map((c: any) => c.id)).toEqual(['accounts_balance', 'credit_debt'].slice(0, 1).concat(['pending_collections', 'renewals', 'capture_pending', 'upcoming_payments']).sort((a, b) => CARD_IDS.indexOf(a as never) - CARD_IDS.indexOf(b as never)));
    expect(p.notifications).toMatchObject({ enabled: true, discreet: true, time: '09:00', quiet: { from: '22:00', to: '07:00' } });
    expect(p.security).toEqual({ lockAfterSeconds: 60 });
    expect(p.capture).toEqual({ reviewMode: 'individual', duplicates: 'separate' });
    expect(p.backup).toEqual({ frequency: 'weekly', keep: 2 });
  });

  it('cada sección enviada reemplaza a la guardada y las demás no se tocan', async () => {
    at('2026-10-12');
    const u = await api.newUser();
    const r = await put(u.token, { security: { lockAfterSeconds: 300 }, capture: { reviewMode: 'batch', duplicates: 'grouped' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.security).toEqual({ lockAfterSeconds: 300 });
    expect(r.body.capture).toEqual({ reviewMode: 'batch', duplicates: 'grouped' });
    expect(r.body.notifications.time).toBe('09:00'); // intacta
    const again = (await api.get(u.token, '/preferences')).body;
    expect(again.security.lockAfterSeconds).toBe(300);
  });

  it('valida cada sección: horas, anticipaciones, tarjetas repetidas y claves desconocidas', async () => {
    const u = await api.newUser();
    const n = (over: Record<string, unknown>) => ({ notifications: { ...((await_defaults as any).notifications), ...over } });
    const await_defaults = resolvePreferences({});
    expect((await put(u.token, n({ time: '25:00' }))).status).toBe(422);
    expect((await put(u.token, n({ quiet: { from: '22:00' } }))).status).toBe(422);
    expect((await put(u.token, { dashboard: { cards: [{ id: 'accounts_balance', enabled: true }, { id: 'accounts_balance', enabled: false }] } })).status).toBe(422);
    expect((await put(u.token, { dashboard: { cards: [{ id: 'inventada', enabled: true }] } })).status).toBe(422);
    expect((await put(u.token, { security: { lockAfterSeconds: -1 } })).status).toBe(422);
    expect((await put(u.token, { backup: { frequency: 'daily', keep: 2 } })).status).toBe(422);
    expect((await put(u.token, { otra: 1 })).status).toBe(422);
    expect((await put(u.token, {})).status).toBe(422);
  });

  it('una sección guardada inválida cae en su valor por defecto en lugar de romper', () => {
    const p = resolvePreferences({ security: { lockAfterSeconds: 'mucho' }, capture: { reviewMode: 'batch', duplicates: 'grouped' } });
    expect(p.security).toEqual({ lockAfterSeconds: 60 });
    expect(p.capture.reviewMode).toBe('batch');
    expect(completeCards([{ id: 'goals', enabled: true }]).map((c) => c.id)).toEqual(['goals', ...CARD_IDS.filter((x) => x !== 'goals')]);
  });
});

describe('Panel configurable (RN-PA01…PA03)', () => {
  it('muestra solo las tarjetas habilitadas, en el orden elegido', async () => {
    at('2026-10-12');
    const u = await api.newUser();
    const acc = await createAccount(api, u.token, 'BCP', '500.00', 'bank', '2026-10-01');
    const d0 = (await api.get(u.token, '/dashboard')).body;
    expect(d0.cards.map((c: any) => c.id)).toEqual(['accounts_balance', 'renewals', 'pending_collections', 'capture_pending', 'upcoming_payments']);
    expect(d0.cards[0].data.accounts).toEqual([expect.objectContaining({ id: acc.id, name: 'BCP', balance: '500.00' })]);
    expect(d0.available).toHaveLength(CARD_IDS.length);

    // Elegir y reordenar: metas y flujo del mes primero, sin cuentas.
    await put(u.token, { dashboard: { cards: [{ id: 'period_flow', enabled: true }, { id: 'goals', enabled: true }, { id: 'accounts_balance', enabled: false }] } });
    const d1 = (await api.get(u.token, '/dashboard')).body;
    expect(d1.cards.map((c: any) => c.id)).toEqual(['period_flow', 'goals']);
    expect(d1.cards[0].data).toMatchObject({ month: '2026-10', income: '0.00', consumption: '0.00', net: '0.00' });
    expect(d1.available.find((c: any) => c.id === 'accounts_balance').enabled).toBe(false);
  });

  it('separa lo pendiente de aceptar (no afecta saldo) de lo aceptado por clasificar (sí afecta)', async () => {
    const a = makeApi({ extractor: (await import('../../src/infra/capture/heuristic.js')).createHeuristicExtractor() });
    a.setNow(new Date('2026-10-12T17:00:00Z'));
    const u = await a.newUser();
    const bcp = await createAccount(a, u.token, 'BCP', '500.00', 'bank', '2026-10-01');
    const d = await a.post(u.token, '/capture/documents', { origin: 'text', text: 'Yape: pagaste S/ 8.50 a Bodega el 2026-10-10. Operación 7771234' });
    const card = async () => ((await a.get(u.token, '/dashboard')).body.cards.find((c: any) => c.id === 'capture_pending').data);
    expect(await card()).toMatchObject({ pendingProposals: 1, acceptedToClassify: 0 });
    const p = d.body.proposals[0];
    await a.patch(u.token, `/capture/proposals/${p.id}`, { accountId: bcp.id }, p.version);
    const pv = await a.post(u.token, `/capture/proposals/${p.id}/preview`);
    await a.post(u.token, `/capture/proposals/${p.id}/accept`, { previewToken: pv.body.previewToken });
    expect(await card()).toMatchObject({ pendingProposals: 0, acceptedToClassify: 1 });
    await a.app.close();
  });

  it('cobros pendientes y renovaciones salen de los mismos datos que el resumen', async () => {
    at('2026-10-07');
    const u = await api.newUser();
    await createAccount(api, u.token, 'BCP', '200.00');
    const svc = await createService(api, u.token, { announcedPrice: '45.00' });
    const ana = await createContact(api, u.token, 'Ana');
    await joinSeat(api, u.token, svc.id, ana.id, { quota: '20.00' });
    at('2026-11-03'); // faltan 4 días para la renovación del 7 de noviembre
    const dash = (await api.get(u.token, '/dashboard')).body;
    const ren = dash.cards.find((c: any) => c.id === 'renewals').data.items;
    expect(ren).toEqual([expect.objectContaining({ name: 'Netflix', renewsOn: '2026-11-07', price: '45.00' })]);
    expect(dash.cards.find((c: any) => c.id === 'pending_collections').data.pending).toBe((await api.get(u.token, '/summary')).body.receivable.pending);
  });
});

describe('Avisos: qué avisar y cuándo (09 §7)', () => {
  it('el horario silencioso mueve la hora al final del silencio', () => {
    const q = { from: '22:00', to: '07:00' };
    expect(outsideQuiet('09:00', q)).toEqual({ time: '09:00', nextDay: false });
    expect(outsideQuiet('23:30', q)).toEqual({ time: '07:00', nextDay: true });
    expect(outsideQuiet('05:00', q)).toEqual({ time: '07:00', nextDay: false });
    expect(outsideQuiet('12:00', { from: '12:00', to: '14:00' })).toEqual({ time: '14:00', nextDay: false });
    expect(outsideQuiet('03:00', null)).toEqual({ time: '03:00', nextDay: false });
  });

  async function withRenewal() {
    at('2026-10-07');
    const u = await api.newUser();
    await createAccount(api, u.token, 'BCP', '200.00');
    const svc = await createService(api, u.token, { announcedPrice: '45.00' });
    return { u, svc };
  }

  it('programa avisos con la anticipación configurada y texto discreto', async () => {
    const { u, svc } = await withRenewal();
    at('2026-11-03', '14:00'); // 09:00 en Lima
    const r = (await api.get(u.token, '/reminders')).body;
    expect(r).toMatchObject({ enabled: true, discreet: true, time: '09:00' });
    const ren = r.items.find((i: any) => i.kind === 'renewal');
    expect(ren).toMatchObject({ dueDate: '2026-11-07', title: 'Tienes renovaciones próximas', detail: null, route: `/service/${svc.id}`, overdue: false });
    // leadDays [3,1,0] → 4, 6 y 7 de noviembre a las 09:00; el del 4 (3 días antes) ya es futuro
    expect(ren.fireAt).toEqual(['2026-11-04T09:00', '2026-11-06T09:00', '2026-11-07T09:00']);
    expect(JSON.stringify(r)).not.toContain('Netflix'); // discreto: sin nombres ni importes
  });

  it('el detalle solo aparece si el usuario lo habilita; y se pueden apagar avisos', async () => {
    const { u } = await withRenewal();
    at('2026-11-03', '14:00');
    const base = resolvePreferences({}).notifications;
    await put(u.token, { notifications: { ...base, discreet: false } });
    const ren = (await api.get(u.token, '/reminders')).body.items.find((i: any) => i.kind === 'renewal');
    expect(ren.detail).toBe('Renueva Netflix (45.00)');
    await put(u.token, { notifications: { ...base, kinds: { ...base.kinds, renewal: { enabled: false, leadDays: [1] } } } });
    expect((await api.get(u.token, '/reminders')).body.items.find((i: any) => i.kind === 'renewal')).toBeUndefined();
    await put(u.token, { notifications: { ...base, enabled: false } });
    expect((await api.get(u.token, '/reminders')).body).toEqual({ enabled: false, items: [] });
  });

  it('las horas pasadas no se programan y el silencio nocturno se respeta', async () => {
    const { u } = await withRenewal();
    at('2026-11-06', '16:00'); // 11:00 en Lima del día 6: la hora de las 09:00 de hoy ya pasó
    const base = resolvePreferences({}).notifications;
    const r1 = (await api.get(u.token, '/reminders')).body.items.find((i: any) => i.kind === 'renewal');
    expect(r1.fireAt).toEqual(['2026-11-07T09:00']); // los avisos de los días 4 y 6 ya pasaron
    at('2026-11-03', '14:00');
    await put(u.token, { notifications: { ...base, time: '23:00', quiet: { from: '22:00', to: '07:00' } } });
    const r2 = (await api.get(u.token, '/reminders')).body.items.find((i: any) => i.kind === 'renewal');
    expect(r2.fireAt).toEqual(['2026-11-05T07:00', '2026-11-07T07:00', '2026-11-08T07:00']);
  });

  it('propuestas de captura, recurrentes y cuotas de préstamo también generan avisos', async () => {
    at('2026-10-12');
    const a = makeApi({ extractor: (await import('../../src/infra/capture/heuristic.js')).createHeuristicExtractor() });
    a.setNow(new Date('2026-10-12T17:00:00Z'));
    const u = await a.newUser();
    const bcp = await createAccount(a, u.token, 'BCP', '500.00', 'bank', '2026-10-01');
    await a.post(u.token, '/capture/documents', { origin: 'text', text: 'Yape: pagaste S/ 8.50 a Bodega el 2026-10-10. Operación 7771234' });
    await a.post(u.token, '/recurring/templates', { name: 'Alquiler', kind: 'expense', accountId: bcp.id, amount: '800.00', interval: { unit: 'month', count: 1 }, startDate: '2026-10-12' });
    const loan = (await a.post(u.token, '/bank-loans', { name: 'Personal' })).body;
    const chg = { installments: [{ number: 1, dueDate: '2026-10-14', principal: '80.00', interest: '20.00', insurance: null, fees: null, total: '100.00' }] };
    const pv = await a.post(u.token, `/bank-loans/${loan.id}/changes/preview`, chg);
    await a.post(u.token, `/bank-loans/${loan.id}/changes`, { ...chg, previewToken: pv.body.previewToken });
    const r = (await a.get(u.token, '/reminders')).body.items;
    expect(r.map((i: any) => i.kind).sort()).toEqual(['capture', 'loan', 'recurring']);
    expect(r.find((i: any) => i.kind === 'capture')).toMatchObject({ count: 1, route: '/capture', dueDate: null });
    expect(r.find((i: any) => i.kind === 'loan')).toMatchObject({ dueDate: '2026-10-14', route: `/bank-loan/${loan.id}` });
    const up = (await a.get(u.token, '/dashboard')).body.cards.find((c: any) => c.id === 'upcoming_payments').data.items;
    expect(up.map((i: any) => i.type).sort()).toEqual(['bank_loan', 'recurring']);
    await a.app.close();
  });
});
