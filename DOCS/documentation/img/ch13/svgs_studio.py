"""Schémas §13.2 : le Studio en profondeur."""
import math

from svglib import P, INK, INK2, LINE, Svg, tr, measure, wrap


def document():
    s = Svg("studio-document.svg", 520)
    s.title(tr("Ce qu'est un « document » du Studio", "What a Studio “document” is"))
    # colonne de gauche : l'arbre du document
    s.rect(20, 56, 440, 448, "#fff", LINE, 14, 1.2)
    s.text(36, 82, tr("document (version 2)", "document (version 2)"), 14, 800, INK)
    rows = [
        ("blue", "dataset", tr("id, nom, type, chemin, dimensions", "id, name, type, path, dimensions")),
        ("blue", "timepoint · sourceSlice", tr("image, taille et qualité de la coupe", "frame, size and quality of the slice")),
        ("blue", "planeSpec", tr("le plan : mode, axe, lacet, tangage, roulis, épaisseur", "the plane: mode, axis, yaw, pitch, roll, thickness")),
        ("green", "channelState[ ]", tr("couleur, min, max, gamma, opacité de chaque canal", "colour, min, max, gamma, opacity of each channel")),
        ("green", "calibration", tr("µm par pixel (x et y), étendue, taille physique", "µm per pixel (x and y), span, physical size")),
        ("amber", "layers[ ]", tr("les annotations, du dessous vers le dessus", "the annotations, bottom to top")),
        ("amber", "guides[ ] · groups[ ]", tr("repères d'alignement · regroupements", "alignment guides · groupings")),
        ("violet", "viewport", tr("zoom, déplacement, rotation de la vue", "zoom, pan, view rotation")),
        ("teal", "layoutMaps[ ]", tr("Comparer : une cellule par panneau (rectangle, µm/px, canaux)", "Compare: one cell per panel (rectangle, µm/px, channels)")),
    ]
    y = 104
    for c, key, desc in rows:
        st, so = P[c]
        s.rect(34, y, 410, 40, so, st, 9, 1.1)
        s.text(46, y + 25, key, 12.5, 800, st, "start", 'font-family="JetBrains Mono, monospace"')
        n = len(wrap(desc, 11.5, 400, 214))
        s.para(222, y + 20 - (n - 1) * 6.5, desc, 214, 11.5, 400, INK, lh=13.5)
        y += 46
    # colonne de droite
    s.card(484, 56, 296, 176, "green", tr("Dans le fichier JSON", "In the JSON file"),
           tr("Tout ce qui précède, en texte : calques, repères, canaux, plan, calibration, cellules de Comparer. Aucun pixel. Un fichier de 5 Mo, 2 000 calques ou 10 000 points est refusé à la lecture.",
              "All of the above, as text: layers, guides, channels, plane, calibration, Compare cells. No pixel. A file over 5 MB, 2,000 layers or 10,000 points is refused on reading."))
    s.card(484, 246, 296, 258, "red", tr("Jamais dans le fichier", "Never in the file"),
           tr("Pour chaque cellule d'une figure de Comparer, trois champs d'exécution : les valeurs brutes des canaux (raw), le cadre de la page (iframe) et la coupe elle-même (sliceResult). Ils vivent en mémoire tant que le Studio est ouvert ; _portableDocument() les retire à chaque export.",
              "For each cell of a Compare figure, three runtime fields: the raw channel values (raw), the page frame (iframe) and the slice itself (sliceResult). They live in memory while the Studio is open; _portableDocument() strips them at every export."))
    s.save()


