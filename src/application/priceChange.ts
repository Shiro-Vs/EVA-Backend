import { sql } from 'kysely';
import { formatISO } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { suggestedQuota } from '../domain/proration.js';
import { unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { checkPreviewToken, makePreviewToken } from '../infra/preview.js';
import type { Ctx } from './context.js';
import { commitQuotaChange, quotaChangeState, type Plan as QuotaPlan, type QuotaChangeInput } from './quota.js';
import { ensureSubscription, getSubscription } from './subscriptions.js';
import { syncSubscription } from './sync.js';

export interface PriceChangeInput {
  newPrice: string;
  /** Inicio de un ciclo futuro (misma regla que el cambio de cuota, D-34). */
  effectiveFrom: string;
  mode: 'per_renewal' | 'lump';
  reason: string;
  /** Cuotas que el administrador CONFIRMA. Las plazas que no aparecen conservan su cuota (RN-Q03). */
  quotas?: Array<{ seatId: string; quota: string }>;
}

interface TermsRow { id: string; valid_from: string; valid_to: string | null; announced_price: string; interval_unit: string; interval_count: number; anchor_date: string }
interface SeatRow { id: string; label: string; contact_id: string; contact_name: string; quota: string | null; locked: boolean }

interface Plan {
  sub: { id: string; name: string };
  terms: TermsRow; allTerms: TermsRow[]; mode: 'insert' | 'update';
  oldPrice: bigint; newPrice: bigint;
  cycles: Array<{ id: string; seq: number; start_date: string; end_date: string }>;
  occupied: number; suggested: bigint;
  seats: SeatRow[];
  changes: Array<{ seat: SeatRow; input: QuotaChangeInput; plan: QuotaPlan; json: Record<string, any>; fingerprint: unknown }>;
}

async function buildPlan(ctx: Ctx, subscriptionId: string, i: PriceChangeInput): Promise<Plan> {
  const sub = await ensureSubscription(ctx, subscriptionId);
  if (sub.status === 'archived') throw unprocessable('SUBSCRIPTION_ARCHIVED', 'The subscription is archived');
  const named = await one<{ name: string }>(ctx.trx, sql<{ name: string }>`select name from subscription where owner_id = ${ctx.ownerId} and id = ${subscriptionId}`);
  await syncSubscription(ctx, subscriptionId);

  const today = formatISO(ctx.today);
  const E = i.effectiveFrom;
  if (E <= today) throw unprocessable('EFFECTIVE_DATE_PAST', 'The new price can only start at a future cycle', { today });
  const cycles = await rows<{ id: string; seq: number; start_date: string; end_date: string }>(ctx.trx, sql<{ id: string; seq: number; start_date: string; end_date: string }>`
    select id, seq, start_date, end_date from billing_cycle where owner_id = ${ctx.ownerId} and subscription_id = ${subscriptionId} and start_date > ${today}::date order by start_date`);
  if (!cycles.some((c) => c.start_date === E)) {
    throw unprocessable('EFFECTIVE_DATE_NOT_CYCLE_START', 'The new price can only start at the beginning of a cycle', { availableDates: cycles.map((c) => c.start_date) });
  }

  const allTerms = await rows<TermsRow>(ctx.trx, sql<TermsRow>`
    select id, valid_from, valid_to, announced_price, interval_unit, interval_count, anchor_date from subscription_terms
    where owner_id = ${ctx.ownerId} and subscription_id = ${subscriptionId} order by valid_from`);
  const terms = allTerms.find((t) => t.valid_to === null);
  if (!terms) throw unprocessable('CALENDAR_CHANGE_UNSUPPORTED', 'The subscription has no open terms');
  if (terms.valid_from > E) throw unprocessable('PRICE_CHANGE_EXISTS', 'There is already a change scheduled after that date');
  const mode = terms.valid_from === E ? 'update' : 'insert';
  const before = [...allTerms].reverse().find((t) => t.valid_from < E);
  const oldPrice = parseMoney((before ?? terms).announced_price);
  const newPrice = parseMoney(i.newPrice);
  if (newPrice <= 0n) throw unprocessable('VALIDATION_ERROR', 'The price must be positive');
  if (newPrice === parseMoney(terms.announced_price)) throw unprocessable('PRICE_UNCHANGED', 'The new price equals the current one');

  const affected = cycles.filter((c) => c.start_date >= E);
  const paid = await rows<{ cycle_id: string }>(ctx.trx, sql<{ cycle_id: string }>`
    select cycle_id from supplier_payment where owner_id = ${ctx.ownerId} and status = 'active' and cycle_id = any(${affected.map((c) => c.id)}::uuid[])`);
  if (paid.length > 0) {
    throw unprocessable('PRICE_CHANGE_BLOCKED', 'A cycle from that date on already has a payment to the provider at the old price; choose a later date', {
      cycles: affected.filter((c) => paid.some((p) => p.cycle_id === c.id)).map((c) => ({ seq: c.seq, start: c.start_date, end: c.end_date })),
    });
  }

  const occ = await one<{ n: string }>(ctx.trx, sql<{ n: string }>`
    select count(*) as n from seat where owner_id = ${ctx.ownerId} and subscription_id = ${subscriptionId} and start_date <= ${E}::date and (end_date is null or end_date > ${E}::date)`);
  const occupied = Math.max(1, Number(occ!.n));
  const seats = await rows<SeatRow>(ctx.trx, sql<SeatRow>`
    select s.id, s.label, m.contact_id, c.name as contact_name,
      (select st.quota from seat_terms st where st.seat_id = s.id and st.owner_id = s.owner_id and st.valid_from <= ${E}::date and (st.valid_to is null or st.valid_to > ${E}::date) limit 1) as quota,
      exists(select 1 from seat_terms st where st.seat_id = s.id and st.owner_id = s.owner_id and st.valid_from >= ${E}::date) as locked
    from seat s join membership m on m.id = s.membership_id and m.owner_id = s.owner_id
    left join contact c on c.id = m.contact_id and c.owner_id = m.owner_id
    where s.owner_id = ${ctx.ownerId} and s.subscription_id = ${subscriptionId} and not m.is_owner
      and s.start_date <= ${E}::date and (s.end_date is null or s.end_date > ${E}::date) order by s.created_at, s.id`);

  const changes: Plan['changes'] = [];
  for (const q of [...(i.quotas ?? [])].sort((a, b) => a.seatId.localeCompare(b.seatId))) {
    const seat = seats.find((x) => x.id === q.seatId);
    if (!seat) throw unprocessable('SEAT_NOT_IN_PROPOSAL', 'That seat is not an active third-party seat at the effective date', { seatId: q.seatId });
    if (seat.quota !== null && parseMoney(seat.quota) === parseMoney(q.quota)) continue; // sin cambio: conserva su cuota
    const input: QuotaChangeInput = { newQuota: q.quota, effectiveFrom: E, mode: i.mode, reason: i.reason };
    const st = await quotaChangeState(ctx, seat.id, input);
    changes.push({ seat, input, plan: st.plan, json: st.json, fingerprint: st.fingerprint });
  }
  return {
    sub: { id: subscriptionId, name: named!.name }, terms, allTerms, mode, oldPrice, newPrice, cycles: affected, occupied,
    suggested: suggestedQuota(newPrice, occupied), seats, changes,
  };
}

const normalizedQuotas = (i: PriceChangeInput) => [...(i.quotas ?? [])].map((q) => ({ seatId: q.seatId, quota: formatMoney(parseMoney(q.quota)) })).sort((a, b) => a.seatId.localeCompare(b.seatId));
const inputsOf = (subscriptionId: string, i: PriceChangeInput) => ({ subscriptionId, newPrice: formatMoney(parseMoney(i.newPrice)), effectiveFrom: i.effectiveFrom, mode: i.mode, quotas: normalizedQuotas(i) });
const stateOf = (p: Plan) => ({
  terms: p.allTerms.map((t) => `${t.id}:${t.valid_from}:${t.valid_to ?? ''}:${t.announced_price}`),
  cycles: p.cycles.map((c) => `${c.id}:${c.start_date}:${c.end_date}`),
  seats: p.seats.map((s) => [s.id, s.quota, s.locked]),
  changes: p.changes.map((c) => [c.seat.id, c.fingerprint]),
});

function previewJson(p: Plan, i: PriceChangeInput) {
  const m = (v: bigint) => formatMoney(v);
  const sum = (f: (j: Record<string, any>) => string) => p.changes.reduce((a, c) => a + parseMoney(f(c.json), { allowNegative: true }), 0n);
  return {
    subscription: p.sub,
    effectiveFrom: i.effectiveFrom, mode: i.mode, oldPrice: m(p.oldPrice), newPrice: m(p.newPrice),
    occupiedSeats: p.occupied,
    suggestedQuota: { amount: m(p.suggested), formula: `ceil(${m(p.newPrice)} / ${p.occupied})` },
    cyclesAffected: p.cycles.map((c) => ({ id: c.id, seq: c.seq, start: c.start_date, end: c.end_date })),
    seats: p.seats.map((s) => {
      const change = p.changes.find((c) => c.seat.id === s.id);
      return {
        seatId: s.id, label: s.label, contact: { id: s.contact_id, name: s.contact_name },
        currentQuota: s.quota === null ? null : m(parseMoney(s.quota)), proposedQuota: m(p.suggested), locked: s.locked,
        newQuota: change ? change.json.newQuota : null, change: change ? change.json : null,
      };
    }),
    totals: { adjustment: m(sum((j) => j.totals.adjustment)), creditFreed: m(sum((j) => j.totals.creditFreed)) },
    note: 'El precio del proveedor no cambia cuotas por sí solo: la propuesta se aplica únicamente a las plazas que confirmes en `quotas`.',
  };
}

export async function previewPriceChange(ctx: Ctx, subscriptionId: string, i: PriceChangeInput) {
  const p = await buildPlan(ctx, subscriptionId, i);
  return { ...previewJson(p, i), previewToken: makePreviewToken(ctx.previewSecret, { scope: 'subscription.price_change', ownerId: ctx.ownerId, inputs: inputsOf(subscriptionId, i), state: stateOf(p) }, ctx.nowMs) };
}

export async function applyPriceChange(ctx: Ctx, subscriptionId: string, body: PriceChangeInput & { previewToken: string }) {
  const { previewToken, ...i } = body;
  const p = await buildPlan(ctx, subscriptionId, i);
  checkPreviewToken(ctx.previewSecret, previewToken, { scope: 'subscription.price_change', ownerId: ctx.ownerId, inputs: inputsOf(subscriptionId, i), state: stateOf(p) }, ctx.nowMs);
  const E = i.effectiveFrom;
  const price = formatMoney(p.newPrice);
  const why = i.reason.trim();

  let termsId = p.terms.id;
  if (p.mode === 'update') {
    await sql`update subscription_terms set announced_price = ${price}, reason = ${why} where owner_id = ${ctx.ownerId} and id = ${p.terms.id}`.execute(ctx.trx);
  } else {
    await sql`update subscription_terms set valid_to = ${E}::date where owner_id = ${ctx.ownerId} and id = ${p.terms.id}`.execute(ctx.trx);
    const t = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
      insert into subscription_terms (owner_id, subscription_id, valid_from, announced_price, interval_unit, interval_count, anchor_date, reason, created_by)
      values (${ctx.ownerId}, ${subscriptionId}, ${E}, ${price}, ${p.terms.interval_unit}, ${p.terms.interval_count}, ${p.terms.anchor_date}, ${why}, ${ctx.actorId}) returning id`);
    termsId = t!.id;
  }
  // Los ciclos ya generados desde la fecha efectiva pasan a la versión nueva; los siguientes nacerán con ella.
  await sql`
    update billing_cycle set terms_id = ${termsId}, terms_snapshot = jsonb_set(terms_snapshot, '{announcedPrice}', to_jsonb(${price}::text))
    where owner_id = ${ctx.ownerId} and subscription_id = ${subscriptionId} and start_date >= ${E}::date`.execute(ctx.trx);

  let creditFreed = 0n;
  const applied: Array<{ seatId: string; adjustments: unknown[] }> = [];
  for (const c of p.changes) {
    const r = await commitQuotaChange(ctx, c.seat.id, c.input, c.plan);
    creditFreed += r.creditFreed;
    applied.push({ seatId: c.seat.id, adjustments: r.adjustments });
  }
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'subscription.price_change', entityType: 'subscription', entityId: subscriptionId, reason: why,
    changes: { from: formatMoney(p.oldPrice), to: price, effectiveFrom: E, mode: i.mode, quotasChanged: p.changes.length, creditFreed: formatMoney(creditFreed) } });
  return { ...previewJson(p, i), applied, creditFreed: formatMoney(creditFreed), subscription: await getSubscription(ctx, subscriptionId) };
}

/** Historial de versiones de precio y calendario del servicio. */
export async function listTerms(ctx: Ctx, subscriptionId: string) {
  await ensureSubscription(ctx, subscriptionId);
  const r = await rows<TermsRow & { reason: string | null }>(ctx.trx, sql<TermsRow & { reason: string | null }>`
    select id, valid_from, valid_to, announced_price, interval_unit, interval_count, anchor_date, reason from subscription_terms
    where owner_id = ${ctx.ownerId} and subscription_id = ${subscriptionId} order by valid_from`);
  return r.map((t) => ({
    id: t.id, validFrom: t.valid_from, validTo: t.valid_to, announcedPrice: formatMoney(parseMoney(t.announced_price)),
    interval: { unit: t.interval_unit, count: t.interval_count }, anchor: t.anchor_date, reason: t.reason,
  }));
}
