import { sql } from 'kysely';
import { carryOver, levelOf, periodOf, periodsFrom, previousPeriod, type BudgetPeriod, type Period } from '../domain/budget.js';
import { formatISO, parseISO } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { assertActiveCategory } from './categories.js';
import { ts, type Ctx } from './context.js';

const m = (v: bigint | string) => (typeof v === 'bigint' ? formatMoney(v) : formatMoney(parseMoney(v)));

export interface BudgetInput {
  name: string;
  categoryId?: string | null;
  includeSubcategories?: boolean;
  period: BudgetPeriod;
  limit: string;
  thresholds?: number[];
  rollover?: boolean;
  rolloverCap?: string | null;
  sharedView?: 'origin_cycle' | 'receipt_date';
  startsOn?: string;
}

interface BudgetRow {
  id: string; name: string; category_id: string | null; category_name: string | null; include_children: boolean; period: BudgetPeriod; starts_on: string; rollover: boolean;
  rollover_cap: string | null; shared_view: 'origin_cycle' | 'receipt_date'; status: string; version: number; created_at: unknown;
}

const sel = sql`
  select b.id, b.name, b.category_id, c.name as category_name, b.include_children, b.period, b.starts_on, b.rollover, b.rollover_cap, b.shared_view, b.status, b.version, b.created_at
  from budget b left join category c on c.id = b.category_id and c.owner_id = b.owner_id`;

async function load(ctx: Ctx, id: string, forUpdate = false) {
  if (forUpdate) await sql`select 1 from budget where owner_id = ${ctx.ownerId} and id = ${id} for update`.execute(ctx.trx);
  const b = await one<BudgetRow>(ctx.trx, sql<BudgetRow>`${sel} where b.owner_id = ${ctx.ownerId} and b.id = ${id}`);
  if (!b) throw notFound('Budget');
  return b;
}

const thresholdsOf = async (ctx: Ctx, id: string) =>
  (await rows<{ percent: number }>(ctx.trx, sql<{ percent: number }>`select percent from budget_threshold where owner_id = ${ctx.ownerId} and budget_id = ${id} order by percent`)).map((r) => r.percent);

const limitAt = async (ctx: Ctx, id: string, date: number) => {
  const r = await one<{ amount: string }>(ctx.trx, sql<{ amount: string }>`select amount from budget_limit where budget_id = ${id} and valid_from <= ${formatISO(date)}::date order by valid_from desc limit 1`);
  return r ? parseMoney(r.amount) : 0n;
};

/** Categorías que cuenta el presupuesto: la suya y, si se indica, sus subcategorías (RN-BU02). Nulo = todas. */
async function scope(ctx: Ctx, b: BudgetRow): Promise<string[] | null> {
  if (!b.category_id) return null;
  if (!b.include_children) return [b.category_id];
  const kids = await rows<{ id: string }>(ctx.trx, sql<{ id: string }>`select id from category where owner_id = ${ctx.ownerId} and parent_id = ${b.category_id}`);
  return [b.category_id, ...kids.map((k) => k.id)];
}

interface Spend {
  gross: bigint; offset: bigint; spent: bigint;
  items: Array<{ operationId: string; date: string; description: string; amount: bigint; categoryId: string | null; cycleId: string | null }>;
}

/**
 * Consumo del período (RN-BU02, BU06, BU07). Solo gastos de consumo confirmados: ni capital de préstamos, ni devoluciones, ni lo revertido.
 * Un servicio compartido consume por costo real neto: pago − cobros reales atribuibles; las cuotas impagas NO reducen el costo.
 */
