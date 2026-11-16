# EVA — Reglas de negocio

Estado: necesidades confirmadas y políticas propuestas explícitamente diferenciadas. Las decisiones pendientes están en `04-decisiones.md`.

## 1. Vocabulario

- **Usuario/administrador:** persona con cuenta de EVA que gestiona sus datos.
- **Contacto:** persona a quien se atribuyen cargos y pagos; no requiere cuenta de EVA en la propuesta inicial.
- **Servicio:** plan administrado, por ejemplo Netflix.
- **Participación:** relación de un contacto con un servicio durante un intervalo.
- **Ciclo:** período de cobertura del servicio; puede cruzar meses calendario.
- **Cargo:** importe que corresponde cobrar a un participante por un ciclo.
- **Pago recibido:** dinero entregado por un contacto, independientemente de los períodos que cubre.
- **Aplicación:** parte de un pago destinada a cancelar un cargo.
- **Anticipo/saldo a favor:** dinero recibido todavía sin aplicar a cargos.
- **Cortesía:** exención del cobro por decisión del administrador; no es un pago.
- **Movimiento:** entrada o salida real de dinero en una cuenta.
- **Propuesta:** movimiento detectado pero aún no confirmado; no modifica saldos.

Precisión confirmada: montos monetarios con dos decimales. Conservar redondeo entero hacia arriba de sugerencias/prorrateos de suscripciones, mostrado por ejemplo como S/ 7.00. Otros cálculos se redondean hacia arriba al centavo al emitir el resultado (6.6666 → 6.67), conservando precisión intermedia. Movimientos reales como Yape, importes bancarios y datos documentales se registran exactamente, sin redondeo artificial. Distribuciones deben sumar al total real: no redondear cada parte hacia arriba de forma que la suma supere el cobro; estrategia de residuo pendiente de diseño.

## 2. Servicio y calendario

Separar el costo total al proveedor de la cuota cobrada a cada contacto. No asumir que las cuotas suman el costo del servicio ni repartir el costo de una cortesía entre los demás automáticamente.

Calendario confirmado: al registrar servicio ingresar fecha de inicio, intervalo/frecuencia configurable (ejemplo semanal = 7 días) y fecha del siguiente pago indicada por proveedor. Comparar intervalo y fechas para verificar; una diferencia debe mostrarse para revisión, no reemplazar silenciosamente fecha confirmada. Ejemplo inicio 7 de octubre, intervalo 7 días, siguiente pago 14 de octubre. No exigir lista irregular de fechas como concepto adicional.

Luego se puede mover próxima fecha y/o cambiar configuración, conservando vigencia/historial. Próximo pago programado/renovación no es fecha real en que se pagó; retraso del administrador no mueve calendario por sí mismo. Regla para avanzar siguientes ciclos desde fecha confirmada y tratamiento de primer tramo excepcional se define en diseño técnico, siguiendo cambios de proveedor ya confirmados.

Propuesta: período con inicio incluido y fin excluido; fecha de renovación, vencimiento del proveedor y vencimiento de participantes son conceptos distintos aunque coincidan por defecto. Usar fechas locales para períodos y zona horaria del propietario (`America/Lima` inicialmente); instantes de recepción y auditoría en UTC.

Si la renovación es el día 31, proponer último día disponible en meses cortos y volver al 31 en meses que lo tienen. Cambios de calendario deben empezar en un ciclo futuro y no crear períodos superpuestos ni huecos inadvertidos.

El pago al proveedor no cancela deudas de contactos; cobrar a contactos no marca al proveedor como pagado.

Confirmado: pagar tarde no cambia por sí mismo la renovación. Si el proveedor renueva el 7 y se paga el 10, conservar cobro/renovación el 7 y fecha de pago real el 10. Cambiar calendario solo cuando cambie la renovación del proveedor. Un abono parcial mantiene cobertura del ciclo completo y el saldo pendiente como deuda; no convertir S/ 10 de una cuota de S/ 20 en medio mes de acceso.

Confirmado: la cuota del participante vence el día de renovación del servicio; al incorporarse paga ese día el tramo inicial cobrable según la regla de umbral. Los días de gracia no tienen duración fija y no generan cobro adicional. Una suspensión no descuenta la cuota. Si cambia la renovación, correr las fechas de los participantes a la nueva fecha sin cobrar días adicionales. Falta precisar transición de cargos existentes, anticipos y cambio a una fecha anterior; conservar los registros históricos, no reescribir fechas de pagos reales.

