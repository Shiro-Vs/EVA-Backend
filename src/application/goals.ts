import { sql } from 'kysely';
import { formatISO, parseISO } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { ts, type Ctx } from './context.js';

const m = (v: bigint | string) => (typeof v === 'bigint' ? formatMoney(v) : formatMoney(parseMoney(v, { allowNegative: true })));

export interface GoalInput { name: string; targetAmount: string; targetDate?: string | null; icon?: string | null; color?: string | null; note?: string | null }

interface GoalRow { id: string; name: string; target_amount: string; target_date: string | null; icon: string | null; color: string | null; note: string | null; status: string; version: number; created_at: unknown }

const sel = sql`select id, name, target_amount, target_date, icon, color, note, status, version, created_at from goal`;

async function load(ctx: Ctx, id: string, forUpdate = false) {
  const g = await one<GoalRow>(ctx.trx, sql<GoalRow>`${sel} where owner_id = ${ctx.ownerId} and id = ${id} ${forUpdate ? sql`for update` : sql``}`);
  if (!g) throw notFound('Goal');
  return g;
}

const balanceOf = async (ctx: Ctx, accountId: string) =>
  parseMoney((await one<{ b: string }>(ctx.trx, sql<{ b: string }>`select coalesce(sum(amount), 0.00) as b from account_entry where owner_id = ${ctx.ownerId} and account_id = ${accountId}`))!.b, { allowNegative: true });

/** Total reservado en una cuenta entre todas las metas activas. */
export const reservedOn = async (ctx: Ctx, accountId: string) =>
  parseMoney((await one<{ r: string }>(ctx.trx, sql<{ r: string }>`
    select coalesce(sum(c.amount), 0.00) as r
    from goal_contribution c join goal g on g.id = c.goal_id and g.owner_id = c.owner_id
    where c.owner_id = ${ctx.ownerId} and c.account_id = ${accountId} and g.status = 'active'`))!.r, { allowNegative: true });

async function view(ctx: Ctx, g: GoalRow) {
  const per = await rows<{ account_id: string; name: string; reserved: string; balance: string; total_reserved: string }>(ctx.trx, sql`
    select c.account_id, a.name, sum(c.amount) as reserved,
           coalesce((select sum(e.amount) from account_entry e where e.account_id = c.account_id and e.owner_id = c.owner_id), 0.00) as balance,
           coalesce((select sum(x.amount) from goal_contribution x join goal xg on xg.id = x.goal_id and xg.owner_id = x.owner_id where x.account_id = c.account_id and x.owner_id = c.owner_id and xg.status = 'active'), 0.00) as total_reserved
    from goal_contribution c join account a on a.id = c.account_id and a.owner_id = c.owner_id
    where c.owner_id = ${ctx.ownerId} and c.goal_id = ${g.id} group by c.account_id, c.owner_id, a.name having sum(c.amount) <> 0 order by a.name`);
  const saved = per.reduce((a, r) => a + parseMoney(r.reserved), 0n);
  const target = parseMoney(g.target_amount);
  const pct = Number((saved * 1000n) / target) / 10;
  const today = formatISO(ctx.today);
  return {
    id: g.id, name: g.name, targetAmount: m(target), targetDate: g.target_date, icon: g.icon, color: g.color, note: g.note, status: g.status, version: g.version, createdAt: ts(g.created_at),
    // «Avance de la meta»: se mide con lo reservado, no con el saldo total de la cuenta (RN-GO05).
    saved: m(saved), remaining: m(target > saved ? target - saved : 0n), percent: pct, achieved: saved >= target,
    daysLeft: g.target_date ? parseISO(g.target_date) - ctx.today : null, overdue: g.target_date !== null && g.target_date < today && saved < target,
    accounts: per.map((r) => ({
      accountId: r.account_id, name: r.name, reserved: m(r.reserved), accountBalance: m(r.balance),
      // Si la suma reservada por todas las metas supera el saldo de la cuenta, se avisa (RN-GO05, D-30).
      overReserved: parseMoney(r.total_reserved, { allowNegative: true }) > parseMoney(r.balance, { allowNegative: true }),
    })),
  };
}

export async function listGoals(ctx: Ctx, status = 'active') {
  const gs = await rows<GoalRow>(ctx.trx, sql<GoalRow>`${sel} where owner_id = ${ctx.ownerId} and status = ${status} order by created_at, id`);
  const out = [];
  for (const g of gs) out.push(await view(ctx, g));
  return out;
}

