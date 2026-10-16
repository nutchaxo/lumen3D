// Page import / export (js/pages/admin/pages-transfer.js + pages-transfer-ui.js).
// Locks:
//   1. the media references the export carries and the import renames (relative
//      config/uploads/ URLs in values, CSS url() and HTML — never an absolute URL);
//   2. a stored page document → bundle entry (draft only when it differs, menu row
//      for custom pages only) → parseBundle round trip, and every refusal code;
//   3. the import plan (targets, replaced / new / built-in, duplicates), the media
//      and variable plans, the write sequence of a page;
//   4. runImport end to end against an in-memory twin of api/site.php + api/media.php:
//      published / draft, media dedup and rename, variables kept, menu rows;
//   5. locale parity of pages.xfer.* and that every key the dialogs use exists;
//   6. the page bundles shipped under DOCS/ parse and only use widget types the
//      renderer and the editor palette know.
//
// Run: node tests/js/test_pages_transfer.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA, collectMediaRefs, renameMediaRefs, collectTokens, pageEntry, usedVariables, buildBundle,
  parseBundle, planImport, planMedia, planVariables, pageWrites, checkContent, isEmptyDoc,
  slugFromFileName, bundleFileName, widgetCount, pageLocales, magicType, base64Bytes,
} from '../../js/pages/admin/pages-transfer.js';
import { runImport } from '../../js/pages/admin/pages-transfer-ui.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// Smallest valid images (magic bytes are what the server and the parser check).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PNG2 = Buffer.from(PNG); PNG2[PNG2.length - 5] ^= 0xff;   // same header, other bytes
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8L'), Buffer.alloc(14, 1)]);
const b64 = (buf) => buf.toString('base64');

const widget = (type, extra) => Object.assign({ id: 'w' + Math.random().toString(36).slice(2, 9), type, props: {} }, extra || {});
const section = (...widgets) => ({ id: 's1', props: { padY: 48 }, columns: [{ id: 'c1', width: 12, props: {}, widgets }] });

// ── 1. media references ─────────────────────────────────────────────────────
{
  const content = {
    sections: [section(
      widget('image', { props: { src: 'config/uploads/a.webp', alt: { en: 'config/uploads is where images live' } } }),
      widget('gallery', { props: { images: [{ src: './config/uploads/b.png' }, { src: '/config/uploads/c.jpg' }] } }),
      widget('html', { props: { html: { en: '<img src="config/uploads/d-1.gif"> and <a href="https://other.host/config/uploads/far.png">x</a>' } } }),
      widget('hero', { props: { bg: "url('config/uploads/e_bg.avif') center/cover", subtitle: { fr: 'myconfig/uploads/no.png config/uploads/x.svg' } } }),
    )],
  };
  content.sections[0].props.bg = 'url(config/uploads/a.webp)';
  assert.deepEqual(collectMediaRefs(content).sort(), ['a.webp', 'b.png', 'c.jpg', 'd-1.gif', 'e_bg.avif'],
    'relative refs in values, url() and HTML; never an absolute URL, an svg or a longer path');
  const renamed = renameMediaRefs(content, { 'a.webp': 'a-1.webp', 'c.jpg': 'c-2.jpg' });
  const json = JSON.stringify(renamed);
  assert.ok(json.includes('"config/uploads/a-1.webp"') && json.includes('url(config/uploads/a-1.webp)'), 'every reference to a renamed file follows');
  assert.ok(json.includes('"/config/uploads/c-2.jpg"'), 'the rooted form keeps its root');
  assert.ok(json.includes('./config/uploads/b.png') && json.includes('https://other.host/config/uploads/far.png'), 'others untouched');
  assert.equal(JSON.stringify(content).includes('a-1.webp'), false, 'renameMediaRefs does not mutate its input');
  assert.deepEqual(collectTokens({ a: 'Hi {brand}, {year} {not a token} {x_1}', b: ['{x_1}'] }).sort(), ['brand', 'x_1', 'year']);
}

