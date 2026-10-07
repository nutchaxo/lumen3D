/* ============================================================
   IRIBHM Microscopy Platform — Volume Viewer (WebGL / Three.js)
   ============================================================ */

const VolumeViewer = (() => {
  let scene, camera, renderer, cube, material;
  let _container;
  let texture3D;
  let animationId;
  let _contextLost = false;     // ELE-18: true between webglcontextlost and webglcontextrestored
  let _onContextLost = null;    // ELE-18: visible-status hooks (wired by viewer.js)
  let _onContextRestored = null;
  let _resizeObserver = null;
  let _observedParent = null;
  const _cameraListeners = new Set();
  let _loadCounter = 0;
  let _baseScale = new THREE.Vector3(1, 1, 1);
  let _zDisplayScale = 1.0;
  let _physicalSizeUm = null;
  let _scaleMode = 'metadata-missing';
  let _hasLoadedVolume = false;
  let _activeTextureKey = null;
  let _activeVolumeEntry = null;
  let _channelHistograms = [];
  let _activeTool = 'navigate';
  let _cutPlane = { axis: 'z', value: 1.0, visible: false };
  let _planeSpec = {
    mode: 'xy',
    axis: 'z',
    value: 1.0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    slabThickness: 1,
    projection: 'single',
    visible: false
  };
  let _cutPlaneMesh = null;
  let _planeBorderMesh = null;   // red edge highlight on hover
  let _cutSlabFaceA = null;      // MIP/average slab faces, ± along the plane normal
  let _cutSlabFaceB = null;
  let _volumeBoundingBox = null;
  let _svrManager = null;
  // Region-of-interest detail streaming (_roiUpdate): the finer level's atlas for the
  // part of the volume in view, its mode ('auto' | 'on' | 'off'), the debounce timer,
  // the round counter and the status the page shows.
  let _roi = null;
  let _roiMode = 'auto';
  // GPU-compressed display atlas: 'auto' compresses the atlases of a timelapse (where
  // the cache must hold many frames), 'on' every bricked volume, 'off' none. Kept for
  // the session and in localStorage 'lumen3d.gpuCompression'; a volume already loaded
  // keeps its form until it is loaded again.
  const GPU_COMPRESSION_MODES = ['auto', 'on', 'off'];
  let _gpuCompressionSession = null;
  let _roiTimer = null;
  let _roiSeq = 0;
  let _roiStatus = { mode: 'auto', active: false, level: null, baseLevel: null, inView: 0, resident: 0, loading: 0, loaded: 0, capacity: 0, pixelsPerVoxel: null, reason: 'idle', message: '' };
  const _roiListeners = new Set();
  // Tuning of the region-of-interest rounds (see _roiUpdate).
  const ROI_DEBOUNCE_MS = 350;
  const ROI_MAX_BYTES = 768 * 1024 * 1024;
  const ROI_AUTO_MIN_BUDGET = 1024 * 1024 * 1024;
  const ROI_BUDGET_SHARE = 0.75;
  const ROI_MIN_SLOTS = 32;
  const ROI_CONCURRENCY = 8;
  // One derived manifest per (manifest, timepoint): BrickLoader recognises a tree it
  // has mounted by the manifest object, so the same timepoint must yield the same one.
  const _tpManifestMemo = new WeakMap();

  let _planeHovered = false;
  const _cutPlaneListeners = new Set();
  const _planeSpecListeners = new Set();
  let _raycaster = null;
  let _pointer = null;
  let _onMeasurePoint = null;
  let _displayState = { backgroundPreset: 'dark', backgroundColor: '#000000' };
  let _measurementGroup = null;
  let _labelsGroup = null;
  let _measurementSprites = [];
  let _showMeasurementLabels = true;
  let _measurementTextSize = 48;
  let _measurements = [];
  // Module-level ref to the label sprite currently being dragged (null when idle).
  // Read by _animate so repulsion is skipped for the whole frame, not just during pointermove.
  let _activeDragSprite = null;
  // BUG-006: declared at module scope; was previously an implicit global (assigned without let).
  let _draggedLabelSprite = null;
  let _rotGizmo = null;
  let _gizmoHovered = false;
  let _qualityTarget = '512x512';
  let _currentQualityMode = '512x512';
  let _isStreamingBricks = false;
  // Number of DISPLAY streams in flight. A background prefetch refuses to start
  // while this is non-zero — see the guard at the top of loadBrickedVolumeStream.
  let _fgStreamActive = 0;
  // Slice-stack loads in flight (loadVolume), each { loadId } once it has one. The
  // current one (loadId === _loadCounter) re-uploads the displayed texture about once
  // a second while its slices land; a superseded one only drains its fetches.
  const _sliceLoads = new Set();
  let _transitionCube = null;
  let _transitionMaterial = null;
  let _transitionEntry = null;
  let _qualityState = { target: '512x512', active: null, mode: 'slice', progress: 0, message: '' };
  const _qualityListeners = new Set();
  let _brickStreamAbort = null;
  let _preloadStreamAbort = null;
  // The last display load (brick stream or slice stack), replayed after a WebGL
  // context loss: { kind, basePath, metadata, timepoint, onProgress, options }.
  let _lastDisplayRequest = null;
  // Bumped on every context loss: a stream started before it stops writing into
  // textures that no longer exist.
  let _contextEpoch = 0;
  // Times of the context losses of this page: a reload that loses the context again
  // and again (a driver that resets on every attempt) stops replaying (see
  // _recoverFromContextLoss) instead of looping until the browser blocks WebGL.
  const _contextLossTimes = [];
  const CONTEXT_LOSS_LOOP = { count: 3, windowMs: 120000 };
  // Listeners registered by init() (canvas, window), removed by dispose().
  let _listenerAbort = null;
  let _firstInteractionLogged = false;
  const _frameStats = {
    lastTs: 0,
    samples: [],
    sampleWindow: 180,
    lastEmitAt: 0
  };
  let _onPostRender = null;

  const RGBA_TEXTURE_BYTES_PER_VOXEL = 4;
  // ELE-24 (BUG-003): brick edge length (voxels). Authoritative across the pipeline:
  // SVR atlas slot (svr-manager.js:43), the shader `brickSize` uniform, the decode
  // worker, and preprocess 3-chunk_packer.py (BRICK_SIZE=64). The legacy
  // brick-loader.js BRICK_SIZE=128 is NOT authoritative — never fall back to 128 here.
  const VOLUME_BRICK_SIZE = 64;
  // MONO-3DTEX: ceiling above which an RGBA volume is rendered through SVRManager
  // (sparse atlas of 64^3 bricks) instead of a single monolithic Data3DTexture.
  // Lowered from 1.5 GiB to 512 MiB: ANGLE/D3D11 silently rejects a single ~1 GiB
  // TEXTURE_3D ("glTexStorage3D: too large") even though it is under 1.5 GiB, leaving
  // a storage-less texture that brick uploads paint with uninitialised GPU memory
  // (pink chunks). 512 MiB is a conservative size ANGLE reliably honours for a single
  // 3D resource; anything larger goes to the SVR atlas, whose per-page allocations are
  // small and whose cascade (svr-manager.js) degrades gracefully on VRAM pressure.
  const MONOLITHIC_RGBA_LIMIT_BYTES = Math.floor(0.5 * 1024 * 1024 * 1024);

  let _needsRender = true;
  let _idleFrameCount = 0;
  const IDLE_SLEEP_FRAMES = 120; // Stop rAF loop after ~2s of no changes
  let _lastCameraPos = new THREE.Vector3();
  let _lastCameraQuat = new THREE.Quaternion();
  let _lastCubePos = new THREE.Vector3();
  let _lastCubeQuat = new THREE.Quaternion();
  let _rotationLocked = false;
  // The raw file shows the sample from below (its +Z face is the underside): it is
  // shown turned over about the screen's vertical axis and its top face is −Z.
  // setSampleUpsideDown.
  let _upsideDown = false;
  // A pose in flight, { from, to, start, duration }: stepped by _animate.
  let _poseAnim = null;
  // The dataset's "home" pose — null unless something set one (the orientation-axes
  // plugin does, from the dataset's saved default view). resetView() returns HERE
  // rather than to the raw voxel axes, so "reset" lands where the dataset opened.
  let _homeQuaternion = null;
  let _isInteracting = false;
  let _activePointers = new Map();
  // Sample cap per ray of a settled frame (the `steps` uniform at rest), refreshed
  // every frame from the drawing-buffer size by _settledSampleCap.
  let _targetSteps = 1024;
  let _lastInteractionTime = 0;
  let _interactionTimeout = null;

  // ── Ray-march sampling and adaptive quality ────────────────────────────────
  // The march takes one sample every 1/sampleRate voxel lengths along the ray
  // (see the shader's `delta`). A settled frame samples every voxel (rate 1: a
  // maximum-intensity projection cannot miss a one-voxel structure) at the full
  // pixel ratio. While the user drags, both the pixel ratio and the rate follow
  // the measured frame time (_nextAdaptiveState) toward INTERACTIVE_TARGET_MS.
  const MAX_MARCH_STEPS = 4096;            // the shader's loop bound
  const IDLE_SAMPLE_RATE = 1.0;
  const INTERACTIVE_TARGET_MS = 16.7;
  const ADAPTIVE_LIMITS = { minScale: 0.25, maxScale: 1, minRate: 0.1, maxRate: 0.75 };
  // A settled frame marches at most this many pixel·samples, so one draw call stays
  // well under the ~2 s GPU watchdog (TDR) of Windows even with no empty space to
  // skip; measured settled frames scale it (_settledBudgetScale).
  const SETTLED_PIXEL_SAMPLE_BUDGET = 6e9;
  let _adaptive = { scale: 0.75, rate: 0.35 };
  let _settledBudgetScale = 1;
  let _lastRenderAt = 0;
  let _lastRenderInteractive = false;
  // Redraws caused by bricks landing are coalesced: one frame every STREAM_REDRAW_MS.
  const STREAM_REDRAW_MS = 250;
  let _streamRedrawTimer = null;
  let _lastStreamRedrawAt = 0;

  function _markInteraction() {
    _lastInteractionTime = Date.now();
    if (_interactionTimeout) {
      clearTimeout(_interactionTimeout);
    }
    _interactionTimeout = setTimeout(() => {
      _interactionTimeout = null;
      _scheduleFrame();
    }, 300);
  }

  // Sigma de débruitage gaussien par canal (jusqu'à 4 canaux)
  let _channelSigma = [0, 0, 0, 0];

  // Pool de Web Workers pour le flou gaussien (parallélisation par tranches de slices Z)
  const BLUR_POOL_SIZE = Math.min(4, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4) || 4);
  let _blurWorkerPool = null;
  let _blurTaskId = 0;
  // taskId → { remaining: number, chunks: Uint8Array[], onDone: fn }
  const _blurAssemblers = new Map();

  function _getBlurWorkerPool() {
    if (!_blurWorkerPool) {
      try {
        _blurWorkerPool = [];
        for (let wi = 0; wi < BLUR_POOL_SIZE; wi++) {
          const w = new Worker('js/workers/gaussian-blur-worker.js');
          w.onmessage = (e) => {
            const msg = e.data || {};
            if (msg.type === 'progress') return;
            if (msg.type === 'error') {
              console.error(`[VolumeViewer] Blur worker ${wi} error (task ${msg.taskId}, chunk ${msg.chunkIndex}):`, msg.message);
              _failBlurTask(msg.taskId, msg.message || 'blur worker error');
              return;
            }
            if (msg.type === 'result') {
              const asm = _blurAssemblers.get(msg.taskId);
              if (!asm) return; // stale
              asm.chunks[msg.chunkIndex] = new Uint8Array(msg.blurredData);
              if (Number.isFinite(msg.effectiveSigma)) asm.effectiveSigma = msg.effectiveSigma;
              asm.remaining--;
              if (asm.remaining === 0) {
                _blurAssemblers.delete(msg.taskId);
                // Assemblage des chunks en un seul buffer
                const totalLen = asm.chunks.reduce((s, c) => s + c.length, 0);
                const merged = new Uint8Array(totalLen);
                let off = 0;
                for (const chunk of asm.chunks) {
                  merged.set(chunk, off);
                  off += chunk.length;
                }
                asm.onDone(merged, asm.effectiveSigma);
              }
            }
          };
          // A worker that dies (script error, out of memory) answers none of its
          // chunks: every task still waiting on the pool is failed, not left pending.
          w.onerror = (err) => {
            console.error(`[VolumeViewer] Blur worker ${wi} error:`, err?.message);
            for (const taskId of [..._blurAssemblers.keys()]) _failBlurTask(taskId, err?.message || 'blur worker failed');
          };
          _blurWorkerPool.push(w);
        }
        console.log(`[VolumeViewer] Blur worker pool initialized (${BLUR_POOL_SIZE} workers)`);
      } catch (err) {
        console.error('[VolumeViewer] Failed to create blur worker pool:', err);
        _blurWorkerPool = null;
      }
    }
    return _blurWorkerPool;
  }

  /**
   * Dispatch un blur en parallèle : découpe le volume en N chunks par profondeur Z,
   * envoie chaque chunk à un Worker du pool, et assemble les résultats.
   * @param {Uint8Array} rawSingleChannel  Données brutes mono-canal (width × height × depth)
   * @param {number} width
   * @param {number} height
   * @param {number} depth
   * @param {number} sigma  Écart-type du noyau gaussien
   * @param {function(Uint8Array)} onDone  Callback avec le résultat blurré
   */
  let _blurActiveCount = 0; // Nombre de tâches blur en cours (multi-canal possible)

  function _showBlurToast() {
    const el = document.getElementById('blur-progress-toast');
    if (el) el.classList.remove('hidden');
    if (window.lucide) window.lucide.createIcons({ nodes: el ? [el] : [] });
  }

  function _hideBlurToast() {
    const el = document.getElementById('blur-progress-toast');
    if (el) el.classList.add('hidden');
  }

  /** A blur task that cannot complete: its assembler is dropped, the toast follows
   *  the remaining count, and its owner is told (onError) so it can put the raw
   *  channel back. */
  function _failBlurTask(taskId, reason) {
    const asm = _blurAssemblers.get(taskId);
    if (!asm) return;
    _blurAssemblers.delete(taskId);
    asm.onError(reason);
  }

  function _dispatchParallelBlur(rawSingleChannel, width, height, depth, sigma, onDone, onError = () => {}) {
    const pool = _getBlurWorkerPool();
    if (!pool || pool.length === 0) {
      // Blurring a volume is not done on the UI thread (CLAUDE.md 1.2): the channel
      // stays as it is, and the caller says so.
      console.warn('[VolumeViewer] No blur worker pool: denoise unavailable');
      onError('no blur worker');
      return;
    }

    _blurActiveCount++;
    _showBlurToast();

    const taskId = ++_blurTaskId;
    const N = Math.min(pool.length, depth);
    const sliceSize = width * height;
    const chunks = new Array(N);

    const settle = () => {
      _blurActiveCount = Math.max(0, _blurActiveCount - 1);
      if (_blurActiveCount === 0) _hideBlurToast();
    };
    const wrappedOnDone = (merged, effectiveSigma) => { settle(); onDone(merged, effectiveSigma); };
    const wrappedOnError = (reason) => { settle(); onError(reason); };

    _blurAssemblers.set(taskId, { remaining: N, chunks, onDone: wrappedOnDone, onError: wrappedOnError, effectiveSigma: sigma });

    for (let i = 0; i < N; i++) {
      const startZ = Math.floor(i * depth / N);
      const endZ = Math.floor((i + 1) * depth / N);
      const chunkDepth = endZ - startZ;
      const chunkData = new Uint8Array(chunkDepth * sliceSize);
      chunkData.set(rawSingleChannel.subarray(startZ * sliceSize, endZ * sliceSize));

      pool[i % pool.length].postMessage({
        type: 'blur',
        rawData: chunkData,
        width, height,
        depth: chunkDepth,
        sigma,
        taskId,
        chunkIndex: i
      }, [chunkData.buffer]);
    }

    console.log(`[VolumeViewer] Blur task ${taskId}: ${depth} slices split across ${N} workers`);
  }

  const QUALITY_PRESETS = {
    '256x256':   { directory: 'preview/slices', maxTextureSize: 256,  maxDepthSamples: 56  },
    '512x512':   { directory: 'medium/slices',  maxTextureSize: 512,  maxDepthSamples: 96  },
    '1024x1024': { directory: 'slices',         maxTextureSize: 1024, maxDepthSamples: 192 },
    '2048x2048': { directory: 'slices',         maxTextureSize: 2048, maxDepthSamples: 256 },
    '4096x4096': { directory: 'slices',         maxTextureSize: 4096, maxDepthSamples: 320 },
    native:      { directory: 'slices',         maxTextureSize: 4096, maxDepthSamples: 320 },
    
    // Legacy compatibility aliases
    preview:     { directory: 'preview/slices', maxTextureSize: 256,  maxDepthSamples: 56  },
    balanced:    { directory: 'medium/slices',  maxTextureSize: 1024, maxDepthSamples: 96  },
    high:        { directory: 'slices',         maxTextureSize: 1024, maxDepthSamples: 192 }
  };
  const CONCURRENT_IMAGE_LOADS = 10;
  const PRELOAD_IMAGE_LOADS = 6;
  const BRICK_STREAM_CONCURRENCY = { 
    '4096x4096': 12, '2048x2048': 16, '1024x1024': 32, native: 16, '256x256': 16, '512x512': 32,
    high: 32, preview: 16, balanced: 32
  };
  // In-flight slice-image requests only (one fetch per URL at a time). Decoded
  // bitmaps are never retained: the caller closes each one as soon as its pixels are
  // copied, and the browser's HTTP cache keeps the compressed files for a revisit.
  const _imageCache = new Map();
  const _volumeCache = new Map();
  // First picture of a stream: the share of its bricks (taken centre first) that
  // must be on the GPU before onFirstPicture fires.
  const FIRST_PICTURE_FRACTION = 0.25;

  // A 4D manifest indexes EVERY timepoint in one document (3.4 MB for the 30-frame
  // reference series), and it used to be re-fetched on each timepoint switch with
  // cache:'no-cache' plus a ?t= buster — so a full scrub pulled ~90 MB of manifest to
  // deliver 3.8 MB of bricks. It cannot change while the page is open, so fetch it once
  // per dataset. The in-flight promise is shared so concurrent switches never race two
  // downloads of the same document.
  //
  // Declared HERE, with the other module state, and not next to the function that uses
  // it: everything past this IIFE's `return` is only reachable as a hoisted function
  // declaration. A `const` down there never executes, so the first call would throw
  // "Cannot access '_manifestCache' before initialization" and silently drop the viewer
  // onto the slice-stack fallback.
  const _manifestCache = new Map();   // "<basePath>/<brickDir>" -> Promise<manifest>

  function _fetchBrickManifest(dir) {
    const hit = _manifestCache.get(dir);
    if (hit) return hit;
    const p = fetch(`${dir}/manifest.json`, { cache: 'no-cache' })
      .then(resp => {
        if (!resp.ok) throw new Error(`No brick manifest (${resp.status})`);
        return resp.json();
      })
      .catch(err => { _manifestCache.delete(dir); throw err; });
    _manifestCache.set(dir, p);
    return p;
  }

  function _perf() {
    return typeof PerfTelemetry !== 'undefined' ? PerfTelemetry : null;
  }
  
  // State
  let config = {
    dimensions: { x: 1, y: 1, z: 1, original_x: 1, original_y: 1 },
    channels: [] // [{ name, color: [r,g,b], min: 0, max: 1, enabled: true }]
  };
  
  let clipPlanes = {
    xMin: 0.0, xMax: 1.0,
    yMin: 0.0, yMax: 1.0,
    zMin: 0.0, zMax: 1.0
  };

  /**
   * Shaders for Volume Raymarching
   */
  const vertexShader = `
    out vec3 vUv;
    out vec3 vOrigin;
    out vec3 vDirection;
    void main() {
      vUv = position;
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vOrigin = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
      vDirection = position - vOrigin;
      gl_Position = projectionMatrix * viewMatrix * worldPosition;
    }
  `;


  // projVertexShader: rays fired along one axis through the volume.
  // Vertices are in _gridGroup space (same as world space, no scale).
  // invCubeScale converts position to cube-local space for ray origin sampling.
  const projVertexShader = `
    uniform int projAxis;      // 0=X (YZ wall), 1=Y (XZ wall), 2=Z (XY wall)
    uniform vec3 invCubeScale; // 1.0 / cube.scale, converts grid space → cube local
    out vec3 vOrigin;
    out vec3 vDirection;
    void main() {
      vec3 cubeLocal = position * invCubeScale;
      if (projAxis == 0) {
         vOrigin    = vec3(-0.5, cubeLocal.y, cubeLocal.z);
         vDirection = vec3(1.0, 0.0, 0.0);
      } else if (projAxis == 1) {
         vOrigin    = vec3(cubeLocal.x, -0.5, cubeLocal.z);
         vDirection = vec3(0.0, 1.0, 0.0);
      } else {
         vOrigin    = vec3(cubeLocal.x, cubeLocal.y, -0.5);
         vDirection = vec3(0.0, 0.0, 1.0);
      }
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;



  // We support up to 4 channels.
  // The texture3D holds RGBA (Channel 0,1,2,3)
  // renderMode: 0 = Structure DVR (front-to-back emission/occlusion), 1 = per-channel
  // MIP (Imaris-like additive fluorescence), 2 = Natural Fluorescence (emission–absorption).
  const fragmentShader = `
    precision highp float;
    precision highp int;
    precision highp sampler3D;
    precision highp sampler2DArray;

    #define MAX_MARCH_STEPS ${MAX_MARCH_STEPS}
    // Structure DVR reference: a sample of displayed value a covers DVR_REF_ALPHA·a of
    // the light over DVR_REF_STEP object units (0.05 per 1/100 of the volume: the look
    // the mode had at 100 samples per ray). DVR_SLAB_REF: see dvrGain below.
    #define DVR_REF_STEP 0.01
    #define DVR_REF_ALPHA 0.05
    #define DVR_SLAB_REF 0.25
    // Depth pick: the march samples twice per voxel length, and the picked surface is
    // where the displayed value first reaches PICK_SURFACE of the ray's maximum.
    #define PICK_MAX_STEPS 4096
    #define PICK_SURFACE 0.55
    #define PICK_MIN_VALUE 0.02

    in vec3 vUv;
    in vec3 vOrigin;
    in vec3 vDirection;

    #ifdef SVR_ARRAY
    // A compressed display atlas (svr-manager.js, compression 'bc'): RGTC pages, which
    // WebGL2 only accepts as 2D array textures — one layer per voxel plane.
    uniform sampler2DArray svrAtlas0;
    uniform sampler2DArray svrAtlas1;
    uniform sampler2DArray svrAtlas2;
    uniform sampler2DArray svrAtlas3;
    uniform sampler2DArray svrAtlas4;
    uniform sampler2DArray svrAtlas5;
    uniform sampler2DArray svrAtlas6;
    uniform sampler2DArray svrAtlas7;
    #else
    uniform sampler3D svrAtlas0;
    uniform sampler3D svrAtlas1;
    uniform sampler3D svrAtlas2;
    uniform sampler3D svrAtlas3;
    uniform sampler3D svrAtlas4;
    uniform sampler3D svrAtlas5;
    uniform sampler3D svrAtlas6;
    uniform sampler3D svrAtlas7;
    #endif
    #ifdef HAS_OCCUPANCY
    uniform sampler3D mapOccupancy;
    // OCC-Z: maps a normalized volume coord to the per-brick occupancy grid so the
    // grid cells align with the 64^3 brick boundaries even when the volume size is
    // not a multiple of the brick size (partial last brick) = volumeDim/(brickSize*gridDim).
    uniform vec3 occupancyScale;
    #endif

    // Voxel counts of the volume bound (texture space [0,1]^3 holds that lattice) and
    // the brick edge in voxels. A brick cell is floor(uvw · volumeVoxels / brickSize).
    uniform vec3 volumeVoxels;
    uniform float brickSize;

    // Atlas components (svr-manager.js): an R8 / RG8 atlas samples as (r, 0, 0, 1) /
    // (r, g, 0, 1), and that alpha of 1 would read as a full channel 3. The channels a
    // dataset does not have are zeroed instead (constant-folded per define).
    #ifndef SVR_COMPONENTS
    #define SVR_COMPONENTS 4
    #endif
    #ifndef ROI_DETAIL_COMPONENTS
    #define ROI_DETAIL_COMPONENTS 4
    #endif
    vec4 keepComponents(vec4 v, int n) {
      return n >= 4 ? v : (n == 2 ? vec4(v.rg, 0.0, 0.0) : (n == 3 ? vec4(v.rgb, 0.0) : vec4(v.r, 0.0, 0.0, 0.0)));
    }

    // Atlas texture coordinate of the continuous voxel position pos (texture space ×
    // the level's voxel counts: voxel i spans [i, i+1], its centre at i + ½) inside the
    // brick 'cell' held at atlas slot 'slot' (slots of 'stride' texels per side).
    //   apron 1 (v3 bricks, 66³ slots, LINEAR atlas): the slot stores volume voxels
    //     64·cell − 1 … 64·cell + 64, so texel slot·stride + 1 + (pos − 64·cell) is the
    //     point pos itself. Hardware trilinear filtering reads the 2×2×2 texels around
    //     it, floor(t − ½) and floor(t − ½) + 1 per axis; with local = pos − 64·cell in
    //     [0, 64] those are slot texels 0 … 65 — the brick's own border at worst, which
    //     holds the neighbouring bricks' voxels (clamp-to-edge outside the volume) — so
    //     the result is exactly the trilinear interpolation of the whole volume, seamless
    //     across bricks.
    //   apron 0 (v2 bricks, 64³ slots, NEAREST atlas): the voxel under pos, clamped to
    //     the brick's real extent, read at its texel centre.
    vec3 slotCoord(vec3 pos, vec3 cell, vec3 slot, vec3 dim, float stride, float apron, vec3 atlasSize) {
      if (apron > 0.5) {
        vec3 local = clamp(pos - cell * brickSize, vec3(0.0), vec3(brickSize));
        return (slot * stride + vec3(apron) + local) / atlasSize;
      }
      vec3 p = clamp(pos, vec3(0.0), dim - vec3(1.0));
      vec3 brickOrigin = cell * brickSize;
      vec3 brickExtent = min(vec3(brickSize), dim - brickOrigin);
      vec3 localVoxel = clamp(floor(p - brickOrigin), vec3(0.0), max(vec3(0.0), brickExtent - vec3(1.0)));
      return (slot * stride + localVoxel + vec3(0.5)) / atlasSize;
    }

    #ifdef ENABLE_SVR
    uniform sampler3D pageTable;
    uniform vec3 atlasDim;
    uniform vec3 volumeDim;
    uniform vec3 ptDim;
    uniform vec3 ptScale;
    // Slot edge in texels (64, or 66 with the 1-voxel border) and the border width.
    uniform float slotStride;
    uniform float brickApron;
    // How many atlas pages are actually live. A sampler3D bound to nothing is an
    // INCOMPLETE texture, and WebGL defines a fetch from one as (0,0,0,1) -- alpha 1.
    // Read as a page index that is 255 - 1 = 254, i.e. "brick present, page 254",
    // so the empty-space test below passed for every voxel of the volume and the ray
    // marcher sampled an unbound atlas, itself returning (0,0,0,1): channel 3 full
    // scale everywhere (a solid box in that channel's colour) and channels 0-2 at
    // exactly zero. Bounding the index against the live page count turns any such
    // inconsistent state back into "no brick" -- an empty view, never wrong voxels.
    uniform int svrPageCount;

    // textureLod everywhere in the march: the atlases have no mipmaps, so level 0 is
    // what texture() returns, without needing derivatives inside divergent control
    // flow (undefined there by GLSL ES 3.00).
    #ifdef SVR_ARRAY
    // The atlas coordinate c (normalised by atlasDim, as for a 3D page) read from a
    // page of layers. Hardware trilinear filtering of a 3D texture is, per axis, the
    // linear blend of the two texels around t − ½: the blend in x and y is the layer's
    // own bilinear filter, the one in z is done here — t = c.z·depth − ½, layers
    // ⌊t⌋ and ⌊t⌋ + 1 weighted by 1 − f and f, f = t − ⌊t⌋. Exactly what the LINEAR
    // 3D page returns; inside a bordered slot both layers belong to the brick (see
    // slotCoord). A v2 (apron 0) atlas is NEAREST: the layer holding c, ⌊c.z·depth⌋.
    // A macro over the local layers (svrL0, svrL1, svrF, svrBlend), not a function
    // taking the sampler: sampler arguments go through a rewriting pass of ANGLE's
    // translator that some backends mishandle.
    #define SVR_LAYER(page) (svrBlend ? mix(textureLod(page, svrL0, 0.0), textureLod(page, svrL1, 0.0), svrF) : textureLod(page, svrL0, 0.0))
    vec4 sampleSVRAtlas(vec3 atlasCoord, float atlasPage) {
        bool svrBlend = brickApron > 0.5;
        float t = atlasCoord.z * atlasDim.z - (svrBlend ? 0.5 : 0.0);
        float z0 = floor(t);
        float svrF = t - z0;
        vec3 svrL0 = vec3(atlasCoord.xy, z0);
        vec3 svrL1 = vec3(atlasCoord.xy, z0 + 1.0);
        #ifdef SVR_ARRAY_PAIRS
        // Three or four channels: page k is svrAtlas<k> (BC5: channels 0, 1) beside
        // svrAtlas<k+4> (BC5: channels 2, 3, or BC4: channel 2 with g read as 0).
        vec4 a; vec4 b;
        if (atlasPage < 0.5) { a = SVR_LAYER(svrAtlas0); b = SVR_LAYER(svrAtlas4); }
        else if (atlasPage < 1.5) { a = SVR_LAYER(svrAtlas1); b = SVR_LAYER(svrAtlas5); }
        else if (atlasPage < 2.5) { a = SVR_LAYER(svrAtlas2); b = SVR_LAYER(svrAtlas6); }
        else { a = SVR_LAYER(svrAtlas3); b = SVR_LAYER(svrAtlas7); }
        return vec4(a.rg, b.rg);
        #else
        if (atlasPage < 0.5) return SVR_LAYER(svrAtlas0);
        if (atlasPage < 1.5) return SVR_LAYER(svrAtlas1);
        if (atlasPage < 2.5) return SVR_LAYER(svrAtlas2);
        if (atlasPage < 3.5) return SVR_LAYER(svrAtlas3);
        if (atlasPage < 4.5) return SVR_LAYER(svrAtlas4);
        if (atlasPage < 5.5) return SVR_LAYER(svrAtlas5);
        if (atlasPage < 6.5) return SVR_LAYER(svrAtlas6);
        return SVR_LAYER(svrAtlas7);
        #endif
    }
    #else
    vec4 sampleSVRAtlas(vec3 atlasCoord, float atlasPage) {
        if (atlasPage < 0.5) return textureLod(svrAtlas0, atlasCoord, 0.0);
        if (atlasPage < 1.5) return textureLod(svrAtlas1, atlasCoord, 0.0);
        if (atlasPage < 2.5) return textureLod(svrAtlas2, atlasCoord, 0.0);
        if (atlasPage < 3.5) return textureLod(svrAtlas3, atlasCoord, 0.0);
        if (atlasPage < 4.5) return textureLod(svrAtlas4, atlasCoord, 0.0);
        if (atlasPage < 5.5) return textureLod(svrAtlas5, atlasCoord, 0.0);
        if (atlasPage < 6.5) return textureLod(svrAtlas6, atlasCoord, 0.0);
        return textureLod(svrAtlas7, atlasCoord, 0.0);
    }
    #endif
    #endif

    #ifdef ROI_DETAIL
    // Region of interest: a FINER level's bricks, streamed only for the part of the
    // volume in view (volume-viewer.js _roiUpdate), in their own atlas and page table.
    // fetchVoxel reads the detail level wherever it holds the brick under the sample
    // and falls back to the level resident everywhere elsewhere. With bordered (v3)
    // bricks both levels are seamless inside themselves; where the detail region ends,
    // the picture steps from the detail level to the coarser one at that brick's face
    // (each side exactly its own level's trilinear interpolation, no gap, no blend).
    uniform sampler3D detailPageTable;
    uniform sampler3D detailAtlas0;
    uniform sampler3D detailAtlas1;
    uniform sampler3D detailAtlas2;
    uniform sampler3D detailAtlas3;
    uniform vec3 detailAtlasDim;
    uniform vec3 detailVolumeDim;
    uniform vec3 detailPtDim;
    uniform float detailSlotStride;
    uniform float detailApron;
    uniform int detailPageCount;

    vec4 sampleDetailAtlas(vec3 atlasCoord, float atlasPage) {
        if (atlasPage < 0.5) return textureLod(detailAtlas0, atlasCoord, 0.0);
        if (atlasPage < 1.5) return textureLod(detailAtlas1, atlasCoord, 0.0);
        if (atlasPage < 2.5) return textureLod(detailAtlas2, atlasCoord, 0.0);
        return textureLod(detailAtlas3, atlasCoord, 0.0);
    }

    // The detail brick last looked up (fetchVoxel): a memo of a pure lookup, valid
    // for the whole draw.
    vec3 detailCell = vec3(-1.0);
    vec4 detailPage = vec4(-1.0);
    #endif
    uniform int numChannels;
    // Sample cap per ray, and samples per voxel length (see delta in main()).
    uniform int steps;
    uniform float sampleRate;
    uniform int renderMode;   // 0 = DVR, 1 = Emission (MIP), 2 = Natural Fluorescence
    uniform float exposure;   // global brightness multiplier
    // View export (renderViewImage). fragCoordOffset: where this tile's window sits in
    // the full exported image, so the jitter below reads the coordinate one full-size
    // render would give it; (0,0) on screen. exportAlpha: 0 on screen, 1 for a
    // transparent export (see fragAlpha).
    uniform vec2 fragCoordOffset;
    uniform int exportAlpha;
    #ifdef PICK_MODE
    // Depth pick (pickVolumePoint): 0 writes x and y of the hit, 1 writes z and the flag.
    uniform int pickPass;
    #endif

    // ── Natural Fluorescence (renderMode 2) controls ──
    uniform float absorption;    // Beer-Lambert extinction (front-to-back occlusion → 3D form)
    uniform float emissionGain;  // fluorophore glow brightness (multiplies exposure)
    uniform float whitePoint;    // extended-Reinhard luminance white point (highlight headroom)
    uniform float saturation;    // constant-luminance chroma push (fluorescent vividness)
    uniform float colocWhiten;   // max desaturation when 3-4 channels truly co-localize
    uniform float colocGamma;    // gate exponent suppressing faint-channel contamination

    uniform vec3 color0; uniform float min0; uniform float max0; uniform float gamma0; uniform float opacity0; uniform int en0;
    uniform vec3 color1; uniform float min1; uniform float max1; uniform float gamma1; uniform float opacity1; uniform int en1;
    uniform vec3 color2; uniform float min2; uniform float max2; uniform float gamma2; uniform float opacity2; uniform int en2;
    uniform vec3 color3; uniform float min3; uniform float max3; uniform float gamma3; uniform float opacity3; uniform int en3;

    uniform vec3 clipMin;
    uniform vec3 clipMax;

    #ifdef VOLUME_WARP
    // 4D stabilisation. Object space stays in "acquisition-box units" (the acquisition
    // box is [-0.5,0.5]^3) but the cube geometry may be larger, so that it covers the
    // union of every frame's box once each has been carried into the stabilised frame.
    //   volumeWarp : object space -> texture coordinate of THIS timepoint's volume.
    //                It folds the inverse of the frame's rigid transform, so the
    //                specimen stands still while the imaged box moves around it. No
    //                voxel is resampled: only the sampling coordinate changes.
    //   clipBox*   : object space -> normalised DISPLAY box, which is the space the
    //                cut plane and the clip sliders act in (the user slices what they
    //                see, not the acquisition frame).
    uniform mat4 volumeWarp;
    uniform vec3 clipBoxMin;
    uniform vec3 clipBoxSize;
    #endif

    out vec4 fragColor;

    // Ray ∩ axis-aligned box [bmin, bmax], both in the ray's own space: entry/exit ray
    // parameters (t0 > t1 ⇔ miss). Shared by the data box and the clip box.
    vec2 hitAABB(vec3 orig, vec3 dir, vec3 bmin, vec3 bmax) {
      vec3 safe_dir = dir + (1.0 - step(vec3(1e-8), abs(dir))) * 1e-8;
      vec3 inv_dir = 1.0 / safe_dir;
      vec3 tmin_tmp = (bmin - orig) * inv_dir;
      vec3 tmax_tmp = (bmax - orig) * inv_dir;
      vec3 tmin = min(tmin_tmp, tmax_tmp);
      vec3 tmax = max(tmin_tmp, tmax_tmp);
      float t0 = max(tmin.x, max(tmin.y, tmin.z));
      float t1 = min(tmax.x, min(tmax.y, tmax.z));
      return vec2(t0, t1);
    }

    vec2 hitBox(vec3 orig, vec3 dir) {
      return hitAABB(orig, dir, vec3(-0.5), vec3(0.5));
    }

    // The clip box (clipMin..clipMax, normalised) in OBJECT space, so the march can be
    // confined to it. Unwarped, uvw = p + 0.5; warped, the sliders act in the display
    // box (clipBoxMin + clipCoord * clipBoxSize). Every sample of the march lies in
    // this box, so no per-sample clip test is needed.
    vec2 hitClipBox(vec3 orig, vec3 dir) {
      #ifdef VOLUME_WARP
      return hitAABB(orig, dir, clipBoxMin + clipMin * clipBoxSize, clipBoxMin + clipMax * clipBoxSize);
      #else
      return hitAABB(orig, dir, clipMin - 0.5, clipMax - 0.5);
      #endif
    }

    #ifdef VOLUME_WARP
    // Entry/exit of the ray through the SOURCE volume, returned in the OBJECT-space ray
    // parameter. Object and texture space are related by a single affine map, so the
    // parameter is common to both and the slab test is done where the box is
    // axis-aligned — texture space, where the acquisition box is exactly the unit cube.
    // Clipping the march to the real data instead of to the enlarged geometry is what
    // keeps the sampling density (and therefore the image) independent of how far the
    // specimen drifted over the series.
    vec2 hitBoxWarped(vec3 orig, vec3 dir) {
      vec3 o = (volumeWarp * vec4(orig, 1.0)).xyz;
      vec3 d = mat3(volumeWarp) * dir;
      vec3 safe_dir = d + (1.0 - step(vec3(1e-8), abs(d))) * 1e-8;
      vec3 inv_dir = 1.0 / safe_dir;
      vec3 tmin_tmp = (vec3(0.0) - o) * inv_dir;
      vec3 tmax_tmp = (vec3(1.0) - o) * inv_dir;
      vec3 tmin = min(tmin_tmp, tmax_tmp);
      vec3 tmax = max(tmin_tmp, tmax_tmp);
      return vec2(max(tmin.x, max(tmin.y, tmin.z)), min(tmax.x, min(tmax.y, tmax.z)));
    }
    #endif

    // Texture coordinate of the object-space point p.
    vec3 toTexture(vec3 p) {
      #ifdef VOLUME_WARP
      vec3 uvw = (volumeWarp * vec4(p, 1.0)).xyz;
      #else
      vec3 uvw = p + vec3(0.5);
      #endif
      return uvw;
    }

    // The 64³ brick (interior) holding uvw, in a level of 'dim' voxels.
    vec3 brickCellIn(vec3 uvw, vec3 dim) {
      vec3 vox = clamp(uvw * dim, vec3(0.0), dim - vec3(1.0));
      return floor(vox / brickSize);
    }

    vec3 brickCell(vec3 uvw) {
      return brickCellIn(uvw, volumeVoxels);
    }

    // Empty-space skip: the ray parameter from uvw to the exit of brick 'cell' of a
    // level of 'dim' voxels. The brick spans [cell, cell+1]·brickSize/dim in texture
    // space and d(uvw)/dt = dirTex, so each face is reached at (face − uvw)/dirTex; the
    // exit is the nearest face ahead on each axis, the first of the three.
    float brickExitIn(vec3 uvw, vec3 dirTex, vec3 cell, vec3 dim) {
      vec3 lo = cell * brickSize / dim;
      vec3 hi = min((cell + vec3(1.0)) * brickSize / dim, vec3(1.0));
      vec3 safe = dirTex + (1.0 - step(vec3(1e-8), abs(dirTex))) * 1e-8;
      vec3 tt = (mix(lo, hi, step(vec3(0.0), safe)) - uvw) / safe;
      return max(0.0, min(tt.x, min(tt.y, tt.z)));
    }

    float brickExit(vec3 uvw, vec3 dirTex, vec3 cell) {
      return brickExitIn(uvw, dirTex, cell, volumeVoxels);
    }

    // The voxel at uvw, or false when its brick holds no data; 'skip' is then the ray
    // parameter to that brick's exit. The brick last looked up is kept in
    // (cachedCell, cachedPage) — page.xyz = its atlas slot, page.w = its atlas page,
    // −1 for an empty brick — so the page table (or the occupancy grid) is read once
    // per brick a ray crosses instead of once per sample.
    bool fetchVoxel(vec3 uvw, vec3 dirTex, inout vec3 cachedCell, inout vec4 cachedPage, out vec4 val, out float skip) {
      skip = 0.0;
      val = vec4(0.0);
      #ifdef ROI_DETAIL
      vec3 dPos = uvw * detailVolumeDim;
      vec3 dCell = brickCellIn(uvw, detailVolumeDim);
      if (any(notEqual(dCell, detailCell))) {
        detailCell = dCell;
        vec4 dp = textureLod(detailPageTable, (dCell + vec3(0.5)) / detailPtDim, 0.0);
        float dAtlasPage = floor(dp.a * 255.0 + 0.5) - 1.0;
        detailPage = (dAtlasPage < 0.0 || dAtlasPage > float(detailPageCount - 1))
          ? vec4(-1.0)
          : vec4(floor(dp.rgb * 255.0 + 0.5), dAtlasPage);
      }
      if (detailPage.w >= 0.0) {
        val = keepComponents(sampleDetailAtlas(slotCoord(dPos, dCell, detailPage.xyz, detailVolumeDim, detailSlotStride, detailApron, detailAtlasDim), detailPage.w), ROI_DETAIL_COMPONENTS);
        return true;
      }
      #endif
      #ifdef ENABLE_SVR
      vec3 cell = brickCell(uvw);
      if (any(notEqual(cell, cachedCell))) {
        cachedCell = cell;
        vec4 page = textureLod(pageTable, (cell + vec3(0.5)) / ptDim, 0.0);
        float atlasPage = floor(page.a * 255.0 + 0.5) - 1.0;
        cachedPage = (atlasPage < 0.0 || atlasPage > float(svrPageCount - 1))
          ? vec4(-1.0)
          : vec4(floor(page.rgb * 255.0 + 0.5), atlasPage);
      }
      if (cachedPage.w < 0.0) {
        skip = brickExit(uvw, dirTex, cell);
        #ifdef ROI_DETAIL
        // A finer brick may hold signal where the coarse one was dropped as empty (a
        // mean rounds a lone faint voxel to 0): never jump past the detail cell.
        skip = min(skip, brickExitIn(uvw, dirTex, dCell, detailVolumeDim));
        #endif
        return false;
      }
      val = keepComponents(sampleSVRAtlas(slotCoord(uvw * volumeDim, cell, cachedPage.xyz, volumeDim, slotStride, brickApron, atlasDim), cachedPage.w), SVR_COMPONENTS);
      return true;
      #else
        #ifdef HAS_OCCUPANCY
        vec3 cell = brickCell(uvw);
        if (any(notEqual(cell, cachedCell))) {
          cachedCell = cell;
          // The cell's centre, (cell + ½)·brickSize/volumeVoxels, in occupancy-grid
          // coordinates (× occupancyScale): NEAREST then reads exactly that cell.
          float occ = textureLod(mapOccupancy, (cell + vec3(0.5)) * brickSize / volumeVoxels * occupancyScale, 0.0).r;
          cachedPage = vec4(occ < 0.5 ? -1.0 : 1.0);
        }
        if (cachedPage.w < 0.0) {
          skip = brickExit(uvw, dirTex, cell);
          #ifdef ROI_DETAIL
          skip = min(skip, brickExitIn(uvw, dirTex, dCell, detailVolumeDim));
          #endif
          return false;
        }
        #endif
      val = textureLod(svrAtlas0, uvw, 0.0);
      return true;
      #endif
    }

    // Displayed value of each channel: window, gamma, opacity, on/off.
    vec4 channelValues(vec4 val) {
      vec4 v = vec4(0.0);
      #if ENABLE_CHANNEL_0
      if (en0 == 1) {
        v.x = clamp((val.r - min0) / max(max0 - min0, 0.0001), 0.0, 1.0);
        if (gamma0 != 1.0) v.x = pow(v.x, gamma0);
        v.x *= opacity0;
      }
      #endif
      #if ENABLE_CHANNEL_1
      if (en1 == 1) {
        v.y = clamp((val.g - min1) / max(max1 - min1, 0.0001), 0.0, 1.0);
        if (gamma1 != 1.0) v.y = pow(v.y, gamma1);
        v.y *= opacity1;
      }
      #endif
      #if ENABLE_CHANNEL_2
      if (en2 == 1) {
        v.z = clamp((val.b - min2) / max(max2 - min2, 0.0001), 0.0, 1.0);
        if (gamma2 != 1.0) v.z = pow(v.z, gamma2);
        v.z *= opacity2;
      }
      #endif
      #if ENABLE_CHANNEL_3
      if (en3 == 1) {
        v.w = clamp((val.a - min3) / max(max3 - min3, 0.0001), 0.0, 1.0);
        if (gamma3 != 1.0) v.w = pow(v.w, gamma3);
        v.w *= opacity3;
      }
      #endif
      return v;
    }

    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    // Alpha of the ray's pixel. On screen it is 1: the canvas shows the light C as an
    // opaque pixel over the page background. A transparent export needs coverage
    // instead, so the PNG composites like the light it records: premultiplied (C, a)
    // with a = max(opacity, max(C)) clamped to [0,1] — never below the brightest
    // channel, so C <= a keeps it a valid premultiplied pixel and over black it is
    // exactly C, the screen value. opacity is the ray's own: 1 - transmittance in the
    // emission-absorption mode, the accumulated alpha in DVR, 0 for MIP (pure light).
    float fragAlpha(vec3 c, float opacity) {
      if (exportAlpha == 0) return 1.0;
      vec3 cc = clamp(c, 0.0, 1.0);
      return clamp(max(opacity, max(cc.r, max(cc.g, cc.b))), 0.0, 1.0);
    }

    // ACES filmic tone mapping — keeps colours saturated and vivid under high brightness
    vec3 ACESFilm(vec3 x) {
      return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
    }

    #ifdef PICK_MODE
    // 16-bit fixed point of x ∈ [0,1] as two bytes (high, low), each written as k/255
    // so an RGBA8 target stores it exactly.
    vec2 encode16(float x) {
      float q = floor(clamp(x, 0.0, 1.0) * 65535.0 + 0.5);
      float hi = floor(q / 256.0);
      return vec2(hi, q - hi * 256.0) / 255.0;
    }
    #endif

    void main() {
      vec3 rayDir = normalize(vDirection);
      #ifdef VOLUME_WARP
      vec2 bounds = hitBoxWarped(vOrigin, rayDir);
      vec3 dirTex = mat3(volumeWarp) * rayDir;
      #else
      vec2 bounds = hitBox(vOrigin, rayDir);
      vec3 dirTex = rayDir;
      #endif
      if (bounds.x > bounds.y) discard;

      bounds.x = max(bounds.x, 0.0);
      // Full traversal of the data box — the reference the slab normalisation below
      // measures the clipped segment against.
      float fullLength = max(bounds.y - bounds.x, 1e-6);

      // Confine the march to the clip box so every sample lands in what is displayed.
      // Marching the whole box and rejecting samples per clipCoord gave a thin z-slab
      // (the Z-stack browser shows ONE slice) a fraction of a sample per ray.
      vec2 clipT = hitClipBox(vOrigin, rayDir);
      bounds.x = max(bounds.x, clipT.x);
      bounds.y = min(bounds.y, clipT.y);
      if (bounds.x >= bounds.y) discard;

      float rayLength = bounds.y - bounds.x;
      // Sampling interval. Texture space [0,1]^3 holds volumeVoxels voxels per axis and
      // d(uvw)/dt = dirTex, so the ray crosses
      //     nu = |dirTex ⊙ volumeVoxels|
      // voxel lengths per unit of its parameter (its direction measured in voxels).
      // One sample every 1/sampleRate voxel lengths is
      //     delta = 1 / (sampleRate · nu),
      // whatever the ray's length, the axis it runs along or the level of detail; a ray
      // needing more than 'steps' samples is spread evenly instead (delta = L/steps).
      float nu = max(length(dirTex * volumeVoxels), 1e-6);
      #ifdef ROI_DETAIL
      // Where the finer level is resident the ray must sample at ITS voxel pitch.
      nu = max(nu, length(dirTex * detailVolumeDim));
      #endif

      #ifdef PICK_MODE
      // Depth of the surface under the pixel. Pass 1 finds the largest displayed value
      // m along the ray; pass 2 the first point where the value reaches
      // max(PICK_MIN_VALUE, PICK_SURFACE·m), linearly interpolated between the two
      // samples around the crossing — the front of the brightest structure the pixel
      // shows, through the same window, channels, clip box and stabilisation.
      float pd = 1.0 / (2.0 * nu);
      if (rayLength / pd > float(PICK_MAX_STEPS)) pd = rayLength / float(PICK_MAX_STEPS);
      vec3 pc = vec3(-1.0);
      vec4 pp = vec4(0.0);
      float peak = 0.0;
      float pt = 0.0;
      for (int i = 0; i < PICK_MAX_STEPS; i++) {
        if (pt > rayLength) break;
        vec4 val; float skip;
        if (!fetchVoxel(toTexture(vOrigin + (bounds.x + pt) * rayDir), dirTex, pc, pp, val, skip)) {
          pt += max(pd, ceil(skip / pd) * pd);
          continue;
        }
        vec4 v = channelValues(val);
        peak = max(peak, max(max(v.x, v.y), max(v.z, v.w)));
        pt += pd;
      }
      if (peak < PICK_MIN_VALUE) discard;
      float surfaceValue = max(PICK_MIN_VALUE, PICK_SURFACE * peak);
      pc = vec3(-1.0);
      pt = 0.0;
      float prevT = 0.0;
      float prevD = 0.0;
      float hitT = -1.0;
      for (int i = 0; i < PICK_MAX_STEPS; i++) {
        if (pt > rayLength) break;
        vec4 val; float skip;
        float d = 0.0;
        if (!fetchVoxel(toTexture(vOrigin + (bounds.x + pt) * rayDir), dirTex, pc, pp, val, skip)) {
          prevT = pt;
          prevD = 0.0;
          pt += max(pd, ceil(skip / pd) * pd);
          continue;
        }
        vec4 v = channelValues(val);
        d = max(max(v.x, v.y), max(v.z, v.w));
        if (d >= surfaceValue) {
          hitT = (d > prevD) ? mix(prevT, pt, (surfaceValue - prevD) / (d - prevD)) : pt;
          break;
        }
        prevT = pt;
        prevD = d;
        pt += pd;
      }
      if (hitT < 0.0) discard;
      vec3 hit = vOrigin + (bounds.x + hitT) * rayDir;
      #ifdef VOLUME_WARP
      vec3 hc = (hit - clipBoxMin) / clipBoxSize;
      #else
      vec3 hc = hit + vec3(0.5);
      #endif
      fragColor = pickPass == 0
        ? vec4(encode16(hc.x), encode16(hc.y))
        : vec4(encode16(hc.z), 1.0, 1.0);
      return;
      #endif

      float delta = 1.0 / (max(sampleRate, 1e-3) * nu);
      float maxSamples = float(max(steps, 1));
      if (rayLength / delta > maxSamples) delta = rayLength / maxSamples;
      // A segment shorter than one interval (a one-slice slab, a grazing ray, a coarse
      // interactive rate) still gets its one sample, weighted by its real length; with
      // delta > rayLength the jittered first sample fell past the exit on most pixels
      // and the slab flickered as speckle while dragging.
      delta = min(delta, rayLength);
      float jitter = hash(gl_FragCoord.xy + fragCoordOffset) * delta;
      float t = jitter;

      // Slab normalisation. A clipped segment is displayed as if it were optically
      // thick: its emission is scaled so its integral matches a column one attenuation
      // length long (1/absorption), or the full traversal when the medium is thinner
      // than that. A bright voxel in a one-slice slab then reads at the level a bright
      // column reads in the full 3D view, and that level no longer depends on how many
      // slices the slab holds. An unclipped ray is left exactly as it was (gain 1):
      //   slabGain = max(1, min(fullLength / rayLength, 1 / (absorption · rayLength)))
      float slabGain = max(1.0, 1.0 / (rayLength * max(absorption, 1.0 / fullLength)));
      // Structure DVR, same idea: a slab thinner than DVR_SLAB_REF is integrated as if
      // it were that thick (never more than the full traversal, so an unclipped ray
      // keeps gain 1). Each sample's opacity is the reference opacity carried over the
      // actual interval (Beer–Lambert opacity correction):
      //   aStep = 1 − (1 − DVR_REF_ALPHA·a)^(delta·dvrGain / DVR_REF_STEP)
      // so a column's accumulated opacity depends on its length, not on how many
      // samples cross it — the image no longer changes between a drag and rest.
      float dvrGain = max(1.0, min(fullLength, DVR_SLAB_REF) / rayLength);
      float dvrExponent = delta * dvrGain / DVR_REF_STEP;

      // ── Per-channel MIP accumulators (mode 1 - Fluorescence) ──
      vec4 mip = vec4(0.0);
      // The ceiling of each displayed channel (its opacity, 0 when off): once every
      // channel reaches it nothing further along the ray can raise the projection.
      vec4 mipCeil = vec4(0.0);
      #if ENABLE_CHANNEL_0
      if (en0 == 1) mipCeil.x = opacity0 * 0.999;
      #endif
      #if ENABLE_CHANNEL_1
      if (en1 == 1) mipCeil.y = opacity1 * 0.999;
      #endif
      #if ENABLE_CHANNEL_2
      if (en2 == 1) mipCeil.z = opacity2 * 0.999;
      #endif
      #if ENABLE_CHANNEL_3
      if (en3 == 1) mipCeil.w = opacity3 * 0.999;
      #endif

      // ── DVR accumulators (mode 0 - Structure) ──
      vec3  accumDVR   = vec3(0.0);
      float accumAlpha = 0.0;

      // ── Natural Fluorescence accumulators (mode 2) ──
      // Front-to-back emission–absorption: clebColor = composited glow, clebChan =
      // per-channel radiance (drives co-localization), clebT = running transmittance.
      vec3  clebColor = vec3(0.0);
      vec4  clebChan  = vec4(0.0);
      float clebT     = 1.0;
      // Step-size independence: tie both opacity and emission to the physical step length
      // 'delta', so brightness/occlusion stay invariant to the sample count.
      // Beer-Lambert transmittance prod(1-aStep)=prod(exp(-clebK*d))=exp(-absorption*int d ds)
      // is then EXACT regardless of step count; exposure is folded into the emission scale.
      float clebK    = absorption * delta;
      float clebEmit = emissionGain * exposure * delta * slabGain;

      vec3 cachedCell = vec3(-1.0);
      vec4 cachedPage = vec4(0.0);
      for (int i = 0; i < MAX_MARCH_STEPS; i++) {
        if (t >= rayLength) break;
        if (renderMode == 0 && accumAlpha > 0.97) break;

        vec3 uvw = toTexture(vOrigin + (bounds.x + t) * rayDir);
        vec4 val;
        float skip;
        if (!fetchVoxel(uvw, dirTex, cachedCell, cachedPage, val, skip)) {
          // Jump to the brick's exit, on the jittered sample lattice.
          t += max(delta, ceil(skip / delta) * delta);
          continue;
        }
        vec4 v = channelValues(val);

        if (renderMode == 1) {
          mip = max(mip, v);
          if (all(greaterThanEqual(mip, mipCeil))) break;
        } else if (renderMode == 2) {
          // Achromatic density = strongest channel (max, NOT sum: co-located channels
          // share one structure's opacity rather than double-darkening it into mud).
          float d = max(max(v.x, v.y), max(v.z, v.w));
          if (d > 0.0025) {
            // Beer-Lambert slab opacity (exact per segment, step-size independent).
            float aStep = 1.0 - exp(-clebK * d);

            // Emission = fluorophore colours weighted by their OWN intensity, so a
            // green-only voxel emits pure green (additive — correct for independent
            // emitters). v retains per-channel radiance for co-localization logic.
            vec3 emit = v.x * color0 + v.y * color1 + v.z * color2 + v.w * color3;

            // Front-to-back: emission attenuated by everything already in front (clebT).
            // Dense near structures occlude the glow behind them → real 3D depth/form.
            float wT = clebT * clebEmit;
            clebColor += wT * emit;
            clebChan  += wT * v;
            clebT     *= (1.0 - aStep);

            if (clebT < 0.004) break;  // early-ray-termination
          }
        } else {
          float localAlpha = max(max(v.x, v.y), max(v.z, v.w));
          if (localAlpha > 0.01) {
            vec3 localColor = v.x * color0 + v.y * color1 + v.z * color2 + v.w * color3;
            float aStep = 1.0 - pow(max(1.0 - DVR_REF_ALPHA * localAlpha, 0.0), dvrExponent);
            accumDVR   += (1.0 - accumAlpha) * aStep * localColor;
            accumAlpha += (1.0 - accumAlpha) * aStep;
          }
        }
        t += delta;
      }

      // ── Natural Fluorescence (mode 2): luminance-only Reinhard + chroma lock ──
      if (renderMode == 2) {
        // Negligible glow → nothing to draw (mirrors the mode-1 / DVR discard).
        if (max(max(clebColor.r, clebColor.g), clebColor.b) < 0.0015) discard;

        vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);   // Rec.709 achromatic axis

        // (1) Compress LUMINANCE ONLY (extended Reinhard, knee at whitePoint).
        float Lin   = dot(clebColor, LUMA);
        float invW2 = 1.0 / max(whitePoint * whitePoint, 1e-4);
        float Lout  = Lin * (1.0 + Lin * invW2) / (1.0 + Lin);

        // (2) CHROMA LOCK: scale every channel by the SAME ratio → chromaticity is
        // invariant, so a bright single fluorophore (0,g,0) stays pure green and can
        // NEVER wash to white, no matter how intense. This is the core anti-whiteout fix.
        vec3 toned = clebColor * (Lout / max(Lin, 1e-5));

        // (3) Controlled co-localization whitening: only GENUINE 3-4 channel overlap
        // trends white; 1- and 2-channel mixes (e.g. green+red = vivid yellow) are spared
        // (coloc starts ramping past two co-present channels), and the colocGamma gate
        // suppresses a faint secondary channel so it cannot contaminate a bright primary.
        float cmax   = max(max(clebChan.x, clebChan.y), max(clebChan.z, clebChan.w));
        vec4  cn     = clebChan / max(cmax, 1e-5);
        float coloc  = clamp((cn.x + cn.y + cn.z + cn.w) - 2.0, 0.0, 1.0);
        float whiten = pow(coloc, colocGamma) * colocWhiten;
        toned = mix(toned, vec3(Lout), whiten);   // desaturate toward gray of EQUAL luminance

        // (4) Constant-luminance saturation push for fluorescent brilliance.
        vec3 fluColor = clamp(mix(vec3(Lout), toned, saturation), 0.0, 1.0);
        fragColor = vec4(fluColor, fragAlpha(fluColor, 1.0 - clebT));
        return;
      }

      vec3 finalColor;

      if (renderMode == 1) {
        float totalMIP = max(max(mip.x, mip.y), max(mip.z, mip.w));
        if (totalMIP < 0.004) discard;
        vec3 mipColor = mip.x * color0 + mip.y * color1 + mip.z * color2 + mip.w * color3;
        finalColor = mipColor * exposure;
      } else {
        if (accumAlpha < 0.01) discard;
        finalColor = accumDVR * exposure;
      }

      fragColor = vec4(finalColor, fragAlpha(finalColor, renderMode == 0 ? accumAlpha : 0.0));
    }
  `;

  /**
   * Build the scene on the canvas `containerId`.
   * options.preserveDrawingBuffer (default true): keep the last frame readable after
   *   it is presented. A page whose every capture first calls renderNow() (render and
   *   read in the same task) can pass false and spare a full-frame copy per frame.
   */
  function init(containerId, options = {}) {
    const container = document.getElementById(containerId);
    if (renderer) dispose();
    _container = container;
    _listenerAbort = typeof AbortController === 'function' ? new AbortController() : null;
    const listen = (target, type, fn, opts = {}) => target.addEventListener(type, fn, _listenerOptions(opts));

    // Setup Three.js Scene
    scene = new THREE.Scene();

    const parent = container.parentElement || container;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);

    // Camera
    camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    camera.position.z = 2.5;

    // Renderer. No multisampling: the ray-marched box is one fragment per pixel and
    // MSAA only quadrupled the colour buffer and its resolve every frame.
    const canvas = container;
    renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: options.preserveDrawingBuffer !== false
    });
    // Captures read through the canvas's own encoders always see a fresh frame.
    _installCaptureHooks(canvas);
    // ELE-18 (EDGE-001): WebGL context loss (VRAM exhaustion, driver reset/TDR, tab
    // backgrounding) must degrade gracefully (Rule 1.1). preventDefault() is REQUIRED so the
    // browser may later restore the context; we stop the render loop, free the volumes
    // (their textures died with the context) and lower the GPU budget, then reload the
    // last view at that budget once the context comes back (_recoverFromContextLoss).
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      _contextLost = true;
      if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
      console.error('[VolumeViewer] WebGL context lost - rendering paused.');
      _perf()?.event('viewer.context_lost', { quality: _qualityTarget });
      _onWebglContextLost();
      _emitQualityState({ message: 'GPU context lost — waiting for the GPU to come back', progress: 0 });
      _onContextLost?.();
    }, _listenerOptions());
    canvas.addEventListener('webglcontextrestored', () => {
      _contextLost = false;
      console.warn('[VolumeViewer] WebGL context restored - reloading the volume at a lower GPU budget.');
      _perf()?.event('viewer.context_restored', { quality: _qualityTarget });
      const reload = _recoverFromContextLoss();
      _onContextRestored?.({ reloading: Boolean(reload), reload });
      _scheduleFrame();
    }, _listenerOptions());
    renderer.setSize(w, h, false);
    renderer.setPixelRatio(_idlePixelRatio());
    renderer.setClearColor(0x000000, 1); // Force Noir Pur pour l'Additive Blending
    _lastAspect = w / h;
    _labelRasterScale = _idlePixelRatio();
    _raycaster = new THREE.Raycaster();
    _pointer = new THREE.Vector2();
    setBackgroundPreset(_displayState.backgroundPreset, _displayState.backgroundColor);

    // Material
    material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      defines: {
        ENABLE_CHANNEL_0: 1,
        ENABLE_CHANNEL_1: 1,
        ENABLE_CHANNEL_2: 1,
        ENABLE_CHANNEL_3: 1,
        HAS_OCCUPANCY: 1
      },
      uniforms: {
        svrAtlas0: { value: null },
        svrAtlas1: { value: null },
        svrAtlas2: { value: null },
        svrAtlas3: { value: null },
        svrAtlas4: { value: null },
        svrAtlas5: { value: null },
        svrAtlas6: { value: null },
        svrAtlas7: { value: null },
        mapOccupancy: { value: null },
        occupancyScale: { value: new THREE.Vector3(1, 1, 1) },
        pageTable: { value: null },
        atlasDim: { value: new THREE.Vector3(512, 512, 512) },
        volumeDim: { value: new THREE.Vector3(1, 1, 1) },
        ptDim: { value: new THREE.Vector3(1, 1, 1) },
        ptScale: { value: new THREE.Vector3(1, 1, 1) },
        brickSize: { value: VOLUME_BRICK_SIZE },
        // Atlas slot layout (SVRManager.updateUniforms): slot edge, border, components.
        slotStride: { value: VOLUME_BRICK_SIZE },
        brickApron: { value: 0 },
        svrComponents: { value: 4 },
        // Region-of-interest detail atlas (ROI_DETAIL; SVRManager role 'detail').
        detailPageTable: { value: null },
        detailAtlas0: { value: null },
        detailAtlas1: { value: null },
        detailAtlas2: { value: null },
        detailAtlas3: { value: null },
        detailAtlasDim: { value: new THREE.Vector3(1, 1, 1) },
        detailVolumeDim: { value: new THREE.Vector3(1, 1, 1) },
        detailPtDim: { value: new THREE.Vector3(1, 1, 1) },
        detailSlotStride: { value: VOLUME_BRICK_SIZE },
        detailApron: { value: 0 },
        detailPageCount: { value: 0 },
        // Voxel lattice of the bound volume: what the sampling interval is measured in.
        volumeVoxels: { value: new THREE.Vector3(1, 1, 1) },
        // 0 until an SVR manager publishes its live page count: an unpublished atlas
        // must read as "no brick", not as page 254 (see fetchVoxel).
        svrPageCount: { value: 0 },
        numChannels: { value: 0 },
        steps: { value: MAX_MARCH_STEPS },
        sampleRate: { value: IDLE_SAMPLE_RATE },
        pickPass: { value: 0 },
        renderMode: { value: 2 },  // 2 = Natural Fluorescence until a shader plugin picks one
        exposure: { value: 1.0 },  // global brightness
        // View export only (renderViewImage); inert on screen.
        fragCoordOffset: { value: new THREE.Vector2(0, 0) },
        exportAlpha: { value: 0 },
        // Natural Fluorescence (mode 2) — tuned defaults for embryo immunofluorescence.
        absorption:   { value: 1.8 },
        emissionGain: { value: 2.2 },
        whitePoint:   { value: 2.0 },
        saturation:   { value: 1.18 },
        colocWhiten:  { value: 0.5 },
        colocGamma:   { value: 2.0 },
        clipMin: { value: new THREE.Vector3(0, 0, 0) },
        clipMax: { value: new THREE.Vector3(1, 1, 1) },
        // 4D stabilisation — inert until the VOLUME_WARP define is switched on by
        // setTimepointTransform(). Identity here means "object space + 0.5", i.e. the
        // exact mapping the un-warped shader hardcodes.
        volumeWarp: { value: new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5) },
        clipBoxMin: { value: new THREE.Vector3(-0.5, -0.5, -0.5) },
        clipBoxSize: { value: new THREE.Vector3(1, 1, 1) },


        color0: { value: new THREE.Vector3(0,1,0) }, min0: { value: 0.0 }, max0: { value: 1.0 }, gamma0: { value: 1.0 }, opacity0: { value: 0.7 }, en0: { value: 1 },
        color1: { value: new THREE.Vector3(1,0,0) }, min1: { value: 0.0 }, max1: { value: 1.0 }, gamma1: { value: 1.0 }, opacity1: { value: 0.7 }, en1: { value: 1 },
        color2: { value: new THREE.Vector3(0,0,1) }, min2: { value: 0.0 }, max2: { value: 1.0 }, gamma2: { value: 1.0 }, opacity2: { value: 0.7 }, en2: { value: 1 },
        color3: { value: new THREE.Vector3(1,1,1) }, min3: { value: 0.0 }, max3: { value: 1.0 }, gamma3: { value: 1.0 }, opacity3: { value: 0.7 }, en3: { value: 1 }
      },
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending // Rend le mélange des pixels purement additif ("Néon")
    });

    // Cube Geometry
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    cube = new THREE.Mesh(geometry, material);
    scene.add(cube);
    _createCutPlaneMesh();
    _createMeasurementGroup();

    // Controls (Orbit)
    _setupInteraction(container, listen);

    // One resize path: the observer of the box the canvas fills (the window only
    // where ResizeObserver does not exist — it would fire for the same change twice).
    if (window.ResizeObserver && container.parentElement) {
      _resizeObserver = new ResizeObserver(resize);
      _resizeObserver.observe(container.parentElement);
      _observedParent = container.parentElement;
    } else {
      listen(window, 'resize', resize);
    }

    _initVolumeGrid();
    _animate();
  }

  /** Listener options tied to this init: dispose() removes them all at once. */
  function _listenerOptions(opts = {}) {
    return _listenerAbort ? { ...opts, signal: _listenerAbort.signal } : opts;
  }

  // The canvas aspect the camera was last fitted for (resize keeps the zoom).
  let _lastAspect = 1;

  function resize() {
    if (!_container || !camera || !renderer) return;
    const parent = _container.parentElement || _container;
    // The canvas can be re-parented (the slice stage moves it into the inspector's
    // square): keep watching the box it actually fills.
    if (_resizeObserver && parent !== _observedParent) {
      _resizeObserver.disconnect();
      _resizeObserver.observe(parent);
      _observedParent = parent;
    }
    const width = Math.max(1, parent.clientWidth);
    const height = Math.max(1, parent.clientHeight);
    const aspect = width / height;
    // The user's zoom is a distance relative to the one that frames the volume. A new
    // aspect changes that framing distance; the camera keeps the same ratio to it, so
    // opening a sidebar neither zooms out nor lets the volume overflow the view. The
    // framing is measured on the unrotated box, so it does not drift with the pose.
    if (_hasLoadedVolume && Math.abs(aspect - _lastAspect) > 1e-6) {
      const before = _fitDistanceForAspect(_lastAspect);
      const after = _fitDistanceForAspect(aspect);
      if (before > 0 && after > 0 && Number.isFinite(after / before)) {
        camera.position.z = Math.max(0.2, Math.min(100, camera.position.z * (after / before)));
      }
    }
    _lastAspect = aspect;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    // Drawn by the loop, not here: a resize is an interaction (reduced frames while
    // the box keeps changing), and one frame follows it.
    _markInteraction();
    _scheduleFrame();
  }

  /** Camera distance framing the unrotated volume box (cube.scale applied) at `aspect`. */
  function _fitDistanceForAspect(aspect, margin = 1.25) {
    if (!camera || !cube) return 0;
    if (!cube.geometry.boundingBox) cube.geometry.computeBoundingBox();
    const size = cube.geometry.boundingBox.getSize(new THREE.Vector3()).multiply(cube.scale);
    const verticalFov = THREE.MathUtils.degToRad(camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
    const distanceY = (Math.abs(size.y) / 2) / Math.tan(verticalFov / 2);
    const distanceX = (Math.abs(size.x) / 2) / Math.tan(horizontalFov / 2);
    return Math.max(0.2, distanceX, distanceY, Math.abs(size.z) * 1.2) * margin;
  }

  /**
   * Render the current view now, synchronously, so a capture in the same task reads
   * this frame (with preserveDrawingBuffer off the canvas is blank between frames).
   */
  function renderNow() {
    if (!renderer || !scene || !camera || _contextLost) return false;
    _syncRotGizmoTransform();
    _syncGridRotation();
    if (_cutPlaneMesh?.visible) _syncCutPlaneToOrbit();
    _updateMeasurementLabelPositions(false, _activeDragSprite);
    renderer.render(scene, camera);
    return true;
  }

  function _installCaptureHooks(canvas) {
    if (!canvas || typeof HTMLCanvasElement === 'undefined') return;
    const proto = HTMLCanvasElement.prototype;
    canvas.toDataURL = function (...args) { renderNow(); return proto.toDataURL.apply(this, args); };
    canvas.toBlob = function (...args) { renderNow(); return proto.toBlob.apply(this, args); };
  }

  function _setupInteraction(canvas, listen = (t, type, fn, o) => t.addEventListener(type, fn, o)) {
    let isDragging = false;
    let dragMode = 'rotate';
    let previousMousePosition = { x: 0, y: 0 };
    let startMousePosition = { x: 0, y: 0 };
    let _activePointerId = null; // primary pointer being tracked

    // Two-finger navigation state: { startDist, startZ, midX, midY }, null when idle.
    _activePointers.clear();
    let _gesture = null;

    let _gridDragState = null;
    let _lastInteractionClickTime = 0;
    let planeDragState = null;
    let gizmoVelocity = { yaw: 0, pitch: 0, roll: 0 };
    let inertiaFrame = null;

    // Prevent native scroll / zoom gestures on the canvas
    canvas.style.touchAction = 'none';
    canvas.style.userSelect = 'none';
    listen(canvas, 'contextmenu', (e) => e.preventDefault());

    // Helper: get offset relative to canvas
    function _offset(e) {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    // ── Two-finger navigation (touch) ─────────────────────────────────────────
    // A two-finger drag is read as one rigid screen transform: the travel of the
    // midpoint pans the volume, the ratio of the finger spacing dollies the camera.
    // One finger stays free for orientation, so no modifier is needed on a tablet.
    function _twoFingerFrame() {
      const [a, b] = [..._activePointers.values()];
      return {
        dist: Math.max(1e-3, Math.hypot(b.x - a.x, b.y - a.y)),
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2
      };
    }

    // Re-anchored on every change of finger count: the pair being measured changes
    // when a finger is added or lifted, and carrying the old reference spacing over
    // would teleport the volume.
    function _seedGesture() {
      const f = _twoFingerFrame();
      _gesture = { startDist: f.dist, startZ: camera ? camera.position.z : 2.5, midX: f.midX, midY: f.midY };
    }

    // World units per CSS pixel on the plane through the volume centre: the
    // perspective frustum is 2·tan(fov/2)·z tall at camera distance z.
    function _worldPerPixel(z) {
      return (2 * Math.tan((camera.fov * Math.PI / 180) / 2) * z) / Math.max(1, canvas.clientHeight);
    }

    // Hand an in-flight one-finger drag over to the gesture without leaving
    // half-applied state behind — a label caught mid-drag must still be committed.
    function _releaseSingleDrag() {
      if (_draggedLabelSprite) {
        _updateMeasurementLabelPositions(true, _draggedLabelSprite);
        _draggedLabelSprite = null;
        _activeDragSprite = null;
      }
      planeDragState = null;
      _gridDragState = null;
      isDragging = false;
    }

    // The finger left over when a pinch ends keeps navigating, instead of going
    // dead until the user lifts it and touches down again.
    function _resumeSingleFinger(pointerId) {
      const pt = _activePointers.get(pointerId);
      if (!pt) return;
      const rect = canvas.getBoundingClientRect();
      try { canvas.setPointerCapture(pointerId); } catch (_) { /* pointer already gone */ }
      _activePointerId = pointerId;
      dragMode = _rotationLocked ? 'pan' : 'rotate';
      isDragging = true;
      _isInteracting = true;
      previousMousePosition = { x: pt.x - rect.left, y: pt.y - rect.top };
      startMousePosition = { ...previousMousePosition };
      _markInteraction();
    }

    function _endInteraction() {
      isDragging = false;
      _isInteracting = false;
      _lastInteractionTime = 0;
      if (_interactionTimeout) {
        clearTimeout(_interactionTimeout);
        _interactionTimeout = null;
      }
      planeDragState = null;
      _scheduleFrame();
    }

    listen(canvas, 'pointerdown', (e) => {
      e.preventDefault();
      _activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

      // Two fingers or more → navigation gesture, whatever tool is active: the
      // volume must stay reachable on a tablet even in measure or cut mode.
      // A mouse never joins a gesture — one device, one pointer — so a stale touch
      // entry left by a missed pointerup can't swallow a click on a hybrid machine.
      if (e.pointerType !== 'mouse' && _activePointers.size >= 2) {
        _releaseSingleDrag();
        _seedGesture();
        _isInteracting = true;
        _markInteraction();
        _scheduleFrame();
        return;
      }

      try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic or already-ended pointer */ }
      _activePointerId = e.pointerId;

      if (!_firstInteractionLogged) {
        _firstInteractionLogged = true;
        _perf()?.event('viewer.first_interaction', { tool: _activeTool, button: e.button, shift: Boolean(e.shiftKey) });
      }
      isDragging = true;
      _isInteracting = true;
      _markInteraction();
      _scheduleFrame();
      if (inertiaFrame) { cancelAnimationFrame(inertiaFrame); inertiaFrame = null; }
      gizmoVelocity = { yaw: 0, pitch: 0, roll: 0 };

      const now = Date.now();
      const isDoubleClick = (now - _lastInteractionClickTime < 300);
      _lastInteractionClickTime = now;
      const off = _offset(e);

      // Check if user clicked a measurement label
      if (_showMeasurementLabels && _measurementSprites.length > 0) {
        // PERF-004: reuse module-level _raycaster/_pointer (synchronous, not retained)
        _pointer.set((off.x / canvas.clientWidth) * 2 - 1, -(off.y / canvas.clientHeight) * 2 + 1);
        _raycaster.setFromCamera(_pointer, camera);
        const hit = _raycaster.intersectObjects(_labelsGroup.children, false);
        if (hit && hit.length > 0) {
          dragMode = 'drag-label';
          _draggedLabelSprite = hit[0].object;
          _activeDragSprite = _draggedLabelSprite; // module-level: read by _animate
          previousMousePosition = { x: off.x, y: off.y };
          startMousePosition = { ...previousMousePosition };
          return;
        }
      }

      const interactionHit = _intersectInteractionHandles(e.clientX, e.clientY);
      if (interactionHit && e.button === 0 && !e.shiftKey) {
        if (interactionHit.object.userData.isAxesSphere) {
          if (isDoubleClick) { if (typeof VolumeGrid !== 'undefined') VolumeGrid.resetAxesPos(); isDragging = false; return; }
          dragMode = 'axes';
        } else if (interactionHit.object.userData.isGridHandle) {
          const plane = interactionHit.object.userData.plane;
          if (isDoubleClick) { if (typeof VolumeGrid !== 'undefined') VolumeGrid.resetGridSize(plane); isDragging = false; return; }
          dragMode = 'grid';
          _gridDragState = { plane, normal: interactionHit.object.userData.normal.clone(),
            startSize: (typeof VolumeGrid !== 'undefined' ? VolumeGrid.getGridSizes()[plane] : 1.5),
            startClientX: e.clientX, startClientY: e.clientY };
        }
      } else if (_activeTool === 'measure' && e.button === 0 && !e.shiftKey) {
        dragMode = 'measure';
      } else if (_activeTool === 'cut' && e.button === 0 && !e.shiftKey) {
        const planeHit = _intersectCutPlane(e.clientX, e.clientY);
        if (planeHit) {
          planeDragState = _startPlaneDrag(e.clientX, e.clientY);
          dragMode = planeDragState ? 'cut-plane' : (_rotationLocked ? 'pan' : 'rotate');
        } else { dragMode = _rotationLocked ? 'pan' : 'rotate'; }
      } else if (_activeTool === 'cut' && (e.shiftKey || e.button === 1 || e.button === 2)) {
        dragMode = 'pan';
      } else {
        // One finger (or the left button) orients the volume; panning needs shift,
        // the middle/right button — or a second finger, handled above.
        dragMode = (e.button === 1 || e.button === 2 || e.shiftKey || _rotationLocked) ? 'pan' : 'rotate';
      }
      previousMousePosition = { x: off.x, y: off.y };
      startMousePosition = { ...previousMousePosition };
    });
    
    listen(canvas, 'pointermove', (e) => {
      // Update pinch tracker
      if (_activePointers.has(e.pointerId)) {
        _activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      }

      // Two-finger pan + pinch-to-zoom, applied in the same move
      if (_gesture && _activePointers.size >= 2) {
        const f = _twoFingerFrame();
        const rect = canvas.getBoundingClientRect();
        const zPrev = camera.position.z;
        const zNext = Math.max(0.2, Math.min(100, _gesture.startZ * (_gesture.startDist / f.dist)));
        const wppPrev = _worldPerPixel(zPrev);
        const wppNext = _worldPerPixel(zNext);
        // Pan and zoom are the same equation. What the fingers hold must stay under
        // them: the volume point at the midpoint is invariant for the whole gesture.
        // A point `a` pixels from the canvas centre sits at a·wpp(z) in world units,
        // so holding (a·wpp(z) − cubePos) constant gives the update below — it pans
        // when only the midpoint moves, anchors the zoom when only the spacing does,
        // and stays exact when both change at once (which every real move does).
        const prevAnchorX = _gesture.midX - rect.left - canvas.clientWidth / 2;
        const prevAnchorY = _gesture.midY - rect.top - canvas.clientHeight / 2;
        const anchorX = f.midX - rect.left - canvas.clientWidth / 2;
        const anchorY = f.midY - rect.top - canvas.clientHeight / 2;
        cube.position.x += anchorX * wppNext - prevAnchorX * wppPrev;
        cube.position.y -= anchorY * wppNext - prevAnchorY * wppPrev;
        camera.position.z = zNext;
        _gesture.midX = f.midX;
        _gesture.midY = f.midY;
        _markInteraction();
        _notifyCameraChange();
        return;
      }

      // Only process primary pointer for drag
      if (e.pointerId !== _activePointerId && isDragging) return;
      if (isDragging) {
        _markInteraction();
      }
      const off = _offset(e);

      if (dragMode === 'drag-label' && _draggedLabelSprite && isDragging) {
        const dx = off.x - previousMousePosition.x;
        const dy = -(off.y - previousMousePosition.y); // Three.js Y is up
        
        // Convert pixel delta to world units in the camera plane
        const vFov = camera.fov * Math.PI / 180;
        const pixelToWorld = (2 * Math.tan(vFov / 2) * camera.position.z) / canvas.clientHeight;
        
        const worldDx = dx * pixelToWorld;
        const worldDy = dy * pixelToWorld;
        
        const { dirX, dirY, id, measurement } = _draggedLabelSprite.userData;
        if (measurement) {
           const deltaR = worldDx * dirX + worldDy * dirY;
           const deltaT = worldDx * (-dirY) + worldDy * dirX;
           
           measurement.labelOffset = measurement.labelOffset || { r: 0, t: 0 };
           measurement.labelOffset.r += deltaR;
           measurement.labelOffset.t += deltaT;
           
           // Pass the active sprite so repulsion radius is 0 while dragging
           _updateMeasurementLabelPositions(false, _draggedLabelSprite);
        }
        
        previousMousePosition = { x: off.x, y: off.y };
        _scheduleFrame();
        return;
      }

      // ---- hover logic (only when mouse/pen, not touch) ----
      if (e.pointerType !== 'touch' && !isDragging) {
        // Plane hover highlight (red border)
        if (_cutPlaneMesh?.visible && _activeTool === 'cut') {
          const planeHit = _intersectCutPlane(e.clientX, e.clientY);
          const wasHovered = _planeHovered;
          _planeHovered = Boolean(planeHit);
          if (_planeHovered !== wasHovered) {
            if (_planeBorderMesh) _planeBorderMesh.material.opacity = _planeHovered ? 0.9 : 0;
            if (_cutPlaneMesh) _cutPlaneMesh.material.opacity = _planeHovered ? 0.12 : 0.055;
            canvas.style.cursor = _planeHovered ? 'ns-resize' : '';
            _scheduleFrame();
          }
        }
        // PERF-020: only raycast axes/grid handles when those features are actually shown;
        // when off, interactionHit stays null and the forEach loops below clear any stale hover.
        const _axesGridActive = (typeof VolumeGrid !== 'undefined') &&
          (VolumeGrid.isAxesVisible() || VolumeGrid.getGridMode() > 0);
        const interactionHit = _axesGridActive ? _intersectInteractionHandles(e.clientX, e.clientY) : null;
        let hoverAxes = false;
        let hoverGrid = null;
        if (interactionHit) {
          if (interactionHit.object.userData.isAxesSphere) hoverAxes = true;
          else if (interactionHit.object.userData.isGridHandle) hoverGrid = interactionHit.object;
        }
        
        if (typeof VolumeGrid !== 'undefined' && VolumeGrid.getAxesGroup()) {
          VolumeGrid.getAxesGroup().children.forEach(c => {
             if (c.userData.isAxesSphere) {
                c.userData.hovered = hoverAxes;
                if (hoverAxes) { c.material.opacity = 0.4; c.scale.setScalar(1.5); }
                else { c.material.opacity = 0.0; c.scale.setScalar(1.0); }
             }
          });
        }
        if (typeof VolumeGrid !== 'undefined' && VolumeGrid.getGridGroup()) {
          VolumeGrid.getGridGroup().children.forEach(c => {
             if (c.userData.isGridHandle) {
                const hovered = (c === hoverGrid);
                c.userData.hovered = hovered;
                if (hovered) { c.material.opacity = 0.8; c.scale.setScalar(1.5); }
                else { c.material.opacity = c.userData.isParallel ? 0.4 : 0.0; c.scale.setScalar(1.0); }
             }
          });
        }
        // Label hover check
        let hoverLabel = false;
        if (_showMeasurementLabels && _measurementSprites.length > 0) {
          // PERF-004: reuse module-level _raycaster/_pointer (synchronous, not retained)
          _pointer.set((off.x / canvas.clientWidth) * 2 - 1, -(off.y / canvas.clientHeight) * 2 + 1);
          _raycaster.setFromCamera(_pointer, camera);
          const hit = _raycaster.intersectObjects(_labelsGroup.children, false);
          if (hit && hit.length > 0) hoverLabel = true;
        }

        if (hoverAxes || hoverGrid || hoverLabel) {
           canvas.style.cursor = 'grab';
           _scheduleFrame();
        } else if (canvas.style.cursor === 'grab' && !_gizmoHovered) {
           canvas.style.cursor = '';
        }
      }

      if (isDragging) {
        const deltaMove = {
          x: off.x - previousMousePosition.x,
          y: off.y - previousMousePosition.y
        };
        if (dragMode === 'grid' && _gridDragState) {
          const worldNormal = _gridDragState.normal.clone().applyQuaternion(cube.quaternion);
          // Grid starts at (-0.75, -0.75, -0.75) local
          const cornerLocal = new THREE.Vector3(-0.75, -0.75, -0.75);
          const cornerWorld = cornerLocal.applyQuaternion(cube.quaternion).add(cube.position);
          
          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(worldNormal, cornerWorld);
          
          const rect = renderer.domElement.getBoundingClientRect();
          // PERF-004: reuse module-level _raycaster/_pointer (synchronous, not retained)
          _pointer.set(((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1, -((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1);
          _raycaster.setFromCamera(_pointer, camera);
          const targetWorld = new THREE.Vector3();
          
          if (_raycaster.ray.intersectPlane(plane, targetWorld)) {
            const targetLocal = targetWorld.sub(cube.position).applyQuaternion(cube.quaternion.clone().invert());
            let rawSize = 0;
            if (_gridDragState.plane === 'xy') {
               rawSize = Math.max(targetLocal.x - (-0.75), targetLocal.y - (-0.75));
            } else if (_gridDragState.plane === 'xz') {
               rawSize = Math.max(targetLocal.x - (-0.75), targetLocal.z - (-0.75));
            } else if (_gridDragState.plane === 'yz') {
               rawSize = Math.max(targetLocal.y - (-0.75), targetLocal.z - (-0.75));
            }
            rawSize = Math.max(0, rawSize);
            const _gm = typeof VolumeGrid !== 'undefined' ? VolumeGrid.getGridMode() : 0;
            const step = 1.5 / (_gm === 2 ? 40 : 10);
            const newSize = Math.max(0, Math.round(rawSize / step) * step);
            const curSizes = typeof VolumeGrid !== 'undefined' ? VolumeGrid.getGridSizes() : {};
            if ((curSizes[_gridDragState.plane] || 0) !== newSize) {
              if (typeof VolumeGrid !== 'undefined') VolumeGrid.setGridSize(_gridDragState.plane, newSize);
            }
          }
        } else if (dragMode === 'axes') {
          _moveAxesToScreenPoint(e.clientX, e.clientY);
        } else if (dragMode === 'pan') {
          const viewHeight = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) * camera.position.z;
          const unitsPerPixel = viewHeight / Math.max(1, canvas.clientHeight);
          cube.position.x += deltaMove.x * unitsPerPixel;
          cube.position.y -= deltaMove.y * unitsPerPixel;
        } else if (dragMode === 'cut-plane') {
          _updatePlaneDrag(planeDragState, e.clientX, e.clientY);
        } else if (dragMode === 'rotate-gizmo') {
          if (planeDragState) {
            const axisName = planeDragState.axis;
            if (axisName === 'free') {
              const sensitivity = 0.42;
              const yawDelta = deltaMove.x * sensitivity;
              const pitchDelta = -deltaMove.y * sensitivity;
              gizmoVelocity = { yaw: yawDelta, pitch: pitchDelta, roll: 0 };
              _applyObliqueRotation({
                yaw: (_planeSpec.yaw || 0) + yawDelta,
                pitch: (_planeSpec.pitch || 0) + pitchDelta,
                roll: (_planeSpec.roll || 0)
              });
              previousMousePosition = { x: off.x, y: off.y };
              return;
            }
            const axisVec = new THREE.Vector3(
                axisName === 'x' ? 1 : 0,
                axisName === 'y' ? 1 : 0,
                axisName === 'z' ? 1 : 0
            ).applyQuaternion(_rotGizmo.getWorldQuaternion(new THREE.Quaternion())).normalize();
            
            // Get tangent at hit point
            const hitPoint = planeDragState.hitPoint.clone();
            const center = _rotGizmo.getWorldPosition(new THREE.Vector3());
            const toHit = hitPoint.sub(center).normalize();
            const tangent = new THREE.Vector3().crossVectors(axisVec, toHit).normalize();
            
            // Project tangent to screen space
            const p1 = _projectToScreen(center);
            const p2 = _projectToScreen(center.clone().add(tangent.multiplyScalar(0.1)));
            
            if (p1 && p2) {
                const screenTangent = { x: p2.x - p1.x, y: p2.y - p1.y };
                const mag = Math.hypot(screenTangent.x, screenTangent.y);
                if (mag > 0.0001) {
                    screenTangent.x /= mag;
                    screenTangent.y /= mag;
                    
                    // Dot product with mouse delta
                    const movement = (deltaMove.x * screenTangent.x) + (deltaMove.y * screenTangent.y);
                    const sensitivity = 2.0;
                    
                    let yaw = _planeSpec.yaw || 0;
                    let pitch = _planeSpec.pitch || 0;
                    let roll = _planeSpec.roll || 0;

                    if (axisName === 'y') yaw += movement * sensitivity;
                    if (axisName === 'x') pitch -= movement * sensitivity;
                    if (axisName === 'z') roll += movement * sensitivity;
                    gizmoVelocity = {
                      yaw: axisName === 'y' ? movement * sensitivity : 0,
                      pitch: axisName === 'x' ? -movement * sensitivity : 0,
                      roll: axisName === 'z' ? movement * sensitivity : 0
                    };

                    _applyObliqueRotation({ yaw, pitch, roll });
                }
            }
          }
        } else if (dragMode === 'measure') {
          // Allow rotation in measure mode — unless rotation is locked (e.g. Z-stack browser)
          if (!_rotationLocked) {
            _poseAnim = null;   // the user took the volume: a pose in flight yields
            const deltaRotationQuaternion = new THREE.Quaternion()
              .setFromEuler(new THREE.Euler(
                  (deltaMove.y * 1) * (Math.PI / 180),
                  (deltaMove.x * 1) * (Math.PI / 180),
                  0,
                  'XYZ'
              ));
            // Renormalised: thousands of compositions in a session would otherwise let
            // the norm drift and shear the ray basis.
            cube.quaternion.multiplyQuaternions(deltaRotationQuaternion, cube.quaternion).normalize();
          }
        } else {
          // Default: rotate — blocked when rotation is locked
          if (!_rotationLocked) {
            _poseAnim = null;   // the user took the volume: a pose in flight yields
            const deltaRotationQuaternion = new THREE.Quaternion()
              .setFromEuler(new THREE.Euler(
                  (deltaMove.y * 1) * (Math.PI / 180),
                  (deltaMove.x * 1) * (Math.PI / 180),
                  0,
                  'XYZ'
              ));
            // Renormalised: thousands of compositions in a session would otherwise let
            // the norm drift and shear the ray basis.
            cube.quaternion.multiplyQuaternions(deltaRotationQuaternion, cube.quaternion).normalize();
          }
        }
        // Notify camera sync in real time — only for moves that actually changed something
        if (!_rotationLocked && (dragMode === 'rotate' || dragMode === 'pan' || dragMode === 'measure')) {
          _notifyCameraChange();
        }
      }
      previousMousePosition = { x: off.x, y: off.y };
    });

    listen(canvas, 'pointerup', (e) => {
      _activePointers.delete(e.pointerId);
      if (_gesture) {
        if (_activePointers.size >= 2) { _seedGesture(); return; }
        _gesture = null;
        _notifyCameraChange();
        if (e.pointerId === _activePointerId) _activePointerId = null;
        const [restId] = _activePointers.keys();
        if (restId !== undefined) { _resumeSingleFinger(restId); return; }
        _endInteraction();
        return;
      }
      if (e.pointerId !== _activePointerId) return;
      _activePointerId = null;
      const off = _offset(e);
      const moved = Math.hypot(off.x - startMousePosition.x, off.y - startMousePosition.y);
      if (isDragging && dragMode === 'measure') {
        if (moved < 6 && _onMeasurePoint) {
          const point = pickVolumePoint(e.clientX, e.clientY);
          if (point) _onMeasurePoint(point);
        } else if (moved >= 6) {
          // User dragged to rotate in measure mode — notify for camera sync
          _notifyCameraChange();
        }
      } else if (isDragging && dragMode === 'drag-label') {
        if (_draggedLabelSprite) {
           _updateMeasurementLabelPositions(true, _draggedLabelSprite);
        }
        _draggedLabelSprite = null;
        _activeDragSprite = null; // clear module-level ref
      } else if (moved < 6 && (typeof VolumeGrid !== 'undefined' && VolumeGrid.isAxesVisible()) && e.button === 0 && e.shiftKey) {
        _moveAxesToScreenPoint(e.clientX, e.clientY);
      } else if (isDragging && dragMode === 'rotate-gizmo') {
        if (moved >= 6) startGizmoInertia();
      } else if (isDragging && dragMode !== 'cut-plane') {
        _notifyCameraChange();
      }
      _endInteraction();
    });

    listen(canvas, 'pointercancel', (e) => {
      _activePointers.delete(e.pointerId);
      if (_gesture) {
        if (_activePointers.size >= 2) { _seedGesture(); return; }
        _gesture = null;
        _notifyCameraChange();
      }
      if (e.pointerId === _activePointerId) {
        _activePointerId = null;
        _endInteraction();
      } else if (_activePointers.size === 0) {
        _endInteraction();
      }
    });

    listen(canvas, 'wheel', (e) => {
      e.preventDefault();
      // In cut mode: scroll over plane → move plane; otherwise zoom
      if (_activeTool === 'cut' && _cutPlane.visible && _planeHovered) {
        const direction = e.deltaY > 0 ? -1 : 1;
        setPlaneSpec({ value: _planeSpec.value + direction * 0.02, visible: true });
        _markInteraction();
        return;
      }
      // Proportional zoom, z·exp(k·Δ): one notch moves the camera by the same share of
      // its distance near or far. deltaMode 1 (lines, Firefox) and 2 (pages) are brought
      // to pixels first, so a notch is the same zoom in every browser.
      const unit = e.deltaMode === 1 ? 33 : (e.deltaMode === 2 ? Math.max(1, canvas.clientHeight || 800) : 1);
      const dy = Math.max(-600, Math.min(600, (Number(e.deltaY) || 0) * unit));
      camera.position.z = Math.max(0.2, Math.min(100, camera.position.z * Math.exp(dy * 0.0015)));
      _markInteraction();
      _scheduleFrame();
      _notifyCameraChange();
    });

    function startGizmoInertia() {
      const speed = Math.hypot(gizmoVelocity.yaw, gizmoVelocity.pitch, gizmoVelocity.roll);
      if (speed < 0.08) return;
      let velocity = { ...gizmoVelocity };
      const tick = () => {
        velocity.yaw *= 0.86;
        velocity.pitch *= 0.86;
        velocity.roll *= 0.86;
        if (Math.hypot(velocity.yaw, velocity.pitch, velocity.roll) < 0.03) {
          inertiaFrame = null;
          return;
        }
        setPlaneSpec({
          mode: 'oblique',
          ..._obliqueSpecKeepingCenter({
            yaw: (_planeSpec.yaw || 0) + velocity.yaw,
            pitch: (_planeSpec.pitch || 0) + velocity.pitch,
            roll: (_planeSpec.roll || 0) + velocity.roll
          })
        });
        inertiaFrame = requestAnimationFrame(tick);
      };
      inertiaFrame = requestAnimationFrame(tick);
    }
  }

  function _applyObliqueRotation(angles) {
    setPlaneSpec({
      mode: 'oblique',
      ..._obliqueSpecKeepingCenter(angles),
      visible: true
    });
  }

  function _obliqueSpecKeepingCenter(angles = {}) {
    const currentNormal = _normalForPlaneSpec(_planeSpec);
    const center = currentNormal.clone().multiplyScalar(_planeDepth(_planeSpec));
    const draft = {
      ..._planeSpec,
      mode: 'oblique',
      yaw: Number.isFinite(angles.yaw) ? angles.yaw : (_planeSpec.yaw || 0),
      pitch: Number.isFinite(angles.pitch) ? angles.pitch : (_planeSpec.pitch || 0),
      roll: Number.isFinite(angles.roll) ? angles.roll : (_planeSpec.roll || 0)
    };
    const nextNormal = _normalForPlaneSpec(draft);
    const nextValue = THREE.MathUtils.clamp(_planeValueAtDepth(draft, center.dot(nextNormal)), 0, 1);
    return {
      yaw: draft.yaw,
      pitch: draft.pitch,
      roll: draft.roll,
      value: nextValue
    };
  }

  /**
   * One step of the interactive quality controller. The cost of a frame is close to
   * pixels × samples, i.e. ∝ scale² · rate (scale: fraction of the idle pixel ratio,
   * rate: samples per voxel length). A frame slower than 1.3 × target shrinks the
   * resolution by sqrt(target / frame) — the factor that brings the cost back to the
   * target — down to minScale, then the sample rate by target / frame. A frame at
   * the target (≤ 1.1 × target: a vsync-paced frame says no more than that) grows
   * the rate first, then the resolution, by small steps, so the two thresholds leave
   * a band where nothing changes. Scale is quantised to 1/20 so the drawing buffer is
   * not reallocated for a 1 % change.
   * @returns {{scale:number, rate:number}} a new state (the input is not modified)
   */
  function _nextAdaptiveState(state, frameMs, targetMs = INTERACTIVE_TARGET_MS, limits = ADAPTIVE_LIMITS) {
    let scale = Math.max(limits.minScale, Math.min(limits.maxScale, Number(state?.scale) || limits.maxScale));
    let rate = Math.max(limits.minRate, Math.min(limits.maxRate, Number(state?.rate) || limits.minRate));
    if (!(frameMs > 0) || !(targetMs > 0)) return { scale, rate };
    if (frameMs > targetMs * 1.3) {
      const ratio = targetMs / frameMs;
      if (scale > limits.minScale + 1e-9) scale = Math.max(limits.minScale, scale * Math.max(0.5, Math.sqrt(ratio)));
      else rate = Math.max(limits.minRate, rate * Math.max(0.5, ratio));
    } else if (frameMs <= targetMs * 1.1) {
      if (rate < limits.maxRate - 1e-9) rate = Math.min(limits.maxRate, rate * 1.1);
      // At least one 1/20 quantum: ×1.05 alone rounds back down below 0.5, which left
      // the resolution stuck at its floor for the session after one slow frame.
      else scale = Math.min(limits.maxScale, Math.max(scale * 1.05, scale + 0.05));
    }
    scale = Math.max(limits.minScale, Math.min(limits.maxScale, Math.round(scale * 20) / 20));
    return { scale, rate };
  }

  /**
   * Sample cap per ray of a settled frame of `pixels` drawing-buffer pixels:
   * the settled budget (pixel·samples) spread over the pixels, between 256 and the
   * shader's loop bound. A ray that needs more samples than the cap is spread
   * evenly over it (see delta in the shader).
   */
  function _settledSampleCap(pixels, budgetScale = 1) {
    const p = Math.max(1, Number(pixels) || 1);
    const budget = SETTLED_PIXEL_SAMPLE_BUDGET * Math.max(0.05, Math.min(1, Number(budgetScale) || 1));
    return Math.max(256, Math.min(MAX_MARCH_STEPS, Math.floor(budget / p)));
  }

  // GPU time of a frame, read back a few frames later (EXT_disjoint_timer_query_webgl2).
  // Without the extension the controller reads the time between two consecutive
  // interactive frames, which is the frame time whenever the GPU is the bottleneck.
  const _gpuTimer = { ext: undefined, pending: [] };

  function _timerExt(gl) {
    if (_gpuTimer.ext === undefined) {
      try { _gpuTimer.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') || null; } catch (_) { _gpuTimer.ext = null; }
    }
    return _gpuTimer.ext;
  }

  function _beginGpuTimer() {
    const gl = renderer?.getContext?.();
    const ext = gl && typeof gl.createQuery === 'function' ? _timerExt(gl) : null;
    if (!ext || _gpuTimer.pending.length >= 4) return null;
    const query = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    return query;
  }

  function _endGpuTimer(query, interactive) {
    if (!query) return;
    const gl = renderer.getContext();
    gl.endQuery(_gpuTimer.ext.TIME_ELAPSED_EXT);
    _gpuTimer.pending.push({ query, interactive });
  }

  function _pollGpuTimers() {
    if (!_gpuTimer.pending.length || !renderer) return;
    const gl = renderer.getContext();
    const ext = _gpuTimer.ext;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    while (_gpuTimer.pending.length) {
      const head = _gpuTimer.pending[0];
      if (!disjoint && !gl.getQueryParameter(head.query, gl.QUERY_RESULT_AVAILABLE)) break;
      _gpuTimer.pending.shift();
      const ms = disjoint ? 0 : gl.getQueryParameter(head.query, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(head.query);
      if (!(ms > 0)) continue;
      if (head.interactive) {
        _adaptive = _nextAdaptiveState(_adaptive, ms);
      } else {
        // A settled frame past ~200 ms comes too close to the GPU watchdog: lower the
        // budget; one far under it gives some back.
        if (ms > 200) _settledBudgetScale = Math.max(0.05, _settledBudgetScale * Math.max(0.5, 150 / ms));
        else if (ms < 60) _settledBudgetScale = Math.min(1, _settledBudgetScale * 1.1);
      }
    }
  }

  function _touchPointerCount() {
    let n = 0;
    for (const p of _activePointers.values()) if (p.type && p.type !== 'mouse') n++;
    return n;
  }

  function _animate() {
    if (_contextLost) { animationId = null; return; }   // ELE-18: never draw on a lost context
    if (!renderer || !scene || !camera || !cube) { animationId = null; return; }   // disposed
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const isInteractingNow = _isInteracting || (_touchPointerCount() >= 2) || (Date.now() - _lastInteractionTime < 250);

    if (_stepPoseAnimation(now)) _needsRender = true;
    _syncRotGizmoTransform();
    _syncGridRotation();
    if (_gpuTimer.ext) _pollGpuTimers();

    // Quality of this frame: a settled frame samples every voxel at the full pixel
    // ratio within the settled budget; an interactive one follows the controller.
    // Streaming no longer degrades the picture: its redraws are only throttled.
    if (material && renderer) {
      const idleRatio = _idlePixelRatio();
      const targetRatio = isInteractingNow ? idleRatio * _adaptive.scale : idleRatio;
      if (Math.abs(renderer.getPixelRatio() - targetRatio) > 1e-6) {
        renderer.setPixelRatio(targetRatio);
        _needsRender = true;
      }
      const size = renderer.getSize(_frameSize);
      _targetSteps = _settledSampleCap(size.x * size.y * idleRatio * idleRatio, _settledBudgetScale);
      // While dragging, a tenth of the settled budget bounds the first frames too,
      // before the controller has measured anything.
      const steps = isInteractingNow
        ? _settledSampleCap(size.x * size.y * targetRatio * targetRatio, 0.1 * _settledBudgetScale)
        : _targetSteps;
      const rate = isInteractingNow ? _adaptive.rate : IDLE_SAMPLE_RATE;
      if (material.uniforms.steps.value !== steps) {
        material.uniforms.steps.value = steps;
        _needsRender = true;
      }
      if (material.uniforms.sampleRate.value !== rate) {
        material.uniforms.sampleRate.value = rate;
        _needsRender = true;
      }
      if (cube) cube.userData.isInteractingNow = isInteractingNow;
    }

    if (_frameStats.lastTs > 0) {
      const dt = Math.max(0, now - _frameStats.lastTs);
      _frameStats.samples.push(dt);
      if (_frameStats.samples.length > _frameStats.sampleWindow) _frameStats.samples.shift();
      if (_frameStats.samples.length >= 45 && (now - _frameStats.lastEmitAt) > 4000) {
        const copy = [..._frameStats.samples].sort((a, b) => a - b);
        const p50 = copy[Math.floor(copy.length * 0.5)] || 0;
        const p95 = copy[Math.floor(copy.length * 0.95)] || 0;
        const avg = copy.reduce((s, v) => s + v, 0) / Math.max(1, copy.length);
        _perf()?.event('viewer.frame_time', {
          sampleCount: copy.length,
          avgMs: Math.round(avg * 100) / 100,
          p50Ms: Math.round(p50 * 100) / 100,
          p95Ms: Math.round(p95 * 100) / 100
        });
        _frameStats.lastEmitAt = now;
      }
    }
    _frameStats.lastTs = now;

    const cameraChanged = !camera.position.equals(_lastCameraPos) || !camera.quaternion.equals(_lastCameraQuat);
    const cubeChanged = !cube.position.equals(_lastCubePos) || !cube.quaternion.equals(_lastCubeQuat);

    if (_needsRender || cameraChanged || cubeChanged) {
      try {
        if (_transitionCube) {
          _transitionCube.position.copy(cube.position);
          _transitionCube.quaternion.copy(cube.quaternion);
          _transitionCube.scale.copy(cube.scale);
        }
        if (cubeChanged && _cutPlaneMesh?.visible) _syncCutPlaneToOrbit();
        _updateMeasurementLabelPositions(false, _activeDragSprite);
      } catch (err) {
        console.warn('[VolumeViewer] Error in pre-render update:', err);
      }
      const query = _beginGpuTimer();
      renderer.render(scene, camera);
      _endGpuTimer(query, isInteractingNow);
      // Without a GPU timer: two interactive frames in consecutive animation frames
      // are as far apart as the slower of the GPU and the display refresh.
      if (!query && !_gpuTimer.ext && isInteractingNow && _lastRenderInteractive) {
        const gap = now - _lastRenderAt;
        if (gap > 0 && gap < 250) _adaptive = _nextAdaptiveState(_adaptive, gap);
      }
      _lastRenderAt = now;
      _lastRenderInteractive = isInteractingNow;
      if (_onPostRender) _onPostRender();
      _lastCameraPos.copy(camera.position);
      _lastCameraQuat.copy(camera.quaternion);
      _lastCubePos.copy(cube.position);
      _lastCubeQuat.copy(cube.quaternion);
      _needsRender = false;
      if (cameraChanged || cubeChanged) _roiSchedule('camera');
      _idleFrameCount = 0;
    } else {
      _idleFrameCount++;
      _lastRenderInteractive = false;
    }

    // Stop requestAnimationFrame loop immediately when idle to prevent GPU usage
    if (_idleFrameCount < IDLE_SLEEP_FRAMES) {
      animationId = requestAnimationFrame(_animate);
    } else {
      animationId = null;
    }
  }
  const _frameSize = new THREE.Vector2();

  /** Wake the render loop if it's sleeping */
  function _scheduleFrame() {
    _needsRender = true;
    if (!animationId && renderer && !_contextLost) {   // ELE-18: don't wake the loop on a lost context
      animationId = requestAnimationFrame(_animate);
    }
  }

  /** A redraw asked by bricks landing: at most one every STREAM_REDRAW_MS. */
  function _scheduleStreamRedraw() {
    const now = Date.now();
    const wait = STREAM_REDRAW_MS - (now - _lastStreamRedrawAt);
    if (wait <= 0) {
      _lastStreamRedrawAt = now;
      _scheduleFrame();
      return;
    }
    if (_streamRedrawTimer) return;
    _streamRedrawTimer = setTimeout(() => {
      _streamRedrawTimer = null;
      _lastStreamRedrawAt = Date.now();
      _scheduleFrame();
    }, wait);
  }

  /**
   * Load WebP slices into a 3D Texture (a dataset served as a slice stack, without
   * bricks — the fallback when brick streaming is unavailable).
   * @param {string} basePath Base path to dataset
   * @param {Object} metadata Dataset metadata
   * @param {number} timepoint Optional timepoint to load
   * @param {function} onProgress Progress callback
   */
  async function loadVolume(basePath, metadata, timepoint = null, onProgress = null, options = {}) {
    // Registered for the whole load, whatever way it ends (a throw included), so a
    // view export never waits on a load that is over (_isVolumeStreaming).
    const job = { loadId: 0 };
    _sliceLoads.add(job);
    if (!options._replay) _lastDisplayRequest = { kind: 'slices', basePath, metadata, timepoint, onProgress, options };
    try {
      return await _loadSliceVolume(basePath, metadata, timepoint, onProgress, options, job);
    } finally {
      _sliceLoads.delete(job);
    }
  }

  async function _loadSliceVolume(basePath, metadata, timepoint, onProgress, options, job) {
    const perfId = _perf()?.start('volume.load.slices', {
      quality: options.quality || '1024x1024',
      timepoint
    });
    _cancelStream(_brickStreamAbort);
    const loadId = ++_loadCounter;
    job.loadId = loadId;
    _resetThrottledProgress();
    const quality = _normalizeQualityKey(options.quality || '1024x1024');
    _emitQualityState({ active: quality, mode: 'slice', progress: 0, streaming: true, message: _t('viewer.qLoadingSlices', 'Loading {quality} slices...', { quality }) });
    const qualityInfo = _resolveQuality(metadata, quality);
    const { x: sourceWidth, y: sourceHeight, z: sourceDepth, c: channels } = metadata.dimensions;
    // EDGE-027 (Rule 1.4): reject malformed dimensions before any buffer allocation.
    // A non-finite or non-positive extent would otherwise produce a NaN/0-sized
    // Uint8Array (silent corruption) or a multi-GB over-allocation.
    if (![sourceWidth, sourceHeight, sourceDepth, channels].every(v => Number.isFinite(v) && v > 0)) {
      const msg = `Invalid volume dimensions: ${sourceWidth}x${sourceHeight}x${sourceDepth}, channels=${channels}`;
      _emitQualityState({ active: quality, mode: 'slice', progress: 0, message: msg });
      _perf()?.end(perfId, { status: 'error', reason: 'invalid-dimensions' });
      throw new Error(`[VolumeViewer] ${msg}`);
    }
    const cacheKey = _volumeCacheKey(basePath, quality, timepoint);
    const cached = options.ignoreVolumeCache ? null : _getCachedVolume(cacheKey);
    if (cached) {
      _activateVolumeEntry(cached, metadata, sourceDepth, sourceWidth, channels, options);
      if (onProgress) onProgress(1, quality);
      _emitQualityState({ active: quality, mode: 'slice', progress: 1, message: `${quality} ready from cache` });
      _perf()?.end(perfId, {
        status: 'ok',
        fromCache: true,
        quality,
        width: cached.width,
        height: cached.height,
        depth: cached.depth
      });
      return {
        stale: false,
        fromCache: true,
        quality,
        width: cached.width,
        height: cached.height,
        depth: cached.depth,
        successfulLoads: cached.successfulLoads,
        failedLoads: cached.failedLoads,
        physicalSizeUm: _physicalSizeUm,
        scaleMode: _scaleMode
      };
    }

    // The dense RGBA texture must fit both the single-3D-texture ceiling and the GPU
    // budget: a quality whose slices would pass either is loaded at the largest slice
    // size that fits (halved in X and Y until it does) and reported as downgraded.
    const zIndices = qualityInfo.zIndices || _buildSampleIndices(sourceDepth, qualityInfo.maxDepthSamples);
    const depth = zIndices.length;
    const channelCount = Math.min(channels, 4);
    const budget = _gpuBudgetBytes();
    const requestedScale = Math.min(1, qualityInfo.maxTextureSize / Math.max(sourceWidth, sourceHeight));
    let scale = requestedScale;
    let width;
    let height;
    for (;;) {
      width = Math.max(1, Math.round(sourceWidth * scale));
      height = Math.max(1, Math.round(sourceHeight * scale));
      const bytes = width * height * depth * RGBA_TEXTURE_BYTES_PER_VOXEL;
      if ((bytes < MONOLITHIC_RGBA_LIMIT_BYTES && bytes <= budget) || Math.max(width, height) <= 64) break;
      scale /= 2;
    }
    const isLive = metadata.type === 'live';
    const stamp = _sliceStamp(metadata);

    const tasks = [];
    for (let zi = 0; zi < depth; zi++) {
      for (let c = 0; c < channelCount; c++) {
        tasks.push({ zi, z: zIndices[zi], c, url: _sliceUrl(basePath, qualityInfo, isLive, timepoint, zIndices[zi], c, stamp) });
      }
    }

    const texturePerfId = _perf()?.start('texture.upload.prepare', { mode: 'slice', quality, width, height, depth });
    let texture3D;
    try {
      texture3D = _allocMonolithicTexture(width, height, depth, false);
    } catch (err) {
      _perf()?.end(texturePerfId, { status: 'error' });
      _perf()?.end(perfId, { status: 'error', quality, message: err.message });
      _emitQualityState({ active: quality, mode: 'slice', progress: 0, message: `${quality} does not fit in GPU memory` });
      throw err;
    }
    const textures = [texture3D];
    _perf()?.end(texturePerfId, { status: 'ok' });

    // The decoded slices, one byte per voxel and channel: what each slice upload is
    // interleaved from, and the raw channels the denoise filter starts from.
    const rawChannelData = Array.from(
      { length: channelCount },
      () => new Uint8Array(width * height * depth)
    );

    const entry = {
      key: cacheKey,
      textures,
      texture: texture3D,
      data: null,
      rawChannelData,
      width,
      height,
      depth,
      sourceWidth,
      sourceHeight,
      sourceDepth,
      channels: channelCount,
      zIndices,
      basePath,
      timepoint,
      quality,
      stride: RGBA_TEXTURE_BYTES_PER_VOXEL,
      gpuBytes: width * height * depth * RGBA_TEXTURE_BYTES_PER_VOXEL,
      downgraded: scale < requestedScale,
      backgroundSuppressed: true,
      successfulLoads: 0,
      failedLoads: 0,
      // Real counts arrive once the slices are in (_deferHistogramComputation).
      histograms: _channelHistograms?.length ? _channelHistograms : _emptyHistograms(channelCount)
    };
    // ELE-10 (RACE-001): a newer load (dataset / timepoint / quality switch) may
    // have bumped _loadCounter while this one was preparing. Do not publish this
    // entry (it rebinds the material uniforms + recenters the camera) on a stale load.
    if (loadId !== _loadCounter && options.cancelStale !== false) {
      _disposeVolumeEntry(entry);
      _perf()?.end(perfId, { status: 'stale', quality });
      return { stale: true };
    }
    _activateVolumeEntry(entry, metadata, sourceDepth, sourceWidth, channels, { ...options, fitCamera: !_hasLoadedVolume });
    _emitQualityState({ active: quality, mode: 'slice', progress: 0, streaming: true, message: _t('viewer.qStreamingSlices', 'Streaming {quality} slices...', { quality }) });

    let completed = 0;
    let successfulLoads = 0;
    let failedLoads = 0;
    const sliceSize = width * height;
    const channelsLanded = new Uint8Array(depth);
    const sliceScratch = new Uint8Array(sliceSize * RGBA_TEXTURE_BYTES_PER_VOXEL);
    const uploadSlice = (zi) => {
      _interleaveChannels(rawChannelData, zi * sliceSize, sliceSize, sliceScratch, RGBA_TEXTURE_BYTES_PER_VOXEL);
      _updateGPUTextureRegion(texture3D, { x: width, y: height, z: depth }, 0, 0, zi, width, height, 1, sliceScratch);
    };
    const runnerCount = Math.min(CONCURRENT_IMAGE_LOADS, tasks.length || 1);
    const readers = Array.from({ length: runnerCount }, () => _createSliceReader(width, height));
    await _runLimited(tasks, runnerCount, async ({ zi, c, url }, runnerIndex) => {
      let ok = false;
      try {
        const img = await _loadImage(url);
        try {
          const reader = readers[runnerIndex] || readers[0] || _createSliceReader(width, height);
          reader.ctx.clearRect(0, 0, width, height);
          reader.ctx.drawImage(img, 0, 0, width, height);
          const imgData = reader.ctx.getImageData(0, 0, width, height).data;
          // The R component of the decoded grayscale slice is the intensity.
          const raw = rawChannelData[c];
          for (let i = 0, src = 0, dst = zi * sliceSize; i < sliceSize; i++, src += 4, dst++) raw[dst] = imgData[src];
        } finally {
          img.close?.();
        }
        ok = true;
        successfulLoads++;
        entry.successfulLoads = successfulLoads;
      } catch (e) {
        failedLoads++;
        entry.failedLoads = failedLoads;
      } finally {
        completed++;
        // ELE-10 (RACE-001): if a newer load took over during the await, don't push
        // GPU uploads or progress for this stale load — the material / _activeVolumeEntry
        // now point at another dataset. Just let the runner drain.
        const stale = loadId !== _loadCounter && options.cancelStale !== false;
        if (!stale) {
          channelsLanded[zi]++;
          // A slice is uploaded once, when its last channel has landed (or failed).
          if (channelsLanded[zi] === channelCount) {
            uploadSlice(zi);
            if (ok || channelCount > 1) _scheduleStreamRedraw();
          }
          if (onProgress) onProgress(completed / tasks.length, quality);
          _emitThrottledProgress(completed / Math.max(1, tasks.length));
        }
      }
    });

    if (loadId !== _loadCounter && options.cancelStale !== false) {
      if (entry !== _activeVolumeEntry && !_volumeCache.has(entry.key)) _disposeVolumeEntry(entry);
      _perf()?.end(perfId, { status: 'stale', quality });
      return { stale: true };
    }
    if (tasks.length > 0 && successfulLoads === 0) {
      _perf()?.end(perfId, {
        status: 'error',
        quality,
        message: `No volume slices could be loaded from ${basePath}/${qualityInfo.directory}.`
      });
      throw new Error(`No volume slices could be loaded from ${basePath}/${qualityInfo.directory}.`);
    }
    if (failedLoads > 0) {
      _perf()?.end(perfId, {
        status: 'partial',
        quality,
        failedLoads,
        totalLoads: tasks.length
      });
      console.warn(`Volume data is incomplete: ${failedLoads} of ${tasks.length} slice files could not be loaded from ${basePath}/${qualityInfo.directory}. Rendering partial volume.`);
    }

    _scheduleFrame();
    entry.backgroundSuppressed = false;
    entry.successfulLoads = successfulLoads;
    entry.failedLoads = failedLoads;
    // A volume with holes is shown but never filed as complete: a revisit loads again.
    entry.degraded = failedLoads > 0;
    // Defer histogram computation off the critical render path
    _deferHistogramComputation(entry);
    _storeVolumeCache(cacheKey, entry);
    _activateVolumeEntry(entry, metadata, sourceDepth, sourceWidth, channels, options);
    // A denoise sigma set before the load is applied to the new volume (in workers).
    _channelSigma.forEach((sigma, c) => { if (sigma > 0.1 && c < channelCount) _applyDenoise(c, sigma, entry); });
    _emitQualityState({
      active: quality,
      mode: 'slice',
      progress: 1,
      message: failedLoads > 0
        ? `${quality} ready — ${failedLoads} of ${tasks.length} slice images missing`
        : `${quality} ready`
    });
    _perf()?.end(perfId, {
      status: 'ok',
      fromCache: false,
      quality,
      width,
      height,
      depth,
      successfulLoads,
      failedLoads
    });

    return {
      stale: false,
      quality,
      width,
      height,
      depth,
      downgraded: entry.downgraded,
      successfulLoads,
      failedLoads,
      physicalSizeUm: _physicalSizeUm,
      scaleMode: _scaleMode
    };
  }

  /** Interleave `count` voxels of every channel, from voxel `offset`, into `out`
   *  (`stride` bytes per voxel, channel c in byte c; absent channels read 0). */
  function _interleaveChannels(channelArrays, offset, count, out, stride) {
    out.fill(0);
    for (let c = 0; c < channelArrays.length && c < stride; c++) {
      const src = channelArrays[c];
      if (!src) continue;
      for (let i = 0, o = c; i < count; i++, o += stride) out[o] = src[offset + i];
    }
    return out;
  }

  /**
   * Warm the browser's HTTP cache with the slice files of a timepoint (nothing is
   * decoded or kept in memory here: the slice load decodes them when it needs them).
   */
  async function preloadVolume(basePath, metadata, timepoint = null, options = {}) {
    const quality = options.quality || '256x256';
    const qualityInfo = _resolveQuality(metadata, quality);
    const { z: sourceDepth, c: channels } = metadata.dimensions || {};
    const isLive = metadata.type === 'live';
    const zIndices = qualityInfo.zIndices || _buildSampleIndices(sourceDepth || 1, qualityInfo.maxDepthSamples);
    const stamp = _sliceStamp(metadata);
    const tasks = [];

    for (let zi = 0; zi < zIndices.length; zi++) {
      for (let c = 0; c < Math.min(channels || 1, 4); c++) {
        tasks.push(_sliceUrl(basePath, qualityInfo, isLive, timepoint, zIndices[zi], c, stamp));
      }
    }

    const maxImages = Number.isFinite(options.maxImages) ? Math.max(1, options.maxImages) : tasks.length;
    const selected = _sampleArray(tasks, maxImages);
    let successfulLoads = 0;
    let failedLoads = 0;
    await _runLimited(selected, options.concurrency || PRELOAD_IMAGE_LOADS, async (url) => {
      try {
        await _prefetchSliceFile(url);
        successfulLoads++;
      } catch (err) {
        failedLoads++;
      }
    });
    return { quality, requested: selected.length, successfulLoads, failedLoads };
  }

  function computePhysicalScale(metadata, sourceDepth, sourceWidth) {
    const dims = metadata.dimensions || {};
    const vs = metadata.voxel_size || {};
    const sourceHeight = Number(dims.y) || sourceWidth || 1;
    const originalWidth = Number(dims.original_x) || sourceWidth || 1;
    const originalHeight = Number(dims.original_y) || sourceHeight || 1;
    const vx = _positiveNumber(vs.x);
    const vy = _positiveNumber(vs.y);
    const vz = _positiveNumber(vs.z ?? metadata.z_spacing_um ?? metadata.z_spacing);
    const hasRawVoxelValues = vx !== null && vy !== null && vz !== null;
    const looksLikePlaceholderVoxel = hasRawVoxelValues
      && Math.abs(vx - 1) < 1e-9
      && Math.abs(vy - 1) < 1e-9
      && Math.abs(vz - 1) < 1e-9
      && !_positiveNumber(metadata.optical_section_thickness_um)
      && !_positiveNumber(metadata.slice_thickness_um);
    const hasVoxelMetadata = hasRawVoxelValues && !looksLikePlaceholderVoxel;

    let webVx = vx || 1;
    let webVy = vy || webVx;

    const rawVx = originalWidth > sourceWidth
      ? webVx * (sourceWidth / originalWidth)
      : webVx;
    const physicalX = sourceWidth * webVx;
    const physicalY = sourceHeight * webVy;
    const thicknessMeta = _positiveNumber(metadata.optical_section_thickness_um)
      ?? _positiveNumber(metadata.slice_thickness_um)
      ?? _positiveNumber(metadata.section_thickness_um);
    const sliceThickness = _resolveSliceThickness(metadata, vz || 1, rawVx || webVx || 1);
    const zCount = Math.max(1, Number(sourceDepth) || 1);
    const physicalZ = zCount <= 1
      ? sliceThickness
      : ((zCount - 1) * (vz || 1)) + sliceThickness;
    const reference = Math.max(physicalX, physicalY, 1);
    const calibrationStatus = hasVoxelMetadata
      ? (thicknessMeta !== null ? 'exact' : 'estimated')
      : (vx !== null || vy !== null || vz !== null ? 'estimated' : 'metadata-missing');
    const calibrationNote = calibrationStatus === 'exact'
      ? 'Microscope voxel size and slice thickness metadata were used.'
      : calibrationStatus === 'estimated'
        ? 'Physical calibration was estimated from available voxel metadata and slice spacing.'
        : 'Microscope calibration metadata is missing.';

    return {
      scale: {
        x: physicalX / reference,
        y: physicalY / reference,
        z: Math.max(0.01, physicalZ / reference)
      },
      physicalSizeUm: {
        x: physicalX,
        y: physicalY,
        z: physicalZ,
        sliceThickness,
        voxelX: webVx,
        voxelY: webVy,
        voxelZ: vz || 1,
        rawVoxelX: rawVx || webVx || 1,
        originalX: originalWidth,
        originalY: originalHeight,
        calibrationStatus,
        calibrationNote
      },
      mode: calibrationStatus === 'exact' ? 'physical' : (calibrationStatus === 'estimated' ? 'estimated' : 'metadata-missing')
    };
  }

  function _resolveSliceThickness(metadata, zSpacing, rawVoxelX) {
    const explicit = _positiveNumber(metadata.optical_section_thickness_um)
      ?? _positiveNumber(metadata.slice_thickness_um)
      ?? _positiveNumber(metadata.section_thickness_um);
    if (explicit !== null) return explicit;
    return Math.min(zSpacing, rawVoxelX);
  }

  function _positiveNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function _applyDisplayScale() {
    if (!cube) return;
    cube.scale.set(_baseScale.x, _baseScale.y, _baseScale.z * _zDisplayScale);
    // The measurement frame undoes this stretch: its points move with it.
    if (_syncMeasurementFrame()) _renderMeasurements();
    _updateCutPlaneMesh();
    _scheduleFrame();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 4D stabilisation
  //
  // A timelapse is acquired while the specimen drifts and rotates. The cell tracking
  // that accompanies it is stabilised — the analysis removes that global motion — and
  // because the motion is a RIGID one, the same transform re-expresses the images in
  // the stabilised frame. We apply it to the sampling coordinate in the shader rather
  // than resampling voxels: exact, free, and reversible.
  //
  // It deliberately does NOT touch cube.position / cube.quaternion: those are the orbit
  // controls, they are what getCameraState() serialises, and folding a per-frame matrix
  // into them would fight the user's interaction and corrupt saved workspaces.
  // ─────────────────────────────────────────────────────────────────────────────

  // Acquisition box in um and the display box the geometry must cover, both resolved
  // once per dataset by setStabilizationSpace().
  let _acqExtent = null;      // { min: Vector3, max: Vector3, size: Vector3 }
  let _displayBox = null;     // { min: Vector3, max: Vector3 } in um, stabilised frame
  let _warpActive = false;

  function _objectFromUm(v, out) {
    // p_um = acqMin + (o + 0.5) * acqSize   =>   o = (p_um - acqMin) / acqSize - 0.5
    return out.set(
      (v.x - _acqExtent.min.x) / _acqExtent.size.x - 0.5,
      (v.y - _acqExtent.min.y) / _acqExtent.size.y - 0.5,
      (v.z - _acqExtent.min.z) / _acqExtent.size.z - 0.5
    );
  }

  /** Declare the acquisition box and the (larger) box the stabilised series sweeps. */
  function setStabilizationSpace(extentUm, displayBoxUm) {
    // Without a stabilisation space the cube is the unit acquisition box again — a
    // dataset opened after a stabilised timelapse must not inherit its larger box.
    const clear = () => {
      _acqExtent = null;
      _displayBox = null;
      if (!cube || cube.userData.boxKey === undefined || cube.userData.boxKey === 'unit') return;
      _clearTransitionVolume();
      const previous = cube.geometry;
      cube.geometry = new THREE.BoxGeometry(1, 1, 1);
      cube.userData.boxKey = 'unit';
      previous?.dispose?.();
      if (material?.uniforms?.clipBoxMin) {
        material.uniforms.clipBoxMin.value.set(-0.5, -0.5, -0.5);
        material.uniforms.clipBoxSize.value.set(1, 1, 1);
      }
      if (_cutPlaneMesh?.visible) _syncCutPlaneToOrbit();
      _scheduleFrame();
    };
    if (!extentUm) { clear(); return; }
    const min = new THREE.Vector3().fromArray(extentUm.min);
    const max = new THREE.Vector3().fromArray(extentUm.max);
    const size = new THREE.Vector3().subVectors(max, min);
    if (!(size.x > 0 && size.y > 0 && size.z > 0)) {
      console.warn('[VolumeViewer] degenerate acquisition extent, stabilisation disabled');
      clear(); return;
    }
    _acqExtent = { min, max, size };
    _displayBox = displayBoxUm
      ? { min: new THREE.Vector3().fromArray(displayBoxUm.min),
          max: new THREE.Vector3().fromArray(displayBoxUm.max) }
      : { min: min.clone(), max: max.clone() };
    _rebuildCubeGeometry();
  }

  /** Resize the cube so it encloses the display box, keeping cube.scale untouched.
   *  The grid, the scale bar, the cut plane and the camera framing all mirror
   *  cube.scale — growing the geometry instead leaves every one of them intact. */
  function _rebuildCubeGeometry() {
    if (!cube || !_acqExtent || !_displayBox) return;
    const lo = _objectFromUm(_displayBox.min, new THREE.Vector3());
    const hi = _objectFromUm(_displayBox.max, new THREE.Vector3());
    const size = new THREE.Vector3().subVectors(hi, lo);
    const center = new THREE.Vector3().addVectors(hi, lo).multiplyScalar(0.5);

    const unit = Math.abs(size.x - 1) < 1e-6 && Math.abs(size.y - 1) < 1e-6 &&
                 Math.abs(size.z - 1) < 1e-6 && center.lengthSq() < 1e-12;
    const wanted = unit ? 'unit' : `${size.x},${size.y},${size.z},${center.x},${center.y},${center.z}`;
    if (cube.userData.boxKey === wanted) return;

    // A cross-fade clone shares this geometry — retire it before disposing.
    _clearTransitionVolume();
    const previous = cube.geometry;
    const geom = new THREE.BoxGeometry(size.x, size.y, size.z);
    if (!unit) geom.translate(center.x, center.y, center.z);
    cube.geometry = geom;
    cube.userData.boxKey = wanted;
    previous?.dispose?.();

    if (material?.uniforms?.clipBoxMin) {
      material.uniforms.clipBoxMin.value.copy(lo);
      material.uniforms.clipBoxSize.value.copy(size);
    }
    if (_cutPlaneMesh?.visible) _syncCutPlaneToOrbit();
    _scheduleFrame();
  }

  /** Apply one timepoint's rigid transform, or null to render the acquisition frame.
   *  @param {number[]|null} matrix column-major 4x4 mapping raw um -> stabilised um. */
  function setTimepointTransform(matrix) {
    if (!material) return false;
    // A rigid transform has det ±1; a singular or non-finite one would invert to a
    // zero/NaN warp and the volume would vanish. Such a frame is shown unwarped.
    let valid = Boolean(matrix);
    if (valid) {
      const values = Array.isArray(matrix) || ArrayBuffer.isView(matrix) ? Array.from(matrix) : null;
      valid = Boolean(values) && values.length === 16 && values.every(Number.isFinite)
        && Math.abs(new THREE.Matrix4().fromArray(values).determinant()) > 1e-9;
      if (!valid) console.warn('[VolumeViewer] invalid timepoint transform ignored (not a finite invertible 4x4 matrix)');
    }
    const enable = valid && Boolean(_acqExtent);
    if (!enable) {
      if (_warpActive) {
        _warpActive = false;
        delete material.defines.VOLUME_WARP;
        material.needsUpdate = true;
        if (typeof VolumeGrid !== 'undefined') VolumeGrid.rebuild?.();
        // The cut plane's value sweeps the display box only while warped (_planeSweep).
        if (_cutPlaneMesh?.visible) _syncCutPlaneToOrbit();
        _scheduleFrame();
      }
      return false;
    }

    const S = _acqExtent.size, A = _acqExtent.min;
    // object -> display um
    const toUm = new THREE.Matrix4().makeScale(S.x, S.y, S.z)
      .premultiply(new THREE.Matrix4().makeTranslation(
        A.x + 0.5 * S.x, A.y + 0.5 * S.y, A.z + 0.5 * S.z));
    // stabilised um -> raw um (the inverse of what the tracking applied)
    const toRaw = new THREE.Matrix4().fromArray(matrix).invert();
    // raw um -> texture coordinate
    const toTex = new THREE.Matrix4().makeTranslation(-A.x, -A.y, -A.z)
      .premultiply(new THREE.Matrix4().makeScale(1 / S.x, 1 / S.y, 1 / S.z));

    material.uniforms.volumeWarp.value.copy(toTex).multiply(toRaw).multiply(toUm);
    if (!_warpActive) {
      _warpActive = true;
      material.defines.VOLUME_WARP = 1;
      material.needsUpdate = true;
      if (typeof VolumeGrid !== 'undefined') VolumeGrid.rebuild?.();
      if (_cutPlaneMesh?.visible) _syncCutPlaneToOrbit();
    }
    if (_transitionMaterial?.uniforms?.volumeWarp) {
      _transitionMaterial.uniforms.volumeWarp.value.copy(material.uniforms.volumeWarp.value);
    }
    _scheduleFrame();
    return true;
  }

  function isStabilized() { return _warpActive; }

  function _resolveQuality(metadata, quality) {
    const safeQuality = _normalizeQualityKey(quality);
    const preset = { ...(QUALITY_PRESETS[safeQuality] || QUALITY_PRESETS.high) };
    const fromCatalog = metadata.qualities?.[safeQuality] || {};
    const zIndices = fromCatalog.zIndices || fromCatalog.z_indices;

    return {
      directory: fromCatalog.directory || preset.directory,
      maxTextureSize: fromCatalog.maxTextureSize || fromCatalog.max_texture_size || preset.maxTextureSize,
      maxDepthSamples: fromCatalog.maxDepthSamples || fromCatalog.max_depth_samples || preset.maxDepthSamples,
      zIndices: Array.isArray(zIndices) ? zIndices.map(Number) : null
    };
  }

  function _t(key, fallback, params) {
    if (typeof I18n !== 'undefined' && typeof I18n.t === 'function') {
      const v = I18n.t(key, params);
      if (typeof v === 'string' && v !== key) return v;
    }
    return String(fallback).replace(/\{(\w+)\}/g, (m, k) => (params && params[k] !== undefined ? params[k] : m));
  }

  function _activateVolumeEntry(entry, metadata, sourceDepth, sourceWidth, channels, options = {}) {
    // SVR-014: an entry whose manager has already been released cannot be shown —
    // its atlases have no GPU texture left. Refuse it here rather than half-binding
    // the material, and say so, instead of rendering a saturated box that reads as
    // a real (and wrong) signal. Rule 1.1: never mount data we cannot vouch for.
    if (entry.disposed || (entry.svrManager
        && typeof entry.svrManager.isUsable === 'function'
        && !entry.svrManager.isUsable())) {
      console.error('[VolumeViewer] Refusing to activate a volume whose GPU textures were already released; keeping the previous volume on screen.');
      _emitQualityState({ message: `${entry.quality || 'volume'} dropped (GPU atlas released before display)` });
      return false;
    }
    const previous = _activeVolumeEntry;
    // Detail bricks belong to the volume they refine: another volume drops them.
    if (_roi && _roi.entry !== entry) _roiTeardown('volume-changed');
    if (entry.svrManager) {
      // The manager it replaces belongs to `previous`, released below unless cached.
      _svrManager = entry.svrManager;
      _svrManager.material = material;
      _svrManager.updateUniforms();
    } else {
      // A dense 3D texture next: no atlas define may stay (a compressed atlas's
      // SVR_ARRAY would declare the pages sampler2DArray).
      SVRManager.clearAtlasDefines(material);
      _svrManager = null;
    }
    const scaleInfo = computePhysicalScale(metadata, sourceDepth, sourceWidth);
    _baseScale.set(scaleInfo.scale.x, scaleInfo.scale.y, scaleInfo.scale.z);
    _physicalSizeUm = scaleInfo.physicalSizeUm;
    _scaleMode = scaleInfo.mode;
    if (entry.histograms && entry.histograms.length) {
      const currentBins = _channelHistograms?.[0]?.bins || 0;
      const newBins = entry.histograms[0].bins || 0;
      if (newBins >= currentBins || entry.histogramsExact) {
        _channelHistograms = entry.histograms;
      }
    }
    _activeTextureKey = entry.key || null;
    _activeVolumeEntry = entry;
    const textures = entry.textures || [];
    _applyDisplayScale();

    // On the SVR path updateUniforms() above is authoritative: it binds all EIGHT
    // atlas pages plus the page table as one consistent set. Only the monolithic path
    // binds a texture here, and there entry.texture IS the single dense volume.
    if (!entry.svrManager) {
      material.uniforms.svrAtlas0.value = entry.texture || textures[0] || null;
      material.uniforms.svrAtlas1.value = textures[1] || textures[0] || entry.texture || null;
      material.uniforms.svrAtlas2.value = textures[2] || textures[0] || entry.texture || null;
      material.uniforms.svrAtlas3.value = textures[3] || textures[0] || entry.texture || null;
      if (material.uniforms.svrPageCount) material.uniforms.svrPageCount.value = 0;
    }
    material.uniforms.volumeVoxels.value.set(Math.max(1, entry.width || 1), Math.max(1, entry.height || 1), Math.max(1, entry.depth || 1));
    if (entry.occupancyMap) {
      material.defines.HAS_OCCUPANCY = 1;
      material.uniforms.mapOccupancy.value = entry.occupancyMap;
      if (material.uniforms.occupancyScale && entry.occupancyScale) {
        material.uniforms.occupancyScale.value.copy(entry.occupancyScale);
      }
    } else {
      delete material.defines.HAS_OCCUPANCY;
      if (material.uniforms.mapOccupancy) {
        material.uniforms.mapOccupancy.value = null;
      }
    }
    material.needsUpdate = true;
    material.uniforms.numChannels.value = Math.min(channels, 4);

    _recompileShaderForActiveChannels();

    if (!_hasLoadedVolume || options.fitCamera) {
      fitCameraToVolume();
      _hasLoadedVolume = true;
    }

    // The volume it replaces is freed now unless the cache keeps it (a native atlas,
    // a volume with dropped bricks, a superseded slice load): nothing else refers to it.
    if (previous && previous !== entry && !_isEntryCached(previous) && previous !== _transitionEntry) {
      _disposeVolumeEntry(previous);
    }
    // What stays resident is re-evaluated against the budget with this volume counted.
    _trimVolumeCache(entry);
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('volume-capabilities', { detail: getCapabilities() }));
    }
    return true;
  }

  // Uniforms that describe ONE volume (its textures and their layout). A cross-fade
  // material has its own; every other uniform — channels, exposure, render mode,
  // step count, clip box, warp — is the very object the main material holds, so a
  // change made during a transition shows on both cubes.
  const PER_VOLUME_UNIFORMS = new Set([
    'svrAtlas0', 'svrAtlas1', 'svrAtlas2', 'svrAtlas3', 'svrAtlas4', 'svrAtlas5', 'svrAtlas6', 'svrAtlas7',
    'mapOccupancy', 'occupancyScale', 'pageTable', 'atlasDim', 'volumeDim', 'ptDim', 'ptScale', 'brickSize',
    'svrPageCount', 'numChannels', 'volumeVoxels', 'slotStride', 'brickApron', 'svrComponents'
  ]);

  function _createTransitionMaterial() {
    if (!material) return null;
    const uniforms = {};
    for (const [key, u] of Object.entries(material.uniforms)) {
      if (!PER_VOLUME_UNIFORMS.has(key)) { uniforms[key] = u; continue; }
      const v = u.value;
      uniforms[key] = { value: v && typeof v.clone === 'function' && !v.isTexture ? v.clone() : v };
    }
    // The detail atlas belongs to the volume on screen, never to the one fading in.
    const defines = { ...(material.defines || {}) };
    delete defines.ROI_DETAIL;
    delete defines.ROI_DETAIL_COMPONENTS;
    const transition = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      defines,
      uniforms,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending
    });
    transition.visible = material.visible;
    return transition;
  }

  function _beginTransitionVolume(entry = null, channels = 4) {
    if (!scene || !cube || !material) return null;
    _clearTransitionVolume();
    _transitionMaterial = _createTransitionMaterial();
    if (!_transitionMaterial) return null;
    _transitionCube = new THREE.Mesh(cube.geometry, _transitionMaterial);
    _transitionCube.position.copy(cube.position);
    _transitionCube.quaternion.copy(cube.quaternion);
    _transitionCube.scale.copy(cube.scale);
    _transitionCube.renderOrder = (cube.renderOrder || 0) + 10;
    scene.add(_transitionCube);
    if (entry) _bindTransitionEntry(entry, channels);
    _scheduleFrame();
    return _transitionMaterial;
  }

  function _bindTransitionEntry(entry, channels = 4) {
    if (!_transitionMaterial || !entry) return;
    _transitionEntry = entry;
    const textures = entry.textures || [];
    if (entry.svrManager) {
      entry.svrManager.material = _transitionMaterial;
      entry.svrManager.updateUniforms();
    } else {
      SVRManager.clearAtlasDefines(_transitionMaterial);
      _transitionMaterial.uniforms.svrAtlas0.value = entry.texture || textures[0] || null;
      _transitionMaterial.uniforms.svrAtlas1.value = textures[1] || textures[0] || entry.texture || null;
      _transitionMaterial.uniforms.svrAtlas2.value = textures[2] || textures[0] || entry.texture || null;
      _transitionMaterial.uniforms.svrAtlas3.value = textures[3] || textures[0] || entry.texture || null;
      _transitionMaterial.uniforms.svrPageCount.value = 0;
    }
    _transitionMaterial.uniforms.volumeVoxels.value.set(Math.max(1, entry.width || 1), Math.max(1, entry.height || 1), Math.max(1, entry.depth || 1));
    if (entry.occupancyMap) {
      _transitionMaterial.defines.HAS_OCCUPANCY = 1;
      _transitionMaterial.uniforms.mapOccupancy.value = entry.occupancyMap;
      if (_transitionMaterial.uniforms.occupancyScale && entry.occupancyScale) {
        _transitionMaterial.uniforms.occupancyScale.value.copy(entry.occupancyScale);
      }
    } else {
      delete _transitionMaterial.defines.HAS_OCCUPANCY;
      if (_transitionMaterial.uniforms.mapOccupancy) _transitionMaterial.uniforms.mapOccupancy.value = null;
    }
    _transitionMaterial.uniforms.numChannels.value = Math.min(channels, 4);
    _transitionMaterial.needsUpdate = true;
    _scheduleFrame();
  }

  function _clearTransitionVolume() {
    if (_transitionCube && scene) scene.remove(_transitionCube);
    _transitionMaterial?.dispose?.();
    _transitionCube = null;
    _transitionMaterial = null;
    _transitionEntry = null;
    _scheduleFrame();
  }

  /** Version stamp of a dataset's slice files (its metadata's modification time), so a
   *  re-generated stack is fetched again instead of served stale from the cache. */
  function _sliceStamp(metadata) {
    const v = metadata?.lastModified || metadata?.updated || metadata?.created || '';
    return v ? String(v) : '';
  }

  function _sliceUrl(basePath, qualityInfo, isLive, timepoint, z, c, stamp = '') {
    const filename = isLive
      ? `t${String(timepoint).padStart(3, '0')}_z${String(z).padStart(3, '0')}_c${c}.webp`
      : `z${String(z).padStart(3, '0')}_c${c}.webp`;
    return `${basePath}/${qualityInfo.directory}/${filename}${stamp ? `?v=${encodeURIComponent(stamp)}` : ''}`;
  }

  function _createSliceReader(width, height) {
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return { canvas, ctx };
  }

  function _volumeCacheKey(basePath, quality, timepoint) {
    return `${basePath}|${timepoint === null || timepoint === undefined ? 'fixed' : timepoint}|${quality}`;
  }

  function _getCachedVolume(key) {
    const entry = _volumeCache.get(key);
    if (!entry) return null;
    if (entry.disposed) { _volumeCache.delete(key); return null; }
    _volumeCache.delete(key);
    _volumeCache.set(key, entry);
    return entry;
  }

  function _isEntryCached(entry) {
    if (!entry) return false;
    return _volumeCache.get(entry.key) === entry;
  }

  function _isSvrManagerCached(manager) {
    if (!manager) return false;
    for (const entry of _volumeCache.values()) {
      if (entry?.svrManager === manager) return true;
    }
    return false;
  }

  function _shouldCacheVolumeEntry(entry) {
    if (entry?.degraded) return false;
    if (!entry?.svrManager) return true;
    const quality = _normalizeQualityKey(entry.quality || '');
    if (quality === 'native' || quality === '4096x4096') return Boolean(window.VolumeViewerDebug?.cacheNativeSvr);
    return true;
  }

  /** Release every GPU resource an entry owns, and the CPU copies it holds. One
   *  helper, called from every path that drops an entry — eviction, replacement,
   *  refusal, abandoned stream, context loss, teardown. `force` releases the entry on
   *  screen too (context loss, dispose). */
  function _disposeVolumeEntry(entry, { force = false } = {}) {
    if (!entry || entry.disposed) return;
    if (entry === _activeVolumeEntry && !force) return;
    const mgr = entry.svrManager;
    if (mgr) {
      const inUse = _activeVolumeEntry?.svrManager === mgr || _transitionEntry?.svrManager === mgr
        || [..._volumeCache.values()].some(e => e !== entry && e.svrManager === mgr);
      if (force || !inUse) {
        mgr.dispose();
        if (_svrManager === mgr) _svrManager = null;
      }
    }
    if (Array.isArray(entry.textures) && !entry.svrManager) entry.textures.forEach(t => t?.dispose?.());
    entry.occupancyMap?.dispose?.();
    entry.occupancyMap = null;
    entry.data = null;
    entry.rawChannelData = null;
    entry.channelData = null;
    entry.disposed = true;
  }

  /** VRAM an entry holds: its atlas (SVR) or its dense texture. */
  function _entryGpuBytes(entry) {
    if (!entry) return 0;
    if (entry.svrManager) return (entry.svrManager.atlasBytes || 0) + (entry.svrManager.pageData?.length || 0);
    if (Number.isFinite(entry.gpuBytes)) return entry.gpuBytes;
    return (entry.width || 0) * (entry.height || 0) * (entry.depth || 0) * (entry.stride || RGBA_TEXTURE_BYTES_PER_VOXEL);
  }

  /** JS memory an entry holds: the raw channels and filtered copies the denoise
   *  filter keeps, and a CPU mirror where one exists. */
  function _entryCpuBytes(entry) {
    if (!entry) return 0;
    let bytes = entry.data?.length || 0;
    const raw = entry.rawChannelData || [];
    for (const a of raw) bytes += a?.length || 0;
    for (const [c, a] of (entry.channelData || []).entries()) if (a && a !== raw[c]) bytes += a.length;
    return bytes;
  }

  /** An entry's real footprint, GPU and CPU together, as the cache budget counts it. */
  function _entryBytes(entry) {
    return _entryGpuBytes(entry) + _entryCpuBytes(entry);
  }

  function _storeVolumeCache(key, entry) {
    if (!_shouldCacheVolumeEntry(entry)) {
      const orphan = _volumeCache.get(key);
      // A degraded volume never replaces a complete one already filed under its key.
      if (orphan && orphan !== entry && !entry?.degraded) {
        _volumeCache.delete(key);
        _disposeVolumeEntry(orphan);
      }
      return;
    }
    const previous = _volumeCache.get(key);
    if (previous && previous !== entry) {
      _volumeCache.delete(key);
      _disposeVolumeEntry(previous);
    }
    _volumeCache.set(key, entry);
    _trimVolumeCache(entry);
  }

  /** The VRAM budget of this page (SVRManager.vramBudget: GPU class, device memory,
   *  recent context losses, an operator override). */
  function _gpuBudgetBytes() {
    const fallback = 1024 * 1024 * 1024;
    if (typeof SVRManager === 'undefined' || typeof SVRManager.vramBudget !== 'function') return fallback;
    try {
      const b = SVRManager.vramBudget(renderer).bytes;
      return Number.isFinite(b) && b > 0 ? b : fallback;
    } catch (e) {
      return fallback;
    }
  }

  /** How much the volume cache may hold besides the volume on screen: 40 % of the VRAM
   *  budget, between 128 and 768 MiB (768 MiB keeps ~12 frames of a 512² timelapse).
   *  @param {number} [vramBytes] the VRAM budget (default: this page's). */
  function _volumeCacheBudget(vramBytes = _gpuBudgetBytes()) {
    const MiB = 1024 * 1024;
    return Math.min(768 * MiB, Math.max(128 * MiB, Math.floor(Number(vramBytes) * 0.4) || 0));
  }

  /** VRAM held by every volume texture of this page right now: the SVR atlases of
   *  every live manager (the Studio's included) and the dense textures of the cached,
   *  displayed and cross-fading volumes. */
  function _residentGpuBytes() {
    let dense = 0;
    const seen = new Set();
    const add = (e) => {
      if (!e || seen.has(e) || e.disposed) return;
      seen.add(e);
      if (!e.svrManager) dense += _entryGpuBytes(e);
    };
    for (const e of _volumeCache.values()) add(e);
    add(_activeVolumeEntry);
    add(_transitionEntry);
    const svr = typeof SVRManager !== 'undefined' && typeof SVRManager.liveAtlasBytes === 'function'
      ? SVRManager.liveAtlasBytes() : 0;
    return dense + svr;
  }

  /**
   * Make room for an allocation of `bytes`: cached volumes other than the one on
   * screen are evicted (in _evictionVictim order) until the budget holds it.
   * @returns {{ budget:number, resident:number, available:number }}
   */
  function _freeGpuFor(bytes) {
    const budget = _gpuBudgetBytes();
    let guard = 0;
    while (_residentGpuBytes() + bytes > budget && guard++ < 4096) {
      const key = _evictionVictim(null);
      if (!key) break;
      const victim = _volumeCache.get(key);
      _volumeCache.delete(key);
      _disposeVolumeEntry(victim);
    }
    const resident = _residentGpuBytes();
    return { budget, resident, available: Math.max(0, budget - resident) };
  }

  // Where playback currently is, so eviction can keep the frames we are about to
  // need instead of the ones we just left.
  let _playhead = { basePath: null, quality: null, frame: 0, total: 0 };

  function setPlayheadHint(basePath, quality, frame, total) {
    _playhead = {
      basePath: basePath || null,
      quality: _normalizeQualityKey(quality || ''),
      frame: Number.isFinite(frame) ? frame : 0,
      total: Number.isFinite(total) && total > 0 ? total : 0
    };
  }

  function _cachedBytes() {
    let sum = 0;
    for (const entry of _volumeCache.values()) sum += _entryBytes(entry);
    return sum;
  }

  /** Pick what to drop when the budget is exceeded.
   *
   *  NOT least-recently-used. Playing a 30-frame series in a cache that holds 14 is
   *  the textbook worst case for LRU on a cyclic scan: the frame you ask for next is
   *  always the one just evicted, so the hit rate collapses to ~0 % and every single
   *  frame is a fresh ~600 ms stream. That — not the cache key, which has been per
   *  (dataset, timepoint, quality) all along — is why native "reloads on every frame".
   *
   *  Order: another quality first (biggest first, since a native entry frees 14x what
   *  a 256 one does), then, within the quality being played, the frame we will reach
   *  LAST — the greatest cyclic distance ahead of the playhead. That keeps a
   *  contiguous window in front of the head, which is what a video buffer is. */
  function _evictionVictim(protectedEntry = null) {
    let worst = null;
    let worstRank = -Infinity;
    for (const [key, entry] of _volumeCache) {
      if (key === _activeTextureKey || entry === _activeVolumeEntry || entry === _transitionEntry) continue;
      // SVR-014: the entry that was JUST stored and is about to be activated is not
      // yet _activeVolumeEntry; freeing an entry one line before showing it is never
      // right, whatever the budget says.
      if (protectedEntry && entry === protectedEntry) continue;
      const quality = _normalizeQualityKey(entry?.quality || '');
      const sameSeries = entry?.basePath === _playhead.basePath && quality === _playhead.quality;
      let rank;
      if (!sameSeries) {
        // Foreign quality/dataset: cheapest thing to lose, biggest first.
        rank = 1e15 + _entryBytes(entry);
      } else if (_playhead.total > 0 && Number.isFinite(entry?.timepoint)) {
        rank = (entry.timepoint - _playhead.frame + _playhead.total) % _playhead.total;
      } else {
        rank = 0;
      }
      if (rank > worstRank) { worstRank = rank; worst = key; }
    }
    return worst;
  }

  /**
   * Keep the cache within its budget (_volumeCacheBudget) AND everything resident —
   * cache plus the volume on screen when the cache does not hold it (a native atlas)
   * — within the VRAM budget. Budgets in BYTES, real ones (atlas size, CPU copies),
   * never a count of entries.
   */
  function _trimVolumeCache(protectedEntry = null) {
    const vram = _gpuBudgetBytes();
    const cacheBudget = _volumeCacheBudget(vram);
    let guard = 0;
    while (guard++ < 4096 && _volumeCache.size) {
      if (_cachedBytes() <= cacheBudget && _residentGpuBytes() <= vram) break;
      const key = _evictionVictim(protectedEntry);
      if (!key) break;
      const entry = _volumeCache.get(key);
      _volumeCache.delete(key);
      _disposeVolumeEntry(entry);
    }
  }

  /** Which timepoints of a series are ACTUALLY resident right now. The buffer bar is
   *  painted from this rather than from a "already visited" set, so it also shrinks
   *  when eviction takes frames back — a bar that only ever grows would read as full
   *  while half the series had been dropped. */
  function _cachedTimepoints(basePath, quality) {
    const want = _normalizeQualityKey(quality || '');
    const out = new Set();
    for (const entry of _volumeCache.values()) {
      if (entry?.basePath !== basePath) continue;
      if (_normalizeQualityKey(entry?.quality || '') !== want) continue;
      if (Number.isFinite(entry?.timepoint)) out.add(entry.timepoint);
    }
    return out;
  }

  /** How many frames of this series can be resident at once — the honest ceiling the
   *  buffer can reach. */
  function _bufferCapacity(basePath, quality) {
    const want = _normalizeQualityKey(quality || '');
    let per = 0;
    for (const entry of _volumeCache.values()) {
      if (entry?.basePath !== basePath) continue;
      if (_normalizeQualityKey(entry?.quality || '') !== want) continue;
      per = Math.max(per, _entryBytes(entry));
    }
    if (!per) return 0;   // nothing loaded yet at this quality: unknown, not zero
    return Math.max(1, Math.floor(_volumeCacheBudget() / per));
  }

  function _emptyHistograms(channels, bins = 256) {
    return Array.from({ length: Math.max(0, channels) }, () => ({ bins, counts: new Array(bins).fill(0), max: 1, total: 0 }));
  }

  /**
   * Histogram of one channel (one byte per voxel), from at most `maxSamples` voxels
   * taken at a fixed stride: counts are scaled back to the voxel count, so the shape
   * — what the channel panel draws and the surface threshold reads — is unbiased
   * while the cost stays bounded (4 M samples, not the 200 M voxels of a full volume).
   */
  function _channelHistogram(values, bins = 256, maxSamples = 4 * 1024 * 1024) {
    const counts = new Array(bins).fill(0);
    const n = values?.length || 0;
    if (!n) return { bins, counts, max: 1, total: 0 };
    const stride = Math.max(1, Math.floor(n / maxSamples));
    let taken = 0;
    for (let i = 0; i < n; i += stride) {
      counts[(values[i] * bins) >> 8]++;
      taken++;
    }
    const k = n / taken;
    for (let b = 0; b < bins; b++) counts[b] = Math.round(counts[b] * k);
    return { bins, counts, max: Math.max(1, ...counts), total: counts.reduce((s, v) => s + v, 0) };
  }

  /** Real histograms of a slice-stack volume, one channel per idle callback. */
  function _deferHistogramComputation(entry) {
    const raw = entry.rawChannelData || [];
    const result = _emptyHistograms(raw.length);
    let c = 0;
    const step = () => {
      if (entry.disposed || !entry.rawChannelData) return;
      if (c < raw.length) {
        result[c] = _channelHistogram(raw[c]);
        c++;
        schedule();
        return;
      }
      entry.histograms = result;
      entry.histogramsExact = true;
      if (_activeVolumeEntry === entry) _channelHistograms = entry.histograms;
    };
    const schedule = () => {
      if (typeof window !== 'undefined' && window.requestIdleCallback) requestIdleCallback(step, { timeout: 800 });
      else setTimeout(step, 50);
    };
    schedule();
  }

  function _sampleArray(items, maxItems) {
    if (items.length <= maxItems) return items;
    if (maxItems <= 1) return items.length ? [items[Math.floor((items.length - 1) / 2)]] : [];
    const result = [];
    const last = items.length - 1;
    for (let i = 0; i < maxItems; i++) {
      result.push(items[Math.round((i / (maxItems - 1)) * last)]);
    }
    return [...new Set(result)];
  }

  async function _runLimited(items, limit, worker) {
    let index = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async (_, runnerIndex) => {
      while (index < items.length) {
        const current = items[index++];
        try {
          await worker(current, runnerIndex);
        } catch (e) {
          console.warn('[VolumeViewer] Worker failed:', e);
        }
      }
    });
    await Promise.all(runners);
  }

  function _buildSampleIndices(depth, maxSamples) {
    if (depth <= maxSamples) {
      return Array.from({ length: depth }, (_, i) => i);
    }
    if (maxSamples <= 1) return [Math.floor(depth / 2)];

    const result = [];
    const last = depth - 1;
    for (let i = 0; i < maxSamples; i++) {
      result.push(Math.round((i / (maxSamples - 1)) * last));
    }
    return [...new Set(result)];
  }

  /** One slice image, decoded. The caller owns the bitmap and closes it once its
   *  pixels are copied: nothing decoded is kept here. */
  async function _loadImage(url) {
    const perf = _perf();
    const fetchPerfId = perf?.start('image.fetch.decode', { url });
    if (window.createImageBitmap && window.fetch) {
      try {
        const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const resp = await fetch(url);
        const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
        const blob = await resp.blob();
        const t2 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const img = await createImageBitmap(blob);
        const t3 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        perf?.end(fetchPerfId, {
          status: 'ok',
          fetchMs: Math.round((t1 - t0) * 100) / 100,
          blobMs: Math.round((t2 - t1) * 100) / 100,
          decodeMs: Math.round((t3 - t2) * 100) / 100,
          bytes: Number(blob.size) || 0
        });
        return img;
      } catch (err) {
        perf?.end(fetchPerfId, { status: 'error', message: err?.message || String(err) });
        throw err;
      }
    }

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        perf?.end(fetchPerfId, { status: 'ok', fallback: true });
        resolve(img);
      };
      img.onerror = (err) => {
        perf?.end(fetchPerfId, { status: 'error', fallback: true });
        reject(err);
      };
      img.src = url;
    });
  }

  /** Fetch a slice file into the HTTP cache (one request per URL at a time). */
  function _prefetchSliceFile(url) {
    const pending = _imageCache.get(url);
    if (pending) return pending;
    const p = fetch(url)
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
        return resp.arrayBuffer();
      })
      .then(() => true)
      .finally(() => { _imageCache.delete(url); });
    _imageCache.set(url, p);
    return p;
  }

  // ── Denoise (per-channel in-plane Gaussian, js/workers/gaussian-blur-worker.js) ──
  // Works on a volume held in ONE dense texture. The channels are taken from the
  // slice-stack load, or read back from the GPU the first time the filter is used on a
  // brick-streamed volume (no CPU copy is kept otherwise); the raw channel stays on
  // the entry so σ → 0 restores it. A sparse atlas (bricks in arbitrary slots) has no
  // plane to blur: the filter reports itself unavailable there.

  function getCapabilities() {
    const e = _activeVolumeEntry;
    let denoise;
    if (!e) denoise = { available: false, reason: 'no-volume' };
    else if (e.svrManager) denoise = { available: false, reason: 'sparse-atlas' };
    else if (!e.texture) denoise = { available: false, reason: 'no-volume' };
    else denoise = { available: true, reason: null };
    return { denoise, depthPick: Boolean(renderer) && !_contextLost };
  }

  function _reportDenoise(channel, detail) {
    if (detail.reason === 'sparse-atlas') {
      _emitQualityState({ message: _t('viewer.denoiseUnavailableSparse',
        'Denoise is not available at this quality (sparse brick atlas): choose a lower quality to use it.') });
    } else if (detail.reason === 'error') {
      _emitQualityState({ message: _t('viewer.denoiseFailed', 'Denoise failed on channel {channel}: the channel is shown unfiltered.', { channel: channel + 1 }) });
    }
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('volume-denoise-state', { detail: { channel, ...detail } }));
    }
  }

  /** The channels of a dense GPU volume, read back one Z layer at a time. */
  async function _readbackChannels(entry) {
    const gl = renderer?.getContext?.();
    const glTex = gl ? renderer.properties.get(entry.texture)?.__webglTexture : null;
    if (!gl || !glTex || gl.isContextLost?.()) throw new Error('volume texture unavailable for readback');
    const { width: w, height: h, depth: d } = entry;
    const channels = Math.max(1, Math.min(4, entry.channels || 1));
    const raw = Array.from({ length: channels }, () => new Uint8Array(w * h * d));
    const layer = new Uint8Array(w * h * 4);
    const fb = gl.createFramebuffer();
    const previousTarget = renderer.getRenderTarget();
    try {
      for (let z = 0; z < d; z++) {
        // Re-bound for every layer: the render loop may have drawn in between.
        renderer.state.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, glTex, 0, z);
        if (z === 0 && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error('volume texture is not readable');
        }
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, layer);
        const base = z * w * h;
        for (let c = 0; c < channels; c++) {
          const out = raw[c];
          for (let i = 0, o = c; i < w * h; i++, o += 4) out[base + i] = layer[o];
        }
        if ((z & 7) === 7) {
          renderer.setRenderTarget(previousTarget);
          await _macrotask();
          if (entry.disposed || gl.isContextLost()) throw new Error('volume released during readback');
        }
      }
    } finally {
      renderer.setRenderTarget(previousTarget);
      gl.deleteFramebuffer(fb);
    }
    return raw;
  }

  /** Upload every channel of `entry.channelData` back into its texture, in slabs of
   *  ≤ 16 MiB interleaved between macrotasks. false when superseded or released. */
  async function _uploadEntryChannels(entry, isCurrent) {
    const { width: w, height: h, depth: d } = entry;
    const stride = entry.stride || RGBA_TEXTURE_BYTES_PER_VOXEL;
    const slice = w * h;
    const slabDepth = Math.max(1, Math.floor((16 * 1024 * 1024) / Math.max(1, slice * stride)));
    const buffer = new Uint8Array(slabDepth * slice * stride);
    for (let z0 = 0; z0 < d; z0 += slabDepth) {
      if (entry.disposed || !isCurrent()) return false;
      const dz = Math.min(slabDepth, d - z0);
      const view = buffer.subarray(0, dz * slice * stride);
      _interleaveChannels(entry.channelData, z0 * slice, dz * slice, view, stride);
      _updateGPUTextureRegion(entry.texture, { x: w, y: h, z: d }, 0, 0, z0, w, h, dz, view);
      _scheduleFrame();
      if (z0 + dz < d) await _macrotask();
    }
    return true;
  }

  /** Blur channel `idx` of `entry` with σ = `sigma` voxels (σ ≤ 0.1 restores it). */
  async function _applyDenoise(idx, sigma, entry = _activeVolumeEntry) {
    if (!entry || entry.disposed) return;
    if (entry.svrManager || !entry.texture) {
      _reportDenoise(idx, { available: false, reason: entry.svrManager ? 'sparse-atlas' : 'no-volume', sigma });
      return;
    }
    if (idx >= (entry.channels || 1)) return;
    entry.denoiseGen = entry.denoiseGen || [0, 0, 0, 0];
    const gen = ++entry.denoiseGen[idx];
    const isCurrent = () => !entry.disposed && entry.denoiseGen[idx] === gen;
    try {
      if (!entry.rawChannelData) {
        entry._readback = entry._readback || _readbackChannels(entry);
        entry.rawChannelData = await entry._readback;
        entry._readback = null;
      }
    } catch (err) {
      entry._readback = null;
      console.warn('[VolumeViewer] Denoise: volume readback failed:', err);
      if (isCurrent()) _reportDenoise(idx, { available: false, reason: 'error', sigma });
      return;
    }
    if (!isCurrent()) return;
    const raw = entry.rawChannelData[idx];
    if (!raw) return;
    entry.channelData = entry.channelData || entry.rawChannelData.slice();
    entry.denoiseSigma = entry.denoiseSigma || [0, 0, 0, 0];
    const finish = async (data, effectiveSigma, failed = false) => {
      if (!isCurrent()) return;   // a newer request owns this channel
      entry.channelData[idx] = data;
      entry.denoiseSigma[idx] = effectiveSigma;
      const done = await _uploadEntryChannels(entry, isCurrent);
      if (done) _reportDenoise(idx, { available: true, reason: failed ? 'error' : null, sigma, effectiveSigma });
    };
    if (!(sigma > 0.1)) { await finish(raw, 0); return; }
    _dispatchParallelBlur(raw, entry.width, entry.height, entry.depth, sigma,
      (blurred, effectiveSigma) => { finish(blurred, Number.isFinite(effectiveSigma) ? effectiveSigma : sigma); },
      () => { finish(raw, 0, true); });
  }

  /**
   * Update channel display parameters
   */
  function updateChannel(idx, params) {
    if (idx < 0 || idx > 3) return;

    if (params.color) {
      // EDGE-026: reject malformed hex before parseInt — otherwise NaN reaches the color uniform.
      if (/^#[0-9a-fA-F]{6}$/.test(params.color)) {
        // Hex to RGB [0-1]
        const r = parseInt(params.color.slice(1,3), 16) / 255;
        const g = parseInt(params.color.slice(3,5), 16) / 255;
        const b = parseInt(params.color.slice(5,7), 16) / 255;
        material.uniforms[`color${idx}`].value.set(r, g, b);
      } else {
        console.warn(`[VolumeViewer] updateChannel: invalid hex color "${params.color}" for channel ${idx} — ignored`);
      }
    }

    if (params.min !== undefined) material.uniforms[`min${idx}`].value = params.min;
    if (params.max !== undefined) material.uniforms[`max${idx}`].value = params.max;
    if (params.gamma !== undefined) material.uniforms[`gamma${idx}`].value = Math.max(0.18, Math.min(5.5, params.gamma));
    if (params.opacity !== undefined) material.uniforms[`opacity${idx}`].value = Math.max(0, Math.min(1, params.opacity));
    if (params.enabled !== undefined) {
      material.uniforms[`en${idx}`].value = params.enabled ? 1 : 0;
      _recompileShaderForActiveChannels();
    }

    // Denoise σ: blurred in the worker pool from the entry's raw channel (no refetch).
    if (params.denoise_sigma !== undefined) {
      const newSigma = Math.max(0, Math.min(5, Number(params.denoise_sigma) || 0));
      const oldSigma = _channelSigma[idx] || 0;
      _channelSigma[idx] = newSigma;
      if (Math.abs(newSigma - oldSigma) > 0.05 && _activeVolumeEntry) { _applyDenoise(idx, newSigma, _activeVolumeEntry); _roiSchedule('denoise'); }
    }

    _scheduleFrame();
  }

  function _recompileShaderForActiveChannels() {
    if (!material) return;
    // Si le panneau de décomposition est ouvert, on doit compiler tous les canaux disponibles
    // pour permettre le rendu simultané des différentes previews par canal (sans qu'elles ne s'effacent).
    // Sur le plan mathématique/GPU, cela évite d'exclure les branches de calcul de couleur et d'opacité
    // (A_sample et color blending) du fragment shader compilé.
    const isDecompOpen = typeof DecompositionPanel !== 'undefined' && DecompositionPanel.isOpen && DecompositionPanel.isOpen();
    const isCh0 = (isDecompOpen || material.uniforms.en0.value === 1) && material.uniforms.numChannels.value > 0;
    const isCh1 = (isDecompOpen || material.uniforms.en1.value === 1) && material.uniforms.numChannels.value > 1;
    const isCh2 = (isDecompOpen || material.uniforms.en2.value === 1) && material.uniforms.numChannels.value > 2;
    const isCh3 = (isDecompOpen || material.uniforms.en3.value === 1) && material.uniforms.numChannels.value > 3;

    material.defines = material.defines || {};
    let changed = false;
    
    const checkDefine = (name, val) => {
      const current = material.defines[name];
      if (current !== val) {
        material.defines[name] = val;
        changed = true;
      }
    };

    checkDefine('ENABLE_CHANNEL_0', isCh0 ? 1 : 0);
    checkDefine('ENABLE_CHANNEL_1', isCh1 ? 1 : 0);
    checkDefine('ENABLE_CHANNEL_2', isCh2 ? 1 : 0);
    checkDefine('ENABLE_CHANNEL_3', isCh3 ? 1 : 0);

    if (changed) {
      material.needsUpdate = true;
      if (typeof VolumeGrid !== 'undefined') {
        VolumeGrid.rebuild();
      }
    }
    _scheduleFrame();
  }
  
  /**
   * Update clipping planes (0.0 to 1.0)
   */
  function setClip(axis, value) {
    // value is the upper bound (0 to 1); it never goes below the axis's lower bound.
    const v = Number(value);
    const raw = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
    if (axis === 'x' || axis === 'y' || axis === 'z') {
      const next = Math.max(clipPlanes[`${axis}Min`], raw);
      clipPlanes[`${axis}Max`] = next;
      material.uniforms.clipMax.value[axis] = next;
    }
    _scheduleFrame();
    _roiSchedule('clip');
  }

  /**
   * Set both min and max clipping for an axis (0.0 to 1.0), or 'all' axes. An explicit
   * 0 is a value (an empty range), not "unset"; only a missing / non-numeric bound
   * falls back to 0 (min) or 1 (max).
   */
  function setClipRange(axis, min, max) {
    if (!material?.uniforms) return;
    const num = (v, fallback) => {
      const n = Number(v);
      return v === null || v === undefined || v === '' || !Number.isFinite(n) ? fallback : n;
    };
    const lo = Math.max(0, Math.min(1, num(min, 0)));
    const hi = Math.max(lo, Math.min(1, num(max, 1)));
    for (const a of ['x', 'y', 'z']) {
      if (axis !== a && axis !== 'all') continue;
      clipPlanes[`${a}Min`] = lo;
      clipPlanes[`${a}Max`] = hi;
      material.uniforms.clipMin.value[a] = lo;
      material.uniforms.clipMax.value[a] = hi;
    }
    _scheduleFrame();
    _roiSchedule('clip');
  }

  // ── Axis-aligned views in the frame the operator defined ────────────────────
  // `_frameQuaternion` (Q_base, metadata.orientation) is the cube pose at which the
  // reference axes of the specimen coincide with the world axes. An axis-aligned
  // view must still look along a VOXEL axis — the z-stack browser shows acquisition
  // planes — but the spin about the viewing axis is free, and it is chosen so the
  // view sits as close as possible to that frame rather than to the raw acquisition
  // orientation of the file.
  let _frameQuaternion = null;

  /**
   * The rotation about world Z nearest to `q`. A rotation about Z is
   * (0, 0, sin θ/2, cos θ/2); its dot product with q is q.z·sin θ/2 + q.w·cos θ/2,
   * maximal when (sin θ/2, cos θ/2) ∝ (q.z, q.w) — the normalised projection of q
   * onto the {z, w} plane. Sign-free: q and −q project onto the same rotation.
   * Degenerate (q.z = q.w = 0: a half-turn about an axis of the XY plane carries no
   * in-plane component) ⇒ identity.
   * @param {THREE.Quaternion} q
   * @returns {THREE.Quaternion}
   */
  function _nearestZSpin(q) {
    const len = Math.hypot(q.z, q.w);
    return len < 1e-6 ? new THREE.Quaternion() : new THREE.Quaternion(0, 0, q.z / len, q.w / len);
  }

  /**
   * Register the calibrated frame the axis-aligned views spin toward. Pass null to
   * fall back to the raw voxel axes.
   * @param {THREE.Quaternion|number[]|{x,y,z,w}|null} q
   */
  function setFrameQuaternion(q) {
    if (q === null || q === undefined) { _frameQuaternion = null; return; }
    const next = Array.isArray(q)
      ? new THREE.Quaternion().fromArray(q)
      : new THREE.Quaternion(q.x, q.y, q.z, q.w);
    if (![next.x, next.y, next.z, next.w].every(Number.isFinite) || next.lengthSq() < 1e-8) return;
    _frameQuaternion = next.normalize();
  }

  /**
   * Turning the sample over: a half-turn about the SCREEN's vertical axis (world Y),
   * so left and right swap and up stays up, whatever the pose — the same half-turn
   * setView's back side uses. Applied in world space (premultiplied): a half-turn
   * about the volume's own X axis looked like a diagonal tumble as soon as a
   * calibration had tilted the file axes on screen.
   */
  function _halfTurn() {
    return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  }

  /**
   * The pose of the raw file before any calibration: the acquisition axes on the
   * world axes, turned over when the file shows the sample from below.
   * @param {boolean} [upsideDown] defaults to the dataset's own flag
   */
  function _rawPoseQuaternion(upsideDown = _upsideDown) {
    return upsideDown ? _halfTurn() : new THREE.Quaternion();
  }

  /**
   * Which way up the raw file shows the sample. `upsideDown`: its +Z face is the
   * underside (a confocal stack, imaged from the objective under an inverted
   * microscope), so its top — the face seen from above the microscope — is the −Z
   * face, which setView's side 'top' resolves to, and the raw pose (an
   * uncalibrated dataset, "reset view" without a default view) is turned over by a
   * half-turn about the screen's vertical. Before anything has posed the volume the
   * raw pose is applied at once. With `preview` (the admin editor's switch) the
   * volume is laid flat with that top face toward the camera — exactly what the
   * z-stack browser will show — so the operator picks the side by looking at the
   * face itself. Neither the calibration frame (file axes → anatomy) nor a default
   * view (a pose of the anatomy) depends on which side is up: both are left alone.
   * @param {boolean} flag
   * @param {{preview?: boolean}} [options]
   */
  function setSampleUpsideDown(flag, options = {}) {
    _upsideDown = Boolean(flag);
    if (!cube) return;
    if (options.preview) {
      setView('xy', { side: 'top', spin: 'tilt', animate: 1000, force: true });
    } else if (!_homeQuaternion && !_hasLoadedVolume) {
      cube.quaternion.copy(_rawPoseQuaternion());
      _scheduleFrame();
    }
  }

  function isSampleUpsideDown() {
    return _upsideDown;
  }

  /** 'top' / 'bottom' are the faces the upside-down flag says; anything but 'back' is 'front'. */
  function _resolveViewSide(side) {
    if (side === 'top') return _upsideDown ? 'back' : 'front';
    if (side === 'bottom') return _upsideDown ? 'front' : 'back';
    return side === 'back' ? 'back' : 'front';
  }

  /**
   * The rotations about the screen axes that bring the world direction `d` (unit)
   * onto the viewing axis +Z. Two of them, applied in world space one after the
   * other: first about the screen axis `d` leans on most — its lean measured by
   * the perpendicular component, so |dy| > |dx| means the horizontal axis X, and
   * the vertical Y otherwise, ties included (turning over a sample that points
   * straight away is a half-turn about the vertical) — then a correction about
   * the other axis, which is never more than a quarter turn.
   *   about X first: Rx(α) zeroes y  (α = atan2(dy, dz)),  then Ry(β) zeroes x
   *                  (β = atan2(−dx, √(dy²+dz²)));
   *   about Y first: Ry(β) zeroes x  (β = atan2(−dx, dz)),  then Rx(α) zeroes y
   *                  (α = atan2(dy, √(dx²+dz²))).
   * Rx(a): (x, y, z) → (x, y·cos a − z·sin a, y·sin a + z·cos a);
   * Ry(b): (x, y, z) → (x·cos b + z·sin b, y, −x·sin b + z·cos b).
   * @returns {{first: {axis: THREE.Vector3, angle: number}, second: {axis: THREE.Vector3, angle: number}}}
   */
  function _tiltToViewAxis(d) {
    const X = new THREE.Vector3(1, 0, 0);
    const Y = new THREE.Vector3(0, 1, 0);
    const ax = Math.min(1, Math.abs(d.x));
    const ay = Math.min(1, Math.abs(d.y));
    // Both components noise: the axis points straight along the viewing axis, one way
    // or the other. Turned over about the vertical, never by whichever noise is larger
    // (the sample-side switch flips a flat stack, which is exactly this pose).
    if (ax < 1e-6 && ay < 1e-6) {
      return { first: { axis: Y, angle: d.z < 0 ? Math.PI : 0 }, second: { axis: X, angle: 0 } };
    }
    // What the second rotation still has to correct is asin|dx| when the horizontal
    // turns first and asin|dy| when the vertical does: the smaller correction wins,
    // and the vertical wins whenever the two are within a few degrees of each other.
    const tie = 5 * Math.PI / 180;
    if (Math.asin(ax) + tie < Math.asin(ay)) {
      const alpha = Math.atan2(d.y, d.z);
      const beta = Math.atan2(-d.x, Math.hypot(d.y, d.z));
      return { first: { axis: X, angle: alpha }, second: { axis: Y, angle: beta } };
    }
    const beta = Math.atan2(-d.x, d.z);
    const alpha = Math.atan2(d.y, Math.hypot(d.x, d.z));
    return { first: { axis: Y, angle: beta }, second: { axis: X, angle: alpha } };
  }

  /** The pose `path` (two screen-axis rotations, both scaled by `k`) reaches from `from`. */
  function _tiltPose(from, path, k) {
    const r1 = new THREE.Quaternion().setFromAxisAngle(path.first.axis, k * path.first.angle);
    const r2 = new THREE.Quaternion().setFromAxisAngle(path.second.axis, k * path.second.angle);
    return r2.multiply(r1).multiply(from);
  }

  /**
   * Take the volume to `target`: at once, or over `animateMs` — stepped by
   * _animate, eased at both ends, one camera notification at the end so the
   * siblings of a Compare panel see the pose it settles on. Along the shortest
   * arc (a slerp), or, with `path` (the two screen-axis rotations of
   * _tiltToViewAxis), with both rotations growing together, so the motion reads
   * as a turn about one screen axis with a slight correction about the other.
   */
  function _poseTo(target, animateMs, path = null) {
    const ms = Number(animateMs) || 0;
    if (ms <= 0 || cube.quaternion.angleTo(target) < 1e-4) {
      _poseAnim = null;
      cube.quaternion.copy(target);
      _notifyCameraChange();
      return;
    }
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    _poseAnim = { from: cube.quaternion.clone(), to: target.clone(), start: now, duration: ms, path };
    _scheduleFrame();
  }

  /** One frame of the pose in flight; true while there is one. */
  function _stepPoseAnimation(now) {
    const a = _poseAnim;
    if (!a) return false;
    // Half a millisecond of slack: timestamps are floating-point sums, and a flight
    // asked to end at start + duration must end there, not one frame later.
    const elapsed = now - a.start;
    const done = elapsed >= a.duration - 0.5;
    const t = done ? 1 : Math.max(0, elapsed / a.duration);
    const eased = t * t * (3 - 2 * t);
    if (a.path) cube.quaternion.copy(_tiltPose(a.from, a.path, eased));
    else cube.quaternion.slerpQuaternions(a.from, a.to, eased);
    if (t >= 1) {
      cube.quaternion.copy(a.to);
      _poseAnim = null;
      _notifyCameraChange();
    }
    return true;
  }

  /**
   * Pose the volume for an axis-aligned view.
   * @param {'xy'|'xz'|'yz'|'3d'} view
   * @param {object} [options]
   *   side    'front' (default): the +axis toward the camera; 'back': the front
   *           pose turned over about the vertical — the same in-plane spin seen
   *           from the other side, screen-up kept, the image the mirror of the
   *           front view, exactly what turning the sample over does; 'top' /
   *           'bottom': the sample's upper / lower face (see setSampleUpsideDown).
   *   spin    'frame' (default): the in-plane spin nearest the calibrated frame;
   *           'nearest': nearest the pose the volume has NOW — the smallest move,
   *           along the shortest arc, whose axis is in general oblique;
   *           'tilt': the spin the volume lands on when its looked-along axis is
   *           brought onto the viewing axis by a rotation about the screen axis
   *           it leans on most (vertical on a tie) plus a correction about the
   *           other — no in-plane turn, the motion reads as a turn about one axis;
   *           a number: degrees of in-plane spin counted from the frame spin.
   *   animate ms: travel there over that time instead of snapping (0: snap).
   *   force   apply even while rotation is locked (the browser's own re-pose).
   * @returns {{spinDeg: number}|null} the in-plane spin the pose landed on, counted
   *   from the frame spin in [0, 360) — what a spin slider shows; null when refused.
   */
  function setView(view, options = {}) {
    if (!cube) return null;
    // BUG-027: honor the rotation lock — don't snap orientation back to a preset axis when locked.
    if (_rotationLocked && !options.force) { _notifyCameraChange(); return null; }
    if (view === '3d') {
      const target = _homeQuaternion ? _homeQuaternion.clone() : _rawPoseQuaternion()
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 6))
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 5));
      _poseTo(target, options.animate);
      return null;
    }
    // B brings the requested voxel axis onto the viewing axis (world Z): looking
    // down Z for xy, down the voxel Y for xz, down the voxel X for yz. The front
    // pose is S·B with S a spin about world Z; among those, the one nearest the
    // frame F maximises ⟨S·B, F⟩ = ⟨S, F·B⁻¹⟩, hence S = nearestZSpin(F·B⁻¹). No
    // frame ⇒ S = identity ⇒ the raw voxel axes.
    // The back side is Ry(π)·(S·B): the front pose turned over about world Y. The
    // spin is NOT re-chosen against the frame from behind — a half-turn about an
    // in-plane axis has no Z component, so every back pose would be equally far
    // from a front-facing frame and the choice would fall on the tilt, not on the
    // in-plane orientation the operator defined.
    const B = new THREE.Quaternion();
    if (view === 'xz') B.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    else if (view === 'yz') B.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
    const S = _frameQuaternion
      ? _nearestZSpin(_frameQuaternion.clone().multiply(B.clone().invert()))
      : new THREE.Quaternion();
    // Q0 is the frame pose of the view, spin 0; every pose of the family is Rz(θ)·Q0
    // — the same face, the slices turned on screen.
    const Q0 = S.clone().multiply(B);
    if (_resolveViewSide(options.side) === 'back') {
      Q0.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
    }
    let spinRad = 0;
    let path = null;
    if (options.spin === 'tilt') {
      // The file direction Q0 looks along, where the volume holds it now; the two
      // screen-axis rotations that bring it onto +Z land in the family by
      // construction — read the spin off the pose they reach.
      const along = new THREE.Vector3(0, 0, 1).applyQuaternion(Q0.clone().invert());
      const d = along.applyQuaternion(cube.quaternion).normalize();
      path = _tiltToViewAxis(d);
      const landed = _tiltPose(cube.quaternion, path, 1);
      const spin = _nearestZSpin(landed.multiply(Q0.clone().invert()));
      spinRad = 2 * Math.atan2(spin.z, spin.w);
    } else if (options.spin === 'nearest') {
      // The Rz(θ)·Q0 nearest the current pose Q maximises ⟨Rz(θ)·Q0, Q⟩ = ⟨Rz(θ), Q·Q0⁻¹⟩:
      // the smallest rotation that lays the slices flat on the screen.
      const nearest = _nearestZSpin(cube.quaternion.clone().multiply(Q0.clone().invert()));
      spinRad = 2 * Math.atan2(nearest.z, nearest.w);
    } else if (Number.isFinite(Number(options.spin))) {
      spinRad = THREE.MathUtils.degToRad(Number(options.spin));
    }
    const target = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), spinRad).multiply(Q0);
    _poseTo(target, options.animate, path);
    return { spinDeg: ((THREE.MathUtils.radToDeg(spinRad) % 360) + 360) % 360 };
  }

  /**
   * The screen's axes in the volume's own frame — the voxel axes, physically
   * proportioned: P = L ⊙ p / max(p), L the cube-local position ([−½, ½]³), p the
   * physical extent per axis (a missing axis counting as 1, as in
   * VolumeSlicer.planeGeometry). That is the frame VolumeSlicer poses its planes
   * in, so a slice drawn along `right` / `up` shows the voxels the way the canvas
   * does. `toward` is the normal of the screen-parallel planes, toward the camera.
   *   The cube draws L at world T + Qc·(s ⊙ L), s = cube.scale (per-axis stretch:
   *   the physical proportions, Z times the display scale), and both the
   *   ray-marcher (its sample position + ½) and the slicer (base + ½) read the
   *   texture at L + ½ (at volumeWarp·L, both, on a stabilised timelapse), through
   *   the same atlas lookup — no flip on either side.
   *   A world direction d is thus the local direction s⁻¹ ⊙ Qc⁻¹·d, the
   *   P direction ∝ (p / s) ⊙ Qc⁻¹·d; a normal maps through the inverse
   *   transpose, ∝ (s / p) ⊙ Qc⁻¹·n. A negative scale component (a mirror) is
   *   carried by the same formulas. The camera basis is read from its world
   *   matrix (columns: right, up, backward), wherever the camera points.
   * While a pose is in flight the pose it flies to is used: a figure asked for
   * mid-flight gets the orientation the screen is about to settle on.
   * @returns {{right: THREE.Vector3, up: THREE.Vector3, toward: THREE.Vector3,
   *   settling: boolean}|null} unit vectors; null before the scene exists
   */
  function getScreenFrameInVolume() {
    if (!cube || !camera) return null;
    camera.updateMatrixWorld();
    const qc = (_poseAnim ? _poseAnim.to : cube.quaternion).clone();
    if (cube.parent) qc.premultiply(cube.parent.getWorldQuaternion(new THREE.Quaternion()));
    const qInv = qc.invert();
    const physical = getPhysicalSize();
    const axis = (v) => (Number(v) > 0 ? Number(v) : 1);
    const px = axis(physical?.x);
    const py = axis(physical?.y);
    const pz = axis(physical?.z);
    const sx = cube.scale.x || 1;
    const sy = cube.scale.y || 1;
    const sz = cube.scale.z || 1;
    const column = (i) => new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, i).applyQuaternion(qInv);
    const direction = (v) => new THREE.Vector3(v.x * px / sx, v.y * py / sy, v.z * pz / sz).normalize();
    const back = column(2);
    return {
      right: direction(column(0)),
      up: direction(column(1)),
      toward: new THREE.Vector3(back.x * sx / px, back.y * sy / py, back.z * sz / pz).normalize(),
      settling: _poseAnim !== null
    };
  }

  function centerSample() {
    if (!cube) return;
    cube.position.set(0, 0, 0);
    _notifyCameraChange();
  }

  /**
   * Register the pose "reset view" returns to, and optionally adopt it right now.
   * Called before the volume streams (PluginRegistry.prepareAll) so the very first
   * rendered brick is already oriented — never after, which would snap a visible
   * specimen. Pass null to clear.
   * @param {THREE.Quaternion|number[]|null} q
   * @param {{apply?: boolean}} [options]  apply:true also poses the cube now
   */
  function setHomeQuaternion(q, options = {}) {
    if (q === null || q === undefined) { _homeQuaternion = null; return; }
    const next = Array.isArray(q)
      ? new THREE.Quaternion().fromArray(q)
      : new THREE.Quaternion(q.x, q.y, q.z, q.w);
    if (![next.x, next.y, next.z, next.w].every(Number.isFinite) || next.lengthSq() < 1e-8) return;
    _homeQuaternion = next.normalize();
    if (options.apply && cube) {
      _poseAnim = null;
      cube.quaternion.copy(_homeQuaternion);
      _scheduleFrame();
    }
  }

  function resetView(options = {}) {
    if (!cube) return;
    cube.position.set(0, 0, 0);
    // BUG-027: preserve orientation while rotation is locked; still allow position/clip reset.
    if (!_rotationLocked) {
      _poseAnim = null;
      if (_homeQuaternion) cube.quaternion.copy(_homeQuaternion);
      else cube.quaternion.copy(_rawPoseQuaternion());
    }
    if (options.resetClipping) {
      resetClipping();
    }
    fitCameraToVolume();
    _notifyCameraChange();
  }

  function resetClipping() {
    if (!material?.uniforms) return;
    clipPlanes = {
      xMin: 0.0, xMax: 1.0,
      yMin: 0.0, yMax: 1.0,
      zMin: 0.0, zMax: 1.0
    };
    material.uniforms.clipMin.value.set(0, 0, 0);
    material.uniforms.clipMax.value.set(1, 1, 1);
    _planeSpec = {
      ..._planeSpec,
      mode: 'xy',
      axis: 'z',
      value: 1.0,
      yaw: 0,
      pitch: 0,
      roll: 0,
      visible: false
    };
    _cutPlane = { axis: 'z', value: 1.0, visible: false };
    _updateCutPlaneMesh();
    _notifyPlaneChange();
  }

  function fitCameraToVolume(margin = 1.25) {
    if (!camera || !cube || !_container) return;
    camera.position.set(0, 0, _fitCameraDistance(margin));
    camera.updateProjectionMatrix();
    _lastAspect = camera.aspect;
  }

  function _fitCameraDistance(margin = 1.25) {
    if (!camera || !cube || !_container) return 2.5;
    // Frame the VOLUME, not whatever is parented to it. Box3.setFromObject() walks
    // every descendant — measurement sprites, the cut plane, the tracking overlay —
    // so the framing drifted with the annotations, and worse, expandByObject caches
    // each child's boundingBox: an overlay whose positions are rewritten per frame
    // would pin the framing to whatever frame 0 happened to span, for the session.
    cube.updateMatrixWorld(true);
    if (!cube.geometry.boundingBox) cube.geometry.computeBoundingBox();
    const box = cube.geometry.boundingBox.clone().applyMatrix4(cube.matrixWorld);
    const size = new THREE.Vector3();
    box.getSize(size);
    const verticalFov = THREE.MathUtils.degToRad(camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
    const distanceY = (size.y / 2) / Math.tan(verticalFov / 2);
    const distanceX = (size.x / 2) / Math.tan(horizontalFov / 2);
    const distanceZ = size.z * 1.2;
    return Math.max(0.2, distanceX, distanceY, distanceZ) * margin;
  }

  function setZDisplayScale(factor, options = {}) {
    const next = Math.max(0.25, Math.min(2.0, Number(factor) || 1.0));
    _zDisplayScale = next;
    _applyDisplayScale();
    if (options.fitCamera) fitCameraToVolume();
    if (options.notify !== false) _notifyCameraChange();
  }

  function _createCutPlaneMesh() {
    if (!cube || _cutPlaneMesh) return;
    const geometry = new THREE.PlaneGeometry(1, 1);
    const planeMaterial = new THREE.MeshBasicMaterial({
      color: 0x7de7ff,
      transparent: true,
      opacity: 0.055,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    _cutPlaneMesh = new THREE.Mesh(geometry, planeMaterial);
    _cutPlaneMesh.renderOrder = 20;
    scene.add(_cutPlaneMesh);

    // Edge highlight (red border) — shown on hover
    const edgeGeom = new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1));
    _planeBorderMesh = new THREE.LineSegments(
      edgeGeom,
      new THREE.LineBasicMaterial({ color: 0xff3333, linewidth: 2, depthTest: false, transparent: true, opacity: 0 })
    );
    _planeBorderMesh.renderOrder = 21;
    _cutPlaneMesh.add(_planeBorderMesh);

    // Slab faces — shown only for MIP/average projection with slabThickness > 1, to
    // visualise the depth the projection integrates over. They are children of the cut
    // plane mesh (so they inherit its orbit-synced orientation) and offset along local
    // +Z, which is the plane normal. Parent Z-scale stays 1 (see _syncCutPlaneToOrbit),
    // so a local-Z position equals a world offset along the normal. Excluded from
    // raycasting so they never interfere with plane hover/drag picking.
    const _slabFaceMat = () => new THREE.MeshBasicMaterial({
      color: 0x7de7ff, transparent: true, opacity: 0.045, side: THREE.DoubleSide, depthWrite: false
    });
    const _slabEdge = () => {
      const ls = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
        new THREE.LineBasicMaterial({ color: 0x7de7ff, transparent: true, opacity: 0.4, depthTest: false })
      );
      ls.renderOrder = 21;
      ls.raycast = () => {};
      return ls;
    };
    _cutSlabFaceA = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), _slabFaceMat());
    _cutSlabFaceB = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), _slabFaceMat());
    [_cutSlabFaceA, _cutSlabFaceB].forEach(face => {
      face.renderOrder = 20;
      face.visible = false;
      face.raycast = () => {};
      face.add(_slabEdge());
      _cutPlaneMesh.add(face);
    });

    // _rotGizmo is kept as an empty group (no rings) so existing code doesn't crash
    _rotGizmo = new THREE.Group();
    _rotGizmo.visible = false;
    scene.add(_rotGizmo);

    _updateCutPlaneMesh();
  }

  function _createMeasurementGroup() {
    if (!cube || _measurementGroup) return;
    // Measurements are drawn in an ISOTROPIC frame: a child of the cube whose scale
    // undoes the cube's per-axis stretch s (physical proportions × Z display scale),
    // so a marker stays a sphere, a line keeps its thickness in every orientation and
    // a label is not squashed on a non-square volume. A cube-local point L is the
    // point L ⊙ s of this frame — the same world point (_pointLocal).
    _measurementGroup = new THREE.Group();
    _measurementGroup.renderOrder = 30;

    _labelsGroup = new THREE.Group();
    _labelsGroup.renderOrder = 35;

    _measurementGroup.add(_labelsGroup);
    cube.add(_measurementGroup);
    _syncMeasurementFrame();
  }

  function _syncMeasurementFrame() {
    if (!_measurementGroup || !cube) return false;
    const s = cube.scale;
    const next = [1 / (s.x || 1), 1 / (s.y || 1), 1 / (s.z || 1)];
    const g = _measurementGroup.scale;
    if (Math.abs(g.x - next[0]) < 1e-12 && Math.abs(g.y - next[1]) < 1e-12 && Math.abs(g.z - next[2]) < 1e-12) return false;
    g.set(next[0], next[1], next[2]);
    return true;
  }

  // Label layout cache: the camera and measurement-frame matrices and the measurement
  // set the last layout was computed for. A frame caused by anything else (an
  // exposure change, a brick landing) reuses the layout.
  const _labelLayoutKey = new Float64Array(33);
  let _labelLayoutVersion = 0;
  let _labelLayoutValid = false;
  const _lbl = {
    right: new THREE.Vector3(),
    up: new THREE.Vector3(),
    centre: new THREE.Vector3(),
    anchor: new THREE.Vector3(),
    toLabel: new THREE.Vector3(),
    world: new THREE.Vector3()
  };

  function _labelLayoutUnchanged() {
    const cam = camera.matrixWorld.elements;
    const grp = _measurementGroup.matrixWorld.elements;
    let same = _labelLayoutValid && _labelLayoutKey[32] === _labelLayoutVersion;
    for (let i = 0; i < 16; i++) {
      if (_labelLayoutKey[i] !== cam[i]) { same = false; _labelLayoutKey[i] = cam[i]; }
      if (_labelLayoutKey[16 + i] !== grp[i]) { same = false; _labelLayoutKey[16 + i] = grp[i]; }
    }
    _labelLayoutKey[32] = _labelLayoutVersion;
    _labelLayoutValid = true;
    return same;
  }

  /**
   * Update measurement label positions in 3D space.
   * @param {boolean} finalizeDrag - true when a drag-label interaction just ended (pointerup)
   * @param {THREE.Sprite|null} activeDraggedSprite - the sprite being dragged (null during animation loop)
   */
  function _updateMeasurementLabelPositions(finalizeDrag = false, activeDraggedSprite = null) {
    if (!_showMeasurementLabels || _measurementSprites.length === 0 || !camera || !cube || !_measurementGroup) return;
    try {
      camera.updateMatrixWorld();
      _measurementGroup.updateWorldMatrix(true, false);
      if (!finalizeDrag && !activeDraggedSprite && _labelLayoutUnchanged()) return;
      if (activeDraggedSprite || finalizeDrag) _labelLayoutValid = false;

      // Camera basis vectors in world space
      const camRight = _lbl.right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      const camUp = _lbl.up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
      const cubeCenter = cube.getWorldPosition(_lbl.centre);
      const frame = _measurementGroup.matrixWorld;

      // 1. Target positions (before overlap resolution). Everything after this works in
      //    the camera plane: a label's on-screen position is (u, v) = its world point
      //    projected on camRight / camUp, and moving it by du·camRight + dv·camUp moves
      //    (u, v) by exactly (du, dv) (the two are orthonormal), so the repulsion runs on
      //    plain numbers and the world offset is applied once at the end.
      const n = _measurementSprites.length;
      const items = new Array(n);
      for (let k = 0; k < n; k++) {
        const sprite = _measurementSprites[k];
        const anchorWorld = _lbl.anchor.copy(sprite.userData.anchorLocal || sprite.userData.anchor).applyMatrix4(frame);
        const toLabel = _lbl.toLabel.copy(anchorWorld).sub(cubeCenter).normalize();
        const rightDot = toLabel.dot(camRight);
        const upDot = toLabel.dot(camUp);

        const len = Math.sqrt(rightDot * rightDot + upDot * upDot);
        let dirX = 1, dirY = 0;
        if (len > 0.001) { dirX = rightDot / len; dirY = upDot / len; }

        // Pivot grows AWAY from anchor
        sprite.center.set(0.5 - dirX * 0.55, 0.5 - dirY * 0.55);

        // Write dirX/dirY to userData so the drag handler (pointermove) can read
        // them without needing access to this closure
        sprite.userData.dirX = dirX;
        sprite.userData.dirY = dirY;

        const m = sprite.userData.measurement;
        const customR = m?.labelOffset?.r || 0;
        const customT = m?.labelOffset?.t || 0;
        const pushDistance = 0.04 + customR;
        const offR = dirX * pushDistance + (-dirY) * customT;
        const offU = dirY * pushDistance + dirX * customT;
        const anchor = anchorWorld.clone();
        const u0 = anchor.dot(camRight) + offR;
        const v0 = anchor.dot(camUp) + offU;
        const w = sprite.scale.x;
        const h = sprite.scale.y;
        const radius = Math.max(w, h) * 0.55;
        const isBeingDragged = activeDraggedSprite != null && activeDraggedSprite === sprite;
        const customRadius = m?.labelOffset?.customRadius;
        items[k] = {
          sprite, anchor, offR, offU,
          // Visual centre in the camera plane (the sprite's pivot is off its centre).
          u: u0 + (0.5 - sprite.center.x) * w,
          v: v0 + (0.5 - sprite.center.y) * h,
          du: 0, dv: 0,
          radius,
          effectiveRadius: isBeingDragged ? 0 : (customRadius !== undefined ? customRadius : radius)
        };
      }
      const dist2D = (a, b) => Math.hypot((a.u + a.du) - (b.u + b.du), (a.v + a.dv) - (b.v + b.dv));

      // 2. Finalize drag: bake current positions into customRadius for the dropped
      //    label AND all nearby labels so nothing snaps on the next render frame.
      if (finalizeDrag && activeDraggedSprite) {
        const dropped = items.find(it => it.sprite === activeDraggedSprite);
        if (dropped) {
          for (const other of items) {
            if (other === dropped) continue;
            const d = dist2D(dropped, other);
            const om = other.sprite.userData.measurement;
            if (!om.labelOffset) om.labelOffset = { r: 0, t: 0 };
            const otherCurrentR = om.labelOffset.customRadius ?? other.radius;
            // If the dropped label is now closer than other's repulsion radius,
            // shrink other's customRadius to accept this closeness
            if (d < otherCurrentR) {
              om.labelOffset.customRadius = Math.max(0, d * 0.45);
              other.effectiveRadius = om.labelOffset.customRadius;
            }
          }

          // Dropped label: customRadius = min gap to any other label's edge
          let minR = dropped.radius;
          for (const other of items) {
            if (other === dropped) continue;
            minR = Math.min(minR, Math.max(0, dist2D(dropped, other) - other.effectiveRadius));
          }
          const dm = dropped.sprite.userData.measurement;
          if (!dm.labelOffset) dm.labelOffset = { r: 0, t: 0 };
          dm.labelOffset.customRadius = minR;
          dropped.effectiveRadius = minR;

          window.dispatchEvent(new CustomEvent('volume-measurement-drag', {
            detail: { id: dropped.sprite.userData.id, labelOffset: dm.labelOffset }
          }));
        }
      }

      // 3. Resolve overlaps via camera-plane repulsion (pairs involving the dragged
      //    sprite are skipped: the user controls its position).
      if (n > 1) {
        for (let iter = 0; iter < 8; iter++) {
          let anyOverlap = false;
          for (let i = 0; i < n; i++) {
            const a = items[i];
            for (let j = i + 1; j < n; j++) {
              const b = items[j];
              if (activeDraggedSprite != null &&
                  (activeDraggedSprite === a.sprite || activeDraggedSprite === b.sprite)) continue;
              const minDist = a.effectiveRadius + b.effectiveRadius;
              if (minDist <= 0) continue;
              const dx = (a.u + a.du) - (b.u + b.du);
              const dy = (a.v + a.dv) - (b.v + b.dv);
              const distSq = dx * dx + dy * dy;
              if (distSq < minDist * minDist && distSq > 1e-8) {
                anyOverlap = true;
                const dist = Math.sqrt(distSq);
                const overlap = minDist - dist;
                const pushX = (dx / dist) * overlap * 0.5;
                const pushY = (dy / dist) * overlap * 0.5;
                a.du += pushX; a.dv += pushY;
                b.du -= pushX; b.dv -= pushY;
              }
            }
          }
          if (!anyOverlap) break;
        }
      }

      // 4. Apply final positions back to sprites (in the measurement frame).
      for (const item of items) {
        const world = _lbl.world.copy(item.anchor)
          .addScaledVector(camRight, item.offR + item.du)
          .addScaledVector(camUp, item.offU + item.dv);
        _measurementGroup.worldToLocal(world);
        item.sprite.position.copy(world);
      }
    } catch (err) {
      console.warn('[VolumeViewer] Error in _updateMeasurementLabelPositions:', err);
    }
  }

  function setMeasurements(items = []) {
    _measurements = Array.isArray(items) ? JSON.parse(JSON.stringify(items)) : [];
    _renderMeasurements();
    // Force several frames of rendering so the scene visually updates
    _idleFrameCount = 0;
    _scheduleFrame();
  }

  function getMeasurementState() {
    return JSON.parse(JSON.stringify(_measurements));
  }

  function setShowMeasurementLabels(visible) {
    _showMeasurementLabels = visible;
    _renderMeasurements();
  }

  function setMeasurementTextSize(size) {
    const n = Number(size);
    if (!Number.isFinite(n)) return;
    _measurementTextSize = Math.max(8, Math.min(256, n));
    _renderMeasurements();
  }

  // Label bitmaps are drawn at their font size × this factor (the device pixel ratio
  // on screen; the export's own scale while a view export renders).
  let _labelRasterScale = 1;

  function _drawLabelCanvas(canvas, text, colorHex, fontSize, rasterScale) {
    const ctx = canvas.getContext('2d');
    const px = fontSize * rasterScale;
    ctx.font = `bold ${px}px sans-serif`;
    const textWidth = ctx.measureText(text).width;
    const pad = px * 0.4;
    canvas.width = Math.max(1, Math.ceil(textWidth + pad * 2));
    canvas.height = Math.max(1, Math.ceil(px + pad * 2));
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `bold ${px}px sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.lineWidth = Math.max(2, px * 0.12);
    ctx.strokeStyle = '#000000';
    ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
    ctx.fillStyle = colorHex;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  }

  function _createMeasurementTextSprite(text, colorHex, anchorPoint) {
    if (!text || text.trim() === '') return null;
    const canvas = document.createElement('canvas');
    const fontSize = _measurementTextSize;
    _drawLabelCanvas(canvas, text, colorHex, fontSize, _labelRasterScale);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
      map: texture,
      depthTest: false,
      transparent: true
    });

    const sprite = new THREE.Sprite(material);
    // World size of the label: canvas pixels at raster scale 1 × (0.0015 / 48) world
    // units per pixel per 48 px of font — independent of the bitmap's resolution.
    const scale = (0.0015 / 48) * fontSize / _labelRasterScale;
    sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);

    // The anchor in measurement-frame space is needed for position calculations
    sprite.userData = {
      isMeasurementLabel: true, anchorLocal: anchorPoint.clone(), anchor: anchorPoint.clone(),
      text, colorHex, fontSize, rasterScale: _labelRasterScale
    };

    return sprite;
  }

  /** Redraw every label bitmap at `rasterScale` pixels per font pixel, in place (the
   *  sprites, and so the scene, are unchanged — only their textures). */
  function _setLabelRasterScale(rasterScale) {
    const next = Math.max(1, Math.min(8, Number(rasterScale) || 1));
    if (next === _labelRasterScale) return;
    _labelRasterScale = next;
    for (const sprite of _measurementSprites) {
      const ud = sprite.userData;
      const map = sprite.material?.map;
      if (!map?.image || !ud?.text) continue;
      _drawLabelCanvas(map.image, ud.text, ud.colorHex, ud.fontSize, next);
      ud.rasterScale = next;
      // A resized canvas needs a fresh GPU texture of the new size.
      map.dispose();
      map.needsUpdate = true;
    }
    _scheduleFrame();
  }

  function _renderMeasurements() {
    if (!_measurementGroup) return;
    _syncMeasurementFrame();
    _labelLayoutVersion++;

    // Clear lines and markers
    for (let i = _measurementGroup.children.length - 1; i >= 0; i--) {
      const child = _measurementGroup.children[i];
      if (child === _labelsGroup) continue;
      _measurementGroup.remove(child);
      child.geometry?.dispose?.();
      child.material?.dispose?.();
      child.children?.forEach(grandChild => {
        grandChild.geometry?.dispose?.();
        grandChild.material?.dispose?.();
      });
    }

    // Clear sprites
    if (_labelsGroup) {
      while (_labelsGroup.children.length) {
        const sprite = _labelsGroup.children[_labelsGroup.children.length - 1];
        _labelsGroup.remove(sprite);
        sprite.material?.map?.dispose?.();
        sprite.material?.dispose?.();
      }
    }
    _measurementSprites = [];

    _measurements.forEach(item => {
      if (item.visible === false) return;
      const points = Array.isArray(item.points) ? item.points : [];
      if (points.length !== 2) return;
      const a = _pointLocal(points[0]);
      const b = _pointLocal(points[1]);
      if (!a || !b) return;

      const color = item.color || '#ff4d4f';
      _measurementGroup.add(_measurementLine(a, b, color));

      if (_showMeasurementLabels && _labelsGroup) {
        // Extremity furthest from the volume centre (the frame's origin)
        const aDist = a.lengthSq();
        const bDist = b.lengthSq();
        const anchorLocal = aDist > bDist ? a.clone() : b.clone();

        const labelText = item.label ? `${item.label}: ` : '';
        // BUG-007: distance may be absent/non-finite (e.g. degenerate or partially-restored measurement) — show em-dash instead of throwing.
        const d = Number.isFinite(item.distance) ? item.distance.toFixed(1) + ' µm' : '—';
        const text = `${labelText}${d}`;
        const sprite = _createMeasurementTextSprite(text, color, anchorLocal);
        if (sprite) {
          sprite.userData.id = item.id;
          sprite.userData.measurement = item;
          _labelsGroup.add(sprite);
          _measurementSprites.push(sprite);
        }
      }
    });
    // Position labels using camera vectors
    _updateMeasurementLabelPositions();
    _scheduleFrame();
  }

  /** A normalised volume point ([0,1]³) in the measurement frame: (n − ½) ⊙ cube.scale. */
  function _pointLocal(point) {
    const normalized = point?.normalized || point;
    if (!normalized || !Number.isFinite(normalized.x) || !Number.isFinite(normalized.y) || !Number.isFinite(normalized.z)) return null;
    const s = cube ? cube.scale : { x: 1, y: 1, z: 1 };
    return new THREE.Vector3(
      (normalized.x - 0.5) * s.x,
      (normalized.y - 0.5) * s.y,
      (normalized.z - 0.5) * s.z
    );
  }

  function _measurementLine(a, b, colorHex) {
    const group = new THREE.Group();
    const distance = a.distanceTo(b);
    if (distance > 0) {
      const lineGeom = new THREE.CylinderGeometry(0.005, 0.005, distance, 8);
      const lineMat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.95, depthTest: false });
      const lineMesh = new THREE.Mesh(lineGeom, lineMat);
      lineMesh.position.copy(a).lerp(b, 0.5);
      lineMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      group.add(lineMesh);
    }
    group.add(_measurementMarker(a, colorHex));
    group.add(_measurementMarker(b, colorHex));
    return group;
  }

  function _measurementMarker(point, colorHex) {
    const size = 0.012;
    const geom = new THREE.SphereGeometry(size, 16, 16);
    const mat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.95, depthTest: false });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(point);
    return mesh;
  }

  function _startPlaneDrag(clientX, clientY) {
    if (!_cutPlaneMesh?.visible) return null;
    const hit = _intersectCutPlane(clientX, clientY);
    if (!hit) return null;
    const normalWorld = new THREE.Vector3(0, 0, 1).applyQuaternion(_cutPlaneMesh.getWorldQuaternion(new THREE.Quaternion())).normalize();
    const centerWorld = _cutPlaneMesh.getWorldPosition(new THREE.Vector3());
    const originScreen = _projectToScreen(centerWorld);
    const unitScreen = _projectToScreen(centerWorld.clone().add(normalWorld));
    if (!originScreen || !unitScreen) return null;
    const axis = {
      x: unitScreen.x - originScreen.x,
      y: unitScreen.y - originScreen.y
    };
    const axisLength = Math.hypot(axis.x, axis.y);
    if (axisLength < 2) return null;
    return {
      startValue: _planeSpec.value,
      startClientX: clientX,
      startClientY: clientY,
      axisX: axis.x / axisLength,
      axisY: axis.y / axisLength,
      pixelsPerUnit: axisLength,
      // Depth per unit of value: 1, or the display box's extent along the normal on a
      // stabilised timelapse (the value sweeps that box), so the plane keeps pace with
      // the pointer either way.
      depthPerValue: _planeSweep(_planeSpec)?.slope || 1
    };
  }

  function _updatePlaneDrag(state, clientX, clientY) {
    if (!state) return;
    const deltaX = clientX - state.startClientX;
    const deltaY = clientY - state.startClientY;
    const travel = (deltaX * state.axisX) + (deltaY * state.axisY);
    const next = state.startValue + (travel / Math.max(8, state.pixelsPerUnit)) / (state.depthPerValue || 1);
    setPlaneSpec({ value: next, visible: true });
  }

  function _intersectCutPlane(clientX, clientY) {
    if (!_raycaster || !_pointer || !camera || !_cutPlaneMesh || !renderer) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    _pointer.x = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    _pointer.y = -(((clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
    _raycaster.setFromCamera(_pointer, camera);
    const hits = _raycaster.intersectObject(_cutPlaneMesh, false);
    return hits[0] || null;
  }

  function _projectToScreen(world) {
    if (!camera || !renderer || !world) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const projected = world.clone().project(camera);
    return {
      x: ((projected.x + 1) * 0.5) * rect.width,
      y: ((1 - projected.y) * 0.5) * rect.height
    };
  }

  function _intersectInteractionHandles(clientX, clientY) {
    if (!camera || !renderer) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    // PERF-004: reuse module-level _raycaster/_pointer (synchronous, not retained)
    _pointer.set(((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1, -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1);
    _raycaster.setFromCamera(_pointer, camera);
    const intersectables = [];
    const _vgAxesGroup = typeof VolumeGrid !== 'undefined' ? VolumeGrid.getAxesGroup() : null;
    const _vgGridGroup = typeof VolumeGrid !== 'undefined' ? VolumeGrid.getGridGroup() : null;
    if ((typeof VolumeGrid !== 'undefined' && VolumeGrid.isAxesVisible()) && _vgAxesGroup) {
      _vgAxesGroup.children.forEach(c => { if (c.userData && c.userData.isAxesSphere) intersectables.push(c); });
    }
    if ((typeof VolumeGrid !== 'undefined' && VolumeGrid.getGridMode() > 0) && _vgGridGroup) {
      _vgGridGroup.children.forEach(c => { if (c.userData && c.userData.isGridHandle && c.material.opacity > 0) intersectables.push(c); });
    }
    const hits = _raycaster.intersectObjects(intersectables);
    return hits.length > 0 ? hits[0] : null;
  }

  function _updateCutPlaneMesh() {
    if (!_cutPlaneMesh) return;
    _cutPlaneMesh.visible = Boolean(_planeSpec.visible);
    _syncCutPlaneToOrbit();
    // Gizmo always hidden (removed)
    if (_rotGizmo) _rotGizmo.visible = false;
  }

  /** Sync cut plane world-space transform to match cube orbit + planeSpec. */
  function _syncCutPlaneToOrbit() {
    if (!_cutPlaneMesh || !cube) return;

    // Plane orientation in cube-local (normalized) space
    const localOrientation = _orientationForPlaneSpec(_planeSpec);
    const localNormal = _normalForPlaneSpec(_planeSpec);

    // Local position along normal, scaled by cube dimensions. The depth is the
    // slicer's (VolumeSlicer.planeSweep): value − ½, or on a stabilised timelapse the
    // display box the value sweeps.
    const sweep = _planeSweep(_planeSpec);
    const localPos = localNormal.clone().multiplyScalar(_planeDepth(_planeSpec, sweep));
    localPos.multiply(cube.scale);
    // The display box is larger than the volume and off its centre: the plane is drawn
    // around the box centre's orthogonal projection on it (in this cube-rotated frame,
    // where the plane's normal is localNormal), as the slicer frames it.
    let boxScale = null;
    if (sweep) {
      const toCentre = sweep.box.centre.clone().multiply(cube.scale).sub(localPos);
      localPos.add(toCentre.addScaledVector(localNormal, -toCentre.dot(localNormal)));
      boxScale = sweep.box.size.clone().multiply(cube.scale);
    }

    // Cube's world rotation (from orbit controls)
    const cubeRot = cube.quaternion;

    // World orientation = cubeRotation * localOrientation
    _cutPlaneMesh.quaternion.copy(cubeRot).multiply(localOrientation);

    // World position = cubeRotation * (localPos) + cube.position
    const worldPos = localPos.applyQuaternion(cubeRot).add(cube.position);
    _cutPlaneMesh.position.copy(worldPos);

    // Scale: use the cube's max axis so the plane covers the volume (the display box's)
    const s = _planeSpec.mode === 'oblique' ? 1.45 : 1.04;
    const maxScale = boxScale
      ? Math.max(boxScale.x, boxScale.y, boxScale.z)
      : Math.max(cube.scale.x, cube.scale.y, cube.scale.z);
    _cutPlaneMesh.scale.set(s * maxScale, s * maxScale, 1);

    _updateCutSlabFaces();
  }

  // World half-thickness of the MIP/average slab, measured along the plane normal.
  // Mirrors volume-slicer.js: each of the (slabThickness-1) extra samples integrates
  // maxP/256 µm along the normal, so the slab spans (steps-1)·maxP/256 µm; one world
  // unit equals `reference` µm (max x/y physical extent, the cube-scale reference).
  // Returns 0 for the thin single-sample plane. chunk-debug derives the same value, so
  // its yellow band and these faces always coincide.
  function _slabHalfWorld() {
    const proj = _planeSpec.projection || 'single';
    const steps = Math.max(1, Math.min(64, _finiteNumber(_planeSpec.slabThickness, 1)));
    if ((proj !== 'mip' && proj !== 'average') || steps <= 1) return 0;
    const p = _physicalSizeUm;
    const px = p && p.x > 0 ? p.x : 1;
    const py = p && p.y > 0 ? p.y : 1;
    const pz = p && p.z > 0 ? p.z : 1;
    const maxP = Math.max(px, py, pz);
    const reference = Math.max(px, py) || 1;
    return ((steps - 1) * maxP / 256) / (2 * reference);
  }

  // Position/show the two slab faces at ±halfWorld along the plane normal (local +Z).
  function _updateCutSlabFaces() {
    if (!_cutSlabFaceA || !_cutSlabFaceB) return;
    const half = _slabHalfWorld();
    const on = half > 0 && Boolean(_planeSpec.visible);
    _cutSlabFaceA.visible = on;
    _cutSlabFaceB.visible = on;
    if (!on) return;
    _cutSlabFaceA.position.set(0, 0, half);
    _cutSlabFaceB.position.set(0, 0, -half);
  }

  function _syncRotGizmoTransform() {
    if (!_rotGizmo || !_rotGizmo.visible || !_cutPlaneMesh || !cube || !camera || !renderer) return;
    cube.updateMatrixWorld(true);
    _cutPlaneMesh.updateMatrixWorld(true);
    _cutPlaneMesh.getWorldPosition(_rotGizmo.position);
    _cutPlaneMesh.getWorldQuaternion(_rotGizmo.quaternion);
    const dist = Math.max(0.1, camera.position.distanceTo(_rotGizmo.position));
    const viewHeight = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) * dist;
    const worldPerPixel = viewHeight / Math.max(1, renderer.domElement.clientHeight);
    const targetRadiusPx = 54;
    const targetRadiusWorld = worldPerPixel * targetRadiusPx;
    const baseRadius = 0.13;
    const uniformScale = Math.max(0.42, Math.min(4.0, targetRadiusWorld / baseRadius));
    _rotGizmo.scale.set(uniformScale, uniformScale, uniformScale);
  }

  function setCutPlane(axis = _cutPlane.axis, value = _cutPlane.value, options = {}) {
    const safeAxis = ['x', 'y', 'z'].includes(axis) ? axis : 'z';
    setPlaneSpec({
      mode: _modeForAxis(safeAxis),
      value,
      visible: options.visible ?? true
    }, options);
  }

  function setCutPlaneVisible(visible) {
    setPlaneSpec({ visible: Boolean(visible) });
  }

  function getCutPlaneState() {
    return { ..._cutPlane, mode: _planeSpec.mode };
  }

  function onCutPlaneChange(callback) {
    if (typeof callback !== 'function') return () => {};
    _cutPlaneListeners.add(callback);
    return () => _cutPlaneListeners.delete(callback);
  }

  function getPlaneSpec() {
    const normal = _normalForPlaneSpec(_planeSpec);
    const orientation = _orientationForPlaneSpec(_planeSpec);
    return {
      ..._planeSpec,
      normal: normal.toArray(),
      orientation: orientation.toArray()
    };
  }

  function setPlaneSpec(spec = {}, options = {}) {
    const next = { ..._planeSpec, ...spec };
    // A quaternion only carries information for an oblique plane: a named mode
    // (xy / xz / yz) defines its own orientation, and re-deriving it from the
    // quaternion a saved or synced spec carries would turn the plane oblique with
    // its pitch clamped to +/-89 deg - one degree off the plane that was saved.
    const namedMode = ['xy', 'xz', 'yz'].includes(spec.mode);
    if (!namedMode && Array.isArray(spec.orientation) && spec.orientation.length === 4) {
      _applyOrientationToSpec(next, spec.orientation);
    }
    if (spec.axis && !spec.mode) next.mode = _modeForAxis(spec.axis);
    next.mode = ['xy', 'xz', 'yz', 'oblique'].includes(next.mode) ? next.mode : 'xy';
    next.axis = _axisForMode(next.mode);
    next.value = _clamp01(Number(next.value));
    next.yaw = _finiteNumber(next.yaw, 0);
    next.pitch = Math.max(-89, Math.min(89, _finiteNumber(next.pitch, 0)));
    next.roll = _finiteNumber(next.roll, 0);
    next.slabThickness = Math.max(1, Math.min(64, _finiteNumber(next.slabThickness, 1)));
    next.projection = ['single', 'mip', 'average'].includes(next.projection) ? next.projection : 'single';
    next.visible = options.visible ?? spec.visible ?? next.visible ?? true;
    next.orientation = _orientationForPlaneSpec(next).toArray();

    _planeSpec = next;
    _cutPlane = {
      axis: next.axis,
      value: next.value,
      visible: next.visible
    };

    _updateCutPlaneMesh();
    if (options.notify !== false) _notifyPlaneChange();
    _scheduleFrame();
  }

  function onPlaneSpecChange(callback) {
    if (typeof callback !== 'function') return () => {};
    _planeSpecListeners.add(callback);
    return () => _planeSpecListeners.delete(callback);
  }

  function _notifyPlaneChange() {
    const cutState = getCutPlaneState();
    const planeState = getPlaneSpec();
    _cutPlaneListeners.forEach(callback => callback(cutState));
    _planeSpecListeners.forEach(callback => callback(planeState));
  }

  function _axisForMode(mode) {
    if (mode === 'xz') return 'y';
    if (mode === 'yz') return 'x';
    if (mode === 'oblique') return 'oblique';
    return 'z';
  }

  function _modeForAxis(axis) {
    if (axis === 'x') return 'yz';
    if (axis === 'y') return 'xz';
    return 'xy';
  }

  /**
   * How the plane's value maps to a depth along its normal (object units), from the
   * slicer that samples the plane (VolumeSlicer.planeSweep) so the mesh on screen and
   * the slice agree: null unwarped (depth = value − ½), else { offset, slope, box } —
   * on a stabilised timelapse the value sweeps the display box, the box the clip
   * sliders act in, instead of the acquisition box it outgrows.
   */
  function _planeSweep(spec = _planeSpec) {
    if (typeof VolumeSlicer === 'undefined' || !VolumeSlicer.planeSweep || !VolumeSlicer.samplingSpace) return null;
    const space = VolumeSlicer.samplingSpace(material);
    if (!space) return null;
    const sweep = VolumeSlicer.planeSweep(spec, getPhysicalSize(), space);
    return sweep && sweep.box ? sweep : null;
  }

  function _planeDepth(spec = _planeSpec, sweep = _planeSweep(spec)) {
    const value = Number.isFinite(Number(spec.value)) ? Number(spec.value) : 0.5;
    return sweep ? sweep.offset + value * sweep.slope : value - 0.5;
  }

  /** The value that puts `spec`'s plane at `depth` (unclamped): _planeDepth's inverse. */
  function _planeValueAtDepth(spec, depth) {
    const sweep = _planeSweep(spec);
    return sweep ? (depth - sweep.offset) / sweep.slope : depth + 0.5;
  }

  function _normalForPlaneSpec(spec = _planeSpec) {
    if (spec.mode === 'yz') return new THREE.Vector3(1, 0, 0);
    if (spec.mode === 'xz') return new THREE.Vector3(0, 1, 0);
    if (spec.mode === 'oblique') {
      const yaw = THREE.MathUtils.degToRad(_finiteNumber(spec.yaw, 0));
      const pitch = THREE.MathUtils.degToRad(_finiteNumber(spec.pitch, 0));
      const roll = THREE.MathUtils.degToRad(_finiteNumber(spec.roll, 0));
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch, -yaw, roll, 'YXZ'));
      return new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
    }
    return new THREE.Vector3(0, 0, 1);
  }

  function _orientationForPlaneSpec(spec = _planeSpec) {
    if (spec.mode !== 'oblique') {
      // BUG-038: apply roll about the plane normal (local +Z) in orthogonal modes too — previously ignored for xy/xz/yz.
      const base = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), _normalForPlaneSpec(spec));
      const roll = THREE.MathUtils.degToRad(_finiteNumber(spec.roll, 0));
      if (roll !== 0) {
        base.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll));
      }
      return base;
    }
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(
      -_finiteNumber(spec.pitch, 0) * Math.PI / 180,
      -_finiteNumber(spec.yaw, 0) * Math.PI / 180,
      _finiteNumber(spec.roll, 0) * Math.PI / 180,
      'YXZ'
    ));
  }

  // Inverse of _orientationForPlaneSpec for an oblique plane: the quaternion is
  // Euler(-pitch, -yaw, roll, 'YXZ'), so the same decomposition gives the angles
  // back with their signs (the normal alone loses the sign of the yaw: n.x = -cos p sin y).
  function _applyOrientationToSpec(spec, orientation) {
    const q = new THREE.Quaternion().fromArray(orientation).normalize();
    const euler = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    spec.mode = 'oblique';
    spec.yaw = -THREE.MathUtils.radToDeg(euler.y);
    spec.pitch = -THREE.MathUtils.radToDeg(euler.x);
    spec.roll = THREE.MathUtils.radToDeg(euler.z);
    spec.orientation = q.toArray();
  }

  function _clamp01(value) {
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1.0;
  }

  function _finiteNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function setActiveTool(tool) {
    _activeTool = tool || 'navigate';
    setCutPlaneVisible(_activeTool === 'cut');
  }

  function placePlaneAtPoint(point, options = {}) {
    if (!point?.normalized) return;
    // point.normalized is the object point + ½; the value that puts the plane through
    // it is read with the plane's own depth map (the coordinate itself unwarped).
    const sweep = _planeSweep(_planeSpec);
    const valueAt = (coordinate) => (sweep ? (coordinate - 0.5 - sweep.offset) / sweep.slope : coordinate);
    if (_planeSpec.mode === 'yz') {
      setPlaneSpec({ value: valueAt(point.normalized.x), visible: options.visible ?? true });
      return;
    }
    if (_planeSpec.mode === 'xz') {
      setPlaneSpec({ value: valueAt(point.normalized.y), visible: options.visible ?? true });
      return;
    }
    if (_planeSpec.mode === 'oblique') {
      const normal = _normalForPlaneSpec(_planeSpec);
      const local = new THREE.Vector3(
        point.normalized.x - 0.5,
        point.normalized.y - 0.5,
        point.normalized.z - 0.5
      );
      const alongNormal = THREE.MathUtils.clamp(_planeValueAtDepth(_planeSpec, local.dot(normal)), 0, 1);
      setPlaneSpec({ value: alongNormal, visible: options.visible ?? true });
      return;
    }
    setPlaneSpec({ value: valueAt(point.normalized.z), visible: options.visible ?? true });
  }

  /**
   * The volume point under a client-space position.
   * @returns {{normalized:{x,y,z}, physicalUm:{x,y,z}|null, screen:{x,y},
   *   depthSource:'projection'|'volume'|'bounding-box', onBoundingBox:boolean}|null}
   *   depthSource 'volume': the depth of the first visible structure under the pixel
   *   (GPU pick, see the shader's PICK_MODE); 'projection': a grid projection wall;
   *   'bounding-box': nothing visible there (or no GPU pick possible) — the point is
   *   where the ray enters the box and its depth means nothing (onBoundingBox: true).
   */
  function pickVolumePoint(clientX, clientY) {
    if (!_raycaster || !_pointer || !camera || !cube || !renderer) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    _pointer.x = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    _pointer.y = -(((clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
    _raycaster.setFromCamera(_pointer, camera);

    let local = null;
    let source = null;

    // First check projections
    const _vgGridGrp = typeof VolumeGrid !== 'undefined' ? VolumeGrid.getGridGroup() : null;
    if (_vgGridGrp) {
       const projMeshes = [];
       _vgGridGrp.traverse(c => { if (c.isMesh && (c.userData.isProjSurface || c.userData.isProjMesh)) projMeshes.push(c); });
       if (projMeshes.length > 0) {
          const hits = _raycaster.intersectObjects(projMeshes, false);
          if (hits.length > 0) {
             local = hits[0].point.clone().applyMatrix4(new THREE.Matrix4().copy(cube.matrixWorld).invert());
             source = 'projection';
          }
       }
    }

    // Then the volume: the depth the GPU reads along this pixel's ray.
    if (!local && material && material.visible) {
      local = _gpuPickPoint(clientX - rect.left, clientY - rect.top, rect.width, rect.height);
      if (local) source = 'volume';
    }
    if (!local && material && material.visible) {
      const localRay = _raycaster.ray.clone().applyMatrix4(new THREE.Matrix4().copy(cube.matrixWorld).invert());
      local = localRay.intersectBox(
        new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)),
        new THREE.Vector3()
      );
      if (local) source = 'bounding-box';
    }

    if (!local) return null;
    const isProj = source === 'projection';

    const norm = {
      x: isProj ? local.x + 0.5 : Math.max(0, Math.min(1, local.x + 0.5)),
      y: isProj ? local.y + 0.5 : Math.max(0, Math.min(1, local.y + 0.5)),
      z: isProj ? local.z + 0.5 : Math.max(0, Math.min(1, local.z + 0.5))
    };
    const physical = getPhysicalSize();
    return {
      normalized: norm,
      physicalUm: physical ? {
        x: norm.x * physical.x,
        y: norm.y * physical.y,
        z: norm.z * physical.z
      } : null,
      screen: { x: clientX - rect.left, y: clientY - rect.top },
      depthSource: source,
      onBoundingBox: source === 'bounding-box'
    };
  }

  // GPU pick: the cube drawn alone, with the ray-march shader in PICK_MODE (same
  // uniforms object as the volume, so the same window, channels, clip box, z-stack
  // slab, warp and bricks), into a 1×1 target windowed onto the clicked pixel.
  let _pick = null;

  function _pickResources() {
    if (_pick) return _pick;
    const target = new THREE.WebGLRenderTarget(1, 1, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false
    });
    const pickMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: material.uniforms,
      defines: {},
      side: THREE.BackSide,
      transparent: false,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending
    });
    const mesh = new THREE.Mesh(cube.geometry, pickMaterial);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    const pickScene = new THREE.Scene();
    pickScene.add(mesh);
    _pick = { target, material: pickMaterial, mesh, scene: pickScene, definesKey: '', pixels: new Uint8Array(4) };
    return _pick;
  }

  function _disposePickResources() {
    if (!_pick) return;
    _pick.target.dispose();
    _pick.material.dispose();
    _pick = null;
  }

  /**
   * Decode the two pick passes into the cube-local point. Each pass is an RGBA8
   * texel: pass 0 = (x hi, x lo, y hi, y lo), pass 1 = (z hi, z lo, 255, 255), the
   * 16-bit fixed point of the position in the box the march ran in — the unit box
   * (p + ½) unwarped, the display box (clipBoxMin + c·clipBoxSize) on a stabilised
   * timelapse. A pass-1 alpha of 0 means the ray found nothing.
   * @returns {THREE.Vector3|null}
   */
  function _decodePickTexels(xy, zf, warped, boxMin, boxSize, out = new THREE.Vector3()) {
    if (!xy || !zf || zf[3] < 128) return null;
    const u16 = (hi, lo) => (hi * 256 + lo) / 65535;
    const c = [u16(xy[0], xy[1]), u16(xy[2], xy[3]), u16(zf[0], zf[1])];
    if (warped) return out.set(boxMin.x + c[0] * boxSize.x, boxMin.y + c[1] * boxSize.y, boxMin.z + c[2] * boxSize.z);
    return out.set(c[0] - 0.5, c[1] - 0.5, c[2] - 0.5);
  }

  function _gpuPickPoint(px, py, cssWidth, cssHeight) {
    if (_contextLost || !renderer || !_activeVolumeEntry || !(cssWidth > 0) || !(cssHeight > 0)) return null;
    const gl = renderer.getContext();
    if (gl.isContextLost?.()) return null;
    const pick = _pickResources();
    const defines = { ...(material.defines || {}), PICK_MODE: 1 };
    const key = JSON.stringify(defines);
    if (key !== pick.definesKey) {
      pick.material.defines = defines;
      pick.material.needsUpdate = true;
      pick.definesKey = key;
    }
    if (pick.mesh.geometry !== cube.geometry) pick.mesh.geometry = cube.geometry;
    cube.updateMatrixWorld(true);
    pick.mesh.matrix.copy(cube.matrixWorld);
    pick.mesh.matrixWorld.copy(cube.matrixWorld);
    camera.updateMatrixWorld();

    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevPass = material.uniforms.pickPass.value;
    const x = Math.max(0, Math.min(cssWidth - 1, Math.floor(px)));
    const y = Math.max(0, Math.min(cssHeight - 1, Math.floor(py)));
    const texels = [];
    try {
      // The 1×1 window of the full frustum whose centre is the clicked pixel's.
      camera.setViewOffset(cssWidth, cssHeight, x, y, 1, 1);
      renderer.setClearColor(0x000000, 0);
      for (let pass = 0; pass < 2; pass++) {
        material.uniforms.pickPass.value = pass;
        renderer.setRenderTarget(pick.target);
        renderer.clear(true, false, false);
        renderer.render(pick.scene, camera);
        renderer.readRenderTargetPixels(pick.target, 0, 0, 1, 1, pick.pixels);
        texels.push(Array.from(pick.pixels));
      }
    } catch (err) {
      console.warn('[VolumeViewer] GPU depth pick failed:', err);
      return null;
    } finally {
      camera.clearViewOffset();
      material.uniforms.pickPass.value = prevPass;
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClear, prevAlpha);
    }
    const warped = Boolean(material.defines?.VOLUME_WARP);
    return _decodePickTexels(texels[0], texels[1], warped,
      material.uniforms.clipBoxMin.value, material.uniforms.clipBoxSize.value);
  }

  function onMeasurePoint(callback) {
    _onMeasurePoint = callback;
  }

  function setBackgroundPreset(preset = 'dark', customColor = '#000000') {
    const resolved = typeof DisplayPresets !== 'undefined'
      ? DisplayPresets.resolve(preset, customColor)
      : { id: 'dark', color: '#000000', transparent: false };
    _displayState = {
      backgroundPreset: resolved.id,
      backgroundColor: resolved.color
    };
    const backdrop = _container?.parentElement;
    if (backdrop) backdrop.style.background = resolved.transparent ? 'transparent' : resolved.color;
    if (renderer) renderer.setClearColor(0x000000, 0);
  }

  function getChannelHistograms() {
    return _channelHistograms.map(hist => ({
      bins: hist.bins,
      counts: [...hist.counts],
      max: hist.max,
      total: hist.total
    }));
  }

  function getCacheStats() {
    let cachedGpu = 0;
    let cachedCpu = 0;
    for (const e of _volumeCache.values()) { cachedGpu += _entryGpuBytes(e); cachedCpu += _entryCpuBytes(e); }
    const active = _activeVolumeEntry;
    return {
      images: _imageCache.size,
      volumes: _volumeCache.size,
      activeTextureKey: _activeTextureKey,
      cachedGpuBytes: cachedGpu,
      cachedCpuBytes: cachedCpu,
      activeGpuBytes: active && !_isEntryCached(active) ? _entryGpuBytes(active) : 0,
      residentGpuBytes: _residentGpuBytes(),
      cacheBudgetBytes: _volumeCacheBudget(),
      vramBudgetBytes: _gpuBudgetBytes()
    };
  }

  function getSamplingVolume() {
    if (!_activeVolumeEntry || (!_activeVolumeEntry.data && !_activeVolumeEntry.textures)) return null;
    return {
      data: _activeVolumeEntry.data,
      textures: _activeVolumeEntry.textures,
      width: _activeVolumeEntry.width,
      height: _activeVolumeEntry.height,
      depth: _activeVolumeEntry.depth,
      sourceWidth: _activeVolumeEntry.sourceWidth,
      sourceHeight: _activeVolumeEntry.sourceHeight,
      sourceDepth: _activeVolumeEntry.sourceDepth,
      channels: _activeVolumeEntry.channels,
      zIndices: [...(_activeVolumeEntry.zIndices || [])],
      quality: _activeVolumeEntry.quality,
      basePath: _activeVolumeEntry.basePath,
      timepoint: _activeVolumeEntry.timepoint,
      backgroundSuppressed: _activeVolumeEntry.backgroundSuppressed === true,
      physicalSizeUm: getPhysicalSize()
    };
  }

  function getPhysicalSize() {
    return _physicalSizeUm
      ? { ..._physicalSizeUm, zDisplayScale: _zDisplayScale, mode: _scaleMode }
      : null;
  }

  function getPhysicalCalibration() {
    if (!_physicalSizeUm) return null;
    return {
      xUm: _physicalSizeUm.x,
      yUm: _physicalSizeUm.y,
      zUm: _physicalSizeUm.z,
      sliceThicknessUm: _physicalSizeUm.sliceThickness,
      voxelXUm: _physicalSizeUm.voxelX,
      voxelYUm: _physicalSizeUm.voxelY,
      voxelZUm: _physicalSizeUm.voxelZ,
      calibrationStatus: _physicalSizeUm.calibrationStatus || 'metadata-missing',
      calibrationNote: _physicalSizeUm.calibrationNote || ''
    };
  }

  function getDisplayScaleState() {
    return {
      zDisplayScale: _zDisplayScale
    };
  }

  function getCameraState() {
    if (!camera || !cube) return null;
    return {
      kind: 'volume',
      cameraZ: camera.position.z,
      quaternion: cube.quaternion.toArray(),
      position: cube.position.toArray(),
      zDisplayScale: _zDisplayScale
    };
  }

  function getDisplayState() {
    return { ..._displayState };
  }

  function applyDisplayState(state = {}) {
    if (state.backgroundPreset || state.backgroundColor) {
      setBackgroundPreset(state.backgroundPreset || _displayState.backgroundPreset, state.backgroundColor || _displayState.backgroundColor);
    }
  }

  function setCameraState(state) {
    if (!state || !camera || !cube) return;
    if (state.kind && state.kind !== 'volume') return;
    if (!Number.isFinite(state.cameraZ) && !Array.isArray(state.quaternion) && !Array.isArray(state.position)) return;
    
    // Prevent default fitCameraToVolume from overwriting this restored state
    _hasLoadedVolume = true;
    if (Number.isFinite(state.cameraZ)) camera.position.z = state.cameraZ;
    if (Number.isFinite(state.zDisplayScale)) {
      setZDisplayScale(state.zDisplayScale, { notify: false });
    }
    // BUG-029: validate restored transform — reject non-finite / degenerate quaternions and normalize before copy.
    if (Array.isArray(state.quaternion) && state.quaternion.length === 4 && state.quaternion.every(Number.isFinite)) {
      const q = new THREE.Quaternion().fromArray(state.quaternion);
      if (q.lengthSq() > 1e-8) { _poseAnim = null; cube.quaternion.copy(q.normalize()); }
    }
    if (Array.isArray(state.position) && state.position.length === 3 && state.position.every(Number.isFinite)) {
      cube.position.fromArray(state.position);
    }
    _scheduleFrame();
  }

  function onCameraChange(callback) {
    if (typeof callback !== 'function') return () => {};
    _cameraListeners.add(callback);
    return () => _cameraListeners.delete(callback);
  }

  let _cameraSyncPending = false;
  function _notifyCameraChange() {
    _scheduleFrame();
    // Throttle via rAF: coalesce multiple pointermove calls into one notification per frame
    if (_cameraSyncPending) return;
    _cameraSyncPending = true;
    requestAnimationFrame(() => {
      _cameraSyncPending = false;
      const state = getCameraState();
      _cameraListeners.forEach(callback => callback(state));
    });
  }

  function setQualityTarget(target = '512x512', mode = null) {
    if (mode !== null) {
      _currentQualityMode = mode;
    } else if (target === '256x256' || target === '512x512' || target === '1024x1024' || target === 'native') {
      _currentQualityMode = target;
    }
    const safe = _normalizeQualityKey(target);
    _qualityTarget = safe;
    _emitQualityState({ target: safe });
  }

  function getQualityState() {
    return { ..._qualityState };
  }

  function onQualityProgress(callback) {
    if (typeof callback !== 'function') return () => {};
    _qualityListeners.add(callback);
    callback(getQualityState());
    return () => _qualityListeners.delete(callback);
  }

  // ELE-18: visible-status hooks for WebGL context loss/restore (wired by viewer.js).
  function onContextLost(callback) { _onContextLost = (typeof callback === 'function') ? callback : null; }
  function onContextRestored(callback) { _onContextRestored = (typeof callback === 'function') ? callback : null; }

  function _emitQualityState(patch = {}) {
    // `streaming` tells the page a load is under way (the progress line shows);
    // any other new message (ready, cancelled, an error) ends it.
    if (patch.message !== undefined && patch.streaming === undefined) patch = { ...patch, streaming: false };
    _qualityState = { ..._qualityState, ...patch };
    _qualityListeners.forEach(callback => callback({ ..._qualityState }));
  }

  // --- Grid and Axes (delegated to VolumeGrid module) ---

  let _gridDisposeBound = false;
  function _initVolumeGrid() {
    if (typeof VolumeGrid === 'undefined') return;
    VolumeGrid.init({
      scene,
      cube,
      camera,
      renderer,
      material,
      projVertexShader,
      fragmentShader,
      onDirty: _scheduleFrame,
      getPhysicalSize
    });
    // LEAK-001/ELE-30 (Rule 1.2): VolumeGrid.dispose() releases the grid/axes
    // groups' GPU resources (geometries, materials, sprite CanvasTextures). In a
    // mono-shot page the one real teardown event is pagehide — wire it so the
    // dispose contract is actually honored (and per-iframe on the Compare page).
    if (typeof window !== 'undefined' && !_gridDisposeBound) {
      _gridDisposeBound = true;
      window.addEventListener('pagehide', () => {
        if (typeof VolumeGrid !== 'undefined') VolumeGrid.dispose();
      });
    }
  }

  function _updateGridsAndAxes() {
    if (typeof VolumeGrid !== 'undefined') VolumeGrid.rebuild();
  }

  function _syncGridRotation() {
    if (typeof VolumeGrid !== 'undefined') VolumeGrid.syncTransforms();
  }

  function _moveAxesToScreenPoint(clientX, clientY) {
    if (typeof VolumeGrid !== 'undefined') VolumeGrid.moveAxesToScreenPoint(clientX, clientY);
  }

  function setGridMode(mode) {
    if (typeof VolumeGrid !== 'undefined') VolumeGrid.setGridMode(mode);
  }

  function setAxesVisible(visible) {
    if (typeof VolumeGrid !== 'undefined') VolumeGrid.setAxesVisible(visible);
  }

  /** Hide / show the volume (cube mesh). Projections remain visible. */
  function setVolumeVisible(visible) {
    if (material) {
      material.visible = visible;
      _scheduleFrame();
    }
  }

  /**
   * Switch render mode: 0 = DVR (depth/structure), 1 = Emission MIP (Imaris-like),
   * 2 = Natural Fluorescence (emission–absorption, chroma-locked).
   */
  /**
   * Switch render mode: 0 = Structure DVR, 1 = per-channel MIP ('fluorescence'),
   * 2 = Natural Fluorescence. Numbers, numeric strings ('2', what a sandboxed plugin
   * sends) and the mode names are accepted; anything else is refused (false) instead
   * of silently becoming MIP.
   * @returns {boolean} true when the mode was applied
   */
  function setRenderMode(mode) {
    if (!material?.uniforms) return false;
    const names = { dvr: 0, 'structure-dvr': 0, structure: 0, mip: 1, fluorescence: 1, natural: 2, 'natural-fluorescence': 2 };
    let m = null;
    if (typeof mode === 'string' && Object.prototype.hasOwnProperty.call(names, mode.trim().toLowerCase())) {
      m = names[mode.trim().toLowerCase()];
    } else if (mode !== null && mode !== '' && Number.isInteger(Number(mode)) && [0, 1, 2].includes(Number(mode))) {
      m = Number(mode);
    }
    if (m === null) {
      console.warn(`[VolumeViewer] setRenderMode: unknown render mode ${JSON.stringify(mode)} — ignored`);
      return false;
    }
    // The cross-fade material shares this uniform object (PER_VOLUME_UNIFORMS).
    material.uniforms.renderMode.value = m;
    _scheduleFrame();
    return true;
  }

  function getRenderMode() {
    return material?.uniforms ? material.uniforms.renderMode.value : null;
  }

  /**
   * Tune the Natural Fluorescence (mode 2) look. Every key is optional and clamped to a
   * safe range; unknown / non-finite values are ignored.
   */
  function setFluorescenceParams(params = {}) {
    if (!material?.uniforms) return;
    const u = material.uniforms;
    const set = (key, v, lo, hi) => {
      if (v === undefined || v === null) return;
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      u[key].value = Math.max(lo, Math.min(hi, n));
    };
    set('absorption',   params.absorption,   0.3, 6.0);
    set('emissionGain', params.emissionGain, 0.2, 6.0);
    set('whitePoint',   params.whitePoint,   0.1, 8.0);
    set('saturation',   params.saturation,   0.5, 2.0);
    set('colocWhiten',  params.colocWhiten,  0.0, 1.0);
    set('colocGamma',   params.colocGamma,   1.0, 4.0);
    _scheduleFrame();
  }

  /**
   * Set global exposure/brightness multiplier (default 1.0)
   */
  function setExposure(value) {
    if (!material?.uniforms) return;
    material.uniforms.exposure.value = Math.max(0.1, Math.min(10.0, Number(value) || 1.0));
    _scheduleFrame();
  }

  // ── 3D view export (PNG) ──────────────────────────────────────────────────────────
  // The current view rendered off screen at any size, tile by tile, through the scene,
  // camera and ray-march materials the render loop draws, at the idle step count —
  // never the reduced frame shown while interacting or streaming. The dialog, the file
  // and the scale bar belong to viewer.js (_bindViewExport).

  let _viewExportInFlight = false;

  /** Pixel ratio of an idle frame; _animate lowers it while interacting/streaming. */
  function _idlePixelRatio() {
    return Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
  }

  /**
   * The 3D view's size: CSS pixels, and the device pixels of an idle frame's drawing
   * buffer (three floors CSS size × pixel ratio). null before init().
   */
  function getViewSize() {
    if (!renderer) return null;
    const css = renderer.getSize(new THREE.Vector2());
    const pixelRatio = _idlePixelRatio();
    return {
      cssWidth: css.x,
      cssHeight: css.y,
      pixelRatio,
      width: Math.max(1, Math.floor(css.x * pixelRatio)),
      height: Math.max(1, Math.floor(css.y * pixelRatio))
    };
  }

  /**
   * µm per pixel of an image `imageHeight` pixels tall showing `cam`'s view, read at
   * the depth of the specimen centre — the rule of the on-screen bar
   * (VolumeGrid._updateScaleBar). A perspective camera maps a length L lying in the
   * view plane at depth d, measured along the view axis (so a panned specimen keeps
   * its scale), to L / (2·tan(fov/2)·d) of the image height, and one world unit is
   * physical.x / cube.scale.x µm (computePhysicalScale normalises the cube to the
   * longer of X and Y; X carries no display override). Hence
   *     µm per pixel = 2·tan(fov/2)·d · (physical.x / cube.scale.x) / imageHeight.
   * Neither the aspect ratio nor a view offset enters: pixels are square, and a tile of
   * a view-offset camera keeps the pitch of the full image. 0 without a calibration
   * (a bar would count voxels) or with the specimen behind the camera.
   */
  function _micronsPerPixelFor(cam, cubeObj, physical, imageHeight) {
    if (!cam || !cubeObj || !(imageHeight > 0)) return 0;
    const calibrated = physical && physical.calibrationStatus !== 'metadata-missing' && physical.mode !== 'metadata-missing';
    const umPerUnit = calibrated && cubeObj.scale.x > 0 ? Number(physical.x) / cubeObj.scale.x : 0;
    if (!(umPerUnit > 0)) return 0;
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const depth = new THREE.Vector3().copy(cubeObj.position).sub(cam.position).dot(dir);
    if (!(depth > 0)) return 0;
    const heightAtDepth = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * depth;
    return heightAtDepth * umPerUnit / imageHeight;
  }

  /** µm per pixel of an image `imageHeight` pixels tall of the current view (see above). */
  function micronsPerPixel(imageHeight) {
    return _micronsPerPixelFor(camera, cube, getPhysicalSize(), imageHeight);
  }

  /**
   * Tiles of a width × height image, row-major from the top-left corner, at most
   * `tile` pixels a side. Tile {x, y, w, h} covers columns [x, x+w) and rows [y, y+h),
   * rows counted downward (the canvas's convention and three's view-offset one), so
   * every pixel of the image belongs to exactly one tile.
   */
  function _planExportTiles(width, height, tile) {
    const tiles = [];
    const step = Math.max(1, Math.floor(tile));
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        tiles.push({ x, y, w: Math.min(step, width - x), h: Math.min(step, height - y) });
      }
    }
    return tiles;
  }

  /**
   * camera.setViewOffset arguments for one tile: its window of the full width × height
   * frustum. three moves the near-plane window by offsetX·(window width)/W to the right
   * and offsetY·(window height)/H down, and shrinks it to w/W × h/H, so a world point
   * that lands on pixel (px, py) of the full image lands on (px − x, py − y) of the tile.
   */
  function _exportTileViewOffset(t, width, height) {
    return [width, height, t.x, t.y, t.w, t.h];
  }

  /**
   * gl_FragCoord offset of one tile. The tile is drawn into a w × h viewport whose
   * origin is its BOTTOM-left pixel (GL window coordinates), so its fragment (fx, fy)
   * is fragment (x + fx, H − (y + h) + fy) of one full-size render. Adding
   * (x, H − y − h) feeds the ray-march jitter that coordinate: the dither runs on
   * across tile seams exactly as a single W × H frame would draw it.
   */
  function _exportTileFragOffset(t, height) {
    return [t.x, height - t.y - t.h];
  }

  /**
   * Render-target configurations, best first: the largest tile the GPU takes with the
   * canvas's multisampling, the same without it, then halving down to 256 px. One that
   * cannot be allocated (or runs out of memory) falls through to the next.
   */
  function _exportTileConfigs(maxTile, samples) {
    const configs = [];
    let tile = Math.max(1, Math.floor(maxTile));
    if (samples > 0) configs.push({ tile, samples });
    for (;;) {
      configs.push({ tile, samples: 0 });
      if (tile <= 256) break;
      tile = Math.max(256, Math.floor(tile / 2));
    }
    return configs;
  }

  function _viewExportError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  function _viewExportAbortError() {
    try {
      return new DOMException('View export cancelled', 'AbortError');
    } catch (_) {
      const err = new Error('View export cancelled');
      err.name = 'AbortError';
      return err;
    }
  }

  function _throwIfViewExportStopped(signal) {
    if (signal && signal.aborted) throw _viewExportAbortError();
    if (_contextLost || renderer?.getContext?.()?.isContextLost?.()) {
      throw _viewExportError('context-lost', 'The GPU context was lost during the export');
    }
  }

  // A macrotask, not a frame: requestAnimationFrame is frozen in a hidden tab, and a
  // MessageChannel message (unlike setTimeout) is not throttled there either.
  function _macrotask() {
    return new Promise(resolve => {
      if (typeof MessageChannel === 'function') {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
        channel.port2.postMessage(0);
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  /** Drains the GL error queue; true when `code` was among the errors. */
  function _glErrorsInclude(gl, code) {
    let hit = false;
    for (let i = 0; i < 16; i++) {
      const error = gl.getError();
      if (error === gl.NO_ERROR) break;
      if (error === code) hit = true;
    }
    return hit;
  }

  /**
   * The output canvas, or null when the browser cannot hold it. Past its limits a
   * browser may still hand out a context whose drawing is silently dropped, so one
   * pixel is written in the far corner and read back.
   */
  function _allocExportCanvas(width, height) {
    let canvas = null;
    try {
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx && canvas.width === width && canvas.height === height) {
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(width - 1, height - 1, 1, 1);
        const probe = ctx.getImageData(width - 1, height - 1, 1, 1).data;
        ctx.clearRect(width - 1, height - 1, 1, 1);
        if (probe[0] === 255 && probe[3] === 255) return { canvas, ctx };
      }
    } catch (_) { /* fall through: not allocatable */ }
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    return null;
  }

  /**
   * The GPU pass that turns a rendered tile into the bytes of the image. The tile holds
   * premultiplied colour (C, A) — the ray-march adds light C at alpha 1, sprites and
   * lines blend "over" — with row 0 at the bottom (GL window origin). It is read
   * row-flipped, so the read-back comes out top row first, then either composited over
   * the background exactly as the browser composites the canvas over the page,
   * C + B·(1 − A), or un-premultiplied for a transparent PNG, whose pixels are straight
   * (C/A, A).
   */
  function _createExportComposite(background) {
    const hex = typeof background === 'string' ? background : '#000000';
    const channel = (i) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    const compositeMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        tileTex: { value: null },
        tileHeight: { value: 1 },
        background: { value: new THREE.Vector3(channel(0), channel(1), channel(2)) },
        opaque: { value: background ? 1 : 0 }
      },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        precision highp float;
        precision highp int;
        uniform sampler2D tileTex;
        uniform int tileHeight;
        uniform vec3 background;
        uniform int opaque;
        out vec4 exportColor;
        void main() {
          ivec2 p = ivec2(gl_FragCoord.xy);
          vec4 src = texelFetch(tileTex, ivec2(p.x, tileHeight - 1 - p.y), 0);
          if (opaque == 1) {
            exportColor = vec4(src.rgb + background * (1.0 - src.a), 1.0);
          } else {
            exportColor = src.a > 0.0 ? vec4(min(src.rgb / src.a, vec3(1.0)), src.a) : vec4(0.0);
          }
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending
    });
    const geometry = new THREE.PlaneGeometry(2, 2);
    const quad = new THREE.Mesh(geometry, compositeMaterial);
    quad.frustumCulled = false;
    const compositeScene = new THREE.Scene();
    compositeScene.add(quad);
    return {
      scene: compositeScene,
      camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
      material: compositeMaterial,
      geometry,
      uniforms: compositeMaterial.uniforms
    };
  }

  /**
   * The two off-screen targets of one configuration (the render, multisampled like the
   * canvas when possible, and the composite) plus the read-back buffer, or null when
   * the GPU (or the JS heap) refuses them.
   */
  function _allocExportTargets(config, width, height) {
    const gl = renderer.getContext();
    const w = Math.min(config.tile, width);
    const h = Math.min(config.tile, height);
    const base = {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      stencilBuffer: false
    };
    const prevTarget = renderer.getRenderTarget();
    let renderTarget = null;
    let compositeTarget = null;
    _glErrorsInclude(gl, gl.OUT_OF_MEMORY);
    try {
      renderTarget = new THREE.WebGLRenderTarget(w, h, { ...base, depthBuffer: true, samples: config.samples });
      compositeTarget = new THREE.WebGLRenderTarget(w, h, { ...base, depthBuffer: false });
      for (const target of [renderTarget, compositeTarget]) {
        renderer.setRenderTarget(target); // allocates the GL storage
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('incomplete framebuffer');
      }
      if (_glErrorsInclude(gl, gl.OUT_OF_MEMORY)) throw new Error('GPU out of memory');
      const pixels = new Uint8Array(w * h * 4);
      return { render: renderTarget, composite: compositeTarget, pixels, tile: config.tile, samples: config.samples };
    } catch (err) {
      console.warn(`[VolumeViewer] View export: ${config.tile}px tiles (${config.samples}× MSAA) unavailable:`, err?.message || err);
      renderTarget?.dispose();
      compositeTarget?.dispose();
      return null;
    } finally {
      renderer.setRenderTarget(prevTarget);
    }
  }

  function _disposeExportTargets(targets) {
    if (!targets) return;
    targets.render?.dispose();
    targets.composite?.dispose();
  }

  /** Every material drawing with the ray-march shader: the volume, a cross-fade cube,
   *  the grid's projection walls (they share the fragment shader). */
  function _rayMarchMaterials() {
    const found = new Set();
    scene.traverse((obj) => {
      const m = obj.material;
      if (m && !Array.isArray(m) && m.isShaderMaterial && m.fragmentShader === fragmentShader) found.add(m);
    });
    return [...found];
  }

  // The premultiplied twin of a ray-march material's blending, used while the shader
  // writes coverage alpha (transparent export): the same compositing of light, with the
  // colour no longer multiplied by that alpha on the way in.
  //   AdditiveBlending (SRC_ALPHA, ONE; screen alpha 1 → dst + C)   → (ONE, ONE)
  //   NormalBlending   (SRC_ALPHA, 1−SRC_ALPHA; alpha 1 → C)         → (ONE, 1−SRC_ALPHA)
  // At alpha 1 either twin gives exactly the screen's result.
  function _premultipliedBlendFactors(blending) {
    if (blending === THREE.AdditiveBlending) return [THREE.OneFactor, THREE.OneFactor];
    if (blending === THREE.NormalBlending) return [THREE.OneFactor, THREE.OneMinusSrcAlphaFactor];
    return null;
  }

  /** The scene sync _animate runs before it renders (gizmo, grid and axes, cross-fade
   *  cube, cut plane, measurement labels), for an off-screen frame. */
  function _prepareExportFrame() {
    try {
      _syncRotGizmoTransform();
      _syncGridRotation();
      if (_transitionCube) {
        _transitionCube.position.copy(cube.position);
        _transitionCube.quaternion.copy(cube.quaternion);
        _transitionCube.scale.copy(cube.scale);
      }
      if (_cutPlaneMesh?.visible) _syncCutPlaneToOrbit();
      _updateMeasurementLabelPositions(false, null);
    } catch (err) {
      console.warn('[VolumeViewer] Error in export pre-render update:', err);
    }
  }

  /**
   * One tile. The snapshot pose, the idle step count and the tile's jitter offset go
   * on the live scene; the tile's window of the full frustum is rendered off screen,
   * composited, read back and written into the output canvas. Everything it changed is
   * put back in `finally` — render target, clear colour, materials, pose — so the live
   * view never sees an export state, even when a render throws. Synchronous: no frame
   * of the render loop can run in between. false on GPU out-of-memory.
   */
  function _renderExportTile(tile, job) {
    const { width, height, snap, targets, composite, ctx, background } = job;
    const gl = renderer.getContext();
    const prevTarget = renderer.getRenderTarget();
    const prevClearColor = renderer.getClearColor(new THREE.Color());
    const prevClearAlpha = renderer.getClearAlpha();
    const prevSteps = material.uniforms.steps.value;
    const prevRate = material.uniforms.sampleRate.value;
    const live = {
      position: cube.position.clone(),
      quaternion: cube.quaternion.clone(),
      scale: cube.scale.clone(),
      interacting: cube.userData.isInteractingNow
    };
    const marchers = _rayMarchMaterials().map((m) => ({
      m,
      blending: m.blending,
      blendEquation: m.blendEquation,
      blendSrc: m.blendSrc,
      blendDst: m.blendDst,
      blendEquationAlpha: m.blendEquationAlpha,
      blendSrcAlpha: m.blendSrcAlpha,
      blendDstAlpha: m.blendDstAlpha,
      exportAlpha: m.uniforms?.exportAlpha ? m.uniforms.exportAlpha.value : null,
      offset: m.uniforms?.fragCoordOffset ? m.uniforms.fragCoordOffset.value.clone() : null
    }));
    try {
      cube.position.copy(snap.position);
      cube.quaternion.copy(snap.quaternion);
      cube.scale.copy(snap.scale);
      cube.userData.isInteractingNow = false;
      // The labels, the cut plane and the grid are laid out from this pose.
      cube.updateMatrixWorld(true);
      material.uniforms.steps.value = _targetSteps;
      material.uniforms.sampleRate.value = IDLE_SAMPLE_RATE;
      const [fx, fy] = _exportTileFragOffset(tile, height);
      for (const saved of marchers) {
        const m = saved.m;
        if (m.uniforms?.fragCoordOffset) m.uniforms.fragCoordOffset.value.set(fx, fy);
        if (background !== null) continue;
        if (m.uniforms?.exportAlpha) m.uniforms.exportAlpha.value = 1;
        const factors = _premultipliedBlendFactors(saved.blending);
        if (factors) {
          m.blending = THREE.CustomBlending;
          m.blendEquation = THREE.AddEquation;
          m.blendSrc = factors[0];
          m.blendDst = factors[1];
          m.blendEquationAlpha = null;
          m.blendSrcAlpha = null;
          m.blendDstAlpha = null;
        }
      }
      _prepareExportFrame();

      snap.camera.setViewOffset(..._exportTileViewOffset(tile, width, height));
      targets.render.viewport.set(0, 0, tile.w, tile.h);
      renderer.setRenderTarget(targets.render);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(scene, snap.camera);

      composite.uniforms.tileTex.value = targets.render.texture;
      composite.uniforms.tileHeight.value = tile.h;
      targets.composite.viewport.set(0, 0, tile.w, tile.h);
      renderer.setRenderTarget(targets.composite);
      renderer.render(composite.scene, composite.camera);
      renderer.readRenderTargetPixels(targets.composite, 0, 0, tile.w, tile.h, targets.pixels);
      if (gl.isContextLost()) throw _viewExportError('context-lost', 'The GPU context was lost during the export');
      if (_glErrorsInclude(gl, gl.OUT_OF_MEMORY)) return false;
      const bytes = new Uint8ClampedArray(targets.pixels.buffer, 0, tile.w * tile.h * 4);
      ctx.putImageData(new ImageData(bytes, tile.w, tile.h), tile.x, tile.y);
      return true;
    } finally {
      snap.camera.clearViewOffset();
      composite.uniforms.tileTex.value = null;
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClearColor, prevClearAlpha);
      material.uniforms.steps.value = prevSteps;
      material.uniforms.sampleRate.value = prevRate;
      for (const saved of marchers) {
        const m = saved.m;
        m.blending = saved.blending;
        m.blendEquation = saved.blendEquation;
        m.blendSrc = saved.blendSrc;
        m.blendDst = saved.blendDst;
        m.blendEquationAlpha = saved.blendEquationAlpha;
        m.blendSrcAlpha = saved.blendSrcAlpha;
        m.blendDstAlpha = saved.blendDstAlpha;
        if (saved.exportAlpha !== null) m.uniforms.exportAlpha.value = saved.exportAlpha;
        if (saved.offset) m.uniforms.fragCoordOffset.value.copy(saved.offset);
      }
      cube.position.copy(live.position);
      cube.quaternion.copy(live.quaternion);
      cube.scale.copy(live.scale);
      cube.userData.isInteractingNow = live.interacting;
      cube.updateMatrixWorld(true);
      _prepareExportFrame();
    }
  }

  /**
   * true while anything still writes into the displayed volume: a brick stream, or the
   * current slice-stack load. _fgStreamActive counts the display streams because a
   * superseded stream's `finally` clears _isStreamingBricks while the one that
   * replaced it (a quality switch mid-stream) is still landing bricks.
   */
  function _isVolumeStreaming() {
    if (_isStreamingBricks || _fgStreamActive > 0) return true;
    for (const job of _sliceLoads) {
      if (job.loadId && job.loadId === _loadCounter) return true;
    }
    return false;
  }

  // Uniforms a tile sets (and puts back) itself, or that the render loop tunes every
  // frame (steps: the tile renders with _targetSteps whatever the loop left there).
  const EXPORT_VOLATILE_UNIFORMS = new Set(['steps', 'sampleRate', 'pickPass', 'fragCoordOffset', 'exportAlpha']);

  function _pushExportValue(out, v) {
    if (v === null || v === undefined) { out.push(null); return; }
    const type = typeof v;
    if (type === 'number' || type === 'boolean' || type === 'string') { out.push(v); return; }
    // A texture counts by identity and upload version (a re-upload changes what it shows).
    if (v.isTexture) { out.push(v.id, v.version); return; }
    if (v.isMatrix3 || v.isMatrix4) { for (let i = 0; i < v.elements.length; i++) out.push(v.elements[i]); return; }
    if (v.isVector2) { out.push(v.x, v.y); return; }
    if (v.isVector3) { out.push(v.x, v.y, v.z); return; }
    if (v.isVector4 || v.isQuaternion) { out.push(v.x, v.y, v.z, v.w); return; }
    if (v.isColor) { out.push(v.r, v.g, v.b); return; }
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      out.push(v.length);
      for (let i = 0; i < v.length; i++) _pushExportValue(out, v[i]);
      return;
    }
    out.push(v);
  }

  /**
   * Everything a tile reads that the user can change while the export runs (the
   * sidebar and toolbar stay live), as one flat array: every ray-march material's
   * visibility, defines and uniform values (exposure, render mode, channel colour /
   * window / gamma / opacity / on-off, clip box, stabilisation warp, textures), every
   * object of the scene with its visibility (grid, axes, tracking layer,
   * measurements, cut plane — shown, hidden, added, removed), the cube scale (the
   * z display scale), the idle step count and the cut plane. The pose is not in it:
   * the tiles render a snapshot of it.
   */
  function _exportFingerprint() {
    const out = [];
    for (const m of _rayMarchMaterials()) {
      out.push(m.id, m.visible);
      const defines = m.defines || {};
      for (const key of Object.keys(defines)) out.push(key, defines[key]);
      const uniforms = m.uniforms || {};
      for (const key of Object.keys(uniforms)) {
        if (EXPORT_VOLATILE_UNIFORMS.has(key)) continue;
        out.push(key);
        _pushExportValue(out, uniforms[key]?.value);
      }
    }
    scene.traverse((obj) => { out.push(obj.id, obj.visible); });
    out.push(cube.scale.x, cube.scale.y, cube.scale.z, _targetSteps);
    const plane = _planeSpec || {};
    out.push(plane.mode, plane.value, plane.yaw, plane.pitch, plane.roll, plane.visible);
    return out;
  }

  function _sameExportFingerprint(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      // NaN equals NaN here: an unset value must not read as a change.
      if (a[i] !== b[i] && !(a[i] !== a[i] && b[i] !== b[i])) return false;
    }
    return true;
  }

  /** Resolves once nothing is feeding the displayed volume, reporting its progress:
   *  tiles rendered while bricks or slices land would each show a different volume. */
  async function _waitForSteadyVolume(signal, onProgress) {
    for (;;) {
      _throwIfViewExportStopped(signal);
      if (!_isVolumeStreaming()) return;
      onProgress({ phase: 'waiting', progress: Math.max(0, Math.min(1, Number(_qualityState.progress) || 0)) });
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  /**
   * Render the current view into a width × height canvas (device pixels): the same
   * picture as the screen, sharper. Each tile is one window of the full frustum
   * (camera.setViewOffset) drawn into an off-screen target, so the output may exceed
   * what the GPU renders in one pass; tiles are rendered one per macrotask, from a
   * snapshot of the pose taken once the volume stopped streaming — a tile rendered
   * while bricks or slices land, after the volume was swapped (timepoint, quality), or
   * after a display setting changed (_exportFingerprint: channels, exposure, render
   * mode, clip, grid / axes / overlays, z scale) restarts the image, three times at most.
   *
   * Background: '#rrggbb' composites the render over that colour exactly as the page
   * shows the canvas; anything else gives a transparent PNG whose ray-march pixels
   * carry coverage alpha (see fragAlpha in the shader) — over black it is the screen
   * image, over anything else a faint glow stays translucent instead of turning into
   * an opaque dark pixel.
   *
   * @param {{width:number, height:number, background?:string|null,
   *          onProgress?:Function, signal?:AbortSignal}} options
   *   onProgress receives { phase: 'waiting', progress } (0..1 of the stream) or
   *   { phase: 'render', tile, tiles } before each tile.
   * @returns {Promise<HTMLCanvasElement>} carrying `exportInfo` = { micronsPerPixel
   *   (of the output, 0 without calibration), tileSize, tiles, samples }. Rejects with
   *   an AbortError on cancel, else an Error whose `code` is 'busy' | 'no-view' | 'size'
   *   | 'canvas' | 'gpu-memory' | 'context-lost' | 'unstable' (the volume kept loading
   *   or changing) | 'display-changed' (the display settings kept changing).
   */
  async function renderViewImage(options = {}) {
    const width = Math.floor(Number(options.width));
    const height = Math.floor(Number(options.height));
    const signal = options.signal || null;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const background = typeof options.background === 'string' && /^#[0-9a-f]{6}$/i.test(options.background)
      ? options.background.toLowerCase()
      : null;
    if (_viewExportInFlight) throw _viewExportError('busy', 'A view export is already running');
    if (!renderer || !scene || !camera || !cube || !material) throw _viewExportError('no-view', 'The 3D view is not ready');
    if (!(width > 0) || !(height > 0)) throw _viewExportError('size', `Invalid export size ${options.width} × ${options.height}`);
    _viewExportInFlight = true;
    let targets = null;
    let composite = null;
    let output = null;
    try {
      _throwIfViewExportStopped(signal);
      output = _allocExportCanvas(width, height);
      if (!output) throw _viewExportError('canvas', `The browser cannot allocate a ${width} × ${height} image`);
      composite = _createExportComposite(background);
      const gl = renderer.getContext();
      const caps = renderer.capabilities || {};
      const viewportMax = gl.getParameter(gl.MAX_VIEWPORT_DIMS) || [2048, 2048];
      const maxTile = Math.min(
        2048,
        caps.maxTextureSize || 2048,
        gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 2048,
        viewportMax[0] || 2048,
        viewportMax[1] || 2048
      );
      const configs = _exportTileConfigs(maxTile, caps.isWebGL2 ? Math.min(4, caps.maxSamples || 0) : 0);
      let configIndex = 0;
      let restarts = 0;
      let lastChange = 'volume';
      // The view the user had when asking: taken now (not after the wait for the
      // volume), and a pose still flying is taken where it lands. The camera keeps its
      // vertical field of view at the image's own aspect, so a size that is not the
      // screen's shows more or less of the scene, never a stretched one.
      const snap = {
        camera: camera.clone(),
        position: cube.position.clone(),
        quaternion: (_poseAnim ? _poseAnim.to : cube.quaternion).clone(),
        scale: cube.scale.clone()
      };
      snap.camera.aspect = width / height;
      snap.camera.updateProjectionMatrix();
      // Label bitmaps at the export's own pixel density (restored in finally).
      const cssHeight = renderer.getSize ? renderer.getSize(new THREE.Vector2()).y : height;
      _setLabelRasterScale(Math.ceil(height / Math.max(1, cssHeight)));
      for (;;) {
        await _waitForSteadyVolume(signal, onProgress);
        const entry = _activeVolumeEntry;
        const fingerprint = _exportFingerprint();
        while (!targets && configIndex < configs.length) {
          targets = _allocExportTargets(configs[configIndex], width, height);
          if (!targets) configIndex++;
        }
        if (!targets) throw _viewExportError('gpu-memory', 'Not enough GPU memory for the export, even in 256 px tiles');
        const tiles = _planExportTiles(width, height, targets.tile);
        const job = { width, height, snap, targets, composite, ctx: output.ctx, background };
        let outcome = 'done';
        for (let i = 0; i < tiles.length; i++) {
          _throwIfViewExportStopped(signal);
          if (_isVolumeStreaming() || _activeVolumeEntry !== entry) { outcome = 'changed'; lastChange = 'volume'; break; }
          // A display setting changed between two tiles: the image would be banded.
          if (!_sameExportFingerprint(fingerprint, _exportFingerprint())) { outcome = 'changed'; lastChange = 'display'; break; }
          onProgress({ phase: 'render', tile: i + 1, tiles: tiles.length });
          if (!_renderExportTile(tiles[i], job)) { outcome = 'oom'; break; }
          await _macrotask();
        }
        if (outcome === 'done') {
          output.canvas.exportInfo = {
            micronsPerPixel: _micronsPerPixelFor(snap.camera, snap, getPhysicalSize(), height),
            tileSize: targets.tile,
            tiles: tiles.length,
            samples: targets.samples
          };
          return output.canvas;
        }
        output.ctx.clearRect(0, 0, width, height);
        if (outcome === 'oom') {
          _disposeExportTargets(targets);
          targets = null;
          configIndex++;
          continue;
        }
        restarts++;
        if (restarts > 3) {
          throw lastChange === 'display'
            ? _viewExportError('display-changed', 'The display settings kept changing during the export')
            : _viewExportError('unstable', 'The volume kept changing during the export');
        }
      }
    } catch (err) {
      if (output) { output.canvas.width = 0; output.canvas.height = 0; }
      throw err;
    } finally {
      _disposeExportTargets(targets);
      if (composite) {
        composite.material.dispose();
        composite.geometry.dispose();
      }
      _setLabelRasterScale(_idlePixelRatio());
      _viewExportInFlight = false;
      _scheduleFrame();
    }
  }

  function getMaterial() {
    return material;
  }

  // Throttle state of the stream's progress reports (_emitThrottledProgress).
  const _progressEmit = { value: -1, at: 0 };

  return {
    init,
    dispose,
    releaseDataset,
    renderNow,
    getCapabilities,
    getQualityFootprints,
    getQualityLevels,
    getActiveLevel,
    selectBrickManifest: (manifest, timepoint) => _selectBrickManifestForTimepoint(manifest, timepoint),
    setDetailMode,
    getGpuCompression,
    setGpuCompression,
    getDetailStatus,
    onDetailStatus,
    refreshDetail: () => _roiSchedule('request'),
    loadVolume,
    preloadVolume,
    updateChannel,
    setClip,
    setClipRange,
    setRotationLocked: (locked) => { _rotationLocked = !!locked; },
    setView,
    setStabilizationSpace,
    setTimepointTransform,
    isStabilized,
    setActiveTool,
    setCutPlane,
    setCutPlaneVisible,
    getCutPlaneState,
    onCutPlaneChange,
    getPlaneSpec,
    setPlaneSpec,
    onPlaneSpecChange,
    pickVolumePoint,
    placePlaneAtPoint,
    onMeasurePoint,
    centerSample,
    setHomeQuaternion,
    setFrameQuaternion,
    setSampleUpsideDown,
    isSampleUpsideDown,
    getRawPoseQuaternion: (flag) => _rawPoseQuaternion(flag === undefined ? _upsideDown : Boolean(flag)),
    isPoseAnimating: () => _poseAnim !== null,
    getScreenFrameInVolume,
    resetView,
    resetClipping,
    fitCameraToVolume,
    setZDisplayScale,
    setBackgroundPreset,
    computePhysicalScale,
    getPhysicalSize,
    getPhysicalCalibration,
    getDisplayScaleState,
    getSamplingVolume,
    getChannelHistograms,
    getCacheStats,
    setQualityTarget,
    getQualityState,
    onQualityProgress,
    onContextLost,
    onContextRestored,
    setShowMeasurementLabels,
    setMeasurementTextSize,
    setMeasurements,
    getMeasurementState,
    resize,
    getCameraState,
    setCameraState,
    setHasLoadedVolume: (val) => { _hasLoadedVolume = !!val; },
    onCameraChange,
    getDisplayState,
    applyDisplayState,
    computeScreenPixelSize: () => {
      if (!camera || !cube || !renderer) return 0;
      const dist = camera.position.distanceTo(cube.position);
      const vFov = THREE.MathUtils.degToRad(camera.fov);
      const screenH = 2.0 * dist * Math.tan(vFov / 2.0);
      const pr = renderer.domElement.clientHeight / screenH;
      return 1.73 * pr; 
    },
    setGridMode,
    setAxesVisible,
    setVolumeVisible,
    setRenderMode,
    getRenderMode,
    setExposure,
    setFluorescenceParams,
    getRenderer: () => renderer,
    getMaterial: () => material,
    makeRgbaBrickFromScalarChannels: _composeRgbaBrickFromScalarChannels,
    applyRgbaBrickLuts: _applyRgbaBrickLuts,
    floorLutsFromManifest: (manifest, channels, histograms = null) => _floorLuts(_floorsFromManifest(manifest, channels, histograms), channels),
    getScene: () => scene,
    getCamera: () => camera,
    // ── 3D view export (PNG) ──
    renderViewImage,
    getViewSize,
    micronsPerPixel,
    // ── Hooks for overlays that must live in the volume's own frame ──────────────
    // Parenting to `cube` (not to the scene) inherits the orbit, the pan, the
    // physical aspect scale and the operator's Z display scale for free — the grid
    // has to mirror all four by hand because it sits at the root.
    // ── Buffer state, for a video-style progress bar ────────────────────────────
    /** Timepoints of `basePath` actually resident at `quality`, right now. */
    getCachedTimepoints: (basePath, quality) => _cachedTimepoints(basePath, quality),
    // Built with the RAW quality string, exactly as the writers do (:1552, :4250) —
    // normalising only here would miss every entry.
    hasCachedVolume: (basePath, quality, timepoint) =>
      _volumeCache.has(_volumeCacheKey(basePath, quality, timepoint)),
    /** How many frames of this series fit in the budget (0 = not measurable yet). */
    getBufferCapacity: (basePath, quality) => _bufferCapacity(basePath, quality),
    /** Tell eviction where playback is, so it keeps the frames coming up next. */
    setPlayheadHint,
    /** Abort a background prefetch in flight (quality change, dataset change,
     *  tab hidden). Cooperative: the batch stops at its next brick boundary. */
    cancelPreload: () => _cancelStream(_preloadStreamAbort),
    getVolumeObject: () => cube,
    /** Acquisition box in um, or null until setStabilizationSpace() has run. */
    getAcquisitionSpace: () => (_acqExtent
      ? { min: _acqExtent.min.clone(), max: _acqExtent.max.clone(), size: _acqExtent.size.clone() }
      : null),
    /** Acquisition um -> cube object space. Single source of the transform: copying
     *  the formula into a consumer is how two implementations of one change of frame
     *  start to drift. Returns null when no acquisition box is known. */
    umToObject: (v, out) => (_acqExtent ? _objectFromUm(v, out || new THREE.Vector3()) : null),
    /** True when an object-space point passes the SAME clip test the shader applies
     *  (Z-stack slab, per-axis clip sliders). Kept here so the overlay cannot drift
     *  from the volume: the shader reads clipCoord from clipBoxMin/Size under warp
     *  and from p+0.5 without it — this mirrors both branches exactly. */
    isInsideClip: (v) => {
      const u = material?.uniforms;
      if (!u) return true;
      let cx, cy, cz;
      if (_warpActive) {
        const lo = u.clipBoxMin.value, sz = u.clipBoxSize.value;
        cx = (v.x - lo.x) / sz.x; cy = (v.y - lo.y) / sz.y; cz = (v.z - lo.z) / sz.z;
      } else {
        cx = v.x + 0.5; cy = v.y + 0.5; cz = v.z + 0.5;
      }
      const lo = u.clipMin.value, hi = u.clipMax.value;
      return cx >= lo.x && cx <= hi.x && cy >= lo.y && cy <= hi.y && cz >= lo.z && cz <= hi.z;
    },
    /** The object-space box the normalised clip ranges act in, as the shader reads
     *  it: clipCoord ∈ [0,1]³ ↔ object min + clipCoord ⊙ size — the display box
     *  (clipBoxMin/Size) under VOLUME_WARP, the unit box (p + ½) otherwise. A range
     *  [a, b] of setClipRange('z', a, b) is thus the object slab
     *  min.z + [a, b]·size.z. Copies; `warped` mirrors the shader's define. */
    getClipSpace: () => {
      const u = material?.uniforms;
      if (material?.defines?.VOLUME_WARP && u?.clipBoxMin && u?.clipBoxSize) {
        return { warped: true, min: u.clipBoxMin.value.clone(), size: u.clipBoxSize.value.clone() };
      }
      return { warped: false, min: new THREE.Vector3(-0.5, -0.5, -0.5), size: new THREE.Vector3(1, 1, 1) };
    },
    triggerRender: _scheduleFrame,
    setOnPostRender: (cb) => {
      _onPostRender = cb;
      // LEAK-015 (Rule 1.2): hand back an unsubscribe so a consumer (e.g.
      // DecompositionPanel) can release the hook — and the closure it captures —
      // on teardown. Idempotent: only clears the slot if it still holds this cb.
      return () => { if (_onPostRender === cb) _onPostRender = null; };
    },
    loadBrickedVolumeStream,
    isBrickReady: () => typeof BrickLoader !== 'undefined' && BrickLoader.isReady(),
    recompileShaderForActiveChannels: _recompileShaderForActiveChannels
  };

  /**
   * Stream one quality of a bricked volume into a GPU texture: a dense 3D texture
   * when the level fits one, else a sparse SVR atlas of its non-empty bricks.
   *
   * options (besides quality / qualityMode / deferActivation / hideTransition /
   * ignoreVolumeCache / concurrency / verifyHashes / preload, unchanged):
   *   coarseFirst      on a first open (nothing on screen), show the coarsest level
   *                    first, then stream the requested one behind it and swap it in
   *                    when complete (default false).
   *   onFirstPicture(info)
   *                    called once something worth showing is on screen: the coarse
   *                    preview complete (coarseFirst), else FIRST_PICTURE_FRACTION of
   *                    the bricks — taken centre first — uploaded, or a cache hit.
   *                    info = { quality, lod, preview: boolean, fromCache: boolean }.
   *                    Not called for a deferred switch (the old volume stays shown)
   *                    nor for a prefetch.
   *
   * Resolves to { available, stale, quality, width, height, depth, lod, requestedLod,
   * downgraded, downgradeReason ('vram-budget' | 'alloc-failed' | 'capacity' | null),
   * neededBytes, budgetBytes, successfulLoads (bricks delivered), failedLoads (bricks
   * missing), missingBricks, degraded, fromCache, previewLod, contextLost, manifest, … }.
   * A volume with missing bricks is shown but never cached as complete.
   */
  async function loadBrickedVolumeStream(basePath, metadata, timepoint = null, onProgress = null, options = {}) {
    // ── Background prefetch mode ────────────────────────────────────────────────
    // Fills the cache for a timepoint that is NOT on screen. It must not touch a
    // single piece of displayed state, and it never runs while a display load is in
    // flight (a display load preempts it through _loadCounter).
    const preload = Boolean(options.preload);
    const isPreview = Boolean(options._previewOf);
    if (preload && _fgStreamActive > 0) return { available: false, reason: 'busy' };
    if (!preload) _fgStreamActive++;

    if (!preload) {
      if (!isPreview) {
        _cancelStream(_brickStreamAbort);
        if (!options._replay) _lastDisplayRequest = { kind: 'bricks', basePath, metadata, timepoint, onProgress, options };
      }
      // A new volume is coming: the detail bricks of the old one go (VRAM, loader group).
      _roiTeardown('stream');
      _clearTransitionVolume();
      if (options.qualityMode) {
        _currentQualityMode = options.qualityMode;
      } else if (options.quality) {
        if (options.quality === '256x256' || options.quality === '512x512' || options.quality === '1024x1024' || options.quality === 'native') {
          _currentQualityMode = options.quality;
        }
      }
      _isStreamingBricks = true;
    }
    try {
      const quality = _normalizeQualityKey(options.quality || '1024x1024');
      const shownQuality = isPreview ? options._previewOf : quality;
      // A prefetch is silent: _qualityState is a single merged singleton and the
      // progress overlay's visibility keys off a regex on its message, so emitting
      // from the background would flash the overlay once per prefetched frame.
      const emitState = preload ? (() => {}) : _emitQualityState;
      const firePicture = (info) => {
        if (preload || typeof options.onFirstPicture !== 'function') return;
        try { options.onFirstPicture(info); } catch (err) { console.warn('[VolumeViewer] onFirstPicture failed:', err); }
      };
      let deferActivation = Boolean(options.deferActivation && _activeVolumeEntry && (_activeVolumeEntry.textures || _activeVolumeEntry.data));
      const perfId = _perf()?.start('volume.load.bricks', { quality, timepoint });
      if (typeof BrickLoader === 'undefined') {
        _perf()?.end(perfId, { status: 'unavailable', reason: 'BrickLoader unavailable' });
        return { available: false, reason: 'BrickLoader unavailable' };
      }
      if (!preload && !isPreview) _qualityTarget = quality;
      const cacheKey = _volumeCacheKey(basePath, quality, timepoint);
      const cached = options.ignoreVolumeCache ? null : _getCachedVolume(cacheKey);
      if (cached) {
        if (preload) {
          _perf()?.end(perfId, { status: 'ok', fromCache: true, quality, preload: true });
          return { stale: false, available: true, cached: true, quality, preload: true };
        }
        _activateVolumeEntry(cached, metadata, cached.sourceDepth, cached.sourceWidth, cached.channels, options);
        _roiSchedule('volume');
        emitState({ active: shownQuality, mode: 'bricks', progress: 1, message: `${quality} ready from cache` });
        onProgress?.(1, quality);
        if (!deferActivation) firePicture({ quality, lod: cached.lod, preview: isPreview, fromCache: true });
        _perf()?.end(perfId, { status: 'ok', fromCache: true, quality, width: cached.width, height: cached.height, depth: cached.depth });
        return {
          stale: false,
          available: true,
          quality,
          width: cached.width,
          height: cached.height,
          depth: cached.depth,
          lod: cached.lod,
          requestedLod: cached.requestedLod,
          downgraded: Boolean(cached.downgraded),
          downgradeReason: cached.downgradeReason || null,
          successfulLoads: cached.successfulLoads || 0,
          failedLoads: 0,
          missingBricks: 0,
          degraded: false,
          fromCache: true,
          physicalSizeUm: _physicalSizeUm,
          scaleMode: _scaleMode,
          streamMode: 'bricks',
          manifest: cached.manifest
        };
      }
      // Read, not bump: the prefetch inherits the current id, so the moment a display
      // load starts (and bumps it) every `loadId !== _loadCounter` guard aborts the
      // prefetch. A coarse preview shares the id of the load it previews.
      const loadId = preload ? _loadCounter : (isPreview ? options._sharedLoadId : ++_loadCounter);
      const epoch = _contextEpoch;
      const brickDir = metadata?.qualities?.native?.directory || 'bricks';
      let manifest;
      try {
        manifest = await _fetchBrickManifest(`${basePath}/${brickDir}`);
      } catch (err) {
        _perf()?.end(perfId, { status: 'unavailable', quality, reason: err.message || String(err) });
        return { available: false, reason: err.message || String(err) };
      }
      if (loadId !== _loadCounter) {
        _perf()?.end(perfId, { status: 'stale', quality });
        return { stale: true };
      }

      const tpSelection = _selectBrickManifestForTimepoint(manifest, timepoint);
      if (!tpSelection.available) {
        _perf()?.end(perfId, { status: 'unavailable', quality, reason: tpSelection.reason });
        return { available: false, reason: tpSelection.reason };
      }
      const treePath = `${basePath}/${brickDir}${tpSelection.subPath ? `/${tpSelection.subPath}` : ''}`;
      BrickLoader.configure?.({
        concurrentLoads: options.concurrency || _brickConcurrencyForQuality(quality),
        verifyHashes: Boolean(options.verifyHashes ?? window.IRIBHM_VERIFY_BRICK_HASHES)
      });
      try {
        // A v3 tree mounts once its binary index has landed and checked out (a promise);
        // a v2 manifest mounts at once (an already resolved one).
        await BrickLoader.init(treePath, tpSelection.manifest);
      } catch (err) {
        // ELE-21: a rejected (malformed) manifest degrades to the {available:false}
        // contract (Rule 1.1/1.4) instead of an opaque throw.
        console.error('[VolumeViewer] Brick manifest rejected:', err);
        _perf()?.event('volume.bricks.manifest_rejected', { quality, reason: err.message });
        return { available: false, reason: err.message };
      }
      if (loadId !== _loadCounter) {
        _perf()?.end(perfId, { status: 'stale', quality });
        return { stale: true };
      }
      if (BrickLoader.getManifest?.() !== tpSelection.manifest) {
        // A later mount won while this tree's index was in flight (BrickLoader.init
        // resolves without mounting then): everything below reads the mounted tree.
        _perf()?.end(perfId, { status: 'stale', quality });
        return preload ? { available: false, reason: 'busy' } : { stale: true };
      }
      const levels = tpSelection.manifest.levels;
      const levelCount = levels ? (Array.isArray(levels) ? levels.length : Object.keys(levels).length) : 1;
      const treeFormat = BrickLoader.getFormat?.() || null;
      const bordered = Boolean(treeFormat && treeFormat.apron > 0);
      const requestedLod = _lodForQuality(quality, levelCount, levels, treeFormat?.version === 3);

      // ── Coarse level first ─────────────────────────────────────────────────────
      let previewLod = null;
      if (options.coarseFirst && !preload && !isPreview && !deferActivation && levelCount > 1 && requestedLod < levelCount - 1) {
        const coarse = levelCount - 1;
        emitState({ target: _qualityTarget, active: quality, mode: 'bricks', progress: 0, streaming: true, message: _t('viewer.qStreamingPreview', 'Streaming preview (LOD{lod}) before {quality}...', { lod: coarse, quality }) });
        const preview = await loadBrickedVolumeStream(basePath, metadata, timepoint, null, {
          ...options,
          quality: `lod${coarse}`,
          coarseFirst: false,
          deferActivation: false,
          onFirstPicture: null,
          _previewOf: quality,
          _sharedLoadId: loadId
        });
        if (loadId !== _loadCounter || epoch !== _contextEpoch) {
          _perf()?.end(perfId, { status: 'stale', quality });
          return preview?.contextLost ? preview : { stale: true };
        }
        if (preview?.available && _activeVolumeEntry) {
          previewLod = coarse;
          deferActivation = true;
          firePicture({ quality, lod: coarse, preview: true, fromCache: Boolean(preview.fromCache) });
        }
      }

      // A stream that replaces the volume on screen at once frees it first, so the
      // budget check below is made without it.
      if (!preload && !deferActivation) _detachActiveVolume();

      // Its OWN abort slot: a prefetch must never clear the foreground's.
      const abortSlot = { cancelled: false, loadId, controller: typeof AbortController === 'function' ? new AbortController() : null };
      if (!preload) _brickStreamAbort = abortSlot;
      else _preloadStreamAbort = abortSlot;
      const stopped = () => abortSlot.cancelled || loadId !== _loadCounter || epoch !== _contextEpoch;

      // ── Level and texture, within the GPU budget ────────────────────────────────
      const max3D = renderer?.capabilities?.max3DTextureSize || 2048;
      const rgbaTransport = BrickLoader.getTransportEncoding?.() === 'raw-rgba-gzip';
      const SVRClass = typeof SVRManager !== 'undefined' ? SVRManager : (window.SVRManager || null);
      // A GPU-compressed display atlas (getGpuCompression): a raw RGBA transport is
      // interleaved on this thread and is never encoded here.
      let useCompression = !rgbaTransport && _gpuCompressionWanted(metadata);
      // A prefetch fills the cache: an atlas the cache would not keep (native) is not
      // worth streaming in the background.
      const preloadSvr = _shouldCacheVolumeEntry({ svrManager: true, quality });
      let lod = requestedLod;
      let dims = null;
      let texture3D = null;
      let streamSvrManager = null;
      let footprint = null;
      let downgradeReason = null;
      let firstRefusal = null;
      const budget = _gpuBudgetBytes();
      for (;;) {
        const candidates = [];
        for (let l = lod; l < levelCount; l++) {
          const fp = _levelFootprint(l, { max3D, rgbaTransport, budget, compressed: useCompression });
          if (fp) candidates.push(fp);
        }
        const pinned = _pinnedGpuBytes();
        // Nothing on screen and nothing else to show: the coarsest level is attempted
        // even over the heuristic budget (only the GPU refusing it ends the load).
        const choice = _chooseStreamLevel(candidates, { available: budget - pinned, preload, preloadSvr, lastResort: !preload && !deferActivation });
        for (const s of choice.skipped) {
          if (!firstRefusal) firstRefusal = s;
          downgradeReason = downgradeReason || s.reason;
          if (s.reason === 'vram-budget') {
            emitState({ message: `${quality}: LOD${s.lod} needs ${_mib(s.bytes)} MiB of GPU memory (budget ${_mib(budget - pinned)} MiB) — trying LOD${s.lod + 1}...` });
          }
        }
        if (!choice.level) {
          const reason = preload && choice.skipped.some(s => s.reason === 'svr-preload') ? 'svr' : 'Insufficient GPU memory for every level';
          _perf()?.end(perfId, { status: 'unavailable', quality, reason });
          if (!preload) emitState({ message: `${quality}: no level fits the GPU memory budget (${_mib(budget)} MiB)` });
          return { available: false, reason, budgetBytes: budget, neededBytes: firstRefusal?.bytes || null };
        }
        footprint = choice.level;
        lod = footprint.lod;
        dims = BrickLoader.getDimensions(lod);
        if (preload && footprint.bytes > budget - _residentGpuBytes()) {
          _perf()?.end(perfId, { status: 'unavailable', reason: 'budget', quality });
          return { available: false, reason: 'budget' };
        }
        if (!preload) _freeGpuFor(footprint.bytes);
        const texturePerfId = _perf()?.start('texture.upload.prepare', { mode: 'bricks', quality, width: dims.x, height: dims.y, depth: dims.z });
        try {
          if (footprint.mode === 'svr') {
            if (!SVRClass) throw new Error('SVRManager unavailable: js/core/svr-manager.js must be loaded before volume-viewer.js');
            // A prefetched atlas publishes on no material: it reaches one when shown
            // (_activateVolumeEntry hands it the material and republishes).
            const svrMaterial = preload
              ? null
              : (deferActivation ? (_transitionMaterial || _beginTransitionVolume(null, footprint.channels)) : material);
            streamSvrManager = new SVRClass();
            streamSvrManager.init(footprint.channels, dims, renderer, svrMaterial, {
              // ≥ 2: a single slot would read as "no target" (largest layout the budget allows).
              targetSlots: Math.max(2, footprint.activeBricks),
              components: footprint.components,
              apron: bordered ? 1 : 0,
              ...(footprint.compressed ? { compression: 'bc' } : {}),
              // Dense textures are not SVR managers: the budget left for atlases is
              // the page's budget minus them (init subtracts the other live atlases).
              budgetBytes: Math.max(0, budget - (_residentGpuBytes() - SVRClass.liveAtlasBytes())),
              ignoreBudget: Boolean(footprint.overBudget)
            });
          } else {
            texture3D = _allocMonolithicTexture(dims.x, dims.y, dims.z, footprint.scalar);
          }
          _perf()?.end(texturePerfId, { status: 'ok' });
          break;
        } catch (err) {
          _perf()?.end(texturePerfId, { status: 'error' });
          streamSvrManager?.dispose?.();
          streamSvrManager = null;
          texture3D = null;
          if (err?.code === 'SVR_BAD_FORMAT' && footprint?.compressed) {
            // The compressed atlas is refused here (no RGTC after all): the same level,
            // uncompressed.
            console.warn(`[VolumeViewer] GPU-compressed atlas unavailable (${err.message}); streaming LOD${lod} uncompressed.`);
            useCompression = false;
            continue;
          }
          const reason = err?.code === 'SVR_OVER_BUDGET' ? 'vram-budget' : 'alloc-failed';
          downgradeReason = downgradeReason || reason;
          if (!firstRefusal) firstRefusal = { lod, bytes: footprint.bytes, reason };
          console.warn(`[VolumeViewer] Texture allocation failed for LOD${lod} (${dims.x}x${dims.y}x${dims.z}, ${_mib(footprint.bytes)} MiB): ${err?.message || err}`);
          emitState({ message: `${quality}: LOD${lod} could not be allocated on the GPU (${_mib(footprint.bytes)} MiB) — trying LOD${lod + 1}...` });
          lod++;
          if (lod >= levelCount) {
            _perf()?.end(perfId, { status: 'unavailable', quality, reason: 'Out of GPU memory' });
            emitState({ message: `${quality}: out of GPU memory at every level` });
            return { available: false, reason: 'Insufficient GPU memory for every level', budgetBytes: budget };
          }
        }
      }
      if (lod === requestedLod) downgradeReason = null;

      const width = dims.x;
      const height = dims.y;
      const depth = dims.z;
      const channels = footprint.channels;
      const streamBricks = BrickLoader.activeBricks(lod);
      const extentUm = computePhysicalScale(metadata, Number(metadata.dimensions?.z) || depth, Number(metadata.dimensions?.x) || width).physicalSizeUm;
      const orderedBricks = _orderBricksForStreaming(streamBricks, dims, extentUm);
      console.log(`[VolumeViewer] Streaming LOD${lod}: ${orderedBricks.length} active bricks (${footprint.mode}, ${_mib(footprint.bytes)} MiB).`);

      let occTex = null;
      let occScale = null;
      if (!streamSvrManager) {
        // Per-brick occupancy of the dense texture: the march jumps over empty bricks.
        const bs = VOLUME_BRICK_SIZE;
        const occNx = Math.max(1, Math.ceil(width / bs));
        const occNy = Math.max(1, Math.ceil(height / bs));
        const occNz = Math.max(1, Math.ceil(depth / bs));
        const occData = new Uint8Array(occNx * occNy * occNz);
        for (const b of orderedBricks) {
          if (b.bx < occNx && b.by < occNy && b.bz < occNz) occData[(b.bz * occNy + b.by) * occNx + b.bx] = 255;
        }
        const TextureClass = THREE.Data3DTexture || THREE.DataTexture3D;
        occTex = new TextureClass(occData, occNx, occNy, occNz);
        occTex.format = THREE.RedFormat;
        occTex.type = THREE.UnsignedByteType;
        occTex.minFilter = THREE.NearestFilter;
        occTex.magFilter = THREE.NearestFilter;
        occTex.unpackAlignment = 1;
        occTex.needsUpdate = true;
        // OCC-Z: the grid spans gridDim·brickSize voxels, which OVER-covers the volume
        // when an axis is not a multiple of brickSize; volumeDim/(brickSize·gridDim)
        // maps a texture coordinate to the grid so a cell is exactly a brick.
        occScale = new THREE.Vector3(width / (bs * occNx), height / (bs * occNy), depth / (bs * occNz));
      }

      const floors = _floorsFromManifest(tpSelection.manifest, channels, tpSelection.histograms);
      const floorLuts = _floorLuts(floors, channels);
      const manifestHistograms = _manifestHistograms(tpSelection.histograms, channels);
      const textures = streamSvrManager ? streamSvrManager.atlases : [texture3D];
      const streamEntry = {
        key: cacheKey,
        textures,
        texture: texture3D || textures[0] || null,
        data: null,
        occupancyMap: occTex,
        occupancyScale: occScale,
        width,
        height,
        depth,
        stride: footprint.scalar ? 1 : RGBA_TEXTURE_BYTES_PER_VOXEL,
        gpuBytes: streamSvrManager ? undefined : footprint.bytes,
        // What the region-of-interest streaming needs to refine this volume with the
        // same transform the stream applied: the floor LUTs, the atlas format.
        floorLuts,
        components: footprint.components,
        treePath,
        treeVersion: treeFormat?.version || 2,
        apron: bordered ? 1 : 0,
        sourceWidth: Number(metadata.dimensions?.x) || width,
        sourceHeight: Number(metadata.dimensions?.y) || height,
        sourceDepth: Number(metadata.dimensions?.z) || depth,
        channels,
        zIndices: _levelSourcePlanes(depth, Number(metadata.dimensions?.z) || depth),
        basePath,
        timepoint,
        quality,
        lod,
        requestedLod,
        downgraded: lod !== requestedLod,
        downgradeReason,
        successfulLoads: 0,
        failedLoads: 0,
        svrManager: streamSvrManager || null,
        // Display voxels in the GPU's BC4 / BC5 blocks (lossy, display only).
        gpuCompressed: Boolean(streamSvrManager?.compressed),
        manifest: tpSelection.manifest,
        histograms: manifestHistograms.length
          ? manifestHistograms
          : (_channelHistograms?.length ? _channelHistograms : _emptyHistograms(channels)),
        histogramsExact: manifestHistograms.length > 0
      };

      const totalBricks = orderedBricks.length;
      emitState({
        target: _qualityTarget,
        active: shownQuality,
        mode: 'bricks',
        progress: 0,
        streaming: true,
        message: isPreview
          ? _t('viewer.qStreamingPreviewBricks', 'Streaming preview (LOD{lod}, {count} bricks) before {quality}...', { lod, count: totalBricks, quality: shownQuality })
          : _t('viewer.qStreamingBricks', 'Streaming {quality} bricks (LOD{lod}, {count} bricks)...', { lod, count: totalBricks, quality })
      });
      _resetThrottledProgress();
      if (onProgress) onProgress(0, quality);
      await _yieldToPaint();

      // The cross-fade this stream fills, if any: only it is cleared by this stream (a
      // stream that superseded this one may already show its own).
      let ownTransition = null;
      const clearOwnTransition = () => {
        if (ownTransition && _transitionMaterial === ownTransition) _clearTransitionVolume();
        ownTransition = null;
      };
      if (deferActivation) {
        if (!_transitionMaterial) _beginTransitionVolume(null, channels);
        _bindTransitionEntry(streamEntry, channels);
        ownTransition = _transitionMaterial;
        // On a TIMEPOINT change the transition cube is what the user watches fill in,
        // brick by brick, on top of the previous frame; during playback it is pure
        // noise. Hidden, the finished frame swaps in atomically at the end. The cube
        // itself must still EXIST: on the SVR path its material is the atlas's.
        if (options.hideTransition && _transitionCube) _transitionCube.visible = false;
      } else if (!preload) {
        _activateVolumeEntry(streamEntry, metadata, streamEntry.sourceDepth, streamEntry.sourceWidth, channels, { ...options, fitCamera: !_hasLoadedVolume });
      }

      // ── Bricks ─────────────────────────────────────────────────────────────────
      // One composed row per brick (every channel interleaved, the background-floor
      // LUT applied, cut to the volume at its edges) from the decode workers, uploaded
      // as it is: no CPU copy of the volume, no per-voxel work on this thread.
      const brickKey = (b) => `${b.bx}_${b.by}_${b.bz}`;
      const missing = new Set();
      const uploadFailed = new Set();
      if (streamSvrManager) streamSvrManager.onUploadError = (keys) => { for (const k of keys) uploadFailed.add(k); };
      const glCtx = renderer?.getContext?.();
      if (!streamSvrManager && glCtx) { for (let i = 0; i < 16 && glCtx.getError() !== glCtx.NO_ERROR; i++) { /* drain: the end check reads this stream's */ } }
      let delivered = 0;
      let firstPictureFired = deferActivation || preload;
      const firstPictureAt = Math.max(1, Math.ceil(totalBricks * FIRST_PICTURE_FRACTION));
      const bs = VOLUME_BRICK_SIZE;
      // A bordered (v3) brick arrives as its stored 66³ (stored voxel s of an axis is
      // volume voxel 64·b − 1 + s). The atlas keeps the border (cropToVolume cuts an edge
      // brick to the voxels in [−1, dim]); a dense texture takes the interior alone, the
      // box [1, 1 + min(64, dim − 64·b)) of each axis, written at 64·b.
      const slotEdge = bordered ? bs + 2 : bs;
      const denseRegion = (brick) => (bordered && !streamSvrManager ? {
        x0: 1, x1: 1 + Math.min(bs, width - brick.bx * bs),
        y0: 1, y1: 1 + Math.min(bs, height - brick.by * bs),
        z0: 1, z1: 1 + Math.min(bs, depth - brick.bz * bs)
      } : undefined);
      const streamTasks = [];
      for (const brick of orderedBricks) {
        const region = denseRegion(brick);
        if (rgbaTransport) streamTasks.push({ bx: brick.bx, by: brick.by, bz: brick.bz, channel: -1, lod });
        else for (let c = 0; c < channels; c++) streamTasks.push({ bx: brick.bx, by: brick.by, bz: brick.bz, channel: c, lod, ...(region ? { region } : {}) });
      }

      let summary = null;
      if (streamTasks.length && BrickLoader.getManifest?.() !== tpSelection.manifest) {
        // Another tree of the dataset was mounted while this stream yielded (the detail
        // streaming re-mounting the frame on screen during a prefetch): mount this one
        // again — a same-dataset mount cancels nothing — before asking its bricks.
        try { await BrickLoader.init(treePath, tpSelection.manifest); } catch (e) { /* checked below */ }
        if (BrickLoader.getManifest?.() !== tpSelection.manifest || stopped()) {
          clearOwnTransition();
          if (streamEntry !== _activeVolumeEntry) _disposeVolumeEntry(streamEntry);
          _perf()?.end(perfId, { status: 'stale', quality });
          return preload ? { available: false, reason: 'busy' } : { stale: true };
        }
      }
      if (streamTasks.length) {
        const result = await BrickLoader.loadBrickTasks(streamTasks, {
          manifest: tpSelection.manifest,
          concurrency: options.concurrency || _brickConcurrencyForQuality(quality),
          group: 'stream',
          streamOnly: true,
          signal: abortSlot.controller?.signal,
          // Stops the batch the moment this stream is superseded, instead of paying
          // for every remaining fetch and decode only to throw the result away.
          shouldAbort: stopped,
          compose: {
            channels, luts: floorLuts, components: footprint.components, cropToVolume: !(bordered && !streamSvrManager),
            // A compressed atlas takes the bricks as blocks, encoded in the decode worker.
            encode: streamSvrManager?.compressed ? 'bc' : null
          },
          onBrickError: ({ bx, by, bz, channel, error } = {}) => {
            // BUG-011 (Rule 1.1): a dropped brick surfaces in the status, not silently.
            if (stopped()) return;
            missing.add(brickKey({ bx, by, bz }));
            console.warn(`[VolumeViewer] brick load failed (${bx},${by},${bz}) ch=${channel}:`, error);
          },
          onBrickLoaded: (row) => {
            if (stopped() || !(row?.data || row?.encoded)) return;
            const r = row.region;
            // No region: a whole brick (a bordered one is its whole stored 66³).
            const bw = r ? r.x1 - r.x0 : (bordered ? slotEdge : Math.min(bs, width - row.bx * bs));
            const bh = r ? r.y1 - r.y0 : (bordered ? slotEdge : Math.min(bs, height - row.by * bs));
            const bd = r ? r.z1 - r.z0 : (bordered ? slotEdge : Math.min(bs, depth - row.bz * bs));
            let ok;
            if (streamSvrManager && row.encoded) {
              ok = streamSvrManager.writeEncodedBrick(row.bx, row.by, row.bz, row.encoded);
            } else if (streamSvrManager) {
              ok = streamSvrManager.writeRgbaBrick(row.bx, row.by, row.bz, row.data, bw, bh, bd);
            } else {
              _updateGPUTextureRegion(texture3D, dims, row.bx * bs, row.by * bs, row.bz * bs, bw, bh, bd, row.data);
              ok = true;
            }
            if (!ok) uploadFailed.add(brickKey(row));
            if (row.failedChannels?.length) missing.add(brickKey(row));
            delivered++;
            streamEntry.successfulLoads = delivered;
            if (!preload) {
              if (!firstPictureFired && delivered >= firstPictureAt) {
                firstPictureFired = true;
                _scheduleFrame();
                firePicture({ quality, lod, preview: isPreview, fromCache: false });
              } else {
                _scheduleStreamRedraw();
              }
            }
          },
          onProgress: (p) => {
            if (stopped()) return;
            const progress = Math.max(0, Math.min(1, p));
            if (_emitThrottledProgress(progress, preload)) onProgress?.(progress, quality);
          }
        }).catch((err) => {
          if (err?.code === 'BRICKS_MOUNT_CHANGED') return { mountChanged: true };
          throw err;
        });
        if (result?.mountChanged) {
          clearOwnTransition();
          if (streamEntry !== _activeVolumeEntry) _disposeVolumeEntry(streamEntry);
          _perf()?.end(perfId, { status: 'stale', quality });
          return preload ? { available: false, reason: 'busy' } : { stale: true };
        }
        summary = result?.summary || null;
      }

      if (stopped()) {
        clearOwnTransition();
        // This entry never reaches the cache: nothing downstream would free it.
        if (streamEntry !== _activeVolumeEntry) _disposeVolumeEntry(streamEntry);
        if (epoch !== _contextEpoch) {
          _perf()?.end(perfId, { status: 'context-lost', quality });
          // Answered as a load that ended, so the page takes its loader down; the
          // volume itself comes back from _recoverFromContextLoss.
          return {
            stale: false, available: true, contextLost: true, quality, width, height, depth, lod, requestedLod,
            downgraded: lod !== requestedLod, downgradeReason, successfulLoads: delivered, failedLoads: totalBricks - delivered,
            missingBricks: totalBricks - delivered, degraded: true, fromCache: false, physicalSizeUm: _physicalSizeUm,
            scaleMode: _scaleMode, streamMode: 'bricks', manifest: tpSelection.manifest
          };
        }
        emitState({ message: `${shownQuality} streaming cancelled` });
        _perf()?.end(perfId, { status: 'stale', quality });
        return { stale: true };
      }

      // Whatever the batch did not deliver whole is missing: failed tasks, and tasks
      // a cancellation from outside this stream left undone (a dataset switch).
      if (summary) {
        for (const f of summary.failed || []) missing.add(brickKey(f));
        if (summary.cancelled) for (const s of summary.skipped || []) missing.add(brickKey(s));
      }
      if (streamSvrManager) {
        for (const k of streamSvrManager.flushUploadErrors()) uploadFailed.add(k);
        streamSvrManager.onUploadError = null;
      }
      let uploadError = false;
      if (!streamSvrManager && glCtx) {
        const err = glCtx.getError();
        uploadError = err !== glCtx.NO_ERROR && err !== glCtx.CONTEXT_LOST_WEBGL;
        if (uploadError) console.warn(`[VolumeViewer] texSubImage3D reported glError=${err} while streaming LOD${lod}: the volume may have holes.`);
      }
      for (const k of uploadFailed) missing.add(k);
      const missingCount = uploadError ? Math.max(missing.size, 1) : missing.size;

      if (streamTasks.length && delivered === 0) {
        clearOwnTransition();
        if (streamEntry === _activeVolumeEntry) {
          // Nothing landed: leave an empty volume on screen rather than a stale one.
          streamEntry.degraded = true;
        } else {
          _disposeVolumeEntry(streamEntry);
        }
        emitState({ active: shownQuality, mode: 'bricks', progress: 0, message: `${quality} bricks unavailable` });
        _perf()?.end(perfId, { status: 'unavailable', quality, reason: 'No brick payload could be loaded' });
        return { available: false, reason: 'No brick payload could be loaded' };
      }

      _scheduleFrame();
      streamEntry.failedLoads = missingCount;
      streamEntry.degraded = missingCount > 0;
      // A degraded LOD must never be filed under the quality that was ASKED for by a
      // background job: revisiting it would report a downgrade nobody asked for.
      if (preload && (lod !== requestedLod || streamEntry.degraded)) {
        _disposeVolumeEntry(streamEntry);
        _perf()?.end(perfId, { status: 'unavailable', reason: lod !== requestedLod ? 'downgraded' : 'incomplete', quality });
        return { available: false, reason: lod !== requestedLod ? 'downgraded' : 'incomplete' };
      }
      _storeVolumeCache(streamEntry.key, streamEntry);
      if (!preload) _activateVolumeEntry(streamEntry, metadata, streamEntry.sourceDepth, streamEntry.sourceWidth, channels, options);
      clearOwnTransition();
      if (!preload && !isPreview) _roiSchedule('volume');
      if (!preload && !firstPictureFired) firePicture({ quality, lod, preview: isPreview, fromCache: false });
      emitState({
        active: shownQuality,
        mode: 'bricks',
        progress: 1,
        message: isPreview
          ? `Preview (LOD${lod}) ready — streaming ${shownQuality}...`
          : (missingCount > 0
            ? `${quality} ready — ${missingCount} of ${totalBricks} bricks missing (shown empty; not cached, reload to retry)`
            : `${quality} bricks ready${streamEntry.gpuCompressed ? ' (GPU-compressed display)' : ''}`)
      });
      onProgress?.(1, quality);
      _perf()?.end(perfId, {
        status: missingCount > 0 ? 'partial' : 'ok',
        fromCache: false,
        quality,
        width,
        height,
        depth,
        successfulLoads: delivered,
        failedLoads: missingCount
      });
      return {
        stale: false,
        available: true,
        quality,
        width,
        height,
        depth,
        // CAP-008: actual LOD rendered vs the LOD the requested quality asked for.
        lod,
        requestedLod,
        downgraded: lod !== requestedLod,
        downgradeReason,
        neededBytes: firstRefusal?.bytes || null,
        budgetBytes: budget,
        successfulLoads: delivered,
        failedLoads: missingCount,
        missingBricks: missingCount,
        degraded: missingCount > 0,
        fromCache: false,
        previewLod,
        physicalSizeUm: _physicalSizeUm,
        scaleMode: _scaleMode,
        streamMode: 'bricks',
        manifest: tpSelection.manifest
      };
    } finally {
      // A prefetch set none of this on the way in, so it restores none of it on the
      // way out — and it must not force a redraw: it has nothing new to show.
      if (!preload) {
        _fgStreamActive = Math.max(0, _fgStreamActive - 1);
        // A superseded stream ends while the one that replaced it still streams.
        _isStreamingBricks = _fgStreamActive > 0;
        _scheduleFrame();
      }
    }
  }

  function _mib(bytes) {
    return Math.round((Number(bytes) || 0) / (1024 * 1024));
  }

  function _cancelStream(slot) {
    if (!slot) return;
    slot.cancelled = true;
    try { slot.controller?.abort(); } catch (e) { /* already aborted */ }
  }

  function _resetThrottledProgress() {
    _progressEmit.value = -1;
    _progressEmit.at = 0;
  }

  /** Progress to the listeners at most every 0.5 % or 100 ms (always at 0 and 1):
   *  a native stream settles tens of thousands of tasks. true when emitted. */
  function _emitThrottledProgress(progress, silent = false) {
    const now = Date.now();
    if (progress < 1 && progress > 0 && Math.abs(progress - _progressEmit.value) < 0.005 && now - _progressEmit.at < 100) return false;
    _progressEmit.value = progress;
    _progressEmit.at = now;
    if (!silent) _emitQualityState({ progress });
    return true;
  }

  /**
   * A dense 3D texture allocated on the GPU with texStorage3D and no upload: bricks are
   * written into it with texSubImage3D (WebGL zero-fills new storage). Its GL texture
   * is deleted by texture.dispose(). Throws when the GPU refuses the allocation.
   */
  function _allocMonolithicTexture(width, height, depth, scalar) {
    const TextureClass = THREE.Data3DTexture || THREE.DataTexture3D;
    const tex = new TextureClass(null, width, height, depth);
    tex.format = scalar ? THREE.RedFormat : THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.unpackAlignment = 1;
    if (!renderer) return tex;
    const gl = renderer.getContext();
    for (let i = 0; i < 16 && gl.getError() !== gl.NO_ERROR; i++) { /* drain stale errors */ }
    const glTex = gl.createTexture();
    renderer.state.bindTexture(gl.TEXTURE_3D, glTex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texStorage3D(gl.TEXTURE_3D, 1, scalar ? gl.R8 : gl.RGBA8, width, height, depth);
    // MONO-3DTEX: ANGLE/D3D11 can reject a large TEXTURE_3D without throwing; a
    // storage-less texture would then be painted with uninitialised GPU memory.
    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      gl.deleteTexture(glTex);
      throw new Error(`3D texture allocation failed (glError=${err}, ${width}x${height}x${depth}, ${_mib(width * height * depth * (scalar ? 1 : 4))} MiB)`);
    }
    const properties = renderer.properties.get(tex);
    properties.__webglTexture = glTex;
    properties.__webglInit = true;
    properties.__version = tex.version;
    tex.addEventListener('dispose', () => {
      try { gl.deleteTexture(glTex); } catch (e) { /* context gone */ }
      renderer?.properties?.remove?.(tex);
    });
    return tex;
  }

  /**
   * GPU footprint of one level of the mounted manifest: its dense texture when every
   * dimension fits a 3D texture and the texture stays under the single-texture
   * ceiling, else the SVR atlas of its non-empty bricks (SVRManager.planAtlas).
   * @returns {{lod, dims:{x,y,z}, channels, activeBricks, mode:'monolithic'|'svr',
   *   scalar:boolean, bytes:number, planned:boolean}|null}
   */
  function _levelFootprint(lod, { max3D = 2048, rgbaTransport = false, budget = _gpuBudgetBytes(), compressed = false } = {}) {
    const dims = typeof BrickLoader !== 'undefined' ? BrickLoader.getDimensions(lod) : null;
    if (!dims) return null;
    const channels = Math.min(4, dims.channels || 1);
    if (compressed && !rgbaTransport && typeof SVRManager !== 'undefined' && typeof SVRManager.pitchFor === 'function') {
      // A compressed display atlas, whatever the level's size (a dense texture cannot
      // hold RGTC in 3D): slots on a pitch of whole blocks, 0.5 byte per voxel and
      // channel, two textures a page (so four pages) beyond two channels.
      const S = SVRManager;
      const stride = Number(dims.brickStride) || VOLUME_BRICK_SIZE;
      const plan = S.planAtlas(Math.max(1, BrickLoader.activeBrickCount(lod)), {
        max3D: S.maxPageDim(renderer, true),
        maxPageBytes: S._maxPageBytes(budget),
        brickSize: S.pitchFor(stride, true),
        texelBytes: S.compressedTexelBytes(channels),
        maxPages: channels > 2 ? S.MAX_PAGES / 2 : S.MAX_PAGES
      });
      const pageTableBytes = Math.ceil(dims.x / VOLUME_BRICK_SIZE) * Math.ceil(dims.y / VOLUME_BRICK_SIZE) * Math.ceil(dims.z / VOLUME_BRICK_SIZE) * 4;
      return {
        lod, dims: { x: dims.x, y: dims.y, z: dims.z }, channels, activeBricks: BrickLoader.activeBrickCount(lod),
        mode: 'svr', compressed: true, scalar: false, components: S.componentsForChannels(channels), stride,
        bytes: plan ? plan.bytes + pageTableBytes : Infinity, planned: Boolean(plan)
      };
    }
    // A single-channel level fills one byte per voxel: an R8 texture, not RGBA8.
    const scalar = channels === 1 && !rgbaTransport;
    const dense = dims.x * dims.y * dims.z * (scalar ? 1 : RGBA_TEXTURE_BYTES_PER_VOXEL);
    const activeBricks = BrickLoader.activeBrickCount(lod);
    const useSVR = dims.x > max3D || dims.y > max3D || dims.z > max3D || dense >= MONOLITHIC_RGBA_LIMIT_BYTES;
    const base = { lod, dims: { x: dims.x, y: dims.y, z: dims.z }, channels, activeBricks };
    if (!useSVR) {
      return { ...base, mode: 'monolithic', scalar, components: scalar ? 1 : RGBA_TEXTURE_BYTES_PER_VOXEL, stride: VOLUME_BRICK_SIZE, bytes: dense, planned: true };
    }
    const S = typeof SVRManager !== 'undefined' ? SVRManager : null;
    // The atlas takes one byte per channel the dataset has (R8, RG8, RGBA8 for 3–4) and
    // slots of the tree's stride (66 with the border); its page table one RGBA8 texel
    // per brick of the grid.
    const components = rgbaTransport || !S?.componentsForChannels ? 4 : S.componentsForChannels(channels);
    const stride = Number(dims.brickStride) || VOLUME_BRICK_SIZE;
    const maxPageBytes = S && typeof S._maxPageBytes === 'function' ? S._maxPageBytes(budget) : 512 * 1024 * 1024;
    const plan = S && typeof S.planAtlas === 'function'
      ? S.planAtlas(Math.max(1, activeBricks), { max3D, components, maxPageBytes, brickSize: stride })
      : null;
    const pageTableBytes = Math.ceil(dims.x / VOLUME_BRICK_SIZE) * Math.ceil(dims.y / VOLUME_BRICK_SIZE) * Math.ceil(dims.z / VOLUME_BRICK_SIZE) * 4;
    return {
      ...base, mode: 'svr', scalar: false, components, stride,
      bytes: plan ? plan.bytes + pageTableBytes : Infinity, planned: Boolean(plan)
    };
  }

  /**
   * The finest level that fits: candidates are tried finest first; one is skipped when
   * its atlas cannot be laid out at all ('capacity'), when it is over `available`
   * bytes ('vram-budget'), or when it needs an SVR atlas for a prefetch that the cache
   * would not keep ('svr-preload': `preloadSvr` false, a native atlas). With
   * `lastResort` (nothing else on screen), when every
   * level is over the budget the coarsest one that can be laid out is returned anyway,
   * flagged `overBudget`: the budget is a heuristic, and an empty viewer is worse than
   * an allocation the GPU may still accept (its refusal is handled by the caller).
   * @returns {{ level: object|null, skipped: Array<{lod, bytes, reason}> }}
   */
  function _chooseStreamLevel(candidates, { available, preload = false, preloadSvr = false, lastResort = false } = {}) {
    const skipped = [];
    let coarsestPlanned = null;
    for (const c of candidates || []) {
      if (!c) continue;
      if (c.mode === 'svr' && preload && !preloadSvr) { skipped.push({ lod: c.lod, bytes: c.bytes, reason: 'svr-preload' }); continue; }
      if (!c.planned) { skipped.push({ lod: c.lod, bytes: c.bytes, reason: 'capacity' }); continue; }
      coarsestPlanned = c;
      if (!(c.bytes <= available)) { skipped.push({ lod: c.lod, bytes: c.bytes, reason: 'vram-budget' }); continue; }
      return { level: c, skipped };
    }
    if (lastResort && !preload && coarsestPlanned) return { level: { ...coarsestPlanned, overBudget: true }, skipped };
    return { level: null, skipped };
  }

  /** VRAM no eviction can free: everything resident but the cached volumes that are
   *  neither on screen nor cross-fading. */
  function _pinnedGpuBytes() {
    let evictable = 0;
    for (const e of _volumeCache.values()) {
      if (e === _activeVolumeEntry || e === _transitionEntry || e.disposed) continue;
      evictable += _entryGpuBytes(e);
    }
    return Math.max(0, _residentGpuBytes() - evictable);
  }

  /**
   * What each quality would cost on the GPU for the dataset mounted now (the
   * BrickLoader manifest): per level and per quality key, the mode (dense texture or
   * sparse atlas), the bytes, and whether it fits this page's VRAM budget. For a host
   * that shares one GPU between several viewers (Compare). null before a manifest is
   * mounted.
   * @param {string[]} [qualities]
   * @returns {{ budgetBytes:number, levels:object[], qualities:Object<string,object> }|null}
   */
  function getQualityFootprints(qualities = ['256x256', '512x512', '1024x1024', 'native']) {
    if (typeof BrickLoader === 'undefined' || !BrickLoader.isReady?.()) return null;
    const manifest = BrickLoader.getManifest?.();
    const levels = manifest?.levels;
    const levelCount = levels ? (Array.isArray(levels) ? levels.length : Object.keys(levels).length) : 1;
    const v3 = _isV3Manifest(manifest);
    const max3D = renderer?.capabilities?.max3DTextureSize || 2048;
    const budget = _gpuBudgetBytes();
    const rgbaTransport = BrickLoader.getTransportEncoding?.() === 'raw-rgba-gzip';
    const out = { budgetBytes: budget, levels: [], qualities: {} };
    const compressed = !rgbaTransport && _gpuCompressionWanted(_lastDisplayRequest?.metadata || null);
    for (let lod = 0; lod < levelCount; lod++) {
      const fp = _levelFootprint(lod, { max3D, rgbaTransport, budget, compressed });
      if (fp) out.levels.push({ ...fp, fits: fp.planned && fp.bytes <= budget });
    }
    for (const q of qualities) {
      const lod = _lodForQuality(_normalizeQualityKey(q), levelCount, levels, v3);
      const fp = out.levels.find(l => l.lod === lod);
      if (fp) out.qualities[q] = fp;
    }
    return out;
  }

  /**
   * The level each quality of the select shows, with its real dimensions, so the page
   * can label "512" as what it is (e.g. "632 × 410 × 96"). `manifest` defaults to the
   * one BrickLoader has mounted; a live dataset's manifest is read at its top level
   * (v3: the levels every timepoint shares).
   * @returns {Array<{ key, value (= key, the select's option value), level, dims: {x,y,z}, voxelSize: {x,y,z}|null }>|null}
   */
  function getQualityLevels(keys = ['256x256', '512x512', '1024x1024', 'native'], manifest = null) {
    const m = manifest || (typeof BrickLoader !== 'undefined' ? BrickLoader.getManifest?.() : null);
    const levels = Array.isArray(m?.levels) ? m.levels : null;
    if (!levels || !levels.length) return null;
    const v3 = _isV3Manifest(m);
    return keys.map((key) => {
      const level = _lodForQuality(_normalizeQualityKey(key), levels.length, levels, v3);
      const lv = levels[level] || {};
      const d = lv.dimensions || {};
      const vs = lv.voxelSize || null;
      return {
        key,
        value: key,
        level,
        dims: { x: Number(d.x) || 0, y: Number(d.y) || 0, z: Number(d.z) || 0 },
        voxelSize: vs ? { x: Number(vs.x), y: Number(vs.y), z: Number(vs.z) } : null
      };
    });
  }

  /** The level on screen: { level, quality, dims, treeVersion, apron, components, mode }, or null. */
  function getActiveLevel() {
    const e = _activeVolumeEntry;
    if (!e || !Number.isInteger(e.lod)) return null;
    return {
      level: e.lod,
      quality: e.quality,
      dims: { x: e.width, y: e.height, z: e.depth },
      treeVersion: e.treeVersion || 2,
      apron: e.apron || 0,
      components: e.svrManager ? e.svrManager.components : (e.stride === 1 ? 1 : RGBA_TEXTURE_BYTES_PER_VOXEL),
      mode: e.svrManager ? 'svr' : 'monolithic',
      compressed: Boolean(e.gpuCompressed),
      detailLevel: _roi && _roi.entry === e ? _roi.level : null
    };
  }

  function _isV3Manifest(manifest) {
    return Boolean(manifest) && (manifest.schema === 'iribhm-bricks-v3' || manifest.version === 3);
  }

  /**
   * Source plane of each z of a level: the identity when the level keeps every plane;
   * a level halved in Z (v3, SPEC §13.1) maps its z to the source plane at its centre,
   * min(D − 1, floor((z + ½)·D/d)).
   */
  function _levelSourcePlanes(depth, sourceDepth) {
    const d = Math.max(1, Math.floor(Number(depth) || 1));
    const D = Math.max(1, Math.floor(Number(sourceDepth) || d));
    if (D === d) return Array.from({ length: d }, (_, z) => z);
    return Array.from({ length: d }, (_, z) => Math.min(D - 1, Math.floor((z + 0.5) * D / d)));
  }

  // ── GPU-compressed display atlas ───────────────────────────────────────────────
  // (GPU_COMPRESSION_MODES and _gpuCompressionSession are declared with the module's
  // state, above the IIFE's return.)

  function _gpuCompressionMode() {
    if (_gpuCompressionSession) return _gpuCompressionSession;
    try {
      const v = typeof localStorage !== 'undefined' ? localStorage.getItem('lumen3d.gpuCompression') : null;
      if (GPU_COMPRESSION_MODES.includes(v)) return v;
    } catch (e) { /* storage blocked */ }
    return 'auto';
  }

  function _isTimelapse(metadata) {
    return metadata?.type === 'live' || Number(metadata?.dimensions?.t) > 1;
  }

  /** Should a volume of `metadata` stream into a compressed atlas on this renderer? */
  function _gpuCompressionWanted(metadata) {
    const mode = _gpuCompressionMode();
    if (mode === 'off' || (mode === 'auto' && !_isTimelapse(metadata))) return false;
    if (!renderer || typeof SVRManager === 'undefined' || typeof SVRManager.compressionSupport !== 'function') return false;
    return SVRManager.compressionSupport(renderer).bc;
  }

  /**
   * { mode, supported, reason, wanted (for the volume of the last display load),
   *   active (the volume on screen is compressed) }.
   */
  function getGpuCompression() {
    const support = renderer && typeof SVRManager !== 'undefined' && SVRManager.compressionSupport
      ? SVRManager.compressionSupport(renderer)
      : { bc: false, reason: 'no-renderer' };
    return {
      mode: _gpuCompressionMode(),
      supported: Boolean(support.bc),
      reason: support.bc ? null : support.reason,
      wanted: _gpuCompressionWanted(_lastDisplayRequest?.metadata || null),
      active: Boolean(_activeVolumeEntry?.gpuCompressed)
    };
  }

  /**
   * Set the mode ('auto' | 'on' | 'off'). Cached volumes in the other form are dropped
   * (the next frames load in the new one); the volume on screen is the caller's to
   * reload. → getGpuCompression().
   */
  function setGpuCompression(mode) {
    const m = mode === true ? 'on' : mode === false ? 'off' : String(mode || 'auto');
    if (!GPU_COMPRESSION_MODES.includes(m)) return getGpuCompression();
    _gpuCompressionSession = m;
    try { if (typeof localStorage !== 'undefined') localStorage.setItem('lumen3d.gpuCompression', m); } catch (e) { /* storage blocked */ }
    const want = _gpuCompressionWanted(_lastDisplayRequest?.metadata || null);
    for (const [key, entry] of [..._volumeCache]) {
      if (!entry || Boolean(entry.gpuCompressed) === want) continue;
      _volumeCache.delete(key);
      // The volume on screen (or fading in) stays until its replacement lands; out of
      // the cache, a reload streams it again instead of finding it there.
      if (entry !== _activeVolumeEntry && entry !== _transitionEntry) _disposeVolumeEntry(entry);
    }
    return getGpuCompression();
  }

  // ── Region of interest: finer bricks where the view needs them ───────────────
  // The quality's level stays resident everywhere. When the user zooms past its
  // resolution (one of its voxels over SVRRoi.DETAIL_PIXELS_PER_VOXEL screen pixels),
  // the bricks of a finer level that are in view (frustum ∩ volume ∩ clip box) are
  // streamed into a second atlas (SVRManager role 'detail', its own page table), most
  // important first (big on screen, near the view centre), within what is left of the
  // VRAM budget; bricks that left the view are recycled least recently used first.
  // The shader samples the finest resident level at each position (fetchVoxel). Each
  // round is debounced after the camera settles, cancels the previous round's loads
  // (loader group 'roi'), and never runs while a volume streams. 'auto' turns itself
  // on only with a VRAM budget of at least ROI_AUTO_MIN_BUDGET; 'on' whatever it is.

  /** 'auto' (default), 'on' or 'off'. 'off' drops the detail bricks at once. */
  function setDetailMode(mode) {
    const m = mode === true ? 'on' : mode === false ? 'off' : String(mode || 'auto');
    if (!['auto', 'on', 'off'].includes(m)) return _roiMode;
    _roiMode = m;
    if (m === 'off') _roiTeardown('off');
    _setRoiStatus({ mode: m });
    _roiSchedule('mode');
    return _roiMode;
  }

  /**
   * { mode, active, level, baseLevel, inView, resident, loading, loaded, capacity,
   *   pixelsPerVoxel, reason, message } — reason: 'idle' | 'off' | 'zoomed-out' |
   * 'finest' | 'budget' | 'budget-low' | 'alloc-failed' | 'streaming' | 'unsupported'
   * | 'loading' | 'ready' | … ; message is the line to show (translated).
   */
  function getDetailStatus() {
    return { ..._roiStatus };
  }

  function onDetailStatus(callback) {
    if (typeof callback !== 'function') return () => {};
    _roiListeners.add(callback);
    callback(getDetailStatus());
    return () => _roiListeners.delete(callback);
  }

  function _setRoiStatus(patch) {
    const next = { ..._roiStatus, ...patch, mode: _roiMode };
    next.message = _roiMessage(next);
    const changed = Object.keys(next).some(k => next[k] !== _roiStatus[k]);
    _roiStatus = next;
    if (changed) _roiListeners.forEach((cb) => { try { cb({ ...next }); } catch (e) { console.warn('[VolumeViewer] detail status listener failed:', e); } });
  }

  function _roiMessage(s) {
    if (s.reason === 'loading') {
      return _t('viewer.detailLoading', 'Detail: loading {loaded} of {total} bricks of level {level}', { loaded: s.loaded, total: s.loading, level: s.level });
    }
    if (s.active && s.level !== null) {
      return _t('viewer.detailStatus', 'Detail: {count} bricks of level {level} in view', { count: s.resident, level: s.level });
    }
    if (s.reason === 'budget' || s.reason === 'alloc-failed') {
      return _t('viewer.detailNoBudget', 'Detail unavailable: not enough GPU memory left');
    }
    return '';
  }

  function _roiSchedule(reason = 'camera') {
    if (_roiMode === 'off' && !_roi) return;
    if (!renderer) return;
    if (_roiTimer) clearTimeout(_roiTimer);
    _roiTimer = setTimeout(() => {
      _roiTimer = null;
      _roiUpdate().catch((err) => console.warn('[VolumeViewer] detail streaming failed:', err));
    }, ROI_DEBOUNCE_MS);
  }

  function _roiTeardown(reason) {
    const roi = _roi;
    _roi = null;
    if (roi) {
      roi.seq = -1;
      try { roi.controller?.abort(); } catch (e) { /* already aborted */ }
      if (typeof BrickLoader !== 'undefined') BrickLoader.cancelGroup?.('roi');
      roi.mgr?.dispose?.();
    }
    if (material && typeof SVRManager !== 'undefined' && SVRManager.unpublishDetail) SVRManager.unpublishDetail(material);
    if (roi) _scheduleFrame();
    if (roi || _roiStatus.active) _setRoiStatus({ active: false, level: null, inView: 0, resident: 0, loading: 0, loaded: 0, capacity: 0, reason });
  }

  /** What the scheduler needs from the view: the focal length in device pixels, the
   *  distance to the volume along the view's centre, and the cube's world scale. */
  function _roiViewGeometry() {
    cube.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    const worldScale = new THREE.Vector3();
    cube.getWorldScale(worldScale);
    const size = renderer.getSize(new THREE.Vector2());
    const focalPx = SVRRoi.focalPx(size.y * _idlePixelRatio(), camera.fov);
    const camPos = new THREE.Vector3();
    camera.getWorldPosition(camPos);
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const inv = cube.matrixWorld.clone().invert();
    const oLocal = camPos.clone().applyMatrix4(inv);
    const aheadLocal = camPos.clone().add(forward).applyMatrix4(inv);
    const box = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
    let distance;
    if (box.containsPoint(oLocal)) {
      distance = camera.near;
    } else {
      const ray = new THREE.Ray(oLocal, aheadLocal.sub(oLocal).normalize());
      const hit = ray.intersectBox(box, new THREE.Vector3()) || box.clampPoint(oLocal, new THREE.Vector3());
      distance = camPos.distanceTo(hit.applyMatrix4(cube.matrixWorld));
    }
    return { focalPx, distance: Math.max(camera.near, distance), worldScale: { x: worldScale.x, y: worldScale.y, z: worldScale.z } };
  }

  /** Texture space (uvw) → world: the cube's world matrix after the inverse of the
   *  object → texture map (p + ½, or the stabilisation warp of a timelapse). */
  function _roiTextureToWorld() {
    const objToTex = _warpActive && material?.uniforms?.volumeWarp?.value
      ? material.uniforms.volumeWarp.value.clone()
      : new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5);
    return cube.matrixWorld.clone().multiply(objToTex.invert());
  }

  /** The camera frustum as planes of texture space ([nx, ny, nz, d], inside ≥ 0). */
  function _roiFrustumPlanes(texToWorld) {
    const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(vp);
    const worldToTex = texToWorld.clone().invert();
    return frustum.planes.map((p) => {
      const q = p.clone().applyMatrix4(worldToTex);
      return [q.normal.x, q.normal.y, q.normal.z, q.constant];
    });
  }

  /** uvw → { x, y } NDC and the view depth. */
  function _roiProjector(texToWorld) {
    const m = new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, texToWorld).elements;
    const pm = camera.projectionMatrix.elements;
    return (u, v, w) => {
      const vx = m[0] * u + m[4] * v + m[8] * w + m[12];
      const vy = m[1] * u + m[5] * v + m[9] * w + m[13];
      const vz = m[2] * u + m[6] * v + m[10] * w + m[14];
      const cx = pm[0] * vx + pm[4] * vy + pm[8] * vz + pm[12];
      const cy = pm[1] * vx + pm[5] * vy + pm[9] * vz + pm[13];
      const cw = pm[3] * vx + pm[7] * vy + pm[11] * vz + pm[15];
      const depth = -vz;
      if (!(cw > 1e-9)) return { x: 1e3, y: 1e3, depth: Math.max(camera.near, depth) };
      return { x: cx / cw, y: cy / cw, depth };
    };
  }

  /** A detail atlas for level k sized to what the budget leaves, or null (status says why). */
  function _roiCreate(entry, k, budget) {
    const dims = BrickLoader.getDimensions(k);
    if (!dims) return null;
    const channels = Math.max(1, Math.min(4, entry.channels || dims.channels || 1));
    const components = SVRManager.componentsForChannels(channels);
    const stride = Number(dims.brickStride) || VOLUME_BRICK_SIZE;
    const free = Math.max(0, budget - _residentGpuBytes());
    const bytes = Math.min(ROI_MAX_BYTES, Math.floor(free * ROI_BUDGET_SHARE));
    const max3D = renderer?.capabilities?.max3DTextureSize || 2048;
    const plan = SVRManager.planAtlasWithin(bytes, {
      max3D, components, brickSize: stride, maxPages: SVRManager.DETAIL_MAX_PAGES, maxPageBytes: SVRManager._maxPageBytes(budget)
    });
    if (!plan || plan.slots < ROI_MIN_SLOTS) {
      _setRoiStatus({ active: false, level: k, baseLevel: entry.lod, capacity: plan ? plan.slots : 0, reason: 'budget' });
      return null;
    }
    const mgr = new SVRManager();
    try {
      mgr.init(channels, dims, renderer, material, {
        role: 'detail', components, targetSlots: plan.slots, budgetBytes: plan.bytes, countLiveAtlases: false
      });
    } catch (err) {
      mgr.dispose();
      SVRManager.unpublishDetail(material);
      console.warn(`[VolumeViewer] Detail atlas for level ${k} refused: ${err?.message || err}`);
      _setRoiStatus({ active: false, level: k, baseLevel: entry.lod, capacity: 0, reason: 'alloc-failed' });
      return null;
    }
    return { entry, level: k, mgr, channels, dims, bricks: null, inFlight: new Set(), controller: null, seq: 0, loaded: 0 };
  }

  /**
   * One round: choose the level the view needs, rank its bricks in view, keep what is
   * resident and wanted, load what is missing (one loader batch, group 'roi').
   */
  async function _roiUpdate() {
    if (!renderer || !camera || !cube || !material || _contextLost) return;
    if (_roiMode === 'off') { _roiTeardown('off'); return; }
    const entry = _activeVolumeEntry;
    const ready = entry && !entry.disposed && Number.isInteger(entry.lod) && entry.manifest && entry.treePath
      && typeof BrickLoader !== 'undefined' && typeof SVRManager !== 'undefined' && typeof SVRRoi !== 'undefined';
    if (!ready) { _roiTeardown('no-volume'); return; }
    if (_fgStreamActive > 0 || _transitionEntry) { _setRoiStatus({ reason: 'streaming' }); return; }   // re-run when the stream ends
    if (entry.lod === 0) { _roiTeardown('finest'); _setRoiStatus({ baseLevel: 0, reason: 'finest' }); return; }
    // v2 trees keep the 1.58 behaviour: their levels are not an isotropic pyramid and
    // their packs are not grouped by region, so a few detail bricks would pull whole
    // multi-MiB packs. Detail streaming is a v3 (bordered pyramid) feature.
    if ((entry.treeVersion || 2) < 3 || BrickLoader.getTransportEncoding?.() === 'raw-rgba-gzip') { _roiTeardown('unsupported'); _setRoiStatus({ reason: 'unsupported' }); return; }
    // A denoised channel is filtered in the dense texture only: raw detail bricks over it
    // would show another picture.
    if (_channelSigma.some(sigma => sigma > 0.05)) { _roiTeardown('denoise'); _setRoiStatus({ reason: 'denoise' }); return; }
    if (BrickLoader.getManifest?.() !== entry.manifest) {
      // Another tree of the same dataset is mounted (a cached timepoint was shown):
      // mount this one; nothing running is cancelled by it.
      try { await BrickLoader.init(entry.treePath, entry.manifest); } catch (e) { _roiTeardown('mount'); return; }
      if (_activeVolumeEntry !== entry || _fgStreamActive > 0) return;
    }
    const levels = (BrickLoader.getFormat?.()?.levels || []).filter(l => l && l.dims);
    const view = _roiViewGeometry();
    const choice = SVRRoi.chooseDetailLevel({
      levels: levels.map(l => ({ level: l.level, voxelWorld: Math.min(view.worldScale.x / l.dims.x, view.worldScale.y / l.dims.y) })),
      baseLevel: entry.lod, focalPx: view.focalPx, distance: view.distance
    });
    if (choice.level === null) {
      _roiTeardown('zoomed-out');
      _setRoiStatus({ baseLevel: entry.lod, pixelsPerVoxel: choice.basePixelsPerVoxel, reason: 'zoomed-out' });
      return;
    }
    const budget = _gpuBudgetBytes();
    if (_roiMode === 'auto' && budget < ROI_AUTO_MIN_BUDGET) {
      _roiTeardown('budget-low');
      _setRoiStatus({ baseLevel: entry.lod, pixelsPerVoxel: choice.basePixelsPerVoxel, reason: 'budget-low' });
      return;
    }
    let roi = _roi;
    if (roi && (roi.level !== choice.level || roi.entry !== entry)) { _roiTeardown('level'); roi = null; }
    if (!roi) {
      roi = _roiCreate(entry, choice.level, budget);
      if (!roi) return;
      _roi = roi;
    }
    const seq = ++_roiSeq;
    roi.seq = seq;
    const texToWorld = _roiTextureToWorld();
    if (!roi.bricks) roi.bricks = BrickLoader.activeBricks(roi.level);
    const clip = _warpActive
      ? { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }
      : { min: { x: clipPlanes.xMin, y: clipPlanes.yMin, z: clipPlanes.zMin }, max: { x: clipPlanes.xMax, y: clipPlanes.yMax, z: clipPlanes.zMax } };
    const ranked = SVRRoi.rankVisible({
      bricks: roi.bricks, dims: roi.dims, planes: _roiFrustumPlanes(texToWorld),
      clipMin: clip.min, clipMax: clip.max, worldScale: view.worldScale,
      project: _roiProjector(texToWorld), near: camera.near, brickSize: VOLUME_BRICK_SIZE
    });
    const keyXYZ = (key) => key.split('_').map(Number);
    const plan = SVRRoi.plan({
      ranked,
      isResident: (key) => { const [x, y, z] = keyXYZ(key); return roi.mgr.has(x, y, z); },
      inFlight: roi.inFlight,
      capacity: roi.mgr.maxSlots,
      residentKeys: roi.mgr.residentKeys()
    });
    for (const key of plan.keep) { const [x, y, z] = keyXYZ(key); roi.mgr.touch(x, y, z); }
    roi.wanted = new Set(plan.want);
    const residentInView = () => { let n = 0; for (const key of roi.wanted) { const [x, y, z] = keyXYZ(key); if (roi.mgr.has(x, y, z)) n++; } return n; };
    const status = (extra = {}) => _setRoiStatus({
      active: true, level: roi.level, baseLevel: entry.lod, inView: plan.inView, resident: residentInView(),
      capacity: roi.mgr.maxSlots, pixelsPerVoxel: choice.basePixelsPerVoxel, ...extra
    });
    _scheduleFrame();
    // The running batch goes on when it fetches exactly bricks still wanted and nothing
    // else is missing; otherwise it is replaced by one fetching every wanted brick not
    // resident (what it had in flight included).
    const wantSet = roi.wanted;
    const stale = [...roi.inFlight].some(k => !wantSet.has(k));
    if (!plan.load.length && !stale) {
      if (!roi.inFlight.size) status({ loading: 0, loaded: 0, reason: 'ready' });
      return;
    }
    const missing = ranked.slice(0, roi.mgr.maxSlots).filter(r => !roi.mgr.has(...keyXYZ(r.key)));
    if (!missing.length) {
      try { roi.controller?.abort(); } catch (e) { /* already aborted */ }
      roi.inFlight = new Set();
      status({ loading: 0, loaded: 0, reason: 'ready' });
      return;
    }
    try { roi.controller?.abort(); } catch (e) { /* already aborted */ }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    roi.controller = controller;
    roi.batchSeq = seq;
    roi.inFlight = new Set(missing.map(b => b.key));
    let loaded = 0;
    status({ loading: missing.length, loaded: 0, reason: 'loading' });
    const stopped = () => roi !== _roi || roi.batchSeq !== seq || _contextLost;
    const tasks = [];
    for (const b of missing) for (let c = 0; c < roi.channels; c++) tasks.push({ bx: b.bx, by: b.by, bz: b.bz, channel: c, lod: roi.level });
    const bs = VOLUME_BRICK_SIZE;
    const stride = roi.mgr.slotStride;
    let lastStatusAt = 0;
    const outcome = await BrickLoader.loadBrickTasks(tasks, {
      manifest: entry.manifest,
      group: 'roi',
      streamOnly: true,
      concurrency: ROI_CONCURRENCY,
      signal: controller?.signal,
      shouldAbort: stopped,
      compose: { channels: roi.channels, luts: entry.floorLuts || [], components: roi.mgr.components, cropToVolume: true },
      onBrickLoaded: (row) => {
        if (roi !== _roi || !row?.data) return;
        const r = row.region;
        const bw = r ? r.x1 - r.x0 : (stride > bs ? stride : Math.min(bs, roi.dims.x - row.bx * bs));
        const bh = r ? r.y1 - r.y0 : (stride > bs ? stride : Math.min(bs, roi.dims.y - row.by * bs));
        const bd = r ? r.z1 - r.z0 : (stride > bs ? stride : Math.min(bs, roi.dims.z - row.bz * bs));
        const key = `${row.bx}_${row.by}_${row.bz}`;
        roi.inFlight.delete(key);
        if (roi.mgr.writeRgbaBrick(row.bx, row.by, row.bz, row.data, bw, bh, bd)) loaded++;
        _scheduleStreamRedraw();
        const now = Date.now();
        if (roi.batchSeq === seq && now - lastStatusAt > 200) { lastStatusAt = now; status({ loading: missing.length, loaded, reason: 'loading' }); }
      },
      onBrickError: ({ bx, by, bz } = {}) => { roi.inFlight.delete(`${bx}_${by}_${bz}`); }
    }).catch((err) => {
      // Another tree got mounted while this round waited (a timepoint prefetch's index):
      // these coordinates are not its bricks. The next round mounts the frame again.
      if (err?.code === 'BRICKS_MOUNT_CHANGED') return { mountChanged: true };
      throw err;
    });
    if (outcome?.mountChanged) {
      if (roi === _roi && roi.batchSeq === seq) { roi.inFlight = new Set(); _roiSchedule('mount'); }
      return;
    }
    if (roi !== _roi) return;
    roi.mgr.flushUploadErrors();
    if (roi.batchSeq !== seq) return;
    roi.inFlight = new Set();
    _scheduleFrame();
    status({ loading: 0, loaded, reason: 'ready' });
  }

  // ── WebGL context loss ──────────────────────────────────────────────────────
  /** The context is gone: so are every texture and atlas. Free them now (GL calls are
   *  no-ops while the context is lost), stop the streams writing into them, and halve
   *  the GPU budget (SVRManager.noteContextLost) so the reload asks for less. */
  function _onWebglContextLost() {
    _contextEpoch++;
    _contextLossTimes.push(Date.now());
    if (_contextLossTimes.length > CONTEXT_LOSS_LOOP.count) _contextLossTimes.shift();
    // A loss may be the GPU watchdog cutting a long frame: settled frames ask for less.
    _settledBudgetScale = Math.max(0.05, _settledBudgetScale * 0.5);
    if (typeof SVRManager !== 'undefined' && typeof SVRManager.noteContextLost === 'function') SVRManager.noteContextLost();
    _cancelStream(_brickStreamAbort);
    _cancelStream(_preloadStreamAbort);
    _releaseAllVolumes();
    _disposePickResources();
    _gpuTimer.pending = [];
    _gpuTimer.ext = undefined;
  }

  /** Unbind every volume texture from the material (nothing is sampled from them). */
  function _unbindVolumeUniforms() {
    if (!material?.uniforms) return;
    for (let i = 0; i < 8; i++) material.uniforms[`svrAtlas${i}`].value = null;
    material.uniforms.pageTable.value = null;
    material.uniforms.mapOccupancy.value = null;
    material.uniforms.svrPageCount.value = 0;
    SVRManager.clearAtlasDefines(material);
  }

  /**
   * Take the volume on screen down before a stream that replaces it at once (not a
   * deferred swap): a cached one stays in the cache (evictable), any other is freed
   * now, so the new texture is allocated against the budget without it.
   */
  function _detachActiveVolume() {
    const prev = _activeVolumeEntry;
    if (!prev) return;
    _roiTeardown('volume-changed');
    _activeVolumeEntry = null;
    _activeTextureKey = null;
    _svrManager = null;
    _unbindVolumeUniforms();
    if (!_isEntryCached(prev)) _disposeVolumeEntry(prev);
    _scheduleFrame();
  }

  /** Free every volume (cache, screen, cross-fade) and unbind them from the material. */
  function _releaseAllVolumes() {
    _roiTeardown('released');
    const crossFading = _transitionEntry;
    _clearTransitionVolume();
    if (crossFading) _disposeVolumeEntry(crossFading, { force: true });
    for (const entry of [..._volumeCache.values()]) _disposeVolumeEntry(entry, { force: true });
    _volumeCache.clear();
    if (_activeVolumeEntry) _disposeVolumeEntry(_activeVolumeEntry, { force: true });
    _svrManager?.dispose?.();
    _svrManager = null;
    _activeVolumeEntry = null;
    _activeTextureKey = null;
    _unbindVolumeUniforms();
  }

  /**
   * The context is back (three.js re-creates its own state): the last display load is
   * replayed at the budget the loss lowered, so the view comes back at a level the GPU
   * can hold instead of failing on the same allocation. Returns its promise (null when
   * there was nothing on screen).
   */
  function _recoverFromContextLoss() {
    const gl = renderer?.getContext?.();
    if (gl) { for (let i = 0; i < 16 && gl.getError() !== gl.NO_ERROR; i++) { /* drain */ } }
    _gpuTimer.ext = undefined;
    const req = _lastDisplayRequest;
    if (!req) return null;
    const now = Date.now();
    if (_contextLossTimes.length >= CONTEXT_LOSS_LOOP.count && now - _contextLossTimes[0] < CONTEXT_LOSS_LOOP.windowMs) {
      _emitQualityState({ message: `The GPU reset ${_contextLossTimes.length} times in a row: the volume is not reloaded automatically. Choose a lower quality or reload the page.`, progress: 0 });
      return null;
    }
    _emitQualityState({ message: `GPU context restored — reloading ${req.options?.quality || 'the volume'} at a lower GPU budget...`, progress: 0 });
    const options = { ...(req.options || {}), ignoreVolumeCache: true, deferActivation: false, coarseFirst: false, _replay: true };
    const run = req.kind === 'slices'
      ? loadVolume(req.basePath, req.metadata, req.timepoint, req.onProgress, options)
      : loadBrickedVolumeStream(req.basePath, req.metadata, req.timepoint, req.onProgress, options);
    return run.then((result) => {
      if (result?.available === false) {
        _emitQualityState({ message: `GPU context restored, but the volume could not be reloaded (${result.reason || 'unavailable'})` });
      } else if (result && !result.stale && (typeof options.onFirstPicture === 'function')) {
        try { options.onFirstPicture({ quality: result.quality, lod: result.lod, preview: false, fromCache: false, recovered: true }); } catch (e) { /* page hook */ }
      }
      return result;
    }, (err) => {
      _emitQualityState({ message: `GPU context restored, but the volume could not be reloaded: ${err?.message || err}` });
      throw err;
    });
  }

  /**
   * Free what a dataset switch leaves behind: every cached volume not of `keepBasePath`
   * (all of them when it is null; the one on screen stays), the brick manifests of
   * other datasets, pending slice prefetches, the loader's idle packs, and the blur
   * workers when no blur runs.
   */
  function releaseDataset(keepBasePath = null) {
    for (const [key, entry] of [..._volumeCache]) {
      if (entry === _activeVolumeEntry || entry === _transitionEntry) continue;
      if (keepBasePath && entry.basePath === keepBasePath) continue;
      _volumeCache.delete(key);
      _disposeVolumeEntry(entry);
    }
    for (const dir of [..._manifestCache.keys()]) {
      if (!keepBasePath || !dir.startsWith(`${keepBasePath}/`)) _manifestCache.delete(dir);
    }
    _imageCache.clear();
    if (typeof BrickLoader !== 'undefined') BrickLoader.trimCaches?.();
    if (_blurWorkerPool && _blurActiveCount === 0 && _blurAssemblers.size === 0) {
      _blurWorkerPool.forEach(w => w.terminate());
      _blurWorkerPool = null;
    }
  }

  /**
   * Tear the viewer down: streams cancelled, every volume, atlas, overlay mesh,
   * material and render target released, the blur workers terminated, the listeners
   * and the resize observer removed, the render loop stopped and the renderer
   * disposed. init() may be called again afterwards.
   */
  function dispose() {
    _cancelStream(_brickStreamAbort);
    _cancelStream(_preloadStreamAbort);
    if (_roiTimer) { clearTimeout(_roiTimer); _roiTimer = null; }
    _loadCounter++;
    if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
    if (_interactionTimeout) { clearTimeout(_interactionTimeout); _interactionTimeout = null; }
    if (_streamRedrawTimer) { clearTimeout(_streamRedrawTimer); _streamRedrawTimer = null; }
    _releaseAllVolumes();
    _disposePickResources();
    _manifestCache.clear();
    _imageCache.clear();
    for (const taskId of [..._blurAssemblers.keys()]) _failBlurTask(taskId, 'viewer disposed');
    _blurWorkerPool?.forEach(w => w.terminate());
    _blurWorkerPool = null;
    _blurActiveCount = 0;
    _hideBlurToast();
    if (typeof TrackingOverlay !== 'undefined') TrackingOverlay.dispose?.();
    if (typeof VolumeGrid !== 'undefined') VolumeGrid.dispose?.();
    const disposeTree = (root) => root?.traverse?.((obj) => {
      obj.geometry?.dispose?.();
      const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
      mats.forEach((m) => { m.map?.dispose?.(); m.dispose?.(); });
    });
    for (const sprite of _measurementSprites) { sprite.material?.map?.dispose?.(); sprite.material?.dispose?.(); }
    _measurementSprites = [];
    disposeTree(_measurementGroup);
    disposeTree(_cutPlaneMesh);
    disposeTree(_rotGizmo);
    if (cube) {
      cube.geometry?.dispose?.();
      scene?.remove(cube);
    }
    material?.dispose?.();
    _resizeObserver?.disconnect();
    _resizeObserver = null;
    _observedParent = null;
    _listenerAbort?.abort();
    _listenerAbort = null;
    _activePointers.clear();
    _gpuTimer.pending = [];
    _gpuTimer.ext = undefined;
    renderer?.dispose?.();
    renderer = null;
    scene = null;
    camera = null;
    cube = null;
    material = null;
    _measurementGroup = null;
    _labelsGroup = null;
    _cutPlaneMesh = null;
    _planeBorderMesh = null;
    _cutSlabFaceA = null;
    _cutSlabFaceB = null;
    _rotGizmo = null;
    _hasLoadedVolume = false;
    _isStreamingBricks = false;
    _fgStreamActive = 0;
    _lastDisplayRequest = null;
    _contextLost = false;
    _contextLossTimes.length = 0;
  }

  function _lodForQuality(quality, levelCount, levels = null, v3 = false) {
    const maxIdx = Math.max(0, levelCount - 1);
    if (!quality || quality === 'native') return 0;

    const lodMatch = quality.match(/^lod(\d+)$/);
    if (lodMatch) {
      return Math.min(maxIdx, parseInt(lodMatch[1], 10));
    }

    // Handle resolution keys (e.g. 256x256, 512x512, 1024x1024)
    const match = quality.match(/^(\d+)x\d+$/);
    if (match) {
      const targetSize = parseInt(match[1], 10);
      // v3 (SPEC §13.7): the finest level whose larger XY side is at most 1.5 × the
      // preset ("512" ≤ 768, "1024" ≤ 1536), the coarsest when none is that small.
      if (v3 && Array.isArray(levels) && levels.length) {
        const limit = 1.5 * targetSize;
        for (let i = 0; i < levels.length; i++) {
          const d = levels[i]?.dimensions;
          if (d && Math.max(Number(d.x) || 0, Number(d.y) || 0) <= limit) return Math.min(i, maxIdx);
        }
        return Math.min(levels.length - 1, maxIdx);
      }
      if (levels && Array.isArray(levels)) {
        let bestLod = 0;
        let minDiff = Infinity;
        for (let i = 0; i < levels.length; i++) {
          const dims = levels[i]?.dimensions;
          if (dims && dims.x && dims.y) {
            const maxDim = Math.max(dims.x, dims.y);
            const diff = Math.abs(maxDim - targetSize);
            if (diff < minDiff) {
              minDiff = diff;
              bestLod = i;
            }
          }
        }
        return bestLod;
      } else {
        // Fallback calculation based on typical levels
        if (targetSize <= 256) return maxIdx;
        if (targetSize <= 512) return Math.min(maxIdx, Math.max(0, maxIdx - 1));
        if (targetSize <= 1024) return Math.min(maxIdx, Math.max(0, maxIdx - 2));
        return 0;
      }
    }

    // Fallbacks for legacy/abstract keys
    if (quality === 'preview' || quality === 'low') return maxIdx;
    if (quality === 'balanced' || quality === 'medium') return Math.min(maxIdx, Math.max(0, maxIdx - 1));
    if (quality === 'high') return Math.min(maxIdx, Math.max(0, maxIdx - 2));
    return 0;
  }

  /** Canonical quality key: a resolution label, 'native', or 'lodN' (one level of the
   *  pyramid, e.g. a coarse preview). Anything else is 512x512, with a warning. */
  function _normalizeQualityKey(value) {
    const key = String(value || '').trim().toLowerCase();
    if (key === 'low' || key === 'preview' || key === '256x256') return '256x256';
    if (key === 'balanced' || key === 'medium' || key === '512x512') return '512x512';
    if (key === 'high' || key === '1024x1024') return '1024x1024';
    if (key === '2048x2048') return '2048x2048';
    if (key === '4096x4096') return '4096x4096';
    if (key === 'native') return 'native';
    if (/^lod\d+$/.test(key)) return key;
    if (key) console.warn(`[VolumeViewer] unknown quality "${value}" — using 512x512`);
    return '512x512'; // default target
  }

  function _brickConcurrencyForQuality(quality) {
    const fromGlobal = Number(window.IRIBHM_BRICK_CONCURRENCY);
    if (Number.isFinite(fromGlobal) && fromGlobal > 0) {
      return Math.max(2, Math.min(96, Math.round(fromGlobal)));
    }
    return BRICK_STREAM_CONCURRENCY[quality] || 24;
  }

  function _yieldToPaint() {
    return new Promise(resolve => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => setTimeout(resolve, 0));
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  function _manifestHistograms(histograms, channels) {
    if (!Array.isArray(histograms) || !histograms.length) return [];
    return histograms.slice(0, channels).map((hist) => {
      const counts = Array.isArray(hist?.counts) ? hist.counts.map(v => Number(v) || 0) : [];
      if (!counts.length) return null;
      return {
        ...hist,
        bins: Number(hist.bins) || counts.length,
        counts,
        max: Number(hist.max) || Math.max(1, ...counts),
        total: Number(hist.total) || counts.reduce((sum, value) => sum + value, 0)
      };
    }).filter(Boolean);
  }

  function _floorLuts(floors, channels) {
    return Array.from({ length: channels }, (_, c) => {
      const floor = Math.max(0, Math.min(254, Math.round(Number(floors?.[c]) || 0)));
      const scale = 255 / Math.max(1, 255 - floor);
      const lut = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        lut[i] = i <= floor ? 0 : Math.min(255, Math.round((i - floor) * scale));
      }
      return lut;
    });
  }

  function _isRgbaTexture(tex) {
    return tex?.format === THREE.RGBAFormat || tex?.image?.data?.length >= (tex?.image?.width || 0) * (tex?.image?.height || 0) * (tex?.image?.depth || 0) * RGBA_TEXTURE_BYTES_PER_VOXEL;
  }

  /** texSubImage3D of a box (tightly packed, 1 or 4 bytes per voxel as the texture). */
  function _updateGPUTextureRegion(tex, dims, ox, oy, oz, bw, bh, bd, brickData) {
    if (!renderer || !brickData || !brickData.length) return;
    const properties = renderer.properties.get(tex);
    const webglTexture = properties?.__webglTexture;
    if (!webglTexture) {
      return;
    }

    const gl = renderer.getContext();
    let prevBinding = null;
    if (renderer.state && renderer.state.bindTexture) {
      renderer.state.bindTexture(gl.TEXTURE_3D, webglTexture);
    } else {
      prevBinding = gl.getParameter(gl.TEXTURE_BINDING_3D);
      gl.bindTexture(gl.TEXTURE_3D, webglTexture);
    }

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
    // three leaves FLIP_Y / PREMULTIPLY set by the last texture it uploaded (true for a
    // canvas label), and either one makes an ArrayBufferView upload an error.
    if (gl.UNPACK_FLIP_Y_WEBGL !== undefined) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL !== undefined) gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (gl.PIXEL_UNPACK_BUFFER) {
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    }

    const glFormat = _isRgbaTexture(tex) ? gl.RGBA : gl.RED;

    gl.texSubImage3D(
      gl.TEXTURE_3D,
      0,
      ox, oy, oz,
      bw, bh, bd,
      glFormat,
      gl.UNSIGNED_BYTE,
      brickData
    );

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);

    if (!(renderer.state && renderer.state.bindTexture)) {
      gl.bindTexture(gl.TEXTURE_3D, prevBinding);
    }
  }

  // Kept for callers outside the stream (the Studio's native pass): the floor LUT and
  // the channel interleave of a brick, on the calling thread. The stream itself has the
  // decode workers do both (BrickLoader compose).
  function _applyRgbaBrickLuts(brickData, floorLuts = null, channels = 4) {
    if (!brickData || !floorLuts?.length) return brickData;
    const activeChannels = Math.max(0, Math.min(4, Number(channels) || 4, floorLuts.length));
    if (!activeChannels) return brickData;
    const out = new Uint8Array(brickData.length);
    for (let i = 0; i < brickData.length; i += 4) {
      for (let c = 0; c < 4; c++) {
        const value = brickData[i + c] || 0;
        const lut = c < activeChannels ? floorLuts[c] : null;
        out[i + c] = lut ? lut[value] : value;
      }
    }
    return out;
  }

  function _composeRgbaBrickFromScalarChannels(channelData, floorLuts = null, channels = 4, brickSize = 64) {
    const activeChannels = Math.max(0, Math.min(4, Number(channels) || 4));
    const voxelCount = brickSize * brickSize * brickSize;
    const out = new Uint8Array(voxelCount * RGBA_TEXTURE_BYTES_PER_VOXEL);
    for (let c = 0; c < activeChannels; c++) {
      const src = channelData?.[c];
      if (!src) continue;
      const lut = floorLuts?.[c] || null;
      const n = Math.min(voxelCount, src.length);
      for (let i = 0, dst = c; i < n; i++, dst += RGBA_TEXTURE_BYTES_PER_VOXEL) {
        const value = src[i] || 0;
        out[dst] = lut ? lut[value] : value;
      }
    }
    return out;
  }

  function _floorsFromManifest(manifest, channels, overrideHistograms = null) {
    const list = Array.isArray(overrideHistograms)
      ? overrideHistograms
      : (Array.isArray(manifest?.histograms) ? manifest.histograms : []);
    return Array.from({ length: channels }, (_, c) => {
      const hist = list[c];
      if (Number.isFinite(hist?.backgroundFloor) && Number(hist.backgroundFloor) > 0) {
        return Math.max(2, Math.min(48, Number(hist.backgroundFloor)));
      }
      const counts = Array.isArray(hist?.counts) ? hist.counts : null;
      const total = Number(hist?.total) || 0;
      if (!counts || !total) return 8;
      const zeroBin = Number(counts[0]) || 0;
      const nonZeroTotal = Math.max(0, total - zeroBin);
      const target = nonZeroTotal > 0 ? zeroBin + nonZeroTotal * 0.20 : total * 0.90;
      let acc = 0;
      let bin = 0;
      for (let i = 0; i < counts.length; i++) {
        acc += Number(counts[i]) || 0;
        if (acc >= target) {
          bin = i;
          break;
        }
      }
      const edges = Array.isArray(hist?.edges) ? hist.edges : null;
      const edgeFloor = edges && Number.isFinite(Number(edges[bin + 1])) ? Number(edges[bin + 1]) : null;
      const estimated = edgeFloor !== null
        ? edgeFloor
        : Math.round((bin / Math.max(1, counts.length - 1)) * 255);
      return Math.max(6, Math.min(48, Math.round(estimated) + 2));
    });
  }

  /**
   * The manifest of one tree (one timepoint of a timelapse) and its path under the
   * brick directory. v2: the timepoint's row overrides channels / levels / histograms /
   * transport. v3 (SPEC §13.3): `timepoints` is an array of { path, index } rows; the
   * tree is `bricks/<path>`, its own index.bin given relative to `bricks/` (so it must
   * lie inside `<path>/`); levels and channels are the root manifest's.
   */
  function _selectBrickManifestForTimepoint(manifest, timepoint) {
    if (!manifest || typeof manifest !== 'object') {
      return { available: false, reason: 'Invalid brick manifest payload' };
    }
    const memoKey = manifest.timepoints ? (Number.isFinite(Number(timepoint)) ? Number(timepoint) : 0) : 'root';
    let memo = _tpManifestMemo.get(manifest);
    if (!memo) { memo = new Map(); _tpManifestMemo.set(manifest, memo); }
    if (memo.has(memoKey)) return memo.get(memoKey);
    const result = _selectBrickManifestUncached(manifest, timepoint);
    if (result.available) memo.set(memoKey, result);
    return result;
  }

  function _selectBrickManifestUncached(manifest, timepoint) {
    if (_isV3Manifest(manifest) && Array.isArray(manifest.timepoints)) {
      const tp = Number.isFinite(Number(timepoint)) ? Number(timepoint) : 0;
      const name = `t${String(tp).padStart(3, '0')}`;
      const row = manifest.timepoints.find(r => r && r.path === name) || manifest.timepoints[tp] || null;
      if (!row || !row.index || typeof row.index.url !== 'string') {
        return { available: false, reason: `No bricks for requested timepoint ${tp}` };
      }
      const sub = String(row.path || name).replace(/^\/+|\/+$/g, '');
      const url = String(row.index.url).replace(/^\/+/, '');
      if (!sub || !url.startsWith(`${sub}/`)) {
        return { available: false, reason: `Timepoint ${tp}: index ${url} is not inside its tree ${sub}/` };
      }
      // The frame's own histograms (SPEC §13.3 `timepointHistograms`), as a v2 row's:
      // they set the frame's background floor, so the picture matches the v2 one.
      const own = manifest.timepointHistograms && typeof manifest.timepointHistograms === 'object'
        ? manifest.timepointHistograms[sub] : null;
      const histograms = Array.isArray(own) ? own : (Array.isArray(manifest.histograms) ? manifest.histograms : []);
      return {
        available: true,
        manifest: { ...manifest, timepoints: null, histograms, index: { ...row.index, url: url.slice(sub.length + 1) } },
        subPath: sub,
        histograms
      };
    }
    const hasTimepoints = manifest.timepoints && typeof manifest.timepoints === 'object';
    if (!hasTimepoints) {
      return {
        available: true,
        manifest,
        subPath: '',
        histograms: Array.isArray(manifest.histograms) ? manifest.histograms : []
      };
    }
    const tp = Number.isFinite(Number(timepoint)) ? Number(timepoint) : 0;
    const keys = [`t${String(tp).padStart(3, '0')}`, String(tp), tp];
    let row = null;
    for (const key of keys) {
      if (manifest.timepoints[key] != null) {
        row = manifest.timepoints[key];
        break;
      }
    }
    if (!row) {
      return { available: false, reason: `No bricks for requested timepoint ${tp}` };
    }
    return {
      available: true,
      manifest: {
        ...manifest,
        channels: row.channels || manifest.channels,
        levels: row.levels || manifest.levels,
        histograms: row.histograms || manifest.histograms,
        brickTransport: row.brickTransport || manifest.brickTransport
      },
      subPath: row.path || `t${String(tp).padStart(3, '0')}`,
      histograms: Array.isArray(row.histograms)
        ? row.histograms
        : (Array.isArray(manifest.histograms) ? manifest.histograms : [])
    };
  }

  /**
   * Bricks sorted by distance from the centre of the grid, in MICROMETRES — a brick
   * holds 64 voxels on every axis but a Z voxel is often several times deeper than an
   * XY one (and the pyramid only halves X and Y), so counting in brick indices would
   * make "the centre" a slab. `extentUm` is the volume's physical size {x, y, z}; a
   * voxel of this level is extent / dims on each axis. The loader starts at the first
   * brick and takes its packs outward from there.
   */
  function _orderBricksForStreaming(bricks, dims, extentUm = null) {
    const bs = Math.max(1, Number(dims?.brickSize) || VOLUME_BRICK_SIZE);
    const nx = Math.max(1, Number(dims?.x) || bs);
    const ny = Math.max(1, Number(dims?.y) || bs);
    const nz = Math.max(1, Number(dims?.z) || bs);
    const cx = Math.ceil(nx / bs) / 2;
    const cy = Math.ceil(ny / bs) / 2;
    const cz = Math.ceil(nz / bs) / 2;
    const wx = Number(extentUm?.x) > 0 ? Number(extentUm.x) / nx : 1;
    const wy = Number(extentUm?.y) > 0 ? Number(extentUm.y) / ny : wx;
    const wz = Number(extentUm?.z) > 0 ? Number(extentUm.z) / nz : wx;
    const d = (b) => Math.hypot((b.bx + 0.5 - cx) * wx, (b.by + 0.5 - cy) * wy, (b.bz + 0.5 - cz) * wz);
    return [...bricks].map(b => [d(b), b]).sort((a, b) => a[0] - b[0]).map(e => e[1]);
  }

})();

// Expose on window so parent frames (compare.js) can access via iframe.contentWindow
window.VolumeViewer = VolumeViewer;

