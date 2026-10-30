export type ColType = 'text' | 'money' | 'date' | 'int' | 'percent';
export interface Col { key: string; label: string; type: ColType }
export type Cell = string | number | null;

/** Una sección exportable. Los importes van como texto decimal («1234.50») y se escriben como número en Excel. */
export interface ExportTable {
  id: string;
  title: string;
  note?: string;
  columns: Col[];
  rows: Array<Record<string, Cell>>;
  totals?: Record<string, Cell>;
}

export interface ExportMeta { title: string; subtitle: string; generatedAt: string }

const NUMERIC = /^-?\d+(\.\d+)?$/;
export const isNumeric = (v: Cell): v is string | number => v !== null && (typeof v === 'number' || NUMERIC.test(v));

/**
 * Una hoja de cálculo interpreta como fórmula lo que empieza con = + - @ (o tabulación/retorno): contenido de un tercero
 * (una descripción o un nombre) podría ejecutar una fórmula al abrir el archivo. En texto se antepone un apóstrofo.
 */
export function safeText(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}
