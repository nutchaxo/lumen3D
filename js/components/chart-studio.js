/* ============================================================
   IRIBHM Microscopy Platform — Chart Studio
   ============================================================ */

const ChartStudio = (() => {
  let _container = null;
  let _metric = 'population';
  let _scale = 'linear';
  let _seriesOptions = () => ({});

  function init(containerId, options = {}) {
    _container = document.getElementById(containerId);
    if (!_container) return;
    _metric = options.metric || _metric;
    _scale = options.scale || _scale;
    _seriesOptions = typeof options.getSeriesOptions === 'function'
      ? options.getSeriesOptions
      : (() => options.seriesOptions || {});
    render();
  }

  function setMetric(metric) {
    _metric = metric;
    render();
  }

  function setScale(scale) {
    _scale = scale;
    render();
  }

  function render() {
    if (!_container || !window.Plotly) return;
    const series = AnalysisStore.populationSeries(_metric, _seriesOptions());
    const traces = series.map(row => ({
      x: row.x,
      y: _scale === 'log' ? row.y.map(value => value > 0 ? value : null) : row.y,
      name: row.region,
      type: _metric === 'mitoses' ? 'bar' : 'scatter',
      mode: _metric === 'mitoses' ? undefined : 'lines',
      line: { shape: 'spline', width: 2 }
    }));
    const title = {
      population: 'Cell population',
      velocity: 'Mean velocity',
      neighbors: 'Neighbor count',
      mitoses: 'Mitoses'
    }[_metric] || _metric;
    Plotly.newPlot(_container, traces, {
      title: { text: title, font: { size: 13 } },
      margin: { t: 34, l: 42, r: 14, b: 34 },
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      font: { color: '#a0a3b1', size: 10 },
      xaxis: { title: 'Timepoint', gridcolor: '#2a2d3a' },
      yaxis: { title, type: _scale, gridcolor: '#2a2d3a' },
      legend: { orientation: 'h', y: -0.28 },
      barmode: 'stack'
    }, { displayModeBar: false, responsive: true });
  }

  function getGraph() {
    return _container;
  }

  return { init, setMetric, setScale, render, getGraph };
})();
