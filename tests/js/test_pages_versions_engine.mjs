// Page versions, the pure engine: js/pages/admin/pages-transfer.js (lumen-pages/2, file name,
// compatibility) + js/pages/admin/pages-versions.js (signatures, live state, import plan).
// Locks:
//   1. lumen-pages/1 keeps its exact bytes and its strictness (repeated slug = duplicate);
//   2. lumen-pages/2 round trips, per-entry fields are validated, versions of a slug are
//      ordered oldest first, one active entry per slug, newer formats are refused;
//   3. exportFileName (local date ddMMyyHHmm, host sanitisation) and semver;
//   4. checkCompatibility (blockers / warnings / per page);
//   5. contentSignature / describeLive / entries ↔ versions;
//   6. planVersionImport (defaults, targets, blocked rows, limits).
//
// Run: node tests/js/test_pages_versions_engine.mjs
import assert from 'node:assert/strict';
import {
  SCHEMA, SCHEMA_V2, SUPPORTED_SCHEMAS, buildBundle, parseBundle, pageEntry, exportFileName, fileHost,
  compareSemver, parseSemver, checkCompatibility,
} from '../../js/pages/admin/pages-transfer.js';
import {
  contentSignature, sameContent, entriesBySlug, planVersionImport, describeLive, versionToBundleEntry,
  pageEntryFromLive, pickActiveForSlug, pickActiveIndex, defaultImportLabel, MAX_VERSIONS,
} from '../../js/pages/admin/pages-versions.js';

const widget = (type, extra) => Object.assign({ id: 'w-' + type, type, props: {} }, extra || {});
const section = (...widgets) => ({ id: 's1', props: {}, columns: [{ id: 'c1', width: 12, props: {}, widgets }] });
const blockOf = (...widgets) => ({ sections: [section(...widgets)] });
const heading = (t) => widget('heading', { text: { en: t } });
const parse = (obj, name) => parseBundle(typeof obj === 'string' ? obj : JSON.stringify(obj), name);
const codes = (obj) => { const r = parse(obj); return r.ok ? [] : r.errors.map((e) => e.code); };

// ── 1. lumen-pages/1 is unchanged ───────────────────────────────────────────
{
  assert.equal(SCHEMA, 'lumen-pages/1');
  assert.equal(SCHEMA_V2, 'lumen-pages/2');
  assert.deepEqual([...SUPPORTED_SCHEMAS], [SCHEMA, SCHEMA_V2]);
  const now = new Date('2026-10-09T10:00:00Z');
  const home = pageEntry('home', { published: blockOf(heading('Hi')) });
  const about = pageEntry('about', { published: blockOf(heading('About')) });
  const b = buildBundle({ pages: [home, about], media: [], variables: {}, platform: '1.86.0', source: 'x.be', now });
  assert.equal(b.$schema, SCHEMA, 'distinct slugs: still written as /1 so older platforms read it');
  assert.equal(JSON.stringify(b), JSON.stringify({
    $schema: SCHEMA, exportedAt: '2026-10-09T10:00:00.000Z', platform: '1.86.0', source: 'x.be',
    pages: [home, about], media: [], variables: {},
  }), 'byte-identical to the previous writer');
  const back = parse(JSON.stringify(b));
  assert.equal(back.ok, true);
  assert.equal(back.bundle.$schema, SCHEMA);
  assert.deepEqual(back.bundle.pages, [home, about]);
  assert.deepEqual(codes({ $schema: SCHEMA, pages: [home, home] }), ['duplicate'], '/1 forbids a repeated slug');
  // The name, note, date and active flag are read in a /1 file too (an older platform ignores them): a single
  // version exported on its own is written /1 and must come back under its own name.
  const r1 = parse({ $schema: SCHEMA, pages: [Object.assign({}, home, { label: 'L', note: 'N', createdAt: '2026-01-01T00:00:00Z', active: true })] });
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.bundle.pages[0], Object.assign({}, home, { label: 'L', note: 'N', createdAt: '2026-01-01T00:00:00Z', active: true }));
  assert.deepEqual(codes({ $schema: SCHEMA, pages: [Object.assign({}, home, { active: true })] }), [], 'one active entry per slug is trivially true in /1');
  // ... and the round trip of one named version through its own export file.
  const one = versionToBundleEntry('about', { label: 'Spring redesign', note: 'my note', createdAt: '2026-03-01T10:00:00Z', content: { published: blockOf(heading('S')) } }, { active: true });
  const file = buildBundle({ pages: [one], platform: '1.87.0', source: 'x.be', now });
  assert.equal(file.$schema, SCHEMA, 'a lone version is a /1 file');
  const back1 = parse(JSON.stringify(file));
  assert.equal(back1.ok, true);
  assert.deepEqual([back1.bundle.pages[0].label, back1.bundle.pages[0].note, back1.bundle.pages[0].active], ['Spring redesign', 'my note', true]);
}

