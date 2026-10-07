import { launch, newPage, shot, sleep, BASE, annotate, clearCallouts } from '../shotlib.mjs';
import { adminPage, goTab } from '../admlogin.mjs';
const lang = 'en';
const b = await launch();
const page = await adminPage(b, { lang });
await goTab(page, '#appearance', 16000);
await page.mouse.move(5,5); await sleep(4000);
const fr=page.frames().find(f=>/page|index|\.html/.test(f.url())&&f!==page.mainFrame()); if(fr){ console.log(fr.url(), await fr.evaluate(()=>[...document.querySelectorAll('.hero a, .hero-actions *, a[href*=explorer]')].slice(0,6).map(e=>e.textContent.trim()+'|'+getComputedStyle(e).color+'|'+getComputedStyle(e).opacity)).catch(e=>String(e))); }
await shot(page, 'apparence', { targets: [
  { sel: '.adm-color-input', nth: 0, n: 1, side: 'left' },
  { sel: '#appearance-font', n: 2, side: 'left' },
  { sel: '#appearance-radius', n: 3, side: 'left' },
  { sel: '#appearance-preview', n: 4, side: 'inside', dx: -300, dy: -150 },
  { sel: '#appearance-save', n: 5, side: 'bottom' },
] });
await b.close();
