/**
 * CutStore — the cut stores of a format-5 brick tree (DOCS/dataset-migrations/SPEC.md §14.5).
 *
 * A tree (`bricks/`, or `bricks/tNNN/` of a timelapse) carries, beside its bricks:
 *   xz/l{k}/c{c}/bNNNNN.bin, yz/…  64 consecutive XZ (YZ) cuts of one channel per pack:
 *       header (20 bytes, little-endian) "LPXZ"|"LPYZ", u16 version 1, u16 tilesA,
 *       u16 tilesZ, u16 0, u32 first, u32 count; then count × tilesZ × tilesA entries in
 *       order (row, tz, ta) {u64 offset, u32 length}; tiles = png-gray8 of ≤ 512 along
 *       the row × ≤ 512 along z, length 0 = all zero. Row image: image[z][a].
 *   cuts/l{k}/index.bin            LBIX with one level (the cut super-block grid).
 *   cuts/l{k}/c{c}/pNNNNN.bin      cut super-block records: 512 × {u32 offset, u32 length}
 *       (offset from the record's start) in (bz, by, bx) order, then the payloads; a
 *       payload is the lossless WebP mosaic of a 32 × 32 × bz brick (its bz slices of
 *       32², min(bz, 8) per row); length 0 = outside the level or all zero.
 *
 * Reads are byte ranges (a host answering 200 is read whole once per pack and sliced).
 * An XZ / YZ cut costs three small reads per channel (header, the row's entries, its
 * tiles); oblique cut bricks two rounds (the record tables, then the bricks, runs of a
 * pack merged across small gaps).
 *
 * Decoding (the png-gray8 tiles of a row, the WebP cut bricks) runs in a small pool of
 * js/workers/cut-decode-worker.js, which loads this very file; without Worker (a test,
 * a worker scope) it runs here.
 */
