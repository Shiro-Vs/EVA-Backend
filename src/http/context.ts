import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import { ZodError } from 'zod';
import type { Ctx } from '../application/context.js';
import { ensureProfile } from '../application/profile.js';
import { todayIn } from '../domain/localDate.js';
import type { AuthUser, Authenticator } from '../infra/auth/auth.js';
import { inTx, type DB } from '../infra/db/db.js';
import { readKey, runIdempotent } from '../infra/idempotency.js';
import { AppError, fromZod } from './errors.js';

export interface HttpDeps {
  db: DB;
  auth: Authenticator;
  now: () => Date;
  timeZone: string;
  previewSecret: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export function bearer(req: FastifyRequest): string {
  const h = req.headers.authorization;
  if (!h || !/^Bearer\s+\S+$/i.test(h)) throw new AppError(401, 'UNAUTHENTICATED', 'Missing, expired or invalid token');
  return h.replace(/^Bearer\s+/i, '');
}

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  try {
    return schema.parse(data);
  } catch (e) {
    if (e instanceof ZodError) throw fromZod(e);
    throw e;
  }
}

/** `If-Match: "3"` → 3. Obligatorio en las modificaciones de recursos con versión (13 §1). */
export function ifMatch(req: FastifyRequest): number {
  const raw = req.headers['if-match'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) throw new AppError(428, 'PRECONDITION_REQUIRED', 'If-Match header with the resource version is required');
  const n = Number(v.replace(/"/g, '').replace(/^W\//, ''));
  if (!Number.isInteger(n) || n < 1) throw new AppError(400, 'MALFORMED_REQUEST', 'Invalid If-Match header');
  return n;
}

const buildCtx = (deps: HttpDeps, user: AuthUser, trx: Ctx['trx']): Ctx => ({
  trx,
  ownerId: user.userId,
  actorId: user.userId,
  today: todayIn(deps.timeZone, deps.now()),
  nowMs: deps.now().getTime(),
  previewSecret: deps.previewSecret,
});

/** Lectura o escritura sin idempotencia: una transacción con el perfil garantizado. */
export async function withCtx<T>(deps: HttpDeps, req: FastifyRequest, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const user = req.user!;
  return inTx(deps.db, async (trx) => {
    await ensureProfile(trx, user);
    return fn(buildCtx(deps, user, trx));
  });
}

/** Escritura con efectos financieros: exige Idempotency-Key y guarda la respuesta junto a los efectos. */
export async function withIdempotency(
  deps: HttpDeps, req: FastifyRequest, reply: FastifyReply, endpoint: string, body: unknown,
  fn: (ctx: Ctx) => Promise<{ status: number; body: unknown }>,
) {
  const user = req.user!;
  const key = readKey(req.headers['idempotency-key']);
  // El perfil debe existir antes de guardar el registro de idempotencia (FK).
  await inTx(deps.db, (trx) => ensureProfile(trx, user));
  const res = await runIdempotent(deps.db, { ownerId: user.userId, key, endpoint, request: body }, async (trx) => fn(buildCtx(deps, user, trx)));
  if (res.replayed) reply.header('Idempotency-Replayed', 'true');
  return reply.status(res.status).send(res.body);
}

export const etag = (reply: FastifyReply, version: number) => reply.header('ETag', `"${version}"`);
