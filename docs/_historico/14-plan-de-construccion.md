# EVA — Plan de construcción y validación

Fecha: 12 de octubre de 2026. Alcance funcional acordado; secuencia técnica propuesta. Android primero, iOS previsto. Datos nuevos sin importación del Excel. No son fechas de entrega ni funcionalidades ya implementadas.

## Orden recomendado

Las reglas de negocio preceden al esquema físico. Después construir backend y frontend por recorrido: una pantalla con datos reales que pueda guardar, consultar y corregir. El backend asegura cálculos/integridad, el móvil permite comprobar que el flujo resuelve tus casos. No completar todo el front o todo el back por separado.

| Entrega | Incluye | Condición de salida |
| --- | --- | --- |
| 0. Diseño técnico | Revisión del código anterior, esquema PostgreSQL, contratos de API, casos de calendario pendientes | Modelo y reglas coherentes, sin confundir dinero con cargos |
| 1. Primer recorrido Android | Acceso, cuentas/saldos iniciales, contactos, servicio, plazas, ciclos, cuota, pago proveedor, cobro parcial/múltiple, anticipo | Crear Netflix, cobrar y ver pendiente/costo propio con persistencia real |
| 2. Núcleo completo de servicios | Cortesías, cambio cuota/precio, baja/devolución, cambio a individual, deuda a préstamo mínimo, calendario/gracia/reactivación, correcciones | Casos de salida/reingreso sin perder dinero ni historia |
| 3. Finanzas completas | Ingresos/gastos/transferencias, clasificación, préstamos completos/bancarios, crédito, presupuestos, metas, recurrencia y conciliación | Saldo, deuda, flujo y resultado reconciliados |
| 4. Captura y Gemini | Correo reenviado, foto/PDF, bandeja, duplicados, reglas, confirmación por lote, análisis/chat y límites | Propuestas corregibles; aceptar una vez, ningún cambio sin confirmar |
| 5. Operación e informes móviles | Resumen mensual vivo/versionado, PDF configurable, panel, avisos, bloqueo, caché de lectura, respaldos/restauración | Exportación reconciliada y restauración ensayada |
| 6. iOS y web | Validar iOS; web de consulta/gráficos/CSV/Excel/PDF, luego administración | Mismos datos y permisos; exportación consistente |
| 7. Ampliaciones | USD/conversión y vista de cambio, formatos gráficos adicionales, acceso de amigos | Alcance/costo revisados con ejemplos antes de agregar |

Seguridad de acceso, aislamiento, auditoría y recuperación básica se incorporan desde entrega 1. La entrega 5 amplía configuración y experiencia; no significa esperar hasta entonces para proteger datos. El orden 3/4 puede ajustarse tras probar el núcleo. No publicar una versión completa si omite silenciosamente módulos acordados.

## Pantallas y recorridos

| Área | Pantallas y acciones |
| --- | --- |
| Acceso | Google/correo, recuperación, bloqueo local y preferencias |
| Panel | Resumen configurable, cuentas, pendientes, próximos pagos y bandeja |
| Cuentas | Lista, detalle/movimientos, apertura, transferencia y conciliación; extensión de crédito |
| Contactos | Lista, estado total, plazas/servicios separados, préstamos, pagos/aplicaciones y texto para compartir |
| Servicios | Lista compartidos/personales, alta con calendario, detalle/cupos, proveedor previsto/real, participantes y ciclos |
| Participación | Alta/plazas/cuota, vista previa de prorrateo, cortesía, baja programada y devolución |
| Cobro | Contacto, cuenta/fecha/importe, reparto manual entre conceptos, crédito sobrante y confirmación |
| Pago proveedor | Servicio/ciclo, importe anunciado/real, cuenta o tarjeta y fecha real |
| Calendario/precio | Antes/después, cobertura y cargos afectados, confirmación con vigencia |
| Finanzas | Registro manual/desglose, categorías, préstamos y cronogramas, tarjeta/estado de cuenta |
| Planificación | Presupuestos, metas/reservas y propuestas recurrentes |
| Bandeja | Fuente/adjuntos, extracción, corrección, posible duplicado, aceptar/vincular/descartar individual o lote |
| Análisis/reportes | Período/filtros, flujo y resultado, origen/destino, costo de servicios, versión guardada y PDF |
| Ajustes | Reglas/defaults/excepciones, privacidad, avisos, IA, respaldo, restauración y acceso |

Toda confirmación sensible muestra efectos concretos: cuenta afectada, importes, deuda restante, crédito/devolución y fechas. No pedir repetir datos que ya existen; completar solo campos ausentes. Mostrar de dónde viene cada sugerencia y qué parte se puede editar.

## Escenarios de aceptación

Datos ilustrativos, no parámetros universales. Meses se interpretan como ciclos del servicio cuando corresponde.

