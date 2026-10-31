import { afterAll, describe, expect, it } from 'vitest';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount, createContact } from '../helpers/scenarios.js';

const api = makeApi();
afterAll(async () => { await api.app.close(); await pool.end(); });
const at = (iso: string) => api.setNow(new Date(`${iso}T17:00:00Z`));

async function setup() {
  at('2026-10-12');
  const u = await api.newUser();
  const bcp = await createAccount(api, u.token, 'BCP', '500.00');
  const tree = (await api.get(u.token, '/categories')).body.items as any[];
  const cat = (name: string) => tree.find((c) => c.name === name);
  return { u, bcp, tree, cat };
}
const spend = (w: Awaited<ReturnType<typeof setup>>, body: Record<string, unknown>) =>
  api.post(w.u.token, '/operations', { kind: 'expense', accountId: w.bcp.id, amount: '20.00', date: '2026-10-10', ...body });

describe('Categorías (RN-CL01, D-29)', () => {
  it('el perfil nuevo trae las categorías sugeridas, editables y archivables', async () => {
    const w = await setup();
    expect(w.tree.map((c) => c.name).sort()).toEqual(['Comida', 'Hogar', 'Minigastos', 'Ocio', 'Otros', 'Salud', 'Servicios', 'Tecnología', 'Transporte']);
    expect(w.tree.every((c) => c.status === 'active' && c.children.length === 0)).toBe(true);
  });

  it('dos niveles, nombres únicos por nivel y renombrar no rompe el historial', async () => {
    const w = await setup();
    const sub = await api.post(w.u.token, '/categories', { name: 'Restaurantes', parentId: w.cat('Comida').id });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    expect(sub.body).toMatchObject({ name: 'Restaurantes', parentId: w.cat('Comida').id });
    expect((await api.post(w.u.token, '/categories', { name: 'Cafés', parentId: sub.body.id })).body.error.code).toBe('CATEGORY_DEPTH_EXCEEDED');
    expect((await api.post(w.u.token, '/categories', { name: 'restaurantes', parentId: w.cat('Comida').id })).body.error.code).toBe('CATEGORY_NAME_EXISTS');
    expect((await api.post(w.u.token, '/categories', { name: 'COMIDA' })).body.error.code).toBe('CATEGORY_NAME_EXISTS');
    expect((await api.post(w.u.token, '/categories', { name: 'Restaurantes' })).status).toBe(201); // el mismo nombre en otro nivel sí

    const op = await spend(w, { categoryId: sub.body.id, description: 'Cena' });
    expect(op.body.category).toMatchObject({ id: sub.body.id, name: 'Restaurantes' });
    const ren = await api.patch(w.u.token, `/categories/${sub.body.id}`, { name: 'Salidas a comer' }, sub.body.version);
    expect(ren.status, JSON.stringify(ren.body)).toBe(200);
    expect((await api.get(w.u.token, `/operations/${op.body.id}`)).body.category.name).toBe('Salidas a comer');
    expect((await api.patch(w.u.token, `/categories/${sub.body.id}`, { name: 'Otra vez' }, sub.body.version)).body.error.code).toBe('CONFLICT_VERSION');
    expect((await api.patch(w.u.token, `/categories/${sub.body.id}`, { name: 'Comida' }, ren.body.version)).status).toBe(200); // distinto nivel
  });

  it('archivar conserva el historial, bloquea clasificar con ella y se puede restaurar', async () => {
    const w = await setup();
    const sub = (await api.post(w.u.token, '/categories', { name: 'Delivery', parentId: w.cat('Comida').id })).body;
    const op = await spend(w, { categoryId: sub.id });
    expect((await api.post(w.u.token, `/categories/${w.cat('Comida').id}/archive`, {})).body.status).toBe('archived');
    const tree = (await api.get(w.u.token, '/categories?status=archived')).body.items;
    expect(tree.find((c: any) => c.name === 'Comida').children.map((c: any) => c.name)).toEqual(['Delivery']);
    expect((await api.get(w.u.token, `/operations/${op.body.id}`)).body.category.name).toBe('Delivery'); // el historial queda
    expect((await spend(w, { categoryId: sub.id })).body.error.code).toBe('CATEGORY_ARCHIVED');
    expect((await spend(w, { categoryId: w.cat('Comida').id })).body.error.code).toBe('CATEGORY_ARCHIVED');
    expect((await api.post(w.u.token, `/categories/${sub.id}/restore`, {})).body.error.code).toBe('CATEGORY_ARCHIVED'); // primero el padre
    expect((await api.post(w.u.token, `/categories/${w.cat('Comida').id}/restore`, {})).body.status).toBe('active');
    expect((await api.post(w.u.token, `/categories/${sub.id}/restore`, {})).body.status).toBe('active');
    const stranger = await api.newUser();
    expect((await api.post(stranger.token, `/categories/${sub.id}/archive`, {})).status).toBe(404);
  });
});

