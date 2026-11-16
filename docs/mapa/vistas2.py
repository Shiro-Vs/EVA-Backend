# -*- coding: utf-8 -*-
"""Vistas de diseño del mapa: capas del backend, entornos, datos por dominios, ciclos de vida, navegación de la app,
zonas de confianza y hoja de ruta; más el tablero «Qué falta» leído de docs/PENDIENTES.md."""
import os
import re

from geom import Escena, ancho_texto, esc, leyenda, partir

AQUI = os.path.dirname(os.path.abspath(__file__))


def _det(titulo, sub, texto, items=None):
    return {"titulo": titulo, "sub": sub, "texto": texto, "items": items or []}


# =====================================================================================================================
# tarjeta con filas (para datos por dominio y navegación)
# =====================================================================================================================
def tarjeta(e, id_, x, y, w, titulo, sub, filas, kind="external", col_n=190, ancho_desc=None):
    """filas: (nombre, descripción). Devuelve el alto. La tarjeta es clicable (data-id=id_)."""
    ancho_desc = ancho_desc or (w - col_n - 18)
    alto_fila = 19
    h = 64 + len(filas) * alto_fila + 12
    out = [f'<g class="nodo tarjeta k-{kind}" data-id="{esc(id_)}" tabindex="0" role="button" aria-label="{esc(titulo)}">',
           f'<rect class="mask" x="{x}" y="{y}" width="{w}" height="{h}" rx="8"/>',
           f'<rect class="caja" x="{x}" y="{y}" width="{w}" height="{h}" rx="8"/>',
           f'<text class="nombre" x="{x + 18}" y="{y + 30}" font-size="16">{esc(titulo)}</text>',
           f'<text class="sub" x="{x + 18}" y="{y + 47}" font-size="10.5">{esc(sub)}</text>']
    for i, (n, d) in enumerate(filas):
        ry = y + 64 + i * alto_fila
        out.append(f'<line class="lrule" x1="{x + 14}" y1="{ry}" x2="{x + w - 14}" y2="{ry}"/>')
        out.append(f'<text class="fila-n env" x="{x + 18}" y="{ry + 13}">{esc(n)}</text>')
        out.append(f'<text class="fila-v" x="{x + col_n}" y="{ry + 13}">{esc(d)}</text>')
        if ancho_texto(d, 11, True) > ancho_desc:
            e.avisos.append(f"[{e.slug}] fila demasiado larga en {id_}: «{d}»")
    out.append("</g>")
    e.nodos_svg.append("".join(out))
    e.cajas[id_] = (x, y, w, h)
    return h


