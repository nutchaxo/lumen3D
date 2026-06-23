class SVRManager {
  static estimateMaxSlots(renderer, brickSize = 64) {
    // CAP-008: ceiling raised 4096 -> 8192 (8 atlas pages, the shader's svrAtlas0..7
    // limit). This lets the viewer attempt the native LOD for datasets up to ~8192
    // active bricks; if the GPU cannot allocate the corresponding 5-8 GiB atlas the
    // init() cascade throws and the caller downgrades the LOD gracefully.
    return Math.max(8192, SVRManager._lastWorkingSlots || 0);
  }

  static atlasConfigs() {
    return [
      // CAP-008: 8->5 page tiers (8/7/6/5 GiB, 1 GiB per 1024x1024x256 texture).
      // 8 pages == the shader's svrAtlas0..7 sampler limit. Only ever selected when
      // an explicit targetSlots demands >4096 slots (smallest-sufficient first); the
      // untargeted path is capped at 4096 in init() so tiny loads never probe 8 GiB.
      { dim: 1024, depth: 256, pages: 8 }, // 8192 slots
      { dim: 1024, depth: 256, pages: 7 }, // 7168 slots
      { dim: 1024, depth: 256, pages: 6 }, // 6144 slots
      { dim: 1024, depth: 256, pages: 5 }, // 5120 slots
      // 4096 slots (4 GiB total, 1 GiB per texture)
      { dim: 1024, depth: 256, pages: 4 },
      // 3072 slots
      { dim: 1024, depth: 256, pages: 3 },
      // 2048 slots
      { dim: 1024, depth: 256, pages: 2 },
      // 1024 slots
      { dim: 1024, depth: 256, pages: 1 },
      
      // 4096 slots (4 GiB total, 512 MiB per texture)
      { dim: 512, depth: 512, pages: 8 },
      // 3072 slots
      { dim: 512, depth: 512, pages: 6 },
      // 2048 slots (2 GiB total, 512 MiB per texture)
      { dim: 512, depth: 512, pages: 4 },
      { dim: 512, depth: 512, pages: 3 },
      { dim: 512, depth: 512, pages: 2 },
      { dim: 512, depth: 512, pages: 1 },
      { dim: 512, depth: 256, pages: 2 },
      { dim: 512, depth: 256, pages: 1 },
      { dim: 256, depth: 256, pages: 1 }
    ];
  }

  static slotsPerAtlasForConfig(config, brickSize = 64) {
    return (config.dim / brickSize) * (config.dim / brickSize) * (config.depth / brickSize);
  }

  static slotsForConfig(config, brickSize = 64) {
    return SVRManager.slotsPerAtlasForConfig(config, brickSize) * (config.pages || 1);
  }

  constructor() {
    this.atlasDim = 1024;
    this.atlasDepth = 256;
    this.brickSize = 64;
    this.atlasPages = 4;
    this.slotsPerAtlas = (this.atlasDim / this.brickSize) * (this.atlasDim / this.brickSize) * (this.atlasDepth / this.brickSize); // 1024
    this.maxSlots = this.slotsPerAtlas * this.atlasPages; // 4096
    this.slotsX = this.atlasDim / this.brickSize;
    this.slotsY = this.atlasDim / this.brickSize;
    this.slotsZ = this.atlasDepth / this.brickSize;
    
    this.atlases = [];
    this.slotData = new Map(); // Only used by scalar-channel fallback to merge channels into RGBA slots.
    this.pageTable = null;
    this.pageData = null;
    
    this.brickMap = new Map(); // "bx_by_bz" -> slotIndex
    this.slotQueue = []; // LRU queue of slot indices
    this.freeSlots = [];
    
    this.volumeDim = null;
    this.ptNx = 0; this.ptNy = 0; this.ptNz = 0;
    this.channels = 0;
    this.renderer = null;
    this.material = null;
    this._atlasWebglTextures = [];
  }

  init(channels, volumeDim, renderer, material, options = {}) {
    this._releaseGpuResources();
    this.channels = channels;
    this.volumeDim = volumeDim;
    this.renderer = renderer;
    this.material = material;
    this._selectAtlasConfig(renderer, options);
    this.brickMap.clear();
    this.slotQueue = [];
    // BUG-035 / STREAMING-21: slotToBrick + freeSlots are sized AFTER the atlas
    // cascade below has fixed the definitive maxSlots — not here on the provisional
    // _selectAtlasConfig pick (which the cascade may grow if a smaller atlas fails
    // GPU allocation). See the post-cascade allocation for the full rationale.
    this.freeSlots = [];
    this.slotToBrick = [];

    this.ptNx = Math.ceil(volumeDim.x / this.brickSize);
    this.ptNy = Math.ceil(volumeDim.y / this.brickSize);
    this.ptNz = Math.ceil(volumeDim.z / this.brickSize);
    
    // Allocate Page Table
    this.pageData = new Uint8Array(this.ptNx * this.ptNy * this.ptNz * 4);
    const TextureClass = THREE.Data3DTexture || THREE.DataTexture3D;
    this.pageTable = new TextureClass(this.pageData, this.ptNx, this.ptNy, this.ptNz);
    this.pageTable.format = THREE.RGBAFormat;
    this.pageTable.type = THREE.UnsignedByteType;
    this.pageTable.minFilter = THREE.NearestFilter; // MUST be nearest for exact slot fetching
    this.pageTable.magFilter = THREE.NearestFilter;
    this.pageTable.unpackAlignment = 1;
    this.pageTable.needsUpdate = true;
    
    // Allocate interleaved RGBA atlases directly on the GPU. RGBA streaming does
    // not mirror slots in JS memory, which avoids multi-GiB V8 allocations.
    this.atlases = [];
    this.slotData.clear();
    let allocatedAtlases = [];
    let atlasAllocated = false;
    const max3D = Math.max(64, renderer?.capabilities?.max3DTextureSize || 2048);
    let configs = SVRManager.atlasConfigs().filter(cfg => cfg.dim <= max3D && cfg.depth <= max3D);
    const targetSlots = Math.max(1, Math.ceil(Number(options.targetSlots) || 0));
    if (targetSlots > 1) {
      configs = configs
        .filter(cfg => SVRManager.slotsForConfig(cfg, this.brickSize) >= targetSlots)
        .sort((a, b) => SVRManager.slotsForConfig(a, this.brickSize) - SVRManager.slotsForConfig(b, this.brickSize));
    } else {
      // CAP-008: no explicit brick demand — keep the historical 4096-slot ceiling so a
      // degenerate (0-1 brick) load never probes the 5-8 GiB tiers added above.
      configs = configs.filter(cfg => SVRManager.slotsForConfig(cfg, this.brickSize) <= 4096);
    }
    for (const config of configs) {
      this._applyAtlasConfig(config);
      const candidateAtlases = [];
      try {
        for (let page = 0; page < this.atlasPages; page++) {
          const atlas = new TextureClass(null, this.atlasDim, this.atlasDim, this.atlasDepth);
          atlas.format = THREE.RGBAFormat;
          atlas.type = THREE.UnsignedByteType;
          // SVR slots are packed edge-to-edge in the atlas. Linear filtering would
          // interpolate with neighboring slots at brick boundaries and create seams.
          atlas.minFilter = THREE.NearestFilter;
          atlas.magFilter = THREE.NearestFilter;
          atlas.unpackAlignment = 1;
          if (renderer) {
            this._initAtlasTexture(atlas);
          }
          atlas.needsUpdate = false;
          candidateAtlases.push(atlas);
        }
        allocatedAtlases = candidateAtlases;
        atlasAllocated = true;
        SVRManager._lastWorkingSlots = Math.max(SVRManager._lastWorkingSlots || 0, this.maxSlots);
        break;
      } catch (err) {
        console.warn(`[SVRManager] Atlas ${this.atlasDim}x${this.atlasDim}x${this.atlasDepth}x${this.atlasPages} rejected; trying smaller atlas.`, err);
        for (const atlas of candidateAtlases) {
          this._disposeAtlasTexture(atlas);
          atlas.dispose?.();
        }
        allocatedAtlases = [];
        // SVR-012: drain any stale GL errors produced by the failed glTexStorage3D so they
        // don't contaminate texSubImage3D calls on the next (smaller) atlas config.
        const gl = renderer?.getContext?.();
        if (gl && typeof gl.getError === 'function') {
          while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
        }
      }
    }
    if (!atlasAllocated || !allocatedAtlases.length) {
      throw new Error('SVR atlas GPU allocation failed for all fallback sizes');
    }
    // BUG-035 / STREAMING-21: build slotToBrick AND freeSlots ONCE, on the FINAL
    // maxSlots the cascade actually allocated. If the cascade fell back to a LARGER
    // atlas than _selectAtlasConfig's provisional pick, a slotToBrick sized on that
    // initial pick would be too short: at eviction `oldKey = slotToBrick[slotIndex]`
    // reads undefined for the extra slots, the `if (oldKey)` guard skips clearing the
    // stale PageTable entry, and that slot keeps pointing at the wrong brick — the
    // shader then samples another brick's voxels (corrupted scientific data) under
    // VRAM pressure. Invariant restored: slotToBrick.length === freeSlots.length === maxSlots.
    this.slotToBrick = new Array(this.maxSlots).fill(null);
    this.freeSlots = [];
    for(let i=0; i<this.maxSlots; i++) this.freeSlots.push(i);
    this.atlases.push(...allocatedAtlases);
    
    this.updateUniforms();
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

  _selectAtlasConfig(renderer, options = {}) {
    const max3D = Math.max(64, renderer?.capabilities?.max3DTextureSize || 2048);
    const configs = SVRManager.atlasConfigs().filter(cfg => cfg.dim <= max3D && cfg.depth <= max3D);
    const targetSlots = Math.max(1, Math.ceil(Number(options.targetSlots) || 0));
    if (targetSlots > 1) {
      const candidates = configs
        .filter(cfg => SVRManager.slotsForConfig(cfg, this.brickSize) >= targetSlots)
        .sort((a, b) => SVRManager.slotsForConfig(a, this.brickSize) - SVRManager.slotsForConfig(b, this.brickSize));
      this._applyAtlasConfig(candidates[0] || configs[configs.length - 1]);
      return;
    }
    // CAP-008: default the untargeted preference to the historical 4096 ceiling (not
    // Infinity) so the provisional pick never lands on the 5-8 GiB tiers without an
    // explicit targetSlots demand.
    const preferredSlots = SVRManager._lastWorkingSlots || 4096;
    const config = configs.find(cfg => SVRManager.slotsForConfig(cfg, this.brickSize) <= preferredSlots) || configs[configs.length - 1];
    this._applyAtlasConfig(config);
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
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
    if (gl.PIXEL_UNPACK_BUFFER) {
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    }

    if (typeof gl.texStorage3D === 'function') {
      gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA8, this.atlasDim, this.atlasDim, this.atlasDepth);
    } else {
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        gl.RGBA,
        this.atlasDim,
        this.atlasDim,
        this.atlasDepth,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null
      );
    }

    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      gl.deleteTexture(tex);
      if (prevBinding !== null) {
        gl.bindTexture(gl.TEXTURE_3D, prevBinding);
      }
      throw new Error(`SVR atlas GPU allocation failed (${this.atlasDim}x${this.atlasDim}x${this.atlasDepth}, glError=${err})`);
    }

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
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
    const properties = this.renderer.properties.get(atlas);
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
  
  updateUniforms() {
    if (!this.material) return;
    this.material.defines.ENABLE_SVR = 1;
    this.material.needsUpdate = true;
    
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
    if (this.material.uniforms.svrAtlas1) this.material.uniforms.svrAtlas1.value = this.atlases[1] || this.atlases[0] || null;
    if (this.material.uniforms.svrAtlas2) this.material.uniforms.svrAtlas2.value = this.atlases[2] || this.atlases[0] || null;
    if (this.material.uniforms.svrAtlas3) this.material.uniforms.svrAtlas3.value = this.atlases[3] || this.atlases[0] || null;
    if (this.material.uniforms.svrAtlas4) this.material.uniforms.svrAtlas4.value = this.atlases[4] || this.atlases[0] || null;
    if (this.material.uniforms.svrAtlas5) this.material.uniforms.svrAtlas5.value = this.atlases[5] || this.atlases[0] || null;
    if (this.material.uniforms.svrAtlas6) this.material.uniforms.svrAtlas6.value = this.atlases[6] || this.atlases[0] || null;
    if (this.material.uniforms.svrAtlas7) this.material.uniforms.svrAtlas7.value = this.atlases[7] || this.atlases[0] || null;
  }

  getSlot(bx, by, bz) {
    const key = `${bx}_${by}_${bz}`;
    if (this.brickMap.has(key)) {
      const slot = this.brickMap.get(key);
      // Move to back of LRU
      this.slotQueue = this.slotQueue.filter(s => s !== slot);
      this.slotQueue.push(slot);
      return slot;
    }
    
    let slotIndex;
    if (this.freeSlots.length > 0) {
      slotIndex = this.freeSlots.pop();
    } else {
      // Evict oldest
      slotIndex = this.slotQueue.shift();
      const oldKey = this.slotToBrick[slotIndex];
      if (oldKey) {
        this.brickMap.delete(oldKey);
        // Clear it in Page Table
        const [px, py, pz] = oldKey.split('_').map(Number);
        const ptIdx = (pz * this.ptNx * this.ptNy + py * this.ptNx + px) * 4;
        this.pageData[ptIdx + 3] = 0; // invalidate
        this.slotToBrick[slotIndex] = null;
      }
    }
    
    this.brickMap.set(key, slotIndex);
    this.slotToBrick[slotIndex] = key;
    this.slotQueue.push(slotIndex);
    return slotIndex;
  }

  writeBrick(channel, bx, by, bz, brickData, bw, bh, bd) {
    if (channel >= this.channels) return;
    const slotIndex = this.getSlot(bx, by, bz);
    const coord = this._slotCoord(slotIndex);

    // ELE-23 (BUG-002): always (re)point the PageTable at the slot getSlot just
    // assigned. The slot may have been recycled from another brick by eviction,
    // so a non-zero alpha does NOT guarantee this entry already maps the right slot.
    const ptIdx = (bz * this.ptNx * this.ptNy + by * this.ptNx + bx) * 4;
    this.pageData[ptIdx + 0] = coord.x;
    this.pageData[ptIdx + 1] = coord.y;
    this.pageData[ptIdx + 2] = coord.z;
    this.pageData[ptIdx + 3] = coord.atlas + 1;
    this.pageTable.needsUpdate = true; // small texture, full update is fine

    // Upload to Atlas
    const sx = coord.x * this.brickSize;
    const sy = coord.y * this.brickSize;
    const sz = coord.z * this.brickSize;
    this._writeChannelToSlot(slotIndex, channel, brickData, bw, bh, bd);
    const uploadData = this._extractSlotRegion(slotIndex, bw, bh, bd);
    // SVR-012: if the GPU upload fails, clear the PageTable entry so the shader
    // treats this brick as missing (ray skip) rather than sampling garbage memory.
    if (this._uploadRgbaRegion(coord.atlas, sx, sy, sz, bw, bh, bd, uploadData) === false) {
      this.pageData[ptIdx + 3] = 0;
      this.pageTable.needsUpdate = true;
    }
  }

  writeRgbaBrick(bx, by, bz, brickData, bw, bh, bd) {
    const slotIndex = this.getSlot(bx, by, bz);
    const coord = this._slotCoord(slotIndex);

    // ELE-23 (BUG-002): always (re)point the PageTable at the slot getSlot just
    // assigned (it may have been recycled by eviction); a non-zero alpha does not
    // guarantee this entry already maps to the correct slot.
    const ptIdx = (bz * this.ptNx * this.ptNy + by * this.ptNx + bx) * 4;
    this.pageData[ptIdx + 0] = coord.x;
    this.pageData[ptIdx + 1] = coord.y;
    this.pageData[ptIdx + 2] = coord.z;
    this.pageData[ptIdx + 3] = coord.atlas + 1;
    this.pageTable.needsUpdate = true;
    const sx = coord.x * this.brickSize;
    const sy = coord.y * this.brickSize;
    const sz = coord.z * this.brickSize;
    const uploadData = this._compactRgbaBrickData(brickData, bw, bh, bd);
    // SVR-012: if the GPU upload fails, clear the PageTable entry (same as writeBrick).
    if (this._uploadRgbaRegion(coord.atlas, sx, sy, sz, bw, bh, bd, uploadData) === false) {
      this.pageData[ptIdx + 3] = 0;
      this.pageTable.needsUpdate = true;
    }
  }

  _compactRgbaBrickData(brickData, bw, bh, bd) {
    if (!brickData) return null;
    const bs = this.brickSize;
    const required = bw * bh * bd * 4;
    if (brickData.length === required) return brickData;
    const uploadData = new Uint8Array(required);
    let dst = 0;
    for (let lz = 0; lz < bd; lz++) {
      const srcZOff = lz * bs * bs * 4;
      for (let ly = 0; ly < bh; ly++) {
        const srcIdx = srcZOff + ly * bs * 4;
        const len = bw * 4;
        uploadData.set(brickData.subarray(srcIdx, srcIdx + len), dst);
        dst += len;
      }
    }
    return uploadData;
  }

  _slotBuffer(slotIndex) {
    let slot = this.slotData.get(slotIndex);
    if (!slot) {
      slot = new Uint8Array(this.brickSize * this.brickSize * this.brickSize * 4);
      this.slotData.set(slotIndex, slot);
    }
    return slot;
  }

  _writeChannelToSlot(slotIndex, channel, brickData, bw, bh, bd) {
    if (!brickData) return;
    const slot = this._slotBuffer(slotIndex);
    const bs = this.brickSize;
    for (let lz = 0; lz < bd; lz++) {
      const srcZOff = lz * bs * bs;
      for (let ly = 0; ly < bh; ly++) {
        let srcIdx = srcZOff + ly * bs;
        let dstIdx = ((lz * bs + ly) * bs) * 4 + channel;
        for (let lx = 0; lx < bw; lx++) {
          slot[dstIdx] = brickData[srcIdx++] || 0;
          dstIdx += 4;
        }
      }
    }
  }

  _writeRgbaToSlot(slotIndex, brickData, bw, bh, bd) {
    if (!brickData) return;
    const slot = this._slotBuffer(slotIndex);
    const bs = this.brickSize;
    for (let lz = 0; lz < bd; lz++) {
      const srcZOff = lz * bs * bs * 4;
      for (let ly = 0; ly < bh; ly++) {
        const srcIdx = srcZOff + ly * bs * 4;
        const dstIdx = ((lz * bs + ly) * bs) * 4;
        slot.set(brickData.subarray(srcIdx, srcIdx + bw * 4), dstIdx);
      }
    }
  }

  _extractSlotRegion(slotIndex, bw, bh, bd) {
    const slot = this._slotBuffer(slotIndex);
    const bs = this.brickSize;
    const uploadData = new Uint8Array(bw * bh * bd * 4);
    let dst = 0;
    for (let lz = 0; lz < bd; lz++) {
      for (let ly = 0; ly < bh; ly++) {
        const srcIdx = ((lz * bs + ly) * bs) * 4;
        const len = bw * 4;
        uploadData.set(slot.subarray(srcIdx, srcIdx + len), dst);
        dst += len;
      }
    }
    return uploadData;
  }

  _uploadRgbaRegion(atlasIndex, sx, sy, sz, bw, bh, bd, uploadData) {
    const atlas = this.atlases[atlasIndex];
    if (!this.renderer || !atlas || !uploadData) return;
    if (
      sx < 0 || sy < 0 || sz < 0 ||
      sx + bw > this.atlasDim ||
      sy + bh > this.atlasDim ||
      sz + bd > this.atlasDepth
    ) {
      console.warn('[SVRManager] Skipping out-of-bounds atlas upload', {
        sx, sy, sz, bw, bh, bd,
        atlasIndex,
        atlasDim: this.atlasDim,
        atlasDepth: this.atlasDepth
      });
      return;
    }
    
    const properties = this.renderer.properties.get(atlas);
    const webglTexture = properties?.__webglTexture;
    if (webglTexture) {
      const gl = this.renderer.getContext();
      let prevBinding = null;
      if (this.renderer.state && this.renderer.state.bindTexture) {
        this.renderer.state.bindTexture(gl.TEXTURE_3D, webglTexture);
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

      gl.texSubImage3D(
        gl.TEXTURE_3D,
        0,
        sx, sy, sz,
        bw, bh, bd,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        uploadData
      );

      // SVR-012: check for GL error after upload. If glTexStorage3D failed during the
      // cascade, stale GL state can cause texSubImage3D to silently fail — leaving the
      // atlas slot with uninitialised GPU memory (appears as pink/garbage in the shader).
      const glErr = gl.getError();

      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);

      if (prevBinding !== null) {
        gl.bindTexture(gl.TEXTURE_3D, prevBinding);
      }

      if (glErr !== gl.NO_ERROR) {
        console.warn('[SVRManager] texSubImage3D failed (glError=' + glErr + ') at atlas=' + atlasIndex + ' offset=' + sx + ',' + sy + ',' + sz);
        return false;
      }
      return true;
    }
    return true;
  }

  dispose() {
    this._releaseGpuResources();
    this.pageData = null;
    if (this.slotData) this.slotData.clear();
    this.brickMap.clear();
    this.slotQueue = [];
    this.freeSlots = [];
    this.slotToBrick = [];
  }
}

window.SVRManager = SVRManager;
