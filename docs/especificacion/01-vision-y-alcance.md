# 01 — Visión y alcance

## 1. Qué es EVA

EVA es una aplicación para **administrar suscripciones compartidas** y **llevar finanzas personales con poco trabajo manual**. El administrador sabe en todo momento quién participa en cada plan, cuánto debe por período, cuánto pagó, qué ciclos cubrió y qué saldo queda. Los correos reenviados y las fotografías proponen movimientos que el usuario revisa antes de aceptarlos.

- Netflix es solo un ejemplo de servicio. EVA registra la **administración y los cobros**; agregar a alguien en EVA no lo agrega en la plataforma del proveedor. **[C]**
- Uso **personal primero** (el creador), con posible acceso de amigos más adelante. Cada administrador tiene sus propios datos. **[C]**
- Los **contactos no necesitan cuenta** en EVA; los administra el usuario. **[C]**
- **Android primero**, iOS previsto, web después. Se empieza con **datos nuevos**: no se importa el Excel ni se reconstruyen movimientos anteriores. Los saldos reales se registran como **apertura**. **[C]**

## 2. Principios de diseño

1. **El dinero real y las obligaciones son cosas distintas.** Un ingreso entra a una cuenta una sola vez; luego se *aplica* a cargos. Nunca se registra dos veces.
2. **Nada se borra, todo se corrige con rastro.** Las correcciones son reversiones y nuevas versiones, con motivo y autor.
3. **La IA propone, tú confirmas.** Ninguna extracción mueve dinero, deuda o cuotas sin confirmación explícita.
4. **Los cálculos son deterministas.** Gemini explica y sugiere; nunca calcula saldos, deudas ni cuotas.
5. **Cada resultado se explica.** Toda vista previa muestra los datos de entrada, la regla aplicada y el efecto exacto (cuenta, importes, deuda restante, fechas).
6. **Servidor como autoridad.** El móvil nunca recalcula dinero; consulta vistas previas al servidor.
7. **Construir por recorrido.** Cada entrega es utilizable de punta a punta; no se hace "todo el backend" y luego "todo el front".

## 3. Mapa de módulos y entregas

Leyenda: ● núcleo de la entrega · ○ parte menor · — no incluido.

| Módulo | Detalle | E1 | E2 | E3 | E4 | E5 | E6 | E7 |
| --- | --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| Acceso y aislamiento | Google/correo, propietario en cada dato, auditoría | ● | | | | ○ | | ○ |
| Cuentas y saldos iniciales | Banco, ahorro, efectivo, billetera, crédito básico | ● | | ○ | | | | |
| Contactos | Lista, estado total | ● | | | | | | |
| Servicios y calendario | Alta, verificación, ciclos, plazas, cuotas | ● | ○ | | | | | |
| Incorporación y prorrateo | Umbral gratis, vista previa | ● | | | | | | |
| Cobros y anticipos | Parcial, varios ciclos, sobrante, reserva | ● | ○ | | | | | |
| Pago al proveedor | Real vs anunciado, cuenta/tarjeta | ● | | | | | | |
| Costo propio | Previsto vs según cobros | ● | | | | | | |
| Cortesías | Por ciclos, hasta fecha, permanente | — | ● | | | | | |
| Cambios de cuota/precio/calendario | Gracia, suspensión, reactivación | — | ● | | | | | |
| Bajas, devoluciones, cambio a individual | Con vista previa | — | ● | | | | | |
| Deuda → préstamo mínimo | Conversión atómica sin efectivo | — | ● | ○ | | | | |
| Correcciones y reversiones | Con vista de efectos | ○ | ● | | | | | |
| Ingresos, gastos, transferencias | Manuales, con desglose | ○ | | ● | | | | |
| Clasificación | Categorías, reglas, desglose/dominante | — | — | ● | ○ | | | |
| Préstamos completos y bancarios | Interés, cronograma, documentos | — | — | ● | ○ | | | |
| Tarjeta de crédito | Estados de cuenta, consumos, cuotas | — | — | ● | ○ | | | |
| Presupuestos, metas, recurrencias, conciliación | | — | — | ● | | | | |
| Captura (correo/foto/PDF) y bandeja | Propuestas, duplicados, lote | — | — | — | ● | | | |
| Análisis y chat con Gemini | Período y datos seleccionados | — | — | — | ● | | | |
| Panel configurable, avisos, bloqueo, caché | | ○ | | | | ● | | |
| Resumen mensual, PDF, respaldos | | — | — | — | — | ● | | |
| iOS y web de consulta | | — | — | — | — | — | ● | |
| USD, conversión, amigos como usuarios | | — | — | — | — | — | — | ● |

> El orden E3 ↔ E4 puede ajustarse tras probar el núcleo **[C]**. La seguridad, el aislamiento, la auditoría y la recuperación básica se incorporan desde la E1, no al final.

## 4. Límites

**Fuera del alcance actual [C]:**

- Débito/cobro automático y conexión bancaria directa: registrar un pago no mueve dinero real.
- Crear cuentas o modificar planes en Netflix u otros proveedores.
- Gastos compartidos ocasionales (por ejemplo, repartir una cena).
- Pagos anticipados de varios ciclos *al proveedor* (los anticipos son solo de participantes).
- Mora o interés automático en servicios.
- Importación del Excel y de historiales anteriores.
- Escrituras sin conexión (el modo offline es solo consulta).
- Inventarios, facturación tributaria, organizaciones.
- Elegir proveedor de API de tipo de cambio ni incluir predicciones (E7).

**Moneda:** solo PEN al inicio. El código de moneda se guarda en cada importe para admitir USD después sin migrar datos. **[C]**

## 5. Supuestos y restricciones

| # | Supuesto o restricción | Efecto |
| --- | --- | --- |
| S1 | Un solo desarrollador; presupuesto operativo sin definir | Se prioriza la E1 como único objetivo inmediato; sin servicios contratados hasta medir |
| S2 | Desarrollo local a costo cero | PostgreSQL local + entorno de pruebas; contratación después de medir ([11](11-arquitectura.md)) |
| S3 | Zona horaria `America/Lima` (UTC−5, sin horario de verano) | Las fechas de cobertura son fechas locales sin hora ([02](02-glosario-y-convenciones.md)) |
| S4 | El dispositivo de pruebas es Android | iOS se valida en la E6; el código no debe impedirlo |
| S5 | Ninguna integración externa de pago | EVA es un libro de registro, no un procesador de pagos |

## 6. Criterio de éxito de la Entrega 1

La Entrega 1 está terminada cuando, con la app Android conectada al backend real y la base persistente:

1. Puedes crear **Netflix** con precio anunciado 45, pagado 47, cuatro plazas (tú incluido) y ver la cuota sugerida (S/ 12) editable.
2. Puedes **incorporar** participantes entre renovaciones y ver la vista previa del prorrateo antes de confirmar.
3. Puedes **cobrar** de forma parcial, de varios ciclos juntos o por adelantado, con **un solo ingreso** en la cuenta y su reparto visible en cada servicio.
4. Puedes registrar el **pago al proveedor** con su monto real y su cuenta, y ver **pendiente** y **costo propio** (previsto y según cobros).
5. Los escenarios **A01–A09, A14, A22 (aceptación idempotente), A27 y A28** del documento 14 pasan como pruebas automáticas.
6. Reiniciar la app o el servidor conserva los datos y no genera cobros duplicados.
