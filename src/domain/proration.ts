// Incorporación entre renovaciones (04 §5; RN-I01…I08) y cuota sugerida (04 §3).
import { type LocalDate } from './localDate.js';
import { ceilDiv, ceilToSol, type Cents } from './money.js';

export type JoinMode = 'full_cycle' | 'trial_free' | 'partial_charged';

export interface JoinResult {
  mode: JoinMode;
  remainingDays: number; // r
  baseDays: number; // B
  freeDaysThreshold: number; // g
  quota: Cents;
  prorated: Cents; // prorrateo antes del tope (0 en ciclo completo)
  gross: Cents;
  exemption: Cents;
  net: Cents;
  dueDate: LocalDate;
  warnings: Array<'TRAMO_EXCEDE_CICLO'>;
  rule: string;
}

export class JoinError extends Error {
  constructor(public readonly code: 'JOIN_OUT_OF_CYCLE' | 'INVALID_INPUT', message: string) {
    super(message);
  }
}

export const PRORATION_RULE_VERSION = 'RN-I01@v1';

export function proratedJoin(i: {
  quota: Cents;
  cycleStart: LocalDate;
  cycleEnd: LocalDate;
  joinDate: LocalDate;
  freeDaysThreshold: number;
  baseDays: number;
}): JoinResult {
  if (i.quota < 0n || i.baseDays < 1 || i.freeDaysThreshold < 0) throw new JoinError('INVALID_INPUT', 'Datos de prorrateo inválidos');
  if (i.joinDate < i.cycleStart || i.joinDate >= i.cycleEnd) {
    throw new JoinError('JOIN_OUT_OF_CYCLE', 'La fecha de ingreso debe estar dentro del ciclo vigente');
  }
  const r = i.cycleEnd - i.joinDate;
  const base = {
    remainingDays: r,
    baseDays: i.baseDays,
    freeDaysThreshold: i.freeDaysThreshold,
    quota: i.quota,
    dueDate: i.joinDate,
    rule: PRORATION_RULE_VERSION,
  };

  // RN-I03: ingresar el día de renovación inicia un ciclo completo
  if (i.joinDate === i.cycleStart) {
    return { ...base, mode: 'full_cycle', prorated: 0n, gross: i.quota, exemption: 0n, net: i.quota, warnings: [] };
  }

  // ceil_sol( Q × r / B ) en un solo paso: ceil( Q×r / (B×100) ) × 100  (04 §1)
  const prorated = ceilDiv(i.quota * BigInt(r), BigInt(i.baseDays) * 100n) * 100n;
  const warnings: JoinResult['warnings'] = prorated > i.quota ? ['TRAMO_EXCEDE_CICLO'] : [];
  const gross = prorated < i.quota ? prorated : i.quota; // RN-I04: nunca más que la cuota
  const free = r <= i.freeDaysThreshold; // Regla A: igualdad cuenta como gratis
  const exemption = free ? gross : 0n;
  return { ...base, mode: free ? 'trial_free' : 'partial_charged', prorated, gross, exemption, net: gross - exemption, warnings };
}

/** Cuota sugerida (RN-P03, D-07): ceil(precio / plazas ocupadas) a sol entero. */
export function suggestedQuota(announcedPrice: Cents, occupiedSeats: number): Cents {
  if (!Number.isInteger(occupiedSeats) || occupiedSeats < 1) throw new RangeError('Debe haber al menos una plaza ocupada');
  return ceilToSol(ceilDiv(announcedPrice, BigInt(occupiedSeats)));
}