const CutStore = (() => {
  const ORTH_MAGIC = { xz: 'LPXZ', yz: 'LPYZ' };
  const ORTH_HEADER = 20;
  const ORTH_ENTRY = 12;
  const ORTH_ROWS = 64;
  const CUT_XY = 32;
  const CUT_SUPER = 8;
  const RECORD_HEAD = CUT_SUPER * CUT_SUPER * CUT_SUPER * 8;
  const RUN_GAP = 32 * 1024;
  const FETCH_SLOTS = 4;
  const MAX_PARTS = 64;            // ranges per multi-range request (as BrickLoader)

  function _pad5(n) { return String(n).padStart(5, '0'); }

  /** A tiny counting semaphore: at most `n` reads of this store in flight. */
  function _slots(n) {
    let free = n;
    const waiting = [];
    return {
      async take() {
        if (free > 0) { free--; return; }
        await new Promise(r => waiting.push(r));
      },
      give() {
        const next = waiting.shift();
        if (next) next(); else free++;
      }
    };
  }

  /**
   * One tree of a v5 manifest. `base` = the tree's URL (".../bricks" or ".../bricks/t003"),
   * `manifest` = that tree's manifest (index urls relative to it, as the viewer mounts it).
   */
  function open(base, manifest) {
    if (!manifest || (manifest.schema !== 'iribhm-bricks-v5' && manifest.schema !== 'iribhm-bricks-v6')) throw new Error('CutStore: not a v5 / v6 tree');
    const root = String(base).replace(/\/$/, '');
    const llRef = manifest.index && manifest.index.columns && manifest.index.columns.ll;
    const stamp = llRef && typeof llRef.sha256 === 'string' ? llRef.sha256.slice(0, 12) : '';
    const whole = new Map();          // url → Promise<Uint8Array> when the host ignores Range
    const cutIndexes = new Map();     // level → Promise<index>
    const slots = _slots(FETCH_SLOTS);

    const urlOf = (rel) => `${root}/${rel}${stamp ? `?v=${stamp}` : ''}`;

    /** Bytes [start, end) of `rel`. */
    async function readRange(rel, start, end, signal) {
      const url = urlOf(rel);
      const cached = whole.get(url);
      if (cached) return (await cached).subarray(start, end);
      await slots.take();
      try {
        const resp = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal });
        if (resp.status === 206) {
          const buf = new Uint8Array(await resp.arrayBuffer());
          if (buf.length !== end - start) throw new Error(`${rel}: ${buf.length} bytes for a range of ${end - start}`);
          return buf;
        }
        if (!resp.ok) throw Object.assign(new Error(`${rel}: HTTP ${resp.status}`), { status: resp.status });
        // A host without Range support: the whole pack, once.
        const p = resp.arrayBuffer().then(b => new Uint8Array(b));
        whole.set(url, p);
        return (await p).subarray(start, end);
      } finally {
        slots.give();
      }
    }

    /**
     * Several runs [{start, end}] of `rel` in as few requests as possible: up to 64
     * ranges per multi-range request (multipart/byteranges parsed by BrickLoader's
     * reader); a host that coalesces, answers one range or the whole file is handled,
     * and any other failure falls back to one request per run. → Map start → bytes.
     */
    async function readRuns(rel, runs, signal) {
      const out = new Map();
      const url = urlOf(rel);
      const cached = whole.get(url);
      if (cached) {
        const all = await cached;
        for (const r of runs) out.set(r.start, all.subarray(r.start, r.end));
        return out;
      }
      const parse = typeof BrickLoader !== 'undefined' ? BrickLoader._parseMultipartByteranges : null;
      for (let i = 0; i < runs.length; i += MAX_PARTS) {
        const chunk = runs.slice(i, i + MAX_PARTS);
        if (chunk.length === 1 || !parse) {
          for (const r of chunk) out.set(r.start, await readRange(rel, r.start, r.end, signal));
          continue;
        }
        let ok = false;
        await slots.take();
        try {
          const resp = await fetch(url, { headers: { Range: 'bytes=' + chunk.map(r => `${r.start}-${r.end - 1}`).join(',') }, signal });
          const type = resp.headers.get('Content-Type') || '';
          if (resp.status === 206 && /multipart\/byteranges/i.test(type)) {
            const parts = parse(new Uint8Array(await resp.arrayBuffer()), type);
            for (const r of chunk) {
              const part = parts.find(q => q.start <= r.start && q.end >= r.end);
              if (!part) throw new Error('a range is missing from the multipart answer');
              out.set(r.start, part.bytes.subarray(r.start - part.start, r.end - part.start));
            }
            ok = true;
          } else if (resp.status === 206) {
            const m = /bytes\s+(\d+)-(\d+)/.exec(resp.headers.get('Content-Range') || '');
            const body = new Uint8Array(await resp.arrayBuffer());
            const s0 = m ? Number(m[1]) : -1;
            if (s0 >= 0 && chunk.every(r => r.start >= s0 && r.end <= s0 + body.length)) {
              for (const r of chunk) out.set(r.start, body.subarray(r.start - s0, r.end - s0));
              ok = true;
            }
          } else if (resp.ok) {
            const p = resp.arrayBuffer().then(b => new Uint8Array(b));
            whole.set(url, p);
            const all = await p;
            for (const r of chunk) out.set(r.start, all.subarray(r.start, r.end));
            ok = true;
          }
        } catch (err) {
          if (signal && signal.aborted) throw err;
        } finally {
          slots.give();
        }
        if (!ok) for (const r of chunk) out.set(r.start, await readRange(rel, r.start, r.end, signal));
      }
      return out;
    }

    // ── XZ / YZ ──────────────────────────────────────────────────────────────
    const orthHeads = new Map();      // rel → Promise<{first, count, ta, tz}>

    function _orthHead(rel, kind, signal) {
      let p = orthHeads.get(rel);
      if (!p) {
        p = readRange(rel, 0, ORTH_HEADER, signal).then((h) => {
          const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
          const magic = String.fromCharCode(h[0], h[1], h[2], h[3]);
          if (magic !== ORTH_MAGIC[kind] || dv.getUint16(4, true) !== 1) throw new Error(`${rel}: not an ${kind} pack`);
          return { ta: dv.getUint16(6, true), tz: dv.getUint16(8, true), first: dv.getUint32(12, true), count: dv.getUint32(16, true) };
        });
        orthHeads.set(rel, p);
        p.catch(() => orthHeads.delete(rel));
      }
      return p;
    }

    /**
     * The XZ (kind 'xz', row = y) or YZ ('yz', row = x) cut of one channel at level k:
     * { width (x for xz, y for yz), height (z), data: Uint8Array width·height, z-major }.
     */
    async function orthRow(kind, level, channel, row, { signal, onBytes } = {}) {
      const block = Math.floor(row / ORTH_ROWS);
      const rel = `${kind}/l${level}/c${channel}/b${_pad5(block)}.bin`;
      const head = await _orthHead(rel, kind, signal);
      const r = row - head.first;
      if (r < 0 || r >= head.count) throw new Error(`${rel}: row ${row} outside ${head.first}+${head.count}`);
      const per = head.ta * head.tz;
      const at = ORTH_HEADER + ORTH_ENTRY * per * r;
      const ent = await readRange(rel, at, at + ORTH_ENTRY * per, signal);
      onBytes?.(ORTH_HEADER + ent.length);
      const dv = new DataView(ent.buffer, ent.byteOffset, ent.byteLength);
      const tiles = [];
      let lo = Infinity, hi = 0;
      for (let i = 0; i < per; i++) {
        const off = Number(dv.getBigUint64(i * ORTH_ENTRY, true));
        const len = dv.getUint32(i * ORTH_ENTRY + 8, true);
        tiles.push({ off, len });
        if (len) { lo = Math.min(lo, off); hi = Math.max(hi, off + len); }
      }
      const levelDims = level >= 0 && Array.isArray(manifest.levels) ? manifest.levels[level].dimensions : null;
      const width = kind === 'xz' ? levelDims.x : levelDims.y;
      const height = levelDims.z;
      const data = new Uint8Array(width * height);
      if (hi > 0) {
        // The row's tiles are contiguous in the pack: one read.
        const run = await readRange(rel, lo, hi, signal);
        onBytes?.(run.length);
        const jobs = [];
        for (let tz = 0; tz < head.tz; tz++) {
          for (let ta = 0; ta < head.ta; ta++) {
            const t = tiles[tz * head.ta + ta];
            if (!t.len) continue;
            jobs.push(_decodePng(run.subarray(t.off - lo, t.off - lo + t.len)).then((img) => {
              for (let y = 0; y < img.height; y++) {
                data.set(img.data.subarray(y * img.width, (y + 1) * img.width), (tz * 512 + y) * width + ta * 512);
              }
            }));
          }
        }
        await Promise.all(jobs);
      }
      return { width, height, data };
    }

    // ── Oblique cut bricks ─────────────────────────────────────────────────────
    function _cutIndex(level, signal) {
      let p = cutIndexes.get(level);
      if (!p) {
        const ref = manifest.index && Array.isArray(manifest.index.cuts) ? manifest.index.cuts[level] : null;
        if (!ref || typeof ref.url !== 'string') return Promise.reject(new Error(`no cut index for level ${level}`));
        p = (async () => {
          const url = `${root}/${ref.url.replace(/^\/+/, '')}?v=${String(ref.sha256 || '').slice(0, 12)}`;
          const resp = await fetch(url, { signal });
          if (!resp.ok) throw new Error(`cut index level ${level}: HTTP ${resp.status}`);
          const u8 = new Uint8Array(await resp.arrayBuffer());
          if (u8.length !== ref.bytes) throw new Error(`cut index level ${level}: ${u8.length} bytes, manifest says ${ref.bytes}`);
          if (typeof PlaneLoader !== 'undefined' && PlaneLoader.sha256Hex) {
            const digest = await PlaneLoader.sha256Hex(u8);
            if (digest !== ref.sha256) throw new Error(`cut index level ${level}: sha256 differs from the manifest`);
          }
          const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
          if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'LBIX' || dv.getUint16(4, true) !== 1 || dv.getUint16(6, true) !== 1) {
            throw new Error(`cut index level ${level}: not a one-level LBIX`);
          }
          const channels = dv.getUint16(8, true);
          const sgx = dv.getUint32(12, true), sgy = dv.getUint32(16, true), sgz = dv.getUint32(20, true);
          const slots = sgx * sgy * sgz;
          if (u8.length !== 28 + 10 * channels * slots) throw new Error(`cut index level ${level}: size`);
          return { dv, channels, sgx, sgy, sgz, slots, base: 28 };
        })();
        cutIndexes.set(level, p);
        p.catch(() => cutIndexes.delete(level));
      }
      return p;
    }

    /**
     * Loads the cut bricks `list` ([{cx, cy, cz}], brick coordinates of level k, depth
     * `bz`) of one channel and calls onBrick({cx, cy, cz, data}) for each STORED one
     * (data: Uint8Array bz·32·32, z-major; voxels past the level are 0). A brick not
     * stored is all zero and is not reported. Returns the count delivered.
     */
    async function loadCutBricks(level, channel, bz, list, { signal, onBytes, onBrick } = {}) {
      const ix = await _cutIndex(level, signal);
      if (channel < 0 || channel >= ix.channels) throw new Error(`channel ${channel} outside the cut index`);
      // Group the bricks by super-block record.
      const bySb = new Map();
      for (const b of list) {
        const sx = Math.floor(b.cx / CUT_SUPER), sy = Math.floor(b.cy / CUT_SUPER), sz = Math.floor(b.cz / CUT_SUPER);
        if (sx >= ix.sgx || sy >= ix.sgy || sz >= ix.sgz) continue;
        const i = (sz * ix.sgy + sy) * ix.sgx + sx;
        let g = bySb.get(i);
        if (!g) bySb.set(i, g = []);
        g.push(b);
      }
      // Round 1: the record tables.
      const records = [];
      for (const [i, group] of bySb) {
        const e = ix.base + 10 * (channel * ix.slots + i);
        const length = ix.dv.getUint32(e + 6, true);
        if (!length) continue;
        records.push({ pack: ix.dv.getUint16(e, true), offset: ix.dv.getUint32(e + 2, true), length, group });
      }
      const tablesByPack = new Map();
      for (const rec of records) {
        rec.rel = `cuts/l${level}/c${channel}/p${_pad5(rec.pack)}.bin`;
        let arr = tablesByPack.get(rec.rel);
        if (!arr) tablesByPack.set(rec.rel, arr = []);
        arr.push(rec);
      }
      await Promise.all([...tablesByPack].map(async ([rel, recs]) => {
        recs.sort((a, b) => a.offset - b.offset);
        const got = await readRuns(rel, recs.map(r => ({ start: r.offset, end: r.offset + RECORD_HEAD })), signal);
        for (const rec of recs) {
          const table = got.get(rec.offset);
          onBytes?.(table.length);
          rec.table = new DataView(table.buffer, table.byteOffset, table.byteLength);
        }
      }));
      // Round 2: the bricks, runs of one pack merged across small gaps.
      const perPack = new Map();
      for (const rec of records) {
        for (const b of rec.group) {
          const local = ((b.cz % CUT_SUPER) * CUT_SUPER + (b.cy % CUT_SUPER)) * CUT_SUPER + (b.cx % CUT_SUPER);
          const off = rec.table.getUint32(local * 8, true);
          const len = rec.table.getUint32(local * 8 + 4, true);
          if (!len) continue;
          const at = rec.offset + off;
          let arr = perPack.get(rec.rel);
          if (!arr) perPack.set(rec.rel, arr = []);
          arr.push({ start: at, end: at + len, brick: b });
        }
      }
      let delivered = 0;
      const jobs = [];
      for (const [rel, items] of perPack) {
        items.sort((a, b) => a.start - b.start);
        let run = null;
        const runs = [];
        for (const it of items) {
          if (run && it.start - run.end <= RUN_GAP) { run.end = Math.max(run.end, it.end); run.items.push(it); }
          else { run = { start: it.start, end: it.end, items: [it] }; runs.push(run); }
        }
        jobs.push((async () => {
          const got = await readRuns(rel, runs, signal);
          for (const r of runs) {
            const bytes = got.get(r.start);
            onBytes?.(bytes.length);
            if (signal && signal.aborted) return;
            await Promise.all(r.items.map(async (it) => {
              const data = await decodeCutBrick(bytes.subarray(it.start - r.start, it.end - r.start), bz);
              if (signal && signal.aborted) return;
              onBrick?.({ cx: it.brick.cx, cy: it.brick.cy, cz: it.brick.cz, data });
              delivered++;
            }));
          }
        })());
      }
      await Promise.all(jobs);
      return delivered;
    }

    return { base: root, manifest, orthRow, loadCutBricks, cutIndex: _cutIndex, readRange, readRuns };
  }

  // ── Decode pool ─────────────────────────────────────────────────────────────
  let _pool = null;            // [{ w, pending }] once created; [] = no worker here
  let _seq = 0;
  const _waiting = new Map();  // id → { resolve, reject, slot }

  function _poolSlots() {
    if (_pool) return _pool;
    _pool = [];
    if (typeof Worker === 'undefined' || typeof document === 'undefined') return _pool;
    const src = document.querySelector('script[src*="cut-store.js"]')?.getAttribute('src') || '';
    const q = (src.match(/\?[^#]*/) || [''])[0];
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
    for (let i = 0; i < n; i++) {
      try {
        const w = new Worker('js/workers/cut-decode-worker.js' + q);
        const slot = { w, pending: 0 };
        w.onmessage = (e) => {
          const m = e.data || {};
          const job = _waiting.get(m.id);
          if (!job) return;
          _waiting.delete(m.id);
          slot.pending--;
          if (m.error) job.reject(new Error(m.error)); else job.resolve(m);
        };
        w.onerror = (e) => {
          // A dead worker leaves the pool; its jobs fail over to this thread.
          _pool = _pool.filter(x => x !== slot);
          for (const [id, job] of _waiting) if (job.slot === slot) { _waiting.delete(id); job.reject(Object.assign(new Error(e.message || 'cut decode worker failed'), { workerFailed: true })); }
        };
        _pool.push(slot);
      } catch (e) {
        break;
      }
    }
    return _pool;
  }

  function _remote(msg, bytes) {
    const pool = _poolSlots();
    if (!pool.length) return null;
    const slot = pool.reduce((a, b) => (b.pending < a.pending ? b : a));
    const id = ++_seq;
    const copy = bytes.slice();
    slot.pending++;
    return new Promise((resolve, reject) => {
      _waiting.set(id, { resolve, reject, slot });
      slot.w.postMessage({ ...msg, id, bytes: copy.buffer }, [copy.buffer]);
    });
  }

  /** A png-gray8 tile → { width, height, data } (in the pool when there is one). */
  async function _decodePng(bytes) {
    const job = _remote({ op: 'png' }, bytes);
    if (job) {
      try {
        const m = await job;
        return { width: m.width, height: m.height, data: new Uint8Array(m.data) };
      } catch (err) {
        if (!err.workerFailed) throw err;
      }
    }
    return PlaneCodec.decodePngGray(bytes);
  }

  /** The bz·32·32 voxels (z-major) of one stored cut brick, decoded in the pool when there is one. */
  async function decodeCutBrick(bytes, bz) {
    const job = _remote({ op: 'cut', bz }, bytes);
    if (job) {
      try {
        return new Uint8Array((await job).data);
      } catch (err) {
        if (!err.workerFailed) throw err;
      }
    }
    return decodeCutBrickLocal(bytes, bz);
  }

  let _canvas = null;
  let _ctx = null;

  /** decodeCutBrick on this thread: lossless WebP, R channel, mosaic of bz slices of 32². */
  async function decodeCutBrickLocal(bytes, bz) {
    const cols = Math.min(bz, 8);
    const w = CUT_XY * cols;
    const h = CUT_XY * Math.ceil(bz / cols);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    try {
      if (bmp.width !== w || bmp.height !== h) throw new Error(`cut brick ${bmp.width}×${bmp.height}, expected ${w}×${h}`);
      if (!_canvas || _canvas.width < w || _canvas.height < h) {
        _canvas = new OffscreenCanvas(Math.max(w, _canvas ? _canvas.width : 0), Math.max(h, _canvas ? _canvas.height : 0));
        _ctx = _canvas.getContext('2d', { willReadFrequently: true });
        _ctx.globalCompositeOperation = 'copy';
      }
      _ctx.drawImage(bmp, 0, 0);
      const px = _ctx.getImageData(0, 0, w, h).data;
      const out = new Uint8Array(bz * CUT_XY * CUT_XY);
      for (let z = 0; z < bz; z++) {
        const ox = (z % cols) * CUT_XY;
        const oy = Math.floor(z / cols) * CUT_XY;
        for (let y = 0; y < CUT_XY; y++) {
          let src = ((oy + y) * w + ox) * 4;
          let dst = (z * CUT_XY + y) * CUT_XY;
          for (let x = 0; x < CUT_XY; x++, src += 4) out[dst++] = px[src];
        }
      }
      return out;
    } finally {
      bmp.close?.();
    }
  }

  /** bz of a level (SPEC §14.5): 2^round(log2(32·vxy / vz)) in [1, 32]. */
  function cutDepth(voxelSize) {
    const vx = Number(voxelSize && voxelSize.x) || 1;
    const vy = Number(voxelSize && voxelSize.y) || 1;
    const vz = Number(voxelSize && voxelSize.z) || 1;
    const r = 32 * Math.max(vx, vy) / vz;
    return Math.min(32, Math.max(1, 2 ** Math.round(Math.log2(r))));
  }

  return { open, decodeCutBrick, decodeCutBrickLocal, cutDepth, CUT_XY, ORTH_ROWS };
})();
