/**
 * Admin SPA — Markdown renderer
 * =============================
 * Turns a GitHub release body (the changelog file, written in Markdown) into
 * HTML for the Version & Update tab. Pure and dependency-free — a string in, a
 * string out — so it runs unchanged under Node for the tests and nothing it
 * emits depends on the page it lands in.
 *
 * The output is safe to assign to innerHTML whatever the input: every source
 * character passes through escapeHtml before reaching the output, raw HTML is
 * shown as text (only <br>, <kbd>, <sub> and <sup> without attributes pass as
 * tags), and a link is emitted only for an http(s) / mailto destination —
 * anything else stays plain text. An image never loads: the notes come from
 * GitHub and a remote <img> would have this panel fetch third-party URLs (the
 * enforced CSP forbids it anyway), so an image is rendered as a link to it.
 *
 * Supported: ATX and setext headings, `## [TAG]` changelog sections (rendered
 * as a badge), paragraphs and hard breaks, `* - +` and `1.` lists nested by
 * indentation (tight / loose), task items, blockquotes with lazy continuation,
 * fenced code, pipe tables with alignment, thematic breaks, and inline code /
 * strong / emphasis / strikethrough / links / autolinks / bare URLs /
 * backslash escapes. Left out on purpose: indented code blocks (an
 * accidentally indented paragraph would turn into code), HTML blocks,
 * footnotes and entities.
 */

'use strict';

// A release body is a few KiB; the cap bounds the emphasis scan, which is
// quadratic in the length of ONE paragraph for adversarial input.
const MAX_CHARS = 64 * 1024;
const SAFE_URL = /^(?:https?:\/\/|mailto:)/i;
// Inline placeholder: NUL + slot index + NUL. NUL never survives the input
// normalisation, so it cannot collide with content.
const PH = '\u0000';

const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])(?:( +)(.*))?$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)?.*$/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^ {0,3}>/;
const SETEXT_H1_RE = /^ {0,3}=+[ \t]*$/;
const SETEXT_H2_RE = /^ {0,3}-+[ \t]*$/;
const TASK_RE = /^\[([ xX])\][ \t]+/;
const SECTION_TAG_RE = /^\[([A-Za-z][A-Za-z0-9 _-]{0,24})\][ \t]*(.*)$/;

export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const isBlank = (l) => /^[ \t]*$/.test(l);
const indentOf = (l) => /^ */.exec(l)[0].length;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// ── Inline ───────────────────────────────────────────────────────────────────
// Constructs that must not be re-parsed (code, links, allowed tags, escapes) are
// rendered first and parked in `slots` behind a placeholder; the remaining text
// is escaped, emphasis runs on the escaped text, and the placeholders are
// resolved last. Recursive calls (link text) share the slot array so indices
// never collide; only the outermost call resolves.

function anchor(url, innerHtml, title, cls) {
  const t = title ? ` title="${escapeHtml(title)}"` : '';
  const c = cls ? ` class="${cls}"` : '';
  return `<a${c} href="${escapeHtml(url)}"${t} target="_blank" rel="noopener noreferrer">${innerHtml}</a>`;
}

// `[text](dest "title")` starting at s[start] === '['. Brackets nest; the
// destination is <…> or a balanced-paren run; the title is optional.
function parseLink(s, start) {
  let depth = 0;
  let j = start;
  for (; j < s.length; j++) {
    const ch = s[j];
    if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) break;
  }
  if (j >= s.length || s[j + 1] !== '(') return null;
  const text = s.slice(start + 1, j);
  let k = j + 2;
  let dest = '';
  let title = '';
  while (k < s.length && /\s/.test(s[k])) k++;
  if (s[k] === '<') {
    const e = s.indexOf('>', k);
    if (e < 0) return null;
    dest = s.slice(k + 1, e);
    k = e + 1;
  } else {
    let pd = 0;
    const st = k;
    while (k < s.length) {
      const ch = s[k];
      if (ch === '(') pd++;
      else if (ch === ')') { if (pd === 0) break; pd--; }
      else if (/\s/.test(ch)) break;
      k++;
    }
    dest = s.slice(st, k);
  }
  while (k < s.length && /\s/.test(s[k])) k++;
  if (s[k] === '"' || s[k] === "'") {
    const q = s[k];
    const e = s.indexOf(q, k + 1);
    if (e < 0) return null;
    title = s.slice(k + 1, e);
    k = e + 1;
    while (k < s.length && /\s/.test(s[k])) k++;
  }
  if (s[k] !== ')') return null;
  return { text, url: dest.trim(), title, end: k + 1 };
}