async function spendIn(ctx: Ctx, b: BudgetRow, p: Period): Promise<Spend> {
  const cats = await scope(ctx, b);
  const start = formatISO(p.start); const end = formatISO(p.end);
  const ops = await rows<{ id: string; occurred_on: string; description: string; category_id: string | null; amount: string; cycle_id: string | null }>(ctx.trx, sql`
    select o.id, o.occurred_on, o.description, o.category_id, -sum(e.amount) as amount, (select sp.cycle_id from supplier_payment sp where sp.operation_id = o.id and sp.status = 'active') as cycle_id
    from financial_operation o join account_entry e on e.operation_id = o.id and e.owner_id = o.owner_id
    where o.owner_id = ${ctx.ownerId} and o.kind = 'expense' and o.status = 'confirmed' and o.concept = 'ordinary'
      and o.occurred_on between ${start}::date and ${end}::date
      and (${cats}::uuid[] is null or o.category_id = any(${cats}::uuid[]))
      and not exists (select 1 from refund f where f.operation_id = o.id)
    group by o.id order by o.occurred_on, o.created_at`);
  const gross = ops.reduce((a, o) => a + parseMoney(o.amount), 0n);

  // Cobros a restar. «Ciclo de origen»: todo lo cobrado de los ciclos que se pagaron en este período, sin importar cuándo entró.
  // «Fecha de recepción»: lo que entró en este período de cualquier ciclo ya pagado dentro del alcance.
  const offsetRow = b.shared_view === 'origin_cycle'
    ? await one<{ total: string }>(ctx.trx, sql<{ total: string }>`
        select coalesce(sum(a.amount), 0.00) as total
        from supplier_payment sp join financial_operation o on o.id = sp.operation_id and o.owner_id = sp.owner_id
        join member_charge mc on mc.cycle_id = sp.cycle_id and mc.owner_id = sp.owner_id and mc.status = 'issued'
        join payment_allocation a on a.obligation_id = mc.obligation_id and a.status = 'active'
        join receipt r on r.id = a.receipt_id and r.status = 'active'
        where sp.owner_id = ${ctx.ownerId} and sp.status = 'active' and o.status = 'confirmed' and o.occurred_on between ${start}::date and ${end}::date
          and (${cats}::uuid[] is null or o.category_id = any(${cats}::uuid[]))`)
    : await one<{ total: string }>(ctx.trx, sql<{ total: string }>`
        select coalesce(sum(a.amount), 0.00) as total
        from supplier_payment sp join financial_operation o on o.id = sp.operation_id and o.owner_id = sp.owner_id
        join member_charge mc on mc.cycle_id = sp.cycle_id and mc.owner_id = sp.owner_id and mc.status = 'issued'
        join payment_allocation a on a.obligation_id = mc.obligation_id and a.status = 'active'
        join receipt r on r.id = a.receipt_id and r.status = 'active'
        where sp.owner_id = ${ctx.ownerId} and sp.status = 'active' and o.status = 'confirmed' and o.occurred_on <= ${end}::date
          and r.received_on between ${start}::date and ${end}::date
          and (${cats}::uuid[] is null or o.category_id = any(${cats}::uuid[]))`);
  const offset = parseMoney(offsetRow!.total);
  const spent = gross > offset ? gross - offset : 0n;
  return {
    gross, offset, spent,
    items: ops.map((o) => ({ operationId: o.id, date: o.occurred_on, description: o.description, amount: parseMoney(o.amount), categoryId: o.category_id, cycleId: o.cycle_id })),
  };
}

/** Estado de un período: límite, arrastre, consumo, aviso y excedente. */
async function periodStatus(ctx: Ctx, b: BudgetRow, p: Period, thresholds: number[]) {
  const first = parseISO(b.starts_on);
  const cap = b.rollover_cap === null ? null : parseMoney(b.rollover_cap);
  let carry = 0n;
  if (b.rollover) {
    // El arrastre se calcula período a período desde el inicio del presupuesto (RN-BU05).
    for (const past of periodsFrom(first, previousPeriod(p, b.period).end, b.period)) {
      if (past.start >= p.start) break;
      const avail = (await limitAt(ctx, b.id, past.start)) + carry;
      const s = await spendIn(ctx, b, past);
      carry = carryOver(avail, s.spent, cap);
    }
  }
  const limit = await limitAt(ctx, b.id, p.start);
  const s = await spendIn(ctx, b, p);
  const available = limit + carry;
  const lv = levelOf(s.spent, available, thresholds);
  return {
    s, status: {
      period: { start: formatISO(p.start), end: formatISO(p.end), kind: b.period },
      limit: m(limit), carry: m(carry), available: m(available), spent: m(s.spent), remaining: m(available > s.spent ? available - s.spent : 0n),
      overBy: m(s.spent > available ? s.spent - available : 0n), percent: lv.percent, thresholdsReached: lv.reached, level: lv.level, exceeded: lv.exceeded,
      started: p.end >= first,
      breakdown: { gross: m(s.gross), collectionsOffset: m(s.offset) },
    },
  };
}

const header = (b: BudgetRow, thresholds: number[]) => ({
  id: b.id, name: b.name, category: b.category_id ? { id: b.category_id, name: b.category_name } : null, includeSubcategories: b.include_children, period: b.period, startsOn: b.starts_on,
  thresholds, rollover: b.rollover, rolloverCap: b.rollover_cap === null ? null : m(b.rollover_cap), sharedView: b.shared_view, status: b.status, version: b.version, createdAt: ts(b.created_at),
});

export async function listBudgets(ctx: Ctx, date?: string, status = 'active') {
  const on = date ? parseISO(date) : ctx.today;
  const bs = await rows<BudgetRow>(ctx.trx, sql<BudgetRow>`${sel} where b.owner_id = ${ctx.ownerId} and b.status = ${status} order by lower(b.name), b.created_at`);
  const out = [];
  for (const b of bs) {
    const th = await thresholdsOf(ctx, b.id);
    out.push({ ...header(b, th), current: (await periodStatus(ctx, b, periodOf(on, b.period), th)).status });
  }
  return out;
}

