/* Orientation Axes — index.js */
PluginRegistry.implement('orientation-axes', {
  _visible: false,
  _ctx: null,
  _group: null,
  _calibrationMode: false,
  _rafId: null,
  _baseQuaternion: null, // Stored dataset quaternion
  _isDragging: false,
  _localPos: new THREE.Vector3(-0.75, -0.75, -0.75),

  init(ctx) {
    this._ctx = ctx;
    this._visible = false;
    this._baseQuaternion = new THREE.Quaternion();
    
    // Check if orientation is saved in dataset meta
    const meta = this._ctx.dataset.getMeta();
    if (meta && meta.orientation) {
      this._baseQuaternion.set(
        meta.orientation.x || 0,
        meta.orientation.y || 0,
        meta.orientation.z || 0,
        meta.orientation.w !== undefined ? meta.orientation.w : 1
      );
    }

    // Build the 3D group
    this._buildGroup();

    // Listen for admin panel messages
    this._msgHandler = this._onMessage.bind(this);
    window.addEventListener('message', this._msgHandler);

    return this;
  },

  _buildGroup() {
    this._group = new THREE.Group();
    const arrowLen = 0.5;

    // A/P = Green (Y-axis)
    // A: +Y
    const aAxis = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0,0,0), arrowLen, 0x00ff00, arrowLen * 0.15, arrowLen * 0.1);
    // P: -Y
    const pAxis = new THREE.ArrowHelper(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0,0,0), arrowLen, 0x00ff00, arrowLen * 0.15, arrowLen * 0.1);

    // D/V = Blue (Z-axis)
    // V: +Z
    const vAxis = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0,0,0), arrowLen, 0x0088ff, arrowLen * 0.15, arrowLen * 0.1);
    // D: -Z
    const dAxis = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0,0,0), arrowLen, 0x0088ff, arrowLen * 0.15, arrowLen * 0.1);

    // L/R = Red (X-axis)
    // R: +X
    const rAxis = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0,0,0), arrowLen, 0xff0000, arrowLen * 0.15, arrowLen * 0.1);
    // L: -X
    const lAxis = new THREE.ArrowHelper(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0,0,0), arrowLen, 0xff0000, arrowLen * 0.15, arrowLen * 0.1);

    this._group.add(aAxis, pAxis, vAxis, dAxis, rAxis, lAxis);

    // Center drag sphere
    const sphereGeom = new THREE.SphereGeometry(0.08, 16, 16);
    const sphereMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.0, depthTest: false });
    const sphere = new THREE.Mesh(sphereGeom, sphereMat);
    sphere.userData = { isOrientationSphere: true, pluginId: 'orientation-axes' };
    this._group.add(sphere);

    // Text Sprites
    // Anatomical axis glyphs default to the standard A/P/V/D/R/L notation in
    // every locale, but are sourced from the plugin lang folder so they can be
    // localized per language if ever needed.
    const t = (k) => this._ctx.i18n.t(k);
    this._addTextSprite(t('axisA'), new THREE.Vector3(0, arrowLen + 0.1, 0), 0x00ff00);
    this._addTextSprite(t('axisP'), new THREE.Vector3(0, -arrowLen - 0.1, 0), 0x00ff00);
    this._addTextSprite(t('axisV'), new THREE.Vector3(0, 0, arrowLen + 0.1), 0x0088ff);
    this._addTextSprite(t('axisD'), new THREE.Vector3(0, 0, -arrowLen - 0.1), 0x0088ff);
    this._addTextSprite(t('axisR'), new THREE.Vector3(arrowLen + 0.1, 0, 0), 0xff0000);
    this._addTextSprite(t('axisL'), new THREE.Vector3(-arrowLen - 0.1, 0, 0), 0xff0000);
  },

  _addTextSprite(text, position, colorHex) {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 48px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#' + colorHex.toString(16).padStart(6, '0');
    ctx.fillText(text, 32, 32);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const spriteMaterial = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.position.copy(position);
    sprite.scale.set(0.15, 0.15, 0.15);
    this._group.add(sprite);
  },

  _getCube() {
    const scene = this._ctx.viewer.getScene();
    return scene ? scene.children.find(c => c.type === 'Mesh' && c.geometry instanceof THREE.BoxGeometry) : null;
  },

  _onMessage(e) {
    if (!Utils.isTrustedMessageOrigin(e)) return;
    if (e.data?.type === 'CALIBRATE_ORIENTATION_START') {
      this._calibrationMode = true;
      if (!this._visible) {
        this.activate();
      }
    } else if (e.data?.type === 'CALIBRATE_ORIENTATION_STOP') {
      this._calibrationMode = false;
    } else if (e.data?.type === 'GET_ORIENTATION') {
      const cube = this._getCube();
      if (cube) {
        const q = cube.quaternion;
        e.source.postMessage({ type: 'ORIENTATION_RESULT', quaternion: { x: q.x, y: q.y, z: q.z, w: q.w } }, e.origin);
      }
    }
  },

  _update() {
    if (!this._visible) return;

    const cube = this._getCube();
    const camera = this._ctx.viewer.getCamera();
    if (!cube || !camera) {
      this._rafId = requestAnimationFrame(this._update.bind(this));
      return;
    }

    if (this._calibrationMode) {
      // In calibration mode, axes are fixed at world identity
      this._group.quaternion.identity();
      this._group.position.copy(this._localPos);
    } else {
      // Normal mode: axes follow the embryo but are offset by the calibration base
      // The embryo is at cube.quaternion.
      // The calibration base aligns the embryo to the axes.
      // Q_world = Q_cube * Q_base^{-1}
      const invBase = this._baseQuaternion.clone().invert();
      const finalQ = cube.quaternion.clone().multiply(invBase);
      this._group.quaternion.copy(finalQ);

      const worldPos = this._localPos.clone().applyQuaternion(cube.quaternion).add(cube.position);
      this._group.position.copy(worldPos);
    }

    // BUG-069: removed a dead per-frame forEach (both branches were empty —
    // THREE.Sprite already faces the camera regardless of parent rotation, and the
    // sphere-hover branch was never implemented). It only added GC/iteration cost.

    this._rafId = requestAnimationFrame(this._update.bind(this));
  },  _bindDragEvents() {
    const canvas = this._ctx.viewer.getRenderer().domElement;
    
    this._onPointerDown = (e) => {
      if (!this._visible) return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, this._ctx.viewer.getCamera());
      const intersects = raycaster.intersectObject(this._group, true);
      if (intersects.length > 0 && intersects[0].object.userData.isOrientationSphere) {
        this._isDragging = true;
        this._ctx.viewer.setRotationLocked(true);
        // Force the mouse event to not rotate the scene if possible
        e.stopPropagation();
      }
    };

    this._onPointerMove = (e) => {
      if (!this._visible) return;
      
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      const camera = this._ctx.viewer.getCamera();
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, camera);

      // Handle hover styling
      const intersects = raycaster.intersectObject(this._group, true);
      let isHoveringSphere = false;
      let sphereObj = null;
      for (const hit of intersects) {
        if (hit.object.userData.isOrientationSphere) {
          isHoveringSphere = true;
          sphereObj = hit.object;
          break;
        }
      }

      let hoverChanged = false;

      // If we are hovering OR dragging, highlight the sphere
      if (sphereObj) {
        if (isHoveringSphere || this._isDragging) {
          if (sphereObj.material.opacity !== 0.4) hoverChanged = true;
          sphereObj.material.opacity = 0.4;
          sphereObj.scale.setScalar(1.5);
          canvas.style.cursor = 'move';
        }
      } else {
        // Find the sphere to reset it if not hovering
        this._group.children.forEach(c => {
          if (c.userData.isOrientationSphere && !this._isDragging) {
            if (c.material.opacity !== 0.0) hoverChanged = true;
            c.material.opacity = 0.0;
            c.scale.setScalar(1.0);
            canvas.style.cursor = '';
          }
        });
      }
      
      if (hoverChanged) {
        VolumeViewer.triggerRender();
      }

      if (!this._isDragging) return;

      const camDir = new THREE.Vector3();
      camera.getWorldDirection(camDir);
      
      const planePoint = this._group.position.clone();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, planePoint);
      
      const target = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(plane, target)) {
        if (this._calibrationMode) {
          this._localPos.copy(target);
        } else {
          const cube = this._getCube();
          if (cube) {
            this._localPos = target.clone().sub(cube.position).applyQuaternion(cube.quaternion.clone().invert());
          }
        }
        VolumeViewer.triggerRender();
      }
    };

    this._onPointerUp = () => {
      if (this._isDragging) {
        this._isDragging = false;
        this._ctx.viewer.setRotationLocked(false);
        // Reset sphere style
        this._group.children.forEach(c => {
          if (c.userData.isOrientationSphere) {
            c.material.opacity = 0.0;
            c.scale.setScalar(1.0);
          }
        });
        canvas.style.cursor = '';
        VolumeViewer.triggerRender();
      }
    };

    // Use capturing phase to intercept before viewer.js if possible
    canvas.addEventListener('pointerdown', this._onPointerDown, true);
    window.addEventListener('pointermove', this._onPointerMove, true);
    window.addEventListener('pointerup', this._onPointerUp, true);
  },

  _unbindDragEvents() {
    const canvas = this._ctx.viewer.getRenderer()?.domElement;
    if (canvas && this._onPointerDown) {
      canvas.removeEventListener('pointerdown', this._onPointerDown, true);
    }
    if (this._onPointerMove) {
      window.removeEventListener('pointermove', this._onPointerMove, true);
      window.removeEventListener('pointerup', this._onPointerUp, true);
    }
  },

  activate() {
    this._visible = !this._visible;
    const scene = this._ctx.viewer.getScene();
    if (this._visible) {
      scene.add(this._group);
      this._update();
      this._bindDragEvents();
    } else {
      scene.remove(this._group);
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._unbindDragEvents();
    }
    VolumeViewer.triggerRender();
    return { active: this._visible };
  },

  getState() { 
    return { 
      visible: this._visible, 
      localPos: { x: this._localPos.x, y: this._localPos.y, z: this._localPos.z } 
    }; 
  },

  setState(s) {
    if (typeof s?.localPos === 'object') {
      this._localPos.set(s.localPos.x, s.localPos.y, s.localPos.z);
    }
    if (typeof s?.visible === 'boolean' && s.visible !== this._visible) {
      this.activate();
    }
  },

  dispose() {
    if (this._visible) {
      const scene = this._ctx.viewer.getScene();
      if (scene) scene.remove(this._group);
    }
    if (this._rafId) cancelAnimationFrame(this._rafId);
    window.removeEventListener('message', this._msgHandler);
    this._unbindDragEvents();
    this._visible = false;
  }
});
