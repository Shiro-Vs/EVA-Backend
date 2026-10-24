import { afterAll, describe, expect, it } from 'vitest';
import { carryOver, levelOf, periodOf, periodsFrom } from '../../src/domain/budget.js';
import { formatISO, parseISO } from '../../src/domain/localDate.js';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount, createContact, createService, joinSeat } from '../helpers/scenarios.js';

const api = makeApi();
afterAll(async () => { await api.app.close(); await pool.end(); });
const at = (iso: string) => api.setNow(new Date(`${iso}T17:00:00Z`));
const iso = (d: number) => formatISO(d);

async function world() {
  at('2026-10-12');
  const u = await api.newUser();
  const bcp = await createAccount(api, u.token, 'BCP', '5000.00', 'bank', '2026-08-01');
  const tree = (await api.get(u.token, '/categories')).body.items as any[];
  const cat = (n: string) => tree.find((c) => c.name === n);
  const sub = (await api.post(u.token, '/categories', { name: 'Restaurantes', parentId: cat('Comida').id })).body;
  return { u, bcp, cat, sub };
}
type W = Awaited<ReturnType<typeof world>>;
const spend = (w: W, amount: string, categoryId: string | null, date = '2026-10-10', extra: Record<string, unknown> = {}) =>
  api.post(w.u.token, '/operations', { kind: 'expense', accountId: w.bcp.id, amount, date, description: 'Gasto', ...(categoryId ? { categoryId } : {}), ...extra });
