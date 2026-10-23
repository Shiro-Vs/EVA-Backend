import { sql } from 'kysely';
import { baseDays, cycleEnd, type Interval } from '../domain/calendar.js';
import { formatISO, parseISO, type LocalDate } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { checkPreviewToken, makePreviewToken } from '../infra/preview.js';
import { ts, type Ctx } from './context.js';
import { ensureSubscription, getSubscription } from './subscriptions.js';
import { syncSubscription } from './sync.js';

export type CalendarChangeInput =
  | { kind: 'shift_renewal'; newDate: string; reason: string }
  | { kind: 'advance_renewal'; newDate: string; reason: string }
  | { kind: 'change_interval'; interval: Interval; reason: string }
  | { kind: 'suspend'; reason: string }
  | { kind: 'reactivate'; renewalDate: string; reason: string };

interface Terms { id: string; valid_from: string; valid_to: string | null; announced_price: string; interval_unit: Interval['unit']; interval_count: number; anchor_date: string }
interface Cyc { id: string; seq: number; start_date: string; end_date: string; effects: number }

interface FutureMove { id: string; seq: number; oldStart: string; oldEnd: string; newStart: LocalDate; newEnd: LocalDate; hasCharges: boolean }

/** Cómo quedan los términos: o se cierra el abierto y se inserta uno nuevo, o (si el límite ya coincidía con un cambio previo) se corre el que empieza ahí. */
interface TermsPlan { mode: 'insert' | 'update'; prevId: string; nextId: string | null; price: string }

interface Plan {
  kind: CalendarChangeInput['kind'];
  status: string;
  termsKey: string;
  tp: TermsPlan | null;
  moved: Cyc | null;
  oldEnd: string | null;
  newEnd: LocalDate | null;
  /** Términos nuevos (None en suspender). */
  next: { interval: Interval; anchor: LocalDate } | null;
  future: FutureMove[];
  remove: Cyc[];
  statusAfter: 'active' | 'suspended';
  effectiveOn: string;
}

const loadCycles = (ctx: Ctx, subscriptionId: string) => rows<Cyc>(ctx.trx, sql<Cyc>`
  select c.id, c.seq, c.start_date, c.end_date,
         ((select count(*) from member_charge mc where mc.cycle_id = c.id and mc.status = 'issued')
        + (select count(*) from supplier_payment sp where sp.cycle_id = c.id and sp.status = 'active'))::int as effects
  from billing_cycle c where c.owner_id = ${ctx.ownerId} and c.subscription_id = ${subscriptionId} order by c.start_date`);

const unsupported = (message: string) => unprocessable('CALENDAR_CHANGE_UNSUPPORTED', message);

function termsPlanFor(all: Terms[], movedStart: string, movedEnd: string): TermsPlan {
  const idx = all.findIndex((t) => t.valid_from <= movedStart && (t.valid_to === null || movedStart < t.valid_to));
  const c = all[idx];
  if (!c) throw unsupported('No terms cover the cycle');
  if (c.valid_to === null) return { mode: 'insert', prevId: c.id, nextId: null, price: c.announced_price };
  const n = all[idx + 1];
  if (n && n.valid_from === c.valid_to && c.valid_to === movedEnd && n.valid_to === null) return { mode: 'update', prevId: c.id, nextId: n.id, price: n.announced_price };
  throw unsupported('A price change is scheduled around this cycle; resolve it first');
}

/** Recalcula, desde `from`, los límites de los ciclos futuros según los términos nuevos (D-02: desde el ancla). */
function recompute(from: LocalDate, next: { interval: Interval; anchor: LocalDate }, cycles: Cyc[], hasCharges: (id: string) => boolean): FutureMove[] {
  const out: FutureMove[] = [];
  let s = from;
  for (const c of cycles) {
    const e = cycleEnd(s, next.anchor, next.interval);
    out.push({ id: c.id, seq: c.seq, oldStart: c.start_date, oldEnd: c.end_date, newStart: s, newEnd: e, hasCharges: hasCharges(c.id) });
    s = e;
  }
  return out;
}

