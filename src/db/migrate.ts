import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = resolve(import.meta.dirname, '..', '..', 'migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

// Se normalizan los saltos de línea: Git puede convertir LF↔CRLF entre Windows y Linux (CI) y el hash no debe cambiar.
const checksum = (sql: string) => createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

/** Aplica en orden las migraciones pendientes. Una migración ya aplicada es inmutable. */
export async function migrate(connectionString: string, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();

  const client = new pg.Client({ connectionString });
  await client.connect();
  const result: MigrationResult = { applied: [], skipped: [] };

  try {
    await client.query(`
      create table if not exists schema_migration (
        name       text primary key,
        checksum   text        not null,
        applied_at timestamptz not null default now()
      )`);

    const done = new Map<string, string>(
      (await client.query<{ name: string; checksum: string }>('select name, checksum from schema_migration')).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );

    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const sum = checksum(sql);
      const previous = done.get(file);

      if (previous !== undefined) {
        if (previous !== sum) {
          throw new Error(`MIGRATION_MODIFIED: ${file} ya fue aplicada y su contenido cambió. Crea una migración nueva.`);
        }
        result.skipped.push(file);
        continue;
      }

      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migration (name, checksum) values ($1, $2)', [file, sum]);
        await client.query('commit');
        result.applied.push(file);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Falló ${file}: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Falta DATABASE_URL (copia .env.example a .env).');
    process.exit(1);
  }
  migrate(url)
    .then((r) => {
      console.log(`Aplicadas: ${r.applied.length ? r.applied.join(', ') : '(ninguna)'}`);
      console.log(`Ya existentes: ${r.skipped.length}`);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
