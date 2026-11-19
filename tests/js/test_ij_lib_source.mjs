// IJLibSource (ij-proc-lib.js): the pure rules of Open from Library — the bundle writer's info block, the µm mapping of dataset slices
// to TIFF planes, what makes a TIFF usable for a dataset (extent, frame, plan), names, session keys and the source of a stored session.
//
// Run: node tests/js/test_ij_lib_source.mjs
import assert from 'node:assert/strict';
import loose from 'node:assert';
import { loadLib, buildTiff, imagej } from './ij_lib_support.mjs';

const ctx = loadLib();
const { IJLibSource, IJProject } = ctx;
let passed = 0;
// the library lives in a vm context: its arrays and objects have another realm's prototypes (loose deepEqual ignores them)
const deepEq = (a, b, m) => loose.deepEqual(a, b, m);
const test = (name, fn) => { fn(); passed++; };

// the text tools/build_download_bundles.py:tiff_info writes (quoted from the writer)
const INFO = (level, frame) => ['Dataset: E8-1', `Source: Imaris .ims ResolutionLevel ${level}, native uint16` + (frame ? `, timepoint ${frame[0]} of 0..${frame[1] - 1}` : ''),
  'Voxel size (um): X=1.2 Y=1.2 Z=2.5', 'Channels: C1=DAPI, C2=GFP', 'Voxel values are the raw acquisition intensities.', 'Lumen3D / IRIBHM Microscopy Platform'].join('\n');

test('the info block: resolution level, frame of a timelapse, voxel size', () => {
  assert.equal(IJLibSource.tiffLevelOf(INFO(2)), 2);
  assert.equal(IJLibSource.tiffLevelOf('no level here'), null);
  assert.equal(IJLibSource.tiffLevelOf(null), null);
  deepEq(IJLibSource.tiffFrameOf(INFO(1, [7, 40])), { frame: 7, count: 40 });
  assert.equal(IJLibSource.tiffFrameOf(INFO(1)), null);
  deepEq(IJLibSource.tiffVoxelOf(INFO(1)), { x: 1.2, y: 1.2, z: 2.5 });
  assert.equal(IJLibSource.tiffVoxelOf('Voxel size: uncalibrated (no extent/unit in the .ims)'), null);
});

test('tiffZRange: one plane takes the TIFF plane holding its centre, a range every plane it touches', () => {
  const R = (first, last, vz0, vzT, slices) => IJLibSource.tiffZRange({ first, last, vz0, vzT, slices });
  // same z sampling
  deepEq(R(3, 3, 2, 2, 10), { jlo: 3, jhi: 3, single: true });
  deepEq(R(3, 7, 2, 2, 10), { jlo: 3, jhi: 7, single: false });
  // a TIFF twice as coarse in z: dataset planes 4..5 are µm [8,12) = TIFF plane 2
  deepEq(R(4, 5, 2, 4, 10), { jlo: 2, jhi: 2, single: false });
  deepEq(R(4, 4, 2, 4, 10), { jlo: 2, jhi: 2, single: true });
  deepEq(R(5, 5, 2, 4, 10), { jlo: 2, jhi: 2, single: true }, 'centre 11 µm is in [8,12)');
  deepEq(R(5, 6, 2, 4, 10), { jlo: 2, jhi: 3, single: false }, 'µm [10,14) touches planes 2 and 3');
  // a TIFF twice as fine in z
  deepEq(R(2, 3, 4, 2, 20), { jlo: 4, jhi: 7, single: false });
  deepEq(R(2, 2, 4, 2, 20), { jlo: 5, jhi: 5, single: true }, 'centre 10 µm → plane 5');
  // clamped
  deepEq(R(0, 99, 2, 2, 10), { jlo: 0, jhi: 9, single: false });
  deepEq(R(99, 99, 2, 2, 10), { jlo: 9, jhi: 9, single: true });
  // float noise on a boundary never adds a plane: 3 × 0.4 / 0.4 is 3.0000000000000004
  deepEq(R(3, 5, 0.4, 0.4, 20), { jlo: 3, jhi: 5, single: false });
  deepEq(R(0, 0.29 === 0 ? 0 : 6, 0.1, 0.1, 20).jhi, 6);
  // metadata.json's 6-decimal z step against the TIFF's full double (E95-1: 4.652059 vs 4.652059326175001): slices 90..109 are 20 planes
  deepEq(R(90, 109, 4.652059, 4.652059326175001, 200), { jlo: 90, jhi: 109, single: false });
  deepEq(R(199, 199, 4.652059, 4.652059326175001, 200), { jlo: 199, jhi: 199, single: true });
  // a degenerate ratio keeps the whole stack
  deepEq(R(1, 2, 0, 2, 10), { jlo: 0, jhi: 9, single: false });
});

