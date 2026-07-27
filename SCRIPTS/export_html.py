import json
import orjson
import os
import gzip
import datetime
import uuid
import math


def _normalize_region_value(value) -> str:
    """Canonicalize region labels for robust sorting/export."""
    if value is None:
        return "Unknown"
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return "Unknown"
    text = str(value).strip()
    if not text or text.lower() in {"nan", "none"}:
        return "Unknown"
    return text
def export_imaris_track(df_dense, out_dir, sample_name, out_filename="cell_tracking.imaris_track",
                        neighbor_dist_df=None, neighbor_summary_df=None, surface_data=None):
    """
    Exports the cell tracking data directly into an optimized, compressed JSON binary format 
    (.imaris_track) seamlessly readable by the standalone ImarisViewer.html Master Web App.
    
    Includes:
      - Stabilized coordinates (x_stab, y_stab, z_stab) as default x/y/z
      - Raw coordinates (x_raw, y_raw, z_raw) for the "Stabilisé" toggle
      - Mitosis/fusion markers
      - Lineage information (parent_cell, daughter_cells)
      - Neighbor distance tracking data (if provided)
    """
    # Extract palette dynamically or fallback
    from Analysis import REGION_PALETTE
    df_dense = df_dense.copy()
    if "region" in df_dense.columns:
        df_dense["region"] = df_dense["region"].map(_normalize_region_value)
    else:
        df_dense["region"] = "Unknown"

    regions = sorted(df_dense["region"].unique(), key=str)
    region_colors = {r: REGION_PALETTE[i % len(REGION_PALETTE)] for i, r in enumerate(regions)}

    # Build internal TRACK_DATA structure
    tps = sorted([float(t) for t in df_dense["timepoint"].unique()])
    
    cells = []
    # Group by unique_cell_id so each gets its own trace/trail
    for cid, grp in df_dense.groupby("unique_cell_id"):
        grp = grp.sort_values("timepoint")
        
        region = grp["region"].iloc[0]
        color = region_colors[region]
        
        # Lineage info (take first non-empty value, should be constant per cell)
        parent_cell = ""
        daughter_cells = ""
        if "parent_cell" in grp.columns:
            parent_vals = grp["parent_cell"].dropna()
            parent_cell = str(parent_vals.iloc[0]) if len(parent_vals) > 0 else ""
        if "daughter_cells" in grp.columns:
            daughter_vals = grp["daughter_cells"].dropna()
            daughter_cells = str(daughter_vals.iloc[0]) if len(daughter_vals) > 0 else ""
        
        cell_obj = {
            "id": int(cid),
            "track_id": int(grp["track_id"].iloc[0]) if "track_id" in grp.columns else None,
            "region": str(region),
            "color": color,
            "t": [float(val) for val in grp["timepoint"]],
            # Default coordinates = stabilized (used when "Stabilisé" is checked)
            "x": [float(val) for val in grp["x_stab"]],
            "y": [float(val) for val in grp["y_stab"]],
            "z": [float(val) for val in grp["z_stab"]],
            # Raw coordinates (used when "Stabilisé" is unchecked)
            "x_raw": [float(val) for val in grp["x"]],
            "y_raw": [float(val) for val in grp["y"]],
            "z_raw": [float(val) for val in grp["z"]],
            # Event markers (red=mitosis, black=fusion)
            "marker_color": grp["marker_color"].tolist() if "marker_color" in grp.columns else [""] * len(grp),
            # Lineage
            "parent_cell": parent_cell,
            "daughter_cells": daughter_cells
        }
        cells.append(cell_obj)
        
    def padded_range(vmin, vmax, pad=0.05):
        span = vmax - vmin
        if span == 0: span = 1
        return [float(vmin - span*pad), float(vmax + span*pad)]

    track_data = {
        "timepoints": tps,
        "cells": cells,
        "layout": {
            "x_range": padded_range(df_dense["x_stab"].dropna().min(), df_dense["x_stab"].dropna().max()),
            "y_range": padded_range(df_dense["y_stab"].dropna().min(), df_dense["y_stab"].dropna().max()),
            "z_range": padded_range(df_dense["z_stab"].dropna().min(), df_dense["z_stab"].dropna().max()),
        }
    }



    # --- Neighbor distance data (stored for future use) ---
    def _sanitize_val(v):
        """Replace NaN/inf with None for clean JSON serialization."""
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            return None
        return v

    def _df_to_records(df):
        """Convert DataFrame to list of dicts with NaN -> None."""
        records = df.to_dict(orient="records")
        return [{k: _sanitize_val(v) for k, v in row.items()} for row in records]

    if neighbor_dist_df is not None and not neighbor_dist_df.empty:
        track_data["neighbor_distances"] = _df_to_records(neighbor_dist_df)

    if neighbor_summary_df is not None and not neighbor_summary_df.empty:
        track_data["neighbor_summary"] = _df_to_records(neighbor_summary_df)

    # --- Surface mesh data ---
    # We now delegate export to GLB via the new parallel export module
    from export_mesh import export_meshes_to_glb_parallel
    
    # Encapsulate into Master Envelope Payload
    dt_now = datetime.datetime.now()
    payload = {
        "signature": "IMARIS_TRACKER_V1",
        "dataset_id": str(uuid.uuid4()),  # Unique ID for deduplication
        "dataset_name": sample_name,
        "date_generation": dt_now.isoformat(),
        "data": track_data
    }
    
    if surface_data is not None:
        # ─── Fusionner stab + raw en un seul GLB ───
        # Les nodes seront nommés stab_tp_1_0, raw_tp_1_0, etc.
        # Le viewer choisit le bon préfixe selon le toggle "Stabilisé"
        merged_meshes = {}
        for cs_name, mesh_results in surface_data.items():
            for tp, data in mesh_results.items():
                if data is not None:
                    merged_meshes[(cs_name, round(float(tp), 2))] = data
        
        glb_filename = f"{sample_name}.glb"
        out_path = os.path.join(out_dir, glb_filename)
        print(f"  -> Encoding merged stab+raw surface ({len(merged_meshes)} nodes)...")
        export_meshes_to_glb_parallel(
            mesh_results=merged_meshes,
            track_data=payload,
            dataset_name=sample_name,
            output_path=out_path
        )
    else:
        print("  [ERROR] No surface meshes provided for export.")

    # Always write the imaris_track JSON payload separately so the viewer drag&drop validator passes
    track_filepath = os.path.join(out_dir, out_filename)
    import gzip, orjson
    with gzip.open(track_filepath, 'wb') as f:
        # We append a simple text header so we can detect it easily if needed, then dump JSON
        f.write(b"IMARIS_TRACKER_V1\n")
        f.write(orjson.dumps(payload))