// ── 2. stored doc → entry → bundle → parse ──────────────────────────────────
{
  const pub = { sections: [section(widget('heading', { text: { en: 'Hello {lab}', fr: 'Bonjour {lab}' } }), widget('image', { props: { src: 'config/uploads/logo.png' } }))], background: { preset: 'stars', params: [] } };
  const home = pageEntry('home', { title: [], published: pub, draft: JSON.parse(JSON.stringify(pub)), schemaVersion: 2 });
  assert.equal(home.draft, undefined, 'a draft equal to the published version is not exported');
  assert.equal(home.nav, undefined, 'built-in pages carry no menu row');
  assert.deepEqual(home.title, {}, "PHP's empty-array title becomes {}");
  assert.deepEqual(home.published.background, { preset: 'stars', params: {} }, 'background kept, PHP [] params normalised');

  const draft = { sections: [section(widget('heading', { text: { en: 'Draft' } }))] };
  const team = pageEntry('team', { title: { en: 'Team' }, published: { sections: [] }, draft }, { slug: 'team', label: { en: 'Our team', fr: 'Équipe' }, show: false });
  assert.deepEqual(team.draft, draft, 'a different draft travels');
  assert.deepEqual(team.nav, { label: { en: 'Our team', fr: 'Équipe' }, show: false });
  assert.equal(isEmptyDoc({ title: [], published: { sections: [] } }), true);
  assert.equal(isEmptyDoc({ published: { sections: [], background: { preset: 'drift' } } }), false);
  assert.equal(isEmptyDoc(team), false);

  const vars = usedVariables([home, team], { lab: { en: 'IRIBHM', fr: 'IRIBHM' }, unused: 'x', bad: 42 });
  assert.deepEqual(vars, { lab: { en: 'IRIBHM', fr: 'IRIBHM' } }, 'only the variables the pages use');

  const bundle = buildBundle({ pages: [home, team], media: [{ name: 'logo.png', data: b64(PNG) }], variables: vars, platform: '1.61.0', source: 'Bemine.ULB.be', now: new Date('2026-10-09T10:00:00Z') });
  assert.equal(bundle.$schema, SCHEMA);
  assert.equal(bundle.media[0].type, 'image/png');
  assert.equal(bundleFileName(bundle, 'Bemine.ULB.be'), 'bemine.ulb.be-pages-2026-10-09.lumen-pages.json');
  assert.equal(bundleFileName(Object.assign({}, bundle, { pages: [home] }), ''), 'site-home-2026-10-09.lumen-pages.json');

  const parsed = parseBundle(JSON.stringify(bundle, null, 2), 'x.lumen-pages.json');
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  assert.equal(parsed.raw, false);
  assert.deepEqual(parsed.bundle.pages, [home, team], 'pages round-trip');
  assert.equal(parsed.bundle.media[0].size, PNG.length, 'decoded media size');
  assert.deepEqual(parsed.bundle.variables, vars);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(widgetCount(home.published), 2);
  assert.deepEqual(pageLocales(home), ['en', 'fr']);
}

