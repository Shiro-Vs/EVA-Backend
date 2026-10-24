import { afterAll, describe, expect, it } from 'vitest';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount, createContact } from '../helpers/scenarios.js';

const api = makeApi();
afterAll(async () => { await api.app.close(); await pool.end(); });
const at = (iso: string) => api.setNow(new Date(`${iso}T17:00:00Z`));
const balance = async (token: string, id: string) => (await api.get(token, `/accounts/${id}`)).body.balance as string;

async function world(opening = '1000.00') {
  at('2026-10-12');
  const u = await api.newUser();
  const bcp = await createAccount(api, u.token, 'BCP', opening);
  return { u, bcp };
}
type W = Awaited<ReturnType<typeof world>>;

async function newLoan(w: W, body: Record<string, unknown>) {
  const pv = await api.post(w.u.token, '/loans/preview', body);
  if (pv.status !== 200) return pv;
  return api.post(w.u.token, '/loans', { ...body, previewToken: pv.body.previewToken });
}
async function pay(w: W, loanId: string, body: Record<string, unknown>) {
  const pv = await api.post(w.u.token, `/loans/${loanId}/payments/preview`, body);
  if (pv.status !== 200 || !pv.body.valid) return pv;
  return api.post(w.u.token, `/loans/${loanId}/payments`, { ...body, previewToken: pv.body.previewToken });
}
const loanOf = async (w: W, id: string) => (await api.get(w.u.token, `/loans/${id}`)).body;
const charge = (loan: any, concept: string, no: number | null) => loan.charges.find((c: any) => c.concept === concept && (no === null || c.installmentNo === no || c.periodNo === no));

describe('A20 · préstamo recibido y devolución con interés (RN-MV05)', () => {
  it('+1 000.00 y −1 050.00; el capital no es ingreso ni gasto de consumo; el costo financiero es 50.00', async () => {
    const w = await world('500.00');
    const carla = await createContact(api, w.u.token, 'Carla');
    const body = {
      direction: 'borrowed', contactId: carla.id, principal: '1000.00', accountId: w.bcp.id,
      interest: { mode: 'fixed', amount: '50.00' }, repayment: { kind: 'final_date', finalDate: '2026-11-12' },
    };
    const pv = await api.post(w.u.token, '/loans/preview', body);
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body.totals).toEqual({ principal: '1000.00', interest: '50.00', toPay: '1050.00' });
    expect(pv.body.disbursement).toMatchObject({ kind: 'in', amount: '1000.00' });

    const r = await api.post(w.u.token, '/loans', { ...body, previewToken: pv.body.previewToken });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await balance(w.u.token, w.bcp.id)).toBe('1500.00');
    expect(r.body).toMatchObject({ engine: 'ledger', direction: 'borrowed', contactName: 'Carla', pending: '1050.00', status: 'open' });
    expect((await api.get(w.u.token, '/summary')).body.loans).toEqual({ lentPending: '0.00', borrowedPending: '1050.00' });

    at('2026-11-12');
    const p = await api.post(w.u.token, `/loans/${r.body.id}/payments/preview`, { amount: '1050.00', accountId: w.bcp.id });
    expect(p.body).toMatchObject({ valid: true, proposedByServer: true, summary: { remainder: '0.00', direction: 'out' } });
    expect(p.body.allocations).toHaveLength(2);
    const paid = await api.post(w.u.token, `/loans/${r.body.id}/payments`, { amount: '1050.00', accountId: w.bcp.id, previewToken: p.body.previewToken });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(await balance(w.u.token, w.bcp.id)).toBe('450.00'); // +1000 −1050
    const l = paid.body.loan;
    expect(l).toMatchObject({ status: 'closed', pending: '0.00' });
    expect(l.totals).toMatchObject({ principalPaid: '1000.00', interestPaid: '50.00', financialCost: '50.00', principalPending: '0.00' });

    // Dos movimientos reales y NINGUNO cuenta como ingreso ganado ni gasto de consumo.
    const ops = (await api.get(w.u.token, '/operations?kind=income')).body.items.concat((await api.get(w.u.token, '/operations?kind=expense')).body.items);
    expect(ops.map((o: any) => [o.kind, o.concept, o.amount]).sort()).toEqual([['expense', 'loan_payment', '-1050.00'], ['income', 'loan_disbursement', '1000.00']]);
    const ordinary = await pool.query(`select count(*)::int as n from financial_operation where owner_id = $1 and kind in ('income','expense') and concept = 'ordinary'`, [w.u.id]);
    expect(ordinary.rows[0].n).toBe(0);
  });
});

