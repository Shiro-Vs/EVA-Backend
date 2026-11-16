# 02 — Glosario y convenciones

## 1. Glosario único

Cuando un documento anterior use otro nombre, vale el de esta tabla. La columna *Tabla/entidad* es el nombre en código y base de datos (inglés, `snake_case`); la interfaz y los documentos usan el término en español.

| Término | Definición | Tabla / entidad |
| --- | --- | --- |
| **Usuario / administrador** | Persona con cuenta de EVA que gestiona sus datos. | `user_profile` |
| **Contacto** | Persona a quien se atribuyen cargos y pagos. No necesita cuenta. Distinto del usuario. | `contact` |
| **Cuenta** | Lugar real del dinero (banco, ahorro, efectivo, billetera) o deuda de crédito. Un solo saldo real por cuenta. | `account` |
| **Canal de pago** | Medio (Yape, Plin, tarjeta digital) vinculado a una cuenta real. No es una cuenta nueva ni suma saldo. | `payment_channel` |
| **Operación financiera** | Hecho confirmado que mueve dinero: ingreso, gasto, transferencia, apertura, ajuste o reversión. | `financial_operation` |
| **Asiento de cuenta** | Efecto firmado de una operación sobre una cuenta. Saldo = suma de asientos. | `account_entry` |
| **Servicio** | Plan administrado (un Netflix concreto). Dos Netflix son dos servicios. | `subscription` |
| **Términos del servicio** | Versión con vigencia de precio anunciado, intervalo y ancla del calendario. | `subscription_terms` |
| **Ciclo** | Período de cobertura `[inicio, fin)` del servicio. Puede cruzar meses calendario. | `billing_cycle` |
| **Participación** | Relación de un contacto (o del administrador) con un servicio durante un intervalo. | `membership` |
| **Plaza** | Cupo identificable dentro de una participación. Un contacto puede ocupar varias. | `seat` |
| **Términos de plaza** | Cuota individual de una plaza, con vigencia. | `seat_terms` |
| **Cortesía** | Exención del cobro por decisión del administrador. No es un pago. | `courtesy` |
| **Obligación por cobrar** | Deuda a favor del administrador; clave común de cargos y componentes de préstamo. | `receivable_obligation` |
| **Cargo** | Obligación de una plaza por un ciclo: bruto, exención y neto. | `member_charge` |
| **Ajuste de cargo** | Aumento, descuento o condonación firmados y documentados. No sobrescribe el cargo. | `charge_adjustment` |
| **Cobro** | Dinero real entregado por un contacto; **un ingreso real**, aunque cubra varios cargos. Equivale a `ReceivedPayment`/`Receipt` de documentos anteriores. | `receipt` |
| **Aplicación** | Parte de un cobro destinada a una obligación. Relación muchos a muchos. | `payment_allocation` |
| **Reserva (anticipo)** | Dinero recibido sin aplicar, con destino por defecto (el servicio). No garantiza precio. | `credit_reservation` |
| **Crédito disponible** | Dinero recibido − aplicaciones − devoluciones. Se divide en *reservado* y *libre*. | (derivado) |
| **Pago al proveedor** | Salida real de dinero para pagar el ciclo del servicio. Independiente de los cobros. | `supplier_payment` |
| **Devolución** | Dinero a devolver a un contacto, distinta de revertir una aplicación. | `refund` |
| **Préstamo** | Deuda entre el administrador y una contraparte, con componentes detallados. | `loan`, `loan_component` |
| **Conversión de deuda** | Traslado atómico de pendientes de servicio a un préstamo, sin efectivo. | `debt_conversion` |
| **Propuesta** | Movimiento detectado y aún no confirmado. No modifica saldos. | `movement_proposal` (E4) |
| **Evento de auditoría** | Registro de quién hizo qué, cuándo y por qué. | `audit_event` |

Equivalencias con los documentos 03 y 13 anteriores: `MoneyMovement` → `financial_operation` + `account_entry`; `MovementItem` → `operation_item`; `ReceivedPayment` → `receipt`; `SupplierObligation` → datos del ciclo (`billing_cycle.terms_snapshot`, sin tabla propia en la E1).

## 2. Dinero

