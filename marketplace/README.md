# Lumen3D — Marketplace de plugins (first-party, signé)

Ce dossier est le **catalogue de plugins** que la plateforme propose à l'installation depuis
le panneau admin (onglet **Catalogue**) et l'assistant de première installation. Il est
**entièrement curé** : seul l'éditeur de la plateforme y publie, et chaque plugin est
distribué en **release signée Ed25519**, vérifiée *fail-closed* à l'installation.

```
marketplace/
├── marketplace-catalog.json         # le catalogue (liste des plugins) — SIGNÉ
├── marketplace-catalog.json.sig     # signature Ed25519 détachée du catalogue
├── src/<placement>/<id>/            # (option.) sources des plugins propres au marketplace
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
4. avec `--push` : **`git add/commit/push`** → le plugin est **live** immédiatement.

Sans `--push`, l'outil prépare tout localement et t'affiche la commande git à lancer.

### Options utiles

| Commande | Effet |
|---|---|
| `publish_plugin.py <dossier>` | prépare (package + catalogue + signature), **sans** pousser |
| `publish_plugin.py <dossier> --push` | + commit + push → **live** |
| `publish_plugin.py <dossier> --recommended false --push` | publie mais **non coché** par défaut dans le sélecteur de 1ʳᵉ install |
| `publish_plugin.py --remove <id> --push` | **dépublie** (retire du catalogue + supprime les artefacts + re-signe) |

> Re-publier un plugin **inchangé** ne crée rien (« rien à committer ») — la signature Ed25519
> est déterministe. Change au moins la `version` (ou le contenu) pour publier une mise à jour.

---

## À quoi ressemble un plugin

Un plugin est un dossier contenant au minimum `plugin.json` + `index.js` (+ `lang/<code>.json`).
Voir les plugins existants sous `js/modules/<placement>/<id>/` comme modèles.

`plugin.json` (métadonnées lues par le catalogue **et** par la plateforme) :

```json
{
  "id": "mon-plugin",                 // = nom du dossier, [A-Za-z0-9_][A-Za-z0-9._-]*
  "name": "Mon Plugin",
  "version": "1.0.0",
  "platformCompat": ">=1.8.0",        // versions de plateforme compatibles (résolveur compat.js)
  "creator": "Mon Labo",
  "placement": "tools",               // "tools" | "channels" | "shaders"
  "subtype": "action",                // "action" | "toggle" | "tool" (pour tools)
  "group": "view",                    // cluster de la barre d'outils
  "icon": "info",                     // icône Lucide
  "order": 60,
  "description": "Ce que fait le plugin (affiché sur la carte du catalogue).",
  "sandbox": true,                    // true = exécuté isolé (iframe) ; voir ci-dessous
  "sandboxCapabilities": ["toolbar.addButton", "viewer.getInfo", "ui.toast"],
  "i18nTitle": "title",
  "i18nLanguages": ["en", "fr"]
}
```

### Sandboxé (recommandé) vs in-page — **le niveau de confiance**

- **`"sandbox": true`** — le plugin tourne dans une **iframe null-origin**, sans accès au DOM,
  au `ViewerContext`, aux cookies ni à l'API admin : uniquement le SDK `LumenPlugin` qui broke
  un jeu **restreint de capacités** (`toolbar.addButton`, `ui.toast`, `ui.download`,
  `viewer.getCanvasBlob`, `viewer.getInfo`, `viewer.setRenderMode`, `channels.getState`,
  `events.subscribe`). C'est le mode **le plus sûr** ; à privilégier. Seuls les `tools`
  (`action`/`toggle`) peuvent être sandboxés.
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
  (gitignoré, machine-local) ou la variable d'env `LUMEN_SIGNING_KEY`. La **clé publique** est
  épinglée dans la source (`dev_server.py:_MARKETPLACE_PUBKEY_HEX` + `api/_admin_lib.php:MARKETPLACE_PUBKEY`)
  et committée — elle ship dans chaque release et survit aux auto-updates.
- **Chaîne de vérification (fail-closed).** À l'installation : signature du **catalogue** vérifiée
  sous la clé épinglée → download du zip → signature du **`SHA256SUMS`** vérifiée → sha256 du zip lu
  depuis ces octets authentifiés → extraction durcie (rejet traversal/absolu/bombe) → validation
  `plugin.json` id/placement → gate de compatibilité → move atomique → approbation opérateur.
  **Toute échec laisse `js/modules/` intact.**
- **URLs.** L'outil dérive automatiquement la base d'URL du `_MARKETPLACE_CATALOG_URL` épinglé, donc
  les `assetUrl`/`sumsUrl`/`sigUrl` correspondent toujours à ce que la plateforme va chercher. Le
  catalogue est servi via **GitHub raw** sur la **branche** de cette URL (actuellement `dev`) — publie
  sur cette branche (l'outil t'avertit si tu n'y es pas).
- **Octets stables.** `SHA256SUMS` et le catalogue sont écrits en **octets bruts (LF)** pour que
  *signé == publié* (une conversion CRLF casserait la signature). Les zips sont **déterministes**
  (entrées triées, timestamp 1980, 0644) → sha256 reproductible.
- **Modèle app-store.** Les plugins ne sont **pas** livrés en dur dans une release (le build
  `tools/build_release.py` les exclut) : une install fraîche démarre sans plugin et installe la
  sélection à la demande depuis ce catalogue.

## Amorcer la clé (si le marketplace n'est pas encore keyé)

```bash
python tools/gen_signing_key.py     # génère la paire
# → coller la CLÉ PUBLIQUE dans dev_server.py:_MARKETPLACE_PUBKEY_HEX ET api/_admin_lib.php:MARKETPLACE_PUBKEY, puis commit
# → stocker la GRAINE PRIVÉE dans secrets/marketplace-signing-seed.hex (gitignoré) et/ou le secret CI LUMEN_SIGNING_KEY
# → renseigner _MARKETPLACE_CATALOG_URL / MARKETPLACE_CATALOG_URL (URL raw du catalogue)
```

Clé vide + URL vide = marketplace **inactif** (état par défaut sûr).
