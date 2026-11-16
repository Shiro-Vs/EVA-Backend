# 01 — Guía de desarrollo

Cómo preparar el entorno, trabajar en el código, probarlo y entregarlo. Está pensada para retomar el proyecto después de semanas sin tocarlo.

> Estado: vigente al 17 de noviembre de 2026. Qué construir y por qué está en [`../especificacion/`](../especificacion/00-README.md); cómo se publica, en [02](02-despliegue-y-publicacion.md).

## 1. Qué hay y dónde

| Carpeta | Qué es | Repositorio | Lenguaje |
| --- | --- | --- | --- |
| `EVA-Backend` | API (Fastify), motor de cálculo, migraciones SQL | `Shiro-Vs/EVA-Backend` (privado) | TypeScript, Node 22 |
| `EVA-Frontend` | App Android (Expo / React Native) | `Shiro-Vs/EVA-Frontend` (público) | TypeScript |
| `EVA-Web` | Sitio público: presentación, privacidad, términos | `Shiro-Vs/EVA-Web` (privado) | HTML y CSS |
| `docs` | Documentación (esta carpeta) | vive dentro de `EVA-Backend/docs` (repo privado) | Markdown y HTML |

**Regla de oro del proyecto:** la app **nunca calcula dinero**. Todo importe, prorrateo, reparto y total lo calcula la API; la app solo lo muestra con formato (`S/ 20.00`). Si una pantalla necesita un número nuevo, se pide a la API.

## 2. Requisitos

- Node 22 o superior y npm.
- Git y la CLI de GitHub (`gh`), para ramas y comprobar el CI.
- Para probar en el teléfono: **Expo Go** (desarrollo rápido) o el **APK de EVA** (necesario para Google, notificaciones y huella).
- PostgreSQL **no** hace falta instalarlo: el proyecto trae su propio clúster local (ver §3).

## 3. Backend

### 3.1 Primer arranque

```bash
cd EVA-Backend
npm install
cp .env.example .env          # los valores por defecto sirven para trabajar en local
npm run db:init               # crea el clúster PostgreSQL local (carpeta .pgdata, puerto 54329, sin contraseña, solo 127.0.0.1)
npm run db:start
npm run db:migrate            # aplica las migraciones
npm run dev                   # API en http://localhost:3000 con recarga
```

El PostgreSQL local es solo del proyecto: `.pgdata` está ignorado por git y no usa contraseña porque solo escucha en `127.0.0.1`. No uses el PostgreSQL del sistema.

### 3.2 Comandos

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | API con recarga automática (`tsx watch`) |
| `npm run typecheck` | Comprueba los tipos |
| `npx vitest run` | Toda la suite (≈ 500 pruebas, 1–2 minutos). Necesita la base local encendida |
| `npx vitest run test/api/capture.test.ts` | Un archivo de pruebas |
| `npm run openapi` | Regenera `openapi.json` (una prueba falla si está desactualizado) |
| `npm run db:status` · `db:start` · `db:stop` | Gestionan el clúster local |
| `npm run db:migrate` | Aplica migraciones pendientes a la base de `DATABASE_URL` |
| `npm run db:reset:dev` | Borra y recrea la base **local** de desarrollo |
| `npm run seed:demo` | Carga datos de demostración (cuentas, servicios, contactos) |
| `npm run dev:token` | Emite un token de desarrollo para llamar a la API sin Supabase |
| `npm run storage:check` · `npm run job:daily` | Comprobaciones contra producción (ver [02 §7](02-despliegue-y-publicacion.md)); leen `.env.supabase` |

### 3.3 Variables de entorno

Todas se validan al arrancar con Zod: si falta o sobra algo, **el proceso no inicia** y dice por qué. La lista completa y comentada está en `EVA-Backend/.env.example`; el inventario con su nivel de secreto, en [04](04-secretos-y-seguridad.md).

Hay dos archivos locales, ambos ignorados por git:

