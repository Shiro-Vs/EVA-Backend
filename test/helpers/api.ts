import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { signDevToken } from '../../src/infra/auth/auth.js';
import { DEV_SECRET, pool, testEnv } from './db.js';

/** Fecha de referencia de los escenarios: 2026-10-12 (mediodía en Lima = 17:00 UTC). */
export const REF_NOW = new Date('2026-10-12T17:00:00Z');

export interface Api {
  app: FastifyInstance;
  setNow(d: Date): void;
  newUser(name?: string): Promise<{ id: string; token: string }>;
  call(o: Req): Promise<Res>;
  /** Atajos autenticados. `write` añade una Idempotency-Key nueva salvo que se indique. */
  get(token: string, url: string): Promise<Res>;
  post(token: string, url: string, body?: unknown, extra?: Record<string, string>): Promise<Res>;
  patch(token: string, url: string, body: unknown, version: number): Promise<Res>;
}

export interface Req { method: 'GET' | 'POST' | 'PATCH'; url: string; token?: string; body?: unknown; headers?: Record<string, string> }
export interface Res { status: number; body: any; headers: Record<string, any> }

export function makeApi(): Api {
  let now = REF_NOW;
  const app = buildApp({ pool, env: testEnv(), now: () => now, logLevel: 'silent' });

  const call = async (o: Req): Promise<Res> => {
    const res = await app.inject({
      method: o.method,
      url: o.url,
      headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...o.headers },
      payload: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
    let body: any = null;
    try { body = res.body ? JSON.parse(res.body) : null; } catch { body = res.body; }
    return { status: res.statusCode, body, headers: res.headers };
  };

  return {
    app,
    setNow: (d) => { now = d; },
    async newUser(name = 'Usuario de prueba') {
      const id = randomUUID();
      return { id, token: await signDevToken(DEV_SECRET, { userId: id, name, email: `${id.slice(0, 8)}@test.local` }) };
    },
    call,
    get: (token, url) => call({ method: 'GET', url: `/v1${url}`, token }),
    post: (token, url, body = {}, extra = {}) => call({ method: 'POST', url: `/v1${url}`, token, body, headers: { 'idempotency-key': randomUUID(), ...extra } }),
    patch: (token, url, body, version) => call({ method: 'PATCH', url: `/v1${url}`, token, body, headers: { 'if-match': `"${version}"` } }),
  };
}
