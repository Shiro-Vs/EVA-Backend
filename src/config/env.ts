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
  })
  .superRefine((v, ctx) => {
    if (v.AUTH_MODE === 'dev' && (v.AUTH_DEV_SECRET?.length ?? 0) < 32) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_DEV_SECRET'], message: 'AUTH_MODE=dev exige AUTH_DEV_SECRET de al menos 32 caracteres' });
    }
    if (v.AUTH_MODE === 'jwks' && (!v.AUTH_JWKS_URL || !v.AUTH_ISSUER)) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_JWKS_URL'], message: 'AUTH_MODE=jwks exige AUTH_JWKS_URL y AUTH_ISSUER' });
    }
  });

export type Env = z.infer<typeof schema>;

/** Valida el entorno al arrancar. Si falta algo, el proceso no inicia (09 §3). */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración inválida:\n${detail}`);
  }
  return parsed.data;
}
