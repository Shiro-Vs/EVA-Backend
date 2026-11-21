import { sql } from 'kysely';
import { cycleEnd, generateCycles, verifyCalendar, baseDays, type Interval, type TermsVersion, type CyclePlan } from '../domain/calendar.js';
import { formatISO, parseISO, type LocalDate } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { suggestedQuota } from '../domain/proration.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { checkPreviewToken, makePreviewToken } from '../infra/preview.js';
import { assertActiveCategory } from './categories.js';
import { emitCharges } from './charges.js';
import { ts, type Ctx } from './context.js';

export interface SubscriptionInput {
  name: string;
  provider?: string | null;
  mode: 'personal' | 'shared';
  capacity: number;
  announcedPrice: string;
  interval: Interval;
  startDate: string;
  nextPaymentDate: string;
  preferredAccountId?: string | null;
  color?: string | null;
  icon?: string | null;
  categoryId?: string | null;
}

/** Entradas que determinan el cálculo (las cosméticas no entran en la firma de la vista previa). */
const previewCore = (i: SubscriptionInput) => ({
  mode: i.mode, capacity: i.mode === 'personal' ? 1 : i.capacity, announcedPrice: formatMoney(parseMoney(i.announcedPrice)),
  interval: i.interval, startDate: i.startDate, nextPaymentDate: i.nextPaymentDate,
});

function plan(i: SubscriptionInput, today: LocalDate) {
  const start = parseISO(i.startDate);
  const next = parseISO(i.nextPaymentDate);
  if (next <= start) throw unprocessable('VALIDATION_ERROR', 'La fecha del siguiente pago debe ser posterior al inicio', [{ field: 'nextPaymentDate' }]);
  const price = parseMoney(i.announcedPrice);
  const calendar = verifyCalendar(start, next, i.interval);
  // D-02: si el proveedor confirma la fecha calculada se conserva el día original como ancla (31 → 28 feb → 31 mar);
  // si difiere y se confirma, la fecha informada pasa a ser el ancla (RN-C03).
  const anchor = calendar.ok ? start : next;
  const terms: TermsVersion[] = [{ validFrom: start, validTo: null, announcedPrice: price, interval: i.interval, anchor }];
  const cycles = generateCycles({ terms, firstStart: start, firstEnd: next, existing: [], today, ahead: 1 });
  return { start, next, anchor, price, calendar, cycles };
}

const cycleJson = (c: CyclePlan) => ({ seq: c.seq, startDate: formatISO(c.start), endDate: formatISO(c.end) });

export function previewSubscription(ctx: Ctx, i: SubscriptionInput & { occupiedSeats?: number }) {
  const p = plan(i, ctx.today);
  const capacity = i.mode === 'personal' ? 1 : i.capacity;
  const occupied = Math.min(Math.max(i.occupiedSeats ?? 1, 1), capacity);
  const quota = suggestedQuota(p.price, occupied);
  return {
    calendar: { ok: p.calendar.ok, expectedNextPayment: formatISO(p.calendar.expected), diffDays: p.calendar.diffDays },
    suggestedQuota: { amount: formatMoney(quota), occupiedSeats: occupied, formula: `ceil(${formatMoney(p.price)} / ${occupied})` },
    cycles: p.cycles.slice(0, 2).map(cycleJson),
    baseDays: p.cycles[0]!.termsSnapshot.baseDays,
    previewToken: makePreviewToken(ctx.previewSecret, { scope: 'subscription.create', ownerId: ctx.ownerId, inputs: previewCore(i), state: null }, ctx.nowMs),
  };
}

interface TermsRow { id: string; valid_from: string; valid_to: string | null; announced_price: string; interval_unit: Interval['unit']; interval_count: number; anchor_date: string }
interface CycleRow { id: string; seq: number; start_date: string; end_date: string; terms_snapshot: { announcedPrice: string; interval: Interval; anchor: string; baseDays: number } }

const toTerms = (t: TermsRow): TermsVersion => ({
  validFrom: parseISO(t.valid_from), validTo: t.valid_to ? parseISO(t.valid_to) : null, announcedPrice: parseMoney(t.announced_price),
  interval: { unit: t.interval_unit, count: t.interval_count }, anchor: parseISO(t.anchor_date),
});

