import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { formatISO, parseISO, todayIn } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import type { FileStore } from '../infra/capture/ports.js';
import { inTx, one, rows, type DB } from '../infra/db/db.js';
import { csvPackage } from '../infra/export/csv.js';
import { exportPdf } from '../infra/export/pdf.js';
import type { Cell, Col, ExportTable } from '../infra/export/types.js';
import { toXlsx } from '../infra/export/xlsx.js';
import { listBudgets } from './budgets.js';
import { ts, type Ctx } from './context.js';
import { listGoals } from './goals.js';
import { listLoans } from './loans.js';
import { listBankLoans } from './bankLoans.js';
import { catLabel, computeRange, fetchEntryRows, FLOW_LABEL, flowTypeOf } from './reports.js';
import { requireOwned } from './operations.js';
import { cycleCost } from './supplier.js';

export const SECTION_IDS = ['transactions', 'flow', 'income_by_category', 'expense_by_category', 'accounts', 'services', 'contacts', 'loans', 'budgets', 'goals'] as const;
export type SectionId = (typeof SECTION_IDS)[number];
export const SECTION_TITLE: Record<SectionId, string> = {
  transactions: 'Movimientos', flow: 'Flujo de dinero', income_by_category: 'Ingresos por categoría', expense_by_category: 'Gastos por categoría', accounts: 'Cuentas',
  services: 'Costo de servicios', contacts: 'Contactos: pendiente y saldo a favor', loans: 'Préstamos', budgets: 'Presupuestos', goals: 'Metas',
};

export interface ExportRequest { from: string; to: string; accountIds?: string[]; sections: SectionId[]; level: 'summary' | 'detail'; format: 'csv' | 'xlsx' | 'pdf' }
export interface ExportDeps { files: FileStore; syncMaxRows: number; ttlHours: number }

const MAX_DAYS = 1830; // 5 años
const HARD_MAX_ROWS = 50_000;
const m = (v: string | bigint) => (typeof v === 'bigint' ? formatMoney(v) : formatMoney(parseMoney(v, { allowNegative: true })));
const sum = (rs: Array<Record<string, Cell>>, k: string) => m(rs.reduce((a, r) => a + parseMoney(String(r[k] ?? '0'), { allowNegative: true }), 0n));
const col = (key: string, label: string, type: Col['type'] = 'text'): Col => ({ key, label, type });

// ───────────────────────── Armado de las secciones ─────────────────────────

function validate(ctx: Ctx, r: ExportRequest) {
  const from = parseISO(r.from); const to = parseISO(r.to);
  if (to < from) throw unprocessable('VALIDATION_ERROR', 'El periodo termina antes de empezar');
  if (to > ctx.today) throw unprocessable('FUTURE_DATE_NOT_ALLOWED', 'El periodo no puede terminar en el futuro');
  if (to - from + 1 > MAX_DAYS) throw unprocessable('PERIOD_TOO_LONG', `El periodo no puede superar ${MAX_DAYS} días`);
  const sections = [...new Set(r.sections)];
  if (sections.length === 0) throw unprocessable('VALIDATION_ERROR', 'Elige al menos una sección');
  return sections;
}

