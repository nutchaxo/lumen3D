"""Figures de la partie « formats et migrations »."""
import json
from pathlib import Path
from svglib import *

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"


def real_run():
    p = DATA / "real_migration.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


# ── Les quatre formats ─────────────────────────────────────────────────────────
def formats_escalier():
    b = [title(tr("Les quatre formats de données", "The four data formats"),
               tr("Chaque marche ajoute une structure à côté des briques ; une migration sait y monter.",
                  "Each step adds a structure beside the bricks; a migration knows how to climb to it."))]
    steps = [
        ("grey", "1", tr("briques v2", "v2 bricks"), [tr("64³ sans bordure", "64³, no border"), tr("manifeste JSON", "JSON manifest"), tr("avant la 1.58.0", "before 1.58.0")], tr("(point de départ)", "(starting point)")),
        ("amber", "2", "planes/", [tr("un fichier par plan Z", "one file per Z plane"), tr("PNG 512² sans perte", "lossless 512² PNG"), tr("coupes XY rapides", "fast XY cuts")], "m002-planes"),
        ("teal", "3", "mips/", [tr("MIP par couche de 64", "MIP per 64-plane layer"), tr("même moule que planes/", "same mould as planes/"), tr("z-stack rapides", "fast z-stack")], "m003-layer-mips"),
        ("green", "4", tr("briques v3", "v3 bricks"), [tr("bricks/ reconstruit (66³)", "bricks/ rebuilt (66³)"), tr("bordure, Z réduit", "border, Z reduced"), tr("index.bin, détail local", "index.bin, local detail")], "m004-bricks-v3"),
    ]
    x0, w = 24, 178
    for i, (col, num, hd, lines, mig) in enumerate(steps):
        x = x0 + i * (w + 13)
        top = 215 - i * 38
        s, soft = P[col]
        b.append(R(x, top, w, 330 - top + 24, soft, s, 12, 1.8))
        b.append(CIRC(x + 24, top + 26, 15, s))
        b.append(T(x + 24, top + 32, num, 17, 800, "#fff", "middle"))
        b.append(T(x + 48, top + 32, hd, 15, 800, s, maxw=w - 58))
        for j, ln in enumerate(lines):
            b.append(T(x + 14, top + 62 + j * 18, ln, 11.5, 400, INK, maxw=w - 22))
        b.append(R(x + 10, 322, w - 20, 22, "#fff", s, 11, 1.3))
        b.append(T(x + w / 2, 337, mig, 11.5, 700, s, "middle", mono=True, maxw=w - 24))
        if i:
            b.append(L(x - 13, top + 60, x, top + 60, s, 2.4, arrow=True))
    b.append(R(24, 372, 752, 70, "#fff", LINE, 12))
    b.append(T(40, 396, tr("Trois faits à retenir", "Three facts to remember"), 13.5, 800))
    b.append(T(40, 416, tr("• le viewer sait lire les formats 1 à 4 ; les marches 2 à 4 ne servent qu'à aller plus vite et plus beau ;",
                           "• the viewer reads formats 1 to 4; steps 2 to 4 only make things faster and nicer;"), 12, 400, INK2, maxw=725))
    b.append(T(40, 434, tr("• le pipeline 0.21.0 écrit directement le format 4 : un jeu fraîchement traité n'a rien à migrer.",
                           "• pipeline 0.21.0 writes format 4 directly: a freshly processed dataset has nothing to migrate."), 12, 400, INK2, maxw=725))
    save("formats-escalier.svg", 458, b)


