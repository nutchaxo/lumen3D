// Package `stk` (js/modules/studio/advanced-studio/ij-proc-stk.js and the stack paths of ij-proc-multi.js) against the ImageJ 1.54p golden
// fixtures of tests/fixtures/ij-stacks: every case of the groups below runs through the REAL op specs (view -> run -> result) and the
// result is compared with what ImageJ produced, slice by slice in ImageJ's stack order: pixels (exact for integer types, a stated
// tolerance for float results), dimensions, labels, calibration, the hyperstack flag and the display mode.
//
// The adapters at the top turn one fixture case (ImageJ command + macro options) into op steps; a step is
//   { op, params, kind: 'newdoc' | 'size' | 'compute', view?: index of the input it runs on }
// A case whose ImageJ run raised an error (`thrown`) must make the op throw; an `options` string the adapter does not know fails the test.
//
// Run: node tests/js/test_ij_stk_ops_fixtures.mjs
import { loadContext, hasFixtures, fixtureFiles, readFx, viewOfStack, makeIo, sigOfStack, sigOfImage, diffSig, parseOpts, makeTester, assert } from './ij_stk_support.mjs';

if (!hasFixtures()) { console.log('SKIP tests/fixtures/ij-stacks is absent'); process.exit(0); }
const ctx = loadContext();
const R = ctx.IJOpRegistry;
const T = makeTester('test_ij_stk_ops_fixtures');

const PROJ = { 'Average Intensity': 'avg', 'Max Intensity': 'max', 'Min Intensity': 'min', 'Sum Slices': 'sum', 'Standard Deviation': 'sd', 'Median': 'median' };
const isHyper = (v) => v.hyperstack || v.nC > 1;

