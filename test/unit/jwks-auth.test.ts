import { randomUUID, webcrypto } from 'node:crypto';
type CryptoKey = webcrypto.CryptoKey;
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { buildApp } from '../../src/http/app.js';
import { jwksAuthenticator } from '../../src/infra/auth/auth.js';
import { pool } from '../helpers/db.js';

// Verifica el modo de producción (Supabase Auth) con un servidor de claves local: mismo contrato, sin depender de un proyecto real.
let server: Server;
let url: string;
let issuer: string;
let good: { privateKey: CryptoKey; kid: string };
let other: { privateKey: CryptoKey };

beforeAll(async () => {
  const g = await generateKeyPair('ES256');
  const jwk: JWK = { ...(await exportJWK(g.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  good = { privateKey: g.privateKey, kid: 'k1' };
  other = { privateKey: (await generateKeyPair('ES256')).privateKey };
  server = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}/auth/v1/.well-known/jwks.json`;
  issuer = `http://127.0.0.1:${port}/auth/v1`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

const sign = (claims: Record<string, unknown>, o: { key?: CryptoKey; kid?: string; iss?: string; aud?: string; exp?: string; alg?: string } = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg: (o.alg ?? 'ES256') as 'ES256', kid: o.kid ?? good.kid }).setIssuer(o.iss ?? issuer).setAudience(o.aud ?? 'authenticated')
    .setIssuedAt().setExpirationTime(o.exp ?? '1h').sign(o.key ?? good.privateKey);
const claims = (over: Record<string, unknown> = {}) => ({ sub: randomUUID(), role: 'authenticated', email: 'rosa@example.com', user_metadata: { full_name: 'Rosa Pérez' }, ...over });
const verify = (token: string, aud?: string) => jwksAuthenticator(url, issuer, aud).verify(token);

describe('Verificación de tokens de producción (Supabase Auth)', () => {
  it('acepta un token válido y toma el correo y el nombre de Google (user_metadata)', async () => {
    const c = claims();
    expect(await verify(await sign(c))).toEqual({ userId: c.sub, email: 'rosa@example.com', name: 'Rosa Pérez' });
  });

  it('rechaza lo que no sea de una persona autenticada de este proyecto', async () => {
    const cases: Array<[string, Promise<string>]> = [
      ['vencido', sign(claims(), { exp: '-1m' })],
      ['emisor distinto', sign(claims(), { iss: 'https://otro.example.com/auth/v1' })],
      ['audiencia distinta', sign(claims(), { aud: 'otra' })],
      ['firmado con otra clave', sign(claims(), { key: other.privateKey })],
      ['clave desconocida (kid)', sign(claims(), { kid: 'inventada' })],
      ['la clave pública «anon» del proyecto (rol anon)', sign({ role: 'anon' })],
      ['rol de servicio', sign(claims({ role: 'service_role' }))],
      ['sub que no es un UUID', sign(claims({ sub: 'admin' }))],
      ['sin sub', sign({ role: 'authenticated' })],
    ];
    for (const [name, token] of cases) {
      await expect(verify(await token), name).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    }
  });

  it('rechaza algoritmos no asimétricos: «none» y HS256 con material público (confusión de algoritmos)', async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims(), iss: issuer, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.`;
    await expect(verify(unsigned)).rejects.toMatchObject({ status: 401 });
    const hs = await new SignJWT(claims()).setProtectedHeader({ alg: 'HS256', kid: good.kid }).setIssuer(issuer).setAudience('authenticated').setExpirationTime('1h').sign(new TextEncoder().encode('secreto-cualquiera-de-32-caracteres!!'));
    await expect(verify(hs)).rejects.toMatchObject({ status: 401 });
    await expect(verify('no-es-un-jwt')).rejects.toMatchObject({ status: 401 });
    await expect(verify('')).rejects.toMatchObject({ status: 401 });
  });

  it('la audiencia es configurable', async () => {
    expect((await verify(await sign(claims(), { aud: 'eva' }), 'eva')).email).toBe('rosa@example.com');
    await expect(verify(await sign(claims(), { aud: 'eva' }))).rejects.toMatchObject({ status: 401 });
  });
});

describe('La API completa en modo producción (jwks)', () => {
  it('atiende a quien trae un token válido y crea su perfil con su nombre; rechaza al resto', async () => {
    const env = loadEnv({ DATABASE_URL: process.env.TEST_DATABASE_URL, AUTH_MODE: 'jwks', AUTH_JWKS_URL: url, AUTH_ISSUER: issuer, PREVIEW_SECRET: 'p'.repeat(40), LOG_LEVEL: 'silent' });
    const app = buildApp({ pool, env, logLevel: 'silent' });
    const c = claims({ sub: randomUUID() });
    const ok = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${await sign(c)}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: c.sub, displayName: 'Rosa Pérez' });
    expect((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${await sign(claims(), { aud: 'otra' })}` } })).statusCode).toBe(401);
    // En producción no existe el acceso de desarrollo.
    expect((await app.inject({ method: 'POST', url: '/dev/login' })).statusCode).toBe(404);
    await app.close();
  });
});
