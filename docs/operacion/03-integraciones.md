# 03 — Integraciones

Qué servicios externos usa EVA, para qué, cómo están configurados y qué pasa si fallan. Vista gráfica: [mapa del sistema](../mapa-eva.html).

> Estado: vigente al 17 de noviembre de 2026. Los valores secretos **no** se anotan aquí: ver [04](04-secretos-y-seguridad.md).

## 1. Resumen

| Servicio | Para qué | Plan | Si cae |
| --- | --- | --- | --- |
| Supabase | Cuentas (Auth), base PostgreSQL, almacenamiento de archivos | Gratuito | La app no puede entrar ni guardar |
| Render | Ejecuta la API | Gratuito (se duerme) | La app muestra error de conexión |
| Vercel | Sitio web público | Hobby | Solo se ve mal la web |
| Resend | Envía correos (confirmación, recuperación, sugerencias); recibirá los de captura | Gratuito | No llegan correos; la app sigue |
| Google Cloud | Entrar con Google | Gratuito | Solo falla «Continuar con Google» |
| Gemini (Google AI) | Lectura de comprobantes y análisis con IA | Gratuito | Se usa el extractor básico; el análisis avisa |
| cron-job.org | Dispara la tarea diaria | Gratuito | Se acumulan respaldos y limpiezas pendientes |
| Expo / EAS | Compila el APK y publica actualizaciones | Gratuito | No se puede publicar; lo instalado sigue |
| Spaceship | Dominio `eva-app.lat` y DNS | Pagado (anual) | Dejan de resolverse web, API y correo |

## 2. Supabase

- **Proyecto:** región São Paulo. Se usa **Auth**, **Postgres** y **Storage**; la Data API está apagada.
- **Auth:** correo y contraseña, más Google. Confirmación de correo activada.
  - **Site URL:** `https://www.eva-app.lat/confirmado/`.
  - **Redirect URLs:** `eva://auth-callback` y `https://www.eva-app.lat/**`.
  - **Google:** activado con los *Authorized Client IDs* de web y Android y la opción *Skip nonce check* (necesaria con el inicio de sesión nativo).
  - **Tokens:** la API los valida con las claves públicas (JWKS, ES256); no guarda ningún secreto de firma.
- **SMTP propio:** los correos de Auth salen por Resend, remitente `EVA <noreply@eva-app.lat>`. Las plantillas en español están en [06](06-plantillas-de-correo.md).
- **Storage:** bucket privado `eva-originals` para comprobantes y respaldos cifrados. La API usa la **clave secreta** (solo servidor). Verificación: `npm run storage:check`.
- **Conexión a la base:** Session pooler (IPv4). Ver [02 §3](02-despliegue-y-publicacion.md).
- **Límites del plan gratuito:** 500 MB de base y 1 GB de archivos; el proyecto se **pausa tras 7 días sin actividad** (la tarea diaria ya cuenta como actividad).

## 3. Inicio de sesión con Google

Dos caminos, el mismo resultado (una sesión de Supabase):

1. **Nativo (APK):** la hoja de cuentas de Android (Credential Manager) devuelve un *ID token* que la app entrega a Supabase (`signInWithGoogleIdToken`).
2. **Navegador (respaldo y Expo Go):** flujo web de Supabase con `prompt=select_account`; vuelve por `eva://auth-callback`.

Configuración en Google Cloud (proyecto *EVAs*):

| Elemento | Valor |
| --- | --- |
| Pantalla de consentimiento | Externa, en producción; dominios autorizados `eva-app.lat` y la URL de Supabase |
| Cliente OAuth **Web** | ID público en `eas.json` y `.env` (`EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`); su secreto está en Supabase |
| Cliente OAuth **Android** | Paquete `com.shirovs.eva` + huella SHA‑1 del certificado de firma de EAS |
| URI de redirección autorizada | `https://<proyecto>.supabase.co/auth/v1/callback` |

Si se **cambia el certificado de firma** (p. ej. al publicar en Google Play), hay que añadir su SHA‑1 al cliente Android o el inicio nativo deja de funcionar.

## 4. Correo saliente (Resend)

