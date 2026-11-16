# 13 — Contrato de API (v1)

Contrato REST de la **Entrega 1** (con las rutas de la E2 marcadas). Es contract-first: el archivo `openapi.json` se genera de los esquemas Zod del backend y el frontend genera sus tipos a partir de él (T-04, T-09). Los ejemplos son normativos para formato y nombres.

## 1. Convenciones generales

| Aspecto | Regla |
| --- | --- |
| Base | `https://<host>/v1` (en local `http://IP:PUERTO/v1`) |
| Formato | JSON UTF-8, claves `camelCase` |
| Autenticación | `Authorization: Bearer <JWT>`. El `ownerId` sale del token, **nunca** del cuerpo. |
| Dinero | Cadena decimal con 2 decimales: `"20.00"`. Campo hermano `currency: "PEN"` donde aplique. |
| Fechas locales | `"2026-10-07"` (`date`, zona del propietario). |
| Instantes | ISO 8601 UTC: `"2026-10-12T21:30:00Z"`. |
| IDs | UUID en cadena. |
| "Hoy" | Lo decide el servidor. El cliente no envía su fecha para reglas de negocio. |
| Cabeceras de respuesta | `X-Request-Id` siempre. `ETag: "<version>"` en recursos mutables. |
| Versión de recurso | `If-Match: "<version>"` en `PATCH`/`PUT`. Obsoleta → `409 CONFLICT_VERSION`. |
| Paginación | Cursor: `?limit=50&cursor=…` → `{ "items": [...], "nextCursor": "…" | null }`. `limit` máx. 200. |
| Orden | `?sort=-occurredOn` (prefijo `-` descendente), solo campos permitidos por recurso. |
| IDs ajenos | `404 NOT_FOUND` (nunca 403) para no revelar existencia. |

### 1.1 Idempotencia

Toda petición `POST` que cree efectos financieros **exige** `Idempotency-Key: <uuid>` (8–128 caracteres).

| Situación | Respuesta |
| --- | --- |
| Primera vez | Se ejecuta y se guarda `(ownerId, key, endpoint, hash del cuerpo, respuesta)` |
| Misma clave + mismo cuerpo | Devuelve **la respuesta guardada** (mismo código y cuerpo), sin repetir efectos |
| Misma clave + cuerpo distinto | `422 IDEMPOTENCY_KEY_REUSED` |
| Sin cabecera en un `POST` financiero | `422 IDEMPOTENCY_KEY_REQUIRED` |
| Pérdida de conexión | El cliente **reenvía con la misma clave**, o consulta el recurso por ID, antes de crear algo nuevo (RN-OF05) |

### 1.2 Vistas previas y `previewToken`

Las operaciones con cálculo (alta de servicio, incorporación, cobro, baja, cambios de cuota/calendario) tienen un par:

1. `POST …/preview` — devuelve el cálculo **sin efectos** y un `previewToken` (firma de: entradas normalizadas, versión de las reglas del motor y versiones de las filas relevantes).
2. `POST …` — recibe las **mismas entradas** más `previewToken`. Si el estado cambió entre ambos pasos (otro cobro, otra versión de cuota…) responde `409 PREVIEW_STALE` con el nuevo cálculo para que el usuario lo revise (RN-CA05). Nunca aplica en silencio algo distinto de lo mostrado.

El `previewToken` caduca a los 10 minutos.

> **Implementado y verificado el 14-oct-2026.** El contrato máquina-legible está en `EVA-Backend/openapi.json` (generado con `npm run openapi` desde los esquemas Zod; una prueba falla si una ruta no está documentada o el archivo está desactualizado). Diferencias respecto a este borrador: `POST /receipts/preview` devuelve **200 con `valid:false` y `issues`** (sin `previewToken`) cuando el reparto no es válido, y la validación del reparto ocurre **antes** de comprobar el token (así una sobreaplicación concurrente responde `OVER_ALLOCATION`). `POST /contacts` no exige `Idempotency-Key`. Se añadieron `GET /subscriptions/{id}/seats`, `GET /seats/{id}`, `GET /contacts/{id}/credit`, `POST /allocations/{id}/release` (deshacer la aplicación automática de una reserva) y `GET /operations/{id}`.

## 2. Recursos y rutas (E1)

Leyenda: 🔒 exige `Idempotency-Key` · ⏩ vista previa disponible · **[E2]** se implementa en la E2.

### Perfil

| Método y ruta | Descripción |
| --- | --- |
| `GET /me` | Perfil y preferencias (`defaultFreeDays`, `exitDaysLimit`, zona). Crea el perfil en el primer acceso. |
| `PATCH /me` | Actualiza nombre, `defaultFreeDays`, `exitDaysLimit`, preferencias. |

### Cuentas