export async function getGoal(ctx: Ctx, id: string) {
  const g = await load(ctx, id);
  const hist = await rows<{ id: string; account_id: string; account_name: string; amount: string; kind: string; operation_id: string | null; note: string | null; created_at: unknown }>(ctx.trx, sql`
    select c.id, c.account_id, a.name as account_name, c.amount, c.kind, c.operation_id, c.note, c.created_at
    from goal_contribution c join account a on a.id = c.account_id and a.owner_id = c.owner_id
    where c.owner_id = ${ctx.ownerId} and c.goal_id = ${id} order by c.created_at desc, c.id`);
  return {
    ...(await view(ctx, g)),
    contributions: hist.map((h) => ({ id: h.id, accountId: h.account_id, accountName: h.account_name, amount: m(h.amount), kind: h.kind, operationId: h.operation_id, note: h.note, at: ts(h.created_at) })),
  };
}

export async function createGoal(ctx: Ctx, i: GoalInput) {
  const target = parseMoney(i.targetAmount);
  if (target <= 0n) throw unprocessable('VALIDATION_ERROR', 'El objetivo de la meta debe ser positivo');
  if (i.targetDate && parseISO(i.targetDate) <= ctx.today) throw unprocessable('GOAL_DATE_PAST', 'La fecha de la meta debe ser posterior a hoy');
  const r = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into goal (owner_id, name, target_amount, target_date, icon, color, note)
    values (${ctx.ownerId}, ${i.name.trim()}, ${m(target)}, ${i.targetDate ?? null}, ${i.icon ?? null}, ${i.color ?? null}, ${i.note?.trim() || null}) returning id`);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'goal.create', entityType: 'goal', entityId: r!.id, changes: { name: i.name.trim(), target: m(target) } });
  return getGoal(ctx, r!.id);
}

export async function patchGoal(ctx: Ctx, id: string, version: number, p: Partial<GoalInput>) {
  const g = await load(ctx, id, true);
  if (g.version !== version) throw conflict('CONFLICT_VERSION', 'La meta cambió mientras la editabas. Recarga e inténtalo de nuevo.');
  let nextTarget = g.target_amount;
  if (p.targetAmount !== undefined) {
    const target = parseMoney(p.targetAmount);
    if (target <= 0n) throw unprocessable('VALIDATION_ERROR', 'El objetivo de la meta debe ser positivo');
    nextTarget = m(target);
  }
  if (p.targetDate !== undefined && p.targetDate !== null) {
    const td = parseISO(p.targetDate);
    if (p.targetDate !== g.target_date && td <= ctx.today) throw unprocessable('GOAL_DATE_PAST', 'La fecha de la meta debe ser posterior a hoy');
  }
  await sql`
    update goal set name = ${(p.name ?? g.name).trim()}, target_amount = ${nextTarget},
      target_date = ${p.targetDate === undefined ? g.target_date : p.targetDate}, icon = ${p.icon === undefined ? g.icon : p.icon},
      color = ${p.color === undefined ? g.color : p.color}, note = ${p.note === undefined ? g.note : (p.note?.trim() || null)}
    where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'goal.update', entityType: 'goal', entityId: id });
  return getGoal(ctx, id);
}

export async function setGoalStatus(ctx: Ctx, id: string, status: 'active' | 'archived') {
  await load(ctx, id, true);
  await sql`update goal set status = ${status} where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: status === 'archived' ? 'goal.archive' : 'goal.restore', entityType: 'goal', entityId: id });
  return getGoal(ctx, id);
}

/** Elimina una meta SOLO si nunca tuvo reservas ni transferencias vinculadas. Si ya se usó, sugiere archivarla. */
export async function deleteGoal(ctx: Ctx, id: string) {
  const g = await load(ctx, id, true);
  const c = await one<{ n: string }>(ctx.trx, sql<{ n: string }>`select count(*) as n from goal_contribution where owner_id = ${ctx.ownerId} and goal_id = ${id}`);
  if (Number(c?.n ?? 0) > 0) {
    throw conflict('GOAL_IN_USE', 'La meta ya tiene historial de reservas: no se puede eliminar. Puedes archivarla', { usage: { aportes: Number(c!.n) } });
  }
  await sql`delete from goal where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'goal.delete', entityType: 'goal', entityId: id, changes: { name: g.name } });
  return { id, deleted: true };
}

async function savingsAccount(ctx: Ctx, accountId: string) {
  const a = await one<{ type: string; status: string; name: string }>(ctx.trx, sql<{ type: string; status: string; name: string }>`select type, status, name from account where owner_id = ${ctx.ownerId} and id = ${accountId} for share`);
  if (!a) throw notFound('Account');
  if (a.status !== 'active') throw unprocessable('ACCOUNT_ARCHIVED', 'La cuenta está archivada');
  if (a.type === 'credit') throw unprocessable('GOAL_ACCOUNT_TYPE', 'Una tarjeta de crédito no tiene dinero propio que reservar: la línea disponible no cuenta');
  return a;
}

