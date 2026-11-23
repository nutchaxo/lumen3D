// Shared support of the macro FILE tests of the runtime (not a test: no `test_` prefix).
//
// frt(opts) boots the real worker runtime (ij_macro_rt_support.mjs rt(): engine + packages + language + ij-proc-macro.js) and puts in
// front of it, in the vm realm:
//   • a stand-in IJMacroVFS that follows the interface of FILES.md §4 (pure helpers, resolve with aliases and the `..` clamp, the
//     virtual roots of §2.6, the policy table of §7.1 with VFS_ASK / allow, permissions, quota, async roots that behave like Chromium's
//     File System Access handles) over in-memory disks — so the runtime is tested against the contract whether or not the VFS builder's
//     ij-macro-vfs.js is on disk (the end-to-end suite of the lead runs the real one);
//   • E.decodeImage / E.encodeImage / E.markSaved of FILES.md §10.2 when the engine does not have them yet (TIFF through the core codec,
//     the other encoders as tagged bytes, enough to see what the runtime wrote and where).
//
//   const t = await frt();
//   const disk = t.disk({ 'a.tif': tiffBytes, 'sub/': {}, 'sub/b.txt': 'hello' });
//   const root = t.grant('Data', disk, { mode: 'allow' });
//   const r = await t.runF('print(File.exists("/Data/a.tif"));');    // the run carries args.vfs { roots, aliases, mountId }
import { createHash } from 'node:crypto';
import { rt } from './ij_macro_rt_support.mjs';

const enc = new TextEncoder();
const bytesOf = (v) => (typeof v === 'string' ? enc.encode(v) : v instanceof Uint8Array ? v : new Uint8Array(v));

// ---------------------------------------------------------------- disks
export function makeDisk(tree = {}, { mtime = 1700000000000 } = {}) {
  const files = new Map(), dirs = new Set();
  const addParents = (rel) => { const parts = rel.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); };
  for (const [k, v] of Object.entries(tree)) {
    if (k.endsWith('/')) { const rel = k.slice(0, -1); dirs.add(rel); addParents(rel); continue; }
    const o = v && typeof v === 'object' && !(v instanceof Uint8Array) && v.bytes !== undefined ? v : { bytes: v };
    files.set(k, { bytes: bytesOf(o.bytes).slice(), mtime: o.mtime === undefined ? mtime : o.mtime });
    addParents(k);
  }
  return {
    files, dirs,
    text(rel) { const f = files.get(rel); return f ? new TextDecoder().decode(f.bytes) : null; },
    bytes(rel) { const f = files.get(rel); return f ? f.bytes : null; },
    tree() { return { files: Array.from(files.keys()).sort(), dirs: Array.from(dirs).sort() }; }
  };
}

// ---------------------------------------------------------------- the stand-in IJMacroVFS
class VfsError extends Error {
  constructor(code, path, details) { super(code); this.code = code; if (path !== undefined) this.path = path; if (details) this.details = details; }
}
const ERRORS = ['VFS_BAD_PATH', 'VFS_NOT_GRANTED', 'VFS_NOT_FOUND', 'VFS_NOT_A_DIR', 'VFS_IS_A_DIR', 'VFS_EXISTS', 'VFS_READ_ONLY', 'VFS_ASK',
  'VFS_PERMISSION', 'VFS_QUOTA', 'VFS_ROOT_DELETE', 'VFS_NOT_EMPTY', 'VFS_BAD_NAME', 'VFS_GONE', 'VFS_STALE', 'VFS_BUSY', 'VFS_TOO_LARGE',
  'VFS_NO_STORAGE', 'VFS_CLOSED', 'VFS_IO'];
const RESERVED = ['tmp', 'home', 'macros', 'luts', 'imagej', 'Downloads'];

