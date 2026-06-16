/* ============================================================
   IRIBHM Microscopy Platform — Volume Grid & Axes Module
   ============================================================
   Manages the spatial reference grid, coordinate axes, and
   scale bar overlay. Extracted from volume-viewer.js for
   modularity.
   ============================================================ */

const VolumeGrid = (() => {
  // Dependencies injected via init()
  let _scene = null;
  let _cube = null;
  let _camera = null;
  let _renderer = null;
  let _material = null;
  let _projVertexShader = '';
  let _fragmentShader = '';
  let _onDirty = null; // callback to wake the render loop

  // Internal state
  let _gridGroup = null;
  let _axesGroup = null;
  let _gridMode = 0; // 0: none, 1: normal, 2: fine
  let _axesVisible = false;
  let _gridSizes = { xy: 1.5, xz: 1.5, yz: 1.5 };
  let _axesLocalPos = new THREE.Vector3(-0.75, -0.75, -0.75);

  /**
   * Initialize with references to shared scene objects.
   * @param {Object} deps - { scene, cube, camera, renderer, material, projVertexShader, fragmentShader, onDirty }
   */
  function init(deps) {
    _scene = deps.scene;
    _cube = deps.cube;
    _camera = deps.camera;
    _renderer = deps.renderer;
    _material = deps.material;
    _projVertexShader = deps.projVertexShader || '';
    _fragmentShader = deps.fragmentShader || '';
    _onDirty = deps.onDirty || (() => {});
  }

  /** Update live references when cube/camera change (e.g. after reload) */
  function updateRefs(refs) {
    if (refs.cube !== undefined) _cube = refs.cube;
    if (refs.camera !== undefined) _camera = refs.camera;
    if (refs.renderer !== undefined) _renderer = refs.renderer;
    if (refs.material !== undefined) _material = refs.material;
  }

  function _dirty() {
    if (_onDirty) _onDirty();
  }

  // ─── Public API ───

  function setGridMode(mode) {
    _gridMode = mode % 3;
    rebuild();
  }

  function getGridMode() {
    return _gridMode;
  }

  function setAxesVisible(visible) {
    _axesVisible = visible;
    rebuild();
  }

  function isAxesVisible() {
    return _axesVisible;
  }

  function getGridSizes() {
    return { ..._gridSizes };
  }

  function setGridSize(plane, size) {
    if (_gridSizes[plane] !== undefined) {
      _gridSizes[plane] = size;
      rebuild();
    }
  }

  function resetGridSize(plane) {
    if (_gridSizes[plane] !== undefined) {
      _gridSizes[plane] = 1.5;
      rebuild();
    }
  }

  function getAxesLocalPos() {
    return _axesLocalPos.clone();
  }

  function resetAxesPos() {
    _axesLocalPos.set(-0.75, -0.75, -0.75);
    rebuild();
  }

  function setAxesLocalPos(x, y, z) {
    _axesLocalPos.set(x, y, z);
    rebuild();
  }

  function getGridGroup() { return _gridGroup; }
  function getAxesGroup() { return _axesGroup; }

  // ─── Helpers ───
  function _createTextSprite(text, position, colorHex) {
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
    return sprite;
  }

  // ─── Rebuild Grid & Axes ───

  // ELE-30 (LEAK-001, Rule 1.2): libérer récursivement les ressources GPU des
  // enfants d'un groupe retiré de la scène (geometries, materials, CanvasTexture
  // des sprites X/Y/Z).
  // ATTENTION : THREE.ArrowHelper partage ses géométries line/cone comme
  // singletons au niveau module (three r0.167) — les disposer corromprait tous
  // les autres ArrowHelper. On saute donc la géométrie des enfants d'ArrowHelper
  // et on ne libère que leur material (par instance).
  function _disposeGroup(group) {
    group.traverse((obj) => {
      const isArrowChild = obj.parent && obj.parent.type === 'ArrowHelper';
      if (!isArrowChild) obj.geometry?.dispose?.();
      const mat = obj.material;
      if (Array.isArray(mat)) {
        mat.forEach((m) => { m?.map?.dispose?.(); m?.dispose?.(); });
      } else if (mat) {
        mat.map?.dispose?.();
        mat.dispose?.();
      }
    });
  }

  function rebuild() {
    if (!_scene) return;
    if (_gridGroup) { _scene.remove(_gridGroup); _disposeGroup(_gridGroup); _gridGroup = null; }
    if (_axesGroup) { _scene.remove(_axesGroup); _disposeGroup(_axesGroup); _axesGroup = null; }

    if (_gridMode === 0 && !_axesVisible) {
      _dirty();
      return;
    }

    const baseSize = 1.5;
    const arrowLen = 0.5;

    if (_gridMode > 0) {
      _gridGroup = new THREE.Group();
      const colorCenter = 0x888888;
      const colorGrid = 0x444444;

      const createPlane = (id, size, rx, ry, rz, px, py, pz, nx, ny, nz) => {
        if (size > 0) {
          const divs = _gridMode === 2 ? Math.round(size / (baseSize / 40)) : Math.round(size / (baseSize / 10));
          const grid = new THREE.GridHelper(size, Math.max(1, divs), colorCenter, colorGrid);
          grid.rotation.set(rx, ry, rz);
          grid.position.set(px, py, pz);
          _gridGroup.add(grid);

          if (_material && _cube) {
            let axisIndex = 2;
            let verts;
            if (nx === 1) {
              axisIndex = 0;
              const s = size / 2;
              verts = new Float32Array([
                px, py - s, pz - s, px, py + s, pz - s,
                px, py - s, pz + s, px, py + s, pz + s
              ]);
            } else if (ny === 1) {
              axisIndex = 1;
              const s = size / 2;
              verts = new Float32Array([
                px - s, py, pz - s, px + s, py, pz - s,
                px - s, py, pz + s, px + s, py, pz + s
              ]);
            } else {
              axisIndex = 2;
              const s = size / 2;
              verts = new Float32Array([
                px - s, py - s, pz, px + s, py - s, pz,
                px - s, py + s, pz, px + s, py + s, pz
              ]);
            }
            const projGeom = new THREE.BufferGeometry();
            projGeom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
            projGeom.setIndex([0, 1, 2, 1, 3, 2]);

            const invScale = new THREE.Vector3(
              1 / (_cube.scale.x || 1),
              1 / (_cube.scale.y || 1),
              1 / (_cube.scale.z || 1)
            );
            const projUniforms = {};
            Object.keys(_material.uniforms).forEach(k => { projUniforms[k] = _material.uniforms[k]; });
            projUniforms.projAxis = { value: axisIndex };
            projUniforms.invCubeScale = { value: invScale };

            const projMat = new THREE.ShaderMaterial({
              glslVersion: THREE.GLSL3,
              vertexShader: _projVertexShader,
              fragmentShader: _fragmentShader,
              uniforms: projUniforms,
              defines: _material.defines ? { ..._material.defines } : {},
              transparent: true,
              depthWrite: false,
              side: THREE.DoubleSide
            });

            const projMesh = new THREE.Mesh(projGeom, projMat);
            projMesh.userData.isProjMesh = true;
            _gridGroup.add(projMesh);
          }
        }

        const handleGeom = new THREE.SphereGeometry(0.04, 16, 16);
        const handleMat = new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.0, depthTest: false });
        const handle = new THREE.Mesh(handleGeom, handleMat);
        const hx = px + (nx === 0 ? size / 2 : 0);
        const hy = py + (ny === 0 ? size / 2 : 0);
        const hz = pz + (nz === 0 ? size / 2 : 0);
        handle.position.set(hx, hy, hz);
        handle.userData = { isGridHandle: true, plane: id, normal: new THREE.Vector3(nx, ny, nz) };
        _gridGroup.add(handle);
      };

      createPlane('xy', _gridSizes.xy, Math.PI / 2, 0, 0, -baseSize / 2 + _gridSizes.xy / 2, -baseSize / 2 + _gridSizes.xy / 2, -baseSize / 2, 0, 0, 1);
      createPlane('xz', _gridSizes.xz, 0, 0, 0, -baseSize / 2 + _gridSizes.xz / 2, -baseSize / 2, -baseSize / 2 + _gridSizes.xz / 2, 0, 1, 0);
      createPlane('yz', _gridSizes.yz, 0, 0, Math.PI / 2, -baseSize / 2, -baseSize / 2 + _gridSizes.yz / 2, -baseSize / 2 + _gridSizes.yz / 2, 1, 0, 0);

      if (_cube) {
        _gridGroup.position.copy(_cube.position);
        _gridGroup.quaternion.copy(_cube.quaternion);
      }
      _scene.add(_gridGroup);
    }

    if (_axesVisible) {
      _axesGroup = new THREE.Group();
      const origin = new THREE.Vector3(0, 0, 0);
      const xAxis = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), origin, arrowLen, 0xff0000, arrowLen * 0.1, arrowLen * 0.05);
      const yAxis = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), origin, arrowLen, 0x00ff00, arrowLen * 0.1, arrowLen * 0.05);
      const zAxis = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), origin, arrowLen, 0x0088ff, arrowLen * 0.1, arrowLen * 0.05);
      _axesGroup.add(xAxis, yAxis, zAxis);

      const xLabel = _createTextSprite("X", new THREE.Vector3(arrowLen + 0.1, 0, 0), 0xff0000);
      const yLabel = _createTextSprite("Y", new THREE.Vector3(0, arrowLen + 0.1, 0), 0x00ff00);
      const zLabel = _createTextSprite("Z", new THREE.Vector3(0, 0, arrowLen + 0.1), 0x0088ff);
      _axesGroup.add(xLabel, yLabel, zLabel);

      const sphereGeom = new THREE.SphereGeometry(0.06, 16, 16);
      const sphereMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.0, depthTest: false });
      const sphere = new THREE.Mesh(sphereGeom, sphereMat);
      sphere.userData = { isAxesSphere: true };
      _axesGroup.add(sphere);

      if (_cube) {
        const worldPos = _axesLocalPos.clone().applyQuaternion(_cube.quaternion).add(_cube.position);
        _axesGroup.position.copy(worldPos);
        _axesGroup.quaternion.copy(_cube.quaternion);
      } else {
        _axesGroup.position.copy(_axesLocalPos);
      }
      _scene.add(_axesGroup);
    }
    _dirty();
  }

  // ─── Per-frame Sync ───

  /** Called every frame to keep grid and axes in sync with cube rotation */
  function syncTransforms() {
    if (!_cube) return;
    if (_gridGroup) {
      _gridGroup.position.copy(_cube.position);
      _gridGroup.quaternion.copy(_cube.quaternion);
      const invScale = new THREE.Vector3(
        1 / (_cube.scale.x || 1),
        1 / (_cube.scale.y || 1),
        1 / (_cube.scale.z || 1)
      );
      const isInteractingNow = _cube.userData.isInteractingNow;
      _gridGroup.children.forEach(child => {
        if (child.userData.isProjMesh) {
          if (child.material?.uniforms?.invCubeScale) {
            child.material.uniforms.invCubeScale.value.copy(invScale);
          }
          if (child.material?.uniforms?.steps && _material?.uniforms?.steps) {
            child.material.uniforms.steps.value = _material.uniforms.steps.value;
          }
        }
      });
      if (_camera) {
        const camDir = new THREE.Vector3();
        _camera.getWorldDirection(camDir);
        _gridGroup.children.forEach(child => {
          if (child.userData.isGridHandle) {
            const worldNormal = child.userData.normal.clone().applyQuaternion(_cube.quaternion);
            const dot = Math.abs(camDir.dot(worldNormal));
            const isParallel = dot > 0.939;
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
    }
    if (_axesGroup) {
      const worldPos = _axesLocalPos.clone().applyQuaternion(_cube.quaternion).add(_cube.position);
      _axesGroup.position.copy(worldPos);
      _axesGroup.quaternion.copy(_cube.quaternion);
      _axesGroup.children.forEach(child => {
        if (child.userData.isAxesSphere) {
          if (!child.userData.hovered) {
            child.material.opacity = 0.0;
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
        const center = _cube ? _cube.position.clone() : new THREE.Vector3();
        const dist = _camera.position.distanceTo(center);
        const vFOV = THREE.MathUtils.degToRad(_camera.fov);
        const heightAtCenter = 2 * Math.tan(vFOV / 2) * dist;
        const rect = _renderer.domElement.getBoundingClientRect();
        const pixelsPerUnit = rect.height / Math.max(0.001, heightAtCenter);
        const stepSize = 1.5 / 10;
        const pixelLength = stepSize * pixelsPerUnit;
        scaleBar.style.width = `${Math.max(20, pixelLength)}px`;
        scaleBar.innerText = '200 µm';
      }
    }
  }

  /** Move axes to a world-space point projected from screen click */
  function moveAxesToScreenPoint(clientX, clientY) {
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
      if (_cube) {
        _axesLocalPos = target.clone().sub(_cube.position)
          .applyQuaternion(_cube.quaternion.clone().invert());
      } else {
        _axesLocalPos.copy(target);
      }
      _dirty();
    }
  }

  // ELE-30: teardown complet (switch de dataset / destruction du viewer) — Rule 1.2.
  function dispose() {
    if (_gridGroup && _scene) { _scene.remove(_gridGroup); }
    if (_gridGroup) { _disposeGroup(_gridGroup); _gridGroup = null; }
    if (_axesGroup && _scene) { _scene.remove(_axesGroup); }
    if (_axesGroup) { _disposeGroup(_axesGroup); _axesGroup = null; }
  }

  return {
    init,
    updateRefs,
    rebuild,
    dispose,
    _disposeGroup,   // exposed for unit testing (ELE-30)
    syncTransforms,
    setGridMode,
    getGridMode,
    setAxesVisible,
    isAxesVisible,
    getGridSizes,
    setGridSize,
    resetGridSize,
    getAxesLocalPos,
    setAxesLocalPos,
    resetAxesPos,
    moveAxesToScreenPoint,
    getGridGroup,
    getAxesGroup
  };
})();
