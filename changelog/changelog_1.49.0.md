# Changelog v1.49.0 (Plateforme Web)

## [ADDED]
* **Cinq plugins pour les photographies whole-mount** (opt-in `dataTypes: ["wholemount"]`, publiés sur le marketplace, installables depuis l'onglet Catalogue) :
  * **Orientation 2D** (`orientation-2d`) : rotation libre et miroir de la photographie avec boussole A/P superposée, pour placer l'antérieur en haut. Le panneau admin l'enregistre avec le dataset (`metadata.orientation2d`, même poignée de main `CALIBRATE_ORIENTATION_START` / `GET_ORIENTATION` que le plugin 3D) et la page l'applique à l'ouverture ; l'espace de travail mémorise la pose de session.
  * **Grille calibrée** (`calibrated-grid`) : grille physique en pas 1-2-5 (µm ou mm) ancrée sur le coin de la photographie, trois états (aucune / large / fine), distances étiquetées sur les bords.
  * **Réglages d'affichage** (`display-adjust`) : luminosité, contraste, gamma, balance des blancs (rouge / bleu) et aplatissement du vignettage par ouverture en niveaux de gris à fenêtre plus large que le spécimen. Non destructif : les mesures et l'isolation du marquage lisent la photographie intacte.
  * **Vue divisée** (`split-view`) : une seconde photographie de la collection à côté de la première, zoom et déplacement liés **à l'échelle physique** (µm par pixel écran et centre physique partagés), échange des deux côtés, choix libre de la comparaison.
  * **Constructeur de planche** (`figure-panel`) : sélection de N photographies, grille à échelle physique commune (chaque panneau ramené au pixel le plus grossier de la sélection, jamais suréchantillonné), orientation enregistrée respectée, étiquettes de stade ou de nom, fond sombre ou clair, une seule barre d'échelle vraie pour tous ; export PNG ou ouverture dans le Studio, calibré.

* **Le visualiseur 2D expose ce dont ces plugins ont besoin.** Trois repères explicites (image → orienté → canvas) avec la rotation comme transformation rigide, donc une seule relation de calibration ; superpositions de plugin (`viewer.addOverlay`) dessinées entre l'image et les mesures ; vue physique (`getPhysicalView` / `setPhysicalView`) ; réglages d'affichage mis en cache ; sections de barre latérale (`ui.addSidebarSection`) ; collection et changement de dataset (`dataset.getCollection` / `onChange` / `open`) ; mode panneau (`?panelIndex=`) où la page échange sa vue physique avec son parent sans écho.

* **Admin.** La section Orientation reste visible pour un wholemount, sans l'éditeur d'axes 3D ni la vue par défaut ; le résultat `orientation2d` est enregistré à la sauvegarde.
