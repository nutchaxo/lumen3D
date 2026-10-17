# Lumen3D — Marketplace de plugins (first-party, signé)

Ce dossier est le **catalogue de plugins** que la plateforme propose à l'installation depuis
le panneau admin (onglet **Catalogue**) et l'assistant de première installation. Il est
**entièrement curé** : seul l'éditeur de la plateforme y publie, et chaque plugin est
distribué en **release signée Ed25519**, vérifiée *fail-closed* à l'installation.

```
marketplace/
├── marketplace-catalog.json         # le catalogue (liste des plugins) — SIGNÉ
├── marketplace-catalog.json.sig     # signature Ed25519 détachée du catalogue
└── plugins/<id>/                    # artefacts de release par plugin :
    ├── plugin-<id>-<ver>.zip        #   le plugin, zip déterministe
    ├── SHA256SUMS                   #   empreinte du zip (format coreutils)
    ├── SHA256SUMS.sig               #   signature Ed25519 détachée du SHA256SUMS
    └── version.json                 #   {id, placement, version, files:{rel:sha256}}
```

---

## Ajouter (ou mettre à jour) un plugin — **une seule commande**

```bash
python tools/publish_plugin.py chemin/vers/mon-plugin --push
```

C'est tout. L'outil :
1. **package + signe** le plugin → `marketplace/plugins/<id>/`,
2. **ajoute/met à jour** son entrée dans `marketplace-catalog.json` (avec les bonnes URLs),
3. **re-signe** le catalogue,
4. avec `--push` : commit **de `marketplace/` seulement** (jamais le reste de l'index) puis push ; le plugin est **live** une fois sur la branche du catalogue (`main`).

Le paquet est construit à côté du dossier publié puis échangé : un `plugin.json` qui échoue au build laisse la version publiée intacte. La graine de signature vient de `LUMEN_MARKETPLACE_SIGNING_KEY` ou de `secrets/marketplace-signing-seed.hex` (voir *Sous le capot*).

Sans `--push`, l'outil prépare tout localement et t'affiche la commande git à lancer.

### Options utiles

| Commande | Effet |
|---|---|
| `publish_plugin.py <dossier>` | prépare (package + catalogue + signature), **sans** pousser |
| `publish_plugin.py <dossier> --push` | + commit + push → **live** |
| `publish_plugin.py <dossier> --recommended false --push` | publie mais **non coché** par défaut dans le sélecteur de 1ʳᵉ install |
| `publish_plugin.py --remove <id> --push` | **dépublie** (retire du catalogue + supprime les artefacts + re-signe) |
| `publish_plugin.py --resign --push` | re-émet le catalogue **inchangé** sous le `serial` suivant (voir *Serial anti-rollback*) |

> Re-publier un plugin **inchangé** ne crée rien (« rien à committer ») — la signature Ed25519
> est déterministe et le catalogue n'est réécrit que si son contenu change. Change au moins la
> `version` (ou le contenu) pour publier une mise à jour.

---

## À quoi ressemble un plugin

Un plugin est un dossier contenant au minimum `plugin.json` + `index.js` (+ `lang/<code>.json`).
Voir les plugins existants sous `js/modules/<placement>/<id>/` comme modèles.

`plugin.json` (la plateforme lit le fichier complet ; le catalogue n'en retient qu'un sous-ensemble, voir ci-dessous) :

```json
{
  "id": "mon-plugin",                 // = nom du dossier, [A-Za-z0-9_][A-Za-z0-9._-]*
  "name": "Mon Plugin",
  "version": "1.0.0",
  "platformCompat": ">=1.8.0",        // versions de plateforme compatibles (résolveur compat.js)
  "creator": "Mon Labo",
  "placement": "tools",               // "tools" | "channels" | "shaders"
  "subtype": "action",                // tools : "action" | "toggle" | "tool" ; channels : "per-channel"
  "group": "view",                    // cluster de la barre d'outils
  "icon": "info",                     // icône Lucide
  "order": 60,
  "dataTypes": ["3d", "live", "2d"],  // types couverts (3d | 2d | live) ; absent = chargé seulement par le visualiseur de volumes (viewer.js)
  "contexts": ["page", "panel"],      // "page" = page autonome ; "panel" = embarqué (page Comparer, vue divisée, aperçu admin) ; absent = ["page"]
  "requires": ["tracking"],           // optionnel : sources que le dataset doit offrir pour que le bouton apparaisse
  "description": "Ce que fait le plugin (affiché sur la carte du catalogue).",
  "sandbox": true,                    // true = exécuté isolé (iframe) ; réservé aux tools action/toggle, voir ci-dessous
  "sandboxCapabilities": ["toolbar.addButton", "viewer.getInfo", "ui.toast"],
  "i18nTitle": "title",
  "i18nLanguages": ["en", "fr"]
}
```

**Ce que retient le catalogue.** L'entrée de `marketplace-catalog.json` porte `id`, `name`,
`placement`, `subtype`, `description`, `creator`, `icon`, `platformCompat`, `sandboxCapabilities`,
`latestVersion` (le `version`), `recommended`, les trois URLs des artefacts et le `sha256` du zip.
`dataTypes`, `contexts`, `requires` et `sandbox` ne sont **pas** recopiés : ils restent dans le
`plugin.json` du zip, que la plateforme lit à l'installation.

### Sandboxé (recommandé) vs in-page — **le niveau de confiance**

- **`"sandbox": true`** — le plugin tourne dans une **iframe null-origin**, sans accès au DOM,
  au `ViewerContext`, aux cookies ni à l'API admin : uniquement le SDK `LumenPlugin` qui broke
  un jeu **restreint de capacités** (`toolbar.addButton`, `ui.toast`, `ui.download`,
  `viewer.getCanvasBlob`, `viewer.getInfo`, `viewer.setRenderMode`, `channels.getState`,
  `events.subscribe`). Un plugin qui ne déclare pas `sandboxCapabilities` reçoit `toolbar.addButton`,
  `ui.toast` et `viewer.getInfo`. C'est le mode **le plus sûr** ; à privilégier. Seuls les `tools`
  (`action`/`toggle`) peuvent être sandboxés : `plugin-registry.js` met en quarantaine tout autre placement sandboxé.
- **In-page (`sandbox` absent/false)** — le plugin s'exécute **en pleine confiance** dans la page
  (accès direct au viewer). Obligatoire pour les `shaders` (GLSL synchrone) et les `channels`
  (remise directe du nœud DOM). Barre de risque plus haute — réservé au first-party.

L'onglet Catalogue et le sélecteur affichent le badge (**bac à sable** vs **confiance totale**).
À l'installation, le plugin atterrit dans le **même trust gate** : approbation opérateur épinglée
au **hash recalculé côté serveur** (jamais celui déclaré — anti-TOCTOU).

### Le flag `recommended`

Chaque entrée du catalogue porte `recommended: true|false`. Les recommandés sont **pré-cochés**
dans le sélecteur de plugins de la **première installation** (l'opérateur peut décocher).
Contrôlé par `--recommended true|false` (par défaut : conserve l'existant, `true` pour un nouveau).

---

## Sous le capot (comment ça reste sûr)

- **Clé de signature.** La graine privée Ed25519 est lue depuis `secrets/marketplace-signing-seed.hex`
  (gitignoré, machine-local) ou la variable d'env `LUMEN_MARKETPLACE_SIGNING_KEY` (prioritaire). Ce n'est
  **pas** `LUMEN_SIGNING_KEY`, la graine des releases du core : `publish_plugin.py` refuse une graine
  dont la clé publique n'est pas `_MARKETPLACE_PUBKEY_HEX`, car tous les hôtes rejetteraient le
  catalogue. La **clé publique** est
  épinglée dans la source (`dev_server.py:_MARKETPLACE_PUBKEY_HEX` + `api/_admin_lib.php:MARKETPLACE_PUBKEY`)
  et committée — elle ship dans chaque release et survit aux auto-updates.
- **Chaîne de vérification (fail-closed).** À l'installation : signature du **catalogue** vérifiée
  sous la clé épinglée → download du zip → signature du **`SHA256SUMS`** vérifiée → sha256 du zip lu
  depuis ces octets authentifiés → extraction durcie (rejet traversal/absolu/bombe) → validation
  `plugin.json` id/placement → gate de compatibilité → move atomique → approbation opérateur.
  **Toute échec laisse `js/modules/` intact.**
- **URLs.** L'outil dérive automatiquement la base d'URL du `_MARKETPLACE_CATALOG_URL` épinglé, donc
  les `assetUrl`/`sumsUrl`/`sigUrl` correspondent toujours à ce que la plateforme va chercher. Le
  catalogue est servi via **GitHub raw** sur la **branche** de cette URL (**`main`**, la branche stable
  des releases) — un plugin n'est **live** qu'une fois sur `main`. Comme le dev se fait sur `dev`
  (CLAUDE.md §1.6), publie puis **merge `dev → main`** (avec `--push`, l'outil t'avertit si la branche
  courante n'est pas `main`).
- **Octets stables.** `SHA256SUMS` et le catalogue sont écrits en **octets bruts (LF)** pour que
  *signé == publié* (une conversion CRLF casserait la signature). Les zips sont **déterministes**
  (entrées triées, timestamp 1980, 0644) → sha256 reproductible.
- **Modèle app-store.** Les plugins ne sont **pas** livrés en dur dans une release (le build
  `tools/build_release.py` les exclut) : une install fraîche démarre sans plugin et installe la
  sélection à la demande depuis ce catalogue.

## Serial anti-rollback

Le catalogue porte un entier `serial` et une date `issuedAt`. `publish_plugin.py` incrémente le
`serial` à chaque changement de contenu (et sur `--resign`), jamais sur une publication sans effet.
Chaque hôte enregistre le plus haut `serial` qu'il a accepté, dans `api/marketplace-state.json`
(Python : `dev_server.py:_marketplace_check_serial` ; PHP : `api/_admin_lib.php:mkt_check_serial`), et
refuse un catalogue de `serial` inférieur (erreur `catalog_rollback`, affichée dans l'onglet Catalogue).
Seul un catalogue dont la signature est vérifiée peut faire monter ce `serial` : un hôte non keyé ne
peut pas être figé par un faux `serial` énorme.

## État du catalogue

Au moment de cette mise à jour, `marketplace-catalog.json` compte **28 plugins** au `serial` **6**
(émis le 2026-10-09). Chacun des 28 dossiers `plugins/<id>/` contient son zip, `SHA256SUMS`,
`SHA256SUMS.sig` et `version.json`, et correspond à une entrée du catalogue. La liste exacte se lit
dans le catalogue lui-même ; elle change à chaque publication.

## Amorcer la clé (déjà fait sur ce dépôt)

La clé publique et l'URL du catalogue sont déjà épinglées dans les sources. Cette procédure ne sert
que pour une nouvelle paire de clés :

```bash
python tools/gen_signing_key.py     # génère la paire
# → coller la CLÉ PUBLIQUE dans dev_server.py:_MARKETPLACE_PUBKEY_HEX ET api/_admin_lib.php:MARKETPLACE_PUBKEY, puis commit
# → stocker la GRAINE PRIVÉE dans secrets/marketplace-signing-seed.hex (gitignoré) et/ou la variable LUMEN_MARKETPLACE_SIGNING_KEY
#   (jamais dans LUMEN_SIGNING_KEY : c'est la clé des releases du core, une autre paire)
# → renseigner _MARKETPLACE_CATALOG_URL / MARKETPLACE_CATALOG_URL (URL raw du catalogue)
```

Clé vide + URL vide = marketplace **inactif** (état par défaut sûr).
