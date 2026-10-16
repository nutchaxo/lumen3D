#!/usr/bin/env python3
"""Codec benchmark of the format-5 compression columns (DOCS/dataset-migrations/SPEC.md Part III).

Reads native (LOD0, lossless) bricks of published datasets, cuts them into the 66³
bricks of the v3 layout (64³ interior + 1-voxel clamp-to-edge apron), encodes each
brick with every candidate codec, decodes it back and compares the 64³ interior with
the source. Prints one table per dataset and writes the raw numbers as JSON.

Candidates
  webp-ll-m4      lossless WebP, method 4 / quality 75 (what format 4 stores)
  webp-ll-m6      lossless WebP, method 6 / quality 100 (only with --m6: ~2 s a brick
                  for ~2 % less)
  deflate9        zlib level 9 of the raw 64³ voxels (the browser inflates natively)
  qU1/qU2/qU4     uniform quantizer, |error| <= 1 / 2 / 4 grey levels, zero kept exact;
                  the brick stores bin INDICES (lossless WebP, method 4) and a 256-entry
                  LUT maps an index to its reconstruction value
  webp-qNN        lossy WebP at quality NN, slices on an 80-px pitch (66 px centred,
                  7 px of edge replication each side: a 16-px macroblock never holds
                  two slices and the deblocking filter, <= 3 px, never reaches data)
  avif-qNN        lossy AVIF 4:0:0 at quality NN, same 80-px layout
  Both lossy families carry a one-byte dead-zone threshold (see dead_zone).

The reported sigma(v) is the horizontal-neighbour-difference noise estimate,
sigma(m) = 1.4826·MAD(d)/sqrt(2) with d = v[x+1] − v[x] binned by their mean m. It is
reported, not used: on the published uint8 volumes (median-filtered and windowed by
2-image_processor.py) it measures structure, not shot noise (11–60 grey levels), so a
noise-bounded quantizer (B3D-style) would need the raw sensor counts.

Usage: python tools/bench_brick_codecs.py DATA_WEB/3d/<a> DATA_WEB/3d/<b> ... \
         [--crop 6] [--out results.json] [--dump DIR] [-j N]
"""
from __future__ import annotations

import argparse
import io
import json
import math
import sys
import time
import zlib
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import dataset_migrations as dm  # noqa: E402

BS = 64
SLICE = 66
COLS, ROWS = 9, 8
PITCH = 80
PAD = (PITCH - SLICE) // 2

# ── reading native bricks ────────────────────────────────────────────────────


def read_crop(ds: Path, channel: int, bx0: int, by0: int, n: int) -> np.ndarray:
    """(Z, n·64, n·64) uint8 of LOD0, bricks bx0..bx0+n−1 × by0..by0+n−1, every z."""
    man = json.loads((ds / "bricks" / "manifest.json").read_text(encoding="utf-8"))
    lv = man["levels"][0]
    dims, grid = lv["dimensions"], lv["gridSize"]
    b2p = man["brickTransport"]["brickToPack"]
    packing = man.get("brickPacking")
    out = np.zeros((grid["z"] * BS, n * BS, n * BS), dtype=np.uint8)
    handles = {}
    try:
        for bz in range(grid["z"]):
            for j in range(n):
                for i in range(n):
                    key = "lod0/c%d/x%03d_y%03d_z%03d.webp" % (channel, bx0 + i, by0 + j, bz)
                    e = b2p.get(key)
                    if not e:
                        continue
                    f = handles.get(e["url"])
                    if f is None:
                        f = handles[e["url"]] = open(ds / "bricks" / e["url"], "rb")
                    f.seek(e["offset"])
                    raw = f.read(e["length"])
                    vox = np.frombuffer(dm.decode_brick(raw, "webp-lossless", packing, BS),
                                        dtype=np.uint8).reshape(BS, BS, BS)
                    out[bz * BS:(bz + 1) * BS, j * BS:(j + 1) * BS, i * BS:(i + 1) * BS] = vox
    finally:
        for f in handles.values():
            f.close()
    return out[:dims["z"]]


