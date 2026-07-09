# Plateforme Web — v1.13.7

> **Menus déroulants natifs lisibles quel que soit le thème de l'OS.** Certains `<select>` (panel admin,
> viewer) affichaient leurs options en gris clair sur fond blanc — illisibles — dès que l'OS était en mode
> clair alors que l'application était en thème sombre.

## [FIXED]
- **Options de `<select>` gris clair sur blanc (illisible)** ([css/themes.css](../css/themes.css), [css/base.css](../css/base.css)) — le popup natif d'un `<select>` est dessiné par l'OS, et son schéma de couleurs suit la propriété CSS `color-scheme`. La règle de base forçait `color-scheme: dark light` sur **tous** les `<select>` : avec deux valeurs, le navigateur laisse la **préférence de l'OS** décider. Sur une machine Windows avec l'OS en mode clair mais l'application en thème sombre, le popup natif se dessinait donc en **blanc** tandis que notre texte d'option restait clair (`#e5e7eb`) → gris clair sur blanc. Correctif : `color-scheme` est désormais lié au **thème de l'application** (`color-scheme: dark` sous `[data-theme="dark"]`, `light` sous `[data-theme="light"]` — posé sur `:root`), et l'ancien `color-scheme: dark light` codé en dur sur `select` est retiré (il inhérite maintenant du root). Le popup natif suit l'app, plus l'OS : fond sombre + texte clair en thème sombre, fond blanc + texte sombre en thème clair. Vérifié : `color-scheme` calculé du `<select>` = `dark`/`light` selon `data-theme`, contraste lisible dans les deux cas.

[Versioning] Plateforme Web → v1.13.7. changelog_1.13.7.md généré.
