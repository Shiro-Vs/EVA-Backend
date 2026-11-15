import { createHmac } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createHeuristicExtractor } from '../../src/infra/capture/heuristic.js';
import { InboundError, type InboundInbox, type ReceivedAttachment, type ReceivedEmail } from '../../src/infra/resend-inbound.js';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';
import { createAccount } from '../helpers/scenarios.js';

afterAll(() => pool.end());

const SECRET = 'whsec_' + Buffer.from('clave-de-prueba-del-webhook-1234').toString('base64');
const YAPE = 'Yape: pagaste S/ 25.50 a Chifa Central el 2026-10-10. Número de operación 1234567';
const NOW = new Date('2026-10-12T17:00:00Z');

function fakeInbox(emails: Record<string, Partial<ReceivedEmail>>, attachments: Record<string, ReceivedAttachment[]> = {}, bytes = Buffer.from('%PDF-1.4 prueba')): InboundInbox & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    async getEmail(id) {
      fetched.push(id);
      const e = emails[id];
      if (!e) throw new InboundError('Resend respondió HTTP 404', 404);
      return { id, from: 'notificaciones@yape.pe', to: [], ...e } as ReceivedEmail;
    },
    async listAttachments(id) { return attachments[id] ?? []; },
    async download() { return bytes; },
  };
}

