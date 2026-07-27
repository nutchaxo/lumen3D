# Changelog v1.27.3 (Plateforme Web)

> Un dataset 4D en bricks émettait des centaines de requêtes vouées à l'échec par timepoint.

## [FIXED]
* **Le préchargement des timepoints voisins tirait des slices qui n'existent pas.** `_scheduleAdjacentPreload` appelle `VolumeViewer.preloadVolume`, or celui-ci ne construit **que** des URLs de pile de slices (`preview/slices/tNNN_zNNN_c0.webp`). Un dataset diffusé en bricks n'a pas de pile de slices : chaque changement de timepoint déclenchait donc **des centaines de 404**, qui monopolisaient le budget de connexions du navigateur pour rien et, sur un hébergement mutualisé, invitaient exactement les rafales de HTTP 429 que le `.htaccess` du projet documente déjà. Le préchargement était en outre totalement inopérant — il ne mettait rien en cache.

## [OPTIMIZED]
* **Vrai préchargement des packs voisins** (`BrickLoader.prefetchPacks`). Le loader ne monte qu'un timepoint à la fois, donc précharger un voisin ne peut pas passer par `loadBricks()` sans entrer en concurrence avec la frame visible. La nouvelle fonction se contente de chauffer les **fichiers de packs** dans `_packCache` — clés absolues, donc ils survivent au montage suivant. Le changement de frame ne coûte alors plus qu'un décodage, sans aller-retour réseau. Les packs pèsent 45 à 125 Ko par timepoint ici, ce qui est précisément ce qui rend l'opération intéressante.
* Le compteur de la ligne de journal disait « resident » alors qu'il compte les timepoints **visités**, pas ceux encore résidents en VRAM — corrigé en « visited so far », le nombre servant à juger la résidence.

## [VERIFIED]
Contre le dataset réel, dans le navigateur :

| Mesure | Résultat |
|---|---|
| Requêtes de slices sur un dataset en bricks | **0** (auparavant des centaines par timepoint) |
| Packs chauffés par le préchargement pendant qu'un autre timepoint est monté | 1 pack, 1 requête |
| Passage vers le timepoint préchargé | **37 bricks en 37 ms** |
| Requêtes réseau supplémentaires pendant ce passage | **0** |

À comparer aux ~187 ms d'une première visite sans préchargement (v1.27.1).
