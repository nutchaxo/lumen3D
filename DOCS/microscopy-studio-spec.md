# Spécifications Fonctionnelles : Microscopy Studio & Exploration Volumétrique

Ce document détaille les spécifications exhaustives et le flux de travail souhaité pour la plateforme de visualisation de microscopie avancée. L'objectif est de fournir une expérience utilisateur "Premium", fluide et précise pour l'exploration de gros volumes de données 4D/5D.

---

## 1. Exploration 3D et Découpe Oblique

L'interface principale doit permettre une manipulation intuitive du volume pour définir des plans de coupe arbitraires (obliques).

### 1.1 Le Gizmo de Rotation 3D (Arcball)
*   **Design Premium** : Une sphère centrale transparente entourée de trois anneaux colorés représentant les axes (Rouge=X, Vert=Y, Bleu=Z).
*   **Interaction Contextuelle** : Au survol d'un anneau, celui-ci doit se mettre en surbrillance (opacité augmentée et effet d'émission) pour confirmer la sélection.
*   **Rotation Cohérente** : Le mouvement de rotation doit être projeté selon la tangente de l'anneau à l'écran. Si un axe est orienté verticalement à l'écran, un mouvement vertical de la souris doit entraîner une rotation naturelle.
*   **Contraintes d'Axe** : En cliquant sur un anneau spécifique, la rotation est strictement contrainte à cet axe. Un clic en dehors des anneaux permet une rotation libre (trackball).

### 1.2 Manipulation du Plan de Coupe
*   **Profondeur du Plan** : Possibilité de déplacer le plan le long de sa normale (translation avant/arrière dans le volume) via un curseur dédié ou par clic-glissé direct sur le plan.
*   **Indépendance du Clipping** : Le déplacement du plan de coupe visuel ne doit pas affecter le rognage (clipping) du modèle 3D global, sauf demande explicite.
*   **Preview Temps Réel** : Une fenêtre de prévisualisation 2D doit afficher instantanément la coupe résultante. Ce rendu doit être **asynchrone** pour ne jamais bloquer l'interface, même sur des volumes massifs (1024³+).

---

## 2. Le Studio de Microscopie (Édition 2D)

Une fois le plan de coupe idéal trouvé, l'utilisateur bascule dans le "Studio" pour l'annotation et l'analyse.

### 2.1 Viewport Interactif "Infini"
*   **Navigation Libre** : Support complet du Pan (déplacement), Zoom (molette) et **Rotation 2D** (orientation de l'image pour l'export).
*   **Centrage Automatique** : À l'ouverture, l'image doit occuper l'espace maximal disponible tout en restant centrée.

### 2.2 Outils d'Annotation et Mesure
*   **Étalonnage Physique** : Tous les outils utilisent les métadonnées de microscopie (`pixelSizeUm`) pour donner des valeurs réelles en microns (µm).
*   **Outil Distance** : Une ligne avec étiquette automatique. Possibilité de personnaliser les extrémités (flèches, barres plates, points, ou rien).
*   **Outil Angle** : Interaction en trois points permettant de mesurer des angles précis entre structures biologiques.
*   **Scale Bar (Barre d'Échelle) Dynamique** :
    *   S'ajuste automatiquement en longueur selon la valeur saisie par l'utilisateur.
    *   Sélecteur d'unité (radio buttons) : **µm, mm, cm, px**.
    *   La conversion doit conserver la valeur brute mais adapter la longueur physique de la barre.

### 2.3 Gestion des Calques et Objets
*   **Liste des Calques** : Affichage à gauche de tous les objets ajoutés.
*   **Drag & Drop Fluide** : Possibilité de réorganiser l'ordre d'empilement (Z-index) des annotations par glisser-déposer avec des animations fluides.
*   **Propriétés Contextuelles** : Changement rapide des couleurs, épaisseurs de traits, tailles de police et opacités pour chaque objet.

### 2.4 Gestion des Canaux (Live)
*   Contrôle individuel de chaque canal (jusqu'à 4 ou plus) directement dans le studio.
*   Ajustement des niveaux (Min, Max, Gamma) et choix des couleurs de LUT.
*   Ré-échantillonnage dynamique de l'image source lors de la modification des paramètres de canaux.

---

## 3. Performance et Rendu Haute Fidélité

### 3.1 Chargement Progressif
*   **Seamless Transition** : Le passage de la version basse résolution (preview) à la version haute définition (high-quality) doit se faire sans freeze de l'interface.
*   **Optimisation CPU/GPU** : Les calculs lourds (comme les histogrammes ou les projections de forte épaisseur) doivent être échantillonnés ou distribués pour maintenir 60 FPS.

### 3.2 Exportation et Partage
*   **Rendu Natif** : L'exportation finale doit utiliser la résolution native des fichiers sources (WebP/OME-Zarr) et non une simple capture d'écran du canvas.
*   **Multi-Format** :
    *   **PNG** : Image haute résolution avec incrustation des annotations et de la barre d'échelle.
    *   **JSON** : Exportation des vecteurs d'annotation pour permettre une réédition ultérieure.
*   **Stamp Métadonnées** : Option pour inclure le nom du dataset, le mode de projection et l'étalonnage directement sur l'image exportée.
