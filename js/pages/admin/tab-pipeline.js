/**
 * Admin SPA — Pipeline tab
 * ========================
 * Hands the operator a self-contained pack for turning raw microscope output into
 * datasets this platform can serve: the Imaris `.ims` volume pipeline plus the
 * Imaris-Excel cell-tracking pipeline, each with a worked example, driven by a
 * launcher that verifies its own integrity before running anything.
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

function fmtSize(bytes) {
  if (!bytes || bytes < 0) return '—';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} Mo` : `${Math.round(bytes / 1024)} Ko`;
}

function editionCard(key, opts) {
  const info = (_info && _info[key]) || { available: false };
  const size = info.size ? ` · ${fmtSize(info.size)}` : '';

  let action;
  let note = '';
  if (_loading) {
    action = `<button class="adm-btn adm-btn-ghost" disabled><span class="spinner spinner-sm"></span> ${escHtml(t('admin.pipelineChecking', 'Vérification…'))}</button>`;
  } else if (info.available && info.source === 'local') {
    // A plain navigation, not fetch(): the session cookie is SameSite=Lax so it
    // rides along, and the browser streams the file straight to disk instead of
    // buffering tens of megabytes in a Blob.
    action = `<a class="adm-btn adm-btn-accent" href="${escHtml(API_ADMIN)}?action=pipeline_download&amp;edition=${escHtml(key)}" download>
                <i data-lucide="download"></i> ${escHtml(t('admin.pipelineDownload', 'Télécharger'))}${escHtml(size)}
              </a>`;
  } else if (info.available && info.url) {
    action = `<a class="adm-btn adm-btn-accent" href="${escHtml(info.url)}" target="_blank" rel="noopener">
                <i data-lucide="external-link"></i> ${escHtml(t('admin.pipelineDownload', 'Télécharger'))}${escHtml(size)}
              </a>`;
    note = t('admin.pipelineFromGithub', 'Téléchargé depuis la page des versions publiées ({tag}).', { tag: info.tag || '—' });
  } else {
    action = `<button class="adm-btn adm-btn-ghost" disabled><i data-lucide="download-cloud"></i> ${escHtml(t('admin.pipelineUnavailable', 'Indisponible'))}</button>`;
    note = info.reason === 'unreachable'
      ? t('admin.pipelineUnreachable', "Impossible de joindre GitHub pour récupérer cette édition. L'édition légère reste disponible.")
      : t('admin.pipelineNotPublished', "Cette édition n'est pas jointe à la dernière version publiée. Utilisez l'édition légère, ou publiez le pack complet depuis le dépôt.");
  }

  return `
    <div class="adm-card">
      <div class="adm-card-head"><i data-lucide="${escHtml(opts.icon)}"></i><span>${escHtml(opts.title)}</span></div>
      <div class="adm-card-body">
        <p class="adm-page-sub">${escHtml(opts.sub)}</p>
        <ul class="adm-bullets">
          ${opts.points.map((p) => `<li><i data-lucide="${escHtml(p.icon)}"></i><span>${escHtml(p.text)}</span></li>`).join('')}
        </ul>
        ${action}
        ${note ? `<p class="adm-page-sub" style="margin-top:10px">${escHtml(note)}</p>` : ''}
      </div>
    </div>`;
}

function render() {
  const root = el('pipeline-root');
  if (!root) return;

  const versions = (_info && _info.versions) || {};

  root.innerHTML = `
    <div class="adm-page-head">
      <h2 class="adm-page-title">${escHtml(t('admin.navPipeline', 'Pipeline de traitement'))}</h2>
      <p class="adm-page-sub">${escHtml(t('admin.pipelinePageSub', "Téléchargez le pack de traitement des données : préprocessing des volumes Imaris (.ims) et analyse du tracking cellulaire (export Excel Imaris). Le pack est autonome et s'exécute sur un poste Windows, hors de ce serveur."))}</p>
    </div>

    <div class="adm-card" style="margin-bottom:18px">
      <div class="adm-card-head"><i data-lucide="workflow"></i><span>${escHtml(t('admin.pipelineWhatTitle', 'Ce que contient le pack'))}</span></div>
      <div class="adm-card-body">
        <ul class="adm-bullets">
          <li><i data-lucide="box"></i><span>${escHtml(t('admin.pipelineWhat1', 'Pipeline volumes : convertit les piles Imaris .ims en jeux de données découpés en briques, avec pyramide de niveaux de détail, vignette et métadonnées.'))}</span></li>
          <li><i data-lucide="git-branch"></i><span>${escHtml(t('admin.pipelineWhat2', "Pipeline tracking : lit l'export Excel produit par Imaris, reconstitue les lignées cellulaires (mitoses comprises), stabilise les trajectoires et calcule les métriques."))}</span></li>
          <li><i data-lucide="link"></i><span>${escHtml(t('admin.pipelineWhat3', 'Rattachement : associe un tracking analysé à un jeu de données déjà traité, pour superposer les trajectoires aux images.'))}</span></li>
          <li><i data-lucide="flask-conical"></i><span>${escHtml(t('admin.pipelineWhat4', "Un exemple d'entrée pour chaque pipeline : le pack est utilisable immédiatement, sans donnée réelle."))}</span></li>
          <li><i data-lucide="shield-check"></i><span>${escHtml(t('admin.pipelineWhat5', "Un lanceur RUN.bat qui vérifie l'intégrité des fichiers (SHA-256), contrôle l'installation de Python et de ses dépendances, puis lance le traitement choisi."))}</span></li>
        </ul>
        <p class="adm-page-sub" style="margin-top:12px">
          ${escHtml(t('admin.pipelineVersions', 'Version du pack : {web} · pipeline de préprocessing : {pp}', {
            web: versions.web || '—', pp: versions.preprocess || '—',
          }))}
        </p>
      </div>
    </div>

    <div class="adm-grid adm-grid-2">
      ${editionCard('complet', {
        icon: 'package-check',
        title: t('admin.pipelineFullTitle', 'Édition complète (hors-ligne)'),
        sub: t('admin.pipelineFullSub', "Tout est embarqué, Python compris. À utiliser sur un poste sans accès internet, ou pour garantir un environnement identique d'une installation à l'autre."),
        points: [
          { icon: 'wifi-off', text: t('admin.pipelineFullP1', 'Aucun accès réseau nécessaire, à aucun moment.') },
          { icon: 'lock', text: t('admin.pipelineFullP2', "Versions des bibliothèques scientifiques figées : deux postes produisent le même résultat.") },
          { icon: 'hard-drive', text: t('admin.pipelineFullP3', 'Environ 70 Mo à télécharger, 200 Mo une fois décompressé.') },
        ],
      })}
      ${editionCard('leger', {
        icon: 'package',
        title: t('admin.pipelineLiteTitle', 'Édition légère'),
        sub: t('admin.pipelineLiteSub', "Les scripts et les exemples uniquement. Python et les bibliothèques sont récupérés au premier lancement, dans un environnement isolé propre au pack."),
        points: [
          { icon: 'feather', text: t('admin.pipelineLiteP1', 'Quelques mégaoctets seulement.') },
          { icon: 'globe', text: t('admin.pipelineLiteP2', "Connexion internet requise une seule fois, au premier lancement.") },
          { icon: 'shield', text: t('admin.pipelineLiteP3', "Le Python déjà installé sur le poste n'est jamais modifié.") },
        ],
      })}
    </div>

    <div class="adm-card" style="margin-top:18px">
      <div class="adm-card-head"><i data-lucide="info"></i><span>${escHtml(t('admin.pipelineUsageTitle', 'Utilisation'))}</span></div>
      <div class="adm-card-body">
        <ul class="adm-bullets">
          <li><i data-lucide="download"></i><span>${escHtml(t('admin.pipelineUsage1', "Décompressez l'archive sur le poste de traitement, puis double-cliquez sur RUN.bat."))}</span></li>
          <li><i data-lucide="folder-input"></i><span>${escHtml(t('admin.pipelineUsage2', 'Déposez les fichiers .ims dans input\\, et les exports Excel dans tracking\\DATA\\<échantillon>\\.'))}</span></li>
          <li><i data-lucide="alert-triangle"></i><span>${escHtml(t('admin.pipelineUsage3', "Le nom du fichier Excel doit contenir l'intervalle entre images (par exemple 30min) : l'analyse y lit sa base de temps."))}</span></li>
          <li><i data-lucide="folder-output"></i><span>${escHtml(t('admin.pipelineUsage4', 'Copiez ensuite le dossier produit dans le DATA_WEB\\ du serveur : il apparaît aussitôt dans le catalogue.'))}</span></li>
          <li><i data-lucide="cpu"></i><span>${escHtml(t('admin.pipelineUsage5', "La mémoire vive est la vraie contrainte : comptez environ 32 Go pour un volume de 3789 × 3789 × 178."))}</span></li>
        </ul>
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
