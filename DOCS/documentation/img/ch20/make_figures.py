#!/usr/bin/env python3
"""Figures of chapter 20 (Annexes).

    FIG_LANG=fr IMG_DIR=DOCS/documentation/img/ch20    python3 make_figures.py
    FIG_LANG=en IMG_DIR=DOCS/documentation/img-en/ch20 python3 make_figures.py

Writes carte-modules.svg, memoires.svg, limites.svg and chronologie.svg.
"""
import os
from xml.sax.saxutils import escape

LANG = os.environ.get("FIG_LANG", "fr")
OUT = os.environ.get("IMG_DIR", os.path.dirname(os.path.abspath(__file__)))
os.makedirs(OUT, exist_ok=True)

INK, SUB, LINE, BG = "#1c2333", "#4a5468", "#c5cbd8", "#f8f9fd"
PAL = {
    "blue": ("#3b5bdb", "#e8edff"), "green": ("#2b8a3e", "#ebfbee"),
    "amber": ("#e67700", "#fff4e6"), "violet": ("#7048e8", "#f3f0ff"),
    "teal": ("#0c8599", "#e3fafc"), "red": ("#c92a2a", "#fff0f0"),
}

TX = {
    "fr": {
        "m_title": "Carte des modules : qui appelle qui ?",
        "m_pages": ("Pages", "js/pages/", "Le chef d'orchestre de chaque page"),
        "m_pages_f": "viewer · explorer · compare · 2d · landing · admpan (+ 27 modules d'admin)",
        "m_comp": ("Composants", "js/components/", "Les morceaux d'interface réutilisables"),
        "m_comp_f": "panneau des canaux · frise · Studio · galerie · décomposition",
        "m_view": ("Viewers", "js/viewers/", "Ceux qui dessinent"),
        "m_view_f": "volume-viewer · volume-slicer · volume-grid · tracking-overlay · 2d-viewer",
        "m_core": ("Noyau", "js/core/", "Les services partagés par toutes les pages"),
        "m_core_f": "brick-loader · svr-manager · catalog · i18n · plugin-registry · url-state · …",
        "m_work": ("Workers", "js/workers/", "Les calculs lourds, en arrière-plan"),
        "m_work_l": ["décodage des briques", "envoi des fichiers", "conversion des données", "flou gaussien", "plans, suivi, 2D"],
        "m_plug": ("Plugins", "js/modules/", "Les outils, canaux et rendus"),
        "m_plug_l": ["installés depuis", "le catalogue signé"],
        "m_foot": "Une flèche = « s'appuie sur ». Les pages ne dessinent rien elles-mêmes : elles confient le rendu aux viewers.",
        "b_title": "Où vit chaque mémoire ? Quatre endroits",
        "b1": ("Ce navigateur", "localStorage", ["thème, langue, daltonisme", "espaces de travail", "échelle Z, vitesse", "budget mémoire graphique", "réglages de l'admin"], "reste après fermeture"),
        "b2": ("Cet onglet", "sessionStorage", ["visite déjà comptée", "vue déjà comptée", "presse-papiers de widget"], "s'efface à la fermeture"),
        "b3": ("L'adresse", "URL", ["?id=  ?quality=  ?type=", "?slug=  ?add=  ?mode=", "#state= : la vue complète"], "se copie, se partage"),
        "b4": ("Le serveur", "cookie + fichiers", ["cookie de session (8 h)", "config/, api/stats.json", "DATA_WEB/, uploads/"], "commun à tous"),
        "b_foot": "Un visiteur anonyme n'écrit rien sur le serveur, sauf trois compteurs anonymes.",
        "l_title": "Ce que Lumen3D ne fait pas",
        "l_items": [
            ("📏", "Pas de quantification", "calibrée de l'intensité"),
            ("🎨", "4 canaux affichés", "au maximum"),
            ("🔬", "Pas de déconvolution", "ni de champ plat"),
            ("🧩", "Pas de segmentation", "ni de détection de cellules"),
            ("✏️", "Pas d'édition", "de vos voxels"),
            ("🌓", "Pas de compensation", "du photoblanchiment"),
            ("👥", "Un seul compte", "administrateur"),
            ("🖥️", "WebGL2 obligatoire", "dans le navigateur"),
        ],
        "l_foot": "Lumen3D montre et mesure les distances ; l'analyse quantitative reste dans vos outils d'analyse.",
        "t_title": "Les grandes étapes de la plateforme et du pipeline",
        "t_web": "Plateforme web",
        "t_pipe": "Pipeline de préparation",
        "t_w": [
            ("1.5", "mise à jour sûre,\n1re version publique"),
            ("1.7", "versions signées\n(Ed25519)"),
            ("1.12", "marque blanche,\ncatalogue de plugins"),
            ("1.31", "le suivi cellulaire\nest dessiné"),
            ("1.43", "import dans\nle navigateur"),
            ("1.47", "photographies 2D"),
            ("1.51", "types 3d · 2d · live"),
            ("1.57", "budget mémoire,\nstreaming réécrit"),
            ("1.58", "mises à jour\ndes données"),
            ("1.59", "formats 3 et 4"),
        ],
        "t_p": [
            ("0.12", "fond par percentile\ndes coins"),
            ("0.15", "séries 4D"),
            ("0.16", "suivi cellulaire\nautomatique"),
            ("0.17", "importeur de\nphotographies"),
            ("0.19", "publication\ntout ou rien"),
            ("0.20", "plans XY (format 2)"),
            ("0.21", "format 4\ndirectement"),
        ],
        "t_now": "aujourd'hui : web 1.59.3 · pipeline 0.21.0",
    },
    "en": {
        "m_title": "Module map: who calls whom?",
        "m_pages": ("Pages", "js/pages/", "The conductor of each page"),
        "m_pages_f": "viewer · explorer · compare · 2d · landing · admpan (+ 27 admin modules)",
        "m_comp": ("Components", "js/components/", "Reusable interface pieces"),
        "m_comp_f": "channel panel · timeline · Studio · gallery · decomposition",
        "m_view": ("Viewers", "js/viewers/", "The ones that draw"),
        "m_view_f": "volume-viewer · volume-slicer · volume-grid · tracking-overlay · 2d-viewer",
        "m_core": ("Core", "js/core/", "Services shared by every page"),
        "m_core_f": "brick-loader · svr-manager · catalog · i18n · plugin-registry · url-state · …",
        "m_work": ("Workers", "js/workers/", "Heavy computing, in the background"),
        "m_work_l": ["brick decoding", "file upload", "data conversion", "gaussian blur", "planes, tracking, 2D"],
        "m_plug": ("Plugins", "js/modules/", "Tools, channels and render modes"),
        "m_plug_l": ["installed from", "the signed catalogue"],
        "m_foot": "An arrow means 'relies on'. Pages draw nothing themselves: they hand rendering to the viewers.",
        "b_title": "Where does each memory live? Four places",
        "b1": ("This browser", "localStorage", ["theme, language, filters", "workspaces", "Z scale, speed", "graphics memory budget", "admin settings"], "stays after closing"),
        "b2": ("This tab", "sessionStorage", ["visit already counted", "view already counted", "widget clipboard"], "cleared on close"),
        "b3": ("The address", "URL", ["?id=  ?quality=  ?type=", "?slug=  ?add=  ?mode=", "#state= : the whole view"], "copy it, share it"),
        "b4": ("The server", "cookie + files", ["session cookie (8 h)", "config/, api/stats.json", "DATA_WEB/, uploads/"], "common to everyone"),
        "b_foot": "An anonymous visitor writes nothing on the server, except three anonymous counters.",
        "l_title": "What Lumen3D does not do",
        "l_items": [
            ("📏", "No calibrated", "intensity quantification"),
            ("🎨", "4 channels shown", "at most"),
            ("🔬", "No deconvolution", "nor flat-field correction"),
            ("🧩", "No segmentation", "nor cell detection"),
            ("✏️", "No editing", "of your voxels"),
            ("🌓", "No photobleaching", "compensation"),
            ("👥", "A single", "administrator account"),
            ("🖥️", "WebGL2 required", "in the browser"),
        ],
        "l_foot": "Lumen3D shows and measures distances; quantitative analysis stays in your analysis tools.",
        "t_title": "The platform and pipeline milestones",
        "t_web": "Web platform",
        "t_pipe": "Preprocessing pipeline",
        "t_w": [
            ("1.5", "safe update,\nfirst public release"),
            ("1.7", "signed releases\n(Ed25519)"),
            ("1.12", "white label,\nplugin catalogue"),
            ("1.31", "cell tracking\nis drawn"),
            ("1.43", "import in\nthe browser"),
            ("1.47", "2D photographs"),
            ("1.51", "types 3d · 2d · live"),
            ("1.57", "memory budget,\nstreaming rewritten"),
            ("1.58", "data updates"),
            ("1.59", "formats 3 and 4"),
        ],
        "t_p": [
            ("0.12", "background from\ncorner percentile"),
            ("0.15", "4D series"),
            ("0.16", "automatic cell\ntracking"),
            ("0.17", "photograph\nimporter"),
            ("0.19", "all-or-nothing\npublish"),
            ("0.20", "XY planes (format 2)"),
            ("0.21", "format 4\ndirectly"),
        ],
        "t_now": "today: web 1.59.3 · pipeline 0.21.0",
    },
}[LANG]


