# EVA — Definición mediante preguntas

Fecha: 7 de octubre de 2026. Este registro distingue respuestas del creador de interpretaciones por confirmar. La entrevista continuará por bloques con opciones escritas directamente en el chat, porque las preguntas interactivas dejaron de aparecer en la interfaz del usuario.

## Respuestas confirmadas

1. Uso principalmente personal; primero solo el creador, quizá algunos amigos después. Cada administrador tendría sus propios datos; detalles de acceso posterior pendientes.
2. Quiere una versión funcional completa de finanzas personales, además de suscripciones. No excluir préstamos del diseño; presupuestos, metas y demás módulos requieren preguntas específicas.
3. Servicios compartidos y personales independientes: Netflix, Spotify, Amazon Prime, ChatGPT, Claude, entre otros. Un contacto puede participar en varios servicios y debe tener resumen total.
4. Cuotas manuales distintas entre personas (por ejemplo S/ 10 y S/ 12), con recomendación automática entera preferentemente redondeada hacia arriba. El ejemplo verbal «45 / 4 = 11.5» se corrige matemáticamente: 45 / 4 = 11.25; la sugerencia hacia arriba sigue siendo S/ 12.
5. Mensual, anual, semanal y frecuencia personalizada. Calendario anunciado y fecha real de pago pueden diferir por retrasos.
6. El administrador también ocupa cupos, sin pagarse a sí mismo. Controlar capacidad del plan y múltiples cupos ocupados por un contacto.
7. Separar precio anunciado (ej. S/ 45), importe real cobrado por banco (ej. S/ 46 o S/ 47), cuenta/tarjeta usada en cada pago y cuotas de contactos. La cuenta puede cambiar entre pagos.
8. Desea mostrar cuánto le cuesta realmente el servicio: pago real menos aportes de terceros. Si los aportes superan lo pagado, mostrar excedente. Falta elegir si el indicador usa cuotas exigibles o dinero efectivamente cobrado; mostrar ambos es una propuesta.
9. Participantes pagan antes de usar; al incorporar uno, paga ese día. Ya elegido umbral configurable de días gratis, con excepciones por participante.
10. Impago acumula deuda; retirar al participante no elimina lo pendiente. No suspensión automática de participantes por deuda confirmada.
11. Cortesías por cantidad de ciclos (meses/semanas según frecuencia), hasta una fecha o permanentes hasta retirar el beneficio.
12. Quiere poder separar deuda anterior mediante un préstamo al contacto y reincorporarlo con nueva participación en cero, incluso con cortesía. Falta definir si traslado es opcional o automático, su momento y tratamiento sin movimiento ficticio.
13. Anticipos solo de participantes. Si cambia la cuota, deben completar la diferencia; no precio garantizado por adelantar dinero. Falta distinguir cambio del costo del proveedor de cambio de cuota individual.
14. Respuestas iniciales: baja al terminar período o inmediata con prorrateo; luego se indicó sin devolución. Última aclaración: sí devolver anticipos de ciclos futuros, terminando el ciclo actual. La baja inmediata depende de días utilizados/restantes y aún requiere una regla concreta.
15. Excel actual genera dificultades al reemplazar personas, registrar pagos al proveedor y cambiar precios/fechas.
16. Convertir servicio compartido en individual conserva las deudas por contacto. Falta si permanecen como deudas de origen suscripción o pasan a préstamos.
17. Desea ayuda automática configurable ante cambios de fechas y plan, mostrando propuestas que pueda ajustar.

## Casos reales pendientes de resolver

## Respuestas del bloque de cupos, cuotas y cobros

