# 14 — Casos de prueba y estrategia de validación

> **Estado (17-nov-2026):** la suite automática del backend tiene 508 pruebas (46 archivos) contra PostgreSQL real, y la del frontend 220. Los escenarios A01–A28 están cubiertos por las pruebas de API; la lista manual de la §4 se recorre en el teléfono antes de cada versión (ver [`../operacion/02`](../operacion/02-despliegue-y-publicacion.md) §9).

Una regla sin caso de prueba no está terminada. Aquí están los 28 escenarios de aceptación (A01–A28) con **datos, pasos y resultados numéricos exactos**, más la estrategia para automatizarlos. Los casos del motor puro están en [04 §10](04-motor-de-calculo.md).

## 1. Estrategia

| Nivel | Qué prueba | Herramienta | Base de datos |
| --- | --- | --- | --- |
| **Unitarias de dominio** | Casos dorados de 04 §10 y propiedades de 04 §11 | Vitest + generación de propiedades (*fast-check*) | No |
| **Integración** | Transacciones, restricciones, disparadores, vistas, aislamiento por propietario | Vitest | **PostgreSQL real** (T-08) |
| **Escenarios** | A01–A28 de extremo a extremo vía HTTP con un reloj controlado | Vitest + cliente HTTP | PostgreSQL real |
| **Contrato** | `openapi.json` sin diferencias; tipos del frontend generados | CI | — |
| **Interfaz** | Recorrido de la E1 en Android real (lista de §4) | Manual, luego automatizable | API real |
| **Seguridad** | A27, pruebas de inyección en entrada, secretos fuera del cliente | Vitest + revisión | PostgreSQL real |

**Reglas de las pruebas**

1. **Reloj inyectable**: ninguna regla lee la hora del sistema. Fecha fija de referencia de los escenarios: **`hoy = 2026-10-12`** salvo que el caso indique otra.
2. **Sin simular la base de datos.** Cada prueba corre en una transacción deshecha o en un esquema aislado.
3. **Migraciones desde cero** en CI: se aplican todas en una base vacía y se compara el esquema esperado.
4. Los escenarios se escriben como **datos + pasos + aserciones numéricas**, reutilizando una fábrica de datos (`test/fixtures`).
5. Cobertura mínima del dominio: **95 % de líneas y ramas**; cada `RN-xxx` de E1 referenciada en al menos una prueba (`// RN-I01`).
6. Cada defecto encontrado añade primero una prueba que falla.

### Datos base (fixture `F0`)

| Elemento | Valor |
| --- | --- |
| Usuario | `U1` (zona `America/Lima`, `defaultFreeDays = 7`, `exitDaysLimit = 7`) |
| Cuentas | **BCP** (banco) apertura **+200.00** · **Efectivo** apertura **+50.00** · **Tarjeta** (crédito) apertura **−100.00** (deuda) |
| Contactos | **Ana**, **Beto**, **Carla** |
| Segundo usuario | `U2` con cuenta y contacto propios (para A27) |

## 2. Escenarios de aceptación

Leyenda de entrega: **E1** obligatorios para cerrar la Entrega 1 · **E2**… se prueban al implementar esa entrega.

### A01 — Netflix: precio anunciado vs pago real, cuatro plazas  · E1 · RN-S02/S03/S04/P03

- **Datos:** Netflix, mensual, ciclo `7-oct → 7-nov`, precio anunciado **45.00**, capacidad **4**. El administrador ocupa 1 plaza; Ana, Beto y Carla ocupan una cada una (cuota **12.00**).
- **Pasos:** (1) vista previa con `occupiedSeats = 4`; (2) crear el servicio y las 3 plazas; (3) registrar el pago real **47.00** el 10-oct desde BCP; (4) intentar un 5.º participante.
- **Resultado:**
  - Cuota sugerida **12.00** (`ceil(45/4)`).
  - Ciclo guarda precio anunciado **45.00**; `supplier_payment.amount_real = 47.00`; **BCP = 153.00**.
  - Ocupación **4/4**; el 5.º → `422 CAPACITY_EXCEEDED`; la plaza del administrador **no genera cargo**.
  - `projectedCost = 47 − 36 = 11.00`.

