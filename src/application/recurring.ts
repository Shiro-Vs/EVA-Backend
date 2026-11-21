import { sql } from 'kysely';
import { cycleEnd, type Interval } from '../domain/calendar.js';
import { formatISO, parseISO, type LocalDate } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { assertActiveCategory } from './categories.js';
import { ts, type Ctx } from './context.js';
import { activeAccount, createOperation, requireOwned } from './operations.js';
import type { Deduction } from './goals.js';

const m = (v: bigint | string) => (typeof v === 'bigint' ? formatMoney(v) : formatMoney(parseMoney(v)));

export interface TemplateInput {
  name: string;
  kind: 'income' | 'expense';
  accountId: string;
  amount: string;
  categoryId?: string | null;
  contactId?: string | null;
  description?: string;
  interval: Interval;
  startDate: string;
  endDate?: string | null;
}

interface TplRow {
  id: string; name: string; kind: 'income' | 'expense'; account_id: string; account_name: string; amount: string; category_id: string | null; contact_id: string | null; description: string;
  interval_unit: Interval['unit']; interval_count: number; anchor_date: string; end_date: string | null; generated_through: string; status: string; version: number; created_at: unknown;
}

const sel = sql`
  select t.id, t.name, t.kind, t.account_id, a.name as account_name, t.amount, t.category_id, t.contact_id, t.description, t.interval_unit, t.interval_count, t.anchor_date, t.end_date,
         t.generated_through, t.status, t.version, t.created_at
  from recurring_template t join account a on a.id = t.account_id and a.owner_id = t.owner_id`;

const intervalOf = (t: TplRow): Interval => ({ unit: t.interval_unit, count: t.interval_count });

/** Fechas de la plantilla en orden: ancla, ancla + intervalo… (el día del mes se conserva: 31 → 28 → 31). */
function* dates(t: TplRow, until: LocalDate): Generator<LocalDate> {
  const anchor = parseISO(t.anchor_date);
  const end = t.end_date ? parseISO(t.end_date) : null;
  let cur = anchor;
  for (let i = 0; i < 5000 && cur <= until && (end === null || cur <= end); i++) {
    yield cur;
    cur = cycleEnd(cur, anchor, intervalOf(t));
  }
}

function nextAfter(t: TplRow, after: LocalDate): LocalDate | null {
  const anchor = parseISO(t.anchor_date);
  const end = t.end_date ? parseISO(t.end_date) : null;
  let cur = anchor;
  for (let i = 0; i < 5000; i++) {
    if (cur > after) return end !== null && cur > end ? null : cur;
    cur = cycleEnd(cur, anchor, intervalOf(t));
  }
  return null;
}

/** Genera de forma idempotente las ocurrencias vencidas (hasta hoy) de las plantillas activas. No registra ningún movimiento. */
export async function syncRecurring(ctx: Ctx, templateId?: string) {
  const ts_ = await rows<TplRow>(ctx.trx, sql<TplRow>`${sel} where t.owner_id = ${ctx.ownerId} and t.status = 'active' and (${templateId ?? null}::uuid is null or t.id = ${templateId ?? null}) order by t.id for update of t`);
  for (const t of ts_) {
    const through = parseISO(t.generated_through);
    let last = through;
    for (const d of dates(t, ctx.today)) {
      if (d <= through) continue;
      await sql`insert into expected_occurrence (owner_id, template_id, due_date, amount) values (${ctx.ownerId}, ${t.id}, ${formatISO(d)}, ${m(t.amount)}) on conflict (template_id, due_date) do nothing`.execute(ctx.trx);
      last = d;
    }
    if (last > through) await sql`update recurring_template set generated_through = ${formatISO(last)} where owner_id = ${ctx.ownerId} and id = ${t.id}`.execute(ctx.trx);
  }
}

const tplView = (t: TplRow, ctx: Ctx) => {
  const next = t.status === 'active' ? nextAfter(t, parseISO(t.generated_through) > ctx.today ? parseISO(t.generated_through) : ctx.today) : null;
  return {
    id: t.id, name: t.name, kind: t.kind, account: { id: t.account_id, name: t.account_name }, amount: m(t.amount), categoryId: t.category_id, contactId: t.contact_id, description: t.description,
    interval: intervalOf(t), startDate: t.anchor_date, endDate: t.end_date, status: t.status, nextDue: next === null ? null : formatISO(next), version: t.version, createdAt: ts(t.created_at),
  };
};

