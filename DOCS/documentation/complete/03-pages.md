# 3. Le tour des pages

::: chapter-intro
- Le site public compte quatre grandes pages : **Accueil**, **Explorateur**, **Viewer** (3D et Live) et **Comparer**, plus la page **2D** et les pages **À propos** / **Mentions légales**.
- On passe de l'une à l'autre par la barre du haut ou par les boutons des fiches ; **l'adresse (URL)** d'une page retient quel jeu de données est ouvert, et même votre vue.
- Chaque section ci-dessous montre une vraie capture d'écran (jeu de démonstration) avec des repères numérotés.
:::

## 3.1 La carte des pages

![Les pages publiques et leurs liens. Les flèches pleines sont des clics ; les pointillés, des liens directs.](img/ch03/carte-navigation.svg){width=95%}

Toutes les pages publiques partagent la même barre du haut : le logo, les quatre liens, puis trois boutons à droite : **langue**, **filtre pour daltoniens** et **thème clair/sombre**.

::: note
Les captures de ce document sont en français et en thème sombre. Le nom du site (« IRIBHM — ULB »), les couleurs et même les textes de l'accueil sont ceux de l'instance photographiée : une autre institution peut les avoir changés (chapitre 13).
:::

## 3.2 L'Accueil {.page}

C'est la vitrine : un message d'accueil, quelques chiffres et trois cartes, une par type de données.