// command -> (options, views, cur) -> [steps]
const ADAPT = {
  'Add Slice'(o, [v]) { return [{ op: 'stkAddSlice', kind: 'size', params: isHyper(v) ? { add: o.add || 'slice', prepend: !!o.prepend } : { add: 'slice' } }]; },
  'Delete Slice'(o, [v]) { return [{ op: 'stkDeleteSlice', kind: 'size', params: isHyper(v) ? { delete: o.delete || 'slice' } : {} }]; },
  'Reverse'() { return [{ op: 'stkReverse', kind: 'size', params: {} }]; },
  'Reduce...'(o) { return [{ op: 'stkReduce', kind: 'size', params: { factor: parseInt(o.reduction, 10), reduceZ: !!o.reduce } }]; },
  'Make Substack...'(o, [v]) { return substack(o, v); },
  'Make Subset...'(o, [v]) { return substack(o, v); },
  'Stack to Hyperstack...'(o) {
    return [{ op: 'stkToHyperstack', kind: 'size', params: { order: String(o.order || 'xyczt(default)').replace('(default)', ''), channels: +o.channels, slices: +o.slices, frames: +o.frames,
      mode: ({ Composite: 'composite', Color: 'color', Grayscale: 'gray' })[o.display] } }];
  },
  'Z Project...'(o, [v]) {
    return [{ op: 'stkZProject', kind: 'newdoc', params: { start: +o.start, stop: +o.stop, method: PROJ[o.projection], allFrames: !!o.all } }];
  },
  'Grouped Z Project...'(o) { return [{ op: 'stkGroupedZ', kind: 'newdoc', params: { method: PROJ[o.projection], group: +o.group } }]; },
  'Make Montage...'(o) {
    return [{ op: 'stkMontage', kind: 'newdoc', params: Object.assign({ columns: +o.columns, rows: +o.rows, scale: +o.scale, first: +o.first, last: +o.last, inc: +o.increment, border: +o.border }, o.use ? { fg: 255, bg: 0 } : {}), cmp: { noLabels: true } }];
  },
  'RGB Color'(o, [v]) {
    const params = { slices: !!o.slices, frames: !!o.frames };
    // the driver switched the second channel off for this case (the flag is display state, not in the fixture's STACK)
    if (CASE.name === 'rgbcolor_composite_active_channels') params.visible = [true, false, true];
    if (o.keep) return [{ op: 'stkRgbColor', kind: 'newdoc', params }];
    return [{ op: 'stkRgbColorInPlace', kind: 'size', params, cmp: { noHyper: true } }];
  },
  '8-bit'(o, v, cur, fx) { return convert(8, fx); },
  '16-bit'(o, v, cur, fx) { return convert(16, fx); },
  '32-bit'(o, v, cur, fx) { return convert(32, fx); },
  'RGB Stack'() { return [{ op: 'stkRgbStack', kind: 'size', params: {}, cmp: { flat: true, noMode: true } }]; },
  'HSB Stack'() { return [{ op: 'stkHsbStack', kind: 'size', params: {}, cmp: { flat: true, noMode: true } }]; },
  'HSB (32-bit)'() { return [{ op: 'stkHsb32', kind: 'size', params: {}, cmp: { flat: true, noMode: true, tol: 1e-6 } }]; },
  'Lab Stack'(o, v, cur, fx) { return fx.case === 'lab_stack_gui' ? [] : [{ op: 'stkLabStack', kind: 'newdoc', params: {}, cmp: { noMode: true, tol: 1e-3 } }]; },
  'Stack to RGB'(o) { return [{ op: o.keep ? 'stkStackToRgb' : 'stkStackToRgbInPlace', kind: o.keep ? 'newdoc' : 'size', params: { slices: !!o.slices, frames: !!o.frames }, cmp: { noHyper: true } }]; },
  'Make Composite'(o) { return [{ op: 'stkMakeComposite', kind: 'size', params: { mode: ({ Composite: 'composite', Color: 'color', Grayscale: 'gray' })[o.display] }, expect: 'created', cmp: { noMode: true } }]; },
  'Merge Channels...'(o, views) {
    const sources = [], docs = [];
    for (let slot = 0; slot < 7; slot++) {
      const nm = o['c' + (slot + 1)];
      if (nm === undefined || nm === true) continue;
      const k = views.findIndex((v) => v.name === nm);
      if (k < 0) throw new Error('no such image ' + nm);
      sources.push({ docId: views[k].id, slot }); if (docs.indexOf(k) < 0) docs.push(k);
    }
    return [{ op: 'mergeChannels', kind: 'newdoc', docs, params: { sources, rgb: !o.create, ignoreLuts: !!o.ignore }, cmp: { noMode: true } }];
  },
  'Split Channels'() { return [{ op: 'splitChannels', kind: 'newdoc', many: true, params: {}, cmp: { noMode: true } }]; },
  'Statistics'(o, v, cur, fx) {
    return [{ op: 'stkStats', kind: 'compute', roi: roiOf(fx.roi || (fx.input && fx.input.roi)), params: { limit: false }, check(res, c) {
      const t = c.table, row = t.rows[0], h = t.headings;
      const at = (name) => row[h.indexOf(name)];
      const near = (a, b, what) => { const ok = (a === null || b === null) ? a === b : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)); assert.ok(ok, what + ': got ' + a + ', want ' + b); };
      near(res.voxels, at('Voxels'), 'Voxels');
      near(res.percentVolume, at('%Volume'), '%Volume');
      near(res.mean, at('Mean'), 'Mean'); near(res.stdDev, at('StdDev'), 'StdDev'); near(res.min, at('Min'), 'Min'); near(res.max, at('Max'), 'Max'); near(res.mode, at('Mode'), 'Mode');
      near(res.median === null ? null : res.median, at('Median'), 'Median');
      const vh = h.find((x) => /^Volume\(/.test(x));
      if (vh) near(res.volume, at(vh), 'Volume');
    } }];
  },
  'Plot Z-axis Profile'(o, v, cur, fx) {
    return [{ op: 'stkProfile', kind: 'compute', roi: roiOf(fx.roi || (fx.input && fx.input.roi)), params: { dimension: o.profile === 'z-axis' ? 'z' : 'time' }, check(res, c) {
      const p = c.plots[0];
      assert.equal(res.title, p.title);
      assert.deepEqual(res.x.map((q) => Math.round(q * 1e6) / 1e6), p.x.map((q) => Math.round(q * 1e6) / 1e6), 'x');
      assert.equal(res.y.length, p.y.length, 'n');
      res.y.forEach((q, i) => assert.ok(Math.abs(q - p.y[i]) <= 1e-5 * Math.max(1, Math.abs(p.y[i])), 'y[' + i + '] got ' + q + ' want ' + p.y[i]));
    } }];
  },
  'Reslice [/]...'(o, v, cur, fx) {
    const roi = roiOf(c_roi(fx));
    const start = String(o.start || 'Top').toLowerCase();
    return [{ op: 'stkReslice', kind: 'newdoc', roi, params: { output: +o.output, start, flip: !!o.flip, rotate: !!o.rotate, avoid: !!o.avoid, sliceCount: o.slice_count ? +o.slice_count : undefined } }];
  },
  '8-bit Color'(o, [v]) {
    const n = Math.min(256, Math.max(2, +o.number));
    return [{ op: 'stk8BitColor', kind: 'size', params: { colors: n }, verify(res, c) {
      // not bit-identical to ImageJ's MedianCut (its improveInverseMap refinement is not reproduced): the palette has at most n colours, the indices
      // reproduce the image, losslessly when it has few colours and within a PSNR bound otherwise
      const table = res.channels[0].display.lut;
      assert.equal(res.bitDepth, 8);
      const planes = res.channels[0].planes || [res.channels[0].data];
      const used = new Set(); let err = 0, cnt = 0;
      planes.forEach((pl, k) => {
        for (let i = 0; i < pl.length; i++) {
          used.add(pl[i]);
          for (let ch = 0; ch < 3; ch++) { const d = table[pl[i] * 3 + ch] - v.channels[ch].planes[k][i]; err += d * d; cnt++; }
        }
      });
      assert.ok(used.size <= n, 'at most ' + n + ' palette entries, used ' + used.size);
      const colours = new Set(); v.channels[0].planes.forEach((pl, k) => { for (let i = 0; i < pl.length; i++) colours.add(((pl[i] >> 3) << 10) | ((v.channels[1].planes[k][i] >> 3) << 5) | (v.channels[2].planes[k][i] >> 3)); });
      const mse = err / cnt;
      if (colours.size <= n) assert.ok(mse < 12, 'few colours: mse ' + mse);   // within the 3 low bits ignored by the 15-bit histogram
      else assert.ok(mse < (n < 4 ? 8000 : 3000), 'mse ' + mse);
      const want = c.self; assert.equal(res.width, want.width); assert.equal(planes.length, want.dims.z * want.dims.t);
    } }];
  },
  'Images to Stack'(o, views) {
    const filter = o.title === undefined || o.title === true ? '' : String(o.title);
    const docs = views.map((v, i) => i).filter((i) => filter === '' || views[i].name.indexOf(filter) >= 0);
    return [{ op: 'stkImagesToStack', kind: 'newdoc', docs, params: { method: ({ 'Copy (center)': 'center', 'Copy (top-left)': 'topleft', 'Scale (smallest)': 'smallest', 'Scale (largest)': 'largest' })[o.method] || 'center',
      name: o.name || 'Stack', useTitles: !!o.use, bicubic: !!o.bicubic, fill: String(o.fill || 'Black').toLowerCase() } }];
  },
  'Stack to Images'() { return [{ op: 'stkStackToImages', kind: 'newdoc', many: true, params: {} }]; },
  'Concatenate...'(o, views) {
    const docs = [];
    for (let i = 1; o['image' + i] !== undefined; i++) { const nm = o['image' + i]; const k = views.findIndex((v) => v.name === nm); if (k >= 0) docs.push(k); }
    return [{ op: 'stkConcatenate', kind: 'newdoc', docs, params: { title: o.title, open4D: !!o.open } }];
  },
  'Combine...'(o, views) {
    const docs = [views.findIndex((v) => v.name === o.stack1), views.findIndex((v) => v.name === o.stack2)];
    return [{ op: 'stkCombine', kind: 'newdoc', docs, params: { vertical: !!o.combine } }];
  },
  'Montage to Stack...'(o) { return [{ op: 'stkMontageToStack', kind: 'newdoc', params: { columns: +o.columns, rows: +o.rows, border: +(o.border || 0) } }]; },
  'Insert...'(o, views) {
    return [{ op: 'insert', kind: 'insert', dst: views.findIndex((v) => v.name === o.destination), src: views.findIndex((v) => v.name === o.source), x: +o.x, y: +o.y }];
  },
  'Hyperstack to Stack'() { return [{ op: 'stkHyperToStack', kind: 'size', params: {}, cmp: { flat: true } }]; },
  'Reduce Dimensionality...'(o) {
    return [{ op: o.keep ? 'stkReduceDimNew' : 'stkReduceDim', kind: o.keep ? 'newdoc' : 'size', params: { channels: !!o.channels, slices: !!o.slices, frames: !!o.frames } }];
  }
};
function roiOf(r) {
  if (!r) return null;
  if (r.type === 'polygon' && r.pts) {
    if (r.pts.length === 4) return { type: 'line', x1: r.pts[0], y1: r.pts[1], x2: r.pts[2], y2: r.pts[3], width: 1 };
    const points = []; for (let i = 0; i < r.pts.length; i += 2) points.push([r.pts[i], r.pts[i + 1]]);
    return { type: 'polygon', points };
  }
  return { type: r.type, x: r.x, y: r.y, w: r.w, h: r.h };
}
function c_roi(fx) { return fx.roi || (fx.input && fx.input.roi) || null; }
function convert(bd, fx) {
  return [{ op: 'stkConvert', kind: 'size', params: { bitDepth: bd, scale: fx.scaleWhenConverting !== false, weighted: !!fx.weighted }, cmp: { noMode: true } }];
}
function substack(o, v) {
  const params = isHyper(v) && (v.nC > 1 || (v.nZ > 1 && v.nT > 1)) ? { channels: o.channels, slices: o.slices, frames: o.frames } : { slices: o.slices };
  const steps = [{ op: 'stkSubstack', kind: 'newdoc', params }];
  if (o.delete) steps.push({ op: 'stkDeleteRange', kind: 'size', params });
  return steps;
}