const normalizeSeparators = (s) => String(s).replace(/\\/g, '/');
const isUrl = (s) => s.indexOf('://') >= 0 || s.indexOf('file:/') >= 0;
const isFullPath = (s) => s.startsWith('/') || s.indexOf(':/') >= 0 || s.indexOf('://') >= 0;
const isMachinePath = (s) => /^[A-Za-z]:\//.test(s) || s.startsWith('//');
function javaNorm(s) { let n = normalizeSeparators(s).replace(/\/+/g, '/'); if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1); return n; }
function javaName(s) { const n = javaNorm(s); return n.substring(n.lastIndexOf('/') + 1); }
function javaParent(s) {
  const n = javaNorm(s);
  const i = n.lastIndexOf('/');
  if (i < 0) return null;
  if (i === 0) return n.length > 1 ? '/' : null;
  return n.substring(0, i);
}
const javaAbsolute = (s) => javaNorm(isFullPath(normalizeSeparators(s)) ? s : '/home/' + s);
function nameWithoutExtension(name) { const d = name.lastIndexOf('.'); return d >= 0 && name.length - d <= 5 ? name.substring(0, d) : name; }
function getNameWithoutExtension(s) { const n = javaName(s); const d = n.lastIndexOf('.'); return d >= 0 ? n.substring(0, d) : n; }
function updateExtension(path, ext) {
  if (path === null) return null;
  const dot = path.lastIndexOf('.'), sep = path.lastIndexOf('/');
  if (dot >= 0 && dot > sep && path.length - dot <= 5) {
    if (dot + 1 < path.length && /[0-9]/.test(path.charAt(dot + 1))) return path + ext;
    return path.substring(0, dot) + ext;
  }
  return path + ext;
}
const addSeparator = (p) => (p === null || p === undefined ? null : p.length > 0 && !p.endsWith('/') ? p + '/' : p);
function formatBytes(n) {
  if (n < 1000) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n, i = -1;
  do { v /= 1000; i++; } while (v >= 1000 && i < u.length - 1);
  return v.toFixed(1) + ' ' + u[i];
}
function aliasPrefixes(dir) {
  const out = [];
  const unc = dir.startsWith('//');
  const parts = dir.split('/').filter((x, i) => x !== '' || i === 0);
  const min = unc ? 4 : 1;
  const segs = dir.replace(/\/$/, '').split('/');
  for (let n = segs.length; n >= (unc ? 4 : 1); n--) out.push(segs.slice(0, n).join('/') + '/');
  void parts; void min;
  return out;
}
const hasher = (alg) => () => { const h = createHash(alg); return { update(u8) { h.update(u8); }, hex() { return h.digest('hex'); } }; };

