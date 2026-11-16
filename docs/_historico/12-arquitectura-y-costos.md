# EVA — Arquitectura propuesta y costos

Revisión: 12 de octubre de 2026. Precios en USD, sujetos a cambios, impuestos y consumo. No se han contratado ni configurado servicios.

## Diseño recomendado

Android e iOS comparten Expo/React Native. Revisar frontend existente y reemplazar datos simulados por API; no reconstruir todo por defecto. Web posterior usa la misma identidad y API.

Supabase alojaría PostgreSQL, autenticación y documentos privados. Una API desplegable en Railway ejecutaría cargos, reparto, devoluciones, préstamos y correcciones dentro de transacciones. No crear otra base financiera en Railway. El móvil puede autenticarse con Supabase; las escrituras financieras pasan por servidor, que valida identidad y propietario incluso si usa una conexión privilegiada.

Módulos dentro de una API: cuentas, contactos, servicios, cobros/créditos, préstamos, tarjetas, planificación, captura e informes. No hacen falta microservicios al comienzo. Trabajos persistentes para renovación, captura y respaldo con reintentos e identificadores únicos; nunca ejecutan cobros bancarios.

Gemini propone y el usuario confirma; claves solo en servidor. Un fallo o límite de IA permite registro manual. Cálculos de cuotas, deuda y saldo no dependen de IA.

## Alternativas

| Alternativa | Base publicada | Utilidad y condiciones |
| --- | --- | --- |
| API local + Supabase Free | Supabase US$0 dentro de límites | Pruebas sin contratar Railway; dispositivo conectado a entorno de desarrollo |
| Solo Supabase Free | US$0 dentro de límites | Menos proveedores; adaptar negocio a funciones/transacciones y evaluar trabajos y límites |
| Supabase Free + Railway Hobby | Desde US$5/mes | API propia; consumo puede superar crédito incluido y base gratuita puede pausarse |
| Supabase Pro + Railway Hobby | Desde US$30/mes de suma base | Base pagada sin pausa por inactividad; no incluye cualquier consumo de IA/correo/recursos extra |

Supabase Free publica 500 MB de base y 1 GB de archivos; Pro parte de US$25/mes. [Precios oficiales](https://supabase.com/pricing). Free con poca actividad puede pausarse tras siete días. [Pausa](https://supabase.com/docs/guides/platform/free-project-pausing).

Railway Free ofrece US$1 de crédito mensual y la prueba US$5 por una vez, hasta 30 días. Hobby cuesta US$5/mes e incluye US$5 de recursos; consumir US$7 implica total US$7, no US$12. [Planes](https://docs.railway.com/pricing/plans), [prueba](https://docs.railway.com/pricing/free-trial).

Supabase recomienda exportaciones externas para proyectos Free. Un respaldo de base no incluye automáticamente archivos almacenados: EVA debe respaldarlos aparte si el usuario lo elige. [Respaldos](https://supabase.com/docs/guides/platform/backups).

## Gemini

«Gemini Pro» aún no confirma el nombre exacto del plan del creador. Google anuncia US$10 mensuales de créditos GenAI/Cloud para Google AI Pro; comprobar elegibilidad, activación y cuenta de facturación antes de presupuestarlos. No son API ilimitada. [Beneficios](https://developers.google.com/program/plans-and-pricing).

Gemini API tiene facturación propia. Créditos elegibles pueden aplicarse; según modalidad puede requerirse saldo prepago activo antes de usarlos. No se ha inspeccionado la cuenta del creador. [Condiciones](https://developers.google.com/profile/help/faq), [facturación API](https://ai.google.dev/gemini-api/docs/billing).

Medir documentos/análisis, tamaño de contexto y reintentos; registrar uso por tarea. Proponer techo mensual y aviso; al agotarlo detener nuevas tareas de IA y mantener registro manual. Elegir modelo/cuotas al implementar, sin inventar hoy una tarifa por comprobante.

## Puesta en uso

Separar desarrollo/producción, asegurar documentos privados y aislamiento, probar restauración/correcciones y medir costos antes de usar datos reales. Elegir correo entrante/saliente en captura; no asumir que está incluido. Evaluar distribución Android/iOS en su entrega.

Recomendación: probar local con PostgreSQL y aprovechar Free para validar. Railway/Supabase es razonable para API propia; confirmar presupuesto después de medir, antes de contratar.