export async function getBudget(ctx: Ctx, id: string, date?: string) {
  const b = await load(ctx, id);
  const th = await thresholdsOf(ctx, id);
  const on = date ? parseISO(date) : ctx.today;
  const { s, status } = await periodStatus(ctx, b, periodOf(on, b.period), th);
  // Servicios compartidos incluidos en el consumo: cuánto costó realmente y cuánto falta cobrar (RN-BU06, RN-BU08).
  const shared = [];
  for (const it of s.items.filter((x) => x.cycleId)) {
    const t = await one<{ expected: string; received: string }>(ctx.trx, sql<{ expected: string; received: string }>`
      select coalesce(sum(v.issued_amount + v.adjustments_total), 0.00) as expected, coalesce(sum(v.applied_total), 0.00) as received
      from v_obligation_balance v join member_charge mc on mc.obligation_id = v.obligation_id where v.owner_id = ${ctx.ownerId} and mc.cycle_id = ${it.cycleId}`);
    const expected = parseMoney(t!.expected); const received = parseMoney(t!.received);
    // Ejemplo (RN-BU08): pago 47, cuotas exigibles 36, cobros 24 → previsto 11, real 23, pendiente 12.
    shared.push({ operationId: it.operationId, cycleId: it.cycleId, date: it.date, paid: m(it.amount), expectedFromOthers: m(expected), receivedFromOthers: m(received), pendingFromOthers: m(expected - received), projectedCost: m(it.amount - expected), realCost: m(it.amount - received) });
  }
  return {
    ...header(b, th), current: status,
    items: s.items.map((x) => ({ operationId: x.operationId, date: x.date, description: x.description, amount: m(x.amount), categoryId: x.categoryId, sharedService: !!x.cycleId })),
    shared,
  };
}

/** Últimos períodos con su consumo (más reciente primero). */
export async function budgetHistory(ctx: Ctx, id: string, count = 6) {
  const b = await load(ctx, id);
  const th = await thresholdsOf(ctx, id);
  const out = [];
  let p = periodOf(ctx.today, b.period);
  for (let i = 0; i < count; i++) {
    out.push((await periodStatus(ctx, b, p, th)).status);
    p = previousPeriod(p, b.period);
  }
  return out;
}

async function validate(ctx: Ctx, i: Partial<BudgetInput>) {
  if (i.categoryId) await assertActiveCategory(ctx, i.categoryId);
  const th = i.thresholds ? [...new Set(i.thresholds)].sort((a, b) => a - b) : undefined;
  if (th && th.some((t) => !Number.isInteger(t) || t < 1 || t > 1000)) throw unprocessable('VALIDATION_ERROR', 'Los avisos deben ser porcentajes enteros entre 1 y 1000');
  if (i.rolloverCap && !i.rollover) throw unprocessable('ROLLOVER_REQUIRED', 'El tope de arrastre solo aplica si el presupuesto arrastra el saldo no gastado');
  if (i.rolloverCap && parseMoney(i.rolloverCap) <= 0n) throw unprocessable('VALIDATION_ERROR', 'El tope de arrastre debe ser positivo');
  return th;
}

