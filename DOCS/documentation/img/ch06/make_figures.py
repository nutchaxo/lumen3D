#!/usr/bin/env python3
"""Figures of chapter 6 (reducing the size without losing anything important).

  FIG_LANG=fr|en   language of every text drawn in the figures (default fr)
  IMG_DIR=<dir>    output folder (default: the folder of this script)
  IMS_DIR=<dir>    folder holding the demonstration .ims files
  CACHE_DIR=<dir>  folder holding u8_c<channel>.npy = the pipeline's 8-bit result (written by chapter 5's script)
Regenerate the English set:
  FIG_LANG=en IMG_DIR=DOCS/documentation/img-en/ch06 python3 DOCS/documentation/img/ch06/make_figures.py
Every data figure is computed from the synthetic demonstration embryo, with the pipeline's own
functions (preprocess/bricks_v3_writer.py: level_ladder, reduce_level, brick_with_apron, mosaic_9x8).
"""
import os, sys, pathlib, html, importlib.util
import numpy as np, h5py
from scipy import ndimage as ndi
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

LANG = os.environ.get("FIG_LANG", "fr")
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2] if (HERE.parents[2] / "preprocess").exists() else pathlib.Path("/home/user/lumen3D")
OUT = pathlib.Path(os.environ.get("IMG_DIR", HERE)); OUT.mkdir(parents=True, exist_ok=True)
IMS = pathlib.Path(os.environ.get("IMS_DIR", "/tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad/ims"))
CACHE = pathlib.Path(os.environ.get("CACHE_DIR", "/tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad/w-c/tmp"))
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

plt.rcParams["font.family"] = "Inter"
DATASET = "Embryo-E95-Em2-Pecam1-Sox2"
PUB = ROOT / "DATA_WEB" / "3d" / DATASET
CHN = ["DAPI", "Pecam1", "Sox2"]