def v2_v3():
    b = [title(tr("Une brique v2 et une brique v3", "A v2 brick and a v3 brick"),
               tr("Ce que la migration m004 change, point par point.", "What migration m004 changes, point by point."))]
    # deux colonnes
    cols = [(24, "grey", "v2", [
        (tr("taille", "size"), "64 × 64 × 64"),
        (tr("bordure", "border"), tr("aucune", "none")),
        (tr("mosaïque", "mosaic"), tr("8 × 8 coupes de 64² (512²)", "8 × 8 slices of 64² (512²)")),
        (tr("lecture GPU", "GPU sampling"), tr("plus proche voisin (NEAREST)", "nearest neighbour (NEAREST)")),
        (tr("niveaux", "levels"), tr("seuil d'occupation 0,05 %", "occupancy threshold 0.05 %")),
        (tr("où est la brique ?", "where is the brick?"), tr("JSON : une entrée par brique", "JSON: one entry per brick")),
        (tr("paquets", "packs"), "lod0/c0/pack_00.bin"),
        (tr("gros embryon", "big embryo"), tr("manifeste ≈ 7,6 Mo", "manifest ≈ 7.6 MB")),
    ]), (412, "green", "v3", [
        (tr("taille", "size"), "66 × 66 × 66"),
        (tr("bordure", "border"), tr("1 voxel (clamp-to-edge)", "1 voxel (clamp-to-edge)")),
        (tr("mosaïque", "mosaic"), tr("9 × 8 coupes de 66² (594 × 528)", "9 × 8 slices of 66² (594 × 528)")),
        (tr("lecture GPU", "GPU sampling"), tr("LINÉAIRE, sans couture", "LINEAR, seamless")),
        (tr("niveaux", "levels"), tr("exacts : un voxel ≥ 1 suffit", "exact: one voxel ≥ 1 is enough")),
        (tr("où est la brique ?", "where is the brick?"), tr("index.bin : 10 octets par case", "index.bin: 10 bytes per slot")),
        (tr("paquets", "packs"), "l0/c0/p00000.bin"),
        (tr("gros embryon", "big embryo"), tr("index ≈ 233 ko", "index ≈ 233 kB")),
    ])]
    for x, col, hd, rows in cols:
        s, soft = P[col]
        b.append(R(x, 70, 364, 330, soft, s, 14, 1.8))
        b.append(T(x + 182, 98, hd, 20, 800, s, "middle"))
        for i, (k, v) in enumerate(rows):
            y = 130 + i * 33
            b.append(T(x + 14, y, k, 11.8, 700, INK2, maxw=120))
            b.append(T(x + 142, y, v, 12, 400, INK, mono=(k in ("paquets", "packs")), maxw=216))
            if i < len(rows) - 1:
                b.append(L(x + 12, y + 12, x + 352, y + 12, "#fff", 1.2))
    b.append(PATH("M 388 235 L 410 235", INK2, 2.4, arrow=True))
    b.append(R(24, 414, 752, 56, P["amber"][1], P["amber"][0], 10, 1.4))
    b.append(T(400, 438, tr("Le niveau natif est recopié voxel pour voxel : la brique v2 absente du manifeste vaut zéro,", "The native level is copied voxel for voxel: a v2 brick absent from the manifest is zero,"), 12, 600, INK, "middle", maxw=730))
    b.append(T(400, 456, tr("la brique v3 absente de l'index vaut zéro, bordure comprise.", "a v3 brick absent from the index is zero, border included."), 12, 600, INK, "middle", maxw=730))
    save("v2-v3.svg", 486, b)


# ── Les unités de travail ──────────────────────────────────────────────────────
def unites():
    b = [title(tr("Découper le travail en unités indépendantes", "Cutting the work into independent units"),
               tr("Exemple réel : le jeu de démonstration 3D (768 × 576 × 112 voxels, 3 canaux) pour m002.",
                  "Real example: the 3D demo dataset (768 × 576 × 112 voxels, 3 channels) for m002."))]
    # clé
    b.append(R(24, 70, 752, 74, "#fff", LINE, 12))
    key = "t0.z0.c1.y1.x0"
    parts = [("t0", "blue", tr("arbre", "tree")), (".z0", "violet", tr("couche", "layer")), (".c1", "green", tr("canal", "channel")),
             (".y1", "amber", tr("tuile Y", "tile Y")), (".x0", "amber", tr("tuile X", "tile X"))]
    x = 60
    for txt, col, lab in parts:
        w = len(txt) * 16.2 + 14
        b.append(R(x, 82, w, 30, P[col][1], P[col][0], 8, 1.6))
        b.append(T(x + w / 2, 104, txt, 18, 700, P[col][0], "middle", mono=True))
        b.append(T(x + w / 2, 132, lab, 10.8, 600, P[col][0], "middle"))
        x += w + 10
    b.append(T(560, 102, tr("= « une couche de 64 plans,", "= “one 64-plane layer,"), 12.5, 600, INK2))
    b.append(T(560, 120, tr("un canal, une tuile 512² »", "one channel, one 512² tile”"), 12.5, 600, INK2))
    # grille des 24 unités
    b.append(T(24, 172, tr("Les 24 unités de m002 pour ce jeu", "The 24 m002 units for this dataset"), 14, 800))
    gx, gy = 40, 192
    for layer in range(2):
        for c in range(3):
            ox = gx + c * 120
            oy = gy + layer * 118
            col = ["blue", "green", "violet"][c]
            b.append(T(ox + 44, oy - 4, f"c{c}", 11, 700, P[col][0], "middle", mono=True))
            for ty in range(2):
                for tx in range(2):
                    w = 36 if tx == 0 else 18
                    h = 36 if ty == 0 else 18
                    px = ox + (0 if tx == 0 else 38)
                    py = oy + (0 if ty == 0 else 38)
                    b.append(R(px, py, w, h, P[col][1], P[col][0], 3, 1.3))
        b.append(T(gx - 8, gy + layer * 118 + 40, f"z{layer}", 11, 700, P["violet"][0], "end", mono=True))
    b.append(T(gx + 150, gy + 252, tr("2 couches × 3 canaux × (2 × 2 tuiles) = 24 unités", "2 layers × 3 channels × (2 × 2 tiles) = 24 units"), 12.5, 700, INK, "middle"))
    # explication à droite
    b.append(card(420, 172, 356, 138, "blue", tr("Pourquoi des unités ?", "Why units?"), [
        tr("• chacune se refait seule : rejouée, elle écrase", "• each can be redone alone: replayed, it overwrites"),
        tr("  ses propres tuiles sans rien casser ;", "  its own tiles without breaking anything;"),
        tr("• deux exécutants peuvent s'en partager la liste ;", "• two executors can share the list;"),
        tr("• on s'arrête et on reprend à n'importe quel moment.", "• you can stop and resume at any time.")], size=12))
    b.append(R(420, 320, 356, 136, "#fff", LINE, 12))
    b.append(T(434, 342, tr("Les trois formes de clé", "The three key shapes"), 13, 800))
    for i, (k, d) in enumerate([("t{t}.z{bz}.c{c}.y{ty}.x{tx}", "m002  " + tr("couche de plans", "plane layer")),
                                ("t{t}.l{l}.c{c}.y{ty}.x{tx}", "m003  " + tr("couche pour le MIP", "layer for the MIP")),
                                ("t{t}.k{k}.c{c}.z{BZ}.y{BY}.x{BX}", "m004  " + tr("super-bloc 4×4×4", "4×4×4 super-block"))]):
        b.append(T(434, 368 + i * 28, k, 11.4, 400, INK, mono=True, maxw=330))
        b.append(T(434, 382 + i * 28, d, 10.8, 600, INK2, maxw=330))
    b.append(R(24, 470, 752, 50, P["grey"][1], LINE, 10))
    b.append(T(400, 492, tr("Une unité vide (toutes ses briques absentes) est comptée « faite » d'emblée : elle ne demande aucun travail.", "An empty unit (all its bricks absent) counts as “done” from the start: it needs no work."), 12, 600, INK, "middle", maxw=730))
    b.append(T(400, 510, tr("Pour le jeu live de démonstration (4 images × 2 canaux × 1 tuile) : 8 unités.", "For the live demo dataset (4 frames × 2 channels × 1 tile): 8 units."), 12, 400, INK2, "middle", maxw=730))
    save("unites.svg", 536, b)


