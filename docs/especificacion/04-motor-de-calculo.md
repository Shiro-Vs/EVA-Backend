# 04 — Motor de cálculo

Especificación exacta de los algoritmos del backend. El motor es **código puro**: sin acceso a base de datos, sin reloj, sin red. Recibe datos y devuelve resultados, lo que lo hace totalmente comprobable con los casos dorados de la sección 9.

Ubicación prevista: `EVA-Backend/src/domain/`. El frontend **no** replica estos cálculos; consume las vistas previas de la API ([13](13-contrato-api.md)). **[P T-05]**

## 1. Tipos base

```ts
type Cents = bigint;               // 1 sol = 100n
type LocalDate = number;           // días enteros desde 1970-01-01 (sin hora ni zona)

interface Money { cents: Cents; currency: 'PEN' }
```

- Conversión de borde: `"20.00"` ↔ `2000n`. Se rechaza más de 2 decimales y signos inválidos.
- `LocalDate` se construye y descompone con funciones propias (`fromYMD`, `toYMD`, `addDays`, `daysInMonth`, `isLeap`). No se usa `Date`.

### Aritmética entera

```ts
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;     // a ≥ 0, b > 0
const ceilToSol = (c: Cents) => ceilDiv(c, 100n) * 100n;        // 701n → 800n
```

Propiedad usada: `ceil(ceil(x)/100) = ceil(x/100)`, por lo que el redondeo a sol de `Q×r/B` se hace en **un solo paso**:

```
cobro_cents = ceilDiv( Q_cents × r , B × 100n ) × 100n
```

Cada resultado se redondea **una vez**; las tasas y pasos intermedios no se redondean. **[C]**

## 2. Calendario

### 2.1 Fin de ciclo

```ts
interface Interval { unit: 'day' | 'week' | 'month' | 'year'; count: number }  // count ≥ 1

function cycleEnd(start: LocalDate, anchor: LocalDate, iv: Interval): LocalDate
```

| Unidad | Cálculo |
| --- | --- |
| `day` | `start + count` |
| `week` | `start + 7×count` |
| `month` | Mes destino = mes de `start` + `count`. Día = `min( día(anchor), daysInMonth(destino) )`. |
| `year` | Año destino = año de `start` + `count`; mes y día del `anchor`; si es 29-feb y el año no es bisiesto → 28-feb. |

El **ancla** es el día original del servicio cuando el proveedor confirma la fecha calculada, y la fecha informada cuando difiere y el administrador lo confirma. Para `month` el día se toma del ancla (no de `start`) para evitar la deriva: ancla 31 → `31 ene → 28 feb → 31 mar → 30 abr → 31 may`. **[C/P D-02]**

### 2.2 Generación de ciclos

```ts
function generateCycles(input: {
  terms: Terms[];            // versiones con vigencia [valid_from, valid_to)
  firstStart: LocalDate;
  firstEnd: LocalDate;       // fecha informada por el proveedor (ancla del ciclo 1)
  existing: Cycle[];         // ya persistidos
  upTo: LocalDate;           // generar hasta cubrir esta fecha (+ 1 ciclo futuro)
}): Cycle[]                  // solo los NUEVOS
```

- Ciclo 1 = `[firstStart, firstEnd)`.
- Ciclo *n+1* empieza en el fin del ciclo *n* y termina en `cycleEnd(start, anchorVigente, intervalVigente)`.
- Se generan ciclos hasta que **exista uno que empiece después de `upTo`** (un ciclo futuro visible).
- **Idempotente**: si ya existe un ciclo con ese `start`, no se crea. La base lo respalda con `UNIQUE(subscription_id, start_date)` y una restricción de exclusión contra superposiciones.
- Cada ciclo copia una instantánea `{ announcedPrice, interval, anchor, baseDays }`.

### 2.3 Verificación del alta (RN-C03)

```ts
function verifyCalendar(start, nextPayment, iv): { ok: boolean; expected: LocalDate; diffDays: number }
```

`expected = cycleEnd(start, start, iv)`. Si `nextPayment ≠ expected` devuelve `ok = false` y la diferencia; el cliente muestra la advertencia y exige confirmación explícita (`confirmCalendarMismatch: true`). Ejemplo: inicio 7-oct, semanal, siguiente 14-oct → `ok`. Inicio 7-oct mensual, siguiente 9-nov → `diffDays = 2`.

## 3. Cuota sugerida (RN-P03)

