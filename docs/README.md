# EVA — Documentación

EVA es una app para repartir suscripciones compartidas y llevar finanzas personales, pensada primero para Android. Está **en producción** para uso personal y de amigos. Esta carpeta es la única documentación vigente del proyecto.

> Última revisión: 17 de noviembre de 2026.

## Dónde empezar

| Si quieres… | Abre |
| --- | --- |
| **Ver todo el sistema de un vistazo** (servicios, flujos, cuentas, entornos, datos, estados, navegación, plan) | [`mapa-eva.html`](mapa-eva.html) — mapa interactivo con zoom |
| **Saber qué falta o qué se quiere añadir** | [`PENDIENTES.md`](PENDIENTES.md) — archivo vivo |
| **Entender qué hace EVA y por qué** (reglas, decisiones, pruebas) | [`especificacion/`](especificacion/00-README.md) |
| **Trabajar en el código o publicar** | [`operacion/`](operacion/) |

## Estructura

```
docs/
├── README.md                  este índice
├── PENDIENTES.md              lo que falta y las ideas nuevas (se edita siempre)
├── mapa-eva.html              mapa interactivo (generado; no se edita a mano)
├── mapa/                      fuente del mapa (datos.py) y generador
├── especificacion/            QUÉ construir y POR QUÉ (00–17 + prototipo)
├── operacion/                 CÓMO se desarrolla, se publica y se mantiene
└── _historico/                definición original; solo consulta
```

## Operación (cómo funciona hoy)

| Documento | Contenido |
| --- | --- |
| [01 · Guía de desarrollo](operacion/01-guia-de-desarrollo.md) | Entorno, comandos, estructura del código, convenciones, lista previa a subir cambios |
| [02 · Despliegue y publicación](operacion/02-despliegue-y-publicacion.md) | Render, Supabase, Vercel, EAS Update y APK, DNS, tarea diaria, reversión |
| [03 · Integraciones](operacion/03-integraciones.md) | Cada servicio externo: para qué, configuración, límites, correo entrante |
| [04 · Secretos y seguridad](operacion/04-secretos-y-seguridad.md) | Inventario de secretos, rotación, protecciones, privacidad |
| [05 · Mantenimiento y problemas](operacion/05-mantenimiento-y-problemas.md) | Rutinas, límites de planes, respaldos, solución de problemas |
| [06 · Plantillas de correo](operacion/06-plantillas-de-correo.md) | Correos de Supabase Auth en español |

## Especificación (qué y por qué)

Entrada: [`especificacion/00-README.md`](especificacion/00-README.md). Fuente de verdad del producto: reglas numeradas `RN-xxx`, algoritmos, SQL, contrato de API, decisiones `D-xx` y casos de prueba `A01–A28`. Si el código y la especificación discrepan, se corrige uno de los dos **en el mismo cambio**.

## Histórico

[`_historico/`](_historico/) conserva la definición original (documentos 01–14, el diagrama de arquitectura y el cronograma antiguos, y las plantillas de correo anteriores). No se mantiene: sirve para saber *por qué* se decidió algo.

## Cómo mantener esta documentación

1. **Una idea nueva o algo que falta** → fila en [`PENDIENTES.md`](PENDIENTES.md).
2. **Cambia una regla del producto** → decisión en `especificacion/10-decisiones.md` y la regla, el SQL, la API y la prueba afectados.
3. **Cambia la infraestructura** (servicio, variable, dominio, flujo) → `operacion/` y `mapa/datos.py`, y regenerar el mapa:

   ```bash
   python docs/mapa/generar_mapa.py
   ```

4. **Nunca** se escriben valores secretos en estos archivos, solo sus nombres.
5. Esta carpeta vive en `EVA-Backend/docs` y se versiona con el repositorio privado del backend: commitea los cambios de documentación junto con los de código. Copia previa a la reorganización: `_respaldo-docs-2026-11-17.zip` (raíz de `D:\Proyectos\EVA`).