export async function buildTables(ctx: Ctx, r: ExportRequest): Promise<ExportTable[]> {
  const sections = validate(ctx, r);
  const ids = [...new Set(r.accountIds ?? [])].sort();
  for (const id of ids) await requireOwned(ctx, 'account', id);
  const needRange = sections.some((s) => ['flow', 'income_by_category', 'expense_by_category', 'accounts'].includes(s));
  const range = needRange ? await computeRange(ctx, { from: r.from, to: r.to, label: `${r.from}/${r.to}`, accountIds: ids }) : null;
  const out: ExportTable[] = [];

  for (const s of sections) {
    switch (s) {
      case 'transactions': {
        const data = await fetchEntryRows(ctx, r.from, r.to, ids);
        if (data.length > HARD_MAX_ROWS) throw unprocessable('EXPORT_TOO_LARGE', `Hay más de ${HARD_MAX_ROWS} movimientos en ese periodo: acota las fechas o las cuentas`, { rows: data.length });
        const rs = data.map((x) => ({
          date: x.occurred_on, time: x.occurred_time ? x.occurred_time.slice(0, 5) : null, account: x.account_name, type: FLOW_LABEL[flowTypeOf(x)], description: x.description || null,
          category: x.category_id ? catLabel(x) : null, amount: m(x.amount), status: x.status === 'reversed' ? 'Revertido' : x.kind === 'reversal' ? 'Reversión' : 'Vigente',
        }));
        out.push({
          id: s, title: SECTION_TITLE[s], note: 'Un renglón por asiento de cuenta; una transferencia aparece dos veces (sale y entra).',
          columns: [col('date', 'Fecha', 'date'), col('time', 'Hora'), col('account', 'Cuenta'), col('type', 'Tipo'), col('description', 'Descripción'), col('category', 'Categoría'), col('amount', 'Importe', 'money'), col('status', 'Estado')],
          rows: rs, totals: { amount: sum(rs, 'amount') },
        });
        break;
      }
      case 'flow': {
        const f = range!.flow;
        out.push({
          id: s, title: SECTION_TITLE[s], note: `Todo lo que entró y salió de las cuentas. Saldo inicial ${f.opening}, saldo final ${f.closing}${f.reconciles ? '' : ' (no cuadra: revisa los movimientos)'}.`,
          columns: [col('label', 'Concepto'), col('in', 'Entró', 'money'), col('out', 'Salió', 'money'), col('net', 'Neto', 'money'), col('movements', 'Movimientos', 'int')],
          rows: f.lines.map((l) => ({ label: l.label, in: l.in, out: l.out, net: l.net, movements: l.movements })), totals: { in: f.totalIn, out: f.totalOut, net: f.net },
        });
        break;
      }
      case 'income_by_category':
      case 'expense_by_category': {
        const part = s === 'income_by_category' ? range!.results.income : range!.results.consumption;
        out.push({
          id: s, title: SECTION_TITLE[s], note: 'Sin transferencias, capital de préstamos, pagos de tarjeta, servicios compartidos ni lo revertido.',
          columns: [col('name', 'Categoría'), col('total', 'Total', 'money'), col('count', 'Movimientos', 'int'), col('percent', '% del total', 'percent')],
          rows: part.byCategory.map((c) => ({ name: c.name, total: c.total, count: c.count, percent: c.percent })), totals: { total: part.total },
        });
        break;
      }
      case 'accounts': {
        const rs = range!.accounts.map((a) => ({ name: a.name, type: a.type, opening: a.opening, closing: a.closing, change: a.change }));
        out.push({
          id: s, title: SECTION_TITLE[s], note: 'Saldo al inicio y al final del periodo. Una tarjeta de crédito muestra su deuda como saldo negativo.',
          columns: [col('name', 'Cuenta'), col('type', 'Tipo'), col('opening', 'Saldo inicial', 'money'), col('closing', 'Saldo final', 'money'), col('change', 'Variación', 'money')],
          rows: rs, totals: { opening: sum(rs, 'opening'), closing: sum(rs, 'closing'), change: sum(rs, 'change') },
        });
        break;
      }
      case 'services': out.push(await servicesTable(ctx, r)); break;
      case 'contacts': out.push(await contactsTable(ctx)); break;
      case 'loans': out.push(await loansTable(ctx)); break;
      case 'budgets': {
        const bs = await listBudgets(ctx, r.to);
        const rs = bs.map((b) => ({ name: b.name, category: b.category?.name ?? 'General', period: b.period === 'weekly' ? 'Semanal' : b.period === 'yearly' ? 'Anual' : 'Mensual', limit: b.current.limit, available: b.current.available, spent: b.current.spent, remaining: b.current.remaining, percent: b.current.percent }));
        out.push({
          id: s, title: SECTION_TITLE[s], note: `Estado del periodo vigente al ${r.to}. Un presupuesto es un límite: no bloquea gastos.`,
          columns: [col('name', 'Presupuesto'), col('category', 'Categoría'), col('period', 'Periodo'), col('limit', 'Límite', 'money'), col('available', 'Disponible', 'money'), col('spent', 'Gastado', 'money'), col('remaining', 'Restante', 'money'), col('percent', '%', 'percent')],
          rows: rs,
        });
        break;
      }
      case 'goals': {
        const gs = await listGoals(ctx);
        const rs = gs.map((g) => ({ name: g.name, target: g.targetAmount, saved: g.saved, remaining: g.remaining, percent: g.percent, date: g.targetDate, status: g.achieved ? 'Cumplida' : 'En curso' }));
        out.push({
          id: s, title: SECTION_TITLE[s], note: 'El avance se mide con lo reservado en tus cuentas; reservar no mueve dinero.',
          columns: [col('name', 'Meta'), col('target', 'Objetivo', 'money'), col('saved', 'Reservado', 'money'), col('remaining', 'Falta', 'money'), col('percent', '%', 'percent'), col('date', 'Fecha objetivo', 'date'), col('status', 'Estado')],
          rows: rs, totals: { target: sum(rs, 'target'), saved: sum(rs, 'saved'), remaining: sum(rs, 'remaining') },
        });
        break;
      }
    }
  }
  return out;
}

