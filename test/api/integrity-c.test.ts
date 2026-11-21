import { afterAll, describe, expect, it } from 'vitest';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount, createContact } from '../helpers/scenarios.js';

const api = makeApi({ env: { CORS_ORIGINS: 'http://localhost:8081' } });
afterAll(async () => { await api.app.close(); await pool.end(); });
const at = (iso: string) => api.setNow(new Date(`${iso}T17:00:00Z`));
const balance = async (token: string, id: string) => (await api.get(token, `/accounts/${id}`)).body.balance as string;

describe('Integridad financiera: tarjetas, vínculos de operaciones y compensación de metas', () => {
  it('bloquea ingresos en tarjeta de crédito (creación, corrección y desembolso de préstamo)', async () => {
    at('2026-10-12');
    const u = await api.newUser();
    const bcp = await createAccount(api, u.token, 'BCP', '500.00', 'bank');
    const visa = await createAccount(api, u.token, 'Visa', '0.00', 'credit');
    const carla = await createContact(api, u.token, 'Carla');

    // 1. Ingreso directo en tarjeta
    const badOp = await api.post(u.token, '/operations', { kind: 'income', accountId: visa.id, amount: '50.00', description: 'Error' });
    expect(badOp.status).toBe(422);
    expect(badOp.body.error.code).toBe('VALIDATION_ERROR');

    // 2. Corregir un ingreso de cuenta bancaria hacia tarjeta
    const okOp = await api.post(u.token, '/operations', { kind: 'income', accountId: bcp.id, amount: '50.00', description: 'Sueldo' });
    expect(okOp.status).toBe(201);
    const badCorr = await api.post(u.token, `/operations/${okOp.body.id}/correct/preview`, { accountId: visa.id });
    expect(badCorr.status).toBe(422);
    expect(badCorr.body.error.code).toBe('VALIDATION_ERROR');

    // 3. Desembolso de préstamo recibido en tarjeta
    const badLoan = await api.post(u.token, '/loans/preview', {
      direction: 'borrowed', contactId: carla.id, principal: '200.00', accountId: visa.id,
      interest: { mode: 'none' }, repayment: { kind: 'final_date', finalDate: '2026-11-12' },
    });
    expect(badLoan.status).toBe(422);
    expect(badLoan.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('protege operaciones vinculadas a préstamos, préstamos bancarios, pagos de tarjeta y cuotas', async () => {
    at('2026-10-12');
    const u = await api.newUser();
    const bcp = await createAccount(api, u.token, 'BCP', '1000.00', 'bank');
    const visa = await createAccount(api, u.token, 'Visa', '0.00', 'credit');
    const ana = await createContact(api, u.token, 'Ana');

    // Préstamo personal: desembolso y pago
    const loanBody = {
      direction: 'lent', contactId: ana.id, principal: '300.00', accountId: bcp.id,
      interest: { mode: 'none' }, repayment: { kind: 'final_date', finalDate: '2026-11-12' },
    };
    const lpv = await api.post(u.token, '/loans/preview', loanBody);
    const loan = await api.post(u.token, '/loans', { ...loanBody, previewToken: lpv.body.previewToken });
    expect(loan.status).toBe(201);

    const disbRow = await pool.query(`select disbursement_operation_id as id from loan where id = $1`, [loan.body.id]);
    const disbOpId = disbRow.rows[0].id as string;
    const disbDetail = await api.get(u.token, `/operations/${disbOpId}`);
    expect(disbDetail.body.links.loanDisbursementId).toBe(loan.body.id);
    expect((await api.post(u.token, `/operations/${disbOpId}/reverse`, { reason: 'Intento' })).body.error.code).toBe('OPERATION_LINKED');
    expect((await api.post(u.token, `/operations/${disbOpId}/correct/preview`, { amount: '250.00' })).body.error.code).toBe('OPERATION_LINKED');

    const ppv = await api.post(u.token, `/loans/${loan.body.id}/payments/preview`, { amount: '100.00', accountId: bcp.id });
    const lpay = await api.post(u.token, `/loans/${loan.body.id}/payments`, { amount: '100.00', accountId: bcp.id, previewToken: ppv.body.previewToken });
    const payOpId = lpay.body.loan.payments[0].operationId as string;
    const payDetail = await api.get(u.token, `/operations/${payOpId}`);
    expect(payDetail.body.links.loanPaymentId).toBe(lpay.body.paymentId);
    expect((await api.post(u.token, `/operations/${payOpId}/reverse`, { reason: 'Intento' })).body.error.code).toBe('OPERATION_LINKED');

    // Préstamo bancario: pago
    const bl = await api.post(u.token, '/bank-loans', { name: 'Hipoteca', accountId: bcp.id });
    expect(bl.status).toBe(201);
    const bpv = await api.post(u.token, `/bank-loans/${bl.body.id}/payments/preview`, { accountId: bcp.id, amount: '80.00' });
    const bpay = await api.post(u.token, `/bank-loans/${bl.body.id}/payments`, { accountId: bcp.id, amount: '80.00', previewToken: bpv.body.previewToken });
    const bpayOpId = bpay.body.loan.payments[0].operationId as string;
    expect((await api.get(u.token, `/operations/${bpayOpId}`)).body.links.bankLoanPaymentId).toBe(bpay.body.paymentId);
    expect((await api.post(u.token, `/operations/${bpayOpId}/reverse`, { reason: 'Intento' })).body.error.code).toBe('OPERATION_LINKED');

    // Tarjeta: compra en cuotas y pago vinculado a estado de cuenta
    const inst = await api.post(u.token, `/accounts/${visa.id}/installment-purchases`, {
      amount: '120.00', installments: 3, firstDueDate: '2026-11-05', description: 'Audífonos',
    });
    expect(inst.status).toBe(201);
    const instOpId = inst.body.operation.id as string;
    expect((await api.get(u.token, `/operations/${instOpId}`)).body.links.installmentPlanId).toBe(inst.body.id);
    expect((await api.post(u.token, `/operations/${instOpId}/reverse`, { reason: 'Intento' })).body.error.code).toBe('OPERATION_LINKED');
    // Tras cancelar el plan de cuotas, sí se puede revertir
    expect((await api.post(u.token, `/installment-plans/${inst.body.id}/cancel`, {})).status).toBe(200);
    expect((await api.post(u.token, `/operations/${instOpId}/reverse`, { reason: 'Devolución' })).status).toBe(201);

    // Estado de cuenta y pago vinculado
    const st = await api.post(u.token, `/accounts/${visa.id}/statements`, {
      cutoffDate: '2026-10-10', dueDate: '2026-10-25', periodTotal: '100.00', minimumPayment: '20.00',
    });
    expect(st.status).toBe(201);
    const tr = await api.post(u.token, '/operations', { kind: 'transfer', accountId: bcp.id, toAccountId: visa.id, amount: '100.00', description: 'Pago Visa' });
    expect(tr.status).toBe(201);
    const linked = await api.post(u.token, `/card-statements/${st.body.id}/payments`, { operationId: tr.body.id });
    expect(linked.status).toBe(201);
    const cardPayId = linked.body.payments[0].id as string;
    expect((await api.get(u.token, `/operations/${tr.body.id}`)).body.links.cardStatementPaymentId).toBe(cardPayId);
    expect((await api.post(u.token, `/operations/${tr.body.id}/reverse`, { reason: 'Intento' })).body.error.code).toBe('OPERATION_LINKED');
    // Tras desvincular el pago del estado, sí se puede revertir
    expect((await api.post(u.token, `/card-statement-payments/${cardPayId}/remove`, {})).status).toBe(200);
    expect((await api.post(u.token, `/operations/${tr.body.id}/reverse`, { reason: 'Error de monto' })).status).toBe(201);
  });

  it('compensa automáticamente goal_contribution al revertir un gasto descontado o una transferencia vinculada', async () => {
    at('2026-10-12');
    const u = await api.newUser();
    const bcp = await createAccount(api, u.token, 'BCP', '200.00', 'bank');
    const ahorro = await createAccount(api, u.token, 'Ahorro', '0.00', 'savings');
    const goal = await api.post(u.token, '/goals', { name: 'Viaje', targetAmount: '500.00' });
    expect(goal.status).toBe(201);

    // Reservar 50.00 en BCP
    expect((await api.post(u.token, `/goals/${goal.body.id}/reserve`, { accountId: bcp.id, amount: '50.00' })).status).toBe(200);
    expect((await api.get(u.token, `/goals/${goal.body.id}`)).body.saved).toBe('50.00');

    // Gasto de 180.00 que consume 30.00 de la reserva
    const spend = await api.post(u.token, '/operations', {
      kind: 'expense', accountId: bcp.id, amount: '180.00', description: 'Compra',
      goalDeductions: [{ goalId: goal.body.id, amount: '30.00' }],
    });
    expect(spend.status).toBe(201);
    expect((await api.get(u.token, `/goals/${goal.body.id}`)).body.saved).toBe('20.00');

    // Revertir el gasto restaura automáticamente los 30.00 reservados
    const revSpend = await api.post(u.token, `/operations/${spend.body.id}/reverse`, { reason: 'Anulado' });
    expect(revSpend.status).toBe(201);
    expect((await api.get(u.token, `/goals/${goal.body.id}`)).body.saved).toBe('50.00');

    // Transferencia de 40.00 hacia Ahorro vinculada a la meta
    const tr = await api.post(u.token, '/operations', { kind: 'transfer', accountId: bcp.id, toAccountId: ahorro.id, amount: '40.00', description: 'Aporte' });
    expect(tr.status).toBe(201);
    expect((await api.post(u.token, `/goals/${goal.body.id}/link-transfer`, { operationId: tr.body.id })).status).toBe(200);
    expect((await api.get(u.token, `/goals/${goal.body.id}`)).body.saved).toBe('90.00');

    // Revertir la transferencia libera los 40.00 vinculados
    const revTr = await api.post(u.token, `/operations/${tr.body.id}/reverse`, { reason: 'Error' });
    expect(revTr.status).toBe(201);
    expect((await api.get(u.token, `/goals/${goal.body.id}`)).body.saved).toBe('50.00');
  });
});

describe('Préstamos: cierre automático y reversión completa de pago anticipado (payoff)', () => {
  it('revertir un payoff con earlyPayoff=accrued restaura cargos anulados/prorrateados y anula el devengado extra', async () => {
    at('2026-10-12');
    const u = await api.newUser();
    const bcp = await createAccount(api, u.token, 'BCP', '1000.00', 'bank');
    const ana = await createContact(api, u.token, 'Ana');

    const body = {
      direction: 'lent', contactId: ana.id, principal: '600.00', accountId: bcp.id, openedOn: '2026-10-12',
      interest: { mode: 'percent', ratePercent: '5', base: 'original' },
      repayment: { kind: 'installments', installments: 3, firstDueDate: '2026-11-12' },
      earlyPayoff: 'accrued',
    };
    const pv = await api.post(u.token, '/loans/preview', body);
    const loan = await api.post(u.token, '/loans', { ...body, previewToken: pv.body.previewToken });
    expect(loan.status).toBe(201);
    const initialPending = loan.body.pending as string;
    expect(initialPending).toBe('690.00'); // 600 + 3*30

    // Payoff a mitad del primer período (27 oct = 15 de 31 días)
    at('2026-10-27');
    const pfpv = await api.post(u.token, `/loans/${loan.body.id}/payoff/preview`, { accountId: bcp.id });
    expect(pfpv.status).toBe(200);
    const pf = await api.post(u.token, `/loans/${loan.body.id}/payoff`, { accountId: bcp.id, previewToken: pfpv.body.previewToken });
    expect(pf.status).toBe(201);
    expect(pf.body.loan.status).toBe('closed');
    expect(pf.body.loan.pending).toBe('0.00');

    // Revertir el pago de payoff debe reabrir el préstamo y restaurar exactamente 690.00
    const rev = await api.post(u.token, `/loan-payments/${pf.body.paymentId}/reverse`, { reason: 'Cheque rebotado' });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    expect(rev.body.status).toBe('open');
    expect(rev.body.pending).toBe('690.00');
    expect(await balance(u.token, bcp.id)).toBe('400.00'); // 1000 - 600 desembolso
    const interests = rev.body.charges.filter((c: any) => c.concept === 'interest' && c.status !== 'void');
    expect(interests.map((c: any) => [c.installmentNo, c.amount])).toEqual([[1, '30.00'], [2, '30.00'], [3, '30.00']]);
  });
});

describe('Validaciones anti-500 y CORS Content-Disposition', () => {
  it('rechaza con 422 importes cero, presupuestos archivados, fechas inexistentes y tarjetas archivadas', async () => {
    at('2026-10-12');
    const u = await api.newUser();
    const visa = await createAccount(api, u.token, 'Visa', '0.00', 'credit');

    // Presupuesto con límite 0 → 422
    const bZero = await api.post(u.token, '/budgets', { name: 'Comida', period: 'monthly', limit: '0.00' });
    expect(bZero.status).toBe(422);
    expect(bZero.body.error.code).toBe('VALIDATION_ERROR');

    // Presupuesto archivado no se puede editar → 422 BUDGET_ARCHIVED
    const bOk = await api.post(u.token, '/budgets', { name: 'Comida', period: 'monthly', limit: '300.00' });
    expect(bOk.status).toBe(201);
    const bArch = await api.post(u.token, `/budgets/${bOk.body.id}/archive`, {});
    expect(bArch.status).toBe(200);
    const bPatch = await api.patch(u.token, `/budgets/${bOk.body.id}`, { limit: '400.00' }, bArch.body.version);
    expect(bPatch.status).toBe(422);
    expect(bPatch.body.error.code).toBe('BUDGET_ARCHIVED');

    // Meta con targetAmount 0 → 422
    const gZero = await api.post(u.token, '/goals', { name: 'Fondo', targetAmount: '0.00' });
    expect(gZero.status).toBe(422);
    expect(gZero.body.error.code).toBe('VALIDATION_ERROR');

    // Fecha de calendario inexistente (31 de febrero) → 422 (nunca 500)
    const gBadDate = await api.post(u.token, '/goals', { name: 'Fondo', targetAmount: '100.00', targetDate: '2027-02-31' });
    expect(gBadDate.status).toBe(422);
    expect(gBadDate.body.error.code).toBe('VALIDATION_ERROR');

    // Estado de cuenta con total 0 o pago mínimo mayor al total → 422
    const stZero = await api.post(u.token, `/accounts/${visa.id}/statements`, {
      cutoffDate: '2026-10-10', dueDate: '2026-10-25', periodTotal: '0.00', minimumPayment: '0.00',
    });
    expect(stZero.status).toBe(422);
    const stMin = await api.post(u.token, `/accounts/${visa.id}/statements`, {
      cutoffDate: '2026-10-10', dueDate: '2026-10-25', periodTotal: '100.00', minimumPayment: '150.00',
    });
    expect(stMin.status).toBe(422);

    // Tarjeta archivada rechaza nuevos estados de cuenta → 422 ACCOUNT_ARCHIVED
    expect((await api.post(u.token, `/accounts/${visa.id}/archive`, {})).status).toBe(200);
    const stArch = await api.post(u.token, `/accounts/${visa.id}/statements`, {
      cutoffDate: '2026-10-10', dueDate: '2026-10-25', periodTotal: '100.00', minimumPayment: '20.00',
    });
    expect(stArch.status).toBe(422);
    expect(stArch.body.error.code).toBe('ACCOUNT_ARCHIVED');
  });

  it('expone Content-Disposition en Access-Control-Expose-Headers para orígenes CORS permitidos', async () => {
    const res = await api.call({ method: 'GET', url: '/healthz', headers: { origin: 'http://localhost:8081' } });
    expect(res.status).toBe(200);
    expect(String(res.headers['access-control-expose-headers'])).toContain('Content-Disposition');
  });
});
