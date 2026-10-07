#!/usr/bin/env python3
"""Figures du chapitre 7 (briques), tirées du jeu de démonstration réel.

    python make_figures.py                      # français -> img/ch07
    FIG_LANG=en IMG_DIR=DOCS/documentation/img-en/ch07 python make_figures.py

Toutes les images viennent du dossier publié DATA_WEB/3d/Embryo-E95-Em2-Pecam1-Sox2
(jeu de démonstration synthétique), décodé avec les fonctions du pipeline.
"""
import io
import os
import struct
import sys
from pathlib import Path

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.patches import Rectangle
from PIL import Image

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "preprocess"))
import bricks_v3_writer as b3  # noqa: E402

LANG = os.environ.get("FIG_LANG", "fr")
OUT = Path(os.environ.get("IMG_DIR", Path(__file__).resolve().parent))
OUT.mkdir(parents=True, exist_ok=True)
DS = ROOT / "DATA_WEB/3d/Embryo-E95-Em2-Pecam1-Sox2"

for f in font_manager.findSystemFonts():
    if "/inter/Inter-" in f or "Inter-" in Path(f).name:
        font_manager.fontManager.addfont(f)
plt.rcParams.update({"font.family": ["Inter", "DejaVu Sans"], "font.size": 11,
                     "axes.edgecolor": "#c5cbd8", "axes.labelcolor": "#1c2333",
                     "text.color": "#1c2333", "xtick.color": "#4a5468", "ytick.color": "#4a5468"})
INK, INK2 = "#1c2333", "#4a5468"
BLUE, GREEN, AMBER, VIOLET, TEAL, RED = "#3b5bdb", "#2b8a3e", "#e67700", "#7048e8", "#0c8599", "#c92a2a"

T = {
    "fr": {
        "seam_a": "Sans bordure : un palier au bord de la brique",
        "seam_b": "Avec bordure : une transition continue",
        "seam_prof": "Profil d'intensité le long de la ligne blanche",
        "seam_x": "position en x (voxels)", "seam_y": "intensité (0-255)",
        "limit": "limite entre deux briques",
        "no_border": "sans bordure", "border": "avec bordure",
        "mosaic_t": "La brique (7, 5, 0) du canal Sox2, niveau 0 : l'image WebP stockée",
        "slice": "coupe", "cut_t": "La même brique, en 3D",
        "face_top": "coupe z' = 65", "face_front": "face avant", "face_side": "face latérale",
        "ch": ["DAPI", "Pecam1", "Sox2"], "ch_t": "Une image par canal : la même brique (7, 5, 0)",
        "lvl_t": "La grille de briques de chaque niveau (couche z = 0, canal Pecam1)",
        "lvl": "niveau", "stored": "brique stockée", "empty": "brique absente (vide)",
        "pk_t": "Quelles briques dans quel paquet ? (niveau 0, canal Pecam1)",
        "layer": "couche de briques", "pack": "paquet", "absent": "vide",
        "pl_t": "Octets à lire pour afficher la coupe XY z = 30 en pleine résolution",
        "pl_bricks": "via les briques\n(toute la couche z de 0 à 63)", "pl_planes": "via planes/\n(le seul plan z = 30)",
        "pl_y": "kilo-octets lus (3 canaux)",
        "mip_t": "Une coupe, et le maximum d'une couche de 64 plans (canal DAPI)",
        "mip_a": "plan z = 30", "mip_b": "MIP de la couche 0 (z 0 à 63)",
    },
    "en": {
        "seam_a": "No border: a step at the brick edge",
        "seam_b": "With border: a continuous transition",
        "seam_prof": "Intensity profile along the white line",
        "seam_x": "x position (voxels)", "seam_y": "intensity (0-255)",
        "limit": "limit between two bricks",
        "no_border": "no border", "border": "with border",
        "mosaic_t": "Brick (7, 5, 0) of the Sox2 channel, level 0: the stored WebP image",
        "slice": "slice", "cut_t": "The same brick, in 3D",
        "face_top": "slice z' = 0", "face_front": "front face", "face_side": "side face",
        "ch": ["DAPI", "Pecam1", "Sox2"], "ch_t": "One image per channel: the same brick (7, 5, 0)",
        "lvl_t": "The brick grid of each level (layer z = 0, Pecam1 channel)",
        "lvl": "level", "stored": "stored brick", "empty": "absent brick (empty)",
        "pk_t": "Which bricks in which pack? (level 0, Pecam1 channel)",
        "layer": "brick layer", "pack": "pack", "absent": "empty",
        "pl_t": "Bytes to read to show the XY cut z = 30 at full resolution",
        "pl_bricks": "through the bricks\n(the whole z layer, 0 to 63)", "pl_planes": "through planes/\n(only plane z = 30)",
        "pl_y": "kilobytes read (3 channels)",
        "mip_t": "One cut, and the maximum of a 64-plane layer (DAPI channel)",
        "mip_a": "plane z = 30", "mip_b": "MIP of layer 0 (z 0 to 63)",
    },
}[LANG]

