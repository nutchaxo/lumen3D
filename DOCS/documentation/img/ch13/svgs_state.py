"""Schémas §13.5 à §13.9 : frise, état partagé, mesures/poses, galerie et jeux liés, orientation."""
import math

from svglib import P, INK, INK2, LINE, Svg, tr, measure, wrap


def bullets(s, x, y, items, w, size=12, gap=16, color="blue"):
    for it in items:
        s.circle(x, y - 4, 3.5, P[color][0], P[color][0], 1)
        y = s.para(x + 12, y, it, w, size, 400, INK) + gap
    return y


def frise():
    s = Svg("frise-boucle.svg", 470)
    s.title(tr("Un tour d'horloge de la frise temporelle", "One tick of the timeline clock"))
    steps = [
        ("blue", tr("① À chaque image d'écran", "① On every screen frame"), tr("requestAnimationFrame : la boucle tourne au rythme de l'affichage et se calme toute seule dans un onglet caché.", "requestAnimationFrame: the loop runs at the display's pace and calms itself in a hidden tab.")),
        ("amber", tr("② Le lecteur attend-il ?", "② Is the player waiting?"), tr("Tant que l'image demandée n'est pas affichée (« tenir l'horloge »), la tête ne bouge pas. Garde : 15 s au plus.", "While the requested frame is not on screen (“holding the clock”), the head does not move. Guard: 15 s at most.")),
        ("green", tr("③ Avancer", "③ Advance"), tr("dt = min(temps écoulé ; 250 ms), puis image += fps × dt / 1000. Un à-coup (chargement, onglet endormi) ne fait jamais sauter une série d'images.", "dt = min(elapsed time; 250 ms), then frame += fps × dt / 1000. A hitch (load, sleeping tab) never skips a run of frames.")),
        ("violet", tr("④ Boucler et arrondir", "④ Loop and round"), tr("Arrivé à la dernière image, retour à 0. L'image affichée = la tête arrondie ; on ne prévient le viewer que si elle a changé.", "At the last frame, back to 0. The shown frame = the rounded head; the viewer is told only if it changed.")),
        ("teal", tr("⑤ Charger", "⑤ Load"), tr("Le viewer ne garde que la dernière image demandée, retient l'horloge jusqu'à son arrivée, puis précharge les voisines.", "The viewer keeps only the last frame asked for, holds the clock until it arrives, then preloads the neighbours.")),
    ]
    y = 56
    for c, head, body in steps:
        st, so = P[c]
        s.rect(20, y, 760, 62, so, st, 12, 1.3)
        s.text(36, y + 24, head, 13, 800, st)
        s.para(250, y + 22, body, 516, 12, 400, INK)
        y += 72
    s.rect(20, 418, 760, 38, P["grey"][1], LINE, 10, 1)
    s.text(36, 442, tr("Vitesses proposées : 0,5 · 1 · 2 · 5 · 10 · 20 images/s (défaut 10), retenue dans le navigateur d'un lancement à l'autre.", "Offered speeds: 0.5 · 1 · 2 · 5 · 10 · 20 frames/s (default 10), remembered by the browser between visits."), 12, 600, INK2)
    s.save()