```ts
suggestedQuota = ceilToSol( ceilDiv(announcedPrice_cents, occupiedSeats) )
```

`occupiedSeats ≥ 1` e incluye al administrador. Ejemplo: `4500n / 4` → `1125n` → `1200n` (S/ 12.00).

## 4. Base de prorrateo (B)

| Frecuencia | `B` (días) |
| --- | --- |
| Mensual (`month`, `count = 1`) | **30** fijo (aunque el mes real tenga 28–31 días) **[C]** |
| Semanal (`week`, `count = 1`) | **7** **[C]** |
| Anual (`year`, `count = 1`) | **días reales del ciclo** (365 o 366) **[C]** |
| Personalizada (cualquier otra) | **días reales del ciclo** (`end − start`) **[P D-03]** |

> La base 30 es una regla de cálculo para tramos parciales; **no** reemplaza las fechas reales de renovación.

## 5. Incorporación entre renovaciones (RN-I01…I08)

```ts
function proratedJoin(i: {
  quota: Cents; cycleStart: LocalDate; cycleEnd: LocalDate;
  joinDate: LocalDate; freeDaysThreshold: number /* g */; baseDays: number /* B */;
}): JoinResult
```

Pasos:

1. `r = cycleEnd − joinDate`. Si `joinDate < cycleStart` o `joinDate ≥ cycleEnd` → error `JOIN_OUT_OF_CYCLE`.
2. **Ingreso en la renovación** (`joinDate = cycleStart`): `modo = 'ciclo_completo'`, `bruto = quota`, `exención = 0`.
3. Si no: `prorrateo = ceilDiv(quota × r, B × 100) × 100`.
4. `bruto = min(quota, prorrateo)`; si `prorrateo > quota` → `warning = 'TRAMO_EXCEDE_CICLO'` (RN-I04).
5. **Umbral**: si `r ≤ g` → `exención = bruto`, `modo = 'tramo_gratis'`; si no `exención = 0`, `modo = 'tramo_cobrado'`.
6. `neto = bruto − exención`. `vencimiento = joinDate` (RN-I05).
7. Devuelve también `snapshot = { quota, r, B, g, prorrateo, modo, regla: 'RN-I01@v1' }`.

El umbral usa **`≤`**: con `g = 7`, `r = 7` es gratis. **[C]** (Regla A)

## 6. Distribución exacta (mayor resto)

Para repartir un total en partes proporcionales sin crear ni perder céntimos **[P D-04]**:

```ts
function distribute(total: Cents, weights: bigint[]): Cents[]
```

1. `suma = Σ pesos`; si es 0 → error.
2. `parte_i = total × peso_i / suma` (división entera hacia abajo).
3. `resto = total − Σ parte_i` (0 ≤ resto < n).
4. Ordenar los índices por el **mayor resto fraccionario** (`total × peso_i mod suma`) descendente; **desempate por índice ascendente**.
5. Sumar 1 céntimo a los primeros `resto` índices.

Invariante: `Σ partes = total`, siempre, y es determinista. `splitEqual(total, n)` es el caso con pesos iguales. Ejemplo: `distribute(1000n, [1n,1n,1n])` → `[334n, 333n, 333n]`.

> No se usa `ceil` por parte: si cada parte se redondeara hacia arriba, la suma superaría el total y crearía dinero inexistente.

## 7. Pendientes, aplicaciones y crédito

```ts
pending(charge) = net + Σ adjustments.active − Σ allocations.active − Σ conversions.active   // ≥ 0
```

```ts
interface ReceiptAvailability {
  received: Cents;
  applied: Cents;        // allocations activas
  refunded: Cents;       // refunds planned + paid
  reserved: Cents;       // credit_reservation activas
  unapplied: Cents;      // received − applied − refunded
  free: Cents;           // unapplied − reserved
}
```

**Validación de una aplicación** (todo en una transacción, con bloqueo de `receipt` y de la obligación):

1. `amount > 0`.
2. `amount ≤ receipt.unapplied` (o `≤ unapplied` + reserva propia si se consume una reserva).
3. `amount ≤ obligation.pending`.
4. Misma moneda; misma propiedad (`owner_id`); contacto del cobro = contacto de la obligación.

Si falla, **se rechaza toda la operación**, sin efectos parciales.

### Sugerencia de reparto (no obligatoria)

Orden por `due_date` ascendente y luego `created_at`; se asigna `min(pendiente, restante)` a cada cargo hasta agotar. Es solo una **propuesta editable** (RN-R03).

