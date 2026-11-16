# 16 — Auditoría del código existente

> **Estado (17-nov-2026): registro histórico.** Es la auditoría del código previo a la reconstrucción (12-oct-2026). Sus recomendaciones se aplicaron: servicios simulados reemplazados por el cliente de la API, lógica de dinero movida al backend y Firebase retirado. No describe el código actual.

Alcance: `EVA-Frontend` (Expo SDK 54) y `EVA-Backend`. Revisión hecha el 12-oct-2026 leyendo el inventario completo de archivos, `package.json`, `.env.example`, flujos de CI, las interfaces, los servicios, la lógica de suscripciones y de finanzas, `api/gemini.ts`, `api/firebase.ts` y el borrador `schema.prisma`. **No se revisó pantalla por pantalla** (componentes de `src/screens` y `src/components`): esa revisión de interfaz es una tarea de la Entrega 0 ([15](15-plan-de-implementacion.md)). Las referencias `archivo:línea` corresponden al estado actual.

## 1. Resumen ejecutivo

| Parte | Veredicto |
| --- | --- |
| **Interfaz y navegación** (componentes comunes, tema, pestañas, rutas) | **Reutilizable.** Se conserva. |
| **Servicios** (`src/services`) | **Reemplazar**: hoy simulan una base en memoria con retardos artificiales. Mantienen una **buena costura** (todas las pantallas llaman a servicios), así que sustituirlos por un cliente de la API es de bajo riesgo. |
| **Lógica de dinero** (`src/logic/shared`) | **Reescribir en el backend.** Contradice las reglas confirmadas en varios puntos y usa un modelo (meses calendario, booleanos de pago) incompatible. |
| **Interfaces TypeScript** | **Reescribir** a partir del contrato de API; hoy usan `Date \| any` y claves de texto. |
| **Firebase y Gemini en el cliente** | **Eliminar.** Código muerto con riesgo de seguridad. |
| **`EVA-Backend`** | Solo contiene un `schema.prisma` borrador. **Descartar** y empezar con [12](12-modelo-de-datos.md). |
| **Pruebas y CI** | **Conservar la infraestructura** (Jest, flujos de GitHub); **reemplazar** las pruebas de la lógica que se retira. |

## 2. Qué se reutiliza

| Elemento | Dónde | Uso previsto |
| --- | --- | --- |
| Componentes base `EVAActionButton`, `EVAAlert`, `EVAAvatar`, `EVAInput`, `EVALoading`, `EVAModal`, `EVASeparator`, `LoadingSplash` | `src/components/common` | Intactos |
| Barra de pestañas | `src/components/layout/EVATabBar.tsx` | Intacta |
| Tema, colores y tipografía | `src/context/ThemeContext.tsx`, `src/hooks/useAppTheme.ts`, `src/constants/Colors.ts`, `Fonts.ts`, `EVA-manual-colores.md` | Intactos |
| Estructura de rutas con Expo Router | `app/` | Se mantiene; se añaden rutas de la E1 |
| Configuración de NativeWind/Tailwind, fuentes Asap, recursos gráficos | `tailwind.config.js`, `global.css`, `assets/` | Intacta |
| Pantallas de acceso | `LoginScreen`, `RegisterScreen`, `ForgotPasswordScreen` + `useLogin`, `useRegister`, `useForgotPassword` | Se conservan visualmente; cambia el origen de datos (`AuthService` → Supabase Auth) |
| Pantallas de panel, planificación, contactos, detalle de servicio | `DashboardScreen`, `PlanningScreen`, `contacts/*`, `ServiceDetail/*` | **Referencia visual.** Se rehacen para ciclos, plazas, aplicaciones y vistas previas (modelo distinto) |
| Flujos de CI (tipos, auditoría de dependencias, pruebas) | `.github/workflows/ci.yml`, `scripts/check-audit-exceptions.js` | Se conservan y se replican en el backend |
| Jest con `jest-expo` | `package.json` | Se conserva |

## 3. Hallazgos que obligan a reescribir la lógica

La lógica actual **no** implementa las reglas confirmadas. Cada punto enlaza con la regla correcta.

