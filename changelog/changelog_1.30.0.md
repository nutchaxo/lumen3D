# Changelog v1.30.0 (Plateforme Web)

> En résolution native, la lecture 4D avançait sur le temps mural pendant que le chargeur, lui, prenait ~600 ms par image. La tête avait déjà parcouru huit à onze images quand la première arrivait : on ne voyait jamais une frame terminée, et jamais deux frames consécutives.

## [FIXED]

* **La lecture est cadencée par le chargeur, plus par l'horloge.** La v1.27.4 avait sérialisé le *chargeur* mais laissé l'*horloge* libre : `timeline.js` avançait de `10 × dt/1000` image à chaque tick, sans jamais consulter l'état du chargement. Le nouveau `Timeline.setStalled()` fige la tête tant que l'image déjà demandée n'est pas à l'écran — l'horloge continue de tourner, elle n'accumule plus. `_loadTimepoint` l'arme et le relâche, ce qui couvre ses **quatre** appelants (lecture, sélecteur de qualité, restauration d'espace de travail, chargement initial) et pas seulement le chemin sérialisé.
  * **Délibérément sans compteur d'encours.** Un chargement peut légitimement ne jamais se terminer — mettre l'onglet en arrière-plan gèle `requestAnimationFrame` alors que le streamer de bricks attend un paint — et un compteur resterait alors au-dessus de zéro pour le reste de la session, porte silencieusement désactivée. Une panne invisible est pire que ce qu'elle prétend éviter. Relâcher à chaque fin ne peut, au pire, rouvrir l'horloge un peu tôt pendant le chevauchement rare de deux chargements ; le tick suivant la referme.
  * Deux garde-fous : un pas d'horloge est **borné à 250 ms** (un à-coup — chargement, GC, onglet masqué — ne se traduit plus par un saut de plusieurs images), et un blocage de plus de **15 s** est ignoré, pour qu'un chargeur coincé ne fige jamais le curseur définitivement.
* **On ne regarde plus le volume se remplir.** Lors d'un changement de timepoint, le cube de transition — ajouté par-dessus l'image courante et rempli brique par brique — est masqué : l'image précédente reste affichée en pleine qualité jusqu'à l'échange atomique de fin. C'est littéralement le « on voit les chunks se charger ». Le cube n'est pas supprimé pour autant : sur le chemin SVR son matériau est la cible d'upload des atlas. Un changement de qualité manuel le garde visible — là, la progression est le seul retour dont dispose l'opérateur.
* **Plus de sonde `/api/health` inutile.** Seule la découverte renseigne `_trustEpoch`, or `api/plugins.php` n'en émet pas : sur un hôte PHP il reste `null` à vie et **100 % des sondes sont mortes par construction**. Comme `api/health` n'a pas de jumeau PHP, chacune était en plus un 404 toutes les 8 secondes dans la console de l'opérateur, noyant les vraies erreurs pendant une lecture. La surveillance ne démarre plus quand l'hôte n'a vouché aucune époque ; la révocation continue de s'appliquer au rechargement suivant.

## [VERIFIED]

Sur le dataset 4D réel (30 timepoints, natif 922×1024×58), lecture mesurée dans le navigateur :

| Mesure | Avant | Après |
|---|---|---|
| Séquence affichée | `2 → 13 → 21 → 29 → 3` | **`2, 3, 4, 5, … 25`** |
| Saut maximum entre deux images affichées | 11 | **1** |
| Images consécutives | 0 / 40 | **53 / 54** |
| Rendu échantillonné pendant la lecture | 48 pas, pixelRatio 0,40 | **600 pas, pixelRatio plein — 100 % des échantillons** |
| Cube de transition visible | oui | **masqué, 160 / 160 échantillons** |

Non-régression : 17 plugins chargés, 0 en quarantaine, stabilisation 4D toujours active, 94 tests (seul subsiste l'échec d'isolation préexistant de `test_max_version_from_changelog`).

**Contrepartie assumée** : en natif la lecture tourne désormais à la vitesse réelle du chargeur, soit ~1,3 image/s tant que l'image n'est pas en cache, au lieu des 10 images/s nominales. C'est le comportement demandé — voir une image complète plutôt qu'un défilement d'images jamais terminées. Les qualités 256 et 512 sont inchangées : leurs 30 timepoints tiennent en cache, chaque image revient en 1 ms et la porte se rouvre aussitôt.

## [NOTE] — la pression VRAM, mesurée mais pas traitée ici

Ce qui rend les images natives coûteuses n'est pas corrigé par cette version : à 52,2 Mio par timepoint (922×1024×58 en R8 — le mot « RGBA » du journal d'allocation est une chaîne statique, l'arithmétique confirme R8) et pour un budget de 768 Mio, **14 timepoints sur 30 tiennent en mémoire**. C'est exactement la frontière entre « ça marche en 256/512 » (15,2 Mio, les 30 tiennent) et « ça rame en natif ». La moitié des images est donc re-streamée à chaque tour, à ~600 ms pièce.

Trois leviers ont été écartés de cette série, avec leur raison :
* **Relever le budget VRAM** — chaque entrée conserve aussi son miroir CPU de 54,7 Mo, jamais libéré : 30 timepoints natifs coûteraient ~1,5 Gio de VRAM **et** autant de tas JS. À mesurer avant, pas à décider maintenant.
* **Passer le natif en atlas creux** (23,4 Mio au lieu de 52) — `_shouldCacheVolumeEntry` refuse de mettre en cache une entrée SVR en qualité native : appliqué seul, le taux de succès du cache tomberait à **zéro**, chaque image coûtant 600 ms. Il faut lever ce blocage d'abord.
* **Réutiliser les bricks décodées entre visites** — le cache LRU tient 1024 bricks, soit ~9 timepoints natifs sur 30 : sur un balayage monotone, le taux de succès est nul. Utile pour un va-et-vient local, pas pour la lecture.