# ── Le journal (la feuille de pointage) ────────────────────────────────────────
def journal_migration():
    r = real_run()
    b = [title(tr("La feuille de pointage du déménagement", "The moving company's tally sheet"),
               tr("Journal et magasin de tuiles d'une vraie conversion m002 (jeu synthétique de test).",
                  "Journal and tile store of a real m002 conversion (synthetic test dataset)."))]
    # journal à gauche (JSON annoté)
    b.append(R(24, 70, 440, 370, "#fff", P["blue"][0], 12, 1.6))
    b.append(T(40, 94, tr("uploads/migrations/3d__<jeu>__m002-planes.json", "uploads/migrations/3d__<set>__m002-planes.json"), 11.5, 700, P["blue"][0], mono=True, maxw=405))
    lines = [
        ('{ "migration": "m002-planes",', None),
        ('  "dataset": "3d/Synthetique-E95",', None),
        ('  "sourceManifests": { "0": "46475b1a…" },', ("blue", tr("empreinte du manifeste de départ", "fingerprint of the starting manifest"))),
        ('  "units": { "total": 24, "empty": 1 },', ("violet", tr("24 caisses, dont 1 vide d'office", "24 boxes, 1 of them empty from the start"))),
        ('  "done": [ "t0.z0.c0.y0.x0", …(23) ],', ("green", tr("les caisses déjà cochées", "the boxes already ticked"))),
        ('  "executors": { "browser": 0, "server": 23 },', ("amber", tr("qui a porté combien de caisses", "who carried how many boxes"))),
        ('  "state": "running",', ("red", tr("running → assembling → swapped", "running → assembling → swapped"))),
        ('  "updatedAt": "2026-10-07T18:49:55Z" }', None),
    ]
    y = 122
    for ln, note in lines:
        b.append(T(40, y, ln, 11.6, 400, INK, mono=True, maxw=410))
        if note:
            col, txt = note
            b.append(R(58, y + 7, len(txt) * 6.1 + 14, 18, P[col][1], P[col][0], 9, 1))
            b.append(T(65, y + 20, txt, 10.8, 600, P[col][0]))
            y += 42
        else:
            y += 26
    # magasin à droite
    b.append(R(478, 70, 298, 370, "#fff", P["green"][0], 12, 1.6))
    b.append(T(494, 94, tr("Le magasin de tuiles", "The tile store"), 13.5, 800, P["green"][0]))
    store = ["uploads/migrations/", "└ 3d__…__m002-planes/", "   └ t0/", "      ├ z0/  c0.y0.x0.png", "      │      c0.y0.x1.png", "      │      c0.y1.x0.png …", "      ├ z1/  …", "      └ z129/ …"]
    for i, ln in enumerate(store):
        b.append(T(494, 122 + i * 22, ln, 11.2, 400, INK, mono=True, maxw=270))
    b.append(T(494, 330, tr("un PNG gris par plan et par tuile :", "one grey PNG per plane and per tile:"), 11.5, 600, INK2))
    b.append(T(494, 348, tr("une unité = jusqu'à 64 petits fichiers", "one unit = up to 64 small files"), 11.5, 400, INK2))
    if r:
        st = [s for s in r["steps"] if s["label"].startswith("m002-planes : toutes")][0]
        b.append(T(494, 376, tr("ici : 42,0 Mo de tuiles avant l'assemblage", "here: 42.0 MB of tiles before assembly"), 11.5, 700, P["green"][0]))
    b.append(T(494, 398, tr("jamais servi : c'est un atelier, pas une vitrine", "never served: a workshop, not a shop window"), 11.5, 400, INK2, maxw=280))
    # bas
    b.append(R(24, 454, 752, 74, P["amber"][1], P["amber"][0], 10, 1.4))
    b.append(T(40, 478, tr("Pourquoi une feuille de pointage ?", "Why a tally sheet?"), 13, 800, P["amber"][0]))
    b.append(T(40, 498, tr("Comme un déménageur coche chaque caisse livrée : si le camion tombe en panne, ou qu'on change de camion", "Like a mover ticking each delivered box: if the truck breaks down, or you switch trucks,"), 12, 400, INK, maxw=725))
    b.append(T(40, 516, tr("(navigateur → serveur), on repart de la dernière caisse cochée. Une caisse livrée deux fois ne gêne personne.", "(browser → server), you restart from the last ticked box. A box delivered twice bothers no one."), 12, 400, INK, maxw=725))
    save("journal-migration.svg", 544, b)


