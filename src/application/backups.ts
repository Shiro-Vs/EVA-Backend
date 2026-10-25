import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { sql } from 'kysely';
import { todayIn } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import type { FileStore } from '../infra/capture/ports.js';
import { inTx, one, rows, type DB, type Trx } from '../infra/db/db.js';
import { checkPreviewToken, makePreviewToken } from '../infra/preview.js';
import { ts, type Ctx } from './context.js';
import { getPreferences } from './dashboard.js';

export interface BackupDeps { files: FileStore; key: Buffer | null }

export const BACKUP_FORMAT_VERSION = 1;
const MAGIC = Buffer.from('EVAENC1');
/** Datos que no entran en un respaldo: se conservan tal cual al restaurar (bitácora, claves de idempotencia, consumo de IA, informes guardados e historial de respaldos). */
const EXCLUDED = new Set(['audit_event', 'idempotency_record', 'usage_record', 'report_snapshot', 'backup']);
const q = (name: string) => sql.id(name);

// ───────────────────────── Catálogo de la base (el respaldo sigue al esquema, no al revés) ─────────────────────────

interface Catalog { order: string[]; columns: Map<string, string[]>; pk: Map<string, string[]>; selfRef: Map<string, { cols: string[]; refCols: string[] }>; latestMigration: string }

async function catalog(trx: Trx): Promise<Catalog> {
  const tables = (await rows<{ t: string }>(trx, sql`
    select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attname = 'owner_id' and not a.attisdropped
    where n.nspname = 'public' and c.relkind = 'r' order by 1`)).map((r) => r.t).filter((t) => !EXCLUDED.has(t) && t !== 'user_profile');
  const set = new Set(tables);
  const fks = await rows<{ child: string; parent: string; cols: string[]; refcols: string[] }>(trx, sql`
    select ch.relname as child, pa.relname as parent,
           array(select attname::text from pg_attribute where attrelid = c.conrelid and attnum = any(c.conkey) order by array_position(c.conkey, attnum)) as cols,
           array(select attname::text from pg_attribute where attrelid = c.confrelid and attnum = any(c.confkey) order by array_position(c.confkey, attnum)) as refcols
    from pg_constraint c join pg_class ch on ch.oid = c.conrelid join pg_class pa on pa.oid = c.confrelid where c.contype = 'f' and c.connamespace = 'public'::regnamespace`);
  const deps = new Map<string, Set<string>>(tables.map((t) => [t, new Set<string>()]));
  const selfRef = new Map<string, { cols: string[]; refCols: string[] }>();
  for (const f of fks) {
    if (!set.has(f.child) || !set.has(f.parent)) continue;
    if (f.child === f.parent) { selfRef.set(f.child, { cols: f.cols.filter((c) => c !== 'owner_id'), refCols: f.refcols.filter((c) => c !== 'owner_id') }); continue; }
    deps.get(f.child)!.add(f.parent);
  }
  const order: string[] = [];
  const left = new Set(tables);
  while (left.size > 0) {
    const ready = [...left].filter((t) => [...deps.get(t)!].every((p) => !left.has(p))).sort();
    if (ready.length === 0) throw unprocessable('BACKUP_SCHEMA_CYCLE', 'Hay dependencias circulares entre tablas: no se puede ordenar el respaldo');
    for (const t of ready) { order.push(t); left.delete(t); }
  }
  const columns = new Map<string, string[]>();
  for (const r of await rows<{ t: string; cols: string[] }>(trx, sql`select table_name::text as t, array_agg(column_name::text order by ordinal_position) as cols from information_schema.columns where table_schema = 'public' and is_generated = 'NEVER' and identity_generation is null group by 1`)) columns.set(r.t, r.cols);
  const pk = new Map<string, string[]>();
  for (const r of await rows<{ t: string; cols: string[] }>(trx, sql`
    select c.relname::text as t, array_agg(a.attname::text order by array_position(i.indkey::int[], a.attnum::int)) as cols from pg_index i join pg_class c on c.oid = i.indrelid
    join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey) where i.indisprimary and c.relnamespace = 'public'::regnamespace group by 1`)) pk.set(r.t, r.cols);
  const latest = await one<{ name: string }>(trx, sql<{ name: string }>`select name from schema_migration order by name desc limit 1`);
  return { order, columns, pk, selfRef, latestMigration: latest?.name ?? '' };
}

