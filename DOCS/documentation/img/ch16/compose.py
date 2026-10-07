#!/usr/bin/env python3
"""Chapter 16 — composite screenshots (4 languages side by side, light/dark, colour-vision strip, phone).
Inputs are the raw captures written by shots_final.mjs into RAW.
FIG_LANG=fr|en  language of the labels;  IMG_DIR=<output folder>;  RAW=<raw captures folder>
"""
import os
from PIL import Image, ImageDraw, ImageFont

LANG = os.environ.get("FIG_LANG", "fr")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get("IMG_DIR", HERE)
RAW = os.environ.get("RAW", "/tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad/r2-16/raw")
os.makedirs(OUT, exist_ok=True)


def L(fr, en):
    return fr if LANG == "fr" else en


def font(size, bold=False):
    p = "/usr/share/fonts/opentype/inter/Inter-%s.otf" % ("Bold" if bold else "Regular")
    try:
        return ImageFont.truetype(p, size)
    except Exception:
        return ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", size)


def labelled(im, label, w, bar=44, color=(28, 35, 51), fs=22):
    im = im.convert("RGB")
    h = round(im.height * w / im.width)
    im = im.resize((w, h), Image.LANCZOS)
    cell = Image.new("RGB", (w, h + bar), (248, 249, 253))
    d = ImageDraw.Draw(cell)
    f = font(fs, True)
    tw = d.textlength(label, font=f)
    d.text(((w - tw) / 2, (bar - fs) / 2 - 3), label, font=f, fill=color)
    cell.paste(im, (0, bar))
    d.rectangle([0, bar, w - 1, h + bar - 1], outline=(197, 203, 216), width=2)
    return cell


def grid(cells, cols, gap=16, bg=(248, 249, 253)):
    rows = [cells[i:i + cols] for i in range(0, len(cells), cols)]
    cw = max(c.width for c in cells)
    rh = [max(c.height for c in r) for r in rows]
    W = cols * cw + (cols + 1) * gap
    H = sum(rh) + (len(rows) + 1) * gap
    out = Image.new("RGB", (W, H), bg)
    y = gap
    for r, h in zip(rows, rh):
        for i, c in enumerate(r):
            out.paste(c, (gap + i * (cw + gap), y))
        y += h + gap
    return out


def save(im, name):
    if im.width > 1600:
        im = im.resize((1600, round(im.height * 1600 / im.width)), Image.LANCZOS)
    im.save(os.path.join(OUT, name), optimize=True)
    print("wrote", name, im.size)


names = {"fr": "Français", "en": "English", "es": "Español", "nl": "Nederlands"}
for page in ("home", "explorer"):
    cells = [labelled(Image.open(f"{RAW}/{page}-{l}.png"), f"{names[l]}  ({l})", 780) for l in ("fr", "en", "es", "nl")]
    save(grid(cells, 2), f"langues-{'accueil' if page == 'home' else 'explorateur'}.png")

cells = []
for page in ("home", "explorer"):
    for th in ("dark", "light"):
        lab = L("Thème sombre", "Dark theme") if th == "dark" else L("Thème clair", "Light theme")
        cells.append(labelled(Image.open(f"{RAW}/theme-{page}-{th}.png"), lab, 780))
save(grid(cells, 2), "theme-clair-sombre.png")

order = ["none", "protanopia", "deuteranopia", "tritanopia", "achromatopsia"]
labs = {"none": L("Sans simulation", "No simulation"), "protanopia": L("Protanopie", "Protanopia"),
        "deuteranopia": L("Deutéranopie", "Deuteranopia"), "tritanopia": L("Tritanopie", "Tritanopia"),
        "achromatopsia": L("Achromatopsie", "Achromatopsia")}
cells = [labelled(Image.open(f"{RAW}/cb-{k}.png"), labs[k], 300, 40, fs=18) for k in order]
save(grid(cells, 5, gap=10), "daltonisme-viewer.png")

mob = [("m-home", L("Accueil", "Home")), ("m-explorer", L("Explorateur", "Explorer")),
       ("m-viewer", L("Viewer", "Viewer")), ("m-viewer-menu", L("Viewer, menu ouvert", "Viewer, menu open"))]
cells = [labelled(Image.open(f"{RAW}/{n}.png"), lab, 360, 40, fs=18) for n, lab in mob]
save(grid(cells, 4, gap=12), "mobile.png")

# the brand-variables block of the page editor's Variables panel (cropped from editeur-variables.png)
src = os.path.join(OUT, "editeur-variables.png")
if os.path.exists(src):
    im = Image.open(src).convert("RGB")
    save(im.crop((0, 468, im.width, 1118)), "variables-marque.png")
