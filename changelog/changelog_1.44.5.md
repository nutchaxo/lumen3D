# Changelog v1.44.5 (Plateforme Web)

## [ADDED]
* **La vitesse de lecture d'un timelapse se règle depuis la frise.** La lecture d'un dataset `live` tournait à une cadence fixe de 10 images par seconde, sans aucun moyen de la changer : le composant de frise savait afficher un curseur SPEED, mais le viewer l'initialisait avec `showSpeed: false` — seule la page de tracking l'exposait. Une division qu'on veut suivre défilait donc à la même vitesse qu'un survol de la série entière.

  Un bouton apparaît maintenant à côté de lecture/pause et parcourt les cadences **0,5 / 1 / 2 / 5 / 10 / 20 img/s**, en bouclant. Un bouton plutôt qu'un second curseur : la barre de frise reste dense en information et ne demande pas de viser une poignée de 70 px (règle 1.3). La valeur de départ reste 10 img/s, exactement la cadence fixe d'avant — rien ne change tant que l'opérateur ne demande rien.

  La cadence est affichée en **images par seconde**, pas en multiplicateur : « ×2 » ne veut rien dire sans référence, alors que « 2 img/s » est la quantité que l'opérateur veut réellement fixer quand il compare un mouvement cellulaire à une horloge. C'est une cadence **demandée**, pas garantie : le verrou de lecture qui retient la tête pendant que l'image demandée se charge continue de s'appliquer, et à résolution native une image coûte ~600 ms — au-delà de 1 à 2 img/s la lecture avance donc au rythme du flux, pas du bouton. C'est précisément ce que le bas de la plage sert à éviter.

  Le réglage est mémorisé pour le viewer, pas pour le dataset : c'est une préférence de confort de l'opérateur, non une propriété du spécimen. Il survit au rechargement (`localStorage`) et il est inclus dans l'espace de travail sauvegardé/restauré des datasets `live` uniquement.

  Traduit dans les quatre langues, unité comprise (`img/s`, `fps`, `bps`) et séparateur décimal compris — « 0,5 img/s » en français, « 0.5 fps » en anglais — l'étiquette et l'infobulle suivant immédiatement un changement de langue.

  **Le curseur SPEED de la page de tracking n'est pas touché** : sa plage 1..10 signifie toujours 2..20 img/s. Le calcul d'avance de la tête a été factorisé en une seule fonction pour les deux commandes ; mesuré sur horloge synthétique, les deux voies produisent l'avance attendue à la trame près (curseur à 5 → 20 images en 2 s, identique à avant).
