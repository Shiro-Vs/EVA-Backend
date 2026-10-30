import { zipSync, strToU8 } from 'fflate';
import { isNumeric, safeText, type Cell, type ExportTable } from './types.js';

const BOM = '﻿'; // Excel abre así los acentos correctamente

function cell(v: Cell, numeric: boolean): string {
  if (v === null || v === '') return '';
  const s = String(v);
  const out = numeric && isNumeric(v) ? s : safeText(s);
  return /[",\r\n]/.test(out) ? `"${out.replace(/"/g, '""')}"` : out;
}

/** Una tabla plana (RFC 4180, saltos CRLF, UTF-8 con BOM). Los totales van como última fila. */
export function toCsv(t: ExportTable): string {
  const num = (c: { type: string }) => c.type !== 'text' && c.type !== 'date';
  const lines = [t.columns.map((c) => cell(c.label, false)).join(',')];
  for (const r of t.rows) lines.push(t.columns.map((c) => cell(r[c.key] ?? null, num(c))).join(','));
  if (t.totals) lines.push(t.columns.map((c, i) => cell(i === 0 ? 'Total' : t.totals![c.key] ?? null, num(c))).join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Una descarga por tabla; con varias, un ZIP con un CSV por sección en el orden elegido. */
export function csvPackage(tables: ExportTable[]): { bytes: Buffer; mime: string; ext: 'csv' | 'zip' } {
  if (tables.length === 1) return { bytes: Buffer.from(toCsv(tables[0]!), 'utf8'), mime: 'text/csv; charset=utf-8', ext: 'csv' };
  const files: Record<string, Uint8Array> = {};
  tables.forEach((t, i) => { files[`${String(i + 1).padStart(2, '0')}-${slug(t.title) || t.id}.csv`] = strToU8(toCsv(t)); });
  return { bytes: Buffer.from(zipSync(files, { level: 6 })), mime: 'application/zip', ext: 'zip' };
}
