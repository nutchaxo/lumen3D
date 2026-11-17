"""Independent read-back of the Advanced view's TIFF writer (ij-core.js IJTiff)
with tifffile: axes, dtype, channels, ImageJ metadata, resolution, pixel values.

Prints a line starting with SKIP and exits 0 when node or tifffile is missing."""
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(ROOT, "tests", "js", "ij_tiff_write_fixture.mjs")


def main():
    node = shutil.which("node")
    if not node:
        print("SKIP: node is not installed")
        return 0
    try:
        import numpy as np
        import tifffile
    except ImportError:
        print("SKIP: numpy / tifffile are not installed")
        return 0

    with tempfile.TemporaryDirectory() as tmp:
        run = subprocess.run([node, FIXTURE, tmp], capture_output=True, text=True, timeout=120)
        if run.returncode != 0:
            print(run.stdout + run.stderr)
            return 1
        with open(os.path.join(tmp, "expected.json"), encoding="utf8") as f:
            expected = json.load(f)

        failures = []

        def check(cond, msg):
            if not cond:
                failures.append(msg)

        for name, exp in expected.items():
            path = os.path.join(tmp, name)
            with tifffile.TiffFile(path) as tf:
                check(tf.is_imagej, name + ": not recognised as ImageJ")
                series = tf.series[0]
                axes = series.axes
                want_axes = "CYX" if exp["channels"] > 1 else "YX"
                check(axes == want_axes, "%s: axes %r != %r" % (name, axes, want_axes))
                dtype = {8: "uint8", 16: "uint16", 32: "float32"}[exp["bitDepth"]]
                check(str(series.dtype) == dtype, "%s: dtype %s != %s" % (name, series.dtype, dtype))
                shape = (exp["channels"], exp["height"], exp["width"]) if exp["channels"] > 1 else (exp["height"], exp["width"])
                check(tuple(series.shape) == shape, "%s: shape %s != %s" % (name, series.shape, shape))

                ij = tf.imagej_metadata or {}
                check(int(ij.get("channels", 1)) == exp["channels"], name + ": channels metadata " + repr(ij.get("channels")))
                check(ij.get("unit") in ("micron", "um", "µm"), name + ": unit " + repr(ij.get("unit")))
                if exp["channels"] > 1:
                    check(ij.get("mode") == "composite", name + ": mode " + repr(ij.get("mode")))
                if "LUTs" in ij:
                    # tifffile unwraps a single LUT to one (3, 256) array instead of a list of one.
                    luts = ij["LUTs"]
                    luts = [luts] if getattr(luts, "ndim", 0) == 2 else list(luts)
                    check(len(luts) == exp["channels"], name + ": LUT count")
                    check(all(tuple(l.shape) == (3, 256) for l in luts), name + ": LUT shape")
                if "Ranges" in ij:
                    check(len(ij["Ranges"]) == 2 * exp["channels"], name + ": range count")

                page = tf.pages[0]
                xr = page.tags["XResolution"].value
                yr = page.tags["YResolution"].value
                want = 1.0 / exp["pixelUm"]
                check(abs(xr[0] / xr[1] - want) < 1e-6, "%s: XResolution %s" % (name, xr))
                check(abs(yr[0] / yr[1] - want) < 1e-6, "%s: YResolution %s" % (name, yr))

                data = tf.asarray()
                want_data = np.array(exp["data"], dtype=dtype).reshape(shape)
                check(np.array_equal(data, want_data), name + ": pixel values differ")

        if failures:
            print("\n".join(failures))
            return 1
        print("test_ij_tiff_tifffile: %d files read back by tifffile %s" % (len(expected), tifffile.__version__))
        return 0


if __name__ == "__main__":
    sys.exit(main())
