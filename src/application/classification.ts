import { sql } from 'kysely';
import { hasCondition, pickRule, type Candidate, type Rule } from '../domain/classification.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { checkPreviewToken, makePreviewToken } from '../infra/preview.js';
import { assertActiveCategory } from './categories.js';
import { ts, type Ctx } from './context.js';

export interface RuleInput {
  name: string;
  priority?: number;
  accountId?: string | null;
  direction?: 'income' | 'expense' | null;
  amountMin?: string | null;
  amountMax?: string | null;
  textContains?: string | null;
  action: 'assign' | 'suggest';
  categoryId: string;
}

interface RuleRow {
  id: string; name: string; priority: number; status: string; account_id: string | null; direction: 'income' | 'expense' | null; amount_min: string | null; amount_max: string | null;
  text_contains: string | null; action: 'assign' | 'suggest'; category_id: string; category_name: string; version: number; created_at: unknown; created_ms: string;
}

const base = sql`
  select r.id, r.name, r.priority, r.status, r.account_id, r.direction, r.amount_min, r.amount_max, r.text_contains, r.action, r.category_id, c.name as category_name,
         r.version, r.created_at, (extract(epoch from r.created_at) * 1000)::bigint::text as created_ms
  from classification_rule r join category c on c.id = r.category_id and c.owner_id = r.owner_id`;

const view = (r: RuleRow) => ({
  id: r.id, name: r.name, priority: r.priority, status: r.status, accountId: r.account_id, direction: r.direction,
  amountMin: r.amount_min === null ? null : formatMoney(parseMoney(r.amount_min)), amountMax: r.amount_max === null ? null : formatMoney(parseMoney(r.amount_max)),
  textContains: r.text_contains, action: r.action, category: { id: r.category_id, name: r.category_name }, version: r.version, createdAt: ts(r.created_at),
});

const toRule = (r: RuleRow): Rule => ({
  id: r.id, priority: r.priority, createdAt: Number(r.created_ms), accountId: r.account_id, direction: r.direction,
  amountMin: r.amount_min === null ? null : parseMoney(r.amount_min), amountMax: r.amount_max === null ? null : parseMoney(r.amount_max),
  textContains: r.text_contains, action: r.action, categoryId: r.category_id,
});

export async function listRules(ctx: Ctx, status?: string) {
  const r = await rows<RuleRow>(ctx.trx, sql<RuleRow>`${base} where r.owner_id = ${ctx.ownerId} and (${status ?? null}::text is null or r.status = ${status ?? null}) order by r.priority, r.created_at, r.id`);
  return r.map(view);
}

async function getRule(ctx: Ctx, id: string) {
  const r = await one<RuleRow>(ctx.trx, sql<RuleRow>`${base} where r.owner_id = ${ctx.ownerId} and r.id = ${id}`);
  if (!r) throw notFound('Rule');
  return r;
}

async function validate(ctx: Ctx, i: RuleInput) {
  const draft = {
    accountId: i.accountId ?? null, direction: i.direction ?? null, amountMin: i.amountMin ? parseMoney(i.amountMin) : null,
    amountMax: i.amountMax ? parseMoney(i.amountMax) : null, textContains: i.textContains?.trim() || null,
  };
  if (!hasCondition(draft)) throw unprocessable('RULE_WITHOUT_CONDITION', 'La regla necesita al menos una condición (cuenta, dirección, importe o texto)');
  if (draft.amountMin !== null && draft.amountMax !== null && draft.amountMin > draft.amountMax) throw unprocessable('RULE_AMOUNT_RANGE', 'El importe mínimo no puede superar al máximo');
  if (i.accountId) {
    const a = await one(ctx.trx, sql`select 1 from account where owner_id = ${ctx.ownerId} and id = ${i.accountId}`);
    if (!a) throw notFound('Account');
  }
  await assertActiveCategory(ctx, i.categoryId);
  return draft;
}

