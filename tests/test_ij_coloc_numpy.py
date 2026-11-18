"""Independent numpy cross-check of the Advanced Studio's Analyze > Colocalization
(js/modules/studio/advanced-studio/ij-proc-coloc.js).

There is no ImageJ reference for it (Coloc 2 is a Fiji plugin, never copied): this test generates images
with numpy, lets node run `IJColoc.analyze` on them, and recomputes every statistic with numpy / plain
float64 formulas written independently of the JavaScript (np.corrcoef for Pearson, the principal axis of
the covariance matrix (eigh) for the orthogonal regression, boolean masks instead of the JS pair table, a full classical Costes scan over every integer level).
Covers 8-bit, 16-bit (read in place, gathered through a selection, full range) and 32-bit, a selection mask, excluded zero-zero
pixels, NaN / Infinity, both tM denominators, manual and Costes thresholds, and the 2D histogram.

Prints a line starting with SKIP and exits 0 when node, numpy are missing."""
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, "js", "modules", "studio", "advanced-studio")

DRIVER = r"""
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const [dir, input, output] = process.argv.slice(2);
const ctx = vm.createContext({ console });
for (const f of ['ij-core.js', 'ij-proc-coloc.js']) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
const IJColoc = vm.runInContext('IJColoc', ctx);
const cases = JSON.parse(fs.readFileSync(input, 'utf8'));
const T = { 8: Uint8Array, 16: Uint16Array, 32: Float32Array };
const out = cases.map((c) => {
  const num = (arr) => arr.map((v) => (v === 'nan' ? NaN : v === 'inf' ? Infinity : v));
  const mask = c.mask ? { x: c.mask.x, y: c.mask.y, w: c.mask.w, h: c.mask.h, data: Uint8Array.from(c.mask.data) } : null;
  const r = IJColoc.analyze({ a: T[c.bits].from(num(c.a)), b: T[c.bits].from(num(c.b)), width: c.w, height: c.h, bitDepth: c.bits, mask, params: c.params });
  const { hist, ...rest } = r;
  return Object.assign(JSON.parse(JSON.stringify(rest)), { hist: Array.from(hist) });
});
fs.writeFileSync(output, JSON.stringify(out));
"""


