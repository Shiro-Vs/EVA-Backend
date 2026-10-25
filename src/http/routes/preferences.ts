import type { FastifyInstance } from 'fastify';
import * as dash from '../../application/dashboard.js';
import { parse, withCtx, type HttpDeps } from '../context.js';
import * as s from '../schemas.js';

/** Preferencias, panel configurable y avisos (05 §8, 09 §7). */
export function preferenceRoutes(app: FastifyInstance, deps: HttpDeps) {
  app.get('/preferences', async (req) => withCtx(deps, req, (ctx) => dash.getPreferences(ctx)));
  app.put('/preferences', async (req) => {
    const b = parse(s.preferencesPatch, req.body);
    return withCtx(deps, req, (ctx) => dash.savePreferences(ctx, b));
  });
  app.get('/dashboard', async (req) => withCtx(deps, req, (ctx) => dash.dashboard(ctx)));
  app.get('/reminders', async (req) => {
    const q = parse(s.remindersQuery, req.query);
    return withCtx(deps, req, (ctx) => dash.reminders(ctx, q.days));
  });
}
