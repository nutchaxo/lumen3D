#!/usr/bin/env python3
"""Figures of format 5 (resolution x compression matrix, SPEC Part III).

  FIG_LANG=fr|en   language of the texts drawn in the figures (default fr)
  IMG_DIR=<dir>    output folder (default: the folder of this script)
  DATASET=<dir>    a format-5 demonstration dataset (default DATA_WEB/3d/Embryo-E95-Em2-Pecam1-Sox2)
Regenerate the English set:
  FIG_LANG=en IMG_DIR=DOCS/documentation/img-en/f5 python3 DOCS/documentation/img/f5/make_figures.py
Every data figure is computed with format5.py, the module the migration and the pipeline share.
"""
import os, sys, json, html, pathlib
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

LANG = os.environ.get("FIG_LANG", "fr")
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(ROOT))
import format5 as f5

OUT = pathlib.Path(os.environ.get("IMG_DIR", HERE)); OUT.mkdir(parents=True, exist_ok=True)
DS = pathlib.Path(os.environ.get("DATASET", ROOT / "DATA_WEB/3d/Embryo-E95-Em2-Pecam1-Sox2"))
plt.rcParams["font.family"] = "Inter"
FR = LANG == "fr"
def T(fr, en): return fr if FR else en
def num(x, nd=0):
    s = f"{x:,.{nd}f}"
    return s.replace(",", " ").replace(".", ",") if FR else s
INK, INK2, LINE, BG = "#1c2333", "#4a5468", "#c5cbd8", "#f8f9fd"
ACC = {"blue": ("#3b5bdb", "#e8edff"), "green": ("#2b8a3e", "#ebfbee"), "amber": ("#e67700", "#fff4e6"),
       "violet": ("#7048e8", "#f3f0ff"), "teal": ("#0c8599", "#e3fafc"), "red": ("#c92a2a", "#fff0f0"), "grey": ("#868e96", "#f1f3f5")}

class Svg:
    def __init__(s, h, title=None, w=800):
        s.w, s.h, s.p = w, h, []
        s.p.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" font-family="Inter, sans-serif">'
                   '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
                   f'<path d="M0,0 L10,5 L0,10 z" fill="{INK2}"/></marker></defs>')
        s.p.append(f'<rect width="{w}" height="{h}" rx="16" fill="{BG}"/>')
        if title: s.text(w / 2, 34, title, 18, 800, INK, "middle")
    def add(s, x): s.p.append(x)
    def rect(s, x, y, w, h, fill="#fff", stroke=LINE, rx=10, sw=1.2, extra=""):
        s.p.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}" {extra}/>')
    def text(s, x, y, t, size=13, w=400, fill=INK, anchor="start", extra=""):
        s.p.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{w}" fill="{fill}" text-anchor="{anchor}" {extra}>{html.escape(str(t), quote=False)}</text>')
    def line(s, x1, y1, x2, y2, stroke=INK2, sw=2, arrow=False, dash=None):
        a = ' marker-end="url(#arr)"' if arrow else ""
        d = f' stroke-dasharray="{dash}"' if dash else ""
        s.p.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{stroke}" stroke-width="{sw}"{a}{d}/>')
    def save(s, name):
        (OUT / name).write_text("\n".join(s.p) + "\n</svg>\n", encoding="utf-8")

# ------------------------------------------------------------------ data
def load_plane(z):
    data = (DS / "planes" / f"z{z:05d}.bin").read_bytes()
    _z, C, tx, ty, ent = f5.parse_plane_pack(data)
    m = json.loads((DS / "metadata.json").read_text())
    return data, C, tx, ty, ent

