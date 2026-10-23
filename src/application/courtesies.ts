import { sql } from 'kysely';
import { formatISO } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { ts, type Ctx } from './context.js';
import { consumeCourtesy } from './courtesy-core.js';
import { syncSubscription } from './sync.js';

export interface CourtesyInput {
  kind: 'cycles' | 'until_date' | 'permanent';
  cycles?: number;
  untilDate?: string;
  reason: string;
}

interface SeatInfo { id: string; label: string; subscription_id: string; is_owner: boolean; end_date: string | null; contact_id: string | null; contact_name: string | null }

async function loadSeat(ctx: Ctx, seatId: string): Promise<SeatInfo> {
  const s = await one<SeatInfo>(ctx.trx, sql<SeatInfo>`
    select s.id, s.label, s.subscription_id, m.is_owner, s.end_date, m.contact_id, c.name as contact_name
    from seat s join membership m on m.id = s.membership_id and m.owner_id = s.owner_id
    left join contact c on c.id = m.contact_id and c.owner_id = m.owner_id
    where s.owner_id = ${ctx.ownerId} and s.id = ${seatId}`);
  if (!s) throw notFound('Seat');
  return s;
}

interface EmittedCharge { obligation_id: string; cycle_id: string; seq: number; start_date: string; end_date: string; quota: string; mode: string; applied: string; adjustments: string }

interface Plan {
  seat: SeatInfo; startsOn: string; input: CourtesyInput; covered: EmittedCharge[]; existingDebt: bigint;
}

/**
 * Plan de la cortesía. Decisión 1 (confirmada): rige desde el SIGUIENTE ciclo, para no tocar lo ya cobrado del ciclo en curso.
 * Un cargo ya emitido dentro de la ventana solo se exime si todavía no tiene cobros ni ajustes (RN-K04: nada se condona solo).
 */
async function buildPlan(ctx: Ctx, seatId: string, input: CourtesyInput): Promise<Plan> {
  const seat = await loadSeat(ctx, seatId);
  if (seat.is_owner) throw unprocessable('COURTESY_OWNER_SEAT', 'Your own seat never generates a charge, so it needs no courtesy');
  if (seat.end_date) throw unprocessable('SEAT_ENDED', 'The seat has already ended');
  await syncSubscription(ctx, seat.subscription_id);

  const active = await one(ctx.trx, sql`select 1 from courtesy where owner_id = ${ctx.ownerId} and seat_id = ${seatId} and status = 'active'
    and (kind <> 'until_date' or until_date >= ${formatISO(ctx.today)}::date)`);
  if (active) throw unprocessable('COURTESY_ALREADY_ACTIVE', 'The seat already has an active courtesy; end it first');

  const next = await one<{ start_date: string | null }>(ctx.trx, sql<{ start_date: string | null }>`
    select min(start_date) as start_date from billing_cycle where owner_id = ${ctx.ownerId} and subscription_id = ${seat.subscription_id} and start_date > ${formatISO(ctx.today)}::date`);
  if (!next?.start_date) throw unprocessable('NO_NEXT_CYCLE', 'There is no next cycle to start the courtesy from');
  const startsOn = next.start_date;
  if (input.kind === 'until_date' && input.untilDate! < startsOn) {
    throw unprocessable('COURTESY_UNTIL_BEFORE_START', 'The end date must not be before the next cycle', { startsOn });
  }

  const emitted = await rows<EmittedCharge>(ctx.trx, sql<EmittedCharge>`
    select b.obligation_id, c.id as cycle_id, c.seq, c.start_date, c.end_date, mc.quota_snapshot as quota, mc.mode,
           b.applied_total as applied, b.adjustments_total as adjustments
    from member_charge mc
    join v_obligation_balance b on b.obligation_id = mc.obligation_id
    join billing_cycle c on c.id = mc.cycle_id and c.owner_id = mc.owner_id
    where mc.owner_id = ${ctx.ownerId} and mc.seat_id = ${seatId} and mc.status = 'issued' and c.start_date >= ${startsOn}::date
    order by c.start_date`);
  let covered = emitted;
  if (input.kind === 'cycles') covered = emitted.slice(0, input.cycles);
  else if (input.kind === 'until_date') covered = emitted.filter((e) => e.start_date <= input.untilDate!);
  covered = covered.filter((e) => e.mode !== 'courtesy');

  const touched = covered.filter((e) => parseMoney(e.applied) > 0n || parseMoney(e.adjustments, { allowNegative: true }) !== 0n);
  if (touched.length > 0) {
    throw unprocessable('COURTESY_CHARGE_ALREADY_APPLIED', 'A charge in the courtesy period already has payments or adjustments and cannot be waived automatically', {
      charges: touched.map((t) => ({ obligationId: t.obligation_id, cycle: { start: t.start_date, end: t.end_date }, applied: formatMoney(parseMoney(t.applied)) })),
    });
  }

  // Deuda anterior de la plaza: la cortesía futura no la borra (RN-K04). Por ahora solo se puede mantener en el servicio.
  const debt = await one<{ pending: string }>(ctx.trx, sql<{ pending: string }>`
    select coalesce(sum(b.pending_amount), 0.00) as pending from member_charge mc
    join v_obligation_balance b on b.obligation_id = mc.obligation_id
    where mc.owner_id = ${ctx.ownerId} and mc.seat_id = ${seatId} and mc.status = 'issued'`);
  // Los cargos cubiertos no tienen cobros ni ajustes y se eximen por completo: su pendiente actual no cuenta como deuda anterior.
  const existingDebt = parseMoney(debt!.pending) - covered.reduce((a, c) => a + parseMoney(c.quota), 0n);
  return { seat, startsOn, input, covered, existingDebt: existingDebt < 0n ? 0n : existingDebt };
}