# =====================================================================================================================
# 1) CAPAS DEL BACKEND
# =====================================================================================================================
def vista_capas():
    e = Escena("d-capas", "Capas del backend", "Cómo se organiza el código de la API: HTTP, aplicación, dominio puro e infraestructura.", 1400, 840)
    det = {}
    e.zona(30, 110, 960, 640, "EVA-Backend · Node 22 · TypeScript")
    e.nodo("cliente", 60, 140, 240, 110, "focal", "APP", "App móvil", "solo muestra; nunca calcula", data_id="cliente")
    e.nodo("http", 60, 300, 240, 110, "backend", "HTTP", "Capa HTTP", "Fastify · Zod · OpenAPI", data_id="http")
    e.nodo("app", 400, 300, 240, 110, "backend", "APP", "Aplicación", "casos de uso · 1 transacción", data_id="app")
    e.nodo("dom", 740, 160, 240, 110, "focal", "PURO", "Dominio", "dinero · calendario · reparto", data_id="dom")
    e.nodo("infra", 740, 440, 240, 110, "backend", "INFRA", "Infraestructura", "Kysely · Auth · IA · correo", data_id="infra")
    e.nodo("db", 1100, 200, 240, 100, "store", "BD", "PostgreSQL", "Supabase · 25 migraciones", data_id="db")
    e.nodo("store", 1100, 340, 240, 100, "store", "FILES", "Supabase Storage", "originales y respaldos", data_id="store")
    e.nodo("gem", 1100, 480, 240, 100, "external", "IA", "Gemini", "gemini-2.5-flash", data_id="gem")
    e.nodo("mail", 1100, 620, 240, 100, "external", "MAIL", "Resend", "enviar y recibir", data_id="mail")
    e.arista("cliente", "http", [(180, 250), (180, 300)], "link", "HTTPS", lado="der")
    e.arista("http", "app", [(300, 355), (400, 355)], "muted", "VALIDADO")
    e.arista("app", "dom", [(640, 330), (690, 330), (690, 215), (740, 215)], "accent", "CALCULA", lado="izq")
    e.arista("app", "infra", [(640, 390), (690, 390), (690, 495), (740, 495)], "muted", "PERSISTE", lado="izq")
    e.arista("infra", "db", [(980, 460), (1010, 460), (1010, 250), (1100, 250)], "muted")
    e.arista("infra", "store", [(980, 480), (1030, 480), (1030, 390), (1100, 390)], "muted")
    e.arista("infra", "gem", [(980, 500), (1070, 500), (1070, 530), (1100, 530)], "link")
    e.arista("infra", "mail", [(980, 520), (1050, 520), (1050, 670), (1100, 670)], "link")
    leyenda(e, 800, [("k-focal", "regla de oro"), ("k-backend", "capa de código"), ("k-store", "datos"), ("k-external", "tercero"), ("ar-accent", "cálculo de dinero"), ("ar-link", "llamada externa")])
    det["cliente"] = _det("App móvil", "EVA-Frontend", "Muestra lo que la API devuelve y le da formato (S/ 20.00). Nunca calcula importes, prorrateos ni repartos.")
    det["http"] = _det("Capa HTTP", "src/http", "Traduce: valida la entrada con Zod, llama a un caso de uso y da formato al error. No contiene reglas de negocio.",
                       [("Rutas", "216 operaciones bajo /v1"), ("Contrato", "openapi.json, regenerado y verificado por una prueba"), ("Fuera de /v1", "/healthz, /readyz, /jobs/daily, /webhooks/resend"), ("Identidad", "Token de Supabase validado con JWKS (ES256)")])
    det["app"] = _det("Aplicación", "src/application", "Un caso de uso por acción. Abre una transacción para todo lo que toca dinero, valida y llama al dominio. Nunca devuelve filas crudas.",
                      [("Idempotencia", "una clave repetida devuelve el resultado ya guardado"), ("Vista previa", "token firmado entre «ver» y «confirmar»"), ("Módulos", "cuentas, contactos, servicios, cobros, préstamos, tarjetas, plan, captura, informes, respaldos, sugerencias, análisis")])
    det["dom"] = _det("Dominio puro", "src/domain", "El motor de cálculo: no conoce base de datos, reloj ni red. Se prueba con casos dorados.",
                      [("Dinero", "céntimos enteros dentro; cadena decimal fuera"), ("Calendario", "ciclos, fechas locales de Lima"), ("Reparto", "cuota por plaza, prorrateo, umbral gratis, salida")])
    det["infra"] = _det("Infraestructura", "src/infra", "Todo lo que sale del proceso: base de datos, autenticación, archivos, IA, correo, respaldos y exportaciones.",
                        [("Base", "Kysely sobre PostgreSQL por Session pooler"), ("Captura", "Gemini o extractor heurístico"), ("Correo", "envío por Resend y lectura de correos recibidos")])
    det["db"] = _det("PostgreSQL", "Supabase", "Fuente de verdad. El esquema son las migraciones SQL numeradas e inmutables.", [("Dinero", "numeric(14,2)"), ("Acceso", "solo desde la API; Data API apagada")])
    det["store"] = _det("Supabase Storage", "bucket privado", "Comprobantes originales (90 días) y respaldos cifrados. Solo la API lo toca, con la clave secreta.")
    det["gem"] = _det("Gemini", "Google AI", "Lee comprobantes y responde análisis. Cuota de 30 usos diarios por usuario. Sin clave, cae al extractor heurístico.")
    det["mail"] = _det("Resend", "correo", "Salida: sugerencias y Auth (SMTP). Entrada: avisos firmados de correos reenviados a la dirección personal de captura.")
    return e, det


