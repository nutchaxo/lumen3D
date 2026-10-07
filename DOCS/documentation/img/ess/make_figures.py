#!/usr/bin/env python3
"""Schemas of the "Essentials" document, in English (img-en/ess) and French (img/ess).

    python DOCS/documentation/img/ess/make_figures.py

Numbers shown in the figures are those of the synthetic demonstration embryo
Embryo-E95-Em2-Pecam1-Sox2 (768 × 576 × 112 voxels, 3 channels) as published by
pipeline 0.21.0, and the formulas of the platform code (see the full documentation).
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent
DOCROOT = HERE.parent.parent
OUT = {"fr": DOCROOT / "img" / "ess", "en": DOCROOT / "img-en" / "ess"}

INK, SOFT, LINE, BG = "#1c2333", "#4a5468", "#c5cbd8", "#f8f9fd"
C = {"blue": ("#3b5bdb", "#e8edff"), "green": ("#2b8a3e", "#ebfbee"), "amber": ("#e67700", "#fff4e6"),
     "violet": ("#7048e8", "#f3f0ff"), "teal": ("#0c8599", "#e3fafc"), "red": ("#c92a2a", "#fff0f0")}

HEAD = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 {h}" font-family="Inter, sans-serif">'
        '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
        f'orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="{SOFT}"/></marker></defs>'
        f'<rect width="800" height="{{h}}" rx="16" fill="{BG}"/>')


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def text(x, y, s, size=13, weight=400, fill=INK, anchor="middle", italic=False):
    st = ' font-style="italic"' if italic else ""
    return (f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-size="{size}" font-weight="{weight}" '
            f'fill="{fill}"{st}>{esc(s)}</text>')


def lines(x, y, rows, size=12, fill=SOFT, gap=16, weight=400, anchor="middle"):
    return "".join(text(x, y + i * gap, r, size, weight, fill, anchor) for i, r in enumerate(rows))


def arrow(x1, y1, x2, y2, w=2.4, color=SOFT):
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="{w}" marker-end="url(#arr)"/>'


def card(x, y, w, h, color, title, emoji, body, foot=None):
    s, soft = C[color]
    out = (f'<g transform="translate({x},{y})"><rect width="{w}" height="{h}" rx="14" fill="#fff" stroke="{LINE}"/>'
           f'<rect width="{w}" height="34" rx="14" fill="{soft}"/><rect y="18" width="{w}" height="16" fill="{soft}"/>'
           + text(w / 2, 22, title, 12, 800, s)
           + text(w / 2, 78, emoji, 34) + lines(w / 2, 108, body, 12.5, INK, 17))
    if foot:
        out += (f'<rect x="10" y="{h - 34}" width="{w - 20}" height="24" rx="12" fill="{soft}"/>'
                + text(w / 2, h - 17, foot, 11.5, 700, s))
    return out + "</g>"


T = {
    "steps_title": {"fr": "Les six étapes du pipeline, pour un fichier .ims",
                    "en": "The six pipeline steps, for one .ims file"},
    "steps": {
        "fr": [("1 · LIRE", "📄", ["taille, voxels,", "canaux, temps"], "meta.json"),
               ("2 · NETTOYER", "🧹", ["fond retiré,", "bruit lissé"], "fond = 0"),
               ("3 · 8 BITS", "🎚️", ["65 536 niveaux", "→ 256 niveaux"], "÷ 2 en taille"),
               ("4 · PYRAMIDE", "🔺", ["la même image", "en plus petit"], "niveaux 0…n"),
               ("5 · BRIQUES", "🧱", ["cubes de 64³", "sans perte"], "WebP"),
               ("6 · PUBLIER", "📦", ["fiche + vignette,", "tout ou rien"], "DATA_WEB/")],
        "en": [("1 · READ", "📄", ["size, voxels,", "channels, time"], "meta.json"),
               ("2 · CLEAN", "🧹", ["background removed,", "noise smoothed"], "background = 0"),
               ("3 · 8 BITS", "🎚️", ["65,536 levels", "→ 256 levels"], "÷ 2 in size"),
               ("4 · PYRAMID", "🔺", ["the same image,", "smaller"], "levels 0…n"),
               ("5 · BRICKS", "🧱", ["64³ cubes,", "lossless"], "WebP"),
               ("6 · PUBLISH", "📦", ["record + thumbnail,", "all or nothing"], "DATA_WEB/")]},
    "steps_foot": {"fr": "Le fichier .ims d'origine n'est jamais modifié. Chaque étape a son chapitre dans la documentation complète (4 à 8).",
                   "en": "The original .ims file is never modified. Each step has its own chapter in the full documentation (4 to 8)."},

    "win_title": {"fr": "Étape 2 + 3 : du signal brut (16 bits) à l'image affichée (8 bits)",
                  "en": "Steps 2 + 3: from the raw signal (16 bits) to the displayed image (8 bits)"},
    "win_x": {"fr": "valeur brute du voxel (16 bits)", "en": "raw voxel value (16 bits)"},
    "win_y": {"fr": "valeur stockée (0 – 255)", "en": "stored value (0 – 255)"},
    "win_floor": {"fr": "plancher du fond", "en": "background floor"},
    "win_floor2": {"fr": "99ᵉ centile des 8 coins", "en": "99th percentile of the 8 corners"},
    "win_max": {"fr": "plafond du signal", "en": "signal ceiling"},
    "win_max2": {"fr": "99,9ᵉ centile du volume", "en": "99.9th percentile of the volume"},
    "win_zero": {"fr": "tout le fond → 0", "en": "all background → 0"},
    "win_sat": {"fr": "0,1 % les plus brillants → 255", "en": "brightest 0.1 % → 255"},
    "win_lin": {"fr": "ligne droite : pas de gamma", "en": "straight line: no gamma"},

    "size_title": {"fr": "Le jeu de démonstration : de 297 Mo de voxels à 9 Mo de briques",
                   "en": "The demonstration dataset: from 297 MB of voxels to 9 MB of bricks"},
    "size_rows": {"fr": [("Voxels bruts en 16 bits (3 canaux)", 297.3, "red"),
                         ("Après passage en 8 bits", 148.6, "amber"),
                         ("Briques WebP, 4 niveaux de pyramide", 9.3, "green"),
                         ("+ plans et projections (Studio)", 9.1, "blue")],
                  "en": [("Raw 16-bit voxels (3 channels)", 297.3, "red"),
                         ("After conversion to 8 bits", 148.6, "amber"),
                         ("WebP bricks, 4 pyramid levels", 9.3, "green"),
                         ("+ planes and projections (Studio)", 9.1, "blue")]},
    "size_unit": {"fr": "Mo", "en": "MB"},
    "size_foot": {"fr": "Gros gain : le fond devient exactement 0, les briques vides ne sont pas stockées et le reste se compresse sans perte.",
                  "en": "Big win: the background becomes exactly 0, empty bricks are not stored and the rest compresses losslessly."},

    "pyr_title": {"fr": "La pyramide d'une grande pile (3789 × 3789 px) et le réglage « Qualité »",
                  "en": "The pyramid of a large stack (3789 × 3789 px) and the “Quality” setting"},
    "pyr_levels": {"fr": ["niveau 5 · 119 px", "niveau 3 · 474 px", "niveau 2 · 948 px", "niveau 0 · 3789 px (natif)"],
                   "en": ["level 5 · 119 px", "level 3 · 474 px", "level 2 · 948 px", "level 0 · 3789 px (native)"]},
    "pyr_q": {"fr": ["aperçu immédiat", "« 512 » (≤ 768 px)", "« 1024 » (≤ 1536 px)", "« Natif »"],
              "en": ["instant preview", "“512” (≤ 768 px)", "“1024” (≤ 1536 px)", "“Native”"]},
    "pyr_note": {"fr": "Chaque niveau = moyenne de blocs 2 × 2 (× 2 en Z si possible) du niveau du dessous. Les niveaux 1 et 4 existent aussi.",
                 "en": "Each level = mean of 2 × 2 blocks (× 2 in Z when possible) of the level below. Levels 1 and 4 exist too."},
    "pyr_side": {"fr": "réglage « Qualité »", "en": "“Quality” setting"},

    "ray_title": {"fr": "Le lancer de rayons : un calcul par pixel, refait à chaque mouvement",
                  "en": "Ray marching: one computation per pixel, redone at every move"},
    "ray_eye": {"fr": "votre œil", "en": "your eye"},
    "ray_px": {"fr": "1 pixel", "en": "1 pixel"},
    "ray_cube": {"fr": "le volume (briques sur la carte graphique)", "en": "the volume (bricks on the graphics card)"},
    "ray_s": {"fr": "1 échantillon par voxel traversé", "en": "1 sample per voxel crossed"},
    "ray_modes": {"fr": [("Fluorescence", "garde le maximum de chaque canal (comme une MIP)", "blue"),
                         ("Fluorescence naturelle", "chaque fluorophore brille, le dense cache ce qui est derrière", "violet"),
                         ("Structure (DVR)", "accumule une opacité, avant → arrière", "teal")],
                  "en": [("Fluorescence", "keeps the maximum of each channel (like a MIP)", "blue"),
                         ("Natural fluorescence", "each fluorophore glows, dense matter hides what lies behind", "violet"),
                         ("Structure (DVR)", "accumulates opacity, front to back", "teal")]},
    "ray_skip": {"fr": "brique vide : le rayon saute par-dessus", "en": "empty brick: the ray jumps over it"},

    "tf_title": {"fr": "Régler un canal : min, max, gamma — exemple d'un voxel de valeur 120",
                 "en": "Tuning a channel: min, max, gamma — example of a voxel of value 120"},
    "tf_steps": {"fr": [("Valeur stockée", "120", "sur 0 – 255"),
                        ("Fenêtre min 20 / max 220", "0,500", "(120 − 20) / 200"),
                        ("Gamma 0,5", "0,707", "0,5 ^ 0,5"),
                        ("Opacité 70 %", "0,495", "0,707 × 0,7"),
                        ("Couleur du canal", "vert × 0,495", "puis addition des canaux")],
                 "en": [("Stored value", "120", "on 0 – 255"),
                        ("Window min 20 / max 220", "0.500", "(120 − 20) / 200"),
                        ("Gamma 0.5", "0.707", "0.5 ^ 0.5"),
                        ("Opacity 70 %", "0.495", "0.707 × 0.7"),
                        ("Channel colour", "green × 0.495", "then channels are added")]},
    "tf_foot": {"fr": "Ces réglages ne changent que l'affichage : les données sur le serveur ne sont jamais modifiées.",
                "en": "These settings only change the display: the data on the server are never modified."},
}


def fig_steps(lang):
    h = 300
    out = HEAD.format(h=h) + text(400, 34, T["steps_title"][lang], 17, 800)
    w, gap, x0 = 118, 11, 13
    for i, (title, emo, body, foot) in enumerate(T["steps"][lang]):
        color = ["blue", "red", "amber", "violet", "green", "teal"][i]
        x = x0 + i * (w + gap)
        out += card(x, 58, w, 190, color, title, emo, body, foot)
        if i < 5:
            out += arrow(x + w + 1, 152, x + w + gap - 1, 152, 2)
    out += text(400, 280, T["steps_foot"][lang], 12, 400, SOFT, italic=True)
    return out + "</svg>"


def fig_window(lang):
    h = 380
    out = HEAD.format(h=h) + text(400, 34, T["win_title"][lang], 17, 800)
    ox, oy, W, H = 110, 320, 600, 230
    out += f'<rect x="{ox}" y="{oy - H}" width="{W}" height="{H}" fill="#fff" stroke="{LINE}"/>'
    fx, mx = ox + 150, ox + 470
    out += f'<rect x="{ox}" y="{oy - H}" width="{fx - ox}" height="{H}" fill="{C["red"][1]}"/>'
    out += f'<rect x="{mx}" y="{oy - H}" width="{ox + W - mx}" height="{H}" fill="{C["amber"][1]}"/>'
    out += (f'<polyline points="{ox},{oy} {fx},{oy} {mx},{oy - H + 8} {ox + W},{oy - H + 8}" fill="none" '
            f'stroke="{C["blue"][0]}" stroke-width="4" stroke-linejoin="round"/>')
    for x, color in ((fx, "red"), (mx, "amber")):
        out += f'<line x1="{x}" y1="{oy - H}" x2="{x}" y2="{oy + 6}" stroke="{C[color][0]}" stroke-width="2" stroke-dasharray="5 4"/>'
    out += text(fx, oy + 22, T["win_floor"][lang], 12.5, 700, C["red"][0]) + text(fx, oy + 38, T["win_floor2"][lang], 11, 400, SOFT)
    out += text(mx, oy + 22, T["win_max"][lang], 12.5, 700, C["amber"][0]) + text(mx, oy + 38, T["win_max2"][lang], 11, 400, SOFT)
    out += text((ox + fx) / 2, oy - 40, T["win_zero"][lang], 12, 700, C["red"][0])
    out += text(mx + 8, oy - H + 60, T["win_sat"][lang], 11, 700, C["amber"][0], "start")
    out += text(ox + 400, oy - 70, T["win_lin"][lang], 12, 600, C["blue"][0], "start")
    out += text(ox + W / 2, oy + 56, T["win_x"][lang], 12, 600, SOFT)
    out += (f'<text x="{ox - 46}" y="{oy - H / 2}" transform="rotate(-90 {ox - 46} {oy - H / 2})" text-anchor="middle" '
            f'font-size="12" font-weight="600" fill="{SOFT}">{esc(T["win_y"][lang])}</text>')
    out += text(ox - 10, oy + 4, "0", 11, 600, SOFT, "end") + text(ox - 10, oy - H + 12, "255", 11, 600, SOFT, "end")
    return out + "</svg>"


def fig_size(lang):
    rows = T["size_rows"][lang]
    h = 110 + len(rows) * 52 + 30
    out = HEAD.format(h=h) + text(400, 34, T["size_title"][lang], 17, 800)
    maxv = rows[0][1]
    for i, (label, v, color) in enumerate(rows):
        y = 64 + i * 52
        bw = max(6, 360 * v / maxv)
        out += text(36, y + 22, label, 13, 600, INK, "start")
        out += f'<rect x="300" y="{y + 6}" width="{bw:.1f}" height="28" rx="8" fill="{C[color][0]}"/>'
        val = f"{v:.1f}".replace(".", "," if lang == "fr" else ".") + " " + T["size_unit"][lang]
        out += text(300 + bw + 10, y + 25, val, 13, 800, C[color][0], "start")
    out += text(400, h - 26, T["size_foot"][lang], 12, 400, SOFT, italic=True)
    return out + "</svg>"


def fig_pyramid(lang):
    h = 330
    out = HEAD.format(h=h) + text(400, 34, T["pyr_title"][lang], 17, 800)
    widths = [210, 270, 340, 440]
    colors = ["teal", "blue", "violet", "green"]
    for i, (w, lab, q) in enumerate(zip(widths, T["pyr_levels"][lang], T["pyr_q"][lang])):
        y = 62 + i * 52
        s, soft = C[colors[i]]
        x = 270 - w / 2
        out += f'<rect x="{x}" y="{y}" width="{w}" height="40" rx="8" fill="{soft}" stroke="{s}" stroke-width="1.5"/>'
        out += text(270, y + 25, lab, 12, 700, s)
        out += arrow(520, y + 20, 556, y + 20, 2)
        out += f'<rect x="562" y="{y + 4}" width="200" height="32" rx="16" fill="#fff" stroke="{s}"/>'
        out += text(662, y + 25, q, 12.5, 700, s)
    out += text(662, 56, T["pyr_side"][lang], 11.5, 700, SOFT)
    out += text(400, 300, T["pyr_note"][lang], 12, 400, SOFT, italic=True)
    return out + "</svg>"


def fig_ray(lang):
    h = 360
    out = HEAD.format(h=h) + text(400, 34, T["ray_title"][lang], 17, 800)
    out += text(60, 157, "👁️", 34) + text(60, 196, T["ray_eye"][lang], 12, 600, SOFT)
    out += f'<rect x="140" y="80" width="12" height="130" fill="#dee2e6"/><rect x="140" y="137" width="12" height="16" fill="{C["blue"][0]}"/>'
    out += text(146, 230, T["ray_px"][lang], 11.5, 700, C["blue"][0])
    # cube as bricks; the ray crosses row 1, whose first and last bricks are empty
    bx, by, n, sz = 250, 70, 4, 50
    empty = {(0, 1), (3, 1), (0, 0), (3, 3), (1, 0)}
    for i in range(n):
        for j in range(n):
            fill = "#ffffff" if (i, j) in empty else C["green"][1]
            out += f'<rect x="{bx + i * sz}" y="{by + j * sz}" width="{sz}" height="{sz}" fill="{fill}" stroke="{LINE}"/>'
    ry = by + 75
    out += f'<line x1="80" y1="{ry}" x2="{bx + n * sz + 16}" y2="{ry}" stroke="{C["amber"][0]}" stroke-width="2.5" marker-end="url(#arr)"/>'
    for k in range(10):
        out += f'<circle cx="{bx + sz + 5 + k * 10}" cy="{ry}" r="3.4" fill="{C["amber"][0]}"/>'
    for i in (0, 3):
        x = bx + i * sz
        out += (f'<path d="M{x + 4},{ry - 4} Q{x + sz / 2},{ry - 30} {x + sz - 4},{ry - 4}" fill="none" '
                f'stroke="{C["red"][0]}" stroke-width="2" stroke-dasharray="4 3" marker-end="url(#arr)"/>')
    ly = by + n * sz + 24
    out += f'<circle cx="{bx - 4}" cy="{ly - 4}" r="4" fill="{C["amber"][0]}"/>' + text(bx + 6, ly, T["ray_s"][lang], 11.5, 700, C["amber"][0], "start")
    out += f'<line x1="{bx - 10}" y1="{ly + 16}" x2="{bx + 2}" y2="{ly + 16}" stroke="{C["red"][0]}" stroke-width="2" stroke-dasharray="4 3"/>' + text(bx + 6, ly + 20, T["ray_skip"][lang], 11.5, 700, C["red"][0], "start")
    out += text(bx + 6, ly + 40, T["ray_cube"][lang], 11.5, 600, SOFT, "start")
    # modes
    for i, (name, desc, color) in enumerate(T["ray_modes"][lang]):
        y = 74 + i * 76
        s_, soft = C[color]
        out += f'<rect x="490" y="{y}" width="290" height="62" rx="12" fill="{soft}" stroke="{s_}" stroke-width="1"/>'
        out += text(504, y + 24, name, 13.5, 800, s_, "start")
        words, row, rows = desc.split(), "", []
        for wd in words:
            if len(row) + len(wd) > 40:
                rows.append(row)
                row = wd
            else:
                row = (row + " " + wd).strip()
        rows.append(row)
        out += lines(504, y + 42, rows, 11.5, INK, 14, 400, "start")
    return out + "</svg>"


def fig_tf(lang):
    h = 250
    out = HEAD.format(h=h) + text(400, 34, T["tf_title"][lang], 16.5, 800)
    steps = T["tf_steps"][lang]
    w, gap, x0 = 140, 15, 12
    for i, (lab, val, sub) in enumerate(steps):
        x = x0 + i * (w + gap)
        color = ["blue", "violet", "teal", "amber", "green"][i]
        s, soft = C[color]
        out += f'<rect x="{x}" y="62" width="{w}" height="130" rx="14" fill="#fff" stroke="{LINE}"/>'
        out += f'<rect x="{x}" y="62" width="{w}" height="40" rx="14" fill="{soft}"/><rect x="{x}" y="86" width="{w}" height="16" fill="{soft}"/>'
        words = lab.split(" ")
        if len(lab) > 18:
            mid = len(words) // 2
            out += lines(x + w / 2, 79, [" ".join(words[:mid]), " ".join(words[mid:])], 11, s, 13, 800)
        else:
            out += text(x + w / 2, 87, lab, 11.5, 800, s)
        out += text(x + w / 2, 142, val, 22 if len(val) < 8 else 16, 800, INK)
        out += text(x + w / 2, 172, sub, 11, 400, SOFT)
        if i < len(steps) - 1:
            out += arrow(x + w + 1, 127, x + w + gap - 1, 127, 2)
    out += text(400, 226, T["tf_foot"][lang], 12, 400, SOFT, italic=True)
    return out + "</svg>"


FIGS = {"etapes.svg": fig_steps, "fenetrage.svg": fig_window, "tailles.svg": fig_size,
        "pyramide.svg": fig_pyramid, "rayons.svg": fig_ray, "reglages.svg": fig_tf}

if __name__ == "__main__":
    for lang, folder in OUT.items():
        folder.mkdir(parents=True, exist_ok=True)
        for name, fn in FIGS.items():
            (folder / name).write_text(fn(lang), encoding="utf-8")
        print(folder, len(FIGS), "figures")
