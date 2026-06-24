# Changelog v0.13.1 (Outil de Preprocessing)

## [ADDED]
* **Lanceur interactif `run_preprocess.bat`** — double-clic (ou exécution en console) pour piloter le pipeline sans retenir la ligne de commande Python. Le script :
  * **demande les informations nécessaires** : dossier d'entrée contenant les `.ims` (validé : doit exister, comptage des `.ims` affiché), dossier de sortie `DATA_WEB` (avec valeur par défaut), et un filtre glob optionnel (ex. `*E8*`) ;
  * **affiche un récapitulatif** puis demande confirmation avant de lancer le traitement ;
  * **exécute `run_preprocess.py`** en relayant proprement sa progression en temps réel (`PYTHONUNBUFFERED=1`, `PYTHONIOENCODING=utf-8`, `chcp 65001`).

## [OPTIMIZED]
* **Résilience aux environnements Python** — le `.bat` détecte automatiquement un interpréteur Python 3 en testant successivement `py -3`, `python`, `python3`, `py` (chaque candidat est validé via `sys.version_info[0]==3`), puis vérifie la présence des dépendances (`numpy`, `Pillow`, `h5py`, `scipy`, `tqdm`) et propose leur installation `pip` si elles manquent.
* **Aucun chemin absolu** — tout est résolu relativement à l'emplacement du script (`%~dp0`) : `run_preprocess.py` à côté du `.bat`, et le dossier de sortie par défaut pointe sur `..\DATA_WEB` (normalisé). Le script est donc portable d'une machine à l'autre sans édition.

## [NOTE]
* Robustesse batch : le retrait des guillemets d'un chemin collé (`set VAR=!VAR:"=!`) n'est appliqué qu'une fois la variable **définie** — sur une variable vide, l'expression renverrait littéralement `"=` et fausserait la validation. Les saisies vides sont donc interceptées avant ce traitement.
