import type { FastifyInstance } from 'fastify';
import { buildSuggestionMail } from '../../application/suggestions.js';
import { MailError } from '../../infra/mail.js';
import { AppError } from '../errors.js';
import { parse, type HttpDeps } from '../context.js';
import { suggestionCreate } from '../schemas.js';

const MAX_PER_HOUR = 5;
const HOUR_MS = 3_600_000;

/** Sugerencias y reportes: llegan por correo al desarrollador con el nombre y el correo de la cuenta. No se guardan en la base. */
export function suggestionRoutes(app: FastifyInstance, deps: HttpDeps) {
  // Límite por persona, en memoria: basta para frenar abusos de un solo servidor y no toca la base.
  const recent = new Map<string, number[]>();

  app.post('/suggestions', async (req) => {
    const user = req.user!;
    const { mailer, suggestionsTo } = deps.mail;
    if (!mailer || !suggestionsTo) throw new AppError(503, 'SUGGESTIONS_UNAVAILABLE', 'Las sugerencias por la app no están disponibles por ahora. Escríbeme directo por correo o WhatsApp.');
    const body = parse(suggestionCreate, req.body);

    const now = deps.now().getTime();
    const mine = (recent.get(user.userId) ?? []).filter((t) => now - t < HOUR_MS);
    if (mine.length >= MAX_PER_HOUR) throw new AppError(429, 'RATE_LIMITED', 'Enviaste varias sugerencias seguidas. Inténtalo de nuevo en un rato.');

    const mail = buildSuggestionMail(suggestionsTo, { id: user.userId, name: user.name, email: user.email }, body, deps.now(), deps.timeZone);
    try {
      await mailer.send(mail);
    } catch (e) {
      if (e instanceof MailError) throw new AppError(502, 'MAIL_FAILED', 'No se pudo enviar tu sugerencia. Inténtalo otra vez o escríbeme directo.');
      throw e;
    }
    recent.set(user.userId, [...mine, now]);
    return { sent: true };
  });
}
