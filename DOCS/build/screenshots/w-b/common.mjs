import { launch, newPage as np, shot, sleep, BASE, annotate, clearCallouts } from '../shotlib.mjs';
import fs from 'fs';
export { launch, shot, sleep, BASE };
export const LANG = process.env.UI_LANG || 'fr';
export const IMG_ROOT = process.env.IMG_DIR_ROOT || '/home/user/lumen3D/DOCS/documentation/img';
export const OUTBASE = process.env.IMG_DIR_BASE; // e.g. .../img-en  -> files go to OUTBASE/chNN
export function outDir(ch) { const d = (OUTBASE ? OUTBASE : IMG_ROOT) + '/' + ch; fs.mkdirSync(d, { recursive: true }); return d; }
export const newPage = (b, o = {}) => np(b, { lang: LANG, ...o });
// small fr/en dictionary for callout labels
const D = {
  fr: { nav:'Navigation', brand:'Identité du site', hero:'Message d’accueil', cta:'Boutons d’action', types:'Types de données', lang:'Langue, daltonisme, thème',
        search:'Recherche', ftype:'Filtre par type', fstage:'Filtre par stade', sort:'Tri et affichage', card:'Fiche d’un jeu de données', badge:'Type', actions:'Voir / Comparer / Télécharger',
        tools:'Outils', export:'Exporter', visuals:'Visuels', layouts:'Dispositions', help:'Aide', channels:'Canaux', display:'Affichage', quality:'Qualité', canvas:'Volume 3D', overlay:'Vue (centrer, réinitialiser, export)',
        timeline:'Ligne de temps', play:'Lecture', scrub:'Curseur de temps', tracking:'Points de suivi', specimen:'Fiche du spécimen', img:'Photographie', scalebar:'Barre d’échelle', measures:'Mesures',
        add:'Ajouter un jeu de données', toolsC:'Outils communs', sync:'Synchronisation', layout:'Disposition', qual:'Qualité', panel:'Panneau (un viewer complet)', 
        sidebar:'Menu des onglets', tabs:'Onglets', content:'Contenu de l’onglet' },
  en: { nav:'Navigation', brand:'Site identity', hero:'Welcome message', cta:'Action buttons', types:'Data types', lang:'Language, colour-blind, theme',
        search:'Search', ftype:'Type filter', fstage:'Stage filter', sort:'Sort and view', card:'A dataset card', badge:'Type', actions:'View / Compare / Download',
        tools:'Tools', export:'Export', visuals:'Visuals', layouts:'Layouts', help:'Help', channels:'Channels', display:'Display', quality:'Quality', canvas:'3D volume', overlay:'View (centre, reset, export)',
        timeline:'Timeline', play:'Play', scrub:'Time slider', tracking:'Tracking points', specimen:'Specimen sheet', img:'Photograph', scalebar:'Scale bar', measures:'Measurements',
        add:'Add a dataset', toolsC:'Shared tools', sync:'Synchronisation', layout:'Layout', qual:'Quality', panel:'Panel (a full viewer)',
        sidebar:'Tab menu', tabs:'Tabs', content:'Tab content' } };
export const L = k => (D[LANG] || D.fr)[k] || k;
// wait until the viewer's blocking loader is gone (software GL is slow)
export async function waitLoaded(page, maxMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const gone = await page.evaluate(() => { const l = document.getElementById('viewer-loader'); return !l || getComputedStyle(l).display === 'none' || l.classList.contains('hidden'); }).catch(() => false);
    if (gone) return true;
    await sleep(2000);
  }
  return false;
}
export async function snap(page, name, ch, opts = {}) {
  const { targets, clip } = opts;
  if (targets) await annotate(page, targets);
  await page.screenshot({ path: outDir(ch) + '/' + name + '.png', clip, timeout: 240000 });
  if (targets) await clearCallouts(page);
  console.log('shot', ch, name);
}