| Regla | Detalle |
| --- | --- |
| Tipo en base de datos | `numeric(14,2)` (nunca `float`). |
| Tipo en el motor de cálculo | **Enteros en céntimos** (`bigint`). Se convierte en los bordes. |
| Tipo en la API | **Cadena decimal** `"20.00"`, nunca número JSON. |
| Moneda | Código ISO `PEN` en cada importe y operación. No existe una cifra sin moneda. No se aplica entre monedas distintas. |
| Importes reales | Yape, transferencias, pagos al proveedor, documentos bancarios: **exactos**, sin redondeo (ejemplo: S/ 10.25). |
| Redondeo de suscripciones | Prorrateos y sugerencias de cuota: **hacia arriba a sol entero**, mostrado como `S/ 7.00`. **[C]** |
| Otros cálculos monetarios | Hacia arriba **al céntimo** al emitir el resultado (6.6666 → 6.67), con precisión intermedia (nunca redondear pasos intermedios ni tasas). **[C]** |
| Distribución de totales | Las partes deben sumar exactamente el total. Método del mayor resto ([04 §6](04-motor-de-calculo.md)). **[P D-04]** |
| Signos | Un asiento positivo aumenta el saldo de la cuenta; negativo lo reduce. En una cuenta de crédito el saldo es **negativo** (deuda): una compra con tarjeta es un asiento negativo; pagar la tarjeta es positivo en la tarjeta y negativo en el banco. |

## 3. Fechas y tiempo

| Regla | Detalle |
| --- | --- |
| Fechas de cobertura y vencimiento | **Fecha local sin hora** (`date`, formato `YYYY-MM-DD`) en la zona del propietario (`America/Lima`). |
| Instantes (recepción, auditoría, creación) | `timestamptz` en UTC; la API usa ISO 8601 con `Z`. |
| Intervalos | Ciclos y vigencias son **`[inicio, fin)`**: inicio incluido, fin excluido. |
| "Hoy" | La fecha local actual del propietario, calculada en el servidor. El cliente nunca decide "hoy" para reglas de negocio. |
| Vencimiento | Un cargo está vencido si `hoy_local > fecha_vencimiento` y su pendiente es mayor que cero. **[P D-13]** |
| Aritmética de calendario | Con un tipo `LocalDate` propio (días desde época entera). **No** se usa `Date` de JavaScript ni `setMonth` para reglas de negocio. |
| Fecha real de pago vs renovación | Conceptos separados: pagar tarde no mueve la renovación. **[C]** |

## 4. Identificadores, estados y versiones

- **IDs**: UUID estables (v4 o v7). Los nombres, las fechas "pagado hasta" y las banderas "pagado" **no** sustituyen relaciones.
- **Estados**: columnas `text` con restricción `CHECK` (no tipos `enum` nativos, por la dificultad de alterarlos). Nunca un booleano ambiguo "pagado": el estado de pago es **derivado** ([03 §6](03-reglas-suscripciones.md)).
- **Versión**: toda entidad mutable lleva `version int` para control optimista. Una edición con versión obsoleta devuelve `409 CONFLICT_VERSION`.
- **Propietario**: todo dato privado lleva `owner_id`. Las claves foráneas son **compuestas** `(owner_id, id)` para impedir referencias cruzadas entre usuarios ([12](12-modelo-de-datos.md)).
- **Archivar, no borrar**: contactos, cuentas y servicios se archivan (`status`); su historial financiero permanece.
- **Instantáneas**: cada cargo y ciclo guarda el precio, la regla y el cálculo aplicados (`calc_snapshot`, `terms_snapshot`). Modificar la configuración después no cambia el pasado.

## 5. Nombres en código

| Ámbito | Convención |
| --- | --- |
| Tablas y columnas | Inglés, `snake_case`, singular (`member_charge`). |
| API (JSON) | Inglés, `camelCase` (`dueDate`). |
| TypeScript | Tipos `PascalCase`, funciones y variables `camelCase`. |
| Interfaz y mensajes al usuario | Español. Los textos viven en un archivo de recursos, no incrustados en lógica de negocio. |
| Códigos de error | `MAYUSCULAS_CON_GUION_BAJO` estables (la app los traduce). |
| Migraciones | `NNNN_descripcion.sql`, numeradas, **inmutables** una vez aplicadas. |

## 6. Etiquetas de estado de decisión

`[C]` confirmado por el creador · `[P]` propuesta cerrada (ID `D-xx`, documento 10) · `[E2]`… entrega en que se implementa · `RN-xxx` regla · `T-xx` decisión técnica.
