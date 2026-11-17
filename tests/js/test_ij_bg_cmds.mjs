// Process > Subtract Background and Process > Enhance Contrast through the real controller and the real engine
// (tests/js/ij_harness.mjs): dialog values → api.run / api.compute / api.setDisplay → worker → undo → redo →
// reload and restore. The expected pixels come from the pure functions of ij-proc-bg.js (IJBg), which
// test_ij_bg_fixtures.mjs checks against ImageJ 1.54p value for value.
//
// Covers: the dialog fields and defaults (ImageJ's), the preview (the harness ticks it and waits for the
// engine), Light background / Create background / Sliding paraboloid / Disable smoothing, "Process all channels",
// 8, 16 and 32 bits, a selection (ignored by Subtract Background; the histogram of Enhance Contrast; selection only
// vs the whole image when normalizing), the multi-channel (composite) rules, Equalize (sqrt / classic), refusals.
//
// Run: node tests/js/test_ij_bg_cmds.mjs
import assert from 'node:assert/strict';
import { boot, EN } from './ij_harness.mjs';

const arr = (a) => Array.from(a);
const lastSpec = (t) => t.log.dialogSpecs[t.log.dialogSpecs.length - 1];
const fieldIds = (spec) => arr(spec.fields.map((f) => f.id));
const infoOf = (t, id) => t.engine('doc.info', { docId: id });
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

// ───────────────────────────── Subtract Background ─────────────────────────────
{
  const t = await boot({ channels: 2 });
  await t.open();
  const A = t.activeId();
  const info0 = (await t.docs()).find((d) => d.docId === A);
  const W = info0.width, H = info0.height;
  assert.equal(info0.bitDepth, 8);
  const IJBg = t.page.IJBg;
  assert.ok(IJBg, 'ij-proc-bg.js is loaded on the page');
  const px = async (c) => arr(await t.pixels(A, c));
  const before = [await px(0), await px(1)];
  const expected = async (data, bd, o) => {
    const bg = await IJBg.background(Uint8Array.from(data), W, H, { radius: o.radius, invert: !!o.invert, presmooth: !o.noSmooth, sliding: !!o.sliding, correctCorners: true });
    return arr(IJBg.render(Uint8Array.from(data), bg, bd, !!o.invert, !!o.create, W, { x: 0, y: 0, w: W, h: H }));
  };

  // ── the menu entry ──
  const cmd = t.cmd('procSubtractBackground');
  assert.deepEqual(J(cmd.menu), ['Process']);
  assert.equal(cmd.order, 110);
  assert.equal(cmd.shortcut, null);
  assert.equal(t.cmd('procEnhanceContrast').order, 50);
  assert.equal(t.cmd('procEnhanceContrast').separatorBefore, true);
  assert.equal(cmd.pkg, 'bg');
  assert.equal(cmd.long, true);

  // ── 1. rolling ball, dark background, the active channel ──
  await t.runCommand('procSubtractBackground', { radius: 12, light: false, create: false, sliding: false, noSmooth: false });
  const spec = lastSpec(t);
  assert.deepEqual(fieldIds(spec), ['radius', 'light', 'create', 'sliding', 'noSmooth', 'all'], 'ImageJ: radius, Light background, Create background, Sliding paraboloid, Disable smoothing (+ all channels on a multi-channel image)');
  const dflt = Object.fromEntries(spec.fields.map((f) => [f.id, f.value]));
  assert.deepEqual(J(dflt), { radius: 50, light: false, create: false, sliding: false, noSmooth: false, all: false }, "defaults: 50 pixels, Light background OFF (deliberate departure from ImageJ's Prefs bs.background: fluorescence has a dark background), the rest off");
  assert.equal(dflt.light, false, 'the dialog opens with Light background off on first use');
  assert.ok(spec.preview && typeof spec.preview.onChange === 'function', 'the dialog has a Preview');
  assert.ok(t.log.previews.length > 0, 'the harness ran the preview through the engine');
  assert.equal(spec.fields[0].unitsKey, 'dlg.pixels');
  const a1 = await px(0);
  assert.deepEqual(a1, await expected(before[0], 8, { radius: 12 }), 'channel 0 = the background-subtracted channel');
  assert.deepEqual(await px(1), before[1], 'the other channel is untouched');
  assert.notDeepEqual(a1, before[0]);
  const i1 = await infoOf(t, A);
  assert.deepEqual([i1.channels[0].display.min, i1.channels[0].display.max], [0, 255], 'setup("final"): resetMinAndMax');

  // the dialog remembers the last values (ImageJ: static fields)
  await t.runCommand('procSubtractBackground', { radius: 12, light: false, create: false, sliding: false, noSmooth: false });
  const d2 = Object.fromEntries(lastSpec(t).fields.map((f) => [f.id, f.value]));
  assert.equal(d2.radius, 12);
  assert.equal(d2.light, false);
  assert.equal(await t.isEnabled('editUndo'), true);
  // undo twice → the original; redo twice → the result of two runs
  await t.runCommand('editUndo'); await t.runCommand('editUndo');
  assert.deepEqual(await px(0), before[0], 'undo restores the pixels');
  await t.runCommand('editRedo');
  assert.deepEqual(await px(0), a1, 'redo');

  // ── 2. Light background + Create background + Sliding paraboloid + Disable smoothing, every channel ──
  await t.runCommand('editUndo');
  await t.runCommand('procSubtractBackground', { radius: 8, light: true, create: true, sliding: true, noSmooth: true, all: true });
  assert.deepEqual(await px(0), await expected(before[0], 8, { radius: 8, invert: true, create: true, sliding: true, noSmooth: true }), 'channel 0: light, create, paraboloid, no smoothing');
  assert.deepEqual(await px(1), await expected(before[1], 8, { radius: 8, invert: true, create: true, sliding: true, noSmooth: true }), 'channel 1 (all channels)');
  // reload: the journal replays the same pixels (the resolved params carry the LUT state, never the display)
  const afterAll = [await px(0), await px(1)];
  await t.flush();
  const keys = (await t.store.shared.list()).map((x) => x.key);
  const t2 = await t.reload({ flush: false });
  const w2 = await t2.spawn();
  for (const key of keys) {
    const res = await t2.engine('session.restore', { key }, w2);
    assert.equal(res.warnings.length, 0, JSON.stringify(res.warnings));
  }
  const restored = [];
  for (const c of [0, 1]) restored.push(arr((await t2.engine('doc.tile', { docId: A, channel: c, level: 0, tx: 0, ty: 0 }, w2)).data));
  assert.deepEqual(restored, afterAll, 'reload restores the same pixels');
  const ri = await t2.engine('doc.info', { docId: A }, w2);
  t2.close();
  t.close();
}

