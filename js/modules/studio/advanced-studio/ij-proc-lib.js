/* ij-proc-lib.js — the pure modules of "Open from Library" (PLAN-wave3 §3.3, §3.5).
 *
 * Classic script, page AND worker (and Node, for the tests). No dependency on defineCommand or the
 * engine: the worker command glue (doc.tiff.project, doc.oblique.*) is appended after these modules
 * by the S-PLUGIN package. Attaches to `self`:
 *
 *   IJTiffStream  reads the pages of a download-bundle TIFF with Range requests, from the index
 *                 api/tiff-index answers (never the whole file):
 *     plan(index)            → the stream's plan, or throws IJ_LIB_TIFF_UNSUPPORTED (+ detail)
 *     pageOf(plan, {z,c,t})  → page number (ImageJ hyperstack order, channels fastest)
 *     bands(plan, {maxBytes, channels}) → [{ s0, s1, y0, y1 }]  strip bands of one page
 *     runs(plan, entries, {maxBytes, maxParts}) → [{ ranges, parts }]  one range per page (band), many per request
 *     fetchRun(url, run, {signal, fetchImpl}) → Promise<Map(key → Uint8Array)>
 *     readPages(url, plan, entries, {concurrency, signal, fetchImpl, onPage}) → Promise<{ requests }>
 *     inflate(bytes) / decodeStrip(plan, bytes, rows, {inflate}) / decodePage(plan, entry, bytes, opts)
 *   IJOblique     accumulates the bricks of an oblique cut into an 8-bit picture:
 *     create(G, {channel, outBitDepth}) → { add, missing, coverage, finish, estimateBytes }
 *     reference(G, volume, channel)     → the direct evaluation the accumulator must equal (tests)
 *
 * References: TIFF 6.0 (§7 strips, §14 predictor, Adobe deflate 8 / 32946), ImageJ 1.54 TiffDecoder /
 * ImageWriter (hyperstack order), RFC 7233 (multipart/byteranges). The oblique geometry is the slice
 * shader's: js/viewers/volume-slicer.js (see IJOblique below).
 */
