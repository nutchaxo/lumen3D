/* ============================================================
   IRIBHM Microscopy Platform — Tracking Analysis Store
   ============================================================ */

const AnalysisStore = (() => {
  let _trackData = null;

  function setTrackingData(trackData) {
    _trackData = trackData;
  }

  function getCell(cellId) {
    if (!_trackData?.cells) return null;
    const key = String(cellId);
    return _trackData.cells[key]
      || Object.values(_trackData.cells).find(cell => String(cell.id) === key || String(cell.track_id) === key)
      || null;
  }

  function cellMetrics(cellId, options = {}) {
    const cell = typeof cellId === 'object' ? cellId : getCell(cellId);
    if (!cell) return null;
    const positions = _posMapForCell(cell, options);
    const times = Object.keys(positions).map(Number).sort((a, b) => a - b);
    let pathLength = 0;
    for (let i = 1; i < times.length; i++) {
      pathLength += _dist(positions[times[i - 1]], positions[times[i]]);
    }
    const displacement = times.length > 1 ? _dist(positions[times[0]], positions[times[times.length - 1]]) : 0;
    const duration = times.length > 1 ? Math.max(1, times[times.length - 1] - times[0]) : 1;
    return {
      id: cell.id,
      trackId: cell.track_id,
      region: cell.region || 'Unknown',
      timepoints: times.length,
      firstTime: times[0] ?? null,
      lastTime: times[times.length - 1] ?? null,
      pathLength,
      displacement,
      straightness: pathLength > 0 ? displacement / pathLength : 0,
      meanSpeed: pathLength / duration,
      parent: cell.parent_cell || cell.parent || null,
      daughters: cell.daughter_cells || cell.daughters || []
    };
  }

  function populationSeries(metric = 'population', options = {}) {
    if (!_trackData?.cells) return [];
    const times = (_trackData.timepoints || _inferTimepoints()).map(Number).sort((a, b) => a - b);
    const byRegion = {};
    const sampleCounts = {};
    const cells = Object.values(_trackData.cells);
    const neighborThreshold = Math.max(0, Number(options.neighborThreshold) || 45);

    if (metric === 'neighbors') {
      const activeByTime = {};
      times.forEach(t => { activeByTime[t] = []; });
      cells.forEach(cell => {
        const positions = _posMapForCell(cell, options);
        times.forEach(t => {
          const pos = positions[String(Math.floor(t))];
          if (pos) activeByTime[t].push({ cell, pos });
        });
      });
      times.forEach((t, idx) => {
        const rows = activeByTime[t] || [];
        rows.forEach(row => {
          const region = row.cell.region || 'Unknown';
          byRegion[region] ||= new Array(times.length).fill(0);
          sampleCounts[region] ||= new Array(times.length).fill(0);
          const count = rows.reduce((sum, other) => {
            if (other === row) return sum;
            return sum + (_dist(row.pos, other.pos) <= neighborThreshold ? 1 : 0);
          }, 0);
          byRegion[region][idx] += count;
          sampleCounts[region][idx]++;
        });
      });
      return Object.entries(byRegion).map(([region, values]) => ({
        region,
        x: times,
        y: values.map((value, idx) => sampleCounts[region][idx] ? value / sampleCounts[region][idx] : 0)
      }));
    }

    cells.forEach(cell => {
      const region = cell.region || 'Unknown';
      byRegion[region] ||= new Array(times.length).fill(0);
      sampleCounts[region] ||= new Array(times.length).fill(0);
      const positions = _posMapForCell(cell, options);

      if (metric === 'mitoses') {
        const mitosisTime = _mitosisTime(cell, options);
        if (mitosisTime === null) return;
        const idx = _nearestTimeIndex(times, mitosisTime);
        if (idx >= 0) byRegion[region][idx] += 1;
        return;
      }

      times.forEach((t, idx) => {
        const current = positions[String(Math.floor(t))];
        if (!current) return;

        if (metric === 'velocity') {
          const prev = positions[String(Math.floor(times[Math.max(0, idx - 1)]))];
          if (prev && idx > 0) {
            const dt = Math.max(1, times[idx] - times[idx - 1]);
            byRegion[region][idx] += _dist(prev, current) / dt;
            sampleCounts[region][idx]++;
          }
          return;
        }

        byRegion[region][idx] += 1;
      });
    });
    return Object.entries(byRegion).map(([region, values]) => ({
      region,
      x: times,
      y: metric === 'velocity'
        ? values.map((value, idx) => sampleCounts[region][idx] ? value / sampleCounts[region][idx] : 0)
        : values
    }));
  }

  function neighborRows(cellId, timepoint, maxNeighbors = 8, options = {}) {
    const cell = getCell(cellId);
    if (!cell || !_trackData?.cells) return [];
    const t = String(Math.round(timepoint || 0));
    const p = _posMapForCell(cell, options)[t];
    if (!p) return [];
    const threshold = Math.max(0, Number(options.neighborThreshold) || Infinity);
    return Object.values(_trackData.cells)
      .filter(other => other !== cell)
      .map(other => {
        const op = _posMapForCell(other, options)[t];
        if (!op) return null;
        const distance = _dist(p, op);
        if (distance > threshold) return null;
        return { id: other.id, trackId: other.track_id, region: other.region || 'Unknown', distance };
      })
      .filter(Boolean)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, maxNeighbors);
  }

  function lineageForCell(cellId) {
    const cell = getCell(cellId);
    if (!cell) return null;
    const metrics = cellMetrics(cell) || {};
    const parentId = metrics.parent;
    const daughters = Array.isArray(metrics.daughters)
      ? metrics.daughters
      : (metrics.daughters ? [metrics.daughters] : []);
    const parent = parentId ? getCell(parentId) : null;
    return {
      id: cell.id,
      trackId: cell.track_id,
      region: cell.region || 'Unknown',
      parent: parent ? {
        id: parent.id,
        trackId: parent.track_id,
        region: parent.region || 'Unknown'
      } : (parentId ? { id: parentId, trackId: parentId, region: 'Unknown' } : null),
      daughters: daughters.map(id => {
        const daughter = getCell(id);
        return daughter ? {
          id: daughter.id,
          trackId: daughter.track_id,
          region: daughter.region || 'Unknown'
        } : {
          id,
          trackId: id,
          region: 'Unknown'
        };
      }),
      metrics
    };
  }

  function trackCsv(cellId) {
    const cell = getCell(cellId);
    if (!cell) return '';
    const positions = cell.positions || {};
    const raw = cell.raw_positions || {};
    const times = [...new Set([...Object.keys(positions), ...Object.keys(raw)])].map(Number).sort((a, b) => a - b);
    const rows = [['timepoint', 'x', 'y', 'z', 'raw_x', 'raw_y', 'raw_z']];
    times.forEach(t => {
      const p = positions[t] || [];
      const r = raw[t] || [];
      rows.push([t, p[0] ?? '', p[1] ?? '', p[2] ?? '', r[0] ?? '', r[1] ?? '', r[2] ?? '']);
    });
    return rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\n');
  }

  function _inferTimepoints() {
    const set = new Set();
    Object.values(_trackData?.cells || {}).forEach(cell => {
      Object.keys(cell.positions || cell.raw_positions || {}).forEach(t => set.add(Number(t)));
    });
    return [...set];
  }

  function _hasDaughters(cell) {
    const value = cell.daughter_cells || cell.daughters;
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  }

  function _mitosisTime(cell, options = {}) {
    if (!_hasDaughters(cell)) return null;
    const metrics = cellMetrics(cell, options);
    const daughters = Array.isArray(metrics?.daughters) ? metrics.daughters : (metrics?.daughters ? [metrics.daughters] : []);
    const daughterStarts = daughters
      .map(id => cellMetrics(getCell(id), options)?.firstTime)
      .filter(Number.isFinite);
    if (daughterStarts.length) return Math.min(...daughterStarts);
    return Number.isFinite(metrics?.lastTime) ? metrics.lastTime : null;
  }

  function _nearestTimeIndex(times, target) {
    if (!times.length || !Number.isFinite(target)) return -1;
    let best = 0;
    let bestDelta = Math.abs(times[0] - target);
    for (let i = 1; i < times.length; i++) {
      const delta = Math.abs(times[i] - target);
      if (delta < bestDelta) {
        best = i;
        bestDelta = delta;
      }
    }
    return best;
  }

  function _posMapForCell(cell, options = {}) {
    if (!cell) return {};
    if (options.useStabilized && cell.positions) return cell.positions;
    return cell.raw_positions || cell.positions || {};
  }

  function _dist(a = [], b = []) {
    const dx = (a[0] || 0) - (b[0] || 0);
    const dy = (a[1] || 0) - (b[1] || 0);
    const dz = (a[2] || 0) - (b[2] || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  return { setTrackingData, getCell, cellMetrics, populationSeries, neighborRows, lineageForCell, trackCsv };
})();
