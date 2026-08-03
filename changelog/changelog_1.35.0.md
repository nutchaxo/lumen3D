# Changelog — Plateforme Web v1.35.0

## [ADDED]

### Navigation tactile du volume — deux doigts pour déplacer et zoomer, un doigt pour orienter

Sur tablette et téléphone, la vue 3D se pilote maintenant comme une carte :

* **un doigt** fait tourner le volume (orientation) ;
* **deux doigts** le déplacent — la vue suit le milieu des deux doigts ;
* **écarter / rapprocher les deux doigts** zoome, et le zoom est **ancré sur le point pincé**.

Les deux gestes à deux doigts sont le **même** geste : on peut déplacer et zoomer dans le même mouvement, sans lâcher. Ce qui se trouve entre les doigts y reste, du début à la fin du geste — c'est ce qui donne l'impression de manipuler l'image plutôt que de piloter un curseur de zoom.

C'est une propriété exacte, pas un réglage : un point situé à `a` pixels du centre du canvas se trouve à `a·wpp(z)` unités monde (`wpp(z) = 2·tan(fov/2)·z / hauteur` — la hauteur du frustum à la distance `z`). Maintenir `a·wpp(z) − position` constant donne une seule mise à jour, qui vaut translation quand seul le milieu bouge, zoom ancré quand seul l'écartement change, et reste juste quand les deux changent en même temps — ce que fait chaque mouvement réel, les doigts n'envoyant jamais leurs événements ensemble.

Auparavant, deux doigts ne faisaient que zoomer, autour du centre de l'écran : pour cadrer une région excentrée il fallait alterner zoom et déplacement au doigt+majuscule, geste impossible sans clavier.

Le geste est **prioritaire sur l'outil actif** : le volume reste atteignable à deux doigts même en mode mesure ou en mode coupe, où le doigt unique est pris par l'outil. Et l'enchaînement est continu — poser un deuxième doigt pendant une rotation bascule proprement en déplacement (une étiquette en cours de glissement est validée, pas perdue), lever un doigt sur deux rend la main à la rotation avec le doigt restant, au lieu de le laisser inerte jusqu'au prochain appui. Un troisième doigt, ou le lever d'un des deux premiers, ré-ancre le geste sur la paire courante plutôt que de téléporter le volume.

Le geste survit aussi à un `pointercancel` — l'événement que le navigateur envoie quand il décide de récupérer le geste : la vue s'arrête là où elle en est, plus rien ne reste armé.

*(La page Tracking utilise `OrbitControls`, dont les réglages tactiles par défaut — un doigt tourne, deux doigts zooment et déplacent — correspondent déjà à ce comportement.)*

## [FIXED]

### Histogrammes — le curseur ne se « lâche » plus en cours de glissement

Déplacer une poignée de niveaux au doigt lâchait le curseur en pleine course : il fallait la rattraper plusieurs fois pour l'amener où on voulait. Trois causes, corrigées ensemble.

1. **Le navigateur volait le geste.** Rien n'indiquait à la page que le glissement horizontal lui appartenait : dès que le doigt dérivait un peu vers le haut ou le bas — ce que fait tout doigt —, le navigateur y voyait un défilement de la barre latérale, s'appropriait le pointeur et émettait `pointercancel`. Or le code n'écoutait que `pointerup` : le glissement mourait là, et ses écouteurs restaient attachés à `window`, un jeu de plus à chaque tentative. Une poignée saisie déclare désormais `touch-action: none` (elle possède le geste dans les deux axes), la bande d'histogramme `touch-action: pan-y` (le défilement vertical de la barre latérale reste possible depuis l'histogramme), et la fin de glissement est traitée sur `pointercancel` et `lostpointercapture` autant que sur `pointerup` — la dernière position est appliquée, et rien ne survit au geste.

2. **La cible était trop petite.** La poignée mesure 12 px de large. Sa zone de préhension est maintenant plus large que le dessin, et toute la bande d'histogramme devient une surface de saisie : un appui n'importe où prend **la poignée la plus proche**. Sur écran tactile, la poignée elle-même est aussi élargie (22 px, recentrée par marge négative pour rester compatible avec une version antérieure du plugin installée depuis le catalogue).

3. **La poignée sautait sous le doigt.** L'appui appliquait immédiatement la position touchée, donc saisir une poignée décalait déjà la valeur avant tout mouvement. Un appui à moins de 20 px d'une poignée la **saisit** en conservant l'écart doigt/poignée ; plus loin, elle rejoint le point touché comme avant.

Le pointeur est capturé sur l'éditeur, pas sur la poignée : il rend compte à un seul élément pour toute la durée du glissement, où que le doigt aille — hors de la poignée, hors de la bande, hors de la barre latérale.

### Scrubber temporel — même défaut, même correction

La glissière de la timeline (jeux de données 4D) présentait exactement le même défaut : pas de `touch-action`, pas de `pointercancel`. Un geste récupéré par le navigateur laissait la glissière armée, qui suivait ensuite le premier mouvement sans rapport. Elle déclare maintenant `touch-action: none` et se désarme sur annulation en conservant l'image atteinte.

### Téléphone — le volume reçoit l'écran au premier affichage

Sur un écran de 375 px, la barre latérale de 320 px ne laissait que ~55 px de canvas : aucun geste ne rattrape une vue aussi étroite. Sous 700 px de large, le viewer s'ouvre donc **barre latérale repliée**, le volume occupant toute la largeur ; le bouton flottant existant la ramène. Tablettes et écrans larges sont inchangés.