export function makeStandInVFS() {
  const state = { tmp: { mount: null, disk: makeDisk() }, downloads: makeDisk(), opened: [], allowCalls: [], grantsAdded: [] };
  function open(ctx) {
    const roots = new Map();   // name → root
    const byId = new Map();
    const addRoot = (r) => { roots.set(r.name, r); byId.set(r.id, r); };
    const addGrant = (g) => {
      const old = byId.get(g.id);
      if (old) roots.delete(old.name);
      addRoot({ id: g.id, name: g.name, mode: g.mode || 'ask', target: g.target || 'inplace', disk: g.handle, async: !!g.async,
        permission: Object.assign({ read: 'granted', readwrite: 'granted' }, g.permission || {}), quota: g.quota, written: 0, virtual: false });
    };
    for (const g of ctx.roots || []) addGrant(g);
    const luts = makeDisk();
    for (const f of (ctx.lutFiles ? ctx.lutFiles() : [])) luts.files.set(f.name, { bytes: f.bytes, mtime: 0 });
    addRoot({ id: 'tmp', name: 'tmp', mode: 'allow', disk: state.tmp.disk, virtual: false, permission: { read: 'granted', readwrite: 'granted' } });
    addRoot({ id: 'downloads', name: 'Downloads', mode: 'allow', target: 'overlay', disk: state.downloads, virtual: false, permission: { read: 'granted', readwrite: 'granted' } });
    for (const [name, disk] of [['home', makeDisk()], ['macros', makeDisk()], ['luts', luts], ['imagej', makeDisk()]])
      addRoot({ id: name, name, mode: 'readonly', disk, virtual: true, permission: { read: 'granted', readwrite: 'granted' } });
    const aliases = (ctx.aliases || []).slice();
    const allowed = new Set();
    const changed = new Set();
    let closed = false;
    const vfs = {
      ctx, roots,
      async prepare() { if (state.tmp.mount !== ctx.mountId) { state.tmp.mount = ctx.mountId; state.tmp.disk.files.clear(); state.tmp.disk.dirs.clear(); } },
      resolve(path, { base } = {}) {
        let s = normalizeSeparators(path);
        if (s === '' || s.indexOf('\0') >= 0) throw new VfsError('VFS_BAD_PATH', s);
        if (!isFullPath(s)) s = (base || '/home/') + s;
        const original = s;
        const viaAlias = () => {
          let best = null;
          for (const a of aliases) {
            if (!byId.has(a.rootId)) continue;
            const hit = a.ci ? s.toLowerCase().startsWith(a.literal.toLowerCase()) : s.startsWith(a.literal);
            if (hit && (!best || a.literal.length > best.literal.length)) best = a;
          }
          const dir = s.endsWith('/') ? s : s.substring(0, s.lastIndexOf('/') + 1);
          if (!best) throw new VfsError('VFS_NOT_GRANTED', original, { literal: dir, prefixes: aliasPrefixes(dir) });
          return '/' + byId.get(best.rootId).name + '/' + s.substring(best.literal.length);
        };
        if (isMachinePath(s)) s = viaAlias();
        const trailing = s.endsWith('/');
        const segs = [];
        for (const p of s.split('/')) { if (p === '' || p === '.') continue; if (p === '..') { segs.pop(); continue; } segs.push(p); }
        if (segs.length && !roots.has(segs[0])) {
          s = original;
          if (!isMachinePath(s)) {
            const dir = s.endsWith('/') ? s : s.substring(0, s.lastIndexOf('/') + 1);
            const best = aliases.filter((a) => byId.has(a.rootId) && s.startsWith(a.literal)).sort((x, y) => y.literal.length - x.literal.length)[0];
            if (!best) throw new VfsError('VFS_NOT_GRANTED', original, { literal: dir, prefixes: aliasPrefixes(dir) });
            return vfs.resolve('/' + byId.get(best.rootId).name + '/' + s.substring(best.literal.length));
          }
        }
        const root = segs.length ? roots.get(segs[0]) : null;
        return { vpath: '/' + segs.join('/') + (trailing && segs.length ? '/' : ''), rootId: root ? root.id : null, root: root ? root.name : null,
          rel: segs.slice(1).join('/'), isRoot: segs.length === 1, isTop: segs.length === 0 };
      },
      stat(vpath) { return wrapOf(vpath, (r, rel) => statSync(r, rel)); },
      list(vpath) {
        const v = split(vpath);
        if (!v.root) return Array.from(roots.values()).map((r) => ({ name: r.name, kind: 'dir' }));
        return wrap(v.root, () => {
          perm(v.root, 'read', vpath);
          const d = v.root.disk;
          if (!(v.rel === '' || d.dirs.has(v.rel))) return null;
          const pre = v.rel === '' ? '' : v.rel + '/';
          const out = new Map();
          for (const k of d.files.keys()) if (k.startsWith(pre) && k.indexOf('/', pre.length) < 0) out.set(k.substring(pre.length), 'file');
          for (const k of d.dirs) if (k.startsWith(pre) && k.length > pre.length && k.indexOf('/', pre.length) < 0) out.set(k.substring(pre.length), 'dir');
          return Array.from(out, ([name, kind]) => ({ name, kind }));
        });
      },
      read(vpath, { offset = 0, length = -1 } = {}) {
        return wrapOf(vpath, (r, rel) => {
          perm(r, 'read', vpath);
          const f = r.disk.files.get(rel);
          if (!f) throw new VfsError(r.disk.dirs.has(rel) || rel === '' ? 'VFS_IS_A_DIR' : 'VFS_NOT_FOUND', vpath);
          return f.bytes.slice(offset, length < 0 ? undefined : offset + length);
        });
      },
      openRead(vpath) {
        return wrapOf(vpath, (r, rel) => {
          perm(r, 'read', vpath);
          const f = r.disk.files.get(rel);
          if (!f) throw new VfsError('VFS_NOT_FOUND', vpath);
          return { size: f.bytes.length, read: (o, l) => f.bytes.slice(o, o + l), close() {} };
        });
      },
      write(vpath, data, { append = false } = {}) {
        return wrapOf(vpath, (r, rel) => {
          const parts = Array.isArray(data) ? data : [data];
          let n = 0; for (const p of parts) n += p.length;
          const exists = r.disk.files.has(rel);
          policy(r, exists ? 'overwrite' : 'new', vpath);
          perm(r, 'readwrite', vpath);
          if (r.disk.dirs.has(rel)) throw new VfsError('VFS_IS_A_DIR', vpath);
          const parent = rel.lastIndexOf('/') >= 0 ? rel.substring(0, rel.lastIndexOf('/')) : '';
          if (parent !== '' && !r.disk.dirs.has(parent)) throw new VfsError('VFS_NOT_FOUND', vpath);
          if (r.quota !== undefined && r.written + n > r.quota) {
            r.written = r.quota;
            throw new VfsError('VFS_QUOTA', vpath, { written: r.quota, free: 0 });
          }
          r.written += n;
          const old = exists && append ? r.disk.files.get(rel).bytes : new Uint8Array(0);
          const out = new Uint8Array(old.length + n);
          out.set(old, 0);
          let at = old.length;
          for (const p of parts) { out.set(p, at); at += p.length; }
          r.disk.files.set(rel, { bytes: out, mtime: ctx.now ? ctx.now() : Date.now() });
          touch(r);
        });
      },
      mkdir(vpath) {
        return wrapOf(vpath, (r, rel) => {
          const exists = r.disk.files.has(rel) || r.disk.dirs.has(rel);
          policy(r, exists ? 'mkdir' : 'new', vpath);
          if (exists) return false;
          const parent = rel.lastIndexOf('/') >= 0 ? rel.substring(0, rel.lastIndexOf('/')) : '';
          if (parent !== '' && !r.disk.dirs.has(parent)) return false;
          r.disk.dirs.add(rel);
          touch(r);
          return true;
        });
      },
      remove(vpath) {
        return wrapOf(vpath, (r, rel) => {
          if (rel === '') throw new VfsError('VFS_ROOT_DELETE', vpath);
          const isFile = r.disk.files.has(rel), isDir = r.disk.dirs.has(rel);
          if (!isFile && !isDir) return false;
          policy(r, 'delete', vpath);
          if (isFile) { r.disk.files.delete(rel); touch(r); return true; }
          for (const k of r.disk.files.keys()) if (k.startsWith(rel + '/')) return false;
          for (const k of r.disk.dirs) if (k.startsWith(rel + '/')) return false;
          r.disk.dirs.delete(rel);
          touch(r);
          return true;
        });
      },
      rename(from, to) {
        const a = split(from), b = split(to);
        if (!a.root || a.root !== b.root) return a.root && a.root.async ? Promise.resolve(false) : false;
        return wrap(a.root, () => {
          const r = a.root, d = r.disk;
          if (!(d.files.has(a.rel) || d.dirs.has(a.rel)) || d.files.has(b.rel) || d.dirs.has(b.rel)) return false;
          policy(r, 'rename', from, to);
          if (d.files.has(a.rel)) { d.files.set(b.rel, d.files.get(a.rel)); d.files.delete(a.rel); }
          else {
            for (const k of Array.from(d.files.keys())) if (k.startsWith(a.rel + '/')) { d.files.set(b.rel + k.substring(a.rel.length), d.files.get(k)); d.files.delete(k); }
            for (const k of Array.from(d.dirs)) if (k === a.rel || k.startsWith(a.rel + '/')) { d.dirs.delete(k); d.dirs.add(b.rel + k.substring(a.rel.length)); }
          }
          touch(r);
          return true;
        });
      },
      copy(from, to) {
        const a = split(from), b = split(to);
        return wrap(b.root || a.root, () => {
          const f = a.root && a.root.disk.files.get(a.rel);
          if (!f) throw new VfsError('VFS_NOT_FOUND', from);
          const exists = b.root.disk.files.has(b.rel);
          policy(b.root, exists ? 'overwrite' : 'new', to);
          const parent = b.rel.lastIndexOf('/') >= 0 ? b.rel.substring(0, b.rel.lastIndexOf('/')) : '';
          if (parent !== '' && !b.root.disk.dirs.has(parent)) throw new VfsError('VFS_NOT_FOUND', to);
          b.root.disk.files.set(b.rel, { bytes: f.bytes.slice(), mtime: f.mtime });
          touch(b.root);
        });
      },
      allow(rootId) { allowed.add(rootId); state.allowCalls.push(rootId); },
      addGrant(g) { state.grantsAdded.push(g.id); addGrant(g); },
      changedRoots() { return Array.from(changed); },
      flush() { return undefined; },
      async close() { closed = true; },
      async changes(rootId) { return { rootId, files: [], deleted: [], renamed: [], dirs: [], bytes: 0 }; },
      async deliver() { return { kind: 'none' }; },
      async discard() {},
      async usage() { return { tmpBytes: 0, workspaces: {} }; }
    };
    function split(vpath) {
      const segs = vpath.split('/').filter((x) => x !== '');
      return { root: segs.length ? roots.get(segs[0]) : null, rel: segs.slice(1).join('/') };
    }
    function wrap(r, fn) {
      if (closed) throw new VfsError('VFS_CLOSED');
      if (r && r.async) { try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); } }
      return fn();
    }
    function wrapOf(vpath, fn) { const v = split(vpath); if (!v.root) throw new VfsError('VFS_NOT_FOUND', vpath); return wrap(v.root, () => fn(v.root, v.rel)); }
    function statSync(r, rel) {
      perm(r, 'read', '/' + r.name + '/' + rel);
      const f = r.disk.files.get(rel);
      if (f) return { kind: 'file', size: f.bytes.length, mtime: f.mtime };
      if (rel === '' || r.disk.dirs.has(rel)) return { kind: 'dir', size: 0, mtime: 0 };
      return null;
    }
    function perm(r, mode, path) {
      if (r.permission && r.permission[mode] && r.permission[mode] !== 'granted') throw new VfsError('VFS_PERMISSION', path, { rootId: r.id, root: r.name, mode });
    }
    function policy(r, action, path, to) {
      if (r.virtual || r.mode === 'readonly') throw new VfsError('VFS_READ_ONLY', path, { root: r.name });
      if (action === 'new') return;
      if (r.mode === 'ask' && !allowed.has(r.id)) throw new VfsError('VFS_ASK', path, Object.assign({ rootId: r.id, root: r.name, action, path }, to ? { to } : {}));
    }
    function touch(r) { if (r.target === 'overlay') { if (!changed.has(r.id)) { changed.add(r.id); if (ctx.onFirstOverlayWrite) ctx.onFirstOverlayWrite(r.id); } } }
    state.opened.push(vfs);
    return vfs;
  }
  return Object.freeze({
    VERSION: 1, RESERVED, ERRORS, VfsError, normalizeSeparators, isFullPath, isUrl, isMachinePath, javaName, javaParent, javaAbsolute,
    nameWithoutExtension, getNameWithoutExtension, updateExtension, addSeparator, formatBytes, aliasPrefixes,
    rootName(existing, name) { let n = name, k = 2; const lc = existing.concat(RESERVED).map((x) => x.toLowerCase()); while (lc.indexOf(n.toLowerCase()) >= 0) n = name + ' (' + (k++) + ')'; return n; },
    hash: { md5: hasher('md5'), sha256: hasher('sha256') },
    open, state
  });
}

