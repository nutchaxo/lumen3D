/* ij-cmds-edit.js — menu commands of package edit (wave 3): File > New > Image / Internal Clipboard / System Clipboard, Close All,
 * Import > LUT…, Save As > LUT…, Edit > Cut / Copy / Copy to System / Paste / Paste Control… / Draw, Edit > Options > Appearance… / Colors… /
 * Conversions… / Misc…, Image > Color > Invert LUTs / Show LUT, Image > Stacks > Make Montage…, Image > Lookup Tables > 3-3-2 RGB / Red/Green.
 * (Image > Duplicate… and Image > Rename… belong to the application and to ij-cmds-multi.js; the Duplicate dialog follows ij.plugin.Duplicator.)
 *
 * Page only, runs before IJApp.mount; talks to the app through the documented extension API (ij-app.js header) and to the worker through the
 * operations of ij-proc-edit.js (paste, copyRegion, draw, montage) and its worker commands (edit.newImage, edit.display).
 *
 * The clipboard is ImageJ's: the internal one (ImagePlus.clipboard) is held HERE, by the page, as the active channel's pixels of the
 * selection's bounding box plus its mask (≤ 64 MiB); Copy to System writes a PNG of the picture as displayed. Paste is a FLOATING paste
 * (ij.gui.Roi.startPaste): the selection is moved on the image with the clipboard shown through it (a reduced preview of the `paste` operation),
 * and the paste is committed — one undo step — when the selection is dropped, another command runs, another image takes over or Enter is
 * pressed; Escape cancels it. The clipboard travels to the worker ONCE (api.putBlob); moving the selection only changes x and y.
 *
 * Reference: ImageJ 1.54p (public domain) — ij.ImagePlus (copy, paste), ij.gui.Roi (startPaste, updatePaste, endPaste, abortPaste),
 * ij.plugin.Clipboard, ij.plugin.frame.PasteController, ij.plugin.filter.Filler, ij.gui.NewImage, ij.plugin.LutLoader, ij.plugin.filter.LutViewer,
 * ij.plugin.MontageMaker, ij.plugin.Colors, ij.plugin.Options (conversions, misc), ij.plugin.AppearanceOptions.
 */
