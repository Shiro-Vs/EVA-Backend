import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { formatISO, fromYMD, parseISO, toYMD } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { canonical } from '../infra/idempotency.js';
import { ts, type Ctx } from './context.js';
import { requireOwned } from './operations.js';

/** Versión de las reglas de cálculo del resumen (RN-RM03). Súbela si cambia cómo se clasifica o suma. */
export const REPORT_RULES_VERSION = 'reports@1';

const m = (v: bigint) => formatMoney(v);
const abs = (v: bigint) => (v < 0n ? -v : v);

export interface MonthlyParams { month: string; accountIds?: string[]; detail?: boolean }

// ───────────────────────── Clasificación (08 §1) ─────────────────────────

export const FLOW_TYPES = ['income', 'expense', 'service_collection', 'service_payment', 'refund', 'loan', 'card_payment', 'transfer', 'adjustment', 'reversal'] as const;
type FlowType = (typeof FLOW_TYPES)[number];
const FLOW_LABEL: Record<FlowType, string> = {
  income: 'Ingresos', expense: 'Gastos', service_collection: 'Cobros de servicios compartidos', service_payment: 'Pagos a proveedores de servicios', refund: 'Devoluciones a participantes',
  loan: 'Préstamos (capital e intereses)', card_payment: 'Pagos de tarjeta de crédito', transfer: 'Transferencias entre tus cuentas', adjustment: 'Ajustes y saldos iniciales', reversal: 'Reversiones',
};

interface Row {
  entry_id: string; operation_id: string; account_id: string; account_name: string; amount: string; kind: string; concept: string; status: string; occurred_on: string; occurred_time: string | null;
  description: string; category_id: string | null; category_name: string | null; parent_name: string | null;
  is_receipt: boolean; is_supplier: boolean; is_refund: boolean; is_card_payment: boolean;
  l_principal: string | null; l_interest: string | null; l_late: string | null; l_unapplied: string | null;
  b_amount: string | null; b_principal: string | null; b_interest: string | null; b_insurance: string | null; b_fees: string | null;
}

function flowTypeOf(r: Row): FlowType {
  if (r.kind === 'reversal') return 'reversal';
  if (r.kind === 'adjustment' || r.kind === 'opening' || r.concept === 'reconciliation') return 'adjustment';
  if (r.kind === 'transfer') return r.is_card_payment ? 'card_payment' : 'transfer';
  if (r.is_receipt) return 'service_collection';
  if (r.is_supplier) return 'service_payment';
  if (r.is_refund) return 'refund';
  if (r.concept === 'loan_disbursement' || r.concept === 'loan_payment') return 'loan';
  return r.kind === 'income' ? 'income' : 'expense';
}

const catLabel = (r: Row) => (r.category_id ? (r.parent_name ? `${r.parent_name} › ${r.category_name}` : r.category_name ?? 'Sin nombre') : 'Sin categoría');

function group(map: Map<string, { total: bigint; count: number }>, total: bigint) {
  return [...map.entries()].sort((a, b) => (a[1].total === b[1].total ? a[0].localeCompare(b[0]) : a[1].total > b[1].total ? -1 : 1))
    .map(([name, v]) => ({ name, total: m(v.total), count: v.count, percent: total === 0n ? 0 : Number((v.total * 1000n) / total) / 10 }));
}
const bump = (map: Map<string, { total: bigint; count: number }>, k: string, v: bigint) => { const c = map.get(k) ?? { total: 0n, count: 0 }; c.total += v; c.count++; map.set(k, c); };

// ───────────────────────── Cálculo del resumen mensual ─────────────────────────

export function monthRange(month: string) {
  const mt = /^(\d{4})-(\d{2})$/.exec(month);
  if (!mt || Number(mt[2]) < 1 || Number(mt[2]) > 12) throw unprocessable('VALIDATION_ERROR', 'El mes debe tener el formato AAAA-MM');
  const y = Number(mt[1]); const mo = Number(mt[2]);
  const next = mo === 12 ? fromYMD(y + 1, 1, 1) : fromYMD(y, mo + 1, 1);
  return { from: formatISO(fromYMD(y, mo, 1)), to: formatISO(next - 1) };
}

