# 21. Glossaire

::: chapter-intro
- Les termes sont classés **par ordre alphabétique**. Chaque définition tient en une ou deux phrases.
- « → chapitre N » vous envoie là où le mot est expliqué en détail.
- Les noms entre crochets, comme [Studio]{.ui}, sont ceux que vous voyez à l'écran.
:::

::: glossary
Atlas
: Grande texture 3D en mémoire graphique où l'on range les briques à afficher, comme les cases d'un casier. → chapitre 10

Atomique
: Se dit d'une opération qui réussit en entier ou pas du tout, sans état intermédiaire visible. Une publication de dataset est atomique. → chapitres 8 et 17

Bac à sable (sandbox)
: Cage dans laquelle un plugin tiers s'exécute : il ne voit ni la page, ni vos cookies, et ne peut demander que ce qu'on lui a explicitement permis. → chapitre 15

Bleu-vert (déploiement)
: Méthode de mise à jour : la nouvelle version est préparée à côté de l'ancienne, testée, puis substituée ; l'ancienne reste disponible pour un retour arrière. → chapitre 18

Boîte englobante (bounding box)
: Parallélépipède qui entoure tout le volume. Un clic qui n'atteint que cette boîte, sans structure visible dessous, n'est pas une mesure valable. → chapitre 12

Bordure (apron)
: Voxel supplémentaire autour d'une brique, copié depuis ses voisines, pour que le filtrage ne laisse pas de couture entre deux briques. Les briques du format 4 font 66³ pour 64³ utiles. → chapitre 7

Brique
: Petit cube de 64×64×64 voxels : l'unité de découpage et de chargement d'un volume. → chapitre 7

Bruit de fond
: Signal parasite présent même là où il n'y a rien à voir (lumière diffuse, électronique du capteur). → chapitre 5

Bruit de Poisson
: Variation aléatoire d'un signal faible, due au nombre limité de photons reçus : plus le signal est faible, plus il paraît granuleux. S'y ajoute le bruit de la caméra. → chapitre 5

Cache
: Mémoire où l'on garde ce qui a déjà été téléchargé pour ne pas le redemander. → chapitre 10

Calibration (physique)
: Taille réelle d'un voxel, en micromètres, dans chaque direction. Sans elle, la barre d'échelle et les mesures n'existent pas. → chapitres 4 et 9

Canal
: Une image du même objet pour une couleur de fluorescence donnée (par exemple DAPI, Pecam1, Sox2). → chapitre 4

Catalogue
: Deux sens à distinguer : la liste des jeux de données du site, générée à la demande à partir des fichiers, et le catalogue de plugins signé, d'où l'on installe les outils. → chapitres 3 et 15

Compression avec perte, sans perte
: Avec perte, le fichier est plus petit mais les valeurs sont légèrement modifiées ; sans perte, on retrouve exactement les valeurs d'origine. Les briques sont stockées sans perte. → chapitre 6

Confocal (microscope)
: Microscope qui n'enregistre que la lumière venue d'un plan très mince du spécimen, plan après plan ; l'empilement des plans forme le volume. → chapitre 4

Contexte (page ou panneau)
: Situation dans laquelle une page tourne : seule, ou intégrée comme panneau (Comparer, vue divisée). Un plugin ne se charge dans un panneau que s'il l'a déclaré. → chapitre 15

Contexte WebGL (perte de)
: Réinitialisation de la carte graphique par le navigateur ou le pilote : les textures disparaissent. Le viewer recharge la vue avec un budget mémoire réduit. → chapitre 19

Coupe optique, plan focal
: Image d'une tranche mince du spécimen, nette à une profondeur donnée. L'épaisseur de coupe est la distance entre deux plans (3,0 µm dans le jeu de démonstration). → chapitre 4

CSP (politique de sécurité du contenu)
: Règle donnée au navigateur : n'exécuter que les scripts portant un code à usage unique (nonce) et provenant du site lui-même. → chapitre 19

CSRF (jeton anti-falsification)
: Attaque où un site tiers fait envoyer une requête à votre insu, depuis votre session. Un jeton secret, exigé à chaque modification, l'empêche. → chapitre 19

