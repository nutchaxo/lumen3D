# 14. Le panneau d'administration en bref

::: chapter-intro
- Le panneau d'administration est la **salle des machines** de Lumen3D : c'est là que l'on met des données en ligne, que l'on vérifie leur état, que l'on règle l'apparence du site et que l'on met la plateforme à jour.
- Il compte **17 onglets en 4 groupes**. Vous n'en utiliserez que quelques-uns au quotidien.
- Ce chapitre est un **survol**. Le mode d'emploi pas à pas est le « **Guide de l'administrateur** », publié dans l'onglet [Documentation]{.ui} du panneau lui-même.
:::

## 14.1 À quoi sert le panneau, et comment y accéder

Le site public est la vitrine : les visiteurs regardent des embryons. Le panneau d'administration est l'**arrière-boutique**. Il sert à :

- **mettre des datasets en ligne** et les décrire (nom, stade, couleurs, orientation) ;
- **choisir ce que le public voit** (visible ou masqué) ;
- **personnaliser le site** : nom, couleurs, pages, mentions légales ;
- **installer des plugins** et **mettre la plateforme à jour** ;
- **contrôler** les données (intégrité, espace disque).

::: note
Le panneau n'a **aucun lien public**. On l'ouvre en tapant l'adresse `admpan.html` à la suite de celle du site (par exemple `https://votre-site/admpan.html`). Il demande un identifiant et un mot de passe. Le mot de passe est créé lors de la toute première visite, grâce à un assistant en 5 étapes (compte, identité, thème, textes, plugins).
:::

## 14.2 Les 17 onglets, en 4 groupes

La barre latérale de gauche range les onglets en quatre groupes. Le fil d'Ariane en haut rappelle où vous êtes (par exemple [Données › Datasets]{.ui}).

| Onglet | Ce qu'il fait | Fréquence |
|---|---|---|
| **Données** | | |
| [Datasets]{.ui} | Liste, aperçu, réglages | souvent |
| [Import]{.ui} | Envoyer un dossier du pipeline | à chaque nouveau dataset |
| [Mises à jour des données]{.ui} | Mettre les datasets au dernier format (6) | rarement |
| [Intégrité des données]{.ui} | Vérifier que rien ne manque ni ne traîne | après un import ou une panne |
| [Types de données]{.ui} | Renommer 3D, 2D, Live | une fois |
| [Statistiques]{.ui} | Visites, vues, téléchargements | à l'occasion |
| [Stockage]{.ui} | Ce qui occupe le disque, et ce qui reste libre | à l'occasion |
| **Site public** | | |
| [Identité]{.ui} | Nom, vocabulaire, SEO, menu | à l'installation |
| [Apparence]{.ui} | Couleurs, police, arrondis | à l'installation |
| [Pages]{.ui} | Éditeur visuel de pages | parfois |
| [Mentions légales]{.ui} | Textes légaux, par langue | une fois |
| **Extensions** | | |
| [Plugins]{.ui} | Activer, approuver | parfois |
| [Catalogue]{.ui} | Installer des plugins signés | parfois |
| **Système** | | |
| [Mises à jour]{.ui} | Mettre la plateforme à jour | régulièrement |
| [Pipeline]{.ui} | Télécharger le pack (ch. 4 à 8) | à chaque nouveau pack |
| [Sécurité]{.ui} | Mot de passe, permissions | rarement |
| [Documentation]{.ui} | Lire les guides publiés | à la demande |

:::: cols-wide-right
::: col
![Barre latérale du panneau (jeu de démonstration).](img/ch14/admin-overview.png){.shot width=100%}
:::
::: col
- [1]{.callout-num} Groupe [Données]{.ui} : les jeux de données, leur contrôle et leur stockage
- [2]{.callout-num} Groupe [Site public]{.ui} : apparence et textes vus par les visiteurs
- [3]{.callout-num} Groupe [Extensions]{.ui} : les plugins
- [4]{.callout-num} Groupe [Système]{.ui} : mises à jour, sécurité, documentation
- [5]{.callout-num} Fil d'Ariane : groupe puis onglet courant
- [6]{.callout-num} Lien vers le site public (nouvel onglet)

En haut à droite : thème clair/sombre du panneau, langue (français, anglais, espagnol, néerlandais) et déconnexion.
:::
::::

