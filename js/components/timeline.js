/* ============================================================
   IRIBHM Microscopy Platform — Timeline Player
   ============================================================ */

const Timeline = (() => {
  let _totalFrames = 0;
  let _currentFrame = 0;
  let _isPlaying = false;
  let _playTimer = null;
  let _lastTime = 0;

  // Playback holds still while the consumer is still fetching the frame it was last
  // asked for. Without this the clock advances on wall time alone: a native-resolution
  // timepoint costs ~600 ms to stream, so by the time it lands the head has already
  // moved ~6 frames on and the loader is sent chasing a different one — the viewer
  // then never presents two consecutive frames, and never a finished one.
  let _stalled = false;
  let _stalledSince = 0;
  // A consumer that dies mid-load must not freeze the scrubber for good.
  const MAX_STALL_MS = 15000;
  // A single step must stay a single step. Any hitch — a load, a GC pause, a hidden
  // tab — otherwise lands as one huge dt and skips a run of frames outright.
  const MAX_STEP_MS = 250;

  let _onChangeCallback = null;
  let _options = {};

  // DOM elements
  let container, btnPlay, timeDisplay, scrubberTrack, scrubberFill, scrubberHandle, scrubberBuffer, sliderSpeed, sliderSmooth;

  function init(containerId, options, onChange) {
    container = document.getElementById(containerId);
    if (!container) return;
    
    _options = Object.assign({
      totalFrames: 10,
      showSpeed: false,
      showSmooth: false,
      stepped: false,
      speedValue: 5,
      smoothValue: 0,
      speedMin: 1,
      speedMax: 10,
      smoothMin: 0,
      smoothMax: 9
    }, options || {});

    // EDGE-040: coerce caller-supplied numerics so a NaN/undefined option can't
    // poison the scrubber (Math.max(1, NaN) is NaN) or playback. Defaults: 1 frame,
    // speed 5, smooth 0.
    const tf = Number(_options.totalFrames);
    _totalFrames = (Number.isFinite(tf) && tf > 0) ? Math.floor(tf) : 1;
    _options.speedValue = Number.isFinite(Number(_options.speedValue)) ? Number(_options.speedValue) : 5;
    _options.smoothValue = Number.isFinite(Number(_options.smoothValue)) ? Number(_options.smoothValue) : 0;
    _onChangeCallback = onChange;
    _currentFrame = 0;
    _isPlaying = false;
    _stalled = false;
    
    _renderDOM();
    _bindEvents();
    _updateTicks();
    _updateUI(0, false);
  }

  function _renderDOM() {
    container.innerHTML = `
      <div class="viewer-timeline" style="width:100%; display:flex; align-items:center;">
        <div class="play-controls" style="display:flex; align-items:center; gap:8px;">
          <button class="btn btn-icon btn-ghost" id="timeline-btn-play">
            <i data-lucide="play" id="timeline-icon-play"></i>
          </button>
          <span style="font-family:var(--font-mono); font-size:var(--text-sm);" id="timeline-time-display">000 / 000</span>
        </div>
        <div class="scrubber-container flex-1 mx-4">
          <div class="scrubber-track ${_options.stepped ? 'scrubber-stepped' : ''}" id="timeline-scrubber-track">
            <div class="scrubber-buffer" id="timeline-scrubber-buffer"></div>
            <div class="scrubber-fill" id="timeline-scrubber-fill" style="width:0%;"></div>
            <div class="scrubber-handle" id="timeline-scrubber-handle" style="left:0%;"></div>
          </div>
        </div>
        ${(_options.showSpeed || _options.showSmooth) ? `
        <div class="timeline-sliders flex flex-col gap-2 ml-2 mr-2 justify-center">
          ${_options.showSpeed ? `
          <div class="flex items-center gap-2">
            <span class="text-[10px] font-bold text-muted w-14 text-right tracking-wider">SPEED</span>
            <input type="range" id="timeline-slider-speed" min="${_options.speedMin}" max="${_options.speedMax}" value="${_options.speedValue}" class="range-slider" style="width: 70px;">
          </div>` : ''}
          ${_options.showSmooth ? `
          <div class="flex items-center gap-2">
            <span class="text-[10px] font-bold text-primary w-14 text-right tracking-wider">SMOOTH</span>
            <input type="range" id="timeline-slider-smooth" min="${_options.smoothMin}" max="${_options.smoothMax}" value="${_options.smoothValue}" class="range-slider" style="width: 70px;">
          </div>` : ''}
        </div>` : ''}
      </div>
    `;

    btnPlay = container.querySelector('#timeline-btn-play');
    timeDisplay = container.querySelector('#timeline-time-display');
    scrubberTrack = container.querySelector('#timeline-scrubber-track');
    scrubberFill = container.querySelector('#timeline-scrubber-fill');
    scrubberHandle = container.querySelector('#timeline-scrubber-handle');
    scrubberBuffer = container.querySelector('#timeline-scrubber-buffer');
    sliderSpeed = container.querySelector('#timeline-slider-speed');
    sliderSmooth = container.querySelector('#timeline-slider-smooth');
    
    if (window.lucide) lucide.createIcons({ root: container });
  }

  function getSmoothing() {
    return _options.showSmooth ? _options.smoothValue : 0;
  }

  function snapFrame(f, forceInteger = false) {
    const smoothing = getSmoothing();
    if (forceInteger || smoothing <= 0) return Math.round(f);
    const step = 1 / (smoothing + 1);
    return Math.round(f / step) * step;
  }

  function _updateTicks() {
    if (!_options.stepped) return;
    const smoothing = getSmoothing();
    const steps = Math.max(1, (_totalFrames - 1) * (smoothing + 1));
    scrubberTrack.style.setProperty('--tick-size', `${100 / steps}%`);
  }

  function _updateUI(f, notify = true) {
    const pct = (_totalFrames > 1) ? (f / (_totalFrames - 1)) * 100 : 0;
    scrubberHandle.style.left = `${pct}%`;
    scrubberFill.style.width = `${pct}%`;
    
    const label = getSmoothing() > 0 ? f.toFixed(1) : String(Math.round(f)).padStart(3, '0');
    timeDisplay.textContent = `${label} / ${String(_totalFrames - 1).padStart(3, '0')}`;

    if (notify && _onChangeCallback) {
      _onChangeCallback({ frame: f, isPlaying: _isPlaying, speed: _options.speedValue, smooth: _options.smoothValue });
    }
  }

  function setFrame(f, forceInteger = false, notify = true) {
    const clamped = Math.max(0, Math.min(_totalFrames - 1, f));
    const snapped = snapFrame(clamped, forceInteger);
    
    // Preserve fractional time accumulation during playback
    if (forceInteger) {
      _currentFrame = snapped;
    } else {
      _currentFrame = clamped;
    }

    _updateUI(snapped, notify);
  }

  function setPlayIcon(icon) {
    if (!btnPlay) return;
    btnPlay.innerHTML = `<i data-lucide="${icon}"></i>`;
    if (window.lucide) {
      lucide.createIcons({ nameAttr: 'data-lucide', root: btnPlay });
    }
  }

  function play() {
    if (_isPlaying) return;
    _isPlaying = true;
    setPlayIcon('pause');
    
    _lastTime = performance.now();
    // PERF-025: requestAnimationFrame loop instead of setInterval(50ms) — it
    // auto-throttles in background tabs (no drift / wasted ticks) and syncs to the
    // render cadence; the dt-based advance keeps playback speed correct.
    const tick = () => {
      if (!_isPlaying) { _playTimer = null; return; }
      const now = performance.now();
      // Keep the clock ticking but stop it accumulating: the head stays put until the
      // frame it already asked for is on screen. Bounded so a wedged consumer can't
      // freeze playback for good.
      if (_stalled && (now - _stalledSince) < MAX_STALL_MS) {
        _lastTime = now;
        _playTimer = requestAnimationFrame(tick);
        return;
      }
      const dt = Math.min(now - _lastTime, MAX_STEP_MS);
      _lastTime = now;

      const speed = _options.showSpeed ? _options.speedValue : 5;
      _currentFrame += (speed * 2) * (dt / 1000); // 2 to 20 fps

      if (_currentFrame >= _totalFrames - 1) {
        _currentFrame = 0; // loop
      }
      setFrame(_currentFrame, false, true);
      _playTimer = requestAnimationFrame(tick);
    };
    _playTimer = requestAnimationFrame(tick);
  }

  /** Hold the playhead while the consumer streams the frame it was last handed.
   *  A no-op when paused — `tick` is the only reader — so callers need not track
   *  whether playback is running. */
  function setStalled(v) {
    const next = Boolean(v);
    if (next === _stalled) return;
    _stalled = next;
    if (next) _stalledSince = performance.now();
  }

  function pause() {
    _isPlaying = false;
    setStalled(false);
    if (_playTimer) {
      cancelAnimationFrame(_playTimer);
      _playTimer = null;
    }
    setPlayIcon('play');
    setFrame(_currentFrame, true, true);
  }

  function togglePlay() {
    if (_isPlaying) pause();
    else play();
  }

  function _bindEvents() {
    btnPlay.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      togglePlay();
    });
    
    let _dragPointerId = null;

    const _scrubTo = (clientX) => {
      const rect = scrubberTrack.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      setFrame(pct * (_totalFrames - 1), false, true);
    };

    scrubberTrack.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      e.preventDefault();
      _dragPointerId = e.pointerId;
      pause();
      _scrubTo(e.clientX);
      try { scrubberTrack.setPointerCapture(e.pointerId); } catch (_) { /* pointer already gone */ }
    });

    scrubberTrack.addEventListener('pointermove', (e) => {
      if (e.pointerId !== _dragPointerId) return;
      _scrubTo(e.clientX);
    });

    // pointercancel matters as much as pointerup on touch: the browser can claim the
    // gesture (scroll, back-swipe) and then no pointerup ever comes — the scrubber
    // would stay armed and keep following the next unrelated move.
    const _endScrub = (e) => {
      if (e.pointerId !== _dragPointerId) return;
      _dragPointerId = null;
      try { scrubberTrack.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
      setFrame(_currentFrame, true, true);
    };
    scrubberTrack.addEventListener('pointerup', _endScrub);
    scrubberTrack.addEventListener('pointercancel', _endScrub);

    if (sliderSpeed) {
      sliderSpeed.addEventListener('input', () => {
        _options.speedValue = parseFloat(sliderSpeed.value);
        if (_onChangeCallback) _onChangeCallback({ frame: _currentFrame, speed: _options.speedValue, smooth: _options.smoothValue });
      });
    }

    if (sliderSmooth) {
      sliderSmooth.addEventListener('input', () => {
        _options.smoothValue = parseInt(sliderSmooth.value, 10);
        _updateTicks();
        setFrame(_currentFrame, true, true);
      });
    }
  }

  // Buffered frames are NOT a prefix: a series fills around the playhead and loses
  // frames again to eviction, so a single width can't describe it. Segments are
  // reused from a pool and only their left/width are written — a style ATTRIBUTE,
  // which the strict CSP allows (style-src-attr), unlike an injected <style>.
  let _bufSegPool = [];

  function _coalesce(sorted) {
    const out = [];
    for (const f of sorted) {
      const last = out[out.length - 1];
      if (last && f === last[1] + 1) last[1] = f;
      else out.push([f, f]);
    }
    return out;
  }

  function _paintSegments(ranges) {
    if (!scrubberBuffer) return;
    const denom = Math.max(1, _totalFrames - 1);
    ranges.forEach((r, i) => {
      let el = _bufSegPool[i];
      if (!el) {
        el = document.createElement('span');
        el.className = 'scrubber-buffer-seg';
        scrubberBuffer.appendChild(el);
        _bufSegPool[i] = el;
      }
      // Frame i owns [i-0.5, i+0.5] so the playhead, which sits at i/(N-1), stays
      // inside the segment that represents it.
      const left = Math.max(0, (r[0] - 0.5) / denom) * 100;
      const right = Math.min(1, (r[1] + 0.5) / denom) * 100;
      el.style.left = `${left}%`;
      el.style.width = `${Math.max(0, right - left)}%`;
      el.style.display = '';
    });
    for (let i = ranges.length; i < _bufSegPool.length; i++) _bufSegPool[i].style.display = 'none';
  }

  /** Accepts a Set/Array of frame indices, or a count (legacy callers such as
   *  widgets.html), which is drawn as the prefix [0, n-1] it used to mean. */
  function updateBuffer(buffered) {
    if (!scrubberBuffer) return;
    if (typeof buffered === 'number') {
      _paintSegments(buffered > 0 ? [[0, Math.max(0, buffered - 1)]] : []);
      return;
    }
    if (!buffered) { _paintSegments([]); return; }
    const frames = [...buffered].filter(Number.isFinite).sort((a, b) => a - b);
    _paintSegments(_coalesce(frames));
  }

  function clearBuffer() { _paintSegments([]); }
  
  function getFrame() {
    return snapFrame(_currentFrame, false);
  }

  return { init, updateBuffer, clearBuffer, setFrame, play, pause, getFrame, setStalled };
})();
