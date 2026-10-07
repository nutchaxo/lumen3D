#!/usr/bin/env python3
"""Figures of chapter 4 (from the microscope to the Imaris file).

  FIG_LANG=fr|en   language of every text drawn in the figures (default fr)
  IMG_DIR=<dir>    output folder (default: the folder of this script)
  IMS_DIR=<dir>    folder holding the demonstration .ims files
Regenerate the English set:
  FIG_LANG=en IMG_DIR=DOCS/documentation/img-en/ch04 python3 DOCS/documentation/img/ch04/make_figures.py
All data come from the synthetic demonstration embryo.
"""
import os, sys, pathlib, html
import numpy as np, h5py
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

LANG = os.environ.get("FIG_LANG", "fr")
HERE = pathlib.Path(__file__).resolve().parent
OUT = pathlib.Path(os.environ.get("IMG_DIR", HERE)); OUT.mkdir(parents=True, exist_ok=True)
IMS = pathlib.Path(os.environ.get("IMS_DIR", "/tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad/ims"))

TX = {
 "voxel_title": ("Du pixel au voxel", "From pixel to voxel"),
 "pixel2d": ("Un pixel : un carré de l'image 2D", "A pixel: one square of a 2D image"),
 "voxel3d": ("Un voxel : une petite boîte 3D", "A voxel: a small 3D box"),
 "vox_note": ("Ici le voxel est « allongé » : 1,2 × 1,2 × 3,0 µm", "Here the voxel is stretched: 1.2 × 1.2 × 3.0 µm"),
 "vox_note2": ("(anisotrope : plus épais en Z qu'en X et Y)", "(anisotropic: thicker in Z than in X and Y)"),
 "x_axis": ("X : 1,2 µm", "X: 1.2 µm"), "y_axis": ("Y : 1,2 µm", "Y: 1.2 µm"), "z_axis": ("Z : 3,0 µm", "Z: 3.0 µm"),
 "one_value": ("une valeur de gris", "one grey value"),
 "pile_title": ("Une pile confocale : 112 coupes empilées le long de Z", "A confocal stack: 112 slices stacked along Z"),
 "slice": ("coupe", "slice"), "dots": ("…", "…"),
 "step3": ("pas de 3,0 µm", "3.0 µm step"), "depth": ("épaisseur totale 336 µm", "total thickness 336 µm"),
 "slice_size": ("768 × 576 voxels", "768 × 576 voxels"),
 "tree_title": ("L'intérieur d'un fichier .ims (HDF5) : ce que le pipeline lit", "Inside an .ims file (HDF5): what the pipeline reads"),
 "tree_root": ("fichier .ims", ".ims file"),
 "t_info": ("Description de l'image", "Image description"),
 "t_xyz": ("X, Y, Z : nombre de voxels (768, 576, 112)", "X, Y, Z: number of voxels (768, 576, 112)"),
 "t_ext": ("ExtMin0-2 / ExtMax0-2 : bords de la boîte (µm)", "ExtMin0-2 / ExtMax0-2: box edges (µm)"),
 "t_unit": ("Unit : unité de ces bords (« um »)", "Unit: unit of these edges (\"um\")"),
 "t_chan": ("Un groupe par canal ; attribut Name", "One group per channel; attribute Name"),
 "t_chan_v": ("DAPI, Pecam1, Sox2", "DAPI, Pecam1, Sox2"),
 "t_time": ("Heure de chaque image (TimePoint1…N)", "Clock time of each frame (TimePoint1…N)"),
 "t_data": ("Les voxels : tableau 3D (Z, Y, X)", "The voxels: 3D array (Z, Y, X)"),
 "t_res": ("niveau 0 = pleine résolution (le seul lu)", "level 0 = full resolution (the only one read)"),
 "t_res1": ("niveaux 1, 2… = pyramide d'Imaris (ignorée)", "levels 1, 2… = Imaris pyramid (ignored)"),
 "t_u16": ("entiers 16 bits : 0 à 65 535", "16-bit integers: 0 to 65,535"),
 "metadata": ("MÉTADONNÉES", "METADATA"), "voxels": ("VOXELS", "VOXELS"),
 "calib_title": ("Calibration : la taille du voxel se déduit de la boîte", "Calibration: the voxel size is deduced from the box"),
 "c_box": ("La boîte, en µm", "The box, in µm"),
 "c_div": ("÷ nombre de voxels", "÷ number of voxels"),
 "c_eq": ("= taille d'un voxel", "= size of one voxel"),
 "c_formula": ("voxel = (ExtMax − ExtMin) ÷ N", "voxel = (ExtMax − ExtMin) ÷ N"),
 "time_title": ("Horloge d'une acquisition : l'intervalle est la médiane des écarts", "Clock of a time series: the interval is the median of the gaps"),
 "t_gap": ("écart 30 min", "gap 30 min"), "t_med": ("médiane = 30 min → time_interval_minutes", "median = 30 min → time_interval_minutes"),
 "frame": ("image", "frame"),
 "chan_dapi": ("DAPI (noyaux)", "DAPI (nuclei)"), "chan_pec": ("Pecam1 (vaisseaux)", "Pecam1 (vessels)"),
 "chan_sox": ("Sox2 (neural)", "Sox2 (neural)"), "chan_comp": ("Les trois superposés", "The three overlaid"),
 "chan_sup": ("Coupe z = 56, jeu de démonstration", "Slice z = 56, demonstration set"),
 "prof_title": ("Même profil de signal en 16 bits et en 8 bits", "The same signal profile in 16 bits and in 8 bits"),
 "prof_x": ("position le long d'une ligne de 60 voxels", "position along a 60-voxel line"),
 "prof_y": ("valeur de gris (échelle 16 bits)", "grey value (16-bit scale)"),
 "prof_16": ("16 bits : 65 536 niveaux", "16 bits: 65,536 levels"),
 "prof_8": ("8 bits (0-255) : marches de 256", "8 bits (0-255): steps of 256"),
}
def T(k): return TX[k][0 if LANG == "fr" else 1]
def esc(s): return html.escape(s, quote=False)
INK, INK2, LINE, BG = "#1c2333", "#4a5468", "#c5cbd8", "#f8f9fd"
ACC = {"blue": ("#3b5bdb", "#e8edff"), "green": ("#2b8a3e", "#ebfbee"), "amber": ("#e67700", "#fff4e6"),
       "violet": ("#7048e8", "#f3f0ff"), "teal": ("#0c8599", "#e3fafc"), "red": ("#c92a2a", "#fff0f0")}

