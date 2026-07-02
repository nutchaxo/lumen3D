# Plateforme Web — v1.0.57

> Lot « hygiène CSS » — dernier lot des quick-wins de l'audit. ⚠️ Changements **visuels** : vérifiés structurellement (mécanisme), à confirmer d'un coup d'œil navigateur (la contrainte « tests unitaires sans navigateur » ne permet pas de valider le rendu).

## [OPTIMIZED]
- **DEAD-025** — les littéraux `z-index` géants (`1000`–`10020`) éparpillés dans `viewer.css`/`tools.css`/`admpan.css` coexistaient de façon incohérente avec l'échelle de tokens `--z-*`. Centralisés dans `variables.css` en tokens nommés (`--z-viewer-base/raised/elevated/popover/modal/modal-top`, `--z-admin-overlay`) — **valeurs préservées à l'identique**, donc l'ordre d'empilement est inchangé (zéro risque de régression de stacking) ; les littéraux bruts sont remplacés par les tokens (source unique).
- **PERF-034** — les keyframes shimmer (`shimmer`/`blur-shimmer`/`adm-shimmer`) animaient `background-position` (lié au *paint*, repeint chaque frame). Réécrites pour animer une **transform `translateX`** sur un pseudo-élément `::after` en surimpression (`.skeleton`, `.blur-progress-fill`, `.skeleton-card`) → animation portée par le compositeur GPU, sans repaint. La couleur de fond reste sur l'élément ; la bande claire glisse via `transform` (`will-change: transform`). ⚠️ **Rendu à valider visuellement** (skeleton loaders + barre de progression indéterminée).

## [TESTS]
- `tests/js/test_css_hygiene.mjs` (nouveau) — structurel : les 7 tokens `--z-*` portent **exactement** les anciennes valeurs (DEAD-025, preuve d'absence de changement de stacking) et aucun littéral `z-index` géant ne subsiste dans les 3 fichiers ; les 3 keyframes shimmer animent `translateX` et plus `background-position`, avec les overlays `::after` (PERF-034).
