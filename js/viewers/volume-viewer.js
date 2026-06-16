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
  let _volumeBoundingBox = null;
  let _svrManager = null;
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
  let _rotGizmo = null;
  let _gizmoHovered = false;
  let _qualityTarget = '512x512';
  let _currentQualityMode = '512x512';
  let _dirtyRegions = [];
  let _isStreamingBricks = false;
  let _transitionCube = null;
  let _transitionMaterial = null;
  let _transitionEntry = null;
  let _qualityState = { target: '512x512', active: null, mode: 'slice', progress: 0, message: '' };
  const _qualityListeners = new Set();
  let _brickStreamAbort = null;
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
  const MONOLITHIC_RGBA_LIMIT_BYTES = Math.floor(1.5 * 1024 * 1024 * 1024);

  let _needsRender = true;
  let _idleFrameCount = 0;
  const IDLE_SLEEP_FRAMES = 120; // Stop rAF loop after ~2s of no changes
  let _lastCameraPos = new THREE.Vector3();
  let _lastCameraQuat = new THREE.Quaternion();
  let _lastCubePos = new THREE.Vector3();
  let _lastCubeQuat = new THREE.Quaternion();
  let _rotationLocked = false;
  let _isInteracting = false;
  let _activePointers = new Map();
  let _targetSteps = 100;
  let _lastInteractionTime = 0;
  let _lastFrameRenderTime = 0;
  let _interactionTimeout = null;

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
            if (e.data.type === 'progress') return;
            if (e.data.type === 'error') {
              console.error(`[VolumeViewer] Blur worker ${wi} error:`, e.data.message);
              return;
            }
            if (e.data.type === 'result') {
              const asm = _blurAssemblers.get(e.data.taskId);
              if (!asm) return; // stale
              asm.chunks[e.data.chunkIndex] = new Uint8Array(e.data.blurredData);
              asm.remaining--;
              if (asm.remaining === 0) {
                _blurAssemblers.delete(e.data.taskId);
                // Assemblage des chunks en un seul buffer
                const totalLen = asm.chunks.reduce((s, c) => s + c.length, 0);
                const merged = new Uint8Array(totalLen);
                let off = 0;
                for (const chunk of asm.chunks) {
                  merged.set(chunk, off);
                  off += chunk.length;
                }
                asm.onDone(merged);
              }
            }
          };
          w.onerror = (err) => console.error(`[VolumeViewer] Blur worker ${wi} error:`, err.message);
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

  function _dispatchParallelBlur(rawSingleChannel, width, height, depth, sigma, onDone) {
    const pool = _getBlurWorkerPool();
    if (!pool || pool.length === 0) {
      // Fallback main-thread
      console.warn('[VolumeViewer] No worker pool, falling back to main thread blur');
      onDone(rawSingleChannel); // return unblurred as fallback
      return;
    }

    _blurActiveCount++;
    _showBlurToast();

    const taskId = ++_blurTaskId;
    const N = Math.min(pool.length, depth);
    const sliceSize = width * height;
    const chunks = new Array(N);

    // Wrapping onDone to decrement counter and hide toast when all tasks complete
    const wrappedOnDone = (merged) => {
      _blurActiveCount = Math.max(0, _blurActiveCount - 1);
      if (_blurActiveCount === 0) _hideBlurToast();
      onDone(merged);
    };

    _blurAssemblers.set(taskId, { remaining: N, chunks, onDone: wrappedOnDone });

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
  const BRICK_TEXTURE_UPDATE_MS = { 
    '4096x4096': 800, '2048x2048': 700, '1024x1024': 650, native: 800, '256x256': 450, '512x512': 550,
    high: 650, preview: 450, balanced: 550
  };
  const BRICK_TEXTURE_UPDATE_OPS = { 
    '4096x4096': 4, '2048x2048': 6, '1024x1024': 12, native: 4, '256x256': 8, '512x512': 12,
    high: 12, preview: 8, balanced: 12
  };
  const IMAGE_CACHE_LIMIT = 640;
  const VOLUME_CACHE_LIMIT = 4;
  const _imageCache = new Map();
  const _volumeCache = new Map();

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
  // renderMode: 0 = DVR (depth/occlusion), 1 = Emission (Imaris-like additive fluorescence)
  const fragmentShader = `
    precision highp float;
    precision highp int;
    precision highp sampler3D;

    in vec3 vUv;
    in vec3 vOrigin;
    in vec3 vDirection;

    uniform sampler3D svrAtlas0;
    uniform sampler3D svrAtlas1;
    uniform sampler3D svrAtlas2;
    uniform sampler3D svrAtlas3;
    uniform sampler3D svrAtlas4;
    uniform sampler3D svrAtlas5;
    uniform sampler3D svrAtlas6;
    uniform sampler3D svrAtlas7;
    #ifdef HAS_OCCUPANCY
    uniform sampler3D mapOccupancy;
    #endif
    
    #ifdef ENABLE_SVR
    uniform sampler3D pageTable;
    uniform vec3 atlasDim;
    uniform vec3 volumeDim;
    uniform vec3 ptDim;
    uniform vec3 ptScale;
    uniform float brickSize;
    
    vec4 getAtlasLookup(vec3 logicalPos) {
        vec3 logicalPixels = clamp(logicalPos * volumeDim, vec3(0.0), volumeDim - vec3(1.0));
        vec3 brickCoord = floor(logicalPixels / brickSize);
        vec3 ptCoord = (brickCoord + vec3(0.5)) / ptDim;
        vec4 page = texture(pageTable, ptCoord);
        float atlasPage = floor(page.a * 255.0 + 0.5) - 1.0;
        if (atlasPage < 0.0) return vec4(-1.0);
        vec3 slotIndex = floor(page.rgb * 255.0 + 0.5);
        vec3 brickOrigin = brickCoord * brickSize;
        vec3 brickExtent = min(vec3(brickSize), volumeDim - brickOrigin);
        vec3 localVoxel = clamp(floor(logicalPixels - brickOrigin), vec3(0.0), max(vec3(0.0), brickExtent - vec3(1.0)));
        vec3 atlasVoxel = slotIndex * brickSize + localVoxel;
        return vec4((atlasVoxel + vec3(0.5)) / atlasDim, atlasPage);
    }

    vec4 sampleSVRAtlas(vec3 atlasCoord, float atlasPage) {
        vec4 value = texture(svrAtlas0, atlasCoord);
        if (atlasPage < 0.5) {
            value = texture(svrAtlas0, atlasCoord);
        } else if (atlasPage < 1.5) {
            value = texture(svrAtlas1, atlasCoord);
        } else if (atlasPage < 2.5) {
            value = texture(svrAtlas2, atlasCoord);
        } else if (atlasPage < 3.5) {
            value = texture(svrAtlas3, atlasCoord);
        } else if (atlasPage < 4.5) {
            value = texture(svrAtlas4, atlasCoord);
        } else if (atlasPage < 5.5) {
            value = texture(svrAtlas5, atlasCoord);
        } else if (atlasPage < 6.5) {
            value = texture(svrAtlas6, atlasCoord);
        } else {
            value = texture(svrAtlas7, atlasCoord);
        }
        return value;
    }
    #endif
    uniform int numChannels;
    uniform int steps;
    uniform int renderMode;   // 0 = DVR, 1 = Emission
    uniform float exposure;   // global brightness multiplier
    
    uniform vec3 color0; uniform float min0; uniform float max0; uniform float gamma0; uniform float opacity0; uniform int en0;
    uniform vec3 color1; uniform float min1; uniform float max1; uniform float gamma1; uniform float opacity1; uniform int en1;
    uniform vec3 color2; uniform float min2; uniform float max2; uniform float gamma2; uniform float opacity2; uniform int en2;
    uniform vec3 color3; uniform float min3; uniform float max3; uniform float gamma3; uniform float opacity3; uniform int en3;

    uniform vec3 clipMin;
    uniform vec3 clipMax;
    
    out vec4 fragColor;

    vec2 hitBox(vec3 orig, vec3 dir) {
      vec3 box_min = vec3(-0.5);
      vec3 box_max = vec3(0.5);
      vec3 safe_dir = dir + (1.0 - step(vec3(1e-8), abs(dir))) * 1e-8;
      vec3 inv_dir = 1.0 / safe_dir;
      vec3 tmin_tmp = (box_min - orig) * inv_dir;
      vec3 tmax_tmp = (box_max - orig) * inv_dir;
      vec3 tmin = min(tmin_tmp, tmax_tmp);
      vec3 tmax = max(tmin_tmp, tmax_tmp);
      float t0 = max(tmin.x, max(tmin.y, tmin.z));
      float t1 = min(tmax.x, min(tmax.y, tmax.z));
      return vec2(t0, t1);
    }

    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    // ACES filmic tone mapping — keeps colours saturated and vivid under high brightness
    vec3 ACESFilm(vec3 x) {
      return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
    }

    void main() {
      vec3 rayDir = normalize(vDirection);
      vec2 bounds = hitBox(vOrigin, rayDir);
      if (bounds.x > bounds.y) discard;

      bounds.x = max(bounds.x, 0.0);
      float rayLength = bounds.y - bounds.x;
      float delta = rayLength / max(float(steps), 1.0);
      float jitter = hash(gl_FragCoord.xy) * delta;
      vec3 p = vOrigin + (bounds.x + jitter) * rayDir;
      float t = jitter;

      // ── Per-channel MIP accumulators (mode 1 - Fluorescence) ──
      float mip0 = 0.0;
      float mip1 = 0.0;
      float mip2 = 0.0;
      float mip3 = 0.0;

      // ── DVR accumulators (mode 0 - Structure) ──
      vec3  accumDVR   = vec3(0.0);
      float accumAlpha = 0.0;

      int maxSteps = steps;
      for (int i = 0; i < 768; i++) {
        if (i >= maxSteps) break;
        if (t >= rayLength) break;
        if (renderMode == 0 && accumAlpha > 0.97) break;

        vec3 uvw = p + vec3(0.5);
        if (uvw.x >= clipMin.x && uvw.x <= clipMax.x &&
            uvw.y >= clipMin.y && uvw.y <= clipMax.y &&
            uvw.z >= clipMin.z && uvw.z <= clipMax.z) {

          #ifdef ENABLE_SVR
          vec4 atlasLookup = getAtlasLookup(uvw);
          if (atlasLookup.w < 0.0) {
             t += delta * 2.5;
             p += rayDir * (delta * 2.5);
             continue;
          }
          #else
            #ifdef HAS_OCCUPANCY
            float occ = texture(mapOccupancy, uvw).r;
            if (occ < 0.5) {
               t += delta * 2.5;
               p += rayDir * (delta * 2.5); // Leap forward safely
               continue;
             }
            #endif
          #endif

          #ifdef ENABLE_SVR
          vec4 val = sampleSVRAtlas(atlasLookup.xyz, atlasLookup.w);
          #else
          vec4 val = texture(svrAtlas0, uvw);
          #endif

          float v0 = 0.0;
          float v1 = 0.0;
          float v2 = 0.0;
          float v3 = 0.0;

          #if ENABLE_CHANNEL_0
          if (en0 == 1) {
            v0 = clamp((val.r - min0) / max(max0 - min0, 0.0001), 0.0, 1.0);
            if (gamma0 != 1.0) v0 = pow(v0, gamma0);
            v0 *= opacity0;
          }
          #endif

          #if ENABLE_CHANNEL_1
          if (en1 == 1) {
            v1 = clamp((val.g - min1) / max(max1 - min1, 0.0001), 0.0, 1.0);
            if (gamma1 != 1.0) v1 = pow(v1, gamma1);
            v1 *= opacity1;
          }
          #endif

          #if ENABLE_CHANNEL_2
          if (en2 == 1) {
            v2 = clamp((val.b - min2) / max(max2 - min2, 0.0001), 0.0, 1.0);
            if (gamma2 != 1.0) v2 = pow(v2, gamma2);
            v2 *= opacity2;
          }
          #endif

          #if ENABLE_CHANNEL_3
          if (en3 == 1) {
            v3 = clamp((val.a - min3) / max(max3 - min3, 0.0001), 0.0, 1.0);
            if (gamma3 != 1.0) v3 = pow(v3, gamma3);
            v3 *= opacity3;
          }
          #endif

          if (renderMode == 1) {
            #if ENABLE_CHANNEL_0
            mip0 = max(mip0, v0);
            #endif
            #if ENABLE_CHANNEL_1
            mip1 = max(mip1, v1);
            #endif
            #if ENABLE_CHANNEL_2
            mip2 = max(mip2, v2);
            #endif
            #if ENABLE_CHANNEL_3
            mip3 = max(mip3, v3);
            #endif
          } else {
            float localAlpha = max(max(v0, v1), max(v2, v3));
            if (localAlpha > 0.01) {
              vec3 localColor = v0 * color0 + v1 * color1 + v2 * color2 + v3 * color3;
              accumDVR   += localColor * localAlpha * 0.05; 
              accumAlpha += localAlpha * 0.05;
            }
          }
        }
        t += delta;
        p += rayDir * delta;
      }

      vec3 finalColor;

      if (renderMode == 1) {
        float totalMIP = max(max(mip0, mip1), max(mip2, mip3));
        if (totalMIP < 0.004) discard;
        vec3 mipColor = mip0 * color0 + mip1 * color1 + mip2 * color2 + mip3 * color3;
        finalColor = mipColor * exposure;
      } else {
        if (accumAlpha < 0.01) discard;
        finalColor = accumDVR * exposure;
      }

      fragColor = vec4(finalColor, 1.0);
    }
  `;

  function init(containerId) {
    const container = document.getElementById(containerId);
    _container = container;
    
    // Setup Three.js Scene
    scene = new THREE.Scene();
    
    const parent = container.parentElement || container;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);

    // Camera
    camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    camera.position.z = 2.5;

    // Renderer
    const canvas = container;
    renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    // ELE-18 (EDGE-001): WebGL context loss (VRAM exhaustion, driver reset/TDR, tab
    // backgrounding) must degrade gracefully (Rule 1.1). preventDefault() is REQUIRED so the
    // browser may later restore the context; we stop the render loop and surface a visible
    // status (hooks wired in viewer.js) instead of drawing on a dead context.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      _contextLost = true;
      if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
      console.error('[VolumeViewer] WebGL context lost - rendering paused.');
      _perf()?.event('viewer.context_lost', { quality: _qualityTarget });
      _emitQualityState({ message: 'GPU context lost', progress: 0 });
      _onContextLost?.();
    }, false);
    canvas.addEventListener('webglcontextrestored', () => {
      _contextLost = false;
      console.warn('[VolumeViewer] WebGL context restored - volume must be reloaded.');
      _perf()?.event('viewer.context_restored', { quality: _qualityTarget });
      _onContextRestored?.();
      _scheduleFrame();
    }, false);
    renderer.setSize(w, h, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 1); // Force Noir Pur pour l'Additive Blending
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
        pageTable: { value: null },
        atlasDim: { value: new THREE.Vector3(512, 512, 512) },
        volumeDim: { value: new THREE.Vector3(1, 1, 1) },
        ptDim: { value: new THREE.Vector3(1, 1, 1) },
        ptScale: { value: new THREE.Vector3(1, 1, 1) },
        brickSize: { value: 64.0 },
        numChannels: { value: 0 },
        steps: { value: 100 },
        renderMode: { value: 1 },  // 1 = Emission (Imaris-like) by default
        exposure: { value: 1.0 },  // global brightness
        clipMin: { value: new THREE.Vector3(0, 0, 0) },
        clipMax: { value: new THREE.Vector3(1, 1, 1) },
        
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
    _setupInteraction(container);

    // Resize handler
    window.addEventListener('resize', resize);
    if (window.ResizeObserver && container.parentElement) {
      _resizeObserver = new ResizeObserver(resize);
      _resizeObserver.observe(container.parentElement);
    }

    _initVolumeGrid();
    _animate();
  }

  function resize() {
    if (!_container || !camera || !renderer) return;
    const parent = _container.parentElement || _container;
    const width = Math.max(1, parent.clientWidth);
    const height = Math.max(1, parent.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    if (_hasLoadedVolume) {
      const requiredDistance = _fitCameraDistance(1.25);
      if (Number.isFinite(requiredDistance) && camera.position.z < requiredDistance) {
        camera.position.z = requiredDistance;
      }
    }
    if (scene && camera) renderer.render(scene, camera);
    _scheduleFrame();
  }
  
  function _setupInteraction(canvas) {
    let isDragging = false;
    let dragMode = 'rotate';
    let previousMousePosition = { x: 0, y: 0 };
    let startMousePosition = { x: 0, y: 0 };
    let _activePointerId = null; // primary pointer being tracked

    // Pinch / two-finger state
    _activePointers.clear();
    let _pinchStartDist = null;
    let _pinchStartCameraZ = null;

    let _gridDragState = null;
    let _lastInteractionClickTime = 0;
    let planeDragState = null;
    let gizmoVelocity = { yaw: 0, pitch: 0, roll: 0 };
    let inertiaFrame = null;

    // Prevent native scroll / zoom gestures on the canvas
    canvas.style.touchAction = 'none';
    canvas.style.userSelect = 'none';
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Helper: get offset relative to canvas
    function _offset(e) {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }
    
    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      _activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      // Two-finger pinch: track but don't start regular drag
      if (_activePointers.size === 2) {
        const pts = [..._activePointers.values()];
        _pinchStartDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        _pinchStartCameraZ = camera ? camera.position.z : 2.5;
        isDragging = false;
        return;
      }

      canvas.setPointerCapture(e.pointerId);
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
        const mouseNorm = new THREE.Vector2(
          (off.x / canvas.clientWidth) * 2 - 1,
          -(off.y / canvas.clientHeight) * 2 + 1
        );
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouseNorm, camera);
        const hit = raycaster.intersectObjects(_labelsGroup.children, false);
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
        // Single touch finger → rotate; touch + shift or RMB → pan
        const isTouch = e.pointerType === 'touch';
        dragMode = (e.button === 1 || e.button === 2 || e.shiftKey || _rotationLocked) ? 'pan'
                 : (isTouch && _activePointers.size === 1) ? 'rotate'
                 : 'rotate';
      }
      previousMousePosition = { x: off.x, y: off.y };
      startMousePosition = { ...previousMousePosition };
    });
    
    canvas.addEventListener('pointermove', (e) => {
      // Update pinch tracker
      if (_activePointers.has(e.pointerId)) {
        _activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }

      // Two-finger pinch-to-zoom
      if (_activePointers.size === 2 && _pinchStartDist !== null) {
        const pts = [..._activePointers.values()];
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        if (dist > 0 && _pinchStartCameraZ !== null) {
          camera.position.z = Math.max(0.2, Math.min(100, _pinchStartCameraZ * (_pinchStartDist / dist)));
          _scheduleFrame();
          _notifyCameraChange();
        }
        _markInteraction();
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
        const interactionHit = _intersectInteractionHandles(e.clientX, e.clientY);
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
          const mouseNorm = new THREE.Vector2(
            (off.x / canvas.clientWidth) * 2 - 1,
            -(off.y / canvas.clientHeight) * 2 + 1
          );
          const raycaster = new THREE.Raycaster();
          raycaster.setFromCamera(mouseNorm, camera);
          const hit = raycaster.intersectObjects(_labelsGroup.children, false);
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
          const ndc = new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1
          );
          const raycaster = new THREE.Raycaster();
          raycaster.setFromCamera(ndc, camera);
          const targetWorld = new THREE.Vector3();
          
          if (raycaster.ray.intersectPlane(plane, targetWorld)) {
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
            const deltaRotationQuaternion = new THREE.Quaternion()
              .setFromEuler(new THREE.Euler(
                  (deltaMove.y * 1) * (Math.PI / 180),
                  (deltaMove.x * 1) * (Math.PI / 180),
                  0,
                  'XYZ'
              ));
            cube.quaternion.multiplyQuaternions(deltaRotationQuaternion, cube.quaternion);
          }
        } else {
          // Default: rotate — blocked when rotation is locked
          if (!_rotationLocked) {
            const deltaRotationQuaternion = new THREE.Quaternion()
              .setFromEuler(new THREE.Euler(
                  (deltaMove.y * 1) * (Math.PI / 180),
                  (deltaMove.x * 1) * (Math.PI / 180),
                  0,
                  'XYZ'
              ));
            cube.quaternion.multiplyQuaternions(deltaRotationQuaternion, cube.quaternion);
          }
        }
        // Notify camera sync in real time — only for moves that actually changed something
        if (!_rotationLocked && (dragMode === 'rotate' || dragMode === 'pan' || dragMode === 'measure')) {
          _notifyCameraChange();
        }
      }
      previousMousePosition = { x: off.x, y: off.y };
    });

    canvas.addEventListener('pointerup', (e) => {
      _activePointers.delete(e.pointerId);
      if (_activePointers.size < 2) { _pinchStartDist = null; _pinchStartCameraZ = null; }
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
      isDragging = false;
      _isInteracting = false;
      _lastInteractionTime = 0;
      if (_interactionTimeout) {
        clearTimeout(_interactionTimeout);
        _interactionTimeout = null;
      }
      planeDragState = null;
      _scheduleFrame();
    });

    canvas.addEventListener('pointercancel', (e) => {
      _activePointers.delete(e.pointerId);
      if (e.pointerId === _activePointerId) {
        _activePointerId = null;
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
      _pinchStartDist = null; _pinchStartCameraZ = null;
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      // In cut mode: scroll over plane → move plane; otherwise zoom
      if (_activeTool === 'cut' && _cutPlane.visible && _planeHovered) {
        const direction = e.deltaY > 0 ? -1 : 1;
        setPlaneSpec({ value: _planeSpec.value + direction * 0.02, visible: true });
        _markInteraction();
        return;
      }
      camera.position.z += e.deltaY * 0.005;
      camera.position.z = Math.max(0.2, Math.min(camera.position.z, 100));
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
    const center = currentNormal.clone().multiplyScalar((_planeSpec.value ?? 0.5) - 0.5);
    const draft = {
      ..._planeSpec,
      mode: 'oblique',
      yaw: Number.isFinite(angles.yaw) ? angles.yaw : (_planeSpec.yaw || 0),
      pitch: Number.isFinite(angles.pitch) ? angles.pitch : (_planeSpec.pitch || 0),
      roll: Number.isFinite(angles.roll) ? angles.roll : (_planeSpec.roll || 0)
    };
    const nextNormal = _normalForPlaneSpec(draft);
    const nextValue = THREE.MathUtils.clamp(center.dot(nextNormal) + 0.5, 0, 1);
    return {
      yaw: draft.yaw,
      pitch: draft.pitch,
      roll: draft.roll,
      value: nextValue
    };
  }

  function _animate() {
    if (_contextLost) { animationId = null; return; }   // ELE-18: never draw on a lost context
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const isInteractingNow = _isInteracting || (_activePointers.size === 2) || (Date.now() - _lastInteractionTime < 250);

    // Cap frame rate during active interaction to reduce GPU workload and temperature.
    // At 40 FPS, the visual movement is still extremely fluid while saving significant GPU power.
    if (isInteractingNow) {
      const elapsed = now - _lastFrameRenderTime;
      const minInterval = 25.0; // 40 FPS max (1000 / 40 = 25ms)
      if (elapsed < minInterval) {
        animationId = requestAnimationFrame(_animate);
        return;
      }
    }
    _lastFrameRenderTime = now;

    _syncRotGizmoTransform();
    _syncGridRotation();

    // Dynamically adjust steps value during interaction or streaming to keep frame rate high
    if (material) {
      const targetVal = (isInteractingNow || _isStreamingBricks)
        ? Math.min(48, Math.max(24, Math.round(_targetSteps * 0.35)))
        : _targetSteps;
      
      if (material.uniforms.steps.value !== targetVal) {
        material.uniforms.steps.value = targetVal;
        _needsRender = true; // Force redraw to apply quality change
      }

      if (cube) {
        cube.userData.isInteractingNow = isInteractingNow;
      }

      if (renderer) {
        const basePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        // During interaction or streaming, render at a lower resolution (0.40 for 1024x1024/native, 0.50 for others).
        // This reduces pixel fill-rate by 6.25x (or 25x on Retina) during rotation/load.
        const interactionScale = (_qualityTarget === '1024x1024' || _qualityTarget === 'native') ? 0.40 : 0.50;
        const targetRatio = (isInteractingNow || _isStreamingBricks)
          ? interactionScale
          : basePixelRatio;
        
        if (renderer.getPixelRatio() !== targetRatio) {
          renderer.setPixelRatio(targetRatio);
          _needsRender = true;
        }
      }
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
      renderer.render(scene, camera);
      if (_onPostRender) _onPostRender();
      _lastCameraPos.copy(camera.position);
      _lastCameraQuat.copy(camera.quaternion);
      _lastCubePos.copy(cube.position);
      _lastCubeQuat.copy(cube.quaternion);
      _needsRender = false;
      _idleFrameCount = 0;
    } else {
      _idleFrameCount++;
    }

    // Stop requestAnimationFrame loop immediately when idle to prevent GPU usage
    if (_idleFrameCount < IDLE_SLEEP_FRAMES) {
      animationId = requestAnimationFrame(_animate);
    } else {
      animationId = null;
    }
  }

  /** Wake the render loop if it's sleeping */
  function _scheduleFrame() {
    _needsRender = true;
    if (!animationId && renderer && !_contextLost) {   // ELE-18: don't wake the loop on a lost context
      animationId = requestAnimationFrame(_animate);
    }
  }

  /**
   * Load WebP slices into a 3D Texture
   * @param {string} basePath Base path to dataset
   * @param {Object} metadata Dataset metadata
   * @param {number} timepoint Optional timepoint to load
   * @param {function} onProgress Progress callback
   */
  async function loadVolume(basePath, metadata, timepoint = null, onProgress = null, options = {}) {
    const perfId = _perf()?.start('volume.load.slices', {
      quality: options.quality || '1024x1024',
      timepoint
    });
    if (_brickStreamAbort) _brickStreamAbort.cancelled = true;
    const loadId = ++_loadCounter;
    const quality = _normalizeQualityKey(options.quality || '1024x1024');
    _emitQualityState({ active: quality, mode: 'slice', progress: 0, message: `Loading ${quality} slices...` });
    const qualityInfo = _resolveQuality(metadata, quality);
    const { x: sourceWidth, y: sourceHeight, z: sourceDepth, c: channels } = metadata.dimensions;
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

    const scale = Math.min(1, qualityInfo.maxTextureSize / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const zIndices = qualityInfo.zIndices || _buildSampleIndices(sourceDepth, qualityInfo.maxDepthSamples);
    const depth = zIndices.length;
    const channelCount = Math.min(channels, 4);
    const isLive = metadata.type === 'live';

    const tasks = [];
    for (let zi = 0; zi < depth; zi++) {
      for (let c = 0; c < channelCount; c++) {
        tasks.push({ zi, z: zIndices[zi], c, url: _sliceUrl(basePath, qualityInfo, isLive, timepoint, zIndices[zi], c) });
      }
    }

    const texturePerfId = _perf()?.start('texture.upload.prepare', { mode: 'slice', quality, width, height, depth });
    const TextureClass = THREE.Data3DTexture || THREE.DataTexture3D;
    const rgbaData = new Uint8Array(width * height * depth * RGBA_TEXTURE_BYTES_PER_VOXEL);
    const texture3D = new TextureClass(rgbaData, width, height, depth);
    texture3D.format = THREE.RGBAFormat;
    texture3D.type = THREE.UnsignedByteType;
    texture3D.minFilter = THREE.LinearFilter;
    texture3D.magFilter = THREE.LinearFilter;
    texture3D.unpackAlignment = 1;
    const textures = [texture3D];
    _perf()?.end(texturePerfId, { status: 'ok' });

    if (Boolean(_activeVolumeEntry && _activeVolumeEntry.textures)) {
        const seeded = _seedVolumeFromActive(width, height, depth, channelCount);
        if (seeded && seeded.length === rgbaData.length) {
          rgbaData.set(seeded);
          texture3D.needsUpdate = true;
        }
    }

    // Cache mono-canal des pixels bruts (avant blur) — utilisé pour
    // le changement de sigma sans re-fetch réseau.
    // Taille par canal : width * height * depth octets.
    const rawChannelData = Array.from(
      { length: channelCount },
      () => new Uint8Array(width * height * depth)
    );

    const entry = {
      key: cacheKey,
      textures,
      texture: texture3D,
      data: rgbaData,
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
      backgroundSuppressed: true,
      successfulLoads: 0,
      failedLoads: 0,
      histograms: _channelHistograms?.length ? _channelHistograms : _computeChannelHistograms(textures, width, height, depth, channelCount)
    };
    // ELE-10 (RACE-001): a newer load (dataset / timepoint / quality switch) may
    // have bumped _loadCounter while this one was preparing. Do not publish this
    // entry (it rebinds the material uniforms + recenters the camera) on a stale load.
    if (loadId !== _loadCounter && options.cancelStale !== false) {
      _perf()?.end(perfId, { status: 'stale', quality });
      return { stale: true };
    }
    _activateVolumeEntry(entry, metadata, sourceDepth, sourceWidth, channels, { ...options, fitCamera: !_hasLoadedVolume });
    _emitQualityState({ active: quality, mode: 'slice', progress: 0, message: `Streaming ${quality} slices...` });

    let completed = 0;
    let successfulLoads = 0;
    let failedLoads = 0;
    let pendingUploads = 0;
    const runnerCount = Math.min(CONCURRENT_IMAGE_LOADS, tasks.length || 1);
    const readers = Array.from({ length: runnerCount }, () => _createSliceReader(width, height));
    await _runLimited(tasks, runnerCount, async ({ zi, c, url }, runnerIndex) => {
      try {
        const img = await _loadImage(url);
        const reader = readers[runnerIndex] || readers[0] || _createSliceReader(width, height);
        reader.ctx.clearRect(0, 0, width, height);
        reader.ctx.drawImage(img, 0, 0, width, height);
        const imgData = reader.ctx.getImageData(0, 0, width, height).data;
        const sliceSize = width * height;
        const rawOffset = zi * sliceSize;

        // Sauvegarde des pixels bruts dans le cache mono-canal
        // (extraction du canal R de l'image RGBA décodée = intensité grayscale)
        for (let i = 0; i < sliceSize; i++) {
          rawChannelData[c][rawOffset + i] = imgData[i * 4];
        }

        // Application du flou gaussien si nécessaire (au chargement initial)
        const sigma = _channelSigma[c] || 0;
        const targetData = rgbaData;
        const rgbaOffset = rawOffset * RGBA_TEXTURE_BYTES_PER_VOXEL + c;
        if (sigma > 0.1) {
          const blurBuf = new Uint8Array(sliceSize);
          blurBuf.set(rawChannelData[c].subarray(rawOffset, rawOffset + sliceSize));
          _gaussianBlurChannel(blurBuf, width, height, 0, 1, sigma);
          for (let i = 0, dst = rgbaOffset; i < sliceSize; i++, dst += RGBA_TEXTURE_BYTES_PER_VOXEL) {
            targetData[dst] = blurBuf[i];
          }
        } else {
          const rawSlice = rawChannelData[c].subarray(rawOffset, rawOffset + sliceSize);
          for (let i = 0, dst = rgbaOffset; i < sliceSize; i++, dst += RGBA_TEXTURE_BYTES_PER_VOXEL) {
            targetData[dst] = rawSlice[i];
          }
        }
        successfulLoads++;
        entry.successfulLoads = successfulLoads;
        pendingUploads++;
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
          if (completed >= tasks.length || (Date.now() - (textures[0]._lastUpdateTime || 0) > 1000)) {
            textures.forEach(t => { t.needsUpdate = true; t._lastUpdateTime = Date.now(); });
            _scheduleFrame();
            pendingUploads = 0;
          }
          if (onProgress) onProgress(completed / tasks.length, quality);
          _emitQualityState({ progress: completed / Math.max(1, tasks.length) });
        }
      }
    });

    if (loadId !== _loadCounter && options.cancelStale !== false) {
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

    textures.forEach(t => t.needsUpdate = true);
    _scheduleFrame();
    entry.backgroundSuppressed = false;
    entry.successfulLoads = successfulLoads;
    entry.failedLoads = failedLoads;
    // Defer histogram computation off the critical render path
    _deferHistogramComputation(entry, textures, width, height, depth, channelCount);
    _storeVolumeCache(cacheKey, entry);
    _activateVolumeEntry(entry, metadata, sourceDepth, sourceWidth, channels, options);
    _emitQualityState({ active: quality, mode: 'slice', progress: 1, message: `${quality} ready` });
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
      successfulLoads,
      failedLoads,
      physicalSizeUm: _physicalSizeUm,
      scaleMode: _scaleMode
    };
  }

  async function preloadVolume(basePath, metadata, timepoint = null, options = {}) {
    const quality = options.quality || '256x256';
    const qualityInfo = _resolveQuality(metadata, quality);
    const { z: sourceDepth, c: channels } = metadata.dimensions || {};
    const isLive = metadata.type === 'live';
    const zIndices = qualityInfo.zIndices || _buildSampleIndices(sourceDepth || 1, qualityInfo.maxDepthSamples);
    const tasks = [];

    for (let zi = 0; zi < zIndices.length; zi++) {
      for (let c = 0; c < Math.min(channels || 1, 4); c++) {
        tasks.push(_sliceUrl(basePath, qualityInfo, isLive, timepoint, zIndices[zi], c));
      }
    }

    const maxImages = Number.isFinite(options.maxImages) ? Math.max(1, options.maxImages) : tasks.length;
    const selected = _sampleArray(tasks, maxImages);
    let successfulLoads = 0;
    let failedLoads = 0;
    await _runLimited(selected, options.concurrency || PRELOAD_IMAGE_LOADS, async (url) => {
      try {
        await _loadImage(url);
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
    _updateCutPlaneMesh();
    _scheduleFrame();
  }

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

  function _stepsForVolumeEntry(entry) {
    const quality = _normalizeQualityKey(entry?.quality || _qualityTarget || '512x512');
    const longestAxis = Math.max(
      Number(entry?.width) || 1,
      Number(entry?.height) || 1,
      (Number(entry?.depth) || 1) * 2
    );
    if (quality === 'native' || quality === '4096x4096' || quality === '2048x2048' || quality === '1024x1024') {
      return Math.min(600, Math.max(256, Math.round(longestAxis)));
    }
    return Math.min(220, Math.max(96, Math.round(Math.max(Number(entry?.width) || 1, Number(entry?.depth) || 1))));
  }

  function _activateVolumeEntry(entry, metadata, sourceDepth, sourceWidth, channels, options = {}) {
    if (entry.svrManager) {
      if (_svrManager && _svrManager !== entry.svrManager) {
        if (!_isSvrManagerCached(_svrManager)) _svrManager.dispose();
      }
      _svrManager = entry.svrManager;
      _svrManager.material = material;
      _svrManager.updateUniforms();
    } else if (material?.defines?.ENABLE_SVR) {
      delete material.defines.ENABLE_SVR;
      material.needsUpdate = true;
      if (_svrManager) {
        if (!_isSvrManagerCached(_svrManager)) _svrManager.dispose();
        _svrManager = null;
      }
    }
    const scaleInfo = computePhysicalScale(metadata, sourceDepth, sourceWidth);
    _baseScale.set(scaleInfo.scale.x, scaleInfo.scale.y, scaleInfo.scale.z);
    _physicalSizeUm = scaleInfo.physicalSizeUm;
    _scaleMode = scaleInfo.mode;
    if (entry.histograms && entry.histograms.length) {
      const currentBins = _channelHistograms?.[0]?.bins || 0;
      const newBins = entry.histograms[0].bins || 0;
      if (newBins >= currentBins) {
        _channelHistograms = entry.histograms;
      }
    }
    _activeTextureKey = entry.key || null;
    _activeVolumeEntry = entry;
    const textures = entry.textures || [];
    _applyDisplayScale();

    material.uniforms.svrAtlas0.value = entry.texture || textures[0] || null;
    material.uniforms.svrAtlas1.value = textures[1] || textures[0] || entry.texture || null;
    material.uniforms.svrAtlas2.value = textures[2] || textures[0] || entry.texture || null;
    material.uniforms.svrAtlas3.value = textures[3] || textures[0] || entry.texture || null;
    if (entry.occupancyMap) {
      material.defines.HAS_OCCUPANCY = 1;
      material.uniforms.mapOccupancy.value = entry.occupancyMap;
    } else {
      delete material.defines.HAS_OCCUPANCY;
      if (material.uniforms.mapOccupancy) {
        material.uniforms.mapOccupancy.value = null;
      }
    }
    material.needsUpdate = true;
    material.uniforms.numChannels.value = Math.min(channels, 4);
    _targetSteps = _stepsForVolumeEntry(entry);
    material.uniforms.steps.value = _targetSteps;

    _recompileShaderForActiveChannels();

    if (!_hasLoadedVolume || options.fitCamera) {
      console.log('[VolumeViewer] fitCameraToVolume called from _activateVolumeEntry, _hasLoadedVolume was:', _hasLoadedVolume);
      fitCameraToVolume();
      _hasLoadedVolume = true;
    } else {
      console.log('[VolumeViewer] Skipping fitCameraToVolume, _hasLoadedVolume=true');
    }
  }

  function _createTransitionMaterial() {
    if (!material) return null;
    const transition = material.clone();
    transition.defines = { ...(material.defines || {}) };
    transition.uniforms = THREE.UniformsUtils ? THREE.UniformsUtils.clone(material.uniforms) : transition.uniforms;
    transition.side = THREE.BackSide;
    transition.transparent = true;
    transition.depthWrite = false;
    transition.blending = THREE.NormalBlending;
    transition.needsUpdate = true;
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
    } else if (_transitionMaterial.defines?.ENABLE_SVR) {
      delete _transitionMaterial.defines.ENABLE_SVR;
    }
    _transitionMaterial.uniforms.svrAtlas0.value = entry.texture || textures[0] || null;
    _transitionMaterial.uniforms.svrAtlas1.value = textures[1] || textures[0] || entry.texture || null;
    _transitionMaterial.uniforms.svrAtlas2.value = textures[2] || textures[0] || entry.texture || null;
    _transitionMaterial.uniforms.svrAtlas3.value = textures[3] || textures[0] || entry.texture || null;
    if (entry.occupancyMap) {
      _transitionMaterial.defines.HAS_OCCUPANCY = 1;
      _transitionMaterial.uniforms.mapOccupancy.value = entry.occupancyMap;
    } else {
      delete _transitionMaterial.defines.HAS_OCCUPANCY;
      if (_transitionMaterial.uniforms.mapOccupancy) _transitionMaterial.uniforms.mapOccupancy.value = null;
    }
    _transitionMaterial.uniforms.numChannels.value = Math.min(channels, 4);
    _transitionMaterial.uniforms.steps.value = material.uniforms.steps.value;
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

  function _sliceUrl(basePath, qualityInfo, isLive, timepoint, z, c) {
    const filename = isLive
      ? `t${String(timepoint).padStart(3, '0')}_z${String(z).padStart(3, '0')}_c${c}.webp`
      : `z${String(z).padStart(3, '0')}_c${c}.webp`;
    return `${basePath}/${qualityInfo.directory}/${filename}?v=20260605_cachebust`;
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
    _volumeCache.delete(key);
    _volumeCache.set(key, entry);
    return entry;
  }

  function _isSvrManagerCached(manager) {
    if (!manager) return false;
    for (const entry of _volumeCache.values()) {
      if (entry?.svrManager === manager) return true;
    }
    return false;
  }

  function _shouldCacheVolumeEntry(entry) {
    if (!entry?.svrManager) return true;
    const quality = _normalizeQualityKey(entry.quality || '');
    if (quality === 'native' || quality === '4096x4096') return Boolean(window.VolumeViewerDebug?.cacheNativeSvr);
    return true;
  }

  function _storeVolumeCache(key, entry) {
    if (!_shouldCacheVolumeEntry(entry)) {
      _volumeCache.delete(key);
      return;
    }
    const previous = _volumeCache.get(key);
    if (previous && previous !== entry && previous !== _activeVolumeEntry) {
      if (previous.svrManager && previous.svrManager !== _svrManager) {
        previous.svrManager.dispose();
      }
      if (Array.isArray(previous.textures)) {
        previous.textures.forEach(t => t?.dispose?.());
      }
    }
    _volumeCache.set(key, entry);
    _trimVolumeCache();
  }

  function _trimVolumeCache() {
    let guard = 0;
    while (_volumeCache.size > VOLUME_CACHE_LIMIT && guard < VOLUME_CACHE_LIMIT + 8) {
      guard++;
      const first = _volumeCache.entries().next().value;
      if (!first) break;
      const [key, entry] = first;
      if (key === _activeTextureKey) {
        _volumeCache.delete(key);
        _volumeCache.set(key, entry);
        continue;
      }
      _volumeCache.delete(key);
      if (entry.svrManager && entry.svrManager !== _svrManager) {
        entry.svrManager.dispose();
      }
      if (Array.isArray(entry.textures)) {
        entry.textures.forEach(t => t?.dispose?.());
      }
    }
  }

  function _computeChannelHistograms(textures, width, height, depth, channels, bins = 256) {
    const histograms = Array.from({ length: channels }, () => new Array(bins).fill(0));
    const voxels = width * height * depth;
    if (!textures || textures.length === 0) return histograms.map(counts => ({ bins, counts, max: 1, total: 0 }));
    const firstData = textures[0]?.image?.data;
    const isRgbaAtlas = textures.length === 1 && firstData && firstData.length >= voxels * RGBA_TEXTURE_BYTES_PER_VOXEL;
    if (isRgbaAtlas) {
      for (let i = 0; i < voxels; i++) {
        const base = i * RGBA_TEXTURE_BYTES_PER_VOXEL;
        for (let c = 0; c < channels; c++) {
          const bin = Math.min(bins - 1, Math.floor(((firstData[base + c] || 0) / 256) * bins));
          histograms[c][bin]++;
        }
      }
      return histograms.map(counts => ({
        bins,
        counts,
        max: Math.max(1, ...counts),
        total: counts.reduce((sum, value) => sum + value, 0)
      }));
    }
    // Parse all voxels for an exact, noise-free histogram
    for (let c = 0; c < channels; c++) {
      if (c >= textures.length) continue;
      const targetData = textures[c].image.data;
      if (!targetData) continue;
      for (let i = 0; i < voxels; i++) {
        const bin = Math.min(bins - 1, Math.floor((targetData[i] / 256) * bins));
        histograms[c][bin]++;
      }
    }
    return histograms.map(counts => ({
      bins,
      counts,
      max: Math.max(1, ...counts),
      total: counts.reduce((sum, value) => sum + value, 0)
    }));
  }

  /**
   * Schedule histogram computation off the critical rendering path.
   * Uses requestIdleCallback when available, falls back to setTimeout.
   */
  function _deferHistogramComputation(entry, textures, width, height, depth, channels) {
    const compute = () => {
      entry.histograms = _computeChannelHistograms(textures, width, height, depth, channels);
      if (_activeVolumeEntry === entry) {
        _channelHistograms = entry.histograms;
      }
    };
    if (window.requestIdleCallback) {
      requestIdleCallback(compute, { timeout: 800 });
    } else {
      setTimeout(compute, 50);
    }
  }

  function _sampleArray(items, maxItems) {
    if (items.length <= maxItems) return items;
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

    const result = [];
    const last = depth - 1;
    for (let i = 0; i < maxSamples; i++) {
      result.push(Math.round((i / (maxSamples - 1)) * last));
    }
    return [...new Set(result)];
  }
  
  function _loadImage(url) {
    const cached = _imageCache.get(url);
    if (cached) {
      _imageCache.delete(url);
      _imageCache.set(url, cached);
      return cached.promise;
    }

    const entry = {};
    entry.promise = _fetchImage(url)
      .then((img) => {
        entry.image = img;
        return img;
      })
      .catch((err) => {
        _imageCache.delete(url);
        throw err;
      });
    _imageCache.set(url, entry);
    _trimImageCache();
    return entry.promise;
  }

  async function _fetchImage(url) {
    const perf = _perf();
    const fetchPerfId = perf?.start('image.fetch.decode', { url });
    if (window.createImageBitmap && window.fetch) {
      try {
        const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const resp = await fetch(url, { cache: 'force-cache' });
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

  function _trimImageCache() {
    while (_imageCache.size > IMAGE_CACHE_LIMIT) {
      const first = _imageCache.entries().next().value;
      if (!first) break;
      const [key, entry] = first;
      _imageCache.delete(key);
      entry.promise?.then((img) => {
        if (img && typeof img.close === 'function') img.close();
      }).catch(() => {});
    }
  }
  /**
   * Flou gaussien 2D par canal — approximation O(n) par 3 passes de box blur.
   * Formule : sigma → 3 rayons de box via l'algorithme de Mykhailo Radzievskyi / Ivan Googolplex.
   * Fonctionne sur des données 8-bit entrelacées (RGBA etc.).
   *
   * @param {Uint8Array} pixelData  Données pixel entrelacées (modifiées in-place)
   * @param {number}     width      Largeur de l'image en pixels
   * @param {number}     height     Hauteur de l'image en pixels
   * @param {number}     channelOffset  Index du canal dans l'entrelacement (0=R, 1=G, …)
   * @param {number}     numChannels    Nombre total de canaux entrelacés (ex: 4 pour RGBA)
   * @param {number}     sigma      Écart-type du noyau gaussien (en pixels)
   */
  function _gaussianBlurChannel(pixelData, width, height, channelOffset, numChannels, sigma) {
    if (sigma <= 0.1) return;
    const boxes = _boxesForGauss(sigma, 3);
    const n = width * height;
    const src = new Float32Array(n);
    const dst = new Float32Array(n);
    // Extraction du canal depuis les données entrelacées
    for (let i = 0; i < n; i++) src[i] = pixelData[i * numChannels + channelOffset];
    // 3 passes de box blur alternées H/V
    for (const radius of boxes) {
      _boxBlurH(src, dst, width, height, radius);
      _boxBlurV(dst, src, width, height, radius);
    }
    // Réécriture du canal dans les données entrelacées
    for (let i = 0; i < n; i++) pixelData[i * numChannels + channelOffset] = Math.round(Math.max(0, Math.min(255, src[i])));
  }

  /**
   * Calcule les 3 rayons de box blur qui approximent un noyau gaussien de sigma donné.
   * Référence : http://blog.ivank.net/fastest-gaussian-blur.html
   */
  function _boxesForGauss(sigma, n) {
    const wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
    let wl = Math.floor(wIdeal);
    if (wl % 2 === 0) wl--;
    const wu = wl + 2;
    const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
    return Array.from({ length: n }, (_, i) => i < m ? (wl - 1) / 2 : (wu - 1) / 2);
  }

  /** Box blur horizontal — moyenne glissante en O(width) par ligne */
  function _boxBlurH(src, dst, w, h, r) {
    if (r < 1) { dst.set(src); return; }
    const iarr = 1.0 / (r + r + 1);
    for (let y = 0; y < h; y++) {
      let ti = y * w, li = ti, ri = ti + r;
      const fv = src[ti], lv = src[ti + w - 1];
      let val = (r + 1) * fv;
      for (let j = 0; j < r; j++) val += src[ti + j];
      for (let j = 0; j <= r; j++) { val += src[ri++] - fv; dst[ti++] = val * iarr; }
      for (let j = r + 1; j < w - r; j++) { val += src[ri++] - src[li++]; dst[ti++] = val * iarr; }
      for (let j = w - r; j < w; j++) { val += lv - src[li++]; dst[ti++] = val * iarr; }
    }
  }

  /** Box blur vertical — moyenne glissante en O(height) par colonne */
  function _boxBlurV(src, dst, w, h, r) {
    if (r < 1) { dst.set(src); return; }
    const iarr = 1.0 / (r + r + 1);
    for (let x = 0; x < w; x++) {
      let ti = x, li = ti, ri = ti + r * w;
      const fv = src[ti], lv = src[ti + w * (h - 1)];
      let val = (r + 1) * fv;
      for (let j = 0; j < r; j++) val += src[ti + j * w];
      for (let j = 0; j <= r; j++) { val += src[ri] - fv; dst[ti] = val * iarr; ri += w; ti += w; }
      for (let j = r + 1; j < h - r; j++) { val += src[ri] - src[li]; dst[ti] = val * iarr; ri += w; li += w; ti += w; }
      for (let j = h - r; j < h; j++) { val += lv - src[li]; dst[ti] = val * iarr; li += w; ti += w; }
    }
  }

  /**
   * Update channel display parameters
   */
  function updateChannel(idx, params) {
    if (idx < 0 || idx > 3) return;
    
    if (params.color) {
      // Hex to RGB [0-1]
      const r = parseInt(params.color.slice(1,3), 16) / 255;
      const g = parseInt(params.color.slice(3,5), 16) / 255;
      const b = parseInt(params.color.slice(5,7), 16) / 255;
      material.uniforms[`color${idx}`].value.set(r, g, b);
    }
    
    if (params.min !== undefined) material.uniforms[`min${idx}`].value = params.min;
    if (params.max !== undefined) material.uniforms[`max${idx}`].value = params.max;
    if (params.gamma !== undefined) material.uniforms[`gamma${idx}`].value = Math.max(0.18, Math.min(5.5, params.gamma));
    if (params.opacity !== undefined) material.uniforms[`opacity${idx}`].value = Math.max(0, Math.min(1, params.opacity));
    if (params.enabled !== undefined) {
      material.uniforms[`en${idx}`].value = params.enabled ? 1 : 0;
      _recompileShaderForActiveChannels();
    }

    // Mise à jour du sigma de débruitage – via cache + Web Worker (pas de re-fetch réseau)
    if (params.denoise_sigma !== undefined) {
      const newSigma = Math.max(0, Math.min(5, Number(params.denoise_sigma) || 0));
      const oldSigma = _channelSigma[idx] || 0;
      _channelSigma[idx] = newSigma;
      if (Math.abs(newSigma - oldSigma) > 0.05 && _activeVolumeEntry) {
        const entry = _activeVolumeEntry;
        const { width, height, depth, data: texData, channels: chCount } = entry;

        if (!texData) { console.warn(`[VolumeViewer] Denoise ch${idx}: no texData`); }
        else {
          // Construction paresseuse du cache mono-canal depuis le buffer RGBA
          // si rawChannelData est absent (cas bricks, cache ancien, etc.)
          if (!entry.rawChannelData) {
            const numCh = chCount || Math.min(4, material.uniforms.numChannels.value);
            const sliceSize = width * height;
            entry.rawChannelData = Array.from({ length: numCh }, (_, c) => {
              const buf = new Uint8Array(sliceSize * depth);
              for (let zi = 0; zi < depth; zi++) {
                const sliceOff = zi * sliceSize * 4;
                const rawOff = zi * sliceSize;
                for (let i = 0; i < sliceSize; i++) {
                  buf[rawOff + i] = texData[sliceOff + i * 4 + c];
                }
              }
              return buf;
            });
            console.log(`[VolumeViewer] Built rawChannelData from RGBA (${numCh} ch, ${entry.rawChannelData[0].length} bytes/ch)`);
          }

          const rawChannelData = entry.rawChannelData;
          if (rawChannelData[idx] && rawChannelData[idx].length > 0) {
            console.log(`[VolumeViewer] Denoise ch${idx}: σ ${oldSigma.toFixed(1)}→${newSigma.toFixed(1)}, cache=${rawChannelData[idx].length} bytes`);

            // Callback exécuté quand le blur parallèle est terminé
            const onResult = (blurredData) => {
              const sliceSize = width * height;
              for (let zi = 0; zi < depth; zi++) {
                const sliceOffset = zi * sliceSize * 4;
                const rawOffset = zi * sliceSize;
                for (let i = 0; i < sliceSize; i++) {
                  texData[sliceOffset + i * 4 + idx] = blurredData[rawOffset + i];
                }
              }
              if (entry.texture) {
                entry.texture.needsUpdate = true;
                _scheduleFrame();
              }
              console.log(`[VolumeViewer] Denoise ch${idx} σ=${newSigma} done (${blurredData.length} bytes)`);
            };

            if (newSigma <= 0.1) {
              // σ ≈ 0 : restaurer les données brutes sans blur
              onResult(rawChannelData[idx]);
            } else {
              // Dispatch parallèle via le pool de Workers
              _dispatchParallelBlur(rawChannelData[idx], width, height, depth, newSigma, onResult);
            }
          }
        }
      }
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
    // value is max percentage (0 to 1)
    const next = Math.max(0, Math.min(1, Number(value) || 0));
    if (axis === 'x') {
      clipPlanes.xMax = next;
      material.uniforms.clipMax.value.x = next;
    }
    if (axis === 'y') {
      clipPlanes.yMax = next;
      material.uniforms.clipMax.value.y = next;
    }
    if (axis === 'z') {
      clipPlanes.zMax = next;
      material.uniforms.clipMax.value.z = next;
    }
    _scheduleFrame();
  }

  /**
   * Set both min and max clipping for an axis (0.0 to 1.0)
   */
  function setClipRange(axis, min, max) {
    if (!material?.uniforms) return;
    const lo = Math.max(0, Math.min(1, Number(min) || 0));
    const hi = Math.max(lo, Math.min(1, Number(max) || 1));
    if (axis === 'x' || axis === 'all') {
      clipPlanes.xMin = axis === 'all' ? lo : lo;
      clipPlanes.xMax = axis === 'all' ? hi : hi;
      if (axis === 'x' || axis === 'all') {
        material.uniforms.clipMin.value.x = clipPlanes.xMin;
        material.uniforms.clipMax.value.x = clipPlanes.xMax;
      }
    }
    if (axis === 'y' || axis === 'all') {
      clipPlanes.yMin = axis === 'all' ? lo : lo;
      clipPlanes.yMax = axis === 'all' ? hi : hi;
      if (axis === 'y' || axis === 'all') {
        material.uniforms.clipMin.value.y = clipPlanes.yMin;
        material.uniforms.clipMax.value.y = clipPlanes.yMax;
      }
    }
    if (axis === 'z' || axis === 'all') {
      clipPlanes.zMin = lo;
      clipPlanes.zMax = hi;
      material.uniforms.clipMin.value.z = clipPlanes.zMin;
      material.uniforms.clipMax.value.z = clipPlanes.zMax;
    }
    _scheduleFrame();
  }
  
  function setView(view) {
    // Reset rotation
    cube.quaternion.identity();
    
    if (view === 'xy') {
      // Default (looking down Z)
    } else if (view === 'xz') {
      cube.rotateX(Math.PI / 2);
    } else if (view === 'yz') {
      cube.rotateY(-Math.PI / 2);
    } else if (view === '3d') {
      cube.rotateX(-Math.PI / 6);
      cube.rotateY(Math.PI / 5);
    }
    _notifyCameraChange();
  }

  function centerSample() {
    if (!cube) return;
    cube.position.set(0, 0, 0);
    _notifyCameraChange();
  }

  function resetView(options = {}) {
    if (!cube) return;
    cube.position.set(0, 0, 0);
    cube.quaternion.identity();
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
  }

  function _fitCameraDistance(margin = 1.25) {
    if (!camera || !cube || !_container) return 2.5;
    const box = new THREE.Box3().setFromObject(cube);
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

    // _rotGizmo is kept as an empty group (no rings) so existing code doesn't crash
    _rotGizmo = new THREE.Group();
    _rotGizmo.visible = false;
    scene.add(_rotGizmo);

    _updateCutPlaneMesh();
  }

  function _createMeasurementGroup() {
    if (!cube || _measurementGroup) return;
    _measurementGroup = new THREE.Group();
    _measurementGroup.renderOrder = 30;
    
    _labelsGroup = new THREE.Group();
    _labelsGroup.renderOrder = 35;

    _measurementGroup.add(_labelsGroup);
    cube.add(_measurementGroup);
  }

  /**
   * Update measurement label positions in 3D space.
   * @param {boolean} finalizeDrag - true when a drag-label interaction just ended (pointerup)
   * @param {THREE.Sprite|null} activeDraggedSprite - the sprite being dragged (null during animation loop)
   */
  function _updateMeasurementLabelPositions(finalizeDrag = false, activeDraggedSprite = null) {
    if (!_showMeasurementLabels || _measurementSprites.length === 0 || !camera || !cube) return;
    try {
      // Camera basis vectors in world space
      const camRight = new THREE.Vector3();
      const camUp = new THREE.Vector3();
      camera.getWorldDirection(new THREE.Vector3());
      camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      camUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();

      const cubeCenter = new THREE.Vector3();
      cube.getWorldPosition(cubeCenter);

      // 1. Calculate target positions (before overlap resolution)
      const items = _measurementSprites.map(sprite => {
        const anchorLocal = (sprite.userData.anchorLocal || sprite.userData.anchor).clone();
        const anchorWorld = anchorLocal.applyMatrix4(cube.matrixWorld);

        const toLabel = anchorWorld.clone().sub(cubeCenter).normalize();
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
        const offset = camRight.clone().multiplyScalar(dirX * pushDistance + (-dirY) * customT)
          .add(camUp.clone().multiplyScalar(dirY * pushDistance + dirX * customT));
        const finalWorld = anchorWorld.clone().add(offset);

        return { sprite, finalWorld, dirX, dirY };
      });

      // 2. Calculate visual centers and effective repulsion radii
      items.forEach(item => {
        const w = item.sprite.scale.x;
        const h = item.sprite.scale.y;
        const cx = 0.5 - item.sprite.center.x;
        const cy = 0.5 - item.sprite.center.y;
        item.visualCenter = item.finalWorld.clone()
          .add(camRight.clone().multiplyScalar(cx * w))
          .add(camUp.clone().multiplyScalar(cy * h));
        item.radius = Math.max(w, h) * 0.55;

        // activeDraggedSprite is passed explicitly — no closure dependency needed
        const isBeingDragged = (activeDraggedSprite != null && activeDraggedSprite === item.sprite);
        const customRadius = item.sprite.userData.measurement?.labelOffset?.customRadius;
        item.effectiveRadius = isBeingDragged ? 0 : (customRadius !== undefined ? customRadius : item.radius);
      });

      // Helper: compute visual center of an item from its current finalWorld
      const _vc = (item) => {
        const s = item.sprite;
        return item.finalWorld.clone()
          .add(camRight.clone().multiplyScalar((0.5 - s.center.x) * s.scale.x))
          .add(camUp.clone().multiplyScalar((0.5 - s.center.y) * s.scale.y));
      };

      // 3. Finalize drag: bake current positions into customRadius for the dropped
      //    label AND all nearby labels so nothing snaps on the next render frame.
      if (finalizeDrag && activeDraggedSprite) {
        const dropped = items.find(it => it.sprite === activeDraggedSprite);
        if (dropped) {
          const droppedVC = _vc(dropped);

          items.forEach(other => {
            if (other === dropped) return;
            const otherVC = _vc(other);
            const dist2D = Math.sqrt(
              Math.pow(droppedVC.dot(camRight) - otherVC.dot(camRight), 2) +
              Math.pow(droppedVC.dot(camUp)    - otherVC.dot(camUp),    2)
            );
            const om = other.sprite.userData.measurement;
            if (!om.labelOffset) om.labelOffset = { r: 0, t: 0 };
            const otherNaturalR = other.radius;
            const otherCurrentR = om.labelOffset.customRadius ?? otherNaturalR;
            // If the dropped label is now closer than other's repulsion radius,
            // shrink other's customRadius to accept this closeness
            if (dist2D < otherCurrentR) {
              om.labelOffset.customRadius = Math.max(0, dist2D * 0.45);
              other.effectiveRadius = om.labelOffset.customRadius;
            }
          });

          // Dropped label: customRadius = min gap to any other label's edge
          let minR = dropped.radius;
          items.forEach(other => {
            if (other === dropped) return;
            const dist2D = Math.sqrt(
              Math.pow(droppedVC.dot(camRight) - _vc(other).dot(camRight), 2) +
              Math.pow(droppedVC.dot(camUp)    - _vc(other).dot(camUp),    2)
            );
            minR = Math.min(minR, Math.max(0, dist2D - other.effectiveRadius));
          });
          const dm = dropped.sprite.userData.measurement;
          if (!dm.labelOffset) dm.labelOffset = { r: 0, t: 0 };
          dm.labelOffset.customRadius = minR;
          dropped.effectiveRadius = minR;

          window.dispatchEvent(new CustomEvent('volume-measurement-drag', {
            detail: { id: dropped.sprite.userData.id, labelOffset: dm.labelOffset }
          }));
        }
      }

      // 4. Resolve overlaps via camera-plane repulsion
      //    - Recompute visual centers each iteration from the updated finalWorld
      //    - Skip ALL pairs involving the dragged sprite: user controls its position
      if (items.length > 1) {
        for (let iter = 0; iter < 8; iter++) {
          let anyOverlap = false;
          for (let i = 0; i < items.length; i++) {
            for (let j = i + 1; j < items.length; j++) {
              const si = items[i].sprite, sj = items[j].sprite;

              // Completely skip any pair involving the dragged sprite during drag
              if (activeDraggedSprite != null &&
                  (activeDraggedSprite === si || activeDraggedSprite === sj)) continue;

              const minDist = items[i].effectiveRadius + items[j].effectiveRadius;
              if (minDist <= 0) continue;

              // Recompute visual centers from CURRENT finalWorld each iteration
              const vi = _vc(items[i]);
              const vj = _vc(items[j]);
              const dx = vi.dot(camRight) - vj.dot(camRight);
              const dy = vi.dot(camUp)    - vj.dot(camUp);
              const distSq = dx * dx + dy * dy;

              if (distSq < minDist * minDist && distSq > 1e-8) {
                anyOverlap = true;
                const dist = Math.sqrt(distSq);
                const overlap = minDist - dist;
                const pushX = (dx / dist) * overlap * 0.5;
                const pushY = (dy / dist) * overlap * 0.5;
                const pushVec = camRight.clone().multiplyScalar(pushX)
                  .add(camUp.clone().multiplyScalar(pushY));
                items[i].finalWorld.add(pushVec);
                items[j].finalWorld.sub(pushVec);
              }
            }
          }
          if (!anyOverlap) break;
        }
      }

      // 5. Apply final positions back to sprites
      items.forEach(item => {
        const finalLocal = item.finalWorld.clone();
        cube.worldToLocal(finalLocal);
        item.sprite.position.copy(finalLocal);
      });
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
    _measurementTextSize = size;
    _renderMeasurements();
  }

  function _createMeasurementTextSprite(text, colorHex, anchorPoint) {
    if (!text || text.trim() === '') return null;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    const fontSize = _measurementTextSize;
    ctx.font = `bold ${fontSize}px sans-serif`;
    
    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;
    const pad = fontSize * 0.4;
    
    canvas.width = textWidth + pad * 2;
    canvas.height = fontSize + pad * 2;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    
    ctx.lineWidth = Math.max(2, fontSize * 0.12);
    ctx.strokeStyle = '#000000';
    ctx.strokeText(text, canvas.width/2, canvas.height/2);
    
    ctx.fillStyle = colorHex;
    ctx.fillText(text, canvas.width/2, canvas.height/2);
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    
    const material = new THREE.SpriteMaterial({ 
      map: texture, 
      depthTest: false, 
      transparent: true 
    });
    
    const sprite = new THREE.Sprite(material);
    // Inverse scale the sprite so the apparent size matches the requested size.
    // Base scale is calculated at a standard resolution (e.g. 48px).
    const scale = (0.0015 / 48) * fontSize;
    sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);
    
    // The anchor in cube-local space is needed for position calculations
    sprite.userData = { isMeasurementLabel: true, anchorLocal: anchorPoint.clone(), anchor: anchorPoint.clone() };
    
    return sprite;
  }

  function _renderMeasurements() {
    if (!_measurementGroup) return;
    
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
        // Find extremity furthest from origin (which is 0,0,0 in local space)
        const aDist = a.lengthSq();
        const bDist = b.lengthSq();
        const anchorLocal = aDist > bDist ? a.clone() : b.clone();
        
        const labelText = item.label ? `${item.label}: ` : '';
        const text = `${labelText}${item.distance.toFixed(1)} µm`;
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

  function _pointLocal(point) {
    const normalized = point?.normalized || point;
    if (!normalized || !Number.isFinite(normalized.x) || !Number.isFinite(normalized.y) || !Number.isFinite(normalized.z)) return null;
    return new THREE.Vector3(
      normalized.x - 0.5,
      normalized.y - 0.5,
      normalized.z - 0.5
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
      pixelsPerUnit: axisLength
    };
  }

  function _updatePlaneDrag(state, clientX, clientY) {
    if (!state) return;
    const deltaX = clientX - state.startClientX;
    const deltaY = clientY - state.startClientY;
    const travel = (deltaX * state.axisX) + (deltaY * state.axisY);
    const next = state.startValue + (travel / Math.max(8, state.pixelsPerUnit));
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

  function _intersectGizmo(clientX, clientY) {
    if (!_raycaster || !_pointer || !camera || !_rotGizmo || !renderer) return null;
    if (!_rotGizmo.visible) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    _pointer.x = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    _pointer.y = -(((clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
    _raycaster.setFromCamera(_pointer, camera);
    const hits = _raycaster.intersectObject(_rotGizmo, true);
    const gizmoHit = hits.find(hit => hit.object.userData.axis);
    return gizmoHit || null;
  }

  function _intersectInteractionHandles(clientX, clientY) {
    if (!camera || !renderer) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, camera);
    const intersectables = [];
    const _vgAxesGroup = typeof VolumeGrid !== 'undefined' ? VolumeGrid.getAxesGroup() : null;
    const _vgGridGroup = typeof VolumeGrid !== 'undefined' ? VolumeGrid.getGridGroup() : null;
    if ((typeof VolumeGrid !== 'undefined' && VolumeGrid.isAxesVisible()) && _vgAxesGroup) {
      _vgAxesGroup.children.forEach(c => { if (c.userData && c.userData.isAxesSphere) intersectables.push(c); });
    }
    if ((typeof VolumeGrid !== 'undefined' && VolumeGrid.getGridMode() > 0) && _vgGridGroup) {
      _vgGridGroup.children.forEach(c => { if (c.userData && c.userData.isGridHandle && c.material.opacity > 0) intersectables.push(c); });
    }
    const hits = raycaster.intersectObjects(intersectables);
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

    // Local position along normal, scaled by cube dimensions
    const localPos = localNormal.clone().multiplyScalar(_planeSpec.value - 0.5);
    localPos.multiply(cube.scale);

    // Cube's world rotation (from orbit controls)
    const cubeRot = cube.quaternion;

    // World orientation = cubeRotation * localOrientation
    _cutPlaneMesh.quaternion.copy(cubeRot).multiply(localOrientation);

    // World position = cubeRotation * (localPos) + cube.position
    const worldPos = localPos.applyQuaternion(cubeRot).add(cube.position);
    _cutPlaneMesh.position.copy(worldPos);

    // Scale: use the cube's max axis so the plane covers the volume
    const s = _planeSpec.mode === 'oblique' ? 1.45 : 1.04;
    const maxScale = Math.max(cube.scale.x, cube.scale.y, cube.scale.z);
    _cutPlaneMesh.scale.set(s * maxScale, s * maxScale, 1);
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
    if (Array.isArray(spec.orientation) && spec.orientation.length === 4) {
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
      return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), _normalForPlaneSpec(spec));
    }
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(
      -_finiteNumber(spec.pitch, 0) * Math.PI / 180,
      -_finiteNumber(spec.yaw, 0) * Math.PI / 180,
      _finiteNumber(spec.roll, 0) * Math.PI / 180,
      'YXZ'
    ));
  }

  function _applyOrientationToSpec(spec, orientation) {
    const q = new THREE.Quaternion().fromArray(orientation).normalize();
    const euler = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
    spec.mode = 'oblique';
    spec.yaw = THREE.MathUtils.radToDeg(Math.atan2(normal.x, normal.z));
    spec.pitch = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(normal.y, -1, 1)));
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
    if (_planeSpec.mode === 'yz') {
      setPlaneSpec({ value: point.normalized.x, visible: options.visible ?? true });
      return;
    }
    if (_planeSpec.mode === 'xz') {
      setPlaneSpec({ value: point.normalized.y, visible: options.visible ?? true });
      return;
    }
    if (_planeSpec.mode === 'oblique') {
      const normal = _normalForPlaneSpec(_planeSpec);
      const local = new THREE.Vector3(
        point.normalized.x - 0.5,
        point.normalized.y - 0.5,
        point.normalized.z - 0.5
      );
      const alongNormal = THREE.MathUtils.clamp(local.dot(normal) + 0.5, 0, 1);
      setPlaneSpec({ value: alongNormal, visible: options.visible ?? true });
      return;
    }
    setPlaneSpec({ value: point.normalized.z, visible: options.visible ?? true });
  }

  function pickVolumePoint(clientX, clientY) {
    if (!_raycaster || !_pointer || !camera || !cube || !renderer) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    _pointer.x = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    _pointer.y = -(((clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
    _raycaster.setFromCamera(_pointer, camera);
    _raycaster.setFromCamera(_pointer, camera);
    
    let local = null;
    let isProj = false;
    
    // First check projections
    const _vgGridGrp = typeof VolumeGrid !== 'undefined' ? VolumeGrid.getGridGroup() : null;
    if (_vgGridGrp) {
       const projMeshes = [];
       _vgGridGrp.traverse(c => { if (c.isMesh && (c.userData.isProjSurface || c.userData.isProjMesh)) projMeshes.push(c); });
       if (projMeshes.length > 0) {
          const hits = _raycaster.intersectObjects(projMeshes, false);
          if (hits.length > 0) {
             local = hits[0].point.clone().applyMatrix4(new THREE.Matrix4().copy(cube.matrixWorld).invert());
             isProj = true;
          }
       }
    }
    
    // If no projection hit, fallback to volume
    if (!local && material && material.visible) {
      const localRay = _raycaster.ray.clone().applyMatrix4(new THREE.Matrix4().copy(cube.matrixWorld).invert());
      local = _pickSurfaceOnRay(localRay)
        || localRay.intersectBox(
          new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)),
          new THREE.Vector3()
        );
    }

    const hit = Boolean(local);
    if (!hit) return null;

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
      screen: { x: clientX - rect.left, y: clientY - rect.top }
    };
  }

  function _pickSurfaceOnRay(localRay) {
    const entry = _activeVolumeEntry;
    if (!entry?.data || !entry.width || !entry.height || !entry.depth) return null;
    const range = _rayBoxRange(localRay.origin, localRay.direction);
    if (!range) return null;
    const threshold = _surfaceThreshold(entry);
    const steps = Math.max(128, Math.min(620, Math.round(Math.max(entry.width, entry.height, entry.depth) * 1.8)));
    const samples = [];
    for (let i = 0; i <= steps; i++) {
      const t = range.tMin + (i / Math.max(1, steps)) * (range.tMax - range.tMin);
      const p = localRay.origin.clone().addScaledVector(localRay.direction, t);
      const norm = { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 };
      const inside = norm.x >= 0 && norm.x <= 1 && norm.y >= 0 && norm.y <= 1 && norm.z >= 0 && norm.z <= 1;
      if (!inside) continue;
      const value = _sampleActiveIntensity(entry, norm.x, norm.y, norm.z);
      samples.push({ t, point: p, value });
    }
    if (!samples.length) return null;
    const smooth = samples.map((_, idx) => {
      const a = samples[Math.max(0, idx - 1)].value;
      const b = samples[idx].value;
      const c = samples[Math.min(samples.length - 1, idx + 1)].value;
      return (a + b + c) / 3;
    });
    let maxValue = 0;
    let maxIdx = 0;
    for (let i = 0; i < smooth.length; i++) {
      if (smooth[i] > maxValue) {
        maxValue = smooth[i];
        maxIdx = i;
      }
    }
    if (maxValue < threshold) return null;
    const surfaceTarget = Math.max(threshold, maxValue * 0.55);
    let surfaceIdx = maxIdx;
    for (let i = 0; i <= maxIdx; i++) {
      if (smooth[i] >= surfaceTarget) {
        surfaceIdx = i;
        break;
      }
    }
    const refineStart = Math.max(0, surfaceIdx - 2);
    const refineEnd = Math.min(samples.length - 1, surfaceIdx + 2);
    let bestIdx = surfaceIdx;
    for (let i = refineStart; i <= refineEnd; i++) {
      if (samples[i].value > samples[bestIdx].value) bestIdx = i;
    }
    return samples[bestIdx].point;
  }

  function _rayBoxRange(origin, direction) {
    const min = -0.5;
    const max = 0.5;
    let tMin = -Infinity;
    let tMax = Infinity;
    for (const axis of ['x', 'y', 'z']) {
      const o = origin[axis];
      const d = direction[axis];
      if (Math.abs(d) < 1e-8) {
        if (o < min || o > max) return null;
        continue;
      }
      const t0 = (min - o) / d;
      const t1 = (max - o) / d;
      tMin = Math.max(tMin, Math.min(t0, t1));
      tMax = Math.min(tMax, Math.max(t0, t1));
      if (tMax < tMin) return null;
    }
    return {
      tMin: Math.max(0, tMin),
      tMax
    };
  }

  function _sampleActiveIntensity(entry, x, y, z) {
    const px = Math.max(0, Math.min(entry.width - 1, x * Math.max(1, entry.width - 1)));
    const py = Math.max(0, Math.min(entry.height - 1, y * Math.max(1, entry.height - 1)));
    const pz = Math.max(0, Math.min(entry.depth - 1, z * Math.max(1, entry.depth - 1)));
    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const z0 = Math.floor(pz);
    const x1 = Math.min(entry.width - 1, x0 + 1);
    const y1 = Math.min(entry.height - 1, y0 + 1);
    const z1 = Math.min(entry.depth - 1, z0 + 1);
    const tx = px - x0;
    const ty = py - y0;
    const tz = pz - z0;
    let intensity = 0;
    for (const dz of [0, 1]) {
      for (const dy of [0, 1]) {
        for (const dx of [0, 1]) {
          const xi = dx ? x1 : x0;
          const yi = dy ? y1 : y0;
          const zi = dz ? z1 : z0;
          const wx = dx ? tx : 1 - tx;
          const wy = dy ? ty : 1 - ty;
          const wz = dz ? tz : 1 - tz;
          const idx = ((zi * entry.height + yi) * entry.width + xi) * 4;
          const value = Math.max(
            entry.data[idx] || 0,
            entry.data[idx + 1] || 0,
            entry.data[idx + 2] || 0,
            entry.data[idx + 3] || 0
          );
          intensity += value * wx * wy * wz;
        }
      }
    }
    return intensity;
  }

  function _surfaceThreshold(entry) {
    const hist = _channelHistograms || [];
    if (!hist.length) return 14;
    const thresholds = hist.map(channelHist => {
      const counts = channelHist?.counts || [];
      const total = Math.max(1, channelHist?.total || 0);
      const target = total * 0.2;
      let acc = 0;
      let bin = 0;
      for (let i = 0; i < counts.length; i++) {
        acc += counts[i];
        if (acc >= target) {
          bin = i;
          break;
        }
      }
      return Math.max(10, Math.round((bin / Math.max(1, counts.length - 1)) * 255));
    });
    return Math.max(12, Math.min(64, Math.min(...thresholds)));
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
    return {
      images: _imageCache.size,
      volumes: _volumeCache.size,
      activeTextureKey: _activeTextureKey
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
    
    console.log('[VolumeViewer] setCameraState called', { cameraZ: state.cameraZ, quaternion: state.quaternion, position: state.position, _hasLoadedVolume });
    // Prevent default fitCameraToVolume from overwriting this restored state
    _hasLoadedVolume = true;
    if (Number.isFinite(state.cameraZ)) camera.position.z = state.cameraZ;
    if (Number.isFinite(state.zDisplayScale)) {
      setZDisplayScale(state.zDisplayScale, { notify: false });
    }
    if (Array.isArray(state.quaternion) && state.quaternion.length === 4) {
      cube.quaternion.fromArray(state.quaternion);
    }
    if (Array.isArray(state.position) && state.position.length === 3) {
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
    _qualityState = { ..._qualityState, ...patch };
    _qualityListeners.forEach(callback => callback({ ..._qualityState }));
  }

  // --- Grid and Axes (delegated to VolumeGrid module) ---

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
      onDirty: _scheduleFrame
    });
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
   * Switch render mode: 0 = DVR (depth/structure), 1 = Emission (Imaris-like fluorescence)
   */
  function setRenderMode(mode) {
    if (!material?.uniforms) return;
    material.uniforms.renderMode.value = (mode === 0 || mode === 'dvr') ? 0 : 1;
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

  function getMaterial() {
    return material;
  }

  return {
    init,
    loadVolume,
    preloadVolume,
    updateChannel,
    setClip,
    setClipRange,
    setRotationLocked: (locked) => { _rotationLocked = !!locked; },
    setView,
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
    setExposure,
    getRenderer: () => renderer,
    getMaterial: () => material,
    makeRgbaBrickFromScalarChannels: _composeRgbaBrickFromScalarChannels,
    applyRgbaBrickLuts: _applyRgbaBrickLuts,
    floorLutsFromManifest: (manifest, channels, histograms = null) => _floorLuts(_floorsFromManifest(manifest, channels, histograms), channels),
    getScene: () => scene,
    getCamera: () => camera,
    triggerRender: _scheduleFrame,
    setOnPostRender: (cb) => { _onPostRender = cb; },
    loadBrickedVolumeStream,
    isBrickReady: () => typeof BrickLoader !== 'undefined' && BrickLoader.isReady(),
    recompileShaderForActiveChannels: _recompileShaderForActiveChannels
  };

  async function loadBrickedVolumeStream(basePath, metadata, timepoint = null, onProgress = null, options = {}) {
    if (_brickStreamAbort) _brickStreamAbort.cancelled = true;
    _clearTransitionVolume();
    window._loggedWriteBrick = 0;
    _dirtyRegions = [];
    if (options.qualityMode) {
      _currentQualityMode = options.qualityMode;
    } else if (options.quality) {
      if (options.quality === '256x256' || options.quality === '512x512' || options.quality === '1024x1024' || options.quality === 'native') {
        _currentQualityMode = options.quality;
      }
    }
    _isStreamingBricks = true;
    try {
      const quality = _normalizeQualityKey(options.quality || '1024x1024');
      const deferActivation = Boolean(options.deferActivation && _activeVolumeEntry && (_activeVolumeEntry.textures || _activeVolumeEntry.data));
      const perfId = _perf()?.start('volume.load.bricks', {
      quality,
      timepoint
    });
    if (typeof BrickLoader === 'undefined') {
      _perf()?.end(perfId, { status: 'unavailable', reason: 'BrickLoader unavailable' });
      return { available: false, reason: 'BrickLoader unavailable' };
    }
    _qualityTarget = quality;
    const cacheKey = _volumeCacheKey(basePath, quality, timepoint);
    const cached = options.ignoreVolumeCache ? null : _getCachedVolume(cacheKey);
    if (cached) {
      _activateVolumeEntry(cached, metadata, cached.sourceDepth, cached.sourceWidth, cached.channels, options);
      _emitQualityState({ active: quality, mode: 'bricks', progress: 1, message: `${quality} ready from cache` });
      onProgress?.(1, quality);
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
        available: true,
        quality,
        width: cached.width,
        height: cached.height,
        depth: cached.depth,
        successfulLoads: cached.successfulLoads || 0,
        failedLoads: 0,
        fromCache: true,
        physicalSizeUm: _physicalSizeUm,
        scaleMode: _scaleMode,
        streamMode: 'bricks',
        manifest: cached.manifest
      };
    }
    const loadId = ++_loadCounter;
    const brickDir = metadata?.qualities?.native?.directory || 'bricks';
    const manifestUrl = `${basePath}/${brickDir}/manifest.json?t=${Date.now()}`;
    let manifest;
    try {
      const resp = await fetch(manifestUrl, { cache: 'no-cache' });
      if (!resp.ok) {
        _perf()?.end(perfId, {
          status: 'unavailable',
          quality,
          reason: `No brick manifest (${resp.status})`
        });
        return { available: false, reason: `No brick manifest (${resp.status})` };
      }
      manifest = await resp.json();
    } catch (err) {
      _perf()?.end(perfId, {
        status: 'unavailable',
        quality,
        reason: err.message || String(err)
      });
      return { available: false, reason: err.message || String(err) };
    }

    const tpSelection = _selectBrickManifestForTimepoint(manifest, timepoint);
    if (!tpSelection.available) {
      _perf()?.end(perfId, {
        status: 'unavailable',
        quality,
        reason: tpSelection.reason
      });
      return { available: false, reason: tpSelection.reason };
    }
    BrickLoader.configure?.({
      concurrentLoads: options.concurrency || _brickConcurrencyForQuality(quality),
      verifyHashes: Boolean(options.verifyHashes ?? window.IRIBHM_VERIFY_BRICK_HASHES)
    });
    try {
      BrickLoader.init(`${basePath}/${brickDir}${tpSelection.subPath ? `/${tpSelection.subPath}` : ''}`, tpSelection.manifest);
    } catch (err) {
      // ELE-21: a rejected (malformed) manifest degrades to the {available:false}
      // contract (Rule 1.1/1.4) instead of an opaque throw.
      console.error('[VolumeViewer] Brick manifest rejected:', err);
      _perf()?.event('volume.bricks.manifest_rejected', { quality, reason: err.message });
      return { available: false, reason: err.message };
    }
    _brickStreamAbort = { cancelled: false, loadId };
    const abortRef = _brickStreamAbort;
    const levelCount = tpSelection.manifest.levels ? (Array.isArray(tpSelection.manifest.levels) ? tpSelection.manifest.levels.length : Object.keys(tpSelection.manifest.levels).length) : 1;
    let lod = _lodForQuality(quality, levelCount, tpSelection.manifest.levels);
    let dims = BrickLoader.getDimensions(lod);
    
    const maxTextureSize = renderer?.capabilities?.max3DTextureSize || 2048;
    
    let textures = [];
    let texture3D = null;
    let rgbaData = null;
    let streamSvrManager = null;
    let allocated = false;
    let width, height, depth;
    const channels = Math.min(4, dims.channels || 1);
    const minNorm = { x: 0, y: 0, z: 0 };
    const maxNorm = { x: 0.9999, y: 0.9999, z: 0.9999 };
    let allBricks = [];

    while (!allocated && dims && lod < levelCount) {
      const lodBeforeCapacityCheck = lod;
      width = dims.x;
      height = dims.y;
      depth = dims.z;
      const rgbaByteLength = width * height * depth * RGBA_TEXTURE_BYTES_PER_VOXEL;
      const useSVR = (
        dims.x > maxTextureSize ||
        dims.y > maxTextureSize ||
        dims.z > maxTextureSize ||
        rgbaByteLength >= MONOLITHIC_RGBA_LIMIT_BYTES
      );
      const SVRClass = useSVR
        ? (window.SVRManager || (typeof SVRManager !== 'undefined' ? SVRManager : null))
        : null;
      allBricks = BrickLoader.bricksForRegion(minNorm, maxNorm, lod);
      const MAX_ALLOWED_BRICKS = SVRClass ? SVRClass.estimateMaxSlots(renderer) : 4096;

      let activeBricksCount = allBricks.filter(brick => 
        BrickLoader.hasBrick(brick.bx, brick.by, brick.bz, lod)
      ).length;

      while (activeBricksCount > MAX_ALLOWED_BRICKS && lod < levelCount - 1) {
        console.warn(`[VolumeViewer] LOD${lod} brick set (${activeBricksCount} active out of ${allBricks.length}) exceeds capacity (${MAX_ALLOWED_BRICKS}); downgrading to LOD${lod + 1}.`);
        lod++;
        dims = BrickLoader.getDimensions(lod);
        allBricks = BrickLoader.bricksForRegion(minNorm, maxNorm, lod);
        activeBricksCount = allBricks.filter(brick => 
          BrickLoader.hasBrick(brick.bx, brick.by, brick.bz, lod)
        ).length;
      }
      if (lod !== lodBeforeCapacityCheck) continue;

      try {
        const texturePerfId = _perf()?.start('texture.upload.prepare', { mode: 'bricks', quality, width, height, depth });
        
        if (useSVR) {
          // Use SVR
          if (!SVRClass) throw new Error('SVRManager unavailable: js/core/svr-manager.js must be loaded before volume-viewer.js');
          if (!deferActivation && _svrManager) {
            if (!_isSvrManagerCached(_svrManager)) _svrManager.dispose();
            _svrManager = null;
          }
          streamSvrManager = new SVRClass();
          if (!deferActivation) _svrManager = streamSvrManager;
          const svrMaterial = deferActivation
            ? (_transitionMaterial || _beginTransitionVolume(null, channels))
            : material;
          streamSvrManager.init(channels, dims, renderer, svrMaterial, { targetSlots: activeBricksCount });
          const currentActiveCount = allBricks.filter(brick => 
            BrickLoader.hasBrick(brick.bx, brick.by, brick.bz, lod)
          ).length;
          if (currentActiveCount > streamSvrManager.maxSlots && lod < levelCount - 1) {
            console.warn(`[VolumeViewer] LOD${lod} brick set (${currentActiveCount} active) exceeds allocated SVR capacity (${streamSvrManager.maxSlots}); downgrading to LOD${lod + 1}.`);
            streamSvrManager.dispose();
            if (streamSvrManager === _svrManager) _svrManager = null;
            streamSvrManager = null;
            lod++;
            dims = BrickLoader.getDimensions(lod);
            continue;
          }
          textures = streamSvrManager.atlases;
          texture3D = textures[0] || null;
          rgbaData = null;
        } else {
          // Use Monolithic
          if (material && material.defines.ENABLE_SVR) {
            delete material.defines.ENABLE_SVR;
            material.needsUpdate = true;
          }
          if (_svrManager) {
            if (!_isSvrManagerCached(_svrManager)) _svrManager.dispose();
            _svrManager = null;
          }
          const TextureClass = THREE.Data3DTexture || THREE.DataTexture3D;
          rgbaData = new Uint8Array(rgbaByteLength);
          texture3D = new TextureClass(rgbaData, width, height, depth);
          texture3D.format = THREE.RGBAFormat;
          texture3D.type = THREE.UnsignedByteType;
          texture3D.minFilter = THREE.LinearFilter;
          texture3D.magFilter = THREE.LinearFilter;
          texture3D.unpackAlignment = 1;
          texture3D.needsUpdate = true;
          if (renderer) {
              const t0 = performance.now();
              renderer.initTexture(texture3D);
              const t1 = performance.now();
              console.log(`[PERF-INIT] RGBA volume allocated in ${(t1-t0).toFixed(2)}ms (${Math.round(rgbaByteLength / 1024 / 1024)} MiB)`);
              const properties = renderer.properties.get(texture3D);
              const webglTexture = properties?.__webglTexture;
              if (webglTexture) {
                  properties.__webglInit = true;
                  properties.__version = texture3D.version;
              }
          }
          texture3D.needsUpdate = false; // Prevent Three.js from attempting full texture upload
          textures.push(texture3D);
        }
        _perf()?.end(texturePerfId, { status: 'ok' });
        allocated = true;
      } catch (err) {
        textures = []; // Free whatever was allocated
        if (streamSvrManager && streamSvrManager !== _svrManager) {
          streamSvrManager.dispose();
          streamSvrManager = null;
        }
        if (_svrManager && streamSvrManager === _svrManager) {
          if (!_isSvrManagerCached(_svrManager)) _svrManager.dispose();
          _svrManager = null;
          streamSvrManager = null;
        }
        console.warn(`[VolumeViewer] Texture allocation failed for LOD${lod} (${width}x${height}x${depth}). Downgrading...`, err);
        lod++;
        dims = BrickLoader.getDimensions(lod);
      }
    }

    if (!allocated || !dims) {
      _perf()?.end(perfId, {
        status: 'unavailable',
        quality,
        reason: 'Out of memory or invalid dimensions'
      });
      return { available: false, reason: 'Insufficient memory for all resolutions' };
    }
    
    const streamBricks = allBricks.filter(brick => BrickLoader.hasBrick(brick.bx, brick.by, brick.bz, lod));
    const orderedBricks = _orderBricksForStreaming(streamBricks, dims);
    console.log(`[VolumeViewer] Streaming LOD${lod}: ${orderedBricks.length} active bricks out of ${allBricks.length} logical bricks.`);
    
    let occTex = null;
    if (tpSelection.manifest?.levels?.[lod]) {
      const grid = tpSelection.manifest.levels[lod].gridSize;
      if (grid) {
        const occNx = grid.x || 1;
        const occNy = grid.y || 1;
        const occNz = grid.z || 1;
        const occData = new Uint8Array(occNx * occNy * occNz);
        for (const b of orderedBricks) {
           if (b.bx < occNx && b.by < occNy && b.bz < occNz) {
             occData[b.bz * occNx * occNy + b.by * occNx + b.bx] = 255;
           }
        }
        const TextureClass = THREE.Data3DTexture || THREE.DataTexture3D;
        occTex = new TextureClass(occData, occNx, occNy, occNz);
        occTex.format = THREE.RedFormat;
        occTex.type = THREE.UnsignedByteType;
        occTex.minFilter = THREE.NearestFilter;
        occTex.magFilter = THREE.NearestFilter;
        occTex.unpackAlignment = 1;
        occTex.needsUpdate = true;
      }
    }

    const totalOps = Math.max(1, orderedBricks.length * channels);
    let doneOps = 0;
    const floors = _floorsFromManifest(tpSelection.manifest, channels, tpSelection.histograms);
    const floorLuts = _floorLuts(floors, channels);
    const manifestHistograms = _manifestHistograms(tpSelection.histograms, channels);
    _emitQualityState({
      target: _qualityTarget,
      active: quality,
      mode: 'bricks',
      progress: 0,
      message: `Streaming ${quality} bricks...`
    });
    if (onProgress) onProgress(0, quality);
    await _yieldToPaint();
    
    const streamEntry = {
      key: cacheKey,
      textures: textures,
      texture: texture3D || textures[0] || null,
      data: rgbaData,
      occupancyMap: occTex,
      width,
      height,
      depth,
      sourceWidth: Number(metadata.dimensions?.x) || width,
      sourceHeight: Number(metadata.dimensions?.y) || height,
      sourceDepth: Number(metadata.dimensions?.z) || depth,
      channels,
      zIndices: Array.from({ length: depth }, (_, idx) => idx),
      basePath,
      timepoint,
      quality,
      successfulLoads: 0,
      failedLoads: 0,
      svrManager: streamSvrManager || null,
      manifest: tpSelection.manifest,
      histograms: manifestHistograms.length
        ? manifestHistograms
        : (_channelHistograms?.length ? _channelHistograms : [])
    };

    if (deferActivation) {
      if (!_transitionMaterial) _beginTransitionVolume(null, channels);
      _bindTransitionEntry(streamEntry, channels);
    }

    if (Boolean(_activeVolumeEntry && _activeVolumeEntry.textures) && textures.length > 1) {
      _emitQualityState({
        target: _qualityTarget,
        active: quality,
        mode: 'bricks',
        progress: 0,
        message: `Initializing ${quality}...`
      });
      await new Promise(resolve => {
        _seedTexturesFromActiveAsync(textures, width, height, depth, channels, loadId, abortRef, resolve);
      });
    }

    if (!deferActivation) {
      _activateVolumeEntry(streamEntry, metadata, streamEntry.sourceDepth, streamEntry.sourceWidth, channels, { ...options, fitCamera: !_hasLoadedVolume });
    }
    const rgbaBrickTransport = BrickLoader.getTransportEncoding?.() === 'raw-rgba-gzip';
    const streamTasks = [];
    if (rgbaBrickTransport) {
      for (const brick of orderedBricks) {
        streamTasks.push({ ...brick, channel: -1, lod });
      }
    } else {
      for (const brick of orderedBricks) {
        for (let c = 0; c < channels; c++) {
          streamTasks.push({ ...brick, channel: c, lod });
        }
      }
    }
    const effectiveTotalOps = Math.max(1, streamTasks.length);
    let lastTextureUploadAt = Date.now();
    let opsSinceTextureUpload = 0;
    const pendingScalarBricks = new Map();
    const streamStats = {
      startedAt: performance.now?.() || Date.now(),
      lastLogAt: performance.now?.() || Date.now(),
      lastDoneOps: 0,
      lastRgbaChunks: 0,
      rgbaChunks: 0
    };
    const uploadEveryMs = BRICK_TEXTURE_UPDATE_MS[quality] || 900;
    const uploadEveryOps = BRICK_TEXTURE_UPDATE_OPS[quality] || 24;
    const maybeLogStreamStats = () => {
      const now = performance.now?.() || Date.now();
      if ((now - streamStats.lastLogAt) < 2000) return;
      const dt = Math.max(0.001, (now - streamStats.lastLogAt) / 1000);
      const channelRate = (doneOps - streamStats.lastDoneOps) / dt;
      const chunkRate = (streamStats.rgbaChunks - streamStats.lastRgbaChunks) / dt;
      console.log(`[VolumeViewer] stream ${quality}: ${streamStats.rgbaChunks}/${orderedBricks.length} chunks, ${doneOps}/${effectiveTotalOps} channel tasks, ${chunkRate.toFixed(1)} chunks/s, ${channelRate.toFixed(1)} channels/s, pending=${pendingScalarBricks.size}`);
      streamStats.lastLogAt = now;
      streamStats.lastDoneOps = doneOps;
      streamStats.lastRgbaChunks = streamStats.rgbaChunks;
    };
    const markTextureDirty = (force = false) => {
      const now = Date.now();
      if (force || opsSinceTextureUpload >= uploadEveryOps || (now - lastTextureUploadAt) >= uploadEveryMs) {
        for (const r of _dirtyRegions) {
          _updateGPUTextureRegion(r.tex, r.dims, r.ox, r.oy, r.oz, r.bw, r.bh, r.bd, r.brickData);
        }
        _dirtyRegions = [];
        _scheduleFrame();
        lastTextureUploadAt = now;
        opsSinceTextureUpload = 0;
      }
    };

    if (streamTasks.length && typeof BrickLoader.loadBrickTasks === 'function') {
      await BrickLoader.loadBrickTasks(streamTasks, {
        concurrency: options.concurrency || _brickConcurrencyForQuality(quality),
        cancelPrevious: true,
        preserveOrder: true,
        streamOnly: true,
        onBrickLoaded: ({ bx, by, bz, channel, data: brickData }) => {
          if (abortRef.cancelled || loadId !== _loadCounter) return;
          if (channel === -1) {
            if (streamSvrManager && streamSvrManager !== _svrManager) {
              const bs = dims.brickSize || VOLUME_BRICK_SIZE;
              const ox = bx * bs;
              const oy = by * bs;
              const oz = bz * bs;
              const bw = Math.min(bs, dims.x - ox);
              const bh = Math.min(bs, dims.y - oy);
              const bd = Math.min(bs, dims.z - oz);
              const uploadData = _applyRgbaBrickLuts(brickData, floorLuts, channels);
              streamSvrManager.writeRgbaBrick(bx, by, bz, uploadData, bw, bh, bd);
            } else {
              _writeRgbaBrick(textures, dims, { bx, by, bz }, brickData, floorLuts, channels, !deferActivation);
            }
            streamStats.rgbaChunks++;
            opsSinceTextureUpload++;
            markTextureDirty(false);
          } else {
            const scalarKey = `${bx}_${by}_${bz}`;
            let pending = pendingScalarBricks.get(scalarKey);
            if (!pending) {
              pending = {
                bx,
                by,
                bz,
                count: 0,
                data: new Array(channels)
              };
              pendingScalarBricks.set(scalarKey, pending);
            }
            if (!pending.data[channel]) {
              pending.count++;
            }
            pending.data[channel] = brickData;
            if (pending.count >= channels) {
              const rgbaBrick = _composeRgbaBrickFromScalarChannels(pending.data, floorLuts, channels, dims.brickSize || VOLUME_BRICK_SIZE);
              if (streamSvrManager) {
                const bs = dims.brickSize || VOLUME_BRICK_SIZE;
                const ox = bx * bs;
                const oy = by * bs;
                const oz = bz * bs;
                const bw = Math.min(bs, dims.x - ox);
                const bh = Math.min(bs, dims.y - oy);
                const bd = Math.min(bs, dims.z - oz);
                streamSvrManager.writeRgbaBrick(bx, by, bz, rgbaBrick, bw, bh, bd);
              } else {
                _writeRgbaBrick(textures, dims, { bx, by, bz }, rgbaBrick, null, channels, !deferActivation);
              }
              streamStats.rgbaChunks++;
              pendingScalarBricks.delete(scalarKey);
              opsSinceTextureUpload++;
              if (streamSvrManager) _scheduleFrame();
              markTextureDirty(false);
            }
          }
          doneOps++;
          streamEntry.successfulLoads = doneOps;
          const progress = Math.max(0, Math.min(1, doneOps / effectiveTotalOps));
          _emitQualityState({ progress });
          onProgress?.(progress, quality);
          maybeLogStreamStats();
        },
        onProgress: (p) => {
          const progress = Math.max(0, Math.min(1, Math.max(doneOps / effectiveTotalOps, p)));
          _emitQualityState({ progress });
          onProgress?.(progress, quality);
        }
      });
    } else if (streamTasks.length) {
      console.warn('[VolumeViewer] BrickLoader.loadBrickTasks unavailable; using legacy per-channel brick loader.');
      for (let c = 0; c < channels; c++) {
        if (abortRef.cancelled || loadId !== _loadCounter) break;
        const brickData = await BrickLoader.loadBricks(orderedBricks, c, lod, {
          cancelPrevious: c === 0,
          onBrickLoaded: ({ bx, by, bz, data }) => {
            if (abortRef.cancelled || loadId !== _loadCounter) return;
            if (streamSvrManager && streamSvrManager !== _svrManager) {
              const bs = dims.brickSize || VOLUME_BRICK_SIZE;
              const ox = bx * bs;
              const oy = by * bs;
              const oz = bz * bs;
              const bw = Math.min(bs, dims.x - ox);
              const bh = Math.min(bs, dims.y - oy);
              const bd = Math.min(bs, dims.z - oz);
              streamSvrManager.writeBrick(c, bx, by, bz, data, bw, bh, bd);
            } else {
              _writeBrick(textures, dims, { bx, by, bz }, c, data, floorLuts[c]);
            }
            doneOps++;
            opsSinceTextureUpload++;
            streamEntry.successfulLoads = doneOps;
            markTextureDirty(false);
            const progress = Math.max(0, Math.min(1, doneOps / totalOps));
            _emitQualityState({ progress });
            onProgress?.(progress, quality);
          },
          onProgress: (p) => {
            const progress = Math.max(0, Math.min(1, (c + p) / Math.max(1, channels)));
            _emitQualityState({ progress });
            onProgress?.(progress, quality);
          }
        });
        if (!streamEntry.successfulLoads && brickData?.size) {
          for (const { bx, by, bz } of orderedBricks) {
            const pixels = brickData.get(`${bx}_${by}_${bz}`);
            if (!pixels) continue;
            if (streamSvrManager && streamSvrManager !== _svrManager) {
              const bs = dims.brickSize || VOLUME_BRICK_SIZE;
              const ox = bx * bs;
              const oy = by * bs;
              const oz = bz * bs;
              const bw = Math.min(bs, dims.x - ox);
              const bh = Math.min(bs, dims.y - oy);
              const bd = Math.min(bs, dims.z - oz);
              streamSvrManager.writeBrick(c, bx, by, bz, pixels, bw, bh, bd);
            } else {
              _writeBrick(textures, dims, { bx, by, bz }, c, pixels, floorLuts[c]);
            }
            doneOps++;
            streamEntry.successfulLoads = doneOps;
          }
          markTextureDirty(true);
        }
      }
    }

    if (pendingScalarBricks.size) {
      for (const pending of pendingScalarBricks.values()) {
        const rgbaBrick = _composeRgbaBrickFromScalarChannels(pending.data, floorLuts, channels, dims.brickSize || VOLUME_BRICK_SIZE);
        if (streamSvrManager) {
          const bs = dims.brickSize || VOLUME_BRICK_SIZE;
          const ox = pending.bx * bs;
          const oy = pending.by * bs;
          const oz = pending.bz * bs;
          const bw = Math.min(bs, dims.x - ox);
          const bh = Math.min(bs, dims.y - oy);
          const bd = Math.min(bs, dims.z - oz);
          streamSvrManager.writeRgbaBrick(pending.bx, pending.by, pending.bz, rgbaBrick, bw, bh, bd);
        } else {
          _writeRgbaBrick(textures, dims, { bx: pending.bx, by: pending.by, bz: pending.bz }, rgbaBrick, null, channels, !deferActivation);
        }
        streamStats.rgbaChunks++;
        opsSinceTextureUpload++;
        if (streamSvrManager) _scheduleFrame();
      }
      pendingScalarBricks.clear();
      markTextureDirty(true);
    }

    if (abortRef.cancelled || loadId !== _loadCounter) {
      if (deferActivation) _clearTransitionVolume();
      if (streamSvrManager && streamSvrManager !== _svrManager) streamSvrManager.dispose();
      _emitQualityState({ message: `${quality} streaming cancelled` });
      _perf()?.end(perfId, { status: 'stale', quality });
      return { stale: true };
    }
    if (streamTasks.length && doneOps === 0) {
      if (deferActivation) _clearTransitionVolume();
      if (streamSvrManager && streamSvrManager !== _svrManager) streamSvrManager.dispose();
      _emitQualityState({
        active: quality,
        mode: 'bricks',
        progress: 0,
        message: `${quality} bricks unavailable`
      });
      _perf()?.end(perfId, {
        status: 'unavailable',
        quality,
        reason: 'No brick payload could be loaded'
      });
      return { available: false, reason: 'No brick payload could be loaded' };
    }

    // Flush any remaining dirty regions
    for (const r of _dirtyRegions) {
      _updateGPUTextureRegion(r.tex, r.dims, r.ox, r.oy, r.oz, r.bw, r.bh, r.bd, r.brickData);
    }
    _dirtyRegions = [];
    _scheduleFrame();
    streamEntry.histograms = manifestHistograms.length
      ? manifestHistograms
      : (_channelHistograms?.length ? _channelHistograms : []);
    _storeVolumeCache(streamEntry.key, streamEntry);
    _activateVolumeEntry(streamEntry, metadata, streamEntry.sourceDepth, streamEntry.sourceWidth, channels, options);
    if (deferActivation) _clearTransitionVolume();
    _emitQualityState({
      active: quality,
      mode: 'bricks',
      progress: 1,
      message: `${quality} bricks ready`
    });
    onProgress?.(1, quality);
    _perf()?.end(perfId, {
      status: 'ok',
      fromCache: false,
      quality,
      width,
      height,
      depth,
        successfulLoads: streamEntry.successfulLoads
      });
      return {
        stale: false,
        available: true,
        quality,
        width,
        height,
        depth,
        successfulLoads: streamEntry.successfulLoads,
        failedLoads: 0,
        fromCache: false,
        physicalSizeUm: _physicalSizeUm,
        scaleMode: _scaleMode,
        streamMode: 'bricks',
        manifest: tpSelection.manifest
      };
    } finally {
      _isStreamingBricks = false;
      _scheduleFrame();
    }
  }

  function _lodForQuality(quality, levelCount, levels = null) {
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

  function _normalizeQualityKey(value) {
    const key = String(value || '').trim().toLowerCase();
    if (key === 'low' || key === 'preview' || key === '256x256') return '256x256';
    if (key === 'balanced' || key === 'medium' || key === '512x512') return '512x512';
    if (key === 'high' || key === '1024x1024') return '1024x1024';
    if (key === '2048x2048') return '2048x2048';
    if (key === '4096x4096') return '4096x4096';
    if (key === 'native') return 'native';
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

  function _compactScalarBrickData(brickData, bs, bw, bh, bd) {
    if (!brickData) return null;
    const required = bw * bh * bd;
    if (brickData.length === required) return brickData;
    const out = new Uint8Array(required);
    let dst = 0;
    for (let lz = 0; lz < bd; lz++) {
      const srcZOff = lz * bs * bs;
      for (let ly = 0; ly < bh; ly++) {
        const srcIdx = srcZOff + ly * bs;
        out.set(brickData.subarray(srcIdx, srcIdx + bw), dst);
        dst += bw;
      }
    }
    return out;
  }

  function _compactRgbaBrickData(brickData, bs, bw, bh, bd) {
    if (!brickData) return null;
    const required = bw * bh * bd * RGBA_TEXTURE_BYTES_PER_VOXEL;
    if (brickData.length === required) return brickData;
    const out = new Uint8Array(required);
    let dst = 0;
    for (let lz = 0; lz < bd; lz++) {
      const srcZOff = lz * bs * bs * RGBA_TEXTURE_BYTES_PER_VOXEL;
      for (let ly = 0; ly < bh; ly++) {
        const srcIdx = srcZOff + ly * bs * RGBA_TEXTURE_BYTES_PER_VOXEL;
        const len = bw * RGBA_TEXTURE_BYTES_PER_VOXEL;
        out.set(brickData.subarray(srcIdx, srcIdx + len), dst);
        dst += len;
      }
    }
    return out;
  }

  function _extractTextureRegionData(tex, dims, ox, oy, oz, bw, bh, bd) {
    const src = tex?.image?.data;
    if (!src) return null;
    const rgba = _isRgbaTexture(tex);
    const stride = rgba ? RGBA_TEXTURE_BYTES_PER_VOXEL : 1;
    const out = new Uint8Array(bw * bh * bd * stride);
    let dst = 0;
    for (let lz = 0; lz < bd; lz++) {
      const gz = oz + lz;
      for (let ly = 0; ly < bh; ly++) {
        const srcIdx = ((gz * dims.y + oy + ly) * dims.x + ox) * stride;
        const len = bw * stride;
        out.set(src.subarray(srcIdx, srcIdx + len), dst);
        dst += len;
      }
    }
    return out;
  }

  function _updateGPUTextureRegion(tex, dims, ox, oy, oz, bw, bh, bd, brickData) {
    if (!renderer) return;
    const uploadData = brickData || _extractTextureRegionData(tex, dims, ox, oy, oz, bw, bh, bd);
    if (!uploadData || !uploadData.length) return;
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
      uploadData
    );

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);

    if (!(renderer.state && renderer.state.bindTexture)) {
      gl.bindTexture(gl.TEXTURE_3D, prevBinding);
    }
  }

  function _writeBrick(textures, dims, brick, channel, brickData, floorOrLut = 0) {
    const bs = dims.brickSize || VOLUME_BRICK_SIZE;
    const ox = brick.bx * bs;
    const oy = brick.by * bs;
    const oz = brick.bz * bs;
    const bw = Math.min(bs, dims.x - ox);
    const bh = Math.min(bs, dims.y - oy);
    const bd = Math.min(bs, dims.z - oz);
    
    // CPU-side LUT application removed to prevent Main Thread stalling (2+ billion iterations for LOD 1024).
    // The GPU fragment shader already handles `channelMins` and `channelMaxs` correctly.

    const _t0 = performance.now();
    if (_svrManager) {
       _svrManager.writeBrick(channel, brick.bx, brick.by, brick.bz, brickData, bw, bh, bd);
       return;
    }
    
    const usesRgbaAtlas = textures.length === 1 && _isRgbaTexture(textures[0]);
    if (usesRgbaAtlas ? (channel < 0 || channel >= RGBA_TEXTURE_BYTES_PER_VOXEL) : channel >= textures.length) return;
    const tex = usesRgbaAtlas ? textures[0] : textures[channel];
    if (!tex) return;
    const targetData = tex.image.data;
    if (targetData) {
      let uploadData;
      if (_isRgbaTexture(tex)) {
        for (let lz = 0; lz < bd; lz++) {
          const gz = oz + lz;
          const srcZOff = lz * bs * bs;
          for (let ly = 0; ly < bh; ly++) {
            let srcIdx = srcZOff + ly * bs;
            let dstIdx = ((gz * dims.y + oy + ly) * dims.x + ox) * RGBA_TEXTURE_BYTES_PER_VOXEL + channel;
            for (let lx = 0; lx < bw; lx++) {
              targetData[dstIdx] = brickData[srcIdx++] || 0;
              dstIdx += RGBA_TEXTURE_BYTES_PER_VOXEL;
            }
          }
        }
        uploadData = _extractTextureRegionData(tex, dims, ox, oy, oz, bw, bh, bd);
      } else {
        for (let lz = 0; lz < bd; lz++) {
          const gz = oz + lz;
          const srcZOff = lz * bs * bs;
          const dstZOff = gz * dims.y * dims.x;
          for (let ly = 0; ly < bh; ly++) {
            const srcIdx = srcZOff + ly * bs;
            const dstIdx = dstZOff + (oy + ly) * dims.x + ox;
            targetData.set(brickData.subarray(srcIdx, srcIdx + bw), dstIdx);
          }
        }
        uploadData = _compactScalarBrickData(brickData, bs, bw, bh, bd);
      }
      _dirtyRegions.push({ tex, dims, ox, oy, oz, bw, bh, bd, brickData: uploadData });
    }
    const _t1 = performance.now();
    if (!window._loggedWriteBrick) { window._loggedWriteBrick = 0; }
    if (window._loggedWriteBrick < 50) { 
       if (brickData && brickData.perf) {
          console.log(`[PERF-LOAD] Chunk ${brick.bx},${brick.by},${brick.bz} decode took ${brickData.perf.total.toFixed(2)}ms (bmp: ${brickData.perf.bmp.toFixed(2)}ms, img: ${brickData.perf.img.toFixed(2)}ms, loop: ${brickData.perf.loop.toFixed(2)}ms)`);
       }
       console.log(`[PERF-WRITE] _writeBrick (chunk ${brick.bx},${brick.by},${brick.bz}) took ${(_t1-_t0).toFixed(2)}ms`); 
       window._loggedWriteBrick++; 
    }
  }

  function _writeRgbaBrick(textures, dims, brick, brickData, floorLuts = null, channels = 4, allowGlobalSvr = true) {
    if (brickData && brickData.perf) {
      if (!window._loggedWriteBrick) { window._loggedWriteBrick = 0; }
      if (window._loggedWriteBrick < 50) {
        console.log(`[PERF-LOAD] Chunk ${brick.bx},${brick.by},${brick.bz} decode took ${brickData.perf.total.toFixed(2)}ms (bmp: ${brickData.perf.bmp.toFixed(2)}ms, img: ${brickData.perf.img.toFixed(2)}ms, loop: ${brickData.perf.loop.toFixed(2)}ms)`);
        window._loggedWriteBrick++;
      }
    }
    const bs = dims.brickSize || VOLUME_BRICK_SIZE;
    const ox = brick.bx * bs;
    const oy = brick.by * bs;
    const oz = brick.bz * bs;
    const bw = Math.min(bs, dims.x - ox);
    const bh = Math.min(bs, dims.y - oy);
    const bd = Math.min(bs, dims.z - oz);
    const uploadData = _applyRgbaBrickLuts(brickData, floorLuts, channels);
    if (allowGlobalSvr && _svrManager) {
      if (typeof _svrManager.writeRgbaBrick === 'function') {
        _svrManager.writeRgbaBrick(brick.bx, brick.by, brick.bz, uploadData, bw, bh, bd);
      } else {
        for (let c = 0; c < channels; c++) {
          const scalar = new Uint8Array(bs * bs * bs);
          for (let i = 0, src = c; i < scalar.length; i++, src += RGBA_TEXTURE_BYTES_PER_VOXEL) {
            scalar[i] = uploadData[src] || 0;
          }
          _svrManager.writeBrick(c, brick.bx, brick.by, brick.bz, scalar, bw, bh, bd);
        }
      }
      return;
    }
    if (textures.length === 1 && _isRgbaTexture(textures[0])) {
      const tex = textures[0];
      const targetData = tex.image.data;
      if (!targetData) return;
      for (let lz = 0; lz < bd; lz++) {
        const gz = oz + lz;
        const srcZOff = lz * bs * bs * RGBA_TEXTURE_BYTES_PER_VOXEL;
        for (let ly = 0; ly < bh; ly++) {
          const srcIdx = srcZOff + ly * bs * RGBA_TEXTURE_BYTES_PER_VOXEL;
          const dstIdx = ((gz * dims.y + oy + ly) * dims.x + ox) * RGBA_TEXTURE_BYTES_PER_VOXEL;
          const len = bw * RGBA_TEXTURE_BYTES_PER_VOXEL;
          targetData.set(uploadData.subarray(srcIdx, srcIdx + len), dstIdx);
        }
      }
      _dirtyRegions.push({
        tex,
        dims,
        ox,
        oy,
        oz,
        bw,
        bh,
        bd,
        brickData: _compactRgbaBrickData(uploadData, bs, bw, bh, bd)
      });
      return;
    }
    for(let c=0; c<channels; c++) {
        if (c >= textures.length) continue;
        const tex = textures[c];
        const targetData = tex.image.data;
        if (!targetData) continue;
        const scalarUpload = new Uint8Array(bw * bh * bd);
        let uploadIdx = 0;
        for (let lz = 0; lz < bd; lz++) {
          const gz = oz + lz;
          for (let ly = 0; ly < bh; ly++) {
            let srcIdx = ((lz * bs + ly) * bs) * 4 + c;
            let dstIdx = (gz * dims.y + oy + ly) * dims.x + ox;
            for (let lx = 0; lx < bw; lx++) {
                const value = uploadData[srcIdx];
                targetData[dstIdx++] = value;
                scalarUpload[uploadIdx++] = value;
                srcIdx += 4;
            }
          }
        }
        _dirtyRegions.push({ tex, dims, ox, oy, oz, bw, bh, bd, brickData: scalarUpload });
    }
  }

  function _seedTexturesFromActive(textures, width, height, depth, channels) {
    const src = _activeVolumeEntry;
    if (!src || !src.textures || !src.width || !src.height || !src.depth) return false;
    
    const srcW = src.width;
    const srcH = src.height;
    const srcD = src.depth;

    for (let c = 0; c < channels; c++) {
      if (c >= textures.length || c >= src.textures.length) continue;
      const dstData = textures[c].image.data;
      const srcData = src.textures[c].image.data;
      if (!dstData || !srcData) continue;

      const lutX = new Int32Array(width);
      for (let x = 0; x < width; x++) {
        lutX[x] = Math.max(0, Math.min(srcW - 1, Math.floor((x / width) * srcW)));
      }

      const lutY = new Int32Array(height);
      for (let y = 0; y < height; y++) {
        lutY[y] = Math.max(0, Math.min(srcH - 1, Math.floor((y / height) * srcH)));
      }

      for (let z = 0; z < depth; z++) {
        const sz = Math.max(0, Math.min(srcD - 1, Math.floor((z / depth) * srcD)));
        const srcZOff = sz * srcH * srcW;
        const dstZOff = z * height * width;
        
        for (let y = 0; y < height; y++) {
          const srcYOff = srcZOff + lutY[y] * srcW;
          const dstYOff = dstZOff + y * width;
          for (let x = 0; x < width; x++) {
            dstData[dstYOff + x] = srcData[srcYOff + lutX[x]];
          }
        }
      }
    }
    return true;
  }

  function _seedTexturesFromActiveAsync(textures, width, height, depth, channels, loadId, abortRef, onDone) {
    const src = _activeVolumeEntry;
    if (!src || !src.textures || !src.width || !src.height || !src.depth) {
      onDone();
      return;
    }
    
    const srcW = src.width;
    const srcH = src.height;
    const srcD = src.depth;

    const lutX = new Int32Array(width);
    for (let x = 0; x < width; x++) {
      lutX[x] = Math.max(0, Math.min(srcW - 1, Math.floor((x / width) * srcW)));
    }

    const lutY = new Int32Array(height);
    for (let y = 0; y < height; y++) {
      lutY[y] = Math.max(0, Math.min(srcH - 1, Math.floor((y / height) * srcH)));
    }

    let z = 0;
    const chunkSlices = 4;
    const dims = { x: width, y: height, z: depth };

    function processNextChunk() {
      if (abortRef.cancelled || loadId !== _loadCounter) {
        return; // Abort silently
      }

      const zEnd = Math.min(depth, z + chunkSlices);
      const numSlices = zEnd - z;

      for (let c = 0; c < channels; c++) {
        if (c >= textures.length || c >= src.textures.length) continue;
        const dstData = textures[c].image.data;
        const srcData = src.textures[c].image.data;
        if (!dstData || !srcData) continue;

        for (let cz = z; cz < zEnd; cz++) {
          const sz = Math.max(0, Math.min(srcD - 1, Math.floor((cz / depth) * srcD)));
          const srcZOff = sz * srcH * srcW;
          const dstZOff = cz * height * width;
          
          for (let y = 0; y < height; y++) {
            const srcYOff = srcZOff + lutY[y] * srcW;
            const dstYOff = dstZOff + y * width;
            const srcRow = srcData.subarray(srcYOff, srcYOff + srcW);
            const dstRow = dstData.subarray(dstYOff, dstYOff + width);
            for (let x = 0; x < width; x++) {
              dstRow[x] = srcRow[lutX[x]];
            }
          }
        }
        
        _updateGPUTextureRegion(textures[c], dims, 0, 0, z, width, height, numSlices);
      }

      z = zEnd;
      if (z < depth) {
        requestAnimationFrame(processNextChunk);
      } else {
        onDone();
      }
    }

    requestAnimationFrame(processNextChunk);
  }

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

  function _selectBrickManifestForTimepoint(manifest, timepoint) {
    if (!manifest || typeof manifest !== 'object') {
      return { available: false, reason: 'Invalid brick manifest payload' };
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

  function _orderBricksForStreaming(bricks, dims) {
    const cx = (dims.gridSize?.x || Math.ceil(dims.x / Math.max(1, dims.brickSize))) / 2;
    const cy = (dims.gridSize?.y || Math.ceil(dims.y / Math.max(1, dims.brickSize))) / 2;
    const cz = (dims.gridSize?.z || Math.ceil(dims.z / Math.max(1, dims.brickSize))) / 2;
    return [...bricks].sort((a, b) => {
      const da = Math.hypot(a.bx - cx, a.by - cy, a.bz - cz);
      const db = Math.hypot(b.bx - cx, b.by - cy, b.bz - cz);
      return da - db;
    });
  }

  function _seedVolumeFromActive(width, height, depth, channels) {
    const src = _activeVolumeEntry;
    if (!src?.data || !src.width || !src.height || !src.depth) return null;
    const dst = new Uint8Array(width * height * depth * 4);
    for (let z = 0; z < depth; z++) {
      const sz = Math.max(0, Math.min(src.depth - 1, Math.round((z / Math.max(1, depth - 1)) * (src.depth - 1))));
      for (let y = 0; y < height; y++) {
        const sy = Math.max(0, Math.min(src.height - 1, Math.round((y / Math.max(1, height - 1)) * (src.height - 1))));
        for (let x = 0; x < width; x++) {
          const sx = Math.max(0, Math.min(src.width - 1, Math.round((x / Math.max(1, width - 1)) * (src.width - 1))));
          const dstIdx = ((z * height + y) * width + x) * 4;
          const srcIdx = ((sz * src.height + sy) * src.width + sx) * 4;
          for (let c = 0; c < channels; c++) {
            dst[dstIdx + c] = src.data[srcIdx + c] || 0;
          }
        }
      }
    }
    return dst;
  }

})();

// Expose on window so parent frames (compare.js) can access via iframe.contentWindow
window.VolumeViewer = VolumeViewer;