def jeton():
    s = Svg("studio-jeton.svg", 360)
    s.title(tr("Le jeton de document : un résultat tardif ne tombe jamais sur la mauvaise figure", "The document token: a late result never lands on the wrong figure"))
    # axe du temps
    s.line(50, 300, 774, 300, INK2, 1.6, arrow=True)
    s.text(770, 292, tr("temps", "time"), 12, 600, INK2, "end")
    # lanes
    s.text(24, 118, tr("Figure A", "Figure A"), 13, 800, P["blue"][0])
    s.text(24, 218, tr("Figure B", "Figure B"), 13, 800, P["green"][0])
    s.rect(100, 100, 330, 30, P["blue"][1], P["blue"][0], 8, 1.4)
    s.text(265, 120, tr("document A ouvert · jeton 1", "document A open · token 1"), 12, 700, P["blue"][0], "middle")
    s.rect(100, 140, 530, 26, "#fff", P["blue"][0], 8, 1.2, 'stroke-dasharray="5 3"')
    s.text(365, 158, tr("passe native A en cours (images partielles, barre de progression)", "native pass A running (partial pictures, progress bar)"), 11.5, 600, P["blue"][0], "middle")
    s.rect(430, 200, 330, 30, P["green"][1], P["green"][0], 8, 1.4)
    s.text(595, 220, tr("document B ouvert · jeton 2", "document B open · token 2"), 12, 700, P["green"][0], "middle")
    # fermeture / ouverture
    s.line(430, 90, 430, 296, P["red"][0], 1.6, "5 3")
    s.text(430, 82, tr("on ouvre B", "B is opened"), 12, 700, P["red"][0], "middle")
    # image tardive
    s.circle(560, 153, 7, P["amber"][0], "#fff", 1.4)
    s.arrow(560, 164, 560, 252, P["amber"][0], 2)
    s.text(566, 190, tr("une image de la passe A arrive…", "a picture from pass A arrives…"), 12, 700, P["amber"][0])
    s.rect(446, 258, 228, 32, P["red"][1], P["red"][0], 8, 1.4)
    s.text(560, 278, tr("jeton 1 ≠ 2 : ignorée", "token 1 ≠ 2: ignored"), 12.5, 800, P["red"][0], "middle")
    s.rect(24, 318, 752, 32, P["grey"][1], LINE, 10, 1)
    s.text(40, 339, tr("setLoadProgress(…, {token}) et setSliceResult(…, {token}) se taisent si le jeton n'est pas celui du document ouvert.",
                       "setLoadProgress(…, {token}) and setSliceResult(…, {token}) stay silent unless the token is the open document's."),
           12, 400, INK2)
    s.save()


def regle():
    s = Svg("studio-regle.svg", 412)
    s.title(tr("Tourner une règle sur des pixels non carrés", "Turning a ruler on non-square pixels"))
    s.text(400, 58, tr("Exemple : pixels de 1 µm × 2 µm (la hauteur d'un pixel vaut deux fois sa largeur)", "Example: pixels of 1 µm × 2 µm (a pixel is twice as tall as it is wide)"),
           12.5, 600, INK2, "middle")
    # grille de pixels 1x2
    gx, gy, cw, ch = 40, 84, 12, 24
    for i in range(10):
        for j in range(6):
            s.rect(gx + i * cw, gy + j * ch, cw, ch, "#fff", "#dee2e6", 0, 0.7)
    s.text(gx, gy + 6 * ch + 20, tr("un pixel = 1 µm × 2 µm", "one pixel = 1 µm × 2 µm"), 11.5, 700, INK2)
    # trois règles de 100 µm
    cols = [(260, tr("horizontale", "horizontal"), 100.0, 100.0, "0°"), (460, tr("à 45°", "at 45°"), 63.25, 100.0, "45°"), (640, tr("verticale", "vertical"), 50.0, 100.0, "90°")]
    s.text(450, 100, tr("La même règle de 100 µm, tournée", "The same 100 µm ruler, turned"), 13.5, 800, INK, "middle")
    px = 1.2
    base_y = 210
    # horizontale : 100 px
    s.line(250, base_y, 250 + 100 * px, base_y, P["blue"][0], 4)
    s.text(250 + 50 * px, base_y - 12, tr("100 px", "100 px"), 12, 800, P["blue"][0], "middle")
    s.text(250 + 50 * px, base_y + 22, tr("0° · 100 µm", "0° · 100 µm"), 12, 700, INK2, "middle")
    # 45° : 63.25 px
    L = 63.25 * px
    s.line(440, base_y + 40, 440 + L * math.cos(math.radians(45)), base_y + 40 - L * math.sin(math.radians(45)), P["green"][0], 4)
    s.text(470 + 46, base_y - 10, tr("63,25 px", "63.25 px"), 12, 800, P["green"][0], "start")
    s.text(470, base_y + 62, tr("45° · 100 µm", "45° · 100 µm"), 12, 700, INK2, "middle")
    # verticale : 50 px
    s.line(660, base_y + 40, 660, base_y + 40 - 50 * px, P["amber"][0], 4)
    s.text(672, base_y + 40 - 25 * px + 4, tr("50 px", "50 px"), 12, 800, P["amber"][0])
    s.text(660, base_y + 62, tr("90° · 100 µm", "90° · 100 µm"), 12, 700, INK2, "middle")
    s.rect(24, 300, 752, 96, P["grey"][1], LINE, 12, 1)
    s.text(40, 324, tr("Longueur en pixels : L' = ℓ / √( (ux·psx)² + (uy·psy)² )", "Length in pixels: L' = ℓ / √( (ux·psx)² + (uy·psy)² )"), 13.5, 800, P["violet"][0])
    s.para(40, 348, tr("ℓ = longueur en µm (conservée), (ux, uy) = direction unitaire de la règle à l'écran, (psx, psy) = taille du pixel en µm. Une rotation « rigide » en pixels garderait 100 px : à 45° elle se lirait √(70,7² + 141,4²) = 158 µm, donc fausse. Le Studio ré-écrit la longueur en pixels à chaque tour : la valeur affichée ne bouge pas.",
                       "ℓ = length in µm (kept), (ux, uy) = the ruler's unit direction on screen, (psx, psy) = pixel size in µm. A “rigid” rotation in pixels would keep 100 px: at 45° it would read √(70.7² + 141.4²) = 158 µm, which is wrong. The Studio rewrites the pixel length at every turn: the displayed value does not move."),
           724, 12, 400, INK)
    s.save()