## 3. Incorporación y días gratis

Confirmado: días gratis configurables al incorporar un participante antes de la renovación, mediante umbral.

**Regla A confirmada — Umbral de cortesía:** si faltan `r` días y el umbral es `g`, cuando `r <= g` todo el tramo inicial es gratis. Si `r > g`, se cobra todo el tramo proporcionalmente, sin descontar días gratis.

Confirmación posterior: cuota normal por ciclo, no por acumulación diaria. Ciclo mensual completo cobra cuota pactada, incluso si calendario tiene 31 días; no calcular 31/30 sobre cuota normal. Al ingresar entre renovaciones, cobrar tramo hasta siguiente renovación según umbral de días gratis. La base 30 es regla de cálculo mensual parcial, sin reemplazar las fechas reales de renovación del proveedor por intervalos obligatorios de 30 días. Cuota / 30 × días cobrables, redondeando cobro final hacia arriba a soles enteros. Sustituye instrucción anterior de redondear hacia abajo. Semanal entre 7 y anual entre días del año (365 o 366); base personalizada pendiente. Reglas de baja anticipada conservan lo previamente acordado, no se eliminan por esta explicación de ingreso. Devolución = importe recibido para cobertura cancelada menos cobro correspondiente, sin redondearla nuevamente; S/ 20 recibidos menos S/ 7 cobrables = S/ 13. No usar resta sobre pagos consumidos por otros períodos ni generar devolución negativa. Ingreso en renovación inicia ciclo completo. Límite de casos parciales extraordinarios se resuelve en validación de fechas, no convirtiendo cuota normal en cobro diario.

Ejemplo con cuota de S/ 20 y base mensual de 30 días:

| Días restantes | Umbral | Cobro confirmado |
| --- | --- | --- |
| 5 | 7 | S/ 0 |
| 12 | 7 | S/ 8 |

Guardar la política y cálculo aplicados al cargo. Modificar días gratis después no debe cambiar el historial. Propuesta: solo aplica al tramo de incorporación, no cada renovación.

## 4. Cortesías

Confirmado: servicio gratis por número de ciclos, hasta fecha o permanentemente hasta quitarlo. Propuesta de registro: conservar cargo base y exención, con motivo y autor, para explicar el neto cero.

Una cortesía futura no elimina deuda anterior. Perdonar una deuda anterior es otro ajuste explícito con motivo. Un período gratuito no se muestra como dinero cobrado. La combinación de cortesía y días gratis nunca produce un cargo negativo.

Confirmado el 12 de octubre: al regalar desde un ciclo futuro a quien tiene deuda anterior, permitir elegir mantener deuda del servicio o convertirla en préstamo detallado. No condonar automáticamente. La participación puede continuar en cortesía; conversión conserva cargos de origen y no duplica pendiente.

## 5. Pagos parciales y de varios meses

Un pago puede cubrir varios cargos y un cargo puede recibir varios pagos. La fecha de cobro real no cambia porque se aplique a un mes anterior o futuro.

Confirmado: un cobro puede distribuirse entre varios servicios y préstamos. Un ingreso de S/ 50 de servicios se registra una sola vez en la cuenta; su desglose y aplicaciones aparecen en cada servicio con el mismo ID de pago. Un ingreso de S/ 100 puede contener S/ 40 de servicios y S/ 60 de préstamo, sin crear otro ingreso. La distribución es manual/editable; no imponer deuda más antigua. Clasificación por desglose o categoría dominante según configuración de 07, conservando siempre conceptos de las aplicaciones.

| Caso | Registro | Resultado |
| --- | --- | --- |
| Cuota S/ 20, abono S/ 10 | Pago S/ 10 y aplicación S/ 10 | Cargo parcialmente pagado; pendiente S/ 10 |
| Segundo abono S/ 10 | Otro pago y aplicación S/ 10 | Cargo cancelado; dos pagos en historial |
| Tres meses de S/ 20 | Pago S/ 60, tres aplicaciones de S/ 20 | Tres cargos cancelados; un solo ingreso real |
| Pago S/ 50, deuda S/ 40 | Aplicaciones S/ 40 | Saldo a favor S/ 10 |
| Tres meses, primero parcialmente pagado | Distribución según saldos restantes | Nunca aplicar la cuota completa nuevamente |