# ── Deux voies, un journal ─────────────────────────────────────────────────────
def deux_voies():
    b = [title(tr("Deux voies, un seul journal", "Two lanes, one journal"),
               tr("Le navigateur et le serveur se partagent la même liste d'unités.", "The browser and the server share the same list of units."))]
    # voie navigateur
    b.append(R(24, 70, 300, 292, P["blue"][1], P["blue"][0], 14, 1.8))
    b.append(T(174, 96, tr("Voie « Ce navigateur »", "“This browser” lane"), 14.5, 800, P["blue"][0], "middle"))
    steps = [tr("① lire les octets d'entrée", "① read the input bytes"), tr("   (read_ranges : 1 requête)", "   (read_ranges: 1 request)"),
             tr("② décoder le WebP sans perte", "② decode the lossless WebP"), tr("③ recouper et encoder en PNG", "③ re-cut and encode as PNG"),
             tr("④ envoyer le résultat (unit_put)", "④ send the result (unit_put)")]
    for i, s in enumerate(steps):
        b.append(T(40, 126 + i * 24, s, 12.5, 400 if s.startswith("   ") else 600, INK2 if s.startswith("   ") else INK, maxw=270))
    b.append(R(40, 252, 268, 50, "#fff", P["blue"][0], 8, 1.3))
    b.append(T(174, 272, tr("Web Workers : 2 × 2 unités au plus", "Web Workers: at most 2 × 2 units"), 11.8, 700, P["blue"][0], "middle"))
    b.append(T(174, 290, "migration-worker.js + js/migrations/m00x.js", 10.2, 400, INK2, "middle", mono=True))
    b.append(T(174, 330, tr("L'onglet doit rester ouvert", "The tab must stay open"), 11.8, 700, P["red"][0], "middle"))
    b.append(T(174, 348, tr("(fermer = mettre en pause)", "(closing = pausing)"), 11.5, 400, INK2, "middle"))
    # voie serveur
    b.append(R(476, 70, 300, 292, P["amber"][1], P["amber"][0], 14, 1.8))
    b.append(T(626, 96, tr("Voie « Le serveur »", "“The server” lane"), 14.5, 800, P["amber"][0], "middle"))
    steps = [tr("① l'onglet appelle unit_run", "① the tab calls unit_run"), tr("   (≤ 20 s par appel, bornées)", "   (≤ 20 s per call, bounded)"),
             tr("② le serveur lit les briques", "② the server reads the bricks"), tr("③ décode, recoupe, encode", "③ decodes, re-cuts, encodes"),
             tr("④ écrit dans le magasin, coche", "④ writes to the store, ticks")]
    for i, s in enumerate(steps):
        b.append(T(492, 126 + i * 24, s, 12.5, 400 if s.startswith("   ") else 600, INK2 if s.startswith("   ") else INK, maxw=270))
    b.append(R(492, 252, 268, 50, "#fff", P["amber"][0], 8, 1.3))
    b.append(T(626, 272, tr("Pillow (Python) ou GD (PHP)", "Pillow (Python) or GD (PHP)"), 11.8, 700, P["amber"][0], "middle"))
    b.append(T(626, 290, tr("décodage + encodage WebP sans perte", "lossless WebP decode + encode"), 11, 400, INK2, "middle"))
    b.append(T(626, 330, tr("L'onglet boucle, mais ne calcule rien", "The tab loops, but computes nothing"), 11.8, 700, P["red"][0], "middle", maxw=270))
    b.append(T(626, 348, tr("(hébergements sans processus de fond)", "(hosts without background processes)"), 11, 400, INK2, "middle", maxw=270))
    # journal au centre
    b.append(R(338, 110, 124, 160, P["green"][1], P["green"][0], 12, 2))
    b.append(T(400, 134, tr("Journal", "Journal"), 14, 800, P["green"][0], "middle"))
    b.append(T(400, 152, "+", 14, 700, P["green"][0], "middle"))
    b.append(T(400, 172, tr("magasin", "tile"), 12.5, 700, P["green"][0], "middle"))
    b.append(T(400, 188, tr("de tuiles", "store"), 12.5, 700, P["green"][0], "middle"))
    b.append(T(400, 216, "uploads/", 11, 400, INK2, "middle", mono=True))
    b.append(T(400, 232, "migrations/", 11, 400, INK2, "middle", mono=True))
    b.append(T(400, 256, tr("jamais servi", "never served"), 10.5, 600, INK2, "middle"))
    b.append(L(324, 190, 338, 190, P["blue"][0], 2.4, arrow=True))
    b.append(L(476, 190, 462, 190, P["amber"][0], 2.4, arrow=True))
    # régulateur
    b.append(R(24, 376, 300, 56, "#fff", P["violet"][0], 10, 1.5))
    b.append(T(174, 398, tr("Régulateur réseau (NetGovernor)", "Network governor (NetGovernor)"), 12.5, 800, P["violet"][0], "middle"))
    b.append(T(174, 418, tr("6 en vol · 4 à 6 requêtes/s · ralentit si 429/503", "6 in flight · 4 to 6 requests/s · slows on 429/503"), 11, 400, INK2, "middle", maxw=285))
    b.append(L(174, 376, 174, 362, P["violet"][0], 2, arrow=True))
    # finalize
    b.append(R(338, 376, 438, 56, "#fff", P["green"][0], 10, 1.5))
    b.append(T(557, 398, tr("Quand toutes les unités sont faites : finalize (toujours côté serveur)", "When all units are done: finalize (always server-side)"), 12.3, 800, P["green"][0], "middle", maxw=420))
    b.append(T(557, 418, tr("assemble, échange, change la version — voir plus bas", "assembles, swaps, bumps the version — see below"), 11.2, 400, INK2, "middle", maxw=420))
    b.append(R(24, 444, 752, 44, P["grey"][1], LINE, 10))
    b.append(T(400, 471, tr("Un jeu = un exécutant à la fois (verrouillé pendant l'exécution) ; deux jeux sur deux voies avancent en parallèle.", "One dataset = one executor at a time (locked while running); two datasets on two lanes advance in parallel."), 11.8, 600, INK, "middle", maxw=735))
    save("deux-voies.svg", 504, b)


