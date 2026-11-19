// Analyze > Skeleton > Analyze Skeleton (2D/3D): Arganda-Carreras et al. 2010 (ij-proc-fiji.js, IJSkeleton / ops analyzeSkeleton, skeletonTagged).
//
// Fiji's plugin is GPL: it was only RUN. tests/fixtures/ij-wave3/fiji/skeleton holds 4 one-pixel skeletons (loops, a lattice, a single pixel, quadruple
// points) × 8 option sets. This test reproduces, EXACTLY (counts equal, lengths ±1e-6, same tags, same pruned skeleton):
//   default / detailed / labeled / Prune ends / Calculate largest shortest path (all 4 skeletons, all 3 tree orders),
// and states, case by case, what still differs (DEVIATIONS below) so any change of behaviour is noticed:
//   - the cycle pruning when several branches are equally short or equally bright (the lattice, a binary skeleton): which one Fiji cuts;
//   - lengths after a cycle cut where a branch starts and ends in the same junction;
//   - the tree made of one end-point and a loop: Fiji reports twice the end branch as its longest shortest path;
//   - the picture of the longest shortest path when two branches join the same pair of junctions.
//
// The options are Fiji's macro keys (the first word of each label): show = "Show detailed info", display = "Display labeled skeletons"; its
// Branch information table is compared branch by branch (as a multiset) and its 32-bit "<title>-labeled-skeletons" pixel by pixel.
// Lowest-intensity pruning on a binary skeleton is all ties, so those runs stay in DEVIATIONS; section 5 runs it on skeletons with distinct
// intensities (fixture skeleton_valued.json, 24 Fiji runs), where the cut voxel is exact.
// Run: node tests/js/test_ij_fiji_skeleton.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const ctx = vm.createContext({ console, setTimeout, clearTimeout });
for (const f of ['ij-core.js', 'ij-proc-shared.js', 'ij-proc-fiji.js']) vm.runInContext(readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
const SK = vm.runInContext('IJSkeleton', ctx);
const reg = vm.runInContext('IJOpRegistry', ctx);
const FX = path.join(ROOT, 'tests', 'fixtures', 'ij-wave3', 'fiji', 'skeleton');
const u8 = (d) => { const b = Buffer.from(d.data.b64, 'base64'); return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const plain = (x) => JSON.parse(JSON.stringify(x));
const optsOf = (c) => ({ prune: /\[shortest branch\]/.test(c.options) ? 'shortest' : /lowest intensity voxel/.test(c.options) ? 'lowestVoxel' : /lowest intensity branch/.test(c.options) ? 'lowestBranch' : 'none',
  pruneEnds: /prune_0/.test(c.options), shortestPath: /calculate/.test(c.options), detailed: /show/.test(c.options), labeled: /display/.test(c.options) });   // macro keys = the first word of "Show detailed info" / "Display labeled skeletons"

// ── 1. the fixtures: what is exact, and what is known to differ ──
// "graph<g>/<case>": the cells of the table that differ (row.column), and whether the tagged / paths / pruned pictures differ
const DEVIATIONS = {
  'graph0/shortestPath': 'sp:2 paths',
  'graph1/pruneShortest': '0.5 0.8 tagged pruned',
  'graph1/pruneLowestVoxel': '0.0 0.3 0.4 0.5 0.6 0.8 tagged pruned',
  'graph1/pruneLowestBranch': '0.0 0.2 0.3 0.4 0.5 0.6 0.7 0.8 tagged pruned',
  'graph2/pruneShortest': '1.5',
  'graph2/pruneLowestVoxel': '1.5 1.6 1.7 tagged pruned',
  'graph2/pruneLowestBranch': '1.0 1.3 1.4 1.5 1.6 1.7 1.8 tagged pruned',
  'graph3/shortestPath': 'paths',
  'graph3/pruneLowestVoxel': '0.5',
  'graph3/pruneLowestBranch': '0.0 0.2 0.3 0.4 0.5 tagged pruned'
};
let exact = 0, deviating = 0, branchTables = 0;
for (const f of readdirSync(FX).sort()) {
  const d = JSON.parse(readFileSync(path.join(FX, f), 'utf8'));
  const data = u8(d.input), w = d.input.width, h = d.input.height;
  for (const c of d.cases) {
    const o = optsOf(c);
    const r = await SK.analyze(data, w, h, o);
    const key = f.replace('.json', '') + '/' + c.name, want = c.result.table.rows, diffs = [];
    assert.equal(r.rows.length, want.length, `${key}: one row per skeleton`);
    r.rows.forEach((row, i) => {
      for (let j = 0; j < 9; j++) if (Math.abs(row[j] - want[i][j]) > ((j === 5 || j === 8) ? 1e-6 : 0)) diffs.push(`${i}.${j}`);
      if (o.shortestPath) {
        if (Math.abs(r.sp[i].length - want[i][9]) > 1e-6 || r.sp[i].x !== want[i][10] || r.sp[i].y !== want[i][11]) diffs.push(`sp:${i}`);
      }
    });
    const tagged = c.result.created.find((x) => x.title === 'Tagged skeleton');
    if (tagged) { const tw = u8(tagged.image); for (let i = 0; i < tw.length; i++) if (tw[i] !== r.tagged[i]) { diffs.push('tagged'); break; } }
    const pw = c.result.created.find((x) => x.title === 'Longest shortest paths');
    if (pw) { const tw = u8(pw.image); for (let i = 0; i < tw.length; i++) if (tw[i] !== r.paths[i]) { diffs.push('paths'); break; } }
    // "Show detailed info": Fiji's Branch information table. The same branches with the same length / Euclidean distance / end points are listed
    // (compared as a multiset: the end points unordered); what differs, and is documented in About: Fiji's row order, which end is V1, and the
    // "running average length" column (the port's is the mean of the lengths listed so far in ITS order)
    if (o.detailed && c.namedTables && c.namedTables['Branch information'] && c.name !== 'default' && !diffs.some((x) => /^\d+\.\d+$/.test(x))) {   // (not where the cycle pruning chose another cut)
      const bt = c.namedTables['Branch information'].rows;
      assert.equal(r.branchRows.length, bt.length, `${key}: one Branch information row per branch`);
      const keyOf = (row) => [row[0], row[1].toFixed(5), row[8].toFixed(5), [row[2] + ',' + row[3], row[5] + ',' + row[6]].sort().join('/'), row[10], row[11]].join('|');
      assert.deepEqual([...r.branchRows.map(keyOf)].sort(), bt.map(keyOf).sort(), `${key}: the branches of the Branch information table`);
      branchTables++;
    }
    // "Display labeled skeletons": a 32-bit "<title>-labeled-skeletons" with the tree number of every skeleton voxel
    const lab = c.result.created.find((x) => /labeled-skeletons$/.test(x.title));
    assert.equal(!!lab, o.labeled, `${key}: the labeled image appears exactly when asked`);
    if (lab) {
      const lb = Buffer.from(lab.image.data.b64, 'base64'), lf = new Float32Array(lb.buffer.slice(lb.byteOffset, lb.byteOffset + lb.byteLength));
      assert.equal(lab.image.bitDepth, 32);
      for (let i = 0; i < lf.length; i++) if (lf[i] !== r.labeled[i]) { diffs.push('labeled'); break; }
    }
    const after = u8(c.result.self), expect = o.prune !== 'none' || o.pruneEnds ? r.pruned : data;
    for (let i = 0; i < after.length; i++) if ((after[i] !== 0) !== (expect[i] !== 0)) { diffs.push('pruned'); break; }
    assert.equal(diffs.join(' '), DEVIATIONS[key] || '', `${key}: ${DEVIATIONS[key] ? 'the known differences changed' : 'must be exact'}`);
    if (DEVIATIONS[key]) deviating++; else exact++;
    // the table that is exact stays exact for the options that do not prune cycles
  }
}
assert.ok(branchTables >= 16, 'Branch information compared for ' + branchTables + ' runs');
assert.equal(exact + deviating, 36);
assert.ok(exact >= 24, 'at least 24 of the 36 runs are exact: ' + exact);

// ── 2. by hand: classification, junctions, branches, lengths ──
const img = (rows) => { const h = rows.length, w = rows[0].length, a = new Uint8Array(w * h); rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === '#') a[y * w + x] = 255; })); return { a, w, h }; };
const go = (rows, o) => { const { a, w, h } = img(rows); return SK.analyze(a, w, h, Object.assign({ prune: 'none' }, o || {})); };
{
  // a single pixel: one tree, one end-point, no branch
  const r = await go(['...', '.#.', '...']);
  assert.deepEqual(plain(r.rows), [[0, 0, 1, 0, 0, 0, 0, 0, 0]]);
  // two touching pixels: a branch without any slab, length 1
  const r2 = await go(['....', '.##.', '....']);
  assert.deepEqual(plain(r2.rows), [[1, 0, 2, 0, 0, 1, 0, 0, 1]]);
  // a straight line of 6: 2 end-points, 4 slabs, one branch of length 5; a diagonal is √2 a step
  const r3 = await go(['........', '.######.', '........']);
  assert.deepEqual(plain(r3.rows), [[1, 0, 2, 0, 4, 5, 0, 0, 5]]);
  const r4 = await go(['#....', '.#...', '..#..', '...#.']);
  assert.ok(Math.abs(r4.rows[0][8] - 3 * Math.SQRT2) < 1e-12);
  // a plus sign with arms of 3: the centre and its four neighbours touch, so they are ONE junction of 5 voxels; each arm is end - slab - junction voxel
  const r5 = await go(['...#...', '...#...', '...#...', '#######', '...#...', '...#...', '...#...']);
  assert.deepEqual(plain(r5.rows[0].slice(0, 5)), [4, 1, 4, 5, 4]);
  assert.equal(r5.rows[0][6], 0); assert.equal(r5.rows[0][7], 1, 'one quadruple point');
  // the junction is located at its first voxel in column order, (2, 3): the arm from (0, 3) is 2 long, the one from (6, 3) is 2 + 2 (it crosses the junction)
  assert.ok(Math.abs(r5.rows[0][8] - 4) < 1e-12, 'the longest arm: ' + r5.rows[0][8]);
  // a T: a triple point
  const r6 = await go(['#####', '..#..', '..#..']);
  assert.equal(r6.rows[0][6], 1); assert.equal(r6.rows[0][7], 0);
  // the tags: end 30, junction 70, slab 127
  const T = SK.TAGS;
  assert.deepEqual([T.END, T.JUNCTION, T.SLAB, T.PATH], [30, 70, 127, 96]);
  const t = (await go(['#####', '..#..', '..#..'])).tagged;
  assert.equal(t[2], 70); assert.equal(t[0], 30); assert.equal(t[1], 70, 'the voxel next to the stem touches three others');
  const tl = (await go(['.....', '.###.', '.....'])).tagged;
  assert.equal(tl[6], 30); assert.equal(tl[7], 127); assert.equal(tl[8], 30);
  // a closed ring of slabs with no vertex (a diamond): one branch whose length is the whole perimeter, 8 diagonal steps
  const diamond = ['..#..', '.#.#.', '#...#', '.#.#.', '..#..'];
  const ring = await go(diamond);
  assert.deepEqual(plain(ring.rows[0].slice(0, 5)), [1, 0, 0, 0, 8]);
  assert.ok(Math.abs(ring.rows[0][5] - 8 * Math.SQRT2) < 1e-12);
  // Prune cycles: the ring is cut at ONE voxel → a line of 7 voxels with two end-points
  for (const m of ['shortest', 'lowestVoxel', 'lowestBranch']) {
    const cut = await go(diamond, { prune: m });
    assert.deepEqual(plain(cut.rows[0].slice(0, 5)), [1, 0, 2, 0, 5], m);
    assert.equal(Array.from(cut.pruned).filter((v) => v).length, 7);
  }
  // calibration scales every length (and only them)
  const cal = await go(['........', '.######.', '........'], { pixelWidth: 0.5, pixelHeight: 0.5 });
  assert.equal(cal.rows[0][5], 2.5); assert.equal(cal.rows[0][4], 4);
  const aniso = await go(['.#.', '.#.', '.#.'], { pixelWidth: 1, pixelHeight: 3 });
  assert.equal(aniso.rows[0][5], 6);
  // two skeletons are two rows, found from the end-points in column order
  const two = await go(['#.....', '#..###', '#.....'], { shortestPath: true });
  assert.equal(two.rows.length, 2); assert.equal(two.rows[0][4], 1); assert.equal(two.rows[1][4], 1);
  assert.equal(two.sp[0].length, 2); assert.equal(two.sp[1].length, 2);
}

