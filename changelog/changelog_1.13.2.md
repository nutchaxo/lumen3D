# Plateforme Web — v1.13.2

> **Correctifs critiques hébergement mutualisé : installation de plugins, page Legal, redirection installateur.**
> L'installation de plugins échouait silencieusement sur les hébergeurs PHP dont `/tmp` est un montage
> distinct du dossier web (dossiers de modules vides). La page Legal renvoyait « Not found » (non livrée) et
> apparaissait dans la barre de navigation au lieu du pied de page. L'installateur ne redirigeait pas vers
> l'onboarding.

## [FIXED]
- **Plugins qui ne s'installaient pas (dossiers de modules vides)** ([api/_admin_lib.php](../api/_admin_lib.php)) — `mkt_install` extrayait le plugin dans `sys_get_temp_dir()` (`/tmp`) puis faisait un `rename()` vers `js/modules/<placement>/<id>`. Sur la plupart des hébergeurs mutualisés, `/tmp` est un **système de fichiers différent** du dossier web → le `rename()` échoue avec **EXDEV** (cross-device), laissant le dossier de placement créé mais **vide** et aucun plugin installé (l'assistant comme le catalogue étaient touchés). L'extraction se fait désormais **sous `js/modules/`** (même volume que la cible) pour que le `rename()` final soit toujours intra-système de fichiers — comme le fait déjà le serveur Python. Vérifié : install réel → `index.js` + `plugin.json` + `lang/` bien présents.
- **Page Legal « Not found »** ([tools/build_release.py](../tools/build_release.py)) — `legal.html` **et** `page.html` (hôte des pages personnalisées `page.html?slug=…`) n'étaient **pas dans l'allowlist de la release** → 404. Ajoutées. Ceci corrige aussi les **pages personnalisées** du constructeur qui renvoyaient « Not found ».
- **Lien Legal dans le pied de page (et non la barre de navigation)** ([js/core/instance-config.js](../js/core/instance-config.js)) — `applyNav` injecte désormais le lien « mentions légales » dans `.footer-links` (et non plus dans `.navbar-links`) quand `nav.showLegal` est actif ; idempotent.
- **Page Legal utile dès l'installation** ([js/pages/legal.js](../js/pages/legal.js)) — si aucune config légale opérateur n'existe encore (`config/legal.json` absent), la page affiche les **6 sections légales par défaut** (`config/defaults/neutral/legal.json`) au lieu d'une page vide.
- **L'installateur redirige vers l'onboarding** ([install.php](../install.php)) — à la fin de l'installation, redirection automatique (3 s) vers `admpan.html` (assistant compte + identité + plugins) + bouton « Aller à la configuration ». Les liens « accueil » restants (écran verrouillé, écran post-suppression) pointent désormais vers le panneau d'administration, pas vers le site (qui est vide avant l'onboarding).

[Versioning] Plateforme Web → v1.13.2. changelog_1.13.2.md généré.
