"""
surface_reconstruction.py — version parallélisée

Utilise tous les threads disponibles sauf 4 (réservés système).
Architecture de parallélisation :
  - Niveau 1 (inter-timepoints) : ProcessPoolExecutor
    → chaque timepoint tourne dans un process indépendant
    → contourne le GIL Python pour du vrai parallélisme CPU
    
  - Niveau 2 (intra-calcul) : workers=-1 dans cKDTree, OpenBLAS
    → numpy/scipy utilisent les threads BLAS automatiquement
    
  - Niveau 3 (numpy) : variables d'environnement BLAS
    → configurées au démarrage pour saturer les cores disponibles
"""

import os
import numpy as np
from scipy.spatial import Delaunay, ConvexHull, cKDTree
from typing import Tuple, Optional, Dict
from concurrent.futures import ProcessPoolExecutor, as_completed
import multiprocessing
def subdivide_large_triangles(
    vertices: np.ndarray,
    faces: np.ndarray,
    reference_points: np.ndarray,
    max_edge_factor: float = 1.8,
    max_iters: int = 2
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Subdivision adaptative des grands triangles pour améliorer les dégradés
    de densité sur les zones trop grossières du maillage.
    """
    if len(vertices) == 0 or len(faces) == 0 or len(reference_points) < 2:
        return vertices, faces

    vertices = vertices.astype(np.float32, copy=False)
    faces = faces.astype(np.int64, copy=False)
    ref_tree = cKDTree(reference_points)

    for _ in range(max_iters):
        if len(faces) == 0:
            break

        k_ref = min(4, len(reference_points))
        distances, _ = ref_tree.query(vertices, k=k_ref, workers=1)
        if distances.ndim == 1:
            distances = distances[:, np.newaxis]
        local_spacing = np.maximum(np.mean(distances, axis=1), 1e-6)

        v0 = vertices[faces[:, 0]]
        v1 = vertices[faces[:, 1]]
        v2 = vertices[faces[:, 2]]

        e01 = np.linalg.norm(v1 - v0, axis=1)
        e12 = np.linalg.norm(v2 - v1, axis=1)
        e20 = np.linalg.norm(v0 - v2, axis=1)
        max_edge = np.maximum(np.maximum(e01, e12), e20)
        face_spacing = (
            local_spacing[faces[:, 0]] +
            local_spacing[faces[:, 1]] +
            local_spacing[faces[:, 2]]
        ) / 3.0

        split_mask = max_edge > (max_edge_factor * face_spacing)
        if not np.any(split_mask):
            break

        kept_faces = faces[~split_mask]
        faces_to_split = faces[split_mask]

        edge_mid_cache = {}
        new_vertices = vertices.tolist()
        new_faces = []

        def midpoint_index(i: int, j: int) -> int:
            key = (i, j) if i < j else (j, i)
            if key in edge_mid_cache:
                return edge_mid_cache[key]
            midpoint = ((vertices[key[0]] + vertices[key[1]]) * 0.5).tolist()
            idx = len(new_vertices)
            new_vertices.append(midpoint)
            edge_mid_cache[key] = idx
            return idx

        for a, b, c in faces_to_split:
            ab = midpoint_index(int(a), int(b))
            bc = midpoint_index(int(b), int(c))
            ca = midpoint_index(int(c), int(a))
            new_faces.extend([
                [int(a), ab, ca],
                [ab, int(b), bc],
                [ca, bc, int(c)],
                [ab, bc, ca],
            ])

        vertices = np.asarray(new_vertices, dtype=np.float32)
        split_faces = np.asarray(new_faces, dtype=np.int64)
        faces = split_faces if len(kept_faces) == 0 else np.vstack([kept_faces, split_faces])

    return vertices, faces.astype(np.uint32, copy=False)


# =============================================================================
# CONFIGURATION DU PARALLÉLISME
# =============================================================================

def get_worker_count() -> int:
    """
    Retourne le nombre de workers à utiliser :
    tous les threads logiques disponibles moins 4 (réservés système).
    Minimum 1 pour éviter les cas dégénérés.
    """
    total = multiprocessing.cpu_count()
    workers = max(1, total - 4)
    return workers


def configure_numpy_threads(n_workers: int) -> None:
    """
    Configure les variables d'environnement BLAS/OpenBLAS/MKL
    AVANT l'import de numpy pour maximiser l'utilisation CPU.
    """
    n_str = str(n_workers)
    os.environ['OMP_NUM_THREADS']       = n_str  # OpenMP
    os.environ['OPENBLAS_NUM_THREADS']  = n_str  # OpenBLAS
    os.environ['MKL_NUM_THREADS']       = n_str  # Intel MKL
    os.environ['VECLIB_MAXIMUM_THREADS']= n_str  # macOS Accelerate
    os.environ['NUMEXPR_NUM_THREADS']   = n_str  # NumExpr


# =============================================================================
# ÉTAPE 1 : CLASSIFICATION SURFACE / INTÉRIEUR
# =============================================================================

def classify_surface_points(
    points: np.ndarray,
    k_neighbors: int = 15,
    surface_fraction: float = 0.45
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Identifie les points en surface vs intérieur.
    Entièrement vectorisé numpy + cKDTree multi-thread.
    """
    n = len(points)
    if n <= 4:
        return np.ones(n, dtype=bool), np.ones(n, dtype=np.float32)

    k_neighbors = int(np.clip(k_neighbors, 3, n - 1))
    surface_fraction = float(np.clip(surface_fraction, 0.05, 0.95))
    n_workers = get_worker_count()
    tree = cKDTree(points)

    # workers=1 : on est déjà dans un ProcessPool
    _, indices = tree.query(points, k=k_neighbors + 1, workers=1)
    indices = indices[:, 1:]  # (N, k) exclure soi-même

    # ------------------------------------------------------------------
    # CRITÈRE 1 : Asymétrie vectorielle — entièrement vectorisé (N, k, 3)
    # ------------------------------------------------------------------
    neighbor_positions = points[indices]                        # (N, k, 3)
    vectors = neighbor_positions - points[:, None, :]           # (N, k, 3)

    norms = np.linalg.norm(vectors, axis=2, keepdims=True)
    norms = np.maximum(norms, 1e-10)
    unit_vectors = vectors / norms                              # (N, k, 3)

    sum_vectors = unit_vectors.sum(axis=1)                      # (N, 3)
    asymmetry_scores = (
        np.linalg.norm(sum_vectors, axis=1) / k_neighbors
    )                                                           # (N,)

    # ------------------------------------------------------------------
    # CRITÈRE 2 : Planéité locale — SVD batch (N, k, 3)
    # OpenBLAS parallélise automatiquement np.linalg.svd sur batch
    # ------------------------------------------------------------------
    centered = neighbor_positions - points[:, None, :]          # (N, k, 3)
    _, sv, _ = np.linalg.svd(centered, full_matrices=False)     # sv: (N, 3)

    sv_sum = sv.sum(axis=1, keepdims=True) + 1e-10
    sv_norm = sv / sv_sum
    planarity_scores = 1.0 - sv_norm[:, 2] / (sv_norm[:, 0] + 1e-10)

    # ------------------------------------------------------------------
    # Score combiné + seuillage
    # ------------------------------------------------------------------
    combined = 0.55 * asymmetry_scores + 0.45 * planarity_scores
    threshold = np.percentile(combined, (1.0 - surface_fraction) * 100.0)
    is_surface = combined >= threshold

    return is_surface, combined


def auto_surface_fraction(points: np.ndarray, k: int = 15) -> float:
    """Estime la fraction de points en surface depuis la géométrie globale."""
    if len(points) <= 4:
        return 1.0

    k = int(np.clip(k, 1, len(points) - 1))
    tree = cKDTree(points)
    distances, _ = tree.query(points, k=k + 1, workers=1)
    mean_spacing = distances[:, 1].mean()

    centroid = points.mean(axis=0)
    radii = np.linalg.norm(points - centroid, axis=1)
    radius = np.percentile(radii, 85)

    optical_depth = mean_spacing * 2.5
    inner_radius = max(radius - optical_depth, 0)
    if radius < 1e-10:
        return 1.0

    fraction = 1.0 - (inner_radius / radius) ** 3

    return float(np.clip(fraction, 0.25, 0.65))


def select_surface_points(
    points: np.ndarray,
    k_neighbors: int = 15,
    surface_fraction: Optional[float] = None
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, float]:
    """
    Sélectionne dynamiquement les candidats de surface.

    Retourne :
      - les points retenus,
      - le masque booléen sur le nuage initial,
      - le score surface/intérieur par point,
      - la fraction cible effectivement utilisée.
    """
    n = len(points)
    if n <= 4:
        mask = np.ones(n, dtype=bool)
        scores = np.ones(n, dtype=np.float32)
        return points, mask, scores, 1.0

    effective_fraction = (
        auto_surface_fraction(points, k=k_neighbors)
        if surface_fraction is None
        else float(np.clip(surface_fraction, 0.05, 0.95))
    )

    mask, scores = classify_surface_points(
        points,
        k_neighbors=k_neighbors,
        surface_fraction=effective_fraction,
    )

    # Garantit un noyau minimal de points de coque, surtout sur petits timepoints.
    min_keep = min(n, max(12, int(np.ceil(n * 0.20))))
    if mask.sum() < min_keep:
        top_idx = np.argsort(scores)[-min_keep:]
        mask = np.zeros(n, dtype=bool)
        mask[top_idx] = True

    return points[mask], mask, scores, effective_fraction


# =============================================================================
# ÉTAPE 2 : ALPHA SHAPE 3D
# =============================================================================

def _circumradii_batch(simplices: np.ndarray, points: np.ndarray) -> np.ndarray:
    """
    Rayons des sphères circonscrites — vectorisé numpy batch.
    OpenBLAS parallélise np.linalg.solve sur la dimension batch.
    """
    A = points[simplices[:, 0]]
    B = points[simplices[:, 1]]
    C = points[simplices[:, 2]]
    D = points[simplices[:, 3]]

    AB, AC, AD = B - A, C - A, D - A

    M_mat = 2.0 * np.stack([AB, AC, AD], axis=1)  # (M, 3, 3)
    rhs = np.stack([
        np.einsum('ij,ij->i', AB, AB),
        np.einsum('ij,ij->i', AC, AC),
        np.einsum('ij,ij->i', AD, AD),
    ], axis=1)                                      # (M, 3)

    radii = np.full(len(simplices), np.inf)
    try:
        # np.linalg.solve requires rhs to be (..., M, 1) to match (..., M, M) matrices
        x = np.linalg.solve(M_mat, rhs[:, :, np.newaxis])
        radii = np.linalg.norm(x.squeeze(-1), axis=1)
    except (np.linalg.LinAlgError, ValueError):
        for i in range(len(simplices)):
            try:
                x = np.linalg.solve(M_mat[i], rhs[i])
                radii[i] = np.linalg.norm(x)
            except np.linalg.LinAlgError:
                radii[i] = np.inf

    return radii


def _orient_faces(points: np.ndarray, faces: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """Oriente les normales vers l'extérieur — vectorisé."""
    centroid = points.mean(axis=0)
    v0, v1, v2 = points[faces[:, 0]], points[faces[:, 1]], points[faces[:, 2]]
    normals = np.cross(v1 - v0, v2 - v0)
    face_centers = (v0 + v1 + v2) / 3.0
    dot = np.einsum('ij,ij->i', normals, face_centers - centroid)
    faces = faces.copy()
    faces[dot < 0] = faces[dot < 0][:, ::-1]
    return points, faces


def _project_to_plane(points: np.ndarray, axis: int = 2) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Projette les points sur le plan orthogonal à `axis` et renvoie aussi la coordonnée axiale."""
    plane_axes = np.array([i for i in range(points.shape[1]) if i != axis], dtype=np.int64)
    plane = points[:, plane_axes]
    axial = points[:, axis]
    return plane, axial, plane_axes


def _estimate_planar_spacing(plane_points: np.ndarray, k: int = 6) -> Tuple[np.ndarray, float]:
    """Espacement local dans le plan projeté + espacement global robuste."""
    n = len(plane_points)
    if n <= 1:
        return np.ones(n, dtype=np.float32), 1.0

    k = int(np.clip(k, 1, n - 1))
    tree = cKDTree(plane_points)
    distances, _ = tree.query(plane_points, k=k + 1, workers=1)
    if distances.ndim == 1:
        distances = distances[:, np.newaxis]
    neighbor_dist = distances[:, 1:]
    local_spacing = np.percentile(neighbor_dist, 75, axis=1)
    base_spacing = float(np.percentile(neighbor_dist, 70))
    base_spacing = max(base_spacing, 1e-6)
    return local_spacing, base_spacing


def _select_outer_sheet_points(
    points: np.ndarray,
    axis: int = 2,
    side: str = "max",
    grid_factor: float = 1.05
) -> Tuple[np.ndarray, np.ndarray, Dict]:
    """
    Sélectionne les points les plus externes dans une grille du plan projeté.

    Le principe est celui du "drap" : pour chaque cellule XY, on garde
    uniquement le point le plus externe selon l'axe du microscope.
    """
    plane, axial, plane_axes = _project_to_plane(points, axis=axis)
    local_spacing, base_spacing = _estimate_planar_spacing(plane, k=6)
    cell_size = max(base_spacing * grid_factor, 1e-6)

    mins = plane.min(axis=0)
    selected_set = set()

    # Multi-grille décalée : conserve mieux les reliefs extérieurs et les
    # points proches des frontières de cellules.
    grid_offsets = [
        np.array([0.0, 0.0]),
        np.array([0.5, 0.0]),
        np.array([0.0, 0.5]),
        np.array([0.5, 0.5]),
    ]

    for offset in grid_offsets:
        shifted = plane - mins + (offset * cell_size)
        cell_coords = np.floor(shifted / cell_size).astype(np.int64)
        _, inverse = np.unique(cell_coords, axis=0, return_inverse=True)

        for cell_id in range(inverse.max() + 1):
            candidates = np.flatnonzero(inverse == cell_id)
            if len(candidates) == 0:
                continue
            if side == "min":
                chosen = candidates[np.argmin(axial[candidates])]
            else:
                chosen = candidates[np.argmax(axial[candidates])]
            selected_set.add(int(chosen))

    # Préserver explicitement le bord latéral projeté pour éviter de rogner
    # les points les plus externes.
    try:
        if len(plane) >= 3:
            hull = ConvexHull(plane)
            selected_set.update(int(i) for i in hull.vertices.tolist())
    except Exception:
        pass

    selected = np.array(sorted(selected_set), dtype=np.int64)
    meta = {
        "plane_axes": plane_axes,
        "cell_size": float(cell_size),
        "base_spacing_xy": float(base_spacing),
        "local_spacing_xy": local_spacing,
        "selected_xy": plane[selected],
        "selected_axial": axial[selected],
    }
    return points[selected], selected, meta


def _sheet_side_score(sheet_points: np.ndarray, axis: int = 2) -> float:
    """
    Score de qualité d'une nappe orientée.
    Plus il est faible, plus la nappe est régulière et bien échantillonnée.
    """
    if len(sheet_points) < 4:
        return np.inf

    plane, axial, _ = _project_to_plane(sheet_points, axis=axis)
    tree = cKDTree(plane)
    k = min(6, len(sheet_points) - 1)
    distances, indices = tree.query(plane, k=k + 1, workers=1)
    if distances.ndim == 1:
        distances = distances[:, np.newaxis]
        indices = indices[:, np.newaxis]

    neighbor_dist = np.maximum(distances[:, 1:], 1e-6)
    neighbor_axial = axial[indices[:, 1:]]
    roughness = np.median(np.abs(neighbor_axial - axial[:, None]) / neighbor_dist)
    spacing_penalty = np.median(neighbor_dist)
    return float(roughness + 0.15 * spacing_penalty)


def _resolve_outward_side(points: np.ndarray, axis: int = 2, side: str = "auto") -> str:
    """Choisit automatiquement la face externe la plus régulière si nécessaire."""
    if side in {"max", "min"}:
        return side

    max_sheet, _, _ = _select_outer_sheet_points(points, axis=axis, side="max")
    min_sheet, _, _ = _select_outer_sheet_points(points, axis=axis, side="min")
    max_score = _sheet_side_score(max_sheet, axis=axis)
    min_score = _sheet_side_score(min_sheet, axis=axis)
    return "max" if max_score <= min_score else "min"


def _triangle_circumradius_2d(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> np.ndarray:
    """Rayon circonscrit 2D pour filtrer les triangles trop grands dans le plan."""
    ab = np.linalg.norm(b - a, axis=1)
    bc = np.linalg.norm(c - b, axis=1)
    ca = np.linalg.norm(a - c, axis=1)
    twice_area = np.abs(
        (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) -
        (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
    )
    denom = np.maximum(2.0 * twice_area, 1e-12)
    return (ab * bc * ca) / denom


def _triangle_pointy_mask(
    edge_a: np.ndarray,
    edge_b: np.ndarray,
    edge_c: np.ndarray,
    face_spacing: np.ndarray,
    long_edge_factor: float = 1.35,
    edge_ratio_factor: float = 3.2,
    min_angle_deg: float = 24.0,
) -> np.ndarray:
    """
    Détecte les triangles à la fois trop longs localement et trop pointus.
    """
    max_edge = np.maximum(np.maximum(edge_a, edge_b), edge_c)
    min_edge = np.maximum(np.minimum(np.minimum(edge_a, edge_b), edge_c), 1e-6)
    edge_ratio = max_edge / min_edge

    # Loi des cosinus pour les 3 angles.
    cos_a = np.clip((edge_b**2 + edge_c**2 - edge_a**2) / (2.0 * edge_b * edge_c + 1e-12), -1.0, 1.0)
    cos_b = np.clip((edge_a**2 + edge_c**2 - edge_b**2) / (2.0 * edge_a * edge_c + 1e-12), -1.0, 1.0)
    cos_c = np.clip((edge_a**2 + edge_b**2 - edge_c**2) / (2.0 * edge_a * edge_b + 1e-12), -1.0, 1.0)
    min_angle = np.minimum(np.minimum(np.arccos(cos_a), np.arccos(cos_b)), np.arccos(cos_c))

    long_mask = max_edge > (long_edge_factor * face_spacing)
    pointy_mask = (edge_ratio > edge_ratio_factor) | (min_angle < np.deg2rad(min_angle_deg))
    return long_mask & pointy_mask


def _face_edges(faces: np.ndarray) -> np.ndarray:
    """Retourne les 3 arêtes triées pour chaque face."""
    return np.sort(
        np.vstack([
            faces[:, [0, 1]],
            faces[:, [1, 2]],
            faces[:, [0, 2]],
        ]),
        axis=1
    )


def _restore_small_sheet_holes(
    faces: np.ndarray,
    keep_mask: np.ndarray,
    max_edge_xy: np.ndarray,
    circumradius_xy: np.ndarray,
    z_span: np.ndarray,
    face_spacing_xy: np.ndarray,
    edge_factor_xy: float,
    alpha_xy_factor: float,
    z_span_factor: float
) -> np.ndarray:
    """
    Réinsère localement des triangles retirés qui forment de petits trous.

    On n'autorise la réparation que si le triangle supprimé est proche des
    seuils, petit localement, et déjà soutenu par au moins 2 arêtes du maillage
    conservé. Cela évite de rouvrir les grands ponts parasites.
    """
    kept_faces = faces[keep_mask]
    removed_idx = np.flatnonzero(~keep_mask)
    if len(kept_faces) == 0 or len(removed_idx) == 0:
        return kept_faces

    edge_keys = {
        tuple(edge.tolist())
        for edge in _face_edges(kept_faces)
    }

    soft_mask = (
        (max_edge_xy < (edge_factor_xy * 1.18) * face_spacing_xy) &
        (circumradius_xy < (alpha_xy_factor * 1.20) * face_spacing_xy) &
        (z_span < (z_span_factor * 1.30) * face_spacing_xy)
    )

    candidate_idx = removed_idx[soft_mask[removed_idx]]
    if len(candidate_idx) == 0:
        return kept_faces

    # Priorité aux plus petits triangles pour refermer les trous minimes avant
    # les quadrilatères "double triangle".
    candidate_idx = candidate_idx[np.argsort(circumradius_xy[candidate_idx])]
    restored = [face.copy() for face in kept_faces]

    for idx in candidate_idx:
        face = faces[idx]
        tri_edges = np.sort(
            np.array([
                [face[0], face[1]],
                [face[1], face[2]],
                [face[0], face[2]],
            ], dtype=np.int64),
            axis=1
        )
        shared_edges = sum(tuple(edge.tolist()) in edge_keys for edge in tri_edges)
        if shared_edges >= 2:
            restored.append(face.copy())
            for edge in tri_edges:
                edge_keys.add(tuple(edge.tolist()))

    return np.asarray(restored, dtype=faces.dtype)


def _orient_sheet_faces(
    points: np.ndarray,
    faces: np.ndarray,
    axis: int = 2,
    side: str = "max"
) -> Tuple[np.ndarray, np.ndarray]:
    """Oriente la nappe pour que sa normale pointe globalement vers l'extérieur."""
    v0 = points[faces[:, 0]]
    v1 = points[faces[:, 1]]
    v2 = points[faces[:, 2]]
    normals = np.cross(v1 - v0, v2 - v0)
    faces = faces.copy()
    if side == "min":
        flip_mask = normals[:, axis] > 0
    else:
        flip_mask = normals[:, axis] < 0
    faces[flip_mask] = faces[flip_mask][:, ::-1]
    return points, faces


def build_oriented_sheet_surface(
    points: np.ndarray,
    axis: int = 2,
    outward_side: str = "auto",
    grid_factor: float = 1.05,
    edge_factor_xy: float = 3.35,
    alpha_xy_factor: float = 2.95,
    z_span_factor: float = 5.5
) -> Tuple[np.ndarray, np.ndarray, Dict]:
    """
    Reconstruit une surface ouverte orientée microscope, de type drap z=f(x,y).

    Étapes :
      1. projection sur le plan orthogonal à l'axe microscope ;
      2. sélection du point le plus externe dans chaque cellule 2D ;
      3. triangulation Delaunay 2D de cette nappe ;
      4. filtrage des triangles qui pontent des concavités.
    """
    n = len(points)
    if n < 4:
        raise ValueError(f"Trop peu de points ({n})")

    resolved_side = _resolve_outward_side(points, axis=axis, side=outward_side)
    sheet_points, selected_idx, meta = _select_outer_sheet_points(
        points,
        axis=axis,
        side=resolved_side,
        grid_factor=grid_factor,
    )

    if len(sheet_points) < 4:
        raise ValueError("Pas assez de points externes pour construire la nappe orientée")

    sheet_plane, sheet_axial, plane_axes = _project_to_plane(sheet_points, axis=axis)
    local_spacing_xy, base_spacing_xy = _estimate_planar_spacing(sheet_plane, k=6)

    tri = Delaunay(sheet_plane)
    faces = tri.simplices
    if len(faces) == 0:
        raise ValueError("Triangulation 2D impossible sur la nappe orientée")

    p0 = sheet_plane[faces[:, 0]]
    p1 = sheet_plane[faces[:, 1]]
    p2 = sheet_plane[faces[:, 2]]

    edge_xy_01 = np.linalg.norm(p1 - p0, axis=1)
    edge_xy_02 = np.linalg.norm(p2 - p0, axis=1)
    edge_xy_12 = np.linalg.norm(p2 - p1, axis=1)
    max_edge_xy = np.maximum(np.maximum(edge_xy_01, edge_xy_02), edge_xy_12)

    face_spacing_xy = (
        local_spacing_xy[faces[:, 0]] +
        local_spacing_xy[faces[:, 1]] +
        local_spacing_xy[faces[:, 2]]
    ) / 3.0

    circumradius_xy = _triangle_circumradius_2d(p0, p1, p2)
    z_span = np.maximum.reduce([
        np.abs(sheet_axial[faces[:, 0]] - sheet_axial[faces[:, 1]]),
        np.abs(sheet_axial[faces[:, 0]] - sheet_axial[faces[:, 2]]),
        np.abs(sheet_axial[faces[:, 1]] - sheet_axial[faces[:, 2]]),
    ])
    pointy_long_mask = _triangle_pointy_mask(
        edge_xy_01,
        edge_xy_02,
        edge_xy_12,
        face_spacing_xy,
        long_edge_factor=1.30,
        edge_ratio_factor=3.4,
        min_angle_deg=22.0,
    )

    keep_mask = (
        (max_edge_xy < edge_factor_xy * face_spacing_xy) &
        (circumradius_xy < alpha_xy_factor * face_spacing_xy) &
        (z_span < z_span_factor * face_spacing_xy) &
        (~pointy_long_mask)
    )

    filtered_faces = faces[keep_mask]
    if len(filtered_faces) > 0:
        faces = _restore_small_sheet_holes(
            faces=faces,
            keep_mask=keep_mask,
            max_edge_xy=max_edge_xy,
            circumradius_xy=circumradius_xy,
            z_span=z_span,
            face_spacing_xy=face_spacing_xy,
            edge_factor_xy=edge_factor_xy,
            alpha_xy_factor=alpha_xy_factor,
            z_span_factor=z_span_factor,
        )

    vertices, faces = _orient_sheet_faces(sheet_points, faces, axis=axis, side=resolved_side)
    info = {
        "method": "oriented_sheet",
        "axis": int(axis),
        "outward_side": resolved_side,
        "grid_factor": float(grid_factor),
        "edge_factor_xy": float(edge_factor_xy),
        "alpha_xy_factor": float(alpha_xy_factor),
        "z_span_factor": float(z_span_factor),
        "base_spacing_xy": float(base_spacing_xy),
        "n_sheet_points": int(len(sheet_points)),
        "selection_ratio": float(len(sheet_points) / len(points)),
        "selected_indices": selected_idx,
        "plane_axes": plane_axes,
    }
    return vertices, faces, info


def build_alpha_shape(
    points: np.ndarray,
    alpha_factor: float = 2.0,
    edge_factor: float = 3.5
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Alpha Shape 3D vectorisé avec filtre d'arêtes longues
    pour créer des surfaces OUVERTES (pas des volumes fermés).
    
    edge_factor : les faces dont une arête dépasse edge_factor × espacement
                  local sont supprimées → ouvre les surfaces artificielles
                  qui "ferment" l'arrière du nuage de points.
    """
    n = len(points)
    if n < 4:
        raise ValueError(f"Trop peu de points ({n})")

    tree = cKDTree(points)
    k_spacing = min(6, n - 1)
    distances, _ = tree.query(points, k=k_spacing + 1, workers=1)
    # Use 85th percentile instead of mean to handle sparse outward regions without holes
    base_spacing = np.percentile(distances[:, 1:], 85)
    alpha = alpha_factor * base_spacing

    tri = Delaunay(points)
    simplices = tri.simplices

    radii = _circumradii_batch(simplices, points)
    valid_simplices = simplices[radii < alpha]

    if len(valid_simplices) == 0:
        hull = ConvexHull(points)
        return _orient_faces(points, hull.simplices)

    # Extraction faces de surface (vectorisé)
    face_combos = [[0,1,2], [0,1,3], [0,2,3], [1,2,3]]
    all_faces = np.vstack([
        np.sort(valid_simplices[:, idx], axis=1)
        for idx in face_combos
    ])

    stride = n + 1
    keys = (all_faces[:, 0].astype(np.int64) * stride * stride +
            all_faces[:, 1].astype(np.int64) * stride +
            all_faces[:, 2].astype(np.int64))

    unique_keys, counts = np.unique(keys, return_counts=True)
    boundary_keys = unique_keys[counts == 1]
    surface_faces = all_faces[np.isin(keys, boundary_keys)]

    if len(surface_faces) == 0:
        hull = ConvexHull(points)
        return _orient_faces(points, hull.simplices)

    # ─── Filtre d'arêtes longues : ouvrir la surface ───
    # Utiliser le 90ème percentile de l'espacement local pour être robuste aux outliers
    local_spacing = np.percentile(distances[:, 1:], 90, axis=1)  # (N,)
    
    # Pour chaque face, calculer la longueur des 3 arêtes
    v0 = points[surface_faces[:, 0]]
    v1 = points[surface_faces[:, 1]]
    v2 = points[surface_faces[:, 2]]
    
    edge_01 = np.linalg.norm(v1 - v0, axis=1)
    edge_02 = np.linalg.norm(v2 - v0, axis=1)
    edge_12 = np.linalg.norm(v2 - v1, axis=1)
    max_edge = np.maximum(np.maximum(edge_01, edge_02), edge_12)
    
    # Seuil par face = edge_factor × espacement local moyen des 3 sommets
    face_spacing = (
        local_spacing[surface_faces[:, 0]] +
        local_spacing[surface_faces[:, 1]] +
        local_spacing[surface_faces[:, 2]]
    ) / 3.0

    pointy_long_mask = _triangle_pointy_mask(
        edge_01,
        edge_02,
        edge_12,
        face_spacing,
        long_edge_factor=1.30,
        edge_ratio_factor=3.4,
        min_angle_deg=22.0,
    )

    keep_mask = (max_edge < (edge_factor * face_spacing)) & (~pointy_long_mask)
    filtered_faces = surface_faces[keep_mask]

    # Si le filtre ouvre trop agressivement la surface, mieux vaut revenir
    # aux faces alpha non filtrées que de reboucher avec une coque convexe.
    if len(filtered_faces) > 0:
        surface_faces = filtered_faces

    return _orient_faces(points, surface_faces)


# =============================================================================
# ÉTAPE 3 : DENSITÉ k-NN
# =============================================================================

def compute_density_knn(
    mesh_vertices: np.ndarray,
    cell_positions: np.ndarray,
    k: int = 6
) -> np.ndarray:
    """
    Densité k-NN → uint8.
    """
    if len(mesh_vertices) == 0:
        return np.zeros(0, dtype=np.uint8)

    tree = cKDTree(cell_positions)
    k = int(np.clip(k, 1, len(cell_positions)))
    distances, _ = tree.query(mesh_vertices, k=k, workers=1)
    if distances.ndim == 1:
        distances = distances[:, np.newaxis]

    mean_dist = distances.mean(axis=1)
    mean_dist = np.maximum(mean_dist, 1e-6)
    raw_density = 1.0 / mean_dist

    p2, p98 = np.percentile(raw_density, [2, 98])
    span = p98 - p2
    if span < 1e-10:
        return np.full(len(mesh_vertices), 128, dtype=np.uint8)

    normalized = np.clip((raw_density - p2) / span, 0.0, 1.0)
    return (normalized * 255).astype(np.uint8)


# =============================================================================
# ÉTAPE 4 : PIPELINE PAR TIMEPOINT (fonction top-level pour ProcessPool)
# =============================================================================

def _process_single_timepoint(args: tuple) -> tuple:
    tp, points, k_surface, surface_fraction, alpha_factor, k_density, verbose = args

    try:
        sheet_info = None
        effective_surface_fraction = None
        surface_mask = np.ones(len(points), dtype=bool)

        try:
            vertices, faces, sheet_info = build_oriented_sheet_surface(
                points,
                axis=2,
                outward_side="auto",
            )
            surface_points = vertices
            effective_surface_fraction = sheet_info["selection_ratio"]
        except Exception as sheet_error:
            if verbose:
                print(f"  [tp={tp:>6.2f}] surface orientée indisponible, fallback alpha-shape: {sheet_error}")
            surface_points, surface_mask, _, effective_surface_fraction = select_surface_points(
                points,
                k_neighbors=k_surface,
                surface_fraction=surface_fraction,
            )
            vertices, faces = build_alpha_shape(surface_points, alpha_factor=alpha_factor)

        vertices, faces = subdivide_large_triangles(
            vertices,
            faces,
            reference_points=points,
            max_edge_factor=1.8,
            max_iters=2,
        )
        density = compute_density_knn(vertices, points, k=k_density)

        tree_tmp = cKDTree(vertices)
        k_alpha = min(4, len(surface_points) - 1)
        if k_alpha >= 1:
            d_tmp, _ = tree_tmp.query(vertices, k=k_alpha + 1, workers=1)
            alpha_used = alpha_factor * np.percentile(d_tmp[:, 1:], 85)
        else:
            alpha_used = 0.0

        result = {
            'vertices':          vertices.astype(np.float32),
            'faces':             faces.astype(np.uint32),
            'density':           density,
            'surface_points':    vertices,
            'n_total':           len(points),
            'n_surface':         int(len(vertices)),
            'n_vertices':        len(vertices),
            'n_faces':           len(faces),
            'alpha_used':        float(alpha_used),
            'surface_fraction':  float(effective_surface_fraction or 1.0),
            'surface_fraction_kept': float(effective_surface_fraction or (len(vertices) / max(len(points), 1))),
            'surface_method':    sheet_info['method'] if sheet_info else 'alpha_shape',
            'surface_side':      sheet_info['outward_side'] if sheet_info else 'n/a',
        }

        if verbose:
            print(
                f"  [tp={tp:>6.2f}] "
                f"{len(points)} pts -> "
                f"{len(vertices)}v / {len(faces)}f "
                f"({result['surface_method']}, side={result['surface_side']})"
            )

        return (tp, result)

    except Exception as e:
        print(f"  [WARN] Erreur tp={tp}: {e}")
        return (tp, None)


# =============================================================================
# ÉTAPE 5 : ORCHESTRATEUR PARALLÈLE
# =============================================================================

def build_all_timepoints(
    points_by_tp: Dict,
    k_surface: int = 15,
    surface_fraction: Optional[float] = None,
    alpha_factor: float = 2.0,
    k_density: int = 6,
    verbose: bool = True
) -> Dict:
    n_workers = get_worker_count()
    timepoints = sorted(points_by_tp.keys())
    n_tp = len(timepoints)

    print(f"\nTraitement de {n_tp} timepoints sur {n_workers} workers...")

    job_args = [
        (
            tp,
            points_by_tp[tp],
            k_surface,
            surface_fraction,
            alpha_factor,
            k_density,
            verbose
        )
        for tp in timepoints
    ]

    results = {}
    chunksize = max(1, int((n_tp / n_workers) ** 0.5))

    with ProcessPoolExecutor(max_workers=n_workers) as executor:
        futures = {
            executor.submit(_process_single_timepoint, args): args[0]
            for args in job_args
        }

        completed = 0
        for future in as_completed(futures):
            tp_id = futures[future]
            try:
                tp, result = future.result()
                results[tp] = result
            except Exception as e:
                print(f"  [WARN] Future erreur tp={tp_id}: {e}")
                results[tp_id] = None

            completed += 1
            if not verbose and completed % 10 == 0:
                print(f"  Progression : {completed}/{n_tp} timepoints")

    results = dict(sorted(results.items()))

    n_ok = sum(1 for v in results.values() if v is not None)
    print(f"\n[OK] {n_ok}/{n_tp} timepoints traités avec succès")

    return results
