# 02 — Despliegue y publicación

Cómo llega cada cambio a producción y cómo volver atrás. Cómo se conectan las piezas está en el [mapa del sistema](../mapa-eva.html) (pestaña «Publicar cambios»).

> Estado: vigente al 17 de noviembre de 2026.

## 1. Resumen

| Qué cambia | Cómo se publica | Cuánto tarda | Lo ve el usuario |
| --- | --- | --- | --- |
| API (`EVA-Backend`) | `git push origin main` → Render despliega solo | 3–5 min | Al instante, sin tocar la app |
| Base de datos | Migración nueva + `npm run db:migrate:prod` | segundos | Al desplegar el código que la usa |
| Web (`EVA-Web`) | `git push origin main` → Vercel despliega solo | segundos | Al instante |
| App: código y pantallas | `npm run publicar -- "mensaje"` (EAS Update) | ≈ 2 min | La próxima vez que abra la app |
| App: cambio nativo (librería, permisos, SDK, ícono, pantalla de carga) | `eas build` → APK nuevo | 15–20 min | Instalando el APK |

## 2. API en Render

- **Servicio:** `eva-api` (Blueprint «EVA»), región Virginia, plan gratuito. Se despliega desde la rama `main` de `Shiro-Vs/EVA-Backend` leyendo `render.yaml`.
- **Compilación:** `npm ci --include=dev` (el servidor corre con `tsx`, que es una dependencia de desarrollo). **Arranque:** `npm run start:prod`. **Salud:** `GET /healthz`.
- **Dirección:** `https://api.eva-app.lat` (dominio propio con certificado) y `https://eva-api-6bef.onrender.com`.
- **Variables:** las públicas viven en `render.yaml`; los secretos, solo en el panel (Environment). Inventario en [04](04-secretos-y-seguridad.md). Al añadir una variable secreta nueva: declararla en `render.yaml` con `sync: false` y crearla a mano en el panel **antes** de subir el código que la exige (la API no arranca si falta una variable obligatoria).
- **Plan gratuito:** el servicio se duerme tras ≈ 15 min sin uso (la primera petición tarda 30–60 s) y su disco es temporal (por eso los archivos van a Supabase Storage). Ver [05](05-mantenimiento-y-problemas.md) para cuándo pagar.

### Publicar un cambio de API

```bash
cd EVA-Backend
npm run typecheck && npx vitest run
git push origin main                       # Render despliega solo
curl https://api.eva-app.lat/healthz       # → {"status":"ok"} cuando termina
```

### Volver atrás

En Render → `eva-api` → **Deploys** → elige el despliegue anterior bueno → **Rollback**. El código vuelve atrás de inmediato; **las migraciones no** (ver §3).

## 3. Base de datos (Supabase)

- Una migración **solo avanza**: nunca se edita una aplicada ni se deshace. Si una migración fue un error, se corrige con otra nueva.
- **Orden correcto cuando un cambio necesita una tabla o columna nueva:**
  1. Escribir la migración `NNNN_descripcion.sql` y probarla en local.
  2. Aplicarla en producción: `npm run db:migrate:prod` (usa `.env.supabase`; el dueño debe tener ahí `DATABASE_URL`).
  3. Recién después, subir el código que la usa.
  Así el código nuevo nunca encuentra una base sin su estructura. Las migraciones deben ser compatibles hacia atrás (agregar, no quitar) para que un *rollback* de código no rompa.
- **Conexión:** siempre por el **Session pooler** de Supabase (IPv4); la conexión directa es solo IPv6 y Render no la alcanza.
- La API de datos de Supabase (Data API) está **apagada** y RLS automático activado: nadie lee tablas con la clave pública.

## 4. Web en Vercel

`Shiro-Vs/EVA-Web` (HTML y CSS planos, sin compilación). Cada `git push origin main` publica. Páginas: `/`, `/privacidad/`, `/terminos/`, `/confirmado/`. Dominio principal `https://www.eva-app.lat`; `eva-app.lat` redirige a `www` (308). Vercel Hobby es solo para uso no comercial.

## 5. App Android (Expo / EAS)

### 5.1 Perfiles (`eas.json`)

| Perfil | Resultado | Canal de actualizaciones | Uso |
| --- | --- | --- | --- |
| `preview` | **APK** instalable directo | `preview` | Tú y tus amigos |
| `production` | **AAB** (formato de Google Play) | `production` | Cuando se publique en Play Store |