DAPI, Pecam1, Sox2
: Les trois canaux du jeu de démonstration : DAPI colore l'ADN (les noyaux), Pecam1 marque les vaisseaux, Sox2 le tissu neural. → chapitre 4

Déconvolution
: Calcul qui tente de défaire le flou de l'optique pour affiner l'image. Lumen3D ne le fait pas. → chapitre 20

Dilatation
: Opération qui épaissit les zones d'un masque d'un ou plusieurs pixels. → chapitre 5

Échantillon (rendu)
: Valeur lue en un point du volume pendant le lancer de rayons. Un rayon en prend des centaines. → chapitre 9

Ed25519 (signature)
: Méthode de signature numérique : un « sceau de cire » que seul l'éditeur peut apposer et que tout le monde peut vérifier. → chapitre 19

Empreinte (hachage, SHA-256)
: Court code calculé à partir du contenu d'un fichier : si un seul octet change, l'empreinte change. Elle sert à vérifier un téléchargement, un plugin, un morceau d'import. → chapitres 15 et 19

ESS (Empty Space Skipping, saut de l'espace vide)
: Les briques dont tous les voxels valent 0 ne sont ni stockées ni parcourues, ce qui économise octets et calcul. Au format 4 la règle est exacte (un seul voxel non nul suffit à garder la brique) ; avant, un seuil d'occupation de 0,05 % écartait aussi les briques presque vides. → chapitres 7 et 9

Exécutant
: Celui qui fait le travail d'une conversion de données : le navigateur ou le serveur. Il peut changer en cours de route, le journal est commun. → chapitre 17

Exposition
: Réglage de luminosité globale appliqué à l'affichage ; il n'altère pas les données. → chapitre 11

Fenêtrage
: Choix des valeurs min et max affichées : en dessous, noir ; au-dessus, pleine intensité. → chapitre 11

Filtre médian
: Remplace chaque valeur par la médiane de ses voisines : il supprime les points isolés sans brouiller les contours. → chapitre 5

Finalisation
: Dernière étape d'une conversion de données : les nouveaux fichiers remplacent les anciens d'un seul geste, puis le numéro de format est mis à jour. → chapitre 17

Fluorophore
: Molécule qui absorbe de la lumière et en réémet d'une autre couleur ; c'est lui qui marque une structure dans l'échantillon. Un canal correspond à un fluorophore. → chapitre 4

Fonction de transfert
: Règle qui convertit une valeur du volume en couleur et en opacité. Dans Lumen3D, c'est la chaîne fenêtre, gamma, opacité et couleur du panneau des canaux ; le chapitre 11 la décrit sans employer ce terme. → chapitre 11

Format de données
: Façon dont un dataset est rangé sur le disque ; numéroté de 1 à 4. Le format courant est le 4. → chapitres 7 et 17

Gamma
: Réglage qui éclaircit ou assombrit les tons moyens sans toucher aux extrêmes. → chapitre 11

GPU
: Processeur de la carte graphique, spécialisé dans le calcul parallèle ; il exécute le lancer de rayons. → chapitre 9

HDF5
: Format de fichier scientifique qui range de gros tableaux de nombres, comme un classeur à tiroirs. Les fichiers Imaris en sont un. → chapitre 4

Histogramme
: Graphique qui compte combien de voxels ont chaque valeur d'intensité ; il aide à régler min et max. → chapitre 11

i18n (internationalisation)
: Mécanisme qui permet d'afficher l'interface en plusieurs langues (anglais, français, espagnol, néerlandais…) et d'en ajouter. → chapitre 16

Idempotent
: Se dit d'une opération qu'on peut refaire sans dégât : le résultat est le même qu'une seule fois. C'est ce qui rend les reprises sûres. → chapitre 17

.ims
: Fichier Imaris : un conteneur HDF5 qui contient les canaux, les niveaux de résolution et les métadonnées d'une acquisition. → chapitre 4

index.bin
: Fichier binaire du format 4 qui dit dans quel pack se trouve chaque brique ; il remplace le gros manifeste JSON. → chapitre 7

Intensité
: Valeur d'un voxel : combien de lumière a été mesurée à cet endroit. Dans le viewer elle est relative (0 à 255), pas calibrée. → chapitres 4 et 11

Interpolation trilinéaire
: Estimation d'une valeur entre voxels en mélangeant les huit voisins, ce qui donne une image lisse. → chapitre 9

Jeton
: Petit code qui prouve un droit : jeton anti-falsification (CSRF) d'une modification, ou « seau à jetons » qui limite le nombre de requêtes admises par seconde. → chapitre 19

Jour embryonnaire (E8.5)
: Âge d'un embryon de souris : E8.5 signifie huit jours et demi après la fécondation. La plateforme lit le stade dans le nom du fichier (E8-5 vaut E8.5). → chapitre 8

Journal
: Fichier tenu à jour pendant une opération longue (import, conversion) : il note ce qui est fait, ce qui permet de reprendre après une coupure. → chapitre 17

Kabsch (algorithme)
: Méthode qui trouve la rotation et le décalage alignant au mieux deux nuages de points ; utilisée pour stabiliser un timelapse. → chapitre 8

Lancer de rayons (ray marching)
: Pour chaque pixel de l'écran, on suit un rayon à travers le volume en cumulant couleur et opacité. → chapitre 9

Lignée, mitose, fusion
: Dans un suivi cellulaire : la lignée est la suite d'une cellule et de ses descendantes ; la mitose est une division en deux cellules ; la fusion réunit deux cellules en une. → chapitre 12

LOD (niveau de détail) / niveau
: Version du volume à une résolution donnée ; le niveau 0 est le plus fin. → chapitre 6

LOD0
: Le niveau de détail le plus fin : la résolution native de l'acquisition. → chapitre 6

Lot (de briques)
: Ensemble de briques demandées ensemble au chargeur, qui gère son annulation et rend un bilan (livrées, échouées, écartées). → chapitre 10

Manifeste
: Fichier qui décrit le contenu d'un dataset (niveaux, briques, packs). → chapitre 7

Marque blanche
: Capacité de la plateforme à prendre le nom, les couleurs, les textes et les types de données de l'institution qui l'héberge, sans écrire de code. → chapitre 16

Masque
: Image en noir et blanc qui dit quels pixels comptent (blanc) et lesquels sont écartés (noir). → chapitre 5

Migration
: Mise à jour d'un dataset déjà publié vers un format plus récent, sans repasser par le pipeline. → chapitre 17

MIP (projection d'intensité maximale)
: Image où chaque pixel prend la valeur la plus forte rencontrée le long d'un axe. → chapitres 7 et 12

Mosaïque
: Plusieurs petites images collées en une grande ; une brique est stockée comme une mosaïque de ses coupes. → chapitre 7

Nonce
: Code aléatoire à usage unique, tiré à chaque chargement de page, qui autorise les scripts du site. → chapitre 19

Opacité
: Facteur appliqué à l'intensité d'un canal : 0 le rend invisible, 1 le laisse à pleine intensité. Ce n'est pas l'absorption physique du tissu, qui n'existe (constante) que dans le mode Fluorescence naturelle. → chapitre 11

Ouverture morphologique
: Érosion suivie d'une dilatation : elle efface les petits points isolés d'un masque et garde les grandes formes. → chapitre 5

Pack
: Fichier `.bin` qui regroupe de nombreuses briques pour limiter le nombre de téléchargements. → chapitre 7

Palier (tier)
: Groupe de priorité d'un import : les fichiers qui rendent un jeu ouvrable (métadonnées, niveau le plus grossier) partent d'abord. → chapitre 17

PBKDF2
: Méthode qui transforme un mot de passe en empreinte volontairement lente à calculer (600 000 tours), pour décourager les essais en masse. → chapitre 19

Percentile
: Valeur sous laquelle se trouve un pourcentage donné des mesures : le 99e percentile est dépassé par 1 % des valeurs. → chapitre 5

Photoblanchiment
: Perte progressive de fluorescence d'un échantillon éclairé longtemps. Dans une série temporelle, le signal baisse alors sans que la structure change. → chapitre 5

Pile Z (Z-stack)
: L'ensemble des plans successifs d'un volume, empilés selon l'axe Z. → chapitre 12

Pivot
: Moment de la mise à jour où un superviseur remplace l'ancien dossier du site par le nouveau, relance le serveur et vérifie qu'il répond ; sinon il revient en arrière. → chapitre 18

Pixel
: Plus petit élément d'une image 2D. → chapitre 4

Plans
: Dossier `planes/` du format 2 : un fichier par plan z du niveau natif, pour lire une coupe XY sans charger 64 plans. → chapitre 7 (et 17)

Plugin
: Outil optionnel qui s'ajoute au viewer (mesure, capture, filtre…) ; il est installé depuis le catalogue signé. → chapitres 12 et 15

PNG
: Format d'image sans perte ; les plans du format 2 sont des tuiles PNG de 512×512. → chapitre 7 (et 17)

Profondeur de bits
: Nombre de bits par valeur : 8 bits donnent 256 niveaux, 16 bits en donnent 65 536. → chapitre 4

PSF (fonction d'étalement du point)
: Forme floue que l'optique donne d'un point lumineux. La déconvolution cherche à la défaire ; Lumen3D ne la corrige pas. → chapitre 20

Pyramide
: Ensemble de versions du volume à des résolutions de plus en plus grossières, empilées comme les étages d'une pyramide. → chapitre 6

Quaternion
: Quatre nombres qui décrivent une rotation 3D sans blocage ; ils servent à mémoriser l'orientation d'un embryon. → chapitre 12

Recalage (registration)
: Alignement des images successives d'un timelapse pour compenser le déplacement de l'embryon (algorithme de Kabsch). → chapitre 8

Retour arrière (rollback)
: Retour automatique à l'ancienne version quand la nouvelle ne démarre pas. Le serveur Python le fait ; l'hébergement PHP, non. → chapitres 18 et 19

Saturation
: Valeur qui dépasse le maximum représentable et est écrêtée. Le pipeline sature volontairement les 0,1 % de voxels les plus brillants (`sig_max`). → chapitre 5

Shader
: Petit programme exécuté par la carte graphique ; celui du viewer fait le lancer de rayons. → chapitre 9

Signature
: Voir Ed25519. → chapitre 19

Sonde de santé
: Petite requête (`/api/health`) qui vérifie que le serveur répond avec la bonne version après une mise à jour. → chapitre 18

Spécimen
: Le nom que l'institution donne à ce qu'elle observe (embryon, organe…) ; il change dans toutes les interfaces. → chapitre 16

SRI (intégrité des sous-ressources)
: Empreinte attendue d'un script ou d'une feuille de style, inscrite dans la page : si le fichier chargé diffère, le navigateur le refuse. → chapitre 19

Staging
: Zone privée où arrivent les fichiers importés avant publication ; elle n'est jamais accessible par URL. → chapitres 17 et 19

Stéréomicroscope
: Microscope à faible grossissement qui donne une image en couleur de l'embryon entier ; il produit les photographies du type 2D. → chapitre 12

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

Unité (de conversion)
: Morceau de travail d'une conversion de données : une couche de 64 plans, d'un canal, pour une tuile de 512×512. → chapitre 17

Voxel
: Pixel en 3D : un petit cube de valeur d'intensité. Sa taille réelle (en µm) est la calibration. → chapitre 4

VRAM
: Mémoire de la carte graphique. Son budget limite la taille d'atlas que le viewer peut utiliser. → chapitre 10

WebGL2
: Technologie du navigateur qui donne accès à la carte graphique, notamment aux textures 3D. → chapitre 9

WebP sans perte
: Format d'image compressé qui restitue exactement les valeurs d'origine ; il stocke les mosaïques de briques. → chapitre 6

Widget
: Bloc de contenu d'une page construite dans l'éditeur (texte, image, bouton…), rangé dans une colonne d'une section. → chapitre 16

Worker (Web Worker)
: Processus d'arrière-plan du navigateur : il décode et calcule sans geler l'écran. → chapitre 10

X-gal
: Coloration qui rend bleues les cellules exprimant un gène rapporteur ; le viewer 2D sait isoler cette coloration. → chapitre 12
:::
