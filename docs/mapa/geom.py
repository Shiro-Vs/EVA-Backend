# -*- coding: utf-8 -*-
"""Primitivas SVG del skill diagram-design aplicadas a EVA: nodos, zonas, conectores ortogonales con esquinas
redondeadas, etiquetas con máscara y un validador de geometría (sin diagonales, sin atravesar nodos, sin cruces)."""
import html
import math

R = 8  # radio de las esquinas de los conectores


def esc(s) -> str:
    return html.escape(str(s), quote=True)


def ancho_texto(texto: str, tam: float, mono: bool = False, bold: bool = False) -> float:
    """Presupuesto de ancho del skill: 0.60em sans (0.62em mono) por carácter; los anchos de Unicode cuestan 1em."""
    t = 0.0
    for ch in texto:
        if ord(ch) > 0x2E7F:
            t += 1.0
        else:
            t += 0.62 if mono else (0.60 if not bold else 0.62)
    return t * tam


def partir(texto: str, max_px: float, tam: float, mono: bool = False) -> list[str]:
    """Parte un texto en líneas que caben en max_px: por palabras y, si una palabra sola no cabe (una URL), por caracteres."""
    por_linea = max(4, int(max_px / (tam * (0.62 if mono else 0.60))))
    palabras = []
    for p in texto.split(" "):
        while ancho_texto(p, tam, mono) > max_px and len(p) > por_linea:
            palabras.append(p[:por_linea])
            p = p[por_linea:]
        palabras.append(p)
    lineas, actual = [], ""
    for p in palabras:
        prueba = (actual + " " + p).strip()
        if ancho_texto(prueba, tam, mono) <= max_px or not actual:
            actual = prueba
        else:
            lineas.append(actual)
            actual = p
    if actual:
        lineas.append(actual)
    return lineas


def _sgn(v: float) -> int:
    return (v > 0) - (v < 0)


def ruta_redondeada(pts: list[tuple[float, float]], r: float = R) -> str:
    d = f"M{pts[0][0]:g} {pts[0][1]:g}"
    for i in range(1, len(pts) - 1):
        p0, p1, p2 = pts[i - 1], pts[i], pts[i + 1]
        d1 = (_sgn(p1[0] - p0[0]), _sgn(p1[1] - p0[1]))
        d2 = (_sgn(p2[0] - p1[0]), _sgn(p2[1] - p1[1]))
        rr = min(r, math.dist(p0, p1) / 2, math.dist(p1, p2) / 2)
        a = (p1[0] - d1[0] * rr, p1[1] - d1[1] * rr)
        b = (p1[0] + d2[0] * rr, p1[1] + d2[1] * rr)
        d += f" L{a[0]:g} {a[1]:g} Q{p1[0]:g} {p1[1]:g} {b[0]:g} {b[1]:g}"
    d += f" L{pts[-1][0]:g} {pts[-1][1]:g}"
    return d


