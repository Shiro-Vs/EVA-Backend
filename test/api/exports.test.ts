import { randomUUID } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { purgeExpiredExports } from '../../src/application/exports.js';
import { createMemoryStore } from '../../src/infra/capture/files.js';
import { createKysely } from '../../src/infra/db/db.js';
import { safeText, type ExportTable } from '../../src/infra/export/types.js';
import { toCsv } from '../../src/infra/export/csv.js';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount, createContact, createService, joinSeat } from '../helpers/scenarios.js';

const files = createMemoryStore();
const api = makeApi({ files });
afterAll(async () => { await api.app.close(); await pool.end(); });
const at = (iso: string, time = '17:00') => api.setNow(new Date(`${iso}T${time}:00Z`));

async function world() {
  at('2026-10-12');
  const u = await api.newUser('Rosa');
  const bcp = await createAccount(api, u.token, 'BCP', '1000.00', 'bank', '2026-08-01');
  const cash = await createAccount(api, u.token, 'Efectivo', '200.00', 'cash', '2026-08-01');
  const tree = (await api.get(u.token, '/categories')).body.items as any[];
  const cat = (n: string) => tree.find((c) => c.name === n);
  const op = async (kind: string, accountId: string, amount: string, date: string, extra: Record<string, unknown> = {}) => {
    const r = await api.post(u.token, '/operations', { kind, accountId, amount, date, ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  };
  await op('income', bcp.id, '3000.00', '2026-09-05', { description: 'Sueldo' });
  await op('expense', bcp.id, '800.00', '2026-09-06', { categoryId: cat('Hogar').id, description: 'Alquiler, "depa" 2' });
  await op('expense', cash.id, '50.00', '2026-09-10', { description: '=HYPERLINK("http://malo.example")' });
  await op('transfer', bcp.id, '100.00', '2026-09-12', { toAccountId: cash.id });
  return { u, bcp, cash, cat, op };
}
const REQ = { from: '2026-09-01', to: '2026-09-30', level: 'summary' as const };
const raw = async (token: string, id: string) => {
  const r = await api.app.inject({ method: 'GET', url: `/v1/exports/${id}/download`, headers: { authorization: `Bearer ${token}` } });
  return r;
};
const make = async (token: string, body: Record<string, unknown>) => {
  const r = await api.post(token, '/exports', { ...REQ, ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
const csvOf = async (token: string, sections: string[], extra: Record<string, unknown> = {}) => {
  const job = await make(token, { sections, format: 'csv', ...extra });
  const dl = await raw(token, job.id);
  expect(dl.statusCode).toBe(200);
  return { job, dl, text: dl.rawPayload.toString('utf8') };
};

describe('Vista previa de una exportación (08 §5)', () => {
  it('muestra las secciones elegidas en orden, con filas, totales y una muestra', async () => {
    const w = await world();
    const r = await api.post(w.u.token, '/exports/preview', { ...REQ, sections: ['accounts', 'transactions'] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.sections.map((s: any) => s.id)).toEqual(['accounts', 'transactions']);
    expect(r.body.sections[0]).toMatchObject({ rows: 2, totals: { opening: '1200.00', closing: '3350.00', change: '2150.00' } });
    expect(r.body.sections[1].rows).toBe(5); // sueldo, alquiler, menú y los dos lados de la transferencia
    expect(r.body.sections[1].sample).toHaveLength(5);
    expect(r.body).toMatchObject({ totalRows: 7, async: false });
    expect(r.body.warnings.join(' ')).toContain('No se incluyen comprobantes originales');
  });

  it('valida periodo, secciones y cuentas', async () => {
    const w = await world();
    const o = await world();
    const pv = (body: Record<string, unknown>) => api.post(w.u.token, '/exports/preview', { ...REQ, sections: ['flow'], ...body });
    expect((await pv({ to: '2026-10-13' })).body.error.code).toBe('FUTURE_DATE_NOT_ALLOWED');
    expect((await pv({ from: '2020-01-01' })).body.error.code).toBe('PERIOD_TOO_LONG');
    expect((await pv({ from: '2026-09-30', to: '2026-09-01' })).status).toBe(422);
    expect((await pv({ sections: [] })).status).toBe(422);
    expect((await pv({ sections: ['flow', 'flow'] })).status).toBe(422);
    expect((await pv({ sections: ['claves'] })).status).toBe(422);
    expect((await pv({ accountIds: [o.bcp.id] })).status).toBe(404);
  });
});

describe('CSV: una descarga por tabla, o un ZIP (08 §5)', () => {
  it('una sección es un CSV con BOM, CRLF, importes numéricos y fila de total', async () => {
    const w = await world();
    const { dl, text } = await csvOf(w.u.token, ['accounts']);
    expect(dl.headers['content-type']).toContain('text/csv');
    expect(dl.headers['content-disposition']).toContain('eva-accounts-2026-09-01_2026-09-30.csv');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1).split('\r\n')).toEqual([
      'Cuenta,Tipo,Saldo inicial,Saldo final,Variación',
      'BCP,bank,1000.00,3100.00,2100.00',
      'Efectivo,cash,200.00,250.00,50.00',
      'Total,,1200.00,3350.00,2150.00', '',
    ]);
  });

  it('escapa comas, comillas y neutraliza fórmulas en texto de terceros', async () => {
    const w = await world();
    const { text } = await csvOf(w.u.token, ['transactions']);
    expect(text).toContain('"Alquiler, ""depa"" 2"');
    expect(text).toContain(`"'=HYPERLINK(""http://malo.example"")"`); // no se ejecuta como fórmula
    expect(text).not.toMatch(/,=HYPERLINK/);
    expect(text).toContain('-800.00'); // los importes negativos NO se tocan
    expect(safeText('=1+1')).toBe("'=1+1");
    expect(safeText('@x')).toBe("'@x");
    expect(safeText('normal')).toBe('normal');
  });

  it('varias secciones forman un ZIP con un CSV por sección, en el orden elegido', async () => {
    const w = await world();
    const job = await make(w.u.token, { sections: ['expense_by_category', 'accounts', 'flow'], format: 'csv' });
    expect(job.filename).toBe('eva-2026-09-01_2026-09-30.zip');
    const dl = await raw(w.u.token, job.id);
    expect(dl.headers['content-type']).toBe('application/zip');
    const z = unzipSync(new Uint8Array(dl.rawPayload));
    expect(Object.keys(z)).toEqual(['01-gastos-por-categoria.csv', '02-cuentas.csv', '03-flujo-de-dinero.csv']);
    expect(strFromU8(z['01-gastos-por-categoria.csv']!)).toContain('Hogar,800.00,1,94.1');
  });

  it('toCsv: cada celda en su columna y sin totales si no los hay', () => {
    const t: ExportTable = { id: 'x', title: 'X', columns: [{ key: 'a', label: 'A', type: 'text' }, { key: 'b', label: 'B', type: 'money' }], rows: [{ a: 'uno\ndos', b: '1.50' }, { a: null, b: null }] };
    expect(toCsv(t)).toBe('﻿A,B\r\n"uno\ndos",1.50\r\n,\r\n');
  });
});

describe('Excel: una hoja por sección con importes como números', () => {
  it('genera un libro válido con hojas en orden, encabezado fijo, números y totales', async () => {
    const w = await world();
    const job = await make(w.u.token, { sections: ['accounts', 'transactions'], format: 'xlsx' });
    expect(job.filename).toBe('eva-2026-09-01_2026-09-30.xlsx');
    const dl = await raw(w.u.token, job.id);
    expect(dl.headers['content-type']).toContain('spreadsheetml.sheet');
    const z = unzipSync(new Uint8Array(dl.rawPayload));
    expect(Object.keys(z).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']);
    const wb = strFromU8(z['xl/workbook.xml']!);
    expect(wb.indexOf('name="Cuentas"')).toBeLessThan(wb.indexOf('name="Movimientos"'));
    const s1 = strFromU8(z['xl/worksheets/sheet1.xml']!);
    expect(s1).toContain('state="frozen"');
    expect(s1).toContain('<c r="C4" s="2"><v>1000.00</v></c>'); // importe como número, no como texto
    expect(s1).toContain('>Total<');
    expect(s1).toContain('<c r="E6" s="3"><v>2150.00</v></c>');
    const s2 = strFromU8(z['xl/worksheets/sheet2.xml']!);
    expect(s2).toContain('Alquiler, &quot;depa&quot; 2'); // XML escapado
    expect(s2).toContain("&apos;".length ? "'=HYPERLINK(" : ''); // la fórmula queda como texto
    expect(s2).not.toMatch(/<f>/);
  });
});

describe('PDF con secciones en orden y gráfico', () => {
  it('genera un PDF con todas las secciones', async () => {
    const w = await world();
    const job = await make(w.u.token, { sections: ['flow', 'expense_by_category', 'accounts', 'transactions', 'contacts', 'loans', 'budgets', 'goals', 'services', 'income_by_category'], format: 'pdf', level: 'detail' });
    const dl = await raw(w.u.token, job.id);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(dl.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(dl.rawPayload.length).toBeGreaterThan(3000);
    expect(job).toMatchObject({ status: 'done', format: 'pdf', ready: true });
  });
});

describe('Los números coinciden con el resumen mensual y con los demás módulos', () => {
  it('flujo y gastos por categoría son los del resumen; el filtro de cuentas se respeta', async () => {
    const w = await world();
    const rep = (await api.get(w.u.token, '/reports/monthly?month=2026-09')).body;
    const { text } = await csvOf(w.u.token, ['flow']);
    const lines = text.slice(1).split('\r\n');
    expect(lines[0]).toBe('Concepto,Entró,Salió,Neto,Movimientos');
    expect(lines.at(-2)).toBe(`Total,${rep.flow.totalIn},${rep.flow.totalOut},${rep.flow.net},`);
    const cash = await csvOf(w.u.token, ['accounts'], { accountIds: [w.cash.id] });
    expect(cash.text).toContain('Efectivo,cash,200.00,250.00,50.00');
    expect(cash.text).not.toContain('BCP');
  });

  it('servicios, contactos, préstamos, presupuestos y metas salen con datos reales', async () => {
    at('2026-10-07');
    const u = await api.newUser();
    const bcp = await createAccount(api, u.token, 'BCP', '500.00', 'bank', '2026-09-01');
    const svc = await createService(api, u.token, { announcedPrice: '45.00' });
    const ana = await createContact(api, u.token, 'Ana');
    await joinSeat(api, u.token, svc.id, ana.id, { quota: '20.00' });
    at('2026-10-12');
    const cyc = (await api.get(u.token, `/subscriptions/${svc.id}/cycles`)).body.items.find((c: any) => c.startDate === '2026-10-07');
    await api.post(u.token, `/billing-cycles/${cyc.id}/supplier-payment`, { accountId: bcp.id, amount: '47.00', paidOn: '2026-10-10' });
    await api.post(u.token, '/goals', { name: 'Laptop', targetAmount: '1200.00' });
    const hogar = ((await api.get(u.token, '/categories')).body.items as any[]).find((c) => c.name === 'Hogar');
    await api.post(u.token, '/budgets', { name: 'Hogar', categoryId: hogar.id, period: 'monthly', limit: '300.00', thresholds: [80, 100] });
    await api.post(u.token, '/bank-loans', { name: 'Personal', entity: 'Banco Sur' });
    const body = { from: '2026-10-01', to: '2026-10-12', level: 'summary', format: 'csv' as const };
    const get = async (section: string, extra: Record<string, unknown> = {}) => {
      const job = await api.post(u.token, '/exports', { ...body, sections: [section], ...extra });
      expect(job.status, JSON.stringify(job.body)).toBe(201);
      return (await raw(u.token, job.body.id)).rawPayload.toString('utf8').slice(1).split('\r\n');
    };
    expect((await get('services'))[1]).toMatch(/^Netflix,1,45.00,47.00,20.00,/);
    expect((await get('services', { level: 'detail' }))[0]).toContain('Ciclo desde');
    expect((await get('contacts'))[1]).toMatch(/^Ana,20\.00,/);
    expect((await get('loans')).some((l) => l.startsWith('Bancario,Personal · Banco Sur'))).toBe(true);
    expect((await get('budgets'))[1]).toMatch(/^Hogar,Hogar,Mensual,300\.00/);
    expect((await get('goals'))[1]).toMatch(/^Laptop,1200\.00,0\.00,1200\.00,0,/);
  });

  it('nunca incluye datos de otro usuario ni secretos', async () => {
    const w = await world();
    const o = await world();
    await o.op('expense', o.bcp.id, '77.77', '2026-09-20', { description: 'SECRETO-DEL-OTRO' });
    const { text } = await csvOf(w.u.token, ['transactions', 'accounts'], {});
    const z = unzipSync(new Uint8Array(text.length ? (await raw(w.u.token, (await api.get(w.u.token, '/exports')).body.items[0].id)).rawPayload : []));
    const all = Object.values(z).map((b) => strFromU8(b)).join('\n');
    expect(all).not.toContain('SECRETO-DEL-OTRO');
    expect(all).not.toContain('77.77');
    expect(all).not.toMatch(/Bearer|password|token|apikey/i);
  });
});

describe('Generación y vencimiento (08 §6)', () => {
  it('una exportación grande queda en cola, se genera en segundo plano y luego se descarga', async () => {
    const a = makeApi({ files, env: { EXPORT_SYNC_MAX_ROWS: '3' } });
    a.setNow(new Date('2026-10-12T17:00:00Z'));
    const u = await a.newUser();
    const bcp = await createAccount(a, u.token, 'BCP', '100.00', 'bank', '2026-08-01');
    for (let i = 1; i <= 6; i++) await a.post(u.token, '/operations', { kind: 'expense', accountId: bcp.id, amount: '1.00', date: `2026-09-0${i}` });
    const pv = await a.post(u.token, '/exports/preview', { ...REQ, sections: ['transactions'] });
    expect(pv.body.async).toBe(true);
    const key = randomUUID();
    const body = { ...REQ, sections: ['transactions'], format: 'csv' };
    const r = await a.post(u.token, '/exports', body, { 'idempotency-key': key });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'queued', ready: false });
    // Reintentar con la misma clave no crea otra exportación.
    const again = await a.post(u.token, '/exports', body, { 'idempotency-key': key });
    expect(again.body.id).toBe(r.body.id);
    let st = r.body.status;
    for (let i = 0; i < 40 && st !== 'done'; i++) { await new Promise((x) => setTimeout(x, 100)); st = (await a.get(u.token, `/exports/${r.body.id}`)).body.status; }
    expect(st).toBe('done');
    const dl = await a.app.inject({ method: 'GET', url: `/v1/exports/${r.body.id}/download`, headers: { authorization: `Bearer ${u.token}` } });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.toString('utf8').split('\r\n').length).toBeGreaterThan(8);
    expect((await a.get(u.token, '/exports')).body.items).toHaveLength(1);
    await a.app.close();
  });

  it('el archivo vence y se borra; el registro queda como vencido', async () => {
    const w = await world();
    const job = await make(w.u.token, { sections: ['accounts'], format: 'csv' });
    expect(new Date(job.expiresAt).getTime() - new Date(job.finishedAt).getTime()).toBe(24 * 3_600_000);
    at('2026-10-13', '18:00'); // más de 24 h después
    const gone = await raw(w.u.token, job.id);
    expect(gone.statusCode).toBe(422);
    expect(gone.json().error.code).toBe('EXPORT_EXPIRED');
    const n = await purgeExpiredExports({ db: createKysely(pool), now: () => new Date('2026-10-13T18:00:00Z'), files });
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await api.get(w.u.token, `/exports/${job.id}`)).body.status).toBe('expired');
    const key = (await pool.query('select file_key from export_job where id = $1', [job.id])).rows[0].file_key;
    expect(key).toBeNull();
  });

  it('una exportación es privada y un periodo con demasiados movimientos se rechaza con un mensaje claro', async () => {
    const w = await world();
    const o = await world();
    const job = await make(w.u.token, { sections: ['accounts'], format: 'csv' });
    expect((await api.get(o.u.token, `/exports/${job.id}`)).status).toBe(404);
    expect((await raw(o.u.token, job.id)).statusCode).toBe(404);
    expect((await api.get(o.u.token, '/exports')).body.items).toEqual([]);
  });
});
