"""Figures de la partie « les fichiers » (arbres annotés, qui écrit quoi, empreintes, catalogue)."""
from pathlib import Path
from svglib import *

ROOT = Path(__file__).resolve().parents[4]
WEB = ROOT / "DATA_WEB"


def size_of(p):
    p = Path(p)
    if p.is_dir():
        return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
    return p.stat().st_size if p.exists() else 0


OWN = {"pipe": "blue", "oper": "amber", "plat": "green"}


def legend_owners(y):
    out = []
    x = 40
    items = [("blue", tr("écrit par le pipeline", "written by the pipeline")),
             ("amber", tr("saisi / ajouté par l'opérateur", "entered / added by the operator")),
             ("green", tr("posé par la plateforme (migration, import)", "set by the platform (migration, import)"))]
    for col, lab in items:
        out.append(CIRC(x, y - 4, 6, P[col][0]))
        out.append(T(x + 12, y, lab, 11.5, 400, INK2))
        x += 14 + len(lab) * 6.2 + 22
    return out


def tree_figure(name, rows, h, ttl, sub, colx=392, comment_x=444):
    """rows : (profondeur, nom, taille, [propriétaires], commentaire, style)"""
    b = [title(ttl, sub)]
    y0 = 86
    rh = 24.5
    for i, (depth, nm, size, owners, comment, style) in enumerate(rows):
        y = y0 + i * rh
        if i % 2 == 0:
            b.append(R(24, y - 17, 752, rh, "#ffffff", "none", 4, 0, 'opacity="0.7"'))
        x = 40 + depth * 22
        if depth:
            b.append(T(x - 15, y, "└" if style == "last" else "├", 13, 400, LINE, mono=True))
        b.append(T(x, y, nm, 12.5, 700 if style == "dir" else 400, INK, mono=True, maxw=colx - x - 60))
        if size:
            b.append(T(colx, y, size, 11.5, 400, INK2, "end"))
        cx = colx + 14
        for o in owners:
            b.append(CIRC(cx, y - 4, 5.5, P[OWN[o]][0]))
            cx += 13
        if comment:
            b.append(T(comment_x, y, comment, 11.5, 400, INK2, maxw=772 - comment_x))
    b.append(legend_owners(h - 14))
    save(name, h, b)


def arbre_3d():
    d = WEB / "3d/Embryo-E95-Em2-Pecam1-Sox2"
    f = fmt_bytes
    rest = size_of(d / "bricks") - size_of(d / "bricks/l0") - size_of(d / "bricks/manifest.json") - size_of(d / "bricks/index.bin")
    rows = [
        (0, "3d/Embryo-E95-Em2-Pecam1-Sox2/", f(size_of(d)), [], tr("un dossier = un jeu de données", "one folder = one dataset"), "dir"),
        (1, "metadata.json", f(size_of(d / "metadata.json")), ["pipe", "oper"], tr("la carte d'identité (voir 17.3)", "the identity card (see 17.3)"), ""),
        (1, "thumbnail.webp", f(size_of(d / "thumbnail.webp")), ["pipe", "oper"], tr("vignette ; l'opérateur peut la redéfinir", "thumbnail; the operator may redefine it"), ""),
        (1, "bricks/", f(size_of(d / "bricks")), ["pipe", "plat"], tr("pyramide de briques v3 (format 4)", "v3 brick pyramid (format 4)"), "dir"),
        (2, "manifest.json", f(size_of(d / "bricks/manifest.json")), ["pipe", "plat"], tr("niveaux, histogrammes, empreinte de l'index", "levels, histograms, index fingerprint"), ""),
        (2, "index.bin", f(size_of(d / "bricks/index.bin")), ["pipe", "plat"], tr("paquet + début + longueur de chaque brique", "pack + start + length of each brick"), ""),
        (2, "l0/c0/p00000.bin p00001.bin …", f(size_of(d / "bricks/l0")), ["pipe", "plat"], tr("niveau 0 (natif), un dossier par canal", "level 0 (native), one folder per channel"), ""),
        (2, "l1/  l2/  l3/", f(rest), ["pipe", "plat"], tr("niveaux de plus en plus grossiers", "ever coarser levels"), "last"),
        (1, "planes/", f(size_of(d / "planes")), ["pipe", "plat"], tr("coupes XY rapides (format 2)", "fast XY cuts (format 2)"), "dir"),
        (2, "manifest.json", f(size_of(d / "planes/manifest.json")), ["pipe", "plat"], "lumen-planes-v1", ""),
        (2, "z00000.bin … z00111.bin", "112 " + tr("fichiers", "files"), ["pipe", "plat"], tr("un fichier par plan Z", "one file per Z plane"), "last"),
        (1, "mips/", f(size_of(d / "mips")), ["pipe", "plat"], tr("MIP par couche de 64 plans (format 3)", "per-64-plane-layer MIP (format 3)"), "dir"),
        (2, "manifest.json  l00000/1.bin", "", ["pipe", "plat"], "lumen-mips-v1", "last"),
        (1, "download/", f(size_of(d / "download")), ["pipe"], tr("toujours servi en pièce jointe", "always served as an attachment"), "dir"),
        (2, "….ims  ….tif  _web.zip  README", "", ["pipe"], tr("original (lien physique), composite, archive", "original (hard link), composite, archive"), ""),
        (2, tr("…_C1_DAPI_MIP.png  (un par canal)", "…_C1_DAPI_MIP.png  (one per channel)"), "", ["pipe"], tr("aperçus de projection", "projection previews"), "last"),
        (1, "gallery/", tr("(absent ici)", "(absent here)"), ["oper"], tr("images jointes : ≤ 40 images de ≤ 8 Mio", "attached images: ≤ 40 images of ≤ 8 MiB"), "dir"),
        (2, "a.png  thumbs/a.png.webp …", "", ["oper"], tr("extension d'après les octets magiques", "extension from the magic bytes"), "last"),
    ]
    tree_figure("arbre-3d.svg", rows, int(86 + len(rows) * 24.5 + 30),
                tr("L'arbre d'un jeu de données 3D (jeu de démonstration)", "The tree of a 3D dataset (demo dataset)"),
                tr("Les pastilles disent qui crée chaque élément ; les tailles sont celles du disque.",
                   "Dots say who creates each element; sizes are those on disk."))


