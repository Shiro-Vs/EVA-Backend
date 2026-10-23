import { sql } from 'kysely';
import { formatISO, parseISO } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { proratedJoin, JoinError, type JoinResult } from '../domain/proration.js';
import { notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { checkPreviewToken, makePreviewToken } from '../infra/preview.js';
import { applyReservations, insertCharge, listCharges } from './charges.js';
import type { Ctx } from './context.js';
import { ensureSubscription } from './subscriptions.js';
import { syncSubscription } from './sync.js';

export interface SeatInput {
  contactId: string;
  label: string;
  joinDate?: string;
  quota: string;
  freeDaysThreshold?: number | null; // excepción de g para esta plaza (RN-I07)
}

interface Plan {
  contactId: string; contactName: string; label: string; quota: bigint; joinDate: number; g: number; gSource: 'plaza' | 'usuario';
  cycle: { id: string; start: number; end: number; baseDays: number };
  occupied: number; capacity: number; result: JoinResult; existingMembershipId: string | null;
}

async function buildPlan(ctx: Ctx, subscriptionId: string, i: SeatInput): Promise<Plan> {
  const sub = await ensureSubscription(ctx, subscriptionId);
  if (sub.status === 'archived') throw unprocessable('SUBSCRIPTION_ARCHIVED', 'The subscription is archived');
  const det = await one<{ mode: string; capacity: number }>(ctx.trx, sql<{ mode: string; capacity: number }>`select mode, capacity from subscription where owner_id = ${ctx.ownerId} and id = ${subscriptionId}`);
  if (det!.mode === 'personal') throw unprocessable('SUBSCRIPTION_PERSONAL', 'A personal subscription does not admit seats for other people');

  const contact = await one<{ name: string; status: string }>(ctx.trx, sql<{ name: string; status: string }>`select name, status from contact where owner_id = ${ctx.ownerId} and id = ${i.contactId}`);
  if (!contact) throw notFound('Contact');
  if (contact.status !== 'active') throw unprocessable('CONTACT_ARCHIVED', 'The contact is archived');

  const quota = parseMoney(i.quota);
  const joinDate = i.joinDate ? parseISO(i.joinDate) : ctx.today;
  const today = formatISO(ctx.today);

  // El ingreso se calcula sobre el ciclo en curso (A03/A04). Antes del ciclo en curso o después no se admite.
  const cyc = await one<{ id: string; start_date: string; end_date: string; terms_snapshot: { baseDays: number } }>(ctx.trx, sql<{ id: string; start_date: string; end_date: string; terms_snapshot: { baseDays: number } }>`
    select id, start_date, end_date, terms_snapshot from billing_cycle
    where owner_id = ${ctx.ownerId} and subscription_id = ${subscriptionId} and start_date <= ${today}::date and end_date > ${today}::date`);
  if (!cyc) throw unprocessable('JOIN_OUT_OF_CYCLE', 'There is no active cycle for today');
  const cycle = { id: cyc.id, start: parseISO(cyc.start_date), end: parseISO(cyc.end_date), baseDays: cyc.terms_snapshot.baseDays };

  const prof = await one<{ default_free_days: number }>(ctx.trx, sql<{ default_free_days: number }>`select default_free_days from user_profile where id = ${ctx.ownerId}`);
  const hasOverride = i.freeDaysThreshold !== undefined && i.freeDaysThreshold !== null;
  const g = hasOverride ? i.freeDaysThreshold! : prof!.default_free_days;

  let result: JoinResult;
  try {
    result = proratedJoin({ quota, cycleStart: cycle.start, cycleEnd: cycle.end, joinDate, freeDaysThreshold: g, baseDays: cycle.baseDays });
  } catch (e) {
    if (e instanceof JoinError) throw unprocessable(e.code, e.message);
    throw e;
  }

  const occ = await one<{ n: string }>(ctx.trx, sql<{ n: string }>`
    select count(*) as n from seat where owner_id = ${ctx.ownerId} and subscription_id = ${subscriptionId}
      and start_date <= ${formatISO(joinDate)}::date and (end_date is null or end_date > ${formatISO(joinDate)}::date)`);
  const existing = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    select id from membership where owner_id = ${ctx.ownerId} and subscription_id = ${subscriptionId} and contact_id = ${i.contactId} and status <> 'ended'`);
  return {
    contactId: i.contactId, contactName: contact.name, label: i.label.trim(), quota, joinDate, g, gSource: hasOverride ? 'plaza' : 'usuario',
    cycle, occupied: Number(occ!.n), capacity: det!.capacity, result, existingMembershipId: existing?.id ?? null,
  };
}

const fingerprint = (p: Plan) => ({ cycle: p.cycle.id, occupied: p.occupied, g: p.g, membership: p.existingMembershipId });
const inputsOf = (subscriptionId: string, i: SeatInput) => ({
  subscriptionId, contactId: i.contactId, label: i.label.trim(), joinDate: i.joinDate ?? null, quota: formatMoney(parseMoney(i.quota)), freeDaysThreshold: i.freeDaysThreshold ?? null,
});

const calcJson = (r: JoinResult, p: Plan) => ({
  mode: r.mode, remainingDays: r.remainingDays, baseDays: r.baseDays, freeDaysThreshold: r.freeDaysThreshold,
  quota: formatMoney(r.quota), prorated: formatMoney(r.prorated), gross: formatMoney(r.gross), exemption: formatMoney(r.exemption), net: formatMoney(r.net),
  rule: r.rule,
  formula: r.mode === 'full_cycle' ? `cuota completa ${formatMoney(r.quota)}`
    : `min(${formatMoney(r.quota)}, ceil_sol(${formatMoney(r.quota)} × ${r.remainingDays} / ${r.baseDays}))${r.mode === 'trial_free' ? `; ${r.remainingDays} ≤ ${r.freeDaysThreshold} ⇒ gratis` : ''}`,
  gSource: p.gSource,
});

export async function previewSeat(ctx: Ctx, subscriptionId: string, i: SeatInput) {
  await syncSubscription(ctx, subscriptionId);
  const p = await buildPlan(ctx, subscriptionId, i);
  const warnings = [...p.result.warnings] as string[];
  if (p.occupied >= p.capacity) warnings.push('CAPACITY_EXCEEDED');
  return {
    cycle: { id: p.cycle.id, startDate: formatISO(p.cycle.start), endDate: formatISO(p.cycle.end) },
    contact: { id: p.contactId, name: p.contactName },
    calculation: calcJson(p.result, p),
    dueDate: formatISO(p.result.dueDate),
    next: { cycleStart: formatISO(p.cycle.end), dueDate: formatISO(p.cycle.end), amount: formatMoney(p.quota) },
    occupancy: { occupied: p.occupied, capacity: p.capacity },
    warnings,
    previewToken: makePreviewToken(ctx.previewSecret, { scope: 'seat.join', ownerId: ctx.ownerId, inputs: inputsOf(subscriptionId, i), state: fingerprint(p) }, ctx.nowMs),
  };
}

export async function createSeat(ctx: Ctx, subscriptionId: string, i: SeatInput & { previewToken: string }) {
  await syncSubscription(ctx, subscriptionId); // bloquea la fila del servicio: serializa altas simultáneas (A28d)
  const p = await buildPlan(ctx, subscriptionId, i);
  checkPreviewToken(ctx.previewSecret, i.previewToken, { scope: 'seat.join', ownerId: ctx.ownerId, inputs: inputsOf(subscriptionId, i), state: fingerprint(p) }, ctx.nowMs);
  if (p.occupied >= p.capacity) throw unprocessable('CAPACITY_EXCEEDED', 'There are no free seats on that date', { occupied: p.occupied, capacity: p.capacity });

  let membershipId = p.existingMembershipId;
  if (!membershipId) {
    const mem = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
      insert into membership (owner_id, subscription_id, contact_id, is_owner, start_date) values (${ctx.ownerId}, ${subscriptionId}, ${p.contactId}, false, ${formatISO(p.joinDate)}) returning id`);
    membershipId = mem!.id;
  }
  const seat = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into seat (owner_id, membership_id, subscription_id, label, start_date) values (${ctx.ownerId}, ${membershipId}, ${subscriptionId}, ${p.label}, ${formatISO(p.joinDate)}) returning id`);
  await sql`
    insert into seat_terms (owner_id, seat_id, valid_from, quota, free_days_threshold, reason, created_by)
    values (${ctx.ownerId}, ${seat!.id}, ${formatISO(p.joinDate)}, ${formatMoney(p.quota)}, ${i.freeDaysThreshold ?? null}, 'Alta de la plaza', ${ctx.actorId})`.execute(ctx.trx);

  const r = p.result;
  const obligationId = await insertCharge(ctx, {
    contactId: p.contactId, seatId: seat!.id, cycleId: p.cycle.id, dueDate: r.dueDate, quota: p.quota, gross: r.gross, exemption: r.exemption,
    mode: r.mode === 'full_cycle' ? 'full_cycle' : r.mode, snapshot: { ...calcJson(r, p), joinDate: formatISO(p.joinDate) },
  });
  await applyReservations(ctx, obligationId, p.contactId, subscriptionId);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'seat.join', entityType: 'seat', entityId: seat!.id,
    changes: { contactId: p.contactId, mode: r.mode, net: formatMoney(r.net), g: p.g } });
  return getSeat(ctx, seat!.id);
}

interface SeatRow {
  id: string; label: string; subscription_id: string; contact_id: string | null; contact_name: string | null; is_owner: boolean;
  start_date: string; end_date: string | null; quota: string; next_quota: string | null; next_quota_from: string | null;
}
const seatBase = (today: number) => sql`
  select s.id, s.label, s.subscription_id, m.contact_id, ct.name as contact_name, m.is_owner, s.start_date, s.end_date,
    coalesce(
      (select st.quota from seat_terms st where st.seat_id = s.id and st.owner_id = s.owner_id and st.valid_from <= ${formatISO(today)}::date and (st.valid_to is null or st.valid_to > ${formatISO(today)}::date) limit 1),
      (select st.quota from seat_terms st where st.seat_id = s.id and st.owner_id = s.owner_id order by st.valid_from limit 1)) as quota,
    (select st.quota from seat_terms st where st.seat_id = s.id and st.owner_id = s.owner_id and st.valid_from > ${formatISO(today)}::date order by st.valid_from limit 1) as next_quota,
    (select st.valid_from from seat_terms st where st.seat_id = s.id and st.owner_id = s.owner_id and st.valid_from > ${formatISO(today)}::date order by st.valid_from limit 1) as next_quota_from
  from seat s join membership m on m.id = s.membership_id and m.owner_id = s.owner_id
  left join contact ct on ct.id = m.contact_id and ct.owner_id = m.owner_id`;

const seatJson = (s: SeatRow) => ({
  id: s.id, label: s.label, subscriptionId: s.subscription_id, isOwner: s.is_owner,
  contact: s.contact_id ? { id: s.contact_id, name: s.contact_name } : null,
  startDate: s.start_date, endDate: s.end_date, quota: formatMoney(parseMoney(s.quota)),
  scheduledQuota: s.next_quota ? { quota: formatMoney(parseMoney(s.next_quota)), from: s.next_quota_from } : null,
});

export async function getSeat(ctx: Ctx, id: string) {
  const found = await one<{ subscription_id: string }>(ctx.trx, sql<{ subscription_id: string }>`select subscription_id from seat where owner_id = ${ctx.ownerId} and id = ${id}`);
  if (!found) throw notFound('Seat');
  await syncSubscription(ctx, found.subscription_id);
  const s = await one<SeatRow>(ctx.trx, sql<SeatRow>`${seatBase(ctx.today)} where s.owner_id = ${ctx.ownerId} and s.id = ${id}`);
  if (!s) throw notFound('Seat');
  return { ...seatJson(s), charges: await listCharges(ctx, sql`mc.seat_id = ${id}`) };
}

export async function listSeats(ctx: Ctx, subscriptionId: string) {
  await ensureSubscription(ctx, subscriptionId);
  await syncSubscription(ctx, subscriptionId);
  const seats = await rows<SeatRow>(ctx.trx, sql<SeatRow>`${seatBase(ctx.today)} where s.owner_id = ${ctx.ownerId} and s.subscription_id = ${subscriptionId} and s.end_date is null order by s.created_at`);
  const out = [];
  for (const s of seats) {
    const charges = s.is_owner ? [] : await listCharges(ctx, sql`mc.seat_id = ${s.id}`);
    const pending = charges.reduce((a, c) => a + parseMoney(c.pending), 0n);
    out.push({ ...seatJson(s), pending: formatMoney(pending), overdue: charges.some((c) => c.overdue) });
  }
  return out;
}