// ── 3. 16 and 32 bits, a selection that is ignored, an inverting LUT ──
{
  const t = await boot({ channels: 1 });
  await t.open();
  const A = t.activeId();
  const px = async (id = A) => arr(await t.pixels(id, 0));
  await t.runCommand('typeBit16');
  const w = (await t.docs())[0].width, h = (await t.docs())[0].height;
  const IJBg = t.page.IJBg;
  const d16 = await px();
  assert.equal((await t.docs())[0].bitDepth, 16);
  t.shell.opts.onRoi({ type: 'rect', x: 5, y: 4, w: 20, h: 12 }, { final: true });
  await t.runCommand('procSubtractBackground', { radius: 10, light: false, create: false, sliding: false, noSmooth: false });
  const out = await px();
  const bg = await IJBg.background(Uint16Array.from(d16), w, h, { radius: 10, invert: false, presmooth: true, sliding: false });
  assert.deepEqual(out, arr(IJBg.render(Uint16Array.from(d16), bg, 16, false, false, w, { x: 0, y: 0, w, h })), '16 bits, and the whole image although a selection exists (no SUPPORTS_MASKING)');
  let outside = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!(x >= 5 && x < 25 && y >= 4 && y < 16) && out[y * w + x] !== d16[y * w + x]) outside++;
  assert.ok(outside > 100, 'pixels outside the selection were processed: ' + outside);
  const i16 = (await t.docs())[0];
  assert.equal(i16.channels[0].display.max, Math.max(...out), '16 bits: the display range is reset to the data range');

  // 32 bits
  await t.runCommand('typeBit32');
  const d32 = await px();
  await t.runCommand('procSubtractBackground', { radius: 10, light: true, create: false, sliding: true, noSmooth: false });
  const bg32 = await IJBg.background(Float32Array.from(d32), w, h, { radius: 10, invert: true, presmooth: true, sliding: true, correctCorners: true });
  assert.deepEqual(await px(), arr(IJBg.render(Float32Array.from(d32), bg32, 32, true, false, w, { x: 0, y: 0, w, h })), '32 bits, light background, sliding paraboloid');

  // an inverting LUT: "Light background" flips (invert = (invertedLut && !light) || (!invertedLut && light))
  await t.runCommand('editUndo');
  await t.engine('doc.setDisplay', { docId: A, channel: 0, invert: true });
  assert.equal((await t.docs())[0].channels[0].display.invert, true);
  await t.runCommand('procSubtractBackground', { radius: 10, light: false, create: false, sliding: false, noSmooth: false });
  const bgInv = await IJBg.background(Float32Array.from(d32), w, h, { radius: 10, invert: true, presmooth: true, sliding: false });
  assert.deepEqual(await px(), arr(IJBg.render(Float32Array.from(d32), bgInv, 32, true, false, w, { x: 0, y: 0, w, h })), 'inverted LUT + Light background off = invert');
  t.close();
}

