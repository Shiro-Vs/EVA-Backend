import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as capture from '../../application/capture.js';
import { todayIn } from '../../domain/localDate.js';
import { inTx } from '../../infra/db/db.js';
import { AppError } from '../errors.js';
import { buildCtx, ifMatch, parse, withCtx, withIdempotency, type HttpDeps } from '../context.js';
import * as s from '../schemas.js';
import { htmlToText, verifySvix, type ReceivedEvent } from '../../infra/resend-inbound.js';

const idParam = z.object({ id: s.uuid });
const MIME_OF = { photo: 'image/jpeg', pdf: 'application/pdf', text: 'text/plain' } as const;
const ALLOWED = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf|text\/plain)$/i;

function decode(b64: string) {
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length === 0) throw new AppError(422, 'VALIDATION_ERROR', 'El archivo está vacío o no es base64 válido');
  return bytes;
}

/** Captura asistida (Entrega 4): la captura propone; el usuario confirma. */
export function captureRoutes(app: FastifyInstance, deps: HttpDeps) {
  const cd = (): capture.CaptureDeps => deps.capture;

  // ---------- Dirección de recepción ----------
  app.get('/capture/inbox-address', async (req) => withCtx(deps, req, (ctx) => capture.getInboxAddress(ctx, cd())));
  app.post('/capture/inbox-address/rotate', async (req) => withCtx(deps, req, (ctx) => capture.rotateInboxAddress(ctx, cd())));
  app.post('/capture/inbox-address/revoke', async (req) => withCtx(deps, req, (ctx) => capture.revokeInboxAddress(ctx)));

  // ---------- Documentos ----------
  app.post('/capture/documents', async (req, reply) => {
    const b = parse(s.captureDocumentCreate, req.body);
    const mime = b.mime ?? MIME_OF[b.origin];
    if (!ALLOWED.test(mime)) throw new AppError(422, 'UNSUPPORTED_MIME', 'Formato no admitido: usa imagen (JPG, PNG, WEBP, HEIC), PDF o texto');
    if (b.origin === 'photo' && !mime.startsWith('image/')) throw new AppError(422, 'UNSUPPORTED_MIME', 'Una foto debe ser una imagen');
    if (b.origin === 'pdf' && mime !== 'application/pdf') throw new AppError(422, 'UNSUPPORTED_MIME', 'Un PDF debe ser application/pdf');
    const bytes = b.contentBase64 ? decode(b.contentBase64) : null;
    const out = await withCtx(deps, req, (ctx) => capture.ingest(ctx, cd(), { origin: b.origin, mime, filename: b.filename, bytes, text: b.text, subject: b.subject, sender: b.sender }));
    return reply.status(out.duplicate ? 200 : 201).send(out);
  });
  app.get('/capture/documents', async (req) => {
    const q = parse(s.captureDocsQuery, req.query);
    return { items: await withCtx(deps, req, (ctx) => capture.listDocuments(ctx, q.status)) };
  });
  app.get('/capture/documents/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => capture.getDocument(ctx, id));
  });
  app.get('/capture/documents/:id/file', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const f = await withCtx(deps, req, (ctx) => capture.readFile(ctx, cd(), id));
    return reply.header('content-type', f.mime).header('cache-control', 'private, no-store').header('content-disposition', `inline; filename="${(f.filename ?? 'documento').replace(/[^\w.\- ]/g, '_')}"`).send(f.bytes);
  });
  app.post('/capture/documents/:id/retry', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => capture.retryDocument(ctx, cd(), id));
  });
  app.post('/capture/documents/:id/discard', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => capture.discardDocument(ctx, id));
  });
  app.post('/capture/documents/:id/delete-file', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => capture.deleteDocumentFile(ctx, cd(), id));
  });
  app.post('/capture/retention/purge', async (req) => {
    const b = parse(s.capturePurge, req.body ?? {});
    return withCtx(deps, req, (ctx) => capture.purgeExpired(ctx, cd(), b.olderThanDays));
  });

  // ---------- Propuestas ----------
  app.get('/capture/proposals', async (req) => {
    const q = parse(s.captureProposalsQuery, req.query);
    return { items: await withCtx(deps, req, (ctx) => capture.listProposals(ctx, q.status)) };
  });
  app.get('/capture/proposals/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const p = await withCtx(deps, req, (ctx) => capture.getProposal(ctx, id));
    return reply.header('ETag', `"${p.version}"`).send(p);
  });
  app.patch('/capture/proposals/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.proposalPatch, req.body);
    const version = ifMatch(req);
    const p = await withCtx(deps, req, (ctx) => capture.patchProposal(ctx, id, version, body));
    return reply.header('ETag', `"${p.version}"`).send(p);
  });
  app.post('/capture/proposals/:id/preview', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => capture.previewAccept(ctx, id));
  });
  app.post('/capture/proposals/:id/accept', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.proposalAccept, req.body);
    return withIdempotency(deps, req, reply, `POST /capture/proposals/${id}/accept`, body, async (ctx) => {
      const r = await capture.acceptProposal(ctx, id, body);
      return { status: r.alreadyAccepted ? 200 : 201, body: r };
    });
  });
  app.post('/capture/proposals/:id/link', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.proposalLink, req.body);
    return withCtx(deps, req, (ctx) => capture.linkProposal(ctx, id, body.operationId));
  });
  app.post('/capture/proposals/:id/discard', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => capture.discardProposal(ctx, id));
  });
  app.post('/capture/proposals/:id/undo', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(s.proposalUndo, req.body);
    return withCtx(deps, req, (ctx) => capture.undoProposal(ctx, id, body.reason));
  });
  // Lote: cada propuesta en su propia transacción; un fallo no rompe las demás (RN-CA07, D-15).
  app.post('/capture/proposals/accept-batch', async (req) => {
    const body = parse(s.proposalBatch, req.body);
    const user = req.user!;
    const accepted: unknown[] = [];
    const failed: Array<{ id: string; code: string; message: string; details?: unknown }> = [];
    for (const item of body.items) {
      try {
        const r = await inTx(deps.db, async (trx) => capture.acceptProposal(buildCtx(deps, user, trx), item.id, { previewToken: item.previewToken, acknowledgeDuplicates: item.acknowledgeDuplicates }));
        accepted.push({ id: item.id, operationId: r.operation.id, alreadyAccepted: r.alreadyAccepted });
      } catch (e) {
        if (e instanceof AppError) failed.push({ id: item.id, code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) });
        else throw e;
      }
    }
    return { accepted, failed, summary: { accepted: accepted.length, failed: failed.length } };
  });

  // ---------- Reglas por remitente y uso ----------
  app.get('/capture/sender-rules', async (req) => ({ items: await withCtx(deps, req, (ctx) => capture.listSenderRules(ctx)) }));
  app.post('/capture/sender-rules', async (req, reply) => {
    const body = parse(s.senderRuleCreate, req.body);
    reply.code(201);
    return withCtx(deps, req, (ctx) => capture.createSenderRule(ctx, body));
  });
  app.post('/capture/sender-rules/:id/archive', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => capture.archiveSenderRule(ctx, id));
  });
  app.get('/capture/usage', async (req) => withCtx(deps, req, (ctx) => capture.usageSummary(ctx, cd())));
}