def arbre_live():
    d = WEB / "live/Demo-Lumen3D-E85-Em1-30min-2ch-4tp"
    f = fmt_bytes
    rows = [
        (0, "live/Demo-Lumen3D-E85-Em1-30min-2ch-4tp/", f(size_of(d)), [], tr("série temporelle : 4 images, 2 canaux", "timelapse: 4 timepoints, 2 channels"), "dir"),
        (1, "metadata.json", f(size_of(d / "metadata.json")), ["pipe", "oper"], tr("+ timeline, tracking, registration…", "+ timeline, tracking, registration…"), ""),
        (1, "thumbnail.webp", f(size_of(d / "thumbnail.webp")), ["pipe", "oper"], "", ""),
        (1, "tracks.json  (+ .gz)", f(size_of(d / "tracks.json")) + " / " + f(size_of(d / "tracks.json.gz")), ["pipe"], tr("le suivi : 50 cellules (JSON + copie gzip)", "tracking: 50 cells (JSON + gzip copy)"), ""),
        (1, "model.glb", f(size_of(d / "model.glb")), ["pipe"], tr("surface 3D du suivi (glTF binaire)", "tracking 3D surface (binary glTF)"), ""),
        (1, "bricks/", f(size_of(d / "bricks")), ["pipe", "plat"], tr("un arbre de briques PAR image", "one brick tree PER timepoint"), "dir"),
        (2, "manifest.json", f(size_of(d / "bricks/manifest.json")), ["pipe", "plat"], tr("timepoints[] : un index.bin par image", "timepoints[]: one index.bin per frame"), ""),
        (2, "t000/  index.bin  l0/c0/ c1/", f(size_of(d / "bricks/t000")), ["pipe", "plat"], tr("l'image 0 (index de 108 octets)", "frame 0 (108-byte index)"), ""),
        (2, "t001/  t002/  t003/", f(size_of(d / "bricks") - size_of(d / "bricks/t000") - size_of(d / "bricks/manifest.json")), ["pipe", "plat"], tr("les autres images, même forme", "the other frames, same shape"), "last"),
        (1, "planes/", f(size_of(d / "planes")), ["pipe", "plat"], tr("un sous-dossier par image", "one sub-folder per frame"), "dir"),
        (2, "t000/  z00000.bin … z00023.bin", f(size_of(d / "planes/t000")), ["pipe", "plat"], tr("24 plans par image", "24 planes per frame"), "last"),
        (1, "mips/", f(size_of(d / "mips")), ["pipe", "plat"], "", "dir"),
        (2, "t000/  manifest.json  l00000.bin", f(size_of(d / "mips/t000")), ["pipe", "plat"], tr("une couche (24 plans < 64)", "one layer (24 planes < 64)"), "last"),
        (1, "download/", f(size_of(d / "download")), ["pipe"], tr("l'.ims contient les 4 images", "the .ims holds all 4 frames"), "last"),
    ]
    tree_figure("arbre-live.svg", rows, int(86 + len(rows) * 24.5 + 30),
                tr("L'arbre d'une série temporelle « live » (jeu de démonstration)", "The tree of a “live” timelapse (demo dataset)"),
                tr("Même idée qu'un jeu 3D, mais chaque image (tNNN) a son propre arbre ; le suivi vit à la racine.",
                   "Same idea as a 3D dataset, but every frame (tNNN) has its own tree; the tracking lives at the root."))


