"""Synthetic Imaris (.ims) files for the preprocessing tests.

The layout is the one the pipeline reads: DataSetInfo/Image carries the size and the
extent as Imaris writes attributes (arrays of single bytes), DataSetInfo/Channel i the
names, and DataSet/ResolutionLevel 0/TimePoint t/Channel c/Data the voxels — chunked
and padded beyond the declared size, as Imaris pads to whole chunks.
"""
from pathlib import Path

import numpy as np


def _attr(text) -> np.ndarray:
    return np.array([bytes([b]) for b in str(text).encode("utf-8")], dtype="S1")


def synthetic_volume(shape, seed: int = 0, dtype=np.uint16) -> np.ndarray:
    """A camera-noise background with bright blobs, thin filaments and isolated hot
    pixels — every case the signal mask and the median filter treat differently."""
    D, H, W = shape
    rng = np.random.default_rng(seed)
    vol = rng.normal(200.0, 12.0, size=shape)
    zz, yy, xx = np.meshgrid(np.arange(D), np.arange(H), np.arange(W), indexing="ij")
    for _ in range(6):
        cz, cy, cx = rng.uniform(0, D), rng.uniform(0, H), rng.uniform(0, W)
        r = rng.uniform(2.0, max(3.0, min(shape) / 3))
        vol += rng.uniform(300, 3000) * np.exp(-((zz - cz) ** 2 + (yy - cy) ** 2 + (xx - cx) ** 2) / (2 * r * r))
    y_line = int(rng.integers(0, H))
    vol[:, y_line, :] += 800.0                       # a one-voxel filament
    hot = rng.integers(0, D * H * W, size=max(1, D * H * W // 2000))
    vol.reshape(-1)[hot] += 4000.0                   # isolated hot pixels
    info = np.iinfo(dtype)
    return np.clip(vol, info.min, info.max).astype(dtype)


def write_ims(path, volumes, extent=((0.0, 0.0, 0.0), (10.0, 20.0, 30.0)), unit="um",
              channel_names=None, pad=(3, 5, 7), chunks=(4, 16, 16), with_extent=True):
    """volumes: list over timepoints of lists over channels of (D, H, W) arrays."""
    import h5py
    path = Path(path)
    D, H, W = volumes[0][0].shape
    with h5py.File(path, "w") as f:
        img = f.create_group("DataSetInfo/Image")
        img.attrs["X"] = _attr(W)
        img.attrs["Y"] = _attr(H)
        img.attrs["Z"] = _attr(D)
        img.attrs["Unit"] = _attr(unit)
        if with_extent:
            for axis in range(3):
                img.attrs[f"ExtMin{axis}"] = _attr(extent[0][axis])
                img.attrs[f"ExtMax{axis}"] = _attr(extent[1][axis])
        n_ch = len(volumes[0])
        for c in range(n_ch):
            ch = f.create_group(f"DataSetInfo/Channel {c}")
            name = (channel_names or [f"Dye {c}"] * n_ch)[c]
            ch.attrs["Name"] = _attr(name)
        for t, chans in enumerate(volumes):
            for c, vol in enumerate(chans):
                padded = np.zeros((D + pad[0], H + pad[1], W + pad[2]), dtype=vol.dtype)
                padded[:D, :H, :W] = vol
                group = f.create_group(f"DataSet/ResolutionLevel 0/TimePoint {t}/Channel {c}")
                group.attrs["ImageSizeX"] = _attr(W)
                group.attrs["ImageSizeY"] = _attr(H)
                group.attrs["ImageSizeZ"] = _attr(D)
                group.create_dataset("Data", data=padded,
                                     chunks=tuple(min(a, b) for a, b in zip(chunks, padded.shape)),
                                     compression="gzip")
    return path