| Método y ruta | Descripción |
| --- | --- |
| `GET /accounts` | Lista con saldo calculado. Filtro `status`. |
| `POST /accounts` 🔒 | Crea cuenta con **saldo inicial** opcional (genera operación `opening`). |
| `GET /accounts/{id}` | Detalle y saldo. |
| `PATCH /accounts/{id}` | Nombre, color, icono, `isDefault`, `excludeFromTotal`. `If-Match`. |
| `POST /accounts/{id}/archive` | Archiva (no borra). |
| `GET /accounts/{id}/entries` | Asientos paginados (con operación y saldo acumulado). |
| `POST /operations` 🔒 | Ingreso, gasto o transferencia manual (E1: uso mínimo). |

### Contactos

| Método y ruta | Descripción |
| --- | --- |
| `GET /contacts` | Lista con **deuda total**, crédito y nº de servicios. |
| `POST /contacts`, `GET /contacts/{id}`, `PATCH /contacts/{id}`, `POST /contacts/{id}/archive` | CRUD básico. |
| `GET /contacts/{id}/statement` | **Estado de cuenta** por servicio → plaza → ciclo, con cargos, aplicaciones y crédito. |

### Servicios

| Método y ruta | Descripción |
| --- | --- |
| `POST /subscriptions/preview` ⏩ | Verifica calendario (RN-C03), sugiere cuota, muestra ciclo 1 y 2. |
| `POST /subscriptions` 🔒 | Crea servicio + términos + ciclos iniciales + plaza del administrador. |
| `GET /subscriptions` | Lista con ocupación, próximo vencimiento, pendiente total. |
| `GET /subscriptions/{id}` | Detalle: términos vigentes, ciclo actual y siguiente, plazas, resumen de costo. |
| `PATCH /subscriptions/{id}` | Nombre, proveedor, color, icono, cuenta preferida. `If-Match`. |
| `POST /subscriptions/{id}/archive` | Archiva el servicio. |
| `GET /subscriptions/{id}/cycles` | Ciclos (con cargos y resumen de costo por ciclo). |
| `POST /subscriptions/{id}/cycles/generate` 🔒 | Emite ciclos por adelantado (`ahead: 1..12`). Idempotente. |
| `GET /billing-cycles/{id}` | Ciclo con cargos, pago al proveedor y `costSummary`. |
| `GET /subscriptions/{id}/terms` ✅ | Versiones de precio y calendario con su vigencia. |
| `POST /subscriptions/{id}/price-change/preview` ⏩ · `POST /subscriptions/{id}/price-change` 🔒 ✅ **[E2, implementado]** | Cambio de precio del proveedor desde el inicio de un ciclo futuro (`effectiveFrom`). La vista previa **propone** `suggestedQuota` (`ceil(precio / plazas ocupadas)`) y por plaza `currentQuota`/`proposedQuota`; con `quotas: [{seatId, quota}]` muestra además los ajustes y el crédito liberado. Aplicar cambia el precio, los ciclos desde esa fecha y **solo** las cuotas confirmadas (RN-Q03/Q04), reutilizando el cambio de cuota (`mode`: `per_renewal`/`lump`). Errores: `PRICE_UNCHANGED`, `PRICE_CHANGE_EXISTS`, `PRICE_CHANGE_BLOCKED` (ciclo ya pagado al proveedor), `SEAT_NOT_IN_PROPOSAL`, `QUOTA_CHANGE_EXISTS`, más los de fecha de cuota. |
| `POST /subscriptions/{id}/calendar-changes/preview` ⏩ · `POST /subscriptions/{id}/calendar-changes` 🔒 · `GET /subscriptions/{id}/calendar-changes` ✅ **[E2, implementado]** | `kind`: `shift_renewal` / `advance_renewal` (`newDate`), `change_interval` (`interval`, rige desde la próxima renovación), `suspend`, `reactivate` (`renewalDate`). La vista previa lista ciclos y vencimientos afectados con `amountsUnchanged: true`. Errores: `NEW_DATE_NOT_FUTURE`, `NEW_DATE_BEFORE_CYCLE_START`, `NEW_DATE_UNCHANGED`, `ADVANCE_NOT_EARLIER`, `NO_CURRENT_CYCLE`, `INTERVAL_UNCHANGED`, `SUBSCRIPTION_SUSPENDED`, `SUBSCRIPTION_NOT_SUSPENDED`, `REACTIVATE_DATE_INVALID`, `CALENDAR_CHANGE_BLOCKED` (ciclos futuros con cargos o pago), `CALENDAR_CHANGE_UNSUPPORTED` (cambio de precio programado alrededor del ciclo). |

### Plazas y participantes

