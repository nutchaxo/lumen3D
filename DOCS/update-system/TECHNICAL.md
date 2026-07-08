# Système de mise à jour — documentation technique

> Comment ça marche concrètement. Pour le *pourquoi*, voir [WALKTHROUGH.md](WALKTHROUGH.md) ; pour la **marche à suivre opérationnelle** (publier une release, mettre à jour un plugin, appliquer), voir [RELEASING.md](RELEASING.md).

## 1. Vue d'ensemble

Deux artefacts versionnés indépendamment (le **core** = plateforme + panneau admin ; les
**plugins**), trois préoccupations séparées (détecter / versionner / appliquer) et quatre
garanties (atomicité, rollback auto, health-gate, isolation viewer). Un socle CI rend le tout
fiable en amont.

```
DÉTECTER    Release GitHub (releases/latest) → tag ; asset lumen3d-web-<v>.zip + SHA256SUMS
VERSIONNER  core: changelog_X.Y.Z.md (vérité) → version.json (projection générée)
            plugin: plugin.json#version + platformCompat (liste/range)
APPLIQUER   core: staging → os.replace(arbre) → --check → pivot → /api/health → ✓/rollback
            plugin: (préparé) staging → os.replace(dossier), sans redémarrage
```

## 2. Le pipeline de mise à jour du core (`dev_server.py`)

### 2.1 Machine à états

```
_start_update()  [sous _UPDATE_LOCK : test-and-set running, ferme le TOCTOU]
   │  refus si running / journal de pivot présent / pas de mise à jour
   ▼
_run_update(info)  [thread démon dans le serveur VIVANT — tout est sans effet
   │                sur l'arbre live jusqu'au pivot]
   ├─ preflight   _preflight_update      (même volume, espace disque, backups/ inscriptible)
   ├─ backup      _make_backup_zip        (échec ⇒ abandon ; testzip après écriture)
   ├─ download    _http_download          (Content-Length vérifié ; tronqué ⇒ erreur)
   ├─ verify      SHA256SUMS + testzip
   ├─ staging     _extract_release        (validation anti-zip-slip par entrée)
   │              _validate_staging        (fichiers requis + sha256 de version.json)
   ├─ verifying   _run_offline_check       (sous-processus : dev_server.py --check)
   ├─ planning    _build_plan + journal    (fichiers à poser, fichiers à supprimer)
   └─ pivoting    _spawn_pivot ; arrêt propre du serveur (httpd.shutdown)
        ───────── le serveur vivant se termine ─────────
                          ▼
   _pivot_main(journal)  [processus SUPERVISEUR détaché, copie du script dans %TEMP%]
        ├─ _wait_port_free
        ├─ _apply_plan     (renommages os.replace journalisés, idempotents)
        ├─ _spawn_server   (relance depuis l'arbre NEUF)
        ├─ _probe_health   (/api/health == version cible, ~30 s)
        │     PASS → _finalize_success (efface journal, purge staging)
        │     FAIL → _reverse_plan → _spawn_server (arbre restauré) → last-update = rolled_back
        └─ tout crash → _reverse_plan de secours
```

Au démarrage, `_reconcile_pivot()` consomme tout journal laissé par un pivot interrompu :
finalisation si l'arbre appliqué == version cible, sinon restauration intégrale.

### 2.2 L'échange atomique (`_apply_plan` / `_reverse_plan`)

Chaque fichier suit une **danse à deux renommages** ; chaque étape teste le **disque**, jamais
une hypothèse, donc un rejeu après crash reprend exactement où il s'est arrêté :

```
op fichier    live=ancien, staged=neuf → (live→old) → (staged→live)
op suppression live=ancien             → (live→old)
```

`_reverse_plan` est sûr sur **n'importe quel** état intermédiaire : un fichier promu retourne au
staging, un original en miroir (`old/`) retourne live, une suppression restaurée réapparaît.
Testé dans `tests/test_update_pivot.py` (application complète, restauration, rejeu après crash
partiel, double reverse idempotent).

### 2.3 Ce qui est protégé et ce qui est supprimé

