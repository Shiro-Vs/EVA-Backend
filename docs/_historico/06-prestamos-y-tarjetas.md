# EVA — Préstamos y tarjetas

Actualizado el 10 de octubre de 2026. Borrador de definición: separar necesidades confirmadas, propuestas de producto y políticas aún pendientes.

## 1. Alcance confirmado

- Préstamos otorgados por el propietario y recibidos de contactos, otras personas o entidades bancarias.
- Sin interés, con importe fijo adicional o con porcentaje configurable sobre capital original o capital pendiente, elegible por préstamo. Capitalización de interés pendiente opcional; solo cuando el usuario la solicita y confirma, no al cierre periódico automáticamente. Registrar importe, fecha y conceptos capitalizados sin duplicar deuda. Fórmula de devengo y aplicación de tasa sobre base actual pendiente de diseño.
- Plan de cuotas, fecha final con abonos libres o sin fecha acordada.
- Deuda retirada de varios servicios se agrupa en un préstamo nuevo del contacto, con detalle por origen/plaza/período; no se mezcla automáticamente con préstamos anteriores.
- Préstamos nuevos solamente en el alcance actual. Conversión de deuda de servicios también permitida; no implica dinero nuevo ni carga manual de un préstamo histórico.
- Un cobro puede repartirse entre servicios y préstamos, con un movimiento real y un ID compartido.
- Documentos bancarios fotografiados y extraídos con Gemini; preguntar datos faltantes, revisar antes de confirmar y permitir ingreso manual completo.
- Confirmado: tarjeta como Account de tipo crédito, con consumos, estados de cuenta y compras en cuotas. CreditCard amplía esa cuenta; no crear dos saldos independientes para la misma tarjeta.
- Confirmado: datos bancarios guardados solo tras confirmación por documento o por usuario, incluidos capital, intereses, seguros, comisiones y fechas. Desconocidos permanecen pendientes, no se inventan estimaciones confirmadas.
- Confirmado: fotografías, PDF de varias páginas, ingreso manual y documentos por correo reenviado.
- Confirmado: deuda de servicios convertida sin interés por defecto, con opción de configurar condiciones al convertir.
- Confirmado: el administrador selecciona cuotas/conceptos a los que aplicar un abono. No imponer orden automático por antigüedad. Dentro de cada cuota, predeterminado capital primero y después interés, con regla configurable por préstamo y reparto modificable antes de confirmar. No diferir automáticamente todos los intereses hasta cancelar el capital de todo el préstamo; no afirmar que esta prioridad coincide con reglas bancarias.
- Confirmado: frecuencia de interés configurable, mostrando mensual como recomendada en interfaz. Esto no implica recomendar una tasa ni activar interés por defecto.
- Confirmado: política de interés ante pago anticipado elegible por préstamo (mantener acordado o solo devengado).
- Confirmado: si se elige interés solo generado y se cancela a mitad del período, elegir por préstamo entre prorrateo diario base 30 para mensual o período iniciado completo. Otros períodos y reglas de capitalización todavía por cerrar.
- Confirmado: cargos por atraso configurables con cálculo previo y confirmación antes de aplicar. Fórmula y periodicidad pendientes.
- Confirmado: conservar redondeo entero de suscripciones, representado con .00. Otros importes/cálculos monetarios a dos decimales, redondeando resultados hacia arriba al centavo (6.6666 → 6.67). Pagos y montos bancarios documentados conservan su valor real; no redondear ni alterar un Yape de 10.25. Aplicar redondeo una vez al resultado monetario emitido, no a tasas o cada paso intermedio. Definir reconciliación del reparto para que sume exactamente el pago.
- Confirmado: sobrepago del préstamo pregunta si conservar saldo del contacto o devolver; no devolver automáticamente sin movimiento real.

## 2. Documentos y calendario bancario

Flujo: foto/documento → identificar tipo → extraer campos y filas → marcar faltantes/ambigüedades → solicitar solo datos necesarios → revisión → confirmación.

Identificar hoja resumen, cronograma, estado de cuenta o comprobante de pago; no son intercambiables. Permitir varios documentos para un mismo crédito y conservar su fecha/versión. Registrar origen por campo o fila: documento confirmado o dato confirmado por usuario. Extracción provisional de Gemini permanece propuesta hasta revisar/confirmar.

Calendario de ayuda construido con fechas/importes confirmados por documento o usuario; separar vencimiento de fecha real de pago. Los datos ausentes quedan pendientes y EVA los pregunta. Una proyección no confirmada no se incorpora como obligación bancaria. Que el calendario sea de ayuda en EVA no elimina el vencimiento real establecido por el banco: mostrarlo cuando se conoce. Nunca generar mora bancaria a partir de conjeturas.

Ante documento nuevo, comparar diferencias de importes/fechas, solicitar confirmación y actualizar cuotas futuras sin borrar pagos anteriores. No desplazar el cronograma automáticamente solo porque un pago real fue tardío. Reprogramación requiere información nueva confirmada.

