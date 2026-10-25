import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as reports from '../../application/reports.js';
import { monthlyPdf } from '../../infra/pdf/monthly.js';
import { parse, withCtx, type HttpDeps } from '../context.js';
import * as s from '../schemas.js';

const idParam = z.object({ id: s.uuid });

/** Resumen mensual vivo y versiones guardadas, y su PDF (08 §2). */
export function reportRoutes(app: FastifyInstance, deps: HttpDeps) {
  app.get('/reports/monthly', async (req) => {
    const q = parse(s.monthlyQuery, req.query);
    return withCtx(deps, req, (ctx) => reports.liveMonthly(ctx, q));
  });
  app.get('/reports/monthly/pdf', async (req, reply) => {
    const q = parse(s.monthlyQuery, req.query);
    const live = await withCtx(deps, req, (ctx) => reports.liveMonthly(ctx, q));
    const pdf = await monthlyPdf(live, { live: true, generatedAt: live.generatedAt, rulesVersion: live.rulesVersion });
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="resumen-${q.month}.pdf"`).header('cache-control', 'private, no-store').send(pdf);
  });
  app.post('/reports/monthly/snapshots', async (req, reply) => {
    const b = parse(s.monthlySave, req.body);
    const r = await withCtx(deps, req, (ctx) => reports.saveMonthly(ctx, b));
    return reply.status(r.unchanged ? 200 : 201).send(r);
  });
  app.get('/reports/monthly/snapshots', async (req) => {
    const q = parse(s.snapshotsQuery, req.query);
    return { items: await withCtx(deps, req, (ctx) => reports.listSnapshots(ctx, q.month)) };
  });
  app.get('/reports/snapshots/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => reports.getSnapshot(ctx, id));
  });
  app.get('/reports/snapshots/:id/pdf', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const snap = await withCtx(deps, req, (ctx) => reports.getSnapshot(ctx, id));
    const pdf = await monthlyPdf(snap.data, { live: false, version: snap.version, generatedAt: snap.generatedAt, rulesVersion: snap.rulesVersion });
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="resumen-${snap.period}-v${snap.version}.pdf"`).header('cache-control', 'private, no-store').send(pdf);
  });
}