async function buildPlan(ctx: Ctx, subscriptionId: string, i: CalendarChangeInput): Promise<Plan> {
  const sub = await ensureSubscription(ctx, subscriptionId);
  if (sub.status === 'archived') throw unprocessable('SUBSCRIPTION_ARCHIVED', 'The subscription is archived');
  await syncSubscription(ctx, subscriptionId);

  const allTerms = await rows<Terms>(ctx.trx, sql<Terms>`
    select id, valid_from, valid_to, announced_price, interval_unit, interval_count, anchor_date from subscription_terms
    where owner_id = ${ctx.ownerId} and subscription_id = ${subscriptionId} order by valid_from`);
  const terms = allTerms.find((t) => t.valid_to === null);
  if (!terms) throw unsupported('The subscription has no open terms');
  const termsKey = allTerms.map((t) => `${t.id}:${t.valid_from}:${t.valid_to ?? ''}`).join(',');
  const cycles = await loadCycles(ctx, subscriptionId);
  const today = formatISO(ctx.today);
  const current = cycles.find((c) => c.start_date <= today && today < c.end_date) ?? null;
  const cyclesWithCharges = new Set((await rows<{ cycle_id: string }>(ctx.trx, sql<{ cycle_id: string }>`
    select distinct cycle_id from member_charge where owner_id = ${ctx.ownerId} and status = 'issued'
      and cycle_id in (select id from billing_cycle where owner_id = ${ctx.ownerId} and subscription_id = ${subscriptionId})`)).map((r) => r.cycle_id));
  const base = { kind: i.kind, status: sub.status, termsKey };
  const iv: Interval = { unit: terms.interval_unit, count: terms.interval_count };

  if (i.kind === 'shift_renewal' || i.kind === 'advance_renewal') {
    if (sub.status === 'suspended') throw unprocessable('SUBSCRIPTION_SUSPENDED', 'The subscription is suspended; reactivate it with the provider renewal date');
    if (!current) throw unprocessable('NO_CURRENT_CYCLE', 'There is no current cycle to move');
    const newEnd = parseISO(i.newDate);
    if (i.newDate <= today) throw unprocessable('NEW_DATE_NOT_FUTURE', 'The new renewal date must be after today');
    if (i.newDate <= current.start_date) throw unprocessable('NEW_DATE_BEFORE_CYCLE_START', 'The new renewal date must be after the current cycle start');
    if (i.newDate === current.end_date) throw unprocessable('NEW_DATE_UNCHANGED', 'The renewal already falls on that date');
    if (i.kind === 'advance_renewal' && i.newDate > current.end_date) throw unprocessable('ADVANCE_NOT_EARLIER', 'To advance a renewal the new date must be earlier than the current one', { currentEnd: current.end_date });
    const after = cycles.filter((c) => c.start_date >= current.end_date);
    const next = { interval: iv, anchor: newEnd };
    return { ...base, moved: current, oldEnd: current.end_date, newEnd, next, future: recompute(newEnd, next, after, (id) => cyclesWithCharges.has(id)), remove: [], statusAfter: 'active', effectiveOn: i.newDate, tp: termsPlanFor(allTerms, current.start_date, current.end_date) };
  }

  if (i.kind === 'change_interval') {
    if (sub.status === 'suspended') throw unprocessable('SUBSCRIPTION_SUSPENDED', 'The subscription is suspended; reactivate it first');
    if (!current) throw unprocessable('NO_CURRENT_CYCLE', 'There is no current cycle');
    if (i.interval.unit === iv.unit && i.interval.count === iv.count) throw unprocessable('INTERVAL_UNCHANGED', 'The interval is already that one');
    const after = cycles.filter((c) => c.start_date >= current.end_date);
    const blocked = after.filter((c) => c.effects > 0);
    if (blocked.length > 0) throw unprocessable('CALENDAR_CHANGE_BLOCKED', 'Later cycles already have charges or a payment; undo them before changing the frequency', { cycles: blocked.map((c) => ({ seq: c.seq, start: c.start_date, end: c.end_date })) });
    const newEnd = parseISO(current.end_date);
    const next = { interval: i.interval, anchor: newEnd };
    return { ...base, moved: current, oldEnd: current.end_date, newEnd, next, future: recompute(newEnd, next, after, () => false), remove: [], statusAfter: 'active', effectiveOn: current.end_date, tp: termsPlanFor(allTerms, current.start_date, current.end_date) };
  }

  if (i.kind === 'suspend') {
    if (sub.status === 'suspended') throw unprocessable('SUBSCRIPTION_SUSPENDED', 'The subscription is already suspended');
    const future = cycles.filter((c) => c.start_date > today);
    const blocked = future.filter((c) => c.effects > 0);
    if (blocked.length > 0) throw unprocessable('CALENDAR_CHANGE_BLOCKED', 'A future cycle already has charges or a payment; undo them before suspending', { cycles: blocked.map((c) => ({ seq: c.seq, start: c.start_date, end: c.end_date })) });
    return { ...base, moved: null, oldEnd: current?.end_date ?? null, newEnd: null, next: null, future: [], remove: future, statusAfter: 'suspended', effectiveOn: today, tp: null };
  }

  // reactivate
  if (sub.status !== 'suspended') throw unprocessable('SUBSCRIPTION_NOT_SUSPENDED', 'The subscription is not suspended');
  const last = cycles[cycles.length - 1];
  if (!last) throw unprocessable('NO_CURRENT_CYCLE', 'The subscription has no cycles');
  if (i.renewalDate <= last.start_date) throw unprocessable('REACTIVATE_DATE_INVALID', 'The renewal date must be after the start of the last cycle', { lastCycleStart: last.start_date });
  const newEnd = parseISO(i.renewalDate);
  const next = { interval: iv, anchor: newEnd };
  return { ...base, moved: last, oldEnd: last.end_date, newEnd, next, future: [], remove: [], statusAfter: 'active', effectiveOn: i.renewalDate, tp: termsPlanFor(allTerms, last.start_date, last.end_date) };
}

