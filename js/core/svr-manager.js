/* ============================================================
   IRIBHM Microscopy Platform — Sparse Volume Renderer atlas
   ============================================================
   Holds the bricks of one level of a volume in 3D texture "pages" (up to
   eight, the shader's svrAtlas0..7) plus a page table: one texel per
   brick of the volume grid, RGB = the brick's slot (x, y, z) inside its
   page, A = page index + 1 (0 = no brick; the shader skips it).

   A slot holds one brick: 64³ voxels on a v2 tree, 66³ on a v3 tree (the
   64³ interior plus a 1-voxel border, DOCS/dataset-migrations/SPEC.md
   §13.2), of `components` bytes per voxel (4 = RGBA8, the default; 2 = RG8
   and 1 = R8 for datasets of two and one channels). The slot edge is the
   "stride" (64 or 66) every layout, byte count and upload offset is measured
   in. A bordered atlas is sampled with hardware trilinear filtering: a sample
   inside a brick reads texel slotOrigin + 1 + local, whose 2×2×2 footprint
   never leaves the slot, so the filter is seamless across bricks; a v2 atlas
   keeps nearest filtering (no border: a linear fetch would blend the next
   slot's brick in).

   The atlas is sized BEFORE allocation against a VRAM budget
   (SVRManager.vramBudget): a level that does not fit is refused up front, so
   the caller picks a coarser level instead of attempting a multi-GiB texture
   the driver may accept and then page or lose.

   role 'detail' (region-of-interest streaming, volume-viewer.js): the same
   atlas published under the detail* uniforms and the ROI_DETAIL define, at
   most DETAIL_MAX_PAGES pages (the shader's detailAtlas0..3).

   compression 'bc' (the display atlas of a timelapse, volume-viewer.js): the
   pages hold the GPU's RGTC blocks (bc-codec.js) — BC4 for one channel, BC5
   for two, two textures per page for three or four channels (BC5 + BC4 /
   BC5 + BC5, the shader's svrAtlas0..3 and svrAtlas4..7, so at most four
   pages). Half a byte per voxel and channel instead of one: twice the bricks
   in the same VRAM, uploaded as they arrive (the GPU decodes in hardware).
   WebGL2 refuses RGTC in a TEXTURE_3D (ANGLE: "requires TEXTURE_2D_ARRAY"), so
   a compressed page is a 2D array texture, one layer per voxel plane, and
   the shader interpolates between two layers itself (SVR_ARRAY). A block is
   4 × 4 texels of one plane: slots are laid out on a pitch rounded up to a
   multiple of 4 (68 for a 66-voxel bordered brick, 64 otherwise), so every
   upload starts on a block edge; the 2 texels of padding are never sampled.
   The values are LOSSY (bc-codec.js gives the error bounds): the atlas is for
   display only. Exact voxels (the Studio's native pass, measurements) never
   come from it.
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

  /** Bytes of one slot: stride³ voxels of `components` bytes (stride 64, or 66 bordered). */
  static slotBytes(components = 4, brickSize = 64) {
    return brickSize * brickSize * brickSize * components;
  }

  /** The slot edge of a tree: 64 + 2·apron (SPEC §13.2). */
  static strideFor(apron = 0) {
    return SVRManager.BRICK_INTERIOR + 2 * (Number(apron) > 0 ? 1 : 0);
  }

  /** Atlas components for a channel count: R8 for one channel, RG8 for two, RGBA8 beyond. */
  static componentsForChannels(channels) {
    const n = Math.max(1, Math.round(Number(channels) || 1));
    return n === 1 ? 1 : n === 2 ? 2 : 4;
  }

  /**
   * Can this renderer hold a compressed ('bc') atlas? A hardware GPU, WebGL2 with
   * EXT_texture_compression_rgtc and a BC5 2D array texture the driver actually
   * accepts (allocated and written once, 4 × 4 × 1, then deleted). Cached per context.
   * A software renderer (SwiftShader, llvmpipe — gpuInfo 'software') is refused: it
   * emulates RGTC by decompressing whole textures, and SwiftShader loses the context
   * sampling a BC5 array of a few MiB. SVRManager.allowSoftwareCompression = true lifts
   * that (tests of the compressed path in a software browser, with tiny atlases).
   * → { bc: boolean, reason: string|null, formats: { bc4, bc5 }|null }
   */
  static compressionSupport(renderer) {
    let gl = null;
    try { gl = renderer?.getContext?.() || null; } catch (e) { gl = null; }
    if (!gl) return { bc: false, reason: 'no-context', formats: null };
    const cached = SVRManager._supportCache.get(gl);
    if (cached) {
      // A restored context has lost its extensions: enable this one again (a no-op
      // when it is already on).
      if (cached.bc) { try { gl.getExtension('EXT_texture_compression_rgtc'); } catch (e) { /* lost */ } }
      return cached;
    }
    if (SVRManager.gpuInfo(renderer).gpuClass === 'software' && !SVRManager.allowSoftwareCompression) {
      const refused = { bc: false, reason: 'software-renderer', formats: null };
      SVRManager._supportCache.set(gl, refused);
      return refused;
    }
    let result;
    try {
      if (typeof gl.texStorage3D !== 'function' || typeof gl.compressedTexSubImage3D !== 'function' || gl.TEXTURE_2D_ARRAY === undefined) {
        result = { bc: false, reason: 'webgl1', formats: null };
      } else if (typeof BCCodec === 'undefined') {
        result = { bc: false, reason: 'no-codec', formats: null };
      } else {
        const ext = gl.getExtension('EXT_texture_compression_rgtc');
        if (!ext) {
          result = { bc: false, reason: 'no-rgtc', formats: null };
        } else {
          const formats = { bc4: ext.COMPRESSED_RED_RGTC1_EXT, bc5: ext.COMPRESSED_RED_GREEN_RGTC2_EXT };
          for (let i = 0; i < 16 && gl.getError() !== gl.NO_ERROR; i++) { /* drain */ }
          const prev = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY);
          const tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
          gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, formats.bc5, 4, 4, 1);
          gl.compressedTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, 4, 4, 1, formats.bc5, new Uint8Array(16));
          const err = gl.getError();
          // Back to the binding three.js believes is current on the active unit.
          gl.bindTexture(gl.TEXTURE_2D_ARRAY, prev);
          gl.deleteTexture(tex);
          result = err === gl.NO_ERROR
            ? { bc: true, reason: null, formats }
            : { bc: false, reason: `refused (glError ${err})`, formats: null };
        }
      }
    } catch (e) {
      result = { bc: false, reason: e?.message || String(e), formats: null };
    }
    SVRManager._supportCache.set(gl, result);
    return result;
  }

  /** Slot pitch (texels between slot origins) for a slot edge: a compressed atlas
   *  rounds it up to whole 4 × 4 blocks. */
  static pitchFor(stride, compressed = false) {
    const s = Math.max(1, Math.round(Number(stride) || 64));
    return compressed ? Math.ceil(s / 4) * 4 : s;
  }

  /** Bytes per texel of a compressed atlas of `channels` channels (0.5 per channel). */
  static compressedTexelBytes(channels) {
    return typeof BCCodec !== 'undefined' ? BCCodec.texelBytesFor(channels) : Math.max(1, Math.min(4, Math.round(Number(channels) || 1))) * 0.5;
  }

  /** Largest page edge an atlas may use: a 3D texture's limit, or for a compressed
   *  (2D array) atlas the smaller of the 2D texture size and the layer count. */
  static maxPageDim(renderer, compressed = false) {
    const max3D = Math.max(64, renderer?.capabilities?.max3DTextureSize || 2048);
    if (!compressed) return max3D;
    let layers = 256;
    try {
      const gl = renderer?.getContext?.();
      if (gl && gl.MAX_ARRAY_TEXTURE_LAYERS !== undefined) layers = Number(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS)) || 256;
    } catch (e) { /* default */ }
    const max2D = Math.max(64, renderer?.capabilities?.maxTextureSize || 2048);
    return Math.max(64, Math.min(max2D, layers));
  }

  /** Remove every atlas define from a material (a dense texture is bound next). */
  static clearAtlasDefines(material) {
    for (const d of ['ENABLE_SVR', 'SVR_COMPONENTS', 'SVR_ARRAY', 'SVR_ARRAY_PAIRS']) SVRManager._setDefine(material, d, null);
  }

  /** Bytes held right now by the atlases of every live manager of this page. */
  static liveAtlasBytes(except = null) {
    let total = 0;
    for (const m of SVRManager._live) if (m !== except) total += m.atlasBytes || 0;
    return total;
  }

  /**
   * The atlas layout holding `targetSlots` slots with the least waste: pages of
   * dim × dim × depth voxels (dim = n·stride, n ∈ {4, 8, 16} — 256/512/1024 for the
   * 64-voxel slots of a v2 tree, 264/528/1056 for the 66-voxel bordered slots of v3 —
   * depth a multiple of the stride), all pages the same size (the shader reads one
   * atlasDim), at most `maxPages` pages, no page above `maxPageBytes`. A page of
   * dim² × depth holds n² · depth/stride slots, so the waste is under one layer of
   * slots per page: ≤ 15 slots per page at n = 4, ≤ 63 at n = 8. `brickSize` is the
   * slot edge (the stride). Null when no layout fits (too many slots for the pages).
   */
  static planAtlas(targetSlots, { max3D = 2048, components = 4, maxPageBytes = 512 * 1024 * 1024, brickSize = 64, maxPages = SVRManager.MAX_PAGES, texelBytes = null } = {}) {
    const target = Math.max(1, Math.ceil(Number(targetSlots) || 1));
    const stride = Math.max(1, Math.round(Number(brickSize) || 64));
    const pageLimit = Math.max(1, Math.min(SVRManager.MAX_PAGES, Math.floor(Number(maxPages) || SVRManager.MAX_PAGES)));
    // texelBytes (a compressed atlas: 0.5 per channel) replaces components.
    const slotBytes = Number(texelBytes) > 0 ? stride * stride * stride * Number(texelBytes) : SVRManager.slotBytes(components, stride);
    let best = null;
    for (const n of SVRManager.SLOTS_PER_SIDE) {
      const dim = n * stride;
      if (dim > max3D) continue;
      const perLayer = n * n;
      const maxLayers = Math.min(Math.floor(max3D / stride), Math.floor(maxPageBytes / (perLayer * slotBytes)));
      if (maxLayers < 1) continue;
      const pages = Math.ceil(target / (perLayer * maxLayers));
      if (pages > pageLimit) continue;
      const layers = Math.ceil(target / (pages * perLayer));
      const slots = pages * layers * perLayer;
      const plan = { dim, depth: layers * stride, pages, slots, bytes: Math.ceil(slots * slotBytes), components, stride };
      if (!best || plan.slots < best.slots || (plan.slots === best.slots && plan.pages < best.pages)) best = plan;
    }
    return best;
  }

  /**
   * The largest layout whose bytes stay within `bytes` (same options as planAtlas):
   * the slot count is searched, not guessed, because layouts round up to whole layers.
   * Null when not even one slot fits.
   */
  static planAtlasWithin(bytes, options = {}) {
    const limit = Math.floor(Number(bytes) || 0);
    const stride = Math.max(1, Math.round(Number(options.brickSize) || 64));
    const slotBytes = Number(options.texelBytes) > 0 ? stride * stride * stride * Number(options.texelBytes) : SVRManager.slotBytes(options.components || 4, stride);
    let hi = Math.floor(limit / slotBytes);
    if (hi < 1) return null;
    const fits = (n) => {
      const p = SVRManager.planAtlas(n, options);
      return p && p.bytes <= limit ? p : null;
    };
    let best = fits(1);
    if (!best) return null;
    let lo = 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const p = fits(mid);
      if (p) { best = p; lo = mid; } else hi = mid - 1;
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
  static maxSlotsForBudget(renderer, { components = 4, budgetBytes = null, includeLive = false, brickSize = 64, maxPages = SVRManager.MAX_PAGES } = {}) {
    const budget = Number.isFinite(Number(budgetBytes)) && budgetBytes !== null ? Number(budgetBytes) : SVRManager.vramBudget(renderer).bytes;
    const available = Math.max(0, budget - (includeLive ? SVRManager.liveAtlasBytes() : 0));
    const max3D = Math.max(64, renderer?.capabilities?.max3DTextureSize || 2048);
    const maxPageBytes = SVRManager._maxPageBytes(budget);
    const stride = Math.max(1, Math.round(Number(brickSize) || 64));
    const pageLimit = Math.max(1, Math.min(SVRManager.MAX_PAGES, Math.floor(Number(maxPages) || SVRManager.MAX_PAGES)));
    // Capacity of the largest layout the texture limits allow.
    let capacity = 0;
    for (const n of SVRManager.SLOTS_PER_SIDE) {
      if (n * stride > max3D) continue;
      const perLayer = n * n;
      const maxLayers = Math.min(Math.floor(max3D / stride), Math.floor(maxPageBytes / (perLayer * SVRManager.slotBytes(components, stride))));
      if (maxLayers >= 1) capacity = Math.max(capacity, perLayer * maxLayers * pageLimit);
    }
    return Math.max(0, Math.min(capacity, Math.floor(available / SVRManager.slotBytes(components, stride))));
  }

  /** Back-compatible name: the slot ceiling for this GPU's budget (RGBA8 slots). */
  static estimateMaxSlots(renderer, brickSize = 64) {
    return SVRManager.maxSlotsForBudget(renderer, { brickSize });
  }

  static slotsPerAtlasForConfig(config, brickSize = 64) {
    const stride = config.stride || brickSize;
    return Math.floor(config.dim / stride) * Math.floor(config.dim / stride) * Math.floor(config.depth / stride);
  }

  static slotsForConfig(config, brickSize = 64) {
    return SVRManager.slotsPerAtlasForConfig(config, brickSize) * (config.pages || 1);
  }

  constructor() {
    this.atlasDim = 512;
    this.atlasDepth = 512;
    // brickSize: the INTERIOR edge of a brick (what the page table's cells are cut in);
    // slotStride: the edge of an atlas slot (64, or 66 with the 1-voxel border).
    this.brickSize = 64;
    this.apron = 0;
    this.slotStride = 64;
    // Texels between slot origins: the stride, or for a compressed atlas the stride
    // rounded up to whole 4 × 4 blocks (pitchFor).
    this.slotPitch = 64;
    this.compressed = false;
    // Compressed: one texture per page and plane (BCCodec.planesFor), planeAtlases[p][page];
    // `atlases` is plane 0's. texelBytes: bytes per texel over every plane.
    this.planes = null;
    this.planeAtlases = [];
    this.texelBytes = null;
    this.role = 'base';
    this.pageLimit = SVRManager.MAX_PAGES;
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
   *   apron         1: bricks are delivered with their 1-voxel border (v3, 66³ slots,
   *                 trilinear); 0: 64³ slots, nearest. Defaults to `volumeDim.apron`,
   *                 which BrickLoader.getDimensions() carries, so an atlas built from
   *                 the loader's dimensions takes the mounted tree's frame by itself.
   *                 Every brick this atlas receives (writeRgbaBrick, writeBrick,
   *                 writeRgbaBrickRegion) is in that frame: stored voxel s of an axis
   *                 is volume voxel 64·b − apron + s.
   *   role          'base' (default) or 'detail' (see the header).
   *   maxPages      page limit (≤ 8; a detail atlas is capped at DETAIL_MAX_PAGES).
   *   compression   'bc': a compressed display atlas (see the header; only for role
   *                 'base', and only where SVRManager.compressionSupport says so — init
   *                 throws err.code 'SVR_BAD_FORMAT' otherwise). Bricks then go in
   *                 through writeEncodedBrick (or writeRgbaBrick / writeBrick, encoded
   *                 on this thread); writeRgbaBrickRegion is refused.
   */
  init(channels, volumeDim, renderer, material, options = {}) {
    this._releaseGpuResources();
    this.channels = channels;
    this.volumeDim = volumeDim;
    this.renderer = renderer;
    this.material = material;
    this.components = [1, 2, 4].includes(Number(options.components)) ? Number(options.components) : 4;
    const apronRaw = options.apron !== undefined ? options.apron : volumeDim?.apron;
    this.apron = Number(apronRaw) > 0 ? 1 : 0;
    this.slotStride = SVRManager.strideFor(this.apron);
    if (volumeDim?.brickStride !== undefined && Number(volumeDim.brickStride) !== this.slotStride && options.apron === undefined) {
      throw Object.assign(new Error(`SVR atlas: brick stride ${volumeDim.brickStride} does not match apron ${this.apron}`), { code: 'SVR_BAD_FORMAT' });
    }
    this.role = options.role === 'detail' ? 'detail' : 'base';
    this.compressed = options.compression === 'bc';
    this.planes = null;
    this.texelBytes = null;
    if (this.compressed) {
      const support = SVRManager.compressionSupport(renderer);
      if (this.role === 'detail' || !support.bc) {
        this.compressed = false;
        throw Object.assign(new Error(`SVR atlas: compression unavailable (${this.role === 'detail' ? 'detail atlas' : support.reason})`), { code: 'SVR_BAD_FORMAT' });
      }
      this.planes = BCCodec.planesFor(Math.min(channels, this.components === 4 ? 4 : this.components))
        .map(p => ({ ...p, glFormat: support.formats[p.format] }));
      this.texelBytes = this.planes.reduce((sum, p) => sum + p.texelBytes, 0);
    }
    this.slotPitch = SVRManager.pitchFor(this.slotStride, this.compressed);
    const pageCap = this.role === 'detail'
      ? SVRManager.DETAIL_MAX_PAGES
      : (this.compressed ? Math.floor(SVRManager.MAX_PAGES / this.planes.length) : SVRManager.MAX_PAGES);
    this.pageLimit = Math.max(1, Math.min(pageCap, Math.floor(Number(options.maxPages) || pageCap)));
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
    const max3D = SVRManager.maxPageDim(renderer, this.compressed);
    const budget = Number.isFinite(Number(options.budgetBytes)) && options.budgetBytes !== null && options.budgetBytes !== undefined
      ? Number(options.budgetBytes)
      : SVRManager.vramBudget(renderer).bytes;
    const others = options.countLiveAtlases === false ? 0 : SVRManager.liveAtlasBytes(this);
    const available = options.ignoreBudget ? Infinity : Math.max(0, budget - others);
    const maxPageBytes = SVRManager._maxPageBytes(options.ignoreBudget ? Infinity : budget);
    const slotBytes = this.compressed
      ? this.slotPitch * this.slotPitch * this.slotPitch * this.texelBytes
      : SVRManager.slotBytes(this.components, this.slotStride);
    const requested = Math.ceil(Number(options.targetSlots) || 0);
    const targeted = requested > 1;

    let target = targeted
      ? requested
      : Math.max(1, Math.min(4096, Number.isFinite(available) ? Math.floor(available / slotBytes) : 4096));
    let allocated = null;
    let lastError = null;
    for (;;) {
      const plan = SVRManager.planAtlas(target, {
        max3D, components: this.components, maxPageBytes, brickSize: this.slotPitch, maxPages: this.pageLimit,
        texelBytes: this.compressed ? this.texelBytes : null
      });
      if (!plan) {
        throw Object.assign(new Error(`SVR atlas cannot hold ${target} bricks within ${this.pageLimit} pages of the texture limit (${max3D})`),
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
    const TextureClass = this.compressed ? THREE.DataArrayTexture : (THREE.Data3DTexture || THREE.DataTexture3D);
    const format = this.components === 1 ? THREE.RedFormat : this.components === 2 ? THREE.RGFormat : THREE.RGBAFormat;
    const planes = this.compressed ? this.planes : [null];
    const byPlane = planes.map(() => []);
    try {
      for (let p = 0; p < planes.length; p++) {
        for (let page = 0; page < this.atlasPages; page++) {
          const atlas = new TextureClass(null, this.atlasDim, this.atlasDim, this.atlasDepth);
          // A compressed page's storage is made here (texStorage3D of its RGTC format);
          // three.js only binds it, so the format fields below are never uploaded from.
          atlas.format = this.compressed ? (planes[p].channels.length === 2 ? THREE.RGFormat : THREE.RedFormat) : format;
          atlas.type = THREE.UnsignedByteType;
          // Slots are packed edge to edge. Without a border, linear filtering would blend
          // the neighbouring slot's brick in at every brick face: nearest. With the 1-voxel
          // border every trilinear footprint stays inside its own slot: linear (on a
          // compressed page: bilinear within a layer, the shader blending two layers).
          const filter = this.apron ? THREE.LinearFilter : THREE.NearestFilter;
          atlas.minFilter = filter;
          atlas.magFilter = filter;
          atlas.unpackAlignment = 1;
          byPlane[p].push(atlas);
          if (this.renderer) this._initAtlasTexture(atlas, planes[p]);
          atlas.needsUpdate = false;
        }
      }
    } catch (err) {
      for (const atlas of byPlane.flat()) {
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
    this.planeAtlases = this.compressed ? byPlane : [];
    this.atlases = byPlane[0];
  }

  _applyAtlasConfig(config) {
    this.atlasDim = config.dim;
    this.atlasDepth = config.depth;
    this.atlasPages = config.pages || 1;
    this.slotsX = Math.floor(this.atlasDim / this.slotPitch);
    this.slotsY = Math.floor(this.atlasDim / this.slotPitch);
    this.slotsZ = Math.floor(this.atlasDepth / this.slotPitch);
    this.slotsPerAtlas = SVRManager.slotsPerAtlasForConfig({ ...config, stride: this.slotPitch }, this.slotPitch);
    this.maxSlots = this.slotsPerAtlas * this.atlasPages;
  }

  _glFormats(gl) {
    if (this.components === 1) return { internal: gl.R8, format: gl.RED };
    if (this.components === 2) return { internal: gl.RG8, format: gl.RG };
    return { internal: gl.RGBA8, format: gl.RGBA };
  }

  _initAtlasTexture(atlas, plane = null) {
    const gl = this.renderer.getContext();
    for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++) {
      // Drain stale errors before testing this atlas allocation.
    }
    const target = this.compressed ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_3D;
    const tex = gl.createTexture();
    let prevBinding = null;
    if (this.renderer.state && this.renderer.state.bindTexture) {
      this.renderer.state.bindTexture(target, tex);
    } else {
      prevBinding = gl.getParameter(this.compressed ? gl.TEXTURE_BINDING_2D_ARRAY : gl.TEXTURE_BINDING_3D);
      gl.bindTexture(target, tex);
    }

    const glFilter = this.apron ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, glFilter);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, glFilter);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    if (gl.PIXEL_UNPACK_BUFFER) {
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    }
    if (this.compressed) {
      // WebGL zero-initialises new storage: an all-zero RGTC block decodes to 0.
      gl.texStorage3D(target, 1, plane.glFormat, this.atlasDim, this.atlasDim, this.atlasDepth);
    } else {
      const { internal, format } = this._glFormats(gl);
      if (typeof gl.texStorage3D === 'function') {
        gl.texStorage3D(target, 1, internal, this.atlasDim, this.atlasDim, this.atlasDepth);
      } else {
        gl.texImage3D(target, 0, internal, this.atlasDim, this.atlasDim, this.atlasDepth, 0, format, gl.UNSIGNED_BYTE, null);
      }
    }

    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      gl.deleteTexture(tex);
      if (prevBinding !== null) {
        gl.bindTexture(target, prevBinding);
      }
      throw new Error(`SVR atlas GPU allocation failed (${this.atlasDim}x${this.atlasDim}x${this.atlasDepth}${this.compressed ? ` ${plane.format}` : ''}, glError=${err})`);
    }
    if (prevBinding !== null) {
      gl.bindTexture(target, prevBinding);
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
    const all = this.planeAtlases.length ? this.planeAtlases.flat() : this.atlases;
    if (this.renderer) {
      for (const atlas of all) {
        this._disposeAtlasTexture(atlas);
      }
    }
    for (const atlas of all) {
      atlas?.dispose?.();
    }
    this.atlases = [];
    this.planeAtlases = [];
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
    if (this.role === 'detail') return this._publishDetail();
    this.material.defines.ENABLE_SVR = 1;
    SVRManager._setDefine(this.material, 'SVR_COMPONENTS', this.components === 4 ? null : this.components);
    // Compressed pages are 2D arrays (sampler2DArray, layers blended in the shader);
    // with two planes svrAtlas0..3 hold the first one's pages, svrAtlas4..7 the second's.
    SVRManager._setDefine(this.material, 'SVR_ARRAY', this.compressed ? 1 : null);
    SVRManager._setDefine(this.material, 'SVR_ARRAY_PAIRS', this.compressed && this.planes.length > 1 ? 1 : null);
    this.material.needsUpdate = true;
    const set = (name, value) => { if (this.material.uniforms[name]) this.material.uniforms[name].value = value; };
    // Slot addressing (the shader's slotCoord): texel = slot·slotStride + brickApron +
    // local, slotStride being the pitch between slot origins.
    set('slotStride', this.slotPitch);
    set('brickApron', this.apron);
    set('svrComponents', this.components);

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

    if (this.compressed && this.planes.length > 1) {
      const half = SVRManager.MAX_PAGES / 2;
      for (let i = 0; i < SVRManager.MAX_PAGES; i++) {
        const pages = this.planeAtlases[i < half ? 0 : 1] || [];
        const u = this.material.uniforms['svrAtlas' + i];
        if (u) u.value = pages[i % half] || pages[0] || null;
      }
      return true;
    }
    this.material.uniforms.svrAtlas0.value = this.atlases[0] || null;
    for (let i = 1; i < SVRManager.MAX_PAGES; i++) {
      const u = this.material.uniforms['svrAtlas' + i];
      if (u) u.value = this.atlases[i] || this.atlases[0] || null;
    }
    return true;
  }

  /** A detail atlas: the detail* uniforms and the ROI_DETAIL define (see the header). */
  _publishDetail() {
    const m = this.material;
    const set = (name, value) => { if (m.uniforms[name]) m.uniforms[name].value = value; };
    m.defines.ROI_DETAIL = 1;
    SVRManager._setDefine(m, 'ROI_DETAIL_COMPONENTS', this.components === 4 ? null : this.components);
    m.needsUpdate = true;
    set('detailPageTable', this.pageTable);
    set('detailAtlasDim', new THREE.Vector3(this.atlasDim, this.atlasDim, this.atlasDepth));
    set('detailVolumeDim', new THREE.Vector3(this.volumeDim.x, this.volumeDim.y, this.volumeDim.z));
    set('detailPtDim', new THREE.Vector3(this.ptNx, this.ptNy, this.ptNz));
    set('detailSlotStride', this.slotStride);
    set('detailApron', this.apron);
    set('detailPageCount', this.atlases.length);
    for (let i = 0; i < SVRManager.DETAIL_MAX_PAGES; i++) set('detailAtlas' + i, this.atlases[i] || this.atlases[0] || null);
    return true;
  }

  /**
   * Take a detail atlas off `material` (or this manager's): the define goes, every
   * detail uniform is unbound, the page count drops to 0 (a stale binding then reads as
   * "no detail brick", never as voxels of a released texture).
   */
  static unpublishDetail(material) {
    if (!material?.uniforms) return;
    let changed = false;
    for (const d of ['ROI_DETAIL', 'ROI_DETAIL_COMPONENTS']) {
      if (material.defines && d in material.defines) { delete material.defines[d]; changed = true; }
    }
    if (material.uniforms.detailPageTable) material.uniforms.detailPageTable.value = null;
    for (let i = 0; i < SVRManager.DETAIL_MAX_PAGES; i++) {
      if (material.uniforms['detailAtlas' + i]) material.uniforms['detailAtlas' + i].value = null;
    }
    if (material.uniforms.detailPageCount) material.uniforms.detailPageCount.value = 0;
    if (changed) material.needsUpdate = true;
  }

  /** Set (value !== null) or remove (null) a define; needsUpdate only on a change. */
  static _setDefine(material, name, value) {
    if (!material) return;
    material.defines = material.defines || {};
    if (value === null || value === undefined) {
      if (name in material.defines) { delete material.defines[name]; material.needsUpdate = true; }
    } else if (material.defines[name] !== value) {
      material.defines[name] = value;
      material.needsUpdate = true;
    }
  }

  // ── Residency (region-of-interest streaming) ────────────────────────────────
  /** Is brick (bx, by, bz) in the atlas (and pointed at by the page table)? */
  has(bx, by, bz) {
    const slot = this.brickMap.get(`${bx}_${by}_${bz}`);
    if (slot === undefined || !this.pageData) return false;
    return this.pageData[(bz * this.ptNx * this.ptNy + by * this.ptNx + bx) * 4 + 3] !== 0;
  }

  /** Mark a resident brick as just used: it becomes the last one the LRU recycles. */
  touch(bx, by, bz) {
    const slot = this.brickMap.get(`${bx}_${by}_${bz}`);
    if (slot === undefined) return false;
    this._lru.delete(slot);
    this._lru.set(slot, true);
    return true;
  }

  /** Bricks resident now, least recently used first ("bx_by_bz" keys). */
  residentKeys() {
    const out = [];
    for (const slot of this._lru.keys()) {
      const key = this.slotToBrick[slot];
      if (key) out.push(key);
    }
    return out;
  }

  /** How many bricks the atlas holds right now. */
  residentCount() {
    return this.brickMap.size;
  }

  /** Drop a brick: its slot goes back to the free list, its page-table entry is cleared. */
  evict(bx, by, bz) {
    const key = `${bx}_${by}_${bz}`;
    const slot = this.brickMap.get(key);
    if (slot === undefined) return false;
    this.brickMap.delete(key);
    this._lru.delete(slot);
    this.slotToBrick[slot] = null;
    this.slotData.delete(slot);
    this.freeSlots.push(slot);
    if (this.pageData) {
      this.pageData[(bz * this.ptNx * this.ptNy + by * this.ptNx + bx) * 4 + 3] = 0;
      if (this.pageTable) this.pageTable.needsUpdate = true;
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
   * One channel of a brick (scalar voxels, stride³, z-major). The slot's other channels
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
    return this._finishUpload(bx, by, bz, slotIndex, ptIdx, this._uploadSlotBox(coord, bw, bh, bd, uploadData));
  }

  /**
   * A whole brick, `components` bytes per voxel interleaved (channel c in byte c),
   * either stride³ voxels (66³ on a bordered atlas) or exactly the bw × bh × bd box (a composed
   * brick cut with cropToVolume, uploaded as it is). Returns false when the upload
   * was refused (the page-table entry is then left empty: the shader skips it).
   */
  writeRgbaBrick(bx, by, bz, brickData, bw, bh, bd) {
    const uploadData = this._compactRgbaBrickData(brickData, bw, bh, bd);
    if (!uploadData) return false;
    const slotIndex = this.getSlot(bx, by, bz);
    const coord = this._slotCoord(slotIndex);
    const ptIdx = this._pointPageTable(bx, by, bz, coord);
    return this._finishUpload(bx, by, bz, slotIndex, ptIdx, this._uploadSlotBox(coord, bw, bh, bd, uploadData));
  }

  /**
   * A brick already in the GPU's blocks (BrickLoader compose `encode: 'bc'`): `encoded`
   * = { width, height, depth, planes: [{ format, channels, bytes }] }, the box from the
   * slot origin rounded up to whole blocks, one plane per texture of this atlas, in
   * order. Returns false when this atlas is not compressed, the planes do not match it
   * or the box does not fit a slot (the page-table entry is then left empty).
   */
  writeEncodedBrick(bx, by, bz, encoded) {
    if (!this.compressed || !this._encodedFits(encoded)) return false;
    const slotIndex = this.getSlot(bx, by, bz);
    const coord = this._slotCoord(slotIndex);
    const ptIdx = this._pointPageTable(bx, by, bz, coord);
    return this._finishUpload(bx, by, bz, slotIndex, ptIdx, this._uploadEncoded(coord, encoded));
  }

  _encodedFits(enc) {
    if (!enc || !Array.isArray(enc.planes) || enc.planes.length !== this.planes.length) return false;
    if (!(enc.width > 0 && enc.height > 0 && enc.depth > 0)) return false;
    if (enc.width % 4 || enc.height % 4 || enc.width > this.slotPitch || enc.height > this.slotPitch || enc.depth > this.slotPitch) return false;
    const blocks = (enc.width / 4) * (enc.height / 4) * enc.depth;
    return enc.planes.every((p, i) => p && p.bytes && p.format === this.planes[i].format
      && p.bytes.length === blocks * 8 * this.planes[i].channels.length);
  }

  /** Upload a box of raw voxels (`components` bytes each) at a slot's origin — encoded
   *  to blocks on this thread first when the atlas is compressed. */
  _uploadSlotBox(coord, bw, bh, bd, uploadData) {
    const p = this.slotPitch;
    if (!this.compressed) return this._uploadRgbaRegion(coord.atlas, coord.x * p, coord.y * p, coord.z * p, bw, bh, bd, uploadData);
    if (!uploadData || typeof BCCodec === 'undefined') return false;
    const enc = BCCodec.encodeBox(uploadData, this.components, bw, bh, bd, this.channels);
    return this._encodedFits(enc) ? this._uploadEncoded(coord, enc) : false;
  }

  /** compressedTexSubImage3D of each plane of an encoded box at a slot's origin. */
  _uploadEncoded(coord, enc) {
    const p = this.slotPitch;
    let result = true;
    for (let i = 0; i < this.planes.length; i++) {
      const r = this._uploadCompressedRegion(i, coord.atlas, coord.x * p, coord.y * p, coord.z * p, enc.width, enc.height, enc.depth, enc.planes[i].bytes);
      if (r === false) return false;
      if (r === 'unchecked') result = 'unchecked';
    }
    return result;
  }

  /**
   * Upload only the sub-box [rx, rx+rw) x [ry, ry+rh) x [rz, rz+rd) of a brick's slot
   * (coordinates in the slot's frame: 0..65 on a bordered atlas, 0..63 otherwise).
   * `data` holds that box alone (tightly packed, `components` bytes per voxel,
   * z-major). The page table points at the slot exactly as for a whole brick, so the
   * caller guarantees that nothing outside the box is ever sampled: a slice through
   * the volume reads one voxel plane of each brick it crosses. The rest of the slot
   * keeps whatever it held (undefined on a fresh atlas) — this is for a throwaway
   * atlas, never the ray-marcher's own.
   */
  writeRgbaBrickRegion(bx, by, bz, data, rx, ry, rz, rw, rh, rd) {
    const bs = this.slotStride;
    if (this.compressed) return false;
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
    const bs = this.slotStride;
    const slotIndex = this.freeSlots.pop();
    const coord = this._slotCoord(slotIndex);
    const gl = this.renderer?.getContext?.();
    if (gl && typeof gl.getError === 'function') {
      for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++) { /* drain stale errors */ }
    }
    const zeros = new Uint8Array(bs * bs * bs * this.components);
    const result = this._uploadSlotBox(coord, bs, bs, bs, zeros);
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
    const bs = this.slotStride;
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
      slot = new Uint8Array(this.slotStride * this.slotStride * this.slotStride * this.components);
      this.slotData.set(slotIndex, slot);
    }
    return slot;
  }

  _writeChannelToSlot(slotIndex, channel, brickData, bw, bh, bd) {
    if (!brickData) return;
    const slot = this._slotBuffer(slotIndex);
    const bs = this.slotStride;
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

  /**
   * compressedTexSubImage3D of a box into one page of plane `plane`. The box starts on
   * a block edge (x, y multiples of 4: slot pitch and offsets are) and spans whole
   * blocks. Same return contract as _uploadRgbaRegion.
   */
  _uploadCompressedRegion(plane, atlasIndex, sx, sy, sz, bw, bh, bd, bytes) {
    if (!this.renderer) return true;
    const atlas = this.planeAtlases[plane]?.[atlasIndex];
    if (!atlas || !bytes) return false;
    if (sx < 0 || sy < 0 || sz < 0 || sx % 4 || sy % 4 || bw % 4 || bh % 4
      || sx + bw > this.atlasDim || sy + bh > this.atlasDim || sz + bd > this.atlasDepth) {
      console.warn('[SVRManager] Skipping misaligned or out-of-bounds compressed upload', {
        sx, sy, sz, bw, bh, bd, atlasIndex, plane, atlasDim: this.atlasDim, atlasDepth: this.atlasDepth
      });
      return false;
    }
    const webglTexture = this.renderer.properties.get(atlas)?.__webglTexture;
    if (!webglTexture) return false;
    const gl = this.renderer.getContext();
    if (this.renderer.state && this.renderer.state.bindTexture) {
      this.renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, webglTexture);
    } else {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, webglTexture);
    }
    if (gl.PIXEL_UNPACK_BUFFER) gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    gl.compressedTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, sx, sy, sz, bw, bh, bd, this.planes[plane].glFormat, bytes);
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
SVRManager.DETAIL_MAX_PAGES = 4;   // the shader's detailAtlas0..3
SVRManager.BRICK_INTERIOR = 64;
// Slots per side of a page: 4, 8 or 16 (256/512/1024 texels at stride 64).
SVRManager.SLOTS_PER_SIDE = [4, 8, 16];
SVRManager.CONTEXT_LOSS_MEMORY_MS = 7 * 24 * 3600 * 1000;
SVRManager._live = new Set();
SVRManager._failedAllocBytes = Infinity;
SVRManager._sessionLosses = 0;
SVRManager._sessionOverrideBytes = null;
SVRManager._supportCache = new WeakMap();
SVRManager.allowSoftwareCompression = false;

window.SVRManager = SVRManager;

/* ── Region-of-interest scheduling ───────────────────────────────────────────
   Pure decisions behind the viewer's detail streaming (volume-viewer.js, "Region
   of interest"): which finer level the view needs, which of its bricks are on
   screen and in what order, and what one round loads, keeps and lets go. No GPU,
   no network: everything comes in as numbers and callbacks.
   ──────────────────────────────────────────────────────────────────────────── */
const SVRRoi = {
  // A level is fine enough while one of its voxels covers at most this many screen
  // pixels; beyond it (the user zoomed past the resolution on screen) a finer level
  // is streamed for what is in view.
  DETAIL_PIXELS_PER_VOXEL: 1.5,

  /** Focal length in pixels of a perspective camera: H / (2·tan(fov/2)). */
  focalPx(viewportHeightPx, fovDeg) {
    const h = Math.max(1, Number(viewportHeightPx) || 1);
    const t = Math.tan((Math.max(1e-3, Math.min(179, Number(fovDeg) || 45)) * Math.PI / 180) / 2);
    return h / (2 * t);
  },

  /** Screen pixels one voxel of world length `voxelWorld` covers at `distance`. */
  pixelsPerVoxel(focalPx, voxelWorld, distance) {
    return (Number(focalPx) || 0) * (Number(voxelWorld) || 0) / Math.max(1e-6, Number(distance) || 0);
  },

  /**
   * The detail level for the view, or null when the resident one is fine enough.
   * levels: [{ level, voxelWorld }] (voxelWorld: world length of a voxel of that
   * level along its finer XY axis), baseLevel: the level resident everywhere.
   * Detail is needed when a base voxel covers more than `threshold` pixels; it is
   * then the COARSEST finer level whose voxel covers at most `threshold` pixels (the
   * fewest bytes that resolve the view), level 0 when none does.
   * → { level: k | null, basePixelsPerVoxel, pixelsPerVoxel (of the chosen level) }
   */
  chooseDetailLevel({ levels, baseLevel, focalPx, distance, threshold = SVRRoi.DETAIL_PIXELS_PER_VOXEL }) {
    const byLevel = new Map((levels || []).map(l => [Number(l.level), Number(l.voxelWorld)]));
    const base = Number(baseLevel);
    const basePpv = SVRRoi.pixelsPerVoxel(focalPx, byLevel.get(base), distance);
    const out = { level: null, basePixelsPerVoxel: basePpv, pixelsPerVoxel: basePpv };
    if (!(base > 0) || !(basePpv > threshold)) return out;
    for (let k = base - 1; k >= 0; k--) {
      if (!byLevel.has(k)) continue;
      const ppv = SVRRoi.pixelsPerVoxel(focalPx, byLevel.get(k), distance);
      out.level = k;
      out.pixelsPerVoxel = ppv;
      if (ppv <= threshold) break;
    }
    return out;
  },

  /** Is the box [min, max] entirely outside one of `planes` ([nx, ny, nz, d], the
   *  inside being n·p + d ≥ 0)? The box's corner furthest along n decides. */
  boxOutside(min, max, planes) {
    for (const [nx, ny, nz, d] of planes || []) {
      const px = nx >= 0 ? max.x : min.x;
      const py = ny >= 0 ? max.y : min.y;
      const pz = nz >= 0 ? max.z : min.z;
      if (nx * px + ny * py + nz * pz + d < 0) return true;
    }
    return false;
  },

  /**
   * The bricks of a level that are in view, most important first.
   *   bricks      [{ bx, by, bz }] the bricks the level stores
   *   dims        the level's voxel counts {x, y, z}; brick b spans
   *               [64·b, min(64·b + 64, dim)) voxels, i.e. that range / dim in uvw
   *   planes      the view frustum in uvw space ([nx, ny, nz, d], inside ≥ 0)
   *   clipMin/Max the clip box in uvw (bricks wholly outside it are not shown)
   *   worldScale  world length of one uvw unit along x, y, z (the cube's scale)
   *   project(u, v, w) → { x, y, depth } NDC position and view depth of a uvw point
   *   near        the smallest depth counted (the camera's near plane)
   * priority = (world diagonal of the brick / depth of its centre) / (1 + 4·r²), r the
   * NDC distance of its centre from the view centre: big on screen and central first.
   * Ties keep the (bz, by, bx) order.
   */
  rankVisible({ bricks, dims, planes, clipMin = { x: 0, y: 0, z: 0 }, clipMax = { x: 1, y: 1, z: 1 }, worldScale = { x: 1, y: 1, z: 1 }, project, near = 1e-3, brickSize = 64 }) {
    const out = [];
    const min = { x: 0, y: 0, z: 0 };
    const max = { x: 0, y: 0, z: 0 };
    for (const b of bricks || []) {
      min.x = (b.bx * brickSize) / dims.x; max.x = Math.min((b.bx + 1) * brickSize, dims.x) / dims.x;
      min.y = (b.by * brickSize) / dims.y; max.y = Math.min((b.by + 1) * brickSize, dims.y) / dims.y;
      min.z = (b.bz * brickSize) / dims.z; max.z = Math.min((b.bz + 1) * brickSize, dims.z) / dims.z;
      if (max.x <= clipMin.x || min.x >= clipMax.x || max.y <= clipMin.y || min.y >= clipMax.y || max.z <= clipMin.z || min.z >= clipMax.z) continue;
      if (SVRRoi.boxOutside(min, max, planes)) continue;
      const p = project ? project((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2) : null;
      const depth = Math.max(near, p ? Number(p.depth) || near : near);
      const r = p ? Math.hypot(Number(p.x) || 0, Number(p.y) || 0) : 0;
      const diag = Math.hypot((max.x - min.x) * worldScale.x, (max.y - min.y) * worldScale.y, (max.z - min.z) * worldScale.z);
      out.push({ bx: b.bx, by: b.by, bz: b.bz, key: `${b.bx}_${b.by}_${b.bz}`, priority: (diag / depth) / (1 + 4 * r * r), order: out.length });
    }
    out.sort((a, b) => (b.priority - a.priority) || (a.order - b.order));
    return out;
  },

  /**
   * One scheduling round within `capacity` slots.
   *   ranked       rankVisible's list
   *   isResident(key) / inFlight (Set of keys already being fetched)
   *   residentKeys the atlas's resident keys, least recently used first
   * → { want: the `capacity` most important keys,
   *     load: their bricks neither resident nor in flight (priority order),
   *     keep: the wanted resident keys, least important first — touched in this order
   *           the most important ends most recent, so the LRU never recycles a
   *           wanted brick while an unwanted one is left,
   *     evict: resident keys not wanted, least recently used first: the slots new
   *           bricks take (recycled lazily as they land),
   *     inView: how many bricks are in view, dropped: how many of them do not fit }
   */
  plan({ ranked, isResident, inFlight = new Set(), capacity, residentKeys = [] }) {
    const cap = Math.max(0, Math.floor(Number(capacity) || 0));
    const list = ranked || [];
    const wanted = list.slice(0, cap);
    const wantSet = new Set(wanted.map(r => r.key));
    const load = [];
    const keep = [];
    for (const r of wanted) {
      if (isResident(r.key)) keep.push(r.key);
      else if (!inFlight.has(r.key)) load.push(r);
    }
    keep.reverse();
    const evict = residentKeys.filter(k => !wantSet.has(k));
    return { want: wanted.map(r => r.key), load, keep, evict, inView: list.length, dropped: Math.max(0, list.length - wanted.length) };
  }
};

window.SVRRoi = SVRRoi;