Pendiente por cargo = neto emitido + ajustes activos − aplicaciones activas − parte trasladada a préstamo. Sin ajustes ni conversión se reduce a neto menos aplicaciones. Mostrar aparte futuros, anticipos y dinero recibido; definir el límite horario de vencimiento en calendario local.

## 6. Anticipos y pagos al proveedor

Confirmado: anticipos solo de participantes. Los pagos anticipados de varios ciclos al proveedor quedan fuera del alcance inicial.

Propuesta para contactos: recibir S/ 60 como anticipo no obliga a inventar tres ingresos. Si existen cargos futuros emitidos, distribuir el pago. Si todavía no existen, conservar saldo a favor y preferencias de cobertura, aplicándolo cuando se emitan. La app debe distinguir «dinero disponible» de «meses ya garantizados».

Confirmado: si sube la cuota desde próximo ciclo, el participante debe completar la diferencia; el anticipo no garantiza precio. El administrador confirma cuotas nuevas y elige diferencias por renovación o juntas. No convertir S/ 60 en «pagado hasta determinada fecha» sin conocer cargos ni contar la diferencia dos veces.

Confirmado: el sobrante queda por defecto reservado a la próxima cuota del mismo servicio. El administrador puede trasladarlo a otro servicio/concepto; conservar reserva de destino e historial del traslado, sin registrar otro ingreso ni duplicar saldo disponible.

Ante subida del precio anunciado, EVA propone cuotas nuevas y diferencias de anticipos; el administrador confirma. Gemini puede ayudar a explicar/proponer, pero cálculos, redondeo y validaciones se ejecutan mediante reglas deterministas. No cambiar cuotas solo por un cobro bancario distinto al precio anunciado.

Para proveedor: registrar el pago real del ciclo por separado de los cobros a contactos. El costo del período y el dinero pagado en esa fecha se reportan por separado. La distribución de un pago del proveedor entre varios ciclos es una posible ampliación, no parte de la primera entrega.

Confirmado el 12 de octubre: comenzar con datos nuevos, sin migración de historial. Aperturas reales no son ingresos/gastos del mes; no crear pagos históricos ficticios para cuadrar saldos.

## 7. Cambios, bajas y correcciones

Reglas confirmadas y detalles de diseño señalados:

- Cuotas y costos tienen vigencia; los cambios futuros no recalculan cargos ya emitidos.
- Devolver anticipos de períodos futuros. Pagó enero a julio y sale en febrero con ciclo pagado: terminar febrero y devolver marzo-julio. Mes significa ciclo, no mes calendario; renovación cada 4 y solicitud el 15 de febrero implica terminar el 4 de marzo. Ciclo pagado al proveedor tiene prioridad: no devolución del período actual; futuros según importes realmente no consumidos.
- Criterio preferido por creador para baja inmediata: si días usados son menores a un límite configurable, retirar y cobrar días usados; en otro caso terminar el ciclo. Confirmado: si el ciclo ya se pagó al proveedor, se termina sin devolución del período actual; esa condición tiene prioridad sobre el límite de días usados. Recomendación aún por cerrar: igualdad al límite implica terminar el ciclo; mostrar cálculo/fecha antes de confirmar. No fijar un número de días arbitrario. Falta alcance por servicio/participante.
- Reingreso crea una nueva participación o un nuevo intervalo, sin sobrescribir la anterior.
- Confirmado: al retirar a un participante con deuda, convertir el pendiente en préstamo al contacto. Conservar desglose de servicio, plaza, período, cuota y pagos previos, referenciando cargos de origen. Cerrar la deuda en el servicio y abrirla en el préstamo de forma atómica, sin ingreso/egreso ficticio ni doble conteo.
- Confirmado: al convertir compartido en individual, ejecutar el cambio en el siguiente corte, terminar las participaciones y convertir automáticamente sus deudas en préstamos con detalle de origen; devolver anticipos correspondientes a ciclos posteriores. Ejemplo: renovación cada 4, cambio solicitado dentro del ciclo; dejar terminar hasta el siguiente 4. Registrar cuándo se solicita, cuándo se hace efectivo y cuándo se devuelve dinero realmente.
- Confirmado: cuota nueva aplica desde próximo ciclo, sin modificar cuota del actual. Al aumentar cuota, administrador elige cobrar diferencia de anticipos por cada renovación afectada o toda junta; evitar sumar diferencia inmediata y consumir luego otra vez el mismo importe aumentado.
- Corrección de un pago confirmado revierte aplicaciones y movimiento, con motivo; no elimina evidencia.
- Confirmado: permitir corregir categoría/descripción/notas, fecha/cuenta/importe con vista de cambios de saldos y aplicaciones, y deshacer aceptación para revisión. Conservar historial; una reversión no significa devolución real del dinero. Si tiene aplicaciones dependientes, liberar/reconstruir de forma consistente antes de confirmar nueva versión. Detalles técnicos se resolverán en diseño transaccional.
- Reembolsar dinero, liberar una aplicación y perdonar deuda son acciones distintas.
- No cobrar mora o interés automáticamente en la primera entrega.