class Escena:
    """Una vista: acumula zonas, aristas, nodos y las valida antes de emitir el SVG."""

    def __init__(self, slug: str, titulo: str, desc: str, w: int, h: int):
        self.slug, self.titulo, self.desc, self.w, self.h = slug, titulo, desc, w, h
        self.zonas: list[str] = []
        self.aristas: list[str] = []
        self.nodos_svg: list[str] = []
        self.extras: list[str] = []      # leyenda, notas…
        self.extras_antes = ""            # va debajo de los nodos (p. ej. líneas de vida)
        self.cajas: dict[str, tuple] = {}     # id -> (x, y, w, h)
        self.segmentos: list[tuple] = []      # (arista_id, (x1,y1), (x2,y2))
        self.mascaras: list[tuple] = []       # (x, y, w, h, etiqueta)
        self.avisos: list[str] = []

    # -- elementos -------------------------------------------------------------------------------------------------
    def zona(self, x, y, w, h, rotulo: str):
        tw = ancho_texto(rotulo.upper(), 9, True) + len(rotulo) * 1.6 + 16
        self.zonas.append(
            f'<g class="zona"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8"/>'
            f'<rect class="zmask" x="{x + 10}" y="{y - 7}" width="{tw:g}" height="14" rx="2"/>'
            f'<text class="eyebrow" x="{x + 18}" y="{y + 3}">{esc(rotulo.upper())}</text></g>'
        )

    def nodo(self, id_, x, y, w, h, kind, tag, nombre, sub, chips=None, data_id=None, tam_nombre=15, tam_sub=11):
        self.cajas[id_] = (x, y, w, h)
        cls = f"k-{kind}"
        tw = max(30, ancho_texto(tag, 8, True) + 14)
        l_nombre = partir(nombre, w - 24, tam_nombre * 1.04)
        l_sub = partir(sub, w - 20, tam_sub, True)
        if len(l_nombre) > 3 or len(l_sub) > 2:
            self.avisos.append(f"[{self.slug}] texto demasiado largo en {id_}: «{nombre}» / «{sub}»")
        alto_bloque = len(l_nombre) * (tam_nombre + 3) + len(l_sub) * (tam_sub + 4) + 4
        if chips:
            primera = y + h * 0.30 + tam_nombre
        else:
            primera = max(y + h / 2 - alto_bloque / 2 + tam_nombre, y + 28 + (0 if len(l_nombre) == 1 else 4))
        g = [f'<g class="nodo {cls}" data-id="{esc(data_id or id_)}" tabindex="0" role="button" aria-label="{esc(nombre)}">']
        g.append(f'<rect class="mask" x="{x}" y="{y}" width="{w}" height="{h}" rx="6"/>')
        g.append(f'<rect class="caja" x="{x}" y="{y}" width="{w}" height="{h}" rx="6"/>')
        g.append(f'<rect class="chip" x="{x + 8}" y="{y + 7}" width="{tw:g}" height="14" rx="2"/>')
        g.append(f'<text class="tag" x="{x + 8 + tw / 2:g}" y="{y + 17}" text-anchor="middle">{esc(tag)}</text>')
        cy_ = primera
        for ln in l_nombre:
            g.append(f'<text class="nombre" x="{x + w / 2:g}" y="{cy_:g}" text-anchor="middle" font-size="{tam_nombre}">{esc(ln)}</text>')
            cy_ += tam_nombre + 3
        cy_ += 2
        for ln in l_sub:
            g.append(f'<text class="sub" x="{x + w / 2:g}" y="{cy_:g}" text-anchor="middle" font-size="{tam_sub}">{esc(ln)}</text>')
            cy_ += tam_sub + 4
        if chips:
            cy = cy_ + 14
            for c in chips:
                cw = min(ancho_texto(c, 10.5, True) + 20, w - 24)
                g.append(f'<rect class="artefacto" x="{x + w / 2 - cw / 2:g}" y="{cy:g}" width="{cw:g}" height="24" rx="4"/>')
                g.append(f'<text class="art" x="{x + w / 2:g}" y="{cy + 16:g}" text-anchor="middle" font-size="10.5">{esc(c)}</text>')
                cy += 32
        g.append("</g>")
        self.nodos_svg.append("".join(g))

    def arista(self, a, b, pts, estilo="muted", etiqueta=None, lado="arriba", seg=None, dash=False, abierta=False, aid=None):
        """pts: lista de puntos ortogonales; estilo: muted | accent | link; etiqueta ≤14 caracteres en mayúsculas."""
        aid = aid or f"{a}-{b}"
        for p, q in zip(pts, pts[1:]):
            if p[0] != q[0] and p[1] != q[1]:
                self.avisos.append(f"[{self.slug}] conector diagonal en {aid}: {p}->{q}")
            self.segmentos.append((aid, p, q, a, b))
        clase = f"ar ar-{estilo}" + (" dash" if dash else "")
        marker = f"url(#{self.slug}-{'open' if abierta else estilo})"
        out = [f'<g class="arista" data-a="{esc(a)}" data-b="{esc(b)}">']
        out.append(f'<path class="{clase}" d="{ruta_redondeada(pts)}" marker-end="{marker}"/>')
        if etiqueta:
            out.append(self._etiqueta(aid, pts, etiqueta, lado, seg))
        out.append("</g>")
        self.aristas.append("".join(out))

    def _etiqueta(self, aid, pts, texto, lado, seg):
        if len(texto) > 14:
            self.avisos.append(f"[{self.slug}] etiqueta de {aid} supera 14 caracteres: «{texto}»")
        # segmento donde va la etiqueta: el más largo salvo que se indique
        if seg is None:
            seg = max(range(len(pts) - 1), key=lambda i: math.dist(pts[i], pts[i + 1]))
        p, q = pts[seg], pts[seg + 1]
        mx, my = (p[0] + q[0]) / 2, (p[1] + q[1]) / 2
        tw = ancho_texto(texto, 10, True) + len(texto) * 0.6
        mw, mh = tw + 12, 16
        if p[1] == q[1]:  # segmento horizontal: etiqueta encima o debajo con 8px de aire
            x = mx - mw / 2
            y = my - 8 - mh if lado == "arriba" else my + 8
        else:             # vertical: etiqueta a un lado
            x = mx + 8 if lado in ("der", "arriba") else mx - 8 - mw
            y = my - mh / 2
        self.mascaras.append((x, y, mw, mh, aid))
        return (f'<rect class="lmask" x="{x:g}" y="{y:g}" width="{mw:g}" height="{mh}" rx="2"/>'
                f'<text class="albl" x="{x + mw / 2:g}" y="{y + 11.5:g}" text-anchor="middle">{esc(texto)}</text>')

    # -- validación ------------------------------------------------------------------------------------------------
    def validar(self):
        def cruza_caja(p, q, caja, margen=0):
            x, y, w, h = caja
            x1, x2 = sorted((p[0], q[0]))
            y1, y2 = sorted((p[1], q[1]))
            return x1 < x + w - margen and x2 > x + margen and y1 < y + h - margen and y2 > y + margen

        # 1) ningún segmento atraviesa un nodo que no sea su origen o destino
        for aid, p, q, a, b in self.segmentos:
            for nid, caja in self.cajas.items():
                if nid in (a, b):
                    continue
                if cruza_caja(p, q, caja, 0.5):
                    self.avisos.append(f"[{self.slug}] el conector {aid} pasa por detrás de {nid}")
        # 2) cruces y solapes entre aristas distintas
        segs = self.segmentos
        for i in range(len(segs)):
            for j in range(i + 1, len(segs)):
                ai, p1, q1, *_ = segs[i]
                aj, p2, q2, *_ = segs[j]
                if ai == aj:
                    continue
                h1, h2 = p1[1] == q1[1], p2[1] == q2[1]
                if h1 == h2:  # paralelos: solape si están alineados y se pisan
                    if h1 and p1[1] == p2[1] and max(min(p1[0], q1[0]), min(p2[0], q2[0])) < min(max(p1[0], q1[0]), max(p2[0], q2[0])):
                        self.avisos.append(f"[{self.slug}] {ai} y {aj} se solapan en y={p1[1]}")
                    if (not h1) and p1[0] == p2[0] and max(min(p1[1], q1[1]), min(p2[1], q2[1])) < min(max(p1[1], q1[1]), max(p2[1], q2[1])):
                        self.avisos.append(f"[{self.slug}] {ai} y {aj} se solapan en x={p1[0]}")
                else:
                    (hp, hq), (vp, vq) = ((p1, q1), (p2, q2)) if h1 else ((p2, q2), (p1, q1))
                    xs = sorted((hp[0], hq[0]))
                    ys = sorted((vp[1], vq[1]))
                    if xs[0] < vp[0] < xs[1] and ys[0] < hp[1] < ys[1]:
                        self.avisos.append(f"[{self.slug}] {ai} cruza a {aj} en ({vp[0]},{hp[1]})")
        # 3) una máscara de etiqueta no puede pisar un nodo
        for x, y, w, h, aid in self.mascaras:
            for nid, caja in self.cajas.items():
                cx, cy, cw, ch = caja
                if x < cx + cw and x + w > cx and y < cy + ch and y + h > cy:
                    self.avisos.append(f"[{self.slug}] la etiqueta de {aid} pisa el nodo {nid}")
        # 4) las máscaras tampoco deben tocar el trazo de otro conector
        for x, y, w, h, aid in self.mascaras:
            for sid, p, q, *_ in self.segmentos:
                if sid == aid:
                    continue
                x1, x2 = sorted((p[0], q[0]))
                y1, y2 = sorted((p[1], q[1]))
                if x1 <= x + w and x2 >= x and y1 <= y + h and y2 >= y:
                    self.avisos.append(f"[{self.slug}] la etiqueta de {aid} toca el conector {sid}")
        # 5) todo dentro del lienzo
        for x, y, w, h, aid in self.mascaras:
            if x < 0 or y < 0 or x + w > self.w or y + h > self.h:
                self.avisos.append(f"[{self.slug}] la etiqueta de {aid} se sale del lienzo")
        for nid, (x, y, w, h) in self.cajas.items():
            if x < 0 or y < 0 or x + w > self.w or y + h > self.h:
                self.avisos.append(f"[{self.slug}] el nodo {nid} se sale del lienzo")

    # -- salida ----------------------------------------------------------------------------------------------------
    def svg(self) -> str:
        s = self.slug
        marcador = lambda n: (f'<marker id="{s}-{n}" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">'
                              f'<polygon class="mk mk-{n}" points="0 0, 9 3.5, 0 7"/></marker>')
        abierto = (f'<marker id="{s}-open" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">'
                   f'<polyline class="mk-open" points="0 0, 9 3.5, 0 7"/></marker>')
        return (
            f'<svg class="mapa" id="svg-{s}" viewBox="0 0 {self.w} {self.h}" xmlns="http://www.w3.org/2000/svg" role="img" '
            f'aria-labelledby="{s}-title {s}-desc" preserveAspectRatio="xMidYMid meet">'
            f'<title id="{s}-title">{esc(self.titulo)}</title><desc id="{s}-desc">{esc(self.desc)}</desc>'
            f'<defs>{marcador("muted")}{marcador("accent")}{marcador("link")}{abierto}</defs>'
            f'<rect class="fondo" width="100%" height="100%"/>'
            + "".join(self.zonas) + self.extras_antes + "".join(self.aristas) + "".join(self.nodos_svg) + "".join(self.extras) + "</svg>"
        )