export async function createRule(ctx: Ctx, i: RuleInput) {
  const d = await validate(ctx, i);
  const r = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into classification_rule (owner_id, name, priority, account_id, direction, amount_min, amount_max, text_contains, action, category_id)
    values (${ctx.ownerId}, ${i.name.trim()}, ${i.priority ?? 100}, ${d.accountId}, ${d.direction}, ${d.amountMin === null ? null : formatMoney(d.amountMin)},
            ${d.amountMax === null ? null : formatMoney(d.amountMax)}, ${d.textContains}, ${i.action}, ${i.categoryId}) returning id`);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'rule.create', entityType: 'classification_rule', entityId: r!.id, changes: { name: i.name.trim(), action: i.action, priority: i.priority ?? 100 } });
  return view(await getRule(ctx, r!.id));
}

/** Editar una regla no recategoriza historial (RN-CL07): solo afecta a lo que se clasifique desde ahora. */
export async function patchRule(ctx: Ctx, id: string, version: number, p: Partial<RuleInput>) {
  const cur = await getRule(ctx, id);
  if (cur.version !== version) throw conflict('CONFLICT_VERSION', 'The rule was modified; reload and retry');
  const merged: RuleInput = {
    name: p.name ?? cur.name, priority: p.priority ?? cur.priority,
    accountId: p.accountId === undefined ? cur.account_id : p.accountId, direction: p.direction === undefined ? cur.direction : p.direction,
    amountMin: p.amountMin === undefined ? cur.amount_min : p.amountMin, amountMax: p.amountMax === undefined ? cur.amount_max : p.amountMax,
    textContains: p.textContains === undefined ? cur.text_contains : p.textContains, action: p.action ?? cur.action, categoryId: p.categoryId ?? cur.category_id,
  };
  const d = await validate(ctx, merged);
  await sql`
    update classification_rule set name = ${merged.name.trim()}, priority = ${merged.priority ?? 100}, account_id = ${d.accountId}, direction = ${d.direction},
      amount_min = ${d.amountMin === null ? null : formatMoney(d.amountMin)}, amount_max = ${d.amountMax === null ? null : formatMoney(d.amountMax)},
      text_contains = ${d.textContains}, action = ${merged.action}, category_id = ${merged.categoryId}
    where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'rule.update', entityType: 'classification_rule', entityId: id });
  return view(await getRule(ctx, id));
}

