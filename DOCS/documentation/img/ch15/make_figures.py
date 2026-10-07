#!/usr/bin/env python3
"""Figures of chapter 15 (plugins, trust, signed catalogue).

    FIG_LANG=fr|en   language of the text drawn in the figures (default fr)
    IMG_DIR=<dir>    output folder (default: folder of this script)
    LUMEN_ROOT=<dir> repository root (default: three levels above this script)

Data figures (matrix, toolbar clusters, hash example) are computed from the real
js/modules/*/*/plugin.json files and from the real bytes of a plugin folder.
"""
import hashlib
import html
import json
import os
import pathlib

LANG = os.environ.get("FIG_LANG", "fr")
HERE = pathlib.Path(__file__).resolve().parent
OUT = pathlib.Path(os.environ.get("IMG_DIR", HERE))
ROOT = pathlib.Path(os.environ.get("LUMEN_ROOT", HERE.parents[3]))
OUT.mkdir(parents=True, exist_ok=True)

INK, INK2, LINE, BG = "#1c2333", "#4a5468", "#c5cbd8", "#f8f9fd"
C = {
    "blue": ("#3b5bdb", "#e8edff"), "green": ("#2b8a3e", "#ebfbee"),
    "amber": ("#e67700", "#fff4e6"), "violet": ("#7048e8", "#f3f0ff"),
    "teal": ("#0c8599", "#e3fafc"), "red": ("#c92a2a", "#fff0f0"),
    "grey": ("#4a5468", "#eef0f5"),
}


def L(fr, en):
    return fr if LANG == "fr" else en


def esc(s):
    return html.escape(str(s), quote=False)


class Svg:
    def __init__(self, h, title):
        self.h = h
        self.parts = []
        self.t(400, 32, title, 18, 800, anchor="middle")

    def rect(self, x, y, w, h, fill="#fff", stroke=LINE, rx=12, sw=1.2, dash=None):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')

    def t(self, x, y, s, size=13, weight=400, fill=INK, anchor="start", mono=False):
        fam = "ui-monospace, Menlo, Consolas, monospace" if mono else "Inter, sans-serif"
        self.parts.append(f'<text x="{x}" y="{y}" font-family="{fam}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}">{esc(s)}</text>')

    def lines(self, x, y, arr, size=12.5, fill=INK2, gap=17, anchor="start", weight=400, mono=False):
        for i, s in enumerate(arr):
            self.t(x, y + i * gap, s, size, weight, fill, anchor, mono)

    def card(self, x, y, w, h, color, head, body=(), size=12.5, bodycolor=INK2, headsize=13, gap=16.5):
        s, soft = C[color]
        self.rect(x, y, w, h, "#fff", LINE)
        self.parts.append(f'<path d="M{x},{y+34} V{y+12} Q{x},{y} {x+12},{y} H{x+w-12} Q{x+w},{y} {x+w},{y+12} V{y+34} Z" fill="{soft}"/>')
        self.t(x + w / 2, y + 22, head, headsize, 800, s, "middle")
        self.lines(x + w / 2, y + 62, body, size, bodycolor, gap, "middle")

    def pill(self, x, y, w, color, text, h=24, size=12):
        s, soft = C[color]
        self.rect(x, y, w, h, soft, s, h / 2, 1)
        self.t(x + w / 2, y + h / 2 + 4.3, text, size, 700, s, "middle")

    def arrow(self, x1, y1, x2, y2, color=INK2, w=2.2):
        self.parts.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="{w}" marker-end="url(#arr)"/>')

    def path(self, d, color=INK2, w=2.2):
        self.parts.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{w}" marker-end="url(#arr)"/>')

    def save(self, name):
        head = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 {self.h}" font-family="Inter, sans-serif">'
                '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
                '<path d="M0,0 L10,5 L0,10 z" fill="#4a5468"/></marker></defs>'
                f'<rect width="800" height="{self.h}" rx="16" fill="{BG}"/>')
        (OUT / name).write_text(head + "".join(self.parts) + "</svg>\n", encoding="utf-8")


def plugins():
    return [json.loads(f.read_text(encoding="utf-8")) for f in sorted((ROOT / "js/modules").glob("*/*/plugin.json"))]