// ── 4. cancel, invalid radius, refusal on a tiny image ──
{
  const t = await boot({ channels: 1, firePreview: false });
  await t.open();
  const before = arr(await t.pixels(t.activeId(), 0));
  await t.runCommand('procSubtractBackground', null);
  assert.deepEqual(arr(await t.pixels(t.activeId(), 0)), before, 'a cancelled dialog changes nothing');
  assert.equal((await t.engine('doc.info', { docId: t.activeId() })).undoDepth, 0);
  // radius <= 0.0001: the dialog refuses it (ImageJ's dialogItemChanged returns false)
  await quiet(() => assert.rejects(t.runCommand('procSubtractBackground', { radius: 0 }), /err\.badArgs|radius/));
  t.script.dialogs.length = 0;
  t.close();
}
{
  // an image so small that the shrunken image has fewer than 2 pixels: refused with a sentence
  const t = await boot({ channels: 1, firePreview: false, volume: { width: 8, height: 8, channels: 1 } });
  await t.open();
  const errs = await quiet(() => t.runCommand('procSubtractBackground', { radius: 300, light: false, create: false, sliding: false, noSmooth: false }, { expectError: true }));
  assert.equal(errs.length, 1);
  assert.equal(errs[0].message, EN.err.bgTooSmall, 'the mapped sentence, never the engine message');
  assert.equal((await t.engine('doc.info', { docId: t.activeId() })).undoDepth, 0);
  await t.runCommand('procSubtractBackground', { radius: 300, light: false, create: false, sliding: true, noSmooth: false }); // paraboloid: fine
  assert.equal((await t.engine('doc.info', { docId: t.activeId() })).undoDepth, 1);
  assert.equal(t.IJApp.errorKey({ code: 'IJ_BG_TOO_SMALL' }), 'err.bgTooSmall');
  assert.equal(t.IJApp.errorKey({ code: 'IJ_BG_EQUALIZE_32' }), 'err.bgEqualize32');
  t.close();
}

// ───────────────────────────── Enhance Contrast ─────────────────────────────
function J(x) { return JSON.parse(JSON.stringify(x)); }