function setup(inbox: InboundInbox, withSecret = true) {
  const a = makeApi({ extractor: createHeuristicExtractor(), inbox, env: withSecret ? { RESEND_WEBHOOK_SECRET: SECRET } : {} });
  a.setNow(NOW);
  const send = (event: unknown, o: { id?: string; ts?: number; secret?: string } = {}) => {
    const payload = JSON.stringify(event);
    const id = o.id ?? 'msg_test';
    const ts = o.ts ?? NOW.getTime() / 1000;
    const sig = 'v1,' + createHmac('sha256', Buffer.from((o.secret ?? SECRET).replace(/^whsec_/, ''), 'base64')).update(`${id}.${ts}.${payload}`).digest('base64');
    return a.app.inject({ method: 'POST', url: '/webhooks/resend', payload, headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': sig } });
  };
  return { a, send };
}
const received = (emailId: string) => ({ type: 'email.received', created_at: '2026-10-12T16:59:00Z', data: { email_id: emailId } });

describe('POST /webhooks/resend', () => {
  it('sin secreto configurado la ruta no existe', async () => {
    const { a, send } = setup(fakeInbox({}), false);
    expect((await send(received('e1'))).statusCode).toBe(404);
    await a.app.close();
  });

  it('exige firma válida y reciente', async () => {
    const inbox = fakeInbox({ e1: { to: ['x@y.z'], text: YAPE } });
    const { a, send } = setup(inbox);
    expect((await send(received('e1'), { secret: 'whsec_' + Buffer.from('otro-secreto-completamente-distinto').toString('base64') })).statusCode).toBe(401);
    expect((await send(received('e1'), { ts: NOW.getTime() / 1000 - 3600 })).statusCode).toBe(401);
    expect((await a.app.inject({ method: 'POST', url: '/webhooks/resend', payload: '{}', headers: { 'content-type': 'application/json' } })).statusCode).toBe(401);
    expect(inbox.fetched).toEqual([]); // sin firma no se llama ni a Resend ni a la IA
    await a.app.close();
  });

  it('un correo a la dirección de recepción crea el documento del dueño, con el remitente completo, y se deduplica', async () => {
    const { a, send } = setup(fakeInbox({}));
    const u = await a.newUser('Rosa');
    await createAccount(a, u.token);
    const addr = (await a.get(u.token, '/capture/inbox-address')).body.address as string;
    const inbox = fakeInbox({ e1: { to: [`Rosa Gastos <${addr.toUpperCase()}>`], fromHeader: 'Yape <notificaciones@yape.pe>', subject: 'Constancia', text: YAPE, messageId: '<m1@yape.pe>' } });
    const { send: enviar, a: a2 } = (() => {
      const s = setup(inbox);
      return { send: s.send, a: s.a };
    })();
    // el mismo mundo (misma base): se reutiliza el usuario creado arriba
    const r = await enviar(received('e1'));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ accepted: true, duplicate: false });
    const again = await enviar(received('e1'), { id: 'msg_reintento' });
    expect(again.json()).toMatchObject({ accepted: true, duplicate: true });
    const docs = (await a.get(u.token, '/capture/documents')).body.items;
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ origin: 'email', sender: 'Yape <notificaciones@yape.pe>', subject: 'Constancia', status: 'proposed' });
    await a2.app.close();
    await a.app.close();
    void send;
  });

  it('un correo solo HTML se convierte en texto', async () => {
    const { a } = setup(fakeInbox({}));
    const u = await a.newUser('Luis');
    await createAccount(a, u.token);
    const addr = (await a.get(u.token, '/capture/inbox-address')).body.address as string;
    const s = setup(fakeInbox({ h1: { to: [addr], subject: 'Constancia', html: `<p>Yape:&nbsp;pagaste S/ 25.50 a Chifa Central el 2026-10-10.</p><p>N&uacute;mero de operaci&oacute;n 1234567</p>`, messageId: '<h1@yape.pe>' } }));
    const r = await s.send(received('h1'));
    expect(r.json()).toMatchObject({ accepted: true });
    const docs = (await a.get(u.token, '/capture/documents')).body.items;
    expect(docs).toHaveLength(1);
    expect(docs[0].status).toBe('proposed');
    await s.a.app.close();
    await a.app.close();
  });

  it('un PDF adjunto se descarga y se guarda como original del documento', async () => {
    const { a } = setup(fakeInbox({}));
    const u = await a.newUser('Ana');
    await createAccount(a, u.token);
    const addr = (await a.get(u.token, '/capture/inbox-address')).body.address as string;
    const att: ReceivedAttachment = { id: 'a1', filename: 'constancia.pdf', contentType: 'application/pdf', size: 15, downloadUrl: 'https://cdn.example/a1' };
    const s = setup(fakeInbox({ p1: { to: [addr], subject: 'Constancia', text: 'adjunto', messageId: '<p1@banco>' } }, { p1: [att] }));
    const r = await s.send(received('p1'));
    expect(r.json()).toMatchObject({ accepted: true });
    const docs = (await a.get(u.token, '/capture/documents')).body.items;
    expect(docs[0]).toMatchObject({ mime: 'application/pdf', filename: 'constancia.pdf' });
    await s.a.app.close();
    await a.app.close();
  });

  it('una dirección desconocida o revocada se ignora sin revelar nada', async () => {
    const { a } = setup(fakeInbox({}));
    const u = await a.newUser('Eva');
    const old = (await a.get(u.token, '/capture/inbox-address')).body.address as string;
    await a.post(u.token, '/capture/inbox-address/rotate');
    const s = setup(fakeInbox({ d1: { to: ['gastos.nadie-abc@in.eva-app.lat'], text: YAPE }, d2: { to: [old], text: YAPE, messageId: '<d2>' } }));
    expect((await s.send(received('d1'))).json()).toEqual({ accepted: false });
    expect((await s.send(received('d2'))).json()).toEqual({ accepted: false });
    expect((await a.get(u.token, '/capture/documents')).body.items).toEqual([]);
    await s.a.app.close();
    await a.app.close();
  });

  it('ignora otros eventos y, si Resend falla, responde 500 para que reintente', async () => {
    const s = setup(fakeInbox({}));
    expect((await s.send({ type: 'email.sent', data: { email_id: 'z' } })).json()).toEqual({ ignored: true });
    expect((await s.send(received('no-existe'))).statusCode).toBe(500);
    await s.a.app.close();
  });
});