| Método y ruta | Descripción |
| --- | --- |
| `POST /subscriptions/{id}/seats/preview` ⏩ | Incorporación: devuelve `r`, `B`, `g`, prorrateo, modo, vencimiento y advertencias. |
| `POST /subscriptions/{id}/seats` 🔒 | Alta de participación/plaza con cuota y primer cargo. Valida **capacidad**. |
| `GET /seats/{id}` | Plaza con historial de cuotas y cargos. |
| `POST /seats/{id}/quota-change/preview` ⏩ · `POST /seats/{id}/quota-change` 🔒 ✅ **[E2, implementado]** | Cambio de cuota **solo desde el inicio de un ciclo futuro** (`effectiveFrom`), modo `per_renewal` o `lump`. La vista previa lista un ajuste por cargo ya emitido (`nueva − cuota con que se emitió`), su vencimiento y el crédito que se libera si la cuota baja. Errores: `EFFECTIVE_DATE_PAST`, `EFFECTIVE_DATE_NOT_CYCLE_START` (con `availableDates`), `QUOTA_UNCHANGED`, `QUOTA_CHANGE_EXISTS`, `QUOTA_OWNER_SEAT`, `NO_QUOTA_AT_DATE`. `GET /seats/{id}` añade `scheduledQuota {quota, from}`. |
| `POST /seats/{id}/courtesies/preview` · `POST /seats/{id}/courtesies` 🔒 (con `debtHandling: keep|convert`; si la plaza ya debe, **es obligatorio** → `DEBT_HANDLING_REQUIRED`; `convert` crea el préstamo y devuelve `loanId`) · `GET /seats/{id}/courtesies` · `POST /courtesies/{id}/end` 🔒 ✅ **[E2, implementado]** | Cortesía por ciclos / hasta una fecha / permanente, **desde el siguiente ciclo**. Los cargos ya emitidos dentro de la ventana se eximen solo si no tienen cobros ni ajustes (`COURTESY_CHARGE_ALREADY_APPLIED`). Errores: `COURTESY_ALREADY_ACTIVE`, `COURTESY_OWNER_SEAT`, `COURTESY_UNTIL_BEFORE_START`, `COURTESY_NOT_ACTIVE`, `NO_NEXT_CYCLE`, `SEAT_ENDED`. La vista previa informa `existingDebt`, `debtChoiceRequired` y `debtOptions`. |
| `POST /seats/{id}/exit/preview` ⏩ · `POST /seats/{id}/exit` 🔒 ✅ **[E2, implementado]** | Baja de una plaza (RN-X01…X07). La vista previa devuelve `mode` (`finish_cycle`/`immediate`), `reasonCode` (`SUPPLIER_PAID`, `NO_LIMIT_DEFINED`, `LIMIT_REACHED`, `EARLY_EXIT`), `effectiveOn`, `currentCharge` (cobro proporcional y ajuste), `voidedCharges`, `refunds` y `loan`; avisa `REFUND_AND_DEBT` si hay crédito devuelto y deuda a la vez. La ejecución es atómica. Errores: `EXIT_OWNER_SEAT`, `SEAT_ALREADY_ENDING`, `NO_CURRENT_CYCLE`. `GET /seats/{id}` añade `voidedCharges`. |

### Cobros y crédito

