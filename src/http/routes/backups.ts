import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as backups from '../../application/backups.js';
import { purgeExpired } from '../../application/capture.js';
import { purgeDeletedUsers } from '../../application/account.js';
import { purgeExpiredExports } from '../../application/exports.js';
import { todayIn } from '../../domain/localDate.js';
import { inTx, rows } from '../../infra/db/db.js';
import { sql } from 'kysely';
import { AppError } from '../errors.js';
import { parse, withCtx, withIdempotency, type HttpDeps } from '../context.js';
import * as s from '../schemas.js';

const idParam = z.object({ id: s.uuid });

/** Respaldos recuperables y restauración con vista previa y copia de recuperación (09 §6). */
export function backupRoutes(app: FastifyInstance, deps: HttpDeps) {
  const bd = (): backups.BackupDeps => ({ files: deps.capture.files, key: deps.backup.key });

  app.post('/backups', async (req, reply) => {
    const b = parse(s.backupCreate, req.body ?? {});
    reply.code(201);
    return withCtx(deps, req, (ctx) => backups.createBackup(ctx, bd(), 'manual', b.note));
  });
  app.get('/backups', async (req) => ({ items: await withCtx(deps, req, (ctx) => backups.listBackups(ctx)) }));
  app.post('/backups/import', async (req, reply) => {
    const b = parse(s.backupImport, req.body);
    const bytes = Buffer.from(b.contentBase64, 'base64');
    if (bytes.length === 0) throw new AppError(422, 'VALIDATION_ERROR', 'El archivo está vacío o no es base64 válido');
    reply.code(201);
    return withCtx(deps, req, (ctx) => backups.importBackup(ctx, bd(), bytes));
  });
  app.get('/backups/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => backups.getBackup(ctx, id));
  });
  app.get('/backups/:id/download', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const f = await withCtx(deps, req, (ctx) => backups.downloadBackup(ctx, bd(), id));
    return reply.header('content-type', 'application/octet-stream').header('content-disposition', `attachment; filename="${f.filename}"`).header('cache-control', 'private, no-store').send(f.bytes);
  });
  app.post('/backups/:id/delete', async (req) => {
    const { id } = parse(idParam, req.params);
    return withCtx(deps, req, (ctx) => backups.deleteBackup(ctx, bd(), id));
  });
  app.post('/backups/:id/restore/preview', async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(s.restoreMode, req.body);
    return withCtx(deps, req, (ctx) => backups.previewRestore(ctx, bd(), id, b.mode));
  });
  app.post('/backups/:id/restore', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const b = parse(s.restoreConfirm, req.body);
    return withIdempotency(deps, req, reply, `POST /backups/${id}/restore`, b, async (ctx) => ({ status: 200, body: await backups.restoreBackup(ctx, bd(), id, b.mode, b.previewToken) }));
  });
}

/**
 * Trabajo diario (Railway cron u otro): crea las copias automáticas que toquen y elimina los originales de captura vencidos.
 * No usa token de usuario: se autentica con un secreto compartido y nunca ejecuta cobros ni pagos.
 */
export function jobRoutes(app: FastifyInstance, deps: HttpDeps) {
  app.post('/jobs/daily', async (req, reply) => {
    const secret = deps.cronSecret;
    if (!secret) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.id } });
    const given = Buffer.from(String(req.headers['x-cron-secret'] ?? ''));
    const want = Buffer.from(secret);
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw new AppError(401, 'UNAUTHENTICATED', 'Invalid cron secret');
    const bk = { files: deps.capture.files, key: deps.backup.key };
    const auto = await backups.runDueBackups({ db: deps.db, now: deps.now, timeZone: deps.timeZone, previewSecret: deps.previewSecret, backup: bk });
    const owners = await rows<{ owner_id: string }>(deps.db, sql`select distinct owner_id from source_document where file_key is not null`);
    let purged = 0;
    for (const o of owners) {
      purged += await inTx(deps.db, async (trx) => {
        const ctx = { trx, ownerId: o.owner_id, actorId: o.owner_id, today: todayIn(deps.timeZone, deps.now()), nowMs: deps.now().getTime(), previewSecret: deps.previewSecret };
        return (await purgeExpired(ctx, deps.capture, 90)).deleted;
      });
    }
    const exportsExpired = await purgeExpiredExports({ db: deps.db, now: deps.now, files: deps.capture.files });
    const tombstones = await purgeDeletedUsers(deps.db, deps.now());
    return reply.send({ backups: auto, originalsPurged: purged, exportsExpired, deletedAccountMarksCleared: tombstones });
  });
}
