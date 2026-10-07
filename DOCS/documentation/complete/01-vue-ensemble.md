# 1. La plateforme en un coup d'œil

::: chapter-intro
- **Lumen3D** est un site web qui permet d'explorer, dans un navigateur ordinaire, des images de microscopie confocale pesant plusieurs gigaoctets : rien à installer.
- Une pile de ~10 Go ne tient ni dans la mémoire d'un navigateur ni dans celle d'une carte graphique : toute la plateforme est conçue pour ne charger que ce que l'écran montre.
- Il existe **trois types** de jeux de données (3D, Live, 2D) et un chemin unique du microscope à l'écran, que ce chapitre vous fait parcourir.
:::

## 1.1 Qu'est-ce que Lumen3D, et pour qui ?

**Lumen3D** (*Light-based Unified Microscopy Exploration in 3D*) est né à l'IRIBHM (ULB) pour regarder des embryons de souris. Il est ensuite devenu une plateforme « marque blanche » : nom, couleurs, pages et vocabulaire se changent depuis le panneau d'administration, sans écrire une ligne de code.

Quatre personnes l'utilisent, chacune avec une part différente de ce document :

:::: {.cards .four}
::: card
#### Le biologiste
Ouvre un embryon, règle les couleurs, mesure, coupe, compare, fabrique une figure.

[chapitres 3, 11, 12]{.pill .green}
:::
::: card
#### Le technicien
Lance le **pipeline** Python qui transforme le fichier Imaris en dossier web.

[chapitres 4 à 8]{.pill .amber}
:::
::: card
#### L'administrateur
Importe, publie, personnalise le site, met à jour la plateforme.

[chapitres 13 et 14]{.pill}
:::
::: card
#### Le visiteur public
Parcourt le catalogue publié et regarde, sans compte ni mot de passe.

[chapitre 3]{.pill .grey}
:::
::::

::: note
Il n'y a **aucun compte utilisateur**. Seule l'administration est protégée par un mot de passe ; tout ce qui est publié est visible par quiconque a l'adresse du site.
:::

## 1.2 Le problème : un fichier trop gros pour un navigateur

Prenons le plus gros jeu de référence du pipeline : un embryon de **3789 × 3789 × 178 voxels** sur **4 canaux**. Le fichier Imaris d'origine pèse **14,4 Go**.

::: example
**Le calcul.** 3789 × 3789 × 178 = 2 555 460 738 voxels par canal. À 1 octet par voxel : **≈ 2,56 Go par canal**, donc **≈ 10,2 Go** pour 4 canaux. La carte graphique, elle, n'offre à la plateforme que 0,25 à 4 Go selon sa classe.
:::

![Même en le réduisant à 1 octet par voxel, la pile dépasse la mémoire de la plupart des cartes graphiques.](img/ch01/pourquoi.svg){width=95%}

Trois obstacles se cumulent :

- **le réseau** : à environ 5 Mo/s, 10 Go demandent plus d'une demi-heure ;
- **la mémoire du navigateur** : il n'est pas fait pour garder des gigaoctets d'image ;
- **la mémoire de la carte graphique** (VRAM) : c'est elle qui dessine, et elle est petite.

::: analogy
**Une encyclopédie de 50 tomes.** Personne ne pose les 50 tomes ouverts sur son bureau pour lire un paragraphe. On prend l'index, on ouvre le bon tome à la bonne page. Lumen3D fait pareil avec l'image : un index (le *manifeste*) et des petits morceaux (les *briques*) que l'on va chercher à la demande.
:::

La réponse tient en trois idées, détaillées aux chapitres 5 à 10 :

::: steps
1. **Réduire** : retirer le bruit de fond, passer en 8 bits, fabriquer des versions plus petites de l'image (les niveaux de détail).
2. **Découper** : cuber l'image en briques de 64 voxels de côté et les ranger dans quelques gros fichiers.
3. **Streamer** : le navigateur télécharge d'abord la version grossière (image instantanée), puis affine seulement la zone regardée.
:::

## 1.3 Les trois types de jeux de données