# ── La machine à états d'un travail ────────────────────────────────────────────
def machine_etats():
    b = [title(tr("La vie d'un travail de migration", "The life of a migration job"),
               tr("États écrits dans le journal ; chaque flèche porte l'appel d'API qui la provoque.",
                  "States written in the journal; each arrow carries the API call that causes it."))]
    def node(x, y, w, h, col, label, sub=None):
        s, soft = P[col]
        out = [R(x, y, w, h, soft, s, 14, 2)]
        out.append(T(x + w / 2, y + (22 if sub else h / 2 + 5), label, 15, 800, s, "middle", mono=True))
        if sub:
            out.append(T(x + w / 2, y + 40, sub, 10.8, 400, INK2, "middle", maxw=w - 10))
        return out
    b.append(T(56, 123, tr("(rien)", "(none)"), 12, 600, INK2, "middle"))
    b.append(node(170, 90, 140, 60, "blue", "running", "unit_put / unit_run"))
    b.append(node(380, 90, 150, 56, "amber", "assembling", tr("assemblage reprenable", "resumable assembly")))
    b.append(node(590, 90, 130, 56, "green", "swapped", tr("échange fait", "swap done")))
    b.append(node(380, 226, 150, 56, "red", "failed", "source_changed…"))
    b.append(R(560, 226, 200, 56, "#fff", P["green"][0], 14, 2))
    b.append(T(660, 250, tr("terminé", "finished"), 15, 800, P["green"][0], "middle"))
    b.append(T(660, 268, tr("journal et tuiles supprimés", "journal and tiles deleted"), 10.8, 400, INK2, "middle"))
    b.append(L(86, 120, 170, 120, INK2, 2, arrow=True))
    b.append(T(128, 110, "plan", 10.5, 700, INK2, "middle", mono=True))
    b.append(L(310, 118, 380, 118, INK2, 2, arrow=True))
    b.append(T(345, 108, "finalize", 10.5, 700, INK2, "middle", mono=True))
    b.append(L(530, 118, 590, 118, INK2, 2, arrow=True))
    b.append(T(560, 108, "finalize", 10.5, 700, INK2, "middle", mono=True))
    b.append(L(655, 146, 660, 226, INK2, 2, arrow=True))
    b.append(T(668, 190, "finalize", 10.5, 700, INK2, mono=True))
    b.append(L(455, 146, 455, 226, P["red"][0], 2, dash="5 4", arrow=True))
    b.append(T(463, 190, tr("le manifeste a changé", "the manifest changed"), 10.8, 600, P["red"][0]))
    b.append(PATH("M 270 150 L 270 254 L 380 254", P["red"][0], 2, dash="5 4", arrow=True))
    b.append(PATH("M 380 272 L 205 272 L 205 152", P["red"][0], 2, dash="5 4", arrow=True))
    b.append(T(293, 290, tr("plan : on repart propre", "plan: start clean"), 10.5, 600, P["red"][0], "middle"))
    # cancel
    b.append(R(24, 312, 752, 188, "#fff", LINE, 12))
    b.append(T(40, 336, tr("Ce qu'il faut savoir", "What to know"), 14, 800))
    pts = [
        tr("• Pause : c'est l'onglet qui s'arrête, pas le journal — il reste « running » et se reprend tel quel.", "• Pause: it is the tab that stops, not the journal — it stays “running” and resumes as is."),
        tr("• finalize rend complete:false tant qu'il n'a pas fini : on le rappelle (assemblage par morceaux).", "• finalize answers complete:false until done: call it again (assembly in pieces)."),
        tr("• swapped = les nouveaux fichiers sont en place, la version n'est pas encore montée. Un plantage ici est sans danger.", "• swapped = the new files are in place, the version is not bumped yet. A crash here is harmless."),
        tr("• failed + source_changed (depuis running ou assembling) : le jeu a été retraité ; plan vide les tuiles et recommence.", "• failed + source_changed (from running or assembling): the dataset was re-processed; plan empties the tiles and restarts."),
        tr("• cancel (la croix) : supprime journal et tuiles ; le jeu de données reste exactement comme il était.", "• cancel (the cross): deletes journal and tiles; the dataset stays exactly as it was."),
    ]
    for i, s in enumerate(pts):
        b.append(T(44, 362 + i * 26, s, 12, 400, INK, maxw=720))
    save("machine-etats.svg", 516, b)