// Refusals — nothing is written for any of them.
{
  const ok = { $schema: SCHEMA, pages: [{ slug: 'home', published: { sections: [section(widget('heading'))] } }] };
  const codes = (obj, name) => { const r = parseBundle(typeof obj === 'string' ? obj : JSON.stringify(obj), name); return r.ok ? [] : r.errors.map((e) => e.code); };
  assert.deepEqual(codes(ok), []);
  assert.deepEqual(codes('{not json'), ['json']);
  assert.deepEqual(codes(''), ['json']);
  assert.deepEqual(codes({ hello: 1 }), ['schema']);
  assert.deepEqual(codes(Object.assign({}, ok, { $schema: 'lumen-pages/2' })), ['version'], 'a newer format is named, not mangled');
  assert.deepEqual(codes(Object.assign({}, ok, { pages: [] })), ['pages']);
  assert.deepEqual(codes({ $schema: SCHEMA, pages: [{ slug: '../x', published: { sections: [] } }] }), ['slug']);
  assert.deepEqual(codes({ $schema: SCHEMA, pages: [{ slug: 'Home', published: { sections: [] } }] }), ['slug'], 'slugs are lower-case');
  assert.deepEqual(codes({ $schema: SCHEMA, pages: [ok.pages[0], ok.pages[0]] }), ['duplicate']);
  assert.deepEqual(codes({ $schema: SCHEMA, pages: [{ slug: 'a' }] }), ['content'], 'a page needs published or draft');
  assert.deepEqual(codes({ $schema: SCHEMA, pages: [{ slug: 'a', published: { sections: [{ columns: [{ widgets: [{ props: {} }] }] }] } }] }), ['content'], 'a widget without a type');
  assert.deepEqual(codes({ $schema: SCHEMA, pages: [{ slug: 'a', published: { sections: [{ columns: new Array(13).fill({}) }] } }] }), ['content'], '> 12 columns, as the server');
  const huge = { $schema: SCHEMA, pages: [{ slug: 'a', published: { sections: [section(widget('richtext', { text: { en: 'x'.repeat(2100000) } }))] } }] };
  assert.deepEqual(codes(huge), ['size'], 'over the 2 MiB page limit of site_validate_page');
  assert.deepEqual(codes(Object.assign({}, ok, { media: [{ name: 'evil.svg', data: b64(PNG) }] })), ['media']);
  assert.deepEqual(codes(Object.assign({}, ok, { media: [{ name: 'fake.png', data: Buffer.from('<?php echo 1; ?>......').toString('base64') }] })), ['media'], 'magic bytes, not the name');
  assert.deepEqual(codes(Object.assign({}, ok, { media: [{ name: 'big.png', data: 'A'.repeat(11200000) }] })), ['media'], 'over 8 MB decoded');
  assert.deepEqual(codes(Object.assign({}, ok, { media: [{ name: 'a.png', data: b64(PNG) }, { name: 'a.png', data: b64(PNG) }] })), ['media']);
  assert.deepEqual(codes(Object.assign({}, ok, { variables: { 'bad name': 'x' } })), ['variables']);
  assert.deepEqual(codes(Object.assign({}, ok, { variables: { n: 3 } })), ['variables']);
  const missing = parseBundle(JSON.stringify({ $schema: SCHEMA, pages: [{ slug: 'a', published: { sections: [section(widget('image', { props: { src: 'config/uploads/gone.png' } }))] } }] }));
  assert.equal(missing.ok, true);
  assert.deepEqual(missing.warnings, [{ code: 'mediaMissing', detail: 'gone.png' }], 'a reference the file does not carry is announced');
  assert.equal(magicType([...WEBP.subarray(0, 12)]), 'webp');
  assert.equal(base64Bytes(b64(PNG)), PNG.length);
}

// A raw page document as a host serves config/pages/<slug>.json.
{
  const raw = { title: [], published: { sections: [section(widget('hero'))] }, schemaVersion: 2 };
  const r = parseBundle(JSON.stringify(raw), 'C:\\Downloads\\about.json');
  assert.equal(r.ok, true);
  assert.equal(r.raw, true);
  assert.equal(r.bundle.pages[0].slug, 'about');
  const anon = parseBundle(JSON.stringify(raw), 'Copie de la page (1).json');
  assert.equal(anon.ok, true);
  assert.equal(anon.bundle.pages[0].slug, 'copie-de-la-page-1');
  assert.equal(slugFromFileName('___.json'), '', 'no usable slug: the operator types one');
  assert.equal(parseBundle(JSON.stringify(raw), '___.json').ok, true);
}

