// Costo propio del servicio (04 §9; RN-F04…F08).
import { type Cents } from './money.js';

export interface CostInput {
  announcedPrice: Cents;
  actualPaid: Cents | null; // pago real del ciclo; null si aún no se pagó
  expectedFromOthers: Cents; // Σ (neto + ajustes activos) de cargos no cancelados, sin el administrador
  receivedFromOthers: Cents; // Σ aplicaciones activas a esos cargos
}

export interface CostSummary extends CostInput {
  pendingFromOthers: Cents;
  projectedCost: Cents; // pago − cuotas exigibles
  costByCollections: Cents; // pago − cobros aplicados
  surplus: Cents; // excedente cuando algún costo es negativo (positivo)
  estimated: boolean; // true si usa el precio anunciado por no haber pago real
}

export function costSummary(i: CostInput): CostSummary {
  const base = i.actualPaid ?? i.announcedPrice;
  const projectedCost = base - i.expectedFromOthers;
  const costByCollections = base - i.receivedFromOthers;
  const worst = projectedCost < costByCollections ? projectedCost : costByCollections;
  return {
    ...i,
    pendingFromOthers: i.expectedFromOthers - i.receivedFromOthers,
    projectedCost,
    costByCollections,
    surplus: worst < 0n ? -worst : 0n,
    estimated: i.actualPaid === null,
  };
}
