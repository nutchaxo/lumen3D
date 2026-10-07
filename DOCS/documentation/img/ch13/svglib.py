"""Petite bibliothèque SVG du chapitre 13 (texte mesuré avec la vraie police Inter : rien ne déborde).

    FIG_LANG=fr|en   langue des textes (tr(fr, en))
    IMG_DIR=...      dossier de sortie (défaut : le dossier de ce fichier)
"""
import os
from pathlib import Path

from PIL import ImageFont

LANG = os.environ.get("FIG_LANG", "fr")
OUT = Path(os.environ.get("IMG_DIR", Path(__file__).resolve().parent))
OUT.mkdir(parents=True, exist_ok=True)

INK, INK2, LINE, BG = "#1c2333", "#4a5468", "#c5cbd8", "#f8f9fd"
P = {"blue": ("#3b5bdb", "#e8edff"), "green": ("#2b8a3e", "#ebfbee"), "amber": ("#e67700", "#fff4e6"),
     "violet": ("#7048e8", "#f3f0ff"), "teal": ("#0c8599", "#e3fafc"), "red": ("#c92a2a", "#fff0f0"),
     "grey": ("#4a5468", "#f1f3f5")}

_FONT_DIR = Path("/usr/share/fonts/opentype/inter")
_FONTS = {}
_WEIGHT_FILE = {400: "Inter-Regular.otf", 500: "Inter-Medium.otf", 600: "Inter-SemiBold.otf",
                700: "Inter-Bold.otf", 800: "Inter-ExtraBold.otf"}


def tr(fr, en):
    return fr if LANG == "fr" else en


def _font(size, weight):
    key = (round(size * 4), weight)
    if key not in _FONTS:
        f = _WEIGHT_FILE.get(weight, "Inter-Regular.otf")
        _FONTS[key] = ImageFont.truetype(str(_FONT_DIR / f), int(round(size * 4)))
    return _FONTS[key]


def measure(s, size=13, weight=400):
    """Largeur en px d'une chaîne (police Inter réelle)."""
    return _font(size, weight).getlength(s) / 4.0


def wrap(s, size, weight, maxw):
    words, lines, cur = s.split(" "), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if cur and measure(trial, size, weight) > maxw:
            lines.append(cur)
            cur = w
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return lines


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