// ── 5. a multi-channel image is a CompositeImage: no Normalize, the display range of the current channel ──
{
  const t = await boot({ channels: 3 });
  await t.open();
  const A = t.activeId();
  const IJBg = t.page.IJBg;
  const info = (await t.docs())[0];
  const W = info.width, H = info.height;
  const px = async (c) => arr(await t.pixels(A, c));
  const before = [await px(0), await px(1), await px(2)];
  const whole = { x: 0, y: 0, w: W, h: H };
  const rangeOf = async (data, sat, rect, mask) => IJBg.rangeOf(await IJBg.statistics(Uint8Array.from(data), W, 8, rect || whole, mask || null), sat);

  await t.runCommand('procEnhanceContrast', { saturated: 0.35, equalize: false });
  const spec = lastSpec(t);
  assert.deepEqual(fieldIds(spec), ['saturated', 'equalize', 'classic'], 'a composite image has no Normalize and no "Update all" (ContrastEnhancer.showDialog)');
  assert.deepEqual(J(Object.fromEntries(spec.fields.map((f) => [f.id, f.value]))), { saturated: 0.35, equalize: false, classic: false });
  assert.equal(spec.fields[0].units, '%');
  const r0 = await rangeOf(before[0], 0.35);
  let ii = await infoOf(t, A);
  assert.deepEqual([ii.channels[0].display.min, ii.channels[0].display.max], [r0.displayMin, r0.displayMax], 'the display range of channel 0');
  assert.ok(r0.valid && (r0.displayMin > 0 || r0.displayMax < 255), 'a range narrower than 0..255');
  for (const c of [0, 1, 2]) assert.deepEqual(await px(c), before[c], 'no pixel changes');
  assert.equal(ii.undoDepth, 0, 'a display change is not an undo step');
  assert.deepEqual([ii.channels[1].display.min, ii.channels[1].display.max], [0, 255], 'other channels keep their display');

  // saturated 5 %: a narrower window, split half per tail
  await t.runCommand('procEnhanceContrast', { saturated: 5, equalize: false });
  const r5 = await rangeOf(before[0], 5);
  ii = await infoOf(t, A);
  assert.deepEqual([ii.channels[0].display.min, ii.channels[0].display.max], [r5.displayMin, r5.displayMax]);
  assert.ok(r5.displayMax - r5.displayMin < r0.displayMax - r0.displayMin, 'more saturation, narrower window');
  const remembered = Object.fromEntries(lastSpec(t).fields.map((f) => [f.id, f.value]));
  assert.equal(remembered.saturated, 0.35, 'the dialog opened with the previous value (the static field)');
  await t.runCommand('procEnhanceContrast', { saturated: 0.35 });
  assert.equal(Object.fromEntries(lastSpec(t).fields.map((f) => [f.id, f.value])).saturated, 5);

  // another channel: the active one
  // selection: the histogram of the selection
  t.shell.opts.onRoi({ type: 'rect', x: 4, y: 3, w: 12, h: 9 }, { final: true });
  await t.runCommand('procEnhanceContrast', { saturated: 0.35 });
  assert.deepEqual(fieldIds(lastSpec(t)), ['saturated', 'equalize', 'classic'], 'composite: no "Update all when normalizing" even with an area selection');
  const ch = (await t.engine('doc.info', { docId: A })).active;
  const rr = await rangeOf(before[ch], 0.35, { x: 4, y: 3, w: 12, h: 9 });
  ii = await infoOf(t, A);
  assert.deepEqual([ii.channels[ch].display.min, ii.channels[ch].display.max], [rr.displayMin, rr.displayMax], 'range of the selection, channel ' + ch);

  // ── Equalize (square root), the current channel only, histogram of the selection's bounding rectangle ──
  t.shell.opts.onRoi({ type: 'oval', x: 3, y: 2, w: 20, h: 14 }, { final: true });
  await t.runCommand('procEnhanceContrast', { saturated: 0.35, equalize: true, classic: false });
  const hist = IJBg.rectHistogram(Uint8Array.from(before[ch]), W, 8, { x: 3, y: 2, w: 20, h: 14 });
  const lut = IJBg.equalizeTable(hist, 8, false);
  const eqExp = before[ch].map((v) => lut[v]);
  assert.deepEqual(await px(ch), eqExp, 'Equalize: the table of the rectangle, applied to the WHOLE image');
  for (const c of [0, 1, 2].filter((x) => x !== ch)) assert.deepEqual(await px(c), before[c], 'other channels untouched');
  ii = await infoOf(t, A);
  assert.deepEqual(J(ii.channels[ch].display), { min: 0, max: 255, lut: ii.channels[ch].display.lut, invert: false }, 'equalize ends with resetMinAndMax');
  await t.runCommand('editUndo');
  assert.deepEqual(await px(ch), before[ch], 'undo');
  // the dialog remembers Equalize (static gEqualize)
  t.shell.opts.onRoi(null, { final: true });
  await t.runCommand('procEnhanceContrast', { saturated: 0.35, equalize: true, classic: true });
  assert.equal(Object.fromEntries(lastSpec(t).fields.map((f) => [f.id, f.value])).equalize, true);
  const hist2 = IJBg.rectHistogram(Uint8Array.from(before[ch]), W, 8, whole);
  assert.deepEqual(await px(ch), before[ch].map((v) => IJBg.equalizeTable(hist2, 8, true)[v]), 'classic equalization (no square root), whole image');
  await t.runCommand('editRedo').catch(() => {});
  t.close();
}

