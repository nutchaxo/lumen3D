"""Synthetic TIFF files for the api/tiff-index tests (pure Python bytes, no numpy / tifffile).

Used by tests/test_tiff_index.py (the Python twin) and, through `python tests/tiff_index_fixtures.py <dir>`,
by tests/test_tiff_index_php.php (the same files through the PHP twin).

`build(pages, ...)` lays a file out as ImageJ / tifffile do: each page's strips, then its IFD
(`interleaved=True`), or every strip first and every IFD at the end (`False`).
"""
import json
import struct
import sys
from pathlib import Path

SIZES = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 12: 8, 16: 8}
FMT = {1: "B", 3: "H", 4: "I", 7: "B", 16: "Q"}


def _pack_values(bo, typ, values):
    if typ == 2:
        return values if isinstance(values, bytes) else values.encode("utf-8")
    if typ == 5:
        out = b""
        for num, den in values:
            out += struct.pack(bo + "II", num, den)
        return out
    return struct.pack(bo + "%d%s" % (len(values), FMT[typ]), *values)


def ij_meta(bo, info=None, labels=(), ranges=(), colors=()):
    """(byte counts, bytes) of ImageJ's IJMetaData: info, labl, rang, luts blocks."""
    enc = "utf-16-le" if bo == "<" else "utf-16-be"
    blocks, header = [], []
    if info is not None:
        header.append((0x696E666F, 1))
        blocks.append(info.encode(enc))
    if labels:
        header.append((0x6C61626C, len(labels)))
        blocks += [s.encode(enc) for s in labels]
    if ranges:
        header.append((0x72616E67, 1))
        blocks.append(struct.pack(bo + "%dd" % len(ranges), *ranges))
    if colors:
        header.append((0x6C757473, len(colors)))
        for r, g, b in colors:
            blocks.append(bytes([min(255, int(r * i / 255)) for i in range(256)])
                          + bytes([min(255, int(g * i / 255)) for i in range(256)])
                          + bytes([min(255, int(b * i / 255)) for i in range(256)]))
    head = struct.pack(bo + "I", 0x494A494A)
    for typ, cnt in header:
        head += struct.pack(bo + "II", typ, cnt)
    return [len(head)] + [len(b) for b in blocks], head + b"".join(blocks)


