#!/usr/bin/env python3
"""Figures of chapters 9, 10 and 11 (data figures).
FIG_LANG=fr|en   IMG_DIR=<root of the image tree> (default DOCS/documentation/img, img-en for English)
Run from the repo root:  FIG_LANG=en IMG_DIR=DOCS/documentation/img-en python3 <this file>
"""
import os, json, math
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager

LANG = os.environ.get('FIG_LANG', 'fr')
REPO = '/home/user/lumen3D'
ROOT = os.environ.get('IMG_DIR') or (f'{REPO}/DOCS/documentation/img-en' if LANG == 'en' else f'{REPO}/DOCS/documentation/img')
def out(ch):
    d = f'{ROOT}/{ch}'; os.makedirs(d, exist_ok=True); return d
def T(fr, en): return en if LANG == 'en' else fr

for f in font_manager.findSystemFonts():
    if '/inter/' in f.lower() and 'Display' not in f: font_manager.fontManager.addfont(f)
plt.rcParams.update({'font.family': 'Inter', 'font.size': 11, 'axes.edgecolor': '#c5cbd8', 'axes.labelcolor': '#1c2333',
                     'xtick.color': '#4a5468', 'ytick.color': '#4a5468', 'text.color': '#1c2333', 'axes.spines.top': False, 'axes.spines.right': False})
BLUE, GREEN, AMBER, VIOLET, TEAL, RED = '#3b5bdb', '#2b8a3e', '#e67700', '#7048e8', '#0c8599', '#c92a2a'
INK2 = '#4a5468'
GCOL = np.array([0, 1, .5]); MCOL = np.array([1, 0, 1])   # Pecam1 (vert), Sox2 (magenta)

