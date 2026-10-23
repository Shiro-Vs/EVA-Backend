import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as loans from '../../application/loans.js';
import * as receipts from '../../application/receipts.js';
import * as refunds from '../../application/refunds.js';
import * as supplier from '../../application/supplier.js';
import { parse, withCtx, withIdempotency, type HttpDeps } from '../context.js';
import * as s from '../schemas.js';

const idParam = z.object({ id: s.uuid });


export function billingRoutes(app: FastifyInstance, deps: HttpDeps) {
  // ---------- Devoluciones (RN-X06) y préstamos (RN-X07) ----------
  app.get('/refunds', async (req) => {
    const q = parse(s.refundListQuery, req.query);
    return { items: await withCtx(deps, req, (ctx) => refunds.listRefunds(ctx, q.status, q.contactId)) };
  });
  app.post('/refunds', async (req, reply) => {
    const body = parse(s.refundCreate, req.body);
    return withIdempotency(deps, req, reply, 'POST /refunds', body, async (ctx) => ({ status: 201, body: await refunds.createRefund(ctx, body) }));
  });
  app.post('/refunds/:id/pay', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.refundPay, req.body);
    return withIdempotency(deps, req, reply, `POST /refunds/${id}/pay`, body, async (ctx) => ({ status: 200, body: await refunds.payRefund(ctx, id, body) }));
  });
  app.post('/refunds/:id/cancel', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.reasonBody, req.body);
    return withIdempotency(deps, req, reply, `POST /refunds/${id}/cancel`, body, async (ctx) => ({ status: 200, body: await refunds.cancelRefund(ctx, id, body.reason) }));
  });
  app.post('/contacts/:id/debt-conversion/preview', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.debtConversionPreview, req.body);
    return withCtx(deps, req, (ctx) => loans.previewDebtConversion(ctx, id, body.obligationIds));
  });
  app.post('/contacts/:id/debt-conversion', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.debtConversionCreate, req.body);
    return withIdempotency(deps, req, reply, `POST /contacts/${id}/debt-conversion`, body, async (ctx) => ({ status: 201, body: await loans.applyDebtConversion(ctx, id, body) }));
  });
  app.get('/loans', async (req) => {
    const q = parse(s.loanListQuery, req.query);
    return { items: await withCtx(deps, req, (ctx) => loans.listLoans(ctx, q.contactId)) };
  });
  app.get('/loans/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => loans.getLoan(ctx, id));
  });

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
