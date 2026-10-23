import { sql } from 'kysely';
import { formatISO } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { checkPreviewToken, makePreviewToken } from '../infra/preview.js';
import type { Ctx } from './context.js';
import { executeExit, exitPreviewState } from './exits.js';
import { ensureSubscription, getSubscription } from './subscriptions.js';
import { syncSubscription } from './sync.js';

const OPTS = { forceFinishCycle: true, trigger: 'individual_switch' } as const;

interface SeatPlan { seatId: string; json: Record<string, any>; fingerprint: unknown }

async function buildPlan(ctx: Ctx, subscriptionId: string) {
  const sub = await ensureSubscription(ctx, subscriptionId);
  if (sub.status === 'archived') throw unprocessable('SUBSCRIPTION_ARCHIVED', 'The subscription is archived');
  const det = await one<{ name: string; mode: string }>(ctx.trx, sql<{ name: string; mode: string }>`select name, mode from subscription where owner_id = ${ctx.ownerId} and id = ${subscriptionId}`);
  if (det!.mode === 'personal') throw unprocessable('SUBSCRIPTION_PERSONAL', 'The subscription is already individual');
  await syncSubscription(ctx, subscriptionId);

  const today = formatISO(ctx.today);
  const cycle = await one<{ id: string; end_date: string }>(ctx.trx, sql<{ id: string; end_date: string }>`
    select id, end_date from billing_cycle where owner_id = ${ctx.ownerId} and subscription_id = ${subscriptionId} and start_date <= ${today}::date and end_date > ${today}::date`);
  if (!cycle) throw unprocessable('NO_CURRENT_CYCLE', 'There is no current cycle (is the subscription suspended?)');

  // Plazas de terceros que siguen: las que ya tienen fecha de baja se despiden solas en su fecha.
  const seatIds = await rows<{ id: string }>(ctx.trx, sql<{ id: string }>`
    select s.id from seat s join membership m on m.id = s.membership_id and m.owner_id = s.owner_id
    where s.owner_id = ${ctx.ownerId} and s.subscription_id = ${subscriptionId} and s.end_date is null and not m.is_owner order by s.id`);
  const seats: SeatPlan[] = [];
  for (const { id } of seatIds) {
    const st = await exitPreviewState(ctx, id, OPTS);
    seats.push({ seatId: id, json: st.json, fingerprint: st.fingerprint });
  }
  return { name: det!.name, cycleEnd: cycle.end_date, seats };
}

const totals = (seats: SeatPlan[]) => {
  const sum = (f: (j: Record<string, any>) => string) => seats.reduce((a, s) => a + parseMoney(f(s.json)), 0n);
  return {
    voidedCharges: seats.reduce((a, s) => a + (s.json.voidedCharges as unknown[]).length, 0),
    refunds: formatMoney(sum((j) => j.refunds.total)),
    loan: formatMoney(sum((j) => j.loan?.total ?? '0.00')),
  };
};

const previewJson = (ctx: Ctx, subscriptionId: string, p: Awaited<ReturnType<typeof buildPlan>>) => ({
  subscription: { id: subscriptionId, name: p.name },
  requestedOn: formatISO(ctx.today),
  effectiveOn: p.cycleEnd, // el siguiente corte (RN-X08)
  modeAfter: 'personal' as const,
  seats: p.seats.map((s) => s.json),
  totals: totals(p.seats),
});

const inputsOf = (subscriptionId: string) => ({ subscriptionId });
const stateOf = (p: Awaited<ReturnType<typeof buildPlan>>) => ({ cycleEnd: p.cycleEnd, seats: p.seats.map((s) => [s.seatId, s.fingerprint]) });

export async function previewSwitchToIndividual(ctx: Ctx, subscriptionId: string) {
  const p = await buildPlan(ctx, subscriptionId);
  return { ...previewJson(ctx, subscriptionId, p), previewToken: makePreviewToken(ctx.previewSecret, { scope: 'subscription.switch_individual', ownerId: ctx.ownerId, inputs: inputsOf(subscriptionId), state: stateOf(p) }, ctx.nowMs) };
}

/**
 * Compartido → individual (RN-X08). Termina todas las plazas de terceros al final del ciclo en curso (con sus devoluciones y
 * préstamos) y deja el servicio como personal desde ya, para que nadie más ingrese. Todo en una transacción.
 */
export async function switchToIndividual(ctx: Ctx, subscriptionId: string, reason: string, previewToken: string) {
  const p = await buildPlan(ctx, subscriptionId);
  checkPreviewToken(ctx.previewSecret, previewToken, { scope: 'subscription.switch_individual', ownerId: ctx.ownerId, inputs: inputsOf(subscriptionId), state: stateOf(p) }, ctx.nowMs);
  const refundIds: string[] = [];
  const loanIds: string[] = [];
  for (const s of p.seats) {
    const r = await executeExit(ctx, s.seatId, reason, undefined, OPTS);
    refundIds.push(...r.refundIds);
    if (r.loanId) loanIds.push(r.loanId);
  }
  await sql`update subscription set mode = 'personal', capacity = 1 where owner_id = ${ctx.ownerId} and id = ${subscriptionId}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'subscription.switch_individual', entityType: 'subscription', entityId: subscriptionId, reason: reason.trim(),
    changes: { requestedOn: formatISO(ctx.today), effectiveOn: p.cycleEnd, seats: p.seats.length, refunds: refundIds.length, loans: loanIds.length } });
  return { ...previewJson(ctx, subscriptionId, p), refundIds, loanIds, subscription: await getSubscription(ctx, subscriptionId) };
}
