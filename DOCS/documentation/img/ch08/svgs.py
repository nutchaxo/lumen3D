"""Schémas SVG du chapitre 8 (générés ; appelé par make_figures.py). Les textes sont en paires fr/en."""
import os
from pathlib import Path

LANG = os.environ.get("FIG_LANG", "fr")
OUT = Path(os.environ.get("IMG_DIR", Path(__file__).resolve().parent))


def tr(fr, en):
    return fr if LANG == "fr" else en


INK, INK2, LINE = "#1c2333", "#4a5468", "#c5cbd8"
P = {"blue": ("#3b5bdb", "#e8edff"), "green": ("#2b8a3e", "#ebfbee"), "amber": ("#e67700", "#fff4e6"),
     "violet": ("#7048e8", "#f3f0ff"), "teal": ("#0c8599", "#e3fafc"), "red": ("#c92a2a", "#fff0f0"),
     "grey": ("#868e96", "#f1f3f5")}
HEAD = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 {h}" font-family="Inter, sans-serif">'
        '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
        '<path d="M0,0 L10,5 L0,10 z" fill="#4a5468"/></marker></defs>'
        '<rect width="800" height="{h}" rx="16" fill="#f8f9fd"/>')


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;")


def text(x, y, s, size=13, weight=400, fill=INK, anchor="start", style=""):
    return f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}" {style}>{esc(s)}</text>'


def title(s):
    return text(400, 34, s, 18, 800, anchor="middle")


def rect(x, y, w, h, fill="#fff", stroke=LINE, rx=0, sw=1, extra=""):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}" {extra}/>'


