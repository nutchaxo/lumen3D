/**
 * Q30Export — the Download Center's "Q30 bricks" download (DOCS/dataset-migrations/SPEC.md
 * §15.5): on a format-6 dataset, the display column `q30` of the chosen levels exactly as it
 * is stored — `bricks/index/q30.bin`, the packs `bricks/l{k}/q30/c{c}/pNNNNN.bin`, the tree's
 * `bricks/manifest.json` and `metadata.json` — in one STORED zip built in this browser (the
 * OME-Zarr export's ZIP writer, OmeZarr.ZipWriter), with a README naming the format. Nothing is
 * decoded or re-encoded. A timelapse downloads the timepoint on screen.
 */
const Q30Export = (() => {
  const BLOB_WARN_BYTES = 1.5 * 1024 ** 3;
  const INDEX_HEADER = 12, INDEX_LEVEL = 16, INDEX_ENTRY = 10;

  function _t(key, def, params) {
    let v = (typeof I18n !== 'undefined' && I18n.t) ? I18n.t(key, params) : key;
    if (v === key || v == null) v = def != null ? def : key;
    if (params && typeof v === 'string') v = v.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
    return v;
  }
  // The reader sees a translated category; the raw cause (HTTP status, URL, parser
  // message) goes to the console only.
  function _why(err, context) {
    let text = '';
    try { text = (typeof Utils !== 'undefined' && Utils.friendlyErrorText) ? Utils.friendlyErrorText(err, { context }) : ''; } catch (e) { text = ''; }
    return text || _t('app.errUnknown', 'Something went wrong. Try again; if it keeps happening, reload the page.');
  }
  const _esc = (s) => (typeof Utils !== 'undefined' && Utils.escapeHtml) ? Utils.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

  function _bytes(n) {
    if (!(n >= 0)) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
    return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}`;
  }

  /**
   * The tree to download: { manifest, base } of the volume on screen (DataAccess.displayedTree:
   * on a timelapse, BrickLoader's mounted tree is often a frame the prefetch loaded after it);
   * null before a mount, and null while the viewer shows no brick tree (a WebGL context
   * loss released it: the mounted tree is then a prefetched frame, not the one named on
   * screen). The mounted tree only on a page without DataAccess.
   */
  function _tree() {
    if (typeof BrickLoader === 'undefined' || !BrickLoader.isReady?.()) return null;
    if (typeof DataAccess !== 'undefined' && typeof DataAccess.displayedTree === 'function') {
      const shown = DataAccess.displayedTree();
      return shown && shown.path && shown.manifest ? { manifest: shown.manifest, base: String(shown.path).replace(/\/$/, '') } : null;
    }
    const m = BrickLoader.getManifest?.();
    return m ? { manifest: m, base: _base() } : null;
  }

  function _manifest() {
    return _tree()?.manifest || null;
  }

  function available() {
    const m = _manifest();
    return Boolean(m && m.schema === 'iribhm-bricks-v6' && m.index?.columns?.q30 && typeof OmeZarr !== 'undefined'
      && typeof BrickLoader.getBasePath === 'function');
  }

  /** {levels: [{gx, gy, gz, packs}], channels, entries: per level a DataView over (C × n) entries}. */
  function parseIndex(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < INDEX_HEADER || String.fromCharCode(...bytes.subarray(0, 4)) !== 'LBIX') throw new Error('index: bad magic');
    const version = dv.getUint16(4, true), nLevels = dv.getUint16(6, true), channels = dv.getUint16(8, true);
    if (version !== 1) throw new Error('index: unsupported version ' + version);
    let pos = INDEX_HEADER;
    const levels = [];
    for (let i = 0; i < nLevels; i++, pos += INDEX_LEVEL) {
      levels.push({ gx: dv.getUint32(pos, true), gy: dv.getUint32(pos + 4, true), gz: dv.getUint32(pos + 8, true), packs: dv.getUint32(pos + 12, true) });
    }
    const entries = [];
    for (const L of levels) {
      const n = channels * L.gx * L.gy * L.gz;
      entries.push({ offset: pos, count: n });
      pos += n * INDEX_ENTRY;
    }
    if (pos !== bytes.length) throw new Error('index: size');
    return { levels, channels, entries, dv };
  }

  /** [{ level, channel, pack, end }] of the packs one level holds (end = the bytes its bricks reach). */
  function packsOf(index, level) {
    const L = index.levels[level], e = index.entries[level], dv = index.dv;
    const n = L.gx * L.gy * L.gz;
    const ends = new Map();
    for (let c = 0; c < index.channels; c++) {
      for (let i = 0; i < n; i++) {
        const o = e.offset + (c * n + i) * INDEX_ENTRY;
        const len = dv.getUint32(o + 6, true);
        if (!len) continue;
        const pack = dv.getUint16(o, true), off = dv.getUint32(o + 2, true);
        const key = `${c}/${pack}`;
        ends.set(key, Math.max(ends.get(key) || 0, off + len));
      }
    }
    return [...ends].map(([key, end]) => { const [c, p] = key.split('/').map(Number); return { level, channel: c, pack: p, end }; })
      .sort((a, b) => a.channel - b.channel || a.pack - b.pack);
  }

  function _base() { return String(BrickLoader.getBasePath()).replace(/\/$/, ''); }
  function _datasetBase(base) { return base.replace(/\/bricks(\/t\d{3,})?$/, ''); }
  function _stamp(ref) { return String(ref.sha256 || '').slice(0, 12); }

  async function _fetch(url, signal) {
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.split('?')[0].split('/').slice(-3).join('/')}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  /** The q30 index of the tree `m` served at `base`: { key, parsed, bytes } (the last one kept). */
  let _index = null;
  async function _loadIndex(signal, base, m) {
    const ref = m.index.columns.q30;
    const key = `${base}|${ref.sha256}`;
    if (_index && _index.key === key) return _index;
    const bytes = await _fetch(`${base}/${String(ref.url).replace(/^\/+/, '')}?v=${_stamp(ref)}`, signal);
    const rec = { key, parsed: parseIndex(bytes), bytes };
    _index = rec;
    return rec;
  }

  /** Bytes per level of the q30 column (from the manifest, every channel). */
  function sizes() {
    const m = _manifest();
    const out = {};
    if (!m) return out;
    for (const L of m.levels || []) {
      const per = m.bytes?.[String(L.level)]?.q30;
      out[L.level] = Array.isArray(per) ? per.reduce((a, b) => a + (Number(b) || 0), 0) : 0;
    }
    return out;
  }

  const README = (name, levels) => [
    `${name} — the WebP Q30 display bricks of a Lumen3D format-6 dataset`,
    '',
    'Layout (DOCS/dataset-migrations/SPEC.md §14.4, §15 of the Lumen3D platform):',
    '  bricks/manifest.json            the tree manifest (levels, dimensions, voxel sizes in µm, columns)',
    '  bricks/index/q30.bin            LBIX index: per level and channel, every brick\'s pack, offset, length',
    `  bricks/l{k}/q30/c{c}/pNNNNN.bin  the packs of the levels included here: ${levels.join(', ')}`,
    '  metadata.json                   the dataset\'s metadata (channels, calibration)',
    '',
    'A brick is a 66³ block (64³ + a 1-voxel border) stored as one WebP image followed by ONE byte:',
    '  0..12  a lossy WebP of the 9 × 8 mosaic of its 66 slices on an 80-px pitch; decoded values',
    '         ≤ that byte are 0 (dead zone)',
    '  255    a lossless WebP of the 9 × 8 mosaic of its 66 slices on a 66-px pitch (exact voxels)',
    'Decode with format5.py (decode_brick(data, "q30")) from the Lumen3D repository or the',
    'preprocessing pack. The lossless column (`ll`) the manifest names is not part of this download:',
    'use the OME-Zarr export of the same page for the exact voxels.',
    ''
  ].join('\n');

  let _job = null;

  function _folderOf(dataset) {
    const id = String(dataset?.id || dataset?.path || 'dataset');
    return id.split('/').pop().replace(/[^A-Za-z0-9._-]+/g, '_') || 'dataset';
  }

  async function run({ levelIds, name, sink, signal, onProgress }) {
    // The tree on screen now is the one downloaded to the end: a timepoint shown or
    // prefetched meanwhile mounts another tree in BrickLoader, but this one's index,
    // manifest and packs stay served, and packs of another frame under this frame's index
    // would be a corrupt download.
    const tree = _tree();
    if (!tree) throw Object.assign(new Error('Q30Export: no tree mounted'), { code: 'BRICKS_NOT_INITIALIZED' });
    const m = tree.manifest;
    const base = tree.base;
    const { parsed: index, bytes: indexBytes } = await _loadIndex(signal, base, m);
    const ref = m.index.columns.q30;
    const zip = new OmeZarr.ZipWriter();
    const enc = new TextEncoder();
    let bytesOut = 0;
    const write = async (parts) => { for (const p of parts) { await sink.write(p); bytesOut += p.length; } };
    const packs = levelIds.slice().sort((a, b) => a - b).flatMap(k => packsOf(index, k));
    const total = packs.reduce((a, p) => a + p.end, 0) || 1;
    let done = 0;
    let metadata = null;
    try { metadata = await _fetch(`${_datasetBase(base)}/metadata.json`, signal); } catch (err) { if (err?.name === 'AbortError') throw err; }
    if (metadata) await write(zip.add('metadata.json', metadata));
    await write(zip.add('bricks/manifest.json', enc.encode(JSON.stringify(m))));
    await write(zip.add('bricks/index/q30.bin', indexBytes));
    for (const p of packs) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const rel = `l${p.level}/q30/c${p.channel}/p${String(p.pack).padStart(5, '0')}.bin`;
      const data = await _fetch(`${base}/${rel}?v=${_stamp(ref)}`, signal);
      await write(zip.add(`bricks/${rel}`, data));
      done += p.end;
      onProgress?.({ done, total, bytesOut, step: rel });
    }
    await write(zip.add('README.txt', enc.encode(README(name, levelIds.map(k => (k === 0 ? 'native' : `level ${k}`))))));
    await write(zip.finish());
    return { bytesOut, packs: packs.length };
  }

  function mount(el, { dataset }) {
    if (!el) return;
    // Not offered yet: keep looking while the section is on screen, until a tree IS shown
    // and is not a q30 one. Nothing on screen covers the loader not mounted yet, a timepoint's
    // coarse preview (the previous volume detached) and a WebGL context loss: each ends with
    // a tree on screen, and the section must appear then without reopening the Download Center.
    if (!available()) {
      if (el.isConnected && typeof BrickLoader !== 'undefined' && !_tree()) setTimeout(() => mount(el, { dataset }), 1000);
      return;
    }
    el.hidden = false;
    const m = _manifest();
    const size = sizes();
    const live = String(dataset?.type || '') === 'live';
    const lv = (m.levels || []).map(L => ({ level: L.level, target: L.target, dims: L.dimensions }));
    el.innerHTML = `
      <div class="dl-section-head"><h3>${_esc(_t('download.q30.title', 'Display bricks (WebP Q30)'))}</h3></div>
      <p class="dl-section-hint">${_esc(_t('download.q30.hint', 'The compressed bricks this site displays, as stored (WebP quality 30), for the chosen levels: much lighter than the lossless data, but read only by Lumen3D tools (format described in the README of the zip). For measurements, use the lossless OME-Zarr export above.'))}${live ? ' ' + _esc(_t('download.omezarr.liveHint', 'A timelapse exports the timepoint on screen.')) : ''}</p>
      <div class="dl-omezarr">
        <fieldset class="dl-omezarr-group"><legend>${_esc(_t('download.omezarr.levels', 'Levels'))}</legend>
          ${lv.map(L => `<label class="dl-omezarr-opt"><input type="checkbox" data-q30-level="${L.level}" ${L.level === 0 ? 'checked' : ''}>
            <span>${_esc(L.level === 0 ? _t('download.omezarr.native', 'Native') : String(L.target || L.level))} — ${L.dims.x} × ${L.dims.y} × ${L.dims.z}</span>
            <span class="dl-omezarr-size">${_esc(_bytes(size[L.level] || 0))}</span></label>`).join('')}
        </fieldset>
        <div class="dl-omezarr-foot">
          <span class="dl-omezarr-total" data-q30-total></span>
          <button class="btn btn-primary btn-sm" data-q30-start><i data-lucide="download"></i> ${_esc(_t('download.q30.start', 'Download .q30.zip'))}</button>
          <button class="btn btn-ghost btn-sm" data-q30-cancel hidden>${_esc(_t('download.omezarr.cancel', 'Cancel'))}</button>
        </div>
        <div class="dl-omezarr-progress" data-q30-progress hidden>
          <div class="dl-omezarr-bar"><div class="dl-omezarr-fill" data-q30-fill></div></div>
          <div class="dl-omezarr-label" data-q30-label></div>
        </div>
      </div>`;
    const q = (s) => el.querySelector(s);
    const picked = () => [...el.querySelectorAll('[data-q30-level]')].filter(i => i.checked).map(i => Number(i.dataset.q30Level));
    const refresh = () => {
      const chosen = picked().reduce((a, k) => a + (size[k] || 0), 0);
      q('[data-q30-total]').textContent = _t('download.q30.total', '{size} to download', { size: _bytes(chosen) });
      q('[data-q30-start]').disabled = Boolean(_job) || !picked().length;
      return chosen;
    };
    el.addEventListener('change', (e) => { if (e.target.closest('[data-q30-level]')) refresh(); });
    refresh();
    q('[data-q30-cancel]').addEventListener('click', () => _job?.ac.abort());
    q('[data-q30-start]').addEventListener('click', async () => {
      if (_job) return;
      const levelIds = picked();
      const reads = refresh();
      const name = _folderOf(dataset);
      let sink;
      try {
        if (typeof window.showSaveFilePicker !== 'function' && reads > BLOB_WARN_BYTES
            && !window.confirm(_t('download.omezarr.memoryWarn', 'This browser keeps the whole file in memory before saving it ({size} or more). Continue?', { size: _bytes(reads) }))) return;
        sink = await OmeZarrExport.openSink(`${name}.q30.zip`);
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        console.error('[Q30Export] The destination file could not be opened:', err);
        q('[data-q30-progress]').hidden = false;
        q('[data-q30-fill]').style.width = '0%';
        q('[data-q30-label]').textContent = _t('download.omezarr.failed', 'Export failed: {error}', { error: _why(err, 'save') });
        return;
      }
      const ac = new AbortController();
      _job = { ac };
      const label = q('[data-q30-label]'), fill = q('[data-q30-fill]');
      q('[data-q30-progress]').hidden = false;
      q('[data-q30-cancel]').hidden = false;
      q('[data-q30-start]').disabled = true;
      label.textContent = _t('download.omezarr.preparing', 'Preparing…');
      fill.style.width = '0%';
      try {
        const r = await run({
          levelIds, name, sink, signal: ac.signal,
          onProgress: (p) => {
            const pct = p.total ? (100 * p.done / p.total) : 100;
            fill.style.width = `${pct.toFixed(1)}%`;
            label.textContent = _t('download.q30.progress', '{pct} % · {out} written', { pct: pct.toFixed(0), out: _bytes(p.bytesOut) });
          }
        });
        await sink.close();
        fill.style.width = '100%';
        label.textContent = _t('download.q30.done', 'Done: {size}, {packs} pack(s).', { size: _bytes(r.bytesOut), packs: r.packs });
      } catch (err) {
        await sink.abort?.();
        if (!err || err.name !== 'AbortError') console.error('[Q30Export] Export failed:', err);
        label.textContent = err && err.name === 'AbortError'
          ? _t('download.omezarr.cancelled', 'Export cancelled.')
          : _t('download.omezarr.failed', 'Export failed: {error}', { error: _why(err) });
      } finally {
        _job = null;
        q('[data-q30-cancel]').hidden = true;
        refresh();
      }
    });
    if (window.lucide) lucide.createIcons({ nodes: [el] });
  }

  return { available, parseIndex, packsOf, sizes, run, mount };
})();
