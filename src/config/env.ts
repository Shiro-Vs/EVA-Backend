import { z } from 'zod';

const schema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TZ_DEFAULT: z.string().default('America/Lima'),
    DATABASE_URL: z.string().min(1),
    AUTH_MODE: z.enum(['dev', 'jwks']),
    AUTH_DEV_SECRET: z.string().optional(),
    AUTH_JWKS_URL: z.string().optional(),
    AUTH_ISSUER: z.string().optional(),
    // Audiencia (aud) esperada en el token. Supabase usa «authenticated».
    AUTH_AUDIENCE: z.string().default('authenticated'),
    PREVIEW_SECRET: z.string().min(32).optional(),
    // Orígenes permitidos para clientes web (separados por coma). Vacío = sin CORS (la app móvil nativa no lo necesita).
    CORS_ORIGINS: z.string().optional(),
    // Solo AUTH_MODE=dev: habilita POST /dev/login, que entrega un token del usuario de desarrollo indicado (sin Supabase).
    DEV_LOGIN_USER_ID: z.uuid().optional(),
    // Captura asistida (Entrega 4). EXTRACTOR=none: la captura falla de forma recuperable; heuristic: solo texto simple (desarrollo); gemini: IA.
    EXTRACTOR: z.enum(['none', 'heuristic', 'gemini']).default('none'),
    GEMINI_API_KEY: z.string().optional(),
    GEMINI_MODEL: z.string().optional(),
    // Modelo del análisis y chat; si se omite se usa GEMINI_MODEL.
    GEMINI_ANALYSIS_MODEL: z.string().optional(),
    STORAGE_DIR: z.string().default('.storage'),
    INBOUND_SECRET: z.string().min(16).optional(),
    INBOX_DOMAIN: z.string().default('eva.local'),
    CAPTURE_DAILY_LIMIT: z.coerce.number().int().min(1).default(30),
    // Respaldos: clave opcional AES-256 (64 caracteres hex) y secreto del trabajo programado diario.
    BACKUP_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'Debe ser una clave de 32 bytes en hexadecimal (64 caracteres)').optional(),
    CRON_SECRET: z.string().min(16).optional(),
    // Exportaciones: filas máximas para generar en la misma petición (más = en segundo plano) y horas que dura el archivo.
    EXPORT_SYNC_MAX_ROWS: z.coerce.number().int().min(1).default(10000),
    EXPORT_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    CAPTURE_MAX_MB: z.coerce.number().min(1).max(25).default(12),
  })
  .superRefine((v, ctx) => {
    if (v.AUTH_MODE === 'dev' && (v.AUTH_DEV_SECRET?.length ?? 0) < 32) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_DEV_SECRET'], message: 'AUTH_MODE=dev exige AUTH_DEV_SECRET de al menos 32 caracteres' });
    }
    if (v.EXTRACTOR === 'gemini' && (!v.GEMINI_API_KEY || !v.GEMINI_MODEL)) {
      ctx.addIssue({ code: 'custom', path: ['GEMINI_API_KEY'], message: 'EXTRACTOR=gemini exige GEMINI_API_KEY y GEMINI_MODEL' });
    }
    if (v.AUTH_MODE === 'jwks' && v.DEV_LOGIN_USER_ID) {
      ctx.addIssue({ code: 'custom', path: ['DEV_LOGIN_USER_ID'], message: 'DEV_LOGIN_USER_ID solo es válido con AUTH_MODE=dev' });
    }
    if (v.AUTH_MODE === 'jwks' && !v.PREVIEW_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['PREVIEW_SECRET'], message: 'AUTH_MODE=jwks exige PREVIEW_SECRET (mínimo 32 caracteres)' });
    }
    if (v.AUTH_MODE === 'jwks' && (!v.AUTH_JWKS_URL || !v.AUTH_ISSUER)) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_JWKS_URL'], message: 'AUTH_MODE=jwks exige AUTH_JWKS_URL y AUTH_ISSUER' });
    }
  });

export type Env = z.infer<typeof schema>;

/** Valida el entorno al arrancar. Si falta algo, el proceso no inicia (09 §3). */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // Una variable vacía (p. ej. `PREVIEW_SECRET=` copiada de .env.example) equivale a no definida.
  const clean = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(clean);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración inválida:\n${detail}`);
  }
  return parsed.data;
}
