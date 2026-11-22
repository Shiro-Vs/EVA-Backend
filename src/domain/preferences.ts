import { z } from 'zod';

// Preferencias del usuario (05 §8 panel, 09 §7 avisos, RN-SE02 bloqueo, RN-CA08/DU03 captura). Se guardan por secciones completas.

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Se espera HH:MM (24 horas)');

export const CARD_IDS = ['accounts_balance', 'credit_debt', 'period_flow', 'budgets', 'goals', 'renewals', 'pending_collections', 'loans', 'capture_pending', 'upcoming_payments'] as const;
export type CardId = (typeof CARD_IDS)[number];
/** Tarjetas sugeridas al empezar: cuentas, cobros pendientes y próximos pagos/renovaciones (RN-PA04); más lo pendiente de revisar. */
export const DEFAULT_CARDS: CardId[] = ['accounts_balance', 'pending_collections', 'renewals', 'upcoming_payments', 'capture_pending'];

const dashboard = z.object({
  cards: z.array(z.object({ id: z.enum(CARD_IDS), enabled: z.boolean() }).strict()).max(CARD_IDS.length)
    .refine((c) => new Set(c.map((x) => x.id)).size === c.length, 'Hay tarjetas repetidas'),
}).strict();

const leadKind = z.object({ enabled: z.boolean(), leadDays: z.array(z.number().int().min(0).max(30)).max(5).refine((d) => new Set(d).size === d.length, 'Anticipaciones repetidas') }).strict();
const flagKind = z.object({ enabled: z.boolean() }).strict();
const DEFAULT_CARD_LEAD = { enabled: true, leadDays: [3, 1, 0] };
const notifications = z.object({
  enabled: z.boolean(),
  /** Texto discreto por defecto: sin importes ni nombres hasta que se habilite el detalle (09 §7). */
  discreet: z.boolean(),
  time: hhmm,
  quiet: z.object({ from: hhmm, to: hhmm }).strict().nullable(),
  repeatOverdue: z.boolean(),
  kinds: z.object({
    renewal: leadKind,
    collection: leadKind,
    recurring: leadKind,
    loan: leadKind,
    card: leadKind.optional().default(DEFAULT_CARD_LEAD),
    budget: flagKind,
    capture: flagKind,
  }).strict(),
}).strict();

const capture = z.object({ reviewMode: z.enum(['individual', 'batch']), duplicates: z.enum(['separate', 'grouped']) }).strict();
/** El PIN y la biometría viven en el teléfono; aquí solo la frecuencia de re-bloqueo, para usarla en todos tus dispositivos (RN-SE02, D-25). */
const security = z.object({ lockAfterSeconds: z.number().int().min(0).max(3600) }).strict();
/** Copias automáticas (RN-BK03/BK04, D-26). */
const backup = z.object({ frequency: z.enum(['off', 'weekly', 'monthly']), keep: z.union([z.literal(1), z.literal(2)]) }).strict();

export const SECTIONS = { dashboard, notifications, capture, security, backup } as const;
export type SectionName = keyof typeof SECTIONS;
export type Preferences = { [K in SectionName]: z.infer<(typeof SECTIONS)[K]> };

export const DEFAULTS: Preferences = {
  dashboard: { cards: CARD_IDS.map((id) => ({ id, enabled: DEFAULT_CARDS.includes(id) })) },
  notifications: {
    enabled: true, discreet: true, time: '09:00', quiet: { from: '22:00', to: '07:00' }, repeatOverdue: false,
    kinds: { renewal: { enabled: true, leadDays: [3, 1, 0] }, collection: { enabled: true, leadDays: [1, 0] }, recurring: { enabled: true, leadDays: [1, 0] }, loan: { enabled: true, leadDays: [3, 1, 0] }, card: { enabled: true, leadDays: [3, 1, 0] }, budget: { enabled: true }, capture: { enabled: true } },
  },
  capture: { reviewMode: 'individual', duplicates: 'separate' },
  security: { lockAfterSeconds: 60 },
  backup: { frequency: 'weekly', keep: 2 },
};

/** Todas las tarjetas siempre presentes y en el orden guardado; las que faltan quedan al final, desactivadas. */
export function completeCards(cards: Array<{ id: CardId; enabled: boolean }>) {
  const have = new Set(cards.map((c) => c.id));
  return [...cards, ...CARD_IDS.filter((id) => !have.has(id)).map((id) => ({ id, enabled: false }))];
}

/** Lo guardado más los valores por defecto: una sección inválida o ausente vuelve a su valor por defecto. */
export function resolvePreferences(stored: unknown): Preferences {
  const src = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(SECTIONS) as SectionName[]) {
    const parsed = SECTIONS[k].safeParse(src[k]);
    out[k] = parsed.success ? parsed.data : DEFAULTS[k];
  }
  const p = out as unknown as Preferences;
  return { ...p, dashboard: { cards: completeCards(p.dashboard.cards) } };
}

export const preferencesPatch = z.object({
  dashboard: dashboard.optional(), notifications: notifications.optional(), capture: capture.optional(), security: security.optional(), backup: backup.optional(),
}).strict().refine((v) => Object.keys(v).length > 0, 'No hay nada que guardar');
export type PreferencesPatch = z.infer<typeof preferencesPatch>;
