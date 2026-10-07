import { launch, newPage, shot, BASE, sleep } from './shotlib.mjs';
const b = await launch();
const page = await newPage(b, { width: 1400, height: 900 });
await page.goto(BASE + '/admpan.html', { waitUntil: 'networkidle' });
await sleep(1500);
await page.fill('#setup-username', 'admin');
await page.fill('#setup-password', (process.env.ADMIN_PASSWORD || ''));
await page.fill('#setup-password2', (process.env.ADMIN_PASSWORD || ''));
await shot(page, 'wizard-1-account', { targets: [
  { sel: '#setup-stepper', n: 1, label: 'Progression', side: 'right' },
  { sel: '#setup-username', n: 2, label: 'Identifiant', side: 'left' },
  { sel: '#setup-password', n: 3, label: 'Mot de passe', side: 'left' },
  { sel: '#setup-password2', n: 4, label: 'Confirmation', side: 'left' },
  { sel: '#setup-next', n: 5, label: 'Suivant', side: 'right' },
]});
await page.click('#setup-next'); await sleep(2500);
await page.fill('#setup-name', 'IRIBHM Microscopy Platform');
await page.fill('#setup-org', 'IRIBHM — ULB');
await shot(page, 'wizard-2-identity', { targets: [
  { sel: '#setup-name', n: 1, label: "Nom de l'instance", side: 'left' },
  { sel: '#setup-org', n: 2, label: 'Organisation', side: 'left' },
  { sel: '#setup-spec-s', n: 3, label: 'Objet', side: 'left' },
  { sel: '#setup-skip', n: 4, label: 'Passer', side: 'bottom' },
]});
await page.click('#setup-next'); await sleep(1200);
await shot(page, 'wizard-3-theme', { targets: [ { sel: '#setup-swatches', n: 1, label: 'Couleur de marque', side: 'left' } ]});
await page.click('#setup-next'); await sleep(1200);
await shot(page, 'wizard-4-texts', { targets: [
  { sel: '#setup-tagline', n: 1, label: 'Accroche', side: 'left' },
  { sel: '#setup-copyright', n: 2, label: 'Pied de page', side: 'left' } ]});
await page.click('#setup-next'); await sleep(6000);
await shot(page, 'wizard-5-plugins', { targets: [ { sel: '#setup-plugins', n: 1, label: 'Plugins à installer', side: 'left' }, { sel: '#setup-next', n: 2, label: 'Terminer', side: 'right' } ]});
console.log(await page.locator('#setup-plugins').innerText().catch(()=>'' ).then(t=>t.slice(0,400)));
await b.close();
