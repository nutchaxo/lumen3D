# 21. Glossaire

::: chapter-intro
- Les termes sont classés **par ordre alphabétique**. Chaque définition tient en une ou deux phrases.
- « → chapitre N » vous envoie là où le mot est expliqué en détail.
- Les noms entre crochets, comme [Studio]{.ui}, sont ceux que vous voyez à l'écran.
:::

::: glossary
Atlas
: Grande texture 3D en mémoire graphique où l'on range les briques à afficher, comme les cases d'un casier. → chapitre 10

Bordure (apron)
: Voxel supplémentaire autour d'une brique, copié depuis ses voisines, pour que le filtrage ne laisse pas de couture entre deux briques. Les briques du format 4 font 66³ pour 64³ utiles. → chapitre 7

Brique
: Petit cube de 64×64×64 voxels : l'unité de découpage et de chargement d'un volume. → chapitre 7

Bruit de fond
: Signal parasite présent même là où il n'y a rien à voir (lumière diffuse, électronique du capteur). → chapitre 5

Cache
: Mémoire où l'on garde ce qui a déjà été téléchargé pour ne pas le redemander. → chapitre 10

Canal
: Une image du même objet pour une couleur de fluorescence donnée (par exemple DAPI, Pecam1, Sox2). → chapitre 4

Compression avec perte, sans perte
: Avec perte, le fichier est plus petit mais les valeurs sont légèrement modifiées ; sans perte, on retrouve exactement les valeurs d'origine. Les briques sont stockées sans perte. → chapitre 6

CSP (politique de sécurité du contenu)
: Règle donnée au navigateur : n'exécuter que les scripts portant un code à usage unique (nonce). → chapitre 19

Dilatation
: Opération qui épaissit les zones d'un masque d'un ou plusieurs pixels. → chapitre 5

Échantillon (rendu)
: Valeur lue en un point du volume pendant le lancer de rayons. Un rayon en prend des centaines. → chapitre 9

Ed25519 (signature)
: Méthode de signature numérique : un « sceau de cire » que seul l'éditeur peut apposer et que tout le monde peut vérifier. → chapitre 19