| Método y ruta | Descripción |
| --- | --- |
| `POST /receipts/preview` ⏩ | Valida y muestra el reparto, el sobrante y la reserva. |
| `POST /receipts` 🔒 | **Un ingreso real** + aplicaciones + reserva del sobrante. Atómico. |
| `GET /receipts/{id}` | Cobro con su reparto, disponibilidad y estado. |
| `POST /accounts/{id}/credit-details` · `GET …` ✅ **[E3]** | Configura la tarjeta: línea (opcional, no es dinero propio), día de corte y día de pago. `GET /accounts/{id}` de una tarjeta añade `credit {creditLine, used, available, cutoffDay, dueDay}`. Error: `NOT_CREDIT_ACCOUNT`. |
| `GET/POST /accounts/{id}/statements` · `GET /card-statements/{id}` · `…/void` ✅ | Estados de cuenta tal como los informa el banco (corte ≠ pago; `periodTotal` no es toda la deuda; `totalBalance` opcional). Estado derivado `unpaid/partial/paid`, `overdue`, `minimumCovered`. Errores: `STATEMENT_EXISTS`, `STATEMENT_DATES`. |
| `POST /card-statements/{id}/payments` · `POST /card-statement-payments/{id}/remove` ✅ | Vincula una transferencia hacia la tarjeta a un estado de cuenta (no crea operaciones). Errores: `NOT_A_CARD_PAYMENT`, `PAYMENT_ALREADY_LINKED`. |
| `POST /accounts/{id}/installment-purchases` · `GET /accounts/{id}/installment-plans` · `POST /installment-plans/{id}/cancel` ✅ | Compra en cuotas: **un** gasto por el total y un calendario (`distribute`, mismo día del mes). |
| `GET /cards/advisor` ✅ | Qué tarjeta da más días hasta pagar una compra de hoy (o de `date`), solo con fechas de corte y pago. |
| `GET /operations` ✅ **[E3]** (cada movimiento trae `concept`; `GET /summary` añade `loans {lentPending, borrowedPending}`) | Movimientos con filtros: `status`, `kind`, `accountId`, `categoryId`, `uncategorized` (excluye cobros y devoluciones, RN-CL08), `from`, `to`, `q`, paginado. |
| `GET /categories` · `POST /categories` · `PATCH /categories/{id}` · `POST /categories/{id}/archive` · `…/restore` ✅ **[E3]** | Árbol de dos niveles (D-29). El perfil nuevo trae las categorías sugeridas. Errores: `CATEGORY_DEPTH_EXCEEDED`, `CATEGORY_NAME_EXISTS`, `CATEGORY_ARCHIVED`. Archivar una raíz archiva sus subcategorías; una categoría archivada no se asigna ni clasifica. |
| `GET/POST /classification-rules` · `PATCH /classification-rules/{id}` · `…/archive` · `…/restore` ✅ **[E3]** | Reglas: condiciones opcionales (cuenta, dirección, importe mín./máx., texto) —al menos una— y acción `assign`/`suggest`. Gana la de menor `priority`; a igualdad, la más antigua (D-14). Errores: `RULE_WITHOUT_CONDITION`, `RULE_AMOUNT_RANGE`. |
| `POST /classification/suggest` ✅ | Devuelve la regla ganadora y las demás coincidencias para un movimiento hipotético. |
| `POST /classification/apply/preview` · `POST /classification/apply` ✅ | Reclasifica **a petición** los movimientos sin categoría con las reglas (RN-CL07); nunca toca lo ya clasificado ni los cobros. |
| `POST /operations` ✅ | Si no se indica `categoryId`, aplica las reglas: `assign` fija la categoría y `suggest` solo la devuelve en `classification`. `GET /operations/{id}` añade `category` y `classificationTrail`. |
| `GET /contacts/{id}/receipts` ✅ | Cobros del contacto (más recientes primero) con `free`/`unapplied` de cada uno. `GET /operations/{id}` añade `links {receiptId, supplierPaymentId, refundId}` para llegar al registro que la originó. |
| `GET /contacts/{id}/credit` | Crédito del contacto: reservado/libre por servicio. |
| `POST /credit-reservations/{id}/move` 🔒 | Traslada el destino de una reserva a otro servicio. |
| `POST /allocations/{id}/release` 🔒 **[E2]** | Libera una aplicación (con motivo). |
| `POST /receipts/{id}/reverse/preview` ⏩ · `POST /receipts/{id}/reverse` 🔒 ✅ **[E2, implementado]** | Revierte un cobro: anula el ingreso, libera sus aplicaciones y las deudas vuelven a quedar pendientes. No devuelve dinero. `GET /receipts/{id}` de un cobro revertido devuelve `availability: null`. |
| `POST /receipts/{id}/correct/preview` ⏩ · `POST /receipts/{id}/correct` 🔒 ✅ **[E2, implementado]** | Corrige importe, cuenta, fecha y/o reparto (A24): vista de efectos (saldos por cuenta, aplicaciones liberadas y reconstruidas, sobrante y reserva) y, al aplicar, reversión del original + cobro nuevo en una transacción. Si el reparto anterior ya no cabe, la vista previa devuelve `valid:false` con `issues` y el usuario elige uno nuevo (`allocations`). Errores: `NO_CHANGES`, `ALREADY_REVERSED`, `RECEIPT_HAS_REFUNDS`, `OVER_ALLOCATION`. |
| `PATCH /receipts/{id}` (If-Match) ✅ | Corrige la nota del cobro sin efecto financiero (RN-V01). |
| `PATCH /operations/{id}` (If-Match) ✅ | Corrige descripción, categoría o contacto sin efecto financiero (RN-V01); no edita operaciones revertidas (`OPERATION_NOT_EDITABLE`) ni cambia el contacto de una operación ligada (`OPERATION_LINKED`). |
| `POST /operations/{id}/correct/preview` ⏩ · `POST /operations/{id}/correct` 🔒 ✅ | Corrige importe, cuenta(s) o fecha de un ingreso, gasto o transferencia: reversión + operación nueva, con vista de efectos por cuenta. Las ligadas a cobros, devoluciones o pagos al proveedor se corrigen por su propio registro (`OPERATION_LINKED`). |
| `GET /refunds` · `POST /refunds` 🔒 · `POST /refunds/{id}/pay` 🔒 · `POST /refunds/{id}/cancel` 🔒 ✅ **[E2, implementado]** | Devoluciones: se **programan** (`planned`), la salida real es un egreso desde una cuenta (`paid`) o se cancelan y el dinero vuelve a ser crédito libre. Errores: `REFUND_EXCEEDS_FREE_CREDIT`, `REFUND_NOT_PLANNED`. |
| `POST /subscriptions/{id}/switch-to-individual/preview` · `POST /subscriptions/{id}/switch-to-individual` 🔒 ✅ **[E2, implementado]** | Compartido → individual (RN-X08): termina todas las plazas de terceros al final del ciclo en curso (cada una con su baja, devolución y préstamo), deja el servicio `personal` desde ya y registra solicitud, efectividad y devoluciones por separado. |
| `POST /contacts/{id}/debt-conversion/preview` · `POST /contacts/{id}/debt-conversion` 🔒 ✅ **[E2, implementado]** | Conversión manual de cargos pendientes en un préstamo con detalle (la deuda total no cambia). Errores: `NOTHING_TO_CONVERT`, `NOT_CONVERTIBLE`, `OBLIGATION_CONTACT_MISMATCH`. |
| `/recurring/templates` (GET/POST/PATCH, `pause`, `resume`, `archive`) · `GET /recurring/pending` · `POST /recurring/occurrences/{id}/confirm|skip|link|reopen` ✅ **[E3]** | Recurrencias: la plantilla **propone** ocurrencias vencidas; solo `confirm` registra el movimiento real; `link` vincula uno existente sin crear otro. |
| `POST /accounts/{id}/reconciliation/preview` · `POST …/reconciliation` · `GET …/reconciliations` ✅ **[E3]** | Conciliación: diferencia real − registrado a una fecha, qué revisar y, solo con motivo, un ajuste `adjustment` (concepto `reconciliation`) en línea propia. |
| `GET/POST /goals` · `GET/PATCH /goals/{id}` · `…/archive` · `…/restore` ✅ **[E3]** | Metas: objetivo, fecha opcional y avance medido con lo **reservado** (`saved`, `percent`, `achieved`). `GET /goals/overview` da por cuenta `total / reserved / free` y avisa `overReserved`. |
| `POST /goals/{id}/reserve` · `…/release` · `…/link-transfer` ✅ | Reservar o liberar dinero que ya está en una cuenta (**no crea operaciones** ni cambia saldos; A21) y vincular una transferencia real de ahorro (queda reservada en la cuenta de destino). Errores: `INSUFFICIENT_FREE_BALANCE`, `GOAL_ACCOUNT_TYPE`, `RELEASE_EXCEEDS_RESERVED`, `TRANSFER_ALREADY_LINKED`, `NOT_A_TRANSFER`. |
| `POST /operations` (gasto o transferencia que usa dinero reservado) ✅ | Responde `422 GOAL_RESERVE_CONFLICT` con `eaten` y las metas afectadas **antes** de registrar nada; se reenvía con `goalDeductions: [{goalId, amount}]` (descuenta de esas metas) o `acceptReserveShortfall: true` (acepta que lo reservado supere el saldo). |
| `GET/POST /budgets` · `GET /budgets/{id}` · `GET /budgets/{id}/history` · `PATCH /budgets/{id}` · `…/archive` · `…/restore` ✅ **[E3]** | Presupuestos: límite por categoría (con o sin subcategorías) o **general**, período `weekly`/`monthly`/`yearly`, avisos (por defecto 80 % y 100 %), arrastre opcional con tope y vista de cobros de servicios compartidos (`origin_cycle`/`receipt_date`). `current` trae `limit`, `carry`, `available`, `spent`, `remaining`, `percent`, `level`, `exceeded` y `breakdown`. Un límite nuevo rige desde el período actual. Error: `BUDGET_EXISTS`, `ROLLOVER_REQUIRED`. `POST /operations` de un gasto devuelve `budgetImpact` (avisos que **no bloquean**). `subscription.categoryId` define la categoría del pago al proveedor. |
| `POST /loans/preview` · `POST /loans` ✅ **[E3]** | Préstamo **recibido u otorgado** (`direction`): contacto o entidad (`counterpartyName`), capital, interés (`none`/`fixed` por período/`percent` por período sobre base `original` o `pending`), devolución (`installments`, `final_date`, `open`), orden de pago (`capital_first`/`interest_first`) y pago anticipado (`keep`/`accrued`). `accountId` registra el desembolso como operación `concept: loan_disbursement` (ni ingreso ganado ni gasto de consumo). |
| `POST /loans/{id}/payments/preview` · `POST /loans/{id}/payments` · `POST /loan-payments/{id}/reverse` ✅ | Un pago es **un** movimiento real (`concept: loan_payment`) aplicado a los cargos que el usuario elige; si no elige, el servidor **propone** (antigüedad; capital→interés) y lo declara en `proposedByServer`. El sobrante se rechaza salvo `onRemainder: "keep"` (saldo a favor, `credit`). Errores: `EXCEEDS_CHARGE`, `REMAINDER`, `LOAN_NOT_OPEN`. |
| `POST /loans/{id}/payoff/preview` · `…/payoff` ✅ | Pago anticipado: `keep` paga el interés acordado; `accrued` solo lo devengado (períodos cumplidos completos y el actual por días, base 30). |
| `POST /loans/{id}/late-fees/preview` · `…/late-fees` ✅ | Mora por período vencido (importe fijo o % de lo vencido): se calcula en vista previa y solo se aplica al confirmar; una vez por cargo y período. |
| `POST /loans/{id}/capitalize/preview` · `…/capitalize` ✅ · `POST /loans/{id}/cancel` ✅ | Capitalizar interés vencido sin pagar (solo a petición); anular un préstamo sin pagos (revierte el desembolso). |
| `GET /loans` · `GET /loans/{id}` ✅ **[E2, implementado]** | Préstamos otorgados por conversión de deuda, con componentes (concepto, ciclo, origen) y saldo derivado (`open`/`closed`). Sus componentes se pagan con un cobro normal (`POST /receipts`). El estado de cuenta (`loans`) los incluye. |

