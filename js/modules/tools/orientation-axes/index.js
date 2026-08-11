/* Orientation Axes — index.js
 *
 * Two jobs, one anatomical frame:
 *   1. the draggable A/P · D/V · L/R gizmo drawn beside the specimen;
 *   2. the dataset's DEFAULT VIEW — the pose the volume is shown in the moment the
 *      dataset is opened. Applied from prepare(), which the registry dispatches
 *      before the first brick is fetched. Rotating after the load would show the
 *      volume in one pose and snap it to another while bricks stream in.
 *
 * Frames — the whole feature is two lines of algebra
 * ---------------------------------------------------
 * `metadata.orientation` (Q_base) is the CUBE quaternion at which the specimen's
 * anatomy sits on the world axes: A→+Y, P→−Y, V→+Z, D→−Z, R→+X, L→−X. So for any
 * cube pose the anatomical frame's world orientation is
 *
 *     Q_anat = Q_cube · Q_base⁻¹     ← what the gizmo is drawn with
 *     Q_cube = Q_anat · Q_base       ← how a default view is applied
 *
 * A default view is therefore STORED as Q_anat: a statement about anatomy ("ventral
 * toward the camera, anterior up"), not about this dataset's raw voxel axes — so
 * refining the calibration later leaves it meaning the same thing.
 *
 * `metadata.orientationAxes` = {
 *     labels:      { A: "Rostral", … }        per-arm rename, missing ⇒ the glyph
 *     hidden:      ["D", "V"]                 arms not drawn
 *     defaultView: { preset, quaternion }     Q_anat, absent ⇒ no default view
 * }
 * The admin panel edits labels/hidden itself but never computes a quaternion: it
 * asks this plugin (postMessage) and stores what comes back, so the geometry has
 * exactly one implementation.
 */

// Gizmo arms, expressed in the anatomical frame.
const ORI_AXIS_DEF = {
  A: { dir: [0, 1, 0],  color: 0x00ff00 },
  P: { dir: [0, -1, 0], color: 0x00ff00 },
  V: { dir: [0, 0, 1],  color: 0x0088ff },
  D: { dir: [0, 0, -1], color: 0x0088ff },
  R: { dir: [1, 0, 0],  color: 0xff0000 },
  L: { dir: [-1, 0, 0], color: 0xff0000 }
};
const ORI_AXIS_CODES = ['A', 'P', 'V', 'D', 'R', 'L'];

// A view preset is two anatomical constraints — which direction faces the camera
// (world +Z) and which one points up (world +Y). That pair pins a rotation exactly.
const ORI_VIEW_PRESETS = {
  ventral:   { face: 'V', up: 'A' },
  dorsal:    { face: 'D', up: 'A' },
  left:      { face: 'L', up: 'A' },
  right:     { face: 'R', up: 'A' },
  anterior:  { face: 'A', up: 'D' },
  posterior: { face: 'P', up: 'D' }
};

/** Quaternion from {x,y,z,w} or [x,y,z,w]; null when absent or degenerate. */
function _oriQuat(v) {
  if (!v) return null;
  const a = Array.isArray(v)
    ? v
    : (typeof v === 'object' ? [v.x, v.y, v.z, v.w !== undefined ? v.w : 1] : null);
  if (!a || a.length !== 4 || !a.every(Number.isFinite)) return null;
  const q = new THREE.Quaternion(a[0], a[1], a[2], a[3]);
  if (q.lengthSq() < 1e-8) return null;
  return q.normalize();
}

/** Q_anat for a named preset — built from its two anatomical constraints. */
function _oriPresetQuat(id) {
  const p = ORI_VIEW_PRESETS[id];
  if (!p) return null;
  const face = new THREE.Vector3().fromArray(ORI_AXIS_DEF[p.face].dir);  // must land on +Z
  const up = new THREE.Vector3().fromArray(ORI_AXIS_DEF[p.up].dir);      // must land on +Y
  const right = new THREE.Vector3().crossVectors(up, face);              // completes the triple
  // m maps +X→right, +Y→up, +Z→face; the view is its inverse (face→+Z, up→+Y).
  const m = new THREE.Matrix4().makeBasis(right, up, face);
  return new THREE.Quaternion().setFromRotationMatrix(m).invert();
}

/** Q_anat for a stored/incoming defaultView descriptor ({preset} and/or {quaternion}). */
function _oriViewQuat(dv) {
  if (!dv || typeof dv !== 'object') return null;
  return _oriQuat(dv.quaternion) || _oriPresetQuat(dv.preset);
}

/** Rule 1.2 — release every GPU resource the gizmo owns before dropping it. */
function _oriDisposeGroup(group) {
  if (!group || typeof group.traverse !== 'function') return;
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      if (m.map) m.map.dispose();
      m.dispose();
    }
  });
}

