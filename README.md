<div align="center">

# EVA · API

**El cerebro de EVA: calcula cada sol, reparto y cuota para que la app solo tenga que mostrarlos.**

![Node](https://img.shields.io/badge/Node-%E2%89%A5%2022-5FA04E?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Supabase-4169E1?logo=postgresql&logoColor=white)
![Tests](https://img.shields.io/badge/pruebas-508-2EA44F)
![Estado](https://img.shields.io/badge/estado-en%20producci%C3%B3n-0369B2)

[Documentación](docs/README.md) · [Mapa interactivo](docs/mapa-eva.html) · [Pendientes](docs/PENDIENTES.md) · [Contrato OpenAPI](openapi.json)

</div>

---

## Qué es

EVA ayuda a repartir **suscripciones compartidas** (Netflix, Spotify…) y a llevar **finanzas personales** (cuentas, tarjetas, préstamos, presupuestos y metas), con captura de comprobantes y análisis con IA. Este repositorio es la **API**: la única que toca el dinero.

> **Regla de oro:** la app móvil nunca calcula importes. Todo prorrateo, reparto y total sale de aquí, con aritmética exacta (céntimos enteros) y reglas probadas.

| | |
|---|---|
| **Producción** | `https://api.eva-app.lat` en Render · salud en `/healthz` |
| **Datos** | Supabase (PostgreSQL, Auth y Storage) |
| **Contrato** | 216 operaciones bajo `/v1`, descritas en [`openapi.json`](openapi.json) |
| **Esquema** | 25 migraciones SQL numeradas e inmutables |
| **Pruebas** | 508 contra PostgreSQL real, sin simular la base |

## Arquitectura

```
 App móvil ──HTTPS + JWT──▶  http  ──▶  application  ──▶  domain (puro)
                                              │
                                              ▼
                                           infra ──▶ PostgreSQL · Storage · Gemini · Resend
```

| Capa | Carpeta | Responsabilidad |
|---|---|---|
| **HTTP** | `src/http` | Rutas Fastify, validación Zod, errores uniformes, OpenAPI |
| **Aplicación** | `src/application` | Casos de uso; una transacción por operación que toca dinero |
| **Dominio** | `src/domain` | Motor de cálculo **puro**: sin base de datos, reloj ni red |
| **Infraestructura** | `src/infra` | Kysely, autenticación, IA, correo, archivos, respaldos |
| **Esquema** | `migrations/` | Fuente de verdad de la base de datos |

## Empezar

Requisitos: **Node ≥ 22** y los binarios de PostgreSQL (`initdb`, `pg_ctl`). El proyecto crea su **propio clúster** en `.pgdata/` (solo `127.0.0.1:54329`, sin contraseña, solo para desarrollo), así que no toca tu PostgreSQL del sistema.

```bash
npm install
cp .env.example .env     # los valores por defecto sirven en local
npm run db:init          # crea el clúster y las bases eva_dev y eva_test
npm run db:migrate       # aplica el esquema
npm run dev              # API en http://localhost:3000
npm run dev:token        # token de desarrollo para llamar a la API sin Supabase
```

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | API con recarga automática |
| `npm test` | Toda la suite (necesita la base local encendida: `npm run db:start`) |
| `npm run typecheck` | Comprueba los tipos |
| `npm run openapi` | Regenera `openapi.json` (una prueba falla si queda desactualizado) |
| `npm run db:migrate` | Aplica migraciones pendientes |
| `npm run db:reset:dev` | Reconstruye **solo** la base de desarrollo |
| `npm run seed:demo` | Carga datos de demostración |
| `npm run storage:check` · `npm run job:daily` | Comprobaciones contra producción (leen `.env.supabase`) |

## Configuración

Las variables se validan con Zod al arrancar: si falta o sobra algo, **el proceso no inicia** y lo dice por su nombre. La lista comentada está en [`.env.example`](.env.example); los secretos nunca se versionan.

| Grupo | Variables |
|---|---|
| Base y entorno | `DATABASE_URL`, `PORT`, `TZ_DEFAULT`, `LOG_LEVEL`, `CORS_ORIGINS` |
| Identidad | `AUTH_MODE` (`dev` o `jwks`), `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE` |
| Archivos y respaldos | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `STORAGE_BUCKET`, `BACKUP_ENCRYPTION_KEY` |
| IA y captura | `EXTRACTOR`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `CAPTURE_DAILY_LIMIT` |
| Correo | `RESEND_API_KEY`, `MAIL_FROM`, `SUGGESTIONS_TO`, `INBOX_DOMAIN`, `RESEND_WEBHOOK_SECRET`, `RESEND_RECEIVE_KEY` |
| Tareas | `CRON_SECRET` |

## Rutas fuera de `/v1`

| Ruta | Para qué |
|---|---|
| `GET /healthz` · `GET /readyz` | Salud del proceso y de la base |
| `POST /jobs/daily` | Tarea diaria (respaldos, limpieza); exige `x-cron-secret` |
| `POST /webhooks/resend` | Correos reenviados para captura; firma Svix |

## Despliegue

Render despliega solo al hacer `git push` a `main` (Blueprint en [`render.yaml`](render.yaml)). Las migraciones se aplican **antes** de subir el código que las usa. Guía completa, reversión y comprobaciones en [`docs/operacion/02-despliegue-y-publicacion.md`](docs/operacion/02-despliegue-y-publicacion.md).

## Convenciones

- **Dinero:** `numeric(14,2)` en la base, cadena decimal en la API (`"20.00"`), céntimos enteros en el motor. Nunca `float`.
- **Aislamiento:** toda tabla privada lleva `owner_id` y ninguna ruta lo acepta de fuera.
- **Migraciones:** una aplicada no se edita; un cambio de esquema es una migración nueva.
- **Fechas:** día calendario local (`America/Lima`); el reloj se inyecta, nunca se lee dentro de las reglas.
- **Secretos:** jamás en el código, en el cliente móvil ni en un commit.

## Documentación

Todo vive en [`docs/`](docs/README.md):

| | |
|---|---|
| [`docs/especificacion/`](docs/especificacion/00-README.md) | Qué construir y por qué: reglas, decisiones, SQL, API y pruebas |
| [`docs/operacion/`](docs/operacion/01-guia-de-desarrollo.md) | Cómo se desarrolla, se publica y se mantiene |
| [`docs/mapa-eva.html`](docs/mapa-eva.html) | Mapa interactivo del sistema, los datos y la hoja de ruta |
| [`docs/PENDIENTES.md`](docs/PENDIENTES.md) | Lo que falta y las ideas nuevas |

---

<div align="center">
<sub>Proyecto privado · Todos los derechos reservados © EVA</sub>
</div>