## 8. Cambios, bajas y devoluciones

### 8.1 Cambio de cuota (RN-Q01/Q02)

```ts
planQuotaChange(i: { effectiveFrom: LocalDate; oldQuota: Cents; newQuota: Cents;
                     issuedCharges: Charge[]; mode: 'per_renewal' | 'lump_sum'; today: LocalDate })
```

Para cada cargo emitido con `cycle.start ≥ effectiveFrom` y no cancelado: ajuste `Δ = newQuota − charge.currentQuota` (puede ser negativo). `per_renewal` → `due = cycle.start`; `lump_sum` → `due = today`, mismo `group_id`. Los ciclos que aún no tienen cargo emitido se emitirán con la cuota nueva, por lo que **no** reciben ajuste (evita cobrar dos veces).

### 8.2 Baja de una plaza (RN-X01…X05)

```ts
planExit(i: { requestDate; cycle; seatStart; quota; baseDays; limitDays /* L */;
              supplierPaidForCycle: boolean; receivedForCurrent: Cents; futureCharges: Charge[] }): ExitPlan
```

1. `cycle` = ciclo que contiene `requestDate`.
2. **Si el proveedor ya fue pagado** para ese ciclo → `efectivo = cycle.end`, `cobroActual = sin cambio`, `devolucionActual = 0`. *(prioridad, RN-X02)*
3. Si no: `u = requestDate − max(cycle.start, seatStart)`.
   - `u < L` → `efectivo = requestDate`; `cobro = ceilDiv(quota × u, B×100) × 100`; `devolucion = max(0, recibidoActual − cobro)`; ajuste al cargo del ciclo = `cobro − neto`.
   - `u ≥ L` → `efectivo = cycle.end`; sin cambio. *(igualdad ⇒ termina ciclo, D-01)*
4. **Ciclos futuros**: cargos con `cycle.start ≥ efectivo` → `void`; sus aplicaciones activas se **liberan** y su suma pasa a **crédito**; `devolucionFutura = Σ liberado` (importes realmente no consumidos).
5. **Deuda pendiente** de cargos vigentes (no void) → `conversión a préstamo` (RN-X07).
6. Devuelve `ExitPlan` con todas las fechas, importes y efectos para la vista previa; **no** modifica nada hasta confirmar.

### 8.3 Conversión de deuda a préstamo (RN-X07)

Para cada obligación origen con `pending > 0`: se crea un `loan_component` (concepto, período, plaza, importe = pendiente) y un `debt_conversion_item`. El pendiente del origen baja a 0 por la **parte convertida**; la suma de pendientes del contacto **no cambia** (A12). Sin `financial_operation`.

## 9. Costos del servicio (RN-F04…F08)

```ts
costSummary(cycle) = {
  announced,                         // del snapshot del ciclo
  actualPaid,                        // supplier_payment activo (o null)
  expectedFromOthers,                // Σ (net + ajustes activos) de cargos no void, excluye al administrador
  receivedFromOthers,                // Σ aplicaciones activas a esos cargos
  pendingFromOthers,                 // expectedFromOthers − receivedFromOthers
  projectedCost,                     // actualPaid − expectedFromOthers
  costByCollections,                 // actualPaid − receivedFromOthers
  surplus                            // si algún costo < 0, el excedente (positivo)
}
```

Sin pago real todavía, `projectedCost` usa `announced`, marcado como *estimado*.

## 10. Casos dorados (valores que el motor debe reproducir)

### 10.1 Prorrateo de incorporación — cuota 20, base 30, umbral 7

| Días restantes `r` | Prorrateo | Modo | Cobro neto | Nota |
| ---: | ---: | --- | ---: | --- |
| 1 | 1 → 1 | gratis | 0 | `r ≤ g` |
| 5 | 4 | gratis | **0** | A03 |
| 7 | 5 | gratis | 0 | igualdad al umbral |
| 8 | 6 | cobrado | 6 | `ceil(160/30)=6` |
| 12 | 8 | cobrado | **8** | A04 |
| 15 | 10 | cobrado | 10 | |
| 30 | 20 | cobrado | 20 | tope = cuota |
| 31 | 21 → tope 20 | cobrado | **20** | `TRAMO_EXCEDE_CICLO` |

(Prorrateo mostrado = `ceilSol(20×r/30)` antes del tope.)

### 10.2 Otras cuotas y frecuencias