test('tiffRangeOf: without a physical z the TIFF is taken stack to stack', () => {
  const facts = { vz0: null, vzT: null, slices: 10 };
  deepEq(IJLibSource.tiffRangeOf(facts, 20, 0, 19), { jlo: 0, jhi: 9, single: false });
  deepEq(IJLibSource.tiffRangeOf(facts, 20, 10, 11), { jlo: 5, jhi: 5, single: false });
  deepEq(IJLibSource.tiffRangeOf({ vz0: 2, vzT: 2, slices: 10 }, 10, 2, 4), { jlo: 2, jhi: 4, single: false });
});

const physical = { x: 614.4, y: 614.4, z: 100, calibrated: true };       // 512 px at 1.2 µm, 40 slices of 2.5 µm
const dims = { x: 512, y: 512, z: 40 };
const mk = (over, ij) => buildTiff(Object.assign({ w: 8, h: 8, pages: 6, bits: 16, resolution: { x: 1 / 76.8, y: 1 / 76.8, unit: 1 }, imagej: imagej(Object.assign({ channels: 2, slices: 3, spacing: 2.5, info: INFO(1), labels: ['DAPI', 'GFP'], colors: ['#0000ff', '#00ff00'], ranges: [0, 4000, 10, 3000] }, ij || {})) }, over || {}));

test('tiffFacts: a usable bundle TIFF — plan, calibration, channels, z mapping, bit depth', () => {
  const t = mk();
  // 8 px × 76.8 µm = 614.4 µm: the TIFF covers the volume's field
  const f = IJLibSource.tiffFacts(t.index, { physicalUm: physical, dims, live: false, timepoint: null });
  assert.equal(f.ok, true);
  deepEq([f.width, f.height, f.slices, f.channels, f.bitDepth, f.level, f.frame], [8, 8, 3, 2, 16, 1, 0]);
  assert.ok(Math.abs(f.pixelUm.x - 76.8) < 1e-9);
  deepEq(f.names, ['DAPI', 'GFP']);
  deepEq(f.colors, ['#0000ff', '#00ff00']);
  assert.equal(f.coarser, true, '8×8 against 512×512');
  assert.ok(Math.abs(f.vz0 - 2.5) < 1e-12 && f.vzT === 2.5, 'vz0 = physical z / dims z, vzT = the ImageJ spacing');
});

test('tiffFacts: refusals — extent, frame, unsupported', () => {
  const t = mk();
  // a TIFF of another field of view
  const far = IJLibSource.tiffFacts(t.index, { physicalUm: { x: 700, y: 700, z: 100, calibrated: true }, dims });
  deepEq([far.ok, far.reason], [false, 'extent']);
  // within one TIFF pixel is accepted
  assert.equal(IJLibSource.tiffFacts(t.index, { physicalUm: { x: 614.4 + 70, y: 614.4, z: 100, calibrated: true }, dims }).ok, true);
  // an uncalibrated dataset (voxel counts) is not compared
  assert.equal(IJLibSource.tiffFacts(t.index, { physicalUm: { x: 512, y: 512, z: 40, calibrated: false }, dims }).ok, true);
  // a timelapse: the bundle TIFF holds one frame, named in its info
  const live = mk({}, { info: INFO(1, [4, 10]) });
  assert.equal(IJLibSource.tiffFacts(live.index, { physicalUm: physical, dims, live: true, timepoint: 4 }).ok, true);
  assert.equal(IJLibSource.tiffFacts(live.index, { physicalUm: physical, dims, live: true, timepoint: 5 }).reason, 'frame');
  assert.equal(IJLibSource.tiffFacts(t.index, { physicalUm: physical, dims, live: true, timepoint: 0 }).reason, 'frame', 'no frame in the info of a timelapse TIFF: disabled');
  // a TIFF with several frames is indexed by t
  const multi = buildTiff({ w: 8, h: 8, pages: 6, bits: 8, imagej: imagej({ channels: 1, slices: 2, frames: 3, info: '' }) });
  assert.equal(IJLibSource.tiffFacts(multi.index, { physicalUm: null, dims: null, live: true, timepoint: 2 }).frame, 2);
  assert.equal(IJLibSource.tiffFacts(multi.index, { physicalUm: null, dims: null, live: true, timepoint: 3 }).reason, 'frame');
  // the stream cannot read it
  const bad = IJLibSource.tiffFacts({ ...t.index, compression: 5 }, { physicalUm: physical, dims });
  deepEq([bad.ok, bad.reason, bad.code], [false, 'unsupported', 'IJ_LIB_TIFF_UNSUPPORTED']);
});

