"""Schémas §13.1 : le suivi cellulaire dans le viewer."""
import math

from svglib import P, INK, INK2, LINE, Svg, tr


def chemin():
    s = Svg("suivi-chemin.svg", 400)
    s.title(tr("Du fichier tracks.json aux sphères de l'écran", "From the tracks.json file to the spheres on screen"))
    cols = [
        ("blue", tr("1 · Le fichier", "1 · The file"), "tracks.json",
         tr("Une entrée par cellule : positions image par image en µm (stabilisées et brutes), région, lignée.",
            "One entry per cell: positions frame by frame in µm (stabilised and raw), region, lineage."),
         tr("démo : 32 675 octets (10 991 en .gz)", "demo: 32,675 bytes (10,991 as .gz)")),
        ("green", tr("2 · Le worker", "2 · The worker"), "tracks-load-worker.js",
         tr("Télécharge (le .gz d'abord), décompresse, lit le JSON, range tout dans des tableaux typés. Hors du fil principal.",
            "Downloads (the .gz first), decompresses, parses the JSON, packs everything into typed arrays. Off the main thread."),
         tr("jamais de gel de la page", "the page never freezes")),
        ("violet", tr("3 · Les tableaux", "3 · The tables"), tr("32 bits, transférés", "32-bit, transferred"),
         tr("Par image : positions + numéros de cellule. Par cellule : lignée, région, événements, durée de vie.",
            "Per frame: positions + cell numbers. Per cell: lineage, region, events, lifespan."),
         tr("démo : 8 048 octets en tout", "demo: 8,048 bytes in all")),
        ("amber", tr("4 · La couche", "4 · The layer"), "TrackingOverlay",
         tr("Une sphère par cellule (maillage instancié). Les cinq outils lisent les mêmes tableaux par ctx.tracking.",
            "One sphere per cell (instanced mesh). The five tools read the same tables through ctx.tracking."),
         tr("une seule copie des données", "a single copy of the data")),
    ]
    x, w, gap = 20, 178, 18
    for i, (c, head, sub, body, foot) in enumerate(cols):
        st, so = P[c]
        s.rect(x, 60, w, 250, "#fff", LINE, 14, 1.2)
        s.rect(x, 60, w, 34, so, so, 14)
        s.rect(x, 78, w, 16, so, so)
        s.text(x + w / 2, 83, head, 13, 800, st, "middle")
        s.text(x + w / 2, 120, sub, 12.5, 700, INK, "middle", 'font-family="JetBrains Mono, monospace"' if "." in sub else "")
        s.para(x + 12, 148, body, w - 24, 12, 400, INK)
        # pastille de bas de carte, repliée sur deux lignes si besoin
        s.rect(x + 10, 262, w - 20, 38, so, st, 12, 1.2)
        s.para(x + w / 2, 278, foot, w - 34, 11, 700, st, lh=13, anchor="middle")
        if i < 3:
            s.arrow(x + w + 2, 185, x + w + gap - 2, 185)
        x += w + gap
    s.rect(20, 326, 760, 52, P["grey"][1], LINE, 12, 1)
    s.para(36, 349, tr("Pourquoi un worker ? Pendant ce temps le viewer télécharge et décode des briques de 64³ voxels : une lecture JSON de plusieurs Mo sur le fil principal se verrait comme un saccade.",
                       "Why a worker? Meanwhile the viewer downloads and decodes 64³-voxel bricks: parsing several MB of JSON on the main thread would show as a stutter."),
           728, 12, 400, INK2)
    s.save()