TX = {
 "bud_title": ("Le budget de taille, étape par étape (jeu de démonstration, 3 canaux)", "The size budget, step by step (demonstration set, 3 channels)"),
 "bud_x": ("taille en mégaoctets (Mo), échelle logarithmique", "size in megabytes (MB), logarithmic scale"),
 "b1": ("1. Voxels bruts, 16 bits", "1. Raw voxels, 16 bits"),
 "b2": ("2. Convertis en 8 bits", "2. Converted to 8 bits"),
 "b3": ("3. + pyramide (4 niveaux)", "3. + pyramid (4 levels)"),
 "b4": ("4. Briques non vides seules\n(avec leur bord de 1 voxel)", "4. Non-empty bricks only\n(with their 1-voxel border)"),
 "b5": ("5. Compressées sans perte (WebP)", "5. Compressed losslessly (WebP)"),
 "b_ims": ("Le fichier .ims d'origine", "The original .ims file"),
 "pyr_title": ("La pyramide de résolutions : même coupe projetée (MIP), niveaux 0 à 3", "The resolution pyramid: same projection (MIP), levels 0 to 3"),
 "lvl": ("Niveau {}", "Level {}"),
 "px": ("{} × {} × {} voxels", "{} × {} × {} voxels"),
 "vox": ("voxel {} × {} × {} µm", "voxel {} × {} × {} µm"),
 "nb": ("{} briques", "{} bricks"),
 "z_kept": ("Z gardé", "Z kept"), "z_half": ("Z divisé par 2", "Z halved"),
 "blk_title": ("Réduire : la moyenne d'un bloc 2 × 2 × 2 (valeurs réelles du jeu de démonstration)", "Reducing: the mean of a 2 × 2 × 2 block (real values from the demonstration set)"),
 "blk_a": ("coupe z", "slice z"), "blk_b": ("coupe z + 1", "slice z + 1"),
 "blk_sum": ("somme des 8 valeurs = {}", "sum of the 8 values = {}"),
 "blk_half": ("+ 4 (pour arrondir au plus proche)", "+ 4 (to round to the nearest)"),
 "blk_div": ("÷ 8, partie entière : ({} + 4) ÷ 8 = {}", "÷ 8, integer part: ({} + 4) ÷ 8 = {}"),
 "blk_res": ("→ 1 voxel du niveau suivant : {}", "→ 1 voxel of the next level: {}"),
 "cmp_title": ("Même brique, quatre façons de l'enregistrer (moyenne sur {} briques du niveau 0)", "The same brick saved four ways (mean over {} level-0 bricks)"),
 "cmp_y": ("taille moyenne d'une brique (Ko)", "mean size of one brick (KB)"),
 "c_raw": ("brut\n(non compressé)", "raw\n(uncompressed)"), "c_png": ("PNG\nsans perte", "PNG\nlossless"),
 "c_webp": ("WebP\nsans perte", "WebP\nlossless"), "c_jpg": ("JPEG q90\navec perte", "JPEG q90\nlossy"),
 "c_exact": ("identique", "identical"), "c_err": ("erreur max {}", "max error {}"),
 "art_title": ("Ce que fait JPEG à une coupe de brique (zoom)", "What JPEG does to a brick slice (zoom)"),
 "art_orig": ("Original (= WebP / PNG)", "Original (= WebP / PNG)"), "art_jpg": ("Après JPEG q90", "After JPEG q90"),
 "art_diff": ("Différence × 8", "Difference × 8"),
 "ess_title": ("Briques stockées (vert) et briques vides non stockées (rouge) : niveau 0, canal {}", "Stored bricks (green) and empty bricks not stored (red): level 0, channel {}"),
 "ess_layer": ("Couche de briques z = {} (coupes {}–{})", "Brick layer z = {} (slices {}–{})"),
 "ess_n": ("{} briques stockées sur {}", "{} bricks stored out of {}"),
 "fin_title": ("Taille finale : du .ims au dossier publié", "Final size: from the .ims to the published folder"),
 "f_ims": ("Fichier .ims d'origine\n(compressé par Imaris)", "Original .ims file\n(compressed by Imaris)"),
 "f_8": ("Voxels 8 bits\nnon compressés", "8-bit voxels\nuncompressed"),
 "f_pub": ("Dossier publié\n(sans download/)", "Published folder\n(without download/)"),
 "f_br": ("dont bricks/\n(vue 3D)", "of which bricks/\n(3D view)"),
 "d_title": ("Compression sans perte : on range la différence avec le voisin", "Lossless compression: store the difference with the neighbour"),
 "d_vals": ("Valeurs d'une ligne de pixels", "Values of a row of pixels"),
 "d_diff": ("Différence avec le voisin de gauche", "Difference with the left neighbour"),
 "d_note1": ("Les valeurs vont jusqu'à {} : il faut 8 bits chacune.", "Values go up to {}: 8 bits each."),
 "d_note2": ("Les différences restent entre {} et {} : bien moins de bits.", "The differences stay between {} and {}: far fewer bits."),
 "d_back": ("On retrouve chaque valeur en additionnant : rien n'est perdu.", "Each value is recovered by adding up: nothing is lost."),
}

# ---------------------------------------------------------------- data
sys.path.insert(0, str(ROOT / "preprocess"))
import bricks_v3_writer as v3
from PIL import Image
import io, json

def get_u8(c):
    f = CACHE / f"u8_c{c}.npy"
    if not f.exists():
        raise SystemExit(f"{f} missing: run img/ch05/make_figures.py first (it writes the 8-bit result there)")
    return np.load(f)

def fmt(x, nd=0):
    s = f"{x:,.{nd}f}"
    return s.replace(",", " ") .replace(".", ",") if LANG == "fr" else s
def fnum(x, nd=1):
    return f"{x:.{nd}f}".replace(".", ",") if LANG == "fr" else f"{x:.{nd}f}"

def build_levels(vol, ladder):
    out = [vol]
    for li in ladder[1:]:
        out.append(v3.reduce_level(out[-1], li["halveZ"]))
    return out

def style_ax(ax):
    for sp in ("top", "right"): ax.spines[sp].set_visible(False)
    ax.tick_params(labelsize=8.5)

def save_fig(fig, name):
    fig.savefig(OUT / name, facecolor="white", dpi=170); plt.close(fig)

