"""Schémas §13.4 : la page 2D en profondeur."""
from svglib import P, INK, INK2, LINE, Svg, tr, measure, wrap


def reperes():
    s = Svg("2d-reperes.svg", 372)
    s.title(tr("Trois repères, une seule relation d'échelle", "Three frames, one scale relation"))
    cards = [
        ("blue", tr("① Image", "① Image"), "(ix, iy)", tr("Les pixels de la photographie telle que stockée (1920 × 1440 sur la démo).", "The photograph's pixels as stored (1920 × 1440 on the demo).")),
        ("violet", tr("② Orientée", "② Oriented"), "(ox, oy)", tr("Après le miroir, puis la rotation autour du centre. Boîte englobante : l = L·|cos θ| + H·|sin θ|.", "After the mirror, then the rotation about the centre. Bounding box: w = W·|cos θ| + H·|sin θ|.")),
        ("green", tr("③ Canevas", "③ Canvas"), "(sx, sy)", tr("Pixels CSS de l'écran : sx = ox·scale + tx, sy = oy·scale + ty.", "CSS pixels of the screen: sx = ox·scale + tx, sy = oy·scale + ty.")),
    ]
    x = 20
    for i, (c, head, coord, body) in enumerate(cards):
        s.card(x, 56, 232, 130, c, head + "  " + coord, body, body_size=12)
        if i < 2:
            s.arrow(x + 234, 120, x + 262, 120)
        x += 264
    s.text(268, 206, tr("miroir + rotation", "mirror + rotation"), 11.5, 700, INK2, "middle")
    s.text(532, 206, tr("zoom + déplacement", "zoom + pan"), 11.5, 700, INK2, "middle")
    s.rect(20, 222, 760, 132, P["grey"][1], LINE, 12, 1)
    s.text(36, 246, tr("La seule relation de calibration", "The only calibration relation"), 13, 800, INK)
    s.text(36, 272, tr("longueur L (µm)  →  L / pixelSizeUm × scale  pixels CSS, dans les trois repères", "length L (µm)  →  L / pixelSizeUm × scale  CSS pixels, in all three frames"), 13, 700, P["violet"][0], "start", 'font-family="JetBrains Mono, monospace"')
    s.para(36, 298, tr("Une rotation est rigide : elle ne change pas l'échelle. Exemple : 2 µm par pixel, scale = 0,5 → 1 pixel de l'image = 0,5 pixel d'écran, donc 100 µm = 100 / 2 × 0,5 = 25 pixels CSS. La barre d'échelle, la grille, les mesures et la vue divisée s'appuient toutes sur cette seule ligne.",
                       "A rotation is rigid: it does not change the scale. Example: 2 µm per pixel, scale = 0.5 → 1 image pixel = 0.5 screen pixel, so 100 µm = 100/2 × 0.5 = 25 CSS pixels. The scale bar, the grid, the measurements and the split view all rest on this one line."),
           728, 12, 400, INK)
    s.save()


def chargement():
    s = Svg("2d-chargement.svg", 340)
    s.title(tr("Le chargement en deux temps", "Two-step loading"))
    s.line(40, 250, 770, 250, INK2, 1.6, arrow=True)
    s.text(770, 270, tr("temps", "time"), 12, 600, INK2, "end")
    # deux requêtes parallèles
    s.text(24, 92, "preview.webp", 12.5, 800, P["green"][0], "start", 'font-family="JetBrains Mono, monospace"')
    s.rect(180, 78, 80, 22, P["green"][1], P["green"][0], 6, 1.4)
    s.text(220, 93, tr("640 px", "640 px"), 11.5, 700, P["green"][0], "middle")
    s.text(24, 142, "image.webp", 12.5, 800, P["blue"][0], "start", 'font-family="JetBrains Mono, monospace"')
    s.rect(180, 128, 440, 22, P["blue"][1], P["blue"][0], 6, 1.4)
    s.text(400, 143, tr("natif (ici 1920 × 1440, plusieurs Mo en vrai)", "native (here 1920 × 1440, several MB for real)"), 11.5, 700, P["blue"][0], "middle")
    s.text(24, 192, "canvas", 12.5, 800, INK, "start", 'font-family="JetBrains Mono, monospace"')
    s.rect(180, 178, 80, 22, "#d3f9d8", P["green"][0], 6, 1)
    s.rect(260, 178, 360, 22, "#ffe8cc", P["amber"][0], 6, 1)
    s.rect(620, 178, 150, 22, "#d0ebff", P["blue"][0], 6, 1)
    s.text(220, 193, tr("vide", "empty"), 11, 700, P["green"][0], "middle")
    s.text(440, 193, tr("aperçu étiré (flou mais immédiat)", "stretched preview (blurry but immediate)"), 11.5, 700, P["amber"][0], "middle")
    s.text(695, 193, tr("image native", "native image"), 11.5, 700, P["blue"][0], "middle")
    s.line(260, 70, 260, 244, P["green"][0], 1.4, "4 3")
    s.line(620, 70, 620, 244, P["blue"][0], 1.4, "4 3")
    s.text(260, 262, tr("l'aperçu se décode", "preview decoded"), 11.5, 700, P["green"][0], "middle")
    s.text(620, 262, tr("le natif se décode", "native decoded"), 11.5, 700, P["blue"][0], "middle")
    s.rect(24, 282, 752, 40, P["grey"][1], LINE, 10, 1)
    s.para(40, 304, tr("Règle : une image plus petite ne remplace jamais une plus grande déjà affichée. Au parcours ←/→, le natif attend 150 ms que la touche se calme.", "Rule: a smaller image never replaces a larger one already on screen. When stepping with ←/→, the native waits 150 ms for the key to settle."), 720, 11.5, 400, INK2)
    s.save()