# ── lecture du dataset ────────────────────────────────────────────────────────
INDEX = b3.parse_index_bin((DS / "bricks/index.bin").read_bytes())


def entry(level, c, bx, by, bz):
    gx, gy, gz, _ = INDEX["levels"][level]
    e = INDEX["entries"][level][c][(bz * gy + by) * gx + bx]
    return int(e["pack"]), int(e["offset"]), int(e["length"])


def read_brick(level, c, bx, by, bz):
    pack, off, ln = entry(level, c, bx, by, bz)
    if ln == 0:
        return np.zeros((66, 66, 66), np.uint8), None
    raw = (DS / f"bricks/l{level}/c{c}/p{pack:05d}.bin").read_bytes()[off:off + ln]
    assert raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"
    img = np.array(Image.open(io.BytesIO(raw)).convert("L"))
    return b3.unmosaic_9x8(img), img


def save(fig, name, dpi=170):
    fig.savefig(OUT / name, dpi=dpi, facecolor="white", bbox_inches="tight", pad_inches=0.12)
    plt.close(fig)


# ── 1. couture avec / sans bordure ────────────────────────────────────────────
def seam():
    A, _ = read_brick(0, 0, 6, 5, 0)      # voxels x 384..447 (+bordure 448)
    B, _ = read_brick(0, 0, 7, 5, 0)      # voxels x 448..511 (+bordure 447)
    zi = 33                                # indice dans la brique de 66 (coupe intérieure 32)
    # Ligne choisie : celle où l'écart entre voxels voisins de part et d'autre est le plus net.
    jump = np.abs(A[zi, 1:65, 64].astype(int) - B[zi, 1:65, 2].astype(int))
    row = int(np.argmax(jump)) + 1
    y0 = max(1, min(row - 6, 64 - 13))
    rows = list(range(y0, y0 + 13))
    x_lo, x_hi, step = 56, 72, 1 / 16      # voxels autour de la limite (x local à A : 64 = limite)

    def sample(brick, xloc, yi, border):
        """Interpolation bilinéaire d'une brique A ou B, en voxels locaux (interieur 0..63)."""
        lo = 1 if not border else 0
        hi = 64 if not border else 65
        # coordonnée dans le tableau de 66 : voxel intérieur i -> indice i+1 ; centre du texel = +0.5
        t = xloc - 0.5 + 1
        t = np.clip(t, lo, hi)
        i0 = np.floor(t).astype(int)
        i1 = np.minimum(i0 + 1, hi)
        w = t - i0
        return brick[zi, yi, i0] * (1 - w) + brick[zi, yi, i1] * w

    xs = np.arange(x_lo, x_hi, step) + step / 2     # x local à A
    def row_profile(yi, border):
        out = np.empty_like(xs)
        for k, x in enumerate(xs):
            if x < 64:
                out[k] = sample(A, x, yi, border)
            else:
                out[k] = sample(B, x - 64, yi, border)
        return out

    imgs = {}
    for border in (False, True):
        imgs[border] = np.array([row_profile(r, border) for r in rows])
    # on interpole aussi verticalement par répétition : une ligne = 1 voxel de haut
    fig = plt.figure(figsize=(9.2, 6.4))
    gs = fig.add_gridspec(2, 2, height_ratios=[1, 0.95], hspace=0.38, wspace=0.12)
    vmax = float(max(imgs[False].max(), imgs[True].max()))
    for col, border in enumerate((False, True)):
        ax = fig.add_subplot(gs[0, col])
        ax.imshow(imgs[border], cmap="gray", vmin=0, vmax=vmax, aspect="auto", interpolation="nearest",
                  extent=[x_lo, x_hi, rows[-1] + 1, rows[0]])
        ax.axvline(64, color=RED, lw=1.6, ls="--")
        ry = row + 0.5
        ax.axhline(ry, color="white", lw=1.4)
        ax.set_title(T["seam_a"] if not border else T["seam_b"], fontsize=10.5, fontweight="bold",
                     color=RED if not border else GREEN)
        ax.set_xticks([56, 60, 64, 68, 72]); ax.set_yticks([])
    ax = fig.add_subplot(gs[1, :])
    for border, colr in ((False, RED), (True, GREEN)):
        k = row - rows[0]
        ax.plot(xs, imgs[border][k], color=colr, lw=2.2,
                label=T["border"] if border else T["no_border"])
    ax.axvline(64, color=INK2, ls="--", lw=1.2)
    ax.text(64.15, ax.get_ylim()[0] + 0.04 * (ax.get_ylim()[1] - ax.get_ylim()[0]), T["limit"],
            color=INK2, fontsize=9.5)
    ax.set_title(T["seam_prof"], fontsize=10.5, fontweight="bold")
    ax.set_xlabel(T["seam_x"]); ax.set_ylabel(T["seam_y"]); ax.legend(frameon=False, loc="upper left")
    ax.grid(alpha=0.25)
    save(fig, "couture.png")


