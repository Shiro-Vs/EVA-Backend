import pg from 'pg';
import { migrate } from '../src/db/migrate.js';

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Falta TEST_DATABASE_URL (copia .env.example a .env y ejecuta npm run db:init).');
  if (!/eva_test/.test(url)) throw new Error('TEST_DATABASE_URL debe apuntar a una base eva_test: se borra por completo.');

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('drop schema public cascade; create schema public;');
  await client.end();

  // Aplica TODAS las migraciones desde cero: es también la verificación de que el esquema se construye limpio.
  await migrate(url);
}