// ───────────────────────── Formato del archivo ─────────────────────────

interface Manifest {
  formatVersion: number; schemaVersion: string; ownerId: string; createdAt: string; kind: string; encrypted: boolean; dataHash: string;
  tables: Record<string, { rows: number; columns: string[] }>; balances: Record<string, string>;
}
interface Payload { userProfile: Record<string, unknown> | null; tables: Record<string, Array<Record<string, unknown>>> }
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

function seal(plain: Buffer, key: Buffer | null): Buffer {
  const gz = gzipSync(plain);
  if (!key) return gz;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(gz), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), enc]);
}

function unseal(bytes: Buffer, key: Buffer | null): { manifest: Manifest; dataJson: string } {
  let gz = bytes;
  if (bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    if (!key) throw unprocessable('BACKUP_KEY_REQUIRED', 'El respaldo está cifrado y este servidor no tiene la clave');
    try {
      const d = createDecipheriv('aes-256-gcm', key, bytes.subarray(MAGIC.length, MAGIC.length + 12));
      d.setAuthTag(bytes.subarray(MAGIC.length + 12, MAGIC.length + 28));
      gz = Buffer.concat([d.update(bytes.subarray(MAGIC.length + 28)), d.final()]);
    } catch { throw unprocessable('BACKUP_CORRUPT', 'El respaldo está dañado o la clave no corresponde'); }
  }
  let parsed: { manifest?: Manifest; data?: string };
  try { parsed = JSON.parse(gunzipSync(gz).toString('utf8')); } catch { throw unprocessable('BACKUP_CORRUPT', 'El archivo no es un respaldo válido'); }
  if (!parsed.manifest || typeof parsed.data !== 'string') throw unprocessable('BACKUP_CORRUPT', 'El archivo no es un respaldo válido');
  if (sha(parsed.data) !== parsed.manifest.dataHash) throw unprocessable('BACKUP_CORRUPT', 'La verificación de integridad falló: el respaldo fue alterado o está incompleto');
  return { manifest: parsed.manifest, dataJson: parsed.data };
}

// ───────────────────────── Crear ─────────────────────────

interface BackupRow { id: string; kind: string; format_version: number; schema_version: string; file_key: string; size_bytes: number; data_hash: string; encrypted: boolean; manifest: Manifest; note: string | null; created_at: unknown }
const bSel = sql`select id, kind, format_version, schema_version, file_key, size_bytes, data_hash, encrypted, manifest, note, created_at from backup`;
const bView = (b: BackupRow) => ({
  id: b.id, kind: b.kind, createdAt: ts(b.created_at), formatVersion: b.format_version, schemaVersion: b.schema_version, sizeBytes: b.size_bytes, hash: b.data_hash, encrypted: b.encrypted, note: b.note,
  tables: Object.fromEntries(Object.entries(b.manifest.tables).map(([k, v]) => [k, v.rows])), totalRows: Object.values(b.manifest.tables).reduce((s, v) => s + v.rows, 0), balances: b.manifest.balances,
});

async function currentBalances(trx: Trx, ownerId: string) {
  const r = await rows<{ account_id: string; b: string }>(trx, sql`select account_id, sum(amount) as b from account_entry where owner_id = ${ownerId} group by account_id having sum(amount) <> 0 order by account_id`);
  return Object.fromEntries(r.map((x) => [x.account_id, formatMoney(parseMoney(x.b, { allowNegative: true }))]));
}