### A02 — Un contacto con dos plazas  · E1 · RN-P01/P06

- **Datos:** Ana ocupa "Cuenta 1" (cuota **10.00**) y "Cuenta 2" (**8.00**) de Netflix.
- **Resultado:** el estado de cuenta muestra **dos líneas (10.00 y 8.00)** y total **18.00**; la lista de contactos cuenta **un** contacto y **un** servicio; ocupa **2** plazas de la capacidad.

### A03 — Ingreso con tramo gratis (`r ≤ g`)  · E1 · RN-I01/I05/I06

- **Datos:** cuota **20.00**, `g = 7`, ciclo `7-oct → 7-nov`; Beto ingresa el **2-nov** (`r = 5`).
- **Resultado:** `bruto 4.00`, `exención 4.00`, **`neto 0.00`**, modo `trial_free`, estado de pago `exempt`, vencimiento **2-nov**. El ciclo `7-nov → 7-dic` emite **20.00** con vencimiento **7-nov**.

### A04 — Ingreso con tramo cobrado (`r > g`)  · E1 · RN-I01/I02

- **Datos:** cuota **20.00**, `g = 7`; Beto ingresa con `r = 12` (**26-oct**).
- **Resultado:** `bruto 8.00` (`ceil(240/30)`), `exención 0.00`, **`neto 8.00`**, modo `partial_charged`. **No** se restan los 7 días gratis.

### A05 — Ciclo mensual de 31 días  · E1 · RN-I02/I03

- **Datos:** ciclo `7-ene → 7-feb` (31 días); cuota **20.00**; Carla ingresa el 7-ene.
- **Resultado:** cargo **20.00**, modo `full_cycle`; **no** 20.67 ni 21.00.

### A06 — Dos cobros parciales a un mismo cargo  · E1 · RN-R01/R02/CH04/CH06

- **Datos:** cargo de Ana por **20.00**. Cobro 1 de **10.00**, luego cobro 2 de **10.00**.
- **Resultado:** tras el primero, `pending 10.00` y estado `partial`; tras el segundo, `pending 0.00` y `paid`. Existen **2 recibos** y **2 operaciones de ingreso** (+10.00 y +10.00); BCP sube **20.00**; **no** se crea ningún ingreso por las aplicaciones.

### A07 — Un ingreso repartido en tres servicios  · E1 · RN-R01/R02/R03

- **Datos:** Ana debe 20.00 (Netflix), 20.00 (Spotify) y 10.00 (YouTube). Un cobro de **50.00**, aplicado 20 + 20 + 10.
- **Resultado:** **un** recibo y **una** operación `+50.00`; 3 aplicaciones que suman **50.00**; cada servicio muestra su parte con el **mismo `receiptId`**; crédito de Ana **0.00**; pendiente total 0.00.

### A08 — Anticipo y subida futura de cuota  · E1 (parte a) + E2 (parte b) · RN-R08/R10/Q01/Q02

- **Datos:** cuota **20.00**; se emiten 3 ciclos por adelantado.
- **Parte a (E1):** cobro **60.00** aplicado 20 + 20 + 20 a los 3 cargos → todos `paid`; crédito 0.
- **Parte b (E2):** la cuota sube a **22.00** desde el ciclo 2, modo *por renovación*.
- **Resultado b:** ajustes **+2.00** en el cargo 2 (vence al inicio del ciclo 2) y **+2.00** en el cargo 3; pendientes **2.00** y **2.00**; **el anticipo no congeló el precio**; Ana debe **4.00** en total (no 6.00 ni 44.00).

### A09 — Sobrante reservado y trasladado de servicio  · E1 · RN-R05/R06/R09

- **Datos:** Ana debe 20.00 en Netflix. Cobro de **30.00** aplicado 20.00; sobrante 10.00 reservado a Netflix.
- **Pasos:** `POST /credit-reservations/{id}/move` hacia Spotify.
- **Resultado:** reservado Netflix **0.00**, Spotify **10.00**; **crédito total de Ana sigue en 10.00**; **saldo de BCP sin cambio**; el recibo conserva **30.00**; no se crea ingreso; queda un `audit_event` con la acción.

