# 08 — Reportes y exportaciones (Entregas 5 y 6)

## 1. Las dos vistas financieras [C]

Todo reporte etiqueta con claridad cuál de las dos está mostrando.

| Vista | Qué responde | Contenido | Fecha de referencia |
| --- | --- | --- | --- |
| **Resultado por conceptos** | ¿Cuánto gané, consumí y qué costo financiero tuve? | Ingresos ganados, gastos de consumo, costos financieros (intereses, seguros, comisiones) | Fecha de la operación (o del cargo para costos de servicio por ciclo) |
| **Flujo de dinero** | ¿Qué entró y salió realmente de mis cuentas? | Todos los movimientos reales, incluidos capital prestado/devuelto, pagos de tarjeta y transferencias, con tipo y dirección | Fecha real de la operación |

Reglas de no duplicación:

| ID | Regla |
| --- | --- |
| RN-RP01 | Las **transferencias propias** no son ingreso ganado ni gasto de consumo; no se suman salida y entrada como dinero hacia terceros. |
| RN-RP02 | Comprar con tarjeta registra **un** gasto; pagarla después no lo repite (A19). |
| RN-RP03 | **Capital** prestado recibido no es ingreso; capital devuelto no es gasto de consumo; intereses sí son costo financiero (A20). |
| RN-RP04 | **Aplicaciones** de cobros no son ingresos: un cobro repartido en tres servicios aparece **una vez** en el flujo (A07). |
| RN-RP05 | **Deudas y cargos pendientes** se presentan aparte de los cobros reales. Los **anticipos** conservan período/destino y **no** se atribuyen íntegros al costo de un ciclo. |
| RN-RP06 | **Ajustes de saldo** en línea propia; **reversiones** y **cargos cancelados** identificados, no sumados. |
| RN-RP07 | Cobros tardíos: aparecen en el **mes de recepción** en el flujo y conservan el **período de la deuda** en la vista por ciclo (A17). |
| RN-RP08 | Deuda convertida y préstamo resultante **no** son dos pendientes (A12). |
| RN-RP09 | Las propuestas **no aceptadas** se separan de los registros confirmados. |

## 2. Resumen mensual [C]

Contenido: período; saldos iniciales y finales por cuenta; **ingresos por origen/categoría**; **egresos por destino/categoría**; neto; detalle de operaciones; secciones diferenciadas de transferencias, préstamos, tarjeta y ajustes.

| Regla | Detalle |
| --- | --- |
| RN-RM01 | Dos formas: **vista viva** (recalculada con los datos actuales) y **versiones guardadas** (instantánea de un cierre). |
| RN-RM02 | Una **corrección posterior** a un mes ya guardado genera **otra versión** identificada; la anterior **no se borra**. (A25) |
| RN-RM03 | Una versión guardada almacena: parámetros (período, cuentas, vista), fecha de generación, versión de reglas y los números calculados (`report_snapshot`, instantánea de datos, no solo un enlace). |
| RN-RM04 | Cada versión muestra metadatos: filtros, nivel de detalle, fecha de generación y número de versión. |

## 3. Estado de cuenta de un contacto [C]

Resumen y **detalle desplegable y filtrable**: servicios y préstamos, conceptos/cupos/períodos, cargos, aplicaciones de cobros, cortesías, devoluciones, saldo a favor y pendiente. Un cobro repartido muestra sus aplicaciones **sin repetir el importe como varios ingresos**. Deuda original y préstamo se marcan como traslado y **no se suman** dos veces. Incluye una acción **"copiar texto para compartir"** por WhatsApp, preparado por el usuario y de envío manual.

## 4. Costo de servicios

Resumen por servicio y ciclo con las cifras de [04 §9](04-motor-de-calculo.md): precio anunciado, pago real, cuotas exigibles, cobros recibidos, pendiente, **costo previsto**, **costo según cobros**, excedente. Con el presupuesto de servicios ([05 §4](05-finanzas-personales.md)) se comparan ambas bases.

## 5. Exportación por plataforma [C]

| Plataforma | Formatos | Notas |
| --- | --- | --- |
| **Móvil** (E5) | **PDF** con tablas y reportes | No CSV ni Excel en móvil inicialmente. |
| **Web** (E6) | **CSV, Excel y PDF**, con gráficos y detalle | Selección y orden de contenido por el usuario. |
| Gráfico aislado (PNG/SVG) | **Pendiente** | "Todo lo necesario" no fija formatos de imagen; se decide en la E6 con ejemplos. |

### Composición configurable

El usuario elige **qué** exportar y **en qué orden**: ingresos/gastos/categorías, cuentas, servicios, contactos, préstamos, presupuestos y metas. Flujo del constructor: período y filtros → módulos/secciones → resumen o detalle → orden → vista previa → generar. Las selecciones respetan relaciones y subtotales.

| Formato | Empaquetado propuesto **[P]** |
| --- | --- |
| PDF | Secciones en el orden elegido, con gráficos. |
| Excel | **Una hoja por sección/tabla**. |
| CSV | Tabla plana: una descarga por tabla, o un **ZIP con varios CSV** si se eligen varias. |

### Protección

- Se exporta **solo** información del propietario dentro de los filtros. **Nunca** claves, tokens, contraseñas ni datos de otro usuario. **[C]**
- **Comprobantes originales, correos completos y respuestas de IA** **no** se incluyen por defecto; incluirlos exige una opción explícita (definición aparte). **[C]**
- Exportar **no** reemplaza el respaldo recuperable ([09 §6](09-seguridad-acceso-respaldos.md)). **[C]**

## 6. Generación y límites [P]

- Reportes pequeños (un mes, un servicio) se generan **síncronamente** en el servidor.
- Exportaciones grandes usan `export_job` con generación **asíncrona**, enlace de descarga **firmado y con vencimiento** (por defecto 24 h) y borrado del archivo después.
- Límite inicial de filas por exportación síncrona: **10 000**; sobre eso se pasa a asíncrono. Valores a ajustar tras medir.

## 7. Web: primera versión [C]

Consulta de datos, **gráficos**, exportaciones y una **sección general de tipo de cambio** (informativa). No convierte saldos automáticamente ni altera registros históricos. La **administración** de cuentas, movimientos, servicios, contactos y préstamos llega en una etapa posterior. Misma identidad, API y datos que el móvil: **no hay copias sincronizadas** ni registros duplicados. Las preferencias de diseño pueden diferir por plataforma.

## 8. Pendientes de definición (se cierran al implementar)

Columnas por tabla, agrupaciones, plantillas guardadas, tipos de comparación y rangos, formato de gráficos individuales, retención de archivos exportados y tratamiento de faltantes dentro del análisis con IA.
