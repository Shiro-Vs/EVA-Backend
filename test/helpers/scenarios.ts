import { expect } from 'vitest';
import type { Api } from './api.js';

export const NETFLIX = {
  name: 'Netflix', provider: 'Netflix', mode: 'shared', capacity: 4, announcedPrice: '45.00',
  interval: { unit: 'month', count: 1 }, startDate: '2026-10-07', nextPaymentDate: '2026-11-07',
};

export async function createService(api: Api, token: string, over: Record<string, unknown> = {}) {
  const body = { ...NETFLIX, ...over };
  const pv = await api.post(token, '/subscriptions/preview', body);
  expect(pv.status, JSON.stringify(pv.body)).toBe(200);
  const r = await api.post(token, '/subscriptions', { ...body, previewToken: pv.body.previewToken });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

export async function createContact(api: Api, token: string, name: string) {
  const r = await api.post(token, '/contacts', { name });
  expect(r.status).toBe(201);
  return r.body;
}

export async function createAccount(api: Api, token: string, name = 'BCP', opening = '200.00', type = 'bank') {
  const r = await api.post(token, '/accounts', { name, type, openingBalance: { amount: opening, date: '2026-10-01' } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

export async function setDefaultFreeDays(api: Api, token: string, days: number) {
  const me = (await api.get(token, '/me')).body;
  const r = await api.patch(token, '/me', { defaultFreeDays: days }, me.version);
  expect(r.status).toBe(200);
}

export interface SeatOpts { label?: string; quota: string; joinDate?: string; freeDaysThreshold?: number | null }

/** Vista previa + alta; devuelve la respuesta del alta (puede ser un error). */
export async function joinSeat(api: Api, token: string, subscriptionId: string, contactId: string, o: SeatOpts) {
  const body = { contactId, label: o.label ?? 'Cuenta 1', quota: o.quota, ...(o.joinDate ? { joinDate: o.joinDate } : {}), ...(o.freeDaysThreshold !== undefined ? { freeDaysThreshold: o.freeDaysThreshold } : {}) };
  const pv = await api.post(token, `/subscriptions/${subscriptionId}/seats/preview`, body);
  if (pv.status !== 200) return pv;
  return api.post(token, `/subscriptions/${subscriptionId}/seats`, { ...body, previewToken: pv.body.previewToken });
}