def arbre_2d():
    d = WEB / "2d/DLL4xCD1-E95-x3.2-240913-1"
    f = fmt_bytes
    rows = [
        (0, "2d/DLL4xCD1-E95-x3.2-240913-1/", f(size_of(d)), [], tr("une photographie de stéréomicroscope", "one stereomicroscope photograph"), "dir"),
        (1, "metadata.json", f(size_of(d / "metadata.json")), ["pipe", "oper"], tr("bloc image{}, pixelSizeUm, acquisition{}…", "image{} block, pixelSizeUm, acquisition{}…"), ""),
        (1, "image.webp", f(size_of(d / "image.webp")), ["pipe"], tr("la photo affichée (WebP avec perte, q90)", "the displayed photo (lossy WebP, q90)"), ""),
        (1, "preview.webp", f(size_of(d / "preview.webp")), ["pipe"], tr("640 px, peinte en premier", "640 px, painted first"), ""),
        (1, "thumbnail.webp", f(size_of(d / "thumbnail.webp")), ["pipe"], tr("carrée, pour l'explorateur", "square, for the explorer"), ""),
        (1, "download/", f(size_of(d / "download")), ["pipe"], tr("le TIFF d'origine (intact) et une notice", "the original TIFF (untouched) and a notice"), "dir"),
        (2, "….tif (original)  README.txt", "", ["pipe"], "", "last"),
        (1, "gallery/", tr("(absent ici)", "(absent here)"), ["oper"], tr("possible aussi pour une photo", "possible for a photo too"), "last"),
    ]
    tree_figure("arbre-2d.svg", rows, int(86 + len(rows) * 24.5 + 30),
                tr("L'arbre d'une photographie 2D (jeu de démonstration)", "The tree of a 2D photograph (demo dataset)"),
                tr("Pas de briques, pas de canaux : trois copies d'une image et une carte d'identité.",
                   "No bricks, no channels: three copies of one image and an identity card."))


def run():
    arbre_3d()
    arbre_live()
    arbre_2d()


# ── Qui écrit quoi ─────────────────────────────────────────────────────────────
def qui_ecrit():
    b = [title(tr("Trois auteurs pour un même metadata.json", "Three authors for one metadata.json"),
               tr("Chaque champ a un propriétaire ; les deux autres respectent ses choix.",
                  "Every field has an owner; the other two respect its choices."))]
    cols = [
        ("blue", tr("1. Le pipeline mesure", "1. The pipeline measures"),
         ["id, type, formatVersion", "dimensions, voxel_size", "physicalSizeUm, acquisitionExtentUm",
          "calibrationStatus / Note", "channels[] (valeurs de départ)" if LANG == "fr" else "channels[] (starting values)",
          "volumeSources[], thumbnail", "timeline, intensityNormalization", "tracking, registration",
          "stage, embryo (lus dans le nom)" if LANG == "fr" else "stage, embryo (read from the name)",
          "created, description (de départ)" if LANG == "fr" else "created, description (initial)"]),
        ("amber", tr("2. L'opérateur règle", "2. The operator adjusts"),
         ["name, description", "stage, stageNumeric, embryo", "voxel_size (calibration à la main)" if LANG == "fr" else "voxel_size (hand calibration)",
          "channels[] : nom, couleur, fenêtre" if LANG == "fr" else "channels[]: name, colour, window",
          "exposure", "orientation, orientationAxes", "upsideDown, orientation2d", "gallery[] (légendes, ordre)" if LANG == "fr" else "gallery[] (captions, order)",
          "hidden (visibilité)" if LANG == "fr" else "hidden (visibility)", "line, staining, reporter, tags…"]),
        ("green", tr("3. La plateforme pose", "3. The platform sets"),
         ["id, type, folderName (à chaque envoi)" if LANG == "fr" else "id, type, folderName (every save)",
          "configured = true", "lastModified", "formatVersion (migration)" if LANG == "fr" else "formatVersion (migration)",
          "hidden = true (à la publication)" if LANG == "fr" else "hidden = true (on publish)",
          "gallery[] : thumb, added" if LANG == "fr" else "gallery[]: thumb, added",
          "jamais : champs calculés (staging…)" if LANG == "fr" else "never: computed fields (staging…)"]),
    ]
    x = 24
    for col, hd, lines in cols:
        w = 245
        b.append(card(x, 70, w, 262, col, hd, lines, size=12, head_size=14.5, mono_lines=False, lh=21))
        x += w + 8
    # règles de fusion
    s1, f1 = P["blue"]
    b.append(R(24, 346, 752, 118, "#fff", LINE, 12))
    b.append(T(40, 372, tr("Quand le même jeu de données est refait ou remplacé", "When the same dataset is redone or replaced"), 14, 800))
    b.append(T(40, 398, tr("Le pipeline refait un jeu :", "Pipeline redoes it:"), 12.5, 700, P["blue"][0]))
    b.append(T(215, 398, tr("mesures du nouveau passage ; les 20 clés « curées » de l'ancien fichier gagnent.",
                            "measurements from the new run; the 20 “curated” keys of the old file win."), 12.5, maxw=550))
    b.append(T(40, 424, tr("L'import remplace un jeu :", "Import replaces it:"), 12.5, 700, P["green"][0]))
    b.append(T(215, 424, tr("le nouveau fichier gagne ; une clé curée n'est reprise que s'il en manque.",
                            "the new file wins; a curated key is carried only if it is missing."), 12.5, maxw=550))
    b.append(T(40, 450, tr("Dans les deux cas :", "In both cases:"), 12.5, 700, P["red"][0]))
    b.append(T(215, 450, tr("formatVersion n'est jamais repris de l'ancien fichier (il décrit le disque).",
                            "formatVersion is never taken from the old file (it describes the disk)."), 12.5, maxw=550))
    save("qui-ecrit.svg", 484, b)


