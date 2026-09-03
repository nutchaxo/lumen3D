# Changelog v1.48.0 (Plateforme Web)

## [ADDED]
* **Studio sur les photographies whole-mount.** Le bouton *Ouvrir dans le Studio* de la page `wholemount.html` envoie l'image à résolution native (telle qu'affichée : normale ou avec le marquage isolé) dans le Studio d'annotation existant, calibré en µm/px ; rectangles, ellipses, flèches, textes, barre d'échelle et mesures, export PNG et JSON, comme pour une coupe de volume. Le Studio accepte désormais le dataset dans son entrée (`sliceResult.dataset`) au lieu de le chercher dans un `ViewerApp` global, ce qui le rend utilisable par toute page.

* **Étiquettes de mesure déplaçables et redimensionnables sur le wholemount.** Une étiquette se déplace à la souris ; le décalage est mémorisé en pixels image avec la mesure (`labelOffset`, persisté dans `MeasurementStore`), donc l'étiquette reste collée au même endroit de la photographie à tout zoom. Un curseur règle la taille du texte, une case masque toutes les étiquettes ; les deux réglages font partie de l'état d'espace de travail.

* **Résolution affichée.** Une pastille en haut à droite du canvas donne le zoom par rapport au natif (100 % = un pixel image par pixel écran) et la taille physique d'un pixel écran à ce zoom.

* **Aperçu et édition des wholemounts dans le panneau admin.** L'aperçu de l'onglet Datasets ouvre `wholemount.html` pour ce type (en mode `admin`, sans en-tête), pour un dataset publié comme pour un import en staging (lecture par le proxy `api/upload.php?action=blob`). Le formulaire n'affiche plus les sections volume (calibration voxel, exposition, orientation 3D) pour une photographie, montre la taille de pixel dans les dimensions, et une sauvegarde ne fabrique plus trois canaux ni de `voxel_size` factices.

* **Menu `[3]` du pack pipeline.** Le lanceur `RUN.bat` propose l'import de photographies whole-mount (dossier de TIFF, coloration, lignée, copie de l'original) ; les choix suivants sont renumérotés (`[4]` rattacher un tracking, `[5]` vérifier l'environnement).

## [FIXED]
* **Onglet Datasets vide sur un hôte PHP.** Trois défaillances, chacune capable de vider toute la liste à partir d'une seule donnée anormale, sont neutralisées : un `json_encode` qui échouait sur un nom de dossier non UTF-8 renvoyait un corps vide en 200 (désormais substitution des octets invalides, sinon une erreur 500 explicite — `admin_json_body`, partagé par `json_out` et `admin_json_out`) ; le tri par nom levait un `TypeError` sous `strict_types` quand `name` était un nombre ; un journal d'import corrompu faisait tomber les datasets publiés avec lui (chaque journal est maintenant isolé, en PHP comme en Python, et un journal illisible est ignoré et journalisé). `datasets.php` finalise aussi les fichiers `.lumen-new` laissés par une mise à jour interrompue, comme `admin.php` et `auth.php`. Côté client, `apiFetch` journalise dans la console le statut HTTP et le début d'une réponse non JSON au lieu de l'avaler. Test : `tests/test_datasets_list_php.php`.
