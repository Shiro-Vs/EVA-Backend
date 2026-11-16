# 05 — Finanzas personales (Entrega 3)

Reglas consolidadas de cuentas, movimientos, clasificación, presupuestos, metas, recurrencias, conciliación y panel. La E1 solo usa **cuentas, saldos iniciales y operaciones básicas** (necesarias para cobros y pagos al proveedor); el resto se implementa en la E3. **[C]** confirmado · **[P D-xx]** propuesta cerrada.

## 1. Cuentas y canales

| ID | Regla | Estado |
| --- | --- | --- |
| RN-AC01 | Tipos de cuenta: **bancaria/ahorro, crédito, efectivo, billetera o tarjeta digital**. Marca, entidad y canal son **atributos**, no tablas por marca. | C |
| RN-AC02 | Cada cuenta tiene **un único saldo real** (o deuda, si es de crédito). Saldo = Σ asientos, no un campo editable. | C |
| RN-AC03 | **Yape/Plin** son un *canal* vinculado a una cuenta real **o** una cuenta independiente (por ejemplo, ligada a un DNI), según el caso. En modo vinculado, un movimiento afecta la cuenta real **una vez**; nunca se suma un saldo Yape extra. | C |
| RN-AC04 | Una tarjeta digital puede ser instrumento de una cuenta o producto con saldo propio. Al configurarla se identifica la relación para evitar doble conteo. | C |
| RN-AC05 | La **línea de crédito disponible no es dinero propio**. | C |
| RN-AC06 | **Saldo inicial**: saldo real actual (o deuda actual de tarjeta) como **apertura**, sin crear ingreso ni gasto. No se cargan movimientos anteriores. | C |
| RN-AC07 | Una cuenta se **archiva**, no se borra, y su historial permanece. Se puede cambiar el nombre libremente. | C |
| RN-AC08 | **Moneda**: solo PEN al inicio; el código se guarda siempre. Con USD (E7) habrá cuentas, saldos y conversiones separados; cotización informativa ≠ tipo de cambio real de una operación y sus comisiones. | C |

## 2. Operaciones financieras

| ID | Regla | Estado |
| --- | --- | --- |
| RN-MV01 | Tipos: **ingreso, gasto, transferencia, apertura, ajuste, reversión**. Cada operación confirmada afecta una cuenta **una vez**. | C |
| RN-MV02 | **Transferencia entre cuentas propias** = dos asientos vinculados (suma 0). No es ingreso ni gasto y no se suma como dinero hacia terceros. | C |
| RN-MV03 | Un **ingreso Yape** que paga una cuota debe poder **vincularse** al cobro existente; nunca se crea además un ingreso manual. Igual para pagos al proveedor. | C |
| RN-MV04 | **Gasto con tarjeta de crédito**: registra el gasto y aumenta la deuda de la tarjeta. **Pagar la tarjeta** desde un banco reduce banco y deuda **sin repetir el gasto**. | C |
| RN-MV05 | **Capital prestado recibido** no es ingreso ganado. Devolver capital no es gasto de consumo. Intereses, seguros y comisiones son **costo financiero**. | C |
| RN-MV06 | Campos mínimos para confirmar: propietario, cuenta, importe positivo, moneda, dirección, fecha. La **categoría puede quedar sin clasificar**. | C |
| RN-MV07 | **Desglose**: un total y sus ítems son partes del **mismo** gasto, no gastos adicionales. La suma de ítems es igual al total (distribución con mayor resto si es proporcional). | C |
| RN-MV08 | Una **compra de S/ 100** con S/ 5 de comida y S/ 95 de tecnología puede guardarse como **desglose** o como **categoría dominante** (tecnología). El predeterminado se elige en configuración y se cambia por compra. Nunca se suman total *y* desglose. | C |
| RN-MV09 | **Corrección**: ver RN-V01…V06 ([03](03-reglas-suscripciones.md)). La edición financiera es reversión + nueva operación. | C |
| RN-MV10 | **Ajuste de saldo** (conciliación): operación de tipo `adjustment` con motivo; se muestra **separado** y no cuenta como ingreso ganado ni gasto de consumo. | C/P D-22 |

## 3. Categorías y clasificación

| ID | Regla | Estado |
| --- | --- | --- |
| RN-CL01 | Categorías **sugeridas y propias**, con **subcategorías** (2 niveles: categoría → subcategoría), renombrado y archivo. Archivar o renombrar **no** rompe reportes históricos ni borra movimientos. | C/P D-29 |
| RN-CL02 | **Obligatoria antes de aceptar** o **clasificar después** es una opción configurable. Si se acepta sin categoría, el movimiento **afecta el saldo una vez** y queda en la cola *Por clasificar*; cambiar la categoría después no crea otro movimiento. | C |
| RN-CL03 | **Canal y categoría son campos distintos** (Yape ≠ categoría "Yape"), de modo que se pueda consultar tecnología pagada con Yape. | C |
| RN-CL04 | **Reglas del usuario antes que Gemini.** Gemini ayuda solo si ninguna regla aplica. Nunca sobrescribe una corrección manual sin revisión. | C |
| RN-CL05 | Reglas: condiciones (canal, cuenta, dirección, **intervalo de importe**, comercio/remitente, texto) y acciones (sugerir/asignar categoría, pedir revisión, señalar posible cobro de servicio/préstamo). Ejemplo: Yape < S/ 10 → *minigastos*. | C |
| RN-CL06 | **Conflicto entre reglas**: gana la de **menor número de prioridad**; desempate por creación más antigua. Se muestra qué regla se aplicó. | P D-14 |
| RN-CL07 | Clasificar **no** acepta el movimiento ni modifica saldos. Las reglas nuevas **no recategorizan** historial salvo petición. | C |
| RN-CL08 | Clasificar como ingreso/gasto y **aplicar a una deuda** son conceptos distintos: un contacto que paga un préstamo por Yape no es "ingreso ganado". | C |
| RN-CL09 | Preguntas al abrir la app por categorías pendientes: configurable (frecuencia y cuenta/canal). | C |