# ── Les blocs d'un metadata.json ───────────────────────────────────────────────
def metadata_blocs():
    b = [title(tr("Les blocs d'un metadata.json, selon le type", "The blocks of a metadata.json, by type"),
               tr("Chaque colonne reprend les vrais champs des jeux de démonstration.",
                  "Each column lists the real fields of the demo datasets."))]
    def col(x, w, head, color, blocks):
        out = [T(x + w / 2, 80, head, 14.5, 800, P[color][0], "middle")]
        y = 94
        for bcol, bt, lines in blocks:
            h = 26 + 17.5 * len(lines)
            out.append(R(x, y, w, h, P[bcol][1], P[bcol][0], 9, 1.4))
            out.append(T(x + 10, y + 18, bt, 12, 800, P[bcol][0]))
            for i, ln in enumerate(lines):
                out.append(T(x + 10, y + 36 + i * 17.5, ln, 11, 400, INK, mono=True, maxw=w - 16))
            y += h + 8
        return out
    ident = ("blue", tr("identité", "identity"), ["id  type  name  folderName", "stage  stageNumeric  embryo", "description  created", "lastModified  configured", "formatVersion  hidden"])
    geo = ("teal", tr("géométrie et calibration", "geometry and calibration"), ["dimensions {x,y,z,c,t}", "voxel_size  physicalSizeUm", "optical_section_thickness_um", "acquisitionExtentUm", "calibrationStatus / Note"])
    chans = ("violet", tr("canaux et sources", "channels and sources"), ["channels[] {name,color,", "  min,max,gamma}", "volumeSources[] {kind,", "  path,manifestPath…}", "thumbnail"])
    b.append(col(24, 244, "3d", "blue", [ident, geo, chans,
                                         ("amber", tr("réglages de l'opérateur", "operator settings"), ["exposure  orientation", "orientationAxes  upsideDown", "gallery[]  relatedIds…"])]))
    b.append(col(278, 244, "live (" + tr("en plus", "in addition") + ")", "green", [
        ("green", "timeline", ["count  intervalMinutes", "timestamps[]"]),
        ("green", "intensityNormalization", ["mode  bounds{c0,c1…}", "signalLevels{t000_c0…}"]),
        ("green", "tracking", ["schema  source  cellCount", "regions[]  boundsUm", "provenance  alignment"]),
        ("green", "registration", ["method  convention", "transforms[] {t,matrix,", "  residualUm…}", "qcSummary  imageBoxUnionUm"]),
        ("grey", tr("(+ tout le bloc 3d)", "(+ the whole 3d block)"), []),
    ]))
    b.append(col(532, 244, "2d", "amber", [
        ("blue", tr("identité", "identity"), ["id  type  name  stage", "line  staining  date", "embryo (null)  hidden"]),
        ("teal", tr("pixels", "pixels"), ["dimensions {x,y,z=1,c=3}", "pixelSizeUm {x,y}", "physicalSizeUm", "calibrationStatus / Note"]),
        ("violet", "image", ["native  width  height", "preview  previewWidth", "previewHeight"]),
        ("amber", "acquisition", ["modality  sourceFile", "lifFile  series", "dissectionDate  zoomNominal"]),
        ("grey", tr("channels : [] (aucun)", "channels: [] (none)"), []),
    ]))
    save("metadata-blocs.svg", 566, b)


