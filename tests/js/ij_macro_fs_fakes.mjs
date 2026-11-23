// Fakes of the browser file APIs the Advanced Studio macro file system uses (FILES.md §14.2), for Node 20 tests.
//
//   FakeFile                 a Blob with name / lastModified / webkitRelativePath whose bytes can be read synchronously
//   makeFakeDisk(tree)       a user folder behind Chromium File System Access handles (permissions, failures, move)
//   makeFakeOpfs({ quota })  the origin private file system: handles with createSyncAccessHandle (exclusive), quota
//   makeSnapshot / makeEntryTree   what <input webkitdirectory> and a folder drop give a page
//   makePickers              scripted showDirectoryPicker / showOpenFilePicker / showSaveFilePicker (need __activation)
//   makeFakeIndexedDB        a small IndexedDB (keyPath stores, put / get / getAll / delete / clear, upgrade)
//   FakeFileReaderSync       synchronous reads of a FakeFile
//   readZip / sparseSink     a strict ZIP reader (CRC and sizes checked, ZIP64) and a sink that counts data bytes
//
// Handles are path-based like the real ones: an operation resolves its path again, so a removed entry answers NotFoundError.
import crypto from 'node:crypto';

const enc = new TextEncoder();
const bytesOf = (x) => {
  if (x == null) return new Uint8Array(0);
  if (typeof x === 'string') return enc.encode(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength));
  if (Object.prototype.toString.call(x) === '[object ArrayBuffer]') return new Uint8Array(x.slice(0));
  throw new TypeError('bytes expected');
};
const domErr = (name, msg) => (name === 'TypeError' ? new TypeError(msg || 'TypeError') : new DOMException(msg || name, name));
const concatBytes = (parts) => {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// ───────────────────────────────────────────── FakeFile / FakeFileReaderSync
export class FakeFile extends Blob {
  constructor(parts, name, opts = {}) {
    const list = (Array.isArray(parts) ? parts : [parts]).map((p) => (p && p._bytes ? p._bytes : bytesOf(p)));
    const bytes = concatBytes(list);
    super([bytes], { type: opts.type || '' });
    this._bytes = bytes;
    this.name = String(name);
    this.lastModified = opts.lastModified != null ? Number(opts.lastModified) : 1700000000000;
    this.webkitRelativePath = opts.webkitRelativePath || '';
    this._check = opts.check || null;   // () => boolean: false = the file changed since (NotReadableError)
  }
  _readable() { if (this._gone || (this._check && !this._check())) throw domErr('NotReadableError'); }
  slice(start, end, type) {
    const n = this._bytes.length;
    let s = start == null ? 0 : start < 0 ? Math.max(0, n + start) : Math.min(start, n);
    let e = end == null ? n : end < 0 ? Math.max(0, n + end) : Math.min(end, n);
    if (e < s) e = s;
    const f = new FakeFile([this._bytes.subarray(s, e)], this.name, { type, lastModified: this.lastModified, check: this._check });
    f._gone = this._gone;
    f._parent = this;
    return f;
  }
  arrayBuffer() {
    try { this._readable(); if (this._parent) this._parent._readable(); } catch (e) { return Promise.reject(e); }
    return Promise.resolve(this._bytes.slice().buffer);
  }
  text() { return this.arrayBuffer().then((b) => new TextDecoder().decode(b)); }
}
export class FakeFileReaderSync {
  readAsArrayBuffer(blob) {
    if (!blob || !blob._bytes) throw new TypeError('FakeFileReaderSync reads FakeFile only');
    blob._readable();
    if (blob._parent) blob._parent._readable();
    return blob._bytes.slice().buffer;
  }
  readAsText(blob) { return new TextDecoder().decode(this.readAsArrayBuffer(blob)); }
}

// ───────────────────────────────────────────── in-memory trees shared by the disk and OPFS fakes
function makeStore(opts) {
  const ci = !!opts.caseInsensitive;
  const key = (n) => (ci ? n.toLowerCase() : n);
  let clock = opts.now || (() => Date.now());
  const rootNode = { kind: 'dir', name: opts.name || '', children: new Map(), mtime: opts.mtime || 0 };
  const store = {
    ci, rootNode, key,
    now: () => clock(),
    setNow(f) { clock = f; },
    fails: new Map(),
    failNext(op, name) { if (!store.fails.has(op)) store.fails.set(op, []); store.fails.get(op).push(name); },
    maybeFail(op) {
      const q = store.fails.get(op);
      if (q && q.length) { const n = q.shift(); throw domErr(n); }
    },
    validName(n) {
      if (typeof n !== 'string' || n === '' || n === '.' || n === '..' || /[\/\\\u0000]/.test(n)) throw domErr('TypeError', 'Name is not allowed.');
      if (opts.windowsNames && (/[<>:"|?*\u0000-\u001f]/.test(n) || /[. ]$/.test(n) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n))) {
        throw domErr('TypeError', 'Name is not allowed.');
      }
    },
    walk(path) {
      let node = rootNode;
      for (const seg of path) {
        if (!node || node.kind !== 'dir') return null;
        node = node.children.get(key(seg)) || null;
      }
      return node;
    },
    parentOf(path) { return store.walk(path.slice(0, -1)); },
    usage() {
      let n = 0;
      const rec = (d) => { for (const c of d.children.values()) { if (c.kind === 'dir') rec(c); else n += c.bytes.length; } };
      rec(rootNode);
      return n;
    }
  };
  return store;
}
function fillTree(store, tree, defaultMtime) {
  for (const [rel0, val] of Object.entries(tree || {})) {
    const isDir = rel0.endsWith('/');
    const segs = rel0.split('/').filter(Boolean);
    let node = store.rootNode;
    const upto = isDir ? segs.length : segs.length - 1;
    for (let i = 0; i < upto; i++) {
      let next = node.children.get(store.key(segs[i]));
      if (!next) { next = { kind: 'dir', name: segs[i], children: new Map(), mtime: defaultMtime }; node.children.set(store.key(segs[i]), next); }
      node = next;
    }
    if (isDir) continue;
    const name = segs[segs.length - 1];
    let bytes, mtime = defaultMtime;
    if (val && typeof val === 'object' && !ArrayBuffer.isView(val) && 'bytes' in val) { bytes = bytesOf(val.bytes); if (val.mtime != null) mtime = val.mtime; }
    else bytes = bytesOf(val);
    node.children.set(store.key(name), { kind: 'file', name, bytes, mtime, version: 0 });
  }
}

// ───────────────────────────────────────────── handles
class FakeWritableStream {
  constructor(fileHandle, keep) {
    this._fh = fileHandle;
    const node = fileHandle._node();
    this._buf = keep ? node.bytes.slice() : new Uint8Array(0);
    this._pos = 0;
    this._open = true;
  }
  _put(data, at) {
    const b = bytesOf(data);
    const end = at + b.length;
    if (end > this._buf.length) { const nb = new Uint8Array(end); nb.set(this._buf); this._buf = nb; }
    this._buf.set(b, at);
    this._pos = end;
  }
  async write(arg) {
    if (!this._open) throw new TypeError('closed');
    this._fh._store.maybeFail('write');
    if (arg && typeof arg === 'object' && !ArrayBuffer.isView(arg) && Object.prototype.toString.call(arg) !== '[object ArrayBuffer]' && 'type' in arg) {
      if (arg.type === 'seek') { this._pos = arg.position; return; }
      if (arg.type === 'truncate') { this._truncate(arg.size); return; }
      this._put(arg.data, arg.position != null ? arg.position : this._pos);
      return;
    }
    if (arg && arg._bytes) { this._put(arg._bytes, this._pos); return; }
    this._put(arg, this._pos);
  }
  async seek(p) { this._pos = p; }
  _truncate(n) {
    const nb = new Uint8Array(n);
    nb.set(this._buf.subarray(0, Math.min(n, this._buf.length)));
    this._buf = nb;
    if (this._pos > n) this._pos = n;
  }
  async truncate(n) { this._truncate(n); }
  async close() {
    if (!this._open) throw new TypeError('closed');
    this._fh._store.maybeFail('close');
    this._open = false;
    const st = this._fh._store;
    const node = this._fh._node();
    if (st.quota != null) {
      const grow = this._buf.length - node.bytes.length;
      if (grow > 0 && st.usage() + grow > st.quota) throw domErr('QuotaExceededError');
    }
    node.bytes = this._buf;
    node.mtime = st.now();
    node.version = (node.version || 0) + 1;
    node.writer = null;
  }
  async abort() { this._open = false; const n = this._fh._node(); if (n) n.writer = null; }
}

class FakeSyncAccessHandle {
  constructor(fh) { this._fh = fh; this._open = true; }
  _node() { if (!this._open) throw domErr('InvalidStateError'); return this._fh._node(); }
  read(view, opts = {}) {
    const node = this._node();
    const at = opts.at || 0;
    const dst = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const n = Math.max(0, Math.min(dst.length, node.bytes.length - at));
    if (n > 0) dst.set(node.bytes.subarray(at, at + n));
    return n;
  }
  write(view, opts = {}) {
    const node = this._node();
    const st = this._fh._store;
    const src = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const at = opts.at != null ? opts.at : 0;
    let n = src.length;
    let over = false;
    if (st.quota != null) {
      const grow = Math.max(0, at + n - node.bytes.length);
      const room = st.quota - st.usage();
      if (grow > room) { n = Math.max(0, n - (grow - Math.max(0, room))); over = true; }
    }
    const end = at + n;
    if (end > node.bytes.length) { const nb = new Uint8Array(end); nb.set(node.bytes); node.bytes = nb; }
    node.bytes.set(src.subarray(0, n), at);
    node.mtime = st.now();
    node.version = (node.version || 0) + 1;
    if (over) throw domErr('QuotaExceededError');
    return n;
  }
  getSize() { return this._node().bytes.length; }
  truncate(n) {
    const node = this._node();
    const nb = new Uint8Array(n);
    nb.set(node.bytes.subarray(0, Math.min(n, node.bytes.length)));
    node.bytes = nb;
    node.version = (node.version || 0) + 1;
  }
  flush() { this._node(); }
  close() {
    if (!this._open) return;
    this._open = false;
    const node = this._fh._store.walk(this._fh._path);
    if (node && node.lock === this) node.lock = null;
    if (this._fh._lockNode && this._fh._lockNode.lock === this) this._fh._lockNode.lock = null;
  }
}

class FakeHandleBase {
  constructor(store, path, kind) { this._store = store; this._path = path; this.kind = kind; this.name = path.length ? path[path.length - 1] : store.rootNode.name; }
  _node() {
    const n = this._store.walk(this._path);
    if (!n) throw domErr('NotFoundError');
    if ((n.kind === 'dir') !== (this.kind === 'directory')) throw domErr('TypeMismatchError');
    return n;
  }
  async isSameEntry(other) { return !!other && other._store === this._store && other.kind === this.kind && this._store.walk(this._path) === this._store.walk(other._path); }
  async queryPermission({ mode = 'read' } = {}) { return this._store.perm(mode); }
  async requestPermission({ mode = 'read' } = {}) {
    const st = this._store;
    const q = st.answers.shift();
    const cur = st.perm(mode);
    const ans = q != null ? q : cur === 'denied' ? 'denied' : 'granted';
    st.perms[mode] = ans;
    if (mode === 'readwrite' && ans === 'granted') st.perms.read = 'granted';
    return ans;
  }
  _need(mode) { if (this._store.perm(mode) !== 'granted') throw domErr('NotAllowedError'); }
  async move(a, b) {
    if (!this._store.allowMove) throw domErr('NotSupportedError');
    this._need('readwrite');
    this._store.maybeFail('move');
    let destPath, newName;
    if (typeof a === 'string') { destPath = this._path.slice(0, -1); newName = a; }
    else { destPath = a._path; newName = b != null ? b : this.name; if (a._store !== this._store) throw domErr('InvalidModificationError'); }
    this._store.validName(newName);
    const node = this._node();
    if (node.lock) throw domErr('NoModificationAllowedError');
    const parent = this._store.parentOf(this._path);
    const dest = this._store.walk(destPath);
    if (!dest || dest.kind !== 'dir') throw domErr('NotFoundError');
    const k = this._store.key(newName);
    const existing = dest.children.get(k);
    if (existing && existing !== node) {
      if (existing.kind === 'dir' || this.kind === 'directory') throw domErr('InvalidModificationError');
    }
    parent.children.delete(this._store.key(this.name));
    node.name = newName;
    dest.children.set(k, node);
    this._path = destPath.concat([newName]);
    this.name = newName;
  }
}

class FakeFileHandle extends FakeHandleBase {
  constructor(store, path) { super(store, path, 'file'); }
  async getFile() {
    this._need('read');
    this._store.maybeFail('getFile');
    const node = this._node();
    if (node.lock && this._store.strictLocks) throw domErr('NoModificationAllowedError');
    const v = node.version;
    const st = this._store, path = this._path;
    return new FakeFile([node.bytes], node.name, { lastModified: node.mtime, check: () => { const n = st.walk(path); return n === node && n.version === v; } });
  }
  async createWritable(opts = {}) {
    if (this._store.noWritable) throw domErr('NotSupportedError');
    this._need('readwrite');
    this._store.maybeFail('createWritable');
    const node = this._node();
    if (node.lock) throw domErr('NoModificationAllowedError');
    return new FakeWritableStream(this, !!opts.keepExistingData);
  }
}

class FakeDirectoryHandle extends FakeHandleBase {
  constructor(store, path) { super(store, path, 'directory'); }
  _child(name, kind, create) {
    this._store.validName(name);
    const node = this._node();
    const k = this._store.key(name);
    let c = node.children.get(k);
    if (!c) {
      if (!create) throw domErr('NotFoundError');
      this._need('readwrite');
      c = kind === 'dir' ? { kind: 'dir', name, children: new Map(), mtime: this._store.now() } : { kind: 'file', name, bytes: new Uint8Array(0), mtime: this._store.now(), version: 0 };
      node.children.set(k, c);
    } else if (c.kind !== kind) throw domErr('TypeMismatchError');
    return this._path.concat([c.name]);
  }
  async getDirectoryHandle(name, opts = {}) {
    this._need('read');
    this._store.maybeFail('getDirectoryHandle');
    return new FakeDirectoryHandle(this._store, this._child(name, 'dir', !!(opts && opts.create)));
  }
  async getFileHandle(name, opts = {}) {
    this._need('read');
    this._store.maybeFail('getFileHandle');
    const h = new (this._store.FileHandleClass)(this._store, this._child(name, 'file', !!(opts && opts.create)));
    return h;
  }
  async removeEntry(name, opts = {}) {
    this._need('readwrite');
    this._store.maybeFail('removeEntry');
    this._store.validName(name);
    const node = this._node();
    const k = this._store.key(name);
    const c = node.children.get(k);
    if (!c) throw domErr('NotFoundError');
    const locked = (n) => n.lock || (n.kind === 'dir' && Array.from(n.children.values()).some(locked));
    if (locked(c)) throw domErr('NoModificationAllowedError');
    if (c.kind === 'dir' && c.children.size && !(opts && opts.recursive)) throw domErr('InvalidModificationError');
    node.children.delete(k);
  }
  async *entries() {
    this._need('read');
    const node = this._node();
    for (const c of Array.from(node.children.values())) {
      const p = this._path.concat([c.name]);
      yield [c.name, c.kind === 'dir' ? new FakeDirectoryHandle(this._store, p) : new (this._store.FileHandleClass)(this._store, p)];
    }
  }
  async *keys() { for await (const [n] of this.entries()) yield n; }
  async *values() { for await (const [, h] of this.entries()) yield h; }
  [Symbol.asyncIterator]() { return this.entries(); }
}

class FakeOpfsFileHandle extends FakeFileHandle {
  async createSyncAccessHandle() {
    if (this._store.noSync) throw domErr('NotSupportedError');
    const node = this._node();
    if (node.lock) throw domErr('NoModificationAllowedError');
    const s = new FakeSyncAccessHandle(this);
    node.lock = s;
    this._lockNode = node;
    this._store.opened++;
    return s;
  }
}

function permissionsOf(store) {
  store.perms = { read: 'granted', readwrite: 'granted' };
  store.answers = [];
  store.perm = (mode) => (mode === 'readwrite' ? store.perms.readwrite : store.perms.readwrite === 'granted' ? 'granted' : store.perms.read);
}

// ───────────────────────────────────────────── makeFakeDisk
export function makeFakeDisk(tree, opts = {}) {
  const mtime = opts.mtime != null ? opts.mtime : 1700000000000;
  const store = makeStore({ caseInsensitive: opts.caseInsensitive, now: opts.now, name: opts.name || 'disk', mtime, windowsNames: opts.windowsNames });
  store.allowMove = opts.move !== false;
  store.FileHandleClass = FakeFileHandle;
  store.strictLocks = false;
  permissionsOf(store);
  fillTree(store, tree, mtime);
  const disk = {
    _store: store,
    dir(rel = '') {
      const segs = rel.split('/').filter(Boolean);
      const node = store.walk(segs);
      if (!node || node.kind !== 'dir') throw new Error('no such folder in the fake disk: ' + rel);
      return new FakeDirectoryHandle(store, segs.map((s, i) => store.walk(segs.slice(0, i + 1)).name));
    },
    file(rel) {
      const segs = rel.split('/').filter(Boolean);
      const node = store.walk(segs);
      if (!node || node.kind !== 'file') throw new Error('no such file in the fake disk: ' + rel);
      return new FakeFileHandle(store, segs);
    },
    setPermission(mode, state) {
      store.perms[mode] = state;
      if (mode === 'readwrite' && state === 'granted') store.perms.read = 'granted';
    },
    answerRequest(state) { store.answers.push(state); },
    failNext(op, name) { store.failNext(op, name); },
    setNow(f) { store.setNow(f); },
    tree() {
      const out = {};
      const rec = (node, prefix) => {
        for (const c of node.children.values()) {
          const rel = prefix + c.name;
          if (c.kind === 'dir') { out[rel + '/'] = { dir: true }; rec(c, rel + '/'); }
          else out[rel] = { size: c.bytes.length, mtime: c.mtime, sha256: crypto.createHash('sha256').update(c.bytes).digest('hex') };
        }
      };
      rec(store.rootNode, '');
      return out;
    },
    bytes(rel) {
      const node = store.walk(rel.split('/').filter(Boolean));
      return node && node.kind === 'file' ? node.bytes.slice() : null;
    },
    text(rel) { const b = disk.bytes(rel); return b == null ? null : new TextDecoder().decode(b); },
    exists(rel) { return !!store.walk(rel.split('/').filter(Boolean)); }
  };
  return disk;
}

// ───────────────────────────────────────────── makeFakeOpfs
export function makeFakeOpfs(opts = {}) {
  const store = makeStore({ name: '', now: opts.now });
  store.quota = opts.quota != null ? opts.quota : 1 << 30;
  store.allowMove = opts.move !== false;
  store.noSync = opts.sync === false;
  store.noWritable = opts.writable === false;
  store.strictLocks = true;
  store.opened = 0;
  store.FileHandleClass = FakeOpfsFileHandle;
  permissionsOf(store);
  const root = new FakeDirectoryHandle(store, []);
  const fs = {
    root,
    _store: store,
    persisted: false,
    storage: {
      getDirectory: async () => root,
      estimate: async () => ({ quota: store.quota, usage: store.usage() }),
      persist: async () => { fs.persisted = true; return true; },
      persisted: async () => fs.persisted
    },
    used: () => store.usage(),
    setQuota(q) { store.quota = q; },
    failNext(op, name) { store.failNext(op, name); },
    openHandles() {
      let n = 0;
      const rec = (d) => { for (const c of d.children.values()) { if (c.kind === 'dir') rec(c); else if (c.lock) n++; } };
      rec(store.rootNode);
      return n;
    },
    tree(prefix = '') {
      const out = {};
      const start = store.walk(prefix.split('/').filter(Boolean));
      const rec = (node, p) => {
        for (const c of node.children.values()) {
          const rel = p + c.name;
          if (c.kind === 'dir') { out[rel + '/'] = { dir: true }; rec(c, rel + '/'); }
          else out[rel] = { size: c.bytes.length, text: c.bytes.length < 4096 ? new TextDecoder().decode(c.bytes) : null };
        }
      };
      if (start && start.kind === 'dir') rec(start, '');
      return out;
    },
    bytes(rel) {
      const node = store.walk(rel.split('/').filter(Boolean));
      return node && node.kind === 'file' ? node.bytes.slice() : null;
    },
    // Hold an exclusive handle as another tab would.
    lock(rel) {
      const node = store.walk(rel.split('/').filter(Boolean));
      if (!node || node.kind !== 'file') throw new Error('no such OPFS file: ' + rel);
      const s = { close() { if (node.lock === s) node.lock = null; } };
      node.lock = s;
      return s;
    }
  };
  return fs;
}

// ───────────────────────────────────────────── snapshot / entry tree
export function makeSnapshot(folderName, tree, opts = {}) {
  const mtime = opts.mtime != null ? opts.mtime : 1700000000000;
  const rels = [], files = [], dirs = new Set();
  for (const [rel0, val] of Object.entries(tree || {})) {
    const segs = rel0.split('/').filter(Boolean);
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/') + '/');
    if (rel0.endsWith('/')) { dirs.add(segs.join('/') + '/'); continue; }
    let bytes, m = mtime;
    if (val && typeof val === 'object' && !ArrayBuffer.isView(val) && 'bytes' in val) { bytes = val.bytes; if (val.mtime != null) m = val.mtime; }
    else bytes = val;
    const rel = segs.join('/');
    rels.push(rel);
    files.push(new FakeFile([bytesOf(bytes)], segs[segs.length - 1], { lastModified: m, webkitRelativePath: folderName + '/' + rel }));
  }
  return { rels, files, dirs: Array.from(dirs) };
}

export function makeEntryTree(folderName, tree, opts = {}) {
  const snap = makeSnapshot(folderName, tree, opts);
  const mkDir = (name, fullPath) => ({ isDirectory: true, isFile: false, name, fullPath, _kids: new Map(),
    createReader() {
      const all = Array.from(this._kids.values());
      let i = 0;
      return { readEntries(ok, err) { queueMicrotask(() => { const batch = all.slice(i, i + 100); i += batch.length; ok(batch); }); } };
    } });
  const top = mkDir(folderName, '/' + folderName);
  const ensure = (segs) => {
    let d = top;
    for (const s of segs) {
      let n = d._kids.get(s);
      if (!n) { n = mkDir(s, d.fullPath + '/' + s); d._kids.set(s, n); }
      d = n;
    }
    return d;
  };
  for (const dd of snap.dirs) ensure(dd.split('/').filter(Boolean));
  snap.rels.forEach((rel, i) => {
    const segs = rel.split('/');
    const d = ensure(segs.slice(0, -1));
    const f = snap.files[i];
    d._kids.set(segs[segs.length - 1], { isDirectory: false, isFile: true, name: f.name, fullPath: d.fullPath + '/' + f.name, file(ok) { queueMicrotask(() => ok(f)); } });
  });
  return top;
}

// ───────────────────────────────────────────── pickers
export function makePickers(answers = {}) {
  const queues = {};
  for (const k of ['directory', 'openFile', 'saveFile']) {
    const a = answers[k];
    queues[k] = a === undefined ? [] : Array.isArray(a) && !(k === 'openFile' && a.length && a[0] && a[0].kind === 'file') ? a.slice() : [a];
  }
  const calls = [];
  const gate = (g) => { if (!g.__activation) throw domErr('SecurityError', 'Must be handling a user gesture to show a file picker.'); };
  const take = (k) => {
    if (!queues[k].length) throw domErr('AbortError', 'The user aborted a request.');
    return queues[k][0];
  };
  const pickers = {
    calls,
    push(kind, answer) { queues[kind].push(answer); },
    install(g) {
      g.showDirectoryPicker = async (opts = {}) => {
        calls.push({ kind: 'directory', options: opts });
        gate(g);
        const a = take('directory');
        if (a === 'abort') { queues.directory.shift(); throw domErr('AbortError', 'The user aborted a request.'); }
        if (a === 'refuseWrite' || (a && a.refuseWrite)) {
          if (opts.mode === 'readwrite') {
            if (a === 'refuseWrite') queues.directory.shift();
            const h = a === 'refuseWrite' ? queues.directory[0] : a.refuseWrite;
            if (h && h._store) h._store.perms.readwrite = 'denied';
            throw domErr('NotAllowedError', 'The user did not grant permission.');
          }
          queues.directory.shift();
          const h = a === 'refuseWrite' ? queues.directory.shift() : a.refuseWrite;
          if (h && h._store) { h._store.perms.readwrite = 'denied'; h._store.perms.read = 'granted'; }
          return h;
        }
        queues.directory.shift();
        if (a && a._store) {
          a._store.perms.read = 'granted';
          if (opts.mode === 'readwrite') a._store.perms.readwrite = 'granted';
        }
        return a;
      };
      g.showOpenFilePicker = async (opts = {}) => {
        calls.push({ kind: 'openFile', options: opts });
        gate(g);
        const a = take('openFile');
        queues.openFile.shift();
        if (a === 'abort') throw domErr('AbortError', 'The user aborted a request.');
        return Array.isArray(a) ? a : [a];
      };
      g.showSaveFilePicker = async (opts = {}) => {
        calls.push({ kind: 'saveFile', options: opts });
        gate(g);
        const a = take('saveFile');
        queues.saveFile.shift();
        if (a === 'abort') throw domErr('AbortError', 'The user aborted a request.');
        return a;
      };
      return pickers;
    }
  };
  return pickers;
}

// ───────────────────────────────────────────── IndexedDB
export function makeFakeIndexedDB() {
  const dbs = new Map();   // name → { version, stores: Map(name → { keyPath, rows: Map }) }
  const later = (f) => setTimeout(f, 0);
  const request = () => ({ result: undefined, error: null, onsuccess: null, onerror: null, readyState: 'pending' });
  const succeed = (req, result) => later(() => { req.result = result; req.readyState = 'done'; if (req.onsuccess) req.onsuccess({ target: req }); });
  const failReq = (req, err) => later(() => { req.error = err; req.readyState = 'done'; if (req.onerror) req.onerror({ target: req }); });
  const copyRow = (v) => (v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype ? Object.assign({}, v) : v);
  function makeDb(name, rec) {
    const db = {
      name,
      get version() { return rec.version; },
      objectStoreNames: { contains: (n) => rec.stores.has(n), get length() { return rec.stores.size; }, item: (i) => Array.from(rec.stores.keys())[i] },
      createObjectStore(n, o = {}) {
        if (rec.stores.has(n)) throw domErr('ConstraintError');
        rec.stores.set(n, { keyPath: o.keyPath || null, rows: new Map() });
        return storeApi(rec.stores.get(n), null);
      },
      deleteObjectStore(n) { rec.stores.delete(n); },
      transaction(names, mode = 'readonly') {
        const list = Array.isArray(names) ? names : [names];
        for (const n of list) if (!rec.stores.has(n)) throw domErr('NotFoundError');
        let pending = 0, failed = false;
        const tx = {
          mode, error: null, oncomplete: null, onerror: null, onabort: null,
          objectStore(n) { if (list.indexOf(n) < 0) throw domErr('NotFoundError'); return storeApi(rec.stores.get(n), tx); },
          abort() { failed = true; later(() => { if (tx.onabort) tx.onabort({ target: tx }); }); },
          _begin() { pending++; },
          _end(ok, err) {
            pending--;
            if (!ok && !failed) { failed = true; tx.error = err; later(() => { if (tx.onerror) tx.onerror({ target: tx }); }); }
            if (pending === 0 && !failed) later(() => { if (pending === 0 && tx.oncomplete) tx.oncomplete({ target: tx }); });
          }
        };
        later(() => { if (pending === 0 && !failed && tx.oncomplete) tx.oncomplete({ target: tx }); });
        return tx;
      },
      close() {}
    };
    return db;
  }
  function storeApi(st, tx) {
    const op = (fn, write) => {
      const req = request();
      if (tx) {
        if (write && tx.mode !== 'readwrite') { failReq(req, domErr('ReadOnlyError')); return req; }
        tx._begin();
      }
      let res, err = null;
      try { res = fn(); } catch (e) { err = e; }
      later(() => {
        if (err) { req.error = err; req.readyState = 'done'; if (req.onerror) req.onerror({ target: req }); if (tx) tx._end(false, err); return; }
        req.result = res; req.readyState = 'done';
        if (req.onsuccess) req.onsuccess({ target: req });
        if (tx) tx._end(true);
      });
      return req;
    };
    const keyOf = (v, k) => (k !== undefined ? k : st.keyPath ? v[st.keyPath] : undefined);
    return {
      keyPath: st.keyPath,
      put: (v, k) => op(() => { const key = keyOf(v, k); if (key === undefined) throw domErr('DataError'); st.rows.set(key, copyRow(v)); return key; }, true),
      add: (v, k) => op(() => { const key = keyOf(v, k); if (st.rows.has(key)) throw domErr('ConstraintError'); st.rows.set(key, copyRow(v)); return key; }, true),
      get: (k) => op(() => copyRow(st.rows.get(k))),
      getAll: () => op(() => Array.from(st.rows.keys()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => copyRow(st.rows.get(k)))),
      getAllKeys: () => op(() => Array.from(st.rows.keys()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))),
      delete: (k) => op(() => { st.rows.delete(k); }, true),
      clear: () => op(() => { st.rows.clear(); }, true),
      count: () => op(() => st.rows.size)
    };
  }
  return {
    open(name, version) {
      const req = Object.assign(request(), { onupgradeneeded: null, onblocked: null });
      later(() => {
        let rec = dbs.get(name);
        const fresh = !rec;
        if (!rec) { rec = { version: 0, stores: new Map() }; dbs.set(name, rec); }
        const want = version == null ? Math.max(1, rec.version) : version;
        if (want < rec.version) { if (fresh) dbs.delete(name); failReq(req, domErr('VersionError')); return; }
        const db = makeDb(name, rec);
        req.result = db;
        if (want > rec.version) {
          const old = rec.version;
          rec.version = want;
          req.transaction = { objectStore: (n) => storeApi(rec.stores.get(n), null) };
          try { if (req.onupgradeneeded) req.onupgradeneeded({ target: req, oldVersion: old, newVersion: want }); }
          catch (e) { failReq(req, e); return; }
        }
        succeed(req, db);
      });
      return req;
    },
    deleteDatabase(name) { const req = request(); dbs.delete(name); succeed(req, undefined); return req; },
    databases: async () => Array.from(dbs, ([name, r]) => ({ name, version: r.version })),
    _dump: (name) => {
      const r = dbs.get(name);
      if (!r) return null;
      const out = {};
      for (const [n, s] of r.stores) out[n] = Array.from(s.rows.values());
      return out;
    }
  };
}

// ───────────────────────────────────────────── ZIP reader and sparse sink
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A source: a Uint8Array, or a sparse sink (bytesAt / size; data not kept → data: null, CRC not checked).
function sourceOf(src) {
  if (ArrayBuffer.isView(src)) {
    const u8 = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
    return { size: u8.length, at: (pos, len) => { if (pos < 0 || pos + len > u8.length) throw new Error('zip: read out of bounds at ' + pos); return u8.subarray(pos, pos + len); }, sparse: false };
  }
  return { size: src.size(), at: (pos, len) => src.bytesAt(pos, len), sparse: true };
}
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 4294967296;

export function readZip(input) {
  const src = sourceOf(input);
  const n = src.size;
  // EOCD: no archive comment is written by the platform; search the last 64 KiB anyway.
  let eocd = -1;
  const from = Math.max(0, n - 65557);
  const tail = src.at(from, n - from);
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = from + i; break; }
  if (eocd < 0) throw new Error('zip: no end of central directory');
  const e = src.at(eocd, 22);
  let count = u16(e, 10), cdSize = u32(e, 12), cdOff = u32(e, 16);
  let zip64End = false;
  if (eocd >= 20) {
    const loc = src.at(eocd - 20, 20);
    if (u32(loc, 0) === 0x07064b50) {
      const recOff = u64(loc, 8);
      const rec = src.at(recOff, 56);
      if (u32(rec, 0) !== 0x06064b50) throw new Error('zip: bad ZIP64 end record');
      count = u64(rec, 32); cdSize = u64(rec, 40); cdOff = u64(rec, 48);
      zip64End = true;
    }
  }
  if (!zip64End && (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff)) throw new Error('zip: ZIP64 values without a ZIP64 end record');
  const cd = src.at(cdOff, cdSize);
  const out = [];
  let p = 0;
  for (let k = 0; k < count; k++) {
    if (u32(cd, p) !== 0x02014b50) throw new Error('zip: bad central record ' + k);
    const flags = u16(cd, p + 8), method = u16(cd, p + 10);
    const dosTime = u16(cd, p + 12), dosDate = u16(cd, p + 14);
    const crc = u32(cd, p + 16);
    let csize = u32(cd, p + 20), usize = u32(cd, p + 24);
    const nlen = u16(cd, p + 28), xlen = u16(cd, p + 30), clen = u16(cd, p + 32);
    const versionNeeded = u16(cd, p + 6);
    let off = u32(cd, p + 42);
    const nameBytes = cd.subarray(p + 46, p + 46 + nlen);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    const extra = cd.subarray(p + 46 + nlen, p + 46 + nlen + xlen);
    let zip64 = false;
    for (let x = 0; x + 4 <= extra.length;) {
      const id = u16(extra, x), len = u16(extra, x + 2);
      if (id === 1) {
        zip64 = true;
        let q = x + 4;
        if (usize === 0xffffffff) { usize = u64(extra, q); q += 8; }
        if (csize === 0xffffffff) { csize = u64(extra, q); q += 8; }
        if (off === 0xffffffff) { off = u64(extra, q); q += 8; }
        if (q > x + 4 + len) throw new Error('zip: short ZIP64 extra in ' + name);
      }
      x += 4 + len;
    }
    if ((usize === 0xffffffff || csize === 0xffffffff || off === 0xffffffff) && !zip64) throw new Error('zip: 0xFFFFFFFF without a ZIP64 extra in ' + name);
    if (method !== 0) throw new Error('zip: not STORE: ' + name);
    if (csize !== usize) throw new Error('zip: STORE sizes differ: ' + name);
    // local header
    const lh = src.at(off, 30);
    if (u32(lh, 0) !== 0x04034b50) throw new Error('zip: bad local header for ' + name);
    const lnlen = u16(lh, 26), lxlen = u16(lh, 28);
    const lflags = u16(lh, 6);
    const lname = new TextDecoder().decode(src.at(off + 30, lnlen));
    if (lname !== name) throw new Error('zip: local name differs: ' + lname + ' / ' + name);
    if (lflags !== flags) throw new Error('zip: local flags differ for ' + name);
    let lcrc = u32(lh, 14), lcs = u32(lh, 18), lus = u32(lh, 22);
    if (lflags & 8) throw new Error('zip: data descriptor not expected: ' + name);
    const lextra = src.at(off + 30 + lnlen, lxlen);
    let lzip64 = false;
    for (let x = 0; x + 4 <= lextra.length;) {
      const id = u16(lextra, x), len = u16(lextra, x + 2);
      if (id === 1) {
        lzip64 = true;
        if (len < 16) throw new Error('zip: local ZIP64 extra needs both sizes: ' + name);
        if (lus === 0xffffffff) lus = u64(lextra, x + 4);
        if (lcs === 0xffffffff) lcs = u64(lextra, x + 12);
      }
      x += 4 + len;
    }
    if (lcrc !== crc) throw new Error('zip: local CRC differs for ' + name);
    if (lus !== usize || lcs !== csize) throw new Error('zip: local sizes differ for ' + name);
    const dataAt = off + 30 + lnlen + lxlen;
    let data = null;
    if (!src.sparse) {
      data = src.at(dataAt, usize).slice();
      const c = crc32(data);
      if (c !== crc) throw new Error('zip: CRC mismatch in ' + name);
    }
    out.push({ name, size: usize, crc, data, zip64: zip64 || lzip64, zip64Local: lzip64, dosTime: ((dosDate << 16) | dosTime) >>> 0,
      dos: { time: dosTime, date: dosDate }, flags, versionNeeded, offset: off, dataAt, isDir: name.endsWith('/'), comment: clen });
    p += 46 + nlen + xlen + clen;
  }
  out.zip64End = zip64End;
  out.cdOffset = cdOff;
  out.cdSize = cdSize;
  return out;
}

// Writes ≤ 64 KiB are kept (headers, names, records); larger ones only advance the position (data of a huge entry).
export function sparseSink(keepLimit = 65536) {
  const segs = [];   // { at, b }
  let pos = 0, dropped = 0;
  const sink = {
    write(u8) {
      const b = new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength);
      if (b.length <= keepLimit) segs.push({ at: pos, b: b.slice() });
      else dropped += b.length;
      pos += b.length;
    },
    writeAt(at, u8) {
      const b = new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength);
      for (const s of segs) if (at >= s.at && at + b.length <= s.at + s.b.length) { s.b.set(b, at - s.at); return; }
      throw new Error('sparseSink: writeAt outside kept bytes at ' + at);
    },
    position: () => pos,
    size: () => pos,
    dropped: () => dropped,
    bytesAt(at, len) {
      const out = new Uint8Array(len);
      for (const s of segs) {
        const a = Math.max(at, s.at), b = Math.min(at + len, s.at + s.b.length);
        if (a < b) out.set(s.b.subarray(a - s.at, b - s.at), a - at);
      }
      return out;
    }
  };
  return sink;
}

