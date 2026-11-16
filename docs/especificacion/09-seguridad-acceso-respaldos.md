# 09 — Seguridad, acceso, offline y respaldos

La seguridad **no se deja para el final**: aislamiento, autenticación, auditoría y secretos correctos se incorporan desde la Entrega 1. **[C]**

## 1. Acceso

| ID | Regla | Estado |
| --- | --- | --- |
| RN-SE01 | Identidad con **Google** y **correo/contraseña**. Las cuentas con el mismo correo se **vinculan** sin duplicar usuario. | C |
| RN-SE02 | **PIN y biometría** locales, configurables, incluida la frecuencia de re-bloqueo. Valor inicial propuesto: bloquear tras **1 minuto en segundo plano**. El bloqueo local **no reemplaza** la autenticación del backend. | C/P D-25 |
| RN-SE03 | El **primer inicio de sesión** y el acceso remoto requieren conexión. | C |
| RN-SE04 | Recuperación de contraseña y sesión expirada: flujo estándar del proveedor de identidad (correo de restablecimiento). Una sesión expirada **sin conexión** permite ver la caché ya cargada pero no operar. | P |
| RN-SE05 | **No** se guardan contraseñas/PIN en texto plano, credenciales de IA en el cliente, ni CVV/claves bancarias. El token de sesión va en almacenamiento seguro del dispositivo (`expo-secure-store`), no en `AsyncStorage`. | C |
| RN-SE06 | Dispositivos autorizados y cierre remoto de sesiones: lista de sesiones activas con opción de cerrar (E5). | P |

## 2. Autorización y aislamiento (defensa en profundidad)

Cuatro capas, de modo que un fallo en una no exponga datos de otro usuario:

| Capa | Mecanismo |
| --- | --- |
| 1. API | Cada petición valida el JWT; el `owner_id` **sale del token**, nunca del cuerpo ni de la URL. Toda consulta filtra por `owner_id`. |
| 2. Dominio | Una operación que relaciona entidades verifica que **todas** pertenecen al mismo propietario antes de escribir. |
| 3. Base de datos | **Claves foráneas compuestas** `(owner_id, id)`: una FK por ID solo no impide apuntar a un registro ajeno, la compuesta sí ([12](12-modelo-de-datos.md)). |
| 4. Opcional | *Row Level Security* de PostgreSQL como red de seguridad adicional si se accede a la base desde fuera de la API. |

- IDs de otros usuarios responden **404** (no 403) para no revelar su existencia. (A27)
- Una operación rechazada **no** deja efectos parciales (transacción única).

## 3. Secretos y configuración

| Regla | Detalle |
| --- | --- |
| Variables `EXPO_PUBLIC_*` | **Se incluyen en el paquete de la app y son extraíbles.** Solo pueden contener datos públicos (URL de la API, clave anónima pública de Supabase). **Nunca** claves de Gemini, de servicio ni de base de datos. |
| Claves de IA y de servicio | Solo en variables de entorno del servidor. |
| `.env` | Ignorado por git; el repositorio contiene un `.env.example` sin valores reales. |
| Rotación | Si alguna clave real estuvo alguna vez en el cliente o en un commit, **se rota**. |
| Entornos | Desarrollo y producción **separados**, con claves y bases distintas. No se usan datos reales hasta probar restauración y aislamiento. |
| Dependencias | `npm audit` en CI con lista de excepciones documentadas (ya existe en el frontend). |

## 4. Modelo de amenazas (resumen)

| Amenaza | Mitigación |
| --- | --- |
| Acceso a datos de otro usuario (IDOR) | Capas 1–3 de §2; pruebas A27 |
| Doble aplicación de un pago (reintento, dos dispositivos) | Clave de idempotencia, transacciones, bloqueo de filas, restricciones únicas (A22, A28) |
| Inyección de instrucciones en un correo/foto | Contenido tratado como dato; salida de IA acotada a un esquema; sin herramientas de IA con efectos |
| Fuga de la clave de Gemini | Solo en servidor; techo de uso; rotación |
| Exposición de comprobantes | Almacenamiento privado, URL firmadas de corta vida, sin enlaces públicos |
| Inyección SQL | Consultas parametrizadas siempre; validación de entrada con esquema |
| Manipulación del reloj del cliente | "Hoy" lo decide el servidor |
| Pérdida de datos | Respaldos, transacciones, reversiones sin borrado, pruebas de restauración |
| Datos sensibles en registros | Los *logs* no incluyen importes asociados a identidad, tokens ni cuerpos de correo |
| Abuso de la dirección de recepción | Rotación/revocación; límite de tasa; descarte de remitentes bloqueados |

## 5. Offline [C]

La decisión vigente sustituye a la anterior (cola de escrituras): **sin internet solo se consulta**.