def page(width=4, height=4, bits=8, compression=1, predictor=1, rows_per_strip=2, strips=None,
         spp=1, tiled=False, sample_format=None, planar=1, photometric=1):
    """One page: `strips` = payload bytes per strip (default: ceil(height / rows_per_strip) strips of 0x11…)."""
    n = -(-height // rows_per_strip)
    if strips is None:
        strips = [bytes([0x10 + i % 200]) * (width * rows_per_strip * (bits // 8) * spp) for i in range(n)]
    return {"width": width, "height": height, "bits": bits, "compression": compression, "predictor": predictor,
            "rps": rows_per_strip, "strips": strips, "spp": spp, "tiled": tiled, "sample_format": sample_format,
            "planar": planar, "photometric": photometric}


def build(pages, bo="<", big=False, interleaved=True, description=None, meta=None, resolution=(2.5, 2.5, 1),
          cycle=False):
    cap = 8 if big else 4
    esz = 20 if big else 12
    offfmt = bo + ("Q" if big else "I")
    buf = bytearray()
    if big:
        buf += (b"II" if bo == "<" else b"MM") + struct.pack(bo + "HHHQ", 43, 8, 0, 0)
    else:
        buf += (b"II" if bo == "<" else b"MM") + struct.pack(bo + "HI", 42, 0)
    ifd_ptrs = []          # position of each IFD's "next" field
    ifd_pos = []

    def put_ifd(i, pg, offs, counts):
        tags = []

        def tag(t, typ, values):
            tags.append((t, typ, values))

        tag(256, 4, [pg["width"]])
        tag(257, 4, [pg["height"]])
        tag(258, 3, [pg["bits"]] * pg["spp"])
        tag(259, 3, [pg["compression"]])
        tag(262, 3, [pg["photometric"]])
        if i == 0 and description is not None:
            tag(270, 2, description.encode("utf-8") + b"\x00")
        tag(324 if pg["tiled"] else 273, 16 if big else 4, offs)
        tag(277, 3, [pg["spp"]])
        if pg["tiled"]:
            tag(322, 4, [pg["width"]])
            tag(323, 4, [pg["rps"]])
        else:
            tag(278, 4, [pg["rps"]])
        tag(325 if pg["tiled"] else 279, 16 if big else 4, counts)
        if resolution and i == 0:
            tag(282, 5, [(int(resolution[0] * 1000), 1000)])
            tag(283, 5, [(int(resolution[1] * 1000), 1000)])
            tag(296, 3, [resolution[2]])
        if pg["planar"] != 1:
            tag(284, 3, [pg["planar"]])
        if pg["predictor"] != 1:
            tag(317, 3, [pg["predictor"]])
        if pg["sample_format"] is not None:
            tag(339, 3, [pg["sample_format"]] * pg["spp"])
        if i == 0 and meta is not None:
            tag(50838, 4, meta[0])
            tag(50839, 1, meta[1])
        tags.sort(key=lambda t: t[0])
        ifd_at = len(buf)
        head = (struct.pack(bo + "Q", len(tags)) if big else struct.pack(bo + "H", len(tags)))
        body_size = len(head) + esz * len(tags) + cap
        blob_at = ifd_at + body_size
        entries, blobs = b"", b""
        for t, typ, values in tags:
            raw = _pack_values(bo, typ, values)
            count = len(raw) if typ == 2 else len(values)
            if len(raw) <= cap:
                val = raw.ljust(cap, b"\x00")
            else:
                pos = blob_at + len(blobs)
                val = struct.pack(offfmt, pos)
                blobs += raw
                if len(blobs) % 2:
                    blobs += b"\x00"
            entries += struct.pack(bo + "HH", t, typ) + (struct.pack(bo + ("Q" if big else "I"), count)) + val
        buf.extend(head + entries + b"\x00" * cap + blobs)
        ifd_pos.append(ifd_at)
        ifd_ptrs.append(ifd_at + len(head) + esz * len(tags))

    placed_strips = []
    if not interleaved:
        for pg in pages:
            offs, counts = [], []
            for s in pg["strips"]:
                offs.append(len(buf))
                counts.append(len(s))
                buf.extend(s)
                if len(buf) % 2:
                    buf.extend(b"\x00")
            placed_strips.append((offs, counts))
        for i, pg in enumerate(pages):
            put_ifd(i, pg, *placed_strips[i])
    else:
        for i, pg in enumerate(pages):
            offs, counts = [], []
            for s in pg["strips"]:
                offs.append(len(buf))
                counts.append(len(s))
                buf.extend(s)
                if len(buf) % 2:
                    buf.extend(b"\x00")
            put_ifd(i, pg, offs, counts)
    struct.pack_into(offfmt, buf, 8 if big else 4, ifd_pos[0])
    for k in range(len(ifd_pos) - 1):
        struct.pack_into(offfmt, buf, ifd_ptrs[k], ifd_pos[k + 1])
    if cycle:
        struct.pack_into(offfmt, buf, ifd_ptrs[-1], ifd_pos[0])
    return bytes(buf)


IJ_DESC = "ImageJ=1.54f\nimages=6\nchannels=3\nslices=2\nframes=1\nhyperstack=true\nmode=composite\nunit=micron\nspacing=2.5\nloop=false\nmin=0.0\nmax=255.0\n"


def fixtures():
    """name → (bytes, expectation) for every fixture file; expectation = {'error': code} or {'pages': n, ...}."""
    out = {}
    imagej_meta = lambda bo: ij_meta(bo, info="Dataset: demo\nSource: Imaris .ims ResolutionLevel 1, native uint8\nµm", labels=["DAPI", "GFP", "RFP", "extra"],
                                    ranges=[0.0, 255.0, 5.0, 100.0, 0.0, 77.5], colors=[(255, 0, 0), (0, 255, 0), (0, 0, 255)])
    for bo, tag in (("<", "ii"), (">", "mm")):
        for big in (False, True):
            name = f"ij-{tag}{'-big' if big else ''}.tif"
            pages = [page(8, 8, 8, rows_per_strip=4) for _ in range(6)]
            out[name] = (build(pages, bo=bo, big=big, description=IJ_DESC, meta=imagej_meta(bo)),
                         {"pages": 6, "bigtiff": big, "littleEndian": bo == "<", "strips": 2, "ij": True})
    pages = [page(8, 8, 16, compression=8, predictor=2, rows_per_strip=2) for _ in range(3)]
    out["deflate-predictor.tif"] = (build(pages, description=None), {"pages": 3, "strips": 4, "compression": 8, "predictor": 2, "bits": 16})
    out["not-interleaved.tif"] = (build([page(8, 8, 8, rows_per_strip=4) for _ in range(4)], interleaved=False),
                                  {"pages": 4, "strips": 2})
    out["three-page-ijcomposite.tif"] = (build([page(16, 8, 8, rows_per_strip=8) for _ in range(3)], bo=">",
                                               description="ImageJ=1.11a\nimages=3\nchannels=3\nmode=composite\nunit=um\n",
                                               meta=ij_meta(">", info="info", labels=["A", "B", "C"], ranges=[0, 10, 0, 20, 0, 30],
                                                            colors=[(0, 255, 255), (255, 255, 0), (255, 0, 255)])),
                                         {"pages": 3, "strips": 1, "ij": True})
    out["non-uniform.tif"] = (build([page(8, 8, 8, rows_per_strip=4), page(8, 8, 16, rows_per_strip=2), page(4, 4, 8, rows_per_strip=4)]),
                              {"pages": 3, "uniform": False})
    out["tiled.tif"] = (build([page(8, 8, 8, rows_per_strip=8, strips=[b"\x01" * 64], tiled=True)]), {"pages": 1, "tiled": True})
    out["cycle.tif"] = (build([page(), page()], cycle=True), {"error": "malformed"})
    out["not-a-tiff.tif"] = (b"hello, this is not a tiff file at all", {"error": "not_tiff"})
    good = build([page(8, 8, 8, rows_per_strip=4) for _ in range(2)])
    out["truncated.tif"] = (good[:len(good) - 40], {"error": "malformed"})
    # one page declaring a million and one strips: refused from the tag's count, before any array is read.
    many = build([page(4, 4, 8, rows_per_strip=4)])
    out["too-many-strips.tif"] = (_with_strip_count(many, 1000001), {"error": "too_many_pages"})
    # Floats PHP writes with an exponent (`5.0e-5`, `1.0e+22`) and Unicode whitespace PHP's trim() keeps and
    # Python's str.strip() would drop: both twins must still answer the same bytes.
    nb, ls, nel = chr(0xA0), chr(0x1C), chr(0x85)
    desc = ("ImageJ=1.54f\nimages=2\nchannels=1\nslices=2\nunit=" + nb + "um" + nb + "\nmode=" + ls + "grayscale" + nel
            + "\nspacing=5e-05\nmin=1e-05\nmax=1e+22\n" + nb + "loop" + nb + "=false\n")
    out["ij-exponent.tif"] = (build([page(8, 8, 8, rows_per_strip=4) for _ in range(2)], description=desc,
                                    meta=ij_meta("<", info="x", ranges=[0.0, 1e-7, 3.5e20, 1e22, 1.5e16, 123456.789])),
                              {"pages": 2, "strips": 2, "ij": True})
    out["bigtiff-huge-meta-count.tif"] = (_with_meta_count(build([page(8, 8, 8, rows_per_strip=4) for _ in range(2)], big=True,
                                                                 description=IJ_DESC, meta=imagej_meta("<"))),
                                          {"pages": 2, "strips": 2, "bigtiff": True})
    return out


def _with_strip_count(data, n):
    """Rewrite the strip-offsets / byte-counts entries of a single-page classic LE file to declare n strips."""
    b = bytearray(data)
    ifd = struct.unpack_from("<I", b, 4)[0]
    count = struct.unpack_from("<H", b, ifd)[0]
    for i in range(count):
        at = ifd + 2 + 12 * i
        tag = struct.unpack_from("<H", b, at)[0]
        if tag in (273, 279):
            struct.pack_into("<I", b, at + 4, n)
            struct.pack_into("<I", b, at + 8, 8)       # a valid offset: the check comes before the read
    return bytes(b)


def _with_meta_count(data):
    """A BigTIFF whose ImageJ byte-count tag (50838) declares 2**63 + 5 values: an unsigned 64-bit count that
    PHP's unpack('P') reads negative. Both twins must ignore the tag."""
    b = bytearray(data)
    ifd = struct.unpack_from("<Q", b, 8)[0]
    count = struct.unpack_from("<Q", b, ifd)[0]
    for i in range(count):
        at = ifd + 8 + 20 * i
        if struct.unpack_from("<H", b, at)[0] == 50838:
            struct.pack_into("<Q", b, at + 4, (1 << 63) + 5)
    return bytes(b)


def write_all(directory):
    d = Path(directory)
    d.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for name, (data, expect) in fixtures().items():
        (d / name).write_bytes(data)
        manifest[name] = expect
    (d / "expect.json").write_text(json.dumps(manifest))
    return manifest


if __name__ == "__main__":
    write_all(sys.argv[1])
