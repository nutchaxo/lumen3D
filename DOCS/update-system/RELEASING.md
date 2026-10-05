# Publier une mise à jour — runbook opérationnel

> Marche à suivre concrète pour **publier une nouvelle version du core**, **mettre à jour un plugin**, et **appliquer** une mise à jour côté opérateur. Pour les internes (staging-swap, health-gate, rollback, hachage de confiance), voir [TECHNICAL.md](TECHNICAL.md) ; pour les décisions de conception, [WALKTHROUGH.md](WALKTHROUGH.md).
>
> **À retenir d'emblée :** le **core** a un pipeline de release complet (`changelog → tests → tag → CI (suite complète + build signé) → release GitHub → panel admin`). Les **plugins de la plateforme** ne sont **pas** dans la release : ils sont publiés dans la **marketplace signée** (`marketplace/`, servie depuis `main`) et installés à la demande depuis l'admin. Les plugins **tiers** restent *drop-in* (dépôt du dossier + approbation de l'opérateur).

---

## 0. Prérequis — la signature Ed25519 est obligatoire

Une release **non signée n'est jamais publiée** : la CI échoue sans clé, et vérifie la signature contre la clé épinglée avant toute publication. Côté hôte, l'updater et l'installeur exigent la signature (fail-closed) dès qu'une clé est épinglée — ce qui est le cas.

État actuel (déjà en place, rien à refaire pour publier) :

- **Clé publique épinglée dans la source** (les trois valeurs doivent être identiques) :
  - `dev_server.py` → `_RELEASE_PUBKEY_HEX` (updater Python),
  - `install.php` → `const PINNED_PUBKEY` (installeur),
  - `api/_admin_lib.php` → `const LUMEN_RELEASE_PUBKEY` (updater des hôtes PHP).
- **Graine privée** dans le secret GitHub `LUMEN_SIGNING_KEY` (Settings → Secrets and variables → Actions).

Changer de clé (rotation, compromission) : `python tools/gen_signing_key.py` imprime une paire (rien n'est écrit sur le disque) ; colle la clé publique dans les **trois** constantes ci-dessus, **commite**, et remplace le secret `LUMEN_SIGNING_KEY`. `tools/verify_release_signature.py` (lancé par la CI) refuse une release dont la signature ne correspond pas à la clé épinglée ou dont les clés épinglées divergent.

> ⚠️ **La clé doit vivre dans la source, pas seulement sur un hôte déployé.** `dev_server.py` n'est **pas** protégé des mises à jour (`_UPDATE_PROTECT`) : une clé posée uniquement sur un serveur en prod serait **écrasée par la prochaine update**. Commitée dans le dépôt, elle ship dans chaque release et survit aux updates.
>
> **Rotation :** un hôte n'accepte que la clé qu'il épingle. La release qui **introduit** une nouvelle clé doit donc encore être signée avec l'**ancienne** (l'hôte la vérifie avec la clé qu'il connaît, puis installe le code qui épingle la nouvelle) ; seules les suivantes sont signées avec la nouvelle.
>
> La marketplace a sa **propre** clé (`_MARKETPLACE_PUBKEY_HEX`, graine `LUMEN_MARKETPLACE_SIGNING_KEY` ou `secrets/marketplace-signing-seed.hex`) : voir [marketplace/README.md](../../marketplace/README.md). Ne jamais signer l'une avec la graine de l'autre.

---

## A) Publier une mise à jour du CORE

### A.1 — Développer et bumper la version

Développe sur `dev`. **La version de la plateforme = le nom du changelog le plus récent** ; il n'y a pas de constante `__version__` pour la plateforme (celle de `dev_server.py` est la version de l'outil serveur, elle *drifte* volontairement). Bumper = **créer un fichier** :

```
changelog/changelog_1.7.1.md     # fix / shader / script          → bump Z
changelog/changelog_1.8.0.md     # nouvel outil / sous-système     → bump Y
```

Format (voir `changelog_1.7.0.md` comme gabarit) :
```markdown
# Plateforme Web — v1.7.1

> Résumé d'une ligne.

## [ADDED]
- …
## [OPTIMIZED]
- …
## [FIXED]
- …

[Versioning] Plateforme Web → v1.7.1. changelog_1.7.1.md généré.
```

> **Depuis la v1.55.0, le changelog est écrit en anglais**, une entrée par puce sous la forme `- **Short title**: what changed and why`. Le panneau admin replie les notes sur le titre en gras seul (*Titles only*), et chaque release embarque **tous** les changelogs du niveau `changelog/` dans l'asset `lumen3d-release-notes.json` : un hôte qui a sauté des versions lit ainsi les notes de chacune d'elles, une pastille par version, jusqu'à celle qui sera installée.

Si un **plugin de la plateforme** (sous `js/modules/`) a changé, bumpe son `plugin.json#version` et republie-le dans la marketplace (section B.1) — il ne part **pas** avec la release du core.

### A.2 — Commit

```bash
git add -A
git commit -m "…"
git push origin dev
```

### A.3 — Vérifier localement

```bash
python tests/run_all.py -j 4                 # toute la suite (JS, Python, PHP) — la CI la rejoue
python tools/check_version.py --tag v1.7.1   # tag == changelog le plus récent ?
python dev_server.py --check                 # l'arbre démarre-t-il ?
```

La CI lance la suite en mode strict (`--strict-skips --check-clean`) : un test qui échoue, qui est **sauté** (dépendance absente) ou qui **modifie le dépôt** bloque la release. Localement, seuls les sauts dus à une dépendance absente (`h5py`, extension PHP `zip`) sont acceptables.

### A.4 — Taguer → la CI publie

```bash
python tools/make_release.py            # vérifie, tague vX.Y.Z sur HEAD et pousse le tag
python tools/make_release.py --dry-run  # montre ce qui serait fait
python tools/make_release.py --watch    # suit ensuite le run CI (gh requis)
```

`make_release.py` **ne crée pas** la release GitHub : il vérifie la structure du changelog, refuse un arbre sale ou une autre branche que `main` (`--allow-branch` / `--allow-dirty` pour forcer), **tague** `vX.Y.Z` et **pousse le tag**. Créer la release à la main publierait d'abord une release sans assets (l'updater se rabattrait sur le zip source, invérifiable) : c'est la CI qui la crée.

