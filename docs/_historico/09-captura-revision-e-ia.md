# EVA — Captura, revisión e IA

Actualizado el 11 de octubre de 2026. Capacidades confirmadas; configuraciones iniciales y excepciones pendientes.

## 1. Fuentes y propuestas

Correo reenviado, fotografía y PDF de varias páginas, además de registro manual. Capturar gastos/ingresos, comprobantes, cronogramas y estados de cuenta según su tipo. Cada fuente tiene propietario, procedencia, momento, estado de procesamiento y vínculo a propuestas/registros; no crear un movimiento por cada archivo si todos describen la misma operación.

Gemini extrae datos y propone clasificación; faltantes o inconsistencias se presentan al usuario. Datos bancarios requieren confirmación por documento/usuario. No inferir el uso de un Yape sin concepto como hecho confirmado.

## 2. Entrada a la bandeja

Confirmado: aviso al abrir, contador en panel y notificaciones opcionales configurables. Categoría pendiente de un movimiento aceptado y propuesta pendiente de aceptar son colas/estados distintos; mostrar claramente qué ya afecta saldo.

Frecuencia de avisos, horario, contenido visible de notificaciones y preferencias iniciales todavía no definidos.

## 3. Revisión individual y por lote

Confirmado: ambas modalidades, con preferencia configurable. Ningún movimiento modifica saldos sin confirmación explícita, incluidos recurrentes.

Para un lote, mostrar propuestas seleccionadas, importes, cuentas y aplicaciones antes de confirmar. Propuestas incompletas/incoherentes deben permitir edición o excluirse del lote; política de atomicidad de lote (todo o parcial con detalle) pendiente de diseño. Cada operación individual mantiene garantías de aceptación atómica e idempotente.

Si un dato cambia después de la vista previa, pedir revisión de ese cambio en lugar de aceptar silenciosamente una versión distinta. Reintentar no duplica movimientos.

## 4. Contactos y cobros

Confirmado: proponer contacto/conceptos usando datos disponibles y reglas configurables por remitente. Administrador revisa y confirma; puede seleccionar manualmente contacto y reparto. Nombre coincidente por sí solo no asigna irrevocablemente un pago.

Un cobro puede cubrir servicios y préstamos, con un movimiento real. Las sugerencias de categoría y de aplicación a deuda no son equivalentes: sugerir «servicios» no cancela un cargo automáticamente.

## 5. Posibles duplicados

Confirmado: elegir entre propuestas separadas con advertencia o agrupadas como posible coincidencia, preguntando si son una sola operación. Importe/fecha iguales no bastan para descartar pago legítimo.

Si se confirma una misma operación, conservar evidencia de correo/foto vinculada al registro único. Si ya existe movimiento manual, poder vincular evidencia a ese movimiento sin ingreso/gasto adicional.

Propuesta técnica: deduplicación de reentrega exacta del mismo mensaje/documento dentro de la recepción, separada de coincidencia entre operaciones; no hacer que un reintento parezca un movimiento nuevo. Identificadores, algoritmo y umbrales pendientes de implementación.

## 6. Conservación de originales

Confirmado: guardar originales de forma configurable, seleccionar cuáles y establecer plazo de eliminación. Aplicar al documento/archivo, no borrar pagos ni movimientos por vencer retención de su comprobante.

Conservar metadatos mínimos de procedencia y decisión tras eliminar original. Archivos privados por propietario, acceso también desde futura web. Plazos iniciales, eliminación manual, alcance de copia de seguridad y manejo de documentos de varios movimientos pendientes.

## 7. Análisis Gemini

Confirmado: reportes/recomendaciones por período y chat sobre datos; usuario selecciona cuentas, servicios, categorías y períodos.

Cálculos financieros en código determinista. Gemini recibe contexto del alcance elegido y explica/proporciona sugerencias; no confirma movimientos, modifica deudas ni realiza pagos.

Propuesta: informar período, filtros, datos faltantes y fecha de análisis; enviar solo contexto necesario, no todos los documentos originales por defecto. Historial de chat/análisis, actualización, presupuesto de uso y fallos de IA pendientes de definir.

No presentar conclusiones generadas como datos bancarios confirmados ni usar predicciones como tasas reales de conversión.

## 8. Pendientes de planificación

- Preferencias iniciales y frecuencia de avisos.
- Tratamiento de extracción fallida, foto ilegible y datos mínimos para aceptar.
- Identificadores/criterios de deduplicación y presentación de evidencia.
- Retención inicial, historial de chat y permisos de Gemini.
- Reportes, formatos de exportación y prioridad móvil/web.
