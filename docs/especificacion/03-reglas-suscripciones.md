# 03 — Reglas de negocio: suscripciones y cobros

Cada regla tiene un ID estable. **[C]** confirmada · **[P D-xx]** propuesta cerrada (ver [10](10-decisiones.md)). Los algoritmos exactos están en [04](04-motor-de-calculo.md); los casos de prueba en [14](14-casos-de-prueba.md).

## 1. Servicios

| ID | Regla | Estado |
| --- | --- | --- |
| RN-S01 | Un **servicio** es un plan concreto. Dos cuentas de Netflix son dos servicios. Puede ser **personal** (solo el administrador) o **compartido**. | C |
| RN-S02 | El **precio anunciado** y el **pago real** son datos distintos. El pago real puede diferir (anunciado 45, banco cobra 47) y puede salir de una cuenta o tarjeta distinta en cada ciclo. | C |
| RN-S03 | La **capacidad** es el número de plazas del plan e incluye la del administrador. Las plazas ocupadas no pueden superar la capacidad. | C |
| RN-S04 | El administrador puede ocupar plazas. **No se cobra a sí mismo**; su plaza cuenta para la capacidad y para la cuota sugerida. | C |
| RN-S05 | Alta de servicio exige: nombre, proveedor, modalidad, capacidad, precio anunciado, frecuencia, **fecha de inicio** y **fecha del siguiente pago** informada por el proveedor. Cuenta preferida de pago opcional. | C |
| RN-S06 | Los cambios de precio, calendario o modalidad son **versiones con vigencia**. Nunca modifican ciclos o cargos ya emitidos. | C |
| RN-S07 | Un servicio se **archiva**, no se borra. Su historial permanece en reportes y estados de cuenta. | C |
| RN-S08 | Un servicio personal no admite plazas de terceros. Convertir compartido → individual sigue [RN-X03](#7-bajas-retiros-y-cambio-a-individual). | C |

## 2. Calendario y ciclos

| ID | Regla | Estado |
| --- | --- | --- |
| RN-C01 | Un **ciclo** es `[inicio, fin)`. Los ciclos de un servicio **no se superponen y no dejan huecos**. Cada ciclo guarda una **instantánea** del precio e intervalo con que se generó. | C/P |
| RN-C02 | **Frecuencias**: semanal (7 días), mensual, anual, o **personalizada** = cada *n* días, semanas o meses. No se admite una lista irregular de fechas. | C |
| RN-C03 | Al dar de alta se **verifica** que `inicio + intervalo` coincida con el siguiente pago informado. Si difiere, se muestra la diferencia y el usuario debe **confirmarla**; no se reemplaza en silencio. Si **coincide** con lo calculado, el **ancla conserva el día original** (D-02: 31 → 28 feb → 31 mar). Si **difiere y se confirma**, prevalece la fecha informada y pasa a ser el ancla. | C/P |
| RN-C04 | **Ancla mensual**: cada fin de ciclo se calcula desde el ancla, no desde el fin anterior. Si el mes no tiene ese día, se usa **el último día disponible** y se vuelve al ancla cuando el mes lo permite. Ancla 31: 31 ene → 28 feb → 31 mar → 30 abr. | P D-02 |
| RN-C05 | **Anual**: mismo día y mes; un 29 de febrero cae en 28 de febrero los años no bisiestos. | P D-02 |
| RN-C06 | **Pago tardío no mueve la renovación.** Si el proveedor renueva el 7 y se paga el 10, el ciclo sigue iniciando el 7; la fecha real de pago es el 10. | C |
| RN-C07 | Un cambio de calendario (nueva fecha o intervalo) se registra como **cambio de calendario** con fecha efectiva, motivo y vista previa de ciclos y cargos afectados. Solo se regeneran ciclos futuros sin efectos financieros. | C/P |
| RN-C08 | **Ciclo en curso que el proveedor desplaza** (Spotify al agregar miembro, YouTube al reactivar): el ciclo se acorta o alarga **solo si el administrador lo confirma**. Los cargos ya emitidos **conservan su monto**; solo se recorren los vencimientos de los cargos siguientes, **sin cobrar días adicionales**. | C |
| RN-C09 | **Gracia y suspensión**: la gracia no tiene duración fija ni genera cobro. Una suspensión **no descuenta cuota** ni genera saldo a favor. La reactivación es un cambio de calendario con nueva ancla. | C |
| RN-C10 | **Renovación adelantada**: el ciclo en curso se cierra en la nueva fecha y el siguiente empieza ahí. Los participantes ya cobrados por el ciclo en curso **no pagan dos veces ni reciben devolución** por los días recortados. Se exige vista previa. | P D-05 |
| RN-C11 | Emisión de ciclos: el sistema mantiene generados el ciclo en curso y **uno futuro**; más ciclos por adelantado solo por acción explícita (anticipos). La generación es **idempotente** (reintentar no duplica). | P D-08 |

## 3. Plazas y cuotas

| ID | Regla | Estado |
| --- | --- | --- |
| RN-P01 | Cada **plaza** tiene **cuota independiente** y detalle propio. Ana con dos plazas de S/ 10 y S/ 8 debe S/ 18; el estado de cuenta muestra las dos líneas. | C |
| RN-P02 | Una cuota es un acuerdo manual. **No se asume** que las cuotas sumen el costo del servicio, ni se reparte automáticamente una cuota global entre plazas. | C |
| RN-P03 | **Cuota sugerida** = `ceil( precio_anunciado / plazas_ocupadas )` a sol entero, incluyendo la plaza del administrador. Editable. No reemplaza cuotas ya acordadas. Ejemplo: 45 / 4 = 11.25 → **S/ 12**. | C/P D-07 |
| RN-P04 | Una cuota nueva rige **desde el próximo ciclo**; no cambia el ciclo en curso. | C |
| RN-P05 | Una cuota puede ser 0 (plaza propia o cortesía registrada como tal). Una cuota negativa no existe. | P |
| RN-P06 | El total de un contacto es la suma de sus plazas y préstamos; siempre se puede desplegar el detalle por plaza y ciclo. | C |

## 4. Incorporación de participantes

Sea `r` los días desde el ingreso hasta el fin del ciclo vigente (`fin − ingreso`, fin excluido), `g` el umbral de días gratis, `Q` la cuota de la plaza y `B` la base de prorrateo ([04 §4](04-motor-de-calculo.md)).

| ID | Regla | Estado |
| --- | --- | --- |
| RN-I01 | **Umbral de cortesía (Regla A)**: si `r ≤ g`, **todo el tramo inicial es gratis**. Si `r > g`, se cobra **todo el tramo** proporcionalmente, **sin** descontar los días gratis. | C |
| RN-I02 | Cobro del tramo = `min( Q , ceil_sol( Q × r / B ) )`. La cuota normal es **por ciclo**, no por acumulación diaria: un ciclo completo cobra `Q` aunque tenga 31 días (no se aplica 31/30). | C/P D-06 |
| RN-I03 | Ingresar **el día de renovación** inicia un ciclo completo con cuota completa. | C |
| RN-I04 | Si el tramo calculado supera el ciclo (por ejemplo `r` > días base) el cobro **se limita a `Q`** y la vista previa muestra una advertencia. Nunca se excede la cuota en silencio. | P D-06 |
| RN-I05 | El **tramo inicial vence el día del ingreso**; los ciclos siguientes vencen el día de renovación. | C |
| RN-I06 | Tramo gratis: se emite un cargo con **neto 0** y exención registrada (explica el neto cero). Los días gratis **solo aplican al tramo de incorporación**, no a cada renovación. | C/P |
| RN-I07 | `g` se define como **valor predeterminado del usuario**, con excepciones por servicio y por plaza. Se guarda en el cargo; cambiarlo después no altera el historial. | C |
| RN-I11 | La fecha de ingreso debe caer dentro del **ciclo en curso** (`JOIN_OUT_OF_CYCLE` en otro caso). La capacidad se cuenta a esa fecha. | P |
| RN-I08 | Siempre hay **vista previa** (`r`, `B`, fórmula, resultado, vencimiento) antes de confirmar el ingreso. | C |
| RN-I09 | **Reingreso** crea una **nueva participación**; la anterior no se sobrescribe y la nueva parte en cero. | C |
| RN-I10 | Agregar un participante en EVA **no** lo agrega en el proveedor. | C |

## 5. Cargos

| ID | Regla | Estado |
| --- | --- | --- |
| RN-CH01 | Existe **un cargo por plaza y ciclo**. Dos plazas del mismo contacto tienen cargos separados. Reintentar la emisión no duplica. | C |
| RN-CH02 | Cargo = `bruto` (cuota completa o prorrateo) − `exención` = `neto`. Guarda cuota vigente, `r`, `B`, `g`, redondeo y versión de regla en `calc_snapshot`. | C |
| RN-CH03 | **Ajustes** (aumento, descuento, condonación) son registros firmados con motivo; **no se edita** el cargo original. | C |
| RN-CH04 | `Pendiente = neto + ajustes activos − aplicaciones activas − parte convertida a préstamo`. Nunca negativo: la sobreaplicación es imposible. | C |
| RN-CH05 | **Estado de pago derivado** (no almacenado): `exento` (total 0), `sin_pagar`, `parcial`, `pagado`, `cancelado`. Además un indicador `vencido`. | P |
| RN-CH06 | Un pago parcial **no reduce la cobertura**: S/ 10 de una cuota de S/ 20 mantienen el ciclo completo y S/ 10 de deuda; no equivalen a medio mes. | C |
| RN-CH07 | Un cargo cancelado (baja, cambio a individual) conserva su historial y pasa a `cancelado`; no entra en pendientes ni en costo previsto. | C |
| RN-CH08 | **Sin mora ni interés automáticos** en servicios (E1–E2). | C |
| RN-CH09 | Los cargos de **ciclos futuros ya emitidos** reciben ajustes si la cuota sube desde un ciclo futuro (ver RN-Q01). | C/P |

## 6. Cobros, aplicaciones y anticipos

| ID | Regla | Estado |
| --- | --- | --- |
| RN-R01 | Un **cobro** es **un solo ingreso real** en una cuenta, con fecha real e importe exacto. Su reparto **no crea ingresos**. | C |
| RN-R02 | Un cobro puede cubrir **varios cargos** de varios servicios (y préstamos, [E2]); un cargo puede recibir **varios cobros**. | C |
| RN-R03 | La **distribución es manual y editable**. La app puede **sugerir** orden por vencimiento más antiguo; no se impone. | C/P D-10 |
| RN-R04 | Una aplicación es **positiva**, ≤ lo disponible del cobro, ≤ el pendiente del obligación, en la **misma moneda**. Se valida en transacción con bloqueo. | C |
| RN-R05 | Un cobro con S/ 50 y deuda S/ 40 deja **S/ 10 de crédito**. | C |
| RN-R06 | El sobrante queda **reservado por defecto para la próxima cuota del mismo servicio**. El administrador puede trasladarlo a otro servicio o concepto; el traslado cambia el **destino**, no el saldo de la cuenta, ni crea ingreso. Se conserva historial. | C |
| RN-R07 | Al emitirse un cargo del servicio que tiene reserva activa del mismo contacto, la reserva se **aplica automáticamente** hasta `min(pendiente, reserva)` y se muestra en la actividad con opción de **deshacer**. | P D-09 |
| RN-R08 | **Anticipo**: no garantiza precio ni "pagado hasta X". Sin cargos emitidos queda como crédito reservado; se aplica al emitirse. Con cargos futuros emitidos puede aplicarse a ellos. | C |
| RN-R09 | `Crédito del contacto = cobros − aplicaciones activas − devoluciones (programadas o pagadas)`. Se muestra separado en **reservado** y **libre**. Una devolución *programada* ya compromete el crédito. | C/P D-11 |
| RN-R10 | Si cambia la cuota, el participante **completa la diferencia**; el anticipo no congela el precio (RN-Q01). | C |
| RN-R11 | Un cobro con aplicaciones dependientes solo se corrige mediante reversión controlada (sección 8). | C |

## 7. Cortesías, cambios de cuota, bajas y conversiones

### 7.1 Cortesías [E2]

| ID | Regla | Estado |
| --- | --- | --- |
| RN-K01 | La cortesía puede ser por **número de ciclos**, **hasta una fecha** o **permanente** hasta quitarla. | C |
| RN-K02 | Cada cargo de un ciclo cubierto se emite con **exención igual al bruto** (neto 0), con motivo y autor. No es dinero cobrado ni pago ficticio. | C/P |
| RN-K03 | **El costo de una cortesía no se reparte** entre los demás automáticamente. | C |
| RN-K04 | Una cortesía **futura no elimina deuda anterior**. Al regalar desde un ciclo futuro a quien debe, se elige **mantener la deuda** en el servicio o **convertirla en préstamo** detallado. Nunca se condona automáticamente. | C |
| RN-K05 | Cortesía + umbral de días gratis **nunca producen cargo negativo**. | C |

### 7.2 Cambio de cuota o precio [E2]

| ID | Regla | Estado |
| --- | --- | --- |
| RN-Q01 | Una cuota nueva rige desde el próximo ciclo. Para cada cargo **ya emitido** de un ciclo con inicio ≥ fecha efectiva se crea un **ajuste** = `nueva − anterior`. | C/P D-19 |
| RN-Q02 | El administrador elige cobrar la diferencia **por renovación** (cada ajuste vence en el inicio de su ciclo) o **junta** (todos vencen en la fecha del cambio). No se suma la diferencia inmediata *y además* se consume otra vez el importe aumentado. | C |
| RN-Q03 | El administrador **confirma** las cuotas nuevas. Un cambio de precio del proveedor genera una **propuesta** de cuotas y de diferencias; Gemini puede explicarla, pero los cálculos son deterministas. | C |
| RN-Q04 | **No** se cambian cuotas solo porque un cobro bancario difiera del precio anunciado. | C |

### 7.3 Bajas, retiros y cambio a individual [E2]

| ID | Regla | Estado |
| --- | --- | --- |
| RN-X01 | **"Terminar el mes" significa terminar el ciclo del servicio.** Renovación el día 4 y solicitud el 15 de febrero → termina el **4 de marzo**. | C |
| RN-X02 | **Ciclo ya pagado al proveedor** → el participante **termina el ciclo sin devolución del período actual**, incluso si cumple el umbral de salida temprana. Esta condición **tiene prioridad**. | C |
| RN-X03 | **Ciclo no pagado al proveedor**: sea `u` los días usados (`fecha de baja − max(inicio del ciclo, ingreso)`) y `L` el límite configurable. Si `u < L` → **baja inmediata** con cobro proporcional; si `u ≥ L` → **termina el ciclo**. La igualdad termina el ciclo. | C/P D-01 |
| RN-X04 | Cobro de baja inmediata = `ceil_sol( Q × u / B )`. **Devolución** = `recibido para esa cobertura − cobro`, **sin volver a redondear**; nunca negativa. Ejemplo: S/ 20 recibidos − S/ 7 = **S/ 13**. | C |
| RN-X05 | **Siempre se devuelven los anticipos de ciclos futuros** (importes realmente no consumidos). Pagó enero a julio y sale en febrero con ciclo pagado: termina febrero, devolver marzo–julio. | C |
| RN-X06 | Una devolución es **solicitada/programada** primero; el dinero real sale solo al **confirmar el egreso** (operación con salida de cuenta). Liberar una aplicación, reembolsar y condonar son **tres acciones distintas**. | C |
| RN-X07 | **Retirar con deuda**: el pendiente se convierte en **préstamo al contacto** con detalle (servicio, plaza, período, cuota, pagos previos). Cierra la deuda en el servicio y abre la del préstamo **de forma atómica**, sin ingreso ni egreso ficticio y sin doble conteo. | C |
| RN-X08 | **Compartido → individual**: se ejecuta **en el siguiente corte**, termina las participaciones, convierte deudas en préstamos con detalle y devuelve anticipos de ciclos posteriores. Se registran las fechas de solicitud, efectividad y devolución real. | C |
| RN-X09 | Un reingreso tras retiro parte **sin deuda** y puede entrar con cortesía; el préstamo anterior permanece aparte. | C |

## 8. Correcciones y reversiones

| ID | Regla | Estado |
| --- | --- | --- |
| RN-V01 | Se puede corregir categoría, descripción y notas **sin efecto financiero**. | C |
| RN-V02 | Corregir **fecha, cuenta o importe** de un cobro/operación confirmada muestra antes la **vista de cambios** (saldos y aplicaciones). Técnicamente: reversión de la versión anterior + nueva operación, en una transacción. | C/P |
| RN-V03 | **Deshacer la aceptación** de una propuesta la devuelve a revisión. | C |
| RN-V04 | Si hay aplicaciones dependientes, se **liberan y reconstruyen** de forma consistente antes de confirmar la nueva versión. | C |
| RN-V05 | Revertir **no** es devolver dinero: no genera salida real. La evidencia nunca se borra; queda auditoría con motivo. | C |
| RN-V06 | Las reversiones y cargos cancelados tienen **tratamiento explícito en reportes** (aparecen identificados, no se suman). | C |

## 9. Pago al proveedor y costo propio

| ID | Regla | Estado |
| --- | --- | --- |
| RN-F01 | Se registra el **pago real del ciclo** por separado de los cobros. Pagar al proveedor **no cancela** deudas de contactos; cobrar **no** marca al proveedor como pagado. | C |
| RN-F02 | El pago al proveedor es una **operación de gasto** en una cuenta, o una compra con tarjeta de crédito (gasto + deuda de tarjeta). Un ciclo tiene un pago activo; se corrige por reversión. | C/P |
| RN-F03 | Pagar un ciclo con fecha distinta a la renovación **no cambia** el calendario (RN-C06). | C |
| RN-F04 | **Costo previsto** = `pago real − Σ cuotas exigibles de terceros` (neto + ajustes activos de cargos no cancelados, sin cortesías). | C |
| RN-F05 | **Costo según cobros** = `pago real − Σ aplicaciones activas a cargos de ese ciclo`. La **deuda pendiente** se muestra aparte. | C |
| RN-F06 | **Atribución**: un cobro se atribuye al ciclo del cargo al que se aplica. Los anticipos sin aplicar **no** se restan del costo de ningún ciclo. | C/P D-12 |
| RN-F07 | Un costo neto negativo (cuotas > pago) se muestra como **excedente**, no como costo cero. | C/P D-12 |
| RN-F08 | Ejemplo: pago 47, cuotas exigibles 34, cobros 24 → previsto **13**, según cobros **23**, pendiente **10**. | C |

## 10. Estados derivados (resumen)

| Concepto | Cómo se obtiene |
| --- | --- |
| Pendiente de un cargo | RN-CH04 |
| Estado de pago | `neto+ajustes = 0` → `exento`; `aplicado = 0` → `sin_pagar`; `0 < aplicado < total` → `parcial`; `pendiente = 0` → `pagado`; cargo `void` → `cancelado` |
| Vencido | `hoy_local > due_date` y `pendiente > 0` |
| Crédito libre | RN-R09 menos reservas activas |
| Deuda de un contacto | Σ pendientes de sus obligaciones (cargos + componentes de préstamo) |
| Saldo de cuenta | Σ `account_entry.amount` de la cuenta |
| Ocupación | plazas activas / capacidad |
