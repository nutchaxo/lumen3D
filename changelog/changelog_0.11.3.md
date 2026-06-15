# Outil de Preprocessing v0.11.3 — 2026-06-08

## [ADDED] Nouveau pipeline structuré et robuste
- **1-ims_metadata.py** : Extracteur propre des métadonnées HDF5 depuis les fichiers Imaris `.ims` (dimensions, taille physique de voxel, calibration, canaux).
- **2-image_processor.py** : Normalisation uint8 par estimation de percentile globale, réduction de bruit gaussienne à 3σ, et downscaling d'image itératif (jusqu'à une taille <= 256 pixels) en préservant toutes les coupes Z intactes.
- **3-chunk_packer.py** : Partitionnement spatial en chunks de 64x64x64, filtrage par taux d'occupation (>0.0005) et empaquetage dans des fichiers `pack_XX.bin` avec compression Gzip indépendante par chunk.
- **4-catalog_generator.py** : Injection des histogrammes de canaux (calculés sur l'échelle de résolution la plus basse) dans le manifest local et génération de `metadata.json` pour le dataset.
- **run_preprocess.py** : Orchestrateur global de la chaîne de traitement qui génère également une miniature composite MIP en fausses couleurs.

## [OPTIMIZED] Nettoyage du code
- **Suppression des fichiers obsolètes** : Suppression de 18 scripts de preprocessing expérimentaux, temporaires et redondants pour nettoyer le répertoire `preprocess/` et ne garder que la chaîne de production propre.
