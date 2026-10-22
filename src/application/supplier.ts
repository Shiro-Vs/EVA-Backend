import { sql } from 'kysely';
import { costSummary } from '../domain/costs.js';
import { formatISO } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one } from '../infra/db/db.js';
import { listCharges } from './charges.js';
import type { Ctx } from './context.js';
import { activeAccount, insertOperation, resolveDate, reverseOperationCore } from './operations.js';
import { syncSubscription } from './sync.js';

interface CycleRow {
  id: string; subscription_id: string; subscription_name: string; seq: number; start_date: string; end_date: string;
  terms_snapshot: { announcedPrice: string; interval: { unit: 'day' | 'week' | 'month' | 'year'; count: number }; baseDays: number };
}

async function cycleRow(ctx: Ctx, id: string): Promise<CycleRow> {
  const c = await one<CycleRow>(ctx.trx, sql<CycleRow>`
    select c.id, c.subscription_id, s.name as subscription_name, c.seq, c.start_date, c.end_date, c.terms_snapshot
    from billing_cycle c join subscription s on s.id = c.subscription_id and s.owner_id = c.owner_id
    where c.owner_id = ${ctx.ownerId} and c.id = ${id}`);
  if (!c) throw notFound('Billing cycle');
  return c;
}

interface PaymentRow { id: string; operation_id: string; amount_real: string; announced_price_snapshot: string; paid_on: string; status: string; account_id: string | null; account_name: string | null }

const activePayment = (ctx: Ctx, cycleId: string) =>
  one<PaymentRow>(ctx.trx, sql<PaymentRow>`
    select sp.id, sp.operation_id, sp.amount_real, sp.announced_price_snapshot, sp.paid_on, sp.status, a.id as account_id, a.name as account_name
    from supplier_payment sp
    left join lateral (select e.account_id from account_entry e where e.operation_id = sp.operation_id and e.owner_id = sp.owner_id limit 1) ae on true
    left join account a on a.id = ae.account_id and a.owner_id = sp.owner_id
    where sp.owner_id = ${ctx.ownerId} and sp.cycle_id = ${cycleId} and sp.status = 'active'`);

const paymentJson = (p: PaymentRow) => ({
  id: p.id, operationId: p.operation_id, amount: formatMoney(parseMoney(p.amount_real)), announcedPrice: formatMoney(parseMoney(p.announced_price_snapshot)), paidOn: p.paid_on,
  account: p.account_id ? { id: p.account_id, name: p.account_name } : null,
});

/** Pago real del ciclo, independiente de los cobros (RN-F01…F03). El calendario no se mueve (RN-C06). */
export async function registerSupplierPayment(ctx: Ctx, cycleId: string, i: { accountId: string; amount: string; paidOn?: string; note?: string }) {
  const c = await cycleRow(ctx, cycleId);
  await sql`select 1 from subscription where owner_id = ${ctx.ownerId} and id = ${c.subscription_id} for update`.execute(ctx.trx);
  const amount = parseMoney(i.amount);
  if (amount <= 0n) throw unprocessable('VALIDATION_ERROR', 'El importe debe ser positivo');
  const paidOn = resolveDate(ctx, i.paidOn);
  if (await activePayment(ctx, cycleId)) throw unprocessable('SUPPLIER_PAYMENT_EXISTS', 'This cycle already has an active supplier payment');
  await activeAccount(ctx, i.accountId); // en una cuenta de crédito el asiento negativo aumenta la deuda de la tarjeta

  const opId = await insertOperation(ctx, { kind: 'expense', date: paidOn, description: i.note?.trim() || `Pago de ${c.subscription_name} (${c.start_date} → ${c.end_date})`, source: 'manual' }, [{ accountId: i.accountId, amount: -amount }]);
  await sql`
    insert into supplier_payment (owner_id, cycle_id, operation_id, amount_real, announced_price_snapshot, paid_on)
    values (${ctx.ownerId}, ${cycleId}, ${opId}, ${formatMoney(amount)}, ${c.terms_snapshot.announcedPrice}, ${formatISO(paidOn)})`.execute(ctx.trx);
  const p = (await activePayment(ctx, cycleId))!;
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'supplier_payment.create', entityType: 'supplier_payment', entityId: p!.id,
    changes: { cycleId, amount: formatMoney(amount), announced: c.terms_snapshot.announcedPrice } });
  return { supplierPayment: paymentJson(p!), operationId: opId, cycle: { id: c.id, startDate: c.start_date, endDate: c.end_date }, calendarUnchanged: true };
}