### Pago al proveedor y costo

| Método y ruta | Descripción |
| --- | --- |
| `POST /billing-cycles/{id}/supplier-payment` 🔒 | Pago real del ciclo (cuenta o tarjeta, monto exacto, fecha real). |
| `POST /supplier-payments/{id}/reverse` 🔒 | Revierte (motivo obligatorio). |
| `GET /subscriptions/{id}/cost-summary?cycleId=` | Costo previsto, según cobros, pendiente, excedente. |

### Auditoría

`GET /audit?entityType=&entityId=` — eventos de una entidad (solo lectura).

## 3. Errores

Formato único:

```json
{
  "error": {
    "code": "OVER_ALLOCATION",
    "message": "La suma aplicada supera el importe del cobro.",
    "details": [{ "field": "allocations[1].amount", "issue": "exceeds_available", "available": "10.00" }],
    "requestId": "7c1f…"
  }
}
```

`message` es técnico (inglés o español neutro); la app muestra su propio texto en español según `code`.

| HTTP | `code` | Cuándo |
| --- | --- | --- |
| 400 | `MALFORMED_REQUEST` | JSON inválido |
| 401 | `UNAUTHENTICATED` | Token ausente, vencido o inválido |
| 404 | `NOT_FOUND` | No existe **o pertenece a otro usuario** |
| 409 | `CONFLICT_VERSION` | `If-Match` obsoleto |
| 409 | `PREVIEW_STALE` | El estado cambió desde la vista previa (incluye el cálculo nuevo) |
| 409 | `CONCURRENT_UPDATE` | Conflicto de bloqueo/serialización; reintentar |
| 422 | `VALIDATION_ERROR` | Esquema inválido (detalles por campo) |
| 422 | `IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_KEY_REUSED` | Ver §1.1 |
| 422 | `CALENDAR_MISMATCH_UNCONFIRMED` | La fecha informada difiere de la calculada y falta `confirmCalendarMismatch` |
| 422 | `CAPACITY_EXCEEDED` | No hay plazas libres a esa fecha |
| 422 | `JOIN_OUT_OF_CYCLE` | La fecha de ingreso no cae dentro del ciclo vigente |
| 422 | `OVER_ALLOCATION` | Aplicación mayor al disponible del cobro **o** al pendiente del cargo |
| 422 | `ALLOCATION_CONTACT_MISMATCH` | El cobro y el cargo son de contactos distintos |
| 422 | `CURRENCY_MISMATCH` | Monedas distintas |
| 422 | `INSUFFICIENT_CREDIT` | Mover/aplicar más crédito del libre |
| 422 | `ALREADY_REVERSED` | La operación ya fue revertida |
| 422 | `SUPPLIER_PAYMENT_EXISTS` | El ciclo ya tiene pago activo |
| 422 | `ACCOUNT_ARCHIVED` / `CONTACT_ARCHIVED` | Uso de entidad archivada |
| 428 | `PRECONDITION_REQUIRED` | Falta `If-Match` en un `PATCH` |
| 422 | `PREVIEW_REQUIRED` / `PREVIEW_INVALID` / `PREVIEW_MISMATCH` | Falta el `previewToken`, es inválido/ajeno, o las entradas difieren de las previsualizadas |
| 409 | `PREVIEW_STALE` | El token caducó (10 min) o el estado cambió desde la vista previa |
| 422 | `OPERATION_LINKED` | La operación respalda un cobro, devolución o pago al proveedor: se revierte ese registro |
| 422 | `OBLIGATION_NOT_PAYABLE` | El cargo está cancelado o no admite pagos |
| 422 | `SUBSCRIPTION_PERSONAL` / `SUBSCRIPTION_ARCHIVED` | Plazas de terceros en un servicio personal, o servicio archivado |
| 422 | `ALREADY_RELEASED` / `RESERVATION_NOT_ACTIVE` | Aplicación ya liberada / reserva consumida |
| 422 | `SUBSCRIPTION_HAS_ACTIVE_SEATS` / `CONTACT_HAS_ACTIVE_SEATS` | Archivar con plazas activas (D-32) |
| 422 | `FUTURE_DATE_NOT_ALLOWED` | Fecha de operación posterior a hoy (D-31) |
| 429 | `RATE_LIMITED` | Demasiadas peticiones |
| 500 | `INTERNAL_ERROR` | Error no previsto (sin detalles internos) |