// ── 2b. cycle pruning cancels and reports progress: a lattice of 128 x 128 has ~230 cycles ──
{
  const w = 128, h = 128, lat = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 8) for (let x = 0; x < w; x++) lat[y * w + x] = 255;
  for (let x = 0; x < w; x += 8) for (let y = 0; y < h; y++) lat[y * w + x] = 255;
  let checks = 0, ticks = 0;
  const ok = await SK.analyze(lat, w, h, { prune: 'shortest' }, { check() { checks++; }, async tick() { ticks++; } });
  assert.ok(ok.cycleCuts > 200, 'the lattice has many cycles: ' + ok.cycleCuts);
  assert.ok(checks >= 8 && ticks >= 8, `check / tick during the pruning: ${checks} / ${ticks}`);
  let n = 0;
  await assert.rejects(SK.analyze(lat, w, h, { prune: 'shortest' }, { check() { if (++n === 9) throw Object.assign(new Error('cancelled'), { code: 'IJ_CANCELLED' }); }, async tick() {} }), (e) => e.code === 'IJ_CANCELLED');
  assert.equal(Array.from(lat).filter((v) => v === 255).length, 2 * 16 * 128 - 16 * 16, 'the input is untouched');
}

// ── 3. Prune ends and the table; Exclude ROI ──
{
  // an H: each side is one junction of 4 voxels (the 3 voxels of the column that touch the bar + the bar's first voxel), 4 end arms of one
  // voxel each and a bar of one slab voxel. Prune ends removes the four arms and keeps the junction voxels and the bar
  const rows = ['#...#', '#...#', '#####', '#...#', '#...#'];
  const full = await go(rows);
  assert.deepEqual(plain(full.rows[0].slice(0, 5)), [5, 2, 4, 8, 1]);
  assert.equal(full.rows[0][6], 2, 'both junctions have three branches');
  const pruned = await go(rows, { pruneEnds: true });
  assert.deepEqual(plain(pruned.rows[0].slice(0, 5)), [5, 2, 0, 8, 1], 'the branches and junctions are those of the unpruned graph, the voxels are what is left');
  assert.equal(pruned.rows[0][6], 0, 'no junction has three branches any more');
  assert.equal(pruned.rows[0][5], full.rows[0][5], 'the lengths are the unpruned graph');
  const left = Array.from(pruned.pruned).filter((v) => v).length;
  assert.equal(left, 9, 'the two junctions and the bar');
  // excluding a selection from the pruning keeps the end branch whose end-point is inside it
  const inRoi = (pix) => pix % 5 === 0 && Math.floor(pix / 5) < 2;   // the top-left end-point's column
  const keep = await SK.analyze(img(rows).a, 5, 5, { prune: 'none', pruneEnds: true, excludeRoi: true }, null, inRoi);
  assert.equal(keep.rows[0][2], 1, 'one end-point stays');
  assert.ok(Array.from(keep.pruned).filter((v) => v).length > left);
  // the same selection is ignored when Exclude ROI is off
  const ign = await SK.analyze(img(rows).a, 5, 5, { prune: 'none', pruneEnds: true, excludeRoi: false }, null, inRoi);
  assert.equal(ign.rows[0][2], 0);
}

