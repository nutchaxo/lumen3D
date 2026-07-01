# Changelog v0.14.0 (Outil de Preprocessing)

## [ADDED]
* **Lanceur autonome auto-suffisant `run_preprocess.bat`** — un **unique fichier .bat** suffit désormais à exécuter tout le pipeline sur un poste **n'ayant jamais vu Python**. Tout est résolu **relativement au dossier du .bat**, aucun chemin absolu.
  * **Scripts embarqués (extraction par nom).** Les 5 scripts Python (`run_preprocess.py` + `1-`→`4-`) sont encodés en base64 dans le .bat. Au lancement, chaque script est vérifié **par son nom** : s'il est déjà présent à côté du .bat il est **conservé** (on peut donc exécuter une version modifiée) ; sinon il est **extrait** (décodage `certutil`, reconstruction bit-à-bit vérifiée par SHA-256).
  * **Provisionnement Python local.** Détection en cascade : runtime local `.runtime\python` → Python système (`py -3`/`python`/`python3`) → sinon **proposition d'installer un Python embarquable** téléchargé depuis python.org dans `.runtime\python` (extraction, activation des `site-packages`, amorçage de `pip` via `get-pip.py`). Isolé, sans droits admin, supprimable en effaçant le dossier.
  * **Dépendances automatiques.** Vérification par import (`numpy`, `Pillow`, `h5py`, `scipy`, `tqdm`) ; installation `pip` à la demande (dans le runtime local quand il est utilisé).
  * **Interface console claire et colorée.** En-têtes d'étapes `[n/5]`, marqueurs `[OK]` / `[*]` / `[X]` colorés (séquences ANSI via capture du caractère ESC), récapitulatif, messages explicites.
  * **Modes utilitaires :** `--check` (vérifie environnement puis quitte), `--extract [dossier]` (reconstruit les scripts), `--force-local` (ignore le Python système), `--help`.
* **Générateur `build_launcher.py` + template `launcher_template.bat.in`** — le .bat étant généré, on édite le template / les .py puis on relance `python build_launcher.py` (ré-embarque les scripts, réinjecte la version). Le .bat **ne doit pas** être édité à la main.

## [OPTIMIZED]
* **Sortie de l'orchestrateur `run_preprocess.py` épurée et colorée** — bannière compacte, en-tête par dataset `>> [i/N] <nom>`, lignes d'étape discrètes, `[OK]`/`[X]` colorés. Couleurs ANSI activées proprement sous Windows (`ENABLE_VIRTUAL_TERMINAL_PROCESSING`) et **désactivées automatiquement** si la sortie est redirigée (dégradation gracieuse en texte brut).

## [VERIFIED]
* Scénario « PC vierge » reproduit de bout en bout : à partir du **seul** `.bat`, extraction des 5 scripts (5/5 SHA-256 identiques aux sources), téléchargement + installation de **Python 3.12.8 embarquable**, amorçage de `pip`, installation de `numpy`/`Pillow`/`h5py`/`scipy`/`tqdm` dans le runtime local, puis exécution réelle de l'orchestrateur via ce Python local. `ProcessPoolExecutor` avec calcul `numpy` dans les workers (utilisé par les étapes 2 et 3) confirmé fonctionnel sous le Python embarquable. Rendu couleurs et marqueurs validés. Détection corrigée pour retenir `py -3` plutôt que `py`.
