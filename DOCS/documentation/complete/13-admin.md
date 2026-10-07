# 13. Le panneau d'administration en bref

::: chapter-intro
- Le panneau d'administration est la **salle des machines** de Lumen3D : c'est là que l'on met des données en ligne, que l'on règle l'apparence du site et que l'on met la plateforme à jour.
- Il compte **15 onglets en 4 groupes**. Vous n'en utiliserez que quelques-uns au quotidien.
- Ce chapitre est un **survol**. Le mode d'emploi pas à pas est le « **Guide de l'administrateur** », publié dans l'onglet [Documentation]{.ui} du panneau lui-même.
:::

## 13.1 À quoi sert le panneau, et comment y accéder

Le site public est la vitrine : les visiteurs regardent des embryons. Le panneau d'administration est l'**arrière-boutique**. Il sert à :

- **mettre des datasets en ligne** et les décrire (nom, stade, couleurs, orientation) ;
- **choisir ce que le public voit** (visible ou masqué) ;
- **personnaliser le site** : nom, couleurs, pages, mentions légales ;
- **installer des plugins** et **mettre la plateforme à jour**.

::: note
Le panneau n'a **aucun lien public**. On l'ouvre en tapant l'adresse `admpan.html` à la suite de celle du site (par exemple `https://votre-site/admpan.html`). Il demande un identifiant et un mot de passe. Le mot de passe est créé lors de la toute première visite, grâce à un assistant en 5 étapes (compte, identité, thème, textes, plugins).
:::

## 13.2 Les 15 onglets, en 4 groupes

La barre latérale de gauche range les onglets en quatre groupes. Le fil d'Ariane en haut rappelle où vous êtes (par exemple [Données › Datasets]{.ui}).

| Onglet | Ce qu'il fait | Fréquence |
|---|---|---|
| **Données** | | |
| [Datasets]{.ui} | Liste, aperçu, réglages | souvent |
| [Import]{.ui} | Envoyer un dossier du pipeline | à chaque nouveau dataset |
| [Mises à jour des données]{.ui} | Remettre au format 4 | rarement |
| [Types de données]{.ui} | Renommer 3D, 2D, Live | une fois |
| [Statistiques]{.ui} | Visites, vues, téléchargements | à l'occasion |
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
![Barre latérale du panneau (jeu de démonstration).](img/ch13/admin-overview.png){.shot width=100%}
:::
::: col
- [1]{.callout-num} Groupe [Données]{.ui} : les jeux de données
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
Une pastille orange « Modifications non sauvegardées » s'allume en haut dès qu'un onglet contient des changements pas encore enregistrés. <kbd>Ctrl</kbd>+<kbd>S</kbd> enregistre l'onglet visible (Datasets, Types de données, Identité, Apparence, Mentions légales).
:::


## 13.4 Mettre un dataset en ligne

Le pipeline (chapitres 4 à 8) produit **un dossier**. Il y a deux façons de le déposer sur le serveur.

![Deux chemins pour mettre un dataset en ligne.](img/ch13/flux-dataset.svg){width=100%}

::: example
**Voie A** : vous copiez le dossier dans `DATA_WEB/3d/` par FTP. Le dataset apparaît tout de suite : le catalogue est recalculé à chaque requête à partir des fichiers `metadata.json`, il n'y a rien à régénérer.
:::

### L'onglet Import, pas à pas