interface InboundMail { to: string; from?: string; subject?: string; text?: string; messageId?: string; attachments?: Array<{ filename?: string; mime: string; contentBase64: string }> }

/** Procesa un correo ya normalizado: resuelve al dueño por la dirección de recepción y lo manda a la captura. Compartido por todos los proveedores. */
async function ingestInbound(deps: HttpDeps, b: InboundMail) {
  const out = await inTx(deps.db, async (trx) => {
    const ownerId = await capture.ownerOfAddress(trx, b.to);
    if (!ownerId) return null; // dirección desconocida o revocada: se descarta en silencio (no revela cuáles existen)
    const ctx = { trx, ownerId, actorId: ownerId, today: todayIn(deps.timeZone, deps.now()), nowMs: deps.now().getTime(), previewSecret: deps.previewSecret };
    const att = b.attachments?.find((a) => ALLOWED.test(a.mime) && !a.mime.startsWith('text/'));
    const bytes = att ? decode(att.contentBase64) : null;
    if (!bytes && !(b.text && b.text.trim())) return { accepted: false as const };
    const doc = await capture.ingest(ctx, deps.capture, { origin: 'email', mime: att?.mime ?? 'text/plain', filename: att?.filename, bytes, text: b.text, subject: b.subject, sender: b.from, messageId: b.messageId });
    return { accepted: true as const, documentId: doc.id, duplicate: doc.duplicate };
  });
  return out ?? { accepted: false as const };
}