| ID | Caso | Resultado verificable |
| --- | --- | --- |
| A01 | Netflix anunciado 45, pago real 47; cuatro plazas incluyéndote | Registrar 45 y 47 separados; tu plaza ocupa capacidad; cuota sugerida editable |
| A02 | Ana ocupa dos plazas de 10 y 8 | Detalle 10 y 8, total 18; no dos contactos |
| A03 | Cuota 20, umbral 7, ingreso a 5 días | Tramo gratis, próximo ciclo cobra 20 |
| A04 | Cuota 20, umbral 7, ingreso a 12 días | ceil(20/30 × 12) = 8; no restar siete días |
| A05 | Ciclo mensual real de 31 días, cuota 20 | Cuota completa 20, sin recargo diario |
| A06 | Deuda 20, dos cobros reales de 10 | Primer pendiente 10, segundo 0; dos ingresos reales, ningún ingreso por aplicación |
| A07 | Un ingreso 50 repartido entre tres servicios | Un ID de cobro/operación; aplicaciones suman <=50; detalle en cada servicio |
| A08 | Anticipo 60, cuota 20; subida futura a 22 | Precio no garantizado; diferencia explícita sin consumirla dos veces |
| A09 | Sobrante trasladado de Netflix a Spotify | Cambia destino del crédito, no saldo de cuenta ni ingreso total |
| A10 | Paga hasta julio, sale en febrero con ciclo ya pagado al proveedor | Termina febrero; devolver futuros marzo-julio según importes no consumidos |
| A11 | Ciclo proveedor no pagado, usado menos del límite configurado | Vista previa de baja temprana/cobro proporcional/devolución; igualdad requiere política de 04 |
| A12 | Retirada con deuda de marzo y abril; luego reingresa | Préstamo conserva ambos orígenes; nueva participación parte en cero; deuda total no se duplica |
| A13 | Compartido a individual con deudas y anticipos | Efectivo en corte siguiente; préstamos detallados y devoluciones futuras; historia intacta |
| A14 | Pago proveedor el 10 cuando renovación es 7 | Fecha real 10, calendario sigue 7 |
| A15 | Suspensión/gracia y reactivación con nueva renovación | No cobrar gracia/extra por transición ni descontar suspensión; mover fechas con historial |
| A16 | Regalo permanente a contacto que ya debe | Elegir conservar deuda o trasladar; no perdonarla ni inventar pago |
| A17 | Gasto enero 30, recuperación enero recibida en febrero | Enero no cambia en caja; febrero incorpora cobro, origen de deuda sigue enero |
| A18 | Servicio pagado 47, cuotas exigibles de terceros 34, recibidas 24 | Previsto 13; según cobros 23; pendiente 10 separado |
| A19 | Compra Netflix 47 con crédito; luego pagar tarjeta desde banco | Un gasto de Netflix; pago tarjeta reduce banco/deuda sin segundo gasto |
| A20 | Recibir préstamo y devolver capital/interés | Flujo distingue fondos/principal; interés es costo, capital no ingreso ganado/gasto de consumo |
| A21 | Reserva para meta dentro de cuenta de 100 | Cuenta sigue 100; mostrar reservado/libre; no ingreso ficticio |
| A22 | Correo y foto del mismo pago, o reintento de aceptación | Advertir/vincular coincidencia; misma aceptación idempotente no duplica dinero |
| A23 | Sin internet | Consultar caché con fecha; no registrar/editar/aceptar hasta reconectar |
| A24 | Corregir cobro aplicado a dos deudas | Mostrar y reconstruir efectos coherentes; auditoría, sin confundir reversión con devolución |
| A25 | Exportación mensual y corrección posterior | Reporte vivo actualizado, versión previa conservada, nueva versión identificada |
| A26 | Restaurar respaldo con documentos incluidos/opcionales | Validar manifiesto y relaciones; saldos/deudas coinciden; archivos según selección |
| A27 | ID de cuenta/cargo perteneciente a otra persona usuaria | Operación rechazada, sin efectos parciales |
| A28 | Dos dispositivos aceptan el mismo pago o emiten ciclo | Un resultado, sin doble cargo/ingreso ni sobreaplicación |

Automatizar pruebas de cálculos, transacciones y aislamiento. Comprobar en Android los recorridos y casos representativos; repetir en iOS antes de declararlo soportado. No son pruebas ejecutadas ahora.

## Qué falta antes de implementar

Resolver ejemplos específicos listados en 04 durante diseño de sus pantallas. Elegir proveedor definitivo, presupuesto y créditos de API cuando haya medición. Definir contratos/paginación/errores, esquema físico y restricciones antes de migrar. Revisar UI existente y acordar prototipo del primer recorrido. El alcance está consolidado; estos pendientes son decisiones de ejecución y algunas excepciones del negocio identificadas, no una razón para volver a preguntar lo ya resuelto.

## Nuevas ideas

Registrar ejemplo, módulo, prioridad, reglas/datos afectados y criterio verificable. Clasificar como confirmada/propuesta/pendiente y actualizar documentos relacionados juntos. Una base extensible necesita migraciones futuras; no prometer que nunca cambiará.
