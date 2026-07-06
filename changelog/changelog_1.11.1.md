# Plateforme Web — v1.11.1

> **White-label — activation du marketplace signé.** La clé de signature Ed25519 du marketplace est
> **posée** (publique épinglée en source, graine privée conservée hors dépôt), le catalogue est **mis
> en ligne** (dossier `marketplace/` servi via GitHub raw), et un **plugin d'exemple installable** est
> publié. Le marketplace passe de « inactif » à **opérationnel, signature obligatoire fail-closed**.

## [ADDED]
- **Clé de signature marketplace posée** ([dev_server.py](../dev_server.py) `_MARKETPLACE_PUBKEY_HEX`, [api/_admin_lib.php](../api/_admin_lib.php) `MARKETPLACE_PUBKEY`) — clé publique Ed25519 épinglée **en source** (survit aux auto-updates), **dédiée** (séparée de la clé de release cœur). La graine privée est stockée **localement hors dépôt** (`secrets/`, gitignoré) — jamais poussée. La signature du catalogue **et** de chaque release plugin devient **obligatoire, fail-closed**.
- **Catalogue en ligne + plugin d'exemple** ([marketplace/](../marketplace/)) — `_MARKETPLACE_CATALOG_URL` pointe `marketplace/marketplace-catalog.json` (GitHub raw, branche `dev`), signé (`.sig`). Premier plugin first-party publié : **`dataset-info`** (outil sandboxé — affiche nom + dimensions du dataset via RPC de capacités), source dans `marketplace/src/`, release signée dans `marketplace/plugins/dataset-info/` (`plugin-dataset-info-1.0.0.zip` + `SHA256SUMS` + `.sig`). Sert aussi de **template** pour les futurs plugins.
- **`.gitignore`** — `secrets/` ajouté (graines de signature marketplace/release, machine-locales, jamais commitées).

## Notes
- **Vérification crypto** : chaîne complète prouvée localement — signature du catalogue vérifiée sous la clé épinglée, signature du `SHA256SUMS` du plugin vérifiée, clé publique == clé épinglée, zip déterministe. Le pipeline d'installation de bout en bout (fetch catalogue signé → download → vérif sig fail-closed → sha256 → extraction durcie → install → approbation) est validé sur instance isolée.
- **Mise en garde clé privée** : `secrets/marketplace-signing-seed.hex` est machine-local et gitignoré. Le perdre impose de re-keyer (nouvelle paire + ré-épinglage). Pour la CI (build de release plugin), utiliser la même graine comme secret `LUMEN_SIGNING_KEY`.
- **Branche du catalogue** : l'URL pointe `dev` (déploiement actif). Pour une prod stable, basculer vers `main`/un tag après merge.

[Versioning] Plateforme Web → v1.11.1. changelog_1.11.1.md généré.
