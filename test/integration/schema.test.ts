import { describe, expect, it, afterAll } from 'vitest';
import {
  allocate, attempt, flush, mkAccount, mkCharge, mkContact, mkCycle, mkOperation, mkReceipt, mkSeat,
  mkSubscription, mkUser, pool, withTx,
} from '../helpers/db.js';

afterAll(() => pool.end());

describe('Inmutabilidad (M08)', () => {
  it('un asiento no se puede modificar ni borrar', () =>
    withTx(async (c) => {
      const u = await mkUser(c);
      const acc = await mkAccount(c, u);
      await mkOperation(c, u, acc, 'opening', '200.00');
      const upd = await attempt(c, () => c.query('update account_entry set amount = 1'));
      const del = await attempt(c, () => c.query('delete from account_entry'));
      expect(upd?.message).toMatch(/IMMUTABLE_ROW/);
      expect(del?.message).toMatch(/IMMUTABLE_ROW/);
    }));

  it('un evento de auditoría no se puede modificar ni borrar', () =>
    withTx(async (c) => {
      const u = await mkUser(c);
      await c.query(
        `insert into audit_event (owner_id, actor_id, action, entity_type, entity_id) values ($1, $1, 'x', 'y', gen_random_uuid())`,
        [u],
      );
      const upd = await attempt(c, () => c.query(`update audit_event set action = 'z'`));
      expect(upd?.message).toMatch(/IMMUTABLE_ROW/);
    }));
});

describe('Equilibrio de operaciones (M09)', () => {
  it('una transferencia que suma cero se acepta', () =>
    withTx(async (c) => {
      const u = await mkUser(c);
      const a = await mkAccount(c, u, 'bank', 'BCP');
      const b = await mkAccount(c, u, 'credit', 'Tarjeta');
      const op = '00000000-0000-4000-8000-000000000001';
      await c.query(
        `insert into financial_operation (id, owner_id, kind, occurred_on, created_by) values ($1, $2, 'transfer', '2026-10-12', $2)`,
        [op, u],
      );
      await c.query(`insert into account_entry (owner_id, operation_id, account_id, amount) values ($1,$2,$3,-47.00),($1,$2,$4,47.00)`, [u, op, a, b]);
      await flush(c);
    }));

  it('una transferencia desbalanceada se rechaza al confirmar', () =>
    withTx(async (c) => {
      const u = await mkUser(c);
      const a = await mkAccount(c, u, 'bank', 'BCP');
      const b = await mkAccount(c, u, 'cash', 'Efectivo');
      const err = await attempt(c, async () => {
        const op = '00000000-0000-4000-8000-000000000002';
        await c.query(
          `insert into financial_operation (id, owner_id, kind, occurred_on, created_by) values ($1, $2, 'transfer', '2026-10-12', $2)`,
          [op, u],
        );
        await c.query(`insert into account_entry (owner_id, operation_id, account_id, amount) values ($1,$2,$3,-50.00),($1,$2,$4,40.00)`, [u, op, a, b]);
        await flush(c);
      });
      expect(err?.message).toMatch(/OPERATION_TRANSFER_UNBALANCED/);
    }));

  it('un ingreso con importe negativo y un gasto positivo se rechazan', () =>
    withTx(async (c) => {
      const u = await mkUser(c);
      const a = await mkAccount(c, u);
      const bad1 = await attempt(c, async () => {
        await mkOperation(c, u, a, 'income', '-5.00');
        await flush(c);
      });
      const bad2 = await attempt(c, async () => {
        await mkOperation(c, u, a, 'expense', '5.00');
        await flush(c);
      });
      expect(bad1?.message).toMatch(/OPERATION_INCOME_NOT_POSITIVE/);
      expect(bad2?.message).toMatch(/OPERATION_EXPENSE_NOT_NEGATIVE/);
    }));

  it('una apertura admite un solo asiento', () =>
    withTx(async (c) => {
      const u = await mkUser(c);
      const a = await mkAccount(c, u);
      const op = await mkOperation(c, u, a, 'opening', '200.00');
      const err = await attempt(c, async () => {
        await c.query(`insert into account_entry (owner_id, operation_id, account_id, amount) values ($1,$2,$3,10.00)`, [u, op, a]);
        await flush(c);
      });
      expect(err?.message).toMatch(/OPERATION_SINGLE_ENTRY_REQUIRED/);
    }));

  it('una reversión exige operación de origen y motivo', () =>
    withTx(async (c) => {
      const u = await mkUser(c);
      const err = await attempt(c, () =>
        c.query(`insert into financial_operation (owner_id, kind, occurred_on, created_by) values ($1, 'reversal', '2026-10-12', $1)`, [u]),
      );
      expect(err?.code).toBe('23514');
    }));
});