- Cuota total por contacto o por plaza, elegible. Estado de cuenta detalla plazas, por ejemplo Netflix primera cuenta y segunda cuenta a S/ 12 cada una. Pendiente reparto visual si cuota pactada es total.
- Sugerir cuota desde precio anunciado, redondeando hacia arriba; el administrador puede cambiarla.
- Mostrar costo previsto y costo tras cobros, con deuda pendiente aparte.
- Ante subida de precio, proponer cuotas/diferencias y confirmar; Gemini puede asistir en la explicación/propuesta.
- Un cobro de S/ 50 es un único ingreso en cuenta, categoría servicios, distribuible entre varios servicios. Cada parte referencia el mismo ID de pago.
- Sobrante destinado por defecto a próxima cuota del mismo servicio; traslado manual permitido.
- Retirar participante convierte deuda en préstamo con detalle de origen por servicio y período. Se interpreta que el desglose debe conservarse porque el creador exige saber qué se le cobra; no borrar ni duplicar la deuda.

Los hechos anteriores actualizan las dudas correspondientes del primer bloque. No confirman todavía reglas de calendario ni conversiones al cambiar todo un plan a individual.

### Suspensión y reactivación de YouTube

Renovación original cada 28; olvida pagar, hay alrededor de cinco días de gracia, luego se suspende. Al reactivar la nueva fecha es cada 4. Quiere soporte para el cambio sin calcularlo todo manualmente.

Confirmado posteriormente: gracia variable sin cobro; suspensión sin descuento de cuota; correr fechas de participantes a nueva renovación sin cobrar días adicionales. Falta definir transición de cargos/pagos existentes, fechas adelantadas y cobertura futura.

### Cambio de Spotify al agregar un miembro

Agregar miembro por S/ 10 puede modificar la fecha de renovación. EVA debe registrar el calendario y costo efectivos comunicados por proveedor/banco; no inferir que todos los proveedores prorratean de la misma manera. Falta decidir qué ocurre con los períodos ya cobrados a contactos.

## Consecuencias para el modelo conceptual

## Respuestas del bloque de calendarios y bajas

- Cuotas de participantes vencen en la renovación del servicio.
- Gracia de duración variable, no cinco días fijos; sin cargo adicional.
- Suspensión no reduce la cuota ni genera devolución/saldo a favor por los días sin acceso.
- Cambio de renovación tras reactivación: correr calendario de participantes, sin cobrar días adicionales.
- Cambio de compartido a individual: terminar participaciones y trasladar automáticamente deudas a préstamos con desglose.
- Esta respuesta de no devolver fue aclarada en el bloque siguiente: terminar ciclo actual y devolver ciclos futuros. No tratarla como prohibición definitiva de reembolso.

## Respuestas del bloque de anticipos y excepciones

- Pago tardío modifica solo fecha real de pago; calendario conserva renovación del proveedor mientras este no la cambie.
- Abono parcial no limita días de acceso; ciclo completo con deuda restante.
- Ejemplo: anticipo enero a julio, baja solicitada en febrero, devolver marzo a julio y terminar febrero. La condición expresada «si aún no se pagó al proveedor» requiere concretarse.
- Cambio de compartido a individual en el siguiente corte, no inmediatamente: si renueva cada 4, terminar el ciclo hasta el siguiente 4. Devolver cobertura posterior sobrante.
- Diferencias por subida de cuota pueden cobrarse por renovación o todas juntas, elegible por administrador.
- Baja inmediata depende de días usados y restantes; faltan umbral, fórmula y excepciones antes de automatizar.

## Consecuencias actualizadas para el modelo conceptual

## Respuestas de precisión de bajas y cálculo

- Confirmado: finalizar mes significa terminar ciclo del servicio; renovación cada 4 lleva baja al siguiente 4.
- Si proveedor ya cobró el ciclo, terminarlo sin devolución; sí devolver anticipos de períodos futuros.
- El creador prefiere límite configurable de días utilizados: si usó menos, permitir baja con cobro proporcional; en otro caso terminar ciclo. Preguntó recomendación: se recomienda este criterio con vista previa; igualdad y relación con pago al proveedor aún pendientes.
- Regla actualizada por el creador: prorrateo mensual con base fija 30, cuota / 30 × días; cobro final hacia arriba a entero. Sustituye redondeo hacia abajo. Confirmado también: semanal entre 7; anual entre días del año. La devolución resta cobro calculado a pago de la cobertura cancelada sin nuevo redondeo. Frecuencias personalizadas pendientes.
- Cuota nueva desde próximo ciclo, no cambiar precio del ciclo iniciado.

