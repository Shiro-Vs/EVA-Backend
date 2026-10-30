// Datos de demostración: seis meses de vida financiera simulada (may–oct 2026) para probar TODAS las pantallas.
// Uso: npm run db:reset:dev && npm run seed:demo   (solo sobre eva_dev; entra con «Entrar en modo desarrollo»).
import { addDays, at, between, chance, confirmed, days, dow, fails, get, money, must, pick, pool, post, put, rnd, soft } from './kit.js';

const START = '2026-05-01';
const TODAY = '2026-10-29';
const day = (iso: string) => Number(iso.slice(8, 10));
const ym = (iso: string) => iso.slice(0, 7);

// ───────────────────────── Preparación ─────────────────────────
at(START);
await must('perfil', get('/me'));
const cats: Record<string, string> = {};
for (const c of (await must('categorías', get('/categories'))).items ?? (await must('categorías', get('/categories')))) { cats[c.name] = c.id; for (const k of c.children ?? []) cats[k.name] = k.id; }
async function cat(name: string, parent?: string, color?: string) {
  if (cats[name]) return cats[name]!;
  const r = await must(`categoría ${name}`, post('/categories', { name, ...(parent ? { parentId: cats[parent] } : {}), ...(color ? { color } : {}) }));
  cats[name] = r.id;
  return r.id as string;
}
for (const [n, p] of [['Supermercado', 'Comida'], ['Restaurantes', 'Comida'], ['Delivery', 'Comida'], ['Taxi y apps', 'Transporte'], ['Combustible', 'Transporte'], ['Transporte público', 'Transporte'],
  ['Alquiler', 'Hogar'], ['Luz', 'Hogar'], ['Agua', 'Hogar'], ['Internet y celular', 'Hogar'], ['Farmacia', 'Salud'], ['Consultas', 'Salud'], ['Salidas', 'Ocio'], ['Videojuegos', 'Ocio']] as const) await cat(n, p);
for (const n of ['Educación', 'Ropa', 'Mascotas', 'Sueldo', 'Freelance', 'Ventas', 'Regalos']) await cat(n);

const accounts: Record<string, { id: string }> = {};
async function account(key: string, body: Record<string, unknown>) { accounts[key] = await must(`cuenta ${key}`, post('/accounts', body)); return accounts[key]!; }
await account('bcp', { name: 'BCP Sueldo', type: 'bank', institution: 'BCP', color: '#0B5CAD', isDefault: true, openingBalance: { amount: '2300.00', date: START } });
await account('ibk', { name: 'Interbank Ahorros', type: 'savings', institution: 'Interbank', color: '#12A150', openingBalance: { amount: '9800.00', date: START } });
await account('cash', { name: 'Efectivo', type: 'cash', color: '#8A6D3B', openingBalance: { amount: '320.00', date: START } });
await account('yape', { name: 'Yape', type: 'wallet', institution: 'Yape', color: '#6F2DA8', openingBalance: { amount: '180.00', date: START } });
await account('visa', { name: 'Visa BBVA', type: 'credit', institution: 'BBVA', color: '#1464A5', openingBalance: { amount: '-350.00', date: START } });
await account('mc', { name: 'Mastercard Interbank', type: 'credit', institution: 'Interbank', color: '#EB5A1E', openingBalance: { amount: '-120.00', date: START } });
await must('visa detalle', post(`/accounts/${accounts.visa!.id}/credit-details`, { creditLine: '9000.00', cutoffDay: 20, dueDay: 10 }));
await must('mc detalle', post(`/accounts/${accounts.mc!.id}/credit-details`, { creditLine: '5000.00', cutoffDay: 5, dueDay: 25 }));
const A = (k: string) => accounts[k]!.id;

const contacts: Record<string, { id: string }> = {};
for (const [name, phone] of [['Ana Torres', '987 654 321'], ['Carlos Mendoza', '976 543 210'], ['Lucía Paredes', '965 432 109'], ['Miguel Rojas', '954 321 098'], ['Sofía Vargas', '943 210 987'], ['Diego Castillo', '932 109 876'], ['Valeria Quispe', '921 098 765'], ['Jorge Salazar', '910 987 654'], ['Raúl (tío)', '999 111 222'], ['Mamá', '999 333 444']] as const)
  contacts[name.split(' ')[0]!] = await must(`contacto ${name}`, post('/contacts', { name, phone }));