(function (root) {
  'use strict';

  function fail(code, message, extra) {
    const e = new Error(message || code);
    e.code = code;
    if (extra) Object.assign(e, extra);
    return e;
  }
  const abortError = () => (typeof DOMException === 'function'
    ? new DOMException('aborted', 'AbortError')
    : Object.assign(new Error('aborted'), { name: 'AbortError' }));
  const throwIfAborted = (signal) => { if (signal && signal.aborted) throw abortError(); };
  const HOST_LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  const MIB = 1024 * 1024;

  // ====================================================================================== IJTiffStream
  const IJTiffStream = (() => {
    const UNSUPPORTED = 'IJ_LIB_TIFF_UNSUPPORTED';

    function unsupported(detail) {
      return fail(UNSUPPORTED, 'unsupported TIFF: ' + detail, { detail });
    }

    function b64ToBytes(text) {
      const bin = atob(text);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }

    function decodeStripTables(strips) {
      const ob = b64ToBytes(strips.offsets), cb = b64ToBytes(strips.byteCounts);
      const n = ob.length >> 3;
      if (cb.length >> 2 !== n) throw fail('IJ_LIB_TIFF_CORRUPT', 'strip tables disagree');
      const odv = new DataView(ob.buffer, ob.byteOffset, ob.byteLength), cdv = new DataView(cb.buffer, cb.byteOffset, cb.byteLength);
      const offsets = new Float64Array(n), counts = new Uint32Array(n);
      for (let i = 0; i < n; i++) { offsets[i] = odv.getFloat64(i * 8, true); counts[i] = cdv.getUint32(i * 4, true); }
      return { offsets, counts };
    }

    const MICRON = /^(?:micron|microns|um|µm|μm)$/i;

    /* The plan of a TIFF stream. Everything the reader refuses is refused here, before one pixel byte
     * is requested: compression ∉ {1, 8, 32946}, predictor ∉ {1, 2}, bits ∉ {8, 16, 32}, 32-bit not
     * float, signed integers, tiles, planar configuration 2 with several samples, non-uniform pages. */
    function plan(index) {
      if (!index || index.v !== 1 || !(index.pages > 0) || !index.strips) throw unsupported('index');
      if (index.tiled) throw unsupported('tiled');
      if (index.uniform === false) throw unsupported('non-uniform pages');
      if (index.compression !== 1 && index.compression !== 8 && index.compression !== 32946) throw unsupported('compression ' + index.compression);
      if (index.predictor !== 1 && index.predictor !== 2) throw unsupported('predictor ' + index.predictor);
      const bits = index.bitsPerSample;
      if (bits !== 8 && bits !== 16 && bits !== 32) throw unsupported('bits ' + bits);
      const sf = index.sampleFormat || 1;
      if (bits === 32 && sf !== 3) throw unsupported('32-bit integer');
      if (bits !== 32 && sf !== 1) throw unsupported('sample format ' + sf);
      const spp = index.samplesPerPixel || 1;
      if (index.planarConfig === 2 && spp > 1) throw unsupported('planar configuration 2');
      if (spp !== 1 && spp !== 3) throw unsupported('samples per pixel ' + spp);
      if (!(index.width > 0 && index.height > 0)) throw unsupported('size');
      const bytesPerSample = bits / 8;
      const perPage0 = index.strips.perPage;
      if (!(perPage0 > 0)) throw unsupported('strips');
      const tables = decodeStripTables(index.strips);
      let pages = index.pages;
      let expandedBytes = 0;
      const ij = index.imagej || null;
      // ImageJ's own big stacks: ONE directory, `images` planes back to back (uncompressed only).
      if (pages === 1 && ij && ij.images > 1 && index.compression === 1) {
        pages = ij.images;
        expandedBytes = index.width * index.height * bytesPerSample * spp;
      } else if (tables.offsets.length !== pages * perPage0) {
        throw fail('IJ_LIB_TIFF_CORRUPT', 'strip tables do not match the page count');
      }
      const rowsPerStrip = Math.min(index.rowsPerStrip || index.height, index.height);
      if (Math.ceil(index.height / rowsPerStrip) !== perPage0) throw fail('IJ_LIB_TIFF_CORRUPT', 'strip count does not match rows per strip');

      let channels = 1, slices = pages, frames = 1;
      if (spp === 1 && ij) {
        const c = ij.channels || 1, z = ij.slices || 1, t = ij.frames || 1;
        if (c * z * t === pages) { channels = c; slices = z; frames = t; }
      }
      if (spp > 1) { channels = spp; slices = pages; frames = 1; }
      let pixelUm = null;
      const res = index.resolution;
      if (res && res.x > 0 && res.y > 0) {
        if (ij && ij.unit && MICRON.test(ij.unit)) pixelUm = { x: 1 / res.x, y: 1 / res.y };
        else if (res.unit === 3) pixelUm = { x: 1e4 / res.x, y: 1e4 / res.y };
        else if (res.unit === 2) pixelUm = { x: 25400 / res.x, y: 25400 / res.y };
      }
      const spacingUm = ij && ij.spacing > 0 && ij.unit && MICRON.test(ij.unit) ? ij.spacing : null;
      const perPage = perPage0;
      const p = {
        url: index.url || null,
        width: index.width, height: index.height, bitDepth: bits, float: bits === 32,
        spp, chunky: spp > 1, littleEndian: index.littleEndian !== false,
        compression: index.compression, predictor: index.predictor, rowsPerStrip,
        pages, channels, slices, frames, spacingUm, pixelUm,
        colors: ij && Array.isArray(ij.colors) ? ij.colors.slice() : [],
        ranges: ij && Array.isArray(ij.ranges) ? ij.ranges.slice() : [],
        labels: ij && Array.isArray(ij.labels) ? ij.labels.slice() : [],
        stripsPerPage: perPage,
        pageBytes: index.width * index.height * bytesPerSample * spp,
        /* the strips of `page`: absolute offsets (Float64) and byte counts (Uint32) */
        stripsOf(page) {
          if (!(page >= 0 && page < pages) || page !== Math.floor(page)) throw fail('IJ_LIB_BAD_ARGS', 'page ' + page);
          if (expandedBytes) {
            return { offsets: Float64Array.from(tables.offsets, (o) => o + page * expandedBytes), counts: tables.counts.slice() };
          }
          const a = page * perPage;
          return { offsets: tables.offsets.subarray(a, a + perPage), counts: tables.counts.subarray(a, a + perPage) };
        }
      };
      return p;
    }

    function pageOf(p, o) {
      const z = o.z | 0, c = o.c | 0, t = o.t | 0;
      if (z < 0 || z >= p.slices || t < 0 || t >= p.frames || c < 0 || c >= p.channels) throw fail('IJ_LIB_BAD_ARGS', 'z/c/t outside the stack');
      return p.spp > 1 ? t * p.slices + z : (t * p.slices + z) * p.channels + c;
    }

    /* A page that does not fit `maxBytes` of decoded float planes (width·height·4·channels) is cut into
     * strip bands, whole strips each: [{ s0, s1, y0, y1 }] (strips s0..s1 exclusive, rows y0..y1). */
    function bands(p, o) {
      const maxBytes = (o && o.maxBytes) || 64 * MIB;
      const channels = (o && o.channels) || 1;
      const rowBytes = p.width * 4 * channels;
      const stripRows = p.rowsPerStrip;
      const perBand = Math.max(1, Math.floor(maxBytes / (rowBytes * stripRows)));
      const out = [];
      for (let s0 = 0; s0 < p.stripsPerPage; s0 += perBand) {
        const s1 = Math.min(p.stripsPerPage, s0 + perBand);
        out.push({ s0, s1, y0: s0 * stripRows, y1: Math.min(p.height, s1 * stripRows) });
      }
      return out;
    }

    const entryOf = (p, e) => (typeof e === 'number' ? { page: e, s0: 0, s1: p.stripsPerPage } : { page: e.page, s0: e.s0 | 0, s1: e.s1 === undefined ? p.stripsPerPage : e.s1 | 0 });
    const keyOf = (p, e) => (e.s0 === 0 && e.s1 === p.stripsPerPage ? e.page : e.page + ':' + e.s0);

    /* The requests that read `entries` (page numbers, or { page, s0, s1 } bands) — as many entries per
     * request as `maxParts` (ranges) and `maxBytes` allow, in the order given. A page's strips lie back to
     * back in the file (the IFDs sit between pages), so an entry is ONE range; strips that do not touch
     * are separate ranges of the same entry.
     *   run = { ranges: [{ start, end }]  (end exclusive),
     *           parts: [{ page, strip, key, at (absolute offset), len }] } */
    function runs(p, entries, o) {
      const maxBytes = (o && o.maxBytes) || 32 * MIB, maxParts = (o && o.maxParts) || 32;
      const out = [];
      let cur = null, curBytes = 0;
      for (const raw of entries) {
        const e = entryOf(p, raw);
        if (!(e.s0 >= 0 && e.s1 > e.s0 && e.s1 <= p.stripsPerPage)) throw fail('IJ_LIB_BAD_ARGS', 'strip band');
        const { offsets, counts } = p.stripsOf(e.page);
        const ranges = [], parts = [];
        let bytes = 0;
        for (let s = e.s0; s < e.s1; s++) {
          const start = offsets[s], len = counts[s];
          parts.push({ page: e.page, strip: s, key: keyOf(p, e), at: start, len });
          bytes += len;
          const last = ranges[ranges.length - 1];
          if (last && last.end === start) last.end = start + len; else if (len > 0) ranges.push({ start, end: start + len });
        }
        if (cur && (cur.ranges.length + ranges.length > maxParts || curBytes + bytes > maxBytes)) { out.push(cur); cur = null; }
        if (!cur) { cur = { ranges: [], parts: [] }; curBytes = 0; }
        for (const r of ranges) cur.ranges.push(r);
        for (const q of parts) cur.parts.push(q);
        curBytes += bytes;
      }
      if (cur) out.push(cur);
      return out;
    }

    // ---- multipart/byteranges (RFC 7233 §4.1), by the lengths Content-Range announces
    const ascii = (u8, a, b) => { let s = ''; for (let i = a; i < b; i++) s += String.fromCharCode(u8[i]); return s; };

    function parseContentRange(text) {
      const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(text || '');
      return m ? { start: Number(m[1]), end: Number(m[2]) + 1 } : null;
    }

    function parseMultipart(buf, contentType) {
      const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
      if (!m) throw fail('IJ_LIB_TIFF_HTTP', 'multipart without a boundary');
      const delim = '--' + (m[1] || m[2]);
      const dl = delim.length;
      const matchAt = (i) => { for (let k = 0; k < dl; k++) if (buf[i + k] !== delim.charCodeAt(k)) return false; return true; };
      const pieces = [];
      let pos = 0;
      while (pos + dl <= buf.length && !matchAt(pos)) pos++;      // preamble
      while (pos + dl <= buf.length && matchAt(pos)) {
        pos += dl;
        if (buf[pos] === 45 && buf[pos + 1] === 45) break;        // closing delimiter
        if (buf[pos] === 13 && buf[pos + 1] === 10) pos += 2;
        let end = pos;                                            // headers up to the empty line
        while (end + 3 < buf.length && !(buf[end] === 13 && buf[end + 1] === 10 && buf[end + 2] === 13 && buf[end + 3] === 10)) end++;
        if (end + 3 >= buf.length) throw fail('IJ_LIB_TIFF_HTTP', 'truncated multipart');
        const cr = parseContentRange(ascii(buf, pos, end).split(String.fromCharCode(10)).filter((l) => /^content-range:/i.test(l.trim())).join(' '));
        if (!cr) throw fail('IJ_LIB_TIFF_HTTP', 'multipart part without Content-Range');
        const bodyStart = end + 4, bodyEnd = bodyStart + (cr.end - cr.start);
        if (bodyEnd > buf.length) throw fail('IJ_LIB_TIFF_HTTP', 'truncated multipart part');
        pieces.push({ start: cr.start, end: cr.end, bytes: buf.subarray(bodyStart, bodyEnd) });
        pos = bodyEnd;
        if (buf[pos] === 13 && buf[pos + 1] === 10) pos += 2;
      }
      return pieces;
    }

    function headerOf(resp, name) { return resp.headers && typeof resp.headers.get === 'function' ? resp.headers.get(name) : null; }

    /* Hosts that refused a multi-range request (a 200, one unlabelled body, a 416): later requests to them
     * carry one range each, the way BrickLoader remembers `_multiRangeBadHosts`. */
    const refusedMulti = new Set();
    const hostOf = (url) => { try { return new URL(url).host; } catch (e) { return String(url); } };

    async function cancelBody(resp) {
      try { if (resp.body && resp.body.cancel) await resp.body.cancel(); } catch (e) { /* closing */ }
    }

    /* → { status: 206, pieces } | { status: 416 | 'multi-refused', pieces: [] }. 'multi-refused' = a request
     * for SEVERAL ranges the host did not answer as ranges (a 200 with the whole file — never read — or
     * one 206 body without a usable Content-Range). A SINGLE range answered with a 200 is a host that
     * ignores Range altogether: IJ_LIB_TIFF_NO_RANGE. */
    async function requestRanges(url, ranges, signal, fetchImpl) {
      const spec = ranges.map((r) => r.start + '-' + (r.end - 1)).join(',');
      // a dropped connection is the host's fault, said as such; only an abort keeps its own name
      const netFail = (e) => { if (e && e.name === 'AbortError') return e; return fail('IJ_LIB_TIFF_HTTP', 'network', { cause: e }); };
      let resp;
      try { resp = await fetchImpl(url, { headers: { Range: 'bytes=' + spec }, signal }); } catch (e) { throw netFail(e); }
      if (resp.status === 200) {
        // the host ignores Range (php -S, some static servers): never read a multi-GB body to find out
        await cancelBody(resp);
        if (ranges.length > 1) return { status: 'multi-refused', pieces: [] };
        throw fail('IJ_LIB_TIFF_NO_RANGE', 'the host answers a Range request with the whole file');
      }
      if (resp.status === 416) return { status: 416, pieces: [] };
      if (resp.status !== 206) throw fail('IJ_LIB_TIFF_HTTP', 'HTTP ' + resp.status, { status: resp.status });
      const type = headerOf(resp, 'content-type') || '';
      const multipart = /multipart\/byteranges/i.test(type);
      const cr = multipart ? null : parseContentRange(headerOf(resp, 'content-range'));
      if (!multipart && ranges.length > 1 && !cr) { await cancelBody(resp); return { status: 'multi-refused', pieces: [] }; }
      let buf;
      try { buf = new Uint8Array(await resp.arrayBuffer()); } catch (e) { throw netFail(e); }
      throwIfAborted(signal);
      if (multipart) return { status: 206, pieces: parseMultipart(buf, type) };
      if (!cr || cr.end - cr.start !== buf.length) throw fail('IJ_LIB_TIFF_HTTP', 'single range without a usable Content-Range');
      return { status: 206, pieces: [{ start: cr.start, end: cr.end, bytes: buf }] };
    }

    const pieceFor = (pieces, at, len) => {
      for (const q of pieces) if (at >= q.start && at + len <= q.end) return q.bytes.subarray(at - q.start, at - q.start + len);
      return null;
    };

    /* One multi-range request for `run` (several pages). A host that refuses several ranges (416, a 200, one
     * unlabelled body) is asked one range at a time and remembered (later runs: one range per request); one
     * range that does not cover them is also asked one at a time. A 200 to ONE range aborts the body at
     * once: IJ_LIB_TIFF_NO_RANGE. → Map(key → the page's (band's) strips back to back). */
    async function fetchRun(url, run, o) {
      const signal = o && o.signal, fetchImpl = (o && o.fetchImpl) || ((...a) => root.fetch(...a));
      throwIfAborted(signal);
      const host = hostOf(url);
      const skipMulti = run.ranges.length > 1 && refusedMulti.has(host);
      let got = !run.ranges.length ? { status: 206, pieces: [] }
        : skipMulti ? { status: 'multi-refused', pieces: [] }
          : await requestRanges(url, run.ranges, signal, fetchImpl);
      let pieces = got.pieces;
      const covered = () => run.parts.every((q) => q.len === 0 || pieceFor(pieces, q.at, q.len));
      if (run.ranges.length > 1 && (got.status !== 206 || !covered())) {
        if (got.status === 'multi-refused' || got.status === 416) refusedMulti.add(host);
        pieces = [];
        for (const r of run.ranges) {
          const one = await requestRanges(url, [r], signal, fetchImpl);
          for (const q of one.pieces) pieces.push(q);
        }
      }
      const byKey = new Map();
      for (const q of run.parts) {
        const bytes = q.len === 0 ? new Uint8Array(0) : pieceFor(pieces, q.at, q.len);
        if (!bytes) throw fail('IJ_LIB_TIFF_HTTP', 'a strip was not part of the answer');
        let list = byKey.get(q.key);
        if (!list) byKey.set(q.key, list = []);
        list.push(bytes);
      }
      const out = new Map();
      for (const [key, list] of byKey) {
        if (list.length === 1) { out.set(key, list[0]); continue; }
        let total = 0;
        for (const b of list) total += b.length;
        const joined = new Uint8Array(total);
        let at = 0;
        for (const b of list) { joined.set(b, at); at += b.length; }
        out.set(key, joined);
      }
      return out;
    }

    /* Reads `entries` with at most `concurrency` (default 2) requests in flight; onPage(entry, bytes) is
     * awaited per page in request order of completion. → { requests }. */
    async function readPages(url, p, entries, o) {
      const opt = o || {};
      const rs = runs(p, entries, refusedMulti.has(hostOf(url)) ? { ...opt, maxParts: 1 } : opt);
      const conc = Math.max(1, opt.concurrency || 2);
      const list = entries.map((e) => entryOf(p, e));
      const entryByKey = new Map(list.map((e) => [keyOf(p, e), e]));
      let next = 0, requests = 0, failure = null;
      const lane = async () => {
        while (!failure && next < rs.length) {
          const run = rs[next++];
          try {
            throwIfAborted(opt.signal);
            requests++;
            const got = await fetchRun(url, run, opt);
            for (const [key, bytes] of got) if (opt.onPage) await opt.onPage(entryByKey.get(key), bytes);
          } catch (err) { failure = failure || err; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(conc, rs.length) }, lane));
      if (failure) throw failure;
      return { requests };
    }

    // ---- decoding
    // `limit` = the byte count the strip must hold: a longer stream is truncated to it (ImageReader does), not buffered further
    async function inflate(bytes, limit) {
      if (typeof DecompressionStream !== 'function') throw fail('IJ_LIB_TIFF_NO_INFLATE', 'DecompressionStream is not available');
      const ds = new DecompressionStream('deflate');
      const writer = ds.writable.getWriter();
      writer.write(bytes).catch(() => {});
      writer.close().catch(() => {});
      const reader = ds.readable.getReader();
      const chunks = [];
      let total = 0, truncated = false;
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          chunks.push(r.value);
          total += r.value.length;
          if (limit > 0 && total >= limit) { truncated = true; break; } // ImageReader truncates an over-long (padded) strip
        }
      } catch (e) {
        try { await reader.cancel(); } catch (_) { /* already closed */ }
        throw e && e.code === 'IJ_LIB_TIFF_CORRUPT' ? e : fail('IJ_LIB_TIFF_CORRUPT', 'the deflate stream is damaged', { cause: e });
      }
      if (truncated) { try { await reader.cancel(); } catch (_) { /* already closed */ } }
      const out = new Uint8Array(limit > 0 ? Math.min(total, limit) : total);
      let at = 0;
      for (const c of chunks) { if (at >= out.length) break; const part = at + c.length > out.length ? c.subarray(0, out.length - at) : c; out.set(part, at); at += part.length; }
      return out;
    }

    /* One strip of `rows` rows → one typed array per sample (spp planes of rows·width). Undoes the
     * deflate, the byte order and the horizontal predictor (TIFF 6.0 §14, per sample, modulo the sample
     * width — on the bit pattern for 32-bit floats too). */
    async function decodeStrip(p, bytes, rows, o) {
      const inf = (o && o.inflate) || inflate;
      const bps = p.bitDepth / 8, w = p.width, spp = p.spp;
      const want = rows * w * spp * bps;
      let raw = p.compression === 1 ? bytes : await inf(bytes, want);
      if (raw.length < want) throw fail('IJ_LIB_TIFF_CORRUPT', 'a strip holds ' + raw.length + ' bytes, ' + want + ' expected');
      // an aligned private copy: the views below need a 4-byte aligned buffer
      const copy = new Uint8Array(want);
      copy.set(raw.length === want ? raw : raw.subarray(0, want));
      raw = copy;
      if (bps > 1 && p.littleEndian !== HOST_LE) {
        for (let i = 0; i < want; i += bps) {
          if (bps === 2) { const t = raw[i]; raw[i] = raw[i + 1]; raw[i + 1] = t; }
          else { const a = raw[i], b = raw[i + 1]; raw[i] = raw[i + 3]; raw[i + 1] = raw[i + 2]; raw[i + 2] = b; raw[i + 3] = a; }
        }
      }
      const v8 = raw;
      const bits = bps === 1 ? v8 : bps === 2 ? new Uint16Array(raw.buffer) : new Uint32Array(raw.buffer);
      if (p.predictor === 2) {
        const rowLen = w * spp;
        for (let y = 0; y < rows; y++) {
          const base = y * rowLen;
          for (let x = spp; x < rowLen; x++) bits[base + x] = (bits[base + x] + bits[base + x - spp]); // the typed array wraps
        }
      }
      const view = p.float ? new Float32Array(raw.buffer) : bits;
      if (spp === 1) return [view];
      const planes = [];
      const Ctor = view.constructor;
      for (let j = 0; j < spp; j++) {
        const pl = new Ctor(rows * w);
        for (let i = 0, s = j; i < rows * w; i++, s += spp) pl[i] = view[s];
        planes.push(pl);
      }
      return planes;
    }

    /* The planes of a page (or strip band) from the bytes fetchRun returned for it: one typed array per
     * sample, (y1 − y0)·width each. */
    async function decodePage(p, entry, bytes, o) {
      const e = entryOf(p, entry);
      const { counts } = p.stripsOf(e.page);
      const rowsOf = (s) => Math.min(p.rowsPerStrip, p.height - s * p.rowsPerStrip);
      const y0 = e.s0 * p.rowsPerStrip, y1 = Math.min(p.height, e.s1 * p.rowsPerStrip);
      const planes = [];
      const Ctor = p.float ? Float32Array : p.bitDepth === 16 ? Uint16Array : Uint8Array;
      for (let j = 0; j < p.spp; j++) planes.push(new Ctor((y1 - y0) * p.width));
      let at = 0;
      for (let s = e.s0; s < e.s1; s++) {
        throwIfAborted(o && o.signal);
        const part = bytes.subarray(at, at + counts[s]);
        at += counts[s];
        const rows = rowsOf(s);
        const got = await decodeStrip(p, part, rows, o);
        for (let j = 0; j < p.spp; j++) planes[j].set(got[j], (s * p.rowsPerStrip - y0) * p.width);
      }
      return planes;
    }

    return { plan, pageOf, bands, runs, fetchRun, readPages, inflate, decodeStrip, decodePage, _parseMultipart: parseMultipart, _refusedMulti: refusedMulti };
  })();

  // ======================================================================================== IJOblique
  /* The oblique cut of a brick tree, accumulated brick by brick. The slice shader (volume-slicer.js) draws
   * an output pixel from `slabSteps` samples uvw_k of the texture-space point
   *
   *     t(px, py, s) = o + (px + ½)·a + (py + ½)·b + (s − (steps − 1)/2)·c                    (G)
   *
   * (o: texture-space origin of the frame's corner, a / b: one pixel along the frame's right / down, c: one
   * slab sample along the normal; derived from VolumeSlicer.planeGeometry by the viewer facade), and reads
   * the voxel floor(t ⊙ dims). Quoted from the shader's FRAG:
   *
   *     bool inBox(vec3 p) { return all(greaterThanEqual(p, vec3(0.0))) && all(lessThanEqual(p, vec3(1.0))); }
   *     // single plane (projMode == 0 || slabSteps <= 1):  if (!inBox(uvw)) transparent;  raw = rawAt(uvw)
   *     // slab, only the K samples inside the volume box count:
   *     //   MIP (projMode 1)      p_i = max_k s_i(uvw_k)
   *     //   average (projMode 2)  p_i = (1/K)·Σ_k s_i(uvw_k)
   *
   * and the RAW_OUTPUT target is an 8-bit render target, so the average is stored as round(255·mean/255) =
   * ⌊Σ/K + ½⌋ (half up; the float32 shader and this exact sum differ only on an exact tie's last ulp).
   * A sample whose t has a component outside [0, 1] is no sample (a single plane there is 0 — the shader's
   * transparent pixel); inside, t = 1 reads the last voxel (clamp-to-edge). The sum is taken in double on
   * the t of ONE fixed evaluation order, ((o + (px+½)a) + (py+½)b) + (s−h)c, which is also what
   * `reference` evaluates: both agree to the last bit. K comes from G alone (the number of s whose t lies
   * in [0, 1]³), never from deliveries: a brick that was never delivered nor failed (an ESS brick, zero
   * voxels) counts as 0 in the mean — it is not "missing". */
  const IJOblique = (() => {
    function checkG(G) {
      const ok = G && G.dims && G.width > 0 && G.height > 0 && Array.isArray(G.o) && Array.isArray(G.a) && Array.isArray(G.b) && Array.isArray(G.c)
        && G.o.length === 3 && G.a.length === 3 && G.b.length === 3 && G.c.length === 3 && G.steps >= 1
        && ['x', 'y', 'z'].every((k) => G.dims[k] > 0);
      if (!ok) throw fail('IJ_LIB_BAD_ARGS', 'oblique geometry');
      for (const v of [].concat(G.o, G.a, G.b, G.c)) if (!Number.isFinite(v)) throw fail('IJ_LIB_BAD_ARGS', 'oblique geometry');
    }

    function prepare(G) {
      checkG(G);
      const slab = Boolean(G.projected) && G.steps > 1 && (G.projMode === 'max' || G.projMode === 'mean');
      const mode = slab ? G.projMode : 'single';
      const n = slab ? G.steps : 1;
      const sc = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
      const h = (G.steps - 1) / 2;
      for (let s = 0; s < n; s++) {
        const d = slab ? s - h : 0;
        for (let k = 0; k < 3; k++) sc[k][s] = d * G.c[k];
      }
      const dimsArr = [G.dims.x, G.dims.y, G.dims.z];
      const W = G.width, H = G.height;
      const pxa = [new Float64Array(W), new Float64Array(W), new Float64Array(W)];
      for (let k = 0; k < 3; k++) for (let x = 0; x < W; x++) pxa[k][x] = (x + 0.5) * G.a[k];
      const pyb = [new Float64Array(H), new Float64Array(H), new Float64Array(H)];
      for (let k = 0; k < 3; k++) for (let y = 0; y < H; y++) pyb[k][y] = (y + 0.5) * G.b[k];
      return { G, mode, n, sc, dimsArr, W, H, pxa, pyb };
    }

    /* t_k at (px, py, s), the canonical evaluation order */
    const tk = (P, k, px, py, s) => P.G.o[k] + P.pxa[k][px] + P.pyb[k][py] + P.sc[k][s];

    /* The px interval (exact) where the sample is inside the volume box and, when `box` is given, its
     * clamped voxel lies in [lo_k, hi_k) on every axis. Every float operation of t_k(px) is monotone in
     * px (the sign of a_k fixes the direction), so each of the two one-sided conditions
     * (t ≥ 0 ∧ voxel ≥ lo, t ≤ 1 ∧ voxel < hi) is a step in px and its edge is found by bisection on the
     * exact predicate: O(log W) evaluations, whatever a_k (a tiny a_k = cos 90° included). → [l, r] or null. */
    function window(P, py, s, box) {
      let L = 0, R = P.W - 1;
      for (let k = 0; k < 3 && L <= R; k++) {
        const dim = P.dimsArr[k];
        const lo = box ? box.lo[k] : 0, hi = box ? box.hi[k] : dim;
        const voxelOf = (t) => { const x = t * dim; return x >= dim ? dim - 1 : Math.floor(x); };
        const low = (px) => { const t = tk(P, k, px, py, s); return t >= 0 && (!box || voxelOf(t) >= lo); };
        const high = (px) => { const t = tk(P, k, px, py, s); return t <= 1 && (!box || voxelOf(t) < hi); };
        const a = P.G.a[k];
        let l, r;
        if (a === 0) {
          if (!(low(0) && high(0))) return null;
          continue;
        }
        const up = a > 0;                                    // t non-decreasing in px: low goes false→true, high true→false
        const first = (f) => {                               // smallest px of [L, R] where the step f is true (f: false→true)
          if (!f(R)) return R + 1;
          let x = L, y = R;
          while (x < y) { const m = (x + y) >> 1; if (f(m)) y = m; else x = m + 1; }
          return x;
        };
        const last = (f) => {                                // largest px of [L, R] where f is true (f: true→false)
          if (!f(L)) return L - 1;
          let x = L, y = R;
          while (x < y) { const m = (x + y + 1) >> 1; if (f(m)) x = m; else y = m - 1; }
          return x;
        };
        if (up) { l = first(low); r = last(high); } else { l = first(high); r = last(low); }
        if (l > r) return null;
        L = Math.max(L, l);
        R = Math.min(R, r);
      }
      return L <= R ? [L, R] : null;
    }

    /* The rows and slab steps a box can touch. The box's 8 corners, taken to the frame's own coordinates
     * (px + ½, py + ½, s − h) with the inverse of [a b c], bound them (an affine image of a box is spanned
     * by its corners); 2 more on each side absorb the rounding. A degenerate frame (no inverse) bounds
     * nothing: every row and step is visited, `window` stays exact. */
    function reach(P, box) {
      const full = { py0: 0, py1: P.H - 1, s0: 0, s1: P.n - 1 };
      const { a, b, c, o } = P.G;
      const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
      const len = (v) => Math.hypot(v[0], v[1], v[2]);
      if (!(Math.abs(det) > 1e-9 * len(a) * len(b) * len(c))) return full;
      // rows of the inverse = cross products of the other two columns, / det
      const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const rowB = cross(c, a).map((v) => v / det);          // py + ½
      const rowC = cross(a, b).map((v) => v / det);          // s − h
      const dims = P.dimsArr;
      const xs = [box.x0 / dims[0], box.x1 / dims[0]], ys = [box.y0 / dims[1], box.y1 / dims[1]], zs = [box.z0 / dims[2], box.z1 / dims[2]];
      let bLo = Infinity, bHi = -Infinity, cLo = Infinity, cHi = -Infinity;
      for (const x of xs) for (const y of ys) for (const z of zs) {
        const d = [x - o[0], y - o[1], z - o[2]];
        const ub = rowB[0] * d[0] + rowB[1] * d[1] + rowB[2] * d[2];
        const uc = rowC[0] * d[0] + rowC[1] * d[1] + rowC[2] * d[2];
        if (ub < bLo) bLo = ub; if (ub > bHi) bHi = ub;
        if (uc < cLo) cLo = uc; if (uc > cHi) cHi = uc;
      }
      if (!(Number.isFinite(bLo) && Number.isFinite(bHi) && Number.isFinite(cLo) && Number.isFinite(cHi))) return full;
      const out = { py0: Math.max(0, Math.floor(bLo - 0.5) - 2), py1: Math.min(P.H - 1, Math.ceil(bHi - 0.5) + 2), s0: 0, s1: P.n - 1 };
      if (P.mode !== 'single') {
        const h = (P.G.steps - 1) / 2;
        out.s0 = Math.max(0, Math.floor(cLo + h) - 2);
        out.s1 = Math.min(P.n - 1, Math.ceil(cHi + h) + 2);
      }
      return out;
    }

    /* Calls visit(pixel, vx, vy, vz) for every sample whose voxel lies in `box` (half-open, level voxels). */
    function eachSample(P, box, visit) {
      const b = { lo: [box.x0, box.y0, box.z0], hi: [box.x1, box.y1, box.z1] };
      const dims = P.dimsArr, o = P.G.o;
      const r = reach(P, box);
      for (let py = r.py0; py <= r.py1; py++) {
        for (let s = r.s0; s <= r.s1; s++) {
          const w = window(P, py, s, b);
          if (!w) continue;
          const row = py * P.W;
          for (let px = w[0]; px <= w[1]; px++) {
            const x = (o[0] + P.pxa[0][px] + P.pyb[0][py] + P.sc[0][s]) * dims[0];
            const y = (o[1] + P.pxa[1][px] + P.pyb[1][py] + P.sc[1][s]) * dims[1];
            const z = (o[2] + P.pxa[2][px] + P.pyb[2][py] + P.sc[2][s]) * dims[2];
            visit(row + px, x >= dims[0] ? dims[0] - 1 : Math.floor(x), y >= dims[1] ? dims[1] - 1 : Math.floor(y), z >= dims[2] ? dims[2] - 1 : Math.floor(z));
          }
        }
      }
    }

    function checkBrick(brick, P) {
      const b = brick && brick.box;
      if (!b || !(b.x1 > b.x0 && b.y1 > b.y0 && b.z1 > b.z0)) throw fail('IJ_LIB_BAD_ARGS', 'brick box');
      if (b.x0 < 0 || b.y0 < 0 || b.z0 < 0 || b.x1 > P.dimsArr[0] || b.y1 > P.dimsArr[1] || b.z1 > P.dimsArr[2]) throw fail('IJ_LIB_BAD_ARGS', 'brick outside the volume');
      const n = (b.x1 - b.x0) * (b.y1 - b.y0) * (b.z1 - b.z0);
      if (!brick.data || brick.data.length !== n) throw fail('IJ_LIB_BAD_ARGS', 'brick data size');
      return b;
    }

    function estimateBytes(G, o) {
      checkG(G);
      const channels = (o && o.channels) || 1;
      const slab = G.projected && G.steps > 1 && G.projMode === 'mean';
      // one channel at a time: the accumulator (Uint32 for a mean, else Uint8), the 8-bit result of a
      // mean's finish() and the Uint8 mask of missing(); only the 8-bit results of several channels add up
      const px = G.width * G.height;
      return px * (slab ? 4 + 1 + 1 : 1 + 1) + px * Math.max(0, channels - 1) + G.width * 10;
    }

    /* The accumulator of ONE channel. `outBitDepth` must be 8 (the library's bricks are 8-bit). */
    function create(G, o) {
      const opt = o || {};
      if (opt.outBitDepth !== undefined && opt.outBitDepth !== 8) throw fail('IJ_LIB_BAD_ARGS', 'IJOblique writes 8-bit pictures');
      const P = prepare(G);
      const N = P.W * P.H;
      const acc = P.mode === 'mean' ? new Uint32Array(N) : new Uint8Array(N);
      const channel = opt.channel === undefined ? null : opt.channel;

      function add(brick) {
        if (channel !== null && brick.channel !== undefined && brick.channel !== channel) return false;
        const b = checkBrick(brick, P);
        const bw = b.x1 - b.x0, bh = b.y1 - b.y0, data = brick.data;
        if (P.mode === 'max') eachSample(P, b, (p, x, y, z) => { const v = data[((z - b.z0) * bh + (y - b.y0)) * bw + (x - b.x0)]; if (v > acc[p]) acc[p] = v; });
        else if (P.mode === 'mean') eachSample(P, b, (p, x, y, z) => { acc[p] += data[((z - b.z0) * bh + (y - b.y0)) * bw + (x - b.x0)]; });
        else eachSample(P, b, (p, x, y, z) => { acc[p] = data[((z - b.z0) * bh + (y - b.y0)) * bw + (x - b.x0)]; });
        return true;
      }

      /* K per pixel (the samples inside the volume, from G alone), one row at a time with a difference
       * array: fn(py, K) gets a Uint16Array of the row — no per-pixel counter plane is ever kept. */
      function eachCountRow(fn) {
        const diff = new Int32Array(P.W + 1), row = new Uint16Array(P.W);
        for (let py = 0; py < P.H; py++) {
          diff.fill(0);
          for (let s = 0; s < P.n; s++) {
            const w = window(P, py, s, null);
            if (w) { diff[w[0]]++; diff[w[1] + 1]--; }
          }
          let run = 0;
          for (let px = 0; px < P.W; px++) { run += diff[px]; row[px] = run; }
          fn(py, row);
        }
      }

      /* The output pixels with a sample in one of the failed boxes (never an ESS brick: that is zeros). */
      function missing(boxes) {
        const mask = new Uint8Array(N);
        for (const b of boxes || []) eachSample(P, b, (p) => { mask[p] = 1; });
        let count = 0;
        for (let i = 0; i < N; i++) count += mask[i];
        return { count, mask };
      }

      /* 1 where the cut meets the volume (at least one sample inside), geometry alone. */
      function coverage() {
        const out = new Uint8Array(N);
        eachCountRow((py, K) => { for (let px = 0; px < P.W; px++) out[py * P.W + px] = K[px] > 0 ? 1 : 0; });
        return out;
      }

      function finish() {
        if (P.mode !== 'mean') return acc;
        const out = new Uint8Array(N);
        eachCountRow((py, K) => {
          const base = py * P.W;
          for (let px = 0; px < P.W; px++) out[base + px] = K[px] ? Math.floor(acc[base + px] / K[px] + 0.5) : 0;
        });
        return out;
      }

      return { add, missing, coverage, finish, mode: P.mode, estimateBytes: () => estimateBytes(G, { channels: 1 }) };
    }

    /* The direct evaluation: every (px, py, s), no windows, no bricks. `volume(x, y, z)` returns the voxel. */
    function reference(G, volume) {
      const P = prepare(G);
      const out = new Uint8Array(P.W * P.H), dims = P.dimsArr;
      for (let py = 0; py < P.H; py++) {
        for (let px = 0; px < P.W; px++) {
          let max = 0, sum = 0, hits = 0;
          for (let s = 0; s < P.n; s++) {
            const t = [0, 1, 2].map((k) => tk(P, k, px, py, s));
            if (!t.every((v) => v >= 0 && v <= 1)) continue;
            const v = [0, 1, 2].map((k) => { const x = t[k] * dims[k]; return x >= dims[k] ? dims[k] - 1 : Math.floor(x); });
            const val = volume(v[0], v[1], v[2]);
            hits++; sum += val; if (val > max) max = val;
          }
          out[py * P.W + px] = P.mode === 'mean' ? (hits ? Math.floor(sum / hits + 0.5) : 0) : max;
        }
      }
      return out;
    }

    return { create, reference, estimateBytes };
  })();

  // ==================================================================================== IJLibSource
  /* The pure rules of "Open from Library" shared by the page (panel, entry flow) and the worker (commands below):
   * what a TIFF offers next to a dataset, which TIFF planes cover which slices, names, keys. No I/O. */
  const IJLibSource = (() => {
    /* ZProjector.METHODS = {"Average Intensity", "Max Intensity", "Min Intensity", "Sum Slices", "Standard Deviation",
     * "Median"} (IJ/plugin/ZProjector.java:24), and makeTitle() (:606-615): "AVG_" unless SUM_ MAX_ MIN_ STD_ MED_. */
    const METHODS = ['avg', 'max', 'min', 'sum', 'sd', 'median'];
    const PREFIX = { avg: 'AVG_', max: 'MAX_', min: 'MIN_', sum: 'SUM_', sd: 'STD_', median: 'MED_' };
    /* CompositeImage.colors (IJ/CompositeImage.java:15): red, green, blue, white, cyan, magenta, yellow, white */
    const IMAGEJ_COLORS = ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#00ffff', '#ff00ff', '#ffff00', '#ffffff'];
    const EPS = 1e-9;

    const projectionTitle = (method, name) => (PREFIX[method] || PREFIX.avg) + String(name);

    /* The free text tools/build_download_bundles.py:tiff_info writes (Fiji's Image > Show Info):
     *   "Source: Imaris .ims ResolutionLevel {level}, native {dtype}" + ", timepoint {t} of 0..{N-1}" (one frame of a timelapse)
     *   "Voxel size (um): X={x} Y={y} Z={z}" */
    function tiffLevelOf(info) {
      const m = /ResolutionLevel\s+(\d+)/.exec(String(info || ''));
      return m ? Number(m[1]) : null;
    }
    /* The frame a timelapse bundle TIFF holds, from the info block the pipeline writes (tools/build_download_bundles.py:364-376, tiff_info):
     *   f"Source: Imaris .ims ResolutionLevel {level}, native {dtype}"
     *   + (f", timepoint {frame[0]} of 0..{frame[1] - 1}" if frame else "")
     * so "timepoint 1 of 0..2" is frame 1 of 3. */
    function tiffFrameOf(info) {
      const m = /timepoint\s+(\d+)\s+of\s+0\.\.(\d+)/.exec(String(info || ''));
      return m ? { frame: Number(m[1]), count: Number(m[2]) + 1 } : null;
    }
    function tiffVoxelOf(info) {
      const m = /Voxel size \(um\):\s*X=(\S+)\s+Y=(\S+)\s+Z=(\S+)/.exec(String(info || ''));
      if (!m) return null;
      const v = { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
      return v.x > 0 && v.y > 0 && v.z > 0 ? v : null;
    }

    /* The plan of a TIFF for a dataset of type 2d: its pages are channels (one page per channel in the ImageJ composites the
     * pipeline writes; a plain multi-page TIFF without ImageJ metadata too). A chunky RGB page is already 3 channels. */
    function planFor(index, asChannels) {
      const p = IJTiffStream.plan(index);
      if (asChannels && p.spp === 1 && p.channels === 1 && p.slices > 1) return Object.assign({}, p, { channels: p.slices, slices: 1 });
      return p;
    }

    /* Which TIFF planes cover the dataset's level-0 slices [first, last] (inclusive). Dataset plane i covers [i·vz0, (i+1)·vz0) µm,
     * TIFF plane j covers [j·vzT, (j+1)·vzT): a range → jlo = floor(first·vz0/vzT), jhi = ceil((last+1)·vz0/vzT) − 1; one plane →
     * the TIFF plane holding its centre (i + ½)·vz0. Clamped to the stack. */
    // A ten-thousandth of a plane: metadata.json prints the z step with 6 decimals (4.652059) while the TIFF carries the full double
    // (spacing=4.652059326…), so slice 90 maps to TIFF plane 89.999994 — that is plane 90, not a sliver of plane 89.
    const ZTOL = 1e-4;
    function tiffZRange(o) {
      const n = Math.max(1, o.slices | 0);
      const clamp = (v) => Math.max(0, Math.min(n - 1, v));
      const ratio = o.vz0 / o.vzT;
      if (!(ratio > 0) || !Number.isFinite(ratio)) return { jlo: 0, jhi: n - 1, single: false };
      if (o.first === o.last) {
        const j = clamp(Math.floor((o.first + 0.5) * ratio + ZTOL));
        return { jlo: j, jhi: j, single: true };
      }
      const jlo = clamp(Math.floor(o.first * ratio + ZTOL));
      const jhi = Math.max(jlo, clamp(Math.ceil((o.last + 1) * ratio - ZTOL) - 1));
      return { jlo, jhi, single: false };
    }

    /* tiffZRange for a TIFF judged by tiffFacts: `nz` = the dataset's level-0 slices (what `first` / `last` index). A dataset with no
     * physical z (or none to map to) is taken stack-to-stack: the TIFF's planes are the dataset's, resampled proportionally. */
    function tiffRangeOf(facts, nz, first, last) {
      const n = Math.max(1, nz | 0);
      const mapped = facts.vz0 > 0 && facts.vzT > 0;
      return tiffZRange({ first, last, vz0: mapped ? facts.vz0 : 1, vzT: mapped ? facts.vzT : n / facts.slices, slices: facts.slices });
    }

    function channelNames(plan, n) {
      const out = [];
      const labels = plan.labels || [];
      // ImageJ's slice labels name the channels — unless they are one string for all of them (the Leica composites label every page with
      // the acquisition's name) or too long to be a name: then C1, C2…
      const clean = labels.slice(0, n).map((l) => (typeof l === 'string' ? l.replace(/^c:\d+\/\d+\s*-\s*/i, '').trim() : ''));      // Bio-Formats' "c:1/3 - <name>"
      const usable = clean.length === n && new Set(clean).size === n && clean.every((l) => l && l.length <= 40);
      for (let i = 0; i < n; i++) {
        if (usable) out.push(clean[i]);
        else if (plan.spp === 3 && n === 3) out.push(['R', 'G', 'B'][i]);
        else out.push('C' + (i + 1));
      }
      return out;
    }
    function channelColors(plan, n) {
      const out = [];
      for (let i = 0; i < n; i++) {
        const c = (plan.colors || [])[i];
        if (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) out.push(c.toLowerCase());
        else if (plan.spp === 3 && n === 3) out.push(IMAGEJ_COLORS[i]);
        else out.push(n === 1 ? '#ffffff' : IMAGEJ_COLORS[i % IMAGEJ_COLORS.length]);
      }
      return out;
    }

    /* What a TIFF is worth to a dataset, or why it is not offered:
     *   o = { physicalUm: {x, y, z, calibrated?} | null, dims: {x, y, z} (level 0) | null, live: bool, timepoint: n | null, asChannels: bool }
     *   → { ok: false, reason: 'unsupported' | 'extent' | 'frame', code?, detail? }
     *   | { ok: true, plan, level, width, height, slices, channels, bitDepth, pixelUm: {x, y} | null, calibrated, frame, vz0, vzT, names,
     *       colors, coarser: bool (fewer pixels than the dataset's level 0) } */
    function tiffFacts(index, o) {
      const opt = o || {};
      let plan;
      try { plan = planFor(index, !!opt.asChannels); } catch (err) {
        return { ok: false, reason: 'unsupported', code: (err && err.code) || null, detail: (err && err.detail) || null };
      }
      const info = (index.imagej && index.imagej.info) || '';
      const vox = tiffVoxelOf(info);
      const phys = opt.physicalUm && opt.physicalUm.x > 0 && opt.physicalUm.y > 0 ? opt.physicalUm : null;
      const physCal = !!phys && phys.calibrated !== false;
      let known = true;
      let px = plan.pixelUm ? plan.pixelUm.x : (vox ? vox.x : null);
      let py = plan.pixelUm ? plan.pixelUm.y : (vox ? vox.y : null);
      if (px === null && phys) { px = phys.x / plan.width; py = phys.y / plan.height; known = false; }
      // the TIFF must cover the dataset's field: its width in µm within one TIFF pixel of the volume's
      if (known && px !== null && physCal && !(Math.abs(plan.width * px - phys.x) <= px && Math.abs(plan.height * py - phys.y) <= py)) {
        return { ok: false, reason: 'extent' };
      }
      // the frame: a timelapse's bundle TIFF holds ONE frame, named in its info block; a TIFF with several frames is indexed by t
      let frame = 0;
      if (opt.live) {
        const tp = opt.timepoint === null || opt.timepoint === undefined ? 0 : opt.timepoint;
        if (plan.frames > 1) { if (!(tp >= 0 && tp < plan.frames)) return { ok: false, reason: 'frame' }; frame = tp; }
        else {
          const f = tiffFrameOf(info);
          if (!f || f.frame !== tp) return { ok: false, reason: 'frame' };
        }
      }
      let vz0 = null, vzT = null;
      if (phys && opt.dims && opt.dims.z > 0 && phys.z > 0) {
        vz0 = phys.z / opt.dims.z;
        vzT = plan.spacingUm || (vox && vox.z) || phys.z / plan.slices;
      }
      const channels = plan.spp > 1 ? plan.spp : plan.channels;
      return {
        ok: true, plan, level: tiffLevelOf(info), width: plan.width, height: plan.height, slices: plan.slices, channels, bitDepth: plan.bitDepth,
        pixelUm: px === null ? null : { x: px, y: py }, calibrated: px !== null, frame, vz0, vzT,
        names: channelNames(plan, channels), colors: channelColors(plan, channels),
        coarser: !!(opt.dims && plan.width * plan.height < opt.dims.x * opt.dims.y * 0.99)
      };
    }

    /* The pages a read takes: for z in [z0, z1] and the wanted channels (a chunky page counts once). */
    function pagesFor(plan, z0, z1, frame, chans) {
      const out = [];
      for (let z = z0; z <= z1; z++) {
        if (plan.chunky) out.push(IJTiffStream.pageOf(plan, { z, c: 0, t: frame }));
        else for (const c of chans) out.push(IJTiffStream.pageOf(plan, { z, c, t: frame }));
      }
      return out;
    }
    /* Compressed bytes the read downloads (from the strip tables): what the panel shows next to the TIFF. */
    function readBytes(plan, z0, z1, frame, chans) {
      let total = 0;
      for (const page of pagesFor(plan, z0, z1, frame, chans)) {
        const s = plan.stripsOf(page);
        for (let i = 0; i < s.counts.length; i++) total += s.counts[i];
      }
      return total;
    }

    /* The session key of a library document (PLAN-wave3 §4): lib|<datasetId>|<treeKey>|<tp>|<z:first-last | obl:…>|<level>|<method>|<input>|<stamp> */
    function sessionKey(o) {
      const where = o.mode === 'oblique'
        ? 'obl:' + [o.spec.yaw, o.spec.pitch, o.spec.roll, o.spec.depth, o.spec.thickness, o.spec.projection].join(',')
        : 'z:' + o.first + '-' + o.last;
      return ['lib', o.datasetId, o.treeKey || '', o.timepoint === null || o.timepoint === undefined ? '' : o.timepoint, where,
        o.level === null || o.level === undefined ? '' : o.level, o.method || '', o.input, o.stamp].join('|');
    }
    /* A stored session of the figure: which source made it. The figure key of the TIFF source is fkey|tiff|…, the processed one
     * fkey|<level>|… (enter() matches both by the fkey| prefix). */
    function sourceOfKey(key, fkey) {
      const rest = String(key).slice(String(fkey).length + 1).split('|')[0];
      return rest === 'tiff' ? 'tiff' : 'processed';
    }

    return { METHODS, PREFIX, IMAGEJ_COLORS, projectionTitle, tiffLevelOf, tiffFrameOf, tiffVoxelOf, planFor, tiffZRange, tiffRangeOf, tiffFacts, pagesFor, readBytes, sessionKey, sourceOfKey };
  })();

  // ============================================================================ worker commands (pkg lib)
  /* The three families of worker commands of "Open from Library", registered with IJOpRegistry.defineCommand: the page reaches them
   * with api.call (or `call` for the entry flow), the documents they build are taken in with api.adopt.
   *   doc.tiff.project   one projection of an original TIFF, read page by page with Range requests (IJTiffStream) — long
   *   doc.zproj.*        the same projection of a processed volume, the page feeding the blocks IJProject takes
   *   doc.oblique.*      an oblique plane accumulated brick by brick (IJOblique)
   * Nothing is written into a document; a handler's arrays live in its own buffers until E.createDoc. */
  (function registerCommands() {
    const R = root.IJOpRegistry;
    if (!R || typeof R.defineCommand !== 'function') return;
    const define = (name, spec) => R.defineCommand(name, Object.assign({ pkg: 'lib' }, spec));
    const MAX_LIVE = 3;                           // accumulators alive at once; a new begin drops the oldest
    const FETCH_MAX = 64 * MIB;
    let tokenSeq = 0;
    const live = new Map();                       // token → { kind, … }

    const bad = (E, what) => E.ijError('IJ_BAD_ARGS', 'lib: ' + what);
    const isInt = (v) => Number.isInteger(v);
    const hexColor = (c) => (typeof c === 'string' && /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(c) ? c : undefined);
    const cleanName = (s, fallback) => (typeof s === 'string' && s.length && s.length <= 255 ? s : fallback);

    function newToken(kind, rec) {
      while (live.size >= MAX_LIVE) live.delete(live.keys().next().value);
      const token = 'lib' + kind + (++tokenSeq);
      live.set(token, Object.assign({ kind }, rec));
      return token;
    }
    function tokenOf(E, token, kind) {
      const rec = live.get(token);
      if (!rec || rec.kind !== kind) throw E.ijError('IJ_LIB_NO_TOKEN', 'the image under construction is gone');
      return rec;
    }
    function calibrationOf(E, c) {
      if (c === undefined || c === null) return { pixelWidth: 1, pixelHeight: 1, unit: 'pixel' };
      if (typeof c !== 'object' || !(c.pixelWidth > 0) || !(c.pixelHeight > 0) || !Number.isFinite(c.pixelWidth) || !Number.isFinite(c.pixelHeight)) throw bad(E, 'calibration');
      return { pixelWidth: c.pixelWidth, pixelHeight: c.pixelHeight, unit: typeof c.unit === 'string' ? c.unit.slice(0, 64) : 'pixel' };
    }
    const plain = (v) => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : {});
    const checkMethod = (E, m) => { if (IJLibSource.METHODS.indexOf(m) < 0) throw bad(E, 'method'); return m; };
    const keyOfArgs = (a) => (typeof a.sessionKey === 'string' && a.sessionKey ? a.sessionKey : undefined);

    // ---------------------------------------------------------------------------------------- doc.tiff.project
    /* Reads pages z0..z1 of the TIFF (channels `channels[].c`) into IJProject, band by band (a band = whole strips of every page of the
     * range: the peak the accumulator needs), several pages per request. The projection's input bit depth is the TIFF's: a 16-bit TIFF
     * keeps 16 bits for Max / Min / Average; Median, Sum and SD are 32-bit float (IJProject.outputBitDepth, ZProjector.java:
     * the median of a 16-bit stack is a float image). Progress: the event `libTiffProgress { fraction }` (whole percents) for the panel. args: { url (absolute), index (the
     * api/tiff-index answer), z0, z1, frame, channels: [{ c, name, color }], method, name, calibration, provenance, sessionKey, asChannels } */
    define('doc.tiff.project', { long: true, async handler(a, E) {
      const IJProject = root.IJProject;
      if (!a || typeof a !== 'object') throw bad(E, 'args');
      if (typeof a.url !== 'string' || !/^[a-z][a-z0-9+.-]*:\/\/[^/]/i.test(a.url)) throw bad(E, 'url');
      const plan = IJLibSource.planFor(a.index, !!a.asChannels);       // IJ_LIB_TIFF_UNSUPPORTED before one byte is requested
      const method = checkMethod(E, a.method);
      const z0 = a.z0, z1 = a.z1, frame = a.frame === undefined ? 0 : a.frame;
      if (!isInt(z0) || !isInt(z1) || z0 < 0 || z1 < z0 || z1 >= plan.slices) throw bad(E, 'z range');
      if (!isInt(frame) || frame < 0 || frame >= plan.frames) throw bad(E, 'frame');
      const nCh = plan.spp > 1 ? plan.spp : plan.channels;
      if (!Array.isArray(a.channels) || !a.channels.length || a.channels.length > 64) throw bad(E, 'channels');
      const chans = a.channels.map((c) => {
        if (!c || !isInt(c.c) || c.c < 0 || c.c >= nCh) throw bad(E, 'channel');
        return { c: c.c, name: cleanName(c.name, 'C' + (c.c + 1)), color: hexColor(c.color) };
      });
      const calibration = calibrationOf(E, a.calibration);
      const C = chans.length, depth = z1 - z0 + 1, bps = plan.bitDepth / 8;
      const fetchBytes = Math.min(FETCH_MAX, Math.max(4 * MIB, Math.floor((E.budgetBytes || 0) / 8)));
      let perBand = plan.stripsPerPage, bandRows = plan.height;
      for (;;) {
        bandRows = Math.min(plan.height, perBand * plan.rowsPerStrip);
        const need = IJProject.estimateBytes({ method, width: plan.width, height: plan.height, depth, channels: C, bandRows, inputBitDepth: plan.bitDepth })
          + 2 * bandRows * plan.width * bps * (plan.spp + 1) + fetchBytes;
        try { E.reserve(need); break; } catch (err) {
          if (err && err.code === 'IJ_OVER_BUDGET' && perBand > 1) { perBand = Math.ceil(perBand / 2); continue; }
          throw err;
        }
      }
      const projector = IJProject.create({ method, width: plan.width, height: plan.height, depth, channels: C, inputBitDepth: plan.bitDepth });
      // Cancel: the page's request is a task the engine flags; the fetches in flight are aborted from here.
      const ac = typeof AbortController === 'function' ? new AbortController() : { signal: undefined, abort() {} };
      let cancelled = false;
      const watch = setInterval(() => { try { E.check(); } catch (err) { cancelled = true; ac.abort(); } }, 100);
      let requests = 0, lastPct = -1;
      try {
        for (let s0 = 0; s0 < plan.stripsPerPage; s0 += perBand) {
          const s1 = Math.min(plan.stripsPerPage, s0 + perBand);
          const y0 = s0 * plan.rowsPerStrip, rows = Math.min(plan.height, s1 * plan.rowsPerStrip) - y0;
          const whole = s0 === 0 && s1 === plan.stripsPerPage;
          const keyOf = (page) => (whole ? page : page + ':' + s0);
          const targets = new Map(), entries = [];
          const want = (page, t) => {
            const k = keyOf(page);
            if (!targets.has(k)) { targets.set(k, []); entries.push(whole ? page : { page, s0, s1 }); }
            targets.get(k).push(t);
          };
          for (let z = z0; z <= z1; z++) {
            if (plan.chunky) { const page = IJTiffStream.pageOf(plan, { z, c: 0, t: frame }); chans.forEach((ch, k) => want(page, { z, ci: k, plane: ch.c })); }
            else chans.forEach((ch, k) => want(IJTiffStream.pageOf(plan, { z, c: ch.c, t: frame }), { z, ci: k, plane: 0 }));
          }
          const got = await IJTiffStream.readPages(a.url, plan, entries, {
            concurrency: 2, signal: ac.signal, fetchImpl: (...args) => E.fetch(...args), maxBytes: Math.floor(fetchBytes / 2),
            onPage: async (entry, bytes) => {
              const list = targets.get(keyOf(entry.page));
              const planes = await IJTiffStream.decodePage(plan, entry, bytes, { signal: ac.signal });
              for (const t of list) projector.addBlock({ channel: t.ci, y0, rows, z0: t.z - z0, depth: 1, data: planes[t.plane] });
              const frac = projector.progress();
              await E.tick(frac, 'op.libTiff');
              const pct = Math.floor(100 * frac);
              if (pct > lastPct) { lastPct = pct; E.postEvent({ event: 'libTiffProgress', fraction: frac }); }
            }
          });
          requests += got.requests;
        }
        E.check();
      } catch (err) {
        if (cancelled || (err && err.name === 'AbortError')) throw E.ijError('IJ_CANCELLED', 'cancelled');
        throw err;
      } finally { clearInterval(watch); }
      const outs = projector.finish();
      // The stored display range of the acquisition. ZProjector resets a single-channel projection to its own data range (ZProjector.java:363,
      // :367, :579, :679) and, for a multichannel image, copies the LUTs / ranges (copyLuts(imp), :446-450) and resets only Sum and SD; so the
      // ranges are carried when C > 1 and the method is neither, whatever the output depth (a 16-bit Median is a float image on the input's
      // scale). A single plane is no projection: it keeps what the file says.
      const keepRanges = depth === 1 || (nCh > 1 && method !== 'sum' && method !== 'sd');
      const channels = outs.map((o, k) => {
        const ch = { data: o.data, name: chans[k].name, color: chans[k].color };
        const lo = plan.ranges[chans[k].c * 2], hi = plan.ranges[chans[k].c * 2 + 1];
        if (keepRanges && Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) {
          ch.display = { min: lo, max: hi, lut: root.IJLuts ? root.IJLuts.forColor(chans[k].color || '#ffffff') : null, invert: false };
        }
        return ch;
      });
      const info = E.createDoc({ name: cleanName(a.name, 'TIFF'), width: plan.width, height: plan.height, bitDepth: outs[0].bitDepth, calibration, channels },
        { provenance: plain(a.provenance), sessionKey: keyOfArgs(a) });
      return { info, bitDepth: outs[0].bitDepth, requests };
    } });

    // ---------------------------------------------------------------------------------------- doc.photo.create
    /* A photograph decoded on the page (RGBA bytes, transferred) → one grey channel when R = G = B everywhere, else R, G, B channels (8-bit).
     * The per-pixel work lives here so the page's main thread stays free. args: { name, width, height, rgba, calibration, provenance, sessionKey } */
    define('doc.photo.create', { async handler(a, E) {
      if (!a || typeof a !== 'object') throw bad(E, 'args');
      if (!isInt(a.width) || !isInt(a.height) || a.width < 1 || a.height < 1) throw bad(E, 'size');
      const n = a.width * a.height;
      if (!a.rgba || !ArrayBuffer.isView(a.rgba) || a.rgba.BYTES_PER_ELEMENT !== 1 || a.rgba.length !== 4 * n) throw bad(E, 'rgba');
      const calibration = calibrationOf(E, a.calibration);
      E.reserve(3 * n);
      const rgba = a.rgba;
      const r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n);
      let grey = true;
      for (let i = 0, k = 0; i < n; i++, k += 4) {
        r[i] = rgba[k]; g[i] = rgba[k + 1]; b[i] = rgba[k + 2];
        if (grey && (r[i] !== g[i] || r[i] !== b[i])) grey = false;
        if ((i & 0xFFFFF) === 0xFFFFF) E.check();
      }
      const channels = grey ? [{ data: r, name: 'Gray', color: '#ffffff' }]
        : [{ data: r, name: 'R', color: IJLibSource.IMAGEJ_COLORS[0] }, { data: g, name: 'G', color: IJLibSource.IMAGEJ_COLORS[1] }, { data: b, name: 'B', color: IJLibSource.IMAGEJ_COLORS[2] }];
      const info = E.createDoc({ name: cleanName(a.name, 'photograph'), width: a.width, height: a.height, bitDepth: 8, calibration, channels },
        { provenance: plain(a.provenance), sessionKey: keyOfArgs(a) });
      return { info };
    } });

    // ---------------------------------------------------------------------------------------- doc.zproj.*
    /* begin { method, width, height, depth, channels: [{ name, color }], name, calibration, provenance, sessionKey, bandRows } → { token,
     * outputBitDepth, bandRows }; add { token, y0, rows, z0, depth, data: [Uint8Array per channel] } → { fraction };
     * finish { token } → { info }; abort { token }. The page streams the blocks of a library session (8-bit, processed volume). */
    define('doc.zproj.begin', { async handler(a, E) {
      const IJProject = root.IJProject;
      if (!a || typeof a !== 'object') throw bad(E, 'args');
      const method = checkMethod(E, a.method);
      for (const k of ['width', 'height', 'depth']) if (!isInt(a[k]) || a[k] < 1) throw bad(E, k);
      if (!Array.isArray(a.channels) || !a.channels.length || a.channels.length > 64) throw bad(E, 'channels');
      const calibration = calibrationOf(E, a.calibration);
      let rows = isInt(a.bandRows) && a.bandRows > 0 ? Math.min(a.bandRows, a.height) : Math.min(64, a.height);
      for (;;) {
        const need = IJProject.estimateBytes({ method, width: a.width, height: a.height, depth: a.depth, channels: a.channels.length, bandRows: rows, inputBitDepth: 8 });
        try { E.reserve(need); break; } catch (err) {
          if (err && err.code === 'IJ_OVER_BUDGET' && rows > 8) { rows = Math.max(8, rows >> 1); continue; }
          throw err;
        }
      }
      // ZProjector's own output depth for an 8-bit stack (Average 8, Sum 32, Median 8): the same image as the TIFF route gives for an 8-bit TIFF
      const projector = IJProject.create({ method, width: a.width, height: a.height, depth: a.depth, channels: a.channels.length, inputBitDepth: 8 });
      const token = newToken('z', { projector, a: { name: cleanName(a.name, 'projection'), width: a.width, height: a.height, calibration,
        channels: a.channels.map((c, i) => ({ name: cleanName(c && c.name, 'C' + (i + 1)), color: hexColor(c && c.color) })),
        provenance: plain(a.provenance), sessionKey: keyOfArgs(a) } });
      return { token, outputBitDepth: projector.outputBitDepth, bandRows: rows };
    } });
    define('doc.zproj.add', { long: true, async handler(a, E) {
      E.check();
      const rec = tokenOf(E, a && a.token, 'z');
      if (!Array.isArray(a.data) || a.data.length !== rec.a.channels.length) throw bad(E, 'data');
      a.data.forEach((data, channel) => rec.projector.addBlock({ channel, y0: a.y0, rows: a.rows, z0: a.z0, depth: a.depth, data }));
      return { fraction: rec.projector.progress() };
    } });
    define('doc.zproj.finish', { async handler(a, E) {
      const rec = tokenOf(E, a && a.token, 'z');
      const outs = rec.projector.finish();
      live.delete(a.token);
      const m = rec.a;
      const info = E.createDoc({ name: m.name, width: m.width, height: m.height, bitDepth: outs[0].bitDepth, calibration: m.calibration,
        channels: outs.map((o, k) => ({ data: o.data, name: m.channels[k].name, color: m.channels[k].color })) }, { provenance: m.provenance, sessionKey: m.sessionKey });
      return { info };
    } });
    define('doc.zproj.abort', { async handler(a) { return { dropped: live.delete(a && a.token) }; } });

    // ---------------------------------------------------------------------------------------- doc.oblique.*
    /* begin { G, channels: [{ index, name, color }], name, calibration, provenance, sessionKey } → { token } (the handler checks what the
     * accumulators need fits; no document yet); add { token, channel, box, data } → { ok } (one brick of one library channel, transferred),
     * or add { token, channel, done: true, failed: [boxes] } → the channel is finished (its accumulator freed, the output pixels with a
     * sample in a failed box noted); finish { token } → { info, missing } (pixels with a sample in a failed box); abort { token }. */
    define('doc.oblique.begin', { async handler(a, E) {
      if (!a || typeof a !== 'object' || !a.G) throw bad(E, 'args');
      if (!Array.isArray(a.channels) || !a.channels.length || a.channels.length > 64) throw bad(E, 'channels');
      const calibration = calibrationOf(E, a.calibration);
      let need;
      try { need = IJOblique.estimateBytes(a.G, { channels: a.channels.length }); } catch (err) { throw bad(E, 'geometry'); }
      E.reserve(need);
      const channels = a.channels.map((c, i) => {
        if (!c || !isInt(c.index) || c.index < 0) throw bad(E, 'channel');
        return { index: c.index, name: cleanName(c.name, 'C' + (i + 1)), color: hexColor(c.color), acc: null, out: null };
      });
      const token = newToken('o', { G: a.G, N: a.G.width * a.G.height, channels, mask: null,
        a: { name: cleanName(a.name, 'oblique'), calibration, provenance: plain(a.provenance), sessionKey: keyOfArgs(a) } });
      return { token };
    } });
    const finishChannel = (rec, ch, failed) => {
      if (ch.out) return;
      if (!ch.acc) ch.acc = IJOblique.create(rec.G, { channel: ch.index, outBitDepth: 8 });
      if (failed && failed.length) {
        const m = ch.acc.missing(failed);
        if (!rec.mask) rec.mask = new Uint8Array(rec.N);
        for (let i = 0; i < rec.N; i++) if (m.mask[i]) rec.mask[i] = 1;
      }
      ch.out = ch.acc.finish();
      ch.acc = null;
    };
    define('doc.oblique.add', { long: true, async handler(a, E) {
      E.check();
      const rec = tokenOf(E, a && a.token, 'o');
      const ch = rec.channels.find((c) => c.index === a.channel);
      if (!ch) throw bad(E, 'channel');
      if (ch.out) throw bad(E, 'channel already finished');
      if (a.done === true) { finishChannel(rec, ch, Array.isArray(a.failed) ? a.failed : []); return { ok: true, done: true }; }
      if (!ch.acc) ch.acc = IJOblique.create(rec.G, { channel: ch.index, outBitDepth: 8 });
      try { ch.acc.add({ channel: ch.index, box: a.box, data: a.data }); } catch (err) { throw bad(E, 'brick ' + (err && err.code ? err.code : 'invalid')); }
      return { ok: true };
    } });
    define('doc.oblique.finish', { async handler(a, E) {
      const rec = tokenOf(E, a && a.token, 'o');
      for (const ch of rec.channels) finishChannel(rec, ch, []);
      live.delete(a.token);
      let missing = 0;
      if (rec.mask) for (let i = 0; i < rec.N; i++) missing += rec.mask[i];
      const m = rec.a;
      const info = E.createDoc({ name: m.name, width: rec.G.width, height: rec.G.height, bitDepth: 8, calibration: m.calibration,
        channels: rec.channels.map((c) => ({ data: c.out, name: c.name, color: c.color })) }, { provenance: m.provenance, sessionKey: m.sessionKey });
      return { info, missing };
    } });
    define('doc.oblique.abort', { async handler(a) { return { dropped: live.delete(a && a.token) }; } });
  })();

  root.IJTiffStream = IJTiffStream;
  root.IJOblique = IJOblique;
  root.IJLibSource = IJLibSource;
})(typeof self !== 'undefined' ? self : globalThis);