# =====================================================================================================================
# 2) ENTORNOS
# =====================================================================================================================
def vista_entornos():
    e = Escena("d-entornos", "Entornos: local y producción", "Qué corre en tu PC al desarrollar y qué corre en la nube con datos reales.", 1700, 780)
    det = {}
    e.zona(40, 100, 780, 560, "Local · tu PC")
    e.zona(880, 100, 780, 560, "Producción · la nube")
    e.nodo("l-tel", 60, 160, 240, 100, "input", "APP", "Teléfono de pruebas", "Expo Go o APK", data_id="l-tel")
    e.nodo("l-api", 400, 160, 240, 100, "backend", "API", "API local", "npm run dev · :3000", data_id="l-api")
    e.nodo("l-pg", 400, 360, 240, 100, "store", "BD", "PostgreSQL propio", ".pgdata · :54329", data_id="l-pg")
    e.nodo("l-seed", 60, 360, 240, 100, "optional", "SEED", "Datos de demostración", "npm run seed:demo", data_id="l-seed")
    e.arista("l-tel", "l-api", [(300, 210), (400, 210)], "link", "WIFI · IP")
    e.arista("l-api", "l-pg", [(520, 260), (520, 360)], "muted", "SQL", lado="der")
    e.arista("l-seed", "l-pg", [(300, 410), (400, 410)], "muted", "CARGA", lado="abajo")
    e.nodo("p-cron", 900, 160, 240, 100, "external", "CRON", "cron-job.org", "tarea diaria 03:00", data_id="p-cron")
    e.nodo("p-tel", 900, 360, 240, 100, "focal", "APP", "APK instalado", "con actualizaciones OTA", data_id="p-tel")
    e.nodo("p-api", 1240, 160, 240, 100, "focal", "API", "API en Render", "api.eva-app.lat", data_id="p-api")
    e.nodo("p-sb", 1240, 360, 240, 100, "store", "BD", "Supabase", "Postgres · Auth · Storage", data_id="p-sb")
    e.arista("p-cron", "p-api", [(1140, 210), (1240, 210)], "muted", "POST /JOBS", dash=True)
    e.arista("p-tel", "p-api", [(1140, 410), (1190, 410), (1190, 230), (1240, 230)], "accent", "HTTPS · /V1", lado="der")
    e.arista("p-api", "p-sb", [(1360, 260), (1360, 360)], "muted", "SQL · POOLER", lado="der")
    leyenda(e, 730, [("k-focal", "pieza principal"), ("k-backend", "servicio propio"), ("k-store", "datos"), ("k-input", "dispositivo"), ("k-optional", "utilidad"), ("ar-link", "red local"), ("ar-accent", "ruta principal")])
    det["l-tel"] = _det("Teléfono de pruebas", "local", "Con Expo Go se ven pantallas y API; Google, notificaciones y huella exigen el APK. La IP de la PC va en EXPO_PUBLIC_API_URL.")
    det["l-api"] = _det("API local", "local", "AUTH_MODE=dev: un token de desarrollo (npm run dev:token) sustituye a Supabase.", [("Variables", "archivo .env"), ("Recarga", "tsx watch")])
    det["l-pg"] = _det("PostgreSQL propio", "local", "Clúster del proyecto, solo en 127.0.0.1 y sin contraseña. No se usa el PostgreSQL del sistema.", [("Reiniciar", "npm run db:reset:dev")])
    det["l-seed"] = _det("Datos de demostración", "local", "Cuentas, servicios y contactos de ejemplo para ver las pantallas con contenido.")
    det["p-cron"] = _det("cron-job.org", "producción", "Despierta la API a las 02:55 y dispara /jobs/daily a las 03:00 (hora de Lima) con x-cron-secret.")
    det["p-tel"] = _det("APK instalado", "producción", "Perfil preview. Recibe cambios de código por EAS Update; los cambios nativos exigen un APK nuevo.")
    det["p-api"] = _det("API en Render", "producción", "Plan gratuito: se duerme tras ≈ 15 min. Despliega sola desde la rama main.", [("Variables", "panel de Render"), ("Migraciones", "antes de subir el código que las usa")])
    det["p-sb"] = _det("Supabase", "producción", "Base, cuentas y archivos reales. Sin entorno de pruebas aparte: lo nuevo se prueba en local primero.")
    return e, det


# =====================================================================================================================
# 3) DATOS POR DOMINIOS
# =====================================================================================================================
DOMINIOS = {
    "identidad": ("Identidad y sistema", "dueño de todo dato (owner_id)", "input", [
        ("user_profile", "perfil, preferencias y tema"), ("contact", "personas con quien compartes"), ("idempotency_record", "claves de reintento"),
        ("audit_event", "quién hizo qué y por qué"), ("usage_record", "uso diario de la IA"), ("deleted_user", "marca de cuenta eliminada")]),
    "cuentas": ("Cuentas y movimientos", "el libro mayor personal", "store", [
        ("account", "efectivo, banco, billetera, tarjeta"), ("account_entry", "asiento por cuenta"), ("financial_operation", "gasto, ingreso, transferencia"),
        ("operation_item", "partidas y categorías"), ("category", "categorías del usuario"), ("payment_channel", "Yape, Plin, transferencia"),
        ("credit_account_details", "datos de la tarjeta de crédito"), ("reconciliation", "conciliación con el estado")]),
    "servicios": ("Servicios compartidos", "suscripciones y plazas", "focal", [
        ("subscription", "servicio y proveedor"), ("subscription_terms", "precio y cuota vigentes"), ("billing_cycle", "ciclo de cobro"),
        ("membership", "persona dentro de un servicio"), ("seat", "plaza que ocupa"), ("seat_terms", "cuota de la plaza"),
        ("calendar_change", "cambio de fechas"), ("courtesy", "cortesías")]),
    "cobros": ("Cobros y pagos", "lo que te deben y lo que pagas", "focal", [
        ("member_charge", "cargo por ciclo a un integrante"), ("receipt", "cobro recibido"), ("payment_allocation", "a qué cargos se aplica"),
        ("charge_adjustment", "ajustes de un cargo"), ("credit_reservation", "saldo a favor reservado"), ("refund", "devolución"),
        ("receivable_obligation", "obligación por cobrar"), ("supplier_payment", "pago al proveedor")]),
    "prestamos": ("Préstamos y tarjetas", "deudas entre personas y con bancos", "backend", [
        ("loan · loan_component", "préstamo entre personas"), ("loan_charge (+allocation)", "cargos y su aplicación"), ("loan_payment", "pago de un préstamo"),
        ("loan_capitalization", "intereses capitalizados"), ("debt_conversion (+item)", "deuda convertida en préstamo"), ("bank_loan (+4 tablas)", "préstamo bancario y cuotas"),
        ("card_statement (+payment)", "estado de tarjeta y su pago"), ("card_installment (+plan)", "compras en cuotas")]),
    "plan": ("Planificación", "presupuestos, metas y recurrentes", "backend", [
        ("budget", "presupuesto mensual"), ("budget_limit", "límite por categoría"), ("budget_threshold", "avisos de umbral"),
        ("goal", "meta de ahorro"), ("goal_contribution", "aportes a la meta"), ("recurring_template", "movimiento recurrente"),
        ("expected_occurrence", "próxima aparición esperada")]),
    "captura": ("Captura e inteligencia", "comprobantes → propuestas", "optional", [
        ("source_document", "comprobante, foto o correo"), ("extraction_run", "una lectura con IA"), ("movement_proposal", "movimiento propuesto"),
        ("evidence_link", "enlace propuesta ↔ documento"), ("duplicate_candidate", "posible duplicado"), ("inbox_address", "dirección de recepción"),
        ("sender_rule", "regla por remitente"), ("classification_*", "reglas y decisiones de categoría")]),
    "analisis": ("Análisis e informes", "lo que se lee y se exporta", "external", [
        ("analysis_request / result", "pregunta y respuesta de la IA"), ("chat_session · chat_message", "conversaciones guardadas"), ("daily_tip", "consejo del día"),
        ("report_snapshot", "resumen mensual guardado"), ("export_job", "exportación en curso"), ("backup", "respaldo cifrado")]),
}


