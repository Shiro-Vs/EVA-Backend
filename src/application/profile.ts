import { sql } from 'kysely';
import { AppError, conflict, notFound } from '../http/errors.js';
import { one, type Trx } from '../infra/db/db.js';
import type { AuthUser } from '../infra/auth/auth.js';
import { seedCategories } from './categories.js';
import { ts } from './context.js';

interface Row {
  id: string; display_name: string; email: string | null; timezone: string; currency: string;
  default_free_days: number; exit_days_limit: number | null; preferences: Record<string, unknown>; version: number; created_at: unknown;
}

export const mapProfile = (r: Row) => ({
  id: r.id,
  displayName: r.display_name,
  email: r.email,
  timezone: r.timezone,
  currency: r.currency,
  defaultFreeDays: r.default_free_days,
  exitDaysLimit: r.exit_days_limit,
  preferences: r.preferences,
  version: r.version,
  createdAt: ts(r.created_at),
});

/** Crea el perfil en el primer acceso (RN-SE). Idempotente. */
export async function ensureProfile(trx: Trx, user: AuthUser) {
  // Una cuenta eliminada no se vuelve a crear con un token que todavía no venció.
  if (await one(trx, sql`select 1 as x from deleted_user where id = ${user.userId}`)) throw new AppError(401, 'ACCOUNT_DELETED', 'This account was deleted');
  const name = user.name?.trim() || user.email?.split('@')[0] || 'Usuario';
  const created = await one<{ id: string }>(trx, sql<{ id: string }>`
    insert into user_profile (id, display_name, email) values (${user.userId}, ${name}, ${user.email ?? null})
    on conflict (id) do nothing returning id`);
  if (created) await seedCategories(trx, user.userId); // categorías sugeridas, editables y archivables (12 §11)
  const row = await one<Row>(trx, sql<Row>`select * from user_profile where id = ${user.userId}`);
  if (!row) throw notFound('Profile');
  return mapProfile(row);
}

export interface ProfilePatch {
  displayName?: string;
  defaultFreeDays?: number;
  exitDaysLimit?: number | null;
}

export async function patchProfile(trx: Trx, userId: string, version: number, p: ProfilePatch) {
  const cur = await one<Row>(trx, sql<Row>`select * from user_profile where id = ${userId} for update`);
  if (!cur) throw notFound('Profile');
  if (cur.version !== version) throw conflict('CONFLICT_VERSION', 'The profile was modified; reload and retry');
  const next = {
    display_name: p.displayName ?? cur.display_name,
    default_free_days: p.defaultFreeDays ?? cur.default_free_days,
    exit_days_limit: p.exitDaysLimit === undefined ? cur.exit_days_limit : p.exitDaysLimit,
  };
  const row = await one<Row>(trx, sql<Row>`
    update user_profile set display_name = ${next.display_name}, default_free_days = ${next.default_free_days}, exit_days_limit = ${next.exit_days_limit}
    where id = ${userId} returning *`);
  if (!row) throw new AppError(500, 'INTERNAL_ERROR', 'Update failed');
  return mapProfile(row);
}
