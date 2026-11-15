import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createResendInbox, htmlToText, InboundError, verifySvix } from '../../src/infra/resend-inbound.js';

const SECRET = 'whsec_' + Buffer.from('clave-de-prueba-del-webhook-1234').toString('base64');
const NOW = 1_800_000_000_000;
const firmar = (id: string, ts: number, payload: string, secret = SECRET) =>
  'v1,' + createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64')).update(`${id}.${ts}.${payload}`).digest('base64');

describe('firma del aviso (Svix)', () => {
  const payload = '{"type":"email.received","data":{"email_id":"abc"}}';
  const ts = NOW / 1000;
  const ok = (signature: string, extra: Partial<Parameters<typeof verifySvix>[0]> = {}) =>
    verifySvix({ secret: SECRET, payload, nowMs: NOW, headers: { id: 'msg_1', timestamp: String(ts), signature }, ...extra });

  it('acepta una firma válida', () => {
    expect(ok(firmar('msg_1', ts, payload))).toBe(true);
  });

  it('acepta si una de varias firmas coincide (rotación del secreto)', () => {
    expect(ok(`v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${firmar('msg_1', ts, payload)}`)).toBe(true);
  });

  it('rechaza cuerpo alterado, secreto equivocado y cabeceras faltantes', () => {
    expect(ok(firmar('msg_1', ts, payload + ' '))).toBe(false);
    expect(ok(firmar('msg_1', ts, payload, 'whsec_' + Buffer.from('otro-secreto-completamente-distinto').toString('base64')))).toBe(false);
    expect(ok('')).toBe(false);
    expect(verifySvix({ secret: SECRET, payload, nowMs: NOW, headers: {} })).toBe(false);
    expect(ok('v2,' + firmar('msg_1', ts, payload).slice(3))).toBe(false); // versión desconocida
  });

  it('rechaza avisos viejos o del futuro (más de 5 minutos)', () => {
    expect(ok(firmar('msg_1', ts - 301, payload), { headers: { id: 'msg_1', timestamp: String(ts - 301), signature: firmar('msg_1', ts - 301, payload) } })).toBe(false);
    expect(ok(firmar('msg_1', ts + 301, payload), { headers: { id: 'msg_1', timestamp: String(ts + 301), signature: firmar('msg_1', ts + 301, payload) } })).toBe(false);
    expect(ok(firmar('msg_1', ts - 299, payload), { headers: { id: 'msg_1', timestamp: String(ts - 299), signature: firmar('msg_1', ts - 299, payload) } })).toBe(true);
  });
});

describe('texto de un correo en HTML', () => {
  it('quita estilos y etiquetas, conserva los saltos y decodifica entidades', () => {
    const html = '<html><head><style>.x{color:red}</style></head><body><p>Hola&nbsp;Rosa</p><table><tr><td>Monto:</td><td>S/&nbsp;25.50</td></tr><tr><td>Comercio</td><td>Caf&eacute; &amp; Pan</td></tr></table><script>alert(1)</script></body></html>';
    expect(htmlToText(html)).toBe('Hola Rosa\nMonto: S/ 25.50\nComercio Café & Pan');
  });
});

describe('cliente de la API de Resend', () => {
  const resp = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it('lee el correo y los adjuntos con la clave, y descarga sin enviarla', async () => {
    const llamadas: Array<{ url: string; auth?: string }> = [];
    const f = (async (url: string, init?: RequestInit) => {
      llamadas.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.authorization });
      if (url.includes('/attachments')) return resp({ data: [{ id: 'a1', filename: 'constancia.pdf', content_type: 'application/pdf', size: 3, download_url: 'https://cdn.example/a1' }] });
      if (url.startsWith('https://cdn.example')) return new Response(Buffer.from([1, 2, 3]));
      return resp({ id: 'e1', from: 'notificaciones@yape.pe', to: ['gastos.rosa-abc@in.eva-app.lat'], subject: 'Constancia', text: 'hola', message_id: '<m@y>', headers: { from: 'Yape <notificaciones@yape.pe>' } });
    }) as unknown as typeof fetch;
    const inbox = createResendInbox({ apiKey: 're_receive_key_de_prueba', fetchFn: f });
    const mail = await inbox.getEmail('e1');
    expect(mail).toMatchObject({ id: 'e1', to: ['gastos.rosa-abc@in.eva-app.lat'], fromHeader: 'Yape <notificaciones@yape.pe>', messageId: '<m@y>' });
    const [att] = await inbox.listAttachments('e1');
    expect(att).toMatchObject({ filename: 'constancia.pdf', contentType: 'application/pdf', size: 3 });
    expect([...(await inbox.download(att!.downloadUrl, 1000))]).toEqual([1, 2, 3]);
    expect(llamadas[0]).toMatchObject({ url: 'https://api.resend.com/emails/receiving/e1?html_format=cid', auth: 'Bearer re_receive_key_de_prueba' });
    expect(llamadas[2]!.auth).toBeUndefined();
  });

  it('un rechazo de Resend o un adjunto enorme se vuelven InboundError', async () => {
    const malo = createResendInbox({ apiKey: 're_receive_key_de_prueba', fetchFn: (async () => resp({}, 403)) as unknown as typeof fetch });
    const e = await malo.getEmail('x').catch((x: Error) => x);
    expect(e).toBeInstanceOf(InboundError);
    expect((e as Error).message).toContain('403');
    expect((e as Error).message).not.toContain('re_receive');
    const grande = createResendInbox({ apiKey: 're_receive_key_de_prueba', fetchFn: (async () => new Response(Buffer.alloc(50))) as unknown as typeof fetch });
    await expect(grande.download('https://cdn.example/x', 10)).rejects.toBeInstanceOf(InboundError);
  });
});
