// Clúster PostgreSQL local del proyecto. Independiente del servicio instalado en el sistema.
// Solo escucha en 127.0.0.1, sin contraseña: es únicamente para desarrollo y pruebas locales.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const PORT = process.env.PG_LOCAL_PORT ?? '54329';
const DATA = resolve(import.meta.dirname, '..', '.pgdata');
const BIN =
  process.env.PG_BIN ??
  ['C:/Program Files/PostgreSQL/18/bin', '/usr/lib/postgresql/18/bin', '/usr/bin'].find((d) =>
    existsSync(join(d, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl')),
  );

if (!BIN) {
  console.error('No se encontró PostgreSQL. Define PG_BIN con la carpeta bin de la instalación.');
  process.exit(1);
}
const exe = (n) => join(BIN, process.platform === 'win32' ? `${n}.exe` : n);
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(exe(cmd), args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
// pg_ctl start deja el servidor heredando la salida: sin stdio 'ignore' el comando nunca termina.
const startServer = () => {
  if (spawnSync(exe('pg_ctl'), ['-D', DATA, 'status'], { stdio: 'ignore' }).status === 0) {
    console.log('PostgreSQL local ya estaba en marcha, puerto', PORT);
    return;
  }
  const r = spawnSync(
    exe('pg_ctl'),
    ['-D', DATA, '-o', `-p ${PORT} -c listen_addresses=127.0.0.1`, '-l', join(DATA, 'server.log'), '-w', 'start'],
    { stdio: 'ignore' },
  );
  if (r.status !== 0) {
    console.error('No se pudo iniciar PostgreSQL; revisa .pgdata/server.log');
    process.exit(r.status ?? 1);
  }
  console.log('PostgreSQL local en marcha, puerto', PORT);
};
const psql = (db, sql) =>
  spawnSync(exe('psql'), ['-h', '127.0.0.1', '-p', PORT, '-U', 'postgres', '-d', db, '-tAc', sql], {
    encoding: 'utf8',
  });

const cmd = process.argv[2];

if (cmd === 'init') {
  if (!existsSync(join(DATA, 'PG_VERSION'))) {
    run('initdb', ['-D', DATA, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C']);
  } else {
    console.log('Clúster ya inicializado en', DATA);
  }
  startServer();
  for (const db of ['eva_dev', 'eva_test']) {
    const exists = psql('postgres', `select 1 from pg_database where datname='${db}'`).stdout.trim();
    if (!exists) run('createdb', ['-h', '127.0.0.1', '-p', PORT, '-U', 'postgres', db]);
  }
  console.log(`Listo: postgres://postgres@127.0.0.1:${PORT}/eva_dev  y  eva_test`);
} else if (cmd === 'start') {
  startServer();
} else if (cmd === 'stop') {
  run('pg_ctl', ['-D', DATA, '-m', 'fast', '-w', 'stop']);
} else if (cmd === 'status') {
  spawnSync(exe('pg_ctl'), ['-D', DATA, 'status'], { stdio: 'inherit' });
} else {
  console.error('Uso: node scripts/pg.mjs <init|start|stop|status>');
  process.exit(2);
}
