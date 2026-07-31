# Changelog v1.34.0 (Plateforme Web)

> Le tampon se remplit maintenant tout seul, sans afficher les images. Changer de résolution vide la barre et la recharge en tâche de fond ; redescendre vers une résolution déjà chargée reprend ce qui restait.

## [ADDED]

* **Préchargement de fond.** Une image n'a plus besoin d'être affichée pour entrer dans le tampon. Le planificateur part de la tête de lecture, avance dans la série, saute ce qui est déjà résident, et **s'arrête net quand la fenêtre autorisée est pleine** — il ne tourne pas en rond à évincer son propre travail. Mesuré sur la série de référence : **30/30 images en 512 sans jouer une seule frame**, puis 30/30 en 256 en une vingtaine de secondes.
* **Un mode `preload` dans le chargeur de volumes**, qui ne touche à aucun état affiché : ni le cube de transition, ni l'amorçage des textures, ni `_svrManager`, ni la cible de qualité (qui pilote aussi le rendu dégradé), ni l'état de progression — `_qualityState` est un singleton fusionné et l'overlay se montre sur une expression du message, donc émettre depuis le fond l'aurait fait clignoter à chaque image préchargée.

## [FIXED]

* **Un préchargement ne peut plus corrompre l'image affichée.** C'était le risque central, et il est réel : `BrickLoader` est un singleton mono-montage dont `init()` appelle `cancelPending()` sans condition, ce qui annule les requêtes du chargement d'affichage en cours. Celui-ci se serait alors terminé **normalement** — `Promise.allSettled` avale l'annulation, son drapeau d'abandon reste faux et son identifiant reste courant — et aurait **mis en cache puis affiché un volume à moitié rempli**, sous la bonne clé. Panne silencieuse, durable, visuellement plausible.
  Le verrou est posé **dans le chargeur**, pas dans la page : le verrou applicatif est déjà contourné par quatre appelants (chargement initial, sélecteur de qualité, restauration d'espace de travail) et le serait par tout appelant futur. Un préchargement refuse simplement de démarrer tant qu'un chargement d'affichage est en vol.
* **Le premier plan préempte le fond gratuitement.** Un préchargement **lit** le compteur de chargement sans l'incrémenter : à la seconde où un chargement d'affichage démarre et l'incrémente, tous les gardes `loadId !== _loadCounter` déjà en place abandonnent le préchargement. L'asymétrie est structurelle, pas conventionnelle.
* **Annuler un préchargement l'annule vraiment.** Poser un drapeau ne suffisait pas : `loadBrickTasks` n'avait aucun point d'abandon hors son propre contrôleur, donc un changement de qualité laissait le lot télécharger et décoder **toutes** les bricks restantes avant de jeter le résultat. Le chargeur accepte désormais un `shouldAbort` coopératif, testé à chaque brick et à chaque tentative — et surtout pas `cancelPending()`, qui est global et tuerait un chargement d'affichage concurrent.
* **Le cache ne peut plus être empoisonné par un LOD dégradé.** La clé de cache ne porte pas le niveau de détail : sous pression mémoire, un préchargement qui retombe sur un LOD inférieur aurait stocké un volume basse résolution étiqueté `native`, peint comme chargé dans la barre, et sa revisite aurait ouvert la modale de rétrogradation et réécrit la qualité de la session — **depuis une tâche de fond que l'utilisateur n'a pas demandée**. Une entrée dont le LOD diffère de celui demandé est désormais refusée et libérée.

## [NOTE] — ce que le préchargement refuse de faire, et pourquoi

* **Jamais dans un panneau de comparaison.** `compare.html` monte jusqu'à quatre iframes, chacune un document complet avec son propre budget mémoire et son contexte WebGL : quatre préchargements simultanés de la même série quadrupleraient l'un et l'autre.
* **Jamais sur le chemin d'atlas creux (SVR).** Il s'approprierait l'atlas du volume affiché, et la politique de cache jetterait l'entrée aussitôt payée en qualité native.
* **Jamais onglet masqué.** `requestAnimationFrame` y est gelé alors que le streamer attend un paint : un préchargement pris là ne se terminerait jamais. Il est abandonné à la sortie et relancé au retour.
* **Jamais sur un dataset non-4D ou non-brické** : il n'y a rien à tamponner, et le chemin par coupes n'a aucun moyen de charger sans afficher.

Le budget mémoire reste **inchangé à 768 Mio** : chaque entrée conserve la texture GPU **et** son miroir CPU — le même tampon compté deux fois. En 256 et 512 la série entière tient (30/30) ; en natif il en tient **14 sur 30**, et la ligne d'état le dit avec la capacité réelle plutôt que d'afficher une barre pleine mensongère.

## [VERIFIED]

Bout en bout dans le navigateur, sur la série réelle (30 timepoints) :

| Scénario | Résultat |
|---|---|
| Ouverture en 512, **sans jouer** | tampon **30/30**, un seul segment continu |
| Bascule en natif | remplissage progressif 9 → **14/30** puis **arrêt au plafond**, contigu depuis la tête |
| Pendant ce temps, entrées 512 | **20 survivantes** — l'éviction ne prend que la place nécessaire |
| Bascule en 256 | **30/30** en ~20 s, et **12 entrées natives conservées** |
| Retour au natif | **13 images disponibles immédiatement** ; la barre dessine le trou (image 1 évincée) en deux segments |
| Lecture en natif | **89 images en 22 s**, séquence continue (2,3,4…17), médiane **147 ms** contre ~600 ms, 79/88 sauts égaux à 1 |
| Dataset fixe non-4D | ni timeline, ni tampon, ni préchargement — aucune erreur console |

Suite de tests : 94 tests, seul subsiste l'échec d'isolation préexistant de `test_max_version_from_changelog`.

**Réserve de méthode** : le volet de prévisualisation de l'environnement de développement est masqué, ce qui gèle `requestAnimationFrame` et empêche tout volume de finir de charger. Les mesures ci-dessus ont donc été prises avec une horloge d'animation de substitution fidèle (~63 Hz) et `document.hidden` neutralisé — sans quoi le préchargement refuse de démarrer, par conception. Les chiffres sont réels ; le rendu à l'écran, lui, n'a pas pu être observé.