- Dominio `eva-app.lat` verificado (DKIM, SPF, DMARC en [02 §6](02-despliegue-y-publicacion.md)).
- **Quién envía:**
  - Supabase Auth, por SMTP (confirmación y recuperación).
  - La API, por la API HTTP de Resend (`src/infra/mail.ts`): sugerencias de usuarios.
- **Sugerencias:** `POST /v1/suggestions` envía un correo con formato a `SUGGESTIONS_TO` (con *reply‑to* del usuario). Límite por usuario para evitar abuso.
- **Límite gratuito:** 100 correos al día y 3 000 al mes.

## 5. Correo entrante para captura (pendiente de configurar)

**Idea:** cada usuario tiene una dirección personal (`gastos.<nombre>-<código>@in.eva-app.lat`). Reenvía allí las constancias de Yape, Plin o su banco y EVA las convierte en una **propuesta** de movimiento que el usuario confirma (la IA nunca registra sola).

**Estado del código:** terminado y probado (`POST /webhooks/resend`, firma Svix, descarga de adjuntos, deduplicación, 508 pruebas verdes). **No se ha configurado** en Resend, DNS ni Render, y por eso no se probó con correo real.

### Pasos para activarlo (tú, cuando quieras)

| # | Dónde | Qué hacer |
| --- | --- | --- |
| 1 | Resend → Domains | Añadir `in.eva-app.lat` con **Receiving** activado; copiar el registro MX que muestra |
| 2 | Spaceship → DNS | Crear ese registro MX en el host `in`; esperar a que Resend lo marque verificado |
| 3 | Resend → Webhooks | Crear un webhook a `https://api.eva-app.lat/webhooks/resend` con el evento `email.received`; copiar el *signing secret* (`whsec_…`) |
| 4 | Resend → API Keys | Crear una clave con **acceso completo** (la de solo envío no puede leer correos recibidos) |
| 5 | Render → Environment | Añadir `RESEND_WEBHOOK_SECRET` (paso 3) y `RESEND_RECEIVE_KEY` (paso 4); guardar y esperar el despliegue |
| 6 | App | Entrar a Captura, rotar la dirección personal y reenviarse un correo de prueba |

Hasta completar los pasos 1–5 la ruta responde 404, así que no hay riesgo. Seguimiento en [PENDIENTES](../PENDIENTES.md).

## 6. Inteligencia artificial (Gemini)

- Modelo `gemini-2.5-flash` desde la API (`GEMINI_API_KEY`, solo servidor).
- Usos: extraer movimientos de comprobantes (imagen, PDF, texto) y el análisis con chat sobre los datos del usuario.
- **Cuota:** 30 usos diarios por usuario (`AI_DAILY_LIMIT`). Si la clave falta o la cuota de Google se agota, la captura cae al extractor heurístico (reglas de texto) y el análisis informa que no está disponible.
- **Privacidad:** el análisis recibe cifras ya calculadas por la API; el modelo **no calcula dinero**. Los comprobantes se envían para leerse y los originales se borran a los 90 días.

## 7. Tarea diaria (cron-job.org)

Descrita en [02 §7](02-despliegue-y-publicacion.md). Se autentica con la cabecera `x-cron-secret`. Si se quiere cambiar la hora, se edita allí, no en el código.

## 8. Expo y EAS

- Cuenta `shirovs`, proyecto *EVA*. Compila APK (perfil `preview`) y publica actualizaciones.
- El plan gratuito tiene cupo mensual de compilaciones; las compilaciones y sus archivos caducan a los 14 días.
- Las actualizaciones usan los canales `preview` y `production`. Ver [02 §5](02-despliegue-y-publicacion.md).

## 9. Si algo deja de funcionar

| Síntoma | Causa probable | Dónde mirar |
| --- | --- | --- |
| «No se pudo conectar» tras un rato sin usar | Render dormido | Esperar 1 minuto y reintentar; ver [05](05-mantenimiento-y-problemas.md) |
| No llegan correos de confirmación | Plantilla o SMTP | Supabase → Auth → SMTP; Resend → Logs |
| Google falla solo en el APK | SHA‑1 o ID de cliente equivocado | Google Cloud → Credenciales |
| «Sin cuota de IA» | Límite diario o de Google | Render → logs; `AI_DAILY_LIMIT` |
| La tarea diaria no corre | Error en cron-job.org | Su historial de ejecuciones |
