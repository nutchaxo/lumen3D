// The admin Markdown renderer (js/pages/admin/markdown.js) turns a GitHub
// release body into HTML for the Version & Update tab. Locks three things:
//   1. the Markdown the changelogs actually use renders as the right structure
//      (headings, `## [TAG]` badges, nested lists, quotes, tables, fences, inline);
//   2. the output is innerHTML-safe for ANY input (raw HTML shown as text, only
//      http(s)/mailto links, no <img>, no event handlers, no javascript: URL);
//   3. every changelog ever published renders without throwing, with balanced
//      tags — and tab-updates.js actually uses the renderer.
//
// Run: node tests/js/test_admin_markdown.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, renderInline, escapeHtml } from '../../js/pages/admin/markdown.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const md = (s, o) => renderMarkdown(s, o);

// ── 1. structure ─────────────────────────────────────────────────────────────

// Headings shift by two so the notes never outrank the tab's own h2 title, and
// the class keeps the ORIGINAL level for styling.
assert.equal(md('# T'), '<h3 class="adm-md-h adm-md-h1">T</h3>');
assert.equal(md('## T'), '<h4 class="adm-md-h adm-md-h2">T</h4>');
assert.equal(md('###### T'), '<h6 class="adm-md-h adm-md-h6">T</h6>');
assert.equal(md('# T', { headingShift: 0 }), '<h1 class="adm-md-h adm-md-h1">T</h1>');
assert.equal(md('## T ##'), '<h4 class="adm-md-h adm-md-h2">T</h4>', 'closing hashes stripped');
assert.equal(md('#hashtag'), '<p>#hashtag</p>', 'no space after # = not a heading');
assert.equal(md('Title\n---'), '<h4 class="adm-md-h adm-md-h2">Title</h4>', 'setext h2');
assert.equal(md('Title\n==='), '<h3 class="adm-md-h adm-md-h1">Title</h3>', 'setext h1');
assert.equal(md('a\n\n---\n\nb'), '<p>a</p><hr><p>b</p>', 'thematic break');
assert.equal(md('* * *'), '<hr>', 'spaced hr is not a list');

// The changelog convention `## [ADDED]` becomes a coloured badge.
assert.equal(md('## [ADDED]'),
  '<h4 class="adm-md-h adm-md-h2 adm-md-sec"><span class="adm-md-badge adm-md-badge-added">Added</span></h4>');
assert.equal(md('## [FIXED] Viewer'),
  '<h4 class="adm-md-h adm-md-h2 adm-md-sec"><span class="adm-md-badge adm-md-badge-fixed">Fixed</span> Viewer</h4>');
assert.ok(md('## [Breaking change]').includes('adm-md-badge-breaking-change">Breaking change</span>'), 'multi-word tag slugified');

// dropLeadingH1 removes only a document title at the very top.
assert.equal(md('# Changelog v1.2.3 (Plateforme Web)\n\n## [FIXED]\n* x', { dropLeadingH1: true }),
  '<h4 class="adm-md-h adm-md-h2 adm-md-sec"><span class="adm-md-badge adm-md-badge-fixed">Fixed</span></h4><ul class="adm-md-list"><li>x</li></ul>');
assert.equal(md('\n\n# T\ntext', { dropLeadingH1: true }), '<p>text</p>', 'leading blanks tolerated');
assert.equal(md('intro\n# T', { dropLeadingH1: true }), '<p>intro</p><h3 class="adm-md-h adm-md-h1">T</h3>', 'a later h1 stays');

// Paragraphs, soft and hard breaks.
assert.equal(md('a\nb'), '<p>a b</p>', 'soft break is a space');
assert.equal(md('a  \nb'), '<p>a<br>b</p>', 'two trailing spaces = hard break');
assert.equal(md('a\\\nb'), '<p>a<br>b</p>', 'backslash hard break');
assert.equal(md('a\n\nb'), '<p>a</p><p>b</p>');

// Lists: tight vs loose, nesting by indentation, ordered start, task items.
assert.equal(md('* a\n* b'), '<ul class="adm-md-list"><li>a</li><li>b</li></ul>', 'tight list has no <p>');
assert.equal(md('- a\n\n- b'), '<ul class="adm-md-list"><li><p>a</p></li><li><p>b</p></li></ul>', 'loose list keeps <p>');
assert.equal(md('* a\n  - b\n  - c\n* d'),
  '<ul class="adm-md-list"><li>a<ul class="adm-md-list"><li>b</li><li>c</li></ul></li><li>d</li></ul>', 'nested bullets');
