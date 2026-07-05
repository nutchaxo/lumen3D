# Publier une mise à jour — runbook opérationnel

> Marche à suivre concrète pour **publier une nouvelle version du core**, **mettre à jour un plugin**, et **appliquer** une mise à jour côté opérateur. Pour les internes (staging-swap, health-gate, rollback, hachage de confiance), voir [TECHNICAL.md](TECHNICAL.md) ; pour les décisions de conception, [WALKTHROUGH.md](WALKTHROUGH.md).
>
> **À retenir d'emblée :** le **core** a un pipeline de release complet (`changelog → tag → CI → release GitHub → panel admin`). Les **plugins** sont *drop-in* : il n'existe **aucun** endpoint d'installation/mise à jour de plugin ni de marketplace. `plugin.json#version` et `platformCompat` sont des **métadonnées** (compat + affichage), pas un mécanisme de déploiement.

---

## 0. Prérequis (une seule fois) — activer la signature Ed25519

Facultatif mais recommandé : sans clé, les releases sont vérifiées par **intégrité sha256 seule** (l'updater le signale bruyamment). Avec une clé, l'authenticité est **obligatoire, fail-closed**.

```bash
python tools/gen_signing_key.py
```
Cela imprime une paire (rien n'est écrit sur le disque). Ensuite :

1. Colle la **clé publique** dans les deux constantes épinglées, **dans la source du dépôt**, puis **commit** :
   - `dev_server.py` → `_RELEASE_PUBKEY_HEX = "…"`
   - `install.php` → `const PINNED_PUBKEY = '…';`
2. Pose la **graine privée** comme secret GitHub `LUMEN_SIGNING_KEY` (Settings → Secrets and variables → Actions).

> ⚠️ **La clé doit vivre dans la source, pas seulement sur un hôte déployé.** `dev_server.py` n'est **pas** protégé des mises à jour (`_UPDATE_PROTECT`) : une clé posée uniquement sur un serveur en prod serait **écrasée par la prochaine update**. Commitée dans le dépôt, elle ship dans chaque release et survit aux updates (modèle « l'opérateur est aussi l'éditeur »).
>
> **Amorçage (TOFU) :** la **première** release qui introduit la clé est authentifiée par sha256 seul — le serveur courant, encore sans clé, ne peut pas vérifier une signature qu'il n'épingle pas encore. Toutes les suivantes sont vérifiées par signature.

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

Si un **plugin bundled** (livré dans le dépôt, sous `js/modules/`) a changé, bumpe aussi son `plugin.json#version` — il part avec cette release.

### A.2 — Commit

```bash
git add -A
git commit -m "…"
git push origin dev
```

### A.3 — Vérifier localement (facultatif mais conseillé)

```bash
python tools/check_version.py --tag v1.7.1   # tag == changelog le plus récent ?
python dev_server.py --check                 # l'arbre démarre-t-il ?
```

### A.4 — Taguer → la CI publie

```bash
git tag v1.7.1
git push origin v1.7.1
```

- Le tag **doit** égaler la version du changelog le plus récent (le garde-fou CI `tools/check_version.py` échoue sinon).
- Le tag peut être sur `dev`, ou sur `main` après un merge `dev→main` si tu gardes `main` stable — la CI se déclenche sur le **tag**, pas sur la branche ; il faut juste que le commit taggé **contienne le fichier changelog**.

La CI (`.github/workflows/release.yml`) enchaîne automatiquement :
1. garde de version (`check_version.py`),
2. test de démarrage (`dev_server.py --check`),
3. build de l'artefact curé (`tools/build_release.py`) → `lumen3d-web-1.7.1.zip` + `version.json` + `SHA256SUMS` (+ `SHA256SUMS.sig` **si** `LUMEN_SIGNING_KEY` est posé),
4. `gh release create` publie les assets.

### A.5 — Appliquer (côté opérateur)

- **Mise à jour d'une install existante** : Panel admin → onglet **Mises à jour** → *Vérifier* → *Appliquer*. Le serveur télécharge l'asset curé, (vérifie la signature si clé épinglée), le met en *staging*, teste son démarrage, bascule atomiquement, sonde `/api/health`, et **rollback automatiquement** si le nouveau ne répond pas.
- **Première install** : déposer `install.php` seul sur l'hôte et l'ouvrir dans un navigateur (wizard : prérequis → download → extraction → compte admin). Il se verrouille après succès.

---

## B) Mettre à jour / ajouter un PLUGIN

Aucun pipeline de release plugin. Tout passe par le placement de fichiers + le gate de confiance. Deux cas distincts.

### B.1 — Plugin *bundled* (dans le dépôt)

1. Édite `js/modules/<placement>/<id>/{plugin.json, index.js, lang/}`.
2. Bumpe `plugin.json#version` et ajuste `platformCompat` :
   - liste : `"platformCompat": ["1.x"]` ou `["1.6.x","1.7.x"]`
   - range : `">=1.6.0 <2.0.0"`, `"^1.7.0"`, `"~1.7.0"`
   - absent ⇒ compatible ; illisible ⇒ **incompatible** (fail-closed, quarantaine).
3. Il part avec la **prochaine release du core** (section A) — pas de release séparée. Sa version s'affiche dans l'admin ; `platformCompat` décide s'il se charge (sinon quarantaine « incompatible »).

> Conséquence : après un bump majeur du core (ex. `2.0.0`), un plugin déclarant `"1.x"` cessera de charger jusqu'à ce que son `platformCompat` soit élargi.

### B.2 — Plugin *tiers* (déposé par l'opérateur, hors dépôt)

1. **Déposer** le dossier dans `js/modules/<placement>/<id>/` sur l'hôte → auto-découvert, mais **`untrusted`** : il **ne s'exécute pas** tant que l'opérateur ne l'approuve pas.
2. **Approuver** : Panel admin → onglet **Plugins** → choisir *in-page* ou *sandboxé* (+ capabilities), avec ré-authentification. L'approbation est **épinglée au hash du contenu**.
3. **Pour le mettre à jour → remplacer ses fichiers.**
   - ⚠️ Changer les fichiers **invalide l'approbation** (le hash change) → le plugin **redevient `untrusted`** → **à ré-approuver**. Ce n'est **pas** un bug : c'est l'anti-TOCTOU — le code exécuté doit correspondre exactement à ce que l'opérateur a validé.
4. Ces plugins tiers **survivent aux updates du core** : la suppression lors d'une update ne concerne que les fichiers de la **release précédente** (`version.json`), et un dossier ajouté par l'opérateur n'y figure jamais (`dev_server.py:_build_plan`).

---

## C) Récapitulatif

| | **Core** | **Plugin bundled** | **Plugin tiers** |
|---|---|---|---|
| Bumper la version | nouveau `changelog/changelog_X.Y.Z.md` | `plugin.json#version` | `plugin.json#version` (indicatif) |
| Publier | tag `vX.Y.Z` → CI → release GitHub | part avec la release core | déposer le dossier sur l'hôte |
| Appliquer | admin → Mises à jour → Appliquer | idem (dans la release core) | approuver / **ré-approuver** (hash) |
| Barrière de compat | garde CI `tag == changelog` | `platformCompat` | `platformCompat` + trust gate |
| Signature | Ed25519 (si clé épinglée) | couverte par la release core | hors périmètre (fichiers locaux) |

---

## D) Pièges & dépannage

- **La CI échoue « tag ≠ changelog »** → le tag `vX.Y.Z` ne correspond pas au changelog le plus récent. Crée le fichier `changelog_X.Y.Z.md` manquant (ou corrige le tag).
- **Release non signée alors qu'une clé est épinglée** → l'updater **refuse** (fail-closed). Vérifie que le secret `LUMEN_SIGNING_KEY` est bien posé et que la CI a produit `SHA256SUMS.sig`.
- **Après une update, l'authenticité repasse en « sha256 seul »** → la clé n'était posée que sur l'hôte, pas dans la source du dépôt (cf. §0). Pose-la dans la source et republie.
- **Un plugin tiers redevient `untrusted` après édition** → comportement attendu (hash pinning). Ré-approuve-le.
- **Un plugin disparaît après un bump majeur du core** → `platformCompat` ne couvre pas la nouvelle version ; élargis-le et republie (bundled) ou remplace les fichiers (tiers).
- **La bascule échoue** → l'installation reste **intacte** (rien n'est muté avant le pivot ; le pivot rollback si `/api/health` ne répond pas). Voir `backups/pivot-journal.json` et `logs/update-pivot-*.log`.

---

*Fichiers de référence : [tools/build_release.py](../../tools/build_release.py), [tools/check_version.py](../../tools/check_version.py), [tools/gen_signing_key.py](../../tools/gen_signing_key.py), [.github/workflows/release.yml](../../.github/workflows/release.yml), [install.php](../../install.php), [dev_server.py](../../dev_server.py) (`_run_update`, `_build_plan`, `_verify_release_signature`), [ed25519_pure.py](../../ed25519_pure.py).*