# ── La chaîne des empreintes ───────────────────────────────────────────────────
def empreintes():
    b = [title(tr("Qui garantit quoi : la chaîne des empreintes SHA-256", "Who vouches for what: the SHA-256 chain"),
               tr("Valeurs réelles du jeu de démonstration 3D (début des 64 caractères).",
                  "Real values of the 3D demo dataset (first characters of 64)."))]
    # manifest au centre
    b.append(card(270, 80, 260, 120, "blue", "bricks/manifest.json", [
        tr("sha256 de ses octets :", "sha256 of its bytes:"), "6557d1fe4813…", 'index.sha256 = "aea0980…"'], size=12, mono_lines=False))
    b.append(card(24, 80, 210, 120, "violet", "bricks/index.bin", [tr("7 846 octets", "7,846 bytes"), "sha256 = aea0980…", tr("(vérifié avant usage)", "(checked before use)")], size=12))
    b.append(card(566, 80, 210, 120, "teal", tr("paquets l0/c0/p00000.bin", "packs l0/c0/p00000.bin"), [tr("URL + ?v=aea098088a2a", "URL + ?v=aea098088a2a"), tr("→ cache d'un an", "→ one-year cache"), tr("(12 premiers hex)", "(first 12 hex)")], size=12))
    b.append(L(270, 140, 234, 140, P["violet"][0], 2.2, arrow=True))
    b.append(L(530, 140, 566, 140, P["teal"][0], 2.2, arrow=True))
    b.append(T(252, 130, "index", 10.5, 600, P["violet"][0], "middle"))
    b.append(T(548, 130, "?v=", 10.5, 600, P["teal"][0], "middle"))
    # planes / mips
    b.append(card(80, 260, 280, 100, "amber", "planes/manifest.json", ['source.manifestSha256', '= 6557d1fe4813…', tr("= l'empreinte du manifeste des briques", "= the fingerprint of the bricks manifest")], size=12))
    b.append(card(440, 260, 280, 100, "amber", "mips/manifest.json", ['source.manifestSha256', '= 6557d1fe4813…', tr("= la même empreinte", "= the same fingerprint")], size=12))
    b.append(PATH("M 400 200 L 400 232 L 220 232 L 220 258", P["amber"][0], 2, arrow=True))
    b.append(PATH("M 400 232 L 580 232 L 580 258", P["amber"][0], 2, arrow=True))
    b.append(T(404, 224, tr("« ces plans ont été faits depuis CE manifeste »", "“these planes were made from THIS manifest”"), 11.5, 600, P["amber"][0]))
    # bas : qui vérifie
    b.append(R(24, 384, 752, 90, "#fff", LINE, 12))
    b.append(T(40, 408, tr("Qui relit ces empreintes ?", "Who reads these fingerprints?"), 13.5, 800))
    for i, ln in enumerate([
        tr("• le viewer vérifie l'index avant de s'en servir, et signe les URL de paquets (?v=) ;", "• the viewer checks the index before using it, and stamps pack URLs (?v=);"),
        tr("• l'import refuse un dossier dont l'index ne correspond pas (index_hash_mismatch) ;", "• the import refuses a folder whose index does not match (index_hash_mismatch);"),
        tr("• une migration annule son travail si le manifeste change en route (source_changed) et re-signe planes/ et mips/ après la v3.", "• a migration drops its work if the manifest changes meanwhile (source_changed) and re-stamps planes/ and mips/ after v3.")]):
        b.append(T(40, 430 + i * 18, ln, 12, 400, INK2, maxw=720))
    save("empreintes.svg", 492, b)


