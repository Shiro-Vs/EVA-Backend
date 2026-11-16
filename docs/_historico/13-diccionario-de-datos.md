# EVA — Diccionario propuesto de datos

Fecha: 12 de octubre de 2026. Diseño lógico para revisión, no migración ejecutada. Complementa 03. Los nombres son orientativos; cerrar tipos/índices en esquema físico. Extensiones previstas no obligan a crear todas las tablas desde el primer despliegue.

## Convenciones

IDs estables UUID; propietario en datos privados y claves compuestas cuando sea necesario para impedir referencias cruzadas. Fechas de cobertura como fechas locales; auditoría/recepción como instantes UTC. Moneda explícita aun usando PEN inicialmente. Montos exactos decimales con dos decimales, cálculos intermedios de mayor precisión; nunca punto flotante para dinero. API representa decimales sin pérdida de precisión. Límites de importe y escala física se validan al cerrar esquema.

Toda entidad mutable necesita creación/actualización y versión para concurrencia. Operaciones financieras confirmadas conservan revisiones y reversiones; archivar contactos/cuentas no borra cargos. Estados explícitos, sin un solo booleano ambiguo «pagado». Reglas importantes tienen vigencia, autor y motivo; cada cálculo guarda entrada, base, días, redondeo y versión de regla.

## Núcleo: primera entrega

| Entidad | Datos mínimos propuestos | Relaciones y responsabilidad |
| --- | --- | --- |
| UserProfile | auth_id, zona, moneda, preferencias | Identidad externa y datos del administrador |
| Contact | propietario, nombre, teléfono/correo opcionales, estado | Persona administrada, distinta de usuario |
| Account | propietario, nombre, tipo, moneda, estado | Un único saldo real o deuda de crédito; no cuenta nueva por cada canal |
| PaymentChannel | nombre/proveedor, cuenta vinculada | Yape/Plin/tarjeta digital según ubicación real del dinero |
| OpeningBalance | cuenta, fecha, importe, naturaleza saldo/deuda | Apertura confirmada, sin inventar ingreso del mes |
| Category | propietario, nombre, padre, estado | Jerarquía y archivo sin perder clasificación histórica |
| FinancialOperation | tipo, fecha, descripción, contacto, fuente, estado, idempotency_key | Una operación confirmada: ingreso, gasto, transferencia, crédito, ajuste o reversión |
| AccountEntry | operación, cuenta, dirección, importe | Efecto real sobre saldo/deuda; transferencia vincula dos efectos |
| OperationItem | operación, categoría, concepto, importe | Desglose cuyo total coincide con operación clasificable |
| Subscription | propietario, nombre/proveedor, modalidad, capacidad, estado | Plan específico; admite dos Netflix distintos |
| SubscriptionTerms | servicio, vigencia, precio anunciado, intervalo/unidad, ancla, reglas | Versiones de precio y calendario; no sobrescribir ciclos anteriores |
| CalendarChange | servicio, antes/después, fecha efectiva, motivo | Transición revisada, incluyendo gracia/suspensión/reactivación |
| BillingCycle | servicio, inicio, fin, renovación, términos_snapshot | Cobertura explícita y reglas aplicadas |
| Membership | servicio, contacto o administrador, inicio/fin, estado | Participación; reingreso nuevo con historia anterior |
| Seat | participación, etiqueta, inicio/fin | Plaza identificable; capacidad cuenta plazas, incluida propia |
| SeatTerms | plaza, cuota, vigencia, excepciones | Cuota individual; contact total no reemplaza detalle |
| Courtesy | participación/plaza, inicio, fin o ciclos, tipo, motivo | Regalo temporal/permanente sin pago ficticio |
| MemberCharge | plaza, ciclo/tramo, vencimiento, base, neto, calculation_snapshot | Obligación cobrable, independiente del dinero recibido |
| ChargeAdjustment | cargo, importe firmado, motivo, autorización | Diferencia, descuento o corrección sin borrar origen |
| SupplierObligation | ciclo, precio anunciado | Lo previsto frente a pago real |
| SupplierPayment | ciclo, operación, importe real | Pago al proveedor enlazado a gasto/compra con crédito |
| Receipt | contacto, operación, importe | Un cobro real, aunque cubra varias deudas; nunca segundo ingreso |
| PaymentAllocation | recibo, obligación destino, importe, estado | Parte aplicada a cargo o componente de préstamo |
| CreditReservation | recibo, destino por defecto, importe reservado, cobertura preferida | Anticipo no aplicado; mover reserva no crea dinero |
| Refund | recibo origen, importe, estado, operación de salida | Devolución prevista distinta de dinero ya devuelto |
| Loan | contacto/contraparte, dirección, principal, términos, estado | Préstamo mínimo necesario para deuda retirada; extensible a préstamos completos |
| LoanComponent | préstamo, tipo, importe, vencimiento, origen | Conceptos detallados: Netflix marzo, Netflix abril, capital/interés |
| DebtConversion | préstamo, fecha, motivo | Reclasificación atómica sin efectivo |
| DebtConversionItem | conversión, cargo origen, importe pendiente | Conserva trazabilidad y cierra pendiente original una sola vez |
| AuditEvent | autor, acción, entidad, fecha, motivo, cambios pertinentes | Historial sin secretos ni copia indiscriminada de documentos |

Los nombres MoneyMovement, MovementItem y ReceivedPayment del modelo 03 se concretan aquí como FinancialOperation + AccountEntry, OperationItem y Receipt. Son niveles del mismo diseño, no tablas duplicadas. Antes del esquema físico unificar nombres en código.

### Obligaciones y aplicaciones