function scanLinks(s, slots, hold) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const isImg = c === '!' && s[i + 1] === '[';
    if (c === '[' || isImg) {
      const link = parseLink(s, isImg ? i + 1 : i);
      if (link) {
        if (isImg) {
          const alt = escapeHtml(link.text || link.url);
          out += hold(SAFE_URL.test(link.url) ? anchor(link.url, alt, link.title, 'adm-md-img') : alt);
        } else {
          const inner = inline(link.text, slots);
          out += hold(SAFE_URL.test(link.url) ? anchor(link.url, inner, link.title) : inner);
        }
        i = link.end;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

// Trailing prose punctuation is not part of a bare URL ("see https://x.y/z."),
// nor is a ')' that has no '(' to match inside the URL.
function trimBareUrl(url) {
  let trail = '';
  for (;;) {
    const last = url[url.length - 1];
    if (/[.,;:!?'"*_~]/.test(last)) { trail = last + trail; url = url.slice(0, -1); continue; }
    if (last === ')') {
      const opens = (url.match(/\(/g) || []).length;
      const closes = (url.match(/\)/g) || []).length;
      if (closes > opens) { trail = last + trail; url = url.slice(0, -1); continue; }
    }
    break;
  }
  return { url, trail };
}

const INNER = '(\\S(?:[\\s\\S]*?\\S)?)';
const RE_TRIPLE = new RegExp('\\*\\*\\*' + INNER + '\\*\\*\\*', 'g');
const RE_STRONG = new RegExp('\\*\\*' + INNER + '\\*\\*', 'g');
const RE_EM = new RegExp('\\*' + INNER + '\\*', 'g');
// Underscore emphasis only at word boundaries — `snake_case_name` is not italic.
const RE_STRONG_U = new RegExp('(^|[^\\p{L}\\p{N}_])__' + INNER + '__(?![\\p{L}\\p{N}_])', 'gu');
const RE_EM_U = new RegExp('(^|[^\\p{L}\\p{N}_])_' + INNER + '_(?![\\p{L}\\p{N}_])', 'gu');
const RE_STRIKE = new RegExp('~~' + INNER + '~~', 'g');

function emphasis(s) {
  if (!/[*_~]/.test(s)) return s;
  s = s.replace(RE_TRIPLE, (m, x) => `<em><strong>${emphasis(x)}</strong></em>`);
  s = s.replace(RE_STRONG, (m, x) => `<strong>${emphasis(x)}</strong>`);
  s = s.replace(RE_STRONG_U, (m, pre, x) => `${pre}<strong>${emphasis(x)}</strong>`);
  s = s.replace(RE_EM, (m, x) => `<em>${emphasis(x)}</em>`);
  s = s.replace(RE_EM_U, (m, pre, x) => `${pre}<em>${emphasis(x)}</em>`);
  s = s.replace(RE_STRIKE, (m, x) => `<del>${emphasis(x)}</del>`);
  return s;
}

function inline(src, slots) {
  const hold = (html) => { slots.push(html); return PH + (slots.length - 1) + PH; };
  let s = src;
  // Backslash escapes (a NUL-delimited slot, so the char is never re-parsed).
  s = s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, (m, c) => hold(escapeHtml(c)));
  // Code spans: a backtick run closes on the next run of the same length.
  s = s.replace(/(`+)(?!`)([\s\S]+?)(?<!`)\1(?!`)/g, (m, ticks, code) => {
    let c = code.replace(/\n/g, ' ');
    if (c.length > 2 && c[0] === ' ' && c[c.length - 1] === ' ' && c.trim()) c = c.slice(1, -1);
    return hold(`<code>${escapeHtml(c)}</code>`);
  });
  // The only raw tags let through, attribute-less; any other '<' is escaped below.
  s = s.replace(/<(\/?)(br|kbd|sub|sup)[ \t]*\/?>/gi, (m, sl, tag) => hold(`<${sl}${tag.toLowerCase()}>`));
  s = s.replace(/<((?:https?:\/\/|mailto:)[^\s<>\u0000]+)>/gi, (m, url) => hold(anchor(url, escapeHtml(url))));
  s = scanLinks(s, slots, hold);
  // GFM: a bare URL starts a line or follows whitespace, '(' or an emphasis delimiter.
  s = s.replace(/(^|[\s(*_~])(https?:\/\/[^\s<>\u0000]+)/g, (m, pre, raw) => {
    const { url, trail } = trimBareUrl(raw);
    return pre + hold(anchor(url, escapeHtml(url))) + trail;
  });
  s = escapeHtml(s);
  s = emphasis(s);
  // Two trailing spaces or a backslash break the line; a bare newline is a space.
  s = s.replace(/(?: {2,}|\\)\n/g, '<br>').replace(/\n/g, ' ');
  return s;
}

function resolve(s, slots) {
  return s.replace(/\u0000(\d+)\u0000/g, (m, k) => resolve(slots[+k], slots));
}

export function renderInline(src) {
  const slots = [];
  return resolve(inline(String(src == null ? '' : src), slots), slots);
}

// ── Blocks ───────────────────────────────────────────────────────────────────

function heading(level, text, shift) {
  const tag = `h${Math.min(6, level + shift)}`;
  const m = SECTION_TAG_RE.exec(text.trim());
  if (m) {
    const label = m[1].trim();
    const pretty = label[0].toUpperCase() + label.slice(1).toLowerCase();
    const badge = `<span class="adm-md-badge adm-md-badge-${slug(label)}">${escapeHtml(pretty)}</span>`;
    const rest = m[2] ? ` ${renderInline(m[2])}` : '';
    return `<${tag} class="adm-md-h adm-md-h${level} adm-md-sec">${badge}${rest}</${tag}>`;
  }
  return `<${tag} class="adm-md-h adm-md-h${level}">${renderInline(text)}</${tag}>`;
}

function startsBlock(l) {
  return ATX_RE.test(l) || FENCE_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l) || LIST_RE.test(l);
}

function splitRow(l) {
  let t = l.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function isDelimRow(l) {
  if (!/^[ \t]*\|?[ \t]*:?-+:?/.test(l)) return false;
  return splitRow(l).every((c) => /^:?-+:?$/.test(c));
}

function alignClass(cell) {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return ' class="adm-md-ac"';
  if (right) return ' class="adm-md-ar"';
  return '';
}

function renderTable(lines, i) {
  const head = splitRow(lines[i]);
  const aligns = splitRow(lines[i + 1]);
  if (head.length !== aligns.length) return null;
  const rows = [];
  let j = i + 2;
  while (j < lines.length && !isBlank(lines[j]) && lines[j].includes('|') && !startsBlock(lines[j])) {
    const cells = splitRow(lines[j]);
    while (cells.length < head.length) cells.push('');
    rows.push(cells.slice(0, head.length));
    j++;
  }
  const th = head.map((c, k) => `<th${alignClass(aligns[k])}>${renderInline(c)}</th>`).join('');
  const tb = rows.map((r) => `<tr>${r.map((c, k) => `<td${alignClass(aligns[k])}>${renderInline(c)}</td>`).join('')}</tr>`).join('');
  const html = `<div class="adm-md-table-wrap"><table class="adm-md-table"><thead><tr>${th}</tr></thead>${tb ? `<tbody>${tb}</tbody>` : ''}</table></div>`;
  return { html, next: j };
}

// One list starting at lines[i]. Every line indented past the item's marker
// belongs to the item (lenient about the exact content indent, the way authors
// actually nest); a blank line keeps the item open only if what follows is
// indented too, and a blank line between two items makes the list loose.
function renderList(lines, i, shift) {
  const first = LIST_RE.exec(lines[i]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let tight = true;

  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i]);
    if (!m || m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered) break;
    const spaces = m[3] ? m[3].length : 1;
    const contentIndent = baseIndent + m[2].length + (spaces >= 5 || !m[4] ? 1 : spaces);
    const itemLines = [m[4] || ''];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) {
        let j = i;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j >= lines.length) break;
        const next = lines[j];
        if (indentOf(next) > baseIndent) {
          tight = false;
          for (; i < j; i++) itemLines.push('');
          continue;
        }
        const sib = LIST_RE.exec(next);
        if (sib && sib[1].length === baseIndent && /\d/.test(sib[2]) === ordered) { tight = false; i = j; }
        break;
      }
      const lIndent = indentOf(l);
      if (lIndent > baseIndent) { itemLines.push(l.slice(Math.min(lIndent, contentIndent))); i++; continue; }
      // Lazy continuation: unindented prose right under the item stays in it.
      if (!startsBlock(l) && itemLines[itemLines.length - 1] !== '') { itemLines.push(l.trim()); i++; continue; }
      break;
    }
    items.push(itemLines);
  }

  const lis = items.map((itemLines) => {
    let prefix = '';
    const task = TASK_RE.exec(itemLines[0]);
    if (task) {
      prefix = `<span class="adm-md-task" aria-hidden="true">${task[1] === ' ' ? '☐' : '☑'}</span>`;
      itemLines[0] = itemLines[0].slice(task[0].length);
    }
    return `<li>${prefix}${parseBlocks(itemLines, shift, tight)}</li>`;
  }).join('');
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
  return { html: `<${tag} class="adm-md-list"${startAttr}>${lis}</${tag}>`, next: i };
}

