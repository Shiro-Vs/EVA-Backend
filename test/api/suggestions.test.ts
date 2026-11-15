import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MailError, type MailMessage, type Mailer } from '../../src/infra/mail.js';
import { makeApi } from '../helpers/api.js';
import { pool } from '../helpers/db.js';

afterAll(() => pool.end());

const sent: MailMessage[] = [];
let failNext = false;
const mailer: Mailer = { async send(m) { if (failNext) { failNext = false; throw new MailError('caído', 503); } sent.push(m); } };
const env = { SUGGESTIONS_TO: 'robert.vs@outlook.com' };
beforeEach(() => { sent.length = 0; failNext = false; });

const body = (over: Record<string, unknown> = {}) => ({ kind: 'idea', message: 'Me gustaría ver los gastos por semana', appVersion: '1.0.0', platform: 'android 14', ...over });

describe('POST /v1/suggestions', () => {
  it('envía el correo al desarrollador con el nombre y el correo de la cuenta y responde sent:true', async () => {
    const api = makeApi({ mailer, env });
    const u = await api.newUser('Rosa Pérez');
    const r = await api.post(u.token, '/suggestions', body());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'robert.vs@outlook.com', subject: 'Sugerencia de Rosa Pérez · Idea' });
    expect(sent[0]!.replyTo).toMatch(/@test\.local$/);
    expect(sent[0]!.html).toContain('Me gustaría ver los gastos por semana');
    expect(sent[0]!.html).toContain(u.id);
    await api.app.close();
  });

  it('exige sesión', async () => {
    const api = makeApi({ mailer, env });
    expect((await api.call({ method: 'POST', url: '/v1/suggestions', body: body() })).status).toBe(401);
    expect(sent).toHaveLength(0);
    await api.app.close();
  });

  it('valida: tipo conocido, mensaje de 5 a 2000 caracteres y sin campos extra', async () => {
    const api = makeApi({ mailer, env });
    const u = await api.newUser();
    for (const bad of [{ kind: 'queja' }, { message: 'hey' }, { message: 'x'.repeat(2001) }, { message: '     ' }, { extra: 1 }]) {
      expect((await api.post(u.token, '/suggestions', body(bad))).status).toBe(422);
    }
    expect(sent).toHaveLength(0);
    await api.app.close();
  });

  it('limita a 5 por hora por persona y vuelve a permitir pasada la hora', async () => {
    const api = makeApi({ mailer, env });
    const u = await api.newUser();
    const other = await api.newUser('Otra persona');
    for (let i = 0; i < 5; i++) expect((await api.post(u.token, '/suggestions', body())).status).toBe(200);
    const sixth = await api.post(u.token, '/suggestions', body());
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('RATE_LIMITED');
    expect((await api.post(other.token, '/suggestions', body())).status).toBe(200); // el límite es por persona
    api.setNow(new Date(Date.now() + 2 * 3_600_000));
    expect((await api.post(u.token, '/suggestions', body())).status).toBe(200);
    await api.app.close();
  });

  it('si el correo falla responde 502 y no cuenta contra el límite', async () => {
    const api = makeApi({ mailer, env });
    const u = await api.newUser();
    failNext = true;
    const r = await api.post(u.token, '/suggestions', body());
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('MAIL_FAILED');
    for (let i = 0; i < 5; i++) expect((await api.post(u.token, '/suggestions', body())).status).toBe(200);
    await api.app.close();
  });

  it('sin correo configurado responde 503 con un mensaje útil', async () => {
    const api = makeApi({});
    const u = await api.newUser();
    const r = await api.post(u.token, '/suggestions', body());
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('SUGGESTIONS_UNAVAILABLE');
    await api.app.close();
  });
});