## Consecuencias del bloque de precisión

Últimas respuestas de cierre: si ya pagó el ciclo al proveedor, el participante termina el ciclo incluso si cumple umbral de salida temprana. Para una salida con devolución aplicable, S/ 20 recibidos menos S/ 7 de cobro calculado devuelve S/ 13.

- Añadir capacidad y ocupación temporal por cupo, incluyendo propietario; definir cuota por contacto o plaza antes del esquema físico.
- Historial de cambios del servicio: plan, precio, calendario, suspensión, gracia y reactivación, con fechas efectivas y propuesta/confirmación del ajuste.
- Separar cobertura, vencimiento, pago real y monto anunciado; cada pago conserva la cuenta usada.
- Contacto con resumen de varios servicios y préstamos; los totales deben distinguir deuda, anticipos y movimientos reales.
- Préstamos recibidos/otorgados con acreedor/deudor identificados; cuotas, intereses y pagos todavía no definidos.
- Traslado de deuda necesita referencias y operación atómica: conservar origen, cerrar pendiente original y abrir obligación nueva sin duplicar deuda ni registrar ingreso/egreso inexistente.
- El modo individual/compartido requiere vigencia histórica; modificar configuración actual no borra cargos previos.

## Próximos bloques de entrevista

## Respuestas iniciales de préstamos — 10 de octubre de 2026

- Deuda retirada de varios servicios se reúne en un préstamo con conceptos/períodos detallados; préstamos anteriores permanecen aparte.
- Préstamos personales sin interés, con importe fijo adicional o con interés porcentual configurable. Fórmula, periodicidad y base pendientes.
- Devolución en cuotas, con fecha final y abonos libres, o sin fecha acordada, elegible por préstamo.
- Bancarios: fotografiar documentos y extraer datos con Gemini, preguntar faltantes y permitir ingreso manual completo. Solicita ayuda para definir calendario orientativo, cambios de fechas y soporte de tarjetas; no ha aprobado todavía la propuesta técnica de seguimiento.
- Un cobro cubre servicios y préstamos con un ingreso real y repartos vinculados al mismo ID.
- Solo préstamos nuevos por ahora; no importación de saldo/historial anterior confirmada. La conversión de deuda de servicios sigue siendo una vía confirmada que no crea un desembolso ficticio.

## Bloques siguientes de entrevista

## Respuestas de seguimiento bancario e intereses — 10 de octubre de 2026

- Seguimiento detallado de capital, interés, seguros y comisiones cuando se conocen; todos los datos confirmados por documento o por usuario, sin conjeturas guardadas como datos bancarios.
- Tarjeta como cuenta de tipo crédito; estados de cuenta, consumos y compras en cuotas.
- Carga por fotos, PDF multipágina, manual y correo reenviado.
- Interés personal configurable sobre capital original o pendiente. Sin confirmar interés compuesto.
- Conversión de servicios sin interés por defecto y opción de configurar condiciones al convertir.
- Distribución de abono elegida manualmente por el administrador, por cuotas/conceptos.

## Bloques pendientes

## Respuestas de intereses y pagos — 10 de octubre de 2026

- Frecuencia configurable, mostrando mensual como recomendada.
- Política de pago anticipado elegible: interés total acordado o solo generado hasta devolución.
- Distribución configurable por préstamo, modificable antes de confirmar. Aclaración del 11 de octubre: dentro de cada cuota, primero capital y después interés. No confirmado interés compuesto ni capitalización de interés impago.
- Cargos por atraso configurables, con vista del cálculo antes de aplicar.
- Precisión aclarada: mantener enteros en redondeos de suscripciones, representados como .00; otros cálculos monetarios hacia arriba a dos decimales. Importes reales/documentales conservan valor exacto, como un Yape con centavos. No redondear tasas ni pasos intermedios.
- Excedente de pago: preguntar si conservar saldo a favor o devolver.

