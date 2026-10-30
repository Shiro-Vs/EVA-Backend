import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as exp from '../../application/exports.js';
import { parse, withCtx, withIdempotency, type HttpDeps } from '../context.js';
import * as s from '../schemas.js';

const idParam = z.object({ id: s.uuid });

/** Exportaciones con el contenido y el orden que elige el usuario: CSV, Excel y PDF (08 §5, §6). */
export function exportRoutes(app: FastifyInstance, deps: HttpDeps) {
  const ed = (): exp.ExportDeps => ({ files: deps.capture.files, syncMaxRows: deps.exports.syncMaxRows, ttlHours: deps.exports.ttlHours });

  app.post('/exports/preview', async (req) => {
    const b = parse(s.exportPreview, req.body);
    return withCtx(deps, req, (ctx) => exp.previewExport(ctx, ed(), b));
  });
  app.post('/exports', async (req, reply) => {
    const b = parse(s.exportRequest, req.body);
    const user = req.user!;
    let toRun: string | null = null;
    const res = await withIdempotency(deps, req, reply, 'POST /exports', b, async (ctx) => {
      const r = await exp.createExport(ctx, ed(), b);
      if (r.background) toRun = r.job.id;
      return { status: 201, body: r.job };
    });
    // Las grandes se generan DESPUÉS de confirmar el registro, sin bloquear la respuesta.
    if (toRun) {
      const id = toRun;
      setImmediate(() => { void exp.runExportJob({ db: deps.db, now: deps.now, timeZone: deps.timeZone, previewSecret: deps.previewSecret, deps: ed() }, user.userId, id); });
    }
    return res;
  });
  app.get('/exports', async (req) => ({ items: await withCtx(deps, req, (ctx) => exp.listExports(ctx)) }));
  app.get('/exports/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => exp.getExport(ctx, id));
  });
  app.get('/exports/:id/download', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const f = await withCtx(deps, req, (ctx) => exp.downloadExport(ctx, ed(), id));
    return reply.header('content-type', f.mime).header('content-disposition', `attachment; filename="${f.filename}"`).header('cache-control', 'private, no-store').send(f.bytes);
  });
}