![L'onglet Import, avec un envoi en cours (jeu de démonstration).](img/ch13/admin-import.png){.shot width=66%}

[1]{.callout-num} Zone de dépôt : glissez le dossier ou cliquez sur [Choisir un dossier]{.ui} · [2]{.callout-num} Rappel : transit par un dossier privé, seuls les fichiers attendus sont acceptés · [3]{.callout-num} Progression globale : pourcentage, volume transféré, vitesse, temps restant · [4]{.callout-num} État du dataset (voir ci-dessous) · [5]{.callout-num} Boutons de la carte : [Éditer]{.ui}, [Vérifier]{.ui}, [Publier]{.ui}, [Supprimer]{.ui} selon l'état

Les états d'un dataset en cours d'import :

| État affiché | Ce que cela veut dire |
|---|---|
| [Envoi — non éditable]{.pill .amber} | les fichiers indispensables à l'ouverture ne sont pas tous là |
| [Envoi — éditable]{.pill .blue} | ouvrable en basse résolution : renommez, réglez les canaux pendant que le reste arrive |
| [Envoyé — à publier]{.pill .green} | transfert complet et vérifié ; il reste à publier |
| [Interrompu]{.pill .grey} | reglissez le même dossier pour reprendre ; sans reprise, purge au bout de 7 jours |

::: analogy
**Un déménagement par camion-navette.** Le dossier part en petits cartons numérotés (blocs de 8 Mio) vers un entrepôt privé. Si le camion tombe en panne, on repart au dernier carton livré. Les cartons les plus utiles (fiche, plan, vue grossière) partent en premier : on peut commencer à décorer avant que tout soit arrivé.
:::

::: warning
Un dataset publié par l'Import est **masqué par défaut**. Allez dans [Datasets]{.ui} puis activez l'œil (ou l'interrupteur [Visibilité]{.ui}) pour le montrer au public.
:::


## 13.5 Éditer un dataset

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

## 13.6 Mises à jour des données

La façon dont les datasets sont stockés a évolué quatre fois (**formats 1 à 4**, voir chapitre 7). Un ancien dataset reste lisible, mais il peut être **mis au format actuel sans repasser par le pipeline**, comme on met à jour un logiciel.

![Les trois mises à jour, les deux exécutants, le test de vitesse.](img/ch13/migrations.svg){width=100%}

Les trois étapes ajoutent : `planes/` (un fichier par plan, coupes XY natives rapides dans le Studio), `mips/` (projection max de chaque couche de 64 plans, figures z-stack rapides), puis une pyramide de briques v3 (66³, bordure d'un voxel, `index.bin`).

::: why
Le niveau natif est conservé voxel pour voxel : rien n'est perdu. L'ancien arbre `bricks/` n'est supprimé qu'après le changement de version du dataset. Un dataset produit par le pipeline 0.21.0 est **déjà** au format 4 : il n'y a rien à faire.
:::

![L'onglet Mises à jour des données (jeu de démonstration, avant lancement).](img/ch13/admin-dataset-updates.png){.shot width=66%}

[1]{.callout-num} [2]{.callout-num} Test de vitesse : [Lancer le test (5 s)]{.ui} compare navigateur et serveur · [3]{.callout-num} Choix de l'exécutant, dataset par dataset (verrouillé pendant l'exécution) · [4]{.callout-num} [Mettre à jour]{.ui} ce dataset · [5]{.callout-num} [Tout mettre à jour]{.ui} : traite tous les datasets prêts

::: warning
**Gardez l'onglet ouvert** pendant une mise à jour. Le quitter la met en pause ; rien n'est perdu, vous reprenez plus tard. N'ouvrez pas plusieurs onglets à la fois : un hébergeur a déjà bloqué l'adresse d'un opérateur qui lançait trop de requêtes. Le régulateur réseau de l'onglet limite le débit pour éviter cela.
:::

Ces mises à jour ne sont **pas obligatoires** : le viewer lit les formats 1 à 4. Elles accélèrent certaines opérations du Studio et améliorent l'affichage.

## 13.7 Plugins et catalogue signé

Les plugins sont les outils du viewer (chapitre 12). Ils **ne sont pas livrés avec la plateforme** : on les installe à la demande depuis le [Catalogue]{.ui}, comme dans une boutique d'applications.

- Le catalogue est **signé** : un plugin non vérifié n'est jamais installé (chapitre 14).
- L'installation demande votre **mot de passe**, puis le plugin est installé et approuvé.
- L'onglet [Plugins]{.ui} affiche trois cartes (Outils, Canaux, Modes de rendu) : un interrupteur par plugin et une étiquette de confiance (`intégré`, `approuvé`, `sandbox`, `non fiable`…).
- Certains plugins n'apparaissent pas dans l'aperçu de l'onglet Datasets, ni dans la page Comparer : ils ne se déclarent compatibles qu'avec la page complète. Ce n'est pas une panne.


## 13.8 Mettre à jour la plateforme

Depuis [Système › Mises à jour]{.ui}, un bouton lance la mise à jour. Ce qui se passe derrière a été pensé pour qu'**un site ne reste jamais cassé**.

![La bascule de mise à jour et son filet de sécurité.](img/ch13/mise-a-jour-plateforme.svg){width=100%}

::: analogy
**Le déménagement bleu-vert.** On monte le nouvel appartement à côté de l'ancien, on vérifie que l'eau et l'électricité marchent, et seulement alors on y emménage. Si quelque chose cloche, on retourne dans l'ancien, resté intact.
:::

- L'onglet affiche les **notes de version** de chaque version qui sera installée, et vérifie vos plugins avant : ceux qui seraient incompatibles sont mis de côté, puis réactivés plus tard.
- Il montre aussi la version du **pack Pipeline** (onglet [Pipeline]{.ui}) : c'est un autre logiciel, qui s'installe sur le poste de traitement, pas sur le serveur.

## 13.9 Personnaliser le site (marque blanche)

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

::: see
Pour le détail de chaque écran, des messages d'erreur et des cas particuliers, consultez le « **Guide de l'administrateur** » (onglet [Documentation]{.ui}). Pour la sécurité du panneau, voir le chapitre 14.
:::
