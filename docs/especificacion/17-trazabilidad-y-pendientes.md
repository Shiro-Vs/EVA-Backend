# 17 — Trazabilidad y pendientes

> **Estado (17-nov-2026):** la trazabilidad (§1) sigue vigente. La lista de pendientes (§4) quedó superada: los temas abiertos y las ideas nuevas se llevan ahora en [`../PENDIENTES.md`](../PENDIENTES.md).

## 1. De dónde sale cada cosa

| Documento anterior | Dónde quedó |
| --- | --- |
| `01-alcance` | [01](01-vision-y-alcance.md) (alcance, límites, entregas) · [03](03-reglas-suscripciones.md) |
| `02-reglas-de-negocio` | [03](03-reglas-suscripciones.md) (suscripciones, con IDs `RN-xxx`) · [04](04-motor-de-calculo.md) (fórmulas) · [08](08-reportes-y-exportaciones.md) |
| `03-modelo-conceptual` | [02](02-glosario-y-convenciones.md) (nombres) · [12](12-modelo-de-datos.md) (invariantes como SQL) · [11](11-arquitectura.md) |
| `04-decisiones` | [10](10-decisiones.md) |
| `05-definicion-mediante-preguntas` | Absorbido en 03/05/06/07/09; el historial queda en el original |
| `06-prestamos-y-tarjetas` | [06](06-prestamos-y-tarjetas.md) |
| `07-cuentas-y-clasificacion`, `08-planificacion-financiera-y-panel` | [05](05-finanzas-personales.md) |
| `09-captura-revision-e-ia` | [07](07-captura-e-ia.md) |
| `10-reportes-exportaciones-y-web` | [08](08-reportes-y-exportaciones.md) |
| `11-acceso-offline-y-respaldos` | [09](09-seguridad-acceso-respaldos.md) |
| `12-arquitectura-y-costos` | [11](11-arquitectura.md) |
| `13-diccionario-de-datos` | [12](12-modelo-de-datos.md) (SQL) · [02](02-glosario-y-convenciones.md) |
| `14-plan-de-construccion` | [14](14-casos-de-prueba.md) (A01–A28) · [15](15-plan-de-implementacion.md) |
| `EVA-Frontend/docs/08-estrategia-sql-backend-y-v1` | Superado por el conjunto actual (SQLite → PostgreSQL desde el inicio; formato de `inboxEmail` conservado en [07 §3](07-captura-e-ia.md)) |
| `EVA-Frontend/docs/01…07` y `EVA-manual-colores` | **No revisados en esta pasada.** El manual de colores sigue vigente para la interfaz; `05-convenciones-de-codigo.md` conviene revisarlo en la Entrega 0 por si hay convenciones útiles para el frontend. |

## 2. Contradicciones detectadas en la documentación anterior y cómo se resolvieron

| # | Contradicción | Resolución | Ver |
| --- | --- | --- | --- |
| 1 | "La cuota vence el día de renovación" frente a "al incorporarse paga **ese día**" el tramo inicial | El **tramo inicial vence el día del ingreso**; los ciclos siguientes, el día de renovación | RN-I05 |
| 2 | Redondeo de prorrateo "hacia abajo" (antiguo) frente a "hacia arriba a entero" | **Hacia arriba a sol entero** (sustituye al anterior, como indica el propio documento 02) | 02 §2, RN-I02 |
| 3 | Baja "sin devolución" (primera respuesta) frente a "devolver anticipos futuros" | **Se devuelven los ciclos futuros**; el ciclo pagado al proveedor se termina sin devolución actual | RN-X02, RN-X05 |
| 4 | Offline "registrar sin conexión" frente a "solo consulta" | **Solo consulta** (decisión vigente) | RN-OF01 |
| 5 | `ReceivedPayment` frente a `Receipt`; `MoneyMovement` frente a `FinancialOperation + AccountEntry` | Un único vocabulario | 02 §1 |
| 6 | "Distribución de un cobro **manual**" frente a "distribuir el pago si existen cargos futuros" (anticipo) | Manual y editable; sin cargos queda reserva; **la reserva se aplica automáticamente al emitirse el cargo, con deshacer** (D-09) | RN-R03, RN-R07 |
| 7 | "Promesa" de pasar de SQLite a PostgreSQL cambiando el `provider` | **Descartada**; PostgreSQL desde el inicio | T-01 |
| 8 | Plan de Firebase frente a Supabase/PostgreSQL | Firebase eliminado | 16, T-06 |
| 9 | Ejemplos de costo distintos: 47/36/24 → 11/23/12 (documento 08) y 47/34/24 → 13/23/10 (documento 14) | Ambos son **correctos** (datos distintos); se conservan como ejemplos separados | RN-BU08, RN-F08 |
| 10 | "`g` fijo en 5 días y ≥28 completo" (código) frente a umbral **configurable** `r ≤ g` | Configurable; el código actual se descarta | 16 H2 |
| 11 | La plaza del administrador: ¿cuenta como ocupada? | Sí cuenta para capacidad y cuota sugerida; no genera cargo | RN-S03/S04 |

## 3. Cosas que debes confirmar (por prioridad)

Todas tienen una **propuesta asumida**: si no respondes, se implementa esa propuesta. Responde solo a las que quieras cambiar.

