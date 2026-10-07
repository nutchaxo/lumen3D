import { launch, newPage, annotate, clearCallouts, BASE, sleep } from '../shotlib.mjs';
const LANG = process.env.UI_LANG, OUT = process.env.IMG_DIR, MODE = process.env.MODE || 'wizard';
const L = {
 en: { prog:'Progress', user:'Username', pass:'Password', conf:'Confirmation', next:'Next', inst:'Instance name', org:'Organization', obj:'Object', skip:'Skip', color:'Brand color', tag:'Tagline', foot:'Footer', plug:'Plugins to install', fin:'Finish', sign:'Sign in' },
 es: { prog:'Progreso', user:'Usuario', pass:'Contraseña', conf:'Confirmación', next:'Siguiente', inst:'Nombre de la instancia', org:'Organización', obj:'Objeto', skip:'Omitir', color:'Color de marca', tag:'Lema', foot:'Pie de página', plug:'Plugins a instalar', fin:'Finalizar', sign:'Iniciar sesión' },
 nl: { prog:'Voortgang', user:'Gebruikersnaam', pass:'Wachtwoord', conf:'Bevestiging', next:'Volgende', inst:'Naam van de instantie', org:'Organisatie', obj:'Object', skip:'Overslaan', color:'Merkkleur', tag:'Slogan', foot:'Voettekst', plug:'Te installeren plug-ins', fin:'Voltooien', sign:'Inloggen' },
}[LANG];
const b = await launch();
const page = await newPage(b, { width: 1400, height: 900, lang: LANG, theme: 'dark', admTheme: 'dark' });
const cardSel = MODE === 'login' ? '#login-screen .adm-gate-card, .adm-gate-card:visible' : '#setup-screen .adm-gate-card';
async function shot(name, targets) {
  await annotate(page, targets);
  const clip = await page.evaluate((cardSel) => {
    const cards = [...document.querySelectorAll('.adm-gate-card')].filter(e => e.offsetParent !== null);
    const c = cards[0].getBoundingClientRect();
    let x0 = c.left, y0 = c.top, x1 = c.right, y1 = c.bottom;
    for (const p of document.getElementById('__callouts').children) { if (p.style.border) continue; const r = p.getBoundingClientRect(); x0 = Math.min(x0, r.left); x1 = Math.max(x1, r.right); }
    x0 = Math.max(0, x0 - 24); y0 = Math.max(0, y0 - 24); x1 = Math.min(innerWidth, x1 + 22); y1 = Math.min(innerHeight, y1 + 24);
    return { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
  }, cardSel);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip });
  await clearCallouts(page); console.log('  shot', name, JSON.stringify(clip));
}
await page.goto(BASE + '/admpan.html', { waitUntil: 'networkidle' });
await sleep(1500);
if (MODE === 'login') {
  await page.fill('#login-username', 'admin'); await page.fill('#login-password', 'xxxxxxxxxx');
  await shot('login', [ { sel: '#login-username', n: 1, label: L.user, side: 'left' }, { sel: '#login-password', n: 2, label: L.pass, side: 'left' }, { sel: '#btn-login', n: 3, label: L.sign, side: 'right' } ]);
} else {
  await page.fill('#setup-username', 'admin'); await page.fill('#setup-password', (process.env.ADMIN_PASSWORD || '')); await page.fill('#setup-password2', (process.env.ADMIN_PASSWORD || ''));
  await shot('wizard-1-account', [ { sel: '#setup-stepper', n: 1, label: L.prog, side: 'right' }, { sel: '#setup-username', n: 2, label: L.user, side: 'left' }, { sel: '#setup-password', n: 3, label: L.pass, side: 'left' }, { sel: '#setup-password2', n: 4, label: L.conf, side: 'left' }, { sel: '#setup-next', n: 5, label: L.next, side: 'right' } ]);
  await page.click('#setup-next'); await sleep(2500);
  await page.fill('#setup-name', 'IRIBHM Microscopy Platform'); await page.fill('#setup-org', 'IRIBHM — ULB');
  await shot('wizard-2-identity', [ { sel: '#setup-name', n: 1, label: L.inst, side: 'left' }, { sel: '#setup-org', n: 2, label: L.org, side: 'left' }, { sel: '#setup-spec-s', n: 3, label: L.obj, side: 'left' }, { sel: '#setup-skip', n: 4, label: L.skip, side: 'bottom' } ]);
  await page.click('#setup-next'); await sleep(1200);
  await shot('wizard-3-theme', [ { sel: '#setup-swatches', n: 1, label: L.color, side: 'left' } ]);
  await page.click('#setup-next'); await sleep(1200);
  await shot('wizard-4-texts', [ { sel: '#setup-tagline', n: 1, label: L.tag, side: 'left' }, { sel: '#setup-copyright', n: 2, label: L.foot, side: 'left' } ]);
  await page.click('#setup-next'); await sleep(6000);
  await shot('wizard-5-plugins', [ { sel: '#setup-plugins', n: 1, label: L.plug, side: 'left' }, { sel: '#setup-next', n: 2, label: L.fin, side: 'right' } ]);
}
await b.close();