| Archivo | Para qué |
| --- | --- |
| `.env` | Desarrollo local (`AUTH_MODE=dev`, base local) |
| `.env.supabase` | Comandos contra **producción** (`DATABASE_URL` de Supabase, `CRON_SECRET`, clave secreta). Lo llena el dueño; nadie más debe leerlo |

### 3.4 Estructura del código

```
migrations/        SQL numerado e inmutable: la fuente de verdad del esquema
src/config/        variables de entorno validadas
src/domain/        motor de cálculo PURO: sin base de datos, reloj ni red
src/application/   casos de uso: una transacción por operación que toca dinero
src/infra/         base de datos (Kysely), autenticación, IA, correo, archivos, exportaciones
src/http/          rutas Fastify, esquemas Zod, errores, contrato OpenAPI
test/              pruebas de API con PostgreSQL real y pruebas unitarias
scripts/           utilidades (PostgreSQL local, comprobaciones, datos de demostración)
```

Reglas de capas (las hace cumplir el código y las pruebas):

1. **`domain` no importa nada** de base de datos, red ni reloj. Se prueba con casos dorados.
2. **`application`** abre la transacción, valida y llama al dominio. Nunca devuelve filas crudas.
3. **`http`** solo traduce: valida la entrada con Zod, llama a un caso de uso y da formato al error. Todas las rutas `/v1` están documentadas en `openapi.json`.
4. **Dinero:** `numeric(14,2)` en la base, cadena decimal en la API (`"20.00"`), céntimos enteros dentro del motor. Nunca `float`.
5. **Fechas:** día calendario local (zona `America/Lima`) como `YYYY-MM-DD`; el reloj se inyecta, no se lee dentro de las reglas.
6. **Migraciones:** una migración aplicada **no se edita**. Un cambio de esquema es una migración nueva (`NNNN_descripcion.sql`); el ejecutor verifica el hash.

### 3.5 Cómo añadir una funcionalidad al backend

1. Anotar la regla en `especificacion/` (reglas `RN-xxx`, decisión `D-xx` en [10](../especificacion/10-decisiones.md)).
2. Si cambia el esquema: migración nueva.
3. Escribir el caso de uso en `src/application` y, si hay cálculo, en `src/domain`.
4. Añadir la ruta en `src/http/routes`, su esquema en `schemas.ts` y su entrada en `openapi.ts`; ejecutar `npm run openapi`.
5. Pruebas: unitarias del dominio y de API contra PostgreSQL real.
6. `npm run typecheck && npx vitest run`, y recién entonces hacer commit.

## 4. Frontend

### 4.1 Primer arranque

```bash
cd EVA-Frontend
npm install
cp .env.example .env          # solo valores públicos (API, Supabase, ID de cliente de Google)
npx expo start
```

Abre la app con Expo Go (QR) o, si ya tienes el APK instalado, ábrelo desde el teléfono. Con tu API local, pon en `.env` la IP de tu PC en la red WiFi (`EXPO_PUBLIC_API_URL=http://192.168.x.x:3000/v1`); para usar producción, `https://api.eva-app.lat/v1`.

| Comando | Qué hace |
| --- | --- |
| `npx expo start` | Servidor de desarrollo (Metro, puerto 8081) |
| `npx expo start --web` | La app en el navegador (sirve para revisar diseño; no hay Google ni notificaciones) |
| `npm test` | Pruebas (Jest, ≈ 220) |
| `npm run typecheck` | Comprueba los tipos |
| `npx expo-doctor` | Revisa que las dependencias coincidan con el SDK |
| `npm run publicar -- "mensaje"` | Publica una actualización por internet (ver [02 §5](02-despliegue-y-publicacion.md)) |

### 4.2 Expo Go frente al APK