describe('Aislamiento entre propietarios (A27, a nivel de base)', () => {
  it('no se puede referenciar un contacto de otro usuario', () =>
    withTx(async (c) => {
      const u1 = await mkUser(c, 'U1');
      const u2 = await mkUser(c, 'U2');
      const contactU1 = await mkContact(c, u1);
      const err = await attempt(c, () =>
        c.query(
          `insert into financial_operation (owner_id, kind, occurred_on, created_by, contact_id) values ($1, 'income', '2026-10-12', $1, $2)`,
          [u2, contactU1],
        ),
      );
      expect(err?.code).toBe('23503');
    }));

  it('no se puede aplicar un cobro de U2 a una obligación de U1', () =>
    withTx(async (c) => {
      const u1 = await mkUser(c, 'U1');
      const u2 = await mkUser(c, 'U2');
      const ana1 = await mkContact(c, u1);
      const ana2 = await mkContact(c, u2);
      const sub = await mkSubscription(c, u1);
      const cyc = await mkCycle(c, u1, sub, 1, '2026-10-07', '2026-11-07');
      const { seatId } = await mkSeat(c, u1, sub, ana1);
      const obl = await mkCharge(c, u1, ana1, seatId, cyc);
      const acc2 = await mkAccount(c, u2);
      const { receiptId } = await mkReceipt(c, u2, ana2, acc2, '20.00');
      const err = await attempt(c, () => allocate(c, u2, receiptId, obl, '20.00'));
      expect(err?.code).toBe('23503');
    }));
});

describe('Calendario y ciclos (M04, M05, M07)', () => {
  it('ciclos contiguos son válidos; superpuestos o duplicados se rechazan', () =>
    withTx(async (c) => {
      const u = await mkUser(c);
      const sub = await mkSubscription(c, u);
      await mkCycle(c, u, sub, 1, '2026-10-07', '2026-11-07');
      await mkCycle(c, u, sub, 2, '2026-11-07', '2026-12-07'); // contiguo: OK
      const overlap = await attempt(c, () => mkCycle(c, u, sub, 3, '2026-11-20', '2026-12-20'));
      const duplicate = await attempt(c, () => mkCycle(c, u, sub, 4, '2026-10-07', '2026-10-20'));
      expect(overlap?.code).toBe('23P01');
      expect(['23P01', '23505']).toContain(duplicate?.code);
    }));

  it('las vigencias de términos no se superponen', () =>
    withTx(async (c) => {
      const u = await mkUser(c);
      const sub = await mkSubscription(c, u);
      const ins = (from: string, to: string | null) =>
        c.query(
          `insert into subscription_terms (owner_id, subscription_id, valid_from, valid_to, announced_price, interval_unit, interval_count, anchor_date, created_by)
           values ($1, $2, $3, $4, 45.00, 'month', 1, '2026-10-07', $1)`,
          [u, sub, from, to],
        );
      await ins('2026-10-07', '2026-12-01');
      await ins('2026-12-01', null); // contigua: OK
      const err = await attempt(c, () => ins('2026-11-15', '2027-01-01'));
      expect(err?.code).toBe('23P01');
    }));

  it('un cargo por plaza y ciclo (M07)', () =>
    withTx(async (c) => {
      const u = await mkUser(c);
      const ana = await mkContact(c, u);
      const sub = await mkSubscription(c, u);
      const cyc = await mkCycle(c, u, sub, 1, '2026-10-07', '2026-11-07');
      const { seatId } = await mkSeat(c, u, sub, ana);
      await mkCharge(c, u, ana, seatId, cyc);
      const err = await attempt(c, () => mkCharge(c, u, ana, seatId, cyc));
      expect(err?.code).toBe('23505');
    }));

  it('un contacto puede tener dos plazas en una participación, pero no dos participaciones activas (A02)', () =>
    withTx(async (c) => {
      const u = await mkUser(c);
      const ana = await mkContact(c, u);
      const sub = await mkSubscription(c, u);
      const { membershipId } = await mkSeat(c, u, sub, ana, 'Cuenta 1');
      await c.query(
        `insert into seat (owner_id, membership_id, subscription_id, label, start_date) values ($1,$2,$3,'Cuenta 2','2026-10-07')`,
        [u, membershipId, sub],
      );
      const dup = await attempt(c, () => mkSeat(c, u, sub, ana, 'Otra'));
      expect(dup?.code).toBe('23505');
    }));

  it('un servicio personal solo admite capacidad 1', () =>
    withTx(async (c) => {
      const u = await mkUser(c);
      const err = await attempt(c, () => mkSubscription(c, u, 2, 'personal'));
      expect(err?.code).toBe('23514');
    }));
});

