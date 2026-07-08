# Plateforme Web — v1.12.4

> **Marketplace servi depuis `main`.** La plateforme étant désormais publiée depuis la branche stable
> `main`, le catalogue de plugins signé et ses artefacts sont servis depuis `main` (et non plus `dev`),
> pour que le marketplace vive sur la même branche que les releases.

## [FIXED]
- **URL du marketplace repointée `dev` → `main`** ([dev_server.py](../dev_server.py), [api/_admin_lib.php](../api/_admin_lib.php)) — `_MARKETPLACE_CATALOG_URL` / `MARKETPLACE_CATALOG_URL` pointent maintenant sur `raw.githubusercontent.com/nutchaxo/lumen3D/main/marketplace/…`. Le catalogue signé a été **régénéré + re-signé** (Ed25519, clé marketplace inchangée) avec les 51 URLs d'assets (`assetUrl`/`sumsUrl`/`sigUrl` des 17 plugins) pointant sur `main` ; signature vérifiée sous la clé épinglée. Les artefacts de plugins (zip/SHA256SUMS/.sig) sont indépendants de la branche — aucun re-packaging. Conséquence : un plugin n'est **live** qu'une fois sur `main` ; le développement reste sur `dev` puis un merge `dev → main` publie (l'outil `publish_plugin.py` avertit si l'on publie depuis une autre branche). Doc `marketplace/README.md` mise à jour.

[Versioning] Plateforme Web → v1.12.4. changelog_1.12.4.md généré.
