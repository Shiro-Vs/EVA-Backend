import { sql } from 'kysely';
import { formatISO } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { checkPreviewToken, makePreviewToken } from '../infra/preview.js';
import { getLedgerLoan, ledgerLoanIds } from './loanLedger.js';
import { ts, type Ctx } from './context.js';

export type ConversionTrigger = 'exit' | 'individual_switch' | 'courtesy_choice' | 'manual';

interface SourceRow {
  obligation_id: string; pending: string; due_date: string; start_date: string; end_date: string; seat_label: string; subscription_name: string;
}

/**
 * Convierte la deuda pendiente de unos cargos en UN préstamo con un componente por cargo (RN-X07, A12).
 * Es atómico y no crea ingresos ni egresos: el pendiente de origen baja por conversión y el componente lo abre,
 * así que la deuda total del contacto no cambia. Devuelve null si no había nada pendiente.
 */
export async function convertDebtToLoan(ctx: Ctx, o: { contactId: string; obligationIds: string[]; trigger: ConversionTrigger; reason: string }) {
  if (o.obligationIds.length === 0) return null;
  const src = await rows<SourceRow>(ctx.trx, sql<SourceRow>`
    select b.obligation_id, b.pending_amount as pending, mc.due_date, c.start_date, c.end_date, s.label as seat_label, sub.name as subscription_name
    from v_obligation_balance b
    join member_charge mc on mc.obligation_id = b.obligation_id
    join billing_cycle c on c.id = mc.cycle_id and c.owner_id = mc.owner_id
    join seat s on s.id = mc.seat_id and s.owner_id = mc.owner_id
    join subscription sub on sub.id = c.subscription_id and sub.owner_id = c.owner_id
    where b.owner_id = ${ctx.ownerId} and b.contact_id = ${o.contactId} and b.obligation_id = any(${o.obligationIds}::uuid[]) and b.pending_amount > 0
    order by c.start_date, b.obligation_id`);
  if (src.length === 0) return null;
  const principal = src.reduce((a, r) => a + parseMoney(r.pending), 0n);
  const today = formatISO(ctx.today);

  const loan = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into loan (owner_id, contact_id, principal, opened_on, origin, note)
    values (${ctx.ownerId}, ${o.contactId}, ${formatMoney(principal)}, ${today}, 'debt_conversion', ${o.reason}) returning id`);
  const conv = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into debt_conversion (owner_id, contact_id, loan_id, converted_on, trigger, reason, created_by)
    values (${ctx.ownerId}, ${o.contactId}, ${loan!.id}, ${today}, ${o.trigger}, ${o.reason}, ${ctx.actorId}) returning id`);
  for (const r of src) {
    const ob = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
      insert into receivable_obligation (owner_id, contact_id, kind) values (${ctx.ownerId}, ${o.contactId}, 'loan_component') returning id`);
    await sql`
      insert into loan_component (obligation_id, owner_id, contact_id, loan_id, concept, period_label, origin_obligation_id, amount, due_date)
      values (${ob!.id}, ${ctx.ownerId}, ${o.contactId}, ${loan!.id}, ${`${r.subscription_name} — ${r.seat_label}`}, ${`ciclo ${r.start_date} → ${r.end_date}`},
              ${r.obligation_id}, ${formatMoney(parseMoney(r.pending))}, ${r.due_date})`.execute(ctx.trx);
    await sql`
      insert into debt_conversion_item (owner_id, conversion_id, source_obligation_id, target_obligation_id, amount)
      values (${ctx.ownerId}, ${conv!.id}, ${r.obligation_id}, ${ob!.id}, ${formatMoney(parseMoney(r.pending))})`.execute(ctx.trx);
  }
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'debt.convert', entityType: 'loan', entityId: loan!.id, reason: o.reason,
    changes: { trigger: o.trigger, principal: formatMoney(principal), components: src.length } });
  return getComponentLoan(ctx, loan!.id);
}

interface LoanRow { id: string; contact_id: string; contact_name: string; principal: string; opened_on: string; origin: string; note: string | null; created_at: unknown; trigger: string | null; reason: string | null }
interface CompRow { obligation_id: string; concept: string; period_label: string | null; origin_obligation_id: string | null; amount: string; due_date: string | null; pending: string }

const loanBase = sql`
  select l.id, l.contact_id, c.name as contact_name, l.principal, l.opened_on, l.origin, l.note, l.created_at, dc.trigger, dc.reason
  from loan l join contact c on c.id = l.contact_id and c.owner_id = l.owner_id
  left join debt_conversion dc on dc.loan_id = l.id and dc.owner_id = l.owner_id`;

async function toView(ctx: Ctx, l: LoanRow) {
  const comps = await rows<CompRow>(ctx.trx, sql<CompRow>`
    select lc.obligation_id, lc.concept, lc.period_label, lc.origin_obligation_id, lc.amount, lc.due_date, b.pending_amount as pending
    from loan_component lc join v_obligation_balance b on b.obligation_id = lc.obligation_id
    where lc.owner_id = ${ctx.ownerId} and lc.loan_id = ${l.id} order by lc.due_date nulls last, lc.created_at, lc.obligation_id`);
  const pending = comps.reduce((a, c) => a + parseMoney(c.pending), 0n);
  return {
    id: l.id, contactId: l.contact_id, contactName: l.contact_name, principal: formatMoney(parseMoney(l.principal)), openedOn: l.opened_on, origin: l.origin,
    // Estado derivado: el préstamo se cierra cuando todos sus componentes están saldados.
    status: pending === 0n ? 'closed' : 'open', pending: formatMoney(pending),
    conversion: l.trigger ? { trigger: l.trigger, reason: l.reason } : null,
    createdAt: ts(l.created_at),
    components: comps.map((c) => ({
      obligationId: c.obligation_id, concept: c.concept, periodLabel: c.period_label, originObligationId: c.origin_obligation_id,
      amount: formatMoney(parseMoney(c.amount)), pending: formatMoney(parseMoney(c.pending)), dueDate: c.due_date,
    })),
  };
}

/** Préstamo de una deuda de servicios convertida (con sus componentes). */
async function getComponentLoan(ctx: Ctx, id: string) {
  const l = await one<LoanRow>(ctx.trx, sql<LoanRow>`${loanBase} where l.owner_id = ${ctx.ownerId} and l.id = ${id}`);
  if (!l) throw notFound('Loan');
  return toView(ctx, l);
}

/** Un préstamo de cualquiera de los dos motores: por conversión de deuda (componentes) o del libro de cargos. */
export async function getLoan(ctx: Ctx, id: string): Promise<LoanSummary> {
  const e = await one<{ engine: string }>(ctx.trx, sql<{ engine: string }>`select engine from loan where owner_id = ${ctx.ownerId} and id = ${id}`);
  if (!e) throw notFound('Loan');
  return (e.engine === 'ledger' ? await getLedgerLoan(ctx, id) : await getComponentLoan(ctx, id)) as unknown as LoanSummary;
}

export interface LoanSummary { id: string; openedOn: string; pending: string; contactId: string | null; [k: string]: unknown }

export async function listLoans(ctx: Ctx, contactId?: string) {
  if (contactId) {
    const c = await one(ctx.trx, sql`select 1 as ok from contact where owner_id = ${ctx.ownerId} and id = ${contactId}`);
    if (!c) throw notFound('Contact');
  }
  const ls = await rows<LoanRow>(ctx.trx, contactId
    ? sql<LoanRow>`${loanBase} where l.owner_id = ${ctx.ownerId} and l.engine = 'components' and l.contact_id = ${contactId} order by l.opened_on desc, l.created_at desc`
    : sql<LoanRow>`${loanBase} where l.owner_id = ${ctx.ownerId} and l.engine = 'components' order by l.opened_on desc, l.created_at desc`);
  const out: LoanSummary[] = [];
  for (const l of ls) out.push((await toView(ctx, l)) as unknown as LoanSummary);
  for (const id of await ledgerLoanIds(ctx, contactId)) out.push((await getLedgerLoan(ctx, id)) as unknown as LoanSummary);
  return out.sort((a, b) => b.openedOn.localeCompare(a.openedOn));
}

interface ManualRow { obligation_id: string; pending: string; contact_id: string; is_charge: boolean; seat_label: string | null; subscription_name: string | null; start_date: string | null; end_date: string | null }

async function manualPlan(ctx: Ctx, contactId: string, obligationIds: string[]) {
  const c = await one<{ name: string }>(ctx.trx, sql<{ name: string }>`select name from contact where owner_id = ${ctx.ownerId} and id = ${contactId}`);
  if (!c) throw notFound('Contact');
  const ids = [...new Set(obligationIds)].sort();
  const locked = await rows<{ id: string }>(ctx.trx, sql<{ id: string }>`select id from receivable_obligation where owner_id = ${ctx.ownerId} and id = any(${ids}::uuid[]) order by id for update`);
  if (locked.length !== ids.length) throw notFound('Obligation');
  const src = await rows<ManualRow>(ctx.trx, sql<ManualRow>`
    select b.obligation_id, b.pending_amount as pending, b.contact_id, (mc.obligation_id is not null) as is_charge,
           s.label as seat_label, sub.name as subscription_name, cy.start_date, cy.end_date
    from v_obligation_balance b
    left join member_charge mc on mc.obligation_id = b.obligation_id
    left join seat s on s.id = mc.seat_id and s.owner_id = mc.owner_id
    left join billing_cycle cy on cy.id = mc.cycle_id and cy.owner_id = mc.owner_id
    left join subscription sub on sub.id = cy.subscription_id and sub.owner_id = cy.owner_id
    where b.owner_id = ${ctx.ownerId} and b.obligation_id = any(${ids}::uuid[]) order by cy.start_date, b.obligation_id`);
  if (src.length !== ids.length) throw unprocessable('NOT_CONVERTIBLE', 'One of the items is cancelled and cannot be converted');
  if (src.some((r) => r.contact_id !== contactId)) throw unprocessable('OBLIGATION_CONTACT_MISMATCH', 'One of the items belongs to another contact');
  if (src.some((r) => !r.is_charge)) throw unprocessable('NOT_CONVERTIBLE', 'A loan component cannot be converted again');
  const payable = src.filter((r) => parseMoney(r.pending) > 0n);
  if (payable.length === 0) throw unprocessable('NOTHING_TO_CONVERT', 'There is no pending debt to convert');
  return { contactName: c.name, ids: payable.map((r) => r.obligation_id), rows: payable, total: payable.reduce((a, r) => a + parseMoney(r.pending), 0n) };
}

const manualInputs = (contactId: string, ids: string[]) => ({ contactId, ids: [...new Set(ids)].sort() });

/** Vista previa de la conversión manual de deuda a préstamo (RN-X07): no cambia la deuda total del contacto. */
export async function previewDebtConversion(ctx: Ctx, contactId: string, obligationIds: string[]) {
  const p = await manualPlan(ctx, contactId, obligationIds);
  return {
    contact: { id: contactId, name: p.contactName },
    total: formatMoney(p.total),
    totalDebtBefore: formatMoney(p.total),
    totalDebtAfter: formatMoney(p.total), // la deuda no cambia: pasa de cargos a componentes de préstamo
    components: p.rows.map((r) => ({
      obligationId: r.obligation_id, concept: `${r.subscription_name} — ${r.seat_label}`, periodLabel: `ciclo ${r.start_date} → ${r.end_date}`, amount: formatMoney(parseMoney(r.pending)),
    })),
    previewToken: makePreviewToken(ctx.previewSecret, { scope: 'debt.convert', ownerId: ctx.ownerId, inputs: manualInputs(contactId, obligationIds), state: p.rows.map((r) => [r.obligation_id, r.pending]) }, ctx.nowMs),
  };
}

export async function applyDebtConversion(ctx: Ctx, contactId: string, i: { obligationIds: string[]; reason: string; previewToken: string }) {
  const p = await manualPlan(ctx, contactId, i.obligationIds);
  checkPreviewToken(ctx.previewSecret, i.previewToken, { scope: 'debt.convert', ownerId: ctx.ownerId, inputs: manualInputs(contactId, i.obligationIds), state: p.rows.map((r) => [r.obligation_id, r.pending]) }, ctx.nowMs);
  return convertDebtToLoan(ctx, { contactId, obligationIds: p.ids, trigger: 'manual', reason: i.reason.trim() });
}
