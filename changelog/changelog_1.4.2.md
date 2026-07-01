# Plateforme Web — v1.4.2

> **Correctif de mise en page : le menu latéral du panneau admin s'empilait au-dessus du contenu.** Sur les écrans larges (bureau, > 900 px), la barre latérale (Datasets / Statistiques / … / Réduire) occupait la moitié supérieure de la fenêtre et le contenu de l'onglet s'affichait en dessous, au lieu d'une colonne latérale pleine hauteur à gauche + contenu à droite. Cause : une règle CSS `flex-direction: column` résiduelle de l'ancien admin mono-écran, restée dans `admpan.css`, qui l'emportait sur le nouveau shell.

## [FIXED]
- **Shell admin empilé verticalement au lieu de côte à côte** ([css/admpan.css](../css/admpan.css), [css/admin-shell.css](../css/admin-shell.css)) — `admpan.css` (chargé **avant** `admin-shell.css`) conservait un bloc `#admin-app { … flex-direction: column }` de la mise en page pré-refonte (v1.4.0). Le nouveau `#admin-app` de `admin-shell.css` posait `display: flex` **sans** redéclarer `flex-direction` et comptait donc sur la valeur par défaut `row` — mais à spécificité égale la règle `column` restait gagnante (aucune surcharge), empilant la sidebar au-dessus de la colonne de contenu. Le bug ne se voyait qu'au-delà de 900 px : sous ce seuil la sidebar passe en `position: fixed` (tiroir mobile) hors du flux, ce qui masquait le problème (et explique pourquoi la vérif v1.4.0 ne l'a pas attrapé). Correctif : suppression du bloc `#admin-app` obsolète (+ `#admin-app.visible`, mort — le shell gère l'affichage en inline) de `admpan.css`, et déclaration explicite de `flex-direction: row` sur `#admin-app` dans `admin-shell.css` pour rendre le shell auto-suffisant.

## Notes
- Vérifié au navigateur (serveur Python, viewport 1280×900) : `#admin-app` calcule `flex-direction: row` ; sidebar pleine hauteur à gauche (x=0, w=248, h=900) ; colonne de contenu + topbar à droite (x=248, w=1032, y=0). Sous 900 px, la sidebar redevient un tiroir mobile (comportement inchangé).
- Aucun résidu : `.admin-main` / `.admin-header` / `#admin-app.visible` ne sont plus référencés par le HTML ou le JS admin (le shell utilise `.adm-content` / `.adm-topbar` et un `display` inline).

[Versioning] Plateforme Web → v1.4.2. changelog_1.4.2.md généré.