| Regla | Detalle |
| --- | --- |
| RN-OF01 | Sin conexión se pueden **ver** los datos previamente cargados. **No** se registra, edita ni confirma nada; no hay cola de escrituras locales. |
| RN-OF02 | Se muestra **fecha de última actualización** y un indicador *sin conexión* para distinguir caché de datos actuales. |
| RN-OF03 | Al reconectar se **refrescan** los datos y se validan permisos y versiones antes de operar. |
| RN-OF04 | La caché guarda **solo** los datos del usuario autenticado y se **borra al cerrar sesión**. |
| RN-OF05 | **Pérdida de conexión durante una confirmación**: la app consulta el resultado por **ID/clave de idempotencia** antes de reintentar; nunca inventa una confirmación local ni duplica el movimiento. |
| RN-OF06 | Gemini, recepción de correo y generación de reportes/respaldos son operaciones **online**. |
| RN-OF07 | **Concurrencia online** (dos dispositivos o un reintento): idempotencia, transacciones y control de versión **permanecen** en la API. |

## 6. Respaldos (E5) [C salvo indicación]

| Regla | Detalle |
| --- | --- |
| RN-BK01 | Copias **recuperables automáticas** y un archivo **descargable/restaurable manualmente**. No son exportaciones (PDF/Excel/CSV). |
| RN-BK02 | **Contenido** seleccionable al generar; **configuración del automático** separada. Los originales se incluyen solo si se eligen y aún existen. |
| RN-BK03 | **Frecuencia** configurable (semanal, mensual u otra). Valor inicial propuesto: **semanal**. **[P D-26]** |
| RN-BK04 | **Retención** elegible: solo el último o los **dos** más recientes. Inicial propuesto: **dos**. La copia vigente **no se borra** hasta verificar que la nueva terminó bien. **[P D-26]** |
| RN-BK05 | **Manifiesto** con propietario, versión del formato/esquema, fecha, contenido y *hash* de integridad. Cifrado en reposo y verificación de integridad como medida técnica. |
| RN-BK06 | **Restaurar**: *reemplazo* con vista previa y copia de recuperación previa, o *incorporar faltantes* revisando coincidencias y conflictos. El usuario elige. |
| RN-BK07 | Restaurar **no** crea ingresos/gastos nuevos, **no** ejecuta pagos, **no** resucita pagos duplicados ni obligaciones ya revertidas sin revisión, y **no** borra datos actuales sin mecanismo de recuperación. (A26) |
| RN-BK08 | **Base y archivos** se respaldan por separado: la copia de la base no incluye archivos almacenados automáticamente. |
| RN-BK09 | Compatibilidad: un respaldo de un esquema antiguo se **migra** al restaurar; uno de un esquema más nuevo se **rechaza** con mensaje claro. |
| RN-BK10 | **Purga**: lo eliminado por retención puede persistir en copias antiguas hasta que se roten; se informa al usuario. |

## 7. Notificaciones y recordatorios [C]

- Contenido **discreto por defecto** ("Tienes cobros por revisar"); detalles financieros solo si se habilitan.
- Varios avisos configurables por **anticipación, repetición y horario**; horario silencioso configurable.
- **Recordatorios al administrador** de renovación y cobros pendientes.
- **Texto/estado de cuenta para compartir manualmente** con plantillas por servicio/contacto. Generar texto **no envía** mensajes; EVA no envía a terceros automáticamente.

## 8. Privacidad

- Se envía a la IA **solo** el contexto necesario y seleccionado por el usuario.
- El usuario puede **borrar** su cuenta y datos: se define el flujo (qué se elimina, qué se conserva por obligación) antes de abrir el acceso a terceros (E7). Los datos de contactos son de terceros: se tratan como confidenciales y se excluyen de cualquier exportación de otro usuario.
- Auditoría: `audit_event` registra autor, acción, entidad, momento y motivo **sin** copiar secretos ni correos completos.

## 9. Cómo quedó implementado (nov 2026)

| Tema | Implementación |
| --- | --- |
| Autenticación | Supabase Auth (correo y Google). La API valida el token con JWKS (ES256); en local, `AUTH_MODE=dev` |
| Sesión en el teléfono | `expo-secure-store` (sesión y perfil en caché) |
| Bloqueo local | PIN y huella opcionales |
| Archivos | Bucket privado `eva-originals` de Supabase Storage, accedido solo con la clave de servidor; originales borrados a los 90 días |
| Respaldos | Cifrados con `BACKUP_ENCRYPTION_KEY`; creación automática por la tarea diaria |
| Tarea diaria | `POST /jobs/daily` con `x-cron-secret`: respaldos, purga de originales, exportaciones vencidas (24 h) y cuentas marcadas para eliminar |
| Correo entrante | Firma Svix con ventana de 5 minutos; dirección por usuario, rotable; direcciones desconocidas se ignoran sin revelar nada |
| Inventario de secretos y rotación | [`../operacion/04-secretos-y-seguridad.md`](../operacion/04-secretos-y-seguridad.md) |