async function insertCycles(ctx: Ctx, subscriptionId: string, termsRows: TermsRow[], cycles: CyclePlan[]) {
  for (const c of cycles) {
    const t = termsRows.find((x) => c.start >= parseISO(x.valid_from) && (x.valid_to === null || c.start < parseISO(x.valid_to)));
    const snap = { announcedPrice: formatMoney(c.termsSnapshot.announcedPrice), interval: c.termsSnapshot.interval, anchor: formatISO(c.termsSnapshot.anchor), baseDays: c.termsSnapshot.baseDays };
    await sql`
      insert into billing_cycle (owner_id, subscription_id, seq, start_date, end_date, terms_id, terms_snapshot)
      values (${ctx.ownerId}, ${subscriptionId}, ${c.seq}, ${formatISO(c.start)}, ${formatISO(c.end)}, ${t?.id ?? null}, ${JSON.stringify(snap)}::jsonb)`.execute(ctx.trx);
  }
}

export async function createSubscription(ctx: Ctx, i: SubscriptionInput & { confirmCalendarMismatch?: boolean; previewToken?: string }) {
  checkPreviewToken(ctx.previewSecret, i.previewToken, { scope: 'subscription.create', ownerId: ctx.ownerId, inputs: previewCore(i), state: null }, ctx.nowMs);
  const p = plan(i, ctx.today);
  if (!p.calendar.ok && !i.confirmCalendarMismatch) {
    throw unprocessable('CALENDAR_MISMATCH_UNCONFIRMED', 'La fecha informada difiere de la calculada y debe confirmarse', {
      expectedNextPayment: formatISO(p.calendar.expected), diffDays: p.calendar.diffDays,
    });
  }
  if (i.preferredAccountId) {
    const a = await one(ctx.trx, sql`select 1 from account where owner_id = ${ctx.ownerId} and id = ${i.preferredAccountId}`);
    if (!a) throw notFound('Account');
  }
  if (i.categoryId) await assertActiveCategory(ctx, i.categoryId);
  const capacity = i.mode === 'personal' ? 1 : i.capacity;
  const sub = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into subscription (owner_id, name, provider, mode, capacity, preferred_account_id, color, icon, category_id)
    values (${ctx.ownerId}, ${i.name.trim()}, ${i.provider ?? null}, ${i.mode}, ${capacity}, ${i.preferredAccountId ?? null}, ${i.color ?? null}, ${i.icon ?? null}, ${i.categoryId ?? null}) returning id`);
  const id = sub!.id;

  const terms = await one<TermsRow>(ctx.trx, sql<TermsRow>`
    insert into subscription_terms (owner_id, subscription_id, valid_from, announced_price, interval_unit, interval_count, anchor_date, reason, created_by)
    values (${ctx.ownerId}, ${id}, ${i.startDate}, ${formatMoney(p.price)}, ${i.interval.unit}, ${i.interval.count}, ${formatISO(p.anchor)}, 'Alta del servicio', ${ctx.actorId})
    returning id, valid_from, valid_to, announced_price, interval_unit, interval_count, anchor_date`);
  await insertCycles(ctx, id, [terms!], p.cycles);

  // La plaza del administrador ocupa capacidad pero no genera cargo (RN-S03/S04).
  const m = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into membership (owner_id, subscription_id, contact_id, is_owner, start_date) values (${ctx.ownerId}, ${id}, null, true, ${i.startDate}) returning id`);
  const seat = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into seat (owner_id, membership_id, subscription_id, label, start_date) values (${ctx.ownerId}, ${m!.id}, ${id}, 'Tuya', ${i.startDate}) returning id`);
  await sql`insert into seat_terms (owner_id, seat_id, valid_from, quota, reason, created_by) values (${ctx.ownerId}, ${seat!.id}, ${i.startDate}, 0.00, 'Plaza del administrador', ${ctx.actorId})`.execute(ctx.trx);

  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'subscription.create', entityType: 'subscription', entityId: id,
    changes: { calendarMismatchConfirmed: !p.calendar.ok, price: formatMoney(p.price) } });
  return getSubscription(ctx, id);
}

/**
 * Mantiene generados el ciclo en curso y `ahead` ciclos futuros (RN-C11, D-08). Idempotente y serializada por la fila del servicio.
 * Devuelve cuántos ciclos nuevos creó.
 */
export async function ensureCycles(ctx: Ctx, subscriptionId: string, ahead = 1): Promise<number> {
  const sub = await one<{ status: string }>(ctx.trx, sql<{ status: string }>`select status from subscription where owner_id = ${ctx.ownerId} and id = ${subscriptionId} for update`);
  if (!sub) throw notFound('Subscription');
  if (sub.status !== 'active') return 0; // archivado o suspendido: no se emiten ciclos (RN-C09)
  const termsRows = await rows<TermsRow>(ctx.trx, sql<TermsRow>`
    select id, valid_from, valid_to, announced_price, interval_unit, interval_count, anchor_date from subscription_terms
    where owner_id = ${ctx.ownerId} and subscription_id = ${subscriptionId} order by valid_from`);
  const existing = (await rows<{ seq: number; start_date: string; end_date: string }>(ctx.trx, sql`
    select seq, start_date, end_date from billing_cycle where owner_id = ${ctx.ownerId} and subscription_id = ${subscriptionId} order by start_date`))
    .map((c) => ({ seq: c.seq, start: parseISO(c.start_date), end: parseISO(c.end_date) }));
  const terms = termsRows.map(toTerms);
  const first = terms[0]!;
  const fresh = generateCycles({ terms, firstStart: first.validFrom, firstEnd: cycleEnd(first.validFrom, first.anchor, first.interval), existing, today: ctx.today, ahead });
  await insertCycles(ctx, subscriptionId, termsRows, fresh);
  return fresh.length;
}

const cycleView = (c: CycleRow) => ({ id: c.id, seq: c.seq, startDate: c.start_date, endDate: c.end_date, announcedPrice: c.terms_snapshot.announcedPrice, baseDays: c.terms_snapshot.baseDays });

export async function listCycles(ctx: Ctx, subscriptionId: string) {
  await ensureSubscription(ctx, subscriptionId);
  await ensureCycles(ctx, subscriptionId);
  await emitCharges(ctx, subscriptionId);
  return (await rows<CycleRow>(ctx.trx, sql<CycleRow>`
    select id, seq, start_date, end_date, terms_snapshot from billing_cycle where owner_id = ${ctx.ownerId} and subscription_id = ${subscriptionId} order by start_date desc`)).map(cycleView);
}

export async function generateAhead(ctx: Ctx, subscriptionId: string, ahead: number) {
  await ensureSubscription(ctx, subscriptionId);
  const created = await ensureCycles(ctx, subscriptionId, ahead);
  // Emisión explícita por adelantado (anticipos): se marcan los primeros `ahead` ciclos futuros para que se emitan sus cargos.
  await sql`
    update billing_cycle set emit_charges = true where id in (
      select id from billing_cycle where owner_id = ${ctx.ownerId} and subscription_id = ${subscriptionId} and start_date > ${formatISO(ctx.today)}::date
      order by start_date limit ${ahead})`.execute(ctx.trx);
  await emitCharges(ctx, subscriptionId);
  if (created > 0) await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'subscription.generate_cycles', entityType: 'subscription', entityId: subscriptionId, changes: { ahead, created } });
  return { created, cycles: await listCycles(ctx, subscriptionId) };
}

export async function ensureSubscription(ctx: Ctx, id: string) {
  const s = await one<{ id: string; status: string }>(ctx.trx, sql<{ id: string; status: string }>`select id, status from subscription where owner_id = ${ctx.ownerId} and id = ${id}`);
  if (!s) throw notFound('Subscription');
  return s;
}

interface SubRow {
  id: string; name: string; provider: string | null; mode: string; capacity: number; preferred_account_id: string | null; color: string | null; icon: string | null; category_id: string | null;
  status: string; currency: string; version: number; created_at: unknown; occupied: string;
}

export async function getSubscription(ctx: Ctx, id: string) {
  await ensureSubscription(ctx, id);
  await ensureCycles(ctx, id);
  await emitCharges(ctx, id);
  const s = await one<SubRow>(ctx.trx, sql<SubRow>`
    select s.*, (select count(*) from seat st where st.owner_id = s.owner_id and st.subscription_id = s.id
                  and st.start_date <= ${formatISO(ctx.today)}::date and (st.end_date is null or st.end_date > ${formatISO(ctx.today)}::date)) as occupied
    from subscription s where s.owner_id = ${ctx.ownerId} and s.id = ${id}`);
  const t = await one<TermsRow>(ctx.trx, sql<TermsRow>`
    select id, valid_from, valid_to, announced_price, interval_unit, interval_count, anchor_date from subscription_terms
    where owner_id = ${ctx.ownerId} and subscription_id = ${id} and valid_from <= ${formatISO(ctx.today)}::date and (valid_to is null or valid_to > ${formatISO(ctx.today)}::date)
    order by valid_from desc limit 1`);
  const cycles = await rows<CycleRow>(ctx.trx, sql<CycleRow>`
    select id, seq, start_date, end_date, terms_snapshot from billing_cycle where owner_id = ${ctx.ownerId} and subscription_id = ${id} order by start_date`);
  const todayIso = formatISO(ctx.today);
  const current = cycles.find((c) => c.start_date <= todayIso && todayIso < c.end_date) ?? null;
  const next = cycles.find((c) => c.start_date > todayIso) ?? null;
  return {
    id: s!.id, name: s!.name, provider: s!.provider, mode: s!.mode, capacity: s!.capacity, preferredAccountId: s!.preferred_account_id,
    color: s!.color, icon: s!.icon, categoryId: s!.category_id, status: s!.status, currency: s!.currency, version: s!.version, createdAt: ts(s!.created_at),
    occupiedSeats: Number(s!.occupied),
    terms: t ? { announcedPrice: formatMoney(parseMoney(t.announced_price)), interval: { unit: t.interval_unit, count: t.interval_count }, anchor: t.anchor_date, validFrom: t.valid_from } : null,
    currentCycle: current ? cycleView(current) : null,
    nextCycle: next ? cycleView(next) : null,
    baseDays: current ? baseDays({ unit: current.terms_snapshot.interval.unit, count: current.terms_snapshot.interval.count }, parseISO(current.start_date), parseISO(current.end_date)) : null,
  };
}

export async function listSubscriptions(ctx: Ctx, status?: string) {
  // Se bloquean las filas en orden de ID, el mismo que usa syncAllSubscriptions: si el listado las tomara en orden alfabético,
  // una petición simultánea de /summary produciría un interbloqueo (40P01 → 409).
  await sql`select id from subscription where owner_id = ${ctx.ownerId} and ${status ? sql`status = ${status}` : sql`status <> 'archived'`} order by id for update`.execute(ctx.trx);
  const ids = await rows<{ id: string }>(ctx.trx, status
    ? sql<{ id: string }>`select id from subscription where owner_id = ${ctx.ownerId} and status = ${status} order by lower(name)`
    : sql<{ id: string }>`select id from subscription where owner_id = ${ctx.ownerId} and status <> 'archived' order by lower(name)`);
  const out = [];
  for (const { id } of ids) out.push(await getSubscription(ctx, id));
  return out;
}

export async function patchSubscription(ctx: Ctx, id: string, version: number, p: { name?: string; provider?: string | null; color?: string | null; icon?: string | null; preferredAccountId?: string | null; categoryId?: string | null }) {
  const cur = await one<{ name: string; provider: string | null; color: string | null; icon: string | null; preferred_account_id: string | null; category_id: string | null; version: number }>(ctx.trx,
    sql`select name, provider, color, icon, preferred_account_id, category_id, version from subscription where owner_id = ${ctx.ownerId} and id = ${id} for update`);
  if (!cur) throw notFound('Subscription');
  if (cur.version !== version) throw conflict('CONFLICT_VERSION', 'The subscription was modified; reload and retry');
  if (p.preferredAccountId) {
    const a = await one(ctx.trx, sql`select 1 from account where owner_id = ${ctx.ownerId} and id = ${p.preferredAccountId}`);
    if (!a) throw notFound('Account');
  }
  if (p.categoryId) await assertActiveCategory(ctx, p.categoryId);
  await sql`
    update subscription set name = ${(p.name ?? cur.name).trim()}, provider = ${p.provider === undefined ? cur.provider : p.provider}, category_id = ${p.categoryId === undefined ? cur.category_id : p.categoryId},
      color = ${p.color === undefined ? cur.color : p.color}, icon = ${p.icon === undefined ? cur.icon : p.icon},
      preferred_account_id = ${p.preferredAccountId === undefined ? cur.preferred_account_id : p.preferredAccountId}
    where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'subscription.update', entityType: 'subscription', entityId: id });
  return getSubscription(ctx, id);
}

