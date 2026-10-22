// Emite un token de DESARROLLO para entrar a la API sin Supabase (AUTH_MODE=dev). Nunca para producción.
// Mantiene el mismo usuario entre ejecuciones (archivo .devuser.json, ignorado por git) para conservar tus datos de prueba.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { signDevToken } from '../src/infra/auth/auth.js';

const secret = process.env.AUTH_DEV_SECRET;
if (!secret || process.env.AUTH_MODE !== 'dev') {
  console.error('Define AUTH_MODE=dev y AUTH_DEV_SECRET en .env');
  process.exit(1);
}
const file = resolve(import.meta.dirname, '..', '.devuser.json');
const wantNew = process.argv.includes('--new');
const nameArg = process.argv.find((a) => a.startsWith('--name='))?.slice(7);

let user = { userId: randomUUID(), name: 'Yo', email: 'yo@dev.local' };
if (existsSync(file) && !wantNew) user = JSON.parse(readFileSync(file, 'utf8'));
if (nameArg) user.name = nameArg;
writeFileSync(file, JSON.stringify(user, null, 2));

const token = await signDevToken(secret, user, '30d');
console.log(`Usuario de desarrollo: ${user.name} (${user.userId})\n`);
console.log(token);
