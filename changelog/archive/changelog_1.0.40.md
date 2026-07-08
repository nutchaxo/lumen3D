# Plateforme Web — v1.0.40

> Lot « robustesse des singletons cœur » — premier lot des quick-wins (effort S) de l'audit de perf/stabilité du 16/06, restants après la campagne Critique/Élevé. Triage préalable : 79 LIVE + 15 PARTIAL retenus, 6 STALE / 7 REFUTED écartés (déjà corrigés ou infirmés). Tests unitaires uniquement (aucune page navigateur).

## [FIXED]
- **BUG-015** — `js/core/i18n.js` : la locale `es` est livrée (`lang/es.json`) mais l'auto-détection navigateur ne testait que `['fr','en']` → un navigateur espagnol retombait silencieusement sur `en`. La liste des langues supportées est désormais une constante unique `SUPPORTED = ['en','fr','es']` réutilisée par le détecteur (ajouter une locale = une ligne).
- **BUG-016** — `js/core/i18n.js` : `I18n.t('clé', params)` levait `value.replace is not a function` lorsque la clé résolvait vers un nœud non-feuille (objet/tableau). Garde ajoutée : une résolution non-string retourne la clé (même contrat qu'une clé non résolue) avant la boucle d'interpolation.
- **BUG-045** — `js/core/theme.js` : `Theme.init` contenait un ternaire mort `prefersDark ? 'dark' : 'dark'` (préférence système lue puis jetée). Remplacé par `_current = 'dark'` explicite — le mode sombre est le défaut voulu pour la microscopie (fluorescence haute-contraste sur fond noir).
- **EDGE-043** — `js/core/utils.js` : `formatFileSize` produisait `'NaN undefined'` sur une taille NaN/Infinity/négative (`Math.log` non fini → index d'unité hors borne). Rejet des tailles non finies/négatives (`—`) et clamp de l'index d'unité (une valeur > 1 Po reste en To au lieu d'indexer au-delà du tableau).
- **DEAD-033** — `js/core/utils.js` : `formatDate` et `formatStage` avaient une garde dupliquée et inatteignable (`return '-'` immédiatement suivi de `return '—'`). Garde unique conservée, standardisée sur l'em-dash `—`.
- **DEAD-034** — `js/core/catalog.js` : `Catalog.getTypes()` était exporté mais sans aucun appelant dans `js/`. Définition et export supprimés (Rule 1.1 — pas de surface morte).
- **EDGE-059** — `js/core/display-presets.js` : `resolve('custom', …)` masquait silencieusement une couleur custom invalide en `#1a1d27` et rendait `transparent` non sélectionnable en custom. `transparent` est désormais honoré (avec le flag `transparent:true`) ; une couleur invalide retombe sur le défaut documenté **avec un avertissement** (`_normalizeColor` retourne `null` au lieu de masquer). 

## [TESTS]
- `tests/js/test_core_robustness.mjs` (nouveau) — harnais Node vm : détection `es-ES→es`/`fr-CA→fr`/`de→en` (BUG-015), `t()` sur clé-objet ne lève pas et retourne la clé (BUG-016), défaut sombre + suppression structurelle du ternaire mort (BUG-045), `formatFileSize` sur NaN/∞/négatif/énorme (EDGE-043), garde unique `formatDate`/`formatStage` (DEAD-033), absence totale de `getTypes` (DEAD-034), `resolve` custom transparent/3-hex/invalide (EDGE-059).