const C = (k: string) => contacts[k]!.id;

// Reglas de clasificación (las que ayudan a ordenar lo nuevo)
for (const [name, text, c, action] of [['Apps de taxi', 'uber', 'Taxi y apps', 'assign'], ['Cabify', 'cabify', 'Taxi y apps', 'assign'], ['Supermercados', 'plaza vea', 'Supermercado', 'assign'], ['Delivery', 'rappi', 'Delivery', 'suggest'], ['Farmacias', 'inkafarma', 'Farmacia', 'assign']] as const)
  await soft(`regla ${name}`, post('/classification-rules', { name, textContains: text, direction: 'expense', action, categoryId: cats[c] }));

// Presupuestos
for (const b of [
  { name: 'Comida del mes', categoryId: cats.Comida, includeSubcategories: true, period: 'monthly', limit: '1000.00', thresholds: [80, 100] },
  { name: 'Transporte', categoryId: cats.Transporte, includeSubcategories: true, period: 'monthly', limit: '260.00', thresholds: [80, 100], rollover: true },
  { name: 'Ocio y salidas', categoryId: cats.Ocio, includeSubcategories: true, period: 'monthly', limit: '320.00', thresholds: [75, 100] },
  { name: 'Minigastos semanales', categoryId: cats.Minigastos, period: 'weekly', limit: '60.00', thresholds: [100] },
  { name: 'Gasto total del mes', period: 'monthly', limit: '4800.00', thresholds: [90, 100] },
  { name: 'Tecnología del año', categoryId: cats['Tecnología'], period: 'yearly', limit: '5000.00', thresholds: [80] },
]) await soft(`presupuesto ${b.name}`, post('/budgets', { ...b, startsOn: START }));

// ───────────────────────── Servicios compartidos ─────────────────────────
type Svc = { id: string; name: string; price: string; pay: string; start: string };
const services: Svc[] = [];
const seatIds: Array<{ seatId: string; contact: string }> = [];
const SERVICES = [
  { name: 'Netflix Premium', provider: 'Netflix', capacity: 4, price: '44.90', start: '2026-05-07', pay: 'visa', cat: 'Servicios' },
  { name: 'Spotify Familiar', provider: 'Spotify', capacity: 6, price: '26.90', start: '2026-05-15', pay: 'visa', cat: 'Servicios' },
  { name: 'YouTube Premium Familia', provider: 'Google', capacity: 5, price: '29.90', start: '2026-05-20', pay: 'bcp', cat: 'Servicios' },
  { name: 'HBO Max', provider: 'Warner', capacity: 3, price: '32.90', start: '2026-05-25', pay: 'mc', cat: 'Servicios' },
  { name: 'Disney+', provider: 'Disney', capacity: 4, price: '38.90', start: '2026-06-03', pay: 'visa', cat: 'Servicios' },
  { name: 'ChatGPT Plus', provider: 'OpenAI', capacity: 2, price: '78.00', start: '2026-07-10', pay: 'visa', cat: 'Tecnología' },
  { name: 'iCloud 200 GB', provider: 'Apple', capacity: 1, price: '11.90', start: '2026-05-12', pay: 'visa', cat: 'Tecnología', personal: true },
  { name: 'Adobe Creative Cloud', provider: 'Adobe', capacity: 1, price: '89.90', start: '2026-05-12', pay: 'mc', cat: 'Tecnología', personal: true },
];
const SEATS: Array<[string, string, string, string]> = [ // servicio, contacto, cuota, ingreso
  ['Netflix Premium', 'Ana', '11.25', '2026-05-07'], ['Netflix Premium', 'Carlos', '11.25', '2026-05-07'], ['Netflix Premium', 'Lucía', '11.25', '2026-05-20'],
  ['Spotify Familiar', 'Ana', '4.50', '2026-05-15'], ['Spotify Familiar', 'Miguel', '4.50', '2026-05-15'], ['Spotify Familiar', 'Sofía', '4.50', '2026-07-01'], ['Spotify Familiar', 'Jorge', '4.50', '2026-06-10'],
  ['YouTube Premium Familia', 'Carlos', '6.00', '2026-05-20'], ['YouTube Premium Familia', 'Sofía', '6.00', '2026-05-22'], ['YouTube Premium Familia', 'Diego', '6.00', '2026-06-02'],
  ['HBO Max', 'Miguel', '11.00', '2026-05-25'], ['HBO Max', 'Jorge', '11.00', '2026-05-25'],
  ['Disney+', 'Lucía', '9.75', '2026-06-03'], ['Disney+', 'Diego', '9.75', '2026-06-03'], ['Disney+', 'Valeria', '9.75', '2026-08-10'],
  ['ChatGPT Plus', 'Valeria', '39.00', '2026-07-10'],
];

