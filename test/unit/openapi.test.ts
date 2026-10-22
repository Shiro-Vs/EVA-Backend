import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { buildOpenApi, ROUTES } from '../../src/http/openapi.js';
import { pool, testEnv } from '../helpers/db.js';

afterAll(() => pool.end());

describe('contrato OpenAPI (13)', () => {
  it('toda ruta /v1 real está documentada y no hay documentación de rutas inexistentes', async () => {
    const app = buildApp({ pool, env: testEnv(), logLevel: 'silent' });
    await app.ready();
    const real = new Set(
      app.routeTable
        .filter((r) => r.url.startsWith('/v1/') && r.method !== 'HEAD')
        .map((r) => `${r.method.toLowerCase()} ${r.url.slice(3).replace(/:(\w+)/g, '{$1}')}`),
    );
    const documented = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
    expect([...real].filter((x) => !documented.has(x))).toEqual([]);
    expect([...documented].filter((x) => !real.has(x))).toEqual([]);
    expect(real.size).toBe(ROUTES.length);
    await app.close();
  });

  it('openapi.json guardado coincide con el generado (ejecuta npm run openapi si cambió la API)', () => {
    const saved = readFileSync(resolve(process.cwd(), 'openapi.json'), 'utf8').replace(/\r\n/g, '\n');
    expect(saved).toBe(JSON.stringify(buildOpenApi(), null, 2) + '\n');
  });

  it('los cuerpos con importes exigen cadenas decimales y rechazan campos desconocidos', () => {
    const doc = buildOpenApi() as any;
    const body = doc.paths['/receipts'].post.requestBody.content['application/json'].schema;
    expect(body.properties.amount.type).toBe('string');
    expect(body.additionalProperties).toBe(false);
    expect(doc.paths['/receipts'].post.parameters.map((p: any) => p.name)).toContain('Idempotency-Key');
  });
});
