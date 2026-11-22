// Coverage of the dialog capture over the Studio's commands (local report; never CI).
//   node tools/ij_fixtures/macro/capture_coverage.mjs [--json]
// A Studio command is matched to a captured ImageJ / Fiji command by its English label ('…' read as '...'): the exact name, and the
// trailing-space twin when the jar has one (both are reported, a Studio command is covered when either was captured).
import fs from 'node:fs';
import path from 'node:path';
import { boot, EN } from '../../../tests/js/ij_harness.mjs';
import { ROOT } from '../../../tests/js/harness.mjs';

const read = (f) => { const p = path.join(ROOT, 'tests', 'fixtures', 'ij-macro', f); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
const ij = read('ij-dialogs.json'), fiji = read('fiji-macro-keys.json');
const table = Object.assign({}, ij && ij.commands, fiji && fiji.commands);
const fijiNames = { procCLAHE: 'Enhance Local Contrast (CLAHE)', pluginsFrangi: 'Frangi Vesselness', pluginsTubeness: 'Tubeness', analyzeDirectionality: 'Directionality',
  skelAnalyze: 'Analyze Skeleton (2D/3D)', ltComplete: 'Local Thickness (complete process)', colocColoc2: 'Coloc 2', pluginsCellCounter: 'Cell Counter',
  adjustAutoThreshold: 'Auto Threshold', adjustAutoLocalThreshold: 'Auto Local Threshold', lut16Colors: '16 colors', lutHiLo: 'HiLo' };
const t = await boot({});
const rows = [];
for (const c of t.IJApp.COMMANDS) {
  const label = String(EN.cmd[c.id] || '').replace(/…/g, '...');
  const names = fijiNames[c.id] ? [fijiNames[c.id]] : [label, label + ' '].filter((n) => table[n]);
  const hits = names.map((n) => ({ n, e: table[n] })).filter((x) => x.e);
  let status;
  if (!hits.length) status = 'no-jar-command';
  else if (hits.some((x) => x.e.dialogs && x.e.dialogs.length)) status = 'dialog';
  else if (hits.some((x) => x.e.noDialog)) status = 'no-dialog';
  else status = 'not-captured';
  rows.push({ id: c.id, label, status, names: hits.map((x) => x.n), why: hits.map((x) => x.e.skipped).filter(Boolean).join(' | ') || undefined });
}
t.close();
const count = {};
for (const r of rows) count[r.status] = (count[r.status] || 0) + 1;
if (process.argv.includes('--json')) console.log(JSON.stringify({ count, rows }, null, 1));
else {
  console.log('Studio commands:', rows.length, JSON.stringify(count));
  for (const s of ['not-captured', 'no-jar-command']) { console.log('\n' + s + ':'); for (const r of rows.filter((x) => x.status === s)) console.log('  ' + r.id + '  ' + JSON.stringify(r.label) + (r.why ? '  -> ' + r.why : '')); }
}
process.exit(0);
