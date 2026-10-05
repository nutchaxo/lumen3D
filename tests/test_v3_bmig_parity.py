"""Browser ↔ server parity of the m004 arithmetic (SPEC §13.1, §13.2).

The browser handler's reduction (js/migrations/m004-bricks-v3.js `reducePlane`) and 66³
apron/clamp mosaic (`mosaicBrick`) are run under node on a random volume with odd sizes,
level after level (with and without Z halving), and every brick must equal
dataset_migrations.py `reduce_level` + `brick_with_apron`, voxel for voxel. The level
geometry (`levelPlan` / `level_geometry`) is compared on several acquisitions too.

Skipped when node or numpy is missing.
"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

try:
    import numpy as np
except ImportError:  # pragma: no cover
    np = None

import dataset_migrations as dm

NODE = shutil.which("node")

NODE_SCRIPT = r"""
const vm = require('vm'), fs = require('fs');
const [root, volPath, X, Y, Z, outPath, plansPath] = process.argv.slice(2);
const ctx = vm.createContext({ console });
vm.runInContext(fs.readFileSync(root + '/js/migrations/m004-bricks-v3.js', 'utf8'), ctx);
const I = ctx.LumenMigrationHandlers['m004-bricks-v3']._internals;
let d = { x: +X, y: +Y, z: +Z };
let vol = new Uint8Array(fs.readFileSync(volPath));
const halves = [false, true, false];   // level 1 keeps Z, level 2 halves it, level 3 keeps it
const out = [];
for (let k = 0; k <= halves.length; k++) {
  if (k > 0) {
    const hz = halves[k - 1];
    const n = { x: Math.ceil(d.x / 2), y: Math.ceil(d.y / 2), z: hz ? Math.ceil(d.z / 2) : d.z };
    const next = new Uint8Array(n.x * n.y * n.z);
    for (let z = 0; z < n.z; z++) {
      const s0 = hz ? 2 * z : z;
      const p0 = vol.subarray(s0 * d.x * d.y, (s0 + 1) * d.x * d.y);
      const p1 = hz && s0 + 1 < d.z ? vol.subarray((s0 + 1) * d.x * d.y, (s0 + 2) * d.x * d.y) : null;
      next.set(I.reducePlane(p0, p1, d.x, d.y, n.x, n.y), z * n.x * n.y);
    }
    vol = next; d = n;
  }
  const box = { x0: 0, x1: d.x, y0: 0, y1: d.y, z0: 0, z1: d.z };
  const g = { x: Math.ceil(d.x / 64), y: Math.ceil(d.y / 64), z: Math.ceil(d.z / 64) };
  for (let bz = 0; bz < g.z; bz++) for (let by = 0; by < g.y; by++) for (let bx = 0; bx < g.x; bx++) {
    const m = I.mosaicBrick(vol, box, d, bx, by, bz);
    const b = new Uint8Array(66 * 66 * 66);
    for (let l = 0; l < 66; l++) for (let j = 0; j < 66; j++) for (let i = 0; i < 66; i++) {
      b[(l * 66 + j) * 66 + i] = m.rgba[((Math.floor(l / 9) * 66 + j) * 594 + (l % 9) * 66 + i) * 4];
    }
    out.push(Buffer.from(b));
    out.push(Buffer.from([m.kept ? 1 : 0]));
  }
}
fs.writeFileSync(outPath, Buffer.concat(out));
const plans = JSON.parse(fs.readFileSync(plansPath, 'utf8')).map(([dd, v]) =>
  I.levelPlan({ x: dd[0], y: dd[1], z: dd[2] }, { x: v[0], y: v[1], z: v[2] }).map((L) => [L.dimensions.x, L.dimensions.y, L.dimensions.z, L.halveZ]));
process.stdout.write(JSON.stringify(plans));
"""


@unittest.skipUnless(NODE and np is not None, "node and numpy required")
class M004ParityTest(unittest.TestCase):
    def test_reduction_apron_and_levels(self):
        X, Y, Z = 141, 77, 133
        rng = np.random.default_rng(1234)
        vol = rng.integers(0, 256, size=(Z, Y, X), dtype=np.uint8)
        vol[rng.random(vol.shape) < 0.6] = 0
        vol[:, :, 64:128] = 0          # an all-zero brick column at level 0
        plans = [((3789, 3789, 226), (0.430366, 0.430366, 2.057106)), ((1000, 700, 90), (0.5, 0.8, 2.0)),
                 ((129, 3, 1), (1, 1, 1)), ((4000, 4000, 500), (0.3, 0.31, 0.62)), ((2048, 2048, 60), (0.1, 0.1, 5.0))]
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "vol.bin").write_bytes(vol.tobytes())
            (tmp / "plans.json").write_text(json.dumps(plans))
            (tmp / "p.js").write_text(NODE_SCRIPT, encoding="utf-8")
            res = subprocess.run([NODE, str(tmp / "p.js"), str(ROOT), str(tmp / "vol.bin"), str(X), str(Y), str(Z),
                                  str(tmp / "out.bin"), str(tmp / "plans.json")],
                                 capture_output=True, text=True, timeout=600)
            self.assertEqual(res.returncode, 0, res.stderr)
            js_plans = json.loads(res.stdout)
            got = (tmp / "out.bin").read_bytes()

        for (dims, vs), js in zip(plans, js_plans):
            py = [[*L["dimensions"], L["halveZ"]] for L in dm.level_geometry(dims, vs)]
            self.assertEqual(js, py, f"levels of {dims} {vs}")

        pos = 0
        level = vol
        n = 66 ** 3
        for k, hz in enumerate([None, False, True, False]):
            if hz is not None:
                level = dm.reduce_level(level, hz)
            Zk, Yk, Xk = level.shape
            for bz in range(-(-Zk // 64)):
                for by in range(-(-Yk // 64)):
                    for bx in range(-(-Xk // 64)):
                        ref = np.asarray(dm.brick_with_apron(level, bz, by, bx, (Xk, Yk, Zk)), dtype=np.uint8)
                        js = np.frombuffer(got[pos:pos + n], dtype=np.uint8).reshape(66, 66, 66)
                        kept = got[pos + n]
                        pos += n + 1
                        self.assertTrue(np.array_equal(js, ref), f"level {k} brick {bz},{by},{bx}")
                        self.assertEqual(bool(kept), bool(ref[1:65, 1:65, 1:65].any()), f"ESS level {k} brick {bz},{by},{bx}")
        self.assertEqual(pos, len(got))


if __name__ == "__main__":
    unittest.main()
