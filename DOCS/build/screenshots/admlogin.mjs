import { newPage, BASE, sleep } from './shotlib.mjs';
export async function adminPage(b, opts = {}) {
  const page = await newPage(b, { width: 1600, height: 950, ...opts });
  await page.goto(BASE + '/admpan.html', { waitUntil: 'networkidle' });
  await sleep(800);
  await page.fill('#login-username', 'admin');
  await page.fill('#login-password', (process.env.ADMIN_PASSWORD || ''));
  await page.click('#btn-login');
  await sleep(2500);
  return page;
}
export async function goTab(page, hash, wait = 2500) {
  await page.evaluate(h => { location.hash = h; }, hash);
  await sleep(wait);
}
