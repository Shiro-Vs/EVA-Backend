import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as calendar from '../../application/calendarChanges.js';
import * as individual from '../../application/individual.js';
import * as price from '../../application/priceChange.js';
import * as subs from '../../application/subscriptions.js';
import { etag, ifMatch, parse, withCtx, withIdempotency, type HttpDeps } from '../context.js';
import * as s from '../schemas.js';

const idParam = z.object({ id: s.uuid });

export function subscriptionRoutes(app: FastifyInstance, deps: HttpDeps) {
  app.post('/subscriptions/preview', async (req) => {
    const body = parse(s.subscriptionPreview, req.body);
    return withCtx(deps, req, async (ctx) => subs.previewSubscription(ctx, body));
  });
  app.post('/subscriptions', async (req, reply) => {
    const body = parse(s.subscriptionCreate, req.body);
    return withIdempotency(deps, req, reply, 'POST /subscriptions', body, async (ctx) => ({ status: 201, body: await subs.createSubscription(ctx, body) }));
  });
  app.get('/subscriptions', async (req) => {
    const q = parse(s.listQuery, req.query);
    return { items: await withCtx(deps, req, (ctx) => subs.listSubscriptions(ctx, q.status)) };
  });
  app.get('/subscriptions/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const r = await withCtx(deps, req, (ctx) => subs.getSubscription(ctx, id));
    etag(reply, r.version);
    return r;
  });
  app.post('/subscriptions/:id/calendar-changes/preview', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.calendarChangeBody, req.body);
    return withCtx(deps, req, (ctx) => calendar.previewCalendarChange(ctx, id, body));
  });
  app.post('/subscriptions/:id/calendar-changes', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.calendarChangeCreate, req.body);
    return withIdempotency(deps, req, reply, `POST /subscriptions/${id}/calendar-changes`, body, async (ctx) => ({ status: 201, body: await calendar.applyCalendarChange(ctx, id, body) }));
  });
  app.get('/subscriptions/:id/calendar-changes', async (req) => {
    const { id } = parse(idParam, req.params);
    return { items: await withCtx(deps, req, (ctx) => calendar.listCalendarChanges(ctx, id)) };
  });
  app.post('/subscriptions/:id/switch-to-individual/preview', async (req) => {
    const { id } = parse(idParam, req.params);
    parse(s.exitPreviewBody, req.body);
    return withCtx(deps, req, (ctx) => individual.previewSwitchToIndividual(ctx, id));
  });
  app.post('/subscriptions/:id/switch-to-individual', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.exitCreate, req.body);
    return withIdempotency(deps, req, reply, `POST /subscriptions/${id}/switch-to-individual`, body, async (ctx) => ({ status: 200, body: await individual.switchToIndividual(ctx, id, body.reason, body.previewToken) }));
  });
  app.get('/subscriptions/:id/terms', async (req) => {
    const { id } = parse(idParam, req.params);
    return { items: await withCtx(deps, req, (ctx) => price.listTerms(ctx, id)) };
  });
  app.post('/subscriptions/:id/price-change/preview', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.priceChangeBody, req.body);
    return withCtx(deps, req, (ctx) => price.previewPriceChange(ctx, id, body));
  });
  app.post('/subscriptions/:id/price-change', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.priceChangeCreate, req.body);
    return withIdempotency(deps, req, reply, `POST /subscriptions/${id}/price-change`, body, async (ctx) => ({ status: 200, body: await price.applyPriceChange(ctx, id, body) }));
  });
  app.patch('/subscriptions/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.subscriptionPatch, req.body);
    const version = ifMatch(req);
    const r = await withCtx(deps, req, (ctx) => subs.patchSubscription(ctx, id, version, body));
    etag(reply, r.version);
    return r;
  });
  app.post('/subscriptions/:id/archive', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => subs.archiveSubscription(ctx, id));
  });
  app.post('/subscriptions/:id/restore', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => subs.restoreSubscription(ctx, id));
  });
  app.post('/subscriptions/:id/delete/preview', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => subs.previewDeleteSubscription(ctx, id));
  });
  app.post('/subscriptions/:id/delete', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.subscriptionDelete, req.body ?? {});
    return withCtx(deps, req, (ctx) => subs.deleteSubscription(ctx, id, body));
  });
  app.get('/subscriptions/:id/cycles', async (req) => {
    const { id } = parse(idParam, req.params);
    return { items: await withCtx(deps, req, (ctx) => subs.listCycles(ctx, id)) };
  });
  app.post('/subscriptions/:id/cycles/generate', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.generateBody, req.body);
    return withIdempotency(deps, req, reply, `POST /subscriptions/${id}/cycles/generate`, body, async (ctx) => ({ status: 200, body: await subs.generateAhead(ctx, id, body.ahead) }));
  });
}
