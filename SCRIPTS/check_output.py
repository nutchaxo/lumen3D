"""
KEY FINDING: cell_ids at tp=1 are SPARSE (gaps=91%), but at tp=2+ they are 
DENSE/CONTIGUOUS (gaps=0%). This is structurally abnormal.

Normal Imaris: cell_ids are global across all objects, so they have gaps.
This dataset: tp=1 is normal (sparse), but tp=2-9 have perfectly contiguous IDs.

This suggests the data was ASSEMBLED from different sources.
The name "Part2" in the filename is a clue.

Let's verify this hypothesis and compare with ALL datasets.
"""
import pandas as pd
import numpy as np
import os

data_dir = r"z:\MORGAN\Viewer\DATA"

print("=" * 100)
print("  CELL_ID CONTIGUITY ANALYSIS — ALL DATASETS")
print("=" * 100)
print()
print(f"  {'Dataset':<60s} | {'TP':>3s} | {'cells':>5s} | {'span':>5s} | {'gaps':>5s} | {'gap%':>5s} | {'contiguous?':>11s}")
print("-" * 100)

for sample in sorted(os.listdir(data_dir)):
    sample_dir = os.path.join(data_dir, sample)
    if not os.path.isdir(sample_dir):
        continue
    xlsx_files = [f for f in os.listdir(sample_dir) if f.endswith(".xlsx") and not f.startswith("~$")]
    if not xlsx_files:
        continue
    
    df = pd.read_excel(os.path.join(sample_dir, xlsx_files[0]))
    
    for tp in sorted(df["timepoint"].unique()):
        tp_data = df[df["timepoint"] == tp]
        cids = sorted(tp_data["cell_id"].values)
        n = len(cids)
        span = cids[-1] - cids[0] + 1
        gaps = span - n
        gap_pct = gaps / max(span, 1) * 100
        contiguous = "YES" if gaps == 0 else f"no ({gaps} gaps)"
        
        # Only show first 3 and last 1 timepoints for brevity
        if tp <= sorted(df["timepoint"].unique())[min(2, len(df["timepoint"].unique())-1)] or tp == sorted(df["timepoint"].unique())[-1]:
            flag = " <<<" if gaps == 0 and n > 10 else ""
            print(f"  {sample[:60]:60s} | {int(tp):3d} | {n:5d} | {span:5d} | {gaps:5d} | {gap_pct:4.0f}% | {contiguous:>11s}{flag}")
    print()

# Now deep-dive into the broken dataset
print("\n" + "=" * 100)
print("  DETAILED BROKEN DATASET ANALYSIS")
print("=" * 100)

broken_path = r"z:\MORGAN\Viewer\DATA\Live-Egfl7eGFP-TS11d-LHF-Em5-21042026-30min-Part2-Analysis\Live-Egfl7eGFP-TS11d-LHF-Em5-21042026-30min-Part2-Analysis.xlsx"
df = pd.read_excel(broken_path)

for tp in sorted(df["timepoint"].unique()):
    tp_data = df[df["timepoint"] == tp]
    cids = sorted(tp_data["cell_id"].values)
    n = len(cids)
    min_cid, max_cid = cids[0], cids[-1]
    span = max_cid - min_cid + 1
    gaps = span - n
    
    # Show first 10 and last 5 cell_ids
    first10 = cids[:10]
    last5 = cids[-5:]
    diffs_first = [cids[i] - cids[i-1] for i in range(1, min(10, len(cids)))]
    
    print(f"\n  tp={int(tp)}: n={n}, range=[{min_cid}-{max_cid}], gaps={gaps}")
    print(f"    First 10 cell_ids: {first10}")
    print(f"    Diffs between first 10: {diffs_first}")
    print(f"    Last 5 cell_ids: {last5}")
    
    # Are they consecutive?
    all_consecutive = all(cids[i] == cids[i-1] + 1 for i in range(1, len(cids)))
    if all_consecutive:
        print(f"    >>> ALL CELL_IDS ARE PERFECTLY CONSECUTIVE (step=1)")
    else:
        # How many are consecutive vs not
        consec_count = sum(1 for i in range(1, len(cids)) if cids[i] == cids[i-1] + 1)
        print(f"    Consecutive pairs: {consec_count}/{n-1} ({consec_count/(n-1)*100:.0f}%)")

# Check how cell_ids relate to regions at each timepoint
print(f"\n\n{'='*100}")
print("  CELL_ID ORDERING BY REGION")
print(f"{'='*100}")

for tp in sorted(df["timepoint"].unique()):
    tp_data = df[df["timepoint"] == tp].sort_values("cell_id")
    
    # Show region progression as cell_id increases
    regions_by_cid = list(zip(tp_data["cell_id"].values[:15], tp_data["region"].values[:15]))
    print(f"\n  tp={int(tp)} - First 15 cells by cell_id order:")
    for cid, region in regions_by_cid:
        print(f"    cell_id={cid:5d} -> {region}")

# Check if tracks at tp=1 have a specific cell_id structure vs tp=2
print(f"\n\n{'='*100}")
print("  TP=1 vs TP=2: Structural comparison")
print(f"{'='*100}")

tp1 = df[df["timepoint"] == 1].sort_values("cell_id")
tp2 = df[df["timepoint"] == 2].sort_values("cell_id")

print(f"\n  tp=1: {len(tp1)} cells, cell_id range [{tp1['cell_id'].min()}-{tp1['cell_id'].max()}]")
print(f"  tp=2: {len(tp2)} cells, cell_id range [{tp2['cell_id'].min()}-{tp2['cell_id'].max()}]")

# Show what regions are present
print(f"\n  Regions at tp=1:")
print(tp1["region"].value_counts().to_string())
print(f"\n  Regions at tp=2:")
print(tp2["region"].value_counts().to_string())
