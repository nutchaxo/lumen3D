// The run() bridge table (ij-macro-cmds.js MACRO_COMMANDS) against the Studio's real dialogs and ImageJ's captured ones.
// Every Studio command runs in the Node harness on the inputs it accepts (8-bit with a rectangle, a composite, 16-bit stack, hyperstack,
// RGB, 32-bit, binary, line / polygon selections, …) with a recording interceptor that answers each dialog with its defaults, then:
//   - every dialog the Studio shows is covered by a DialogEntry (a key or null for EVERY settable field), every key the table names is a
//     field the command still shows, every choice / radio option has its ImageJ item text;
//   - the Recorder's string for the defaults (IJMacroOptions.build) answers the dialog headlessly with the same values (round trip);
//   - a field's own `ijKey` (stk / multi packages) agrees with the table;
//   - against tests/fixtures/ij-macro/ij-dialogs.json / fiji-macro-keys.json (when present): the captured dialog exists, every key the
//     table writes is a key of it (or of a variant of the ImageJ dialog the capture input did not open, listed below with its source line),
//     every item text is one of its items.
import assert from 'node:assert/strict';
import { boot } from './ij_harness.mjs';
import { loadCmds, fixture } from './ij_macro_cmds_support.mjs';

const L = loadCmds();
if (!L) { console.log('SKIP ij-macro-cmds.js absent'); process.exit(0); }
const { IJMacroOptions: O, IJMacroCmds: C } = L;
const T = C.MACRO_COMMANDS;

// commands never run here: they would tear the harness down, loop forever, or start a macro
const NOT_RUN = new Set(['fileCloseAll', 'stackStartAnimation', 'macRun', 'procRepeatCommand']);
// keys of ImageJ dialog variants the capture's inputs did not open (an ImageJ 1.54p source line shows each)
const EXTRA_KEYS = {
  'Duplicate...#0': ['duplicate', 'range', 'channels', 'slices', 'frames'],         // Duplicator.java:488-613 (stack / hyperstack dialogs)
  'Size...#0': ['time'],                                                             // Resizer.java:97
  'Properties...#0': ['unit'],                                                       // ImageProperties.java:73 (legacy macro key)
  'Scale...#0': ['z', 'depth', 'process'],                                           // Scaler.java:275-319
  'Rotate... #0': ['enlarge'],                                                       // Rotator.java:154
  'Bin...#0': ['z'],                                                                 // Binner.java:263
  'Options...#0': ['do'],                                                            // Binary.java:65 (with an image)
  'Gaussian Blur...#0': ['scaled'],                                                  // GaussianBlur.java:91 (calibrated image)
  'Bandpass Filter...#0': ['process'],                                               // FFTFilter.java:419 (stack)
  'Set Slice...#0': ['channel', 'frame'],                                            // hyperstack "Set Position"
  'Make Substack...#0': ['channels', 'frames'],                                      // SubstackMaker (hyperstack)
  'Reduce...#0': ['reduce'],                                                         // Reducer (hyperstack: "Reduce in Z-Dimension")
  'Reduce Dimensionality...#0': ['slices', 'frames'],                                // HyperStackReducer.java:166-168
  'Stack to RGB#0': [],
  'Make Subset...#0': ['channels', 'frames'],
  'Enhance Local Contrast (CLAHE)#0': ['process_as_composite'],                      // composite input only
  'Directionality#0': [],
  'Z Project...#0': ['all'],                                                         // ZProjector.java:299 (hyperstack with frames)
  'Concatenate...#0': ['image4', 'image5', 'image6', 'image7', 'image8'],           // Concatenator.java:368 (one choice per open image)
  'Enhance Contrast...#0': ['process_all', 'use']                                    // ContrastEnhancer.java:66-69 (stack)
};
// fields whose own ijKey is wrong: the table holds the jar's key (change requests to the owning package)
const IJKEY_DIFF = { 'stackConcatenate.all': 'all_open', 'stackSubstack.do': 'do_not' };
// fields a dialog shows only with more images open than this test keeps (Concatenate: one choice per open image)
const SHOWN_WITH_MORE_IMAGES = { stackConcatenate: ['image4', 'image5', 'image6', 'image7', 'image8'] };
// fields a dialog shows only when a macro runs the command (this test runs them as the operator does): ImageJ's in-place Image Calculator,
// RGBStackMerge closing its sources
const MACRO_ONLY_FIELDS = { procImageCalculator: ['create'], colorMergeChannels: ['keep'] };
// item texts the Studio accepts beyond ImageJ's list (Concatenate's Image1 / Image2 may be left empty in the Studio)
const STUDIO_ITEMS = { 'stackConcatenate.image1': ['-- None --'], 'stackConcatenate.image2': ['-- None --'] };
const PLANE_WORDS = new Set(['stack', 'process']);   // PlugInFilterRunner / FFTFilter words, not components of the dialog