// ── 3. plans ────────────────────────────────────────────────────────────────
{
  const bundle = { pages: [{ slug: 'home' }, { slug: 'team' }, { slug: 'news' }, { slug: '' }], media: [], variables: {} };
  const rows = planImport(bundle, ['team']);
  assert.deepEqual(rows.map((r) => [r.target, r.builtin, r.exists, r.error]), [
    ['home', true, true, null], ['team', false, true, null], ['news', false, false, null], ['', false, false, 'slug']]);
  const re = planImport(bundle, ['team'], ['home', 'news', 'news', 'Contact ']);
  assert.deepEqual(re.map((r) => [r.target, r.error]), [['home', null], ['news', 'duplicate'], ['news', 'duplicate'], ['contact', null]], 'targets are trimmed, lower-cased, deduplicated');

  const mp = planMedia({ media: [{ name: 'a.png' }, { name: 'b.png' }, { name: 'c.png' }] }, new Map([['a.png', { sameBytes: true }], ['b.png', { sameBytes: false }]]));
  assert.deepEqual(mp.reuse, ['a.png']);
  assert.deepEqual(mp.upload.map((m) => m.name), ['b.png', 'c.png'], 'same name, other bytes: uploaded (the server picks another name)');

  const vp = planVariables({ variables: { a: 'x', b: { en: 'y' }, c: 'z' } }, { b: { en: 'y' }, c: 'other' });
  assert.deepEqual(vp.add, { a: 'x' });
  assert.deepEqual(vp.conflicts, ['c'], 'an operator value is never overwritten');

  const P = { sections: [] }, D = { sections: [section(widget('spacer'))] };
  assert.deepEqual(pageWrites({ title: { en: 'T' }, published: P, draft: D }, { publish: true }).map((s) => s.action), ['save_draft', 'publish', 'save_draft'],
    'publish the published version, then put the different draft back');
  assert.deepEqual(pageWrites({ title: { en: 'T' }, published: P, draft: D }, { publish: true })[0].body, { draft: P, title: { en: 'T' } });
  assert.deepEqual(pageWrites({ title: {}, published: P, draft: null }, { publish: false }), [{ action: 'save_draft', body: { draft: P } }], 'no empty title written');
  assert.deepEqual(pageWrites({ title: {}, published: P, draft: D }, { publish: false })[0].body.draft, D, 'draft mode keeps the draft');
  assert.equal(checkContent({ sections: [] }), null);
  assert.equal(checkContent({ blocks: [{ type: 'heading' }] }), null, 'legacy flat pages pass');
}

// ── 4. runImport against an in-memory twin of the endpoints ─────────────────
function fakeServer(seed) {
  const pages = new Map(Object.entries(seed.pages || {}));   // slug → { public, draft }
  const media = new Map(Object.entries(seed.media || {}));   // name → Buffer
  let instance = JSON.parse(JSON.stringify(seed.instance || {}));
  const log = [];
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url, 'http://host/');
    const body = init.body ? JSON.parse(init.body) : null;
    const action = u.searchParams.get('action');
    const doc = u.searchParams.get('doc') || '';
    if (u.pathname.startsWith('/config/uploads/')) {
      const f = media.get(decodeURIComponent(u.pathname.slice('/config/uploads/'.length)));
      return f ? new Response(f, { status: 200, headers: { 'Content-Type': 'image/png' } }) : new Response('', { status: 404 });
    }
    log.push(`${action} ${doc || (body && body.filename) || ''}`.trim());
    if (u.pathname === '/api/media.php') {
      if (action === 'list') return json({ files: [...media.keys()].map((name) => ({ name, url: 'config/uploads/' + name })) });
      if (action === 'upload') {
        const raw = Buffer.from(body.data, 'base64');
        const [stem, ext] = [body.filename.replace(/\.[^.]+$/, '').toLowerCase(), 'png'];
        let name = `${stem}.${ext}`, i = 1;
        while (media.has(name)) name = `${stem}-${i++}.${ext}`;
        media.set(name, raw);
        return json({ ok: true, url: 'config/uploads/' + name, name });
      }
    }
    if (u.pathname === '/api/site.php') {
      if (doc === 'instance' && action === 'get') return json(instance);
      if (doc === 'instance' && action === 'save') {
        for (const p of u.searchParams.get('merge').split(',')) {
          const segs = p.split('.');
          let src = body, node = instance;
          for (const s of segs) src = src == null ? undefined : src[s];
          for (const s of segs.slice(0, -1)) node = node[s] = node[s] || {};
          node[segs[segs.length - 1]] = src;
        }
        return json({ ok: true });
      }
      const slug = doc.slice('pages/'.length);
      const cur = pages.get(slug) || { public: null, draft: null };
      if (action === 'save_draft') {
        if (seed.failSlug === slug) return json({ error: 'write_failed' }, 500);
        if ('title' in body) cur.public = Object.assign({ published: { sections: [] } }, cur.public || {}, { title: body.title });
        cur.draft = body.draft;
        pages.set(slug, cur);
        return json({ ok: true, rev: 'r' });
      }
      if (action === 'publish') {
        cur.public = Object.assign({}, cur.public || {}, { published: cur.draft });
        pages.set(slug, cur);
        return json({ ok: true, rev: 'r' });
      }
    }
    return json({ error: 'unexpected ' + url }, 400);
  };
  return { pages, media, get instance() { return instance; }, log };
}

