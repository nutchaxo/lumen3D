# Plateforme Web — v1.0.52

> Lot « landing/explorer : déduplication & perf ».

## [OPTIMIZED]
- **DEAD-035** — `toggleDropdown` et la partie commune de `switchLanguage` étaient dupliquées entre `landing.js` et `explorer.js`. Implémentation hoistée dans `Utils.toggleDropdown(id)` + `Utils.closeDropdowns()` (un seul exemplaire) ; les handlers de page délèguent. Le `toggleDropdown` partagé installe un listener outside-click **one-shot** qui se retire lui-même (pas de fuite sur toggles répétés).
- **PERF-028** — le filtrage réécrivait `innerHTML` **deux fois** par frappe (deuxième passe pour « réparer » des séparateurs mojibake `Â·`). Les glyphes (`·`, `×`) sont désormais émis en entités HTML (`&middot;`, `&times;`) **à la source** des templates → une seule écriture `innerHTML`, plus de seconde passe.
- **PERF-031** — la boucle hero du fond animé recalculait toutes les paires de particules (O(n²)) à chaque frame, avec un `Math.sqrt` par paire, **même onglet masqué**. Désormais : saut complet du balayage+redraw quand `document.hidden` (RAF maintenu pour reprise transparente), et comparaison de distance **au carré** (le `sqrt` n'est calculé que pour les paires sous le rayon de connexion).
- **EDGE-045** — les URLs de vignettes dans `explorer.js` portaient `?v=${Date.now()}`, désactivant le cache navigateur et re-téléchargeant les vignettes à chaque rendu/filtre. Cache-buster horloge supprimé (URL stable).

## [TESTS]
- `tests/js/test_landing_explorer_perf.mjs` (nouveau) — `Utils.toggleDropdown`/`closeDropdowns` en `vm` (ouvre/ferme) ; structurel : délégation à `Utils` (DEAD-035), suppression de la 2ᵉ passe `innerHTML` + entités (PERF-028), saut-si-masqué + distance au carré (PERF-031), zéro `Date.now()` dans `explorer.js` (EDGE-045). `node --check`.
