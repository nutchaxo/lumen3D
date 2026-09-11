# Changelog v0.18.0 (Outil de Preprocessing)

## [ADDED]
* **Nouveau vocabulaire des types de données : `3d`, `2d`, `live`, `tracking`.** Les mots `fixed` et `wholemount` disparaissent : un volume à un seul point temporel est désormais un dataset **`3d`**, une photographie est un dataset **`2d`**. Le mot est simultanément le dossier sous `DATA_WEB/`, le premier segment de l'identifiant et la valeur de `"type"` dans `metadata.json` — une seule chaîne, plus aucune traduction entre « dossier de stockage » et « type ». Aucun alias, aucune double lecture : la plateforme ne lit plus que cette forme.
  * `run_preprocess.py` écrit dans `<output>/3d/<nom>/` (ou `<output>/live/<nom>/` pour un timelapse) au lieu de `<output>/fixed/<nom>/`, et affiche le type résolu dans le récapitulatif de chaque dataset.
  * `4-catalog_generator.py` dérive le type du dossier parent — qui *est* le type — et écrit `"type": "3d"|"live"` et `"id": "<type>/<nom>"`. Rien d'autre n'est persisté : l'emplacement des octets se relit toujours du dossier, jamais d'un champ qui pourrait devenir faux après un renommage.
  * `3-chunk_packer.py` aligne le `"datasetType"` de `bricks/manifest.json` sur `"3d"`/`"live"`.

* **`wholemount_importer.py` devient `2d_importer.py`.** Même outil, même contrat d'entrée (TIFF ImageJ/Leica), même préservation de la curation sur `--force`. Il écrit maintenant `DATA_WEB/2d/<nom>/` avec `"type": "2d"`, et son identifiant devient `"2d/<nom>"` — il écrivait jusqu'ici un `id` **nu** (le seul nom de dossier), incohérent avec ce que produisait le pipeline volumes. Les libellés opérateur (`[2d] …`, `Type : 2D photograph` dans le `README.txt` de `download/`) suivent.

  ```bash
  python 2d_importer.py --input <dossier ou fichier.tif> --output DATA_WEB --staining X-gal --with-downloads [--line DLL4xCD1] [--only "*E8.0*"] [--force]
  ```

  Un repassage `--force` sur une photographie importée avant cette version **corrige son type et son identifiant** : `type` et `id` ne font pas partie des clés curatoriales préservées.

## [FIXED]
* **Le pack pipeline embarquait deux fois le bloc d'import des photographies.** Dans `tools/pipeline_bundle/RUN.bat.in`, l'étiquette `:run_wholemount` et ses cinquante lignes étaient présentes **à l'identique deux fois** ; `cmd.exe` n'exécute que la première, la seconde était du code mort que toute réécriture automatique aurait dupliqué une fois de plus. Le doublon est supprimé et le bloc survivant renommé `:run_2d`.

## [OPTIMIZED]
* **Le lanceur autonome et le pack pipeline sont régénérés.** `run_preprocess.bat` ré-embarque les sept scripts (dont `2d_importer.py` à l'index 5) — sans régénération, l'opérateur aurait reçu un lanceur écrivant silencieusement l'ancien vocabulaire, puisque les scripts y sont encodés en base64. `tools/build_pipeline_bundle.py`, `tools/build_release.py` et `tools/build_download_bundles.py` suivent le renommage des fichiers (`2d.html`, `css/2d.css`, `js/pages/2d.js`, `js/viewers/2d-viewer.js`, `preprocess/2d_importer.py`) et la nouvelle liste de types.

## [KNOWN]
* **Les datasets déjà publiés ne sont pas réécrits par le pipeline.** Le labo ne va pas repasser des volumes de plusieurs heures pour changer une chaîne de caractères : la migration du déploiement existant (`DATA_WEB/fixed` → `DATA_WEB/3d`, `DATA_WEB/wholemount` → `DATA_WEB/2d`, réécriture des `metadata.json`) est faite une seule fois, côté serveur, au démarrage de la plateforme.
