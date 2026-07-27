"""
Imaris Cell Tracking — Cell ID Assignment & Lineage Analysis
=============================================================
Reads Imaris Excel exports from DATA/<SAMPLE>/ folders,
assigns unique biological cell IDs (handling mitosis events),
and outputs a CSV with lineage information (parent/daughter cells).

Output structure:
    OUTPUT/<YY.MM.DD-HH.MM>/<SAMPLE>/cell_tracking.csv
"""

import os
import sys
import glob
from datetime import datetime
import multiprocessing

def _configure_threads_early():
    total = multiprocessing.cpu_count()
    n_workers = max(1, total - 4)
    n_str = str(n_workers)
    os.environ['OMP_NUM_THREADS']        = n_str
    os.environ['OPENBLAS_NUM_THREADS']   = n_str
    os.environ['MKL_NUM_THREADS']        = n_str
    os.environ['VECLIB_MAXIMUM_THREADS'] = n_str
    os.environ['NUMEXPR_NUM_THREADS']    = n_str
"""
Imaris Cell Tracking — Cell ID Assignment & Lineage Analysis
=============================================================
Reads Imaris Excel exports from DATA/<SAMPLE>/ folders,
assigns unique biological cell IDs (handling mitosis events),
and outputs a CSV with lineage information (parent/daughter cells).

Output structure:
    OUTPUT/<YY.MM.DD-HH.MM>/<SAMPLE>/cell_tracking.csv
"""

import os
import sys
import glob
from datetime import datetime
import multiprocessing

def _configure_threads_early():
    total = multiprocessing.cpu_count()
    n_workers = max(1, total - 4)
    # FORCE 1 THREAD PER PROCESS TO AVOID OVERSUBSCRIPTION (256+ threads)
    n_str = "1"
    os.environ['OMP_NUM_THREADS']        = n_str
    os.environ['OPENBLAS_NUM_THREADS']   = n_str
    os.environ['MKL_NUM_THREADS']        = n_str
    os.environ['VECLIB_MAXIMUM_THREADS'] = n_str
    os.environ['NUMEXPR_NUM_THREADS']    = n_str
    return n_workers

n_workers = _configure_threads_early()

import numpy as np
import pandas as pd
from scipy.optimize import linear_sum_assignment
from scipy.spatial.transform import Rotation
from scipy.spatial import ConvexHull
from export_html import export_imaris_track


# ---------------------------------------------
#  PATHS
# ---------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(BASE_DIR, "DATA")
OUTPUT_ROOT = os.path.join(BASE_DIR, "OUTPUT")


# ---------------------------------------------
#  HELPERS
# ---------------------------------------------

def euclidean_distance(p1, p2):
    """Euclidean distance between two 3D points (arrays of shape (3,))."""
    return np.sqrt(np.sum((p1 - p2) ** 2))


def build_cost_matrix(coords_prev, coords_curr):
    """
    Build a cost matrix of Euclidean distances between two sets of 3D points.
    Shape: (n_prev, n_curr).
    """
    n_prev = len(coords_prev)
    n_curr = len(coords_curr)
    cost = np.zeros((n_prev, n_curr))
    for i in range(n_prev):
        for j in range(n_curr):
            cost[i, j] = euclidean_distance(coords_prev[i], coords_curr[j])
    return cost


def assign_synthetic_track_ids(df: pd.DataFrame) -> pd.DataFrame:
    """
    Remplace les track_id manquants par des IDs synthétiques uniques, un par ligne.

    Ces lignes correspondent à des cellules isolées observées sur un seul timepoint.
    Leur donner un track_id distinct évite qu'elles soient toutes fusionnées sous
    le même unique_cell_id résiduel (-1) plus tard dans le pipeline.
    """
    df = df.copy()

    track_str = df["track_id"].astype(str).str.strip()
    missing_mask = df["track_id"].isna() | (track_str == "") | (track_str.str.lower() == "nan")
    n_missing = int(missing_mask.sum())
    if n_missing == 0:
        return df

    numeric_track_ids = pd.to_numeric(df.loc[~missing_mask, "track_id"], errors="coerce")
    max_track_id = int(numeric_track_ids.max()) if numeric_track_ids.notna().any() else 0
    synthetic_ids = np.arange(max_track_id + 1, max_track_id + 1 + n_missing, dtype=np.int64)

    if pd.api.types.is_string_dtype(df["track_id"].dtype):
        df.loc[missing_mask, "track_id"] = synthetic_ids.astype(str)
    else:
        df.loc[missing_mask, "track_id"] = synthetic_ids
    return df


def _find_column_by_alias(df: pd.DataFrame, aliases):
    """Return the first matching column name for a list of lowercase aliases."""
    normalized_to_original = {}
    for col in df.columns:
        key = str(col).strip().lower()
        if key not in normalized_to_original:
            normalized_to_original[key] = col
    for alias in aliases:
        if alias in normalized_to_original:
            return normalized_to_original[alias]
    return None


def normalize_region_value(value) -> str:
    """Canonicalize region labels so sorting/color mapping stays stable."""
    if pd.isna(value):
        return "Unknown"
    text = str(value).strip()
    if not text or text.lower() in {"nan", "none"}:
        return "Unknown"
    return text


def normalize_region_series(region_series: pd.Series) -> pd.Series:
    """Normalize a pandas Series of region labels to clean strings."""
    return region_series.map(normalize_region_value)


