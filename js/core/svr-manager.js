/* ============================================================
   IRIBHM Microscopy Platform — Sparse Volume Renderer atlas
   ============================================================
   Holds the bricks of one level of a volume in 3D texture "pages" (up to
   eight, the shader's svrAtlas0..7) plus a page table: one texel per
   brick of the volume grid, RGB = the brick's slot (x, y, z) inside its
   page, A = page index + 1 (0 = no brick; the shader skips it).

   A slot is 64³ voxels of `components` bytes (4 = RGBA8, the default: one
   channel per byte). The atlas is sized BEFORE allocation against a VRAM
   budget (SVRManager.vramBudget): a level that does not fit is refused up
   front, so the caller picks a coarser level instead of attempting a
   multi-GiB texture the driver may accept and then page or lose.
   ============================================================ */

class SVRManager {
  // ── VRAM budget ─────────────────────────────────────────────────────────────
  /**
   * What the page can tell about the GPU before allocating anything.
   * `gpuClass` comes from the unmasked renderer string (WEBGL_debug_renderer_info;
   * absent in some browsers): 'software' (SwiftShader, llvmpipe…), 'discrete'
   * (NVIDIA, Radeon RX/Pro, Intel Arc), 'integrated' (Intel HD/UHD/Iris, Apple,
   * AMD APU "Radeon Graphics", mobile GPUs) or 'unknown'.
   */
  static gpuInfo(renderer) {
    let rendererName = null;
    try {
      const gl = renderer?.getContext?.();
      const ext = gl?.getExtension?.('WEBGL_debug_renderer_info');
      if (ext) rendererName = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') || null;
      if (!rendererName && gl?.getParameter && gl.RENDERER !== undefined) rendererName = String(gl.getParameter(gl.RENDERER) || '') || null;
    } catch (e) { /* no context */ }
    const name = rendererName || '';
    let gpuClass = 'unknown';
    if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(name)) gpuClass = 'software';
    else if (/nvidia|geforce|quadro|tesla|\brtx\b|\bgtx\b|radeon\s*(rx|pro|vii|r9|r7)|firepro|intel.*\barc\b/i.test(name)) gpuClass = 'discrete';
    else if (/intel|iris|uhd|hd graphics|apple|mali|adreno|powervr|vivante|radeon\(tm\) graphics|radeon graphics|vega \d+ graphics/i.test(name)) gpuClass = 'integrated';
    const dm = typeof navigator !== 'undefined' && Number.isFinite(Number(navigator.deviceMemory)) ? Number(navigator.deviceMemory) : null;
    const max3D = Math.max(64, renderer?.capabilities?.max3DTextureSize || 2048);
    return { renderer: rendererName, gpuClass, deviceMemoryGB: dm, max3D };
  }

  /**
   * The VRAM the atlases of this page may take, in bytes, and where it comes from.
   * Heuristic (no browser API reports VRAM): software 256 MiB; integrated / unified
   * memory 2 GiB with ≥ 8 GB of device memory, 1 GiB with ≥ 4 GB or unknown, else
   * 512 MiB; discrete 4 GiB (3 GiB on a machine reporting < 8 GB); unknown 2 GiB with
   * ≥ 8 GB, else 1 GiB. Each WebGL context loss noted in the last week halves it (floor
   * 256 MiB), and an allocation that failed in this session caps it below that size.
   * An operator override (SVRManager.setVramBudget, or localStorage
   * 'lumen3d.vramBudgetMB') replaces the heuristic, still under the failure cap.
   */
  static vramBudget(renderer) {
    const info = SVRManager.gpuInfo(renderer);
    const GiB = 1024 * 1024 * 1024;
    const MiBb = 1024 * 1024;
    const dm = info.deviceMemoryGB;
    let bytes;
    if (info.gpuClass === 'software') bytes = 256 * MiBb;
    else if (info.gpuClass === 'integrated') bytes = dm === null ? GiB : dm >= 8 ? 2 * GiB : dm >= 4 ? GiB : 512 * MiBb;
    else if (info.gpuClass === 'discrete') bytes = (dm === null || dm >= 8) ? 4 * GiB : 3 * GiB;
    else bytes = (dm !== null && dm >= 8) ? 2 * GiB : GiB;
    let source = 'heuristic';
    const override = SVRManager._overrideBytes();
    if (override) { bytes = override; source = 'override'; }
    const losses = SVRManager._recentContextLosses();
    if (losses > 0 && source !== 'override') bytes = Math.max(256 * MiBb, bytes / Math.pow(2, losses));
    if (Number.isFinite(SVRManager._failedAllocBytes)) bytes = Math.min(bytes, SVRManager._failedAllocBytes - 1);
    return { bytes: Math.max(0, Math.floor(bytes)), source, contextLosses: losses, ...info };
  }

  /** Session override of the budget, in bytes (null clears it). */
  static setVramBudget(bytes) {
    SVRManager._sessionOverrideBytes = Number.isFinite(Number(bytes)) && Number(bytes) > 0 ? Number(bytes) : null;
  }

  static _overrideBytes() {
    if (SVRManager._sessionOverrideBytes) return SVRManager._sessionOverrideBytes;
    try {
      const mb = Number(typeof localStorage !== 'undefined' ? localStorage.getItem('lumen3d.vramBudgetMB') : null);
      if (Number.isFinite(mb) && mb > 0) return mb * 1024 * 1024;
    } catch (e) { /* storage blocked */ }
    return null;
  }

  /**
   * Record a WebGL context loss: the budget is halved for the rest of the week (on
   * this browser profile), so the next load picks a coarser level instead of looping
   * on the allocation that lost the context.
   */
  static noteContextLost() {
    const now = Date.now();
    SVRManager._sessionLosses = (SVRManager._sessionLosses || 0) + 1;
    try {
      if (typeof localStorage === 'undefined') return;
      const list = SVRManager._storedLosses().filter(t => now - t < SVRManager.CONTEXT_LOSS_MEMORY_MS);
      list.push(now);
      localStorage.setItem('lumen3d.gpuContextLosses', JSON.stringify(list.slice(-8)));
    } catch (e) { /* storage blocked: the session count still applies */ }
  }

  /** Forget the recorded context losses and the failure cap (operator action). */
  static resetGpuBudget() {
    SVRManager._sessionLosses = 0;
    SVRManager._failedAllocBytes = Infinity;
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem('lumen3d.gpuContextLosses'); } catch (e) { /* storage blocked */ }
  }

  static _storedLosses() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('lumen3d.gpuContextLosses') : null;
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter(Number.isFinite) : [];
    } catch (e) { return []; }
  }

  static _recentContextLosses() {
    const now = Date.now();
    const stored = SVRManager._storedLosses().filter(t => now - t < SVRManager.CONTEXT_LOSS_MEMORY_MS).length;
    return Math.min(4, Math.max(stored, SVRManager._sessionLosses || 0));
  }

  static slotBytes(components = 4, brickSize = 64) {
    return brickSize * brickSize * brickSize * components;
  }

  /** Bytes held right now by the atlases of every live manager of this page. */
  static liveAtlasBytes(except = null) {
    let total = 0;
    for (const m of SVRManager._live) if (m !== except) total += m.atlasBytes || 0;
    return total;
  }

  /**
   * The atlas layout holding `targetSlots` slots with the least waste: pages of
   * dim × dim × depth voxels (dim ∈ {256, 512, 1024}, depth a multiple of 64), all
   * pages the same size (the shader reads one atlasDim), at most 8 pages, no page
   * above `maxPageBytes`. A page of dim² × depth holds (dim/64)² · depth/64 slots, so
   * the waste is under one 64-voxel layer per page: ≤ 15 slots per page at dim 256,
   * ≤ 63 at 512. Null when no layout fits (too many slots for 8 pages).
   */
  static planAtlas(targetSlots, { max3D = 2048, components = 4, maxPageBytes = 512 * 1024 * 1024, brickSize = 64 } = {}) {
    const target = Math.max(1, Math.ceil(Number(targetSlots) || 1));
    const slotBytes = SVRManager.slotBytes(components, brickSize);
    let best = null;
    for (const dim of [256, 512, 1024]) {
      if (dim > max3D) continue;
      const perLayer = (dim / brickSize) * (dim / brickSize);
      const maxLayers = Math.min(Math.floor(max3D / brickSize), Math.floor(maxPageBytes / (perLayer * slotBytes)));
      if (maxLayers < 1) continue;
      const pages = Math.ceil(target / (perLayer * maxLayers));
      if (pages > SVRManager.MAX_PAGES) continue;
      const layers = Math.ceil(target / (pages * perLayer));
      const slots = pages * layers * perLayer;
      const plan = { dim, depth: layers * brickSize, pages, slots, bytes: slots * slotBytes, components };
      if (!best || plan.slots < best.slots || (plan.slots === best.slots && plan.pages < best.pages)) best = plan;
    }
    return best;
  }

  /** Largest page the budget allows: 512 MiB, or 1 GiB once the budget exceeds 4 GiB
   *  (a D3D11 resource above a quarter of the dedicated VRAM is refused by the driver). */
  static _maxPageBytes(budgetBytes) {
    return budgetBytes > 4 * 1024 * 1024 * 1024 ? 1024 * 1024 * 1024 : 512 * 1024 * 1024;
  }

  /**
   * How many 64³ slots an atlas may hold on this GPU, budget permitting (the atlases
   * already allocated are NOT subtracted unless `includeLive`; init() does subtract
   * them). The viewer uses it to choose a coarser level BEFORE allocating.
   */
  static maxSlotsForBudget(renderer, { components = 4, budgetBytes = null, includeLive = false, brickSize = 64 } = {}) {
    const budget = Number.isFinite(Number(budgetBytes)) && budgetBytes !== null ? Number(budgetBytes) : SVRManager.vramBudget(renderer).bytes;
    const available = Math.max(0, budget - (includeLive ? SVRManager.liveAtlasBytes() : 0));
    const max3D = Math.max(64, renderer?.capabilities?.max3DTextureSize || 2048);
    const maxPageBytes = SVRManager._maxPageBytes(budget);
    // Capacity of the largest layout the texture limits allow.
    let capacity = 0;
    for (const dim of [256, 512, 1024]) {
      if (dim > max3D) continue;
      const perLayer = (dim / brickSize) * (dim / brickSize);
      const maxLayers = Math.min(Math.floor(max3D / brickSize), Math.floor(maxPageBytes / (perLayer * SVRManager.slotBytes(components, brickSize))));
      if (maxLayers >= 1) capacity = Math.max(capacity, perLayer * maxLayers * SVRManager.MAX_PAGES);
    }
    return Math.max(0, Math.min(capacity, Math.floor(available / SVRManager.slotBytes(components, brickSize))));
  }

  /** Back-compatible name: the slot ceiling for this GPU's budget (RGBA8 slots). */
  static estimateMaxSlots(renderer, brickSize = 64) {
    return SVRManager.maxSlotsForBudget(renderer, { brickSize });
  }

  static slotsPerAtlasForConfig(config, brickSize = 64) {
    return (config.dim / brickSize) * (config.dim / brickSize) * (config.depth / brickSize);
  }

  static slotsForConfig(config, brickSize = 64) {
    return SVRManager.slotsPerAtlasForConfig(config, brickSize) * (config.pages || 1);
  }

  constructor() {
    this.atlasDim = 512;
    this.atlasDepth = 512;
    this.brickSize = 64;
    this.atlasPages = 1;
    this.components = 4;
    this.slotsX = this.atlasDim / this.brickSize;
    this.slotsY = this.atlasDim / this.brickSize;
    this.slotsZ = this.atlasDepth / this.brickSize;
    this.slotsPerAtlas = this.slotsX * this.slotsY * this.slotsZ;
    this.maxSlots = this.slotsPerAtlas * this.atlasPages;
    this.atlasBytes = 0;

    this.atlases = [];
    // Per-channel writes (writeBrick) need the slot's other channels to upload a
    // whole texel: a CPU copy of the slot, kept only until the slot is recycled.
    this.slotData = new Map();
    this.pageTable = null;
    this.pageData = null;

    this.brickMap = new Map();  // "bx_by_bz" -> slotIndex
    this._lru = new Map();      // slotIndex -> true, least recently used first
    this.slotQueue = [];        // kept for callers that reset it; the LRU is _lru
    this.freeSlots = [];
    this.slotToBrick = [];

    this.volumeDim = null;
    this.ptNx = 0; this.ptNy = 0; this.ptNz = 0;
    this.channels = 0;
    this.renderer = null;
    this.material = null;
    this._atlasWebglTextures = [];
    // Uploads not yet checked with gl.getError() (see flushUploadErrors).
    this._unchecked = [];
    this.errorCheckInterval = 32;
    this.onUploadError = null;
    this._scratch = null;
  }

  /**
   * Allocate the atlas for one level of `volumeDim` voxels.
   * options:
   *   targetSlots   bricks to hold (the level's non-empty bricks). The smallest layout
   *                 holding them is allocated; if it is over budget or the GPU refuses
   *                 it, init throws (err.code 'SVR_OVER_BUDGET' / 'SVR_ALLOC_FAILED')
   *                 and the caller should try a coarser level — a larger layout is
   *                 never tried after a failure.
   *                 Without it, the largest layout up to 4096 slots the budget allows,
   *                 halved on each GPU refusal.
   *   components    4 (RGBA8, default), 2 (RG8) or 1 (R8) bytes per voxel. With 1 or 2
   *                 the shader must compile out channels ≥ components (a R8/RG8 texel
   *                 samples as (r,0,0,1)/(r,g,0,1): alpha 1 would read as a full channel
   *                 3) and every upload passes `components` bytes per voxel.
   *   budgetBytes   replaces SVRManager.vramBudget(renderer).bytes for this atlas.
   *   ignoreBudget  allocate whatever the GPU accepts (operator override).
   *   countLiveAtlases (default true) subtract the atlases of the other live managers.
   */
  init(channels, volumeDim, renderer, material, options = {}) {
    this._releaseGpuResources();
    this.channels = channels;
    this.volumeDim = volumeDim;
    this.renderer = renderer;
    this.material = material;
    this.components = [1, 2, 4].includes(Number(options.components)) ? Number(options.components) : 4;
    this.brickMap.clear();
    this._lru = new Map();
    this.slotQueue = [];
    this.freeSlots = [];
    this.slotToBrick = [];
    this.slotData.clear();
    this._unchecked = [];

    this.ptNx = Math.ceil(volumeDim.x / this.brickSize);
    this.ptNy = Math.ceil(volumeDim.y / this.brickSize);
    this.ptNz = Math.ceil(volumeDim.z / this.brickSize);

    const MiBb = 1024 * 1024;
    const max3D = Math.max(64, renderer?.capabilities?.max3DTextureSize || 2048);
    const budget = Number.isFinite(Number(options.budgetBytes)) && options.budgetBytes !== null && options.budgetBytes !== undefined
      ? Number(options.budgetBytes)
      : SVRManager.vramBudget(renderer).bytes;
    const others = options.countLiveAtlases === false ? 0 : SVRManager.liveAtlasBytes(this);
    const available = options.ignoreBudget ? Infinity : Math.max(0, budget - others);
    const maxPageBytes = SVRManager._maxPageBytes(options.ignoreBudget ? Infinity : budget);
    const slotBytes = SVRManager.slotBytes(this.components, this.brickSize);
    const requested = Math.ceil(Number(options.targetSlots) || 0);
    const targeted = requested > 1;

    let target = targeted
      ? requested
      : Math.max(1, Math.min(4096, Number.isFinite(available) ? Math.floor(available / slotBytes) : 4096));
    let allocated = null;
    let lastError = null;
    for (;;) {
      const plan = SVRManager.planAtlas(target, { max3D, components: this.components, maxPageBytes, brickSize: this.brickSize });
      if (!plan) {
        throw Object.assign(new Error(`SVR atlas cannot hold ${target} bricks within ${SVRManager.MAX_PAGES} pages of the 3D texture limit (${max3D})`),
          { code: 'SVR_OVER_BUDGET', neededSlots: target });
      }
      if (plan.bytes > available) {
        if (targeted) {
          throw Object.assign(new Error(`SVR atlas for ${target} bricks needs ${Math.round(plan.bytes / MiBb)} MiB, ` +
            `over the VRAM budget (${Math.round(available / MiBb)} MiB available of ${Math.round(budget / MiBb)} MiB)`),
            { code: 'SVR_OVER_BUDGET', neededBytes: plan.bytes, availableBytes: available, budgetBytes: budget });
        }
        // Layouts round up to whole layers: step down until one fits.
        target = Math.min(target - 1, Math.floor(available / slotBytes));
        if (target < 1) throw Object.assign(new Error('No VRAM budget left for an SVR atlas'), { code: 'SVR_OVER_BUDGET' });
        continue;
      }
      try {
        this._allocatePages(plan);
        allocated = plan;
        break;
      } catch (err) {
        lastError = err;
        // Never try this size again in this session, and never a larger one now — unless
        // the context was lost: then every call fails, whatever its size, and the cap
        // would outlive the restored context (noteContextLost lowers the budget instead).
        const lostContext = Boolean(this.renderer?.getContext?.()?.isContextLost?.());
        if (!lostContext) SVRManager._failedAllocBytes = Math.min(SVRManager._failedAllocBytes, plan.bytes);
        console.warn(`[SVRManager] Atlas ${plan.dim}x${plan.dim}x${plan.depth}x${plan.pages} (${Math.round(plan.bytes / MiBb)} MiB) rejected by the GPU.`, err);
        if (targeted || plan.slots <= 16) break;
        target = Math.floor(plan.slots / 2);
      }
    }
    if (!allocated) {
      throw Object.assign(new Error('SVR atlas GPU allocation failed' + (lastError ? ': ' + lastError.message : '')),
        { code: 'SVR_ALLOC_FAILED' });
    }
    // slotToBrick and freeSlots are sized on the FINAL maxSlots (BUG-035).
    this.slotToBrick = new Array(this.maxSlots).fill(null);
    this.freeSlots = [];
    for (let i = this.maxSlots - 1; i >= 0; i--) this.freeSlots.push(i);
    this.atlasBytes = allocated.bytes;
    SVRManager._live.add(this);

    this.pageData = new Uint8Array(this.ptNx * this.ptNy * this.ptNz * 4);
    const TextureClass = THREE.Data3DTexture || THREE.DataTexture3D;
    this.pageTable = new TextureClass(this.pageData, this.ptNx, this.ptNy, this.ptNz);
    this.pageTable.format = THREE.RGBAFormat;
    this.pageTable.type = THREE.UnsignedByteType;
    this.pageTable.minFilter = THREE.NearestFilter; // MUST be nearest for exact slot fetching
    this.pageTable.magFilter = THREE.NearestFilter;
    this.pageTable.unpackAlignment = 1;
    this.pageTable.needsUpdate = true;

    this.updateUniforms();
  }

  _allocatePages(plan) {
    this._applyAtlasConfig(plan);
    const TextureClass = THREE.Data3DTexture || THREE.DataTexture3D;
    const format = this.components === 1 ? THREE.RedFormat : this.components === 2 ? THREE.RGFormat : THREE.RGBAFormat;
    const pages = [];
    try {
      for (let page = 0; page < this.atlasPages; page++) {
        const atlas = new TextureClass(null, this.atlasDim, this.atlasDim, this.atlasDepth);
        atlas.format = format;
        atlas.type = THREE.UnsignedByteType;
        // SVR slots are packed edge-to-edge in the atlas. Linear filtering would
        // interpolate with neighboring slots at brick boundaries and create seams.
        atlas.minFilter = THREE.NearestFilter;
        atlas.magFilter = THREE.NearestFilter;
        atlas.unpackAlignment = 1;
        pages.push(atlas);
        if (this.renderer) this._initAtlasTexture(atlas);
        atlas.needsUpdate = false;
      }
    } catch (err) {
      for (const atlas of pages) {
        this._disposeAtlasTexture(atlas);
        atlas.dispose?.();
      }
      // SVR-012: drain the GL errors of the refused allocation so they are not read
      // as the failure of a later upload.
      const gl = this.renderer?.getContext?.();
      if (gl && typeof gl.getError === 'function') {
        for (let i = 0; i < 16 && gl.getError() !== gl.NO_ERROR; i++) { /* drain */ }
      }
      throw err;
    }
    this.atlases = pages;
  }

  _applyAtlasConfig(config) {
    this.atlasDim = config.dim;
    this.atlasDepth = config.depth;
    this.atlasPages = config.pages || 1;
    this.slotsX = this.atlasDim / this.brickSize;
    this.slotsY = this.atlasDim / this.brickSize;
    this.slotsZ = this.atlasDepth / this.brickSize;
    this.slotsPerAtlas = SVRManager.slotsPerAtlasForConfig(config, this.brickSize);
    this.maxSlots = this.slotsPerAtlas * this.atlasPages;
  }

  _glFormats(gl) {
    if (this.components === 1) return { internal: gl.R8, format: gl.RED };
    if (this.components === 2) return { internal: gl.RG8, format: gl.RG };
    return { internal: gl.RGBA8, format: gl.RGBA };
  }

  _initAtlasTexture(atlas) {
    const gl = this.renderer.getContext();
    for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++) {
      // Drain stale errors before testing this atlas allocation.
    }
    const tex = gl.createTexture();
    let prevBinding = null;
    if (this.renderer.state && this.renderer.state.bindTexture) {
      this.renderer.state.bindTexture(gl.TEXTURE_3D, tex);
    } else {
      prevBinding = gl.getParameter(gl.TEXTURE_BINDING_3D);
      gl.bindTexture(gl.TEXTURE_3D, tex);
    }

    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    if (gl.PIXEL_UNPACK_BUFFER) {
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    }
    const { internal, format } = this._glFormats(gl);
    if (typeof gl.texStorage3D === 'function') {
      gl.texStorage3D(gl.TEXTURE_3D, 1, internal, this.atlasDim, this.atlasDim, this.atlasDepth);
    } else {
      gl.texImage3D(gl.TEXTURE_3D, 0, internal, this.atlasDim, this.atlasDim, this.atlasDepth, 0, format, gl.UNSIGNED_BYTE, null);
    }

    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      gl.deleteTexture(tex);
      if (prevBinding !== null) {
        gl.bindTexture(gl.TEXTURE_3D, prevBinding);
      }
      throw new Error(`SVR atlas GPU allocation failed (${this.atlasDim}x${this.atlasDim}x${this.atlasDepth}, glError=${err})`);
    }
    if (prevBinding !== null) {
      gl.bindTexture(gl.TEXTURE_3D, prevBinding);
    }

    const properties = this.renderer.properties.get(atlas);
    properties.__webglTexture = tex;
    properties.__webglInit = true;
    properties.__version = atlas.version;
    this._atlasWebglTextures.push(tex);
  }

  _disposeAtlasTexture(atlas) {
    if (!atlas || !this.renderer) return;
    const properties = this.renderer.properties?.get?.(atlas);
    const tex = properties?.__webglTexture;
    if (!tex) return;
    try {
      this.renderer.getContext().deleteTexture(tex);
    } catch (err) {
      console.warn('[SVRManager] Failed to delete manual atlas texture:', err);
    }
    const idx = this._atlasWebglTextures.indexOf(tex);
    if (idx >= 0) this._atlasWebglTextures.splice(idx, 1);
    properties.__webglTexture = null;
    properties.__webglInit = false;
  }

  _releaseGpuResources() {
    if (this.pageTable) {
      this.pageTable.dispose();
      this.pageTable = null;
    }
    if (this.renderer) {
      for (const atlas of this.atlases) {
        this._disposeAtlasTexture(atlas);
      }
    }
    for (const atlas of this.atlases) {
      atlas?.dispose?.();
    }
    this.atlases = [];
    this._atlasWebglTextures = [];
    this.atlasBytes = 0;
    SVRManager._live.delete(this);
  }

  _slotCoord(slotIndex) {
    const atlas = Math.floor(slotIndex / this.slotsPerAtlas);
    const localSlot = slotIndex % this.slotsPerAtlas;
    const slotsXY = this.slotsX * this.slotsY;
    return {
      atlas,
      x: localSlot % this.slotsX,
      y: Math.floor(localSlot / this.slotsX) % this.slotsY,
      z: Math.floor(localSlot / slotsXY)
    };
  }

  /** Does this manager still own the GPU resources the shader needs? False once
   *  dispose()/_releaseGpuResources() has run — the atlases and the page table are
   *  gone, and publishing that state would switch ENABLE_SVR on with nothing bound. */
  isUsable() {
    return Boolean(this.pageTable) && this.atlases.length > 0;
  }

  updateUniforms() {
    if (!this.material) return false;
    // SVR-014: a released manager must never publish: an unbound sampler3D reads as
    // (0,0,0,1), i.e. page 254 "brick present" for every voxel.
    if (!this.isUsable()) {
      console.warn('[SVRManager] updateUniforms() on a released manager — refusing to publish (atlases/page table are gone).');
      return false;
    }
    this.material.defines.ENABLE_SVR = 1;
    this.material.needsUpdate = true;

    if (this.material.uniforms.svrPageCount) {
      this.material.uniforms.svrPageCount.value = this.atlases.length;
    }
    this.material.uniforms.pageTable.value = this.pageTable;
    this.material.uniforms.atlasDim.value = new THREE.Vector3(this.atlasDim, this.atlasDim, this.atlasDepth);
    this.material.uniforms.volumeDim.value = new THREE.Vector3(this.volumeDim.x, this.volumeDim.y, this.volumeDim.z);
    this.material.uniforms.ptDim.value = new THREE.Vector3(this.ptNx, this.ptNy, this.ptNz);

    // ptScale maps logical coords 0..1 to PageTable coords 0..1
    const scaleX = (this.volumeDim.x) / (this.ptNx * this.brickSize);
    const scaleY = (this.volumeDim.y) / (this.ptNy * this.brickSize);
    const scaleZ = (this.volumeDim.z) / (this.ptNz * this.brickSize);
    this.material.uniforms.ptScale.value = new THREE.Vector3(scaleX, scaleY, scaleZ);
    this.material.uniforms.brickSize.value = this.brickSize;

    this.material.uniforms.svrAtlas0.value = this.atlases[0] || null;
    for (let i = 1; i < SVRManager.MAX_PAGES; i++) {
      const u = this.material.uniforms['svrAtlas' + i];
      if (u) u.value = this.atlases[i] || this.atlases[0] || null;
    }
    return true;
  }

  /** The slot of a brick (assigned on first use, least recently used recycled). */
  getSlot(bx, by, bz) {
    const key = `${bx}_${by}_${bz}`;
    if (this.brickMap.has(key)) {
      const slot = this.brickMap.get(key);
      this._lru.delete(slot);
      this._lru.set(slot, true);
      return slot;
    }

    let slotIndex;
    if (this.freeSlots.length > 0) {
      slotIndex = this.freeSlots.pop();
    } else {
      slotIndex = this._lru.keys().next().value;
      this._lru.delete(slotIndex);
      const oldKey = this.slotToBrick[slotIndex];
      if (oldKey) {
        this.brickMap.delete(oldKey);
        const [px, py, pz] = oldKey.split('_').map(Number);
        const ptIdx = (pz * this.ptNx * this.ptNy + py * this.ptNx + px) * 4;
        this.pageData[ptIdx + 3] = 0; // invalidate
        this.slotToBrick[slotIndex] = null;
      }
    }
    // A recycled slot's CPU copy holds the evicted brick's channels: never reuse it.
    this.slotData.delete(slotIndex);

    this.brickMap.set(key, slotIndex);
    this.slotToBrick[slotIndex] = key;
    this._lru.set(slotIndex, true);
    return slotIndex;
  }

  _pointPageTable(bx, by, bz, coord) {
    // ELE-23 (BUG-002): always (re)point the PageTable at the slot getSlot just
    // assigned: it may have been recycled from another brick by eviction.
    const ptIdx = (bz * this.ptNx * this.ptNy + by * this.ptNx + bx) * 4;
    this.pageData[ptIdx + 0] = coord.x;
    this.pageData[ptIdx + 1] = coord.y;
    this.pageData[ptIdx + 2] = coord.z;
    this.pageData[ptIdx + 3] = coord.atlas + 1;
    this.pageTable.needsUpdate = true;
    return ptIdx;
  }

  /**
   * One channel of a brick (scalar voxels, bs³, z-major). The slot's other channels
   * come from a CPU copy of the slot, dropped when the slot is recycled; prefer
   * writeRgbaBrick (all channels at once, nothing kept in JS memory).
   */
  writeBrick(channel, bx, by, bz, brickData, bw, bh, bd) {
    if (channel >= this.channels || channel >= this.components) return false;
    const slotIndex = this.getSlot(bx, by, bz);
    const coord = this._slotCoord(slotIndex);
    const ptIdx = this._pointPageTable(bx, by, bz, coord);
    this._writeChannelToSlot(slotIndex, channel, brickData, bw, bh, bd);
    const uploadData = this._extractSlotRegion(slotIndex, bw, bh, bd);
    return this._finishUpload(bx, by, bz, slotIndex, ptIdx,
      this._uploadRgbaRegion(coord.atlas, coord.x * this.brickSize, coord.y * this.brickSize, coord.z * this.brickSize, bw, bh, bd, uploadData));
  }

  /**
   * A whole brick, `components` bytes per voxel interleaved (channel c in byte c),
   * either bs³ voxels or exactly the bw × bh × bd box inside the volume (a composed
   * brick cut with cropToVolume, uploaded as it is). Returns false when the upload
   * was refused (the page-table entry is then left empty: the shader skips it).
   */
  writeRgbaBrick(bx, by, bz, brickData, bw, bh, bd) {
    const uploadData = this._compactRgbaBrickData(brickData, bw, bh, bd);
    if (!uploadData) return false;
    const slotIndex = this.getSlot(bx, by, bz);
    const coord = this._slotCoord(slotIndex);
    const ptIdx = this._pointPageTable(bx, by, bz, coord);
    return this._finishUpload(bx, by, bz, slotIndex, ptIdx,
      this._uploadRgbaRegion(coord.atlas, coord.x * this.brickSize, coord.y * this.brickSize, coord.z * this.brickSize, bw, bh, bd, uploadData));
  }

  /**
   * Upload only the sub-box [rx, rx+rw) x [ry, ry+rh) x [rz, rz+rd) of a brick's slot.
   * `data` holds that box alone (tightly packed, `components` bytes per voxel,
   * z-major). The page table points at the slot exactly as for a whole brick, so the
   * caller guarantees that nothing outside the box is ever sampled: a slice through
   * the volume reads one voxel plane of each brick it crosses. The rest of the slot
   * keeps whatever it held (undefined on a fresh atlas) — this is for a throwaway
   * atlas, never the ray-marcher's own.
   */
  writeRgbaBrickRegion(bx, by, bz, data, rx, ry, rz, rw, rh, rd) {
    const bs = this.brickSize;
    if (!data || !(rw > 0 && rh > 0 && rd > 0)) return false;
    if (rx < 0 || ry < 0 || rz < 0 || rx + rw > bs || ry + rh > bs || rz + rd > bs) return false;
    const needed = rw * rh * rd * this.components;
    if (data.length < needed) return false;
    const slotIndex = this.getSlot(bx, by, bz);
    const coord = this._slotCoord(slotIndex);
    const ptIdx = this._pointPageTable(bx, by, bz, coord);
    const upload = data.length === needed ? data : data.subarray(0, needed);
    return this._finishUpload(bx, by, bz, slotIndex, ptIdx, this._uploadRgbaRegion(
      coord.atlas,
      coord.x * bs + rx, coord.y * bs + ry, coord.z * bs + rz,
      rw, rh, rd, upload
    ));
  }

  _finishUpload(bx, by, bz, slotIndex, ptIdx, result) {
    if (result === false) {
      this.pageData[ptIdx + 3] = 0;
      this.pageTable.needsUpdate = true;
      return false;
    }
    if (result === 'unchecked') {
      const key = `${bx}_${by}_${bz}`;
      this._unchecked.push({ key, slotIndex, ptIdx });
      if (this._unchecked.length >= this.errorCheckInterval) {
        return !this.flushUploadErrors().includes(key);
      }
    }
    return true;
  }

  /**
   * Points the page-table entry of every brick for which `isEmpty(bx, by, bz)` holds at
   * one shared slot of zeros, so a brick the level does not store (dropped as empty by
   * the packer's ESS) reads as zero voxels instead of "no brick here". Only for a
   * throwaway atlas sized with one slot to spare: the slicer's FALLBACK_TEX variant
   * shows its fallback picture wherever no brick backs a sample, and a slab crossing an
   * ESS-dropped brick would keep the preview for good. The slot is taken out of the
   * free list and never recycled. → the number of entries pointed (0: no free slot, or
   * the zero upload was refused — the entries stay "no brick").
   */
  pointEmptyBricks(isEmpty) {
    if (typeof isEmpty !== 'function' || !this.pageData || !this.freeSlots.length) return 0;
    const bs = this.brickSize;
    const slotIndex = this.freeSlots.pop();
    const coord = this._slotCoord(slotIndex);
    const gl = this.renderer?.getContext?.();
    if (gl && typeof gl.getError === 'function') {
      for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++) { /* drain stale errors */ }
    }
    const zeros = new Uint8Array(bs * bs * bs * this.components);
    const result = this._uploadRgbaRegion(coord.atlas, coord.x * bs, coord.y * bs, coord.z * bs, bs, bs, bs, zeros);
    const refused = result === false || (result === 'unchecked' && gl && gl.getError() !== gl.NO_ERROR);
    if (refused) {
      this.freeSlots.push(slotIndex);
      return 0;
    }
    let pointed = 0;
    for (let bz = 0; bz < this.ptNz; bz++) {
      for (let by = 0; by < this.ptNy; by++) {
        for (let bx = 0; bx < this.ptNx; bx++) {
          if (!isEmpty(bx, by, bz)) continue;
          this._pointPageTable(bx, by, bz, coord);
          pointed++;
        }
      }
    }
    return pointed;
  }

  /**
   * One gl.getError() for every upload since the last check (it is a synchronous
   * round trip to the GPU process, too slow to pay per brick). WebGL keeps the first
   * error until it is read and cannot say which call raised it, so on an error every
   * brick of the window is treated as missing: its page-table entry is cleared (the
   * shader skips it rather than sampling uninitialised memory) and its key returned —
   * and passed to `onUploadError(keys, glError)` — for the caller to load again.
   * Runs by itself every `errorCheckInterval` uploads; call it at the end of a stream.
   */
  flushUploadErrors() {
    const window = this._unchecked;
    this._unchecked = [];
    if (!window.length || !this.renderer) return [];
    const gl = this.renderer.getContext?.();
    if (!gl || typeof gl.getError !== 'function') return [];
    const err = gl.getError();
    if (err === gl.NO_ERROR) return [];
    for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++) { /* drain */ }
    const failed = [];
    for (const { key, slotIndex, ptIdx } of window) {
      if (this.slotToBrick[slotIndex] !== key) continue;   // recycled since: not ours to clear
      this.pageData[ptIdx + 3] = 0;
      failed.push(key);
    }
    if (failed.length) {
      this.pageTable.needsUpdate = true;
      console.warn(`[SVRManager] texSubImage3D failed (glError=${err}); ${failed.length} brick(s) left out of the atlas.`);
      try { this.onUploadError?.(failed, err); } catch (e) { console.error(e); }
    }
    return failed;
  }

  _compactRgbaBrickData(brickData, bw, bh, bd) {
    if (!brickData) return null;
    const bs = this.brickSize;
    const comps = this.components;
    const required = bw * bh * bd * comps;
    if (brickData.length === required) return brickData;
    if (brickData.length < bs * bs * bs * comps) return null;
    // texSubImage3D copies synchronously, so one scratch buffer serves every upload.
    if (!this._scratch || this._scratch.length < required) this._scratch = new Uint8Array(bs * bs * bs * comps);
    const uploadData = this._scratch.subarray(0, required);
    let dst = 0;
    const len = bw * comps;
    for (let lz = 0; lz < bd; lz++) {
      const srcZOff = lz * bs * bs * comps;
      for (let ly = 0; ly < bh; ly++) {
        const srcIdx = srcZOff + ly * bs * comps;
        uploadData.set(brickData.subarray(srcIdx, srcIdx + len), dst);
        dst += len;
      }
    }
    return uploadData;
  }

  _slotBuffer(slotIndex) {
    let slot = this.slotData.get(slotIndex);
    if (!slot) {
      slot = new Uint8Array(this.brickSize * this.brickSize * this.brickSize * this.components);
      this.slotData.set(slotIndex, slot);
    }
    return slot;
  }

  _writeChannelToSlot(slotIndex, channel, brickData, bw, bh, bd) {
    if (!brickData) return;
    const slot = this._slotBuffer(slotIndex);
    const bs = this.brickSize;
    const comps = this.components;
    for (let lz = 0; lz < bd; lz++) {
      const srcZOff = lz * bs * bs;
      for (let ly = 0; ly < bh; ly++) {
        let srcIdx = srcZOff + ly * bs;
        let dstIdx = ((lz * bs + ly) * bs) * comps + channel;
        for (let lx = 0; lx < bw; lx++) {
          slot[dstIdx] = brickData[srcIdx++] || 0;
          dstIdx += comps;
        }
      }
    }
  }

  _extractSlotRegion(slotIndex, bw, bh, bd) {
    const slot = this._slotBuffer(slotIndex);
    return this._compactRgbaBrickData(slot, bw, bh, bd);
  }

  /**
   * texSubImage3D of a box into one page. Returns false when nothing was uploaded
   * (no data, no such page, a box outside the page, a page without GPU storage),
   * 'unchecked' after a real upload (its GL error is read in flushUploadErrors), and
   * true without a renderer (headless bookkeeping, unit tests).
   */
  _uploadRgbaRegion(atlasIndex, sx, sy, sz, bw, bh, bd, uploadData) {
    if (!this.renderer) return true;
    const atlas = this.atlases[atlasIndex];
    if (!atlas || !uploadData) return false;
    if (
      sx < 0 || sy < 0 || sz < 0 ||
      sx + bw > this.atlasDim ||
      sy + bh > this.atlasDim ||
      sz + bd > this.atlasDepth
    ) {
      console.warn('[SVRManager] Skipping out-of-bounds atlas upload', {
        sx, sy, sz, bw, bh, bd, atlasIndex, atlasDim: this.atlasDim, atlasDepth: this.atlasDepth
      });
      return false;
    }

    const properties = this.renderer.properties.get(atlas);
    const webglTexture = properties?.__webglTexture;
    if (!webglTexture) return false;
    const gl = this.renderer.getContext();
    let prevBinding = null;
    if (this.renderer.state && this.renderer.state.bindTexture) {
      this.renderer.state.bindTexture(gl.TEXTURE_3D, webglTexture);
    } else {
      prevBinding = gl.getParameter(gl.TEXTURE_BINDING_3D);
      gl.bindTexture(gl.TEXTURE_3D, webglTexture);
    }

    // Unpack state is client-side (no GPU round trip). three.js sets FLIP_Y /
    // PREMULTIPLY per texture it uploads (true for a canvas texture), and either one
    // left true makes a texSubImage3D from an ArrayBufferView an INVALID_OPERATION.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
    if (gl.UNPACK_FLIP_Y_WEBGL !== undefined) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL !== undefined) gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (gl.PIXEL_UNPACK_BUFFER) {
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    }

    gl.texSubImage3D(gl.TEXTURE_3D, 0, sx, sy, sz, bw, bh, bd, this._glFormats(gl).format, gl.UNSIGNED_BYTE, uploadData);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    if (prevBinding !== null) {
      gl.bindTexture(gl.TEXTURE_3D, prevBinding);
    }
    return 'unchecked';
  }

  dispose() {
    this._releaseGpuResources();
    this.pageData = null;
    if (this.slotData) this.slotData.clear();
    this.brickMap.clear();
    this._lru = new Map();
    this.slotQueue = [];
    this.freeSlots = [];
    this.slotToBrick = [];
    this._unchecked = [];
    this._scratch = null;
  }
}

SVRManager.MAX_PAGES = 8;   // the shader's svrAtlas0..7
SVRManager.CONTEXT_LOSS_MEMORY_MS = 7 * 24 * 3600 * 1000;
SVRManager._live = new Set();
SVRManager._failedAllocBytes = Infinity;
SVRManager._sessionLosses = 0;
SVRManager._sessionOverrideBytes = null;

window.SVRManager = SVRManager;
