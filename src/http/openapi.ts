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
  D('get', '/contacts/{id}/receipts', 'Cobros', 'Cobros del contacto con lo que queda disponible de cada uno'),
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

  D('post', '/seats/{id}/exit/preview', 'Bajas', 'Vista previa de la baja: modo, fecha efectiva, cobro, cargos cancelados, devoluciones y préstamo', { body: s.exitPreviewBody }),
  D('post', '/seats/{id}/exit', 'Bajas', 'Ejecuta la baja de forma atómica (devoluciones programadas y deuda convertida en préstamo)', { body: s.exitCreate, idempotent: true }),
  D('get', '/refunds', 'Devoluciones', 'Devoluciones (programadas, pagadas o canceladas)'),
  D('post', '/refunds', 'Devoluciones', 'Programa la devolución de crédito libre de un cobro', { body: s.refundCreate, idempotent: true, status: 201 }),
  D('post', '/refunds/{id}/pay', 'Devoluciones', 'Registra la salida real del dinero desde una cuenta', { body: s.refundPay, idempotent: true }),
  D('post', '/refunds/{id}/cancel', 'Devoluciones', 'Cancela una devolución programada (el dinero vuelve a ser crédito libre)', { body: s.reasonBody, idempotent: true }),
  D('get', '/loans', 'Préstamos', 'Préstamos otorgados (por conversión de deuda), con sus componentes'),
  D('get', '/loans/{id}', 'Préstamos', 'Detalle de un préstamo con origen y saldo de cada componente'),

  D('post', '/subscriptions/{id}/switch-to-individual/preview', 'Servicios', 'Vista previa del cambio a individual: bajas, devoluciones y préstamos de cada plaza', { body: s.exitPreviewBody }),
  D('post', '/subscriptions/{id}/switch-to-individual', 'Servicios', 'Cambia a individual al final del ciclo en curso (RN-X08), en una sola transacción', { body: s.exitCreate, idempotent: true }),
  D('post', '/contacts/{id}/debt-conversion/preview', 'Préstamos', 'Vista previa de convertir deuda de servicio en un préstamo', { body: s.debtConversionPreview }),
  D('post', '/contacts/{id}/debt-conversion', 'Préstamos', 'Convierte deuda de servicio en un préstamo con detalle (la deuda total no cambia)', { body: s.debtConversionCreate, idempotent: true, status: 201 }),

  D('get', '/subscriptions/{id}/terms', 'Servicios', 'Versiones de precio y calendario del servicio con su vigencia'),
  D('post', '/subscriptions/{id}/price-change/preview', 'Servicios', 'Propuesta por cambio de precio del proveedor: cuota sugerida, plazas y diferencias', { body: s.priceChangeBody }),
  D('post', '/subscriptions/{id}/price-change', 'Servicios', 'Aplica el nuevo precio desde un ciclo futuro y las cuotas que confirmes', { body: s.priceChangeCreate, idempotent: true }),

  D('patch', '/operations/{id}', 'Correcciones', 'Corrige descripción, categoría o contacto de una operación (sin efecto financiero)', { body: s.operationPatch, ifMatch: true }),
  D('post', '/operations/{id}/correct/preview', 'Correcciones', 'Vista de efectos de corregir importe, cuenta o fecha de una operación', { body: s.operationCorrection }),
  D('post', '/operations/{id}/correct', 'Correcciones', 'Revierte la operación y registra la corregida, en una transacción', { body: s.operationCorrectionCreate, idempotent: true, status: 201 }),
  D('patch', '/receipts/{id}', 'Correcciones', 'Corrige la nota de un cobro (sin efecto financiero)', { body: s.receiptPatch, ifMatch: true }),
  D('post', '/receipts/{id}/correct/preview', 'Correcciones', 'Vista de efectos de corregir importe, cuenta, fecha o reparto de un cobro', { body: s.receiptCorrection }),
  D('post', '/receipts/{id}/correct', 'Correcciones', 'Anula el cobro y registra el corregido con su reparto, en una transacción', { body: s.receiptCorrectionCreate, idempotent: true, status: 201 }),
  D('post', '/receipts/{id}/reverse/preview', 'Correcciones', 'Vista de efectos de revertir un cobro'),
  D('post', '/receipts/{id}/reverse', 'Correcciones', 'Revierte un cobro: anula el ingreso y las deudas vuelven a quedar pendientes', { body: s.receiptReverseCreate, idempotent: true }),

  D('post', '/accounts/{id}/reconciliation/preview', 'Conciliación', 'Compara el saldo real con el registrado y lista qué revisar antes de ajustar', { body: s.reconcileBody }),
  D('post', '/accounts/{id}/reconciliation', 'Conciliación', 'Registra la conciliación; si hay diferencia, un ajuste con fecha y motivo (línea propia, no ingreso ni gasto)', { body: s.reconcileCreate, idempotent: true, status: 201 }),
  D('get', '/accounts/{id}/reconciliations', 'Conciliación', 'Historial de conciliaciones con saldo antes y después'),
  D('get', '/recurring/templates', 'Recurrencias', 'Plantillas de ingresos y gastos recurrentes con su próxima fecha'),
  D('post', '/recurring/templates', 'Recurrencias', 'Crea una plantilla (sueldo, alquiler…): solo propone, nunca registra por sí sola', { body: s.recurringCreate, status: 201 }),
  D('get', '/recurring/templates/{id}', 'Recurrencias', 'Plantilla con sus ocurrencias'),
  D('patch', '/recurring/templates/{id}', 'Recurrencias', 'Edita la plantilla; si cambia el calendario se vuelven a proponer solo las ocurrencias pendientes', { body: s.recurringPatch, ifMatch: true }),
  D('post', '/recurring/templates/{id}/pause', 'Recurrencias', 'Pausa: no se proponen ocurrencias mientras tanto'),
  D('post', '/recurring/templates/{id}/resume', 'Recurrencias', 'Reanuda desde hoy, sin inundar con lo ocurrido durante la pausa'),
  D('post', '/recurring/templates/{id}/archive', 'Recurrencias', 'Archiva la plantilla'),
  D('get', '/recurring/pending', 'Recurrencias', 'Ocurrencias vencidas por decidir y las próximas'),
  D('post', '/recurring/occurrences/{id}/confirm', 'Recurrencias', 'Confirma: registra el movimiento real con lo esperado o lo que corrijas', { body: s.occurrenceConfirm, idempotent: true }),
  D('post', '/recurring/occurrences/{id}/skip', 'Recurrencias', 'Omite una ocurrencia sin registrar nada', { body: s.occurrenceSkip }),
  D('post', '/recurring/occurrences/{id}/link', 'Recurrencias', 'Vincula un movimiento que ya existe (no crea otro) e informa diferencias', { body: s.occurrenceLink }),
  D('post', '/recurring/occurrences/{id}/reopen', 'Recurrencias', 'Reabre una ocurrencia omitida o cuyo movimiento se revirtió'),

  D('get', '/capture/inbox-address', 'Captura', 'Dirección de recepción de correos (estable; se crea en el primer uso)'),
  D('post', '/capture/inbox-address/rotate', 'Captura', 'Rota la dirección: la anterior deja de recibir'),
  D('post', '/capture/inbox-address/revoke', 'Captura', 'Revoca la dirección sin crear otra'),
  D('post', '/capture/documents', 'Captura', 'Recibe una foto, PDF o texto y lo analiza; una reentrega exacta no crea otro documento', { body: s.captureDocumentCreate, status: 201 }),
  D('get', '/capture/documents', 'Captura', 'Documentos recibidos, con filtro por estado'),
  D('get', '/capture/documents/{id}', 'Captura', 'Documento con sus intentos de extracción y propuestas'),
  D('get', '/capture/documents/{id}/file', 'Captura', 'Descarga el original (solo su dueño; sin caché)'),
  D('post', '/capture/documents/{id}/retry', 'Captura', 'Reintenta un documento fallido'),
  D('post', '/capture/documents/{id}/discard', 'Captura', 'Descarta un documento fallido o sin transacción'),
  D('post', '/capture/documents/{id}/delete-file', 'Captura', 'Elimina el original conservando la procedencia (no con propuestas pendientes)'),
  D('post', '/capture/retention/purge', 'Captura', 'Elimina los originales resueltos que superan el plazo (90 días por defecto)', { body: s.capturePurge }),
  D('get', '/capture/proposals', 'Captura', 'Propuestas por estado (pendientes por defecto): no afectan saldos'),
  D('get', '/capture/proposals/{id}', 'Captura', 'Propuesta con lo que falta y las posibles coincidencias'),
  D('patch', '/capture/proposals/{id}', 'Captura', 'Completa o corrige una propuesta pendiente', { body: s.proposalPatch, ifMatch: true }),
  D('post', '/capture/proposals/{id}/preview', 'Captura', 'Vista previa de aceptar: efecto en cuentas, faltantes, coincidencias y previewToken'),
  D('post', '/capture/proposals/{id}/accept', 'Captura', 'Acepta (atómico e idempotente): crea el movimiento y vincula la evidencia', { body: s.proposalAccept, idempotent: true, status: 201 }),
  D('post', '/capture/proposals/{id}/link', 'Captura', 'Vincula la evidencia a un movimiento existente sin crear otro', { body: s.proposalLink }),
  D('post', '/capture/proposals/{id}/discard', 'Captura', 'Descarta la propuesta sin afectar saldos'),
  D('post', '/capture/proposals/{id}/undo', 'Captura', 'Deshace una aceptación: revierte el movimiento y vuelve a revisión', { body: s.proposalUndo }),
  D('post', '/capture/proposals/accept-batch', 'Captura', 'Acepta varias; cada una en su transacción, con informe de aceptadas y fallidas', { body: s.proposalBatch }),
  D('get', '/capture/sender-rules', 'Captura', 'Reglas por remitente'),
  D('post', '/capture/sender-rules', 'Captura', 'Crea una regla por remitente (cuenta, categoría o contacto)', { body: s.senderRuleCreate, status: 201 }),
  D('post', '/capture/sender-rules/{id}/archive', 'Captura', 'Archiva una regla por remitente'),
  D('get', '/capture/usage', 'Captura', 'Uso de IA del día y del mes frente al tope'),

  D('post', '/analysis/context', 'Análisis', 'Muestra los datos que se enviarían a la IA para un alcance, sin enviarlos ni gastar cuota', { body: s.analysisContext }),
  D('post', '/analysis', 'Análisis', 'Pregunta a la IA sobre el alcance elegido (periodo, cuentas, categorías, servicios); guardar es opcional', { body: s.analysisRun, status: 201 }),
  D('get', '/analysis', 'Análisis', 'Análisis guardados'),
  D('get', '/analysis/{id}', 'Análisis', 'Un análisis guardado'),
  D('post', '/analysis/{id}/delete', 'Análisis', 'Elimina un análisis guardado'),
  D('post', '/analysis/chats', 'Análisis', 'Crea un chat con un alcance; el historial es opt-in', { body: s.chatCreate, status: 201 }),
  D('get', '/analysis/chats', 'Análisis', 'Chats del usuario'),
  D('get', '/analysis/chats/{id}', 'Análisis', 'Chat con sus mensajes (si guarda historial)'),
  D('post', '/analysis/chats/{id}/messages', 'Análisis', 'Envía un mensaje; sin historial guardado el cliente reenvía los turnos que quiera conservar', { body: s.chatMessage }),
  D('post', '/analysis/chats/{id}/delete', 'Análisis', 'Borra el chat y sus mensajes'),

  D('post', '/bank-loans', 'Préstamos bancarios', 'Crea un préstamo bancario: solo guarda datos confirmados por documento o por ti', { body: s.bankLoanCreate, status: 201 }),
  D('get', '/bank-loans', 'Préstamos bancarios', 'Préstamos bancarios con próximo vencimiento y datos pendientes'),
  D('get', '/bank-loans/{id}', 'Préstamos bancarios', 'Datos con su origen, calendario de ayuda, pagos, documentos y advertencias de coherencia'),
  D('patch', '/bank-loans/{id}', 'Préstamos bancarios', 'Edita o cierra el préstamo', { body: s.bankLoanPatch, ifMatch: true }),
  D('post', '/bank-loans/{id}/changes/preview', 'Préstamos bancarios', 'Compara un documento (o datos manuales) con lo vigente: nuevo, cambiado, bloqueado por pagos; señala incoherencias', { body: s.bankLoanChange }),
  D('post', '/bank-loans/{id}/changes', 'Préstamos bancarios', 'Confirma el cambio: actualiza datos y cuotas futuras sin tocar lo pagado', { body: s.bankLoanChangeConfirm, idempotent: true }),
  D('post', '/bank-loans/{id}/payments/preview', 'Préstamos bancarios', 'Vista previa de un pago real: efecto en la cuenta y en la cuota; no genera mora', { body: s.bankLoanPaymentPreview }),
  D('post', '/bank-loans/{id}/payments', 'Préstamos bancarios', 'Registra un pago real (egreso de una cuenta propia); el desglose es opcional', { body: s.bankLoanPaymentCreate, idempotent: true, status: 201 }),
  D('post', '/bank-loans/payments/{id}/reverse', 'Préstamos bancarios', 'Revierte un pago y reabre su cuota', { body: s.bankLoanPaymentReverse, idempotent: true }),

  D('get', '/reports/monthly', 'Reportes', 'Resumen mensual vivo: flujo de dinero y resultado por conceptos, con las versiones guardadas y si cambió desde la última'),
  D('get', '/reports/monthly/pdf', 'Reportes', 'PDF del resumen mensual vivo'),
  D('post', '/reports/monthly/snapshots', 'Reportes', 'Guarda una versión (instantánea) del resumen; si no cambió nada no crea otra', { body: s.monthlySave, status: 201 }),
  D('get', '/reports/monthly/snapshots', 'Reportes', 'Versiones guardadas, con filtro por mes'),
  D('get', '/reports/snapshots/{id}', 'Reportes', 'Una versión guardada con sus números'),
  D('get', '/reports/snapshots/{id}/pdf', 'Reportes', 'PDF de una versión guardada'),
  D('get', '/goals', 'Metas', 'Metas de ahorro con avance (lo reservado, no el saldo total)'),
  D('get', '/goals/overview', 'Metas', 'Por cuenta: total, reservado y libre, con aviso si lo reservado supera el saldo'),
  D('post', '/goals', 'Metas', 'Crea una meta (objetivo, fecha opcional)', { body: s.goalCreate, status: 201 }),
  D('get', '/goals/{id}', 'Metas', 'Detalle con el historial de aportes'),
  D('patch', '/goals/{id}', 'Metas', 'Edita una meta', { body: s.goalPatch, ifMatch: true }),
  D('post', '/goals/{id}/archive', 'Metas', 'Archiva una meta'),
  D('post', '/goals/{id}/restore', 'Metas', 'Restaura una meta'),
  D('post', '/goals/{id}/reserve', 'Metas', 'Aparta dinero que ya está en una cuenta (no crea operaciones ni cambia el saldo)', { body: s.goalMoney, idempotent: true }),
  D('post', '/goals/{id}/release', 'Metas', 'Libera dinero reservado', { body: s.goalMoney, idempotent: true }),
  D('post', '/goals/{id}/link-transfer', 'Metas', 'Vincula una transferencia real de ahorro: lo transferido queda reservado', { body: s.goalLink, idempotent: true }),
  D('get', '/budgets', 'Presupuestos', 'Presupuestos con su estado en el período de una fecha (consumo, límite, arrastre, avisos)'),
  D('post', '/budgets', 'Presupuestos', 'Crea un presupuesto (límite por categoría o general, período, avisos, arrastre opcional)', { body: s.budgetCreate, status: 201 }),
  D('get', '/budgets/{id}', 'Presupuestos', 'Detalle: movimientos que consumen y servicios compartidos por costo real neto'),
  D('get', '/budgets/{id}/history', 'Presupuestos', 'Consumo de los últimos períodos'),
  D('patch', '/budgets/{id}', 'Presupuestos', 'Edita el presupuesto; un límite nuevo rige desde el período actual', { body: s.budgetPatch, ifMatch: true }),
  D('post', '/budgets/{id}/archive', 'Presupuestos', 'Archiva un presupuesto'),
  D('post', '/budgets/{id}/restore', 'Presupuestos', 'Restaura un presupuesto archivado'),
  D('post', '/loans/preview', 'Préstamos', 'Vista previa de un préstamo nuevo: cronograma, intereses y totales', { body: s.loanBody }),
  D('post', '/loans', 'Préstamos', 'Registra un préstamo recibido u otorgado, con su desembolso opcional', { body: s.loanCreate, idempotent: true, status: 201 }),
  D('post', '/loans/{id}/payments/preview', 'Préstamos', 'Vista previa de un pago: a qué cargos se aplica (propuesta o elegida) y el sobrante', { body: s.loanPaymentBody }),
  D('post', '/loans/{id}/payments', 'Préstamos', 'Registra un pago: UN movimiento real aplicado a los cargos elegidos', { body: s.loanPaymentCreate, idempotent: true, status: 201 }),
  D('post', '/loan-payments/{id}/reverse', 'Préstamos', 'Revierte un pago de préstamo', { body: s.reasonBody, idempotent: true }),
  D('post', '/loans/{id}/payoff/preview', 'Préstamos', 'Cálculo del pago anticipado (interés acordado o solo el devengado)', { body: s.loanPayoffBody }),
  D('post', '/loans/{id}/payoff', 'Préstamos', 'Cancela el préstamo con un pago anticipado', { body: s.loanPayoffCreate, idempotent: true, status: 201 }),
  D('post', '/loans/{id}/late-fees/preview', 'Préstamos', 'Cálculo previo de la mora por períodos vencidos', { body: s.lateFeeBody }),
  D('post', '/loans/{id}/late-fees', 'Préstamos', 'Aplica la mora calculada (solo si se confirma)', { body: s.lateFeeCreate, idempotent: true }),
  D('post', '/loans/{id}/capitalize/preview', 'Préstamos', 'Interés vencido que se podría capitalizar'),
  D('post', '/loans/{id}/capitalize', 'Préstamos', 'Capitaliza el interés vencido y sin pagar (solo si se confirma)', { body: s.tokenOnly, idempotent: true }),
  D('post', '/loans/{id}/cancel', 'Préstamos', 'Anula un préstamo sin pagos (revierte el desembolso)', { body: s.reasonBody, idempotent: true }),
  D('get', '/accounts/{id}/credit-details', 'Tarjetas', 'Línea, día de corte y día de pago de la tarjeta'),
  D('post', '/accounts/{id}/credit-details', 'Tarjetas', 'Configura la tarjeta (la línea no es dinero propio)', { body: s.creditDetails }),
  D('get', '/accounts/{id}/statements', 'Tarjetas', 'Estados de cuenta con pagos vinculados y estado derivado'),
  D('post', '/accounts/{id}/statements', 'Tarjetas', 'Registra un estado de cuenta tal como lo informa el banco', { body: s.statementCreate, idempotent: true, status: 201 }),
  D('get', '/card-statements/{id}', 'Tarjetas', 'Detalle de un estado de cuenta'),
  D('post', '/card-statements/{id}/void', 'Tarjetas', 'Anula un estado de cuenta (motivo obligatorio)', { body: s.reasonBody }),
  D('post', '/card-statements/{id}/payments', 'Tarjetas', 'Vincula un pago (transferencia a la tarjeta) a un estado de cuenta', { body: s.statementPayment, idempotent: true, status: 201 }),
  D('post', '/card-statement-payments/{id}/remove', 'Tarjetas', 'Quita el vínculo de un pago con el estado de cuenta'),
  D('post', '/accounts/{id}/installment-purchases', 'Tarjetas', 'Compra en cuotas: un gasto por el total y su calendario de cuotas', { body: s.installmentPurchase, idempotent: true, status: 201 }),
  D('get', '/accounts/{id}/installment-plans', 'Tarjetas', 'Planes de cuotas de la tarjeta'),
  D('post', '/installment-plans/{id}/cancel', 'Tarjetas', 'Cancela un plan de cuotas'),
  D('get', '/cards/advisor', 'Tarjetas', 'Qué tarjeta da más días para pagar una compra de hoy (solo fechas)'),
  D('get', '/operations', 'Movimientos', 'Movimientos con filtros (estado, tipo, cuenta, categoría, sin categoría, fechas, texto)'),
  D('get', '/categories', 'Categorías', 'Árbol de categorías y subcategorías (dos niveles)'),
  D('post', '/categories', 'Categorías', 'Crea una categoría o subcategoría', { body: s.categoryCreate, status: 201 }),
  D('patch', '/categories/{id}', 'Categorías', 'Renombra o cambia ícono y color (el historial no se rompe)', { body: s.categoryPatch, ifMatch: true }),
  D('post', '/categories/{id}/archive', 'Categorías', 'Archiva la categoría y sus subcategorías'),
  D('post', '/categories/{id}/restore', 'Categorías', 'Restaura una categoría archivada'),
  D('get', '/classification-rules', 'Clasificación', 'Reglas del usuario por prioridad'),
  D('post', '/classification-rules', 'Clasificación', 'Crea una regla (condiciones + acción asignar/sugerir)', { body: s.ruleCreate, status: 201 }),
  D('patch', '/classification-rules/{id}', 'Clasificación', 'Edita una regla (no recategoriza historial)', { body: s.rulePatch, ifMatch: true }),
  D('post', '/classification-rules/{id}/archive', 'Clasificación', 'Archiva una regla'),
  D('post', '/classification-rules/{id}/restore', 'Clasificación', 'Restaura una regla'),
  D('post', '/classification/suggest', 'Clasificación', 'Qué regla aplicaría a un movimiento (ganadora y demás coincidencias)', { body: s.classificationSuggest }),
  D('post', '/classification/apply/preview', 'Clasificación', 'Vista previa de clasificar los movimientos sin categoría con las reglas', { body: s.classificationApplyPreview }),
  D('post', '/classification/apply', 'Clasificación', 'Clasifica a petición los movimientos sin categoría (nunca toca lo ya clasificado)', { body: s.classificationApply, idempotent: true }),

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
