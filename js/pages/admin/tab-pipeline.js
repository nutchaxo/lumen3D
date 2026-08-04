/**
 * Admin SPA — Pipeline tab
 * ========================
 * Hands the operator a self-contained pack for turning raw microscope output into
 * datasets this platform can serve: the Imaris `.ims` volume pipeline plus the
 * Imaris-Excel cell-tracking pipeline, each with a worked example, driven by a
 * launcher that verifies its own integrity before running anything.
 *
 * The page is deliberately schematic rather than descriptive: a four-box flow for
 * what the pack does, a side-by-side spec sheet for the one decision the operator
 * actually has to make (which edition), and three numbered steps for the run. What
 * used to be thirteen paragraphs of prose now lives in the pack's own LISEZ-MOI.
 *
 * Two editions, delivered differently on purpose (see dev_server.py:_pipeline_info):
 *   — light: shipped inside the release, served by this host, needs the network once.
 *   — complete: carries a whole Python runtime, so it is attached to the GitHub
 *     release and the browser fetches it from there. The host never proxies it.
 */

'use strict';

import { API_ADMIN, t, escHtml, apiFetch, toast, el, refreshIcons } from './shared.js';

let _info = null;
let _loading = true;

const unitMB = () => t('admin.pipelineUnitMB', 'Mo');