async function servicesTable(ctx: Ctx, r: ExportRequest): Promise<ExportTable> {
  const cycles = await rows<{ id: string; name: string; start_date: string; end_date: string }>(ctx.trx, sql`
    select c.id, s.name, c.start_date::text as start_date, c.end_date::text as end_date from billing_cycle c join subscription s on s.owner_id = c.owner_id and s.id = c.subscription_id
    where c.owner_id = ${ctx.ownerId} and c.start_date between ${r.from}::date and ${r.to}::date order by s.name, c.start_date limit 600`);
  const cols = [col('announced', 'Precio anunciado', 'money'), col('paid', 'Pagado al proveedor', 'money'), col('expected', 'Cuotas exigibles', 'money'), col('received', 'Cobrado', 'money'), col('pending', 'Pendiente', 'money'), col('projected', 'Costo previsto', 'money'), col('byCollections', 'Costo según cobros', 'money'), col('surplus', 'Excedente', 'money')];
  const per: Array<Record<string, Cell>> = [];
  for (const c of cycles) {
    const k = await cycleCost(ctx, c.id);
    per.push({ service: c.name, from: c.start_date, to: c.end_date, announced: k.announcedPrice, paid: k.actualPaid ?? '0.00', expected: k.expectedFromOthers, received: k.receivedFromOthers, pending: k.pendingFromOthers, projected: k.projectedCost, byCollections: k.costByCollections, surplus: k.surplus });
  }
  const keys = cols.map((c) => c.key);
  let rs = per;
  let columns = [col('service', 'Servicio'), col('from', 'Ciclo desde', 'date'), col('to', 'Hasta', 'date'), ...cols];
  if (r.level === 'summary') {
    const by = new Map<string, Record<string, Cell>>();
    for (const x of per) {
      const cur: Record<string, Cell> = by.get(String(x.service)) ?? { service: x.service ?? null, ...Object.fromEntries(keys.map((k) => [k, '0.00'])), cycles: 0 };
      for (const k of keys) cur[k] = m(parseMoney(String(cur[k]), { allowNegative: true }) + parseMoney(String(x[k]), { allowNegative: true }));
      cur.cycles = Number(cur.cycles) + 1;
      by.set(String(x.service), cur);
    }
    rs = [...by.values()];
    columns = [col('service', 'Servicio'), col('cycles', 'Ciclos', 'int'), ...cols];
  }
  return {
    id: 'services', title: SECTION_TITLE.services, note: 'Cifras de cada ciclo con las reglas de costo de la app: costo previsto, según cobros y excedente.',
    columns, rows: rs, totals: Object.fromEntries(keys.map((k) => [k, sum(rs, k)])),
  };
}