# ── Le catalogue calculé à chaque requête ─────────────────────────────────────
def catalogue():
    b = [title(tr("Le catalogue n'est pas un fichier : il est calculé", "The catalogue is not a file: it is computed"),
               tr("GET /DATA_WEB/catalog.json → une réponse construite depuis les metadata.json.",
                  "GET /DATA_WEB/catalog.json → an answer built from the metadata.json files."))]
    b.append(card(24, 74, 210, 190, "blue", "DATA_WEB/", ["3d/  <jeu>/metadata.json" if LANG == "fr" else "3d/  <set>/metadata.json", "2d/  <jeu>/metadata.json" if LANG == "fr" else "2d/  <set>/metadata.json",
                                                         "live/<jeu>/metadata.json" if LANG == "fr" else "live/<set>/metadata.json", "", tr("rien d'autre à tenir à jour :", "nothing else to keep up to date:"), tr("déposer un dossier suffit", "dropping a folder is enough")], size=12, mono_lines=False))
    steps = [
        tr("1. ignorer les dossiers « . » (publication)", "1. skip “.” folders (publishing)"),
        tr("2. lire chaque metadata.json", "2. read each metadata.json"),
        tr("3. imposer id, path, type (le dossier fait foi)", "3. force id, path, type (the folder is the authority)"),
        tr("4. thumbnail = le fichier s'il existe", "4. thumbnail = the file if it exists"),
        tr("5. garder : configuré ou vignette, et non masqué", "5. keep: configured or thumbnailed, and not hidden"),
        tr("6. trier : date la plus récente d'abord, puis nom", "6. sort: newest date first, then name"),
    ]
    b.append(R(262, 74, 290, 190, "#fff", P["violet"][0], 12, 1.6))
    b.append(T(277, 98, tr("Le scan (par requête)", "The scan (per request)"), 14, 800, P["violet"][0]))
    for i, s in enumerate(steps):
        b.append(T(277, 122 + i * 22, s, 11.5, 400, INK, maxw=265))
    b.append(L(234, 169, 262, 169, INK2, 2.2, arrow=True))
    b.append(card(580, 74, 196, 190, "green", tr("La réponse", "The answer"), ["catalog.json", tr("+ ETag (sha-256)", "+ ETag (sha-256)"), "Cache-Control: no-cache", "", tr("→ 304 si rien n'a changé", "→ 304 if nothing changed")], size=12))
    b.append(L(552, 169, 580, 169, INK2, 2.2, arrow=True))
    # cache
    b.append(R(24, 286, 752, 96, "#fff", LINE, 12))
    b.append(T(40, 310, tr("Pourquoi ce n'est pas lent : une signature faite de stat() seulement", "Why it is not slow: a signature made of stat() calls only"), 13.5, 800))
    for i, ln in enumerate([
        tr("• la liste n'est recalculée que si l'un des metadata.json (date, taille) ou des dossiers a changé ;", "• the list is recomputed only if a metadata.json (date, size) or a folder changed;"),
        tr("• la signature est revérifiée au plus toutes les 2 secondes (serveur Python) ; chaque écriture de l'admin la remet à zéro.", "• the signature is rechecked at most every 2 seconds (Python server); every admin write resets it."),
        tr("• côté PHP : api/catalog.php, réécrit depuis /DATA_WEB/catalog.json, cache dans api/.catalog-cache.json.", "• on PHP: api/catalog.php, rewritten from /DATA_WEB/catalog.json, cached in api/.catalog-cache.json.")]):
        b.append(T(40, 332 + i * 18, ln, 11.8, 400, INK2, maxw=725))
    b.append(R(24, 396, 752, 44, P["amber"][1], P["amber"][0], 10, 1.4))
    b.append(T(400, 423, tr("Conséquence : un jeu copié par SFTP apparaît seul ; un jeu « masqué » reste invisible du public mais visible de l'admin.",
                            "Result: a dataset copied over SFTP appears by itself; a “hidden” one stays invisible to the public."), 12, 600, INK, "middle", maxw=730))
    save("catalogue.svg", 454, b)


# ── La migration unique des types ──────────────────────────────────────────────
def migration_types():
    b = [title(tr("La conversion unique du vocabulaire (depuis la 1.51.0)", "The one-shot vocabulary conversion (since 1.51.0)"),
               tr("Faite au démarrage par les deux serveurs ; ne coûte presque rien quand il n'y a plus rien à convertir.",
                  "Run at start-up by both servers; costs almost nothing when there is nothing left to convert."))]
    rows = [("fixed/", "3d/", "blue"), ("wholemount/", "2d/", "amber"), ("tracking/", tr("supprimé si vide, sinon laissé et signalé", "removed if empty, else left and reported"), "red")]
    y = 78
    for old, new, col in rows:
        b.append(R(60, y, 190, 40, "#fff", LINE, 8))
        b.append(T(155, y + 26, old, 15, 700, INK2, "middle", mono=True))
        b.append(L(250, y + 20, 330, y + 20, P[col][0], 2.4, arrow=True))
        b.append(R(334, y, 400, 40, P[col][1], P[col][0], 8, 1.5))
        b.append(T(354, y + 26, new, 14 if len(new) < 8 else 11.8, 700 if len(new) < 8 else 400, INK, mono=len(new) < 8, maxw=370))
        y += 52
    b.append(R(24, 240, 752, 196, "#fff", LINE, 12))
    b.append(T(40, 264, tr("Ce qui est converti, d'un seul passage", "What is converted, in a single pass"), 14, 800))
    items = [
        tr("les dossiers de DATA_WEB/ et de uploads/staging/ (un par un si la cible existe déjà)", "the folders of DATA_WEB/ and uploads/staging/ (one by one if the target exists)"),
        tr("les journaux d'import uploads/state/fixed__*.json (renommés et réécrits)", "the import journals uploads/state/fixed__*.json (renamed and rewritten)"),
        tr('"type" et "id" de chaque metadata.json, et les anciens id dans relatedIds / linkedTrackingId', '"type" and "id" of every metadata.json, and old ids in relatedIds / linkedTrackingId'),
        tr("les clés de api/stats.json (compteurs additionnés en cas de collision)", "the keys of api/stats.json (counters summed on collision)"),
        tr("pageTitles.wholemount, et les liens explorer.html?type=… des pages construites", "pageTitles.wholemount, and the explorer.html?type=… links of built pages"),
    ]
    for i, s in enumerate(items):
        b.append(T(44, 292 + i * 22, "• " + s, 12, 400, INK, maxw=715))
    b.append(T(44, 410, tr("Ce n'est pas une couche de compatibilité : après la conversion, plus aucun code ne lit les anciens mots.",
                           "It is not a compatibility layer: after the conversion, no code reads the old words any more."), 12, 700, P["red"][0], maxw=715))
    b.append(T(44, 428, tr("Une seule passe tourne à chaque démarrage : la réparation de l'identité (type/id) d'un metadata.json qui contredit son dossier.",
                           "One pass runs at every start: repairing the identity (type/id) of a metadata.json that contradicts its folder."), 11.5, 400, INK2, maxw=715))
    save("migration-types.svg", 452, b)


