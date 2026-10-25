import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Env } from '../config/env.js';
import { createAuthenticator, signDevToken, type Authenticator } from '../infra/auth/auth.js';
import { createGeminiAnalyst, createLocalAnalyst, createUnavailableAnalyst } from '../infra/capture/analyst.js';
import { createDiskStore } from '../infra/capture/files.js';
import { createGeminiExtractor } from '../infra/capture/gemini.js';
import { createHeuristicExtractor, createUnavailableExtractor } from '../infra/capture/heuristic.js';
import type { Analyst, Extractor, FileStore } from '../infra/capture/ports.js';
import { createKysely } from '../infra/db/db.js';
import { bearer, type HttpDeps } from './context.js';
import { AppError, fromDatabase } from './errors.js';
import { billingRoutes } from './routes/billing.js';
import { analysisRoutes } from './routes/analysis.js';
import { bankLoanRoutes } from './routes/bankLoans.js';
import { backupRoutes, jobRoutes } from './routes/backups.js';
import { preferenceRoutes } from './routes/preferences.js';
import { reportRoutes } from './routes/reports.js';
import { captureRoutes, inboundRoutes } from './routes/capture.js';
import { coreRoutes } from './routes/core.js';
import { financeRoutes } from './routes/finance.js';
import { seatRoutes } from './routes/seats.js';
import { subscriptionRoutes } from './routes/subscriptions.js';

declare module 'fastify' {
  interface FastifyInstance {
    routeTable: Array<{ method: string; url: string }>;
  }
}

export interface AppDeps {
  pool: pg.Pool;
  env: Env;
  now?: () => Date; // reloj inyectable: ninguna regla lee la hora del sistema (14 §1)
  authenticator?: Authenticator;
  logLevel?: string;
  extractor?: Extractor; // inyectable en pruebas
  analyst?: Analyst;
  files?: FileStore;
}

/** Construye la API. La lógica de negocio vive en src/domain y src/application. */
export function buildApp({ pool, env, now = () => new Date(), authenticator, logLevel = env.LOG_LEVEL, extractor, files, analyst }: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: logLevel },
    bodyLimit: Math.ceil(env.CAPTURE_MAX_MB * 1.4 * 1048576) + 65536, // archivos en base64 (captura)
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
  });

  app.decorate('routeTable', []);
  app.addHook('onRoute', (r) => {
    for (const m of Array.isArray(r.method) ? r.method : [r.method]) app.routeTable.push({ method: m, url: r.url });
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Request-Id', req.id);
  });

  // CORS solo para orígenes explícitos (desarrollo web). La app nativa no lo necesita.
  const origins = new Set((env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean));
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin || !origins.has(origin)) return;
    reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin')
      .header('Access-Control-Expose-Headers', 'ETag, Idempotency-Replayed, X-Request-Id');
    if (req.method === 'OPTIONS') {
      return reply.status(204)
        .header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS')
        .header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, If-Match, X-Request-Id')
        .header('Access-Control-Max-Age', '600')
        .send();
    }
  });

  // Formato de error uniforme (13 §3). No se filtran detalles internos.
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    const mapped = err instanceof AppError ? err : fromDatabase(err);
    if (mapped) {
      return reply.status(mapped.status).send({ error: { code: mapped.code, message: mapped.message, ...(mapped.details ? { details: mapped.details } : {}), requestId: req.id } });
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'unhandled');
    return reply.status(status).send({
      error: { code: status === 500 ? 'INTERNAL_ERROR' : 'MALFORMED_REQUEST', message: status === 500 ? 'Internal error' : err.message, requestId: req.id },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.id } });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await pool.query('select 1');
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  // Acceso de desarrollo: SOLO existe con AUTH_MODE=dev y un usuario configurado. En staging/producción la ruta no se registra.
  if (env.AUTH_MODE === 'dev' && env.DEV_LOGIN_USER_ID && env.AUTH_DEV_SECRET) {
    const secret = env.AUTH_DEV_SECRET;
    const devUser = { userId: env.DEV_LOGIN_USER_ID, name: 'Yo (desarrollo)', email: 'dev@eva.local' };
    app.post('/dev/login', async () => ({ token: await signDevToken(secret, devUser, '30d'), user: { id: devUser.userId, name: devUser.name } }));
  }

  const auth = authenticator ?? createAuthenticator(env);
  const deps: HttpDeps = {
    db: createKysely(pool),
    auth,
    now,
    timeZone: env.TZ_DEFAULT,
    previewSecret: env.PREVIEW_SECRET ?? env.AUTH_DEV_SECRET ?? '',
    capture: {
      extractor: extractor ?? (env.EXTRACTOR === 'gemini' ? createGeminiExtractor({ apiKey: env.GEMINI_API_KEY!, model: env.GEMINI_MODEL! }) : env.EXTRACTOR === 'heuristic' ? createHeuristicExtractor() : createUnavailableExtractor()),
      files: files ?? createDiskStore(env.STORAGE_DIR),
      inboxDomain: env.INBOX_DOMAIN,
      dailyLimit: env.CAPTURE_DAILY_LIMIT,
      inboundSecret: env.INBOUND_SECRET,
      maxBytes: Math.floor(env.CAPTURE_MAX_MB * 1024 * 1024),
    },
    backup: { key: env.BACKUP_ENCRYPTION_KEY ? Buffer.from(env.BACKUP_ENCRYPTION_KEY, 'hex') : null },
    cronSecret: env.CRON_SECRET,
    analyst: analyst ?? (env.EXTRACTOR === 'gemini' ? createGeminiAnalyst({ apiKey: env.GEMINI_API_KEY!, model: env.GEMINI_ANALYSIS_MODEL ?? env.GEMINI_MODEL! }) : env.EXTRACTOR === 'heuristic' ? createLocalAnalyst() : createUnavailableAnalyst()),
  };

  inboundRoutes(app, deps);
  jobRoutes(app, deps);

  app.register(
    async (v1) => {
      // El propietario sale SIEMPRE del token (09 §2).
      v1.addHook('onRequest', async (req) => {
        req.user = await auth.verify(bearer(req));
      });
      coreRoutes(v1, deps);
      subscriptionRoutes(v1, deps);
      seatRoutes(v1, deps);
      billingRoutes(v1, deps);
      financeRoutes(v1, deps);
      captureRoutes(v1, deps);
      analysisRoutes(v1, deps);
      bankLoanRoutes(v1, deps);
      backupRoutes(v1, deps);
      reportRoutes(v1, deps);
      preferenceRoutes(v1, deps);
    },
    { prefix: '/v1' },
  );

  return app;
}
