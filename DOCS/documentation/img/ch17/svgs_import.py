"""Figures de la partie « l'import dans le navigateur »."""
import hashlib
import json
import sys
from pathlib import Path
from svglib import *

HERE = Path(__file__).resolve().parent
ROOT = Path(__file__).resolve().parents[4]
DATA = HERE / "data"
sys.path.insert(0, str(ROOT))


def real_import():
    p = DATA / "real_import.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


# ── Le parcours d'un import ────────────────────────────────────────────────────
def import_flux():
    b = [title(tr("Du dossier déposé au jeu publié", "From the dropped folder to the published dataset"),
               tr("Six étapes ; seules les trois du milieu transportent des octets.", "Six steps; only the three in the middle move bytes."))]
    steps = [
        ("blue", "1", tr("Déposer", "Drop"), [tr("glissez le dossier", "drag the folder"), tr("le navigateur le lit", "the browser reads it"), tr("(8 fichiers à la fois)", "(8 files at a time)")]),
        ("blue", "2", tr("Planifier", "Plan"), [tr("1 requête par jeu :", "1 request/dataset:"), tr("la liste des fichiers", "the list of files"), tr("+ leurs tailles", "+ their sizes")]),
        ("violet", "3", tr("Envoyer", "Send"), [tr("blocs de 8 Mio", "8 MiB chunks"), tr("SHA-256 par bloc", "SHA-256 per chunk"), tr("4 en parallèle", "4 in parallel")]),
        ("violet", "4", tr("Refermer", "Close"), [tr("un fichier fini :", "a finished file:"), tr("taille + contenu +", "size + content +"), tr("empreinte globale", "overall fingerprint")]),
        ("amber", "5", tr("Vérifier", "Validate"), [tr("le jeu est-il", "is the dataset"), tr("entier et cohérent ?", "whole, consistent?"), tr("(codes d'erreur)", "(error codes)")]),
        ("green", "6", tr("Publier", "Publish"), [tr("un renommage", "one rename"), tr("vers DATA_WEB/", "into DATA_WEB/"), tr("masqué par défaut", "hidden by default")]),
    ]
    w = 118
    for i, (col, n, hd, ls) in enumerate(steps):
        x = 24 + i * (w + 8.8)
        s, soft = P[col]
        b.append(R(x, 72, w, 124, soft, s, 12, 1.7))
        b.append(CIRC(x + 20, 96, 12, s))
        b.append(T(x + 20, 101, n, 13, 800, "#fff", "middle"))
        b.append(T(x + 38, 101, hd, 13, 800, s, maxw=w - 42))
        for j, ln in enumerate(ls):
            b.append(T(x + 10, 128 + j * 19, ln, 11, 400, INK, maxw=w - 14))
    # bande navigateur / serveur
    b.append(R(24, 214, 366, 28, P["blue"][1], P["blue"][0], 8, 1.3))
    b.append(T(207, 233, tr("dans le navigateur (un Web Worker fait tout le transfert)", "in the browser (a Web Worker does the whole transfer)"), 11.5, 700, P["blue"][0], "middle", maxw=355))
    b.append(R(400, 214, 376, 28, P["amber"][1], P["amber"][0], 8, 1.3))
    b.append(T(588, 233, tr("sur le serveur : staging jamais servi, puis DATA_WEB/", "on the server: never-served staging, then DATA_WEB/"), 11.5, 700, P["amber"][0], "middle", maxw=365))
    # trois remarques
    b.append(R(24, 258, 752, 150, "#fff", LINE, 12))
    b.append(T(40, 282, tr("Les trois garanties qui font la différence", "The three guarantees that make the difference"), 13.5, 800))
    pts = [
        (tr("Reprise : ", "Resume: "), tr("un journal note chaque bloc reçu ; reglisser le dossier reprend au bloc près, même sous l'autre serveur.", "a journal notes every chunk received; dropping the folder again resumes to the chunk, even under the other server.")),
        (tr("Contrôle : ", "Control: "), tr("rien n'est écrit avant d'avoir vérifié le chemin (liste blanche) et l'empreinte du bloc.", "nothing is written before the path (allowlist) and the chunk fingerprint are checked.")),
        (tr("Priorité : ", "Priority: "), tr("les fichiers qui rendent le jeu ouvrable partent d'abord (paliers) : on peut l'éditer avant la fin.", "the files that make the dataset openable go first (tiers): you can edit before the end.")),
    ]
    for i, (k, v) in enumerate(pts):
        b.append(T(44, 312 + i * 30, k, 12, 800, P["blue"][0]))
        b.append(T(130, 312 + i * 30, v, 11.6, 400, INK, maxw=640))
    b.append(T(44, 396, tr("Rien n'atteint DATA_WEB/ sans votre clic sur Publier.", "Nothing reaches DATA_WEB/ without your click on Publish."), 12, 800, P["green"][0]))
    save("import-flux.svg", 424, b)