### A10 — Baja con ciclo pagado al proveedor y anticipos futuros  · E2 · RN-X01/X02/X05

- **Datos:** cuota **20.00**; renovación el día 4; Ana pagó **7 ciclos** (`4-ene → 4-ago`, 140.00 aplicados); el proveedor está pagado para el ciclo `4-feb → 4-mar`. Baja solicitada el **15-feb**.
- **Resultado:** `efectivo = 4-mar`; el ciclo de febrero queda `paid` y **sin devolución actual**; los 5 cargos de `4-mar … 4-jul` pasan a `void`; se **liberan 100.00** y se programa una **devolución de 100.00**; el dinero real aún **no** salió (estado `planned`); pendiente de Ana **0.00**.

### A11 — Baja temprana con ciclo no pagado, y la igualdad  · E2 · RN-X03/X04 · D-01

- **Datos:** cuota **20.00**, ciclo `4-abr → 4-may`, `L = 7`, proveedor **no** pagado, Ana recibió **20.00** del ciclo.
- **a)** baja el **8-abr** (`u = 4`): cobro **3.00**; devolución **17.00**; efectivo 8-abr.
- **b)** baja el **11-abr** (`u = 7`): `u ≥ L` → **termina el 4-may**, sin devolución del ciclo.
- **c)** baja el 8-abr **con proveedor pagado** → termina el 4-may (prioridad).

### A12 — Retiro con deuda, conversión a préstamo y reingreso  · E2 · RN-X07/X09/I09

- **Datos:** Ana debe marzo **20.00** y abril **10.00** (abril tenía 10.00 pagados de 20.00).
- **Resultado (retiro):** nace **un préstamo** de **30.00** con **2 componentes** (20.00 y 10.00) que referencian los cargos de origen; los cargos origen quedan en **pendiente 0.00** por conversión; **deuda total de Ana = 30.00 antes y después** (no 60.00); **ninguna** operación financiera nueva.
- **Resultado (reingreso):** nueva participación y nueva plaza; el primer cargo nuevo parte sin deuda; el préstamo permanece aparte.

### A13 — Compartido a individual  · E2 · RN-X08

- **Datos:** Ana con deuda 20.00; Beto con 2 ciclos futuros pagados (40.00); renovación el día 4; cambio solicitado el 15.
- **Resultado:** efectivo en el **siguiente corte (día 4)**; participaciones terminan; deuda de Ana → préstamo 20.00 con detalle; cargos futuros de Beto `void`; **devolución programada de 40.00**; historial intacto; se registran solicitud, efectividad y devolución como fechas distintas.

### A14 — Pago tardío al proveedor  · E1 · RN-C06/F03

- **Datos:** renovación el **7-oct**; pago real el **10-oct**.
- **Resultado:** `supplier_payment.paid_on = 10-oct`; el ciclo sigue `7-oct → 7-nov`; el siguiente ciclo inicia el **7-nov**; el calendario **no** cambia.

### A15 — Gracia, suspensión y reactivación  · E2 · RN-C08/C09

- **Datos:** YouTube con ancla 28; el administrador olvida pagar, se suspende y se reactiva con renovación el día 4.
- **Resultado:** vista previa con ciclos y cargos afectados; **no se cobra gracia ni días extra**; los **montos emitidos no cambian**; los **vencimientos siguientes se corren al día 4**; la suspensión **no descuenta** cuota; queda un `calendar_change` con historial.

### A16 — Regalo permanente a quien ya debe  · E2 · RN-K01/K02/K04

- **Datos:** Beto debe **20.00** del ciclo anterior; se le regala el servicio desde el ciclo siguiente.
- **Resultado:** el sistema obliga a elegir. **Mantener:** deuda 20.00 intacta, nuevos cargos `net 0.00` con exención = bruto. **Convertir:** préstamo de 20.00 y deuda de servicio 0.00. En ambos casos **no** hay condonación ni cobro ficticio.

### A17 — Cobro tardío entre meses  · E1 (cálculo) + E5 (informe) · RN-F05/F06 · RN-RP07

