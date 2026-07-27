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
    P : ndarray (n, 3) — source points (previous timepoint)
    Q : ndarray (n, 3) — target points (current timepoint)

    Returns
    -------
    R : ndarray (3, 3) — rotation matrix
    t : ndarray (3,)   — translation vector
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
            print(f"     FAIL: Stabilization may be UNRELIABLE — check data")