def spheres():
    s = Svg("suivi-spheres.svg", 356)
    s.title(tr("Pourquoi des sphères et pas des « points »", "Why spheres and not “points”"))
    for k, (x0, head, c) in enumerate([(20, tr("Des points GPU (THREE.Points)", "GPU points (THREE.Points)"), "red"),
                                      (410, tr("Des sphères instanciées (ce que fait Lumen3D)", "Instanced spheres (what Lumen3D does)"), "green")]):
        st, so = P[c]
        s.rect(x0, 56, 370, 288, "#fff", LINE, 14, 1.2)
        s.text(x0 + 185, 82, head, 14, 800, st, "middle")
        for i, (zoom, lab) in enumerate([(1.0, tr("zoom ×1", "zoom ×1")), (2.0, tr("zoom ×2", "zoom ×2")), (4.0, tr("zoom ×4", "zoom ×4"))]):
            cx = x0 + 62 + i * 123
            cy = 170
            if c == "red":
                side = 22 if zoom < 4 else 26   # la taille plafonne
                if zoom == 4:
                    side = 26
                s.rect(cx - side / 2, cy - side / 2, side, side, "#ffc9c9", st, 0, 1.6)
                s.text(cx, cy + 50, tr("carré, ≈ même taille", "square, about the same size"), 11, 600, st, "middle")
            else:
                r = 8 * zoom
                s.circle(cx, cy, r, "#b2f2bb", st, 1.6)
                s.text(cx, cy + 50, tr("rond, grandit", "round, grows"), 11, 600, st, "middle")
            s.text(cx, 112, lab, 12, 700, INK2, "middle")
        if c == "red":
            s.para(x0 + 18, 258, tr("La taille est un nombre de pixels d'écran, plafonnée par le pilote (63 px sur certains processeurs graphiques Intel) : zoomer ne fait plus grossir le point, et il est dessiné carré.",
                                    "The size is a number of screen pixels, capped by the driver (63 px on some Intel graphics parts): zooming no longer grows the point, and it is drawn square."),
                   334, 12, 400, INK)
        else:
            s.para(x0 + 18, 258, tr("Le diamètre est un nombre de micromètres (réglable de 2 à 40). Chaque sphère compense l'étirement du cube, y compris l'étirement Z de l'opérateur : elle reste ronde et exacte à tout zoom.",
                                    "The diameter is a number of micrometres (adjustable from 2 to 40). Each sphere compensates the cube's stretch, including the operator's Z stretch: it stays round and true at every zoom."),
                   334, 12, 400, INK)
    s.save()


def _rot(deg):
    a = math.radians(deg)
    return math.cos(a), math.sin(a)