Las variables públicas de la app (`EXPO_PUBLIC_*`) se declaran dentro de cada perfil en `eas.json`: el `.env` local **no** viaja a la compilación.

### 5.2 Compilar un APK nuevo

```bash
cd EVA-Frontend
# 1. subir "version" en app.json (porque cambia el runtime de las actualizaciones)
npx eas-cli build --platform android --profile preview
```

Al terminar, el enlace **de la página** (`expo.dev/accounts/shirovs/...`) es privado. Para compartir el APK hay que dar el **enlace directo del archivo** (`https://expo.dev/artifacts/eas/....apk`), que es público. Se obtiene con:

```bash
npx eas-cli build:list --platform android --limit 3 --json --non-interactive
```

Los archivos de compilaciones del plan gratuito **caducan a los 14 días**; la app ya instalada sigue funcionando.

### 5.3 Actualizar sin reinstalar (EAS Update)

```bash
npm run publicar -- "Qué cambió"            # canal preview
npm run publicar:produccion -- "Qué cambió" # canal production
```

- El comando usa **siempre** las direcciones de producción de `eas.json` y se niega a publicar si la API es local.
- La app busca versiones nuevas al abrirse y al volver a primer plano; cuando hay una lista, pregunta «Actualizar ahora».
- **`runtimeVersion`** sigue a `version` de `app.json` (política `appVersion`): una actualización solo llega a APK de la **misma** versión. Por eso, tras un cambio nativo, se sube `version` y se compila un APK nuevo.
- Volver atrás: publicar de nuevo la versión anterior, o revertir desde expo.dev → *Over-the-air updates*.

| Cambia… | ¿Basta con `publicar`? |
| --- | --- |
| Pantallas, textos, estilos, lógica de la app | Sí |
| Una librería con código nativo, permisos de Android, ícono, pantalla de carga, versión del SDK de Expo | No: APK nuevo |

## 6. Dominio y DNS (Spaceship)

| Registro | Host | Apunta a | Para qué |
| --- | --- | --- | --- |
| CNAME | `api` | `eva-api-6bef.onrender.com` | API |
| A / CNAME | `@` y `www` | los valores que muestra Vercel | Sitio web |
| TXT | `resend._domainkey` | firma DKIM de Resend | Enviar correo |
| CNAME | `send` y `rsend` | `…forge.rmta.net` (Resend) | Enviar correo |
| TXT | `_dmarc` | `v=DMARC1; p=none;` | Reputación de correo |
| TXT | `@` | `google-site-verification=…` | Prueba de propiedad para Google |
| MX | `in` | el valor que muestra Resend | **Pendiente:** recibir correos (ver [03 §5](03-integraciones.md)) |

El dominio `eva-app.lat` renueva automáticamente y vence el 6 de noviembre de 2027.

## 7. Tarea diaria (cron-job.org)

Dos trabajos, hora de Lima:

| Hora | Petición | Para qué |
| --- | --- | --- |
| 02:55 | `GET https://api.eva-app.lat/healthz` | Despertar al servidor si Render lo durmió |
| 03:00 | `POST https://api.eva-app.lat/jobs/daily` con la cabecera `x-cron-secret` | Respaldos automáticos, borrar originales de más de 90 días, limpiar exportaciones vencidas y marcas de cuentas eliminadas |

Comprobación manual: `npm run job:daily` (lee `CRON_SECRET` de `.env.supabase`). Debe responder `HTTP 200` con un resumen.

## 8. Después de cada despliegue

| Comprobación | Cómo |
| --- | --- |
| La API responde | `curl https://api.eva-app.lat/healthz` y `/readyz` |
| El login funciona | Entrar en la app con correo |
| El almacenamiento funciona | `npm run storage:check` |
| La tarea diaria responde | `npm run job:daily` |
| El CI está en verde | `gh run list --repo Shiro-Vs/EVA-Backend --limit 3` |

## 9. Lista de comprobación de lanzamiento de una versión de la app

- [ ] Pruebas y tipos en verde; `expo-doctor` sin problemas.
- [ ] `version` subida en `app.json` si hay cambios nativos.
- [ ] API y migraciones ya desplegadas (la app nueva no debe pedir algo que el servidor no tiene).
- [ ] Compilar, instalar en un teléfono real y probar: arranque, sesión, Google, Sugerencias, notificaciones, PIN y huella.
- [ ] Compartir el enlace directo del APK; anotar la fecha de caducidad (14 días).
