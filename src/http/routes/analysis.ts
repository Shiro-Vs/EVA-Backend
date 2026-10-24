import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as analysis from '../../application/analysis.js';
import { parse, withCtx, type HttpDeps } from '../context.js';
import * as s from '../schemas.js';

const idParam = z.object({ id: s.uuid });

/** Análisis y chat con IA (Entrega 4, 07 §9): la IA explica datos que calcula el servidor; nunca modifica nada. */
export function analysisRoutes(app: FastifyInstance, deps: HttpDeps) {
  const ad = (): analysis.AnalysisDeps => ({ analyst: deps.analyst, dailyLimit: deps.capture.dailyLimit });

  app.post('/analysis/context', async (req) => {
    const b = parse(s.analysisContext, req.body);
    return withCtx(deps, req, (ctx) => analysis.previewContext(ctx, b.scope));
  });
  app.post('/analysis', async (req, reply) => {
    const b = parse(s.analysisRun, req.body);
    reply.code(201);
    return withCtx(deps, req, (ctx) => analysis.analyze(ctx, ad(), b));
  });
  app.get('/analysis', async (req) => ({ items: await withCtx(deps, req, (ctx) => analysis.listAnalyses(ctx)) }));

  // Chats (rutas fijas antes que /analysis/:id)
  app.post('/analysis/chats', async (req, reply) => {
    const b = parse(s.chatCreate, req.body);
    reply.code(201);
    return withCtx(deps, req, (ctx) => analysis.createChat(ctx, b));
  });
  app.get('/analysis/chats', async (req) => ({ items: await withCtx(deps, req, (ctx) => analysis.listChats(ctx)) }));
  app.get('/analysis/chats/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => analysis.getChat(ctx, id));
  });
  app.post('/analysis/chats/:id/messages', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(s.chatMessage, req.body);
    return withCtx(deps, req, (ctx) => analysis.sendMessage(ctx, ad(), id, b));
  });
  app.post('/analysis/chats/:id/delete', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => analysis.deleteChat(ctx, id));
  });

  app.get('/analysis/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => analysis.getAnalysis(ctx, id));
  });
  app.post('/analysis/:id/delete', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => analysis.deleteAnalysis(ctx, id));
  });
}
