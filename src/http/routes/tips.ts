import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as tips from '../../application/tips.js';
import { parse, withCtx, type HttpDeps } from '../context.js';

const historyQuery = z.object({ days: z.coerce.number().int().min(1).max(60).default(14) });

/** Consejo del día con IA (D-70): uno por día, basado en tus propios datos; nunca modifica nada. */
export function tipRoutes(app: FastifyInstance, deps: HttpDeps) {
  const td = (): tips.TipDeps => ({ analyst: deps.analyst, dailyLimit: deps.capture.dailyLimit });
  app.get('/tips/today', async (req) => withCtx(deps, req, (ctx) => tips.todayTip(ctx, td())));
  app.get('/tips', async (req) => {
    const q = parse(historyQuery, req.query);
    return { items: await withCtx(deps, req, (ctx) => tips.tipHistory(ctx, q.days)) };
  });
}