assert.equal(md('1. a\n   - b\n2. c'),
  '<ol class="adm-md-list"><li>a<ul class="adm-md-list"><li>b</li></ul></li><li>c</li></ol>', 'bullet under ordered');
assert.equal(md('1. a\n  - b'),
  '<ol class="adm-md-list"><li>a<ul class="adm-md-list"><li>b</li></ul></li></ol>', 'two-space nesting under "1. " is accepted');
assert.equal(md('3. a\n4. b'), '<ol class="adm-md-list" start="3"><li>a</li><li>b</li></ol>', 'ordered start');
assert.equal(md('* first\n  continued\n* second'),
  '<ul class="adm-md-list"><li>first continued</li><li>second</li></ul>', 'indented continuation joins the item');
assert.equal(md('* first\nlazy\n* second'),
  '<ul class="adm-md-list"><li>first lazy</li><li>second</li></ul>', 'lazy continuation');
assert.equal(md('* item\n\nAfter.'), '<ul class="adm-md-list"><li>item</li></ul><p>After.</p>', 'blank + unindented text ends the list');
assert.equal(md('* item\n\n  second para\n* next'),
  '<ul class="adm-md-list"><li><p>item</p><p>second para</p></li><li><p>next</p></li></ul>', 'internal blank makes the list loose');
assert.equal(md('- [ ] todo\n- [x] done'),
  '<ul class="adm-md-list"><li><span class="adm-md-task" aria-hidden="true">☐</span>todo</li><li><span class="adm-md-task" aria-hidden="true">☑</span>done</li></ul>');
assert.equal(md('1.5 mm'), '<p>1.5 mm</p>', 'a decimal is not an ordered item');
assert.equal(md('-foo'), '<p>-foo</p>', 'marker needs a space');
assert.equal(md('**bold** start'), '<p><strong>bold</strong> start</p>', 'a bold line is not a bullet');
assert.equal(md('* a\n\n1. b'),
  '<ul class="adm-md-list"><li>a</li></ul><ol class="adm-md-list"><li>b</li></ol>', 'type change starts a new list');

// Blockquotes: nested Markdown inside, lazy continuation, blank line ends it.
assert.equal(md('> **a**\n> b'), '<blockquote class="adm-md-quote"><p><strong>a</strong> b</p></blockquote>');
assert.equal(md('> a\nlazy'), '<blockquote class="adm-md-quote"><p>a lazy</p></blockquote>');
assert.equal(md('> a\n\nout'), '<blockquote class="adm-md-quote"><p>a</p></blockquote><p>out</p>');
assert.equal(md('> * x\n> * y'), '<blockquote class="adm-md-quote"><ul class="adm-md-list"><li>x</li><li>y</li></ul></blockquote>');

// Fenced code: verbatim, escaped, no inline parsing, language class sanitised.
assert.equal(md('```js\n**not bold** <b>\n```'), '<pre class="adm-md-pre"><code class="lang-js">**not bold** &lt;b&gt;</code></pre>');
assert.equal(md('~~~\nx\n~~~'), '<pre class="adm-md-pre"><code>x</code></pre>');
assert.equal(md('```\nopen forever'), '<pre class="adm-md-pre"><code>open forever</code></pre>', 'unclosed fence runs to the end');
assert.equal(md('````\n```\ninner\n```\n````'), '<pre class="adm-md-pre"><code>```\ninner\n```</code></pre>', 'shorter run does not close');
assert.ok(!md('```x"y onclick\nz\n```').includes('onclick'), 'language class is sanitised');

// Pipe tables: alignment classes, escaped pipes, ragged rows padded.
{
  const html = md('| A | B | C |\n|:--|:-:|--:|\n| 1 | a \\| b | 3 |\n| x |');
  assert.ok(html.startsWith('<div class="adm-md-table-wrap"><table class="adm-md-table"><thead><tr><th>A</th><th class="adm-md-ac">B</th><th class="adm-md-ar">C</th></tr></thead>'));
  assert.ok(html.includes('<tbody><tr><td>1</td><td class="adm-md-ac">a | b</td><td class="adm-md-ar">3</td></tr><tr><td>x</td><td class="adm-md-ac"></td><td class="adm-md-ar"></td></tr></tbody>'));
  assert.equal(md('| a | b |\n| c | d |'), '<p>| a | b | | c | d |</p>', 'no delimiter row = not a table');
  assert.equal(md('a | b\n--|--\n1 | 2\n\nafter'),
    '<div class="adm-md-table-wrap"><table class="adm-md-table"><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div><p>after</p>');
}

