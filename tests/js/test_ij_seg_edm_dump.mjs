// Helper of tests/test_ij_seg_scipy.py: writes random binary masks and the Euclidean distance maps the Advanced Studio
// computes for them (ij-proc-seg.js IJSeg.edmFloat = ImageJ's EDM, float) into the directory given as argument, so Python
// can compare them with scipy.ndimage.distance_transform_edt. Without an argument it writes into a temporary directory and
// checks only that the files are there (so the test runner may run it like any other test).
//
// Run: node tests/js/test_ij_seg_edm_dump.mjs [outDir]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const DIR = path.join(ROOT, 'js', 'modules', 'studio', 'advanced-studio');
const sandbox = { console, setTimeout };
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ['ij-core.js', 'ij-analysis.js', 'ij-proc-shared.js', 'ij-proc-seg.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
const { IJSeg } = sandbox;

function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const cases = [[37, 29, 0.25, 1], [64, 64, 0.04, 2], [90, 41, 0.08, 3], [128, 96, 0.02, 4], [51, 77, 0.5, 5], [200, 120, 0.004, 6]];
const argDir = process.argv[2];
const out = argDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ij-seg-edm-'));
fs.mkdirSync(out, { recursive: true });
const meta = [];
for (let k = 0; k < cases.length; k++) {
  const [w, h, p, seed] = cases[k];
  const rnd = lcg(seed);
  const m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = rnd() < p ? 0 : 255; // isolated background points: long distances
  // a filled disk of background and a wall, so that large distances occur next to straight edges
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x - w / 3) ** 2 + (y - h / 2) ** 2 < (h / 6) ** 2) m[y * w + x] = 0;
  const f = await IJSeg.edmFloat(m, w, h, false, null);
  fs.writeFileSync(path.join(out, `mask${k}.bin`), m);
  fs.writeFileSync(path.join(out, `edm${k}.bin`), Buffer.from(f.buffer, f.byteOffset, f.byteLength));
  meta.push({ w, h });
}
fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta));
if (!argDir) {
  for (let k = 0; k < cases.length; k++) assert.ok(fs.statSync(path.join(out, `edm${k}.bin`)).size > 0);
  fs.rmSync(out, { recursive: true, force: true });
  console.log('ok: wrote and removed ' + cases.length + ' masks');
}
