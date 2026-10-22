import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as receipts from '../../application/receipts.js';
import * as supplier from '../../application/supplier.js';
import { parse, withCtx, withIdempotency, type HttpDeps } from '../context.js';
import * as s from '../schemas.js';

const idParam = z.object({ id: s.uuid });


export function billingRoutes(app: FastifyInstance, deps: HttpDeps) {
  // ---------- Cobros ----------
  app.post('/receipts/preview', async (req) => {
    const body = parse(s.receiptBody, req.body);
    return withCtx(deps, req, (ctx) => receipts.previewReceipt(ctx, body));
  });
  app.post('/receipts', async (req, reply) => {
    const body = parse(s.receiptCreate, req.body);
    return withIdempotency(deps, req, reply, 'POST /receipts', body, async (ctx) => ({ status: 201, body: await receipts.createReceipt(ctx, body) }));
  });
  app.get('/receipts/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => receipts.getReceipt(ctx, id));
  });
  app.get('/contacts/:id/credit', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => receipts.contactCredit(ctx, id));
  });
  app.post('/credit-reservations/:id/move', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.moveBody, req.body);
    return withIdempotency(deps, req, reply, `POST /credit-reservations/${id}/move`, body, async (ctx) => ({ status: 200, body: await receipts.moveReservation(ctx, id, body.subscriptionId) }));
  });
  app.post('/allocations/:id/release', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.reasonBody, req.body);
    return withIdempotency(deps, req, reply, `POST /allocations/${id}/release`, body, async (ctx) => ({ status: 200, body: await receipts.releaseAllocation(ctx, id, body.reason) }));
  });

  // ---------- Pago al proveedor y costo ----------
  app.post('/billing-cycles/:id/supplier-payment', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.supplierBody, req.body);
    return withIdempotency(deps, req, reply, `POST /billing-cycles/${id}/supplier-payment`, body, async (ctx) => ({ status: 201, body: await supplier.registerSupplierPayment(ctx, id, body) }));
  });
  app.post('/supplier-payments/:id/reverse', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.reasonBody, req.body);
    return withIdempotency(deps, req, reply, `POST /supplier-payments/${id}/reverse`, body, async (ctx) => ({ status: 200, body: await supplier.reverseSupplierPayment(ctx, id, body.reason) }));
  });
  app.get('/billing-cycles/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => supplier.getCycleDetail(ctx, id));
  });
  app.get('/subscriptions/:id/cost-summary', async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ cycleId: s.uuid.optional() }), req.query);
    return withCtx(deps, req, (ctx) => supplier.subscriptionCost(ctx, id, q.cycleId));
  });
}
