# -*- coding: utf-8 -*-
"""Las cuatro vistas del mapa, dibujadas con las primitivas de geom.py."""
import datos as D
from geom import Escena, ancho_texto, esc, leyenda, partir


# =====================================================================================================================
# 1) SISTEMA: qué piezas hay y cómo se hablan (arquitectura, con una zona)
# =====================================================================================================================
def vista_sistema() -> Escena:
    W, H = 1760, 1120
    e = Escena("sistema", "Mapa del sistema de EVA",
               "Cómo se conectan la app, la API en Render, Supabase, Google, Resend, Vercel, cron-job.org y Expo mientras EVA funciona.", W, H)
    n = D.NODOS

    # zona de Supabase (se dibuja primero)
    e.zona(860, 230, 380, 500, "Supabase · proyecto EVA")

    # ---- nodos --------------------------------------------------------------------------------------------------
    chips_api = ["216 rutas en /v1 (JWT)", "/jobs/daily (secreto)", "/healthz · /readyz", "7 secretos en Environment", "render.yaml (Blueprint)"]
    e.nodo("cron", 480, 110, 280, 84, n["cron"]["tipo"], n["cron"]["etiqueta"], n["cron"]["titulo"], n["cron"]["sub"])
    e.nodo("render", 480, 250, 280, 420, "focal", "API", n["render"]["titulo"], n["render"]["sub"], chips=chips_api)
    e.nodo("phone", 60, 250, 260, 120, "focal", "APP", n["phone"]["titulo"], n["phone"]["sub"])
    e.nodo("expo", 60, 470, 260, 84, n["expo"]["tipo"], n["expo"]["etiqueta"], n["expo"]["titulo"], n["expo"]["sub"])
    e.nodo("browser", 60, 790, 260, 84, n["browser"]["tipo"], n["browser"]["etiqueta"], n["browser"]["titulo"], n["browser"]["sub"])
    e.nodo("vercel", 60, 950, 260, 84, n["vercel"]["tipo"], n["vercel"]["etiqueta"], n["vercel"]["titulo"], n["vercel"]["sub"])
    e.nodo("auth", 900, 270, 260, 100, n["auth"]["tipo"], n["auth"]["etiqueta"], n["auth"]["titulo"], n["auth"]["sub"])
    e.nodo("db", 900, 430, 260, 100, n["db"]["tipo"], n["db"]["etiqueta"], n["db"]["titulo"], n["db"]["sub"])
    e.nodo("storage", 900, 590, 260, 100, n["storage"]["tipo"], n["storage"]["etiqueta"], n["storage"]["titulo"], n["storage"]["sub"])
    e.nodo("google", 1340, 270, 280, 100, n["google"]["tipo"], n["google"]["etiqueta"], n["google"]["titulo"], n["google"]["sub"])
    e.nodo("gemini", 900, 770, 260, 84, n["gemini"]["tipo"], n["gemini"]["etiqueta"], n["gemini"]["titulo"], n["gemini"]["sub"])
    e.nodo("resend", 1340, 880, 280, 100, n["resend"]["tipo"], n["resend"]["etiqueta"], n["resend"]["titulo"], n["resend"]["sub"])

    # ---- conectores ---------------------------------------------------------------------------------------------
    e.arista("phone", "render", [(320, 310), (480, 310)], "accent", "HTTPS · /v1")
    e.arista("phone", "auth", [(190, 250), (190, 52), (1100, 52), (1100, 270)], "link", "AUTH · HTTPS", seg=1)
    e.arista("expo", "phone", [(190, 470), (190, 370)], "muted", "OTA", lado="der", dash=True)
    e.arista("browser", "vercel", [(190, 874), (190, 950)], "link", "HTTPS", lado="der")
    e.arista("cron", "render", [(620, 194), (620, 250)], "muted", "POST /jobs", lado="der", dash=True)
    e.arista("render", "auth", [(760, 320), (900, 320)], "muted", "JWKS · ADMIN")
    e.arista("render", "db", [(760, 480), (900, 480)], "muted", "SQL · POOLER")
    e.arista("render", "storage", [(760, 640), (900, 640)], "muted", "REST · SECRETA")
    e.arista("render", "gemini", [(700, 670), (700, 812), (900, 812)], "link", "API KEY", seg=1)
    e.arista("render", "resend", [(620, 670), (620, 930), (1340, 930)], "link", "HTTPS · API", seg=1)
    e.arista("auth", "google", [(1160, 300), (1340, 300)], "link", "OAUTH")
    e.arista("auth", "resend", [(1160, 345), (1290, 345), (1290, 840), (1480, 840), (1480, 880)], "muted", "SMTP · 465", lado="der", seg=1, dash=True)

    leyenda(e, 1076, [("k-focal", "pieza principal"), ("k-backend", "servicio propio"), ("k-store", "datos"), ("k-external", "tercero"),
                      ("ar-accent", "ruta principal"), ("ar-link", "llamada HTTPS"), ("ar-muted", "interno"), ("ar-muted-dash", "programado / asíncrono")])
    return e