// ── 4. the Branch information table and the shortest path ──
{
  const d = await go(['#....', '#.###', '#....'], { detailed: true });
  void d;
  const t = await go(['#######', '...#...', '...#...', '...#...'], { detailed: true, shortestPath: true });
  assert.deepEqual(plain(t.rows[0].slice(0, 5)), [3, 1, 3, 4, 3]);
  assert.equal(t.branchRows.length, 3);
  assert.equal(t.branchRows[0].length, 12);
  assert.equal(t.branchRows[0][0], 1, 'Skeleton ID');
  // the junction is at its first voxel (2, 0): arms 2, 2 + 2 (it crosses the junction) and 2 + √2
  const lens = t.branchRows.map((r) => r[1]).sort((a, b) => a - b);
  assert.ok(Math.abs(lens[0] - 2) < 1e-12 && Math.abs(lens[1] - (2 + Math.SQRT2)) < 1e-12 && Math.abs(lens[2] - 4) < 1e-12, lens.join(' '));
  const total = lens[0] + lens[1] + lens[2];
  assert.ok(Math.abs(total / 3 - t.rows[0][5]) < 1e-12, 'the average branch length is the mean of the table');
  assert.ok(Math.abs(t.branchRows[2][9] - total / 3) < 1e-12, 'running average length of the last row');
  assert.equal(t.branchRows[0][8] > 0, true, 'Euclidean distance between the two vertices');
  // the longest shortest path: the right arm and the stem (4 + 2 + √2); its picture marks only the slab voxels (96) of the two branches
  assert.ok(Math.abs(t.sp[0].length - (4 + 2 + Math.SQRT2)) < 1e-12, 'longest shortest path ' + t.sp[0].length);
  assert.equal(Array.from(t.paths).filter((v) => v === 96).length, 2);
  assert.equal(Array.from(t.paths).filter((v) => v === 255).length, 10 - 2);
}

