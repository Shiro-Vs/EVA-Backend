import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Correo entrante con Resend (Receiving). Resend avisa con un webhook `email.received` que trae SOLO metadatos;
 * el cuerpo y los adjuntos se piden después a su API. Los avisos van firmados con Svix.
 */

// ───────────────────────── Firma del aviso (Svix) ─────────────────────────

export interface SvixHeaders { id?: string; timestamp?: string; signature?: string }

/**
 * Comprueba la firma Svix de un aviso: HMAC-SHA256 de `id.timestamp.cuerpo` con el secreto (`whsec_` + base64).
 * La cabecera puede traer varias firmas separadas por espacio (`v1,<base64> v1,<base64>`); basta con que una coincida.
 * Se rechazan avisos con más de `toleranciaSeg` de antigüedad (o del futuro) para frenar repeticiones.
 */
export function verifySvix(o: { secret: string; headers: SvixHeaders; payload: string; nowMs: number; toleranciaSeg?: number }): boolean {
  const { id, timestamp, signature } = o.headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(o.nowMs / 1000 - ts) > (o.toleranciaSeg ?? 300)) return false;
  const key = Buffer.from(o.secret.replace(/^whsec_/, ''), 'base64');
  if (key.length === 0) return false;
  const esperada = createHmac('sha256', key).update(`${id}.${timestamp}.${o.payload}`).digest();
  return signature.split(' ').some((part) => {
    const [version, b64] = part.split(',');
    if (version !== 'v1' || !b64) return false;
    const dada = Buffer.from(b64, 'base64');
    return dada.length === esperada.length && timingSafeEqual(dada, esperada);
  });
}

// ───────────────────────── Evento y cliente de la API ─────────────────────────

export interface ReceivedEvent { type: string; data: { email_id?: string; message_id?: string; to?: string[] } }

export interface ReceivedEmail {
  id: string;
  from: string;
  to: string[];
  cc?: string[];
  receivedFor?: string[];
  subject?: string;
  text?: string;
  html?: string;
  messageId?: string;
  /** Cabecera From completa («Yape <notificaciones@yape.pe>»); `from` trae solo la dirección. */
  fromHeader?: string;
}
export interface ReceivedAttachment { id: string; filename?: string; contentType: string; size: number; downloadUrl: string }

/** Lo que el servidor necesita de Resend para leer un correo recibido. Se inyecta en las pruebas. */
export interface InboundInbox {
  getEmail(id: string): Promise<ReceivedEmail>;
  listAttachments(emailId: string): Promise<ReceivedAttachment[]>;
  download(url: string, maxBytes: number): Promise<Buffer>;
}

export class InboundError extends Error {
  constructor(message: string, public readonly status = 0) { super(message); this.name = 'InboundError'; }
}

export function createResendInbox(o: { apiKey: string; fetchFn?: typeof fetch }): InboundInbox {
  const f = o.fetchFn ?? fetch;
  const base = 'https://api.resend.com';
  const get = async (path: string) => {
    let res: Response;
    try {
      res = await f(`${base}${path}`, { headers: { authorization: `Bearer ${o.apiKey}` }, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new InboundError('No se pudo conectar con Resend');
    }
    if (!res.ok) throw new InboundError(`Resend respondió HTTP ${res.status}`, res.status);
    return res;
  };
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    async getEmail(id) {
      const j = (await (await get(`/emails/receiving/${encodeURIComponent(id)}?html_format=cid`)).json()) as Record<string, any>;
      return {
        id: String(j.id ?? id), from: String(j.from ?? ''), to: arr(j.to), cc: arr(j.cc), receivedFor: arr(j.received_for),
        subject: typeof j.subject === 'string' ? j.subject : undefined, text: typeof j.text === 'string' ? j.text : undefined,
        html: typeof j.html === 'string' ? j.html : undefined, messageId: typeof j.message_id === 'string' ? j.message_id : undefined,
        fromHeader: typeof j.headers?.from === 'string' ? j.headers.from : undefined,
      };
    },
    async listAttachments(emailId) {
      const j = (await (await get(`/emails/receiving/${encodeURIComponent(emailId)}/attachments?limit=20`)).json()) as { data?: Array<Record<string, any>> };
      return (j.data ?? []).map((a) => ({ id: String(a.id), filename: typeof a.filename === 'string' ? a.filename : undefined, contentType: String(a.content_type ?? ''), size: Number(a.size ?? 0), downloadUrl: String(a.download_url ?? '') }));
    },
    async download(url, maxBytes) {
      // La dirección de descarga ya viene firmada: no lleva la clave.
      let res: Response;
      try {
        res = await f(url, { signal: AbortSignal.timeout(30_000) });
      } catch {
        throw new InboundError('No se pudo descargar el adjunto');
      }
      if (!res.ok) throw new InboundError(`La descarga del adjunto respondió HTTP ${res.status}`, res.status);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > maxBytes) throw new InboundError('El adjunto supera el tamaño máximo');
      return bytes;
    },
  };
}

// ───────────────────────── Texto del correo ─────────────────────────

const ENTIDADES: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&aacute;': 'á', '&eacute;': 'é', '&iacute;': 'í', '&oacute;': 'ó', '&uacute;': 'ú', '&ntilde;': 'ñ' };

/** Texto legible de un HTML (muchos correos de bancos solo traen HTML). Quita estilos y scripts, mantiene saltos de línea. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|[a-z]+);/gi, (m) => ENTIDADES[m.toLowerCase()] ?? (/^&#\d+;$/.test(m) ? String.fromCharCode(Number(m.slice(2, -1))) : ' '))
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