def f_anatomie():
    s = Svg(400, L("Un plugin : un dossier, trois sortes de fichiers", "A plugin: one folder, three kinds of files"))
    s.rect(24, 60, 300, 300, "#fff")
    s.t(40, 86, "js/modules/tools/measure-distance/", 11.2, 700, INK, mono=True)
    rows = [("plugin.json", "blue", L("la carte d'identité", "the identity card")),
            ("index.js", "green", L("le comportement", "the behaviour")),
            ("lang/", "amber", L("les textes traduits", "the translated texts"))]
    y = 108
    for name, col, lab in rows:
        s.pill(44, y, 120, col, name, 26, 12.5)
        s.t(176, y + 18, lab, 12.5, 600, INK2)
        y += 40
    s.lines(60, 232, ["en.json  fr.json", "es.json  nl.json"], 12, INK2, 17, mono=True)
    s.t(44, 284, L("+ éventuellement : .css, .html,", "+ optionally: .css, .html,"), 12, 400, INK2)
    s.t(44, 301, L("images, workers…", "images, workers…"), 12, 400, INK2)
    s.t(44, 336, L("Le nom du dossier = l'id du plugin.", "Folder name = plugin id."), 12.5, 700, INK)
    outs = [("tools", "blue", L("Un bouton de la barre d'outils", "A toolbar button"), L("23 plugins · mesure, capture…", "23 plugins · measure, capture…")),
            ("channels", "green", L("Un réglage sous chaque canal", "A control under each channel"), L("2 plugins · histogramme, flou", "2 plugins · histogram, blur")),
            ("shaders", "violet", L("Une entrée du menu de rendu", "An entry of the render-mode menu"), L("3 plugins · fluorescence…", "3 plugins · fluorescence…"))]
    y = 62
    for pl, col, head, sub in outs:
        st, soft = C[col]
        s.rect(440, y, 336, 92, "#fff", LINE)
        s.rect(440, y, 100, 92, soft, LINE)
        s.t(490, y + 52, pl + "/", 14, 800, st, "middle", mono=True)
        s.t(552, y + 38, head, 12.5, 700, INK)
        s.t(552, y + 62, sub, 12, 400, INK2)
        s.arrow(332, 210, 436, y + 46, st)
        y += 104
    s.t(400, 388, L("Le dossier parent décide de ce que devient le plugin (son placement).", "The parent folder decides what the plugin becomes (its placement)."), 12.5, 600, INK2, "middle")
    s.save("anatomie.svg")


def f_decouverte():
    s = Svg(470, L("Découverte puis chargement : l'ordre est fixe", "Discovery then loading: the order is fixed"))
    src = [("violet", "api/plugins.php  /  api/plugins", L("liste + plugin.json complets + verdict de confiance", "list + full plugin.json + trust verdict"), L("d'abord", "first")),
           ("amber", "js/modules/manifest.json", L("seulement les chemins (hôtes statiques)", "paths only (static hosts)"), L("sinon", "else")),
           ("grey", L("liste embarquée (17 chemins)", "embedded list (17 paths)"), L("filet de sécurité : le viewer démarre toujours", "safety net: the viewer always starts"), L("sinon", "else"))]
    y = 56
    for col, name, sub, tag in src:
        s.rect(24, y, 360, 62, "#fff")
        s.pill(34, y + 8, 58, col, tag, 20, 11)
        s.t(100, y + 24, name, 12, 700, INK, mono=True)
        s.t(100, y + 46, sub, 11.5, 400, INK2)
        y += 72
    s.rect(430, 100, 346, 72, C["blue"][1], C["blue"][0])
    s.t(603, 128, "PluginRegistry.discover()", 14, 800, C["blue"][0], "middle", mono=True)
    s.t(603, 150, L("renvoie les chemins  tools/…  channels/…  shaders/…", "returns the paths  tools/…  channels/…  shaders/…"), 11, 400, INK2, "middle")
    for yy in (87, 159, 231):
        s.path(f"M388,{yy} C410,{yy} 410,136 426,136", INK2, 1.8)
    steps = [("loadModules", "blue", L("barrières + exécution", "gates + execution")),
             ("buildToolbarButtons", "green", L("boutons d'après plugin.json", "buttons from plugin.json")),
             ("prepareAll", "amber", L("état initial (avant les briques)", "initial state (before bricks)")),
             ("initAll", "violet", L("init(ctx) de chacun", "init(ctx) for each")),
             ("bindToolbarButtons", "teal", L("clic → activate()", "click → activate()"))]
    s.t(400, 300, L("Puis, dans cet ordre, côté page (viewer.js / 2d.js) :", "Then, in this order, on the page side (viewer.js / 2d.js):"), 13, 700, INK, "middle")
    for i, (name, col, sub) in enumerate(steps):
        xx = 24 + i * 152
        st, soft = C[col]
        s.rect(xx, 316, 144, 84, "#fff")
        s.rect(xx, 316, 144, 28, soft, LINE)
        s.t(xx + 72, 335, str(i + 1), 13, 800, st, "middle")
        s.t(xx + 72, 366, name, 10, 700, INK, "middle", mono=True)
        s.t(xx + 72, 386, sub, 10.3, 400, INK2, "middle")
        if i:
            s.arrow(xx - 7, 358, xx + 1, 358)
    s.rect(24, 418, 752, 40, C["red"][1], C["red"][0])
    s.t(400, 443, L("Règle d'or : discover + loadModules sont terminés AVANT de construire la moindre interface.", "Golden rule: discover + loadModules finish BEFORE any interface is built."), 12.3, 700, C["red"][0], "middle")
    s.save("decouverte.svg")