const W = 48, H = 40;
function plane(bd, kind, seed) {
  const Ctor = bd === 8 ? Uint8Array : bd === 16 ? Uint16Array : Float32Array;
  const a = new Ctor(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = kind === 'bin' ? (((x - 12) ** 2 + (y - 12) ** 2 < 40 || (x - 32) ** 2 + (y - 26) ** 2 < 60) ? 255 : 0) : ((x * 5 + y * 3 + seed * 17) % 200) + 20 + ((x * y) % 7);
    a[y * W + x] = bd === 16 ? v * 50 : v;
  }
  return a;
}
const CTX = {
  g8r: { bd: 8, roi: 'rect' }, comp: { bd: 8, nC: 2, roi: 'rect' }, stack16: { bd: 16, nZ: 3, roi: 'rect' }, hyper: { bd: 8, nC: 2, nZ: 3, nT: 2, hyper: true },
  rgbr: { bd: 8, rgb: true, roi: 'rect' }, g32r: { bd: 32, roi: 'rect' }, bin: { bd: 8, kind: 'bin' }, g16r: { bd: 16, roi: 'rect' }, g8: { bd: 8 },
  line: { bd: 8, roi: 'line' }, point: { bd: 8, roi: 'point' }, poly: { bd: 8, roi: 'polygon' }, stack: { bd: 8, nZ: 3 }
};
const ROIS = { rect: { type: 'rect', x: 5, y: 6, w: 20, h: 15 }, line: { type: 'line', x1: 3, y1: 4, x2: 30, y2: 25 }, point: { type: 'point', points: [[10, 10], [20, 15]] },
  polygon: { type: 'polygon', points: [[4, 4], [30, 6], [25, 30], [6, 22]] } };

