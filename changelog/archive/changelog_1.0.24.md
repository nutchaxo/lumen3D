# Plateforme Web — v1.0.24

## [FIXED]
- **ELE-22 (EDGE-005)** — `js/pages/admpan.js` : `selectDataset` montait n'importe quel JSON renvoyé par `get()` sans validation (viole Rule 1.4). Ajout de `validateDatasetMeta()` (id non vide, `type` ∈ {`fixed`,`live`,`tracking`}, dimensions `x/y/z/c` > 0, `channels` non vide) ; un dataset malformé est **rejeté** (toast) **avant** toute création d'état d'édition (`_draft`/`_original`). Exécuté après la garde de péremption ELE-15. Validé contre les 15 `metadata.json` réels (0 faux rejet).
- Test : `tests/js/test_admpan_validate_meta.mjs` (structurel) + non-régression du test ELE-15 + `node --check`.