def arrow(x1, y1, x2, y2, w=2.4):
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{INK2}" stroke-width="{w}" marker-end="url(#arr)"/>'


def box(x, y, w, h, col, lines, head=None):
    st, so = P[col]
    out = [rect(x, y, w, h, so, st, 12, 1.6)]
    yy = y + 24
    if head:
        out.append(text(x + w / 2, yy, head, 13.5, 800, st, "middle"))
        yy += 20
    for i, l in enumerate(lines):
        out.append(text(x + w / 2, yy + i * 17, l, 12, 400, INK, "middle"))
    return out


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


def sources():
    b = [title(tr("Où le pipeline va chercher le suivi cellulaire (par ordre de priorité)", "Where the pipeline looks for cell tracking (in priority order)"))]
    src = [("1", ".imaris_track", tr("à côté du fichier .ims", "next to the .ims file"), tr("le plus complet", "the most complete"), "green"),
           ("2", tr("Scene8 dans le .ims", "Scene8 inside the .ims"), tr("objets Spots / Tracks d'Imaris", "Imaris Spots / Tracks objects"), tr("sans fichier en plus", "no extra file"), "blue"),
           ("3", tr("classeur Excel", "Excel workbook"), tr(".xls / .xlsx exporté d'Imaris", ".xls / .xlsx exported from Imaris"), tr("peut être périmé", "may be out of date"), "amber")]
    for i, (n, name, d1, d2, col) in enumerate(src):
        y = 62 + i * 82
        st, so = P[col]
        b += [rect(30, y, 250, 68, so, st, 12, 1.6), text(52, y + 30, n, 24, 800, st), text(84, y + 28, name, 14, 800, st),
              text(84, y + 46, d1, 12, 400, INK), text(84, y + 62, d2, 11.5, 400, INK2, style='font-style="italic"')]
        b.append(arrow(282, y + 34, 330, 160 if i != 1 else 160))
    b += box(335, 112, 190, 96, "violet", [tr("identité des cellules,", "cell identity,"), tr("lignées, stabilisation", "lineages, stabilisation")], tr("Analysis.py du labo", "the lab's Analysis.py"))
    b.append(arrow(527, 160, 572, 160))
    outs = [("tracks.json", tr("cellules, positions, lignées", "cells, positions, lineages"), "teal"),
            ("model.glb", tr("surface 3D de l'embryon", "3D surface of the embryo"), "teal"),
            ("metadata.json", tr("blocs tracking + registration", "tracking + registration blocks"), "teal")]
    for i, (n, d, col) in enumerate(outs):
        y = 66 + i * 66
        b += [rect(575, y, 200, 56, P[col][1], P[col][0], 10, 1.5), text(675, y + 24, n, 13.5, 800, P[col][0], "middle"), text(675, y + 43, d, 11.5, 400, INK, "middle")]
    b.append(text(400, 328, tr("Le suivi n'est cherché que pour une série temporelle ; s'il échoue, le volume est publié quand même.",
                              "Tracking is only looked for in a time series; if it fails, the volume is still published."), 12, 400, INK2, "middle", 'font-style="italic"'))
    save("sources-suivi.svg", 348, b)


def rigide():
    b = [title(tr("Un mouvement rigide : tourner et glisser, sans déformer", "A rigid motion: rotate and slide, without deforming"))]
    import math
    pts = [(0, 0), (60, 10), (90, 60), (30, 90), (-10, 50)]

    def poly(ox, oy, ang, col, fill):
        a = math.radians(ang)
        q = [(ox + x * math.cos(a) - y * math.sin(a), oy + x * math.sin(a) + y * math.cos(a)) for x, y in pts]
        s = "".join(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="6" fill="{col}"/>' for x, y in q)
        s += '<polygon points="' + " ".join(f"{x:.1f},{y:.1f}" for x, y in q) + f'" fill="{fill}" fill-opacity=".35" stroke="{col}" stroke-width="1.6"/>'
        return s
    b.append(rect(30, 60, 220, 200, "#fff", LINE, 12))
    b.append(poly(95, 110, 0, P["blue"][0], "#b2c8ff"))
    b.append(text(140, 285, tr("Image 1 : position de référence", "Frame 1: the reference position"), 12.5, 700, P["blue"][0], "middle"))
    b.append(rect(290, 60, 220, 200, "#fff", LINE, 12))
    b.append(poly(380, 98, 28, P["amber"][0], "#ffd8a8"))
    b.append(text(400, 285, tr("Image 4 : l'embryon a bougé", "Frame 4: the embryo moved"), 12.5, 700, P["amber"][0], "middle"))
    b.append(arrow(252, 160, 288, 160))
    b.append(arrow(512, 160, 548, 160))
    b.append(rect(550, 60, 220, 200, "#fff", LINE, 12))
    b.append(poly(615, 110, 0, P["blue"][0], "#b2c8ff"))
    b.append(poly(615, 110, 0, P["green"][0], "#b2f2bb").replace('r="6"', 'r="3.2"'))
    b.append(text(660, 285, tr("On défait le mouvement : superposé", "We undo the motion: superposed"), 12.5, 700, P["green"][0], "middle"))
    b.append(text(400, 328, tr("Les distances entre points ne changent pas : c'est ce qui permet d'appliquer la même transformation aux images.",
                              "Distances between points do not change: that is what lets the same transformation be applied to the images."), 12, 400, INK2, "middle", 'font-style="italic"'))
    save("rigide.svg", 348, b)


def publication():
    b = [title(tr("Publication « tout ou rien » : on ne change la vitrine que quand la nouvelle est prête", "“All or nothing” publication: the shop window changes only when the new one is ready"))]
    steps = [("1", tr("Construire", "Build"), [tr("tout est fabriqué", "everything is built"), tr("dans un dossier privé", "in a private folder")], "blue"),
             ("2", tr("Mettre de côté", "Set aside"), [tr("marqueur posé,", "marker written,"), tr("anciens → .pre-swap", "old → .pre-swap")], "amber"),
             ("3", tr("Installer", "Install"), [tr("nouveaux bricks/,", "new bricks/,"), tr("planes/, mips/…", "planes/, mips/…")], "violet"),
             ("4", tr("Valider", "Commit"), [tr("metadata.json écrit", "metadata.json written"), tr("EN DERNIER", "LAST")], "red"),
             ("5", tr("Nettoyer", "Clean up"), [tr("marqueur et .pre-swap", "marker and .pre-swap"), tr("supprimés", "removed")], "green")]
    for i, (n, t, lines, col) in enumerate(steps):
        x = 24 + i * 156
        st, so = P[col]
        b += [rect(x, 70, 142, 110, so, st, 12, 2), text(x + 71, 98, f"{n} · {t}", 13.5, 800, st, "middle")]
        for j, l in enumerate(lines):
            b.append(text(x + 71, 128 + j * 18, l, 11.5, 400, INK, "middle"))
        if i < 4:
            b.append(arrow(x + 144, 125, x + 154, 125, 2))
    b.append(rect(24, 202, 752, 112, "#fff", LINE, 12))
    msgs = [(tr("Échec AVANT l'étape 4 : tout est remis comme avant ; le jeu de données publié n'a jamais cessé de fonctionner.",
                "Failure BEFORE step 4: everything is put back; the published dataset never stopped working."), 700, INK),
            (tr("Plantage en plein milieu : au lancement suivant, le marqueur permet de finir ou d'annuler proprement,",
                "Crash in the middle: at the next launch, the marker lets the pipeline finish or undo cleanly,"), 400, INK2),
            (tr("selon que metadata.json (dont l'empreinte sha256 est dans le marqueur) est déjà en place ou non.",
                "depending on whether metadata.json (its sha256 is stored in the marker) is already in place."), 400, INK2)]
    yy = 232
    for m, wt, colr in msgs:
        for ln in wrap(m, 112):
            b.append(text(40, yy, ln, 12, wt, colr)); yy += 19
        yy += 6
    save("publication.svg", 332, b)


def parcours():
    b = [title(tr("De votre ordinateur au site : deux routes", "From your computer to the site: two routes"))]
    b += box(24, 80, 170, 100, "blue", [tr("dossier input\\", "input\\ folder"), tr("fichiers .ims", ".ims files")], tr("1 · Vous déposez", "1 · You drop"))
    b.append(arrow(196, 130, 236, 130))
    b += box(240, 80, 170, 100, "green", [tr("menu [1] du", "menu [1] of"), "RUN.bat"], tr("2 · Vous lancez", "2 · You run"))
    b.append(arrow(412, 130, 452, 130))
    b += box(456, 80, 150, 100, "amber", [tr("dossier output\\", "output\\ folder"), tr("3d\\ ou live\\", "3d\\ or live\\")], tr("3 · Résultat", "3 · Result"))
    b.append(arrow(608, 105, 640, 70))
    b.append(arrow(608, 155, 640, 200))
    b += box(642, 40, 140, 66, "violet", [tr("copie FTP dans", "FTP copy into"), "DATA_WEB/"], tr("Route A", "Route A"))
    b += box(642, 172, 140, 66, "teal", [tr("glisser dans l'onglet", "drag into the tab"), tr("Import (navigateur)", "Import (browser)")], tr("Route B", "Route B"))
    b.append(text(400, 290, tr("Dans les deux cas, le jeu de données apparaît dans le catalogue sans rien régénérer.", "Either way, the dataset appears in the catalogue with nothing to regenerate."), 12.5, 400, INK2, "middle", 'font-style="italic"'))
    save("parcours-pipeline.svg", 312, b)


def build():
    for f in (sources, rigide, publication, parcours):
        f()


if __name__ == "__main__":
    build()
