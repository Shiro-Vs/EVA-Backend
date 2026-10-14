import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/http/app.js';
import { pool } from '../helpers/db.js';

afterAll(() => pool.end());

const base = { DATABASE_URL: 'postgres://x', AUTH_MODE: 'dev', AUTH_DEV_SECRET: 'x'.repeat(32) };

describe('configuración', () => {
  it('acepta una configuración válida con valores por defecto', () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(3000);
    expect(env.TZ_DEFAULT).toBe('America/Lima');
  });
  it('rechaza si falta DATABASE_URL', () => {
    expect(() => loadEnv({ AUTH_MODE: 'dev', AUTH_DEV_SECRET: 'x'.repeat(32) })).toThrow(/DATABASE_URL/);
  });
  it('rechaza un secreto de desarrollo corto', () => {
    expect(() => loadEnv({ ...base, AUTH_DEV_SECRET: 'corto' })).toThrow(/AUTH_DEV_SECRET/);
  });
  it('en modo jwks exige URL e emisor', () => {
    expect(() => loadEnv({ DATABASE_URL: 'x', AUTH_MODE: 'jwks' })).toThrow(/AUTH_JWKS_URL/);
  });
});

describe('API base', () => {
  it('/healthz responde ok con X-Request-Id', async () => {
    const app = buildApp({ pool, logLevel: 'silent' });
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'req-123' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('req-123');
    await app.close();
  });
  it('/readyz confirma la conexión a la base', async () => {
    const app = buildApp({ pool, logLevel: 'silent' });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.json()).toEqual({ status: 'ready' });
    await app.close();
  });
  it('una ruta inexistente usa el formato de error uniforme', async () => {
    const app = buildApp({ pool, logLevel: 'silent' });
    const res = await app.inject({ method: 'GET', url: '/nada' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: expect.any(String), requestId: expect.any(String) });
    await app.close();
  });
});

describe('migraciones inmutables', () => {
  it('rechaza una migración ya aplicada cuyo contenido cambió', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eva-mig-'));
    writeFileSync(join(dir, '0001_extensions_and_helpers.sql'), '-- contenido distinto\nselect 1;\n');
    await expect(migrate(process.env.TEST_DATABASE_URL!, dir)).rejects.toThrow(/MIGRATION_MODIFIED/);
  });
  it('un cambio de saltos de línea (LF↔CRLF) no cuenta como modificación', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eva-mig-eol-'));
    const original = readFileSync(join(process.cwd(), 'migrations', '0001_extensions_and_helpers.sql'), 'utf8').replace(/\r\n/g, '\n');
    writeFileSync(join(dir, '0001_extensions_and_helpers.sql'), original.replace(/\n/g, '\r\n'));
    const r = await migrate(process.env.TEST_DATABASE_URL!, dir);
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual(['0001_extensions_and_helpers.sql']);
  });
  it('volver a ejecutar sin cambios no aplica nada', async () => {
    const r = await migrate(process.env.TEST_DATABASE_URL!);
    expect(r.applied).toEqual([]);
    expect(r.skipped.length).toBeGreaterThanOrEqual(7);
  });
});
