# Plateforme Web — v1.13.0

> **Éditeur de pages « Elementor » (sections → colonnes → widgets) + lot de correctifs post-test.**
> Nouveau constructeur de pages visuel (glisser-déposer, colonnes redimensionnables alignées sur une
> grille de 12, WYSIWYG, aperçu en direct), plus six corrections issues d'un test réel sur hébergement
> PHP : onglet Plugins qui tournait à l'infini, installation lente, catalogue, pages blanches, résidus
> IRIBHM/ULB dans le white-label, sections légales par défaut, et bouton d'accueil de l'installateur.

## [ADDED]
- **Éditeur de pages structuré — sections / colonnes / widgets** ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js), [js/core/page-renderer.js](../js/core/page-renderer.js)) — refonte complète du constructeur en modèle Elementor : des **sections** empilées (fond, marges, pleine largeur ou centrée, alignement vertical), découpées en **colonnes** sur une grille de **12 unités** (dispositions 1 / 2 / 3 / 4 / ⅔-⅓ / ⅓-⅔), où l'on glisse des **widgets**. Glisser-déposer depuis la palette, réordonnancement inter/intra-colonnes, **poignée de redimensionnement entre colonnes qui s'aligne (snap) sur les unités de 12**, canevas **WYSIWYG** (widgets rendus par le vrai `PageRenderer`), panneau de réglages contextuel (widget / colonne / section / page), aperçu en direct (`postMessage LUMEN_PREVIEW_DOC`), dupliquer/supprimer/monter/descendre à tous les niveaux, textes multi-langues. Nouveau schéma `pages/<slug>.json` : `{title, draft:{sections}, published:{sections}}`.
- **Sections légales robustes par défaut** ([config/defaults/neutral/legal.json](../config/defaults/neutral/legal.json)) — 6 sections génériques éditables (Éditeur, Protection des données/RGPD, Cookies, Propriété intellectuelle, Responsabilité, Contact) en FR/EN/ES avec des champs `[entre crochets]` à compléter dans l'onglet Légal.

## [OPTIMIZED]
- **Rendu de pages rétro-compatible** ([js/core/page-renderer.js](../js/core/page-renderer.js)) — le renderer normalise sections **ou** anciens blocs plats **ou** tableau nu, ce qui **corrige les pages qui s'affichaient vides** (les pages de l'ancien éditeur sont converties en une section 12 unités). Colonnes responsives sans media-query (flex-wrap + min-width → empilement sur mobile), styles inline compatibles CSP. `page-view.js`/`landing.js`/`about.js` rendent désormais la source (sections) via `renderSource`/`fetchSource`.
- **Installation de plugins plus rapide** ([api/_admin_lib.php](../api/_admin_lib.php), [dev_server.py](../dev_server.py)) — quand le catalogue est signé (clé Ed25519), `entry.sha256` est **déjà authentifié** par la signature du catalogue : on **saute les téléchargements `SHA256SUMS` + `.sig` par plugin** (2 requêtes GitHub raw en moins par installation ; ~12 s → ~7 s). Repli sur la chaîne détachée si le catalogue n'est pas signé.

## [FIXED]
- **Onglet Plugins qui chargeait indéfiniment** ([js/pages/admin/tab-plugins.js](../js/pages/admin/tab-plugins.js)) — le spinner s'affichait dès que la liste était vide, sans distinguer « en cours » / « vide » / « erreur ». États explicites : **état vide** (« aucun plugin installé → Catalogue ») avec bouton vers le Catalogue, **état d'erreur** avec bouton Réessayer.
- **Catalogue : récupération robuste sur hébergement mutualisé** — la détection « déjà installé » et le rechargement après install/désinstall reposent sur le fetch cURL (v1.12.5) ; l'accélération réduit la latence perçue qui faisait croire à un blocage.
- **Résidus IRIBHM/ULB dans le white-label** ([index.html](../index.html), [explorer.html](../explorer.html), [about.html](../about.html), [admpan.html](../admpan.html), [widgets.html](../widgets.html), [lang/*.json](../lang/en.json)) — les libellés statiques codés en dur (« IRIBHM — ULB » dans les barres de navigation et pieds de page, « IRIBHM Admin », pied de connexion) sont neutralisés en défauts white-label ; l'identité IRIBHM provient désormais uniquement de `config/instance.json` au runtime. Plus d'apparition d'« IRIBHM — ULB » pendant l'installation.
- **`install.php` : bouton « page d'accueil » retiré de l'écran final** ([install.php](../install.php)) — la page d'accueil n'affiche rien tant que l'onboarding admin n'est pas fait ; seul le lien vers le panneau d'administration (« Configurer la plateforme ») reste.

[Versioning] Plateforme Web → v1.13.0. changelog_1.13.0.md généré.
