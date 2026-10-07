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
  let _previewCanvas = null;
  let _previewCtx = null;
  let _initialized = false;
  let _disabled = false;

  // ── Plane state ──
  let _spec = {
    mode: 'xy', value: 0.5,
    yaw: 0, pitch: 0, roll: 0,
    slabThickness: 1,          // samples across the slab (1 = a single plane)
    // Distance between two samples along the plane normal, in normalised texture
    // units (1/dims.z samples a Z-stack one slice per step). null = the historical
    // 1/256 of the longest physical axis, which the slice inspector's slider assumes.
    slabStepNorm: null,
    projection: 'single' // 'single' | 'mip' | 'average'
  };
  const MAX_SLAB_STEPS = 1024; // must match the loop bound in FRAG

  let _visible = false;
  let _rafId = null;
  let _listeners = new Set();
  let _visibleListeners = new Set();
  // The sidebar preview renders at PREVIEW_SIZE. On the slice stage (the canvas
  // area, viewer.js _setSliceStage) the interactive resolution follows the
  // displayed size up to 1024 px, and a sharper pass up to MAX_PREVIEW_SIZE runs
  // once the plane has settled for REFINE_DELAY_MS — a drag never pays the big
  // readback. One render pass (target + readback buffer + ImageData) per size.
  const PREVIEW_SIZE = 320;
  const MAX_PREVIEW_SIZE = 2048;
  const REFINE_DELAY_MS = 160;
  let _previewSize = PREVIEW_SIZE;
  let _refineSize = 0;
  let _refineTimer = null;
  const _passes = new Map();
  const PLANE_KEYS = ['mode', 'value', 'yaw', 'pitch', 'roll', 'slabThickness', 'slabStepNorm', 'projection'];
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
    // The raw fallback is read as exact bytes: not at the default lowp.
    precision highp sampler2D;
    precision highp sampler2DArray;

    #ifdef SVR_ARRAY
    // A compressed display atlas (svr-manager.js): pages are 2D arrays of RGTC layers.
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

    #ifdef ENABLE_SVR
    uniform sampler3D pageTable;
    uniform vec3 atlasDim;
    uniform vec3 volumeDim;
    uniform vec3 ptDim;
    uniform float brickSize;
    // Atlas slot layout (svr-manager.js): slot edge (64, or 66 with the 1-voxel border
    // of a v3 brick), border width, and the bytes per voxel (1 R8, 2 RG8, 4 RGBA8).
    uniform float slotStride;
    uniform float brickApron;
    uniform int svrComponents;
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
    // The part of the frame this render covers (x, y, w, h in 0..1, GL orientation):
    // (0, 0, 1, 1) is the whole frame; a window renders the same pixels of that part
    // alone, so a caller that only keeps a crop pays only that crop's readback.
    uniform vec4  uvWindow;
    // 1 renders the window upside down: the target's first row (GL bottom) holds the
    // window's TOP row, so a readback is already in canvas order (no CPU flip).
    uniform float flipY;

    #ifdef VOLUME_WARP
    // 4D stabilisation, linked by reference from the volume material: cube (object)
    // space → texture coordinate of the timepoint on screen (volume-viewer.js,
    // setTimepointTransform). The define follows the volume material's (_syncUniforms).
    uniform mat4 volumeWarp;
    #endif

    #ifdef FALLBACK_TEX
    // The picture shown wherever a brick the plane crosses is not in the atlas: the
    // Studio's preview of the same plane at the same render size, so the chunks of
    // the native pass replace it one by one instead of opening a black hole.
    // fallbackRect places that (cropped) picture in the render frame, GL orientation.
    uniform sampler2D fallbackTex;
    uniform vec4 fallbackRect;
    #endif

    #ifdef PLANE_TEX
    // The Studio's native picture of an axis-aligned plane, without a 3D atlas: the
    // voxel planes the plane reads along its normal axis k (or, for a MIP slab, their
    // per-channel maximum, planeReduced = 1) in a 2D array texture, texel (u, v, layer)
    // = voxel (u, v) of plane layer, (u, v) the two other axes in x, y, z order. The
    // voxel of uvw is computed exactly as getAtlasLookup computes it, floor of
    // clamp(uvw·dim, 0, dim − 1); planePresence holds, per brick column and layer, 1
    // once that brick's voxels are in (0: the atlas would have no brick there).
    uniform sampler2DArray planeTex;
    uniform sampler2DArray planePresence;
    uniform vec3 planeDim;
    uniform int planeAxis;       // 0: normal x (u = y, v = z); 1: y (u = x, v = z); 2: z (u = x, v = y)
    uniform int planeLayerBase;  // voxel index along k of layer 0
    uniform int planeLayers;
    uniform int planeReduced;
    uniform float planeBrickSize;
    #endif

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
      // The voxel's own texel: a bordered slot keeps its interior from texel 1 on. The
      // slice reads exact voxels (the texel centre), a LINEAR atlas included: at a texel
      // centre the filter weights of the neighbours are 0.
      vec3 atlasVoxel = slotIndex * slotStride + vec3(brickApron) + localVoxel;
      return vec4((atlasVoxel + vec3(0.5)) / atlasDim, atlasPage);
    }

    // An R8 / RG8 atlas samples as (r, 0, 0, 1) / (r, g, 0, 1): the channels the
    // dataset does not have read as 0, as in an RGBA8 atlas.
    vec4 keepComponents(vec4 v) {
      if (svrComponents >= 4) return v;
      if (svrComponents == 3) return vec4(v.rgb, 0.0);
      if (svrComponents == 2) return vec4(v.rg, 0.0, 0.0);
      return vec4(v.r, 0.0, 0.0, 0.0);
    }

    #ifdef SVR_ARRAY
    // The slice reads texel centres: the layer is the one holding the coordinate,
    // ⌊c.z·depth⌋, and the bilinear filter of a layer at a texel centre is that texel.
    // A macro, not a function taking the sampler (see volume-viewer.js SVR_LAYER).
    #define SVR_LAYER(page) texture(page, svrL)
    vec4 sampleSVRAtlas(vec3 atlasCoord, float atlasPage) {
      vec3 svrL = vec3(atlasCoord.xy, floor(atlasCoord.z * atlasDim.z));
      #ifdef SVR_ARRAY_PAIRS
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
    #endif

    float channelValue(float raw, float lo, float hi, float gamma, float opacity) {
      float v = clamp((raw - lo) / max(hi - lo, 0.0001), 0.0, 1.0);
      if (gamma != 1.0) v = pow(v, gamma);
      return v * opacity;
    }

    // The atlas texel at uvw: channels 0..3 in r, g, b, a. present is false where no
    // brick backs the voxel (every channel reads 0 there).
    vec4 rawAt(vec3 uvw, out bool present) {
      #ifdef PLANE_TEX
      vec3 voxel = floor(clamp(uvw * planeDim, vec3(0.0), planeDim - vec3(1.0)));
      vec3 brick = floor(voxel / planeBrickSize);
      ivec2 texel;
      ivec2 column;
      float along;
      if (planeAxis == 2) { texel = ivec2(voxel.xy); column = ivec2(brick.xy); along = voxel.z; }
      else if (planeAxis == 1) { texel = ivec2(voxel.xz); column = ivec2(brick.xz); along = voxel.y; }
      else { texel = ivec2(voxel.yz); column = ivec2(brick.yz); along = voxel.x; }
      int layer = planeReduced == 1 ? 0 : int(along) - planeLayerBase;
      present = layer >= 0 && layer < planeLayers
        && texelFetch(planePresence, ivec3(column, layer), 0).r > 0.5;
      if (!present) return vec4(0.0);
      return texelFetch(planeTex, ivec3(texel, layer), 0);
      #else
      #ifdef ENABLE_SVR
      vec4 atlasLookup = getAtlasLookup(uvw);
      present = atlasLookup.w >= 0.0;
      if (!present) return vec4(0.0);
      return keepComponents(sampleSVRAtlas(atlasLookup.xyz, atlasLookup.w));
      #else
      present = true;
      return texture(svrAtlas0, uvw);
      #endif
      #endif
    }

    // The colour of raw channel values v: Σ channelValue(v_i)·colour_i over the
    // enabled channels i < numChannels.
    vec3 composeRaw(vec4 v) {
      vec3 c = vec3(0.0);
      if (en0==1 && numChannels>0) c += channelValue(v.r, min0, max0, gamma0, opacity0) * color0;
      if (en1==1 && numChannels>1) c += channelValue(v.g, min1, max1, gamma1, opacity1) * color1;
      if (en2==1 && numChannels>2) c += channelValue(v.b, min2, max2, gamma2, opacity2) * color2;
      if (en3==1 && numChannels>3) c += channelValue(v.a, min3, max3, gamma3, opacity3) * color3;
      return c;
    }

    // rgb: the composed channel colour at uvw; a: 1 when a brick backs the voxel,
    // 0 when the atlas has none there (black in rgb).
    vec4 colorAt(vec3 uvw) {
      bool present;
      vec4 v = rawAt(uvw, present);
      if (!present) return vec4(0.0);
      return vec4(composeRaw(v), 1.0);
    }

    bool inBox(vec3 p) {
      return all(greaterThanEqual(p, vec3(0.0))) && all(lessThanEqual(p, vec3(1.0)));
    }

    // The texture coordinate of the cube-space point p, by the ray-marcher's own map
    // (volume-viewer.js, per-sample uvw): p + ½, or volumeWarp·p on a stabilised
    // timelapse. base (main) IS that cube space: sliceOrigin + pc.x·sliceRight +
    // pc.y·sliceUp with sliceRight = r ⊙ maxP/p_axis (planeGeometry), i.e. the
    // physically proportioned plane P = base ⊙ p_axis/maxP expressed in cube units,
    // the frame the cube geometry is drawn in (world = T + Qc·(s ⊙ base)) and the one
    // the ray-marcher marches its p in (vOrigin = modelMatrix⁻¹·camera). Unwarped both
    // read base + ½; warped both read volumeWarp·base — the same voxel for the same
    // point of the volume on screen, and the in-box test below runs on that texture
    // coordinate (this timepoint's data), not on base.
    vec3 texCoord(vec3 p) {
      #ifdef VOLUME_WARP
      return (volumeWarp * vec4(p, 1.0)).xyz;
      #else
      return p + 0.5;
      #endif
    }

    // A slab, projected channel by channel on the RAW values — the Fiji convention:
    // project the intensities, then window and colour the projection once (the only
    // order under which "average" is the mean intensity). The samples sit at
    //   uvw_k = texCoord(base + (−h + k·δ)·n),   k = 0 … N−1,   h = (N − 1)·δ/2
    // (N = slabSteps, δ = slabDelta, n = sliceNormal, a cube-space step), and only the
    // K of them inside the volume box count:
    //   MIP (projMode 1)      p_i = max_k s_i(uvw_k)
    //   average (projMode 2)  p_i = (1/K)·Σ_k s_i(uvw_k)
    // hits = K (0: the slab misses the volume at this pixel); missing = one of the
    // samples fell on a brick the atlas does not hold (read as 0).
    vec4 projectSlab(vec3 base, out int hits, out bool missing) {
      vec4 raw = vec4(0.0);
      hits = 0;
      missing = false;
      float halfSlab = float(slabSteps - 1) * slabDelta * 0.5;
      for (int i = 0; i < 1024; i++) {
        if (i >= slabSteps) break;
        vec3 uvw = texCoord(base + (-halfSlab + float(i) * slabDelta) * sliceNormal);
        if (!inBox(uvw)) continue;
        bool present;
        vec4 s = rawAt(uvw, present);
        if (!present) missing = true;
        if (projMode == 1) raw = max(raw, s);
        else raw += s;
        hits++;
        #ifdef PLANE_TEX
        // A reduced plane already holds the slab's maximum: every further sample in the
        // box reads the same texel and the same presence.
        if (planeReduced == 1) break;
        #endif
      }
      if (hits > 0 && projMode == 2) raw /= float(hits);
      return raw;
    }

    #ifdef FALLBACK_TEX
    // false when the fragment lies outside the fallback picture (nothing to show there).
    bool fallbackColor(vec2 uv, out vec4 color) {
      vec2 fuv = (uv - fallbackRect.xy) / fallbackRect.zw;
      if (any(lessThan(fuv, vec2(0.0))) || any(greaterThan(fuv, vec2(1.0)))) return false;
      color = texture(fallbackTex, fuv);
      return true;
    }
    #endif

    #ifdef RAW_OUTPUT
    #ifdef FALLBACK_TEX
    // 1.0 for a channel always read from the fallback (one the pass did not load).
    uniform vec4 fallbackChannels;

    // The fallback's raw texel under uv (exact bytes, no filtering); false outside it.
    // Its rows are stored top row first, the frame counts them from the bottom.
    bool fallbackRaw(vec2 uv, out vec4 raw) {
      vec2 fuv = (uv - fallbackRect.xy) / fallbackRect.zw;
      if (any(lessThan(fuv, vec2(0.0))) || any(greaterThan(fuv, vec2(1.0)))) return false;
      ivec2 size = textureSize(fallbackTex, 0);
      ivec2 p = clamp(ivec2(floor(fuv * vec2(size))), ivec2(0), size - 1);
      raw = texelFetch(fallbackTex, ivec2(p.x, size.y - 1 - p.y), 0);
      return true;
    }
    #endif
    #endif

    void main() {
      vec2 uv = uvWindow.xy + vec2(vUv.x, flipY > 0.5 ? 1.0 - vUv.y : vUv.y) * uvWindow.zw;
      vec2 pc = (uv - 0.5) * 2.0 * sliceExtent;
      vec3 base = sliceOrigin + pc.x * sliceRight + pc.y * sliceUp;

      #ifdef RAW_OUTPUT
      // Raw values: one plane's texel, or a slab's per-channel projection (projectSlab,
      // quantised to a byte by the target). The colour is applied afterwards
      // (SliceCompositor) with the colour path's own formula, so both paths give the
      // same picture. (0,0,0,0) wherever the colour path leaves the pixel transparent
      // for want of a voxel: outside the box, or a missing brick with no fallback.
      // A projected slab is opaque over the whole volume, black where no channel
      // shows; with fewer than four channels the unused channel 3 carries that
      // coverage (1 inside the volume) so the compositor keeps the outside transparent.
      vec4 raw = vec4(0.0);
      bool missing = false;
      if (projMode == 0 || slabSteps <= 1) {
        vec3 uvw = texCoord(base);
        if (!inBox(uvw)) { fragColor = vec4(0.0); return; }
        bool present;
        raw = rawAt(uvw, present);
        missing = !present;
      } else {
        int hits;
        raw = projectSlab(base, hits, missing);
        if (hits == 0) { fragColor = vec4(0.0); return; }
        if (numChannels < 4) raw.a = 1.0;
      }
      #ifdef FALLBACK_TEX
      vec4 f;
      bool covered = fallbackRaw(uv, f);
      // As the colour path: a plane or slab short of a brick shows the fallback there.
      if (missing) { fragColor = covered ? f : vec4(0.0); return; }
      if (covered) raw = mix(raw, f, fallbackChannels);
      #endif
      fragColor = raw;
      #else
      if (projMode == 0 || slabSteps <= 1) {
        vec3 uvw = texCoord(base);
        if (!inBox(uvw)) discard;
        vec4 s = colorAt(uvw);
        #ifdef FALLBACK_TEX
        if (s.a < 0.5) {
          vec4 f;
          if (fallbackColor(uv, f)) { fragColor = f; return; }
          discard;
        }
        #endif
        if (length(s.rgb) < 0.005) discard;
        fragColor = vec4(s.rgb, 1.0);
        return;
      }

      // A slab: the raw projection first, then the channel window and colour once —
      // the RAW_OUTPUT picture coloured by SliceCompositor, term for term.
      int hits;
      bool missing;
      vec4 p = projectSlab(base, hits, missing);
      if (hits == 0) discard;
      #ifdef FALLBACK_TEX
      // A slab is only as complete as every brick it crosses: keep the preview until
      // the last of them has landed.
      if (missing) {
        vec4 f;
        if (fallbackColor(uv, f)) { fragColor = f; return; }
        discard;
      }
      #endif
      // The raw target stores p as a byte, rounded to the nearest (GLES 3.0 §2.1.6.2);
      // the same rounding here keeps the colour picture byte-equal to the recoloured
      // raw one (a MIP of exact texels is already on that grid; a mean, or a linearly
      // filtered slice stack, is not).
      p = floor(p * 255.0 + 0.5) / 255.0;
      // Opaque over the whole slab, black where no channel shows (no 0.005 cut-off,
      // unlike one plane): the slab reads as one block, as the z-stack shows it.
      fragColor = vec4(composeRaw(p), 1.0);
      #endif
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
      _acquirePass(PREVIEW_SIZE);

      _scene = new THREE.Scene();
      _camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

      _buildMaterial();
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), _mat);
      _scene.add(quad);
      return true;
    } catch (err) {
      _disabled = true;
      _releasePasses();
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
    // Every load hands the material over again: the same program serves it as long as
    // the defines agree (re-linked in place); a rebuild disposes the material it replaces.
    if (_mat && _atlasDefinesKey(_mat) === _atlasDefinesKey(material)) {
      _linkUniforms(_mat.uniforms, material);
    } else {
      const previous = _mat;
      _buildMaterial();
      previous?.dispose?.();
    }
    if (_scene?.children?.[0]) _scene.children[0].material = _mat;
    _scheduleRender();
  }

  // Uniforms read by reference from the volume material: its atlas pages, page table
  // and channel settings (zero copy; a channel edit shows on the next render).
  const LINKED_UNIFORMS = [
    'svrAtlas0', 'svrAtlas1', 'svrAtlas2', 'svrAtlas3', 'svrAtlas4', 'svrAtlas5', 'svrAtlas6', 'svrAtlas7',
    'pageTable', 'atlasDim', 'volumeDim', 'ptDim', 'brickSize', 'slotStride', 'brickApron', 'svrComponents', 'numChannels',
    'color0', 'min0', 'max0', 'gamma0', 'opacity0', 'en0',
    'color1', 'min1', 'max1', 'gamma1', 'opacity1', 'en1',
    'color2', 'min2', 'max2', 'gamma2', 'opacity2', 'en2',
    'color3', 'min3', 'max3', 'gamma3', 'opacity3', 'en3'
  ];

  function _defaultLinkedUniform(k) {
    if (/^svrAtlas\d$/.test(k) || k === 'pageTable') return { value: null };
    if (k === 'atlasDim') return { value: new THREE.Vector3(512, 512, 512) };
    if (k === 'volumeDim' || k === 'ptDim') return { value: new THREE.Vector3(1, 1, 1) };
    if (k === 'brickSize' || k === 'slotStride') return { value: 64.0 };
    if (k === 'brickApron') return { value: 0 };
    if (k === 'svrComponents') return { value: 4 };
    if (k === 'numChannels') return { value: 0 };
    if (/^color\d$/.test(k)) return { value: new THREE.Vector3(1, 1, 1) };
    if (/^max\d$/.test(k) || /^gamma\d$/.test(k) || /^opacity\d$/.test(k)) return { value: 1 };
    return { value: 0 };   // min*, en*
  }

  /** Points `u`'s linked entries at `source`'s own uniform objects (defaults where it has none). */
  function _linkUniforms(u, source) {
    for (const k of LINKED_UNIFORMS) u[k] = source?.uniforms?.[k] || _defaultLinkedUniform(k);
    // The stabilisation warp, by reference too: setTimepointTransform() rewrites the
    // matrix in place for every timepoint, and the slice follows without a rebuild.
    // Unlinked (a material without it), texCoord's identity: cube + ½.
    u.volumeWarp = source?.uniforms?.volumeWarp
      || { value: new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5) };
  }

  function _makeMaterial(source, defines) {
    const u = {};
    _linkUniforms(u, source);
    // Slice-specific uniforms (owned by slicer)
    u.sliceOrigin = { value: new THREE.Vector3() };
    u.sliceRight  = { value: new THREE.Vector3(1,0,0) };
    u.sliceUp     = { value: new THREE.Vector3(0,1,0) };
    u.sliceNormal = { value: new THREE.Vector3(0,0,1) };
    u.sliceExtent = { value: EXTENT };
    u.slabSteps   = { value: 1 };
    u.slabDelta   = { value: 0.005 };
    u.projMode    = { value: 0 };
    u.uvWindow     = { value: new THREE.Vector4(0, 0, 1, 1) };
    u.flipY        = { value: 0 };
    u.fallbackTex  = { value: null };
    u.fallbackRect = { value: new THREE.Vector4(0, 0, 1, 1) };
    u.fallbackChannels = { value: new THREE.Vector4(0, 0, 0, 0) };
    u.planeTex       = { value: null };
    u.planePresence  = { value: null };
    u.planeDim       = { value: new THREE.Vector3(1, 1, 1) };
    u.planeAxis      = { value: 2 };
    u.planeLayerBase = { value: 0 };
    u.planeLayers    = { value: 1 };
    u.planeReduced   = { value: 0 };
    u.planeBrickSize = { value: 64 };

    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines,
      uniforms: u,
      depthTest: false, depthWrite: false,
      // Raw bytes must land untouched: no blending (three r147 already maps an opaque
      // NormalBlending material to NoBlending — stated, not relied upon).
      blending: defines.RAW_OUTPUT ? THREE.NoBlending : THREE.NormalBlending
    });
  }

  // The atlas defines a material samples its pages with (svr-manager.js): sparse or
  // dense, and a compressed atlas's 2D arrays (one or two textures per page).
  const ATLAS_DEFINES = ['ENABLE_SVR', 'SVR_ARRAY', 'SVR_ARRAY_PAIRS'];

  function _copyAtlasDefines(source, defines) {
    if (!source?.defines?.ENABLE_SVR) return defines;
    for (const d of ATLAS_DEFINES) if (source.defines[d]) defines[d] = 1;
    return defines;
  }

  function _atlasDefinesKey(material) {
    return ATLAS_DEFINES.map(d => (material?.defines?.[d] ? 1 : 0)).join('');
  }

  /** The slicer's own material, for the inspector plane on screen (_volumeMaterial). */
  function _buildMaterial() {
    const defines = {};
    _copyAtlasDefines(_volumeMaterial, defines);
    if (samplingSpace(_volumeMaterial)) defines.VOLUME_WARP = 1;
    _mat = _makeMaterial(_volumeMaterial, defines);
  }

  // One material per define set for the explicit renders (renderWithMaterial,
  // renderRawWithMaterial), kept for the page's life and re-linked to each source:
  // three.js caches a program per define set only while a material uses it, and the
  // slice shader (eight sampler3D, a 1024-step slab loop) costs a few hundred
  // milliseconds to compile on ANGLE — disposing the material after every pass
  // recompiled it at every Studio open.
  const _programs = new Map();

  function _foreignMaterial(source, { rawOutput = false, fallback = false, plane = false } = {}) {
    const defines = {};
    if (plane) defines.PLANE_TEX = 1;
    else {
      _copyAtlasDefines(source, defines);
      if (samplingSpace(source)) defines.VOLUME_WARP = 1;
    }
    if (fallback) defines.FALLBACK_TEX = 1;
    if (rawOutput) defines.RAW_OUTPUT = 1;
    const key = Object.keys(defines).sort().join('|') || 'plain';
    let mat = _programs.get(key);
    if (!mat) {
      mat = _makeMaterial(source, defines);
      _programs.set(key, mat);
    } else {
      _linkUniforms(mat.uniforms, source);
    }
    return mat;
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

  /**
   * How `material` maps the slicer's cube space to its texture: null when it reads
   * texture = cube + ½ (no VOLUME_WARP define: every volume but a stabilised
   * timelapse), else the ray-marcher's own state, copied from its uniforms —
   *   warp             cube → texture of the timepoint on screen (volumeWarp),
   *   boxMin, boxSize  the display box in cube units (clipBoxMin / clipBoxSize): the
   *                    enlarged cube geometry, the box the clip sliders act in.
   * A copy: the next timepoint does not move a space already handed out.
   */
  function samplingSpace(material) {
    const u = material?.uniforms;
    if (!material?.defines?.VOLUME_WARP || !u?.volumeWarp?.value?.elements) return null;
    return _normalizeSpace({
      warp: u.volumeWarp.value.elements,
      boxMin: u.clipBoxMin?.value || null,
      boxSize: u.clipBoxSize?.value || null
    });
  }

  /** A space as samplingSpace() returns it, from a Matrix4 / 16 numbers (column-major)
   *  and {x,y,z} / [x,y,z] boxes; null when the warp is missing or singular. */
  function _normalizeSpace(space) {
    if (!space || !space.warp) return null;
    const elements = space.warp.elements || space.warp;
    if (!elements || elements.length !== 16) return null;
    const warp = new THREE.Matrix4().fromArray(Array.from(elements, Number));
    if (!warp.elements.every(Number.isFinite) || !(Math.abs(warp.determinant()) > 1e-12)) return null;
    const vec = (v, fallback) => {
      const a = Array.isArray(v) ? v : (v ? [v.x, v.y, v.z] : null);
      return a && a.length === 3 && a.every(Number.isFinite)
        ? new THREE.Vector3(a[0], a[1], a[2])
        : new THREE.Vector3(fallback, fallback, fallback);
    };
    const boxSize = vec(space.boxSize, 1);
    if (!(boxSize.x > 0 && boxSize.y > 0 && boxSize.z > 0)) boxSize.set(1, 1, 1);
    return { warp, boxMin: vec(space.boxMin, -0.5), boxSize };
  }

  /** The physical extent per axis as planeGeometry reads it (EDGE-035: a missing or
   *  non-positive axis counts as 1), and the longest one. */
  function _physicalAxes(physical) {
    const px = physical && physical.x > 0 ? physical.x : 1;
    const py = physical && physical.y > 0 ? physical.y : 1;
    const pz = physical && physical.z > 0 ? physical.z : 1;
    return { px, py, pz, maxP: Math.max(px, py, pz) || 1 };
  }

  /**
   * Half-side of the square frame, in quad units — the physically proportioned cube
   * frame P = cube ⊙ p_axis/maxP, one unit = the longest physical axis. EXTENT for a
   * volume read unwarped. A stabilised one is shown in its display box, which
   * outgrows the acquisition box by the whole drift of the series; planeGeometry then
   * centres the frame on the display box and the frame is at least the box's
   * half-diagonal in P,
   *   E = max(EXTENT, ½·|boxSize ⊙ p/maxP|),
   * so the cut of ANY plane through the display box fits in it: for X on the plane,
   * |X − c′| ≤ |X − c| ≤ E, c the box centre and c′ its orthogonal projection on the
   * plane (the frame's centre), and the square of half-side E holds the disc of radius
   * E. One value per dataset, not per plane: a Studio pixel is 2E·maxP/renderRes µm.
   */
  function frameExtent(space, physical = null) {
    const s = space ? _normalizeSpace(space) : null;
    if (!s) return EXTENT;
    const { px, py, pz, maxP } = _physicalAxes(physical);
    const half = 0.5 * Math.hypot(s.boxSize.x * px / maxP, s.boxSize.y * py / maxP, s.boxSize.z * pz / maxP);
    return Number.isFinite(half) ? Math.max(EXTENT, half) : EXTENT;
  }

  /**
   * Where `value` ∈ [0, 1] puts a plane of normal `normal` (unit, in P — the normal
   * _computePlaneVectors gives, read as a cube-space vector for the origin): the plane
   * passes through the cube point n·d with
   *   d = offset + value·slope,   offset = (m·c)/(m·n) − ½·slope,   slope = |B ⊙ m|,
   * m = normalize(n ⊙ p/maxP) the plane's unit normal in cube space (= planeGeometry's
   * unwarped texNormal), c and B the centre and size of the box the plane sweeps.
   * Unwarped (no `space`) that box is the volume, c = 0 and B = 1: d = value − ½,
   * the plane of every earlier version, returned as { offset: −½, slope: 1, box: null }.
   * On a stabilised timelapse it is the DISPLAY box (space.boxMin / boxSize), the box
   * the clip sliders act in, which outgrows the acquisition box by the drift of the
   * series: an axis-aligned plane (m = n = ±e_k) sits at c_k ± (value − ½)·B_k —
   * object min_k + value·B_k on +e_k, a clip slider's own mapping — so [0, 1] reaches
   * every slice of the display box; an oblique one sweeps the same share of it an
   * unwarped plane sweeps of the volume, m·x from m·c − ½(m·n)·slope to
   * m·c + ½(m·n)·slope, through the box centre at ½. VolumeViewer places its cut-plane
   * mesh with the same map, so the plane on screen is the plane the slicer samples.
   */
  function _planeSweep(normal, physical, space) {
    const s = space ? _normalizeSpace(space) : null;
    const unwarped = { offset: -0.5, slope: 1, box: null };
    if (!s || !normal) return unwarped;
    const { px, py, pz, maxP } = _physicalAxes(physical);
    const m = new THREE.Vector3(normal.x * px / maxP, normal.y * py / maxP, normal.z * pz / maxP);
    const length = m.length();
    if (!(length > 0)) return unwarped;
    m.divideScalar(length);
    const mn = m.dot(normal);
    const slope = Math.hypot(s.boxSize.x * m.x, s.boxSize.y * m.y, s.boxSize.z * m.z);
    const centre = s.boxMin.clone().addScaledVector(s.boxSize, 0.5);
    const offset = m.dot(centre) / mn - 0.5 * slope;
    if (!(mn > 1e-9) || !(slope > 0) || !Number.isFinite(offset)) return unwarped;
    return { offset, slope, box: { centre, size: s.boxSize.clone() } };
  }

  /** The value a plane spec's position is read from (_computePlaneVectors' rule). */
  function _planeValue(spec) {
    return Number.isFinite(+(spec && spec.value)) ? +spec.value : 0.5;
  }

  /**
   * The sweep of `spec`'s plane (see _planeSweep) — { offset, slope, box } with
   * depth = offset + value·slope along the P normal of the spec, box = the display
   * box ({ centre, size }, cube units) or null unwarped. VolumeViewer reads it to draw
   * and drag its cut plane where the slicer samples it.
   */
  function planeSweep(spec, physical = null, space = null) {
    return _planeSweep(_computePlaneVectors(spec || {}).normal, physical, space);
  }

  /** The depth (cube units, along the spec's P normal) its value puts the plane at. */
  function planeDepth(spec, physical = null, space = null) {
    const sweep = planeSweep(spec, physical, space);
    return sweep.offset + _planeValue(spec) * sweep.slope;
  }

  /** The value that puts `spec`'s plane at `depth` (unclamped): planeDepth's inverse. */
  function planeValueAtDepth(spec, depth, physical = null, space = null) {
    const sweep = planeSweep(spec, physical, space);
    return (Number(depth) - sweep.offset) / sweep.slope;
  }

  /**
   * The slab the shader samples for `spec`, in normalised texture units ([0,1]³ is
   * the volume). The plane is posed in physical space (yaw/pitch/roll, a position
   * along its normal) and drawn with maxP/p_axis anisotropy so that one unit of the
   * quad is the longest physical axis. In texture space that scaling tilts an
   * oblique plane's normal away from its physical one — n_tex ∝ S⁻¹·n with
   * S = diag(maxP/p_x, maxP/p_y, maxP/p_z) — and a sample at parameter t along the
   * scaled normal S·n sits at t·(S·n)·n_tex = t/|S⁻¹n| from the plane, so a slab of
   * `steps` samples spaced `delta` spans (steps − 1)·delta / (2·|S⁻¹n|) either side.
   * Everything that has to agree with the shader (the Studio's native pass choosing
   * its bricks) reads the geometry here instead of re-deriving it.
   *
   * With a sampling `space` (a stabilised timelapse, see samplingSpace) the plane
   * lives in cube space — the display frame, where the cut plane and the clip ranges
   * of the 3D view live —, its value sweeping the display box (_planeSweep: the depth
   * VolumeViewer draws its cut plane at), and the texture is read at W·x (W =
   * space.warp, affine, linear part L). The texture-space plane is then the image of
   * the cube one:
   *   center = W·origin;
   *   normal ∝ L⁻ᵀ·m, m the cube-space unit normal S⁻¹n/|S⁻¹n| (a normal maps by the
   *            inverse transpose: m·(x − o) = 0 ⇔ (L⁻ᵀm)·(W x − W o) = 0);
   *   halfThickness = h·|(L·step)·normal|, h = (steps − 1)·delta/2: the texture
   *            displacement of the outermost sample, measured along that normal.
   * The frame is centred on the display box — sliceOrigin moves within the plane to
   * the orthogonal projection (in P) of the box centre — and its half-side is
   * frameExtent(space), so the whole display box is framed whatever the drift.
   *
   * @param {object} spec  plane spec (mode, value, yaw, pitch, roll, slabThickness,
   *                       slabStepNorm, projection). slabStepNorm is a spacing along
   *                       the normal in cube units (= texture units when unwarped).
   * @param {{x:number,y:number,z:number}|null} physical  physical extent per axis
   *        (µm); a missing or non-positive axis counts as 1 (EDGE-035)
   * @param {object|null} [space]  samplingSpace() of the material the plane is
   *        rendered through; null/omitted = texture = cube + ½ (unchanged geometry)
   * @returns {{ origin: THREE.Vector3, center: THREE.Vector3, right: THREE.Vector3,
   *   up: THREE.Vector3, step: THREE.Vector3, normal: THREE.Vector3, steps: number,
   *   delta: number, projMode: number, projected: boolean, halfThickness: number,
   *   extent: number, warped: boolean }}
   *   origin/right/up/step are the shader's sliceOrigin/sliceRight/sliceUp/
   *   sliceNormal (cube space, centre at 0); center is the plane point the frame is
   *   centred on, in texture space (origin + 0.5 unwarped); normal is the unit normal
   *   of the sampled plane in texture space; halfThickness is half the slab's extent
   *   along that normal (0 for one plane); extent is the frame's half-side (quad
   *   units, the shader's sliceExtent).
   */
  function planeGeometry(spec, physical = null, space = null) {
    const { origin, right, up, normal } = _computePlaneVectors(spec || {});
    const px = physical && physical.x > 0 ? physical.x : 1;
    const py = physical && physical.y > 0 ? physical.y : 1;
    const pz = physical && physical.z > 0 ? physical.z : 1;
    const maxP = Math.max(px, py, pz) || 1;
    const scale = new THREE.Vector3(maxP / px, maxP / py, maxP / pz);
    const rightP = right.clone();
    const upP = up.clone();
    right.multiply(scale);
    up.multiply(scale);
    const step = normal.clone().multiply(scale);
    const texNormal = new THREE.Vector3(normal.x / scale.x, normal.y / scale.y, normal.z / scale.z);
    const texNormalLength = texNormal.length() || 1;
    texNormal.divideScalar(texNormalLength);

    const proj = (spec && spec.projection) || 'single';
    const projMode = proj === 'mip' ? 1 : proj === 'average' ? 2 : 0;
    const steps = Math.max(1, Math.min(MAX_SLAB_STEPS, Math.round(+(spec && spec.slabThickness)) || 1));
    // slabDelta is measured along `step`: a spacing of slabStepNorm texture units
    // along the normal axis is slabStepNorm / |step| delta units. Without a requested
    // spacing the historical 1/256 of the longest physical axis applies.
    let delta = steps > 1 ? (1.0 / 256) : 0;
    const stepNorm = +(spec && spec.slabStepNorm);
    if (steps > 1 && Number.isFinite(stepNorm) && stepNorm > 0) {
      delta = stepNorm / (step.length() || 1);
    }
    const projected = steps > 1 && projMode !== 0;
    const warped = space ? _normalizeSpace(space) : null;
    if (!warped) {
      const halfThickness = projected ? ((steps - 1) * delta * 0.5) / texNormalLength : 0;
      return {
        origin,
        center: origin.clone().addScalar(0.5),
        right,
        up,
        step,
        normal: texNormal,
        steps,
        delta,
        projMode,
        projected,
        halfThickness,
        extent: EXTENT,
        warped: false
      };
    }

    // The plane's position: value sweeps the display box (_planeSweep), where the clip
    // sliders act and the cut plane on screen moves — not the acquisition box, whose
    // [−½, ½] along the normal leaves the drifted part of a late timepoint unreachable.
    const sweep = _planeSweep(normal, physical, warped);
    origin.copy(normal).multiplyScalar(sweep.offset + _planeValue(spec) * sweep.slope);
    // The frame's centre: the display box centre c projected (in P, where rightP /
    // upP / normal are orthonormal) on the plane — origin + a·right + b·up in cube
    // units with a, b the in-plane components of c_P − origin_P (x_P = x / scale).
    const c = warped.boxMin.clone().addScaledVector(warped.boxSize, 0.5);
    const dP = new THREE.Vector3((c.x - origin.x) / scale.x, (c.y - origin.y) / scale.y, (c.z - origin.z) / scale.z);
    const framed = origin.clone().addScaledVector(right, dP.dot(rightP)).addScaledVector(up, dP.dot(upP));
    const linear = new THREE.Matrix3().setFromMatrix4(warped.warp);
    const normalTex = texNormal.clone().applyMatrix3(linear.clone().invert().transpose());
    const normalTexLength = normalTex.length() || 1;
    normalTex.divideScalar(normalTexLength);
    const stepTex = step.clone().applyMatrix3(linear);
    return {
      origin: framed,
      center: framed.clone().applyMatrix4(warped.warp),
      right,
      up,
      step,
      normal: normalTex,
      steps,
      delta,
      projMode,
      projected,
      halfThickness: projected ? (steps - 1) * delta * 0.5 * Math.abs(stepTex.dot(normalTex)) : 0,
      extent: frameExtent(warped, physical),
      warped: true
    };
  }

  function _physicalSize() {
    return (typeof VolumeViewer !== 'undefined' && VolumeViewer.getPhysicalSize)
      ? VolumeViewer.getPhysicalSize()
      : null;
  }

  // The VOLUME_WARP define and the linked volumeWarp uniform follow the source
  // material's: setTimepointTransform() switches the define on and off on the SAME
  // material object (the stabilisation toggle), which updateMaterial() never hears of.
  // three.js caches programs by their defines, so a toggle back reuses the program.
  function _syncWarp(space) {
    const src = _volumeMaterial?.uniforms?.volumeWarp;
    let changed = false;
    if (src && _mat.uniforms.volumeWarp !== src) {
      _mat.uniforms.volumeWarp = src;
      changed = true;
    }
    const want = Boolean(space);
    if (want !== Boolean(_mat.defines?.VOLUME_WARP)) {
      _mat.defines = _mat.defines || {};
      if (want) _mat.defines.VOLUME_WARP = 1;
      else delete _mat.defines.VOLUME_WARP;
      changed = true;
    }
    if (changed) _mat.needsUpdate = true;
  }

  /** The plane uniforms of `mat` for `spec`, sampled through `source`'s space. */
  function _syncUniformsFor(mat, spec, source) {
    const u = mat.uniforms;
    const g = planeGeometry(spec, _physicalSize(), samplingSpace(source));
    u.sliceOrigin.value.copy(g.origin);
    u.sliceRight.value.copy(g.right);
    u.sliceUp.value.copy(g.up);
    u.sliceNormal.value.copy(g.step);
    u.sliceExtent.value = g.extent;
    u.projMode.value = g.projMode;
    u.slabSteps.value = g.steps;
    u.slabDelta.value = g.delta;
  }

  // The atlas defines follow the source material's too: a timelapse shows a cached
  // timepoint by re-publishing its atlas on the SAME material, and a compressed
  // atlas (2D array pages) may follow an uncompressed one there.
  function _syncAtlasDefines() {
    if (!_volumeMaterial || _atlasDefinesKey(_mat) === _atlasDefinesKey(_volumeMaterial)) return;
    _mat.defines = _mat.defines || {};
    for (const d of ATLAS_DEFINES) delete _mat.defines[d];
    _copyAtlasDefines(_volumeMaterial, _mat.defines);
    _mat.needsUpdate = true;
  }

  function _syncUniforms() {
    if (!_mat) return;
    _syncAtlasDefines();
    _syncWarp(samplingSpace(_volumeMaterial));
    _syncUniformsFor(_mat, _spec, _volumeMaterial);
  }

  // ── Rendering ────────────────────────────────────────────

  function _hasRenderableVolume(mat = _mat) {
    return Boolean(mat?.uniforms?.svrAtlas0?.value);
  }

  function _acquirePass(size) {
    let pass = _passes.get(size);
    if (pass) return pass;
    const target = new THREE.WebGLRenderTarget(size, size, {
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType
    });
    pass = { target, buf: new Uint8Array(size * size * 4), img: null };
    _passes.set(size, pass);
    return pass;
  }

  function _releasePasses(keep = []) {
    for (const [size, pass] of _passes) {
      if (keep.includes(size)) continue;
      pass.target?.dispose?.();
      _passes.delete(size);
    }
  }

  /**
   * One draw of `mat` into the w × h corner of `target`, read back into `readInto`;
   * the renderer's target, viewport and autoClear are restored.
   * The viewport is the target's own (target.viewport, which setRenderTarget applies
   * as is), never renderer.setViewport: three multiplies that by the device pixel
   * ratio and floors it, and at a fractional ratio (1.75: Windows at 175 %)
   * (w / pr)·pr lands just below w — the last row and column were never drawn.
   */
  function _drawInto(mat, target, w, h, readInto) {
    const prevTarget = _renderer.getRenderTarget();
    const prevViewport = new THREE.Vector4();
    _renderer.getViewport(prevViewport);
    const prevAutoClear = _renderer.autoClear;
    // The target starts transparent black whatever the page's clear colour: a pixel
    // the colour path discards must read back alpha 0 (the slab footprint, the crop).
    const prevClear = _renderer.getClearColor?.(new THREE.Color()) || null;
    const prevClearAlpha = _renderer.getClearAlpha?.();
    const quad = _scene.children[0];
    const prevMat = quad.material;
    try {
      quad.material = mat;
      target.viewport?.set(0, 0, w, h);
      _renderer.autoClear = true;
      _renderer.setRenderTarget(target);
      if (prevClear) _renderer.setClearColor(0x000000, 0);
      _renderer.clear();
      _renderer.render(_scene, _camera);
      _renderer.readRenderTargetPixels(target, 0, 0, w, h, readInto);
    } finally {
      quad.material = prevMat;
      if (prevClear) _renderer.setClearColor(prevClear, prevClearAlpha);
      _renderer.setRenderTarget(prevTarget);
      _renderer.setViewport(prevViewport);
      _renderer.autoClear = prevAutoClear;
    }
  }

  // ── Render: preview ──────────────────────────────────────

  /** Renders the plane at `size` px into the preview canvas. */
  function _doPreview(size = _previewSize) {
    if (_disabled || !_visible || !_renderer || !_hasRenderableVolume()) return false;
    let pass;
    try {
      pass = _acquirePass(size);
    } catch (err) {
      // The big pass is a refinement: losing it leaves the interactive one.
      if (size === _refineSize) _refineSize = 0;
      console.warn(`[VolumeSlicer] ${size}px preview allocation failed; keeping ${_previewSize}px.`, err);
      return false;
    }
    _syncUniforms();
    _mat.uniforms.uvWindow.value.set(0, 0, 1, 1);
    // Drawn upside down: the readback is already in canvas order.
    _mat.uniforms.flipY.value = 1;
    _drawInto(_mat, pass.target, size, size, pass.buf);

    if (!pass.img) pass.img = _previewCtx.createImageData(size, size);
    pass.img.data.set(pass.buf);
    // Resizing the bitmap clears it; putImageData refills it in the same task.
    if (_previewCanvas.width !== size || _previewCanvas.height !== size) {
      _previewCanvas.width = size;
      _previewCanvas.height = size;
    }
    _previewCtx.putImageData(pass.img, 0, 0);
    return true;
  }

  // ── Render: explicit frames (Studio, captures) ─────────────
  // A frame of renderRes² px, or a window of it, is drawn in square tiles: each tile
  // is its own draw and its own readback, so no single GPU command runs long enough
  // to trip the driver watchdog (Windows TDR, ~2 s: a thick slab samples up to 1024
  // times per pixel), and the target and readback buffer stay tile-sized whatever the
  // frame — they used to be frame-sized and kept for the rest of the session.
  const TILE_MAX = 2048;
  // Atlas fetches one draw may issue (pixels × slab samples): a thick slab gets smaller tiles.
  const TILE_SAMPLE_BUDGET = 1 << 26;
  let _tile = null;        // { target, buf, size }: the tile pass
  let _outCanvas = null;   // { canvas, ctx }: renderHighRes()'s picture, overwritten by the next one

  function _acquireTile(size) {
    if (_tile && _tile.size >= size) return _tile;
    _releaseTile();
    const target = new THREE.WebGLRenderTarget(size, size, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType });
    try {
      _tile = { target, buf: new Uint8Array(size * size * 4), size };
    } catch (err) {
      target.dispose?.();
      throw err;
    }
    return _tile;
  }

  function _releaseTile() {
    _tile?.target?.dispose?.();
    _tile = null;
  }

  /** Tile side for `mat`'s plane: TILE_MAX, shrunk so pixels × slab samples stays in budget. */
  function _tileSideFor(mat, w, h) {
    const u = mat.uniforms;
    const slab = Number(u.projMode?.value) !== 0 ? Math.max(1, Number(u.slabSteps?.value) || 1) : 1;
    // A reduced plane reads one texel per pixel however thick the slab (FRAG: PLANE_TEX).
    const samples = mat.defines?.PLANE_TEX && Number(u.planeReduced?.value) === 1 ? 1 : slab;
    const side = Math.max(256, Math.floor(Math.sqrt(TILE_SAMPLE_BUDGET / samples)));
    return Math.max(1, Math.min(TILE_MAX, side, Math.max(w, h)));
  }

  /**
   * Draws the window `win` ({x, y, w, h}, pixels of a size × size frame, y down) of
   * `mat` tile by tile; sink(tx, ty, tw, th, rows) receives each tile's pixels in
   * canvas order (row r = window row ty + r, tw·4 bytes each). A tile's lowest row in
   * the GL frame is size − (y + ty + th); it is drawn flipped (flipY), so its first
   * row read back is its top one.
   */
  function _renderTiles(mat, size, win, sink) {
    const T = _tileSideFor(mat, win.w, win.h);
    const tile = _acquireTile(T);
    const u = mat.uniforms;
    u.flipY.value = 1;
    for (let ty = 0; ty < win.h; ty += T) {
      for (let tx = 0; tx < win.w; tx += T) {
        const tw = Math.min(T, win.w - tx);
        const th = Math.min(T, win.h - ty);
        u.uvWindow.value.set((win.x + tx) / size, (size - (win.y + ty) - th) / size, tw / size, th / size);
        _drawInto(mat, tile.target, tw, th, tile.buf);
        sink(tx, ty, tw, th, tile.buf);
      }
    }
  }

  /** `window` as integer frame pixels, or null when empty, malformed or the whole frame. */
  function _normalizeWindow(window, size) {
    if (!window) return null;
    const x = Math.max(0, Math.floor(Number(window.x) || 0));
    const y = Math.max(0, Math.floor(Number(window.y) || 0));
    const w = Math.min(size - x, Math.floor(Number(window.w) || 0));
    const h = Math.min(size - y, Math.floor(Number(window.h) || 0));
    if (!(w > 0 && h > 0)) return null;
    if (x === 0 && y === 0 && w === size && h === size) return null;
    return { x, y, w, h };
  }

  /**
   * The frame window {x, y, w, h} a crop rect ({x, y, x2, y2, renderRes}, inclusive
   * pixel bounds) cuts out of a `size` px frame — null when the rect is unusable or
   * drawn at another size.
   */
  function windowForRect(rect, size) {
    if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.x2)) return null;
    if (rect.renderRes && rect.renderRes !== size) return null;
    const minX = Math.max(0, Math.round(rect.x));
    const minY = Math.max(0, Math.round(rect.y));
    const maxX = Math.min(size - 1, Math.round(rect.x2));
    const maxY = Math.min(size - 1, Math.round(rect.y2));
    if (minX > maxX || minY > maxY) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  /** Applies a Studio channel state to `mat`'s (linked) channel uniforms; → restore(). */
  function _applyChannelOverrides(mat, channelOverrides) {
    if (!Array.isArray(channelOverrides)) return () => {};
    const originals = {};
    for (let i = 0; i < 4; i++) {
      const cState = channelOverrides[i];
      if (!cState || !mat.uniforms[`color${i}`]) continue;
      originals[`color${i}`] = mat.uniforms[`color${i}`].value.clone();
      originals[`min${i}`] = mat.uniforms[`min${i}`].value;
      originals[`max${i}`] = mat.uniforms[`max${i}`].value;
      originals[`gamma${i}`] = mat.uniforms[`gamma${i}`].value;
      originals[`opacity${i}`] = mat.uniforms[`opacity${i}`].value;
      originals[`en${i}`] = mat.uniforms[`en${i}`].value;

      if (cState.color) {
        if (typeof cState.color === 'string') {
          const col = new THREE.Color(cState.color);
          mat.uniforms[`color${i}`].value.set(col.r, col.g, col.b);
        } else {
          mat.uniforms[`color${i}`].value.set(cState.color.r/255, cState.color.g/255, cState.color.b/255);
        }
      }
      if (cState.min !== undefined) mat.uniforms[`min${i}`].value = cState.min;
      if (cState.max !== undefined) mat.uniforms[`max${i}`].value = cState.max;
      if (cState.gamma !== undefined) mat.uniforms[`gamma${i}`].value = cState.gamma;
      if (cState.opacity !== undefined) mat.uniforms[`opacity${i}`].value = cState.opacity;
      if (typeof cState.enabled === 'boolean') mat.uniforms[`en${i}`].value = cState.enabled ? 1 : 0;
    }
    return () => {
      for (const k in originals) {
        if (typeof originals[k] === 'object') mat.uniforms[k].value.copy(originals[k]);
        else mat.uniforms[k].value = originals[k];
      }
    };
  }

  function _acquireOutCanvas(w, h) {
    if (_outCanvas && _outCanvas.canvas.width === w && _outCanvas.canvas.height === h) return _outCanvas;
    const canvas = _outCanvas?.canvas || document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    _outCanvas = { canvas, ctx: canvas.getContext('2d') };
    return _outCanvas;
  }

  /** The colour picture of `mat` (window of a size² frame) → the module's canvas, or null. */
  function _renderColour(mat, size, channelOverrides, window) {
    const restore = _applyChannelOverrides(mat, channelOverrides);
    const win = _normalizeWindow(window, size) || { x: 0, y: 0, w: size, h: size };
    try {
      const out = _acquireOutCanvas(win.w, win.h);
      let img = null;
      _renderTiles(mat, size, win, (tx, ty, tw, th, rows) => {
        if (!img || img.width !== tw || img.height !== th) img = out.ctx.createImageData(tw, th);
        img.data.set(rows.subarray(0, tw * th * 4));
        out.ctx.putImageData(img, tx, ty);
      });
      return out.canvas;
    } catch (err) {
      console.warn('[VolumeSlicer] High-res render failed.', err);
      return null;
    } finally {
      restore();
    }
  }

  /**
   * Renders the plane at `size` px (a square frame, getPlaneExtentUnits() across it) and
   * returns the canvas — module-owned, overwritten by the next render and released by
   * releaseHiPass(), so a caller copies what it keeps. `window` = {x, y, w, h} (pixels of
   * that frame, y down) renders that rectangle alone, at the same scale: the same
   * pixels as that part of the full frame, for a fraction of the cost.
   */
  function renderHighRes(size = 1024, channelOverrides = null, window = null) {
    if (_disabled || !_renderer || !_hasRenderableVolume()) return null;
    _syncUniforms();
    return _renderColour(_mat, size, channelOverrides, window);
  }

  // Textures of the fallback pictures (the Studio preview) of explicit renders, kept
  // while the same picture is handed in again (every refresh of a native pass).
  let _fallbackColourTex = null; // { canvas, texture }
  let _fallbackRawTex = null;    // { data, texture }

  /** fallbackRect for a crop rect {x, y, x2, y2, renderRes}: canvas columns [x, x2] and
   *  rows [y, y2] (top-down) of a renderRes frame, in GL orientation (0..1). */
  function _fallbackRectFor(rect) {
    const res = rect.renderRes;
    const x = Math.max(0, Math.round(rect.x));
    const y = Math.max(0, Math.round(rect.y));
    const x2 = Math.min(res - 1, Math.round(rect.x2));
    const y2 = Math.min(res - 1, Math.round(rect.y2));
    return new THREE.Vector4(x / res, (res - 1 - y2) / res, (x2 - x + 1) / res, (y2 - y + 1) / res);
  }

  function _validRect(rect) {
    return Boolean(rect && Number.isFinite(rect.renderRes) && rect.renderRes > 0 && Number.isFinite(rect.x) && Number.isFinite(rect.x2));
  }

  /**
   * One render of `spec` through `material` (its atlas, page table and channel
   * uniforms) at `size` px, the module's own material and plane left untouched.
   * `options.fallback = { canvas, rect }` paints `canvas` — a picture of the same
   * plane, cropped to `rect` ({x, y, x2, y2, renderRes}: its own frame, any size) —
   * wherever a brick the plane crosses is missing from `material`'s atlas, so a
   * partial atlas renders as "native where landed, preview elsewhere" instead of
   * black holes. `options.window` = {x, y, w, h} renders that part of the frame alone
   * (see renderHighRes). The program is shared by every source with the same defines.
   */
  function renderWithMaterial(material, spec, size = 1024, channelOverrides = null, options = null) {
    if (_disabled || !_renderer || !material || !_scene) return null;
    const fb = options?.fallback;
    const hasFallback = Boolean(fb?.canvas && _validRect(fb.rect));
    const mat = _foreignMaterial(material, { fallback: hasFallback });
    if (!_hasRenderableVolume(mat)) return null;
    if (hasFallback) {
      if (!_fallbackColourTex || _fallbackColourTex.canvas !== fb.canvas) {
        _fallbackColourTex?.texture?.dispose?.();
        const texture = new THREE.CanvasTexture(fb.canvas);
        // A non-power-of-two picture sampled 1:1: no mipmaps.
        texture.generateMipmaps = false;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        _fallbackColourTex = { canvas: fb.canvas, texture };
      }
      // flipY (the CanvasTexture default) puts the canvas's last row at v = 0, as the
      // GL frame counts rows.
      mat.uniforms.fallbackTex.value = _fallbackColourTex.texture;
      mat.uniforms.fallbackRect.value.copy(_fallbackRectFor(fb.rect));
    }
    _syncUniformsFor(mat, { ..._spec, ...(spec || {}) }, material);
    return _renderColour(mat, size, channelOverrides, options?.window || null);
  }

  /**
   * Gives back the tile pass and the module canvas of the explicit renders (tile-sized
   * target and readback buffer, the last picture's canvas): a Studio pass or a capture
   * calls it once done. The next render allocates them again.
   */
  function releaseHiPass() {
    _releaseTile();
    if (_outCanvas) {
      _outCanvas.canvas.width = 0;
      _outCanvas.canvas.height = 0;
      _outCanvas = null;
    }
  }

  /**
   * End of a pass: drops the fallback textures and the references the shared programs
   * hold to the pass's atlas / plane textures (the programs themselves stay compiled),
   * and the tile pass (releaseHiPass).
   */
  function releaseForeign() {
    _fallbackColourTex?.texture?.dispose?.();
    _fallbackColourTex = null;
    _fallbackRawTex?.texture?.dispose?.();
    _fallbackRawTex = null;
    for (const mat of _programs.values()) {
      const u = mat.uniforms;
      _linkUniforms(u, null);
      u.fallbackTex.value = null;
      u.planeTex.value = null;
      u.planePresence.value = null;
    }
    releaseHiPass();
  }

  function _isRawPicture(raw) {
    if (!raw || !ArrayBuffer.isView(raw.data) || raw.data.BYTES_PER_ELEMENT !== 1) return false;
    const w = Number(raw.width);
    const h = Number(raw.height);
    return Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && raw.data.length >= w * h * 4;
  }

  /**
   * One render of `spec` through `material`'s atlas at `size` px that returns the RAW
   * channel values instead of colours (the RAW_OUTPUT variant of the slice shader):
   * RGBA = channels 0..3 as the colour math reads them, per-channel max / mean across
   * a slab, (0,0,0,0) outside the volume and where a brick is missing with no
   * fallback. The target is RGBA8 with no blending and no colour-space step, so the
   * bytes are the atlas's own (a mean is rounded to the nearest byte).
   *   options.window           {x, y, w, h}: that part of the frame alone (renderHighRes)
   *   options.fallbackRaw      { raw, rect }: a raw picture of the same plane, cropped to
   *                            rect ({x, y, x2, y2, renderRes} of ITS frame — any
   *                            resolution: it is looked up by frame position); read
   *                            wherever a brick is missing — a DataTexture of its exact
   *                            bytes (a 2D canvas would premultiply channel 3 away)
   *   options.fallbackChannels channel indices always taken from the fallback where it
   *                            covers the pixel (channels the pass did not load)
   *   options.plane            a createPlaneVolume() handle: the voxels come from it
   *                            instead of `material`'s atlas (an axis-aligned plane of
   *                            an unwarped volume only); `material` still gives the
   *                            channel count
   *   options.out              a raw this function returned before, of the same size:
   *                            refilled in place (`version` + 1) instead of allocating
   * @returns {{data: Uint8Array, width: number, height: number, channels: number,
   *   projected: boolean, coverage: boolean, version?: number}|null}
   *   rows top-down (canvas order); `data` is the caller's; `channels` is the volume's
   *   channel count (the numChannels uniform); `projected` marks a slab (MIP / average
   *   over more than one sample), which SliceCompositor draws opaque over the whole
   *   volume as the colour path does; `coverage` marks a projected slab of fewer than
   *   four channels, whose unused channel 3 is 255 inside the volume and 0 outside it
   *   (the part of the frame the colour path leaves transparent)
   */
  function renderRawWithMaterial(material, spec, size = 1024, options = null) {
    if (_disabled || !_renderer || !material || !_scene) return null;
    const plane = options?.plane && options.plane.texture ? options.plane : null;
    // The plane texture holds unwarped voxels: a stabilised timelapse keeps the atlas.
    if (plane && samplingSpace(material)) return null;
    const fb = options?.fallbackRaw;
    const hasFallback = Boolean(_isRawPicture(fb?.raw) && _validRect(fb.rect));
    const mat = _foreignMaterial(material, { rawOutput: true, fallback: hasFallback, plane: Boolean(plane) });
    if (plane) _bindPlane(mat, plane);
    else if (!_hasRenderableVolume(mat)) return null;
    if (hasFallback) {
      if (!_fallbackRawTex || _fallbackRawTex.data !== fb.raw.data) {
        _fallbackRawTex?.texture?.dispose?.();
        const texture = new THREE.DataTexture(fb.raw.data, fb.raw.width, fb.raw.height, THREE.RGBAFormat, THREE.UnsignedByteType);
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        texture.flipY = false;
        texture.premultiplyAlpha = false;
        texture.unpackAlignment = 1;
        texture.needsUpdate = true;
        _fallbackRawTex = { data: fb.raw.data, texture };
      }
      mat.uniforms.fallbackTex.value = _fallbackRawTex.texture;
      mat.uniforms.fallbackRect.value.copy(_fallbackRectFor(fb.rect));
    }
    const only = Array.isArray(options?.fallbackChannels) ? options.fallbackChannels : [];
    mat.uniforms.fallbackChannels.value.set(...[0, 1, 2, 3].map(c => (hasFallback && only.includes(c) ? 1 : 0)));
    _syncUniformsFor(mat, { ..._spec, ...(spec || {}) }, material);
    try {
      return _renderRaw(mat, size, options?.window || null, options?.out || null);
    } catch (err) {
      console.warn('[VolumeSlicer] Raw render failed.', err);
      return null;
    }
  }

  function _renderRaw(mat, size, window, out) {
    const win = _normalizeWindow(window, size) || { x: 0, y: 0, w: size, h: size };
    const reuse = _isRawPicture(out) && out.width === win.w && out.height === win.h ? out : null;
    let data;
    try {
      data = reuse ? reuse.data : new Uint8Array(win.w * win.h * 4);
    } catch (err) {
      console.warn('[VolumeSlicer] Raw readback allocation failed.', err);
      return null;
    }
    const stride = win.w * 4;
    _renderTiles(mat, size, win, (tx, ty, tw, th, rows) => {
      const row = tw * 4;
      for (let r = 0; r < th; r++) data.set(rows.subarray(r * row, (r + 1) * row), (ty + r) * stride + tx * 4);
    });
    const u = mat.uniforms;
    const channels = Math.max(1, Math.min(4, Math.round(Number(u.numChannels?.value)) || 4));
    // The shader's own test for a slab (projMode ≠ 0 and more than one sample).
    const projected = Number(u.projMode?.value) !== 0 && Number(u.slabSteps?.value) > 1;
    // The shader writes the coverage when numChannels < 4 (the uniform, not the clamp above).
    const coverage = projected && Number(u.numChannels?.value) < 4;
    if (reuse) {
      // New contents in the same buffer: SliceCompositor re-uploads on a new version.
      reuse.version = (Number(reuse.version) || 0) + 1;
      reuse.channels = channels;
      reuse.projected = projected;
      reuse.coverage = coverage;
      return reuse;
    }
    return { data, width: win.w, height: win.h, channels, projected, coverage };
  }

  // ── Axis-aligned plane volumes (the Studio's native pass without a 3D atlas) ──

  const _PLANE_AXES = { x: ['y', 'z'], y: ['x', 'z'], z: ['x', 'y'] };

  function _planeError(code, message) {
    return Object.assign(new Error(message), { code });
  }

  /**
   * A 2D array texture holding the voxel planes an axis-aligned slice reads, for
   * renderRawWithMaterial(…, { plane }): texel (u, v, layer) = voxel (u, v) of plane
   * `layer`, (u, v) the two axes other than the normal one in x, y, z order — W × H ×
   * layers × 4 bytes (one 5735² plane: 132 MB) instead of a 64³ atlas slot per brick.
   *   desc = { axis: 'x' | 'y' | 'z', dims: {x, y, z} (voxels of the level), layers,
   *            layerBase (voxel index along the normal of layer 0), reduced (one layer
   *            holding a slab's maximum), brickSize }
   * Returns { texture, presence, width, height, layers, bytes, upload(u0, v0, w, h,
   * layer, data) → bool, setPresent(bu, bv, layer, on), flushErrors() → [{bu, bv,
   * layer}], dispose() }. Throws err.code 'PLANE_UNSUPPORTED' (no WebGL2, a side above
   * MAX_TEXTURE_SIZE, too many layers) or 'PLANE_ALLOC_FAILED' (the GPU refused it).
   * A brick column (bu, bv) of a layer is sampled only once setPresent() marked it: a
   * texel never written is never read (the shader reads "no brick" there, as the atlas
   * would before the brick lands).
   */
  function createPlaneVolume(desc = {}) {
    const gl = _renderer?.getContext?.();
    const axes = _PLANE_AXES[desc.axis];
    if (!gl || !axes || typeof gl.texStorage3D !== 'function' || !THREE.DataArrayTexture) {
      throw _planeError('PLANE_UNSUPPORTED', 'Plane volumes need WebGL2 array textures');
    }
    const dims = desc.dims || {};
    const W = Math.floor(Number(dims[axes[0]]) || 0);
    const H = Math.floor(Number(dims[axes[1]]) || 0);
    const L = Math.max(1, Math.floor(Number(desc.layers) || 1));
    const bs = Math.max(1, Math.floor(Number(desc.brickSize) || 64));
    const maxTex = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0;
    const maxLayers = Number(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS)) || 0;
    if (!(W > 0 && H > 0) || W > maxTex || H > maxTex || L > maxLayers) {
      throw _planeError('PLANE_UNSUPPORTED', `A ${W} × ${H} × ${L} plane exceeds this GPU's texture limits (${maxTex} px, ${maxLayers} layers)`);
    }
    for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++) { /* drain stale errors */ }
    const texture = new THREE.DataArrayTexture(null, W, H, L);
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.UnsignedByteType;
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.unpackAlignment = 1;
    const tex = gl.createTexture();
    const bind = () => {
      if (_renderer.state?.bindTexture) _renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      else gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    };
    bind();
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, W, H, L);
    const allocError = gl.getError();
    if (allocError !== gl.NO_ERROR) {
      gl.deleteTexture(tex);
      throw _planeError('PLANE_ALLOC_FAILED', `The GPU refused a ${W} × ${H} × ${L} plane texture (glError ${allocError})`);
    }
    // three binds this texture object for the planeTex sampler; it never uploads it
    // (version 0), so the storage above is the one sampled.
    const props = _renderer.properties.get(texture);
    props.__webglTexture = tex;
    props.__webglInit = true;
    props.__version = texture.version;

    const cu = Math.ceil(W / bs);
    const cv = Math.ceil(H / bs);
    const presenceData = new Uint8Array(cu * cv * L);
    const presence = new THREE.DataArrayTexture(presenceData, cu, cv, L);
    presence.format = THREE.RedFormat;
    presence.type = THREE.UnsignedByteType;
    presence.minFilter = THREE.NearestFilter;
    presence.magFilter = THREE.NearestFilter;
    presence.generateMipmaps = false;
    presence.unpackAlignment = 1;
    presence.needsUpdate = true;

    let unchecked = [];
    let disposed = false;
    const handle = {
      axis: desc.axis,
      width: W,
      height: H,
      layers: L,
      layerBase: Math.max(0, Math.floor(Number(desc.layerBase) || 0)),
      reduced: Boolean(desc.reduced),
      brickSize: bs,
      dims: { x: Number(dims.x) || 1, y: Number(dims.y) || 1, z: Number(dims.z) || 1 },
      texture,
      presence,
      bytes: W * H * L * 4,
      /** One tile (w × h texels, RGBA rows of u) at (u0, v0) of `layer`. → false when it does not fit. */
      upload(u0, v0, w, h, layer, data) {
        if (disposed || !data || !(w > 0 && h > 0)) return false;
        if (u0 < 0 || v0 < 0 || u0 + w > W || v0 + h > H || layer < 0 || layer >= L) return false;
        if (data.length < w * h * 4) return false;
        bind();
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
        if (gl.UNPACK_FLIP_Y_WEBGL !== undefined) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        if (gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL !== undefined) gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        if (gl.PIXEL_UNPACK_BUFFER) gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, u0, v0, layer, w, h, 1, gl.RGBA, gl.UNSIGNED_BYTE,
          data.length === w * h * 4 ? data : data.subarray(0, w * h * 4));
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        unchecked.push({ bu: Math.floor(u0 / bs), bv: Math.floor(v0 / bs), layer });
        return true;
      },
      setPresent(bu, bv, layer, on = true) {
        if (bu < 0 || bv < 0 || bu >= cu || bv >= cv || layer < 0 || layer >= L) return;
        presenceData[(layer * cv + bv) * cu + bu] = on ? 255 : 0;
        presence.needsUpdate = true;
      },
      /**
       * One gl.getError() for the uploads since the last call. WebGL cannot say which
       * call failed, so on an error every column uploaded since is marked absent again
       * and returned (the caller counts its bricks as missing).
       */
      flushErrors() {
        const window = unchecked;
        unchecked = [];
        if (disposed || !window.length) return [];
        const err = gl.getError();
        if (err === gl.NO_ERROR) return [];
        for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++) { /* drain */ }
        window.forEach(t => handle.setPresent(t.bu, t.bv, t.layer, false));
        console.warn(`[VolumeSlicer] Plane texture upload failed (glError=${err}); ${window.length} tile(s) left out.`);
        return window;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        try { gl.deleteTexture(tex); } catch (e) { /* context lost */ }
        props.__webglTexture = null;
        props.__webglInit = false;
        texture.dispose();
        presence.dispose();
      }
    };
    return handle;
  }

  function _bindPlane(mat, plane) {
    const u = mat.uniforms;
    u.planeTex.value = plane.texture;
    u.planePresence.value = plane.presence;
    u.planeDim.value.set(plane.dims.x, plane.dims.y, plane.dims.z);
    u.planeAxis.value = plane.axis === 'x' ? 0 : plane.axis === 'y' ? 1 : 2;
    u.planeLayerBase.value = plane.layerBase;
    u.planeLayers.value = plane.layers;
    u.planeReduced.value = plane.reduced ? 1 : 0;
    u.planeBrickSize.value = plane.brickSize;
  }

  /**
   * Histograms of a raw slice for the channel panel, in VolumeViewer.
   * getChannelHistograms()'s shape (see SliceCompositor.histograms).
   * `slice` = { raw, width, height } with raw a raw picture or its bytes.
   */
  function computeChannelHistograms(slice, bins = 256) {
    if (typeof SliceCompositor === 'undefined' || !slice) return [];
    const raw = _isRawPicture(slice.raw)
      ? slice.raw
      : { data: slice.raw, width: Number(slice.width), height: Number(slice.height) };
    return SliceCompositor.histograms(raw, bins);
  }

  function _scheduleRender() {
    if (_disabled) return;
    _cancelRefine();
    if (_rafId) return;
    _rafId = requestAnimationFrame(() => {
      _rafId = null;
      _doPreview(_previewSize);
      _armRefine();
    });
  }

  function _armRefine() {
    if (!_visible || !(_refineSize > _previewSize)) return;
    _refineTimer = setTimeout(() => {
      _refineTimer = null;
      _doPreview(_refineSize);
    }, REFINE_DELAY_MS);
  }

  function _cancelRefine() {
    if (_refineTimer) { clearTimeout(_refineTimer); _refineTimer = null; }
  }

  /** The sharpest render available, now — for a capture of what is on screen. */
  function flushPreview() {
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    _cancelRefine();
    return _doPreview(_refineSize > _previewSize ? _refineSize : _previewSize);
  }

  /**
   * Resolution of the preview canvas: `size` for every interactive render, and
   * an optional sharper `refineSize` drawn once the plane settles. Sizes are
   * clamped to [64, MAX_PREVIEW_SIZE] and rounded to a multiple of 8.
   */
  function setPreviewResolution(size = PREVIEW_SIZE, refineSize = 0) {
    const snap = (v) => {
      const n = Math.round(Number(v) / 8) * 8;
      return Number.isFinite(n) && n > 0 ? Math.max(64, Math.min(MAX_PREVIEW_SIZE, n)) : 0;
    };
    const next = snap(size) || PREVIEW_SIZE;
    const refine = snap(refineSize);
    const nextRefine = refine > next ? refine : 0;
    if (next === _previewSize && nextRefine === _refineSize) return;
    _previewSize = next;
    _refineSize = nextRefine;
    _cancelRefine();
    _releasePasses([_previewSize, _refineSize]);
    if (_visible) _scheduleRender();
  }

  function getPreviewResolution() {
    return { size: _previewSize, refineSize: _refineSize };
  }

  /**
   * The slice re-coloured with `channelState`. A slice that carries its raw values is
   * re-coloured from them: same pixels, same frame, no re-render (its atlas may be
   * gone — the Studio's native pass). A 'gpu-slicer' / 'zstack' capture without raw is
   * rendered again through the volume material, at its own frame (renderRes) and crop
   * (cropRect) when it carries them — the plane on screen is not touched.
   */
  function recompose(sliceResult, channelState) {
    if (!sliceResult) return null;
    if (_isRawPicture(sliceResult.raw) && typeof SliceCompositor !== 'undefined') {
      const canvas = SliceCompositor.compose(sliceResult.raw, channelState, { numChannels: sliceResult.raw.channels });
      return canvas ? { ...sliceResult, canvas, width: canvas.width, height: canvas.height } : null;
    }
    if (sliceResult.source !== 'gpu-slicer' && sliceResult.source !== 'zstack') return null;
    if (!_volumeMaterial) return null;
    const size = Number(sliceResult.renderRes) > 0 ? Math.round(sliceResult.renderRes) : (Number(sliceResult.width) || 1024);
    const window = Number(sliceResult.renderRes) > 0 ? windowForRect(sliceResult.cropRect, size) : null;
    const canvas = renderWithMaterial(_volumeMaterial, sliceResult.planeSpec || getPlaneSpec(), size, channelState, { window });
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
      merged.slabThickness = Math.min(MAX_SLAB_STEPS, Math.max(1, Math.round(+merged.slabThickness) || 1));
    }
    if ('slabStepNorm' in merged) {
      const step = +merged.slabStepNorm;
      merged.slabStepNorm = Number.isFinite(step) && step > 0 ? Math.min(1, step) : null;
    }
    // Only the plane's own keys reach the spec: a sibling panel's spec also carries
    // `visible`, `normal`, `orientation`, `axis`, which must not ride back into
    // VolumeViewer.setPlaneSpec through the next slider move.
    for (const k of Object.keys(merged)) { if (!PLANE_KEYS.includes(k)) delete merged[k]; }
    Object.assign(_spec, merged);
    if (_visible) _scheduleRender();
    _listeners.forEach(cb => cb({ ..._spec }));
  }

  function getPlaneSpec() { return { ..._spec }; }

  function setVisible(v) {
    const next = _disabled ? false : Boolean(v);
    const changed = next !== _visible;
    _visible = next;
    if (next) _scheduleRender();
    else _cancelRefine();
    if (changed) {
      _visibleListeners.forEach(cb => {
        try { cb(next); } catch (err) { console.warn('[VolumeSlicer] visibility listener failed:', err); }
      });
    }
  }

  /** Fires with true/false when the slice goes on or off screen (not on a repeat). */
  function onVisibleChange(cb) {
    if (typeof cb !== 'function') return () => {};
    _visibleListeners.add(cb);
    return () => _visibleListeners.delete(cb);
  }

  function isVisible() { return _visible; }

  function getPreviewCanvas() { return _previewCanvas; }

  function onChange(cb) {
    _listeners.add(cb);
    return () => _listeners.delete(cb);
  }

  function dispose() {
    if (_rafId) cancelAnimationFrame(_rafId);
    _rafId = null;
    _cancelRefine();
    _releasePasses();
    releaseForeign();
    for (const mat of _programs.values()) mat.dispose();
    _programs.clear();
    _mat?.dispose();
    _scene = null;
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
    setPreviewResolution,
    getPreviewResolution,
    flushPreview,
    onVisibleChange,
    /** Quad units drawn across the frame's width (= height): 2 × frameExtent — 2 ×
     *  EXTENT unless `material` (default: the linked volume material) samples a
     *  stabilised timelapse, whose display box can need a larger frame. */
    getPlaneExtentUnits: (material) => 2 * frameExtent(
      samplingSpace(material === undefined ? _volumeMaterial : material), _physicalSize()),
    planeGeometry,
    planeSweep,
    planeDepth,
    planeValueAtDepth,
    samplingSpace,
    frameExtent,
    renderHighRes,
    renderWithMaterial,
    renderRawWithMaterial,
    createPlaneVolume,
    windowForRect,
    releaseForeign,
    releaseHiPass,
    recompose,
    computeChannelHistograms,
    onChange,
    dispose,
    /** Force an immediate preview render (e.g. after channel change) */
    refresh: _scheduleRender
  };
})();

// Expose on window so parent frames (compare.js) can access via iframe.contentWindow
window.VolumeSlicer = VolumeSlicer;