/** D-32: un servicio con plazas activas de terceros o reservas de crédito activas no se archiva. */
export async function archiveSubscription(ctx: Ctx, id: string) {
  await ensureSubscription(ctx, id);
  const n = await one<{ n: string }>(ctx.trx, sql<{ n: string }>`
    select count(*) as n from seat s join membership m on m.id = s.membership_id and m.owner_id = s.owner_id
    where s.owner_id = ${ctx.ownerId} and s.subscription_id = ${id} and (s.end_date is null or s.end_date > ${formatISO(ctx.today)}::date) and not m.is_owner`);
  if (Number(n!.n) > 0) throw unprocessable('SUBSCRIPTION_HAS_ACTIVE_SEATS', 'The subscription still has active seats; remove them first');
  const res = await one<{ n: string }>(ctx.trx, sql<{ n: string }>`
    select count(*) as n from credit_reservation where owner_id = ${ctx.ownerId} and target_subscription_id = ${id} and status = 'active'`);
  if (Number(res!.n) > 0) throw unprocessable('SUBSCRIPTION_HAS_RESERVATIONS', 'Hay crédito reservado para este servicio: muévelo a otro servicio o libéralo antes de archivar');
  await sql`update subscription set status = 'archived' where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'subscription.archive', entityType: 'subscription', entityId: id });
  return getSubscription(ctx, id);
}

/** Restaura un servicio archivado a activo. (Un servicio suspendido se reactiva mediante cambio de calendario). */
export async function restoreSubscription(ctx: Ctx, id: string) {
  const s = await one<{ id: string; status: string }>(ctx.trx, sql<{ id: string; status: string }>`select id, status from subscription where owner_id = ${ctx.ownerId} and id = ${id} for update`);
  if (!s) throw notFound('Subscription');
  if (s.status !== 'archived') throw unprocessable('SUBSCRIPTION_NOT_ARCHIVED', 'Solo un servicio archivado se puede restaurar');
  await sql`update subscription set status = 'active' where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'subscription.restore', entityType: 'subscription', entityId: id });
  return getSubscription(ctx, id);
}

