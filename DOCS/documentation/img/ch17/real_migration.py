"""Exécute le VRAI moteur de migration (dataset_migrations.py) sur un jeu synthétique de format 1
dans un dossier temporaire et range journaux, tailles et durées dans data/real_migration.json
(rien n'est écrit dans la plateforme).   python real_migration.py"""
import json, os, sys, time, shutil, copy
from pathlib import Path
import tempfile
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / 'tests'))
import numpy as np
import dataset_migrations as dm
from test_mig_py_server import _write_tree, _volume

W = Path(tempfile.mkdtemp(prefix='lumen-doc17-mig-'))
(W / 'DATA_WEB' / '3d').mkdir(parents=True)
dm.configure(W, data_web=W / 'DATA_WEB', uploads_dir=W / 'uploads')

name = 'Synthetique-E95'
X, Y, Z, C = 520, 520, 130, 2
rng = np.random.default_rng(11)
ds = W / 'DATA_WEB' / '3d' / name
vols = [_volume(rng, X, Y, Z) for _ in range(C)]
drop = lambda c, bx, by, bz: (bx + 2 * by + bz + c) % 4 == 0
levels, transport, truth = _write_tree(ds / 'bricks', vols, drop)
manifest = {"version": 2, "schema": "iribhm-bricks-v2", "dataset": name, "channels": C, "brickSize": 64,
            "brickPacking": {"mode": "grid", "cols": 8, "rows": 8},
            "voxelSize": {"x": 1.2, "y": 1.2, "z": 3.0},
            "levels": levels, "brickTransport": transport, "timepoints": None,
            "histograms": [{"counts": [1, 2, 3]}] * C}
(ds / 'bricks' / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
(ds / 'metadata.json').write_text(json.dumps({"id": f"3d/{name}", "name": name, "type": "3d", "dimensions": {"x": X, "y": Y, "z": Z, "c": C, "t": 1}}, indent=2), encoding='utf-8')
DID = f'3d/{name}'

def tree(d, depth=2):
    out = []
    for p in sorted(d.rglob('*')):
        rel = p.relative_to(d)
        if len(rel.parts) > depth: continue
        out.append((str(rel), p.stat().st_size if p.is_file() else None))
    return out
def du(d):
    return sum(f.stat().st_size for f in d.rglob('*') if f.is_file()) if d.exists() else 0

rec = {"dataset": DID, "dims": [X, Y, Z, C], "steps": []}
def snapshot(label):
    jd = {}
    for p in sorted((W / 'uploads' / 'migrations').glob('*.json')) if (W / 'uploads' / 'migrations').exists() else []:
        jd[p.name] = json.loads(p.read_text())
    return {"label": label, "journals": jd,
            "sizes": {k: du(ds / k) for k in ('bricks', 'planes', 'mips', '.planes-incoming', '.bricks-incoming', 'bricks.v2-old', '.planes-old')},
            "root": sorted(p.name for p in ds.iterdir()),
            "store": du(W / 'uploads' / 'migrations')}

st = dm.status()
row = [r for r in st['datasets'] if r['id'] == DID][0]
rec['status0'] = {k: row[k] for k in ('formatVersion', 'pending', 'repair', 'trees', 'estimate')}
rec['server'] = {k: st['server'][k] for k in ('available', 'reasons', 'webpDecode', 'pngEncode', 'webpLosslessEncode', 'migrations')}
rec['steps'].append(snapshot('format 1 (avant)'))

for mid in ('m002-planes', 'm003-layer-mips', 'm004-bricks-v3'):
    t0 = time.time()
    p = dm.plan_job(DID, mid)
    plan_sum = {k: p[k] for k in p if k != 'units'}
    plan_sum['firstUnits'] = p['units'][:4]
    s_plan = snapshot(mid + ' : après plan')
    # run a few units
    out = dm.unit_run(DID, mid, max_seconds=1)
    s_part = snapshot(mid + ' : après quelques unités')
    while True:
        out = dm.unit_run(DID, mid, max_seconds=20)
        if out['done'] >= out['total']: break
        pl = dm.plan_job(DID, mid)   # m004 runs in waves
    s_done = snapshot(mid + ' : toutes unités faites')
    fin = dm.finalize(DID, mid, 0.001)  # tiny budget: assembling, resumable
    fin_calls = [fin]
    s_asm = snapshot(mid + ' : finalize (budget minuscule)')
    while not fin.get('complete'):
        fin = dm.finalize(DID, mid, 0.5); fin_calls.append(fin)
    s_fin = snapshot(mid + ' : terminé')
    rec['steps'].extend([dict(s_plan, plan=plan_sum), s_part, s_done, dict(s_asm, finalize=fin_calls[:3], ncalls=len(fin_calls)), dict(s_fin, seconds=round(time.time() - t0, 2))])
    meta = json.loads((ds / 'metadata.json').read_text())
    rec['steps'][-1]['formatVersion'] = meta.get('formatVersion')
(HERE / 'data').mkdir(exist_ok=True)
(HERE / 'data' / 'real_migration.json').write_text(json.dumps(rec, indent=1, default=str))
shutil.rmtree(W, ignore_errors=True)
print('ok')