def f_barrieres():
    s = Svg(560, L("Les barrières de loadModules, dans l'ordre", "The loadModules gates, in order"))
    gates = [(L("plugin.json lisible, id = nom du dossier, placement = dossier", "plugin.json readable, id = folder name, placement = folder"), "red", L("quarantaine · invalid-meta", "quarantine · invalid-meta")),
             (L("platformCompat accepte la version de la plateforme", "platformCompat accepts the platform version"), "red", L("quarantaine · incompatible", "quarantine · incompatible")),
             (L("dataTypes couvre le type de la page (3d · 2d · live)", "dataTypes covers the page type (3d · 2d · live)"), "grey", L("laissé de côté (pas une faute)", "left out (not a fault)")),
             (L("contexts couvre le contexte (page ou panel)", "contexts covers the context (page or panel)"), "grey", L("laissé de côté (pas une faute)", "left out (not a fault)")),
             (L("confiance : empreinte relue = verdict du serveur", "trust: re-read hash = server verdict"), "red", L("quarantaine · untrusted", "quarantine · untrusted")),
             (L("voie d'exécution : iframe (sandboxed) ou page (Blob)", "execution lane: iframe (sandboxed) or page (Blob)"), "amber", L("quarantaine · sandbox-* / script-failed", "quarantine · sandbox-* / script-failed")),
             (L("implement() appelé, puis init(ctx) sans exception", "implement() called, then init(ctx) without exception"), "amber", L("quarantaine · no-impl / init-failed", "quarantine · no-impl / init-failed"))]
    y = 52
    for i, (g, col, out) in enumerate(gates):
        st, soft = C["blue"]
        s.rect(24, y, 470, 52, "#fff")
        s.rect(24, y, 44, 52, soft, LINE)
        s.t(46, y + 32, str(i + 1), 17, 800, st, "middle")
        s.t(78, y + 31, g, 12, 600, INK)
        ost, osoft = C[col]
        s.rect(530, y + 4, 246, 44, osoft, ost, 10)
        s.t(653, y + 31, out, 11, 700, ost, "middle")
        s.arrow(498, y + 26, 526, y + 26, ost, 1.8)
        if i < len(gates) - 1:
            s.arrow(259, y + 53, 259, y + 66, INK2, 1.8)
        y += 68
    s.t(259, 548, L("✔ le plugin est enregistré, son bouton est construit", "✔ the plugin is registered, its button is built"), 12.5, 700, C["green"][0], "middle")
    s.save("barrieres.svg")


def f_matrice():
    ps = plugins()
    order = {"tools": 0, "channels": 1, "shaders": 2}
    ps.sort(key=lambda p: (order[p["placement"]], p["id"]))
    rh = 17.5
    H = int(100 + len(ps) * rh + 30)
    s = Svg(H, L("Qui se charge où ? (28 plugins × type × contexte)", "What loads where? (28 plugins × type × context)"))
    cols = [("3d", "page"), ("3d", "panel"), ("live", "page"), ("live", "panel"), ("2d", "page"), ("2d", "panel")]
    x0, cw = 330, 74
    for i, (t, c) in enumerate(cols):
        x = x0 + i * cw
        col = {"3d": "blue", "live": "green", "2d": "amber"}[t]
        s.rect(x + 2, 50, cw - 4, 22, C[col][1], C[col][0], 6, 1)
        s.t(x + cw / 2, 65, t, 12, 800, C[col][0], "middle")
        s.t(x + cw / 2, 88, c, 11, 600, INK2, "middle")
    y = 108
    for k, p in enumerate(ps):
        dt, cx = p.get("dataTypes"), p.get("contexts")
        if k % 2 == 0:
            s.rect(24, y - 13, 752, rh, "#eef0f7", "none", 0, 0)
        s.t(32, y, p["id"], 11.3, 600, INK, mono=True)
        s.t(236, y, p["placement"], 10.5, 400, INK2)
        for i, (t, c) in enumerate(cols):
            ok_t = (t in dt) if isinstance(dt, list) else (t != "2d")
            ok_c = ((not isinstance(cx, list)) or ("page" in cx)) if c == "page" else (isinstance(cx, list) and "panel" in cx)
            ok = ok_t and ok_c
            s.t(x0 + i * cw + cw / 2, y, "●" if ok else "·", 12, 700, C["green"][0] if ok else "#aab1c2", "middle")
        y += rh
    s.t(400, H - 10, L("● = chargé    · = laissé de côté   (calculé d'après les plugin.json réels)", "● = loaded    · = left out   (computed from the real plugin.json files)"), 11.5, 600, INK2, "middle")
    s.save("matrice.svg")