def recolor():
    s = Svg("studio-recolor.svg", 430)
    s.title(tr("Recolorer sans refaire le rendu : des valeurs brutes aux couleurs", "Recolouring without re-rendering: from raw values to colours"))
    # boîte 1 : raw
    s.card(20, 56, 190, 176, "blue", tr("① raw : les valeurs brutes", "① raw: the raw values"),
           tr("Pour chaque pixel de la coupe, les valeurs des canaux 0 à 3 telles que la carte graphique les a lues dans l'atlas (4 octets RGBA). Une seule fois, au rendu de la coupe.",
              "For each pixel of the slice, the values of channels 0 to 3 as the graphics card read them from the atlas (4 RGBA bytes). Once, when the slice is rendered."))
    s.arrow(214, 140, 246, 140)
    s.card(250, 56, 300, 176, "violet", tr("② SliceCompositor", "② SliceCompositor"),
           tr("Applique à chaque canal allumé exactement l'arithmétique du shader de coupe, sur son propre canevas WebGL2 (ou une table de 256 valeurs si WebGL2 manque). Une passe par changement de réglage.",
              "Applies to each lit channel exactly the slice shader's arithmetic, on its own WebGL2 canvas (or a 256-entry table when WebGL2 is missing). One pass per setting change."))
    s.arrow(554, 140, 586, 140)
    s.card(590, 56, 190, 176, "green", tr("③ L'image du Studio", "③ The Studio picture"),
           tr("Les couleurs du document, pas celles du viewer. Les calques ne bougent pas : même cadre, mêmes pixels.",
              "The document's colours, not the viewer's. The layers do not move: same frame, same pixels."))
    # formule
    s.rect(20, 252, 760, 156, P["grey"][1], LINE, 12, 1)
    s.text(36, 276, tr("La formule, canal par canal (i = canaux allumés)", "The formula, channel by channel (i = lit channels)"), 13, 800, INK)
    f = ["vᵢ = clamp( (rawᵢ/255 − minᵢ) / max(maxᵢ − minᵢ ; 0,0001) ; 0 ; 1 )",
         "vᵢ = vᵢ ^ gammaᵢ",
         "rgb = clamp( Σ vᵢ · opacitéᵢ · couleurᵢ ; 0 ; 1 )"] if tr("a", "b") == "a" else [
         "vᵢ = clamp( (rawᵢ/255 − minᵢ) / max(maxᵢ − minᵢ ; 0.0001) ; 0 ; 1 )",
         "vᵢ = vᵢ ^ gammaᵢ",
         "rgb = clamp( Σ vᵢ · opacityᵢ · colourᵢ ; 0 ; 1 )"]
    y = 300
    for ln in f:
        s.text(40, y, ln, 12.5, 700, P["violet"][0], "start", 'font-family="JetBrains Mono, monospace"')
        y += 22
    s.para(40, y + 8, tr("Transparent si |rgb| < 0,005 pour une coupe simple ; opaque (noir si rien ne s'affiche) pour une tranche projetée en MIP ou en moyenne.",
                         "Transparent if |rgb| < 0.005 for a single slice; opaque (black where nothing shows) for a slab projected as MIP or average."),
           724, 12, 400, INK2)
    s.save()