# =====================================================================================================================
# 2) FLUJOS: diagramas de secuencia
# =====================================================================================================================
MAPA_ACTOR = {"app": "phone", "auth": "auth", "api": "render", "db": "db", "storage": "storage", "gemini": "gemini", "resend": "resend",
              "google": "google", "cron": "cron", "web": "vercel", "eas": "expo"}
PRINCIPAL = ("api", "app", "eas")
TAG_ACTOR = {"app": "APP", "auth": "AUTH", "api": "API", "db": "BD", "storage": "FILES", "gemini": "IA", "resend": "MAIL", "mail": "CORREO",
             "google": "OAUTH", "cron": "CRON", "web": "WEB", "eas": "OTA", "pc": "PC", "nav": "WEB"}


def vista_flujo(f: dict) -> Escena:
    W = 1500
    margen = 60
    actores = f["actores"]
    n = len(actores)
    colw = (W - 2 * margen) / n
    cx = {a[0]: margen + colw * (i + 0.5) for i, a in enumerate(actores)}
    ids = [a[0] for a in actores]
    principal = next((p for p in PRINCIPAL if p in ids), actores[0][0])

    # primero se mide la altura
    filas = []
    y = 160
    for k, (de, a, txt, tipo) in enumerate(f["pasos"], 1):
        if de == a:
            disponible = (cx[actores[min(len(actores) - 1, [x[0] for x in actores].index(de) + 1)][0]] - cx[de] - 80) if de != actores[-1][0] else (cx[de] - cx[actores[-2][0]] - 80 if n > 1 else 400)
            disponible = max(disponible, 260)
            lineas = partir(txt, disponible, 11.5)
            alto = max(14 * len(lineas) + 26, 48)
            filas.append(dict(k=k, de=de, a=a, txt=txt, tipo=tipo, lineas=lineas, y=y, alto=alto, ay=y + 8))
        else:
            span = abs(cx[a] - cx[de])
            lineas = partir(txt, span - 28, 11.5)
            alto = 14 * len(lineas) + 38
            filas.append(dict(k=k, de=de, a=a, txt=txt, tipo=tipo, lineas=lineas, y=y, alto=alto, ay=y + 14 * len(lineas) + 16))
        y += alto
    y_fin = y + 10

    # notas
    notas = []
    ny = y_fin + 40
    for t in f.get("notas", []):
        lineas = partir(t, W - 2 * margen - 70, 12)
        notas.append((ny, lineas))
        ny += 14 * len(lineas) + 30
    H = int(ny + 90)

    e = Escena(f"flujo-{f['id']}", f["titulo"], f["resumen"], W, H)

    # lifelines y actores
    cuerpo = []
    for i, (aid, nombre, sub) in enumerate(actores):
        x = cx[aid]
        bw = min(220, colw - 40)
        cuerpo.append(f'<line class="vida" x1="{x:g}" y1="100" x2="{x:g}" y2="{y_fin}"/>')
        k = "focal" if aid == principal else "backend"
        e.nodo(aid, x - bw / 2, 36, bw, 64, k, TAG_ACTOR.get(aid, aid.upper()[:5]), nombre, sub, data_id=MAPA_ACTOR.get(aid, ""), tam_nombre=14, tam_sub=10)

    # mensajes
    for r in filas:
        x1, x2 = cx[r["de"]], cx[r["a"]]
        ay = r["ay"]
        tipo = r["tipo"]
        clase = {"call": "ar ar-link", "ret": "ar ar-muted dash", "async": "ar ar-muted dash", "self": "ar ar-muted"}[tipo]
        marker = "open" if tipo == "async" else ("link" if tipo == "call" else "muted")
        mk = f"url(#{e.slug}-{marker})"
        num = f'<g class="paso"><circle cx="30" cy="{ay:g}" r="11"/><text x="30" y="{ay + 4:g}" text-anchor="middle">{r["k"]}</text></g>'
        if r["de"] == r["a"]:
            lado = 1 if r["de"] != actores[-1][0] else -1
            x0 = x1
            ruta = f"M{x0:g} {ay:g} L{x0 + lado * 44:g} {ay:g} L{x0 + lado * 44:g} {ay + 22:g} L{x0:g} {ay + 22:g}"
            cuerpo.append(f'<path class="{clase}" d="{ruta}" marker-end="{mk}"/>')
            tx = x0 + lado * 58
            anchor = "start" if lado == 1 else "end"
            w_t = max(ancho_texto(l, 11.5) for l in r["lineas"]) + 12
            mx = tx - 6 if lado == 1 else tx - w_t + 6
            my = ay + 11 - (14 * len(r["lineas"])) / 2 - 3
            cuerpo.append(f'<rect class="lmask" x="{mx:g}" y="{my:g}" width="{w_t:g}" height="{14 * len(r["lineas"]) + 6}" rx="2"/>')
            for j, l in enumerate(r["lineas"]):
                cuerpo.append(f'<text class="msg" x="{tx:g}" y="{my + 14 + j * 14:g}" text-anchor="{anchor}">{esc(l)}</text>')
        else:
            cuerpo.append(f'<path class="{clase}" d="M{x1:g} {ay:g} L{x2:g} {ay:g}" marker-end="{mk}"/>')
            mid = (x1 + x2) / 2
            w_t = max(ancho_texto(l, 11.5) for l in r["lineas"]) + 12
            my = ay - 8 - 14 * len(r["lineas"]) - 2
            cuerpo.append(f'<rect class="lmask" x="{mid - w_t / 2:g}" y="{my:g}" width="{w_t:g}" height="{14 * len(r["lineas"]) + 4}" rx="2"/>')
            for j, l in enumerate(r["lineas"]):
                cuerpo.append(f'<text class="msg" x="{mid:g}" y="{my + 13 + j * 14:g}" text-anchor="middle">{esc(l)}</text>')
        cuerpo.append(num)

    # notas
    nt = []
    for (yy, lineas) in notas:
        alto = 14 * len(lineas) + 20
        nt.append(f'<g class="nota"><rect x="{margen}" y="{yy - 14}" width="{W - 2 * margen}" height="{alto}" rx="6"/>'
                  f'<text class="eyebrow" x="{margen + 14}" y="{yy + 1}">NOTA</text>')
        for j, l in enumerate(lineas):
            nt.append(f'<text class="msg" x="{margen + 70}" y="{yy + 1 + j * 14}">{esc(l)}</text>')
        nt.append("</g>")

    # las vidas y mensajes van DEBAJO de los actores (los nodos se pintan después)
    e.extras_antes = "".join(cuerpo)
    e.extras.append("".join(nt))
    leyenda(e, H - 36, [("ar-link", "llamada"), ("ar-muted-dash", "respuesta"), ("ar-muted-dash-open", "correo o aviso asíncrono"), ("k-focal", "pieza principal")])
    return e


