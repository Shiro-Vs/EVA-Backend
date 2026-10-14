import pg from 'pg';
import { migrate } from './migrate.js';

// Reinicia SOLO la base de desarrollo: borra todo y reaplica las migraciones.
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Falta DATABASE_URL.');
  process.exit(1);
}
if (!/eva_dev/.test(url)) {
  console.error('Por seguridad solo se reinicia una base llamada eva_dev.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query('drop schema public cascade; create schema public;');
await client.end();

const r = await migrate(url);
console.log(`Base de desarrollo reiniciada. Migraciones aplicadas: ${r.applied.length}`);
