# Changelog v0.14.1 (Outil de Preprocessing)

## [ADDED]
* **Génération du dossier `download/` intégrée au pipeline (optionnelle).** Une **option est demandée avant le lancement** (« Generer aussi les fichiers download/ (archive, OME-TIFF, MIP) ? [o/N] », défaut **non** car l'étape est lourde — elle relit le `.ims`). Si acceptée, après chaque dataset (juste après l'étape 4, quand `metadata.json` existe), le pipeline construit son `download/` : archive web `_web.zip`, `.ims` original (lien dur), OME-TIFF µm-calibré, MIP par canal, `README.txt`.
  * `run_preprocess.py` : nouveau drapeau **`--with-downloads`** ; appelle `build_download_bundles.py` par dataset (`--data-web <sortie> --raw-dir <dossier des .ims> --datasets <nom>`). L'outil est lancé via le même mécanisme interruptible (groupe de processus dédié, Ctrl+C géré).
  * `run_preprocess.bat` : option dans le récapitulatif, ligne « Download/ : oui/non », **installation automatique de `tifffile`** (dépendance de l'OME-TIFF) uniquement si l'option est choisie, et passage de `--with-downloads`.
  * **`build_download_bundles.py` embarqué dans le `.bat`** (6ᵉ script) : conservé depuis `tools/` dans le dépôt, **extrait** à côté des autres sur un poste vierge. L'orchestrateur le résout dans `tools/` (dépôt) ou à côté de lui-même (extrait).

## [OPTIMIZED]
* **`build_download_bundles.py` portable et pilotable :** nouveaux arguments **`--data-web`** (cible DATA_WEB) et **`--raw-dir`** (dossier des `.ims` source, prioritaire) — plus de dépendance au chemin RAW_DATA absolu quand le pipeline le pilote. Lecture du `metadata.json` par dataset (tolérante au BOM via `utf-8-sig`) comme source faisant autorité pour les canaux/voxels, donc correct même lancé juste après la construction d'un dataset, avant l'agrégation de `catalog.json`.
* **`run_step` factorisé en `run_script`** (lancement interruptible en groupe de processus dédié) réutilisé tel quel pour l'outil de download.

## [VERIFIED]
* Embarquement/extraction : le `.bat` génère 6 scripts ; `--extract` reconstruit les 6 **SHA-256 identiques** aux sources ; en dépôt l'outil download est conservé depuis `tools/` (pas de doublon), sur un `.bat` seul il est extrait à côté. `build_download_bundles.py` produit l'archive web + README (canaux lus depuis `metadata.json`) et saute proprement `.ims`/TIFF/MIP en l'absence de source. Option download (o/n/défaut), récapitulatif et passage de `--with-downloads` validés.
