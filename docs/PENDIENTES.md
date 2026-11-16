# Pendientes y mejoras de EVA

Archivo **vivo**: aquí se anota todo lo que falta o se quiere añadir al proyecto. Se edita a mano en cada sesión de trabajo. El tablero del [mapa](mapa-eva.html) (pestaña «Qué falta») se genera leyendo las tablas de este archivo.

**Cómo usarlo**

- Cada fila tiene un **ID** fijo (`P-01`…); nunca se reutiliza.
- **Prioridad:** `Alta` (bloquea o es lo siguiente), `Media`, `Baja`.
- **Estado:** `Por hacer` · `En curso` · `Esperando` (depende de algo externo) · `Hecho`.
- Al terminar algo: cambiar el estado a `Hecho` y anotar la fecha en «Hecho recientemente». Cuando la lista de hechos crezca, mover lo viejo a `_historico/`.
- Si una idea cambia una regla del producto, añadirla también a [`especificacion/10-decisiones.md`](especificacion/10-decisiones.md).

> Última actualización: 17 de noviembre de 2026.

---

## 1. Siguiente paso

| ID | Qué | Prioridad | Estado |
| --- | --- | --- | --- |
| P-01 | **Captura por correo:** activar la recepción (Resend, DNS, Render) y probar con un correo real. El código ya está listo | Alta | Esperando |
| P-02 | Probar en el APK: notificaciones, PIN y huella, Sugerencias y la hoja de cuentas de Google | Alta | Por hacer |

## 2. Configuración que depende del dueño

Pasos detallados en [`operacion/03-integraciones.md` §5](operacion/03-integraciones.md).

| ID | Qué | Prioridad | Estado |
| --- | --- | --- | --- |
| P-03 | Resend: añadir dominio `in.eva-app.lat` con Receiving y copiar el MX | Alta | Esperando |
| P-04 | Spaceship: crear el registro MX del host `in` | Alta | Esperando |
| P-05 | Resend: webhook a `https://api.eva-app.lat/webhooks/resend` (evento `email.received`) | Alta | Esperando |
| P-06 | Resend: clave con acceso completo; en Render, `RESEND_RECEIVE_KEY` y `RESEND_WEBHOOK_SECRET` | Alta | Esperando |
| P-07 | Guardar `BACKUP_ENCRYPTION_KEY` también en el gestor de contraseñas | Alta | Por hacer |
| P-08 | Activar verificación en dos pasos en GitHub, Render, Supabase, Expo y Spaceship | Media | Por hacer |

## 3. Producto

| ID | Qué | Prioridad | Estado |
| --- | --- | --- | --- |
| P-09 | **Entrega 7:** movimientos en dólares y tipo de cambio (D-xx por definir) | Media | Por hacer |
| P-10 | Dar acceso a amigos (APK directo) y recoger sugerencias reales de uso | Media | Por hacer |
| P-11 | Reglas por remitente en Captura (aprender de las correcciones del usuario) | Baja | Por hacer |
| P-12 | Pasar correos y sitio web a la **Paleta 1 · Pizarra** (hoy conservan el violeta) | Media | Por hacer |
| P-13 | Lista de sesiones abiertas y cierre remoto de sesión | Baja | Por hacer |

## 4. Pulido de pantallas

| ID | Qué | Prioridad | Estado |
| --- | --- | --- | --- |
| P-14 | Detalle de cuenta | Media | Por hacer |
| P-15 | Nueva operación (formulario más compacto) | Media | Por hacer |
| P-16 | Préstamos | Media | Por hacer |
| P-17 | Plan (planificación) | Baja | Por hacer |
| P-18 | Resto de formularios: selectores, calendarios, botones uniformes | Baja | Por hacer |

## 5. Técnica y operación

| ID | Qué | Prioridad | Estado |
| --- | --- | --- | --- |
| P-19 | Probar una restauración completa de respaldo y rutinizar un `pg_dump` fuera de Supabase | Alta | Por hacer |
| P-20 | Publicar en **Google Play** (firma, ficha, política de datos, pruebas cerradas) | Media | Por hacer |
| P-21 | Decidir planes de pago: Render (sin dormir), Supabase (sin pausa), Resend | Media | Por hacer |
| P-22 | Monitoreo: aviso cuando la API o la tarea diaria fallen | Media | Por hacer |
| P-23 | Pasar `docs/` a un repositorio git privado (hecho: ahora vive en `EVA-Backend/docs`) | Media | Hecho |
| P-24 | Revisar excepciones de auditoría de dependencias (fecha límite 16‑feb‑2027) | Baja | Por hacer |
| P-25 | Actualizar a la siguiente versión de Expo SDK | Baja | Por hacer |
| P-26 | Fuente Asap embebida en el mapa de documentación | Baja | Por hacer |

## 6. Ideas (sin compromiso)

| ID | Qué | Prioridad | Estado |
| --- | --- | --- | --- |
| P-27 | Captura desde capturas de pantalla compartidas al abrir EVA («Compartir con EVA») | Baja | Por hacer |
| P-28 | Widget de saldo y próximos cobros | Baja | Por hacer |
| P-29 | Versión iOS | Baja | Por hacer |
| P-30 | Más de un idioma o moneda base | Baja | Por hacer |

## 7. Hecho recientemente

| ID | Qué | Prioridad | Estado |
| --- | --- | --- | --- |
| P-31 | Producción completa: Supabase, Render, Vercel, Resend, dominio y tarea diaria (nov 2026) | Alta | Hecho |
| P-32 | Inicio de sesión con Google nativo y por navegador | Alta | Hecho |
| P-33 | Sugerencias dentro de la app con correo con formato | Media | Hecho |
| P-34 | Actualizaciones por internet (EAS Update) y APK 1.0.2 | Alta | Hecho |
| P-35 | Código de captura por correo entrante con firma Svix, adjuntos y deduplicación | Alta | Hecho |
| P-36 | Limpieza de ramas, archivos obsoletos y auditoría del CI | Media | Hecho |
| P-37 | Reorganización de la documentación y mapa interactivo | Media | Hecho |
