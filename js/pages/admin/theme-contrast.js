/* ============================================================
   Admin — filled-button colours that keep white text readable
   ============================================================
   Twin of dev_server.py _theme_strong_pair and api/site.php
   site_theme_strong_pair, which write the same pair into the compiled
   config/theme.css. This copy only feeds the Appearance tab's live preview,
   so what the operator sees before saving is what the server will compile.

   strong = the primary scaled toward black, from 77 % (what the stylesheet's
   color-mix does) down one percent at a time, until white text on it reaches
   WCAG AA (contrast ≥ 4.5:1); hover = the same colour at 64/77 of that factor.
   Contrast = (1 + 0.05) / (L + 0.05), L the WCAG relative luminance over the
   linearised sRGB channels. Channels are rounded half up in integer maths so
   the three implementations produce the same bytes.
   ============================================================ */

export const AA_TEXT_RATIO = 4.5;

/** [r, g, b] in 0..255 for '#rgb', '#rrggbb', 'rgb(…)' or 'rgba(…)'; null otherwise. */
export function parseRgb(value) {
  const v = String(value == null ? '' : value).trim();
  let m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[0-9.]+%?\s*)?\)$/i.exec(v);
  if (m) {
    const rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
    return rgb.every((c) => c <= 255) ? rgb : null;
  }
  return null;
}

export function luminance(rgb) {
  const lin = rgb.map((c) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function contrastOnWhite(rgb) { return 1.05 / (luminance(rgb) + 0.05); }

function scale(rgb, pct) { return rgb.map((c) => Math.floor((c * pct + 50) / 100)); }

function hex(rgb) { return '#' + rgb.map((c) => c.toString(16).padStart(2, '0').toUpperCase()).join(''); }

/** [strong, hover] as '#RRGGBB', or null when the colour cannot be parsed. */
export function strongPair(primary) {
  const rgb = parseRgb(primary);
  if (!rgb) return null;
  let pct = 77;
  while (pct > 0 && contrastOnWhite(scale(rgb, pct)) < AA_TEXT_RATIO) pct--;
  const hoverPct = Math.floor((pct * 64 + 38) / 77);
  return [hex(scale(rgb, pct)), hex(scale(rgb, hoverPct))];
}
