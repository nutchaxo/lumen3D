// Prints an HTML document to an A4 PDF with Chromium (Playwright).
// Usage: node print_pdf.mjs <in.html> <out.pdf> <footer-title> [--links <out.json>]
//   --links: also write, for every internal link of the document, the PDF page its
//   target lands on (used by build_docs.py to fill the table of contents).
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import fs from 'fs';

const require = createRequire(import.meta.url);
let playwright;
for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright']) {
  try { playwright = require(p); break; } catch (_) { /* next */ }
}
if (!playwright) { console.error('playwright not found'); process.exit(2); }

const [, , input, output, footerTitle = '', ...rest] = process.argv;
const linksOut = rest[0] === '--links' ? rest[1] : null;

const browser = await playwright.chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(input).href, { waitUntil: 'networkidle' });
await page.evaluate(async () => {
  await document.fonts.ready;
  await Promise.all([...document.images].map(img => img.complete ? null :
    new Promise(r => { img.onload = img.onerror = r; })));
});

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const footer = `
  <div style="width:100%;font-family:Inter,sans-serif;font-size:7.5px;color:#8a93a6;
              padding:0 14mm;display:flex;justify-content:space-between;">
    <span>${esc(footerTitle)}</span>
    <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
  </div>`;

await page.pdf({
  path: output,
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate: footer,
  margin: { top: '14mm', bottom: '16mm', left: '0', right: '0' },
  outline: true,
  tagged: true,
  preferCSSPageSize: false,
});

if (linksOut) {
  // Heading ids in document order; the PDF side is resolved by build_docs.py.
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('h1[id], h2[id]')].map(h => h.id));
  fs.writeFileSync(linksOut, JSON.stringify(ids));
}
await browser.close();
