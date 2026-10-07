---
title: "Lumen3D, de A à Z"
subtitle: "Documentation complète de la plateforme"
eyebrow: "IRIBHM · ULB — Lumen3D"
version: "Plateforme Web 1.59.2 · Pipeline 0.21.0 · Format de données 4"
date: "Octobre 2026"
abstract: "Comment un fichier Imaris de plusieurs gigaoctets devient un embryon que l'on fait tourner dans un navigateur : les langages, les pages, le nettoyage de l'image, la compression, les briques, le rendu 3D, les outils de mesure et le panneau d'administration. Écrit pour des biologistes, illustré à chaque page."
lang: fr
toc-title: "Sommaire"
cover-image: img/cover.png
---

# Comment lire ce document {.unnumbered}

::: lead
Ce document explique **tout** ce que fait Lumen3D, sans supposer que vous savez programmer.
Chaque page a au moins une illustration ; le texte reste court.
:::

## Trois façons de le lire

:::: cards
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
Les images de volumes de ce document proviennent d'**embryons de démonstration synthétiques**,
fabriqués pour cette documentation puis traités par le vrai pipeline de la plateforme.
Ce ne sont pas des données du laboratoire. Les chiffres cités (seuils, tailles, formules)
sont lus dans le code de la version 1.59.2 de la plateforme et 0.21.0 du pipeline.
:::

::: see
Une version courte de ce document, **« L'essentiel pour le biologiste »** (10 pages), et le
**Guide de l'administrateur** sont publiés au même endroit, dans l'onglet *Documentation*
du panneau d'administration.
:::
