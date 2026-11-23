/* ij-macro-vfs.js — IJMacroVFS: the virtual file system of ImageJ macros in the Advanced Studio.
 *
 * Contract: DOCS/studio-advanced/macros/FILES.md (§2 paths, §3 roots, §4 this module, §7 policy, §11 delivery).
 * Loaded on the page (pure members only are used there) and in the engine worker as the second `pre` file of package
 * `macro`; a failure of this file withdraws package `macro`, never the engine. Runs unchanged under Node (tests).
 *
 * A macro sees one closed namespace: `/<Root>/<rel>`, `/` separator, no machine path ever. Roots are the folders the user
 * granted (Chromium directory handles, or a snapshot of `File` objects elsewhere), `/tmp/` (OPFS), `/Downloads/` (an OPFS
 * workspace with nothing underneath) and four empty or generated read-only roots. A root that cannot be written in place
 * (Firefox / Safari, or a Chromium folder whose write permission was refused) gets a copy-on-write overlay in OPFS: new and
 * changed files live there, deletions and renames are records over the untouched base, and delivery hands the result back
 * as file links or a STORE ZIP that unzips over the original folder.
 *
 * Every operation is serialised in call order and returns a value or a Promise of it: OPFS files are read and written
 * through synchronous access handles (worker only), so a macro working in `/tmp/` or an overlay suspends only when a handle
 * is first opened. Nothing here touches the network, the Studio library or a dataset: the only storage reached is the
 * user's granted handles and files, and the origin's private file system.
 */
