#!/usr/bin/env python3
"""Figures du chapitre 8 (fin du pipeline), tirées du jeu de démonstration réel.

    python make_figures.py                      # français -> img/ch08
    FIG_LANG=en IMG_DIR=DOCS/documentation/img-en/ch08 python make_figures.py

Données : DATA_WEB/3d/Embryo-E95-Em2-Pecam1-Sox2 (vignette, histogrammes) et
DATA_WEB/live/Demo-Lumen3D-E85-Em1-30min-2ch-4tp (suivi cellulaire) — jeux de démonstration synthétiques.
"""
import io
import json
import os
import struct
import sys
from pathlib import Path

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
LANG = os.environ.get("FIG_LANG", "fr")
OUT = Path(os.environ.get("IMG_DIR", HERE))
OUT.mkdir(parents=True, exist_ok=True)
DS = ROOT / "DATA_WEB/3d/Embryo-E95-Em2-Pecam1-Sox2"
LIVE = ROOT / "DATA_WEB/live/Demo-Lumen3D-E85-Em1-30min-2ch-4tp"

for f in font_manager.findSystemFonts():
    if "Inter-" in Path(f).name:
        font_manager.fontManager.addfont(f)
plt.rcParams.update({"font.family": ["Inter", "DejaVu Sans"], "font.size": 11, "axes.edgecolor": "#c5cbd8",
                     "axes.labelcolor": "#1c2333", "text.color": "#1c2333", "xtick.color": "#4a5468", "ytick.color": "#4a5468"})
INK, INK2 = "#1c2333", "#4a5468"
BLUE, GREEN, AMBER, VIOLET, RED = "#3b5bdb", "#2b8a3e", "#e67700", "#7048e8", "#c92a2a"

T = {
    "fr": {
        "th_t": "La vignette : le MIP de chaque canal, colorié puis additionné",
        "th_ch": ["DAPI → vert", "Pecam1 → magenta", "Sox2 → bleu"], "th_res": "vignette réelle\n(thumbnail.webp)",
        "hi_t": "Histogrammes du niveau le plus grossier (64 classes), échelle logarithmique",
        "hi_x": "valeur du voxel (0-255)", "hi_y": "nombre de voxels",
        "ka_a": "1. Brut : l'embryon a bougé", "ka_b": "2. Après rotation + translation", "ka_c": "3. Trajectoires",
        "t1": "image 1 (référence)", "t4": "image 4, brute", "t4s": "image 4, stabilisée",
        "raw": "brutes", "stab": "stabilisées", "x": "x (µm)", "y": "y (µm)",
    },
    "en": {
        "th_t": "The thumbnail: each channel's MIP, coloured then added",
        "th_ch": ["DAPI → green", "Pecam1 → magenta", "Sox2 → blue"], "th_res": "real thumbnail\n(thumbnail.webp)",
        "hi_t": "Histograms of the coarsest level (64 bins), logarithmic scale",
        "hi_x": "voxel value (0-255)", "hi_y": "number of voxels",
        "ka_a": "1. Raw: the embryo moved", "ka_b": "2. After rotation + translation", "ka_c": "3. Trajectories",
        "t1": "frame 1 (reference)", "t4": "frame 4, raw", "t4s": "frame 4, stabilised",
        "raw": "raw", "stab": "stabilised", "x": "x (µm)", "y": "y (µm)",
    },
}[LANG]


def save(fig, name, dpi=170):
    fig.savefig(OUT / name, dpi=dpi, facecolor="white", bbox_inches="tight", pad_inches=0.12)
    plt.close(fig)


def read_pack_tiles(path, c, W, H):
    d = path.read_bytes()
    magic, ver, C, TX, TY, z = struct.unpack_from("<4sHHHHI", d, 0)
    full = np.zeros((H, W), np.uint8)
    for ty in range(TY):
        for tx in range(TX):
            off, ln = struct.unpack_from("<QI", d, 16 + 12 * ((c * TY + ty) * TX + tx))
            if ln:
                t = np.array(Image.open(io.BytesIO(d[off:off + ln])))
                full[ty * 512:ty * 512 + t.shape[0], tx * 512:tx * 512 + t.shape[1]] = t
    return full


