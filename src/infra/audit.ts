import { sql } from 'kysely';
import type { Trx } from './db/db.js';

export interface AuditInput {
  ownerId: string;
  actorId: string;
  action: string; // 'receipt.create', 'allocation.release', …
  entityType: string;
  entityId: string;
  reason?: string | null;
  changes?: Record<string, unknown> | null; // solo campos pertinentes; nunca secretos ni correos completos
}

export async function audit(trx: Trx, a: AuditInput): Promise<void> {
  await sql`
    insert into audit_event (owner_id, actor_id, action, entity_type, entity_id, reason, changes)
    values (${a.ownerId}, ${a.actorId}, ${a.action}, ${a.entityType}, ${a.entityId}, ${a.reason ?? null}, ${a.changes ? JSON.stringify(a.changes) : null}::jsonb)
  `.execute(trx);
}