export async function createBudget(ctx: Ctx, i: BudgetInput) {
  const th = (await validate(ctx, i)) ?? [80, 100];
  const limit = parseMoney(i.limit);
  if (limit <= 0n) throw unprocessable('VALIDATION_ERROR', 'El límite del presupuesto debe ser positivo');
  const startsOn = i.startsOn ? periodOf(parseISO(i.startsOn), i.period).start : periodOf(ctx.today, i.period).start;
  const dup = await one(ctx.trx, sql`select 1 from budget where owner_id = ${ctx.ownerId} and status = 'active' and period = ${i.period}
    and coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(${i.categoryId ?? null}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`);
  if (dup) throw conflict('BUDGET_EXISTS', 'Ya tienes un presupuesto activo para esa categoría y ese período');
  const r = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into budget (owner_id, name, category_id, include_children, period, starts_on, rollover, rollover_cap, shared_view)
    values (${ctx.ownerId}, ${i.name.trim()}, ${i.categoryId ?? null}, ${i.includeSubcategories ?? true}, ${i.period}, ${formatISO(startsOn)}, ${i.rollover ?? false},
            ${i.rolloverCap ? m(i.rolloverCap) : null}, ${i.sharedView ?? 'origin_cycle'}) returning id`);
  await sql`insert into budget_limit (owner_id, budget_id, valid_from, amount) values (${ctx.ownerId}, ${r!.id}, ${formatISO(startsOn)}, ${m(limit)})`.execute(ctx.trx);
  for (const t of th) await sql`insert into budget_threshold (owner_id, budget_id, percent) values (${ctx.ownerId}, ${r!.id}, ${t})`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'budget.create', entityType: 'budget', entityId: r!.id, changes: { name: i.name.trim(), period: i.period, limit: m(limit) } });
  return getBudget(ctx, r!.id);
}

/** Cambiar el límite rige desde el inicio del período actual: los anteriores no se reescriben. */
export async function patchBudget(ctx: Ctx, id: string, version: number, p: Partial<Omit<BudgetInput, 'categoryId' | 'period' | 'startsOn'>>) {
  const b = await load(ctx, id, true);
  if (b.status !== 'active') throw unprocessable('BUDGET_ARCHIVED', 'El presupuesto está archivado');
  if (b.version !== version) throw conflict('CONFLICT_VERSION', 'The budget was modified; reload and retry');
  const th = await validate(ctx, { ...p, rollover: p.rollover ?? b.rollover });
  const rollover = p.rollover ?? b.rollover;
  const cap = p.rolloverCap === undefined ? (rollover ? b.rollover_cap : null) : p.rolloverCap;
  if (cap && !rollover) throw unprocessable('ROLLOVER_REQUIRED', 'El tope de arrastre solo aplica si el presupuesto arrastra el saldo no gastado');
  if (p.limit !== undefined && parseMoney(p.limit) <= 0n) throw unprocessable('VALIDATION_ERROR', 'El límite del presupuesto debe ser positivo');
  await sql`
    update budget set name = ${(p.name ?? b.name).trim()}, include_children = ${p.includeSubcategories ?? b.include_children}, rollover = ${rollover},
      rollover_cap = ${rollover && cap ? m(cap) : null}, shared_view = ${p.sharedView ?? b.shared_view} where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  if (th) {
    await sql`delete from budget_threshold where owner_id = ${ctx.ownerId} and budget_id = ${id}`.execute(ctx.trx);
    for (const t of th) await sql`insert into budget_threshold (owner_id, budget_id, percent) values (${ctx.ownerId}, ${id}, ${t})`.execute(ctx.trx);
  }
  if (p.limit !== undefined) {
    const from = formatISO(periodOf(ctx.today, b.period).start);
    await sql`
      insert into budget_limit (owner_id, budget_id, valid_from, amount) values (${ctx.ownerId}, ${id}, ${from}, ${m(parseMoney(p.limit))})
      on conflict (budget_id, valid_from) do update set amount = excluded.amount`.execute(ctx.trx);
  }
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'budget.update', entityType: 'budget', entityId: id });
  return getBudget(ctx, id);
}

export async function setBudgetStatus(ctx: Ctx, id: string, status: 'active' | 'archived') {
  const b = await load(ctx, id, true);
  if (status === 'active') {
    const dup = await one(ctx.trx, sql`select 1 from budget where owner_id = ${ctx.ownerId} and status = 'active' and id <> ${id} and period = ${b.period}
      and coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(${b.category_id}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`);
    if (dup) throw conflict('BUDGET_EXISTS', 'Ya tienes un presupuesto activo para esa categoría y ese período');
  }
  await sql`update budget set status = ${status} where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: status === 'archived' ? 'budget.archive' : 'budget.restore', entityType: 'budget', entityId: id });
  return getBudget(ctx, id);
}

/** Elimina un presupuesto (es una regla de aviso: no borra movimientos reales). */
export async function deleteBudget(ctx: Ctx, id: string) {
  const b = await load(ctx, id, true);
  await sql`delete from budget_threshold where owner_id = ${ctx.ownerId} and budget_id = ${id}`.execute(ctx.trx);
  await sql`delete from budget_limit where owner_id = ${ctx.ownerId} and budget_id = ${id}`.execute(ctx.trx);
  await sql`delete from budget where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'budget.delete', entityType: 'budget', entityId: id, changes: { name: b.name } });
  return { id, deleted: true };
}

/** Presupuestos que un gasto toca y cómo quedan (avisos que NO bloquean): se devuelve al registrar el gasto. */
export async function impactOf(ctx: Ctx, categoryId: string | null, date: number) {
  const bs = await rows<BudgetRow>(ctx.trx, sql<BudgetRow>`${sel} where b.owner_id = ${ctx.ownerId} and b.status = 'active'`);
  const out = [];
  for (const b of bs) {
    const cats = await scope(ctx, b);
    if (cats !== null && (categoryId === null || !cats.includes(categoryId))) continue;
    const th = await thresholdsOf(ctx, b.id);
    const { status } = await periodStatus(ctx, b, periodOf(date, b.period), th);
    if (status.level !== null || status.exceeded) out.push({ budgetId: b.id, name: b.name, ...status });
  }
  return out;
}