class Svg:
    def __init__(s, h, title=None):
        s.h = h; s.p = []
        s.p.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 {h}" font-family="Inter, sans-serif">'
                   '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
                   f'<path d="M0,0 L10,5 L0,10 z" fill="{INK2}"/></marker></defs>')
        s.p.append(f'<rect width="800" height="{h}" rx="16" fill="{BG}"/>')
        if title: s.text(400, 34, title, 18, 800, INK, "middle")
    def add(s, x): s.p.append(x)
    def rect(s, x, y, w, h, fill="#fff", stroke=LINE, rx=10, sw=1.2, extra=""):
        s.p.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}" {extra}/>')
    def text(s, x, y, t, size=13, w=400, fill=INK, anchor="start", extra=""):
        s.p.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{w}" fill="{fill}" text-anchor="{anchor}" {extra}>{esc(t)}</text>')
    def line(s, x1, y1, x2, y2, stroke=INK2, sw=2, arrow=False, dash=None):
        a = ' marker-end="url(#arr)"' if arrow else ""
        d = f' stroke-dasharray="{dash}"' if dash else ""
        s.p.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{stroke}" stroke-width="{sw}"{a}{d}/>')
    def poly(s, pts, fill, stroke=INK2, sw=1.2):
        s.p.append('<polygon points="%s" fill="%s" stroke="%s" stroke-width="%s"/>' % (" ".join(f"{x},{y}" for x, y in pts), fill, stroke, sw))
    def save(s, name):
        (OUT / name).write_text("\n".join(s.p) + "\n</svg>\n", encoding="utf-8")