export async function computeMonthly(ctx: Ctx, p: MonthlyParams) {
  const { from, to } = monthRange(p.month);
  const cur = toYMD(ctx.today);
  if (p.month > `${cur.y}-${String(cur.m).padStart(2, '0')}`) throw unprocessable('FUTURE_DATE_NOT_ALLOWED', 'No hay resumen de un mes futuro');
  const ids = [...new Set(p.accountIds ?? [])].sort();
  for (const id of ids) await requireOwned(ctx, 'account', id);
  const accFilter = ids.length ? sql`and e.account_id in (${sql.join(ids.map((i) => sql`${i}::uuid`))})` : sql``;

  // Saldos de apertura y cierre: suma de asientos hasta la fecha, por cuenta (siempre cuadran con el flujo).
  const bal = await rows<{ id: string; name: string; type: string; archived: boolean; opening: string; closing: string }>(ctx.trx, sql`
    select a.id, a.name, a.type, (a.status = 'archived') as archived,
           coalesce(sum(e.amount) filter (where o.occurred_on < ${from}::date), 0) as opening,
           coalesce(sum(e.amount) filter (where o.occurred_on <= ${to}::date), 0) as closing
    from account a left join account_entry e on e.owner_id = a.owner_id and e.account_id = a.id
         left join financial_operation o on o.owner_id = e.owner_id and o.id = e.operation_id
    where a.owner_id = ${ctx.ownerId} ${ids.length ? sql`and a.id in (${sql.join(ids.map((i) => sql`${i}::uuid`))})` : sql``}
    group by a.id, a.name, a.type, a.status order by a.name, a.id`);
  const accounts = bal.filter((a) => !a.archived || parseMoney(a.opening, { allowNegative: true }) !== 0n || parseMoney(a.closing, { allowNegative: true }) !== 0n);

  const data = await rows<Row>(ctx.trx, sql<Row>`
    with ledger as (
      select lp.operation_id,
             sum(al.amount) filter (where c.concept = 'principal') as l_principal,
             sum(al.amount) filter (where c.concept = 'interest') as l_interest,
             sum(al.amount) filter (where c.concept = 'late_fee') as l_late,
             max(lp.unapplied) as l_unapplied
      from loan_payment lp left join loan_allocation al on al.owner_id = lp.owner_id and al.payment_id = lp.id
           left join loan_charge c on c.owner_id = al.owner_id and c.id = al.charge_id
      where lp.owner_id = ${ctx.ownerId} and lp.status = 'active' group by lp.operation_id)
    select e.id as entry_id, e.operation_id, e.account_id, a.name as account_name, e.amount, o.kind, o.concept, o.status, o.occurred_on, o.occurred_time::text as occurred_time, o.description,
           o.category_id, c.name as category_name, p.name as parent_name,
           exists (select 1 from receipt r where r.operation_id = o.id) as is_receipt,
           exists (select 1 from supplier_payment s where s.operation_id = o.id) as is_supplier,
           exists (select 1 from refund f where f.operation_id = o.id) as is_refund,
           (o.kind = 'transfer' and exists (select 1 from account_entry e2 join account a2 on a2.owner_id = e2.owner_id and a2.id = e2.account_id where e2.operation_id = o.id and e2.owner_id = o.owner_id and a2.type = 'credit')) as is_card_payment,
           l.l_principal, l.l_interest, l.l_late, l.l_unapplied,
           b.amount as b_amount, b.principal as b_principal, b.interest as b_interest, b.insurance as b_insurance, b.fees as b_fees
    from account_entry e
    join financial_operation o on o.owner_id = e.owner_id and o.id = e.operation_id
    join account a on a.owner_id = e.owner_id and a.id = e.account_id
    left join category c on c.owner_id = o.owner_id and c.id = o.category_id
    left join category p on p.owner_id = c.owner_id and p.id = c.parent_id
    left join ledger l on l.operation_id = o.id
    left join bank_loan_payment b on b.owner_id = o.owner_id and b.operation_id = o.id and b.status = 'active'
    where e.owner_id = ${ctx.ownerId} and o.occurred_on between ${from}::date and ${to}::date ${accFilter}
    order by o.occurred_on, o.occurred_time nulls first, o.created_at, e.id`);

  // ----- Flujo de dinero: todo lo que entró y salió de las cuentas; cuadra con apertura y cierre -----
  const flow = new Map<FlowType, { in: bigint; out: bigint; n: number }>(FLOW_TYPES.map((t) => [t, { in: 0n, out: 0n, n: 0 }]));
  // ----- Resultado por conceptos -----
  const incomeBy = new Map<string, { total: bigint; count: number }>();
  const consumptionBy = new Map<string, { total: bigint; count: number }>();
  let income = 0n; let consumption = 0n; let finIncome = 0n;
  const finCost = { loanInterest: 0n, loanLateFees: 0n, bankInterest: 0n, bankInsurance: 0n, bankFees: 0n };
  const shared = { paid: 0n, collected: 0n, refunds: 0n };
  const other = { transfersIn: 0n, transfersOut: 0n, cardPayments: 0n, loansIn: 0n, loansOut: 0n, adjustments: 0n };
  let reversalsCount = 0; let reversedCount = 0; let undisclosed = 0; let unclassified = 0;

  for (const r of data) {
    const amt = parseMoney(r.amount, { allowNegative: true });
    const t = flowTypeOf(r);
    const f = flow.get(t)!;
    if (amt >= 0n) f.in += amt; else f.out += -amt;
    f.n++;
    if (r.kind === 'reversal') { reversalsCount++; continue; }
    if (r.status === 'reversed') { reversedCount++; continue; }
    const a = abs(amt);
    switch (t) {
      case 'adjustment': other.adjustments += amt; break;
      case 'transfer': if (amt >= 0n) other.transfersIn += a; else other.transfersOut += a; break;
      case 'card_payment': if (amt < 0n) other.cardPayments += a; else other.transfersIn += 0n; break;
      case 'service_collection': shared.collected += a; break;
      case 'service_payment': shared.paid += a; break;
      case 'refund': shared.refunds += a; break;
      case 'loan': {
        const inflow = amt >= 0n;
        if (r.concept === 'loan_disbursement') { if (inflow) other.loansIn += a; else other.loansOut += a; break; }
        const money = (v: string | null) => (v ? parseMoney(v) : 0n);
        if (r.l_principal !== null || r.l_interest !== null || r.l_late !== null) {
          const i = money(r.l_interest); const lf = money(r.l_late); const pr = a - i - lf;
          if (inflow) { finIncome += i + lf; other.loansIn += pr; } else { finCost.loanInterest += i; finCost.loanLateFees += lf; other.loansOut += pr; }
        } else if (r.b_amount !== null) {
          const i = money(r.b_interest); const s = money(r.b_insurance); const fe = money(r.b_fees); const known = i + s + fe;
          finCost.bankInterest += i; finCost.bankInsurance += s; finCost.bankFees += fe;
          other.loansOut += a - known;
          if (money(r.b_principal) + known < a) undisclosed++;
        } else if (inflow) other.loansIn += a; else other.loansOut += a;
        break;
      }
      case 'income': income += a; bump(incomeBy, catLabel(r), a); break;
      case 'expense': consumption += a; bump(consumptionBy, catLabel(r), a); if (!r.category_id) unclassified++; break;
      default: break;
    }
  }

  const openingTotal = accounts.reduce((s, a) => s + parseMoney(a.opening, { allowNegative: true }), 0n);
  const closingTotal = accounts.reduce((s, a) => s + parseMoney(a.closing, { allowNegative: true }), 0n);
  const flowLines = FLOW_TYPES.map((t) => ({ type: t, label: FLOW_LABEL[t], in: m(flow.get(t)!.in), out: m(flow.get(t)!.out), net: m(flow.get(t)!.in - flow.get(t)!.out), movements: flow.get(t)!.n })).filter((l) => l.movements > 0);
  const flowIn = [...flow.values()].reduce((s, x) => s + x.in, 0n);
  const flowOut = [...flow.values()].reduce((s, x) => s + x.out, 0n);

  const finCostTotal = Object.values(finCost).reduce((s, x) => s + x, 0n);
  const sharedNetCost = shared.paid - shared.collected + shared.refunds;
  const resultsNet = income + finIncome - consumption - finCostTotal - sharedNetCost;

  const notes: string[] = [];
  if (unclassified > 0) notes.push(`${unclassified} gastos sin categoría: están en el total pero no se pueden atribuir a una categoría.`);
  if (undisclosed > 0) notes.push(`${undisclosed} pagos de préstamos bancarios sin desglose completo: lo no desglosado se muestra como capital/pago sin detallar, no como costo financiero.`);
  if (reversedCount + reversalsCount > 0) notes.push('Los movimientos revertidos y sus reversiones no se suman en el resultado; en el flujo aparecen en su propia línea.');
  notes.push('Los intereses de tarjeta de crédito no registrados como movimiento no se incluyen.');
  const pend = await one<{ n: string }>(ctx.trx, sql<{ n: string }>`select count(*) as n from movement_proposal where owner_id = ${ctx.ownerId} and status = 'pending'`);
  if (Number(pend?.n ?? 0) > 0) notes.push(`Hay ${pend!.n} propuestas de captura sin aceptar: no forman parte de este resumen.`);

  const detail = p.detail ? data.slice(0, 2000).map((r) => ({
    date: r.occurred_on, time: r.occurred_time ? r.occurred_time.slice(0, 5) : null, account: r.account_name, type: flowTypeOf(r), kind: r.kind, status: r.status,
    description: r.description, category: r.category_id ? catLabel(r) : null, amount: m(parseMoney(r.amount, { allowNegative: true })),
  })) : undefined;

  const result = {
    period: { month: p.month, from, to },
    filters: { accountIds: ids, accounts: ids.length ? accounts.map((a) => a.name) : [], detail: !!p.detail },
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, opening: m(parseMoney(a.opening, { allowNegative: true })), closing: m(parseMoney(a.closing, { allowNegative: true })), change: m(parseMoney(a.closing, { allowNegative: true }) - parseMoney(a.opening, { allowNegative: true })) })),
    flow: {
      label: 'Flujo de dinero', note: 'Todo lo que entró y salió realmente de tus cuentas, por fecha de la operación.',
      opening: m(openingTotal), lines: flowLines, totalIn: m(flowIn), totalOut: m(flowOut), net: m(flowIn - flowOut), closing: m(closingTotal), reconciles: openingTotal + flowIn - flowOut === closingTotal,
    },
    results: {
      label: 'Resultado por conceptos', note: 'Cuánto ganaste, consumiste y qué costo financiero tuviste. No incluye transferencias, capital de préstamos ni pagos de tarjeta.',
      income: { total: m(income), byCategory: group(incomeBy, income) },
      consumption: { total: m(consumption), byCategory: group(consumptionBy, consumption) },
      financialIncome: m(finIncome),
      financialCosts: { total: m(finCostTotal), loanInterest: m(finCost.loanInterest), loanLateFees: m(finCost.loanLateFees), bankInterest: m(finCost.bankInterest), bankInsurance: m(finCost.bankInsurance), bankFees: m(finCost.bankFees) },
      sharedServices: { paidToSuppliers: m(shared.paid), collected: m(shared.collected), refunds: m(shared.refunds), netCost: m(sharedNetCost) },
      net: m(resultsNet),
    },
    other: {
      label: 'Fuera del resultado', transfers: { in: m(other.transfersIn), out: m(other.transfersOut) }, cardPayments: m(other.cardPayments),
      loans: { capitalIn: m(other.loansIn), capitalOut: m(other.loansOut) }, adjustments: m(other.adjustments), reversals: { reversed: reversedCount, reversalEntries: reversalsCount },
    },
    counts: { movements: data.length },
    notes,
    ...(detail ? { operations: detail, operationsTruncated: data.length > 2000 } : {}),
  };
  return result;
}
export type MonthlyData = Awaited<ReturnType<typeof computeMonthly>>;