def standardize_input_dataframe(df: pd.DataFrame, sample_name="") -> pd.DataFrame:
    """
    Normalize supported input schemas to the canonical columns expected downstream.

    Supported behavior:
      - old schema: already has track_id, cell_id, timepoint, x, y, z, region
      - lightweight schema: cell_id/timepoint/x/y/z only
        -> track_id is derived from cell_id, region defaults to "Unknown"
    """
    df = df.copy()
    df.columns = [str(col).strip() for col in df.columns]

    alias_groups = {
        "track_id": ["track_id", "track id", "trackid"],
        "cell_id": ["cell_id", "cell id", "cellid", "id", "object_id", "object id", "spot_id", "spot id"],
        "timepoint": ["timepoint", "time point", "frame", "time", "tp", "t"],
        "x": ["x", "x_um", "x (um)", "position x", "position_x"],
        "y": ["y", "y_um", "y (um)", "position y", "position_y"],
        "z": ["z", "z_um", "z (um)", "position z", "position_z"],
        "region": ["region", "group", "population", "class"],
    }

    rename_map = {}
    for target, aliases in alias_groups.items():
        col = _find_column_by_alias(df, aliases)
        if col is not None and col != target:
            rename_map[col] = target
    if rename_map:
        df = df.rename(columns=rename_map)

    if "cell_id" not in df.columns:
        raise ValueError(
            f"Missing required identifier column 'cell_id' in sample '{sample_name}'. "
            f"Available columns: {list(df.columns)}"
        )

    required_coords = {"timepoint", "x", "y", "z"}
    missing_coords = required_coords - set(df.columns)
    if missing_coords:
        raise ValueError(
            f"Missing required columns {missing_coords} in sample '{sample_name}'. "
            f"Available columns: {list(df.columns)}"
        )

    if "track_id" not in df.columns:
        df["track_id"] = df["cell_id"]
        print("  [INFO] No 'track_id' column found; using 'cell_id' as persistent track identifier.")

    if "region" not in df.columns:
        df["region"] = "Unknown"
        print("  [INFO] No 'region' column found; defaulting all cells to 'Unknown'.")
    else:
        df["region"] = normalize_region_series(df["region"])

    for col in ["track_id", "cell_id", "timepoint", "x", "y", "z"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    before_drop = len(df)
    df = df.dropna(subset=["cell_id", "timepoint", "x", "y", "z"]).copy()
    dropped = before_drop - len(df)
    if dropped:
        print(f"  [WARNING] Dropped {dropped} rows with missing numeric tracking data.")

    df["cell_id"] = df["cell_id"].astype(np.int64)
    df["timepoint"] = df["timepoint"].astype(float)

    track_text = df["track_id"].astype("string").str.strip()
    missing_track_mask = df["track_id"].isna() | track_text.str.lower().isin(["", "nan", "none"])
    track_numeric = pd.to_numeric(df["track_id"], errors="coerce")
    if track_numeric[~missing_track_mask].notna().all():
        df["track_id"] = track_numeric.astype("Int64")
        df.loc[missing_track_mask, "track_id"] = pd.NA
    else:
        df["track_id"] = track_text
        df.loc[missing_track_mask, "track_id"] = pd.NA

    return df


# ---------------------------------------------
#  CORE ALGORITHM
# ---------------------------------------------

class CellIDAssigner:
    """
    Assigns unique cell IDs within each track_id, handling:
     - Simple tracks (1 cell per timepoint — no mitosis)
     - Mitosis events (cell count increases between timepoints)
     - Cell disappearance (cell count decreases between timepoints)
     - Tracks starting already divided (multiple cells at first timepoint)
     - Nested / cascading mitosis
    """

    def __init__(self):
        self.next_id = 1
        self.parent_map = {}     # unique_cell_id -> parent_unique_cell_id (can be string ID1/ID2)
        self.daughter_map = {}   # unique_cell_id -> list of daughter_unique_cell_ids
        self.mitosis_markers = set()  # set of (timepoint, unique_cell_id) dying next frame via mitosis
        self.fusion_markers = set()   # set of (timepoint, unique_cell_id) dying next frame via fusion

    def _new_id(self):
        """Generate the next unique cell ID."""
        cid = self.next_id
        self.next_id += 1
        return cid

    def assign_ids(self, df):
        """
        Process the full dataframe. Returns a copy with added columns:
          - unique_cell_id
          - parent_cell
          - daughter_cells

        Parameters
        ----------
        df : pd.DataFrame
            Must contain: track_id, cell_id, timepoint, x, y, z, region
        """
        df = df.copy()
        df["unique_cell_id"] = -1
        df["parent_cell"] = ""
        df["daughter_cells"] = ""

        for track_id, track_group in df.groupby("track_id"):
            self._process_track(df, track_id, track_group)

        # Garde-fou: si certaines lignes ont échappé au groupby (track_id manquant
        # ou anormal), on les traite comme des cellules indépendantes mono-frame.
        orphan_mask = df["unique_cell_id"] == -1
        if orphan_mask.any():
            for idx in df.index[orphan_mask]:
                df.at[idx, "unique_cell_id"] = self._new_id()

        # Fill daughter_cells column from daughter_map
        self._fill_daughters(df)

        return df

    def _process_track(self, df, track_id, track_group):
        """Process a single track_id: assign cell IDs across all timepoints."""

        timepoints = sorted(track_group["timepoint"].unique())

        # State: list of (unique_cell_id, x, y, z) for the "current" cells
        current_cells = []

        for t_idx, tp in enumerate(timepoints):
            # Get all rows for this track at this timepoint
            tp_mask = (df["track_id"] == track_id) & (df["timepoint"] == tp)
            tp_rows = df.loc[tp_mask].copy()
            tp_indices = tp_rows.index.tolist()
            tp_coords = tp_rows[["x", "y", "z"]].values  # shape (n_curr, 3)

            n_curr = len(tp_indices)

            if t_idx == 0:
                # First timepoint: assign new IDs to all cells
                for i in range(n_curr):
                    cid = self._new_id()
                    current_cells.append((cid, tp_coords[i]))
                    df.at[tp_indices[i], "unique_cell_id"] = cid
            else:
                n_prev = len(current_cells)
                prev_tp = timepoints[t_idx - 1]

                if n_curr == 0:
                    # No cells at this timepoint — all disappeared
                    current_cells = []
                    continue

                # Build cost matrix: rows=prev cells, cols=curr points
                prev_coords = np.array([c[1] for c in current_cells])
                cost = build_cost_matrix(prev_coords, tp_coords)

                if n_curr == n_prev:
                    # Same number of cells: simple matching
                    self._handle_same_count(df, tp_indices, tp_coords,
                                            current_cells, cost, n_curr)

                elif n_curr > n_prev:
                    # More cells than before = mitosis event(s)
                    self._handle_mitosis(
                        df, tp_indices, tp_coords, prev_tp,
                        current_cells, cost, n_prev, n_curr
                    )

                elif n_curr < n_prev:
                    # Fewer cells = disappearance
                    self._handle_disappearance(
                        df, tp_indices, tp_coords, prev_tp,
                        current_cells, cost, n_prev, n_curr
                    )

        return current_cells

    def _handle_same_count(self, df, tp_indices, tp_coords, 
                           current_cells, cost, n_curr):
        row_ind, col_ind = linear_sum_assignment(cost)
        
        new_current = []
        # cost shape = (n_prev, n_curr): row_ind indexes previous cells,
        # col_ind indexes current detections.
        for prev_i, curr_i in zip(row_ind, col_ind):
            cid = current_cells[prev_i][0]
            df.at[tp_indices[curr_i], "unique_cell_id"] = cid
            new_current.append((cid, tp_coords[curr_i]))
        
        current_cells.clear()
        current_cells.extend(new_current)

    def _handle_mitosis(self, df, tp_indices, tp_coords, prev_tp,
                        current_cells, cost, n_prev, n_curr):
        """
        Handle a mitosis event where n_curr > n_prev.

        Strategy:
        1. Use the Hungarian algorithm on the full cost matrix (n_prev × n_curr)
           to optimally match each previous cell to its nearest current point.
        2. The unmatched current points are the NEW daughter cells.
        3. For each new daughter, find which matched cell is closest to it
           -> that cell is the mother.
        4. The mother's matched point also becomes a daughter (sibling).
        5. Both daughters get new IDs; the mother's old ID goes into parent_cell.
        """
        # Hungarian matching: assign each prev cell to one curr point
        row_ind, col_ind = linear_sum_assignment(cost)

        matched_curr = set(col_ind)
        unmatched_curr = [j for j in range(n_curr) if j not in matched_curr]

        # Build mapping: prev_idx -> curr_idx (from the matching)
        prev_to_curr = dict(zip(row_ind, col_ind))

        # Track which mothers have already been processed
        processed_mothers = set()

        # For each unmatched (new) cell, find its mother
        for new_j in unmatched_curr:
            new_coord = tp_coords[new_j]

            # Find closest matched previous cell to this new point
            best_mother_prev_idx = None
            best_dist = float("inf")
            for r, c in zip(row_ind, col_ind):
                if r in processed_mothers:
                    continue
                dist = euclidean_distance(tp_coords[c], new_coord)
                # Also consider distance from the PREVIOUS position of the mother
                dist_prev = euclidean_distance(current_cells[r][1], new_coord)
                combined_dist = min(dist, dist_prev)
                if combined_dist < best_dist:
                    best_dist = combined_dist
                    best_mother_prev_idx = r

            if best_mother_prev_idx is None:
                # Fallback: pick any unprocessed mother
                for r in row_ind:
                    if r not in processed_mothers:
                        best_mother_prev_idx = r
                        break

            processed_mothers.add(best_mother_prev_idx)

            mother_id = current_cells[best_mother_prev_idx][0]
            mother_matched_curr_idx = prev_to_curr[best_mother_prev_idx]

            # Create new IDs for both daughters
            daughter1_id = self._new_id()  # replaces mother's matched point
            daughter2_id = self._new_id()  # the new unmatched point

            self.parent_map[daughter1_id] = mother_id
            self.parent_map[daughter2_id] = mother_id
            if mother_id not in self.daughter_map:
                self.daughter_map[mother_id] = []
            self.daughter_map[mother_id].extend([daughter1_id, daughter2_id])
            
            # MARK THE MOTHER FOR MITOSIS HIGHLIGHT
            self.mitosis_markers.add((prev_tp, mother_id))

            # Assign IDs to the dataframe
            df.at[tp_indices[mother_matched_curr_idx], "unique_cell_id"] = daughter1_id
            df.at[tp_indices[new_j], "unique_cell_id"] = daughter2_id

            # Update current_cells: replace mother with daughter1
            current_cells[best_mother_prev_idx] = (daughter1_id, tp_coords[mother_matched_curr_idx])

        # Assign IDs for matched cells that were NOT mothers (no mitosis for them)
        for r, c in zip(row_ind, col_ind):
            if r not in processed_mothers:
                if cost[r, c] > 60.0:
                    cid = self._new_id()
                else:
                    cid = current_cells[r][0]
                df.at[tp_indices[c], "unique_cell_id"] = cid
                current_cells[r] = (cid, tp_coords[c])

        # Add the new daughter cells to current_cells
        for new_j in unmatched_curr:
            cid = df.at[tp_indices[new_j], "unique_cell_id"]
            current_cells.append((cid, tp_coords[new_j]))

    def _handle_disappearance(self, df, tp_indices, tp_coords, prev_tp,
                              current_cells, cost, n_prev, n_curr):
        """
        Handle n_curr < n_prev. This means either cells left the view,
        OR they fused. We match all n_curr to n_prev. The leftover n_prev - n_curr
        cells are checked to see if they fused into one of the n_curr cells.
        """
        cost_t = cost.T
        row_ind, col_ind = linear_sum_assignment(cost_t)
        
        matched_prev = set(col_ind)
        unmatched_prev = set(range(n_prev)) - matched_prev

        # Check where unmatched previous cells went
        fusion_targets = {}
        for p_idx in unmatched_prev:
            best_c_idx = np.argmin(cost[p_idx, :])
            # If the closest spot is reasonably close, consider it a fusion
            if cost[p_idx, best_c_idx] < 60.0:  # 60 um threshold for fusion
                if best_c_idx not in fusion_targets:
                    fusion_targets[best_c_idx] = []
                fusion_targets[best_c_idx].append(p_idx)

        new_current = []
        for c_idx, p_idx in zip(row_ind, col_ind):
            primary_parent_id = current_cells[p_idx][0]
            
            if c_idx in fusion_targets and cost[p_idx, c_idx] < 60.0:
                # FUSION DETECTED
                fused_prev_indices = [p_idx] + fusion_targets[c_idx]
                parent_ids = sorted([current_cells[pi][0] for pi in fused_prev_indices])
                
                merged_id = self._new_id()
                parent_str = "/".join(str(pid) for pid in parent_ids)
                
                self.parent_map[merged_id] = parent_str
                for pid in parent_ids:
                    if pid not in self.daughter_map:
                        self.daughter_map[pid] = []
                    self.daughter_map[pid].append(merged_id)
                    # Add fusion marker (black) for the frame BEFORE fusion
                    self.fusion_markers.add((prev_tp, pid))
                
                df.at[tp_indices[c_idx], "unique_cell_id"] = merged_id
                new_current.append((merged_id, tp_coords[c_idx]))
            else:
                # Normal continuation, but check distance to prevent teleporting (bug fix)
                if cost[p_idx, c_idx] > 60.0:
                    # Too far, new cell
                    new_id = self._new_id()
                    df.at[tp_indices[c_idx], "unique_cell_id"] = new_id
                    new_current.append((new_id, tp_coords[c_idx]))
                else:
                    df.at[tp_indices[c_idx], "unique_cell_id"] = primary_parent_id
                    new_current.append((primary_parent_id, tp_coords[c_idx]))

        current_cells.clear()
        current_cells.extend(new_current)

    def _fill_daughters(self, df):
        """Fill parent_cell and daughter_cells columns from lineage maps."""

        # Build reverse lookup: unique_cell_id -> set of row indices
        id_to_indices = {}
        for idx, row in df.iterrows():
            cid = row["unique_cell_id"]
            if cid not in id_to_indices:
                id_to_indices[cid] = []
            id_to_indices[cid].append(idx)

        # Fill parent_cell
        for child_id, parent_id in self.parent_map.items():
            if child_id in id_to_indices:
                for idx in id_to_indices[child_id]:
                    df.at[idx, "parent_cell"] = str(parent_id)

        # Fill daughter_cells
        for mother_id, daughters in self.daughter_map.items():
            daughter_str = "/".join(str(d) for d in daughters)
            if mother_id in id_to_indices:
                for idx in id_to_indices[mother_id]:
                    df.at[idx, "daughter_cells"] = daughter_str


# ---------------------------------------------
#  KABSCH / SVD STABILIZATION
# ---------------------------------------------

def kabsch(P, Q):
    """
    Find the optimal rigid transformation (rotation R + translation t)
    that minimizes || Q - (R @ P.T).T - t ||.

    Parameters
    ----------
    P : ndarray (n, 3) � source points (previous timepoint)
    Q : ndarray (n, 3) � target points (current timepoint)

    Returns
    -------
    R : ndarray (3, 3) � rotation matrix
    t : ndarray (3,)   � translation vector
    Such that: Q_aligned = (R @ Q.T).T + t  ~=  P
    """
    # Centroids
    centroid_P = P.mean(axis=0)
    centroid_Q = Q.mean(axis=0)

    # Center the points
    P_c = P - centroid_P
    Q_c = Q - centroid_Q

    # Cross-covariance matrix
    H = Q_c.T @ P_c

    # SVD
    U, S, Vt = np.linalg.svd(H)

    # Ensure proper rotation (det = +1, not reflection)
    d = np.linalg.det(Vt.T @ U.T)
    sign_matrix = np.diag([1, 1, np.sign(d)])

    R = Vt.T @ sign_matrix @ U.T
    t = centroid_P - R @ centroid_Q

    return R, t


def apply_rigid_transform(coords, R, t):
    """Apply rotation R and translation t to an (n, 3) array of points."""
    return (R @ coords.T).T + t


def find_reference_cells(df, assigner):
    """
    Select reference cells: unique_cell_ids that
      - are NOT involved in mitosis (neither mother nor daughter)
      - are present on at least 2 timepoints
    """
    # Cells involved in mitosis
    mitosis_cells = set(assigner.parent_map.keys()) | set(assigner.daughter_map.keys())

    ref_cells = []
    for cid, grp in df.groupby("unique_cell_id"):
        if cid in mitosis_cells:
            continue
        if len(grp) >= 2:
            ref_cells.append(cid)

    return ref_cells


def stabilize_coordinates(df, assigner):
    """
    Stabilize cell coordinates by removing embryo global motion
    using sequential Kabsch alignment.

    Returns
    -------
    df : DataFrame with x_stab, y_stab, z_stab columns added
    diagnostics : dict with per-transition residual info
    """
    df = df.copy()
    timepoints = sorted(df["timepoint"].unique())
    ref_cells = find_reference_cells(df, assigner)

    print(f"  Stabilization: {len(ref_cells)} reference cells (no mitosis, >=2 timepoints)")

    # Initialize stabilized coords = raw coords for the first timepoint
    df["x_stab"] = df["x"].copy()
    df["y_stab"] = df["y"].copy()
    df["z_stab"] = df["z"].copy()

    diagnostics = {
        "transitions": [],        # (tp_from, tp_to)
        "n_refs_used": [],        # number of ref cells used per transition
        "rmse_before": [],        # RMSE of ref cells before alignment
        "rmse_after": [],         # RMSE of ref cells after alignment
        "max_residual_after": [], # max residual after alignment
        "per_cell_residuals": {}, # cell_id -> list of residuals across transitions
        "rotations_per_tp": {},   # timepoint -> cumulative Euler angles (rx, ry, rz) in degrees
    }

    # Track cumulative rotation
    R_cumul = np.eye(3)
    diagnostics["rotations_per_tp"][timepoints[0]] = (0.0, 0.0, 0.0)

    for cell in ref_cells:
        diagnostics["per_cell_residuals"][cell] = []

    # Sequential alignment: align tp(n) onto tp(n-1) (already stabilized)
    for i in range(1, len(timepoints)):
        tp_prev = timepoints[i - 1]
        tp_curr = timepoints[i]

        # Find reference cells present at BOTH timepoints
        refs_prev = df[(df["timepoint"] == tp_prev) & (df["unique_cell_id"].isin(ref_cells))]
        refs_curr = df[(df["timepoint"] == tp_curr) & (df["unique_cell_id"].isin(ref_cells))]

        # Intersect: cells present at both
        common_cells = sorted(
            set(refs_prev["unique_cell_id"].values) & set(refs_curr["unique_cell_id"].values)
        )

        if len(common_cells) < 3:
            print(f"    WARNING: Only {len(common_cells)} common ref cells for "
                  f"tp{tp_prev}->tp{tp_curr}, skipping alignment (need >=3)")
            diagnostics["transitions"].append((tp_prev, tp_curr))
            diagnostics["n_refs_used"].append(len(common_cells))
            diagnostics["rmse_before"].append(np.nan)
            diagnostics["rmse_after"].append(np.nan)
            diagnostics["max_residual_after"].append(np.nan)
            continue

        # Get matched coordinates (same order of cell IDs)
        P = np.array([
            refs_prev[refs_prev["unique_cell_id"] == c][["x_stab", "y_stab", "z_stab"]].values[0]
            for c in common_cells
        ])
        Q = np.array([
            refs_curr[refs_curr["unique_cell_id"] == c][["x", "y", "z"]].values[0]
            for c in common_cells
        ])

        # RMSE before alignment
        residuals_before = np.linalg.norm(P - Q, axis=1)
        rmse_before = np.sqrt(np.mean(residuals_before ** 2))

        # Kabsch alignment
        R, t = kabsch(P, Q)

        # Apply to ALL cells at this timepoint
        curr_mask = df["timepoint"] == tp_curr
        raw_coords = df.loc[curr_mask, ["x", "y", "z"]].values
        stabilized = apply_rigid_transform(raw_coords, R, t)
        df.loc[curr_mask, "x_stab"] = stabilized[:, 0]
        df.loc[curr_mask, "y_stab"] = stabilized[:, 1]
        df.loc[curr_mask, "z_stab"] = stabilized[:, 2]

        # RMSE after alignment (on reference cells only)
        Q_aligned = apply_rigid_transform(Q, R, t)
        residuals_after = np.linalg.norm(P - Q_aligned, axis=1)
        rmse_after = np.sqrt(np.mean(residuals_after ** 2))

        # Store diagnostics
        diagnostics["transitions"].append((tp_prev, tp_curr))
        diagnostics["n_refs_used"].append(len(common_cells))
        diagnostics["rmse_before"].append(rmse_before)
        diagnostics["rmse_after"].append(rmse_after)
        diagnostics["max_residual_after"].append(float(np.max(residuals_after)))

        # Track cumulative rotation (Euler angles in degrees)
        R_cumul = R @ R_cumul
        # Decompose into Euler angles (XYZ convention)
        rot = Rotation.from_matrix(R_cumul)
        rx, ry, rz = rot.as_euler('xyz', degrees=True)
        diagnostics["rotations_per_tp"][tp_curr] = (rx, ry, rz)

        for j, cell in enumerate(common_cells):
            if cell in diagnostics["per_cell_residuals"]:
                diagnostics["per_cell_residuals"][cell].append(residuals_after[j])

        print(f"    tp{tp_prev}->tp{tp_curr}: {len(common_cells)} refs, "
              f"RMSE {rmse_before:.2f} -> {rmse_after:.2f}, "
              f"max residual {np.max(residuals_after):.2f}")

    return df, diagnostics


def plot_stabilization_diagnostics(diagnostics, out_dir):
    """
    Generate diagnostic plots for stabilization quality.
    Saves a multi-panel PNG.
    """
    fig, axes = plt.subplots(2, 2, figsize=(14, 10))
    fig.suptitle("Stabilization Quality Diagnostics", fontsize=16, fontweight="bold")

    transitions = diagnostics["transitions"]
    labels = [f"{a}->{b}" for a, b in transitions]
    x_pos = range(len(labels))

    # -- Panel 1: RMSE before vs after --
    ax = axes[0, 0]
    rmse_b = diagnostics["rmse_before"]
    rmse_a = diagnostics["rmse_after"]
    bar_w = 0.35
    ax.bar([x - bar_w / 2 for x in x_pos], rmse_b, bar_w,
           label="Before alignment", color="#e74c3c", alpha=0.8)
    ax.bar([x + bar_w / 2 for x in x_pos], rmse_a, bar_w,
           label="After alignment", color="#2ecc71", alpha=0.8)
    ax.set_xlabel("Transition")
    ax.set_ylabel("RMSE (um)")
    ax.set_title("RMSE of Reference Cells")
    ax.set_xticks(list(x_pos))
    ax.set_xticklabels(labels, rotation=45, ha="right")
    ax.legend()
    ax.grid(axis="y", alpha=0.3)

    # -- Panel 2: Max residual per transition --
    ax = axes[0, 1]
    max_res = diagnostics["max_residual_after"]
    colors = ["#2ecc71" if (r is not None and not np.isnan(r) and r < 30)
              else "#e74c3c" for r in max_res]
    ax.bar(x_pos, max_res, color=colors, alpha=0.8)
    ax.axhline(y=30, color="red", linestyle="--", alpha=0.5, label="Warning threshold (30um)")
    ax.set_xlabel("Transition")
    ax.set_ylabel("Max Residual (um)")
    ax.set_title("Max Residual After Alignment")
    ax.set_xticks(list(x_pos))
    ax.set_xticklabels(labels, rotation=45, ha="right")
    ax.legend()
    ax.grid(axis="y", alpha=0.3)

    # -- Panel 3: Number of reference cells used --
    ax = axes[1, 0]
    n_refs = diagnostics["n_refs_used"]
    ax.bar(x_pos, n_refs, color="#3498db", alpha=0.8)
    ax.set_xlabel("Transition")
    ax.set_ylabel("# Reference Cells")
    ax.set_title("Reference Cells Used Per Transition")
    ax.set_xticks(list(x_pos))
    ax.set_xticklabels(labels, rotation=45, ha="right")
    ax.grid(axis="y", alpha=0.3)

    # -- Panel 4: Distribution of per-cell mean residuals --
    ax = axes[1, 1]
    mean_residuals = []
    for cell, resids in diagnostics["per_cell_residuals"].items():
        if len(resids) > 0:
            mean_residuals.append(np.mean(resids))
    if mean_residuals:
        ax.hist(mean_residuals, bins=30, color="#9b59b6", alpha=0.8, edgecolor="white")
        median_val = np.median(mean_residuals)
        ax.axvline(x=median_val, color="#e74c3c", linestyle="--",
                   label=f"Median = {median_val:.2f}um")
    ax.set_xlabel("Mean Residual Per Cell (um)")
    ax.set_ylabel("# Reference Cells")
    ax.set_title("Distribution of Per-Cell Residuals")
    ax.legend()
    ax.grid(axis="y", alpha=0.3)

    plt.tight_layout()
    out_path = os.path.join(out_dir, "stabilization_diagnostics.png")
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  Saved: {out_path}")

    # Print summary verdict
    valid_rmse = [r for r in rmse_a if r is not None and not np.isnan(r)]
    if valid_rmse:
        overall_rmse = np.mean(valid_rmse)
        overall_max = max(r for r in max_res if r is not None and not np.isnan(r))
        print(f"  -- Stabilization summary --")
        print(f"     Mean RMSE after alignment: {overall_rmse:.2f} um")
        print(f"     Max residual:              {overall_max:.2f} um")
        if overall_rmse < 15 and overall_max < 40:
            print(f"     OK: Stabilization looks GOOD")
        elif overall_rmse < 30:
            print(f"     ~ Stabilization is ACCEPTABLE but noisy")
        else:
            print(f"     FAIL: Stabilization may be UNRELIABLE � check data")


# ---------------------------------------------
#  CELL METRICS
# ---------------------------------------------



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

    t_counts = df.groupby("unique_cell_id")["timepoint"].nunique()
    max_count = t_counts.max()

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

        records.append({
            "unique_cell_id": cid,
            "track_id": grp["track_id"].iloc[0],
            "region": grp["region"].iloc[0],
            "first_timepoint": float(first_tp),
            "first_z": float(coords[0, 2]),
            "path_length": path_length,
            "net_displacement": net_displacement,
            "straightness_index": straightness_index,
            "mean_velocity": mean_velocity,
            "max_velocity": max_velocity,
            "parent_cell": parent,
            "daughter_cells": daughters,
            "is_new_cell": is_new_cell,
        })

    metrics_df = pd.DataFrame(records)
    return metrics_df


def compute_neighbor_distances(df, assigner, coord_cols=("x_stab", "y_stab", "z_stab"), n_neighbors=3):
    """
    For each cell lineage, identify the N closest neighbors at first appearance,
    then track the distance to those same neighbors across all timepoints.

    Inheritance rules:
      - Mitosis: daughter cells inherit the mother's neighbors
      - Fusion: merged cell inherits all unique neighbors from both parents
        (excluding the parents themselves, since they no longer exist)

    Parameters
    ----------
    df : DataFrame with tracking data (must have unique_cell_id, timepoint, coords)
    assigner : CellIDAssigner with parent_map, daughter_map
    coord_cols : tuple of (x, y, z) column names to use
    n_neighbors : int, number of nearest neighbors to find at first appearance

    Returns
    -------
    dist_df : DataFrame — one row per (cell × timepoint), with distance to each neighbor
    summary_df : DataFrame — one row per cell, with neighbor IDs + summary stats
    """
    cx, cy, cz = coord_cols

    # --- Step 1: Build per-cell info ---
    # For each unique_cell_id: first timepoint, all timepoints, coordinates at each tp
    cell_info = {}  # cid -> {first_tp, timepoints: [sorted], coords: {tp: (x,y,z)}}
    for cid, grp in df.groupby("unique_cell_id"):
        grp = grp.sort_values("timepoint")
        tps = grp["timepoint"].values.tolist()
        coords_by_tp = {}
        for _, row in grp.iterrows():
            coords_by_tp[row["timepoint"]] = np.array([row[cx], row[cy], row[cz]])
        cell_info[cid] = {
            "first_tp": tps[0],
            "timepoints": tps,
            "coords": coords_by_tp,
            "region": grp["region"].iloc[0],
            "track_id": grp["track_id"].iloc[0],
        }

    # --- Step 2: Build snapshot lookup (tp -> list of active cell IDs) ---
    tp_to_cells = {}
    for cid, info in cell_info.items():
        for tp in info["timepoints"]:
            if tp not in tp_to_cells:
                tp_to_cells[tp] = []
            tp_to_cells[tp].append(cid)

    # --- Step 3: Assign initial neighbors ---
    # neighbor_map: cid -> list of neighbor cids (ordered by original distance)
    neighbor_map = {}
    inherited_from = {}  # cid -> parent cid (or "" if original)

    # Process cells in order of first appearance
    all_cids = sorted(cell_info.keys(), key=lambda c: (cell_info[c]["first_tp"], c))

    for cid in all_cids:
        info = cell_info[cid]
        first_tp = info["first_tp"]

        # Check for inheritance via mitosis or fusion
        parent = assigner.parent_map.get(cid, None)

        if parent is not None:
            # Determine parent cell ID(s)
            # parent can be an int (mitosis) or a string "id1/id2" (fusion)
            parent_str = str(parent)

            if "/" in parent_str:
                # Fusion: inherit from ALL parents
                parent_ids = [int(p) for p in parent_str.split("/")]
                merged_neighbors = []
                for pid in parent_ids:
                    if pid in neighbor_map:
                        merged_neighbors.extend(neighbor_map[pid])
                # Remove duplicates, and exclude the parent IDs themselves (they no longer exist)
                seen = set()
                unique_neighbors = []
                for n in merged_neighbors:
                    if n not in seen and n not in parent_ids and n != cid:
                        unique_neighbors.append(n)
                        seen.add(n)
                neighbor_map[cid] = unique_neighbors
                inherited_from[cid] = parent_str
            else:
                # Mitosis: inherit from single parent
                parent_id = int(parent_str)
                if parent_id in neighbor_map:
                    # Copy parent's neighbors, excluding self and sibling(s)
                    # (siblings are other daughters of the same parent)
                    siblings = set(assigner.daughter_map.get(parent_id, []))
                    neighbor_map[cid] = [
                        n for n in neighbor_map[parent_id]
                        if n != cid and n not in siblings
                    ]
                    # If we lost neighbors (because siblings were in the list), try to
                    # top up from the current snapshot
                    if len(neighbor_map[cid]) < n_neighbors:
                        active_cells = tp_to_cells.get(first_tp, [])
                        exclude = set(neighbor_map[cid]) | {cid} | siblings
                        candidates = [
                            c for c in active_cells
                            if c not in exclude and first_tp in cell_info[c]["coords"]
                        ]
                        if candidates and first_tp in info["coords"]:
                            pos = info["coords"][first_tp]
                            dists = [
                                (euclidean_distance(pos, cell_info[c]["coords"][first_tp]), c)
                                for c in candidates
                            ]
                            dists.sort()
                            needed = n_neighbors - len(neighbor_map[cid])
                            neighbor_map[cid].extend([c for _, c in dists[:needed]])
                else:
                    neighbor_map[cid] = []
                inherited_from[cid] = parent_str
        else:
            # No parent: compute neighbors from scratch
            inherited_from[cid] = ""
            active_cells = tp_to_cells.get(first_tp, [])
            candidates = [c for c in active_cells if c != cid and first_tp in cell_info[c]["coords"]]

            if len(candidates) == 0 or first_tp not in info["coords"]:
                neighbor_map[cid] = []
                continue

            pos = info["coords"][first_tp]
            dists = [
                (euclidean_distance(pos, cell_info[c]["coords"][first_tp]), c)
                for c in candidates
            ]
            dists.sort()
            neighbor_map[cid] = [c for _, c in dists[:n_neighbors]]

    # --- Step 3b: Evolve neighbor lists when neighbors undergo mitosis or fusion ---
    # Build reverse lineage lookups:
    #   parent_to_daughters: parent_id -> [daughter_ids]  (mitosis: parent splits)
    #   parents_to_merged: frozenset({parent_ids}) -> merged_id  (fusion: parents merge)
    parent_to_daughters = {}  # int -> list[int]
    fusion_events = []  # list of (merged_id, set_of_parent_ids, first_tp_of_merged)

    for child_id, parent_val in assigner.parent_map.items():
        parent_str = str(parent_val)
        if "/" in parent_str:
            # Fusion event
            parent_ids = set(int(p) for p in parent_str.split("/"))
            if child_id in cell_info:
                fusion_events.append((child_id, parent_ids, cell_info[child_id]["first_tp"]))
        else:
            # Mitosis event
            parent_id = int(parent_str)
            if parent_id not in parent_to_daughters:
                parent_to_daughters[parent_id] = []
            parent_to_daughters[parent_id].append(child_id)

    # For each cell, build a per-timepoint neighbor list that evolves.
    # Start from neighbor_map[cid] (the initial/inherited set), then at each tp
    # check if any neighbor has died and been replaced by daughters or merged.
    # We precompute: for each cell that undergoes mitosis, the timepoint it happens
    # (= the first_tp of its daughters) and for fusion likewise.

    # last_tp_of_cell: the last timepoint a cell is alive
    last_tp = {}
    for cid_n, info_n in cell_info.items():
        last_tp[cid_n] = info_n["timepoints"][-1] if info_n["timepoints"] else -1

    # mitosis_at: parent_id -> timepoint when it divides (= first_tp of daughters)
    mitosis_at = {}
    for parent_id, daughters in parent_to_daughters.items():
        if daughters and daughters[0] in cell_info:
            mitosis_at[parent_id] = cell_info[daughters[0]]["first_tp"]

    # fusion_at: frozenset of parent_ids -> (merged_id, timepoint)
    fusion_lookup = {}
    for merged_id, parent_ids, merged_first_tp in fusion_events:
        fusion_lookup[frozenset(parent_ids)] = (merged_id, merged_first_tp)

    def evolve_neighbors_for_cell(cid):
        """
        Return a dict: timepoint -> list of neighbor IDs active at that timepoint.
        Starts from neighbor_map[cid] and evolves as neighbors undergo mitosis/fusion.
        """
        base_neighbors = list(neighbor_map.get(cid, []))
        if not base_neighbors:
            return {}

        info = cell_info[cid]
        current_set = list(base_neighbors)  # mutable working copy
        tp_neighbors = {}

        for tp in info["timepoints"]:
            # Check for mitosis of any current neighbor
            new_set = []
            for n in current_set:
                if n in mitosis_at and mitosis_at[n] == tp:
                    # This neighbor just divided — replace with both daughters
                    daughters = parent_to_daughters[n]
                    for d in daughters:
                        if d != cid:  # don't add self as own neighbor
                            new_set.append(d)
                else:
                    new_set.append(n)

            # Check for fusion of any pair of current neighbors
            # If two neighbors merged, replace both with the merged cell
            merged_replacements = {}  # neighbor_id -> merged_id (or None to remove)
            current_set_ids = set(new_set)
            for key, (merged_id, merge_tp) in fusion_lookup.items():
                if merge_tp == tp:
                    # Check if any of the fusing parents are in our neighbor set
                    overlap = key & current_set_ids
                    if len(overlap) >= 1:
                        # Replace all overlapping parents with the merged cell
                        for parent_id in overlap:
                            merged_replacements[parent_id] = merged_id

            if merged_replacements:
                final_set = []
                added_merged = set()
                for n in new_set:
                    if n in merged_replacements:
                        m = merged_replacements[n]
                        if m not in added_merged and m != cid:
                            final_set.append(m)
                            added_merged.add(m)
                    else:
                        final_set.append(n)
                new_set = final_set

            current_set = new_set
            tp_neighbors[tp] = list(current_set)

        return tp_neighbors

    # --- Step 4: Compute distances over time using evolved neighbor lists ---
    dist_records = []
    summary_records = []

    for cid in all_cids:
        info = cell_info[cid]
        initial_neighbors = neighbor_map.get(cid, [])

        if not initial_neighbors:
            summary_records.append({
                "unique_cell_id": cid,
                "track_id": info["track_id"],
                "region": info["region"],
                "n_initial_neighbors": 0,
                "initial_neighbor_ids": "",
                "inherited_from": inherited_from.get(cid, ""),
                "mean_dist_all_neighbors": np.nan,
                "max_dist_all_neighbors": np.nan,
            })
            continue

        tp_neighbors = evolve_neighbors_for_cell(cid)

        # Collect all neighbor IDs ever tracked (for column generation)
        all_neighbor_ids_ever = []
        seen_n = set()
        for tp_list in tp_neighbors.values():
            for n in tp_list:
                if n not in seen_n:
                    all_neighbor_ids_ever.append(n)
                    seen_n.add(n)

        # Per-neighbor distance timeseries
        all_dists_flat = []
        per_neighbor_dists = {n: [] for n in all_neighbor_ids_ever}

        for tp in info["timepoints"]:
            if tp not in info["coords"]:
                continue
            pos = info["coords"][tp]
            neighbors_at_tp = tp_neighbors.get(tp, [])

            row = {
                "unique_cell_id": cid,
                "timepoint": tp,
            }
            for i, n in enumerate(neighbors_at_tp):
                col_id = f"neighbor_{i+1}_id"
                col_dist = f"dist_to_N{i+1}"
                row[col_id] = n

                if n in cell_info and tp in cell_info[n]["coords"]:
                    d = euclidean_distance(pos, cell_info[n]["coords"][tp])
                    row[col_dist] = round(d, 3)
                    all_dists_flat.append(d)
                    per_neighbor_dists[n].append(d)
                else:
                    row[col_dist] = np.nan

            dist_records.append(row)

        # Summary
        summary_row = {
            "unique_cell_id": cid,
            "track_id": info["track_id"],
            "region": info["region"],
            "n_initial_neighbors": len(initial_neighbors),
            "initial_neighbor_ids": ", ".join(str(n) for n in initial_neighbors),
            "final_neighbor_ids": ", ".join(str(n) for n in (tp_neighbors[info["timepoints"][-1]] if info["timepoints"][-1] in tp_neighbors else [])),
            "inherited_from": inherited_from.get(cid, ""),
            "mean_dist_all_neighbors": round(float(np.nanmean(all_dists_flat)), 3) if all_dists_flat else np.nan,
            "max_dist_all_neighbors": round(float(np.nanmax(all_dists_flat)), 3) if all_dists_flat else np.nan,
        }
        # Per-neighbor summary (using all_neighbor_ids_ever for stable columns)
        for i, n in enumerate(all_neighbor_ids_ever):
            nd = per_neighbor_dists[n]
            summary_row[f"neighbor_{i+1}_id"] = n
            summary_row[f"mean_dist_N{i+1}"] = round(float(np.mean(nd)), 3) if nd else np.nan
            summary_row[f"max_dist_N{i+1}"] = round(float(np.max(nd)), 3) if nd else np.nan

        summary_records.append(summary_row)

    dist_df = pd.DataFrame(dist_records)
    summary_df = pd.DataFrame(summary_records)

    print(f"  Neighbor tracking: {len(neighbor_map)} cells tracked, "
          f"max {max(len(v) for v in neighbor_map.values()) if neighbor_map else 0} initial neighbors")

    return dist_df, summary_df


# ---------------------------------------------
#  EMBRYO SURFACE RECONSTRUCTION
# ---------------------------------------------

from scipy.interpolate import LinearNDInterpolator
from scipy.spatial import cKDTree, Delaunay


from surface_reconstruction import build_all_timepoints

def _build_viewer_dense_timepoints(raw_timepoints, smooth_steps):
    """
    Reproduit la logique du viewer pour la timeline interpolée.
    """
    raw_timepoints = sorted(float(tp) for tp in raw_timepoints)
    if smooth_steps <= 1 or len(raw_timepoints) <= 1:
        return [round(tp, 2) for tp in raw_timepoints]

    gaps = [raw_timepoints[i + 1] - raw_timepoints[i] for i in range(len(raw_timepoints) - 1)]
    gaps.sort()
    median_gap = gaps[len(gaps) // 2] if gaps else 1.0

    dense_tps = []
    for i in range(len(raw_timepoints) - 1):
        t0 = raw_timepoints[i]
        t1 = raw_timepoints[i + 1]
        dense_tps.append(round(t0, 2))
        diff = t1 - t0
        if diff < median_gap * 1.5 and diff > median_gap * 0.5:
            for s in range(1, smooth_steps):
                dense_tps.append(round(t0 + (diff * (s / smooth_steps)), 2))
    dense_tps.append(round(raw_timepoints[-1], 2))
    return dense_tps


def _build_surface_point_clouds(df, coord_cols, smooth_steps=1, allow_track_gaps=False):
    """
    Construit les nuages par timepoint pour les surfaces.

    `allow_track_gaps=False` :
      - strict raw, uniquement les positions réellement mesurées.

    `allow_track_gaps=True` :
      - mode viewer smooth, interpolation cellule par cellule entre deux
        observations successives d'une même cellule, même s'il manque des
        frames brutes intermédiaires.
    """
    cx, cy, cz = coord_cols
    raw_timepoints = sorted(float(tp) for tp in df["timepoint"].unique())

    if not allow_track_gaps:
        point_clouds = {}
        for tp in raw_timepoints:
            points = df[df["timepoint"] == tp][[cx, cy, cz]].values
            if len(points) >= 4:
                point_clouds[round(tp, 2)] = points
        return point_clouds

    target_tps = _build_viewer_dense_timepoints(raw_timepoints, smooth_steps=smooth_steps)
    point_clouds = {tp: [] for tp in target_tps}
    eps = 1e-6

    for _, grp in df.groupby("unique_cell_id"):
        grp = grp.sort_values("timepoint")
        ts = grp["timepoint"].astype(float).to_numpy()
        coords = grp[[cx, cy, cz]].to_numpy(dtype=float)

        if len(ts) == 0:
            continue

        for target_tp in target_tps:
            idx = np.searchsorted(ts, target_tp)

            if idx < len(ts) and abs(ts[idx] - target_tp) < eps:
                point_clouds[target_tp].append(coords[idx])
                continue

            if idx == 0 or idx >= len(ts):
                continue

            t0, t1 = ts[idx - 1], ts[idx]
            if not (t0 + eps < target_tp < t1 - eps):
                continue

            frac = (target_tp - t0) / (t1 - t0)
            interp = coords[idx - 1] * (1.0 - frac) + coords[idx] * frac
            point_clouds[target_tp].append(interp)

    return {
        round(tp, 2): np.asarray(points, dtype=float)
        for tp, points in point_clouds.items()
        if len(points) >= 4
    }


def compute_embryo_surfaces(df, smooth_steps=10):
    """
    Compute embryo surface meshes for all timepoints, both coordinate systems.
    Exporte deux variantes :
      - raw/stab : strictement sur les points mesurés aux frames brutes
      - raw_interp/stab_interp : version dense alignée avec le slider smooth du viewer
    """
    coord_systems = {
        "stab": ("x_stab", "y_stab", "z_stab"),
        "raw": ("x", "y", "z"),
    }
    
    surface_data = {}
    
    for cs_name, (cx, cy, cz) in coord_systems.items():
        print(f"\n--- Constructing {cs_name.upper()} meshes ---")

        raw_point_clouds = _build_surface_point_clouds(
            df,
            coord_cols=(cx, cy, cz),
            smooth_steps=1,
            allow_track_gaps=False,
        )
        interp_point_clouds = _build_surface_point_clouds(
            df,
            coord_cols=(cx, cy, cz),
            smooth_steps=smooth_steps,
            allow_track_gaps=True,
        )

        surface_data[cs_name] = build_all_timepoints(
            points_by_tp=raw_point_clouds,
            k_surface=15,
            surface_fraction=None,
            alpha_factor=4.0,
            k_density=6,
            verbose=False
        )
        surface_data[f"{cs_name}_interp"] = build_all_timepoints(
            points_by_tp=interp_point_clouds,
            k_surface=15,
            surface_fraction=None,
            alpha_factor=4.0,
            k_density=6,
            verbose=False
        )
        
    return surface_data


# ---------------------------------------------
#  3D VIDEO RENDERING
# ---------------------------------------------

# Curated color palette for regions
REGION_PALETTE = [
    "#e74c3c",  # red
    "#3498db",  # blue
    "#2ecc71",  # green
    "#f39c12",  # orange
    "#9b59b6",  # purple
    "#1abc9c",  # teal
    "#e67e22",  # dark orange
    "#34495e",  # dark grey-blue
    "#e84393",  # pink
    "#00cec9",  # cyan
]


def interpolate_dataframe(df, steps_per_interval=10):
    """
    Creates a dense dataframe with linearly interpolated positions between timepoints.
    steps_per_interval=10 means 1 real frame, 9 interpolated frames.
    """
    dense_rows = []
    tps = sorted(df["timepoint"].unique())
    coords = ["x", "y", "z", "x_stab", "y_stab", "z_stab"]
    
    for i in range(len(tps) - 1):
        t0 = tps[i]
        t1 = tps[i+1]
        
        df0 = df[df["timepoint"] == t0].set_index("unique_cell_id")
        df1 = df[df["timepoint"] == t1].set_index("unique_cell_id")
        
        # Cells present in both frames
        common = df0.index.intersection(df1.index)
        
        for step in range(steps_per_interval):
            frac = step / float(steps_per_interval)
            current_tp = t0 + frac
            
            if step == 0:
                current_df = df0.copy()
            else:
                current_df = df0.loc[common].copy()
                for c in coords:
                    current_df[c] = df0.loc[common, c] * (1 - frac) + df1.loc[common, c] * frac
                
                # Copy marker colors ONLY if at step 0, else clear them (we only mark the exact end frame)
                # Actually, during interpolation the user said "la dernière frame avant qu'elle disparaisse"
                # If we interpolate, the line continues until t=t0+0.9. It should remain marked during the whole transit from t0 to t1.
                if "marker_color" in current_df.columns:
                    current_df["marker_color"] = df0.loc[common, "marker_color"]
                    
            current_df["timepoint"] = current_tp
            current_df = current_df.reset_index()
            dense_rows.append(current_df)
            
    # Add the final timepoint
    last_tp = tps[-1]
    df_last = df[df["timepoint"] == last_tp].copy()
    df_last["timepoint"] = float(last_tp)
    dense_rows.append(df_last)
    
    return pd.concat(dense_rows, ignore_index=True)


def _pad_and_save_video(frames, video_path, fps):
    """Pad frames to uniform size (divisible by 16) and save as MP4."""
    max_h = max(f.shape[0] for f in frames)
    max_w = max(f.shape[1] for f in frames)
    new_h = ((max_h + 15) // 16) * 16
    new_w = ((max_w + 15) // 16) * 16
    padded = []
    for frame in frames:
        fh, fw = frame.shape[:2]
        p = np.full((new_h, new_w, frame.shape[2]), 255, dtype=frame.dtype)
        p[:fh, :fw] = frame
        padded.append(p)
    imageio.mimwrite(video_path, padded, fps=fps, quality=8)


def _render_frames(df, timepoints, regions, region_colors,
                   plot_x, plot_y, plot_z,
                   xlim, ylim, zlim,
                   elev, azim,
                   rotations_per_tp=None,
                   title=None):
    """
    Render one frame per timepoint. Returns list of image arrays.

    plot_x/y/z : column names (str) or tuples (col_name, sign) to use for each mpl axis.
                 If sign is -1, the column values are negated.
    rotations_per_tp : dict {tp: (rx, ry, rz)} with cumulative Euler angles (degrees),
                       or None to skip rotation annotations.
    title : optional title string displayed at top of each frame.
    """
    frames = []

    def _get_col(g, spec):
        if isinstance(spec, tuple):
            col, sign = spec
            return g[col] * sign
        return g[spec]



    # Precompute trajectories: for each unique_cell_id, store sorted list of
    # (timepoint, x, y, z) using the plot axis specs, plus region for color
    trajectories = {}
    for cid, grp in df.groupby("unique_cell_id"):
        grp = grp.sort_values("timepoint")
        traj = []
        for _, row in grp.iterrows():
            px = -row[plot_x[0]] if isinstance(plot_x, tuple) and plot_x[1] == -1 else row[plot_x if isinstance(plot_x, str) else plot_x[0]]
            py = -row[plot_y[0]] if isinstance(plot_y, tuple) and plot_y[1] == -1 else row[plot_y if isinstance(plot_y, str) else plot_y[0]]
            pz = -row[plot_z[0]] if isinstance(plot_z, tuple) and plot_z[1] == -1 else row[plot_z if isinstance(plot_z, str) else plot_z[0]]
            traj.append((row["timepoint"], px, py, pz))
        region = grp["region"].iloc[0]
        trajectories[cid] = (region, traj)

    for tp in timepoints:
        g = df[df["timepoint"] == tp]

        fig = plt.figure(figsize=(12, 10), facecolor="white")
        ax = fig.add_subplot(111, projection="3d", facecolor="white")

        # Draw trajectory trail lines (up to current timepoint)
        for cid, (region, traj) in trajectories.items():
            # Filter trajectory points up to current tp
            pts = [(x, y, z) for t, x, y, z in traj if t <= tp]
            if len(pts) >= 2:
                xs, ys, zs = zip(*pts)
                ax.plot(xs, ys, zs,
                        color=region_colors[region],
                        linewidth=0.8, alpha=0.5)

        # Scatter current timepoint points (on top of trails)
        for region in regions:
            rg = g[g["region"] == region]
            if len(rg) == 0:
                continue
                
            # Default styling
            colors = [region_colors[region]] * len(rg)
            sizes = [30] * len(rg)
            edgecolors = ["white"] * len(rg)
            linewidths = [0.3] * len(rg)
            
            if "marker_color" in rg.columns:
                for i, c in enumerate(rg["marker_color"]):
                    if c == "red":
                        colors[i] = "#ff0000"
                        sizes[i] = 90
                        edgecolors[i] = "#880000"
                        linewidths[i] = 1.0
                    elif c == "black":
                        colors[i] = "#000000"
                        sizes[i] = 90
                        edgecolors[i] = "white"
                        linewidths[i] = 1.0

            ax.scatter(
                _get_col(rg, plot_x),
                _get_col(rg, plot_y),
                _get_col(rg, plot_z),
                c=colors,
                s=sizes, alpha=0.9,
                label=region, edgecolors=edgecolors, linewidths=linewidths
            )

        ax.set_xlim(xlim)
        ax.set_ylim(ylim)
        ax.set_zlim(zlim)

        # Setup native 3D grid and axes
        def _get_label(spec):
            return spec[0].upper() if isinstance(spec, tuple) else spec.upper()

        ax.set_xlabel(_get_label(plot_x), fontweight="bold", labelpad=10)
        ax.set_ylabel(_get_label(plot_y), fontweight="bold", labelpad=10)
        ax.set_zlabel(_get_label(plot_z), fontweight="bold", labelpad=10)

        # Clean but visible grid
        ax.xaxis.pane.fill = False
        ax.yaxis.pane.fill = False
        ax.zaxis.pane.fill = False
        ax.xaxis.pane.set_edgecolor('#e0e0e0')
        ax.yaxis.pane.set_edgecolor('#e0e0e0')
        ax.zaxis.pane.set_edgecolor('#e0e0e0')
        ax.grid(True, linestyle='--', color='#cccccc', alpha=0.6)

        # Title (for comparison panels)
        if title:
            fig.text(0.5, 0.95, title, fontsize=16, fontweight="bold",
                     ha="center", va="top", color="#333333")

        # Timepoint indicator (top-right)
        is_real = tp.is_integer() if isinstance(tp, float) else True
        data_tag = "REAL DATA" if is_real else "INTERPOLATED"
        tag_color = "#34495e" if is_real else "#f39c12"
        fig.text(0.85, 0.05, f"t = {tp:.1f}\n{data_tag}", fontsize=14, fontweight="bold",
                 ha="center", va="center", color=tag_color)

        # Rotation angles annotation (bottom-left)
        if rotations_per_tp:
            t_floor = int(np.floor(tp))
            if t_floor in rotations_per_tp:
                rx, ry, rz = rotations_per_tp[t_floor]
                rot_text = (f"Stabilization rotation (cumul.)\n"
                            f"  Rx = {rx:+.1f}\n"
                            f"  Ry = {ry:+.1f}\n"
                            f"  Rz = {rz:+.1f}")
                fig.text(0.03, 0.05, rot_text, fontsize=9,
                         ha="left", va="bottom", color="#555555",
                         fontfamily="monospace",
                         bbox=dict(boxstyle="round,pad=0.4", facecolor="white",
                                   edgecolor="#cccccc", alpha=0.9))

        # Legend
        ax.legend(loc="upper left", fontsize=9, framealpha=0.9,
                  markerscale=1.5, borderpad=0.8)

        ax.view_init(elev=elev, azim=azim)

        # Render to buffer
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=200,
                    facecolor="white", edgecolor="none")
        plt.close(fig)
        buf.seek(0)
        frames.append(imageio.imread(buf))
        buf.close()

        print(f"    Frame tp{tp} rendered")

    return frames


def render_3d_videos(df, out_dir, diagnostics, fps=1):
    """
    Generate two 3D scatter videos of stabilized coordinates:
      1. stabilized_raw_video.mp4          - default 3D view
      2. stabilized_bottom_view_video.mp4  - view from below, rotated 40 deg CW
    """
    df = df.copy()
    if "region" in df.columns:
        df["region"] = normalize_region_series(df["region"])
    else:
        df["region"] = "Unknown"

    timepoints = sorted(df["timepoint"].unique())
    regions = sorted(df["region"].unique(), key=str)
    region_colors = {r: REGION_PALETTE[i % len(REGION_PALETTE)] for i, r in enumerate(regions)}

    margin = 30
    x_min, x_max = df["x_stab"].min() - margin, df["x_stab"].max() + margin
    y_min, y_max = df["y_stab"].min() - margin, df["y_stab"].max() + margin
    z_min, z_max = df["z_stab"].min() - margin, df["z_stab"].max() + margin

    rot_data = diagnostics.get("rotations_per_tp", None)

    # --- Video 1: Raw stabilized coordinates (default view) ---
    print(f"  Rendering raw stabilized video ({len(timepoints)} frames)...")
    frames_raw = _render_frames(
        df, timepoints, regions, region_colors,
        plot_x="x_stab", plot_y="y_stab", plot_z="z_stab",
        xlim=(x_min, x_max), ylim=(y_min, y_max), zlim=(z_min, z_max),
        elev=25, azim=-60,
        rotations_per_tp=rot_data
    )
    raw_path = os.path.join(out_dir, "stabilized_raw_video.mp4")
    _pad_and_save_video(frames_raw, raw_path, fps)
    print(f"  Saved: {raw_path}")

    # --- Video 2: View from below, rotated 40 deg clockwise ---
    print(f"  Rendering bottom-view video ({len(timepoints)} frames)...")
    frames_bot = _render_frames(
        df, timepoints, regions, region_colors,
        plot_x="x_stab", plot_y="y_stab", plot_z="z_stab",
        xlim=(x_min, x_max), ylim=(y_min, y_max), zlim=(z_min, z_max),
        elev=-70, azim=-100,
        rotations_per_tp=rot_data
    )
    bot_path = os.path.join(out_dir, "stabilized_bottom_view_video.mp4")
    _pad_and_save_video(frames_bot, bot_path, fps)
    print(f"  Saved: {bot_path}")

    # --- Video 3: Side-by-side comparison (stabilized vs raw) ---
    # Use shared axis limits that encompass both raw and stabilized ranges
    all_x = np.concatenate([df["x_stab"].values, df["x"].values])
    all_y = np.concatenate([df["y_stab"].values, df["y"].values])
    all_z = np.concatenate([df["z_stab"].values, df["z"].values])
    shared_xlim = (all_x.min() - margin, all_x.max() + margin)
    shared_ylim = (all_y.min() - margin, all_y.max() + margin)
    shared_zlim = (all_z.min() - margin, all_z.max() + margin)

    print(f"  Rendering comparison video ({len(timepoints)} frames)...")
    # Left: stabilized
    frames_stab = _render_frames(
        df, timepoints, regions, region_colors,
        plot_x="x_stab", plot_y="y_stab", plot_z="z_stab",
        xlim=shared_xlim, ylim=shared_ylim, zlim=shared_zlim,
        elev=-70, azim=-100,
        rotations_per_tp=rot_data,
        title="STABILIZED"
    )
    # Right: raw (not stabilized)
    print(f"  Rendering raw comparison panels ({len(timepoints)} frames)...")
    frames_not_stab# ---------------------------------------------
#  EXPORT ORCHESTRATOR
# ---------------------------------------------

def package_and_export(df, out_dir, diagnostics=None, neighbor_dist_df=None, neighbor_summary_df=None, surface_data=None):
    """
    Exports the cell metrics and unique identifiers straightforwardly to a standalone 
    compressed dataset `.imaris_track` for the Universal HTML Viewer.
    """
    sample_name = os.path.basename(out_dir.rstrip(os.sep))
    
    # Export Universal App Compressed Data Payload
    export_imaris_track(df, out_dir, sample_name, out_filename=f"{sample_name}.imaris_track",
                        surface_data=surface_data)


# ---------------------------------------------
#  OUTPUT
# ---------------------------------------------

def create_output_dir(sample_name):
    """Create output directory: OUTPUT/YY.MM.DD-HH.MM/<SAMPLE>/"""
    timestamp = datetime.now().strftime("%y.%m.%d-%H.%M")
    out_dir = os.path.join(OUTPUT_ROOT, timestamp, sample_name)
    os.makedirs(out_dir, exist_ok=True)
    return out_dir


# ---------------------------------------------
#  EXTENDED METRICS
# ---------------------------------------------

def compute_directionality(df, coord_cols=("x_stab", "y_stab", "z_stab")):
    """Compute direction directionality (start -> end) for each unique cell."""
    x_col, y_col, z_col = coord_cols
    
    # Sort by timepoint to ensure first and last are correct
    df = df.sort_values(by=["unique_cell_id", "timepoint"])
    
    first_tp = df.groupby("unique_cell_id").first().reset_index()
    last_tp = df.groupby("unique_cell_id").last().reset_index()
    
    metrics = pd.DataFrame({
        "unique_cell_id": first_tp["unique_cell_id"],
        "track_id": first_tp["track_id"],
        "region": first_tp["region"],
        "tp_start": first_tp["timepoint"],
        "tp_end": last_tp["timepoint"],
        "x_start": first_tp[x_col],
        "y_start": first_tp[y_col],
        "z_start": first_tp[z_col],
        "x_end": last_tp[x_col],
        "y_end": last_tp[y_col],
        "z_end": last_tp[z_col],
    })
    
    metrics["dx"] = metrics["x_end"] - metrics["x_start"]
    metrics["dy"] = metrics["y_end"] - metrics["y_start"]
    metrics["dz"] = metrics["z_end"] - metrics["z_start"]
    
    def get_sign(val):
        if val > 1e-4: return "+"
        elif val < -1e-4: return "-"
        return "0"
        
    metrics["dir_x"] = metrics["dx"].apply(get_sign)
    metrics["dir_y"] = metrics["dy"].apply(get_sign)
    metrics["dir_z"] = metrics["dz"].apply(get_sign)
    
    metrics["azimuth_theta_deg"] = np.degrees(np.arctan2(metrics["dy"], metrics["dx"]))
    hypot_xy = np.hypot(metrics["dx"], metrics["dy"])
    metrics["elevation_phi_deg"] = np.degrees(np.arctan2(metrics["dz"], hypot_xy))
    
    return metrics


def compute_population_stats(df, assigner):
    """Compute population dynamics per region through time."""
    # 2. Mitosis per region through time
    # Mitosis markers: set of (tp, parent_cid) where division happened
    def is_mitosis(row):
        return (row["timepoint"], row["unique_cell_id"]) in assigner.mitosis_markers
        
    mitosis_rows = df[df.apply(is_mitosis, axis=1)]
    if not mitosis_rows.empty:
        mitosis_pivot = pd.crosstab(mitosis_rows["region"], mitosis_rows["timepoint"])
        mitosis_pivot["Total Mitosis"] = mitosis_pivot.sum(axis=1)
    else:
        mitosis_pivot = pd.DataFrame()

    # 3. New cells appearing
    # A cell appears at its first timepoint.
    first_tp_df = df.groupby("unique_cell_id").first().reset_index()
    new_cells_pivot = pd.crosstab(first_tp_df["region"], first_tp_df["timepoint"])
    new_cells_pivot["Total New Cells"] = new_cells_pivot.sum(axis=1)
    
    # 4. New cells (excluding mitosis daughters)
    # parent_cell is None, NaN or empty for non-mitosis daughters
    no_mitosis_df = first_tp_df[first_tp_df["parent_cell"].isna() | (first_tp_df["parent_cell"] == "")]
    if not no_mitosis_df.empty:
        new_cells_no_mitosis_pivot = pd.crosstab(no_mitosis_df["region"], no_mitosis_df["timepoint"])
        new_cells_no_mitosis_pivot["Total (No Mitosis)"] = new_cells_no_mitosis_pivot.sum(axis=1)
    else:
        new_cells_no_mitosis_pivot = pd.DataFrame()
        
    return mitosis_pivot, new_cells_pivot, new_cells_no_mitosis_pivot

# ---------------------------------------------
#  MAIN PIPELINE
# ---------------------------------------------


def process_sample(sample_dir, sample_name, time_interval_min=1.0):
    """Process one sample: read data, assign IDs, compute metrics, save CSVs."""

    # Find Excel file(s) in the sample directory (ignore temp files)
    xlsx_files = [
        f for f in glob.glob(os.path.join(sample_dir, "*.xlsx"))
        if not os.path.basename(f).startswith("~$")
    ]

    if not xlsx_files:
        print(f"  [WARNING] No .xlsx file found in {sample_dir}, skipping.")
        return None

    if len(xlsx_files) > 1:
        print(f"  [WARNING] Multiple .xlsx files in {sample_dir}, using first: {xlsx_files[0]}")

    input_file = xlsx_files[0]
    print(f"  Reading: {input_file}")

    df = pd.read_excel(input_file)
    try:
        df = standardize_input_dataframe(df, sample_name=sample_name)
    except ValueError as exc:
        print(f"  [ERROR] {exc}")
        return None
    df = assign_synthetic_track_ids(df)

    # Validate expected columns
    required_cols = {"track_id", "cell_id", "timepoint", "x", "y", "z", "region"}
    missing = required_cols - set(df.columns)
    if missing:
        print(f"  [ERROR] Missing columns after normalization: {missing}")
        return None

    print(f"  Data: {len(df)} rows, {df['track_id'].nunique()} tracks, "
          f"{df['timepoint'].nunique()} timepoints")

    # Assign cell IDs
    assigner = CellIDAssigner()
    result = assigner.assign_ids(df)

    # Summary stats
    n_cells = result["unique_cell_id"].nunique()
    n_mitosis = len(assigner.daughter_map)
    print(f"  Assigned {n_cells} unique cell IDs, detected {n_mitosis} mitosis events")

    # Decorate DataFrame with event markers
    result["marker_color"] = ""
    for (tp, cid) in assigner.mitosis_markers:
        result.loc[(result["timepoint"] == tp) & (result["unique_cell_id"] == cid), "marker_color"] = "red"
    for (tp, cid) in assigner.fusion_markers:
        result.loc[(result["timepoint"] == tp) & (result["unique_cell_id"] == cid), "marker_color"] = "black"

    # Stabilize coordinates
    print("  Stabilizing coordinates (Kabsch/SVD)...")
    result, diagnostics = stabilize_coordinates(result, assigner)



    # Compute per-cell metrics (raw coordinates)
    metrics_raw = compute_metrics(result, assigner, coord_cols=("x", "y", "z"), time_interval_min=time_interval_min)
    print(f"  Computed metrics for {len(metrics_raw)} cells (raw coords, dt={time_interval_min} min)")

    # Compute per-cell metrics (stabilized coordinates)
    metrics_stab = compute_metrics(result, assigner, coord_cols=("x_stab", "y_stab", "z_stab"), time_interval_min=time_interval_min)
    print(f"  Computed metrics for {len(metrics_stab)} cells (stabilized coords, dt={time_interval_min} min)")

    # Compute neighbor distances (using stabilized coordinates)
    print("  Computing neighbor distances...")
    neighbor_dist_df, neighbor_summary_df = compute_neighbor_distances(
        result, assigner, coord_cols=("x_stab", "y_stab", "z_stab"), n_neighbors=3
    )

    # Compute embryo surface meshes
    print("  Computing embryo surface meshes...")
    surface_data = compute_embryo_surfaces(result)

    # Save outputs
    out_dir = create_output_dir(sample_name)

    # --- Excel Workbook with all analysis sheets ---
    tracking_cols = [
        "track_id", "cell_id", "timepoint",
        "x", "y", "z", "region",
        "unique_cell_id", "parent_cell", "daughter_cells"
    ]
    tracking_stab_cols = [
        "track_id", "cell_id", "timepoint",
        "x_stab", "y_stab", "z_stab", "region",
        "unique_cell_id", "parent_cell", "daughter_cells"
    ]
    metrics_cols = [
        "unique_cell_id", "track_id", "region",
        "path_length", "net_displacement", "straightness_index",
        "mean_velocity", "max_velocity",
        "parent_cell", "daughter_cells"
    ]

    xlsx_path = os.path.join(out_dir, f"{sample_name}_analysis.xlsx")
    with pd.ExcelWriter(xlsx_path, engine="openpyxl") as writer:
        result[tracking_cols].to_excel(writer, sheet_name="Tracking (raw)", index=False)
        result[tracking_stab_cols].to_excel(writer, sheet_name="Tracking (stabilized)", index=False)
        metrics_raw[metrics_cols].to_excel(writer, sheet_name="Metrics (raw)", index=False)
        metrics_stab[metrics_cols].to_excel(writer, sheet_name="Metrics (stabilized)", index=False)
        if not neighbor_dist_df.empty:
            neighbor_dist_df.to_excel(writer, sheet_name="Neighbor Distances", index=False)
        if not neighbor_summary_df.empty:
            neighbor_summary_df.to_excel(writer, sheet_name="Neighbor Summary", index=False)
        
        # New tabs
        print("  Computing directionality and population stats...")
        directionality_df = compute_directionality(result, coord_cols=("x_stab", "y_stab", "z_stab"))
        directionality_df.to_excel(writer, sheet_name="Directionality", index=False)
        
        mitosis_pivot, new_cells_pivot, no_mito_pivot = compute_population_stats(result, assigner)
        
        # Combine population stats into one sheet with spacing
        pop_sheet_name = "Population Stats"
        start_row = 0
        if not mitosis_pivot.empty:
            pd.DataFrame([["Mitosis per region through time"]]).to_excel(writer, sheet_name=pop_sheet_name, startrow=start_row, startcol=0, header=False, index=False)
            mitosis_pivot.to_excel(writer, sheet_name=pop_sheet_name, startrow=start_row+1)
            start_row += len(mitosis_pivot) + 4
            
        if not new_cells_pivot.empty:
            pd.DataFrame([["New cells appearing through time per region"]]).to_excel(writer, sheet_name=pop_sheet_name, startrow=start_row, startcol=0, header=False, index=False)
            new_cells_pivot.to_excel(writer, sheet_name=pop_sheet_name, startrow=start_row+1)
            start_row += len(new_cells_pivot) + 4
            
        if not no_mito_pivot.empty:
            pd.DataFrame([["New cells appearing (excluding mitosis)"]]).to_excel(writer, sheet_name=pop_sheet_name, startrow=start_row, startcol=0, header=False, index=False)
            no_mito_pivot.to_excel(writer, sheet_name=pop_sheet_name, startrow=start_row+1)
            start_row += len(no_mito_pivot) + 4
            
    print(f"  Saved: {xlsx_path}")

    # Build Universal App binary pipeline
    print("  Packing JSON metadata and tracking coordinates for Viewer...")
    package_and_export(result, out_dir, diagnostics,
                       neighbor_dist_df=neighbor_dist_df,
                       neighbor_summary_df=neighbor_summary_df, surface_data=surface_data)

    return result


def main():
    """Process all samples found in DATA/ directory."""
    print("=" * 60)
    print("  Imaris Cell Tracking — Cell ID Assignment")
    print("=" * 60)
    print()

    if not os.path.isdir(DATA_DIR):
        print(f"[ERROR] Data directory not found: {DATA_DIR}")
        sys.exit(1)

    # Find all sample subdirectories
    samples = sorted([
        d for d in os.listdir(DATA_DIR)
        if os.path.isdir(os.path.join(DATA_DIR, d))
    ])

    if not samples:
        print(f"[ERROR] No sample directories found in {DATA_DIR}")
        sys.exit(1)

    print(f"Found {len(samples)} sample(s): {', '.join(samples)}")
    print()

    for sample_name in samples:
        print(f"Processing {sample_name}...")
        sample_dir = os.path.join(DATA_DIR, sample_name)
        
        # Start by looking for an .xlsx file to extract time interval from its name
        xlsx_files = [
            f for f in glob.glob(os.path.join(sample_dir, "*.xlsx"))
            if not os.path.basename(f).startswith("~$")
        ]
        
        time_interval_min = None
        if xlsx_files:
            import re
            filename = os.path.basename(xlsx_files[0])
            match = re.search(r'(\d+)min', filename, re.IGNORECASE)
            if match:
                time_interval_min = float(match.group(1))
                print(f"  [+] Auto-detected time interval from filename '{filename}': {time_interval_min} min")

        # Ask user for time interval interactively if not found in filename
        if time_interval_min is None:
            while True:
                ans = input(f"  Enter time interval in minutes between frames for {sample_name} (e.g., 30 or 60): ")
                try:
                    time_interval_min = float(ans)
                    if time_interval_min > 0:
                        break
                    print("  [ERROR] Please enter a positive number.")
                except ValueError:
                    print("  [ERROR] Invalid input. Please enter a number.")
                
        process_sample(sample_dir, sample_name, time_interval_min)
        print()

    print("=" * 60)
    print("  Pipeline complete!")
    print("=" * 60)


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