export async function createBackup(ctx: Ctx, deps: BackupDeps, kind: 'manual' | 'auto' | 'recovery', note?: string) {
  const cat = await catalog(ctx.trx);
  const payload: Payload = { userProfile: null, tables: {} };
  const prof = await one<{ j: Record<string, unknown> }>(ctx.trx, sql<{ j: Record<string, unknown> }>`select to_jsonb(u) as j from user_profile u where id = ${ctx.ownerId}`);
  payload.userProfile = prof?.j ?? null;
  const tables: Manifest['tables'] = {};
  for (const t of cat.order) {
    const r = await one<{ j: Array<Record<string, unknown>> }>(ctx.trx, sql<{ j: Array<Record<string, unknown>> }>`select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) as j from ${q(t)} x where x.owner_id = ${ctx.ownerId}`);
    payload.tables[t] = r!.j;
    tables[t] = { rows: r!.j.length, columns: cat.columns.get(t) ?? [] };
  }
  const dataJson = JSON.stringify(payload);
  const manifest: Manifest = {
    formatVersion: BACKUP_FORMAT_VERSION, schemaVersion: cat.latestMigration, ownerId: ctx.ownerId, createdAt: new Date(ctx.nowMs).toISOString(), kind, encrypted: !!deps.key,
    dataHash: sha(dataJson), tables, balances: await currentBalances(ctx.trx, ctx.ownerId),
  };
  const bytes = seal(Buffer.from(JSON.stringify({ manifest, data: dataJson }), 'utf8'), deps.key);
  const id = randomUUID();
  const fileKey = `${ctx.ownerId}/backups/${id}`;
  await deps.files.put(fileKey, bytes);
  // El respaldo vigente no se da por bueno hasta releerlo y verificar su integridad (RN-BK04).
  try { unseal(await deps.files.get(fileKey), deps.key); } catch (e) { await deps.files.delete(fileKey); throw e; }
  const b = await one<BackupRow>(ctx.trx, sql<BackupRow>`
    insert into backup (id, owner_id, kind, format_version, schema_version, file_key, size_bytes, data_hash, encrypted, manifest, note, created_at)
    values (${id}, ${ctx.ownerId}, ${kind}, ${BACKUP_FORMAT_VERSION}, ${cat.latestMigration}, ${fileKey}, ${bytes.length}, ${manifest.dataHash}, ${!!deps.key}, ${JSON.stringify(manifest)}::jsonb, ${note?.trim() || null}, ${manifest.createdAt})
    returning id, kind, format_version, schema_version, file_key, size_bytes, data_hash, encrypted, manifest, note, created_at`);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'backup.create', entityType: 'backup', entityId: id, changes: { kind, rows: Object.values(tables).reduce((s, v) => s + v.rows, 0) } });
  return bView(b!);
}

/** Conserva solo las últimas `keep` copias automáticas; se llama DESPUÉS de verificar la nueva (RN-BK04). */
async function pruneAuto(ctx: Ctx, deps: BackupDeps, keep: number) {
  const old = await rows<{ id: string; file_key: string }>(ctx.trx, sql`select id, file_key from backup where owner_id = ${ctx.ownerId} and kind = 'auto' order by created_at desc, id desc offset ${keep}`);
  for (const b of old) { await deps.files.delete(b.file_key); await sql`delete from backup where owner_id = ${ctx.ownerId} and id = ${b.id}`.execute(ctx.trx); }
  return old.length;
}

export async function listBackups(ctx: Ctx) {
  return (await rows<BackupRow>(ctx.trx, sql<BackupRow>`${bSel} where owner_id = ${ctx.ownerId} order by created_at desc, id desc limit 100`)).map(bView);
}

async function loadBackup(ctx: Ctx, id: string) {
  const b = await one<BackupRow>(ctx.trx, sql<BackupRow>`${bSel} where owner_id = ${ctx.ownerId} and id = ${id}`);
  if (!b) throw notFound('Backup');
  return b;
}
export async function getBackup(ctx: Ctx, id: string) { return bView(await loadBackup(ctx, id)); }

export async function downloadBackup(ctx: Ctx, deps: BackupDeps, id: string) {
  const b = await loadBackup(ctx, id);
  return { bytes: await deps.files.get(b.file_key), filename: `eva-respaldo-${b.manifest.createdAt.slice(0, 10)}.eva-backup` };
}

