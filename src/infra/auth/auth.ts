import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';
import type { Env } from '../../config/env.js';
import { AppError } from '../../http/errors.js';

export interface AuthUser {
  userId: string;
  email?: string;
  name?: string;
}

export interface Authenticator {
  verify(token: string): Promise<AuthUser>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unauthenticated = () => new AppError(401, 'UNAUTHENTICATED', 'Missing, expired or invalid token');

function toUser(payload: { sub?: string; email?: unknown; name?: unknown }): AuthUser {
  if (!payload.sub || !UUID_RE.test(payload.sub)) throw unauthenticated();
  return {
    userId: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    name: typeof payload.name === 'string' ? payload.name : undefined,
  };
}

/** Desarrollo y pruebas: JWT HS256 firmados con AUTH_DEV_SECRET (equivalente local a Supabase Auth). */
export function devAuthenticator(secret: string): Authenticator {
  const key = new TextEncoder().encode(secret);
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
        return toUser(payload);
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw unauthenticated();
      }
    },
  };
}

/** Staging/producción: verificación con las claves públicas (JWKS) del proveedor de identidad. */
export function jwksAuthenticator(jwksUrl: string, issuer: string): Authenticator {
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, jwks, { issuer });
        return toUser(payload);
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw unauthenticated();
      }
    },
  };
}

export function createAuthenticator(env: Env): Authenticator {
  return env.AUTH_MODE === 'dev' ? devAuthenticator(env.AUTH_DEV_SECRET!) : jwksAuthenticator(env.AUTH_JWKS_URL!, env.AUTH_ISSUER!);
}

/** Emite un token de desarrollo. Solo para pruebas y para trabajar en local; nunca en producción. */
export async function signDevToken(secret: string, user: { userId: string; email?: string; name?: string }, ttl = '12h') {
  return new SignJWT({ email: user.email, name: user.name })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.userId)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(new TextEncoder().encode(secret));
}