// Cómo paga cada persona: demora en días, desde cuándo deja de pagar y si paga por partes.
const HABIT: Record<string, { delay: number; stopFrom?: string; partial?: boolean; via: string }> = {
  Ana: { delay: 1, via: 'yape' }, Carlos: { delay: 5, via: 'bcp' }, Lucía: { delay: 2, via: 'yape' }, Miguel: { delay: 9, stopFrom: '2026-10-01', via: 'yape' },
  Sofía: { delay: 0, via: 'yape' }, Diego: { delay: 6, stopFrom: '2026-09-01', via: 'bcp' }, Valeria: { delay: 1, via: 'yape' }, Jorge: { delay: 3, partial: true, via: 'yape' },
};

const paidCycles = new Set<string>();
const pendingStatements: Array<{ id: string; card: string; due: string; amount: number }> = [];
const statementTotals: Record<string, number> = { visa: 0, mc: 0 };

// ───────────────────────── Plantillas recurrentes ─────────────────────────
const templates: Array<{ id: string; name: string }> = [];
async function template(name: string, kind: 'income' | 'expense', acc: string, amount: string, startDate: string, categoryName: string, description?: string) {
  const t = await soft(`plantilla ${name}`, post('/recurring/templates', { name, kind, accountId: A(acc), amount, categoryId: cats[categoryName], interval: { unit: 'month', count: 1 }, startDate, ...(description ? { description } : {}) }));
  if (t) templates.push({ id: t.id, name });
}
await template('Sueldo', 'income', 'bcp', '5400.00', '2026-05-28', 'Sueldo', 'Sueldo - Innova SAC');
await template('Alquiler', 'expense', 'bcp', '1200.00', '2026-05-01', 'Alquiler', 'Alquiler departamento');
await template('Internet hogar', 'expense', 'visa', '109.90', '2026-05-08', 'Internet y celular', 'Internet Fibra 400 Mbps');
await template('Plan de celular', 'expense', 'bcp', '49.90', '2026-05-10', 'Internet y celular', 'Claro postpago');
await template('Gimnasio', 'expense', 'bcp', '89.00', '2026-05-12', 'Salud', 'Smart Fit mensual');
await template('Seguro del auto', 'expense', 'bcp', '185.00', '2026-05-18', 'Transporte', 'Seguro vehicular Rímac');
const SKIPPED = { name: 'Plan de celular', month: '2026-07' };
const LEFT_PENDING = new Set(['Gimnasio:2026-10', 'Seguro del auto:2026-10']);

// ───────────────────────── Préstamos ─────────────────────────
let bankLoanId: string | null = null;
const bankInst: Array<{ number: number; dueDate: string; principal: string; interest: string; insurance: string; total: string }> = [];
const lentLoans: Array<{ id: string; name: string }> = [];

// ───────────────────────── Línea de tiempo diaria ─────────────────────────
const moneyOps = { count: 0 };
async function op(kind: 'income' | 'expense' | 'transfer', from: string, amount: number, date: string, description: string, categoryName?: string, extra: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = { kind, accountId: A(from), amount: money(amount), date, time: `${String(8 + Math.floor(rnd() * 13)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}`, description, ...extra };
  if (categoryName) body.categoryId = cats[categoryName];
  const r = await soft(`operación «${description}»`, post('/operations', body));
  if (r) moneyOps.count++;
  return r;
}
const balanceOf = async (k: string) => Number((await must('saldo', get(`/accounts/${A(k)}`))).balance);

