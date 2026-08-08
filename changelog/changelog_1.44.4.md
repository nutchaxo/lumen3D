# Changelog v1.44.4 (Plateforme Web)

## [OPTIMIZED]
* **« Affichage » remonte dans la barre latérale du viewer, « Échelle Physique » descend en fin de liste.** L'encart Affichage porte les réglages consultés à chaque ouverture de dataset — mode de rendu, exposition, fond — et se trouvait tout en bas, sous Échelle Physique et Qualité de Rendu : le panneau Canaux d'un volume à quatre canaux occupe déjà plus d'un écran de haut, il fallait donc défiler pour l'atteindre. Échelle Physique ne sert qu'à corriger l'étirement Z d'une acquisition, une opération faite une fois pour toutes et rarement reprise : les deux encarts échangent leurs places. L'ordre est désormais Canaux → Affichage → Qualité de Rendu → Échelle Physique.

  Aucun identifiant, écouteur ni règle CSS n'est touché — le déplacement porte sur le balisage statique de `viewer.html`, et rien dans la feuille de styles ni dans `viewer.js` ne dépend du rang des `.panel-section` (pas de `nth-child`).