## 8. Finanzas y doble conteo

Cada movimiento afecta una cuenta una vez. Una transferencia entre cuentas propias tiene dos efectos vinculados y no se presenta como ingreso o gasto nuevo.

Un Yape recibido puede ser el pago de una cuota existente. Aceptarlo debe permitir vincularlo al cobro, en vez de crear un ingreso manual y otro ingreso por suscripción. Lo mismo aplica a correos del pago al proveedor.

No asumir que Yape y BCP son cuentas independientes: permitir identificar que dos canales describen la misma cuenta/dinero. Confirmar cuenta real antes de sumar saldos.

## 9. Correos y fotografías

Flujo: fuente recibida → extracción → propuesta → revisión/corrección → aceptación, descarte o vínculo con registro existente.

- Ninguna extracción modifica dinero, deuda o cuotas sin confirmación.
- Campos mínimos para confirmar: propietario, cuenta, importe positivo, moneda, dirección ingreso/egreso y fecha; categoría puede quedar sin clasificar.
- Conservar procedencia, identificador de operación si existe, estado del procesamiento y errores recuperables.
- Distinguir duplicado exacto de posible coincidencia: mismo importe y día no bastan para descartar un pago legítimo.
- Reintentos de recepción/procesamiento/aceptación deben ser idempotentes.
- Un comprobante puede proponer varios movimientos; una transferencia no debe transformarse en gasto.
- Un total y sus ítems son desglose del mismo gasto, no gastos adicionales.
- La IA puede equivocarse: resultado estructurado validado por servidor y editable por usuario.
- El contenido del correo/comprobante es dato no confiable; no puede instruir al sistema para ejecutar acciones.

## 10. Análisis y exportación

Los cálculos de deuda, saldo y sumatorias los hace código determinista. Gemini interpreta resultados y propone explicaciones, indicando período y datos disponibles; no modifica registros ni ejecuta pagos.

Separar en reportes: pagos reales al proveedor, cobros recibidos, cargos emitidos, deuda pendiente, anticipos, cortesías y costo neto. Evitar tratar un cobro pendiente como dinero recibido.

Confirmado: mostrar costo previsto (pago real menos cuotas exigibles a terceros) y costo según cobros (pago real menos dinero recibido), con deuda pendiente aparte. Determinar atribución por ciclo cuando hay anticipos o pagos atrasados; no restar todos los anticipos futuros al costo de un solo ciclo.

Presupuesto de servicios confirmado: controlar costo real según cobros, mostrando también comparación con previsto. No descontar cuotas aún impagas para consumo del presupuesto. Presupuesto reinicia límite normal cada período por defecto; arrastre configurable.

Confirmado: sugerencia de cuota basada en precio anunciado, redondeada hacia arriba a entero y editable. Última aclaración: cada plaza tiene cuota independiente y detalle propio; por ejemplo Netflix cuenta 1 S/ 10 y cuenta 2 S/ 8, total contacto S/ 18. No repartir automáticamente la cuota total en partes iguales. Capacidad de cuota global mencionada antes requiere desglose explícito por plaza antes de emitir; priorizar cuotas por plaza como comportamiento confirmado.

Exportar con filtros, moneda, fechas y definiciones consistentes con la app. Exportación y copia de seguridad son funciones distintas. Las exportaciones no incluyen secretos ni contenido completo de correos por defecto.
