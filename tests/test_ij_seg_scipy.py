"""Independent check of the Advanced view's Euclidean distance map (ij-proc-seg.js IJSeg.edmFloat, a port of ImageJ's
EDM) against scipy.ndimage.distance_transform_edt, the exact map.

ImageJ documents its algorithm as a fast approximation: exact for distances < 13, otherwise at most 0.09 too small (never
too large). So for every foreground pixel:  -0.0901 <= imagej - exact <= 1e-5, and background pixels are 0.

Prints a line starting with SKIP and exits 0 when node, numpy or scipy is missing."""
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HELPER = os.path.join(ROOT, "tests", "js", "test_ij_seg_edm_dump.mjs")


def main():
    node = shutil.which("node")
    if not node:
        print("SKIP: node is not installed")
        return 0
    try:
        import numpy as np
        from scipy import ndimage
    except ImportError:
        print("SKIP: numpy / scipy are not installed")
        return 0

    failures = []
    with tempfile.TemporaryDirectory() as tmp:
        run = subprocess.run([node, HELPER, tmp], capture_output=True, text=True, timeout=120)
        if run.returncode != 0:
            print(run.stdout + run.stderr)
            return 1
        with open(os.path.join(tmp, "meta.json"), encoding="utf8") as f:
            meta = json.load(f)
        worst = 0.0
        for k, m in enumerate(meta):
            w, h = m["w"], m["h"]
            mask = np.fromfile(os.path.join(tmp, "mask%d.bin" % k), dtype=np.uint8).reshape(h, w)
            ij = np.fromfile(os.path.join(tmp, "edm%d.bin" % k), dtype="<f4").reshape(h, w).astype(np.float64)
            if not (mask == 0).any():
                continue
            exact = ndimage.distance_transform_edt(mask != 0)
            d = ij - exact
            if (ij[mask == 0] != 0).any():
                failures.append("case %d: background pixels are not 0" % k)
            lo, hi = float(d.min()), float(d.max())
            worst = min(worst, lo)
            if lo < -0.0901 or hi > 1e-5:
                failures.append("case %d: imagej - exact in [%.5f, %.5f]" % (k, lo, hi))
            small = exact < 13
            if small.any() and float(np.abs(d[small]).max()) > 1e-5:
                failures.append("case %d: not exact below distance 13 (max %.6f)" % (k, float(np.abs(d[small]).max())))
        print("worst deviation below the exact map: %.5f" % worst)
    if failures:
        print("\n".join(failures))
        return 1
    print("ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
