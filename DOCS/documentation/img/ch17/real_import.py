"""Fait tourner le VRAI moteur d'import (upload_staging.py) dans un dossier temporaire avec le jeu
de démonstration 3D (lu seulement) et range le résultat dans data/real_import.json.   python real_import.py"""
import hashlib, json, os, shutil, sys, time
from pathlib import Path
import tempfile
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]; sys.path.insert(0, str(ROOT))
import upload_staging as us
W = Path(tempfile.mkdtemp(prefix='lumen-doc17-imp-'))
us.configure(W); us.ensure_dirs()
SRC = ROOT / 'DATA_WEB/3d/Embryo-E95-Em2-Pecam1-Sox2'
TYPE, FOLDER = '3d', 'Embryo-E95-Em2-Pecam1-Sox2'
CH = 256 * 1024
files = []
for p in sorted(SRC.rglob('*')):
    if p.is_file():
        rel = p.relative_to(SRC).as_posix()
        if rel.startswith('download/') and not rel.endswith('README.txt'): continue   # 500 MB of originals: not needed here
        files.append({'path': rel, 'size': p.stat().st_size})
# a few forbidden extras
extras = [{'path': 'evil.php', 'size': 10}, {'path': '.htaccess', 'size': 5}, {'path': '../x.png', 'size': 3},
          {'path': 'download/report.html', 'size': 3}, {'path': 'bricks/lod0/c0/pack_00.bin', 'size': 3},
          {'path': 'gallery/a.png', 'size': 3}]
res = us.plan([{'type': TYPE, 'folder': FOLDER, 'files': files + extras}], CH)
d = res['datasets'][0]
out = {'chunkSize': res['chunkSize'], 'nfiles': len(d['files']), 'rejected': d['rejected'], 'total': d['totalBytes'], 'state0': d['state']}
tiers = {}
for f in d['files']:
    t = tiers.setdefault(f['tier'], {'files': 0, 'bytes': 0, 'kinds': {}})
    t['files'] += 1; t['bytes'] += f['size']; t['kinds'][f['kind']] = t['kinds'].get(f['kind'], 0) + 1
out['tiers'] = {str(k): v for k, v in sorted(tiers.items())}
# upload in tier order, record state changes
order = sorted(d['files'], key=lambda f: (f['tier'], f['path']))
trace = []
last = None
digests = {}
def send(f):
    data = (SRC / f['path']).read_bytes()
    n = (len(data) + CH - 1) // CH
    hs = []
    for i in range(n):
        chunk = data[i * CH:(i + 1) * CH]
        h = hashlib.sha256(chunk).hexdigest(); hs.append(h)
        st, pl = us.write_chunk(TYPE, FOLDER, f['path'], i, chunk, h, f['fileId'])
        assert st == 200, (f['path'], st, pl)
    root = hashlib.sha256(b''.join(bytes.fromhex(h) for h in hs)).hexdigest()
    st, pl = us.finalize_file(TYPE, FOLDER, f['path'], root)
    assert st == 200, (f['path'], st, pl)
    return pl['state'], n
sent = 0
for f in order:
    if f['size'] == 0: continue
    state, n = send(f); sent += f['size']
    if state != last:
        trace.append({'after': f['path'], 'tier': f['tier'], 'state': state, 'bytes': sent}); last = state
