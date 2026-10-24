// Reglas de clasificación (05 §3, RN-CL04…CL07, D-14). Lógica pura: sin base de datos ni reloj.

export interface Rule {
  id: string;
  priority: number;
  /** Instante de creación (para desempatar): la más antigua gana. */
  createdAt: number;
  accountId: string | null;
  direction: 'income' | 'expense' | null;
  amountMin: bigint | null; // céntimos
  amountMax: bigint | null; // céntimos
  textContains: string | null;
  action: 'assign' | 'suggest';
  categoryId: string;
}

export interface Candidate {
  accountId: string;
  direction: 'income' | 'expense';
  amount: bigint; // céntimos, positivo
  text: string;
}

/** Minúsculas y sin tildes: «Café» coincide con «cafe». */
export const normalizeText = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Una regla sin ninguna condición coincidiría con todo: no es válida. */
export const hasCondition = (r: Pick<Rule, 'accountId' | 'direction' | 'amountMin' | 'amountMax' | 'textContains'>): boolean =>
  r.accountId !== null || r.direction !== null || r.amountMin !== null || r.amountMax !== null || r.textContains !== null;

/** Todas las condiciones presentes deben cumplirse. */
export function matches(r: Rule, c: Candidate): boolean {
  if (r.accountId !== null && r.accountId !== c.accountId) return false;
  if (r.direction !== null && r.direction !== c.direction) return false;
  if (r.amountMin !== null && c.amount < r.amountMin) return false;
  if (r.amountMax !== null && c.amount > r.amountMax) return false;
  if (r.textContains !== null && !normalizeText(c.text).includes(normalizeText(r.textContains))) return false;
  return true;
}

/** Orden de precedencia: menor número de prioridad; si empatan, la más antigua; si aún, por id (determinista). */
export const byPrecedence = (a: Rule, b: Rule): number => a.priority - b.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id);

/** Reglas que aplican a la operación, en orden de precedencia; `applied` es la que gana. */
export function pickRule(rules: Rule[], c: Candidate): { applied: Rule | null; matched: Rule[] } {
  const matched = rules.filter((r) => hasCondition(r) && matches(r, c)).sort(byPrecedence);
  return { applied: matched[0] ?? null, matched };
}
