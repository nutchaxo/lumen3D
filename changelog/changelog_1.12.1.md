# Plateforme Web — v1.12.1

> **Outil — publication de plugin en une commande.** `tools/publish_plugin.py` prend un dossier de
> plugin et fait tout : package + signature, ajout/mise à jour dans le catalogue signé, re-signature,
> et (avec `--push`) commit + push GitHub — le plugin est **live immédiatement**, aucune étape manuelle.

## [ADDED]
- **`tools/publish_plugin.py`** — publieur marketplace « clé en main ». Usage :
  - `python tools/publish_plugin.py <dossier-plugin>` → package + signe le plugin (`marketplace/plugins/<id>/`), ajoute/met à jour son entrée dans `marketplace-catalog.json`, re-signe le catalogue (prépare, sans pousser).
  - `… --push` → en plus : `git add marketplace` + commit + push sur la branche courante → **live**.
  - `… --recommended true|false` → coché par défaut ou non dans le sélecteur de première installation (par défaut : conserve l'existant / `true` pour un nouveau).
  - `--remove <id> [--push]` → dépublie (retire du catalogue + supprime les artefacts + re-signe [+ push]).
  Détails : graine de signature lue depuis `secrets/marketplace-signing-seed.hex` (ou `LUMEN_SIGNING_KEY`) ; **base d'URL dérivée automatiquement** du `_MARKETPLACE_CATALOG_URL` épinglé (les `assetUrl`/`sumsUrl`/`sigUrl` correspondent toujours à ce que la plateforme va chercher) ; `SHA256SUMS`/catalogue écrits en octets bruts (LF) pour que **signé == publié** ; signature Ed25519 déterministe → re-publier un plugin inchangé = « rien à committer » (géré, pas de commit vide) ; avertissement si la branche courante ≠ branche de l'URL du catalogue. Sortie forcée en UTF-8 (consoles Windows cp1252).

## Notes
- **Vérifié en réel** : `publish_plugin.py <plugin> --push` a publié un plugin de test → **catalogue live à 18, signature vérifiée sous la clé épinglée, installation réseau OK (sandboxed)** ; puis `--remove <id> --push` → retour à **17**, signature valide, artefacts nettoyés. Cycle add + install + remove prouvé de bout en bout, catalogue final propre.
- **Ajouter un plugin** revient donc à : `python tools/publish_plugin.py chemin/vers/mon-plugin --push`. C'est tout.

[Versioning] Plateforme Web → v1.12.1. changelog_1.12.1.md généré.