## Bloques aún pendientes

## Respuestas de cuentas y clasificación — 11 de octubre de 2026

- Pregunta 1 (prioridad capital por préstamo o cuota): respuesta sin letra, confirma configurabilidad pero no alcance. Pendiente aclaración.
- Tipos: bancarias, ahorro, crédito, efectivo, billeteras y tarjetas digitales; cita SIP como ejemplo. No necesita fijar marcas como tipos de tabla. No apartados virtuales confirmados.
- Yape/Plin: configuración vinculada a cuenta o independiente (por ejemplo DNI), según caso real; evitar duplicar saldo.
- App solo soles inicialmente. Dólares/conversión posterior configurable. Desea futura web con vista general de tipo de cambio mediante API, tasas y posible predicción básica; alcance/proveedor pendientes.
- Respuesta numerada 5 describe clasificación de gastos (pregunta 6), no saldo inicial (pregunta 5). No inferir saldo inicial confirmado.
- Quiere poder repartir gasto entre categorías o asignarlo a categoría dominante: ejemplo S/ 5 hamburguesa + S/ 95 periférico, categoría general tecnología.
- Gemini sugiere categorías de correos con información suficiente. Yape sin concepto requiere opciones configurables: preguntar al entrar, categoría por canal (Yape/tarjeta), regla de importe pequeño (ejemplo menos de S/ 10 → minigastos), y ajuste manual.
- Automatizar parcialmente conservando facilidad para registro claro/manual. No confirma aceptación automática de movimientos ni asignaciones irreversibles.

## Bloques por completar

## Respuestas de cierre de cuentas y categorías — 11 de octubre de 2026

- Reparto predeterminado del abono personal dentro de cada cuota: capital primero, luego interés; configuración editable.
- Saldo inicial real de cuenta o deuda inicial de crédito, sin crear ingreso/gasto. No carga de movimientos anteriores seleccionada.
- Configuración de predeterminado desglose/categoría dominante y excepción por compra.
- Reglas propias antes que Gemini; IA ayuda si ninguna aplica, con corrección manual.
- Categoría obligatoria o clasificación posterior configurables. Aceptación sin categoría, si se habilita, no deja el dinero como propuesta: afecta saldo y queda pendiente solo la clasificación.
- Categorías sugeridas y propias con subcategorías, renombrado y archivo; alta configurabilidad.

## Bloques siguientes

## Respuestas de planificación financiera — 11 de octubre de 2026

- Presupuestos por categorías/subcategorías, con períodos y niveles de aviso configurables.
- Metas con objetivo, fecha opcional y aportes vinculados a cuentas; sin duplicar saldos.
- Recurrencias configurables para programar propuestas, vincular correos coincidentes y evitar duplicados; siempre preguntar antes de registrar, por seguridad.
- Conciliar revisando/corrigiendo movimientos; si diferencia no explicada, ajuste con fecha y motivo.
- No gastos compartidos ocasionales por ahora.
- Panel elegible/reordenable con tarjetas de resúmenes financieros y servicios/contactos.

## Siguientes bloques por definir

## Respuestas de captura y Gemini — 11 de octubre de 2026

- Aviso al abrir, contador y notificaciones opcionales, configurables.
- Revisión individual y por lote con preferencia configurable; confirmación explícita antes de afectar saldos.
- Sugerencias de contacto/conceptos basadas en datos y reglas configurables por remitente; revisar y confirmar. No sustituye selección manual previamente acordada de aplicaciones.
- Posibles duplicados: configurable entre mostrar propuestas separadas con advertencia o agrupar como posible coincidencia y preguntar si es una operación.
- Conservación configurable de originales, selección de cuáles guardar y plazo de eliminación.
- Gemini para reportes/recomendaciones por período y chat sobre datos; selección de cuentas, servicios, categorías y períodos incluidos.
- Estas respuestas eligen capacidad/configurabilidad, no valores iniciales ni aceptación automática. Falta cerrar configuración predeterminada y operación cuando IA/extracción falla.

