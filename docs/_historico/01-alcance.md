# EVA — Alcance y etapas

## 1. Visión confirmada

EVA permite administrar suscripciones compartidas y registrar finanzas personales con menos trabajo manual. El administrador conoce quién participa en cada plan, cuánto debe por período, cuánto pagó, qué meses cubrió y qué saldo queda. La captura mediante correos y fotografías propone movimientos que el usuario revisa antes de aceptarlos.

Netflix es un ejemplo de servicio; EVA registra la administración y los cobros. Agregar un participante en EVA no implica agregarlo automáticamente a la plataforma del proveedor.

Actualización confirmada: el producto está pensado principalmente para uso personal del creador, con posible acceso de amigos más adelante. El alcance completo incluye finanzas personales y préstamos, además de suscripciones. La construcción será incremental: primero Android, con iOS previsto; el primer recorrido utilizable será cuentas y suscripciones. Se comenzará con registros nuevos, sin importar el Excel ni reconstruir movimientos anteriores; los saldos iniciales reales se registran como apertura. Las reglas de los demás módulos están en los documentos específicos y el orden completo en el documento 14.

## 2. Funcionalidades solicitadas

| ID | Necesidad | Resultado esperado |
| --- | --- | --- |
| SUB-01 | Administrar servicios compartidos | Servicio, costo, renovación, participantes y cuotas |
| SUB-02 | Incorporar participantes entre renovaciones | Primera cuota con regla configurable de días gratis |
| SUB-03 | Dar un servicio gratis a alguien | Cortesía identificable, sin deuda ni pago ficticio |
| SUB-04 | Registrar anticipos por varios meses | Dinero recibido y cobertura futura trazables |
| SUB-05 | Cobrar varios meses juntos | Un cobro distribuido entre varios cargos |
| SUB-06 | Registrar pagos parciales | Cuota de S/ 20 con abono de S/ 10 y pendiente de S/ 10 |
| FIN-01 | Registrar ingresos y gastos | Movimientos por cuenta, fecha y categoría |
| FIN-02 | Cuentas bancarias, ahorro, crédito y billeteras/tarjetas digitales | Configurables según ubicación real del dinero |
| FIN-03 | Clasificación flexible manual, por reglas y Gemini | Desglose o categoría dominante; reglas por canal/importe |
| FIN-04 | Presupuestos por categoría/subcategoría | Períodos y niveles de aviso configurables |
| FIN-05 | Metas de ahorro vinculadas a cuentas | Objetivo, fecha opcional y aportes sin duplicar saldos |
| FIN-06 | Ingresos/gastos recurrentes | Propuestas configurables con confirmación obligatoria y vínculo con captura |
| FIN-07 | Conciliación de cuentas | Revisar movimientos y ajuste documentado si falta explicación |
| UI-01 | Panel configurable | Elegir y ordenar resúmenes financieros, servicios y contactos |
| REP-01 | Resumen mensual general detallado | Cuánto entró/salió, origen/destino y ambas vistas financieras, exportable |
| SEG-01 | Acceso Google/correo, PIN y biometría | Bloqueo y preferencias configurables |
| OFF-01 | Consulta sin conexión | Solo datos previamente cargados; escrituras/confirmaciones requieren internet |
| BAK-01 | Respaldos recuperables automáticos y manuales | Descarga/restauración distinta de reportes |
| NOT-01 | Notificaciones y textos de cobro | Contenido configurable, discreto por defecto; compartir manualmente |
| PRE-01 | Préstamos otorgados y recibidos, personales y bancarios | Control detallado según documento 06 |
| SUB-07 | Cupos y múltiples plazas por contacto | Capacidad, ocupación y cuota configurable |
| SUB-08 | Cambios de plan, precio, calendario, suspensión y reactivación | Historial conservado y propuesta de ajuste configurable |
| CAP-01 | Reenviar correos de Yape, BCP y otros | Bandeja de propuestas para revisar y aceptar |
| CAP-02 | Fotografiar comprobantes | Extracción con Gemini y confirmación del usuario |
| IA-01 | Analizar gastos y datos personales | Recomendaciones basadas en los registros disponibles |
| EXP-01 | Exportar información | PDF móvil; CSV, Excel, PDF y gráficos/detalle en web |
| WEB-01 | Versión web futura | Acceso a los mismos datos y exportación de gráficos |

## 3. Alcance recomendado por entregas

Estas prioridades son propuestas para revisión; todas las solicitudes anteriores pertenecen a la visión del producto.

### Entrega A — Núcleo móvil confiable

