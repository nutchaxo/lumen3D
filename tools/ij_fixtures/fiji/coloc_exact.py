#!/usr/bin/env python3
"""High-precision reference for Coloc 2 (tests/fixtures/ij-wave3/fiji/coloc2).

Fiji's Log prints Pearson with 2 decimals, Kendall with 4, Spearman with 8, Manders with 3: too coarse for the +-1e-9
tolerance of Spearman / Kendall. This script recomputes every deterministic number from the SAME input images
(`pairs.json` `inputs`) with numpy / scipy, using the thresholds Fiji chose (`parsed` "Ch1/Ch2 Max Threshold"), and writes
`pairs_exact.json` next to it. Each value also carries the Fiji Log value and `logDecimals` so a test can check the exact
number against the Log at the Log's own precision. Run after `FijiRefs coloc`:

    python tools/ij_fixtures/fiji/coloc_exact.py tests/fixtures/ij-wave3/fiji/coloc2
"""
import base64, json, sys
from pathlib import Path
import numpy as np
from scipy import stats


def decode(img):
    d = img["data"]
    if isinstance(d, list):
        a = np.array(d, dtype=np.float64)
    else:
        raw = base64.b64decode(d["b64"])
        a = np.frombuffer(raw, dtype={"u8": np.uint8, "u16": "<u2", "f32": "<f4"}[d["dtype"]]).astype(np.float64)
    return a  # row-major, length w*h


def pearson(x, y):
    if x.size < 2 or x.std() == 0 or y.std() == 0:
        return None
    return float(np.corrcoef(x, y)[0, 1])


def main(folder):
    folder = Path(folder)
    src = json.loads((folder / "pairs.json").read_text(encoding="utf-8"))
    imgs = {k: decode(v) for k, v in src["inputs"].items()}
    names = {"correlated": ("a", "b"), "independent": ("a", "c"), "identical": ("a", "a")}
    out = []
    for case in src["cases"]:
        p = case["parsed"]
        x, y = imgs[names[case["pair"]][0]], imgs[names[case["pair"]][1]]
        t1, t2 = p["Ch1 Max Threshold"], p["Ch2 Max Threshold"]
        above = (x > t1) | (y > t2)
        below = (x < t1) | (y < t2)
        both_below = (x < t1) & (y < t2)
        sp = stats.spearmanr(x, y)
        kt = stats.kendalltau(x, y, variant="b")
        sx, sy = x.sum(), y.sum()
        vals = {
            "pearsonAll": pearson(x, y),
            "pearsonAboveOr": pearson(x[above], y[above]),
            "pearsonAboveAnd": pearson(x[(x > t1) & (y > t2)], y[(x > t1) & (y > t2)]),
            "pearsonBelowOr": pearson(x[below], y[below]),
            "pearsonBelowAnd": pearson(x[both_below], y[both_below]),
            "spearman": float(sp.statistic),
            "kendallTauB": float(kt.statistic),
            "M1": float(x[y > 0].sum() / sx),
            "M2": float(y[x > 0].sum() / sy),
            "tM1_gt": float(x[y > t2].sum() / sx),
            "tM2_gt": float(y[x > t1].sum() / sy),
            "tM1_ge": float(x[y >= t2].sum() / sx),
            "tM2_ge": float(y[x >= t1].sum() / sy),
            "meanCh1": float(x.mean()),
            "meanCh2": float(y.mean()),
        }
        # which pixel-set definition reproduces the printed Fiji number (rounded to the Log's decimals): the others are kept for reference
        checks = [
            ("Pearson's R value (no threshold)", "pearsonAll", 2),
            ("Pearson's R value (above threshold)", ["pearsonAboveOr", "pearsonAboveAnd"], 2),
            ("Pearson's R value (below threshold)", ["pearsonBelowOr", "pearsonBelowAnd"], 2),
            ("Spearman's rank correlation value", "spearman", 8),
            ("Kendall's Tau-b rank correlation value", "kendallTauB", 4),
            ("Manders' M1 (Above zero intensity of Ch2)", "M1", 3),
            ("Manders' M2 (Above zero intensity of Ch1)", "M2", 3),
            ("Manders' tM1 (Above autothreshold of Ch2)", ["tM1_gt", "tM1_ge"], 3),
            ("Manders' tM2 (Above autothreshold of Ch1)", ["tM2_gt", "tM2_ge"], 3),
            ("Channel 1 Mean", "meanCh1", 3),
            ("Channel 2 Mean", "meanCh2", 3),
        ]
        match = {}
        for logkey, ours, dec in checks:
            ours_l = ours if isinstance(ours, list) else [ours]
            fiji = p[logkey]
            ok = [o for o in ours_l if (vals[o] is None and fiji is None) or (vals[o] is not None and fiji is not None and abs(round(vals[o], dec) - fiji) < 1e-9)]   # NaN prints as null on both sides
            match[logkey] = {"fijiLog": fiji, "logDecimals": dec, "reproducedBy": ok, "exact": {o: vals[o] for o in ours_l}}
        out.append({"pair": case["pair"], "regression": case["regression"], "thresholds": [t1, t2], "exact": vals, "vsFijiLog": match})
    doc = {
        "imagej": src.get("imagej"), "case": "pairs_exact",
        "call": "numpy.corrcoef / scipy.stats.spearmanr (average ranks) / scipy.stats.kendalltau(variant='b') / Manders sums, on the inputs of pairs.json at Fiji's own thresholds (tools/ij_fixtures/fiji/coloc_exact.py); numpy %s scipy %s" % (np.__version__, __import__("scipy").__version__),
        "note": "`vsFijiLog[...].reproducedBy` lists which pixel-set definitions round to the Fiji Log value at the Log's decimals; a definition missing there does not match Fiji. Spearman / Kendall are compared at +-1e-9 against `exact`.",
        "cases": out,
    }
    (folder / "pairs_exact.json").write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8", newline="\n")
    bad = [(c["pair"], c["regression"], k) for c in out for k, v in c["vsFijiLog"].items() if not v["reproducedBy"]]
    print("written; log values not reproduced:", bad)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures/ij-wave3/fiji/coloc2")
