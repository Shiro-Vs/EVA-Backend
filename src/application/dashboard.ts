import { sql } from 'kysely';
import { nextDueDate } from '../domain/card.js';
import { addDays, formatISO, parseISO } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { completeCards, resolvePreferences, type CardId, type Preferences, type PreferencesPatch } from '../domain/preferences.js';
import { one, rows } from '../infra/db/db.js';
import { audit } from '../infra/audit.js';
import { listAccounts } from './accounts.js';
import { listBudgets } from './budgets.js';
import type { Ctx } from './context.js';
import { overview as goalsOverview } from './goals.js';
import { computeMonthly } from './reports.js';
import { summary } from './summary.js';

const m = (v: string | bigint) => (typeof v === 'bigint' ? formatMoney(v) : formatMoney(parseMoney(v, { allowNegative: true })));

// ───────────────────────── Preferencias ─────────────────────────

export async function getPreferences(ctx: Ctx): Promise<Preferences> {
  const r = await one<{ preferences: unknown }>(ctx.trx, sql<{ preferences: unknown }>`select preferences from user_profile where id = ${ctx.ownerId}`);
  return resolvePreferences(r?.preferences);
}

/** Cada sección enviada reemplaza a la guardada; las demás no se tocan. */
export async function savePreferences(ctx: Ctx, patch: PreferencesPatch): Promise<Preferences> {
  const next: Record<string, unknown> = { ...patch };
  if (patch.dashboard) next.dashboard = { cards: completeCards(patch.dashboard.cards) };
  await sql`update user_profile set preferences = coalesce(preferences, '{}'::jsonb) || ${JSON.stringify(next)}::jsonb where id = ${ctx.ownerId}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'preferences.update', entityType: 'user_profile', entityId: ctx.ownerId, changes: { sections: Object.keys(patch) } });
  return getPreferences(ctx);
}

// ───────────────────────── Datos de cada tarjeta ─────────────────────────

const TITLES: Record<CardId, string> = {
  accounts_balance: 'Saldo por cuenta', credit_debt: 'Deuda de tarjetas', period_flow: 'Ingresos y gastos del mes', budgets: 'Presupuestos', goals: 'Metas', renewals: 'Próximas renovaciones',
  pending_collections: 'Cobros pendientes', loans: 'Préstamos', capture_pending: 'Por revisar', upcoming_payments: 'Próximos pagos',
};

async function renewals(ctx: Ctx, days: number) {
  const today = formatISO(ctx.today); const until = formatISO(addDays(ctx.today, days));
  return rows<{ subscription_id: string; name: string; renews_on: string; price: string }>(ctx.trx, sql`
    select s.id as subscription_id, s.name, c.end_date::text as renews_on, coalesce(c.terms_snapshot->>'announcedPrice', '0') as price
    from subscription s join billing_cycle c on c.owner_id = s.owner_id and c.subscription_id = s.id and c.start_date <= ${today}::date and c.end_date > ${today}::date
    where s.owner_id = ${ctx.ownerId} and s.status = 'active' and c.end_date <= ${until}::date order by c.end_date, s.name limit 50`);
}

async function bankInstallments(ctx: Ctx, days: number) {
  const until = formatISO(addDays(ctx.today, days));
  return rows<{ loan_id: string; loan_name: string; no: number; due_date: string; remaining: string }>(ctx.trx, sql`
    select l.id as loan_id, l.name as loan_name, i.no, i.due_date::text as due_date, greatest(i.total - i.paid_amount, 0) as remaining
    from bank_loan_installment i join bank_loan l on l.owner_id = i.owner_id and l.id = i.loan_id
    where i.owner_id = ${ctx.ownerId} and l.status = 'active' and i.status = 'scheduled' and i.due_date <= ${until}::date order by i.due_date, i.no limit 50`);
}

async function recurringDue(ctx: Ctx, days: number) {
  const until = formatISO(addDays(ctx.today, days));
  return rows<{ occurrence_id: string; name: string; kind: string; due_date: string; amount: string }>(ctx.trx, sql`
    select o.id as occurrence_id, t.name, t.kind, o.due_date::text as due_date, o.amount
    from expected_occurrence o join recurring_template t on t.owner_id = o.owner_id and t.id = o.template_id
    where o.owner_id = ${ctx.ownerId} and o.status = 'pending' and o.due_date <= ${until}::date order by o.due_date, t.name limit 50`);
}

interface CardPaymentDue {
  type: 'card_statement' | 'card_debt';
  id: string;
  accountId: string;
  name: string;
  dueDate: string;
  amount: string;
}

/**
 * Pagos próximos de tarjetas de crédito dentro del horizonte:
 * 1) Estados de cuenta activos con saldo pendiente (incluye vencidos).
 * 2) Tarjetas configuradas con deuda actual > 0 cuyo próximo día de pago cae dentro del horizonte
 *    (solo si no tienen ya un estado de cuenta pendiente ni uno ya pagado para esa misma fecha).
 */
async function cardPaymentsDue(ctx: Ctx, days: number): Promise<CardPaymentDue[]> {
  const untilDate = addDays(ctx.today, days);
  const until = formatISO(untilDate);

  const stmts = await rows<{ id: string; account_id: string; account_name: string; due_date: string; remaining: string }>(ctx.trx, sql`
    select s.id, s.account_id, a.name as account_name, s.due_date::text as due_date,
           greatest(s.period_total - coalesce((
             select sum(e.amount)
             from card_statement_payment p
             join financial_operation o on o.id = p.operation_id and o.owner_id = p.owner_id
             join account_entry e on e.operation_id = o.id and e.owner_id = o.owner_id and e.account_id = s.account_id and e.amount > 0
             where p.owner_id = s.owner_id and p.statement_id = s.id and p.status = 'active' and o.status = 'confirmed'
           ), 0), 0) as remaining
    from card_statement s
    join account a on a.id = s.account_id and a.owner_id = s.owner_id
    where s.owner_id = ${ctx.ownerId} and s.status = 'active' and a.status = 'active' and a.type = 'credit' and s.due_date <= ${until}::date
    order by s.due_date, a.name limit 50`);

  const out: CardPaymentDue[] = [];
  const accountsWithUnpaidStmt = new Set<string>();
  const coveredDueByAccount = new Set<string>();

  for (const s of stmts) {
    coveredDueByAccount.add(`${s.account_id}:${s.due_date}`);
    if (parseMoney(s.remaining) > 0n) {
      accountsWithUnpaidStmt.add(s.account_id);
      out.push({
        type: 'card_statement',
        id: s.id,
        accountId: s.account_id,
        name: `Pago tarjeta ${s.account_name}`,
        dueDate: s.due_date,
        amount: m(s.remaining),
      });
    }
  }

  const cards = await rows<{ account_id: string; account_name: string; due_day: number; balance: string }>(ctx.trx, sql`
    select a.id as account_id, a.name as account_name, d.due_day, coalesce(b.balance, 0.00) as balance
    from account a
    join credit_account_details d on d.account_id = a.id and d.owner_id = a.owner_id
    left join v_account_balance b on b.account_id = a.id and b.owner_id = a.owner_id
    where a.owner_id = ${ctx.ownerId} and a.status = 'active' and a.type = 'credit'`);

  for (const c of cards) {
    if (accountsWithUnpaidStmt.has(c.account_id)) continue;
    const bal = parseMoney(c.balance, { allowNegative: true });
    if (bal >= 0n) continue;
    const due = nextDueDate(ctx.today, c.due_day);
    if (due > untilDate) continue;
    const dueIso = formatISO(due);
    if (coveredDueByAccount.has(`${c.account_id}:${dueIso}`)) continue;
    out.push({
      type: 'card_debt',
      id: c.account_id,
      accountId: c.account_id,
      name: `Pago tarjeta ${c.account_name}`,
      dueDate: dueIso,
      amount: m(-bal),
    });
  }

  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name));
}

async function collectionsDue(ctx: Ctx, days: number) {
  const until = formatISO(addDays(ctx.today, days));
  return rows<{ due_date: string; n: string; total: string }>(ctx.trx, sql`
    select d.effective_due_date::text as due_date, count(*) as n, sum(b.pending_amount) as total
    from v_obligation_balance b join v_charge_due d on d.obligation_id = b.obligation_id
    where b.owner_id = ${ctx.ownerId} and b.pending_amount > 0 and d.effective_due_date <= ${until}::date group by d.effective_due_date order by d.effective_due_date limit 60`);
}

async function capturePending(ctx: Ctx) {
  const r = await one<{ pending: string; classify: string; failed: string; loan_docs: string }>(ctx.trx, sql`
    select (select count(*) from movement_proposal where owner_id = ${ctx.ownerId} and status = 'pending') as pending,
           -- aceptados por clasificar: ya afectan saldo pero no tienen categoría (RN-PA03)
           (select count(*) from financial_operation o where o.owner_id = ${ctx.ownerId} and o.status = 'confirmed' and o.kind in ('income','expense') and o.category_id is null
              and exists (select 1 from movement_proposal p where p.owner_id = o.owner_id and p.operation_id = o.id and p.status = 'accepted')) as classify,
           (select count(*) from source_document where owner_id = ${ctx.ownerId} and status = 'failed') as failed,
           (select count(*) from source_document where owner_id = ${ctx.ownerId} and status = 'loan_document') as loan_docs`);
  return { pendingProposals: Number(r?.pending ?? 0), acceptedToClassify: Number(r?.classify ?? 0), failedDocuments: Number(r?.failed ?? 0), loanDocuments: Number(r?.loan_docs ?? 0) };
}

async function cardData(ctx: Ctx, id: CardId, cache: { summary?: Awaited<ReturnType<typeof summary>> }): Promise<unknown> {
  switch (id) {
    case 'accounts_balance': {
      const accs = (await listAccounts(ctx, 'active')).filter((a) => a.type !== 'credit');
      return { accounts: accs.map((a) => ({ id: a.id, name: a.name, type: a.type, balance: a.balance, excludeFromTotal: a.excludeFromTotal })), net: (cache.summary ??= await summary(ctx)).balance.net };
    }
    case 'credit_debt': {
      const cards = (await listAccounts(ctx, 'active')).filter((a) => a.type === 'credit');
      return { cards: cards.map((a) => ({ id: a.id, name: a.name, debt: m(-parseMoney(a.balance, { allowNegative: true })) })) };
    }
    case 'period_flow': {
      const ym = formatISO(ctx.today).slice(0, 7);
      const r = (await computeMonthly(ctx, { month: ym })).results;
      return { month: ym, income: r.income.total, consumption: r.consumption.total, net: r.net };
    }
    case 'budgets': {
      const bs = await listBudgets(ctx);
      return { budgets: bs.map((b) => ({ id: b.id, name: b.name, percent: b.current.percent, level: b.current.level, exceeded: b.current.exceeded, remaining: b.current.remaining })) };
    }
    case 'goals': {
      const o = await goalsOverview(ctx);
      return { totals: o.totals };
    }
    case 'renewals': return { items: (await renewals(ctx, 14)).map((r) => ({ subscriptionId: r.subscription_id, name: r.name, renewsOn: r.renews_on, price: m(r.price) })) };
    case 'pending_collections': { const s = (cache.summary ??= await summary(ctx)); return { pending: s.receivable.pending, overdue: s.receivable.overdue, debtors: s.receivable.debtors }; }
    case 'loans': {
      const s = (cache.summary ??= await summary(ctx));
      const bank = await bankInstallments(ctx, 30);
      return { ledger: s.loans, bankLoans: { nextInstallments: bank.slice(0, 5).map((b) => ({ loanId: b.loan_id, name: b.loan_name, number: b.no, dueDate: b.due_date, remaining: m(b.remaining) })) } };
    }
    case 'capture_pending': return capturePending(ctx);
    case 'upcoming_payments': {
      const items = [
        ...(await bankInstallments(ctx, 14)).map((b) => ({ type: 'bank_loan', id: b.loan_id, name: `${b.loan_name} · cuota ${b.no}`, dueDate: b.due_date, amount: m(b.remaining) })),
        ...(await recurringDue(ctx, 14)).filter((o) => o.kind === 'expense').map((o) => ({ type: 'recurring', id: o.occurrence_id, name: o.name, dueDate: o.due_date, amount: m(o.amount) })),
        ...(await cardPaymentsDue(ctx, 14)).map((c) => ({ type: c.type, id: c.id, name: c.name, dueDate: c.dueDate, amount: c.amount })),
      ].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      return { items: items.slice(0, 10) };
    }
  }
}

/** Panel: solo las tarjetas habilitadas, en el orden elegido (RN-PA01). */
export async function dashboard(ctx: Ctx) {
  const prefs = await getPreferences(ctx);
  const cache: { summary?: Awaited<ReturnType<typeof summary>> } = {};
  const cards = [];
  for (const c of prefs.dashboard.cards) if (c.enabled) cards.push({ id: c.id, title: TITLES[c.id], data: await cardData(ctx, c.id, cache) });
  return { asOf: formatISO(ctx.today), cards, available: prefs.dashboard.cards.map((c) => ({ id: c.id, title: TITLES[c.id], enabled: c.enabled })) };
}

// ───────────────────────── Avisos y recordatorios ─────────────────────────

const GENERIC: Record<string, string> = {
  renewal: 'Tienes renovaciones próximas', collection: 'Tienes cobros por revisar', recurring: 'Tienes movimientos recurrentes por decidir', loan: 'Tienes cuotas de préstamo próximas',
  card: 'Tienes un pago de tarjeta próximo', budget: 'Un presupuesto necesita tu atención', capture: 'Tienes propuestas por revisar',
};

interface Reminder { id: string; kind: string; dueDate: string | null; overdue: boolean; title: string; detail: string | null; route: string; count: number; fireAt: string[] }

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fromMin = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

/** Si la hora cae en el horario silencioso, se mueve al final de ese horario (09 §7). */
export function outsideQuiet(time: string, quiet: { from: string; to: string } | null): { time: string; nextDay: boolean } {
  if (!quiet) return { time, nextDay: false };
  const t = toMin(time); const f = toMin(quiet.from); const e = toMin(quiet.to);
  const inQuiet = f === e ? false : f < e ? t >= f && t < e : t >= f || t < e;
  if (!inQuiet) return { time, nextDay: false };
  return { time: quiet.to, nextDay: f > e && t >= f };
}

/**
 * Qué avisar y cuándo (hora local). El teléfono programa las notificaciones con esta lista; el servidor no envía nada a terceros.
 * El contenido es discreto por defecto: sin importes ni nombres hasta que el usuario habilite el detalle.
 */
export async function reminders(ctx: Ctx, horizonDays = 14) {
  const tz = (await one<{ timezone: string }>(ctx.trx, sql<{ timezone: string }>`select timezone from user_profile where id = ${ctx.ownerId}`))?.timezone ?? 'America/Lima';
  const localNow = { date: formatISO(ctx.today), time: new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ctx.nowMs)) };
  const prefs = (await getPreferences(ctx)).notifications;
  if (!prefs.enabled) return { enabled: false, items: [] as Reminder[] };
  const today = formatISO(ctx.today);
  const k = prefs.kinds;

  const pushAt = (out: string[], date: string, time: string) => {
    const q = outsideQuiet(time, prefs.quiet);
    const d = q.nextDay ? formatISO(addDays(parseISO(date), 1)) : date;
    const stamp = `${d}T${q.time}`;
    if (stamp >= `${localNow.date}T${localNow.time}` && d <= formatISO(addDays(ctx.today, horizonDays)) && !out.includes(stamp)) out.push(stamp);
  };
  const nextDailySlot = (): { fireAt: string[]; overdue: boolean } => {
    const out: string[] = [];
    pushAt(out, prefs.time >= localNow.time ? localNow.date : formatISO(addDays(ctx.today, 1)), prefs.time);
    return { fireAt: out, overdue: false };
  };

  const schedule = (kind: 'renewal' | 'collection' | 'recurring' | 'loan' | 'card', due: string): { fireAt: string[]; overdue: boolean } => {
    const cfg = k[kind];
    const overdue = due < today;
    const out: string[] = [];
    if (overdue) {
      // Vencido: un solo aviso por día hasta que se resuelva, si el usuario lo pidió.
      if (prefs.repeatOverdue) pushAt(out, prefs.time >= localNow.time ? localNow.date : formatISO(addDays(ctx.today, 1)), prefs.time);
    } else for (const lead of cfg.leadDays) pushAt(out, formatISO(parseISO(due) - lead), prefs.time);
    return { fireAt: out.sort(), overdue };
  };
  const mk = (kind: keyof typeof k, id: string, due: string | null, count: number, detail: string, route: string, sched: { fireAt: string[]; overdue: boolean } | null): Reminder => ({
    id, kind, dueDate: due, overdue: sched?.overdue ?? false, title: GENERIC[kind]!, detail: prefs.discreet ? null : detail, route, count, fireAt: sched?.fireAt ?? [],
  });

  const items: Reminder[] = [];
  if (k.renewal.enabled) for (const r of await renewals(ctx, horizonDays)) items.push(mk('renewal', `renewal:${r.subscription_id}:${r.renews_on}`, r.renews_on, 1, `Renueva ${r.name} (${m(r.price)})`, `/service/${r.subscription_id}`, schedule('renewal', r.renews_on)));
  if (k.collection.enabled) for (const c of await collectionsDue(ctx, horizonDays)) items.push(mk('collection', `collection:${c.due_date}`, c.due_date, Number(c.n), `${c.n} cobro(s) por ${m(c.total)}`, '/contacts', schedule('collection', c.due_date)));
  if (k.recurring.enabled) for (const o of await recurringDue(ctx, horizonDays)) items.push(mk('recurring', `recurring:${o.occurrence_id}`, o.due_date, 1, `${o.name} (${m(o.amount)})`, '/recurring', schedule('recurring', o.due_date)));
  if (k.loan.enabled) for (const b of await bankInstallments(ctx, horizonDays)) items.push(mk('loan', `loan:${b.loan_id}:${b.no}`, b.due_date, 1, `${b.loan_name}: cuota ${b.no} (${m(b.remaining)})`, `/bank-loan/${b.loan_id}`, schedule('loan', b.due_date)));
  if (k.card.enabled) {
    for (const c of await cardPaymentsDue(ctx, horizonDays)) {
      items.push(mk(
        'card',
        c.type === 'card_statement' ? `card:stmt:${c.id}` : `card:due:${c.id}:${c.dueDate}`,
        c.dueDate,
        1,
        `${c.name} (${c.amount})`,
        c.type === 'card_statement' ? `/card-statement/${c.id}` : `/account/${c.id}/card`,
        schedule('card', c.dueDate),
      ));
    }
  }
  if (k.budget.enabled) for (const b of await listBudgets(ctx)) if (b.current.level !== null) items.push(mk('budget', `budget:${b.id}:${b.current.period.start}:${b.current.level}`, null, 1, `${b.name} al ${b.current.percent ?? 0} %`, `/budgets/${b.id}`, nextDailySlot()));
  if (k.capture.enabled) { const c = await capturePending(ctx); if (c.pendingProposals > 0) items.push(mk('capture', 'capture:pending', null, c.pendingProposals, `${c.pendingProposals} propuesta(s) por revisar`, '/capture', nextDailySlot())); }

  items.sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.id.localeCompare(b.id));
  return { enabled: true, discreet: prefs.discreet, time: prefs.time, items };
}
