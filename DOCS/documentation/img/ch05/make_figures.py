#!/usr/bin/env python3
"""Figures of chapter 5 (cleaning the image: removing the background noise).

  FIG_LANG=fr|en   language of every text drawn in the figures (default fr)
  IMG_DIR=<dir>    output folder (default: the folder of this script)
  IMS_DIR=<dir>    folder holding the demonstration .ims files
  CACHE_DIR=<dir>  where the pipeline's 8-bit result is cached (slow median filter)
Regenerate the English set:
  FIG_LANG=en IMG_DIR=DOCS/documentation/img-en/ch05 python3 DOCS/documentation/img/ch05/make_figures.py
Every data figure is computed from the synthetic demonstration embryo, with the pipeline's own
functions (preprocess/2-image_processor.py: corner_boxes, level_tile).
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
CH, Z = 0, 56          # channel (DAPI) and slice shown in every figure
plt.rcParams["font.family"] = "Inter"

TX = {
 # overview
 "chain_title": ("Le nettoyage d'un canal, dans l'ordre du code", "Cleaning one channel, in the order of the code"),
 "ch1": ("Fond", "Floor"), "ch1b": ("bg_floor", "bg_floor"), "ch1c": ("99e percentile\ndes 8 coins", "99th percentile\nof the 8 corners"),
 "ch2": ("Point blanc", "White point"), "ch2b": ("sig_max", "sig_max"), "ch2c": ("99,9e percentile\n1 voxel sur 4", "99.9th percentile\none voxel in 4"),
 "ch3": ("Masque", "Mask"), "ch3b": ("signal à protéger", "signal to protect"), "ch3c": ("seuil, ouverture,\ndilatation ×3", "threshold, opening,\ndilation ×3"),
 "ch4": ("Médiane", "Median"), "ch4b": ("hors du masque", "outside the mask"), "ch4c": ("3 × 3 × 3\nvoxels", "3 × 3 × 3\nvoxels"),
 "ch5": ("Fenêtre", "Window"), "ch5b": ("16 bits → 8 bits", "16 bits → 8 bits"), "ch5c": ("[bg_floor ; sig_max]\n→ [0 ; 255]", "[bg_floor ; sig_max]\n→ [0 ; 255]"),
 # corners
 "corn_title": ("Les 8 coins : du fond de caméra pur, sans embryon", "The 8 corners: pure camera background, no embryo"),
 "corn_cube": ("le volume", "the volume"), "corn_small": ("8 petits cubes", "8 small cubes"),
 "corn_size": ("jusqu'à 32 × 32 × 32 voxels chacun", "up to 32 × 32 × 32 voxels each"),
 "corn_size2": ("(ici 28 : un quart de l'épaisseur Z = 112)", "(here 28: a quarter of the Z thickness = 112)"),
 "corn_emb": ("embryon", "embryo"),
 # histogram
 "h_left": ("Voxels des 8 coins (175 616 voxels)", "Voxels of the 8 corners (175,616 voxels)"),
 "h_right": ("Tout le volume (1 voxel sur 4), échelle log", "Whole volume (one voxel in 4), log scale"),
 "h_x": ("valeur du voxel (16 bits)", "voxel value (16 bits)"), "h_y": ("nombre de voxels", "number of voxels"),
 "h_bg": ("bg_floor = 4 524\n(99e percentile des coins)", "bg_floor = 4,524\n(99th percentile of the corners)"),
 "h_bg2": ("bg_floor", "bg_floor"), "h_sig": ("sig_max = 33 663\n(99,9e percentile)", "sig_max = 33,663\n(99.9th percentile)"),
 "h_noise": ("bruit de caméra", "camera noise"), "h_sigarea": ("signal de l'embryon", "embryo signal"),
 "h_1pct": ("1 % des voxels du fond\nau-dessus de bg_floor", "1 % of the background voxels\nabove bg_floor"),
 # lattice
 "lat_title": ("Le point blanc : on ne regarde qu'un voxel sur 4 dans chaque direction", "The white point: only one voxel in 4 is looked at, in each direction"),
 "lat_all": ("Tous les voxels (X, Y, Z)", "All voxels (X, Y, Z)"), "lat_sub": ("voxels échantillonnés : indices 0, 4, 8, 12…", "sampled voxels: indices 0, 4, 8, 12…"),
 "lat_ratio": ("1/4 × 1/4 × 1/4 = 1/64 des voxels", "1/4 × 1/4 × 1/4 = 1/64 of the voxels"),
 "lat_count": ("192 × 144 × 28 = 774 144 voxels classés (sur 49 545 216)", "192 × 144 × 28 = 774,144 voxels ranked (out of 49,545,216)"),
 # masks
 "m_raw": ("Tranche brute", "Raw slice"), "m_thr": ("1. Seuil\nvoxel > 1,1 × bg_floor", "1. Threshold\nvoxel > 1.1 × bg_floor"),
 "m_open": ("2. Ouverture\n(1 érosion + 1 dilatation)", "2. Opening\n(1 erosion + 1 dilation)"),
 "m_dil": ("3. Dilatation × 3\n= masque final", "3. Dilation × 3\n= final mask"),
 "m_removed": ("rouge : voxels retirés", "red: voxels removed"), "m_added": ("bleu : voxels ajoutés", "blue: voxels added"),
 "m_sup": ("Canal DAPI, coupe z = 56 (jeu de démonstration). Ligne du bas : zoom sur la zone encadrée.", "DAPI channel, slice z = 56 (demonstration set). Bottom row: zoom on the framed area."),
 "m_cover": ("masque : {:.1f} % des voxels", "mask: {:.1f} % of the voxels"),
 # cross
 "x_title": ("L'élément qui définit « voisin » : la croix à 6 voisins", "The element that defines 'neighbour': the 6-neighbour cross"),
 "x_3d": ("En 3D : un voxel et ses 6 voisins", "In 3D: one voxel and its 6 neighbours"),
 "x_2d": ("Vue dans un plan : 4 voisins", "Seen in one plane: 4 neighbours"),
 "x_no": ("Les diagonales ne comptent pas.", "Diagonals do not count."),
 "x_c": ("voxel central", "central voxel"), "x_n": ("voisin (face commune)", "neighbour (shared face)"),
 # opening 7x7
 "o_title": ("Ouverture sur une grille 7 × 7 : le pixel isolé disparaît, le vrai signal reste", "Opening on a 7 × 7 grid: the isolated pixel vanishes, the real signal stays"),
 "o0": ("Après le seuil", "After the threshold"), "o1": ("Érosion\n(on mange 1 voxel)", "Erosion\n(eat 1 voxel)"),
 "o2": ("Dilatation\n(on le rend)", "Dilation\n(give it back)"), "o3": ("Résultat de\nl'ouverture", "Result of\nthe opening"),
 "o_hot": ("pixel chaud", "hot pixel"), "o_blob": ("vrai signal", "real signal"),
 "o_note": ("2D, croix à 4 voisins pour le dessin ; le pipeline fait la même chose en 3D avec 6 voisins.", "2D, 4-neighbour cross for the drawing; the pipeline does the same in 3D with 6 neighbours."),
 # median
 "d_title": ("Médiane ou moyenne ? Un pixel chaud au milieu de 8 voisins", "Median or mean? A hot pixel among 8 neighbours"),
 "d_grid": ("Les 9 valeurs", "The 9 values"), "d_sorted": ("Rangées dans l'ordre :", "Sorted:"),
 "d_med": ("médiane = 5e valeur = {}", "median = 5th value = {}"), "d_mean": ("moyenne = {:.0f}", "mean = {:.0f}"),
 "d_ok": ("le pixel chaud est écrasé", "the hot pixel is crushed"), "d_bad": ("le pixel chaud contamine tout", "the hot pixel contaminates everything"),
 "d_note": ("Exemple 2D à 9 valeurs ; le pipeline prend 27 voxels (3 × 3 × 3).", "2D example with 9 values; the pipeline takes 27 voxels (3 × 3 × 3)."),
 # window
 "w_title": ("La fenêtre : 16 bits → 8 bits (canal DAPI du jeu de démonstration)", "The window: 16 bits → 8 bits (DAPI channel of the demonstration set)"),
 "w_x": ("valeur d'entrée, 16 bits", "input value, 16 bits"), "w_y": ("valeur de sortie, 8 bits", "output value, 8 bits"),
 "w_flat0": ("tout\nécrasé\nà 0", "everything\ncrushed\nto 0"), "w_flat1": ("tout saturé à 255", "everything saturated at 255"),
 "w_lin": ("progression linéaire", "linear ramp"),
 # before / after
 "ba_raw": ("Avant : voxels bruts (16 bits)", "Before: raw voxels (16 bits)"), "ba_fin": ("Après : image finale (8 bits)", "After: final image (8 bits)"),
 "ba_zraw": ("Zoom, brut", "Zoom, raw"), "ba_zfin": ("Zoom, final", "Zoom, final"),
 "ba_sup": ("Même coupe z = 56, canal DAPI (jeu de démonstration). Le brut est affiché de 0 à sig_max pour une comparaison loyale.", "Same slice z = 56, DAPI channel (demonstration set). The raw one is displayed from 0 to sig_max for a fair comparison."),
 # flicker
 "f_title": ("Série temporelle : fenêtre par image ou fenêtre unique ? (schéma)", "Time series: one window per frame or a single window? (diagram)"),
 "f_x": ("images successives", "successive frames"), "f_y": ("luminosité (% de la première image)", "brightness (% of the first frame)"),
 "f_real": ("signal réel : le fluorophore s'éteint", "real signal: the fluorophore fades"),
 "f_per": ("fenêtre recalculée à chaque image : l'écran ne bouge pas (trompeur)", "window recomputed every frame: the screen does not move (misleading)"),
 "f_glob": ("fenêtre unique : l'écran suit la réalité", "single window: the screen follows reality"),
 # tiles
 "t_title": ("Gros volume : découpé en tuiles avec une marge de 5 voxels", "Big volume: cut into tiles with a 5-voxel margin"),
 "t_vol": ("le canal (jamais chargé en entier)", "the channel (never loaded whole)"),
 "t_core": ("cœur de la tuile : ce qui est écrit", "tile core: what is written"),
 "t_halo": ("marge (halo) de 5 voxels : lue pour calculer, jetée ensuite", "5-voxel margin (halo): read to compute, then thrown away"),
 "t_why": ("1 (ouverture : érosion) + 1 (dilatation) + 3 (dilatations) = 5 voxels d'influence", "1 (opening: erosion) + 1 (dilation) + 3 (dilations) = 5 voxels of influence"),
 "t_res": ("Résultat identique octet pour octet, quel que soit le découpage", "Byte-identical result, whatever the tiling"),
 "t_budget": ("≤ 24 millions de voxels par tuile, marge comprise", "≤ 24 million voxels per tile, margin included"),
 # fate of a voxel
 "fa_title": ("Le destin d'un voxel : une seule question décide de tout", "The fate of a voxel: one question decides everything"),
 "fa_in": ("un voxel du volume brut (16 bits)", "a voxel of the raw volume (16 bits)"),
 "fa_q": ("Fait-il partie du masque ?", "Is it inside the mask?"),
 "fa_q2": ("(embryon + halo de 3 voxels)", "(embryo + 3-voxel halo)"),
 "fa_yes": ("OUI", "YES"), "fa_no": ("NON", "NO"),
 "fa_keep": ("valeur d'origine gardée", "original value kept"), "fa_keep2": ("rien n'est modifié", "nothing is changed"),
 "fa_med": ("remplacé par la médiane", "replaced by the median"), "fa_med2": ("de ses 27 voisins", "of its 27 neighbours"),
 "fa_win": ("fenêtre 16 → 8 bits", "window 16 → 8 bits"),
 "fa_win2": ("plancher → 0, plafond → 255", "floor → 0, ceiling → 255"),
 "fa_r1": ("le signal, intact", "the signal, intact"), "fa_r1b": ("étiré entre 0 et 255", "stretched between 0 and 255"),
 "fa_r2": ("presque toujours sous", "almost always below"), "fa_r2b": ("le plancher → 0 (noir)", "the floor → 0 (black)"),
 "fa_who1": ("{} % des voxels", "{} % of the voxels"),
 "fa_who2a": ("{} % : fond sous le plancher", "{} %: background below the floor"),
 "fa_who2b": ("{} % : pics de bruit au-dessus du plancher", "{} %: noise peaks above the floor"),
 "fa_who2c": ("et pixels chauds isolés", "and isolated hot pixels"),
 "fa_foot": ("Démo, canal DAPI, 49,5 millions de voxels", "Demo set, DAPI channel, 49.5 million voxels"),
 # strip
 "s_title": ("Le nettoyage voxel par voxel, sur une ligne de 19 voxels", "Cleaning voxel by voxel, on a line of 19 voxels"),
 "s_r0": ("① Valeurs brutes (16 bits). Plancher = 4 524, seuil = 1,1 × plancher = 4 976, plafond = 33 663",
          "① Raw values (16 bits). Floor = 4,524, threshold = 1.1 × floor = 4,976, ceiling = 33,663"),
 "s_r1": ("② Seuil : au-dessus de 4 976 ?", "② Threshold: above 4,976?"),
 "s_r2": ("③ Ouverture : les points isolés sont retirés", "③ Opening: isolated points are removed"),
 "s_r3": ("④ Dilatation × 3 : le masque s'élargit de 3 voxels de chaque côté (halo)", "④ Dilation × 3: the mask grows by 3 voxels on each side (halo)"),
 "s_r4": ("⑤ Hors du masque : médiane de 3 voxels (ici en 1D ; 27 en 3D)", "⑤ Outside the mask: median of 3 voxels (here in 1D; 27 in 3D)"),
 "s_r5": ("⑥ Fenêtre → résultat 8 bits (0 à 255)", "⑥ Window → 8-bit result (0 to 255)"),
 "s_r6": ("Pour comparer : la fenêtre seule, sans masque ni médiane", "For comparison: the window alone, without mask or median"),
 "s_peak": ("pic de bruit", "noise peak"), "s_hot": ("pixel chaud", "hot pixel"), "s_cell": ("cellule", "cell"),
 "s_halo": ("halo", "halo"),
 "s_left": ("restent visibles : du bruit", "stay visible: noise"),
 "s_note": ("Exemple en 1D pour la lisibilité, calculé avec les mêmes fonctions (scipy) ; le pipeline fait exactement cela en 3D.",
            "1D example for readability, computed with the same functions (scipy); the pipeline does exactly this in 3D."),
 # real profile
 "p_title": ("Une vraie ligne de l'image : y = 300, coupe z = 56, canal DAPI (bord de l'embryon)", "A real line of the image: y = 300, slice z = 56, DAPI channel (edge of the embryo)"),
 "p_title2": ("Une ligne dans une zone de tissu faible : y = 472, coupe z = 56 (axes agrandis ; plafond hors cadre)", "A line through a faint tissue area: y = 472, slice z = 56 (axes enlarged; ceiling off the chart)"),
 "p_raw": ("valeur brute (16 bits)", "raw value (16 bits)"), "p_u8": ("résultat (8 bits)", "result (8 bits)"),
 "p_x": ("position le long de la ligne (voxels, x)", "position along the line (voxels, x)"),
 "p_floor": ("plancher 4 524", "floor 4,524"), "p_thr": ("seuil 4 976", "threshold 4,976"), "p_sig": ("plafond 33 663", "ceiling 33,663"),
 "p_mask": ("dans le masque (valeur gardée)", "inside the mask (value kept)"),
 "p_out": ("hors masque : médiane", "outside the mask: median"),
 "p_win": ("fenêtre seule (sans médiane)", "window alone (no median)"), "p_pipe": ("pipeline", "pipeline"),
 "p_bg": ("fond", "background"), "p_tis": ("tissu", "tissue"),
 # fate map
 "fm_raw": ("Brut (16 bits)", "Raw (16 bits)"), "fm_map": ("Ce que devient chaque voxel", "What becomes of each voxel"),
 "fm_fin": ("Résultat (8 bits)", "Result (8 bits)"),
 "fm_a": ("fond sous le plancher → 0", "background below the floor → 0"),
 "fm_b": ("au-dessus du plancher mais hors masque → écrasé par la médiane → 0", "above the floor but outside the mask → crushed by the median → 0"),
 "fm_s": ("hors masque, survit à la médiane (structure faible étendue)", "outside the mask, survives the median (faint extended structure)"),
 "fm_c": ("dans le masque → valeur d'origine gardée", "inside the mask → original value kept"),
 "fm_sup": ("Coupe z = 56, canal DAPI, zone de 160 × 110 voxels où le tissu est faible (jeu de démonstration).",
            "Slice z = 56, DAPI channel, 160 × 110-voxel area where the tissue is faint (demonstration set)."),
 # minimum thickness
 "e_title": ("Taille minimale : environ 3 voxels d'épaisseur dans chaque direction", "Minimum size: about 3 voxels thick in every direction"),
 "e_raw": ("Avant : 5 objets brillants (20 000) et 1 faible (6 000), sur du bruit de caméra", "Before: 5 bright objects (20,000) and 1 faint one (6,000), on camera noise"),
 "e_fin": ("Après le nettoyage (résultat 8 bits)", "After cleaning (8-bit result)"),
 "e_w": ("section\n{0} × {0}", "section\n{0} × {0}"), "e_ws": ("section\n{0} × {0}", "section\n{0} × {0}"), "e_pt": ("point\nisolé", "isolated\npoint"),
 "e_faint": ("7 × 7,\nfaible", "7 × 7,\nfaint"),
 "e_gone": ("effacé", "erased"), "e_kept": ("gardé", "kept"),
 "e_sup": ("Volume synthétique de test, coupe du milieu : chaque barre a une section carrée (même épaisseur en X et en Z). Même plancher et même plafond que le canal DAPI de démonstration.",
           "Synthetic test volume, middle slice: each bar has a square cross-section (same thickness in X and in Z). Same floor and ceiling as the demonstration DAPI channel."),
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

# ---------------------------------------------------------------- data
sys.path.insert(0, str(ROOT / "preprocess"))
_spec = importlib.util.spec_from_file_location("ip", ROOT / "preprocess" / "2-image_processor.py")
ip = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(ip)
IMSFILE = IMS / "Embryo-E95-Em2-Pecam1-Sox2.ims"
DSNAME = f"/DataSet/ResolutionLevel 0/TimePoint 0/Channel {CH}/Data"

def load_raw():
    with h5py.File(IMSFILE, "r") as f:
        return f[DSNAME][:]

def estimate(v):
    """bg_floor and sig_max exactly as the single-timepoint path of the pipeline."""
    cd = np.concatenate([v[b[0]:b[1], b[2]:b[3], b[4]:b[5]].astype(np.float32).ravel() for b in ip.corner_boxes(v.shape)])
    sub = v[::4, ::4, ::4].astype(np.float32)
    return cd, sub, float(np.percentile(cd, 99.0)), float(np.percentile(sub, 99.9))

def final_u8(v, bg, sig):
    f = CACHE / f"u8_c{CH}.npy"
    if f.exists():
        return np.load(f)
    CACHE.mkdir(parents=True, exist_ok=True)
    tmp = CACHE / f"lod0_c{CH}_fig.bin"
    np.memmap(tmp, dtype=np.uint8, mode="w+", shape=v.shape).flush()
    for b in ip.plan_tiles(v.shape, ip.MASK_HALO, ip._tile_budget()):
        ip.level_tile((str(IMSFILE), DSNAME, v.shape, b, bg, sig, str(tmp), False))
    a = np.array(np.memmap(tmp, dtype=np.uint8, mode="r", shape=v.shape)); np.save(f, a); return a

def u8_formula(x, bg, sig):
    return np.trunc(255.0 * (np.clip(x, bg, sig) - bg) / (sig - bg))

def style_ax(ax):
    for sp in ("top", "right"): ax.spines[sp].set_visible(False)
    ax.tick_params(labelsize=8)

def save_fig(fig, name):
    fig.savefig(OUT / name, facecolor="white", dpi=170); plt.close(fig)

# ---------------------------------------------------------------- SVG figures
def fig_chain():
    s = Svg(215, T("chain_title"))
    items = [("ch1", "blue"), ("ch2", "violet"), ("ch3", "green"), ("ch4", "amber"), ("ch5", "red")]
    w = 138; gap = 22; x0 = 24
    for i, (k, col) in enumerate(items):
        x = x0 + i * (w + gap)
        st, so = ACC[col]
        s.rect(x, 62, w, 130, "#fff", LINE, 14)
        s.rect(x, 62, w, 36, so, st, 14); s.add(f'<rect x="{x+1}" y="82" width="{w-2}" height="16" fill="{so}"/>')
        s.text(x + w / 2, 86, f"{i+1} · {T(k)}", 14, 800, st, "middle")
        s.text(x + w / 2, 120, T(k + "b"), 14, 800, INK, "middle")
        for j, ln in enumerate(T(k + "c").split("\n")):
            s.text(x + w / 2, 148 + j * 18, ln, 12, 400, INK2, "middle")
        if i < 4: s.line(x + w + 2, 127, x + w + gap - 2, 127, INK2, 2.4, True)
    s.save("chaine.svg")

def proj(x, y, z, ox=70, oy=370, W=250, H=190, dx=130, dz=110):
    return ox + x * W + z * dx, oy - y * H - z * dz

def cube_faces(s, x, y, z, a, fill_front, fill_top, fill_right, stroke):
    P = lambda X, Y, Z: proj(X, Y, Z)
    s.poly([P(x, y, z), P(x + a, y, z), P(x + a, y + a, z), P(x, y + a, z)], fill_front, stroke, 1.4)
    s.poly([P(x, y + a, z), P(x + a, y + a, z), P(x + a, y + a, z + a), P(x, y + a, z + a)], fill_top, stroke, 1.4)
    s.poly([P(x + a, y, z), P(x + a, y, z + a), P(x + a, y + a, z + a), P(x + a, y + a, z)], fill_right, stroke, 1.4)

def fig_corners():
    s = Svg(420, T("corn_title"))
    P = proj
    # big cube wireframe (back edges dashed)
    v = {(i, j, k): P(i, j, k) for i in (0, 1) for j in (0, 1) for k in (0, 1)}
    for (a, b) in [((0,0,1),(1,0,1)),((0,0,1),(0,1,1)),((0,0,1),(0,0,0))]:
        s.line(*v[a], *v[b], LINE, 1.6, dash="5 4")
    # embryo ellipse hint (inside)
    cx, cy = P(0.5, 0.5, 0.5)
    s.add(f'<ellipse cx="{cx}" cy="{cy}" rx="72" ry="55" fill="#dbe4ff" stroke="{ACC["blue"][0]}" stroke-width="1.5" opacity="0.9"/>')
    s.text(cx, cy + 5, T("corn_emb"), 14, 700, ACC["blue"][0], "middle")
    a = 0.2
    order = sorted([(k, j, i) for i in (0, 1) for j in (0, 1) for k in (0, 1)], key=lambda t: (-t[0], t[1], -t[2]))
    for (k, j, i) in order:
        x = 0 if i == 0 else 1 - a; y = 0 if j == 0 else 1 - a; z = 0 if k == 0 else 1 - a
        cube_faces(s, x, y, z, a, "#ffd8a8", "#ffe8cc", "#ffc078", ACC["amber"][0])
    # front frame of the big cube
    for (p, q) in [((0,0,0),(1,0,0)),((1,0,0),(1,1,0)),((1,1,0),(0,1,0)),((0,1,0),(0,0,0)),((0,1,0),(0,1,1)),((0,1,1),(1,1,1)),((1,1,1),(1,0,1)),((1,0,0),(1,0,1)),((1,1,0),(1,1,1))]:
        s.line(*v[p], *v[q], INK2, 1.4)
    for (k, j, i) in order:
        x = 0 if i == 0 else 1 - a; y = 0 if j == 0 else 1 - a; z = 0 if k == 0 else 1 - a
        if k == 0:
            cube_faces(s, x, y, z, a, "#ffd8a8", "#ffe8cc", "#ffc078", ACC["amber"][0])
    s.add(f'<ellipse cx="{cx}" cy="{cy}" rx="72" ry="55" fill="#dbe4ff" stroke="{ACC["blue"][0]}" stroke-width="1.5" opacity="0.55"/>')
    s.text(cx, cy + 5, T("corn_emb"), 14, 700, ACC["blue"][0], "middle")
    s.rect(500, 140, 285, 150, "#fff", LINE, 14)
    s.add(f'<rect x="520" y="160" width="22" height="22" fill="#ffd8a8" stroke="{ACC["amber"][0]}" stroke-width="1.5"/>')
    s.text(552, 177, T("corn_small"), 14, 800, ACC["amber"][0])
    s.text(520, 212, T("corn_size"), 12.5, 600, INK)
    s.text(520, 234, T("corn_size2"), 12, 400, INK2)
    s.save("coins.svg")

def fig_lattice():
    s = Svg(300, T("lat_title"))
    n = 16; c = 14
    rng = np.random.default_rng(0)
    for (ox, title, sub) in [(110, T("lat_all"), False), (466, T("lat_sub"), True)]:
        s.text(ox + n * c / 2, 62, title, 13, 700, INK, "middle")
        for i in range(n):
            for j in range(n):
                on = (i % 4 == 0 and j % 4 == 0)
                if sub and not on:
                    fill = "#f1f3f5"
                elif sub:
                    fill = ACC["red"][0]
                else:
                    fill = ACC["red"][0] if on else "#adb5bd"
                s.add(f'<rect x="{ox+j*c}" y="{82+i*c}" width="{c-2}" height="{c-2}" fill="{fill}"/>')
    s.line(345, 190, 440, 190, INK2, 2.4, True)
    s.text(400, 335, T("lat_ratio"), 13, 700, ACC["red"][0], "middle")
    s.text(400, 355, T("lat_count"), 12, 400, INK2, "middle")
    s.h = 372; s.p[0] = s.p[0].replace("0 0 800 300", "0 0 800 372"); s.p[1] = s.p[1].replace('height="300"', 'height="372"')
    s.save("echantillon.svg")

def fig_cross():
    s = Svg(290, T("x_title"))
    # 3D cross, oblique projection
    s.text(220, 66, T("x_3d"), 14, 700, INK, "middle")
    a = 46; dx, dy = 22, -22
    def box(cx, cy, fill_f, fill_t, fill_r, st=INK2):
        s.poly([(cx, cy), (cx + a, cy), (cx + a, cy + a), (cx, cy + a)], fill_f, st, 1.4)
        s.poly([(cx, cy), (cx + dx, cy + dy), (cx + a + dx, cy + dy), (cx + a, cy)], fill_t, st, 1.4)
        s.poly([(cx + a, cy), (cx + a + dx, cy + dy), (cx + a + dx, cy + a + dy), (cx + a, cy + a)], fill_r, st, 1.4)
    c0 = (190, 160)
    # painter order: back, then sides, then front, top
    box(c0[0] - dx, c0[1] - dy, "#bac8ff", "#dbe4ff", "#91a7ff", ACC["blue"][0])          # +Z (behind) shown behind
    box(c0[0] - a, c0[1], "#d8f5a2", "#ebfbee", "#b2f2bb", ACC["green"][0])                # -X
    box(c0[0], c0[1] + a, "#d8f5a2", "#ebfbee", "#b2f2bb", ACC["green"][0])                # -Y
    box(c0[0], c0[1], "#ffa8a8", "#ffc9c9", "#ff8787", ACC["red"][0])                      # centre
    box(c0[0] + a, c0[1], "#d8f5a2", "#ebfbee", "#b2f2bb", ACC["green"][0])                # +X
    box(c0[0], c0[1] - a, "#d8f5a2", "#ebfbee", "#b2f2bb", ACC["green"][0])                # +Y
    box(c0[0] + dx, c0[1] + dy, "#bac8ff", "#dbe4ff", "#91a7ff", ACC["blue"][0])
    s.text(c0[0] + a / 2, c0[1] + a / 2 + 5, "0", 15, 800, ACC["red"][0], "middle")
    # 2D
    s.text(600, 66, T("x_2d"), 14, 700, INK, "middle")
    for (i, j, col) in [(0, 0, "c"), (-1, 0, "n"), (1, 0, "n"), (0, -1, "n"), (0, 1, "n")]:
        x = 600 - 28 + i * 56; y = 130 + j * 56
        s.add(f'<rect x="{x}" y="{y}" width="54" height="54" fill="{"#ffc9c9" if col=="c" else "#b2f2bb"}" stroke="{ACC["red"][0] if col=="c" else ACC["green"][0]}" stroke-width="1.8"/>')
    for (i, j) in [(-1, -1), (1, -1), (-1, 1), (1, 1)]:
        x = 600 - 28 + i * 56; y = 130 + j * 56
        s.add(f'<rect x="{x}" y="{y}" width="54" height="54" fill="#f1f3f5" stroke="{LINE}" stroke-width="1.2" stroke-dasharray="4 3"/>')
    s.text(600, 163, "0", 15, 800, ACC["red"][0], "middle")
    s.text(600, 280, T("x_no"), 12.5, 600, INK2, "middle")
    s.add(f'<rect x="36" y="238" width="16" height="16" fill="#ffc9c9" stroke="{ACC["red"][0]}"/>'); s.text(58, 251, T("x_c"), 12, 400, INK)
    s.add(f'<rect x="36" y="262" width="16" height="16" fill="#b2f2bb" stroke="{ACC["green"][0]}"/>'); s.text(58, 275, T("x_n"), 12, 400, INK)
    s.save("croix.svg")

def grid_svg(s, ox, oy, g, c, on_fill="#3b5bdb", hot=None, blob=None):
    n = g.shape[0]
    for i in range(n):
        for j in range(n):
            if g[i, j]:
                isH = hot is not None and hot[i, j]
                fill = ACC["red"][0] if isH else on_fill
            else:
                fill = "#fff"
            s.add(f'<rect x="{ox+j*c}" y="{oy+i*c}" width="{c}" height="{c}" fill="{fill}" stroke="{LINE}" stroke-width="1"/>')

def fig_opening():
    s = Svg(330, T("o_title"))
    g = np.zeros((7, 7), bool); g[1:5, 1:5] = True; g[6, 5] = True
    hot = np.zeros_like(g); hot[6, 5] = True
    cross = ndi.generate_binary_structure(2, 1)
    er = ndi.binary_erosion(g, cross); op = ndi.binary_dilation(er, cross)
    assert np.array_equal(op, ndi.binary_opening(g, cross))
    c = 26; xs = [18, 218, 418, 618]
    labels = ["o0", "o1", "o2", "o3"]
    for k, (x, arr) in enumerate(zip(xs, [g, er, op, op])):
        grid_svg(s, x, 100, arr, c, hot=hot if k == 0 else None)
        for j, ln in enumerate(T(labels[k]).split("\n")):
            s.text(x + 7 * c / 2, 62 + j * 18, ln, 13, 700, INK, "middle")
        if k < 3: s.line(x + 7 * c + 4, 190, x + 200 - 8 + 0, 190, INK2, 2.2, True) if False else None
    for k in range(3):
        s.line(xs[k] + 7 * c + 4, 190, xs[k + 1] - 4, 190, INK2, 2.2, True)
    s.text(18 + 5 * c + c / 2 - 2, 100 + 7 * c + 18, T("o_hot"), 12, 700, ACC["red"][0], "middle")
    s.text(18 + 2.5 * c, 100 + 7 * c + 18, T("o_blob"), 12, 700, ACC["blue"][0], "middle")
    s.text(400, 322, T("o_note"), 11.5, 400, INK2, "middle")
    s.h = 335; s.p[0] = s.p[0].replace("0 0 800 330", "0 0 800 335"); s.p[1] = s.p[1].replace('height="330"', 'height="335"')
    s.save("ouverture.svg")
    return int(g.sum()), int(op.sum())

def fig_median():
    vals = np.array([[2810, 3120, 2950], [3040, 52000, 2880], [2760, 3090, 2990]])
    srt = np.sort(vals.ravel()); med = int(np.median(vals)); mean = float(vals.mean())
    s = Svg(300, T("d_title"))
    s.text(190, 64, T("d_grid"), 14, 700, INK, "middle")
    c = 76
    for i in range(3):
        for j in range(3):
            hotc = vals[i, j] == 52000
            s.add(f'<rect x="{70+j*c}" y="{82+i*c*0.7}" width="{c}" height="{c*0.7}" fill="{ACC["red"][1] if hotc else "#fff"}" stroke="{ACC["red"][0] if hotc else LINE}" stroke-width="{2 if hotc else 1.2}"/>')
            s.text(70 + j * c + c / 2, 82 + i * c * 0.7 + c * 0.7 / 2 + 5, f"{vals[i,j]:,}".replace(",", " " if LANG == "fr" else ","), 14, 700, ACC["red"][0] if hotc else INK, "middle")
    s.text(520, 64, T("d_sorted"), 14, 700, INK, "middle")
    for k, v in enumerate(srt):
        x = 340 + k * 49
        isMed = k == 4
        s.add(f'<rect x="{x}" y="80" width="47" height="30" rx="4" fill="{ACC["green"][1] if isMed else "#fff"}" stroke="{ACC["green"][0] if isMed else LINE}" stroke-width="{2.4 if isMed else 1}"/>')
        s.text(x + 23.5, 100, f"{v/1000:.1f}".replace(".", "," if LANG == "fr" else ".") + "k" if v < 10000 else "52k", 11, 700, INK, "middle")
    s.rect(330, 135, 210, 82, ACC["green"][1], ACC["green"][0], 12, 1.8)
    s.text(435, 163, T("d_med").format(f"{med:,}".replace(",", " " if LANG == "fr" else ",")), 14, 800, ACC["green"][0], "middle")
    s.text(435, 188, T("d_ok"), 12, 600, INK2, "middle")
    s.rect(560, 135, 215, 82, ACC["red"][1], ACC["red"][0], 12, 1.8)
    s.text(667, 163, T("d_mean").format(mean).replace(",", " ") if LANG == "fr" else T("d_mean").format(mean), 14, 800, ACC["red"][0], "middle")
    s.text(667, 188, T("d_bad"), 12, 600, INK2, "middle")
    s.text(400, 280, T("d_note"), 11.5, 400, INK2, "middle")
    s.save("mediane.svg")
    return med, mean

def fig_tiles():
    s = Svg(400, T("t_title"))
    s.text(300, 62, T("t_vol"), 12.5, 600, INK2, "middle")
    s.rect(60, 74, 480, 200, "#fff", INK2, 8, 1.8)
    s.line(300, 74, 300, 274, LINE, 1.6, dash="6 4")
    s.line(60, 174, 540, 174, LINE, 1.6, dash="6 4")
    s.add(f'<rect x="60" y="74" width="260" height="120" fill="{ACC["amber"][1]}" stroke="{ACC["amber"][0]}" stroke-width="2" stroke-dasharray="6 4"/>')
    s.add(f'<rect x="60" y="74" width="240" height="100" fill="{ACC["green"][1]}" stroke="{ACC["green"][0]}" stroke-width="2.4"/>')
    s.add(f'<rect x="300" y="174" width="240" height="100" fill="#f1f3f5" opacity="0.6"/>')
    s.text(180, 130, "tuile" if LANG == "fr" else "tile", 16, 800, ACC["green"][0], "middle")
    s.add(f'<rect x="580" y="90" width="22" height="22" fill="{ACC["green"][1]}" stroke="{ACC["green"][0]}" stroke-width="2"/>')
    s.text(610, 107, "cœur" if LANG == "fr" else "core", 13, 800, ACC["green"][0])
    s.add(f'<rect x="580" y="130" width="22" height="22" fill="{ACC["amber"][1]}" stroke="{ACC["amber"][0]}" stroke-width="2" stroke-dasharray="4 3"/>')
    s.text(610, 147, "marge (halo)" if LANG == "fr" else "margin (halo)", 13, 800, ACC["amber"][0])
    s.text(580, 190, "5 voxels" if LANG == "fr" else "5 voxels", 12.5, 600, INK2)
    # legend lines
    s.text(40, 310, T("t_core"), 12.5, 600, ACC["green"][0])
    s.text(40, 330, T("t_halo"), 12.5, 600, ACC["amber"][0])
    s.text(40, 352, T("t_why"), 12.5, 600, INK)
    s.text(40, 374, T("t_budget"), 12, 400, INK2)
    s.text(40, 394, T("t_res"), 12.5, 700, ACC["blue"][0])
    s.h = 410; s.p[0] = s.p[0].replace("0 0 800 400", "0 0 800 410"); s.p[1] = s.p[1].replace('height="400"', 'height="410"')
    s.save("tuiles.svg")

# ---------------------------------------------------------------- data figures
def fig_hist(v, cd, sub, bg, sig):
    fig, ax = plt.subplots(1, 2, figsize=(11, 3.7))
    a = ax[0]
    a.hist(cd, bins=120, color="#e67700", alpha=.85)
    a.axvline(bg, color="#c92a2a", lw=2)
    ymax = a.get_ylim()[1]
    a.text(bg + 150, ymax * 0.62, T("h_bg"), color="#c92a2a", fontsize=9, fontweight="bold")
    a.set_title(T("h_left"), fontsize=10.5, color=INK); a.set_xlabel(T("h_x"), fontsize=9); a.set_ylabel(T("h_y"), fontsize=9)
    a.text(0.03, 0.9, T("h_noise"), transform=a.transAxes, color="#e67700", fontsize=10, fontweight="bold")
    style_ax(a)
    b = ax[1]
    b.hist(sub.ravel(), bins=200, range=(0, 65535), color="#3b5bdb", alpha=.85, log=True)
    b.axvline(bg, color="#c92a2a", lw=2); b.axvline(sig, color="#2b8a3e", lw=2)
    b.text(bg + 900, 2e5, T("h_bg2"), color="#c92a2a", fontsize=9, fontweight="bold", va="top")
    b.text(sig + 900, 6e3, T("h_sig"), color="#2b8a3e", fontsize=9, fontweight="bold")
    b.set_title(T("h_right"), fontsize=10.5, color=INK); b.set_xlabel(T("h_x"), fontsize=9); b.set_ylabel(T("h_y"), fontsize=9)
    style_ax(b)
    fig.tight_layout(); save_fig(fig, "histogramme.png")
    frac_above = float((cd > bg).mean()); return frac_above

def fig_masks(v, bg, sig):
    m1 = v > bg * 1.1
    m2 = ndi.binary_opening(m1, iterations=1)
    m3 = ndi.binary_dilation(m2, iterations=3)
    cover = [m.mean() * 100 for m in (m1, m2, m3)]
    rem = (m1 & ~m2)[Z]
    # zoom window with the most removed voxels in the slice
    H, W = rem.shape; wh, ww = 70, 100
    ii = ndi.uniform_filter(rem.astype(float), size=(wh, ww), mode="constant") * wh * ww
    cy, cx = np.unravel_index(np.argmax(ii[wh // 2:H - wh // 2, ww // 2:W - ww // 2]), (H - wh, W - ww))
    y0, x0 = cy, cx
    box = (slice(y0, y0 + wh), slice(x0, x0 + ww))
    fig = plt.figure(figsize=(11, 5.6))
    gs = fig.add_gridspec(2, 4, height_ratios=[1, 1.0], hspace=0.04, wspace=0.04, left=0.01, right=0.99, top=0.9, bottom=0.06)
    sl = v[Z].astype(float)
    tops = [np.clip(sl / sig, 0, 1), m1[Z], m2[Z], m3[Z]]
    titles = [T("m_raw"), T("m_thr"), T("m_open"), T("m_dil")]
    for k in range(4):
        a = fig.add_subplot(gs[0, k]); a.imshow(tops[k], cmap="gray", vmin=0, vmax=1, interpolation="nearest"); a.axis("off")
        a.set_title(titles[k], fontsize=9.5, color=INK)
        a.add_patch(plt.Rectangle((x0, y0), ww, wh, fill=False, ec="#e67700", lw=1.4))
        if k > 0: a.text(6, H - 8, T("m_cover").format(cover[k - 1]) if False else "", fontsize=8)
    # zoom row
    def rgbzoom(base, other=None, color=None):
        img = np.stack([base] * 3, -1).astype(float)
        if other is not None:
            img[other] = color
        return img[box]
    z0 = np.clip(sl / sig, 0, 1)
    zs = [np.stack([z0] * 3, -1)[box],
          rgbzoom(m1[Z]),
          rgbzoom(m2[Z], rem, (0.85, 0.1, 0.1)),
          rgbzoom(m3[Z], (m3[Z] & ~m2[Z]), (0.2, 0.4, 0.95))]
    for k in range(4):
        a = fig.add_subplot(gs[1, k]); a.imshow(zs[k], interpolation="nearest"); a.axis("off")
    fig.text(0.5, 0.012, T("m_sup") + "   " + T("m_removed") + " · " + T("m_added"), ha="center", fontsize=8, color=INK2)
    save_fig(fig, "masque.png")
    return cover, int(rem.sum()), int((m1 & ~m2).sum()), (y0, x0)

def fig_window(bg, sig):
    x = np.linspace(0, 45000, 900)
    y = u8_formula(x, bg, sig)
    fig, ax = plt.subplots(figsize=(8, 4))
    ax.plot(x, y, color="#3b5bdb", lw=2.6)
    ax.axvline(bg, color="#c92a2a", ls="--", lw=1.4); ax.axvline(sig, color="#2b8a3e", ls="--", lw=1.4)
    ax.text(bg - 600, 205, f"bg_floor = {bg:,.0f}".replace(",", " " if LANG == "fr" else ","), color="#c92a2a", ha="right", fontsize=9, fontweight="bold")
    ax.text(sig + 600, 40, f"sig_max = {sig:,.0f}".replace(",", " " if LANG == "fr" else ","), color="#2b8a3e", ha="left", fontsize=9, fontweight="bold")
    ax.text(bg / 2, 45, T("w_flat0"), ha="center", fontsize=8, color=INK2, linespacing=1.1)
    ax.text(39500, 222, T("w_flat1"), ha="center", fontsize=8.5, color=INK2)
    ax.text(18500, 98, T("w_lin"), ha="center", fontsize=9, color="#3b5bdb", rotation=40)
    pts = [4000, 10000, 20000, 40000]
    for p in pts:
        o = u8_formula(np.array([p], float), bg, sig)[0]
        ax.plot([p], [o], "o", color="#e67700", ms=7, zorder=5)
        ax.annotate(f"{p:,} → {int(o)}".replace(",", " " if LANG == "fr" else ","), (p, o), textcoords="offset points", xytext={4000: (-22, 12), 10000: (8, -14), 20000: (8, -14), 40000: (-30, 10)}[p], fontsize=8.5, color="#e67700", fontweight="bold")
    ax.set_xlabel(T("w_x")); ax.set_ylabel(T("w_y")); ax.set_title(T("w_title"), fontsize=10.5, color=INK)
    ax.set_ylim(-8, 266); ax.set_xlim(0, 45000); ax.grid(alpha=.25); style_ax(ax)
    fig.tight_layout(); save_fig(fig, "fenetre.png")
    return [(p, int(u8_formula(np.array([p], float), bg, sig)[0])) for p in pts]

def fig_before_after(v, u8, bg, sig, box):
    y0, x0 = 225, 150
    wh, ww = 70, 100
    fig = plt.figure(figsize=(11, 5.4))
    gs = fig.add_gridspec(2, 2, height_ratios=[1.6, 1], hspace=0.12, wspace=0.04)
    sl = np.clip(v[Z].astype(float) / sig, 0, 1)
    a = fig.add_subplot(gs[0, 0]); a.imshow(sl, cmap="gray", vmin=0, vmax=1); a.axis("off"); a.set_title(T("ba_raw"), fontsize=10, color=INK)
    b = fig.add_subplot(gs[0, 1]); b.imshow(u8[Z], cmap="gray", vmin=0, vmax=255); b.axis("off"); b.set_title(T("ba_fin"), fontsize=10, color=INK)
    for q in (a, b): q.add_patch(plt.Rectangle((x0, y0), ww, wh, fill=False, ec="#e67700", lw=1.4))
    c = fig.add_subplot(gs[1, 0]); c.imshow(sl[y0:y0 + wh, x0:x0 + ww], cmap="gray", vmin=0, vmax=1, interpolation="nearest"); c.axis("off"); c.set_title(T("ba_zraw"), fontsize=9, color=INK2, pad=2)
    d = fig.add_subplot(gs[1, 1]); d.imshow(u8[Z][y0:y0 + wh, x0:x0 + ww], cmap="gray", vmin=0, vmax=255, interpolation="nearest"); d.axis("off"); d.set_title(T("ba_zfin"), fontsize=9, color=INK2, pad=2)
    fig.text(0.5, 0.01, T("ba_sup"), ha="center", fontsize=8, color=INK2)
    save_fig(fig, "avant_apres.png")

def fig_flicker():
    t = np.arange(1, 7)
    real = 100 * np.array([1, .72, .52, .38, .28, .2])
    fig, ax = plt.subplots(figsize=(8, 3.8))
    ax.plot(t, real, "-o", color="#c92a2a", lw=2.4, label=T("f_real"))
    ax.plot(t, np.full_like(real, 100), "--s", color="#e67700", lw=2, label=T("f_per"))
    ax.plot(t, real, "-", color="#2b8a3e", lw=0)  # same as real by construction
    ax.plot(t, real * 0.96 + 1, ":^", color="#2b8a3e", lw=2.2, label=T("f_glob"))
    ax.set_ylim(0, 115); ax.set_xlabel(T("f_x")); ax.set_ylabel(T("f_y")); ax.set_title(T("f_title"), fontsize=10.5, color=INK)
    ax.legend(frameon=False, fontsize=8.2, loc="lower left"); ax.grid(alpha=.25); style_ax(ax)
    fig.tight_layout(); save_fig(fig, "serie_temporelle.png")

# ---------------------------------------------------------------- the fate of a voxel (v1.60 rewrite)
def fmt(x, nd=1):
    t = f"{x:,.{nd}f}"
    return t.replace(",", " ").replace(".", ",") if LANG == "fr" else t

def fig_fate(st):
    s = Svg(480, T("fa_title"))
    s.rect(250, 56, 300, 40, "#fff", INK2, 10, 1.4); s.text(400, 81, T("fa_in"), 14, 700, INK, "middle")
    s.line(400, 96, 400, 116, INK2, 2, True)
    s.poly([(400, 118), (560, 160), (400, 202), (240, 160)], ACC["blue"][1], ACC["blue"][0], 1.8)
    s.text(400, 157, T("fa_q"), 15, 800, ACC["blue"][0], "middle"); s.text(400, 177, T("fa_q2"), 11.5, 500, INK2, "middle")
    # yes branch (left), no branch (right)
    for side, key, col, x in (("l", "fa_yes", "green", 170), ("r", "fa_no", "amber", 630)):
        x0 = 240 if side == "l" else 560
        s.line(x0, 160, x, 160, INK2, 2); s.line(x, 160, x, 222, INK2, 2, True)
        s.text((x0 + x) / 2, 152, T(key), 13, 800, ACC[col][0], "middle")
    boxes = [(170, "green", "fa_keep", "fa_keep2", "fa_r1", "fa_r1b"), (630, "amber", "fa_med", "fa_med2", "fa_r2", "fa_r2b")]
    for x, col, a, b, r1, r2 in boxes:
        st_, so = ACC[col]
        s.rect(x - 125, 224, 250, 54, so, st_, 12, 1.6)
        s.text(x, 247, T(a), 14, 800, st_, "middle"); s.text(x, 267, T(b), 12, 500, INK2, "middle")
        s.line(x, 278, x, 298, INK2, 2, True)
        s.rect(x - 125, 300, 250, 44, "#fff", ACC["red"][0], 12, 1.4)
        s.text(x, 320, T("fa_win"), 13.5, 700, ACC["red"][0], "middle"); s.text(x, 337, T("fa_win2"), 11, 500, INK2, "middle")
        s.line(x, 344, x, 362, INK2, 2, True)
        s.rect(x - 125, 364, 250, 50, "#1c2333" if col == "amber" else "#fff", INK, 12, 1.6)
        fill = "#fff" if col == "amber" else st_
        s.text(x, 386, T(r1), 13.5, 800, fill, "middle"); s.text(x, 404, T(r2), 11.5, 500, "#d0d6e2" if col == "amber" else INK2, "middle")
    # who goes where
    s.rect(30, 230, 0, 0)
    s.text(170, 438, T("fa_who1").format(fmt(st["C"])), 13, 800, ACC["green"][0], "middle")
    s.text(630, 434, T("fa_who2a").format(fmt(st["A"])), 12, 700, INK, "middle")
    s.text(630, 450, T("fa_who2b").format(fmt(st["B"])), 12, 700, ACC["amber"][0], "middle")
    s.text(630, 465, T("fa_who2c"), 12, 700, ACC["amber"][0], "middle")
    s.text(170, 465, T("fa_foot"), 9.5, 400, INK2, "middle")
    s.save("destin.svg")

STRIP = np.array([2200, 4700, 2900, 2400, 3300, 9000, 2700, 2500, 3600, 4800,
                  6000, 14000, 22000, 26000, 19000, 8000, 4300, 3500, 2800], float)

def fig_strip(bg, sig):
    v = STRIP; n = v.size; thr = bg * 1.1
    m1 = v > thr
    m2 = ndi.binary_opening(m1, iterations=1)
    m3 = ndi.binary_dilation(m2, iterations=3)
    med = ndi.median_filter(v, size=3)
    comp = np.where(m3, v, med)
    u8 = u8_formula(comp, bg, sig).astype(int); win = u8_formula(v, bg, sig).astype(int)
    cw, x0 = 40, 20; rh = 28
    rows_y = [104, 170, 224, 278, 332, 400, 462]
    s = Svg(524, T("s_title"))
    def cell(i, y, txt, fill="#fff", stroke=LINE, col=INK, w=600, sw=1):
        x = x0 + i * cw
        s.add(f'<rect x="{x+1}" y="{y}" width="{cw-2}" height="{rh}" rx="4" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>')
        if txt != "": s.text(x + cw / 2, y + 19, str(txt), 11.5 if len(str(txt)) > 4 else 13, w, col, "middle")
    def label(y, k, col=INK): s.text(x0, y - 7, T(k), 13, 700, col)
    # brackets above the raw row
    def bracket(i0, i1, k, col):
        xa, xb = x0 + i0 * cw + 3, x0 + (i1 + 1) * cw - 3
        s.add(f'<path d="M{xa},98 L{xa},92 L{xb},92 L{xb},98" fill="none" stroke="{col}" stroke-width="1.6"/>')
        s.text((xa + xb) / 2, 87, T(k), 11, 700, col, "middle")
    s.text(x0, 62, T("s_r0"), 13, 700, INK)
    bracket(1, 1, "s_peak", ACC["amber"][0]); bracket(5, 5, "s_hot", ACC["red"][0])
    bracket(7, 9, "s_halo", ACC["blue"][0]); bracket(10, 15, "s_cell", ACC["green"][0]); bracket(16, 18, "s_halo", ACC["blue"][0])
    for i in range(n):
        g = int(255 - min(1.0, v[i] / sig) * 200)
        above = v[i] > bg
        cell(i, rows_y[0], int(v[i]), f"rgb({g},{g},{min(255,g+10)})", ACC["red"][0] if above else LINE, "#fff" if g < 140 else INK, 600, 1.8 if above else 1)
    label(rows_y[1], "s_r1")
    for i in range(n): cell(i, rows_y[1], "✓" if m1[i] else "", ACC["green"][1] if m1[i] else "#fff", ACC["green"][0] if m1[i] else LINE, ACC["green"][0], 800)
    label(rows_y[2], "s_r2")
    for i in range(n):
        if m1[i] and not m2[i]: cell(i, rows_y[2], "✗", ACC["red"][1], ACC["red"][0], ACC["red"][0], 800, 1.6)
        else: cell(i, rows_y[2], "✓" if m2[i] else "", ACC["green"][1] if m2[i] else "#fff", ACC["green"][0] if m2[i] else LINE, ACC["green"][0], 800)
    label(rows_y[3], "s_r3")
    for i in range(n):
        if m3[i] and not m2[i]: cell(i, rows_y[3], "+", ACC["blue"][1], ACC["blue"][0], ACC["blue"][0], 800, 1.6)
        else: cell(i, rows_y[3], "✓" if m3[i] else "", ACC["green"][1] if m3[i] else "#fff", ACC["green"][0] if m3[i] else LINE, ACC["green"][0], 800)
    label(rows_y[4], "s_r4")
    for i in range(n):
        if m3[i]: cell(i, rows_y[4], int(v[i]), ACC["green"][1], ACC["green"][0], INK, 500)
        else:
            ch = med[i] != v[i]
            cell(i, rows_y[4], int(med[i]), ACC["amber"][1] if ch else "#fff", ACC["amber"][0] if ch else LINE, ACC["amber"][0] if ch else INK2, 700 if ch else 500, 1.6 if ch else 1)
    label(rows_y[5], "s_r5", ACC["red"][0])
    for i in range(n):
        g = 255 - int(u8[i] / 255 * 220)
        cell(i, rows_y[5], u8[i], "#0b0d12" if u8[i] == 0 else f"rgb({255-g},{255-g},{255-g})", INK, "#fff", 800)
    label(rows_y[6], "s_r6", INK2)
    for i in range(n):
        bad = win[i] > 0 and not u8[i] > 0
        cell(i, rows_y[6], win[i], ACC["red"][1] if bad else "#f1f3f5", ACC["red"][0] if bad else LINE, ACC["red"][0] if bad else INK2, 700 if bad else 400, 1.6 if bad else 1)
    s.text(400, 510, T("s_note"), 10.5, 400, INK2, "middle")
    s.save("profil_etapes.svg")
    return dict(m1=m1.tolist(), m2=m2.tolist(), m3=m3.tolist(), med=med.tolist(), u8=u8.tolist(), win=win.tolist())

def slab_pipeline(v, bg, sig, z=Z):
    """Mask, median and 8-bit result of slice z, exactly as level_tile (mask needs 5 voxels of context)."""
    a, b = max(0, z - 6), min(v.shape[0], z + 7)
    slab = v[a:b].astype(np.float32)
    m = ndi.binary_dilation(ndi.binary_opening(slab > bg * 1.1, iterations=1), iterations=3)[z - a]
    med = ndi.median_filter(v[z - 1:z + 2].astype(np.float32), size=3)[1]
    raw = v[z].astype(np.float32)
    u8 = u8_formula(np.where(m, raw, med), bg, sig).astype(np.uint8)
    return raw, m, med, u8

def fate_stats(v, bg, sig):
    """Whole-volume shares of the three fates (the median is computed on the whole volume: slow)."""
    f = CACHE / f"fate_c{CH}.npy"
    if f.exists():
        return dict(zip(("A", "B", "C", "Bsurv", "speck_win", "speck_pipe"), np.load(f).tolist()))
    vv = v.astype(np.float32)
    m = ndi.binary_dilation(ndi.binary_opening(vv > bg * 1.1, iterations=1), iterations=3)
    med = ndi.median_filter(vv, size=3)
    out = ~m; N = vv.size
    u8 = u8_formula(np.where(m, vv, med), bg, sig); win = u8_formula(vv, bg, sig)
    r = [100 * (out & (vv <= bg)).sum() / N, 100 * (out & (vv > bg)).sum() / N, 100 * m.sum() / N,
         100 * (out & (vv > bg) & (med > bg)).sum() / N, float(((win > 0) & out).sum()), float(((u8 > 0) & out).sum())]
    CACHE.mkdir(parents=True, exist_ok=True); np.save(f, np.array(r))
    return dict(zip(("A", "B", "C", "Bsurv", "speck_win", "speck_pipe"), r))

def fig_profile(v, bg, sig, y=300, xa=140, xb=330, ymax=None, name="profil_reel.png", title="p_title"):
    raw, m, med, u8 = slab_pipeline(v, bg, sig)
    x = np.arange(xa, xb); r = raw[y, xa:xb]; mm = m[y, xa:xb]; md = med[y, xa:xb]
    win = u8_formula(r, bg, sig); fin = u8[y, xa:xb].astype(float)
    fig, (a1, a2) = plt.subplots(2, 1, figsize=(10, 6.2), sharex=True, gridspec_kw=dict(height_ratios=[1.35, 1], hspace=0.12))
    for ax in (a1, a2):
        for i, inside in enumerate(mm):
            if inside: ax.axvspan(x[i] - .5, x[i] + .5, color="#ebfbee", lw=0, zorder=0)
    a1.plot(x, r, color="#4a5468", lw=1.1, zorder=2)
    a1.scatter(x[mm], r[mm], s=9, color="#2b8a3e", zorder=3, label=T("p_mask"))
    a1.scatter(x[~mm], md[~mm], s=9, color="#e67700", zorder=3, marker="s", label=T("p_out"))
    top = ymax or max(sig * 1.12, r.max() * 1.05); k_ = 350 * top / 37000
    lines = [(bg, "#c92a2a", "p_floor", "--", -k_, "top"), (bg * 1.1, "#7048e8", "p_thr", ":", k_, "bottom")]
    if sig < top: lines.append((sig, "#2b8a3e", "p_sig", "--", k_, "bottom"))
    for val, col, k, ls, dy, va in lines:
        a1.axhline(val, color=col, ls=ls, lw=1.3); a1.text(xb - 1, val + dy, T(k), color=col, ha="right", va=va, fontsize=8.5, fontweight="bold",
                                                       bbox=dict(fc="white", ec="none", pad=0.5, alpha=0.85))
    a1.set_ylim(0, top); a1.set_ylabel(T("p_raw")); a1.legend(frameon=False, fontsize=8.5, loc="upper left")
    a1.set_title(T(title), fontsize=10.5, color=INK); a1.grid(alpha=.2); style_ax(a1)
    a2.plot(x, win, color="#c92a2a", lw=1, ls=":", label=T("p_win"))
    a2.plot(x, fin, color="#1c2333", lw=1.6, label=T("p_pipe"))
    a2.set_ylim(-5, 260 if ymax is None else 60); a2.set_ylabel(T("p_u8")); a2.set_xlabel(T("p_x")); a2.legend(frameon=False, fontsize=8.5, loc="upper left")
    a2.grid(alpha=.2); style_ax(a2)
    fig.subplots_adjust(left=0.08, right=0.98, top=0.94, bottom=0.09); save_fig(fig, name)
    return int(mm.sum()), int(((win > 0) & ~mm).sum()), int(((fin > 0) & ~mm).sum())

def fig_fatemap(v, bg, sig, y0=345, x0=409, wh=110, ww=160):
    raw, m, med, u8 = slab_pipeline(v, bg, sig)
    b = (slice(y0, y0 + wh), slice(x0, x0 + ww))
    r, mm, md, uu = raw[b], m[b], med[b], u8[b]
    cat = np.zeros(r.shape + (3,))
    cat[~mm & (r <= bg)] = (0.13, 0.15, 0.2)
    cat[~mm & (r > bg)] = (0.96, 0.55, 0.05)
    cat[~mm & (r > bg) & (md > bg)] = (0.85, 0.1, 0.1)
    cat[mm] = (0.18, 0.62, 0.28)
    fig = plt.figure(figsize=(11, 3.9))
    gs = fig.add_gridspec(1, 3, wspace=0.03, left=0.01, right=0.99, top=0.9, bottom=0.25)
    for k, (img, t, kw) in enumerate(((np.clip(r / sig, 0, 1), "fm_raw", dict(cmap="gray", vmin=0, vmax=1)),
                                      (cat, "fm_map", {}), (uu, "fm_fin", dict(cmap="gray", vmin=0, vmax=255)))):
        a = fig.add_subplot(gs[0, k]); a.imshow(img, interpolation="nearest", **kw); a.axis("off"); a.set_title(T(t), fontsize=10, color=INK)
    from matplotlib.patches import Patch
    hs = [Patch(color=c, label=T(k)) for c, k in (((0.13, 0.15, 0.2), "fm_a"), ((0.96, 0.55, 0.05), "fm_b"), ((0.85, 0.1, 0.1), "fm_s"), ((0.18, 0.62, 0.28), "fm_c"))]
    fig.legend(handles=hs, loc="lower center", ncol=2, frameon=False, fontsize=8.5, bbox_to_anchor=(0.5, 0.06))
    fig.text(0.5, 0.01, T("fm_sup"), ha="center", fontsize=8, color=INK2)
    save_fig(fig, "destin_carte.png")
    o = ~mm
    return dict(bg_out=int((o & (r <= bg)).sum()), peaks=int((o & (r > bg)).sum()), surv=int((o & (r > bg) & (md > bg)).sum()), mask=int(mm.sum()))


def fig_thickness(bg, sig):
    rng = np.random.default_rng(0)
    v = rng.normal(2626, 806, (20, 80, 150)).clip(0)
    objs = [("pt", 14, 1, 20000), ("w1", 34, 1, 20000), ("w2", 54, 2, 20000), ("w3", 74, 3, 20000), ("w5", 96, 5, 20000), ("faint", 121, 7, 6000)]
    for k, x, w, val in objs:
        if k == "pt": v[10, 40, x] = val
        else: v[10 - w // 2:10 - w // 2 + w, 20:70, x:x + w] = val
    m = ndi.binary_dilation(ndi.binary_opening(v > bg * 1.1, iterations=1), iterations=3)
    med = ndi.median_filter(v, size=3)
    u8 = u8_formula(np.where(m, v, med), bg, sig)
    fig = plt.figure(figsize=(10.5, 3.9))
    gs = fig.add_gridspec(1, 2, wspace=0.04, left=0.01, right=0.99, top=0.86, bottom=0.13)
    out = []
    for j, (img, t, kw) in enumerate(((np.clip(v[10] / sig, 0, 1), "e_raw", dict(vmin=0, vmax=1)), (u8[10], "e_fin", dict(vmin=0, vmax=255)))):
        a = fig.add_subplot(gs[0, j]); a.imshow(img, cmap="gray", interpolation="nearest", **kw); a.axis("off")
        a.set_title(T(t), fontsize=9.5, color=INK)
        for k, x, w, val in objs:
            kept = u8[10, 40, x:x + w].max() > 0
            lab = T("e_pt") if k == "pt" else T("e_faint") if k == "faint" else (T("e_w") if w == 1 else T("e_ws")).format(w)
            if j == 0: a.text(x + w / 2 - .5, 2, lab, color="#ffd43b", ha="center", va="top", fontsize=7.5, fontweight="bold", linespacing=1.0)
            else:
                a.text(x + w / 2 - .5, 74, T("e_kept") if kept else T("e_gone"), color="#69db7c" if kept else "#ff6b6b", ha="center", va="top", fontsize=8, fontweight="bold")
                out.append((k, bool(kept)))
    fig.suptitle(T("e_title"), fontsize=10.5, color=INK, y=0.985)
    fig.text(0.5, 0.015, T("e_sup"), ha="center", fontsize=7.8, color=INK2, wrap=True)
    save_fig(fig, "epaisseur.png")
    return out

if __name__ == "__main__" and os.environ.get("ONLY") == "fate":
    fig_chain(); v = load_raw(); cd, sub, bg, sig = estimate(v)
    st = fate_stats(v, bg, sig); print("fate", st); fig_fate(st)
    print("strip", fig_strip(bg, sig)); print("profile", fig_profile(v, bg, sig), fig_profile(v, bg, sig, 472, 330, 520, 9000, "profil_faible.png", "p_title2")); print("map", fig_fatemap(v, bg, sig)); print("thickness", fig_thickness(bg, sig))
    sys.exit(0)

if __name__ == "__main__":
    fig_chain(); fig_corners(); fig_lattice(); fig_cross()
    o = fig_opening(); md = fig_median(); fig_tiles(); fig_flicker()
    v = load_raw(); cd, sub, bg, sig = estimate(v)
    print("shape", v.shape, "corner cube", ip.corner_boxes(v.shape)[0], "corner n", cd.size, "bg", bg, "sig", sig, "sub n", sub.size)
    print("corner frac above bg", fig_hist(v, cd, sub, bg, sig), "corner median", np.median(cd), "corner max", cd.max(), "vol median", np.median(v))
    cover, nrem, _, box = fig_masks(v, bg, sig); print("mask coverage % (thr, open, dil)", cover, "removed in slice", nrem, "box", box)
    print("window examples", fig_window(bg, sig))
    u8 = final_u8(v, bg, sig); fig_before_after(v, u8, bg, sig, box)
    print("opening example voxels", o, "median/mean", md, "u8 nonzero%", (u8 > 0).mean() * 100, "u8 max", u8.max())
