# 04 — Secretos y seguridad

Qué es secreto, dónde vive cada valor, cómo se rota y qué protecciones tiene el sistema.

> Estado: vigente al 17 de noviembre de 2026. **Este documento nunca contiene valores**, solo nombres y ubicaciones.

## 1. Reglas

1. Un secreto vive en **un solo lugar** (el panel del servicio que lo usa). Nunca en el código, en un chat, en un commit ni en una captura.
2. El repositorio de la app es **público**: allí solo hay valores públicos por diseño (ver §3).
3. Si un secreto se muestra o se sube por error, se **rota de inmediato** (§5); borrar el commit no basta.
4. Quien trabaje en el proyecto con ayuda de un asistente no le entrega claves: el asistente trabaja con los archivos `.env*` locales sin leerlos y pide al dueño que los complete.

## 2. Inventario de secretos

| Nombre | Qué protege | Dónde vive | Quién lo usa |
| --- | --- | --- | --- |
| `DATABASE_URL` | Acceso total a la base | Render (panel) y `.env.supabase` local | API, migraciones |
| `SUPABASE_SERVICE_ROLE_KEY` | Clave secreta de Supabase (Storage y administración de cuentas) | Render (panel) y `.env.supabase` | API |
| `BACKUP_ENCRYPTION_KEY` | Cifra los respaldos. **Si se pierde, los respaldos no se pueden abrir** | Render (panel) + copia en el gestor de contraseñas del dueño | API |
| `PREVIEW_SECRET` | Firma los *preview tokens* de operaciones | Render (generado) | API |
| `CRON_SECRET` | Autoriza `/jobs/daily` | Render (generado), cron-job.org, `.env.supabase` | API, cron |
| `GEMINI_API_KEY` | Uso de la IA (consume cuota) | Render (panel) | API |
| `RESEND_API_KEY` | Envío de correo | Render (panel) | API |
| `RESEND_WEBHOOK_SECRET` | Firma de avisos de correo entrante | Render (panel) | API (cuando se active) |
| `RESEND_RECEIVE_KEY` | Lectura de correos recibidos | Render (panel) | API (cuando se active) |
| Contraseña SMTP de Supabase | Envío de Auth por Resend | Supabase (Auth → SMTP) | Supabase |
| Secreto del cliente OAuth Web | Google sign-in | Supabase (Auth → Google) | Supabase |
| Cuenta de Expo, GitHub, Render, Supabase, Vercel, Spaceship, Google | Acceso a los paneles | Gestor de contraseñas del dueño, con verificación en dos pasos | Dueño |

## 3. Qué es público por diseño

Estos valores están en `eas.json` y en el repositorio público y **no son secretos**:

- `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SUPABASE_URL`.
- La **clave publicable** de Supabase (`sb_publishable_…`): solo permite lo que las políticas de la base autorizan, y la Data API está apagada.
- El **ID de cliente web de Google**: identifica la app, no autoriza nada por sí solo.
- Identificadores del proyecto de Expo.

Los nombres con `SECRET`, `SERVICE_ROLE`, `PRIVATE`, `DATABASE_URL` o claves `re_…`, `AIza…`, `sb_secret_…` **nunca** entran al repositorio de la app.

## 4. Protecciones del sistema

| Capa | Protección |
| --- | --- |
| Identidad | Tokens firmados de Supabase validados con JWKS; la API no guarda contraseñas |
| Datos | Cada consulta está filtrada por el dueño autenticado; no hay endpoint que devuelva datos de otra cuenta |
| Dinero | Operaciones con claves de idempotencia y *preview tokens* firmados: no se duplican ni se alteran entre la vista previa y la confirmación |
| Base | Data API apagada; RLS activado; conexión solo desde la API |
| Archivos | Bucket privado; acceso solo con la clave de servidor; originales borrados a los 90 días |
| Respaldos | Cifrados con `BACKUP_ENCRYPTION_KEY` |
| Tareas | `/jobs/daily` exige `x-cron-secret` |
| Correo entrante | Firma Svix con ventana de 5 minutos; direcciones por usuario rotables; remitentes desconocidos se descartan sin revelar nada |
| IA | Cuota diaria; el modelo no calcula ni registra dinero; toda propuesta la confirma el usuario |
| Dispositivo | Bloqueo opcional con PIN y huella; sesión en el almacén seguro del sistema (SecureStore) |
| Dependencias | Auditoría en el CI, con excepciones documentadas en `.github/audit-exceptions.json` (revisar el 16‑feb‑2027) |

## 5. Cómo rotar un secreto

| Secreto | Pasos |
| --- | --- |
| `GEMINI_API_KEY` | Crear clave nueva en Google AI Studio → pegarla en Render → borrar la vieja |
| `RESEND_API_KEY` | Crear clave nueva en Resend → actualizar Render (y la contraseña SMTP en Supabase, que usa la misma) → borrar la vieja |
| `CRON_SECRET` | Cambiarlo en Render **y** en la cabecera del trabajo en cron-job.org al mismo tiempo; probar con `npm run job:daily` |
| `DATABASE_URL` | Cambiar la contraseña de la base en Supabase → actualizar Render y `.env.supabase` → esperar al redespliegue |
| Clave secreta de Supabase | Generar una nueva en Supabase → actualizar Render y `.env.supabase` → revocar la anterior |
| `PREVIEW_SECRET` | Cambiarlo en Render. Efecto: se invalidan las vistas previas abiertas en ese momento (inofensivo) |
| `BACKUP_ENCRYPTION_KEY` | **No se rota sin plan:** los respaldos viejos solo se abren con la clave con que se cifraron. Guardar siempre la clave anterior mientras existan respaldos viejos |
| `RESEND_WEBHOOK_SECRET` | Rotar en Resend → actualizar Render. Durante la transición Resend firma con ambos |

Después de rotar: comprobar `/healthz`, iniciar sesión y `npm run job:daily`.

## 6. Antes de subir código al repositorio público

- [ ] `git diff` revisado: sin `.env`, claves, contraseñas ni cadenas de conexión.
- [ ] Ningún valor con aspecto de clave (`re_…`, `sb_secret_…`, `AIza…`, `postgresql://…:…@`) fuera de comentarios de ejemplo con valores falsos.
- [ ] Los archivos nuevos de configuración local están en `.gitignore`.
- [ ] Si algo sensible llegó a subirse: **rotar primero**, limpiar después.

## 7. Datos personales

- La política de privacidad y los términos están publicados en `https://www.eva-app.lat/privacidad/` y `/terminos/`.
- El usuario puede **exportar** sus datos y **eliminar su cuenta**; la eliminación deja una marca y la tarea diaria completa la limpieza (RN‑xxx en la especificación).
- No se envían datos personales a servicios que no los necesitan: el análisis de IA recibe cifras agregadas, no identificadores de contactos.