// ── 6. a single-channel image: Normalize, selection only / whole image, every bit depth ──
{
  const t = await boot({ channels: 1 });
  await t.open();
  const A = t.activeId();
  const IJBg = t.page.IJBg;
  const dims = (await t.docs())[0];
  const W = dims.width, H = dims.height;
  const px = async () => arr(await t.pixels(A, 0));
  const maxOf = { 8: 255, 16: 65535, 32: 1 };
  const bits = async () => (await t.docs())[0].bitDepth;
  const ctor = { 8: Uint8Array, 16: Uint16Array, 32: Float32Array };

  for (const bd of [8, 16, 32]) {
    if (bd === 16) await t.runCommand('typeBit16'); else if (bd === 32) await t.runCommand('typeBit32');
    assert.equal(await bits(), bd);
    const before = await px();
    const data = ctor[bd].from(before);
    const full = { x: 0, y: 0, w: W, h: H };
    const stats = await IJBg.statistics(data, W, bd, full, null);
    const r = IJBg.rangeOf(stats, 0.35);

    // Normalize, no selection
    await t.runCommand('procEnhanceContrast', { saturated: 0.35, normalize: true, equalize: false });
    assert.deepEqual(fieldIds(lastSpec(t)), ['saturated', 'normalize', 'equalize', 'classic'], 'a single image has Normalize');
    const norm = bd === 32 ? arr(IJBg.normalizeFloat(data, r.min, r.max)) : arr(data.map((v) => IJBg.normalizeTable(bd, r.min, r.max)[v]));
    const after = await px();
    assert.deepEqual(after, norm, `${bd} bits: Normalize`);
    assert.notDeepEqual(after, before);
    let ii = (await t.docs())[0];
    assert.deepEqual([ii.channels[0].display.min, ii.channels[0].display.max], [0, maxOf[bd]], `${bd} bits: the display range after Normalize is 0..${maxOf[bd]} (run(): ip.setMinAndMax)`);
    await t.runCommand('editUndo');
    assert.deepEqual(await px(), before, 'undo');
    ii = (await t.docs())[0];

    // selection: the histogram of the (oval) selection; selection only unless "Update all when normalizing"
    const oval = { type: 'oval', x: 4, y: 3, w: 24, h: 18 };
    t.shell.opts.onRoi(oval, { final: true });
    const mask = (await t.engine('doc.compute', { docId: A, op: 'saturatedRange', params: { saturated: 0.35 }, roi: oval, channel: 0 }));
    const rOval = mask;
    for (const entire of [false, true]) {
      await t.runCommand('procEnhanceContrast', { saturated: 0.35, normalize: true, entire, equalize: false });
      assert.deepEqual(fieldIds(lastSpec(t)), ['saturated', 'normalize', 'entire', 'equalize', 'classic'], 'an area selection adds "Update all when normalizing"');
      const got = await px();
      const tbl = bd === 32 ? null : IJBg.normalizeTable(bd, rOval.min, rOval.max);
      const nf = bd === 32 ? IJBg.normalizeFloat(ctor[bd].from(before), rOval.min, rOval.max) : null;
      const Rm = t.page.IJRoi.mask(oval, W, H);
      let inside = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const inMask = x >= Rm.x && x < Rm.x + Rm.w && y >= Rm.y && y < Rm.y + Rm.h && Rm.data[(y - Rm.y) * Rm.w + (x - Rm.x)] === 1;
        let want;
        if (bd === 32) want = nf[i]; // ImageJ normalises every pixel of a 32-bit image whatever the selection
        else want = (entire || inMask) ? tbl[before[i]] : before[i];
        if (got[i] !== want) assert.fail(`${bd} bits, entire=${entire}: pixel ${x},${y} is ${got[i]}, expected ${want} (inside ${inMask})`);
        if (inMask) inside++;
      }
      assert.ok(inside > 100);
      await t.runCommand('editUndo');
      assert.deepEqual(await px(), before);
    }
    t.shell.opts.onRoi(null, { final: true });
  }

  // a flat selection (hmax <= hmin): nothing happens (ImageJ: "if (hmax>hmin)")
  const A8 = t.activeId();
  void A8;
  t.close();
}

