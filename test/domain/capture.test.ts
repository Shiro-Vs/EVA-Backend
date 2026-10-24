import { describe, expect, it } from 'vitest';
import { contentHash, dayDistance, duplicateReason, extractionSchema, inboxAddressFor, missingForAccept } from '../../src/domain/capture.js';

describe('Dirección de recepción (07 §3)', () => {
  it('tiene el formato gastos.{nombre}-{hash3}@dominio y es estable', () => {
    const a = inboxAddressFor('11111111-1111-1111-1111-111111111111', 'María Pérez', 'eva.app', 0);
    expect(a).toMatch(/^gastos\.mariaperez-[0-9a-f]{3}@eva\.app$/);
    expect(inboxAddressFor('11111111-1111-1111-1111-111111111111', 'María Pérez', 'eva.app', 0)).toBe(a);
  });
  it('rotar cambia el sufijo sin depender del nombre', () => {
    const id = '22222222-2222-2222-2222-222222222222';
    expect(inboxAddressFor(id, 'Ana', 'eva.app', 1)).not.toBe(inboxAddressFor(id, 'Ana', 'eva.app', 0));
    expect(inboxAddressFor(id, 'Ana', 'eva.app', 0).split('-').pop()).toBe(inboxAddressFor(id, 'Otro nombre', 'eva.app', 0).split('-').pop());
  });
});

describe('Huella del contenido (RN-DU01)', () => {
  it('ignora diferencias de espacios y distingue contenidos distintos', () => {
    expect(contentHash({ text: 'Pagaste  S/ 10', subject: 'a' })).toBe(contentHash({ text: ' Pagaste S/ 10 ', subject: 'a' }));
    expect(contentHash({ text: 'Pagaste S/ 10' })).not.toBe(contentHash({ text: 'Pagaste S/ 11' }));
    expect(contentHash({ bytes: Buffer.from([1, 2, 3]) })).not.toBe(contentHash({ bytes: Buffer.from([1, 2, 4]) }));
  });
});

describe('Posible coincidencia (RN-DU02, D-23)', () => {
  const base = { amount: '10.00', occurredOn: '2026-10-10', operationRef: null, accountId: 'a1', channel: null };
  it('el mismo identificador de operación basta', () => {
    expect(duplicateReason({ ...base, operationRef: '99' }, { ...base, amount: '5.00', operationRef: '99' })).toBe('operation_ref');
  });
  it('mismo importe y cuenta con ≤ 1 día de diferencia', () => {
    expect(duplicateReason(base, { ...base, occurredOn: '2026-10-11' })).toBe('amount_account_window');
    expect(duplicateReason(base, { ...base, occurredOn: '2026-10-12' })).toBeNull();
  });
  it('importe y día iguales en otra cuenta NO bastan', () => {
    expect(duplicateReason(base, { ...base, accountId: 'a2' })).toBeNull();
  });
  it('sin cuenta, el mismo canal sirve; sin fecha no se compara', () => {
    const x = { ...base, accountId: null, channel: 'Yape' };
    expect(duplicateReason(x, { ...x, channel: 'yape' })).toBe('amount_account_window');
    expect(duplicateReason(x, { ...x, occurredOn: null })).toBeNull();
  });
  it('dayDistance cuenta días enteros', () => {
    expect(dayDistance('2026-03-01', '2026-02-28')).toBe(1);
  });
});

describe('Requisitos para aceptar (RN-CA06)', () => {
  const ok = { direction: 'expense', amount: '10.00', occurredOn: '2026-10-10', accountId: 'a', toAccountId: null, currency: 'PEN' };
  it('completo no falta nada; la categoría no se exige', () => expect(missingForAccept(ok)).toEqual([]));
  it('lista lo que falta', () => expect(missingForAccept({ ...ok, amount: null, occurredOn: null, accountId: null })).toEqual(['accountId', 'amount', 'occurredOn']));
  it('moneda distinta de PEN y transferencia sin destino', () => {
    expect(missingForAccept({ ...ok, currency: 'USD' })).toEqual(['currency']);
    expect(missingForAccept({ ...ok, direction: 'transfer' })).toEqual(['toAccountId']);
    expect(missingForAccept({ ...ok, direction: 'transfer', toAccountId: 'a' })).toEqual(['toAccountId']);
  });
});

describe('Esquema de extracción (07 §6)', () => {
  const valid = { documentType: 'payment_receipt', isTransaction: true, confidence: 0.9, movements: [{ direction: 'expense', amount: '10.25', currency: 'PEN', occurredOn: '2026-10-12', counterparty: 'Chifa', channel: 'Yape', operationId: '1', concept: null, suggestedCategory: null, items: [] }], missingFields: [], warnings: [] };
  it('acepta una extracción válida', () => expect(extractionSchema.safeParse(valid).success).toBe(true));
  it('rechaza importes con coma o decimales de más y fechas inexistentes', () => {
    expect(extractionSchema.safeParse({ ...valid, movements: [{ ...valid.movements[0], amount: '10,25' }] }).success).toBe(false);
    expect(extractionSchema.safeParse({ ...valid, movements: [{ ...valid.movements[0], amount: '10.255' }] }).success).toBe(false);
    expect(extractionSchema.safeParse({ ...valid, movements: [{ ...valid.movements[0], occurredOn: '2026-02-31' }] }).success).toBe(false);
  });
  it('rechaza tipos de documento o direcciones desconocidos', () => {
    expect(extractionSchema.safeParse({ ...valid, documentType: 'invoice' }).success).toBe(false);
    expect(extractionSchema.safeParse({ ...valid, movements: [{ ...valid.movements[0], direction: 'refund' }] }).success).toBe(false);
  });
});