/** Elimina definitivamente un servicio SOLO si nunca tuvo pagos al proveedor, cargos, participantes ni historial. Si ya se usó, sugiere archivarlo. */
export async function deleteSubscription(ctx: Ctx, id: string) {
  const s = await one<{ id: string; name: string }>(ctx.trx, sql<{ id: string; name: string }>`select id, name from subscription where owner_id = ${ctx.ownerId} and id = ${id} for update`);
  if (!s) throw notFound('Subscription');
  const usage: Record<string, number> = {};
  const add = (label: string, n: string | undefined) => { if (Number(n ?? 0) > 0) usage[label] = Number(n); };
  add('pagos al proveedor', (await one<{ n: string }>(ctx.trx, sql<{ n: string }>`
    select count(*) as n from supplier_payment sp join billing_cycle bc on bc.id = sp.cycle_id and bc.owner_id = sp.owner_id
    where sp.owner_id = ${ctx.ownerId} and bc.subscription_id = ${id}`))?.n);
  add('cargos emitidos', (await one<{ n: string }>(ctx.trx, sql<{ n: string }>`
    select count(*) as n from member_charge mc join billing_cycle bc on bc.id = mc.cycle_id and bc.owner_id = mc.owner_id
    where mc.owner_id = ${ctx.ownerId} and bc.subscription_id = ${id}`))?.n);
  add('participantes', (await one<{ n: string }>(ctx.trx, sql<{ n: string }>`
    select count(*) as n from membership where owner_id = ${ctx.ownerId} and subscription_id = ${id} and not is_owner`))?.n);
  add('reservas de crédito', (await one<{ n: string }>(ctx.trx, sql<{ n: string }>`
    select count(*) as n from credit_reservation where owner_id = ${ctx.ownerId} and target_subscription_id = ${id}`))?.n);
  add('cambios de calendario', (await one<{ n: string }>(ctx.trx, sql<{ n: string }>`
    select count(*) as n from calendar_change where owner_id = ${ctx.ownerId} and subscription_id = ${id}`))?.n);
  if (Object.keys(usage).length > 0) {
    throw conflict('SUBSCRIPTION_IN_USE', 'El servicio ya tiene historial o participantes: no se puede eliminar sin romperlo. Puedes archivarlo', { usage });
  }
  await sql`delete from seat_terms where owner_id = ${ctx.ownerId} and seat_id in (select id from seat where owner_id = ${ctx.ownerId} and subscription_id = ${id})`.execute(ctx.trx);
  await sql`delete from seat where owner_id = ${ctx.ownerId} and subscription_id = ${id}`.execute(ctx.trx);
  await sql`delete from membership where owner_id = ${ctx.ownerId} and subscription_id = ${id}`.execute(ctx.trx);
  await sql`delete from billing_cycle where owner_id = ${ctx.ownerId} and subscription_id = ${id}`.execute(ctx.trx);
  await sql`delete from subscription_terms where owner_id = ${ctx.ownerId} and subscription_id = ${id}`.execute(ctx.trx);
  await sql`delete from subscription where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'subscription.delete', entityType: 'subscription', entityId: id, changes: { name: s.name } });
  return { id, deleted: true };
}
