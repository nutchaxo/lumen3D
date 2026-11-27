/* ============================================================
   Lumen3D — visible time range of a timelapse
   ============================================================
   `metadata.json` may carry `timeRange: { start, end }` on a `live` dataset: the
   first and the LAST timepoint (both inclusive, 0-based, absolute indices of the
   acquisition) a visitor can reach. The acquisition itself is never cut — bricks,
   `dimensions.t`, the `download/` folder and every export keep the whole series —
   so this is a window over the timeline, nothing else.

   Frames stay ABSOLUTE everywhere (loader, tracking, Studio, workspace links): the
   range only decides which ones the timeline offers. Anything unusable (not an
   object, NaN, start after end, a range outside the series) means "no range" —
   a malformed value must never hide a dataset (rule 1.4).
   ============================================================ */

const TimeRange = (() => {
  const _int = (v) => {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return NaN;
    const n = Number(v);
    return Number.isInteger(n) ? n : NaN;
  };

  /**
   * @param {*} raw    `metadata.timeRange`, whatever the file holds
   * @param {number} total  `dimensions.t`
   * @returns {{ start:number, end:number, count:number, total:number, active:boolean }}
   *   `active` is true only when the window is narrower than the series.
   */
  function normalize(raw, total) {
    const n = Math.floor(Number(total));
    const count = Number.isFinite(n) && n > 0 ? n : 1;
    const full = { start: 0, end: count - 1, count, total: count, active: false };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return full;
    const start = _int(raw.start);
    const end = _int(raw.end);
    if (Number.isNaN(start) || Number.isNaN(end)) return full;
    if (start < 0 || end > count - 1 || start > end) return full;
    return { start, end, count: end - start + 1, total: count, active: start !== 0 || end !== count - 1 };
  }

  /** The stored form: null when the window is the whole series (nothing to keep). */
  function toStored(range) {
    return range && range.active ? { start: range.start, end: range.end } : null;
  }

  function clamp(range, frame) {
    const f = Number(frame);
    if (!Number.isFinite(f)) return range.start;
    return Math.max(range.start, Math.min(range.end, f));
  }

  /** Position of an absolute frame inside the window, 0..1 (0 for a one-frame window). */
  function fractionOf(range, frame) {
    return range.count > 1 ? (clamp(range, frame) - range.start) / (range.count - 1) : 0;
  }

  /** The absolute frame at a 0..1 position of the window. */
  function frameAt(range, fraction) {
    const p = Math.max(0, Math.min(1, Number(fraction) || 0));
    return range.start + Math.round(p * (range.count - 1));
  }

  return { normalize, toStored, clamp, fractionOf, frameAt };
})();