Tout jeu de données publié est d'un de ces trois types. Le même mot sert de nom de dossier, de début d'identifiant (par exemple `3d/Embryo-E95-Em2-Pecam1-Sox2`) et de filtre dans l'Explorateur.

![Trois types, trois pages d'affichage. Les noms entre guillemets sont ceux que le public lit par défaut.](img/ch01/types.svg){width=95%}

::: note
Les noms affichés (« 3D », « Live », « 2D ») appartiennent à l'administrateur : il peut les renommer dans l'onglet [Types de données]{.ui} sans toucher aux dossiers. Dans ce document, on utilise les noms par défaut.
:::

| Type | Ce que contient le jeu | Exemple du jeu de démonstration |
|---|---|---|
| 3D | un volume, 1 à 4 canaux | `Embryo-E95-Em2-Pecam1-Sox2` (768 × 576 × 112, 3 canaux) |
| Live | un volume par instant, avec ligne de temps | `Demo-Lumen3D-E85-Em1-30min-2ch-4tp` (4 instants) |
| 2D | une photographie calibrée en µm | `DLL4xCD1-E95-x3.2-240913-1` (coloration X-gal) |

::: why
**Pourquoi le suivi cellulaire n'est-il pas un type ?** Parce qu'il décrit un jeu Live, il ne le remplace pas. Les positions des cellules, leurs trajectoires et la surface sont des **couches** dessinées par-dessus le volume, et cinq outils dédiés les analysent (chapitre 12). Un jeu Live sans suivi reste un jeu Live.
:::

::: warning
Les jeux de ce document sont des **jeux de démonstration synthétiques**, fabriqués pour l'occasion : ce ne sont pas des données réelles du laboratoire.
:::

## 1.4 Le voyage d'une acquisition

De l'échantillon à l'écran, les données traversent quatre lieux.

![Du microscope à l'écran, en quatre étapes.](img/ch01/parcours.svg){width=100%}

| Étape | Qui | Durée typique | Chapitre |
|---|---|---|---|
| 1. Acquisition | microscope confocal + logiciel Imaris | selon l'échantillon | 4 |
| 2. Préparation | technicien, pipeline Python sur son ordinateur | minutes à heures, une seule fois | 5 à 8 |
| 3. Mise en ligne | administrateur : import par glisser-déposer ou SFTP, puis publication | selon le débit | 13 |
| 4. Affichage | n'importe qui, avec un navigateur | quelques secondes pour la première image | 9 à 12 |

::: remember
Le travail lourd (nettoyage, découpage) se fait **une seule fois, hors ligne**. Ensuite, chaque visiteur ne télécharge que des morceaux : c'est ce qui rend l'exploration fluide.
:::

## 1.5 Chiffres clés

:::: keynums
::: keynum
**3**
types de données : 3D, Live, 2D
:::
::: keynum
**64³**
voxels par brique (66³ avec bord, format 4)
:::
::: keynum
**4**
canaux affichés au maximum
:::
::: keynum
**4**
langues : anglais, français, espagnol, néerlandais
:::
::: keynum
**28**
plugins au catalogue signé
:::
::: keynum
**≈ 126 000**
lignes de code, hors tests
:::
::: keynum
**512 · 1024 · natif**
les trois qualités de rendu
:::
::: keynum
**201**
fichiers de tests automatiques
:::
::::

Quelques repères de version, valables à la date de ce document :

- plateforme web **1.59.2** ; pipeline de préparation **0.21.0** ;
- format de données courant : [format 4]{.pill .green} (les formats 1 à 3 sont convertis en place, voir chapitre 13) ;
- chaque version est vérifiée par les tests automatiques avant d'être publiée.

## 1.6 Carte de la documentation

Ce document est organisé comme le trajet de la donnée. Retrouvez votre question ci-dessous.

![Quelle question, quel chapitre ?](img/ch01/carte.svg){width=95%}

::: tip
Pressé ? Lisez les encadrés **En 30 secondes** au début de chaque chapitre : ils suffisent pour savoir si la suite vous concerne.
:::