`_UPDATE_PROTECT` liste les chemins jamais touchés : `DATA_WEB`, identifiants/stats/plugins
désactivés/quarantaine, logs, backups, environnements locaux (`.git`, `.venv-312`, `__pycache__`),
et le contenu de dev-checkout (`DOCS`, `preprocess`, `tools`, `README.md`, …) absent des artefacts
par construction. Les **suppressions upstream** sont calculées par diff des manifestes
`version.json` (ancien vs stagé) : un fichier que l'ancienne release livrait mais pas la nouvelle
est supprimé ; un fichier inconnu des deux (ajouté par l'utilisateur) n'est jamais touché.

### 2.4 Le contrôle de démarrage `--check`

`python dev_server.py --check [--root DIR]` valide un arbre **hors-ligne** sans binder de port :
compilation de `dev_server.py`, présence des entrypoints, JSON des langues, cohérence
`version.json` ↔ changelog, et plugins (avertissements non-fatals). Sortie 0/1 + rapport JSON.
Triple usage : garde-fou de pivot (contre l'arbre stagé), test CI, outil manuel.

## 3. Compatibilité plugin ↔ plateforme

### 3.1 Le champ `platformCompat`

```jsonc
"platformCompat": ">=1.4.0 <2.0.0"   // range : comparateurs AND
"platformCompat": "^1.4.0"           // ≡ >=1.4.0 <2.0.0
"platformCompat": "~1.4.1"           // ≡ >=1.4.1 <1.5.0
"platformCompat": ["1.3", "1.4.x"]   // liste : OR de tokens bare
"platformCompat": ["1.4.0", "1.4.1"] // pin exact
// absent ⇒ compatible ; illisible ⇒ incompatible (fail-closed)
```

Tokens bare : 3 parties = exact (`1.4.1`) ; moins = préfixe (`1.4` ≡ `1.4.x` ≡ `>=1.4.0 <1.5.0`).
Les suffixes pré-release (`-rc1`) sont ignorés. Version plateforme = `max(changelog)`.

### 3.2 Les trois résolveurs jumeaux

| Implémentation | Fichier | Signature |
|---|---|---|
| JS (viewer) | `js/core/compat.js` | `Compat.satisfies(platformVersion, decl) → {ok, reason}` |
| Python (dev server) | `dev_server.py` | `_compat_satisfies(platform_version, decl) → (ok, reason)` |
| PHP (fallback) | `api/_admin_lib.php` | `admin_compat_satisfies($ver, $decl) → [ok, reason]` |

Tous les trois sont validés contre `tests/compat-vector.json` (42 cas) par
`tests/test_compat.{py,js,php}`. **Règle : toute modification sémantique doit passer les trois.**

### 3.3 Gating et pré-vol

- **À la découverte** (`/api/plugins`, `plugin-registry.js`, `plugins.php`) : un plugin
  incompatible est filtré côté serveur ET côté client → son `index.js` n'est jamais chargé.
- **Avant une mise à jour core** : `GET /api/admin.php?action=update_preflight&target=X.Y.Z`
  renvoie `{ok:[…], willQuarantine:[…], blocking:[…]}`. `blocking` non vide (aucun mode de rendu
  compatible ne survivrait) → l'UI empêche la confirmation.
- **Auto-réparation** : la quarantaine est réévaluée à chaque `discover()` — un plugin redevenu
  compatible après une mise à jour est réactivé automatiquement.

## 4. Isolation du viewer (`plugin-registry.js` + `viewer.js`)

Registre de quarantaine (`getQuarantined()`) alimenté à chaque point de rejet : meta invalide,
`id` ≠ dossier, placement incohérent, incompatible, `index.js` en échec, `implement()` manquant,
`init()` qui throw. `try/catch` par plugin dans `buildToolbarButtons`/`activate`/`deactivate`/
`initAll`, plus une barrière globale autour de toute la phase plugin dans `viewer.js`. Garantie :
**le canvas 3D démarre toujours**, même si tout le sous-système plugin échoue.

## 5. Détection et endpoints

| Endpoint | Rôle |
|---|---|
| `GET /api/health` | `{ok, web, server, lastUpdate?}` — sonde du pivot + moniteur externe |
| `GET …admin.php?action=update_check` | release la plus récente ; préfère l'asset curé + `SHA256SUMS` |
| `GET …admin.php?action=update_preflight&target=` | rapport de compat plugins vs version cible |
| `POST …admin.php?action=update_apply` | lance le pipeline (auth + CSRF) |
| `GET …admin.php?action=update_status` | phase live ; `last` (résultat persistant) quand idle |
| `POST …admin.php?action=update_ack` | acquitte la bannière de résultat |

## 6. Pipeline CI et artefact

- `tools/check_version.py --tag vX.Y.Z` : `max(changelog) == tag`, monotonie, unicité, changelog
  non vide. `--no-tag` : validation structurelle seule.
- `tools/build_release.py --version X.Y.Z --out dist` : construit `lumen3d-web-X.Y.Z.zip` depuis
  une **allowlist** runtime (fail-safe), génère `version.json` (sha256 par fichier) et
  `SHA256SUMS`. Zip déterministe (entrées triées, timestamps fixes).
- `.github/workflows/release.yml` (tag `v*`) : garde version → `--check` → build → `gh release
  create` avec les notes du changelog. `.github/workflows/ci.yml` (push/PR) : garde + `--check`.

## 7. Installeur autonome (`install.php`)

Fichier unique déposé dans un répertoire web vide. Rôles par type de requête : GET = page
d'assistant (CSS/JS inline, zéro dépendance externe) ; `POST ?api=<step>` = API JSON
(status/check/download/extract/verify/configure/finalize). Sécurité : dépôt GitHub **codé en
dur** (aucune URL utilisateur), validation anti-zip-slip par entrée, credential PBKDF2 écrit en
création-exclusive au format interopérable Python/PHP, CSRF sur chaque POST, **auto-verrouillage**
(refus si un credential existe), auto-suppression proposée en fin. Téléchargement par tranches
avec reprise (Range) pour survivre aux `max_execution_time` mutualisés. État dans
`.install-state.json` (sans secret, supprimé en fin). Détails et mesures de sécurité :
en-tête du fichier `install.php`.

## 8. Fichiers

| Fichier | Rôle |
|---|---|
| `dev_server.py` | pipeline core, superviseur de pivot, `--check`, `/api/health`, `_compat_satisfies`, préflight |
| `js/core/compat.js` | résolveur JS (IIFE classic) + résolution de la version plateforme |
| `js/core/plugin-registry.js` | filtre compat, validation meta, quarantaine, try/catch par plugin |
| `js/pages/viewer.js` | barrière d'isolation autour de la phase plugin |
| `js/pages/admin/tab-updates.js` | UI mises à jour (stepper, pré-vol, suivi restart, résultat) |
| `js/pages/admin/tab-plugins.js` | badges de compatibilité |
| `api/_admin_lib.php`, `admin.php`, `plugins.php` | jumeaux PHP (compat, préflight, filtre discovery) |
| `install.php` | installeur autonome |
| `.github/workflows/{release,ci}.yml`, `tools/{check_version,build_release}.py` | CI + artefact |
| `tests/compat-vector.json`, `test_compat.{py,js,php}`, `test_update_pivot.py` | conformité + cœur du pivot |
