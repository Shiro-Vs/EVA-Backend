# -*- coding: utf-8 -*-
"""Genera docs/mapa-eva.html: un mapa interactivo (zoom, arrastre y detalle por pieza) de todo EVA.

Uso:   python docs/mapa/generar_mapa.py
Edita el contenido en docs/mapa/datos.py (qué es cada pieza, variables, flujos) y vuelve a ejecutarlo.
"""
import datetime
import json
import os
import sys

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)

import datos as D  # noqa: E402
from geom import esc  # noqa: E402
from vistas import MAPA_ACTOR, vista_flujo, vista_inventario, vista_publicacion, vista_sistema  # noqa: E402
import vistas2 as V2  # noqa: E402


def construir_datos(flujos_escena):
    nodos = {}
    for k, n in D.NODOS.items():
        nodos[k] = {key: n.get(key) for key in ("titulo", "etiqueta", "sub", "tipo", "resumen", "donde", "datos", "vars", "guardado", "notas")}
    conexiones = [{"de": a, "a": b, "etiqueta": t, "texto": x} for a, b, t, x in D.CONEXIONES]
    flujos = []
    for f in D.FLUJOS:
        nombres = {a[0]: a[1] for a in f["actores"]}
        flujos.append({
            "id": f["id"], "titulo": f["titulo"], "resumen": f["resumen"], "notas": f.get("notas", []),
            "actores": [{"id": a[0], "nombre": a[1], "sub": a[2], "nodo": MAPA_ACTOR.get(a[0], "")} for a in f["actores"]],
            "pasos": [{"n": i + 1, "de": nombres[p[0]], "a": nombres[p[1]], "txt": p[2], "tipo": p[3]} for i, p in enumerate(f["pasos"])],
        })
    pasos = {}
    quien = {"tu": "Lo haces tú, en tu PC", "git": "GitHub", "nube": "Servicio en la nube", "tel": "Llega al teléfono o a la web"}
    for fila in D.PUBLICACION:
        for j, (tit, sub, q) in enumerate(fila["pasos"]):
            pasos[f"{fila['id']}-{j}"] = {"titulo": tit, "sub": sub, "quien": quien[q], "camino": fila["titulo"], "llegada": fila["llegada"], "n": j + 1, "de": len(fila["pasos"])}
    inventario = {t["id"]: {"titulo": t["titulo"], "sub": t["sub"], "items": t["items"]} for t in D.INVENTARIO}
    publicacion = [{"id": f["id"], "titulo": f["titulo"], "sub": f["sub"], "llegada": f["llegada"]} for f in D.PUBLICACION]
    return {"nodos": nodos, "conexiones": conexiones, "flujos": flujos, "pasos": pasos, "inventario": inventario, "publicacion": publicacion}


DISENOS = [
    ("capas", "Capas del backend", "Cómo se organiza el código de la API.", V2.vista_capas),
    ("entornos", "Local y producción", "Qué corre en tu PC y qué corre en la nube.", V2.vista_entornos),
    ("datos", "Datos por dominios", "Las tablas de la base agrupadas por tema.", V2.vista_datos),
    ("ciclos", "Ciclos de vida", "Los estados de cada objeto importante.", V2.vista_ciclos),
    ("navegacion", "Navegación de la app", "Las pantallas por pestaña.", V2.vista_navegacion),
    ("confianza", "Zonas de confianza", "Qué vive en cada zona y dónde están los secretos.", V2.vista_confianza),
    ("ruta", "Hoja de ruta", "Entregas construidas y por venir.", V2.vista_ruta),
]


def main():
    sistema = vista_sistema()
    flujos = [vista_flujo(f) for f in D.FLUJOS]
    inventario = vista_inventario()
    publicacion = vista_publicacion()
    disenos = [(i, t, r, fn()) for i, t, r, fn in DISENOS]
    items = V2.leer_pendientes()
    tablero, det_pend = V2.vista_pendientes(items)
    escenas = [sistema, *flujos, inventario, publicacion, *[d[3][0] for d in disenos], tablero]
    for e in escenas:
        e.validar()
    avisos = [a for e in escenas for a in e.avisos]

    data = construir_datos(flujos)
    data["disenos"] = [{"id": i, "titulo": t, "resumen": r, "det": d[1]} for i, t, r, d in disenos]
    data["pendientes"] = det_pend
    vistas = {
        "sistema": sistema.svg(),
        "flujos": "".join(f'<div class="flujo" data-flujo="{esc(f["id"])}" hidden>{e.svg()}</div>' for f, e in zip(D.FLUJOS, flujos)),
        "inventario": inventario.svg(),
        "publicacion": publicacion.svg(),
        "diseno": "".join(f'<div class="diseno" data-diseno="{esc(i)}" hidden>{d[0].svg()}</div>' for i, t, r, d in disenos),
        "pendientes": tablero.svg(),
    }
    opc_diseno = "".join(f'<option value="{esc(i)}">{esc(t)}</option>' for i, t, r, d in disenos)
    opciones = "".join(f'<option value="{esc(f["id"])}">{i + 1}. {esc(f["titulo"])}</option>' for i, f in enumerate(D.FLUJOS))
    hoy = datetime.date.today().strftime("%d/%m/%Y")

    plantilla = open(os.path.join(AQUI, "plantilla.html"), encoding="utf8").read()
    html = (plantilla
            .replace("%%OPCIONES%%", opciones)
            .replace("%%V_SISTEMA%%", vistas["sistema"])
            .replace("%%V_FLUJOS%%", vistas["flujos"])
            .replace("%%V_INVENTARIO%%", vistas["inventario"])
            .replace("%%V_PUBLICACION%%", vistas["publicacion"])
            .replace("%%V_DISENO%%", vistas["diseno"])
            .replace("%%V_PENDIENTES%%", vistas["pendientes"])
            .replace("%%OPC_DISENO%%", opc_diseno)
            .replace("%%FECHA%%", hoy)
            .replace("%%DATA%%", json.dumps(data, ensure_ascii=False).replace("</", "<\\/")))
    salida = os.path.join(os.path.dirname(AQUI), "mapa-eva.html")
    with open(salida, "w", encoding="utf8") as f:
        f.write(html)

    print(f"mapa-eva.html: {os.path.getsize(salida) / 1024:.0f} KB · {len(escenas)} diagramas")
    if avisos:
        print(f"\n{len(avisos)} avisos de geometría:")
        for a in avisos:
            print("  -", a)
        sys.exit(1)
    print("geometría sin avisos")


if __name__ == "__main__":
    main()