> **Confirmadas por el creador el 14-oct-2026:** las 9 preguntas de esta tabla se respondieron aceptando la propuesta (la 10, sobre T-03, quedó resuelta por la prueba de concepto de la Entrega 0). Valores iniciales confirmados: `g = 0` y `L` sin definir. Las filas se conservan como registro de lo decidido.

### 3.1 Antes de empezar la Entrega 1 — CONFIRMADAS

| # | Pregunta | Propuesta asumida | ID |
| --- | --- | --- | --- |
| 1 | En meses cortos, un servicio que renueva el 31 ¿vence el último día disponible (28/30) y vuelve al 31? | **Sí** | D-02 |
| 2 | Si el tramo de incorporación calculado supera la cuota (ciclo de 31 días), ¿limitar a la cuota y avisar? | **Sí** | D-06 |
| 3 | Reparto de céntimos al dividir un total entre partes: mayor resto, determinista. | **Sí** | D-04 |
| 4 | Si el participante tiene un **anticipo/reserva** y se emite su próximo cargo, ¿se aplica solo (con "deshacer") o prefieres que te pregunte siempre? | Se aplica solo, con deshacer | D-09 |
| 5 | Emisión de cargos: el del ciclo siguiente se emite **al empezar ese ciclo** (no antes), salvo que adelantes ciclos a mano. ¿Quieres emitirlo unos días antes? | Al empezar el ciclo | D-08 |
| 6 | **Cuota sugerida** = precio anunciado entre plazas **ocupadas** (incluida la tuya). | **Sí** | D-07 |
| 7 | El **límite de días para baja inmediata** (`L`) y los **días gratis** (`g`): ¿valor inicial? | `g = 0` y `L` sin definir (siempre termina el ciclo) hasta que los configures | 02 §2, RN-I07 |
| 8 | Fechas de cobros y pagos: ¿se permiten **fechas pasadas** (sí) y **futuras** (no)? | Pasadas sí, futuras no | D-31 |
| 9 | Archivar: un **servicio con plazas activas** o un **contacto con plazas activas** no se pueden archivar; con deuda pendiente se permite con advertencia. | Como se indica | D-32 |
| 10 | Base de datos y acceso: confirmar la **prueba de concepto de 0.4** (Kysely + migraciones SQL) antes de fijar T-03. | Confirmar tras 0.4 | T-03 |

### 3.2 Antes de la Entrega 2

| # | Pregunta | Propuesta | ID |
| --- | --- | --- | --- |
| 11 | Igualdad al límite de baja (`u = L`): ¿termina el ciclo? | **Sí** | D-01 |
| 12 | Renovación adelantada: ¿sin devolución ni cobro doble? | **Sí** | D-05 |
| 13 | Anual y personalizada: base = días reales del ciclo. | **Sí** | D-03 |
| 14 | Diferencia por subida de cuota: ajuste por cada cargo ya emitido, "por renovación" o "junta". | **Sí** | D-19 |
| 15 | Devolución programada compromete el crédito aunque el dinero no haya salido. | **Sí** | D-11 |

### 3.3 Para entregas posteriores (no bloquean la E1)

Fórmulas de interés y mora (D-20, D-21), conflicto de reglas de clasificación (D-14), duplicados 24 h (D-23), retención 90 días (D-24), bloqueo 1 min (D-25), respaldo semanal con 2 copias (D-26), tope inicial de Gemini (D-27), arrastre de presupuesto (D-28), profundidad de categorías (D-29), metas por cuenta (D-30). Detalle en [10](10-decisiones.md).

## 4. Pendientes que **no** se pueden decidir hoy

| Tema | Depende de | Entrega |
| --- | --- | --- |
| Presupuesto operativo y planes de pago | Medir tamaño de datos y uso | E1 → antes de contratar |
| Qué incluye tu plan de Gemini (créditos de API) | Revisar tu cuenta y la facturación de la API | Antes de E4 |
| Dominio y proveedor del correo de recepción | Elegir y comprobar condiciones vigentes | E4 |
| Formato de gráficos individuales | Ver ejemplos | E6 |
| Proveedor de tipo de cambio y proyección | Alcance de la web | E7 |
| Acceso de amigos (invitaciones, permisos, eliminación de cuenta) | Diseño de privacidad | E7 |

## 5. Lista de revisión de este conjunto

Antes de empezar a programar, comprueba:

- [ ] Leí [01 §6](01-vision-y-alcance.md) y es lo que quiero lograr primero.
- [ ] Revisé la tabla 3.1 y corregí lo que no me convence.
- [ ] Revisé los ejemplos numéricos de [04 §10](04-motor-de-calculo.md) y coinciden con mi intuición.
- [ ] Los escenarios A01–A09 de [14](14-casos-de-prueba.md) describen mis casos reales.
- [ ] Acepto que el motor de cálculo viva solo en el backend ([10 T-05](10-decisiones.md)).
- [ ] Acepto eliminar Firebase y Gemini del cliente ([16 §4](16-auditoria-del-codigo.md)).
- [ ] Acepto que, si algún número de este conjunto contradice mi intención real, **mi intención manda** y se corrige aquí primero.
