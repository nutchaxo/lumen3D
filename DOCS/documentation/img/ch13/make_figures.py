#!/usr/bin/env python3
"""Figures de données du chapitre 13 (« Les outils sous le capot »), tirées du jeu de démonstration réel.

    python make_figures.py                                  # français -> ce dossier
    FIG_LANG=en IMG_DIR=../../img-en/ch13 python make_figures.py [nom ...]

Sans argument : toutes les figures. Les schémas SVG sont produits par svgs.py (même variables).
Sources : DATA_WEB/live/Demo-Lumen3D-E85-Em1-30min-2ch-4tp (suivi + registration),
DATA_WEB/2d/DLL4xCD1-E95-x3.2-240913-1 (photographie), js/pages/compare-policy.js et
js/workers/pixel-ops-2d.js exécutés tels quels sous Node pour les figures qui en dépendent.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.patches import Polygon, Rectangle

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
LANG = os.environ.get("FIG_LANG", "fr")
OUT = Path(os.environ.get("IMG_DIR", HERE))
OUT.mkdir(parents=True, exist_ok=True)

for f in font_manager.findSystemFonts():
    if "Inter-" in Path(f).name and "Display" not in Path(f).name:
        font_manager.fontManager.addfont(f)
plt.rcParams.update({"font.family": ["Inter", "DejaVu Sans"], "font.size": 11,
                     "axes.edgecolor": "#c5cbd8", "axes.labelcolor": "#1c2333",
                     "text.color": "#1c2333", "xtick.color": "#4a5468", "ytick.color": "#4a5468",
                     "figure.facecolor": "white", "axes.facecolor": "white"})
INK, INK2 = "#1c2333", "#4a5468"
BLUE, GREEN, AMBER, VIOLET, TEAL, RED = "#3b5bdb", "#2b8a3e", "#e67700", "#7048e8", "#0c8599", "#c92a2a"


def tr(fr, en):
    return fr if LANG == "fr" else en


def dec(x, nd=1):
    s = f"{x:.{nd}f}"
    return s.replace(".", ",") if LANG == "fr" else s


LIVE = ROOT / "DATA_WEB/live/Demo-Lumen3D-E85-Em1-30min-2ch-4tp"


def save(fig, name, dpi=170):
    fig.savefig(OUT / name, dpi=dpi, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print("  ", name)


# ── 1. Les repères de la stabilisation, vrais chiffres ──────────────────────────────
def suivi_reperes():
    meta = json.loads((LIVE / "metadata.json").read_text())
    reg = meta["registration"]
    ext = meta["acquisitionExtentUm"]
    lo, hi = np.array(ext["min"][:2]), np.array(ext["max"][:2])
    tracks = json.loads((LIVE / "tracks.json").read_text())
    union = reg["imageBoxUnionUm"]
    fig, axes = plt.subplots(1, 2, figsize=(11.2, 5.0), gridspec_kw={"width_ratios": [1, 1]})

    # a) repère stabilisé : les fenêtres d'acquisition de chaque image
    ax = axes[0]
    cols = ["#adb5bd", "#74c0fc", "#4c6ef5", "#1c3fd1"]
    for i, tr_ in enumerate(reg["transforms"]):
        M = np.array(tr_["matrix"]).reshape(4, 4).T
        corners = np.array([[lo[0], lo[1], 0, 1], [hi[0], lo[1], 0, 1], [hi[0], hi[1], 0, 1], [lo[0], hi[1], 0, 1]])
        pts = (M @ corners.T).T[:, :2]
        ax.add_patch(Polygon(pts, closed=True, fill=(i == 0), facecolor="#f1f3f5", edgecolor=cols[i], lw=2.0 if i else 1.6,
                             ls="-" if i else "--", label=tr(f"image {i + 1} · {dec(tr_['rotationDeg'], 1)}°", f"frame {i + 1} · {dec(tr_['rotationDeg'], 1)}°")))
    ub = np.array([[union["min"][0], union["min"][1]], [union["max"][0], union["min"][1]],
                   [union["max"][0], union["max"][1]], [union["min"][0], union["max"][1]]])
    ax.add_patch(Polygon(ub, closed=True, fill=False, edgecolor=RED, lw=1.8, ls=(0, (5, 3)),
                         label=tr("boîte d'affichage (union)", "display box (union)")))
    reg_col = {"Anterior": "#e74c3c", "Posterior": "#2ecc71", "Lateral": "#3498db"}
    xs, ys, cs = [], [], []
    for c in tracks["cells"].values():
        p = c["positions"].get("4")
        if p:
            xs.append(p[0]); ys.append(p[1]); cs.append(reg_col.get(c["region"], "#888"))
    ax.scatter(xs, ys, s=22, c=cs, zorder=5, edgecolors="white", linewidths=0.5)
    ax.set_xlim(-30, 215); ax.set_ylim(220, -22); ax.set_aspect("equal")
    ax.set_xlabel(tr("x stabilisé (µm)", "stabilised x (µm)")); ax.set_ylabel(tr("y stabilisé (µm)", "stabilised y (µm)"))
    ax.set_title(tr("Repère stabilisé : l'embryon est immobile,\nla fenêtre d'acquisition tourne et glisse", "Stabilised frame: the embryo stands still,\nthe acquisition window turns and slides"),
                 fontsize=11.5, fontweight="bold", color=INK, loc="left")
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.17), ncol=3, fontsize=8.6, frameon=False)

    # b) l'écart cumulé : rotation et déplacement par image
    ax = axes[1]
    idx = np.arange(1, 5)
    rot = [t["rotationDeg"] for t in reg["transforms"]]
    shift = [float(np.linalg.norm(t["translationUm"])) for t in reg["transforms"]]
    ax.bar(idx - 0.18, rot, 0.36, color=BLUE, label=tr("rotation (°)", "rotation (°)"))
    ax.bar(idx + 0.18, shift, 0.36, color=AMBER, label=tr("déplacement (µm)", "shift (µm)"))
    for x, v in zip(idx - 0.18, rot):
        ax.text(x, v + 0.5, dec(v, 1), ha="center", fontsize=9, color=BLUE, fontweight="bold")
    for x, v in zip(idx + 0.18, shift):
        ax.text(x, v + 0.5, dec(v, 1), ha="center", fontsize=9, color=AMBER, fontweight="bold")
    ax.set_xticks(idx); ax.set_xticklabels([tr(f"image {i}", f"frame {i}") for i in idx])
    ax.set_title(tr("Ce que la matrice de chaque image corrige", "What each frame's matrix corrects"),
                 fontsize=11.5, fontweight="bold", color=INK, loc="left")
    ax.legend(frameon=False, loc="upper left")
    for sp in ("top", "right"):
        ax.spines[sp].set_visible(False)
    ax.set_ylim(0, 28)
    fig.text(0.5, -0.08, tr("Jeu de démonstration (synthétique) : rotations 0 ; 2,3 ; 4,7 ; 7,0° ; points = cellules de l'image 4 colorées par région.",
                            "Demo dataset (synthetic): rotations 0; 2.3; 4.7; 7.0°; dots = frame-4 cells coloured by region."),
             ha="center", fontsize=9, color=INK2, style="italic")
    fig.tight_layout()
    save(fig, "suivi-reperes.png")


ALL = {"suivi_reperes": suivi_reperes}

if __name__ == "__main__":
    names = sys.argv[1:] or list(ALL)
    for n in names:
        print(n)
        ALL[n]()