describe('Préstamo otorgado en cuotas con interés sobre el pendiente', () => {
  const body = (w: W, contactId: string) => ({
    direction: 'lent', contactId, principal: '600.00', accountId: w.bcp.id, openedOn: '2026-10-12',
    interest: { mode: 'percent', ratePercent: '2', base: 'pending' }, repayment: { kind: 'installments', installments: 3, firstDueDate: '2026-11-12' },
  });

  it('cronograma, desembolso y el pago propuesto por antigüedad (capital antes que interés)', async () => {
    const w = await world();
    const ana = await createContact(api, w.u.token, 'Ana');
    const r = await newLoan(w, body(w, ana.id));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await balance(w.u.token, w.bcp.id)).toBe('400.00'); // salieron 600.00
    expect(r.body.charges.map((c: any) => [c.concept, c.installmentNo, c.dueDate, c.amount])).toEqual([
      ['principal', 1, '2026-11-12', '200.00'], ['interest', 1, '2026-11-12', '12.00'],
      ['principal', 2, '2026-12-12', '200.00'], ['interest', 2, '2026-12-12', '8.00'],
      ['principal', 3, '2027-01-12', '200.00'], ['interest', 3, '2027-01-12', '4.00'],
    ]);
    expect(r.body.nextDue).toEqual({ dueDate: '2026-11-12', amount: '212.00' });
    expect((await api.get(w.u.token, '/summary')).body.loans.lentPending).toBe('624.00');

    at('2026-11-12');
    const p = await pay(w, r.body.id, { amount: '210.00', accountId: w.bcp.id });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const l = p.body.loan;
    expect(charge(l, 'principal', 1)).toMatchObject({ paid: '200.00', pending: '0.00' }); // primero el capital…
    expect(charge(l, 'interest', 1)).toMatchObject({ paid: '10.00', pending: '2.00' }); // …y con lo que sobra, el interés
    expect(await balance(w.u.token, w.bcp.id)).toBe('610.00');
    expect(l.nextDue).toEqual({ dueDate: '2026-11-12', amount: '2.00' });
  });

  it('el administrador elige a qué se aplica un abono; no hay orden automático (RN-L05)', async () => {
    const w = await world();
    const ana = await createContact(api, w.u.token, 'Ana');
    const r = await newLoan(w, body(w, ana.id));
    const i1 = charge(r.body, 'interest', 1).id;
    const p3 = charge(r.body, 'principal', 3).id;
    const p = await pay(w, r.body.id, { amount: '100.00', accountId: w.bcp.id, allocations: [{ chargeId: i1, amount: '12.00' }, { chargeId: p3, amount: '88.00' }] });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(charge(p.body.loan, 'interest', 1)).toMatchObject({ pending: '0.00' });
    expect(charge(p.body.loan, 'principal', 3)).toMatchObject({ paid: '88.00', pending: '112.00' });
    expect(charge(p.body.loan, 'principal', 1)).toMatchObject({ paid: '0.00' }); // lo más antiguo quedó como estaba
  });

  it('validaciones del pago y el sobrante: se rechaza salvo que se conserve como saldo a favor (RN-L11)', async () => {
    const w = await world();
    const ana = await createContact(api, w.u.token, 'Ana');
    const r = await newLoan(w, body(w, ana.id));
    const p1 = charge(r.body, 'principal', 1).id;
    const over = await api.post(w.u.token, `/loans/${r.body.id}/payments/preview`, { amount: '500.00', accountId: w.bcp.id, allocations: [{ chargeId: p1, amount: '300.00' }] });
    expect(over.body).toMatchObject({ valid: false });
    expect(over.body.issues.map((i: any) => i.code).sort()).toEqual(['EXCEEDS_CHARGE', 'REMAINDER']);
    expect(over.body.previewToken).toBeUndefined();
    expect((await api.post(w.u.token, `/loans/${r.body.id}/payments`, { amount: '50.00', accountId: w.bcp.id, allocations: [{ chargeId: p1, amount: '20.00' }], previewToken: 'x'.repeat(20) })).status).toBe(422);

    const sobra = { amount: '250.00', accountId: w.bcp.id, allocations: [{ chargeId: p1, amount: '200.00' }] };
    expect((await api.post(w.u.token, `/loans/${r.body.id}/payments/preview`, sobra)).body.issues[0].code).toBe('REMAINDER');
    const kept = await pay(w, r.body.id, { ...sobra, onRemainder: 'keep' });
    expect(kept.status, JSON.stringify(kept.body)).toBe(201);
    expect(kept.body.loan.credit).toBe('50.00'); // conservado, nunca devuelto solo
    expect(kept.body.loan.payments[0]).toMatchObject({ amount: '250.00', unapplied: '50.00' });
    expect(await balance(w.u.token, w.bcp.id)).toBe('650.00');
  });

  it('un pago se puede revertir: el dinero vuelve y la deuda se reabre', async () => {
    const w = await world();
    const ana = await createContact(api, w.u.token, 'Ana');
    const r = await newLoan(w, body(w, ana.id));
    const p = await pay(w, r.body.id, { amount: '100.00', accountId: w.bcp.id });
    expect(await balance(w.u.token, w.bcp.id)).toBe('500.00');
    const rev = await api.post(w.u.token, `/loan-payments/${p.body.paymentId}/reverse`, { reason: 'Se registró dos veces' });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    expect(await balance(w.u.token, w.bcp.id)).toBe('400.00');
    expect(rev.body.pending).toBe('624.00');
    expect(rev.body.payments[0].status).toBe('reversed');
    expect((await api.post(w.u.token, `/loan-payments/${p.body.paymentId}/reverse`, { reason: 'otra vez' })).body.error.code).toBe('ALREADY_REVERSED');
  });

  it('mora: se calcula en vista previa y solo se aplica al confirmar, una vez por período (RN-L10/L23)', async () => {
    const w = await world();
    const ana = await createContact(api, w.u.token, 'Ana');
    const r = await newLoan(w, { ...body(w, ana.id), openedOn: '2026-08-12', interest: { mode: 'none' }, repayment: { kind: 'installments', installments: 3, firstDueDate: '2026-09-12' } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // Hoy 12-oct: la cuota 1 venció el 12-sep (un período completo vencido); la 2 vence hoy y aún no cuenta.
    const pv = await api.post(w.u.token, `/loans/${r.body.id}/late-fees/preview`, { mode: 'fixed', amount: '5.00' });
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body).toMatchObject({ count: 1, total: '5.00' });
    expect(pv.body.items[0]).toMatchObject({ overduePending: '200.00', fee: '5.00', periodNo: 1 });
    expect((await loanOf(w, r.body.id)).totals.feesPending).toBe('0.00'); // calcular no cobra

    const ap = await api.post(w.u.token, `/loans/${r.body.id}/late-fees`, { mode: 'fixed', amount: '5.00', previewToken: pv.body.previewToken });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect(ap.body.totals.feesPending).toBe('5.00');
    expect((await api.post(w.u.token, `/loans/${r.body.id}/late-fees/preview`, { mode: 'fixed', amount: '5.00' })).body.count).toBe(0);

    at('2026-11-12'); // un período más para la cuota 1 y el primero para la cuota 2
    const pv2 = await api.post(w.u.token, `/loans/${r.body.id}/late-fees/preview`, { mode: 'percent', ratePercent: '3' });
    expect(pv2.body.items.map((i: any) => [i.periodNo, i.overduePending, i.fee]).sort()).toEqual([[1, '200.00', '6.00'], [2, '200.00', '6.00']]);
    expect((await api.post(w.u.token, '/loans/' + r.body.id + '/late-fees/preview', { mode: 'percent' })).body.error.code).toBe('INTEREST_REQUIRED');
  });

  it('anular un préstamo sin pagos revierte el desembolso; con pagos se rechaza', async () => {
    const w = await world();
    const ana = await createContact(api, w.u.token, 'Ana');
    const a = await newLoan(w, body(w, ana.id));
    const c = await api.post(w.u.token, `/loans/${a.body.id}/cancel`, { reason: 'Me equivoqué' });
    expect(c.body.status).toBe('cancelled');
    expect(await balance(w.u.token, w.bcp.id)).toBe('1000.00');
    const b = await newLoan(w, body(w, ana.id));
    await pay(w, b.body.id, { amount: '50.00', accountId: w.bcp.id });
    expect((await api.post(w.u.token, `/loans/${b.body.id}/cancel`, { reason: 'x' })).body.error.code).toBe('LOAN_HAS_PAYMENTS');
  });
});

