import { sql } from 'kysely';
import { formatISO } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { one, rows } from '../infra/db/db.js';
import type { Ctx } from './context.js';
import { syncAllSubscriptions } from './sync.js';

const m = (v: string | null | undefined) => formatMoney(parseMoney(v ?? '0', { allowNegative: true }));

/**
 * Resumen para el inicio y las cabeceras (saldo total, por cobrar, compromisos y actividad reciente).
 * Los totales los calcula el servidor: la app solo los muestra (docs/especificacion/10 T-05).
 */
export async function summary(ctx: Ctx) {
  await syncAllSubscriptions(ctx);
  const today = formatISO(ctx.today);

  const bal = await one<{ net: string; n: string }>(ctx.trx, sql<{ net: string; n: string }>`
    select coalesce(sum(b.balance), 0.00) as net, count(distinct a.id) as n
    from account a left join v_account_balance b on b.account_id = a.id and b.owner_id = a.owner_id
    where a.owner_id = ${ctx.ownerId} and a.status = 'active' and not a.exclude_from_total`);

  const rec = await one<{ pending: string; overdue: string; debtors: string }>(ctx.trx, sql<{ pending: string; overdue: string; debtors: string }>`
    select coalesce(sum(b.pending_amount), 0.00) as pending,
           coalesce(sum(b.pending_amount) filter (where d.effective_due_date < ${today}::date), 0.00) as overdue,
           count(distinct b.contact_id) filter (where b.pending_amount > 0) as debtors
    from v_obligation_balance b join v_charge_due d on d.obligation_id = b.obligation_id
    where b.owner_id = ${ctx.ownerId} and b.pending_amount > 0`);

  const credit = await one<{ free: string; reserved: string }>(ctx.trx, sql<{ free: string; reserved: string }>`
    select coalesce(sum(free), 0.00) as free, coalesce(sum(reserved), 0.00) as reserved from v_receipt_availability where owner_id = ${ctx.ownerId}`);

  const subs = await one<{ active: string; total: string }>(ctx.trx, sql<{ active: string; total: string }>`
    select count(distinct s.id) as active, coalesce(sum((c.terms_snapshot->>'announcedPrice')::numeric), 0.00) as total
    from subscription s left join billing_cycle c on c.subscription_id = s.id and c.owner_id = s.owner_id
         and c.start_date <= ${today}::date and c.end_date > ${today}::date
    where s.owner_id = ${ctx.ownerId} and s.status = 'active'`);

  const recent = await rows<{ id: string; operation_id: string; kind: string; op_status: string; occurred_on: string; description: string; account_id: string; account_name: string; amount: string }>(ctx.trx, sql`
    select ae.id, ae.operation_id, fo.kind, fo.status as op_status, fo.occurred_on, fo.description, a.id as account_id, a.name as account_name, ae.amount
    from account_entry ae
    join financial_operation fo on fo.id = ae.operation_id and fo.owner_id = ae.owner_id
    join account a on a.id = ae.account_id and a.owner_id = ae.owner_id
    where ae.owner_id = ${ctx.ownerId} and fo.kind <> 'opening'
    order by fo.occurred_on desc, fo.created_at desc, ae.amount desc, ae.id desc limit 8`);

  return {
    asOf: today,
    balance: { net: m(bal?.net), accounts: Number(bal?.n ?? 0) },
    receivable: { pending: m(rec?.pending), overdue: m(rec?.overdue), debtors: Number(rec?.debtors ?? 0), creditFree: m(credit?.free), creditReserved: m(credit?.reserved) },
    subscriptions: { active: Number(subs?.active ?? 0), currentCycleTotal: m(subs?.total) },
    recent: recent.map((r) => ({
      id: r.id, operationId: r.operation_id, kind: r.kind, status: r.op_status, occurredOn: r.occurred_on, description: r.description,
      account: { id: r.account_id, name: r.account_name }, amount: m(r.amount),
    })),
  };
}