async function contactsTable(ctx: Ctx): Promise<ExportTable> {
  const today = formatISO(ctx.today);
  const cs = await rows<{ name: string; pending: string; overdue: string; credit: string }>(ctx.trx, sql`
    select c.name,
      coalesce((select sum(b.pending_amount) from v_obligation_balance b where b.owner_id = c.owner_id and b.contact_id = c.id and b.pending_amount > 0), 0) as pending,
      coalesce((select sum(b.pending_amount) from v_obligation_balance b join v_charge_due d on d.obligation_id = b.obligation_id
                where b.owner_id = c.owner_id and b.contact_id = c.id and b.pending_amount > 0 and d.effective_due_date < ${today}::date), 0) as overdue,
      coalesce((select sum(a.free) from v_receipt_availability a where a.owner_id = c.owner_id and a.contact_id = c.id), 0) as credit
    from contact c where c.owner_id = ${ctx.ownerId} and c.status = 'active' order by lower(c.name), c.id`);
  const rs = cs.map((c) => ({ name: c.name, pending: m(c.pending), overdue: m(c.overdue), credit: m(c.credit) }));
  return {
    id: 'contacts', title: SECTION_TITLE.contacts, note: `A la fecha de hoy (${today}), no al periodo elegido. El pendiente no incluye lo convertido a préstamo.`,
    columns: [col('name', 'Contacto'), col('pending', 'Pendiente', 'money'), col('overdue', 'Vencido', 'money'), col('credit', 'Saldo a favor', 'money')],
    rows: rs, totals: { pending: sum(rs, 'pending'), overdue: sum(rs, 'overdue'), credit: sum(rs, 'credit') },
  };
}

async function loansTable(ctx: Ctx): Promise<ExportTable> {
  const ls = (await listLoans(ctx)) as unknown as Array<{ contactName?: string | null; counterpartyName?: string | null; direction?: string; principal: string; pending: string; status: string; openedOn: string }>;
  const bank = await listBankLoans(ctx);
  const status = (s: string) => (s === 'open' ? 'Abierto' : s === 'closed' ? 'Cerrado' : s === 'cancelled' ? 'Anulado' : s);
  const rs: Array<Record<string, Cell>> = [
    ...ls.map((l) => ({ type: l.direction === 'borrowed' ? 'Recibido' : 'Otorgado', who: l.contactName ?? l.counterpartyName ?? '', opened: l.openedOn, principal: m(l.principal), pending: m(l.pending), status: status(l.status), next: null })),
    ...bank.map((b) => ({ type: 'Bancario', who: b.entity ? `${b.name} · ${b.entity}` : b.name, opened: null, principal: null, pending: b.remainingScheduled, status: b.status === 'closed' ? 'Cerrado' : 'Abierto', next: b.nextDue?.dueDate ?? null })),
  ];
  return {
    id: 'loans', title: SECTION_TITLE.loans, note: 'Lo pendiente de un préstamo bancario es lo que falta del calendario confirmado, no una estimación.',
    columns: [col('type', 'Tipo'), col('who', 'Con quién'), col('opened', 'Desde', 'date'), col('principal', 'Capital', 'money'), col('pending', 'Pendiente', 'money'), col('status', 'Estado'), col('next', 'Próxima cuota', 'date')],
    rows: rs,
  };
}

// ───────────────────────── Cantidad, formato y entrega ─────────────────────────

/** Cuántas filas tendría, sin armarlo todo: decide si se genera ya o en segundo plano (08 §6). */
export async function estimateRows(ctx: Ctx, r: ExportRequest): Promise<number> {
  const sections = validate(ctx, r);
  let n = sections.length * 50;
  if (sections.includes('transactions')) {
    const ids = [...new Set(r.accountIds ?? [])];
    const c = await one<{ n: string }>(ctx.trx, sql<{ n: string }>`
      select count(*) as n from account_entry e join financial_operation o on o.owner_id = e.owner_id and o.id = e.operation_id
      where e.owner_id = ${ctx.ownerId} and o.occurred_on between ${r.from}::date and ${r.to}::date ${ids.length ? sql`and e.account_id in (${sql.join(ids.map((i) => sql`${i}::uuid`))})` : sql``}`);
    n += Number(c?.n ?? 0);
  }
  return n;
}