// ── 7. flat selection: nothing changes; equalize refuses 32 bits; a line selection ──
{
  const t = await boot({ channels: 1, firePreview: false });
  await t.open();
  const A = t.activeId();
  const before = arr(await t.pixels(A, 0));
  const disp = J((await infoOf(t, A)).channels[0].display);
  // one pixel: the statistics hold one value, hmax == hmin → no change at all
  t.shell.opts.onRoi({ type: 'rect', x: 3, y: 3, w: 1, h: 1 }, { final: true });
  const n0 = t.log.status.length;
  await t.runCommand('procEnhanceContrast', { saturated: 0.35, normalize: true, entire: true });
  assert.deepEqual(arr(await t.pixels(A, 0)), before, 'no pixel changes');
  // ContrastEnhancer.run: "if (normalize) { ... ip.setMinAndMax(0, ip.getBitDepth()==32?1.0:ip.maxValue()); }" even when stretchHistogram did nothing
  const dflat = (await infoOf(t, A)).channels[0].display;
  assert.deepEqual([dflat.min, dflat.max], [0, 255], 'Normalize on a flat selection still sets the display to 0..max');
  assert.ok(t.log.status.slice(n0).some((s) => typeof s === 'string' && s === EN.res.enhanceNoChange), 'the operator is told nothing changed');
  void disp;
  // a line selection: Roi.setIntBounds of a line (x = floor(bx+0.5), width = floor(bx+bw+1.5) - x): (2,2)-(20,14) -> (2,2,19,13)
  const IJBg = t.page.IJBg;
  const W = (await t.docs())[0].width;
  const statRange = async (rect, mask) => IJBg.rangeOf(await IJBg.statistics(Uint8Array.from(before), W, 8, rect, mask || null), 0.35);
  const dispOf = async () => { const d = (await infoOf(t, A)).channels[0].display; return [d.min, d.max]; };
  const lineRoi = { type: 'line', x1: 2, y1: 2, x2: 20, y2: 14, width: 1 };
  t.shell.opts.onRoi(lineRoi, { final: true });
  await t.runCommand('procEnhanceContrast', { saturated: 0.35, normalize: false });
  const lr = await statRange({ x: 2, y: 2, w: 19, h: 13 });
  assert.deepEqual(await dispOf(), [lr.displayMin, lr.displayMax], 'line selection: ImageJ line bounds (19 x 13), not the width-widened box');
  // a multi-point selection: the histogram holds the point pixels only (PointRoi.getMask)
  const pts = [[1, 1], [30, 2], [5, 20], [17, 9], [25, 18]];
  t.shell.opts.onRoi({ type: 'point', points: pts }, { final: true });
  await t.runCommand('procEnhanceContrast', { saturated: 0.35, normalize: false });
  const pm = { x: 1, y: 1, w: 30, h: 20, data: new Uint8Array(30 * 20) };
  for (const [x, y] of pts) pm.data[(y - 1) * 30 + (x - 1)] = 1;
  const pr = await statRange({ x: 1, y: 1, w: 30, h: 20 }, pm);
  assert.deepEqual(await dispOf(), [pr.displayMin, pr.displayMax], 'multi-point: the point pixels only');
  // a polyline: the polygon of its vertices is filled (PolygonRoi.getMask)
  const poly = [[3, 3], [28, 5], [20, 19]];
  t.shell.opts.onRoi({ type: 'polyline', points: poly }, { final: true });
  await t.runCommand('procEnhanceContrast', { saturated: 0.35, normalize: false });
  const fm = t.page.IJRoi.mask({ type: 'polygon', points: poly }, W, 64);
  const plr = await statRange({ x: fm.x, y: fm.y, w: fm.w, h: fm.h }, fm);
  assert.deepEqual(await dispOf(), [plr.displayMin, plr.displayMax], 'polyline: the filled polygon');
  // a line wholly outside the image: an empty roi, nothing changes (display kept)
  const keep = await dispOf();
  t.shell.opts.onRoi({ type: 'line', x1: 500, y1: 500, x2: 600, y2: 520, width: 1 }, { final: true });
  await t.runCommand('procEnhanceContrast', { saturated: 0.35, normalize: false });
  assert.deepEqual(await dispOf(), keep, 'a line outside the image changes nothing');
  t.shell.opts.onRoi(null, { final: true });
  // Equalize on a 32-bit image: refused with the mapped sentence
  await t.runCommand('typeBit32');
  const b32 = arr(await t.pixels(A, 0));
  const errs = await quiet(() => t.runCommand('procEnhanceContrast', { saturated: 0.35, equalize: true }, { expectError: true }));
  assert.equal(errs.length, 1);
  assert.equal(errs[0].message, EN.err.bgEqualize32);
  assert.deepEqual(arr(await t.pixels(A, 0)), b32);
  // the dialog's own cancel
  await t.runCommand('procEnhanceContrast', null);
  t.close();
}

