import { describe, expect, it, vi } from 'vitest';
import { buildSuggestionMail, escapeHtml } from '../../src/application/suggestions.js';
import { createResendMailer, MailError } from '../../src/infra/mail.js';

const NOW = new Date('2026-11-15T20:30:00Z');
const sender = { id: '11111111-2222-3333-4444-555555555555', name: 'Rosa Pérez', email: 'rosa@example.com' };

describe('correo de sugerencias', () => {
  it('dice quién la envió (nombre, correo y cuenta), el tipo, el mensaje, la versión y la fecha en hora de Lima', () => {
    const m = buildSuggestionMail('robert.vs@outlook.com', sender, { kind: 'idea', message: 'Agregar modo familia\ncon varios administradores', appVersion: '1.0.0', platform: 'android 14' }, NOW, 'America/Lima');
    expect(m.to).toBe('robert.vs@outlook.com');
    expect(m.subject).toBe('Sugerencia de Rosa Pérez · Idea');
    expect(m.replyTo).toBe('rosa@example.com');
    for (const piece of ['Rosa Pérez', 'rosa@example.com', sender.id, 'Idea', 'Agregar modo familia', 'Versión 1.0.0', 'android 14', '15 de noviembre de 2026']) {
      expect(m.html).toContain(piece);
      expect(m.text).toContain(piece);
    }
    expect(m.html).toContain('mailto:rosa@example.com');
    expect(m.html).toContain('3:30'); // 20:30 UTC = 15:30 en Lima
  });

  it('escapa el HTML del mensaje y del nombre: lo que escribe la gente no puede inyectar contenido', () => {
    const m = buildSuggestionMail('a@b.co', { id: 'x', name: '<img src=x onerror=alert(1)>', email: 'a"b@c.co' }, { kind: 'problem', message: '<script>alert("hola")</script> & más' }, NOW, 'America/Lima');
    expect(m.html).not.toContain('<script>');
    expect(m.html).not.toContain('<img');
    expect(m.html).toContain('&lt;script&gt;alert(&quot;hola&quot;)&lt;/script&gt; &amp; más');
    expect(m.html).toContain('mailto:a&quot;b@c.co');
  });

  it('sin nombre usa el correo; sin ninguno de los dos lo indica; el asunto nunca lleva saltos de línea', () => {
    expect(buildSuggestionMail('a@b.co', { id: 'x', email: 'solo@correo.com' }, { kind: 'other', message: 'hola mundo' }, NOW, 'America/Lima').subject).toBe('Sugerencia de solo@correo.com · Otro');
    const anon = buildSuggestionMail('a@b.co', { id: 'x' }, { kind: 'other', message: 'hola mundo' }, NOW, 'America/Lima');
    expect(anon.subject).toBe('Sugerencia de Alguien · Otro');
    expect(anon.html).toContain('sin correo en la cuenta');
    expect(anon.replyTo).toBeUndefined();
    expect(buildSuggestionMail('a@b.co', { id: 'x', name: 'Línea1\r\nBcc: x@y.z' }, { kind: 'idea', message: 'hola mundo' }, NOW, 'America/Lima').subject).not.toMatch(/[\r\n]/);
  });

  it('escapeHtml cubre los cinco caracteres peligrosos', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('envío con Resend', () => {
  const msg = { to: 'robert.vs@outlook.com', subject: 'Asunto', html: '<p>x</p>', text: 'x', replyTo: 'rosa@example.com' };

  it('llama a la API con la clave, el remitente y reply_to', async () => {
    const f = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    await createResendMailer({ apiKey: 're_clave_de_prueba', from: 'EVA <no-reply@eva-app.lat>', fetchFn: f as unknown as typeof fetch }).send(msg);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer re_clave_de_prueba');
    expect(JSON.parse(init.body as string)).toMatchObject({ from: 'EVA <no-reply@eva-app.lat>', to: ['robert.vs@outlook.com'], subject: 'Asunto', reply_to: 'rosa@example.com' });
  });

  it('un rechazo o una caída de red se vuelven MailError sin revelar la clave', async () => {
    const rejected = createResendMailer({ apiKey: 're_clave_de_prueba', from: 'x', fetchFn: (async () => new Response('{"message":"bad"}', { status: 403 })) as unknown as typeof fetch });
    const e1 = await rejected.send(msg).catch((e: Error) => e);
    expect(e1).toBeInstanceOf(MailError);
    expect((e1 as Error).message).toContain('403');
    expect((e1 as Error).message).not.toContain('re_clave');
    const down = createResendMailer({ apiKey: 're_clave_de_prueba', from: 'x', fetchFn: (async () => { throw new Error('red'); }) as unknown as typeof fetch });
    expect(await down.send(msg).catch((e: Error) => e)).toBeInstanceOf(MailError);
  });
});