Una operación fallida **no deja efectos parciales**.

## 4. Ejemplos normativos

### 4.1 Vista previa de alta de servicio

`POST /v1/subscriptions/preview`

```json
{
  "name": "Netflix",
  "provider": "Netflix",
  "mode": "shared",
  "capacity": 4,
  "announcedPrice": "45.00",
  "interval": { "unit": "month", "count": 1 },
  "startDate": "2026-10-07",
  "nextPaymentDate": "2026-11-07",
  "occupiedSeats": 1
}
```

Respuesta `200`:

```json
{
  "calendar": { "ok": true, "expectedNextPayment": "2026-11-07", "diffDays": 0 },
  "suggestedQuota": { "amount": "45.00", "formula": "ceil(45.00 / 1)" },
  "cycles": [
    { "seq": 1, "startDate": "2026-10-07", "endDate": "2026-11-07" },
    { "seq": 2, "startDate": "2026-11-07", "endDate": "2026-12-07" }
  ],
  "baseDays": 30,
  "previewToken": "eyJ…"
}
```

(Con `occupiedSeats: 4` la cuota sugerida es `"12.00"`: `ceil(45/4) = 12`.)

### 4.2 Vista previa de incorporación

`POST /v1/subscriptions/{id}/seats/preview`

```json
{
  "contactId": "c0e2…",
  "label": "Cuenta 1",
  "joinDate": "2026-10-30",
  "quota": "20.00"
}
```

