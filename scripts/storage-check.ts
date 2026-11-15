// Comprueba que Supabase Storage responde con la clave de servicio: sube un archivo de prueba, lo lee y lo borra.
// Uso: npx tsx --env-file=.env.supabase scripts/storage-check.ts   (necesita SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY y STORAGE_BUCKET)
import { createSupabaseStore } from '../src/infra/capture/files.js';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STORAGE_BUCKET } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !STORAGE_BUCKET) {
  console.error('Faltan SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY o STORAGE_BUCKET en el archivo de entorno.');
  process.exit(1);
}
const store = createSupabaseStore({ url: SUPABASE_URL, serviceKey: SUPABASE_SERVICE_ROLE_KEY, bucket: STORAGE_BUCKET });
const key = `_check/${Date.now()}.txt`;
const body = Buffer.from('EVA storage check');
try {
  await store.put(key, body);
  const back = await store.get(key);
  await store.delete(key);
  console.log(back.equals(body) ? 'OK: Supabase Storage guarda, lee y borra archivos.' : 'ERROR: el archivo leído no coincide.');
  process.exit(back.equals(body) ? 0 : 1);
} catch (e) {
  console.error('ERROR:', (e as Error).message);
  process.exit(1);
}