// ── 2. lumen-pages/2 ────────────────────────────────────────────────────────
{
  const v = (label, createdAt, text, extra) => Object.assign(pageEntry('about', { published: blockOf(heading(text)) }), { label, createdAt }, extra || {});
  const old = v('Old', '2026-01-01T10:00:00Z', 'one');
  const mid = v('Mid', '2026-06-01T10:00:00Z', 'two', { active: true, note: 'line1\nline2' });
  const neu = v('New', '2026-11-01T10:00:00Z', 'three');
  const b = buildBundle({ pages: [old, mid, neu], platform: '1.87.0', source: 'bemine.be', now: new Date('2026-11-19T10:00:00Z') });
  assert.equal(b.$schema, SCHEMA_V2, 'a repeated slug makes the file /2');
  const r = parse(JSON.stringify(b));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.bundle.$schema, SCHEMA_V2);
  assert.deepEqual(r.bundle.pages.map((p) => p.label), ['Old', 'Mid', 'New']);
  assert.equal(r.bundle.pages[1].active, true);
  assert.equal(r.bundle.pages[1].note, 'line1\nline2');
  assert.equal(r.bundle.pages[0].createdAt, '2026-01-01T10:00:00Z');
  assert.deepEqual(r.bundle.pages, [old, mid, neu], 'round trip');

  // Entries of a slug come back oldest first whatever the file order; slots of other slugs stay.
  const home = pageEntry('home', { published: blockOf(heading('H')) });
  const shuffled = parse({ $schema: SCHEMA_V2, pages: [neu, home, old, mid] });
  assert.deepEqual(shuffled.bundle.pages.map((p) => p.label || p.slug), ['Old', 'home', 'Mid', 'New'].map((x) => x));
  // Equal dates: file order. A slug with an undated entry keeps its file order entirely.
  const same = parse({ $schema: SCHEMA_V2, pages: [Object.assign({}, neu, { label: 'A' }), Object.assign({}, neu, { label: 'B' })] });
  assert.deepEqual(same.bundle.pages.map((p) => p.label), ['A', 'B']);
  const undated = parse({ $schema: SCHEMA_V2, pages: [neu, Object.assign({}, old, { createdAt: undefined })] });
  assert.deepEqual(undated.bundle.pages.map((p) => p.label), ['New', 'Old']);

  // Validation of the per-entry fields.
  const odd = parse({ $schema: SCHEMA_V2, pages: [Object.assign({}, old, { label: ' ' + 'x'.repeat(200) + '\u0007 ', note: 'n'.repeat(2500), createdAt: 'yesterday' })] });
  assert.equal(odd.ok, true);
  assert.equal(odd.bundle.pages[0].label.length, 120, 'label capped at 120');
  assert.equal(odd.bundle.pages[0].note.length, 2000, 'note capped at 2000');
  assert.equal('createdAt' in odd.bundle.pages[0], false, 'a createdAt that is not an ISO date is dropped');
  assert.equal(parse({ $schema: SCHEMA_V2, pages: [Object.assign({}, old, { label: 'a\u0000b\nc' })] }).bundle.pages[0].label, 'abc', 'control characters out of a label');
  assert.equal(parse({ $schema: SCHEMA_V2, pages: [Object.assign({}, old, { label: 42, note: {}, active: 'yes' })] }).bundle.pages[0].label, undefined);
  assert.equal('active' in parse({ $schema: SCHEMA_V2, pages: [Object.assign({}, old, { active: 'yes' })] }).bundle.pages[0], false, 'only true counts');
  assert.deepEqual(codes({ $schema: SCHEMA_V2, pages: [Object.assign({}, old, { active: true }), Object.assign({}, neu, { active: true })] }), ['active'], 'one active entry per slug');
  assert.deepEqual(codes({ $schema: SCHEMA_V2, pages: [Object.assign({}, old, { active: true }), Object.assign({}, home, { active: true })] }), [], 'one per slug, not one per file');
  assert.deepEqual(codes({ $schema: SCHEMA_V2, pages: [old] }), [], '/2 without a repeat is fine for a reader');
  assert.deepEqual(codes({ $schema: SCHEMA_V2, pages: [] }), ['pages']);
  assert.deepEqual(codes({ $schema: 'lumen-pages/3', pages: [old] }), ['version']);
  assert.deepEqual(codes({ $schema: 'lumen-pages/0', pages: [old] }), ['version']);
  assert.deepEqual(codes({ $schema: SCHEMA_V2, pages: [Object.assign({}, old, { slug: '../x' })] }), ['slug']);
  assert.deepEqual(codes({ $schema: SCHEMA_V2, pages: [Object.assign({}, old, { published: {}, draft: undefined })] }), ['content']);
  // More than the 200 pages of /1 is allowed for versions.
  const many = Array.from({ length: 300 }, (_, i) => Object.assign({}, old, { createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
  assert.deepEqual(codes({ $schema: SCHEMA_V2, pages: many }), []);
  assert.deepEqual(codes({ $schema: SCHEMA, pages: many.map((p, i) => Object.assign({}, p, { slug: 's' + i })) }), ['pages'], '/1 keeps its 200');

  // A raw page document still imports as /1 and keeps its page schemaVersion for the verifier.
  const raw = parse({ title: [], published: blockOf(widget('hero')), schemaVersion: 3 }, 'about.json');
  assert.equal(raw.ok, true);
  assert.equal(raw.raw, true);
  assert.equal(raw.bundle.$schema, SCHEMA);
  assert.equal(raw.bundle.pages[0].schemaVersion, 3);
}

// ── 3. file name + semver ───────────────────────────────────────────────────
{
  const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi);   // LOCAL time: the result must not depend on the zone
  assert.equal(exportFileName({ host: 'www.Bemine.be', slugs: ['about'], now: at(2026, 11, 19, 14, 45) }), 'bemine.be_about_1911261445.json');
  assert.equal(exportFileName({ host: 'bemine.be', slugs: ['home'], now: at(2026, 1, 2, 3, 4) }), 'bemine.be_home_0201260304.json', 'single digits are zero padded');
  assert.equal(exportFileName({ host: 'a.b', slugs: ['x'], now: at(2030, 12, 31, 0, 0) }), 'a.b_x_3112300000.json', 'midnight');
  assert.equal(exportFileName({ host: 'a.b', slugs: ['x'], now: at(2100, 2, 5, 23, 59) }), 'a.b_x_0502002359.json', 'two-digit year wraps');
  assert.equal(exportFileName({ host: 'localhost:8080', slugs: ['about'], now: at(2026, 11, 19, 14, 45) }), 'localhost_about_1911261445.json');
  assert.equal(fileHost('127.0.0.1:8080'), '127.0.0.1');
  assert.equal(fileHost('[::1]'), 'ipv6-1');
  assert.equal(fileHost('::1'), 'ipv6-1');
  assert.equal(fileHost('[2001:DB8::1]:8443'), 'ipv6-2001-db8-1');
  assert.equal(fileHost(''), 'site');
  assert.equal(fileHost(null), 'site');
  assert.equal(fileHost('www.'), 'site');
  assert.equal(fileHost('..'), 'site');
  assert.equal(fileHost('Bé mine/../x.be'), 'b-mine-..-x.be'.replace('..-', '..-'), 'exotic characters become "-"');
  assert.ok(/^[a-z0-9.-]+$/.test(fileHost('Bé mine/../x.be')));
  assert.equal(fileHost('a'.repeat(100)).length, 60);
  assert.equal(fileHost('www.www.x.be'), 'www.x.be', 'only one leading www.');
  // Several pages.
  const n = at(2026, 11, 19, 14, 45);
  assert.equal(exportFileName({ host: 'h.be', slugs: ['home', 'about'], now: n }), 'h.be_home+about_1911261445.json');
  assert.equal(exportFileName({ host: 'h.be', slugs: ['about', 'about', 'about'], now: n }), 'h.be_about_1911261445.json', 'one page with all its versions is still its slug');
  const longs = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc', 'dddddddddddd'];   // 12*4+3 = 51 > 40
  assert.equal(exportFileName({ host: 'h.be', slugs: longs, now: n }), 'h.be_4-pages_1911261445.json');
  assert.equal(exportFileName({ host: 'h.be', slugs: ['a'.repeat(40)], now: n }), `h.be_${'a'.repeat(40)}_1911261445.json`, 'a single long slug is never abbreviated');
  assert.equal(exportFileName({ host: 'h.be', slugs: [], now: n }), 'h.be_pages_1911261445.json');
  assert.equal(exportFileName({ host: 'h.be', slugs: ['../x'], now: n }), 'h.be_x_1911261445.json', 'a slug cannot carry a path');
  assert.match(exportFileName({ host: 'h.be', slugs: ['a'] }), /^h\.be_a_\d{10}\.json$/, 'now defaults to the current time');
  assert.match(exportFileName({ host: 'h.be', slugs: ['a'], now: new Date(NaN) }), /^h\.be_a_\d{10}\.json$/);
  assert.match(exportFileName(), /^site_pages_\d{10}\.json$/);

  assert.deepEqual(parseSemver('1.86.0'), [1, 86, 0]);
  assert.deepEqual(parseSemver('1.86'), [1, 86, 0]);
  assert.deepEqual(parseSemver('2'), [2, 0, 0]);
  assert.deepEqual(parseSemver('v1.86.0-beta'), [1, 86, 0]);
  assert.deepEqual(parseSemver('1.86.0+build.5'), [1, 86, 0]);
  for (const bad of ['', 'garbage', '1.x', '1..2', '-1.0.0', '1.2.3.4', null, undefined, 5, '1.86.0 beta', 'x1.0']) assert.equal(parseSemver(bad), null, String(bad));
  assert.equal(compareSemver('1.9.0', '1.10.0'), -1, 'numeric, not lexical');
  assert.equal(compareSemver('1.10.0', '1.9.0'), 1);
  assert.equal(compareSemver('1.86', '1.86.0'), 0);
  assert.equal(compareSemver('v1.86.0-beta', '1.86.0'), 0, 'a suffix is ignored');
  assert.equal(compareSemver('2.0.0', '1.99.99'), 1);
  assert.equal(compareSemver('1.86.1', '1.86.0'), 1);
  assert.equal(compareSemver('garbage', '1.0.0'), null);
  assert.equal(compareSemver('1.0.0', undefined), null);
}

// ── 4. compatibility ────────────────────────────────────────────────────────
{
  const site = { platform: '1.87.0', widgetTypes: ['heading', 'image', 'hero'], maxPageSchema: 2 };
  const ok = { $schema: SCHEMA, platform: '1.87.0', pages: [{ slug: 'a', published: blockOf(heading('x')) }] };
  let c = checkCompatibility(ok, site);
  assert.equal(c.ok, true);
  assert.deepEqual(c.blockers, []);
  assert.deepEqual(c.warnings, []);
  assert.deepEqual(c.pages, [{ index: 0, slug: 'a', ok: true, issues: [] }]);

  c = checkCompatibility(Object.assign({}, ok, { platform: '1.88.0' }), site);
  assert.equal(c.ok, false);
  assert.deepEqual(c.blockers.map((b) => b.code), ['platformNewer']);
  assert.deepEqual(c.blockers[0].detail, { exported: '1.88.0', site: '1.87.0' });
  assert.equal(c.blockers[0].page, undefined, 'a whole-file blocker names no page');
  assert.equal(c.pages[0].ok, true, 'the page itself is fine; the file is what is refused');
  assert.equal(checkCompatibility(Object.assign({}, ok, { platform: '1.87.1' }), site).ok, false, 'a patch newer is newer');
  assert.equal(checkCompatibility(Object.assign({}, ok, { platform: '1.10.0' }), { platform: '1.9.0' }).ok, false, '1.10 is newer than 1.9');
  assert.equal(checkCompatibility(Object.assign({}, ok, { platform: '1.87' }), site).ok, true);
  assert.equal(checkCompatibility(Object.assign({}, ok, { platform: 'v1.87.0-rc1' }), site).ok, true);

  c = checkCompatibility(Object.assign({}, ok, { platform: undefined }), site);
  assert.equal(c.ok, true);
  assert.deepEqual(c.warnings.map((w) => w.code), ['platformUnknown']);
  assert.deepEqual(checkCompatibility(Object.assign({}, ok, { platform: 'banana' }), site).warnings.map((w) => [w.code, w.detail]), [['platformUnknown', 'banana']], 'garbage is a warning, never a blocker');
  c = checkCompatibility(Object.assign({}, ok, { platform: '1.61.0' }), site);
  assert.equal(c.ok, true);
  assert.deepEqual(c.warnings.map((w) => w.code), ['platformOlder']);
  assert.deepEqual(checkCompatibility(Object.assign({}, ok, { platform: '1.87.0' }), { platform: '1.87.5', widgetTypes: [] }).warnings, [], 'same major.minor is not "older"');
  assert.deepEqual(checkCompatibility(Object.assign({}, ok, { platform: '0.99.0' }), { platform: '1.0.0' }).warnings.map((w) => w.code), ['platformOlder']);

  c = checkCompatibility({ $schema: 'lumen-pages/3', platform: '1.87.0', pages: ok.pages }, site);
  assert.deepEqual(c.blockers.map((b) => [b.code, b.detail]), [['schemaNewer', { found: 3, max: 2 }]]);
  assert.equal(checkCompatibility({ $schema: SCHEMA_V2, platform: '1.87.0', pages: ok.pages }, site).ok, true);

  // Widgets: published, draft, legacy blocks, nested; only the page that uses them is blocked.
  const bundle = {
    $schema: SCHEMA, platform: '1.87.0',
    pages: [
      { slug: 'good', published: blockOf(heading('x')) },
      { slug: 'pub', published: blockOf(widget('timeline')) },
      { slug: 'draftonly', published: blockOf(heading('x')), draft: blockOf(widget('mystery')) },
      { slug: 'legacy', published: { blocks: [widget('heading'), widget('old-thing')] } },
      { slug: 'legacytop', blocks: [widget('top-old')] },
      { slug: 'nested', published: blockOf(Object.assign(widget('hero'), { children: [widget('deep')], widgets: [widget('deeper')] })) },
      { slug: 'several', published: blockOf(widget('b-x'), widget('a-x'), widget('b-x')) },
    ],
  };
  c = checkCompatibility(bundle, site);
  assert.equal(c.ok, false);
  assert.deepEqual(c.pages.map((p) => p.ok), [true, false, false, false, false, false, false]);
  const wu = (slug) => c.blockers.find((b) => b.code === 'widgetUnknown' && b.slug === slug);
  assert.deepEqual(wu('pub').detail, ['timeline']);
  assert.deepEqual(wu('pub').page, 1);
  assert.deepEqual(wu('draftonly').detail, ['mystery'], 'a widget unknown in the draft only still blocks');
  assert.deepEqual(wu('legacy').detail, ['old-thing']);
  assert.deepEqual(wu('legacytop').detail, ['top-old']);
  assert.deepEqual(wu('nested').detail, ['deep', 'deeper']);
  assert.deepEqual(wu('several').detail, ['a-x', 'b-x'], 'sorted, once each');
  assert.equal(checkCompatibility(bundle, { platform: '1.87.0' }).ok, true, 'no widget list known: not checked');
  assert.equal(checkCompatibility(bundle, { platform: '1.87.0', widgetTypes: new Set(['heading', 'timeline', 'mystery', 'old-thing', 'top-old', 'hero', 'deep', 'deeper', 'a-x', 'b-x']) }).ok, true, 'any Iterable of types');

  // Page schema.
  c = checkCompatibility({ $schema: SCHEMA, platform: '1.87.0', pages: [{ slug: 'a', schemaVersion: 3, published: blockOf() }, { slug: 'b', schemaVersion: 2, published: blockOf() }] }, site);
  assert.deepEqual(c.pages.map((p) => [p.ok, p.issues]), [[false, ['pageSchemaNewer']], [true, []]]);
  assert.deepEqual(c.blockers[0].detail, { found: 3, max: 2 });
  assert.equal(checkCompatibility({ $schema: SCHEMA, platform: '1.87.0', pages: [{ slug: 'a', schemaVersion: 9, published: blockOf() }] }, { platform: '1.87.0' }).ok, true, 'no maxPageSchema: not checked');

  // Works on a parsed bundle, a raw page document included.
  const parsed = parse({ title: [], published: blockOf(widget('mystery')), schemaVersion: 3 }, 'about.json');
  c = checkCompatibility(parsed.bundle, site);
  assert.deepEqual(c.pages[0].issues, ['widgetUnknown', 'pageSchemaNewer']);

  // Tokens.
  const tk = { $schema: SCHEMA, platform: '1.87.0', variables: { lab: 'L' }, pages: [{ slug: 'a', title: { en: '{lab}' }, published: blockOf(widget('heading', { text: { en: '{lab} {brand} {mine} {gone}' } })) }] };
  c = checkCompatibility(tk, { platform: '1.87.0', variables: { mine: 'x' }, tokens: ['brand'] });
  assert.deepEqual(c.warnings.map((w) => [w.code, w.page, w.detail]), [['tokenUndefined', 0, ['gone']]]);
  assert.equal(c.ok, true, 'a token is never a blocker');
  assert.deepEqual(checkCompatibility(tk, { platform: '1.87.0', variables: ['mine', 'gone'], tokens: ['brand'] }).warnings, []);

  // Garbage in, no throw.
  for (const junk of [null, undefined, 5, 'x', [], { pages: 'no' }, { pages: [null, 3, {}] }]) {
    assert.doesNotThrow(() => checkCompatibility(junk, site));
    assert.doesNotThrow(() => checkCompatibility(ok, junk));
  }
}

// ── 5. signatures, live state, entries ─────────────────────────────────────
{
  const A = blockOf(heading('a'), widget('spacer', { props: { h: 1, w: 2 } }));
  const A2 = JSON.parse(JSON.stringify(A));
  A2.sections[0].columns[0].widgets[1].props = { w: 2, h: 1 };   // other key order
  assert.equal(contentSignature({ published: A }), contentSignature({ published: A2 }), 'key order is not a change');
  assert.equal(sameContent({ published: A, title: [] }, { published: A2, title: {} }), true, "PHP's [] title is {}");
  assert.equal(sameContent({ published: A }, { published: A, draft: A2 }), true, 'a draft equal to the published block is no draft');
  assert.equal(sameContent({ published: A }, { published: A, draft: blockOf(heading('other')) }), false);
  assert.equal(sameContent({ published: A, title: { en: 'T' } }, { published: A, title: { en: 'U' } }), false, 'the title counts');
  assert.equal(sameContent({ published: A, schemaVersion: 2, nav: { show: true } }, { published: A }), true, 'schemaVersion and nav are not content');
  assert.equal(sameContent({ draft: A }, { published: A }), false, 'draft-only differs from published');
  assert.equal(sameContent({ published: { sections: [], background: { preset: 'x', params: [] } } }, { published: { sections: [], background: { preset: 'x', params: {} } } }), true, 'PHP [] params');
  assert.equal(sameContent({ published: { sections: [] } }, { published: { sections: [], background: { preset: 'x' } } }), false);
  assert.equal(sameContent({ content: { published: A } }, { published: A }), true, 'a stored version works as is');
  assert.equal(typeof contentSignature(null), 'string');
  assert.equal(sameContent(null, {}), true);

  // entriesBySlug
  const bundle = { pages: [{ slug: 'about', label: '1' }, { slug: 'home' }, { slug: 'about', label: '2' }] };
  const by = entriesBySlug(bundle);
  assert.deepEqual([...by.keys()], ['about', 'home'], 'order of first appearance');
  assert.deepEqual(by.get('about').map((e) => [e.index, e.page.label]), [[0, '1'], [2, '2']]);
  assert.equal(entriesBySlug(null).size, 0);

  // pick
  const E = (createdAt, extra) => Object.assign({ slug: 'a', createdAt }, extra || {});
  assert.equal(pickActiveIndex([]), -1);
  assert.equal(pickActiveForSlug([]), null);
  assert.equal(pickActiveIndex([E('2026-01-01T00:00:00Z'), E('2026-03-01T00:00:00Z', { active: true }), E('2026-05-01T00:00:00Z')]), 1, 'the flagged one');
  assert.equal(pickActiveIndex([E('2026-01-01T00:00:00Z'), E('2026-05-01T00:00:00Z'), E('2026-03-01T00:00:00Z')]), 1, 'else the newest');
  assert.equal(pickActiveIndex([E(), E()]), 1, 'else the last');
  assert.equal(pickActiveIndex([E('2026-01-01T00:00:00Z'), E()]), 0, 'the dated one beats the undated');
  assert.equal(pickActiveIndex([E('2026-01-01T00:00:00Z'), E('2026-01-01T00:00:00Z')]), 1, 'a tie goes to the later one');
  const list = [E('2026-01-01T00:00:00Z'), E('2026-02-01T00:00:00Z')];
  assert.equal(pickActiveForSlug(list), list[1]);

  // versions → entries → bundle
  const nav = { label: { en: 'Team' }, show: false };
  const ver = { id: 'v0123456789ab', label: 'Spring', note: 'n', createdAt: '2026-04-01T10:00:00Z', content: { title: { en: 'T' }, nav, published: A, draft: A } };
  const e = versionToBundleEntry('team', ver, { active: true });
  assert.deepEqual(e, { slug: 'team', title: { en: 'T' }, nav, published: A, label: 'Spring', note: 'n', createdAt: '2026-04-01T10:00:00Z', active: true });
  assert.equal(versionToBundleEntry('about', ver).nav, undefined, 'a built-in page has no menu row');
  assert.equal('active' in versionToBundleEntry('team', ver), false);
  assert.equal(versionToBundleEntry('team', { label: 'x' }), null);
  const onlyDraft = versionToBundleEntry('team', { label: 'd', content: { draft: A } });
  assert.deepEqual([onlyDraft.published, onlyDraft.draft], [undefined, A]);
  const diff = versionToBundleEntry('team', { label: 'd', content: { published: A, draft: blockOf(heading('z')) } });
  assert.ok(diff.published && diff.draft);
  const live = pageEntryFromLive('team', { title: { en: 'T' }, published: A, draft: A, schemaVersion: 2 }, nav, { label: 'Live' });
  assert.deepEqual(live, { slug: 'team', title: { en: 'T' }, nav, published: A, label: 'Live' });
  // many versions of one page → /2 → parse → same versions, active kept
  const v1 = versionToBundleEntry('team', Object.assign({}, ver, { label: 'one', createdAt: '2026-01-01T00:00:00Z' }), {});
  const v2 = versionToBundleEntry('team', Object.assign({}, ver, { label: 'two', createdAt: '2026-02-01T00:00:00Z', content: { published: blockOf(heading('v2')) } }), { active: true });
  const file = buildBundle({ pages: [v1, v2], platform: '1.87.0', source: 'h', now: new Date('2026-11-19T00:00:00Z') });
  assert.equal(file.$schema, SCHEMA_V2);
  const back = parse(JSON.stringify(file));
  assert.deepEqual(back.bundle.pages, [v1, v2]);
  assert.equal(pickActiveForSlug(back.bundle.pages), back.bundle.pages[1]);

  // describeLive
  const signed = (id, content, extra) => Object.assign({ id, label: id.toUpperCase(), content }, extra || {});
  const V1 = signed('v1', { published: blockOf(heading('one')) });
  const V2 = signed('v2', { published: A }, { isActive: true });
  const V3 = signed('v3', { published: blockOf(heading('three')) });
  let d = describeLive({ published: A, draft: A, schemaVersion: 2 }, [V3, V2, V1]);
  assert.deepEqual([d.state, d.id, d.label, d.matchedActive, d.comparable], ['sync', 'v2', 'V2', true, true]);
  d = describeLive({ published: blockOf(heading('three')) }, [V3, V2, V1]);
  assert.deepEqual([d.state, d.id, d.matchedActive], ['sync', 'v3', false], 'equal to an inactive version');
  d = describeLive({ published: blockOf(heading('edited')) }, [V3, V2, V1]);
  assert.deepEqual([d.state, d.id, d.matchedActive], ['modified', 'v2', true], 'drifted from the active version');
  d = describeLive({ published: blockOf(heading('edited')) }, [V3, V1]);
  assert.deepEqual([d.state, d.id], ['unversioned', null]);
  assert.equal(describeLive({ published: A }, []).state, 'unversioned');
  assert.equal(describeLive(null, [V2]).state, 'modified', 'an empty live page is not the active version');
  assert.equal(describeLive({ published: A }, [{ id: 'x', isActive: true, signature: contentSignature({ published: A }) }]).state, 'sync', 'a precomputed signature is enough');
  d = describeLive({ published: A }, [{ id: 'v9', isActive: true, label: 'L' }, V3]);
  assert.deepEqual([d.state, d.id, d.comparable], ['modified', 'v9', false], 'content unknown: best effort, flagged');
  assert.equal(describeLive({ published: A }, undefined).state, 'unversioned');
}

// ── 6. import plan ──────────────────────────────────────────────────────────
{
  const mk = (slug, extra) => Object.assign({ slug, title: {}, published: blockOf(heading(slug)) }, extra || {});
  const meta = (n) => Array.from({ length: n }, (_, i) => ({ id: 'v' + String(i).padStart(12, '0') }));
  const st = (pages, versions) => ({ pages: pages || [], versions: versions || {} });
  const sum = (plan) => plan.rows.map((r) => [r.target, r.action, r.include, r.error, r.activate]);

  // Defaults: a new page is created, an existing one only gets a version.
  let bundle = { source: 'bemine.be', exportedAt: '2026-11-18T09:00:00.000Z', pages: [mk('about'), mk('team'), mk('news')] };
  let plan = planVersionImport(bundle, st(['team']), {});
  assert.deepEqual(sum(plan), [['about', 'version', true, null, null], ['team', 'version', true, null, null], ['news', 'create', true, null, 'publish']], 'about is built in: always exists');
  assert.equal(plan.rows[2].createsPage, true);
  assert.equal(plan.rows[0].createsPage, false);
  assert.equal(plan.rows[2].exists, false);
  assert.equal(plan.rows[0].builtin, true);
  assert.deepEqual(plan.counts, { included: 3, create: 1, version: 2, replace: 0, skipped: 0, blocked: 0, errors: 0 });
  assert.equal(plan.ok && plan.canImport, true);
  assert.equal(plan.activate, 'publish');
  assert.equal(plan.rows[0].label, 'bemine.be · 2026-11-18', 'label from "<source> · <date>"');
  assert.equal(plan.rows[0].labelDefault, true);
  assert.equal(defaultImportLabel({}, {}), '');
  assert.equal(defaultImportLabel({ source: 's' }, { createdAt: '2026-02-03T23:59:00Z' }), 's · 2026-02-03');

  // Choices: replace, include off, rename the target, draft mode.
  plan = planVersionImport(bundle, st(['team']), {
    activate: 'draft',
    rows: [{ action: 'replace' }, { include: false }, { target: ' News ' }],
  });
  assert.deepEqual(sum(plan), [['about', 'replace', true, null, 'draft'], ['team', 'version', false, null, null], ['news', 'create', true, null, 'draft']]);
  assert.equal(plan.counts.skipped, 1);
  assert.equal(plan.rows[2].target, 'news', 'targets are trimmed and lower-cased');
  assert.equal(planVersionImport(bundle, st(), { activate: 'whatever' }).activate, 'publish');
  // A rename onto an existing page turns "create" into a plain version; onto a new name, a version into create.
  plan = planVersionImport(bundle, st(['team']), { rows: [null, { target: 'new-name' }, { target: 'team' }] });
  assert.deepEqual(sum(plan).slice(1), [['new-name', 'create', true, null, 'publish'], ['team', 'version', true, null, null]]);
  // The words are corrected to the target's state, the intent to activate is kept.
  plan = planVersionImport(bundle, st(['team']), { rows: [{ action: 'create' }, { action: 'create' }, { action: 'replace' }] });
  assert.deepEqual(plan.rows.map((r) => r.action), ['replace', 'replace', 'create']);
  plan = planVersionImport(bundle, st(['team']), { rows: [{ action: 'nonsense' }] });
  assert.equal(plan.rows[0].action, 'version');
  // Slug validation.
  plan = planVersionImport(bundle, st(), { rows: [{ target: '../etc' }, { target: '' }, { target: 'Ok_1-x' }] });
  assert.deepEqual(plan.rows.map((r) => r.error), ['slug', 'slug', null]);
  assert.equal(plan.ok, false);
  assert.equal(plan.canImport, false);
  assert.equal(planVersionImport(bundle, st(), { rows: [{ target: 'x'.repeat(65) }] }).rows[0].error, 'slug');
  assert.equal(planVersionImport(bundle, st(), { rows: [{ target: '_x' }] }).rows[0].error, 'slug');
  plan = planVersionImport(bundle, st(), { rows: [{ target: '../etc', include: false }] });
  assert.equal(plan.rows[0].error, null, 'an excluded row is not validated');
  assert.equal(plan.ok, true);
  assert.equal(planVersionImport(bundle, st(), { rows: bundle.pages.map(() => ({ include: false })) }).canImport, false, 'nothing included: nothing to do');

  // Several versions of one page.
  const hist = {
    source: 's', exportedAt: '2026-11-18T09:00:00.000Z',
    pages: [mk('blog', { label: 'v1', createdAt: '2026-01-01T00:00:00Z' }), mk('blog', { label: 'v2', createdAt: '2026-02-01T00:00:00Z', active: true }), mk('blog', { label: 'v3', createdAt: '2026-03-01T00:00:00Z' })],
  };
  plan = planVersionImport(hist, st(), {});
  assert.deepEqual(sum(plan).map((r) => r.slice(0, 2)), [['blog', 'version'], ['blog', 'create'], ['blog', 'version']], 'the flagged version is the one that goes live; the page is created once');
  assert.deepEqual(plan.rows.map((r) => r.error), [null, null, null], 'versions of one page are not duplicates');
  assert.deepEqual(plan.rows.map((r) => r.label), ['v1', 'v2', 'v3']);
  assert.equal(plan.rows[1].flaggedActive, true);
  plan = planVersionImport(Object.assign({}, hist, { pages: hist.pages.map((p) => Object.assign({}, p, { active: undefined })) }), st(), {});
  assert.deepEqual(plan.rows.map((r) => r.action), ['version', 'version', 'create'], 'no flag: the newest');
  plan = planVersionImport(hist, st(['blog']), {});
  assert.deepEqual(plan.rows.map((r) => r.action), ['version', 'version', 'version'], 'existing page: live untouched');
  plan = planVersionImport(hist, st(['blog']), { rows: [{}, { action: 'replace' }, { action: 'replace' }] });
  assert.deepEqual(plan.rows.map((r) => r.action), ['version', 'replace', 'replace']);
  plan = planVersionImport(hist, st(), { rows: [{ action: 'create' }, { action: 'create' }, { action: 'create' }] });
  assert.deepEqual(plan.rows.map((r) => r.action), ['create', 'replace', 'replace'], 'created once, then replaced');
  assert.deepEqual(plan.rows.map((r) => r.createsPage), [true, false, false]);
  plan = planVersionImport(hist, st(), { rows: [{ action: 'version' }, { action: 'version' }, { action: 'version' }] });
  assert.deepEqual(plan.rows.map((r) => r.action), ['version', 'version', 'version'], 'history only, no page');
  assert.equal(plan.counts.create, 0);

  // Two different pages onto one NEW slug would create two pages at once; onto an existing one it is a history merge.
  bundle = { pages: [mk('a'), mk('b')] };
  plan = planVersionImport(bundle, st(), { rows: [{ target: 'z' }, { target: 'z' }] });
  assert.deepEqual(plan.rows.map((r) => r.error), ['duplicate', 'duplicate']);
  assert.equal(plan.ok, false);
  plan = planVersionImport(bundle, st(['z']), { rows: [{ target: 'z' }, { target: 'z' }] });
  assert.deepEqual(plan.rows.map((r) => [r.error, r.action]), [[null, 'version'], [null, 'version']]);
  plan = planVersionImport(bundle, st(), { rows: [{ target: 'z' }, { target: 'z', include: false }] });
  assert.deepEqual(plan.rows.map((r) => r.error), [null, null], 'an excluded row collides with nothing');
  plan = planVersionImport({ pages: [mk('a'), mk('b')] }, st(), { rows: [{ target: 'home' }, { target: 'home' }] });
  assert.deepEqual(plan.rows.map((r) => [r.error, r.action, r.builtin]), [[null, 'version', true], [null, 'version', true]], 'built-in pages always exist');

  // Blocked rows by compatibility cannot be included.
  bundle = { $schema: SCHEMA, platform: '1.87.0', pages: [mk('ok'), mk('bad', { published: blockOf(widget('mystery')) })] };
  const site = { platform: '1.87.0', widgetTypes: ['heading'], maxPageSchema: 2 };
  plan = planVersionImport(bundle, st(), { site, rows: [{}, { include: true }] });
  assert.deepEqual(plan.rows.map((r) => [r.include, r.blocked, r.blockedBy]), [[true, false, []], [false, true, ['widgetUnknown']]]);
  assert.equal(plan.counts.blocked, 1);
  assert.equal(plan.counts.skipped, 0, 'blocked is not "skipped"');
  assert.equal(plan.canImport, true, 'the importable rows still go');
  plan = planVersionImport(bundle, st(), { compat: checkCompatibility(bundle, site) });
  assert.equal(plan.rows[1].blocked, true, 'a precomputed verdict works too');
  plan = planVersionImport(Object.assign({}, bundle, { platform: '1.99.0' }), st(), { site });
  assert.deepEqual(plan.rows.map((r) => [r.include, r.blockedBy]), [[false, ['platformNewer']], [false, ['platformNewer', 'widgetUnknown']]], 'a whole-file blocker blocks every row');
  assert.equal(plan.canImport, false);
  assert.equal(planVersionImport(bundle, st(), {}).rows[1].blocked, false, 'no verdict given: nothing blocked');

  // Limits: 50 versions per page; an activation on an existing page may add a safety snapshot.
  const many = { pages: Array.from({ length: 5 }, (_, i) => mk('lib', { label: 'n' + i, createdAt: `2026-0${i + 1}-01T00:00:00Z` })) };
  plan = planVersionImport(many, st(['lib'], { lib: meta(MAX_VERSIONS - 3) }), {});
  assert.deepEqual(plan.rows.map((r) => r.error), [null, null, null, 'limit', 'limit'], 'the oldest fit, the newest do not');
  assert.equal(plan.ok, false);
  plan = planVersionImport(many, st(['lib'], { lib: meta(MAX_VERSIONS - 3) }), { rows: [{}, {}, {}, { include: false }, { include: false }] });
  assert.equal(plan.ok, true);
  plan = planVersionImport(many, st(['lib'], { lib: meta(MAX_VERSIONS - 3) }), { rows: [{ action: 'replace' }, {}, {}, { include: false }, { include: false }] });
  assert.deepEqual(plan.rows.map((r) => r.error), [null, null, 'limit', null, null], 'one place is kept for the safety snapshot');
  assert.equal(planVersionImport(many, st([], { lib: meta(MAX_VERSIONS) }), {}).rows.every((r) => r.error === 'limit'), true, 'a deleted page whose history is full');
  plan = planVersionImport({ pages: [mk('lib')] }, st([], { lib: meta(2) }), {});
  assert.deepEqual([plan.rows[0].exists, plan.rows[0].hasHistory, plan.rows[0].action], [false, true, 'create'], 'a deleted page with a history: restored by the import');

  // Garbage in, no throw.
  for (const [b, s, c] of [[null, null, null], [{}, {}, {}], [{ pages: [null, 7, {}] }, { pages: [1, null], versions: { x: 'no' } }, { rows: 'no' }]]) {
    assert.doesNotThrow(() => planVersionImport(b, s, c));
  }
  assert.deepEqual(planVersionImport(null, null, null).rows, []);
  assert.equal(planVersionImport(null, null, null).canImport, false);
}

// ── 7. Review fixes: the verifier models the server, never fails open, never throws ──────────────
{
  const bundleOf = (pages, extra) => Object.assign({ $schema: SCHEMA, platform: '1.87.0', pages }, extra || {});
  const one = (slug, block, extra) => Object.assign({ slug, title: {}, published: block }, extra || {});

  // A site that cannot say its own version cannot tell that a file is too recent for it: fail closed.
  for (const platform of ['', undefined, null, 'banana', 7]) {
    const c = checkCompatibility(bundleOf([one('a', blockOf(heading('x')))], { platform: '9.0.0' }), { platform });
    assert.equal(c.ok, false, `platform ${String(platform)}: nothing can be compared`);
    assert.deepEqual(c.blockers.map((b) => b.code), ['siteUnknown']);
  }
  assert.equal(checkCompatibility(bundleOf([one('a', blockOf(heading('x')))]), undefined).ok, false, 'no site description at all');
  const unknownSite = bundleOf([one('a', blockOf(heading('x'))), one('b', blockOf(heading('y')))], { platform: '9.0.0' });
  const plan = planVersionImport(unknownSite, { pages: [], versions: {} }, { site: { platform: '' } });
  assert.deepEqual(plan.rows.map((r) => [r.include, r.blockedBy]), [[false, ['siteUnknown']], [false, ['siteUnknown']]], 'every row is blocked');
  assert.equal(plan.canImport, false);

  // Deep nesting: refused, never a RangeError, and the verdict of a file survives a deep object.
  const deep = (n) => '{"a":'.repeat(n) + '1' + '}'.repeat(n);
  for (const n of [70, 1000, 5000, 20000]) {
    const text = `{"$schema":"lumen-pages/1","pages":[{"slug":"a","published":{"sections":[],"x":${deep(n)}}}]}`;
    let r;
    assert.doesNotThrow(() => { r = parseBundle(text); }, `depth ${n}`);
    assert.equal(r.ok, false);
    assert.ok(n < 20000 ? r.errors[0].code === 'content' : ['content', 'json'].includes(r.errors[0].code));
  }
  const nest = (n) => { let v = 1; for (let i = 0; i < n; i++) v = { a: v }; return v; };
  const withProps = (props) => blockOf(widget('heading', { props }));   // block → sections → section → columns → column → widgets → widget → props: 8 levels
  assert.equal(parse(bundleOf([one('a', withProps({ deep: nest(56) }))])).ok, true, 'a block 64 containers deep is the deepest accepted');
  assert.deepEqual(codes(bundleOf([one('a', withProps({ deep: nest(57) }))])), ['content'], 'one more is not');
  let chain = { type: 'heading' };
  for (let i = 0; i < 4000; i++) chain = { type: 'group', widgets: [chain] };
  assert.doesNotThrow(() => checkCompatibility({ $schema: SCHEMA, platform: '1.87.0', pages: [{ slug: 'a', published: { sections: [{ columns: [{ widgets: [chain] }] }] } }] }, { platform: '1.87.0', widgetTypes: ['heading'] }));
  assert.deepEqual(checkCompatibility({ $schema: SCHEMA, platform: '1.87.0', pages: [{ slug: 'a', published: { sections: [{ columns: [{ widgets: [chain] }] }] } }] }, { platform: '1.87.0', widgetTypes: ['heading'] }).blockers.map((b) => b.code), ['widgetUnknown'], 'a deep chain of widgets is still walked');

  // Sizes as the server counts them: JSON escaping of non-ASCII (6 characters each), the 4 MiB of one version, localized caps.
  const textBlock = (body) => ({ sections: [{ id: 's', columns: [{ id: 'c', width: 12, widgets: [{ type: 'text', props: { body } }] }] }] });
  assert.deepEqual(codes(bundleOf([one('a', textBlock('é'.repeat(400000)))])), ['size'], '400000 two-byte characters: 800 KB as UTF-8, 2.4 MB as the server counts');
  assert.deepEqual(codes(bundleOf([one('a', textBlock('é'.repeat(300000)))])), [], '300000 fit');
  assert.deepEqual(codes(bundleOf([one('a', textBlock('/'.repeat(1100000)))])), [], 'a slash is one character');
  const letters = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)), 't'.repeat(4000)]));
  assert.deepEqual(codes(bundleOf([one('a', textBlock('x'.repeat(2000000)), { draft: textBlock('y'.repeat(2000000)), title: letters(64) })])), ['size'], 'two blocks of 2 MB and a heavy title: over the 4 MiB of one version');
  assert.deepEqual(codes(bundleOf([one('a', textBlock('x'.repeat(2000000)), { draft: textBlock('y'.repeat(2000000)) })])), [], 'two blocks of 2 MB fit');
  assert.deepEqual(codes(bundleOf([one('a', blockOf(heading('x')), { title: { en: 'é'.repeat(4001) } })])), ['content'], 'a localized value of 4001 characters');
  assert.deepEqual(codes(bundleOf([one('a', blockOf(heading('x')), { title: { en: '😀'.repeat(4000) } })])), [], '4000 characters, astral ones counted once');
  const manyLocales = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)), 'x']));
  assert.deepEqual(codes(bundleOf([one('a', blockOf(heading('x')), { nav: { label: manyLocales, show: true } })])), ['content'], '65 locales');

  // Versions of one page do not lift the cap on pages: 200 distinct slugs, in /2 as in /1.
  const many = (n) => Array.from({ length: n }, (_, i) => one('p' + i, blockOf(heading('x'))));
  assert.equal(parse({ $schema: SCHEMA_V2, pages: many(200) }).ok, true);
  assert.deepEqual(codes({ $schema: SCHEMA_V2, pages: many(201) }), ['pages'], '201 distinct slugs in a /2 file');
  assert.equal(parse({ $schema: SCHEMA_V2, pages: Array.from({ length: 300 }, (_, i) => one('same', blockOf(heading('v' + i)))) }).ok, true, 'many versions of one page are one page');

  // The status of a page against its versions follows the server's rule: a version without a title leaves the live title alone.
  const A = blockOf(heading('A'));
  const live = { title: { en: 'About us' }, published: A, draft: A };
  assert.equal(describeLive(live, [{ id: 'v1', label: 'Plain', isActive: true, content: { published: A } }]).state, 'sync', 'a title-less active version equals the live page whatever its title');
  assert.equal(describeLive(live, [{ id: 'v1', label: 'Titled', isActive: true, content: { title: { en: 'Other' }, published: A } }]).state, 'modified', 'a version with a title must match it');
  assert.equal(describeLive(live, [{ id: 'v1', label: 'Titled', isActive: true, content: { title: { en: 'About us' }, published: A } }]).state, 'sync');
  assert.equal(describeLive(live, [{ id: 'v1', label: 'P', isActive: false, content: { published: A } }]).state, 'sync', 'also when it is not the active one');
  const sigs = (c) => ({ signature: contentSignature(c), signatureBare: contentSignature(c, { title: false }), hasTitle: !!(c.title && Object.keys(c.title).length) });
  assert.equal(describeLive(live, [Object.assign({ id: 'v1', isActive: true }, sigs({ published: A }))]).state, 'sync', 'the same with precomputed signatures');
  assert.equal(describeLive(live, [Object.assign({ id: 'v1', isActive: true }, sigs({ title: { en: 'X' }, published: A }))]).state, 'modified');
  assert.equal(sameContent(live, { published: A }), true);
  assert.equal(sameContent(live, { title: { en: 'X' }, published: A }), false);

  // Room in the history: a draft activation does not leave the page equal to the version, so each takes a safety snapshot.
  const pagesOf = (n) => Array.from({ length: n }, (_, i) => one('news', blockOf(heading('v' + i)), { label: 'v' + i, createdAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` }));
  const metas = (n, bytes) => Array.from({ length: n }, (_, i) => ({ id: 'v' + i, label: 'm' + i, bytes: bytes || 0 }));
  const st = (n, bytes) => ({ pages: ['news'], versions: { news: metas(n, bytes) } });
  const allReplace = Array.from({ length: 8 }, () => ({ action: 'replace' }));
  let p2 = planVersionImport({ pages: pagesOf(8) }, st(40), { activate: 'draft', rows: allReplace });
  assert.equal(p2.ok, false, 'in draft mode 8 activations of an existing page may need 8 snapshots: 40 + 8 + 8 > 50');
  assert.ok(p2.rows.some((r) => r.error === 'limit'));
  p2 = planVersionImport({ pages: pagesOf(8) }, st(40), { activate: 'publish', rows: allReplace });
  assert.equal(p2.ok, true, 'in publish mode the page IS each version in turn: one snapshot at most');
  p2 = planVersionImport({ pages: pagesOf(8) }, st(33), { activate: 'draft', rows: allReplace });
  assert.equal(p2.ok, true, '33 + 8 + 8 = 49');

  // The stored file is capped too (32 MiB, indented): a history that is already heavy takes no more.
  p2 = planVersionImport({ pages: pagesOf(2) }, st(10, 3000000), {});
  assert.ok(p2.rows.every((r) => r.error === 'limit'), '10 versions of 3 MB (compact) cannot take a 11th');
  p2 = planVersionImport({ pages: pagesOf(2) }, st(10, 20000), {});
  assert.equal(p2.ok, true);
}

console.log('test_pages_versions_engine: OK');