async function validate(ctx: Ctx, i: Partial<TemplateInput>) {
  if (i.accountId) { const a = await activeAccount(ctx, i.accountId); if (a.type === 'credit' && i.kind === 'income') throw unprocessable('VALIDATION_ERROR', 'Un ingreso no se registra en una tarjeta de crédito'); }
  if (i.categoryId) await assertActiveCategory(ctx, i.categoryId);
  if (i.contactId) await requireOwned(ctx, 'contact', i.contactId);
  if (i.amount && parseMoney(i.amount) <= 0n) throw unprocessable('VALIDATION_ERROR', 'El importe debe ser positivo');
  if (i.endDate && i.startDate && i.endDate < i.startDate) throw unprocessable('RECURRING_DATES', 'La fecha final no puede ser anterior al inicio');
}

export async function createTemplate(ctx: Ctx, i: TemplateInput) {
  await validate(ctx, i);
  const start = parseISO(i.startDate);
  const r = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into recurring_template (owner_id, name, kind, account_id, amount, category_id, contact_id, description, interval_unit, interval_count, anchor_date, end_date, generated_through)
    values (${ctx.ownerId}, ${i.name.trim()}, ${i.kind}, ${i.accountId}, ${m(i.amount)}, ${i.categoryId ?? null}, ${i.contactId ?? null}, ${i.description?.trim() ?? ''}, ${i.interval.unit}, ${i.interval.count},
            ${i.startDate}, ${i.endDate ?? null}, ${formatISO(start - 1)}) returning id`);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'recurring.create', entityType: 'recurring_template', entityId: r!.id, changes: { name: i.name.trim(), amount: m(i.amount) } });
  return getTemplate(ctx, r!.id);
}

async function loadTemplate(ctx: Ctx, id: string, forUpdate = false) {
  const t = await one<TplRow>(ctx.trx, sql<TplRow>`${sel} where t.owner_id = ${ctx.ownerId} and t.id = ${id} ${forUpdate ? sql`for update of t` : sql``}`);
  if (!t) throw notFound('Recurring template');
  return t;
}

export async function getTemplate(ctx: Ctx, id: string) {
  await syncRecurring(ctx, id);
  const t = await loadTemplate(ctx, id);
  const occ = await rows<OccRow>(ctx.trx, sql<OccRow>`${occSel} where o.owner_id = ${ctx.ownerId} and o.template_id = ${id} order by o.due_date desc limit 50`);
  return { ...tplView(t, ctx), occurrences: occ.map(occView) };
}

export async function listTemplates(ctx: Ctx, status = 'active') {
  await syncRecurring(ctx);
  const r = await rows<TplRow>(ctx.trx, sql<TplRow>`${sel} where t.owner_id = ${ctx.ownerId} and t.status = ${status} order by lower(t.name), t.created_at`);
  const pend = await rows<{ template_id: string; n: string }>(ctx.trx, sql<{ template_id: string; n: string }>`select template_id, count(*) as n from expected_occurrence where owner_id = ${ctx.ownerId} and status = 'pending' group by template_id`);
  return r.map((t) => ({ ...tplView(t, ctx), pendingCount: Number(pend.find((p) => p.template_id === t.id)?.n ?? 0) }));
}

/** Cambiar importe, cuenta, frecuencia o inicio afecta solo a lo que aún no se confirmó: las ocurrencias pendientes futuras se regeneran. */
export async function patchTemplate(ctx: Ctx, id: string, version: number, p: Partial<Omit<TemplateInput, 'kind'>>) {
  const t = await loadTemplate(ctx, id, true);
  if (t.version !== version) throw conflict('CONFLICT_VERSION', 'The template was modified; reload and retry');
  await validate(ctx, { ...p, kind: t.kind, startDate: p.startDate ?? t.anchor_date });
  const scheduleChanged = p.interval !== undefined || p.startDate !== undefined || p.endDate !== undefined;
  const next = {
    name: (p.name ?? t.name).trim(), account_id: p.accountId ?? t.account_id, amount: p.amount ? m(p.amount) : m(t.amount),
    category_id: p.categoryId === undefined ? t.category_id : p.categoryId, contact_id: p.contactId === undefined ? t.contact_id : p.contactId,
    description: p.description === undefined ? t.description : p.description.trim(), unit: p.interval?.unit ?? t.interval_unit, count: p.interval?.count ?? t.interval_count,
    anchor: p.startDate ?? t.anchor_date, end: p.endDate === undefined ? t.end_date : p.endDate,
  };
  if (scheduleChanged) {
    // Lo ya decidido (confirmado u omitido) se conserva; lo pendiente se vuelve a proponer según el calendario nuevo.
    await sql`delete from expected_occurrence where owner_id = ${ctx.ownerId} and template_id = ${id} and status = 'pending'`.execute(ctx.trx);
    const decided = await one<{ d: string | null }>(ctx.trx, sql<{ d: string | null }>`select max(due_date) as d from expected_occurrence where template_id = ${id}`);
    const base = formatISO(parseISO(next.anchor) - 1);
    const through = decided?.d && decided.d > base ? decided.d : base;
    await sql`update recurring_template set generated_through = ${through} where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  }
  await sql`
    update recurring_template set name = ${next.name}, account_id = ${next.account_id}, amount = ${next.amount}, category_id = ${next.category_id}, contact_id = ${next.contact_id},
      description = ${next.description}, interval_unit = ${next.unit}, interval_count = ${next.count}, anchor_date = ${next.anchor}, end_date = ${next.end}
    where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'recurring.update', entityType: 'recurring_template', entityId: id });
  return getTemplate(ctx, id);
}

export async function setTemplateStatus(ctx: Ctx, id: string, status: 'active' | 'paused' | 'archived') {
  const t = await loadTemplate(ctx, id, true);
  // Reanudar no inunda de propuestas lo que pasó mientras estuvo en pausa: se retoma desde hoy.
  const through = status === 'active' && t.status !== 'active' ? formatISO(ctx.today - 1 > parseISO(t.generated_through) ? ctx.today - 1 : parseISO(t.generated_through)) : t.generated_through;
  await sql`update recurring_template set status = ${status}, generated_through = ${through} where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: `recurring.${status}`, entityType: 'recurring_template', entityId: id });
  return getTemplate(ctx, id);
}