Respuesta `200` (ciclo 7-oct → 7-nov; `r = 8`; `g = 7` ⇒ se cobra):

```json
{
  "cycle": { "id": "9a1b…", "startDate": "2026-10-07", "endDate": "2026-11-07" },
  "calculation": {
    "mode": "partial_charged",
    "remainingDays": 8,
    "baseDays": 30,
    "freeDaysThreshold": 7,
    "quota": "20.00",
    "prorated": "6.00",
    "gross": "6.00",
    "exemption": "0.00",
    "net": "6.00",
    "rule": "RN-I01@v1",
    "formula": "min(20.00, ceil_sol(20.00 × 8 / 30))"
  },
  "dueDate": "2026-10-30",
  "next": { "cycleStart": "2026-11-07", "dueDate": "2026-11-07", "amount": "20.00" },
  "warnings": [],
  "previewToken": "eyJ…"
}
```

`POST /v1/subscriptions/{id}/seats` 🔒 recibe el mismo cuerpo más `previewToken` y devuelve `201` con la plaza, la participación y el cargo emitido (`obligationId`, `net: "6.00"`).

### 4.3 Cobro con reparto y reserva

`POST /v1/receipts` 🔒

```json
{
  "contactId": "c0e2…",
  "accountId": "a7d4…",
  "amount": "60.00",
  "receivedOn": "2026-10-12",
  "note": "Yape de Ana",
  "allocations": [
    { "obligationId": "o111…", "amount": "20.00" },
    { "obligationId": "o112…", "amount": "20.00" }
  ],
  "reserveRemainder": { "subscriptionId": "s001…" },
  "previewToken": "eyJ…"
}
```

Respuesta `201`:

```json
{
  "receipt": { "id": "r555…", "amount": "60.00", "operationId": "op99…", "status": "active", "version": 1 },
  "allocations": [
    { "id": "al1…", "obligationId": "o111…", "amount": "20.00" },
    { "id": "al2…", "obligationId": "o112…", "amount": "20.00" }
  ],
  "availability": { "received": "60.00", "applied": "40.00", "refunded": "0.00",
                    "unapplied": "20.00", "reserved": "20.00", "free": "0.00" },
  "account": { "id": "a7d4…", "balanceAfter": "260.00" }
}
```

Reglas: `Σ allocations ≤ amount`; el resto va a reserva si se pidió, o queda como crédito libre. La operación crea **un solo asiento** `+60.00`.

Error típico (`422 OVER_ALLOCATION`):

