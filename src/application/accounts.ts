import { sql } from 'kysely';
import { formatISO } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { parseISO } from '../domain/localDate.js';
import { ts, type Ctx } from './context.js';

interface Row {
  id: string; name: string; type: string; currency: string; institution: string | null; color: string | null; icon: string | null;
  is_default: boolean; exclude_from_total: boolean; status: string; version: number; created_at: unknown; balance: string;
}

export const mapAccount = (r: Row) => ({
  id: r.id, name: r.name, type: r.type, currency: r.currency, institution: r.institution, color: r.color, icon: r.icon,
  isDefault: r.is_default, excludeFromTotal: r.exclude_from_total, status: r.status, balance: formatMoney(parseMoney(r.balance, { allowNegative: true })),
  version: r.version, createdAt: ts(r.created_at),
});

const base = sql`
  select a.*, coalesce(b.balance, 0.00) as balance
  from account a left join v_account_balance b on b.account_id = a.id and b.owner_id = a.owner_id`;

export async function getAccountRow(ctx: Ctx, id: string, forUpdate = false) {
  const lock = forUpdate ? sql`for update of a` : sql``;
  const r = await one<Row>(ctx.trx, sql<Row>`${base} where a.owner_id = ${ctx.ownerId} and a.id = ${id} ${lock}`);
  if (!r) throw notFound('Account');
  return r;
}

export const getAccount = async (ctx: Ctx, id: string) => mapAccount(await getAccountRow(ctx, id));

export async function listAccounts(ctx: Ctx, status?: string) {
  const f = status ? sql`and a.status = ${status}` : sql``;
  return (await rows<Row>(ctx.trx, sql<Row>`${base} where a.owner_id = ${ctx.ownerId} ${f} order by a.is_default desc, a.created_at`)).map(mapAccount);
}

export interface CreateAccountInput {
  name: string; type: 'bank' | 'savings' | 'cash' | 'wallet' | 'credit';
  institution?: string; color?: string; icon?: string; isDefault?: boolean; excludeFromTotal?: boolean;
  openingBalance?: { amount: string; date?: string };
}

export async function createAccount(ctx: Ctx, i: CreateAccountInput) {
  let opening = 0n;
  let openingDate = ctx.today;
  if (i.openingBalance) {
    opening = parseMoney(i.openingBalance.amount, { allowNegative: true });
    if (i.type === 'credit' && opening > 0n) throw unprocessable('VALIDATION_ERROR', 'En una cuenta de crédito el saldo inicial es la deuda y debe ser ≤ 0');
    if (i.type !== 'credit' && opening < 0n) throw unprocessable('VALIDATION_ERROR', 'El saldo inicial no puede ser negativo');
    if (i.openingBalance.date) openingDate = parseISO(i.openingBalance.date);
    if (openingDate > ctx.today) throw unprocessable('FUTURE_DATE_NOT_ALLOWED', 'La fecha no puede ser posterior a hoy');
  }
  if (i.isDefault) await sql`update account set is_default = false where owner_id = ${ctx.ownerId} and is_default`.execute(ctx.trx);

  const acc = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into account (owner_id, name, type, institution, color, icon, is_default, exclude_from_total)
    values (${ctx.ownerId}, ${i.name.trim()}, ${i.type}, ${i.institution ?? null}, ${i.color ?? null}, ${i.icon ?? null}, ${i.isDefault ?? false}, ${i.excludeFromTotal ?? false})
    returning id`);
  const id = acc!.id;

  if (opening !== 0n) {
    const op = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
      insert into financial_operation (owner_id, kind, occurred_on, description, created_by)
      values (${ctx.ownerId}, 'opening', ${formatISO(openingDate)}, 'Saldo inicial', ${ctx.actorId}) returning id`);
    await sql`insert into account_entry (owner_id, operation_id, account_id, amount) values (${ctx.ownerId}, ${op!.id}, ${id}, ${formatMoney(opening)})`.execute(ctx.trx);
  }
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'account.create', entityType: 'account', entityId: id, changes: { type: i.type, opening: formatMoney(opening) } });
  return getAccount(ctx, id);
}

export interface PatchAccountInput { name?: string; color?: string | null; icon?: string | null; isDefault?: boolean; excludeFromTotal?: boolean }

export async function patchAccount(ctx: Ctx, id: string, version: number, p: PatchAccountInput) {
  const cur = await getAccountRow(ctx, id, true);
  if (cur.version !== version) throw conflict('CONFLICT_VERSION', 'The account was modified; reload and retry');
  if (p.isDefault) await sql`update account set is_default = false where owner_id = ${ctx.ownerId} and is_default and id <> ${id}`.execute(ctx.trx);
  await sql`
    update account set name = ${p.name?.trim() ?? cur.name}, color = ${p.color === undefined ? cur.color : p.color}, icon = ${p.icon === undefined ? cur.icon : p.icon},
      is_default = ${p.isDefault ?? cur.is_default}, exclude_from_total = ${p.excludeFromTotal ?? cur.exclude_from_total}
    where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'account.update', entityType: 'account', entityId: id, changes: p as Record<string, unknown> });
  return getAccount(ctx, id);
}

export async function archiveAccount(ctx: Ctx, id: string) {
  const cur = await getAccountRow(ctx, id, true);
  await sql`update account set status = 'archived', is_default = false where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'account.archive', entityType: 'account', entityId: id });
  const warnings = parseMoney(cur.balance, { allowNegative: true }) !== 0n ? ['ACCOUNT_HAS_BALANCE'] : [];
  return { account: await getAccount(ctx, id), warnings };
}

export async function listEntries(ctx: Ctx, accountId: string, limit: number, offset: number) {
  await getAccountRow(ctx, accountId);
  const r = await rows<{ id: string; operation_id: string; kind: string; occurred_on: string; description: string; op_status: string; amount: string; running: string }>(
    ctx.trx,
    sql`
      with e as (
        select ae.id, ae.operation_id, fo.kind, fo.occurred_on, fo.description, fo.status as op_status, ae.amount, ae.created_at,
               sum(ae.amount) over (order by fo.occurred_on, ae.created_at, ae.id) as running
        from account_entry ae
        join financial_operation fo on fo.id = ae.operation_id and fo.owner_id = ae.owner_id
        where ae.owner_id = ${ctx.ownerId} and ae.account_id = ${accountId})
      select * from e order by occurred_on desc, created_at desc, id desc limit ${limit + 1} offset ${offset}`,
  );
  const page = r.slice(0, limit);
  return {
    items: page.map((e) => ({ id: e.id, operationId: e.operation_id, kind: e.kind, occurredOn: e.occurred_on, description: e.description, operationStatus: e.op_status, amount: formatMoney(parseMoney(e.amount, { allowNegative: true })), balanceAfter: formatMoney(parseMoney(e.running, { allowNegative: true })) })),
    nextCursor: r.length > limit ? Buffer.from(String(offset + limit)).toString('base64url') : null,
  };
}
