// Structural tests for the HTML/CSS-injection escaping batch. These files build
// innerHTML from catalog/dataset/user data and touch the DOM at load (not
// vm-loadable), so we assert the dangerous interpolations are now routed through
// the shared Utils.escapeHtml helper and the raw forms are gone.
//   SEC-014 compare.js _bindModal (id/thumbnail/name/type)
//   SEC-015 landing.js createDatasetCard (thumbnail/name/description)
//   SEC-018 measure-distance item.color in inline style
//   SEC-019 channel-panel channel.color in inline style
//   SEC-021 tracking.js colormap menu name/stops + inline onmouseover/onmouseout
//
// Run: node tests/js/test_html_escaping.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// ── SEC-014 compare.js ──
{
  const s = read('js/pages/compare.js');
  for (const f of ['d.id', 'd.thumbnail', 'd.name']) {
    assert.ok(s.includes(`Utils.escapeHtml(${f})`), `SEC-014: ${f} escaped in _bindModal`);
  }
  assert.ok(s.includes('Utils.escapeHtml(String(d.type).toUpperCase())'), 'SEC-014: d.type escaped');
  assert.ok(!/src="\$\{d\.thumbnail\}"/.test(s), 'SEC-014: raw d.thumbnail src removed');
  assert.ok(!/>\$\{d\.name\}</.test(s), 'SEC-014: raw d.name removed');
}

// ── SEC-015 landing.js ──
{
  const s = read('js/pages/landing.js');
  for (const f of ['dataset.thumbnail', 'dataset.name']) {
    assert.ok(s.includes(`Utils.escapeHtml(${f})`), `SEC-015: ${f} escaped`);
  }
  assert.ok(/Utils\.escapeHtml\(dataset\.description/.test(s), 'SEC-015: description escaped');
  assert.ok(!/\$\{dataset\.name\}/.test(s), 'SEC-015: raw dataset.name removed');
  assert.ok(!/src="\$\{dataset\.thumbnail\}"/.test(s), 'SEC-015: raw thumbnail src removed');
}

// ── SEC-018 measure-distance ──
{
  const s = read('js/modules/tools/measure-distance/index.js');
  assert.ok(s.includes('${esc(item.color)}'), 'SEC-018: item.color escaped in inline style');
  assert.ok(!/background:\$\{item\.color\}/.test(s), 'SEC-018: raw item.color removed');
}

// ── SEC-019 channel-panel ──
{
  const s = read('js/components/channel-panel.js');
  assert.ok(/const safeColor = Utils\.escapeHtml/.test(s), 'SEC-019: safeColor computed via escapeHtml');
  assert.ok(!/background:\$\{channel\.color\}/.test(s), 'SEC-019: raw channel.color removed from inline styles');
  assert.ok((s.match(/\$\{safeColor\}/g) || []).length >= 2, 'SEC-019: both swatches use safeColor');
}

// ── SEC-021 tracking.js + viewer.css ──
{
  const s = read('js/pages/tracking.js');
  assert.ok(s.includes('Utils.escapeHtml(n)'), 'SEC-021: colormap name escaped');
  assert.ok(s.includes('Utils.escapeHtml(c)'), 'SEC-021: colormap stop color escaped');
  const menu = s.slice(s.indexOf('colormap-option'), s.indexOf('colormap-option') + 600);
  assert.ok(!/onmouseover=/.test(menu) && !/onmouseout=/.test(menu), 'SEC-021: inline onmouseover/onmouseout removed from colormap option');
  assert.ok(/colormap-option\$\{isSel \? ' selected'/.test(s), 'SEC-021: selection via CSS .selected class');

  const css = read('css/viewer.css');
  assert.ok(/\.colormap-option:hover/.test(css), 'SEC-021: hover handled in CSS');
  assert.ok(/\.colormap-option\.selected/.test(css), 'SEC-021: selected state in CSS');
}

console.log('HTML/CSS escaping (SEC-014/015/018/019/021): OK');
