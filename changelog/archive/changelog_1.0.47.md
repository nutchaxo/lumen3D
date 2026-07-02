# Plateforme Web — v1.0.47

> Lot « hygiène de composants » — `measurement-store.js` + `channel-panel.js`.

## [FIXED]
- **LEAK-020** (Rule 1.2) — `js/core/measurement-store.js` : `clear()` ne vidait que le tableau d'une entrée ; la clé `${scope}:${datasetId}` de la `Map` `_state` n'était jamais supprimée → croissance d'une entrée par (scope, dataset) visité. Ajout de `dropDataset(datasetId, scope)` (supprime l'entrée) et `reset()` (purge totale), exposés sur l'API.
- **LEAK-016** (Rule 1.2) — `js/components/channel-panel.js` : le listener `document 'click'` (fermeture des popups couleur) était enregistré une fois à la construction, sans retrait. Handle nommé `_onDocClick` + `dispose()` qui le retire, câblé sur `pagehide` (teardown de page mono-shot).
- **BUG-044** — `js/components/channel-panel.js` `setState` : le plancher `nextMin + 0.01` était appliqué **après** le clamp de `min` et jamais re-clampé → `min === 1.0` produisait `max = 1.01` (> 1), propagé tel quel à l'uniform shader. `min` est désormais plafonné à `0.99` et `max` re-clampé dans `[0,1]` tout en gardant `max > min`.
- **BUG-070** — `js/components/channel-panel.js` `init()` écrivait `_container.innerHTML = ''` puis le ré-écrasait immédiatement via `_renderAll()` (écriture DOM morte). Ligne supprimée.

## [TESTS]
- `tests/js/test_component_hygiene.mjs` (nouveau) — `MeasurementStore` chargé en `vm` : `dropDataset` supprime l'entrée, laisse les autres intactes, `reset` purge tout (LEAK-020) ; structurel `channel-panel` : suppression du `innerHTML=''` (BUG-070), clamp `min`≤0.99 + `max` re-clampé (BUG-044), `_onDocClick` retiré dans `dispose` câblé sur `pagehide` et exposé (LEAK-016). `node --check`.
