import { afterAll, describe, expect, it } from 'vitest';
import type { Extractor } from '../../src/infra/capture/ports.js';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount } from '../helpers/scenarios.js';

/** El extractor devuelve lo que diga el texto del documento: "SUMMARY", "SCHEDULE", "BAD", "SCHEDULE2" o "STATEMENT". */
const inst = (n: number, due: string, total = '100.00', p = '80.00', i = '15.00', s = '3.00', f = '2.00') => ({ number: n, dueDate: due, principal: p, interest: i, insurance: s, fees: f, total });
const DOCS: Record<string, unknown> = {
  SUMMARY: { documentType: 'loan_summary', isTransaction: false, movements: [], loan: { entity: 'Banco Sur', loanNumber: 'PR-001', principal: '300.00', tea: '18.50', termMonths: 3, installmentsCount: 3, disbursedOn: '2026-09-01', firstDueDate: '2026-10-01', monthlyPayment: '100.00' } },
  SCHEDULE: { documentType: 'loan_schedule', isTransaction: false, movements: [], loan: { installments: [inst(1, '2026-10-01'), inst(2, '2026-11-01'), inst(3, '2026-12-01')] } },
  BAD: { documentType: 'loan_schedule', isTransaction: false, movements: [], loan: { installments: [inst(1, '2026-10-01'), inst(3, '2026-12-01', '120.00')] } },
  SCHEDULE2: { documentType: 'loan_schedule', isTransaction: false, movements: [], loan: { installments: [inst(1, '2026-10-05', '999.00', '900.00', '90.00', '5.00', '4.00'), inst(2, '2026-11-15', '110.00', '90.00', '15.00', '3.00', '2.00')] } },
  STATEMENT: { documentType: 'bank_statement', isTransaction: false, movements: [], loan: { outstandingBalance: '210.00', asOf: '2026-10-10' } },
  YAPE: { documentType: 'payment_receipt', isTransaction: true, movements: [{ direction: 'expense', amount: '5.00', currency: 'PEN', occurredOn: '2026-10-10' }] },
};
const extractor: Extractor = {
  provider: 'test', model: 'loan-1',
  async extract(i) {
    const key = Object.keys(DOCS).sort((a, b) => b.length - a.length).find((k) => (i.text ?? '').includes(k))!;
    return { raw: DOCS[key], provider: 'test', model: 'loan-1', usage: { tokensIn: 1, tokensOut: 1, costEstimate: 0 } };
  },
};

const api = makeApi({ extractor });
afterAll(async () => { await api.app.close(); await pool.end(); });
api.setNow(new Date('2026-10-12T17:00:00Z')); // hoy: 2026-10-12

async function world() {
  const u = await api.newUser();
  const bcp = await createAccount(api, u.token, 'BCP', '1000.00', 'bank', '2026-08-01');
  const loan = (await api.post(u.token, '/bank-loans', { name: 'Préstamo personal', accountId: bcp.id })).body;
  const doc = async (text: string) => {
    const r = await api.post(u.token, '/capture/documents', { origin: 'text', text: `${text} ${Math.random()}` });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  };
  const change = async (body: Record<string, unknown>, ack = false) => {
    const pv = await api.post(u.token, `/bank-loans/${loan.id}/changes/preview`, body);
    if (pv.status !== 200) return { pv, r: pv };
    const r = await api.post(u.token, `/bank-loans/${loan.id}/changes`, { ...body, previewToken: pv.body.previewToken, ...(ack ? { acknowledgeWarnings: true } : {}) });
    return { pv, r };
  };
  const get = async () => (await api.get(u.token, `/bank-loans/${loan.id}`)).body;
  const pay = async (body: Record<string, unknown>) => {
    const pv = await api.post(u.token, `/bank-loans/${loan.id}/payments/preview`, { accountId: bcp.id, ...body });
    if (pv.status !== 200) return { pv, r: pv };
    return { pv, r: await api.post(u.token, `/bank-loans/${loan.id}/payments`, { accountId: bcp.id, ...body, previewToken: pv.body.previewToken }) };
  };
  const bal = async () => (await api.get(u.token, `/accounts/${bcp.id}`)).body.balance as string;
  return { u, bcp, loan, doc, change, get, pay, bal };
}