# ---------------------------------------------------------------- 1. pixel -> voxel
def fig_voxel():
    s = Svg(330, T("voxel_title"))
    # 2D grid
    s.text(190, 70, T("pixel2d"), 14, 700, INK, "middle")
    ox, oy, c = 100, 90, 36
    rng = np.random.default_rng(3)
    for i in range(5):
        for j in range(5):
            g = int(60 + 150 * rng.random())
            s.add(f'<rect x="{ox+j*c}" y="{oy+i*c}" width="{c}" height="{c}" fill="rgb({g},{g},{g})" stroke="#fff" stroke-width="1"/>')
    s.add(f'<rect x="{ox+2*c}" y="{oy+2*c}" width="{c}" height="{c}" fill="none" stroke="{ACC["red"][0]}" stroke-width="3"/>')
    s.text(190, 290, T("one_value"), 13, 700, ACC["red"][0], "middle")
    s.line(310, 180, 400, 180, arrow=True)
    # 3D voxel (oblique projection)
    s.text(590, 70, T("voxel3d"), 14, 700, INK, "middle")
    x0, y0, w, h, d = 480, 150, 70, 70, 100
    dx, dy = 0.5 * d, -0.5 * d
    s.poly([(x0, y0), (x0 + w, y0), (x0 + w, y0 + h), (x0, y0 + h)], ACC["blue"][1], ACC["blue"][0], 2)
    s.poly([(x0, y0), (x0 + dx, y0 + dy), (x0 + w + dx, y0 + dy), (x0 + w, y0)], "#d0dcff", ACC["blue"][0], 2)
    s.poly([(x0 + w, y0), (x0 + w + dx, y0 + dy), (x0 + w + dx, y0 + h + dy), (x0 + w, y0 + h)], "#bccbff", ACC["blue"][0], 2)
    s.text(x0 + w / 2, y0 + h + 22, T("x_axis"), 13, 700, ACC["blue"][0], "middle")
    s.text(x0 - 10, y0 + h / 2 + 5, T("y_axis"), 13, 700, ACC["blue"][0], "end")
    s.text(x0 + w + dx + 8, y0 + dy + h / 2 + 30, T("z_axis"), 13, 700, ACC["red"][0])
    s.text(590, 285, T("vox_note"), 13, 700, INK, "middle")
    s.text(590, 304, T("vox_note2"), 12, 400, INK2, "middle")
    s.save("voxel.svg")

# ---------------------------------------------------------------- 2. stack of slices
def fig_pile():
    s = Svg(330, T("pile_title"))
    n = 9; x0, y0, w, h = 250, 250, 220, 110; dx, dy = 60, -14
    for i in range(n):
        x = x0 + i * 12; y = y0 - i * 22
        col = ACC["blue"][1] if i % 2 == 0 else "#dbe4ff"
        s.poly([(x, y), (x + w, y), (x + w + dx, y + dy), (x + dx, y + dy)], col, ACC["blue"][0], 1.2)
    # front-most (first) slice label
    s.text(x0 - 12, y0 + 18, f"{T('slice')} 1", 13, 700, INK, "end")
    s.text(x0 + 8 * 12 - 12, y0 - 8 * 22 + 4, f"{T('slice')} 112", 13, 700, INK, "end")
    s.text(x0 + w / 2 + 6, y0 + 22, T("slice_size"), 13, 600, INK2, "middle")
    # z axis
    s.line(640, 258, 640, 76, ACC["red"][0], 2.5, True)
    s.text(652, 100, "Z", 15, 800, ACC["red"][0])
    s.text(652, 180, T("step3"), 13, 600, INK2)
    s.text(652, 200, T("depth"), 13, 600, INK2)
    s.save("pile.svg")

