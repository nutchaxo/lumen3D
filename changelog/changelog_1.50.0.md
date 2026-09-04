# Changelog v1.50.0 (Plateforme Web)

## [ADDED]
* **Planche de figure : deux mises en page, une calibration par panneau.** `figure-panel` 1.1.0 propose *même échelle physique* (chaque panneau ramené au pixel le plus grossier de la sélection, une seule barre d'échelle vraie pour tous) ou *même taille d'image* (chaque photographie remplit sa case, une barre d'échelle par panneau). Dans les deux cas, le Studio reçoit un rectangle de calibration par panneau (`layoutMaps`) : une barre d'échelle ou une distance posée sur un panneau lit le µm/px de ce panneau et se recalcule si on la déplace sur un autre.

* **Navigation propre à chaque panneau.** Quand la page wholemount est un panneau (vue divisée ou page Comparer), son en-tête est masqué ; elle affiche désormais ses propres commandes précédent / parcourir / suivant / ajuster au-dessus de la photographie. Le panneau de droite d'une vue divisée se change donc directement, comme celui de gauche.

* **La page Comparer accueille les photographies.** Un panneau wholemount y partage sa vue physique avec les autres photographies via l'option de synchronisation *Camera* (µm par pixel écran et centre physique communs), ne montre pas les commandes 3D (Z-stack, grille, axes), répond au bouton *réglages* du panneau en ouvrant sa barre latérale, alimente le Studio de comparaison avec son rendu natif calibré, et ne bloque plus la file de chargement haute définition des volumes voisins (la poignée de main `START_HIGH_DETAIL`, sans réponse possible, tenait une place pendant 60 s).

## [FIXED]
* **`WholemountViewer` et `WholemountApp` sont exposés sur `window`.** Une `const` de premier niveau n'est pas une propriété de `window` : la page Comparer et l'hôte de la vue divisée, qui lisent le visualiseur d'un panneau via `iframe.contentWindow`, ne le trouvaient pas. Le lien de vue physique entre panneaux et l'export vers le Studio en dépendaient.
* **Les pastilles de zoom et de navigation d'un panneau ne recouvrent plus l'en-tête dessiné par la page hôte.**