def leyenda(esc_, y, items, x0=40):
    """Tira horizontal al final (nunca flotando dentro del diagrama). items: (clase, texto, ancho)."""
    out = [f'<line class="lrule" x1="{x0}" y1="{y - 12}" x2="{esc_.w - x0}" y2="{y - 12}"/>',
           f'<text class="eyebrow" x="{x0}" y="{y + 6}">LEYENDA</text>']
    x = x0 + 80
    for tipo, texto in items:
        if tipo.startswith("k-"):
            out.append(f'<g class="nodo {tipo} leyenda-caja"><rect class="caja" x="{x}" y="{y - 6}" width="30" height="18" rx="4"/></g>')
            x += 38
        elif tipo.startswith("ar-"):
            partes = tipo.split("-")
            base = partes[1]
            dash = " dash" if "dash" in partes else ""
            mk = "open" if "open" in partes else base
            out.append(f'<path class="ar ar-{base}{dash}" d="M{x} {y + 3} L{x + 30} {y + 3}" marker-end="url(#{esc_.slug}-{mk})"/>')
            x += 38
        elif tipo.startswith("b-"):
            out.append(f'<rect class="badge {tipo}" x="{x}" y="{y - 5}" width="58" height="16" rx="3"/>'
                       f'<text class="badge-t {tipo}" x="{x + 29}" y="{y + 7}" text-anchor="middle">{texto.split("|")[0]}</text>')
            texto = texto.split("|")[1]
            x += 66
        out.append(f'<text class="leg" x="{x}" y="{y + 7}">{esc(texto)}</text>')
        x += ancho_texto(texto, 11) + 36
    esc_.extras.append("".join(out))
