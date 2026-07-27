# Changelog v1.27.4 (Plateforme Web)

> En pleine qualité, la lecture demandait des frames plus vite que le chargeur ne peut en produire, si bien que chaque frame annulait la précédente et qu'aucune n'aboutissait.

## [FIXED]
* **La lecture suit désormais le rythme du chargeur.** Elle réclame une frame toutes les ~100 ms, alors qu'en 512×512 une frame coûte ~160 ms à récupérer, décoder et téléverser. Chaque demande annulait donc le chargement encore en vol : la console se remplissait d'`AbortError` et le défilement saccadait sans jamais montrer une frame complète. Les demandes sont maintenant sérialisées, en ne conservant que **la plus récente** pendant qu'un chargement tourne — la lecture est plus lente que la vitesse demandée mais affiche réellement les images, et les frames intermédiaires sont abandonnées plutôt que mises en file, donc elle ne prend jamais de retard sur le curseur.
* **Un chargement annulé n'est plus traité comme une erreur.** Quitter une frame pendant son décodage est le comportement NORMAL d'un défilement : l'`AbortError` est désormais propagé pour que la tâche soit abandonnée, au lieu de journaliser une erreur puis de payer un décodage sur le thread principal pour une brick que plus personne n'attend.

## [NOTE] — ce qui reste, et pourquoi ce n'est pas dans cette version
Le journal de production montre la cause de fond : **chaque timepoint alloue une texture de 58 Mio** (`RGBA volume allocated`). Avec le budget VRAM de 768 Mo, seuls ~12 des 30 timepoints tiennent en 512×512 — d'où des revisites à 162 ms alors qu'une frame encore résidente revient en **1 ms**.

Or ce dataset n'a **qu'un seul canal** et la texture est allouée en RGBA8 : les trois quarts de ces 58 Mio sont du remplissage. Passer les datasets mono-canal en R8 diviserait par quatre la VRAM *et* le volume téléversé par frame, ce qui ferait tenir les 30 timepoints.

Ce changement n'est pas livré ici parce que la constante de pas RGBA est utilisée dans une vingtaine d'endroits du chemin d'échantillonnage (écriture des bricks, histogrammes, extraction de coupes, atlas creux), et qu'il ne peut pas être validé sans voir le rendu. Il sera fait avec une vérification visuelle.