const budget = async (w: W, body: Record<string, unknown>) => {
  const r = await api.post(w.u.token, '/budgets', { name: 'Presupuesto', period: 'monthly', limit: '300.00', ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
const status = async (w: W, id: string, date?: string) => (await api.get(w.u.token, `/budgets/${id}${date ? `?date=${date}` : ''}`)).body.current;

describe('períodos y niveles (dominio)', () => {
  it('mes, semana de lunes a domingo y año', () => {
    expect([iso(periodOf(parseISO('2026-10-12'), 'monthly').start), iso(periodOf(parseISO('2026-10-12'), 'monthly').end)]).toEqual(['2026-10-01', '2026-10-31']);
    expect([iso(periodOf(parseISO('2026-02-10'), 'monthly').end)]).toEqual(['2026-02-28']);
    expect([iso(periodOf(parseISO('2026-10-14'), 'weekly').start), iso(periodOf(parseISO('2026-10-14'), 'weekly').end)]).toEqual(['2026-10-12', '2026-10-18']); // 12-oct-2026 es lunes
    expect(iso(periodOf(parseISO('2026-10-18'), 'weekly').start)).toBe('2026-10-12');
    expect(iso(periodOf(parseISO('2026-10-19'), 'weekly').start)).toBe('2026-10-19');
    expect([iso(periodOf(parseISO('2026-06-30'), 'yearly').start), iso(periodOf(parseISO('2026-06-30'), 'yearly').end)]).toEqual(['2026-01-01', '2026-12-31']);
    expect(periodsFrom(parseISO('2026-08-15'), parseISO('2026-10-12'), 'monthly').map((p) => iso(p.start))).toEqual(['2026-08-01', '2026-09-01', '2026-10-01']);
  });

  it('avisos: se cruzan al llegar al porcentaje y nada se bloquea; el excedente no se arrastra', () => {
    expect(levelOf(250n, 300n, [80, 100])).toMatchObject({ percent: 83.3, reached: [80], level: 80, exceeded: false });
    expect(levelOf(300n, 300n, [80, 100])).toMatchObject({ reached: [80, 100], level: 100, exceeded: false });
    expect(levelOf(310n, 300n, [80, 100])).toMatchObject({ level: 100, exceeded: true });
    expect(levelOf(10n, 0n, [80, 100]).exceeded).toBe(true);
    expect(carryOver(300n, 250n, null)).toBe(50n); // límite 300, gastó 250 → arrastra 50
    expect(carryOver(300n, 250n, 20n)).toBe(20n); // con tope
    expect(carryOver(300n, 350n, null)).toBe(0n); // el exceso no se arrastra como deuda
  });
});

describe('Presupuestos por categoría (RN-BU01…BU05)', () => {
  it('suma la categoría y sus subcategorías; avisa sin bloquear; ignora lo revertido y lo que no es consumo', async () => {
    const w = await world();
    const b = await budget(w, { name: 'Comida', categoryId: w.cat('Comida').id });
    expect(b).toMatchObject({ thresholds: [80, 100], rollover: false, includeSubcategories: true });
    expect((await spend(w, '200.00', w.cat('Comida').id)).status).toBe(201);
    expect((await spend(w, '50.00', w.sub.id)).status).toBe(201); // la subcategoría cuenta en el padre
    await spend(w, '500.00', w.cat('Tecnología').id); // otra categoría: no cuenta
    expect(await status(w, b.id)).toMatchObject({ spent: '250.00', remaining: '50.00', percent: 83.3, level: 80, exceeded: false, available: '300.00' });

    // Pasarse del límite NO bloquea y el gasto lo informa.
    const over = await spend(w, '60.00', w.cat('Comida').id);
    expect(over.status, JSON.stringify(over.body)).toBe(201);
    expect(over.body.budgetImpact[0]).toMatchObject({ name: 'Comida', spent: '310.00', overBy: '10.00', level: 100, exceeded: true });
    expect((await api.post(w.u.token, `/operations/${over.body.id}/reverse`, { reason: 'Error' })).status).toBe(201);
    expect((await status(w, b.id)).spent).toBe('250.00'); // lo revertido no consume

    // Lo que no es consumo no entra: ingresos, transferencias, préstamos y devoluciones.
    await api.post(w.u.token, '/operations', { kind: 'income', accountId: w.bcp.id, amount: '900.00', date: '2026-10-10', categoryId: w.cat('Comida').id });
    const other = await createAccount(api, w.u.token, 'Efectivo', '0.00', 'cash', '2026-08-01');
    await api.post(w.u.token, '/operations', { kind: 'transfer', accountId: w.bcp.id, toAccountId: other.id, amount: '100.00', date: '2026-10-10' });
    expect((await status(w, b.id)).spent).toBe('250.00');

    // Sin incluir subcategorías solo cuenta la categoría misma.
    const ed = await api.patch(w.u.token, `/budgets/${b.id}`, { includeSubcategories: false }, b.version);
    expect(ed.body.current.spent).toBe('200.00');
    expect((await api.get(w.u.token, `/budgets/${b.id}`)).body.items).toHaveLength(1);
  });

  it('el presupuesto general cuenta todo gasto de consumo UNA sola vez', async () => {
    const w = await world();
    const g = await budget(w, { name: 'General', limit: '1000.00' });
    await budget(w, { name: 'Comida', categoryId: w.cat('Comida').id });
    await spend(w, '100.00', w.cat('Comida').id);
    await spend(w, '50.00', w.sub.id);
    await spend(w, '25.00', null); // sin categoría también cuenta en el general
    expect((await status(w, g.id)).spent).toBe('175.00');
    expect((await api.get(w.u.token, '/budgets')).body.items.map((x: any) => [x.name, x.current.spent])).toEqual([['Comida', '150.00'], ['General', '175.00']]);
  });

  it('sin arrastre cada período empieza con su límite; con arrastre pasa solo lo no gastado y con tope', async () => {
    const w = await world();
    await spend(w, '250.00', w.cat('Comida').id, '2026-09-10'); // septiembre: gastó 250 de 300
    const none = await budget(w, { name: 'Sin arrastre', categoryId: w.cat('Comida').id, startsOn: '2026-09-01' });
    expect(await status(w, none.id)).toMatchObject({ limit: '300.00', carry: '0.00', available: '300.00', spent: '0.00' });
    expect((await status(w, none.id, '2026-09-20'))).toMatchObject({ spent: '250.00' });
    await api.post(w.u.token, `/budgets/${none.id}/archive`, {});

    const roll = await budget(w, { name: 'Con arrastre', categoryId: w.cat('Comida').id, startsOn: '2026-09-01', rollover: true });
    expect(await status(w, roll.id)).toMatchObject({ limit: '300.00', carry: '50.00', available: '350.00' }); // lo no gastado de septiembre
    const capped = await api.patch(w.u.token, `/budgets/${roll.id}`, { rolloverCap: '20.00' }, roll.version);
    expect(capped.body.current).toMatchObject({ carry: '20.00', available: '320.00' });

    await spend(w, '400.00', w.cat('Comida').id, '2026-08-20'); // ese presupuesto no existía en agosto
    const w2 = await world();
    await spend(w2, '350.00', w2.cat('Comida').id, '2026-09-10'); // se pasó en septiembre
    const over = await budget(w2, { name: 'Pasado', categoryId: w2.cat('Comida').id, startsOn: '2026-09-01', rollover: true });
    expect(await status(w2, over.id)).toMatchObject({ carry: '0.00', available: '300.00' }); // el exceso NO se arrastra como deuda
    expect((await api.post(w.u.token, '/budgets', { name: 'x', period: 'monthly', limit: '10.00', categoryId: w.cat('Ocio').id, rolloverCap: '5.00' })).body.error.code).toBe('ROLLOVER_REQUIRED');
  });

  it('un límite nuevo rige desde el período actual y no reescribe los anteriores', async () => {
    const w = await world();
    const b = await budget(w, { categoryId: w.cat('Comida').id, startsOn: '2026-09-01' });
    await spend(w, '250.00', w.cat('Comida').id, '2026-09-10');
    const ed = await api.patch(w.u.token, `/budgets/${b.id}`, { limit: '400.00' }, b.version);
    expect(ed.body.current).toMatchObject({ limit: '400.00', available: '400.00' });
    expect(await status(w, b.id, '2026-09-20')).toMatchObject({ limit: '300.00', spent: '250.00', percent: 83.3 });
    const hist = (await api.get(w.u.token, `/budgets/${b.id}/history?count=2`)).body.items;
    expect(hist.map((h: any) => [h.period.start, h.limit, h.spent])).toEqual([['2026-10-01', '400.00', '0.00'], ['2026-09-01', '300.00', '250.00']]);
  });

  it('un presupuesto semanal', async () => {
    const w = await world();
    const b = await budget(w, { name: 'Semana', period: 'weekly', limit: '100.00', categoryId: w.cat('Transporte').id });
    await spend(w, '30.00', w.cat('Transporte').id, '2026-10-12');
    await spend(w, '40.00', w.cat('Transporte').id, '2026-10-11'); // domingo de la semana anterior
    expect(await status(w, b.id)).toMatchObject({ period: { start: '2026-10-12', end: '2026-10-18', kind: 'weekly' }, spent: '30.00' });
  });

  it('validaciones: uno por categoría y período, categorías archivadas y avisos', async () => {
    const w = await world();
    const b = await budget(w, { categoryId: w.cat('Comida').id });
    expect((await api.post(w.u.token, '/budgets', { name: 'otro', period: 'monthly', limit: '10.00', categoryId: w.cat('Comida').id })).body.error.code).toBe('BUDGET_EXISTS');
    expect((await api.post(w.u.token, '/budgets', { name: 'otro', period: 'weekly', limit: '10.00', categoryId: w.cat('Comida').id })).status).toBe(201); // otro período sí
    await api.post(w.u.token, `/categories/${w.cat('Ocio').id}/archive`, {});
    expect((await api.post(w.u.token, '/budgets', { name: 'ocio', period: 'monthly', limit: '10.00', categoryId: w.cat('Ocio').id })).body.error.code).toBe('CATEGORY_ARCHIVED');
    expect((await api.post(w.u.token, '/budgets', { name: 'a', period: 'monthly', limit: '10.00', thresholds: [0] })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await api.patch(w.u.token, `/budgets/${b.id}`, { thresholds: [50, 90, 100] }, b.version)).body.thresholds).toEqual([50, 90, 100]);
    await api.post(w.u.token, `/budgets/${b.id}/archive`, {});
    expect((await api.get(w.u.token, '/budgets?status=archived')).body.items.map((x: any) => x.name)).toEqual(['Presupuesto']);
    expect((await api.get((await api.newUser()).token, `/budgets/${b.id}`)).status).toBe(404);
  });
});

describe('Servicios compartidos en el presupuesto (RN-BU06…BU08)', () => {
  async function shared(view: 'origin_cycle' | 'receipt_date') {
    const w = await world();
    const b = await budget(w, { name: 'Servicios', categoryId: w.cat('Servicios').id, limit: '100.00', sharedView: view });
    at('2026-10-07');
    const svc = await createService(api, w.u.token, { categoryId: w.cat('Servicios').id });
    const ana = await createContact(api, w.u.token, 'Ana');
    const beto = await createContact(api, w.u.token, 'Beto');
    const sa = await joinSeat(api, w.u.token, svc.id, ana.id, { quota: '18.00' });
    const sb = await joinSeat(api, w.u.token, svc.id, beto.id, { quota: '18.00' });
    expect(sa.status, JSON.stringify(sa.body)).toBe(201);
    at('2026-10-10');
    const cycles = (await api.get(w.u.token, `/subscriptions/${svc.id}/cycles`)).body.items as any[];
    const cyc = cycles.find((c) => c.startDate === '2026-10-07');
    const sp = await api.post(w.u.token, `/billing-cycles/${cyc.id}/supplier-payment`, { accountId: w.bcp.id, amount: '47.00', paidOn: '2026-10-10' });
    expect(sp.status, JSON.stringify(sp.body)).toBe(201);
    return { w, b, svc, ana, beto, sa: sa.body, sb: sb.body };
  }
  const collect = async (s: Awaited<ReturnType<typeof shared>>, contactId: string, obligationId: string, amount: string, receivedOn: string) => {
    const body = { contactId, accountId: s.w.bcp.id, amount, allocations: [{ obligationId, amount }], receivedOn };
    const pv = await api.post(s.w.u.token, '/receipts/preview', body);
    expect((await api.post(s.w.u.token, '/receipts', { ...body, previewToken: pv.body.previewToken })).status).toBe(201);
  };

  it('pago 47, cuotas exigibles 36, cobros 24 → previsto 11, real 23, pendiente 12; las cuotas impagas no reducen el costo', async () => {
    const s = await shared('origin_cycle');
    expect(await status(s.w, s.b.id)).toMatchObject({ spent: '47.00', breakdown: { gross: '47.00', collectionsOffset: '0.00' } }); // nadie ha pagado todavía
    at('2026-10-20');
    await collect(s, s.ana.id, s.sa.charges[0].obligationId, '18.00', '2026-10-20');
    await collect(s, s.beto.id, s.sb.charges[0].obligationId, '6.00', '2026-10-20');
    const d = (await api.get(s.w.u.token, `/budgets/${s.b.id}`)).body;
    expect(d.current).toMatchObject({ spent: '23.00', breakdown: { gross: '47.00', collectionsOffset: '24.00' } });
    expect(d.shared).toHaveLength(1);
    expect(d.shared[0]).toMatchObject({ paid: '47.00', expectedFromOthers: '36.00', receivedFromOthers: '24.00', pendingFromOthers: '12.00', projectedCost: '11.00', realCost: '23.00' });
    expect(d.items[0]).toMatchObject({ amount: '47.00', sharedService: true });
  });

  it('según la vista: «ciclo de origen» resta el cobro al mes del pago; «fecha de recepción» lo resta al mes en que entró', async () => {
    const o = await shared('origin_cycle');
    at('2026-11-02');
    await collect(o, o.ana.id, o.sa.charges[0].obligationId, '18.00', '2026-11-02');
    await collect(o, o.beto.id, o.sb.charges[0].obligationId, '6.00', '2026-11-02');
    expect((await status(o.w, o.b.id, '2026-10-15')).spent).toBe('23.00'); // octubre baja a 23 aunque se cobró en noviembre
    expect(await status(o.w, o.b.id, '2026-11-15')).toMatchObject({ spent: '0.00', breakdown: { gross: '0.00', collectionsOffset: '0.00' } });

    const r = await shared('receipt_date');
    at('2026-11-02');
    await collect(r, r.ana.id, r.sa.charges[0].obligationId, '18.00', '2026-11-02');
    await collect(r, r.beto.id, r.sb.charges[0].obligationId, '6.00', '2026-11-02');
    expect((await status(r.w, r.b.id, '2026-10-15')).spent).toBe('47.00'); // caja: octubre pagó 47
    expect(await status(r.w, r.b.id, '2026-11-15')).toMatchObject({ spent: '0.00', breakdown: { gross: '0.00', collectionsOffset: '24.00' } }); // noviembre recibió 24
  });

  it('el pago al proveedor hereda la categoría del servicio y se puede cambiar', async () => {
    const s = await shared('origin_cycle');
    const sub = (await api.get(s.w.u.token, `/subscriptions/${s.svc.id}`)).body;
    expect(sub.categoryId).toBe(s.w.cat('Servicios').id);
    const ed = await api.patch(s.w.u.token, `/subscriptions/${s.svc.id}`, { categoryId: s.w.cat('Ocio').id }, sub.version);
    expect(ed.status, JSON.stringify(ed.body)).toBe(200);
    expect(ed.body.categoryId).toBe(s.w.cat('Ocio').id);
  });
});
