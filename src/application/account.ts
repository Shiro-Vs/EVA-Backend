import { sql } from 'kysely';
import { unprocessable } from '../http/errors.js';
import type { FileStore } from '../infra/capture/ports.js';
import { inTx, one, rows, type DB } from '../infra/db/db.js';
import { checkPreviewToken, makePreviewToken } from '../infra/preview.js';
import { catalog } from './backups.js';
import type { Ctx } from './context.js';

export const DELETE_PHRASE = 'ELIMINAR MI CUENTA';
const q = (name: string) => sql.id(name);
/** Tablas con archivos privados del usuario (originales, respaldos, exportaciones). */
const FILE_TABLES = ['source_document', 'backup', 'export_job'] as const;

async function counts(ctx: Ctx) {
  const cat = await catalog(ctx.trx, true);
  const out: Record<string, number> = {};
  for (const t of cat.order) {
    const n = Number((await one<{ n: string }>(ctx.trx, sql<{ n: string }>`select count(*) as n from ${q(t)} where owner_id = ${ctx.ownerId}`))!.n);
    if (n > 0) out[t] = n;
  }
  return { cat, tables: out };
}

async function fileKeys(ctx: Ctx): Promise<string[]> {
  const keys: string[] = [];
  for (const t of FILE_TABLES) keys.push(...(await rows<{ k: string }>(ctx.trx, sql<{ k: string }>`select file_key as k from ${q(t)} where owner_id = ${ctx.ownerId} and file_key is not null`)).map((r) => r.k));
  return keys;
}

/** Qué se eliminará, sin eliminar nada. */
export async function previewDeletion(ctx: Ctx) {
  const { tables } = await counts(ctx);
  const keys = await fileKeys(ctx);
  const total = Object.values(tables).reduce((s, n) => s + n, 0);
  const token = makePreviewToken(ctx.previewSecret, { scope: 'account.delete', ownerId: ctx.ownerId, inputs: {}, state: { total } }, ctx.nowMs);
  return {
    tables, totalRows: total, files: keys.length, confirmPhrase: DELETE_PHRASE, previewToken: token,
    willDelete: ['Tus cuentas, movimientos, servicios, contactos, cobros, préstamos, presupuestos, metas y recurrentes', 'Propuestas de captura, documentos y sus archivos originales', 'Análisis y chats guardados', 'Respaldos y exportaciones (incluidos sus archivos)', 'Preferencias, bitácora de cambios y claves de operación'],
    warnings: [
      'Es definitivo: no se puede deshacer. Si quieres conservar algo, antes descarga un respaldo (se borrará también del servidor).',
      'Los datos de tus contactos son tuyos y se eliminan contigo; EVA no guarda copia.',
      'Copias antiguas del almacenamiento pueden persistir hasta que se roten (RN-AR06).',
    ],
  };
}

/**
 * Elimina TODOS los datos del usuario y su perfil. Las tablas inmutables (asientos, bitácora, informes) se desprotegen solo
 * dentro de esta transacción y se vuelven a proteger antes de confirmar. Queda únicamente el identificador, sin datos personales.
 */
export async function deleteAccount(ctx: Ctx, deps: { files: FileStore }, i: { previewToken: string; confirm: string }) {
  if (i.confirm.trim().toUpperCase() !== DELETE_PHRASE) throw unprocessable('CONFIRMATION_MISMATCH', `Escribe exactamente «${DELETE_PHRASE}» para confirmar`);
  const { cat, tables } = await counts(ctx);
  const total = Object.values(tables).reduce((s, n) => s + n, 0);
  checkPreviewToken(ctx.previewSecret, i.previewToken, { scope: 'account.delete', ownerId: ctx.ownerId, inputs: {}, state: { total } }, ctx.nowMs);

  await sql`select pg_advisory_xact_lock(hashtextextended(${`${ctx.ownerId}:delete`}, 0))`.execute(ctx.trx);
  const keys = await fileKeys(ctx);
  for (const k of keys) await deps.files.delete(k);

  const PROTECTED: Array<[string, string]> = [['account_entry', 'account_entry_immutable'], ['audit_event', 'audit_event_immutable'], ['report_snapshot', 'report_snapshot_no_change']];
  for (const [t, trg] of PROTECTED) await sql`alter table ${q(t)} disable trigger ${q(trg)}`.execute(ctx.trx);
  for (const t of [...cat.order].reverse()) await sql`delete from ${q(t)} where owner_id = ${ctx.ownerId}`.execute(ctx.trx);
  await sql`delete from user_profile where id = ${ctx.ownerId}`.execute(ctx.trx);
  await sql`insert into deleted_user (id, deleted_at) values (${ctx.ownerId}, ${new Date(ctx.nowMs).toISOString()}) on conflict do nothing`.execute(ctx.trx);
  await sql`set constraints all immediate`.execute(ctx.trx);
  for (const [t, trg] of PROTECTED) await sql`alter table ${q(t)} enable trigger ${q(trg)}`.execute(ctx.trx);
  return { deleted: true, rows: total, files: keys.length };
}

/** El identificador de una cuenta eliminada se conserva unos días (lo que dura un token) y luego se borra. */
export async function purgeDeletedUsers(db: DB, now: Date, days = 7) {
  const r = await inTx(db, (trx) => rows<{ id: string }>(trx, sql<{ id: string }>`delete from deleted_user where deleted_at < ${new Date(now.getTime() - days * 86_400_000).toISOString()}::timestamptz returning id`));
  return r.length;
}
