# 06 — Préstamos y tarjetas

El **préstamo mínimo** (para convertir deuda de servicios) se implementa en la **E2**. Los préstamos completos, los bancarios y las tarjetas se implementan en la **E3**. Las reglas están cerradas aquí para que el esquema de la E2 no necesite rehacerse.

## 1. Alcance

| ID | Regla | Estado |
| --- | --- | --- |
| RN-L01 | Préstamos **otorgados** (el administrador presta) y **recibidos** (de contactos, otras personas o entidades bancarias). Solo préstamos **nuevos**: no se importan históricos. | C |
| RN-L02 | Interés: **ninguno**, **importe fijo adicional** o **porcentaje** sobre capital **original** o **pendiente**, elegible por préstamo. | C |
| RN-L03 | Devolución: **plan de cuotas**, **fecha final con abonos libres**, o **sin fecha acordada**, elegible por préstamo. | C |
| RN-L04 | **Deuda de servicios convertida**: sin interés por defecto, con opción de configurar condiciones al convertir. Un retiro con varios servicios crea **un préstamo nuevo** del contacto con conceptos por origen; **no se mezcla** con préstamos anteriores. | C |
| RN-L05 | **Abonos**: el administrador **elige** a qué cuotas o conceptos aplicarlos; no hay orden automático por antigüedad. | C |
| RN-L06 | **Dentro de cada cuota**: primero capital, después interés (predeterminado), configurable por préstamo y modificable antes de confirmar. No se difieren automáticamente todos los intereses hasta cancelar el capital total. No se afirma que coincida con reglas bancarias. | C |
| RN-L07 | **Frecuencia de interés** configurable (mensual mostrada como recomendada). No implica recomendar tasa ni activarla por defecto. | C |
| RN-L08 | **Pago anticipado**: elegible por préstamo entre *mantener el interés acordado* o *solo el devengado*. Si es devengado y se cancela a mitad de período: *prorrateo diario base 30 (mensual)* o *período iniciado completo*. | C |
| RN-L09 | **Capitalización**: solo cuando el usuario la **solicita y confirma**; sin frecuencia automática. Registra importe, fecha y conceptos capitalizados sin duplicar deuda. | C |
| RN-L10 | **Cargos por atraso** configurables con **cálculo previo y confirmación** antes de aplicar. | C |
| RN-L11 | **Sobrepago**: se pregunta si **conservar saldo a favor** del contacto o **devolver**; nunca se devuelve automáticamente sin movimiento real. | C |
| RN-L12 | Un cobro puede repartirse entre **servicios y préstamos** con un solo ingreso real y el mismo ID de cobro. | C |
| RN-L13 | Conversión de deuda: **atómica**, conserva origen, cierra el pendiente original y abre el nuevo **sin ingreso/egreso ficticio y sin doble conteo**. Un préstamo recibido por EVA que sale realmente de una cuenta propia sí tiene operación asociada. | C |

## 2. Fórmulas propuestas (E3)

Estas fórmulas cierran lo que la definición dejó abierto. Todas se muestran en **vista previa** antes de confirmar. Aritmética según [04 §1](04-motor-de-calculo.md).

| ID | Regla | Estado |
| --- | --- | --- |
| RN-L20 | **Interés simple por período completo**: `interés_período = base × tasa`, donde `base` = capital original o pendiente al inicio del período, y la tasa corresponde a la frecuencia elegida. Redondeo **una vez**, hacia arriba al céntimo. | P D-20 |
| RN-L21 | **Interés compuesto**: solo mediante la acción explícita de capitalizar (RN-L09). | C |
| RN-L22 | **Prorrateo diario (mensual, base 30)** al cancelar antes: `interés = base × tasa × días_transcurridos / 30`, hacia arriba al céntimo. | P D-20 |
| RN-L23 | **Mora personal**: el usuario elige entre *importe fijo por período vencido* o *porcentaje sobre la cuota vencida por período*. Se calcula en vista previa y se aplica **solo al confirmar**; queda como cargo separado y auditable. | P D-21 |
| RN-L24 | **Reconciliación de céntimos**: el reparto de un abono entre conceptos usa `distribute` ([04 §6](04-motor-de-calculo.md)); la suma de partes iguala el pago real. | P D-04 |

