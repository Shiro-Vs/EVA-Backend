# EVA-Backend

API de EVA: suscripciones compartidas y finanzas personales. Especificación completa en
[`../docs/especificacion/`](../docs/especificacion/00-README.md) (fuente de verdad).

**Estado:** Entrega 0 (diseño técnico). Existen el esquema SQL aplicado y verificado, la configuración, el CI y la API mínima
(`/healthz`, `/readyz`). La lógica de negocio empieza en la Entrega 1.

## Requisitos

- Node.js ≥ 22 (probado con v22.22.3) y npm.
- PostgreSQL 18 instalado en el sistema (solo para sus binarios `initdb`, `pg_ctl`, `psql`). El proyecto crea **su propio clúster**
  en `.pgdata/`, independiente del servicio del sistema, escuchando solo en `127.0.0.1:54329` **sin contraseña** (únicamente desarrollo).
  Si PostgreSQL está en otra ruta: `PG_BIN="<carpeta bin>"`.

## Puesta en marcha

```bash
npm install
cp .env.example .env        # ajusta si hace falta
npm run db:init             # crea el clúster local y las bases eva_dev y eva_test
npm run db:migrate          # aplica las migraciones a eva_dev
npm test                    # reconstruye eva_test desde cero y ejecuta las pruebas
npm run dev                 # API en http://localhost:3000
```

| Comando | Qué hace |
| --- | --- |
| `npm run db:init` / `db:start` / `db:stop` / `db:status` | Gestiona el clúster local (`scripts/pg.mjs`) |
| `npm run db:migrate` | Aplica migraciones pendientes (cada una en una transacción; una aplicada es **inmutable**) |
| `npm run db:reset:dev` | Borra y reconstruye **solo** `eva_dev` |
| `npm test` | Vitest contra PostgreSQL real (sin simular la base) |
| `npm run typecheck` | `tsc --noEmit` |

## Estructura

```
migrations/    SQL numerado e inmutable (fuente de verdad del esquema). Generado desde docs/especificacion/12
src/config/    variables de entorno validadas al arrancar
src/db/        ejecutor de migraciones, Kysely (prueba de concepto T-03)
src/http/      Fastify: formato de error uniforme, X-Request-Id, health
test/          integración con PostgreSQL real y pruebas unitarias
archive/       schema.prisma.old (borrador anterior, solo referencia; no se ejecuta)
scripts/pg.mjs clúster PostgreSQL local del proyecto
```

`src/domain` (motor de cálculo puro) y `src/application` (casos de uso) llegan con la Entrega 1.

## Versiones fijadas (Entrega 0, 14-oct-2026)

Obtenidas con `npm view <paquete> version` al crear el proyecto; las exactas instaladas están en `package-lock.json`.

| Componente | Versión |
| --- | --- |
| Node.js (desarrollo) | 22.22.3 |
| PostgreSQL | 18.4 |
| TypeScript | ^7.0.2 |
| Fastify | ^5.12.7 |
| Kysely | ^0.29.6 |
| pg | ^8.23.1 |
| zod | ^4.6.7 |
| jose | ^6.2.12 |
| Vitest | ^5.0.4 |
| fast-check | ^4.10.2 |
| tsx | ^4.23.15 |
| @types/node | ^22.20.5 |

CI (`.github/workflows/ci.yml`): imagen `postgres:18`, Node 22, tipos + pruebas (que aplican todas las migraciones desde una base vacía) y `npm audit --audit-level=high`.
Pendiente de añadir con la Entrega 1: comprobación de `openapi.json` sin diferencias.

## Convenciones clave

- Dinero: `numeric(14,2)` en la base, **cadena decimal** en la API, céntimos enteros en el motor. Nunca `float`.
- Toda tabla privada lleva `owner_id`; las claves foráneas son compuestas `(owner_id, id)`.
- Los estados son `text` + `CHECK`. Los asientos y la auditoría son inmutables.
- No se editan migraciones aplicadas: se crea una nueva.
- Ninguna clave secreta en el cliente móvil.