def vista_datos():
    W, M, CW, GAP = 1760, 60, 500, 70
    cols = [M, M + CW + GAP, M + 2 * (CW + GAP)]
    pos = {"identidad": (0, 0), "servicios": (1, 0), "cobros": (2, 0), "plan": (0, 1), "cuentas": (1, 1), "prestamos": (2, 1), "captura": (0, 2), "analisis": (1, 2)}
    altos = {k: 64 + len(v[3]) * 19 + 12 for k, v in DOMINIOS.items()}
    fila_h = [max(altos[k] for k, p in pos.items() if p[1] == r) for r in range(3)]
    ys = [100]
    for r in range(2):
        ys.append(ys[-1] + fila_h[r] + 110)
    H = ys[2] + fila_h[2] + 130
    e = Escena("d-datos", "Datos por dominios", "Las tablas de la base agrupadas por tema y cómo se relacionan los grupos.", W, H)
    det = {}
    for k, (t, s, kind, filas) in DOMINIOS.items():
        c, r = pos[k]
        tarjeta(e, k, cols[c], ys[r], CW, t, s, filas, kind, col_n=206)
        det[k] = _det(t, s, "Tablas de este grupo. Todas llevan owner_id: ninguna consulta cruza datos de otra cuenta.", [(n, d) for n, d in filas])

    def borde(k, lado, fy=None):
        x, y, w, h = e.cajas[k]
        return {"izq": x, "der": x + w}[lado] if lado in ("izq", "der") else None

    cx = lambda k: e.cajas[k][0]
    cy = lambda k: e.cajas[k][1]
    cw = lambda k: e.cajas[k][2]
    ch = lambda k: e.cajas[k][3]
    # servicios → identidad (miembros son contactos)
    y1 = cy("servicios") + 40
    e.arista("servicios", "identidad", [(cx("servicios"), y1), (cx("identidad") + CW, y1)], "muted", "CONTACTO")
    # cobros → servicios (cargo de plaza y ciclo)
    e.arista("cobros", "servicios", [(cx("cobros"), y1), (cx("servicios") + CW, y1)], "accent", "PLAZA")
    # cobros → cuentas (el cobro es un movimiento)
    xcob = cx("cobros") + CW / 2
    ymid = cy("cobros") + ch("cobros") + 55
    e.arista("cobros", "cuentas", [(xcob, cy("cobros") + ch("cobros")), (xcob, ymid), (cx("cuentas") + CW / 2, ymid), (cx("cuentas") + CW / 2, cy("cuentas"))], "accent", "MOVIMIENTO", seg=1)
    # préstamos → cuentas
    y2 = cy("cuentas") + 100
    e.arista("prestamos", "cuentas", [(cx("prestamos"), y2), (cx("cuentas") + CW, y2)], "muted", "PAGOS")
    # plan → cuentas
    e.arista("plan", "cuentas", [(cx("plan") + CW, y2), (cx("cuentas"), y2)], "muted", "CUENTAS")
    # captura → cuentas (la propuesta se convierte en operación)
    y3 = cy("cuentas") + 160
    ycap = cy("captura") + 120
    xl = cx("cuentas") - GAP / 2
    e.arista("captura", "cuentas", [(cx("captura") + CW, ycap), (xl, ycap), (xl, y3), (cx("cuentas"), y3)], "link", "ACEPTA", seg=1, lado="izq")
    # cuentas → análisis
    xa = cx("cuentas") + CW / 2
    e.arista("cuentas", "analisis", [(xa, cy("cuentas") + ch("cuentas")), (xa, cy("analisis"))], "link", "LEE", lado="der")
    leyenda(e, H - 36, [("k-focal", "núcleo de servicios"), ("k-store", "libro mayor"), ("k-backend", "planificación y deuda"), ("ar-accent", "relación principal"), ("ar-link", "usa IA")])
    return e, det


