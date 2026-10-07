// Screenshot helpers: numbered red callouts drawn over the page before the capture.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
export const { chromium } = require('/opt/node22/lib/node_modules/playwright');

export const BASE = 'http://localhost:8080';
export const OUT = process.env.SHOT_OUT || '/tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad/shots';

export async function launch() {
  return chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
}

export async function newPage(browser, { width = 1600, height = 950, scale = 1, lang = 'fr', theme = 'dark', admTheme = 'dark', storage = {} } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
  await ctx.addInitScript(([lang, theme, admTheme, storage]) => {
    try {
      localStorage.setItem('iribhm-lang', lang);
      localStorage.setItem('iribhm-theme', theme);
      localStorage.setItem('adm-theme', admTheme);
      for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
    } catch (_) {}
  }, [lang, theme, admTheme, storage]);
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 200)));
  return page;
}

// targets: [{ sel | box:{x,y,width,height}, n, label, side:'left'|'right'|'top'|'bottom'|'inside', pad, nth }]
export async function annotate(page, targets) {
  const boxes = [];
  for (const t of targets) {
    let box = t.box;
    if (!box && t.sel) {
      const loc = page.locator(t.sel).nth(t.nth || 0);
      try { box = await loc.boundingBox({ timeout: 3000 }); } catch (_) { box = null; }
    }
    if (!box) { console.log('  [annotate] missing target', t.sel || '', t.n); continue; }
    boxes.push({ ...t, box });
  }
  await page.evaluate((items) => {
    const layer = document.createElement('div');
    layer.id = '__callouts';
    layer.setAttribute('style', 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;');
    document.body.appendChild(layer);
    const RED = '#e03131';
    for (const it of items) {
      const p = it.pad ?? 4;
      const b = it.box;
      if (!it.noBox) {
        const r = document.createElement('div');
        r.setAttribute('style', `position:fixed;left:${b.x - p}px;top:${b.y - p}px;width:${b.width + 2 * p}px;height:${b.height + 2 * p}px;` +
          `border:2.5px solid ${RED};border-radius:7px;box-shadow:0 0 0 2px rgba(255,255,255,.55);`);
        layer.appendChild(r);
      }
      const pill = document.createElement('div');
      const hasLabel = !!it.label;
      pill.innerHTML = `<span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:#fff;color:${RED};font-weight:800;font-size:13px;">${it.n}</span>` +
        (hasLabel ? `<span style="margin:0 8px 0 7px;">${it.label}</span>` : '');
      pill.setAttribute('style', `position:fixed;display:inline-flex;align-items:center;background:${RED};color:#fff;` +
        `font:600 13px Inter,sans-serif;border-radius:20px;padding:3px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.35);`);
      layer.appendChild(pill);
      const pw = pill.offsetWidth, ph = pill.offsetHeight;
      const side = it.side || 'left';
      let x, y;
      const cy = b.y + b.height / 2 - ph / 2, cx = b.x + b.width / 2 - pw / 2;
      if (side === 'left') { x = b.x - p - pw - 8; y = cy; }
      else if (side === 'right') { x = b.x + b.width + p + 8; y = cy; }
      else if (side === 'top') { x = cx; y = b.y - p - ph - 6; }
      else if (side === 'bottom') { x = cx; y = b.y + b.height + p + 6; }
      else if (side === 'tl') { x = b.x - p - pw / 2; y = b.y - p - ph / 2; }
      else if (side === 'tr') { x = b.x + b.width + p - pw / 2; y = b.y - p - ph / 2; }
      else { x = cx; y = cy; }
      if (it.dx) x += it.dx; if (it.dy) y += it.dy;
      x = Math.max(4, Math.min(window.innerWidth - pw - 4, x));
      y = Math.max(4, Math.min(window.innerHeight - ph - 4, y));
      pill.style.left = x + 'px'; pill.style.top = y + 'px';
    }
  }, boxes);
}

export async function clearCallouts(page) {
  await page.evaluate(() => document.getElementById('__callouts')?.remove());
}

export async function shot(page, name, { clip, targets, fullPage } = {}) {
  if (targets) await annotate(page, targets);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip, fullPage });
  if (targets) await clearCallouts(page);
  console.log('  shot', name);
}

export async function elShot(page, sel, name, { targets, margin = 0 } = {}) {
  const box = await page.locator(sel).first().boundingBox();
  if (!box) { console.log('  [elShot] missing', sel); return; }
  const vp = page.viewportSize();
  const clip = { x: Math.max(0, box.x - margin), y: Math.max(0, box.y - margin), width: Math.min(vp.width, box.width + 2 * margin), height: Math.min(vp.height - Math.max(0, box.y - margin), box.height + 2 * margin) };
  await shot(page, name, { clip, targets });
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
