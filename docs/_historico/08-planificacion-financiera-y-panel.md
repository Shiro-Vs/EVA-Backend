# EVA — Planificación financiera y panel

Actualizado el 11 de octubre de 2026. Núcleo solicitado; las reglas específicas pendientes no se presentan como aprobadas.

## 1. Presupuestos

Confirmado: límites por categoría y subcategoría, períodos y niveles de aviso configurables.

Modelo propuesto: período con fechas explícitas, presupuesto asignado, alcance por categoría/descendientes, reglas de aviso y uso calculado desde gastos confirmados. Confirmado: relación padre/subcategoría configurable, mostrando qué incluye cada límite; un gasto no se duplica en total general. Un presupuesto es límite/plan de gasto, no dinero adicional ni reserva bancaria automática.

Confirmado: servicio compartido consume presupuesto por costo real neto, pago real al proveedor menos cobros reales atribuibles. Cuotas impagas no reducen ese costo; mostrar comparación contra costo propio previsto y pendiente de cobrar. Ejemplo: pago 47, cuotas exigibles 36 y cobros 24 → costo previsto 11, costo real 23 y pendiente 12.

Confirmado posteriormente: dos vistas elegibles por presupuesto, cobros atribuidos a ciclo de origen y cobros por fecha real de recepción. Pago de enero cobrado en febrero aparece en flujo de febrero y recuperación de enero en vista por ciclo. No crear otro ingreso ni mover fecha real. Recuperación de deuda anterior explica saldo favorable del mes, distinguiéndolo de excedente de cuotas sobre costo. Falta detalle de devoluciones/anticipos y costos netos negativos, sin contar dos veces el mismo cobro.

Confirmado: cada período empieza con límite normal sin arrastre por defecto (300 presupuestados y 250 gastados → siguiente límite 300). Arrastre puede habilitarse por presupuesto. Falta alcance del arrastre ante exceso, tope y cambio de límite; efecto de ajustes/préstamos también pendiente.

Los avisos no bloquean automáticamente gastos. Bloqueo no solicitado. Preferencias de notificación pendientes.

## 2. Metas de ahorro

Confirmado: objetivo monetario, fecha opcional y aportes vinculados a cuentas reales para localizar el dinero, sin duplicar saldos.

Confirmado: aportar mediante asignación de dinero existente en una/varias cuentas, vincular transferencias reales de ahorro y programar aportes como propuestas siempre confirmables. Una asignación de S/ 100 de saldo BCP no crea ingreso, gasto ni otro saldo de S/ 100; una transferencia real puede asociarse al aporte. No confundir meta con cuenta bancaria.

Confirmado: vistas configurables de saldo y avance de meta, o saldo total/reservado/libre (ejemplo 1,000 total, 300 reservado, 700 libre). Si gasto usa dinero reservado, avisar y preguntar de qué meta descontar antes de confirmar. No ejecutar transferencias bancarias externas. Pendiente: varias metas por cuenta, cómo detectar uso de reserva, insuficiencia, base de proyección y detalle de fecha/avance.

## 3. Ingresos y gastos recurrentes

Confirmado: programación configurable y generación de propuestas, siempre con pregunta/confirmación antes de registrar. No ejecución automática de movimientos financieros, aunque exista regla o plantilla.

Separar plantilla (sueldo, alquiler, recibo) de ocurrencia del período, propuesta y movimiento confirmado. Si llega correo/foto de la misma operación, vincularlo a la ocurrencia/propuesta; no registrar ingreso/gasto adicional.

Una recurrencia es expectativa; sin confirmación no modifica cuenta ni presume que se cobró. Si cantidad o fecha difiere, mostrar dato esperado y real y solicitar revisión. Generación idempotente por plantilla/período.

Servicios ya generados por módulo de suscripciones no deben generar gasto duplicado mediante una recurrencia genérica. Falta definir integración de pagos de servicios, préstamos y tarjeta en calendario común.

## 4. Conciliación y ajustes

Confirmado: comparar saldo registrado con real, revisar/corregir movimientos y registrar ajuste con fecha/motivo si no se logra explicar diferencia.

Conservar saldo antes/después, importe de diferencia, autor y momento. No sobrescribir saldo sin evidencia histórica. Propuesta: ajuste no se clasifica como ingreso ganado o gasto de consumo por defecto; aparece separado para no distorsionar reportes. Tratamiento final pendiente.

## 5. Panel

Confirmado: panel configurable, con tarjetas elegibles y orden editable de finanzas, cuentas, servicios, contactos y próximos pagos. Persistir preferencias por usuario.

Pendiente lista exacta, tarjetas iniciales y filtros. Candidatas: saldo por cuenta, deuda de crédito, ingresos/gastos del período, presupuestos, metas, renovaciones, cobros pendientes, préstamos y propuestas para revisar.

Distinguir pendientes de aceptación (aún no afectan saldo) de movimientos aceptados con categoría pendiente (sí afectan saldo).

## 6. Límite confirmado

Gastos compartidos ocasionales (por ejemplo dividir cena entre contactos) excluidos por ahora. No añadir modelo de grupos/liquidación de gastos a partir de funcionalidad de suscripciones o préstamos.
