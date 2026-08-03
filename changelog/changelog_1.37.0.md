# Changelog — Plateforme Web v1.37.0

## [ADDED]

### Studio de coupe — navigation à deux doigts

Le Studio (préparation de figures : flèches, barre d'échelle, texte, export PNG) n'avait aucun moyen de zoomer au doigt : le zoom y était à la molette, et le seul bouton de vue est « Reset View ». Sur tablette, on ne pouvait donc pas cadrer.

Comme dans le viewer, **deux doigts déplacent et zooment**, dans le même geste, avec le zoom **ancré sur le point pincé**. Ici la règle est encore plus stricte : **un doigt dessine**, donc la navigation appartient entièrement au second — un geste ne produit jamais de trait.

L'ancrage se dérive de la transformation du Studio, `écran = R(rotation)·(image − centre)·zoom + décalage`. Fixer le point d'image sous le milieu des doigts donne `décalage' = milieu' − (milieu − décalage)·(zoom'/zoom)` : simple translation quand l'écartement ne change pas, zoom ancré quand seul l'écartement change, exact quand les deux bougent ensemble. **La rotation sort de l'équation** — une figure pivotée est donc traitée sans cas particulier (vérifié à 30° : dérive du point tenu de l'ordre de 10⁻¹⁴).

Le geste **ne fait pas pivoter** la figure : sur une surface de préparation de figure, on veut une orientation choisie et stable, pas une rotation accidentelle en pinçant. Elle reste au curseur dédié et à `Alt` + glisser.

Un tracé en cours au moment où le deuxième doigt se pose est **refermé proprement**, jamais laissé à moitié :

* une forme encore à l'état de brouillon est abandonnée — elle ne devient un calque qu'au relâchement, rien ne se crée ;
* un déplacement ou un redimensionnement **déjà écrit dans un calque** est validé dans l'historique, donc annulable, plutôt que réverti en silence ;
* une mesure d'angle en cours (trois clics successifs) est préservée : elle survit déjà aux relâchements par construction, le geste ne la casse pas.

Le doigt qui reste après un pincement demeure **inerte** jusqu'à ce qu'on le lève : lui rendre la main dessinerait une forme que l'utilisateur n'a jamais voulue, il naviguait. C'est l'inverse du viewer, où le doigt restant reprend l'orientation — parce que là-bas, un doigt ne crée rien.

## [FIXED]

### Studio de coupe — dessiner au doigt fonctionne

Le canvas du Studio ne déclarait pas à qui appartenaient les gestes tactiles. Le navigateur y voyait donc un défilement dès qu'un tracé s'écartait de l'horizontale, s'appropriait le pointeur et annulait le trait en cours de ligne — le dessin au doigt était en pratique inutilisable, indépendamment du geste à deux doigts ajouté ci-dessus. Le canvas déclare maintenant `touch-action: none` : il possède tous les gestes, un doigt pour dessiner, deux pour naviguer.
