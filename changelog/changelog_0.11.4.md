# Outil de Preprocessing v0.11.4 — 2026-06-08

## [OPTIMIZED] Packing par 128 briques
- **Changement** : Augmentation de la constante `CHUNKS_PER_PACK` de 64 à 128 dans `3-chunk_packer.py`.
- **Bénéfice** : Division par 2 du nombre total de fichiers packs physiques `.bin` sur le disque et du nombre de requêtes HTTP initiées par le visualiseur Web.
- **Performance** : Les fichiers packs compressés conservent une taille très modérée (entre 2 et 10 Mo par fichier), permettant un téléchargement ultra-rapide tout en optimisant considérablement l'arborescence de fichiers et le temps de copie.