// ── 8. Normalize (selection only) and Equalize survive undo / redo and a reload (the journal replays them) ──
{
  const t = await boot({ channels: 1 });
  await t.open();
  const A = t.activeId();
  const px = async () => arr(await t.pixels(A, 0));
  const before = await px();
  t.shell.opts.onRoi({ type: 'oval', x: 3, y: 2, w: 26, h: 20 }, { final: true });
  await t.runCommand('procEnhanceContrast', { saturated: 1, normalize: true, entire: false, equalize: false });
  const afterNorm = await px();
  assert.notDeepEqual(afterNorm, before);
  t.shell.opts.onRoi({ type: 'rect', x: 2, y: 2, w: 20, h: 15 }, { final: true });
  await t.runCommand('procEnhanceContrast', { saturated: 1, equalize: true, classic: false });
  const afterEq = await px();
  assert.notDeepEqual(afterEq, afterNorm);
  await t.runCommand('editUndo');
  assert.deepEqual(await px(), afterNorm, 'undo of Equalize');
  await t.runCommand('editRedo');
  assert.deepEqual(await px(), afterEq, 'redo of Equalize');
  await t.runCommand('editUndo'); await t.runCommand('editUndo');
  assert.deepEqual(await px(), before, 'undo of both');
  await t.runCommand('editRedo'); await t.runCommand('editRedo');
  assert.deepEqual(await px(), afterEq);
  const info = await infoOf(t, A);
  await t.flush();
  const keys = (await t.store.shared.list()).map((x) => x.key);
  const t2 = await t.reload({ flush: false });
  const w2 = await t2.spawn();
  for (const key of keys) assert.equal((await t2.engine('session.restore', { key }, w2)).warnings.length, 0);
  assert.deepEqual(arr((await t2.engine('doc.tile', { docId: A, channel: 0, level: 0, tx: 0, ty: 0 }, w2)).data), afterEq, 'reload restores Normalize + Equalize');
  const ri = await t2.engine('doc.info', { docId: A }, w2);
  assert.equal(ri.channels[0].display.max, info.channels[0].display.max);
  t2.close();
  t.close();
}

