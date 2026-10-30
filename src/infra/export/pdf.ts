import PDFDocument from 'pdfkit';
import type { Cell, Col, ExportMeta, ExportTable } from './types.js';

const money = (v: Cell) => { if (v === null || v === '') return ''; const s = String(v); const neg = s.startsWith('-'); const [i, d] = (neg ? s.slice(1) : s).split('.'); return `${neg ? '-' : ''}${i!.replace(/\B(?=(\d{3})+$)/g, ',')}.${(d ?? '00').padEnd(2, '0').slice(0, 2)}`; };
const show = (c: Col, v: Cell) => (v === null ? '' : c.type === 'money' ? money(v) : c.type === 'percent' ? `${v} %` : String(v));

/** PDF con las secciones en el orden elegido, tablas paginadas y un gráfico de barras para los gastos por categoría (08 §5). */
export function exportPdf(tables: ExportTable[], meta: ExportMeta): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: meta.title, Producer: 'EVA' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const W = doc.page.width - 80;
    const bottom = () => doc.page.height - 60;

    doc.font('Helvetica-Bold').fontSize(20).fillColor('#111').text(meta.title);
    doc.font('Helvetica').fontSize(9.5).fillColor('#555').text(meta.subtitle, { width: W });
    doc.fontSize(8.5).text(`Generado el ${meta.generatedAt.slice(0, 10)}`);

    for (const t of tables) {
      if (doc.y > bottom() - 80) doc.addPage();
      doc.moveDown(0.9).font('Helvetica-Bold').fontSize(13).fillColor('#111').text(t.title);
      if (t.note) doc.font('Helvetica').fontSize(8.5).fillColor('#666').text(t.note, { width: W });
      doc.moveDown(0.3);

      // Anchos: el texto largo recibe más espacio; los importes, lo justo.
      const weights = t.columns.map((c) => (c.type === 'text' ? (c.key === 'description' ? 3 : 2) : 1.2));
      const total = weights.reduce((a, b) => a + b, 0);
      const widths = weights.map((w) => (w / total) * W);
      const x0 = 40;
      const drawRow = (cells: string[], bold: boolean, fill?: string) => {
        const heights = cells.map((s, i) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).heightOfString(s, { width: widths[i]! - 6 }));
        const h = Math.max(...heights, 11) + 4;
        if (doc.y + h > bottom()) { doc.addPage(); }
        const y = doc.y;
        if (fill) doc.rect(x0, y - 1, W, h).fill(fill);
        let x = x0;
        cells.forEach((s, i) => {
          const right = t.columns[i]!.type === 'money' || t.columns[i]!.type === 'int' || t.columns[i]!.type === 'percent';
          doc.fillColor('#111').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).text(s, x + 3, y + 1, { width: widths[i]! - 6, align: right ? 'right' : 'left' });
          x += widths[i]!;
        });
        doc.y = y + h;
      };
      drawRow(t.columns.map((c) => c.label), true, '#EEF2F7');
      if (t.rows.length === 0) { doc.font('Helvetica').fontSize(9).fillColor('#666').text('Sin datos en este periodo.', x0 + 3); }
      for (const r of t.rows) drawRow(t.columns.map((c) => show(c, r[c.key] ?? null)), false);
      if (t.totals) drawRow(t.columns.map((c, i) => (i === 0 ? 'Total' : show(c, t.totals![c.key] ?? null))), true, '#F6F8FA');

      if (t.id === 'expense_by_category' && t.rows.length > 0) {
        const top = t.rows.slice(0, 8);
        const max = Math.max(...top.map((r) => Number(r.total ?? 0)), 1);
        if (doc.y + top.length * 16 + 24 > bottom()) doc.addPage();
        doc.moveDown(0.6).font('Helvetica-Bold').fontSize(9).fillColor('#111').text('Gráfico: gastos por categoría');
        for (const r of top) {
          const y = doc.y + 2;
          doc.font('Helvetica').fontSize(8).fillColor('#333').text(String(r.name ?? '').slice(0, 28), 40, y, { width: 130 });
          const w = Math.max(2, (Number(r.total ?? 0) / max) * (W - 220));
          doc.rect(175, y, w, 9).fill('#3B82F6');
          doc.fillColor('#333').text(money(r.total ?? null), 180 + w, y, { width: 80 });
          doc.y = y + 15;
        }
      }
    }
    doc.moveDown(1.2).font('Helvetica').fontSize(8).fillColor('#777').text('Exportación generada por EVA a partir de tus registros. No es un estado de cuenta bancario ni asesoría financiera.', { width: W });
    doc.end();
  });
}
