# 2. Les technologies : qui fait quoi

::: chapter-intro
- Lumen3D mélange cinq langages et quelques formats de fichiers ; chacun a **un seul métier**, et ce chapitre vous dit lequel.
- Tout ce que le navigateur exécute est **fourni par le site lui-même** (aucun service extérieur) : la plateforme fonctionne hors ligne et reste sous contrôle.
- Le serveur ne calcule jamais l'image 3D : il **distribue des fichiers**. Le dessin se fait chez vous, sur votre carte graphique.
:::

## 2.1 Une page web, c'est un corps humain

Avant les détails, une image pour tout retenir :

:::: cards
::: card
#### HTML : le squelette
Dit ce qu'il y a sur la page : un titre, un bouton, une zone de dessin. Un fichier par page, à la racine du projet.
:::
::: card
#### CSS : les vêtements
Dit à quoi ça ressemble : couleurs, tailles, thème clair ou sombre. 16 feuilles de style.
:::
::: card
#### JavaScript : les muscles
Fait bouger les choses : clic sur un bouton, téléchargement des briques, calcul des mesures.
:::
::::

::: analogy
**Une page web = un corps.** Sans squelette (HTML) rien ne tient ; sans vêtements (CSS) c'est austère ; sans muscles (JavaScript) rien ne bouge. Lumen3D ajoute un quatrième organe : un **œil** très rapide, le shader (section 2.3).
:::

## 2.2 Le client : ce qui tourne dans votre navigateur

Le « client », c'est votre navigateur. Il reçoit les fichiers HTML, CSS et JavaScript, puis fait tout le travail visible.

- **JavaScript « vanilla »** : du JavaScript pur, organisé en petits modules, sans framework. Environ **68 400 lignes**.
- **Web Workers** : des « employés de l'ombre » du navigateur. Ils décodent les images WebP et font les calculs lourds pour que l'écran ne se fige jamais.
- **Bibliothèques** : Three.js (scène 3D), Lucide (icônes), Plotly (graphiques de suivi). Elles sont copiées dans le dossier `js/vendor/`.

![Les langages, par volume de code (la barre « shaders » est comprise dans le JavaScript).](img/ch02/loc-bars.svg){width=92%}

::: why
**Pourquoi du JavaScript sans framework ?** Pas d'étape de fabrication : on modifie un fichier, on recharge la page, c'est tout. Le code reste lisible par quelqu'un qui n'a pas appris un outil de plus, et il n'y a aucune dépendance qui puisse disparaître ou changer d'un mois à l'autre. Seul le panneau d'administration utilise les modules modernes (`import` / `export`).
:::

## 2.3 GLSL : le programme minuscule exécuté des millions de fois

L'image 3D n'est pas une photo : elle est **calculée à chaque image affichée**. Pour chaque pixel de l'écran, on fait traverser le volume à un rayon imaginaire et on cumule la lumière rencontrée (chapitre 9). Cela représente des millions de petits calculs identiques.

La carte graphique est faite pour cela : elle les exécute en parallèle. Le petit programme qu'elle exécute est écrit en **GLSL**, le langage des **shaders**.

::: analogy
**Un shader, c'est une recette donnée à un million de cuisiniers.** Chaque cuisinier prépare un seul pixel, tous en même temps, avec la même recette. Un processeur ordinaire serait un seul cuisinier très rapide : il perdrait la course.
:::

- Environ **1 800 lignes** de GLSL, écrites dans des fichiers JavaScript (le rendu du volume, la coupe oblique, le recolorage des coupes).
- Le navigateur les confie à **WebGL2**, l'interface standard pour parler à la carte graphique.

::: tech
Le volume est stocké dans la carte graphique sous forme de **textures 3D**, découpées en emplacements de 64³ voxels (66³ en format 4). Le shader lit ces emplacements ; ceux qui sont vides sont sautés. Les détails sont aux chapitres 9 et 10.
:::

## 2.4 Le serveur : un guichet, pas un cerveau

Le serveur est un programme qui répond aux demandes du navigateur. Ici, il fait **cinq métiers** :

| Métier | En clair |
|---|---|
| Distribuer des fichiers | pages, scripts, briques ; avec compression et mise en cache |
| Dresser le catalogue | la liste des jeux est **recalculée à chaque requête** en lisant les `metadata.json` |
| API d'administration | connexion, édition des fiches, statistiques |
| Importer | recevoir un dossier par morceaux, le vérifier, le publier |
| Se mettre à jour | télécharger une version signée, la contrôler, basculer, annuler si besoin |

![Les trois acteurs : le navigateur dessine, le serveur tend des fichiers, les données sont de simples fichiers.](img/ch02/architecture.svg){width=100%}

::: example
**Le catalogue n'est pas un fichier.** Vous copiez un dossier de jeu dans `DATA_WEB/3d/` : il apparaît tout de suite dans l'Explorateur. Rien à régénérer, parce que le serveur relit les fiches à chaque demande (il mémorise le résultat tant qu'aucun fichier n'a changé).
:::

### Deux serveurs jumeaux

Le même serveur existe **en deux langages**, avec la même interface vers le navigateur :

:::: cols
::: col
#### Python : `dev_server.py`
- recommandé, port 8080 ;
- bibliothèque standard seulement : rien à installer ;
- c'est lui qui sait se mettre à jour en un bloc, avec retour arrière automatique.
:::
::: col
#### PHP : dossier `api/`
- pour les hébergements classiques d'université ou d'institut, qui offrent PHP mais pas Python ;
- mêmes fichiers, mêmes formats, même mot de passe : un import commencé sous l'un reprend sous l'autre ;
- PHP 8.1 ou plus.
:::
::::