def f_cycle():
    s = Svg(448, L("La vie d'un plugin dans la page", "A plugin's life in the page"))
    boxes = [(24, "registered", "grey", L("index.js exécuté", "index.js executed"), "implement(id, {…})"),
             (214, "initialized", "blue", L("contexte reçu", "context received"), "prepare → init(ctx)"),
             (404, "active", "green", L("outil ou bascule en marche", "tool or toggle running"), "activate()"),
             (594, "disposed", "violet", L("page quittée", "page left"), "dispose()")]
    for x, name, col, sub, hook in boxes:
        st, soft = C[col]
        s.rect(x, 70, 182, 104, "#fff")
        s.rect(x, 70, 182, 30, soft, LINE)
        s.t(x + 91, 91, name, 13, 800, st, "middle", mono=True)
        s.t(x + 91, 128, sub, 11.5, 400, INK2, "middle")
        s.pill(x + 11, 140, 160, col, hook, 24, 11)
    for xx in (206, 396, 586):
        s.arrow(xx, 122, xx + 6, 122)
    s.path("M495,178 C495,205 305,205 305,180", C["green"][0], 2)
    s.t(400, 216, L("deactivate() : retour à « initialized »", "deactivate(): back to “initialized”"), 11.5, 600, C["green"][0], "middle")
    st, soft = C["red"]
    s.rect(24, 236, 752, 50, soft, st)
    s.t(400, 258, "quarantined", 13, 800, st, "middle", mono=True)
    s.t(400, 277, L("implement() jamais appelé · init() qui lève une exception · retiré à chaud (révocation)", "implement() never called · init() throws · removed live (revocation)"), 11.5, 500, INK2, "middle")
    s.t(24, 316, L("Crochets facultatifs, appelés quand la page en a besoin :", "Optional hooks, called when the page needs them:"), 13, 700, INK)
    hooks = [("getState / setState", L("enregistrer / rétablir l'espace de travail", "save / restore the workspace")),
             ("reset", L("retour à l'état « dataset neuf »", "back to a fresh-dataset state")),
             ("onLanguageChange", L("repeindre les textes dynamiques", "repaint dynamic texts")),
             ("getExports / getGraph", L("alimenter le Centre de téléchargement", "feed the Download Center"))]
    for i, (h, d) in enumerate(hooks):
        x = 24 + (i % 2) * 380
        y = 330 + (i // 2) * 44
        s.rect(x, y, 372, 38, "#fff")
        s.t(x + 10, y + 24, h, 11, 700, C["blue"][0], mono=True)
        s.t(x + 166, y + 24, d, 10.5, 400, INK2)
    s.t(400, 438, L("Chaque appel est isolé par try/catch : un plugin en panne ne bloque jamais les autres.", "Every call is wrapped in try/catch: a failing plugin never blocks the others."), 12, 600, INK2, "middle")
    s.save("cycle-vie.svg")


def f_contexte():
    s = Svg(470, L("Ce que reçoit un plugin : l'objet ctx", "What a plugin receives: the ctx object"))
    cards = [("ctx.viewer", "blue", L("rendu : modes, coupe, vue,", "render: modes, clipping, view,"), "renderNow(), setView()…"),
             ("ctx.dataset", "green", "getMeta() · getId()", "getBasePath()"),
             ("ctx.channels", "amber", "getState() · setState()", L("couleur, fenêtre, gamma", "colour, window, gamma")),
             ("ctx.measurements", "violet", "list · add · update", "remove · clear · setAll"),
             ("ctx.ui", "teal", "toast · addSidebarSection", "addCanvasPanel · getCanvas"),
             ("ctx.tools", "blue", "current() · activate()", "onChange(cb)"),
             ("ctx.tracking", "green", "positionUm · cellsAt · pick", "select · on('frame'…)"),
             ("ctx.workspace", "amber", "getState() · applyState()", L("(espace de travail)", "(workspace)")),
             ("ctx.i18n", "violet", L("t('clé') → plugins.<id>.clé", "t('key') → plugins.<id>.key"), L("repli automatique sur l'anglais", "automatic English fallback")),
             ("ctx.slicer", "teal", L("coupe oblique : plan,", "oblique slice: plane,"), L("canvas d'aperçu", "preview canvas")),
             ("ctx.iframe", "grey", "isIframe() · panelIndex()", L("postMessage vers l'hôte", "postMessage to the host")),
             ("getCanvasBlob…", "red", "getCustomExports()", "getGraph() · _state")]
    for i, (n, col, a, b) in enumerate(cards):
        x = 24 + (i % 3) * 252
        y = 56 + (i // 3) * 98
        st, soft = C[col]
        s.rect(x, y, 244, 88, "#fff")
        s.rect(x, y, 244, 28, soft, LINE)
        s.t(x + 122, y + 19, n, 12.5, 800, st, "middle", mono=True)
        s.t(x + 122, y + 52, a, 11, 400, INK2, "middle")
        s.t(x + 122, y + 72, b, 11, 400, INK2, "middle")
    s.t(400, 456, L("Chaque plugin reçoit sa propre copie : seul ctx.i18n change (lié à l'id du plugin).", "Each plugin gets its own copy: only ctx.i18n differs (bound to the plugin id)."), 11.8, 600, INK2, "middle")
    s.save("contexte.svg")


def f_barre():
    ps = [p for p in plugins() if p["placement"] == "tools"]
    groups = [("tools", L("Outils", "Tools")), ("export", L("Exporter", "Export")), ("visuals", L("Visuels", "Visuals")), ("layouts", L("Dispositions", "Layouts"))]
    sub_col = {"tool": "blue", "toggle": "green", "action": "amber"}
    s = Svg(448, L("Les 23 plugins d'outils rangés dans les 4 grappes de la barre", "The 23 tool plugins placed in the toolbar's 4 clusters"))
    for gi, (g, lab) in enumerate(groups):
        x = 24 + (gi % 2) * 380
        y = 52 if gi < 2 else 182
        hh = 120 if gi < 2 else 190
        items = sorted([p for p in ps if p.get("group") == g], key=lambda p: p["order"])
        s.rect(x, y, 372, hh, "#fff")
        s.rect(x, y, 372, 28, C["grey"][1], LINE)
        s.t(x + 12, y + 19, f'{lab}  ·  group "{g}"', 12.5, 800, INK)
        for i, p in enumerate(items):
            st, soft = C[sub_col[p["subtype"]]]
            yy = y + 46 + i * 14.6
            s.rect(x + 12, yy - 9, 9, 9, soft, st, 2, 1.2)
            s.t(x + 28, yy, f'{p["order"]:>2}', 10.5, 600, INK2, mono=True)
            s.t(x + 52, yy, p["id"], 10.8, 600, INK, mono=True)
            dts = p.get("dataTypes")
            if dts:
                s.t(x + 360, yy, "/".join(dts), 10, 500, INK2, "end")
    ly = 396
    for i, (col, lab) in enumerate([("blue", L("tool : outil exclusif (chip)", "tool: exclusive tool (chip)")), ("green", L("toggle : bascule", "toggle: on/off switch")), ("amber", L("action : un clic, une fonction", "action: one click, one function"))]):
        x = 30 + i * 250
        st, soft = C[col]
        s.rect(x, ly, 12, 12, soft, st, 3, 1.4)
        s.t(x + 20, ly + 11, lab, 11.5, 600, INK2)
    s.t(400, 436, L("n° = champ order · à droite : dataTypes si déclaré · le bouton « Navigation » est statique", "no. = order field · right: dataTypes if declared · the “Navigate” button is static"), 10.8, 500, INK2, "middle")
    s.save("barre-outils.svg")


def f_arbre():
    s = Svg(600, L("Le serveur classe chaque plugin : le premier « oui » gagne", "The server classifies each plugin: the first “yes” wins"))
    qs = [(L("Tous ses fichiers figurent dans version.json (release), avec la même empreinte ?", "All its files are in version.json (release) with the same hash?"), "bundled", "green", L("exécuté dans la page", "runs in the page")),
          (L("Une approbation « bac à sable » valide (empreinte ET capacités) ?", "A valid “sandbox” approval (hash AND capabilities)?"), "sandboxed", "violet", L("exécuté dans l'iframe", "runs in the iframe")),
          (L("Mode développeur actif (--dev-trust-local) ?", "Developer mode on (--dev-trust-local)?"), "dev", "amber", L("exécuté dans la page", "runs in the page")),
          (L("Une approbation « in-page » valide (empreinte ET capacités) ?", "A valid “in-page” approval (hash AND capabilities)?"), "approved-trusted", "blue", L("exécuté dans la page", "runs in the page"))]
    s.pill(24, 50, 250, "grey", L("Un plugin se présente (un dossier)", "A plugin shows up (a folder)"), 26, 12)
    y = 94
    for i, (q, tier, col, lane) in enumerate(qs):
        st, soft = C[col]
        s.rect(24, y, 440, 62, "#fff", LINE)
        s.t(36, y + 36, str(i + 1), 15, 800, INK2)
        s.parts.append(f'<foreignObject x="56" y="{y+6}" width="400" height="52"><div xmlns="http://www.w3.org/1999/xhtml" style="font:600 12.2px Inter,sans-serif;color:{INK};line-height:1.35;padding-top:8px">{esc(q)}</div></foreignObject>')
        s.arrow(468, y + 31, 526, y + 31, st)
        s.t(497, y + 22, L("oui", "yes"), 11, 700, st, "middle")
        s.rect(530, y + 6, 246, 50, soft, st, 10)
        s.t(653, y + 28, tier, 13, 800, st, "middle", mono=True)
        s.t(653, y + 46, lane, 11, 500, INK2, "middle")
        s.arrow(244, y + 63, 244, y + 80, INK2, 1.8)
        s.t(256, y + 76, L("non", "no"), 11, 700, INK2)
        y += 82
    s.rect(24, 422, 440, 54, C["red"][1], C["red"][0])
    s.t(244, 446, "untrusted", 14, 800, C["red"][0], "middle", mono=True)
    s.t(244, 465, L("absent de la découverte : son code n'est jamais chargé", "absent from discovery: its code is never loaded"), 11.5, 600, INK2, "middle")
    s.rect(24, 494, 752, 90, "#fff", LINE)
    s.t(36, 516, L("Ensuite, côté navigateur :", "Then, in the browser:"), 12.5, 800, INK)
    s.lines(36, 538, [L("• il relit les octets exacts et recalcule l'empreinte : différente du verdict → untrusted ;", "• it re-reads the exact bytes and recomputes the hash: different from the verdict → untrusted;"),
                      L("• plugin.json avec  \"sandbox\": true  : les niveaux ci-dessus décident SEULEMENT s'il se charge ;", "• plugin.json with  \"sandbox\": true : the tiers above decide ONLY whether it loads;"),
                      L("   il tourne alors toujours dans l'iframe (niveau affiché : sandboxed).", "   it then always runs in the iframe (tier shown: sandboxed).")], 11.3, INK2, 17)
    s.save("arbre-confiance.svg")


def f_empreinte():
    d = ROOT / "js/modules/tools/toggle-grid"
    EXT = (".js", ".json", ".mjs", ".css", ".html")
    fh = {}
    for p in sorted(d.rglob("*")):
        if p.is_file() and p.suffix.lower() in EXT and not p.name.startswith("."):
            fh[p.relative_to(d).as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()

    def comp(f):
        return hashlib.sha256(("lumen-plugin-trust/1\n" + "\n".join(f"{k}:{f[k]}" for k in sorted(f))).encode()).hexdigest()

    h1 = comp(fh)
    alt = dict(fh)
    alt["index.js"] = hashlib.sha256((d / "index.js").read_bytes() + b" ").hexdigest()
    h2 = comp(alt)
    s = Svg(430, L("L'empreinte d'un plugin (exemple réel : toggle-grid)", "A plugin's fingerprint (real example: toggle-grid)"))
    s.t(24, 62, L("① une empreinte par fichier (SHA-256 des octets)", "① one hash per file (SHA-256 of the bytes)"), 12.5, 800, C["blue"][0])
    y = 84
    for k, v in fh.items():
        s.rect(24, y - 13, 330, 20, "#fff", LINE, 6, 1)
        s.t(32, y + 1, k, 11.3, 600, INK, mono=True)
        s.t(346, y + 1, v[:12] + "…", 11.3, 500, C["amber"][0], "end", mono=True)
        y += 24
    s.t(400, 62, L("② on trie et on assemble", "② sort and assemble"), 12.5, 800, C["blue"][0])
    s.rect(392, 72, 384, 148, "#fff", LINE)
    lines = ["lumen-plugin-trust/1"] + [f"{k}:{fh[k][:10]}…" for k in sorted(fh)]
    s.lines(402, 92, lines, 11, INK2, 18, mono=True)
    s.arrow(358, 130, 388, 130)
    s.rect(24, 236, 752, 60, C["green"][1], C["green"][0])
    s.t(40, 258, L("③ SHA-256 de l'ensemble = empreinte du plugin", "③ SHA-256 of the whole = plugin fingerprint"), 12.5, 800, C["green"][0])
    s.t(40, 282, h1[:32] + "…", 15, 700, INK, mono=True)
    s.rect(24, 312, 752, 80, C["red"][1], C["red"][0])
    s.t(40, 334, L("④ on ajoute UN espace à la fin de index.js…", "④ add ONE space at the end of index.js…"), 12.5, 800, C["red"][0])
    s.t(40, 358, h2[:32] + "…", 15, 700, INK, mono=True)
    s.t(40, 380, L("→ une tout autre empreinte : toute approbation liée à l'ancienne devient caduque.", "→ a completely different fingerprint: any approval tied to the old one is void."), 12, 600, INK2)
    s.t(400, 416, L("Douze caractères suffisent à l'œil ; le contrôle compare les 64.", "Twelve characters are enough for the eye; the check compares all 64."), 11.5, 500, INK2, "middle")
    s.save("empreinte.svg")


def f_sandbox():
    s = Svg(560, L("Le bac à sable : un guichet blindé avec un interphone", "The sandbox: an armoured counter with an intercom"))
    s.rect(24, 52, 220, 420, "#fff")
    s.rect(24, 52, 220, 30, C["blue"][1], LINE)
    s.t(134, 72, L("La page (hôte)", "The page (host)"), 13, 800, C["blue"][0], "middle")
    s.lines(40, 110, ["PluginSandbox", L("• vérifie chaque message", "• checks every message"), L("• garde ctx (jamais remis)", "• keeps ctx (never handed over)"), L("• répond par des copies", "• replies with copies")], 11.5, INK2, 20)
    s.rect(556, 52, 220, 420, C["violet"][1], C["violet"][0], 12, 1.5, "6 4")
    s.rect(556, 52, 220, 30, "#fff", C["violet"][0])
    s.t(666, 72, 'iframe sandbox="allow-scripts"', 10.6, 800, C["violet"][0], "middle", mono=True)
    s.lines(570, 110, [L("origine « null »", "“null” origin"), L("pas de DOM de la page", "no page DOM"), L("ni cookies ni stockage", "no cookies, no storage"), L("aucun réseau (connect-src 'none')", "no network (connect-src 'none')"), L("ni worker ni sous-cadre", "no worker, no sub-frame"), "", "window.LumenPlugin", L("(le seul objet disponible)", "(the only object available)")], 11.2, INK2, 20)
    msgs = [(112, "→", "1  ready", L("le cadre est prêt", "the frame is ready")),
            (152, "←", "2  init", L("infos publiques + textes", "public info + texts")),
            (192, "←", "3  activate", L("après un VRAI clic", "after a REAL click")),
            (232, "→", "4  req viewer.getCanvasBlob", L("+ jeton du cadre", "+ frame token")),
            (272, "←", "5  res  ok | forbidden | busy", L("copie « à plat »", "flat copy")),
            (312, "→", "6  req ui.download", L("≤ 1,5 s après le clic", "≤ 1.5 s after the click")),
            (352, "←", "7  ping", L("toutes les 1,5 s", "every 1.5 s")),
            (392, "→", "8  pong", L("sinon cadre détruit (~ 6 s)", "else frame destroyed (~ 6 s)"))]
    for y, d, name, sub in msgs:
        if d == "→":
            s.arrow(552, y, 250, y, C["violet"][0], 2)
        else:
            s.arrow(250, y, 552, y, C["blue"][0], 2)
        s.t(400, y - 8, name, 11.2, 700, INK, "middle", mono=True)
        s.t(400, y + 16, sub, 10.8, 400, INK2, "middle")
    s.rect(24, 486, 752, 64, "#fff", LINE)
    s.t(36, 506, L("Contrôles de l'hôte sur chaque message reçu :", "Host checks on every incoming message:"), 12, 800, INK)
    s.t(36, 525, L("espace 'lumen-plugin' → fenêtre émettrice connue → origine 'null' → jeton → débit (40 + 20/s) → capacité accordée", "namespace 'lumen-plugin' → known sender window → 'null' origin → token → rate (40 + 20/s) → capability granted"), 10.3, 500, INK2)
    s.t(36, 541, L("Capacité non accordée : réponse « forbidden » et compteur d'abus (> 50 en 10 s : cadre détruit).", "Capability not granted: “forbidden” reply and abuse counter (> 50 in 10 s: frame destroyed)."), 10.3, 500, INK2)
    s.save("bac-a-sable.svg")


def f_signatures():
    s = Svg(500, L("Deux clés, deux chaînes de signatures", "Two keys, two signature chains"))
    lanes = [(56, "blue", L("Clé des releases (le logiciel)", "Release key (the software)"), "LUMEN_SIGNING_KEY (CI)",
              "_RELEASE_PUBKEY_HEX · LUMEN_RELEASE_PUBKEY · install.php",
              [("SHA256SUMS.sig", L("signe la liste des empreintes", "signs the hash list")), ("lumen3d-web-X.Y.Z.zip", L("la plateforme, sans les plugins", "the platform, without plugins"))]),
             (270, "violet", L("Clé du catalogue (les plugins)", "Catalogue key (the plugins)"), "LUMEN_MARKETPLACE_SIGNING_KEY",
              "_MARKETPLACE_PUBKEY_HEX · MARKETPLACE_PUBKEY",
              [("catalog.json.sig", L("signe le catalogue (+ serial)", "signs the catalogue (+ serial)")), ("plugin-<id>-<ver>.zip", L("un zip par plugin", "one zip per plugin"))])]
    for y, col, title, priv, pub, items in lanes:
        st, soft = C[col]
        s.rect(24, y, 752, 198, "#fff")
        s.rect(24, y, 752, 30, soft, LINE)
        s.t(40, y + 20, title, 13, 800, st)
        s.rect(40, y + 44, 210, 66, soft, st, 10)
        s.t(145, y + 66, L("clé PRIVÉE (graine)", "PRIVATE key (seed)"), 12, 800, st, "middle")
        s.t(145, y + 85, priv, 9, 500, INK2, "middle", mono=True)
        s.t(145, y + 101, L("chez l'éditeur seulement", "publisher only"), 10.5, 400, INK2, "middle")
        s.arrow(254, y + 78, 298, y + 78, st)
        s.t(276, y + 66, L("signe", "signs"), 10.5, 700, st, "middle")
        for i, (a, b) in enumerate(items):
            xx = 302 + i * 236
            s.rect(xx, y + 44, 226, 66, "#fff", st, 10)
            s.t(xx + 113, y + 68, a, 10.6, 700, INK, "middle", mono=True)
            s.t(xx + 113, y + 90, b, 9.6, 400, INK2, "middle")
        s.rect(40, y + 126, 720, 56, "#fff", LINE)
        s.t(52, y + 146, L("clé PUBLIQUE épinglée dans le code source, livrée avec chaque version :", "PUBLIC key pinned in the source code, shipped with every release:"), 11.5, 700, INK)
        s.t(52, y + 166, pub, 10.4, 500, INK2, mono=True)
    s.t(400, 262, "≠", 22, 800, C["red"][0], "middle")
    s.t(400, 488, L("Perdre l'une ne compromet pas l'autre. Clé vide dans le code = authenticité non prouvée (avertissement).", "Losing one does not compromise the other. Empty key in the code = authenticity not proven (warning)."), 11, 600, INK2, "middle")
    s.save("chaine-signatures.svg")


def f_installation():
    s = Svg(520, L("Installer un plugin du catalogue : dix contrôles, tout ou rien", "Installing a catalogue plugin: ten checks, all or nothing"))
    steps = [L("Mot de passe\nadmin re-saisi", "Admin password\nre-entered"),
             L("Catalogue lu,\nsignature Ed25519\nvérifiée", "Catalogue read,\nEd25519 signature\nverified"),
             L("Serial ≥ le plus\nhaut déjà vu", "Serial ≥ highest\nalready seen"),
             L("Entrée trouvée,\nplatformCompat\nsatisfait", "Entry found,\nplatformCompat\nsatisfied"),
             L("Zip téléchargé\n(≤ 8 Mio)", "Zip downloaded\n(≤ 8 MiB)"),
             L("sha256 du zip =\nsha256 du\ncatalogue signé", "zip sha256 =\nsigned catalogue\nsha256"),
             L("Extraction\ndurcie (≤ 500\nentrées, 24 Mio)", "Hardened\nextraction (≤ 500\nentries, 24 MiB)"),
             L("plugin.json :\nid et placement\n= catalogue", "plugin.json:\nid and placement\n= catalogue"),
             L("Dossier échangé\n(ancienne copie\nmise de côté)", "Folder swapped\n(old copy\nparked)"),
             L("Approbation\népinglée sur le\nhash du disque", "Approval pinned\nto the on-disk\nhash")]
    for i, t in enumerate(steps):
        r, c = divmod(i, 5)
        x = 24 + c * 152
        y = 56 + r * 150
        st, soft = C["blue" if i < 4 else ("amber" if i < 8 else "green")]
        s.rect(x, y, 140, 112, "#fff")
        s.rect(x, y, 140, 28, soft, LINE)
        s.t(x + 70, y + 20, str(i + 1), 14, 800, st, "middle")
        s.lines(x + 70, y + 56, t.split("\n"), 11, INK, 16, "middle", 600)
        if c < 4:
            s.arrow(x + 141, y + 56, x + 151, y + 56, INK2, 1.8)
    s.rect(24, 360, 752, 58, C["red"][1], C["red"][0])
    s.t(400, 384, L("Un seul contrôle qui échoue → js/modules/ est remis exactement comme avant", "Any single check failing → js/modules/ is put back exactly as before"), 13, 800, C["red"][0], "middle")
    s.t(400, 404, L("(pour une mise à jour : l'ancienne version, mise de côté, est remise en place)", "(for an upgrade: the old version, parked aside, is put back)"), 11.5, 500, INK2, "middle")
    s.rect(24, 434, 752, 70, "#fff", LINE)
    s.t(36, 456, L("Mode choisi à l'étape 10 :", "Mode chosen at step 10:"), 12, 800, INK)
    s.t(36, 476, L("« bac à sable » si plugin.json dit sandbox: true (ou outil avec capacités déclarées) ;", "“sandbox” if plugin.json says sandbox: true (or a tool with declared capabilities);"), 11, 500, INK2)
    s.t(36, 493, L("sinon « in-page » (obligatoire pour les canaux et les modes de rendu).", "otherwise “in-page” (mandatory for channels and render modes)."), 11, 500, INK2)
    s.save("installation.svg")


def f_maj():
    s = Svg(332, L("Mettre à jour la plateforme : les plugins incompatibles s'effacent", "Updating the platform: incompatible plugins step aside"))
    cols = [("blue", L("1 · Avant (rapport)", "1 · Before (report)"), [L("pour chaque plugin :", "for each plugin:"), L("platformCompat accepte", "platformCompat accepts"), L("la version CIBLE ?", "the TARGET version?"), L("→ ok  ou  willQuarantine", "→ ok  or  willQuarantine"), L("blocage si plus aucun", "blocked if no render"), L("mode de rendu ne reste", "mode would remain")]),
            ("amber", L("2 · Après le basculement", "2 · After the swap"), [L("chaque découverte refiltre :", "each discovery re-filters:"), L("incompatible → absent de", "incompatible → absent from"), L("la liste, fichiers intacts", "the list, files intact"), L("l'admin donne la raison", "the admin gives the reason"), L("(étiquette « incompatible »)", "(“incompatible” label)")]),
            ("green", L("3 · Plus tard", "3 · Later"), [L("une nouvelle version du", "a new version of the"), L("plugin (catalogue) ou de", "plugin (catalogue) or of"), L("la plateforme le rend", "the platform makes it"), L("compatible → il revient", "compatible → it comes"), L("tout seul, sans réinstaller", "back, no reinstall")])]
    for i, (col, head, body) in enumerate(cols):
        x = 24 + i * 254
        s.card(x, 56, 242, 180, col, head, body, 11.6, INK2, 13, 20)
        if i < 2:
            s.arrow(x + 244, 146, x + 252, 146)
    s.rect(24, 256, 752, 56, C["violet"][1], C["violet"][0])
    s.t(400, 280, L("Les plugins tiers déposés par l'opérateur survivent aux mises à jour", "Third-party plugins dropped by the operator survive updates"), 12.5, 800, C["violet"][0], "middle")
    s.t(400, 300, L("(seuls les fichiers de la release précédente sont remplacés ; le magasin d'approbations est protégé)", "(only the previous release's files are replaced; the approval store is protected)"), 11, 500, INK2, "middle")
    s.save("mise-a-jour.svg")


if __name__ == "__main__":
    for fn in (f_anatomie, f_decouverte, f_barrieres, f_matrice, f_cycle, f_contexte, f_barre, f_arbre, f_empreinte, f_sandbox, f_signatures, f_installation, f_maj):
        fn()
    print("ok", LANG, OUT)
