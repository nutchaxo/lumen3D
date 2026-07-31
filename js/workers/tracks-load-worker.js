/* ============================================================
   IRIBHM Microscopy Platform — Tracking loader worker
   ============================================================
   Fetches tracks.json (1 MB raw on the reference series), parses it and packs it
   into transferable typed arrays, off the main thread — the viewer is streaming
   64^3 bricks at the same time and a 1 MB JSON.parse on the UI thread is a visible
   hitch (rule 1.2).

   Output stays in ACQUISITION MICROMETRES. The um -> object-space transform lives
   in VolumeViewer._objectFromUm and is applied there: re-deriving it here would be
   a second implementation of one change of frame, free to drift (rule 1.1). The
   cost on the main thread is 3 multiplies per point per frame (<= 348 points).
   ============================================================ */

/** Cells are keyed by their timepoint STRING ('1'..'30' — Imaris counts from 1)
 *  while the brick pyramid indexes frames from 0. Rather than hardcode the +1,
 *  build the mapping from the file's own sorted `timepoints` list, so a series
 *  starting at 0, non-contiguous or non-integer still lands on the right frame. */
function buildFrameIndex(timepoints) {
  const sorted = Array.isArray(timepoints) ? timepoints.slice().sort((a, b) => a - b) : [];
  const map = new Map();
  sorted.forEach((v, i) => {
    map.set(String(v), i);
    // The importer writes str(int(t)) for whole values; JS String(1.0) is '1', so
    // these agree — but a float like 1.5 stringifies differently on each side.
    if (Number.isInteger(v)) map.set(String(Math.trunc(v)), i);
  });
  return { map, frameCount: sorted.length };
}

function hexToRgb(hex) {
  const s = String(hex || '').replace('#', '');
  if (s.length !== 6) return [1, 1, 1];
  const n = parseInt(s, 16);
  if (!Number.isFinite(n)) return [1, 1, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

async function fetchDoc(url, post) {
  // The .gz sibling is a pure optimisation: the preprocessing writes it, but
  // DATA_WEB is deployed by SFTP and is not part of a release, so it is routinely
  // absent (it 404s on the reference host today). Any failure — missing file, a
  // server that already applied Content-Encoding so the stream is not gzip, a
  // parse error — falls back to the plain document without surfacing an error.
  if (typeof DecompressionStream !== 'undefined') {   // NOT `in window`: no window in a worker
    try {
      const resp = await fetch(url + '.gz', { cache: 'no-store' });
      if (resp.ok && resp.body) {
        const text = await new Response(resp.body.pipeThrough(new DecompressionStream('gzip'))).text();
        post({ phase: 'parse' });
        return JSON.parse(text);
      }
    } catch (_) { /* fall through to the plain document */ }
  }
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} on ${url}`);
  const total = Number(resp.headers.get('Content-Length')) || 0;
  if (!resp.body || !total) {
    post({ phase: 'parse' });
    return JSON.parse(await resp.text());
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    seen += value.length;
    post({ phase: 'download', pct: Math.min(1, seen / total) });
  }
  post({ phase: 'parse' });
  return JSON.parse(new TextDecoder().decode(await new Blob(chunks).arrayBuffer()));
}

self.onmessage = async (ev) => {
  const { url } = ev.data || {};
  const post = (m) => self.postMessage(m);
  try {
    const doc = await fetchDoc(url, post);
    const cells = doc && doc.cells;
    if (!cells || typeof cells !== 'object') throw new Error('tracks.json: missing "cells"');

    const { map: keyToFrame, frameCount } = buildFrameIndex(doc.timepoints);
    if (!frameCount) throw new Error('tracks.json: missing "timepoints"');

    const ids = Object.keys(cells);
    const cellTotal = ids.length;

    // Pass 1 — how many cells exist per frame. Cells appear and disappear (324 at
    // t=1, 348 at t=10, 65 at t=30 on the reference series): drawing a fixed count
    // would leave hundreds of stale points frozen at their last known position.
    const counts = new Uint16Array(frameCount);
    let unmapped = 0;
    for (const id of ids) {
      const p = cells[id] && cells[id].positions;
      if (!p) continue;
      for (const key in p) {
        const f = keyToFrame.get(key);
        if (f === undefined) { unmapped++; continue; }
        counts[f]++;
      }
    }
    let maxN = 0;
    for (let f = 0; f < frameCount; f++) if (counts[f] > maxN) maxN = counts[f];

    const stride = maxN * 3;
    const posStab = new Float32Array(frameCount * stride);
    const posRaw = new Float32Array(frameCount * stride);
    const cellIdx = new Uint16Array(frameCount * maxN);
    // One colour per CELL, not per cell per frame: a cell's region never changes,
    // so a per-frame colour array would be 30x the same bytes.
    const palette = new Float32Array(cellTotal * 3);
    const regions = new Array(cellTotal);
    const cursor = new Uint16Array(frameCount);
    let hasRawAll = true;

    for (let c = 0; c < cellTotal; c++) {
      const cell = cells[ids[c]];
      const rgb = hexToRgb(cell && cell.color);
      palette[c * 3] = rgb[0]; palette[c * 3 + 1] = rgb[1]; palette[c * 3 + 2] = rgb[2];
      regions[c] = (cell && cell.region) || 'Unknown';
      const p = cell && cell.positions;
      if (!p) continue;
      const raw = cell.raw_positions;
      if (!raw) hasRawAll = false;
      for (const key in p) {
        const f = keyToFrame.get(key);
        if (f === undefined) continue;
        const slot = cursor[f]++;
        const o = f * stride + slot * 3;
        const v = p[key];
        posStab[o] = v[0]; posStab[o + 1] = v[1]; posStab[o + 2] = v[2];
        const r = raw && raw[key];
        // No raw pair for this timepoint: fall back to the stabilised value rather
        // than leaving a zero, which would park a point at the acquisition origin.
        posRaw[o] = r ? r[0] : v[0];
        posRaw[o + 1] = r ? r[1] : v[1];
        posRaw[o + 2] = r ? r[2] : v[2];
        cellIdx[f * maxN + slot] = c;
      }
      if ((c & 63) === 0) post({ phase: 'bake', pct: c / cellTotal });
    }

    self.postMessage({
      phase: 'done',
      frameCount, maxN, cellTotal, hasRaw: hasRawAll, unmapped,
      regions,
      posStab, posRaw, cellIdx, counts, palette
    }, [posStab.buffer, posRaw.buffer, cellIdx.buffer, counts.buffer, palette.buffer]);
  } catch (err) {
    self.postMessage({ phase: 'error', message: (err && err.message) || String(err) });
  }
};
