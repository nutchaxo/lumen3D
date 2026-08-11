# Changelog v0.16.2 (Outil de Preprocessing)

## [FIXED]
* **L'élimination des briques vides comptait du bruit de quantification comme du signal.** `Egfl7eGFP-Em3-Decidua-7hCulture-TS11c` déclarait **7200 briques non vides sur 7200** à tous les niveaux — l'empty-space skipping n'éliminait strictement rien, à comparer aux 20 à 29 % d'occupation d'un dataset sain du même catalogue. Conséquence directe pour l'opérateur : 28 776 briques-canaux à télécharger au LOD0 contre 9 000 à 15 000 pour un volume comparable, un chargement en résolution native qui n'aboutissait pas en cinq minutes, et une pression inutile sur le plafond de 8192 emplacements d'atlas du viewer.

  **L'origine n'est pas la soustraction de fond.** Le window leveling de `2-image_processor.py` ramène `[bg_floor, sig_max]` sur `[0, 255]` : un voxel situé un pas au-dessus du plancher de bruit atterrit donc sur 1. Un fond dont le bruit chevauche `bg_floor` laisse toujours un semis de 1 — c'est de l'arithmétique, pas un défaut d'estimation, et tous les datasets en portent. Le défaut est que `process_chunk` testait `np.count_nonzero`, ce qui compte ces 1 comme du contenu.

  Mesuré sur les briques publiées de Decidua : les huit briques de coin sont à 96,9 %, 98,5 % et 98,9 % de voxels nuls avec un 99ᵉ centile égal à 1 — et toutes étaient conservées, parce que 3 % de voxels non nuls dépasse largement le seuil de 0,05 %. Le viewer, lui, ne les affiche jamais : `volume-viewer.js:_floorsFromManifest` calcule un plancher d'affichage par canal et le borne à `[6, 48]`, borne basse atteinte dès que le manifeste ne porte pas de `backgroundFloor` explicite — ce qui est le cas de tous les datasets publiés à ce jour. Tout ce qui est sous 6 est écrasé par la LUT avant même le ray marcher. Ces briques étaient donc téléchargées, décodées et logées dans un emplacement d'atlas pour zéro pixel.

  **Le test est maintenant l'intersection** de la tolérance historique (`occ > 0,05 %` sur les voxels non nuls, inchangée) et d'une vérification de visibilité : la brique doit contenir au moins un voxel strictement au-dessus de `DISPLAY_FLOOR = 5`. Une intersection, donc le nouveau test ne peut que conserver un sous-ensemble de ce qu'il conservait — aucun dataset ne peut grossir — et tout ce qu'il élimine en plus est **prouvablement invisible** : zéro voxel au niveau du plancher d'affichage ou au-dessus. Les voxels stockés ne sont pas touchés, seul l'index change.

  Règle d'abord rejouée hors ligne sur la totalité des briques déjà publiées d'un niveau, pour borner le risque : Decidua LOD2 serait passé de 1836 briques conservées à 1434 (−21,9 %), et le témoin sain `Egfl7eGFP-E75-Em10` LOD2 de 932 à 930 (−0,2 %) — la correction porte sur le dataset pathologique et laisse les autres intacts.

  **Mesuré ensuite sur un vrai repassage de Decidua dans le pipeline**, le gain est plus large que ne le laissait voir la simulation :

  | LOD | grille | briques non vides avant → après | gain |
  |---|---|---|---|
  | 0 | 3789 × 3789 × 125 | 7200 → 3800 | −47,2 % |
  | 1 | 2048 × 2048 × 125 | 2048 → 1251 | −38,9 % |
  | 2 | 1024 × 1024 × 125 | 512 → 321 | −37,3 % |
  | 3 | 512 × 512 × 125 | 128 → 90 | −29,7 % |
  | 4 | 256 × 256 × 125 | 32 → 27 | −15,6 % |

  Entrées `brickToPack` : 39 303 → 18 039 (**−54,1 %**). Empreinte disque du dossier `bricks/` : 2,0 Go → 988 Mo. Rendu vérifié en navigateur après repassage : couverture d'image 22,77 % contre 23,2 % avant — la silhouette est la même, rien n'a disparu.

  À noter pour qui compare les deux versions à l'œil : le repassage rejoue **tout** le pipeline dans sa version courante, alors que les briques publiées dataient de juin et d'une version antérieure. L'équilibre des couleurs change donc un peu (le mélange par canal se rééquilibre), ce qui ne vient pas de ce correctif — le test d'occupation ne touche aucun voxel, il ne décide que de l'indexation.

  **Ce qui n'a délibérément pas été fait.** Abandonner le ratio pour ne garder que « au moins un voxel affichable » retirerait 291 briques supplémentaires à Decidua LOD2, mais chacune contient jusqu'à 131 voxels que le viewer afficherait réellement. Écarter du signal mesuré pour économiser de la bande passante n'est pas une décision que ce script prend en silence (règle 1.1) ; les deux constantes sont exposées en tête de module pour que l'opérateur puisse trancher en connaissance de cause.

  Le correctif ne s'applique qu'aux datasets **repassés dans le pipeline** : il change ce que `3-chunk_packer.py` écrit dans `manifest.json`, pas les manifestes déjà publiés.

  À noter, hors périmètre de ce correctif : `Egfl7eGFP-Em1-E95` et `Egfl7eGFP-Em2-E9` affichent 76 % et 82 % de briques occupées au LOD0 là où `Egfl7eGFP-E95-1` — même capteur 5735², même nombre de canaux — en occupe 20 %. Le décodage de leurs briques montre du signal réel largement étalé, pas un plancher résiduel : leur densité paraît authentique, conséquence de la déconvolution. C'est ce qui les fait dépasser le plafond de 8192 emplacements et rétrograder en 2048 quand on demande la native.