# ------------------------------------------------------------------ ch09: one ray, three modes
def ray_modes():
    n = 768                       # one sample per voxel on a 768-voxel axis
    delta = 1.0 / n
    t = (np.arange(n) + .5) * delta
    g = 0.85 * np.exp(-((t - .33) / .07) ** 2)             # front blob (green)
    m = 0.75 * np.exp(-((t - .52) / .10) ** 2)             # blob behind (magenta), overlaps
    v = np.stack([g, m], 1)
    # Fluorescence (mode 1)
    mip = np.maximum.accumulate(v, 0)
    c1 = mip[-1, 0] * GCOL + mip[-1, 1] * MCOL
    # Natural fluorescence (mode 2): absorption 1.8, emissionGain 2.2, whitePoint 2, saturation 1.18
    ab, eg, wp, sat = 1.8, 2.2, 2.0, 1.18
    Tm = 1.0; col = np.zeros(3); Tt = []; cum = []
    for s in v:
        d = s.max()
        if d > .0025:
            a = 1 - math.exp(-ab * delta * d); emit = s[0] * GCOL + s[1] * MCOL
            col += Tm * eg * delta * emit; Tm *= (1 - a)
        Tt.append(Tm); cum.append(col.copy())
    Lw = np.array([.2126, .7152, .0722])
    def tone(col):
        Lin = col @ Lw; Lout = Lin * (1 + Lin / wp ** 2) / (1 + Lin)
        toned = col * (Lout / max(Lin, 1e-5))
        return np.clip(Lout + (toned - Lout) * sat, 0, 1)
    # Structure DVR (mode 0): reference alpha 0.05 per 0.01
    acc = np.zeros(3); al = 0.0; als = []
    for s in v:
        a_loc = s.max()
        if a_loc > .01:
            lc = s[0] * GCOL + s[1] * MCOL
            a = 1 - max(1 - .05 * a_loc, 0) ** (delta / .01)
            acc += (1 - al) * a * lc; al += (1 - al) * a
        als.append(al)
    EXPN, EXPD = float(os.environ.get('EN', 4)), float(os.environ.get('ED', 3))
    nat = tone(col * EXPN / EXPN)  # tone-mapped emission (exposure scales the emission gain below)
    # exposure multiplies clebEmit: recompute with it
    Tm = 1.0; col2 = np.zeros(3)
    for s in v:
        d = s.max()
        if d > .0025:
            a = 1 - math.exp(-ab * delta * d); emit = s[0] * GCOL + s[1] * MCOL
            col2 += Tm * eg * EXPN * delta * emit; Tm *= (1 - a)
    nat = tone(col2)
    dvr = np.clip(acc * EXPD, 0, 1)
    fig = plt.figure(figsize=(11, 6.6), dpi=170)
    gs = fig.add_gridspec(2, 3, width_ratios=[1, 1, .42], hspace=.55, wspace=.28)
    ax = fig.add_subplot(gs[0, 0]); ax.plot(t, g, color=GREEN, lw=2.2, label=T('canal vert (devant)', 'green channel (in front)')); ax.plot(t, m, color=VIOLET, lw=2.2, label=T('canal magenta (derrière)', 'magenta channel (behind)'))
    ax.set_title(T('Ce que le rayon rencontre', 'What the ray meets'), loc='left', fontweight='bold'); ax.set_xlabel(T('profondeur le long du rayon  →', 'depth along the ray  →')); ax.set_ylabel(T('valeur affichée', 'displayed value')); ax.legend(frameon=False, fontsize=9, loc='upper right'); ax.set_ylim(0, 1.15)
    ax = fig.add_subplot(gs[0, 1]); ax.plot(t, mip[:, 0], color=GREEN, lw=2.2); ax.plot(t, mip[:, 1], color=VIOLET, lw=2.2)
    ax.set_title(T('① Fluorescence : le maximum', '① Fluorescence: the maximum'), loc='left', fontweight='bold'); ax.set_xlabel(T('profondeur  →', 'depth  →')); ax.set_ylabel(T('maximum rencontré', 'maximum met so far')); ax.set_ylim(0, 1.15)
    ax = fig.add_subplot(gs[1, 0]); ax.plot(t, Tt, color=AMBER, lw=2.2, label=T('lumière restante (transmittance)', 'light left (transmittance)'))
    cn = np.array(cum).sum(1); ax.plot(t, cn / cn.max(), color=TEAL, lw=2, ls='--', label=T('lumière accumulée (relative)', 'light collected (relative)'))
    ax.set_title(T('② Naturelle : émission + absorption', '② Natural: emission + absorption'), loc='left', fontweight='bold'); ax.set_xlabel(T('profondeur  →', 'depth  →')); ax.legend(frameon=False, fontsize=8.5, loc='lower right'); ax.set_ylim(0, 1.1)
    ax = fig.add_subplot(gs[1, 1]); ax.plot(t, als, color=RED, lw=2.2)
    ax.set_title(T('③ Structure : opacité cumulée', '③ Structure: accumulated opacity'), loc='left', fontweight='bold'); ax.set_xlabel(T('profondeur  →', 'depth  →')); ax.set_ylabel(T('opacité cumulée', 'accumulated opacity')); ax.set_ylim(0, max(.2, max(als) * 1.3))
    ax = fig.add_subplot(gs[:, 2]); ax.axis('off'); ax.set_xlim(0, 1); ax.set_ylim(0, 1)
    ax.text(.5, .99, T('Pixel obtenu', 'Resulting pixel'), ha='center', va='top', fontweight='bold')
    for k, (c, lab) in enumerate([(np.clip(c1, 0, 1), T('① Fluorescence', '① Fluorescence')), (nat, T('② Naturelle', '② Natural')), (dvr, T('③ Structure', '③ Structure'))]):
        y0 = .72 - k * .30
        ax.add_patch(plt.Rectangle((.12, y0), .76, .2, color=c, ec='#c5cbd8'))
        ax.text(.5, y0 - .03, lab, ha='center', va='top', fontsize=10)
    fig.savefig(f'{out("ch09")}/rayon-1d.png', facecolor='white', bbox_inches='tight'); plt.close(fig)
    print('ray: c1', c1, 'nat', nat, 'dvr', dvr, 'T_end', Tt[-1], 'alpha_end', als[-1])

# ------------------------------------------------------------------ ch09: jitter against banding
def hash2(x, y):   # Hoskins-style fract hash, as in the shader
    p = np.stack([x, y], -1) * np.array([.1031, .1030])
    p3 = np.modf(np.stack([p[..., 0], p[..., 1], p[..., 0]], -1) * .1031)[0]
    p3 = p3 + (p3 * (p3[..., [1, 2, 0]] + 33.33)).sum(-1, keepdims=True)
    return np.modf((p3[..., 0] + p3[..., 1]) * p3[..., 2])[0]