def trois_images():
    """Trois images de la série, vues « brutes » puis « stabilisées » (vraies rotations du jeu de démonstration)."""
    s = Svg("stabilisation-3-images.svg", 568)
    s.title(tr("On ne déplace pas l'embryon : on déplace le regard", "We do not move the embryo: we move the gaze"))
    frames = [  # (étiquette, rotation °, translation µm) : valeurs réelles du jeu de démonstration (images 1, 3, 4)
        (tr("image 1", "frame 1"), 0.0, (0.0, 0.0)),
        (tr("image 3", "frame 3"), 4.6593, (-11.09, 10.60)),
        (tr("image 4", "frame 4"), 7.0317, (-16.14, 16.39)),
    ]
    px = 0.95  # px de dessin par µm
    box = 192 * px

    def stab_of_raw(u, v, deg, t):      # p = M · q   (M = rotation de −θ puis translation)
        c, sn = _rot(deg)
        return c * u + sn * v + t[0], -sn * u + c * v + t[1]

    def raw_of_stab(X, Y, deg, t):      # q = M⁻¹ · p
        c, sn = _rot(deg)
        a, b = X - t[0], Y - t[1]
        return c * a - sn * b, sn * a + c * b

    ell = [(96 + 62 * math.cos(math.radians(a)), 96 + 36 * math.sin(math.radians(a))) for a in range(0, 360, 12)]
    marker = (136.0, 88.0)
    rowy = [76, 310]
    heads = [tr("Ce que le microscope a enregistré : la fenêtre est fixe, l'embryon dérive", "What the microscope recorded: the window is fixed, the embryo drifts"),
             tr("Ce que Lumen3D montre : l'embryon est immobile, la fenêtre bouge", "What Lumen3D shows: the embryo stands still, the window moves")]
    for r in range(2):
        s.text(20, rowy[r] - 12, heads[r], 13.5, 800, P["blue"][0] if r == 0 else P["green"][0])
    for i, (lab, deg, t) in enumerate(frames):
        x0 = 30 + i * 255
        for r in range(2):
            y0 = rowy[r]
            s.rect(x0, y0, box, box, "#fff", LINE, 6, 1)
            if r == 0:
                body = [(x0 + a * px, y0 + b * px) for a, b in (raw_of_stab(X, Y, deg, t) for X, Y in ell)]
                mk = raw_of_stab(marker[0], marker[1], deg, t)
                mk = (x0 + mk[0] * px, y0 + mk[1] * px)
                s.rect(x0, y0, box, box, "none", P["blue"][0], 6, 2.4)
            else:
                body = [(x0 + X * px, y0 + Y * px) for X, Y in ell]
                mk = (x0 + marker[0] * px, y0 + marker[1] * px)
                s.rect(x0, y0, box, box, "none", "#adb5bd", 6, 1.4, 'stroke-dasharray="4 3"')
                corners = [stab_of_raw(u, v, deg, t) for (u, v) in [(0, 0), (192, 0), (192, 192), (0, 192)]]
                s.path("M" + " L".join(f"{x0 + a * px:.1f},{y0 + b * px:.1f}" for a, b in corners) + " Z", P["blue"][0], 2.4, "none")
            s.path("M" + " L".join(f"{a:.1f},{b:.1f}" for a, b in body) + " Z", P["green"][0], 2, "#d3f9d8")
            s.circle(mk[0], mk[1], 5, P["red"][0], "#fff", 1.2)
            dec = f"{deg:.1f}".replace(".", ",") if tr("a", "b") == "a" else f"{deg:.1f}"
            s.text(x0 + box / 2, y0 + box + 17, f"{lab} · {dec}°", 12, 700, INK2, "middle")
    s.para(400, 536, tr("Rotations et translations réelles du jeu de démonstration (images 1, 3 et 4). Carré bleu = la fenêtre d'acquisition, pointillé gris = sa place à l'image 1, point rouge = un repère sur l'embryon.",
                        "Real rotations and translations of the demo dataset (frames 1, 3 and 4). Blue square = the acquisition window, grey dashes = its place at frame 1, red dot = a landmark on the embryo."),
           740, 11.5, 400, INK2, anchor="middle", style='font-style="italic"')
    s.save()


