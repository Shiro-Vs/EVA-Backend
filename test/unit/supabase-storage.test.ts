import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { serviceHeaders } from '../../src/infra/auth/admin.js';
import { createSupabaseStore } from '../../src/infra/capture/files.js';

// Servidor local que imita la API de Supabase Storage: mismo contrato, sin depender de un proyecto real.
const KEY = 'sb_secret_clave-de-prueba-0123456789';
let server: Server;
let url: string;
const objects = new Map<string, Buffer>();
const seen: Array<{ method: string; path: string; headers: IncomingMessage['headers'] }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const path = decodeURIComponent((req.url ?? '').replace('/storage/v1/object/', ''));
      seen.push({ method: req.method ?? '', path, headers: req.headers });
      const legacy = !KEY.startsWith('sb_');
      if (req.headers.apikey !== KEY || (legacy ? req.headers.authorization !== `Bearer ${KEY}` : req.headers.authorization !== undefined)) { res.statusCode = 401; return res.end('{}'); }
      if (req.method === 'POST') { objects.set(path, Buffer.concat(chunks)); res.statusCode = 200; return res.end('{}'); }
      if (req.method === 'GET') {
        const b = objects.get(path);
        if (!b) { res.statusCode = 400; return res.end('{"error":"not_found"}'); } // Supabase responde 400 «Object not found»
        res.statusCode = 200; return res.end(b);
      }
      if (req.method === 'DELETE') { objects.delete(path); res.statusCode = 200; return res.end('{}'); }
      res.statusCode = 405; res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const store = () => createSupabaseStore({ url: `${url}/`, serviceKey: KEY, bucket: 'eva-files' });

describe('Almacenamiento en Supabase Storage', () => {
  it('guarda, lee y borra un archivo con la clave de servicio', async () => {
    const s = store();
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252]);
    await s.put('owner-1/doc-1', bytes);
    expect(seen.at(-1)).toMatchObject({ method: 'POST', path: 'eva-files/owner-1/doc-1' });
    expect(seen.at(-1)!.headers['x-upsert']).toBe('true');
    expect((await s.get('owner-1/doc-1')).equals(bytes)).toBe(true);
    await s.delete('owner-1/doc-1');
    await expect(s.get('owner-1/doc-1')).rejects.toThrow('Archivo inexistente');
  });

  it('la clave nueva (sb_secret_) va solo en apikey; la antigua (JWT) también como Bearer', () => {
    expect(serviceHeaders('sb_secret_abc')).toEqual({ apikey: 'sb_secret_abc' });
    expect(serviceHeaders('eyJ.abc.def')).toEqual({ apikey: 'eyJ.abc.def', authorization: 'Bearer eyJ.abc.def' });
  });

  it('borrar algo que no existe no falla', async () => {
    await expect(store().delete('owner-1/no-existe')).resolves.toBeUndefined();
  });

  it('rechaza claves que se salen del bucket', async () => {
    const s = store();
    for (const k of ['', '/abs', 'a/../b', 'a//b', './x']) await expect(s.put(k, Buffer.from('x'))).rejects.toThrow('Clave de archivo inválida');
  });

  it('codifica los segmentos de la ruta', async () => {
    await store().put('o w/ñ#1', Buffer.from('x'));
    expect(seen.at(-1)!.path).toBe('eva-files/o w/ñ#1');
  });

  it('con una clave incorrecta falla sin revelar la clave', async () => {
    const bad = createSupabaseStore({ url, serviceKey: 'sb_secret_otra-clave-0123456789ab', bucket: 'eva-files' });
    const err = await bad.put('a/b', Buffer.from('x')).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('HTTP 401');
    expect((err as Error).message).not.toContain('sb_secret');
  });
});

describe('Configuración de STORAGE_BUCKET', () => {
  const base = { DATABASE_URL: 'postgres://x', AUTH_MODE: 'dev', AUTH_DEV_SECRET: 'x'.repeat(32) };
  it('exige SUPABASE_URL y la clave de servicio', () => {
    expect(() => loadEnv({ ...base, STORAGE_BUCKET: 'eva-files' })).toThrow(/STORAGE_BUCKET/);
    expect(loadEnv({ ...base, STORAGE_BUCKET: 'eva-files', SUPABASE_URL: 'https://a.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(30) }).STORAGE_BUCKET).toBe('eva-files');
  });
  it('es opcional', () => { expect(loadEnv(base).STORAGE_BUCKET).toBeUndefined(); });
});
