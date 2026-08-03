# Changelog — Plateforme Web v1.34.2

## [FIXED]

### Éditeur de pages — deux barres d'outils superposées à la sélection d'un élément

Cliquer sur un élément faisait apparaître **deux barres d'outils l'une sur l'autre** dans le coin haut-droit : celle de l'élément (dupliquer / supprimer) et celle de sa colonne (déplacer / réglages / dupliquer / supprimer), décalées de 2 px — d'où l'impression de doublon, et le risque de cliquer sur la mauvaise icône, puisque la barre de la colonne se dessine par-dessus.

Cause : chaque niveau (section, colonne, élément) épingle sa barre au coin haut-droit de son propre bloc, et ces coins se confondent dès qu'un bloc est aligné sur le bord haut de son parent — le cas normal pour le premier élément d'une colonne, celles-ci n'ayant pas de marge intérieure par défaut. La visibilité étant décidée bloc par bloc (survol de la colonne *et* sélection de l'élément), les deux barres s'affichaient ensemble.

La visibilité est maintenant **arbitrée en un seul endroit** (`js/core/page-edit-frame.js`) : le bloc le plus intérieur sous le curseur possède le coin, et un bloc sélectionné ne garde sa barre que tant que le pointeur est hors de la surface d'édition. Une seule barre est donc visible à la fois, quel que soit l'imbrication :

* survol d'un élément → barre de l'élément (poignée de déplacement comprise), la colonne s'efface ;
* survol de la colonne hors de ses éléments → barre de la colonne, l'élément sélectionné s'efface ;
* survol de la marge de la section → barre de la section ;
* pointeur sorti du cadre → l'élément sélectionné récupère sa barre.

L'arbitrage lit la position du pointeur plutôt que des paires `mouseenter`/`mouseleave` par bloc : la règle reste vraie quel que soit l'ordre de déclenchement des événements imbriqués. Les liserés de survol, la sélection, le glisser-déposer et les actions des barres sont inchangés.