# ── finalize ───────────────────────────────────────────────────────────────────
def finalize():
    r = real_run()
    b = [title(tr("Finalize : l'échange et le changement de version", "Finalize: the swap and the version bump"),
               tr("Exemple m002 ; m003 est identique avec mips/, m004 ajoute deux gestes (voir le texte).",
                  "m002 example; m003 is identical with mips/, m004 adds two moves (see text)."))]
    steps = [
        ("blue", "1", tr("Tout est fait ?", "All done?"), tr("toutes les unités sont cochées et les manifestes sources n'ont pas changé", "all units are ticked and the source manifests have not changed")),
        ("blue", "2", tr("Assembler", "Assemble"), tr("un fichier zNNNNN.bin à la fois dans .planes-incoming/ ; chaque PNG a son en-tête vérifié", "one zNNNNN.bin at a time in .planes-incoming/; every PNG has its header checked")),
        ("amber", "3", tr("Échanger", "Swap"), tr("planes/ → .planes-old/, puis .planes-incoming/ → planes/ : deux renommages", "planes/ → .planes-old/, then .planes-incoming/ → planes/: two renames")),
        ("green", "4", tr("Monter la version", "Bump the version"), tr("formatVersion = 2, sous le verrou de metadata.json, fusionné dans le fichier courant", "formatVersion = 2, under the metadata.json lock, merged into the current file")),
        ("grey", "5", tr("Nettoyer", "Clean up"), tr("supprime .planes-old/, le journal et le magasin de tuiles", "deletes .planes-old/, the journal and the tile store")),
    ]
    for i, (col, n, hd, ds) in enumerate(steps):
        y = 68 + i * 44
        s, soft = P[col]
        b.append(R(24, y, 752, 38, soft, s, 10, 1.6))
        b.append(CIRC(48, y + 19, 12, s))
        b.append(T(48, y + 24, n, 13, 800, "#fff", "middle"))
        b.append(T(70, y + 24, hd, 13, 800, s, maxw=150))
        b.append(T(226, y + 24, ds, 11.5, 400, INK, maxw=540))
    # frise de l'état du disque
    b.append(T(24, 316, tr("Ce que voit le disque, instant après instant", "What the disk looks like, moment by moment"), 14, 800))
    segs = [(24, 330, "red", tr("version 1 + ancien état", "version 1 + old state"), tr("tout est intact", "everything intact")),
            (354, 206, "amber", tr("version 1 + nouveaux fichiers", "version 1 + new files"), tr("« à mettre à jour » : relançable", "“needs update”: can be re-run")),
            (560, 216, "green", tr("version 2", "version 2"), tr("terminé", "finished"))]
    for x, w2, col, lab, sub in segs:
        s, soft = P[col]
        b.append(R(x, 328, w2, 56, soft, s, 8, 1.6))
        b.append(T(x + w2 / 2, 351, lab, 12.2, 800, s, "middle", maxw=w2 - 10))
        b.append(T(x + w2 / 2, 370, sub, 11, 400, INK2, "middle", maxw=w2 - 10))
    b.append(L(354, 320, 354, 392, P["amber"][0], 2.2))
    b.append(T(346, 406, tr("étape 3 : renommage", "step 3: rename"), 11, 700, P["amber"][0], "end"))
    b.append(L(560, 320, 560, 392, P["green"][0], 2.6))
    b.append(T(770, 406, tr("étape 4 : la version monte = point de validation", "step 4: version bump = commit point"), 11.2, 800, P["green"][0], "end"))
    # crash
    b.append(R(24, 424, 752, 128, "#fff", LINE, 12))
    b.append(T(40, 448, tr("Et si ça plante ?", "What if it crashes?"), 14, 800))
    for i, s in enumerate([
        tr("• pendant l'assemblage : l'ancien état est intact ; on rappelle finalize, il finit les fichiers manquants ;", "• during assembly: the old state is intact; call finalize again, it finishes the missing files;"),
        tr("• entre l'échange et la version : la structure neuve est là, la version est restée basse ; finalize est idempotent ;", "• between swap and version: the new structure is there, the version stayed low; finalize is idempotent;"),
        tr("• m004 : bricks/ est échangé avec .bricks-incoming/ ; les manifestes planes/ et mips/ sont re-signés AVANT la version ;", "• m004: bricks/ is swapped with .bricks-incoming/; the planes/ and mips/ manifests are re-stamped BEFORE the version;"),
        tr("• m004 : l'ancien arbre (bricks.v2-old/) n'est supprimé qu'APRÈS le changement de version.", "• m004: the old tree (bricks.v2-old/) is deleted only AFTER the version bump.")]):
        b.append(T(44, 472 + i * 19, s, 11.8, 400, INK, maxw=722))
    save("finalize.svg", 568, b)