// `tight` = paragraphs of a tight list item are emitted without <p>.
function parseBlocks(lines, shift, tight = false) {
  const out = [];
  let para = [];
  const flush = () => {
    if (!para.length) return;
    const html = renderInline(para.join('\n'));
    out.push(tight ? html : `<p>${html}</p>`);
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { flush(); i++; continue; }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      flush();
      const marker = fence[1];
      const lang = (fence[2] || '').toLowerCase().replace(/[^a-z0-9_+-]/g, '');
      const buf = [];
      i++;
      while (i < lines.length) {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[i]);
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length) { i++; break; }
        buf.push(lines[i]);
        i++;
      }
      const cls = lang ? ` class="lang-${lang}"` : '';
      out.push(`<pre class="adm-md-pre"><code${cls}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    const atx = ATX_RE.exec(line);
    if (atx) {
      flush();
      const text = (atx[2] || '').replace(/[ \t]+#+$/, '').replace(/^#+$/, '');
      out.push(heading(atx[1].length, text, shift));
      i++;
      continue;
    }

    if (para.length && SETEXT_H1_RE.test(line)) { out.push(heading(1, para.join(' '), shift)); para = []; i++; continue; }
    if (para.length && SETEXT_H2_RE.test(line)) { out.push(heading(2, para.join(' '), shift)); para = []; i++; continue; }

    if (HR_RE.test(line)) { flush(); out.push('<hr>'); i++; continue; }

    if (QUOTE_RE.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length) {
        const l = lines[i];
        if (QUOTE_RE.test(l)) { buf.push(l.replace(/^ {0,3}> ?/, '')); i++; continue; }
        if (!isBlank(l) && buf.length && !isBlank(buf[buf.length - 1]) && !startsBlock(l)) { buf.push(l); i++; continue; }
        break;
      }
      out.push(`<blockquote class="adm-md-quote">${parseBlocks(buf, shift)}</blockquote>`);
      continue;
    }

    if (LIST_RE.test(line)) {
      flush();
      const r = renderList(lines, i, shift);
      out.push(r.html);
      i = r.next;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isDelimRow(lines[i + 1])) {
      const r = renderTable(lines, i);
      if (r) { flush(); out.push(r.html); i = r.next; continue; }
    }

    para.push(line.replace(/^[ \t]+/, ''));
    i++;
  }
  flush();
  return out.join('');
}

/**
 * @param {string} text  Markdown source (a GitHub release body).
 * @param {{headingShift?: number, dropLeadingH1?: boolean}} [opts]
 *   headingShift  — `#` becomes h(1+shift); default 2, so the notes never
 *                   outrank the page's own h2 title.
 *   dropLeadingH1 — omit a document-level title (the card already names the
 *                   version).
 * @returns {string} HTML, safe for innerHTML.
 */
export function renderMarkdown(text, opts = {}) {
  const shift = Number.isInteger(opts.headingShift) ? opts.headingShift : 2;
  let src = String(text == null ? '' : text);
  if (!src.trim()) return '';
  src = src.slice(0, MAX_CHARS).replace(/\u0000/g, '\uFFFD').replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  const lines = src.split('\n');
  if (opts.dropLeadingH1) {
    let k = 0;
    while (k < lines.length && isBlank(lines[k])) k++;
    if (k < lines.length && /^ {0,3}#(?:[ \t]|$)/.test(lines[k])) lines.splice(0, k + 1);
  }
  return parseBlocks(lines, shift);
}