def main():
    node = shutil.which("node")
    if not node:
        print("SKIP: node is not installed")
        return 0
    try:
        import numpy as np
    except ImportError:
        print("SKIP: numpy is not installed")
        return 0

    rng = np.random.default_rng(20261117)

    def make(bits, w, h, zeros=0.1, anti=False):
        top = 255 if bits == 8 else 4095
        n = w * h
        sig = rng.random(n) < 0.3
        s = (0.3 + 0.7 * rng.random(n)) * top
        a = np.where(sig, s + rng.random(n) * top * 0.05, rng.random(n) * top * 0.25)
        b = np.where(sig, (top - s if anti else s * 0.8) + rng.random(n) * top * 0.05, rng.random(n) * top * 0.25)
        z = rng.random(n) < zeros
        a[z] = 0
        b[z] = 0
        a = np.clip(np.floor(a), 0, top)
        b = np.clip(np.floor(b), 0, top)
        if bits == 32:
            a = a / top + rng.random(n) * 1e-3
            b = b / top + rng.random(n) * 1e-3
            a[z] = 0
            b[z] = 0
        return a, b

    def mask_box(w, h):
        x, y, mw, mh = 5, 4, w - 17, h - 11
        data = (rng.random(mw * mh) < 0.8).astype(np.uint8)
        return {"x": x, "y": y, "w": mw, "h": mh, "data": data.tolist()}

    P = dict(mode="none", t1=0, t2=0, excludeZero=False, denominator="all")

    def case(name, bits, a, b, w, h, mask=None, **kw):
        p = dict(P, ch1=0, ch2=1, doc2=None)
        p.update(kw)
        c = {"name": name, "bits": bits, "w": w, "h": h, "params": p,
             "a": [("nan" if np.isnan(v) else "inf" if np.isinf(v) else float(v)) for v in a],
             "b": [("nan" if np.isnan(v) else "inf" if np.isinf(v) else float(v)) for v in b], "mask": mask}
        return c

    cases = []
    W, H = 64, 48
    a, b = make(8, W, H)
    cases.append(case("8-bit none", 8, a, b, W, H))
    cases.append(case("8-bit manual den=all", 8, a, b, W, H, mode="manual", t1=60, t2=45))
    cases.append(case("8-bit manual den=above exclude", 8, a, b, W, H, mode="manual", t1=60, t2=45, denominator="above", excludeZero=True))
    cases.append(case("8-bit roi costes", 8, a, b, W, H, mask=mask_box(W, H), mode="costes"))
    cases.append(case("8-bit costes", 8, a, b, W, H, mode="costes"))
    a, b = make(8, W, H, anti=True)
    cases.append(case("8-bit anti costes (fails)", 8, a, b, W, H, mode="costes"))
    a, b = make(16, W, H)
    cases.append(case("16-bit dense costes", 16, a, b, W, H, mode="costes"))
    cases.append(case("16-bit roi costes", 16, a, b, W, H, mask=mask_box(W, H), mode="costes"))
    cases.append(case("16-bit manual roi", 16, a, b, W, H, mask=mask_box(W, H), mode="manual", t1=900, t2=700, denominator="above"))
    cases.append(case("16-bit exclude zero costes", 16, a, b, W, H, mode="costes", excludeZero=True))
    # full-range 16-bit: a ladder of tens of thousands of levels
    fa = np.floor(rng.random(W * H) ** 2 * 65535)
    fb = np.clip(np.floor(fa * 0.7 + rng.random(W * H) * 12000), 0, 65535)
    cases.append(case("16-bit full-range costes", 16, fa, fb, W, H, mode="costes"))
    cases.append(case("16-bit full-range manual on-threshold", 16, fa, fb, W, H, mode="manual", t1=float(fa[5]), t2=float(fb[5])))
    # exactly proportional data: the regression is b = 2a and pixels lie ON their own thresholds
    pa = np.floor(rng.random(W * H) * 100)
    cases.append(case("8-bit proportional costes", 8, pa, pa * 2, W, H, mode="costes"))
    a, b = make(32, W, H)
    cases.append(case("32-bit none", 32, a, b, W, H))
    cases.append(case("32-bit costes", 32, a, b, W, H, mode="costes"))
    a2, b2 = a.copy(), b.copy()
    a2[3] = np.nan
    b2[10] = np.inf
    a2[20] = -np.inf
    cases.append(case("32-bit nan/inf manual", 32, a2, b2, W, H, mode="manual", t1=0.3, t2=0.2))
    cases.append(case("32-bit negative values", 32, a - 0.4, b - 0.3, W, H, mode="manual", t1=0.0, t2=0.0))
    a3, b3 = make(32, W, H, anti=True)
    cases.append(case("32-bit anti costes (fails)", 32, a3, b3, W, H, mode="costes"))
    cases.append(case("32-bit roi costes", 32, a, b, W, H, mask=mask_box(W, H), mode="costes"))

    with tempfile.TemporaryDirectory() as tmp:
        drv = os.path.join(tmp, "driver.mjs")
        inp = os.path.join(tmp, "cases.json")
        outp = os.path.join(tmp, "out.json")
        with open(drv, "w", encoding="utf8") as f:
            f.write(DRIVER)
        with open(inp, "w", encoding="utf8") as f:
            json.dump(cases, f)
        run = subprocess.run([node, drv, DIR, inp, outp], capture_output=True, text=True, timeout=300)
        if run.returncode != 0:
            print(run.stdout + run.stderr)
            return 1
        with open(outp, encoding="utf8") as f:
            results = json.load(f)

    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    def close(x, y, tol, msg):
        if y is None:
            check(x is None, "%s: %r != None" % (msg, x))
        else:
            check(x is not None and abs(x - y) <= tol * max(1.0, abs(y)), "%s: %r != %r" % (msg, x, y))

    def pearson(x, y):
        if x.size < 2 or np.var(x) <= 0 or np.var(y) <= 0:
            return None
        return float(np.corrcoef(x, y)[0, 1])

    for c, got in zip(cases, results):
        nm = c["name"]
        p = c["params"]
        bits = c["bits"]
        dt = np.float64
        a = np.array([np.nan if v == "nan" else np.inf if v == "inf" else v for v in c["a"]], dtype=dt)
        b = np.array([np.nan if v == "nan" else np.inf if v == "inf" else v for v in c["b"]], dtype=dt)
        if bits == 32:
            a = a.astype(np.float32).astype(dt)
            b = b.astype(np.float32).astype(dt)
        w, h = c["w"], c["h"]
        sel = np.ones(w * h, dtype=bool)
        if c["mask"]:
            m = c["mask"]
            sel[:] = False
            md = np.array(m["data"], dtype=np.uint8).reshape(m["h"], m["w"]) != 0
            full = np.zeros((h, w), dtype=bool)
            full[m["y"]:m["y"] + m["h"], m["x"]:m["x"] + m["w"]] = md
            sel = full.ravel()
        if bits == 32:
            sel &= np.isfinite(a) & np.isfinite(b)
        if p["excludeZero"]:
            sel &= ~((a == 0) & (b == 0))
        x, y = a[sel], b[sel]
        n = x.size
        check(got["n"] == n, "%s: n %r != %r" % (nm, got["n"], n))
        mx, my = x.mean(), y.mean()
        close(got["mean1"], mx, 1e-12, nm + " mean1")
        close(got["mean2"], my, 1e-12, nm + " mean2")
        close(got["pearsonAll"], pearson(x, y), 1e-9, nm + " pearsonAll")
        if x.min() >= 0 and y.min() >= 0:
            close(got["m1"], float(x[y > 0].sum() / x.sum()), 1e-9, nm + " m1")
            close(got["m2"], float(y[x > 0].sum() / y.sum()), 1e-9, nm + " m2")
            close(got["overlap"], float((x * y).sum() / np.sqrt((x * x).sum() * (y * y).sum())), 1e-9, nm + " overlap")
        pdm = (x - mx) * (y - my)
        has_var = x.var() > 0 and y.var() > 0
        # Li 2004: N(PDM > 0) / N(total) - 0.5, zero products stay in the total
        close(got["icq"], (float((pdm > 0).sum()) / n - 0.5) if has_var else None, 1e-12, nm + " icq")

        # the orthogonal (Deming, delta = 1) regression: first principal axis of the covariance matrix
        cov = np.cov(np.vstack([x, y]), bias=True)
        slope = intercept = None
        if cov[0, 1] > 0:
            vals, vecs = np.linalg.eigh(cov)
            v = vecs[:, 1]
            slope = float(v[1] / v[0])
            intercept = float(my - slope * mx)

        incl = p["mode"] != "none"  # manual / Costes: >= like ImageJ's thresholds; none: strictly above zero

        def above_of(t1, t2):
            return ((x >= t1) & (y >= t2)) if incl else ((x > t1) & (y > t2))

        def below_r(t1, t2):
            ab = above_of(t1, t2)
            return pearson(x[~ab], y[~ab])

        # Manders and the overlap need non-negative intensities
        neg = bool(x.min() < 0 or y.min() < 0)
        check(got["negative"] == neg, "%s: negative flag" % nm)
        if neg:
            for k in ("m1", "m2", "tm1", "tm2", "overlap"):
                check(got[k] is None, "%s: %s is null with negative values" % (nm, k))

        t1, t2, status = 0.0, 0.0, None
        if p["mode"] == "manual":
            t1, t2 = float(p["t1"]), float(p["t2"])
        elif p["mode"] == "costes":
            status = "failed"
            if slope is not None:
                # the module's own slope / intercept (checked against eigh below to 1e-9): the scan then compares the
                # very same doubles, so a pixel lying on a threshold is classified identically
                ms, cs = got["slope"], got["intercept"]
                is_int = bits != 32
                hi = float(x.max())
                lo = 0.0 if is_int else float(x.min())
                if is_int and hi > lo:
                    # CLASSICAL SCAN: every integer level from the maximum down, the first where r(below) <= 0
                    t1 = None
                    for t in range(int(hi), -1, -1):
                        r = below_r(t, ms * t + cs)
                        if not ((r if r is not None else 0.0) > 0):
                            t1 = float(t)
                            break
                    if t1 is None:
                        t1 = 0.0
                    else:
                        status = "ok"
                        t2 = ms * t1 + cs
                elif (not is_int) and hi > lo and got["costes"] == "ok":
                    # 32-bit: T1 is a level of a 2^-32 ladder. From outside: g(T1) holds, g(T1 + one fine step) does
                    # not, and every statistic downstream is exact once (T1, T2) is given
                    status = "ok"
                    t1, t2 = got["t1"], got["t2"]
                    g = lambda t: not ((below_r(t, ms * t + cs) or 0.0) > 0)
                    check(g(t1), nm + ": g(T1) holds")
                    step = (hi - lo) * 2.0 ** -32
                    check(not g(t1 + step * 1.001), nm + ": g(T1 + fine step) does not hold")
                    check(t2 == ms * t1 + cs, nm + ": T2 on the line")
        check(got["costes"] == status, "%s: costes status %r != %r" % (nm, got["costes"], status))
        if status == "failed":
            for k in ("t1", "t2", "nAbove", "nBelow", "pearsonAbove", "pearsonBelow", "tm1", "tm2"):
                check(got[k] is None, "%s: %s is null after a failed search" % (nm, k))
        else:
            close(got["t1"], t1, 1e-12, nm + " t1")
            close(got["t2"], t2, 1e-9, nm + " t2")
            above = above_of(t1, t2)
            check(got["nAbove"] == int(above.sum()), "%s: nAbove %r != %r" % (nm, got["nAbove"], int(above.sum())))
            check(got["nBelow"] == int((~above).sum()), nm + " nBelow")
            close(got["pearsonAbove"], pearson(x[above], y[above]), 1e-9, nm + " pearsonAbove")
            close(got["pearsonBelow"], pearson(x[~above], y[~above]), 1e-9, nm + " pearsonBelow")
            gx = (x >= t1) if incl else (x > t1)
            gy = (y >= t2) if incl else (y > t2)
            d1 = x[gx].sum() if p["denominator"] == "above" else x.sum()
            d2 = y[gy].sum() if p["denominator"] == "above" else y.sum()
            close(got["tm1"], None if neg else (float(x[above].sum() / d1) if d1 > 0 else None), 1e-9, nm + " tm1")
            close(got["tm2"], None if neg else (float(y[above].sum() / d2) if d2 > 0 else None), 1e-9, nm + " tm2")
        if slope is not None:
            close(got["slope"], slope, 1e-9, nm + " slope")
            close(got["intercept"], intercept, 1e-9, nm + " intercept")

        # the 2D histogram: row = channel 2 bin, column = channel 1 bin
        BINS = 256
        if bits == 8:
            ax, bx = (-0.5, 255.5), (-0.5, 255.5)
        elif bits == 16:
            ax, bx = (float(x.min()) - 0.5, float(x.max()) + 0.5), (float(y.min()) - 0.5, float(y.max()) + 0.5)
        else:
            ax = (float(x.min()), float(x.max()) if x.max() > x.min() else float(x.min()) + 1)
            bx = (float(y.min()), float(y.max()) if y.max() > y.min() else float(y.min()) + 1)
        xb = np.clip(np.floor((x - ax[0]) / ((ax[1] - ax[0]) / BINS)), 0, BINS - 1).astype(int)
        yb = np.clip(np.floor((y - bx[0]) / ((bx[1] - bx[0]) / BINS)), 0, BINS - 1).astype(int)
        hist = np.zeros(BINS * BINS, dtype=np.int64)
        np.add.at(hist, yb * BINS + xb, 1)
        check(np.array_equal(np.array(got["hist"], dtype=np.int64), hist), nm + ": 2D histogram")
        close(got["xRange"][0], ax[0], 1e-12, nm + " xRange0")
        close(got["yRange"][1], bx[1], 1e-12, nm + " yRange1")

    if failures:
        print("FAIL: ij coloc numpy cross-check")
        for f in failures[:40]:
            print("  " + f)
        return 1
    print("ij coloc numpy: OK (%d cases)" % len(cases))
    return 0


if __name__ == "__main__":
    sys.exit(main())
