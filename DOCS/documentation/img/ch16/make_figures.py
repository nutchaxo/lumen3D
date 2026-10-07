#!/usr/bin/env python3
"""Chapter 16 (Personnaliser et traduire) — every schema of the chapter, generated.

FIG_LANG=fr|en   language of every text in the figures (default fr)
IMG_DIR=<dir>    output folder (default: the folder of this script)

Colours that are *computed* (derived brand tokens, contrast ratios, colour-vision
simulations) are computed here with the same formulas as the platform code:
  - tab-appearance.js  _adjustL / _rgba      (hover = +8 L, dark = -10 L, subtle = alpha)
  - variables.css      color-mix(primary 77 % / 64 %, black)
  - colorblind.js      Machado 2009 matrices, applied to LINEAR-light RGB
"""
import os
import colorsys
from xml.sax.saxutils import escape

LANG = os.environ.get("FIG_LANG", "fr")
OUT = os.environ.get("IMG_DIR", os.path.dirname(os.path.abspath(__file__)))
os.makedirs(OUT, exist_ok=True)

INK, INK2, LINE, CARD = "#1c2333", "#4a5468", "#c5cbd8", "#f8f9fd"
ACC = {
    "blue": ("#3b5bdb", "#e8edff"), "green": ("#2b8a3e", "#ebfbee"),
    "amber": ("#e67700", "#fff4e6"), "violet": ("#7048e8", "#f3f0ff"),
    "teal": ("#0c8599", "#e3fafc"), "red": ("#c92a2a", "#fff0f0"),
    "grey": ("#4a5468", "#eef0f5"),
}
WARN = []


def L(fr, en):
    return fr if LANG == "fr" else en


def est(s, size, bold=False):
    return len(s) * size * (0.60 if bold else 0.545)


class Svg:
    def __init__(self, name, h, title=None):
        self.name, self.h, self.parts = name, h, []
        self.parts.append(
            '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
            'orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#4a5468"/></marker></defs>'
            f'<rect width="800" height="{h}" rx="16" fill="{CARD}"/>')
        if title:
            self.text(400, 34, title, 18, True, anchor="middle")

    def rect(self, x, y, w, h, fill="#fff", stroke=LINE, rx=12, sw=1.2, dash=None):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')

    def text(self, x, y, s, size=13, bold=False, fill=INK, anchor="start", maxw=None, mono=False, italic=False):
        if maxw and est(s, size, bold) > maxw:
            WARN.append(f"{self.name}: text too wide ({est(s, size, bold):.0f}>{maxw}): {s}")
        fam = "JetBrains Mono, Consolas, monospace" if mono else "Inter, sans-serif"
        st = ' font-style="italic"' if italic else ""
        self.parts.append(
            f'<text x="{x}" y="{y}" font-family="{fam}" font-size="{size}" font-weight="{800 if bold else 400}" '
            f'fill="{fill}" text-anchor="{anchor}"{st} xml:space="preserve">{escape(s)}</text>')

    def para(self, x, y, s, size=12, maxw=700, lh=None, **kw):
        import textwrap
        lh = lh or size * 1.4
        n = max(10, int(maxw / (size * 0.53)))
        out = textwrap.wrap(s, n)
        for i, ln in enumerate(out):
            self.text(x, y + i * lh, ln, size, maxw=maxw, **kw)
        return y + len(out) * lh

    def lines(self, x, y, arr, size=13, lh=None, **kw):
        lh = lh or size * 1.35
        for i, s in enumerate(arr):
            self.text(x, y + i * lh, s, size, **kw)

    def card(self, x, y, w, h, head, color="blue", body=None, size=12.5, bsize=None):
        st, so = ACC[color]
        self.rect(x, y, w, h, "#fff")
        self.parts.append(f'<path d="M{x},{y+34} L{x},{y+12} Q{x},{y} {x+12},{y} L{x+w-12},{y} Q{x+w},{y} {x+w},{y+12} L{x+w},{y+34} Z" fill="{so}"/>')
        self.text(x + w / 2, y + 22, head, size, True, st, "middle", maxw=w - 14)
        if body:
            self.lines(x + 12, y + 56, body, bsize or 12, maxw=w - 20)

    def pill(self, x, y, w, h, s, color="blue", size=12, bold=True):
        st, so = ACC[color]
        self.rect(x, y, w, h, so, st, rx=h / 2, sw=1)
        self.text(x + w / 2, y + h / 2 + size * 0.35, s, size, bold, st, "middle", maxw=w - 8)

    def arrow(self, x1, y1, x2, y2, dash=None, sw=2.2):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#4a5468" stroke-width="{sw}"{d} marker-end="url(#arr)"/>')

    def raw(self, s):
        self.parts.append(s)

    def save(self):
        body = "\n".join(self.parts)
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 {self.h}" font-family="Inter, sans-serif">\n{body}\n</svg>\n')
        with open(os.path.join(OUT, self.name), "w", encoding="utf-8") as f:
            f.write(svg)


# ───────────────────────── colour maths ─────────────────────────
def hex2rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def rgb2hex(r, g, b):
    return "#%02X%02X%02X" % tuple(max(0, min(255, round(v))) for v in (r, g, b))


def adjust_l(hexc, dl):
    """Same as tab-appearance.js _adjustL (HSL lightness shift in percentage points)."""
    r, g, b = [v / 255 for v in hex2rgb(hexc)]
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    l = max(0, min(1, l + dl / 100))
    r, g, b = colorsys.hls_to_rgb(h, l, s)
    return rgb2hex(r * 255, g * 255, b * 255)


def mix_black(hexc, pct):
    return rgb2hex(*[v * pct for v in hex2rgb(hexc)])


def lin(c):
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def unlin(v):
    v = max(0.0, min(1.0, v))
    return 255 * (12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055)


def lum(hexc):
    r, g, b = [lin(v) for v in hex2rgb(hexc)]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = lum(a), lum(b)
    if la < lb:
        la, lb = lb, la
    return (la + 0.05) / (lb + 0.05)