def lieux():
    s = Svg("etat-lieux.svg", 326)
    s.title(tr("Où vit ce que vous réglez ?", "Where does what you adjust live?"))
    cards = [
        ("blue", tr("La mémoire de la page", "The page's memory"),
         tr("Mesures, historique du Studio, atlas de la carte graphique, tampons de briques. Disparaît quand l'onglet se ferme.", "Measurements, Studio history, graphics-card atlas, brick buffers. Gone when the tab closes.")),
        ("green", tr("L'adresse (#state=)", "The address (#state=)"),
         tr("Caméra, canaux, outil, plan de coupe, mesures, image de la série. Se copie, s'envoie, se met en favori.", "Camera, channels, tool, cut plane, measurements, frame. Can be copied, sent, bookmarked.")),
        ("amber", tr("Le navigateur (localStorage)", "The browser (localStorage)"),
         tr("Vos préférences : thème, langue, daltonisme, vitesse de la frise, étirement Z… et les espaces de travail de Comparer.", "Your preferences: theme, language, colour-blind filter, timeline speed, Z stretch… and Compare workspaces.")),
        ("grey", tr("Le serveur", "The server"),
         tr("Rien de ce que vous réglez. Seulement des compteurs anonymes (une vue par jeu et par session).", "Nothing you adjust. Only anonymous counters (one view per dataset per session).")),
    ]
    x = 20
    for c, head, body in cards:
        s.card(x, 56, 182, 168, c, head, body, body_size=12)
        x += 192
    s.rect(20, 242, 760, 64, P["grey"][1], LINE, 12, 1)
    s.para(36, 266, tr("Le viewer n'a pas de bouton « Sauvegarder » : l'adresse sert de sauvegarde. Navigation privée ou stockage bloqué : tout est protégé par des try/catch ; la page marche, elle oublie simplement vos préférences.",
                       "The viewer has no “Save” button: the address is the save. Private browsing or blocked storage: everything is wrapped in try/catch; the page works, it simply forgets your preferences."),
           728, 12.5, 400, INK)
    s.save()


def hash_():
    s = Svg("etat-hash.svg", 400)
    s.title(tr("De l'état de la page au #state= de l'adresse", "From the page state to the address's #state="))
    steps = [
        ("blue", tr("État", "State"), tr("ui · viewer · plugins", "ui · viewer · plugins"), tr("2 580 caractères en JSON (E95 de démonstration)", "2,580 characters as JSON (demo E95)")),
        ("green", tr("Compression", "Compression"), "deflate-raw", tr("CompressionStream du navigateur", "the browser's CompressionStream")),
        ("amber", tr("Texte", "Text"), "base64url", tr("sans + / = : sûr dans une adresse", "no + / = : safe in an address")),
        ("violet", tr("Adresse", "Address"), "#state=…", tr("1 362 caractères ici", "1,362 characters here")),
    ]
    x = 20
    for i, (c, head, mid, foot) in enumerate(steps):
        st, so = P[c]
        s.rect(x, 62, 172, 130, "#fff", LINE, 14, 1.2)
        s.rect(x, 62, 172, 32, so, so, 14)
        s.rect(x, 78, 172, 16, so, so)
        s.text(x + 86, 84, head, 13, 800, st, "middle")
        s.text(x + 86, 120, mid, 12.5, 700, INK, "middle", 'font-family="JetBrains Mono, monospace"' if i else "")
        s.para(x + 86, 146, foot, 150, 11.5, 400, INK2, anchor="middle")
        if i < 3:
            s.arrow(x + 174, 128, x + 190, 128)
        x += 192
    s.card(20, 214, 244, 170, "teal", tr("Écrit seulement si utile", "Written only when useful"),
           tr("Toutes les secondes, on compare une empreinte de l'état. Rien n'a changé : rien n'est écrit. Retour exact à l'état d'ouverture : l'adresse est nettoyée. Les compteurs qui bougent seuls (cache de briques) sont ignorés.", "Every second, a fingerprint of the state is compared. Nothing changed: nothing is written. Back to the exact opening state: the address is cleaned. Counters that move on their own (brick cache) are ignored."), body_size=11.5)
    s.card(278, 214, 244, 170, "amber", tr("Trois plafonds", "Three ceilings"),
           tr("Écrit : 64 Kio de texte au plus (au-delà, l'adresse n'est plus mise à jour). Lu : 2 Mio de texte. Gonflé : 16 Mio, pour qu'un lien piégé ne puisse pas « exploser » en mémoire.", "Written: at most 64 KiB of text (beyond, the address is no longer updated). Read: 2 MiB of text. Inflated: 16 MiB, so a booby-trapped link cannot “explode” in memory."), body_size=11.5)
    s.card(536, 214, 244, 170, "violet", tr("À l'ouverture d'un lien", "Opening a link"),
           tr("Le viewer demande : « Ouvrir la vue enregistrée » ou « Ouvrir le jeu de données à neuf ». Échap = ouvrir la vue (ce que faisait un lien avant la question). Un lien illisible est simplement oublié.", "The viewer asks: “Open the saved view” or “Open the dataset as new”. Escape = open the view (what a link did before the question). An unreadable link is simply forgotten."), body_size=11.5)
    s.save()


