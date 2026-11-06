// The display box is as deep as the voxel lattice the texture spreads over [0, 1]:
// n planes of vz µm each, n·vz µm — never (n − 1)·vz + a slice thickness. The old box
// put the centre of plane k at (k + ½)·(n − 1 + t/vz)/n planes, so µm → voxel
// conversions (DataAccess, a plugin dividing by voxelSize.z) read plane k − 1 in the
// far part of an anisotropic stack and Z distances came out short.
//   • computePhysicalScale (lifted and run) on the shape of a pipeline volume without a
//     thickness key (n = 72, vz = 5.535901, vx = 1.277332): z = 72·vz;
//   • with an explicit optical section thinner than the step: the box is still n·vz,
//     the thickness is reported as given;
//   • physicalSizeUm.sliceThickness (what the pipeline writes) is the reported thickness;
//   • the centre of every plane k, picked (_pickResult) and converted by
//     DataAccess.screenToVoxel, is voxel k; physicalUm / vz floors to k as well.
//
// Run: node tests/js/test_physical_z_extent.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, loadModule } from './harness.mjs';

const require = createRequire(import.meta.url);
const THREE = require('../../js/vendor/three.min.js');
const VV = readFileSync(path.join(ROOT, 'js/viewers/volume-viewer.js'), 'utf8').replace(/\r\n/g, '\n');
const lift = (name) => {
  const m = VV.match(new RegExp(`\\n  (?:async )?function ${name}\\((?:[^()]|\\([^()]*\\))*\\) \\{[\\s\\S]*?\\n  \\}\\n`));
  assert.ok(m, `${name} must be defined at module level in volume-viewer.js`);
  return m[0];
};

const U = new Function('THREE', `
  ${lift('computePhysicalScale')}
  ${lift('_explicitSliceThickness')}
  ${lift('_resolveSliceThickness')}
  ${lift('_positiveNumber')}
  ${lift('_pickResult')}
  return { computePhysicalScale, _pickResult };
`)(THREE);

const N = 72, VZ = 5.535901, VXY = 1.277332, W = 512, H = 512;
const base = {
  dimensions: { x: W, y: H, z: N, c: 3 },
  voxel_size: { x: VXY, y: VXY, z: VZ }
};

// ── extent ───────────────────────────────────────────────────────────────────
{
  const p = U.computePhysicalScale(base, N, W).physicalSizeUm;
  assert.ok(Math.abs(p.z - N * VZ) < 1e-9, `z = n·vz (${p.z} vs ${N * VZ})`);
  assert.ok(Math.abs(p.x - W * VXY) < 1e-9 && Math.abs(p.y - H * VXY) < 1e-9, 'x and y unchanged');
  assert.ok(Math.abs(p.sliceThickness - Math.min(VZ, VXY)) < 1e-12, 'no thickness key: the reported estimate is min(vz, vx)');
  assert.equal(p.calibrationStatus, 'estimated');

  const thin = U.computePhysicalScale({ ...base, optical_section_thickness_um: 2 }, N, W).physicalSizeUm;
  assert.ok(Math.abs(thin.z - N * VZ) < 1e-9, 'an optical section thinner than the step does not shrink the box');
  assert.equal(thin.sliceThickness, 2, 'reported as given');
  assert.equal(thin.calibrationStatus, 'exact');

  const piped = U.computePhysicalScale({ ...base, physicalSizeUm: { z: N * VZ, sliceThickness: VZ } }, N, W).physicalSizeUm;
  assert.equal(piped.sliceThickness, VZ, 'physicalSizeUm.sliceThickness is the reported thickness');
  assert.equal(piped.calibrationStatus, 'exact');

  const one = U.computePhysicalScale({ ...base, dimensions: { ...base.dimensions, z: 1 }, optical_section_thickness_um: 3 }, 1, W).physicalSizeUm;
  assert.equal(one.z, 3, 'a single plane is one slice thickness deep');

  const scale = U.computePhysicalScale(base, N, W).scale;
  assert.ok(Math.abs(scale.z - (N * VZ) / (W * VXY)) < 1e-12, 'the cube is stretched to n·vz');
  console.log('display box depth = n·vz: OK');
}

// ── pick → DataAccess.screenToVoxel: plane k is voxel k ──────────────────────
{
  const physical = U.computePhysicalScale(base, N, W).physicalSizeUm;
  let hit = null;
  const DataAccess = loadModule('js/core/data-access.js', 'DataAccess', {
    BrickLoader: {
      isReady: () => true,
      getLevelInfo: (k) => (k === 0 ? { dims: { x: W, y: H, z: N }, voxelSize: { x: VXY, y: VXY, z: VZ } } : null)
    },
    VolumeViewer: { pickVolumePoint: () => hit }
  });
  for (let k = 0; k < N; k++) {
    const local = new THREE.Vector3(0, 0, (k + 0.5) / N - 0.5);
    hit = { ...U._pickResult(local, 'volume', physical, null), onBoundingBox: false, depthSource: 'volume' };
    const v = DataAccess.screenToVoxel(10, 10);
    assert.equal(v.voxel.z, k, `centre of plane ${k} reads voxel ${k} (got ${v.voxel.z})`);
    assert.ok(Math.abs(v.um.z - (k + 0.5) * VZ) < 1e-6, `plane ${k}: µm in the voxel frame`);
    assert.equal(Math.floor(hit.physicalUm.z / VZ), k, `plane ${k}: physicalUm / vz is the same voxel`);
  }
  console.log('every plane centre picks its own voxel: OK');
}

console.log('physical Z extent: OK');