def thumbnail():
    cols = [(0, 255, 102), (255, 61, 255), (47, 107, 255)]      # THUMB_COLORS du pipeline
    mips = []
    for c in range(3):
        m = np.maximum(read_pack_tiles(DS / "mips/l00000.bin", c, 768, 576),
                       read_pack_tiles(DS / "mips/l00001.bin", c, 768, 576))
        mips.append(m)
    comp = np.zeros((576, 768, 3), np.float32)
    for m, (r, g, b) in zip(mips, cols):
        n = m.astype(np.float32) / 255
        comp += np.stack([n * r, n * g, n * b], -1)
    comp = np.clip(comp, 0, 255).astype(np.uint8)
    real = np.array(Image.open(DS / "thumbnail.webp").convert("RGB"))
    fig, axs = plt.subplots(1, 5, figsize=(11.2, 2.9), gridspec_kw={"width_ratios": [1, 1, 1, .22, 1]})
    for i in range(3):
        rgb = np.stack([mips[i] / 255.0 * k / 255 for k in cols[i]], -1)
        axs[i].imshow(rgb); axs[i].set_title(T["th_ch"][i], fontsize=10.5, fontweight="bold")
    axs[3].axis("off"); axs[3].text(.5, .5, "+  +\n=", ha="center", va="center", fontsize=22, fontweight="bold", color=INK2)
    axs[4].imshow(real); axs[4].set_title(T["th_res"], fontsize=10.5, fontweight="bold", color=GREEN)
    for a in (axs[0], axs[1], axs[2], axs[4]):
        a.set_xticks([]); a.set_yticks([])
    fig.suptitle(T["th_t"], fontsize=11, fontweight="bold", y=1.05)
    save(fig, "vignette.png")
    return comp


def histograms():
    m = json.loads((DS / "bricks/manifest.json").read_text())
    names = ["DAPI", "Pecam1", "Sox2"]
    cols = ["#3D7BFF", "#00A84F", "#D12BD1"]
    fig, axs = plt.subplots(1, 3, figsize=(11, 3.1), sharey=True)
    for ax, h, n, c in zip(axs, m["histograms"], names, cols):
        e = np.array(h["edges"])
        ax.bar(e[:-1], np.where(np.array(h["counts"]) > 0, np.array(h["counts"]), np.nan), width=np.diff(e), align="edge", color=c)
        ax.set_yscale("log"); ax.set_xlim(0, 255); ax.set_xlabel(T["hi_x"])
        ax.set_title(f"{n} · max {h['max']}",
                     fontsize=10, fontweight="bold")
        for s in ("top", "right"):
            ax.spines[s].set_visible(False)
    axs[0].set_ylabel(T["hi_y"])
    fig.suptitle(T["hi_t"], fontsize=11, fontweight="bold", y=1.05)
    save(fig, "histogrammes.png")


def kabsch():
    t = json.loads((LIVE / "tracks.json").read_text())
    reg = json.loads((LIVE / "metadata.json").read_text())["registration"]["transforms"][3]
    M = np.array(reg["matrix"]).reshape(4, 4).T          # colonne-majeur -> ligne-majeur
    cells = [c for c in t["cells"].values() if "1" in c["raw_positions"] and "4" in c["raw_positions"]]
    P1 = np.array([c["raw_positions"]["1"] for c in cells])
    P4 = np.array([c["raw_positions"]["4"] for c in cells])
    P4s = (np.c_[P4, np.ones(len(P4))] @ M.T)[:, :3]
    S4 = np.array([c["positions"]["4"] for c in cells])
    assert np.allclose(P4s, S4, atol=1e-3)
    fig, axs = plt.subplots(1, 3, figsize=(11.2, 3.9))
    ax = axs[0]
    ax.scatter(P1[:, 0], P1[:, 1], s=26, c=BLUE, label=T["t1"])
    ax.scatter(P4[:, 0], P4[:, 1], s=26, c=AMBER, label=T["t4"])
    ax.set_title(T["ka_a"], fontsize=10.5, fontweight="bold")
    ax = axs[1]
    ax.scatter(P1[:, 0], P1[:, 1], s=26, c=BLUE, label=T["t1"])
    ax.scatter(P4s[:, 0], P4s[:, 1], s=26, c=GREEN, label=T["t4s"])
    for a, b in zip(P1, P4s):
        ax.plot([a[0], b[0]], [a[1], b[1]], color="#adb5bd", lw=.8, zorder=0)
    ax.set_title(T["ka_b"], fontsize=10.5, fontweight="bold")
    ax = axs[2]
    for c in cells[:10]:
        r = np.array([c["raw_positions"][k] for k in "1234"]); s = np.array([c["positions"][k] for k in "1234"])
        ax.plot(r[:, 0], r[:, 1], "-o", color=AMBER, ms=3, lw=1.3, alpha=.9, label=T["raw"] if c is cells[0] else None)
        ax.plot(s[:, 0], s[:, 1], "-o", color=GREEN, ms=3, lw=1.3, alpha=.9, label=T["stab"] if c is cells[0] else None)
    ax.set_title(T["ka_c"], fontsize=10.5, fontweight="bold")
    for ax in axs:
        ax.set_aspect("equal"); ax.set_xlabel(T["x"]); ax.legend(frameon=False, fontsize=9, loc="upper center", bbox_to_anchor=(.5, -.2), ncol=2)
        for s in ("top", "right"):
            ax.spines[s].set_visible(False)
    axs[0].set_ylabel(T["y"])
    for ax in axs:
        ax.set_xlim(0, 190); ax.set_ylim(0, 190)
    save(fig, "kabsch.png")
    print("rotation", reg["rotationDeg"], "translation", reg["translationUm"], "n", len(cells))


if __name__ == "__main__":
    sys.path.insert(0, str(HERE))
    import svgs
    svgs.build()
    thumbnail(); histograms(); kabsch()
