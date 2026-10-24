import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as cards from '../../application/cards.js';
import * as categories from '../../application/categories.js';
import * as classification from '../../application/classification.js';
import * as operations from '../../application/operations.js';
import { ifMatch, parse, withCtx, withIdempotency, type HttpDeps } from '../context.js';
import * as s from '../schemas.js';

const idParam = z.object({ id: s.uuid });

/** Finanzas personales (Entrega 3): categorías, reglas de clasificación y movimientos. */
export function financeRoutes(app: FastifyInstance, deps: HttpDeps) {
  // ---------- Movimientos ----------
  app.get('/operations', async (req) => {
    const q = parse(s.operationListQuery, req.query);
    return withCtx(deps, req, (ctx) => operations.listOperations(ctx, { ...q, offset: s.decodeCursor(q.cursor) }));
  });

  // ---------- Tarjeta de crédito ----------
  app.get('/accounts/:id/credit-details', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, async (ctx) => (await cards.getCreditDetails(ctx, id)) ?? { configured: false });
  });
  app.post('/accounts/:id/credit-details', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.creditDetails, req.body);
    return withCtx(deps, req, (ctx) => cards.putCreditDetails(ctx, id, body));
  });
  app.get('/accounts/:id/statements', async (req) => {
    const { id } = parse(idParam, req.params);
    return { items: await withCtx(deps, req, (ctx) => cards.listStatements(ctx, id)) };
  });
  app.post('/accounts/:id/statements', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.statementCreate, req.body);
    return withIdempotency(deps, req, reply, `POST /accounts/${id}/statements`, body, async (ctx) => ({ status: 201, body: await cards.createStatement(ctx, id, body) }));
  });
  app.get('/card-statements/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => cards.getStatement(ctx, id));
  });
  app.post('/card-statements/:id/void', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.reasonBody, req.body);
    return withCtx(deps, req, (ctx) => cards.voidStatement(ctx, id, body.reason));
  });
  app.post('/card-statements/:id/payments', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.statementPayment, req.body);
    return withIdempotency(deps, req, reply, `POST /card-statements/${id}/payments`, body, async (ctx) => ({ status: 201, body: await cards.linkPayment(ctx, id, body.operationId) }));
  });
  app.post('/card-statement-payments/:id/remove', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => cards.unlinkPayment(ctx, id));
  });
  app.post('/accounts/:id/installment-purchases', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.installmentPurchase, req.body);
    return withIdempotency(deps, req, reply, `POST /accounts/${id}/installment-purchases`, body, async (ctx) => ({ status: 201, body: await cards.createInstallmentPurchase(ctx, id, body) }));
  });
  app.get('/accounts/:id/installment-plans', async (req) => {
    const { id } = parse(idParam, req.params);
    return { items: await withCtx(deps, req, (ctx) => cards.listInstallmentPlans(ctx, id)) };
  });
  app.post('/installment-plans/:id/cancel', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => cards.cancelInstallmentPlan(ctx, id));
  });
  app.get('/cards/advisor', async (req) => {
    const q = parse(s.advisorQuery, req.query);
    return withCtx(deps, req, (ctx) => cards.advisor(ctx, q.date));
  });

  // ---------- Categorías ----------
  app.get('/categories', async (req) => {
    const q = parse(s.categoryListQuery, req.query);
    return { items: await withCtx(deps, req, (ctx) => categories.listCategories(ctx, q.status)) };
  });
  app.post('/categories', async (req, reply) => {
    const body = parse(s.categoryCreate, req.body);
    reply.code(201);
    return withCtx(deps, req, (ctx) => categories.createCategory(ctx, body));
  });
  app.patch('/categories/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.categoryPatch, req.body);
    const version = ifMatch(req);
    return withCtx(deps, req, (ctx) => categories.patchCategory(ctx, id, version, body));
  });
  app.post('/categories/:id/archive', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => categories.archiveCategory(ctx, id));
  });
  app.post('/categories/:id/restore', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => categories.restoreCategory(ctx, id));
  });

  // ---------- Reglas de clasificación ----------
  app.get('/classification-rules', async (req) => {
    const q = parse(s.ruleListQuery, req.query);
    return { items: await withCtx(deps, req, (ctx) => classification.listRules(ctx, q.status)) };
  });
  app.post('/classification-rules', async (req, reply) => {
    const body = parse(s.ruleCreate, req.body);
    reply.code(201);
    return withCtx(deps, req, (ctx) => classification.createRule(ctx, body));
  });
  app.patch('/classification-rules/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.rulePatch, req.body);
    const version = ifMatch(req);
    return withCtx(deps, req, (ctx) => classification.patchRule(ctx, id, version, body));
  });
  app.post('/classification-rules/:id/archive', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => classification.setRuleStatus(ctx, id, 'archived'));
  });
  app.post('/classification-rules/:id/restore', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => classification.setRuleStatus(ctx, id, 'active'));
  });
  app.post('/classification/suggest', async (req) => {
    const body = parse(s.classificationSuggest, req.body);
    return withCtx(deps, req, (ctx) => classification.suggest(ctx, body));
  });
  app.post('/classification/apply/preview', async (req) => {
    const body = parse(s.classificationApplyPreview, req.body);
    return withCtx(deps, req, (ctx) => classification.previewApply(ctx, body.from, body.to));
  });
  app.post('/classification/apply', async (req, reply) => {
    const body = parse(s.classificationApply, req.body);
    return withIdempotency(deps, req, reply, 'POST /classification/apply', body, async (ctx) => ({ status: 200, body: await classification.applyRules(ctx, body) }));
  });
}
