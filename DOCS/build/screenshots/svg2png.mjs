import { launch } from './shotlib.mjs';
import { pathToFileURL } from 'url';
const files = process.argv.slice(2);
const b = await launch(); const p = await b.newPage({ viewport: { width: 800, height: 600 } });
for (const f of files) { await p.goto(pathToFileURL(f).href); const el = p.locator('svg'); await el.screenshot({ path: f.replace(/\.svg$/, '.check.png'), timeout: 120000 }); }
await b.close();
