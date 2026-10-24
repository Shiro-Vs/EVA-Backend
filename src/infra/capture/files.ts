import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { FileStore } from './ports.js';

/** Almacenamiento en disco (desarrollo y pruebas). En producción se sustituye por almacenamiento privado con URL firmada. */
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