function ctxFor(server, local) {
  const taken = [];
  const ctx = {
    pages: () => [{ slug: 'home', builtin: true }, { slug: 'about', builtin: true }],
    instance: () => local,
    locale: () => 'fr',
    isBusy: () => false,
    normalizeContent: (b) => JSON.parse(JSON.stringify(b)),
    reconcileInstance: async () => { for (const k of Object.keys(server.instance)) if (k !== 'variables') local[k] = JSON.parse(JSON.stringify(server.instance[k])); },
    saveInstancePaths: async (paths) => {
      const r = await fetch(`api/site.php?action=save&doc=instance&merge=${paths.join(',')}`, { method: 'POST', body: JSON.stringify(local) });
      return r.ok;
    },
    takeOver: (slug) => taken.push(slug),
    afterImport: async () => {},
  };
  return { ctx, taken };
}

{
  const logoRef = { sections: [section(widget('image', { props: { src: 'config/uploads/logo.png' } }), widget('heading', { text: { en: '{lab} team, {other}' } }))] };
  const bundle = parseBundle(JSON.stringify({
    $schema: SCHEMA,
    pages: [
      { slug: 'about', title: {}, published: { sections: [section(widget('heading', { text: { en: 'About' } }))] } },
      { slug: 'team', title: { en: 'Team' }, nav: { label: { en: 'Our team' }, show: true }, published: logoRef, draft: { sections: [] } },
      { slug: 'news', title: { en: 'News' }, published: { sections: [section(widget('image', { props: { src: 'config/uploads/same.png' } }))] } },
    ],
    media: [{ name: 'logo.png', data: b64(PNG) }, { name: 'same.png', data: b64(PNG) }],
    variables: { lab: 'IRIBHM', other: 'kept' },
  })).bundle;

  // Publish: the library already has a DIFFERENT logo.png and the SAME same.png.
  const server = fakeServer({
    media: { 'logo.png': PNG2, 'same.png': PNG },
    instance: { brand: { name: 'B' }, variables: { other: 'mine' }, nav: { customPages: [{ slug: 'news', label: { en: 'News' }, show: false }] } },
  });
  const local = JSON.parse(JSON.stringify(server.instance));
  const { ctx, taken } = ctxFor(server, local);
  const plan = planImport(bundle, ['news']);
  const res = await runImport(ctx, bundle, plan, { publish: true, say: () => {} });
  assert.deepEqual(res.failed, []);
  assert.deepEqual(res.done, ['about', 'team', 'news']);
  assert.deepEqual(taken, ['about', 'team', 'news'], 'open editors are told to stop before any write');
  assert.ok(server.log.indexOf('upload logo.png') < server.log.indexOf('save_draft pages/about'), 'images first, so pages never point at a missing file');
  assert.equal(server.log.filter((l) => l.startsWith('upload')).length, 1, 'an identical file already in the library is reused');
  assert.ok(server.media.has('logo-1.png'), 'a different file under the same name gets the name the server picks');
  const team = server.pages.get('team');
  assert.equal(team.public.published.sections[0].columns[0].widgets[0].props.src, 'config/uploads/logo-1.png', 'the page follows the new name');
  assert.deepEqual(team.public.title, { en: 'Team' });
  assert.deepEqual(team.draft, { sections: [] }, 'the different draft of the file is put back after publishing');
  assert.equal(server.pages.get('about').public.published.sections[0].columns[0].widgets[0].text.en, 'About');
  assert.equal(server.pages.get('news').public.published.sections[0].columns[0].widgets[0].props.src, 'config/uploads/same.png');
  assert.deepEqual(server.instance.variables, { other: 'mine', lab: 'IRIBHM' }, 'absent variable added, operator value kept');
  assert.ok(res.notes.some((n) => n.includes('other')), 'the kept variable is reported');
  assert.deepEqual(server.instance.nav.customPages, [
    { slug: 'news', label: { en: 'News' }, show: true },
    { slug: 'team', label: { en: 'Our team' }, show: true },
  ], 'new custom page gets its menu row; a hidden one is revealed on publish, as the editor does');
  assert.deepEqual(server.instance.brand, { name: 'B' }, 'nothing else of instance.json is touched');
}

