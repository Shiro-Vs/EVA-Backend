import { at, get, must, post, confirmed, pool } from './kit.js';

at('2026-05-01');
await must('me', get('/me'));
const acc = await must('cuenta', post('/accounts', { name: 'BCP Sueldo', type: 'bank', openingBalance: { amount: '2300.00', date: '2026-05-01' } }));
const c = await must('contacto', post('/contacts', { name: 'Ana' }));
at('2026-05-07');
const svc = await confirmed('servicio', '/subscriptions/preview', '/subscriptions', { name: 'Netflix', provider: 'Netflix', mode: 'shared', capacity: 4, announcedPrice: '44.90', interval: { unit: 'month', count: 1 }, startDate: '2026-05-07', nextPaymentDate: '2026-06-07' });
const seat = await confirmed('plaza', `/subscriptions/${svc.id}/seats/preview`, `/subscriptions/${svc.id}/seats`, { contactId: c.id, label: 'Ana', quota: '11.25', joinDate: '2026-05-07' });
console.log('SERVICIO', JSON.stringify(svc).slice(0, 700));
console.log('PLAZA', JSON.stringify(seat).slice(0, 900));
at('2026-06-12');
const cyc = await must('ciclos', get(`/subscriptions/${svc.id}/cycles`));
console.log('CICLOS', JSON.stringify(cyc).slice(0, 900));
const s2 = await must('plaza2', get(`/seats/${seat.id}`));
console.log('PLAZA2', JSON.stringify(s2).slice(0, 1200));
console.log('ACC', JSON.stringify(acc).slice(0, 300));
await pool.end();
