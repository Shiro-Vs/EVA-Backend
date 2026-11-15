/** Envío de correos transaccionales (hoy: las sugerencias que llegan al desarrollador). */
export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Si se responde el correo, la respuesta va a esta dirección (p. ej. la de quien envió la sugerencia). */
  replyTo?: string;
}

export interface Mailer {
  send(m: MailMessage): Promise<void>;
}

export class MailError extends Error {
  constructor(message: string, public readonly status = 0) { super(message); this.name = 'MailError'; }
}

/** Resend (https://resend.com): el dominio remitente ya está verificado. La clave solo vive en el servidor. */
export function createResendMailer(o: { apiKey: string; from: string; fetchFn?: typeof fetch }): Mailer {
  const f = o.fetchFn ?? fetch;
  return {
    async send(m) {
      let res: Response;
      try {
        res = await f('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: o.from, to: [m.to], subject: m.subject, html: m.html, text: m.text, ...(m.replyTo ? { reply_to: m.replyTo } : {}) }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new MailError('No se pudo conectar con el servicio de correo');
      }
      if (!res.ok) throw new MailError(`El servicio de correo rechazó el envío (HTTP ${res.status})`, res.status);
    },
  };
}