- **Datos:** ciclo de enero: pago al proveedor **30.00** (enero); cuotas exigibles de terceros **20.00**; cobro de **20.00** recibido en **febrero**.
- **Resultado:** flujo de **enero** = −30.00 (sin cobro); flujo de **febrero** = +20.00; vista por ciclo: **enero** `costByCollections = 10.00` (30 − 20).

### A18 — Costo previsto vs según cobros  · E1 · RN-F04/F05/F08

- **Datos:** pago real **47.00**; cuotas exigibles de terceros **34.00**; cobros aplicados **24.00**.
- **Resultado:** `projectedCost 13.00`; `costByCollections 23.00`; `pendingFromOthers 10.00` (aparte).

### A19 — Compra con tarjeta y pago de la tarjeta  · E3 · RN-MV04

- **Pasos:** gasto Netflix **47.00** con *Tarjeta*; luego transferencia **47.00** de BCP → Tarjeta.
- **Resultado:** tras la compra, Tarjeta **−147.00**; tras el pago, Tarjeta **−100.00** y BCP **−47.00**; el gasto de Netflix aparece **una sola vez (47.00)**.

### A20 — Préstamo recibido y devolución con interés  · E3 · RN-MV05

- **Pasos:** recibir **1 000.00** de Carla en BCP; devolver **1 050.00** (1 000 capital + 50 interés).
- **Resultado:** flujo: **+1 000.00** y **−1 050.00**; resultado por conceptos: **costo financiero 50.00**; el capital **no** es ingreso ni gasto de consumo.

### A21 — Reserva para una meta  · E3 · RN-GO02/GO03

- **Datos:** BCP con saldo 100.00; se asignan 30.00 a una meta.
- **Resultado:** saldo BCP **100.00**; reservado **30.00**; libre **70.00**; **ninguna** operación creada.

### A22 — Aceptación repetida (idempotencia) y correo + foto del mismo pago  · E1 (idempotencia) + E4 (captura) · RN-CA02/DU01…DU04

- **E1:** repetir `POST /receipts` con la **misma `Idempotency-Key`** y mismo cuerpo → misma respuesta, **1 recibo, 1 operación**, saldo sube **una vez**. Mismo clave con cuerpo distinto → `422 IDEMPOTENCY_KEY_REUSED`.
- **E4:** correo y foto del mismo Yape → una **posible coincidencia** advertida o agrupada; si se confirma que es la misma, **un solo** movimiento con **dos evidencias**; aceptar dos veces no duplica.

### A23 — Sin internet  · E5 · RN-OF01…OF05

- **Resultado:** se consultan los datos en caché con **fecha de última actualización** visible; registrar, editar y aceptar quedan **deshabilitados** hasta reconectar; la caché se borra al cerrar sesión.

### A24 — Corregir un cobro aplicado a dos deudas  · E2 ✅ (implementado) · RN-V02/V04/V05

- **Datos:** cobro **30.00** aplicado 20.00 (Netflix) + 10.00 (Spotify). Se corrige el importe a **25.00**.
- **Resultado:** vista previa de efectos (BCP −5.00; aplicaciones a reconstruir); el usuario elige 20 + 5; se crea una **reversión** del cobro original y una **nueva operación**; el recibo viejo queda `reversed`; auditoría con motivo; **no** se registra devolución de dinero.

### A25 — Resumen mensual y corrección posterior  · E5 · RN-RM01/RM02

- **Resultado:** el reporte vivo cambia tras la corrección; la **versión guardada** anterior se conserva; la nueva se identifica como versión siguiente.

### A26 — Restaurar un respaldo  · E5 · RN-BK06/BK07

- **Resultado:** se valida el manifiesto y las relaciones; saldos y deudas **coinciden** con los del respaldo; no se crean ingresos/gastos nuevos ni se reactivan pagos revertidos; la copia de recuperación previa existe.

### A27 — Aislamiento entre usuarios  · E1 · RN-SE (§2)

- **Pasos:** `U2` intenta (1) leer una cuenta de `U1`, (2) crear un cobro con el `contactId` de `U1`, (3) aplicar a una obligación de `U1`.
- **Resultado:** **404 / rechazo** en las tres; **ninguna fila creada**; en la base, insertar directamente una fila con `owner_id = U2` que apunte a un registro de `U1` **falla por la clave compuesta**.