const MEALS = ['Menú almuerzo', 'Almuerzo oficina', 'Pollería', 'Cevichería', 'Chifa', 'Desayuno', 'Cena rápida', 'Sandwich'];
const CAFES = ['Café Starbucks', 'Café Juan Valdez', 'Helado', 'Snack tienda', 'Bebida', 'Golosinas', 'Pan con chicharrón'];
const REST = ['Cena con amigos', 'Almuerzo domingo familia', 'Parrilla', 'Pizzería', 'Sushi', 'Restaurante criollo'];
const SUPER = ['Plaza Vea compras', 'Wong compras', 'Tottus compras', 'Metro compras'];

let sueldoMes = '';
for (const d of days(START, TODAY)) {
  at(d);
  const dd = day(d);

  // Servicios que arrancan hoy
  for (const s of SERVICES.filter((x) => x.start === d)) {
    const body = { name: s.name, provider: s.provider, mode: (s as any).personal ? 'personal' : 'shared', capacity: s.capacity, announcedPrice: s.price, interval: { unit: 'month', count: 1 }, startDate: d, nextPaymentDate: addDays(d, 30) === d ? d : nextMonth(d), preferredAccountId: A(s.pay), categoryId: cats[s.cat] };
    const created = await confirmed(`servicio ${s.name}`, '/subscriptions/preview', '/subscriptions', body, true);
    if (created) services.push({ id: created.id, name: s.name, price: s.price, pay: s.pay, start: d });
  }
  // Participantes que entran hoy
  for (const [svcName, who, quota, join] of SEATS.filter((x) => x[3] === d)) {
    const svc = services.find((x) => x.name === svcName);
    if (!svc) continue;
    const seat = await confirmed(`plaza ${who}/${svcName}`, `/subscriptions/${svc.id}/seats/preview`, `/subscriptions/${svc.id}/seats`, { contactId: C(who), label: who, quota, joinDate: join }, true);
    if (seat) seatIds.push({ seatId: seat.id, contact: who });
  }

  // Pago al proveedor de los ciclos que empiezan hoy
  for (const s of services) {
    const cycles = (await get(`/subscriptions/${s.id}/cycles`)).body?.items ?? [];
    for (const c of cycles) {
      if (c.startDate <= d && !paidCycles.has(c.id)) {
        paidCycles.add(c.id);
        const r = await soft(`pago proveedor ${s.name}`, post(`/billing-cycles/${c.id}/supplier-payment`, { accountId: A(s.pay), amount: s.price, paidOn: c.startDate <= d ? c.startDate : d, note: 'Débito automático' }));
        if (r && (s.pay === 'visa' || s.pay === 'mc')) statementTotals[s.pay] += Number(s.price);
      }
    }
  }

  // Cobros: cada persona paga según su costumbre
  for (const [who, h] of Object.entries(HABIT)) {
    const mine = seatIds.filter((x) => x.contact === who);
    const due: Array<{ obligationId: string; pending: number; dueDate: string; net: number }> = [];
    for (const m of mine) {
      const seat = await get(`/seats/${m.seatId}`);
      for (const c of seat.body?.charges ?? []) {
        const pending = Number(c.pending);
        if (pending <= 0) continue;
        if (h.stopFrom && c.dueDate >= h.stopFrom) continue;
        if (addDays(c.dueDate, h.delay) > d) continue;
        if (h.partial && Number(c.applied) > 0 && addDays(c.dueDate, h.delay + 9) > d) continue;
        due.push({ obligationId: c.obligationId, pending, dueDate: c.dueDate, net: Number(c.net) });
      }
    }
    if (due.length === 0) continue;
    const allocations = due.map((x) => ({ obligationId: x.obligationId, amount: money(h.partial && x.pending === x.net ? Math.round(x.pending * 0.6 * 100) / 100 : x.pending) }));
    const total = allocations.reduce((a, x) => a + Number(x.amount), 0);
    await confirmed(`cobro ${who}`, '/receipts/preview', '/receipts', { contactId: C(who), accountId: A(h.via), amount: money(total), receivedOn: d, note: pick(['Yape', 'Transferencia', 'Plin', 'Efectivo']), allocations }, true);
  }

  // Cambios en servicios (historia con matices)
  if (d === '2026-08-01') { const seat = seatIds.find((x) => x.contact === 'Lucía'); if (seat) await soft('cortesía', post(`/seats/${seat.seatId}/courtesies`, { kind: 'cycles', cycles: 1, reason: 'Regalo de cumpleaños' })); }
  if (d === '2026-09-10') { const s = services.find((x) => x.name === 'Netflix Premium'); if (s) await confirmed('precio Netflix', `/subscriptions/${s.id}/price-change/preview`, `/subscriptions/${s.id}/price-change`, { newPrice: '47.90', effectiveFrom: '2026-10-07', mode: 'per_renewal', reason: 'Netflix subió el plan Premium' }, true); }
  if (d === '2026-09-20') { const seat = seatIds.find((x) => x.contact === 'Jorge' && true); const hbo = services.find((x) => x.name === 'HBO Max'); if (hbo) { const seats = (await get(`/subscriptions/${hbo.id}/seats`)).body?.items ?? []; const j = seats.find((x: any) => x.contact?.name?.startsWith('Jorge')); if (j) await confirmed('baja Jorge', `/seats/${j.id}/exit/preview`, `/seats/${j.id}/exit`, { reason: 'Ya no usa HBO' }, true); } void seat; }

  // Préstamos
  if (d === '2026-05-15') {
    const loan = await soft('préstamo bancario', post('/bank-loans', { name: 'Préstamo personal BCP', entity: 'BCP', accountId: A('bcp'), note: 'Para la laptop y arreglos del departamento' }));
    if (loan) {
      bankLoanId = loan.id;
      const principal = 4000, n = 12, tea = 0.185;
      const i = Math.pow(1 + tea, 1 / 12) - 1;
      const pay = (principal * i) / (1 - Math.pow(1 + i, -n));
      let rest = principal;
      for (let k = 1; k <= n; k++) {
        const interest = Math.round(rest * i * 100) / 100;
        const capital = k === n ? rest : Math.round((pay - interest) * 100) / 100;
        const ins = 3.1;
        rest = Math.round((rest - capital) * 100) / 100;
        const due = addDays('2026-06-15', 0).slice(0, 5) + String(((5 + k) % 12) + 1).padStart(2, '0') + '-15';
        bankInst.push({ number: k, dueDate: dateOfMonth(2026, 5 + k, 15), principal: money(capital), interest: money(interest), insurance: money(ins), total: money(capital + interest + ins) });
        void due;
      }
      await confirmed('cronograma BCP', `/bank-loans/${loan.id}/changes/preview`, `/bank-loans/${loan.id}/changes`, {
        facts: [{ key: 'principal', value: '4000.00' }, { key: 'tea', value: '18.5' }, { key: 'term_months', value: '12' }, { key: 'installments_count', value: '12' }, { key: 'disbursed_on', value: '2026-05-15' }, { key: 'first_due_date', value: '2026-06-15' }, { key: 'monthly_payment', value: bankInst[0]!.total }, { key: 'loan_number', value: 'PR-2026-0042' }],
        installments: bankInst,
      }, true);
    }
  }
  const inst = bankInst.find((x) => x.dueDate === d);
  if (inst && bankLoanId) await confirmed(`cuota ${inst.number} BCP`, `/bank-loans/${bankLoanId}/payments/preview`, `/bank-loans/${bankLoanId}/payments`, { accountId: A('bcp'), amount: inst.total, paidOn: d, installmentNumber: inst.number, principal: inst.principal, interest: inst.interest, insurance: inst.insurance }, true);

  if (d === '2026-07-05') {
    const l = await confirmed('préstamo a Miguel', '/loans/preview', '/loans', { direction: 'lent', contactId: C('Miguel'), principal: '400.00', openedOn: d, accountId: A('bcp'), interest: { mode: 'none' }, repayment: { kind: 'installments', installments: 4, firstDueDate: '2026-08-05' }, note: 'Para su matrícula' }, true);
    if (l) lentLoans.push({ id: l.id, name: 'Miguel' });
  }
  if (d === '2026-08-01') await confirmed('préstamo de Raúl', '/loans/preview', '/loans', { direction: 'borrowed', contactId: C('Raúl'), principal: '1500.00', openedOn: d, accountId: A('bcp'), interest: { mode: 'percent', ratePercent: '3', base: 'original' }, repayment: { kind: 'final_date', finalDate: '2026-12-15' }, note: 'Adelanto para el viaje' }, true);
  if (d === '2026-09-15') await confirmed('préstamo a Jorge', '/loans/preview', '/loans', { direction: 'lent', contactId: C('Jorge'), principal: '250.00', openedOn: d, accountId: A('yape'), interest: { mode: 'none' }, repayment: { kind: 'open' } }, true);
  for (const l of lentLoans) {
    if (['2026-08-05', '2026-09-05'].includes(d)) {
      const detail = await get(`/loans/${l.id}`);
      void detail;
      await confirmed(`pago de ${l.name}`, `/loans/${l.id}/payments/preview`, `/loans/${l.id}/payments`, { amount: '100.00', accountId: A('yape'), paidOn: d }, true);
    }
  }

  // Compras a cuotas con tarjeta
  if (d === '2026-06-08') await soft('laptop a cuotas', post(`/accounts/${A('visa')}/installment-purchases`, { amount: '2800.00', installments: 12, firstDueDate: '2026-07-10', description: 'Laptop Lenovo Yoga', categoryId: cats['Tecnología'], date: d }));
  if (d === '2026-09-12') await soft('celular a cuotas', post(`/accounts/${A('mc')}/installment-purchases`, { amount: '900.00', installments: 6, firstDueDate: '2026-10-25', description: 'Audífonos y parlante', categoryId: cats['Tecnología'], date: d }));

  // Recurrentes del día
  const pend = (await get('/recurring/pending?within=0')).body;
  for (const o of pend?.due ?? []) {
    const key = `${o.templateName ?? o.name}:${ym(o.dueDate)}`;
    if (LEFT_PENDING.has(key) || o.dueDate > d) continue;
    if ((o.templateName ?? o.name) === SKIPPED.name && ym(o.dueDate) === SKIPPED.month) { await soft('omitir ocurrencia', post(`/recurring/occurrences/${o.id}/skip`, { note: 'Este mes lo cubrió la empresa' })); continue; }
    if (addDays(o.dueDate, 0) < d && !chance(0.4) && dd % 2) continue; // algunas se confirman un día después
    const kindTpl = (o.templateName ?? o.name) as string;
    const amount = kindTpl === 'Sueldo' ? undefined : undefined;
    void amount;
    const r = await soft(`confirmar ${kindTpl}`, post(`/recurring/occurrences/${o.id}/confirm`, { date: o.dueDate }));
    if (r && (kindTpl === 'Internet hogar')) statementTotals.visa += 109.9;
  }

  // Gastos cotidianos
  const weekend = dow(d) === 0 || dow(d) === 6;
  const spendFrom = () => pick(['cash', 'yape', 'yape', 'visa']);
  if (chance(weekend ? 0.7 : 0.92)) { const a = pick(['cash', 'yape']); await op('expense', a, between(11, 24), d, pick(MEALS), 'Comida'); }
  if (chance(0.6)) await op('expense', pick(['yape', 'cash']), between(2.5, 6), d, pick(['Pasaje bus', 'Metropolitano', 'Combi']), 'Transporte público');
  if (chance(0.4)) { const f = spendFrom(); const x = await op('expense', f, between(9, 22), d, pick(CAFES), 'Minigastos'); if (x && f === 'visa') statementTotals.visa += Number(x.amount ? Math.abs(Number(x.amount)) : 0); }
  if (chance(0.22)) await op('expense', 'yape', between(9, 24), d, pick(['Uber al trabajo', 'Uber a casa', 'Cabify', 'Uber centro']), 'Taxi y apps');
  if (dow(d) === 6) await op('expense', pick(['visa', 'bcp', 'bcp', 'yape']), between(110, 230), d, pick(SUPER), 'Supermercado');
  if (dow(d) === 0) { const f = pick(['visa', 'mc', 'yape']); const r = await op('expense', f, between(65, 150), d, pick(REST), 'Restaurantes'); if (r && (f === 'visa' || f === 'mc')) statementTotals[f] += Math.abs(Number(r.amount ?? 0)); }
  if (chance(0.07)) await op('expense', 'yape', between(28, 55), d, 'Pedido Rappi', 'Delivery');
  if (chance(0.05)) await op('expense', 'bcp', between(45, 140), d, pick(['Inkafarma medicinas', 'Farmacia', 'Consulta médica']), 'Farmacia');
  if (chance(0.04)) await op('expense', 'visa', between(80, 260), d, pick(['Zapatillas', 'Polo y jean', 'Camisa']), 'Ropa');
  if (chance(0.05)) await op('expense', 'mc', between(30, 120), d, pick(['Cine y canchita', 'Entradas concierto', 'Bowling', 'Juego Steam']), 'Salidas');
  if (chance(0.025)) await op('expense', 'cash', between(30, 90), d, pick(['Comida para el perro', 'Veterinario']), 'Mascotas');
  if (chance(0.1)) await op('expense', 'yape', between(15, 60), d, pick(['Cerveza con amigos', 'Compra bodega', 'Propina', 'Lavandería']), undefined); // sin categoría a propósito

  // Servicios del hogar (variables)
  if (dd === 3) await op('expense', 'bcp', between(62, 98), d, 'Recibo de luz Enel', 'Luz');
  if (dd === 5) await op('expense', 'bcp', between(28, 46), d, 'Recibo de agua Sedapal', 'Agua');

  // Ingresos extra
  if (['2026-05-14', '2026-06-22', '2026-08-06', '2026-09-18', '2026-10-15'].includes(d)) await op('income', pick(['yape', 'bcp']), between(350, 950), d, pick(['Proyecto freelance web', 'Diseño de logo', 'Asesoría contable']), 'Freelance');
  if (['2026-07-19', '2026-09-27'].includes(d)) await op('income', 'yape', between(120, 380), d, 'Venta en Marketplace', 'Ventas');
  if (d === '2026-07-12') await op('income', 'bcp', 250, d, 'Regalo cumpleaños', 'Regalos');

  // Retiros de efectivo y recargas
  if (dd === 2 || dd === 17) await op('transfer', 'bcp', 300, d, 'Retiro cajero', undefined, { toAccountId: A('cash') });
  if (dow(d) === 1 && chance(0.75)) await op('transfer', 'bcp', pick([120, 150, 180]), d, 'Recarga Yape', undefined, { toAccountId: A('yape') });

  // Tarjetas: estado de cuenta al corte y pago al vencimiento
  if (dd === 21) {
    const cutoff = `${ym(d)}-20`;
    const total = Math.abs(await balanceOf('visa'));
    const due = `${nextMonth(cutoff).slice(0, 7)}-10`;
    if (total > 0) { const st = await soft('estado Visa', post(`/accounts/${A('visa')}/statements`, { cutoffDate: cutoff, dueDate: due, periodTotal: money(total), minimumPayment: money(Math.max(50, total * 0.1)) })); if (st) pendingStatements.push({ id: st.id, card: 'visa', due, amount: total }); }
  }
  if (dd === 6) {
    const cutoff = `${ym(d)}-05`;
    const total = Math.abs(await balanceOf('mc'));
    if (total > 0) { const st = await soft('estado MC', post(`/accounts/${A('mc')}/statements`, { cutoffDate: cutoff, dueDate: `${ym(d)}-25`, periodTotal: money(total), minimumPayment: money(Math.max(40, total * 0.1)) })); if (st) pendingStatements.push({ id: st.id, card: 'mc', due: `${ym(d)}-25`, amount: total }); }
  }
  for (const st of pendingStatements.filter((x) => x.due === d)) {
    const pay = Math.max(0, Math.min(Math.round(st.amount * 0.9 / 10) * 10, (await balanceOf('bcp')) - 1200));
    const r = pay > 0 ? await op('transfer', 'bcp', pay, d, `Pago tarjeta ${st.card === 'visa' ? 'Visa BBVA' : 'Mastercard'}`, undefined, { toAccountId: A(st.card) }) : null;
    if (r) await soft('vincular pago', post(`/card-statements/${st.id}/payments`, { operationId: r.id }));
  }

  // Sueldo ya viene de la plantilla; ahorro a fin de mes
  if (dd === 29 && d <= TODAY) {
    const bal = await balanceOf('bcp');
    const save = Math.max(0, Math.min(400, Math.floor((bal - 2200) / 100) * 100));
    if (save >= 100) await op('transfer', 'bcp', save, d, 'Ahorro mensual', undefined, { toAccountId: A('ibk') });
  }
  // Guardar el resumen del mes anterior
  if (dd === 2 && d > '2026-05-31') await soft(`resumen ${prevMonth(d)}`, post('/reports/monthly/snapshots', { month: prevMonth(d) }));
  sueldoMes = d;
}
void sueldoMes;