// ───────────────────────── Ocurrencias ─────────────────────────

interface OccRow { id: string; template_id: string; template_name: string; kind: string; due_date: string; amount: string; status: string; operation_id: string | null; op_status: string | null; decided_at: unknown; note: string | null }

const occSel = sql`
  select o.id, o.template_id, t.name as template_name, t.kind, o.due_date, o.amount, o.status, o.operation_id, fo.status as op_status, o.decided_at, o.note
  from expected_occurrence o join recurring_template t on t.id = o.template_id and t.owner_id = o.owner_id
  left join financial_operation fo on fo.id = o.operation_id and fo.owner_id = o.owner_id`;

const occView = (o: OccRow) => ({
  id: o.id, templateId: o.template_id, templateName: o.template_name, kind: o.kind, dueDate: o.due_date, amount: m(o.amount), status: o.status,
  operationId: o.operation_id, operationReversed: o.op_status === 'reversed', decidedAt: o.decided_at ? ts(o.decided_at) : null, note: o.note,
});

/** Lo que espera una respuesta del usuario: ocurrencias vencidas sin decidir y lo que viene en los próximos días. */
export async function pending(ctx: Ctx, within = 7) {
  await syncRecurring(ctx);
  const due = await rows<OccRow>(ctx.trx, sql<OccRow>`${occSel} where o.owner_id = ${ctx.ownerId} and o.status = 'pending' order by o.due_date, o.created_at`);
  const upcoming = [];
  const horizon = ctx.today + within;
  for (const t of await rows<TplRow>(ctx.trx, sql<TplRow>`${sel} where t.owner_id = ${ctx.ownerId} and t.status = 'active'`)) {
    const n = nextAfter(t, ctx.today);
    if (n !== null && n <= horizon) upcoming.push({ templateId: t.id, name: t.name, kind: t.kind, dueDate: formatISO(n), amount: m(t.amount), account: { id: t.account_id, name: t.account_name } });
  }
  upcoming.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return { due: due.map(occView), upcoming };
}

async function loadOcc(ctx: Ctx, id: string) {
  const o = await one<OccRow & { account_id: string; category_id: string | null; contact_id: string | null; description: string; tname: string }>(ctx.trx, sql`
    select o.id, o.template_id, t.name as template_name, t.name as tname, t.kind, o.due_date, o.amount, o.status, o.operation_id, null as op_status, o.decided_at, o.note,
           t.account_id, t.category_id, t.contact_id, t.description
    from expected_occurrence o join recurring_template t on t.id = o.template_id and t.owner_id = o.owner_id
    where o.owner_id = ${ctx.ownerId} and o.id = ${id} for update of o`);
  if (!o) throw notFound('Occurrence');
  return o;
}

export interface ConfirmInput { amount?: string; accountId?: string; date?: string; description?: string; categoryId?: string | null; goalDeductions?: Deduction[]; acceptReserveShortfall?: boolean }