::: remember
Deux onglets commencent par « Mises à jour » : [Mises à jour des données]{.ui} (groupe Données : remettre **vos datasets** au format actuel) et [Mises à jour]{.ui} (groupe Système : mettre à jour **la plateforme**). Ne les confondez pas.
:::

::: tip
Une pastille orange « Modifications non sauvegardées » s'allume en haut dès qu'un onglet contient des changements pas encore enregistrés. <kbd>Ctrl</kbd>+<kbd>S</kbd> enregistre l'onglet visible parmi cinq : [Datasets]{.ui}, [Types de données]{.ui}, [Identité]{.ui}, [Apparence]{.ui} et [Mentions légales]{.ui}.
:::


## 14.3 Mettre un dataset en ligne

Le pipeline (chapitres 4 à 8) produit **un dossier**. Il y a deux façons de le déposer sur le serveur.

![Deux chemins pour mettre un dataset en ligne.](img/ch14/flux-dataset.svg){width=100%}

::: example
**Voie A** : vous copiez le dossier dans `DATA_WEB/3d/` par FTP. Le dataset apparaît tout de suite : le catalogue est recalculé à chaque requête à partir des fichiers `metadata.json`, il n'y a rien à régénérer.
:::

### L'onglet Import, pas à pas

![L'onglet Import, avant le dépôt d'un dossier.](img/ch14/admin-import.png){.shot width=66%}

[1]{.callout-num} Zone de dépôt : glissez le dossier ou cliquez sur [Choisir un dossier]{.ui} · [2]{.callout-num} Rappel : transit par un dossier privé, seuls les fichiers attendus sont acceptés. Une fois le dossier déposé, l'onglet affiche la progression globale (pourcentage, volume, vitesse, temps restant) et une carte par dataset avec son état et ses boutons [Éditer]{.ui}, [Vérifier]{.ui}, [Publier]{.ui}, [Supprimer]{.ui}.

Les états d'un dataset en cours d'import :

| État affiché | Ce que cela veut dire |
|---|---|
| [Envoi — non éditable]{.pill .amber} | les fichiers indispensables à l'ouverture ne sont pas tous là |
| [Envoi — éditable]{.pill .blue} | ouvrable en basse résolution : renommez, réglez les canaux pendant que le reste arrive |
| [Envoyé — à publier]{.pill .green} | transfert complet et vérifié ; il reste à publier |
| [Interrompu]{.pill .grey} | redéposez le même dossier pour reprendre ; sans reprise, le transfert est purgé au bout de 7 jours |