def pick():
    s = Svg("pick-encodage.svg", 384)
    s.title(tr("Lire la profondeur sous le curseur : deux passes d'un pixel", "Reading the depth under the cursor: two one-pixel passes"))
    s.card(20, 56, 370, 116, "blue", tr("Passe 0 : x et y", "Pass 0: x and y"),
           tr("Le shader rend UN pixel (la fenêtre de la caméra recentrée sur votre clic) et écrit dans ses 4 octets RGBA : x en 16 bits (octet haut, octet bas), y en 16 bits.", "The shader renders ONE pixel (the camera window recentred on your click) and writes into its 4 RGBA bytes: x on 16 bits (high byte, low byte), y on 16 bits."), body_size=12)
    s.card(410, 56, 370, 116, "green", tr("Passe 1 : z et le drapeau", "Pass 1: z and the flag"),
           tr("Même rayon : z en 16 bits dans R et G, 255 dans B et A. Un alpha à 0 signifie « rien trouvé » : le clic est refusé (aucune structure sous le curseur).", "Same ray: z on 16 bits in R and G, 255 in B and A. An alpha of 0 means “nothing found”: the click is refused (no structure under the cursor)."), body_size=12)
    s.rect(20, 190, 760, 176, P["grey"][1], LINE, 12, 1)
    s.text(36, 214, tr("Pourquoi deux octets : un octet seul ne donne que 256 positions", "Why two bytes: a single byte gives only 256 positions"), 13, 800, INK)
    s.para(36, 238, tr("Une position q ∈ [0 ; 1] devient l'entier N = arrondi(q × 65 535), écrit en octet haut = ⌊N / 256⌋ et octet bas = N − 256 × octet haut. Exemple : q = 0,7 → N = 45 875 = 179 × 256 + 51. La précision est donc de 1/65 535 de la boîte, soit 0,01 µm sur une boîte de 600 µm.",
                       "A position q ∈ [0; 1] becomes the integer N = round(q × 65,535), written as high byte = ⌊N / 256⌋ and low byte = N − 256 × high byte. Example: q = 0.7 → N = 45,875 = 179 × 256 + 51. The precision is therefore 1/65,535 of the box, i.e. 0.01 µm on a 600 µm box."), 724, 12, 400, INK)
    s.para(36, 300, tr("Le long du rayon : un échantillon tous les ½ voxel, 4 096 pas au plus. Étape 1 : le maximum m des valeurs affichées. Étape 2 : le premier point où la valeur atteint max(0,02 ; 0,55 × m), interpolé entre les deux échantillons voisins. Même fenêtre, canaux, rognage, tranche du Z-stack et stabilisation que l'écran.",
                       "Along the ray: one sample every ½ voxel, at most 4,096 steps. Step 1: the maximum m of the displayed values. Step 2: the first point where the value reaches max(0.02; 0.55 × m), interpolated between the two neighbouring samples. Same window, channels, clipping, Z-stack slab and stabilisation as the screen."), 724, 12, 400, INK2)
    s.save()


def pick_ordre():
    s = Svg("pick-ordre.svg", 206)
    s.title(tr("Les trois sources d'un point, dans l'ordre", "The three sources of a point, in order"))
    items = [("amber", tr("1 · Un mur de projection", "1 · A projection wall"), tr("Si la grille est allumée et que le rayon touche un de ses murs : source « projection ». Le point est posé sur le mur, pas sur l'échantillon.", "If the grid is on and the ray hits one of its walls: source “projection”. The point lands on the wall, not on the specimen.")),
             ("green", tr("2 · Le volume (lecture GPU)", "2 · The volume (GPU read)"), tr("Le cas normal : source « volume », la profondeur de la première structure visible.", "The normal case: source “volume”, the depth of the first visible structure.")),
             ("red", tr("3 · La boîte (repli)", "3 · The box (fallback)"), tr("Rien de visible, ou pas de lecture GPU possible : source « bounding-box », où le rayon entre dans la boîte. L'outil de mesure refuse ce point.", "Nothing visible, or no GPU read possible: source “bounding-box”, where the ray enters the box. The measure tool refuses this point."))]
    x = 20
    for c, head, body in items:
        s.card(x, 56, 242, 132, c, head, body, body_size=12)
        x += 259
    s.save()


