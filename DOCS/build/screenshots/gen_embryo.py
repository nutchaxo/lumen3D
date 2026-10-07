"""Synthetic mouse-embryo-like confocal stack written as an Imaris .ims (for doc screenshots)."""
import sys
from pathlib import Path
import numpy as np
from scipy import ndimage as ndi
import h5py


def attr(v):
    return np.frombuffer(str(v).encode("ascii"), dtype="S1")


def smooth01(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def make(name, out_dir, W, H, D, vox, seed, channels=("DAPI", "Pecam1", "Sox2"), ang0=-215, ang1=55):
    rng = np.random.default_rng(seed)
    vx, vy, vz = vox
    Wu, Hu, Du = W * vx, H * vy, D * vz
    L = min(Wu, Hu)
    cx, cy, zc = Wu * 0.5, Hu * 0.52, Du * 0.5
    # centreline: a curling C
    N = 260
    u = np.linspace(0, 1, N)
    th = np.deg2rad(ang0 + (ang1 - ang0) * u)
    Rc = L * (0.30 - 0.06 * u ** 2)
    px, py = cx + Rc * np.cos(th), cy + Rc * np.sin(th)
    tx, ty = np.gradient(px), np.gradient(py)
    tn = np.hypot(tx, ty)
    tx, ty = tx / tn, ty / tn
    nx, ny = ty, -tx  # outward normal (dorsal side)
    rad = L * (0.045 + 0.12 * u ** 1.3 + 0.10 * smooth01((u - 0.82) / 0.18))
    zrad = np.minimum(rad * 0.95, Du * 0.46)

    best = np.full((D, H, W), 9.0, np.float32)
    tt = np.zeros((D, H, W), np.float32)
    ss = np.zeros((D, H, W), np.float32)
    zz = np.zeros((D, H, W), np.float32)
    for i in range(N):
        r = rad[i] * 1.25
        x0, x1 = max(0, int((px[i] - r) / vx)), min(W, int((px[i] + r) / vx) + 1)
        y0, y1 = max(0, int((py[i] - r) / vy)), min(H, int((py[i] + r) / vy) + 1)
        if x1 <= x0 or y1 <= y0:
            continue
        Y, X = np.mgrid[y0:y1, x0:x1].astype(np.float32)
        X = X * vx - px[i]
        Y = Y * vy - py[i]
        Z = (np.arange(D, dtype=np.float32) * vz - zc)[:, None, None]
        along = X * tx[i] + Y * ty[i]
        side = (X * nx[i] + Y * ny[i]) / rad[i]
        zn = Z / zrad[i]
        dn = np.sqrt((along / rad[i]) ** 2 + side ** 2 + zn ** 2).astype(np.float32)
        sub = best[:, y0:y1, x0:x1]
        m = dn < sub
        sub[m] = dn[m]
        tt[:, y0:y1, x0:x1][m] = u[i]
        ss[:, y0:y1, x0:x1][m] = np.broadcast_to(side, dn.shape)[m]
        zz[:, y0:y1, x0:x1][m] = np.broadcast_to(zn, dn.shape)[m]
    tissue = smooth01((1.0 - best) / 0.08)
    print(name, "tissue frac", float((tissue > 0.5).mean()))

    pts = (rng.random((D, H, W), dtype=np.float32) < 0.006).astype(np.float32)
    nuc = ndi.gaussian_filter(pts, sigma=(0.7, 1.5, 1.5))
    nuc /= np.percentile(nuc[tissue > 0.5], 99.5) + 1e-6
    nuc = np.clip(nuc, 0, 1.4)

    # somites: paired blocks either side of the neural tube along the trunk
    ph = (tt * 22) % 1.0
    som = np.exp(-0.5 * ((ph - 0.5) / 0.18) ** 2) * np.exp(-0.5 * ((ss - 0.35) / 0.18) ** 2) \
        * np.exp(-0.5 * ((np.abs(zz) - 0.5) / 0.2) ** 2) * (tt < 0.78) * (tt > 0.08)
    dapi = tissue * (0.18 + 1.2 * nuc) * (0.8 + 0.9 * som)

    # neural tube (dorsal), brain vesicles at the head end
    nt = np.sqrt(((ss - 0.62) / 0.24) ** 2 + (zz / 0.26) ** 2)
    ntw = np.exp(-0.5 * ((nt - 0.75) / 0.25) ** 2) * (tt < 0.84)
    brain = np.sqrt(((ss - 0.15) / 0.62) ** 2 + (zz / 0.62) ** 2)
    brw = np.exp(-0.5 * ((brain - 0.8) / 0.13) ** 2) * smooth01((tt - 0.80) / 0.06)
    sox2 = (ntw + brw) * tissue * (0.25 + 1.4 * nuc)
    lumen = (nt < 0.45) * (tt < 0.84) + (brain < 0.62) * (tt > 0.84)
    dapi *= 1 - 0.85 * np.clip(lumen, 0, 1)

    # vessels
    ves = np.zeros_like(dapi)
    for zo in (-0.3, 0.3):
        d = np.sqrt(((ss - 0.05) * rad_like(tt, rad, u)) ** 2 + ((zz - zo) * 30) ** 2)
        ves += np.exp(-0.5 * (d / 3.2) ** 2) * (tt < 0.86) * (tt > 0.03)
        isv = np.exp(-0.5 * ((ph - 0.0) / 0.03) ** 2) + np.exp(-0.5 * ((ph - 1.0) / 0.03) ** 2)
        ves += isv * np.exp(-0.5 * ((zz - zo) / 0.07) ** 2) * (ss > 0.0) * (ss < 0.6) * (tt < 0.78) * 0.9
    ves *= smooth01(tissue * 1.5)
    n1 = ndi.gaussian_filter(rng.standard_normal((D, H, W)).astype(np.float32), sigma=(1.2, 3.5, 3.5))
    n1 /= n1.std()
    n2 = ndi.gaussian_filter(rng.standard_normal((D, H, W)).astype(np.float32), sigma=(4, 20, 20))
    n2 /= n2.std()
    plexus = np.exp(-0.5 * (n1 / 0.10) ** 2) * smooth01(n2 + 0.3) * (best < 0.95) * (best > 0.55)
    ves += plexus * (0.30 + 0.25 * (tt > 0.8))
    # heart: ventral, under the head
    hi = int(N * 0.74)
    hx, hy = px[hi] - nx[hi] * rad[hi] * 1.15, py[hi] - ny[hi] * rad[hi] * 1.15
    Zg, Yg, Xg = np.mgrid[0:D, 0:H, 0:W].astype(np.float32)
    hr = rad[hi] * 0.75
    hd = np.sqrt(((Xg * vx - hx) / hr) ** 2 + ((Yg * vy - hy) / (hr * 0.8)) ** 2 + ((Zg * vz - zc) / min(hr, Du * 0.35)) ** 2)
    ves += np.exp(-0.5 * ((hd - 0.62) / 0.035) ** 2) * 0.55
    heart_t = smooth01((1.0 - hd) / 0.1)
    dapi = np.maximum(dapi, heart_t * (0.2 + 1.1 * nuc) * (1 - 0.7 * (hd < 0.6)))
    del Zg, Yg, Xg

    att = np.exp(-(np.arange(D, dtype=np.float32) / D) * 0.7)[:, None, None]
    outs = []
    for arr, bg in ((dapi, 0.05), (ves, 0.035), (sox2, 0.04)):
        a = arr * att
        a = a + rng.normal(bg, bg * 0.4, size=a.shape).astype(np.float32)
        a = np.clip(a, 0, None)
        a = a / np.percentile(a, 99.97) * 40000 + 600
        outs.append(np.clip(a, 0, 65535).astype(np.uint16))
    outs = outs[: len(channels)]

    path = Path(out_dir) / f"{name}.ims"
    path.parent.mkdir(parents=True, exist_ok=True)
    with h5py.File(path, "w") as f:
        info = f.create_group("DataSetInfo")
        img = info.create_group("Image")
        for k, v in (("X", W), ("Y", H), ("Z", D), ("ExtMin0", "0.000"), ("ExtMin1", "0.000"),
                     ("ExtMin2", "0.000"), ("ExtMax0", f"{Wu:.3f}"), ("ExtMax1", f"{Hu:.3f}"),
                     ("ExtMax2", f"{Du:.3f}"), ("Unit", "um"), ("Name", name)):
            img.attrs[k] = attr(v)
        for i, cn in enumerate(channels):
            g = info.create_group(f"Channel {i}")
            g.attrs["Name"] = attr(cn)
        ti = info.create_group("TimeInfo")
        ti.attrs["DatasetTimePoints"] = attr(1)
        ti.attrs["FileTimePoints"] = attr(1)
        ti.attrs["TimePoint1"] = attr("2026-03-11 10:00:00.000")
        tp = f.create_group("DataSet/ResolutionLevel 0/TimePoint 0")
        for i, a in enumerate(outs):
            tp.create_group(f"Channel {i}").create_dataset("Data", data=a, chunks=(16, 64, 64),
                                                          compression="gzip", compression_opts=1)
    print("wrote", path)
    return outs


def rad_like(tt, rad, u):
    return np.interp(tt, u, rad).astype(np.float32)


def preview(outs, path):
    from PIL import Image
    cs = [o.max(0).astype(np.float32) for o in outs]
    cs = [np.clip((c - np.percentile(c, 30)) / (np.percentile(c, 99.8) - np.percentile(c, 30)), 0, 1) for c in cs]
    while len(cs) < 3:
        cs.append(np.zeros_like(cs[0]))
    rgb = np.stack([cs[2] * 0.9 + cs[1] * 0.1, cs[1], cs[0] * 0.9 + cs[2] * 0.3], -1)
    Image.fromarray((np.clip(rgb, 0, 1) * 255).astype("uint8")).save(path)


if __name__ == "__main__":
    out = sys.argv[1]
    which = sys.argv[2] if len(sys.argv) > 2 else "all"
    specs = {
        "a": ("Embryo-E95-Em2-Pecam1-Sox2", 768, 576, 112, (1.2, 1.2, 3.0), 7, ("DAPI", "Pecam1", "Sox2"), -215, 55),
        "b": ("Embryo-E85-Em1-Pecam1-Sox2", 512, 400, 80, (1.2, 1.2, 3.0), 11, ("DAPI", "Pecam1", "Sox2"), -180, 40),
        "c": ("Embryo-E105-Em3-Pecam1", 640, 544, 96, (1.5, 1.5, 3.5), 23, ("DAPI", "Pecam1"), -235, 70),
    }
    for k, s in specs.items():
        if which != "all" and k not in which:
            continue
        o = make(s[0], out, *s[1:6], channels=s[6], ang0=s[7], ang1=s[8])
        preview(o, Path(out) / f"{s[0]}.png")