/** Confirmar registra el movimiento real (con los datos esperados o los que el usuario corrija). Solo entonces cambia una cuenta. */
export async function confirmOccurrence(ctx: Ctx, id: string, i: ConfirmInput) {
  const o = await loadOcc(ctx, id);
  if (o.status !== 'pending') throw unprocessable('OCCURRENCE_DECIDED', 'Esta ocurrencia ya se decidió');
  const date = i.date ?? (o.due_date > formatISO(ctx.today) ? formatISO(ctx.today) : o.due_date);
  const op = await createOperation(ctx, {
    kind: o.kind as 'income' | 'expense', accountId: i.accountId ?? o.account_id, amount: i.amount ?? m(o.amount), date,
    description: i.description ?? (o.description || o.tname), categoryId: i.categoryId === undefined ? o.category_id : i.categoryId, contactId: o.contact_id,
    goalDeductions: i.goalDeductions, acceptReserveShortfall: i.acceptReserveShortfall,
  });
  await sql`update expected_occurrence set status = 'confirmed', operation_id = ${op.id}, decided_at = now() where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'recurring.confirm', entityType: 'expected_occurrence', entityId: id, changes: { operationId: op.id, amount: i.amount ?? m(o.amount) } });
  return { occurrence: await getOccurrence(ctx, id), operation: op };
}

export async function skipOccurrence(ctx: Ctx, id: string, note?: string) {
  const o = await loadOcc(ctx, id);
  if (o.status !== 'pending') throw unprocessable('OCCURRENCE_DECIDED', 'Esta ocurrencia ya se decidió');
  await sql`update expected_occurrence set status = 'skipped', decided_at = now(), note = ${note?.trim() || null} where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'recurring.skip', entityType: 'expected_occurrence', entityId: id, reason: note ?? null });
  return getOccurrence(ctx, id);
}

/**
 * Vincula un movimiento que YA existe (por ejemplo, el que llegó por correo o foto) a la ocurrencia: no se crea otro (RN-RE04).
 * Si el importe o la fecha difieren, se informa.
 */
export async function linkOccurrence(ctx: Ctx, id: string, operationId: string) {
  const o = await loadOcc(ctx, id);
  if (o.status !== 'pending') throw unprocessable('OCCURRENCE_DECIDED', 'Esta ocurrencia ya se decidió');
  const op = await one<{ kind: string; status: string; occurred_on: string; amount: string }>(ctx.trx, sql<{ kind: string; status: string; occurred_on: string; amount: string }>`
    select o.kind, o.status, o.occurred_on, abs(coalesce(sum(e.amount), 0)) as amount from financial_operation o left join account_entry e on e.operation_id = o.id and e.owner_id = o.owner_id
    where o.owner_id = ${ctx.ownerId} and o.id = ${operationId} group by o.id`);
  if (!op) throw notFound('Operation');
  if (op.status !== 'confirmed' || op.kind !== o.kind) throw unprocessable('OPERATION_MISMATCH', `Solo un ${o.kind === 'income' ? 'ingreso' : 'gasto'} confirmado se puede vincular a esta ocurrencia`);
  const taken = await one(ctx.trx, sql`select 1 from expected_occurrence where owner_id = ${ctx.ownerId} and operation_id = ${operationId}`);
  if (taken) throw conflict('OPERATION_ALREADY_LINKED', 'Ese movimiento ya cumple otra ocurrencia');
  await sql`update expected_occurrence set status = 'confirmed', operation_id = ${operationId}, decided_at = now() where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'recurring.link', entityType: 'expected_occurrence', entityId: id, changes: { operationId } });
  const warnings: string[] = [];
  if (parseMoney(op.amount) !== parseMoney(o.amount)) warnings.push('AMOUNT_DIFFERS');
  if (op.occurred_on !== o.due_date) warnings.push('DATE_DIFFERS');
  return { occurrence: await getOccurrence(ctx, id), warnings, expectedAmount: m(o.amount), actualAmount: m(op.amount), expectedDate: o.due_date, actualDate: op.occurred_on };
}

/** Reabre una ocurrencia omitida, o confirmada cuyo movimiento se revirtió, para decidirla de nuevo. */
export async function reopenOccurrence(ctx: Ctx, id: string) {
  const o = await one<OccRow>(ctx.trx, sql<OccRow>`${occSel} where o.owner_id = ${ctx.ownerId} and o.id = ${id}`);
  if (!o) throw notFound('Occurrence');
  const reversed = o.status === 'confirmed' && o.op_status === 'reversed';
  if (o.status !== 'skipped' && !reversed) throw unprocessable('OCCURRENCE_NOT_REOPENABLE', 'Solo se reabre una ocurrencia omitida o cuyo movimiento fue revertido');
  await sql`update expected_occurrence set status = 'pending', operation_id = null, decided_at = null where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'recurring.reopen', entityType: 'expected_occurrence', entityId: id });
  return getOccurrence(ctx, id);
}

export async function getOccurrence(ctx: Ctx, id: string) {
  const o = await one<OccRow>(ctx.trx, sql<OccRow>`${occSel} where o.owner_id = ${ctx.ownerId} and o.id = ${id}`);
  if (!o) throw notFound('Occurrence');
  return occView(o);
}
