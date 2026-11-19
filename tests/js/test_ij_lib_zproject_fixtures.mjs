// doc.tiff.project (ij-proc-lib.js) against the recorded outputs of ImageJ 1.54p's ZProjector (tests/fixtures/ij-wave3/lib/zproject_*.json):
// each stack is written as a synthetic TIFF (one page per slice, deflate + predictor for the integer depths), read back through the real
// command (Range requests, strip bands, IJProject at the TIFF's bit depth) and compared with what ImageJ gave: the bit depth and every pixel
// of every recorded method / range. Band size and page arrival order do not change a byte (whole-page bands and 1-row bands).
//
// Run: node tests/js/test_ij_lib_zproject_fixtures.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';
import { loadLib, buildTiff, imagej, host, makeE, callCommand } from './ij_lib_support.mjs';

const ctx = loadLib();
const DIR = path.join(ROOT, 'tests', 'fixtures', 'ij-wave3', 'lib');

// a fixture array: a plain list (null = NaN) or { b64 } of the stated bit depth
function values(v, bitDepth) {
  if (Array.isArray(v)) return v.map((x) => (x === null ? NaN : x));
  const buf = Buffer.from(v.b64, 'base64');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  return Array.from(bitDepth === 8 ? new Uint8Array(ab) : bitDepth === 16 ? new Uint16Array(ab) : new Float32Array(ab));
}
const same = (a, b) => a === b || (a !== a && b !== b);

let runs = 0, files = 0;
async function replay(name, stack, cases) {
  const W = stack[0].width, H = stack[0].height, bits = stack[0].bitDepth;
  const planes = stack.map((p) => values(p.data, bits));
  for (const rowsPerStrip of [H, 1]) {                                  // whole-page bands, then one row at a time
    const t = buildTiff({ w: W, h: H, pages: stack.length, bits, rowsPerStrip, compression: bits === 32 ? 'none' : 'deflate', predictor: bits === 32 ? 1 : 2,
      imagej: imagej({ channels: 1, slices: stack.length, spacing: 1, ranges: [], colors: [], labels: [], info: '' }), pixel: (p, x, y) => planes[p][y * W + x] });
    const h = host(t.file);
    for (const c of cases) {
      const E = makeE({ fetchImpl: h.fetchImpl });
      await callCommand(ctx, 'doc.tiff.project', { url: t.index.url, index: t.index, z0: c.params.start - 1, z1: c.params.stop - 1, frame: 0, method: c.params.method, name: 'Z',
        calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, provenance: {}, sessionKey: 'lib|fx', channels: [{ c: 0, name: 'A', color: '#ffffff' }] }, E);
      const img = E.rec.docs[0].image;
      const where = `${name} ${c.params.method} ${c.params.start}-${c.params.stop} (rows/strip ${rowsPerStrip})`;
      assert.equal(img.bitDepth, c.bitDepth, where + ': bit depth');
      const want = values(c.output.data, c.output.bitDepth || c.bitDepth).map((v) => (c.bitDepth === 32 ? Math.fround(v) : v));      // float32 values printed in decimal
      assert.equal(img.channels[0].data.length, want.length, where + ': size');
      for (let i = 0; i < want.length; i++) {
        const g = img.channels[0].data[i];
        if (!same(g, want[i])) assert.fail(`${where}: pixel ${i} is ${g}, ImageJ gave ${want[i]}`);
      }
      runs++;
    }
  }
}

for (const f of fs.readdirSync(DIR).filter((n) => /^zproject_.*\.json$/.test(n)).sort()) {
  const fx = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  if (fx.groups) for (const [i, g] of fx.groups.entries()) await replay(f + '#' + i, g.stack, g.cases);
  else await replay(f, fx.stack, fx.cases);
  files++;
}
assert.ok(files >= 6 && runs >= 100, 'every recorded fixture ran: ' + files + ' files, ' + runs + ' runs');
console.log(`test_ij_lib_zproject_fixtures: ${files} fixtures, ${runs} ImageJ outputs matched`);
