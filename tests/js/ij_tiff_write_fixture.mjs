// Writes the TIFF fixtures read by tests/test_ij_tiff_tifffile.py.
// Usage: node tests/js/ij_tiff_write_fixture.mjs <output dir>
import vm from 'node:vm';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = 'js/modules/studio/advanced-studio/ij-core.js';
vm.runInThisContext(readFileSync(path.join(ROOT, FILE), 'utf8'), { filename: FILE });
const { IJImage, IJTiff } = globalThis;

const dir = process.argv[2];
if (!dir) { console.error('usage: ij_tiff_write_fixture.mjs <dir>'); process.exit(2); }
mkdirSync(dir, { recursive: true });

const W = 7, H = 5;
const specs = [
  { file: 'c2_u8.tif', bd: 8, colors: ['#ff0000', '#00ff00'], px: 0.25 },
  { file: 'c1_u16.tif', bd: 16, colors: ['#ffffff'], px: 0.5 },
  { file: 'c3_f32.tif', bd: 32, colors: ['#0000ff', '#00ff00', '#ff00ff'], px: 0.125 }
];
const expected = {};
for (const s of specs) {
  const img = IJImage.create({
    name: s.file, width: W, height: H, bitDepth: s.bd,
    channels: s.colors.map((color, i) => ({ name: 'ch' + (i + 1), color })),
    calibration: { pixelWidth: s.px, pixelHeight: s.px, unit: 'µm' }
  });
  img.channels.forEach((c, k) => {
    for (let i = 0; i < c.data.length; i++) c.data[i] = s.bd === 8 ? (i * 7 + k * 50) & 255 : s.bd === 16 ? i * 1717 + k * 11 : (i - 10) * 0.75 + k;
  });
  writeFileSync(path.join(dir, s.file), IJTiff.write(img));
  expected[s.file] = { bitDepth: s.bd, channels: s.colors.length, width: W, height: H, pixelUm: s.px, data: img.channels.map((c) => Array.from(c.data)) };
}
writeFileSync(path.join(dir, 'expected.json'), JSON.stringify(expected));