const MIME = { csv: 'text/csv; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' } as const;

export async function renderExport(ctx: Ctx, r: ExportRequest, tables: ExportTable[]) {
  const meta = {
    title: 'Exportación EVA', generatedAt: new Date(ctx.nowMs).toISOString(),
    subtitle: `Periodo ${r.from} a ${r.to} · ${r.accountIds?.length ? `${r.accountIds.length} cuenta(s)` : 'todas las cuentas'} · ${r.level === 'detail' ? 'con detalle' : 'resumen'}`,
  };
  const base = `eva-${r.from}_${r.to}`;
  if (r.format === 'csv') { const p = csvPackage(tables); return { bytes: p.bytes, mime: p.mime, filename: tables.length === 1 ? `eva-${tables[0]!.id}-${r.from}_${r.to}.csv` : `${base}.zip` }; }
  if (r.format === 'xlsx') return { bytes: toXlsx(tables), mime: MIME.xlsx, filename: `${base}.xlsx` };
  return { bytes: await exportPdf(tables, meta), mime: MIME.pdf, filename: `${base}.pdf` };
}

/** Vista previa: cuántas filas por sección, las primeras de cada una y si se generará en segundo plano. */
export async function previewExport(ctx: Ctx, deps: ExportDeps, r: ExportRequest) {
  const tables = await buildTables(ctx, r);
  const estimated = await estimateRows(ctx, r);
  const total = tables.reduce((s, t) => s + t.rows.length, 0);
  return {
    sections: tables.map((t) => ({ id: t.id, title: t.title, note: t.note ?? null, columns: t.columns, rows: t.rows.length, sample: t.rows.slice(0, 10), totals: t.totals ?? null })),
    totalRows: total, async: estimated > deps.syncMaxRows, format: r.format,
    warnings: ['No se incluyen comprobantes originales, correos completos ni respuestas de IA.', 'Exportar no reemplaza el respaldo recuperable.'],
  };
}

interface JobRow { id: string; params: ExportRequest; format: string; status: string; rows: number; filename: string | null; mime: string | null; size_bytes: number | null; error_code: string | null; created_at: unknown; finished_at: unknown; expires_at: unknown; file_key: string | null }
const jSel = sql`select id, params, format, status, rows, filename, mime, size_bytes, error_code, created_at, finished_at, expires_at, file_key from export_job`;
const jView = (j: JobRow) => ({
  id: j.id, status: j.status, format: j.format, params: j.params, rows: j.rows, filename: j.filename, mime: j.mime, sizeBytes: j.size_bytes, errorCode: j.error_code,
  createdAt: ts(j.created_at), finishedAt: j.finished_at ? ts(j.finished_at) : null, expiresAt: j.expires_at ? ts(j.expires_at) : null, ready: j.status === 'done',
});

async function finish(ctx: Ctx, deps: ExportDeps, jobId: string, r: ExportRequest) {
  const tables = await buildTables(ctx, r);
  const out = await renderExport(ctx, r, tables);
  const key = `${ctx.ownerId}/exports/${jobId}`;
  await deps.files.put(key, out.bytes);
  const rowsCount = tables.reduce((s, t) => s + t.rows.length, 0);
  await sql`update export_job set status = 'done', rows = ${rowsCount}, filename = ${out.filename}, mime = ${out.mime}, file_key = ${key}, size_bytes = ${out.bytes.length},
            finished_at = ${new Date(ctx.nowMs).toISOString()}, expires_at = ${new Date(ctx.nowMs + deps.ttlHours * 3_600_000).toISOString()} where owner_id = ${ctx.ownerId} and id = ${jobId}`.execute(ctx.trx);
}