## Bloques que siguen

## Respuestas de reportes y web — 11 de octubre de 2026

- Móvil: tablas/reportes en PDF. La respuesta 2 precisa la respuesta 1: no CSV/Excel en móvil inicialmente.
- Web: exportación más completa y detallada, con gráficos, CSV, Excel y PDF. Otros formatos «necesarios» pendientes de concretar.
- Resumen con ambas vistas: resultado por conceptos y flujo de dinero, sin doble gasto al pagar crédito ni ingreso ganado por capital prestado.
- Contactos: resumen y detalle desplegable/filtrable de cargos, ciclos, cupos, pagos/aplicaciones, cortesías, devoluciones y saldos.
- Primera web consulta/análisis/exportaciones/tipo de cambio; administración se añade después.
- Todos los módulos/datos relevantes exportables, ordenados, con selección y orden de contenido por usuario. No exportar secretos ni datos de otros usuarios por interpretar «todo» literalmente.

## Bloques de cierre siguientes

## Respuestas de presupuestos y metas — 11 de octubre de 2026

- Relación entre presupuesto de categoría y subcategoría configurable, con alcance claro.
- Después de explicación: presupuesto de servicios cuenta pago real al proveedor menos cobros reales; deuda impaga no se descuenta. Comparar con costo esperado (debió pagar 11, actualmente pagó neto 23).
- Después de explicación: límite previsto reinicia cada período por defecto (300), con arrastre configurable por presupuesto.
- Vistas configurables de saldo/avance y saldo total/reservado/libre.
- Si gasto usa reserva de meta, avisar y preguntar de cuál descontar antes de confirmar.
- Aportes por asignación de dinero existente, vinculación de transferencias reales y programación de propuestas, siempre con confirmación.

## Bloques pendientes de cierre

## Respuestas de acceso, respaldo y operación — 11 de octubre de 2026

- Acceso con Google y correo/contraseña.
- PIN y biometría configurables, incluyendo cuándo volver a bloquear.
- Elección inicial de registrar offline posteriormente sustituida: vigente solo consulta de caché, con registro/edición/confirmación online.
- Respaldos recuperables automáticos y archivo manual descargable/restaurable.
- Notificaciones configurables con contenido discreto predeterminado.
- Recordatorios al administrador y texto/estado de cuenta para compartir manualmente, con plantillas por servicio/contacto. No envío automático a terceros confirmado.
- Capacidades confirmadas; manejo de conflictos, política de restauración y operaciones offline exactas pendientes.

## Bloques para cierre de definición

## Respuestas de operación y valores configurables — 11 de octubre de 2026

- Revisión explícita de offline: solo entrar a ver datos cargados con internet; registrar/editar/confirmar tras recuperar conexión. La elección anterior de escrituras offline queda descartada.
- Restauración elegible entre reemplazo con vista previa/copia de recuperación e incorporación de faltantes con revisión.
- Contenido de respaldo elegible, configuración del automático separada; frecuencia semanal/mensual u otra configurable.
- Retención elegible: último respaldo reemplaza anteriores o conservar dos. Nueva copia verificada antes de eliminar vieja como propuesta de implementación necesaria.
- Días gratis desde predeterminado definido por usuario, con excepciones por servicio/participante.
- Varios avisos configurables por anticipación, repetición y horario.

## Excepciones y priorización por cerrar

## Respuestas de excepciones y resumen mensual — 11 de octubre de 2026