# ── Le test de vitesse ─────────────────────────────────────────────────────────
def speedtest():
    b = [title(tr("Le test de vitesse de 5 secondes", "The 5-second speed test"),
               tr("Les deux exécutants convertissent en même temps le même bloc synthétique.",
                  "Both executors convert the same synthetic block at the same time."))]
    b.append(R(24, 70, 752, 60, "#fff", LINE, 12))
    b.append(T(40, 94, tr("Le bloc : js/migrations/speedtest-brick.webp (≈ 128 ko, taches gaussiennes + bruit de Poisson)", "The block: js/migrations/speedtest-brick.webp (≈ 128 kB, Gaussian blobs + Poisson noise)"), 12, 600, INK, maxw=725))
    b.append(T(40, 114, tr("= ce que fait une unité pour chaque brique : décoder la mosaïque WebP, encoder ses voxels en une tuile PNG 512².", "= what a unit does per brick: decode the WebP mosaic, encode its voxels as one 512² PNG tile."), 12, 400, INK2, maxw=725))
    # barres temps
    b.append(T(24, 160, tr("Navigateur", "Browser"), 13, 800, P["blue"][0]))
    b.append(T(24, 232, tr("Serveur", "Server"), 13, 800, P["amber"][0]))
    # axe 0-5 s
    x0, x1 = 130, 740
    b.append(L(x0, 262, x1, 262, INK2, 1.5))
    for s in range(6):
        x = x0 + (x1 - x0) * s / 5
        b.append(L(x, 258, x, 266, INK2, 1.5))
        b.append(T(x, 282, f"{s} s", 11, 400, INK2, "middle"))
    # lots navigateur
    bw = (x1 - x0) / 5
    for i in range(4):
        xx = x0 + i * 1.18 * bw / 1.0
        b.append(R(xx, 142, 1.1 * bw - 6, 36, P["blue"][1], P["blue"][0], 6, 1.4))
        b.append(T(xx + (1.1 * bw - 6) / 2, 158, tr("lot de 16", "batch of 16"), 11, 700, P["blue"][0], "middle"))
        b.append(T(xx + (1.1 * bw - 6) / 2, 172, tr("2 requêtes", "2 requests"), 10, 400, INK2, "middle"))
    b.append(R(x0 + 4.7 * bw, 142, 0.3 * bw, 36, "#fff", LINE, 6, 1, 'stroke-dasharray="3 3"'))
    # appels serveur
    for i in range(5):
        xx = x0 + i * bw
        b.append(R(xx, 214, bw - 6, 36, P["amber"][1], P["amber"][0], 6, 1.4))
        b.append(T(xx + (bw - 6) / 2, 237, tr("speedtest ≤ 1 s", "speedtest ≤ 1 s"), 11, 700, P["amber"][0], "middle"))
    # explications
    items = [
        tr("• le navigateur télécharge 16 copies du bloc (1 requête), les décode et les encode, renvoie 16 tuiles (1 requête) — sous le régulateur ;", "• the browser downloads 16 copies of the block (1 request), decodes and encodes them, returns 16 tiles (1 request) — under the governor;"),
        tr("• le serveur enchaîne des appels d'au plus 1 s, un à la fois, jusqu'à la fin de la fenêtre ;", "• the server chains calls of at most 1 s, one at a time, until the window ends;"),
        tr("• score = blocs par seconde × 10, mesuré sur le temps du dernier lot ou appel terminé ; le plus haut gagne.", "• score = blocks per second × 10, measured over the time of the last completed batch or call; the higher wins."),
        tr("• le gagnant devient l'exécutant par défaut de chaque jeu dont l'opérateur n'a pas choisi ; aucune donnée n'est lue ni écrite.", "• the winner becomes the default executor of every dataset the operator has not set; no data is read or written."),
    ]
    for i, s in enumerate(items):
        b.append(T(24, 316 + i * 22, s, 11.6, 400, INK, maxw=752))
    save("speedtest.svg", 418, b)


