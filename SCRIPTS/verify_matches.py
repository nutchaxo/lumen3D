import pandas as pd
import json
import struct

df = pd.read_excel('D:/Kristof/Morgan/DATA/SAMPLE-3/Live-Egfl7eGFP-E75-06112025-30min-Positions-Analysis.xlsx')
df_stab = df[df['timepoint']==1.0]
pts_raw = df_stab[['x','y','z']].values

df_9 = df[df['timepoint']==9.0]
pts_9 = df_9[['x','y','z']].values

f = open('D:/Kristof/Morgan/OUTPUT/26.04.10-13.11/SAMPLE-3/SAMPLE-3_raw.glb', 'rb')
f.read(12)
jl = int.from_bytes(f.read(4), 'little')
f.read(4)
gltf = json.loads(f.read(jl))
bl = int.from_bytes(f.read(4), 'little')
f.read(4)
bd = f.read(bl)

def get_verts(mesh_idx):
    m = gltf['meshes'][mesh_idx]['primitives'][0]['attributes']['POSITION']
    acc = gltf['accessors'][m]
    bv = gltf['bufferViews'][acc['bufferView']]
    o = bv.get('byteOffset',0)
    return [struct.unpack_from('<3f', bd, o + i*12) for i in range(acc['count'])]

v1 = get_verts(0)
v9 = get_verts(80)

print(f"RAW Cells at t=1.0: {len(pts_raw)}")
print(f"RAW Cells at t=9.0: {len(pts_9)}")
print(f"GLB Node 0 (tp_1.0) vertices: {len(v1)}")
print(f"GLB Node 80 (tp_9.0) vertices: {len(v9)}")

int_1_1 = len(set([round(x[0],2) for x in v1]).intersection([round(x[0],2) for x in pts_raw]))
int_9_9 = len(set([round(x[0],2) for x in v9]).intersection([round(x[0],2) for x in pts_9]))
int_9_1 = len(set([round(x[0],2) for x in v9]).intersection([round(x[0],2) for x in pts_raw]))

print(f"Match between tp_1.0 mesh and RAW 1.0 cells: {int_1_1} matches")
print(f"Match between tp_9.0 mesh and RAW 9.0 cells: {int_9_9} matches")
print(f"Match between tp_9.0 mesh and RAW 1.0 cells: {int_9_1} matches")
