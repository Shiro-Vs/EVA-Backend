import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { serviceHeaders } from '../auth/admin.js';
import type { FileStore } from './ports.js';

/** Almacenamiento en disco (desarrollo y pruebas). En producción se usa createSupabaseStore (almacenamiento privado). */
export function createDiskStore(root: string): FileStore {
  const base = resolve(root);
  const path = (key: string) => {
    const p = resolve(join(base, key));
    if (!p.startsWith(base + sep)) throw new Error('Clave de archivo inválida');
    return p;
  };
  return {
    async put(key, bytes) { const p = path(key); await mkdir(dirname(p), { recursive: true }); await writeFile(p, bytes); },
    get: (key) => readFile(path(key)),
    async delete(key) { await rm(path(key), { force: true }); },
  };
}

/**
 * Supabase Storage (producción): bucket PRIVADO al que solo accede esta API con la clave de servicio.
 * Las claves de archivo las genera el servidor; cada segmento se codifica para la URL.
 */
export function createSupabaseStore(o: { url: string; serviceKey: string; bucket: string; fetchFn?: typeof fetch }): FileStore {
  const f = o.fetchFn ?? fetch;
  const base = `${o.url.replace(/\/+$/, '')}/storage/v1/object/${encodeURIComponent(o.bucket)}`;
  const target = (key: string) => {
    if (!key || key.startsWith('/') || key.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) throw new Error('Clave de archivo inválida');
    return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  };
  const auth = serviceHeaders(o.serviceKey);
  const fail = (what: string, status: number) => new Error(`Almacenamiento: no se pudo ${what} (HTTP ${status})`);
  return {
    async put(key, bytes) {
      const res = await f(target(key), { method: 'POST', headers: { ...auth, 'content-type': 'application/octet-stream', 'x-upsert': 'true' }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw fail('guardar el archivo', res.status);
    },
    async get(key) {
      const res = await f(target(key), { headers: auth, signal: AbortSignal.timeout(60_000) });
      if (res.status === 404 || res.status === 400) throw new Error('Archivo inexistente');
      if (!res.ok) throw fail('leer el archivo', res.status);
      return Buffer.from(await res.arrayBuffer());
    },
    async delete(key) {
      const res = await f(target(key), { method: 'DELETE', headers: auth, signal: AbortSignal.timeout(30_000) });
      if (!res.ok && res.status !== 404 && res.status !== 400) throw fail('borrar el archivo', res.status);
    },
  };
}

/** En memoria: pruebas. */
export function createMemoryStore(): FileStore & { size(): number } {
  const m = new Map<string, Buffer>();
  return {
    async put(key, bytes) { m.set(key, bytes); },
    async get(key) { const b = m.get(key); if (!b) throw new Error('Archivo inexistente'); return b; },
    async delete(key) { m.delete(key); },
    size: () => m.size,
  };
}