# =====================================================================================================================
# 3) INVENTARIO: una tarjeta por cuenta/proveedor
# =====================================================================================================================
BADGE = {D.PUBLICO: ("b-pub", "PÚBLICO"), D.SECRETO: ("b-sec", "SECRETO"), D.LOCAL: ("b-loc", "LOCAL")}


def vista_inventario() -> Escena:
    W = 1760
    margen, gap, cw = 60, 40, 520
    cols = [margen + i * (cw + gap) for i in range(3)]
    altos = [90.0, 90.0, 90.0]
    tarjetas = []
    for t in D.INVENTARIO:
        filas = []
        h = 66.0
        for nombre, valor, nivel in t["items"]:
            env = "_" in nombre or nombre.isupper()
            nl = partir(nombre, 182, 10.5 if env else 12.5, env)
            vl = partir(valor, 208, 11, True)
            alto = max(len(nl), len(vl)) * 15 + 20
            filas.append((nl, vl, nivel, h, alto, env))
            h += alto
        h += 12
        c = altos.index(min(altos))
        tarjetas.append((t, filas, cols[c], altos[c], h))
        altos[c] += h + 28
    H = int(max(altos) + 90)
    e = Escena("inventario", "Cuentas, direcciones y variables de EVA",
               "Una tarjeta por servicio con lo que contiene, dónde vive y qué es público o secreto.", W, H)
    kinds = {"externo": "external", "focal": "focal", "store": "store", "optional": "optional", "input": "input"}
    for t, filas, x, y, h in tarjetas:
        k = kinds.get(t["color"], "external")
        out = [f'<g class="tarjeta nodo k-{k}" data-id="" data-card="{esc(t["id"])}">',
               f'<rect class="mask" x="{x}" y="{y}" width="{cw}" height="{h:g}" rx="8"/>',
               f'<rect class="caja" x="{x}" y="{y}" width="{cw}" height="{h:g}" rx="8"/>',
               f'<text class="nombre" x="{x + 18}" y="{y + 30}" font-size="17">{esc(t["titulo"])}</text>',
               f'<text class="sub" x="{x + 18}" y="{y + 48}" font-size="11">{esc(t["sub"])}</text>']
        for nl, vl, nivel, fy, alto, env in filas:
            ry = y + fy
            out.append(f'<line class="lrule" x1="{x + 14}" y1="{ry:g}" x2="{x + cw - 14}" y2="{ry:g}"/>')
            for j, l in enumerate(nl):
                out.append(f'<text class="fila-n{" env" if env else ""}" x="{x + 18}" y="{ry + 18 + j * 15:g}">{esc(l)}</text>')
            for j, l in enumerate(vl):
                out.append(f'<text class="fila-v" x="{x + 214}" y="{ry + 18 + j * 15:g}">{esc(l)}</text>')
            cls, txt = BADGE[nivel]
            out.append(f'<rect class="badge {cls}" x="{x + cw - 14 - 58}" y="{ry + 7:g}" width="58" height="15" rx="3"/>'
                       f'<text class="badge-t {cls}" x="{x + cw - 14 - 29}" y="{ry + 18:g}" text-anchor="middle">{txt}</text>')
        out.append("</g>")
        e.nodos_svg.append("".join(out))
        e.cajas[t["id"]] = (x, y, cw, h)
    # el valor de los badges ya ocupa su columna: el texto de valor se limita a 208px (arriba)
    leyenda(e, H - 36, [("b-pub", "PÚBLICO|va en la app o el código"), ("b-sec", "SECRETO|solo en el panel del servicio"), ("b-loc", "LOCAL|solo en tu PC o teléfono")])
    return e