export async function setRuleStatus(ctx: Ctx, id: string, status: 'active' | 'archived') {
  await getRule(ctx, id);
  await sql`update classification_rule set status = ${status} where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: status === 'archived' ? 'rule.archive' : 'rule.restore', entityType: 'classification_rule', entityId: id });
  return view(await getRule(ctx, id));
}

/** Reglas activas cuya categoría también está activa: una categoría archivada ya no clasifica. */
async function activeRules(ctx: Ctx): Promise<Array<{ rule: Rule; row: RuleRow }>> {
  const r = await rows<RuleRow>(ctx.trx, sql<RuleRow>`${base} where r.owner_id = ${ctx.ownerId} and r.status = 'active' and c.status = 'active'`);
  return r.map((row) => ({ rule: toRule(row), row }));
}

const explain = (row: RuleRow) => ({ ruleId: row.id, ruleName: row.name, action: row.action, categoryId: row.category_id, categoryName: row.category_name, priority: row.priority });

/** ¿Qué regla aplicaría a esta operación? Muestra la ganadora y las demás coincidencias (RN-CL06). */
export async function suggest(ctx: Ctx, c: { accountId: string; direction: 'income' | 'expense'; amount: string; text?: string }) {
  const cand: Candidate = { accountId: c.accountId, direction: c.direction, amount: parseMoney(c.amount), text: c.text ?? '' };
  const all = await activeRules(ctx);
  const { applied, matched } = pickRule(all.map((x) => x.rule), cand);
  const byId = new Map(all.map((x) => [x.row.id, x.row]));
  return { applied: applied ? explain(byId.get(applied.id)!) : null, matched: matched.map((m) => explain(byId.get(m.id)!)) };
}

/** Clasifica una operación recién creada con las reglas del usuario (RN-CL04). `assign` fija la categoría; `suggest` solo la propone. */
export async function autoClassify(ctx: Ctx, operationId: string, cand: Candidate) {
  const all = await activeRules(ctx);
  const { applied } = pickRule(all.map((x) => x.rule), cand);
  if (!applied) return null;
  const row = all.find((x) => x.row.id === applied.id)!.row;
  if (applied.action === 'assign') {
    await sql`update financial_operation set category_id = ${applied.categoryId} where owner_id = ${ctx.ownerId} and id = ${operationId}`.execute(ctx.trx);
  }
  await sql`insert into classification_decision (owner_id, operation_id, rule_id, category_id, mode) values (${ctx.ownerId}, ${operationId}, ${applied.id}, ${applied.categoryId}, ${applied.action})`.execute(ctx.trx);
  return explain(row);
}

interface OpRow { id: string; description: string; occurred_on: string; account_id: string; amount: string }

/** Operaciones de ingreso o gasto sin categoría que EVA puede clasificar; los cobros y devoluciones se quedan fuera (RN-CL08). */
async function unclassified(ctx: Ctx, from?: string, to?: string) {
  return rows<OpRow>(ctx.trx, sql<OpRow>`
    select o.id, o.description, o.occurred_on, e.account_id, e.amount
    from financial_operation o join account_entry e on e.operation_id = o.id and e.owner_id = o.owner_id
    where o.owner_id = ${ctx.ownerId} and o.kind in ('income','expense') and o.status = 'confirmed' and o.category_id is null
      and not exists (select 1 from receipt r where r.operation_id = o.id) and not exists (select 1 from refund f where f.operation_id = o.id)
      and (${from ?? null}::date is null or o.occurred_on >= ${from ?? null}::date) and (${to ?? null}::date is null or o.occurred_on <= ${to ?? null}::date)
    order by o.occurred_on, o.created_at, o.id limit 500`);
}

async function buildApply(ctx: Ctx, from?: string, to?: string) {
  const all = await activeRules(ctx);
  const rules = all.map((x) => x.rule);
  const items = [];
  for (const o of await unclassified(ctx, from, to)) {
    const amt = parseMoney(o.amount, { allowNegative: true });
    const { applied } = pickRule(rules, { accountId: o.account_id, direction: amt < 0n ? 'expense' : 'income', amount: amt < 0n ? -amt : amt, text: o.description });
    if (!applied) continue;
    const row = all.find((x) => x.row.id === applied.id)!.row;
    items.push({ operationId: o.id, description: o.description, occurredOn: o.occurred_on, amount: formatMoney(amt), ...explain(row) });
  }
  return items;
}

/** Vista previa de reclasificar lo pendiente con las reglas (solo a petición: RN-CL07). Nunca toca lo que ya tiene categoría. */
export async function previewApply(ctx: Ctx, from?: string, to?: string) {
  const items = await buildApply(ctx, from, to);
  return {
    count: items.length, items,
    note: 'Solo se clasifican movimientos sin categoría. Lo ya clasificado a mano no se toca.',
    previewToken: makePreviewToken(ctx.previewSecret, { scope: 'classification.apply', ownerId: ctx.ownerId, inputs: { from: from ?? null, to: to ?? null }, state: items.map((x) => [x.operationId, x.ruleId]) }, ctx.nowMs),
  };
}

export async function applyRules(ctx: Ctx, i: { from?: string; to?: string; previewToken: string }) {
  const items = await buildApply(ctx, i.from, i.to);
  checkPreviewToken(ctx.previewSecret, i.previewToken, { scope: 'classification.apply', ownerId: ctx.ownerId, inputs: { from: i.from ?? null, to: i.to ?? null }, state: items.map((x) => [x.operationId, x.ruleId]) }, ctx.nowMs);
  for (const x of items) {
    await sql`update financial_operation set category_id = ${x.categoryId} where owner_id = ${ctx.ownerId} and id = ${x.operationId} and category_id is null`.execute(ctx.trx);
    await sql`insert into classification_decision (owner_id, operation_id, rule_id, category_id, mode) values (${ctx.ownerId}, ${x.operationId}, ${x.ruleId}, ${x.categoryId}, 'bulk')`.execute(ctx.trx);
  }
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'classification.apply', entityType: 'user_profile', entityId: ctx.ownerId, changes: { classified: items.length } });
  return { classified: items.length };
}

/** Rastro de una operación: qué regla o persona la clasificó. */
export async function decisionsOf(ctx: Ctx, operationId: string) {
  const r = await rows<{ rule_id: string | null; rule_name: string | null; category_id: string; category_name: string; mode: string; created_at: unknown }>(ctx.trx, sql`
    select d.rule_id, r.name as rule_name, d.category_id, c.name as category_name, d.mode, d.created_at
    from classification_decision d join category c on c.id = d.category_id and c.owner_id = d.owner_id
    left join classification_rule r on r.id = d.rule_id and r.owner_id = d.owner_id
    where d.owner_id = ${ctx.ownerId} and d.operation_id = ${operationId} order by d.created_at desc`);
  return r.map((x) => ({ ruleId: x.rule_id, ruleName: x.rule_name, categoryId: x.category_id, categoryName: x.category_name, mode: x.mode, at: ts(x.created_at) }));
}
