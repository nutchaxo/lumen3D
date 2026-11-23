// Schema check of the ImageJ 1.54p stack fixtures (tests/fixtures/ij-stacks, written by tools/ij_fixtures/run4.sh):
// every file parses, every STACK object decodes (dims x planes x labels x calibration), every encoded array has the length it declares,
// dialog captures are well formed, TIFF bytes start with a TIFF header. The port tests (test_ij_stk_*.mjs) come later and read the same files.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ij-stacks');
if (!existsSync(root)) { console.log('SKIP tests/fixtures/ij-stacks is absent (generate it with tools/ij_fixtures/run4.sh)'); process.exit(0); }

const GROUPS = ['dialogs', 'zproj', 'reslice', 'substack', 'reduce', 'reverse', 'concat', 'hyper', 'montage', 'zprofile', 'stats', 'labels', 'slices', 'rgb', 'convert', 'tiff', 'stackproc'];
let failures = 0, files = 0, stacks = 0, planes = 0, totalBytes = 0;
const fail = (where, msg) => { failures++; console.error('FAIL ' + where + ': ' + msg); };

/** ARRAY of the README: number[] | {b64, dtype, length} -> typed array (NaN for null). */
function decodeData(d, where) {
  if (Array.isArray(d)) return Float64Array.from(d, (v) => (v === null ? NaN : v));
  if (d && typeof d === 'object' && typeof d.b64 === 'string') {
    const b = Buffer.from(d.b64, 'base64');
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    const per = { u8: 1, u16: 2, f32: 4 }[d.dtype];
    if (!per) { fail(where, 'unknown dtype ' + d.dtype); return null; }
    if (ab.byteLength !== d.length * per) { fail(where, `b64 holds ${ab.byteLength} bytes, ${d.length} x ${d.dtype} declared`); return null; }
    return d.dtype === 'u8' ? new Uint8Array(ab) : d.dtype === 'u16' ? new Uint16Array(ab) : new Float32Array(ab);
  }
  fail(where, 'not an ARRAY');
  return null;
}

function checkStack(s, where) {
  stacks++;
  const { dims, width, height, bitDepth } = s;
  if (!dims || ![dims.c, dims.z, dims.t].every((n) => Number.isInteger(n) && n >= 1)) return fail(where, 'bad dims ' + JSON.stringify(dims));
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return fail(where, 'bad size');
  if (![8, 16, 24, 32].includes(bitDepth)) return fail(where, 'bad bitDepth ' + bitDepth);
  const rgb = bitDepth === 24;
  const n = dims.c * dims.z * dims.t;
  if (!Array.isArray(s.planes) || s.planes.length !== n) return fail(where, `${s.planes && s.planes.length} planes for c${dims.c} z${dims.z} t${dims.t}`);
  s.planes.forEach((p, i) => {
    planes++;
    const w = `${where} plane ${i + 1}`;
    if (rgb) {
      if (!p || p.rgb !== true) return fail(w, 'RGB plane without rgb:true');
      if (p.dtype !== 'u8' || p.length !== width * height * 3) return fail(w, `RGB plane length ${p.length}, expected ${width * height * 3}`);
      decodeData(p, w);
    } else {
      if (p && p.rgb) return fail(w, 'rgb plane in a non-RGB stack');
      const a = decodeData(p, w);
      if (a && a.length !== width * height) fail(w, `${a.length} values for ${width}x${height}`);
    }
  });
  if (s.labels !== undefined && (!Array.isArray(s.labels) || s.labels.length !== n || s.labels.some((l) => l !== null && typeof l !== 'string'))) fail(where, 'labels do not match the planes');
  const cal = s.calibration;
  if (!cal || typeof cal.unit !== 'string' || !(cal.pixelWidth > 0) || !(cal.pixelHeight > 0) || !(cal.pixelDepth > 0)) fail(where, 'bad calibration ' + JSON.stringify(cal));
  if (!Array.isArray(s.displayRanges) || s.displayRanges.some((r) => !Array.isArray(r) || r.length !== 2)) fail(where, 'bad displayRanges');
  if (!rgb && s.luts) {
    if (s.luts.length !== s.displayRanges.length) fail(where, 'luts / displayRanges count differ');
    for (const l of s.luts) {
      if (l === 'grays' || l === 'inverting') continue;
      if (!l || typeof l.rgb !== 'string' || Buffer.from(l.rgb, 'base64').length !== 768) fail(where, 'bad lut');
    }
  }
  if (s.composite && !['composite', 'color', 'grayscale'].includes(s.mode)) fail(where, 'bad composite mode ' + s.mode);
}

function checkDialogs(d, where) {
  if (!Array.isArray(d.steps)) return fail(where, 'dialog capture without steps');
  if (d.steps.length === 0 && d.noDialog !== true) fail(where, 'no steps and no noDialog flag');
  const kinds = new Set(['label', 'message', 'numeric', 'string', 'text', 'checkbox', 'radio', 'choice', 'slider', 'button', 'textarea']);
  for (const s of d.steps) {
    if (typeof s.title !== 'string' || !Array.isArray(s.components)) return fail(where, 'bad step');
    for (const c of s.components) {
      if (!kinds.has(c.t)) fail(where, 'unknown component ' + c.t);
      if (c.t === 'choice' && (!Array.isArray(c.items) || !c.items.includes(c.selected))) fail(where, 'choice default not among its items');
      if (c.t === 'checkbox' && typeof c.state !== 'boolean') fail(where, 'checkbox without state');
    }
  }
}

function walk(o, where) {
  if (Array.isArray(o)) { o.forEach((x, i) => walk(x, `${where}[${i}]`)); return; }
  if (!o || typeof o !== 'object') return;
  if (o.planes && o.dims && o.bitDepth) { checkStack(o, where); return; }
  if (o.tiff && o.tiff.b64) {
    const b = Buffer.from(o.tiff.b64, 'base64');
    const okHdr = (b[0] === 0x49 && b[1] === 0x49 && b[2] === 42 && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 42);
    if (!okHdr || b.length !== o.tiff.length) fail(where, 'tiff bytes are not a TIFF of the declared length');
    if (!(o.ifdCount >= 1)) fail(where, 'tiff without ifdCount');
    if (typeof o.description !== 'string') fail(where, 'tiff without description');
  }
  for (const [k, v] of Object.entries(o)) if (k !== 'tiff') walk(v, `${where}.${k}`);
}

for (const g of GROUPS) {
  const dir = join(root, g);
  if (!existsSync(dir)) { fail(g, 'group directory missing'); continue; }
  const names = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (names.length === 0) fail(g, 'group is empty');
  for (const f of names) {
    const path = join(dir, f);
    const where = `${g}/${f}`;
    files++;
    totalBytes += statSync(path).size;
    let d;
    try { d = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { fail(where, 'does not parse: ' + e.message); continue; }
    if (d.imagej !== '1.54p') fail(where, 'imagej version ' + d.imagej);
    if (d.case !== f.replace(/\.json$/, '')) fail(where, 'case name ' + d.case);
    if (typeof d.op !== 'string') fail(where, 'no op');
    if (d.error) { fail(where, 'driver error recorded: ' + d.error); continue; }
    if (g === 'dialogs') checkDialogs(d, where); else walk(d, where);
  }
}
if (totalBytes > 9 * 1024 * 1024) fail('size', `fixtures weigh ${(totalBytes / 1048576).toFixed(1)} MB (limit 9 MB)`);

console.log(`ij-stacks fixtures: ${files} files, ${stacks} stacks, ${planes} planes, ${(totalBytes / 1048576).toFixed(2)} MB`);
if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('ok');
