"""
export_mesh.py

Sérialisation binaire des meshes au format GLB (Binary glTF 2.0).
"""

import struct
import json
import numpy as np
from typing import Dict, Tuple, Optional
from concurrent.futures import ProcessPoolExecutor, as_completed
import multiprocessing

def get_worker_count() -> int:
    total = multiprocessing.cpu_count()
    return max(1, total - 4)

def _pad_to_4(data: bytes, pad_byte: bytes = b'\x00') -> bytes:
    """Aligne sur multiple de 4 bytes (requis par spec glTF 2.0)."""
    remainder = len(data) % 4
    if remainder:
        data += pad_byte * (4 - remainder)
    return data

def _encode_tracks_compact(tracks: dict) -> dict:
    """
    Encode les tracks de cellules en format ultra-compact.
    """
    compact = {}
    for tid, positions_by_tp in tracks.items():
        flat = []
        for t in sorted(positions_by_tp.keys()):
            pos = positions_by_tp[t]
            flat.extend([
                round(float(t), 2),
                round(float(pos[0]), 1),
                round(float(pos[1]), 1),
                round(float(pos[2]), 1)
            ])
        compact[str(tid)] = flat
    return compact

def _encode_single_timepoint_binary(args: tuple) -> tuple:
    tp, data = args

    vertices = data['vertices'].astype(np.float32)
    faces    = data['faces'].astype(np.uint32).ravel()
    density = data['density']
    if density.dtype != np.uint8:
        density = (np.clip(density, 0.0, 1.0) * 255).astype(np.uint8)

    verts_bytes   = _pad_to_4(vertices.tobytes())
    faces_bytes   = _pad_to_4(faces.tobytes())
    density_bytes = _pad_to_4(density.tobytes())

    metadata = {
        'n_vertices':        len(vertices),
        'n_faces':           len(faces) // 3,
        'n_surface':         data['n_surface'],
        'n_total':           data['n_total'],
        'verts_min':         vertices.min(axis=0).tolist(),
        'verts_max':         vertices.max(axis=0).tolist(),
        'verts_len':         len(verts_bytes),
        'faces_len':         len(faces_bytes),
        'density_len':       len(density_bytes),
    }

    return (tp, verts_bytes, faces_bytes, density_bytes, metadata)

def export_meshes_to_glb_parallel(
    mesh_results: Dict,
    track_data: Optional[dict] = None,
    dataset_name: str = "embryo",
    output_path: str = "embryo.glb"
) -> None:
    n_workers = get_worker_count()
    valid = {tp: d for tp, d in mesh_results.items() if d is not None}
    
    # Trier les entrées : supporter les clés tuple (cs_name, tp) et float tp
    def sort_key(k):
        if isinstance(k, tuple):
            return (k[0], float(k[1]))  # trier par cs_name puis tp
        return ('', float(k))
    
    job_args = [(tp, data) for tp, data in sorted(valid.items(), key=lambda x: sort_key(x[0]))]

    print(f"\nEncodage binaire de {len(job_args)} timepoints ({n_workers} workers)...")

    encoded = {}
    with ProcessPoolExecutor(max_workers=n_workers) as executor:
        futures = {
            executor.submit(_encode_single_timepoint_binary, args): args[0]
            for args in job_args
        }
        for future in as_completed(futures):
            tp, vb, fb, db, meta = future.result()
            encoded[tp] = (vb, fb, db, meta)

    print("Assemblage GLB...")

    binary_blob = bytearray()
    buffer_views = []
    accessors = []
    meshes_gltf = []
    nodes = []

    for tp in sorted(encoded.keys(), key=sort_key):
        verts_bytes, faces_bytes, density_bytes, meta = encoded[tp]
        n_verts = meta['n_vertices']
        n_faces = meta['n_faces']

        def add_bv(data_bytes, target=None):
            offset = len(binary_blob)
            binary_blob.extend(data_bytes)
            bv = {"buffer": 0, "byteOffset": offset, "byteLength": len(data_bytes)}
            if target:
                bv["target"] = target
            buffer_views.append(bv)
            return len(buffer_views) - 1

        def add_acc(bv_idx, component_type, count, type_str,
                    normalized=False, min_v=None, max_v=None):
            acc = {
                "bufferView": bv_idx,
                "componentType": component_type,
                "count": count,
                "type": type_str,
            }
            if normalized:
                acc["normalized"] = True
            if min_v is not None:
                acc["min"] = min_v
                acc["max"] = max_v
            accessors.append(acc)
            return len(accessors) - 1

        # ─── Extraire le préfixe de coordonnées et le timepoint ───
        if isinstance(tp, tuple):
            cs_prefix, tp_val = tp
            tp_normalized = round(float(tp_val), 2)
            tp_safe = f"{cs_prefix}_tp_{str(tp_normalized).replace('.', '_')}"
        else:
            cs_prefix = ""
            tp_normalized = round(float(tp), 2)
            tp_safe = f"tp_{str(tp_normalized).replace('.', '_')}"
        
        verts_bv  = add_bv(verts_bytes, target=34962)
        faces_bv  = add_bv(faces_bytes, target=34963)
        den_bv    = add_bv(density_bytes)

        verts_acc = add_acc(verts_bv, 5126, n_verts, "VEC3",
                            min_v=meta['verts_min'], max_v=meta['verts_max'])
        faces_acc = add_acc(faces_bv, 5125, n_faces * 3, "SCALAR")
        den_acc   = add_acc(den_bv, 5121, n_verts, "SCALAR", normalized=True)

        mesh_idx = len(meshes_gltf)
        meshes_gltf.append({
            "name": f"surface_{tp_safe}",
            "primitives": [{
                "attributes": {"POSITION": verts_acc, "_DENSITY": den_acc},
                "indices": faces_acc,
                "mode": 4
            }]
        })

        nodes.append({
            "name": tp_safe,
            "mesh": mesh_idx,
            "extras": {
                "timepoint":        tp_normalized,
                "coord_system":     cs_prefix,
                "n_surface_points": meta['n_surface'],
                "n_total_points":   meta['n_total']
            }
        })

    # Timepoints list in scene extras
    all_tps = set()
    for tp in encoded.keys():
        if isinstance(tp, tuple):
            all_tps.add(round(float(tp[1]), 2))
        else:
            all_tps.add(round(float(tp), 2))

    scene_extras = {
        "dataset_name": dataset_name,
        "n_timepoints": len(all_tps),
        "timepoints": sorted(all_tps)
    }
    
    if track_data is not None:
        scene_extras["track_data"] = track_data

    gltf_json = {
        "asset": {"version": "2.0", "generator": "embryo_tracker"},
        "scene": 0,
        "scenes": [{"name": dataset_name,
                    "nodes": list(range(len(nodes))),
                    "extras": scene_extras}],
        "nodes": nodes,
        "meshes": meshes_gltf,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": len(binary_blob)}]
    }

    json_bytes = _pad_to_4(
        json.dumps(gltf_json, separators=(',',':')).encode('utf-8'),
        pad_byte=b' '
    )
    bin_bytes = _pad_to_4(bytes(binary_blob))
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)

    with open(output_path, 'wb') as f:
        f.write(b'glTF')
        f.write(struct.pack('<I', 2))
        f.write(struct.pack('<I', total))
        f.write(struct.pack('<I', len(json_bytes)))
        f.write(b'JSON')
        f.write(json_bytes)
        f.write(struct.pack('<I', len(bin_bytes)))
        f.write(b'BIN\x00')
        f.write(bin_bytes)

    print(f"[OK] GLB : {output_path} ({total/(1024*1024):.2f} Mo)")