| Capacidad | Expo Go | APK de EVA |
| --- | --- | --- |
| Pantallas, navegación, API | Sí | Sí |
| Entrar con la hoja de cuentas de Google | No (usa el navegador) | Sí |
| Notificaciones y recordatorios | No | Sí |
| PIN y huella | Parcial | Sí |
| Actualizaciones por internet (EAS Update) | No | Sí |
| Botón «Entrar en modo desarrollo» | Sí | No (solo existe con `__DEV__`) |

### 4.3 Estructura del código

```
app/            rutas de expo-router (una carpeta o archivo por pantalla)
src/api/        cliente de la API, sesión, caché sin conexión, login (Supabase, Google)
src/components/ kit de interfaz v1, hojas inferiores, diálogos
src/constants/  paletas de color, entidades bancarias
src/context/    sesión, tema, diálogos
src/hooks/      useAsync, useSubmit, useDone…
src/logic/      lógica de pantallas sin interfaz
src/screens/    pantallas por módulo
src/security/   bloqueo con PIN y huella
src/updates/    aviso de «hay una versión nueva»
```

### 4.4 Convenciones de interfaz

Criterios que se fueron fijando al pulir las pantallas; seguirlos mantiene la app coherente.

- **Colores:** la identidad es la **Paleta 1 · Pizarra** (azul de marca y acento ámbar). La Paleta 2 · Violeta es un tema alternativo. Los colores salen siempre de `useAppTheme()`; los únicos colores fijos permitidos son los de marcas externas (servicios, bancos).
- **Minimalismo:** listas planas con una barra de estado a la izquierda, no tarjetas por todo. Tarjetas solo para resúmenes (saldo, cuentas).
- **Formularios compactos:** selectores en lugar de montones de botones; calendarios para fechas; botones del mismo tamaño y que se distinguen por color.
- **Confirmaciones:** siempre con `useDialog` (`confirm`, `notify`, `success`, `fail`). Lo destructivo va en rojo, y el botón de **cancelar** es el destacado («Mantener»), para no incitar a borrar.
- **Hojas inferiores** (`BottomSheet`): se cierran deslizando hacia abajo.
- **Espaciado:** compacto y uniforme; cabecera fija y solo el contenido con scroll, sin scroll innecesario.
- **Idioma:** textos en español; mensajes de error del servidor traducidos por `code`.

## 5. Control de versiones

- **Ramas:** `main` es siempre desplegable. El trabajo largo va en una rama (`feat/…`) que se fusiona a `main` cuando está probado. Hoy el frontend y el backend trabajan directo sobre `main` y una rama de entrega.
- **Commits:** en español, en imperativo y descriptivos («Sugerencias: POST /v1/suggestions envía…»). **Sin líneas de atribución automática** en los mensajes.
- **Nunca se versiona:** `.env*` (salvo `.env.example`), claves, contraseñas, `.pgdata`, `.storage`, carpetas del editor o del asistente. El frontend es un **repositorio público**: antes de subir, comprobar que no entra ningún secreto (ver [04 §6](04-secretos-y-seguridad.md)).
- **CI (GitHub Actions):**
  - Backend: pruebas con un servicio PostgreSQL.
  - Frontend: tipos, auditoría de dependencias, pruebas y compilación web. La auditoría compara contra `.github/audit-exceptions.json` (avisos conocidos de herramientas de Expo, con fecha de revisión).

## 6. Lista de comprobación antes de subir cambios

- [ ] `npm run typecheck` sin errores (en el repositorio que tocaste).
- [ ] Pruebas verdes (`npx vitest run` o `npm test`).
- [ ] Si cambió la API: `npm run openapi` y el contrato actualizado.
- [ ] Si cambió el esquema: migración nueva, aplicada en local.
- [ ] Sin secretos en el diff.
- [ ] Documentación al día: regla o decisión en `especificacion/`, y pendientes en [`../PENDIENTES.md`](../PENDIENTES.md).
- [ ] Si cambió la infraestructura: `docs/mapa/datos.py` y regenerar el mapa.