![Page d'accueil (index.html).](img/ch03/accueil.png){.shot width=88%}

::: legend
| n | ce que c'est |
|--|----------------------|
| 1 | La barre de navigation : Accueil, Explorateur, Comparer, À propos. |
| 2 | Le titre : « Explorez les embryons ». Le mot « embryons » vient d'un réglage de l'instance. |
| 3 | [Explorer les données]{.ui} ouvre l'Explorateur ; [En savoir plus]{.ui} ouvre À propos. |
| 4 | Les compteurs : jeux de données, embryons, cellules suivies, régions. Ils se calculent sur le catalogue publié. |
| 5 | Les cartes de types : un clic ouvre l'Explorateur déjà filtré (`explorer.html?type=3d`). |
:::

En dessous, la section [Jeux de données en vedette]{.ui} met en avant trois jeux choisis automatiquement (le suivi le plus riche, le volume le plus profond…). L'administrateur peut remplacer toute l'accueil par une page de son cru.

## 3.3 L'Explorateur {.page}

L'Explorateur liste les jeux publiés. Les jeux **masqués** n'y figurent pas.

![Explorateur de données (explorer.html).](img/ch03/explorateur.png){.shot width=95%}

::: legend
| n | ce que c'est |
|--|----------------------|
| 1 | La recherche : elle cherche dans le nom, la description, les noms de canaux, le stade et l'embryon. |
| 2 | Le filtre [Type de données]{.ui} : 3D, Live ou 2D. |
| 3 | Le filtre [Stade]{.ui} : une case par stade présent (E8, E8.5, E9…). [Effacer les filtres]{.ui} remet tout à zéro. |
| 4 | Le tri (Nom, Date, Stade) et le choix grille / liste ; à côté, le nombre de résultats. |
| 5 | Une fiche : miniature, type, pastilles, nom, description, stade et date. |
:::

Sur chaque fiche, trois actions :

- [Voir]{.ui} ouvre le viewer (ou la page 2D pour une photographie) ;
- [Comparer]{.ui} ajoute le jeu à la page Comparer ;
- [Télécharger]{.ui} ouvre le centre de téléchargement du jeu (originaux et exports, quand l'administrateur les a joints).

::: tip
Les pastilles de la fiche en disent long : **Web** (affichable), **Brut** (fichier d'origine à télécharger), **Suivi** (cellules suivies), **Lié** (d'autres jeux sont rattachés, par exemple une photographie du même embryon).
:::

## 3.4 Le viewer 3D {.page}

C'est le cœur de la plateforme. Ouvrez un jeu 3D : le volume apparaît d'abord flou puis s'affine.

![Le viewer sur un jeu 3D (viewer.html?id=3d/…).](img/ch03/viewer-3d.png){.shot width=100%}

::: legend
| n | ce que c'est |
|--|----------------------|
| 1 | Groupe **Outils** : [Naviguer]{.ui} (par défaut), [Couper à travers le volume]{.ui}, [Mesurer la distance]{.ui}. |
| 2 | Groupe **Exporter** : [Centre de téléchargement]{.ui}, [Capture d'ecran]{.ui}. |
| 3 | Groupe **Visuels** : grille, axes, axes d'orientation, masquer le volume, débogage des briques. |
| 4 | Groupe **Dispositions** : [Mode présentation]{.ui}, [Décomposer par canal]{.ui}, [Explorateur Z-Stack]{.ui}. |
| 5 | Panneau [Canaux]{.ui} : une ligne par canal (case, couleur, histogramme réglable). |
| 6 | [Qualité de Rendu]{.ui} : 512, 1024 ou natif. Le texte dessous donne la qualité réellement active. |
| 7 | Quatre boutons sur le volume : centrer l'échantillon, réinitialiser la vue, exporter la vue en PNG, réinitialiser l'espace de travail. |
:::

**Bouger** : glisser = tourner ; <kbd>Maj</kbd> + glisser (ou bouton droit) = déplacer ; molette = zoomer ; deux doigts = déplacer et pincer.

Sous les canaux, le panneau [Affichage]{.ui} règle le [Mode de rendu]{.ui} (par défaut « Fluorescence »), la [Visibilité (exposition)]{.ui} et l'[Arrière-plan]{.ui}. Plus bas, [Détail au zoom]{.ui} charge des briques plus fines quand vous zoomez, et [Échelle Physique]{.ui} étire l'affichage en Z.

::: note
Les boutons dépendent des **plugins installés** sur votre instance. Chapitre 12 : chaque outil ; chapitre 11 : couleurs et histogrammes.
:::

::: tip
**Partager votre vue.** L'adresse du navigateur se termine bientôt par `#state=…` : elle contient caméra, canaux, outil actif et mesures. Copiez-la, la personne qui l'ouvre peut [Ouvrir la vue enregistrée]{.ui}.
:::

## 3.5 Le viewer Live : la ligne de temps

Un jeu Live s'ouvre dans la même page. Deux choses s'ajoutent : la **ligne de temps** en bas, et, s'il a été suivi, la couche [Points de suivi]{.ui} dans le panneau des canaux.

![Le viewer sur un jeu Live (jeu de démonstration à 4 instants, 50 cellules suivies). Le menu des outils est ouvert.](img/ch03/viewer-live.png){.shot width=100%}

::: legend
| n | ce que c'est |
|--|----------------------|
| 1 | Le menu des outils. Quand le titre est long ou la fenêtre étroite, les groupes se replient derrière le bouton ☰. Ici apparaissent aussi les outils de suivi : [Inspecter une cellule]{.ui}, [Distance entre cellules]{.ui}, [Graphiques de suivi]{.ui}, trajectoires, surface. |
| 2 | La couche [Points de suivi]{.ui} : taille et opacité des sphères, mitoses, fusions, couleur par région. |
| 3 | Lecture / pause et vitesse (en images par seconde ; chaque clic change de vitesse). |
| 4 | Le compteur : instant actuel / dernier instant (numérotés à partir de 0). |
| 5 | Le curseur de temps ; la bande claire indique les instants déjà en mémoire. |
:::

::: note
Sur ce petit jeu, la lecture est instantanée. Sur un vrai time-lapse, la lecture **attend** que l'instant demandé soit chargé : vous voyez des images terminées, à la vitesse où elles arrivent (chapitre 10).
:::

## 3.6 La page 2D {.page}

Une photographie de stéréomicroscope, calibrée en micromètres. Pas de canaux ni de 3D : on déplace, on zoome, on mesure.

![La page 2D (2d.html?id=2d/…).](img/ch03/page-2d.png){.shot width=100%}

::: legend
| n | ce que c'est |
|--|----------------------|
| 1 | La barre d'outils : Naviguer, Mesurer ; Studio, téléchargement, planche, capture ; ajuster, résolution native 1:1, isoler le marquage ; navigation dans la collection. |
| 2 | La fiche du [Spécimen]{.ui} : stade, lignée, coloration, dissection, zoom, taille de pixel, champ. |
| 3 | La section [Mesures]{.ui} : cliquer deux points donne une distance en µm. |
| 4 | La barre d'échelle (ici 200 µm), qui suit le zoom. |
| 5 | Le zoom affiché, et la taille d'un pixel d'écran en µm. |
:::

- Molette = zoom, glisser = déplacer, double-clic = ajuster à l'écran.
- [Parcourir la collection]{.ui} ouvre une planche-contact de toutes les photographies ; ← et → passent à la suivante.
- La page affiche d'abord un aperçu léger, puis la résolution native dès qu'elle est prête.

## 3.7 Comparer {.page}

Jusqu'à **quatre panneaux** côte à côte. Chaque panneau est un **vrai viewer** (ou une vraie page 2D) intégré : tout ce que vous savez faire dans le viewer, vous le faites ici, et on peut mélanger volumes et photographies.

![Comparer trois embryons (E8.5, E9.5, E10.5 : jeu de démonstration).](img/ch03/comparer.png){.shot width=100%}

::: legend
| n | ce que c'est |
|--|----------------------|
| 1 | [Ajouter un jeu de données]{.ui} : ouvre une fenêtre de choix avec recherche et filtres par type. |
| 2 | Les outils communs (Naviguer, Couper, Mesurer…) : un clic s'applique à tous les panneaux. |
| 3 | [Studio]{.ui} (une figure composée de tous les panneaux), [Exporter]{.ui}, [Sauvegarder]{.ui} et [Restaurer]{.ui} l'espace de travail. |
| 4 | [Disposition Auto]{.ui} (colonnes, lignes, grille) et [Qualité auto]{.ui}. |
| 5 | **SYNC** : ce qui est synchronisé entre panneaux, [Plan Z]{.ui}, [Temps]{.ui}, [Caméra / vue]{.ui}, [Canaux]{.ui}. Tout est coché par défaut. |
| 6 | Les boutons propres à un panneau (grille, axes, orientation, volume, Z-stack), son réglage et sa fermeture. |
| 7 | Le nom du jeu du panneau. |
:::

- **Caméra / vue** coché : tourner un embryon fait tourner les autres, même calibrés différemment. Pour des time-lapses de longueurs différentes, on synchronise la **fraction** du temps écoulé.
- **Qualité auto** : les panneaux s'ouvrent à 512, puis montent un par un (jusqu'à 1024 pour deux volumes, 512 au-delà) pour tenir dans une mémoire graphique commune.
- Un seul volume à plusieurs canaux ? Le bouton [Décomposer]{.ui} le clone en un panneau par canal.
- L'adresse de la page (`#state=…`) retient les panneaux et leur disposition : copiez-la pour partager la comparaison.


## 3.8 À propos et Mentions légales

**À propos** présente le projet. Son contenu par défaut est une page modifiable par l'administrateur (éditeur de pages, chapitre 13). **Mentions légales** affiche le texte juridique saisi dans l'onglet [Mentions légales]{.ui} ; le lien du pied de page n'apparaît que s'il est activé.

![La page À propos.](img/ch03/a-propos.png){.shot width=80%}

::: note
Sur une installation neuve, les mentions légales sont un modèle à compléter (nom de l'organisation, adresse, hébergeur) : ce sont des champs entre crochets que l'administrateur remplit.
:::

D'autres pages peuvent exister : l'administrateur peut créer des **pages personnalisées**, ouvertes par `page.html?slug=<nom>` et ajoutées à la barre du haut.

## 3.9 L'administration : un aperçu

L'administration vit dans `admpan.html` et demande un mot de passe. Elle n'est pas dans la barre publique. Voici seulement son allure ; le détail est au chapitre 13.

![Le panneau d'administration, onglet Datasets.](img/ch03/admin-apercu.png){.shot width=88%}

::: legend
| n | ce que c'est |
|--|----------------------|
| 1 | Le menu : quatre familles, **Données**, **Site public**, **Extensions**, **Système**. |
| 2 | La liste des jeux (publiés, masqués, en cours d'import) avec recherche et filtres. |
| 3 | La zone d'aperçu du jeu choisi : le viewer y est affiché tel que le verront les visiteurs. |
| 4 | Le thème, la langue et la déconnexion. |
:::

## 3.10 Les adresses à connaître

Une adresse (URL) peut tout dire d'une page. Les plus utiles :

| Adresse | Effet |
|---|---|
| `viewer.html?id=3d/<dossier>` | ouvre un volume 3D (même forme pour `live/…`) |
| `2d.html?id=2d/<dossier>` | ouvre une photographie |
| `explorer.html?type=3d` | Explorateur déjà filtré (`3d`, `live` ou `2d`) |
| `compare.html?add=<id>&add=<id>` | Comparer avec ces jeux déjà posés (4 au plus) |
| `…#state=…` | la vue exacte (caméra, canaux, outils, mesures) : à copier pour partager |
| `page.html?slug=<nom>` | une page personnalisée |

::: warning
Les paramètres `hideHeader` et `panelIndex` servent à la page Comparer pour intégrer des pages sans leur en-tête ; ne les utilisez pas pour un usage normal.
:::

::: tip
**Raccourcis clavier** (viewer) : <kbd>V</kbd> ou <kbd>Échap</kbd> Naviguer ; <kbd>C</kbd> couper ; <kbd>M</kbd> mesurer ; <kbd>I</kbd> inspecter une cellule ; <kbd>D</kbd> distance entre cellules. Page 2D : <kbd>F</kbd> ajuster, <kbd>B</kbd> planche, ← → photographie précédente / suivante.
:::