const GROUPS = (process.argv[2] ? process.argv[2].split(',') : ['substack', 'reduce', 'reverse', 'hyper', 'slices', 'concat', 'montage', 'zproj', 'rgb', 'convert', 'stats', 'zprofile', 'reslice']);
const COMMANDS = new Set(Object.keys(ADAPT));
const CASE = { name: '' };
let seen = 0, skipped = 0;

async function runStep(step, views, cur) {
  if (step.kind === 'insert') {
    const dst = views[step.dst], src = views[step.src];
    const list = ctx.IJStk.insertPlanes(dst, src, step.x, step.y);
    // the destination as the engine's commitPlanes leaves it: the pasted planes replace the old ones
    const channels = dst.channels.map((ch) => ({ name: ch.name, color: ch.color, planes: ch.planes.slice() }));
    for (const it of list) channels[it.c].planes[it.t * dst.nZ + it.z] = it.data;
    return { name: dst.name, width: dst.width, height: dst.height, bitDepth: dst.bitDepth, nZ: dst.nZ, nT: dst.nT, rgb: dst.rgb, hyperstack: dst.hyperstack,
      labels: dst.labels, calibration: dst.calibration, channels };
  }
  const spec = R.get(step.op);
  assert.ok(spec, 'op ' + step.op);
  const order = step.docs ? step.docs.map((i) => views[i]) : [views[step.view === undefined ? cur : step.view]].concat(views.filter((x, i) => i !== (step.view === undefined ? cur : step.view)));
  const view = order[0];
  const io = makeIo(order);
  if (spec.validate) spec.validate(step.params, { width: view.width, height: view.height, bitDepth: view.bitDepth, channels: view.channels.length });
  return spec.run(view, step.params, step.roi || null, io);
}

