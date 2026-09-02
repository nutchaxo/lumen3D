# Changelog v0.17.0 (Outil de Preprocessing)

## [ADDED]
* **`wholemount_importer.py` — une photographie, un dataset.** Nouvel outil autonome (il ne passe pas par `run_preprocess.py`, qui reste dédié aux volumes `.ims`). Il lit les TIFF tels qu'ImageJ/Fiji les exporte depuis un `.lif` Leica — un composite de trois plans 8 bits avec LUT Rouge/Vert/Bleu, c'est-à-dire la photo couleur du stéréomicroscope — mais accepte aussi un TIFF RGB simple ou un plan gris. Pour chaque fichier il écrit `DATA_WEB/wholemount/<nom>/` :
  * `image.webp` — résolution native, qualité 90 (≈ 100 à 400 Ko pour 1920 × 1440) ;
  * `preview.webp` — grand côté 640 px, qualité 80 (≈ 6 à 15 Ko), ce que la page peint en premier ;
  * `thumbnail.webp` — carré 512 px, la convention du catalogue ;
  * `metadata.json` — type `wholemount`, `dimensions {x, y, z: 1, c: 3, t: 1}`, `image {native, preview, width, height, …}`, `pixelSizeUm`, `physicalSizeUm`, `acquisition {microscope, camera, zoom, magnification, objective, numericalAperture, exposureMs, gain, dissectionDate, lifFile, series}`, `stage`, `line`, `staining`, `date` ;
  * `download/` (`--with-downloads`) — le TIFF d'origine (lien dur, copie sinon) et un `README.txt` de provenance.

  ```bash
  python wholemount_importer.py --input <dossier ou fichier.tif> --output DATA_WEB --staining X-gal --with-downloads [--line DLL4xCD1] [--only "*E8.0*"] [--force]
  ```

* **Rien n'est deviné.** La taille de pixel vient des tags de résolution TIFF (uniquement si l'unité déclarée est le micron, sinon `calibrationStatus: unknown` et la page n'affiche ni barre d'échelle ni mesures). Les réglages d'acquisition viennent du bloc Leica embarqué par ImageJ, filtré sur la série exacte (`<série> Image|…`, ce qui évite qu'une série `240913` capte les lignes de `240913 2`) et débarrassé des `0` que LAS X écrit pour un réglage non applicable. Le stade, le zoom nominal, la date de dissection et l'index de prise sont lus dans le nom de fichier tel que le labo le compose (`<lif> - E8.0 x3.2 241008 2.tif`) ; la lignée est le premier jeton en forme de croisement (`DLL4xCD1`), remplaçable par `--line`.

* **Le repassage préserve la curation.** Avec `--force`, un `metadata.json` existant est fusionné : les mesures sont rafraîchies, les clés éditées par le labo (`name`, `description`, `stage`, `line`, `staining`, `hidden`, `gallery`, `tags`, `notes`, …) sont conservées. C'est le comportement que le pipeline volumes n'a pas encore (cf. le point *[KNOWN]* de la 0.16.3).

* **Emballé dans le pack pipeline et le lanceur.** `tools/build_pipeline_bundle.py` et `preprocess/build_launcher.py` embarquent le nouvel importeur ; le LISEZ-MOI du pack documente l'appel.
