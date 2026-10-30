import { strToU8, zipSync } from 'fflate';
import { isNumeric, safeText, type Cell, type ExportTable } from './types.js';

// Libro de Excel mínimo (Open XML) sin librerías: una hoja por sección, importes como números, encabezado fijo.

const esc = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i: number) => { let n = i + 1; let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

// Estilos: 0 normal · 1 negrita · 2 importe · 3 importe en negrita · 4 entero · 5 entero en negrita · 6 título grande
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function sheetName(title: string, used: Set<string>): string {
  const base = title.replace(/[\[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Hoja';
  let n = base; let i = 2;
  while (used.has(n.toLowerCase())) { const suf = ` (${i++})`; n = base.slice(0, 31 - suf.length) + suf; }
  used.add(n.toLowerCase());
  return n;
}

function sheetXml(t: ExportTable): string {
  const rows: string[] = [];
  const text = (r: number, c: number, v: string, s = 0) => `<c r="${colName(c)}${r}" t="inlineStr"${s ? ` s="${s}"` : ''}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  const num = (r: number, c: number, v: string | number, s: number) => `<c r="${colName(c)}${r}" s="${s}"><v>${v}</v></c>`;
  const put = (r: number, c: number, v: Cell, type: string, bold: boolean) => {
    if (v === null || v === '') return '';
    if (type === 'money' || type === 'int' || type === 'percent') {
      if (isNumeric(v)) return num(r, c, v, type === 'int' ? (bold ? 5 : 4) : bold ? 3 : 2);
    }
    return text(r, c, safeText(String(v)), bold ? 1 : 0);
  };
  let r = 1;
  rows.push(`<row r="${r++}">${text(1, 0, t.title, 6)}</row>`);
  rows.push(`<row r="${r++}">${t.note ? text(2, 0, t.note) : ''}</row>`);
  rows.push(`<row r="${r}">${t.columns.map((c, i) => text(r, i, c.label, 1)).join('')}</row>`); r++;
  const headerRow = r - 1;
  for (const row of t.rows) { rows.push(`<row r="${r}">${t.columns.map((c, i) => put(r, i, row[c.key] ?? null, c.type, false)).join('')}</row>`); r++; }
  if (t.totals) { rows.push(`<row r="${r}">${t.columns.map((c, i) => (i === 0 ? text(r, 0, 'Total', 1) : put(r, i, t.totals![c.key] ?? null, c.type, true))).join('')}</row>`); r++; }
  const widths = t.columns.map((c, i) => {
    const longest = Math.max(c.label.length, ...t.rows.slice(0, 200).map((x) => String(x[c.key] ?? '').length), i === 0 ? 5 : 0);
    return Math.min(60, Math.max(c.type === 'text' ? 14 : 12, longest + 2));
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${rows.join('')}</sheetData>
</worksheet>`;
}

export function toXlsx(tables: ExportTable[]): Buffer {
  const used = new Set<string>();
  const names = tables.map((t) => sheetName(t.title, used));
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${tables.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${tables.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${tables.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8(STYLES),
  };
  tables.forEach((t, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(t)); });
  return Buffer.from(zipSync(files, { level: 6 }));
}
