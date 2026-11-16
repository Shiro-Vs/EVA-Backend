# EVA — Acceso, offline y respaldos

Actualizado el 11 de octubre de 2026. Confirmado por el creador; políticas concretas e implementación pendientes.

## 1. Acceso y bloqueo

Google y correo/contraseña. PIN y biometría configurables, incluyendo frecuencia de bloqueo. Definir recuperación, sesión expirada y dispositivos autorizados. El bloqueo local no reemplaza autenticación/autorización del backend.

No guardar contraseñas/PIN en texto plano, credenciales de IA en cliente, ni CVV/claves bancarias para el seguimiento de tarjetas. Diseño de almacenamiento protegido y recuperación se elige al implementar, sin prometer funciones de hardware no verificadas.

## 2. Consulta sin conexión — decisión vigente

El creador revisó su elección: sin internet solo consultar datos previamente cargados; al recuperar conexión se permite registrar, editar y confirmar. No registrar movimientos locales, preparar nuevas escrituras ni sincronizar una cola de operaciones offline en el alcance actual.

Mostrar fecha de última actualización y estado sin conexión para distinguir caché de datos actuales. Bloqueo local permanece; primer login y acceso remoto requieren conexión. Al reconectar, refrescar datos y validar permisos/versiones antes de confirmar.

Internet no elimina concurrencia: dos dispositivos o un reintento pueden intentar aplicar el mismo pago. Conservar idempotencia, transacciones y control de versión en API. Si se pierde conexión durante confirmación, consultar resultado por ID antes de reintentar; no inventar una confirmación local ni duplicar movimiento.

Gemini, recepción/procesamiento remoto de correo y generación de nuevos reportes/respaldos se tratan como operaciones online. Alcance exacto de documentos ya descargados y sesión expirada offline pendiente de diseño técnico, sin ampliar por inferencia el modo lectura.

## 3. Respaldos

Confirmado: copias recuperables automáticas y archivo descargable/restaurable manualmente. No confundir con exportación PDF/Excel/CSV.

Confirmado: restaurar por reemplazo con vista previa y copia de recuperación, o incorporar faltantes revisando coincidencias/conflictos; usuario elige. Contenido seleccionable al generar y configuración separada para respaldo automático, incluidos originales si se eligen y aún existen.

Confirmado: frecuencia automática configurable (ejemplos semanal/mensual) y retención configurable, conservando solo último respaldo o dos más recientes. No borrar copia vigente antes de verificar que la nueva terminó correctamente. Definir calendario/cantidad elegidos en configuración, no asumir que semanal es obligatorio.

Diseñar manifiesto con propietario, versión de formato/esquema, fecha y contenido. Cifrado e integridad como propuesta técnica. Incorporación/reemplazo no ejecuta pagos nuevos ni revive obligaciones ya revertidas sin revisión.

Restaurar no registra ingresos/gastos nuevos ni resucita pagos duplicados. No borrar datos actuales sin mecanismo de recuperación/revisión. Archivo/documento eliminado por retención puede persistir en copias antiguas: definir qué garantiza retención y cómo se purgan respaldos.

## 4. Notificaciones y cobros compartibles

Confirmado: contenido configurable, aviso discreto por defecto. Detalles financieros solo si se habilitan. Avisos de bandeja, presupuestos, vencimientos y metas con preferencias todavía por cerrar.

Confirmado: recordar al administrador y preparar texto/estado de cuenta para compartir manualmente, con plantillas por servicio/contacto. Generar texto no envía mensaje; no integrar envío automático a terceros por inferencia. Compartir documento/texto ocurre por acción del usuario.

Confirmado: varios avisos con anticipación, repetición y horario configurables. Umbral de días gratis tiene predeterminado definido por usuario y excepciones por servicio/participante. Horario silencioso, canales y números iniciales se definirán en configuración.

## 5. Decisiones pendientes

- Caché de lectura, frescura y acceso con sesión expirada.
- Concurrencia/reintentos online y pérdida de conexión durante una confirmación.
- Detalle de incorporación de respaldos, verificación y políticas de archivos.
- Parámetros iniciales de frecuencia/retención y recuperación de acceso.
- PIN/biometría predeterminados y tiempo de bloqueo.
- Avisos de vencimiento, horarios y valores iniciales de reglas de servicio.
