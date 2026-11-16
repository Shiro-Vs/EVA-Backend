# EVA — Especificación de construcción

Versión 1.1 del conjunto · 17 de noviembre de 2026 · Estado: **Entregas 0 a 6 construidas y en producción; pendiente la Entrega 7**.

Este conjunto es la **fuente de verdad del producto**: reglas numeradas, algoritmos, esquema SQL, contrato de API, decisiones y casos de prueba. Nació de la definición original (ahora en [`../_historico/`](../_historico/)) cruzada con el código, y se mantiene al día con lo construido. Cómo se desarrolla, se publica y se opera está en [`../operacion/`](../operacion/01-guia-de-desarrollo.md); lo que falta, en [`../PENDIENTES.md`](../PENDIENTES.md).

## Estado de las entregas

| Entrega | Estado |
| --- | --- |
| 0 Diseño técnico | Hecha |
| 1 Primer recorrido Android | Hecha |
| 2 Núcleo de servicios | Hecha |
| 3 Finanzas completas | Hecha |
| 4 Captura y Gemini | Hecha (incluye correo entrante; falta configurarlo en producción, P-01) |
| 5 Operación e informes | Hecha |
| 6 Pulido y lanzamiento por APK | Hecha: en producción desde nov 2026 |
| 7 Dólares, tipo de cambio y acceso de amigos | **Pendiente** (P-09, P-10) |

Medidas actuales: 216 operaciones `/v1`, 25 migraciones, 508 pruebas de backend y 220 de frontend.

## Cómo se relaciona con el resto de la documentación

| Fuente | Rol |
| --- | --- |
| **`docs/especificacion/` (este conjunto)** | **Fuente de verdad del producto.** Si hay conflicto con el código, se corrige uno de los dos en el mismo cambio. |
| `docs/operacion/` | Cómo se trabaja, se publica y se mantiene lo construido. |
| `docs/PENDIENTES.md` | Lo que falta o se quiere añadir. |
| `docs/_historico/` | Definición original (01–14), arquitectura y cronograma antiguos. Solo consulta. |
| `EVA-Frontend/docs/` | Contexto histórico (Firebase, SQLite, sprints). Vigente solo el manual de colores. |

## Orden de lectura

| # | Documento | Para qué sirve | Lo usa quien… |
| --- | --- | --- | --- |
| 01 | [Visión y alcance](01-vision-y-alcance.md) | Qué es EVA, qué entra en cada entrega y qué no | todos |
| 02 | [Glosario y convenciones](02-glosario-y-convenciones.md) | Vocabulario único, nombres ES↔EN, formatos de dinero y fecha | todos |
| 03 | [Reglas de suscripciones](03-reglas-suscripciones.md) | Reglas de negocio numeradas (RN-xxx) del núcleo | backend, pruebas |
| 04 | [Motor de cálculo](04-motor-de-calculo.md) | Algoritmos exactos, redondeo, calendario y casos dorados | backend |
| 05 | [Finanzas personales](05-finanzas-personales.md) | Cuentas, movimientos, clasificación, presupuestos, metas, recurrencias, conciliación | backend, front |
| 06 | [Préstamos y tarjetas](06-prestamos-y-tarjetas.md) | Préstamos personales y bancarios, tarjeta de crédito | backend |
| 07 | [Captura e IA](07-captura-e-ia.md) | Correo, foto, PDF, bandeja, duplicados, Gemini | backend, front |
| 08 | [Reportes y exportaciones](08-reportes-y-exportaciones.md) | Dos vistas financieras, resumen mensual, PDF/CSV/Excel | backend, front |
| 09 | [Seguridad, acceso y respaldos](09-seguridad-acceso-respaldos.md) | Autenticación, aislamiento, offline, respaldos, amenazas | todos |
| 10 | [Registro de decisiones](10-decisiones.md) | Cada decisión: confirmada o propuesta, con justificación | quien decide |
| 11 | [Arquitectura](11-arquitectura.md) | Stack, módulos, entornos, costos, CI/CD | backend, devops |
| 12 | [Modelo de datos](12-modelo-de-datos.md) | **SQL de PostgreSQL** de las Entregas 1 y 2, vistas e invariantes | backend |
| 13 | [Contrato de API](13-contrato-api.md) | Endpoints, formatos, errores, idempotencia | backend, front |
| 14 | [Casos de prueba](14-casos-de-prueba.md) | Escenarios A01–A28 con números exactos, estrategia de pruebas | todos |
| 15 | [Plan de implementación](15-plan-de-implementacion.md) | Entrega 0 y backlog de la Entrega 1 con criterios de aceptación | todos |
| 16 | [Auditoría del código existente](16-auditoria-del-codigo.md) | Qué se reutiliza, qué se reescribe y qué se descarta | front |
| 17 | [Trazabilidad y pendientes](17-trazabilidad-y-pendientes.md) | Contradicciones resueltas y lo que aún necesita tu confirmación | quien decide |

## Cómo leer las etiquetas

| Etiqueta | Significado |
| --- | --- |
| **[C]** | Confirmado por el creador. No se cambia sin decisión explícita. |
| **[P]** | Propuesta cerrada en este conjunto para destrabar la implementación. Tiene un ID `D-xx` en el documento 10. Se asume vigente salvo que el creador la corrija. |
| **[E2]**, **[E3]** … | Regla especificada, pero se implementa en esa entrega. |
| **RN-xxx** | Regla de negocio con ID estable; las pruebas y el SQL la citan. |
| **A01…A28** | Escenarios de aceptación (documento 14). |

## Nivel de detalle por entrega

| Entrega | Reglas | Algoritmos | SQL | API | Pruebas |
| --- | --- | --- | --- | --- | --- |
| 0 Diseño técnico | — | — | — | — | — |
| **1 Primer recorrido Android** | Completas | Completos | **Completo** | **Completo** | **Completas** |
| **2 Núcleo de servicios** | Completas | Completos | **Completo** | Resumen | Completas |
| 3 Finanzas completas | Completas | Fórmulas | Diccionario | — | Escenarios |
| 4 Captura y Gemini | Completas | Contrato de IA | Diccionario | — | Escenarios |
| 5 Operación e informes | Completas | Fórmulas | Diccionario | — | Escenarios |
| 6–7 iOS, web, ampliaciones | Alcance | — | — | — | — |

Las entregas 3 a 7 tienen reglas cerradas pero su SQL y contratos se detallan al iniciarlas, siguiendo el principio de no crear tablas por anticipación. El núcleo (IDs, propietario, moneda, fechas, operaciones separadas de aplicaciones) ya está diseñado para admitirlas sin reemplazarlo.

## Cómo cambiar una regla después

1. Registrar la necesidad en el documento 10 (ID, ejemplo, impacto).
2. Actualizar la regla en 03/05/06, el algoritmo en 04, el SQL en 12 y la API en 13 **en el mismo cambio**.
3. Añadir o ajustar el caso de prueba en 14. Una regla sin caso de prueba no está terminada.
4. Si ya existen datos, escribir una migración; nunca editar una migración aplicada.
