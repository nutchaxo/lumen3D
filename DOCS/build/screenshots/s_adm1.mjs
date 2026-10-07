import { launch, newPage, shot, BASE, sleep } from './shotlib.mjs';
import { adminPage, goTab } from './admlogin.mjs';
const b = await launch();
// login screen
{ const p = await newPage(b, { width: 1400, height: 900 });
  await p.goto(BASE + '/admpan.html', { waitUntil: 'networkidle' }); await sleep(1000);
  await p.fill('#login-username', 'admin'); await p.fill('#login-password', 'xxxxxxxxxx');
  await shot(p, 'login', { targets: [
    { sel: '#login-username', n: 1, label: 'Identifiant', side: 'left' },
    { sel: '#login-password', n: 2, label: 'Mot de passe', side: 'left' },
    { sel: '#btn-login', n: 3, label: 'Se connecter', side: 'right' } ]});
  await p.close(); }
const page = await adminPage(b);
await goTab(page, '#datasets', 6000);
await shot(page, 'raw-datasets');
await b.close();