// ── 9. regressions of the review round ──
{
  const t = await boot({ channels: 1, firePreview: false });
  await t.open();
  const A = t.activeId();
  const IJBg = t.page.IJBg;
  const W = (await t.docs())[0].width;
  const before = arr(await t.pixels(A, 0));
  const whole = { x: 0, y: 0, w: W, h: (await t.docs())[0].height };
  const eq = (rect) => { const l = IJBg.equalizeTable(IJBg.rectHistogram(Uint8Array.from(before), W, 8, rect), 8, false); return before.map((v) => l[v]); };
  // Equalize with a polygon / freehand selection: the histogram of its BOUNDING RECTANGLE (ip.setRoi(roi.getBounds()))
  const poly = [[2, 2], [14, 3], [8, 10]];
  const bb = t.page.IJRoi.bounds({ type: 'polygon', points: poly });
  for (const type of ['polygon', 'freehand']) {
    t.shell.opts.onRoi({ type, points: poly }, { final: true });
    await t.runCommand('procEnhanceContrast', { saturated: 0.35, equalize: true, classic: false });
    assert.deepEqual(arr(await t.pixels(A, 0)), eq(bb), type + ': Equalize uses the bounding rectangle');
    assert.notDeepEqual(eq(bb), eq(whole), 'the rectangle table differs from the whole-image table (the test can tell)');
    await t.runCommand('editUndo');
    assert.deepEqual(arr(await t.pixels(A, 0)), before);
  }
  t.shell.opts.onRoi(null, { final: true });
  // the Subtract Background preview follows the run's channel: the dialog spec exposes only onChange, so the
  // source is checked: the preview channel reads the value captured before the dialog, never the live state
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../js/modules/studio/advanced-studio/ij-cmds-bg.js', import.meta.url), 'utf8');
  const pv = src.slice(src.indexOf("preview: { op: 'subtractBackground'"), src.indexOf("if (!values) return;"));
  assert.ok(pv.includes('st.activeChannel') && !pv.includes('api.state()'), 'preview channel = the captured channel');
  // scratchBytes: nothing shrunk, nothing declared for the small arrays; the paraboloid declares its line cache only
  const spec = t.page.IJOpRegistry.get('subtractBackground');
  const info = { width: 5735, height: 5735, bitDepth: 16 };
  const n = info.width * info.height;
  assert.equal(spec.scratchBytes(info, { radius: 10 }), n * 4 + n * 2 + (5735 + 5735 + 20) * 21 * 4 + 4 * 1048576, 'radius <= 10: no shrunken copy, only the line cache and the z ring');
  assert.equal(spec.scratchBytes(info, { radius: 10, sliding: true }), n * 4 + n * 2 + 5735 * 8 + 4 * 1048576);
  assert.ok(spec.scratchBytes(info, { radius: 50 }) > n * 4 + n * 2 + 4 * 1048576, 'radius 50 shrinks: the small arrays count');
  // saturatedRange counts the mask box of an area selection
  const sr = t.page.IJOpRegistry.get('saturatedRange');
  const s0 = sr.scratchBytes({ width: 1000, height: 1000, bitDepth: 8, roi: null });
  const s1 = sr.scratchBytes({ width: 1000, height: 1000, bitDepth: 8, roi: { type: 'rect', x: 0, y: 0, w: 1000, h: 1000 } });
  assert.equal(s1 - s0, 1000000);
  t.close();
}

// ───────────────────────────── the display keeps its LUT (integration review) ─────────────────────────────
// A step that resets the display range (resetMinAndMax) must not turn a coloured channel grey nor drop an inverted LUT.
{
  const t = await boot({ channels: 2 });
  await t.open();
  const A = t.activeId();
  const lutsOf = async () => (await infoOf(t, A)).channels.map((c) => [c.display.lut, !!c.display.invert]);
  const before = await lutsOf();
  assert.notEqual(before[0][0], 'Grays', 'the test needs a coloured channel');
  await t.runCommand('procSubtractBackground', { radius: 12, light: false, create: false, sliding: false, noSmooth: false });
  assert.deepEqual(J(await lutsOf()), J(before), 'Subtract Background keeps the LUTs');
  await t.runCommand('procEnhanceContrast', { saturated: 0.35, equalize: true, classic: false });
  assert.deepEqual(J(await lutsOf()), J(before), 'Equalize keeps the LUTs');
  // an inverted LUT survives too, and so does the invert flag after an undo / redo
  await t.engine('doc.setDisplay', { docId: A, channel: 0, invert: true });
  const inv = await lutsOf();
  assert.equal(inv[0][1], true);
  await t.runCommand('procSubtractBackground', { radius: 12, light: false, create: false, sliding: false, noSmooth: false });
  assert.deepEqual(J(await lutsOf()), J(inv), 'the inverted flag survives');
  await t.runCommand('editUndo');
  assert.deepEqual(J(await lutsOf()), J(inv), 'and the undo');
  t.close();
}

console.log('ij bg cmds: OK');
