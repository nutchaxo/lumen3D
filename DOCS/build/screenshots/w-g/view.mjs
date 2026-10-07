import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
import fs from 'fs';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const D='/home/user/lumen3D/DOCS/documentation/img/';
for (const f of process.argv.slice(2)) {
  const svg = fs.readFileSync(D+f,'utf8');
  await p.setContent(`<body style="margin:0;background:#fff"><div style="width:1600px">${svg.replace('<svg ','<svg width="1600" ')}</div></body>`);
  await p.locator('svg').screenshot({ path: `/tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad/w-g/v_${f.replace(/\//g,'_')}.png` });
}
await b.close();