def poses():
    s = Svg("poses-tilt.svg", 372)
    s.title(tr("Coucher le volume : deux rotations autour des axes de l'écran", "Laying the volume flat: two rotations about the screen's axes"))
    s.card(20, 56, 250, 128, "blue", tr("① Où regarde la pile ?", "① Where does the stack look?"),
           tr("d = la direction du fichier que la vue « de dessus » doit regarder, telle que le volume la tient maintenant : ici d = (0,20 ; 0,60 ; 0,775).", "d = the file direction the “top” view must look along, as the volume holds it now: here d = (0.20; 0.60; 0.775)."), body_size=12)
    s.arrow(274, 120, 300, 120)
    s.card(304, 56, 250, 128, "amber", tr("② Quel axe tourne d'abord ?", "② Which axis turns first?"),
           tr("Celui sur lequel d penche le plus : asin|dy| = 36,9° > asin|dx| = 11,5° + 5° → d'abord l'axe horizontal X, avec une avance de 5° au vertical en cas d'égalité.", "The one d leans on most: asin|dy| = 36.9° > asin|dx| = 11.5° + 5° → the horizontal X axis first, with a 5° lead to the vertical on a tie."), body_size=12)
    s.arrow(558, 120, 584, 120)
    s.card(588, 56, 192, 128, "green", tr("③ Les deux angles", "③ The two angles"),
           tr("α = atan2(dy ; dz) = 37,8° autour de X ; puis β = atan2(−dx ; √(dy²+dz²)) = −11,5° autour de Y.", "α = atan2(dy; dz) = 37.8° about X; then β = atan2(−dx; √(dy²+dz²)) = −11.5° about Y."), body_size=12)
    s.rect(20, 204, 760, 150, P["grey"][1], LINE, 12, 1)
    y = 230
    s.text(36, y, tr("Pourquoi pas la rotation « la plus courte » ?", "Why not the “shortest” rotation?"), 13, 800, INK)
    bullets(s, 42, y + 26, [
        tr("La plus courte tourne autour d'un axe oblique : à l'écran, la pile « culbute » en diagonale. Deux rotations autour des axes de l'écran se lisent comme un seul geste, avec une petite correction.", "The shortest turns about an oblique axis: on screen, the stack “tumbles” diagonally. Two rotations about the screen's axes read as one gesture with a slight correction."),
        tr("Aucune rotation dans le plan n'est ajoutée : le Z-stack reprend l'angle où la pose a atterri (curseur Rotation).", "No in-plane turn is added: the Z-stack takes the angle where the pose landed (Rotation slider)."),
        tr("Une pile qui regarde déjà droit devant (dx et dy ≈ 0) se retourne d'un demi-tour autour de la verticale, jamais selon un bruit numérique. Animation : 1,5 s à l'ouverture, 1,2 s depuis la piste, 1 s depuis le sens de l'échantillon.", "A stack already looking straight ahead (dx and dy ≈ 0) turns over by a half-turn about the vertical, never by numerical noise. Animation: 1.5 s on opening, 1.2 s from the track, 1 s from the sample-side switch."),
    ], 712, 12, 12)
    s.save()


