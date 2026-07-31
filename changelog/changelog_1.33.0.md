# Changelog v1.33.0 (Plateforme Web)

> En natif, chaque image était rechargée : le cache gardait quatorze frames sur trente et les remplaçait dans l'ordre exact où on allait les redemander. Le taux de succès tombait à zéro, et le rendu restait donc en permanence dans son mode dégradé — c'est la « résolution low » qu'on voyait à la place du natif.

## [FIXED]

### Le cache évinçait précisément ce qu'on allait redemander

* **L'éviction n'est plus LRU.** Lire une série de 30 images dans un cache qui en contient 14 est le pire cas d'école du LRU sur un balayage cyclique : l'image réclamée est systématiquement celle qui vient d'être évincée, donc **~0 % de succès** et un re-streaming complet (~600 ms) à chaque frame. La victime est désormais choisie autrement : d'abord une autre qualité (la plus grosse d'abord), sinon, dans la qualité en cours de lecture, l'image dont la **distance cyclique en avant** de la tête de lecture est la plus grande — celle dont on aura besoin en dernier. On conserve ainsi une fenêtre contiguë devant la tête, c'est-à-dire un tampon.
* **Le budget se compte en octets, plus en nombre d'entrées.** L'ancienne limite dérivait **un** nombre d'entrées de la **plus grosse** entrée présente : une seule image native (52 MiB) faisait tomber le plafond à 14 pour *toutes* les qualités et balayait d'un coup les entrées 256 et 512, qui pèsent pourtant 3,6 et 14,5 MiB. C'est la raison pour laquelle **redescendre vers une résolution déjà chargée n'était jamais instantané** : la clé de cache distinguait bien les qualités depuis toujours, mais les entrées avaient été détruites entre-temps. Le plafond dur de 32 entrées disparaît également : il interdisait structurellement de tamponner une série de plus de 32 images, même en 256.

### Quatre fuites mémoire sur les chemins d'abandon

Un cache qui évince davantage rend ces fuites déterminantes ; elles sont bouchées par un helper unique `_disposeVolumeEntry`, appelé partout où une entrée est lâchée.

* `entry.occupancyMap` n'était libérée par **aucun** chemin : une texture GPU orpheline à chaque éviction.
* La branche de refus de mise en cache supprimait l'entrée précédente **sans rien libérer**.
* Les deux sorties d'abandon d'un streaming (annulé, ou sans aucune brick livrée) ne libéraient que le gestionnaire SVR, laissant la texture de volume — **52 MiB** sur la série de référence — et la carte d'occupation sur le GPU. Cette entrée n'atteignant jamais le cache, plus personne ne l'aurait libérée.
* **Un échec d'allocation fuyait la texture qu'il venait de refuser.** Three.js ne libère un `WebGLTexture` que sur `dispose()` ; la texture rejetée par ANGLE n'était pas encore dans le tableau, donc invisible du `catch`. Chaque échec rendait le suivant plus probable — une spirale.

## [ADDED]

* **Barre de tampon segmentée, et honnête.** Les images chargées ne forment pas un préfixe : une série se remplit **autour** de la tête de lecture et perd des images à l'éviction. La barre dessine donc des segments, peints depuis le **contenu réel du cache** et non depuis un compteur d'images « déjà visitées » — lequel n'était jamais remis à zéro et ne pouvait que croître, affichant un tampon plein alors que la moitié de la série avait été évincée. Elle **se vide et se repeint au changement de qualité**, et montre immédiatement ce qui reste si l'on redescend vers une résolution déjà chargée.
* **Ligne d'état du tampon** (`Tampon 18/30 · 512×512`), dans son propre élément : la ligne de statut qualité est réécrite à chaque chargement d'image, donc plusieurs fois par seconde en lecture, et l'y placer l'aurait effacée en permanence. Quand la série entière ne tient pas en mémoire, elle le dit et donne la capacité réelle.

## [NOTE] — ce qui est mesuré, et ce qui ne l'est pas encore

**Le réseau n'a jamais été le problème** : la série complète pèse **5,2 Mio en natif** (177 Kio par image, un pack chacun), 3,0 Mio en 512, 1,1 Mio en 256. Tout le coût est le décodage des ~112 bricks WebP et surtout la mémoire : une image native décodée occupe 52 MiB, soit **300 fois** sa taille compressée.

Conséquence directe, chiffrée sur le budget de 768 Mio : en **256 et 512, les 30 images tiennent** (109 Mio et 435 Mio) — une fois la série parcourue, la lecture coûte ~1 ms par image. En **natif il en tient 14 sur 30** (1,53 Gio seraient nécessaires). Le budget n'a **délibérément pas été relevé** : chaque entrée conserve à la fois la texture GPU et son miroir CPU — le **même tampon compté deux fois** — donc porter le budget à 1,7 Gio en coûterait ~3,4 en pratique. Libérer le miroir CPU est le préalable, et il est lu par la sonde d'intensité et l'amorçage des textures : ce sera un changement à part.

**Ce qui n'est pas encore là** : le préchargement de fond, c'est-à-dire remplir le tampon **sans afficher** les images. En l'état, une image n'entre dans le tampon que lorsqu'elle est affichée au moins une fois. Passer de 256 à 512 demande donc encore de parcourir la série une fois. Ce chantier est identifié et cadré, mais il exige des garde-fous qu'il serait imprudent de livrer sans les avoir exercés : quatre appelants court-circuitent la sérialisation du chargeur, et un préchargement démarré pendant un chargement d'affichage **met en cache un volume à moitié rempli**, sous la bonne clé, affiché comme valide.

**Limite de vérification** : la barre segmentée, la ligne d'état et l'API de tampon ont été exercées dans le navigateur (segments non contigus `{0-2, 10-11, 29}` rendus aux bonnes positions, compatibilité de l'ancien appel numérique, remise à zéro). La politique d'éviction, elle, n'a **pas** pu être exercée sur des volumes réels : le volet de prévisualisation de l'environnement de développement est masqué, ce qui gèle `requestAnimationFrame`, or le streamer de bricks attend un paint — aucun volume ne finit de charger. Le raisonnement est chiffré et les garde-fous sont doubles (l'entrée affichée est protégée par sa clé **et** par son identité), mais un contrôle après déploiement reste nécessaire.