def jitter():
    W = 260; yy, xx = np.mgrid[0:W, 0:W]
    cx = cy = W / 2; R = 100.0
    r2 = (xx - cx) ** 2 + (yy - cy) ** 2
    inside = r2 < R * R
    half = np.sqrt(np.maximum(R * R - r2, 0))           # half chord of the sphere along the ray (pixels)
    # a ray crosses the sphere between z0-half and z0+half; one sample every `step` pixels
    step = 14.0
    z_start = -R
    def count(offset):
        a = (np.floor((half - 0 + 0) / step - offset + 1e-9) + np.floor(half / step + offset)) # samples inside [-half, half]
        lo = np.ceil((-half - z_start) / step - offset); hi = np.floor((half - z_start) / step - offset)
        return np.where(inside, hi - lo + 1, 0)
    fixed = count(np.zeros_like(half))
    jit = count(hash2(xx.astype(float), yy.astype(float)))
    sm = np.where(inside, 2 * half / step, 0)
    fig, axs = plt.subplots(1, 3, figsize=(11, 3.9), dpi=170)
    for a, im, ti in zip(axs, [fixed, jit, sm], [T('Sans décalage : anneaux', 'No offset: rings'), T('Avec décalage aléatoire : grain fin', 'With random offset: fine grain'), T('Valeur exacte (pour comparer)', 'Exact value (for comparison)')]):
        a.imshow(im, cmap='magma', vmin=0, vmax=2 * R / step); a.set_title(ti, fontsize=11, fontweight='bold'); a.axis('off')
    fig.suptitle(T('Une sphère uniforme, un échantillon tous les %d pixels (simulation)' % step, 'A uniform sphere, one sample every %d pixels (simulation)' % step), y=1.02, fontsize=11, color=INK2)
    fig.savefig(f'{out("ch09")}/jitter.png', facecolor='white', bbox_inches='tight'); plt.close(fig)

# ------------------------------------------------------------------ ch11: window and gamma curves
def curves():
    x = np.arange(0, 256)
    fig, ax = plt.subplots(1, 2, figsize=(11, 4.2), dpi=170)
    a = ax[0]
    mn, mx = 20, 220
    y = np.clip((x - mn) / (mx - mn), 0, 1)
    a.plot(x, y, color=BLUE, lw=2.6); a.axvline(mn, color=INK2, ls=':'); a.axvline(mx, color=INK2, ls=':')
    a.text(mn - 3, .5, 'min = 20', rotation=90, ha='right', va='center', color=INK2); a.text(mx + 3, .5, 'max = 220', rotation=90, ha='left', va='center', color=INK2)
    a.plot([120], [.5], 'o', color=AMBER, ms=9); a.annotate(T('120 → 0,5', '120 → 0.5'), (120, .5), (140, .28), arrowprops=dict(arrowstyle='->', color=AMBER), color=AMBER, fontweight='bold')
    a.fill_between(x, 0, y, color='#e8edff', alpha=.7)
    a.set_title(T('La fenêtre min / max', 'The min / max window'), loc='left', fontweight='bold'); a.set_xlabel(T('valeur enregistrée (0–255)', 'stored value (0–255)')); a.set_ylabel(T('valeur après la fenêtre (0–1)', 'value after the window (0–1)')); a.set_xlim(0, 255); a.set_ylim(-.02, 1.05)
    b = ax[1]; u = np.linspace(0, 1, 300)
    for gm, c, lab in [(0.5, GREEN, T('gamma 0,5 : éclaircit les tons faibles', 'gamma 0.5: brightens faint tones')), (1, INK2, T('gamma 1 : droite', 'gamma 1: straight line')), (2, RED, T('gamma 2 : assombrit les tons faibles', 'gamma 2: darkens faint tones'))]:
        b.plot(u, u ** gm, color=c, lw=2.4, label=lab)
    b.plot([.5], [.5 ** .5], 'o', color=AMBER, ms=9); b.annotate('0,5 → 0,707' if LANG == 'fr' else '0.5 → 0.707', (.5, .707), (.56, .45), arrowprops=dict(arrowstyle='->', color=AMBER), color=AMBER, fontweight='bold', bbox=dict(fc='white', ec='none', alpha=.9))
    b.set_title(T('Le gamma', 'The gamma'), loc='left', fontweight='bold'); b.set_xlabel(T('valeur dans la fenêtre (0–1)', 'value inside the window (0–1)')); b.set_ylabel(T('valeur après le gamma', 'value after the gamma')); b.legend(frameon=False, fontsize=9, loc='upper left'); b.set_xlim(0, 1); b.set_ylim(0, 1.02)
    fig.tight_layout(); fig.savefig(f'{out("ch11")}/courbes.png', facecolor='white'); plt.close(fig)