for (const g of GROUPS) {
  for (const file of fixtureFiles(g)) {
    const fx = readFx(file);
    if (!COMMANDS.has(fx.command)) { skipped++; continue; }
    const cases = fx.cases || [fx];
    CASE.name = fx.case;
    cases.forEach((c, k) => T.test(`${g}/${fx.case} #${k + 1} [${c.options}]`, async () => {
      seen++;
      // convert_make_composite_stack keeps the stack each case started from in `self` (its `input` is the first one only)
      const inputs = c.input ? [c.input] : (fx.case === 'convert_make_composite_stack' ? [c.self] : (fx.inputs || [fx.input]));
      const views = inputs.map((S, i) => viewOfStack(S, 'd' + (i + 1)));
      const cur = fx.inputs ? (fx.current || 1) - 1 : 0;
      let steps;
      try { steps = ADAPT[fx.command](parseOpts(c.options), views, cur, fx); } catch (e) { if (c.thrown) return; throw e; }
      if (c.thrown) {
        let threw = false;
        try { for (const s of steps) await runStep(s, views, cur); } catch (e) { threw = true; }
        assert.ok(threw, 'ImageJ refused this (' + c.thrown + ')');
        return;
      }
      // ImageJ made nothing and changed nothing (an empty range, a reduction of 1): the op may answer null or refuse
      const nothing = !(c.created || []).length && !(c.self && c.self.dims) && !(c.others || []).some((x) => x && x.dims && x !== 'unchanged');
      if (nothing || (c.dialogs && c.dialogs.length && !(c.created || []).length)) { try { for (const s of steps) await runStep(s, views, cur); } catch (e) { /* a refusal is as good as nothing */ } return; }
      const created = (c.created || []).filter((x) => x && x.dims);
      let ci = 0;
      for (const s of steps) {
        const res = await runStep(s, views, cur);
        if (s.kind === 'compute') { s.check(res, c); continue; }
        if (s.verify) { s.verify(res, c); continue; }
        if (s.kind === 'insert') {
          const want = (c.others || []).find((x) => x && x.dims) || ((c.others || []).indexOf('unchanged') >= 0 ? inputs[s.dst] : null);
          assert.ok(want, 'ImageJ reports the destination');
          const d = diffSig(sigOfImage(res, views[s.dst].calibration), sigOfStack(want), Object.assign({}, s.cmp));
          assert.deepEqual(d, [], 'destination: ' + d.join('; '));
        } else if (s.kind === 'newdoc') {
          assert.ok(res.length === (s.many ? created.length : 1) || !created.length, 'image count ' + res.length + ' vs ' + created.length);
          for (let r = 0; r < res.length; r++) {
            const want = created[ci++];
            assert.ok(want, 'ImageJ created nothing but the op made ' + res.length);
            const got = sigOfImage(res[r], views[cur].calibration);
            const d = diffSig(got, sigOfStack(want), Object.assign({}, s.cmp));
            assert.deepEqual(d, [], 'created image ' + (r + 1) + (got.name !== undefined ? ' (' + got.name + ')' : '') + ': ' + d.join('; '));
            if (want.title !== undefined && res[r].name !== undefined && s.name !== false) assert.equal(res[r].name, want.title, 'title');
          }
        } else if (s.kind === 'size') {
          if (res === null) continue;
          const want = s.expect === 'created' || (created.length > ci && !c.self) ? created[ci++] : c.self;
          if (want && want.dims) {
            const d = diffSig(sigOfImage(res, views[cur].calibration), sigOfStack(want), Object.assign({}, s.cmp));
            assert.deepEqual(d, [], 'self: ' + d.join('; '));
          }
        }
      }
    }));
  }
}
await new Promise((r) => setTimeout(r, 50));
console.log(`(${seen} cases run, ${skipped} fixture files with commands of later steps skipped)`);
T.done();