# ---------------------------------------------------------------- 3. HDF5 tree
def fig_tree():
    s = Svg(520, T("tree_title"))
    def node(x, y, w, label, kind="grp", sub=None, color="blue"):
        st, so = ACC[color]
        s.rect(x, y, w, 30 if not sub else 44, so, st, 8, 1.4)
        s.text(x + 10, y + 20, label, 13, 700, st)
        if sub: s.text(x + 10, y + 37, sub, 11.5, 400, INK2)
    s.text(40, 66, T("tree_root"), 14, 800, INK)
    s.line(60, 74, 60, 480, LINE, 2)
    # DataSetInfo
    s.line(60, 100, 90, 100, LINE, 2)
    node(90, 84, 200, "DataSetInfo", color="violet"); s.text(310, 104, T("metadata"), 11.5, 800, ACC["violet"][0])
    s.line(110, 114, 110, 262, LINE, 2)
    items = [(142, "DataSetInfo/Image", T("t_info")), ]
    s.line(110, 140, 135, 140, LINE, 2)
    node(135, 126, 190, "Image", color="violet"); s.text(335, 136, T("t_xyz"), 12, 400, INK)
    s.text(335, 152, T("t_ext"), 12, 400, INK); s.text(335, 168, T("t_unit"), 12, 400, INK)
    s.line(110, 196, 135, 196, LINE, 2)
    node(135, 182, 190, "Channel 0, 1, 2…", color="violet"); s.text(335, 196, T("t_chan"), 12, 400, INK); s.text(335, 212, T("t_chan_v"), 12, 600, INK2)
    s.line(110, 252, 135, 252, LINE, 2)
    node(135, 238, 190, "TimeInfo", color="violet"); s.text(335, 254, T("t_time"), 12, 400, INK)
    # DataSet
    s.line(60, 300, 90, 300, LINE, 2)
    node(90, 284, 200, "DataSet", color="teal"); s.text(310, 304, T("voxels"), 11.5, 800, ACC["teal"][0])
    s.line(110, 314, 110, 440, LINE, 2)
    s.line(110, 340, 135, 340, LINE, 2)
    node(135, 326, 240, "ResolutionLevel 0", color="teal"); s.text(385, 346, T("t_res"), 12, 400, INK)
    s.line(155, 356, 155, 410, LINE, 2)
    s.line(155, 380, 180, 380, LINE, 2)
    node(180, 366, 200, "TimePoint 0, 1, 2…", color="teal")
    s.line(200, 396, 200, 420, LINE, 2); s.line(200, 420, 225, 420, LINE, 2)
    node(225, 406, 190, "Channel 0, 1, 2…", color="teal")
    s.line(245, 436, 245, 456, LINE, 2); s.line(245, 456, 270, 456, LINE, 2)
    s.rect(270, 440, 150, 32, "#fff4e6", ACC["amber"][0], 8, 1.8)
    s.text(282, 461, "Data", 14, 800, ACC["amber"][0])
    s.text(430, 453, T("t_u16"), 12, 400, INK); s.text(430, 470, "(112, 576, 768)", 12, 600, INK2)
    s.line(110, 498, 135, 498, LINE, 2)
    s.line(110, 440, 110, 498, LINE, 2)
    s.rect(135, 484, 270, 28, "#f1f3f5", LINE, 8, 1.2, 'stroke-dasharray="5 4"')
    s.text(145, 503, "ResolutionLevel 1, 2…", 13, 700, "#868e96"); s.text(415, 503, T("t_res1"), 12, 400, "#868e96")
    s.h = 530
    s.p[0] = s.p[0].replace('0 0 800 520', '0 0 800 530'); s.p[1] = s.p[1].replace('height="520"', 'height="530"')
    s.save("arbre.svg")

# ---------------------------------------------------------------- 4. calibration
def fig_calib():
    s = Svg(290, T("calib_title"))
    s.text(400, 62, T("c_formula"), 17, 800, ACC["blue"][0], "middle")
    cols = [("X", "921,6 µm", "768", "1,2 µm") if LANG == "fr" else ("X", "921.6 µm", "768", "1.2 µm"),
            ("Y", "691,2 µm", "576", "1,2 µm") if LANG == "fr" else ("Y", "691.2 µm", "576", "1.2 µm"),
            ("Z", "336,0 µm", "112", "3,0 µm") if LANG == "fr" else ("Z", "336.0 µm", "112", "3.0 µm")]
    for i, (ax, box, n, v) in enumerate(cols):
        x = 40 + i * 245
        s.rect(x, 85, 225, 175, "#fff", LINE, 14)
        s.text(x + 112, 112, ax, 18, 800, INK, "middle")
        s.text(x + 112, 138, T("c_box"), 11.5, 400, INK2, "middle")
        s.text(x + 112, 160, box, 17, 700, ACC["amber"][0], "middle")
        s.text(x + 112, 186, T("c_div"), 11.5, 400, INK2, "middle")
        s.text(x + 112, 208, n, 17, 700, ACC["violet"][0], "middle")
        s.line(x + 40, 218, x + 185, 218, LINE, 1.5)
        s.text(x + 112, 244, "= " + v, 19, 800, ACC["green"][0], "middle")
    s.save("calibration.svg")