// ───────────────────────── Metas ─────────────────────────
at(TODAY);
const goals: Array<[string, string, string | null, string, string, string]> = [
  ['Viaje a Cusco', '3500.00', '2027-03-15', 'ibk', '1850.00', 'airplane'],
  ['Fondo de emergencia', '15000.00', null, 'ibk', '6200.00', 'shield'],
  ['Laptop nueva', '4200.00', '2026-12-20', 'ibk', '2900.00', 'laptop'],
  ['Regalo de aniversario', '600.00', '2026-11-30', 'bcp', '150.00', 'gift'],
];
for (const [name, target, date, accKey, reserve, icon] of goals) {
  const g = await soft(`meta ${name}`, post('/goals', { name, targetAmount: target, ...(date ? { targetDate: date } : {}), icon }));
  if (g) await soft(`reservar ${name}`, post(`/goals/${g.id}/reserve`, { accountId: A(accKey), amount: reserve }));
}

// ───────────────────────── Captura (propuestas por revisar) ─────────────────────────
for (const t of [
  'Yape: Yapeaste S/ 18.50 a Panadería Don José el 28/10/2026 10:15 Nro. de operación 5530012',
  'Plin: Recibiste S/ 120.00 de Carlos Mendoza el 27/10/2026 19:40 Nro. de operación 7730481',
  'BCP: Compra con tarjeta S/ 86.90 en Inkafarma el 26/10/2026 17:20 Nro. de operación 2210987',
  'Yape: Yapeaste S/ 35.00 a Café Tostado el 25/10/2026 08:05 Nro. de operación 5521766',
]) await soft('captura', post('/capture/documents', { origin: 'text', text: t, sender: 'yape@notificaciones.pe' }));

