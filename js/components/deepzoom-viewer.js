/* ============================================================
   IRIBHM Microscopy Platform — Deep Zoom Viewer (2D Native)
   ============================================================
   Encapsulates OpenSeadragon for fluid, Google Maps-style
   navigation of high-resolution Z-stack slices. Supports:
   - DZI (Deep Zoom Image) sources
   - Custom tile sources from tiles2d/manifest.json
   - Viewport sync with 3D viewer
   - Channel-aware tile URL templates
   ============================================================ */

const DeepZoomViewer = (() => {
  let _viewer = null;
  let _containerId = null;
  let _manifest = null;
  let _currentSlice = 0;
  let _currentChannel = 0;
  let _sliceCount = 0;
  let _active = false;
  const _listeners = new Set();

  /**
   * Initialize the DeepZoom viewer.
   * @param {string} containerId - DOM element ID for the viewer
   */
  function init(containerId) {
    _containerId = containerId;
  }

  /**
   * Check if OpenSeadragon is available.
   */
  function isAvailable() {
    return typeof OpenSeadragon !== 'undefined';
  }

  /**
   * Load a tiles2d manifest and initialize the viewer.
   * @param {string} manifestUrl - URL to the tiles2d/manifest.json
   * @param {Object} options - { initialSlice, channel }
   */
  async function loadManifest(manifestUrl, options = {}) {
    if (!isAvailable()) {
      console.warn('[DeepZoom] OpenSeadragon is required. Load it before using DeepZoom mode.');
      return false;
    }

    try {
      const resp = await fetch(manifestUrl);
      if (!resp.ok) {
        console.warn(`[DeepZoom] Manifest not found: ${manifestUrl} (${resp.status})`);
        return false;
      }
      _manifest = await resp.json();
    } catch (err) {
      console.warn('[DeepZoom] Failed to load manifest:', err);
      return false;
    }

    _sliceCount = _manifest.sliceCount || _manifest.slice_count || 1;
    _currentSlice = options.initialSlice ?? Math.floor(_sliceCount / 2);
    _currentChannel = options.channel ?? 0;

    _createViewer();
    _loadSlice(_currentSlice, _currentChannel);
    _active = true;
    return true;
  }

  /**
   * Load a DZI tile source directly.
   * @param {Object|string} tileSource - DZI URL or OpenSeadragon tile source config
   */
  function load(tileSource) {
    if (!isAvailable()) {
      console.error('[DeepZoom] OpenSeadragon is required.');
      return;
    }

    _createViewer();

    _viewer.open(tileSource);
    _active = true;
  }

  /**
   * Switch to a different Z-slice.
   * @param {number} sliceIndex - Z-slice index
   * @param {number} channel - Channel index
   */
  function setSlice(sliceIndex, channel = _currentChannel) {
    _currentSlice = Math.max(0, Math.min(_sliceCount - 1, sliceIndex));
    _currentChannel = channel;
    _loadSlice(_currentSlice, _currentChannel);
  }

  /**
   * Navigate slices by delta.
   */
  function nudgeSlice(delta) {
    setSlice(_currentSlice + delta);
  }

  function getCurrentSlice() {
    return _currentSlice;
  }

  function getSliceCount() {
    return _sliceCount;
  }

  function isActive() {
    return _active;
  }

  /**
   * Destroy the viewer and free resources.
   */
  function destroy() {
    if (_viewer) {
      _viewer.destroy();
      _viewer = null;
    }
    _active = false;
    _manifest = null;
  }

  /**
   * Get current viewport bounds in image coordinates.
   * @returns {Object|null} { x, y, width, height, zoom }
   */
  function getViewportBounds() {
    if (!_viewer) return null;
    try {
      const bounds = _viewer.viewport.getBounds(true);
      const imageBounds = _viewer.viewport.viewportToImageRectangle(bounds);
      return {
        x: Math.round(imageBounds.x),
        y: Math.round(imageBounds.y),
        width: Math.round(imageBounds.width),
        height: Math.round(imageBounds.height),
        zoom: _viewer.viewport.getZoom(true)
      };
    } catch {
      return null;
    }
  }

  /**
   * Register a callback for viewport changes.
   */
  function onViewportChange(callback) {
    if (typeof callback !== 'function') return () => {};
    _listeners.add(callback);
    return () => _listeners.delete(callback);
  }

  // ── Internal ──────────────────────────────────────────────

  function _createViewer() {
    if (_viewer) {
      _viewer.destroy();
      _viewer = null;
    }

    _viewer = OpenSeadragon({
      id: _containerId,
      prefixUrl: 'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/3.0.0/images/',
      showNavigator: true,
      navigatorPosition: 'TOP_RIGHT',
      crossOriginPolicy: 'Anonymous',
      smoothTileEdgesMinZoom: Infinity,
      imageLoaderLimit: 8,
      maxZoomPixelRatio: 4,
      zoomPerScroll: 1.3,
      animationTime: 0.3,
      immediateRender: true,
      debugMode: false
    });

    _viewer.addHandler('open', () => {
      console.log('[DeepZoom] Image pyramid loaded successfully.');
    });

    _viewer.addHandler('viewport-change', () => {
      const bounds = getViewportBounds();
      _listeners.forEach(cb => cb(bounds));
    });
  }

  function _loadSlice(sliceIndex, channel) {
    if (!_viewer || !_manifest) return;

    const basePath = _manifest.basePath || _manifest.base_path || '';
    // SEC-020 (Rule 1.4): basePath is manifest-sourced and concatenated raw into the
    // tile URLs below — refuse a value that could escape the dataset dir (a scheme
    // like http:/file:, a protocol-relative //host, or a '..' path segment).
    if (/^[a-z][a-z0-9+.-]*:/i.test(basePath) || String(basePath).startsWith('//') ||
        String(basePath).replace(/^\/+/, '').split(/[\\/]/).includes('..')) {
      console.warn(`[DeepZoomViewer] refusing unsafe manifest basePath "${basePath}"`);
      return;
    }
    const tileSize = _manifest.tileSize || _manifest.tile_size || 256;
    const width = _manifest.width || 1;
    const height = _manifest.height || 1;
    const levels = _manifest.levels || _manifest.pyramid_levels || 1;

    // Construct a custom tile source for this slice
    const tileSource = {
      width: width,
      height: height,
      tileSize: tileSize,
      tileOverlap: 0,
      minLevel: 0,
      maxLevel: Math.max(0, levels - 1),
      getTileUrl: function(level, x, y) {
        const zStr = String(sliceIndex).padStart(3, '0');
        const cStr = String(channel);
        return `${basePath}/z${zStr}_c${cStr}/level${level}/tile_${x}_${y}.webp`;
      }
    };

    // Check if the manifest has explicit tile URLs
    if (_manifest.tiles && _manifest.tiles[sliceIndex]) {
      const sliceTiles = _manifest.tiles[sliceIndex];
      if (sliceTiles.dzi) {
        _viewer.open(sliceTiles.dzi);
        return;
      }
    }

    _viewer.open(tileSource);
  }

  return {
    init,
    isAvailable,
    load,
    loadManifest,
    setSlice,
    nudgeSlice,
    getCurrentSlice,
    getSliceCount,
    isActive,
    destroy,
    getViewportBounds,
    onViewportChange
  };
})();