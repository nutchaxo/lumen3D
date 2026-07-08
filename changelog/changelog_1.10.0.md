# Plateforme Web — v1.10.0

> **White-label — constructeur de pages par blocs (Objectif 2, pièce maîtresse).** Un **éditeur de
> pages façon Elementor** dans le panneau admin permet de construire les pages publiques par **blocs**
> (titre, texte, héros, bouton, image, galerie, statistiques dynamiques, derniers datasets, HTML…),
> de les **réordonner** (glisser-déposer / ▲▼), d'éditer chaque bloc en **multilingue**, avec **aperçu
> en direct** (brouillon poussé à l'iframe par `postMessage`), **brouillon → publication** et **retour
> au défaut**. L'opérateur crée des **pages personnalisées** (rendues par `page.html?slug=…`, ajoutées
> automatiquement à la navigation) et peut aussi **remplacer l'accueil et « À propos »** par ses propres
> blocs. Bump de la ligne mineure (Y) : nouveau sous-système majeur. Voir [DOCS/whitelabel/PLAN.md](../DOCS/whitelabel/PLAN.md) §3.2.

## [ADDED]
- **Moteur de rendu de blocs** ([js/core/page-renderer.js](../js/core/page-renderer.js)) — IIFE classique (`PageRenderer`) qui rend une liste ordonnée de blocs dans un conteneur. **11 types** : `heading`, `richtext`, `hero`, `button`, `image`, `gallery`, `stat-grid` (dynamique : compte les datasets via `Catalog`), `latest-datasets` (dynamique), `divider`, `spacer`, `html`. Textes **localisés** (`{en, fr, …}`, repli `en`). Rendu **anti-injection** : le texte passe par `textContent` ; le bloc `html` (auteur = opérateur de confiance) est **assaini** (retrait de `script`/`style`/`iframe`/attributs `on*`/`javascript:`). Aperçu vérifié : titre/paragraphes/bouton/stat fixe rendus, `<script>` retiré du bloc HTML.
- **Constructeur de pages — onglet « Pages »** ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js)) — palette de blocs, liste **réordonnable** (glisser-déposer + ▲▼ + suppression), panneau de réglages **par bloc** (champs adaptés au type, texte **multilingue** une langue à la fois), **aperçu en direct** dans une iframe (les blocs du brouillon sont poussés par `postMessage`, sans aller-retour disque). **Brouillon** (`save`) / **Publier** (`save`+`publish`) / **Défaut** (`reset`). Gestion des **pages personnalisées** : création (identifiant + libellé → enregistre `config/pages/<slug>.json` + inscrit la page dans `nav.customPages`), suppression, sélection. Les pages intégrées `home`/`about` sont éditables et prévisualisées via la vraie page.
- **Page personnalisée `page.html` + rendu** ([page.html](../page.html), [js/pages/page-view.js](../js/pages/page-view.js)) — hôte générique : lit `?slug=`, charge `config/pages/<slug>.json`, rend les blocs **publiés** (ou le **brouillon** avec `?preview=draft`). Pont d'aperçu `postMessage` pour l'édition en direct. Chrome de marque + tête injectée + nav config-driven.
- **Navigation config-driven** ([js/core/instance-config.js](../js/core/instance-config.js) `applyNav`) — la barre de navigation reflète l'instance : les liens standard (Explorer/Comparer/Suivi/À propos) sont masqués selon `nav.showX`, les **pages personnalisées** sont injectées (`page.html?slug=…`), et un lien « Mentions légales » apparaît si `nav.showLegal`. Idempotent (re-appliqué au changement de langue).
- **Remplacement de l'accueil / « À propos » par blocs** ([index.html](../index.html), [js/pages/landing.js](../js/pages/landing.js), [about.html](../about.html), [js/pages/about.js](../js/pages/about.js)) — si l'opérateur publie une disposition de blocs pour `home`/`about`, elle **remplace** le contenu par défaut (sinon le défaut s'affiche — aucune régression pour IRIBHM). Vérifié : sans blocs publiés, `index.html`/`about.html` rendent leur contenu par défaut inchangé.
- **Clés i18n `pages.*` + `admin.navPages`** ([lang/en.json](../lang/en.json), [lang/fr.json](../lang/fr.json), [lang/es.json](../lang/es.json)) — en/fr/es, **parité 885 clés**.

## Notes
- **Vérification** : le panneau admin démarre avec les **9 onglets** (dont **Pages**) — module valide, aucune erreur. `PageRenderer` testé en isolation (6 blocs rendus, localisation, statistique dynamique, **assainissement HTML**). `index.html`/`about.html` rendent leur défaut sans régression après l'encapsulation (`home-default`/`about-default` visibles, conteneurs de blocs masqués). `page.html` servi (tête injectée). Parité i18n re-vérifiée (885 × 3). Le flux d'édition/publication interactif est protégé par l'authentification admin — à exercer connecté.
- **Sécurité** : les écritures (pages, instance) passent par `/api/site.php` (session + CSRF). Le rendu de blocs est anti-injection (`textContent` + assainisseur pour le bloc HTML). Slugs de page validés (`^[a-z0-9][a-z0-9_-]{0,63}$`) côté client **et** serveur.
- **Portée** : les colonnes imbriquées (layout multi-colonnes) ne sont pas encore proposées (complexité d'édition) ; le jeu de blocs actuel couvre les besoins courants. La galerie/les statistiques offrent un éditeur de liste simple.

[Versioning] Plateforme Web → v1.10.0. changelog_1.10.0.md généré.