def galerie():
    s = Svg("galerie-chemin.svg", 358)
    s.title(tr("Le trajet d'une image de galerie", "The path of a gallery image"))
    cards = [
        ("blue", tr("1 · Envoi", "1 · Upload"), tr("L'administrateur glisse une image (capture annotée, figure). Le corps part brut, sans conversion.", "The administrator drops an image (annotated capture, figure). The body travels raw, without conversion.")),
        ("red", tr("2 · Contrôles", "2 · Checks"), tr("Le type vient des octets magiques (WebP, PNG, JPEG, GIF), jamais du nom. Au plus 8 Mio, 40 images par jeu.", "The type comes from the magic bytes (WebP, PNG, JPEG, GIF), never from the name. At most 8 MiB, 40 images per dataset.")),
        ("green", tr("3 · Stockage", "3 · Storage"), tr("gallery/<nom>.ext, nom nettoyé. Une vignette de 320 px (WebP, sinon JPEG) dans gallery/thumbs/. Ordre et légendes dans metadata.json.", "gallery/<name>.ext, name sanitised. A 320 px thumbnail (WebP, else JPEG) in gallery/thumbs/. Order and captions in metadata.json.")),
        ("violet", tr("4 · Affichage", "4 · Display"), tr("Un dock dans le coin du canevas (3D et 2D) : grille de vignettes, puis visionneuse plein écran. Trois états : ouvert, large, puce.", "A dock in the canvas corner (3D and 2D): thumbnail grid, then full-screen lightbox. Three states: open, large, chip.")),
    ]
    x = 20
    for i, (c, head, body) in enumerate(cards):
        s.card(x, 56, 178, 176, c, head, body, body_size=12)
        if i < 3:
            s.arrow(x + 180, 140, x + 192, 140)
        x += 194
    s.rect(20, 252, 760, 88, P["grey"][1], LINE, 12, 1)
    s.para(36, 276, tr("metadata.json garde « gallery: [{ file, thumb, title, caption, added }] » : le catalogue la transporte sans rien de plus. À chaque enregistrement, la liste est réconciliée avec le dossier dans les deux sens (un fichier orphelin est ajouté, une entrée sans fichier est retirée). Le dock se souvient de son état (clé iribhm-gallery-dock).",
                       "metadata.json keeps “gallery: [{ file, thumb, title, caption, added }]”: the catalogue carries it for free. On every save, the list is reconciled with the folder in both directions (an orphan file is added, an entry without file is removed). The dock remembers its state (key iribhm-gallery-dock)."),
           728, 12, 400, INK)
    s.save()


def relations():
    s = Svg("relations.svg", 380)
    s.title(tr("Jeux « liés » : quatre règles, quatre natures", "“Linked” datasets: four rules, four kinds"))
    rows = [
        ("violet", tr("registered · recalé", "registered"), tr("L'un des deux porte un bloc registration (transformations de recalage).", "One of the two carries a registration block (registration transforms).")),
        ("blue", tr("related · lié explicitement", "related"), tr("relatedIds de l'un cite l'autre (dans un sens ou dans l'autre).", "one's relatedIds names the other (in either direction).")),
        ("green", tr("same-embryo · même embryon", "same-embryo"), tr("Même numéro d'embryon et même stade.", "Same embryo number and same stage.")),
        ("amber", tr("context · contexte", "context"), tr("Même date de dissection et même stade (autre embryon possible).", "Same dissection date and same stage (possibly another embryo).")),
    ]
    y = 60
    for c, head, body in rows:
        st, so = P[c]
        s.rect(20, y, 520, 56, so, st, 12, 1.3)
        s.text(36, y + 24, head, 13, 800, st)
        s.para(36, y + 42, body, 490, 12, 400, INK)
        y += 66
    s.card(560, 60, 220, 254, "grey", tr("À quoi ça sert", "What it is for"),
           tr("L'explorateur affiche le badge « Lié » ; la page 2D et le viewer listent les jeux liés d'un autre type (une photographie vers son volume). L'ordre ci-contre est celui qu'on teste : le premier qui s'applique donne la nature affichée.", "The explorer shows the “Linked” badge; the 2D page and the viewer list linked datasets of another type (a photograph to its volume). The order shown is the order tested: the first that applies gives the kind displayed."), body_size=12)
    s.save()


