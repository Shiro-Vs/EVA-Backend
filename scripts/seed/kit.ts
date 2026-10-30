// Utilidades de la carga de datos de demostración: cliente HTTP en proceso, reloj simulado y azar repetible.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadEnv } from '../../src/config/env.js';
import { buildApp } from '../../src/http/app.js';
import { signDevToken } from '../../src/infra/auth/auth.js';

process.env.EXTRACTOR = 'heuristic'; // la carga nunca gasta cuota de IA
export const env = loadEnv();
if (!/eva_dev/.test(env.DATABASE_URL)) throw new Error('Por seguridad la carga solo corre sobre eva_dev.');

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 4 });
let now = new Date('2026-05-01T17:00:00Z');
export const app = buildApp({ pool, env, now: () => now, logLevel: 'silent' });
/** Mediodía en Lima del día indicado. */
export const at = (iso: string) => { now = new Date(`${iso}T17:00:00Z`); };

export const USER_ID = env.DEV_LOGIN_USER_ID!;
export const token = await signDevToken(env.AUTH_DEV_SECRET!, { userId: USER_ID, name: 'Yo (desarrollo)', email: 'dev@eva.local' });

export interface Res { status: number; body: any }
export const fails: string[] = [];

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await app.inject({
    method: method as 'GET', url: `/v1${url}`,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: any = null;
  try { parsed = res.body ? JSON.parse(res.body) : null; } catch { parsed = res.body; }
  return { status: res.statusCode, body: parsed };
}

export const get = (url: string) => call('GET', url);
export const post = (url: string, body: unknown = {}) => call('POST', url, body, { 'idempotency-key': randomUUID() });
export const put = (url: string, body: unknown) => call('PUT', url, body, { 'idempotency-key': randomUUID() });
export const patch = (url: string, body: unknown, version: number) => call('PATCH', url, body, { 'if-match': `"${version}"` });

/** Exige éxito: si falla, deja claro qué paso fue. */
export async function must(label: string, r: Res | Promise<Res>): Promise<any> {
  const x = await r;
  if (x.status >= 400) throw new Error(`${label}: HTTP ${x.status} ${JSON.stringify(x.body).slice(0, 400)}`);
  return x.body;
}
/** Intenta; si falla lo anota y sigue (para pasos de relleno). */
export async function soft(label: string, r: Res | Promise<Res>): Promise<any | null> {
  const x = await r;
  if (x.status >= 400) { fails.push(`${label}: ${x.body?.error?.code ?? x.status} ${x.body?.error?.message ?? ''}`.trim()); return null; }
  return x.body;
}
/** Vista previa + confirmación (el patrón de EVA para lo que mueve dinero). */
export async function confirmed(label: string, previewUrl: string, createUrl: string, body: Record<string, unknown>, soft_ = false) {
  const pv = await post(previewUrl, body);
  if (pv.status >= 400 || !pv.body.previewToken) {
    if (soft_) { fails.push(`${label} (vista previa): ${pv.body?.error?.code ?? pv.status} ${pv.body?.error?.message ?? ''}`.trim()); return null; }
    throw new Error(`${label} (vista previa): HTTP ${pv.status} ${JSON.stringify(pv.body).slice(0, 400)}`);
  }
  const r = await post(createUrl, { ...body, previewToken: pv.body.previewToken });
  if (r.status >= 400) {
    if (soft_) { fails.push(`${label}: ${r.body?.error?.code ?? r.status} ${r.body?.error?.message ?? ''}`.trim()); return null; }
    throw new Error(`${label}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
  }
  return r.body;
}

// Azar repetible: la misma carga produce siempre los mismos datos.
let s = 20261029;
export const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
export const between = (a: number, b: number) => a + rnd() * (b - a);
export const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
export const chance = (p: number) => rnd() < p;
export const money = (n: number) => n.toFixed(2);

export const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const days = (from: string, to: string) => { const out: string[] = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };
export const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 = domingo
