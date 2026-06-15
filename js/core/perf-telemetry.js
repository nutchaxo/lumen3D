/* ============================================================
   IRIBHM Microscopy Platform - Performance Telemetry
   ============================================================ */

const PerfTelemetry = (() => {
  const MAX_SPANS = 3000;
  const MAX_EVENTS = 5000;
  const _active = new Map();
  const _spans = [];
  const _events = [];
  const _counters = new Map();
  const _context = {};
  const _sessionStartedAt = new Date().toISOString();
  let _seq = 0;

  function setContext(patch = {}) {
    if (!patch || typeof patch !== 'object') return;
    Object.assign(_context, patch);
  }

  function event(name, meta = {}) {
    if (!name) return null;
    const row = {
      type: 'event',
      id: `e_${++_seq}`,
      name: String(name),
      t: _now(),
      ts: Date.now(),
      meta: _safe(meta)
    };
    _events.push(row);
    _trim(_events, MAX_EVENTS);
    return row.id;
  }

  function inc(name, value = 1) {
    if (!name) return;
    const next = (_counters.get(name) || 0) + (Number(value) || 0);
    _counters.set(name, next);
    return next;
  }

  function start(name, meta = {}) {
    if (!name) return null;
    const id = `s_${++_seq}`;
    _active.set(id, {
      id,
      name: String(name),
      t0: _now(),
      ts0: Date.now(),
      meta: _safe(meta)
    });
    return id;
  }

  function end(id, meta = {}) {
    if (!id || !_active.has(id)) return null;
    const span = _active.get(id);
    _active.delete(id);
    const t1 = _now();
    const row = {
      type: 'span',
      id: span.id,
      name: span.name,
      t0: span.t0,
      t1,
      durationMs: Math.max(0, t1 - span.t0),
      ts0: span.ts0,
      ts1: Date.now(),
      meta: { ...span.meta, ..._safe(meta) }
    };
    _spans.push(row);
    _trim(_spans, MAX_SPANS);
    return row;
  }

  function cancel(id, meta = {}) {
    if (!id || !_active.has(id)) return null;
    const span = _active.get(id);
    _active.delete(id);
    return event('span.cancelled', { span: span.name, ..._safe(meta) });
  }

  function clear() {
    _active.clear();
    _spans.length = 0;
    _events.length = 0;
    _counters.clear();
  }

  function getSummary() {
    const groups = new Map();
    _spans.forEach(row => {
      const bucket = groups.get(row.name) || [];
      bucket.push(row.durationMs);
      groups.set(row.name, bucket);
    });
    const operations = {};
    groups.forEach((durations, name) => {
      const sorted = [...durations].sort((a, b) => a - b);
      const sum = sorted.reduce((acc, value) => acc + value, 0);
      operations[name] = {
        count: sorted.length,
        minMs: _round(sorted[0] || 0),
        maxMs: _round(sorted[sorted.length - 1] || 0),
        avgMs: _round(sum / Math.max(1, sorted.length)),
        p50Ms: _round(_percentile(sorted, 0.5)),
        p95Ms: _round(_percentile(sorted, 0.95))
      };
    });
    return {
      sessionStartedAt: _sessionStartedAt,
      context: { ..._context },
      activeSpans: _active.size,
      counters: Object.fromEntries(_counters.entries()),
      operationNames: Object.keys(operations).sort(),
      operations,
      spanCount: _spans.length,
      eventCount: _events.length,
      lastSpans: _spans.slice(-80),
      lastEvents: _events.slice(-80)
    };
  }

  function _percentile(sorted, p) {
    if (!sorted.length) return 0;
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
    return sorted[idx];
  }

  function _round(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
  }

  function _trim(arr, limit) {
    if (arr.length <= limit) return;
    arr.splice(0, arr.length - limit);
  }

  function _safe(meta) {
    if (!meta || typeof meta !== 'object') return {};
    const out = {};
    for (const [key, value] of Object.entries(meta)) {
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
        out[key] = value;
      } else if (Array.isArray(value)) {
        out[key] = value.slice(0, 20);
      } else {
        try {
          out[key] = JSON.parse(JSON.stringify(value));
        } catch {
          out[key] = String(value);
        }
      }
    }
    return out;
  }

  function _now() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
  }

  return {
    setContext,
    event,
    inc,
    start,
    end,
    cancel,
    clear,
    getSummary
  };
})();

if (typeof window !== 'undefined') {
  window.PerfTelemetry = PerfTelemetry;
}