def planche():
    s = Svg("2d-planche.svg", 372)
    s.title(tr("La planche de figure : même échelle physique ou même taille", "The figure board: same physical scale or same size"))
    s.text(400, 58, tr("Exemple : photo A 1920 × 1440 px à 2,0 µm/px · photo B 1600 × 1200 px à 3,2 µm/px", "Example: photo A 1920 × 1440 px at 2.0 µm/px · photo B 1600 × 1200 px at 3.2 µm/px"), 12.5, 600, INK2, "middle")
    for k, (x0, head, c, wa, ha, wb, hb, note) in enumerate([
        (20, tr("Même échelle physique", "Same physical scale"), "green", 1200, 900, 1600, 1200,
         tr("Chaque photo est ramenée au pixel le plus grossier (3,2 µm). A × 0,625 → 1200 × 900 ; B reste 1:1. Une seule barre vaut pour les deux. Jamais d'agrandissement.", "Each photo is brought to the coarsest pixel (3.2 µm). A × 0.625 → 1200 × 900; B stays 1:1. One bar is true for both. Never enlarged.")),
        (410, tr("Même taille d'image", "Same image size"), "blue", 1600, 1200, 1600, 1200,
         tr("Chaque photo remplit la même cellule (1600 × 1200). A × 0,833, B × 1. Chaque panneau porte sa propre barre d'échelle.", "Each photo fills the same cell (1600 × 1200). A × 0.833, B × 1. Each panel carries its own scale bar."))]):
        st, so = P[c]
        s.rect(x0, 76, 370, 280, "#fff", st, 14, 1.4)
        s.text(x0 + 185, 100, head, 14, 800, st, "middle")
        cw, chh = 160, 120
        for j, (lab, w, h) in enumerate([("A", wa, ha), ("B", wb, hb)]):
            cx = x0 + 20 + j * 175
            s.rect(cx, 116, cw, chh, "#f8f9fa", LINE, 4, 1, 'stroke-dasharray="3 3"')
            ww, hh = cw * w / 1600, chh * h / 1200
            s.rect(cx + (cw - ww) / 2, 116 + (chh - hh) / 2, ww, hh, so, st, 3, 1.6)
            s.text(cx + cw / 2, 116 + chh / 2 + 5, f"{lab} · {w} × {h}", 12, 800, st, "middle")
        s.para(x0 + 16, 276, note, 338, 12, 400, INK)
    s.text(215, 340, tr("barre commune sous la planche", "common bar under the board"), 11.5, 700, P["green"][0], "middle")
    s.text(595, 340, tr("une barre par panneau", "one bar per panel"), 11.5, 700, P["blue"][0], "middle")
    s.save()