describe('Préstamo sin fecha: interés mensual al consultar, capitalización y pago anticipado', () => {
  const open = (w: W, over: Record<string, unknown> = {}) => ({
    direction: 'borrowed', counterpartyName: 'Banco X', principal: '1000.00', openedOn: '2026-08-12',
    interest: { mode: 'percent', ratePercent: '5', base: 'original' }, repayment: { kind: 'open' }, ...over,
  });

  it('el interés se devenga mes a mes, sin duplicarse al consultar de nuevo', async () => {
    const w = await world();
    const r = await newLoan(w, open(w));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ contactName: 'Banco X', counterpartyName: 'Banco X' });
    const interest = (l: any) => l.charges.filter((c: any) => c.concept === 'interest');
    expect(interest(r.body).map((c: any) => [c.periodNo, c.dueDate, c.amount])).toEqual([[1, '2026-09-12', '50.00'], [2, '2026-10-12', '50.00']]);
    expect(interest(await loanOf(w, r.body.id))).toHaveLength(2); // consultar otra vez no duplica
    at('2026-11-12');
    expect(interest(await loanOf(w, r.body.id))).toHaveLength(3);
  });

  it('con base «pendiente», lo abonado a capital reduce el interés de los períodos siguientes', async () => {
    const w = await world();
    const r = await newLoan(w, open(w, { openedOn: '2026-10-12', interest: { mode: 'percent', ratePercent: '5', base: 'pending' } }));
    at('2026-11-12');
    const l1 = await loanOf(w, r.body.id);
    expect(charge(l1, 'interest', 1).amount).toBe('50.00');
    const principal = charge(l1, 'principal', null);
    const p = await pay(w, r.body.id, { amount: '400.00', accountId: w.bcp.id, allocations: [{ chargeId: principal.id, amount: '400.00' }] });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    at('2026-12-12');
    expect(charge(await loanOf(w, r.body.id), 'interest', 2).amount).toBe('30.00'); // 5 % de 600
  });

  it('capitalizar es solo a petición: el interés vencido pasa a capital y desde entonces genera interés', async () => {
    const w = await world();
    const r = await newLoan(w, open(w, { interest: { mode: 'percent', ratePercent: '5', base: 'pending' } }));
    expect(r.body.totals).toMatchObject({ principalPending: '1000.00', interestPending: '100.00' });
    const pv = await api.post(w.u.token, `/loans/${r.body.id}/capitalize/preview`, {});
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body.total).toBe('100.00');
    expect((await loanOf(w, r.body.id)).totals.principalPending).toBe('1000.00'); // la vista previa no cambia nada
    const ap = await api.post(w.u.token, `/loans/${r.body.id}/capitalize`, { previewToken: pv.body.previewToken });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect(ap.body.totals).toMatchObject({ principalPending: '1100.00', interestPending: '0.00' });
    expect(ap.body.charges.filter((c: any) => c.status === 'capitalized')).toHaveLength(2);
    expect((await api.post(w.u.token, `/loans/${r.body.id}/capitalize/preview`, {})).body.error.code).toBe('NOTHING_TO_CAPITALIZE');
    at('2026-11-12');
    expect(charge(await loanOf(w, r.body.id), 'interest', 3).amount).toBe('55.00'); // 5 % de 1 100
  });

  it('pago anticipado «solo el devengado»: períodos cumplidos completos y el actual por días (base 30)', async () => {
    const w = await world();
    const r = await newLoan(w, open(w, { openedOn: '2026-10-01', earlyPayoff: 'accrued' }));
    at('2026-11-10');
    const pv = await api.post(w.u.token, `/loans/${r.body.id}/payoff/preview`, { accountId: w.bcp.id });
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body.total).toBe('1065.00'); // 1 000 + 50 del período cumplido + 50 × 9 / 30 = 15.00 del período en curso
    expect(pv.body.lines.map((l: any) => [l.concept, l.settle, l.action]).sort()).toEqual([['interest', '15.00', 'accrued_now'], ['interest', '50.00', 'full'], ['principal', '1000.00', 'full']]);
    const done = await api.post(w.u.token, `/loans/${r.body.id}/payoff`, { accountId: w.bcp.id, previewToken: pv.body.previewToken });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body.loan).toMatchObject({ status: 'closed', pending: '0.00' });
    expect(done.body.loan.totals.interestPaid).toBe('65.00');
    expect(done.body.loan.payments[0].kind).toBe('payoff');
    expect(await balance(w.u.token, w.bcp.id)).toBe('-65.00'); // 1000 − 1065
  });

  it('pago anticipado «mantener lo acordado» vs «solo el devengado» sobre el mismo préstamo con fecha final', async () => {
    const mk = async (early: string) => {
      const w = await world('2000.00');
      const r = await newLoan(w, { direction: 'borrowed', counterpartyName: 'Banco X', principal: '1000.00', interest: { mode: 'fixed', amount: '50.00' }, repayment: { kind: 'final_date', finalDate: '2026-12-12' }, earlyPayoff: early });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      at('2026-11-20');
      return { w, id: r.body.id as string };
    };
    const keep = await mk('keep');
    expect((await api.post(keep.w.u.token, `/loans/${keep.id}/payoff/preview`, { accountId: keep.w.bcp.id })).body.total).toBe('1100.00'); // todo el interés acordado
    const accrued = await mk('accrued');
    const pv = await api.post(accrued.w.u.token, `/loans/${accrued.id}/payoff/preview`, { accountId: accrued.w.bcp.id });
    expect(pv.body.total).toBe('1063.34'); // 1 000 + 50 + 50 × 8 / 30 = 13.34
    const done = await api.post(accrued.w.u.token, `/loans/${accrued.id}/payoff`, { accountId: accrued.w.bcp.id, previewToken: pv.body.previewToken });
    expect(done.body.loan.totals.interestPaid).toBe('63.34');
    expect(done.body.loan.status).toBe('closed');
  });
});