def png_bytes(arr, best=True):
    b = io.BytesIO(); Image.fromarray(arr, "L").save(b, format="PNG", compress_level=9 if best else 6, optimize=best); return b.getvalue()
def webp_bytes(arr):
    b = io.BytesIO(); Image.fromarray(arr, "L").save(b, format="WEBP", lossless=True, quality=v3.WEBP_QUALITY, method=v3.WEBP_METHOD); return b.getvalue()
def jpg_bytes(arr, q=90):
    b = io.BytesIO(); Image.fromarray(arr, "L").save(b, format="JPEG", quality=q); return b.getvalue()

def load_all():
    vols = [get_u8(c) for c in range(3)]
    shape = vols[0].shape
    meta = json.loads((PUB / "bricks" / "manifest.json").read_text())
    vs = meta["levels"][0]["voxelSize"]
    ladder = v3.level_ladder((shape[2], shape[1], shape[0]), (vs["x"], vs["y"], vs["z"]))
    levels = [build_levels(v, ladder) for v in vols]          # levels[c][k]
    idx = v3.parse_index_bin((PUB / "bricks" / "index.bin").read_bytes())
    return vols, meta, ladder, levels, idx

def read_brick(idx, k, c, bi):
    e = idx["entries"][k][c][bi]
    if e["length"] == 0: return None
    path = PUB / "bricks" / v3.pack_rel(k, c, int(e["pack"]))
    with open(path, "rb") as f:
        f.seek(int(e["offset"])); return f.read(int(e["length"]))

def verify_pyramid(ladder, levels, idx):
    """Every stored brick of the published dataset decodes to exactly the brick rebuilt here."""
    bad = tot = 0; nonstored_ok = True
    for k, (gx, gy, gz, _) in enumerate(idx["levels"]):
        for c in range(3):
            for bz in range(gz):
                for by in range(gy):
                    for bx in range(gx):
                        bi = (bz * gy + by) * gx + bx
                        mine = v3.brick_with_apron(levels[c][k], bx, by, bz)
                        data = read_brick(idx, k, c, bi)
                        if data is None:
                            nonstored_ok &= not v3.brick_kept(mine); continue
                        tot += 1
                        if not np.array_equal(v3.decode_brick(data), mine) or webp_bytes(v3.mosaic_9x8(mine)) != data: bad += 1
    return tot, bad, nonstored_ok

# ---------------------------------------------------------------- figures
def fig_budget(ladder, idx):
    X, Y, Z = 768, 576, 112
    raw16 = 3 * X * Y * Z * 2
    raw8 = raw16 // 2
    pyr = 3 * sum(li["dimensions"]["x"] * li["dimensions"]["y"] * li["dimensions"]["z"] for li in ladder)
    stored = sum(int((e["length"] > 0).sum()) for e in idx["entries"])
    stored_b = stored * v3.SLICE ** 3
    on_disk = int(sum(int(e["length"].sum()) for e in idx["entries"]))
    ims = (IMS / (DATASET + ".ims")).stat().st_size
    vals = [raw16, raw8, pyr, stored_b, on_disk]
    keys = ["b1", "b2", "b3", "b4", "b5"]
    cols = ["#868e96", "#3b5bdb", "#7048e8", "#e67700", "#2b8a3e"]
    fig, ax = plt.subplots(figsize=(10, 4))
    ys = np.arange(len(vals))[::-1]
    ax.barh(ys, [v / 1e6 for v in vals], color=cols, height=.62)
    ax.set_xscale("log"); ax.set_xlim(1, 2500)
    ax.set_yticks(ys); ax.set_yticklabels([T(k) for k in keys], fontsize=9)
    for y, v in zip(ys, vals):
        ax.text(v / 1e6 * 0.9, y, fnum(v / 1e6, 1) + (" Mo" if LANG == "fr" else " MB"), va="center", ha="right", fontsize=10, fontweight="bold", color="#fff")
    ax.axvline(ims / 1e6, color="#c92a2a", ls="--", lw=1.4, zorder=0.5)
    ax.text(ims / 1e6 * 1.05, 4.5, T("b_ims") + " : " + fnum(ims / 1e6, 1) + (" Mo" if LANG == "fr" else " MB"), color="#c92a2a", fontsize=8.5, va="center")
    ax.set_xlabel(T("bud_x"), fontsize=9); ax.set_title(T("bud_title"), fontsize=10.5, color=INK); ax.set_ylim(-.6, 4.8)
    style_ax(ax); fig.tight_layout(); save_fig(fig, "budget.png")
    return dict(raw16=raw16, raw8=raw8, pyr=pyr, stored=stored, stored_b=stored_b, on_disk=on_disk, ims=ims)

