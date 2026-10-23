import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as courtesies from '../../application/courtesies.js';
import * as exits from '../../application/exits.js';
import * as quota from '../../application/quota.js';
import * as seats from '../../application/seats.js';
import { parse, withCtx, withIdempotency, type HttpDeps } from '../context.js';
import * as s from '../schemas.js';

const idParam = z.object({ id: s.uuid });


export function seatRoutes(app: FastifyInstance, deps: HttpDeps) {
  app.post('/subscriptions/:id/seats/preview', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.seatBody, req.body);
    return withCtx(deps, req, (ctx) => seats.previewSeat(ctx, id, body));
  });
  app.post('/subscriptions/:id/seats', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.seatCreate, req.body);
    return withIdempotency(deps, req, reply, `POST /subscriptions/${id}/seats`, body, async (ctx) => ({ status: 201, body: await seats.createSeat(ctx, id, body) }));
  });
  app.get('/subscriptions/:id/seats', async (req) => {
    const { id } = parse(idParam, req.params);
    return { items: await withCtx(deps, req, (ctx) => seats.listSeats(ctx, id)) };
  });
  app.get('/seats/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => seats.getSeat(ctx, id));
  });

  // Cortesías (RN-K01..K05)
  app.post('/seats/:id/courtesies/preview', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.courtesyBody, req.body);
    return withCtx(deps, req, (ctx) => courtesies.previewCourtesy(ctx, id, body));
  });
  app.post('/seats/:id/courtesies', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.courtesyBody, req.body);
    return withIdempotency(deps, req, reply, `POST /seats/${id}/courtesies`, body, async (ctx) => ({ status: 201, body: await courtesies.createCourtesy(ctx, id, body) }));
  });
  app.get('/seats/:id/courtesies', async (req) => {
    const { id } = parse(idParam, req.params);
    return { items: await withCtx(deps, req, (ctx) => courtesies.listCourtesies(ctx, id)) };
  });
  app.post('/courtesies/:id/end', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    return withIdempotency(deps, req, reply, `POST /courtesies/${id}/end`, {}, async (ctx) => ({ status: 200, body: await courtesies.endCourtesy(ctx, id) }));
  });

  // Bajas (RN-X01..X07)
  app.post('/seats/:id/exit/preview', async (req) => {
    const { id } = parse(idParam, req.params);
    parse(s.exitPreviewBody, req.body);
    return withCtx(deps, req, (ctx) => exits.previewExit(ctx, id));
  });
  app.post('/seats/:id/exit', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.exitCreate, req.body);
    return withIdempotency(deps, req, reply, `POST /seats/${id}/exit`, body, async (ctx) => ({ status: 200, body: await exits.executeExit(ctx, id, body.reason, body.previewToken) }));
  });

  // Cambio de cuota (RN-Q01..Q04)
  app.post('/seats/:id/quota-change/preview', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.quotaChangeBody, req.body);
    return withCtx(deps, req, (ctx) => quota.previewQuotaChange(ctx, id, body));
  });
  app.post('/seats/:id/quota-change', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.quotaChangeCreate, req.body);
    return withIdempotency(deps, req, reply, `POST /seats/${id}/quota-change`, body, async (ctx) => ({ status: 200, body: await quota.applyQuotaChange(ctx, id, body) }));
  });
}