// ───────────────────────── Vista viva y versiones guardadas ─────────────────────────

const sha = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const normParams = (p: MonthlyParams) => ({ month: p.month, accountIds: [...new Set(p.accountIds ?? [])].sort(), detail: !!p.detail });

interface SnapRow { id: string; period: string; params: unknown; version: number; rules_version: string; data_hash: string; data: MonthlyData; generated_at: unknown; params_hash: string }
const snapSel = sql`select id, period, params, params_hash, version, rules_version, data_hash, data, generated_at from report_snapshot`;
const snapView = (s: SnapRow) => ({ id: s.id, period: s.period, version: s.version, params: s.params, rulesVersion: s.rules_version, generatedAt: ts(s.generated_at), data: s.data });
const snapMeta = (s: SnapRow) => ({ id: s.id, version: s.version, generatedAt: ts(s.generated_at), rulesVersion: s.rules_version });

export async function liveMonthly(ctx: Ctx, params: MonthlyParams) {
  const np = normParams(params);
  const data = await computeMonthly(ctx, np);
  const saved = await rows<SnapRow>(ctx.trx, sql<SnapRow>`${snapSel} where owner_id = ${ctx.ownerId} and kind = 'monthly' and period = ${np.month} and params_hash = ${sha(np)} order by version desc`);
  return {
    live: true, generatedAt: new Date(ctx.nowMs).toISOString(), rulesVersion: REPORT_RULES_VERSION, ...data,
    savedVersions: saved.map(snapMeta),
    // Si ya hay una versión guardada y los números actuales difieren, hubo cambios posteriores (RN-RM02).
    differsFromLatestSaved: saved.length > 0 ? saved[0]!.data_hash !== sha(data) : null,
  };
}