(function (root) {
  'use strict';

  const VERSION = 1;
  const RESERVED = Object.freeze(['tmp', 'home', 'macros', 'luts', 'imagej', 'Downloads']);
  const MAX_READ = 2147483647;
  const CHUNK = 4 * 1024 * 1024;
  const POOL_MAX = 64;
  const STORE_DIR = 'lumen3d-ij-macro';
  const ERRORS = Object.freeze(['VFS_BAD_PATH', 'VFS_NOT_GRANTED', 'VFS_NOT_FOUND', 'VFS_NOT_A_DIR', 'VFS_IS_A_DIR',
    'VFS_EXISTS', 'VFS_READ_ONLY', 'VFS_ASK', 'VFS_PERMISSION', 'VFS_QUOTA', 'VFS_ROOT_DELETE', 'VFS_NOT_EMPTY',
    'VFS_BAD_NAME', 'VFS_GONE', 'VFS_STALE', 'VFS_BUSY', 'VFS_TOO_LARGE', 'VFS_NO_STORAGE', 'VFS_CLOSED', 'VFS_IO']);
  const README_EN = Object.freeze({
    'dlg.mac.files.readme': 'Results of macros run in the Lumen3D Advanced Studio on the folder {name}.\nUnzip this archive where the folder {name} is: every file goes to its place.',
    'dlg.mac.files.readmeManual': 'A ZIP archive cannot delete or rename files. Do it by hand:',
    'dlg.mac.files.readmeDelete': 'delete  {path}',
    'dlg.mac.files.readmeRename': 'rename  {from}  ->  {to}'
  });

  class VfsError extends Error {
    constructor(code, path, details) {
      super(code);
      this.name = 'VfsError';
      this.code = code;
      this.isVfsError = true;
      if (path != null) this.path = path;
      if (details) {
        this.details = details;
        for (const k of Object.keys(details)) if (!(k in this)) this[k] = details[k];
      }
    }
  }
  const fail = (code, path, details) => { throw new VfsError(code, path, details); };
  const isVfsError = (e) => !!(e && e.isVfsError && typeof e.code === 'string');
  const errName = (e) => (e && typeof e.name === 'string' ? e.name : '');
  const isName = (e, ...names) => names.indexOf(errName(e)) >= 0;

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  MaybePromise plumbing: operations are generators that yield values or Promises; drive() runs one synchronously
  //  until the first pending Promise, then continues asynchronously (so a fully synchronous path stays synchronous).
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  function isThenable(v) { return v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function'; }
  function step(gen, val, isErr) {
    for (;;) {
      const r = isErr ? gen.throw(val) : gen.next(val);
      if (r.done) return r.value;
      if (isThenable(r.value)) return Promise.resolve(r.value).then((v) => step(gen, v, false), (e) => step(gen, e, true));
      val = r.value; isErr = false;
    }
  }
  const drive = (gen) => step(gen, undefined, false);
  function then(v, f) { return isThenable(v) ? v.then(f) : f(v); }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  Pure path rules (§2)
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  function normalizeSeparators(s) { return String(s).replace(/\\/g, '/'); }
  function isUrl(s) { const t = normalizeSeparators(s); return t.indexOf('://') >= 0 || t.toLowerCase().indexOf('file:/') >= 0; }
  function isFullPath(s) { const t = normalizeSeparators(s); return t.startsWith('/') || t.indexOf(':/') >= 0; }
  function isMachinePath(s) { const t = normalizeSeparators(s); return /^[A-Za-z]:\//.test(t) || t.startsWith('//'); }

  /* java.io.File on Unix: duplicate separators collapsed, a trailing separator dropped (except "/" itself). */
  function javaNorm(s) {
    let t = normalizeSeparators(s).replace(/\/{2,}/g, '/');
    if (t.length > 1 && t.endsWith('/')) t = t.slice(0, -1);
    return t;
  }
  function javaName(s) { const t = javaNorm(s); return t.slice(t.lastIndexOf('/') + 1); }
  function javaParent(s) {
    const t = javaNorm(s);
    const prefix = t.startsWith('/') ? 1 : 0;
    const i = t.lastIndexOf('/');
    if (i < prefix) return prefix > 0 && t.length > prefix ? t.slice(0, prefix) : null;
    return t.slice(0, i);
  }
  function javaAbsolute(s) {
    const t = javaNorm(s);
    if (isFullPath(t)) return t;
    return t === '' ? '/home' : '/home/' + t;
  }
  /* Functions.nameWithoutExtension: only an extension of at most four characters is cut. */
  function nameWithoutExtension(name) {
    if (name == null) return '';
    const n = String(name);
    const dot = n.lastIndexOf('.');
    return dot >= 0 && n.length - dot <= 5 ? n.slice(0, dot) : n;
  }
  function getNameWithoutExtension(s) {
    const n = javaName(s);
    const dot = n.lastIndexOf('.');
    return dot >= 0 ? n.slice(0, dot) : n;
  }
  /* IJ.updateExtension 1.54p with File.separator = "/". */
  function updateExtension(path, ext) {
    if (path == null) return null;
    let p = String(path);
    const dot = p.lastIndexOf('.');
    const sep = p.lastIndexOf('/');
    if (dot >= 0 && dot > sep && p.length - dot <= 5) {
      if (dot + 1 < p.length && p.charCodeAt(dot + 1) >= 48 && p.charCodeAt(dot + 1) <= 57) p += ext;
      else p = p.slice(0, dot) + ext;
    } else p += ext;
    return p;
  }
  /* IJ.addSeparator 1.54p on a platform that is not Windows. */
  function addSeparator(path) {
    if (path == null) return null;
    const p = String(path);
    return p.length > 0 && !p.endsWith('/') ? p + '/' : p;
  }
  function rootName(existingNames, folderName) {
    let base = String(folderName == null ? '' : folderName).replace(/[\/\\\u0000-\u001f]/g, '_').trim();
    if (!base || base === '.' || base === '..') base = 'Files';
    const taken = new Set();
    for (const n of existingNames || []) taken.add(String(n).toLowerCase());
    for (const n of RESERVED) taken.add(n.toLowerCase());
    if (!taken.has(base.toLowerCase())) return base;
    for (let k = 2; ; k++) {
      const c = base + ' (' + k + ')';
      if (!taken.has(c.toLowerCase())) return c;
    }
  }

  function collapse(str) {
    const out = [];
    for (const seg of str.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { if (out.length) out.pop(); continue; }
      out.push(seg);
    }
    return out;
  }
  /* The fixed head of a machine path that `..` never climbs above: "C:/", "//host/share/", "x:/", "/". */
  function machineHead(s) {
    if (/^[A-Za-z]:\//.test(s)) return s.slice(0, 3);
    if (s.startsWith('//')) {
      const parts = s.slice(2).split('/');
      if (parts.length >= 2 && parts[0] && parts[1]) return '//' + parts[0] + '/' + parts[1] + '/';
      return '//' + (parts[0] || '') + (parts[0] ? '/' : '');
    }
    const k = s.indexOf(':/');
    if (k >= 0 && !s.startsWith('/')) return s.slice(0, k + 2);
    return '/';
  }
  function canonMachine(s) {
    const head = machineHead(s);
    const segs = collapse(s.slice(head.length));
    return head + segs.join('/') + (segs.length && s.endsWith('/') ? '/' : '');
  }
  function dirOf(s) { return s.endsWith('/') ? s : s.slice(0, s.lastIndexOf('/') + 1); }
  function aliasPrefixes(literalDir) {
    let s = normalizeSeparators(literalDir);
    if (!s.endsWith('/')) s += '/';
    if (!isFullPath(s)) return [s];
    s = canonMachine(s);
    if (!s.endsWith('/')) s += '/';
    let head = machineHead(s);
    const segs = collapse(s.slice(head.length));
    let keep = 0;
    if (head === '/') { if (!segs.length) return [s]; head = '/' + segs[0] + '/'; keep = 1; }
    const out = [];
    for (let n = segs.length; n >= keep; n--) {
      const rest = segs.slice(keep, n);
      out.push(head + (rest.length ? rest.join('/') + '/' : ''));
    }
    return out;
  }
  function formatBytes(n) {
    let v = Number(n);
    if (!(v > 0)) return '0 B';
    if (v < 1000) return Math.round(v) + ' B';
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let u = 0;
    v /= 1000;
    while (v >= 999.95 && u < units.length - 1) { v /= 1000; u++; }
    return v.toFixed(1) + ' ' + units[u];
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  CRC-32 (slicing by 8), MD5, SHA-256 — streaming
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  const CRC_T = (() => {
    const t = [];
    const t0 = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t0[n] = c >>> 0;
    }
    t.push(t0);
    for (let k = 1; k < 8; k++) {
      const p = t[k - 1], q = new Uint32Array(256);
      for (let n = 0; n < 256; n++) q[n] = (p[n] >>> 8) ^ t0[p[n] & 255];
      t.push(q);
    }
    return t;
  })();
  const crc32 = Object.freeze({
    update(crc, data) {
      const b = toU8(data);
      const [T0, T1, T2, T3, T4, T5, T6, T7] = CRC_T;
      let c = crc >>> 0, i = 0;
      const n = b.length, n8 = n - 8;
      while (i <= n8) {
        c ^= b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
        c = T7[c & 255] ^ T6[(c >>> 8) & 255] ^ T5[(c >>> 16) & 255] ^ T4[c >>> 24] ^
          T3[b[i + 4]] ^ T2[b[i + 5]] ^ T1[b[i + 6]] ^ T0[b[i + 7]];
        i += 8;
      }
      while (i < n) c = T0[(c ^ b[i++]) & 255] ^ (c >>> 8);
      return c >>> 0;
    },
    done(crc) { return (crc ^ 0xffffffff) >>> 0; }
  });

  /* A 64-byte block hasher with the message length kept as a Number (exact below 2^53 bytes). */
  function blockHasher(init, compress, finishWords, bigEndian) {
    const st = init.slice();
    const buf = new Uint8Array(64);
    const dv = new DataView(buf.buffer);
    let fill = 0, total = 0;
    return {
      update(data) {
        const b = toU8(data);
        total += b.length;
        let i = 0;
        if (fill) {
          const k = Math.min(64 - fill, b.length);
          buf.set(b.subarray(0, k), fill); fill += k; i = k;
          if (fill < 64) return this;
          compress(st, dv, 0); fill = 0;
        }
        if (b.length - i >= 64) {
          const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
          for (; b.length - i >= 64; i += 64) compress(st, v, i);
        }
        if (i < b.length) { buf.set(b.subarray(i), 0); fill = b.length - i; }
        return this;
      },
      hex() {
        const bits = total * 8;
        const tail = new Uint8Array(((fill + 9 + 63) >> 6) << 6);
        tail.set(buf.subarray(0, fill));
        tail[fill] = 0x80;
        const tv = new DataView(tail.buffer);
        const hi = Math.floor(bits / 4294967296) >>> 0, lo = bits >>> 0;
        if (bigEndian) { tv.setUint32(tail.length - 8, hi); tv.setUint32(tail.length - 4, lo); }
        else { tv.setUint32(tail.length - 8, lo, true); tv.setUint32(tail.length - 4, hi, true); }
        const s = st.slice();
        for (let o = 0; o < tail.length; o += 64) compress(s, tv, o);
        return finishWords(s);
      }
    };
  }
  const hex8 = (w) => (w >>> 0).toString(16).padStart(8, '0');
  const MD5_K = new Int32Array(64).map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0);
  const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  function md5Compress(st, v, o) {
    let a = st[0], b = st[1], c = st[2], d = st[3];
    for (let i = 0; i < 64; i++) {
      let f, g;
      const r = i >> 4;
      if (r === 0) { f = (b & c) | (~b & d); g = i; }
      else if (r === 1) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (r === 2) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      const tmp = d; d = c; c = b;
      const x = (a + f + MD5_K[i] + v.getInt32(o + 4 * g, true)) | 0;
      const s = MD5_S[(r << 2) | (i & 3)];
      b = (b + ((x << s) | (x >>> (32 - s)))) | 0;
      a = tmp;
    }
    st[0] = (st[0] + a) | 0; st[1] = (st[1] + b) | 0; st[2] = (st[2] + c) | 0; st[3] = (st[3] + d) | 0;
  }
  function md5Finish(st) {
    let out = '';
    for (const w of st) for (let k = 0; k < 4; k++) out += ((w >>> (8 * k)) & 255).toString(16).padStart(2, '0');
    return out;
  }
  const SHA_K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  const SHA_W = new Int32Array(64);
  function shaCompress(st, v, o) {
    const w = SHA_W;
    for (let i = 0; i < 16; i++) w[i] = v.getInt32(o + 4 * i, false);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = st[0], b = st[1], c = st[2], d = st[3], e = st[4], f = st[5], g = st[6], h = st[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    st[0] = (st[0] + a) | 0; st[1] = (st[1] + b) | 0; st[2] = (st[2] + c) | 0; st[3] = (st[3] + d) | 0;
    st[4] = (st[4] + e) | 0; st[5] = (st[5] + f) | 0; st[6] = (st[6] + g) | 0; st[7] = (st[7] + h) | 0;
  }
  const hash = Object.freeze({
    md5: () => blockHasher(new Int32Array([0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476]), md5Compress, md5Finish, false),
    sha256: () => blockHasher(new Int32Array([0x6a09e667, 0xbb67ae85 | 0, 0x3c6ef372, 0xa54ff53a | 0, 0x510e527f, 0x9b05688c | 0,
      0x1f83d9ab, 0x5be0cd19]), shaCompress, (st) => Array.from(st, hex8).join(''), true)
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  Bytes
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(s));
    const out = [];
    const str = String(s);
    for (let i = 0; i < str.length; i++) {
      let c = str.codePointAt(i);
      if (c > 0xffff) i++;
      if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }
  function utf8Decode(b) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(b);
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return decodeURIComponent(escape(s));
  }
  /* Typed arrays may come from another realm (a test harness, a structured clone): never `instanceof`. */
  function toU8(x) {
    if (x == null) return new Uint8Array(0);
    if (typeof x === 'string') return utf8(x);
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    if (Object.prototype.toString.call(x) === '[object ArrayBuffer]') return new Uint8Array(x);
    throw new VfsError('VFS_IO', null, { reason: 'data' });
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  ZIP writer (§11.2): STORE, sizes known in advance, CRC patched in the local header, ZIP64 when needed
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  function dosDateTime(ms) {
    const d = new Date(Number(ms));
    const y = d.getFullYear();
    if (!(y === y) || y < 1980) return { time: 0, date: (1 << 5) | 1 };
    if (y > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 };
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }
  function le(n, bytes) {
    const out = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) out[i] = Math.floor(n / Math.pow(256, i)) & 255;
    return out;
  }
  function concat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  const MADE_BY = (3 << 8) | 45;

  function zipCreate(sink, opts) {
    const o = opts || {};
    const now = typeof o.now === 'function' ? o.now : () => Date.now();
    // Test-only knobs: the same code paths as a real 4 GiB entry or 65 535 entries, at a size a test can afford.
    const lim = o.testLimits || {};
    const SIZE_LIM = lim.size != null ? lim.size : 0xffffffff;
    const OFF_LIM = lim.offset != null ? lim.offset : 0xffffffff;
    const COUNT_LIM = lim.count != null ? lim.count : 0xffff;
    const cd = [];
    let open = null, finished = false, anyZip64 = false;

    function add(name, info) {
      if (finished) fail('VFS_IO', null, { reason: 'zip finished' });
      if (open) fail('VFS_IO', null, { reason: 'zip entry open' });
      const nm = String(name);
      if (!nm || nm.indexOf('\u0000') >= 0 || nm.startsWith('/') || nm.indexOf('\\') >= 0) fail('VFS_BAD_NAME', nm);
      const nb = utf8(nm);
      if (nb.length > 0xffff) fail('VFS_BAD_NAME', nm);
      const dir = nm.endsWith('/');
      const size = dir ? 0 : Math.max(0, Math.floor(Number(info && info.size) || 0));
      const { time, date } = dosDateTime(info && info.mtime != null ? info.mtime : now());
      const offset = sink.position();
      const big = size >= SIZE_LIM;
      if (big) anyZip64 = true;
      const extra = big ? concat([le(1, 2), le(16, 2), le(size, 8), le(size, 8)]) : new Uint8Array(0);
      const head = concat([le(0x04034b50, 4), le(big ? 45 : 20, 2), le(0x0800, 2), le(0, 2), le(time, 2), le(date, 2),
        le(0, 4), le(big ? 0xffffffff : size, 4), le(big ? 0xffffffff : size, 4), le(nb.length, 2), le(extra.length, 2), nb, extra]);
      sink.write(head);
      const rec = { nb, size, offset, time, date, dir, crc: 0, big };
      let written = 0, crc = 0xffffffff;
      const entry = {
        write(data) {
          if (open !== entry) fail('VFS_IO', nm, { reason: 'zip entry closed' });
          const b = toU8(data);
          if (written + b.length > size) fail('VFS_IO', nm, { reason: 'zip entry size' });
          crc = crc32.update(crc, b);
          written += b.length;
          if (b.length) sink.write(b);
        },
        end() {
          if (open !== entry) fail('VFS_IO', nm, { reason: 'zip entry closed' });
          if (written !== size) fail('VFS_IO', nm, { reason: 'zip entry size' });
          rec.crc = crc32.done(crc);
          sink.writeAt(offset + 14, le(rec.crc, 4));
          cd.push(rec);
          open = null;
        }
      };
      open = entry;
      return entry;
    }
    function addBytes(name, data, mtime) {
      const b = toU8(data);
      const e = add(name, { size: b.length, mtime });
      e.write(b);
      e.end();
    }
    function finish() {
      if (open) fail('VFS_IO', null, { reason: 'zip entry open' });
      if (finished) fail('VFS_IO', null, { reason: 'zip finished' });
      finished = true;
      const cdStart = sink.position();
      for (const r of cd) {
        const bigOff = r.offset >= OFF_LIM;
        const parts = [];
        if (r.big) parts.push(le(r.size, 8), le(r.size, 8));
        if (bigOff) parts.push(le(r.offset, 8));
        const body = concat(parts);
        const extra = body.length ? concat([le(1, 2), le(body.length, 2), body]) : body;
        if (extra.length) anyZip64 = true;
        const ext = r.dir ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0;
        sink.write(concat([le(0x02014b50, 4), le(MADE_BY, 2), le(extra.length ? 45 : 20, 2), le(0x0800, 2), le(0, 2),
          le(r.time, 2), le(r.date, 2), le(r.crc, 4), le(r.big ? 0xffffffff : r.size, 4), le(r.big ? 0xffffffff : r.size, 4),
          le(r.nb.length, 2), le(extra.length, 2), le(0, 2), le(0, 2), le(0, 2), le(ext, 4),
          le(bigOff ? 0xffffffff : r.offset, 4), r.nb, extra]));
      }
      const cdEnd = sink.position();
      const cdSize = cdEnd - cdStart;
      const z64 = cd.length >= COUNT_LIM || cdStart >= OFF_LIM || cdSize >= OFF_LIM;
      if (z64) {
        anyZip64 = true;
        sink.write(concat([le(0x06064b50, 4), le(44, 8), le(MADE_BY, 2), le(45, 2), le(0, 4), le(0, 4),
          le(cd.length, 8), le(cd.length, 8), le(cdSize, 8), le(cdStart, 8)]));
        sink.write(concat([le(0x07064b50, 4), le(0, 4), le(cdEnd, 8), le(1, 4)]));
      }
      sink.write(concat([le(0x06054b50, 4), le(0, 2), le(0, 2), le(z64 ? 0xffff : cd.length, 2), le(z64 ? 0xffff : cd.length, 2),
        le(z64 ? 0xffffffff : cdSize, 4), le(z64 ? 0xffffffff : cdStart, 4), le(0, 2)]));
      return { entries: cd.length, bytes: sink.position(), zip64: anyZip64 };
    }
    return { add, addBytes, finish };
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  Rel paths (inside a root, '' = the root itself)
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  const parentRel = (rel) => { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); };
  const baseName = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
  const joinRel = (a, b) => (a ? a + '/' + b : b);
  const under = (p, a) => p === a || p.startsWith(a + '/');
  const depth = (rel) => (rel ? rel.split('/').length : 0);
  const DIR = () => ({ kind: 'dir', size: 0, mtime: 0 });
  function safeRel(s) {
    if (typeof s !== 'string') return null;
    const t = normalizeSeparators(s).replace(/^\/+|\/+$/g, '');
    if (t.indexOf('\u0000') >= 0) return null;
    const segs = t.split('/');
    for (const g of segs) if (g === '' || g === '.' || g === '..') return t === '' ? '' : null;
    return t;
  }
  function entriesOf(dirHandle) {
    return (async () => {
      const out = [];
      const it = typeof dirHandle.entries === 'function' ? dirHandle.entries() : dirHandle[Symbol.asyncIterator]();
      for (;;) {
        const r = await it.next();
        if (r.done) break;
        out.push(r.value);
      }
      return out;
    })();
  }
  function readerOf(file, path) {
    const size = file.size;
    return {
      size,
      read(offset, length) {
        const off = Math.max(0, Math.min(size, Number(offset) || 0));
        const len = length == null || length < 0 ? size - off : Math.min(length, size - off);
        const blob = file.slice(off, off + len);
        const FRS = root.FileReaderSync;
        if (typeof FRS === 'function') {
          try { return new Uint8Array(new FRS().readAsArrayBuffer(blob)); }
          catch (e) { throw readError(e, path); }
        }
        return blob.arrayBuffer().then((ab) => new Uint8Array(ab), (e) => { throw readError(e, path); });
      },
      close() {}
    };
  }
  function readError(e, path) {
    if (isVfsError(e)) return e;
    if (isName(e, 'NotReadableError', 'NotFoundError')) return new VfsError('VFS_GONE', path);
    return e;
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  OPFS: shared store, sync access handle pool, trees
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  function SahPool() { this.map = new Map(); this.pending = new Map(); }
  SahPool.prototype.get = function (key, fh) {
    const e = this.map.get(key);
    if (e) { this.map.delete(key); this.map.set(key, e); return e; }
    if (this.pending.has(key)) return this.pending.get(key);
    const p = (async () => {
      while (this.map.size >= POOL_MAX) {
        const first = this.map.keys().next().value;
        this.close(first);
      }
      const s = await fh.createSyncAccessHandle();
      this.map.set(key, s);
      return s;
    })();
    const done = () => { if (this.pending.get(key) === p) this.pending.delete(key); };
    p.then(done, done);
    this.pending.set(key, p);
    return p;
  };
  SahPool.prototype.close = function (key) {
    const s = this.map.get(key);
    if (!s) return;
    this.map.delete(key);
    try { s.flush(); } catch (_) { /* a handle that failed still closes */ }
    try { s.close(); } catch (_) { /* already closed */ }
  };
  SahPool.prototype.closeUnder = function (prefix) {
    for (const k of Array.from(this.map.keys())) if (k === prefix || k.startsWith(prefix + '/')) this.close(k);
  };
  SahPool.prototype.closeAll = function () { for (const k of Array.from(this.map.keys())) this.close(k); };

  const hasSync = (fh) => !!fh && typeof fh.createSyncAccessHandle === 'function';

  /* One directory of OPFS seen as a tree with an in-memory index (kind, size, mtime). */
  function OpfsTree(store, segs, hidden) {
    this.store = store;
    this.segs = segs;
    this.key = segs.join('/');
    this.hidden = hidden || null;
    this.reset();
  }
  OpfsTree.prototype.reset = function () {
    this.idx = new Map([['', DIR()]]);
    this.kids = new Map([['', new Map()]]);
    this.dh = new Map();
    this.fh = new Map();
  };
  OpfsTree.prototype._add = function (rel, meta) {
    if (rel === '') return;
    const p = parentRel(rel);
    if (!this.idx.has(p)) this._add(p, DIR());
    this.idx.set(rel, meta);
    let k = this.kids.get(p);
    if (!k) { k = new Map(); this.kids.set(p, k); }
    k.set(baseName(rel), true);
    if (meta.kind === 'dir' && !this.kids.has(rel)) this.kids.set(rel, new Map());
  };
  OpfsTree.prototype._del = function (rel) {
    for (const k of Array.from(this.idx.keys())) if (k !== '' && under(k, rel)) { this.idx.delete(k); this.kids.delete(k); }
    for (const k of Array.from(this.dh.keys())) if (k !== '' && under(k, rel)) this.dh.delete(k);
    for (const k of Array.from(this.fh.keys())) if (under(k, rel)) this.fh.delete(k);
    const pk = this.kids.get(parentRel(rel));
    if (pk) pk.delete(baseName(rel));
  };
  OpfsTree.prototype.sahKey = function (rel) { return this.key + '/' + rel; };
  OpfsTree.prototype.dir = function* (rel, create) {
    const c = this.dh.get(rel);
    if (c) return c;
    let h;
    if (rel === '') {
      h = this.store.dir;
      for (const s of this.segs) h = yield h.getDirectoryHandle(s, { create: true });
    } else {
      const p = yield* this.dir(parentRel(rel), create);
      h = yield p.getDirectoryHandle(baseName(rel), create ? { create: true } : undefined);
      if (create && !this.idx.has(rel)) this._add(rel, DIR());
    }
    this.dh.set(rel, h);
    return h;
  };
  OpfsTree.prototype.file = function* (rel, create) {
    const c = this.fh.get(rel);
    if (c) return c;
    const p = yield* this.dir(parentRel(rel), !!create);
    const h = yield p.getFileHandle(baseName(rel), create ? { create: true } : undefined);
    this.fh.set(rel, h);
    return h;
  };
  OpfsTree.prototype.load = function* () {
    this.reset();
    const walk = function* (tree, rel, handle) {
      const list = yield entriesOf(handle);
      for (const [name, h] of list) {
        if (rel === '' && tree.hidden && tree.hidden.has(name)) continue;
        const r = joinRel(rel, name);
        if (h.kind === 'directory') { tree._add(r, DIR()); tree.dh.set(r, h); yield* walk(tree, r, h); }
        else {
          const f = yield h.getFile();
          tree._add(r, { kind: 'file', size: f.size, mtime: f.lastModified || 0 });
          tree.fh.set(r, h);
        }
      }
    };
    const top = yield* this.dir('', true);
    yield* walk(this, '', top);
  };
  OpfsTree.prototype.stat = function (rel) {
    const m = this.idx.get(rel);
    return m ? { kind: m.kind, size: m.size, mtime: m.mtime } : null;
  };
  OpfsTree.prototype.list = function (rel) {
    const m = this.idx.get(rel);
    if (!m || m.kind !== 'dir') return null;
    const out = [];
    for (const name of (this.kids.get(rel) || new Map()).keys()) out.push({ name, kind: this.idx.get(joinRel(rel, name)).kind });
    return out;
  };
  OpfsTree.prototype.mkdirs = function* (rel) {
    if (rel === '') { yield* this.dir('', true); return; }
    yield* this.dir(rel, true);
    if (!this.idx.has(rel)) this._add(rel, DIR());
  };
  OpfsTree.prototype.openRead = function* (rel, path) {
    const m = this.idx.get(rel);
    if (!m) fail('VFS_NOT_FOUND', path);
    if (m.kind === 'dir') fail('VFS_IS_A_DIR', path);
    const fh = yield* this.file(rel, false);
    const store = this.store, key = this.sahKey(rel);
    if (!hasSync(fh)) { const f = yield fh.getFile(); return readerOf(f, path); }
    const size = m.size;
    return {
      size,
      read(offset, length) {
        const off = Math.max(0, Math.min(size, Number(offset) || 0));
        const len = length == null || length < 0 ? size - off : Math.min(length, size - off);
        return then(store.pool.get(key, fh), (sah) => {
          const out = new Uint8Array(len);
          const got = len ? sah.read(out, { at: off }) : 0;
          return got === len ? out : out.subarray(0, got);
        });
      },
      close() {}
    };
  };
  /* A writer: write(u8) → MaybePromise, close() → MaybePromise, abort(). */
  OpfsTree.prototype.writer = function* (rel, append) {
    yield* this.mkdirs(parentRel(rel));
    const fh = yield* this.file(rel, true);
    const tree = this, store = this.store, key = this.sahKey(rel);
    const settle = (size) => tree._add(rel, { kind: 'file', size, mtime: store.now() });
    if (hasSync(fh)) {
      const sah = yield store.pool.get(key, fh);
      if (!append) sah.truncate(0);
      let pos = append ? sah.getSize() : 0;
      settle(pos);
      return {
        write(data) {
          const b = toU8(data);
          return then(store.pool.get(key, fh), (s) => {
            let n;
            try { n = s.write(b, { at: pos }); }
            catch (e) { const sz = s.getSize(); if (sz > pos) { store.written += sz - pos; pos = sz; } settle(pos); throw e; }
            pos += n; store.written += n; settle(pos);
            if (n < b.length) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
          });
        },
        close() { return then(store.pool.get(key, fh), (s) => { s.flush(); settle(s.getSize()); }); },
        abort() { settle(pos); }
      };
    }
    const w = yield fh.createWritable({ keepExistingData: !!append });
    let pos = 0;
    if (append) { const f = yield fh.getFile(); pos = f.size; yield (typeof w.seek === 'function' ? w.seek(pos) : w.write({ type: 'seek', position: pos })); }
    const start = pos;
    return {
      write(data) { const b = toU8(data); return w.write(b).then(() => { pos += b.length; }); },
      close() { return w.close().then(() => { store.written += pos - start; settle(pos); }); },
      abort() { try { const a = w.abort(); if (isThenable(a)) a.then(null, () => {}); } catch (_) { /* nothing to undo */ } }
    };
  };
  OpfsTree.prototype.remove = function* (rel) {
    this.store.pool.closeUnder(this.sahKey(rel));
    const p = yield* this.dir(parentRel(rel), false);
    yield p.removeEntry(baseName(rel), { recursive: true });
    this._del(rel);
  };
  OpfsTree.prototype.move = function* (a, b) {
    const m = this.idx.get(a);
    if (!m) return;
    if (m.kind === 'file') {
      this.store.pool.close(this.sahKey(a));
      const fh = yield* this.file(a, false);
      yield* this.mkdirs(parentRel(b));
      let moved = false;
      if (typeof fh.move === 'function') {
        try {
          const dest = yield* this.dir(parentRel(b), true);
          yield fh.move(dest, baseName(b));
          moved = true;
        } catch (e) { if (isName(e, 'QuotaExceededError', 'NoModificationAllowedError')) throw e; }
      }
      if (!moved) {
        const r = yield* this.openRead(a, a);
        const w = yield* this.writer(b, false);
        yield* pump(w, r);
        this.store.pool.close(this.sahKey(b));
        yield* this.remove(a);
      } else {
        this._del(a);
      }
      this._add(b, { kind: 'file', size: m.size, mtime: m.mtime });
      return;
    }
    yield* this.mkdirs(b);
    for (const name of Array.from((this.kids.get(a) || new Map()).keys())) yield* this.move(joinRel(a, name), joinRel(b, name));
    yield* this.remove(a);
  };
  OpfsTree.prototype.setMtime = function (rel, ms) { const m = this.idx.get(rel); if (m && m.kind === 'file') m.mtime = Number(ms) || 0; };
  OpfsTree.prototype.bytes = function () { let n = 0; for (const m of this.idx.values()) if (m.kind === 'file') n += m.size; return n; };

  function* pump(w, src) {
    try {
      if (Array.isArray(src)) {
        for (const c of src) { const b = toU8(c); if (b.length) yield w.write(b); }
      } else {
        for (let off = 0; off < src.size;) {
          const c = yield src.read(off, Math.min(CHUNK, src.size - off));
          if (!c.length) break;
          yield w.write(c);
          off += c.length;
        }
      }
      yield w.close();
    } catch (e) {
      try { if (w.abort) w.abort(); } catch (_) { /* the first error is the one reported */ }
      throw e;
    }
  }

  /*
   * Small JSON records of OPFS (a workspace manifest, the /tmp/ times) in two slots, `name` and `name + '.1'`, each carrying a
   * sequence number `seq`: a write replaces the OLDER slot, so a write cut short (quota, a worker killed between the truncate and
   * the write) leaves the newer record whole. The reader takes the parseable slot of the highest `seq` (a record without one, as
   * written before the two slots, counts 0).
   */
  const JSON_SLOTS = (name) => [name, name + '.1'];
  function* readJson(store, segs, name) {
    let d = store.dir;
    for (const s of segs) d = yield d.getDirectoryHandle(s, { create: true });
    const slots = JSON_SLOTS(name);
    let best = null;
    for (let k = 0; k < slots.length; k++) {
      let v;
      try {
        const fh = yield d.getFileHandle(slots[k]);
        const f = yield fh.getFile();
        const text = f.text ? yield f.text() : utf8Decode(new Uint8Array(yield f.arrayBuffer()));
        v = JSON.parse(text);
      } catch (e) {
        if (isName(e, 'NotFoundError')) continue;
        if (e instanceof SyntaxError || isName(e, 'SyntaxError')) { console.error('[IJMacroVFS] unreadable ' + segs.concat([slots[k]]).join('/'), e); continue; }
        throw e;
      }
      const seq = v && typeof v === 'object' && Number.isInteger(v.seq) ? v.seq : 0;
      if (!best || seq > best.seq) best = { v, seq, k };
    }
    store.json.set(segs.concat([name]).join('/'), best ? { seq: best.seq, k: best.k } : { seq: 0, k: 1 });
    return best ? best.v : null;
  }
  function* writeJson(store, segs, name, value) {
    const id = segs.concat([name]).join('/');
    if (!store.json.has(id)) yield* readJson(store, segs, name);
    const last = store.json.get(id);
    const k = 1 - last.k, seq = last.seq + 1;
    let d = store.dir;
    for (const s of segs) d = yield d.getDirectoryHandle(s, { create: true });
    const slot = JSON_SLOTS(name)[k];
    const fh = yield d.getFileHandle(slot, { create: true });
    const bytes = utf8(JSON.stringify(Object.assign({}, value, { seq })));
    if (hasSync(fh)) {
      const key = '#' + segs.join('/') + '/' + slot;
      const sah = yield store.pool.get(key, fh);
      try {
        sah.truncate(0);
        const n = sah.write(bytes, { at: 0 });
        if (n < bytes.length) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
        sah.flush();
      } finally { store.pool.close(key); }
    } else {
      const w = yield fh.createWritable({ keepExistingData: false });
      yield w.write(bytes);
      yield w.close();
    }
    store.json.set(id, { seq, k });
  }
  function* removeJson(store, segs, name) {
    let d = store.dir;
    for (const s of segs) d = yield d.getDirectoryHandle(s, { create: true });
    for (const slot of JSON_SLOTS(name)) {
      try { yield d.removeEntry(slot); } catch (e) { if (!isName(e, 'NotFoundError')) throw e; }
    }
    store.json.delete(segs.concat([name]).join('/'));
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  Bases (read side of a root)
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  function SnapshotBase(snap) {
    this.stale = !snap;
    this.files = new Map();
    this.dirs = new Map([['', []]]);
    if (!snap) return;
    const addDir = (rel) => {
      if (this.dirs.has(rel)) return;
      const p = parentRel(rel);
      addDir(p);
      this.dirs.set(rel, []);
      this.dirs.get(p).push(baseName(rel));
    };
    const rels = snap.rels || [], files = snap.files || [];
    for (let i = 0; i < rels.length; i++) {
      const rel = safeRel(rels[i]);
      if (!rel || !files[i] || this.files.has(rel) || this.dirs.has(rel)) continue;
      let clash = false;
      for (let p = parentRel(rel); p && !clash; p = parentRel(p)) clash = this.files.has(p);
      if (clash) continue;
      addDir(parentRel(rel));
      this.files.set(rel, files[i]);
      this.dirs.get(parentRel(rel)).push(baseName(rel));
    }
    for (const d of snap.dirs || []) { const rel = safeRel(d); if (rel != null && rel !== '' && !this.files.has(rel)) addDir(rel); }
  }
  SnapshotBase.prototype.stat = function* (q) {
    const f = this.files.get(q);
    if (f) return { kind: 'file', size: f.size, mtime: Number(f.lastModified) || 0 };
    return this.dirs.has(q) ? DIR() : null;
  };
  SnapshotBase.prototype.list = function* (q) {
    const d = this.dirs.get(q);
    if (!d) return null;
    return d.map((name) => ({ name, kind: this.files.has(joinRel(q, name)) ? 'file' : 'dir' }));
  };
  SnapshotBase.prototype.openRead = function* (q, path) {
    const f = this.files.get(q);
    if (!f) fail(this.dirs.has(q) ? 'VFS_IS_A_DIR' : 'VFS_NOT_FOUND', path);
    return readerOf(f, path);
  };

  function EntriesBase(entries) {
    this.map = new Map();
    for (const e of entries || []) if (e && e.handle && safeRel(e.name) && e.name.indexOf('/') < 0) this.map.set(e.name, e);
  }
  EntriesBase.prototype.stat = function* (q) {
    if (q === '') return DIR();
    const e = this.map.get(q);
    if (!e) return null;
    try { const f = yield e.handle.getFile(); return { kind: 'file', size: f.size, mtime: f.lastModified || 0 }; }
    catch (err) { if (isName(err, 'NotFoundError')) return null; throw err; }
  };
  EntriesBase.prototype.list = function* (q) {
    if (q !== '') return null;
    return Array.from(this.map.keys(), (name) => ({ name, kind: 'file' }));
  };
  EntriesBase.prototype.openRead = function* (q, path) {
    const e = this.map.get(q);
    if (!e) fail(q === '' ? 'VFS_IS_A_DIR' : 'VFS_NOT_FOUND', path);
    const f = yield e.handle.getFile();
    return readerOf(f, path);
  };

  /* A Chromium directory handle. Async throughout; handles cached per Vfs. */
  function FsaBackend(handle) { this.h = handle; this.dh = new Map([['', handle]]); this.fh = new Map(); }
  FsaBackend.prototype.forget = function (rel) {
    for (const k of Array.from(this.dh.keys())) if (k !== '' && under(k, rel)) this.dh.delete(k);
    for (const k of Array.from(this.fh.keys())) if (under(k, rel)) this.fh.delete(k);
  };
  FsaBackend.prototype.dir = function* (rel, create) {
    const c = this.dh.get(rel);
    if (c) return c;
    const p = yield* this.dir(parentRel(rel), false);
    const h = yield p.getDirectoryHandle(baseName(rel), create ? { create: true } : undefined);
    this.dh.set(rel, h);
    return h;
  };
  FsaBackend.prototype.fileH = function* (rel) {
    const c = this.fh.get(rel);
    if (c) return c;
    const p = yield* this.dir(parentRel(rel), false);
    const h = yield p.getFileHandle(baseName(rel));
    this.fh.set(rel, h);
    return h;
  };
  FsaBackend.prototype.stat = function* (rel) {
    if (rel === '') return DIR();
    let p;
    try { p = yield* this.dir(parentRel(rel), false); }
    catch (e) { if (isName(e, 'NotFoundError', 'TypeMismatchError', 'TypeError')) return null; throw e; }
    const name = baseName(rel);
    try {
      const fh = yield p.getFileHandle(name);
      this.fh.set(rel, fh);
      const f = yield fh.getFile();
      return { kind: 'file', size: f.size, mtime: f.lastModified || 0 };
    } catch (e) {
      if (isName(e, 'TypeMismatchError')) {
        try { const d = yield p.getDirectoryHandle(name); this.dh.set(rel, d); return DIR(); }
        catch (e2) { if (isName(e2, 'NotFoundError', 'TypeMismatchError')) return null; throw e2; }
      }
      if (isName(e, 'NotFoundError', 'TypeError')) return null;
      throw e;
    }
  };
  FsaBackend.prototype.list = function* (rel) {
    let d;
    try { d = yield* this.dir(rel, false); }
    catch (e) { if (isName(e, 'NotFoundError', 'TypeMismatchError', 'TypeError')) return null; throw e; }
    const list = yield entriesOf(d);
    return list.map(([name, h]) => ({ name, kind: h.kind === 'directory' ? 'dir' : 'file' }));
  };
  FsaBackend.prototype.openRead = function* (rel, path) {
    let fh;
    try { fh = yield* this.fileH(rel); }
    catch (e) {
      if (isName(e, 'TypeMismatchError')) fail('VFS_IS_A_DIR', path);
      if (isName(e, 'NotFoundError')) fail('VFS_NOT_FOUND', path);
      throw e;
    }
    let f;
    try { f = yield fh.getFile(); } catch (e) { throw readError(e, path); }
    return readerOf(f, path);
  };
  /* F8: write straight into the target; the browser swaps the new content in only at close(). */
  FsaBackend.prototype.writer = function* (rel, append) {
    const p = yield* this.dir(parentRel(rel), false);
    const fh = yield p.getFileHandle(baseName(rel), { create: true });
    this.fh.set(rel, fh);
    const w = yield fh.createWritable({ keepExistingData: !!append });
    if (append) {
      const f = yield fh.getFile();
      yield (typeof w.seek === 'function' ? w.seek(f.size) : w.write({ type: 'seek', position: f.size }));
    }
    return {
      write: (b) => w.write(b),
      close: () => w.close(),
      abort() { try { const a = w.abort(); if (isThenable(a)) a.then(null, () => {}); } catch (_) { /* nothing to undo */ } }
    };
  };
  FsaBackend.prototype.mkdir = function* (rel) {
    const p = yield* this.dir(parentRel(rel), false);
    const h = yield p.getDirectoryHandle(baseName(rel), { create: true });
    this.dh.set(rel, h);
    return true;
  };
  FsaBackend.prototype.remove = function* (rel) {
    const p = yield* this.dir(parentRel(rel), false);
    try { yield p.removeEntry(baseName(rel)); }
    catch (e) { if (isName(e, 'InvalidModificationError', 'NotFoundError')) return false; throw e; }
    this.forget(rel);
    return true;
  };
  FsaBackend.prototype.rename = function* (a, b, kind) {
    const h = kind === 'file' ? yield* this.fileH(a) : yield* this.dir(a, false);
    if (typeof h.move === 'function') {
      try {
        if (parentRel(a) === parentRel(b)) yield h.move(baseName(b));
        else { const dest = yield* this.dir(parentRel(b), false); yield h.move(dest, baseName(b)); }
        this.forget(a); this.forget(b);
        return true;
      } catch (e) {
        if (isName(e, 'NotAllowedError', 'SecurityError', 'QuotaExceededError', 'NoModificationAllowedError')) throw e;
        this.forget(a); this.forget(b);
      }
    }
    if (kind !== 'file') return false;
    const r = yield* this.openRead(a, a);
    const w = yield* this.writer(b, false);
    yield* pump(w, r);
    return yield* this.remove(a);
  };

  const EmptyBase = { stat: function* (q) { return q === '' ? DIR() : null; }, list: function* (q) { return q === '' ? [] : null; },
    openRead: function* (q, path) { fail(q === '' ? 'VFS_IS_A_DIR' : 'VFS_NOT_FOUND', path); } };

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  Root drivers: stat / list / openRead / writeFile / mkdir / remove / rename / setMtime, all generators over rels
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  /* Virtual read-only roots (§2.6). */
  function VirtualDriver(id, name, filesFn) {
    this.id = id; this.name = name; this.mode = 'readonly'; this.virtual = true;
    this.filesFn = filesFn || null; this.files = null;
  }
  VirtualDriver.prototype.table = function () {
    if (this.files) return this.files;
    this.files = new Map();
    if (this.filesFn) {
      let list = [];
      try { list = this.filesFn() || []; } catch (e) { console.error('[IJMacroVFS] /' + this.name + '/ content', e); }
      for (const f of list) {
        if (!f || typeof f.name !== 'string') continue;
        const n = /\.lut$/i.test(f.name) ? f.name : f.name + '.lut';
        if (safeRel(n) && n.indexOf('/') < 0) this.files.set(n, toU8(f.bytes));
      }
    }
    return this.files;
  };
  VirtualDriver.prototype.stat = function* (rel) {
    if (rel === '') return DIR();
    const b = this.table().get(rel);
    return b ? { kind: 'file', size: b.length, mtime: 0 } : null;
  };
  VirtualDriver.prototype.list = function* (rel) {
    if (rel !== '') return null;
    return Array.from(this.table().keys(), (name) => ({ name, kind: 'file' }));
  };
  VirtualDriver.prototype.openRead = function* (rel, path) {
    const b = this.table().get(rel);
    if (!b) fail(rel === '' ? 'VFS_IS_A_DIR' : 'VFS_NOT_FOUND', path);
    return { size: b.length, read: (o, l) => { const off = Math.max(0, Math.min(b.length, o | 0)); return b.slice(off, l < 0 ? b.length : off + l); }, close() {} };
  };

  /*
   * /tmp/: an OPFS tree written directly, one folder per Studio open (tmp/<mountId>/, F14), so two tabs never share or clear each
   * other's /tmp/. The worker holds a Web Lock named after its mount for its whole life; at load, the folders of mounts nobody holds
   * (without Web Locks: whose record is older than TMP_STALE_MS) and of mounts this worker left are removed. The file times live in
   * tmpmeta/<mountId>.json, outside the macro's tree, so every name under /tmp/ is the macro's.
   */
  const TMP_LOCK = 'lumen3d-ij-tmp-';
  const TMP_STALE_MS = 7 * 86400000;
  const tmpMounts = new Map();     // mount folder → release() of its lock (this worker's mounts)
  const tmpLeft = new Set();       // mount folders this worker left: collectable whatever the lock manager says
  function mountDirName(id) { const s = String(id || '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 64); return s || '_'; }
  function locksApi(c) {
    if (c && c.locks !== undefined) return c.locks;
    const n = root.navigator;
    return n && n.locks && typeof n.locks.request === 'function' ? n.locks : null;
  }
  function enterTmpMount(locks, mid) {
    for (const [m, release] of Array.from(tmpMounts)) {
      if (m === mid) continue;
      tmpMounts.delete(m); tmpLeft.add(m);
      try { release(); } catch (_) { /* the lock went with its holder */ }
    }
    tmpLeft.delete(mid);
    if (tmpMounts.has(mid)) return;
    let release = () => {};
    if (locks) {
      try {
        const held = new Promise((resolve) => { release = resolve; });
        const p = locks.request(TMP_LOCK + mid, () => held);
        if (p && typeof p.then === 'function') p.then(null, (e) => console.error('[IJMacroVFS] /tmp/ lock', e));
      } catch (e) { console.error('[IJMacroVFS] /tmp/ lock', e); }
    }
    tmpMounts.set(mid, () => release());
  }
  function* collectTmp(store, top, mid, locks) {
    let busy = null;
    if (locks && typeof locks.query === 'function') {
      try {
        const q = yield locks.query();
        busy = new Set();
        for (const l of [].concat((q && q.held) || [], (q && q.pending) || [])) {
          if (l && typeof l.name === 'string' && l.name.startsWith(TMP_LOCK)) busy.add(l.name.slice(TMP_LOCK.length));
        }
      } catch (e) { console.error('[IJMacroVFS] /tmp/ lock query', e); busy = null; }
    }
    const kept = new Set([mid]);
    for (const [name, h] of yield entriesOf(top)) {
      if (name === mid) continue;
      if (h.kind === 'directory' && !tmpLeft.has(name)) {
        if (busy) { if (busy.has(name)) { kept.add(name); continue; } }
        else {
          const meta = yield* readJson(store, ['tmpmeta'], name + '.json');
          if (meta && Number(meta.at) > store.now() - TMP_STALE_MS) { kept.add(name); continue; }
        }
      }
      try { yield top.removeEntry(name, { recursive: true }); }
      catch (e) {
        // a file of that mount still open in another worker: it is in use after all
        if (isName(e, 'NoModificationAllowedError', 'InvalidModificationError')) { kept.add(name); continue; }
        if (!isName(e, 'NotFoundError')) throw e;
      }
      tmpLeft.delete(name);
    }
    const meta = yield store.dir.getDirectoryHandle('tmpmeta', { create: true });
    for (const [name] of yield entriesOf(meta)) {
      const m = /^(.*)\.json(\.1)?$/.exec(name);
      if (m && kept.has(m[1])) continue;
      try { yield meta.removeEntry(name); } catch (e) { if (!isName(e, 'NotFoundError', 'NoModificationAllowedError')) throw e; }
      if (m) store.json.delete('tmpmeta/' + m[1] + '.json');
    }
  }
  function TmpDriver() {
    this.id = 'tmp'; this.name = 'tmp'; this.mode = 'allow'; this.virtual = false; this.needsStorage = true;
    this.tree = null; this.mtimes = {};
  }
  TmpDriver.prototype.load = function* (store, mountId, locks) {
    const mid = mountDirName(mountId);
    enterTmpMount(locks, mid);
    const top = yield store.dir.getDirectoryHandle('tmp', { create: true });
    yield* collectTmp(store, top, mid, locks);
    this.tree = new OpfsTree(store, ['tmp', mid]);
    this.mountId = mid;
    const mark = yield* readJson(store, ['tmpmeta'], mid + '.json');
    this.mtimes = mark && mark.mtimes && typeof mark.mtimes === 'object' ? mark.mtimes : {};
    if (!mark) yield* writeJson(store, ['tmpmeta'], mid + '.json', { v: 2, mountId: mid, mtimes: {}, at: store.now() });
    yield* this.tree.load();
    for (const [rel, ms] of Object.entries(this.mtimes)) this.tree.setMtime(rel, ms);
    this.dirty = false;
  };
  TmpDriver.prototype.ready = function () { return !!this.tree; };
  TmpDriver.prototype.stat = function* (rel) { return this.tree ? this.tree.stat(rel) : (rel === '' ? DIR() : null); };
  TmpDriver.prototype.list = function* (rel) { return this.tree ? this.tree.list(rel) : (rel === '' ? [] : null); };
  TmpDriver.prototype.openRead = function* (rel, path) { if (!this.tree) fail('VFS_NOT_FOUND', path); return yield* this.tree.openRead(rel, path); };
  TmpDriver.prototype.writeFile = function* (rel, src, append) {
    if (rel in this.mtimes) { delete this.mtimes[rel]; this.dirty = true; }
    const w = yield* this.tree.writer(rel, append);
    yield* pump(w, src);
  };
  TmpDriver.prototype.mkdir = function* (rel) { yield* this.tree.mkdirs(rel); return true; };
  TmpDriver.prototype.remove = function* (rel) {
    yield* this.tree.remove(rel);
    for (const k of Object.keys(this.mtimes)) if (under(k, rel)) { delete this.mtimes[k]; this.dirty = true; }
    return true;
  };
  TmpDriver.prototype.rename = function* (a, b) {
    yield* this.tree.move(a, b);
    for (const k of Object.keys(this.mtimes)) if (under(k, a)) { this.mtimes[b + k.slice(a.length)] = this.mtimes[k]; delete this.mtimes[k]; this.dirty = true; }
    return true;
  };
  TmpDriver.prototype.setMtime = function* (rel, ms) { this.tree.setMtime(rel, ms); this.mtimes[rel] = Number(ms) || 0; this.dirty = true; };
  TmpDriver.prototype.flush = function* (store) {
    if (!this.tree || !this.dirty) return;
    yield* writeJson(store, ['tmpmeta'], this.mountId + '.json', { v: 2, mountId: this.mountId, mtimes: this.mtimes, at: store.now() });
    this.dirty = false;
  };
  TmpDriver.prototype.clear = function* () {
    if (!this.tree) return;
    for (const n of Array.from((this.tree.kids.get('') || new Map()).keys())) yield* this.tree.remove(n);
    this.mtimes = {}; this.dirty = true;
  };

  /* A Chromium folder written in place. */
  function FsaDriver(g) {
    this.id = g.id; this.name = g.name; this.mode = g.mode; this.virtual = false; this.inplace = true;
    this.permHandle = g.handle; this.be = new FsaBackend(g.handle);
  }
  FsaDriver.prototype.stat = function* (rel) { return yield* this.be.stat(rel); };
  FsaDriver.prototype.list = function* (rel) { return yield* this.be.list(rel); };
  FsaDriver.prototype.openRead = function* (rel, path) { return yield* this.be.openRead(rel, path); };
  FsaDriver.prototype.writeFile = function* (rel, src, append) { const w = yield* this.be.writer(rel, append); yield* pump(w, src); };
  FsaDriver.prototype.mkdir = function* (rel) { return yield* this.be.mkdir(rel); };
  FsaDriver.prototype.remove = function* (rel) { return yield* this.be.remove(rel); };
  FsaDriver.prototype.rename = function* (a, b, kind) { return yield* this.be.rename(a, b, kind); };
  FsaDriver.prototype.setMtime = function* () { /* a directory handle cannot set a file's time */ };

  /*
   * Overlay over an immutable base. State, all in visible rels except where noted:
   *   data   the OPFS tree of new and changed files (their visible paths), plus the physical parents they need;
   *   dirs   folders created by macros;
   *   recs   [{ from: <base rel>, to: <visible rel> | null, dir }]: a rename of a base entry (to = where it shows now) or a
   *          deletion (to = null, a whiteout). Order-free: a visible path maps to the base through the record with the
   *          longest `to` containing it (or identity), and is hidden when another record's `from` contains the mapped base
   *          path more deeply than the mapping record's own `from` (that base entry was moved away or deleted later).
   */
  function OverlayDriver(g, base) {
    this.id = g.id; this.name = g.name; this.mode = g.mode; this.virtual = false; this.needsStorage = true;
    this.folderName = g.folderName || g.name;
    this.base = base;
    this.permHandle = g.kind === 'fsa' ? g.handle : null;
    this.inplaceEntries = new Map();
    if (g.kind === 'files') for (const e of g.entries || []) if (e && e.writable && e.handle) this.inplaceEntries.set(e.name, e);
    this.data = null; this.dirs = new Set(); this.recs = []; this.dirty = false; this.busy = false;
  }
  OverlayDriver.prototype.wsSegs = function () { return ['ws', this.id]; };
  OverlayDriver.prototype.load = function* (store) {
    this.data = new OpfsTree(store, ['ws', this.id, 'data']);
    let man;
    try {
      man = yield* readJson(store, this.wsSegs(), 'manifest.json');
      yield* this.data.load();
    } catch (e) {
      if (isName(e, 'NoModificationAllowedError')) { this.busy = true; return; }
      throw e;
    }
    this.dirs = new Set(); this.recs = [];
    if (man && man.v === 1) {
      const files = man.files && typeof man.files === 'object' ? man.files : {};
      for (const [rel, meta] of Object.entries(files)) {
        const r = safeRel(rel);
        if (r && meta && this.data.stat(r) && this.data.stat(r).kind === 'file') this.data.setMtime(r, meta.mtime);
      }
      for (const d of Array.isArray(man.dirs) ? man.dirs : []) { const r = safeRel(d); if (r) this.dirs.add(r); }
      for (const w of Array.isArray(man.whiteouts) ? man.whiteouts : []) { const r = safeRel(w); if (r) this.recs.push({ from: r, to: null, dir: false }); }
      for (const x of Array.isArray(man.renames) ? man.renames : []) {
        const f = x && safeRel(x.from), t = x && safeRel(x.to);
        if (f && t) this.recs.push({ from: f, to: t, dir: !!x.dir });
      }
    } else if (man) console.error('[IJMacroVFS] ignored a workspace manifest of an unknown version', this.id);
  };
  OverlayDriver.prototype.manifest = function (now) {
    const files = {};
    if (this.data) for (const [rel, m] of this.data.idx) if (m.kind === 'file') files[rel] = { size: m.size, mtime: m.mtime };
    return {
      v: 1, rootId: this.id, folderName: this.folderName, files,
      dirs: Array.from(this.dirs).sort().map((d) => d + '/'),
      whiteouts: this.recs.filter((r) => r.to === null).map((r) => r.from),
      renames: this.recs.filter((r) => r.to !== null).map((r) => ({ from: r.from, to: r.to, dir: r.dir })),
      updatedAt: now
    };
  };
  OverlayDriver.prototype.flush = function* (store) {
    if (!this.data || !this.dirty) return;
    yield* writeJson(store, this.wsSegs(), 'manifest.json', this.manifest(store.now()));
    this.dirty = false;
  };
  OverlayDriver.prototype.ready = function () { return !!this.data; };
  OverlayDriver.prototype.check = function (path) { if (this.busy) fail('VFS_BUSY', path); };
  OverlayDriver.prototype.baseOf = function (p) {
    let best = null;
    for (const r of this.recs) if (r.to !== null && under(p, r.to) && (!best || r.to.length > best.to.length)) best = r;
    const q = best ? best.from + p.slice(best.to.length) : p;
    const floor = best ? best.from.length : -1;
    for (const r of this.recs) if (r !== best && under(q, r.from) && r.from.length > floor) return null;
    return q;
  };
  OverlayDriver.prototype.baseStat = function* (p) {
    const q = this.baseOf(p);
    if (q === null) return null;
    const st = yield* this.base.stat(q);
    return st ? Object.assign(st, { q }) : null;
  };
  OverlayDriver.prototype.stat = function* (rel) {
    this.check(rel);
    if (rel === '') return DIR();
    const d = this.data && this.data.stat(rel);
    if (d && d.kind === 'file') return d;
    const b = yield* this.baseStat(rel);
    if (d || (b && b.kind === 'dir')) return DIR();
    if (b) return { kind: b.kind, size: b.size, mtime: b.mtime };
    return this.dirs.has(rel) ? DIR() : null;
  };
  OverlayDriver.prototype.list = function* (rel) {
    const st = yield* this.stat(rel);
    if (!st || st.kind !== 'dir') return null;
    const seen = new Map();
    const b = rel === '' ? { kind: 'dir', q: '' } : yield* this.baseStat(rel);
    if (b && b.kind === 'dir') {
      const kids = (yield* this.base.list(b.q)) || [];
      for (const k of kids) {
        const vp = joinRel(rel, k.name);
        if (this.baseOf(vp) !== joinRel(b.q, k.name)) continue;
        const d = this.data && this.data.stat(vp);
        seen.set(k.name, d ? d.kind : k.kind);
      }
    }
    const extra = new Map();
    for (const r of this.recs) {
      if (r.to === null || parentRel(r.to) !== rel || r.to === '' || seen.has(baseName(r.to))) continue;
      if (this.baseOf(r.to) !== r.from) continue;
      const bs = yield* this.base.stat(r.from);
      if (bs) extra.set(baseName(r.to), bs.kind);
    }
    if (this.data) for (const k of this.data.list(rel) || []) if (!seen.has(k.name)) extra.set(k.name, k.kind);
    for (const dd of this.dirs) if (dd !== '' && parentRel(dd) === rel && !seen.has(baseName(dd))) extra.set(baseName(dd), 'dir');
    const out = Array.from(seen, ([name, kind]) => ({ name, kind }));
    for (const name of Array.from(extra.keys()).sort()) if (!seen.has(name)) out.push({ name, kind: extra.get(name) });
    return out;
  };
  OverlayDriver.prototype.openRead = function* (rel, path) {
    this.check(path);
    const d = this.data && this.data.stat(rel);
    if (d && d.kind === 'file') return yield* this.data.openRead(rel, path);
    const b = yield* this.baseStat(rel);
    if (!b) fail(d || this.dirs.has(rel) ? 'VFS_IS_A_DIR' : 'VFS_NOT_FOUND', path);
    if (b.kind === 'dir') fail('VFS_IS_A_DIR', path);
    return yield* this.base.openRead(b.q, path);
  };
  OverlayDriver.prototype.inplaceEntry = function (rel) {
    if (!this.inplaceEntries.has(rel) || this.baseOf(rel) !== rel) return null;
    const d = this.data && this.data.stat(rel);
    return d ? null : this.inplaceEntries.get(rel);
  };
  OverlayDriver.prototype.writeFile = function* (rel, src, append) {
    this.check(rel);
    const ent = this.inplaceEntry(rel);
    if (ent) {
      const w = yield ent.handle.createWritable({ keepExistingData: !!append });
      if (append) { const f = yield ent.handle.getFile(); yield (typeof w.seek === 'function' ? w.seek(f.size) : w.write({ type: 'seek', position: f.size })); }
      yield* pump({ write: (b) => w.write(b), close: () => w.close(), abort() { try { const a = w.abort(); if (isThenable(a)) a.then(null, () => {}); } catch (_) { /* nothing */ } } }, src);
      return { inplace: true };
    }
    let own = !!(this.data.stat(rel) && this.data.stat(rel).kind === 'file');
    const hadOwn = own;
    this.dirty = true;
    try {
      if (append && !own) {
        const b = yield* this.baseStat(rel);
        if (b && b.kind === 'file') {
          const r = yield* this.base.openRead(b.q, rel);
          const w0 = yield* this.data.writer(rel, false);
          yield* pump(w0, r);
          own = true;
        }
      }
      const w = yield* this.data.writer(rel, append && own);
      yield* pump(w, src);
    } catch (e) {
      // A write cut short (quota, the base folder gone during the copy) over a file of the folder must not leave a partial overlay
      // file shadowing the intact base file: Download results would ship it. Without earlier overlay data the base shows again,
      // as a Chromium folder keeps its file when a createWritable is not closed. A new file keeps the bytes that fit (a full disk).
      if (!hadOwn && this.data.stat(rel)) {
        let b = null;
        try { b = yield* this.baseStat(rel); } catch (_) { b = null; }
        if (b && b.kind === 'file') {
          try { yield* this.data.remove(rel); } catch (_) { /* the first error is the one reported */ }
        }
      }
      throw e;
    }
    return { inplace: false };
  };
  OverlayDriver.prototype.mkdir = function* (rel) {
    this.check(rel);
    this.dirty = true;
    yield* this.data.mkdirs(rel);
    this.dirs.add(rel);
    return true;
  };
  OverlayDriver.prototype.remove = function* (rel) {
    this.check(rel);
    const d = this.data.stat(rel);
    const b = yield* this.baseStat(rel);
    this.dirty = true;
    if (d) yield* this.data.remove(rel);
    this.dirs.delete(rel);
    if (b) {
      const exact = this.recs.find((r) => r.to === rel);
      if (exact) exact.to = null;
      else this.recs.push({ from: b.q, to: null, dir: b.kind === 'dir' });
    }
    return true;
  };
  OverlayDriver.prototype.rename = function* (a, b2) {
    this.check(a);
    const d = this.data.stat(a);
    const bs = yield* this.baseStat(a);
    this.dirty = true;
    if (d) yield* this.data.move(a, b2);
    for (const dd of Array.from(this.dirs)) if (under(dd, a)) { this.dirs.delete(dd); this.dirs.add(b2 + dd.slice(a.length)); }
    let exact = false;
    for (const r of this.recs) {
      if (r.to === null || !under(r.to, a)) continue;
      if (r.to === a) exact = true;
      r.to = b2 + r.to.slice(a.length);
    }
    if (bs && !exact) this.recs.push({ from: bs.q, to: b2, dir: bs.kind === 'dir' });
    return true;
  };
  OverlayDriver.prototype.setMtime = function* (rel, ms) { if (this.data) { this.data.setMtime(rel, ms); this.dirty = true; } };
  OverlayDriver.prototype.changes = function* () {
    const files = [];
    let bytes = 0;
    if (this.data) {
      for (const [rel, m] of this.data.idx) {
        if (m.kind !== 'file') continue;
        const orig = yield* this.base.stat(rel);
        files.push({ rel, size: m.size, mtime: m.mtime, kind: orig && orig.kind === 'file' ? 'modified' : 'new' });
        bytes += m.size;
      }
    }
    files.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
    const byDepth = (x, y) => depth(y) - depth(x) || (x < y ? -1 : x > y ? 1 : 0);
    const recreated = (rel) => !!(this.data && this.data.stat(rel)) || this.dirs.has(rel);
    const deleted = this.recs.filter((r) => r.to === null && !recreated(r.from)).map((r) => r.from).sort(byDepth);
    const renamed = this.recs.filter((r) => r.to !== null && r.to !== r.from).map((r) => ({ from: r.from, to: r.to }))
      .sort((x, y) => byDepth(x.from, y.from));
    const dirs = Array.from(this.dirs).sort();
    return { rootId: this.id, files, deleted, renamed, dirs, bytes };
  };

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  Vfs (§4.2–4.3)
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  function open(ctx) {
    const c = ctx || {};
    const now = typeof c.now === 'function' ? c.now : () => Date.now();
    const store = { dir: null, pool: new SahPool(), written: 0, now, json: new Map() };
    const drivers = new Map();     // id → driver
    const byName = new Map();      // root name → driver
    const order = [];              // granted ids, then virtual ones
    const allowed = new Set();
    // files this Vfs created: writing to them again (a writer's appends, a second saveAs) is still a new file, not an overwrite
    const created = new Set();
    const changed = new Set();
    const firstWrite = new Set();
    const perms = new Map();       // id → { read, readwrite }
    let aliases = [];
    let prepared = null, isPrepared = false, closed = false, tail = null;

    const estimate = () => {
      if (typeof c.estimate === 'function') return Promise.resolve(c.estimate());
      const nav = root.navigator;
      if (nav && nav.storage && typeof nav.storage.estimate === 'function') return nav.storage.estimate();
      return Promise.resolve(null);
    };
    function quotaError() {
      return estimate().then((est) => {
        const free = est && est.quota != null ? Math.max(0, Number(est.quota) - Number(est.usage || 0)) : 0;
        return new VfsError('VFS_QUOTA', null, { written: store.written, free });
      }, () => new VfsError('VFS_QUOTA', null, { written: store.written, free: 0 }));
    }

    function overlayFor(g) {
      if (g.kind === 'fsa') return new OverlayDriver(g, new FsaBackend(g.handle));
      if (g.kind === 'files') return new OverlayDriver(g, g.entries ? new EntriesBase(g.entries) : new SnapshotBase(g.snapshot));
      if (g.kind === 'downloads') return new OverlayDriver(g, EmptyBase);
      return new OverlayDriver(g, new SnapshotBase(g.snapshot));
    }
    function register(drv, isGrant) {
      let name = drv.name;
      const clash = byName.get(name);
      if (clash && clash.id !== drv.id) {
        name = rootName(Array.from(byName.keys()).filter((n) => byName.get(n).id !== drv.id), name);
        drv.name = name;
      }
      const old = drivers.get(drv.id);
      if (old) { byName.delete(old.name); } else if (isGrant) order.splice(order.length - VIRTUAL_COUNT, 0, drv.id); else order.push(drv.id);
      drivers.set(drv.id, drv);
      byName.set(drv.name, drv);
    }
    function grantDriver(g) {
      if (!g || typeof g.id !== 'string' || typeof g.name !== 'string') fail('VFS_IO', null, { reason: 'grant' });
      const mode = g.mode === 'readonly' || g.mode === 'allow' ? g.mode : 'ask';
      const gg = Object.assign({}, g, { mode });
      if (g.kind === 'snapshot' && !g.snapshot) {
        const d = overlayFor(gg); d.stale = true; return d;
      }
      if (g.kind === 'files' && !g.entries && !g.snapshot) { const d = overlayFor(gg); d.stale = true; return d; }
      if (g.kind === 'fsa' && !g.handle) { const d = new OverlayDriver(gg, EmptyBase); d.stale = true; return d; }
      if (g.kind === 'fsa' && g.target !== 'overlay') return new FsaDriver(gg);
      return overlayFor(gg);
    }

    const VIRTUAL_COUNT = 6;
    register(new TmpDriver(), false);
    register(new VirtualDriver('home', 'home'), false);
    register(new VirtualDriver('macros', 'macros'), false);
    register(new VirtualDriver('luts', 'luts', typeof c.lutFiles === 'function' ? c.lutFiles : null), false);
    register(new VirtualDriver('imagej', 'imagej'), false);
    const downloads = new OverlayDriver({ id: 'downloads', name: 'Downloads', mode: 'allow', kind: 'downloads', folderName: 'Downloads' }, EmptyBase);
    register(downloads, false);
    for (const g of c.roots || []) {
      if (!g || g.kind === 'downloads') continue;
      try { register(grantDriver(g), true); } catch (e) { console.error('[IJMacroVFS] grant refused', e); }
    }
    setAliases(c.aliases);

    function setAliases(list) {
      aliases = [];
      for (const a of list || []) {
        if (!a || typeof a.literal !== 'string' || typeof a.rootId !== 'string') continue;
        let lit = normalizeSeparators(a.literal);
        if (!lit.endsWith('/')) lit += '/';
        const ci = typeof a.ci === 'boolean' ? a.ci : isMachinePath(lit);
        aliases.push({ literal: lit, rootId: a.rootId, ci });
      }
    }

    // ---- resolution (§2.3)
    function viaAlias(canon, original) {
      const test = canon.endsWith('/') ? canon : canon + '/';
      let best = null;
      for (const a of aliases) {
        const drv = drivers.get(a.rootId);
        if (!drv) continue;
        const ok = a.ci ? test.toLowerCase().startsWith(a.literal.toLowerCase()) : test.startsWith(a.literal);
        if (ok && (!best || a.literal.length > best.literal.length)) best = a;
      }
      if (!best) {
        const literal = dirOf(canon);
        fail('VFS_NOT_GRANTED', original, { literal, prefixes: aliasPrefixes(literal) });
      }
      const drv = drivers.get(best.rootId);
      const rest = test.slice(best.literal.length);
      const segs = [drv.name].concat(collapse(rest));
      return made(segs, canon.endsWith('/'), drv);
    }
    function made(segs, trailing, drv) {
      if (!segs.length) return { vpath: '/', rootId: null, root: null, rel: '', isRoot: false, isTop: true };
      return {
        vpath: '/' + segs.join('/') + (trailing ? '/' : ''),
        rootId: drv.id, root: drv.name, rel: segs.slice(1).join('/'),
        isRoot: segs.length === 1, isTop: false
      };
    }
    function resolve(path, opts) {
      if (path == null) fail('VFS_BAD_PATH', '');
      let s = normalizeSeparators(path);
      if (s === '' || s.indexOf('\u0000') >= 0 || isUrl(s)) fail('VFS_BAD_PATH', s);
      if (!isFullPath(s)) {
        let b = opts && opts.base != null ? normalizeSeparators(opts.base) : '/home/';
        if (b && !b.endsWith('/')) b += '/';
        s = b + s;
        if (!isFullPath(s)) s = '/home/' + s;
      }
      const trailing = s.endsWith('/');
      if (s.startsWith('/') && !s.startsWith('//')) {
        const segs = collapse(s);
        if (!segs.length) return made([], false, null);
        const drv = byName.get(segs[0]);
        if (drv) return made(segs, trailing, drv);
        return viaAlias('/' + segs.join('/') + (trailing ? '/' : ''), s);
      }
      return viaAlias(canonMachine(s), s);
    }

    // ---- serialisation, preparation, closing
    function prepare() {
      if (closed) return Promise.reject(new VfsError('VFS_CLOSED'));
      if (prepared) return prepared;
      prepared = (async () => {
        let opfsRoot = null;
        if (typeof c.opfs === 'function') {
          try { opfsRoot = await c.opfs(); } catch (e) { console.error('[IJMacroVFS] no private storage', e); opfsRoot = null; }
        }
        if (opfsRoot) {
          try { store.dir = await opfsRoot.getDirectoryHandle(STORE_DIR, { create: true }); }
          catch (e) { console.error('[IJMacroVFS] no private storage', e); store.dir = null; }
        }
        if (store.dir) {
          await drive(drivers.get('tmp').load(store, String(c.mountId || ''), locksApi(c)));
          for (const id of order) {
            const d = drivers.get(id);
            if (d instanceof OverlayDriver && !d.stale) await drive(d.load(store));
          }
        }
        isPrepared = true;
      })();
      return prepared;
    }
    function exec(genFn, path, mode) {
      if (closed) throw new VfsError('VFS_CLOSED', path);
      const run = () => {
        let r;
        try { r = drive(genFn()); } catch (e) { return failWith(e, path, mode); }
        return isThenable(r) ? r.then(null, (e) => failWith(e, path, mode)) : r;
      };
      const wrap = (r) => {
        if (!isThenable(r)) return r;
        // Registered before the caller's own reaction, so a caller resuming after this settles finds the queue empty.
        const clear = () => { if (tail === p) tail = null; };
        const p = r.then(clear, clear);
        tail = p;
        return r;
      };
      if (!isPrepared) return wrap((tail || prepare()).then(() => prepare()).then(() => { if (closed) throw new VfsError('VFS_CLOSED', path); return run(); }));
      if (tail) return wrap(tail.then(() => { if (closed) throw new VfsError('VFS_CLOSED', path); return run(); }));
      return wrap(run());
    }
    function failWith(e, path, mode) {
      if (isVfsError(e)) {
        if (e.path == null && path != null) e.path = path;
        throw e;
      }
      // An error of the caller's own (a cancelled request: string code) passes through; DOMException codes are numbers.
      if (e && typeof e.code === 'string') throw e;
      if (isName(e, 'QuotaExceededError')) return quotaError().then((err) => { err.path = path; throw err; });
      if (isName(e, 'NoModificationAllowedError')) throw new VfsError('VFS_BUSY', path);
      if (isName(e, 'NotReadableError')) throw new VfsError('VFS_GONE', path);
      if (isName(e, 'NotFoundError')) throw new VfsError('VFS_NOT_FOUND', path);
      if (isName(e, 'TypeMismatchError')) throw new VfsError('VFS_NOT_A_DIR', path);
      if (isName(e, 'InvalidModificationError')) throw new VfsError('VFS_NOT_EMPTY', path);
      if (isName(e, 'TypeError')) throw new VfsError('VFS_BAD_NAME', path);
      if (isName(e, 'NotAllowedError', 'SecurityError')) {
        // Revoked while the run went on: forget the cached answer so the next access asks the browser again.
        const details = { mode: mode || 'read' };
        try {
          const r = path != null ? resolve(path) : null;
          const d = r && !r.isTop ? drivers.get(r.rootId) : null;
          if (d) { details.rootId = d.id; details.root = d.name; perms.delete(d.id); }
        } catch (_) { /* a path that no longer resolves keeps the bare code */ }
        throw new VfsError('VFS_PERMISSION', path, details);
      }
      console.error('[IJMacroVFS]', e);
      throw new VfsError('VFS_IO', path);
    }

    // ---- per-root checks
    function rootOf(r) {
      if (r.isTop) return null;
      const d = drivers.get(r.rootId);
      if (!d) fail('VFS_NOT_GRANTED', r.vpath, { literal: r.vpath, prefixes: [] });
      if (d.stale) fail('VFS_STALE', r.vpath, { rootId: d.id, root: d.name });
      return d;
    }
    function* perm(d, mode, path) {
      if (!d.permHandle) return;
      let p = perms.get(d.id);
      if (!p) { p = {}; perms.set(d.id, p); }
      if (p[mode] === 'granted' || (mode === 'read' && p.readwrite === 'granted')) return;
      const h = d.permHandle;
      if (typeof h.queryPermission !== 'function') { p[mode] = 'granted'; return; }
      const state = yield h.queryPermission({ mode });
      if (state === 'granted') { p[mode] = 'granted'; return; }
      fail('VFS_PERMISSION', path, { rootId: d.id, root: d.name, mode, state });
    }
    function denyReadOnly(d, path) {
      if (d.virtual || d.mode === 'readonly') fail('VFS_READ_ONLY', path, { root: d.name, rootId: d.id });
    }
    function* storageFor(d, path) {
      if (d.needsStorage && !d.ready()) fail('VFS_NO_STORAGE', path);
      if (d.inplace) yield* perm(d, 'readwrite', path);
    }
    function policy(d, action, path, to) {
      if (action === 'new') return;
      if (d.mode === 'allow' || allowed.has(d.id)) return;
      const details = { rootId: d.id, root: d.name, action, path };
      if (to != null) details.to = to;
      fail('VFS_ASK', path, details);
    }
    function touched(d) {
      if (!(d instanceof OverlayDriver)) return;
      changed.add(d.id);
      if (!firstWrite.has(d.id)) {
        firstWrite.add(d.id);
        if (typeof c.onFirstOverlayWrite === 'function') {
          try { c.onFirstOverlayWrite(d.id); } catch (e) { console.error('[IJMacroVFS] onFirstOverlayWrite', e); }
        }
      }
    }
    function* statR(d, r) {
      if (r.isTop) return DIR();
      yield* perm(d, 'read', r.vpath);
      return yield* d.stat(r.rel);
    }
    function* parentDir(d, r) {
      const st = yield* d.stat(parentRel(r.rel));
      if (!st) fail('VFS_NOT_FOUND', r.vpath);
      if (st.kind !== 'dir') fail('VFS_NOT_A_DIR', r.vpath);
    }
    function srcOf(data) { return Array.isArray(data) ? data : [data]; }

    // ---- operations
    const api = {};
    api.resolve = resolve;
    api.prepare = prepare;
    api.stat = (path) => exec(function* () {
      const r = resolve(path);
      if (r.isTop) return DIR();
      const d = rootOf(r);
      return yield* statR(d, r);
    }, path, 'read');
    api.list = (path) => exec(function* () {
      const r = resolve(path);
      if (r.isTop) return order.map((id) => ({ name: drivers.get(id).name, kind: 'dir' }));
      const d = rootOf(r);
      yield* perm(d, 'read', r.vpath);
      return yield* d.list(r.rel);
    }, path, 'read');
    function* openReadR(path) {
      const r = resolve(path);
      if (r.isTop) fail('VFS_IS_A_DIR', r.vpath);
      const d = rootOf(r);
      yield* perm(d, 'read', r.vpath);
      return yield* d.openRead(r.rel, r.vpath);
    }
    api.read = (path, opts) => exec(function* () {
      const o = opts || {};
      const rd = yield* openReadR(path);
      try {
        const off = Math.max(0, Math.min(rd.size, Number(o.offset) || 0));
        const want = o.length == null || o.length < 0 ? rd.size - off : Math.min(Number(o.length), rd.size - off);
        // o.max: the room the caller has for the bytes (the engine's free memory), checked before anything is allocated
        if (want > MAX_READ || (typeof o.max === 'number' && want > o.max)) fail('VFS_TOO_LARGE', normalizeSeparators(path), { size: rd.size });
        return yield rd.read(off, want);
      } finally { rd.close(); }
    }, path, 'read');
    api.openRead = (path) => exec(function* () {
      const rd = yield* openReadR(path);
      return {
        size: rd.size,
        read(offset, length) {
          if (closed) throw new VfsError('VFS_CLOSED', path);
          try {
            const v = rd.read(offset, length);
            return isThenable(v) ? v.then(null, (e) => failWith(e, path, 'read')) : v;
          } catch (e) { return failWith(e, path, 'read'); }
        },
        close() { rd.close(); }
      };
    }, path, 'read');
    api.write = (path, data, opts) => exec(function* () {
      const append = !!(opts && opts.append);
      const r = resolve(path);
      if (r.isTop || r.isRoot) fail('VFS_IS_A_DIR', r.vpath);
      const d = rootOf(r);
      denyReadOnly(d, r.vpath);
      yield* perm(d, 'read', r.vpath);
      yield* parentDir(d, r);
      const st = yield* d.stat(r.rel);
      if (st && st.kind === 'dir') fail('VFS_IS_A_DIR', r.vpath);
      yield* storageFor(d, r.vpath);
      const key = d.id + '/' + r.rel;
      policy(d, st && !created.has(key) ? 'overwrite' : 'new', r.vpath);
      const res = yield* d.writeFile(r.rel, srcOf(data), append);
      if (!st) created.add(key);
      if (!(res && res.inplace)) touched(d);
    }, path, 'readwrite');
    api.mkdir = (path) => exec(function* () {
      const r = resolve(path);
      if (r.isTop || r.isRoot) return false;
      const d = rootOf(r);
      denyReadOnly(d, r.vpath);
      yield* perm(d, 'read', r.vpath);
      const pst = yield* d.stat(parentRel(r.rel));
      if (!pst || pst.kind !== 'dir') return false;
      const st = yield* d.stat(r.rel);
      if (st) { policy(d, 'mkdir', r.vpath); return false; }
      yield* storageFor(d, r.vpath);
      const ok = yield* d.mkdir(r.rel);
      touched(d);
      return !!ok;
    }, path, 'readwrite');
    api.remove = (path) => exec(function* () {
      const r = resolve(path);
      if (r.isTop || r.isRoot) fail('VFS_ROOT_DELETE', r.vpath);
      const d = rootOf(r);
      denyReadOnly(d, r.vpath);
      yield* perm(d, 'read', r.vpath);
      const st = yield* d.stat(r.rel);
      if (!st) return false;
      if (st.kind === 'dir') { const kids = yield* d.list(r.rel); if (kids && kids.length) return false; }
      yield* storageFor(d, r.vpath);
      policy(d, 'delete', r.vpath);
      const ok = yield* d.remove(r.rel);
      if (ok) touched(d);
      return !!ok;
    }, path, 'readwrite');
    api.rename = (from, to) => exec(function* () {
      const a = resolve(from), b = resolve(to);
      if (a.isTop || a.isRoot || b.isTop || b.isRoot || a.rootId !== b.rootId) return false;
      const d = rootOf(a);
      denyReadOnly(d, a.vpath);
      yield* perm(d, 'read', a.vpath);
      const sa = yield* d.stat(a.rel);
      if (!sa) return false;
      if (yield* d.stat(b.rel)) return false;
      const pb = yield* d.stat(parentRel(b.rel));
      if (!pb || pb.kind !== 'dir') return false;
      if (under(b.rel, a.rel)) return false;
      yield* storageFor(d, a.vpath);
      policy(d, 'rename', a.vpath, b.vpath);
      const ok = yield* d.rename(a.rel, b.rel, sa.kind);
      if (ok) touched(d);
      return !!ok;
    }, from, 'readwrite');
    api.copy = (from, to) => exec(function* () {
      const a = resolve(from), b = resolve(to);
      if (a.isTop) fail('VFS_IS_A_DIR', a.vpath);
      const da = rootOf(a);
      const sa = yield* statR(da, a);
      if (!sa) fail('VFS_NOT_FOUND', a.vpath);
      if (sa.kind === 'dir') fail('VFS_IS_A_DIR', a.vpath);
      if (b.isTop || b.isRoot) fail('VFS_IS_A_DIR', b.vpath);
      const db = rootOf(b);
      denyReadOnly(db, b.vpath);
      yield* perm(db, 'read', b.vpath);
      yield* parentDir(db, b);
      const sb = yield* db.stat(b.rel);
      if (sb && sb.kind === 'dir') fail('VFS_IS_A_DIR', b.vpath);
      yield* storageFor(db, b.vpath);
      const key = db.id + '/' + b.rel;
      policy(db, sb && !created.has(key) ? 'overwrite' : 'new', b.vpath);
      if (!sb) created.add(key);
      // Tools.copyFile opens the source, then truncates the target: copying a file onto itself leaves it empty.
      const same = da === db && a.rel === b.rel;
      let res;
      if (same) res = yield* db.writeFile(b.rel, [], false);
      else {
        const rd = yield* da.openRead(a.rel, a.vpath);
        try { res = yield* db.writeFile(b.rel, rd, false); } finally { rd.close(); }
      }
      if (!(res && res.inplace)) { yield* db.setMtime(b.rel, sa.mtime); touched(db); }
    }, from, 'readwrite');
    api.allow = (rootId) => { allowed.add(String(rootId)); };
    api.addGrant = (grant) => {
      if (closed) throw new VfsError('VFS_CLOSED');
      const drv = grantDriver(grant);
      perms.delete(drv.id);
      const old = drivers.get(drv.id);
      register(drv, true);
      if (drv instanceof OverlayDriver && !drv.stale) {
        if (old instanceof OverlayDriver && old.data) {
          drv.data = old.data; drv.dirs = old.dirs; drv.recs = old.recs; drv.dirty = old.dirty; drv.busy = old.busy;
          return undefined;
        }
        if (store.dir) {
          const p = exec(function* () { yield* drv.load(store); });
          if (isThenable(p)) p.then(null, (e) => console.error('[IJMacroVFS] workspace of a new grant', e));
          return p;
        }
      }
      return undefined;
    };
    api.setAliases = (list) => { setAliases(list); };
    api.changedRoots = () => Array.from(changed);
    api.flush = () => exec(function* () {
      if (!store.dir) return;
      yield* drivers.get('tmp').flush(store);
      for (const id of order) { const d = drivers.get(id); if (d instanceof OverlayDriver) yield* d.flush(store); }
    });
    api.close = () => {
      if (closed) return Promise.resolve();
      const finish = () => { closed = true; store.pool.closeAll(); };
      if (!prepared) { finish(); return Promise.resolve(); }
      const p = Promise.resolve(api.flush()).then(finish, (e) => { finish(); throw e; });
      return p;
    };
    api.clearTmp = () => exec(function* () { if (store.dir) { yield* drivers.get('tmp').clear(); yield* drivers.get('tmp').flush(store); } });

    // ---- delivery (macro.vfs only)
    const promised = (fn) => new Promise((res) => res(fn()));
    function overlayById(rootId) {
      const d = drivers.get(String(rootId));
      return d instanceof OverlayDriver && !d.stale ? d : null;
    }
    api.changes = (rootId) => promised(() => exec(function* () {
      const d = overlayById(rootId);
      if (!d) return { rootId: String(rootId), files: [], deleted: [], renamed: [], dirs: [], bytes: 0 };
      return yield* d.changes();
    }));
    api.deliver = (rootId, opts) => promised(() => exec(function* () {
      const o = opts || {};
      const d = overlayById(rootId);
      if (!d) return { kind: 'none' };
      if (!store.dir || !d.data) fail('VFS_NO_STORAGE');
      const ch = yield* d.changes();
      const maxLinks = o.maxLinks == null ? 3 : o.maxLinks;
      const emptyDirs = ch.dirs.filter((dd) => !ch.files.some((f) => f.rel.startsWith(dd + '/')));
      if (!ch.files.length && !ch.deleted.length && !ch.renamed.length && !emptyDirs.length) return { kind: 'none' };
      if (ch.files.length <= maxLinks && !ch.deleted.length && !ch.renamed.length && !emptyDirs.length) {
        const files = [];
        for (const f of ch.files) {
          store.pool.close(d.data.sahKey(f.rel));
          const fh = yield* d.data.file(f.rel, false);
          files.push({ name: baseName(f.rel), file: yield fh.getFile() });
        }
        return { kind: 'files', files };
      }
      return yield* buildZip(d, ch, o);
    }));
    function* buildZip(d, ch, o) {
      const texts = Object.assign({}, README_EN, o.texts || {});
      const fill = (t, vars) => String(t).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
      const folder = d.folderName;
      const items = [];
      for (const dd of ch.dirs) items.push({ name: folder + '/' + dd + '/', dir: true });
      for (const f of ch.files) items.push({ name: folder + '/' + f.rel, file: f });
      items.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
      const total = ch.bytes;
      const out = new OpfsTree(store, ['out']);
      yield* out.dir('', true);
      const zipName = d.id + '.zip';
      try { yield* out.remove(zipName); } catch (e) { if (!isName(e, 'NotFoundError')) throw e; }
      const fh = yield* out.file(zipName, true);
      const key = out.sahKey(zipName);
      const memory = !hasSync(fh);
      let sah = null, pos = 0;
      const chunks = [];
      const sink = memory ? {
        write(b) { chunks.push({ at: pos, b: b.slice() }); pos += b.length; },
        writeAt(at, b) { for (const ch2 of chunks) if (at >= ch2.at && at + b.length <= ch2.at + ch2.b.length) { ch2.b.set(b, at - ch2.at); return; } },
        position: () => pos
      } : {
        write(b) {
          const n = sah.write(b, { at: pos });
          pos += n;
          if (n < b.length) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
        },
        writeAt(at, b) { sah.write(b, { at }); },
        position: () => pos
      };
      if (!memory) { sah = yield store.pool.get(key, fh); sah.truncate(0); }
      let done = 0;
      // onProgress(fraction, doneBytes, totalBytes); an exception it throws (a cancelled request) stops the archive.
      const progress = () => { if (typeof o.onProgress === 'function') o.onProgress(total ? done / total : 1, done, total); };
      let result;
      try {
        const z = zipCreate(sink, { now });
        if (ch.deleted.length || ch.renamed.length) {
          const lines = [fill(texts['dlg.mac.files.readme'], { name: folder }), '', fill(texts['dlg.mac.files.readmeManual'], {})];
          for (const del of ch.deleted) lines.push('  ' + fill(texts['dlg.mac.files.readmeDelete'], { path: folder + '/' + del }));
          for (const rn of ch.renamed) lines.push('  ' + fill(texts['dlg.mac.files.readmeRename'], { from: folder + '/' + rn.from, to: folder + '/' + rn.to }));
          z.addBytes('README.txt', utf8(lines.join('\n') + '\n'), now());
        }
        for (const it of items) {
          if (it.dir) { z.add(it.name, { size: 0, mtime: now() }).end(); continue; }
          const rd = yield* d.data.openRead(it.file.rel, '/' + d.name + '/' + it.file.rel);
          const e = z.add(it.name, { size: rd.size, mtime: it.file.mtime });
          for (let off = 0; off < rd.size;) {
            const part = yield rd.read(off, Math.min(CHUNK, rd.size - off));
            if (!part.length) break;
            e.write(part);
            off += part.length; done += part.length;
            progress();
          }
          e.end();
          store.pool.close(d.data.sahKey(it.file.rel));
        }
        result = z.finish();
        if (!memory) { sah.flush(); store.pool.close(key); }
      } catch (err) {
        store.pool.close(key);
        try { yield* out.remove(zipName); } catch (_) { /* the partial archive is removed when possible */ }
        throw err;
      }
      progress();
      const name = folder + '-results.zip';
      let file;
      if (memory) {
        const parts = chunks.map((x) => x.b);
        file = typeof File === 'function' ? new File(parts, name, { type: 'application/zip' }) : new Blob(parts, { type: 'application/zip' });
      } else file = yield fh.getFile();
      return { kind: 'zip', name, file, entries: result.entries, bytes: result.bytes, zip64: result.zip64 };
    }
    api.discard = (rootId) => promised(() => exec(function* () {
      const d = overlayById(rootId);
      if (!store.dir) return;
      const id = String(rootId);
      store.pool.closeUnder('ws/' + id);
      store.pool.close('out/' + id + '.zip');
      const wsRoot = yield store.dir.getDirectoryHandle('ws', { create: true });
      try { yield wsRoot.removeEntry(id, { recursive: true }); } catch (e) { if (!isName(e, 'NotFoundError')) throw e; }
      store.json.delete('ws/' + id + '/manifest.json');
      try { const o = yield store.dir.getDirectoryHandle('out', { create: true }); yield o.removeEntry(id + '.zip'); }
      catch (e) { if (!isName(e, 'NotFoundError')) throw e; }
      if (d) {
        d.data = new OpfsTree(store, ['ws', id, 'data']);
        yield* d.data.dir('', true);
        d.dirs = new Set(); d.recs = []; d.dirty = false;
        changed.delete(id);
      }
    }));
    api.usage = () => promised(() => exec(function* () {
      const res = { tmpBytes: 0, workspaces: {} };
      if (!store.dir) return res;
      const tmp = drivers.get('tmp');
      res.tmpBytes = tmp.tree ? tmp.tree.bytes() : 0;
      const ws = yield store.dir.getDirectoryHandle('ws', { create: true });
      for (const [name, h] of yield entriesOf(ws)) {
        if (h.kind !== 'directory') continue;
        const live = drivers.get(name);
        if (live instanceof OverlayDriver && live.data) { res.workspaces[name] = live.data.bytes(); continue; }
        const t = new OpfsTree(store, ['ws', name, 'data']);
        yield* t.load();
        res.workspaces[name] = t.bytes();
      }
      return res;
    }));
    api.roots = () => order.map((id) => { const d = drivers.get(id); return { id: d.id, name: d.name, mode: d.mode }; });
    /** Whether an append to `path` goes through a browser writable stream of the user's folder, which copies the whole file at each
     *  open (keepExistingData): the buffered writers of a run flush such a file less often (FILES.md F15). */
    api.slowAppend = (path) => {
      let r;
      try { r = resolve(path); } catch (_) { return false; }
      if (r.isTop || r.isRoot) return false;
      const d = drivers.get(r.rootId);
      if (d instanceof FsaDriver) return true;
      return d instanceof OverlayDriver && d.inplaceEntries.has(r.rel);
    };
    return Object.freeze(api);
  }

  root.IJMacroVFS = Object.freeze({
    VERSION, RESERVED, ERRORS, MAX_READ, VfsError,
    normalizeSeparators, isFullPath, isUrl, isMachinePath,
    javaName, javaParent, javaAbsolute, nameWithoutExtension, getNameWithoutExtension, updateExtension, addSeparator,
    rootName, aliasPrefixes, formatBytes,
    crc32, hash, zip: Object.freeze({ create: zipCreate }),
    open
  });
})(typeof self !== 'undefined' ? self : globalThis);
