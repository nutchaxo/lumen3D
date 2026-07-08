# Plateforme Web — v1.0.54

> Lot « robustesse admin/studio » — `js/pages/admpan.js` + `js/components/studio-editor.js`.

## [FIXED]
- **BUG-057** — `admpan.js` : `saveDataset` et `saveThumbnail` déclenchaient `rebuild_catalog` en **fire-and-forget** (ni `await` ni `catch`), avalant silencieusement un échec → le catalogue pouvait diverger des métadonnées sauvegardées. Les deux appels sont désormais **attendus** et surfacent un toast d'avertissement si `rebuild` échoue (`!rb?.ok`).
- **EDGE-018** (Rule 1.4) — `admpan.js` : le quaternion d'orientation reçu (`ORIENTATION_RESULT`) était stocké tel quel dans `_draft.orientation` sans validation. Désormais validé (tableau/objet de 4 composantes toutes finies) et **normalisé** (longueur > 1e-6) avant stockage ; une valeur non finie/dégénérée est rejetée (l'orientation précédente est conservée). La forme (tableau vs `{x,y,z,w}`) est préservée.
- **EDGE-019** (Rule 1.4) — `studio-editor.js` `_migrateLayer` : un JSON importé pouvait porter une géométrie `NaN`/`Infinity`/non numérique (`??` ne garde que `null`/`undefined`, pas `NaN`) corrompant le canvas. Coercition de tous les numériques (`x,y,w,h`, `points[].x/y`, `style.strokeWidth/fontSize/opacity`) vers des valeurs finies, en **réutilisant** `_clamp`/`_clamp01`.

## [OPTIMIZED]
- **DEAD-038** — `studio-editor.js` : `OPACITY_LEVELS` défini mais jamais lu — supprimé. (`_clamp`/`_clamp01`, auparavant inutilisés, sont désormais réellement employés par EDGE-019 plutôt que supprimés.)

## [TESTS]
- `tests/js/test_admin_studio_robustness.mjs` (nouveau) — structurel + `node --check` : 3 `await … rebuild_catalog` et aucun appel fire-and-forget résiduel (BUG-057), normalisation quaternion (`Math.hypot` + `every(Number.isFinite)`, suppression de l'assignation brute) (EDGE-018), coercition géométrie + clamps réutilisés dans `_migrateLayer` (EDGE-019), absence d'`OPACITY_LEVELS` (DEAD-038). Non-régression : `test_admpan_validate_meta.mjs`, `test_admpan_selectdataset_guard.mjs`.
