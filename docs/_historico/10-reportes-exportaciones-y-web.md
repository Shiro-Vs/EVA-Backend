# EVA — Reportes, exportaciones y web

Actualizado el 11 de octubre de 2026. Alcance confirmado, salvo pendientes identificados.

## 1. Exportación por plataforma

| Plataforma | Alcance confirmado |
| --- | --- |
| Móvil | PDF con tablas y reportes; no CSV/Excel inicialmente |
| Web | CSV, Excel y PDF con mayor detalle, gráficos y selección/orden del contenido |

Exportación móvil de «tablas» significa tablas dentro de PDF, según aclaración posterior de formatos. No asumir archivos de hojas de cálculo en móvil.

La petición de web «todo lo necesario» contempla ampliar formatos si se acuerdan, pero no confirma formatos de imagen, paquetes ZIP, plugins u otros formatos sin concretar. PDF puede incluir gráficos; exportación individual de gráfico pendiente de definir.

## 2. Composición configurable

Confirmado: usuario elige qué exportar y el orden. Cubrir todos los módulos relevantes: ingresos/gastos/categorías, cuentas, servicios, contactos, préstamos, presupuestos y metas. Selección de secciones y orden deben mantenerse coherentes con relaciones y subtotales.

Propuesta de constructor: elegir período y filtros, seleccionar módulos/secciones, elegir resumen/detalle, ordenar, previsualizar y generar. Columnas, agrupación, orden de filas, plantillas guardadas y formatos por módulo pendientes.

CSV representa una tabla plana; si se seleccionan varias tablas, se debe elegir descarga por tabla o paquete con varios CSV. Excel puede separar tablas/secciones en hojas. PDF presenta secciones en orden. Estas decisiones de empaquetado no están aprobadas aún.

## 3. Dos vistas financieras

Confirmado: resultado por conceptos y flujo de dinero, con etiquetas claras.

- Resultado: ingresos ganados, gastos de consumo y costos financieros según clasificación.
- Flujos: movimientos reales de dinero, incluidos capital prestado/devuelto, pagos de tarjeta y transferencias, con distinción de tipo/dirección.
- Transferencias propias no se presentan como ingreso ganado/gasto de consumo; no sumar salida y entrada como movimiento de dinero hacia terceros.
- Comprar con tarjeta crea gasto/deuda; pagar después reduce cuenta/deuda y no repite el gasto de la compra.
- Deudas/cargos pendientes se presentan aparte de cobros reales. Anticipos mantienen período/destino y no se atribuyen íntegros al costo de un ciclo sin distribución.
- Ajustes de saldo se identifican separadamente; tratamiento en métricas pendiente de cierre.

Períodos, fechas usadas para cada vista (ocurrencia, cargo, confirmación) y métricas específicas se documentarán antes de implementar reportes.

## 4. Resumen mensual solicitado

Confirmado: resumen mensual general y detallado de todo lo que ingresó/salió, origen de cada ingreso y destino de cada egreso. Integrarlo al panel/reportes y PDF móvil; exportación web más detallada.

Propuesta de estructura: período, saldos iniciales/finales por cuenta, ingresos por origen/categoría, egresos por destino/categoría, neto, detalle de operaciones y secciones diferenciadas de transferencias, préstamos, tarjeta y ajustes. Distinguir flujo real de dinero y resultado por conceptos ya confirmado; no duplicar transferencias internas, aplicaciones de pagos o gasto de tarjeta al pagarla. Pendientes no aceptados separados de registros confirmados.

Cobros tardíos aparecen en mes de recepción en flujo y conservan período de deuda en vista por ciclo. Comparar costo previsto/real para explicar diferencias. Confirmado el 12 de octubre: vista recalculada con datos actuales y versiones guardadas/exportadas de cada cierre; correcciones posteriores generan nueva versión sin borrar la guardada. Frecuencia de generación y parámetros/plantillas iniciales pendientes.

## 5. Estados de cuenta de contactos

Confirmado: resumen y detalle desplegable/filtrable. Incluir servicios y préstamos, conceptos/cupos/períodos, cargos, aplicaciones de pagos, cortesías, devoluciones, saldo a favor y pendiente.

Conversión de deuda a préstamo conserva desglose original y marca traslado; no sumar deuda original y préstamo como dos pendientes. Un único pago repartido en varios conceptos muestra sus aplicaciones sin repetir el importe como varios ingresos.

## 6. Primera web y evolución

Confirmado: primera versión consulta datos, gráficos, exporta y ofrece sección general de tipo de cambio. Administración de cuentas/movimientos/servicios/contactos/préstamos en una etapa posterior.

Misma identidad y API/datos del móvil, sin sincronización por copias separadas ni registros financieros duplicados. Preferencias de diseño pueden diferir por plataforma. Vista de tipo de cambio no convierte automáticamente saldos ni altera registros históricos; dólar/cambio operativo queda para ampliación.

## 7. Protección y alcance de «todo exportable»

Exportar datos del propietario dentro de filtros elegidos, nunca claves, tokens, contraseñas ni datos de otro usuario. Incluir comprobantes/correos originales y respuestas de IA en una exportación requiere definición aparte; no anexarlos por defecto.

Exportar reportes no reemplaza copia de seguridad recuperable. Capacidades de respaldo/restauración confirmadas en `11-acceso-offline-y-respaldos.md`; detalles técnicos pendientes.

## 8. Pendientes

- Columnas, agrupaciones y plantillas guardadas.
- Formatos de gráficos y tratamiento de varios CSV.
- Tipos de comparación, rangos y fechas de referencia.
- Metadatos de generación, filtros y nivel de detalle en PDF.
- Límites de tamaño, generación asíncrona y retención de archivos exportados.
- Alcance de análisis/IA dentro de reportes y tratamiento de faltantes.