# ── La liste blanche ───────────────────────────────────────────────────────────
def liste_blanche():
    o = real_import()
    b = [title(tr("La liste blanche : tout ce qui n'est pas prévu est refusé", "The allowlist: anything not foreseen is refused"),
               tr("Deux barrières, dans l'ordre ; aucun octet n'est accepté avant d'avoir passé les deux.", "Two gates, in order; no byte is accepted before passing both."))]
    b.append(R(24, 70, 752, 74, "#fff", P["violet"][0], 12, 1.6))
    b.append(T(40, 92, tr("Barrière 1 — la forme du chemin (_safe_rel)", "Gate 1 — the shape of the path (_safe_rel)"), 13, 800, P["violet"][0]))
    b.append(T(40, 112, tr("refuse : octet nul, chemin absolu, « \\ », « . » et « .. », fichier caché (« .xxx »), plus de 12 niveaux, segment > 200 caractères.", "refuses: null byte, absolute path, “\\”, “.” and “..”, hidden file (“.xxx”), more than 12 levels, segment > 200 characters."), 11.5, 400, INK, maxw=715))
    b.append(T(40, 130, tr("puis, sur le disque : resolve() doit retomber dans le dossier du jeu.", "then, on disk: resolve() must land inside the dataset folder."), 11.5, 400, INK2, maxw=715))
    b.append(T(24, 170, tr("Barrière 2 — une des règles suivantes (classify_path), selon le type", "Gate 2 — one of the following rules (classify_path), by type"), 13, 800, P["green"][0]))
    rows = [
        ("metadata.json  thumbnail.webp", "0", tr("3d live 2d", "3d live 2d")),
        ("bricks/manifest.json  bricks/index.bin", "0", "3d live"),
        ("bricks/t001/index.bin  (une image)" if LANG == "fr" else "bricks/t001/index.bin  (one frame)", "0", "live"),
        ("preview.webp  image.webp", "1 · 2", "2d"),
        ("tracks.json  tracks.json.gz", "1", "live"),
        ("bricks/l3/c0/p00000.bin  bricks/lod2/c1/pack_00.bin", "1…3", "3d live"),
        ("model.glb", "3", "3d live"),
        ("planes/z00007.bin  planes/t001/…  mips/l00000.bin", "4", "3d live"),
        ("download/<nom>.ims .tif .png .zip .txt …", "4", tr("3d live 2d", "3d live 2d")),
    ]
    b.append(T(560, 190, tr("palier", "tier"), 11, 700, INK2, "middle"))
    b.append(T(700, 190, tr("types", "types"), 11, 700, INK2, "middle"))
    for i, (pat, tier, types) in enumerate(rows):
        y = 210 + i * 25
        b.append(R(24, y - 15, 752, 22, P["green"][1] if i % 2 == 0 else "#fff", "none", 4, 0))
        b.append(T(36, y, "✓", 13, 800, P["green"][0]))
        b.append(T(56, y, pat, 11.5, 400, INK, mono=True, maxw=470))
        b.append(T(560, y, tier, 11.5, 700, INK2, "middle"))
        b.append(T(700, y, types, 11.5, 400, INK2, "middle"))
    y0 = 210 + len(rows) * 25 + 14
    b.append(T(24, y0, tr("Refusés (résultats réels du moteur)", "Refused (real engine results)"), 13, 800, P["red"][0]))
    ref = [
        ("evil.php", tr("pas de règle", "no rule")), (".htaccess", tr("fichier caché", "hidden file")), ("../x.png", tr("chemin remontant", "path traversal")),
        ("download/report.html", tr("HTML/SVG/XML : rendu actif", "HTML/SVG/XML: active content")), ("gallery/a.png", tr("la galerie ne voyage pas", "the gallery does not travel")),
        ("bricks/l0/c0/p0.bin", tr("nom de paquet hors motif", "pack name off pattern")),
    ]
    for i, (p, why) in enumerate(ref):
        x = 24 + (i % 2) * 380
        y = y0 + 24 + (i // 2) * 24
        b.append(T(x, y, "✗", 13, 800, P["red"][0]))
        b.append(T(x + 20, y, p, 11.5, 400, INK, mono=True, maxw=190))
        b.append(T(x + 215, y, why, 11, 400, INK2, maxw=150))
    yb = y0 + 24 + 3 * 24 + 10
    b.append(R(24, yb, 752, 40, P["amber"][1], P["amber"][0], 10, 1.4))
    b.append(T(400, yb + 25, tr("Un « .php » caché dans « a.php.png » passe (extension finale png) : download/ n'est jamais exécuté et toujours servi en pièce jointe.", "A “.php” hidden in “a.php.png” passes (final extension png): download/ is never executed and always served as an attachment."), 11, 600, INK, "middle", maxw=740))
    save("liste-blanche.svg", yb + 56, b)


# ── Les paliers ────────────────────────────────────────────────────────────────
def paliers():
    o = real_import()
    t = o["tiers"] if o else {}
    cols = {"0": "blue", "1": "teal", "2": "green", "3": "amber", "4": "grey"}
    names = {
        "0": tr("0 · cœur", "0 · core"), "1": tr("1 · aperçu", "1 · preview"), "2": tr("2 · niveaux intermédiaires", "2 · middle levels"),
        "3": tr("3 · niveau natif", "3 · native level"), "4": tr("4 · planes, mips, originaux", "4 · planes, mips, originals"),
    }
    what = {
        "0": tr("metadata.json, manifeste, index.bin, vignette", "metadata.json, manifest, index.bin, thumbnail"),
        "1": tr("le niveau le plus grossier, tous canaux", "the coarsest level, every channel"),
        "2": tr("les niveaux entre les deux, du plus grossier au plus fin", "the levels in between, coarse to fine"),
        "3": tr("niveau 0 ; images 1, 2, 3… d'une série", "level 0; frames 1, 2, 3… of a series"),
        "4": tr("planes/, mips/, download/ (hors les originaux : 530 Mo)", "planes/, mips/, download/ (not counting the originals: 530 MB)"),
    }
    b = [title(tr("Les paliers : ouvrable en secondes, complet en heures", "Tiers: openable in seconds, complete in hours"),
               tr("Haut : les vrais octets du jeu de démonstration. Bas : le même partage appliqué à 10 Go de briques, à 5 Mo/s.", "Top: the real bytes of the demo dataset. Bottom: the same split applied to 10 GB of bricks, at 5 MB/s."))]
    # tableau
    b.append(T(24, 84, tr("palier", "tier"), 11, 700, INK2))
    b.append(T(250, 84, tr("ce qu'il contient", "what it holds"), 11, 700, INK2))
    b.append(T(640, 84, tr("fichiers", "files"), 11, 700, INK2, "end"))
    b.append(T(770, 84, tr("octets", "bytes"), 11, 700, INK2, "end"))
    for i, k in enumerate("01234"):
        y = 106 + i * 24
        s, soft = P[cols[k]]
        b.append(R(24, y - 15, 752, 22, soft, "none", 4, 0))
        b.append(CIRC(36, y - 4, 5.5, s))
        b.append(T(48, y, names[k], 11.8, 700, s, maxw=200))
        b.append(T(250, y, what[k], 11.5, 400, INK, maxw=380))
        if k in t:
            b.append(T(640, y, str(t[k]["files"]), 11.5, 400, INK2, "end"))
            b.append(T(770, y, fmt_bytes(t[k]["bytes"]), 11.5, 700, INK2, "end"))
    # frise du scénario
    b.append(T(24, 258, tr("Scénario : 10 Go de briques (mêmes proportions) à 5 Mo/s", "Scenario: 10 GB of bricks (same proportions) at 5 MB/s"), 13.5, 800))
    brick_total = sum(t[k]["bytes"] for k in "0123") if t else 1
    fr = {k: (t[k]["bytes"] / brick_total if t else 0.25) for k in "0123"}
    gb, rate = 10e9, 5e6
    secs = {k: fr[k] * gb / rate for k in "0123"}
    x0, wtot = 24, 752
    total = sum(secs.values()) * 1.18   # place pour le palier 4
    x = x0
    acc = 0.0
    marks = []
    for k in "0123":
        w = max(secs[k] / total * wtot, 3)
        s, soft = P[cols[k]]
        b.append(R(x, 276, w, 40, s, s, 3, 0))
        if w > 40:
            b.append(T(x + w / 2, 301, k, 14, 800, "#fff", "middle"))
        x += w
        acc += secs[k]
        marks.append((x, acc, k))
    b.append(R(x, 276, x0 + wtot - x, 40, P["grey"][1], P["grey"][0], 3, 1.2, 'stroke-dasharray="5 4"'))
    b.append(T((x + x0 + wtot) / 2, 301, tr("palier 4 : ensuite", "tier 4: afterwards"), 11.5, 700, P["grey"][0], "middle", maxw=x0 + wtot - x - 6))

    def clock(sec):
        if sec < 90:
            return f"{sec:.0f} s"
        m = sec / 60
        return f"{m:.0f} min" if m < 90 else f"{m / 60:.1f} h".replace(".", ",") if LANG == "fr" else f"{m / 60:.1f} h"
    # jalons
    t01 = secs["0"] + secs["1"]
    xo = x0 + t01 / total * wtot
    b.append(L(xo, 322, xo, 346, P["teal"][0], 2.2))
    b.append(T(xo + 6, 362, tr(f"≈ {clock(t01)} : ouvrable et éditable", f"≈ {clock(t01)}: openable and editable"), 12.5, 800, P["teal"][0]))
    t012 = t01 + secs["2"]
    xm = x0 + t012 / total * wtot
    b.append(L(xm, 322, xm, 380, P["green"][0], 2.2))
    b.append(T(xm + 6, 396, tr(f"≈ {clock(t012)} : toutes les qualités sauf la native", f"≈ {clock(t012)}: every quality except native"), 12, 700, P["green"][0]))
    t0123 = sum(secs.values())
    xe = x0 + t0123 / total * wtot
    b.append(L(xe, 322, xe, 414, P["amber"][0], 2.2))
    b.append(T(xe - 6, 430, tr(f"≈ {clock(t0123)} : briques complètes", f"≈ {clock(t0123)}: bricks complete"), 12, 700, P["amber"][0], "end"))
    b.append(R(24, 450, 752, 46, "#fff", LINE, 10))
    b.append(T(400, 470, tr("Dès le palier 1, le jeu est ouvrable en basse résolution ; une fois édité, metadata.json est verrouillé :", "From tier 1, the dataset opens at low resolution; once edited, metadata.json is locked:"), 11.8, 600, INK, "middle", maxw=735))
    b.append(T(400, 487, tr("la suite du transfert ne remplace pas vos réglages.", "the rest of the transfer does not replace your settings."), 11.8, 600, INK, "middle", maxw=735))
    save("paliers.svg", 512, b)


# ── Anatomie d'un bloc ─────────────────────────────────────────────────────────
def bloc():
    CH = 262144
    path = ROOT / "DATA_WEB/3d/Embryo-E95-Em2-Pecam1-Sox2/bricks/l0/c1/p00001.bin"
    data = path.read_bytes()
    n = (len(data) + CH - 1) // CH
    hs = [hashlib.sha256(data[i * CH:(i + 1) * CH]).hexdigest() for i in range(n)]
    root = hashlib.sha256(b"".join(bytes.fromhex(h) for h in hs)).hexdigest()
    b = [title(tr("Un bloc, de la lecture à l'écriture", "A chunk, from reading to writing"),
               tr(f"Le fichier bricks/l0/c1/p00001.bin du jeu de démonstration ({len(data):,} octets) découpé en blocs de 256 Kio.".replace(",", " "),
                  f"The demo dataset file bricks/l0/c1/p00001.bin ({len(data):,} bytes) cut into 256 KiB chunks."))]
    # fichier
    b.append(T(24, 84, tr("le fichier", "the file"), 12, 700, INK2))
    x0, W = 24, 752
    wchunk = W * CH / len(data)
    for i in range(n):
        w = wchunk if i < n - 1 else W - wchunk * (n - 1)
        col = ["blue", "violet", "teal"][i % 3]
        b.append(R(x0 + wchunk * i, 94, w, 30, P[col][1], P[col][0], 4, 1.5))
        b.append(T(x0 + wchunk * i + w / 2, 114, f"{tr('bloc', 'chunk')} {i}", 12, 700, P[col][0], "middle"))
    b.append(T(24, 142, tr("262 144 octets (256 Kio) par bloc ; le dernier prend le reste : ", "262,144 bytes (256 KiB) per chunk; the last takes the rest: ") + f"{len(data) - CH * (n - 1):,}".replace(",", " " if LANG == "fr" else ",") + tr(" octets", " bytes") + tr("  (par défaut, 8 Mio)", "  (default: 8 MiB)"), 11.5, 400, INK2, maxw=740))
    # étapes pour le bloc 1
    steps = [
        ("blue", "1", tr("Lire et hacher", "Read and hash"), [tr("le Worker lit la tranche", "the Worker reads the slice"), "SHA-256 = " + hs[-1][:10] + "…", tr("(crypto.subtle : HTTPS exigé)", "(crypto.subtle: HTTPS required)")]),
        ("violet", "2", tr("Envoyer", "Send"), [tr("POST ?action=chunk", "POST ?action=chunk"), "&path=…&index=" + str(n - 1), "&sha256=…&fid=4"]),
        ("amber", "3", tr("Le serveur contrôle", "The server checks"), [tr("chemin permis ? numéro de fichier", "path allowed? file number"), tr("↔ chemin ? longueur attendue ?", "↔ path? expected length?"), tr("SHA-256 recalculé = annoncé ?", "SHA-256 = announced?")]),
        ("green", "4", tr("Écrire, noter", "Write, note"), [tr("écrit à l'offset index × taille", "writes at offset index × size"), tr("fsync puis 16 octets ajoutés", "fsync then 16 bytes appended"), tr("au journal des blocs", "to the chunk log")]),
    ]
    w = 178
    for i, (col, nn, hd, ls) in enumerate(steps):
        x = 24 + i * (w + 13)
        s, soft = P[col]
        b.append(R(x, 170, w, 126, soft, s, 12, 1.7))
        b.append(CIRC(x + 20, 194, 12, s))
        b.append(T(x + 20, 199, nn, 13, 800, "#fff", "middle"))
        b.append(T(x + 38, 199, hd, 12.5, 800, s, maxw=w - 44))
        for j, ln in enumerate(ls):
            b.append(T(x + 10, 226 + j * 19, ln, 10.6, 400, INK, maxw=w - 14, mono=(j == 1 and i in (0, 1))))
        if i:
            b.append(L(x - 13, 232, x, 232, INK2, 2, arrow=True))
    # erreurs
    b.append(R(24, 312, 752, 92, "#fff", LINE, 12))
    b.append(T(40, 334, tr("Ce que répond le serveur", "What the server answers"), 13, 800))
    errs = [("200", tr("reçu, écrit, noté", "received, written, noted"), "green"), ("400", "checksum_required · bad_chunk_length", "red"),
            ("409", "file_not_planned (" + tr("replanifier", "re-plan") + ")", "amber"), ("413", "chunk_too_large (> 16 MiB)", "red"),
            ("422", "checksum_mismatch (" + tr("le client renvoie", "the client resends") + ")", "red"), ("507", "insufficient_disk (" + tr("fin du transfert", "end of transfer") + ")", "red")]
    for i, (c, d, col) in enumerate(errs):
        x = 40 + (i % 2) * 370
        y = 358 + (i // 2) * 21
        b.append(R(x, y - 13, 36, 17, P[col][0], P[col][0], 8, 0))
        b.append(T(x + 18, y, c, 10.8, 800, "#fff", "middle"))
        b.append(T(x + 44, y, d, 11, 400, INK, maxw=315, mono=(c != "200")))
    # fin de fichier
    b.append(R(24, 418, 752, 70, P["green"][1], P["green"][0], 12, 1.5))
    b.append(T(40, 440, tr("Quand tous les blocs sont là : file_done", "When all chunks are in: file_done"), 13, 800, P["green"][0]))
    b.append(T(40, 460, tr("le client envoie root = SHA-256 de la suite des empreintes de blocs = " + root[:12] + "…", "the client sends root = SHA-256 of the sequence of chunk fingerprints = " + root[:12] + "…"), 11.3, 400, INK, maxw=715, mono=False))
    b.append(T(40, 477, tr("Le serveur vérifie aussi la taille sur disque et le contenu (signature WebP, JSON valide, en-tête d'index…).", "The server also checks the size on disk and the content (WebP signature, valid JSON, index header…)."), 11.3, 400, INK2, maxw=715))
    save("bloc.svg", 504, b)


# ── Le journal d'import : trois fichiers ───────────────────────────────────────
def journal_import():
    import upload_staging as us
    o = real_import()
    entry = o["journal_entry_example"] if o else {}
    fid = int(entry.get("id", 4))
    size = int(entry.get("size", 329046))
    chunk = int(entry.get("chunkSize", 262144))
    tag = us._path_tag("bricks/l0/c1/p00001.bin")
    rec = us._TABLE_RECORD.pack(size, chunk, 1, tag)
    log0, log1 = us._log_record(fid, 0), us._log_record(fid, 1)
    hexs = lambda bs, n=8: " ".join(f"{x:02x}" for x in bs[:n])
    b = [title(tr("Le journal d'import : trois fichiers, un format commun", "The import journal: three files, one shared format"),
               tr("uploads/state/<type>__<dossier>.json / .files / .log — lus et écrits par Python comme par PHP.", "uploads/state/<type>__<folder>.json / .files / .log — read and written by Python and PHP alike."))]
    # JSON
    b.append(R(24, 70, 752, 138, "#fff", P["blue"][0], 12, 1.6))
    b.append(T(40, 92, ".json  " + tr("— l'état de chaque fichier (réécrit rarement)", "— the state of each file (rarely rewritten)"), 13, 800, P["blue"][0]))
    jl = ['"bricks/l0/c1/p00001.bin": { "size": %d, "chunkSize": %d,' % (size, chunk),
          '   "kind": "pack", "tier": 3, "id": %d, "done": %s,' % (fid, str(entry.get("done", True)).lower()),
          '   "bits": "%s", "sha": "0c7c826a73d9…" }' % entry.get("bits", "Aw==")]
    for i, ln in enumerate(jl):
        b.append(T(40, 118 + i * 19, ln, 11.4, 400, INK, mono=True, maxw=720))
    b.append(T(40, 184, tr("bits = une case par bloc, en base 64 : « Aw== » = 0x03 = blocs 0 et 1 reçus. id : jamais réutilisé.", "bits = one slot per chunk, base 64: “Aw==” = 0x03 = chunks 0 and 1 received. id: never reused."), 11.5, 400, INK2, maxw=715))
    # files
    b.append(R(24, 222, 752, 100, "#fff", P["violet"][0], 12, 1.6))
    b.append(T(40, 244, ".files  " + tr("— la table des fichiers prévus : 16 octets d'en-tête puis 32 octets par fichier", "— the table of planned files: 16-byte header then 32 bytes per file"), 13, 800, P["violet"][0], maxw=715))
    b.append(T(40, 268, tr("enregistrement n° %d :" % fid, "record #%d:" % fid), 11.5, 700, INK2))
    parts = [("blue", hexs(rec[0:8]), tr("taille u64 = %d" % size, "size u64 = %d" % size)), ("violet", hexs(rec[8:12], 4), tr("bloc u32 = %d" % chunk, "chunk u32 = %d" % chunk)),
             ("amber", hexs(rec[12:16], 4), "flags = 1 (" + tr("vivant", "live") + ")"), ("teal", hexs(rec[16:24]) + " …", tr("16 octets : empreinte du chemin", "16 bytes: path fingerprint"))]
    x = 160
    for col, hx, lab in parts:
        wd = len(hx) * 7.1 + 12
        b.append(R(x, 255, wd, 20, P[col][1], P[col][0], 4, 1.2))
        b.append(T(x + 6, 270, hx, 11, 400, INK, mono=True))
        b.append(T(x + wd / 2, 292, lab, 9.8, 600, P[col][0], "middle"))
        x += wd + 8
    b.append(T(40, 314, tr("elle prouve qu'un numéro de fichier désigne bien le chemin envoyé, sans relire le journal", "it proves a file number really names the path sent, without rereading the journal"), 11.2, 400, INK2, maxw=715))
    # log
    b.append(R(24, 336, 752, 138, "#fff", P["green"][0], 12, 1.6))
    b.append(T(40, 358, ".log  " + tr("— le journal des blocs reçus : on AJOUTE 16 octets par bloc, on ne réécrit rien", "— the log of received chunks: 16 bytes are APPENDED per chunk, nothing is rewritten"), 13, 800, P["green"][0], maxw=715))
    for i, (lg, idx) in enumerate([(log0, 0), (log1, 1)]):
        y = 386 + i * 40
        b.append(T(40, y - 4, tr("bloc %d de ce fichier :" % idx, "chunk %d of this file:" % idx), 11.5, 700, INK2))
        fields = [("blue", hexs(lg[0:4], 4), "id u32 = %d" % fid), ("violet", hexs(lg[4:8], 4), tr("bloc u32 = %d" % idx, "chunk u32 = %d" % idx)),
                  ("amber", hexs(lg[8:12], 4) + " = LUC1", tr("signature", "magic")), ("red", hexs(lg[12:16], 4), "crc32")]
        x = 210
        for col, hx, lab in fields:
            wd = len(hx) * 7.1 + 12
            b.append(R(x, y - 17, wd, 20, P[col][1], P[col][0], 4, 1.2))
            b.append(T(x + 6, y - 2, hx, 11, 400, INK, mono=True))
            b.append(T(x + wd / 2, y + 13, lab, 9.8, 600, P[col][0], "middle"))
            x += wd + 8
    b.append(T(40, 466, tr("un enregistrement n'est ajouté qu'APRÈS le fsync des octets ; queue tronquée ou CRC faux : ignoré (coûte un renvoi).", "a record is appended only AFTER the bytes are fsynced; torn tail or bad CRC: ignored (costs a resend)."), 11.2, 400, INK2, maxw=715))
    b.append(T(400, 494, tr("Avant : réécrire tout le journal à chaque bloc coûtait 40 ms pour 20 000 fichiers ; maintenant : 16 octets ajoutés.", "Before: rewriting the whole journal for each chunk cost 40 ms for 20,000 files; now: 16 bytes appended."), 11.5, 700, INK, "middle", maxw=740))
    save("journal-import.svg", 512, b)


# ── États d'un import et purge ─────────────────────────────────────────────────
def etats_import():
    b = [title(tr("Les états d'un jeu en cours d'import", "The states of a dataset being imported"),
               tr("Ce qu'on peut faire dans chaque état, et ce qui arrive à un import abandonné.", "What you can do in each state, and what happens to an abandoned import."))]
    nodes = [
        ("amber", 24, tr("Envoi — non éditable", "Uploading — not editable"), "uploading", [tr("fichiers du palier ≤ 1", "tier ≤ 1 files"), tr("pas encore tous là", "not all there yet")], [tr("ouvrir : non", "open: no"), tr("éditer : non", "edit: no")]),
        ("blue", 214, tr("Envoi — éditable", "Uploading — editable"), "editable", [tr("metadata + manifeste", "metadata + manifest"), tr("+ niveau grossier", "+ coarse level")], [tr("ouvrir : oui (basse résolution)", "open: yes (low resolution)"), tr("éditer : oui", "edit: yes")]),
        ("green", 404, tr("Envoyé — à publier", "Uploaded — ready to publish"), "staged", [tr("tous les fichiers", "every file"), tr("terminés et vérifiés", "finished and checked")], [tr("vérifier, publier", "validate, publish"), tr("jamais purgé", "never purged")]),
        ("grey", 594, tr("Publié", "Published"), "published", [tr("déplacé dans DATA_WEB/", "moved to DATA_WEB/"), tr("masqué par défaut", "hidden by default")], [tr("journal supprimé", "journal deleted"), tr("(visibilité à activer)", "(visibility to enable)")]),
    ]
    for col, x, hd, code, l1, l2 in nodes:
        s, soft = P[col]
        b.append(R(x, 80, 182, 156, soft, s, 12, 1.8))
        b.append(T(x + 91, 104, hd, 11.4, 800, s, "middle", maxw=170))
        b.append(T(x + 91, 122, code, 11.5, 700, s, "middle", mono=True))
        for j, ln in enumerate(l1):
            b.append(T(x + 12, 148 + j * 17, ln, 11.2, 400, INK, maxw=160))
        for j, ln in enumerate(l2):
            b.append(T(x + 12, 196 + j * 17, ln, 11.2, 700, s, maxw=160))
    for x in (206, 396, 586):
        b.append(L(x, 158, x + 8, 158, INK2, 2.4, arrow=True))
    # stalled / purge
    b.append(R(24, 262, 752, 128, "#fff", P["red"][0], 12, 1.6))
    b.append(T(40, 286, tr("Interrompu (stalled) puis purgé", "Interrupted (stalled), then purged"), 13.5, 800, P["red"][0]))
    for i, s in enumerate([
        tr("• aucun bloc accepté depuis 7 jours (604 800 s) : l'état devient « stalled » (Interrompu) ;", "• no chunk accepted for 7 days (604,800 s): the state becomes “stalled” (Interrupted);"),
        tr("• le nettoyage (à chaque affichage de la liste, ou action gc) efface alors ses fichiers et son journal ;", "• the cleanup (on every list, or the gc action) then deletes its files and journal;"),
        tr("• un jeu « Envoyé — à publier » n'est JAMAIS purgé : c'est du travail fini qui n'attend que votre clic ;", "• a “Uploaded — ready to publish” dataset is NEVER purged: it is finished work waiting for your click;"),
        tr("• reglisser le même dossier relance le compte à rebours : seuls les blocs manquants repartent.", "• dropping the same folder again restarts the clock: only the missing chunks are resent.")]):
        b.append(T(44, 312 + i * 19, s, 11.6, 400, INK, maxw=715))
    b.append(R(24, 404, 752, 52, P["amber"][1], P["amber"][0], 10, 1.4))
    b.append(T(400, 427, tr("« Éditable » = les fichiers de palier ≤ 1 sont terminés ET metadata.json ET (manifeste ou aperçu) sont arrivés.", "“Editable” = tier ≤ 1 files are finished AND metadata.json AND (manifest or preview) have arrived."), 11.5, 700, INK, "middle", maxw=740))
    b.append(T(400, 445, tr("Dès que vous enregistrez une édition, metadata.json est verrouillé (metaLocked) : le transfert ne le réécrit plus.", "As soon as you save an edit, metadata.json is locked (metaLocked): the transfer no longer rewrites it."), 11.5, 400, INK2, "middle", maxw=740))
    save("etats-import.svg", 474, b)


# ── Publier et remplacer ───────────────────────────────────────────────────────
def publication():
    o = real_import()
    carried = o["publish_overwrite"][1].get("carriedKeys", []) if o else []
    b = [title(tr("Publier, et remplacer un jeu déjà publié", "Publishing, and replacing an already published dataset"),
               tr("Tout ou rien : le visiteur voit l'ancien jeu ou le nouveau, jamais un mélange.", "All or nothing: visitors see the old dataset or the new one, never a mix."))]
    steps = [
        ("blue", "1", tr("Valider", "Validate"), [tr("validate_dataset", "validate_dataset"), tr("sinon 409", "else 409"), "validation_failed"]),
        ("violet", "2", tr("Clés curées", "Curated keys"), [tr("si le dossier existe déjà", "if the folder already exists"), tr("et overwrite = true", "and overwrite = true"), tr("(clés absentes du nouveau)", "(keys the new one lacks)")]),
        ("amber", "3", tr("Échanger les dossiers", "Swap the folders"), [tr("ancien → .replaced-<jeu>-<date>", "old → .replaced-<set>-<date>"), tr("nouveau → DATA_WEB/<type>/", "new → DATA_WEB/<type>/"), tr("(deux renommages)", "(two renames)")]),
        ("green", "4", tr("Conclure", "Conclude"), [tr("galerie de l'ancien reprise", "old gallery carried over"), tr(".replaced supprimé", ".replaced deleted"), tr("journal supprimé", "journal deleted")]),
    ]
    w = 178
    for i, (col, n, hd, ls) in enumerate(steps):
        x = 24 + i * (w + 13)
        s, soft = P[col]
        b.append(R(x, 72, w, 124, soft, s, 12, 1.7))
        b.append(CIRC(x + 20, 96, 12, s))
        b.append(T(x + 20, 101, n, 13, 800, "#fff", "middle"))
        b.append(T(x + 38, 101, hd, 12.3, 800, s, maxw=w - 44))
        for j, ln in enumerate(ls):
            b.append(T(x + 10, 128 + j * 19, ln, 10.8, 400, INK, maxw=w - 14))
        if i:
            b.append(L(x - 13, 140, x, 140, INK2, 2, arrow=True))
    # exemple réel
    b.append(R(24, 214, 752, 134, "#fff", LINE, 12))
    b.append(T(40, 238, tr("Un essai réel (moteur d'import, dossier temporaire)", "A real trial (import engine, temporary folder)"), 13.5, 800))
    lines = [
        tr("Avant : le jeu publié a été édité (orientation, galerie, un nom corrigé, hidden = false).", "Before: the published dataset was edited (orientation, gallery, a corrected name, hidden = false)."),
        tr("On reglisse le dossier du pipeline (qui contient son propre nom) puis : Publier → 409 already_exists.", "The pipeline folder (which carries its own name) is dropped again, then: Publish → 409 already_exists."),
        tr("Remplacer → carriedKeys = [" + ", ".join(carried) + "], carriedGallery = true,", "Replace → carriedKeys = [" + ", ".join(carried) + "], carriedGallery = true,"),
        tr("mais le nom revient à celui du pipeline : le nouveau fichier l'énonce, il gagne.", "but the name goes back to the pipeline's: the new file states it, so it wins."),
        tr("formatVersion vaut 4 (celui du nouveau), jamais l'ancien chiffre.", "formatVersion is 4 (the new one), never the old figure."),
    ]
    for i, s in enumerate(lines):
        b.append(T(44, 262 + i * 17, s, 11.4, 400 if i != 2 else 700, INK, maxw=715, mono=False))
    b.append(R(24, 364, 752, 96, P["amber"][1], P["amber"][0], 12, 1.5))
    b.append(T(40, 388, tr("Et si le serveur s'arrête au milieu ?", "And if the server stops in the middle?"), 13, 800, P["amber"][0]))
    for i, s in enumerate([
        tr("Au démarrage suivant, recover_publish_leftovers() règle ce qui reste dans DATA_WEB/<type>/ :", "At the next start, recover_publish_leftovers() settles what remains in DATA_WEB/<type>/:"),
        tr("• .replaced-<jeu>-… sans le dossier <jeu> : la panne était entre les deux renommages → l'ancien est remis en place ;", "• .replaced-<set>-… without the <set> folder: the crash was between the two renames → the old one is put back;"),
        tr("• .replaced-<jeu>-… avec <jeu> : supprimé ; .incoming-<jeu>-… (copie partielle entre disques) : toujours supprimé.", "• .replaced-<set>-… with <set>: deleted; .incoming-<set>-… (partial cross-volume copy): always deleted.")]):
        b.append(T(44, 410 + i * 18, s, 11.3, 400, INK, maxw=715))
    save("publication.svg", 478, b)


def run():
    import_flux()
    liste_blanche()
    paliers()
    bloc()
    journal_import()
    etats_import()
    publication()