::: tech
Un petit serveur `fast_server.py` ne fait que distribuer des fichiers (sans administration) : il sert aux mesures de performance. Les deux serveurs complets sont maintenus identiques par des tests automatiques qui comparent leurs résultats.
:::

## 2.5 Python : l'établi du laboratoire

Le **pipeline de préparation** est écrit en Python, parce que c'est la boîte à outils de la science : lire un fichier HDF5 (`h5py`), calculer sur de gros tableaux (`numpy`), filtrer (`scipy`), écrire des images (`Pillow`).

::: analogy
**L'établi.** Le pipeline est l'atelier où l'on prépare la pièce, hors de la vitrine. Le visiteur ne le voit jamais : il ne voit que la pièce finie, sur l'étagère (`DATA_WEB/`).
:::

- Il tourne sur l'ordinateur du technicien, **une seule fois par jeu de données**.
- Dépendances figées : `h5py` 3.16.0, `numpy` 2.5.1, `scipy` 1.16.0, `Pillow` 11.1.0, `tqdm` 4.67.1.
- Python 3.10 ou plus. Détail des cinq étapes : chapitres 4 à 8.

## 2.6 Les formats de fichiers : des contenants

Un format est un **contenant** ; ce qui compte, c'est ce qu'on met dedans.

| Format | Image mentale | Rôle dans Lumen3D |
|---|---|---|
| **JSON** | des fiches cartonnées étiquetées | `metadata.json` (fiche d'un jeu), `manifest.json` (l'index des briques), configuration, traductions |
| **WebP sans perte** | une boîte hermétique pour une image | chaque brique ; les pixels sont restitués exactement |
| **PNG** | idem, format plus ancien | les plans entiers du format 2 (coupes rapides) |
| **`.bin` (packs)** | un classeur à anneaux | des centaines de briques mises bout à bout, pour moins de fichiers |
| **HDF5 (`.ims`)** | un **système de fichiers dans un fichier** | le fichier Imaris d'origine : dossiers, tableaux et métadonnées dans un seul bloc |
| **glTF / GLB** | une maquette 3D en carton | `model.glb`, la surface exportée avec le suivi cellulaire |
| **TIFF** | le négatif de laboratoire | uniquement les téléchargements facultatifs et l'entrée des photographies |

::: note
La photographie d'un jeu 2D est enregistrée en WebP **avec** une légère perte (qualité 90) par défaut. Les briques des volumes, elles, sont toujours sans perte.
:::

## 2.7 Pourquoi tout est « auto-hébergé »

Three.js, Lucide et Plotly ne sont pas chargés depuis Internet : leurs fichiers sont **dans le dossier du site**. Voici pourquoi.

::: steps
1. **Hors ligne** : sur un réseau d'institut fermé, rien ne se casse.
2. **Sécurité** : la politique de sécurité du navigateur (CSP) n'accepte que du code venant du site lui-même. Un script étranger serait **bloqué**.
3. **Intégrité** : chaque bibliothèque est vérifiée par une empreinte (SRI) ; si un octet change, elle est refusée.
4. **Confidentialité** : aucun tiers ne sait qui regarde quel jeu de données.
:::

| Bibliothèque | Version | Rôle |
|---|---|---|
| Three.js | 0.147.0 | scène 3D, caméra, cube de départ des rayons |
| Lucide | 0.344.0 | icônes des boutons |
| Plotly | 2.27.0 | graphiques de suivi (chargée seulement à l'ouverture d'un graphique) |

::: why
**Pourquoi une version de Three.js aussi ancienne ?** La 0.147.0 est figée à dessein : un seul fichier stable, qui ne change pas sous les pieds de la plateforme. Le calcul du volume, lui, est écrit sur mesure (le « lanceur de rayons » du chapitre 9) ; Three.js ne fournit que le cadre.
:::

::: note
**Seule exception** : les polices de caractères (Google Fonts), chargées en arrière-plan. Elles ne servent qu'à l'apparence du texte.
:::

## 2.8 Ce qu'il faut côté navigateur

- un navigateur récent avec **WebGL2** et les **textures 3D** ; sans cela, la plateforme refuse d'ouvrir un volume et affiche un message plutôt que de planter ;
- une carte graphique : plus elle a de mémoire, plus la qualité atteignable est élevée ;
- le thème clair/sombre, la langue et un filtre pour daltoniens sont dans l'en-tête de chaque page.

La plateforme **mesure** la mémoire disponible et s'y adapte :

| Classe de carte graphique | Budget mémoire retenu |
|---|---|
| sans carte (rendu logiciel) | 256 Mio |
| intégrée (portable) | 0,5 à 2 Gio |
| dédiée | 3 à 4 Gio |
| inconnue | 1 à 2 Gio |

::: remember
Si la qualité demandée dépasse le budget, la plateforme choisit le niveau plus petit et vous le dit : elle ne plante pas (chapitre 10).
:::

## 2.9 Le dossier du projet

À quoi servent les dossiers que vous verrez si vous ouvrez le projet ? Un coup d'œil sur les deux premiers niveaux :

![Le projet vu de haut : visiteur, serveur, préparation, qualité.](img/ch02/arbo.svg){width=100%}

::: see
Les dossiers `DATA_WEB/` (données publiées) et `uploads/` (imports en attente) sont décrits au chapitre 7 et au chapitre 14. Les règles qui empêchent de les atteindre depuis une adresse web sont au chapitre 19.
:::
