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



# ── 2. La page 2D : cartes intermédiaires (le vrai code de pixel-ops-2d.js tourne sous Node) ───
W2, H2 = 1920, 1440
D2 = Path(os.environ.get("D2_DIR", "/tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad/r2-13/d2"))


def _d2_data():
    """Exécute js/workers/pixel-ops-2d.js sur la photographie de démonstration (voir make_2d_data.mjs)."""
    if not (D2 / "iso.rgba").exists():
        D2.mkdir(parents=True, exist_ok=True)
        from PIL import Image
        photo = ROOT / "DATA_WEB/2d/DLL4xCD1-E95-x3.2-240913-1/image.webp"
        im = Image.open(photo).convert("RGBA")
        np.array(im).tofile(D2 / "full.rgba")
        for name, div in (("s4", 4), ("s8", 8)):
            w, h = -(-im.width // div), -(-im.height // div)
            np.array(im.resize((w, h), Image.BILINEAR)).tofile(D2 / f"{name}.rgba")
        subprocess.run(["node", str(HERE / "make_2d_data.mjs"), str(D2), str(ROOT)], check=True)
    rd = lambda n, dt, shp: np.fromfile(D2 / n, dtype=dt).reshape(shp)
    return {"full": rd("full.rgba", np.uint8, (H2, W2, 4)), "iso": rd("iso.rgba", np.uint8, (H2, W2, 4)),
            "flat": rd("flat.rgba", np.uint8, (H2, W2, 4)), "ctx": rd("ctx.f32", np.float32, (360, 480)),
            "gain": rd("gain.f32", np.float32, (180, 240)), "curves": json.loads((D2 / "curves.json").read_text())}


def d2_isolation():
    d = _d2_data()
    full, ctx = d["full"], d["ctx"]
    r, g, b = [full[:, :, i].astype(np.float32) for i in range(3)]
    ctx_big = np.kron(ctx, np.ones((4, 4)))[:H2, :W2]
    ratio = b / (r + 1)
    v = np.where(ctx_big > 5, np.clip((ratio - 1.0) / 0.8, 0, 1), 0)
    fig, axes = plt.subplots(1, 4, figsize=(15.5, 4.4))
    ims = [(full[:, :, :3], tr("① photographie", "① photograph"), None),
           (ctx_big, tr("② contexte « tissu jaune »\n(moyenne locale de (R+V)/2 − B)", "② “yellow tissue” context\n(local mean of (R+G)/2 − B)"), "magma"),
           (v, tr("③ v : le marquage (B/R de 1,0 à 1,8,\ndans le tissu seulement)", "③ v: the stain (B/R from 1.0 to 1.8,\ninside tissue only)"), "viridis"),
           (d["iso"][:, :, :3], tr("④ résultat : gris sombre + cyan", "④ result: dim grey + cyan"), None)]
    for ax, (img, ttl, cm) in zip(axes, ims):
        ax.imshow(img, cmap=cm, vmin=0 if cm else None, vmax=(max(12.0, float(np.percentile(ctx_big, 99))) if cm == "magma" else 1) if cm else None)
        ax.set_title(ttl, fontsize=10.5, fontweight="bold", color=INK, loc="left")
        ax.axis("off")
    fig.text(0.5, 0.01, tr("Photographie de démonstration (synthétique). Le seuil du contexte est 5 : en dessous, v = 0 (le fond mat, même bleuté, ne s'allume pas).",
                           "Demo photograph (synthetic). The context threshold is 5: below it, v = 0 (the matte background, even bluish, does not light up)."),
             ha="center", fontsize=9, color=INK2, style="italic")
    fig.tight_layout(rect=(0, 0.04, 1, 1))
    save(fig, "2d-isolation-cartes.png", 150)


def d2_aplatir():
    d = _d2_data()
    fig, axes = plt.subplots(1, 3, figsize=(13.5, 4.4), gridspec_kw={"width_ratios": [1, 1, 1]})
    axes[0].imshow(d["full"][:, :, :3]); axes[0].set_title(tr("① photographie", "① photograph"), fontsize=10.5, fontweight="bold", loc="left")
    gain = np.kron(d["gain"], np.ones((8, 8)))[:H2, :W2]
    im = axes[1].imshow(gain, cmap="coolwarm", vmin=0.5, vmax=1.5)
    axes[1].set_title(tr("② gain = éclairage moyen / éclairage local\n(surface fittée sur les 40 % de pixels les plus sombres)", "② gain = mean illumination / local illumination\n(surface fitted on the darkest 40 % of pixels)"), fontsize=10.5, fontweight="bold", loc="left")
    fig.colorbar(im, ax=axes[1], fraction=0.046, pad=0.02)
    axes[2].imshow(d["flat"][:, :, :3]); axes[2].set_title(tr("③ après « Aplatir le fond »", "③ after “Flatten the background”"), fontsize=10.5, fontweight="bold", loc="left")
    for ax in axes:
        ax.axis("off")
    fig.text(0.5, 0.01, tr(f"Gain réel de cette photographie : de {dec(float(gain.min()), 2)} à {dec(float(gain.max()), 2)} (borné entre 0,5 et 3). Cette photo synthétique n'a pas de vrai vignettage : la figure montre le mécanisme, pas un bénéfice.",
                           f"Actual gain of this photograph: from {dec(float(gain.min()), 2)} to {dec(float(gain.max()), 2)} (clamped between 0.5 and 3)."),
             ha="center", fontsize=9, color=INK2, style="italic")
    fig.tight_layout(rect=(0, 0.04, 1, 1))
    save(fig, "2d-aplatir.png", 150)


def d2_lut():
    c = _d2_data()["curves"]
    x = np.arange(256)
    fig, ax = plt.subplots(figsize=(6.6, 5.0))
    ax.plot(x, c["id"]["g"], color="#adb5bd", lw=2, label=tr("rien (identité)", "none (identity)"))
    ax.plot(x, c["bright"]["g"], color=BLUE, lw=2, label=tr("luminosité +30", "brightness +30"))
    ax.plot(x, c["contrast"]["g"], color=GREEN, lw=2, label=tr("contraste +50", "contrast +50"))
    ax.plot(x, c["gamma2"]["g"], color=AMBER, lw=2, label=tr("gamma 2", "gamma 2"))
    ax.plot(x, c["blue14"]["b"], color=VIOLET, lw=2, ls="--", label=tr("bleu ×1,4 (canal bleu seul)", "blue ×1.4 (blue channel only)"))
    ax.set_xlim(0, 255); ax.set_ylim(0, 260); ax.set_aspect("equal")
    ax.set_xlabel(tr("valeur du pixel avant (0-255)", "pixel value before (0-255)")); ax.set_ylabel(tr("valeur après (0-255)", "value after (0-255)"))
    ax.set_title(tr("La table de correspondance : 256 valeurs, calculée une fois", "The look-up table: 256 values, computed once"), fontsize=11.5, fontweight="bold", loc="left")
    ax.legend(frameon=False, fontsize=9.5, loc="lower right")
    for sp in ("top", "right"):
        ax.spines[sp].set_visible(False)
    fig.tight_layout()
    save(fig, "2d-lut.png")


ALL = {"suivi_reperes": suivi_reperes, "d2_isolation": d2_isolation, "d2_aplatir": d2_aplatir, "d2_lut": d2_lut}

if __name__ == "__main__":
    names = sys.argv[1:] or list(ALL)
    for n in names:
        print(n)
        ALL[n]()