def head(h):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 {h}" font-family="Inter, sans-serif">\n'
            '<defs>'
            f'<marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="{SUB}"/></marker>'
            f'</defs>\n<rect width="800" height="{h}" rx="16" fill="{BG}"/>\n')


def title(s):
    return f'<text x="400" y="32" text-anchor="middle" font-size="18" font-weight="800" fill="{INK}">{escape(s)}</text>\n'


def arrow(x1, y1, x2, y2):
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{SUB}" stroke-width="2.2" marker-end="url(#arr)"/>\n'


def foot(h, s, size=12.5):
    return f'<text x="400" y="{h - 14}" text-anchor="middle" font-size="{size}" font-weight="700" fill="{INK}">{escape(s)}</text>\n'


def fig_modules():
    h = 436
    s = head(h) + title(TX["m_title"])
    layers = [("m_pages", "m_pages_f", "violet", 52), ("m_comp", "m_comp_f", "teal", 138),
              ("m_view", "m_view_f", "blue", 224), ("m_core", "m_core_f", "green", 310)]
    for k, kf, c, y in layers:
        st, so = PAL[c]
        name, path, role = TX[k]
        s += f'<rect x="24" y="{y}" width="548" height="74" rx="12" fill="{so}" stroke="{st}" stroke-width="1.6"/>\n'
        s += f'<text x="40" y="{y + 25}" font-size="15" font-weight="800" fill="{st}">{escape(name)}</text>\n'
        s += f'<text x="{40 + 8 * len(name) + 22}" y="{y + 25}" font-size="12" fill="{SUB}" font-family="monospace">{escape(path)}</text>\n'
        s += f'<text x="40" y="{y + 46}" font-size="12.5" fill="{INK}">{escape(role)}</text>\n'
        s += f'<text x="40" y="{y + 64}" font-size="11.5" fill="{SUB}">{escape(TX[kf])}</text>\n'
    for y in (126, 212, 298):
        s += arrow(298, y - 0, 298, y + 12)
    # workers + plugins column
    st, so = PAL["amber"]
    name, path, role = TX["m_work"]
    s += f'<rect x="596" y="52" width="180" height="214" rx="12" fill="{so}" stroke="{st}" stroke-width="1.6"/>\n'
    s += f'<text x="686" y="78" text-anchor="middle" font-size="15" font-weight="800" fill="{st}">{escape(name)}</text>\n'
    s += f'<text x="686" y="96" text-anchor="middle" font-size="12" fill="{SUB}" font-family="monospace">{escape(path)}</text>\n'
    s += f'<text x="686" y="118" text-anchor="middle" font-size="11.5" fill="{INK}">{escape(role)}</text>\n'
    for i, t in enumerate(TX["m_work_l"]):
        s += f'<text x="686" y="{146 + i * 22}" text-anchor="middle" font-size="12.5" fill="{INK}">• {escape(t)}</text>\n'
    st, so = PAL["red"]
    name, path, role = TX["m_plug"]
    s += f'<rect x="596" y="282" width="180" height="102" rx="12" fill="{so}" stroke="{st}" stroke-width="1.6"/>\n'
    s += f'<text x="686" y="308" text-anchor="middle" font-size="15" font-weight="800" fill="{st}">{escape(name)}</text>\n'
    s += f'<text x="686" y="326" text-anchor="middle" font-size="12" fill="{SUB}" font-family="monospace">{escape(path)}</text>\n'
    for i, t in enumerate(TX["m_plug_l"]):
        s += f'<text x="686" y="{350 + i * 18}" text-anchor="middle" font-size="12.5" fill="{INK}">{escape(t)}</text>\n'
    s += arrow(572, 347, 594, 347) + arrow(572, 160, 594, 160)
    s += foot(h, TX["m_foot"], 12)
    return s + "</svg>\n"


def fig_memories():
    h = 400
    s = head(h) + title(TX["b_title"])
    cols = [("b1", "blue"), ("b2", "teal"), ("b3", "violet"), ("b4", "amber")]
    for i, (k, c) in enumerate(cols):
        x = 24 + i * 190
        st, so = PAL[c]
        name, kind, items, note = TX[k]
        s += f'<rect x="{x}" y="56" width="178" height="276" rx="12" fill="{so}" stroke="{st}" stroke-width="1.6"/>\n'
        s += f'<text x="{x + 89}" y="86" text-anchor="middle" font-size="15" font-weight="800" fill="{st}">{escape(name)}</text>\n'
        s += f'<text x="{x + 89}" y="106" text-anchor="middle" font-size="12" fill="{SUB}" font-family="monospace">{escape(kind)}</text>\n'
        for j, t in enumerate(items):
            s += f'<text x="{x + 12}" y="{140 + j * 30}" font-size="11.5" fill="{INK}">• {escape(t)}</text>\n'
        s += f'<rect x="{x + 14}" y="298" width="150" height="24" rx="12" fill="#fff" stroke="{st}"/>\n'
        s += f'<text x="{x + 89}" y="315" text-anchor="middle" font-size="11.5" font-weight="700" fill="{st}">{escape(note)}</text>\n'
    s += foot(h - 8, TX["b_foot"], 12.5)
    return s + "</svg>\n"


def fig_limits():
    h = 380
    s = head(h) + title(TX["l_title"])
    for i, (ico, a, b) in enumerate(TX["l_items"]):
        col, row = i % 4, i // 4
        x, y = 24 + col * 190, 62 + row * 130
        st, so = PAL["red"] if i in (0, 3, 4, 5) else PAL["amber"]
        s += f'<rect x="{x}" y="{y}" width="178" height="116" rx="12" fill="{so}" stroke="{st}" stroke-width="1.6"/>\n'
        s += f'<text x="{x + 89}" y="{y + 44}" text-anchor="middle" font-size="30">{ico}</text>\n'
        s += f'<text x="{x + 89}" y="{y + 72}" text-anchor="middle" font-size="12.5" font-weight="800" fill="{st}">{escape(a)}</text>\n'
        s += f'<text x="{x + 89}" y="{y + 92}" text-anchor="middle" font-size="12" fill="{INK}">{escape(b)}</text>\n'
    s += foot(h, TX["l_foot"], 12.5)
    return s + "</svg>\n"


def _track(y, items, color, above_first=True, label=None):
    st, so = PAL[color]
    n = len(items)
    x0, x1 = 84, 716
    out = f'<line x1="{x0 - 20}" y1="{y}" x2="{x1 + 30}" y2="{y}" stroke="{st}" stroke-width="3"/>\n'
    for i, (ver, cap) in enumerate(items):
        x = x0 + (x1 - x0) * i / (n - 1)
        up = (i % 2 == 0) == above_first
        out += f'<circle cx="{x}" cy="{y}" r="8" fill="{st}"/>\n'
        out += f'<text x="{x}" y="{y + (-16 if up else 28)}" text-anchor="middle" font-size="14" font-weight="800" fill="{st}">{escape(ver)}</text>\n'
        for j, ln in enumerate(cap.split("\n")):
            yy = (y - 32 - (len(cap.split("\n")) - 1 - j) * 14) if up else (y + 44 + j * 14)
            out += f'<text x="{x}" y="{yy}" text-anchor="middle" font-size="11.5" fill="{INK}">{escape(ln)}</text>\n'
    return out


def fig_timeline():
    h = 440
    s = head(h) + title(TX["t_title"])
    s += f'<text x="30" y="62" font-size="13" font-weight="800" fill="{PAL["blue"][0]}">{escape(TX["t_web"])}</text>\n'
    s += _track(150, TX["t_w"], "blue", above_first=True)
    s += f'<text x="30" y="262" font-size="13" font-weight="800" fill="{PAL["green"][0]}">{escape(TX["t_pipe"])}</text>\n'
    s += _track(340, TX["t_p"], "green", above_first=True)
    s += foot(h, TX["t_now"], 12.5)
    return s + "</svg>\n"


for name, fn in (("carte-modules", fig_modules), ("memoires", fig_memories), ("limites", fig_limits), ("chronologie", fig_timeline)):
    with open(os.path.join(OUT, name + ".svg"), "w", encoding="utf-8") as f:
        f.write(fn())
    print("wrote", os.path.join(OUT, name + ".svg"))
