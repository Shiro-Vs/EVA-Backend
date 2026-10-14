import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';

export interface AppDeps {
  pool: pg.Pool;
  logLevel?: string;
}

/** Construye la API. La lógica de negocio vive en src/domain y src/application (entrega 1). */
export function buildApp({ pool, logLevel = 'info' }: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: logLevel },
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Request-Id', req.id);
  });

  // Formato de error uniforme (13 §3). No se filtran detalles internos.
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'unhandled');
    reply.status(status).send({
      error: {
        code: status === 500 ? 'INTERNAL_ERROR' : (err.code ?? 'MALFORMED_REQUEST'),
        message: status === 500 ? 'Internal error' : err.message,
        requestId: req.id,
      },
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

  return app;
}