describe('Reglas de clasificación (RN-CL04…CL07, D-14)', () => {
  it('una regla necesita al menos una condición y un rango válido', async () => {
    const w = await setup();
    const base = { name: 'R', action: 'assign', categoryId: w.cat('Comida').id };
    expect((await api.post(w.u.token, '/classification-rules', base)).body.error.code).toBe('RULE_WITHOUT_CONDITION');
    expect((await api.post(w.u.token, '/classification-rules', { ...base, amountMin: '50.00', amountMax: '10.00' })).body.error.code).toBe('RULE_AMOUNT_RANGE');
    expect((await api.post(w.u.token, '/classification-rules', { ...base, textContains: 'x', categoryId: '00000000-0000-4000-8000-000000000001' })).status).toBe(404);
    expect((await api.post(w.u.token, '/classification-rules', { ...base, textContains: 'pollo' })).status).toBe(201);
  });

  it('gana la de menor número de prioridad; a igualdad, la más antigua; se muestra cuál se aplicó', async () => {
    const w = await setup();
    const r = async (body: Record<string, unknown>) => (await api.post(w.u.token, '/classification-rules', { action: 'suggest', ...body })).body;
    const general = await r({ name: 'Todo gasto', direction: 'expense', categoryId: w.cat('Otros').id, priority: 100 });
    const pollo = await r({ name: 'Pollo', textContains: 'POLLO', categoryId: w.cat('Comida').id, priority: 10 });
    const a = await r({ name: 'Empate A', textContains: 'pollo', categoryId: w.cat('Hogar').id, priority: 10 });
    const sg = await api.post(w.u.token, '/classification/suggest', { accountId: w.bcp.id, direction: 'expense', amount: '25.00', text: 'Pollería El Pollo Dorado' });
    expect(sg.status, JSON.stringify(sg.body)).toBe(200);
    expect(sg.body.applied.ruleId).toBe(pollo.id); // misma prioridad que «Empate A», pero más antigua
    expect(sg.body.matched.map((m: any) => m.ruleName)).toEqual(['Pollo', 'Empate A', 'Todo gasto']);
    const none = await api.post(w.u.token, '/classification/suggest', { accountId: w.bcp.id, direction: 'income', amount: '25.00', text: 'otro' });
    expect(none.body.applied).toBeNull();
    // Una categoría archivada deja de clasificar.
    await api.post(w.u.token, `/categories/${w.cat('Comida').id}/archive`, {});
    expect((await api.post(w.u.token, '/classification/suggest', { accountId: w.bcp.id, direction: 'expense', amount: '25.00', text: 'pollo' })).body.applied.ruleId).toBe(a.id);
    void general;
  });

  it('al crear un movimiento sin categoría: `assign` la fija, `suggest` solo la propone y una categoría elegida manda', async () => {
    const w = await setup();
    await api.post(w.u.token, '/classification-rules', { name: 'Netflix', textContains: 'netflix', direction: 'expense', action: 'assign', categoryId: w.cat('Servicios').id, priority: 1 });
    await api.post(w.u.token, '/classification-rules', { name: 'Grandes', direction: 'expense', amountMin: '100.00', action: 'suggest', categoryId: w.cat('Otros').id, priority: 50 });

    const a = await spend(w, { description: 'NETFLIX octubre', amount: '45.00' });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.category.name).toBe('Servicios');
    expect(a.body.classification).toMatchObject({ ruleName: 'Netflix', action: 'assign' });
    expect(a.body.classificationTrail[0]).toMatchObject({ ruleName: 'Netflix', mode: 'assign', categoryName: 'Servicios' });

    const b = await spend(w, { description: 'Compra grande', amount: '150.00' });
    expect(b.body.category).toBeNull(); // solo sugerida
    expect(b.body.classification).toMatchObject({ ruleName: 'Grandes', action: 'suggest', categoryName: 'Otros' });

    const c = await spend(w, { description: 'netflix de nuevo', categoryId: w.cat('Ocio').id });
    expect(c.body.category.name).toBe('Ocio'); // la elección manual manda
    expect(c.body.classification).toBeNull();

    const d = await api.post(w.u.token, '/operations', { kind: 'transfer', accountId: w.bcp.id, toAccountId: (await createAccount(api, w.u.token, 'Efectivo', '0.00', 'cash')).id, amount: '10.00', date: '2026-10-10', description: 'netflix' });
    expect(d.body.classification).toBeNull(); // una transferencia no se clasifica

    // Clasificar a mano deja su rastro y no pasa por reglas.
    const man = await api.patch(w.u.token, `/operations/${b.body.id}`, { categoryId: w.cat('Tecnología').id }, b.body.version);
    expect(man.status, JSON.stringify(man.body)).toBe(200);
    expect(man.body.classificationTrail[0]).toMatchObject({ mode: 'manual', ruleId: null, categoryName: 'Tecnología' });
  });

  it('reclasificar es a petición: solo lo que no tiene categoría y nunca cobros ni lo ya clasificado a mano', async () => {
    const w = await setup();
    const ana = await createContact(api, w.u.token, 'Ana');
    const old1 = (await spend(w, { description: 'Spotify Premium', amount: '17.00' })).body;
    const old2 = (await spend(w, { description: 'Spotify Familiar', amount: '25.00', categoryId: w.cat('Ocio').id })).body;
    const incomeOp = (await api.post(w.u.token, '/operations', { kind: 'income', accountId: w.bcp.id, amount: '30.00', date: '2026-10-10', description: 'Spotify devolución', contactId: ana.id })).body;
    // Las reglas nuevas no recategorizan el historial por sí solas (RN-CL07).
    const rule = await api.post(w.u.token, '/classification-rules', { name: 'Spotify', textContains: 'spotify', action: 'assign', categoryId: w.cat('Servicios').id });
    expect(rule.status).toBe(201);
    expect((await api.get(w.u.token, `/operations/${old1.id}`)).body.category).toBeNull();

    const pv = await api.post(w.u.token, '/classification/apply/preview', {});
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body.items.map((x: any) => x.operationId).sort()).toEqual([old1.id, incomeOp.id].sort()); // el clasificado a mano queda fuera
    const applied = await api.post(w.u.token, '/classification/apply', { previewToken: pv.body.previewToken });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.classified).toBe(2);
    expect((await api.get(w.u.token, `/operations/${old1.id}`)).body.category.name).toBe('Servicios');
    expect((await api.get(w.u.token, `/operations/${old2.id}`)).body.category.name).toBe('Ocio');
    expect((await api.get(w.u.token, `/operations/${old1.id}`)).body.classificationTrail[0].mode).toBe('bulk');
    expect((await api.post(w.u.token, '/classification/apply/preview', {})).body.count).toBe(0);
  });
});

