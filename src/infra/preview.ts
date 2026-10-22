import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { canonical } from './idempotency.js';
import { conflict, unprocessable } from '../http/errors.js';

// Vista previa → confirmación (13 §1.2). El token firma las entradas normalizadas y una huella del estado relevante:
// si algo cambió entre la vista previa y la confirmación, se responde PREVIEW_STALE y nunca se aplica en silencio.
export const ENGINE_VERSION = 'engine@1';
const TTL_MS = 10 * 60 * 1000;

const sha = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

export interface PreviewPayload {
  scope: string; // 'subscription.create', 'seat.join', 'receipt.create' …
  ownerId: string;
  inputs: unknown; // entradas normalizadas (sin previewToken ni idempotency)
  state: unknown; // huella del estado relevante (versiones, pendientes…)
}

export function makePreviewToken(secret: string, p: PreviewPayload, now = Date.now()): string {
  const body = b64(JSON.stringify({ s: p.scope, o: p.ownerId, i: sha(p.inputs), f: sha(p.state), v: ENGINE_VERSION, e: now + TTL_MS }));
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Valida la firma, el alcance, las entradas, el motor y la huella de estado. Lanza AppError si no coincide. */
export function checkPreviewToken(secret: string, token: string | undefined, p: PreviewPayload, now = Date.now()): void {
  if (!token) throw unprocessable('PREVIEW_REQUIRED', 'A previewToken from the matching preview call is required');
  const [body, sig] = token.split('.');
  if (!body || !sig) throw unprocessable('PREVIEW_INVALID', 'Malformed previewToken');
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unprocessable('PREVIEW_INVALID', 'Invalid previewToken');

  let data: { s: string; o: string; i: string; f: string; v: string; e: number };
  try {
    data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw unprocessable('PREVIEW_INVALID', 'Malformed previewToken');
  }
  if (data.s !== p.scope || data.o !== p.ownerId) throw unprocessable('PREVIEW_INVALID', 'previewToken does not belong to this operation');
  if (data.i !== sha(p.inputs)) throw unprocessable('PREVIEW_MISMATCH', 'The request differs from the one that was previewed');
  if (data.e < now || data.v !== ENGINE_VERSION || data.f !== sha(p.state)) {
    throw conflict('PREVIEW_STALE', 'The data changed since the preview; review the new calculation');
  }
}
