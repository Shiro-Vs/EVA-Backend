# EVA — Cuentas y clasificación

Actualizado el 11 de octubre de 2026. Alcance confirmado y propuesta de reglas pendientes de cerrar.

## 1. Cuentas confirmadas

Tipos: cuentas bancarias/de ahorro, crédito, efectivo y billeteras o tarjetas digitales. Nombre comercial, entidad y canal son atributos configurables, no nuevas tablas por marca. No se confirmó administración de inversiones ni apartados virtuales.

Yape/Plin pueden ser canal de una cuenta bancaria o cuenta independiente según configuración. En modo vinculado, un movimiento Yape afecta la cuenta real una vez; no sumar un saldo Yape extra al de su cuenta bancaria. Una tarjeta digital puede ser instrumento de una cuenta o un producto con saldo propio; al configurarla se debe identificar esa relación para evitar doble conteo.

La tarjeta de crédito es una cuenta de tipo crédito con deuda y extensión de estados de cuenta/consumos/cuotas. No considerar línea disponible como dinero propio.

Confirmado: registrar saldo actual de dinero o deuda actual de tarjeta como saldo inicial, sin crear ingreso/gasto. No se eligió cargar historial anterior. Conciliación mediante revisión/corrección de movimientos; si diferencia no se explica, permitir ajuste de saldo con fecha/motivo e historial. Esto no cambia decisión de registrar solo préstamos nuevos. Ver `08-planificacion-financiera-y-panel.md`.

## 2. Monedas y ampliación web

Confirmado: móvil solo soles al inicio. Registrar código PEN en las entidades, sin asumir que una cifra sin moneda servirá para ampliación.

Más adelante: cuentas en USD, saldos separados y conversiones; futura web con sección general de tipo de cambio/tasas vía API. Deseo de proyección básica aún no delimitado; no constituye modelo de predicción aprobado ni promesa de resultados.

En ampliación, separar cotización informativa (proveedor, fecha, compra/venta si aplica) de tipo de cambio real utilizado en una operación y sus comisiones. No modificar movimientos históricos al actualizar una cotización. No contratar ni escoger proveedor de API en esta etapa.

## 3. Clasificación solicitada

Confirmado: seleccionar predeterminado en configuración entre desglose y categoría dominante, pudiendo cambiar por compra. Ejemplo: S/ 100, S/ 5 comida y S/ 95 tecnología. Desglose conserva las dos partes; categoría dominante del registro podría ser tecnología. Falta elegir presentación de reportes; no sumar total más desglose como gastos separados.

Confirmado: categorías sugeridas, categorías propias y subcategorías, con creación, renombrado y archivo, buscando alta configurabilidad. La profundidad de la jerarquía no se ha fijado. Archivar/renombrar no debe borrar movimientos ni romper reportes históricos.

Confirmado: categoría obligatoria antes de aceptar o clasificación posterior son opciones configurables. Si se permite aceptar sin categoría, el movimiento afecta saldo una vez y sigue en cola de clasificación. Cambiar categoría después no crea otro movimiento.

Gemini puede proponer categoría desde correo/foto, apoyándose en comercio, descripción e ítems. Un pago Yape de S/ 10 sin concepto no revela por sí mismo para qué se gastó: permitir reglas explícitas o preguntar al usuario.

Configuraciones solicitadas como posibilidades, sin valores predeterminados aprobados:

- Preguntar al abrir app por categorías pendientes.
- Categoría por canal: Yape, tarjeta u otro nombre definido por usuario.
- Regla por importe/canal: ejemplo Yape menor a S/ 10 → «minigastos».
- Ayuda Gemini cuando el contenido aporta información.
- Corrección manual de categoría y desglose.

Mantener canal y categoría como campos distintos aunque el usuario decida crear una categoría llamada Yape. Así podrá consultar tecnología pagada con Yape o minigastos pagados con tarjeta.

## 4. Motor de reglas propuesto

Entidades previstas: ClassificationRule (propietario, condiciones, acción, prioridad, habilitada y vigencia), ClassificationDecision (regla/IA/manual, explicación, categoría propuesta/confirmada) y configuración de revisión de cada usuario.

Condiciones posibles: canal, cuenta, dirección ingreso/gasto, intervalo de importe, comercio/remitente y texto. Acciones: sugerir/asignar categoría, pedir revisión o señalar posible cobro de servicio/préstamo. Aún no están confirmados todos los filtros.

Prioridad confirmada: reglas del usuario prevalecen frente a Gemini; Gemini ayuda cuando ninguna regla aplica. Corrección manual permitida. Propuesta para conflicto entre reglas: orden explícito por usuario con explicación de regla aplicada; falta cerrar ese caso específico. Ningún resultado de IA sobrescribe una corrección manual sin revisión.

Clasificar automáticamente no significa aceptar el movimiento ni modificar saldos automáticamente. Sigue vigente revisión antes de aceptar propuestas de correo/foto; cualquier cambio a esa regla requiere decisión explícita.

Reglas nuevas no recategorizan historial sin petición del usuario. Un contacto que paga un préstamo no debe convertirse en ingreso ganado solo por tener canal Yape: clasificación de gasto/ingreso y aplicación a una deuda son conceptos distintos.

## 5. Preguntas pendientes

1. Presentación de ajustes en reportes y auditoría; ajuste con motivo ya confirmado.
2. Presentación de reportes según desglose o categoría dominante y conservación de ítems.
3. Conflictos entre varias reglas; prioridad frente a Gemini ya confirmada.
4. Frecuencia/interfaz de preguntas al abrir app y configuración por cuenta/canal.
5. Profundidad de subcategorías y tratamiento de cambios en reportes.
6. Reglas detalladas de presupuestos/metas confirmados; ver `08-planificacion-financiera-y-panel.md`.
