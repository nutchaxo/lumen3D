# Plateforme Web — v1.0.46

> Lot « cohérence doc/code du transport de bricks » — alignement de `CLAUDE.md` et `README.md` sur le format réel (la documentation décrivait gzip + PNG + HTTP range, le code sert des packs `.bin` de tuiles WebP téléchargés en entier).

## [FIXED]
- **DEAD-041** — `CLAUDE.md` §3.2 affirmait `BRICK_SIZE = 128 … legacy constant` à `brick-loader.js:9`, alors que depuis v1.0.38 la constante est `BRICK_SIZE = 64` (`brick-loader.js:14`). Corrigé ; la note « legacy 128 » trompeuse est supprimée.
- **DEAD-040** — écart doc/code sur le pipeline de streaming : `CLAUDE.md` (diagramme §3.2, table §2.3, §5) et `README.md` (features, format, arbre préproc, diagramme mermaid) décrivaient un transport `gzip + PNG` avec `brick-fetch-worker (range fetch)`. Réalité : les bricks 64³ sont mosaïquées **8×8 en tuiles WebP 512²**, empaquetées en `.bin`, **téléchargées en entier** (pas de HTTP range — `_fetchPackBuffer` lit le pack complet) et décodées via `createImageBitmap` dans un **pool de decode-workers** (`brick-decode-worker.js`). Docs alignées ; le nœud `brick-fetch-worker` (mort, cf. DEAD-003) est retiré du diagramme mermaid du README.

## [TESTS]
- `tests/js/test_doc_transport_consistency.mjs` (nouveau) — garde anti-régression : `CLAUDE.md`/`README.md` ne contiennent plus `BRICK_SIZE = 128`, `gzip`, `range fetch`/`HTTP range requests`, `gunzip`, `512² PNGs`, et mentionnent bien `BRICK_SIZE = 64` + `WebP`.