export async function deleteBackup(ctx: Ctx, deps: BackupDeps, id: string) {
  const b = await loadBackup(ctx, id);
  await deps.files.delete(b.file_key);
  await sql`delete from backup where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'backup.delete', entityType: 'backup', entityId: id });
  return { id, deleted: true, note: 'Las copias antiguas de este archivo pueden persistir en respaldos del almacenamiento hasta que se roten (RN-BK10).' };
}

/** Registra un archivo de respaldo descargado antes (restauración manual). Debe ser del mismo propietario. */
export async function importBackup(ctx: Ctx, deps: BackupDeps, bytes: Buffer) {
  const cat = await catalog(ctx.trx);
  const { manifest } = unseal(bytes, deps.key);
  if (manifest.ownerId !== ctx.ownerId) throw unprocessable('BACKUP_OTHER_OWNER', 'Este respaldo pertenece a otro usuario');
  if (manifest.formatVersion > BACKUP_FORMAT_VERSION) throw unprocessable('BACKUP_NEWER_FORMAT', 'El respaldo se generó con una versión más nueva de EVA: actualiza la app');
  if (manifest.schemaVersion > cat.latestMigration) throw unprocessable('BACKUP_NEWER_SCHEMA', 'El respaldo viene de un esquema más nuevo que este servidor: actualiza el servidor antes de restaurarlo');
  const id = randomUUID();
  const fileKey = `${ctx.ownerId}/backups/${id}`;
  await deps.files.put(fileKey, bytes);
  const b = await one<BackupRow>(ctx.trx, sql<BackupRow>`
    insert into backup (id, owner_id, kind, format_version, schema_version, file_key, size_bytes, data_hash, encrypted, manifest, created_at)
    values (${id}, ${ctx.ownerId}, 'imported', ${manifest.formatVersion}, ${manifest.schemaVersion}, ${fileKey}, ${bytes.length}, ${manifest.dataHash}, ${manifest.encrypted}, ${JSON.stringify(manifest)}::jsonb, ${manifest.createdAt})
    returning id, kind, format_version, schema_version, file_key, size_bytes, data_hash, encrypted, manifest, note, created_at`);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'backup.import', entityType: 'backup', entityId: id });
  return bView(b!);
}

// ───────────────────────── Restaurar ─────────────────────────

export type RestoreMode = 'replace' | 'merge';
type Rows = Array<Record<string, unknown>>;

async function open(ctx: Ctx, deps: BackupDeps, id: string) {
  const b = await loadBackup(ctx, id);
  const { manifest, dataJson } = unseal(await deps.files.get(b.file_key), deps.key);
  const cat = await catalog(ctx.trx);
  if (manifest.ownerId !== ctx.ownerId) throw unprocessable('BACKUP_OTHER_OWNER', 'Este respaldo pertenece a otro usuario');
  if (manifest.formatVersion > BACKUP_FORMAT_VERSION) throw unprocessable('BACKUP_NEWER_FORMAT', 'El respaldo se generó con una versión más nueva de EVA');
  if (manifest.schemaVersion > cat.latestMigration) throw unprocessable('BACKUP_NEWER_SCHEMA', 'El respaldo viene de un esquema más nuevo que este servidor');
  return { b, manifest, payload: JSON.parse(dataJson) as Payload, cat };
}

/** Columnas del respaldo que todavía existen: un respaldo de un esquema anterior se migra al insertar (RN-BK09). */
const usableCols = (cat: Catalog, t: string, backupCols: string[]) => {
  const cur = new Set(cat.columns.get(t) ?? []);
  return backupCols.filter((c) => cur.has(c));
};

async function countExisting(ctx: Ctx, cat: Catalog, t: string, data: Rows) {
  const pk = cat.pk.get(t);
  if (!pk || data.length === 0) return { fresh: data.length, existing: 0 };
  const cond = sql.join(pk.map((c) => sql`y.${q(c)} = x.${q(c)}`), sql` and `);
  const r = await one<{ n: string }>(ctx.trx, sql<{ n: string }>`select count(*) as n from jsonb_populate_recordset(null::${q(t)}, ${JSON.stringify(data)}::jsonb) x where not exists (select 1 from ${q(t)} y where y.owner_id = ${ctx.ownerId} and ${cond})`);
  const fresh = Number(r?.n ?? 0);
  return { fresh, existing: data.length - fresh };
}

async function currentCounts(ctx: Ctx, cat: Catalog) {
  const out: Record<string, number> = {};
  for (const t of cat.order) out[t] = Number((await one<{ n: string }>(ctx.trx, sql<{ n: string }>`select count(*) as n from ${q(t)} where owner_id = ${ctx.ownerId}`))!.n);
  return out;
}

export async function previewRestore(ctx: Ctx, deps: BackupDeps, id: string, mode: RestoreMode) {
  const { b, manifest, payload, cat } = await open(ctx, deps, id);
  const now = await currentCounts(ctx, cat);
  const report: Array<{ table: string; inBackup: number; current: number; willAdd: number; alreadyThere: number; willRemove: number }> = [];
  const warnings: string[] = [];
  for (const t of cat.order) {
    const data = payload.tables[t] ?? [];
    const { fresh, existing } = mode === 'merge' ? await countExisting(ctx, cat, t, data) : { fresh: data.length, existing: 0 };
    report.push({ table: t, inBackup: data.length, current: now[t]!, willAdd: fresh, alreadyThere: existing, willRemove: mode === 'replace' ? now[t]! : 0 });
  }
  for (const t of Object.keys(payload.tables)) if (!cat.columns.has(t)) warnings.push(`La tabla «${t}» del respaldo ya no existe en este servidor y se omite.`);
  if (manifest.schemaVersion < cat.latestMigration) warnings.push('El respaldo viene de un esquema anterior: se migra al restaurar (lo que no existía queda con su valor por defecto).');
  if (mode === 'merge') warnings.push('Se incorporan solo los registros que faltan; los que ya existen se conservan como están, sin sobrescribir.');
  else warnings.push('Reemplazar sustituye todos tus datos actuales por los del respaldo. Antes se guarda una copia de recuperación.');
  warnings.push('Restaurar no crea ingresos ni gastos nuevos, no ejecuta pagos y no reactiva lo que estaba revertido en el respaldo. Los archivos originales no forman parte del respaldo.');
  const balances = manifest.balances;
  const token = makePreviewToken(ctx.previewSecret, { scope: 'backup.restore', ownerId: ctx.ownerId, inputs: { id, mode }, state: { hash: b.data_hash, now } }, ctx.nowMs);
  return {
    backup: bView(b), mode, valid: true, report, warnings, expectedBalances: balances, currentBalances: await currentBalances(ctx.trx, ctx.ownerId),
    recoveryCopy: true, previewToken: token,
  };
}

async function insertTable(ctx: Ctx, cat: Catalog, t: string, data: Rows, backupCols: string[]) {
  if (data.length === 0) return 0;
  const cols = usableCols(cat, t, backupCols);
  const colList = sql.join(cols.map((c) => q(c)));
  const selList = sql.join(cols.map((c) => sql`x.${q(c)}`));
  const self = cat.selfRef.get(t);
  if (!self || self.cols.length === 0) {
    const r = await sql`insert into ${q(t)} (${colList}) select ${selList} from jsonb_populate_recordset(null::${q(t)}, ${JSON.stringify(data)}::jsonb) x on conflict do nothing`.execute(ctx.trx);
    return Number(r.numAffectedRows ?? 0);
  }
  // Tablas que se refieren a sí mismas (categorías, reversiones…): primero las filas sin padre o con el padre ya insertado, y así en rondas.
  const sc = self.cols[0]!; const rc = self.refCols[0]!;
  let total = 0;
  for (let round = 0; round < 50; round++) {
    const r = await sql`
      insert into ${q(t)} (${colList}) select ${selList} from jsonb_populate_recordset(null::${q(t)}, ${JSON.stringify(data)}::jsonb) x
      where (x.${q(sc)} is null or exists (select 1 from ${q(t)} y where y.owner_id = ${ctx.ownerId} and y.${q(rc)} = x.${q(sc)})) on conflict do nothing`.execute(ctx.trx);
    const n = Number(r.numAffectedRows ?? 0);
    total += n;
    if (n === 0) break;
  }
  return total;
}

export async function restoreBackup(ctx: Ctx, deps: BackupDeps, id: string, mode: RestoreMode, previewToken: string) {
  const { b, manifest, payload, cat } = await open(ctx, deps, id);
  const now = await currentCounts(ctx, cat);
  checkPreviewToken(ctx.previewSecret, previewToken, { scope: 'backup.restore', ownerId: ctx.ownerId, inputs: { id, mode }, state: { hash: b.data_hash, now } }, ctx.nowMs);

  // Copia de recuperación previa: siempre, antes de tocar nada (RN-BK06).
  const recovery = await createBackup(ctx, deps, 'recovery', `Antes de restaurar el respaldo del ${manifest.createdAt.slice(0, 10)}`);
  const inserted: Record<string, number> = {};
  try {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`${ctx.ownerId}:restore`}, 0))`.execute(ctx.trx);
    if (mode === 'replace') await sql`alter table account_entry disable trigger account_entry_immutable`.execute(ctx.trx);
    if (mode === 'replace') {
      for (const t of [...cat.order].reverse()) await sql`delete from ${q(t)} where owner_id = ${ctx.ownerId}`.execute(ctx.trx);
      const p = payload.userProfile;
      if (p) {
        await sql`update user_profile set display_name = ${p.display_name as string}, timezone = ${p.timezone as string}, default_free_days = ${p.default_free_days as number}, exit_days_limit = ${(p.exit_days_limit ?? null) as number | null}, preferences = ${JSON.stringify(p.preferences ?? {})}::jsonb where id = ${ctx.ownerId}`.execute(ctx.trx);
      }
    }
    for (const t of cat.order) inserted[t] = await insertTable(ctx, cat, t, payload.tables[t] ?? [], manifest.tables[t]?.columns ?? Object.keys((payload.tables[t] ?? [])[0] ?? {}));
    // Primero se evalúan las comprobaciones diferidas (asientos de cada operación) y recién entonces se vuelve a proteger la tabla.
    await sql`set constraints all immediate`.execute(ctx.trx);
    if (mode === 'replace') await sql`alter table account_entry enable trigger account_entry_immutable`.execute(ctx.trx);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e && typeof e === 'object' && 'status' in e) throw e;
    throw unprocessable('RESTORE_FAILED', 'No se pudo restaurar: los datos del respaldo no son coherentes con este servidor. No se cambió nada.', { detail: msg.slice(0, 300) });
  }

  // Verificación: los saldos deben coincidir con los del respaldo (A26).
  let balancesMatch: boolean | null = null;
  if (mode === 'replace') {
    const after = await currentBalances(ctx.trx, ctx.ownerId);
    const a = JSON.stringify(Object.entries(after).sort()); const e = JSON.stringify(Object.entries(manifest.balances).sort());
    balancesMatch = a === e;
    if (!balancesMatch) throw unprocessable('RESTORE_MISMATCH', 'Tras restaurar, los saldos no coinciden con los del respaldo. No se cambió nada.');
  }
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'backup.restore', entityType: 'backup', entityId: id, changes: { mode, recoveryBackupId: recovery.id, rows: Object.values(inserted).reduce((s, n) => s + n, 0) } });
  return { restored: true, mode, backupId: id, recoveryBackupId: recovery.id, inserted, balancesMatch, note: 'Si algo no es lo esperado, restaura la copia de recuperación.' };
}