def bricks66(crop: np.ndarray):
    """66³ bricks (clamp-to-edge apron) whose 64³ interior holds a voxel >= 1."""
    Z, H, W = crop.shape
    gz = -(-Z // BS)
    padded = np.pad(crop, ((1, gz * BS - Z + 1), (1, 1), (1, 1)), mode="edge")
    for bz in range(gz):
        for by in range(H // BS):
            for bx in range(W // BS):
                b = padded[bz * BS:bz * BS + SLICE, by * BS:by * BS + SLICE, bx * BS:bx * BS + SLICE]
                if b[1:-1, 1:-1, 1:-1].any():
                    yield np.ascontiguousarray(b)


# ── noise model and quantizers ───────────────────────────────────────────────


def noise_sigma(crop: np.ndarray) -> np.ndarray:
    """σ(v) for v = 0..255 (see module doc)."""
    a = crop[:, :, :-1].astype(np.int16)
    b = crop[:, :, 1:].astype(np.int16)
    keep = (a > 0) & (b > 0)
    d = (b - a)[keep].astype(np.float64)
    m = ((a + b) // 2)[keep]
    sig = np.full(256, np.nan)
    for v0 in range(1, 256, 4):
        sel = (m >= v0) & (m < v0 + 4)
        if sel.sum() >= 200:
            dd = d[sel]
            sig[v0:v0 + 4] = 1.4826 * np.median(np.abs(dd - np.median(dd))) / math.sqrt(2)
    if np.all(np.isnan(sig)):
        return np.ones(256)
    idx = np.arange(256)
    ok = ~np.isnan(sig)
    sig = np.interp(idx, idx[ok], sig[ok])
    sig = np.maximum.accumulate(np.maximum(sig, 0.5))
    sig[0] = 0.0
    return sig


def quantizer(half_width) -> tuple[np.ndarray, np.ndarray]:
    """(index_of[v], value_of[index]) of a quantizer whose bin starting at s spans
    2·e(s)+1 values (e(s) = half_width(s), an int >= 0), zero alone in bin 0, each bin
    reconstructed at its centre (clipped to its last value at 255)."""
    index_of = np.zeros(256, dtype=np.uint8)
    value_of = np.zeros(256, dtype=np.uint8)
    s, k = 1, 1
    while s <= 255:
        e = int(half_width(s))
        w = 2 * e + 1
        hi = min(255, s + w - 1)
        index_of[s:hi + 1] = k
        value_of[k] = min(hi, s + e)
        s, k = hi + 1, k + 1
    return index_of, value_of


# ── mosaics ──────────────────────────────────────────────────────────────────


def mosaic(b66: np.ndarray) -> np.ndarray:
    return np.frombuffer(dm.mosaic_9x8(b66), dtype=np.uint8).reshape(dm.V3_MOSAIC_H, dm.V3_MOSAIC_W)


def unmosaic(m: np.ndarray) -> np.ndarray:
    return dm.unmosaic_9x8(np.ascontiguousarray(m))


def mosaic80(b66: np.ndarray) -> np.ndarray:
    slots = np.zeros((COLS * ROWS, PITCH, PITCH), dtype=np.uint8)
    slots[:SLICE] = np.pad(b66, ((0, 0), (PAD, PAD), (PAD, PAD)), mode="edge")
    return slots.reshape(ROWS, COLS, PITCH, PITCH).transpose(0, 2, 1, 3).reshape(ROWS * PITCH, COLS * PITCH)


def unmosaic80(m: np.ndarray) -> np.ndarray:
    slots = m.reshape(ROWS, PITCH, COLS, PITCH).transpose(0, 2, 1, 3).reshape(COLS * ROWS, PITCH, PITCH)
    return np.ascontiguousarray(slots[:SLICE, PAD:PAD + SLICE, PAD:PAD + SLICE])


def _save(img: np.ndarray, fmt: str, **kw) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(img, mode="L").save(buf, format=fmt, **kw)
    return buf.getvalue()


def _load(data: bytes) -> np.ndarray:
    with Image.open(io.BytesIO(data)) as im:
        im.load()
        band = im if im.mode == "L" else im.convert("RGB").getchannel(0)
        return np.asarray(band, dtype=np.uint8)


# ── codecs: brick66 -> (bytes, decoded66) ────────────────────────────────────


def dead_zone(src66: np.ndarray, data: bytes, dec66: np.ndarray, top: int = 12):
    """A lossy codec smears the zero background into small values. The encoder knows
    the source, so it picks the threshold tau in 0..top that minimises the squared error
    of the 64³ interior once every decoded value <= tau is set to 0, and stores tau as one
    byte (the decoder folds it into the LUT it already applies)."""
    s = src66[1:-1, 1:-1, 1:-1].astype(np.int32)
    d = dec66[1:-1, 1:-1, 1:-1].astype(np.int32)
    best, best_sse = 0, None
    for tau in range(top + 1):
        e = np.where(d <= tau, 0, d) - s
        sse = int((e * e).sum())
        if best_sse is None or sse < best_sse:
            best, best_sse = tau, sse
    out = dec66.copy()
    out[out <= best] = 0
    return data + bytes([best]), out


def make_codecs(with_m6: bool = False):
    codecs = {}

    def webp_ll(method, quality):
        def enc(b):
            data = _save(mosaic(b), "WEBP", lossless=True, method=method, quality=quality)
            return data, unmosaic(_load(data))
        return enc

    codecs["webp-ll-m4"] = webp_ll(4, 75)
    if with_m6:
        codecs["webp-ll-m6"] = webp_ll(6, 100)

    def deflate(b):
        data = zlib.compress(np.ascontiguousarray(b[1:-1, 1:-1, 1:-1]).tobytes(), 9)
        out = b.copy()
        out[1:-1, 1:-1, 1:-1] = np.frombuffer(zlib.decompress(data), dtype=np.uint8).reshape(BS, BS, BS)
        return data, out

    codecs["deflate9"] = deflate

    def quantized(index_of, value_of):
        def enc(b):
            idx = index_of[b]
            data = _save(mosaic(idx), "WEBP", lossless=True, method=4, quality=75)
            return data + value_of.tobytes(), value_of[unmosaic(_load(data))]
        return enc

    for e in (1, 2, 4):
        codecs["qU%d" % e] = quantized(*quantizer(lambda s, e=e: e))

    def webp_lossy(q):
        def enc(b):
            data = _save(mosaic80(b), "WEBP", quality=q, method=6)
            return dead_zone(b, data, unmosaic80(_load(data)))
        return enc

    for q in (95, 90, 80, 70, 50):
        codecs["webp-q%d" % q] = webp_lossy(q)

    def avif(q):
        def enc(b):
            data = _save(mosaic80(b), "AVIF", quality=q, subsampling="4:0:0", speed=6)
            return dead_zone(b, data, unmosaic80(_load(data)))
        return enc

    for q in (90, 80, 70, 50):
        codecs["avif-q%d" % q] = avif(q)
    return codecs


# ── one task: a crop of one channel ──────────────────────────────────────────


def otsu(values: np.ndarray) -> int:
    hist = np.bincount(values.ravel(), minlength=256).astype(np.float64)
    hist[0] = 0
    total = hist.sum()
    if total == 0:
        return 1
    w = np.cumsum(hist)
    mu = np.cumsum(hist * np.arange(256))
    with np.errstate(divide="ignore", invalid="ignore"):
        between = (mu[-1] * w / total - mu) ** 2 / (w * (total - w))
    return int(np.nanargmax(between[1:255]) + 1)


def run_task(task):
    ds, channel, bx0, by0, n, dump, with_m6 = task
    crop = read_crop(Path(ds), channel, bx0, by0, n)
    sigma = noise_sigma(crop)
    thr = otsu(crop)
    codecs = make_codecs(with_m6)
    stats = {name: {"bytes": 0, "sec": 0.0, "sse": 0.0, "sse_fg": 0.0, "n": 0, "n_fg": 0,
                    "maxerr": 0, "abs_fg": 0.0, "zero_to_nz": 0, "nz_to_zero": 0,
                    "tp": 0, "fp": 0, "fn": 0, "sum_src": 0, "sum_rec": 0} for name in codecs}
    nb = 0
    dumped = 0
    for b in bricks66(crop):
        nb += 1
        src = b[1:-1, 1:-1, 1:-1].astype(np.int32)
        fg = src > 0
        for name, enc in codecs.items():
            t0 = time.perf_counter()
            data, dec = enc(b)
            st = stats[name]
            st["sec"] += time.perf_counter() - t0
            rec = dec[1:-1, 1:-1, 1:-1].astype(np.int32)
            err = rec - src
            st["bytes"] += len(data)
            st["sse"] += float((err * err).sum())
            st["n"] += err.size
            fgu = fg | (rec > 0)
            st["sse_fg"] += float((err[fgu] ** 2).sum())
            st["abs_fg"] += float(np.abs(err[fgu]).sum())
            st["n_fg"] += int(fgu.sum())
            st["maxerr"] = max(st["maxerr"], int(np.abs(err).max()))
            st["zero_to_nz"] += int(((src == 0) & (rec != 0)).sum())
            st["nz_to_zero"] += int(((src != 0) & (rec == 0)).sum())
            a, r = src >= thr, rec >= thr
            st["tp"] += int((a & r).sum())
            st["fp"] += int((~a & r).sum())
            st["fn"] += int((a & ~r).sum())
            st["sum_src"] += int(src.sum())
            st["sum_rec"] += int(rec.sum())
            if dump and dumped < 24 and not name.startswith("deflate"):
                ext = ".avif" if name.startswith("avif") else ".webp"
                d = Path(dump) / name
                d.mkdir(parents=True, exist_ok=True)
                payload = data[:-256] if name.startswith("q") else (data[:-1] if name.startswith(("webp-q", "avif")) else data)
                (d / ("b%02d%s" % (dumped, ext))).write_bytes(payload)
        if dump and dumped < 24:
            dumped += 1
    return {"dataset": Path(ds).name, "channel": channel, "crop": [bx0, by0, n], "bricks": nb,
            "otsu": thr, "sigma": [round(float(s), 3) for s in sigma[[16, 32, 64, 128, 200]]],
            "stats": stats}


def plan_tasks(datasets, n, dump, with_m6=False):
    tasks = []
    for k, ds in enumerate(datasets):
        man = json.loads((Path(ds) / "bricks" / "manifest.json").read_text(encoding="utf-8"))
        g = man["levels"][0]["gridSize"]
        channels = int(man["channels"])
        crops = [((g["x"] - n) // 2, (g["y"] - n) // 2), ((g["x"] - n) // 4, (g["y"] - n) // 4)]
        for c in range(channels):
            for ci, (bx0, by0) in enumerate(crops):
                tasks.append((str(ds), c, bx0, by0, n, dump if (k == 0 and c == 0 and ci == 0) else None, with_m6))
    return tasks


def merge(results):
    """Per dataset: codec -> summed stats."""
    out = {}
    for r in results:
        agg = out.setdefault(r["dataset"], {"bricks": 0, "codecs": {}})
        agg["bricks"] += r["bricks"]
        for name, st in r["stats"].items():
            a = agg["codecs"].setdefault(name, {k: 0 for k in st})
            for k, v in st.items():
                a[k] = max(a[k], v) if k == "maxerr" else a[k] + v
    return out


def report(merged):
    lines = []
    for ds, agg in merged.items():
        base = agg["codecs"]["webp-ll-m4"]["bytes"] or 1
        lines.append("\n## %s (%d bricks)\n" % (ds, agg["bricks"]))
        lines.append("| codec | MB | vs format 4 | max err | PSNR fg dB | mean abs fg | Dice@Otsu | Σ intensity | 0→≠0 | ms/brick enc |")
        lines.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
        for name, st in agg["codecs"].items():
            mse = st["sse_fg"] / max(1, st["n_fg"])
            psnr = float("inf") if mse == 0 else 10 * math.log10(255 * 255 / mse)
            dice = 2 * st["tp"] / max(1, 2 * st["tp"] + st["fp"] + st["fn"])
            drift = (st["sum_rec"] - st["sum_src"]) / max(1, st["sum_src"]) * 100
            lines.append("| %s | %.1f | %.3f | %d | %s | %.2f | %.4f | %+.2f %% | %.2e | %.0f |" % (
                name, st["bytes"] / 1e6, st["bytes"] / base, st["maxerr"],
                "∞" if psnr == float("inf") else "%.1f" % psnr, st["abs_fg"] / max(1, st["n_fg"]),
                dice, drift, st["zero_to_nz"] / max(1, st["n"]), st["sec"] / max(1, agg["bricks"]) * 1000))
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("datasets", nargs="+")
    ap.add_argument("--crop", type=int, default=6, help="crop side in bricks (default 6)")
    ap.add_argument("--out", default=None, help="JSON of every per-task number")
    ap.add_argument("--dump", default=None, help="write 24 bricks per codec of the first crop here")
    ap.add_argument("--m6", action="store_true", help="also test lossless WebP method 6")
    ap.add_argument("-j", type=int, default=8)
    a = ap.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    tasks = plan_tasks(a.datasets, a.crop, a.dump, a.m6)
    with ProcessPoolExecutor(max_workers=a.j) as ex:
        results = list(ex.map(run_task, tasks))
    merged = merge(results)
    if a.out:
        Path(a.out).write_text(json.dumps({"tasks": results, "merged": merged}, indent=1), encoding="utf-8")
    print(report(merged))
    for r in results:
        print("%s c%d crop %s: %d bricks, otsu %d, sigma@16/32/64/128/200 = %s" % (
            r["dataset"][:40], r["channel"], r["crop"], r["bricks"], r["otsu"], r["sigma"]))


if __name__ == "__main__":
    main()
