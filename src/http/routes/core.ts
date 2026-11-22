import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as accounts from '../../application/accounts.js';
import * as contacts from '../../application/contacts.js';
import * as corrections from '../../application/corrections.js';
import * as operations from '../../application/operations.js';
import { contactStatement } from '../../application/statement.js';
import { summary } from '../../application/summary.js';
import { ensureProfile, patchProfile } from '../../application/profile.js';
import { etag, ifMatch, parse, withCtx, withIdempotency, type HttpDeps } from '../context.js';
import * as s from '../schemas.js';

const idParam = z.object({ id: s.uuid });

export function coreRoutes(app: FastifyInstance, deps: HttpDeps) {
  // ---------- Perfil ----------
  app.get('/me', async (req, reply) => {
    const p = await withCtx(deps, req, (ctx) => ensureProfile(ctx.trx, req.user!));
    etag(reply, p.version);
    return p;
  });
  app.patch('/me', async (req, reply) => {
    const body = parse(s.profilePatch, req.body);
    const version = ifMatch(req);
    const p = await withCtx(deps, req, async (ctx) => {
      await ensureProfile(ctx.trx, req.user!);
      return patchProfile(ctx.trx, ctx.ownerId, version, body);
    });
    etag(reply, p.version);
    return p;
  });

  app.get('/summary', async (req) => withCtx(deps, req, (ctx) => summary(ctx)));

  // ---------- Cuentas ----------
  app.get('/accounts', async (req) => {
    const q = parse(s.listQuery, req.query);
    return { items: await withCtx(deps, req, (ctx) => accounts.listAccounts(ctx, q.status)) };
  });
  app.post('/accounts', async (req, reply) => {
    const body = parse(s.accountCreate, req.body);
    return withIdempotency(deps, req, reply, 'POST /accounts', body, async (ctx) => ({ status: 201, body: await accounts.createAccount(ctx, body) }));
  });
  app.get('/accounts/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const a = await withCtx(deps, req, (ctx) => accounts.getAccount(ctx, id));
    etag(reply, a.version);
    return a;
  });
  app.patch('/accounts/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.accountPatch, req.body);
    const version = ifMatch(req);
    const a = await withCtx(deps, req, (ctx) => accounts.patchAccount(ctx, id, version, body));
    etag(reply, a.version);
    return a;
  });
  app.post('/accounts/:id/archive', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => accounts.archiveAccount(ctx, id));
  });
  app.post('/accounts/:id/restore', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => accounts.restoreAccount(ctx, id));
  });
  app.post('/accounts/:id/delete/preview', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => accounts.previewDeleteAccount(ctx, id));
  });
  app.post('/accounts/:id/delete', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = req.body ? parse(s.bankAccountDelete, req.body) : {};
    return withCtx(deps, req, (ctx) => accounts.deleteAccount(ctx, id, body));
  });
  app.get('/accounts/:id/entries', async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(s.listQuery, req.query);
    return withCtx(deps, req, (ctx) => accounts.listEntries(ctx, id, q.limit, s.decodeCursor(q.cursor)));
  });

  // ---------- Operaciones ----------
  app.post('/operations', async (req, reply) => {
    const body = parse(s.operationCreate, req.body);
    return withIdempotency(deps, req, reply, 'POST /operations', body, async (ctx) => ({ status: 201, body: await operations.createOperation(ctx, body) }));
  });
  app.get('/operations/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => operations.getOperation(ctx, id));
  });
  app.patch('/operations/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.operationPatch, req.body);
    const version = ifMatch(req);
    return withCtx(deps, req, (ctx) => corrections.patchOperation(ctx, id, version, body));
  });
  app.post('/operations/:id/correct/preview', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.operationCorrection, req.body);
    return withCtx(deps, req, (ctx) => corrections.previewOperationCorrection(ctx, id, body));
  });
  app.post('/operations/:id/correct', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.operationCorrectionCreate, req.body);
    return withIdempotency(deps, req, reply, `POST /operations/${id}/correct`, body, async (ctx) => ({ status: 201, body: await corrections.applyOperationCorrection(ctx, id, body) }));
  });
  app.post('/operations/:id/reverse', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.reverseBody, req.body);
    return withIdempotency(deps, req, reply, `POST /operations/${id}/reverse`, body, async (ctx) => ({ status: 201, body: await operations.reverseOperation(ctx, id, body.reason, body.date) }));
  });

  // ---------- Contactos ----------
  app.get('/contacts', async (req) => {
    const q = parse(s.listQuery, req.query);
    return { items: await withCtx(deps, req, (ctx) => contacts.listContacts(ctx, q.status)) };
  });
  app.post('/contacts', async (req, reply) => {
    const body = parse(s.contactCreate, req.body);
    const c = await withCtx(deps, req, (ctx) => contacts.createContact(ctx, body));
    etag(reply, c.version);
    return reply.status(201).send(c);
  });
  app.get('/contacts/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const c = await withCtx(deps, req, (ctx) => contacts.getContact(ctx, id));
    etag(reply, c.version);
    return c;
  });
  app.patch('/contacts/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.contactPatch, req.body);
    const version = ifMatch(req);
    const c = await withCtx(deps, req, (ctx) => contacts.patchContact(ctx, id, version, body as Partial<contacts.ContactInput>));
    etag(reply, c.version);
    return c;
  });
  app.get('/contacts/:id/statement', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => contactStatement(ctx, id));
  });
  app.post('/contacts/:id/archive', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => contacts.archiveContact(ctx, id));
  });
  app.post('/contacts/:id/restore', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => contacts.restoreContact(ctx, id));
  });
  app.post('/contacts/:id/delete', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => contacts.deleteContact(ctx, id));
  });
}