| Entrada | Resultado |
| --- | --- |
| Cuota 10, base 30, `r=12`, `g=7` | `ceil(120/30)=4` → S/ 4.00 |
| Cuota 12, base 30, `r=10`, `g=7` | S/ 4.00 |
| Cuota 11.50, base 30, `r=10`, `g=7` | `1150×10/(30×100)=3.83` → S/ 4.00 |
| Cuota 7, `r=8`, `g=2` | `ceil(56/30)=2` → S/ 2.00 |
| Cuota 9, `r=29` | `ceil(261/30)=9` → S/ 9.00 (= cuota) |
| Semanal: cuota 5, `B=7`, `r=3`, `g=2` | `ceil(15/7)=3` → S/ 3.00 |
| Anual: cuota 120, ciclo de 365 días, `r=100`, `g=30` | `ceil(12000/365)=33` → S/ 33.00 |
| Anual: ciclo de 366 días, `r=100` | `ceil(12000/366)=33` → S/ 33.00 |
| Ciclo mensual de 31 días, ingreso en renovación, cuota 20 | S/ 20.00 (sin 31/30) — A05 |

### 10.3 Cuota sugerida

| Precio | Plazas | Resultado |
| ---: | ---: | ---: |
| 45 | 4 | **12** (11.25 ↑) |
| 45 | 5 | 9 |
| 47 | 4 | 12 (11.75 ↑) |
| 30 | 3 | 10 |
| 17.99 | 3 | 6 (5.997 ↑) |

### 10.4 Calendario

| Entrada | Salida |
| --- | --- |
| Ancla 31, mensual, desde 31-ene-2026 | 28-feb, 31-mar, 30-abr, 31-may |
| Ancla 30, mensual, desde 30-ene-2026 | 28-feb, 30-mar |
| Ancla 31, desde 31-ene-2028 (bisiesto) | 29-feb, 31-mar |
| Anual, ancla 29-feb-2028 | 28-feb-2029, 28-feb-2030, 28-feb-2031, 29-feb-2032 |
| Semanal desde 7-oct | 14-oct, 21-oct |
| Personalizado 15 días desde 1-oct | 16-oct, 31-oct |
| Cada 2 meses, ancla 31, desde 31-ene | 31-mar (no 28-mar), 31-may |
| Verificación: inicio 7-oct, mensual, informado 14-oct | `ok=false`, `diffDays=-24` |

> El caso "ancla 31 → 28 feb → 31 mar" prueba que el cálculo se hace desde el ancla; si el código derivase de la fecha anterior daría 28-mar.

### 10.5 Bajas

| Entrada | Resultado |
| --- | --- |
| Cuota 20, ciclo 4-abr→4-may, baja 8-abr, `L=7`, proveedor **no** pagado | `u=4<7` → inmediata; cobro `ceil(80/30)=3`; recibido 20 → devolución **17** |
| Mismo caso, baja 11-abr (`u=7`) | `u≥L` → termina el 4-may; sin devolución actual |
| Mismo caso, baja 8-abr, proveedor **pagado** | termina el 4-may (prioridad) |
| Recibidos 20, cobro 7 | devolución **13** |
| Pagó 7 ciclos (ene–jul, renov. el 4), baja 15-feb, proveedor pagado feb | efectivo 4-mar; 5 ciclos futuros `void`; devolución futura 5 × cuota |

### 10.6 Distribución

| Entrada | Salida |
| --- | --- |
| `distribute(1000n,[1,1,1])` | `[334,333,333]` |
| `distribute(1000n,[1,2])` | `[333,667]` (mayor resto: 333.33 y 666.67) |
| `distribute(1n,[1,1])` | `[1,0]` (desempate por índice) |
| `distribute(0n,[…])` | todo 0 |

## 11. Invariantes que las pruebas de propiedades deben comprobar

1. `Σ distribute(t, w) = t` para todo `t ≥ 0` y pesos positivos.
2. `0 ≤ cobro_incorporacion ≤ cuota` siempre.
3. `cobro` es monótono no decreciente en `r`.
4. `pending ≥ 0` y `Σ aplicaciones activas de un cobro ≤ importe del cobro`.
5. Generar ciclos dos veces produce el mismo resultado (idempotencia) y nunca superposición ni huecos.
6. `cycleEnd` siempre es posterior a `start`.
7. `cycleEnd(…, anclaD)` nunca devuelve un día mayor que `daysInMonth`.
8. Saldo de cuenta = Σ asientos, también después de reversiones.