### A28 — Concurrencia: dos dispositivos  · E1 · RN-R04 · [12 §7](12-modelo-de-datos.md)

- **a) Sobreaplicación:** cargo con pendiente **20.00**; dos cobros simultáneos intentan aplicar **15.00** cada uno (claves distintas).
  - Resultado: **exactamente uno** tiene éxito; el otro `422 OVER_ALLOCATION`; pendiente final **5.00**.
- **b) Misma clave:** dos peticiones idénticas simultáneas → **un solo** efecto.
- **c) Emisión:** dos `generate` simultáneos del mismo servicio → **un** ciclo por inicio (sin duplicados ni superposición).
- **d) Capacidad:** dos altas simultáneas al **último cupo** → una `201`, otra `422 CAPACITY_EXCEEDED`.

## 3. Pruebas adicionales del motor (E1)

| ID | Qué verifica | Referencia |
| --- | --- | --- |
| M01 | Todos los casos dorados 04 §10.1–10.6 | 04 |
| M02 | Propiedades 04 §11 (generadas, ≥ 1 000 casos por propiedad) | 04 |
| M03 | Verificación de calendario del alta: coincide / difiere / confirmada | RN-C03 |
| M04 | Ciclos se generan sin superposición ni huecos tras cambiar términos | RN-C01 |
| M05 | Un ciclo generado dos veces no duplica (restricción única y exclusión) | RN-C11 |
| M06 | Monedas distintas no se aplican | RN-R04 |
| M07 | Cargo único por plaza y ciclo (`UNIQUE (seat_id, cycle_id)`) | RN-CH01 |
| M08 | Los asientos no se pueden modificar ni borrar | 12 §2 |
| M09 | Una transferencia desbalanceada se rechaza al confirmar | 12 §3 |
| M10 | `Σ aplicaciones activas ≤ importe del recibo` también a nivel de base | 12 §7 |
| M11 | Archivar contacto/servicio/cuenta conserva historial y reportes | RN-S07 |
| M12 | Importes con más de 2 decimales o signo inválido en la API → `VALIDATION_ERROR` | 02 §2 |
| M13 | La clave `Idempotency-Key` ausente en un `POST` financiero → `422` | 13 §1.1 |
| M14 | `PREVIEW_STALE` si el estado cambió entre vista previa y confirmación | 13 §1.2 |

## 4. Lista manual de verificación en Android (cierre de la E1)

Con la app conectada al backend real y base persistente:

1. [ ] Iniciar sesión (correo o Google) y cerrar/reabrir la app sin perder sesión.
2. [ ] Crear BCP con saldo inicial 200.00 y ver el saldo.
3. [ ] Crear contactos Ana, Beto y Carla.
4. [ ] Crear Netflix (45.00, 4 plazas, 7-oct → 7-nov) y ver la cuota sugerida **S/ 12.00**.
5. [ ] Incorporar a un participante a mitad de ciclo y revisar la **vista previa** del prorrateo antes de confirmar.
6. [ ] Registrar el pago al proveedor de **47.00** el 10-oct y comprobar que la renovación sigue el 7.
7. [ ] Cobrar **10.00** parcial, luego otro **10.00** y ver `pagado`.
8. [ ] Cobrar **60.00** por adelantado y ver crédito/reserva.
9. [ ] Ver el estado de cuenta de Ana con dos plazas (10 + 8 = 18).
10. [ ] Ver costo propio **previsto** y **según cobros**, con el pendiente aparte.
11. [ ] Matar la app y reiniciar el servidor: los datos siguen y no hay cobros duplicados.
12. [ ] Repetir un envío (doble toque en "Confirmar"): **no** duplica el cobro.
13. [ ] Sin red: ver datos en caché con fecha y acciones deshabilitadas.

## 5. Criterios de "terminado" por funcionalidad

Una funcionalidad de la E1 está terminada solo si: (1) sus reglas `RN-xxx` tienen prueba; (2) el SQL aplica sus restricciones; (3) el endpoint está en `openapi.json`; (4) la pantalla muestra la **vista previa con la fórmula** cuando hay cálculo; (5) pasa los escenarios asignados; (6) no hay variables secretas en el cliente.
