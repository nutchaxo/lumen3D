# Plateforme Web — v1.0.17

## [FIXED]
- **ELE-07 (SEC-009)** — Durcissement (moindre privilège) du `sandbox` de l'iframe de prévisualisation admin (`admpan.html`). `allow-forms` et `allow-popups` retirés (inutiles pour une preview en lecture seule) ; `allow-scripts` + `allow-same-origin` conservés car **requis** par le viewer first-party (modules ES + `localStorage`, qui lèvent une `SecurityError` sous une origine sandbox opaque). La preview ne charge que du contenu first-party same-origin — modèle de confiance documenté en commentaire dans le HTML.
- Test : `tests/test_admin_iframe_sandbox.py`.