// ── 5. the operations ──
{
  const spec = reg.get('analyzeSkeleton'), tagged = reg.get('skeletonTagged');
  assert.equal(spec.kind, 'compute'); assert.equal(tagged.kind, 'newdoc'); assert.deepEqual(plain(spec.bitDepths), [8]);
  for (const bad of [null, { prune: 'x' }, { prune: 'none', pruneEnds: 'yes' }, { prune: 'none', pixelWidth: 0 }]) assert.throws(() => spec.validate(bad), (e) => e.code === 'IJ_BAD_ARGS');
  const { a, w, h } = img(['#####', '..#..', '..#..']);
  const view = Object.freeze({ id: 'd', name: 'skel.tif', width: w, height: h, bitDepth: 8, active: 0, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'px' }, channels: [{ data: a }] });
  const io = { channel: 0, tick: async () => {}, check() {}, reserve() {}, roiMask: () => null };
  const res = await spec.run(view, { prune: 'none', shortestPath: true, detailed: true }, null, io);
  assert.equal(res.columns.length, 13); assert.equal(res.columns[9], 'Longest Shortest Path'); assert.deepEqual(plain(res.columns.slice(10)), ['spx', 'spy', 'spz']);
  assert.equal(res.rows[0].length, 13); assert.ok(res.branchRows && res.branchColumns.length === 12);
  const docs = await tagged.run(view, { prune: 'shortest', pruneEnds: true, shortestPath: true, labeled: true }, null, io);
  assert.deepEqual(plain(docs.map((x) => x.name)), ['Tagged skeleton', 'Longest shortest paths', 'skel-labeled-skeletons', 'skel-pruned']);
  assert.equal(docs[2].bitDepth, 32); assert.equal(docs[0].bitDepth, 8);
  const empty = Object.freeze({ id: 'e', name: 'e', width: 3, height: 3, bitDepth: 8, active: 0, channels: [{ data: new Uint8Array(9) }] });
  await assert.rejects(spec.run(empty, { prune: 'none' }, null, io), (e) => e.code === 'IJ_FIJI_NO_SKELETON');
  // never writes into its input
  assert.deepEqual(Array.from(a), Array.from(img(['#####', '..#..', '..#..']).a));
  // a cancel in the middle of a big analysis
  const W = 40000, big = new Uint8Array(W * 4);
  for (let x = 0; x < W; x++) big[W + x] = 255;
  const stop = () => { throw Object.assign(new Error('c'), { code: 'IJ_CANCELLED' }); };
  await assert.rejects(SK.analyze(big, W, 4, { prune: 'none', shortestPath: true }, { check() {}, async tick() { stop(); } }), (e) => e.code === 'IJ_CANCELLED');
  await assert.rejects(SK.analyze(big, W, 4, { prune: 'none' }, { check: stop, async tick() {} }), (e) => e.code === 'IJ_CANCELLED');
}

