import { sql } from 'kysely';
import { conflict, notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows, type Trx } from '../infra/db/db.js';
import { ts, type Ctx } from './context.js';

/** Categorías sugeridas al crear el perfil (12 §11): editables y archivables, sin importar saldos ni historial. */
export const SUGGESTED_CATEGORIES = ['Servicios', 'Comida', 'Transporte', 'Tecnología', 'Salud', 'Ocio', 'Hogar', 'Otros', 'Minigastos'] as const;

export async function seedCategories(trx: Trx, ownerId: string) {
  for (const name of SUGGESTED_CATEGORIES) {
    await sql`insert into category (owner_id, name) values (${ownerId}, ${name}) on conflict do nothing`.execute(trx);
  }
}

interface Row { id: string; parent_id: string | null; name: string; icon: string | null; color: string | null; status: string; version: number; created_at: unknown }

const node = (r: Row) => ({ id: r.id, parentId: r.parent_id, name: r.name, icon: r.icon, color: r.color, status: r.status, version: r.version, createdAt: ts(r.created_at) });

/** Árbol de dos niveles (D-29): categoría → subcategorías. */
export async function listCategories(ctx: Ctx, status?: string) {
  const all = await rows<Row>(ctx.trx, status
    ? sql<Row>`select id, parent_id, name, icon, color, status, version, created_at from category where owner_id = ${ctx.ownerId} and status = ${status} order by lower(name)`
    : sql<Row>`select id, parent_id, name, icon, color, status, version, created_at from category where owner_id = ${ctx.ownerId} order by lower(name)`);
  const byParent = new Map<string, Row[]>();
  for (const r of all) if (r.parent_id) byParent.set(r.parent_id, [...(byParent.get(r.parent_id) ?? []), r]);
  const present = new Set(all.map((r) => r.id));
  // Una subcategoría cuyo padre no pasó el filtro (p. ej. padre archivado) se muestra como raíz para no perderla.
  return all.filter((r) => !r.parent_id || !present.has(r.parent_id)).map((r) => ({ ...node(r), children: (byParent.get(r.id) ?? []).map(node) }));
}

async function load(ctx: Ctx, id: string) {
  const c = await one<Row>(ctx.trx, sql<Row>`select id, parent_id, name, icon, color, status, version, created_at from category where owner_id = ${ctx.ownerId} and id = ${id} for update`);
  if (!c) throw notFound('Category');
  return c;
}

async function assertNameFree(ctx: Ctx, parentId: string | null, name: string, exceptId?: string) {
  const dup = await one(ctx.trx, sql`
    select 1 from category where owner_id = ${ctx.ownerId} and coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(${parentId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
      and lower(name) = lower(${name}) and (${exceptId ?? null}::uuid is null or id <> ${exceptId ?? null})`);
  if (dup) throw conflict('CATEGORY_NAME_EXISTS', 'Ya existe una categoría con ese nombre en este nivel');
}

export async function createCategory(ctx: Ctx, i: { name: string; parentId?: string | null; icon?: string | null; color?: string | null }) {
  const name = i.name.trim();
  if (i.parentId) {
    const p = await load(ctx, i.parentId);
    if (p.parent_id) throw unprocessable('CATEGORY_DEPTH_EXCEEDED', 'Solo hay dos niveles: categoría y subcategoría');
    if (p.status !== 'active') throw unprocessable('CATEGORY_ARCHIVED', 'La categoría padre está archivada');
  }
  await assertNameFree(ctx, i.parentId ?? null, name);
  const r = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into category (owner_id, parent_id, name, icon, color) values (${ctx.ownerId}, ${i.parentId ?? null}, ${name}, ${i.icon ?? null}, ${i.color ?? null}) returning id`);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'category.create', entityType: 'category', entityId: r!.id, changes: { name, parentId: i.parentId ?? null } });
  return getCategory(ctx, r!.id);
}

export async function getCategory(ctx: Ctx, id: string) {
  const c = await one<Row>(ctx.trx, sql<Row>`select id, parent_id, name, icon, color, status, version, created_at from category where owner_id = ${ctx.ownerId} and id = ${id}`);
  if (!c) throw notFound('Category');
  return node(c);
}

/** Renombrar no rompe el historial: todo se enlaza por id (RN-CL01). */
export async function patchCategory(ctx: Ctx, id: string, version: number, p: { name?: string; icon?: string | null; color?: string | null }) {
  const c = await load(ctx, id);
  if (c.version !== version) throw conflict('CONFLICT_VERSION', 'The category was modified; reload and retry');
  const name = p.name === undefined ? c.name : p.name.trim();
  if (name.toLowerCase() !== c.name.toLowerCase()) await assertNameFree(ctx, c.parent_id, name, id);
  await sql`
    update category set name = ${name}, icon = ${p.icon === undefined ? c.icon : p.icon}, color = ${p.color === undefined ? c.color : p.color}
    where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'category.update', entityType: 'category', entityId: id, changes: { before: c.name, after: name } });
  return getCategory(ctx, id);
}

