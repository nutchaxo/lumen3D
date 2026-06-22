# Plateforme Web — v1.0.56

> Lot « durcissement HTML & pages ».

## [FIXED]
- **SEC-022** — `admpan.html` : le lien `← Explorer` (`target="_blank"`) n'avait pas de `rel="noopener"` → reverse-tabnabbing (la page ouverte pouvait manipuler `window.opener`). `rel="noopener"` ajouté.
- **SEC-020** (Rule 1.4) — `js/components/deepzoom-viewer.js` `_loadSlice` : `basePath` issu du manifest était concaténé brut dans les URLs de tuiles. Validation ajoutée : refus (warn + bail) d'un `basePath` avec scheme (`http:`/`file:`), protocole-relative (`//host`) ou segment `..`.
- **BUG-058** — `deepzoom.html` : attributs `data-i18n` présents mais `i18n.js` jamais chargé (libellés inertes). `js/core/i18n.js` est désormais chargé et `I18n.init()` appelé au `DOMContentLoaded` (repli no-op : le texte FR statique est conservé si une clé manque).
- **BUG-059** — `about.html` / `compare.html` / `explorer.html` : handlers inline `onclick="Theme.toggle()"` / `onclick="ColorBlind.openModal()"` sans garde de présence (erreur si un script échoue à charger). Gardés en `onclick="window.Theme && Theme.toggle()"` / `onclick="window.ColorBlind && ColorBlind.openModal()"`.

## [OPTIMIZED]
- **DEAD-024** — `widgets.html` : `background: var(--bg-default)` référençait un token CSS inexistant (fond non défini). Corrigé en `var(--bg-body)`.
- **DEAD-008** — `index.html` : import `three@0.167.0/build/three.module.js` (ESM) **inutilisé** — le hero de la landing est un système de particules canvas 2D (`landing.js`), et l'ESM n'exposait pas de `window.THREE` (incohérence de version majeure avec l'UMD du viewer). Script retiré.

## [TESTS]
- `tests/js/test_html_hardening.mjs` (nouveau) — structurel : `rel="noopener"` (SEC-022), garde `basePath` deepzoom (SEC-020), `--bg-body` (DEAD-024), absence du `<script>` three.module (DEAD-008), `i18n.js` + `I18n.init()` dans deepzoom.html (BUG-058), handlers inline gardés sur les 3 pages (BUG-059). `node --check` deepzoom-viewer.js. Non-régression : `test_sri.py`, `test_compare_html.py`.