def natif():
    s = Svg("studio-natif.svg", 520)
    s.title(tr("La passe « native » : de l'aperçu à la résolution maximale", "The “native” pass: from the preview to full resolution"))
    # étape 1 aperçu
    s.card(20, 56, 760, 56, "blue", tr("Aperçu (0 octet réseau) : la coupe que la carte graphique tient déjà, rendue en ≤ 2048 px → le Studio s'ouvre tout de suite.", "Preview (0 network bytes): the slice the graphics card already holds, rendered at ≤ 2048 px → the Studio opens at once."),
           "", head_size=13)
    s.arrow(400, 114, 400, 134)
    # étape 2 : plan de la passe
    s.card(20, 138, 760, 54, "violet", tr("Plan de la passe : quelles briques (et quels plans) le plan de coupe traverse-t-il ?", "Pass plan: which bricks (and planes) does the cut plane cross?"),
           "", head_size=13)
    s.arrow(210, 194, 210, 216)
    s.arrow(590, 194, 590, 216)
    # deux backends
    s.card(20, 220, 372, 168, "green", tr("Chemin « plan » (plan axial ou MIP, volume non déformé)", "“plane” path (axial plane or MIP, unwarped volume)"),
           tr("Une texture 2D à couches qui ne contient que les plans de voxels réellement échantillonnés. Pour une coupe XY, les octets viennent de planes/ (un plan = un fichier), de mips/ (maxima par couche de 64 plans) ou, à défaut, des briques.",
              "A layered 2D texture holding only the voxel planes actually sampled. For an XY cut, the bytes come from planes/ (one plane = one file), from mips/ (per-layer maxima over 64 planes) or, failing that, from the bricks."),
           body_size=12)
    s.card(408, 220, 372, 168, "amber", tr("Chemin « atlas » (coupe oblique, série stabilisée, moyenne)", "“atlas” path (oblique cut, stabilised series, average)"),
           tr("Un petit atlas 3D jetable, dimensionné dans le budget de mémoire vidéo, rempli brique par brique (plages d'octets ciblées). Trop gros : on essaie le niveau juste en dessous.",
              "A small throw-away 3D atlas, sized within the video-memory budget and filled brick by brick (targeted byte ranges). Too big: try the next level down."),
           body_size=12)
    s.arrow(210, 390, 400, 418)
    s.arrow(590, 390, 400, 418)
    s.card(20, 420, 760, 84, "teal", tr("Rendu progressif : au plus toutes les 0,5 s, dès que 2 % des briques sont arrivées (ou après 2 s), la coupe est re-rendue en valeurs brutes ; l'aperçu comble ce qui manque encore ; le Studio recolorie et redessine.",
                                         "Progressive render: at most every 0.5 s, once 2 % of the bricks have arrived (or after 2 s), the slice is re-rendered as raw values; the preview fills what is still missing; the Studio recolours and redraws."),
           "", head_size=12.5)
    s.save()


def plan_atlas():
    s = Svg("studio-plan-atlas.svg", 380)
    s.title(tr("Pourquoi le chemin « plan » : la mémoire vidéo d'une seule coupe", "Why the “plane” path: the video memory of a single cut"))
    # barres : plan vs atlas
    s.text(24, 70, tr("Coupe XY native d'un jeu de 5735 × 5735 voxels, 4 canaux (valeurs du code, barres à la même échelle)", "Native XY cut of a 5735 × 5735-voxel dataset, 4 channels (values from the code, bars to the same scale)"), 13, 700, INK2)
    s.rect(24, 92, 752, 70, "#fff", LINE, 12, 1)
    s.text(40, 118, tr("Chemin plan", "Plane path"), 13.5, 800, P["green"][0])
    s.rect(220, 104, 10, 22, P["green"][0], P["green"][0], 2)
    s.text(240, 121, tr("≈ 132 Mo : une texture de 5735 × 5735 × 4 octets", "≈ 132 MB: one 5735 × 5735 × 4-byte texture"), 12.5, 700, P["green"][0])
    s.text(40, 148, tr("lit les plans de voxels de la coupe", "reads the cut's voxel planes"), 11.5, 400, INK2)
    s.rect(24, 174, 752, 70, "#fff", LINE, 12, 1)
    s.text(40, 200, tr("Chemin atlas", "Atlas path"), 13.5, 800, P["amber"][0])
    s.rect(220, 186, 520, 22, P["amber"][0], P["amber"][0], 4)
    s.text(228, 202, tr("de 1 à 7 Gio : un emplacement de 66³ voxels par brique traversée", "from 1 to 7 GiB: a 66³-voxel slot for every brick crossed"), 12.5, 700, "#fff")
    s.text(40, 230, tr("une coupe traverse toute une couche de briques", "a cut crosses a whole layer of bricks"), 11.5, 400, INK2)
    s.rect(24, 262, 752, 100, P["grey"][1], LINE, 12, 1)
    s.para(40, 286, tr("Dans une brique de 64 plans, la coupe n'en lit qu'un : les 63 autres voxels de profondeur sont du gaspillage de mémoire et de réseau. Le chemin plan ne garde que le plan utile (ou, pour une tranche projetée, son maximum par colonne, calculé dans un worker). Si le plan est oblique, ou si la série est stabilisée, ce raccourci n'existe pas : l'atlas prend le relais.",
                       "In a 64-plane brick, the cut reads just one: the other 63 depth voxels would waste memory and network. The plane path keeps only the useful plane (or, for a projected slab, its per-column maximum, computed in a worker). If the plane is oblique, or the series is stabilised, this shortcut does not exist: the atlas takes over."),
           724, 12, 400, INK)
    s.save()