const inputsOf = (subscriptionId: string, i: CalendarChangeInput) => ({ subscriptionId, ...i });
const fingerprint = (p: Plan, cycles: Cyc[]) => ({ terms: p.termsKey, status: p.status, cycles: cycles.map((c) => `${c.id}:${c.start_date}:${c.end_date}:${c.effects}`) });

const previewJson = (p: Plan) => ({
  kind: p.kind,
  effectiveOn: p.effectiveOn,
  statusAfter: p.statusAfter,
  currentCycle: p.moved ? { id: p.moved.id, seq: p.moved.seq, start: p.moved.start_date, oldEnd: p.oldEnd, newEnd: p.newEnd === null ? p.oldEnd : formatISO(p.newEnd) } : null,
  futureCycles: p.future.map((f) => ({ id: f.id, seq: f.seq, old: { start: f.oldStart, end: f.oldEnd }, new: { start: formatISO(f.newStart), end: formatISO(f.newEnd) }, hasCharges: f.hasCharges })),
  removedCycles: p.remove.map((c) => ({ id: c.id, seq: c.seq, start: c.start_date, end: c.end_date })),
  // RN-C08/C09: nada de esto cambia importes ni cobra días extra.
  amountsUnchanged: true,
  note: p.kind === 'suspend'
    ? 'La suspensión no descuenta cuota ni genera saldo a favor. No se emitirán ciclos ni cargos hasta reactivar.'
    : p.kind === 'reactivate'
      ? 'El ciclo se extiende hasta la nueva renovación sin cobrar días extra; los ciclos siguientes parten del nuevo día.'
      : 'Los cargos ya emitidos conservan su monto; solo se mueven los vencimientos de los ciclos siguientes.',
});