/** Crea la exportación. Pequeña: queda lista en la misma petición. Grande: queda en cola y se genera en segundo plano. */
export async function createExport(ctx: Ctx, deps: ExportDeps, r: ExportRequest) {
  const estimated = await estimateRows(ctx, r);
  await buildTablesCheck(ctx, r);
  const id = randomUUID();
  const background = estimated > deps.syncMaxRows;
  await sql`insert into export_job (id, owner_id, params, format, status, created_at) values (${id}, ${ctx.ownerId}, ${JSON.stringify(r)}::jsonb, ${r.format}, ${background ? 'queued' : 'running'}, ${new Date(ctx.nowMs).toISOString()})`.execute(ctx.trx);
  if (!background) await finish(ctx, deps, id, r);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'export.create', entityType: 'export_job', entityId: id, changes: { format: r.format, sections: r.sections.length, background } });
  return { background, job: await getExport(ctx, id) };
}

/** Valida cuentas y fechas antes de aceptar el trabajo (sin armar las tablas). */
async function buildTablesCheck(ctx: Ctx, r: ExportRequest) {
  validate(ctx, r);
  for (const id of new Set(r.accountIds ?? [])) await requireOwned(ctx, 'account', id);
}

/** Genera una exportación en cola; lo llama el servidor después de confirmar el registro. Nunca lanza: deja el estado en el registro. */
export async function runExportJob(env: { db: DB; now: () => Date; timeZone: string; previewSecret: string; deps: ExportDeps }, ownerId: string, jobId: string) {
  try {
    await inTx(env.db, async (trx) => {
      const ctx: Ctx = { trx, ownerId, actorId: ownerId, today: todayIn(env.timeZone, env.now()), nowMs: env.now().getTime(), previewSecret: env.previewSecret };
      const j = await one<{ params: ExportRequest; status: string }>(trx, sql<{ params: ExportRequest; status: string }>`select params, status from export_job where owner_id = ${ownerId} and id = ${jobId} for update`);
      if (!j || j.status !== 'queued') return;
      await sql`update export_job set status = 'running' where owner_id = ${ownerId} and id = ${jobId}`.execute(trx);
      await finish(ctx, env.deps, jobId, j.params);
    });
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : 'EXPORT_FAILED';
    await sql`update export_job set status = 'failed', error_code = ${code}, finished_at = ${env.now().toISOString()} where owner_id = ${ownerId} and id = ${jobId} and status in ('queued','running')`.execute(env.db);
  }
}

export async function getExport(ctx: Ctx, id: string) {
  const j = await one<JobRow>(ctx.trx, sql<JobRow>`${jSel} where owner_id = ${ctx.ownerId} and id = ${id}`);
  if (!j) throw notFound('Export');
  return jView(j);
}
export async function listExports(ctx: Ctx) {
  return (await rows<JobRow>(ctx.trx, sql<JobRow>`${jSel} where owner_id = ${ctx.ownerId} order by created_at desc, id desc limit 50`)).map(jView);
}

export async function downloadExport(ctx: Ctx, deps: ExportDeps, id: string) {
  const j = await one<JobRow>(ctx.trx, sql<JobRow>`${jSel} where owner_id = ${ctx.ownerId} and id = ${id}`);
  if (!j) throw notFound('Export');
  if (j.status === 'expired' || (j.expires_at && new Date(j.expires_at as string).getTime() < ctx.nowMs)) throw unprocessable('EXPORT_EXPIRED', 'La exportación venció: genera otra');
  if (j.status !== 'done' || !j.file_key) throw unprocessable('EXPORT_NOT_READY', j.status === 'failed' ? 'La exportación falló' : 'La exportación todavía se está generando');
  return { bytes: await deps.files.get(j.file_key), mime: j.mime!, filename: j.filename! };
}

/** Borra los archivos vencidos (24 h por defecto): el registro queda como `expired`. Lo llama el trabajo diario. */
export async function purgeExpiredExports(env: { db: DB; now: () => Date; files: FileStore }) {
  const due = await rows<{ id: string; file_key: string | null }>(env.db, sql`select id, file_key from export_job where status in ('done','failed') and expires_at is not null and expires_at < ${env.now().toISOString()}::timestamptz limit 500`);
  for (const j of due) {
    if (j.file_key) await env.files.delete(j.file_key);
    await sql`update export_job set status = 'expired', file_key = null where id = ${j.id}`.execute(env.db);
  }
  return due.length;
}