# ── Hébergements mutualisés : octants et unit_timeout ──────────────────────────
def octants():
    b = [title(tr("Serveur trop lent : octants et reprise par le navigateur", "Server too slow: octants and browser takeover"),
               tr("Hébergement PHP mutualisé : une requête qui dépasse max_execution_time est tuée. Les octants concernent m004.", "Shared PHP host: a request that exceeds max_execution_time is killed. Octants concern m004."))]
    cols = [
        ("blue", "1", tr("Le serveur lance l'unité entière", "The server starts the whole unit"), [tr("(m004 : un super-bloc 4×4×4, ≤ 64 briques)", "(m004: one 4×4×4 super-block, ≤ 64 bricks)"), tr("attempts[unité] monte de 1 AVANT le départ", "attempts[unit] goes up by 1 BEFORE the start"), tr("(suivi tenu seulement si l'hôte limite le temps)", "(kept only when the host limits time)")]),
        ("amber", "2", tr("L'hôte tue la requête ?", "The host kills the request?"), [tr("max_execution_time est dépassé : coupure", "max_execution_time exceeded: cut off"), tr("au prochain appel, la même unité est", "at the next call, the same unit is"), tr("reprise en 8 octants (2×2×2 briques)", "redone as 8 octants (2×2×2 bricks)")]),
        ("violet", "3", tr("Octant par octant", "Octant by octant"), [tr("chacun est rangé puis noté dans le journal", "each is stored then noted in the journal"), tr("(partial[unité] = [0, 3, 5…])", "(partial[unit] = [0, 3, 5…])"), tr("l'unité est cochée quand tous y sont", "the unit is ticked when all are in")]),
        ("red", "4", tr("Tuée une deuxième fois", "Killed a second time"), [tr("409 unit_timeout (au bout de 2 morts)", "409 unit_timeout (after 2 deaths)"), tr("le journal reste « running », rien n'est perdu", "the journal stays “running”, nothing is lost"), tr("→ le NAVIGATEUR reprend cette étape", "→ the BROWSER takes this step over")]),
    ]
    for i, (col, n, hd, ls) in enumerate(cols):
        x = 24 + (i % 2) * 388
        y = 72 + (i // 2) * 116
        w = 364
        s, soft = P[col]
        b.append(R(x, y, w, 104, soft, s, 12, 1.7))
        b.append(CIRC(x + 22, y + 24, 12, s))
        b.append(T(x + 22, y + 29, n, 13, 800, "#fff", "middle"))
        b.append(T(x + 44, y + 29, hd, 13.5, 800, s, maxw=w - 54))
        for j, ln in enumerate(ls):
            b.append(T(x + 16, y + 52 + j * 19, ln, 11.8, 400, INK, maxw=w - 24))
    b.append(L(388, 124, 412, 124, INK2, 2, arrow=True))
    b.append(L(594, 176, 594, 188, INK2, 2, arrow=True))
    b.append(L(412, 240, 388, 240, INK2, 2, arrow=True))
    b.append(T(24, 322, tr("Un super-bloc et ses 8 octants", "A super-block and its 8 octants"), 13.5, 800))
    ox, oy = 40, 338
    cell = 22
    for z in range(2):
        for y in range(2):
            for x in range(2):
                n = z * 4 + y * 2 + x
                px = ox + x * (cell * 2 + 4) + z * 150
                py = oy + y * (cell * 2 + 4)
                done = n in (0, 1, 2, 4)
                b.append(R(px, py, cell * 2, cell * 2, P["green"][1] if done else "#fff", P["green"][0] if done else LINE, 4, 1.4))
                b.append(T(px + cell, py + cell + 5, str(n), 13, 700, P["green"][0] if done else INK2, "middle"))
    b.append(T(ox + 48, oy + 116, tr("moitié basse", "lower half"), 11, 400, INK2, "middle"))
    b.append(T(ox + 198, oy + 116, tr("moitié haute", "upper half"), 11, 400, INK2, "middle"))
    b.append(T(ox + 124, oy + 134, tr("verts = déjà rangés (partial)", "green = already stored (partial)"), 11, 600, P["green"][0], "middle"))
    b.append(card(400, 326, 376, 128, "grey", tr("Ce que garantit le mécanisme", "What the mechanism guarantees"), [
        tr("• aucun travail déjà rangé n'est perdu ;", "• no work already stored is lost;"),
        tr("• un octant n'est lancé que s'il tient dans le temps restant ;", "• an octant starts only if it fits in the time left;"),
        tr("• un nouveau plan remet les compteurs à zéro ;", "• a new plan resets the counters;"),
        tr("• le navigateur n'a pas ce plafond de temps.", "• the browser has no such time ceiling.")], size=11.8))
    b.append(R(24, 488, 752, 44, P["amber"][1], P["amber"][0], 10, 1.4))
    b.append(T(400, 515, tr("« limits.resettable » dit si l'hôte honore set_time_limit() ; sinon l'échéance est le début de la requête + max_execution_time.", "“limits.resettable” says whether the host honours set_time_limit(); otherwise the deadline is request start + max_execution_time."), 11.5, 600, INK, "middle", maxw=735))
    save("octants.svg", 548, b)


def run():
    formats_escalier()
    v2_v3()
    unites()
    journal_migration()
    deux_voies()
    machine_etats()
    finalize()
    speedtest()
    octants()
