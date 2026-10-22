import { sql } from 'kysely';
import { rows } from '../infra/db/db.js';
import { ensureCycles } from './subscriptions.js';
import { emitCharges } from './charges.js';
import type { Ctx } from './context.js';

/** Generación perezosa e idempotente de ciclos y cargos al consultar u operar (D-08). Serializada por la fila del servicio. */
export async function syncSubscription(ctx: Ctx, subscriptionId: string): Promise<void> {
  await ensureCycles(ctx, subscriptionId);
  await emitCharges(ctx, subscriptionId);
}

/**
 * Sincroniza todos los servicios activos del propietario (para lecturas que suman cargos de varios servicios).
 * Se recorren en orden de ID para que dos peticiones simultáneas nunca se bloqueen entre sí.
 */
export async function syncAllSubscriptions(ctx: Ctx): Promise<void> {
  const ids = await rows<{ id: string }>(ctx.trx, sql<{ id: string }>`select id from subscription where owner_id = ${ctx.ownerId} and status <> 'archived' order by id`);
  for (const { id } of ids) await syncSubscription(ctx, id);
}