```json
{ "error": { "code": "OVER_ALLOCATION", "message": "Allocation exceeds receipt amount.",
  "details": [{ "field": "allocations", "issue": "sum_exceeds_receipt", "sum": "70.00", "receipt": "60.00" }],
  "requestId": "…" } }
```

### 4.4 Pago al proveedor

`POST /v1/billing-cycles/{id}/supplier-payment` 🔒

```json
{ "accountId": "a7d4…", "amount": "47.00", "paidOn": "2026-10-10", "note": "Cobro bancario real" }
```

Respuesta `201`:

```json
{
  "supplierPayment": { "id": "sp1…", "amount": "47.00", "announcedPrice": "45.00", "paidOn": "2026-10-10" },
  "operationId": "op100…",
  "cycle": { "startDate": "2026-10-07", "endDate": "2026-11-07" },
  "calendarUnchanged": true
}
```

El ciclo conserva su inicio el 7 aunque se pagó el 10 (RN-C06, A14). Con una cuenta de tipo `credit`, la operación es un gasto con asiento negativo en la tarjeta (deuda).

### 4.5 Resumen de costo

`GET /v1/subscriptions/{id}/cost-summary?cycleId=9a1b…`

```json
{
  "cycleId": "9a1b…",
  "announcedPrice": "45.00",
  "actualPaid": "47.00",
  "expectedFromOthers": "34.00",
  "receivedFromOthers": "24.00",
  "pendingFromOthers": "10.00",
  "projectedCost": "13.00",
  "costByCollections": "23.00",
  "surplus": "0.00",
  "estimated": false
}
```

### 4.6 Estado de cuenta de un contacto

`GET /v1/contacts/{id}/statement`

```json
{
  "contact": { "id": "c0e2…", "name": "Ana" },
  "totals": { "pending": "18.00", "overdue": "0.00", "creditFree": "0.00", "creditReserved": "10.00" },
  "services": [{
    "subscriptionId": "s001…", "name": "Netflix",
    "seats": [
      { "seatId": "st1…", "label": "Cuenta 1", "quota": "10.00", "pending": "10.00" },
      { "seatId": "st2…", "label": "Cuenta 2", "quota": "8.00",  "pending": "8.00" }
    ],
    "charges": [{
      "obligationId": "o111…", "seatId": "st1…", "cycle": { "start": "2026-10-07", "end": "2026-11-07" },
      "dueDate": "2026-10-07", "net": "10.00", "adjustments": "0.00", "applied": "0.00",
      "pending": "10.00", "paymentStatus": "unpaid", "overdue": false
    }]
  }],
  "loans": []
}
```

## 5. Reglas de implementación del contrato

1. Los esquemas Zod de entrada y salida son la única definición; `openapi.json` se regenera en CI y **una diferencia sin confirmar rompe el build**.
2. Ninguna ruta acepta `ownerId`. Toda consulta filtra por el propietario del token.
3. Los casos de uso abren **una transacción** y devuelven el resultado ya confirmado; el cliente no compone operaciones multi-paso.
4. Los cambios incompatibles se publican bajo `/v2`; los campos nuevos opcionales no requieren versión.
5. Los textos de error visibles al usuario viven en el cliente.
6. El servidor registra un `audit_event` por cada operación financiera con `requestId`, actor, acción y motivo.

## 6. Anexo: rutas fuera de `/v1` y añadidas después de la Entrega 1

El contrato completo y vigente es `EVA-Backend/openapi.json` (216 operaciones bajo `/v1`). Aquí solo se documentan las piezas que no son recursos de negocio.

| Ruta | Autenticación | Para qué |
| --- | --- | --- |
| `GET /healthz` · `GET /readyz` | Ninguna | Salud del proceso y de la conexión a la base |
| `POST /jobs/daily` | Cabecera `x-cron-secret` | Respaldos automáticos, purga de originales > 90 días, exportaciones vencidas y cuentas marcadas para eliminar. Responde un resumen |
| `POST /webhooks/resend` | Firma Svix (`svix-id`, `svix-timestamp`, `svix-signature`) | Aviso `email.received`: la API lee el correo en Resend, resuelve al dueño por la dirección y crea un documento propuesto. Responde `{accepted, duplicate}`; una dirección desconocida responde `{accepted:false}` sin detalle. Si falta el secreto, la ruta no existe (404). Un fallo de Resend responde 500 para que reintente |
| `POST /v1/suggestions` | Token | Envía una sugerencia por correo al desarrollador (D-71). 5 por hora por persona; 503 si el correo no está configurado |
| `GET /v1/tips/today` | Token | Consejo del día con IA (D-70) |
| `GET /v1/capture/inbox-address` · `POST …/rotate` | Token | Dirección personal de recepción y su rotación |

Detalle de seguridad de cada una: [09 §9](09-seguridad-acceso-respaldos.md).