function fmtSize(bytes) {
  if (!bytes || bytes < 0) return null;
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} ${unitMB()}`
                 : `${Math.round(bytes / 1024)} ${t('admin.pipelineUnitKB', 'Ko')}`;
}

/** One box of the "what the pack does" flow, followed by its arrow. */
function flowStep(icon, title, sub, last) {
  return `
    <li class="adm-flow-step">
      <span class="adm-flow-ic"><i data-lucide="${escHtml(icon)}"></i></span>
      <b>${escHtml(title)}</b>
      <em>${escHtml(sub)}</em>
    </li>
    ${last ? '' : '<li class="adm-flow-arrow" aria-hidden="true"><i data-lucide="chevron-right"></i></li>'}`;
}

/**
 * One edition. `opts.specs` are the three lines that decide the choice — size,
 * network, Python — answered in a couple of words each rather than in a sentence.
 */
function editionCard(key, opts) {
  const info = (_info && _info[key]) || { available: false };
  const size = fmtSize(info.size) || opts.sizeFallback;

  let action;
  let note = '';
  if (_loading) {
    action = `<button class="adm-btn adm-btn-ghost adm-pl-dl" disabled>
                <span class="spinner spinner-sm"></span> ${escHtml(t('admin.pipelineChecking', 'Vérification…'))}
              </button>`;
  } else if (info.newer && info.newer.url) {
    // A newer pack than this host's has been published. Offer it as the primary
    // action and keep the installed one reachable — an offline processing station
    // may well be why the operator came here.
    action = `<a class="adm-btn adm-btn-accent adm-pl-dl" href="${escHtml(info.newer.url)}" target="_blank" rel="noopener">
                <i data-lucide="download-cloud"></i> ${escHtml(t('admin.pipelineDownloadNew', 'Télécharger la v{v}', { v: info.newer.version || '—' }))}
              </a>
              ${info.source === 'local' ? `
              <a class="adm-btn adm-btn-ghost adm-pl-dl2" href="${escHtml(API_ADMIN)}?action=pipeline_download&amp;edition=${escHtml(key)}" download>
                <i data-lucide="download"></i> ${escHtml(t('admin.pipelineDownloadInstalled', 'Version installée (v{v})', { v: info.version || '—' }))}
              </a>` : ''}`;
    note = t('admin.pipelineNewerNote', 'Une version plus récente du pack est publiée ({tag}).', { tag: info.newer.tag || '—' });
  } else if (info.available && info.source === 'local') {
    // A plain navigation, not fetch(): the session cookie is SameSite=Lax so it
    // rides along, and the browser streams the file straight to disk instead of
    // buffering tens of megabytes in a Blob.
    action = `<a class="adm-btn adm-btn-accent adm-pl-dl" href="${escHtml(API_ADMIN)}?action=pipeline_download&amp;edition=${escHtml(key)}" download>
                <i data-lucide="download"></i> ${escHtml(t('admin.pipelineDownload', 'Télécharger'))}
              </a>`;
  } else if (info.available && info.url) {
    action = `<a class="adm-btn adm-btn-accent adm-pl-dl" href="${escHtml(info.url)}" target="_blank" rel="noopener">
                <i data-lucide="external-link"></i> ${escHtml(t('admin.pipelineDownload', 'Télécharger'))}
              </a>`;
    note = t('admin.pipelineFromGithub', 'Téléchargé depuis la page des versions publiées ({tag}).', { tag: info.tag || '—' });
  } else {
    action = `<button class="adm-btn adm-btn-ghost adm-pl-dl" disabled>
                <i data-lucide="download-cloud"></i> ${escHtml(t('admin.pipelineUnavailable', 'Indisponible'))}
              </button>`;
    note = info.reason === 'unreachable'
      ? t('admin.pipelineUnreachable', "Impossible de joindre GitHub pour récupérer cette édition. L'édition légère reste disponible.")
      : t('admin.pipelineNotPublished', "Cette édition n'est pas jointe à la dernière version publiée. Utilisez l'édition légère, ou publiez le pack complet depuis le dépôt.");
  }

  const specs = [
    { icon: 'hard-drive', label: t('admin.pipelineSpecSize', 'Taille'), value: _loading ? '…' : size },
    { icon: 'globe', label: t('admin.pipelineSpecNet', 'Internet'), value: opts.net },
    { icon: 'terminal', label: t('admin.pipelineSpecPython', 'Python'), value: opts.python },
  ];

  return `
    <div class="adm-card adm-ed${opts.recommended ? ' is-reco' : ''}">
      <div class="adm-card-head">
        <i data-lucide="${escHtml(opts.icon)}"></i><span>${escHtml(opts.title)}</span>
        ${opts.recommended ? `<span class="adm-tag adm-tag-ok adm-ed-badge">${escHtml(t('admin.pipelineRecommended', 'Recommandé'))}</span>` : ''}
      </div>
      <div class="adm-card-body">
        <p class="adm-ed-for"><i data-lucide="${escHtml(opts.forIcon)}"></i>${escHtml(opts.forWhom)}</p>
        <dl class="adm-specs">
          ${specs.map((s) => `
            <div>
              <dt><i data-lucide="${escHtml(s.icon)}"></i>${escHtml(s.label)}</dt>
              <dd>${escHtml(s.value || '—')}</dd>
            </div>`).join('')}
        </dl>
        ${note ? `<p class="adm-ed-note">${escHtml(note)}</p>` : ''}
        ${action}
      </div>
    </div>`;
}

function render() {
  const root = el('pipeline-root');
  if (!root) return;

  const versions = (_info && _info.versions) || {};
  // The pack IS the preprocessing tool, so it carries that component's version —
  // the same number the Updates tab reports, and now the one in its filename.
  const packVer = versions.preprocess || '—';
  // Only packs built from web v1.42.0 on record which release they shipped with;
  // for an older one the line is dropped rather than guessed from this install.
  const platformVer = versions.platform || null;
  const upd = (_info && _info.update) || {};

  // The pack moves on the preprocessing tool's own numbers, so a newer one can be
  // published without any platform release — which is exactly the case this banner
  // exists to make visible.
  const updateBanner = upd.available ? `
    <div class="adm-choice adm-choice-accent" style="margin-bottom:16px">
      <i data-lucide="sparkles"></i>
      <span><b>${escHtml(t('admin.pipelineUpdateTitle', 'Nouvelle version du pack : v{remote}', { remote: upd.remote || '—' }))}</b>
        ${escHtml(t('admin.pipelineUpdateHint', 'Ce serveur propose la v{local}. Téléchargez la nouvelle ci-dessous — la plateforme n\'a pas besoin d\'être mise à jour pour ça.', { local: upd.local || '—' }))}</span>
    </div>` : '';

  root.innerHTML = `
    <div class="adm-page-head">
      <div>
        <h2 class="adm-page-title">${escHtml(t('admin.navPipeline', 'Pipeline de traitement'))}</h2>
        <p class="adm-page-sub">${escHtml(t('admin.pipelinePageSub', "Le pack qui transforme les sorties du microscope en jeux de données publiables. Il s'exécute sur un poste Windows, hors de ce serveur."))}</p>
      </div>
    </div>

    ${updateBanner}

    <div class="adm-card" style="margin-bottom:16px">
      <div class="adm-card-head">
        <i data-lucide="workflow"></i><span>${escHtml(t('admin.pipelineFlowTitle', 'Le principe'))}</span>
        <span class="adm-card-count">${escHtml(t('admin.pipelineVerChip', 'pipeline v{pp}', { pp: packVer }))}</span>
      </div>
      <div class="adm-card-body">
        <ol class="adm-flow">
          ${flowStep('microscope', t('admin.pipelineFlow1', 'Fichiers bruts'), t('admin.pipelineFlow1Sub', '.ims · export Excel'))}
          ${flowStep('play', t('admin.pipelineFlow2', 'RUN.bat'), t('admin.pipelineFlow2Sub', 'Sur un poste Windows'))}
          ${flowStep('box', t('admin.pipelineFlow3', 'Jeu de données'), t('admin.pipelineFlow3Sub', 'Volumes + trajectoires'))}
          ${flowStep('globe-2', t('admin.pipelineFlow4', 'DATA_WEB\\'), t('admin.pipelineFlow4Sub', 'Visible dans le catalogue'), true)}
        </ol>
        <div class="adm-featchips">
          <span><i data-lucide="git-branch"></i>${escHtml(t('admin.pipelineFeat1', '2 pipelines : volumes + tracking'))}</span>
          <span><i data-lucide="flask-conical"></i>${escHtml(t('admin.pipelineFeat2', 'Exemples inclus'))}</span>
          <span><i data-lucide="shield-check"></i>${escHtml(t('admin.pipelineFeat3', 'Intégrité vérifiée (SHA-256)'))}</span>
        </div>
        ${platformVer ? `<p class="adm-pl-ver">${escHtml(t('admin.pipelineVersions', 'Livré avec la plateforme v{web}', { web: platformVer }))}</p>` : ''}
      </div>
    </div>

    <div class="adm-choice">
      <i data-lucide="git-fork"></i>
      <span><b>${escHtml(t('admin.pipelineChoose', 'Quelle édition ?'))}</b> ${escHtml(t('admin.pipelineChooseHint', 'Le poste de traitement a-t-il accès à internet ? Oui → légère. Non → complète.'))}</span>
    </div>

    <div class="adm-grid adm-grid-2">
      ${editionCard('leger', {
        icon: 'feather',
        recommended: true,
        title: t('admin.pipelineLiteTitle', 'Édition légère'),
        forIcon: 'wifi',
        forWhom: t('admin.pipelineLiteFor', 'Poste connecté à internet.'),
        sizeFallback: `~3 ${unitMB()}`,
        net: t('admin.pipelineLiteNet', 'Une seule fois, au 1er lancement'),
        python: t('admin.pipelineLitePython', 'Installé par le pack, à part du système'),
      })}
      ${editionCard('complet', {
        icon: 'package-check',
        title: t('admin.pipelineFullTitle', 'Édition complète (hors-ligne)'),
        forIcon: 'wifi-off',
        forWhom: t('admin.pipelineFullFor', 'Poste isolé du réseau, ou environnement à figer.'),
        sizeFallback: `~70 ${unitMB()}`,
        net: t('admin.pipelineFullNet', 'Jamais'),
        python: t('admin.pipelineFullPython', 'Embarqué, versions figées'),
      })}
    </div>

    <div class="adm-card" style="margin-top:16px">
      <div class="adm-card-head"><i data-lucide="list-ordered"></i><span>${escHtml(t('admin.pipelineStepsTitle', 'Utilisation'))}</span></div>
      <div class="adm-card-body">
        <ol class="adm-steps">
          <li><span class="adm-step-n">1</span><span>${escHtml(t('admin.pipelineStep1', 'Décompressez le pack, puis double-cliquez sur RUN.bat.'))}</span></li>
          <li><span class="adm-step-n">2</span><span>${escHtml(t('admin.pipelineStep2', 'Déposez vos fichiers : les .ims dans input\\, les exports Excel dans tracking\\DATA\\<échantillon>\\.'))}</span></li>
          <li><span class="adm-step-n">3</span><span>${escHtml(t('admin.pipelineStep3', 'Copiez le dossier produit dans le DATA_WEB\\ du serveur : il apparaît aussitôt dans le catalogue.'))}</span></li>
        </ol>
        <p class="adm-note"><i data-lucide="alert-triangle"></i><span>${escHtml(t('admin.pipelineNote', "À savoir : le nom du fichier Excel doit contenir l'intervalle entre images (ex. 30min), l'analyse y lit sa base de temps. Comptez ~32 Go de mémoire vive pour un volume de 3789 × 3789 × 178."))}</span></p>
      </div>
    </div>`;

  refreshIcons(root);
}

async function load() {
  _loading = true;
  render();
  // Reaches GitHub to look for the complete edition, so it can take a moment; the
  // light edition's availability is resolved locally and never blocks on that.
  _info = await apiFetch(`${API_ADMIN}?action=pipeline_info`);
  _loading = false;
  if (!_info) toast(t('admin.pipelineLoadError', 'Impossible de lire l\'état des packs de traitement.'), 'error');
  render();
}

export const PipelineTab = {
  id: 'pipeline',
  titleKey: 'admin.navPipeline',
  titleDefault: 'Pipeline',
  mounted: false,
  mount() { load(); },
  activate() {},
  relabel() { render(); },
};