- Le tag **doit** égaler la version du changelog le plus récent (le garde-fou CI `tools/check_version.py` échoue sinon).
- La CI se déclenche sur le **tag**, pas sur la branche ; le commit taggé doit **contenir le fichier changelog**.

La CI (`.github/workflows/release.yml`) enchaîne :
1. **job `test`** : garde de version (`check_version.py`), test de démarrage (`dev_server.py --check`), dépendances du pipeline, **suite complète** `tests/run_all.py --strict-skips --check-clean`, invariants de sécurité (pas d'`allow-same-origin`, pas d'`eval`/`new Function`, pas de `<script src>` CDN) ;
2. **job `release`** (seulement si `test` est vert) : refus immédiat si le secret `LUMEN_SIGNING_KEY` est absent ; build du **pack de traitement complet** (`build_pipeline_bundle.py --full`, avant le zip pour être couvert par la signature) ; build de l'artefact curé **signé** (`build_release.py --require-signature`) → `lumen3d-web-X.Y.Z.zip` + `version.json` + `SHA256SUMS` + `SHA256SUMS.sig` + `lumen3d-release-notes.json`, le pack léger copié dans `dist/`, les **deux packs** dans `SHA256SUMS` ; **vérification** de `SHA256SUMS.sig` contre la clé épinglée (`tools/verify_release_signature.py`) ;
3. **publication** : la release est créée en **brouillon**, reçoit **tous** ses assets, puis est publiée (`--draft=false --latest`). Un hôte qui interroge `releases/latest` ne voit donc jamais une release sans son zip. Si une release existe déjà pour le tag, ses assets sont remplacés et ses notes rafraîchies.