// ---------------------------------------------------------------- the booted runtime with the stand-ins
export async function frt(opts = {}) {
  const t = await rt(Object.assign({ vfs: false, packages: ['multi', 'geom', 'roi', 'ana', 'io', 'edit', 'stk'] }, opts.rt || {}));
  const W = t.W;
  const V = makeStandInVFS();
  W.IJMacroVFS = V;
  // the worker has the deflate streams (ROI sets, ZIP entries, PNG): Node's own stand in for them in this realm
  if (typeof globalThis.DecompressionStream === 'function') { W.DecompressionStream = globalThis.DecompressionStream; W.CompressionStream = globalThis.CompressionStream; }
  const saved = [];
  const spec = W.IJOpRegistry.getCommand('macro.run');
  const orig = spec.handler;
  spec.handler = (a, E) => {
    const E2 = Object.create(E);
    if (typeof E.decodeImage !== 'function') {
      E2.decodeImage = async (bytes, o) => {
        if (o.kind === 'tiff') {
          const image = await W.IJTiff.read(bytes, o.name);
          if (!o.plane) return image;
          const k = o.plane - 1, nC = image.rgb ? 1 : image.channels.length, nZ = image.nZ || 1;
          const c = image.rgb ? 0 : k % nC, z = Math.floor(k / nC) % nZ, tt = Math.floor(k / (nC * nZ));
          const chans = image.rgb ? image.channels : [image.channels[c]];
          return Object.assign({}, image, { nZ: 1, nT: 1, hyperstack: false, mode: undefined, channels: chans.map((ch) => Object.assign({}, ch, { planes: [ch.planes[tt * nZ + z]] })) });
        }
        if (o.kind === 'text') {
          const im = W.IJTextIo.parseTextImage(new TextDecoder().decode(bytes));
          return { name: o.name, width: im.width, height: im.height, bitDepth: 32, nZ: 1, nT: 1, rgb: false, hyperstack: false,
            calibration: { pixelWidth: 1, pixelHeight: 1, pixelDepth: 1, unit: 'pixel' },
            channels: [{ name: 'C1', color: '#ffffff', display: { min: 0, max: 255, lut: 'Grays', invert: false }, planes: [im.data] }] };
        }
        const err = new Error('picture'); err.code = 'IJ_IO_DECODE'; throw err;
      };
    }
    // PNG / JPEG need CompressionStream / OffscreenCanvas, which this vm realm does not have: tagged bytes stand in for them
    const realEncode = typeof E.encodeImage === 'function' ? E.encodeImage.bind(E) : null;
    {
      E2.encodeImage = async (docId, o) => {
        if (realEncode && o.format !== 'png' && o.format !== 'jpeg') return realEncode(docId, o);
        if (o.format === 'tiff') return t.ok('doc.exportTiff', { docId });
        return { bytes: enc.encode(o.format.toUpperCase() + ':' + docId + (o.entryName ? ':' + o.entryName : '') + (o.quality ? ':q' + o.quality : '')), rev: 0 };
      };
    }
    if (typeof E.markSaved !== 'function') E2.markSaved = (docId, o) => { saved.push([docId, o]); return {}; };
    return orig(a, E2);
  };
  const grants = [];
  const aliases = [];
  let idSeq = 0;
  let mountId = 'mount0000000000a';
  t.page.texts = [];
  t.page.answers['text.open'] = (a) => { t.page.texts.push([a.title, a.text]); return {}; };
  t.page.answers['window.text'] = (a) => { const w = (t.page.textWindows || {})[a.title]; return w === undefined ? { found: false, text: '' } : { found: true, text: w }; };
  return Object.assign(t, {
    V, saved, grants, aliases,
    disk: makeDisk,
    grant(name, disk, o = {}) {
      const g = { id: (++idSeq).toString(16).padStart(16, '0'), name, kind: 'fsa', target: o.target || 'inplace', mode: o.mode || 'allow', folderName: name,
        handle: disk, async: !!o.async, permission: o.permission, quota: o.quota };
      grants.push(g);
      return g;
    },
    alias(literal, g, ci) { aliases.push({ literal, rootId: g.id, ci: !!ci, createdAt: 0 }); },
    newMount() { mountId = 'mount' + Date.now().toString(16).padStart(11, '0'); },
    runF(source, o = {}) { return t.run(source, Object.assign({ vfs: { roots: grants.slice(), aliases: aliases.slice(), mountId, queue: { folders: 0, files: 0 } } }, o)); }
  });
}
