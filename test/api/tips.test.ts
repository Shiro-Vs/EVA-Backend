import { afterAll, describe, expect, it } from 'vitest';
import { FOCI, focusFor } from '../../src/application/tips.js';
import { createUnavailableAnalyst } from '../../src/infra/capture/analyst.js';
import { ExtractorError, type AnalyzeInput, type Analyst } from '../../src/infra/capture/ports.js';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount } from '../helpers/scenarios.js';

function scripted(next: () => string | Error): Analyst & { calls: AnalyzeInput[] } {
  const calls: AnalyzeInput[] = [];
  return {
    provider: 'test', model: 'tip-1', calls,
    async answer(i) {
      calls.push(i);
      const v = next();
      if (v instanceof Error) throw v;
      return { text: v, provider: 'test', model: 'tip-1', usage: { tokensIn: 400, tokensOut: 50, costEstimate: 0.001 } };
    },
  };
}

let n = 0;
const analyst = scripted(() => `Consejo ${++n}`);
const api = makeApi({ analyst });
afterAll(async () => { await api.app.close(); await pool.end(); });
const at = (iso: string) => api.setNow(new Date(`${iso}T17:00:00Z`));

async function world(movements = 8) {
  at('2026-10-12');
  const u = await api.newUser();
  const bcp = await createAccount(api, u.token, 'BCP', '1000.00', 'bank', '2026-08-01');
  const food = ((await api.get(u.token, '/categories')).body.items as any[]).find((c) => c.name === 'Comida');
  for (let i = 0; i < movements; i++) {
    const r = await api.post(u.token, '/operations', { kind: 'expense', accountId: bcp.id, amount: '20.00', date: `2026-10-0${(i % 9) + 1}`, description: `Menú ${i}`, categoryId: food.id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  return { u, bcp };
}

describe('Consejo del día con IA', () => {
  it('se genera una sola vez por día y la segunda lectura no gasta IA', async () => {
    const w = await world();
    const before = analyst.calls.length;
    const a = await api.get(w.u.token, '/tips/today');
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.date).toBe('2026-10-12');
    expect(a.body.tip).toMatchObject({ text: expect.stringMatching(/^Consejo \d+$/), provider: 'test' });
    const b = await api.get(w.u.token, '/tips/today');
    expect(b.body.tip.text).toBe(a.body.tip.text);
    expect(analyst.calls.length).toBe(before + 1);
    const usage = (await api.get(w.u.token, '/capture/usage')).body;
    expect(usage.today.used ?? usage.today.count ?? usage.today).toBeDefined();
  });

  it('cada día toma otro enfoque y no repite los consejos anteriores', async () => {
    const w = await world();
    at('2026-10-12');
    const d1 = await api.get(w.u.token, '/tips/today');
    at('2026-10-13');
    const d2 = await api.get(w.u.token, '/tips/today');
    expect(d1.body.tip.focus).not.toBe(d2.body.tip.focus);
    expect(d2.body.tip.text).not.toBe(d1.body.tip.text);
    const last = analyst.calls[analyst.calls.length - 1]!;
    expect(last.question).toContain(d1.body.tip.text); // se le muestra lo anterior para no repetirlo
    expect(last.question).toContain('ENFOQUE DE HOY');
    const hist = (await api.get(w.u.token, '/tips?days=7')).body.items;
    expect(hist.map((t: any) => t.date)).toEqual(['2026-10-13', '2026-10-12']);
  });

  it('los enfoques rotan por completo y son estables dentro del mismo día', () => {
    const seen = new Set(Array.from({ length: FOCI.length }, (_, i) => focusFor(20000 + i).id));
    expect(seen.size).toBe(FOCI.length);
    expect(focusFor(20000)).toBe(focusFor(20000));
  });

  it('con pocos movimientos no inventa nada ni gasta IA', async () => {
    const w = await world(2);
    const before = analyst.calls.length;
    const r = await api.get(w.u.token, '/tips/today');
    expect(r.body).toEqual({ date: '2026-10-12', tip: null, reason: 'NOT_ENOUGH_DATA' });
    expect(analyst.calls.length).toBe(before);
  });

  it('a la IA solo le llegan datos calculados por el servidor, sin identificadores', async () => {
    const w = await world();
    await api.get(w.u.token, '/tips/today');
    const sent = JSON.stringify(analyst.calls[analyst.calls.length - 1]!.context);
    expect(sent).toContain('totals');
    expect(sent).not.toContain(w.u.id);
  });

  it('si la IA falla no se guarda nada y se puede reintentar luego', async () => {
    let fail = true;
    const flaky = scripted(() => (fail ? new ExtractorError('ANALYST_NETWORK', 'sin red', true) : 'Consejo recuperado'));
    const a2 = makeApi({ analyst: flaky });
    a2.setNow(new Date('2026-10-12T17:00:00Z'));
    const u = await a2.newUser();
    const bcp = await createAccount(a2, u.token, 'BCP', '1000.00', 'bank', '2026-08-01');
    for (let i = 1; i <= 6; i++) await a2.post(u.token, '/operations', { kind: 'expense', accountId: bcp.id, amount: '10.00', date: `2026-10-0${i}` });
    expect((await a2.get(u.token, '/tips/today')).body).toEqual({ date: '2026-10-12', tip: null, reason: 'AI_ERROR' });
    expect((await a2.get(u.token, '/tips')).body.items).toEqual([]);
    fail = false;
    expect((await a2.get(u.token, '/tips/today')).body.tip.text).toBe('Consejo recuperado');
    await a2.app.close();
  });

  it('sin modelo de IA configurado responde que no está disponible', async () => {
    const a3 = makeApi({ analyst: createUnavailableAnalyst() });
    a3.setNow(new Date('2026-10-12T17:00:00Z'));
    const u = await a3.newUser();
    expect((await a3.get(u.token, '/tips/today')).body).toEqual({ date: '2026-10-12', tip: null, reason: 'AI_UNAVAILABLE' });
    await a3.app.close();
  });

  it('cada persona ve solo su consejo', async () => {
    const w = await world();
    await api.get(w.u.token, '/tips/today');
    const other = await api.newUser();
    expect((await api.get(other.token, '/tips')).body.items).toEqual([]);
  });
});