/** Aparta dinero que YA está en la cuenta para la meta. No crea ninguna operación y no cambia el saldo (A21). */
export async function reserve(ctx: Ctx, goalId: string, i: { accountId: string; amount: string; note?: string }) {
  const g = await load(ctx, goalId, true);
  if (g.status !== 'active') throw unprocessable('GOAL_ARCHIVED', 'La meta está archivada');
  await savingsAccount(ctx, i.accountId);
  const amount = parseMoney(i.amount);
  if (amount <= 0n) throw unprocessable('VALIDATION_ERROR', 'El importe debe ser positivo');
  await sql`select 1 from account where owner_id = ${ctx.ownerId} and id = ${i.accountId} for update`.execute(ctx.trx); // serializa reservas sobre la misma cuenta
  const free = (await balanceOf(ctx, i.accountId)) - (await reservedOn(ctx, i.accountId));
  if (amount > (free > 0n ? free : 0n)) throw unprocessable('INSUFFICIENT_FREE_BALANCE', 'La cuenta no tiene tanto dinero libre para reservar', { free: m(free > 0n ? free : 0n), requested: m(amount) });
  await sql`insert into goal_contribution (owner_id, goal_id, account_id, amount, kind, note, created_by) values (${ctx.ownerId}, ${goalId}, ${i.accountId}, ${m(amount)}, 'reserve', ${i.note?.trim() || null}, ${ctx.actorId})`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'goal.reserve', entityType: 'goal', entityId: goalId, changes: { accountId: i.accountId, amount: m(amount) } });
  return getGoal(ctx, goalId);
}

export async function release(ctx: Ctx, goalId: string, i: { accountId: string; amount: string; note?: string }) {
  await load(ctx, goalId, true);
  const amount = parseMoney(i.amount);
  if (amount <= 0n) throw unprocessable('VALIDATION_ERROR', 'El importe debe ser positivo');
  const have = parseMoney((await one<{ r: string }>(ctx.trx, sql<{ r: string }>`select coalesce(sum(amount), 0.00) as r from goal_contribution where owner_id = ${ctx.ownerId} and goal_id = ${goalId} and account_id = ${i.accountId}`))!.r, { allowNegative: true });
  if (amount > have) throw unprocessable('RELEASE_EXCEEDS_RESERVED', 'No hay tanto reservado en esa cuenta para esta meta', { reserved: m(have > 0n ? have : 0n), requested: m(amount) });
  await sql`insert into goal_contribution (owner_id, goal_id, account_id, amount, kind, note, created_by) values (${ctx.ownerId}, ${goalId}, ${i.accountId}, ${m(-amount)}, 'release', ${i.note?.trim() || null}, ${ctx.actorId})`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'goal.release', entityType: 'goal', entityId: goalId, changes: { accountId: i.accountId, amount: m(amount) } });
  return getGoal(ctx, goalId);
}

/** Vincula una transferencia REAL de ahorro hacia una cuenta: lo transferido queda reservado para la meta (RN-GO02). */
export async function linkTransfer(ctx: Ctx, goalId: string, operationId: string) {
  const g = await load(ctx, goalId, true);
  if (g.status !== 'active') throw unprocessable('GOAL_ARCHIVED', 'La meta está archivada');
  const op = await one<{ kind: string; status: string }>(ctx.trx, sql<{ kind: string; status: string }>`select kind, status from financial_operation where owner_id = ${ctx.ownerId} and id = ${operationId}`);
  if (!op) throw notFound('Operation');
  if (op.kind !== 'transfer' || op.status !== 'confirmed') throw unprocessable('NOT_A_TRANSFER', 'Solo una transferencia confirmada entre tus cuentas se puede vincular a una meta');
  const dest = await one<{ account_id: string; amount: string }>(ctx.trx, sql<{ account_id: string; amount: string }>`select account_id, amount from account_entry where owner_id = ${ctx.ownerId} and operation_id = ${operationId} and amount > 0`);
  if (!dest) throw unprocessable('NOT_A_TRANSFER', 'La transferencia no tiene cuenta de destino');
  await savingsAccount(ctx, dest.account_id);
  const used = await one(ctx.trx, sql`select 1 from goal_contribution where owner_id = ${ctx.ownerId} and operation_id = ${operationId} and kind = 'transfer'`);
  if (used) throw conflict('TRANSFER_ALREADY_LINKED', 'Esa transferencia ya está vinculada a una meta');
  await sql`insert into goal_contribution (owner_id, goal_id, account_id, amount, kind, operation_id, created_by) values (${ctx.ownerId}, ${goalId}, ${dest.account_id}, ${m(parseMoney(dest.amount))}, 'transfer', ${operationId}, ${ctx.actorId})`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'goal.link_transfer', entityType: 'goal', entityId: goalId, changes: { operationId, amount: m(parseMoney(dest.amount)) } });
  return getGoal(ctx, goalId);
}