class Svg:
    def __init__(self, name, h, w=800):
        self.name, self.h, self.w = name, h, w
        self.parts = []
        self.defs = []
        self.warnings = []

    # ── primitives ───────────────────────────────────────────────
    def raw(self, s):
        self.parts.append(s)

    def text(self, x, y, s, size=13, weight=400, fill=INK, anchor="start", style=""):
        self.parts.append(f'<text x="{x:g}" y="{y:g}" font-size="{size:g}" font-weight="{weight}" fill="{fill}" '
                          f'text-anchor="{anchor}" {style}>{esc(s)}</text>')
        w = measure(s, size, weight)
        left = x - (w / 2 if anchor == "middle" else (w if anchor == "end" else 0))
        if left < 2 or left + w > self.w - 2:
            self.warnings.append(f"texte hors cadre: {s[:40]!r} ({left:.0f}..{left + w:.0f})")
        return w

    def title(self, s, y=34):
        self.text(self.w / 2, y, s, 18, 800, anchor="middle")

    def rect(self, x, y, w, h, fill="#fff", stroke=LINE, rx=0, sw=1, extra=""):
        self.parts.append(f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="{rx:g}" fill="{fill}" '
                          f'stroke="{stroke}" stroke-width="{sw:g}" {extra}/>')

    def line(self, x1, y1, x2, y2, color=INK2, w=1.6, dash=None, arrow=False, arrow_start=False, extra=""):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        m = ' marker-end="url(#arr)"' if arrow else ""
        if arrow and color != INK2:
            m = f' marker-end="url(#arr_{color[1:]})"'
            self._need_marker(color)
        ms = ""
        if arrow_start:
            ms = f' marker-start="url(#arrs_{color[1:]})"'
            self._need_marker(color, start=True)
        self.parts.append(f'<line x1="{x1:g}" y1="{y1:g}" x2="{x2:g}" y2="{y2:g}" stroke="{color}" '
                          f'stroke-width="{w:g}"{d}{m}{ms} {extra}/>')

    def arrow(self, x1, y1, x2, y2, color=INK2, w=2.2, dash=None, both=False):
        self.line(x1, y1, x2, y2, color, w, dash, arrow=True, arrow_start=both)

    def path(self, d, stroke=INK2, w=1.8, fill="none", dash=None, arrow=False, extra=""):
        da = f' stroke-dasharray="{dash}"' if dash else ""
        m = ""
        if arrow:
            m = ' marker-end="url(#arr)"' if stroke == INK2 else f' marker-end="url(#arr_{stroke[1:]})"'
            if stroke != INK2:
                self._need_marker(stroke)
        self.parts.append(f'<path d="{d}" fill="{fill}" stroke="{stroke}" stroke-width="{w:g}"{da}{m} {extra}/>')

    def circle(self, cx, cy, r, fill="#fff", stroke=LINE, sw=1.4, extra=""):
        self.parts.append(f'<circle cx="{cx:g}" cy="{cy:g}" r="{r:g}" fill="{fill}" stroke="{stroke}" '
                          f'stroke-width="{sw:g}" {extra}/>')

    def _need_marker(self, color, start=False):
        cid = color[1:]
        tag = f'arrs_{cid}' if start else f'arr_{cid}'
        if any(tag in d for d in self.defs):
            return
        if start:
            self.defs.append(f'<marker id="{tag}" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" '
                             f'orient="auto"><path d="M10,0 L0,5 L10,10 z" fill="{color}"/></marker>')
        else:
            self.defs.append(f'<marker id="{tag}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
                             f'orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="{color}"/></marker>')

    # ── blocs de texte mesurés ───────────────────────────────────
    def para(self, x, y, s, maxw, size=12.5, weight=400, fill=INK, lh=None, anchor="start", style=""):
        """Texte à la ligne dans maxw ; renvoie le y du bas."""
        lh = lh or size * 1.38
        for ln in wrap(s, size, weight, maxw):
            self.text(x, y, ln, size, weight, fill, anchor, style)
            y += lh
        return y - lh + (size * 0.3)

    def card(self, x, y, w, h, color, head, body="", body_size=12.5, head_size=13.5, pad=14, bold_body=False,
             fill=None):
        st, so = P[color]
        self.rect(x, y, w, h, fill or so, st, 12, 1.4)
        ty = y + pad + head_size * 0.8
        for ln in wrap(head, head_size, 800, w - 2 * pad):
            self.text(x + pad, ty, ln, head_size, 800, st)
            ty += head_size * 1.3
        if body:
            by = ty + 3
            bottom = self.para(x + pad, by, body, w - 2 * pad, body_size, 600 if bold_body else 400, INK)
            if bottom > y + h - 4:
                self.warnings.append(f"carte trop pleine: {head[:30]!r} bas={bottom:.0f} > {y + h - 4:.0f}")

    def pill(self, x, y, s, color="blue", size=12, h=24, anchor="start"):
        st, so = P[color]
        w = measure(s, size, 700) + 22
        left = x - w / 2 if anchor == "middle" else x
        self.rect(left, y, w, h, so, st, h / 2, 1.2)
        self.text(left + w / 2, y + h / 2 + size * 0.35, s, size, 700, st, "middle")
        return w

    def numdot(self, x, y, n, color="red", r=11):
        st, _ = P[color]
        self.circle(x, y, r, st, st, 1)
        self.text(x, y + 4.5, str(n), 13, 800, "#fff", "middle")

    def save(self):
        head = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" font-family="Inter, sans-serif">'
                f'<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
                f'orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#4a5468"/></marker>{"".join(self.defs)}</defs>'
                f'<rect width="{self.w}" height="{self.h}" rx="16" fill="{BG}"/>')
        (OUT / self.name).write_text(head + "".join(self.parts) + "</svg>", encoding="utf-8")
        for w in self.warnings:
            print(f"  [!] {self.name}: {w}")
        return self