{
  // Draft mode: published versions untouched, new custom page hidden, a failing page reported.
  const bundle = parseBundle(JSON.stringify({ $schema: SCHEMA, pages: [
    { slug: 'home', published: { sections: [section(widget('hero'))] } },
    { slug: 'lab', title: { en: 'Lab' }, published: { sections: [section(widget('richtext'))] } },
    { slug: 'broken', published: { sections: [] } },
  ] })).bundle;
  const live = { title: [], published: { sections: [section(widget('heading', { text: { en: 'Live' } }))] } };
  const server = fakeServer({ pages: { home: { public: live, draft: null } }, instance: { nav: { customPages: [] } }, failSlug: 'broken' });
  const local = JSON.parse(JSON.stringify(server.instance));
  const { ctx } = ctxFor(server, local);
  const res = await runImport(ctx, bundle, planImport(bundle, []), { publish: false, say: () => {} });
  assert.deepEqual(res.done, ['home', 'lab']);
  assert.deepEqual(res.failed, ['broken']);
  assert.equal(server.pages.get('home').public, live, 'draft mode never touches what visitors see');
  assert.equal(server.pages.get('home').draft.sections[0].columns[0].widgets[0].type, 'hero');
  assert.equal(server.log.includes('publish pages/home'), false);
  assert.deepEqual(server.instance.nav.customPages, [{ slug: 'lab', label: { en: 'Lab' }, show: false }], 'hidden until published');
}

// ── 5. locales ──────────────────────────────────────────────────────────────
{
  const keysOf = (o, pre = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keysOf(v, `${pre}${k}.`) : [`${pre}${k}`]));
  const en = JSON.parse(read('lang/en.json')).pages.xfer;
  const enKeys = keysOf(en).sort();
  for (const code of ['fr', 'es', 'nl']) {
    assert.deepEqual(keysOf(JSON.parse(read(`lang/${code}.json`)).pages.xfer).sort(), enKeys, `pages.xfer parity in ${code}`);
  }
  const src = read('js/pages/admin/pages-transfer-ui.js') + read('js/pages/admin/tab-pages.js');
  for (const m of src.matchAll(/'pages\.xfer\.([A-Za-z_.]+)'/g)) assert.ok(enKeys.includes(m[1]), `missing en key pages.xfer.${m[1]}`);
  for (const slug of ['home', 'about']) assert.ok(enKeys.includes(`builtin_${slug}`));
  assert.match(read('js/pages/admin/tab-pages.js'), /openExportDialog\(_xferCtx\(\)\)/);
  assert.match(read('js/pages/admin/tab-pages.js'), /pickImportFile\(_xferCtx\(\)\)/);
}

// ── 6. shipped bundles use only known widgets ───────────────────────────────
{
  const renderer = read('js/core/page-renderer.js');
  const block = renderer.slice(renderer.indexOf('const RENDERERS'), renderer.indexOf('const WIDGET_TYPES'));
  const known = new Set([...block.matchAll(/^ {4}'?([a-z-]+)'?\(b\)/gm)].map((m) => m[1]));
  const palette = read('js/pages/admin/tab-pages.js');
  const dir = path.join(ROOT, 'DOCS', 'bemine-pages');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.lumen-pages.json')) : [];
  for (const f of files) {
    const r = parseBundle(readFileSync(path.join(dir, f), 'utf8'), f);
    assert.equal(r.ok, true, `${f}: ${JSON.stringify(r.errors)}`);
    for (const p of r.bundle.pages) {
      for (const b of [p.published, p.draft].filter(Boolean)) {
        for (const s of b.sections || []) for (const c of s.columns || []) for (const w of c.widgets || []) {
          assert.ok(known.has(w.type), `${f} ${p.slug}: unknown widget type ${w.type}`);
          assert.ok(palette.includes(`'${w.type}'`), `${f} ${p.slug}: ${w.type} is not in the editor`);
        }
      }
    }
  }
  assert.ok(known.size >= 20, `renderer types parsed (${known.size})`);
}

console.log('test_pages_transfer: OK');