/** Por cuenta: total, reservado y libre (RN-GO03), con aviso si lo reservado supera el saldo. */
export async function overview(ctx: Ctx) {
  const accs = await rows<{ id: string; name: string; type: string; balance: string; reserved: string }>(ctx.trx, sql`
    select a.id, a.name, a.type, coalesce((select sum(e.amount) from account_entry e where e.account_id = a.id and e.owner_id = a.owner_id), 0.00) as balance,
           coalesce((select sum(c.amount) from goal_contribution c join goal g on g.id = c.goal_id and g.owner_id = c.owner_id where c.account_id = a.id and c.owner_id = a.owner_id and g.status = 'active'), 0.00) as reserved
    from account a where a.owner_id = ${ctx.ownerId} and a.status = 'active' and a.type <> 'credit' order by a.is_default desc, a.created_at`);
  const items = accs.map((a) => {
    const bal = parseMoney(a.balance, { allowNegative: true }); const res = parseMoney(a.reserved, { allowNegative: true });
    return { accountId: a.id, name: a.name, total: m(bal), reserved: m(res), free: m(bal - res), overReserved: res > bal };
  });
  const sum = (f: (x: (typeof items)[number]) => string) => items.reduce((a, x) => a + parseMoney(f(x), { allowNegative: true }), 0n);
  return { accounts: items, totals: { total: m(sum((x) => x.total)), reserved: m(sum((x) => x.reserved)), free: m(sum((x) => x.free)) } };
}

// ───────────────────────── Gastos que usan dinero reservado (RN-GO04) ─────────────────────────

export interface Deduction { goalId: string; amount: string }

/**
 * ¿Este egreso se come dinero reservado? Si sí, hay que decidir ANTES de confirmar: descontar de qué meta(s) o aceptar el faltante.
 * Devuelve cuánto reservado se usaría y las metas con dinero apartado en esa cuenta.
 */
export async function reserveConflict(ctx: Ctx, accountId: string, outflow: bigint) {
  const reserved = await reservedOn(ctx, accountId);
  if (reserved <= 0n) return null;
  const free = (await balanceOf(ctx, accountId)) - reserved;
  const eaten = outflow - (free > 0n ? free : 0n);
  if (eaten <= 0n) return null;
  const goals = await rows<{ goal_id: string; name: string; reserved: string }>(ctx.trx, sql`
    select c.goal_id, g.name, sum(c.amount) as reserved from goal_contribution c join goal g on g.id = c.goal_id and g.owner_id = c.owner_id
    where c.owner_id = ${ctx.ownerId} and c.account_id = ${accountId} and g.status = 'active' group by c.goal_id, g.name having sum(c.amount) > 0 order by g.name`);
  return { eaten: eaten > reserved ? reserved : eaten, goals: goals.map((g) => ({ goalId: g.goal_id, name: g.name, reserved: m(g.reserved) })) };
}

/** Descuenta de las metas elegidas lo que el gasto usó de lo reservado. Se llama con la operación ya creada. */
export async function applyDeductions(ctx: Ctx, accountId: string, operationId: string, deductions: Deduction[]) {
  for (const d of deductions) {
    const amount = parseMoney(d.amount);
    if (amount <= 0n) continue;
    await sql`insert into goal_contribution (owner_id, goal_id, account_id, amount, kind, operation_id, created_by) values (${ctx.ownerId}, ${d.goalId}, ${accountId}, ${m(-amount)}, 'spend', ${operationId}, ${ctx.actorId})`.execute(ctx.trx);
  }
}

export async function validateDeductions(ctx: Ctx, accountId: string, eaten: bigint, deductions: Deduction[], goals: Array<{ goalId: string; reserved: string }>) {
  const total = deductions.reduce((a, d) => a + parseMoney(d.amount), 0n);
  if (total < eaten) throw unprocessable('GOAL_DEDUCTION_INSUFFICIENT', 'Lo descontado de las metas no cubre el dinero reservado que usa este gasto', { needed: m(eaten), provided: m(total) });
  for (const d of deductions) {
    const have = goals.find((g) => g.goalId === d.goalId);
    if (!have || parseMoney(d.amount) > parseMoney(have.reserved)) throw unprocessable('GOAL_DEDUCTION_EXCEEDS', 'Una meta no tiene tanto reservado en esa cuenta', { goalId: d.goalId, accountId });
  }
}