# =====================================================================================================================
# 4) CICLOS DE VIDA
# =====================================================================================================================
CICLOS = [
    ("op", "Operación financiera", "financial_operation", ["confirmada"], [("reversada", "k-store")], "Una operación confirmada solo se revierte, no se borra: el saldo se reconstruye."),
    ("part", "Participación en un servicio", "membership", ["activa"], [("terminando", "k-optional"), ("terminada", "k-store")], "Al retirar a alguien se convierte lo pendiente; la plaza termina en el siguiente corte."),
    ("cargo", "Cargo de integrante", "member_charge", ["emitido"], [("anulado", "k-store")], "Pagado, parcial o vencido se calcula por las aplicaciones; no es un estado guardado."),
    ("devol", "Devolución", "refund", ["planificada"], [("pagada", "k-store"), ("cancelada", "k-store")], "Al pagarse libera el crédito o cobertura con su salida real."),
    ("prest", "Préstamo entre personas", "loan", ["abierto"], [("cerrado", "k-store"), ("cancelado", "k-store")], "Se cierra al saldarse; cancelar no borra el historial."),
    ("cuota", "Cuota de préstamo bancario", "bank_loan_installment", ["programada"], [("pagada", "k-store"), ("reemplazada", "k-optional")], "Un cambio de condiciones reemplaza las cuotas futuras."),
    ("doc", "Documento de captura", "source_document", ["recibido", "propuesto"], [("falló", "k-optional"), ("descartado", "k-optional"), ("sin movimiento", "k-optional"), ("préstamo", "k-store")], "Del correo o la foto salen propuestas que el usuario confirma; la IA nunca registra sola."),
    ("prop", "Propuesta de movimiento", "movement_proposal", ["pendiente"], [("aceptada", "k-store"), ("vinculada", "k-store"), ("descartada", "k-optional")], "Aceptar crea la operación; vincular la asocia a una existente."),
    ("ocur", "Ocurrencia recurrente", "expected_occurrence", ["pendiente"], [("confirmada", "k-store"), ("omitida", "k-optional")], "Confirmar crea el movimiento esperado de ese día."),
    ("exp", "Exportación", "export_job", ["en cola", "ejecutando"], [("lista", "k-store"), ("falló", "k-optional")], "Una lista caduca a las 24 h y la tarea diaria la limpia."),
]


def vista_ciclos():
    W = 1300
    bw, bh, sep = 190, 64, 76
    x0 = 400
    filas = []
    y = 100
    for c in CICLOS:
        k = len(c[4])
        alto = max(bh, k * 70) + 36
        filas.append((c, y, alto))
        y += alto
    H = y + 80
    e = Escena("d-ciclos", "Ciclos de vida", "Los estados por los que pasa cada objeto importante y cómo termina.", W, H)
    det = {}
    for (cid, titulo, tabla, previos, finales, nota), y, alto in filas:
        yc = y + alto / 2
        e.extras.append(f'<line class="lrule" x1="40" y1="{y - 12}" x2="{W - 40}" y2="{y - 12}"/>')
        e.extras.append(f'<text class="nombre fila-t" x="40" y="{yc - 6}" font-size="16">{esc(titulo)}</text>')
        e.extras.append(f'<text class="sub" x="40" y="{yc + 12}" font-size="11">{esc(tabla)}</text>')
        prev = None
        x = x0
        for j, nm in enumerate(previos):
            nid = f"{cid}-{j}"
            e.nodo(nid, x, yc - bh / 2, bw, bh, "backend", "ESTADO", nm, "", data_id=nid, tam_nombre=14)
            det[nid] = _det(nm, titulo, nota)
            if prev:
                e.arista(prev, nid, [(x - sep, yc), (x, yc)], "muted")
            prev = nid
            x += bw + sep
        n = len(finales)
        paso = 70
        top = yc - paso * (n - 1) / 2
        sx = x - sep - 0  # borde derecho del último previo = x - sep
        # puntos de salida repartidos por el borde derecho del último estado previo
        for i, (nm, kind) in enumerate(finales):
            nid = f"{cid}-f{i}"
            ty = top + i * paso
            e.nodo(nid, x, ty - bh / 2, bw, bh, kind[2:], "FIN" if nm not in ("terminando",) else "ESTADO", nm, "", data_id=nid, tam_nombre=14)
            det[nid] = _det(nm, titulo, nota)
            fy = yc - bh / 2 + bh * (i + 1) / (n + 1)
            if n == 1:
                e.arista(prev, nid, [(x - sep, yc), (x, yc)], "muted")
                continue
            # carril: más cerca del destino cuanto más lejos del centro, para no cruzar
            lane = x - sep + 20 + 12 * (min(i, n - 1 - i))
            if abs(ty - fy) < 1:
                e.arista(prev, nid, [(x - sep, fy), (x, fy)], "muted")
            else:
                e.arista(prev, nid, [(x - sep, fy), (lane, fy), (lane, ty), (x, ty)], "muted")
        # el borde derecho del último previo está en x - sep
    e.extras.append(f'<text class="eyebrow" x="40" y="48">LOS ESTADOS SON LOS DE LAS RESTRICCIONES DE LAS MIGRACIONES SQL</text>')
    leyenda(e, H - 36, [("k-backend", "estado de partida"), ("k-store", "final normal"), ("k-optional", "final alterno"), ("ar-muted", "transición")])
    return e, det


