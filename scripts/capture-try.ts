// Prueba manual de captura contra el backend en marcha, con un usuario temporal. Uso: tsx --env-file=.env scripts/capture-try.ts imagen1 imagen2 …
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { signDevToken } from '../src/infra/auth/auth.js';

const base = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const secret = process.env.AUTH_DEV_SECRET!;
const id = randomUUID();
const token = await signDevToken(secret, { userId: id, name: 'Prueba de captura', email: 'captura@test.local' });
const MIME: Record<string, string> = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf' };

for (const file of process.argv.slice(2)) {
  const mime = MIME[extname(file).toLowerCase()];
  if (!mime) { console.log(file, '→ formato no admitido'); continue; }
  const res = await fetch(`${base}/v1/capture/documents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ origin: mime === 'application/pdf' ? 'pdf' : 'photo', mime, filename: file.split(/[\\/]/).pop(), contentBase64: readFileSync(file).toString('base64') }),
  });
  const j = (await res.json()) as any;
  console.log(`\n${file.split(/[\\/]/).pop()} → HTTP ${res.status} · estado ${j.status ?? j.error?.code} · intentos ${j.attempts}`);
  if (j.error) console.log('  error:', j.error);
  for (const p of j.proposals ?? []) console.log('  propuesta:', JSON.stringify({ direction: p.direction, amount: p.amount, occurredOn: p.occurredOn, occurredTime: p.occurredTime, counterparty: p.counterparty, channel: p.channel, operationRef: p.operationRef, concept: p.concept, missing: p.missing, confidence: p.confidence }));
}
const u = await (await fetch(`${base}/v1/capture/usage`, { headers: { authorization: `Bearer ${token}` } })).json();
console.log('\nuso:', JSON.stringify(u));
