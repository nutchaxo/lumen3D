"""Tiny SVG helper for the chapter 18 figures (palette of DOCS/build/STYLE.md).

FIG_LANG=fr|en selects the language of every text; IMG_DIR the output folder.
"""
import os
from html import escape

LANG = os.environ.get("FIG_LANG", "fr")
OUT = os.environ.get("IMG_DIR", os.path.dirname(os.path.abspath(__file__)))

INK, INK2, LINE, BG = "#1c2333", "#4a5468", "#c5cbd8", "#f8f9fd"
ACC = {
    "blue": ("#3b5bdb", "#e8edff"), "green": ("#2b8a3e", "#ebfbee"),
    "amber": ("#e67700", "#fff4e6"), "violet": ("#7048e8", "#f3f0ff"),
    "teal": ("#0c8599", "#e3fafc"), "red": ("#c92a2a", "#fff0f0"),
    "grey": ("#4a5468", "#eef0f5"),
}
WARN = []


def T(fr, en):
    return fr if LANG == "fr" else en


class Svg:
    def __init__(self, name, h, title=None, w=800):
        self.name, self.w, self.h = name, w, h
        self.p = []
        self.p.append(f'<rect width="{w}" height="{h}" rx="16" fill="{BG}"/>')
        if title:
            self.text(w / 2, 34, title, 18, 800, anchor="middle")

    # -- primitives -------------------------------------------------------
    def text(self, x, y, s, size=13, weight=400, fill=INK, anchor="start", maxw=None, mono=False):
        if maxw is not None and len(s) * size * (0.60 if mono else 0.56) > maxw:
            WARN.append(f"{self.name}: text too wide ({len(s)*size*0.56:.0f}>{maxw}) '{s}'")
        fam = "ui-monospace, Menlo, Consolas, monospace" if mono else "Inter, sans-serif"
        self.p.append(
            f'<text x="{x:g}" y="{y:g}" font-family="{fam}" font-size="{size}" font-weight="{weight}" '
            f'fill="{fill}" text-anchor="{anchor}">{escape(s)}</text>')

    def rect(self, x, y, w, h, fill="#fff", stroke=LINE, rx=12, sw=1.2, dash=None):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.p.append(f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="{rx}" '
                      f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')

    def line(self, x1, y1, x2, y2, color=INK2, sw=2, dash=None, arrow=False):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        m = ' marker-end="url(#arr)"' if arrow else ""
        self.p.append(f'<line x1="{x1:g}" y1="{y1:g}" x2="{x2:g}" y2="{y2:g}" stroke="{color}" '
                      f'stroke-width="{sw}"{d}{m}/>')

    def path(self, d, color=INK2, sw=2, arrow=True, dash=None, fill="none"):
        m = ' marker-end="url(#arr)"' if arrow else ""
        da = f' stroke-dasharray="{dash}"' if dash else ""
        self.p.append(f'<path d="{d}" fill="{fill}" stroke="{color}" stroke-width="{sw}"{da}{m}/>')

    # -- composites ---------------------------------------------------------
    def box(self, x, y, w, h, title, lines=(), acc="blue", tsize=14, lsize=12, head=True, mono_lines=False,
            align="left"):
        strong, soft = ACC[acc]
        self.rect(x, y, w, h, "#fff", LINE)
        if head:
            self.p.append(f'<path d="M{x},{y+34} V{y+12} a12,12 0 0 1 12,-12 H{x+w-12} a12,12 0 0 1 12,12 V{y+34} Z" fill="{soft}"/>')
            self.text(x + w / 2 if align == "center" else x + 14, y + 22, title, tsize, 800, strong,
                      anchor="middle" if align == "center" else "start", maxw=w - 24)
            ty = y + 54
        else:
            ty = y + 24
            self.text(x + w / 2, ty, title, tsize, 800, strong, anchor="middle", maxw=w - 20)
            ty += 22
        for ln in lines:
            self.text(x + 14, ty, ln, lsize, 400, INK2, maxw=w - 24, mono=mono_lines)
            ty += lsize + 6

    def pill(self, x, y, w, h, s, acc="blue", size=12, weight=700):
        strong, soft = ACC[acc]
        self.rect(x, y, w, h, soft, strong, rx=h / 2, sw=1)
        self.text(x + w / 2, y + h / 2 + size * 0.35, s, size, weight, strong, anchor="middle", maxw=w - 10)

    def card(self, x, y, w, h, s_lines, acc="blue", size=12.5, weight=600, align="middle"):
        strong, soft = ACC[acc]
        self.rect(x, y, w, h, soft, strong, rx=10, sw=1.2)
        n = len(s_lines)
        top = y + h / 2 - (n - 1) * (size + 4) / 2 + size * 0.35
        for i, ln in enumerate(s_lines):
            self.text(x + w / 2 if align == "middle" else x + 10, top + i * (size + 4), ln, size,
                      weight if i == 0 else 400, INK if i == 0 else INK2,
                      anchor=align, maxw=w - 14)

    def save(self):
        head = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" '
                f'font-family="Inter, sans-serif">'
                '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" '
                'markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#4a5468"/></marker></defs>')
        os.makedirs(OUT, exist_ok=True)
        with open(os.path.join(OUT, self.name + ".svg"), "w", encoding="utf-8") as f:
            f.write(head + "".join(self.p) + "</svg>")
