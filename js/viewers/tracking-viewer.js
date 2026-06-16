/* ============================================================
   IRIBHM Microscopy Platform — Tracking 3D Viewer
   ============================================================ */

const TrackingViewer = (() => {
  let _container, _renderer, _scene, _camera, _controls;
  let _datasetMeta, _trackData;
  let _glbScene = null;
  let _resizeObserver = null;
  let _onCameraChange = null;
  let _onCellSelect = null;
  let _onMeasureChange = null;
  let _lastCameraNotify = 0;
  let _applyingCameraState = false;
  let _raycaster = null;
  let _pointer = null;
  let _activeTool = 'navigate';
  let _surfaceGroup = null;
  let _surfaceVariants = { raw: [], stab: [] };
  let _measurementGroup = null;
  let _measurements = [];
  let _measureDraft = [];
  let _measurementMode = 'snapshot';
  let _meshClipSpec = {
    enabled: false,
    mode: 'xy',
    value: 1,
    yaw: 0,
    pitch: 0,
    color: '#00d2ff',
    opacity: 0.22
  };
  let _clipPlaneHelper = null;
  let _clipCapGroup = null;
  // ELE-28 (PERF-002): invalidation key for the clip cap. The cap is a pure
  // function of the clip plane spec (+ derived _clipSpan) and the set of
  // currently-visible surface meshes (which changes as the scrub picks the
  // nearest surface variant). Rebuild — full per-triangle walk + GPU alloc — only
  // when this key changes.
  let _clipCapKey = null;
  
  // Meshes
  let _cellMesh; // InstancedMesh
  let _trailLines = [];
  let _velocityGroup = null;
  let _neighborGroup = null;
  
  // State
  let _currentTime = 0;
  let _filters = { mitosis: true, fusion: true, stabilized: false };
  let _surfaceOpts = { opacity: 0.0, colorMode: 'density' };
  let _displayState = { backgroundPreset: 'paper', backgroundColor: '#ffffff' };
  let _surfaceLegendState = { kind: 'uniform', title: 'Surface', items: [] };
  // ELE-29 (PERF-003): memoize the O(vertices x cells) surface-color pass.
  // _surfaceColorSig encodes every input the dynamic density/region recompute
  // reads; set it to null to force a recompute on the next call.
  let _surfaceColorSig = null;
  let _regionRevision = 0;
  // Pre-allocated surface materials (swap, never toggle vertexColors)
  let _surfaceMatUniform = null;
  let _surfaceMatDensity = null;
  let _smoothing = 0;
  let _velocityFieldVisible = false;
  let _neighborNetworkVisible = false;
  let _neighborThreshold = 55;
  let _pointScale = 1.0;
  
  // Data mapping
  let _activeCells = []; // array of cell IDs active around current time
  let _cellIds = []; // all cell IDs for the instanced mesh mapping
  let _cellIdToIndex = {}; // cellId -> instance index
  let _selectedCellId = null;

  // Colors
  const REGION_COLORS = [
    '#3498db', '#e74c3c', '#2ecc71', '#f1c40f', '#9b59b6', '#1abc9c', '#e67e22', '#34495e'
  ];
  let _regionColorMap = {};

  const COLOR_MAPS = {
    viridis: ['#440154', '#31688e', '#35b779', '#fde725'],
    magma: ['#000004', '#51127c', '#b63679', '#fc8961'],
    plasma: ['#0d0887', '#9c179e', '#bd3786', '#ed7953', '#f0f921'],
    inferno: ['#000004', '#57106e', '#bb3754', '#f98d0a'],
    turbo: ['#23171b', '#4a58dd', '#2f9df5', '#27d7c4', '#4df884', '#95fb51', '#dedd32', '#ffa423', '#f65f18', '#c9220a', '#7a0403'],
    coolwarm: ['#3b4cc0', '#8caff6', '#dddddd', '#f49a7b', '#b40426'],
    gray: ['#000000', '#ffffff']
  };
  let _activeColormap = 'viridis';

  async function init(container) {
    _container = container;
    
    _scene = new THREE.Scene();
    
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    _camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
    _camera.position.set(0, 0, 500);
    
    _renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    _renderer.setSize(width, height, false);
    _renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    _renderer.localClippingEnabled = true;
    if ('outputColorSpace' in _renderer) {
      _renderer.outputColorSpace = THREE.SRGBColorSpace;
    } else {
      _renderer.outputEncoding = THREE.sRGBEncoding;
    }
    container.appendChild(_renderer.domElement);
    setBackgroundPreset(_displayState.backgroundPreset, _displayState.backgroundColor);
    
    _controls = new THREE.OrbitControls(_camera, _renderer.domElement);
    _controls.enableDamping = true;
    _controls.dampingFactor = 0.05;
    _controls.screenSpacePanning = true;
    _controls.addEventListener('change', () => {
      if (_applyingCameraState) return;
      const now = performance.now();
      if (now - _lastCameraNotify > 120) {
        _lastCameraNotify = now;
        _notifyCameraChange();
      }
    });
    _raycaster = new THREE.Raycaster();
    _pointer = new THREE.Vector2();
    _setupInteraction();
    _velocityGroup = new THREE.Group();
    _neighborGroup = new THREE.Group();
    _measurementGroup = new THREE.Group();
    _clipCapGroup = new THREE.Group();
    _scene.add(_velocityGroup);
    _scene.add(_neighborGroup);
    _scene.add(_measurementGroup);
    _scene.add(_clipCapGroup);
    
    // Lights
    const ambLight = new THREE.AmbientLight(0xffffff, 0.6);
    _scene.add(ambLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
    dirLight.position.set(1, 1, 2);
    _scene.add(dirLight);
    
    window.addEventListener('resize', _onResize);
    if (window.ResizeObserver) {
      _resizeObserver = new ResizeObserver(_onResize);
      _resizeObserver.observe(container);
    }
    
    // Create two surface materials upfront
    _surfaceMatUniform = new THREE.MeshBasicMaterial({
      color: 0x87CEEB,
      transparent: true,
      opacity: _surfaceOpts.opacity,
      side: THREE.DoubleSide,
      depthWrite: _surfaceOpts.opacity >= 0.999,
    });
    _surfaceMatDensity = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: _surfaceOpts.opacity,
      side: THREE.DoubleSide,
      depthWrite: _surfaceOpts.opacity >= 0.999,
    });
    
    _animate();
  }

  let _gridDragState = null;
  let _axesDragState = false;
  let _lastInteractionClickTime = 0;
  let _isDraggingInteraction = false;
  let _interactionStartMouse = {x: 0, y: 0};

  function _setupInteraction() {
    _renderer.domElement.addEventListener('pointerdown', (e) => {
      const now = Date.now();
      const isDoubleClick = (now - _lastInteractionClickTime < 300);
      _lastInteractionClickTime = now;
      
      const interactionHit = _intersectInteractionHandles(e.clientX, e.clientY);
      if (interactionHit && e.button === 0 && !e.shiftKey) {
        _controls.enabled = false;
        _isDraggingInteraction = true;
        _interactionStartMouse = {x: e.clientX, y: e.clientY};
        if (interactionHit.object.userData.isAxesSphere) {
          if (isDoubleClick) {
            const span = _clipSpan ? _clipSpan() : 100;
            _axesGroup.position.set(-span*1.5/2, -span*1.5/2, -span*1.5/2);
            _isDraggingInteraction = false;
            _controls.enabled = true;
          } else {
            _axesDragState = true;
          }
        } else if (interactionHit.object.userData.isGridHandle) {
          const plane = interactionHit.object.userData.plane;
          if (isDoubleClick) {
            _gridSizeScales[plane] = 1.0;
            _updateGridsAndAxes();
            _isDraggingInteraction = false;
            _controls.enabled = true;
          } else {
            _gridDragState = { plane: plane, normal: interactionHit.object.userData.normal.clone(), startScale: _gridSizeScales[plane], startX: e.clientX, startY: e.clientY };
          }
        }
      }
    });

    _renderer.domElement.addEventListener('pointermove', (e) => {
      if (!_isDraggingInteraction) {
        const hit = _intersectInteractionHandles(e.clientX, e.clientY);
        let hoverAxes = false;
        let hoverGrid = null;
        if (hit) {
          if (hit.object.userData.isAxesSphere) hoverAxes = true;
          else if (hit.object.userData.isGridHandle) hoverGrid = hit.object;
        }
        if (_axesGroup) {
          _axesGroup.children.forEach(c => {
            if (c.userData.isAxesSphere) {
              c.userData.hovered = hoverAxes;
              c.material.opacity = hoverAxes ? 0.4 : 0.0;
              c.scale.setScalar(hoverAxes ? 1.5 : 1.0);
            }
          });
        }
        if (_gridGroup) {
          _gridGroup.children.forEach(c => {
            if (c.userData.isGridHandle) {
              const hovered = (c === hoverGrid);
              c.userData.hovered = hovered;
              if (hovered) {
                c.material.opacity = 0.8;
                c.scale.setScalar(1.5);
              } else {
                c.material.opacity = c.userData.isParallel ? 0.4 : 0.0;
                c.scale.setScalar(1.0);
              }
            }
          });
        }
        if (hoverAxes || hoverGrid) _renderer.domElement.style.cursor = 'grab';
        else _renderer.domElement.style.cursor = '';
      } else {
        if (_axesDragState) {
          _moveAxesToScreenPoint(e.clientX, e.clientY);
        } else if (_gridDragState) {
          const span = _clipSpan ? _clipSpan() : 100;
          const baseSize = span * 1.5;
          const cornerWorld = new THREE.Vector3(-baseSize/2, -baseSize/2, -baseSize/2);
          const worldNormal = _gridDragState.normal;
          
          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(worldNormal, cornerWorld);
          
          const rect = _renderer.domElement.getBoundingClientRect();
          const ndc = new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1
          );
          const raycaster = new THREE.Raycaster();
          raycaster.setFromCamera(ndc, _camera);
          const targetWorld = new THREE.Vector3();
          
          if (raycaster.ray.intersectPlane(plane, targetWorld)) {
            let rawSize = 0;
            if (_gridDragState.plane === 'xy') {
               rawSize = Math.max(targetWorld.x - (-baseSize/2), targetWorld.y - (-baseSize/2));
            } else if (_gridDragState.plane === 'xz') {
               rawSize = Math.max(targetWorld.x - (-baseSize/2), targetWorld.z - (-baseSize/2));
            } else if (_gridDragState.plane === 'yz') {
               rawSize = Math.max(targetWorld.y - (-baseSize/2), targetWorld.z - (-baseSize/2));
            }
            rawSize = Math.max(0, rawSize);
            const rawScale = rawSize / baseSize;
            const stepScale = 1.0 / (_gridMode === 2 ? 40 : 10);
            const newScale = Math.max(0, Math.round(rawScale / stepScale) * stepScale);
            if (_gridSizeScales[_gridDragState.plane] !== newScale) {
              _gridSizeScales[_gridDragState.plane] = newScale;
              _updateGridsAndAxes();
            }
          }
        }
      }
    });

    _renderer.domElement.addEventListener('pointerup', (e) => {
      if (_isDraggingInteraction) {
        const moved = Math.hypot(e.clientX - _interactionStartMouse.x, e.clientY - _interactionStartMouse.y);
        _isDraggingInteraction = false;
        _axesDragState = false;
        _gridDragState = null;
        _controls.enabled = true;
        if (moved > 5) return; // Prevent clicking cell if we dragged
      }
      // If we didn't drag an interaction handle, handle cell click
      const movedSinceDown = Math.hypot(e.clientX - _interactionStartMouse.x, e.clientY - _interactionStartMouse.y);
      if (!_isDraggingInteraction && movedSinceDown < 5) {
         _handleCellClick(e);
      }
    });
  }

  function _intersectInteractionHandles(clientX, clientY) {
    if (!_camera || !_renderer) return null;
    const rect = _renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, _camera);
    const intersectables = [];
    if (_axesVisible && _axesGroup) {
      _axesGroup.children.forEach(c => { if (c.userData && c.userData.isAxesSphere) intersectables.push(c); });
    }
    if (_gridMode > 0 && _gridGroup) {
      _gridGroup.children.forEach(c => { if (c.userData && c.userData.isGridHandle && c.material.opacity > 0) intersectables.push(c); });
    }
    const hits = raycaster.intersectObjects(intersectables);
    return hits.length > 0 ? hits[0] : null;
  }

  function _onResize() {
    if (!_container || !_camera || !_renderer) return;
    const width = Math.max(1, _container.clientWidth);
    const height = Math.max(1, _container.clientHeight);
    _camera.aspect = width / height;
    _camera.updateProjectionMatrix();
    _renderer.setSize(width, height, false);
    if (_scene && _camera) _renderer.render(_scene, _camera);
  }

  function _syncGridRotation() {
    if (_gridGroup && _camera) {
      const camDir = new THREE.Vector3();
      _camera.getWorldDirection(camDir);
      _gridGroup.children.forEach(child => {
        if (child.userData.isGridHandle) {
          const dot = Math.abs(camDir.dot(child.userData.normal));
          const isParallel = dot > 0.939; // ~20 degrees
          child.userData.isParallel = isParallel;
          if (!isParallel) {
            child.material.opacity = 0;
          } else if (!child.userData.hovered) {
            child.material.opacity = 0.4;
            child.scale.setScalar(1.0);
          }
        }
      });
    }
    
    // Update scale bar
    const scaleBar = document.getElementById('viewer-scale-bar');
    if (scaleBar && _camera && _renderer) {
      if (_gridMode === 0) {
        scaleBar.classList.add('hidden');
      } else {
        scaleBar.classList.remove('hidden');
        const center = _controls ? _controls.target.clone() : new THREE.Vector3();
        const dist = _camera.position.distanceTo(center);
        const vFOV = THREE.MathUtils.degToRad(_camera.fov); 
        const heightAtCenter = 2 * Math.tan(vFOV / 2) * dist;
        const rect = _renderer.domElement.getBoundingClientRect();
        const pixelsPerUnit = rect.height / Math.max(0.001, heightAtCenter);
        // Base size is span * 1.5. Step size is (span * 1.5) / 10.
        const span = _clipSpan ? _clipSpan() : 100;
        const stepSize = (span * 1.5) / 10;
        const pixelLength = stepSize * pixelsPerUnit;
        scaleBar.style.width = `${Math.max(20, pixelLength)}px`;
        scaleBar.innerText = '200 µm';
      }
    }
  }

  function _animate() {
    requestAnimationFrame(_animate);
    if (_controls) _controls.update();
    _syncGridRotation();
    if (_renderer && _scene && _camera) _renderer.render(_scene, _camera);
  }

  async function loadData(basePath, metadata, onProgress) {
    _datasetMeta = metadata;
    
    const tracksPromise = _fetchJsonMaybeGzip(`${basePath}/tracks.json`);
    const modelPromise = _loadModel(basePath);

    _trackData = await tracksPromise;
    
    _normalizeCellFlags();
    _buildRegionColors();
    _initInstancedMesh();
    _measurements = MeasurementStore.list(_datasetMeta?.id || 'tracking', 'tracking');
    
    const gltf = await modelPromise;
    _attachModel(gltf);
  }

  async function _fetchJsonMaybeGzip(url) {
    if ('DecompressionStream' in window) {
      try {
        const gzResp = await fetch(`${url}.gz`);
        if (gzResp.ok && gzResp.body) {
          const stream = gzResp.body.pipeThrough(new DecompressionStream('gzip'));
          return await new Response(stream).json();
        }
      } catch (err) {
        console.warn('[TrackingViewer] Compressed JSON unavailable:', err);
      }
    }

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Could not load ${url}`);
    return await resp.json();
  }

  async function _loadModel(basePath) {
    const loader = new THREE.GLTFLoader();
    if ('DecompressionStream' in window) {
      try {
        const gzResp = await fetch(`${basePath}/model.glb.gz`);
        if (gzResp.ok && gzResp.body) {
          const stream = gzResp.body.pipeThrough(new DecompressionStream('gzip'));
          const arrayBuffer = await new Response(stream).arrayBuffer();
          return await new Promise((resolve, reject) => {
            loader.parse(arrayBuffer, `${basePath}/`, resolve, reject);
          });
        }
      } catch (err) {
        console.warn('[TrackingViewer] Compressed GLB unavailable:', err);
      }
    }

    return await new Promise((resolve, reject) => {
      loader.load(`${basePath}/model.glb`, resolve, undefined, reject);
    });
  }

  function _attachModel(gltf) {
    _glbScene = gltf.scene;

    const box = new THREE.Box3().setFromObject(_glbScene);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    _glbScene.position.x = -center.x;
    _glbScene.position.y = -center.y;
    _glbScene.position.z = -center.z;
    _initTrails();
    _indexSurfaceVariants();
    _surfaceGroup = new THREE.Group();
    _surfaceGroup.add(_glbScene);
    _scene.add(_surfaceGroup);

    const maxDim = Math.max(size.x, size.y, size.z);
    _camera.position.set(0, 0, maxDim * 1.15);
    _controls.target.set(0, 0, 0);
    _controls.update();

    _updateSurfaceVisibility();
    _updateSurfaceColor();
    _updateClipState();
    setTimepoint(_currentTime);
  }

  function _indexSurfaceVariants() {
    _surfaceVariants = { raw: [], stab: [] };
    _glbScene?.traverse((child) => {
      if (!child.isMesh) return;
      const info = _parseSurfaceVariantName(child.name || child.parent?.name || '');
      // Assign uniform material by default; _updateSurfaceColor will swap
      child.material = _surfaceMatUniform;
      child.visible = false;
      if (!info) return;
      child.userData.surfaceVariant = info;
      _surfaceVariants[info.space].push({ key: info.key, frameValue: info.frameValue, interpolated: info.interpolated, mesh: child });
    });
    ['raw', 'stab'].forEach(space => {
      _surfaceVariants[space].sort((a, b) => a.frameValue - b.frameValue);
    });
  }

  function _parseSurfaceVariantName(name = '') {
    const rawMatch = /raw_tp_(\d+)_(\d+)/i.exec(name);
    if (rawMatch) return _surfaceVariantInfo('raw', Number(rawMatch[1]), Number(rawMatch[2]), false);
    const rawInterpMatch = /raw_interp_tp_(\d+)_(\d+)/i.exec(name);
    if (rawInterpMatch) return _surfaceVariantInfo('raw', Number(rawInterpMatch[1]), Number(rawInterpMatch[2]), true);
    const stabMatch = /stab_tp_(\d+)_(\d+)/i.exec(name);
    if (stabMatch) return _surfaceVariantInfo('stab', Number(stabMatch[1]), Number(stabMatch[2]), false);
    const stabInterpMatch = /stab_interp_tp_(\d+)_(\d+)/i.exec(name);
    if (stabInterpMatch) return _surfaceVariantInfo('stab', Number(stabInterpMatch[1]), Number(stabInterpMatch[2]), true);
    return null;
  }

  function _surfaceVariantInfo(space, tp, frac, interpolated) {
    const frameValue = Math.max(0, (tp - 1) + (frac / 10));
    return {
      space,
      tp,
      frac,
      interpolated,
      frameValue,
      key: `${space}:${interpolated ? 'interp' : 'base'}:${tp}:${frac}`
    };
  }

  function _normalizeCellFlags() {
    if (!_trackData?.cells) return;
    Object.values(_trackData.cells).forEach(cell => {
      cell.is_mitosis = cell.is_mitosis || _hasValue(cell.daughters);
      cell.is_fusion = cell.is_fusion || false;
    });
  }

  function _hasValue(value) {
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== null && String(value).trim() !== '';
  }

  function _buildRegionColors() {
    let regions = new Set();
    Object.values(_trackData.cells).forEach(c => {
      if (c.region) regions.add(c.region);
    });
    let i = 0;
    regions.forEach(r => {
      _regionColorMap[r] = new THREE.Color(REGION_COLORS[i % REGION_COLORS.length]);
      _regionRevision++;   // ELE-29: invalidate the surface-color memo when the region palette (re)builds
      i++;
    });
  }

  function _initInstancedMesh() {
    if (_cellMesh) _scene.remove(_cellMesh);
    
    const cellEntries = Object.entries(_trackData.cells);
    const count = cellEntries.length;
    _cellIds = [];
    _cellIdToIndex = {};
    
    const geom = new THREE.SphereGeometry(6.5, 20, 20);
    const mat = new THREE.MeshPhongMaterial({ color: 0xffffff });
    mat.vertexColors = false;
    _cellMesh = new THREE.InstancedMesh(geom, mat, count);
    
    cellEntries.forEach(([id, cell], index) => {
      _cellIds.push(id);
      _cellIdToIndex[id] = index;
      
      const col = _regionColorMap[cell.region] || new THREE.Color(0xffffff);
      _cellMesh.setColorAt(index, col);
      
      // Hide initially by setting scale to 0
      const dummy = new THREE.Object3D();
      dummy.scale.set(0,0,0);
      dummy.updateMatrix();
      _cellMesh.setMatrixAt(index, dummy.matrix);
    });
    
    _cellMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    _scene.add(_cellMesh);
  }

  function _initTrails() {
    _trailLines.forEach(line => _scene.remove(line));
    _trailLines = [];

    // Basic lines for each track
    // (Could be optimized with a single BufferGeometry, but for 400 cells individual lines are okay)
    const mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 });
    const center = _glbScene ? _glbScene.position : new THREE.Vector3();
    
    Object.values(_trackData.cells).forEach(cell => {
      const posMap = _filters.stabilized ? cell.positions : (cell.raw_positions || cell.positions);
      const points = [];
      const times = Object.keys(posMap).map(Number).sort((a,b)=>a-b);
      
      times.forEach(t => {
        const p = posMap[t];
        points.push(new THREE.Vector3(p[0] + center.x, p[1] + center.y, p[2] + center.z));
      });
      
      if (points.length > 1) {
        const geom = new THREE.BufferGeometry().setFromPoints(points);
        geom.setDrawRange(0, 0);
        const line = new THREE.Line(geom, mat.clone());
        if (cell.region && _regionColorMap[cell.region]) {
          line.material.color.copy(_regionColorMap[cell.region]);
        }
        line.userData = { cellId: cell.id, times: times, pointCount: points.length };
        _scene.add(line);
        _trailLines.push(line);
      }
    });
  }

  function _getPos(cell, tStr) {
    const p = _filters.stabilized ? cell.positions : (cell.raw_positions || cell.positions);
    return p[tStr];
  }

  function _surfaceFrameValue(frame = _currentTime) {
    const clamped = Math.max(0, Number.isFinite(frame) ? frame : 0);
    if (_smoothing <= 0) return Math.round(clamped);
    return Math.round(clamped * 10) / 10;
  }

  function _visibleSurfaceSpace() {
    return _filters.stabilized ? 'stab' : 'raw';
  }

  function _currentSurfaceEntries() {
    const space = _visibleSurfaceSpace();
    const entries = _surfaceVariants[space] || [];
    if (!entries.length) return [];
    
    // Only use interpolated meshes if the smooth/extrapolated slider is active
    const wantsInterp = _smoothing > 0;
    const validEntries = entries.filter(e => e.interpolated === wantsInterp);
    const searchEntries = validEntries.length > 0 ? validEntries : entries;

    const target = _surfaceFrameValue(_currentTime);
    let bestDistance = Infinity;
    let best = [];
    searchEntries.forEach(entry => {
      const distance = Math.abs(entry.frameValue - target);
      if (distance + 1e-6 < bestDistance) {
        bestDistance = distance;
        best = [entry];
        return;
      }
      if (Math.abs(distance - bestDistance) < 1e-6) best.push(entry);
    });
    return best;
  }

  function _visibleSurfaceMeshes() {
    return _currentSurfaceEntries().map(entry => entry.mesh).filter(Boolean);
  }

  function _updateSurfaceVisibility() {
    const active = new Set(_visibleSurfaceMeshes().map(mesh => mesh.uuid));
    _glbScene?.traverse((child) => {
      if (!child.isMesh || !child.userData.surfaceVariant) return;
      child.visible = active.has(child.uuid);
    });
    
    if (_gridGroup) {
      _gridGroup.traverse(child => {
         if (child.isMesh && child.userData.isProjSurface) {
            // Find the corresponding original mesh uuid
            // Since variants are unique by 'key' or properties, we can match by variant info
            const varInfo = child.userData.surfaceVariant;
            // The active set has UUIDs of the original meshes.
            // We can just find if any active mesh matches the variant info exactly!
            const isVisible = _visibleSurfaceMeshes().some(m => 
              m.userData.surfaceVariant.space === varInfo.space &&
              m.userData.surfaceVariant.frameValue === varInfo.frameValue &&
              m.userData.surfaceVariant.interpolated === varInfo.interpolated
            );
            child.visible = isVisible;
         }
      });
    }
  }

  function setTimepoint(t) {
    _currentTime = t;
    if (!_trackData || !_cellMesh) return;
    
    const dataTime = _frameToDataTime(t);
    const t0 = Math.floor(dataTime);
    const t1 = Math.ceil(dataTime);
    const alpha = dataTime - t0;
    
    const dummy = new THREE.Object3D();
    const hiddenScale = new THREE.Vector3(0,0,0);
    const normalScale = new THREE.Vector3(1.0,1.0,1.0);
    const selectedScale = new THREE.Vector3(1.8,1.8,1.8);
    
    // Offset to center (same as GLB)
    const center = _glbScene ? _glbScene.position : new THREE.Vector3();
    
    Object.entries(_trackData.cells).forEach(([id, cell]) => {
      const idx = _cellIdToIndex[id];
      const p0 = _getPos(cell, t0);
      const p1 = _getPos(cell, t1);
      
      let visible = false;
      let x, y, z;
      
      if (p0 && p1) {
        x = p0[0] + (p1[0] - p0[0]) * alpha;
        y = p0[1] + (p1[1] - p0[1]) * alpha;
        z = p0[2] + (p1[2] - p0[2]) * alpha;
        visible = true;
      } else if (p0 && alpha < 0.5) {
        x = p0[0]; y = p0[1]; z = p0[2];
        visible = true;
      } else if (p1 && alpha >= 0.5) {
        x = p1[0]; y = p1[1]; z = p1[2];
        visible = true;
      }
      
      // Apply filters
      if (visible) {
        if (!_filters.mitosis && cell.is_mitosis) visible = false;
        if (!_filters.fusion && cell.is_fusion) visible = false;
      }
      
      if (visible) {
        dummy.position.set(x + center.x, y + center.y, z + center.z);
        const s = (String(id) === String(_selectedCellId) ? 1.8 : 1.0) * _pointScale;
        dummy.scale.set(s, s, s);
      } else {
        dummy.position.set(0,0,0);
        dummy.scale.set(0,0,0);
      }
      
      dummy.updateMatrix();
      _cellMesh.setMatrixAt(idx, dummy.matrix);
    });
    
    _cellMesh.instanceMatrix.needsUpdate = true;
    _updateSurfaceVisibility();
    _updateClipState();
    
    // Update trails — draw progressively up to the current time
    _trailLines.forEach(line => {
      const times = line.userData.times || [];
      const minT = times[0];
      const maxT = times[times.length - 1];
      if (!times.length || dataTime < minT) {
        line.material.opacity = 0;
        line.visible = false;
        line.geometry.setDrawRange(0, 0);
        return;
      }
      // Count how many points have a time <= current time
      let visiblePoints = 0;
      for (let i = 0; i < times.length; i++) {
        if (times[i] <= dataTime + 0.5) visiblePoints++;
        else break;
      }
      visiblePoints = Math.max(1, visiblePoints);
      const drawCount = Math.min(line.userData.pointCount || visiblePoints, Math.max(2, visiblePoints));
      line.geometry.setDrawRange(0, drawCount);
      // Active cell trails are brighter, past trails are dim
      if (dataTime >= minT && dataTime <= maxT + 0.5) {
        line.material.opacity = 0.38;
      } else if (dataTime > maxT + 0.5) {
        line.material.opacity = 0.06;
      }
      line.visible = drawCount >= 2 && line.material.opacity > 0.01;
    });
    _updateVelocityField();
    _updateNeighborNetwork();
    _updateSurfaceColor();
    _updateMeasurementVisuals();
    _notifyMeasureChange();
  }

  function _frameToDataTime(frame) {
    const times = (_trackData?.timepoints || []).map(Number).sort((a, b) => a - b);
    if (!times.length) return frame;

    const maxIndex = times.length - 1;
    const clamped = Math.max(0, Math.min(maxIndex, frame));
    const i0 = Math.floor(clamped);
    const i1 = Math.ceil(clamped);
    if (i0 === i1) return times[i0];

    const alpha = clamped - i0;
    return times[i0] + (times[i1] - times[i0]) * alpha;
  }

  function setFilter(key, val) {
    _filters[key] = val;
    if (key === 'stabilized') {
      // Trails need to be rebuilt or updated
      _trailLines.forEach(l => _scene.remove(l));
      _trailLines = [];
      _initTrails();
    }
    setTimepoint(_currentTime);
    _updateSurfaceVisibility();
    _surfaceColorSig = null;   // ELE-29: filter change -> force recompute
    _updateSurfaceColor();
  }

  function setSurfaceOpacity(val) {
    _surfaceOpts.opacity = val;
    if (_glbScene) {
      _glbScene.traverse((child) => {
        if (child.isMesh && child.material) {
          child.material.opacity = val;
          child.material.transparent = val < 0.999;
          child.material.depthWrite = val >= 0.999;
        }
      });
    }
    // Also sync the two shared materials
    if (_surfaceMatUniform) {
      _surfaceMatUniform.opacity = val;
      _surfaceMatUniform.transparent = val < 0.999;
      _surfaceMatUniform.depthWrite = val >= 0.999;
    }
    if (_surfaceMatDensity) {
      _surfaceMatDensity.opacity = val;
      _surfaceMatDensity.transparent = val < 0.999;
      _surfaceMatDensity.depthWrite = val >= 0.999;
    }
  }

  function setSurfaceColorMode(mode) {
    _surfaceOpts.colorMode = ['uniform', 'density', 'region'].includes(mode) ? mode : 'uniform';
    _surfaceColorSig = null;   // ELE-29: color mode changed -> force recompute
    _updateSurfaceColor();
  }

  function _makeSurfaceMaterial(color) {
    // Legacy helper – used only for non-surface meshes if any remain
    return new THREE.MeshBasicMaterial({
      color,
      transparent: _surfaceOpts.opacity < 0.999,
      opacity: _surfaceOpts.opacity,
      side: THREE.DoubleSide,
      depthWrite: _surfaceOpts.opacity >= 0.999,
    });
  }

  function _updateSurfaceColor() {
    if (!_glbScene) return;

    // ELE-29: skip the O(vertices x cells) recompute when no surface-coloring input
    // changed. Key = mode + quantized surface frame (same granularity as
    // _visibleSurfaceMeshes) + smoothing + filters + neighbor threshold + region
    // palette revision. Set _surfaceColorSig = null elsewhere to force a recompute.
    const _sig = [
      _surfaceOpts.colorMode,
      _surfaceFrameValue(_currentTime),
      _smoothing,
      _filters.mitosis, _filters.fusion, _filters.stabilized,
      _neighborThreshold,
      _regionRevision
    ].join('|');
    if (_sig === _surfaceColorSig) return;
    _surfaceColorSig = _sig;

    _scene.updateMatrixWorld(true);
    
    const mode = _surfaceOpts.colorMode;
    const visibleMeshes = _visibleSurfaceMeshes();
    const cellRows = (mode === 'region')
      ? _surfaceCellRows()
      : [];
    
    // Build density payload only when needed
    let densityPayload = { rows: [], stats: _globalDensityStats };
    if (mode === 'density') {
      // Check if GLB has pre-baked _DENSITY attribute first
      const hasBakedDensity = visibleMeshes.some(m => _getDensityAttribute(m) != null);
      if (!hasBakedDensity) {
        // Fall back to dynamic computation from cell positions
        densityPayload = _computeVisibleMeshDensity(visibleMeshes, _surfaceCellRows());
      }
    }
    _surfaceLegendState = _legendStateForMode(mode, densityPayload.stats);
    
    _glbScene.traverse((child) => {
      if (!child.isMesh) return;
      if (!child.visible) return;

      if (mode === 'uniform') {
        child.material = _surfaceMatUniform;
        return;
      }

      if (mode === 'density') {
        // Try pre-baked _DENSITY attribute (ImarisViewer pattern)
        const densityAttr = _getDensityAttribute(child);
        if (densityAttr) {
          _precomputeDensityColors(child, densityAttr);
          child.material = _surfaceMatDensity;
        } else {
          // Dynamic density from cell positions
          const row = densityPayload.rows.find(e => e.uuid === child.uuid);
          if (row && row.values.length > 0) {
            const colors = _densityColorArray(row.values, densityPayload.stats);
            const smoothed = _smoothVertexColors(child, colors);
            child.geometry.setAttribute('color', new THREE.BufferAttribute(smoothed, 3));
            child.geometry.attributes.color.needsUpdate = true;
            child.material = _surfaceMatDensity;
          } else {
            child.material = _surfaceMatUniform;
          }
        }
        return;
      }

      if (mode === 'region') {
        const regionColors = _computeRegionVertexColors(child, cellRows);
        if (regionColors && regionColors.length > 0) {
          const smoothed = _smoothVertexColors(child, regionColors);
          child.geometry.setAttribute('color', new THREE.BufferAttribute(smoothed, 3));
          child.geometry.attributes.color.needsUpdate = true;
          child.material = _surfaceMatDensity; // uses vertex colors
        } else {
          child.material = _surfaceMatUniform;
        }
      }
    });
  }

  /** Find a pre-baked density attribute in the GLB geometry (ImarisViewer compat) */
  function _getDensityAttribute(mesh) {
    const attrs = mesh.geometry?.attributes || {};
    if (attrs._DENSITY) return attrs._DENSITY;
    if (attrs._density) return attrs._density;
    if (attrs.density) return attrs.density;
    // Fallback: look for any single-component custom attribute
    const posCount = attrs.position ? attrs.position.count : null;
    for (const [name, attr] of Object.entries(attrs)) {
      if (!attr || typeof attr.count !== 'number') continue;
      if (['position', 'normal', 'uv', 'uv2', 'color'].includes(name)) continue;
      if (posCount != null && attr.count === posCount && attr.itemSize === 1) {
        return attr;
      }
    }
    return null;
  }

  /** Convert pre-baked density values into Inferno vertex colors */
  function _precomputeDensityColors(mesh, densityAttr) {
    const arr = densityAttr.array;
    const count = densityAttr.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const raw = arr[i];
      const normalized = raw > 1 ? raw / 255 : raw;
      const t = Math.max(0, Math.min(1, normalized));
      const c = _densityColor(t);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    mesh.geometry.attributes.color.needsUpdate = true;
  }

  /**
   * Laplacian smooth on vertex colors using mesh adjacency.
   * Averages each vertex's color with its neighbors over a few iterations
   * to soften harsh triangle-to-triangle color transitions.
   */
  function _smoothVertexColors(mesh, colors, iterations = 2, blend = 0.5) {
    const geo = mesh.geometry;
    const posAttr = geo?.attributes?.position;
    if (!posAttr || !colors || colors.length === 0) return colors;
    const count = posAttr.count;
    if (colors.length !== count * 3) return colors;

    // Build adjacency from triangles
    const adj = new Array(count);
    for (let i = 0; i < count; i++) adj[i] = [];
    const indexAttr = geo.index;
    if (indexAttr) {
      const indices = indexAttr.array;
      for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t], b = indices[t + 1], c = indices[t + 2];
        adj[a].push(b, c);
        adj[b].push(a, c);
        adj[c].push(a, b);
      }
    } else {
      for (let t = 0; t < count; t += 3) {
        const a = t, b = t + 1, c = t + 2;
        if (c >= count) break;
        adj[a].push(b, c);
        adj[b].push(a, c);
        adj[c].push(a, b);
      }
    }
    // Deduplicate adjacency
    for (let i = 0; i < count; i++) adj[i] = [...new Set(adj[i])];

    let current = new Float32Array(colors);
    for (let it = 0; it < iterations; it++) {
      const next = new Float32Array(current);
      for (let i = 0; i < count; i++) {
        const neighbors = adj[i];
        if (neighbors.length === 0) continue;
        let sr = current[i * 3], sg = current[i * 3 + 1], sb = current[i * 3 + 2];
        let n = 1;
        for (const nb of neighbors) {
          sr += current[nb * 3];
          sg += current[nb * 3 + 1];
          sb += current[nb * 3 + 2];
          n++;
        }
        sr /= n; sg /= n; sb /= n;
        next[i * 3]     = current[i * 3]     * (1 - blend) + sr * blend;
        next[i * 3 + 1] = current[i * 3 + 1] * (1 - blend) + sg * blend;
        next[i * 3 + 2] = current[i * 3 + 2] * (1 - blend) + sb * blend;
      }
      current = next;
    }
    return current;
  }

  function _surfaceCellRows() {
    if (!_trackData?.cells) return [];
    const center = _glbScene ? _glbScene.position : new THREE.Vector3();
    const dataTime = _frameToDataTime(_currentTime);
    const t0 = Math.floor(dataTime);
    const t1 = Math.ceil(dataTime);
    const alpha = dataTime - t0;
    return Object.entries(_trackData.cells)
      .map(([id, cell]) => {
        // Use the SAME visibility logic as setTimepoint to avoid ghost cells
        const p0 = _getPos(cell, t0);
        const p1 = _getPos(cell, t1);
        let x, y, z;
        if (p0 && p1) {
          x = p0[0] + (p1[0] - p0[0]) * alpha;
          y = p0[1] + (p1[1] - p0[1]) * alpha;
          z = p0[2] + (p1[2] - p0[2]) * alpha;
        } else if (p0 && alpha < 0.5) {
          x = p0[0]; y = p0[1]; z = p0[2];
        } else if (p1 && alpha >= 0.5) {
          x = p1[0]; y = p1[1]; z = p1[2];
        } else {
          return null; // Cell not visible — do NOT include in surface computation
        }
        // Apply filters (same as setTimepoint)
        if (!_filters.mitosis && cell.is_mitosis) return null;
        if (!_filters.fusion && cell.is_fusion) return null;
        return {
          id,
          region: cell.region || 'Unknown',
          position: new THREE.Vector3(x + center.x, y + center.y, z + center.z)
        };
      })
      .filter(Boolean);
  }

  let _globalDensityStats = { min: 0, max: 20, p10: 0, p90: 10 };

  function _computeVisibleMeshDensity(meshes, cellRows) {
    if (!meshes.length || !cellRows.length) return { rows: [], stats: _globalDensityStats };
    const sigma = Math.max(8, Math.min(54, _neighborThreshold * 0.52));
    const radius = Math.max(18, sigma * 2.8);
    const radiusSq = radius * radius;
    const vector = new THREE.Vector3();
    const rows = meshes.map(mesh => {
      const attr = mesh.geometry?.attributes?.position;
      if (!attr) return { uuid: mesh.uuid, values: [] };
      const values = new Array(attr.count);
      for (let i = 0; i < attr.count; i++) {
        vector.fromBufferAttribute(attr, i).applyMatrix4(mesh.matrixWorld);
        let density = 0;
        for (const cell of cellRows) {
          const dSq = vector.distanceToSquared(cell.position);
          if (dSq > radiusSq) continue;
          density += Math.exp(-dSq / (2 * sigma * sigma));
        }
        values[i] = density;
      }
      return { uuid: mesh.uuid, values };
    });
    return { rows, stats: _globalDensityStats };
  }

  function _computeRegionVertexColors(mesh, cellRows) {
    const attr = mesh.geometry?.attributes?.position;
    if (!attr || !cellRows.length) return null;
    const colors = new Float32Array(attr.count * 3);
    const vector = new THREE.Vector3();
    for (let i = 0; i < attr.count; i++) {
      vector.fromBufferAttribute(attr, i).applyMatrix4(mesh.matrixWorld);
      let nearest = null;
      let best = Infinity;
      for (const cell of cellRows) {
        const dSq = vector.distanceToSquared(cell.position);
        if (dSq < best) {
          best = dSq;
          nearest = cell;
        }
      }
      const color = nearest?.region && _regionColorMap[nearest.region]
        ? _regionColorMap[nearest.region]
        : new THREE.Color(0x9aa4b3);
      colors[i * 3] = color.r;
      colors[(i * 3) + 1] = color.g;
      colors[(i * 3) + 2] = color.b;
    }
    return colors;
  }

  function _densityColorArray(values = [], stats = null) {
    const colors = new Float32Array(values.length * 3);
    values.forEach((value, index) => {
      const color = _densityColor(_normalizeDensity(value, stats));
      colors[index * 3] = color.r;
      colors[(index * 3) + 1] = color.g;
      colors[(index * 3) + 2] = color.b;
    });
    return colors;
  }

  function _applyVertexColors(mesh, colors) {
    if (!mesh?.geometry || !colors?.length) {
      // No colors to apply — ensure material stays in non-vertex-color mode
      if (mesh?.material) {
        mesh.material.vertexColors = false;
        mesh.material.color.setHex(0xaaaaaa);
        mesh.material.needsUpdate = true;
      }
      return;
    }
    mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    mesh.geometry.attributes.color.needsUpdate = true;
    mesh.material.vertexColors = true;
    mesh.material.color.setHex(0xffffff);
    // CRITICAL: must trigger shader recompile after toggling vertexColors
    mesh.material.needsUpdate = true;
  }

  function _densityStats(values = []) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const p10 = sorted[Math.floor((sorted.length - 1) * 0.1)];
    const p90 = sorted[Math.floor((sorted.length - 1) * 0.9)];
    return { min, max, p10, p90 };
  }

  function _normalizeDensity(value, stats) {
    if (!stats) return 0;
    const low = Number.isFinite(stats.p10) ? stats.p10 : stats.min;
    const high = Number.isFinite(stats.p90) ? stats.p90 : stats.max;
    if (high <= low) return 0;
    return Math.max(0, Math.min(1, (value - low) / (high - low)));
  }

  function _densityColor(t) {
    const stops = COLOR_MAPS[_activeColormap].map(c => new THREE.Color(c));
    const clamped = Math.max(0, Math.min(1, t));
    const scaled = clamped * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(scaled));
    const alpha = scaled - i;
    return stops[i].clone().lerp(stops[i + 1], alpha);
  }

  function _legendStateForMode(mode, densityStats) {
    if (mode === 'density') {
      return {
        kind: 'density',
        title: 'Local Cell Density',
        unit: 'relative',
        min: densityStats?.p10 ?? densityStats?.min ?? 0,
        max: densityStats?.p90 ?? densityStats?.max ?? 1,
        stops: COLOR_MAPS[_activeColormap]
      };
    }
    if (mode === 'region') {
      return {
        kind: 'region',
        title: 'Region Colors',
        items: Object.entries(_regionColorMap).map(([name, color]) => ({
          label: name,
          color: `#${color.getHexString()}`
        }))
      };
    }
    return { kind: 'uniform', title: 'Uniform Surface', items: [{ label: 'Embryo surface', color: '#aaaaaa' }] };
  }

  function _activeClipPlanes() {
    if (!_meshClipSpec.enabled) return [];
    return [_buildClipPlane()];
  }

  function _buildClipPlane() {
    const normal = _clipNormal(_meshClipSpec);
    const point = normal.clone().multiplyScalar((_meshClipSpec.value - 0.5) * _clipSpan());
    return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point).normalize();
  }

  function _clipSpan() {
    const box = new THREE.Box3().setFromObject(_glbScene || _surfaceGroup || _scene);
    const size = box.getSize(new THREE.Vector3());
    return Math.max(size.x, size.y, size.z, 1);
  }

  function _clipNormal(spec = _meshClipSpec) {
    if (spec.mode === 'yz') return new THREE.Vector3(1, 0, 0);
    if (spec.mode === 'xz') return new THREE.Vector3(0, 1, 0);
    if (spec.mode === 'oblique') {
      const yaw = THREE.MathUtils.degToRad(Number(spec.yaw) || 0);
      const pitch = THREE.MathUtils.degToRad(Number(spec.pitch) || 0);
      return new THREE.Vector3(
        Math.cos(pitch) * Math.sin(yaw),
        Math.sin(pitch),
        Math.cos(pitch) * Math.cos(yaw)
      ).normalize();
    }
    return new THREE.Vector3(0, 0, 1);
  }

  function _updateClipState() {
    const planes = _activeClipPlanes();
    _glbScene?.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      child.material.clippingPlanes = planes;
      child.material.needsUpdate = true;
    });
    if (_cellMesh?.material) {
      _cellMesh.material.clippingPlanes = planes;
      _cellMesh.material.needsUpdate = true;
    }
    _trailLines.forEach(line => {
      if (!line.material) return;
      line.material.clippingPlanes = planes;
      line.material.needsUpdate = true;
    });
    _neighborGroup?.children?.forEach(line => {
      if (line.material) {
        line.material.clippingPlanes = planes;
        line.material.needsUpdate = true;
      }
    });
    _updateClipHelper();
    _updateClipCap();
  }

  function _updateClipHelper() {
    if (_clipPlaneHelper) {
      _scene.remove(_clipPlaneHelper);
      _clipPlaneHelper.geometry?.dispose?.();
      _clipPlaneHelper.material?.dispose?.();
      _clipPlaneHelper = null;
    }
    if (!_meshClipSpec.enabled || !_glbScene) return;
    const span = _clipSpan() * 1.15;
    _clipPlaneHelper = new THREE.Mesh(
      new THREE.PlaneGeometry(span, span),
      new THREE.MeshBasicMaterial({
        color: _meshClipSpec.color,
        transparent: true,
        opacity: _meshClipSpec.opacity,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    );
    const normal = _clipNormal(_meshClipSpec);
    _clipPlaneHelper.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    _clipPlaneHelper.position.copy(normal.clone().multiplyScalar((_meshClipSpec.value - 0.5) * _clipSpan()));
    _clipPlaneHelper.renderOrder = 18;
    _scene.add(_clipPlaneHelper);
  }

  function _clipCapSignature(meshes) {
    if (!_meshClipSpec.enabled || !_glbScene) return 'disabled';
    const s = _meshClipSpec;
    const variantKeys = meshes
      .map(m => m.userData?.surfaceVariant?.key ?? m.uuid)
      .sort()
      .join(',');
    // _clipSpan reflects the scene bbox; it feeds _buildClipPlane's coplanar point,
    // so a span change (e.g. model re-attach) must invalidate the cap.
    return [s.enabled, s.mode, s.value, s.yaw, s.pitch, s.color, s.opacity, _clipSpan(), variantKeys].join('|');
  }

  function _updateClipCap() {
    if (!_clipCapGroup) return;
    if (!_meshClipSpec.enabled || !_glbScene) {
      // Teardown: free the cap and force a rebuild on re-enable.
      if (_clipCapKey !== 'disabled') { _clearGroup(_clipCapGroup); _clipCapKey = 'disabled'; }
      return;
    }
    const meshes = _visibleSurfaceMeshes();
    const signature = _clipCapSignature(meshes);
    // Cache hit: plane + visible surface-mesh set unchanged -> existing cap is correct.
    if (signature === _clipCapKey && _clipCapGroup.children.length) return;
    _clearGroup(_clipCapGroup);
    _clipCapKey = signature;
    if (!meshes.length) return;
    const plane = _buildClipPlane();
    const segments = [];
    meshes.forEach(mesh => _collectPlaneSegments(mesh, plane, segments));
    if (segments.length < 3) return;

    const origin = plane.coplanarPoint(new THREE.Vector3());
    const normal = plane.normal.clone().normalize();
    const helper = Math.abs(normal.y) > 0.8 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const right = helper.clone().cross(normal).normalize();
    const up = normal.clone().cross(right).normalize();
    const points2d = segments.map(point => ({
      x: point.clone().sub(origin).dot(right),
      y: point.clone().sub(origin).dot(up)
    }));
    const hull = _convexHull(points2d);
    if (hull.length < 3) return;

    const shape = new THREE.Shape();
    shape.moveTo(hull[0].x, hull[0].y);
    for (let i = 1; i < hull.length; i++) shape.lineTo(hull[i].x, hull[i].y);
    shape.closePath();

    const capMaterial = new THREE.MeshBasicMaterial({
      color: _meshClipSpec.color,
      transparent: true,
      opacity: Math.min(0.96, Math.max(0.28, _meshClipSpec.opacity + 0.32)),
      side: THREE.DoubleSide,
      depthWrite: true
    });
    const capMesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), capMaterial);
    capMesh.position.copy(origin);
    capMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    capMesh.renderOrder = 19;
    _clipCapGroup.add(capMesh);

    const loopPoints = hull.map(({ x, y }) => new THREE.Vector3(x, y, 0));
    loopPoints.push(loopPoints[0].clone());
    const edgeMaterial = new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.95, linewidth: 2 });
    const edge = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(loopPoints),
      edgeMaterial
    );
    edge.position.copy(origin);
    edge.quaternion.copy(capMesh.quaternion);
    edge.renderOrder = 20;
    _clipCapGroup.add(edge);
  }

  function _collectPlaneSegments(mesh, plane, out) {
    const geometry = mesh.geometry;
    const position = geometry?.attributes?.position;
    if (!position) return;
    const index = geometry.index;
    const matrix = mesh.matrixWorld;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const points = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const distances = [0, 0, 0];
    const epsilon = 1e-4;
    const readIndex = (triIndex, corner) => index ? index.array[triIndex * 3 + corner] : triIndex * 3 + corner;
    const triCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3);

    for (let tri = 0; tri < triCount; tri++) {
      a.fromBufferAttribute(position, readIndex(tri, 0)).applyMatrix4(matrix);
      b.fromBufferAttribute(position, readIndex(tri, 1)).applyMatrix4(matrix);
      c.fromBufferAttribute(position, readIndex(tri, 2)).applyMatrix4(matrix);
      points[0].copy(a); points[1].copy(b); points[2].copy(c);
      distances[0] = plane.distanceToPoint(a);
      distances[1] = plane.distanceToPoint(b);
      distances[2] = plane.distanceToPoint(c);
      const hits = [];
      _trianglePlaneEdge(points[0], points[1], distances[0], distances[1], epsilon, hits);
      _trianglePlaneEdge(points[1], points[2], distances[1], distances[2], epsilon, hits);
      _trianglePlaneEdge(points[2], points[0], distances[2], distances[0], epsilon, hits);
      if (hits.length >= 2) {
        out.push(hits[0], hits[1]);
      }
    }
  }

  function _trianglePlaneEdge(a, b, da, db, epsilon, hits) {
    if (Math.abs(da) <= epsilon && Math.abs(db) <= epsilon) {
      hits.push(a.clone(), b.clone());
      return;
    }
    if ((da > epsilon && db > epsilon) || (da < -epsilon && db < -epsilon)) return;
    if (Math.abs(da - db) <= epsilon) return;
    const t = da / (da - db);
    if (t < -epsilon || t > 1 + epsilon) return;
    hits.push(a.clone().lerp(b, THREE.MathUtils.clamp(t, 0, 1)));
  }

  function _convexHull(points) {
    const unique = [];
    const seen = new Set();
    points.forEach(point => {
      const key = `${point.x.toFixed(3)}|${point.y.toFixed(3)}`;
      if (seen.has(key)) return;
      seen.add(key);
      unique.push(point);
    });
    unique.sort((p, q) => p.x === q.x ? p.y - q.y : p.x - q.x);
    if (unique.length < 3) return unique;

    const cross = (o, a, b) => ((a.x - o.x) * (b.y - o.y)) - ((a.y - o.y) * (b.x - o.x));
    const lower = [];
    unique.forEach(point => {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
      lower.push(point);
    });
    const upper = [];
    for (let i = unique.length - 1; i >= 0; i--) {
      const point = unique[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
      upper.push(point);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  function setSmoothing(val) {
    _smoothing = val;
    _surfaceColorSig = null;   // ELE-29: smoothing change -> force recompute
    _updateSurfaceVisibility();
    _updateSurfaceColor();
  }

  function centerSample() {
    if (!_camera || !_controls) return;
    const target = new THREE.Vector3(0, 0, 0);
    const delta = target.clone().sub(_controls.target);
    _camera.position.add(delta);
    _controls.target.copy(target);
    _controls.update();
    _notifyCameraChange();
  }

  function setBackgroundPreset(preset = 'dark', customColor = '#1a1d27') {
    const resolved = typeof DisplayPresets !== 'undefined'
      ? DisplayPresets.resolve(preset, customColor)
      : { id: 'dark', color: '#1a1d27', transparent: false };
    _displayState = {
      backgroundPreset: resolved.id,
      backgroundColor: resolved.color
    };
    if (!_renderer || !_scene) return;
    if (resolved.transparent) {
      _scene.background = null;
      _renderer.setClearColor(0x000000, 0);
    } else {
      _scene.background = new THREE.Color(resolved.color);
      _renderer.setClearColor(resolved.color, 1);
    }
  }

  function findCell(trackId) {
    if (!_trackData?.cells) return null;
    const entry = Object.entries(_trackData.cells).find(([id, c]) => c.track_id == trackId || c.id == trackId || id == trackId);
    const cell = entry?.[1] || null;
    if (cell) {
      selectCell(entry[0]);
      return cell;
    }
    return null;
  }

  function _handleCellClick(event) {
    if (!_raycaster || !_pointer || !_camera) return;
    const rect = _renderer.domElement.getBoundingClientRect();
    _pointer.x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    _pointer.y = -(((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
    _raycaster.setFromCamera(_pointer, _camera);

    if (_axesVisible && _axesGroup && event.shiftKey) {
      _moveAxesToScreenPoint(event.clientX, event.clientY);
    }

    if (!_cellMesh) return;
    const targets = [_cellMesh];
    if (_gridGroup) {
      _gridGroup.traverse(c => {
         if (c.isInstancedMesh && c.parent?.userData?.isProjGroup) {
            targets.push(c);
         }
      });
    }
    const hits = _raycaster.intersectObjects(targets, false);
    const hit = hits.find(item => item.instanceId !== undefined);
    if (!hit) return;
    const cellId = _cellIds[hit.instanceId];
    if (_activeTool === 'measure') {
      _addMeasureCell(cellId);
      return;
    }
    selectCell(cellId);
  }

  function _addMeasureCell(cellId) {
    if (!cellId) return;
    if (_measureDraft.length >= 2 || _measureDraft.includes(String(cellId))) {
      _measureDraft = [];
    }
    _measureDraft.push(String(cellId));
    if (_measureDraft.length === 2) {
      _createMeasurementFromDraft();
    }
    _updateMeasurementVisuals();
    _notifyMeasureChange();
  }

  function clearMeasurement() {
    _measureDraft = [];
    _measurements = [];
    _syncMeasurementStore();
    _updateMeasurementVisuals();
    _notifyMeasureChange();
  }

  function getMeasurement() {
    const draftCells = _measureDraft
      .map(id => ({ id, cell: _trackData?.cells?.[id] || null, position: _cellPositionAtTime(id, _currentTime) }))
      .filter(row => row.cell && row.position);
    const payload = {
      mode: _measurementMode,
      draft: {
        cells: draftCells,
        distance: draftCells.length === 2 ? _distance(draftCells[0].position, draftCells[1].position) : null,
        timepoint: _currentTime
      },
      measurements: _measurements.map(row => _resolveMeasurementRow(row))
    };
    return payload;
  }

  function _createMeasurementFromDraft() {
    if (_measureDraft.length !== 2) return null;
    const a = _cellPositionAtTime(_measureDraft[0], _currentTime);
    const b = _cellPositionAtTime(_measureDraft[1], _currentTime);
    if (!a || !b) return null;
    const measurement = MeasurementStore.add(_datasetMeta?.id || 'tracking', 'tracking', {
      scope: 'tracking',
      datasetId: _datasetMeta?.id || 'tracking',
      label: `Track ${_measurements.length + 1}`,
      mode: _measurementMode,
      unit: 'units',
      timepoint: _currentTime,
      distance: _distance(a, b),
      cells: [_measureDraft[0], _measureDraft[1]],
      points: [a, b],
      metadata: {
        status: 'ok'
      }
    });
    _measurements.push(measurement);
    _measureDraft = [];
    _syncMeasurementStore();
    return measurement;
  }

  function _resolveMeasurementRow(row) {
    const base = {
      ...row,
      status: row.status || 'ok',
      distance: row.distance ?? null,
      points: Array.isArray(row.points) ? row.points : [],
      cells: Array.isArray(row.cells) ? row.cells : []
    };
    if (row.mode !== 'follow-cells') return base;
    const a = _cellPositionAtTime(row.cells?.[0], _currentTime);
    const b = _cellPositionAtTime(row.cells?.[1], _currentTime);
    if (!a || !b) {
      return {
        ...base,
        status: 'out-of-frame',
        distance: null,
        points: []
      };
    }
    return {
      ...base,
      status: 'ok',
      distance: _distance(a, b),
      points: [a, b],
      timepoint: _currentTime
    };
  }

  function _cellPositionAtTime(cellId, frame = _currentTime) {
    const cell = _trackData?.cells?.[cellId];
    if (!cell) return null;
    const dataTime = _frameToDataTime(frame);
    const t0 = Math.floor(dataTime);
    const t1 = Math.ceil(dataTime);
    const alpha = dataTime - t0;
    const p0 = _getPos(cell, t0);
    const p1 = _getPos(cell, t1);
    if (p0 && p1) {
      return [
        p0[0] + (p1[0] - p0[0]) * alpha,
        p0[1] + (p1[1] - p0[1]) * alpha,
        p0[2] + (p1[2] - p0[2]) * alpha
      ];
    }
    return p0 || p1 || null;
  }

  function _distance(a = [], b = []) {
    const dx = (a[0] || 0) - (b[0] || 0);
    const dy = (a[1] || 0) - (b[1] || 0);
    const dz = (a[2] || 0) - (b[2] || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function _notifyMeasureChange() {
    if (_onMeasureChange) _onMeasureChange(getMeasurement());
  }

  function _updateMeasurementVisuals() {
    if (!_measurementGroup) return;
    _clearGroup(_measurementGroup);
    const center = _glbScene ? _glbScene.position : new THREE.Vector3();
    _measurements.forEach(row => {
      if (row.visible === false) return;
      const resolved = _resolveMeasurementRow(row);
      if (resolved.points?.length !== 2) return;
      _measurementGroup.add(_measurementLine(resolved.points[0], resolved.points[1], center, row.color || '#ff4d4f'));
    });
    if (_measureDraft.length === 1) {
      const point = _cellPositionAtTime(_measureDraft[0], _currentTime);
      if (point) _measurementGroup.add(_measurementMarker(point, center, '#ff4d4f'));
    }
    if (_measureDraft.length === 2) {
      const a = _cellPositionAtTime(_measureDraft[0], _currentTime);
      const b = _cellPositionAtTime(_measureDraft[1], _currentTime);
      if (a && b) _measurementGroup.add(_measurementLine(a, b, center, '#ff9f43', true));
    }
  }

  function _measurementLine(a, b, center, colorHex, dashed = false) {
    const start = new THREE.Vector3(a[0] + center.x, a[1] + center.y, a[2] + center.z);
    const end = new THREE.Vector3(b[0] + center.x, b[1] + center.y, b[2] + center.z);
    const group = new THREE.Group();
    if (dashed) {
      const material = new THREE.LineDashedMaterial({ color: colorHex, dashSize: 5, gapSize: 3, transparent: true, opacity: 0.95, depthTest: false });
      const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
      const line = new THREE.Line(geometry, material);
      if (line.computeLineDistances) line.computeLineDistances();
      group.add(line);
    } else {
      const distance = start.distanceTo(end);
      if (distance > 0) {
        const lineGeom = new THREE.CylinderGeometry(1.2, 1.2, distance, 8);
        const lineMat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.95, depthTest: false });
        const lineMesh = new THREE.Mesh(lineGeom, lineMat);
        lineMesh.position.copy(start).lerp(end, 0.5);
        lineMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().sub(start).normalize());
        group.add(lineMesh);
      }
    }
    group.add(_measurementMarker(a, center, colorHex));
    group.add(_measurementMarker(b, center, colorHex));
    return group;
  }

  function _measurementMarker(point, center, colorHex) {
    const position = new THREE.Vector3(point[0] + center.x, point[1] + center.y, point[2] + center.z);
    const size = 3.5;
    const geom = new THREE.SphereGeometry(size, 16, 16);
    const mat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.95, depthTest: false });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(position);
    return mesh;
  }

  function listMeasurements() {
    return _measurements.map(row => _resolveMeasurementRow(row));
  }

  function setMeasurements(items = []) {
    _measurements = MeasurementStore.setAll(_datasetMeta?.id || 'tracking', 'tracking', items);
    _updateMeasurementVisuals();
    _notifyMeasureChange();
  }

  function updateMeasurement(id, patch = {}) {
    const updated = MeasurementStore.update(_datasetMeta?.id || 'tracking', 'tracking', id, patch);
    if (!updated) return null;
    _measurements = MeasurementStore.list(_datasetMeta?.id || 'tracking', 'tracking');
    _updateMeasurementVisuals();
    _notifyMeasureChange();
    return updated;
  }

  function removeMeasurement(id) {
    _measurements = MeasurementStore.remove(_datasetMeta?.id || 'tracking', 'tracking', id);
    _updateMeasurementVisuals();
    _notifyMeasureChange();
  }

  function setMeasurementMode(mode) {
    _measurementMode = mode === 'follow-cells' ? 'follow-cells' : 'snapshot';
    _notifyMeasureChange();
  }

  function _syncMeasurementStore() {
    MeasurementStore.setAll(_datasetMeta?.id || 'tracking', 'tracking', _measurements);
  }

  function selectCell(cellId) {
    if (!_trackData?.cells || cellId === undefined || cellId === null) return null;
    const id = String(cellId);
    const entry = _trackData.cells[id]
      ? [id, _trackData.cells[id]]
      : Object.entries(_trackData.cells).find(([, c]) => String(c.id) === id || String(c.track_id) === id);
    if (!entry) return null;
    const cell = entry[1];
    _selectedCellId = entry[0];
    setTimepoint(_currentTime);
    _updateNeighborNetwork();
    if (_onCellSelect) _onCellSelect(cell, entry[0]);
    return cell;
  }

  function setVelocityFieldVisible(visible) {
    _velocityFieldVisible = Boolean(visible);
    _updateVelocityField();
  }

  function setNeighborNetworkVisible(visible) {
    _neighborNetworkVisible = Boolean(visible);
    _updateNeighborNetwork();
  }

  function setNeighborThreshold(value) {
    const next = Number(value);
    _neighborThreshold = Number.isFinite(next) ? Math.max(5, Math.min(500, next)) : 55;
    _updateNeighborNetwork();
    if (_surfaceOpts.colorMode === 'density') _updateSurfaceColor();
  }

  function setMeshClipSpec(spec = {}) {
    _meshClipSpec = {
      ..._meshClipSpec,
      ...spec,
      enabled: spec.enabled === undefined ? _meshClipSpec.enabled : Boolean(spec.enabled),
      mode: ['xy', 'xz', 'yz', 'oblique'].includes(spec.mode) ? spec.mode : (_meshClipSpec.mode || 'xy'),
      value: Number.isFinite(spec.value) ? Math.max(0, Math.min(1, spec.value)) : _meshClipSpec.value,
      yaw: Number.isFinite(spec.yaw) ? spec.yaw : _meshClipSpec.yaw,
      pitch: Number.isFinite(spec.pitch) ? Math.max(-89, Math.min(89, spec.pitch)) : _meshClipSpec.pitch,
      color: spec.color || _meshClipSpec.color,
      opacity: Number.isFinite(spec.opacity) ? Math.max(0.04, Math.min(0.8, spec.opacity)) : _meshClipSpec.opacity
    };
    _updateClipState();
  }

  function getMeshClipSpec() {
    return { ..._meshClipSpec };
  }

  function getNeighborNetworkRows(maxRows = 16) {
    if (!_selectedCellId || !_trackData?.cells) return [];
    const selected = _cellPositionAtTime(_selectedCellId, _currentTime);
    if (!selected) return [];
    return Object.entries(_trackData.cells)
      .filter(([id]) => String(id) !== String(_selectedCellId))
      .map(([id, cell]) => {
        const position = _cellPositionAtTime(id, _currentTime);
        if (!position) return null;
        return {
          id,
          trackId: cell.track_id || cell.id || id,
          region: cell.region || 'Unknown',
          distance: _distance(selected, position)
        };
      })
      .filter(Boolean)
      .filter(row => row.distance <= _neighborThreshold)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, maxRows);
  }

  function getVelocityRows(maxRows = 500) {
    if (!_trackData?.cells) return [];
    return Object.entries(_trackData.cells)
      .map(([id, cell]) => {
        const p0 = _cellPositionAtTime(id, _currentTime);
        const p1 = _cellPositionAtTime(id, _currentTime + 1);
        if (!p0 || !p1) return null;
        const speed = _distance(p0, p1);
        if (speed <= 0) return null;
        return {
          id,
          trackId: cell.track_id || cell.id || id,
          region: cell.region || 'Unknown',
          speed,
          x: p0[0],
          y: p0[1],
          z: p0[2],
          dx: p1[0] - p0[0],
          dy: p1[1] - p0[1],
          dz: p1[2] - p0[2]
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.speed - a.speed)
      .slice(0, maxRows);
  }

  function _updateVelocityField() {
    if (!_velocityGroup) return;
    _clearGroup(_velocityGroup);
    if (!_velocityFieldVisible || !_trackData?.cells) return;
    const center = _glbScene ? _glbScene.position : new THREE.Vector3();
    const rows = getVelocityRows(260);
    const maxSpeed = Math.max(1, ...rows.map(row => row.speed));
    rows.forEach(row => {
      const start = new THREE.Vector3(row.x + center.x, row.y + center.y, row.z + center.z);
      const dir = new THREE.Vector3(row.dx, row.dy, row.dz);
      const length = Math.max(4, Math.min(48, row.speed * 0.75));
      const color = new THREE.Color().setHSL(0.58 - Math.min(1, row.speed / maxSpeed) * 0.58, 0.95, 0.56);
      const arrow = new THREE.ArrowHelper(dir.normalize(), start, length, color, Math.max(2, length * 0.28), Math.max(1, length * 0.16));
      arrow.userData = { cellId: row.id, speed: row.speed };
      _velocityGroup.add(arrow);
    });
  }

  function _updateNeighborNetwork() {
    if (!_neighborGroup) return;
    _clearGroup(_neighborGroup);
    if (!_neighborNetworkVisible || !_selectedCellId || !_trackData?.cells) return;
    const selected = _cellPositionAtTime(_selectedCellId, _currentTime);
    if (!selected) return;
    const center = _glbScene ? _glbScene.position : new THREE.Vector3();
    const origin = new THREE.Vector3(selected[0] + center.x, selected[1] + center.y, selected[2] + center.z);
    getNeighborNetworkRows(24).forEach(row => {
      const pos = _cellPositionAtTime(row.id, _currentTime);
      if (!pos) return;
      const target = new THREE.Vector3(pos[0] + center.x, pos[1] + center.y, pos[2] + center.z);
      const geom = new THREE.BufferGeometry().setFromPoints([origin, target]);
      const mat = new THREE.LineBasicMaterial({
        color: row.distance <= _neighborThreshold * 0.55 ? 0x00a654 : 0x00d2ff,
        transparent: true,
        opacity: 0.72
      });
      const line = new THREE.Line(geom, mat);
      line.userData = { selectedId: _selectedCellId, neighborId: row.id, distance: row.distance };
      _neighborGroup.add(line);
    });
  }

  function _clearGroup(group) {
    while (group.children.length) {
      const child = group.children[group.children.length - 1];
      group.remove(child);
      if (child.children?.length) _clearGroup(child);
      child.geometry?.dispose?.();
      child.material?.dispose?.();
      if (child.line?.geometry) child.line.geometry.dispose();
      if (child.cone?.geometry) child.cone.geometry.dispose();
      if (child.line?.material) child.line.material.dispose();
      if (child.cone?.material) child.cone.material.dispose();
    }
  }

  function getSelectedCell() {
    if (!_selectedCellId || !_trackData?.cells) return null;
    return _trackData.cells[_selectedCellId]
      || Object.values(_trackData.cells).find(c => String(c.id) === String(_selectedCellId) || String(c.track_id) === String(_selectedCellId))
      || null;
  }

  function renderGraph() {
    if (!window.Plotly || !_trackData) return;
    
    // Example graph: Cell population over time by region
    const timepoints = (_trackData.timepoints || []).map(Number).sort((a, b) => a - b);
    const maxT = timepoints.length || _datasetMeta.dimensions.t || 10;
    let countsByRegion = {};
    
    Object.values(_trackData.cells).forEach(c => {
      const r = c.region || 'Unknown';
      if (!countsByRegion[r]) countsByRegion[r] = new Array(maxT).fill(0);

      if (timepoints.length) {
        timepoints.forEach((tp, idx) => {
          if (c.positions[String(Math.floor(tp))]) countsByRegion[r][idx]++;
        });
      } else {
        Object.keys(c.positions).map(Number).forEach(t => {
          if (t >= 0 && t < maxT) countsByRegion[r][t]++;
        });
      }
    });
    
    const traces = Object.keys(countsByRegion).map(r => {
      return {
        x: Array.from({length: maxT}, (_, i) => i),
        y: countsByRegion[r],
        name: r,
        type: 'scatter',
        mode: 'lines',
        line: { shape: 'spline' }
      };
    });
    
    const layout = {
      margin: { t: 10, l: 30, r: 10, b: 30 },
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      font: { color: '#a0a3b1', size: 10 },
      xaxis: { title: 'Timepoint', gridcolor: '#2a2d3a' },
      yaxis: { title: 'Cells', gridcolor: '#2a2d3a' },
      showlegend: false
    };
    
    Plotly.newPlot('stats-graph', traces, layout, {displayModeBar: false, responsive: true});
  }

  function getCameraState() {
    if (!_camera || !_controls) return null;
    return {
      kind: 'tracking',
      position: _camera.position.toArray(),
      quaternion: _camera.quaternion.toArray(),
      target: _controls.target.toArray()
    };
  }

  function getDisplayState() {
    return {
      ..._displayState,
      surfaceOpacity: _surfaceOpts.opacity,
      surfaceColorMode: _surfaceOpts.colorMode
    };
  }

  function applyDisplayState(state = {}) {
    if (state.backgroundPreset || state.backgroundColor) {
      setBackgroundPreset(state.backgroundPreset || _displayState.backgroundPreset, state.backgroundColor || _displayState.backgroundColor);
    }
    if (Number.isFinite(state.surfaceOpacity)) setSurfaceOpacity(state.surfaceOpacity);
    if (state.surfaceColorMode) setSurfaceColorMode(state.surfaceColorMode);
  }

  function getLegendState() {
    return _surfaceLegendState;
  }

  function setCameraState(state) {
    if (!state || !_camera || !_controls) return;
    if (state.kind && state.kind !== 'tracking') return;
    if (!Array.isArray(state.position) && !Array.isArray(state.quaternion) && !Array.isArray(state.target)) return;
    _applyingCameraState = true;
    if (Array.isArray(state.position) && state.position.length === 3) {
      _camera.position.fromArray(state.position);
    }
    if (Array.isArray(state.quaternion) && state.quaternion.length === 4) {
      _camera.quaternion.fromArray(state.quaternion);
    }
    if (Array.isArray(state.target) && state.target.length === 3) {
      _controls.target.fromArray(state.target);
    }
    _camera.updateProjectionMatrix();
    _controls.update();
    _applyingCameraState = false;
  }

  function onCameraChange(callback) {
    _onCameraChange = callback;
  }

  function onCellSelect(callback) {
    _onCellSelect = callback;
  }

  function onMeasureChange(callback) {
    _onMeasureChange = callback;
  }

  function setActiveTool(tool) {
    _activeTool = tool || 'navigate';
  }

  function _notifyCameraChange() {
    if (_onCameraChange) _onCameraChange(getCameraState());
  }

  // --- Grid and Axes ---
  let _gridGroup = null;
  let _axesGroup = null;
  let _gridMode = 0; // 0: none, 1: normal, 2: fine
  let _axesVisible = false;
  let _gridSizeScales = { xy: 1.0, xz: 1.0, yz: 1.0 };

  function _updateGridsAndAxes() {
    if (_gridGroup) { _scene.remove(_gridGroup); _gridGroup = null; }
    if (_axesGroup) { _scene.remove(_axesGroup); _axesGroup = null; }
    
    if (_gridMode === 0 && !_axesVisible) return;
    
    const span = _clipSpan ? _clipSpan() : 100;
    const baseSize = span * 1.5;
    const arrowLen = span * 0.5;
    
    if (_gridMode > 0) {
      _gridGroup = new THREE.Group();
      const colorCenter = 0x888888;
      const colorGrid = 0x444444;
      
      const createPlane = (id, scale, rx, ry, rz, px, py, pz, nx, ny, nz) => {
        const size = baseSize * scale;
        if (size > 0) {
          const divs = _gridMode === 2 ? Math.round(size / (baseSize/40)) : Math.round(size / (baseSize/10));
          const grid = new THREE.GridHelper(size, Math.max(1, divs), colorCenter, colorGrid);
          grid.rotation.set(rx, ry, rz);
          grid.position.set(px, py, pz);
          _gridGroup.add(grid);
          
          // Build projection group: flatten geometry along the normal axis so everything sits on the wall
          // Cells are cloned via instanced mesh; surfaces are cloned with correct parent transform
          const projGroup = new THREE.Group();
          projGroup.userData.isProjGroup = true;
          
          // Wall position: the wall sits at the negative extreme of each axis
          // We position the projGroup at the wall, then scale to 0 along the normal axis
          const wallX = nx === 1 ? -baseSize/2 : 0;
          const wallY = ny === 1 ? -baseSize/2 : 0;
          const wallZ = nz === 1 ? -baseSize/2 : 0;
          projGroup.position.set(wallX, wallY, wallZ);
          projGroup.scale.set(
            nx === 1 ? 0.0001 : 1,
            ny === 1 ? 0.0001 : 1,
            nz === 1 ? 0.0001 : 1
          );
          
          if (_cellMesh) {
            const cellClone = new THREE.InstancedMesh(_cellMesh.geometry, _cellMesh.material.clone(), _cellMesh.count);
            cellClone.instanceMatrix = _cellMesh.instanceMatrix;
            if (_cellMesh.instanceColor) cellClone.instanceColor = _cellMesh.instanceColor;
            cellClone.material.transparent = true;
            cellClone.material.opacity = 0.6;
            cellClone.visible = (size > 0);
            projGroup.add(cellClone);
          }
          
          if (_glbScene) {
             // The glbScene has a centering offset stored in its position
             const glbOffset = _glbScene.position.clone();
             _glbScene.traverse(child => {
                if (child.isMesh && child.userData.surfaceVariant) {
                   const surfClone = new THREE.Mesh(child.geometry, child.material.clone());
                   surfClone.material.transparent = true;
                   surfClone.material.opacity = 0.4;
                   surfClone.userData.isProjSurface = true;
                   surfClone.userData.surfaceVariant = child.userData.surfaceVariant;
                   // World transform of child = glbScene.position + child local transform
                   // We need to apply the full world matrix of the child relative to scene root
                   child.updateWorldMatrix(true, false);
                   surfClone.applyMatrix4(child.matrixWorld);
                   surfClone.visible = (size > 0);
                   projGroup.add(surfClone);
                }
             });
          }
          _gridGroup.add(projGroup);
        }
        
        const handleGeom = new THREE.SphereGeometry(baseSize * 0.025, 16, 16);
        const handleMat = new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.0, depthTest: false });
        const handle = new THREE.Mesh(handleGeom, handleMat);
        const hx = px + (nx === 0 ? size/2 : 0);
        const hy = py + (ny === 0 ? size/2 : 0);
        const hz = pz + (nz === 0 ? size/2 : 0);
        handle.position.set(hx, hy, hz);
        handle.userData = { isGridHandle: true, plane: id, normal: new THREE.Vector3(nx, ny, nz) };
        _gridGroup.add(handle);
      };

      createPlane('xy', _gridSizeScales.xy, Math.PI/2, 0, 0, -baseSize/2 + (baseSize*_gridSizeScales.xy)/2, -baseSize/2 + (baseSize*_gridSizeScales.xy)/2, -baseSize/2, 0, 0, 1);
      createPlane('xz', _gridSizeScales.xz, 0, 0, 0, -baseSize/2 + (baseSize*_gridSizeScales.xz)/2, -baseSize/2, -baseSize/2 + (baseSize*_gridSizeScales.xz)/2, 0, 1, 0);
      createPlane('yz', _gridSizeScales.yz, 0, 0, Math.PI/2, -baseSize/2, -baseSize/2 + (baseSize*_gridSizeScales.yz)/2, -baseSize/2 + (baseSize*_gridSizeScales.yz)/2, 1, 0, 0);
      
      _scene.add(_gridGroup);
      // Sync surface visibility so projections show only the current timepoint
      _updateSurfaceVisibility();
    }
    
    if (_axesVisible) {
      _axesGroup = new THREE.Group();
      const origin = new THREE.Vector3(0, 0, 0);
      const xAxis = new THREE.ArrowHelper(new THREE.Vector3(1,0,0), origin, arrowLen, 0xff0000, arrowLen*0.1, arrowLen*0.05);
      const yAxis = new THREE.ArrowHelper(new THREE.Vector3(0,1,0), origin, arrowLen, 0x00ff00, arrowLen*0.1, arrowLen*0.05);
      const zAxis = new THREE.ArrowHelper(new THREE.Vector3(0,0,1), origin, arrowLen, 0x0088ff, arrowLen*0.1, arrowLen*0.05);
      _axesGroup.add(xAxis, yAxis, zAxis);
      
      const sphereGeom = new THREE.SphereGeometry(baseSize * 0.04, 16, 16);
      const sphereMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.0, depthTest: false });
      const sphere = new THREE.Mesh(sphereGeom, sphereMat);
      sphere.userData = { isAxesSphere: true };
      _axesGroup.add(sphere);

      // In tracking viewer, axes position is static until moved
      if (!_axesGroup.userData.initializedPos) {
        _axesGroup.position.set(-baseSize/2, -baseSize/2, -baseSize/2);
        _axesGroup.userData.initializedPos = true;
      }
      _scene.add(_axesGroup);
    }
  }

  function setGridMode(mode) {
    _gridMode = mode % 3;
    _updateGridsAndAxes();
  }

  /** Move axes to a world-space point projected from screen click onto a
   *  plane parallel to the screen and passing through the current axes position */
  function _moveAxesToScreenPoint(clientX, clientY) {
    if (!_axesGroup || !_camera || !_renderer) return;
    const rect = _renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    const camDir = new THREE.Vector3();
    _camera.getWorldDirection(camDir);
    const planePoint = _axesGroup.position.clone();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, planePoint);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, _camera);
    const target = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(plane, target)) {
      _axesGroup.position.copy(target);
    }
  }
  
  function setAxesVisible(visible) {
    _axesVisible = visible;
    _updateGridsAndAxes();
  }

  function setDensityColormap(name) {
    if (!COLOR_MAPS[name]) return;
    _activeColormap = name;
    _updateSurfaceColor();
    _notifyMeasureChange();
  }

  function getDensityColormap() {
    return _activeColormap;
  }

  function getDensityColormapNames() {
    return Object.keys(COLOR_MAPS);
  }

  function getDensityColormapStops(name) {
    return COLOR_MAPS[name] || [];
  }

  return {
    init,
    loadData,
    setTimepoint,
    setFilter,
    setSurfaceOpacity,
    setSurfaceColorMode,
    setBackgroundPreset,
    setSmoothing,
    centerSample,
    resize: _onResize,
    findCell,
    renderGraph,
    setActiveTool,
    setVelocityFieldVisible,
    setNeighborNetworkVisible,
    setNeighborThreshold,
    setMeshClipSpec,
    getMeshClipSpec,
    getNeighborNetworkRows,
    getVelocityRows,
    selectCell,
    clearMeasurement,
    clearMeasurements: clearMeasurement,
    getMeasurement,
    listMeasurements,
    setMeasurements,
    updateMeasurement,
    removeMeasurement,
    setMeasurementMode,
    getSelectedCell,
    onCellSelect,
    onMeasureChange,
    getCameraState,
    setCameraState,
    onCameraChange,
    getDisplayState,
    applyDisplayState,
    getLegendState,
    setGridMode,
    setAxesVisible,
    setPointScale: (s) => { _pointScale = s; setTimepoint(_currentTime); },
    setDensityColormap,
    getDensityColormap,
    getDensityColormapNames,
    getDensityColormapStops,
    getRenderer: () => _renderer,
    getTrackData: () => _trackData,
    getCurrentTime: () => _currentTime
  };
})();