# =====================================================================================================================
# 5) NAVEGACIÓN DE LA APP
# =====================================================================================================================
NAV = {
    "sesion": ("Sin sesión", "pantallas públicas", "input", [
        ("/", "entrar (correo o Google)"), ("/register", "crear cuenta"), ("/forgot-password", "pedir código"), ("/reset-password", "código y nueva clave"), ("/auth-callback", "regreso de Google")]),
    "inicio": ("Inicio", "pestaña 1 · /", "focal", [
        ("saldo y consejo", "resumen y consejo del día"), ("/capture", "bandeja, lote, reglas"), ("/analysis", "análisis con IA y chats"), ("/panel", "panel configurable")]),
    "dinero": ("Dinero", "pestaña 2 · /money", "focal", [
        ("/account/[id]", "detalle, tarjeta, conciliar"), ("/operation/new", "gasto, ingreso, transferencia"), ("/operation/[id]", "ver y corregir"), ("/card-statement/[id]", "estado de tarjeta"),
        ("/loans", "préstamos entre personas"), ("/bank-loans", "préstamos bancarios")]),
    "servicios": ("Servicios", "pestaña 3 · /planning", "focal", [
        ("/service/new · /join", "crear o unirse"), ("/service/[id]", "calendario, precio, gestión"), ("/service/pay", "pago al proveedor"), ("/seat/[id]", "cuota, cortesía, salida"),
        ("/receipt/new", "registrar un cobro"), ("/refunds", "devoluciones")]),
    "nuevo": ("Nuevo (+)", "pestaña 4 · hoja de acciones", "optional", [
        ("Registrar cobro", "→ /receipt/new"), ("Gasto, ingreso, transferencia", "→ /operation/new"), ("Subir comprobante", "→ /capture/new"), ("Servicio · cuenta · contacto", "alta rápida"),
        ("Meta · préstamo", "alta rápida")]),
    "personas": ("Personas", "pestaña 5 · /people", "focal", [
        ("/contacts", "lista, deuda y vencidos"), ("/contact/[id]", "ficha y estado de cuenta"), ("/contact/[id]/receipts", "cobros de la persona"), ("/contact/[id]/convert", "convertir deuda en préstamo"),
        ("/export/contact", "exportar su estado")]),
    "plan": ("Plan", "pestaña 6 · /plan", "backend", [
        ("/budgets", "presupuestos"), ("/goals", "metas"), ("/recurring", "movimientos recurrentes"), ("/categories", "categorías"), ("/rules · /classify", "reglas y clasificación")]),
    "mas": ("Más", "pestaña 7 · /more", "backend", [
        ("/settings/general", "tema y preferencias"), ("/settings/account", "cuenta y privacidad"), ("/settings/billing", "ajustes de cobro"), ("/settings/lock", "PIN y huella"),
        ("/settings/notifications", "avisos"), ("/settings/backups", "respaldos"), ("/reports · /export", "informes y exportación")]),
}


def vista_navegacion():
    W, M, CW, GAP = 2100, 60, 380, 40
    e = Escena("d-nav", "Navegación de la app", "Las pantallas de EVA agrupadas por la pestaña desde la que se llega.", W, 1000)
    det = {}
    y0 = 120
    sesion = NAV["sesion"]
    h = tarjeta(e, "sesion", M, y0, CW, sesion[0], sesion[1], sesion[3], sesion[2], col_n=170)
    zx = M + CW + 80
    ancho_zona = W - zx - 40
    cw2 = (ancho_zona - 4 * GAP) / 3
    orden = [["inicio", "dinero", "servicios"], ["nuevo", "personas", "plan"], ["mas"]]
    y = y0
    for fila in orden:
        alto_fila = max(64 + len(NAV[k][3]) * 19 + 12 for k in fila)
        for i, k in enumerate(fila):
            x = zx + GAP + i * (cw2 + GAP)
            tarjeta(e, k, x, y, cw2, NAV[k][0], NAV[k][1], NAV[k][3], NAV[k][2], col_n=210)
        y += alto_fila + 40
    y_fin = y
    e.zona(zx, y0 - 44, ancho_zona, y_fin - y0 + 24, "Con sesión · barra inferior de 7 pestañas")
    e.zona(M - 20, y0 - 44, CW + 40, h + 64, "Sin sesión")
    for k, (t, s_, kind, filas) in NAV.items():
        det[k] = _det(t, s_, "Rutas de la app (expo-router, carpeta app/).", list(filas))
    e.h = int(max(y_fin, y0 + h) + 100)
    leyenda(e, e.h - 36, [("k-focal", "pestaña principal"), ("k-backend", "pestaña de apoyo"), ("k-optional", "acción rápida"), ("k-input", "sin sesión")])
    return e, det


