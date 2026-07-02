# Système de mise à jour — cheminement, décisions, observations

> Journal de conception du sous-système de mise à jour livré en v1.5.0. Documente
> le *pourquoi* des choix, pas seulement le *quoi* (voir [TECHNICAL.md](TECHNICAL.md)
> pour le fonctionnement concret).

## 1. Point de départ : ce qui existait et pourquoi ça cassait

L'updater d'origine (`_run_update` dans `dev_server.py`) faisait : backup zip → download du
zipball GitHub → extraction → **copie fichier par fichier directement sur l'installation
vivante** → `os.execv` inconditionnel 1,5 s plus tard. Trois défauts confirmés, mutuellement
aggravants :

1. **Aucune atomicité.** `_copy_tree_filtered` écrasait `ROOT` fichier par fichier. Toute
   interruption (kill, disque plein, verrou Windows) laissait un arbre mi-ancien/mi-nouveau
   non amorçable, sans marqueur.
2. **Échecs silencieux.** Un `except OSError: pass` par fichier avalait les erreurs (fichier
   verrouillé, ENOSPC), puis le code passait quand même à `phase='done'`, `pct=100` — un update
   partiel rapporté comme un succès complet.
3. **Redémarrage aveugle.** `os.execv` relançait sans vérifier que la nouvelle version démarre.
   Une erreur de syntaxe/import dans le nouveau `dev_server.py` → le site restait éteint, et le
   backup zip créé n'était **jamais** restauré par aucun code.

Deux hypothèses ont été explorées puis **écartées** après vérification : le zip-slip via
`extractall` (CPython assainit les noms depuis 2.7.4) et un champ `error` prétendument obsolète
(remis à zéro par `_start_update`). On ne durcit pas contre des non-problèmes.

## 2. Le choix d'architecture central : Blue-Green Staging Swap

Quatre architectures ont été mises en concurrence :

| Approche | Atomicité | Rejeté parce que… |
|---|---|---|
| Journal transactionnel in-place | par fichier | fenêtre « arbre déchiré » toujours présente ; recovery-au-boot fragile |
| Checkout git (fetch + reset) | forte | suppose `ROOT` = checkout git propre → faux en déploiement labo/PHP |
| Superviseur permanent (run.py) | — (borne juste le rayon) | change la commande de lancement, 2ᵉ process permanent, apply non atomique |
| **Blue-Green Staging Swap** | **par dossier (`os.replace`)** | **retenu** |

**Décision : Staging Swap.** C'est le seul qui atteint une **vraie atomicité par renommage de
répertoire** — `os.replace` sur NTFS est une opération de métadonnées MFT, indivisible. `ROOT`
n'est touché que par des renommages atomiques, jamais par une copie en place. On y greffe deux
éléments empruntés aux autres designs : le **health-gate** (contrôle offline `--check` + sonde
online `/api/health`) et un **verrou réel** fermant la course TOCTOU.

### Observations Windows qui ont façonné le design
- Le processus serveur **verrouille son CWD** : impossible de renommer `ROOT` tant qu'on tourne
  dedans. → le superviseur de pivot tourne depuis `%TEMP%` (`cwd=tempfile.gettempdir()`).
- Le `dev_server.py` vivant fait *partie* du swap. → on exécute une **copie** du script dans
  `%TEMP%` comme superviseur, pas le fichier en cours de remplacement.
- Antivirus/indexeurs posent des **verrous transitoires** sur les fichiers fraîchement écrits.
  → `os.replace` avec retries bornés sur `PermissionError` (`_rename_retry`).
- `os.execv` sur Windows a une sémantique douteuse pour un service détaché. → on préfère
  `subprocess.Popen` avec `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` pour respawn le serveur.

## 3. La deuxième dimension : plugins et compatibilité

Le besoin : les plugins ont leur propre cycle de vie et déclarent leur compatibilité plateforme
(liste ou range). Le fait dominant qui a tout orienté : **`index.js` d'un plugin s'exécute avec
les pleins privilèges de la page**. Un plugin tiers non-fiable = prise de contrôle complète.

