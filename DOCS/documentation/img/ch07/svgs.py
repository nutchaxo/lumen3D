"""Schémas SVG du chapitre 7 (générés pour garder fr/en synchronisés ; appelé par make_figures.py)."""
import os
from pathlib import Path

LANG = os.environ.get("FIG_LANG", "fr")
OUT = Path(os.environ.get("IMG_DIR", Path(__file__).resolve().parent))


def tr(fr, en):
    return fr if LANG == "fr" else en


INK, INK2, LINE = "#1c2333", "#4a5468", "#c5cbd8"
P = {"blue": ("#3b5bdb", "#e8edff"), "green": ("#2b8a3e", "#ebfbee"), "amber": ("#e67700", "#fff4e6"),
     "violet": ("#7048e8", "#f3f0ff"), "teal": ("#0c8599", "#e3fafc"), "red": ("#c92a2a", "#fff0f0")}
HEAD = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 {h}" font-family="Inter, sans-serif">'
        '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
        '<path d="M0,0 L10,5 L0,10 z" fill="#4a5468"/></marker></defs>'
        '<rect width="800" height="{h}" rx="16" fill="#f8f9fd"/>')


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;")


def text(x, y, s, size=13, weight=400, fill=INK, anchor="start", style=""):
    return (f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{fill}" '
            f'text-anchor="{anchor}" {style}>{esc(s)}</text>')


def title(s):
    return text(400, 34, s, 18, 800, anchor="middle")


def rect(x, y, w, h, fill="#fff", stroke=LINE, rx=0, sw=1, extra=""):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}" {extra}/>'


