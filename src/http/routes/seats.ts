import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
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
}
