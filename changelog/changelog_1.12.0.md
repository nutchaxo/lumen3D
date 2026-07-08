# Plateforme Web — v1.12.0

> **White-label — modèle « app-store » des plugins + sélecteur à la première installation.** Le
> catalogue signé contient désormais **tous les plugins first-party** (17), les plugins ne sont **plus
> livrés en dur** dans une release (dé-bundle), et la **première installation ouvre un sélecteur de
> plugins** (étape 5 de l'assistant) avec **présélection par défaut** (recommandés cochés, décochables)
> qui installe les choisis depuis le catalogue signé. Bump de la ligne mineure (Y).

## [ADDED]
- **Catalogue = tous les plugins first-party** ([marketplace/](../marketplace/), [tools/build_plugin_release.py](../tools/build_plugin_release.py)) — les 17 plugins de `js/modules/` (2 shaders, 2 canaux, 13 outils) sont packagés en **releases signées** (`marketplace/plugins/<id>/`) et listés dans `marketplace-catalog.json` (re-signé). Chaque entrée porte un flag **`recommended`** (tous sauf `chunk-debug` (débogage) et `screenshot-sandboxed` (référence)) → 15/17 présélectionnés. Exposé par `marketplace_catalog` (jumeaux Python + PHP).
- **Sélecteur de plugins à la première installation — étape 5 de l'assistant** ([admpan.html](../admpan.html), [js/pages/admin/shell.js](../js/pages/admin/shell.js)) — après compte → identité → thème → textes, une **5e étape « Plugins »** récupère le catalogue signé et affiche tous les plugins groupés par emplacement (Rendu / Canaux / Outils) avec **cases à cocher**, les **recommandés cochés par défaut** (décochables ; les incompatibles grisés). « Terminer » amorce la config **puis installe les plugins cochés** (via l'endpoint marketplace, ré-auth par le mot de passe de l'assistant), avec **progression** (`x/N`). `already_installed` compté comme succès. Clés i18n `wizard.plugins*`/`wizard.pl*`/`wizard.installing2`/`installedN` en/fr/es (parité 949).

## [OPTIMIZED]
- **Dé-bundle des plugins de la release** ([tools/build_release.py](../tools/build_release.py)) — l'artefact de release **exclut** `js/modules/{tools,channels,shaders}/*` (+ le `manifest.json` de découverte périmé) : une **installation fraîche démarre sans plugin**, l'assistant installe la sélection à la demande depuis le catalogue signé. `js/modules/` reste présent (les installs y atterrissent) ; **`js/modules/` du dépôt est intact** (ton instance de dev garde ses plugins — seul le zip distribué dé-bundle). `_install_marketplace_plugin` crée `MODULES_DIR` si absent (install fraîche).

## Notes
- **Vérification end-to-end** : catalogue **17 plugins** servi + signature vérifiée sous la clé épinglée (réseau) ; installation isolée d'un plugin de **chaque type** (shader/outil/canal → `trusted`, sandbox → `sandboxed`) — tous atterrissent + approuvés. **Assistant première installation** (serveur isolé sans identifiant → assistant) : les 5 étapes se déroulent, l'étape Plugins charge **17 cases (15 cochées = recommandés)**, la sélection s'installe au « Terminer » (fluorescence + measure-distance installés, toggle-grid non coché → non installé), entrée dans le panneau OK. Build de release : **0 fichier plugin** dans l'artefact, `js/modules/` conservé. Suite Python **19/19** verte.
- **Modèle** : app-store — plugins à la demande. Une install fraîche nécessite le réseau à la première configuration (accepté) ; les shaders recommandés sont cochés par défaut pour que le viewer fonctionne. Ajouter un plugin au catalogue : `build_plugin_release.py` (seed = `secrets/marketplace-signing-seed.hex`) → déposer dans `marketplace/plugins/<id>/` → ajouter l'entrée + re-signer le catalogue.

[Versioning] Plateforme Web → v1.12.0. changelog_1.12.0.md généré.