# =====================================================================================================================
# 6) ZONAS DE CONFIANZA
# =====================================================================================================================
def vista_confianza():
    e = Escena("d-confianza", "Zonas de confianza", "Qué vive en cada zona, qué cruza entre ellas y dónde están los secretos.", 1700, 840)
    det = {}
    e.zona(40, 100, 380, 520, "Tu teléfono")
    e.zona(520, 100, 460, 640, "Servidor de EVA · Render")
    e.zona(1060, 100, 600, 520, "Proveedores")
    e.nodo("t-app", 80, 160, 260, 140, "focal", "APP", "Aplicación EVA", "solo datos públicos", data_id="t-app")
    e.nodo("t-ss", 80, 400, 260, 100, "store", "LOCAL", "SecureStore", "sesión y perfil · PIN y huella", data_id="t-ss")
    e.nodo("s-api", 560, 160, 300, 420, "focal", "API", "API de EVA", "filtra todo por dueño", data_id="s-api")
    e.nodo("s-env", 560, 630, 300, 90, "security", "SECRETOS", "Variables de entorno", "panel de Render", data_id="s-env")
    e.nodo("p-auth", 1140, 150, 280, 100, "external", "AUTH", "Supabase Auth", "identidad y Google", data_id="p-auth")
    e.nodo("p-db", 1140, 270, 280, 100, "store", "DATOS", "Supabase datos", "base y archivos privados", data_id="p-db")
    e.nodo("p-ia", 1140, 390, 280, 100, "external", "IA", "Gemini", "solo cifras necesarias", data_id="p-ia")
    e.nodo("p-mail", 1140, 510, 280, 100, "external", "MAIL", "Resend", "salida y entrada de correo", data_id="p-mail")
    e.arista("t-app", "s-api", [(340, 230), (560, 230)], "accent", "JWT · HTTPS")
    e.arista("t-ss", "t-app", [(210, 400), (210, 300)], "muted", "SESIÓN", lado="der")
    e.arista("s-env", "s-api", [(710, 630), (710, 580)], "muted", "LEE", lado="der")
    e.arista("s-api", "p-auth", [(860, 200), (1140, 200)], "link", "VERIFICA")
    e.arista("s-api", "p-db", [(860, 320), (1140, 320)], "link", "CLAVE SECRETA")
    e.arista("s-api", "p-ia", [(860, 440), (1140, 440)], "link", "CLAVE API")
    e.arista("s-api", "p-mail", [(860, 560), (1140, 560)], "link", "CLAVE API")
    leyenda(e, 800, [("k-focal", "núcleo"), ("k-store", "datos"), ("k-security", "secretos"), ("k-external", "tercero"), ("ar-accent", "solo token del usuario"), ("ar-link", "con credencial del servidor")])
    det["t-app"] = _det("Aplicación EVA", "teléfono", "El repositorio es público: no contiene ningún secreto. Solo direcciones y claves publicables.", [("Pública", "API, URL de Supabase, clave publicable, ID web de Google")])
    det["t-ss"] = _det("SecureStore", "teléfono", "Almacén seguro del sistema donde vive la sesión y el perfil en caché. Bloqueo opcional con PIN y huella.")
    det["s-api"] = _det("API de EVA", "Render", "La única puerta a los datos. Valida el token, filtra por dueño en cada consulta y registra auditoría de las operaciones de dinero.")
    det["s-env"] = _det("Variables de entorno", "Render", "Los secretos solo existen aquí y en el .env.supabase local del dueño.", [("Ejemplos", "DATABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BACKUP_ENCRYPTION_KEY, GEMINI_API_KEY, RESEND_API_KEY, CRON_SECRET")])
    det["p-auth"] = _det("Supabase Auth", "proveedor", "Emite los tokens. La API no guarda contraseñas ni claves de firma: valida con las claves públicas (JWKS).")
    det["p-db"] = _det("Supabase datos", "proveedor", "Data API apagada; solo la API se conecta.")
    det["p-ia"] = _det("Gemini", "proveedor", "Recibe el comprobante o cifras agregadas ya calculadas; nunca identificadores de contactos.")
    det["p-mail"] = _det("Resend", "proveedor", "Los correos entrantes llegan como avisos firmados (Svix) y direcciones desconocidas se ignoran sin revelar nada.")
    return e, det


# =====================================================================================================================
# 7) HOJA DE RUTA
# =====================================================================================================================
ENTREGAS = [
    ("e0", "E0", "Diseño técnico", "especificación y base", "hecha"),
    ("e1", "E1", "Primer recorrido", "cuentas, contactos, cobros", "hecha"),
    ("e2", "E2", "Núcleo de servicios", "ciclos, plazas, reparto", "hecha"),
    ("e3", "E3", "Finanzas completas", "presupuestos, metas, recurrentes", "hecha"),
    ("e4", "E4", "Captura e IA", "comprobantes y correo", "hecha"),
    ("e5", "E5", "Operación e informes", "respaldos, informes, avisos", "hecha"),
    ("e6", "E6", "Lanzamiento por APK", "producción y OTA", "hecha"),
    ("e7", "E7", "Dólares y amigos", "tipo de cambio y acceso", "pendiente"),
]


