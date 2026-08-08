# Changelog v1.46.0 (Plateforme Web)

## [ADDED]
* **Un dataset s'ouvre dans l'orientation qu'on lui a définie — et il l'est avant que la première brique arrive.** L'orientation enregistrée depuis le panneau d'administration ne servait qu'à dessiner le gizmo A/P · D/V · L/R : le volume, lui, s'ouvrait toujours sur ses axes voxel bruts, et l'opérateur devait le tourner à la main à chaque ouverture pour retrouver la vue dont il parlait dans son article. Un spécimen acquis couché apparaissait couché.

  Le moment où la pose est appliquée est le cœur de la chose. La faire après le chargement se verrait : les briques arrivent pendant plusieurs dizaines de secondes, le volume s'afficherait donc dans une pose puis basculerait dans une autre au milieu du flux. Elle est donc posée par un **nouveau couloir de démarrage**, `PluginRegistry.prepareAll(ctx)`, que `viewer.js` déclenche entre `VolumeViewer.init()` et le premier `fetch` de pack — canevas encore vide, rien à faire basculer. Mesuré sur `Egfl7eGFP-E8-1` : la pose est enregistrée à t=8841 ms alors que **zéro** pack a été demandé, le premier `pack_00.bin` part à t=9332 ms sur un cube **déjà** orienté, et l'échantillonnage de la pose image par image jusqu'à la fin du chargement ne relève **qu'une seule** valeur — aucun basculement.

  La pose est enregistrée comme **quaternion « home » du viewer** (`VolumeViewer.setHomeQuaternion`), pas seulement recopiée sur le cube : « Réinitialiser la vue » ramène donc là où le dataset s'est ouvert, et non aux axes voxel. Un `#state=…` partagé par un collègue continue de gagner — il est restauré plus loin dans le démarrage, et c'est bien ce qu'on attend d'un lien qui décrit une vue précise.

  Le gizmo n'a pas besoin d'être affiché : ouvrir depuis l'explorer suffit.

* **Une vue par défaut est une phrase d'anatomie, pas une pose de voxels.** Elle est stockée comme `Q_anat`, l'orientation **du repère anatomique** dans le monde, et composée au chargement avec l'étalonnage du dataset :

      Q_anat = Q_cube · Q_base⁻¹     ← ce avec quoi le gizmo est dessiné
      Q_cube = Q_anat · Q_base       ← ce avec quoi une vue par défaut est appliquée

  Conséquence voulue : affiner l'étalonnage anatomique plus tard **ne périme pas** la vue enregistrée. « Face ventrale, antérieur en haut » veut toujours dire la même chose, alors qu'un quaternion de cube brut aurait silencieusement désigné une autre vue.

  Six préréglages sont proposés, chacun défini par deux contraintes anatomiques — quelle direction fait face à la caméra, laquelle pointe vers le haut : face ventrale, face dorsale, profil gauche, profil droit, vue antérieure, vue postérieure. Un préréglage n'est donc pas un quaternion écrit à la main mais un changement de base construit à partir de ces deux contraintes, ce qui est exactement ce que le test vérifie : la direction promise arrive bien sur le +Z du monde, à 1e-3 près, quel que soit l'étalonnage du dataset.

* **« Orientation 3D » est devenue une vraie section dans l'éditeur de datasets.** Elle ne contenait qu'un bouton. Elle en porte maintenant trois blocs :

  **Repère anatomique** — le bouton d'étalonnage d'avant. À un détail près, qui manquait : lancer l'étalonnage **repart de l'alignement déjà enregistré** au lieu de la pose où le volume se trouve. Sur un dataset déjà étalonné, l'opérateur voit son alignement et le retouche ; avant, il le refaisait de zéro à chaque fois.

  **Axes affichés** — les six bras (A, P, V, D, R, L), chacun avec une case à cocher et un champ de renommage de 12 caractères. Décocher masque le bras, et il n'est alors **pas construit du tout** plutôt que rendu invisible : un axe masqué l'est parce qu'il n'a pas de sens pour ce spécimen, il ne doit donc coûter ni géométrie ni texture. Un renommage vide retombe sur la lettre localisée. La toile des étiquettes passe à un rapport 2:1, sans quoi un nom comme « Rostral » s'affichait écrasé sur un sprite carré.

  **Vue par défaut** — la liste des six préréglages, « Aucune », et « Utiliser la vue actuelle » qui capture la pose que l'opérateur vient de composer dans l'aperçu.

  Le panneau **ne calcule aucun quaternion**. Il pose la question au greffon qui tourne dans l'aperçu (`APPLY_ORIENTATION_VIEW` / `GET_ORIENTATION_VIEW`) et enregistre la réponse : la géométrie n'a qu'une implémentation, et ce qui est sauvegardé est exactement ce que l'opérateur a vu. Corollaire assumé : sans le greffon installé, la vue par défaut n'est pas configurable — le panneau le dit au bout de 2 s d'attente au lieu de laisser une liste déroulante sans effet. Les modifications d'axes sont poussées en direct dans l'aperçu, avec une temporisation : le gizmo est reconstruit à chaque envoi, taper un nom ne doit pas jeter et re-téléverser six textures par frappe.

* **Crochet `prepare(ctx)` dans le contrat des greffons.** Dispatché par `PluginRegistry.prepareAll()` avant que le volume ne se charge, pour un module qui doit fixer l'état **initial** de la scène. Délibérément synchrone — il est sur le chemin critique du démarrage, un `prepare()` qui rend une promesse n'est pas attendu. Le `ctx` d'un greffon est désormais construit une seule fois (`_pluginCtx`) : `prepare()` et `init()` reçoivent le même objet. Un module sans `prepare()` est laissé strictement tel quel.

## [FIXED]
* **Le gizmo d'orientation ne fuyait plus discrètement le GPU.** `dispose()` retirait le groupe de la scène et s'arrêtait là : les six géométries de flèche, les matériaux et les six textures de canevas des étiquettes restaient alloués (règle 1.2). Sur la page Comparaison, où chaque panneau est un viewer complet, changer de dataset dans quatre panneaux les accumulait. Tout ce que le groupe possède est maintenant libéré — au `dispose()` comme à chaque reconstruction déclenchée par un renommage ou un changement de langue.

## [I18N]
* Nouvelles clés d'administration dans les quatre langues (`en`, `fr`, `es`, `nl`), parité complète vérifiée : `admin.orientationFrame`, `admin.orientationAxes*`, `admin.defaultView*`, `admin.captureView`, `admin.view*` (10 clés), `admin.axis*` (6 clés), `admin.orientationPluginMissing`.

## [TESTS]
* `tests/js/test_orientation_default_view.mjs` — exécute le **vrai** `index.js` du greffon avec le Three.js du dépôt : les six préréglages amènent bien l'anatomie promise face à la caméra sous un étalonnage non trivial, capturer puis réouvrir une vue reproduit la pose au 1e-6, `prepare()` enregistre la pose « home » et **ne touche à rien** sur un `defaultView` absent, vide, dégénéré (quaternion nul), non fini ou de préréglage inconnu, et l'éditeur d'axes masque/renomme ce qu'il annonce.
