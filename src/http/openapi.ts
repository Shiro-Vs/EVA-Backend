import { z, type ZodType } from 'zod';
import * as s from './schemas.js';

// Contrato de la API v1 (13). Las entradas se derivan de los esquemas Zod que la API ya usa para validar,
// así que el contrato no puede divergir de lo que el servidor acepta. Un test comprueba que no falte ninguna ruta.
interface Doc {
  method: 'get' | 'post' | 'patch';
  path: string;
  tag: string;
  summary: string;
  body?: ZodType;
  idempotent?: boolean; // exige Idempotency-Key
  ifMatch?: boolean; // exige If-Match con la versión
  status?: number; // 201 en creaciones
}

const D = (method: Doc['method'], path: string, tag: string, summary: string, extra: Partial<Doc> = {}): Doc => ({ method, path, tag, summary, ...extra });

export const ROUTES: Doc[] = [
  D('get', '/me', 'Perfil', 'Perfil y preferencias (se crea en el primer acceso)'),
  D('patch', '/me', 'Perfil', 'Actualiza nombre, días gratis predeterminados y límite de baja', { body: s.profilePatch, ifMatch: true }),

  D('get', '/summary', 'Perfil', 'Resumen: saldo total, por cobrar, compromisos y actividad reciente'),

  D('get', '/accounts', 'Cuentas', 'Lista de cuentas con saldo calculado'),
  D('post', '/accounts', 'Cuentas', 'Crea una cuenta con saldo inicial opcional', { body: s.accountCreate, idempotent: true, status: 201 }),
  D('get', '/accounts/{id}', 'Cuentas', 'Detalle y saldo'),
  D('patch', '/accounts/{id}', 'Cuentas', 'Edita datos de la cuenta', { body: s.accountPatch, ifMatch: true }),
  D('post', '/accounts/{id}/archive', 'Cuentas', 'Archiva la cuenta (no la borra)'),
  D('get', '/accounts/{id}/entries', 'Cuentas', 'Asientos con saldo acumulado (paginado)'),

  D('post', '/operations', 'Operaciones', 'Ingreso, gasto o transferencia manual', { body: s.operationCreate, idempotent: true, status: 201 }),
  D('get', '/operations/{id}', 'Operaciones', 'Detalle de una operación'),
  D('post', '/operations/{id}/reverse', 'Operaciones', 'Revierte una operación creando la contraria', { body: s.reverseBody, idempotent: true, status: 201 }),

  D('get', '/contacts', 'Contactos', 'Lista con deuda, crédito y ocupación'),
  D('post', '/contacts', 'Contactos', 'Crea un contacto', { body: s.contactCreate, status: 201 }),
  D('get', '/contacts/{id}', 'Contactos', 'Detalle del contacto'),
  D('patch', '/contacts/{id}', 'Contactos', 'Edita un contacto', { body: s.contactPatch, ifMatch: true }),
  D('post', '/contacts/{id}/archive', 'Contactos', 'Archiva el contacto (bloqueado con plazas activas)'),
  D('get', '/contacts/{id}/statement', 'Contactos', 'Estado de cuenta por servicio, plaza y ciclo, con texto para compartir'),
  D('get', '/contacts/{id}/credit', 'Cobros', 'Crédito del contacto: libre y reservado'),

  D('post', '/subscriptions/preview', 'Servicios', 'Vista previa: calendario, cuota sugerida y primeros ciclos', { body: s.subscriptionPreview }),
  D('post', '/subscriptions', 'Servicios', 'Crea el servicio, sus ciclos y la plaza del administrador', { body: s.subscriptionCreate, idempotent: true, status: 201 }),
  D('get', '/subscriptions', 'Servicios', 'Lista de servicios'),
  D('get', '/subscriptions/{id}', 'Servicios', 'Detalle con ciclo actual y siguiente'),
  D('patch', '/subscriptions/{id}', 'Servicios', 'Edita datos del servicio', { body: s.subscriptionPatch, ifMatch: true }),
  D('post', '/subscriptions/{id}/archive', 'Servicios', 'Archiva el servicio (bloqueado con plazas activas)'),
  D('get', '/subscriptions/{id}/cycles', 'Servicios', 'Ciclos del servicio'),
  D('post', '/subscriptions/{id}/cycles/generate', 'Servicios', 'Emite ciclos y cargos por adelantado (idempotente)', { body: s.generateBody, idempotent: true }),
  D('get', '/subscriptions/{id}/cost-summary', 'Servicios', 'Costo previsto, según cobros, pendiente y excedente'),

  D('post', '/subscriptions/{id}/seats/preview', 'Plazas', 'Vista previa de la incorporación (prorrateo con fórmula)', { body: s.seatBody }),
  D('post', '/subscriptions/{id}/seats', 'Plazas', 'Alta de plaza con su primer cargo', { body: s.seatCreate, idempotent: true, status: 201 }),
  D('get', '/subscriptions/{id}/seats', 'Plazas', 'Plazas activas del servicio con pendiente'),
  D('get', '/seats/{id}', 'Plazas', 'Plaza con sus cargos'),

  D('post', '/seats/{id}/courtesies/preview', 'Cortesías', 'Vista previa: desde qué ciclo rige y qué cargos ya emitidos se eximen', { body: s.courtesyBody }),
  D('post', '/seats/{id}/courtesies', 'Cortesías', 'Crea una cortesía (por ciclos, hasta una fecha o permanente) desde el siguiente ciclo', { body: s.courtesyBody, idempotent: true, status: 201 }),
  D('get', '/seats/{id}/courtesies', 'Cortesías', 'Cortesías de la plaza'),
  D('post', '/courtesies/{id}/end', 'Cortesías', 'Termina la cortesía; los ciclos sin emitir vuelven a cobrarse', { idempotent: true }),
  D('post', '/seats/{id}/quota-change/preview', 'Plazas', 'Vista previa del cambio de cuota: ajustes por ciclo, vencimientos y crédito liberado', { body: s.quotaChangeBody }),
  D('post', '/seats/{id}/quota-change', 'Plazas', 'Aplica el cambio de cuota desde el inicio de un ciclo futuro', { body: s.quotaChangeCreate, idempotent: true }),

  D('post', '/subscriptions/{id}/calendar-changes/preview', 'Calendario', 'Vista previa de un cambio de calendario: ciclos y vencimientos afectados (los importes no cambian)', { body: s.calendarChangeBody }),
  D('post', '/subscriptions/{id}/calendar-changes', 'Calendario', 'Desplaza o adelanta la renovación, cambia la frecuencia, suspende o reactiva', { body: s.calendarChangeCreate, idempotent: true, status: 201 }),
  D('get', '/subscriptions/{id}/calendar-changes', 'Calendario', 'Historial de cambios de calendario'),

  D('get', '/billing-cycles/{id}', 'Pagos', 'Ciclo con cargos, pago al proveedor y costo'),
  D('post', '/billing-cycles/{id}/supplier-payment', 'Pagos', 'Registra el pago real al proveedor', { body: s.supplierBody, idempotent: true, status: 201 }),
  D('post', '/supplier-payments/{id}/reverse', 'Pagos', 'Revierte un pago al proveedor', { body: s.reasonBody, idempotent: true }),

  D('post', '/receipts/preview', 'Cobros', 'Valida el reparto y muestra sobrante y reserva', { body: s.receiptBody }),
  D('post', '/receipts', 'Cobros', 'Registra un ingreso real, su reparto y la reserva del sobrante', { body: s.receiptCreate, idempotent: true, status: 201 }),
  D('get', '/receipts/{id}', 'Cobros', 'Cobro con aplicaciones, reservas y disponibilidad'),
  D('post', '/credit-reservations/{id}/move', 'Cobros', 'Traslada el destino de una reserva a otro servicio', { body: s.moveBody, idempotent: true }),
  D('post', '/allocations/{id}/release', 'Cobros', 'Libera una aplicación (deshacer)', { body: s.reasonBody, idempotent: true }),
];

