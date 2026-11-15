import type { MailMessage } from '../infra/mail.js';

export const SUGGESTION_KINDS = { idea: 'Idea', problem: 'Algo no funciona', other: 'Otro' } as const;
export type SuggestionKind = keyof typeof SUGGESTION_KINDS;

export interface SuggestionInput { kind: SuggestionKind; message: string; appVersion?: string; platform?: string }
export interface Sender { id: string; name?: string; email?: string }

/** El texto del usuario es contenido no confiable: se escapa antes de entrar al HTML del correo. */
export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const KIND_STYLE: Record<SuggestionKind, { bg: string; fg: string }> = {
  idea: { bg: '#ede9fe', fg: '#5b21b6' },
  problem: { bg: '#fee2e2', fg: '#b91c1c' },
  other: { bg: '#e5e7eb', fg: '#374151' },
};

/** Fecha y hora legibles en la zona del servidor (Lima), para el correo. */
function when(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('es-PE', { timeZone, dateStyle: 'long', timeStyle: 'short' }).format(now);
}

/** Arma el correo que recibe el desarrollador: quién escribió (nombre y correo), qué tipo es, el mensaje y desde qué versión. */
export function buildSuggestionMail(to: string, s: Sender, i: SuggestionInput, now: Date, timeZone: string): MailMessage {
  const who = (s.name?.trim() || s.email || 'Alguien').replace(/\s+/g, ' ').slice(0, 80);
  const kind = SUGGESTION_KINDS[i.kind];
  const st = KIND_STYLE[i.kind];
  const date = when(now, timeZone);
  const meta = [i.appVersion ? `Versión ${i.appVersion}` : null, i.platform ?? null].filter(Boolean).join(' · ');
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;color:#7a7390;font-size:13px;width:92px;vertical-align:top;">${label}</td><td style="padding:6px 0;color:#1d1433;font-size:14px;">${value}</td></tr>`;
  const email = s.email ? `<a href="mailto:${escapeHtml(s.email)}" style="color:#5b21b6;text-decoration:none;">${escapeHtml(s.email)}</a>` : '<span style="color:#7a7390;">sin correo en la cuenta</span>';

  const html = `<div style="background:#f4f1fa;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" align="center" width="100%" style="max-width:560px;background:#ffffff;border-radius:20px;padding:28px;">
    <tr><td>
      <p style="margin:0 0 2px;font-size:13px;letter-spacing:2px;color:#6b4bb0;font-weight:bold;">EVA</p>
      <h1 style="margin:0 0 14px;font-size:21px;color:#1d1433;">Nueva sugerencia</h1>
      <p style="margin:0 0 18px;"><span style="display:inline-block;background:${st.bg};color:${st.fg};font-size:12px;font-weight:bold;padding:5px 12px;border-radius:999px;">${escapeHtml(kind)}</span></p>
      <div style="background:#f4f1fa;border-left:4px solid #5b21b6;border-radius:12px;padding:16px 18px;margin:0 0 22px;">
        <p style="margin:0;font-size:15px;line-height:1.6;color:#1d1433;white-space:pre-wrap;">${escapeHtml(i.message)}</p>
      </div>
      <table role="presentation" width="100%" style="border-top:1px solid #e4def0;padding-top:10px;">
        ${row('De', `<strong>${escapeHtml(who)}</strong>`)}
        ${row('Correo', email)}
        ${row('Cuenta', `<span style="font-family:monospace;font-size:12px;color:#7a7390;">${escapeHtml(s.id)}</span>`)}
        ${meta ? row('App', escapeHtml(meta)) : ''}
        ${row('Fecha', escapeHtml(date))}
      </table>
      <p style="margin:18px 0 0;font-size:12px;color:#7a7390;">Responde este correo para escribirle directamente${s.email ? ` a ${escapeHtml(s.email)}` : ''}.</p>
    </td></tr>
  </table>
</div>`;

  const text = [`Nueva sugerencia en EVA (${kind})`, '', i.message, '', `De: ${who}`, `Correo: ${s.email ?? 'sin correo en la cuenta'}`, `Cuenta: ${s.id}`, ...(meta ? [`App: ${meta}`] : []), `Fecha: ${date}`].join('\n');

  return { to, subject: `Sugerencia de ${who} · ${kind}`, html, text, replyTo: s.email };
}
