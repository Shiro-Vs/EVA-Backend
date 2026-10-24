import { sql } from 'kysely';
import { formatISO, parseISO, toYMD } from '../domain/localDate.js';
import { formatMoney, parseMoney } from '../domain/money.js';
import { notFound } from '../http/errors.js';
import { one, rows } from '../infra/db/db.js';
import { listCharges } from './charges.js';
import type { Ctx } from './context.js';
import { getContact } from './contacts.js';
import { listLoans } from './loans.js';

const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const human = (isoDate: string) => { const { m, d } = toYMD(parseISO(isoDate)); return `${d} ${MES[m - 1]}`; };
const soles = (c: bigint) => `S/ ${formatMoney(c)}`;

/**
 * Estado de cuenta por servicio → plaza → ciclo (RN-P01, RN-P06, 08 §3).
 * `shareText` es un texto discreto para pegar en WhatsApp: generarlo no envía nada (09 §7).
 */
export async function contactStatement(ctx: Ctx, contactId: string) {
  const contact = await getContact(ctx, contactId); // sincroniza cargos y valida propiedad
  const charges = await listCharges(ctx, sql`mc.contact_id = ${contactId}`);

  const seatQuota = new Map<string, string>();
  const quotas = await rows<{ seat_id: string; quota: string }>(ctx.trx, sql<{ seat_id: string; quota: string }>`
    select s.id as seat_id, (select st.quota from seat_terms st where st.seat_id = s.id and st.owner_id = s.owner_id order by st.valid_from desc limit 1) as quota
    from seat s join membership m on m.id = s.membership_id and m.owner_id = s.owner_id where s.owner_id = ${ctx.ownerId} and m.contact_id = ${contactId}`);
  for (const q of quotas) seatQuota.set(q.seat_id, formatMoney(parseMoney(q.quota)));

  type ChargeView = (typeof charges)[number];
  type SubGroup = { subscriptionId: string; name: string; seats: Map<string, { seatId: string; label: string; quota: string; pending: bigint }>; charges: ChargeView[] };
  const bySub = new Map<string, SubGroup>();
  for (const c of charges) {
    const s: SubGroup = bySub.get(c.subscriptionId) ?? { subscriptionId: c.subscriptionId, name: c.subscriptionName, seats: new Map(), charges: [] };
    const seat = s.seats.get(c.seatId) ?? { seatId: c.seatId, label: c.seatLabel, quota: seatQuota.get(c.seatId) ?? '0.00', pending: 0n };
    seat.pending += parseMoney(c.pending);
    s.seats.set(c.seatId, seat);
    s.charges.push(c);
    bySub.set(c.subscriptionId, s);
  }
  const services = [...bySub.values()].map((s) => ({
    subscriptionId: s.subscriptionId, name: s.name,
    seats: [...s.seats.values()].map((x) => ({ seatId: x.seatId, label: x.label, quota: x.quota, pending: formatMoney(x.pending) })),
    charges: s.charges,
  }));

  const lines: string[] = [];
  for (const s of services) {
    for (const c of s.charges.filter((x) => parseMoney(x.pending) > 0n)) {
      lines.push(`• ${s.name} · ${c.seatLabel}: ${soles(parseMoney(c.pending))} (${c.overdue ? 'venció' : 'vence'} el ${human(c.dueDate)})`);
    }
  }
  const loans = await listLoans(ctx, contactId);
  for (const l of loans.filter((x) => x.engine !== 'ledger' && parseMoney(x.pending) > 0n)) lines.push(`• Préstamo (deuda convertida): ${soles(parseMoney(l.pending))}`);
  const total = parseMoney(contact.totals.pending);
  const shareText = total === 0n
    ? `Hola ${contact.name}, estás al día. ¡Gracias!`
    : [`Hola ${contact.name}, este es tu estado de cuenta:`, ...lines, `Total pendiente: ${soles(total)}`].join('\n');

  return { contact: { id: contact.id, name: contact.name }, totals: contact.totals, services, loans, shareText, asOf: formatISO(ctx.today) };
}

export async function assertContact(ctx: Ctx, id: string) {
  const c = await one(ctx.trx, sql`select 1 as ok from contact where owner_id = ${ctx.ownerId} and id = ${id}`);
  if (!c) throw notFound('Contact');
}