Datos ausentes pueden permanecer desconocidos si no bloquean seguimiento básico; no obligar a inventar TEA, seguros, capital o intereses para registrar un pago real. Una suma incoherente, texto ilegible o foto de página incompleta se señala antes de confirmar. Confirmado soporte de PDF, fotos y documentos por correo.

## 3. Préstamo bancario frente a tarjeta

| Aspecto | Préstamo bancario | Tarjeta de crédito |
| --- | --- | --- |
| Registro base | Crédito y cronograma de cuotas | Línea de crédito y consumos |
| Documento de seguimiento | Cronograma/hoja resumen actualizados | Estado de cuenta por período |
| Fechas | Vencimiento por cuota | Corte del período y límite de pago distintos |
| Importes | Cuota y desglose si disponible | Pago total del período, mínimo, cargos y saldo |
| Cambios | Nuevo cronograma confirmado | Nuevo estado de cuenta y condiciones confirmadas |

Referencia educativa: [SBS, guía de finanzas personales](https://www.sbs.gob.pe/portals/3/educacion-financiera-pdf/GUIA-INFORMADOS-SE-VIVE-MEJOR.pdf). La SBS describe datos relevantes del estado de cuenta como fecha de pago, línea, pago total del período y mínimo: [explicación de estados de cuenta](https://www.sbs.gob.pe/noticia/detallenoticia/idnoticia/1431). Cronograma y condiciones son documentos del crédito; referencia: [manual educativo SBS](https://www.sbs.gob.pe/Portals/3/jer/enlaces/MANUAL-DEL-DOCENTE-2023.pdf).

Contabilidad del producto confirmada al elegir ambas vistas de reportes: comprar Netflix con tarjeta registra gasto y aumenta deuda de tarjeta; pagar luego la tarjeta desde BCP reduce BCP y deuda, sin volver a registrar Netflix como gasto. Capital prestado recibido no es ingreso ganado ni devolución de capital gasto de consumo; mostrar flujos por separado. Intereses, seguros y otros cargos se distinguen como costo financiero. Presentación detallada en `10-reportes-exportaciones-y-web.md`.

No asumir que «pago total del período» significa toda la deuda incluyendo cuotas futuras. Diferenciar importes tal como los informa el banco. No calcular interés bancario ni pago mínimo oficial mediante la fórmula de suscripciones. Montos bancarios mantienen precisión documental; redondeo a enteros de cuotas compartidas no se aplica a documentos/pagos del banco.

## 4. Modelo conceptual adicional propuesto

| Entidad | Responsabilidad |
| --- | --- |
| Counterparty | Contacto o entidad prestamista/prestataria, sin requerir cuenta EVA |
| Loan | Dirección otorgado/recibido, moneda, capital, condiciones y estado |
| LoanConcept | Conceptos de deuda agrupada con referencias a cargos originales |
| LoanTerms | Modalidad de interés, tasa/base/período, vigencia y condiciones |
| LoanScheduleVersion | Cronograma original o actualizado, origen y fecha de confirmación |
| LoanInstallment | Capital/interés/otros costos y vencimiento confirmados; faltantes pendientes |
| LoanPaymentAllocation | Parte de cobro/pago aplicada a cuota o saldo de préstamo |
| CreditCard | Extensión uno a uno de Account tipo crédito: línea, fechas confirmadas y entidad; un solo saldo/deuda |
| CardStatement | Período, corte, vencimiento, total del período, mínimo y fuente documental |
| CardPurchasePlan | Desglose de compra en cuotas, solo si se incluye esa modalidad |
| CreditPayment | Pago que reduce deuda con vínculo al movimiento de la cuenta de origen |

Reutilizar un evento de pago y aplicaciones, sin duplicar MoneyMovement por módulo. La denominación ReceivedPayment del borrador previo debe revisarse para admitir desembolsos y pagos de deudas recibidas en dirección opuesta. Loan y CreditCard tienen reglas distintas, aunque comparten movimientos y documentos.

## 5. Decisiones pendientes

1. Base de días y devengo del interés personal; frecuencia configurable (mensual recomendada) y capital original o pendiente ya confirmados.
2. Desglose de otros costos y reconciliación de centavos; prioridad capital primero/interés después dentro de cada cuota ya confirmada como configurable.
3. Método de cálculo de devengado al pagar antes; política por préstamo ya elegida.
4. Fórmula/periodicidad de mora personal configurable con confirmación; mora bancaria solo con data confirmada.
5. Categorías del cobro mixto y presentación de préstamos en reportes.
6. Registro de compras en cuotas y pagos de tarjeta, reconciliación con estados de cuenta.
7. Base temporal de intereses y cargos periódicos; precisión monetaria resuelta: entero en reglas de suscripciones y otros cálculos hacia arriba al centavo, preservando montos reales.