# ---------------------------------------------------------------- 5. timestamps
def fig_time():
    s = Svg(200, T("time_title"))
    xs = [100, 300, 500, 700]; stamps = ["09:00", "09:30", "10:00", "10:30"]
    s.line(60, 100, 740, 100, LINE, 3)
    for i, (x, t) in enumerate(zip(xs, stamps)):
        s.add(f'<circle cx="{x}" cy="100" r="13" fill="{ACC["blue"][1]}" stroke="{ACC["blue"][0]}" stroke-width="2.5"/>')
        s.text(x, 105, str(i + 1), 13, 800, ACC["blue"][0], "middle")
        s.text(x, 70, t, 15, 800, INK, "middle")
        s.text(x, 134, f"TimePoint{i+1}", 12, 400, INK2, "middle")
        if i < 3:
            s.text(x + 100, 90, T("t_gap"), 12, 700, ACC["green"][0], "middle")
    s.rect(210, 150, 380, 32, ACC["green"][1], ACC["green"][0], 16)
    s.text(400, 171, T("t_med"), 13, 700, ACC["green"][0], "middle")
    s.save("horloge.svg")

# ---------------------------------------------------------------- data figures
def load_vol(c):
    f = h5py.File(IMS / "Embryo-E95-Em2-Pecam1-Sox2.ims", "r")
    return f[f"DataSet/ResolutionLevel 0/TimePoint 0/Channel {c}/Data"][:]

def fig_channels():
    vols = [load_vol(c) for c in range(3)]
    z = 56
    plt.rcParams["font.family"] = "Inter"
    fig, ax = plt.subplots(1, 4, figsize=(11, 3.4), dpi=170)
    titles = [T("chan_dapi"), T("chan_pec"), T("chan_sox"), T("chan_comp")]
    cols = [(0.2, 0.45, 1.0), (1.0, 0.2, 0.2), (0.15, 0.9, 0.3)]
    rgb = np.zeros(vols[0].shape[1:] + (3,))
    for i, v in enumerate(vols):
        sl = v[z].astype(float); hi = np.percentile(v[::4, ::4, ::4], 99.9)
        n = np.clip(sl / hi, 0, 1)
        ax[i].imshow(n, cmap="gray", vmin=0, vmax=1)
        rgb += n[..., None] * np.array(cols[i])
    ax[3].imshow(np.clip(rgb, 0, 1))
    for a, t in zip(ax, titles):
        a.set_title(t, fontsize=10, color=INK); a.axis("off")
    fig.suptitle(T("chan_sup"), fontsize=9, color=INK2, y=0.02)
    fig.tight_layout(); fig.savefig(OUT / "canaux.png", facecolor="white"); plt.close(fig)

def fig_profile():
    v = load_vol(1)
    sl = v[56].astype(float)
    # strongest local contrast line segment of 60 voxels
    best = None
    for y in range(40, 530, 7):
        for x in range(100, 640, 20):
            part = sl[y, x:x + 60]; r = part.max() - part.min()
            if part.min() < 2500 and (best is None or abs(r - 5000) < abs(best[0] - 5000)): best = (r, y, x)
    _, y, x = best
    prof = sl[y, x:x + 60]
    q8 = np.floor(prof / 256) * 256
    plt.rcParams["font.family"] = "Inter"
    fig, ax = plt.subplots(figsize=(8, 3.3), dpi=170)
    ax.plot(prof, color="#3b5bdb", lw=2, label=T("prof_16"))
    ax.step(range(60), q8, where="mid", color="#e67700", lw=2, label=T("prof_8"))
    ax.set_xlabel(T("prof_x")); ax.set_ylabel(T("prof_y")); ax.set_title(T("prof_title"), fontsize=11, color=INK)
    ax.legend(frameon=False, fontsize=9); ax.grid(alpha=.25)
    for sp in ("top", "right"): ax.spines[sp].set_visible(False)
    fig.tight_layout(); fig.savefig(OUT / "profondeur.png", facecolor="white"); plt.close(fig)
    print("profile", y, x, prof.min(), prof.max(), "levels16", len(np.unique(prof)), "levels8", len(np.unique(q8)))

if __name__ == "__main__":
    fig_voxel(); fig_pile(); fig_tree(); fig_calib(); fig_time(); fig_channels(); fig_profile()