# ------------------------------------------------------------------ ch11: real histograms of the demo dataset
def display_hist(counts):
    c = list(map(float, counts)); n = len(c)
    bg = max(1, math.ceil(n * .04)); peak = max(1, max(c[bg:]))
    c = [min(v, peak * 1.35) if i < bg else v for i, v in enumerate(c)]
    for i in range(1, n - 1):
        if c[i] < c[i - 1] * .2 and c[i] < c[i + 1] * .2: c[i] = (c[i - 1] + c[i + 1]) / 2
    return c
def auto_range(counts, total):
    lo, hi = total * .005, total * .995; cum = 0; mn = 0; mx = len(counts) - 1
    for i, v in enumerate(counts):
        cum += v
        if cum <= lo: mn = i
        if cum <= hi: mx = i
    return mn / len(counts), min(1, (mx + 1) / len(counts))
def histos():
    m = json.load(open(f'{REPO}/DATA_WEB/3d/Embryo-E95-Em2-Pecam1-Sox2/bricks/manifest.json'))
    names = [c['name'] for c in json.load(open(f'{REPO}/DATA_WEB/3d/Embryo-E95-Em2-Pecam1-Sox2/metadata.json'))['channels']]
    cols = ['#3b82f6', '#00d26a', '#e040fb']
    fig, axs = plt.subplots(2, 3, figsize=(11, 5.6), dpi=170, sharex=True)
    for k, h in enumerate(m['histograms'][:3]):
        c = np.array(h['counts']); x = np.arange(64) * 4 + 2
        a = axs[0, k]; a.bar(x, c, width=4, color=cols[k]); a.set_title(names[k], fontweight='bold', loc='left', color=cols[k]); a.set_yscale('linear')
        a.text(.97, .95, T('%.0f %% des voxels dans la 1re colonne' % (100 * c[0] / c.sum()), '%.0f %% of voxels in the 1st bar' % (100 * c[0] / c.sum())), transform=a.transAxes, ha='right', va='top', fontsize=8.5, color=INK2)
        d = np.array(display_hist(c)); a2 = axs[1, k]
        a2.fill_between(x, 0, d / d.max(), color=cols[k], alpha=.35, step='mid'); a2.plot(x, d / d.max(), color=cols[k], lw=1.6, drawstyle='steps-mid')
        mn, mx = auto_range(c, c.sum()); a2.axvline(mn * 255, color=INK2, ls=':'); a2.axvline(mx * 255, color=INK2, ls=':')
        a2.set_xlabel(T('valeur enregistrée (0–255)', 'stored value (0–255)')); a2.set_xlim(0, 256)
        print(names[k], 'auto min/max', round(mn * 255), round(mx * 255), 'bg share', c[0] / c.sum())
        if k == 0: a.set_ylabel(T('nombre de voxels (réel)', 'voxel count (raw)')); a2.set_ylabel(T('dessin du panneau', 'what the panel draws'))
    fig.tight_layout(); fig.savefig(f'{out("ch11")}/histogrammes.png', facecolor='white'); plt.close(fig)

# ------------------------------------------------------------------ ch11: floor LUT
def floor_lut():
    x = np.arange(256); f = 26
    lut = np.where(x <= f, 0, np.minimum(255, np.round((x - f) * 255 / (255 - f))))
    fig, ax = plt.subplots(figsize=(5.4, 3.8), dpi=170)
    ax.plot(x, x, color='#c5cbd8', lw=1.5, ls='--', label=T('sans plancher', 'without floor')); ax.plot(x, lut, color=BLUE, lw=2.4, label=T("avec un plancher de %d (DAPI)" % f, "with a floor of %d (DAPI)" % f))
    ax.axvspan(0, f, color='#fff0f0'); ax.text(f / 2, 200, T('→ 0', '→ 0'), ha='center', color=RED, fontweight='bold')
    ax.set_xlabel(T('valeur enregistrée', 'stored value')); ax.set_ylabel(T('valeur après le plancher', 'value after the floor')); ax.legend(frameon=False, fontsize=9, loc='lower right'); ax.set_xlim(0, 255); ax.set_ylim(0, 260)
    fig.tight_layout(); fig.savefig(f'{out("ch11")}/plancher.png', facecolor='white'); plt.close(fig)
    print('LUT floor 6, 120 ->', round((120 - 6) * 255 / 249))

if __name__ == '__main__':
    ray_modes(); jitter(); curves(); histos(); floor_lut()