describe('Listado de movimientos', () => {
  it('filtra por sin categoría, tipo, cuenta y texto, y pagina', async () => {
    const w = await setup();
    const ana = await createContact(api, w.u.token, 'Ana');
    for (const [d, amt, extra] of [['Café', '5.00', {}], ['Taxi', '12.00', { categoryId: w.cat('Transporte').id }], ['Cena', '40.00', {}]] as Array<[string, string, Record<string, unknown>]>) {
      expect((await spend(w, { description: d, amount: amt, ...extra })).status).toBe(201);
    }
    // Un cobro de un contacto no cuenta como «sin categoría» (RN-CL08).
    await api.post(w.u.token, '/operations', { kind: 'income', accountId: w.bcp.id, amount: '9.00', date: '2026-10-10', description: 'Aporte', contactId: ana.id });
    const un = (await api.get(w.u.token, '/operations?uncategorized=true')).body.items;
    expect(un.map((o: any) => o.description).sort()).toEqual(['Aporte', 'Café', 'Cena']);
    expect((await api.get(w.u.token, '/operations?kind=expense&q=ta')).body.items.map((o: any) => o.description)).toEqual(['Taxi']);
    expect((await api.get(w.u.token, `/operations?categoryId=${w.cat('Transporte').id}`)).body.items).toHaveLength(1);
    const p1 = (await api.get(w.u.token, `/operations?accountId=${w.bcp.id}&limit=2`)).body;
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (await api.get(w.u.token, `/operations?accountId=${w.bcp.id}&limit=2&cursor=${p1.nextCursor}`)).body;
    expect(p2.items.length).toBeGreaterThanOrEqual(2); // incluye el saldo inicial
    expect(p1.items[0]).toMatchObject({ accountId: w.bcp.id, amount: expect.any(String) });
  });

  it('eliminar: solo sin subcategorías ni uso; si no, explica por qué (y archivar sigue disponible)', async () => {
    const w = await setup();
    const sub = (await api.post(w.u.token, '/categories', { name: 'Restaurantes', parentId: w.cat('Comida').id })).body;
    // con subcategorías no se puede
    const blocked = await api.post(w.u.token, `/categories/${w.cat('Comida').id}/delete`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'CATEGORY_HAS_CHILDREN', details: { children: 1 } });
    // en uso no se puede: dice dónde
    expect((await spend(w, { categoryId: sub.id })).status).toBe(201);
    const used = await api.post(w.u.token, `/categories/${sub.id}/delete`);
    expect(used.status).toBe(409);
    expect(used.body.error.code).toBe('CATEGORY_IN_USE');
    expect(used.body.error.details.usage.movimientos).toBe(1);
    expect((await api.post(w.u.token, `/categories/${sub.id}/archive`)).body.status).toBe('archived');
    // sin uso y sin hijas sí se elimina, y desaparece del árbol
    const free = (await api.post(w.u.token, '/categories', { name: 'Temporal' })).body;
    const ok = await api.post(w.u.token, `/categories/${free.id}/delete`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toEqual({ id: free.id, deleted: true });
    expect(((await api.get(w.u.token, '/categories')).body.items as any[]).some((c) => c.id === free.id)).toBe(false);
    // otra persona no puede borrar la tuya
    const other = await api.newUser();
    expect((await api.post(other.token, `/categories/${w.cat('Hogar').id}/delete`)).status).toBe(404);
  });
});