def importeur():
    s = Svg("2d-importeur.svg", 410)
    s.title(tr("L'importeur 2D : un TIFF d'ImageJ → un jeu de données", "The 2D importer: one ImageJ TIFF → one dataset"))
    s.card(20, 56, 230, 232, "amber", tr("Le fichier d'entrée", "The input file"),
           tr("TIFF exporté d'ImageJ/Fiji depuis un .lif Leica : trois plans 8 bits (R, V, B) avec leurs tables de couleur, ou un RGB, ou un niveau de gris. Les balises lues : résolution X/Y (282, 283), description (270), bloc ImageJ (50839) avec le texte Leica.",
              "TIFF exported by ImageJ/Fiji from a Leica .lif: three 8-bit planes (R, G, B) with their colour tables, or an RGB, or greyscale. Tags read: X/Y resolution (282, 283), description (270), ImageJ block (50839) carrying the Leica text."),
           body_size=12)
    s.arrow(254, 172, 290, 172)
    s.card(294, 56, 236, 232, "violet", tr("Ce qui est calculé", "What is computed"),
           tr("Composite additif : sortie = Σ table_c[plan_c]. Taille de pixel = 1 / résolution, seulement si l'unité est le micron. Réglages Leica : zoom, objectif, exposition, gain… Stade, zoom, date et ligne lus dans le nom du fichier.",
              "Additive composite: output = Σ table_c[plane_c]. Pixel size = 1 / resolution, only if the unit is the micron. Leica settings: zoom, objective, exposure, gain… Stage, zoom, date and line read from the file name."),
           body_size=12)
    s.arrow(534, 172, 568, 172)
    s.card(572, 56, 208, 232, "green", tr("DATA_WEB/2d/<jeu>/", "DATA_WEB/2d/<dataset>/"),
           "", body_size=12)
    items = ["image.webp  " + tr("(natif, q 90)", "(native, q 90)"), "preview.webp  (640 px)", "thumbnail.webp  (512²)", "metadata.json", "download/  " + tr("(option)", "(option)")]
    y = 112
    for it in items:
        s.text(586, y, it, 12, 700, INK, "start", 'font-family="JetBrains Mono, monospace"' if False else "")
        y += 30
    s.rect(20, 306, 760, 88, P["grey"][1], LINE, 12, 1)
    s.para(36, 330, tr("Exemple : « DLL4xCD1 - E9.5 x3.2 240913 1.tif » → dossier DLL4xCD1-E95-x3.2-240913-1, stade E9.5, ligne DLL4xCD1, zoom ×3,2, dissection le 2024-09-13, index 1. Rien n'est deviné : ce que le fichier ne dit pas (coloration, ligne) vient de la ligne de commande, et --force garde ce que le laboratoire a corrigé à la main.",
                       "Example: “DLL4xCD1 - E9.5 x3.2 240913 1.tif” → folder DLL4xCD1-E95-x3.2-240913-1, stage E9.5, line DLL4xCD1, zoom ×3.2, dissected 2024-09-13, index 1. Nothing is guessed: what the file does not say (staining, line) comes from the command line, and --force keeps what the lab corrected by hand."),
           728, 12, 400, INK)
    s.save()


def vue_physique():
    s = Svg("2d-vue-physique.svg", 330)
    s.title(tr("La vue divisée échange une vue physique, pas des pixels", "The split view exchanges a physical view, not pixels"))
    s.card(20, 56, 340, 140, "blue", tr("Côté gauche : photo A (2 µm/px)", "Left side: photo A (2 µm/px)"),
           tr("scale = 0,5 pixel d'écran par pixel d'image → umPerCss = 2 / 0,5 = 4 µm par pixel d'écran. centerUm = décalage, en µm, du centre de l'écran par rapport au centre de la photo.",
              "scale = 0.5 screen pixel per image pixel → umPerCss = 2 / 0.5 = 4 µm per screen pixel. centerUm = offset, in µm, of the screen centre from the photo's centre."), body_size=12)
    s.arrow(364, 126, 436, 126, INK2, 2.4, both=True)
    s.text(400, 116, "WM_SET_PHYSICAL_VIEW", 10.5, 800, INK2, "middle")
    s.card(440, 56, 340, 140, "green", tr("Côté droit : photo B (3,2 µm/px)", "Right side: photo B (3.2 µm/px)"),
           tr("Reçoit umPerCss = 4 → scale = 3,2 / 4 = 0,8 pixel d'écran par pixel d'image, et se recentre sur le même décalage en µm : même grossissement physique.",
              "Receives umPerCss = 4 → scale = 3.2 / 4 = 0.8 screen pixel per image pixel, and recentres on the same offset in µm: same physical magnification."), body_size=12)
    s.rect(20, 216, 760, 100, P["grey"][1], LINE, 12, 1)
    s.para(36, 240, tr("Anti-écho : la page qui reçoit une vue ne la renvoie pas (reason ≠ 'user'), et le plugin ignore ce qui revient pendant qu'il l'applique. Une photo sans calibration n'envoie ni ne reçoit de vue physique. Dans Comparer, la même règle vaut pour tous les panneaux de photographies calibrées.",
                       "Anti-echo: the page that receives a view does not send it back (reason ≠ 'user'), and the plugin ignores what comes back while it applies it. A photo without calibration neither sends nor receives a physical view. In Compare the same rule applies to every calibrated photograph panel."),
           728, 12.5, 400, INK)
    s.save()


def build():
    reperes()
    chargement()
    planche()
    importeur()
    vue_physique()


if __name__ == "__main__":
    build()