L'import accepte les arbres au **format 6** (ceux que produit le pipeline 0.23.0, ou l'outil `tools/convert_dataset.py`) comme au format 5. Un fichier qui n'appartient pas au format de l'arbre (une copie de qualité d'un autre format, par exemple) est refusé. Le bouton [Éditer]{.ui} ouvre l'aperçu d'un dataset encore en cours d'import, qui s'affiche comme un dataset publié.

::: analogy
**Un déménagement par camion-navette.** Le dossier part en petits cartons numérotés (blocs de 8 Mio) vers un entrepôt privé. Si le camion tombe en panne, on repart au dernier carton livré. Les cartons les plus utiles (fiche, plan, vue grossière) partent en premier : on peut commencer à décorer avant que tout soit arrivé.
:::

::: warning
Un dataset publié par l'Import est **masqué par défaut**. Allez dans [Datasets]{.ui} puis activez l'œil (ou l'interrupteur [Visibilité]{.ui}) pour le montrer au public.
:::

::: tip
Un dataset qui n'est pas au dernier format, ou dont le transfert est incomplet, se signale dans [Intégrité des données]{.ui} (section 14.9). L'import ne le répare pas à votre place.
:::

## 14.4 Éditer un dataset

Cliquez un dataset dans la liste de l'onglet [Datasets]{.ui} : l'aperçu s'ouvre au centre, les réglages à droite. Voici ce que vous pouvez y régler :

| Section | Ce que vous y décidez |
|---|---|
| [Visibilité]{.ui} | visible ou masqué dans l'explorateur (**appliqué immédiatement**) |
| [Identification]{.ui} | nom d'affichage, stade, embryon, description |
| [Galerie d'images]{.ui} | jusqu'à 40 images (8 Mo max) avec légendes, affichées dans le viewer |
| [Calibration physique]{.ui} | taille du voxel X, Y, Z en µm |
| [Paramètres d'affichage]{.ui} | exposition par défaut |
| [Orientation]{.ui} | sens de l'échantillon, repère de référence, axes affichés, vue par défaut |
| Canaux (dans l'aperçu) | nom, couleur, min, max, gamma de chaque canal |

::: remember
Ce que l'éditeur enregistre est un **réglage** : il est fusionné dans le `metadata.json` du dataset. Le panneau ne touche jamais aux pixels du niveau natif. La position de la caméra, le mode de rendu ou le plan de coupe ne sont pas conservés : ils appartiennent au visiteur.
:::

Le bouton [Redéfinir la preview]{.ui} (sous l'aperçu) fait de la vue actuelle la vignette de l'explorateur. L'orientation 3D (axes, vue par défaut) est expliquée au chapitre 12.

## 14.5 Mises à jour des données

La façon dont les datasets sont stockés a évolué **six fois** (**formats 1 à 6**, voir chapitre 7). Un ancien dataset reste lisible, mais il peut être **mis au format actuel sans repasser par le pipeline**, comme on met à jour un logiciel.

| Étape | Ce qu'elle ajoute |
|---|---|
| 1 → 2 | `planes/` : un fichier par plan, coupes XY natives rapides dans le Studio |
| 2 → 3 | `mips/` : projection max de chaque couche de 64 plans, figures z-stack rapides |
| 3 → 4 | pyramide de briques v3 : 66³ avec une bordure d'un voxel, index binaire |
| 4 → 5 | matrice : niveaux qui gardent toutes les tranches, cinq compressions, copies de coupe |
| 5 → 6 | **une seule qualité d'affichage** : WebP qualité 30 à chaque niveau, et le sans perte gardé à côté |

::: note
Au format 6, chaque niveau est stocké **deux fois** : en WebP qualité 30, ce que vous voyez à l'écran, et sans perte, ce que lisent les exports. Les copies intermédiaires du format 5 disparaissent. Les coupes rapides (plans XY, XZ, YZ et cubes de coupe) restent sans perte.
:::

::: why
Le niveau natif est conservé voxel pour voxel dans la version sans perte : rien de vos mesures n'est perdu. La nouvelle version s'écrit **à côté** de l'ancienne, et l'ancienne n'est retirée qu'une fois la nouvelle complète. Une mise à jour interrompue reprend là où elle s'est arrêtée.
:::

- Un dataset produit par le pipeline **0.23.0** est déjà au format 6 : cette page ne lui propose rien.
- Un dataset au format 4 ou 5 est converti **étape par étape** jusqu'au format 6 (la carte indique « étape 2 sur 3 », par exemple).
- Sur un hébergement PHP, les étapes 4 → 5 et 5 → 6 se font **dans le navigateur** : le serveur PHP n'a pas de convertisseur pour elles.

![L'onglet Mises à jour des données pendant une conversion (capture antérieure à la version 1.73, jeu de démonstration).](../admin-guide/img/dupd-running.png){.shot width=80%}

[1]{.callout-num} [Pause]{.ui} · [2]{.callout-num} Les deux files : ce navigateur et le serveur, chacune avec son dataset en cours · [3]{.callout-num} La carte d'un dataset, avec son chemin de formats et ses étapes · [4]{.callout-num} Choix de l'exécutant, dataset par dataset (verrouillé pendant l'exécution) · [5]{.callout-num} La progression · [6]{.callout-num} Annuler. Le détail est dans le *Guide de l'administrateur*, chapitre 5.

### Ce que vous voyez dans l'onglet

| Élément | Ce qu'il fait |
|---|---|
| [Tout mettre à jour]{.ui} | lance toutes les mises à jour en attente, en file |
| [Test de vitesse]{.ui} | 5 s : les deux exécutants convertissent le même bloc de test (une brique 64³ synthétique) en même temps. Le plus rapide est proposé par défaut (★) |
| [Ce navigateur]{.ui} / [Le serveur]{.ui} | le choix d'exécutant de **chaque** dataset ; deux datasets sur des exécutants différents avancent en même temps |
| [Pause]{.ui} / [Reprendre]{.ui} | arrête ou relance la file, sans rien perdre |
| [Mettre à jour]{.ui}, [Reprendre]{.ui}, [Réessayer]{.ui}, [Réparer]{.ui} | le bouton de la carte selon l'état du dataset |
| [Annuler]{.ui} (croix) | abandonne la progression ; le dataset reste tel quel |
| [Historique]{.ui} | le journal des mises à jour et des redémarrages |

::: tech
- **Progression** : elle commence à 0 %. Une unité sans donnée (par exemple une brique vide) est comptée comme faite et affichée à part : « N sans données, déjà terminées ».
- **Ce navigateur** : jusqu'à **4 workers**, deux seulement si le navigateur annonce moins de 8 Go de mémoire, et jamais plus de la moitié des cœurs du processeur. Chaque worker traite deux unités à la fois.
- **Régulateur réseau** : une seule file de requêtes est partagée par les onglets du même navigateur ; l'onglet ralentit lui-même si l'hébergeur répond lentement ou renvoie une erreur 429 ou 503.
:::

### Quand ça s'arrête, et quand ça repart

Un échec (un worker qui plante, une unité qui échoue encore et encore, un lien perdu) **relance la mise à jour toute seule**, après 10 s, 30 s, 1 min, 2 min, puis 5 min. La reprise part du journal : rien n'est recalculé.

- Elle **s'arrête** après cinq tentatives sans aucune unité terminée entre-temps. Le bouton [Réessayer]{.ui} la relance à la main.
- Elle **ne se relance pas** dans trois cas : une unité que le serveur ne peut pas convertir dans son délai, l'absence d'exécutant capable, une préparation qui échoue. Une session expirée demande de vous reconnecter.

::: warning
**Gardez l'onglet ouvert** pendant une mise à jour. Le quitter la met en pause ; rien n'est perdu, vous reprenez plus tard. Un autre onglet du même navigateur ne peut pas mettre le **même** dataset à jour : il affiche « Dans un autre onglet ». N'ouvrez pas non plus plusieurs onglets pour accélérer : un hébergeur a déjà bloqué l'adresse d'un opérateur qui lançait trop de requêtes.
:::

### Conserver la version précédente

Une case à cocher (replier la liste « Conserver la version précédente ») garde, pour les mises à jour **3 → 4** et **4 → 5**, les anciennes briques à côté des nouvelles. Le viewer peut afficher l'une ou l'autre (outil *Chunk debug*) pour comparer. Cela prend autant de place que les briques de chaque dataset : supprimez-les ensuite depuis la liste [Versions précédentes conservées]{.ui} une fois la comparaison faite.

::: note
Ces mises à jour ne sont **pas obligatoires**. Un ancien dataset reste lisible par le viewer ; la mise à jour améliore l'affichage et accélère certaines opérations du Studio. Les datasets **en cours d'import** n'apparaissent pas ici : leur contrôle est dans [Intégrité des données]{.ui}.
:::

## 14.6 Plugins et catalogue signé

Les plugins sont les outils du viewer (chapitre 12). Ils **ne sont pas livrés avec la plateforme** : on les installe à la demande depuis le [Catalogue]{.ui}, comme dans une boutique d'applications.

- Le catalogue est **signé** : un plugin non vérifié n'est jamais installé (chapitre 19).
- L'installation demande votre **mot de passe**, puis le plugin est installé et approuvé.
- L'onglet [Plugins]{.ui} affiche trois cartes (Outils, Canaux, Modes de rendu) : un interrupteur par plugin et une étiquette de confiance (`intégré`, `approuvé`, `sandbox`, `non fiable`…).
- Certains plugins n'apparaissent pas dans l'aperçu de l'onglet Datasets, ni dans la page Comparer : ils ne se déclarent compatibles qu'avec la page complète. Ce n'est pas une panne.


## 14.7 Mettre à jour la plateforme

Depuis [Système › Mises à jour]{.ui}, un bouton lance la mise à jour. Ce qui se passe derrière a été pensé pour qu'**un site ne reste jamais cassé**.

![La bascule de mise à jour et son filet de sécurité.](img/ch14/mise-a-jour-plateforme.svg){width=100%}

::: analogy
**Le déménagement bleu-vert.** On monte le nouvel appartement à côté de l'ancien, on vérifie que l'eau et l'électricité marchent, et seulement alors on y emménage. Si quelque chose cloche, on retourne dans l'ancien, resté intact.
:::

- L'onglet affiche les **notes de version** de chaque version qui sera installée, et vérifie vos plugins avant : ceux qui seraient incompatibles sont mis de côté, puis réactivés plus tard.

::: warning
Ce filet de sécurité complet (bascule vérifiée par une sonde de santé, **retour automatique** à l'ancienne version) existe sur un serveur **Python**. Sur un hébergement **PHP**, la mise à jour se fait en une seule requête, avec la même vérification d'empreinte SHA-256 et de signature, mais **sans retour automatique** : les fichiers déjà copiés restent en place. → chapitre 18.
:::

- Il montre aussi la version du **pack Pipeline** (onglet [Pipeline]{.ui}) : c'est un autre logiciel, qui s'installe sur le poste de traitement, pas sur le serveur.

## 14.8 Personnaliser le site (marque blanche)

Lumen3D n'est pas lié à un laboratoire : tout ce que le public voit se règle sans écrire de code.

| Onglet | Ce que vous y personnalisez |
|---|---|
| [Identité]{.ui} | nom de l'instance, nom du « spécimen » (embryon, organe…), accroche, pied de page, liens du menu |
| [Apparence]{.ui} | couleur de marque, police, arrondis, avec aperçu en direct |
| [Pages]{.ui} | éditeur visuel : sections, colonnes, widgets ; sauvegarde automatique du brouillon |
| [Mentions légales]{.ui} | sections de texte, une langue à la fois |
| [Types de données]{.ui} | le **nom** donné à « 3d », « 2d » et « live » dans les badges et les filtres |

::: note
Renommer un type de données ne change que le **texte affiché** : jamais les dossiers, les identifiants ni les adresses. Le nom du spécimen et des types s'adapte automatiquement dans tout le site.
:::

## 14.9 Vérifier l'intégrité des données

L'onglet [Intégrité des données]{.ui} contrôle chaque dataset, **publié ou en cours d'import**, sans rien modifier.

::: tldr
- Un contrôle en **lecture seule** : il ne répare rien et n'écrit rien.
- Il dit ce qui **manque**, ce qui **traîne** en trop, et si le dataset est au **dernier format** (6).
- Chaque constat dit comment le corriger, en quatre langues.
:::

### Lancer le contrôle

Rien ne se lance à l'ouverture de l'onglet : cliquez [Lancer le diagnostic]{.ui}. Le bouton devient [Relancer]{.ui} ensuite. Le tableau se remplit au fur et à mesure (deux datasets à la fois) ; le compteur en haut affiche l'avancement.

| Carte | Ce qu'elle compte |
|---|---|
| [Sains]{.ui} | datasets sans constat |
| [Avertissements]{.ui} | datasets à corriger sans urgence : vignette absente, format ancien, fichiers en trop, mise à jour interrompue |
| [Erreurs]{.ui} | datasets dont un élément indispensable manque ou est abîmé (`metadata.json`, manifest, pack, index, image de galerie listée) |

Un dataset est « en erreur » dès qu'un de ses constats est une erreur ; les simples **informations** (par exemple un ancien arbre de briques conservé) ne comptent pas.
| [Dernier format]{.ui} | le numéro du format le plus récent (6) |

Une case [Seulement les datasets avec des constats]{.ui} masque les datasets sains.

### Ce qui est vérifié

| Famille | Exemples de constats |
|---|---|
| Métadonnées | `metadata.json` absent ou illisible ; « type » ou « id » qui ne correspond pas au dossier |
| Images | `thumbnail.webp` absent ; `image.webp` ou `preview.webp` absent (photographies 2D) |
| Briques | manifest absent ; un pack nommé par le manifest est absent ou plus court ; un index ne correspond pas à son empreinte |
| Galerie et suivi | image de galerie listée et absente ; fichier de galerie non listé ; fichier de suivi cellulaire absent |
| Restes | une mise à jour interrompue ; un ancien arbre de briques conservé ; des fichiers que l'import n'accepterait pas |
| Format | pas au dernier format (conversion en attente) ; une structure à réparer |
| Import en cours | fichiers pas entièrement reçus ; fichiers jamais prévus ; un dataset publié du même nom existe déjà |

Un import en cours est jugé avec **la même validation que la publication** : ce que le contrôle signale est donc ce qui bloquerait la publication.

### Lire un constat

- Chaque ligne a un **état** (OK, avertissement, erreur), son type, son format et le nombre de constats.
- [Détails]{.ui} déplie la liste : le message, les fichiers concernés, leur taille, puis une ligne **Pour corriger :**.
- [Revérifier]{.ui} relance le contrôle **de ce seul dataset**, sur place, sans toucher au reste du tableau.

::: tip
Une réparation de format ou de structure se fait dans [Mises à jour des données]{.ui} (section 14.5). Un fichier en trop se supprime en SFTP, ou par une réimportation. Le contrôle ne fait jamais le travail à votre place.
:::

::: warning
Si le contrôle lui-même échoue, la ligne le dit : le code HTTP et le début de la réponse, ou, sur un hébergement PHP, l'erreur fatale (mémoire ou temps dépassés). Revérifier ce dataset seul suffit souvent. Si le message parle de mémoire ou de temps, la limite de PHP doit être relevée par l'hébergeur.
:::

## 14.10 Surveiller le stockage

L'onglet [Stockage]{.ui} répond à une question simple : **où part le disque** ? Ses textes restent en français dans toutes les langues, faute de clés de traduction dans `lang/*.json`.

::: tldr
- Trois chiffres au sommet : capacité totale, occupé, disponible.
- Ce qui est occupé est rangé en **données publiées**, **imports et corbeille**, **plateforme et code**, et le reste du volume.
- Le calcul de l'occupation est gardé **10 minutes** ; le disque libre est lu à chaque ouverture.
:::

### Le volume

| Chiffre | Ce qu'il veut dire |
|---|---|
| Capacité totale | la taille du volume qui héberge l'installation |
| Occupé | ce qui est utilisé, avec sa part de la capacité |
| Disponible | l'espace **libre réel** du volume |

La barre colorée montre la répartition, segment par segment :

| Segment | Ce qu'il regroupe |
|---|---|
| Données publiées | les dossiers `DATA_WEB/` des trois types (3d, 2d, live) |
| Imports & corbeille | les imports en cours, la corbeille, les migrations et les journaux d'import |
| Plateforme & code | le code, les bibliothèques embarquées, la documentation, les journaux du serveur |
| Autres sur le volume | ce que le volume contient d'autre que la plateforme, si le volume est partagé |
| Disponible | l'espace libre |

::: note
« Autres sur le volume » est calculé par soustraction : l'espace utilisé du volume moins ce que la plateforme compte. « Disponible » est l'espace libre réel ; un quota plus strict de l'hébergeur n'y apparaît pas. Les liens durs ne sont comptés qu'une fois, et les liens symboliques ne sont pas suivis.
:::

### Les cartes et la table

| Carte | Contenu |
|---|---|
| Données publiées | une ligne par type (3d, 2d, live) avec son nombre de datasets, puis « Autres fichiers » |
| Imports & corbeille | Imports en cours, Corbeille (60 jours), Migrations de données, Journaux d'import |
| Plateforme & code | Plugins, Bibliothèques embarquées, API serveur, Traductions, Documentation, Pipeline de prétraitement, etc. |
| Par dataset | une ligne par dataset : nom, type, taille, nombre de fichiers, part, puis le détail par dossier |

Dans la table [Par dataset]{.ui}, le détail sort les quatre plus gros dossiers de premier niveau du dataset (par exemple `bricks`, `planes`, `mips`, `download`, `gallery`).

[Recalculer]{.ui} refait l'inventaire tout de suite, au lieu d'attendre les dix minutes. À utiliser après un import ou une suppression.

::: tip
Le plus gros poste est souvent `bricks` (les briques de chaque niveau, dans chaque dataset). La **corbeille** garde un dataset supprimé pendant 60 jours avant de le libérer : son poids reste compté jusque-là.
:::

::: see
- La façon dont un dataset est rangé sur le disque : chapitre 7.
- Les anciennes versions gardées par une mise à jour : section 14.5.
- Les fichiers anormaux qui gonflent un dataset : section 14.9.
:::

::: see
Pour le détail de chaque écran, des messages d'erreur et des cas particuliers, consultez le « **Guide de l'administrateur** » (onglet [Documentation]{.ui}). Pour la sécurité du panneau, voir le chapitre 19.
:::