test('tiffFacts: no resolution tag — the pixel size comes from the voxel line of the info, else from the volume', () => {
  const noRes = mk({ resolution: null });
  const f = IJLibSource.tiffFacts(noRes.index, { physicalUm: { x: 9.6, y: 9.6, z: 100, calibrated: true }, dims: { x: 8, y: 8, z: 40 } });
  assert.equal(f.ok, true);
  deepEq(f.pixelUm, { x: 1.2, y: 1.2 }, 'Voxel size (um) of the info block');
  // and with neither: the volume's own field (self-consistent, so never refused)
  const bare = mk({ resolution: null }, { info: '' });
  const g = IJLibSource.tiffFacts(bare.index, { physicalUm: physical, dims });
  assert.equal(g.ok, true);
  assert.ok(Math.abs(g.pixelUm.x - 614.4 / 8) < 1e-9);
  assert.equal(IJLibSource.tiffFacts(bare.index, { physicalUm: null, dims: null }).pixelUm, null, 'nothing to calibrate with');
});

test('tiffFacts: a photograph — its pages are channels, a chunky RGB page is three', () => {
  const comp = buildTiff({ w: 6, h: 4, pages: 3, bits: 8, imagej: imagej({ channels: 3, slices: 1, spacing: 1, info: '', extra: { unit: '' } }), resolution: { x: 100, y: 100, unit: 3 } });
  const f = IJLibSource.tiffFacts(comp.index, { physicalUm: null, dims: { x: 6, y: 4, z: 1 }, asChannels: true });
  deepEq([f.ok, f.channels, f.slices], [true, 3, 1]);
  assert.ok(Math.abs(f.pixelUm.x - 100) < 1e-9, '100 pixels per cm = 100 µm per pixel');
  // no ImageJ block: three pages = three channels
  const plain = buildTiff({ w: 6, h: 4, pages: 3, bits: 8 });
  const p = IJLibSource.tiffFacts(plain.index, { physicalUm: null, dims: null, asChannels: true });
  deepEq([p.channels, p.slices], [3, 1]);
  assert.equal(IJLibSource.tiffFacts(plain.index, { physicalUm: null, dims: null }).slices, 3, 'without asChannels the pages are slices');
  // chunky RGB
  const rgb = buildTiff({ w: 6, h: 4, pages: 1, bits: 8, spp: 3 });
  const r = IJLibSource.tiffFacts(rgb.index, { physicalUm: null, dims: null, asChannels: true });
  deepEq([r.channels, r.names, r.colors], [3, ['R', 'G', 'B'], ['#ff0000', '#00ff00', '#0000ff']]);
  deepEq(IJLibSource.planFor(plain.index, true).channels, 3);
  // the Leica / Bio-Formats composites label every page with the acquisition's name: C1, C2, C3
  const leica = buildTiff({ w: 6, h: 4, pages: 3, bits: 8, imagej: imagej({ channels: 3, slices: 1, info: '', labels: ['c:1/3 - E7.75 x3.2', 'c:2/3 - E7.75 x3.2', 'c:3/3 - E7.75 x3.2'] }) });
  deepEq(IJLibSource.tiffFacts(leica.index, { physicalUm: null, dims: null }).names, ['C1', 'C2', 'C3']);
  const named = buildTiff({ w: 6, h: 4, pages: 2, bits: 8, imagej: imagej({ channels: 2, slices: 1, info: '', labels: ['c:1/2 - DAPI', 'c:2/2 - GFP'] }) });
  deepEq(IJLibSource.tiffFacts(named.index, { physicalUm: null, dims: null }).names, ['DAPI', 'GFP']);
  // ImageJ default colours without LUTs
  const noColors = buildTiff({ w: 6, h: 4, pages: 4, bits: 8, imagej: imagej({ channels: 4, slices: 1, info: '' }) });
  deepEq(IJLibSource.tiffFacts(noColors.index, { physicalUm: null, dims: null }).colors, ['#ff0000', '#00ff00', '#0000ff', '#ffffff']);
  deepEq(IJLibSource.tiffFacts(noColors.index, { physicalUm: null, dims: null }).names, ['C1', 'C2', 'C3', 'C4']);
});

