import { sql } from 'kysely';
import { one } from '../infra/db/db.js';
import type { Ctx } from './context.js';

export interface CourtesyRow {
  id: string; kind: 'cycles' | 'until_date' | 'permanent'; starts_on: string; until_date: string | null; cycles_total: number | null; cycles_used: number;
}

/**
 * Cortesía activa que cubre el ciclo que empieza en `cycleStartIso` (RN-K01). Bloquea la fila: dos emisiones
 * simultáneas no pueden gastar dos veces el mismo ciclo de una cortesía por número de ciclos.
 */
export async function coveringCourtesy(ctx: Ctx, seatId: string, cycleStartIso: string): Promise<CourtesyRow | undefined> {
  return one<CourtesyRow>(ctx.trx, sql<CourtesyRow>`
    select id, kind, starts_on, until_date, cycles_total, cycles_used from courtesy
    where owner_id = ${ctx.ownerId} and seat_id = ${seatId} and status = 'active' and starts_on <= ${cycleStartIso}::date
      and (kind = 'permanent'
           or (kind = 'until_date' and until_date >= ${cycleStartIso}::date)
           or (kind = 'cycles' and cycles_used < cycles_total))
    order by starts_on limit 1 for update`);
}

/** Cuenta un ciclo cubierto; una cortesía por número de ciclos termina sola al agotarlos. */
export async function consumeCourtesy(ctx: Ctx, courtesyId: string, cycles = 1): Promise<void> {
  await sql`
    update courtesy set cycles_used = cycles_used + ${cycles},
      status = case when kind = 'cycles' and cycles_used + ${cycles} >= cycles_total then 'ended' else status end,
      ended_at = case when kind = 'cycles' and cycles_used + ${cycles} >= cycles_total then now() else ended_at end
    where owner_id = ${ctx.ownerId} and id = ${courtesyId}`.execute(ctx.trx);
}