def volume(channel=0):
    meta = json.loads((DS / "bricks/manifest.json").read_text())
    d = meta["levels"][0]["dimensions"]; X, Y, Z = d["x"], d["y"], d["z"]
    vol = np.zeros((Z, Y, X), np.uint8)
    for z in range(Z):
        data, C, tx, ty, ent = load_plane(z)
        for t in range(tx * ty):
            off, ln = ent[channel * tx * ty + t]
            if not ln: continue
            tile = f5.unpng_gray8(data[off:off + ln])
            yy, xx = (t // tx) * f5.TILE, (t % tx) * f5.TILE
            vol[z, yy:yy + tile.shape[0], xx:xx + tile.shape[1]] = tile
    return vol, meta

# ------------------------------------------------------------------ figures
def fig_ladder(meta5):
    """Format 4 vs format 5 levels of the demonstration dataset (real dimensions)."""
    f4 = [(768, 576, 112, 1.2, 3.0), (384, 288, 56, 2.4, 6.0), (192, 144, 28, 4.8, 12.0), (96, 72, 14, 9.6, 24.0)]
    f5l = [(L["dimensions"]["x"], L["dimensions"]["y"], L["dimensions"]["z"], L["voxelSize"]["x"], L["voxelSize"]["z"], L["target"]) for L in meta5["levels"]]
    s = Svg(420, T("Les niveaux du jeu de démonstration : format 4 et format 5", "The levels of the demonstration dataset: format 4 and format 5"))
    def col(x0, title, sub, rows, colr, f5style):
        st, so = ACC[colr]
        s.text(x0 + 170, 70, title, 15, 800, st, "middle"); s.text(x0 + 170, 89, sub, 11.5, 500, INK2, "middle")
        y = 108
        for r in rows:
            X, Y, Z, vx, vz = r[:5]
            w = max(170, 300 * X / 768); h = 40 + 14 * Z / 112
            s.rect(x0 + 170 - w / 2, y, w, h, so, st, 6, 1.5)
            lab = (T("natif", "native") if (len(r) > 5 and r[5] == "native") or X == 768 else str(r[5]) if len(r) > 5 else "")
            s.text(x0 + 170, y + h / 2 + 1, f"{X} × {Y} × {Z}", 12.5, 700, INK, "middle")
            s.text(x0 + 170, y + h / 2 + 15, f"{num(vx,1)} × {num(vx,1)} × {num(vz,1)} µm", 10, 500, INK2, "middle")
            if len(r) > 5: s.text(x0 + 170 - w / 2 - 8, y + h / 2 + 5, lab, 12, 800, st, "end")
            y += h + 10
    col(30, T("Format 4", "Format 4"), T("X, Y divisés par 2 ; Z aussi tant que le voxel reste ≈ cubique", "X, Y halved; Z too while the voxel stays ≈ cubic"), f4, "grey", False)
    col(430, T("Format 5", "Format 5"), T("le grand côté vaut 512 puis 256 ; toutes les tranches gardées", "the long side is 512 then 256; every slice kept"), f5l, "blue", True)
    s.text(400, 400, T("Les mêmes 112 tranches dans chaque niveau du format 5 : la profondeur ne perd jamais de détail.",
                       "The same 112 slices in every level of format 5: depth never loses detail."), 11.5, 600, INK2, "middle")
    s.save("niveaux.svg")

def fig_columns(vol):
    """One real brick in the five columns: middle slice, size, error."""
    Z, Y, X = vol.shape
    best, pos = -1, None
    for bz in range(-(-Z // 64)):
        for by in range(-(-Y // 64)):
            for bx in range(-(-X // 64)):
                n = int(np.count_nonzero(vol[bz*64:(bz+1)*64, by*64:(by+1)*64, bx*64:(bx+1)*64] > 20))
                if n > best: best, pos = n, (bx, by, bz)
    bx, by, bz = pos
    b66 = f5.brick_with_apron(vol, bx, by, bz)
    known = {}
    enc = {c: f5.encode_brick(b66, c, known) for c in f5.COLUMN_IDS}
    dec = {c: f5.decode_brick(enc[c], c) for c in f5.COLUMN_IDS}
    src = b66.astype(int)
    zmid = 33
    names = {"ll": T("Sans perte", "Lossless"), "b2": "±2", "b4": "±4", "q80": T("Légère (WebP 80)", "Light (WebP 80)"), "q50": T("Très légère (WebP 50)", "Very light (WebP 50)")}
    fig, ax = plt.subplots(2, 5, figsize=(12, 5.6), gridspec_kw=dict(hspace=0.32, wspace=0.06, left=0.01, right=0.99, top=0.86, bottom=0.04))
    stats = {}
    for j, c in enumerate(f5.COLUMN_IDS):
        d = dec[c].astype(int)
        err = np.abs(d - src)[1:-1, 1:-1, 1:-1]
        stats[c] = dict(kb=len(enc[c]) / 1024, maxerr=int(err.max()), changed=float((err > 0).mean() * 100),
                        tail=int(enc[c][-1]) if c in ("q80", "q50") else None)
        sl = dec[c][zmid]
        ax[0, j].imshow(sl, cmap="gray", vmin=0, vmax=max(1, int(src.max())), interpolation="nearest"); ax[0, j].axis("off")
        ax[0, j].set_title(f"{names[c]}\n{num(stats[c]['kb'],1)} {T('Ko', 'KB')} · {T('écart max', 'max error')} {stats[c]['maxerr']}", fontsize=9.5, color=INK)
        ax[1, j].imshow(np.abs(d[zmid] - src[zmid]), cmap="magma", vmin=0, vmax=16, interpolation="nearest"); ax[1, j].axis("off")
        ax[1, j].set_title(T(f"écart (×16) · {num(stats[c]['changed'],1)} % des voxels modifiés", f"error (×16) · {num(stats[c]['changed'],1)} % of voxels changed"), fontsize=8.5, color=INK2)
    fig.suptitle(T(f"Une vraie brique du jeu de démonstration (canal DAPI, 66³ voxels) dans les cinq compressions — tranche du milieu",
                   f"A real brick of the demonstration dataset (DAPI channel, 66³ voxels) in the five compressions — middle slice"), fontsize=11, color=INK)
    fig.savefig(OUT / "colonnes.png", dpi=160, facecolor="white"); plt.close(fig)
    return dict(brick=pos, stats=stats)

def deadzone_stats(vol, q=50):
    """Over every stored level-0 brick: zero voxels the lossy image makes non-zero, before and after the dead zone."""
    Z, Y, X = vol.shape
    nz = bef = aft = 0; taus = []; stored = {"lossy": 0, "b4": 0, "ll": 0}
    for bz in range(-(-Z // 64)):
        for by in range(-(-Y // 64)):
            for bx in range(-(-X // 64)):
                b66 = f5.brick_with_apron(vol, bx, by, bz)
                if not f5.brick_kept(b66): continue
                raw = f5._webp(f5.mosaic80(b66), quality=q, method=f5.WEBP_LOSSY_METHOD)
                d0 = f5.unmosaic80(f5._unwebp(raw)); tau = f5.dead_zone(b66, d0); taus.append(tau)
                z0 = b66[1:-1, 1:-1, 1:-1] == 0
                nz += int(z0.sum()); bef += int((d0[1:-1, 1:-1, 1:-1][z0] > 0).sum())
                aft += int((f5.apply_dead_zone(d0, tau)[1:-1, 1:-1, 1:-1][z0] > 0).sum())
                tag = f5.encode_brick(b66, "q%d" % q)[-1]
                stored["ll" if tag == f5.TAG_LL else "b4" if tag == f5.TAG_B4 else "lossy"] += 1
    return dict(zero_voxels=nz, before_pct=100 * bef / nz, after_pct=100 * aft / nz, tau_hist=np.bincount(taus).tolist(), stored=stored)

def fig_quantizer():
    idx, val = f5.quantizer(2)
    s = Svg(250, T("La colonne ±2 : des « casiers » de 5 valeurs, chacun lu à son centre", "The ±2 column: \"bins\" of 5 values, each read at its centre"))
    x0, cw, y = 30, 29.5, 76
    s.text(x0, y - 10, T("valeur d'origine", "original value"), 12, 700, INK)
    cols = ["#e8edff", "#fff4e6"]
    for v in range(0, 25):
        k = int(idx[v]); fill = "#1c2333" if v == 0 else cols[k % 2]
        s.rect(x0 + v * cw, y, cw - 2, 28, fill, LINE, 4, 1)
        s.text(x0 + v * cw + (cw - 2) / 2, y + 19, v, 11.5, 700, "#fff" if v == 0 else INK, "middle")
    s.text(x0 + 25 * cw + 4, y + 19, "…", 14, 700, INK)
    y2 = 150
    s.text(x0, y2 - 10, T("ce que le viewer affiche", "what the viewer shows"), 12, 700, INK)
    for v in range(0, 25):
        k = int(idx[v]); fill = "#1c2333" if v == 0 else cols[k % 2]
        s.rect(x0 + v * cw, y2, cw - 2, 28, fill, LINE, 4, 1)
        s.text(x0 + v * cw + (cw - 2) / 2, y2 + 19, int(val[k]), 11.5, 800, "#fff" if v == 0 else ACC["blue"][0] if k % 2 == 0 else ACC["amber"][0], "middle")
        s.line(x0 + v * cw + (cw - 2) / 2, y + 30, x0 + v * cw + (cw - 2) / 2, y2 - 2, LINE, 1)
    s.text(400, 208, T("0 reste seul : le fond reste exactement noir. Toute autre valeur bouge de 2 au plus.",
                       "0 stays alone: the background stays exactly black. Any other value moves by 2 at most."), 12, 600, INK2, "middle")
    s.text(400, 228, T("Les numéros de casier se compressent sans perte, bien mieux que les valeurs elles-mêmes.",
                       "The bin numbers compress losslessly, much better than the values themselves."), 12, 600, INK2, "middle")
    s.save("quantif.svg")

def fig_grid80():
    s = Svg(300, T("Pourquoi les colonnes légères rangent les tranches tous les 80 pixels", "Why the light columns place the slices every 80 pixels"))
    def panel(x0, title, pitch, sub, ok):
        st = ACC["red"][0] if not ok else ACC["green"][0]
        s.text(x0 + 165, 66, title, 14, 800, INK, "middle"); s.text(x0 + 165, 84, sub, 11, 500, INK2, "middle")
        scale = 1.55; ox, oy = x0 + 20, 100
        # two neighbouring slices
        for k in range(2):
            left = ox + k * pitch * scale + (pitch - 66) / 2 * scale
            s.rect(left, oy + (pitch - 66) / 2 * scale, 66 * scale, 66 * scale, ["#d0bfff", "#99e9f2"][k], "none", 0, 0)
        # 16-px WebP blocks
        for gx in range(0, int(2 * pitch) + 1, 16):
            s.line(ox + gx * scale, oy, ox + gx * scale, oy + pitch * scale, "#495057", 1, dash="3,3")
        if not ok:
            s.rect(ox + 64 * scale, oy - 3, 16 * scale, pitch * scale + 6, "none", ACC["red"][0], 2, 2.5)
        s.text(ox + 4, oy + pitch * scale + 18, T("pointillés : blocs WebP de 16 pixels", "dotted: 16-pixel WebP blocks"), 10.5, 500, INK2)
        bad = [gx for gx in range(0, int(2 * pitch), 16) if gx < pitch * 1 < gx + 16 and pitch % 16]
        s.text(x0 + 165, oy + pitch * scale + 42, T("un bloc chevauche deux tranches : elles se mélangent", "a block straddles two slices: they bleed") if not ok
               else T("chaque bloc reste dans une seule tranche (+ 7 px de marge)", "every block stays inside one slice (+ 7 px margin)"), 12, 700, st, "middle")
    panel(20, T("Avec perte au pas de 66 (non retenu)", "Lossy on a 66 pitch (not used)"), 66, T("les tranches se touchent ; encadré : le bloc 64–80", "the slices touch; framed: block 64–80"), False)
    panel(410, T("Avec perte : pas de 80", "Lossy: pitch 80"), 80, T("66 pixels utiles centrés dans 80", "66 useful pixels centred in 80"), True)
    s.save("grille80.svg")

def fig_cuts(meta5):
    s = Svg(470, T("Trois copies de plus pour couper vite, à chaque niveau", "Three extra copies for fast cuts, at every level"))
    cards = [("blue", T("Coupe XY", "XY cut"), T("un plan entier, déjà prêt", "a whole plane, ready-made"), "xy/ · planes/", T("1 fichier", "1 file")),
             ("green", T("Coupe XZ / YZ", "XZ / YZ cut"), T("une ligne de 64 coupes recoupées", "one row of 64 re-cut slices"), "xz/ · yz/", T("3 lectures par canal", "3 reads per channel")),
             ("violet", T("Coupe oblique", "Oblique cut"), T("petites briques de 32 × 32 × bz", "small bricks of 32 × 32 × bz"), "cuts/", T("≈ 4 à 6 voxels lus par pixel", "≈ 4–6 voxels read per pixel"))]
    for i, (c, a, b, d, e) in enumerate(cards):
        x = 30 + i * 252; st, so = ACC[c]
        s.rect(x, 60, 236, 150, so, st, 14, 1.6)
        s.text(x + 118, 92, a, 16, 800, st, "middle"); s.text(x + 118, 120, b, 12, 500, INK, "middle")
        s.text(x + 118, 150, d, 12.5, 700, INK2, "middle", 'font-family="monospace"'); s.text(x + 118, 186, e, 12.5, 800, st, "middle")
    s.text(400, 246, T("Voxels lus pour chaque pixel d'une coupe native (simulation sur un embryon de 5735² × 178)", "Voxels read per pixel of a native cut (simulated on a 5735² × 178 embryo)"), 13, 700, INK, "middle")
    rows = [("XY", 64.5, 1.0), ("XZ", 8.0, 3.8), (T("incliné 30°", "tilted 30°"), 59.7, 8.8), ("(1,1,1)", 44.5, 8.8)]
    for i, (lab, a, b) in enumerate(rows):
        y = 266 + i * 46
        s.text(130, y + 22, lab, 12.5, 700, INK, "end")
        wa = 560 * a / 65; wb = 560 * b / 65
        s.rect(140, y + 4, wa, 16, ACC["grey"][1], ACC["grey"][0], 3, 1); s.text(140 + wa + 6, y + 17, f"{num(a,1)} {T('(briques 64³)', '(64³ bricks)')}", 11, 600, INK2)
        s.rect(140, y + 23, max(wb, 2), 16, ACC["blue"][1], ACC["blue"][0], 3, 1); s.text(140 + max(wb, 2) + 6, y + 36, f"{num(b,1)} {T('(copies de coupe)', '(cut copies)')}", 11, 700, ACC["blue"][0])
    s.text(400, 458, T("XY : la copie par plans en lit exactement 1. Chiffres : SPEC § 14.5.", "XY: the plane copy reads exactly 1. Figures: SPEC § 14.5."), 10.5, 500, INK2, "middle")
    s.save("coupes.svg")

def fig_tree():
    def du(p):
        tot = 0
        for f in p.rglob("*"):
            if f.is_file(): tot += f.stat().st_size
        return tot / 1e6
    b = DS / "bricks"
    rows = [("bricks/index/", T("un index par compression", "one index per compression"), du(b / "index")),
            ("bricks/l0/ll  b2  b4  q80  q50/", T("niveau natif, cinq compressions", "native level, five compressions"), du(b / "l0")),
            ("bricks/l1/…  l2/…", T("niveaux 512 et 256, cinq compressions", "levels 512 and 256, five compressions"), du(b / "l1") + du(b / "l2")),
            ("bricks/xy/", T("plans XY des niveaux réduits", "XY planes of the reduced levels"), du(b / "xy")),
            ("bricks/xz/  bricks/yz/", T("coupes XZ et YZ recoupées", "re-cut XZ and YZ slices"), du(b / "xz") + du(b / "yz")),
            ("bricks/cuts/", T("petites briques des coupes obliques", "small bricks of oblique cuts"), du(b / "cuts")),
            ("planes/  mips/", T("inchangés (niveau natif)", "unchanged (native level)"), du(DS / "planes") + du(DS / "mips"))]
    s = Svg(110 + 44 * len(rows), T("Le dossier d'un jeu au format 5 (jeu de démonstration, tailles réelles)", "The folder of a format-5 dataset (demonstration dataset, real sizes)"))
    mx = max(r[2] for r in rows)
    for i, (p, d, mb) in enumerate(rows):
        y = 62 + i * 44
        s.text(30, y + 18, p, 12.5, 700, INK, extra='font-family="monospace"')
        s.text(30, y + 35, d, 11, 500, INK2)
        w = 230 * mb / mx
        s.rect(500, y + 10, max(w, 2), 18, ACC["blue"][1], ACC["blue"][0], 3, 1)
        s.text(500 + max(w, 2) + 8, y + 24, f"{num(mb,1)} {T('Mo', 'MB')}", 11.5, 700, INK)
    s.text(400, 62 + 44 * len(rows) + 24, T("Format 4 du même jeu : 9 Mo de briques. Le disque est dépensé ; le réseau et la carte graphique, non.",
                                           "Format 4 of the same dataset: 9 MB of bricks. Disk is spent; network and graphics memory are not."), 11.5, 600, INK2, "middle")
    s.save("arbre.svg")
    return {r[0]: round(r[2], 1) for r in rows}

if __name__ == "__main__":
    vol, meta5 = volume(0)
    fig_ladder(meta5); fig_quantizer(); fig_grid80(); fig_cuts(meta5)
    print("tree", fig_tree())
    print("columns", fig_columns(vol))
    if os.environ.get("DEADZONE"): print("deadzone", deadzone_stats(vol))
