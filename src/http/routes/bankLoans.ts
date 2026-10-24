import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as bank from '../../application/bankLoans.js';
import { ifMatch, parse, withCtx, withIdempotency, type HttpDeps } from '../context.js';
import * as s from '../schemas.js';

const idParam = z.object({ id: s.uuid });

/** Préstamos bancarios con documentos (06 §3): solo datos confirmados; nunca mora ni cálculo bancario por conjetura. */
export function bankLoanRoutes(app: FastifyInstance, deps: HttpDeps) {
  app.post('/bank-loans', async (req, reply) => {
    const b = parse(s.bankLoanCreate, req.body);
    reply.code(201);
    return withCtx(deps, req, (ctx) => bank.createBankLoan(ctx, b));
  });
  app.get('/bank-loans', async (req) => {
    const q = parse(s.bankLoanListQuery, req.query);
    return { items: await withCtx(deps, req, (ctx) => bank.listBankLoans(ctx, q.status)) };
  });
  app.get('/bank-loans/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const l = await withCtx(deps, req, (ctx) => bank.getBankLoan(ctx, id));
    return reply.header('ETag', `"${l.version}"`).send(l);
  });
  app.patch('/bank-loans/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const b = parse(s.bankLoanPatch, req.body);
    const version = ifMatch(req);
    const l = await withCtx(deps, req, (ctx) => bank.patchBankLoan(ctx, id, version, b));
    return reply.header('ETag', `"${l.version}"`).send(l);
  });
  app.post('/bank-loans/:id/changes/preview', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(s.bankLoanChange, req.body);
    return withCtx(deps, req, (ctx) => bank.previewChange(ctx, id, b));
  });
  app.post('/bank-loans/:id/changes', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const b = parse(s.bankLoanChangeConfirm, req.body);
    return withIdempotency(deps, req, reply, `POST /bank-loans/${id}/changes`, b, async (ctx) => ({ status: 200, body: await bank.applyChange(ctx, id, b) }));
  });
  app.post('/bank-loans/:id/payments/preview', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(s.bankLoanPaymentPreview, req.body);
    return withCtx(deps, req, (ctx) => bank.previewPayment(ctx, id, b));
  });
  app.post('/bank-loans/:id/payments', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const b = parse(s.bankLoanPaymentCreate, req.body);
    return withIdempotency(deps, req, reply, `POST /bank-loans/${id}/payments`, b, async (ctx) => ({ status: 201, body: await bank.createPayment(ctx, id, b) }));
  });
  app.post('/bank-loans/payments/:id/reverse', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const b = parse(s.bankLoanPaymentReverse, req.body);
    return withIdempotency(deps, req, reply, `POST /bank-loans/payments/${id}/reverse`, b, async (ctx) => ({ status: 200, body: await bank.reversePayment(ctx, id, b.reason) }));
  });
}
