# Changelog v1.27.1 (Plateforme Web)

> Le défilement d'un timelapse re-téléchargeait ~30× plus d'octets de manifeste que de données d'image, et relançait la lecture en cours à chaque frame d'animation.

## [FIXED]
* **Le manifeste de bricks n'est plus re-téléchargé à chaque timepoint.** Un manifeste 4D indexe *tous* les timepoints dans un seul document — **3,4 Mo** pour la série de référence — et il était récupéré à chaque changement de frame avec `cache:'no-cache'` **et** un `?t=Date.now()` interdisant toute mise en cache. Parcourir les 30 timepoints tirait donc **~90 Mo de manifeste pour livrer 3,8 Mo de bricks** : 96 % des octets transférés n'étaient pas des données. Il ne peut pas changer pendant que la page est ouverte : il est désormais récupéré **une fois par dataset**, la promesse en vol étant partagée pour que deux changements simultanés ne lancent jamais deux téléchargements.
* **La lecture ne relance plus le chargeur 60 fois par seconde.** `timeline.js` déclenche son `onChange` à *chaque* frame d'animation, alors que l'indice de frame ne change que quelques fois par seconde. Sans dédoublonnage, chaque tick ré-entrait dans `_loadTimepoint`, incrémentait `_activeLoadToken` et **annulait le chargement encore en vol** — en lecture, un timepoint pouvait ne jamais finir de charger. Le rechargement n'a plus lieu que sur changement de frame entière.
* **Changer de timepoint n'est plus traité comme un changement de dataset** (`BrickLoader.init`). Chaque pas de défilement vidait le cache de bricks décodées, vidait le cache de packs, annulait les fetchs en vol et **terminait puis recréait les 8 workers de décodage** — avec une URL cache-bustée, donc le script du worker était re-téléchargé à chaque fois. Or les deux caches sont **déjà uniques par timepoint** (`_cacheKey` préfixe avec le chemin de montage, qui porte le `/tNNN` ; les clés de packs sont des URLs qui le portent aussi), donc rien ne pouvait entrer en collision entre frames : tout ce travail était jeté sans raison. Une brick arrivée après un changement de frame est maintenant **mise en cache mais jamais livrée** à la frame courante — la garder est sûr (sa clé appartient à l'ancien montage), la livrer téléverserait les pixels d'une autre frame dans l'atlas.

## [OPTIMIZED]
* **La limite du cache GPU s'adapte au coût réel d'un timepoint** au lieu d'un `4` en dur écrit pour des datasets à volume unique — sur une série de 30 frames, il provoquait une éviction et un re-téléversement à presque chaque pas. Elle se calcule maintenant à partir d'un budget VRAM (768 Mo) et de l'empreinte d'une entrée : **~12 timepoints résidents en 512×512, la série entière en 256×256**.
* **LRU de bricks décodées portée de 200 à 1024** (~268 Mo de tas, et seulement si autant de bricks distinctes sont réellement visitées). 200 bricks représentaient moins de trois timepoints de la série de référence, donc le défilement re-décodait en permanence.
* Le temps de chargement d'un timepoint est journalisé en console (`ms`, première visite / revisite, nombre de frames résidentes) pour que le coût d'un pas se lise directement au lieu de se déduire.

## [VERIFIED]
Contre le dataset réel, dans le navigateur :

| Mesure | Résultat |
|---|---|
| Parcours de 10 timepoints, à froid | 1 874 ms (187 ms/frame) |
| Re-parcours des mêmes 10 timepoints | **7 ms**, soit 0,7 ms/frame |
| Téléchargements du script des workers sur 20 montages | **0** (auparavant 8 par changement) |
| Requêtes de manifeste | **1** au total |
| Octets transférés pour 10 frames | **1,25 Mo** (auparavant ~34 Mo) |
| Contamination entre frames | aucune — empreintes de contenu distinctes entre t000 et t015, et revisite identique à l'octet près |

Non mesuré : le coût GPU par frame (allocation de texture + téléversement de l'atlas), le volet Navigateur masqué empêchant toujours le rendu de s'exécuter — voir `changelog_1.26.0.md`.