> **Les packs sont nommés d'après la version du PIPELINE**, pas celle de la plateforme. C'est ce qui permet au panneau admin de comparer le pack installé sur l'hôte à celui publié, sans rien télécharger — et donc de proposer une mise à jour du pipeline **sans** mise à jour de la plateforme (onglets *Pipeline* et *Mises à jour*, depuis la web v1.44.0). Un pack qui n'est pas joint à la release n'est pas détectable : ne retire pas ces assets.

### A.5 — Appliquer (côté opérateur)

- **Mise à jour d'une install existante** : Panel admin → onglet **Mises à jour** → *Vérifier* → *Appliquer*. Le serveur télécharge **l'asset nommé d'après la version** (jamais le zip source de GitHub), exige qu'il figure dans `SHA256SUMS` avec la bonne empreinte et que `SHA256SUMS.sig` soit valide pour la clé épinglée, le met en *staging*, teste son démarrage, bascule atomiquement, sonde `/api/health`, et **rollback automatiquement** si le nouveau ne répond pas. Une release invérifiable est refusée avec la raison affichée.
- **Première install** : déposer `install.php` seul sur l'hôte et l'ouvrir dans un navigateur (wizard : prérequis → download → extraction → compte admin). Il se verrouille après succès.

---

## B) Mettre à jour / ajouter un PLUGIN

### B.1 — Plugin de la plateforme (dans le dépôt → marketplace signée)

Les plugins sous `js/modules/` ne sont **pas** livrés dans la release du core (`build_release.py` exclut `js/modules/{tools,channels,shaders}/*`) : ils sont publiés dans la marketplace et installés depuis l'admin (onglet **Catalogue**, et sélection au premier lancement).

1. Édite `js/modules/<placement>/<id>/{plugin.json, index.js, lang/}`.
2. Bumpe `plugin.json#version`. Si le plugin appelle **sans repli** une API du core apparue dans une version récente, relève le plancher `platformCompat` (ex. `">=1.57.0"`) — sinon un hôte plus ancien l'installerait et perdrait la fonction sans le dire :
   - liste : `"platformCompat": ["1.x"]` ou `["1.6.x","1.7.x"]`
   - range : `">=1.6.0 <2.0.0"`, `"^1.7.0"`, `"~1.7.0"`
   - absent ⇒ compatible ; illisible ⇒ **incompatible** (fail-closed, quarantaine).
3. Si un plugin est ajouté ou retiré : régénère le manifeste statique (`python tools/gen_plugins_manifest.py`) et la liste de secours de `js/core/plugin-registry.js` (`_DEFAULT_MODULE_PATHS`).
4. Publie : `python tools/publish_plugin.py js/modules/<placement>/<id>` prépare le paquet signé et met à jour le catalogue signé ; `--push` commite **uniquement** `marketplace/` et pousse. La graine de la marketplace vient de `LUMEN_MARKETPLACE_SIGNING_KEY` ou de `secrets/marketplace-signing-seed.hex` (voir [marketplace/README.md](../../marketplace/README.md)).
5. **La publication est effective au merge `dev → main`** : le catalogue est servi depuis `main`. Les hôtes mettent à jour le core **puis** les plugins.

> Conséquence : après un bump majeur du core (ex. `2.0.0`), un plugin déclarant `"1.x"` cessera de charger jusqu'à ce que son `platformCompat` soit élargi et le plugin republié.

### B.2 — Plugin *tiers* (déposé par l'opérateur, hors dépôt)

1. **Déposer** le dossier dans `js/modules/<placement>/<id>/` sur l'hôte → auto-découvert, mais **`untrusted`** : il **ne s'exécute pas** tant que l'opérateur ne l'approuve pas.
2. **Approuver** : Panel admin → onglet **Plugins** → choisir *in-page* ou *sandboxé* (+ capabilities), avec ré-authentification. L'approbation est **épinglée au hash du contenu**.
3. **Pour le mettre à jour → remplacer ses fichiers.**
   - ⚠️ Changer les fichiers **invalide l'approbation** (le hash change) → le plugin **redevient `untrusted`** → **à ré-approuver**. Ce n'est **pas** un bug : c'est l'anti-TOCTOU — le code exécuté doit correspondre exactement à ce que l'opérateur a validé.