def arrow(x1, y1, x2, y2, w=2.4):
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{INK2}" stroke-width="{w}" marker-end="url(#arr)"/>'


def wrap(s, n):
    words, lines, cur = s.split(" "), [], ""
    for w in words:
        if cur and len(cur) + len(w) + 1 > n:
            lines.append(cur); cur = w
        else:
            cur = (cur + " " + w).strip()
    return lines + [cur]


def save(name, h, body):
    (OUT / name).write_text(HEAD.format(h=h) + "".join(body) + "</svg>", encoding="utf-8")


# ── a. pourquoi découper ─────────────────────────────────────────────────────
def tuiles():
    b = [title(tr("Ne charger que les morceaux qu'on regarde", "Load only the pieces you are looking at"))]
    # gauche : carte
    b.append(text(200, 70, tr("Une carte en ligne", "An online map"), 15, 800, anchor="middle"))
    for r in range(4):
        for c in range(6):
            on = 1 <= c <= 3 and 1 <= r <= 2
            b.append(rect(60 + c * 46, 90 + r * 46, 44, 44, "#d0ebff" if on else "#fff", P["blue"][0] if on else LINE, 4, 1.6 if on else 1))
    b.append(rect(104, 130, 144, 90, "none", P["red"][0], 4, 2.6, 'stroke-dasharray="6 4"'))
    b.append(text(200, 292, tr("6 × 4 tuiles, 6 chargées", "6 × 4 tiles, 6 loaded"), 13, 700, anchor="middle", fill=P["blue"][0]))
    b.append(text(200, 312, tr("votre écran = le cadre rouge", "your screen = the red frame"), 12, 400, INK2, "middle"))
    # droite : volume
    b.append(text(600, 70, tr("Un volume en briques", "A volume in bricks"), 15, 800, anchor="middle"))
    for r in range(4):
        for c in range(6):
            on = 1 <= c <= 4 and 1 <= r <= 3
            empty = c in (0, 5) or r == 0
            fill = "#f1f3f5" if empty else ("#d3f9d8" if on else "#fff")
            b.append(rect(460 + c * 46, 90 + r * 46, 44, 44, fill, P["green"][0] if (on and not empty) else LINE, 4, 1.6 if (on and not empty) else 1))
    b.append(text(600, 292, tr("seules les briques visibles ET non vides", "only bricks that are visible AND non-empty"), 13, 700, anchor="middle", fill=P["green"][0]))
    b.append(text(600, 312, tr("sont téléchargées (gris = vide, jamais stocké)", "are downloaded (grey = empty, never stored)"), 12, 400, INK2, "middle"))
    b.append(text(400, 346, tr("Embryon réel typique : 3789 × 3789 × 178 voxels × 4 canaux ≈ 10,2 Go : trop gros pour un seul morceau.",
                              "Typical real embryo: 3789 × 3789 × 178 voxels × 4 channels ≈ 10.2 GB: far too big for one piece."),
                 12.5, 400, INK2, "middle", 'font-style="italic"'))
    save("tuiles.svg", 366, b)


# ── b. brique et bordure ─────────────────────────────────────────────────────
def bordure():
    b = [title(tr("Une brique : 64 voxels utiles + 1 voxel de bordure de chaque côté", "A brick: 64 useful voxels + a 1-voxel border on every side"))]
    # trois briques voisines (coupe 2D), centrale détaillée
    x0, y0, s = 80, 70, 230
    b.append(rect(x0 - 70, y0 + 15, 70, s - 30, "#f3f0ff", LINE, 6))
    b.append(rect(x0 + s, y0 + 15, 70, s - 30, "#f3f0ff", LINE, 6))
    b.append(rect(x0, y0, s, s, "#ffe8cc", P["amber"][0], 6, 2))
    b.append(rect(x0 + 16, y0 + 16, s - 32, s - 32, "#d0ebff", P["blue"][0], 4, 2))
    b.append(text(x0 + s / 2, y0 + s / 2 - 4, tr("64 × 64 × 64", "64 × 64 × 64"), 17, 800, P["blue"][0], "middle"))
    b.append(text(x0 + s / 2, y0 + s / 2 + 18, tr("voxels « à elle »", "the brick's own voxels"), 13, 400, INK, "middle"))
    b.append(text(x0 + s / 2, y0 - 8, tr("coupe à travers la brique stockée : 66 × 66 × 66", "cross-section of the stored brick: 66 × 66 × 66"), 12.5, 700, P["amber"][0], "middle"))
    b.append(text(x0 - 35, y0 + s / 2 + 5, tr("voisine", "neighbour"), 12, 400, INK2, "middle"))
    b.append(text(x0 + s + 35, y0 + s / 2 + 5, tr("voisine", "neighbour"), 12, 400, INK2, "middle"))
    # flèches : la bordure copie les voxels voisins
    b.append(arrow(x0 - 6, y0 + 60, x0 + 6, y0 + 60, 2))
    b.append(arrow(x0 + s + 6, y0 + 60, x0 + s - 6, y0 + 60, 2))
    # explications
    ex = 400
    items = [
        (P["blue"], tr("L'intérieur (bleu)", "The interior (blue)"), tr("64³ = 262 144 voxels : la place de la brique dans la grille.", "64³ = 262,144 voxels: the brick's own place in the grid.")),
        (P["amber"], tr("La bordure (orange)", "The border (orange)"), tr("1 voxel copié depuis chaque voisine : 66³ = 287 496 voxels, soit 9,7 % de plus.", "1 voxel copied from each neighbour: 66³ = 287,496 voxels, i.e. 9.7 % more.")),
        (P["violet"], tr("Les voisines", "The neighbours"), tr("Leur premier voxel devient la bordure de cette brique, et inversement.", "Their first voxel becomes this brick's border, and vice versa.")),
    ]
    yy = 96
    for (st, so), t1, t2 in items:
        b.append(rect(ex, yy, 370, 74, so, st, 12, 1.4))
        b.append(text(ex + 14, yy + 26, t1, 14, 800, st))
        # texte sur 2 lignes
        words = t2.split(" ")
        l1, l2 = "", ""
        for w in words:
            if not l2 and len(l1) + len(w) < 46:
                l1 += w + " "
            else:
                l2 += w + " "
        b.append(text(ex + 14, yy + 47, l1.strip(), 12.5, 400, INK))
        b.append(text(ex + 14, yy + 64, l2.strip(), 12.5, 400, INK))
        yy += 88
    b.append(text(400, 358, tr("Hors du volume, la bordure répète le dernier voxel (« clamp to edge »). Une brique absente vaut zéro, bordure comprise.",
                              "Outside the volume, the border repeats the last voxel (“clamp to edge”). An absent brick is zero, border included."),
                 12, 400, INK2, "middle", 'font-style="italic"'))
    save("bordure.svg", 366, b)


# ── c. la mosaïque 9 × 8 ─────────────────────────────────────────────────────
def mosaique_schema():
    b = [title(tr("66 coupes → une seule image de 9 colonnes × 8 lignes (594 × 528 px)", "66 slices → one single image of 9 columns × 8 rows (594 × 528 px)"))]
    # pile de coupes à gauche
    for k in range(7, -1, -1):
        off = k * 7
        b.append(rect(40 + off, 120 - off + 40, 120, 120, "#d0ebff" if k else "#ffd8a8", P["blue"][0] if k else P["amber"][0], 3, 1.4))
    b.append(text(110, 90, tr("brique 66 × 66 × 66", "brick 66 × 66 × 66"), 14, 800, anchor="middle"))
    b.append(text(110, 300, tr("66 coupes de 66 × 66 px", "66 slices of 66 × 66 px"), 13, 700, INK, "middle"))
    b.append(text(110, 318, tr("z' = 0 devant, z' = 65 derrière", "z' = 0 in front, z' = 65 behind"), 12, 400, INK2, "middle"))
    b.append(arrow(215, 200, 262, 200))
    # grille 9x8
    gx, gy, c = 275, 62, 50
    hl = {0: "amber", 1: "blue", 8: "green", 9: "violet", 65: "red"}
    for s in range(72):
        col, row = s % 9, s // 9
        if s in hl:
            st, so = P[hl[s]]
            b.append(rect(gx + col * c, gy + row * 28.5, c, 28.5, so, st, 0, 2.2))
            b.append(text(gx + col * c + c / 2, gy + row * 28.5 + 19, str(s), 14, 800, st, "middle"))
        elif s < 66:
            b.append(rect(gx + col * c, gy + row * 28.5, c, 28.5, "#fff", LINE))
            b.append(text(gx + col * c + c / 2, gy + row * 28.5 + 19, str(s), 12, 400, INK2, "middle"))
        else:
            b.append(rect(gx + col * c, gy + row * 28.5, c, 28.5, "#e9ecef", LINE))
            b.append(text(gx + col * c + c / 2, gy + row * 28.5 + 19, "0", 11, 400, "#868e96", "middle"))
    b.append(text(gx + 4.5 * c, gy - 8, tr("9 colonnes × 66 px = 594 px", "9 columns × 66 px = 594 px"), 12.5, 700, INK, "middle"))
    b.append(text(gx + 4.5 * c, gy + 8 * 28.5 + 22, tr("coupe z' → colonne z' mod 9, ligne z' div 9   (cases grises : 6 vides)", "slice z' → column z' mod 9, row z' div 9   (grey cells: 6 empty)"),
                  12.5, 700, INK, "middle"))
    b.append(text(gx + 4.5 * c, gy + 8 * 28.5 + 44, tr("8 lignes × 66 px = 528 px", "8 rows × 66 px = 528 px"), 12.5, 400, INK2, "middle"))
    save("mosaique-schema.svg", 360, b)


# ── d. super-blocs et paquets ────────────────────────────────────────────────
def superblocs():
    b = [title(tr("Les paquets : des « boîtes de 64 briques » rangées par super-blocs 4 × 4 × 4", "Packs: “boxes of 64 bricks” filled by 4 × 4 × 4 super-blocks"))]

    def cube(x, y, n, s, fill, stroke):
        out = []
        for k in range(n - 1, -1, -1):
            for j in range(n):
                for i in range(n):
                    px = x + i * s + k * s * .5
                    py = y + j * s - k * s * .5
                    out.append(rect(px, py, s, s, fill, stroke, 0, .8))
        return out
    b += cube(60, 160, 4, 26, "#d3f9d8", P["green"][0])
    b.append(text(130, 95, tr("un super-bloc", "one super-block"), 14, 800, P["green"][0], "middle"))
    b.append(text(130, 112, tr("4 × 4 × 4 = 64 briques voisines", "4 × 4 × 4 = 64 neighbouring bricks"), 12, 400, INK2, "middle"))
    b.append(arrow(235, 210, 300, 210))
    b.append(rect(315, 140, 140, 140, "#fff4e6", P["amber"][0], 14, 2))
    b.append(text(385, 195, tr("paquet", "pack"), 16, 800, P["amber"][0], "middle"))
    b.append(text(385, 216, "p00000.bin", 13, 700, INK, "middle"))
    b.append(text(385, 238, tr("≤ 64 briques", "≤ 64 bricks"), 12.5, 400, INK, "middle"))
    b.append(text(385, 256, tr("≤ 16 Mio", "≤ 16 MiB"), 12.5, 400, INK, "middle"))
    b.append(rect(500, 80, 270, 190, "#fff", LINE, 12))
    b.append(text(515, 108, tr("Pourquoi des super-blocs ?", "Why super-blocks?"), 14, 800))
    rows = [tr("Une coupe en XZ ou YZ traverse", "A cut along XZ or YZ crosses"),
            tr("une rangée de briques : avec des", "one row of bricks: with"),
            tr("super-blocs, ces briques sont dans", "super-blocks, those bricks sit in"),
            tr("peu de paquets, donc peu de requêtes.", "few packs, hence few requests."),
            tr("Mesuré (simulation, embryon", "Measured (simulation, embryo"),
            tr("5735² × 172) : coupe YZ = 66 paquets", "5735² × 172): YZ cut = 66 packs"),
            tr("au lieu de 668.", "instead of 668.")]
    for i, r in enumerate(rows):
        b.append(text(515, 132 + i * 18, r, 12.5, 700 if i >= 4 else 400, P["red"][0] if i >= 5 else INK))
    b.append(text(400, 326, tr("Un paquet contient toujours des super-blocs entiers ; un super-bloc trop gros est coupé dans l'ordre des briques.",
                              "A pack always holds whole super-blocks; a super-block that is too big is split in brick order."), 12, 400, INK2, "middle", 'font-style="italic"'))
    save("superblocs.svg", 342, b)


# ── e. anatomie d'index.bin ──────────────────────────────────────────────────
def index_bin():
    b = [title(tr("Anatomie de index.bin (le jeu de démonstration : 7 846 octets)", "Anatomy of index.bin (the demonstration dataset: 7,846 bytes)"))]
    y = 70
    parts = [(tr("en-tête", "header"), "12 o" if LANG == "fr" else "12 B", "LBIX · v1 · 4 niveaux · 3 canaux" if LANG == "fr" else "LBIX · v1 · 4 levels · 3 channels", "violet", 130),
             (tr("1 ligne par niveau", "1 row per level"), "4 × 16 o" if LANG == "fr" else "4 × 16 B", tr("grille X, Y, Z + nombre de paquets", "grid X, Y, Z + number of packs"), "teal", 190),
             (tr("1 entrée par case de brique", "1 entry per brick slot"), "7 770 o" if LANG == "fr" else "7,770 B", tr("(216 + 30 + 9 + 4) × 3 canaux × 10 o", "(216 + 30 + 9 + 4) × 3 channels × 10 B"), "amber", 380)]
    x = 30
    for name, size, desc, col, w in parts:
        st, so = P[col]
        b.append(rect(x, y, w, 64, so, st, 8, 1.6))
        b.append(text(x + w / 2, y + 24, name, 13, 800, st, "middle"))
        b.append(text(x + w / 2, y + 44, size, 13, 700, INK, "middle"))
        for k, ln in enumerate(wrap(desc, max(14, int(w / 6.4)))):
            b.append(text(x + w / 2, y + 86 + k * 15, ln, 11.5, 400, INK2, "middle"))
        x += w
    # une entrée de 10 octets
    b.append(text(400, 190, tr("Une entrée = 10 octets = 3 nombres", "One entry = 10 bytes = 3 numbers"), 15, 800, anchor="middle"))
    cells = [("pack", "u16", "2 o", P["blue"], 120), ("offset", "u32", "4 o", P["green"], 220), ("length", "u32", "4 o", P["red"], 220)]
    x = 120
    explain = [tr("quel paquet", "which pack"), tr("où commence l'image", "where the image starts"), tr("combien d'octets (0 = brique absente)", "how many bytes (0 = absent brick)")]
    for (n, t, sz, (st, so), w), ex in zip(cells, explain):
        b.append(rect(x, 210, w * .96, 52, so, st, 8, 1.6))
        b.append(text(x + w * .48, 233, f"{n}  ({t}, {sz if LANG == 'fr' else sz.replace(' o', ' B')})", 13, 800, st, "middle"))
        b.append(text(x + w * .48, 252, ex, 11.5, 400, INK, "middle"))
        x += w
    b.append(text(400, 300, tr("Toutes les valeurs sont en « petit-boutiste » (little-endian) : l'octet de poids faible vient en premier.",
                              "All values are little-endian: the least significant byte comes first."), 12, 400, INK2, "middle", 'font-style="italic"'))
    save("index-bin.svg", 322, b)


# ── f. coupe et couches : MIP ────────────────────────────────────────────────
def mips_slab():
    b = [title(tr("Un MIP sur une épaisseur : les MIP de couches + les plans des extrémités", "A MIP over a thickness: layer MIPs + the end planes"))]
    x0, w, y = 40, 720, 120
    total = 320
    k = w / total
    for l in range(5):
        b.append(rect(x0 + l * 64 * k, y, 64 * k, 60, "#f8f9fd", LINE))
        b.append(text(x0 + (l * 64 + 32) * k, y - 8, tr(f"couche {l}", f"layer {l}"), 12, 700, INK2, "middle"))
        b.append(text(x0 + (l * 64 + 32) * k, y + 24, f"z {l * 64}–{l * 64 + 63}", 12, 400, INK2, "middle"))
    a, e = 50, 270
    for lo, hi, col in ((a, 64, "amber"), (256, e, "amber")):
        st, so = P[col]
        b.append(rect(x0 + lo * k, y, (hi - lo) * k, 60, so, st, 0, 2))
    for l in (1, 2, 3):
        st, so = P["green"]
        b.append(rect(x0 + l * 64 * k, y, 64 * k, 60, so, st, 0, 2.4))
        b.append(text(x0 + (l * 64 + 32) * k, y + 46, "MIP", 13, 800, st, "middle"))
    b.append(f'<line x1="{x0 + a * k}" y1="{y + 80}" x2="{x0 + e * k}" y2="{y + 80}" stroke="{INK}" stroke-width="2.4" marker-start="url(#arr)" marker-end="url(#arr)"/>')
    b.append(text(x0 + (a + e) / 2 * k, y + 104, tr(f"épaisseur demandée : z {a} à {e - 1}  (220 plans)", f"requested thickness: z {a} to {e - 1}  (220 planes)"), 13, 700, INK, "middle"))
    b.append(rect(80, 250, 300, 62, P["green"][1], P["green"][0], 10, 1.5))
    b.append(text(230, 274, tr("3 images (MIP des couches 1, 2, 3)", "3 images (MIPs of layers 1, 2, 3)"), 13, 800, P["green"][0], "middle"))
    b.append(text(230, 294, tr("couches entièrement dans l'épaisseur", "layers entirely inside the thickness"), 12, 400, INK, "middle"))
    b.append(rect(420, 250, 300, 62, P["amber"][1], P["amber"][0], 10, 1.5))
    b.append(text(570, 274, tr("28 plans lus un par un", "28 planes read one by one"), 13, 800, P["amber"][0], "middle"))
    b.append(text(570, 294, tr("z 50–63 et z 256–269 (les extrémités)", "z 50–63 and z 256–269 (the ends)"), 12, 400, INK, "middle"))
    b.append(text(400, 340, tr("31 images au lieu de 220 : et le résultat est identique pixel pour pixel.", "31 images instead of 220: and the result is identical pixel for pixel."),
                  13, 700, INK, "middle"))
    save("mips-schema.svg", 360, b)


# ── g. planes : une coupe XY sans / avec planes/ ─────────────────────────────
def planes_schema():
    b = [title(tr("Une coupe XY : toute une couche de briques, ou un seul plan", "An XY cut: a whole layer of bricks, or a single plane"))]
    b.append(rect(30, 60, 350, 240, "#fff", LINE, 12))
    b.append(text(205, 88, tr("Sans planes/ : via les briques", "Without planes/: through the bricks"), 14, 800, P["amber"][0], "middle"))
    for k in range(10, -1, -1):
        b.append(rect(90 + k * 6, 130 - k * 4 + 20, 120, 80, "#ffe8cc", P["amber"][0], 2, 1.1))
    b.append(rect(90, 150, 120, 80, "#ffd8a8", P["amber"][0], 2, 1.6))
    b.append(text(205 + 20, 245, tr("la coupe voulue est ici…", "the wanted cut is in here…"), 12, 400, INK2))
    b.append(text(205, 268, tr("…mais il faut lire les 64 plans de la couche", "…but all 64 planes of the layer must be read"), 12.5, 700, P["amber"][0], "middle"))
    b.append(text(205, 288, tr("(≈ 190 Mo sur un grand embryon)", "(≈ 190 MB on a large embryo)"), 12, 400, INK2, "middle"))
    b.append(rect(420, 60, 350, 240, "#fff", LINE, 12))
    b.append(text(595, 88, tr("Avec planes/ : un plan à la fois", "With planes/: one plane at a time"), 14, 800, P["green"][0], "middle"))
    for k in range(10, -1, -1):
        b.append(rect(480 + k * 6, 130 - k * 4 + 20, 120, 80, "#f8f9fd", LINE, 2, 0.8))
    b.append(rect(480 + 5 * 6, 130 - 5 * 4 + 20, 120, 80, "#b2f2bb", P["green"][0], 2, 2.2))
    b.append(text(595, 268, tr("on ne lit que les tuiles de ce plan", "only the tiles of that plane are read"), 12.5, 700, P["green"][0], "middle"))
    b.append(text(595, 288, tr("(des dizaines de fois moins d'octets)", "(tens of times fewer bytes)"), 12, 400, INK2, "middle"))
    save("planes-schema.svg", 322, b)


# ── h. formats 1 → 4 ─────────────────────────────────────────────────────────
def formats():
    b = [title(tr("Les quatre formats de données : un escalier", "The four data formats: a staircase"))]
    steps = [("1", tr("briques v2", "v2 bricks"), tr("bricks/ seul", "bricks/ only"), "grey"),
             ("2", "planes/", tr("coupes XY rapides", "fast XY cuts"), "blue"),
             ("3", "mips/", tr("MIP par couche", "per-layer MIP"), "green"),
             ("4", tr("briques v3", "v3 bricks"), tr("bordure + index.bin", "border + index.bin"), "amber")]
    pal = dict(P); pal["grey"] = ("#868e96", "#f1f3f5")
    for i, (n, name, desc, col) in enumerate(steps):
        st, so = pal[col]
        x, h = 40 + i * 185, 70 + i * 34
        yb = 270
        b.append(rect(x, yb - h, 165, h, so, st, 10, 2))
        b.append(text(x + 82, yb - h + 28, tr(f"format {n}", f"format {n}"), 15, 800, st, "middle"))
        b.append(text(x + 82, yb - h + 50, name, 13, 700, INK, "middle"))
        b.append(text(x + 82, yb - h + 68, desc, 12, 400, INK2, "middle"))
        if i:
            b.append(text(x - 10, yb + 24, f"m00{i + 1}", 12, 700, P["violet"][0], "middle"))
    b.append(text(400, 318, tr("m002-planes · m003-layer-mips · m004-bricks-v3 : les migrations qui font monter un jeu de données d'une marche.",
                              "m002-planes · m003-layer-mips · m004-bricks-v3: the migrations that move a dataset up one step."), 12, 400, INK2, "middle", 'font-style="italic"'))
    save("formats.svg", 340, b)


def build():
    for f in (tuiles, bordure, mosaique_schema, superblocs, index_bin, mips_slab, planes_schema, formats):
        f()


if __name__ == "__main__":
    build()