export async function previewCalendarChange(ctx: Ctx, subscriptionId: string, i: CalendarChangeInput) {
  const p = await buildPlan(ctx, subscriptionId, i);
  const cycles = await loadCycles(ctx, subscriptionId);
  return { ...previewJson(p), previewToken: makePreviewToken(ctx.previewSecret, { scope: 'subscription.calendar_change', ownerId: ctx.ownerId, inputs: inputsOf(subscriptionId, i), state: fingerprint(p, cycles) }, ctx.nowMs) };
}

const PARK = parseISO('9000-01-01');

export async function applyCalendarChange(ctx: Ctx, subscriptionId: string, body: CalendarChangeInput & { previewToken: string }) {
  const { previewToken, ...i } = body;
  const p = await buildPlan(ctx, subscriptionId, i as CalendarChangeInput);
  const cycles = await loadCycles(ctx, subscriptionId);
  checkPreviewToken(ctx.previewSecret, previewToken, { scope: 'subscription.calendar_change', ownerId: ctx.ownerId, inputs: inputsOf(subscriptionId, i as CalendarChangeInput), state: fingerprint(p, cycles) }, ctx.nowMs);
  const preview = previewJson(p);

  let afterTermsId: string | null = null;
  if (p.next && p.newEnd !== null && p.moved && p.tp) {
    const newEndIso = formatISO(p.newEnd);
    if (p.tp.mode === 'insert') {
      await sql`update subscription_terms set valid_to = ${newEndIso}::date where owner_id = ${ctx.ownerId} and id = ${p.tp.prevId}`.execute(ctx.trx);
      const t = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
        insert into subscription_terms (owner_id, subscription_id, valid_from, announced_price, interval_unit, interval_count, anchor_date, reason, created_by)
        values (${ctx.ownerId}, ${subscriptionId}, ${newEndIso}, ${formatMoney(parseMoney(p.tp.price))}, ${p.next.interval.unit}, ${p.next.interval.count},
                ${formatISO(p.next.anchor)}, ${i.reason.trim()}, ${ctx.actorId}) returning id`);
      afterTermsId = t!.id;
    } else {
      // El límite ya coincidía con un cambio anterior: se corre ese cambio (sin solapar vigencias, en el orden que corresponda).
      const setPrev = () => sql`update subscription_terms set valid_to = ${newEndIso}::date where owner_id = ${ctx.ownerId} and id = ${p.tp!.prevId}`.execute(ctx.trx);
      const setNext = () => sql`
        update subscription_terms set valid_from = ${newEndIso}::date, interval_unit = ${p.next!.interval.unit}, interval_count = ${p.next!.interval.count},
          anchor_date = ${formatISO(p.next!.anchor)}::date, reason = ${i.reason.trim()}
        where owner_id = ${ctx.ownerId} and id = ${p.tp!.nextId}`.execute(ctx.trx);
      if (newEndIso > p.oldEnd!) { await setNext(); await setPrev(); } else { await setPrev(); await setNext(); }
      afterTermsId = p.tp.nextId;
    }

    // 1) Aparca los ciclos futuros lejos: las restricciones de no superposición se comprueban por sentencia.
    for (const [idx, f] of p.future.entries()) {
      await sql`update billing_cycle set start_date = ${formatISO(PARK + idx * 2)}::date, end_date = ${formatISO(PARK + idx * 2 + 1)}::date where owner_id = ${ctx.ownerId} and id = ${f.id}`.execute(ctx.trx);
    }
    // 2) Mueve el límite del ciclo (en curso o último).
    if (formatISO(p.newEnd) !== p.oldEnd) {
      await sql`update billing_cycle set end_date = ${formatISO(p.newEnd)}::date where owner_id = ${ctx.ownerId} and id = ${p.moved.id}`.execute(ctx.trx);
    }
    // 3) Coloca los ciclos futuros con los términos nuevos y mueve los vencimientos de lo ya emitido.
    for (const f of p.future) {
      const snap = { announcedPrice: formatMoney(parseMoney(p.tp!.price)), interval: p.next.interval, anchor: formatISO(p.next.anchor), baseDays: baseDays(p.next.interval, f.newStart, f.newEnd) };
      await sql`
        update billing_cycle set start_date = ${formatISO(f.newStart)}::date, end_date = ${formatISO(f.newEnd)}::date, terms_id = ${afterTermsId}, terms_snapshot = ${JSON.stringify(snap)}::jsonb
        where owner_id = ${ctx.ownerId} and id = ${f.id}`.execute(ctx.trx);
      if (f.hasCharges && formatISO(f.newStart) !== f.oldStart) {
        await sql`update member_charge set due_date = ${formatISO(f.newStart)}::date where owner_id = ${ctx.ownerId} and cycle_id = ${f.id} and status = 'issued' and due_date = ${f.oldStart}::date`.execute(ctx.trx);
        await sql`
          update charge_adjustment set due_date = ${formatISO(f.newStart)}::date
          where owner_id = ${ctx.ownerId} and status = 'active' and kind = 'quota_change' and due_date = ${f.oldStart}::date
            and obligation_id in (select obligation_id from member_charge where owner_id = ${ctx.ownerId} and cycle_id = ${f.id})`.execute(ctx.trx);
      }
    }
  }
  for (const c of p.remove) await sql`delete from billing_cycle where owner_id = ${ctx.ownerId} and id = ${c.id}`.execute(ctx.trx);
  if (p.statusAfter !== p.status) await sql`update subscription set status = ${p.statusAfter} where owner_id = ${ctx.ownerId} and id = ${subscriptionId}`.execute(ctx.trx);

  const rec = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into calendar_change (owner_id, subscription_id, kind, effective_on, before_terms_id, after_terms_id, old_current_end, new_current_end, reason, preview, confirmed_by)
    values (${ctx.ownerId}, ${subscriptionId}, ${i.kind}, ${p.effectiveOn}, ${p.tp ? p.tp.prevId : null}, ${afterTermsId}, ${p.oldEnd},
            ${p.newEnd === null ? null : formatISO(p.newEnd)}, ${i.reason.trim()}, ${JSON.stringify(preview)}::jsonb, ${ctx.actorId}) returning id`);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: `calendar.${i.kind}`, entityType: 'subscription', entityId: subscriptionId, reason: i.reason.trim(),
    changes: { effectiveOn: p.effectiveOn, oldEnd: p.oldEnd, newEnd: p.newEnd === null ? null : formatISO(p.newEnd), removedCycles: p.remove.length } });

  await syncSubscription(ctx, subscriptionId); // genera ciclos/cargos que correspondan tras el cambio (p. ej. al reactivar)
  return { id: rec!.id, ...preview, subscription: await getSubscription(ctx, subscriptionId) };
}

export async function listCalendarChanges(ctx: Ctx, subscriptionId: string) {
  await ensureSubscription(ctx, subscriptionId);
  const r = await rows<{ id: string; kind: string; effective_on: string; old_current_end: string | null; new_current_end: string | null; reason: string; preview: unknown; created_at: unknown }>(ctx.trx, sql`
    select id, kind, effective_on, old_current_end, new_current_end, reason, preview, created_at from calendar_change
    where owner_id = ${ctx.ownerId} and subscription_id = ${subscriptionId} order by created_at desc, id`);
  return r.map((x) => ({ id: x.id, kind: x.kind, effectiveOn: x.effective_on, oldCurrentEnd: x.old_current_end, newCurrentEnd: x.new_current_end, reason: x.reason, preview: x.preview, createdAt: ts(x.created_at) }));
}