test('pagesFor / readBytes: the pages of a read, a chunky page once, bytes from the strip tables', () => {
  const t = mk();                                              // 2 channels × 3 slices, channels fastest
  const f = IJLibSource.tiffFacts(t.index, { physicalUm: physical, dims });
  deepEq(IJLibSource.pagesFor(f.plan, 1, 2, 0, [0, 1]), [2, 3, 4, 5]);
  deepEq(IJLibSource.pagesFor(f.plan, 0, 0, 0, [1]), [1]);
  const total = IJLibSource.readBytes(f.plan, 0, 2, 0, [0, 1]);
  assert.equal(total, t.counts.reduce((a, b) => a + b, 0));
  assert.equal(IJLibSource.readBytes(f.plan, 0, 0, 0, [0]), t.counts.slice(0, t.strips).reduce((a, b) => a + b, 0));
  const rgb = IJLibSource.tiffFacts(buildTiff({ w: 6, h: 4, pages: 2, bits: 8, spp: 3 }).index, { physicalUm: null, dims: null });
  deepEq(IJLibSource.pagesFor(rgb.plan, 0, 1, 0, [0, 1, 2]), [0, 1], 'one page per z, whatever the channels');
});

test('names, keys, sources', () => {
  assert.equal(IJLibSource.projectionTitle('max', 'E8-1 z 0-9'), 'MAX_E8-1 z 0-9');
  deepEq(IJLibSource.METHODS.map((m) => IJLibSource.projectionTitle(m, 'x')), ['AVG_x', 'MAX_x', 'MIN_x', 'SUM_x', 'STD_x', 'MED_x']);
  const base = { datasetId: '3d/E8-1', treeKey: 'tk', timepoint: null, level: 0, method: 'avg', input: 'tiff', stamp: 'abc' };
  assert.equal(IJLibSource.sessionKey({ ...base, mode: 'z', first: 3, last: 9 }), 'lib|3d/E8-1|tk||z:3-9|0|avg|tiff|abc');
  assert.equal(IJLibSource.sessionKey({ ...base, mode: 'oblique', timepoint: 2, input: 'processed', spec: { yaw: 10, pitch: -5, roll: 0, depth: 0.5, thickness: 4, projection: 'max' } }),
    'lib|3d/E8-1|tk|2|obl:10,-5,0,0.5,4,max|0|avg|processed|abc');
  assert.equal(IJLibSource.sourceOfKey('3d/E8-1|tk||z|0-9|tiff|f.tif|max|1-5|x', '3d/E8-1|tk||z|0-9'), 'tiff');
  assert.equal(IJLibSource.sourceOfKey('3d/E8-1|tk||z|0-9|0|max|1-5|x', '3d/E8-1|tk||z|0-9'), 'processed');
});

test('output bit depth follows the TIFF (IJProject.outputBitDepth)', () => {
  assert.equal(IJProject.outputBitDepth('max', 5, 16), 16);
  assert.equal(IJProject.outputBitDepth('min', 5, 16), 16);
  assert.equal(IJProject.outputBitDepth('avg', 5, 16), 16);
  assert.equal(IJProject.outputBitDepth('sum', 5, 16), 32);
  assert.equal(IJProject.outputBitDepth('sd', 5, 8), 32);
  assert.equal(IJProject.outputBitDepth('median', 5, 8), 8);
  assert.equal(IJProject.outputBitDepth('median', 5, 16), 32);
  assert.equal(IJProject.outputBitDepth('max', 5), 8, 'without the input depth: the legacy rule of the processed volume');
});

console.log('test_ij_lib_source: ' + passed + ' groups passed');