/** Guarda una instantánea. Si no cambió nada respecto de la última versión, no crea otra. */
export async function saveMonthly(ctx: Ctx, params: MonthlyParams) {
  const np = normParams(params);
  const hash = sha(np);
  await sql`select pg_advisory_xact_lock(hashtextextended(${`${ctx.ownerId}:monthly:${np.month}:${hash}`}, 0))`.execute(ctx.trx);
  const data = await computeMonthly(ctx, np);
  const dataHash = sha(data);
  const last = await one<SnapRow>(ctx.trx, sql<SnapRow>`${snapSel} where owner_id = ${ctx.ownerId} and kind = 'monthly' and period = ${np.month} and params_hash = ${hash} order by version desc limit 1`);
  if (last && last.data_hash === dataHash) return { ...snapView(last), unchanged: true };
  const snap = await one<SnapRow>(ctx.trx, sql<SnapRow>`
    insert into report_snapshot (owner_id, kind, period, params, params_hash, version, rules_version, data_hash, data, generated_at)
    values (${ctx.ownerId}, 'monthly', ${np.month}, ${JSON.stringify(np)}::jsonb, ${hash}, ${(last?.version ?? 0) + 1}, ${REPORT_RULES_VERSION}, ${dataHash}, ${JSON.stringify(data)}::jsonb, ${new Date(ctx.nowMs).toISOString()})
    returning id, period, params, params_hash, version, rules_version, data_hash, data, generated_at`);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'report.snapshot', entityType: 'report_snapshot', entityId: snap!.id, changes: { period: np.month, version: snap!.version } });
  return { ...snapView(snap!), unchanged: false, previousVersion: last?.version ?? null };
}

export async function listSnapshots(ctx: Ctx, month?: string) {
  const r = await rows<SnapRow>(ctx.trx, sql<SnapRow>`${snapSel} where owner_id = ${ctx.ownerId} and kind = 'monthly' and (${month ?? null}::text is null or period = ${month ?? null}) order by period desc, generated_at desc, version desc limit 200`);
  return r.map((s) => ({ ...snapMeta(s), period: s.period, params: s.params }));
}

export async function getSnapshot(ctx: Ctx, id: string) {
  const s = await one<SnapRow>(ctx.trx, sql<SnapRow>`${snapSel} where owner_id = ${ctx.ownerId} and id = ${id}`);
  if (!s) throw notFound('Report');
  return snapView(s);
}