const t = await boot({ firePreview: false, channels: 2 });
await t.open();
const api = t.api('edit');
let serial = 0;
async function make(name) {
  const c = CTX[name];
  const nC = c.rgb ? 3 : (c.nC || 1), NP = (c.nZ || 1) * (c.nT || 1);
  const img = { name: name + '-' + (++serial), width: W, height: H, bitDepth: c.bd, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' }, channels: [] };
  if (c.rgb) img.rgb = true;
  if (NP > 1) { img.nZ = c.nZ || 1; img.nT = c.nT || 1; img.hyperstack = !!c.hyper; }
  for (let k = 0; k < nC; k++) {
    const ch = { name: 'C' + (k + 1), color: ['#ff0000', '#00ff00', '#0000ff'][k] };
    if (NP > 1) { ch.planes = []; for (let p = 0; p < NP; p++) ch.planes.push(plane(c.bd, c.kind, k + p)); } else ch.data = plane(c.bd, c.kind, k);
    img.channels.push(ch);
  }
  const id = await api.addDoc(img, { placement: 'tab' });
  if (c.roi) api.setRoi(ROIS[c.roi], { docId: id });
  return id;
}
// a second image for the commands that take two (Combine, Concatenate… consume their sources: it is made again when gone)
const keep = new Set();
for (const d of await t.docs()) keep.add(d.docId);
keep.add(await make('g8'));
async function ensureSecond() {
  const open = new Set((await t.docs()).map((d) => d.docId));
  if ([...keep].filter((id) => open.has(id)).length < 2) keep.add(await make('g8'));
}
async function closeExtra() {
  for (const d of await t.docs()) {
    if (keep.has(d.docId)) continue;
    t.script.nextAsk = 'discard';
    try { await api.closeDoc(d.docId); } catch (_) { /* gone */ }
    t.script.nextAsk = null;
  }
}

const failures = [];
const everIds = new Set();            // every image id met: a titles field lists them
const check = (cond, msg) => { if (!cond) failures.push(msg); };
const seenFields = {};                 // commandId → Set(field id) over every context
const IJ = fixture('ij-dialogs.json'), FJ = fixture('fiji-macro-keys.json');
const capOf = (ij) => {
  const i = ij.lastIndexOf('#');
  const name = ij.slice(0, i), k = Number(ij.slice(i + 1));
  const e = (IJ && IJ.commands[name]) || (FJ && FJ.commands[name]);
  return e && e.dialogs ? e.dialogs[k] || null : (e ? undefined : null);
};
const isImageOption = (o, docIds) => { const v = String(o && typeof o === 'object' ? o.value : o); return docIds.has(v) || v.startsWith('doc:'); };
// the macro string literal the Recorder wrote, as the interpreter reads it (\n, \\, \", \ooo)
const unescape = (src) => src.replace(/\\(n|\\|"|[0-7]{3})/g, (m, e) => (e === 'n' ? '\n' : e === '\\' || e === '"' ? e : String.fromCharCode(parseInt(e, 8))));
const tr = (k, p) => k + (p ? ' ' + JSON.stringify(p) : '');

let runs = 0, dialogsSeen = 0, roundTrips = 0;
for (const c of t.IJApp.COMMANDS) {
  if (c.dynamic) continue;
  const entry = T[c.id];
  if (!entry) { failures.push(c.id + ': no MACRO_COMMANDS entry'); continue; }
  if (entry.cls === 'E' || NOT_RUN.has(c.id)) continue;
  const expectDialogs = entry.dialogs.length > 0;
  seenFields[c.id] = new Set();
  let ok = 0, ranAny = false;
  for (const cx of Object.keys(CTX)) {
    await ensureSecond();
    try { await make(cx); } catch (e) { failures.push('make ' + cx + ': ' + e.message); continue; }
    let enabled = false;
    try { enabled = !!c.enabled(t.shell.opts.getState()); } catch (_) { enabled = false; }
    if (!enabled) { await closeExtra(); continue; }
    for (const d of await t.docs()) everIds.add(String(d.docId));
    const s0 = t.log.dialogSpecs.length, f0 = t.failures.length;
    let err = null;
    try {
      await Promise.race([t.shell.opts.onCommand(c, { source: 'menu' }), new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 20000))]);
    } catch (e) { err = e; }
    t.script.dialogs.length = 0;
    if (t.failures.length > f0) t.failures.length = f0;
    const specs = t.log.dialogSpecs.slice(s0);
    runs++; ranAny = true;
    if (!expectDialogs) {
      check(specs.length === 0, c.id + ' (' + cx + '): shows a dialog the table does not list (' + (specs[0] && specs[0].title) + ')');
      await closeExtra();
      break;
    }
    for (const d of await t.docs()) everIds.add(String(d.docId));
    const docIds = everIds;
    for (const [k, spec] of specs.entries()) {
      dialogsSeen++;
      const fields = (spec.fields || []).filter(Boolean);
      for (const f of fields) seenFields[c.id].add(f.id);
      const de = C.pickDialog(entry, k, fields);
      if (!de) { failures.push(c.id + ' (' + cx + ') dialog ' + k + ' "' + spec.title + '": no DialogEntry covers fields ' + fields.filter((f) => f.type !== 'message').map((f) => f.id).join(',')); continue; }
      if (de.refuse) continue;
      for (const f of fields) {
        if (typeof f.ijKey === 'string' && de.keys[f.id] !== f.ijKey) {
          check(IJKEY_DIFF[c.id + '.' + f.id] === de.keys[f.id], c.id + '.' + f.id + ': field ijKey "' + f.ijKey + '" vs table "' + de.keys[f.id] + '"');
        }
        if ((f.type === 'choice' || f.type === 'radio') && de.keys[f.id] !== null) {
          const map = (de.items && de.items[f.id]) || {};
          const titles = Array.isArray(de.titles) && de.titles.includes(f.id);
          const values = new Set(Object.values(map).filter((v) => v !== null).map(String));
          for (const o of f.options || []) {
            if (titles && isImageOption(o, docIds)) continue;
            const v = String(o && typeof o === 'object' ? o.value : o);
            check(values.has(v), c.id + '.' + f.id + ': option ' + JSON.stringify(v) + ' has no ImageJ item text');
          }
        }
      }
      // round trip: the Recorder's string for the defaults answers the dialog with the same values
      const raw = {};
      for (const f of fields) if (f.type !== 'message') raw[f.id] = f.type === 'check' ? !!f.value : (f.value === undefined || f.value === null ? '' : String(f.value));
      const base = t.IJViewPure.collectFields(fields, raw, {});
      if (!base.ok) continue;
      if (typeof spec.validate === 'function') { const v = spec.validate(base.values); if (v && Object.keys(v).length) continue; }   // defaults the dialog itself refuses (Merge: two images)
      // build() writes the macro SOURCE (Recorder.fixString escapes): the string the interpreter hands run() is its unescaped text
      const opts = O.normalize(unescape(O.build(base.values, de, spec)) || ' ');
      const r = C.headlessAnswer(spec, opts, { commandId: c.id, entry, dialogIndex: k, vars: {}, pure: t.IJViewPure, tr });
      if (!r.ok) { failures.push(c.id + ' (' + cx + ') round trip of ' + JSON.stringify(opts) + ': ' + r.error.text); continue; }
      for (const id of Object.keys(base.values)) {
        if (de.keys[id] === null || de.keys[id] === undefined) continue;
        const f = fields.find((x) => x.id === id);
        const shown = (v) => (typeof v === 'number' && f && Number.isInteger(f.decimals) ? v.toFixed(f.decimals) : String(v));
        check(shown(r.values[id]) === shown(base.values[id]), c.id + ' (' + cx + ') round trip of ' + id + ': ' + JSON.stringify(base.values[id]) + ' → ' + JSON.stringify(r.values[id]) + ' via ' + JSON.stringify(opts));
      }
      check(r.unknown.length === 0, c.id + ': fields without a key ' + r.unknown.join(','));
      roundTrips++;
    }
    if (err && specs.length === 0 && String(err.message) === 'timeout') failures.push(c.id + ' (' + cx + '): timed out');
    await closeExtra();
    if (specs.length && ++ok >= 7) break;
  }
  if (expectDialogs && ranAny) {
    for (const d of entry.dialogs) for (const id of Object.keys(d.keys)) check(seenFields[c.id].has(id) || (SHOWN_WITH_MORE_IMAGES[c.id] || []).includes(id) || (MACRO_ONLY_FIELDS[c.id] || []).includes(id), c.id + ': the table names field "' + id + '" the command never showed');
  }
  if (!ranAny && expectDialogs) failures.push(c.id + ': enabled on no test input (its dialogs were not checked)');
}

// ── against the capture
let capChecked = 0;
for (const [id, e] of Object.entries(T)) {
  for (const d of e.dialogs) {
    if (!d.ij || !(IJ || FJ)) continue;
    const cap = capOf(d.ij);
    if (cap === undefined) continue;   // the other fixture is absent
    if (!cap) { failures.push(id + ': capture ' + d.ij + ' does not exist'); continue; }
    capChecked++;
    const comps = cap.components.filter((x) => typeof x.key === 'string');
    const capKeys = new Set(comps.map((x) => x.key));
    const extra = new Set(EXTRA_KEYS[d.ij] || []);
    for (const [fid, key] of Object.entries(d.keys)) {
      if (key === null) continue;
      check(capKeys.has(key) || extra.has(key) || PLANE_WORDS.has(key), id + '.' + fid + ': key "' + key + '" is not in ' + d.ij);
      const comp = comps.find((x) => x.key === key);
      const map = d.items && d.items[fid];
      if (!comp || !map || !Array.isArray(comp.items)) continue;
      const titles = Array.isArray(d.titles) && d.titles.includes(fid);
      for (const text of Object.keys(map)) check(comp.items.includes(text) || (STUDIO_ITEMS[id + '.' + fid] || []).includes(text), id + '.' + fid + ': item ' + JSON.stringify(text) + ' is not an item of ' + d.ij + ' ' + key);
    }
    if (cap.title !== undefined && d.title !== null) check(d.title === cap.title, id + ': title ' + JSON.stringify(d.title) + ' vs captured ' + JSON.stringify(cap.title));
  }
}

t.close();
if (failures.length) { console.error(failures.join('\n')); assert.fail(failures.length + ' parity problems'); }
console.log('ok: ' + runs + ' runs, ' + dialogsSeen + ' dialogs, ' + roundTrips + ' round trips, ' + capChecked + ' captured dialogs checked'
  + (IJ ? '' : ' (SKIP ij-dialogs.json absent)') + (FJ ? '' : ' (SKIP fiji-macro-keys.json absent)'));
process.exit(0);