| # | Hallazgo | Ubicación | Regla vigente |
| --- | --- | --- | --- |
| H1 | **Desbordamiento de fechas**: el vencimiento se arma con `new Date(año, mes, dia_cobro)`. Con `dia_cobro = 31` en febrero, JavaScript produce **3 de marzo**, no el 28. Mismo patrón en el cierre del ciclo. | `subscriptionLogic.ts:79`, `:135`, `:155`, `:190` | RN-C04 (ancla + último día del mes) |
| H2 | **Umbral de cortesía fijo y distinto**: "menos de 5 días = gratis", "28 días o más = completo". Debe ser configurable (`g`), con `≤`, y aplicar el cobro de **todo el tramo** si `r > g`. | `subscriptionLogic.ts:198-202` | RN-I01, RN-I07 |
| H3 | **Redondeo erróneo**: `Math.round(x*100)/100` (al céntimo, "al más cercano"). Las suscripciones redondean **hacia arriba a sol entero**. | `subscriptionLogic.ts:206` | RN-I02, 02 §2 |
| H4 | **Aritmética de coma flotante** para dinero (`+`, `/`, `Number()`), con `reduce` sobre números JS. | `subscriptionLogic.ts:176`, `:259`; `financeLogic.ts:21` | D-16: céntimos enteros |
| H5 | **Ciclos = meses calendario**, identificados por el texto `"Octubre 2026"` y con orden por `parseMesAnio`. Solo `mensual` y `anual`; no hay semanal ni personalizada; un ciclo que cruza meses no cabe. | `Subscription.ts:1`, `serviceUtils.ts:1-14`, `subscriptionLogic.ts:60-109` | RN-C01/C02 (ciclo `[inicio, fin)`, ID estable) |
| H6 | **El estado de pago es un booleano** por persona y mes (`registro_pagos_personas: Record<string, boolean>`) más un `pagado_hasta`. | `Subscription.ts:22`, `:8` | RN-CH05: estado derivado de cargos y aplicaciones |
| H7 | **Los pagos se aplican por número de meses** (FIFO automático): no existen pagos parciales, importes, ni reparto manual; imposible representar S/ 10 sobre S/ 20. | `subscriptionLogic.ts:215-264` | RN-R01…R07 |
| H8 | **El pago adelantado se guarda como una fecha** `pagado_hasta` desplazada con `setMonth`. | `subscriptionLogic.ts:253` | RN-R08: reserva, no "pagado hasta" |
| H9 | **La deuda se calcula con el booleano y `cuota − pagado`**, sin ajustes, conversiones ni aplicaciones; además compara `Date` con zona local del dispositivo. | `financeLogic.ts:9-28`, `:76-86` | RN-CH04, D-13 |
| H10 | **Borrar participantes borra historial futuro**: `removeSubscriber` elimina registros del participante en ciclos futuros y no contempla deudas, devoluciones ni préstamos. | `SubscriptionService.ts:112-143` | RN-X01…X09, RN-S07 |
| H11 | **Regenerar el historial descarta ciclos futuros** sin pagos "para regenerarlos con la configuración actual". Mezcla configuración actual con historia. | `subscriptionLogic.ts:28-41` | RN-S06: las versiones no reescriben el pasado |
| H12 | **Se cambia la modalidad (compartido/individual) o la frecuencia "en el mes actual"** y se vacían los registros del mes. | `SubscriptionService.ts:55-87` | RN-X08 (siguiente corte, con préstamos y devoluciones) |
| H13 | **Una sola cuota por contacto y servicio** (`Subscriber.cuota`, y el diccionario se llavea por `Subscriber.id` = contacto). No hay plazas. | `Subscription.ts:3-11`, `:22-24` | RN-P01 (cuota por plaza) |
| H14 | **Sin concepto de cobro único con aplicaciones**: cada pago modifica el diccionario de montos del mes. | `Subscription.ts:24` | RN-R01 |
| H15 | **Tipos laxos**: `Date \| any` en fechas del dominio. | `Subscription.ts:8-9`, `:16-17`, `:39` | 02 §3 |
| H16 | **El estado vive en un objeto global mutable** (`mockDatabase`) y el "servicio" mezcla lectura con sincronización/escritura (`getSubscriptions` modifica la base). | `SubscriptionService.ts:18-25` | T-05, principio: lecturas sin efectos |