- Cada cupo con cuota individual independiente: Netflix 10 + 10 o 10 + 8, detalle separado y total agregado. No elegir reparto igual automático por interpretar respuesta como A/C.
- Pregunta de frecuencia personalizada de servicios no respondida: respuesta 2 habla de respaldo semanal/mensual configurable; mantener pendiente y distinguir ambas configuraciones.
- Límite de prorrateo al importe de cuota: pendiente; solicita explicación.
- Capitalización/interés compuesto solo al activar explícitamente modalidad del préstamo; frecuencia/fórmula pendientes, no activarlo por defecto.
- Prorrateo o período iniciado completo para interés devengado al devolver antes, elegible por préstamo.
- Cobros tardíos con vista por período de origen y por mes real de cobro, base elegible por presupuesto.
- Nueva necesidad confirmada: resumen mensual de todos los ingresos/egresos, de dónde entró/salió, general y detallado; no confundir aplicaciones/cobros con nuevos movimientos ni recuperación de deuda con ingresos duplicados.

## Preguntas de aclaración siguientes

## Aclaración de cuota por ciclo y frecuencia

- Confirmado por explicación del creador: cuota normal por ciclo; calcular días al incorporar entre renovaciones porque no corresponde cobrar ciclo completo. Mantener umbral gratis, base mensual 30 y redondeo entero previamente acordados. No aplicar 31/30 a cuota normal ni redefinir por inferencia las fechas de proveedor.
- Frecuencia personalizada de servicios sigue pendiente: solicita ejemplos claros. Distinguir intervalo repetible (cada 15 días/cada 2 meses) de fechas irregulares ingresadas manualmente y de frecuencia de respaldos.

## Frecuencia de servicios cerrada por el creador

- Al crear servicio, fecha de inicio y fecha del siguiente pago indicadas por proveedor, con frecuencia configurable; ejemplo semanal = 7 días. Verificar coherencia entre esos datos al registrar.
- Luego permite mover fechas/configuración. No exigir más calendario manual al alta ni inferir lista de fechas irregulares como solicitud adicional.
- Esta respuesta resuelve la duda de frecuencia anterior. Próxima fecha programada distinta de fecha real del pago, conforme regla confirmada de atraso.

## Respuestas de cierre de reglas — 12 de octubre de 2026

- Regalo con deuda anterior: elegir mantenerla en servicio o convertirla en préstamo; no condonación automática.
- Capitalización: únicamente cuando usuario la solicita/confirma, sin frecuencia automática.
- Correcciones completas con vista de efectos e historial; deshacer aceptación y volver a revisar.
- Resumen mensual en vista recalculable y versiones guardadas/exportadas; correcciones generan otra versión.
- Siguientes decisiones: dispositivo/plataforma inicial, transición desde Excel, orden de pruebas y presupuesto operativo. Detalles técnicos rutinarios se resolverán en diseño, no requerir encuesta de cada índice/transacción.

1. Cupos/cuotas, costo personal y pagos por contacto entre servicios.
2. Anticipos, cambios de cuota y traslado de deuda a préstamos.
3. Calendarios, gracia, suspensión, reactivación y cambios de plan.
4. Préstamos otorgados/recibidos y bancarios.
5. Cuentas, tarjetas, gastos, categorías, monedas y otros módulos financieros.
6. Captura por correo/foto, duplicados, privacidad y análisis Gemini.
7. Pantallas, reportes, exportación, web, respaldos y operación.
8. Prioridades y criterios de aceptación de cada entrega.

El historial anterior conserva las dudas tal como surgieron; consultar decisiones vigentes y escenarios antes de diseñar el esquema físico.

## Plataforma y primera entrega — 12 de octubre de 2026

- Android primero; aplicación prevista también para iOS.
- Empezar desde cero con datos nuevos, sin importar el Excel anterior.
- Primer recorrido para probar: cuentas y suscripciones, contactos, cuotas, pagos parciales y anticipos.
- Presupuesto operativo todavía sin importe definido. El creador considera Railway y Supabase, y dispone de un plan que llama Gemini Pro. Comparar condiciones y confirmar beneficios de API antes de presupuestarlos.
- Esto no autoriza contrataciones, despliegues ni cambios en las cuentas de proveedores.