def zstack():
    s = Svg("studio-zstack.svg", 392)
    s.title(tr("De l'écran à la figure : le plan du Z-stack vient du repère de l'écran", "From the screen to the figure: the Z-stack plane comes from the screen's frame"))
    s.card(20, 56, 240, 150, "blue", tr("① Le repère de l'écran", "① The screen's frame"),
           tr("getScreenFrameInVolume() : où pointent la droite et le haut de l'écran dans le volume (proportions physiques), et vers quoi regarde la caméra.",
              "getScreenFrameInVolume(): where the screen's right and up point inside the volume (physical proportions), and what the camera looks along."),
           body_size=12)
    s.arrow(262, 130, 290, 130)
    s.card(294, 56, 240, 150, "violet", tr("② Face et roulis", "② Face and roll"),
           tr("La face +Z (lacet 0) ou −Z (lacet 180°, image miroir) la plus proche de l'écran, puis le roulis dans le plan : r = atan2(r̂y − ûx ; r̂x + ûy).",
              "The +Z face (yaw 0) or −Z face (yaw 180°, mirror image) nearest the screen, then the in-plane roll: r = atan2(r̂y − ûx; r̂x + ûy)."),
           body_size=12)
    s.arrow(536, 130, 564, 130)
    s.card(568, 56, 212, 150, "green", tr("③ Un plan oblique", "③ An oblique plane"),
           tr("mode oblique, axe z, tangage 0, lacet 0 ou 180, roulis r, position c = (début + n/2)/z.",
              "oblique mode, axis z, pitch 0, yaw 0 or 180, roll r, position c = (start + n/2)/z."),
           body_size=12)
    s.rect(20, 226, 760, 156, P["grey"][1], LINE, 12, 1)
    s.text(36, 250, tr("Exemple du jeu de démonstration : curseur sur les coupes 59 à 70 (12 coupes) sur 112", "Demo example: cursor on slices 59 to 70 (12 slices) out of 112"), 13, 800, INK)
    items = [tr("indices 58 à 69 : c = (58 + 12/2) / 112 = 0,571 : le plan est posé au milieu des 12 coupes.", "indices 58 to 69: c = (58 + 12/2) / 112 = 0.571: the plane sits in the middle of the 12 slices."),
             tr("épaisseur = 12 échantillons, un par coupe (pas de 1/112) ; MIP dès que n > 1.", "thickness = 12 samples, one per slice (step 1/112); MIP as soon as n > 1."),
             tr("sur la face −Z la position devient 1 − c = 0,429 : les deux faces lisent les mêmes coupes.", "on the −Z face the position becomes 1 − c = 0.429: both faces read the same slices."),
             tr("série stabilisée : la tranche est prise dans la boîte d'affichage, échantillonnée à travers le même « warp » que l'écran.", "stabilised series: the slab is taken in the display box, sampled through the same “warp” as the screen.")]
    y = 274
    for it in items:
        s.circle(42, y - 4, 3.5, P["blue"][0], P["blue"][0], 1)
        y = s.para(54, y, it, 708, 12, 400, INK) + 20
    s.save()


def build():
    document()
    jeton()
    regle()
    recolor()
    natif()
    plan_atlas()
    zstack()


if __name__ == "__main__":
    build()
