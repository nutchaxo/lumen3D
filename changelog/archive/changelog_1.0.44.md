# Plateforme Web — v1.0.44

> Lot « échappement HTML/CSS » — durcissement défensif des chaînes injectées dans `innerHTML`/styles inline. Tous réutilisent le helper existant `Utils.escapeHtml` (introduit pour SEC-004) ; aucun nouveau helper.

## [FIXED]
- **SEC-014** — `js/pages/compare.js` `_bindModal` : les champs catalogue `d.id`/`d.thumbnail`/`d.name`/`d.type` étaient interpolés bruts dans la modale de sélection (`_addPanel` échappait pourtant déjà). Échappés via `Utils.escapeHtml`.
- **SEC-015** — `js/pages/landing.js` `createDatasetCard` : `dataset.thumbnail`/`name`/`description` interpolés bruts (contrairement à `explorer.js`). Échappés (miroir d'`explorer.js`).
- **SEC-018** — `js/modules/tools/measure-distance/index.js` : `item.color` (mutable via l'action toggle-color) injecté brut dans un `style="background:…"` — un attribut pouvait être cassé. Échappé via `esc()` (déjà utilisé pour `id`/`label`).
- **SEC-019** — `js/components/channel-panel.js` : `channel.color` (donnée dataset) injecté brut dans deux styles inline (swatches). Échappé via un `safeColor` calculé en tête de `_channelHtml`. *(La moitié `decomposition-panel.js` de ce finding est infirmée par le triage : elle écrit `element.style.color` via le setter DOM, non concaténé — pas de vecteur d'injection.)*
- **SEC-021** — `js/pages/tracking.js` + `css/viewer.css` : le menu de colormaps utilisait des handlers inline `onmouseover`/`onmouseout` et interpolait noms/stops bruts (constantes internes — non exploitable de l'extérieur, mais hygiène CSP). Survol/sélection déplacés sur des règles CSS (`.colormap-option:hover` / `.colormap-option.selected`) ; noms et couleurs de stops échappés par défense en profondeur.

## [TESTS]
- `tests/js/test_html_escaping.mjs` (nouveau) — structurel (fichiers touchant le DOM) : présence des formes échappées et **absence** des interpolations brutes pour chaque champ (SEC-014/015/018/019), suppression des handlers inline + classe `.selected` côté JS et règles `:hover`/`.selected` côté CSS (SEC-021). `node --check` sur les cinq fichiers JS touchés.