## 3. Préstamos bancarios

| ID | Regla | Estado |
| --- | --- | --- |
| RN-B01 | **Seguimiento detallado** de capital, interés, seguros y comisiones **cuando se conocen**. Solo se guardan datos **confirmados por documento o por el usuario**. Lo desconocido queda como *pendiente*, nunca como estimación guardada como dato bancario. | C |
| RN-B02 | **Carga**: fotografía, PDF multipágina, ingreso manual y documentos por correo reenviado. Gemini extrae provisionalmente; el resultado es **propuesta** hasta revisar y confirmar. | C |
| RN-B03 | Tipos de documento **no intercambiables**: hoja resumen, cronograma, estado de cuenta, comprobante de pago. Pueden existir varios por crédito, con fecha/versión. Cada campo/fila registra su origen (documento o usuario). | C |
| RN-B04 | Si falta información se **pregunta solo lo necesario**. No se obliga a inventar TEA, seguros, capital o intereses para registrar un pago real. | C |
| RN-B05 | **Calendario de ayuda**: construido con fechas/importes confirmados. Separa **vencimiento** de **fecha real de pago**. Una proyección no confirmada **no** es obligación bancaria. | C |
| RN-B06 | Ante un **documento nuevo**: comparar diferencias, pedir confirmación y actualizar cuotas futuras **sin borrar pagos anteriores**. No se desplaza el cronograma por un pago tardío. La reprogramación exige información nueva confirmada. | C |
| RN-B07 | **Nunca** se genera mora bancaria a partir de conjeturas. Ni el interés ni el pago mínimo oficial se calculan con la fórmula de suscripciones. | C |
| RN-B08 | Una suma incoherente, texto ilegible o una página incompleta se **señalan antes de confirmar**. | C |
| RN-B09 | **Precisión**: importes bancarios conservan su valor documental; el redondeo entero de cuotas compartidas **no** se aplica. | C |

## 4. Tarjeta de crédito

| ID | Regla | Estado |
| --- | --- | --- |
| RN-T01 | La tarjeta es una **cuenta de tipo crédito** con extensión (`credit_account_details`): línea, fechas, entidad. **Un solo saldo/deuda**; no se crean dos saldos para la misma tarjeta. | C |
| RN-T02 | **Estado de cuenta** por período: fecha de corte, **fecha límite de pago** (distintas), total del período, pago mínimo, cargos y saldo, tal como los informa el banco. | C |
| RN-T03 | **"Pago total del período" no es toda la deuda**: no incluye automáticamente cuotas futuras. Se muestran los importes diferenciados como los informa el banco. | C |
| RN-T04 | **Consumos** y **compras en cuotas** (plan de cuotas con desglose) se registran con la tarjeta; pagar la tarjeta reduce deuda sin repetir el gasto (RN-MV04). | C |
| RN-T05 | **No** se almacenan CVV, claves ni datos bancarios sensibles. | C |
| RN-T06 | El **asesor de tarjeta** (qué tarjeta conviene usar hoy según corte/pago) es una ampliación **[P]** de bajo costo: lógica matemática sobre fechas de corte y pago confirmadas. | P |

## 5. Efecto en los reportes

Ver [08](08-reportes-y-exportaciones.md). Resumen: en **flujo de dinero** aparecen el capital recibido/devuelto y los pagos de tarjeta; en **resultado por conceptos** solo el consumo y el **costo financiero** (intereses, seguros, comisiones). Deuda original convertida y préstamo resultante **nunca** se suman como dos pendientes.