export async function previewCourtesy(ctx: Ctx, seatId: string, input: CourtesyInput) {
  const p = await buildPlan(ctx, seatId, input);
  return {
    seat: { id: p.seat.id, label: p.seat.label, contact: p.seat.contact_id ? { id: p.seat.contact_id, name: p.seat.contact_name } : null },
    kind: input.kind, cycles: input.kind === 'cycles' ? input.cycles : null, untilDate: input.kind === 'until_date' ? input.untilDate : null,
    startsOn: p.startsOn,
    waivedCharges: p.covered.map((c) => ({ obligationId: c.obligation_id, cycle: { id: c.cycle_id, seq: c.seq, start: c.start_date, end: c.end_date }, waived: formatMoney(parseMoney(c.quota)) })),
    existingDebt: formatMoney(p.existingDebt),
    debtPolicy: 'keep' as const,
    rule: 'RN-K01..K05',
  };
}

interface CourtesyDbRow {
  id: string; seat_id: string; kind: string; starts_on: string; until_date: string | null; cycles_total: number | null; cycles_used: number;
  reason: string; status: string; created_at: unknown; ended_at: unknown;
}

const view = (r: CourtesyDbRow, todayIso: string) => ({
  id: r.id, seatId: r.seat_id, kind: r.kind, startsOn: r.starts_on, untilDate: r.until_date, cyclesTotal: r.cycles_total, cyclesUsed: r.cycles_used,
  reason: r.reason,
  // Estado derivado: una cortesía "hasta una fecha" deja de estar vigente sola al pasar esa fecha.
  status: r.status === 'ended' || (r.kind === 'until_date' && r.until_date !== null && r.until_date < todayIso) ? 'ended' : 'active',
  createdAt: ts(r.created_at), endedAt: r.ended_at ? ts(r.ended_at) : null,
});

export async function createCourtesy(ctx: Ctx, seatId: string, input: CourtesyInput) {
  const p = await buildPlan(ctx, seatId, input);
  const c = await one<CourtesyDbRow>(ctx.trx, sql<CourtesyDbRow>`
    insert into courtesy (owner_id, seat_id, kind, starts_on, until_date, cycles_total, reason, created_by)
    values (${ctx.ownerId}, ${seatId}, ${input.kind}, ${p.startsOn}, ${input.kind === 'until_date' ? input.untilDate! : null},
            ${input.kind === 'cycles' ? input.cycles! : null}, ${input.reason.trim()}, ${ctx.actorId})
    returning *`);
  // Cargos ya emitidos dentro de la ventana (p. ej. ciclos emitidos por adelantado): exención igual al bruto (RN-K02).
  for (const e of p.covered) {
    await sql`
      update member_charge set exemption_amount = gross_amount, mode = 'courtesy',
        calc_snapshot = calc_snapshot || jsonb_build_object('courtesyId', ${c!.id}::text, 'waivedAfterIssue', true)
      where owner_id = ${ctx.ownerId} and obligation_id = ${e.obligation_id}`.execute(ctx.trx);
  }
  if (p.covered.length > 0) await consumeCourtesy(ctx, c!.id, p.covered.length);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'courtesy.create', entityType: 'seat', entityId: seatId,
    changes: { courtesyId: c!.id, kind: input.kind, startsOn: p.startsOn, waivedCharges: p.covered.length } });
  const fresh = await one<CourtesyDbRow>(ctx.trx, sql<CourtesyDbRow>`select * from courtesy where owner_id = ${ctx.ownerId} and id = ${c!.id}`);
  return view(fresh!, formatISO(ctx.today));
}

export async function listCourtesies(ctx: Ctx, seatId: string) {
  await loadSeat(ctx, seatId);
  const r = await rows<CourtesyDbRow>(ctx.trx, sql<CourtesyDbRow>`select * from courtesy where owner_id = ${ctx.ownerId} and seat_id = ${seatId} order by created_at desc, id`);
  return r.map((x) => view(x, formatISO(ctx.today)));
}

/** Termina la cortesía: los ciclos aún no emitidos vuelven a cobrarse; los ya eximidos conservan su exención. */
export async function endCourtesy(ctx: Ctx, id: string) {
  const c = await one<CourtesyDbRow>(ctx.trx, sql<CourtesyDbRow>`select * from courtesy where owner_id = ${ctx.ownerId} and id = ${id} for update`);
  if (!c) throw notFound('Courtesy');
  if (c.status !== 'active') throw unprocessable('COURTESY_NOT_ACTIVE', 'The courtesy has already ended');
  await sql`update courtesy set status = 'ended', ended_at = now() where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'courtesy.end', entityType: 'seat', entityId: c.seat_id, changes: { courtesyId: id } });
  const fresh = await one<CourtesyDbRow>(ctx.trx, sql<CourtesyDbRow>`select * from courtesy where owner_id = ${ctx.ownerId} and id = ${id}`);
  return view(fresh!, formatISO(ctx.today));
}