- Autenticación y aislamiento de información por propietario.
- Contactos, cuentas de dinero y categorías básicas.
- Servicios mensuales, anuales, semanales y personalizados; participantes y cuotas individuales con sugerencia de reparto redondeado hacia arriba.
- Renovaciones, cargos por período, incorporación y cortesías.
- Pagos parciales, pagos de varios meses, anticipos y saldo a favor.
- Registro separado del pago al proveedor y cobro a participantes.
- Ingresos, gastos y transferencias manuales.
- Historial, correcciones trazables y detalle de deuda por contacto y servicio.

Cierre: los escenarios del núcleo de suscripciones del documento 14 tienen resultados reproducibles; reiniciar la app conserva datos y no genera cobros duplicados. La conversión de deuda requiere el préstamo personal mínimo de esa entrega.

### Entrega B — Captura asistida (después de completar préstamos y planificación financiera)

- Dirección de recepción asociada al usuario y guía de reenvío.
- Procesamiento de correos y fotografías, adjuntos y seguimiento de errores.
- Bandeja unificada para corregir, aceptar, descartar o vincular con un movimiento existente.
- Detección de duplicados entre correo, foto y registro manual.

Cierre: aceptar dos veces una propuesta no duplica el movimiento; descartar no afecta saldos; un correo reenviado repetidamente no crea gastos repetidos.

### Entrega C — Análisis y salida de datos

- Resúmenes de gastos, cobros, pendientes y costo de los servicios.
- Recomendaciones de Gemini con período y datos usados visibles.
- Confirmado: móvil exporta tablas/reportes en PDF. CSV y Excel se ofrecen desde web; detalles en `10-reportes-exportaciones-y-web.md`.

### Entrega D — Web

- Misma identidad, backend y datos que móvil.
- Confirmado: primera web de consulta, gráficos, exportaciones y vista de tipo de cambio; administración de datos después, sin excluirla de la visión futura.
- Web exporta CSV, Excel y PDF, con gráficos/detalle y selección/orden de contenido. Formatos de imagen de gráficos pendientes de elegir; «todo lo necesario» no fija PNG/SVG u otros formatos automáticamente.

## 4. Límites propuestos para la primera entrega

- Confirmado: app inicialmente solo PEN. Dólares y conversión configurables como ampliación; futura web con vista general de tipo de cambio vía API, tasas y posible proyección básica todavía por delimitar. No elegir API ni incluir predicciones en la primera entrega.
- Confirmado: tú administras todo y los participantes son contactos; no necesitan cuenta de EVA.
- Anticipos solo de participantes. Pagos anticipados de varios ciclos al proveedor fuera del alcance inicial.
- Sin conexión bancaria directa ni débito/cobro automático: registrar y revisar pagos no mueve dinero real.
- Sin integración para crear cuentas o modificar planes en Netflix u otros proveedores.
- Cuota manual por persona y recomendación de reparto; la recomendación no reemplaza automáticamente cuotas acordadas.
- Préstamos personales/bancarios, presupuestos y metas confirmados en la visión completa; reglas pendientes se detallan en documentos correspondientes. Inventarios, facturación tributaria y organizaciones sin solicitud confirmada.
- Confirmado: gastos compartidos ocasionales (por ejemplo repartir una cena) fuera del alcance actual; no extender préstamos/suscripciones a ese módulo por inferencia.
- Decisión vigente: sin conexión únicamente consultar datos cargados previamente. Crear/editar/confirmar requiere internet; no cola de escrituras offline ni extracción remota sin conexión. Sustituye elección anterior de registrar offline.

## 5. Ideas incorporadas durante la definición

| Idea propuesta | Utilidad | Prioridad sugerida |
| --- | --- | --- |
| Vista «a quién cobrar hoy» | Reúne pendientes y vencimientos | Después del núcleo |
| Estado de cuenta por contacto | Explica cargos, pagos y meses cubiertos | Núcleo, vista sencilla |
| Recordatorio para el administrador | Evita olvidar renovación o cobro | Después del núcleo |
| Resumen compartible preparado por el usuario | Facilita explicar un cobro por WhatsApp | Después del núcleo; envío manual |
| Medir costo propio y recuperaciones | Distingue pago al proveedor, cobros y cortesías | Análisis |
| Aviso de posible duplicado | Evita sumar correo y foto del mismo pago | Captura asistida |
| Pausa y reingreso de participantes | Conserva historial al cambiar el grupo | Tras definir reglas de baja |

Estas necesidades fueron incorporadas durante las preguntas posteriores: estado por contacto, costo propio, posibles duplicados, reingresos, avisos al administrador y textos para compartir manualmente. La tabla conserva su motivación; las prioridades vigentes están en el documento 14.