def vignette():
    s = Svg("vignette-chemin.svg", 204)
    s.title(tr("« Redéfinir la preview » : de l'aperçu à la vignette de l'explorateur", "“Reset preview”: from the preview to the explorer thumbnail"))
    cards = [("blue", tr("① L'aperçu du viewer", "① The viewer preview"), tr("Vous orientez le volume. Si une coupe ou le Z-stack est ouvert, c'est elle (1024 px) qui est photographiée.", "You orient the volume. If a slice or the Z-stack is open, that slice (1024 px) is what is photographed.")),
             ("amber", tr("② 512 × 512", "② 512 × 512"), tr("L'image est posée au centre d'un carré de 512 px, fond #080a12, sans déformation, puis encodée en WebP (qualité 0,9).", "The image is centred in a 512 px square, background #080a12, undistorted, then encoded as WebP (quality 0.9).")),
             ("green", tr("③ thumbnail.webp", "③ thumbnail.webp"), tr("Le serveur vérifie les octets magiques (≤ 5 Mio) et écrit thumbnail.webp. La grille de l'explorateur l'affiche.", "The server checks the magic bytes (≤ 5 MiB) and writes thumbnail.webp. The explorer grid shows it."))]
    x = 20
    for i, (c, head, body) in enumerate(cards):
        s.card(x, 56, 236, 126, c, head, body, body_size=12)
        if i < 2:
            s.arrow(x + 238, 118, x + 254, 118)
        x += 256
    s.save()


def orientation():
    s = Svg("orientation-reperes.svg", 340)
    s.title(tr("Trois poses, deux produits de quaternions", "Three poses, two quaternion products"))
    s.card(20, 56, 236, 120, "blue", tr("Q_base · le repère", "Q_base · the frame"),
           tr("metadata.orientation : la pose du cube pour laquelle les axes de l'anatomie coïncident avec ceux de l'écran (R→+X, A→+Y, V→+Z).", "metadata.orientation: the cube pose for which the anatomy's axes coincide with the screen's (R→+X, A→+Y, V→+Z)."), body_size=12)
    s.card(282, 56, 236, 120, "green", tr("Q_anat · l'anatomie", "Q_anat · the anatomy"),
           tr("La pose de l'anatomie à l'écran : Q_anat = Q_cube · Q_base⁻¹. C'est ce qui oriente la boussole, et ce que stocke une vue par défaut.", "The anatomy's pose on screen: Q_anat = Q_cube · Q_base⁻¹. It orients the compass and is what a default view stores."), body_size=12)
    s.card(544, 56, 236, 120, "amber", tr("Q_cube · le volume", "Q_cube · the volume"),
           tr("La pose réelle du cube : Q_cube = Q_anat · Q_base. Une vue par défaut est appliquée avant la première brique.", "The cube's actual pose: Q_cube = Q_anat · Q_base. A default view is applied before the first brick."), body_size=12)
    s.rect(20, 196, 760, 128, P["grey"][1], LINE, 12, 1)
    s.text(36, 220, tr("Six préréglages = deux contraintes anatomiques", "Six presets = two anatomical constraints"), 13, 800, INK)
    rows = [(tr("ventral", "ventral"), "V → " + tr("caméra", "camera") + ", A → " + tr("haut", "up")), (tr("dorsal", "dorsal"), "D → " + tr("caméra", "camera") + ", A → " + tr("haut", "up")),
            (tr("gauche · droite", "left · right"), "L / R → " + tr("caméra", "camera") + ", A → " + tr("haut", "up")), (tr("antérieur · postérieur", "anterior · posterior"), "A / P → " + tr("caméra", "camera") + ", D → " + tr("haut", "up"))]
    y = 246
    for a, b in rows:
        s.text(52, y, a, 12.5, 800, P["green"][0])
        s.text(250, y, b, 12.5, 600, INK)
        y += 22
    s.para(420, 246, tr("Les deux contraintes (quelle direction regarde la caméra, laquelle pointe vers le haut) fixent une rotation unique. Les arêtes R/L, A/P, V/D sont des identifiants de stockage : vous les nommez comme vous voulez (« antérieur », « dorsal »).",
                        "The two constraints (which direction faces the camera, which points up) pin down a single rotation. The R/L, A/P, V/D keys are storage identifiers: you name them as you wish (“anterior”, “dorsal”)."), 344, 12, 400, INK2)
    s.save()


def build():
    frise()
    lieux()
    hash_()
    pick()
    pick_ordre()
    poses()
    galerie()
    relations()
    vignette()
    orientation()


if __name__ == "__main__":
    build()