// ── 2. inline ────────────────────────────────────────────────────────────────

assert.equal(renderInline('**b** *i* `c` ~~s~~'), '<strong>b</strong> <em>i</em> <code>c</code> <del>s</del>');
assert.equal(renderInline('***x***'), '<em><strong>x</strong></em>');
assert.equal(renderInline('**a *b* c**'), '<strong>a <em>b</em> c</strong>');
assert.equal(renderInline('__b__ _i_'), '<strong>b</strong> <em>i</em>');
assert.equal(renderInline('snake_case_name and file_name_x'), 'snake_case_name and file_name_x', 'intraword underscores stay');
assert.equal(renderInline('2 * 3 * 4'), '2 * 3 * 4', 'spaced asterisks stay');
assert.equal(renderInline('a ** b'), 'a ** b');
assert.equal(renderInline('`a*b*c`'), '<code>a*b*c</code>', 'no emphasis inside code');
assert.equal(renderInline('`` a`b ``'), '<code>a`b</code>', 'double-backtick span with a backtick inside');
assert.equal(renderInline('\\*not em\\*'), '*not em*', 'backslash escapes');
assert.equal(renderInline('\\\\'), '\\', 'escaped backslash');
assert.equal(renderInline('x_y*'), 'x_y*');
assert.equal(renderInline('Résumé *été* café'), 'Résumé <em>été</em> café', 'unicode letters');
assert.equal(renderInline('_l\'été_'), '<em>l&#39;été</em>');

// Links: only http(s)/mailto get an anchor, always new-tab + noopener.
assert.equal(renderInline('[t](https://x.y/z)'), '<a href="https://x.y/z" target="_blank" rel="noopener noreferrer">t</a>');
assert.equal(renderInline('[t](https://x.y "Title")'), '<a href="https://x.y" title="Title" target="_blank" rel="noopener noreferrer">t</a>');
assert.equal(renderInline('[t](<https://x.y/a b>)'), '<a href="https://x.y/a b" target="_blank" rel="noopener noreferrer">t</a>');
assert.equal(renderInline('[t](https://x.y/a_(b))'), '<a href="https://x.y/a_(b)" target="_blank" rel="noopener noreferrer">t</a>', 'balanced parens in dest');
assert.equal(renderInline('[**t**](mailto:a@b.c)'), '<a href="mailto:a@b.c" target="_blank" rel="noopener noreferrer"><strong>t</strong></a>');
assert.equal(renderInline('[t](javascript:alert(1))'), 't', 'javascript: is not linked');
assert.equal(renderInline('[t](data:text/html,x)'), 't', 'data: is not linked');
assert.equal(renderInline('[t](page.html)'), 't', 'a relative path has no base here');
assert.equal(renderInline('[t](vbscript:x)'), 't');
assert.equal(renderInline('[a [b] c](https://x.y)'), '<a href="https://x.y" target="_blank" rel="noopener noreferrer">a [b] c</a>', 'nested brackets');
assert.equal(renderInline('[x] not a link'), '[x] not a link');
assert.equal(renderInline('see [1]'), 'see [1]');
assert.equal(renderInline('<https://x.y>'), '<a href="https://x.y" target="_blank" rel="noopener noreferrer">https://x.y</a>', 'autolink');
assert.equal(renderInline('see https://x.y/z. Then'),
  'see <a href="https://x.y/z" target="_blank" rel="noopener noreferrer">https://x.y/z</a>. Then', 'bare URL, trailing dot excluded');
assert.equal(renderInline('(https://x.y)'),
  '(<a href="https://x.y" target="_blank" rel="noopener noreferrer">https://x.y</a>)', 'bare URL in parens');
assert.equal(renderInline('**https://x.y**'),
  '<strong><a href="https://x.y" target="_blank" rel="noopener noreferrer">https://x.y</a></strong>');
assert.equal(renderInline('https://x.y/?a=1&b=2'),
  '<a href="https://x.y/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">https://x.y/?a=1&amp;b=2</a>', 'ampersand escaped in href');

// Images become links (the CSP forbids remote images; the panel must not fetch them).
assert.equal(renderInline('![shot](https://x.y/a.png)'),
  '<a class="adm-md-img" href="https://x.y/a.png" target="_blank" rel="noopener noreferrer">shot</a>');
