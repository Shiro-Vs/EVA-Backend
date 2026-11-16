# 05 — Mantenimiento y solución de problemas

Rutinas periódicas, límites de los planes gratuitos y qué hacer cuando algo falla.

> Estado: vigente al 17 de noviembre de 2026.

## 1. Rutinas

| Cada… | Qué | Cómo |
| --- | --- | --- |
| Semana | Mirar que la tarea diaria corra | cron-job.org → historial (debe haber `200`) |
| Mes | Revisar correos y cuotas | Resend (uso), Gemini (cuota), Supabase (uso de base y archivos) |
| Mes | Comprobar el CI | `gh run list --repo Shiro-Vs/EVA-Backend --limit 5` y lo mismo con `EVA-Frontend` |
| 14 días | Si hay APK compartido: renovarlo | Compilar de nuevo o redistribuir antes de que caduque el enlace |
| 16‑feb‑2027 | Revisar excepciones de la auditoría de dependencias | `EVA-Frontend/.github/audit-exceptions.json` |
| 6‑nov‑2027 | Renovación del dominio | Spaceship (renovación automática; confirmar el medio de pago) |
| Con cada versión de Expo SDK | Actualizar el SDK | `npx expo install --fix`, `npx expo-doctor`, compilar APK nuevo |

## 2. Límites a vigilar

| Servicio | Límite del plan gratuito | Qué ocurre al alcanzarlo | Cuándo pagar |
| --- | --- | --- | --- |
| Render | Se duerme a los ≈ 15 min; 750 h/mes | Primera petición lenta | Al tener usuarios que lo noten o para quitar el cron de «despertar» |
| Supabase | 500 MB base, 1 GB archivos, pausa tras 7 días sin actividad | Pausa o rechazo de escrituras | Al acercarse al 70 % o al necesitar respaldos del proveedor |
| Resend | 100 correos/día, 3 000/mes | Se rechazan envíos | Con más de unas decenas de usuarios nuevos al día |
| Gemini | Cuota de Google + 30 usos/día/usuario | Cae al extractor básico | Si se ofrece IA a muchos usuarios |
| EAS | Cupo mensual de compilaciones | Cola o rechazo | Con compilaciones frecuentes |
| Vercel Hobby | Solo uso no comercial | Riesgo de suspensión si se monetiza | Antes de cobrar por la app |

## 3. Respaldos y restauración

- **Automáticos:** la tarea diaria crea un respaldo cifrado por usuario (según su configuración) y borra los vencidos.
- **Manuales:** desde la app, *Más → Respaldos*; también restauración y exportación.
- **Base completa:** Supabase gratuito no ofrece respaldos descargables. Para una copia total: `pg_dump` con la `DATABASE_URL` del Session pooler y guardar el archivo cifrado fuera de la nube del proyecto. Pendiente de rutinizar (ver [PENDIENTES](../PENDIENTES.md)).
- **Probar la restauración** al menos una vez antes de lanzar a más usuarios.

## 4. Problemas frecuentes

### La app dice que no puede conectarse
1. Abrir `https://api.eva-app.lat/healthz` en el navegador. Si tarda y responde, era Render dormido.
2. Si no responde: Render → `eva-api` → *Logs*. Buscar el error de arranque (suele ser una variable faltante o inválida: la API lo dice por su nombre).
3. Si el último despliegue falló: *Rollback* al anterior (ver [02 §2](02-despliegue-y-publicacion.md)).

### El despliegue de Render falla
- **«Environment variable … required»:** falta una variable secreta en el panel; crearla y redesplegar.
- **Error de compilación:** reproducir en local con `npm ci --include=dev && npm run typecheck`.
- **Error de base de datos al arrancar:** una migración pendiente. Ejecutar `npm run db:migrate:prod` y reiniciar.

### No llega el correo de confirmación o de código
1. Resend → *Logs*: ¿salió? ¿rebotó?
2. Revisar *Spam*. Los dominios nuevos tardan en ganar reputación.
3. Supabase → Auth → *SMTP*: que siga activo y con la clave vigente.
4. Si el enlace de confirmación aparece como «vencido» al instante: un antivirus o servicio de correo lo abrió antes. La recuperación de contraseña usa **código** justamente por esto.

### La pantalla «Nueva contraseña» o el login se queda cargando
Actualizar a la última versión de la app (cerrarla y abrirla dos veces para recibir la actualización). Si persiste, cerrar sesión y volver a entrar.

### «Continuar con Google» no abre la hoja de cuentas
- Solo funciona en el **APK**, no en Expo Go.
- Comprobar que el SHA‑1 del certificado de firma esté en el cliente Android de Google Cloud ([03 §3](03-integraciones.md)).
- Si el teléfono tiene una sola cuenta de Google, Android puede entrar directo sin preguntar: es el comportamiento del sistema. El respaldo por navegador siempre pregunta.

### Mi amigo no puede abrir el APK
- Darle el **enlace directo del archivo** `.apk`, no el de la página de la compilación (esa pide cuenta de Expo).
- Si el enlace caducó (14 días), compilar de nuevo.
- En el teléfono: permitir «instalar apps de fuentes desconocidas» para el navegador o el gestor de archivos.

### La actualización por internet no llega
- El APK y la actualización deben compartir `version` (runtime). Si cambió `version`, hace falta un APK nuevo.
- Cerrar la app por completo y abrirla; la comprobación se hace al abrir y al volver a primer plano.
- Ver que la actualización se publicó en el **canal** correcto (`preview` para el APK de pruebas).

### El CI del frontend sale en rojo
- Mirar qué paso falló: tipos, auditoría, pruebas o compilación web.
- **Auditoría:** si es un aviso nuevo de una herramienta de Expo sin arreglo disponible, evaluarlo y, si procede, añadirlo a `.github/audit-exceptions.json` con motivo y fecha de revisión.

### Las migraciones de producción y local se desincronizaron
No editar migraciones aplicadas. Crear una nueva que corrija. Para la base local de desarrollo se puede recrear con `npm run db:reset:dev`.

## 5. Antes de invitar a más personas

- [ ] Probar restauración de un respaldo.
- [ ] Decidir el plan de Render (despertar) y de Supabase (pausa y tamaño).
- [ ] Activar el correo entrante si se quiere captura por reenvío.
- [ ] Revisar privacidad y términos con un especialista si habrá usuarios fuera del círculo cercano.
- [ ] Pasar de APK a Google Play (firma, política de datos, pruebas cerradas).
