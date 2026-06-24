# Plateforme Web — v1.3.4

> **Les previews de *Decompose by Channel* suivent l'embryon en temps réel.** Avant, les vignettes ne se rafraîchissaient qu'une fois la rotation terminée (1–2 s de latence ressentie) : l'optimisation perf d'origine *debounçait* le rendu, et chaque frame de mouvement ré-armait le timer, donc rien ne se redessinait tant qu'on bougeait. Le rendu des vignettes passe d'un *debounce* à un *throttle* : mise à jour live pendant le mouvement, image nette à l'arrêt.

## [OPTIMIZED]
- **Vignettes Decompose en direct (throttle + bord de fuite)** ([js/components/decomposition-panel.js](../js/components/decomposition-panel.js)) — `_scheduleDecompRender()` ne se contente plus de ré-armer un debounce de 140 ms (qui ne se déclenchait jamais pendant un drag continu). Désormais :
  - **pendant le mouvement** : un rendu *draft* des vignettes au plus toutes les `_DECOMP_THROTTLE_MS` (66 ms ≈ 15 maj/s), pour que les previews suivent l'embryon en temps réel ;
  - **à l'arrêt** : un rendu pleine résolution `_DECOMP_QUIET_MS` (140 ms) après la dernière frame sale (bord de fuite), pour une image finale pixel-exacte.
- **Rendu draft à résolution réduite** ([js/components/decomposition-panel.js](../js/components/decomposition-panel.js)) — `_renderDecompositions(opts)` accepte `{ draft }` : en mode draft, le volume est rendu dans un buffer WebGL réduit (`_DECOMP_DRAFT_SCALE = 0.5`, soit ≈4× moins de fragments) puis upscalé par `drawImage` (source 9-args) vers le canvas 2D pleine résolution. Résultat : previews légèrement adoucies pendant qu'on tourne, re-nettoyées par le rendu pleine résolution dès l'arrêt — coût GPU par frame de mouvement maîtrisé (le canvas 2D reste, lui, à pleine résolution pour rester net au repos).

[Versioning] Plateforme Web → v1.3.4. changelog_1.3.4.md généré.
