"""Figures de données du chapitre 17 (matplotlib) : le régulateur réseau.

La courbe vient de la VRAIE classe NetGovernor (js/pages/admin/migration-runner.js) exécutée sur une
horloge virtuelle par gov_sim.mjs (résultats dans data/gov_sim.json).
"""
import json
import os
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager

HERE = Path(__file__).resolve().parent
LANG = os.environ.get("FIG_LANG", "fr")
OUT = Path(os.environ.get("IMG_DIR", HERE))
OUT.mkdir(parents=True, exist_ok=True)

for f in font_manager.findSystemFonts():
    if "Inter-" in Path(f).name and "Display" not in Path(f).name:
        font_manager.fontManager.addfont(f)
plt.rcParams.update({"font.family": ["Inter", "DejaVu Sans"], "font.size": 10.5,
                     "axes.edgecolor": "#c5cbd8", "axes.labelcolor": "#1c2333",
                     "text.color": "#1c2333", "xtick.color": "#4a5468", "ytick.color": "#4a5468"})
INK, INK2 = "#1c2333", "#4a5468"
BLUE, GREEN, AMBER, VIOLET, TEAL, RED, GREY = "#3b5bdb", "#2b8a3e", "#e67700", "#7048e8", "#0c8599", "#c92a2a", "#8a93a6"


def tr(fr, en):
    return fr if LANG == "fr" else en


def gouverneur():
    d = json.loads((HERE / "data/gov_sim.json").read_text(encoding="utf-8"))
    a, old = d["v159_3"], d["v159_2"]
    fig = plt.figure(figsize=(8.4, 6.6), facecolor="white")
    gs = fig.add_gridspec(2, 2, height_ratios=[1, 1], hspace=0.55, wspace=0.32)
    ax1 = fig.add_subplot(gs[0, :])
    ax2 = fig.add_subplot(gs[1, 0])
    ax3 = fig.add_subplot(gs[1, 1])

    # a. plafond de débit
    for run, col, lab, ls in ((old, GREY, tr("1.59.2 : 10 à 16 requêtes/s", "1.59.2: 10 to 16 requests/s"), "--"),
                              (a, BLUE, tr("1.59.3 : 4 à 6 requêtes/s", "1.59.3: 4 to 6 requests/s"), "-")):
        t = [r[0] for r in run["rateTrace"] if r[0] <= 45]
        v = [r[1] for r in run["rateTrace"] if r[0] <= 45]
        ax1.step(t, v, where="post", color=col, lw=2.2, ls=ls, label=lab)
    ax1.axvline(20, color=RED, lw=1.3, ls=":")
    ax1.annotate(tr("une réponse 429 :\ndébit ÷ 2 et pause de 5 s", "a 429 answer:\nrate ÷ 2 and a 5 s hold"), xy=(20.2, 3.2), xytext=(27, 2.0),
                 color=RED, fontsize=10, arrowprops=dict(arrowstyle="->", color=RED))
    ax1.annotate(tr("+ 0,2 requête/s à chaque\nréponse reçue", "+ 0.2 request/s for each\nanswer received"), xy=(31, 6), xytext=(33.5, 9.2), color=BLUE, fontsize=10,
                 arrowprops=dict(arrowstyle="->", color=BLUE))
    ax1.set_xlim(0, 45)
    ax1.set_ylim(0, 17.5)
    ax1.set_xlabel(tr("temps (s)", "time (s)"))
    ax1.set_ylabel(tr("débit autorisé (requêtes/s)", "allowed rate (requests/s)"))
    ax1.set_title(tr("Le plafond de débit du régulateur réseau (la vraie classe, horloge virtuelle)", "The network governor's rate ceiling (the real class, virtual clock)"),
                  fontsize=12, fontweight="bold", loc="left")
    ax1.legend(frameon=False, loc="center right", bbox_to_anchor=(1.0, 0.62), fontsize=10)
    ax1.spines[["top", "right"]].set_visible(False)

    # b. requêtes réellement parties chaque seconde
    def bars(run, col, off, lab):
        xs = list(range(0, 45))
        ys = [run["perSec"].get(str(i), 0) for i in xs]
        ax2.bar([x + off for x in xs], ys, width=0.42, color=col, label=lab)
    bars(old, GREY, -0.21, "1.59.2")
    bars(a, BLUE, 0.21, "1.59.3")
    ax2.set_xlim(0, 45)
    ax2.set_xlabel(tr("seconde", "second"))
    ax2.set_ylabel(tr("requêtes parties", "requests started"))
    ax2.set_title(tr("Requêtes réellement parties", "Requests actually started"), fontsize=11, fontweight="bold", loc="left")
    ax2.legend(frameon=False, fontsize=9.5, loc="upper right")
    ax2.spines[["top", "right"]].set_visible(False)

    # c. mesures réelles (paire de jeux de test, SPEC §7.2)
    labs = ["1.59.1", "1.59.2", "1.59.3"]
    reqs = [3400, 3443, 424]
    ax3.bar(labs, reqs, color=[RED, GREY, BLUE], width=0.6)
    for i, v in enumerate(reqs):
        ax3.text(i, v + 60, ("≈ " if i == 0 else "") + f"{v:,}".replace(",", " " if LANG == "fr" else ","), ha="center", fontsize=10, fontweight="bold")
    ax3.set_ylim(0, 4200)
    ax3.set_ylabel(tr("requêtes (même conversion)", "requests (same conversion)"))
    ax3.set_title(tr("Mesuré sur la paire de jeux de test", "Measured on the test pair of datasets"), fontsize=11, fontweight="bold", loc="left")
    ax3.spines[["top", "right"]].set_visible(False)
    ax3.text(2.45, 1500, tr("115 s\ncontre 436 s\n(1.59.2)", "115 s\nvs 436 s\n(1.59.2)"), ha="right", fontsize=9.5, color=BLUE)
    fig.savefig(OUT / "gouverneur.png", dpi=200, bbox_inches="tight", facecolor="white")
    plt.close(fig)


def run():
    gouverneur()
