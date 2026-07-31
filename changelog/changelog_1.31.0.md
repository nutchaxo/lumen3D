# Changelog v1.31.0 (Plateforme Web)

> Les données de suivi cellulaire étaient produites, publiées et servies — mais rien ne les dessinait. Le viewer affiche désormais les centroïdes suivis par-dessus le volume, pilotés depuis la barre latérale comme un canal, sans histogramme.

## [ADDED]

* **Calque « Points de suivi ».** Un dataset dont le `metadata.json` porte un bloc `tracking` gagne une entrée dans le panneau des canaux : case de visibilité, pastille de couleur, ligne d'état, et un corps dépliable avec **taille en micromètres**, **opacité** et la **légende des régions** avec leurs effectifs. Aucun histogramme : il n'aurait aucun sens pour un nuage de points, et son absence est **structurelle** — la boucle de plugins qui en injecte un ne tourne que sur le chemin des canaux, elle n'est pas filtrée après coup.
* **Le panneau connaît maintenant la notion de *calque*** (`ChannelPanel.registerLayer`), distincte de celle de canal. `_channels` reste strictement 1:1 avec les canaux réels : `getState`/`setState`, les écritures d'uniformes de `VolumeViewer.updateChannel` et la sérialisation d'espace de travail indexent tous par numéro de canal, et y glisser un pseudo-canal les aurait tous décalés. Un dataset sans suivi rend exactement le même DOM qu'avant.
* **Chargement hors du thread principal** (`js/workers/tracks-load-worker.js`) : `tracks.json` fait 1 Mo et le viewer diffuse des bricks en même temps. Le worker télécharge, décompresse si un `.gz` est disponible, analyse et empaquette le tout en tableaux typés transférés en une fois (~375 Kio). La ligne d'état affiche le pourcentage et l'étape, pas un sablier.

## [FIXED]

* **Le cadrage caméra suivait ses décorations.** `fitCameraToVolume` mesurait la boîte englobante avec `Box3.setFromObject(cube)`, qui parcourt **tous** les descendants : les sprites de mesure et le plan de coupe élargissaient donc le cadrage. Pire, `expandByObject` met en cache la boîte de chaque enfant : un calque dont les positions sont réécrites à chaque image aurait figé le cadrage sur ce que couvrait la frame 0, pour toute la session. Le cadrage se fait désormais sur la géométrie du volume seule.

## [NOTE] — les deux pièges de ce calque, et comment ils sont traités

**Quel jeu de coordonnées.** L'espace objet du cube **est** celui des micromètres stabilisés quand le warp du shader est actif (`volumeWarp = toTex · M⁻¹ · toUm`), et celui des micromètres bruts d'acquisition sinon. `tracks.json` porte les deux jeux : c'est donc un simple aiguillage de dictionnaire, **jamais** un produit matriciel. Appliquer `M` à des positions déjà stabilisées les enverrait dans un troisième repère — erreur **invisible au premier timepoint**, où la transform est l'identité, et de ~250 µm au dernier, ce qui se lirait comme un défaut d'alignement général plutôt que comme une mauvaise branche.

**Quelle taille.** Des sphères instanciées, pas des `THREE.Points`. `gl_PointSize` est un nombre de pixels : pour exprimer un diamètre en micromètres il faudrait le diviser par `tan(fov/2)`, il est écrêté par `ALIASED_POINT_SIZE_RANGE` du pilote (les points cessent de grossir au zoom) et il dessine des carrés. Une sphère dont l'échelle d'instance compense `cube.scale` reste ronde dans l'espace monde, honnête en micromètres à tout zoom, et survit à l'échelle Z d'affichage.

Le calque suit aussi le **clipping** : il applique exactement le test du shader (`clipBoxMin`/`clipBoxSize` sous warp, `p + 0.5` sinon), donc il se réduit avec les curseurs de clip et avec la dalle du mode z-stack au lieu de flotter au-dessus d'un volume masqué.

## [VERIFIED]

Contre le dataset réel (579 cellules, 30 timepoints), dans le navigateur :

| Contrôle | Résultat |
|---|---|
| Conversion µm → espace objet | **écart max 1,5·10⁻⁸** contre un recalcul indépendant depuis `tracks.json` + `metadata.json` |
| Points placés au premier timepoint | **324 / 324** attendus, tous dans la boîte d'acquisition |
| Bascule stabilisé ↔ brut | **251,4 µm** d'écart moyen à t=29 (valeur mesurée dans les données), **0** à t=0 où la transform est l'identité |
| Suivi du clipping | 324 → 229 (moitié en z) → 4 (dalle de 10 %) → 324 après restauration |
| Taille | doubler le diamètre en µm double exactement l'échelle d'instance |
| Régions | 7 régions, effectifs et couleurs conformes au `metadata.json` |
| Dataset sans suivi | 4 canaux, **0 calque**, histogrammes intacts, aucune erreur console |

**Non vérifié à l'écran** : le rendu visuel lui-même (les points superposés aux cellules fluorescentes) et l'isotropie en espace monde une fois le volume chargé. Le volet de prévisualisation de l'environnement de développement était masqué, ce qui gèle `requestAnimationFrame` — or le streamer de bricks attend un paint, donc le volume ne finit pas de charger. Le placement a été validé numériquement à la place ; un contrôle visuel reste à faire.
