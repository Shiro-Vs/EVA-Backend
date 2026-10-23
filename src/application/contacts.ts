import { sql } from 'kysely';
import { formatMoney, parseMoney } from '../domain/money.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';
import { audit } from '../infra/audit.js';
import { one, rows } from '../infra/db/db.js';
import { formatISO } from '../domain/localDate.js';
import { ts, type Ctx } from './context.js';
import { syncAllSubscriptions } from './sync.js';

interface Row {
  id: string; name: string; phone: string | null; email: string | null; color: string | null; notes: string | null; status: string; version: number; created_at: unknown;
  pending: string; overdue: string; credit_free: string; credit_reserved: string; active_seats: string; services: string;
}

const money = (v: string) => formatMoney(parseMoney(v, { allowNegative: true }));

export const mapContact = (r: Row) => ({
  id: r.id, name: r.name, phone: r.phone, email: r.email, color: r.color, notes: r.notes, status: r.status, version: r.version, createdAt: ts(r.created_at),
  totals: { pending: money(r.pending), overdue: money(r.overdue), creditFree: money(r.credit_free), creditReserved: money(r.credit_reserved) },
  activeSeats: Number(r.active_seats),
  services: Number(r.services),
});

/** Contactos con deuda, crédito y ocupación calculados desde las vistas (RN-P06). */
const base = (today: number) => sql`
  select c.*,
    coalesce((select sum(b.pending_amount) from v_obligation_balance b where b.owner_id = c.owner_id and b.contact_id = c.id), 0.00) as pending,
    coalesce((select sum(b.pending_amount) from v_obligation_balance b
              join v_charge_due d on d.obligation_id = b.obligation_id
              where b.owner_id = c.owner_id and b.contact_id = c.id and d.effective_due_date < ${formatISO(today)}::date and b.pending_amount > 0), 0.00) as overdue,
    coalesce((select sum(a.free) from v_receipt_availability a where a.owner_id = c.owner_id and a.contact_id = c.id), 0.00) as credit_free,
    coalesce((select sum(a.reserved) from v_receipt_availability a where a.owner_id = c.owner_id and a.contact_id = c.id), 0.00) as credit_reserved,
    (select count(*) from seat s join membership m on m.id = s.membership_id and m.owner_id = s.owner_id
       where m.owner_id = c.owner_id and m.contact_id = c.id and s.end_date is null) as active_seats,
    (select count(distinct m.subscription_id) from membership m where m.owner_id = c.owner_id and m.contact_id = c.id and m.status <> 'ended') as services
  from contact c`;

export async function getContact(ctx: Ctx, id: string) {
  await syncAllSubscriptions(ctx);
  const r = await one<Row>(ctx.trx, sql<Row>`${base(ctx.today)} where c.owner_id = ${ctx.ownerId} and c.id = ${id}`);
  if (!r) throw notFound('Contact');
  return mapContact(r);
}

export async function listContacts(ctx: Ctx, status?: string) {
  await syncAllSubscriptions(ctx);
  const f = status ? sql`and c.status = ${status}` : sql``;
  return (await rows<Row>(ctx.trx, sql<Row>`${base(ctx.today)} where c.owner_id = ${ctx.ownerId} ${f} order by lower(c.name)`)).map(mapContact);
}

export interface ContactInput { name: string; phone?: string | null; email?: string | null; color?: string | null; notes?: string | null }

export async function createContact(ctx: Ctx, i: ContactInput) {
  const r = await one<{ id: string }>(ctx.trx, sql<{ id: string }>`
    insert into contact (owner_id, name, phone, email, color, notes)
    values (${ctx.ownerId}, ${i.name.trim()}, ${i.phone ?? null}, ${i.email ?? null}, ${i.color ?? null}, ${i.notes ?? null}) returning id`);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'contact.create', entityType: 'contact', entityId: r!.id });
  return getContact(ctx, r!.id);
}

export async function patchContact(ctx: Ctx, id: string, version: number, p: Partial<ContactInput>) {
  const cur = await one<{ name: string; phone: string | null; email: string | null; color: string | null; notes: string | null; version: number }>(ctx.trx,
    sql`select name, phone, email, color, notes, version from contact where owner_id = ${ctx.ownerId} and id = ${id} for update`);
  if (!cur) throw notFound('Contact');
  if (cur.version !== version) throw conflict('CONFLICT_VERSION', 'The contact was modified; reload and retry');
  const pick = <K extends keyof ContactInput>(k: K, fallback: ContactInput[K] | null) => (p[k] === undefined ? fallback : p[k]);
  await sql`
    update contact set name = ${(p.name ?? cur.name).trim()}, phone = ${pick('phone', cur.phone)}, email = ${pick('email', cur.email)},
      color = ${pick('color', cur.color)}, notes = ${pick('notes', cur.notes)}
    where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'contact.update', entityType: 'contact', entityId: id });
  return getContact(ctx, id);
}

/** D-32: con plazas activas no se archiva; con deuda pendiente se permite con advertencia. */
export async function archiveContact(ctx: Ctx, id: string) {
  const c = await getContact(ctx, id);
  if (c.activeSeats > 0) throw unprocessable('CONTACT_HAS_ACTIVE_SEATS', 'The contact still occupies seats; remove them first');
  await sql`update contact set status = 'archived' where owner_id = ${ctx.ownerId} and id = ${id}`.execute(ctx.trx);
  await audit(ctx.trx, { ownerId: ctx.ownerId, actorId: ctx.actorId, action: 'contact.archive', entityType: 'contact', entityId: id });
  const warnings = parseMoney(c.totals.pending) > 0n ? ['CONTACT_HAS_PENDING_DEBT'] : [];
  return { contact: await getContact(ctx, id), warnings };
}