def vista_ruta():
    W = 1780
    e = Escena("d-ruta", "Hoja de ruta", "Las entregas construidas y las que siguen.", W, 640)
    det = {}
    bw, gap, x0 = 180, 32, 50
    prev = None
    for i, (nid, tag, nombre, sub, est) in enumerate(ENTREGAS):
        x = x0 + i * (bw + gap)
        kind = "store" if est == "hecha" else "focal"
        e.nodo(nid, x, 150, bw, 130, kind, tag, nombre, sub, data_id=nid)
        if prev:
            e.arista(prev, nid, [(x - gap, 215), (x, 215)], "accent" if est != "hecha" else "muted")
        prev = nid
        det[nid] = _det(f"{tag} · {nombre}", "hecha" if est == "hecha" else "pendiente", sub.capitalize() + ".", [("Estado", "construida y en producción" if est == "hecha" else "siguiente entrega; ver PENDIENTES.md (P-09, P-10)")])
    e.zona(40, 360, 1300, 190, "Más adelante, sin fecha")
    futuros = [("f-play", "PLAY", "Google Play", "P-20"), ("f-pago", "PLANES", "Planes de pago", "P-21"), ("f-mon", "ALERTAS", "Monitoreo", "P-22"), ("f-ios", "IDEA", "Versión iOS", "P-29")]
    for i, (nid, tag, nombre, pid) in enumerate(futuros):
        e.nodo(nid, 70 + i * 315, 400, 270, 110, "optional", tag, nombre, pid, data_id=nid)
        det[nid] = _det(nombre, "pendiente", "Ver el detalle y la prioridad en docs/PENDIENTES.md.", [("ID", pid)])
    leyenda(e, 600, [("k-store", "construida"), ("k-focal", "siguiente"), ("k-optional", "idea o pendiente"), ("ar-accent", "camino al siguiente hito")])
    return e, det


# =====================================================================================================================
# TABLERO «QUÉ FALTA» (lee docs/PENDIENTES.md)
# =====================================================================================================================
def _limpia(t):
    t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)
    return t.replace("**", "").replace("`", "").strip()


def leer_pendientes():
    ruta = os.path.join(os.path.dirname(AQUI), "PENDIENTES.md")
    items, seccion = [], ""
    for ln in open(ruta, encoding="utf8"):
        m = re.match(r"##\s+\d+\.\s+(.*)", ln)
        if m:
            seccion = m.group(1).strip()
            continue
        c = [x.strip() for x in ln.strip().strip("|").split("|")]
        if len(c) == 4 and re.match(r"P-\d+", c[0]):
            items.append({"id": c[0], "texto": _limpia(c[1]), "prioridad": c[2], "estado": c[3], "seccion": seccion})
    return items


COLS = [("Por hacer", "Por hacer"), ("En curso", "En curso"), ("Esperando", "Esperando"), ("Hecho", "Hecho")]
KIND_PRIO = {"Alta": "focal", "Media": "backend", "Baja": "optional"}


def vista_pendientes(items):
    W, M, GAP = 2000, 40, 24
    u = (W - 2 * M - 3 * GAP - GAP) / 5
    ancho = {"Por hacer": 2 * u + GAP, "En curso": u, "Esperando": u, "Hecho": u}
    ch_card = 92
    por_col = {c: [i for i in items if i["estado"] == c] for c, _ in COLS}
    filas = max(-(-len(por_col["Por hacer"]) // 2), len(por_col["En curso"]), len(por_col["Esperando"]), len(por_col["Hecho"]))
    H = 150 + filas * (ch_card + 12) + 110
    e = Escena("pendientes", "Qué falta", "Tablero de lo pendiente, leído de docs/PENDIENTES.md.", W, H)
    det = {}
    x = M
    for c, _ in COLS:
        w = ancho[c]
        e.zona(x, 90, w, H - 90 - 90, f"{c} · {len(por_col[c])}")
        sub = 2 if c == "Por hacer" else 1
        cw = (w - 28 - (sub - 1) * 14) / sub
        for k, it in enumerate(por_col[c]):
            col, fila = (k % 2, k // 2) if sub == 2 else (0, k)
            kind = "store" if c == "Hecho" else KIND_PRIO.get(it["prioridad"], "backend")
            e.nodo(it["id"], x + 14 + col * (cw + 14), 120 + fila * (ch_card + 12), cw, ch_card, kind, f'{it["id"]} · {it["prioridad"].upper()}', it["texto"], it["seccion"], data_id=it["id"], tam_nombre=12.5, tam_sub=10)
            det[it["id"]] = _det(it["id"] + " · " + it["texto"][:60], it["seccion"], it["texto"], [("Prioridad", it["prioridad"]), ("Estado", it["estado"]), ("Sección", it["seccion"])])
        x += w + GAP
    leyenda(e, H - 36, [("k-focal", "prioridad alta"), ("k-backend", "prioridad media"), ("k-optional", "prioridad baja"), ("k-store", "hecho")])
    return e, det