out['trace'] = trace
# capture journal files
jp = us.journal_path(TYPE, FOLDER)
out['journal_names'] = sorted(p.name for p in us.STATE_DIR.iterdir())
j = json.loads(jp.read_text())
out['journal_keys'] = {k: (v if k != 'files' else f'{len(v)} files') for k, v in j.items()}
out['journal_entry_example'] = {k: j['files']['bricks/l0/c1/p00001.bin'][k] for k in j['files']['bricks/l0/c1/p00001.bin']}
out['journal_entry_manifest'] = j['files']['bricks/manifest.json']
# validate
out['validate_ok'] = us.validate_dataset(TYPE, FOLDER)
# damage cases (on a copy of staging dir): truncate a pack, remove a pack
sd = us.staging_dataset_dir(TYPE, FOLDER)
pk = sd / 'bricks/l0/c1/p00001.bin'
orig = pk.read_bytes()
pk.write_bytes(orig[:-1000]); out['validate_truncated'] = us.validate_dataset(TYPE, FOLDER)
pk.unlink(); out['validate_missing'] = us.validate_dataset(TYPE, FOLDER)
pk.write_bytes(orig)
idx = sd / 'bricks/index.bin'; ib = idx.read_bytes(); idx.write_bytes(ib[:-10] + b'\0' * 10)
out['validate_index_hash'] = us.validate_dataset(TYPE, FOLDER)
idx.write_bytes(ib)
(sd / 'stray.txt').write_text('x'); out['validate_stray'] = us.validate_dataset(TYPE, FOLDER); (sd / 'stray.txt').unlink()
out['validate_ok2'] = us.validate_dataset(TYPE, FOLDER)
# a wrong checksum chunk
st, pl = us.write_chunk(TYPE, FOLDER, 'thumbnail.webp', 0, b'abc', hashlib.sha256(b'xyz').hexdigest(), None)
out['bad_checksum'] = [st, {k: v for k, v in pl.items() if k != 'actual'}]
st, pl = us.write_chunk(TYPE, FOLDER, 'thumbnail.webp', 0, b'abc', None, None); out['no_checksum'] = [st, pl]
# log record + hex
rec = us._log_record(7, 3); out['log_record_hex'] = rec.hex(); out['log_record_fid7_idx3'] = rec.hex(' ')
# publish hidden
st, pl = us.publish_dataset(TYPE, FOLDER); out['publish1'] = [st, pl]
pub = json.loads((W / 'DATA_WEB/3d' / FOLDER / 'metadata.json').read_text())
out['published_hidden'] = pub.get('hidden')
# curated keys: edit the published metadata (as the admin would) then re-import (plan + all + overwrite)
pm = W / 'DATA_WEB/3d' / FOLDER / 'metadata.json'
pub.update({'name': 'E9.5 — Em2 (corrigé à la main)', 'orientation': [0, 0, 0, 1], 'hidden': False,
            'gallery': [{'file': 'a.png', 'caption': 'x'}], 'formatVersion': 1})
pm.write_text(json.dumps(pub, indent=2))
(W / 'DATA_WEB/3d' / FOLDER / 'gallery').mkdir(); (W / 'DATA_WEB/3d' / FOLDER / 'gallery' / 'a.png').write_bytes(b'\x89PNG\r\n\x1a\nxxxx')
res = us.plan([{'type': TYPE, 'folder': FOLDER, 'files': files}], CH)
d2 = res['datasets'][0]
out['replan_published'] = d2['published']; out['replan_state'] = d2['state']
# upload only metadata + manifest-minimum? upload everything quickly again
for f in sorted(d2['files'], key=lambda f: f['tier']):
    if f['size']: send(f)
st, pl = us.publish_dataset(TYPE, FOLDER); out['publish_no_overwrite'] = [st, pl]
st, pl = us.publish_dataset(TYPE, FOLDER, overwrite=True, hidden=False); out['publish_overwrite'] = [st, pl]
fin = json.loads(pm.read_text())
out['after_overwrite'] = {k: fin.get(k) for k in ('name', 'orientation', 'hidden', 'gallery', 'formatVersion')}
out['gallery_dir'] = (W / 'DATA_WEB/3d' / FOLDER / 'gallery' / 'a.png').exists()
out['dirs_left'] = sorted(p.name for p in (W / 'DATA_WEB/3d').iterdir())
(HERE / 'data').mkdir(exist_ok=True)
(HERE / 'data' / 'real_import.json').write_text(json.dumps(out, indent=1))
shutil.rmtree(W, ignore_errors=True)
print(json.dumps({k: out[k] for k in ('chunkSize', 'nfiles', 'rejected', 'total', 'tiers', 'trace')}, indent=1)[:3500])
