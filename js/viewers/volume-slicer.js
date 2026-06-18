/* ============================================================
   IRIBHM Microscopy Platform — Volume Slicer (GPU)
   ============================================================
   Renders arbitrary-orientation slices through the loaded volume
   entirely on the GPU. Samples the same SVR atlas pages
   (svrAtlas0..7 + pageTable) and links the same channel uniforms
   (color/min/max/gamma/opacity/enabled) as the main volume
   renderer, by reference (zero copy); falls back to sampling
   svrAtlas0 as a plain 3D texture when ENABLE_SVR is off.
   ============================================================ */

const VolumeSlicer = (() => {
  // ── Dependencies (injected via init) ──
  let _renderer = null;
  let _volumeMaterial = null;

  // ── GPU resources ──
  let _scene = null;
  let _camera = null;
  let _mat = null;
  let _target = null;        // WebGLRenderTarget for preview
  let _pixelBuf = null;      // Uint8Array for readRenderTargetPixels
  let _previewCanvas = null;
  let _previewCtx = null;
  let _initialized = false;
  let _disabled = false;

  // ── Plane state ──
  let _spec = {
    mode: 'xy', value: 0.5,
    yaw: 0, pitch: 0, roll: 0,
    slabThickness: 1,
    projection: 'single' // 'single' | 'mip' | 'average'
  };

  let _visible = false;
  let _rafId = null;
  let _listeners = new Set();
  const PREVIEW_SIZE = 320;
  const EXTENT = 0.75; // half-size in cube units (covers oblique diagonals)

  // ── Shaders ──────────────────────────────────────────────

  const VERT = `
    out vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
    }
  `;

  const FRAG = `
    precision highp float;
    precision highp sampler3D;

    uniform sampler3D svrAtlas0;
    uniform sampler3D svrAtlas1;
    uniform sampler3D svrAtlas2;
    uniform sampler3D svrAtlas3;
    uniform sampler3D svrAtlas4;
    uniform sampler3D svrAtlas5;
    uniform sampler3D svrAtlas6;
    uniform sampler3D svrAtlas7;

    #ifdef ENABLE_SVR
    uniform sampler3D pageTable;
    uniform vec3 atlasDim;
    uniform vec3 volumeDim;
    uniform vec3 ptDim;
    uniform float brickSize;
    #endif

    uniform int numChannels;

    uniform vec3 color0; uniform float min0; uniform float max0; uniform float gamma0; uniform float opacity0; uniform int en0;
    uniform vec3 color1; uniform float min1; uniform float max1; uniform float gamma1; uniform float opacity1; uniform int en1;
    uniform vec3 color2; uniform float min2; uniform float max2; uniform float gamma2; uniform float opacity2; uniform int en2;
    uniform vec3 color3; uniform float min3; uniform float max3; uniform float gamma3; uniform float opacity3; uniform int en3;

    uniform vec3  sliceOrigin;
    uniform vec3  sliceRight;
    uniform vec3  sliceUp;
    uniform vec3  sliceNormal;
    uniform float sliceExtent;
    uniform int   slabSteps;
    uniform float slabDelta;
    uniform int   projMode;   // 0 single, 1 MIP, 2 average

    in vec2 vUv;
    out vec4 fragColor;

    #ifdef ENABLE_SVR
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
      if (atlasPage < 0.5) return texture(svrAtlas0, atlasCoord);
      if (atlasPage < 1.5) return texture(svrAtlas1, atlasCoord);
      if (atlasPage < 2.5) return texture(svrAtlas2, atlasCoord);
      if (atlasPage < 3.5) return texture(svrAtlas3, atlasCoord);
      if (atlasPage < 4.5) return texture(svrAtlas4, atlasCoord);
      if (atlasPage < 5.5) return texture(svrAtlas5, atlasCoord);
      if (atlasPage < 6.5) return texture(svrAtlas6, atlasCoord);
      return texture(svrAtlas7, atlasCoord);
    }
    #endif

    float channelValue(float raw, float lo, float hi, float gamma, float opacity) {
      float v = clamp((raw - lo) / max(hi - lo, 0.0001), 0.0, 1.0);
      if (gamma != 1.0) v = pow(v, gamma);
      return v * opacity;
    }

    vec3 colorAt(vec3 uvw) {
      #ifdef ENABLE_SVR
      vec4 atlasLookup = getAtlasLookup(uvw);
      if (atlasLookup.w < 0.0) return vec3(0.0);
      vec4 v = sampleSVRAtlas(atlasLookup.xyz, atlasLookup.w);
      #else
      vec4 v = texture(svrAtlas0, uvw);
      #endif
      vec3 c = vec3(0.0);
      if (en0==1 && numChannels>0) c += channelValue(v.r, min0, max0, gamma0, opacity0) * color0;
      if (en1==1 && numChannels>1) c += channelValue(v.g, min1, max1, gamma1, opacity1) * color1;
      if (en2==1 && numChannels>2) c += channelValue(v.b, min2, max2, gamma2, opacity2) * color2;
      if (en3==1 && numChannels>3) c += channelValue(v.a, min3, max3, gamma3, opacity3) * color3;
      return c;
    }

    bool inBox(vec3 p) {
      return all(greaterThanEqual(p, vec3(0.0))) && all(lessThanEqual(p, vec3(1.0)));
    }

    void main() {
      vec2 pc = (vUv - 0.5) * 2.0 * sliceExtent;
      vec3 base = sliceOrigin + pc.x * sliceRight + pc.y * sliceUp;

      if (projMode == 0 || slabSteps <= 1) {
        vec3 uvw = base + 0.5;
        if (!inBox(uvw)) discard;
        vec3 c = colorAt(uvw);
        if (length(c) < 0.005) discard;
        fragColor = vec4(c, 1.0);
        return;
      }

      vec3 acc = vec3(0.0);
      int hits = 0;
      float halfSlab = float(slabSteps - 1) * slabDelta * 0.5;
      for (int i = 0; i < 64; i++) {
        if (i >= slabSteps) break;
        vec3 uvw = base + (-halfSlab + float(i) * slabDelta) * sliceNormal + 0.5;
        if (!inBox(uvw)) continue;
        vec3 c = colorAt(uvw);
        if (projMode == 1) acc = max(acc, c);
        else acc += c;
        hits++;
      }
      if (hits == 0) discard;
      if (projMode == 2) acc /= float(hits);
      fragColor = vec4(acc, 1.0);
    }
  `;

  // ── Init ─────────────────────────────────────────────────

  function init(deps) {
    if (_initialized) return !_disabled;
    _initialized = true;
    _disabled = false;
    _renderer = deps.renderer;
    _volumeMaterial = deps.material || null;

    _previewCanvas = document.createElement('canvas');
    _previewCanvas.width = PREVIEW_SIZE;
    _previewCanvas.height = PREVIEW_SIZE;
    _previewCanvas.className = 'slicer-preview-canvas';
    _previewCtx = _previewCanvas.getContext('2d');
    try {
      _target = new THREE.WebGLRenderTarget(PREVIEW_SIZE, PREVIEW_SIZE, {
        format: THREE.RGBAFormat, type: THREE.UnsignedByteType
      });
      _pixelBuf = new Uint8Array(PREVIEW_SIZE * PREVIEW_SIZE * 4);

      _scene = new THREE.Scene();
      _camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

      _buildMaterial();
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), _mat);
      _scene.add(quad);
      return true;
    } catch (err) {
      _disabled = true;
      _target?.dispose?.();
      _target = null;
      _pixelBuf = null;
      _scene = null;
      _camera = null;
      _mat?.dispose?.();
      _mat = null;
      if (_previewCtx) {
        _previewCtx.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
        _previewCtx.fillStyle = 'rgba(20,20,20,0.75)';
        _previewCtx.fillRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
        _previewCtx.fillStyle = '#bbb';
        _previewCtx.font = '13px sans-serif';
        _previewCtx.fillText('Slice preview unavailable', 18, 32);
      }
      console.warn('[VolumeSlicer] Disabled after allocation failure; continuing without slicer preview.', err);
      return false;
    }
  }

  function updateMaterial(material) {
    if (_disabled || !_initialized) return;
    _volumeMaterial = material;
    _buildMaterial();
    if (_scene?.children?.[0]) _scene.children[0].material = _mat;
    _scheduleRender();
  }

  function _buildMaterial() {
    const u = {};
    const defaults = {
      svrAtlas0: { value: null },
      svrAtlas1: { value: null },
      svrAtlas2: { value: null },
      svrAtlas3: { value: null },
      svrAtlas4: { value: null },
      svrAtlas5: { value: null },
      svrAtlas6: { value: null },
      svrAtlas7: { value: null },
      pageTable: { value: null },
      atlasDim: { value: new THREE.Vector3(512, 512, 512) },
      volumeDim: { value: new THREE.Vector3(1, 1, 1) },
      ptDim: { value: new THREE.Vector3(1, 1, 1) },
      brickSize: { value: 64.0 },
      numChannels: { value: 0 }
    };
    Object.assign(u, defaults);
    for (let i = 0; i < 4; i++) {
      u[`color${i}`] = { value: new THREE.Vector3(1, 1, 1) };
      u[`min${i}`] = { value: 0 };
      u[`max${i}`] = { value: 1 };
      u[`gamma${i}`] = { value: 1 };
      u[`opacity${i}`] = { value: 1 };
      u[`en${i}`] = { value: 0 };
    }

    // Link texture and channel uniforms by reference from the active volume material.
    const linked = [
      'svrAtlas0','svrAtlas1','svrAtlas2','svrAtlas3','svrAtlas4','svrAtlas5','svrAtlas6','svrAtlas7',
      'pageTable','atlasDim','volumeDim','ptDim','brickSize','numChannels',
      'color0','min0','max0','gamma0','opacity0','en0',
      'color1','min1','max1','gamma1','opacity1','en1',
      'color2','min2','max2','gamma2','opacity2','en2',
      'color3','min3','max3','gamma3','opacity3','en3'
    ];
    if (_volumeMaterial?.uniforms) {
      linked.forEach(k => { if (_volumeMaterial.uniforms[k]) u[k] = _volumeMaterial.uniforms[k]; });
    }

    // Slice-specific uniforms (owned by slicer)
    u.sliceOrigin = { value: new THREE.Vector3() };
    u.sliceRight  = { value: new THREE.Vector3(1,0,0) };
    u.sliceUp     = { value: new THREE.Vector3(0,1,0) };
    u.sliceNormal = { value: new THREE.Vector3(0,0,1) };
    u.sliceExtent = { value: EXTENT };
    u.slabSteps   = { value: 1 };
    u.slabDelta   = { value: 0.005 };
    u.projMode    = { value: 0 };

    const defines = {};
    if (_volumeMaterial?.defines?.ENABLE_SVR) defines.ENABLE_SVR = 1;

    _mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines,
      uniforms: u,
      depthTest: false, depthWrite: false
    });
  }

  // ── Plane Computation ────────────────────────────────────

  function _computePlaneVectors(spec) {
    const yaw   = THREE.MathUtils.degToRad(spec.yaw || 0);
    const pitch = THREE.MathUtils.degToRad(spec.pitch || 0);
    const roll  = THREE.MathUtils.degToRad(spec.roll || 0);

    let normal, right, up;
    if (spec.mode === 'xz') {
      normal = new THREE.Vector3(0, 1, 0);
      right  = new THREE.Vector3(1, 0, 0);
      up     = new THREE.Vector3(0, 0, 1);
    } else if (spec.mode === 'yz') {
      normal = new THREE.Vector3(1, 0, 0);
      right  = new THREE.Vector3(0, 1, 0);
      up     = new THREE.Vector3(0, 0, 1);
    } else if (spec.mode === 'oblique') {
      const q = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(-pitch, -yaw, roll, 'YXZ')
      );
      normal = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
      right  = new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize();
      up     = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();
    } else { // xy
      normal = new THREE.Vector3(0, 0, 1);
      right  = new THREE.Vector3(1, 0, 0);
      up     = new THREE.Vector3(0, 1, 0);
    }

    // EDGE-034: use spec.value directly (sanitized to [0,1] in setPlaneSpec) so a
    // legitimate 0 is honored instead of being rewritten to 0.5 by `value || 0.5`.
    const value = Number.isFinite(+spec.value) ? +spec.value : 0.5;
    const origin = normal.clone().multiplyScalar(value - 0.5);
    return { origin, right, up, normal };
  }

  function _syncUniforms() {
    if (!_mat) return;
    const u = _mat.uniforms;
    const { origin, right, up, normal } = _computePlaneVectors(_spec);
    
    // Convert right and up from physical direction to uvw space 
    // so that 1.0 in pc corresponds to maxP physical microns.
    if (typeof VolumeViewer !== 'undefined' && VolumeViewer.getPhysicalSize) {
      const physical = VolumeViewer.getPhysicalSize() || {x: 1, y: 1, z: 1};
      // EDGE-035: the `|| {1,1,1}` guard only catches a null return, not an object
      // with a 0 dimension (malformed metadata scaleInfo) — which gave maxP/0 = ∞
      // (or 0/0 = NaN) uniforms. Replace any non-positive physical dim with 1.
      const px = physical.x > 0 ? physical.x : 1;
      const py = physical.y > 0 ? physical.y : 1;
      const pz = physical.z > 0 ? physical.z : 1;
      const maxP = Math.max(px, py, pz) || 1;
      right.x *= maxP / px;
      right.y *= maxP / py;
      right.z *= maxP / pz;

      up.x *= maxP / px;
      up.y *= maxP / py;
      up.z *= maxP / pz;

      // Slab delta also needs to be in uvw space for normal
      normal.x *= maxP / px;
      normal.y *= maxP / py;
      normal.z *= maxP / pz;
    }

    u.sliceOrigin.value.copy(origin);
    u.sliceRight.value.copy(right);
    u.sliceUp.value.copy(up);
    u.sliceNormal.value.copy(normal);

    const proj = _spec.projection || 'single';
    u.projMode.value = proj === 'mip' ? 1 : proj === 'average' ? 2 : 0;
    const steps = Math.max(1, Math.min(64, _spec.slabThickness || 1));
    u.slabSteps.value = steps;
    u.slabDelta.value = steps > 1 ? (1.0 / 256) : 0;
  }

  // ── Rendering ────────────────────────────────────────────


  // ── Render: preview ──────────────────────────────────────
  function _hasRenderableVolume() {
    return Boolean(_mat?.uniforms?.svrAtlas0?.value);
  }

  function _doPreview() {
    if (_disabled || !_target || !_pixelBuf || !_visible || !_renderer || !_hasRenderableVolume()) return;
    _syncUniforms();

    // Save full renderer state
    const prevTarget   = _renderer.getRenderTarget();
    const prevViewport = new THREE.Vector4();
    _renderer.getViewport(prevViewport);
    const prevAutoClear = _renderer.autoClear;

    // The viewport size must be in CSS/logical pixels (Three.js multiplies by
    // pixelRatio internally). Dividing by pixelRatio makes the GL call land
    // exactly at PREVIEW_SIZE × PREVIEW_SIZE — matching the render target.
    const pr = _renderer.getPixelRatio();
    const vpSize = PREVIEW_SIZE / pr;

    _renderer.autoClear = true;
    _renderer.setRenderTarget(_target);
    _renderer.setViewport(0, 0, vpSize, vpSize);
    _renderer.clear();
    _renderer.render(_scene, _camera);

    _renderer.readRenderTargetPixels(_target, 0, 0, PREVIEW_SIZE, PREVIEW_SIZE, _pixelBuf);

    // ── CRITICAL: restore ALL renderer state ───────────────
    _renderer.setRenderTarget(prevTarget);
    _renderer.setViewport(prevViewport);
    _renderer.autoClear = prevAutoClear;

    // Flip Y (WebGL origin = bottom-left, Canvas2D origin = top-left)
    const imgData = _previewCtx.createImageData(PREVIEW_SIZE, PREVIEW_SIZE);
    for (let y = 0; y < PREVIEW_SIZE; y++) {
      const src = (PREVIEW_SIZE - 1 - y) * PREVIEW_SIZE * 4;
      const dst = y * PREVIEW_SIZE * 4;
      imgData.data.set(_pixelBuf.subarray(src, src + PREVIEW_SIZE * 4), dst);
    }
    _previewCtx.putImageData(imgData, 0, 0);
  }

  let _hiTarget = null;
  let _hiBuf = null;
  let _hiCanvas = null;
  let _hiCtx = null;
  let _hiImgData = null;
  let _hiSize = 0;

  function renderHighRes(size = 1024, channelOverrides = null) {
    if (_disabled || !_renderer || !_hasRenderableVolume()) return null;
    _syncUniforms();

    // Temporarily apply channel overrides for Studio
    let originals = null;
    if (channelOverrides && Array.isArray(channelOverrides)) {
      originals = {};
      for (let i = 0; i < 4; i++) {
        const cState = channelOverrides[i];
        if (!cState || !_mat.uniforms[`color${i}`]) continue;
        originals[`color${i}`] = _mat.uniforms[`color${i}`].value.clone();
        originals[`min${i}`] = _mat.uniforms[`min${i}`].value;
        originals[`max${i}`] = _mat.uniforms[`max${i}`].value;
        originals[`gamma${i}`] = _mat.uniforms[`gamma${i}`].value;
        originals[`opacity${i}`] = _mat.uniforms[`opacity${i}`].value;
        originals[`en${i}`] = _mat.uniforms[`en${i}`].value;

        if (cState.color) {
          if (typeof cState.color === 'string') {
            const col = new THREE.Color(cState.color);
            _mat.uniforms[`color${i}`].value.set(col.r, col.g, col.b);
          } else {
            _mat.uniforms[`color${i}`].value.set(cState.color.r/255, cState.color.g/255, cState.color.b/255);
          }
        }
        if (cState.min !== undefined) _mat.uniforms[`min${i}`].value = cState.min;
        if (cState.max !== undefined) _mat.uniforms[`max${i}`].value = cState.max;
        if (cState.gamma !== undefined) _mat.uniforms[`gamma${i}`].value = cState.gamma;
        if (cState.opacity !== undefined) _mat.uniforms[`opacity${i}`].value = cState.opacity;
        if (typeof cState.enabled === 'boolean') _mat.uniforms[`en${i}`].value = cState.enabled ? 1 : 0;
      }
    }

    if (size !== _hiSize) {
      if (_hiTarget) _hiTarget.dispose();
      try {
        _hiTarget = new THREE.WebGLRenderTarget(size, size, {
          format: THREE.RGBAFormat, type: THREE.UnsignedByteType
        });
        _hiBuf = new Uint8Array(size * size * 4);
        _hiCanvas = document.createElement('canvas');
        _hiCanvas.width = size;
        _hiCanvas.height = size;
        _hiCtx = _hiCanvas.getContext('2d');
        _hiImgData = _hiCtx.createImageData(size, size);
        _hiSize = size;
      } catch (err) {
        _hiTarget?.dispose?.();
        _hiTarget = null;
        _hiBuf = null;
        _hiCanvas = null;
        _hiCtx = null;
        _hiImgData = null;
        _hiSize = 0;
        console.warn('[VolumeSlicer] High-res render allocation failed.', err);
        return null;
      }
    }

    const prevTarget   = _renderer.getRenderTarget();
    const prevViewport = new THREE.Vector4();
    _renderer.getViewport(prevViewport);
    const prevAutoClear = _renderer.autoClear;

    const pr = _renderer.getPixelRatio();
    const vpSize = size / pr;

    _renderer.autoClear = true;
    _renderer.setRenderTarget(_hiTarget);
    _renderer.setViewport(0, 0, vpSize, vpSize);
    _renderer.clear();
    _renderer.render(_scene, _camera);
    _renderer.readRenderTargetPixels(_hiTarget, 0, 0, size, size, _hiBuf);

    // Restore overrides
    if (originals) {
      for (const k in originals) {
        if (typeof originals[k] === 'object') {
           _mat.uniforms[k].value.copy(originals[k]);
        } else {
           _mat.uniforms[k].value = originals[k];
        }
      }
    }
    
    // Restore renderer
    _renderer.setRenderTarget(prevTarget);
    _renderer.setViewport(prevViewport);
    _renderer.autoClear = prevAutoClear;

    for (let y = 0; y < size; y++) {
      const src = (size - 1 - y) * size * 4;
      const dst = y * size * 4;
      _hiImgData.data.set(_hiBuf.subarray(src, src + size * 4), dst);
    }
    _hiCtx.putImageData(_hiImgData, 0, 0);
    return _hiCanvas;
  }

  function renderWithMaterial(material, spec, size = 1024, channelOverrides = null) {
    if (_disabled || !_renderer || !material) return null;

    const previousVolumeMaterial = _volumeMaterial;
    const previousMaterial = _mat;
    const previousSpec = { ..._spec };
    let temporaryMaterial = null;

    try {
      _volumeMaterial = material;
      _buildMaterial();
      temporaryMaterial = _mat;
      if (_scene?.children?.[0]) _scene.children[0].material = _mat;
      if (spec) _spec = { ..._spec, ...spec };
      return renderHighRes(size, channelOverrides);
    } finally {
      if (temporaryMaterial && temporaryMaterial !== previousMaterial) {
        temporaryMaterial.dispose?.();
      }
      _volumeMaterial = previousVolumeMaterial;
      _mat = previousMaterial;
      _spec = previousSpec;
      if (_scene?.children?.[0] && previousMaterial) _scene.children[0].material = previousMaterial;
    }
  }

  function _scheduleRender() {
    if (_disabled) return;
    if (_rafId) return;
    _rafId = requestAnimationFrame(() => {
      _rafId = null;
      _doPreview();
    });
  }

  function recompose(sliceResult, channelState) {
    if (sliceResult.source !== 'gpu-slicer' && sliceResult.source !== 'zstack') return null;
    // Make sure we use the same plane spec
    const oldSpec = getPlaneSpec();
    if (sliceResult.planeSpec) setPlaneSpec(sliceResult.planeSpec);
    
    const canvas = renderHighRes(sliceResult.width || 1024, channelState);
    
    // Restore original plane spec
    setPlaneSpec(oldSpec);
    
    if (!canvas) return null;
    return {
      ...sliceResult,
      canvas,
      width: canvas.width,
      height: canvas.height
    };
  }

  // ── Public API ───────────────────────────────────────────

  function setPlaneSpec(spec) {
    // EDGE-009 / EDGE-034 (Rule 1.4): sanitize before merging. A NaN angle is falsy
    // (coerced to 0 downstream) but Infinity / a truthy non-numeric flowed into the
    // Euler->quaternion and produced a degenerate (NaN/Inf) normal/right/up. `value`
    // was accepted unbounded (offsetting the plane outside the [0,1] cube) and a
    // legitimate 0 was wrongly turned into 0.5 by `value || 0.5`.
    const merged = { ...spec };
    for (const k of ['yaw', 'pitch', 'roll']) {
      if (k in merged) merged[k] = Number.isFinite(+merged[k]) ? +merged[k] : 0;
    }
    if (merged.value != null) {
      merged.value = Math.min(1, Math.max(0, Number.isFinite(+merged.value) ? +merged.value : 0.5));
    }
    if (merged.slabThickness != null) {
      merged.slabThickness = Math.min(64, Math.max(1, Math.round(+merged.slabThickness) || 1));
    }
    Object.assign(_spec, merged);
    if (_visible) _scheduleRender();
    _listeners.forEach(cb => cb({ ..._spec }));
  }

  function getPlaneSpec() { return { ..._spec }; }

  function setVisible(v) {
    if (_disabled) {
      _visible = false;
      return;
    }
    _visible = v;
    if (v) _scheduleRender();
  }

  function isVisible() { return _visible; }

  function getPreviewCanvas() { return _previewCanvas; }

  function onChange(cb) {
    _listeners.add(cb);
    return () => _listeners.delete(cb);
  }

  function dispose() {
    if (_rafId) cancelAnimationFrame(_rafId);
    _target?.dispose();
    _hiTarget?.dispose();
    _mat?.dispose();
    _scene = null;
    _target = null;
    _pixelBuf = null;
    _hiTarget = null;
    _hiBuf = null;
    _initialized = false;
    _disabled = false;
  }

  return {
    init,
    updateMaterial,
    setPlaneSpec,
    getPlaneSpec,
    setVisible,
    isVisible,
    isAvailable: () => !_disabled,
    getPreviewCanvas,
    renderHighRes,
    renderWithMaterial,
    recompose,
    onChange,
    dispose,
    /** Force an immediate preview render (e.g. after channel change) */
    refresh: _scheduleRender
  };
})();

// Expose on window so parent frames (compare.js) can access via iframe.contentWindow
window.VolumeSlicer = VolumeSlicer;