Propuesta: una tabla común ReceivableObligation identifica deudas a favor del administrador; MemberCharge y LoanComponent se vinculan a ella. PaymentAllocation apunta a esa clave verificable. Para deudas que EVA debe pagar usar obligaciones de salida separadas o dirección explícita y validada; no aplicar ingreso de contacto a deuda bancaria por una referencia genérica sin validación.

Evitar pares libres «tipo + ID» que permitan apuntar a una entidad inexistente. Un recibo puede repartirse entre varios servicios/préstamos, con suma aplicada y reservada controlada. Las conversiones no son cobros. El pendiente debe descontar aplicaciones, ajustes y reclasificación activa, sin restar dos veces la misma parte.

### Fórmulas y conservación

- Pendiente de obligación = neto emitido + ajustes activos − aplicaciones activas − parte reclasificada; nunca negativo por sobreaplicación.
- Crédito disponible = cobro real − aplicaciones activas − devoluciones reales − reservas activas. Reserva cambia disponibilidad de destino, no el total de dinero a favor del contacto.
- Total de crédito del contacto = cobros − aplicaciones − devoluciones; separar disponible/reservado. No restar una reserva dos veces al aplicar.
- Saldo/deuda de cuenta se reconstruye desde apertura y efectos activos; cualquier caché debe coincidir. Crédito usa convenciones de signo documentadas.
- Componentes de una compra suman su total. Distribuir centavos residuales de forma determinista; no elevar cada fragmento si crea dinero inexistente.
- Cargo por plaza/ciclo/tipo y emisión programada tienen clave única para impedir duplicado por reintento.

## Extensiones del alcance completo

| Módulo | Entidades propuestas | Datos y restricciones esenciales |
| --- | --- | --- |
| Préstamos completos | LoanTerms, LoanInstallment, InterestAccrual, Capitalization | Base original/pendiente, tasa/fijo/frecuencia, prioridad de abono, cierre anticipado; capitalización solicitada y referencias al interés convertido |
| Bancarios | LoanDocument, ScheduleRevision | Origen/confirmación de datos, cuotas capital/interés/seguro/comisión, fechas informadas y revisiones |
| Crédito | CreditAccountDetails, CardStatement, CardPurchase, CardInstallment, CardPaymentAllocation | Extensión de Account sin saldo duplicado; corte/vencimiento, deuda real y seguimiento de cuotas |
| Clasificación | ClassificationRule, RuleCondition, RuleAction | Orden/prioridad y excepciones; reglas antes que IA, no reemplazar corrección manual |
| Presupuesto | Budget, BudgetPeriod, BudgetThreshold | Límite, período, arrastre opcional, vista caja/ciclo; reglas parentales sin doble consumo |
| Metas | Goal, GoalReservation, GoalContribution | Objetivo, fecha opcional, reservas en cuentas reales; no nuevo saldo ni reserva ilimitada |
| Recurrencia | RecurringTemplate, ExpectedOccurrence | Fecha prevista, propuesta y vínculo con operación confirmada; no movimientos automáticos |
| Conciliación | Reconciliation, ReconciliationItem | Saldo informado, diferencias, registros revisados y ajuste confirmado |
| Captura | InboxSource, SourceDocument, ExtractionRun, MovementProposal, EvidenceLink | Fuente privada, estado/error, resultado, confirmación, vínculo a existente; una fuente puede originar varias propuestas |
| Duplicados | DuplicateCandidate, SourceDelivery | Coincidencia revisable distinta de reentrega exacta idempotente |
| IA | AnalysisRequest, AnalysisResult, ChatSession, UsageRecord | Datos/período seleccionados, modelo/fecha, consumo y límites; no herramienta que altere dinero sola |
| Reportes | ReportDefinition, ReportSnapshot, ExportJob | Filtros/secciones/orden, versión guardada, generación y vencimiento de descarga |
| Respaldos | BackupPolicy, BackupRun, RestoreJob | Frecuencia, retención, manifiesto/versiones, archivos opcionales y vista previa de restauración |
| Avisos | NotificationPreference, Reminder, DeliveryAttempt | Horarios, privacidad y deduplicación; textos a contactos se comparten por acción manual |

No crear tablas vacías de cada ampliación por anticipación. Conservar desde el inicio IDs, propietario, fechas, moneda, procedencia y operaciones/aplicaciones separadas: eso permite agregar módulos sin reemplazar el núcleo.

## Transacciones que deben ser indivisibles

1. Confirmar cobro y registrar efectos, desgloses y aplicaciones validadas.
2. Retirar participante y convertir únicamente pendientes seleccionados; no perder deuda ni duplicarla.
3. Confirmar devolución y liberar cobertura/crédito correspondiente, con salida real.
4. Revertir/corregir operación y reconstruir aplicaciones dependientes con vista previa.
5. Emitir renovación una vez, respetando términos y cambios efectivos.
6. Aceptar propuesta y asociar evidencias una vez, aunque móvil reintente.

Reintento con misma clave devuelve resultado existente. Edición con versión obsoleta exige recargar/revisar. Fallo del lote no rompe una operación individual. Sin conexión no se crea cola de nuevas escrituras.

## Esquema físico siguiente

Elegir enums y restricciones, relaciones verificables, índices por propietario/fecha/estado, restricciones de capacidad y períodos, política de borrado/retención y SQL transaccional. Revisar schema Prisma antiguo, generar migración inicial PostgreSQL en entorno de desarrollo y comprobar escenarios de 14. Documentar versiones reales de herramientas al hacerlo; esta planificación no valida compatibilidad de una instalación anterior.