PluginRegistry.implement('orientation-axes', {
  _visible: false,
  _ctx: null,
  _group: null,
  _calibrationMode: false,
  _rafId: null,
  _baseQuaternion: null,   // Q_base — the dataset's anatomical calibration
  _defaultView: null,      // Q_anat — the dataset's default view, null when unset
  _labels: {},
  _hidden: null,           // Set of hidden axis codes
  _isDragging: false,
  _localPos: new THREE.Vector3(-0.75, -0.75, -0.75),

  /**
   * Pre-load hook (PluginRegistry.prepareAll) — runs between VolumeViewer.init()
   * and the first brick fetch, while the canvas is still empty. This is the ONLY
   * place the default view may be applied: doing it in init(), which runs once the
   * volume is already on screen, would rotate a visible specimen.
   */
  prepare(ctx) {
    this._ctx = ctx;
    this._readConfig();
    const q = this._defaultCubeQuaternion();
    if (!q) return;
    if (typeof VolumeViewer !== 'undefined' && VolumeViewer.setHomeQuaternion) {
      // Registered as the viewer's HOME pose, not merely copied onto the cube, so
      // the "reset view" button returns here instead of to the raw voxel axes.
      VolumeViewer.setHomeQuaternion(q, { apply: true });
    } else {
      const cube = this._getCube();
      if (cube) cube.quaternion.copy(q);
    }
  },

  init(ctx) {
    this._ctx = ctx;
    this._visible = false;
    this._readConfig();

    this._buildGroup();

    // Listen for admin panel messages
    this._msgHandler = this._onMessage.bind(this);
    window.addEventListener('message', this._msgHandler);

    return this;
  },

  /** Re-read everything this plugin draws from the dataset metadata. */
  _readConfig() {
    const meta = this._ctx?.dataset?.getMeta?.() || null;
    this._baseQuaternion = _oriQuat(meta && meta.orientation) || new THREE.Quaternion();
    const cfg = (meta && meta.orientationAxes) || {};
    this._labels = (cfg.labels && typeof cfg.labels === 'object') ? cfg.labels : {};
    this._hidden = new Set(Array.isArray(cfg.hidden) ? cfg.hidden.filter((c) => ORI_AXIS_DEF[c]) : []);
    this._defaultView = _oriViewQuat(cfg.defaultView);
  },

  /** The cube pose that realises the dataset's default view, or null when unset. */
  _defaultCubeQuaternion() {
    if (!this._defaultView) return null;
    return this._defaultView.clone().multiply(this._baseQuaternion || new THREE.Quaternion());
  },

  /** Displayed glyph for an arm: the operator's rename, else the localized letter. */
  _axisLabel(code) {
    const custom = this._labels && this._labels[code];
    if (typeof custom === 'string' && custom.trim()) return custom.trim();
    const key = 'axis' + code;
    const translated = this._ctx?.i18n?.t ? this._ctx.i18n.t(key) : key;
    return (translated && translated !== key) ? translated : code;
  },

  _buildGroup() {
    this._group = new THREE.Group();
    const arrowLen = 0.5;
    const origin = new THREE.Vector3(0, 0, 0);

    // A/P = green (Y), D/V = blue (Z), L/R = red (X). Hidden arms are not built at
    // all rather than made invisible — an operator hides an axis because it is
    // meaningless for that specimen, so it should cost nothing to draw.
    for (const code of ORI_AXIS_CODES) {
      if (this._hidden && this._hidden.has(code)) continue;
      const def = ORI_AXIS_DEF[code];
      const dir = new THREE.Vector3().fromArray(def.dir);
      this._group.add(new THREE.ArrowHelper(dir, origin, arrowLen, def.color, arrowLen * 0.15, arrowLen * 0.1));
      this._addTextSprite(this._axisLabel(code), dir.clone().multiplyScalar(arrowLen + 0.1), def.color);
    }

    // Center drag sphere
    const sphereGeom = new THREE.SphereGeometry(0.08, 16, 16);
    const sphereMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.0, depthTest: false });
    const sphere = new THREE.Mesh(sphereGeom, sphereMat);
    sphere.userData = { isOrientationSphere: true, pluginId: 'orientation-axes' };
    this._group.add(sphere);
  },

  /** Rebuild after a labels/visibility change, preserving on-screen state. */
  _rebuildGroup() {
    const scene = this._ctx?.viewer?.getScene?.();
    const wasMounted = this._visible && this._group && scene;
    if (wasMounted) scene.remove(this._group);
    _oriDisposeGroup(this._group);
    this._buildGroup();
    if (wasMounted) scene.add(this._group);
    if (typeof VolumeViewer !== 'undefined') VolumeViewer.triggerRender();
  },

  _addTextSprite(text, position, colorHex) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 44px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#' + colorHex.toString(16).padStart(6, '0');
    ctx.fillText(text, 64, 32);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const spriteMaterial = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.position.copy(position);
    // 2:1 canvas — the sprite must match it or a renamed axis renders squashed.
    sprite.scale.set(0.30, 0.15, 0.15);
    this._group.add(sprite);
  },

  _getCube() {
    if (typeof VolumeViewer !== 'undefined' && VolumeViewer.getVolumeObject) {
      const obj = VolumeViewer.getVolumeObject();
      if (obj) return obj;
    }
    const scene = this._ctx?.viewer?.getScene?.();
    return scene ? scene.children.find(c => c.type === 'Mesh' && c.geometry instanceof THREE.BoxGeometry) : null;
  },

  _onMessage(e) {
    if (!Utils.isTrustedMessageOrigin(e)) return;
    if (e.data?.type === 'CALIBRATE_ORIENTATION_START') {
      this._calibrationMode = true;
      // Start from the SAVED alignment rather than from wherever the volume happens
      // to sit (a default view may have posed it): the operator refines a
      // calibration, they don't redo it from scratch.
      const cube = this._getCube();
      if (cube && this._baseQuaternion) cube.quaternion.copy(this._baseQuaternion);
      if (!this._visible) {
        this.activate();
      }
      if (typeof VolumeViewer !== 'undefined') VolumeViewer.triggerRender();
    } else if (e.data?.type === 'CALIBRATE_ORIENTATION_STOP') {
      this._calibrationMode = false;
    } else if (e.data?.type === 'GET_ORIENTATION') {
      const cube = this._getCube();
      if (cube) {
        const q = cube.quaternion;
        e.source.postMessage({ type: 'ORIENTATION_RESULT', quaternion: { x: q.x, y: q.y, z: q.z, w: q.w } }, e.origin);
      }
    } else if (e.data?.type === 'SET_ORIENTATION_AXES') {
      // Live preview of the admin panel's axes editor (labels + visibility).
      const cfg = e.data.value || {};
      this._labels = (cfg.labels && typeof cfg.labels === 'object') ? cfg.labels : {};
      this._hidden = new Set(Array.isArray(cfg.hidden) ? cfg.hidden.filter((c) => ORI_AXIS_DEF[c]) : []);
      this._rebuildGroup();
    } else if (e.data?.type === 'APPLY_ORIENTATION_VIEW') {
      // The panel picked a default view: pose the volume AND hand back the Q_anat it
      // must store, so what is saved is exactly what was resolved and shown here.
      const q = _oriViewQuat(e.data.value);
      const cube = this._getCube();
      if (q && cube) {
        this._defaultView = q;
        cube.quaternion.copy(this._defaultCubeQuaternion());
        if (typeof VolumeViewer !== 'undefined') {
          VolumeViewer.setHomeQuaternion?.(cube.quaternion);
          VolumeViewer.triggerRender();
        }
      }
      e.source?.postMessage({
        type: 'ORIENTATION_VIEW_RESULT',
        preset: e.data.value?.preset || 'custom',
        quaternion: q ? q.toArray() : null
      }, e.origin);
    } else if (e.data?.type === 'GET_ORIENTATION_VIEW') {
      // Capture the CURRENT pose as a default view, in the anatomical frame.
      const cube = this._getCube();
      const base = this._baseQuaternion || new THREE.Quaternion();
      const qAnat = cube ? cube.quaternion.clone().multiply(base.clone().invert()) : null;
      if (qAnat) {
        this._defaultView = qAnat;
        if (typeof VolumeViewer !== 'undefined') VolumeViewer.setHomeQuaternion?.(cube.quaternion);
      }
      e.source?.postMessage({
        type: 'ORIENTATION_VIEW_RESULT',
        preset: 'custom',
        quaternion: qAnat ? qAnat.toArray() : null
      }, e.origin);
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
      const invBase = (this._baseQuaternion || new THREE.Quaternion()).clone().invert();
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

  onLanguageChange() {
    // Only the un-renamed arms move with the locale, but rebuilding all of them is
    // cheaper than tracking which glyph came from where.
    this._rebuildGroup();
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
      PluginRegistry.syncToolbarButton('orientation-axes', { active: this._visible });
    }
  },

  /**
   * Gizmo away, dragging over, arms back where the dataset puts them. The cube's
   * pose is NOT touched here: VolumeViewer.resetView() already returns it to the
   * home quaternion this plugin registered in prepare().
   */
  reset() {
    this._calibrationMode = false;
    this._isDragging = false;
    this._localPos.set(-0.75, -0.75, -0.75);
    if (this._visible) this.activate();
    PluginRegistry.syncToolbarButton('orientation-axes', { active: this._visible });
  },

  dispose() {
    if (this._visible) {
      const scene = this._ctx.viewer.getScene();
      if (scene) scene.remove(this._group);
    }
    if (this._rafId) cancelAnimationFrame(this._rafId);
    window.removeEventListener('message', this._msgHandler);
    this._unbindDragEvents();
    _oriDisposeGroup(this._group);
    this._group = null;
    this._visible = false;
  }
});
