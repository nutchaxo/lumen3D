/**
 * OmeZarrExport — the Download Center's OME-Zarr v0.5 export (DOCS/dataset-migrations/SPEC.md
 * §14.9): the mounted dataset's LOSSLESS levels (the `ll` column of a format-5 tree, the only
 * column of a v2 / v3 tree) written as one `<folder>.ome.zarr.zip` the browser saves to disk
 * (napari, Fiji, zarr-python, Neuroglancer read the store; unzip it or open the zip directly).
 *
 * The bricks come from BrickLoader's decode workers (the same reads as DataAccess.readRegion),
 * one shard (16 × 16 bricks of one brick layer, one channel, one level) per batch, two shards in
 * flight; js/workers/ome-zarr-worker.js encodes each shard; the zip is written as it goes —
 * through the File System Access API when the browser has it (no size limit), else as a Blob.
 * A timelapse exports its CURRENT timepoint (axes c, z, y, x).
 */
const OmeZarrExport = (() => {
  const IN_FLIGHT = 2;
  const BLOB_WARN_BYTES = 1.5 * 1024 ** 3;

  function _t(key, def, params) {
    let v = (typeof I18n !== 'undefined' && I18n.t) ? I18n.t(key, params) : key;
    if (v === key || v == null) v = def != null ? def : key;
    if (params && typeof v === 'string') v = v.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
    return v;
  }
  const _esc = (s) => (typeof Utils !== 'undefined' && Utils.escapeHtml) ? Utils.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

  function _bytes(n) {
    if (!(n >= 0)) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
    return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}`;
  }

  function available() {
    return typeof BrickLoader !== 'undefined' && BrickLoader.isReady?.() && typeof OmeZarr !== 'undefined'
      && typeof CompressionStream !== 'undefined' && Boolean(BrickLoader.getFormat()?.levels?.length);
  }

  // ── Plan ────────────────────────────────────────────────────────────────────

  // A v3 / v5 tree indexes every brick per channel; a v2 tree's mask (any channel) decides.
  let _packIndex = null;
  function _hasPackIndex() {
    if (_packIndex === null) {
      const f = BrickLoader.getFormat();
      _packIndex = Boolean(f && f.version >= 3);
    }
    return _packIndex;
  }

  /** Every level of the mounted tree: [{ level, dims, voxelSize, grid, target }]. */
  function levels() {
    const f = BrickLoader.getFormat();
    return (f?.levels || []).map(L => ({
      level: L.level, dims: { ...L.dims }, grid: { ...L.grid }, target: L.target ?? null,
      voxelSize: L.voxelSize ? { ...L.voxelSize } : (typeof DataAccess !== 'undefined' ? DataAccess.voxelSize(L.level) : { x: 1, y: 1, z: 1 })
    }));
  }

  /** The shard work of an export: [{ ...shard, tasks }], only shards holding a brick. */
  function plan(levelIds, channelIds) {
    const all = levels();
    const out = [];
    for (const k of levelIds) {
      const L = all.find(l => l.level === k);
      if (!L) continue;
      for (const c of channelIds) {
        for (const s of OmeZarr.shardsOf(k, c, L.grid)) {
          const tasks = [];
          for (const b of s.bricks) {
            if (!BrickLoader.hasBrick(b.bx, b.by, b.bz, k)) continue;
            const t = { bx: b.bx, by: b.by, bz: b.bz, lod: k, channel: c, column: 'll' };
            if (_hasPackIndex() ? BrickLoader.brickLocation(t) : true) tasks.push({ t, slot: b.slot, box: OmeZarr.brickBox(b.bx, b.by, b.bz, L.dims) });
          }
          if (tasks.length) out.push({ ...s, tasks, dims: L.dims });
        }
      }
    }
    return out;
  }

  /** Compressed lossless bytes the export reads (what the loader downloads), per level. */
  function estimate(levelIds, channelIds) {
    const perLevel = {};
    let total = 0;
    for (const s of plan(levelIds, channelIds)) {
      const b = BrickLoader.estimateTaskBytes(s.tasks.map(x => x.t));
      perLevel[s.level] = (perLevel[s.level] || 0) + b;
      total += b;
    }
    return { perLevel, total };
  }

  // ── Sink ────────────────────────────────────────────────────────────────────

  /** Must be called from the click (the save picker needs the user's gesture). */
  async function openSink(filename) {
    if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'OME-Zarr (zip)', accept: { 'application/zip': ['.zip'] } }]
      });
      const w = await handle.createWritable();
      return { kind: 'file', write: (p) => w.write(p), close: () => w.close(), abort: () => w.abort().catch(() => {}) };
    }
    const parts = [];
    return {
      kind: 'blob',
      write: (p) => { parts.push(p); },
      close: () => {
        const url = URL.createObjectURL(new Blob(parts, { type: 'application/zip' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        parts.length = 0;
      },
      abort: () => { parts.length = 0; }
    };
  }

  // ── Run ─────────────────────────────────────────────────────────────────────

  let _worker = null, _seq = 0;
  const _pending = new Map();
  function _encoder() {
    if (_worker) return _worker;
    const v = (document.querySelector('script[src*="ome-zarr-export.js"]')?.src.match(/\?v=[^&#]*/) || [''])[0];
    _worker = new Worker('js/workers/ome-zarr-worker.js' + v);
    _worker.onmessage = (e) => {
      const m = e.data || {};
      const p = _pending.get(m.id);
      if (!p) return;
      _pending.delete(m.id);
      if (m.ok) p.resolve(m); else p.reject(new Error(m.error || 'shard encode failed'));
    };
    _worker.onerror = (e) => {
      for (const p of _pending.values()) p.reject(new Error(e.message || 'OME-Zarr worker crashed'));
      _pending.clear();
      _worker = null;
    };
    return _worker;
  }

  function _encode(bricks) {
    const id = ++_seq;
    return new Promise((resolve, reject) => {
      _pending.set(id, { resolve, reject });
      _encoder().postMessage({ type: 'shard', id, bricks }, bricks.map(b => b.data));
    });
  }

  function _abortError() { return Object.assign(new Error('aborted'), { name: 'AbortError' }); }

  /** The decoded interiors of one shard's bricks (BrickLoader workers), ready to transfer. */
  async function _loadShard(shard, signal) {
    const bySlot = new Map(shard.tasks.map(x => [`${x.t.bx}_${x.t.by}_${x.t.bz}`, x]));
    const apron = Number(BrickLoader.getFormat()?.apron) || 0;
    const got = [];
    const tasks = shard.tasks.map(x => ({
      ...x.t,
      region: { x0: x.box.x0 + apron, x1: x.box.x1 + apron, y0: x.box.y0 + apron, y1: x.box.y1 + apron, z0: x.box.z0 + apron, z1: x.box.z1 + apron }
    }));
    const result = await BrickLoader.loadBrickTasks(tasks, {
      group: `omezarr-${shard.key}-${Math.random().toString(36).slice(2)}`,
      cancelPrevious: false, byteRanges: true, streamOnly: true, signal,
      onBrickLoaded: (row) => {
        const x = bySlot.get(`${row.bx}_${row.by}_${row.bz}`);
        const b = x && x.box;
        if (!x || !row.data || row.data.length !== (b.x1 - b.x0) * (b.y1 - b.y0) * (b.z1 - b.z0)) return;
        got.push({ slot: x.slot, box: b, data: row.data.slice().buffer });
      }
    });
    if (result?.summary?.cancelled || signal?.aborted) throw _abortError();
    const failed = result?.summary?.failed || [];
    if (failed.length) throw Object.assign(new Error(`${failed.length} brick(s) of ${shard.key} could not be read`), { code: 'READ_FAILED' });
    return got;
  }

  /**
   * Export levels × channels into `sink`. onProgress({ done, total, bytesIn, step }) after each
   * shard. Resolves { shards, chunks, bytesOut }.
   */
  async function run({ levelIds, channelIds, name, channels, sink, signal, onProgress }) {
    const all = levels().filter(L => levelIds.includes(L.level)).sort((a, b) => a.level - b.level);
    const chans = channelIds.slice().sort((a, b) => a - b);
    if (!all.length || !chans.length) throw new Error('nothing to export');
    const zip = new OmeZarr.ZipWriter();
    const root = `${name}.ome.zarr`;
    let bytesOut = 0;
    let chain = Promise.resolve();
    const write = (parts) => {
      chain = chain.then(async () => { for (const p of parts) { await sink.write(p); bytesOut += p.length; } });
      return chain;
    };
    const json = (o) => new TextEncoder().encode(JSON.stringify(o, null, 1));
    // An array's channel axis holds the exported channels, renumbered 0..n−1 in their order.
    write(zip.add(`${root}/zarr.json`, json(OmeZarr.groupMeta({
      name, levels: all, channels: chans.map(c => channels[c] || { label: `C${c}` })
    }))));
    for (const L of all) write(zip.add(`${root}/${L.level}/zarr.json`, json(OmeZarr.arrayMeta(chans.length, L.dims))));
    const work = plan(all.map(L => L.level), chans);
    const total = work.length;
    let done = 0, chunks = 0, bytesIn = 0;
    const step = (s) => _t('download.omezarr.step', 'Level {level} · channel {channel} · layer {z}', { level: s.level, channel: s.channel, z: s.sz });
    let next = 0;
    const one = async () => {
      while (next < work.length) {
        if (signal?.aborted) throw _abortError();
        const s = work[next++];
        bytesIn += BrickLoader.estimateTaskBytes(s.tasks.map(x => x.t));
        const bricks = await _loadShard(s, signal);
        const r = await _encode(bricks);
        if (r.bytes) {
          const key = `${s.level}/c/${chans.indexOf(s.channel)}/${s.sz}/${s.sy}/${s.sx}`;
          await write(zip.add(`${root}/${key}`, new Uint8Array(r.bytes), r.crc));
          chunks += r.chunks;
        }
        done++;
        onProgress?.({ done, total, bytesIn, bytesOut, step: step(s) });
      }
    };
    await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, Math.max(1, work.length)) }, one));
    await write(zip.finish());
    await chain;
    return { shards: total, chunks, bytesOut };
  }

  // ── Download Center panel ───────────────────────────────────────────────────

  let _job = null;

  function _channelsOf(dataset, count) {
    const meta = Array.isArray(dataset?.channels) ? dataset.channels : [];
    return Array.from({ length: count }, (_, c) => {
      const m = meta[c] || {};
      const lo = Number.isFinite(m.min) ? m.min : 0, hi = Number.isFinite(m.max) ? m.max : 1;
      return { label: m.name || `C${c}`, color: m.color || '#FFFFFF', window: { start: Math.round(lo * 255), end: Math.round(hi * 255) } };
    });
  }

  function _folderOf(dataset) {
    const id = String(dataset?.id || dataset?.path || 'dataset');
    return id.split('/').pop().replace(/[^A-Za-z0-9._-]+/g, '_') || 'dataset';
  }

  function mount(el, { dataset }) {
    if (!el) return;
    // Opened before the volume is mounted: wait for it while the section is on screen.
    if (!available()) {
      if (el.isConnected && typeof BrickLoader !== 'undefined') setTimeout(() => mount(el, { dataset }), 1000);
      return;
    }
    el.hidden = false;
    const fmt = BrickLoader.getFormat();
    const lv = levels();
    const chs = _channelsOf(dataset, fmt.channels);
    const live = String(dataset?.type || '') === 'live';
    el.innerHTML = `
      <div class="dl-section-head"><h3>${_esc(_t('download.omezarr.title', 'OME-Zarr export (napari, Fiji, Python)'))}</h3></div>
      <p class="dl-section-hint">${_esc(_t('download.omezarr.hint', 'The lossless voxels of the chosen levels as one OME-Zarr v0.5 store in a zip, calibrated in micrometres, with the channel names and colours. Built in this browser from the dataset\'s bricks.'))}${live ? ' ' + _esc(_t('download.omezarr.liveHint', 'A timelapse exports the timepoint on screen.')) : ''}</p>
      <div class="dl-omezarr">
        <fieldset class="dl-omezarr-group"><legend>${_esc(_t('download.omezarr.levels', 'Levels'))}</legend>
          ${lv.map(L => `<label class="dl-omezarr-opt"><input type="checkbox" data-oz-level="${L.level}" checked>
            <span>${_esc(L.level === 0 ? _t('download.omezarr.native', 'Native') : String(L.target || L.level))} — ${L.dims.x} × ${L.dims.y} × ${L.dims.z}</span>
            <span class="dl-omezarr-size" data-oz-size="${L.level}"></span></label>`).join('')}
        </fieldset>
        <fieldset class="dl-omezarr-group"><legend>${_esc(_t('download.omezarr.channels', 'Channels'))}</legend>
          ${chs.map((c, i) => `<label class="dl-omezarr-opt"><input type="checkbox" data-oz-channel="${i}" checked>
            <span class="dl-omezarr-swatch" style="background:${_esc(c.color)}"></span><span>${_esc(c.label)}</span></label>`).join('')}
        </fieldset>
        <div class="dl-omezarr-foot">
          <span class="dl-omezarr-total" data-oz-total></span>
          <button class="btn btn-primary btn-sm" data-oz-start><i data-lucide="download"></i> ${_esc(_t('download.omezarr.start', 'Export .ome.zarr.zip'))}</button>
          <button class="btn btn-ghost btn-sm" data-oz-cancel hidden>${_esc(_t('download.omezarr.cancel', 'Cancel'))}</button>
        </div>
        <div class="dl-omezarr-progress" data-oz-progress hidden>
          <div class="dl-omezarr-bar"><div class="dl-omezarr-fill" data-oz-fill></div></div>
          <div class="dl-omezarr-label" data-oz-label></div>
        </div>
      </div>`;
    const q = (s) => el.querySelector(s);
    const picked = (attr) => [...el.querySelectorAll(`[${attr}]`)].filter(i => i.checked).map(i => Number(i.getAttribute(attr)));
    const refresh = () => {
      const est = estimate(lv.map(L => L.level), picked('data-oz-channel'));
      for (const L of lv) {
        const s = q(`[data-oz-size="${L.level}"]`);
        if (s) s.textContent = _bytes(est.perLevel[L.level] || 0);
      }
      const chosen = picked('data-oz-level').reduce((a, k) => a + (est.perLevel[k] || 0), 0);
      q('[data-oz-total]').textContent = _t('download.omezarr.total', 'Reads {size} of lossless bricks', { size: _bytes(chosen) });
      q('[data-oz-start]').disabled = Boolean(_job) || !picked('data-oz-level').length || !picked('data-oz-channel').length;
      return chosen;
    };
    el.addEventListener('change', (e) => { if (e.target.closest('[data-oz-level],[data-oz-channel]')) refresh(); });
    refresh();
    q('[data-oz-cancel]').addEventListener('click', () => _job?.ac.abort());
    q('[data-oz-start]').addEventListener('click', async () => {
      if (_job) return;
      const levelIds = picked('data-oz-level'), channelIds = picked('data-oz-channel');
      const reads = refresh();
      const name = _folderOf(dataset);
      let sink;
      try {
        if (typeof window.showSaveFilePicker !== 'function' && reads > BLOB_WARN_BYTES
            && !window.confirm(_t('download.omezarr.memoryWarn', 'This browser keeps the whole file in memory before saving it ({size} or more). Continue?', { size: _bytes(reads) }))) return;
        sink = await openSink(`${name}.ome.zarr.zip`);
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        throw err;
      }
      const ac = new AbortController();
      _job = { ac };
      const label = q('[data-oz-label]'), fill = q('[data-oz-fill]');
      q('[data-oz-progress]').hidden = false;
      q('[data-oz-cancel]').hidden = false;
      q('[data-oz-start]').disabled = true;
      label.textContent = _t('download.omezarr.preparing', 'Preparing…');
      fill.style.width = '0%';
      const t0 = performance.now();
      try {
        const r = await run({
          levelIds, channelIds, name, channels: chs, sink, signal: ac.signal,
          onProgress: (p) => {
            const pct = p.total ? (100 * p.done / p.total) : 100;
            fill.style.width = `${pct.toFixed(1)}%`;
            const el2 = (performance.now() - t0) / 1000;
            const eta = p.done ? el2 * (p.total - p.done) / p.done : 0;
            label.textContent = _t('download.omezarr.progress', '{pct} % · {step} · {out} written · {eta} left',
              { pct: pct.toFixed(0), step: p.step, out: _bytes(p.bytesOut), eta: eta >= 60 ? `${Math.round(eta / 60)} min` : `${Math.round(eta)} s` });
          }
        });
        await sink.close();
        fill.style.width = '100%';
        label.textContent = _t('download.omezarr.done', 'Done: {size}, {chunks} chunks.', { size: _bytes(r.bytesOut), chunks: r.chunks });
      } catch (err) {
        await sink.abort?.();
        label.textContent = err && err.name === 'AbortError'
          ? _t('download.omezarr.cancelled', 'Export cancelled.')
          : _t('download.omezarr.failed', 'Export failed: {error}', { error: String(err && err.message || err) });
      } finally {
        _job = null;
        q('[data-oz-cancel]').hidden = true;
        refresh();
      }
    });
    if (window.lucide) lucide.createIcons({ nodes: [el] });
  }

  return { available, levels, plan, estimate, openSink, run, mount };
})();
