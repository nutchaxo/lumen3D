---
title: "Lumen3D, de A à Z"
subtitle: "Documentation complète de la plateforme"
eyebrow: "IRIBHM · ULB — Lumen3D"
version: "Plateforme Web 1.59.3 · Pipeline 0.21.0 · Format de données 4"
date: "Octobre 2026"
abstract: "Comment un fichier Imaris de plusieurs gigaoctets devient un embryon que l'on fait tourner dans un navigateur — et tout ce qui entoure ce voyage : les langages et les pages, le nettoyage de l'image, la compression, les briques, le rendu 3D, le streaming, les histogrammes, chaque outil et son fonctionnement interne, les plugins, la personnalisation et les langues, les formats de données, l'import, l'hébergement, les mises à jour, la sécurité. 21 chapitres écrits pour des biologistes, illustrés à chaque page."
lang: fr
toc-title: "Sommaire"
toc-class: compact
cover-image: img/cover.png
---

# Comment lire ce document {.unnumbered}

::: lead
Ce document explique **tout** ce que fait Lumen3D, sans supposer que vous savez programmer.
Chaque page a au moins une illustration ; le texte reste court.
:::

## Quatre façons de le lire

:::: {.cards .two}
::: card
#### 🚀 En 20 minutes
Lisez seulement les encadrés verts **« En 30 secondes »** de chaque chapitre et regardez les figures.
:::
::: card
#### 🧬 « Mon dataset »
Chapitres **4 à 8** : ce qui arrive à votre fichier Imaris, étape par étape, avec de vrais chiffres.
:::
::: card
#### 🖥️ « L'écran »
Chapitres **9 à 12** : comment le viewer dessine le volume et comment fonctionnent les outils.
:::
::: card
#### ⚙️ « Les coulisses »
Chapitres **13 à 20** : le fonctionnement interne des outils, l'administration, les plugins, la personnalisation, les formats, l'hébergement, la sécurité.
:::
::::

## Les encadrés

::: tldr
Le résumé du chapitre ou de la section, en trois points.
:::

:::: cols
::: col
::: analogy
Une comparaison avec la vie de tous les jours.
:::
::: example
Un calcul fait à la main avec de vrais nombres.
:::
:::
::: col
::: tech
Le détail technique (formules, noms de fichiers). Vous pouvez le sauter.
:::
::: warning
Une limite à connaître avant d'interpréter vos images.
:::
:::
::::

## Les conventions

| Vous voyez… | Cela signifie… |
|---|---|
| [Enregistrer]{.ui} | un bouton ou un libellé tel qu'il apparaît à l'écran |
| [3]{.callout-num} | le repère numéroté n° 3 sur la capture d'écran juste au-dessus |
| `metadata.json` | un nom de fichier ou une valeur technique |
| → chapitre 7 | la notion est expliquée en détail ailleurs |

::: note
Les images de volumes proviennent d'**embryons de démonstration synthétiques**, traités par le vrai
pipeline ; ce ne sont pas des données du laboratoire. Les chiffres sont lus dans le code (plateforme 1.59.3,
pipeline 0.21.0). Version courte : **« L'essentiel »** (10 pages), dans l'onglet *Documentation* du panneau d'administration.
:::