// A sink over a growing array (ZIP writer tests).
export function memorySink() {
  let buf = new Uint8Array(1 << 16), pos = 0;
  const grow = (n) => { if (n > buf.length) { let m = buf.length; while (m < n) m *= 2; const nb = new Uint8Array(m); nb.set(buf.subarray(0, pos)); buf = nb; } };
  return {
    write(u8) { const b = new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength); grow(pos + b.length); buf.set(b, pos); pos += b.length; },
    writeAt(at, u8) { const b = new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength); if (at + b.length > pos) throw new Error('writeAt past the end'); buf.set(b, at); },
    position: () => pos,
    bytes: () => buf.slice(0, pos)
  };
}

// Installs the fakes on a global object (a worker sandbox or globalThis); returns an uninstall function.
export function installFsGlobals(g, { opfs, fileReaderSync = true, pickers, idb } = {}) {
  const saved = {};
  const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(g, k); Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  if (fileReaderSync) set('FileReaderSync', FakeFileReaderSync);
  if (opfs) {
    const nav = Object.assign({}, g.navigator || {}, { storage: opfs.storage });
    set('navigator', nav);
  }
  if (idb) set('indexedDB', idb);
  if (pickers) pickers.install(g);
  return () => {
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(g, k, d); else delete g[k]; }
    if (pickers) { delete g.showDirectoryPicker; delete g.showOpenFilePicker; delete g.showSaveFilePicker; }
  };
}
