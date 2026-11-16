# EVA — Decisiones vigentes

Actualizado: 12 de octubre de 2026. Las respuestas posteriores sustituyen interpretaciones anteriores. El documento 05 conserva el historial de preguntas.

## Confirmado por el creador

| Área | Decisión |
| --- | --- |
| Usuario y plataformas | Uso personal primero, amigos quizá después; contactos sin login. Android primero, iOS previsto y web después |
| Inicio | Datos nuevos, sin importar Excel; saldos/deudas reales de apertura |
| Primera prueba | Cuentas, contactos, servicios, plazas, cuotas, pagos parciales y anticipos |
| Servicios | Personales/compartidos; varias plazas por contacto con cuotas individuales y detalle |
| Precio | Anunciado y pago real separados; cuota manual con sugerencia entera hacia arriba |
| Calendario | Inicio, intervalo configurable y siguiente pago informado; cambios con historial. Pago tardío no mueve renovación |
| Gracia/reactivación | Gracia gratis, suspensión sin descuento; mover fechas sin cobrar días adicionales al cambiar renovación |
| Incorporación | Hasta umbral, tramo gratis; por encima, todos los días restantes cobrables |
| Cálculo | Cuota normal por ciclo; prorrateo mensual /30, semanal /7, anual según días del año |
| Precisión | Dos decimales; cálculos hacia arriba al centavo, sugerencias/prorrateos de suscripción a entero; pagos reales exactos |
| Cobros | Un ingreso real, aplicaciones manuales múltiples; parciales y varios ciclos juntos |
| Anticipos | Solo participantes; sobrante a próxima cuota por defecto, trasladable; no garantiza precio |
| Cambio de cuota | Próximo ciclo; diferencias de anticipos por renovación o juntas, a elección |
| Regalos | Por ciclos, hasta fecha o permanentes; deuda anterior conservada o convertida en préstamo |
| Baja | Ciclo pagado al proveedor se termina; devolver futuros. Sin pago al proveedor, baja temprana según días usados y límite configurable |
| Retirada/cambio a individual | Deudas a préstamo con origen detallado; reingreso nuevo. Cambio a individual en próximo corte, devolución de anticipos futuros |
| Préstamos | Otorgados/recibidos, personales/bancarios; sin interés, fijo o porcentaje configurable; datos bancarios confirmados |
| Abonos/intereses | Selección manual; capital primero dentro de cuota, configurable. Capitalización solo solicitada/confirmada manualmente |
| Crédito | Cuenta de crédito con estados/consumos/cuotas; pagar tarjeta no repite gasto |
| Finanzas | Cuentas, categorías, presupuestos, metas, recurrencias y conciliación |
| Presupuesto de servicios | Pagos/cobros reales, por ciclo o caja; comparación con previsto |
| Captura e IA | Correo, foto, PDF y manual; siempre confirmar, individual o lote. IA extrae/clasifica/analiza datos seleccionados |
| Reportes/exportación | Mensual vivo y versiones guardadas; flujo y resultado diferenciados. Móvil PDF, web CSV/Excel/PDF y gráficos/detalle |
| Moneda | PEN inicial, USD y conversión después |
| Acceso/offline | Google/correo, PIN y biometría configurables. Offline solo consulta; escritura con internet |
| Respaldos | Manuales/automáticos, frecuencia y retención configurables; restauración revisada |

## Propuestas técnicas

PostgreSQL, migraciones versionadas y API común móvil/web. Reutilizar Expo/React Native tras revisar el trabajo existente. Supabase para base, identidad y archivos; API desplegable en Railway, comparada con alternativa de solo Supabase en 12. Dinero separado de aplicaciones; correcciones/reversiones con historia. Propietario y autorización en cada operación, calendario idempotente, aritmética decimal y claves de Gemini solo en servidor.

No implican contratación ni esquema físico ya aprobado. Índices, transacciones y paginación se resuelven durante diseño técnico sin encuestar cada detalle.

## Puntos para revisar con ejemplos

| Punto | Propuesta a revisar | Momento |
| --- | --- | --- |
| Sugerencia de cuota | Dividir entre plazas ocupadas, incluida la del administrador | Alta de servicio |
| Igualdad al límite de baja | Terminar ciclo cuando días usados >= límite | Antes de implementar bajas |
| Prorrateo personalizado | Días del ciclo explícito para intervalos sin base estándar | Diseño de frecuencia |
| Renovación día 29/30/31 | Último día disponible, conservando ancla original | Diseño de calendario |
| Renovación adelantada | Vista previa, sin doble cuota por cobertura coincidente | Validación de calendario |
| Tramo inicial excepcional largo | Revisar límite con ejemplo; no limitar ni exceder cuota silenciosamente | Prorrateo inicial |
| Lote de captura | Cada propuesta atómica; informe de aceptadas/fallidas | Captura |
| Documentos | Plazo elegible; explicar originales incluidos en respaldos | Archivos |
| Costos | Techo mensual y créditos realmente habilitados | Antes de contratar |
| Gráfico aislado | PDF confirmado; PNG/SVG por evaluar | Web |

Cuotas, días gratis y frecuencia de respaldo se eligen en la configuración; no necesitan un valor universal ahora. Próximo trabajo: esquema físico y contratos del núcleo según 13 y escenarios de 14, después conectar Android. El Prisma anterior se conserva durante planificación.
