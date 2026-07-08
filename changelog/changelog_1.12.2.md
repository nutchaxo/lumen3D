# Plateforme Web — v1.12.2

> **Propreté — doc + tests + carte d'architecture.** Documentation d'ajout de plugins au marketplace,
> tests pérennes pour la couche de config white-label et le marketplace, et mise à jour de `CLAUDE.md`.

## [ADDED]
- **Guide d'ajout de plugins** ([marketplace/README.md](../marketplace/README.md)) — comment publier un plugin en une commande (`tools/publish_plugin.py <dossier> --push`), structure d'un plugin (`plugin.json`/`index.js`/`lang/`), sandboxé vs in-page (confiance), flag `recommended`, dépublication, fonctionnement interne (clé de signature, chaîne de vérification fail-closed, URLs dérivées, octets LF, zip déterministe, modèle app-store), amorçage de la clé.
- **Tests pérennes** ([tests/test_dev_server_site.py](../tests/test_dev_server_site.py), [tests/test_marketplace.py](../tests/test_marketplace.py)) — **+11 tests** (21/21 au total). Site-config : sûreté des noms de doc, save/load/publish/reset, injection `{{SITE:…}}` (résolution + échappement HTML + fallback), génération `theme.css` + scrub des valeurs, **garde de régression du bug 405** (`/api/site.php` routé dans `do_GET` **et** `do_POST`). Marketplace : liste non configurée, sûreté des chemins de désinstallation, extraction durcie (bon/imbriqué/traversal), gate de signature (no-op sans clé / fail-closed avec clé), chaîne build→signe→vérifie (+ déterminisme), et **vérification que le catalogue committé est toujours valablement signé** sous la clé épinglée (hors-ligne, CI-safe).

## [OPTIMIZED]
- **`CLAUDE.md` — carte d'architecture à jour** ([CLAUDE.md](../CLAUDE.md)) — version courante `1.12.1`, nouveau bloc « white-label v1.8.0→v1.12.1 » (couche `config/`, onglets Identité/Pages/Apparence/Légal/Catalogue, `instance-config.js`/`page-renderer.js`, `/api/site.php`, marketplace signé + `publish_plugin.py`, modèle app-store), lignes ajoutées au §2.1/§2.3 et à la table « Where do I find X? » du §7.

[Versioning] Plateforme Web → v1.12.2. changelog_1.12.2.md généré.
