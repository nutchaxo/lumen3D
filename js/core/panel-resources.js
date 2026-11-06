/* ============================================================
   Panels: what each embedded viewer may hold
   ============================================================
   Every panel is a whole document: its own WebGL context, its own VRAM budget
   (SVRManager.vramBudget believes the card is its alone), its own pool of brick
   decode workers, its own pack caches and its own HTTP slots. Four panels with
   the defaults of a lone viewer are four times what the machine was sized for.
   This module divides one machine budget between the panels; it is pure, the
   host and the panel pages feed it plain numbers and the tests too. Loaded by
   compare.html (which decides) and viewer.html (which applies, at boot from
   `?panels=N` and afterwards from PANEL_RESOURCES).

   GPU: the host learns the machine's budget from the panels (`gpuBudgetBytes`,
   what a lone page would have allowed itself), keeps `GPU_SHARE` of it for the
   panels together, and hands each panel what its atlas needs (+ headroom) plus
   an equal part of what is left, for its frame cache. The panel then plans and
   evicts against that figure instead of the card's.

   CPU / network: workers, concurrent decodes, pack bodies in flight (one HTTP/1.1
   host gives the browser six sockets for everything) and compressed-pack caches
   are divided by the number of volume panels.
   ============================================================ */

const PanelResources = (() => {
  const MiB = 1024 * 1024;
  const GiB = 1024 * MiB;
  const GPU_SHARE = 0.7;                 // of the machine budget, for all panels together
  const GPU_FALLBACK = 1.5 * GiB;        // no panel reported a budget (an older page)
  const GPU_CEILING = 6 * GiB;
  const GPU_FLOOR = 192 * MiB;
  const HEADROOM = 1.15;                 // what a page holds besides its atlas (slicer, uniforms, staging)
  const MIN_PANEL_BYTES = 128 * MiB;

  /** Bytes the panels may hold together, from what the pages report (the smallest report wins). */
  function totalBudget(reported) {
    const values = (Array.isArray(reported) ? reported : [reported]).map(Number).filter(v => Number.isFinite(v) && v > 0);
    if (!values.length) return GPU_FALLBACK;
    return Math.max(GPU_FLOOR, Math.min(GPU_CEILING, Math.floor(Math.min(...values) * GPU_SHARE)));
  }

  /**
   * One VRAM budget per panel.
   * @param {{key:*, bytes:number}[]} entries  what each panel's atlas needs now (its biggest
   *        level while it moves between two: both are resident at the swap)
   * @param {number} total  totalBudget()
   * @returns {Map<*, number>}
   */
  function vramShares(entries, total) {
    const n = entries.length;
    const out = new Map();
    if (!n) return out;
    const wanted = entries.map(e => Math.max(0, Number(e.bytes) || 0) * HEADROOM);
    const need = wanted.reduce((s, v) => s + v, 0);
    // A plan that does not fit (an unpriced panel, a manual level) is squeezed evenly rather than starved.
    const scale = need > total && need > 0 ? total / need : 1;
    const extra = Math.max(0, total - need * scale) / n;
    entries.forEach((e, i) => out.set(e.key, Math.max(MIN_PANEL_BYTES, Math.floor(wanted[i] * scale + extra))));
    return out;
  }

  /**
   * Loader settings of one panel when `panels` volume panels share the page and
   * `cores` logical processors (BrickLoader.configure's own names).
   */
  function loaderSettings(panels, cores) {
    const n = Math.max(1, Math.floor(Number(panels)) || 1);
    const c = Math.max(2, Math.floor(Number(cores)) || 4);
    return {
      decodeWorkers: Math.max(1, Math.min(8, Math.floor((c - 1) / n))),
      concurrentLoads: Math.max(6, Math.floor(24 / n)),
      packFetchSlots: Math.max(1, Math.floor(4 / n)),
      packCacheBytes: Math.max(48 * MiB, Math.floor(192 * MiB / n)),
      rangeCacheBytes: Math.max(16 * MiB, Math.floor(64 * MiB / n)),
      prefetchCacheBytes: Math.max(8 * MiB, Math.floor(32 * MiB / n))
    };
  }

  return { totalBudget, vramShares, loaderSettings, HEADROOM, GPU_SHARE, GPU_FALLBACK };
})();