/** Archivar conserva el historial; una categoría archivada ya no se ofrece para clasificar. Archivar una raíz archiva sus subcategorías. */
export async function archiveCategory(ctx: Ctx, id: string) {
  const c = await load(ctx, id);
  await sql`update category set status = 'archived' where owner_id = ${ctx.ownerId} and (id = ${id} or parent_id = ${id})`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'category.archive', entityType: 'category', entityId: id, changes: { name: c.name } });
  return getCategory(ctx, id);
}

export async function restoreCategory(ctx: Ctx, id: string) {
  const c = await load(ctx, id);
  if (c.parent_id) {
    const p = await load(ctx, c.parent_id);
    if (p.status !== 'active') throw unprocessable('CATEGORY_ARCHIVED', 'Restaura primero la categoría padre');
  }
  await sql`update category set status = 'active' where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'category.restore', entityType: 'category', entityId: id });
  return getCategory(ctx, id);
}

/** Dónde se usa una categoría: cuenta por tabla. Lo que tiene historial o configuración no se borra (se archiva). */
const USAGE: Array<[string, string]> = [
  ['financial_operation', 'movimientos'], ['operation_item', 'detalles de movimientos'], ['classification_rule', 'reglas'], ['classification_decision', 'clasificaciones registradas'],
  ['movement_proposal', 'propuestas de captura'], ['sender_rule', 'reglas por remitente'], ['subscription', 'servicios'], ['budget', 'presupuestos'], ['recurring_template', 'recurrentes'],
];

/** Elimina una categoría SOLO si no tiene subcategorías ni uso. Si no, explica por qué y sugiere archivarla. */
export async function deleteCategory(ctx: Ctx, id: string) {
  const c = await load(ctx, id);
  const kids = await one<{ n: string }>(ctx.trx, sql<{ n: string }>`select count(*) as n from category where owner_id = ${ctx.ownerId} and parent_id = ${id}`);
  if (Number(kids?.n ?? 0) > 0) throw conflict('CATEGORY_HAS_CHILDREN', 'Tiene subcategorías: elimínalas primero o archiva toda la categoría', { children: Number(kids!.n) });
  const usage: Record<string, number> = {};
  for (const [table, label] of USAGE) {
    const r = await one<{ n: string }>(ctx.trx, sql<{ n: string }>`select count(*) as n from ${sql.table(table)} where owner_id = ${ctx.ownerId} and category_id = ${id}`);
    if (Number(r?.n ?? 0) > 0) usage[label] = Number(r!.n);
  }
  if (Object.keys(usage).length > 0) throw conflict('CATEGORY_IN_USE', 'La categoría está en uso: no se puede eliminar sin romper tu historial. Puedes archivarla', { usage });
  await sql`delete from category where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'category.delete', entityType: 'category', entityId: id, changes: { name: c.name } });
  return { id, deleted: true };
}

/** La categoría debe existir, ser del usuario y estar activa para clasificar con ella. */
export async function assertActiveCategory(ctx: Ctx, id: string) {
  const c = await one<{ status: string }>(ctx.trx, sql<{ status: string }>`select status from category where owner_id = ${ctx.ownerId} and id = ${id}`);
  if (!c) throw notFound('Category');
  if (c.status !== 'active') throw unprocessable('CATEGORY_ARCHIVED', 'La categoría está archivada');
}