Consecuencia: las **pruebas actuales** (`financeLogic.test.ts`, `serviceHistoryUtils.test.ts`, `serviceUtils.test.ts`, `subscriptionLogic.test.ts`, unas 540 líneas) validan reglas que ya no aplican. Se **archivan** (no se portan) y se sustituyen por los casos de [14](14-casos-de-prueba.md) en el backend. Es normal que ya no pasen o carezcan de sentido tras el cambio de modelo.

## 4. Seguridad y configuración

| # | Hallazgo | Riesgo | Acción |
| --- | --- | --- | --- |
| S1 | `src/api/gemini.ts:3` crea el cliente con `process.env.EXPO_PUBLIC_GEMINI_API_KEY`. Cualquier variable `EXPO_PUBLIC_*` **se incluye en el paquete de la app** y es extraíble. | **Alto** si hay una clave real | Eliminar el archivo; mover Gemini al servidor (E4). **Si alguna vez se usó una clave real, rotarla.** |
| S2 | `src/api/firebase.ts` y las variables `FIREBASE_*` de `.env.example`; `firebase` en `package.json`. Ningún archivo bajo `src/` ni `app/` los importa: es **código muerto**. | Bajo (superficie innecesaria) | Eliminar archivo y dependencias. |
| S3 | `@google/generative-ai` instalada en el cliente. | Medio | Desinstalar del cliente. |
| S4 | `.env` existe en el repositorio local y **está ignorado por git** (`.gitignore:42`). No se leyó su contenido. | — | Mantener ignorado; comprobar en el historial de git que nunca se subió. Dejar `.env.example` solo con variables públicas. |
| S5 | README del frontend describe un producto con Firebase. | Confusión | Actualizar tras la Entrega 0. |

## 5. `EVA-Backend`

Solo contiene `prisma/schema.prisma`. Discrepancias con las reglas vigentes:

| # | Hallazgo | Regla vigente |
| --- | --- | --- |
| B1 | `provider = "sqlite"` con tipos `@db.Decimal`: la propia nota "cambia a postgresql, mismo código" no es válida (T-01). | T-01 |
| B2 | Ciclos por `(year, month)` único por servicio. | RN-C01 `[inicio, fin)` |
| B3 | `SubscriptionMember` con `@@unique([subscriptionId, contactId])`: **impide dos plazas** del mismo contacto. | RN-P01 |
| B4 | `fixedQuota` por participante; sin vigencias de cuota ni de precio. | RN-S06, RN-P04 |
| B5 | Deuda como `Debt` agregada por contacto con `currentBalance` en caché y `DebtItem/DebtPayment/DebtAllocation`; los pagos del contacto no son un **ingreso único** ligado a una operación de cuenta. | RN-R01 (cobro = un ingreso real) |
| B6 | `Account.currentBalance` almacenado (caché editable) en lugar de **suma de asientos**. | RN-AC02 |
| B7 | Sin clave compuesta de propietario: una FK por ID no impide cruzar usuarios. | 09 §2, 12 §1 |
| B8 | `TransactionType` mezcla `SAVING_CONTRIBUTION` y `LOAN_PAYMENT` con ingreso/gasto; los aportes a metas no deben crear dinero. | RN-GO02 |
| B9 | `Goal.deadline` obligatoria. | RN-GO01 (opcional) |
| B10 | Sin idempotencia, reversión ni auditoría de reversión; `AuditLog` genérico con `before/after` completos. | 12 §5–6 |
| B11 | `Budget` por mes y categoría únicamente. | RN-BU01 |

Algunas ideas sí se aprovechan: nombres `snake_case` con mapeo, `Decimal(14,2)`, borrado lógico, auditoría. Todo lo demás se rehace.

## 6. Decisión

- **Frontend**: conservar y adaptar la interfaz reutilizable (componentes, tema, navegación, acceso); reescribir `src/services`, `src/interfaces`, `src/logic/shared` y `src/logic/serviceDetail`/`contacts` que dependen del modelo antiguo; eliminar Firebase, Gemini cliente y mocks de dinero.
- **Backend**: crear el proyecto desde cero siguiendo [11](11-arquitectura.md) y [12](12-modelo-de-datos.md); archivar el `schema.prisma` actual como referencia (renombrar a `schema.prisma.old`, sin ejecutarlo).
- **Orden**: primero el backend de la E1 con sus pruebas; el frontend se conecta pantalla por pantalla (ver [15](15-plan-de-implementacion.md)).