# ── 2. la mosaïque réelle + croquis 3D ────────────────────────────────────────
def mosaic():
    vol, img = read_brick(0, 2, 7, 5, 0)
    fig = plt.figure(figsize=(10.6, 4.9))
    gs = fig.add_gridspec(1, 2, width_ratios=[594, 520], wspace=0.06)
    ax = fig.add_subplot(gs[0])
    ax.imshow(img, cmap="gray", vmin=0, vmax=max(1, int(img.max())), interpolation="nearest")
    for i in range(1, 9):
        ax.axvline(i * 66 - .5, color="#ff8787", lw=.7)
    for j in range(1, 8):
        ax.axhline(j * 66 - .5, color="#ff8787", lw=.7)
    for s in (0, 1, 8, 9, 10, 65):
        ax.text((s % 9) * 66 + 4, (s // 9) * 66 + 14, str(s), color="#ffd43b", fontsize=11, fontweight="bold",
                bbox=dict(boxstyle="round,pad=0.12", fc="#000000aa", ec="none"))
    ax.set_xticks([(c + .5) * 66 for c in range(9)]); ax.set_xticklabels([str(c) for c in range(9)], fontsize=8)
    ax.set_yticks([(r + .5) * 66 for r in range(8)]); ax.set_yticklabels([str(r) for r in range(8)], fontsize=8)
    ax.xaxis.tick_top(); ax.tick_params(length=0)
    ax.set_title(T["mosaic_t"], fontsize=10, fontweight="bold", pad=22)
    # croquis 3D
    ax3 = fig.add_subplot(gs[1], projection="3d")
    n = 66
    g = np.arange(n + 1)
    cm = plt.get_cmap("gray")
    sc = max(1, int(vol.max()))
    def face(arr):
        return cm(np.clip(arr.astype(float) / sc, 0, 1))
    X, Y = np.meshgrid(g, g)
    # face z' = 0 (haut)
    ax3.plot_surface(X, Y, np.zeros_like(X) + 66, facecolors=face(vol[65]), rstride=1, cstride=1, shade=False)
    # face y' = 0 (avant)
    Xf, Zf = np.meshgrid(g, g)
    ax3.plot_surface(Xf, np.zeros_like(Xf), Zf, facecolors=face(vol[:, 0, :]), rstride=1, cstride=1, shade=False)
    # face x' = 66 (côté)
    Yf, Zs = np.meshgrid(g, g)
    ax3.plot_surface(np.full_like(Yf, 66), Yf, Zs, facecolors=face(vol[:, :, 65]), rstride=1, cstride=1, shade=False)
    ax3.set_xlim(0, 66); ax3.set_ylim(0, 66); ax3.set_zlim(66, 0)
    ax3.view_init(elev=-24, azim=-48)
    ax3.set_box_aspect((1, 1, 1))
    for a in (ax3.xaxis, ax3.yaxis, ax3.zaxis):
        a.set_pane_color((1, 1, 1, 0)); a._axinfo["grid"]["linewidth"] = 0.2
    ax3.set_xlabel("x'", labelpad=-6); ax3.set_ylabel("y'", labelpad=-6); ax3.set_zlabel("z'", labelpad=-6)
    ax3.set_xticks([0, 33, 66]); ax3.set_yticks([0, 33, 66]); ax3.set_zticks([0, 33, 66])
    ax3.tick_params(labelsize=7, pad=-3)
    ax3.set_title(T["cut_t"], fontsize=10, fontweight="bold")
    save(fig, "mosaique.png")


# ── 3. une image par canal ───────────────────────────────────────────────────
def channels():
    fig, axs = plt.subplots(1, 3, figsize=(10.6, 2.9))
    cols = ["#3D7BFF", "#00FF66", "#FF3DFF"]
    for c, ax in enumerate(axs):
        vol, img = read_brick(0, c, 7, 5, 0)
        _, _, ln = entry(0, c, 7, 5, 0)
        ax.imshow(img, cmap="gray", vmin=0, vmax=max(1, int(img.max())), interpolation="nearest")
        ax.set_xticks([]); ax.set_yticks([])
        for s in ax.spines.values():
            s.set_color(cols[c]); s.set_linewidth(3)
        ax.set_title(f"{T['ch'][c]} - {ln:,} o".replace(",", " ") if LANG == "fr" else f"{T['ch'][c]} - {ln:,} B",
                     fontsize=10.5, fontweight="bold")
    fig.suptitle(T["ch_t"], fontsize=11, fontweight="bold", y=1.04)
    save(fig, "canaux.png")


# ── 4. grille de briques par niveau ──────────────────────────────────────────
def levels():
    fig, axs = plt.subplots(1, 4, figsize=(10.6, 3.0), gridspec_kw={"width_ratios": [12, 6, 3, 2]})
    for L, ax in enumerate(axs):
        gx, gy, gz, _ = INDEX["levels"][L]
        for by in range(gy):
            for bx in range(gx):
                _, _, ln = entry(L, 1, bx, by, 0)
                ax.add_patch(Rectangle((bx, by), 1, 1, fc=("#d0ebff" if ln else "#f1f3f5"), ec="white", lw=1.5))
                if ln:
                    ax.add_patch(Rectangle((bx + .3, by + .3), .4, .4, fc=BLUE, ec="none", alpha=.0))
        ax.set_xlim(0, gx); ax.set_ylim(gy, 0); ax.set_aspect("equal")
        ax.set_xticks([]); ax.set_yticks([])
        for s in ax.spines.values():
            s.set_visible(False)
        dims = INDEX["levels"][L]
        ax.set_title(f"{T['lvl']} {L}\n{gx}×{gy}×{gz}", fontsize=10, fontweight="bold")
    h1 = Rectangle((0, 0), 1, 1, fc="#d0ebff", ec="white"); h2 = Rectangle((0, 0), 1, 1, fc="#f1f3f5", ec="#c5cbd8")
    fig.legend([h1, h2], [T["stored"], T["empty"]], loc="lower center", ncol=2, frameon=False, bbox_to_anchor=(.5, -.08))
    fig.suptitle(T["lvl_t"], fontsize=11, fontweight="bold", y=1.16)
    save(fig, "niveaux.png")


# ── 5. paquets ───────────────────────────────────────────────────────────────
def packs():
    gx, gy, gz, _ = INDEX["levels"][0]
    pal = [BLUE, AMBER]
    fig, axs = plt.subplots(1, 2, figsize=(10.6, 3.3))
    for bz, ax in enumerate(axs):
        for by in range(gy):
            for bx in range(gx):
                p, off, ln = entry(0, 1, bx, by, bz)
                fc = "#f1f3f5" if ln == 0 else pal[p % 2]
                ax.add_patch(Rectangle((bx, by), 1, 1, fc=fc, ec="white", lw=1.3, alpha=1 if ln == 0 else .85))
        for k in range(0, gx + 1, 4):
            ax.axvline(k, color=INK, lw=1.6)
        for k in range(0, gy + 1, 4):
            ax.axhline(k, color=INK, lw=1.6)
        ax.axhline(gy, color=INK, lw=1.6); ax.axvline(gx, color=INK, lw=1.6)
        ax.set_xlim(0, gx); ax.set_ylim(gy, 0); ax.set_aspect("equal"); ax.set_xticks([]); ax.set_yticks([])
        for s in ax.spines.values():
            s.set_visible(False)
        ax.set_title(f"{T['layer']} z = {bz}", fontsize=10, fontweight="bold")
    hs = [Rectangle((0, 0), 1, 1, fc=BLUE), Rectangle((0, 0), 1, 1, fc=AMBER), Rectangle((0, 0), 1, 1, fc="#f1f3f5", ec="#c5cbd8")]
    fig.legend(hs, [f"{T['pack']} p00000", f"{T['pack']} p00001", T["absent"]], loc="lower center", ncol=3,
               frameon=False, bbox_to_anchor=(.5, -.07))
    fig.suptitle(T["pk_t"], fontsize=11, fontweight="bold", y=1.03)
    save(fig, "paquets.png")


# ── 6. planes/ contre briques ────────────────────────────────────────────────
def read_plane_tiles(pack_path):
    d = pack_path.read_bytes()
    magic, ver, C, TX, TY, z = struct.unpack_from("<4sHHHHI", d, 0)
    assert magic in (b"LPLN", b"LMIP")
    ents = []
    for i in range(C * TY * TX):
        off, ln = struct.unpack_from("<QI", d, 16 + 12 * i)
        ents.append((off, ln))
    return d, C, TX, TY, ents


def planes_bytes():
    z = 30
    brick_b = sum(entry(0, c, bx, by, 0)[2] for c in range(3) for by in range(9) for bx in range(12))
    pd = DS / f"planes/z{z:05d}.bin"
    plane_b = pd.stat().st_size
    return brick_b, plane_b


def planes():
    brick_b, plane_b = planes_bytes()
    fig, ax = plt.subplots(figsize=(7.6, 3.2))
    vals = [brick_b / 1024, plane_b / 1024]
    bars = ax.barh([T["pl_bricks"], T["pl_planes"]], vals, color=[AMBER, GREEN], height=.55)
    for r, v in zip(bars, vals):
        ax.text(v + max(vals) * .01, r.get_y() + r.get_height() / 2, f"{v:,.0f} ko".replace(",", " ") if LANG == "fr" else f"{v:,.0f} kB",
                va="center", fontsize=11, fontweight="bold")
    ax.invert_yaxis(); ax.set_xlim(0, max(vals) * 1.18)
    ax.set_xlabel(T["pl_y"]); ax.set_title(T["pl_t"], fontsize=10.5, fontweight="bold")
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    save(fig, "planes_octets.png")
    return brick_b, plane_b


# ── 7. une coupe et le MIP d'une couche ──────────────────────────────────────
def mips():
    def tiles_img(path, c, nx=2, ny=2, W=768, H=576):
        d, C, TX, TY, ents = read_plane_tiles(path)
        full = np.zeros((H, W), np.uint8)
        for ty in range(TY):
            for tx in range(TX):
                off, ln = ents[(c * TY + ty) * TX + tx]
                if ln:
                    t = np.array(Image.open(io.BytesIO(d[off:off + ln])))
                    full[ty * 512:ty * 512 + t.shape[0], tx * 512:tx * 512 + t.shape[1]] = t
        return full
    plane = tiles_img(DS / "planes/z00030.bin", 0)
    mip = tiles_img(DS / "mips/l00000.bin", 0)
    fig, axs = plt.subplots(1, 2, figsize=(10.6, 3.9))
    for ax, im, t in zip(axs, (plane, mip), (T["mip_a"], T["mip_b"])):
        ax.imshow(im, cmap="Blues", vmin=0, vmax=max(1, int(mip.max())), interpolation="nearest")
        ax.set_xticks([]); ax.set_yticks([]); ax.set_title(t, fontsize=10.5, fontweight="bold")
    fig.suptitle(T["mip_t"], fontsize=11, fontweight="bold", y=1.02)
    save(fig, "mip_couche.png")


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import svgs
    svgs.build()
    seam(); mosaic(); channels(); levels(); packs()
    print("octets coupe z=30 :", planes())
    mips()