def run2():
    qui_ecrit()
    metadata_blocs()
    empreintes()
    catalogue()
    migration_types()


def carte_chapitre():
    b = [title(tr("Ce chapitre, en une carte", "This chapter, on one map"),
               tr("Trois questions, trois parties : de quoi est fait un jeu de données, comment il change de format, comment il arrive.",
                  "Three questions, three parts: what a dataset is made of, how it changes format, how it arrives."))]
    parts = [
        ("blue", "A", tr("Les fichiers", "The files"), tr("De quoi est fait un jeu de données ?", "What is a dataset made of?"),
         [tr("17.1  les trois arbres annotés", "17.1  the three annotated trees"), tr("17.2  qui écrit quoi", "17.2  who writes what"), tr("17.3  metadata.json, champ par champ", "17.3  metadata.json, field by field"),
          tr("17.4  manifestes, index, tracks.json", "17.4  manifests, index, tracks.json"), tr("17.5  catalogue et vocabulaire", "17.5  catalogue and vocabulary"), tr("17.6  download/ et gallery/", "17.6  download/ and gallery/")]),
        ("amber", "B", tr("Les formats et les migrations", "Formats and migrations"), tr("Comment un jeu change-t-il de format ?", "How does a dataset change format?"),
         [tr("17.7  les formats 1 à 4", "17.7  formats 1 to 4"), tr("17.8  trois migrations", "17.8  three migrations"), tr("17.9  unités et journal", "17.9  units and journal"),
          tr("17.10  deux exécutants", "17.10  two executors"), tr("17.11  finalize", "17.11  finalize"), tr("17.12  régulateur, hébergeurs lents", "17.12  governor, slow hosts")]),
        ("green", "C", tr("L'import dans le navigateur", "The browser import"), tr("Comment un jeu arrive-t-il sans SFTP ?", "How does a dataset arrive without SFTP?"),
         [tr("17.13  le parcours", "17.13  the journey"), tr("17.14  la liste blanche", "17.14  the allowlist"), tr("17.15  les paliers", "17.15  the tiers"),
          tr("17.16  blocs et journal", "17.16  chunks and journal"), tr("17.17  états et purge", "17.17  states and purge"), tr("17.18  valider, publier, remplacer", "17.18  validate, publish, replace")]),
    ]
    for i, (col, letter, hd, q, items) in enumerate(parts):
        x = 24 + i * 254
        s, soft = P[col]
        b.append(R(x, 78, 244, 258, soft, s, 14, 1.8))
        b.append(CIRC(x + 26, 108, 16, s))
        b.append(T(x + 26, 114, letter, 17, 800, "#fff", "middle"))
        b.append(T(x + 50, 112, hd, 14, 800, s, maxw=190))
        b.append(T(x + 14, 148, q, 12, 700, INK, maxw=220))
        for j, it in enumerate(items):
            b.append(T(x + 14, 180 + j * 24, it, 11.8, 400, INK, maxw=222))
    b.append(R(24, 350, 752, 44, "#fff", LINE, 10))
    b.append(T(400, 377, tr("Fil rouge : un jeu de données est un dossier, et chaque fichier a un auteur, une raison d'être et un contrôle d'intégrité.", "Common thread: a dataset is a folder, and every file has an author, a purpose and an integrity check."), 12, 600, INK, "middle", maxw=735))
    save("carte-chapitre.svg", 410, b)


