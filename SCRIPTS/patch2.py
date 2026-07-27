
# ---------------------------------------------
#  CELL METRICS
# ---------------------------------------------

def is_in_hull(point, hull):
    """Check if a 2D point is inside a scipy.spatial.ConvexHull."""
    return np.all(hull.equations[:, :-1] @ point + hull.equations[:, -1] <= 1e-8)

def compute_metrics(df, assigner, coord_cols=("x", "y", "z"), time_interval_min=1.0):
    """
    Compute per-cell migration metrics from the tracked dataframe.

    Parameters
    ----------
    df : DataFrame with tracking data
    assigner : CellIDAssigner with lineage info
    coord_cols : tuple of column names for x, y, z coordinates
                 Use ("x", "y", "z") for raw or ("x_stab", "y_stab", "z_stab") for stabilized
    time_interval_min : float, time between consecutive frames in minutes

    Returns a DataFrame with one row per unique_cell_id.
    """
    cx, cy, cz = coord_cols
    records = []

    t_min = df["timepoint"].min()
    t_max = df["timepoint"].max()
    
    cell_time_ranges = df.groupby("unique_cell_id")["timepoint"].agg(['min', 'max'])
    stable_cids = cell_time_ranges[(cell_time_ranges['min'] == t_min) & (cell_time_ranges['max'] == t_max)].index.tolist()
    
    masks = {}
    if len(stable_cids) > 0:
        stable_df = df[df["unique_cell_id"].isin(stable_cids)]
        for tp, tp_df in stable_df.groupby("timepoint"):
            pts2d = tp_df[[cx, cy]].values
            z_min, z_max = tp_df[cz].min(), tp_df[cz].max()
            if len(pts2d) >= 3:
                try:
                    hull = ConvexHull(pts2d)
                    masks[tp] = {"hull": hull, "z_min": z_min, "z_max": z_max}
                except:
                    pass

    for cid, grp in df.groupby("unique_cell_id"):
        grp = grp.sort_values("timepoint")
        coords = grp[[cx, cy, cz]].values  # shape (n, 3)
        tps = grp["timepoint"].values

        # Step distances
        if len(coords) > 1:
            deltas = np.diff(coords, axis=0)
            step_dists = np.linalg.norm(deltas, axis=1)
            # Time gaps between consecutive timepoints (for velocity)
            time_gaps = np.diff(tps).astype(float)
            # Avoid division by zero (shouldn't happen, but safety)
            time_gaps[time_gaps == 0] = 1.0
            # Convert time_gaps from frames to minutes, compute speed um/min
            step_velocities = step_dists / (time_gaps * time_interval_min)
        else:
            step_dists = np.array([0.0])
            step_velocities = np.array([0.0])

        path_length = float(np.sum(step_dists))
        net_displacement = float(np.linalg.norm(coords[-1] - coords[0]))

        if path_length > 0:
            straightness_index = net_displacement / path_length
        else:
            straightness_index = 0.0

        mean_velocity = float(np.mean(step_velocities)) if len(step_velocities) > 0 else 0.0
        max_velocity = float(np.max(step_velocities)) if len(step_velocities) > 0 else 0.0

        # Lineage info
        parent = str(assigner.parent_map[cid]) if cid in assigner.parent_map else ""
        daughters = ""
        if cid in assigner.daughter_map:
            daughters = "/".join(str(d) for d in assigner.daughter_map[cid])

        # New cell and stable mask logic
        first_tp = tps[0]
        has_parent = cid in assigner.parent_map
        is_new_cell = (not has_parent) and (first_tp > t_min)
        
        in_stable_mask = False
        if is_new_cell and first_tp in masks:
            m = masks[first_tp]
            z_first = coords[0, 2]
            if m["z_min"] <= z_first <= m["z_max"]:
                if is_in_hull(coords[0, :2], m["hull"]):
                    in_stable_mask = True

        records.append({
            "unique_cell_id": cid,
            "track_id": grp["track_id"].iloc[0],
            "region": grp["region"].iloc[0],
            "path_length": path_length,
            "net_displacement": net_displacement,
            "straightness_index": straightness_index,
            "mean_velocity": mean_velocity,
            "max_velocity": max_velocity,
            "parent_cell": parent,
            "daughter_cells": daughters,
            "is_new_cell": is_new_cell,
            "in_stable_mask": in_stable_mask,
        })

    metrics_df = pd.DataFrame(records)
    return metrics_df