// ── 6. a long skeleton is analysed in time (no recursion, no quadratic step) ──
{
  const W = 3000, H = 3, line = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) line[W + x] = 255;
  const t0 = Date.now();
  const r = await SK.analyze(line, W, H, { prune: 'none' });
  assert.deepEqual(plain(r.rows[0].slice(0, 5)), [1, 0, 2, 0, W - 2]); assert.equal(r.rows[0][5], W - 1);
  assert.ok(Date.now() - t0 < 3000, 'a 3000-voxel line: ' + (Date.now() - t0) + ' ms');
}

console.log(`ij fiji skeleton: OK (${exact} of 36 Fiji runs exact, ${deviating} with the documented differences)`);

// ── 5. Fiji runs on skeletons with distinct intensities (fixture fiji/skeleton_valued.json: 24 graph × pattern runs) ──
// The voxel a lowest-intensity method cuts is the minimum of the mean of three consecutive voxels of its branch: every cut Fiji made is a cut of the
// port, in 24 of 24 voxel runs. What stays different (pinned): Fiji's "lowest intensity voxel" stops after fewer cuts on the lattices (graph 1, 3),
// and its "lowest intensity branch" visits the cycles in another order there.
{
  const vp = JSON.parse(readFileSync(path.join(FX, '..', 'skeleton_valued.json'), 'utf8'));
  let voxelSubset = 0, voxelRuns = 0, countsEqual = 0;
  const countDiff = [];
  for (const c of vp.runs) {
    const g = JSON.parse(readFileSync(path.join(FX, 'graph' + c.g + '.json'), 'utf8')), data = u8(g.input), w = g.input.width, h = g.input.height;
    const v = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[y * w + x]) v[y * w + x] = c.pat === 0 ? 40 + ((x * 31 + y * 17) % 200) : c.pat === 1 ? 40 + ((x * 7 + y * 53) % 211) : 255 - ((x * 13 + y * 29) % 190);
    const r = await SK.analyze(v, w, h, { prune: c.m });
    const port = new Set();
    for (let i = 0; i < w * h; i++) if (v[i] && !r.pruned[i]) port.add((i % w) + ':' + Math.floor(i / w));
    const fiji = c.removed.split(' ').filter(Boolean);
    if (c.m === 'lowestVoxel') { voxelRuns++; if (fiji.every((q) => port.has(q))) voxelSubset++; }
    if (r.rows[0].slice(0, 5).every((x, j) => x === c.row[j])) countsEqual++; else countDiff.push(`g${c.g}p${c.pat}${c.m === 'lowestVoxel' ? 'V' : 'B'}`);
    if (c.g === 0 || c.g === 2) assert.equal(r.rows[0].slice(0, 5).join('/'), c.row.slice(0, 5).join('/'), `graph ${c.g} pattern ${c.pat} ${c.m}: the counts are Fiji's`);
    if (c.g === 0) assert.equal([...port].sort().join(' '), fiji.sort().join(' '), `graph 0 pattern ${c.pat} ${c.m}: the same voxel`);
  }
  assert.equal(voxelRuns, 12);
  assert.equal(voxelSubset, 12, 'every voxel Fiji cut with "lowest intensity voxel" is cut here too');
  assert.equal(countDiff.join(' '), 'g1p0V g1p0B g1p1V g1p1B g1p2V g1p2B g3p0V g3p0B g3p2V g3p2B', 'the counts that differ (pinned)');
}