def fig_pyramid(ladder, levels, meta):
    nb = [l["brickCount"] for l in meta["levels"]]
    mips = [levels[0][k].max(0) for k in range(len(ladder))]
    W = [max(li["dimensions"]["x"], 250) for li in ladder]
    fig = plt.figure(figsize=(11, 3.9))
    gs = fig.add_gridspec(1, len(ladder), width_ratios=W, wspace=0.06, left=0.01, right=0.99, top=0.82, bottom=0.2)
    for k, li in enumerate(ladder):
        a = fig.add_subplot(gs[0, k]); a.imshow(mips[k], cmap="gray", vmin=0, vmax=255, interpolation="nearest"); a.set_xticks([]); a.set_yticks([])
        for sp in a.spines.values(): sp.set_color("#c5cbd8")
        d = li["dimensions"]; v = li["voxelSize"]
        a.set_title(T("lvl").format(k), fontsize=10.5, color=INK, fontweight="bold")
        a.set_xlabel(T("px").format(d["x"], d["y"], d["z"]) + "\n" + T("vox").format(fnum(v["x"]), fnum(v["y"]), fnum(v["z"])) + "\n" + T("nb").format(nb[k]) + (("\n" + (T("z_half") if li["halveZ"] else T("z_kept"))) if k else ""), fontsize=7.8, color=INK2, labelpad=3)
    fig.suptitle(T("pyr_title"), fontsize=10.5, color=INK, y=0.97)
    save_fig(fig, "pyramide.png")