describe('Un préstamo nuevo no inventa nada (RN-B01, RN-B04)', () => {
  it('nace sin datos: lo desconocido queda pendiente, no como estimación', async () => {
    const w = await world();
    const l = await w.get();
    expect(l).toMatchObject({ name: 'Préstamo personal', status: 'active', facts: [], installments: [], nextDue: null, pending: ['principal', 'tea', 'term_months', 'first_due_date'] });
    expect(l.totals).toEqual({ scheduled: '0.00', paid: '0.00', remainingScheduled: '0.00', overdue: 0 });
  });
  it('se puede pagar sin cronograma ni datos (un pago real no exige inventar nada)', async () => {
    const w = await world();
    const { r } = await w.pay({ amount: '100.00', paidOn: '2026-10-10', interest: '30.00' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await w.bal()).toBe('900.00');
    expect((await w.get()).payments[0]).toMatchObject({ amount: '100.00', interest: '30.00', principal: null, installmentId: null });
  });
});

describe('Documentos: resumen, cronograma y estado de cuenta (RN-B02, RN-B03)', () => {
  it('un documento de préstamo no crea propuestas de movimiento y espera a asociarse', async () => {
    const w = await world();
    const d = await w.doc('SUMMARY');
    expect(d).toMatchObject({ status: 'loan_document', proposals: [] });
    expect((await api.get(w.u.token, '/capture/proposals')).body.items).toEqual([]);
    expect((await api.get(w.u.token, '/capture/documents?status=loan_document')).body.items).toHaveLength(1);
  });

  it('el resumen aporta los datos con su origen; el tipo de documento no es intercambiable', async () => {
    const w = await world();
    const sum = await w.doc('SUMMARY');
    const sched = await w.doc('SCHEDULE');
    expect((await api.post(w.u.token, `/bank-loans/${w.loan.id}/changes/preview`, { documentId: sum.id, kind: 'schedule' })).body.error.code).toBe('DOCUMENT_KIND_MISMATCH');
    expect((await api.post(w.u.token, `/bank-loans/${w.loan.id}/changes/preview`, { documentId: sched.id, kind: 'summary' })).body.error.code).toBe('DOCUMENT_KIND_MISMATCH');
    const { pv, r } = await w.change({ documentId: sum.id, kind: 'summary' });
    expect(pv.body.facts.map((f: any) => [f.key, f.change])).toEqual([['principal', 'new'], ['tea', 'new'], ['term_months', 'new'], ['installments_count', 'new'], ['disbursed_on', 'new'], ['first_due_date', 'new'], ['monthly_payment', 'new'], ['loan_number', 'new']]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const l = r.body;
    expect(l.facts.find((f: any) => f.key === 'tea')).toMatchObject({ value: '18.50', origin: 'document', documentId: sum.id });
    expect(l.pending).toEqual([]);
    expect(l.documents[0]).toMatchObject({ kind: 'summary', documentId: sum.id });
  });

  it('el cronograma crea el calendario y separa vencimiento de fecha de pago', async () => {
    const w = await world();
    const sched = await w.doc('SCHEDULE');
    const { pv, r } = await w.change({ documentId: sched.id, kind: 'schedule' });
    expect(pv.body.installments.map((x: any) => x.change)).toEqual(['new', 'new', 'new']);
    expect(pv.body.warnings).toEqual([]);
    const l = r.body;
    expect(l.installments.map((i: any) => [i.number, i.dueDate, i.total, i.state, i.origin])).toEqual([
      [1, '2026-10-01', '100.00', 'overdue', 'document'], [2, '2026-11-01', '100.00', 'upcoming', 'document'], [3, '2026-12-01', '100.00', 'upcoming', 'document'],
    ]);
    expect(l.totals).toMatchObject({ scheduled: '300.00', remainingScheduled: '300.00', overdue: 1 });
    expect(l.nextDue).toMatchObject({ number: 1, dueDate: '2026-10-01', remaining: '100.00' });
  });

  it('el estado de cuenta aporta el saldo con su fecha y nada más', async () => {
    const w = await world();
    const st = await w.doc('STATEMENT');
    const { r } = await w.change({ documentId: st.id, kind: 'statement' });
    expect(r.body.facts).toEqual([expect.objectContaining({ key: 'outstanding_balance', value: '210.00', asOf: '2026-10-10', origin: 'document' })]);
    expect(r.body.installments).toEqual([]);
  });

  it('un documento sin datos de préstamo, o de otro usuario, se rechaza', async () => {
    const w = await world();
    const yape = await w.doc('YAPE');
    expect((await api.post(w.u.token, `/bank-loans/${w.loan.id}/changes/preview`, { documentId: yape.id, kind: 'summary' })).body.error.code).toBe('NO_LOAN_DATA');
    const o = await world();
    const other = await o.doc('SUMMARY');
    expect((await api.post(w.u.token, `/bank-loans/${w.loan.id}/changes/preview`, { documentId: other.id, kind: 'summary' })).status).toBe(404);
  });
});

describe('Incoherencias y correcciones del usuario (RN-B03, RN-B08)', () => {
  it('señala una página incompleta y una suma que no cuadra; no se guarda sin confirmarlo', async () => {
    const w = await world();
    const bad = await w.doc('BAD');
    const pv = await api.post(w.u.token, `/bank-loans/${w.loan.id}/changes/preview`, { documentId: bad.id, kind: 'schedule' });
    expect(pv.body.requiresAcknowledge).toBe(true);
    expect(pv.body.warnings.map((x: any) => x.code).sort()).toEqual(['GAP_IN_NUMBERING', 'ROW_SUM_MISMATCH']);
    const body = { documentId: bad.id, kind: 'schedule', previewToken: pv.body.previewToken };
    const blocked = await api.post(w.u.token, `/bank-loans/${w.loan.id}/changes`, body);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('SCHEDULE_WARNINGS');
    expect((await w.get()).installments).toEqual([]);
    const ok = await api.post(w.u.token, `/bank-loans/${w.loan.id}/changes`, { ...body, acknowledgeWarnings: true });
    expect(ok.status).toBe(200);
    expect(ok.body.installments).toHaveLength(2);
    expect(ok.body.warnings.map((x: any) => x.code)).toContain('GAP_IN_NUMBERING'); // sigue señalado en el préstamo
  });

  it('lo que el usuario corrige queda marcado como suyo; lo demás conserva el origen documental', async () => {
    const w = await world();
    const sched = await w.doc('SCHEDULE');
    const fixed = [inst(1, '2026-10-01'), inst(2, '2026-11-03'), inst(3, '2026-12-01')];
    const { r } = await w.change({ documentId: sched.id, kind: 'schedule', installments: fixed });
    expect(r.body.installments.map((i: any) => [i.number, i.dueDate, i.origin])).toEqual([[1, '2026-10-01', 'document'], [2, '2026-11-03', 'user'], [3, '2026-12-01', 'document']]);
  });

  it('un resumen no admite cuotas ni un cronograma datos del préstamo (RN-B03)', async () => {
    const w = await world();
    const sum = await w.doc('SUMMARY');
    const sched = await w.doc('SCHEDULE');
    expect((await api.post(w.u.token, `/bank-loans/${w.loan.id}/changes/preview`, { documentId: sum.id, kind: 'summary', installments: [inst(1, '2026-10-01')] })).status).toBe(422);
    expect((await api.post(w.u.token, `/bank-loans/${w.loan.id}/changes/preview`, { documentId: sched.id, kind: 'schedule', facts: [{ key: 'principal', value: '1.00' }] })).status).toBe(422);
  });

  it('ingreso manual: queda como origen usuario y valida cada valor', async () => {
    const w = await world();
    expect((await w.change({ facts: [{ key: 'tea', value: '18,5%' }] })).r.body.error.code).toBe('INVALID_FACT');
    expect((await api.post(w.u.token, `/bank-loans/${w.loan.id}/changes/preview`, {})).status).toBe(422);
    const { r } = await w.change({ facts: [{ key: 'principal', value: '50' }], installments: [inst(1, '2026-11-01', '60.00', '50.00', '10.00', '0.00', '0.00')] });
    expect(r.body.facts[0]).toMatchObject({ key: 'principal', value: '50.00', origin: 'user', documentId: null });
    expect(r.body.installments[0]).toMatchObject({ origin: 'user', total: '60.00' });
  });

  it('un cambio posterior a la vista previa se rechaza', async () => {
    const w = await world();
    const pv = await api.post(w.u.token, `/bank-loans/${w.loan.id}/changes/preview`, { facts: [{ key: 'principal', value: '500' }] });
    await w.change({ facts: [{ key: 'tea', value: '10' }] });
    const r = await api.post(w.u.token, `/bank-loans/${w.loan.id}/changes`, { facts: [{ key: 'principal', value: '500' }], previewToken: pv.body.previewToken });
    expect(r.body.error.code).toBe('PREVIEW_STALE');
  });
});

describe('Pagos reales y documentos nuevos (RN-B05, RN-B06, RN-B07)', () => {
  async function withSchedule() {
    const w = await world();
    const sched = await w.doc('SCHEDULE');
    await w.change({ documentId: sched.id, kind: 'schedule' });
    return w;
  }

  it('un pago tardío cierra la cuota, guarda la fecha real y NO genera mora ni mueve el calendario', async () => {
    const w = await withSchedule();
    const pv = await api.post(w.u.token, `/bank-loans/${w.loan.id}/payments/preview`, { accountId: w.bcp.id, amount: '100.00', paidOn: '2026-10-10', installmentNumber: 1 });
    expect(pv.body).toMatchObject({ account: { before: '1000.00', after: '900.00' }, installment: { number: 1, settles: true, late: true, paidAfter: '100.00' } });
    const { r } = await w.pay({ amount: '100.00', paidOn: '2026-10-10', installmentNumber: 1, principal: '80.00', interest: '15.00', insurance: '3.00', fees: '2.00' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const l = await w.get();
    expect(l.installments[0]).toMatchObject({ number: 1, dueDate: '2026-10-01', paidOn: '2026-10-10', state: 'paid', late: true, remaining: '0.00' });
    expect(l.installments.map((i: any) => i.dueDate)).toEqual(['2026-10-01', '2026-11-01', '2026-12-01']); // el calendario no se desplaza
    expect(l.totals).toMatchObject({ scheduled: '300.00', paid: '100.00', remainingScheduled: '200.00', overdue: 0 });
    expect(await w.bal()).toBe('900.00');
    const op = (await api.get(w.u.token, `/operations?accountId=${w.bcp.id}`)).body.items.find((o: any) => o.concept === 'loan_payment');
    expect(op).toMatchObject({ kind: 'expense', description: 'Cuota 1 · Préstamo personal' });
  });

  it('una cuota vencida solo se marca: no se agrega ningún cargo', async () => {
    const w = await withSchedule();
    const l = await w.get();
    expect(l.installments[0].state).toBe('overdue');
    expect(l.totals.scheduled).toBe('300.00'); // nada de mora
    expect(l.installments[0].total).toBe('100.00');
  });

  it('un pago parcial deja la cuota abierta con lo que falta', async () => {
    const w = await withSchedule();
    await w.pay({ amount: '40.00', installmentNumber: 1 });
    expect((await w.get()).installments[0]).toMatchObject({ state: 'partial_overdue', paidAmount: '40.00', remaining: '60.00' });
    await w.pay({ amount: '60.00', installmentNumber: 1 });
    expect((await w.get()).installments[0]).toMatchObject({ state: 'paid', remaining: '0.00' });
    expect((await w.pay({ amount: '1.00', installmentNumber: 1 })).r.body.error.code).toBe('INSTALLMENT_PAID');
  });

  it('el pago es un egreso real: no se revierte por la ruta de movimientos y revertirlo reabre la cuota', async () => {
    const w = await withSchedule();
    const { r } = await w.pay({ amount: '100.00', installmentNumber: 1 });
    const opId = r.body.operation.id;
    expect((await api.post(w.u.token, `/operations/${opId}/reverse`, { reason: 'x' })).body.error.code).toBe('OPERATION_LINKED');
    const rv = await api.post(w.u.token, `/bank-loans/payments/${r.body.paymentId}/reverse`, { reason: 'Me equivoqué' });
    expect(rv.status, JSON.stringify(rv.body)).toBe(200);
    expect(rv.body.installments[0]).toMatchObject({ state: 'overdue', paidAmount: '0.00', paidOn: null });
    expect(rv.body.payments[0].status).toBe('reversed');
    expect(await w.bal()).toBe('1000.00');
    expect((await api.post(w.u.token, `/bank-loans/payments/${r.body.paymentId}/reverse`, { reason: 'otra vez' })).body.error.code).toBe('ALREADY_REVERSED');
  });

  it('un cronograma nuevo actualiza lo futuro sin borrar ni tocar lo pagado (RN-B06)', async () => {
    const w = await withSchedule();
    await w.pay({ amount: '100.00', paidOn: '2026-10-10', installmentNumber: 1 });
    const s2 = await w.doc('SCHEDULE2');
    const pv = await api.post(w.u.token, `/bank-loans/${w.loan.id}/changes/preview`, { documentId: s2.id, kind: 'schedule' });
    expect(pv.body.installments.map((x: any) => [x.number, x.change])).toEqual([[1, 'locked'], [2, 'changed'], [3, 'removed']]);
    const ok = await api.post(w.u.token, `/bank-loans/${w.loan.id}/changes`, { documentId: s2.id, kind: 'schedule', previewToken: pv.body.previewToken, acknowledgeWarnings: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const l = ok.body;
    expect(l.installments.map((i: any) => [i.number, i.dueDate, i.total, i.state])).toEqual([[1, '2026-10-01', '100.00', 'paid'], [2, '2026-11-15', '110.00', 'upcoming']]);
    expect(l.installments[0].paidOn).toBe('2026-10-10');
    expect(l.payments).toHaveLength(1);
    expect(l.documents.map((d: any) => d.kind)).toEqual(['schedule', 'schedule']);
    expect(l.documents[0].summary.installments).toEqual([{ number: 1, change: 'locked' }, { number: 2, change: 'changed' }, { number: 3, change: 'removed' }]);
  });

  it('el mismo documento otra vez no cambia nada', async () => {
    const w = await withSchedule();
    const pv = await api.post(w.u.token, `/bank-loans/${w.loan.id}/changes/preview`, { installments: [inst(1, '2026-10-01'), inst(2, '2026-11-01'), inst(3, '2026-12-01')] });
    expect(pv.body.hasChanges).toBe(false);
    expect(pv.body.installments.map((x: any) => x.change)).toEqual(['same', 'same', 'same']);
  });

  it('valida el pago: desglose, fecha futura, cuenta y préstamo cerrado', async () => {
    const w = await withSchedule();
    expect((await w.pay({ amount: '50.00', principal: '40.00', interest: '20.00' })).r.body.error.code).toBe('BREAKDOWN_EXCEEDS_PAYMENT');
    expect((await w.pay({ amount: '50.00', paidOn: '2026-10-13' })).r.body.error.code).toBe('FUTURE_DATE_NOT_ALLOWED');
    expect((await w.pay({ amount: '50.00', installmentNumber: 9 })).r.status).toBe(404);
    const other = await world();
    expect((await api.post(w.u.token, `/bank-loans/${w.loan.id}/payments/preview`, { accountId: other.bcp.id, amount: '10.00' })).status).toBe(404);
    const v = (await w.get()).version;
    expect((await api.patch(w.u.token, `/bank-loans/${w.loan.id}`, { status: 'closed' }, v)).body.status).toBe('closed');
    expect((await w.pay({ amount: '10.00' })).r.body.error.code).toBe('LOAN_CLOSED');
  });

  it('el comprobante de pago se vincula como evidencia del egreso', async () => {
    const w = await withSchedule();
    const rec = await w.doc('YAPE');
    const { r } = await w.pay({ amount: '100.00', installmentNumber: 1, documentId: rec.id });
    expect(r.status).toBe(201);
    const ev = await pool.query('select count(*)::int as n from evidence_link where document_id = $1 and operation_id = $2', [rec.id, r.body.operation.id]);
    expect(ev.rows[0].n).toBe(1);
  });
});

describe('Aislamiento y lista', () => {
  it('cada usuario ve solo sus préstamos; la lista muestra próximo vencimiento y pendientes', async () => {
    const a = await world();
    const b = await world();
    const sched = await a.doc('SCHEDULE');
    await a.change({ documentId: sched.id, kind: 'schedule' });
    const list = (await api.get(a.u.token, '/bank-loans')).body.items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Préstamo personal', nextDue: { number: 1 }, remainingScheduled: '300.00', overdue: 1, pending: ['principal', 'tea', 'term_months', 'first_due_date'] });
    expect((await api.get(b.u.token, `/bank-loans/${a.loan.id}`)).status).toBe(404);
    expect((await api.post(b.u.token, `/bank-loans/${a.loan.id}/changes/preview`, { facts: [{ key: 'principal', value: '1' }] })).status).toBe(404);
    expect((await api.get(b.u.token, '/bank-loans')).body.items.map((x: any) => x.id)).toEqual([b.loan.id]);
  });
});
