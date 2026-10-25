import PDFDocument from 'pdfkit';
import type { MonthlyData } from '../../application/reports.js';

const MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const monthTitle = (month: string) => `${MES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
const fmt = (v: string) => { const neg = v.startsWith('-'); const [i, d] = (neg ? v.slice(1) : v).split('.'); return `${neg ? '-' : ''}S/ ${i!.replace(/\B(?=(\d{3})+$)/g, ',')}.${d ?? '00'}`; };

export interface PdfMeta { live: boolean; version?: number; generatedAt: string; rulesVersion: string }

/** PDF del resumen mensual: mismas cifras que la vista (viva o guardada), con la versión y la fecha de generación bien visibles (RN-RM04). */
export function monthlyPdf(d: MonthlyData, meta: PdfMeta): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 44, info: { Title: `Resumen de ${monthTitle(d.period.month)}`, Producer: 'EVA' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - 88;
    const h1 = (t: string) => { doc.moveDown(0.8).font('Helvetica-Bold').fontSize(13).fillColor('#111').text(t); doc.moveDown(0.2); };
    const small = (t: string) => doc.font('Helvetica').fontSize(8.5).fillColor('#666').text(t, { width: W });
    const row = (label: string, value: string, o: { bold?: boolean; indent?: number } = {}) => {
      const y = doc.y;
      doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor('#111').text(label, 44 + (o.indent ?? 0), y, { width: W * 0.62 - (o.indent ?? 0) });
      const after = doc.y;
      doc.text(value, 44 + W * 0.62, y, { width: W * 0.38, align: 'right' });
      doc.y = Math.max(after, doc.y);
    };

    doc.font('Helvetica-Bold').fontSize(20).fillColor('#111').text(`Resumen de ${monthTitle(d.period.month)}`);
    doc.font('Helvetica').fontSize(10).fillColor('#444').text(meta.live ? 'Vista viva (se recalcula con los datos actuales)' : `Versión guardada n.º ${meta.version}`);
    small(`Generado el ${meta.generatedAt.slice(0, 10)} · reglas ${meta.rulesVersion} · periodo ${d.period.from} a ${d.period.to}${d.filters.accounts.length ? ` · cuentas: ${d.filters.accounts.join(', ')}` : ' · todas las cuentas'}`);

    h1('Cuentas');
    for (const a of d.accounts) row(`${a.name}`, `${fmt(a.opening)}  ->  ${fmt(a.closing)}`);

    h1(d.flow.label);
    small(d.flow.note);
    doc.moveDown(0.3);
    row('Saldo inicial', fmt(d.flow.opening), { bold: true });
    for (const l of d.flow.lines) row(l.label, `+ ${fmt(l.in)}   - ${fmt(l.out)}`, { indent: 10 });
    row('Total entró / salió', `+ ${fmt(d.flow.totalIn)}   - ${fmt(d.flow.totalOut)}`, { bold: true });
    row('Saldo final', fmt(d.flow.closing), { bold: true });
    if (!d.flow.reconciles) small('Atención: el flujo no cuadra con los saldos; revisa los movimientos.');

    h1(d.results.label);
    small(d.results.note);
    doc.moveDown(0.3);
    row('Ingresos ganados', fmt(d.results.income.total), { bold: true });
    for (const c of d.results.income.byCategory) row(`${c.name} (${c.percent}%)`, fmt(c.total), { indent: 12 });
    row('Gastos de consumo', fmt(d.results.consumption.total), { bold: true });
    for (const c of d.results.consumption.byCategory) row(`${c.name} (${c.percent}%)`, fmt(c.total), { indent: 12 });
    row('Costos financieros', fmt(d.results.financialCosts.total), { bold: true });
    const fc = d.results.financialCosts;
    for (const [k, v] of [['Interés de préstamos', fc.loanInterest], ['Mora de préstamos', fc.loanLateFees], ['Interés bancario', fc.bankInterest], ['Seguros bancarios', fc.bankInsurance], ['Comisiones bancarias', fc.bankFees]] as const) if (v !== '0.00') row(k, fmt(v), { indent: 12 });
    if (d.results.financialIncome !== '0.00') row('Ingresos financieros', fmt(d.results.financialIncome), { bold: true });
    const sv = d.results.sharedServices;
    row('Servicios compartidos: costo neto', fmt(sv.netCost), { bold: true });
    row('Pagado a proveedores', fmt(sv.paidToSuppliers), { indent: 12 });
    row('Cobrado a participantes', fmt(sv.collected), { indent: 12 });
    if (sv.refunds !== '0.00') row('Devoluciones', fmt(sv.refunds), { indent: 12 });
    row('Resultado del mes', fmt(d.results.net), { bold: true });

    h1(d.other.label);
    row('Transferencias propias (entran / salen)', `${fmt(d.other.transfers.in)} / ${fmt(d.other.transfers.out)}`);
    row('Pagos de tarjeta de crédito', fmt(d.other.cardPayments));
    row('Capital de préstamos (entra / sale)', `${fmt(d.other.loans.capitalIn)} / ${fmt(d.other.loans.capitalOut)}`);
    row('Ajustes de saldo', fmt(d.other.adjustments));

    if (d.notes.length) { h1('Notas'); for (const n of d.notes) small(`- ${n}`); }

    if (d.operations?.length) {
      h1('Detalle de movimientos');
      for (const o of d.operations) {
        if (doc.y > doc.page.height - 70) doc.addPage();
        row(`${o.date}${o.time ? ` ${o.time}` : ''}  ${o.account} - ${o.description || o.kind}${o.status === 'reversed' ? ' (revertido)' : ''}`, fmt(o.amount));
      }
      if (d.operationsTruncated) small('Se muestran los primeros 2000 movimientos.');
    }

    doc.moveDown(1);
    small('Documento generado por EVA a partir de tus registros. No es un estado de cuenta bancario ni asesoría financiera.');
    doc.end();
  });
}