// ───────────────────────── Preferencias del panel ─────────────────────────
await soft('panel', put('/preferences', { dashboard: { cards: ['accounts_balance', 'credit_debt', 'period_flow', 'budgets', 'goals', 'renewals', 'pending_collections', 'loans', 'upcoming_payments', 'capture_pending'].map((id) => ({ id, enabled: true })) } }));

// ───────────────────────── Informe ─────────────────────────
const summary = await must('resumen', get('/summary'));
console.log('\n=== Carga terminada ===');
console.log('Movimientos creados a mano:', moneyOps.count);
console.log('Saldo total:', JSON.stringify(summary.balance ?? summary.totalBalance ?? summary).slice(0, 300));
for (const k of Object.keys(accounts)) console.log(' ', k.padEnd(5), (await must('saldo', get(`/accounts/${A(k)}`))).balance);
console.log('Pasos omitidos o rechazados:', fails.length);
for (const f of [...new Set(fails)].slice(0, 40)) console.log('  -', f);
await pool.end();

// ───────────────────────── Fechas ─────────────────────────
function nextMonth(iso: string) { const [y, m, dd] = iso.split('-').map(Number) as [number, number, number]; return dateOfMonth(y, m + 1, dd); }
function prevMonth(iso: string) { const [y, m] = iso.split('-').map(Number) as [number, number]; const d = new Date(Date.UTC(y, m - 2, 1)); return d.toISOString().slice(0, 7); }
function dateOfMonth(y: number, m: number, dd: number) { const d = new Date(Date.UTC(y, m - 1, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`; }
