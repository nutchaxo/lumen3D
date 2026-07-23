# Plateforme Web — v1.21.0

> **Édition directe, aperçu mobile, copier‑coller.** L'éditeur se rapproche encore d'Elementor : on
> **double‑clique un titre ou un bouton pour le modifier directement sur la page**, on bascule l'aperçu
> entre **bureau / tablette / mobile** pour voir la mise en page réelle, et on **copie‑colle** un widget
> (y compris d'une page à l'autre) au clavier.

## [ADDED]

### Édition de texte en place ([js/core/page-edit-frame.js](../js/core/page-edit-frame.js) + [js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js))
- **Double‑clic sur un titre / libellé** (widgets *Titre*, *Bouton*, titre de *Héros*, *Bandeau d'action*, *Carte icône*) le rend éditable **directement dans la page** ; **Entrée** valide, **Échap** annule.
- Reste fidèle au flux de données à sens unique : la frame propose le nouveau texte (`setText`), le parent l'écrit dans le modèle — CSP‑safe (un simple attribut `contenteditable`, aucun `<style>` injecté).
- Les widgets à mise en forme riche (*Texte*) gardent volontairement l'édition en barre latérale (le double‑clic perdrait le gras/italique/liens).

### Aperçu par appareil ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js))
- Bascule **Bureau / Tablette / Mobile** dans la barre de l'éditeur : la surface d'édition est contrainte à la largeur choisie (100 % / 820 px / 390 px) et centrée, pour **voir le rendu mobile réel** (empilement des colonnes) sans quitter l'éditeur.

### Copier / coller un widget ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js))
- **Ctrl/Cmd+C** copie le widget sélectionné, **Ctrl/Cmd+V** le colle juste après la sélection. Le presse‑papier passe par `sessionStorage`, donc il **survit au rechargement de l'onglet éditeur** et fonctionne **d'une page à l'autre**.

> Note : la surcharge de valeurs *par appareil* (padding/taille de police différents selon l'écran) reste
> une évolution future — la CSP interdisant le `<style>` injecté, elle passera par un jeu de classes
> responsives prédéfinies plutôt que par du CSS généré.
