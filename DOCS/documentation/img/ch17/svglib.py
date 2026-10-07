"""Petite bibliothèque SVG du chapitre 17 (mêmes teintes que les autres chapitres).

Langue : variable d'environnement FIG_LANG (fr|en) ; dossier de sortie : IMG_DIR.
"""
import os
from pathlib import Path

LANG = os.environ.get("FIG_LANG", "fr")
OUT = Path(os.environ.get("IMG_DIR", Path(__file__).resolve().parent))
OUT.mkdir(parents=True, exist_ok=True)

INK, INK2, LINE, BG = "#1c2333", "#4a5468", "#c5cbd8", "#f8f9fd"
P = {"blue": ("#3b5bdb", "#e8edff"), "green": ("#2b8a3e", "#ebfbee"), "amber": ("#e67700", "#fff4e6"),
     "violet": ("#7048e8", "#f3f0ff"), "teal": ("#0c8599", "#e3fafc"), "red": ("#c92a2a", "#fff0f0"),
     "grey": ("#4a5468", "#eef0f5")}
MONO = "'DejaVu Sans Mono', 'Liberation Mono', monospace"
WARN = []


def tr(fr, en):
    return fr if LANG == "fr" else en


def fmt_bytes(n):
    """Taille décimale comme dans le reste de la documentation (Mo, ko / MB, kB)."""
    mo, ko, o = tr("Mo", "MB"), tr("ko", "kB"), tr("o", "B")
    if n >= 1e9:
        s = f"{n / 1e9:.1f} " + tr("Go", "GB")
    elif n >= 1e6:
        s = f"{n / 1e6:.1f} {mo}" if n < 1e8 else f"{n / 1e6:.0f} {mo}"
    elif n >= 1e3:
        s = f"{n / 1e3:.1f} {ko}" if n < 1e5 else f"{n / 1e3:.0f} {ko}"
    else:
        s = f"{n} {o}"
    return s.replace(".", ",") if LANG == "fr" else s


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def T(x, y, s, size=13, weight=400, fill=INK, anchor="start", mono=False, maxw=None, extra=""):
    """Texte ; maxw = largeur disponible (px) : avertit si l'estimation déborde."""
    if maxw is not None:
        est = len(s) * size * (0.60 if mono else 0.56)
        if est > maxw:
            WARN.append(f"[{LANG}] texte trop long ({est:.0f} > {maxw}) : {s[:50]}")
    ff = f' font-family="{MONO}"' if mono else ""
    if mono:
        s = s.replace(" ", "\u00a0")
    return (f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{fill}" '
            f'text-anchor="{anchor}"{ff} {extra}>{esc(s)}</text>')


def title(s, sub=None):
    out = [T(400, 32, s, 18, 800, anchor="middle")]
    if sub:
        out.append(T(400, 52, sub, 12.5, 400, INK2, "middle"))
    return out


def R(x, y, w, h, fill="#fff", stroke=LINE, rx=8, sw=1.2, extra=""):
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" '
            f'stroke="{stroke}" stroke-width="{sw}" {extra}/>')


def L(x1, y1, x2, y2, stroke=INK2, sw=1.6, dash=None, arrow=False):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    m = ' marker-end="url(#arr)"' if arrow else ""
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{stroke}" stroke-width="{sw}"{d}{m}/>'


def PATH(d, stroke=INK2, sw=1.8, fill="none", arrow=False, dash=None):
    m = ' marker-end="url(#arr)"' if arrow else ""
    da = f' stroke-dasharray="{dash}"' if dash else ""
    return f'<path d="{d}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{m}{da}/>'


def CIRC(x, y, r, fill, stroke="none", sw=1):
    return f'<circle cx="{x}" cy="{y}" r="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>'


def card(x, y, w, h, color, head=None, lines=(), size=12.5, head_size=14, rx=12, mono_lines=False, lh=None):
    """Carte colorée : titre en gras puis des lignes de texte."""
    s, soft = P[color]
    out = [R(x, y, w, h, soft, s, rx, 1.6)]
    yy = y + 22
    if head:
        out.append(T(x + 14, yy, head, head_size, 800, s, maxw=w - 28))
        yy += 8
    lh = lh or size * 1.5
    for ln in lines:
        yy += lh
        out.append(T(x + 14, yy, ln, size, 400, INK, mono=mono_lines, maxw=w - 28))
    return out


def pill(x, y, label, color, size=11.5, h=20):
    s, soft = P[color]
    w = len(label) * size * 0.58 + 16
    return [R(x, y, w, h, s, s, h / 2, 0), T(x + w / 2, y + h / 2 + size * 0.35, label, size, 700, "#fff", "middle")], w


def head(h):
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 %d" font-family="Inter, sans-serif">'
            '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
            '<path d="M0,0 L10,5 L0,10 z" fill="#4a5468"/></marker>'
            '<marker id="arrr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
            '<path d="M0,0 L10,5 L0,10 z" fill="#c92a2a"/></marker></defs>'
            '<rect width="800" height="%d" rx="16" fill="%s"/>' % (h, h, BG))


def save(name, h, body):
    flat = []
    for b in body:
        if isinstance(b, (list, tuple)):
            flat.extend(b)
        else:
            flat.append(b)
    (OUT / name).write_text(head(h) + "".join(flat) + "</svg>", encoding="utf-8")


def wrap(s, n):
    words, lines, cur = s.split(" "), [], ""
    for w in words:
        if cur and len(cur) + len(w) + 1 > n:
            lines.append(cur)
            cur = w
        else:
            cur = (cur + " " + w).strip()
    return lines + [cur]


def mtext(x, y, s, n, size=12.5, lh=None, fill=INK, weight=400, anchor="start", mono=False):
    """Texte multi-lignes (coupé à n caractères)."""
    lh = lh or size * 1.45
    return [T(x, y + i * lh, ln, size, weight, fill, anchor, mono) for i, ln in enumerate(wrap(s, n))]