def pack_planes():
    import struct
    f = WEB / "3d/Embryo-E95-Em2-Pecam1-Sox2/planes/z00030.bin"
    data = f.read_bytes()
    magic, ver, C, TX, TY, z = struct.unpack_from("<4sHHHHI", data, 0)
    n = C * TX * TY
    ents = [struct.unpack_from("<QI", data, 16 + 12 * i) for i in range(n)]
    hb = 16 + 12 * n
    b = [title(tr("Un fichier plan, octet par octet", "A plane file, byte by byte"),
               tr(f"planes/z00030.bin du jeu de démonstration : {len(data):,} octets pour 3 canaux × 2 × 2 tuiles.".replace(",", " "),
                  f"planes/z00030.bin of the demo dataset: {len(data):,} bytes for 3 channels × 2 × 2 tiles."))]
    # en-tête décodé
    hx = " ".join(f"{x:02x}" for x in data[:16])
    b.append(R(24, 70, 752, 84, "#fff", P["blue"][0], 12, 1.6))
    b.append(T(40, 92, tr("les 16 premiers octets", "the first 16 bytes"), 12.5, 800, P["blue"][0]))
    b.append(T(40, 114, hx, 13, 700, INK, mono=True))
    labs = [("4c 50 4c 4e", tr("« LPLN »", "“LPLN”"), 0, 4), ("01 00", tr("version 1", "version 1"), 4, 2), ("03 00", "C = 3", 6, 2), ("02 00", "TX = 2", 8, 2), ("02 00", "TY = 2", 10, 2), ("1e 00 00 00", "z = 30", 12, 4)]
    for hxs, lab, off, ln in labs:
        x = 40 + off * 3 * 7.8 + (ln * 3 * 7.8) / 2 - 3
        b.append(T(x, 138, lab, 10.8, 700, P["blue"][0], "middle"))
    # table et charges utiles
    b.append(T(24, 182, tr(f"Puis {n} entrées de 12 octets (décalage u64 + longueur u32), dans l'ordre canal, tuile Y, tuile X : en-tête = 16 + 12 × {n} = {hb} octets",
                           f"Then {n} entries of 12 bytes (u64 offset + u32 length), in channel, tile Y, tile X order: header = 16 + 12 × {n} = {hb} bytes"), 12.2, 700, INK, maxw=752))
    x0, W = 24, 752
    total = len(data)
    b.append(R(x0, 200, W * hb / total, 34, P["blue"][1], P["blue"][0], 3, 1.4))
    cols = {0: "blue", 1: "green", 2: "violet"}
    for i, (off, ln) in enumerate(ents):
        c = i // (TX * TY)
        if ln == 0:
            continue
        x = x0 + W * off / total
        w = W * ln / total
        b.append(R(x, 200, w, 34, P[cols[c]][1], P[cols[c]][0], 3, 1.4))
        if w > 28:
            b.append(T(x + w / 2, 222, f"c{c}", 11, 700, P[cols[c]][0], "middle"))
    b.append(T(x0 + 2, 254, tr("table", "table"), 10.8, 700, P["blue"][0]))
    # légende des tuiles
    b.append(T(24, 288, tr("Les 12 tuiles (une ligne par entrée)", "The 12 tiles (one row per entry)"), 12.5, 800))
    for i, (off, ln) in enumerate(ents):
        c, rem = divmod(i, TX * TY)
        ty, tx = divmod(rem, TX)
        col = (i % 4)
        x = 24 + (i % 4) * 190
        y = 312 + (i // 4) * 54
        s, soft = P[cols[c]] if ln else P["red"]
        b.append(R(x, y, 180, 44, soft, s, 8, 1.4))
        b.append(T(x + 10, y + 18, f"c{c}  y{ty}  x{tx}", 12, 800, s, mono=True))
        if ln:
            b.append(T(x + 10, y + 36, tr(f"début {off:,} · {ln:,} o".replace(",", " "), f"start {off:,} · {ln:,} B"), 10.8, 400, INK))
        else:
            b.append(T(x + 10, y + 36, tr("longueur 0 : tuile toute noire", "length 0: all-black tile"), 10.8, 700, s))
    b.append(R(24, 482, 752, 56, P["amber"][1], P["amber"][0], 10, 1.4))
    b.append(T(400, 506, tr("Chaque tuile est un PNG gris complet (signature 89 50 4e 47…), 512 × 512 pixels au plus.", "Each tile is a complete grey PNG (signature 89 50 4e 47…), 512 × 512 pixels at most."), 11.8, 700, INK, "middle", maxw=735))
    b.append(T(400, 524, tr("Une tuile entièrement nulle n'occupe aucun octet : sa longueur est 0 et son décalage 0.", "A tile that is entirely zero takes no byte: its length is 0 and its offset 0."), 11.5, 400, INK2, "middle", maxw=735))
    save("pack-planes.svg", 556, b)