# =====================================================================================================================
# 4) PUBLICACIÓN: cómo viaja cada tipo de cambio hasta el usuario
# =====================================================================================================================
QUIEN = {"tu": ("input", "TÚ"), "git": ("external", "GIT"), "nube": ("backend", "NUBE"), "tel": ("store", "APP")}


def vista_publicacion() -> Escena:
    W = 1760
    fil_h = 156
    top = 90
    H = top + len(D.PUBLICACION) * fil_h + 100
    e = Escena("publicacion", "Cómo llega un cambio al usuario",
               "Cinco caminos: servidor, base de datos, web, código de la app por internet y cambios nativos con un APK nuevo.", W, H)
    bw, bh, gap, x0 = 220, 92, 44, 420
    for i, fila in enumerate(D.PUBLICACION):
        y = top + i * fil_h
        yc = y + 30
        e.extras.append(f'<line class="lrule" x1="40" y1="{y - 12}" x2="{W - 40}" y2="{y - 12}"/>')
        e.extras.append(f'<text class="nombre fila-t" x="40" y="{yc + 6}" font-size="16">{esc(fila["titulo"])}</text>')
        e.extras.append(f'<text class="sub" x="40" y="{yc + 24}" font-size="11">{esc(fila["sub"])}</text>')
        for j, l in enumerate(partir("Llega: " + fila["llegada"], 330, 11.5)):
            e.extras.append(f'<text class="llega" x="40" y="{yc + 52 + j * 15}" font-size="11.5">{esc(l)}</text>')
        prev = None
        for j, (tit, sub, q) in enumerate(fila["pasos"]):
            x = x0 + j * (bw + gap)
            nid = f"{fila['id']}-{j}"
            kind, tag = QUIEN[q]
            if prev:
                e.arista(prev, nid, [(x - gap, yc + bh / 2 - 8), (x, yc + bh / 2 - 8)], "muted", None)
            e.nodo(nid, x, yc - 14, bw, bh, kind, tag, tit, sub, data_id=nid, tam_nombre=13, tam_sub=10)
            prev = nid
    leyenda(e, H - 36, [("k-input", "lo haces tú"), ("k-external", "GitHub"), ("k-backend", "servicio en la nube"), ("k-store", "llega al teléfono o a la web"),
                        ("ar-muted", "siguiente paso")])
    return e