def chaine_matrices():
    s = Svg("warp-chaine.svg", 420)
    s.title(tr("La chaîne de trois changements de repère du shader", "The shader's chain of three changes of frame"))
    boxes = [
        ("blue", tr("① Espace objet", "① Object space"), "o ∈ [−½, ½]³", tr("là où le rayon avance", "where the ray advances"), "(0 ; 0 ; 0)"),
        ("green", tr("② µm stabilisés", "② Stabilised µm"), "p = A + (o + ½)·S", tr("l'embryon immobile", "the motionless embryo"), "(96 ; 96 ; 48)"),
        ("amber", tr("③ µm bruts", "③ Raw µm"), "q = M⁻¹ · p", tr("là où le microscope a posé l'embryon", "where the microscope placed the embryo"), "(101,65 ; 92,57 ; 49,89)"),
        ("violet", tr("④ Texture", "④ Texture"), "uvw = (q − A) / S", tr("l'adresse à lire dans l'atlas", "the address to read in the atlas"), "(0,529 ; 0,482 ; 0,520)"),
    ]
    x, w, gap = 20, 170, 26
    for i, (c, head, formula, sub, ex) in enumerate(boxes):
        st, so = P[c]
        s.rect(x, 62, w, 168, "#fff", LINE, 14, 1.2)
        s.rect(x, 62, w, 34, so, so, 14)
        s.rect(x, 80, w, 16, so, so)
        s.text(x + w / 2, 85, head, 13, 800, st, "middle")
        s.text(x + w / 2, 124, formula, 13.5, 700, INK, "middle")
        s.para(x + 10, 150, sub, w - 20, 12, 400, INK2, anchor="start")
        s.rect(x + 10, 192, w - 20, 28, so, st, 14, 1.2)
        s.text(x + w / 2, 210, ex, 12, 700, st, "middle")
        if i < 3:
            s.arrow(x + w + 2, 146, x + w + gap - 2, 146)
        x += w + gap
    # étiquettes sous les flèches
    s.text(223, 252, "toUm", 12, 700, INK2, "middle")
    s.text(419, 252, "M⁻¹", 12, 700, INK2, "middle")
    s.text(615, 252, "toTex", 12, 700, INK2, "middle")
    s.rect(20, 272, 760, 130, P["grey"][1], LINE, 12, 1)
    s.text(36, 296, tr("Une seule matrice 4 × 4 par image, calculée une fois par changement d'image :", "One single 4 × 4 matrix per frame, computed once per frame change:"), 13, 800, INK)
    s.text(36, 322, "volumeWarp = toTex · M⁻¹ · toUm", 15, 700, P["violet"][0], "start", 'font-family="JetBrains Mono, monospace"')
    s.para(36, 348, tr("A = coin minimal de la boîte d'acquisition (0 ; 0 ; 0 µm), S = ses dimensions (192 ; 192 ; 96 µm). Exemple : l'image 4 du jeu de démonstration (rotation 7,03°, décalage −16,14 ; 16,39 ; −1,79 µm). Le centre de l'écran ① lit donc le voxel ④ et non le centre exact (0,5 ; 0,5 ; 0,5).",
                       "A = minimum corner of the acquisition box (0; 0; 0 µm), S = its size (192; 192; 96 µm). Example: frame 4 of the demo dataset (rotation 7.03°, shift −16.14; 16.39; −1.79 µm). The screen centre ① therefore reads voxel ④, not the exact centre (0.5; 0.5; 0.5)."),
           730, 12, 400, INK2)
    s.save()


def methode():
    s = Svg("warp-methode.svg", 300)
    s.title(tr("Deux façons de « stabiliser » des images", "Two ways to “stabilise” images"))
    left = (20, "red", tr("Rééchantillonner (non retenu)", "Resample (not used)"),
            [tr("Fabriquer, pour chaque image, une copie tournée et décalée du volume.", "Build, for each frame, a rotated and shifted copy of the volume."),
             tr("Chaque voxel est recalculé par interpolation : il est un peu flou, donc ce n'est plus la mesure.", "Every voxel is recomputed by interpolation: slightly blurred, so no longer the measurement."),
             tr("Coût : tout le volume, à chaque image.", "Cost: the whole volume, at every frame."),
             tr("Irréversible une fois les briques écrites.", "Irreversible once the bricks are written.")])
    right = (410, "green", tr("Déplacer le regard (Lumen3D)", "Move the gaze (Lumen3D)"),
             [tr("La texture n'est jamais touchée : les voxels restent ceux de la mesure.", "The texture is never touched: the voxels stay those of the measurement."),
              tr("Seul le point de lecture change : chaque rayon est envoyé à travers la matrice de l'image.", "Only the reading point changes: each ray is sent through the frame's matrix."),
              tr("Coût : une matrice 4 × 4 par image.", "Cost: one 4 × 4 matrix per frame."),
              tr("Réversible en un clic (stabilisé ⇄ brut).", "Reversible in one click (stabilised ⇄ raw).")])
    for x0, c, head, items in (left, right):
        st, so = P[c]
        s.rect(x0, 56, 370, 226, so, st, 14, 1.4)
        s.text(x0 + 185, 84, head, 15, 800, st, "middle")
        y = 116
        for it in items:
            s.circle(x0 + 24, y - 4, 4, st, st, 1)
            y = s.para(x0 + 38, y, it, 316, 12.5, 400, INK) + 28
    s.save()


def build():
    chemin()
    spheres()
    trois_images()
    chaine_matrices()
    methode()


if __name__ == "__main__":
    build()
