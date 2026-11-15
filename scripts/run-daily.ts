// Ejecuta una vez el trabajo diario de producción (POST /jobs/daily) para comprobar que responde. Muestra solo el estado y el resumen.
// Uso: npm run job:daily   (lee CRON_SECRET y, si quieres, API_BASE de .env.supabase)
const base = (process.env.API_BASE ?? 'https://api.eva-app.lat').replace(/\/+$/, '');
const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error('Falta CRON_SECRET en .env.supabase (cópialo de Render → eva-api → Environment).');
  process.exit(1);
}
try {
  const res = await fetch(`${base}/jobs/daily`, { method: 'POST', headers: { 'x-cron-secret': secret }, signal: AbortSignal.timeout(120_000) });
  console.log(`HTTP ${res.status}`, (await res.text()).slice(0, 500));
  process.exit(res.ok ? 0 : 1);
} catch (e) {
  console.error('ERROR:', (e as Error).message);
  process.exit(1);
}