describe('Aplicaciones y cobros (M10, A06, A07, A09)', () => {
  it('Σ aplicaciones no puede superar el cobro', () =>
    withTx(async (c) => {
      const u = await mkUser(c);
      const ana = await mkContact(c, u);
      const acc = await mkAccount(c, u);
      const sub = await mkSubscription(c, u);
      const c1 = await mkCycle(c, u, sub, 1, '2026-10-07', '2026-11-07');
      const c2 = await mkCycle(c, u, sub, 2, '2026-11-07', '2026-12-07');
      const { seatId } = await mkSeat(c, u, sub, ana);
      const o1 = await mkCharge(c, u, ana, seatId, c1, '40.00');
      const o2 = await mkCharge(c, u, ana, seatId, c2, '40.00');
      const { receiptId } = await mkReceipt(c, u, ana, acc, '60.00');
      await allocate(c, u, receiptId, o1, '40.00');
      await flush(c); // 40 ≤ 60: OK
      const err = await attempt(c, async () => {
        await allocate(c, u, receiptId, o2, '30.00'); // 70 > 60
        await flush(c);
      });
      expect(err?.message).toMatch(/ALLOCATION_EXCEEDS_RECEIPT/);
    }));

  it('una aplicación no puede superar el pendiente del cargo', () =>
    withTx(async (c) => {
      const u = await mkUser(c);
      const ana = await mkContact(c, u);
      const acc = await mkAccount(c, u);
      const sub = await mkSubscription(c, u);
      const cyc = await mkCycle(c, u, sub, 1, '2026-10-07', '2026-11-07');
      const { seatId } = await mkSeat(c, u, sub, ana);
      const o1 = await mkCharge(c, u, ana, seatId, cyc, '20.00');
      const { receiptId } = await mkReceipt(c, u, ana, acc, '60.00');
      const err = await attempt(c, async () => {
        await allocate(c, u, receiptId, o1, '25.00');
        await flush(c);
      });
      expect(err?.message).toMatch(/ALLOCATION_EXCEEDS_OBLIGATION/);
    }));

  it('el cobro y el cargo deben ser del mismo contacto', () =>
    withTx(async (c) => {
      const u = await mkUser(c);
      const ana = await mkContact(c, u, 'Ana');
      const beto = await mkContact(c, u, 'Beto');
      const acc = await mkAccount(c, u);
      const sub = await mkSubscription(c, u);
      const cyc = await mkCycle(c, u, sub, 1, '2026-10-07', '2026-11-07');
      const { seatId } = await mkSeat(c, u, sub, beto);
      const oBeto = await mkCharge(c, u, beto, seatId, cyc, '20.00');
      const { receiptId } = await mkReceipt(c, u, ana, acc, '20.00');
      const err = await attempt(c, async () => {
        await allocate(c, u, receiptId, oBeto, '20.00');
        await flush(c);
      });
      expect(err?.message).toMatch(/ALLOCATION_CONTACT_MISMATCH/);
    }));

  it('dos cobros parciales cubren un cargo de 20.00 sin crear ingresos extra (A06)', () =>
    withTx(async (c) => {
      const u = await mkUser(c);
      const ana = await mkContact(c, u);
      const acc = await mkAccount(c, u);
      await mkOperation(c, u, acc, 'opening', '200.00');
      const sub = await mkSubscription(c, u);
      const cyc = await mkCycle(c, u, sub, 1, '2026-10-07', '2026-11-07');
      const { seatId } = await mkSeat(c, u, sub, ana);
      const obl = await mkCharge(c, u, ana, seatId, cyc, '20.00');

      const r1 = await mkReceipt(c, u, ana, acc, '10.00');
      await allocate(c, u, r1.receiptId, obl, '10.00');
      await flush(c);
      let st = (await c.query(`select pending_amount, payment_status from v_charge_status where obligation_id = $1`, [obl])).rows[0];
      expect(st).toEqual({ pending_amount: '10.00', payment_status: 'partial' });

      const r2 = await mkReceipt(c, u, ana, acc, '10.00');
      await allocate(c, u, r2.receiptId, obl, '10.00');
      await flush(c);
      st = (await c.query(`select pending_amount, payment_status from v_charge_status where obligation_id = $1`, [obl])).rows[0];
      expect(st).toEqual({ pending_amount: '0.00', payment_status: 'paid' });

      const bal = (await c.query(`select balance from v_account_balance where account_id = $1`, [acc])).rows[0];
      expect(bal.balance).toBe('220.00'); // 200 + 10 + 10
      const ops = (await c.query(`select count(*)::int as n from financial_operation where kind = 'income'`)).rows[0];
      expect(ops.n).toBe(2); // las aplicaciones no crean ingresos
    }));

  it('tramo gratis: neto 0 y estado exento (A03)', () =>
    withTx(async (c) => {
      const u = await mkUser(c);
      const beto = await mkContact(c, u);
      const sub = await mkSubscription(c, u);
      const cyc = await mkCycle(c, u, sub, 1, '2026-10-07', '2026-11-07');
      const { seatId } = await mkSeat(c, u, sub, beto);
      const obl = await mkCharge(c, u, beto, seatId, cyc, '4.00', '4.00');
      const st = (await c.query(`select issued_amount, pending_amount, payment_status from v_charge_status where obligation_id = $1`, [obl])).rows[0];
      expect(st).toEqual({ issued_amount: '0.00', pending_amount: '0.00', payment_status: 'exempt' });
    }));

  it('disponibilidad del cobro con aplicación, reserva y devolución (A09)', () =>
    withTx(async (c) => {
      const u = await mkUser(c);
      const ana = await mkContact(c, u);
      const acc = await mkAccount(c, u);
      const sub = await mkSubscription(c, u);
      const cyc = await mkCycle(c, u, sub, 1, '2026-10-07', '2026-11-07');
      const { seatId } = await mkSeat(c, u, sub, ana);
      const obl = await mkCharge(c, u, ana, seatId, cyc, '20.00');
      const { receiptId } = await mkReceipt(c, u, ana, acc, '30.00');
      await allocate(c, u, receiptId, obl, '20.00');
      await c.query(`insert into credit_reservation (owner_id, receipt_id, target_subscription_id, amount) values ($1,$2,$3,10.00)`, [u, receiptId, sub]);
      await flush(c);

      const row = async () => (await c.query(`select received, applied, unapplied, reserved, free from v_receipt_availability where receipt_id = $1`, [receiptId])).rows[0];
      expect(await row()).toEqual({ received: '30.00', applied: '20.00', unapplied: '10.00', reserved: '10.00', free: '0.00' });

      // Trasladar la reserva a otro servicio no cambia el crédito total del cobro.
      const sub2 = await mkSubscription(c, u);
      await c.query(`update credit_reservation set target_subscription_id = $1 where receipt_id = $2`, [sub2, receiptId]);
      expect(await row()).toEqual({ received: '30.00', applied: '20.00', unapplied: '10.00', reserved: '10.00', free: '0.00' });

      // Una devolución programada compromete el crédito (D-11).
      await c.query(`update credit_reservation set status = 'released' where receipt_id = $1`, [receiptId]);
      await c.query(`insert into refund (owner_id, receipt_id, contact_id, amount, reason) values ($1,$2,$3,4.00,'prueba')`, [u, receiptId, ana]);
      expect(await row()).toEqual({ received: '30.00', applied: '20.00', unapplied: '6.00', reserved: '0.00', free: '6.00' });
    }));

  it('un cobro corresponde a una sola operación', () =>
    withTx(async (c) => {
      const u = await mkUser(c);
      const ana = await mkContact(c, u);
      const acc = await mkAccount(c, u);
      const { opId } = await mkReceipt(c, u, ana, acc, '10.00');
      const err = await attempt(c, () =>
        c.query(`insert into receipt (owner_id, contact_id, operation_id, amount, received_on) values ($1,$2,$3,10.00,'2026-10-12')`, [u, ana, opId]),
      );
      expect(err?.code).toBe('23505');
    }));
});

describe('Pago al proveedor', () => {
  it('un ciclo admite un solo pago activo; tras revertir se puede registrar otro (A14)', () =>
    withTx(async (c) => {
      const u = await mkUser(c);
      const acc = await mkAccount(c, u);
      const sub = await mkSubscription(c, u);
      const cyc = await mkCycle(c, u, sub, 1, '2026-10-07', '2026-11-07');
      const pay = async (amount: string) => {
        const op = await mkOperation(c, u, acc, 'expense', `-${amount}`);
        await c.query(
          `insert into supplier_payment (owner_id, cycle_id, operation_id, amount_real, announced_price_snapshot, paid_on)
           values ($1,$2,$3,$4,45.00,'2026-10-10')`,
          [u, cyc, op, amount],
        );
      };
      await pay('47.00');
      const dup = await attempt(c, () => pay('47.00'));
      expect(dup?.code).toBe('23505');
      await c.query(`update supplier_payment set status = 'reversed' where cycle_id = $1`, [cyc]);
      await pay('46.00'); // permitido tras la reversión
    }));
});