describe('Validaciones al crear', () => {
  it('quién, cuánto y cómo se devuelve', async () => {
    const w = await world();
    const ana = await createContact(api, w.u.token, 'Ana');
    const code = async (b: Record<string, unknown>) => (await api.post(w.u.token, '/loans/preview', b)).body.error?.code;
    const ok = { direction: 'lent', contactId: ana.id, principal: '100.00', interest: { mode: 'none' }, repayment: { kind: 'open' } };
    expect(await code({ ...ok, contactId: null })).toBe('VALIDATION_ERROR');
    expect(await code({ ...ok, direction: 'borrowed', contactId: null })).toBe('VALIDATION_ERROR');
    expect(await code({ ...ok, interest: { mode: 'fixed' } })).toBe('INTEREST_REQUIRED');
    expect(await code({ ...ok, interest: { mode: 'percent' } })).toBe('INTEREST_REQUIRED');
    expect(await code({ ...ok, repayment: { kind: 'installments', installments: 3 } })).toBe('REPAYMENT_REQUIRED');
    expect(await code({ ...ok, repayment: { kind: 'final_date', finalDate: '2026-09-01' } })).toBe('REPAYMENT_DATES');
    expect(await code({ ...ok, openedOn: '2026-12-01' })).toBe('FUTURE_DATE_NOT_ALLOWED');
    expect(await code({ ...ok, accountId: '00000000-0000-4000-8000-000000000001' })).toBe('NOT_FOUND');
    // La vista previa avisa si el token no corresponde a lo que se confirma.
    const pv = await api.post(w.u.token, '/loans/preview', ok);
    expect((await api.post(w.u.token, '/loans', { ...ok, principal: '200.00', previewToken: pv.body.previewToken })).body.error.code).toBe('PREVIEW_MISMATCH');
  });

  it('un préstamo viene por GET /loans junto con los de conversión de deuda, y es privado', async () => {
    const w = await world();
    const ana = await createContact(api, w.u.token, 'Ana');
    const r = await newLoan(w, { direction: 'lent', contactId: ana.id, principal: '100.00', interest: { mode: 'none' }, repayment: { kind: 'open' } });
    expect((await api.get(w.u.token, `/loans?contactId=${ana.id}`)).body.items.map((l: any) => l.id)).toEqual([r.body.id]);
    const stranger = await api.newUser();
    expect((await api.get(stranger.token, `/loans/${r.body.id}`)).status).toBe(404);
    expect((await api.post(stranger.token, `/loans/${r.body.id}/cancel`, { reason: 'x' })).status).toBe(404);
  });
});
