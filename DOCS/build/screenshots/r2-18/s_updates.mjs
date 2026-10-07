// Read-only screenshot of the admin "Mises à jour" tab (nothing is clicked except tab navigation).
// UI_LANG=fr|en selects the interface language; SHOT_OUT is the output folder.
import { launch, shot } from '../shotlib.mjs';
import { adminPage, goTab } from '../admlogin.mjs';
const lang = process.env.UI_LANG || 'fr';
const b = await launch();
const page = await adminPage(b, { lang });
await goTab(page, '#updates', 9000);
await shot(page, 'maj-onglet', {
  clip: { x: 250, y: 58, width: 1350, height: 700 },
  targets: [
    { sel: '#tab-updates .adm-card:nth-of-type(1), #tab-updates section:nth-of-type(1)', n: 1, side: 'left', box: { x: 416, y: 162, width: 1016, height: 166 }, dx: 30 },
    { n: 2, side: 'left', box: { x: 416, y: 347, width: 1016, height: 113 }, dx: 30 },
    { n: 3, side: 'left', box: { x: 416, y: 480, width: 1016, height: 118 }, dx: 30 },
    { n: 4, side: 'left', box: { x: 416, y: 616, width: 1016, height: 118 }, dx: 30 },
    { n: 5, side: 'left', box: { x: 1336, y: 86, width: 96, height: 31 } },
  ],
});
await b.close();