const ERROR = {
  type: 'object',
  required: ['error'],
  properties: { error: { type: 'object', required: ['code', 'message', 'requestId'], properties: { code: { type: 'string' }, message: { type: 'string' }, details: {}, requestId: { type: 'string' } } } },
};

const clean = (schema: Record<string, unknown>) => { const { $schema: _omit, ...rest } = schema; return rest; };

export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    const params: unknown[] = [];
    for (const name of r.path.match(/\{(\w+)\}/g) ?? []) params.push({ name: name.slice(1, -1), in: 'path', required: true, schema: { type: 'string', format: 'uuid' } });
    if (r.idempotent) params.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 }, description: 'Un reintento con la misma clave y cuerpo devuelve la respuesta ya guardada.' });
    if (r.ifMatch) params.push({ name: 'If-Match', in: 'header', required: true, schema: { type: 'string' }, description: 'Versión del recurso, p. ej. "3".' });
    (paths[r.path] ??= {})[r.method] = {
      tags: [r.tag],
      summary: r.summary,
      security: [{ bearer: [] }],
      parameters: params,
      ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: clean(z.toJSONSchema(r.body, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>) } } } } : {}),
      responses: {
        [String(r.status ?? 200)]: { description: 'OK' },
        '401': { description: 'UNAUTHENTICATED', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'NOT_FOUND (también para recursos de otro usuario)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '422': { description: 'VALIDATION_ERROR u otro error de negocio (ver docs 13 §3)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'EVA API', version: '1.0.0', description: 'Contrato v1. Dinero como cadena decimal ("20.00"); fechas locales YYYY-MM-DD. Las respuestas se documentan en docs/especificacion/13-contrato-api.md.' },
    servers: [{ url: '/v1' }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }, schemas: { Error: ERROR } },
    paths,
  };
}
