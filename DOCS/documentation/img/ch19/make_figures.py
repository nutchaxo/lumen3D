#!/usr/bin/env python3
"""Figures of chapter 19 added in round 2 (« Que se passe-t-il si… ? »).

    FIG_LANG=fr IMG_DIR=DOCS/documentation/img/ch19    python3 make_figures.py
    FIG_LANG=en IMG_DIR=DOCS/documentation/img-en/ch19 python3 make_figures.py

Writes replis-brique.svg, perte-contexte.svg and coupure-import.svg.
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

T = {
    "fr": {
        "t1": "Une brique en difficulté : l'échelle des replis",
        "s1": "1 · Télécharger", "s1b": "le pack, par le réseau",
        "s2": "2 · Décoder", "s2b": "un worker, en arrière-plan",
        "s3": "3 · Afficher", "s3b": "la carte graphique (WebGL2)",
        "p1": ["Pas de réponse pendant 30 s,", "erreur réseau, brique illisible :", "3 essais (attente 0,5 s puis 1 s)"],
        "p2": ["Worker planté ou figé (30 s) :", "il est remplacé (3 fois au plus),", "puis décodage dans la page"],
        "p3": ["Pas de textures 3D (WebGL2) :", "refus avec un message clair,", "jamais de plantage de l'onglet"],
        "f1": ["Toujours en échec :", "la brique est signalée,", "jamais livrée, comptée dans", "le bilan du lot (failed)"],
        "f2": ["La tâche repart sur un", "autre worker. Le reste du", "volume continue de", "s'afficher"],
        "f3": ["Aucune donnée corrompue", "n'atteint la mémoire", "graphique"],
        "foot": "Règle d'or : une brique douteuse est écartée, jamais affichée de travers, et l'onglet ne plante pas.",
        "t2": "Perte du contexte graphique : une reprise, avec garde-fou",
        "l1": "1 · Le GPU est réinitialisé",
        "l1b": ["textures libérées, flux arrêtés,", "budget mémoire ÷ 2", "(plancher 256 Mo)"],
        "l2": "2 · Le navigateur rend la main",
        "l2b": ["le dernier affichage est rechargé", "avec le budget réduit"],
        "l3": "3 · Le volume revient",
        "l3b": ["souvent à un niveau plus grossier,", "que vous pouvez relever ensuite"],
        "tl": "Garde-fou : 3 pertes en moins de 120 s",
        "tick": "perte", "sec": "secondes",
        "stop": ["Plus de rechargement automatique.", "Message : choisissez une qualité plus basse", "ou rechargez la page."],
        "mem": "Le budget est retenu une semaine par navigateur (jusqu'à 4 pertes comptées) : 4 Gio → 2 → 1 → 0,5 → 0,25 Gio",
        "t3": "Pendant un import : quatre pannes, quatre réactions",
        "c0": "Un morceau de 8 Mio", "c0b": "part vers le serveur",
        "a1": "Aucune réponse (réseau coupé)", "a1b": ["Attente, sans compter d'échec.", "Sonde toutes les 2 s (jusqu'à 15 s).", "Reprise au retour du réseau."],
        "a2": "Erreur serveur, trop de requêtes", "a2b": ["5xx, 429 : jusqu'à 6 essais,", "attente 1 s doublée jusqu'à 30 s.", "Puis fichier marqué en échec : Réessayer."],
        "a3": "Session expirée (401)", "a3b": ["Arrêt net, message clair.", "Reconnectez-vous et reglissez", "le dossier : reprise au morceau près."],
        "a4": "Disque plein (507)", "a4b": ["Refus avant d'écrire si la place", "manque ; message avec besoin/libre.", "Libérez de la place, puis reprenez."],
        "foot3": "Un morceau renvoyé deux fois est sans effet (même octets, même position) : réessayer est toujours sûr.",
    },
    "en": {
        "t1": "A brick in trouble: the ladder of fallbacks",
        "s1": "1 · Download", "s1b": "the pack, over the network",
        "s2": "2 · Decode", "s2b": "a worker, in the background",
        "s3": "3 · Display", "s3b": "the graphics card (WebGL2)",
        "p1": ["No answer for 30 s, network", "error, unreadable brick:", "3 attempts (wait 0.5 s then 1 s)"],
        "p2": ["Worker crashed or frozen (30 s):", "it is replaced (3 times at most),", "then decoding in the page"],
        "p3": ["No 3D textures (WebGL2):", "refused with a clear message,", "the tab never crashes"],
        "f1": ["Still failing:", "the brick is reported,", "never delivered, counted in", "the batch summary (failed)"],
        "f2": ["The task restarts on", "another worker. The rest of", "the volume keeps", "displaying"],
        "f3": ["No corrupt data ever", "reaches graphics", "memory"],
        "foot": "Golden rule: a doubtful brick is dropped, never shown wrongly, and the tab does not crash.",
        "t2": "Graphics context lost: one recovery, with a safeguard",
        "l1": "1 · The GPU is reset",
        "l1b": ["textures freed, streams stopped,", "memory budget ÷ 2", "(floor 256 MiB)"],
        "l2": "2 · The browser gives it back",
        "l2b": ["the last view is reloaded", "with the reduced budget"],
        "l3": "3 · The volume comes back",
        "l3b": ["often at a coarser level,", "which you can raise afterwards"],
        "tl": "Safeguard: 3 losses in under 120 s",
        "tick": "loss", "sec": "seconds",
        "stop": ["No more automatic reload.", "Message: choose a lower quality", "or reload the page."],
        "mem": "The budget is remembered for a week per browser (up to 4 losses counted): 4 GiB → 2 → 1 → 0.5 → 0.25 GiB",
        "t3": "During an import: four failures, four reactions",
        "c0": "An 8 MiB chunk", "c0b": "leaves for the server",
        "a1": "No answer (network down)", "a1b": ["Wait, without counting a failure.", "Probe every 2 s (up to 15 s).", "Resumes when the network is back."],
        "a2": "Server error, too many requests", "a2b": ["5xx, 429: up to 6 attempts,", "wait 1 s doubling up to 30 s.", "Then file marked failed: Retry."],
        "a3": "Session expired (401)", "a3b": ["Clean stop, clear message.", "Sign in again and drop the", "folder again: resumes chunk by chunk."],
        "a4": "Disk full (507)", "a4b": ["Refused before writing if space", "is missing; message with needed/free.", "Free some space, then resume."],
        "foot3": "A chunk sent twice has no effect (same bytes, same position): retrying is always safe.",
    },
}[LANG]

_next_id = [0]


def head(h, extra=""):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 {h}" font-family="Inter, sans-serif">\n'
            '<defs>'
            f'<marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="{SUB}"/></marker>'
            '<marker id="arrr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#c92a2a"/></marker>'
            f'</defs>\n<rect width="800" height="{h}" rx="16" fill="{BG}"/>\n')


def title(s):
    return f'<text x="400" y="32" text-anchor="middle" font-size="18" font-weight="800" fill="{INK}">{escape(s)}</text>\n'


def box(x, y, w, h, color, head_txt=None, sub=None, lines=(), size=12.5, head_size=14, line_h=18):
    st, so = PAL[color]
    out = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{so}" stroke="{st}" stroke-width="1.6"/>\n'
    cy = y + 26
    if head_txt:
        out += f'<text x="{x + w / 2}" y="{cy}" text-anchor="middle" font-size="{head_size}" font-weight="800" fill="{st}">{escape(head_txt)}</text>\n'
        cy += 20
    if sub:
        out += f'<text x="{x + w / 2}" y="{cy}" text-anchor="middle" font-size="12" fill="{SUB}">{escape(sub)}</text>\n'
        cy += 20
    for ln in lines:
        out += f'<text x="{x + w / 2}" y="{cy}" text-anchor="middle" font-size="{size}" fill="{INK}">{escape(ln)}</text>\n'
        cy += line_h
    return out


def arrow(x1, y1, x2, y2, red=False):
    m = "arrr" if red else "arr"
    c = "#c92a2a" if red else SUB
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{c}" stroke-width="2.2" marker-end="url(#{m})"/>\n'


def fig_brick():
    h = 414
    s = head(h) + title(T["t1"])
    xs = [24, 288, 552]
    heads = [(T["s1"], T["s1b"], "blue"), (T["s2"], T["s2b"], "green"), (T["s3"], T["s3b"], "violet")]
    for x, (a, b, c) in zip(xs, heads):
        s += box(x, 56, 224, 74, c, a, b)
    s += arrow(250, 93, 286, 93) + arrow(514, 93, 550, 93)
    probs = [T["p1"], T["p2"], T["p3"]]
    fix = [T["f1"], T["f2"], T["f3"]]
    for x, p, f in zip(xs, probs, fix):
        s += arrow(x + 112, 132, x + 112, 160, red=True)
        s += box(x, 162, 224, 96, "amber", None, None, p, size=12.5, line_h=19)
        s += arrow(x + 112, 260, x + 112, 288, red=False)
        s += box(x, 290, 224, 82, "red" if x == xs[0] else "teal", None, None, f, size=12, line_h=17)
    s += f'<text x="400" y="{h - 14}" text-anchor="middle" font-size="12.5" font-weight="700" fill="{INK}">{escape(T["foot"])}</text>\n'
    return s + "</svg>\n"


def fig_context():
    h = 430
    s = head(h) + title(T["t2"])
    xs = [24, 288, 552]
    steps = [(T["l1"], T["l1b"], "red"), (T["l2"], T["l2b"], "amber"), (T["l3"], T["l3b"], "green")]
    for x, (a, b, c) in zip(xs, steps):
        s += box(x, 54, 224, 100, c, a, None, b, size=12.5, line_h=18)
    s += arrow(250, 104, 286, 104) + arrow(514, 104, 550, 104)
    # timeline
    s += f'<text x="400" y="190" text-anchor="middle" font-size="14" font-weight="800" fill="{INK}">{escape(T["tl"])}</text>\n'
    x0, x1, y = 70, 730, 250
    s += f'<line x1="{x0}" y1="{y}" x2="{x1}" y2="{y}" stroke="{SUB}" stroke-width="2.4"/>\n'
    for sec in (0, 30, 60, 90, 120):
        x = x0 + (x1 - x0) * sec / 120
        s += f'<line x1="{x}" y1="{y - 5}" x2="{x}" y2="{y + 5}" stroke="{SUB}" stroke-width="2"/>\n'
        s += f'<text x="{x}" y="{y + 24}" text-anchor="middle" font-size="12" fill="{SUB}">{sec}</text>\n'
    s += f'<text x="{x1 + 12}" y="{y + 24}" text-anchor="start" font-size="12" fill="{SUB}">{escape(T["sec"])}</text>\n'
    for sec in (8, 51, 104):
        x = x0 + (x1 - x0) * sec / 120
        s += f'<circle cx="{x}" cy="{y}" r="9" fill="#c92a2a"/>\n'
        s += f'<text x="{x}" y="{y - 18}" text-anchor="middle" font-size="12" font-weight="700" fill="#c92a2a">{escape(T["tick"])}</text>\n'
    s += arrow(x0 + (x1 - x0) * 104 / 120, y + 14, 560, 296, red=True)
    s += box(200, 296, 560, 80, "red", None, None, T["stop"], size=12.5, line_h=19)
    s += f'<text x="400" y="{h - 26}" text-anchor="middle" font-size="12" fill="{SUB}">{escape(T["mem"])}</text>\n'
    return s + "</svg>\n"


def fig_import():
    h = 450
    s = head(h) + title(T["t3"])
    s += box(24, 180, 150, 84, "blue", T["c0"], T["c0b"])
    cols = [("amber", T["a1"], T["a1b"]), ("teal", T["a2"], T["a2b"]),
            ("red", T["a3"], T["a3b"]), ("violet", T["a4"], T["a4b"])]
    ys = [48, 142, 236, 330]
    for y, (c, hd, ln) in zip(ys, cols):
        st, so = PAL[c]
        s += f'<rect x="230" y="{y}" width="546" height="84" rx="12" fill="{so}" stroke="{st}" stroke-width="1.6"/>\n'
        s += f'<text x="246" y="{y + 24}" font-size="14" font-weight="800" fill="{st}">{escape(hd)}</text>\n'
        for i, t in enumerate(ln):
            s += f'<text x="246" y="{y + 44 + i * 16}" font-size="12.5" fill="{INK}">{escape(t)}</text>\n'
        s += f'<path d="M176,222 C 200,222 200,{y + 42} 228,{y + 42}" fill="none" stroke="{SUB}" stroke-width="2" marker-end="url(#arr)"/>\n'
    s += f'<text x="400" y="{h - 14}" text-anchor="middle" font-size="12.5" font-weight="700" fill="{INK}">{escape(T["foot3"])}</text>\n'
    return s + "</svg>\n"


for name, fn in (("replis-brique", fig_brick), ("perte-contexte", fig_context), ("coupure-import", fig_import)):
    with open(os.path.join(OUT, name + ".svg"), "w", encoding="utf-8") as f:
        f.write(fn())
    print("wrote", os.path.join(OUT, name + ".svg"))