4. Ces plugins tiers **survivent aux updates du core** : la suppression lors d'une update ne concerne que les fichiers de la **release précédente** (`version.json`), et un dossier ajouté par l'opérateur n'y figure jamais (`dev_server.py:_build_plan`).

---

## C) Récapitulatif

| | **Core** | **Plugin de la plateforme** | **Plugin tiers** |
|---|---|---|---|
| Bumper la version | nouveau `changelog/changelog_X.Y.Z.md` | `plugin.json#version` | `plugin.json#version` (indicatif) |
| Publier | `make_release.py` (tag) → CI : tests, build signé, brouillon → assets → publication | `publish_plugin.py <dir> --push`, effectif au merge sur `main` | déposer le dossier sur l'hôte |
| Appliquer | admin → Mises à jour → Appliquer | admin → Catalogue | approuver / **ré-approuver** (hash) |
| Barrière | suite de tests complète + garde `tag == changelog` | `platformCompat` | `platformCompat` + trust gate |
| Signature | Ed25519 **obligatoire** (`LUMEN_SIGNING_KEY`, clé épinglée) | Ed25519 de la marketplace (clé séparée) | hors périmètre (fichiers locaux) |

---

## D) Pièges & dépannage

- **La CI échoue « tag ≠ changelog »** → le tag `vX.Y.Z` ne correspond pas au changelog le plus récent. Crée le fichier `changelog_X.Y.Z.md` manquant (ou corrige le tag).
- **La CI échoue « secret LUMEN_SIGNING_KEY is not set »** → le secret manque ou a été supprimé : rien n'est publié. Pose-le et relance le run.
- **La CI échoue à « Verify SHA256SUMS.sig »** → la graine du secret ne correspond pas à la clé épinglée, ou les trois constantes épinglées divergent (cf. §0).
- **La CI échoue au job `test`** → un test échoue, est sauté ou modifie le dépôt : rien n'est publié. Corrige, commite, puis publie un patch (nouveau changelog + nouveau tag).
- **Après une update, l'authenticité repasse en « sha256 seul »** → la clé n'était posée que sur l'hôte, pas dans la source du dépôt (cf. §0). Pose-la dans la source et republie.
- **Un plugin tiers redevient `untrusted` après édition** → comportement attendu (hash pinning). Ré-approuve-le.
- **Un plugin disparaît après un bump majeur du core** → `platformCompat` ne couvre pas la nouvelle version ; élargis-le et republie-le dans la marketplace (plateforme) ou remplace les fichiers (tiers).
- **Un plugin publié n'apparaît pas dans le catalogue des hôtes** → il a été publié sur `dev` : le catalogue est lu sur `main`, merge `dev → main`.
- **La bascule échoue** → l'installation reste **intacte** (rien n'est muté avant le pivot ; le pivot rollback si `/api/health` ne répond pas). Voir `backups/pivot-journal.json` et `logs/update-pivot-*.log`.

---

*Fichiers de référence : [tools/make_release.py](../../tools/make_release.py), [tools/build_release.py](../../tools/build_release.py), [tools/verify_release_signature.py](../../tools/verify_release_signature.py), [tools/check_version.py](../../tools/check_version.py), [tools/gen_signing_key.py](../../tools/gen_signing_key.py), [tools/publish_plugin.py](../../tools/publish_plugin.py), [tests/run_all.py](../../tests/run_all.py), [.github/workflows/release.yml](../../.github/workflows/release.yml), [install.php](../../install.php), [dev_server.py](../../dev_server.py) (`_run_update`, `_build_plan`, `_verify_release_signature`), [ed25519_pure.py](../../ed25519_pure.py).*