LUM = [0.2126, 0.7152, 0.0722]
MATRICES = {
    "none": None,
    "protanopia": [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
    "deuteranopia": [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881],
    "tritanopia": [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.303900],
    "achromatopsia": LUM * 3,
}


def simulate(hexc, name):
    m = MATRICES[name]
    if m is None:
        return hexc
    r, g, b = [lin(v) for v in hex2rgb(hexc)]
    out = [m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b]
    return rgb2hex(*[unlin(v) for v in out])


# ═════════════════════════ 1. config map ═════════════════════════
def fig_config_carte():
    s = Svg("config-carte.svg", 432, L("Un dossier, des fichiers JSON : qui les lit, et ce que le visiteur voit",
                                       "One folder, a few JSON files: who reads them and what visitors see"))
    s.text(24, 66, "config/ (public)", 13, True, ACC["blue"][0])
    s.text(290, 66, L("lu par", "read by"), 13, True, ACC["violet"][0])
    s.text(540, 66, L("ce que le visiteur voit", "what visitors see"), 13, True, ACC["green"][0])
    rows = [
        ("instance.json", "blue", L("le serveur : {{SITE:…}}", "the server: {{SITE:…}}"), "violet",
         L("titre d'onglet, SEO", "tab title, SEO")),
        ("instance.json", "blue", "InstanceConfig + I18n", "violet",
         L("logo, noms, pied, menu, {jetons}", "logo, names, footer, menu, {tokens}")),
        ("theme.json → theme.css", "blue", L("<link> sur chaque page", "<link> on every page"), "violet",
         L("couleurs, police, arrondis", "colours, font, corners")),
        ("legal.json", "blue", "legal.js", "violet", L("page Mentions légales", "Legal notice page")),
        ("pages/<slug>.json", "blue", "PageRenderer", "violet",
         L("accueil, À propos, pages perso", "home, About, custom pages")),
        ("defaults/neutral/", "grey", L("« Réinitialiser »", "“Reset”"), "grey",
         L("valeurs de départ neutres", "neutral starting values")),
    ]
    y = 80
    for f, c1, r, c2, v in rows:
        s.pill(24, y, 215, 34, f, c1, 13)
        s.arrow(243, y + 17, 281, y + 17)
        s.pill(285, y, 215, 34, r, c2, 12.5)
        s.arrow(504, y + 17, 536, y + 17)
        s.rect(540, y, 244, 34, "#fff", LINE, 10)
        s.text(662, y + 22, v, 11.5, False, INK, "middle", maxw=232)
        y += 44
    s.rect(24, y + 6, 760, 62, ACC["red"][1], ACC["red"][0], 12, 1.4, "5 4")
    s.text(40, y + 29, L("Hors de config/ : les brouillons de pages vivent dans api/page-drafts/ (privé, jamais servi).",
                         "Outside config/: page drafts live in api/page-drafts/ (private, never served)."), 12.5, True, ACC["red"][0], maxw=735)
    s.text(40, y + 50, L("config/ est public : aucun secret n'y entre. Les mises à jour de la plateforme n'y touchent pas.",
                         "config/ is public: no secret ever goes in. Platform updates leave it alone."), 12.5, False, INK, maxw=735)
    s.save()


# ═════════════════════════ 2. three channels ═════════════════════════
def fig_trois_canaux():
    s = Svg("trois-canaux.svg", 450, L("Une valeur de instance.json, trois chemins vers l'écran",
                                       "One instance.json value, three routes to the screen"))
    w = 246
    xs = [16, 277, 538]
    heads = [L("① Serveur, avant l'envoi", "① Server, before sending"),
             L("② Navigateur, au chargement", "② Browser, on load"),
             L("③ Navigateur, dans les textes", "③ Browser, inside texts")]
    cols = ["blue", "green", "violet"]
    code = [["<title>{{SITE:pageTitles.", "home|Lumen3D}}</title>"],
            ['<b data-instance=', '"brand.monogram">IR</b>'],
            [L("« Explorez les", "“Explore"), L("{specimenPlural} »", "{SpecimenPlural}”")]]
    what = [L("Remplace le marqueur par la valeur (échappée) ; sinon le texte de repli.",
              "Swaps the marker for the value (escaped); otherwise the fallback text."),
            L("Écrit la valeur dans l'élément : texte, ou attribut avec data-instance-attr.",
              "Writes the value into the element: text, or an attribute with data-instance-attr."),
            L("I18n.t() remplace chaque {jeton} par la valeur de l'instance, dans la langue du visiteur.",
              "I18n.t() swaps each {token} for the instance value, in the visitor's language.")]
    why = [L("Bon titre et bonne description avant tout JavaScript : moteurs de recherche, aperçus de liens.",
             "Right title and description before any JavaScript: search engines, link previews."),
           L("Logo, nom, pied de page, menu : tout ce qui est dans la page mais pas dans une phrase.",
             "Logo, name, footer, menu: whatever sits in the page but not in a sentence."),
           L("Les fichiers de langue restent neutres : aucun « embryon » écrit en dur.",
             "Language files stay neutral: no hard-coded “embryo”.")]
    for i in range(3):
        x = xs[i]
        s.card(x, 56, w, 350, heads[i], cols[i])
        s.text(x + 12, 106, L("Syntaxe", "Syntax"), 11.5, True, INK2)
        s.rect(x + 10, 114, w - 20, 50, "#f1f3f9", LINE, 8)
        for k, p in enumerate(code[i]):
            s.text(x + 18, 134 + k * 16, p, 11, False, INK, maxw=w - 30, mono=True)
        s.text(x + 12, 194, L("Ce qu'il fait", "What it does"), 11.5, True, INK2)
        import textwrap
        for k, ln in enumerate(textwrap.wrap(what[i], 33)):
            s.text(x + 12, 212 + k * 16, ln, 12, False, INK, maxw=w - 24)
        s.text(x + 12, 280, L("Pourquoi", "Why"), 11.5, True, INK2)
        for k, ln in enumerate(textwrap.wrap(why[i], 33)):
            s.text(x + 12, 298 + k * 16, ln, 12, False, INK, maxw=w - 24)
    s.text(400, 432, L("Le même fichier alimente les trois : ils ne peuvent pas se contredire.",
                       "One file feeds all three: they cannot disagree."), 13, True, INK2, "middle")
    s.save()


# ═════════════════════════ 3. localizable value ═════════════════════════
def fig_localisable():
    s = Svg("localisable.svg", 396, L("Une valeur « par langue » : qui répond quoi ?",
                                      "A “per-language” value: who answers what?"))
    s.rect(24, 56, 752, 70, "#fff")
    s.text(40, 82, L("config/instance.json  →  specimen.plural", "config/instance.json  →  specimen.plural"), 12.5, True, ACC["blue"][0])
    s.text(40, 108, '{ "en": "embryos",  "fr": "embryons",  "es": "embriones" }', 14, False, INK, mono=True, maxw=720)
    heads = [L("Langue du visiteur", "Visitor's language"), L("Réponse", "Answer"), L("Pourquoi", "Why")]
    s.text(40, 156, heads[0], 12, True, INK2)
    s.text(240, 156, heads[1], 12, True, INK2)
    s.text(430, 156, heads[2], 12, True, INK2)
    rows = [("fr", "embryons", L("la langue existe dans l'objet", "the language exists in the object"), "green"),
            ("nl", "embryos", L("absente → on prend « en »", "missing → falls back to “en”"), "amber"),
            ("ja", "embryos", L("absente → on prend « en »", "missing → falls back to “en”"), "amber"),
            ("(sans «en»)", L("1re valeur trouvée", "first value found"), L("dernier recours : ni la langue ni « en »", "last resort: neither the language nor “en”"), "grey")]
    y = 168
    for lg, ans, why, c in rows:
        s.pill(40, y, 150, 34, lg, c, 13)
        s.arrow(196, y + 17, 232, y + 17, sw=1.8)
        s.text(240, y + 22, ans, 14, True, INK, maxw=180)
        s.text(430, y + 22, why, 12, False, INK, maxw=345)
        y += 44
    s.text(400, 366, L("Ordre : langue du visiteur → « en » → première valeur.",
                       "Order: visitor's language → “en” → first value."), 13, True, INK2, "middle", maxw=760)
    s.text(400, 384, L("Une chaîne simple (sans accolades) vaut pour toutes les langues.",
                       "A plain string (no braces) applies to every language."), 12, False, INK2, "middle", maxw=760)
    s.save()


# ═════════════════════════ 4. theme pipeline ═════════════════════════
def fig_theme_pipeline():
    s = Svg("theme-pipeline.svg", 420, L("Du sélecteur de couleur à toutes les pages", "From the colour picker to every page"))
    s.card(16, 56, 170, 150, L("Apparence", "Appearance"), "violet",
           [L("couleurs, police,", "colours, font,"), L("arrondis + aperçu", "corners + preview"), L("en direct", "live"), L("→ [Enregistrer]", "→ [Save]")])
    s.arrow(190, 130, 224, 130)
    s.card(228, 56, 170, 150, "theme.json", "blue",
           ['{ "tokens": {', '  "--color-primary":', '    "#2F6BFF" } }', L("ce qui change seul", "only what changed")], 12)
    s.arrow(402, 130, 436, 130)
    s.card(440, 56, 170, 150, L("Le serveur compile", "The server compiles"), "green",
           [L("assainit chaque valeur", "scrubs every value"), L("(pas de { } ; @ < >)", "(no { } ; @ < >)"), L("→ :root { … }", "→ :root { … }")], 12)
    s.arrow(614, 130, 648, 130)
    s.card(652, 56, 132, 150, "theme.css", "amber",
           [L("fichier servi,", "served file,"), L("identique pour", "same for"), L("chaque visiteur", "every visitor")], 12)
    # cascade
    s.text(24, 240, L("L'ordre des feuilles de style (la dernière gagne) :", "Stylesheet order (the last one wins):"), 13, True, INK2)
    items = [("variables.css", L("valeurs d'usine", "factory values"), "grey"),
             ("themes.css", L("sombre / clair", "dark / light"), "grey"),
             ("config/theme.css", L("VOTRE marque", "YOUR brand"), "amber"),
             ("base · components · layout…", L("mise en page", "layout"), "grey"),
             ("tools.css", L("outils", "tools"), "grey")]
    x = 24
    ws = [130, 120, 150, 215, 109]
    for (n, sub, c), w in zip(items, ws):
        s.rect(x, 252, w, 62, ACC[c][1], ACC[c][0], 10, 1.8 if c == "amber" else 1.2)
        s.text(x + w / 2, 278, n, 11.5, True, INK, "middle", maxw=w - 8)
        if sub:
            s.text(x + w / 2, 298, sub, 11.5, False, INK2, "middle", maxw=w - 8)
        x += w + 6
    s.rect(24, 334, 752, 70, "#fff")
    s.lines(40, 358, [L("Un fichier servi (pas un <style> injecté) : la politique de sécurité du site interdit les styles injectés.",
                        "A served file (not an injected <style>): the site's security policy forbids injected styles."),
                      L("Donc le thème est là dès le premier affichage. L'aperçu, lui, change les variables une à une.",
                        "So the theme is there from the first paint. The preview changes variables one by one.")],
            12, 20, maxw=725)
    s.save()


# ═════════════════════════ 5. derived tokens ═════════════════════════
def fig_theme_derives(base="#2F6BFF"):
    s = Svg("theme-derives.svg", 340, L("Un seul clic de couleur, cinq réglages dérivés",
                                        "One colour click, five derived settings"))
    hov, dark = adjust_l(base, 8), adjust_l(base, -10)
    r, g, b = hex2rgb(base)
    strong, strongh = mix_black(base, .77), mix_black(base, .64)
    chips = [(base, "--color-primary", L("votre choix", "your pick")),
             (hov, "--color-primary-hover", L("+ 8 de clarté", "+ 8 lightness")),
             (dark, "--color-primary-dark", L("− 10 de clarté", "− 10 lightness")),
             (f"rgba({r},{g},{b},0.15)", "--color-primary-subtle", L("15 % d'opacité", "15 % opacity")),
             (strong, "--color-primary-strong", L("77 % de noir mélangé", "77 % mixed with black"))]
    x = 24
    for col, name, sub in chips:
        s.rect(x, 62, 140, 74, "#fff")
        fill = col
        s.rect(x + 10, 72, 120, 34, fill if not col.startswith("rgba") else f"rgb({r},{g},{b})", "#c5cbd8", 8)
        if col.startswith("rgba"):
            s.parts.append(f'<rect x="{x+10}" y="72" width="120" height="34" rx="8" fill="#fff"/><rect x="{x+10}" y="72" width="120" height="34" rx="8" fill="{col}" stroke="#c5cbd8"/>')
        label = col if not col.startswith("rgba") else "rgba(…, .15)"
        s.text(x + 70, 124, label, 11, False, INK, "middle", mono=True, maxw=130)
        s.text(x + 70, 152, name.replace("--color-primary", "…primary"), 11, True, INK2, "middle", maxw=136)
        s.text(x + 70, 168, sub, 11, False, INK2, "middle", maxw=136)
        x += 152
    s.rect(24, 188, 752, 128, "#fff")
    s.lines(40, 212, [
        L("• hover, dark : la clarté (HSL) est décalée de +8 / −10 points, comme dans le code de l'éditeur.",
          "• hover, dark: HSL lightness is shifted by +8 / −10 points, as in the editor's code."),
        L("• subtle : la même couleur à 15 % d'opacité (fonds discrets, pastilles).",
          "• subtle: the same colour at 15 % opacity (quiet backgrounds, badges)."),
        L("• strong : pour les boutons pleins à texte blanc ; calculé par le navigateur (color-mix), il fonce seulement.",
          "• strong: for filled buttons with white text; computed by the browser (color-mix), it only darkens."),
        L(f"Valeurs de l'exemple : base {base}, hover {hov}, dark {dark}, strong {strong}, strong-hover {strongh}.",
          f"Values in this example: base {base}, hover {hov}, dark {dark}, strong {strong}, strong-hover {strongh}."),
    ], 12, 22, maxw=715)
    s.save()


# ═════════════════════════ 6. contrast ═════════════════════════
def fig_contraste():
    presets = [("green", "#00A654"), ("blue", "#2F6BFF"), ("purple", "#7C5CFF"), ("teal", "#0FC5A8"),
               ("orange", "#FF7A2F"), ("crimson", "#E5484D")]
    names = {"green": L("Vert", "Green"), "blue": L("Bleu", "Blue"), "purple": L("Violet", "Purple"),
             "teal": L("Turquoise", "Teal"), "orange": L("Orange", "Orange"), "crimson": L("Carmin", "Crimson")}
    s = Svg("contraste.svg", 440, L("Texte blanc sur un bouton de la couleur de marque", "White text on a brand-colour button"))
    s.text(24, 60, L("Contraste du blanc sur --color-primary-strong (la couleur assombrie à 77 %),", "Contrast of white on --color-primary-strong (the colour darkened to 77 %),"), 12.5, False, INK2, maxw=760)
    s.text(24, 78, L("pour les 6 couleurs proposées par l'assistant de première installation.", "for the 6 colours offered by the first-run wizard."), 12.5, False, INK2, maxw=760)
    x0, y0, bw = 130, 104, 480
    maxv = 8.0
    xa = x0 + 30 + bw * 4.5 / maxv
    for i, (k, col) in enumerate(presets):
        strong = mix_black(col, .77)
        c = contrast("#FFFFFF", strong)
        y = y0 + i * 40
        s.text(24, y + 20, names[k], 13, True, INK, maxw=100)
        s.rect(x0, y + 2, 20, 24, strong, "#999", 4)
        w = bw * c / maxv
        ok = c >= 4.5
        s.rect(x0 + 30, y + 4, w, 20, ACC["green" if ok else "amber"][1], ACC["green" if ok else "amber"][0], 6, 1.4)
        num = f"{c:.2f}".replace(".", ",") if LANG == "fr" else f"{c:.2f}"
        s.text(x0 + 30 + max(w, bw * 4.5 / maxv + 6) + 8, y + 20, f"{num} : 1", 13, True, ACC["green" if ok else "amber"][0])
    s.parts.append(f'<line x1="{xa}" y1="{y0-6}" x2="{xa}" y2="{y0+6*40-6}" stroke="{ACC["red"][0]}" stroke-width="2" stroke-dasharray="6 4"/>')
    s.text(xa, y0 + 6 * 40 + 12, L("4,5 : seuil WCAG AA pour du texte courant", "4.5: WCAG AA threshold for body text"), 12, True, ACC["red"][0], "middle", maxw=330)
    s.rect(24, 376, 752, 48, ACC["amber"][1], ACC["amber"][0], 10, 1.2)
    s.text(40, 396, L("Le calcul ne fait que foncer la couleur : il garde le contraste d'origine sans en garantir un minimum.", "The calculation only darkens the colour: it keeps the original contrast without guaranteeing a minimum."), 12, False, INK, maxw=725)
    s.text(40, 414, L("Après un changement de couleur, vérifiez les boutons en thème clair et en thème sombre.", "After changing the colour, check the buttons in both the light and the dark theme."), 12, True, INK, maxw=725)
    s.save()


# ═════════════════════════ 7. page model ═════════════════════════
def fig_page_modele():
    s = Svg("page-modele.svg", 470, L("Une page = des sections, des colonnes, des widgets", "A page = sections, columns, widgets"))
    s.rect(24, 52, 540, 400, "#fff", LINE, 14)
    # section 1
    s.text(36, 74, L("SECTION 1 (bande pleine largeur)", "SECTION 1 (full-width band)"), 11, True, ACC["blue"][0])
    s.rect(36, 82, 516, 104, ACC["blue"][1], ACC["blue"][0], 10, 1.2, "4 3")
    s.rect(46, 92, 166, 84, "#fff", ACC["blue"][0], 8)
    s.text(129, 112, L("Colonne  4/12", "Column  4/12"), 11.5, True, ACC["blue"][0], "middle")
    s.lines(129, 132, [L("Texte (étiquette)", "Text (label)"), L("Titre", "Heading")], 11.5, 18, anchor="middle")
    s.rect(222, 92, 320, 84, "#fff", ACC["blue"][0], 8)
    s.text(382, 112, L("Colonne  8/12", "Column  8/12"), 11.5, True, ACC["blue"][0], "middle")
    s.lines(382, 132, [L("Texte, Liste de liens,", "Text, Link list,"), L("Fiche d'informations…", "Info sheet…")], 11.5, 18, anchor="middle")
    # section 2
    s.text(36, 210, L("SECTION 2", "SECTION 2"), 11, True, ACC["green"][0])
    s.rect(36, 218, 516, 84, ACC["green"][1], ACC["green"][0], 10, 1.2, "4 3")
    for i in range(4):
        x = 46 + i * 126
        s.rect(x, 228, 120, 64, "#fff", ACC["green"][0], 8)
        s.text(x + 60, 248, L("Col. 3/12", "Col. 3/12"), 11, True, ACC["green"][0], "middle")
        s.text(x + 60, 270, L("Compteur", "Counter"), 11.5, False, INK, "middle")
    # section 3
    s.text(36, 326, L("SECTION 3", "SECTION 3"), 11, True, ACC["violet"][0])
    s.rect(36, 334, 516, 66, ACC["violet"][1], ACC["violet"][0], 10, 1.2, "4 3")
    s.rect(46, 344, 496, 46, "#fff", ACC["violet"][0], 8)
    s.text(294, 364, L("Colonne 12/12", "Column 12/12"), 11.5, True, ACC["violet"][0], "middle")
    s.text(294, 381, L("Derniers datasets", "Latest datasets"), 11.5, False, INK, "middle")
    s.text(294, 424, L("… autant de sections que nécessaire (jusqu'à 300)", "… as many sections as needed (up to 300)"), 11.5, False, INK2, "middle")
    # legend
    s.card(584, 56, 200, 396, L("Les règles", "The rules"), "grey")
    items = [
        (L("Section", "Section"), [L("une bande de la page,", "a band of the page,"), L("avec ses marges et", "with its margins and"), L("son fond", "its background")]),
        (L("Colonne", "Column"), [L("largeur de 1 à 12", "width from 1 to 12"), L("(douzièmes), 6 colonnes", "(twelfths), 6 columns"), L("au plus par section ;", "at most per section;"), L("empilées sur mobile", "stacked on mobile")]),
        (L("Widget", "Widget"), [L("une brique de contenu :", "a content brick:"), L("27 types, jusqu'à", "27 types, up to"), L("500 par colonne", "500 per column")]),
    ]
    y = 98
    for h, ls in items:
        s.text(596, y, h, 13, True, INK, maxw=180)
        s.lines(596, y + 18, ls, 11.5, 16, fill=INK2, maxw=180)
        y += 24 + 16 * len(ls) + 12
    s.text(684, 446, L("(≤ 2 Mo par page)", "(≤ 2 MB per page)"), 11.5, False, INK2, "middle")
    s.save()


# ═════════════════════════ 8. the 27 widgets ═════════════════════════
WIDGETS = {
    "basics": ["heading", "richtext", "image", "icon", "button", "badge"],
    "content": ["hero", "cta-banner", "feature-card", "quote", "gallery", "profile", "cite-block", "counter", "video", "logo-strip"],
    "lists": ["accordion", "timeline", "stat-grid", "latest-datasets", "icon-list", "tabs", "link-list", "spec-list"],
    "layout": ["divider", "spacer", "html"],
}
WNAME = {
    "fr": {"heading": "Titre", "richtext": "Texte", "hero": "Héros", "button": "Bouton", "image": "Image", "gallery": "Galerie",
           "stat-grid": "Statistiques", "latest-datasets": "Derniers datasets", "divider": "Séparateur", "spacer": "Espace",
           "html": "HTML", "icon": "Icône", "feature-card": "Carte icône", "quote": "Citation", "accordion": "Accordéon / FAQ",
           "timeline": "Frise chronologique", "cta-banner": "Bandeau d'action", "badge": "Badges", "icon-list": "Liste à icônes",
           "profile": "Profil", "cite-block": "Citation copiable", "tabs": "Onglets", "counter": "Compteur animé", "video": "Vidéo",
           "link-list": "Liste de liens", "spec-list": "Fiche d'informations", "logo-strip": "Bandeau de logos"},
    "en": {"heading": "Heading", "richtext": "Text", "hero": "Hero", "button": "Button", "image": "Image", "gallery": "Gallery",
           "stat-grid": "Stats", "latest-datasets": "Latest datasets", "divider": "Divider", "spacer": "Spacer", "html": "HTML",
           "icon": "Icon", "feature-card": "Icon card", "quote": "Quote", "accordion": "Accordion / FAQ", "timeline": "Timeline",
           "cta-banner": "Call-to-action", "badge": "Badges", "icon-list": "Icon list", "profile": "Profile",
           "cite-block": "Copyable citation", "tabs": "Tabs", "counter": "Animated counter", "video": "Video",
           "link-list": "Link list", "spec-list": "Info sheet", "logo-strip": "Logo strip"},
}
CATNAME = {"fr": {"basics": "Bases", "content": "Contenu", "lists": "Listes & données", "layout": "Structure"},
           "en": {"basics": "Basics", "content": "Content", "lists": "Lists & data", "layout": "Structure"}}


def fig_widgets():
    s = Svg("widgets-27.svg", 450, L("Les 27 widgets de l'éditeur de pages", "The page editor's 27 widgets"))
    cols = {"basics": "blue", "content": "green", "lists": "violet", "layout": "amber"}
    pos = {"basics": (16, 56, 250, 170), "content": (276, 56, 508, 170), "lists": (16, 236, 508, 170), "layout": (534, 236, 250, 170)}
    for cat, (x, y, w, h) in pos.items():
        n = len(WIDGETS[cat])
        s.card(x, y, w, h, f"{CATNAME[LANG][cat]}  ·  {n}", cols[cat])
        per = 2
        cw = (w - 24 - 8 * (per - 1)) / per if w < 300 else (w - 24 - 8 * 2) / 3
        per = 2 if w < 300 else 3
        for i, wid in enumerate(WIDGETS[cat]):
            r, c = divmod(i, per)
            s.pill(x + 12 + c * (cw + 8), y + 46 + r * 30, cw, 24, WNAME[LANG][wid], cols[cat], 11, False)
    s.text(400, 432, L("6 + 10 + 8 + 3 = 27 types. Statistiques, Compteur animé et Derniers datasets se remplissent seuls depuis le catalogue.",
                       "6 + 10 + 8 + 3 = 27 types. Stats, Animated counter and Latest datasets fill themselves from the catalogue."), 11.5, False, INK2, "middle", maxw=770)
    s.save()


# ═════════════════════════ 9. draft / publish ═════════════════════════
def fig_brouillon():
    s = Svg("brouillon-publication.svg", 450, L("Brouillon, publication : deux fichiers, deux publics",
                                                 "Draft, publish: two files, two audiences"))
    s.card(16, 56, 190, 130, L("L'éditeur", "The editor"), "violet",
           [L("vous modifiez la vraie", "you edit the real"), L("page dans un cadre", "page in a frame"), L("(?edit=1)", "(?edit=1)")], 12)
    s.arrow(210, 106, 262, 106)
    s.text(236, 94, L("1,2 s", "1.2 s"), 11, True, INK2, "middle")
    s.card(266, 56, 250, 130, L("Brouillon (privé)", "Draft (private)"), "amber",
           ["api/page-drafts/<slug>.json", L("droits 0600, jamais servi", "mode 0600, never served"), L("visible de l'opérateur seul", "visible to the operator only")], 12)
    s.arrow(520, 106, 560, 106)
    s.text(540, 94, L("Publier", "Publish"), 11, True, INK2, "middle")
    s.card(564, 56, 220, 130, L("Page publiée (publique)", "Published page (public)"), "green",
           ["config/pages/<slug>.json", L("lue par page.html,", "read by page.html,"), L("l'accueil, À propos", "home, About")], 12)
    s.text(24, 216, L("Quatre garde-fous", "Four safeguards"), 14, True, INK)
    g = [("blue", L("Révision", "Revision"), [L("chaque enregistrement", "each save carries"), L("porte la révision lue :", "the revision it read:"), L("document changé ailleurs", "document changed elsewhere"), L("→ refus 409 « stale »", "→ refused 409 “stale”")]),
         ("teal", L("Un seul éditeur", "One editor"), [L("deux onglets sur la même", "two tabs on the same"), L("page : le second se tait", "page: the second goes quiet"), L("(BroadcastChannel) puis", "(BroadcastChannel) until"), L("« reprendre la main »", "“take over”")]),
         ("violet", L("Historique", "History"), [L("annuler / rétablir :", "undo / redo:"), L("60 états, pris après", "60 states, taken after"), L("450 ms de calme", "450 ms of quiet"), ""]),
         ("red", L("Limites", "Limits"), [L("2 Mo par page,", "2 MB per page,"), L("300 sections, 12 colonnes", "300 sections, 12 columns"), L("(6 dans l'éditeur),", "(6 in the editor),"), L("500 widgets/colonne", "500 widgets/column")])]
    x = 16
    for c, h, ls in g:
        s.card(x, 228, 186, 160, h, c, ls, 12, 11.5)
        x += 195
    s.text(400, 416, L("Le brouillon est sauvé tout seul ; « Publier » enregistre d'abord le brouillon puis le promeut en version publique.",
                       "The draft saves itself; “Publish” first saves the draft, then promotes it to the public version."), 12, False, INK2, "middle", maxw=770)
    s.text(400, 436, L("Réseau coupé ou session expirée : la sauvegarde est retentée (et au retour du réseau).",
                       "Network down or session expired: the save is retried (and again when the network is back)."), 12, False, INK2, "middle", maxw=770)
    s.save()


# ═════════════════════════ 10. channel colour ═════════════════════════
def fig_couleur_canal():
    s = Svg("couleur-canal.svg", 450, L("D'où vient la couleur de départ d'un canal ?", "Where does a channel's starting colour come from?"))
    s.text(24, 62, L("Le viewer prend la première réponse non vide, de haut en bas (valeurs d'exemple ; canal « Pecam1 ») :",
                     "The viewer takes the first non-empty answer, top to bottom (example values; channel named “Pecam1”):"), 12.5, False, INK2, maxw=760)
    steps = [
        ("1", "display_defaults[i].color", L("réglages d'affichage du jeu de données", "the dataset's display settings"), "#FF8800", "violet"),
        ("2", "colors[i]", L("liste de couleurs (ancien format)", "colour list (older format)"), "#FFFF00", "blue"),
        ("3", "channels[i].color", L("ce que le pipeline ou l'éditeur a écrit", "what the pipeline or the editor wrote"), "#FF00FF", "green"),
        ("4", L("préréglage par nom", "preset by name"), L("config/instance.json : channelColorPresets", "config/instance.json: channelColorPresets"), "#FF00FF", "amber"),
        ("5", L("cycle neutre", "neutral cycle"), L("vert · bleu clair · magenta · rouge", "green · light blue · magenta · red"), "#00FF00", "grey"),
    ]
    y = 78
    for n, name, sub, col, c in steps:
        s.rect(24, y, 752, 56, "#fff", LINE, 10)
        s.pill(34, y + 12, 34, 32, n, c, 15)
        s.text(80, y + 24, name, 13.5, True, INK, mono=(n in "123"), maxw=330)
        s.text(80, y + 44, sub, 12, False, INK2, maxw=420)
        s.rect(640, y + 12, 60, 32, col, "#999", 6)
        s.text(708, y + 33, col, 11, False, INK2, mono=True, maxw=64)
        y += 64
    s.rect(24, y + 4, 752, 36, ACC["amber"][1], ACC["amber"][0], 10)
    s.text(40, y + 27, L("Le pipeline écrit toujours une couleur (étape 3) : l'étape 4 ne sert qu'aux jeux dont les métadonnées n'en ont pas.",
                         "The pipeline always writes a colour (step 3): step 4 only matters for datasets whose metadata has none."), 11.5, False, INK, maxw=725)
    s.save()


# ═════════════════════════ 11. language choice + lookup ═════════════════════════
def fig_i18n_choix():
    s = Svg("i18n-choix.svg", 470, L("Quelle langue ? Quelle phrase ?", "Which language? Which sentence?"))
    s.text(24, 60, L("A. Au chargement, la langue est choisie ainsi", "A. On load, the language is chosen like this"), 13.5, True, ACC["blue"][0])
    s.rect(24, 72, 360, 360, "#fff")
    boxes = [("1", L("Choix déjà fait ? ", "Choice already made? "), L("clé iribhm-lang du navigateur", "iribhm-lang key of the browser"), "blue"),
             ("2", L("Langue du navigateur", "Browser language"), L("« fr-BE » → « fr »", "“fr-BE” → “fr”"), "green"),
             ("3", L("Anglais", "English"), L("langue de secours, toujours là", "fallback language, always there"), "grey")]
    y = 86
    for n, a, b, c in boxes:
        s.pill(36, y + 8, 30, 30, n, c, 14)
        s.text(78, y + 20, a, 13, True, INK, maxw=290)
        s.text(78, y + 38, b, 11.5, False, INK2, maxw=290)
        y += 74
        if n != "3":
            s.arrow(51, y - 28, 51, y + 2, sw=1.8)
    s.text(36, 318, L("La langue doit exister dans lang/ (liste lue via", "The language must exist in lang/ (list read via"), 11.5, False, INK, maxw=340)
    s.text(36, 335, L("/api/languages, sinon lang/manifest.json).", "/api/languages, else lang/manifest.json)."), 11.5, False, INK, maxw=340)
    s.text(36, 362, L("Charge d'abord « en », puis la langue choisie ; si", "Loads “en” first, then the chosen language; if its"), 11.5, False, INK, maxw=340)
    s.text(36, 379, L("son fichier échoue, l'interface reste en anglais.", "file fails, the interface stays in English."), 11.5, False, INK, maxw=340)
    s.text(36, 406, L("Un clic dans le menu écrit le choix et prévient", "A click in the menu stores the choice and tells"), 11.5, False, INK, maxw=340)
    s.text(36, 423, L("les autres pages ouvertes (événement « storage »).", "the other open pages (“storage” event)."), 11.5, False, INK, maxw=340)
    s.text(416, 60, L("B. Pour chaque texte, I18n.t('clé') cherche", "B. For each text, I18n.t('key') looks"), 13.5, True, ACC["violet"][0])
    s.rect(416, 72, 368, 360, "#fff")
    looks = [("1", L("langue courante", "current language"), L("« Explorez les {specimenPlural} »", "“Explora los {specimenPlural}”") if False else L("fr : « Explorez les {specimenPlural} »", "fr: “Explorez les {specimenPlural}”"), "blue"),
             ("2", L("sinon l'anglais", "else English"), L("en : « Explore {SpecimenPlural} »", "en: “Explore {SpecimenPlural}”"), "green"),
             ("3", L("sinon la clé elle-même", "else the key itself"), L("« landing.heroTitle » (trou visible)", "“landing.heroTitle” (visible gap)"), "red")]
    y = 86
    for n, a, b, c in looks:
        s.pill(428, y + 8, 30, 30, n, c, 14)
        s.text(470, y + 20, a, 13, True, INK, maxw=300)
        s.text(470, y + 38, b, 11.5, False, INK2, maxw=300, mono=False)
        y += 62
    s.text(428, 288, L("Puis chaque {jeton} est remplacé :", "Then each {token} is replaced:"), 13, True, INK)
    s.lines(428, 310, [L("1. valeur donnée par l'appelant", "1. value passed by the caller"),
                       L("2. valeur de l'instance (brand, specimen…)", "2. instance value (brand, specimen…)"),
                       L("3. sinon le {jeton} reste tel quel", "3. otherwise the {token} stays as is")], 12, 20, maxw=345)
    s.rect(428, 380, 344, 42, ACC["amber"][1], ACC["amber"][0], 10)
    s.text(600, 397, L("fr → « Explorez les embryons »", "fr → “Explorez les embryons”"), 12.5, True, INK, "middle", maxw=330)
    s.text(600, 414, L("nl → « Verken Embryos » (pas de nl dans le spécimen)", "nl → “Verken Embryos” (no nl in the specimen)"), 11.5, False, INK, "middle", maxw=334)
    s.save()


# ═════════════════════════ 12. where texts live ═════════════════════════
def fig_i18n_ou():
    s = Svg("i18n-ou.svg", 460, L("Où vit chaque texte du site ?", "Where does each text of the site live?"))
    rows = [
        ("lang/<code>.json", L("l'interface (boutons, messages, panneau d'admin)", "the interface (buttons, messages, admin panel)"),
         L("1 943 clés × 4 langues, parité testée", "1,943 keys × 4 languages, parity tested"), "blue"),
        ("plugins/…/lang/<code>.json", L("les mots de chaque outil", "each tool's own words"),
         L("28 dictionnaires (240 clés) ; manque → anglais", "28 dictionaries (240 keys); missing → English"), "violet"),
        ("config/instance.json", L("nom, accroche, spécimen, pied de page, SEO, types", "name, tagline, specimen, footer, SEO, types"),
         L("valeurs « par langue » : { en, fr, es, nl }", "“per-language” values: { en, fr, es, nl }"), "green"),
        ("config/pages/<slug>.json", L("le texte des pages que vous construisez", "the text of the pages you build"),
         L("dans le document lui-même, par langue", "inside the document itself, per language"), "amber"),
        ("config/legal.json", L("les mentions légales", "the legal notice"),
         L("sections { title, body } par langue", "sections { title, body } per language"), "teal"),
    ]
    y = 56
    for f, what, how, c in rows:
        s.rect(16, y, 768, 66, "#fff")
        s.rect(16, y, 8, 66, ACC[c][0], ACC[c][0], 4)
        s.text(38, y + 26, f, 13.5, True, ACC[c][0], mono=True, maxw=300)
        s.text(38, y + 48, what, 12, False, INK, maxw=330)
        s.text(400, y + 26, L("Comment", "How"), 11, True, INK2)
        s.text(400, y + 48, how, 12, False, INK, maxw=375)
        y += 74
    s.text(400, y + 18, L("Les trois derniers appartiennent à VOTRE site : ni dans lang/, ni touchés par une mise à jour.",
                          "The last three belong to YOUR site: not in lang/, not touched by an update."), 12.5, True, INK2, "middle", maxw=770)
    s.save()


# ═════════════════════════ 13. rate limit ═════════════════════════
def fig_debit():
    s = Svg("limitation-debit.svg", 456, L("Deux seaux à jetons protègent le compteur de visites", "Two token buckets protect the visit counter"))
    s.card(16, 56, 366, 150, L("Un seau par adresse", "One bucket per address"), "blue",
           [L("capacité : 60 jetons", "capacity: 60 tokens"), L("remplissage : 1 jeton par seconde", "refill: 1 token per second"),
            L("4 096 emplacements en mémoire ;", "4,096 slots in memory;"), L("adresse hachée, jamais écrite", "address hashed, never written")], 12.5)
    s.card(418, 56, 366, 150, L("Un seau pour tout le site", "One bucket for the whole site"), "violet",
           [L("capacité : 600 jetons", "capacity: 600 tokens"), L("remplissage : 20 jetons par seconde", "refill: 20 tokens per second"),
            L("plafonne le total, même quand", "caps the total, even when"), L("des adresses partagent un emplacement", "addresses share a slot")], 12.5)
    s.text(400, 240, L("Chaque balise (visite, vue) coûte 1 jeton à chacun des deux seaux", "Each beacon (visit, view) costs 1 token from each of the two buckets"), 13.5, True, INK, "middle", maxw=770)
    s.rect(40, 262, 200, 44, ACC["blue"][1], ACC["blue"][0], 10)
    s.text(140, 289, L("Balise reçue", "Beacon received"), 13, True, ACC["blue"][0], "middle", maxw=190)
    s.rect(300, 262, 200, 44, ACC["amber"][1], ACC["amber"][0], 10)
    s.text(400, 289, L("Les 2 seaux ont un jeton ?", "Both buckets have a token?"), 12.5, True, ACC["amber"][0], "middle", maxw=192)
    s.rect(560, 262, 200, 44, ACC["green"][1], ACC["green"][0], 10)
    s.text(660, 289, L("Oui : on compte", "Yes: counted"), 13, True, ACC["green"][0], "middle", maxw=190)
    s.arrow(244, 284, 296, 284)
    s.arrow(504, 284, 556, 284)
    s.arrow(400, 310, 400, 336)
    s.rect(300, 340, 200, 44, ACC["red"][1], ACC["red"][0], 10)
    s.text(400, 367, L("Non : 429, rien écrit", "No: 429, nothing written"), 12.5, True, ACC["red"][0], "middle", maxw=192)
    s.text(400, 414, L("Une inondation de requêtes coûte un hachage et deux mises à jour de 16 octets,", "A flood of requests costs one hash and two 16-byte updates,"), 12, False, INK2, "middle", maxw=770)
    s.text(400, 432, L("jamais une réécriture du fichier de statistiques.", "never a rewrite of the statistics file."), 12, False, INK2, "middle", maxw=770)
    s.save()


# ═════════════════════════ 14. what is stored ═════════════════════════
def fig_stats_stockage():
    s = Svg("stats-stockage.svg", 440, L("Ce qui est compté, ce qui est gardé, ce qui n'existe pas", "What is counted, what is kept, what does not exist"))
    s.card(16, 56, 330, 250, "api/stats.json", "blue", None)
    code = ['{ "global": { "visits": 19,', '    "views": 127, "downloads": 0,', '    "since": "2026-10-07…" },',
            '  "daily": { "2026-10-07":', '    { "views": 127, "visits": 19 } },', '  "datasets": { "3d/Embryo-…": {',
            '    "views": 87,', '    "lastViewed": "2026-10-07…" } } }']
    for i, ln in enumerate(code):
        s.text(30, 104 + i * 20, ln, 11.5, False, INK, mono=True, maxw=310)
    s.text(30, 276, L("(chiffres de l'exemple : jeu de démonstration)", "(example figures: demonstration set)"), 11, False, INK2, italic=True, maxw=310)
    s.card(366, 56, 418, 118, L("Ce qui est compté", "What is counted"), "green",
           [L("visite : une ouverture de l'accueil par session", "visit: one home-page opening per session"),
            L("vue : un jeu ouvert dans le viewer, une fois par session", "view: a dataset opened in the viewer, once per session"),
            L("téléchargement : un fichier de download/ servi en entier", "download: a file from download/ served in full")], 12)
    s.card(366, 188, 418, 118, L("Ce qui n'est PAS gardé", "What is NOT kept"), "red",
           [L("aucune adresse IP, aucun cookie, aucun identifiant", "no IP address, no cookie, no identifier"),
            L("pas de navigateur, de pays, de page de provenance", "no browser, country or referring page"),
            L("pas de visiteur : seulement des compteurs", "no visitor: counters only")], 12)
    s.rect(16, 322, 768, 100, "#fff")
    s.lines(32, 346, [
        L("• Session = un onglet : une clé de sessionStorage, qui reste dans le navigateur et disparaît à sa fermeture.",
          "• Session = a tab: a sessionStorage key, which stays in the browser and disappears when it closes."),
        L("• Les aperçus de l'administration ne comptent pas ; l'identifiant d'un jeu doit désigner un jeu qui existe.",
          "• Admin previews are not counted; a dataset id must name a dataset that exists."),
        L("• Les écritures sont regroupées : au plus toutes les 5 secondes, à la lecture de l'admin, et à l'arrêt.",
          "• Writes are batched: at most every 5 seconds, when the admin reads, and at shutdown."),
    ], 12, 24, maxw=735)
    s.save()


# ═════════════════════════ 15. colour-vision swatches ═════════════════════════
def fig_daltonisme():
    pal = ["#e6194B", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#42d4f4"]
    names = [("none", L("Sans simulation", "No simulation")), ("protanopia", L("Protanopie (rouge absent)", "Protanopia (no red)")),
             ("deuteranopia", L("Deutéranopie (vert absent)", "Deuteranopia (no green)")),
             ("tritanopia", L("Tritanopie (bleu absent)", "Tritanopia (no blue)")), ("achromatopsia", L("Achromatopsie", "Achromatopsia"))]
    s = Svg("daltonisme-teintes.svg", 372, L("Les mêmes 7 teintes, selon la déficience simulée", "The same 7 hues, by simulated deficiency"))
    y = 56
    for key, nm in names:
        s.text(24, y + 26, nm, 13, True, INK, maxw=215)
        for i, c in enumerate(pal):
            s.rect(250 + i * 74, y + 4, 66, 34, simulate(c, key), "#99a", 8)
        y += 48
    s.text(400, 312, L("Même calcul que le navigateur : matrices de Machado et al. (2009) sur la lumière linéaire ;",
                       "Same maths as the browser: Machado et al. (2009) matrices on linear light;"), 12, False, INK2, "middle", maxw=770)
    s.text(400, 330, L("achromatopsie = luminance seule.", "achromatopsia = luminance only."), 12, False, INK2, "middle", maxw=770)
    s.text(400, 352, L("C'est une simulation pour vérifier une figure, pas une correction de couleurs.",
                       "It is a simulation to check a figure, not a colour correction."), 12.5, True, INK2, "middle", maxw=770)
    s.save()


# ═════════════════════════ 16. theme-boot timeline ═════════════════════════
def fig_theme_boot():
    s = Svg("theme-boot.svg", 400, L("Pourquoi le thème clair ne clignote pas", "Why the light theme does not flash"))
    s.text(24, 62, L("Chaque page est livrée en thème sombre. Un visiteur qui a choisi « clair » doit l'avoir", "Every page ships in the dark theme. A visitor who chose “light” must have it"), 12.5, False, INK2, maxw=765)
    s.text(24, 80, L("AVANT le premier affichage :", "BEFORE the first paint:"), 12.5, True, INK2, maxw=765)
    steps = [(L("1. Le <head> se lit", "1. <head> is parsed"), "grey"),
             (L("2. theme-boot.js", "2. theme-boot.js"), "green"),
             (L("3. Premier affichage", "3. First paint"), "blue"),
             (L("4. Fin du <body>", "4. End of <body>"), "violet")]
    desc = [[L("feuilles de style", "stylesheets"), L("(thème sombre par défaut)", "(dark theme by default)")],
            [L("lit localStorage ;", "reads localStorage;"), L("si « light » → data-theme", "if “light” → data-theme"), L("passe à light", "becomes light")],
            [L("la page apparaît déjà", "the page appears already"), L("dans le bon thème", "in the right theme")],
            [L("theme.js branche le", "theme.js wires the"), L("bouton, suit les autres", "button, follows the other"), L("onglets", "tabs")]]
    x = 16
    for (t, c), d in zip(steps, desc):
        s.card(x, 96, 176, 140, t, c, d, 12, 12)
        x += 198
    for xa in (194, 392, 590):
        s.arrow(xa, 166, xa + 20, 166, sw=1.8)
    s.rect(16, 256, 768, 130, "#fff")
    s.lines(32, 282, [
        L("• Sans theme-boot.js : un visiteur « clair » verrait d'abord une page sombre, puis un éclair blanc.",
          "• Without theme-boot.js: a “light” visitor would first see a dark page, then a white flash."),
        L("• Premier passage, sans choix mémorisé : le thème sombre (fort contraste pour la fluorescence).",
          "• First visit, no stored choice: the dark theme (high contrast for fluorescence)."),
        L("• Le panneau d'administration a son propre réglage (clé adm-theme), indépendant du site public.",
          "• The admin panel has its own setting (adm-theme key), independent from the public site."),
        L("• Si le navigateur bloque le stockage : la page garde son thème par défaut, sans erreur.",
          "• If the browser blocks storage: the page keeps its default theme, with no error."),
    ], 12, 24, maxw=735)
    s.save()


# ═════════════════════════ 17. perf telemetry ═════════════════════════
def fig_perf():
    s = Svg("perf-telemetrie.svg", 390, L("PerfTelemetry : un carnet de bord qui ne quitte jamais l'onglet", "PerfTelemetry: a logbook that never leaves the tab"))
    s.card(16, 56, 230, 190, L("Le viewer note", "The viewer notes"), "blue",
           [L("viewer.init", "viewer.init"), L("viewer.timepoint.load", "viewer.timepoint.load"), L("volume.load.bricks", "volume.load.bricks"),
            L("texture.upload.prepare", "texture.upload.prepare"), L("viewer.frame_time (≈ 4 s)", "viewer.frame_time (≈ 4 s)"), L("viewer.context_lost …", "viewer.context_lost …")], 12)
    s.arrow(250, 150, 288, 150)
    s.card(292, 56, 230, 190, L("En mémoire, bornés", "In memory, bounded"), "green",
           [L("3 000 durées (spans)", "3,000 spans"), L("5 000 événements", "5,000 events"), L("500 mesures en cours", "500 open measures"),
            L("des compteurs", "some counters"), L("rien n'est écrit", "nothing is written")], 12)
    s.arrow(526, 150, 564, 150)
    s.card(568, 56, 216, 190, L("Console seulement", "Console only"), "violet",
           ["PerfTelemetry", ".getSummary()", L("min, moyenne, p50, p95", "min, mean, p50, p95"), L("par opération", "per operation"), L("pour un diagnostic", "for a diagnosis")], 12)
    s.rect(16, 266, 768, 106, ACC["red"][1], ACC["red"][0], 12, 1.4, "5 4")
    s.lines(32, 292, [
        L("Aucun envoi réseau : rien dans PerfTelemetry n'est posté au serveur ni à un tiers.",
          "No network sending: nothing in PerfTelemetry is posted to the server or a third party."),
        L("Les compteurs de visites (api/stats.json) sont un système tout à fait distinct.",
          "The visit counters (api/stats.json) are a completely separate system."),
        L("Il n'est chargé que par la page du viewer ; on le lit à la main, depuis la console du navigateur.",
          "It is loaded only by the viewer page; you read it by hand, from the browser console."),
    ], 12.5, 24, maxw=735)
    s.save()


if __name__ == "__main__":
    for fn in (fig_config_carte, fig_trois_canaux, fig_localisable, fig_theme_pipeline, fig_theme_derives, fig_contraste,
               fig_page_modele, fig_widgets, fig_brouillon, fig_couleur_canal, fig_i18n_choix, fig_i18n_ou, fig_debit,
               fig_stats_stockage, fig_daltonisme, fig_theme_boot, fig_perf):
        fn()
    for w in WARN:
        print("WARN", w)
    print("figures written to", OUT, f"(FIG_LANG={LANG})")