(function () {
  'use strict';
  if (typeof IJApp === 'undefined' || typeof IJApp.extend !== 'function') return;

  const E = () => IJEdit;
  const ijError = (code, message) => Object.assign(new Error(message || code), { code });
  const MAX_CLIPBOARD_BYTES = 64 * 1048576;
  const idle = (st) => !!st.doc && !st.busy;
  const AREA = new Set(['rect', 'oval', 'polygon', 'freehand', 'mask']);
  const hasArea = (st) => idle(st) && !!st.roi && AREA.has(st.roi.type);
  const anyIdle = (st) => !st.busy;
  const bytesPer = (bd) => (bd === 8 ? 1 : bd === 16 ? 2 : 4);
  const seed31 = () => { try { return crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff; } catch (_) { return Date.now() & 0x7fffffff; } };
  const COLOR_NAMES = {
    red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], magenta: [255, 0, 255], cyan: [0, 255, 255], yellow: [255, 255, 0], orange: [255, 200, 0],
    black: [0, 0, 0], white: [255, 255, 255], gray: [128, 128, 128], lightgray: [192, 192, 192], darkgray: [64, 64, 64], pink: [255, 175, 175]
  };
  // ij.plugin.Colors.colors, in the dialog's order
  const COLOR_LIST = ['red', 'green', 'blue', 'magenta', 'cyan', 'yellow', 'orange', 'black', 'white', 'gray', 'lightgray', 'darkgray', 'pink'];
  const COLOR_KEYS = { red: 'dlg.edit.colorRed', green: 'dlg.edit.colorGreen', blue: 'dlg.edit.colorBlue', magenta: 'dlg.edit.colorMagenta', cyan: 'dlg.edit.colorCyan',
    yellow: 'dlg.edit.colorYellow', orange: 'dlg.edit.colorOrange', black: 'dlg.edit.colorBlack', white: 'dlg.edit.colorWhite', gray: 'dlg.edit.colorGray',
    lightgray: 'dlg.edit.colorLightgray', darkgray: 'dlg.edit.colorDarkgray', pink: 'dlg.edit.colorPink' };
  function rgbOf(v, fallback) {
    if (typeof v === 'string') {
      const k = v.trim().toLowerCase();
      if (COLOR_NAMES[k]) return COLOR_NAMES[k].slice();
      const m = /^#?([0-9a-f]{6})$/.exec(k);
      if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    }
    return fallback;
  }
  const hex = (rgb) => '#' + rgb.map((x) => (x < 16 ? '0' : '') + x.toString(16)).join('');
  const names = (st) => (st.docs || []).map((d) => d.name);

  // ═══════════════════════════════════ the internal clipboard ═══════════════════════════════════
  // { data (typed array, w*h), w, h, bitDepth, mask (Uint8Array w*h | null), shape (the selection at its original place, or null),
  //   x, y (where it was), name, calibration }
  let CLIP = null;

  function clipShape(roi, box, mask, w, h) {
    // a selection that sat wholly on the image keeps its shape; one that hung over its edge is the mask that was copied
    if (!roi || roi.type === 'rect') return null;
    try {
      const b = IJRoi.bounds(roi);
      if (roi.type !== 'mask' && b.x === box.x && b.y === box.y && b.w === w && b.h === h) return roi;
    } catch (_) { /* a mask below */ }
    return mask ? IJRoi.translate(IJRoi.fromMask(mask, w, h), box.x, box.y) : null;
  }

  async function copyToClipboard(api, cut) {
    const st = api.state();
    const doc = st.doc;
    if (!doc) return;
    const roi = st.roi && AREA.has(st.roi.type) ? st.roi : null;
    // ImagePlus.copy: "if (cut && roi==null && !IJ.isMacro()) { IJ.error("Edit>Cut", "This command requires an area selection"); return; }"
    if (cut && !roi) throw ijError('IJ_EDIT_NEEDS_AREA');
    const ch = st.activeChannel;
    // the size is known from the selection's bounds: a copy over the limit is refused before the worker builds it
    const cb = roi ? IJRoi.bounds(roi) : { x: 0, y: 0, w: doc.width, h: doc.height };
    const cw = Math.max(0, Math.min(doc.width, cb.x + cb.w) - Math.max(0, cb.x)), chh = Math.max(0, Math.min(doc.height, cb.y + cb.h) - Math.max(0, cb.y));
    if (cw * chh * bytesPer(doc.bitDepth) > MAX_CLIPBOARD_BYTES) throw ijError('IJ_EDIT_CLIPBOARD_TOO_LARGE');
    const res = await api.compute('copyRegion', {}, { docId: doc.docId, channel: ch, roi, labelKey: cut ? 'op.cut' : 'op.copyRegion' });
    if (!res) return;
    if (res.data.byteLength > MAX_CLIPBOARD_BYTES) throw ijError('IJ_EDIT_CLIPBOARD_TOO_LARGE');
    CLIP = {
      data: res.data, w: res.w, h: res.h, bitDepth: res.bitDepth, mask: res.mask || null, x: res.x, y: res.y,
      shape: clipShape(roi, { x: res.x, y: res.y }, res.mask, res.w, res.h), name: doc.name, calibration: doc.calibration || null
    };
    if (cut) {
      // "ip.snapshot(); ip.setColor(Toolbar.getBackgroundColor()); ip.fill(); if (roi!=null && roi.getType()!=Roi.RECTANGLE) { getMask(); ip.reset(ip.getMask()); }"
      await api.run('clear', { value: api.colorValue(doc.docId, ch, 'background') }, { docId: doc.docId, channel: ch, roi, labelKey: 'op.cut' });
    }
    // "IJ.showStatus(msg + ": " + (w*h*bytesPerPixel)/1024 + "k")"
    api.toast(cut ? 'dlg.edit.cutStatus' : 'dlg.edit.copyStatus', { size: Math.floor((CLIP.w * CLIP.h * bytesPer(CLIP.bitDepth)) / 1024) });
  }

  // ═══════════════════════════════════ the system clipboard ═══════════════════════════════════

  function copyToSystem(api) {
    const st = api.state();
    const doc = st.doc;
    if (!doc) return Promise.resolve();
    // Clipboard.getTransferData: "if (roi!=null && !roi.isLine()) { bounds = roi.getBounds(); if (!(bounds.x==0&&bounds.y==0&&bounds.width==
    // imp.getWidth()&&bounds.height==imp.getHeight())) imp = imp.crop(); }" — the bounding box, whatever the shape (Roi.isLine: line, polyline, freeline)
    let rect;
    if (st.roi && st.roi.type !== 'line' && st.roi.type !== 'polyline') {
      const b = IJRoi.bounds(st.roi);
      const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y), x1 = Math.min(doc.width, b.x + b.w), y1 = Math.min(doc.height, b.y + b.h);
      if (x1 > x0 && y1 > y0 && !(x0 === 0 && y0 === 0 && x1 === doc.width && y1 === doc.height)) rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    // The write must start inside the key / menu gesture: the PNG is a promise handed to the ClipboardItem, nothing is awaited before.
    if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.write !== 'function' || typeof ClipboardItem === 'undefined') return Promise.reject(ijError('IJ_EDIT_CLIPBOARD_UNSUPPORTED'));
    // A floating paste is part of what ImageJ copies (Roi.updatePaste writes it into the processor): it lands before the picture is rendered,
    // inside the promise so the clipboard write itself still starts in the gesture.
    const landing = FLOAT && !FLOAT.done && FLOAT.docId === doc.docId ? commitFloat(api, FLOAT) : Promise.resolve();
    const png = landing.then(() => api.renderPng(doc.docId, rect ? { rect } : undefined));
    let item;
    try { item = new ClipboardItem({ 'image/png': png }); } catch (_) { return Promise.reject(ijError('IJ_EDIT_CLIPBOARD_UNSUPPORTED')); }
    return navigator.clipboard.write([item]).then(() => { api.toast('dlg.edit.copiedSystem'); }, (err) => {
      if (err && err.code && String(err.code).indexOf('IJ_') === 0) throw err;
      throw ijError('IJ_EDIT_CLIPBOARD_DENIED');
    });
  }

  /** The picture on the system clipboard as 1 or 3 channels: a grey one is one channel, a colour one the three bytes R, G, B. */
  async function readSystemClipboard() {
    if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.read !== 'function') throw ijError('IJ_EDIT_CLIPBOARD_UNSUPPORTED');
    let items;
    try { items = await navigator.clipboard.read(); } catch (_) { throw ijError('IJ_EDIT_CLIPBOARD_DENIED'); }
    let blob = null;
    for (const it of items || []) {
      const type = (it.types || []).find((t) => /^image\//.test(t));
      if (type) { blob = await it.getType(type); break; }
    }
    if (!blob) throw ijError('IJ_EDIT_CLIPBOARD_NO_IMAGE');
    if (typeof createImageBitmap !== 'function') throw ijError('IJ_EDIT_CLIPBOARD_UNSUPPORTED');
    let bmp;
    try { bmp = await createImageBitmap(blob); } catch (_) { throw ijError('IJ_EDIT_CLIPBOARD_NO_IMAGE'); }
    try {
      const w = bmp.width, h = bmp.height;
      // the main thread decodes in bands of at most ~1 Mpx, yielding between them (never one full-size canvas), and refuses a picture
      // larger than a screenshot of any real display
      if (!(w > 0 && h > 0) || w * h > 33554432) throw ijError('IJ_TOO_LARGE');
      const n = w * h;
      const bandH = Math.max(1, Math.min(h, Math.floor(1048576 / w)));
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = bandH;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      const R = new Uint8Array(n), G = new Uint8Array(n), B = new Uint8Array(n);
      let gray = true;
      for (let y0 = 0; y0 < h; y0 += bandH) {
        const bh = Math.min(bandH, h - y0);
        cx.clearRect(0, 0, w, bandH);
        cx.drawImage(bmp, 0, y0, w, bh, 0, 0, w, bh);
        const px = cx.getImageData(0, 0, w, bh).data;
        const o = y0 * w;
        for (let i = 0, m = w * bh; i < m; i++) {
          const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
          R[o + i] = r; G[o + i] = g; B[o + i] = b;
          if (r !== g || g !== b) gray = false;
        }
        await new Promise((res) => setTimeout(res, 0));
      }
      return { width: w, height: h, planes: gray ? [R] : [R, G, B], gray };
    } finally { if (bmp.close) bmp.close(); }
  }

  async function showSystemClipboard(api) {
    const st = api.state();
    const img = await readSystemClipboard();
    const name = E().makeUniqueName('Clipboard', names(st));
    const colors = img.gray ? ['#ffffff'] : ['#ff0000', '#00ff00', '#0000ff'];
    const chNames = img.gray ? ['C1'] : ['R', 'G', 'B'];
    await api.addDoc({
      name, width: img.width, height: img.height, bitDepth: 8, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'px' },
      channels: img.planes.map((data, i) => ({ data, name: chNames[i], color: colors[i], display: { min: 0, max: 255, lut: IJLuts.forColor(colors[i]), invert: false } }))
    }, { placement: 'tab' });
  }

  /** Clipboard.showInternalClipboard: the clipboard as an image "Clipboard"; a non-rectangular selection is cleared outside ("Clear Outside"). */
  async function showInternalClipboard(api) {
    const st = api.state();
    if (!CLIP) throw ijError('IJ_EDIT_CLIPBOARD_EMPTY');
    const c = CLIP;
    const name = E().makeUniqueName('Clipboard', names(st));
    const cal = c.calibration ? Object.assign({}, c.calibration) : { pixelWidth: 1, pixelHeight: 1, unit: 'px' };
    const id = await api.addDoc({ name, width: c.w, height: c.h, bitDepth: c.bitDepth, calibration: cal, channels: [{ data: c.data.slice(), name: 'C1', color: '#ffffff' }] }, { placement: 'tab' });
    if (c.mask) {
      const roi = IJRoi.fromMask(c.mask, c.w, c.h);
      await api.run('clearOutside', { value: api.colorValue(id, 0, 'background') }, { docId: id, channel: 0, roi, labelKey: 'op.clipboard' });
    }
  }

  // ═══════════════════════════════════════ floating paste ═══════════════════════════════════════

  let FLOAT = null;
  let PANEL_MODE_HOOK = null;
  // Roi.pasteMode is a static of the running session, reset to COPY when the Paste Control window is built (PasteController: "Roi.setPasteMode
  // (Blitter.COPY)"): it is held here, not in the preferences, so a transfer mode nobody can see never lingers across a reload.
  let PASTE_MODE = 'copy';
  const pasteModeOf = () => PASTE_MODE;

  /** The parameters of the paste operation at the floating state's present place. */
  function pasteParams(api, f) {
    const p = { data: f.blob, w: f.w, h: f.h, x: f.x, y: f.y, mode: pasteModeOf() };
    if (f.maskBlob) p.mask = f.maskBlob;
    if (f.bitDepth === 32 && p.mode === 'divide') {
      const dz = api.settings.get('misc.divZero');
      if (typeof dz === 'string' && dz.trim().toLowerCase() !== 'infinity') p.divZero = dz;
    }
    return p;
  }
  /** The pasted selection at (x, y): the clipboard's own shape, or a rectangle. */
  function pasteRoi(f) {
    if (f.shape) return IJRoi.translate(f.shape, f.x - f.box.x, f.y - f.box.y);
    return { type: 'rect', x: f.x, y: f.y, w: f.w, h: f.h };
  }

  function stopFloat(api, f, why) {
    if (!f || f.done) return;
    f.done = true;
    if (FLOAT === f) FLOAT = null;
    clearTimeout(f.timer); clearTimeout(f.watch);
    try { f.off(); } catch (_) { /* gone */ }
    try { api.clearPending(); } catch (_) { /* gone */ }
    try { api.cancelPreview(); } catch (_) { /* gone */ }
    // a cancelled (or orphaned) paste gives its blobs up; a committed one keeps them, its step still uses them
    if (why !== 'commit') {
      for (const ref of [f.blob, f.maskBlob]) if (ref && typeof ref === 'object' && ref.blobRef) Promise.resolve(api.dropBlob(ref)).catch(() => {});
    }
  }

  function schedulePreview(api, f) {
    clearTimeout(f.timer);
    f.timer = setTimeout(async () => {
      if (f.done) return;
      try { f.lastView = viewKey(api, f.docId); await api.preview('paste', pasteParams(api, f), { docId: f.docId, channel: f.channel, roi: f.roi }); }
      catch (err) { if (!err || (err.code !== 'IJ_CANCELLED' && err.code !== 'IJ_SUPERSEDED' && err.code !== 'IJ_NO_DOC')) console.error('[advanced-studio] paste preview', err); }
    }, 40);
  }
  function viewKey(api, docId) {
    const v = api.view(docId);
    if (!v) return '';
    const r = v.visibleRect();
    return [r.x0, r.y0, r.x1, r.y1].map((x) => Math.round(x * 100)).join(',');
  }
  // The visible part of the image changed (zoom, pan): the preview only draws what was visible when it was asked for.
  function watchView(api, f) {
    f.watch = setTimeout(() => {
      if (f.done) return;
      if (viewKey(api, f.docId) !== f.lastView) schedulePreview(api, f);
      watchView(api, f);
    }, 300);
    if (f.watch && f.watch.unref) f.watch.unref();
  }

  async function commitFloat(api, f) {
    if (!f || f.done) return;
    stopFloat(api, f, 'commit');
    // Roi.endPaste: ip.copyBits(clipboard, x, y, pasteMode) at the selection's place, then reset(mask)
    try { await api.run('paste', pasteParams(api, f), { docId: f.docId, channel: f.channel, roi: f.roi, labelKey: 'op.paste' }); }
    catch (err) {
      // the step never took the blobs: they go back to the worker
      for (const ref of [f.blob, f.maskBlob]) if (ref && typeof ref === 'object' && ref.blobRef) Promise.resolve(api.dropBlob(ref)).catch(() => {});
      throw err;
    }
  }

  async function pasteCommand(api) {
    const st = api.state();
    if (!CLIP) { await showSystemClipboard(api); return; }                         // Clipboard.paste: "if (ImagePlus.getClipboard()==null) showSystemClipboard();"
    if (!st.doc) { await showInternalClipboard(api); return; }                     //                  "... else if (imp==null) showInternalClipboard();"
    const doc = st.doc, c = CLIP;
    if (c.bitDepth !== doc.bitDepth) throw ijError('IJ_EDIT_PASTE_TYPE');
    const w = c.w, h = c.h;
    // ImagePlus.paste: a selection of the clipboard's size takes it in place; else the clipboard is centred on the visible part of the image
    // (on the image when it is at least as large): "xCenter = w>=width ? width/2 : srcRect.x + srcRect.width/2; ... setRoi(xCenter-w/2, yCenter-h/2, w, h)"
    let x, y;
    const roi = st.roi && AREA.has(st.roi.type) ? st.roi : null;
    const rb = roi ? IJRoi.bounds(roi) : null;
    // ImagePlus.paste keeps the selection when it has the clipboard's size ("if (r.width==cr.width && r.height==cr.height) ... roi kept"), and
    // Roi.updatePaste masks the copy with THAT selection ("ip.copyBits(clipboard, x+xoffset, y+yoffset, pasteMode); if (type!=RECTANGLE) ip.reset(ip.getMask())")
    let shape = c.shape, mask = c.mask, box = { x: c.x, y: c.y };
    if (rb && rb.w === w && rb.h === h) {
      x = rb.x; y = rb.y;
      box = { x: rb.x, y: rb.y };
      if (roi.type === 'rect') { shape = null; mask = null; }
      else { shape = roi; mask = IJRoi.mask(IJRoi.translate(roi, -rb.x, -rb.y), w, h).data; }
    } else {
      const v = api.view(doc.docId);
      const r = v ? v.visibleRect() : { x0: 0, y0: 0, x1: doc.width, y1: doc.height };
      const sx = Math.floor(r.x0), sy = Math.floor(r.y0), sw = Math.max(1, Math.ceil(r.x1) - sx), sh = Math.max(1, Math.ceil(r.y1) - sy);
      const xc = w >= doc.width ? Math.trunc(doc.width / 2) : sx + Math.trunc(sw / 2);
      const yc = h >= doc.height ? Math.trunc(doc.height / 2) : sy + Math.trunc(sh / 2);
      x = xc - Math.trunc(w / 2); y = yc - Math.trunc(h / 2);
    }
    const f = {
      docId: doc.docId, channel: st.activeChannel, bitDepth: doc.bitDepth, w, h, x, y, shape, box, roi: null,
      blob: await api.putBlob(c.data), maskBlob: mask ? (mask.length >= 4096 ? await api.putBlob(mask) : mask) : null,
      timer: 0, watch: 0, done: false, starting: true, off: () => {}, lastView: '', api
    };
    f.roi = pasteRoi(f);
    if (FLOAT) {
      // a paste still floating: it lands first (a leftover of an image that was closed meanwhile is dropped)
      const old = FLOAT;
      if (st.docs.some((d) => d.docId === old.docId)) await commitFloat(api, old).catch((err) => api.error(err)); else stopFloat(api, old, 'gone');
    }
    FLOAT = f;
    api.setRoi(f.roi, { docId: f.docId });
    f.starting = false;
    const offRoi = api.on('roi', (ev) => {
      if (f.done || f.starting || !ev || ev.docId !== f.docId) return;
      const r = ev.roi;
      const b = r && AREA.has(r.type) ? IJRoi.bounds(r) : null;
      if (b && b.w === f.w && b.h === f.h) { f.x = b.x; f.y = b.y; f.roi = r; schedulePreview(api, f); return; }
      // the selection was dropped or replaced by another one: the paste lands where it was (Roi.endPaste)
      commitFloat(api, f).catch((err) => api.error(err));
    });
    const offDoc = api.on('doc', (ev) => { if (ev && ev.kind === 'closed' && ev.docId === f.docId) stopFloat(api, f, 'gone'); });
    f.off = () => { offRoi(); offDoc(); };
    api.setPending({
      labelKey: 'dlg.edit.pasting',
      commit: () => commitFloat(api, f),
      cancel: () => { stopFloat(api, f, 'cancel'); }            // Roi.abortPaste: the image as it was, the selection stays
    });
    schedulePreview(api, f);
    watchView(api, f);
  }

  // ═══════════════════════════════════════ Paste Control ═══════════════════════════════════════
  function buildPasteControl(el, papi) {
    const sel = document.createElement('select');
    sel.className = 'ij-search';
    for (const m of E().PASTE_MODES) {
      const o = document.createElement('option');
      o.value = m; o.textContent = papi.tr('dlg.edit.mode.' + m);
      sel.appendChild(o);
    }
    const label = document.createElement('label');
    label.textContent = papi.tr('dlg.edit.transferMode');
    const grid = document.createElement('div');
    grid.className = 'ij-form-grid';
    grid.appendChild(label); grid.appendChild(sel);
    const wrap = document.createElement('div');
    wrap.className = 'ij-panel-ext';
    wrap.appendChild(grid);
    el.appendChild(wrap);
    PASTE_MODE = 'copy';
    const show = () => { sel.value = PASTE_MODE; };
    show();
    // PasteController.itemStateChanged: Roi.setPasteMode(mode)
    sel.addEventListener('change', () => { if (E().PASTE_MODES.indexOf(sel.value) >= 0) PASTE_MODE = sel.value; if (PANEL_MODE_HOOK) PANEL_MODE_HOOK(); });
    return { refresh: show, dispose() { sel.remove(); } };
  }
  // a change of mode while a paste floats: the preview is drawn again
  PANEL_MODE_HOOK = () => { const f = FLOAT; if (f && !f.done && f.api) schedulePreview(f.api, f); };

  // ═══════════════════════════════════════ Draw ═══════════════════════════════════════
  /** Edit > Draw: the selection's outline in the foreground colour (Filler.draw: roi.drawPixels(ip)). */
  async function drawCommand(api) {
    const st = api.state();
    if (!st.doc || !st.roi) return;
    const roi = st.roi, ch = st.activeChannel;
    // The stroke width of the selection (Line / segmented line: its width), and the processor's own width (Line.getWidth(): the tool's line width).
    const stroke = (roi.type === 'line' || roi.type === 'polyline') ? Math.max(1, Math.round(roi.width || 1)) : 1;
    const value = api.colorValue(st.doc.docId, ch, 'foreground');
    await api.run('draw', { value, lineWidth: stroke, staticWidth: Math.max(1, Math.round(st.lineWidth || 1)), shape: roi },
      { docId: st.doc.docId, channel: ch, roi, labelKey: 'op.draw' });
  }

  // ═══════════════════════════════════════ File > New > Image ═══════════════════════════════════════
  let NEW_IMAGE_NAME = 'Untitled';
  async function newImageCommand(api) {
    const st = api.state();
    // NewImage keeps the name in a static of the session ("private static String name = \"Untitled\""), not in the preferences
    const mem = Object.assign({ type: 8, fill: 'black', width: 512, height: 512 }, api.settings.get('edit.newImage') || {}, { name: NEW_IMAGE_NAME });
    const v = await api.dialog({
      title: api.tr('dlg.edit.newTitle'), okLabel: api.tr('dlg.ok'),
      fields: [
        { type: 'string', id: 'name', labelKey: 'dlg.edit.newName', value: String(mem.name) },
        { type: 'choice', id: 'type', labelKey: 'dlg.edit.newType', value: [8, 16, 32].indexOf(mem.type) >= 0 ? mem.type : 8, options: [{ value: 8, label: '8-bit' }, { value: 16, label: '16-bit' }, { value: 32, label: '32-bit' }] },
        { type: 'choice', id: 'fill', labelKey: 'dlg.edit.newFill', value: E().NEW_FILLS.indexOf(mem.fill) >= 0 ? mem.fill : 'black', options: E().NEW_FILLS.map((f) => ({ value: f, labelKey: 'dlg.edit.fill.' + f })) },
        { type: 'number', id: 'width', labelKey: 'dlg.edit.newWidth', value: mem.width, min: 1, max: 100000, integer: true, decimals: 0, unitsKey: 'dlg.edit.pixels' },
        { type: 'number', id: 'height', labelKey: 'dlg.edit.newHeight', value: mem.height, min: 1, max: 100000, integer: true, decimals: 0, unitsKey: 'dlg.edit.pixels' }
      ],
      validate: (x) => (x.width * x.height > 268435456 ? { width: 'dlg.edit.newTooLarge' } : null)
    });
    if (!v) return;
    NEW_IMAGE_NAME = String(v.name);
    api.settings.set('edit.newImage', { type: v.type, fill: v.fill, width: v.width, height: v.height });
    // WindowManager.checkForDuplicateName: a title already in use gets "-1", "-2", ...
    const title = E().makeUniqueName(String(v.name).trim() || 'Untitled', names(st));
    // Noise is the one fill that draws random numbers: the seed is drawn here once and journaled in the image's provenance
    const res = await api.call('edit.newImage', { name: title, bitDepth: v.type, fill: v.fill, width: v.width, height: v.height, seed: seed31() }, { labelKey: 'op.newImage' });
    if (!res) return;
    await api.adopt(res.info, { placement: 'tab' });
  }

  async function closeAllCommand(api) {
    // WindowManager closes every image; an image with unsaved changes asks first, and a refusal stops the rest (closeDoc → false)
    for (const d of api.state().docs.slice()) {
      const closed = await api.closeDoc(d.docId);
      if (!closed) break;
    }
  }

  // ═══════════════════════════════════════ look-up tables ═══════════════════════════════════════
  const RESERVED_LUTS = () => IJLuts.names().concat([E().LUT_RGB332, E().LUT_REDGREEN]);
  async function displayOf(api, docId) { const r = await api.call('edit.display', { docId }, { labelKey: 'op.lut' }); if (!r) throw ijError('IJ_EDIT_NO_DISPLAY'); return r; }

  /** LutLoader.createImage(cm): with no image open a LUT command makes a 256 x 32 ramp image whose colour model is the table. */
  async function lutRampImage(api, title, lutName) {
    const ramp = new Uint8Array(256 * 32);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 256; x++) ramp[y * 256 + x] = x;
    await api.addDoc({
      name: E().makeUniqueName(title, names(api.state())), width: 256, height: 32, bitDepth: 8, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'px' },
      channels: [{ data: ramp, name: 'C1', color: '#ffffff', display: { min: 0, max: 255, lut: lutName, invert: false } }]
    }, { placement: 'tab' });
  }

  /** LutLoader.showLut on an image: the active channel takes a fresh table (an inverted one is replaced, not inverted again); a composite
   *  shown in Grayscale mode gives every channel the table and goes to Color mode, where the tables show. */
  async function applyLutToDoc(api, st, name) {
    const docId = st.doc.docId;
    if (st.doc.channels && st.doc.channels.length > 1) {
      const d = await displayOf(api, docId);
      if (d.mode === 'gray') {
        for (let c = 0; c < d.channels.length; c++) await api.setDisplay(docId, c, { lut: name, invert: false });
        await api.setDisplayMode(docId, 'color');
        return;
      }
    }
    await api.setDisplay(docId, st.activeChannel, { lut: name, invert: false });
  }

  async function setNamedLut(api, name) {
    const st = api.state();
    if (!st.doc) { await lutRampImage(api, name === E().LUT_REDGREEN ? 'redgreen' : name, name); return; }
    await applyLutToDoc(api, st, name);
  }

  async function importLut(api) {
    const st = api.state();
    const files = await api.pickFile({ accept: '.lut,.txt,.csv', multiple: false });
    if (!files || !files.length) return;
    const f = files[0];
    const parsed = IJLutFile.parse(new Uint8Array(await f.arrayBuffer()));
    let name = String(f.name || 'LUT').replace(/\.[^.]*$/, '').trim().slice(0, 56) || 'LUT';
    if (name.charAt(0) === '#' || RESERVED_LUTS().indexOf(name) >= 0) name += ' (LUT)';
    await api.registerLut(name, parsed.table);
    // LutLoader.showLut: "if (imp!=null) {...} else createImage(fi, showImage)" — the ramp image is titled with the file's name
    if (!api.state().doc) { await lutRampImage(api, String(f.name || name), name); return; }
    await applyLutToDoc(api, st, name);
  }

  async function saveLut(api) {
    const st = api.state();
    if (!st.doc) return;
    const d = await displayOf(api, st.doc.docId);
    const c = d.channels[st.activeChannel];
    // FileSaver.saveAsLut: the table of the image's colour model, 768 bytes (reds, greens, blues)
    const bytes = IJLutFile.write(E().effectiveTable(c.lut, c.invert, c.color));
    const base = String(st.doc.name || 'LUT').replace(/\.[A-Za-z0-9]+$/, '') || 'LUT';
    await api.saveFile(base + '.lut', 'application/octet-stream', '.lut', 'dlg.edit.lutFiles', async () => new Blob([bytes], { type: 'application/octet-stream' }));
  }

  function fnv(table) { let h = 0x811c9dc5; for (let i = 0; i < table.length; i++) { h ^= table[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); }

  /** Image > Color > Invert LUTs (the macro InvertAllLuts): every channel's table replaced by its inverse that keeps the colour. */
  async function invertLuts(api) {
    const st = api.state();
    if (!st.doc) return;
    const d = await displayOf(api, st.doc.docId);
    // The macro ends with "Property.set(\"CompositeProjection\", \"Invert\")" for a composite shown as a Sum: every inverted table maps 0 to
    // white, so the additive composite would be white everywhere. This renderer has no Invert / Min projection: the command is refused there.
    if (d.channels.length > 1 && d.mode === 'composite') throw ijError('IJ_EDIT_INVERT_COMPOSITE');
    for (let c = 0; c < d.channels.length; c++) {
      const ch = d.channels[c];
      const inv = E().invertLutTable(E().effectiveTable(ch.lut, ch.invert, ch.color));
      const id = IJLuts.identify(inv);
      if (typeof id.lut === 'string') await api.setDisplay(st.doc.docId, c, { lut: id.lut, invert: id.invert });
      else {
        const name = 'Inverted LUT ' + fnv(inv);
        await api.registerLut(name, inv);
        await api.setDisplay(st.doc.docId, c, { lut: name, invert: false });
      }
    }
  }

  /** Image > Color > Show LUT (ij.plugin.filter.LutViewer): the red, green and blue entries of the active channel's table (grey: one line). */
  async function showLut(api) {
    const st = api.state();
    if (!st.doc) return;
    const d = await displayOf(api, st.doc.docId);
    const c = d.channels[st.activeChannel];
    const t = E().effectiveTable(c.lut, c.invert, c.color);
    const x = [], r = [], g = [], b = [], rows = [];
    let gray = true;
    for (let i = 0; i < 256; i++) {
      x.push(i); r.push(t[i * 3]); g.push(t[i * 3 + 1]); b.push(t[i * 3 + 2]);
      if (t[i * 3] !== t[i * 3 + 1] || t[i * 3 + 1] !== t[i * 3 + 2]) gray = false;
      rows.push([i, t[i * 3], t[i * 3 + 1], t[i * 3 + 2]]);
    }
    // "if (isGray) g.setColor(Color.black); else g.setColor(Color.red);" then green and blue for a colour table
    const series = gray ? [{ kind: 'line', x, y: r, color: '#757575', label: 'Gray' }]
      : [{ kind: 'line', x, y: r, color: '#e53935', label: 'Red' }, { kind: 'line', x, y: g, color: '#43a047', label: 'Green' }, { kind: 'line', x, y: b, color: '#1e88e5', label: 'Blue' }];
    api.openPlot({
      title: api.tr('dlg.edit.lutPlotTitle'), xLabel: 'Index', yLabel: 'Value', series, xRange: [0, 255], yRange: [0, 255],
      csv: { columns: ['Index', 'Red', 'Green', 'Blue'], rows }
    });
  }

  // ═══════════════════════════════════════ Options ═══════════════════════════════════════
  async function appearanceOptions(api) {
    const v = await api.dialog({ title: api.tr('dlg.edit.appearanceTitle'), okLabel: api.tr('dlg.ok'),
      fields: [{ type: 'check', id: 'interpolate', labelKey: 'dlg.edit.interpolate', value: !!api.settings.get('appearance.interpolate') }] });
    if (!v) return;
    api.settings.set('appearance.interpolate', !!v.interpolate);
  }

  async function colorsOptions(api) {
    const pick = (key, fallback) => {
      const v = String(api.settings.get(key) || '').trim().toLowerCase();
      return COLOR_LIST.indexOf(v) >= 0 || /^#[0-9a-f]{6}$/.test(v) ? v : fallback;
    };
    // a colour no name gives (a macro's setForegroundColor) is offered as itself, as ImageJ's Colors dialog adds the custom colour to its list
    const optionsFor = (cur) => COLOR_LIST.map((n) => ({ value: n, labelKey: COLOR_KEYS[n] })).concat(COLOR_LIST.indexOf(cur) < 0 ? [{ value: cur, label: cur }] : []);
    const fg = pick('colors.foreground', 'white'), bg = pick('colors.background', 'black'), sel = pick('colors.selection', 'yellow');
    const v = await api.dialog({
      title: api.tr('dlg.edit.colorsTitle'), okLabel: api.tr('dlg.ok'),
      fields: [
        { type: 'choice', id: 'foreground', labelKey: 'dlg.edit.foreground', value: fg, options: optionsFor(fg) },
        { type: 'choice', id: 'background', labelKey: 'dlg.edit.background', value: bg, options: optionsFor(bg) },
        { type: 'choice', id: 'selection', labelKey: 'dlg.edit.selection', value: sel, options: optionsFor(sel) }
      ]
    });
    if (!v) return;
    for (const k of ['foreground', 'background', 'selection']) if (api.settings.get('colors.' + k) !== v[k]) api.settings.set('colors.' + k, v[k]);
  }

  async function conversionsOptions(api) {
    const v = await api.dialog({
      title: api.tr('dlg.edit.conversionsTitle'), okLabel: api.tr('dlg.ok'),
      fields: [
        { type: 'check', id: 'scale', labelKey: 'dlg.edit.scaleWhenConverting', value: api.settings.get('conv.scale') !== false },
        { type: 'check', id: 'weighted', labelKey: 'dlg.edit.weightedRgb', value: api.settings.get('conv.weighted') === true },
        { type: 'check', id: 'fullRange16', labelKey: 'dlg.edit.fullRange16', value: !!api.settings.get('conv.fullRange16') }
      ]
    });
    if (!v) return;
    // Options.conversions: "ImageConverter.setDoScaling(gd.getNextBoolean()); ... ColorProcessor.setWeightingFactors(0.299, 0.587, 0.114) when
    // 'Weighted RGB conversions' is ticked; Prefs.fullRange16bitInversions = gd.getNextBoolean();"
    api.settings.set('conv.scale', !!v.scale);
    api.settings.set('conv.weighted', !!v.weighted);
    api.settings.set('conv.fullRange16', !!v.fullRange16);
  }

  async function miscOptions(api) {
    const stored = api.settings.get('misc.divZero');
    const M = IJMulti;
    const cur = M.parseDivZero(String(stored));
    const v = await api.dialog({
      title: api.tr('dlg.edit.miscTitle'), okLabel: api.tr('dlg.ok'),
      fields: [{ type: 'string', id: 'divZero', labelKey: 'dlg.edit.divZero', value: E().javaFloatToString(cur === null ? Infinity : cur) }]
    });
    if (!v) return;
    // Options.miscOptions: an unreadable text leaves the value as it was ("if (f!=null) FloatBlitter.divideByZeroValue = f.floatValue()")
    const f = M.parseDivZero(String(v.divZero));
    if (f !== null) api.settings.set('misc.divZero', E().javaFloatToString(f));
  }

  // ═══════════════════════════════════════ Make Montage ═══════════════════════════════════════
  // MontageMaker keeps its last values in static fields and starts again from the defaults when the stack changes.
  let MONTAGE_MEM = null;
  async function montageCommand(api) {
    const st = api.state();
    const doc = st.doc;
    if (!doc) return;
    // a real stack (z / t slices) goes to MontageMaker's stack path (package stk); a single plane of several channels keeps the channel montage below
    if ((doc.nSlices || 1) > 1 && typeof IJStkCmds !== 'undefined' && IJStkCmds && typeof IJStkCmds.montage === 'function') return IJStkCmds.montage(api);
    const n = (doc.channels || []).length;
    if (n < 2) throw ijError('IJ_EDIT_STACK_REQUIRED');
    let d = E().montageDefaults(n, doc.width);
    // MontageMaker.showDialog: a change of stack resets columns, rows, scale, increment, first and last only; borderWidth, fontSize, label and
    // useForegroundColor are statics that survive any stack change
    if (MONTAGE_MEM) {
      const v0 = MONTAGE_MEM.values;
      if (MONTAGE_MEM.docId === doc.docId || MONTAGE_MEM.n === n) d = Object.assign(d, v0);
      else d = Object.assign(d, { border: v0.border, fontSize: v0.fontSize, label: v0.label, useForeground: v0.useForeground });
    }
    const v = await api.dialog({
      title: api.tr('dlg.edit.montageTitle'), okLabel: api.tr('dlg.ok'),
      fields: [
        { type: 'number', id: 'columns', labelKey: 'dlg.edit.columns', value: d.columns, min: 1, integer: true, decimals: 0 },
        { type: 'number', id: 'rows', labelKey: 'dlg.edit.rows', value: d.rows, min: 1, integer: true, decimals: 0 },
        { type: 'number', id: 'scale', labelKey: 'dlg.edit.scaleFactor', value: d.scale, min: 0.01, decimals: 2, step: 'any' },
        { type: 'number', id: 'first', labelKey: 'dlg.edit.firstSlice', value: d.first, integer: true, decimals: 0 },
        { type: 'number', id: 'last', labelKey: 'dlg.edit.lastSlice', value: d.last, integer: true, decimals: 0 },
        { type: 'number', id: 'increment', labelKey: 'dlg.edit.increment', value: d.increment, integer: true, decimals: 0 },
        { type: 'number', id: 'border', labelKey: 'dlg.edit.borderWidth', value: d.border, integer: true, decimals: 0 },
        { type: 'number', id: 'fontSize', labelKey: 'dlg.edit.fontSize', value: d.fontSize, min: 1, integer: true, decimals: 0 },
        { type: 'check', id: 'label', labelKey: 'dlg.edit.labelSlices', value: !!d.label },
        { type: 'check', id: 'useForeground', labelKey: 'dlg.edit.useForeground', value: !!d.useForeground }
      ],
      validate: (x) => {
        const s = Math.trunc(doc.width * x.scale), t = Math.trunc(doc.height * x.scale);
        return s < 1 || t < 1 ? { scale: 'dlg.edit.montageScale' } : null;
      }
    });
    if (!v) return;
    MONTAGE_MEM = { docId: doc.docId, n, values: { columns: v.columns, rows: v.rows, scale: v.scale, first: v.first, last: v.last, increment: v.increment, border: v.border, fontSize: v.fontSize, label: !!v.label, useForeground: !!v.useForeground } };
    const c = E().montageClamp({ columns: v.columns, rows: v.rows, scale: v.scale, first: v.first, last: v.last, increment: v.increment, border: v.border }, n);
    const params = { columns: c.columns, rows: c.rows, scale: c.scale, first: c.first, last: c.last, increment: c.increment, border: c.border, label: !!v.label, useForeground: !!v.useForeground };
    if (v.useForeground) { params.fg = rgbOf(api.settings.get('colors.foreground'), [255, 255, 255]); params.bg = rgbOf(api.settings.get('colors.background'), [0, 0, 0]); }
    const res = await api.run('montage', params, { docId: doc.docId, noRoi: true, labelKey: 'op.montage', placement: 'tab' });
    if (!res || !res.newDocIds || !res.newDocIds.length || !v.label) return;
    // MontageMaker.drawLabel: the slice number (the stack has no labels) centred under each tile; here an overlay text, not burnt into the pixels
    const info = api.state().docs.find((x) => x.docId === res.newDocIds[0]);
    const m = info && info.provenance && info.provenance.montage;
    if (!m) return;
    const color = hex(m.fg || [255, 255, 255]);
    const items = [];
    let x = 0, y = 0, slice = m.first;
    const mw = info.width, mh = info.height;
    while (slice <= m.last) {
      items.push({ kind: 'text', x: x + Math.trunc(m.width / 2), y: y + m.height - Math.trunc(m.border / 2) - v.fontSize - 1, text: String(slice), size: v.fontSize, color, background: null, bold: false, serif: false, align: 'center', tag: 'edit.montage' });
      x += m.width + m.border;
      if (x >= mw) { x = 0; y += m.height + m.border; if (y >= mh) break; }
      slice += m.increment;
    }
    api.annotations.add(res.newDocIds[0], items);
  }

  const mk = (id, menu, order, extra) => Object.assign({ id, menu, order, enabled: idle }, extra || {});
  const commands = [
    mk('fileNewImage', ['File', 'New'], 10, { shortcut: 'n', keys: ['n'], enabled: anyIdle, run: newImageCommand }),
    mk('fileNewInternalClipboard', ['File', 'New'], 20, { enabled: anyIdle, run: showInternalClipboard }),
    mk('fileNewSystemClipboard', ['File', 'New'], 30, { shortcut: 'Shift+V', keys: ['Shift+V'], enabled: anyIdle, run: showSystemClipboard }),
    mk('fileCloseAll', ['File'], 22, { enabled: (st) => !st.busy && st.nDocs > 0, run: closeAllCommand }),
    mk('fileImportLut', ['File', 'Import'], 10, { enabled: anyIdle, run: importLut }),
    mk('fileSaveLut', ['File', 'SaveAs'], 22, { run: saveLut }),

    mk('editCut', ['Edit'], 22, { shortcut: 'Ctrl+X', keys: ['Ctrl+X'], separatorBefore: true, enabled: hasArea, run: (api) => copyToClipboard(api, true) }),
    mk('editCopy', ['Edit'], 24, { shortcut: 'Ctrl+C', keys: ['Ctrl+C'], run: (api) => copyToClipboard(api, false) }),
    mk('editCopyToSystem', ['Edit'], 26, { gesture: true, run: copyToSystem }),
    mk('editPaste', ['Edit'], 27, { shortcut: 'Ctrl+V', keys: ['Ctrl+V'], enabled: anyIdle, run: pasteCommand }),
    mk('editPasteControl', ['Edit'], 28, { enabled: () => true, run: (api) => api.openPanel('pasteControl') }),
    mk('editDraw', ['Edit'], 55, { shortcut: 'd', keys: ['d'], enabled: (st) => idle(st) && !!st.roi, run: drawCommand }),

    mk('optAppearance', ['Edit', 'Options'], 10, { enabled: () => true, run: appearanceOptions }),
    mk('optColors', ['Edit', 'Options'], 30, { enabled: () => true, run: colorsOptions }),
    mk('optConversions', ['Edit', 'Options'], 50, { enabled: () => true, run: conversionsOptions }),
    mk('optMisc', ['Edit', 'Options'], 110, { enabled: () => true, run: miscOptions }),

    mk('colorInvertLuts', ['Image', 'Color'], 35, { run: invertLuts }),
    mk('colorShowLut', ['Image', 'Color'], 60, { separatorBefore: true, run: showLut }),
    mk('stackMontage', ['Image', 'Stacks'], 80, { long: true, enabled: (st) => idle(st) && ((st.doc.channels || []).length > 1 || (st.doc.nSlices || 1) > 1), run: montageCommand }),
    mk('lut332RGB', ['Image', 'LookupTables'], 70, { enabled: anyIdle, run: (api) => setNamedLut(api, '3-3-2 RGB') }),
    mk('lutRedGreen', ['Image', 'LookupTables'], 140, { enabled: anyIdle, run: (api) => setNamedLut(api, 'Red/Green') })
  ];

  IJApp.extend({
    pkg: 'edit',
    commands,
    panels: { pasteControl: { titleKey: 'dlg.edit.pasteControlTitle', build: buildPasteControl, defaultSize: { w: 300, h: 120 } } },
    errors: {
      IJ_EDIT_PASTE_TYPE: 'err.editPasteType', IJ_EDIT_CLIPBOARD_TOO_LARGE: 'err.editClipboardTooLarge', IJ_EDIT_CLIPBOARD_EMPTY: 'err.editClipboardEmpty',
      IJ_EDIT_CLIPBOARD_UNSUPPORTED: 'err.editClipboardUnsupported', IJ_EDIT_CLIPBOARD_DENIED: 'err.editClipboardDenied', IJ_EDIT_CLIPBOARD_NO_IMAGE: 'err.editClipboardNoImage',
      IJ_EDIT_LUT_UNKNOWN: 'err.editLutUnknown', IJ_EDIT_STACK_REQUIRED: 'err.editStackRequired', IJ_EDIT_NEEDS_AREA: 'err.editNeedsArea', IJ_BAD_LUT: 'err.editBadLut',
      IJ_NO_BLOB: 'err.editNoBlob', IJ_EDIT_INVERT_COMPOSITE: 'err.editInvertComposite', IJ_EDIT_NO_DISPLAY: 'err.editNoDisplay'
    }
  });
})();
