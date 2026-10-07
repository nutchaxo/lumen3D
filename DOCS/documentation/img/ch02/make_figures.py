"""Generates ch02/loc-bars.svg. UI_LANG=fr|en, IMG_DIR_BASE=<dir> (output goes to <dir>/ch02)."""
import os
LANG = os.environ.get('UI_LANG', 'fr')
base = os.environ.get('IMG_DIR_BASE')
out = os.path.join(base, 'ch02') if base else os.path.dirname(os.path.abspath(__file__))
os.makedirs(out, exist_ok=True)
T = {
 'fr': dict(title="Combien de lignes de code, par langage ?", sub="Fichiers suivis par git, hors bibliothèques tierces, hors tests",
            js="JavaScript", py="Python", php="PHP", css="CSS", html="HTML", glsl="GLSL (shaders)",
            glsl_note="≈ 1 800 lignes, écrites à l'intérieur de fichiers JavaScript",
            foot="Les tests (≈ 26 000 lignes de JavaScript, 12 000 de Python, 3 000 de PHP) ne sont pas comptés.",
            fmt=lambda n: f"{n:,}".replace(',', ' ')),
 'en': dict(title="How many lines of code, per language?", sub="Files tracked by git, excluding third-party libraries and tests",
            js="JavaScript", py="Python", php="PHP", css="CSS", html="HTML", glsl="GLSL (shaders)",
            glsl_note="about 1,800 lines, written inside JavaScript files",
            foot="Tests (about 26,000 lines of JavaScript, 12,000 of Python, 3,000 of PHP) are not counted.",
            fmt=lambda n: f"{n:,}"),
}[LANG]
rows = [('js', 68400, '#e67700'), ('py', 27342, '#3b5bdb'), ('php', 16941, '#7048e8'),
        ('css', 9403, '#0c8599'), ('html', 4210, '#c92a2a'), ('glsl', 1800, '#2b8a3e')]
X0, W = 190, 520
mx = 68400
s = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 360" font-family="Inter, sans-serif">',
     '<rect width="800" height="360" rx="16" fill="#f8f9fd"/>',
     f'<text x="400" y="32" text-anchor="middle" font-size="17" font-weight="800" fill="#1c2333">{T["title"]}</text>',
     f'<text x="400" y="52" text-anchor="middle" font-size="12.5" fill="#4a5468">{T["sub"]}</text>']
y = 76
for key, n, col in rows:
    w = max(4, W * n / mx)
    s.append(f'<text x="{X0-12}" y="{y+19}" text-anchor="end" font-size="14" font-weight="700" fill="#1c2333">{T[key]}</text>')
    s.append(f'<rect x="{X0}" y="{y}" width="{w:.0f}" height="28" rx="6" fill="{col}"/>')
    lab = ('≈ ' if key == 'glsl' else '') + T['fmt'](n)
    if w > 120:
        s.append(f'<text x="{X0+w-10:.0f}" y="{y+19}" text-anchor="end" font-size="13" font-weight="800" fill="#fff">{lab}</text>')
    else:
        s.append(f'<text x="{X0+w+8:.0f}" y="{y+19}" font-size="13" font-weight="800" fill="#1c2333">{lab}</text>')
    y += 40
s.append(f'<text x="{X0}" y="{y+8}" font-size="12" font-style="italic" fill="#4a5468">{T["glsl_note"]}</text>')
s.append(f'<text x="400" y="342" text-anchor="middle" font-size="12" fill="#4a5468">{T["foot"]}</text>')
s.append('</svg>')
open(os.path.join(out, 'loc-bars.svg'), 'w', encoding='utf-8').write('\n'.join(s))
print('wrote', out)