// ───────────────────────── Automáticos ─────────────────────────

const DUE_DAYS = { weekly: 7, monthly: 30 } as const;

/** Crea la copia automática de quien la tenga activada y ya le toque. Lo llama un trabajo programado, no un usuario. */
export async function runDueBackups(env: { db: DB; now: () => Date; timeZone: string; previewSecret: string; backup: BackupDeps; only?: string[] }) {
  const all = await rows<{ id: string }>(env.db, sql`select id from user_profile order by id`);
  const users = env.only ? all.filter((u) => env.only!.includes(u.id)) : all;
  const out: Array<{ ownerId: string; created: boolean; backupId?: string; pruned?: number; error?: string }> = [];
  for (const u of users) {
    try {
      const r = await inTx(env.db, async (trx) => {
        const ctx: Ctx = { trx, ownerId: u.id, actorId: u.id, today: todayIn(env.timeZone, env.now()), nowMs: env.now().getTime(), previewSecret: env.previewSecret };
        const prefs = (await getPreferences(ctx)).backup;
        if (prefs.frequency === 'off') return { created: false };
        const last = await one<{ created_at: Date }>(trx, sql<{ created_at: Date }>`select created_at from backup where owner_id = ${u.id} and kind = 'auto' order by created_at desc limit 1`);
        if (last && ctx.nowMs - new Date(last.created_at).getTime() < DUE_DAYS[prefs.frequency] * 86_400_000) return { created: false };
        const b = await createBackup(ctx, env.backup, 'auto');
        return { created: true, backupId: b.id, pruned: await pruneAuto(ctx, env.backup, prefs.keep) };
      });
      out.push({ ownerId: u.id, ...r });
    } catch (e) {
      out.push({ ownerId: u.id, created: false, error: e instanceof Error ? e.message.slice(0, 200) : 'error' });
    }
  }
  return out;
}