def fig_block(levels, ladder):
    v0 = levels[0][0]; v1 = levels[0][1]
    best = None
    for z in range(10, 100, 2):
        for y in range(100, 500, 2):
            for x in range(100, 700, 2):
                pass
    # search tissue blocks with distinct values and a half-up rounding visible (sum % 8 >= 4)
    rng = np.random.default_rng(5)
    cand = []
    for _ in range(4000):
        z, y, x = 2 * rng.integers(10, 50), 2 * rng.integers(50, 250), 2 * rng.integers(50, 350)
        blk = v0[z:z + 2, y:y + 2, x:x + 2].astype(int)
        if 70 <= blk.mean() <= 160 and blk.std() > 18 and blk.sum() % 8 >= 4:
            cand.append((z, y, x, blk))
            if len(cand) > 5: break
    z, y, x, blk = cand[0]
    s = int(blk.sum()); res = (s + 4) // 8
    assert res == int(v1[z // 2, y // 2, x // 2]) and res == int(v3.reduce_level(v0[z:z + 2, y:y + 2, x:x + 2], True)[0, 0, 0])
    svg = Svg(300, T("blk_title"))
    for k in range(2):
        ox = 60 + k * 190
        s_ = svg
        s_.text(ox + 70, 70, T("blk_a") if k == 0 else T("blk_b"), 13, 700, INK, "middle")
        for i in range(2):
            for j in range(2):
                val = int(blk[k, i, j]); g = int(40 + val * 0.75)
                s_.add(f'<rect x="{ox+j*70}" y="{82+i*50}" width="70" height="50" fill="rgb({g},{g},{g})" stroke="#fff" stroke-width="2"/>')
                s_.text(ox + j * 70 + 35, 82 + i * 50 + 31, str(val), 17, 800, "#fff" if g < 140 else INK, "middle")
    svg.line(445, 132, 495, 132, INK2, 2.4, True)
    svg.rect(505, 82, 270, 100, ACC["green"][1], ACC["green"][0], 12, 1.8)
    svg.text(640, 112, T("blk_sum").format(s), 13, 700, INK, "middle")
    svg.text(640, 134, T("blk_half"), 12, 400, INK2, "middle")
    svg.text(640, 160, T("blk_div").format(s, res), 12.5, 700, ACC["green"][0], "middle")
    svg.text(400, 235, T("blk_res").format(res), 17, 800, ACC["green"][0], "middle")
    svg.save("bloc.svg")
    return (z, y, x), blk.ravel().tolist(), s, res

def fig_compression(levels, idx):
    rows = []; rng = np.random.default_rng(1)
    mos = []
    gx, gy, gz, _ = idx["levels"][0]
    for c in range(3):
        for bz in range(gz):
            for by in range(gy):
                for bx in range(gx):
                    b = v3.brick_with_apron(levels[c][0], bx, by, bz)
                    if v3.brick_kept(b): mos.append((c, bx, by, bz, v3.mosaic_9x8(b)))
    sizes = {"raw": [], "png": [], "png6": [], "webp": [], "jpg": []}
    maxerr = 0; altered = 0; zero_alt = 0; nvox = 0; nzero = 0
    for (c, bx, by, bz, m) in mos:
        sizes["raw"].append(m.size); sizes["png"].append(len(png_bytes(m))); sizes["png6"].append(len(png_bytes(m, False)))
        sizes["webp"].append(len(webp_bytes(m)))
        jb = jpg_bytes(m); sizes["jpg"].append(len(jb))
        d = np.asarray(Image.open(io.BytesIO(jb))).astype(int)
        err = np.abs(d - m.astype(int)); maxerr = max(maxerr, int(err.max())); altered += int((err > 0).sum()); nvox += m.size
        z0 = m == 0; nzero += int(z0.sum()); zero_alt += int((err[z0] > 0).sum())
    mean = {k: float(np.mean(v)) for k, v in sizes.items()}
    keys = ["raw", "png", "webp", "jpg"]; labels = ["c_raw", "c_png", "c_webp", "c_jpg"]
    cols = ["#868e96", "#7048e8", "#2b8a3e", "#e67700"]
    fig, ax = plt.subplots(figsize=(8.6, 4.1))
    xs = np.arange(4)
    ax.bar(xs, [mean[k] / 1000 for k in keys], color=cols, width=.62)
    for x, k in zip(xs, keys):
        ax.text(x, mean[k] / 1000 + 5, fnum(mean[k] / 1000, 1) + (" Ko" if LANG == "fr" else " KB"), ha="center", fontsize=10, fontweight="bold", color=INK)
    ax.text(2, mean["webp"] / 1000 / 2, T("c_exact"), ha="center", color="#fff", fontsize=9, fontweight="bold")
    ax.text(1, mean["png"] / 1000 / 2, T("c_exact"), ha="center", color="#fff", fontsize=9, fontweight="bold")
    ax.text(3, mean["jpg"] / 1000 / 2, T("c_err").format(maxerr), ha="center", color="#fff", fontsize=9, fontweight="bold")
    ax.set_xticks(xs); ax.set_xticklabels([T(l) for l in labels], fontsize=9.5)
    ax.set_ylabel(T("cmp_y"), fontsize=9); ax.set_title(T("cmp_title").format(len(mos)), fontsize=10.5, color=INK)
    ax.set_ylim(0, mean["raw"] / 1000 * 1.12); style_ax(ax); fig.tight_layout(); save_fig(fig, "compression.png")
    # artefacts: the slice cell where JPEG's error is largest (thin bright structures), zoomed
    bestc = None
    for (c, bx, by, bz, m) in mos:
        if c != 1: continue
        jb_ = np.asarray(Image.open(io.BytesIO(jpg_bytes(m)))).astype(int)
        for r in range(8):
            for cc in range(9):
                if r * 9 + cc >= 66: continue
                cl = m[66 * r:66 * (r + 1), 66 * cc:66 * (cc + 1)].astype(int)
                e_ = np.abs(jb_[66 * r:66 * (r + 1), 66 * cc:66 * (cc + 1)] - cl)
                sc = int(e_.max()) * 1000 + int((cl > 0).sum() > 100) * int((e_ > 0).sum())
                if bestc is None or sc > bestc[0]: bestc = (sc, c, bx, by, bz, r, cc, m)
    _, c, bx, by, bz, r, cc, m = bestc
    cell = m[66 * r:66 * (r + 1), 66 * cc:66 * (cc + 1)]
    jb = np.asarray(Image.open(io.BytesIO(jpg_bytes(m)))).astype(int)[66 * r:66 * (r + 1), 66 * cc:66 * (cc + 1)]
    diff = np.abs(jb - cell.astype(int))
    yy, xx = np.unravel_index(np.argmax(diff), diff.shape)
    y0 = int(np.clip(yy - 20, 0, 66 - 40)); x0 = int(np.clip(xx - 20, 0, 66 - 40))
    cr = (slice(y0, y0 + 40), slice(x0, x0 + 40))
    fig, ax = plt.subplots(1, 3, figsize=(10, 3.7))
    ax[0].imshow(cell[cr], cmap="gray", vmin=0, vmax=255, interpolation="nearest"); ax[0].set_title(T("art_orig"), fontsize=10, color=INK)
    ax[1].imshow(jb[cr], cmap="gray", vmin=0, vmax=255, interpolation="nearest"); ax[1].set_title(T("art_jpg"), fontsize=10, color=INK)
    ax[2].imshow(np.clip(diff[cr] * 8, 0, 255), cmap="magma", vmin=0, vmax=255, interpolation="nearest"); ax[2].set_title(T("art_diff"), fontsize=10, color=INK)
    for a in ax: a.axis("off")
    fig.suptitle(T("art_title"), fontsize=10.5, color=INK)
    fig.tight_layout(); save_fig(fig, "jpeg_artefacts.png")
    return dict(n=len(mos), mean=mean, maxerr=maxerr, altered_pct=100 * altered / nvox, zero_alt=zero_alt, nzero=nzero,
                best_cell=(c, bx, by, bz, r, cc, int(diff.max()), int((diff[cr] > 0).sum()), int(diff[cr].size)))

def fig_delta(levels):
    v = levels[2][0]          # Sox2
    best = None
    for z in (30,):
        for y in range(300, 576, 2):
            for x in range(100, 740, 2):
                seg = v[z, y, x:x + 14].astype(int)
                d = np.diff(seg)
                if seg.min() >= 50 and seg.max() - seg.min() >= 12 and np.abs(d).max() <= 7:
                    sc = np.abs(d).max() - 0.01 * seg.max()
                    if best is None or sc < best[0]: best = (sc, z, y, x, seg)
    _, z, y, x, seg = best
    d = np.diff(seg)
    svg = Svg(310, T("d_title"))
    n = len(seg); w = 50
    x0 = (800 - n * w) // 2
    svg.text(40, 74, T("d_vals"), 13, 700, INK)
    for i, val in enumerate(seg):
        svg.rect(x0 + i * w, 84, w - 4, 38, ACC["blue"][1], ACC["blue"][0], 6, 1.4)
        svg.text(x0 + i * w + (w - 4) / 2, 109, str(int(val)), 15, 800, ACC["blue"][0], "middle")
    svg.text(40, 160, T("d_diff"), 13, 700, INK)
    for i in range(n):
        txt = str(int(seg[0])) if i == 0 else f"{int(d[i-1]):+d}".replace("-", "−")
        svg.rect(x0 + i * w, 170, w - 4, 38, ACC["green"][1] if i else ACC["blue"][1], ACC["green"][0] if i else ACC["blue"][0], 6, 1.4)
        svg.text(x0 + i * w + (w - 4) / 2, 195, txt, 15, 800, ACC["green"][0] if i else ACC["blue"][0], "middle")
        if i: svg.line(x0 + i * w - 2, 125, x0 + i * w - 2, 166, LINE, 1.2, False)
    svg.text(400, 240, T("d_note1").format(int(seg.max())), 13, 600, ACC["blue"][0], "middle")
    svg.text(400, 262, T("d_note2").format(f"{int(d.min()):d}".replace("-", "−"), f"+{int(d.max())}"), 13, 600, ACC["green"][0], "middle")
    svg.text(400, 288, T("d_back"), 12.5, 400, INK2, "middle")
    svg.save("difference.svg")
    return (z, y, x), seg.tolist()

def fig_ess(levels, idx, c=1):
    gx, gy, gz, _ = idx["levels"][0]
    e = idx["entries"][0][c]
    fig, ax = plt.subplots(1, gz, figsize=(5.2 * gz, 3.9))
    ax = np.atleast_1d(ax); counts = []
    for bz in range(gz):
        mip = levels[c][0][bz * 64:bz * 64 + 64].max(0)
        a = ax[bz]; a.imshow(mip, cmap="gray", vmin=0, vmax=255, interpolation="nearest")
        n_st = 0
        for by in range(gy):
            for bx in range(gx):
                st = e[(bz * gy + by) * gx + bx]["length"] > 0
                n_st += int(st)
                a.add_patch(plt.Rectangle((bx * 64 - .5, by * 64 - .5), 64, 64, fill=True, fc=(0.17, 0.54, 0.24, 0.16) if st else (0.79, 0.16, 0.16, 0.45), ec=(0.17, 0.54, 0.24, 0.9) if st else (0.79, 0.16, 0.16, 0.9), lw=1.1))
        a.set_xlim(-.5, mip.shape[1] - .5); a.set_ylim(mip.shape[0] - .5, -.5); a.axis("off")
        a.set_title(T("ess_layer").format(bz, bz * 64, min(bz * 64 + 63, levels[c][0].shape[0] - 1)) + "\n" + T("ess_n").format(n_st, gx * gy), fontsize=9.5, color=INK)
        counts.append(n_st)
    fig.suptitle(T("ess_title").format(CHN[c]), fontsize=10.5, color=INK, y=1.0)
    fig.tight_layout(); save_fig(fig, "briques_vides.png")
    return counts

def fig_final(sizes):
    base = PUB
    def tot(p): return sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.is_dir() else p.stat().st_size
    parts = {k: tot(base / k) for k in ("bricks", "planes", "mips", "thumbnail.webp", "metadata.json")}
    pub = sum(parts.values())
    vals = [sizes["ims"], sizes["raw8"], pub, parts["bricks"]]
    keys = ["f_ims", "f_8", "f_pub", "f_br"]; cols = ["#c92a2a", "#3b5bdb", "#2b8a3e", "#0c8599"]
    fig, ax = plt.subplots(figsize=(8.8, 3.8))
    ax.bar(range(4), [v / 1e6 for v in vals], color=cols, width=.6)
    for i, v in enumerate(vals):
        ax.text(i, v / 1e6 + 5, fnum(v / 1e6, 1) + (" Mo" if LANG == "fr" else " MB"), ha="center", fontsize=10, fontweight="bold", color=INK)
    ax.set_xticks(range(4)); ax.set_xticklabels([T(k) for k in keys], fontsize=9)
    ax.set_ylabel("Mo" if LANG == "fr" else "MB", fontsize=9); ax.set_title(T("fin_title"), fontsize=10.5, color=INK)
    ax.set_ylim(0, max(vals) / 1e6 * 1.12); style_ax(ax); fig.tight_layout(); save_fig(fig, "taille_finale.png")
    return parts, pub

if __name__ == "__main__":
    vols, meta, ladder, levels, idx = load_all()
    print("ladder", [(l["level"], l["dimensions"], l["voxelSize"], l["halveZ"]) for l in ladder])
    print("verify pyramid vs published bricks: stored bricks checked, mismatches, unstored really empty:", verify_pyramid(ladder, levels, idx))
    sz = fig_budget(ladder, idx); print("budget", sz)
    fig_pyramid(ladder, levels, meta)
    print("block", fig_block(levels, ladder))
    print("compression", fig_compression(levels, idx))
    print("delta", fig_delta(levels))
    print("ess counts", [fig_ess(levels, idx, c) for c in (1,)])
    print("final", fig_final(sz))