/** «Yape <notificaciones@yape.pe>» → «notificaciones@yape.pe» (minúsculas). */
const addressOf = (v: string) => (/<([^>]+)>/.exec(v)?.[1] ?? v).trim().toLowerCase();

/**
 * Correo entrante (D-52): el proveedor de correo, cualquiera que sea, reenvía aquí un JSON normalizado.
 * No usa el token del usuario: se autentica con un secreto compartido y resuelve al propietario por la dirección de recepción.
 */
export function inboundRoutes(app: FastifyInstance, deps: HttpDeps) {
  app.post('/webhooks/email', async (req, reply) => {
    const secret = deps.capture.inboundSecret;
    if (!secret) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.id } });
    const given = Buffer.from(String(req.headers['x-inbound-secret'] ?? ''));
    const want = Buffer.from(secret);
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw new AppError(401, 'UNAUTHENTICATED', 'Invalid inbound secret');
    const b = parse(s.captureInboundEmail, req.body);
    const out = await ingestInbound(deps, b);
    return reply.status(202).send(out);
  });

  // Resend (Receiving): el aviso trae solo metadatos y va firmado (Svix); el contenido se pide a la API de Resend.
  // Se necesita el cuerpo CRUDO para comprobar la firma, por eso este parser solo vale dentro de esta ruta.
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    scope.post('/webhooks/resend', async (req, reply) => {
      const { secret, inbox } = deps.inbound;
      if (!secret || !inbox) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.id } });
      const raw = typeof req.body === 'string' ? req.body : '';
      const h = req.headers;
      const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
      if (!verifySvix({ secret, payload: raw, nowMs: deps.now().getTime(), headers: { id: one(h['svix-id']), timestamp: one(h['svix-timestamp']), signature: one(h['svix-signature']) } })) {
        throw new AppError(401, 'UNAUTHENTICATED', 'Invalid signature');
      }
      let ev: ReceivedEvent;
      try { ev = JSON.parse(raw) as ReceivedEvent; } catch { throw new AppError(400, 'MALFORMED_REQUEST', 'Invalid JSON'); }
      if (ev.type !== 'email.received' || !ev.data?.email_id) return reply.send({ ignored: true });

      // Los errores de Resend (red, 5xx) suben como 500: Resend reintenta el aviso, y la deduplicación evita documentos dobles.
      const mail = await inbox.getEmail(ev.data.email_id);
      const candidates = [...mail.to, ...(mail.receivedFor ?? []), ...(mail.cc ?? [])].map(addressOf).filter(Boolean);
      const to = await inTx(deps.db, async (trx) => {
        for (const c of candidates) if (await capture.ownerOfAddress(trx, c)) return c;
        return null;
      });
      if (!to) return reply.send({ accepted: false });

      let attachments: InboundMail['attachments'];
      const list = await inbox.listAttachments(mail.id);
      const pick = list.find((a) => ALLOWED.test(a.contentType) && !a.contentType.startsWith('text/') && a.size > 0 && a.size <= deps.capture.maxBytes && a.downloadUrl);
      if (pick) attachments = [{ filename: pick.filename, mime: pick.contentType, contentBase64: (await inbox.download(pick.downloadUrl, deps.capture.maxBytes)).toString('base64') }];
      const text = (mail.text?.trim() ? mail.text : htmlToText(mail.html ?? '')).slice(0, 200_000);
      const out = await ingestInbound(deps, { to, from: mail.fromHeader ?? mail.from, subject: mail.subject, text, messageId: mail.messageId, attachments });
      return reply.send(out);
    });
  });
}
