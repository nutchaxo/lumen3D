import sys
import os
sys.path.append(os.getcwd())
import pickle

# On va essayer de trouver un fichier temp ou cache si possible, sinon on crée un mock pour tester l'export
from SCRIPTS.export_mesh import export_meshes_to_glb_parallel
import numpy as np

mock_results = {
    1.0: {'vertices': np.zeros((10,3)), 'faces': np.zeros((3,3)), 'density': np.zeros(10), 'n_surface': 10, 'n_total': 10, 'n_vertices': 10, 'n_faces': 1},
    1.1: {'vertices': np.zeros((10,3)), 'faces': np.zeros((3,3)), 'density': np.zeros(10), 'n_surface': 10, 'n_total': 10, 'n_vertices': 10, 'n_faces': 1}
}

export_meshes_to_glb_parallel(mock_results, dataset_name="test", output_path="test_naming.glb")

# Maintenant on check le contenu du GLB pour voir les noms des nodes
with open("test_naming.glb", "rb") as f:
    content = f.read()
    json_start = content.find(b'{"asset"')
    json_end = content.find(b']}', json_start) + 2
    gltf = content[json_start:json_end].decode('utf-8')
    print("GLTF JSON Sample (nodes names):")
    import json
    data = json.loads(gltf)
    for node in data.get('nodes', []):
        print(f"Node name: {node['name']}")