## 4. Presupuestos

| ID | Regla | Estado |
| --- | --- | --- |
| RN-BU01 | Límites por **categoría y subcategoría**; **período** y **niveles de aviso** configurables (por ejemplo 80 % y 100 %). Los avisos **no bloquean** gastos. | C |
| RN-BU02 | Relación padre/subcategoría **configurable**: el presupuesto muestra qué incluye. Un gasto **no se duplica** en el total general. | C |
| RN-BU03 | Un presupuesto es un **límite**, no dinero ni reserva bancaria. | C |
| RN-BU04 | Cada período inicia con el límite normal; **sin arrastre** por defecto (límite 300, gastó 250 → siguiente límite 300). | C |
| RN-BU05 | **Arrastre** opcional por presupuesto: arrastra el saldo **no gastado positivo**; el exceso **no** se arrastra como deuda. Tope opcional y efecto de cambios de límite visibles. | P D-28 |
| RN-BU06 | **Servicios compartidos** consumen presupuesto por **costo real neto** = pago real − cobros reales atribuibles. Las cuotas impagas **no** reducen ese costo. Se compara con el costo previsto. | C |
| RN-BU07 | Dos vistas elegibles por presupuesto: cobros **atribuidos al ciclo de origen** o por **fecha real de recepción**. Pago de enero cobrado en febrero: caja de febrero lo incorpora; la vista por ciclo lo deja en enero. No se crea otro ingreso. | C |
| RN-BU08 | Ejemplo: pago 47, cuotas exigibles 36, cobros 24 → costo previsto **11**, real **23**, pendiente **12**. | C |

## 5. Metas de ahorro

| ID | Regla | Estado |
| --- | --- | --- |
| RN-GO01 | Meta = **objetivo monetario**, fecha **opcional**, aportes **vinculados a cuentas reales**. No es una cuenta bancaria. | C |
| RN-GO02 | **Aportar** = asignar dinero existente en una o varias cuentas (reserva), vincular una **transferencia real** de ahorro, o **programar** aportes como propuestas siempre confirmables. Asignar S/ 100 de un saldo de S/ 100 **no** crea ingreso, gasto ni saldo adicional. | C |
| RN-GO03 | Vistas configurables: *saldo y avance de meta* **o** *total / reservado / libre* (1 000 total, 300 reservado, 700 libre). | C |
| RN-GO04 | Si un gasto usa dinero reservado, **avisar y preguntar** de qué meta descontar **antes de confirmar**. | C |
| RN-GO05 | **Varias metas por cuenta** permitidas; si Σ reservado supera el saldo de la cuenta, se avisa. El avance se mide con el reservado, no con el saldo total. | P D-30 |
| RN-GO06 | EVA **no ejecuta** transferencias bancarias externas. | C |

## 6. Ingresos y gastos recurrentes

| ID | Regla | Estado |
| --- | --- | --- |
| RN-RE01 | Se separan **plantilla** (sueldo, alquiler), **ocurrencia** del período, **propuesta** y **movimiento confirmado**. | C |
| RN-RE02 | **Siempre** se pregunta antes de registrar. Ninguna recurrencia ejecuta un movimiento por sí sola. | C |
| RN-RE03 | Generación **idempotente** por plantilla y período. Una recurrencia es **expectativa**: sin confirmación no cambia cuentas. | C |
| RN-RE04 | Si llega un correo/foto de la misma operación, **se vincula** a la ocurrencia; no se crea un segundo movimiento. Si el importe o fecha difiere, se muestra lo esperado y lo real. | C |
| RN-RE05 | Los servicios generados por el módulo de suscripciones **no** generan gasto duplicado vía una recurrencia genérica. | C |

## 7. Conciliación

| ID | Regla | Estado |
| --- | --- | --- |
| RN-CO01 | Comparar saldo registrado con el real; **revisar y corregir movimientos** primero. | C |
| RN-CO02 | Si la diferencia no se explica, registrar un **ajuste** con fecha y motivo, conservando saldo antes/después, diferencia, autor y momento. No se sobrescribe el saldo. | C |
| RN-CO03 | El ajuste se informa en una línea propia (no ingreso ganado ni gasto de consumo). | P D-22 |

## 8. Panel configurable

| ID | Regla | Estado |
| --- | --- | --- |
| RN-PA01 | Panel con **tarjetas elegibles y orden editable**; preferencias por usuario. | C |
| RN-PA02 | Tarjetas candidatas: saldo por cuenta, deuda de crédito, ingresos/gastos del período, presupuestos, metas, renovaciones, cobros pendientes, préstamos, propuestas por revisar, próximos pagos. | C |
| RN-PA03 | Distinguir **pendientes de aceptación** (no afectan saldo) de **aceptados con categoría pendiente** (sí afectan). | C |
| RN-PA04 | Tarjetas iniciales sugeridas para la E1: cuentas, cobros pendientes, próximos pagos (renovaciones). | P |

## 9. Gastos compartidos ocasionales

Excluidos. No añadir grupos ni liquidación de gastos por inferencia desde suscripciones o préstamos. **[C]**