assert.equal(renderInline('![](https://x.y/a.png)'),
  '<a class="adm-md-img" href="https://x.y/a.png" target="_blank" rel="noopener noreferrer">https://x.y/a.png</a>');
assert.equal(renderInline('![alt](javascript:x)'), 'alt');
assert.ok(!renderInline('![a](https://x.y/a.png)').includes('<img'), 'never an <img>');

// ── 3. innerHTML safety ──────────────────────────────────────────────────────

assert.equal(md('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
assert.equal(md('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
assert.equal(md('a <b onclick="x">b</b>'), '<p>a &lt;b onclick=&quot;x&quot;&gt;b&lt;/b&gt;</p>');
assert.equal(md('a<br>b<br/>c<BR />d'), '<p>a<br>b<br>c<br>d</p>', 'br passes, normalised');
assert.equal(md('<kbd>Ctrl</kbd> H<sub>2</sub>O x<sup>2</sup>'), '<p><kbd>Ctrl</kbd> H<sub>2</sub>O x<sup>2</sup></p>');
assert.equal(md('<kbd onclick="x">k</kbd>'), '<p>&lt;kbd onclick=&quot;x&quot;&gt;k</kbd></p>', 'an attribute disqualifies the tag');
assert.equal(md('<a href="https://x.y">t</a>'), '<p>&lt;a href=&quot;https://x.y&quot;&gt;t&lt;/a&gt;</p>', 'raw anchors are text');
{
  // A quote in the destination breaks the link syntax; the bare URL is then
  // autolinked and the smuggled attribute is escaped text, never markup.
  const html = md('[t](https://x.y" onmouseover="alert(1))');
  assert.equal(html, '<p>[t](<a href="https://x.y" target="_blank" rel="noopener noreferrer">https://x.y</a>&quot; onmouseover=&quot;alert(1))</p>');
  assert.ok(!/<[^>]*onmouseover/.test(html), 'no tag carries the smuggled attribute');
}
assert.equal(renderInline('[t](https://x.y/"onmouseover="alert(1)")'),
  '<a href="https://x.y/&quot;onmouseover=&quot;alert(1)&quot;" target="_blank" rel="noopener noreferrer">t</a>', 'quotes in href are escaped');
assert.equal(md('## <b>x</b>'), '<h4 class="adm-md-h adm-md-h2">&lt;b&gt;x&lt;/b&gt;</h4>');
assert.equal(md('| <i>x</i> |\n|--|\n| <u>y</u> |'),
  '<div class="adm-md-table-wrap"><table class="adm-md-table"><thead><tr><th>&lt;i&gt;x&lt;/i&gt;</th></tr></thead><tbody><tr><td>&lt;u&gt;y&lt;/u&gt;</td></tr></tbody></table></div>');
assert.equal(md('## [<b>]'), '<h4 class="adm-md-h adm-md-h2">[&lt;b&gt;]</h4>', 'a tag with markup is not a badge');
assert.equal(md('\u0000\u00000\u0000'), '<p>\uFFFD\uFFFD0\uFFFD</p>', 'NUL cannot forge a placeholder');
assert.equal(md('a\r\nb\r\n\r\nc'), '<p>a b</p><p>c</p>', 'CRLF normalised');
assert.equal(md(''), '');
assert.equal(md(null), '');
assert.equal(md('   \n\t\n'), '');
assert.equal(md(12), '<p>12</p>');
assert.equal(escapeHtml('<&>"\''), '&lt;&amp;&gt;&quot;&#39;');
assert.equal(md('x'.repeat(70 * 1024)).length, 64 * 1024 + 7, 'input capped at 64 KiB');

// Adversarial emphasis input finishes promptly (lazy scans are linear per opener).
{
  const t0 = Date.now();
  md(('**a ' + '*b '.repeat(200) + '\n').repeat(60));
  md('_'.repeat(20000));
  md('['.repeat(5000) + ']('.repeat(5000));
  assert.ok(Date.now() - t0 < 2000, `adversarial input took ${Date.now() - t0} ms`);
}

// ── 4. every changelog ever shipped renders, balanced, with badges ───────────
{
  const files = ['changelog', 'changelog/archive'].flatMap((d) =>
    readdirSync(path.join(ROOT, d)).filter((f) => /^changelog_\d+\.\d+\.\d+\.md$/.test(f)).map((f) => path.join(d, f)));
  assert.ok(files.length > 100, `found ${files.length} changelogs`);
  const count = (h, re) => (h.match(re) || []).length;
  // The property the renderer promises: every emitted tag is one it knows, every
  // attribute is from its allowlist and quoted, every href is http(s)/mailto.
  const TAGS = new Set(['h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody',
    'tr', 'th', 'td', 'strong', 'em', 'del', 'a', 'br', 'hr', 'span', 'div', 'kbd', 'sub', 'sup']);
  const ATTRS = new Set(['href', 'title', 'target', 'rel', 'class', 'start', 'aria-hidden']);
  const checkTags = (html, f) => {
    for (const m of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)) {
      const [, tag, rest] = m;
      assert.ok(TAGS.has(tag.toLowerCase()), `${f}: unexpected tag <${tag}>`);
      let left = rest;
      for (const a of rest.matchAll(/\s+([a-zA-Z-]+)="([^"]*)"/g)) {
        assert.ok(ATTRS.has(a[1].toLowerCase()), `${f}: unexpected attribute ${a[1]} on <${tag}>`);
        if (a[1] === 'href') assert.ok(/^(https?:\/\/|mailto:)/i.test(a[2]), `${f}: unsafe href ${a[2]}`);
        left = left.replace(a[0], '');
      }
      assert.equal(left.trim(), '', `${f}: unquoted attribute in <${tag}${rest}>`);
    }
  };
  checkTags(md('[t](https://x.y/"onmouseover="alert(1)") <img src=x onerror=y> ![i](https://x.y/a.png)'), 'xss sample');
  let badges = 0;
  for (const f of files) {
    const src = read(f);
    const html = md(src, { dropLeadingH1: true });
    assert.ok(html.length > 0, `${f}: empty output`);
    checkTags(html, f);
    assert.ok(!html.includes('\u0000'), `${f}: unresolved placeholder`);
    for (const tag of ['ul', 'ol', 'li', 'p', 'blockquote', 'pre', 'code', 'table', 'strong', 'em', 'a', 'h3', 'h4', 'h5', 'h6']) {
      assert.equal(count(html, new RegExp(`<${tag}[\\s>]`, 'g')), count(html, new RegExp(`</${tag}>`, 'g')), `${f}: <${tag}> balanced`);
    }
    // `## [ADDED]` today, `### [ADDED]` in the 0.11 archive: a badge at any level.
    const sections = count(src, /^#{1,6} +\[[A-Za-z][A-Za-z0-9 _-]*\]/gm);
    assert.equal(count(html, /adm-md-badge-/g), sections, `${f}: every [TAG] heading became a badge`);
    badges += sections;
  }
  assert.ok(badges > 300, `${badges} section badges across the changelogs`);

  // The newest changelog, rendered the way the tab renders it, opens on its
  // first section (the document title is dropped) and its bullets are <li>.
  const newest = files.filter((f) => !f.includes('archive')).sort((a, b) => {
    const v = (s) => /(\d+)\.(\d+)\.(\d+)/.exec(s).slice(1).map(Number);
    const [x, y] = [v(a), v(b)];
    return (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]);
  }).pop();
  const html = md(read(newest), { dropLeadingH1: true });
  assert.ok(html.startsWith('<h4 class="adm-md-h adm-md-h2 adm-md-sec"><span class="adm-md-badge'), `${newest}: starts on a section badge`);
  assert.ok(/<ul class="adm-md-list"><li>(?:<p>)?<strong>/.test(html), `${newest}: bullets with a bold lead`);
}

// ── 5. the tab uses it ───────────────────────────────────────────────────────
{
  const s = read('js/pages/admin/tab-updates.js');
  assert.ok(/import \{[^}]*\brenderMarkdown\b[^}]*\} from '\.\/markdown\.js'/.test(s), 'tab-updates imports renderMarkdown');
  assert.ok(/renderMarkdown\(_check\.notes,\s*\{[^}]*dropLeadingH1:\s*true/.test(s), 'notes rendered via renderMarkdown (document title dropped)');
  assert.ok(!/<pre class="adm-release-notes">\$\{escHtml\(_check\.notes\)\}/.test(s), 'the plain-text <pre> is gone');
  assert.ok(!/\$\{_check\.notes\}/.test(s), 'notes never interpolated raw');
  const css = read('css/admin-shell.css');
  for (const cls of ['.adm-md-badge-added', '.adm-md-badge-optimized', '.adm-md-badge-fixed', '.adm-md-quote', '.adm-md-table', '.adm-md-pre', '.adm-release-notes.is-open']) {
    assert.ok(css.includes(cls), `admin-shell.css styles ${cls}`);
  }
}

console.log('admin markdown renderer: OK');
