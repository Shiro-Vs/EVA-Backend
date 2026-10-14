import pg from 'pg';
import { loadEnv } from './config/env.js';
import { buildApp } from './http/app.js';

const env = loadEnv();
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const app = buildApp({ pool, logLevel: env.LOG_LEVEL });

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: env.PORT, host: '0.0.0.0' });
