import { launch, shot, sleep, BASE } from '../shotlib.mjs';
import { adminPage, goTab } from '../admlogin.mjs';
const b = await launch();
const page = await adminPage(b);
await page.route('**/api/upload.php**', async r => { const u=r.request().url(); if(/action=(chunk|put|write)/.test(u)||r.request().method()==='PUT'||r.request().postDataBuffer()?.length>100000){ await sleep(900);} r.continue(); });
await goTab(page, '#upload', 1500);
await page.setInputFiles('#upl-input', process.env.S+'/import-src/3d/Embryo-E85-Em9-Import-Demo');
for (let i=0;i<14;i++){ await sleep(1500); await shot(page, 'imp-seq-'+i); }
await b.close();