export async function reverseSupplierPayment(ctx: Ctx, id: string, reason: string) {
  const p = await one<{ id: string; operation_id: string; status: string; cycle_id: string }>(ctx.trx, sql<{ id: string; operation_id: string; status: string; cycle_id: string }>`
    select id, operation_id, status, cycle_id from supplier_payment where owner_id = ${ctx.ownerId} and id = ${id} for update`);
  if (!p) throw notFound('Supplier payment');
  if (p.status === 'reversed') throw unprocessable('ALREADY_REVERSED', 'The supplier payment is already reversed');
  await reverseOperationCore(ctx, p.operation_id, reason, undefined, { allowLinked: true });
  await sql`update supplier_payment set status = 'reversed' where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'supplier_payment.reverse', entityType: 'supplier_payment', entityId: id, reason });
  return { id, status: 'reversed', cycleId: p.cycle_id };
}

/** Costo previsto, según cobros, pendiente y excedente de un ciclo (RN-F04…F08). */
export async function cycleCost(ctx: Ctx, cycleId: string) {
  const c = await cycleRow(ctx, cycleId);
  const pay = await activePayment(ctx, cycleId);
  const t = await one<{ expected: string; received: string }>(ctx.trx, sql<{ expected: string; received: string }>`
    select coalesce(sum(b.issued_amount + b.adjustments_total), 0.00) as expected, coalesce(sum(b.applied_total), 0.00) as received
    from v_obligation_balance b join member_charge mc on mc.obligation_id = b.obligation_id
    where b.owner_id = ${ctx.ownerId} and mc.cycle_id = ${cycleId}`);
  const r = costSummary({
    announcedPrice: parseMoney(c.terms_snapshot.announcedPrice), actualPaid: pay ? parseMoney(pay.amount_real) : null,
    expectedFromOthers: parseMoney(t!.expected), receivedFromOthers: parseMoney(t!.received),
  });
  const f = (v: bigint) => formatMoney(v);
  return {
    cycleId, announcedPrice: f(r.announcedPrice), actualPaid: r.actualPaid === null ? null : f(r.actualPaid),
    expectedFromOthers: f(r.expectedFromOthers), receivedFromOthers: f(r.receivedFromOthers), pendingFromOthers: f(r.pendingFromOthers),
    projectedCost: f(r.projectedCost), costByCollections: f(r.costByCollections), surplus: f(r.surplus), estimated: r.estimated,
  };
}

export async function getCycleDetail(ctx: Ctx, cycleId: string) {
  const c = await cycleRow(ctx, cycleId);
  await syncSubscription(ctx, c.subscription_id);
  const pay = await activePayment(ctx, cycleId);
  return {
    id: c.id, subscriptionId: c.subscription_id, subscriptionName: c.subscription_name, seq: c.seq, startDate: c.start_date, endDate: c.end_date,
    announcedPrice: c.terms_snapshot.announcedPrice,
    baseDays: c.terms_snapshot.baseDays,
    charges: await listCharges(ctx, sql`mc.cycle_id = ${cycleId}`),
    supplierPayment: pay ? paymentJson(pay) : null,
    costSummary: await cycleCost(ctx, cycleId),
  };
}

/** Resumen de costo del ciclo en curso (o el indicado) de un servicio. */
export async function subscriptionCost(ctx: Ctx, subscriptionId: string, cycleId?: string) {
  await syncSubscription(ctx, subscriptionId);
  let id = cycleId;
  if (!id) {
    const cur = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
      select id from billing_cycle where owner_id = ${ctx.ownerId} and subscription_id = ${subscriptionId}
        and start_date <= ${formatISO(ctx.today)}::date and end_date > ${formatISO(ctx.today)}::date`);
    if (!cur) throw notFound('Current cycle');
    id = cur.id;
  } else {
    const ok = await one(ctx.trx, sql`select 1 from billing_cycle where owner_id = ${ctx.ownerId} and subscription_id = ${subscriptionId} and id = ${id}`);
    if (!ok) throw notFound('Billing cycle');
  }
  return cycleCost(ctx, id);
}