ESS (Empty Space Skipping, saut de l'espace vide)
: Les briques presque entièrement vides ne sont pas stockées ni parcourues, ce qui économise octets et calcul. → chapitres 7 et 9

Exposition
: Réglage de luminosité globale appliqué à l'affichage ; il n'altère pas les données. → chapitre 11

Fenêtrage
: Choix des valeurs min et max affichées : en dessous, noir ; au-dessus, pleine intensité. → chapitre 11

Filtre médian
: Remplace chaque valeur par la médiane de ses voisines : il supprime les points isolés sans brouiller les contours. → chapitre 5

Fonction de transfert
: Règle qui convertit une valeur du volume en couleur et en opacité. → chapitre 11

Format de données
: Façon dont un dataset est rangé sur le disque ; numéroté de 1 à 4. Le format courant est le 4. → chapitres 7 et 14

Gamma
: Réglage qui éclaircit ou assombrit les tons moyens sans toucher aux extrêmes. → chapitre 11

GPU
: Processeur de la carte graphique, spécialisé dans le calcul parallèle ; il exécute le lancer de rayons. → chapitre 9

HDF5
: Format de fichier scientifique qui range de gros tableaux de nombres, comme un classeur à tiroirs. Les fichiers Imaris en sont un. → chapitre 4

Histogramme
: Graphique qui compte combien de voxels ont chaque valeur d'intensité ; il aide à régler min et max. → chapitre 11

.ims
: Fichier Imaris : un conteneur HDF5 qui contient les canaux, les niveaux de résolution et les métadonnées d'une acquisition. → chapitre 4

index.bin
: Fichier binaire du format 4 qui dit dans quel pack se trouve chaque brique ; il remplace le gros manifeste JSON. → chapitre 7

Interpolation trilinéaire
: Estimation d'une valeur entre voxels en mélangeant les huit voisins, ce qui donne une image lisse. → chapitre 9

Kabsch (algorithme)
: Méthode qui trouve la rotation et le décalage alignant au mieux deux nuages de points ; utilisée pour stabiliser un timelapse. → chapitre 8

Lancer de rayons (ray marching)
: Pour chaque pixel de l'écran, on suit un rayon à travers le volume en cumulant couleur et opacité. → chapitre 9

LOD (niveau de détail) / niveau
: Version du volume à une résolution donnée ; le niveau 0 est le plus fin. → chapitre 6

Manifeste
: Fichier qui décrit le contenu d'un dataset (niveaux, briques, packs). → chapitre 7

Masque
: Image en noir et blanc qui dit quels pixels comptent (blanc) et lesquels sont écartés (noir). → chapitre 5

Migration
: Mise à jour d'un dataset déjà publié vers un format plus récent, sans repasser par le pipeline. → chapitre 14

MIP (projection d'intensité maximale)
: Image où chaque pixel prend la valeur la plus forte rencontrée le long d'un axe. → chapitres 7 et 12

Mosaïque
: Plusieurs petites images collées en une grande ; une brique est stockée comme une mosaïque de ses coupes. → chapitre 7

Nonce
: Code aléatoire à usage unique, tiré à chaque chargement de page, qui autorise les scripts du site. → chapitre 19

Opacité
: Degré d'absorption de la lumière par une structure : 0 est transparent, 1 est opaque. → chapitre 11

Ouverture morphologique
: Érosion suivie d'une dilatation : elle efface les petits points isolés d'un masque et garde les grandes formes. → chapitre 5

Pack
: Fichier `.bin` qui regroupe de nombreuses briques pour limiter le nombre de téléchargements. → chapitre 7

Percentile
: Valeur sous laquelle se trouve un pourcentage donné des mesures : le 99e percentile est dépassé par 1 % des valeurs. → chapitre 5

Pixel
: Plus petit élément d'une image 2D. → chapitre 4

Plans
: Dossier `planes/` du format 2 : un fichier par plan z du niveau natif, pour lire une coupe XY sans charger 64 plans. → chapitre 14

Plugin
: Outil optionnel qui s'ajoute au viewer (mesure, capture, filtre…) ; il est installé depuis le catalogue signé. → chapitres 12 et 14

PNG
: Format d'image sans perte ; les plans du format 2 sont des tuiles PNG de 512×512. → chapitre 14

Profondeur de bits
: Nombre de bits par valeur : 8 bits donnent 256 niveaux, 16 bits en donnent 65 536. → chapitre 4

Pyramide
: Ensemble de versions du volume à des résolutions de plus en plus grossières, empilées comme les étages d'une pyramide. → chapitre 6

Quaternion
: Quatre nombres qui décrivent une rotation 3D sans blocage ; ils servent à mémoriser l'orientation d'un embryon. → chapitre 12

Shader
: Petit programme exécuté par la carte graphique ; celui du viewer fait le lancer de rayons. → chapitre 9

Signature
: Voir Ed25519. → chapitre 19

Staging
: Zone privée où arrivent les fichiers importés avant publication ; elle n'est jamais accessible par URL. → chapitres 14 et 19

Streaming
: Chargement progressif : on affiche ce qui est arrivé et on complète en continu, sans attendre tout le fichier. → chapitre 10

Studio
: Outil de figures : recadrage, annotations, barres d'échelle et export d'images pour publication. → chapitre 12

Suivi cellulaire
: Suivi de chaque cellule d'image en image dans un timelapse (trajectoires, lignées, divisions). → chapitre 8

Super-bloc
: Groupe de 4×4×4 briques voisines qu'un pack range en bloc pour qu'une région se lise d'un seul tenant. → chapitre 7

Table de pages
: Tableau qui dit où chaque brique se trouve dans l'atlas, comme un plan de casiers. → chapitre 10

Three.js
: Bibliothèque JavaScript qui simplifie l'affichage 3D dans le navigateur. → chapitre 2

Timelapse
: Série d'acquisitions du même spécimen au fil du temps, chaque image étant un volume 3D. → chapitre 4

Voxel
: Pixel en 3D : un petit cube de valeur d'intensité. Sa taille réelle (en µm) est la calibration. → chapitre 4

VRAM
: Mémoire de la carte graphique. Son budget limite la taille d'atlas que le viewer peut utiliser. → chapitre 10

WebGL2
: Technologie du navigateur qui donne accès à la carte graphique, notamment aux textures 3D. → chapitre 9

WebP sans perte
: Format d'image compressé qui restitue exactement les valeurs d'origine ; il stocke les mosaïques de briques. → chapitre 6

Worker (Web Worker)
: Processus d'arrière-plan du navigateur : il décode et calcule sans geler l'écran. → chapitre 10
:::