**Décision : rester en modèle « bundled » pour l'instant.** Les 16 plugins restent dans le repo
core (garantis compatibles, jamais cassables hors-ligne). On ajoute la *couche* compatibilité +
isolation, et on prépare — sans l'activer — un registre central first-party pour plus tard. Le
modèle « chaque plugin déclare son URL de téléchargement » est explicitement écarté par défaut
(surface d'attaque maximale). **Le champ `platformCompat` gate la fonctionnalité, jamais la
confiance.**

### Format de compatibilité : un seul champ, deux formes
`platformCompat` accepte une **chaîne** (range : `>=1.4.0 <2.0.0`, `^`, `~`, ou token bare/prefix)
ou un **tableau** (liste = OR de tokens bare). Discriminé par type JSON — pas de `||` dans une
chaîne (la liste couvre déjà l'OR, ce qui garde le parseur minimal). Sémantique fail-safe :
absent ⇒ compatible (back-compat des 16 plugins), illisible ⇒ **incompatible** (jamais une
exception qui remonte, jamais « compatible par défaut »).

**Décision structurante : trois résolveurs jumeaux (JS, Python, PHP) validés contre UN vecteur
de conformité partagé** (`tests/compat-vector.json`, 42 cas). C'est le garde-fou contre la dérive
silencieuse entre les trois implémentations — toute modification sémantique doit passer les trois.

### Isolation : un plugin cassé ne casse jamais le viewer
Observation : `discover + loadModules + buildToolbarButtons` tournaient **hors try/catch** au
top-level de `viewer.js`. Un seul `plugin.json` malformé pouvait faire tomber tout le viewer.
Correctifs : `try/catch` par plugin partout (build/activate/deactivate/init), validation de meta
avant tout enregistrement, barrière globale dans `viewer.js`, et un **registre de quarantaine**
qui transforme les échecs console-only en diagnostic opérateur (badges dans le panneau admin).

## 4. La troisième dimension : détection, versionnage, application

Question tranchée : *où* regarde-t-on les mises à jour ? Réponse — trois questions distinctes :
- **Détecter** → Releases GitHub (événement de publication délibéré, avec artefact + checksums).
- **Versionner** → le changelog reste la source de vérité ; `version.json` en est la projection
  machine générée au build.
- **Appliquer** → l'arbre complet en staging-swap. Le « fichier par fichier » est cantonné à la
  vérification d'intégrité (sha256 par fichier dans `version.json`), jamais au modèle d'apply.

## 5. Restructuration GitHub et installeur

Observation : le repo n'avait **aucun `.github/`**. Sans CI, rien ne garantissait qu'une release
existe ni qu'elle corresponde au dernier changelog. On a ajouté un pipeline `release.yml` qui
couple tag ↔ changelog ↔ artefact curé ↔ checksums, verrouillé par une garde de version.

Point technique corrigé en cours de route : contrairement à ce qu'on croyait initialement,
**GitHub honore `.gitattributes export-ignore`** pour ses archives source. On l'utilise donc pour
alléger le zipball fallback, tout en gardant l'artefact curé (allowlist) comme source préférée
(fail-safe : ce qui n'est pas listé est exclu).

Pour l'installeur : un seul `install.php`, dépôt codé en dur (aucune URL utilisateur), extraction
anti-zip-slip par entrée, credential PBKDF2 au format interopérable, auto-verrouillage après
installation, téléchargement par tranches avec reprise pour survivre aux `max_execution_time` des
hébergements mutualisés.

## 6. Revue adversariale pré-publication

Avant tout commit, une revue multi-agents (5 dimensions : sécurité de l'installeur, correction
du pivot, parité des trois résolveurs compat, isolation viewer, jumeaux PHP) avec vérification
adversariale de chaque trouvaille a été passée sur le diff complet. **Sept défauts réels** ont
été confirmés puis corrigés — dont trois notables qui n'auraient pas été trouvés par relecture
seule :

1. **Réconciliation trompeuse** (HIGH). Un rollback interrompu laissait `phase="applied"` ; comme
   le nouveau changelog était déjà vivant, la réconciliation prenait cet unique fichier pour une
   preuve d'application complète et « finalisait » un arbre à moitié restauré. Leçon : la version
   du changelog est *un fichier parmi tant d'autres* dans le swap — la preuve d'un swap complet
   doit être l'arbre entier (sha256 du manifeste), pas un fichier témoin. Fix + test de régression.
2. **Sonde `/api/health` sur `0.0.0.0`** (HIGH). Le mode documenté `--host 0.0.0.0` faisait
   *systématiquement* rollback : on ne peut pas se *connecter* à l'adresse d'écoute joker. Reproduit
   sur cette machine Windows (WinError 10049). Leçon : une adresse de *bind* n'est pas une adresse
   de *connect*.
3. **Divergence des jumeaux compat** (MEDIUM). Le résolveur PHP acceptait un `platformCompat` en
   forme d'objet (tableau associatif) que JS et Python rejettent — un fail-open que le vecteur de
   42 cas ne détectait que « par chance ». Fix + cas de régression où la valeur *matcherait*.

Cette passe justifie a posteriori l'investissement dans les tests exécutables (cœur du pivot,
vecteur de conformité tri-langage) : ils ont servi de socle pour prouver les correctifs.

## 7. Ce qui reste hors-scope (assumé)
- Le fallback PHP ne peut pas s'auto-redémarrer (`update_apply` → `unsupported`) — acceptable et
  documenté ; la compat + le préflight y sont néanmoins miroités.
- Sources de plugins tierces / signatures détachées / bac à sable d'exécution : conception prête,
  livraison différée (Phase 2), car elles exigent une CI org + hébergement + revue de sécurité
  dédiée. Tant qu'elles n'existent pas, seul le `js/modules/` curé est autorisé.
