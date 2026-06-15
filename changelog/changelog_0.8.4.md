# Changelog 0.8.4

[OPTIMIZED]
- Refonte de la structure HTML du panneau d'administration (`admpan.html`) : l'en-tête (Header) n'est plus coincé dans le layout flexbox principal. Il a été déplacé pour s'afficher correctement sur toute la largeur en haut de l'écran, ce qui supprime l'espace vide indésirable sur la gauche.
- Panneau d'administration : ajout d'un bouton de repli dynamique (◀) sur la liste des datasets (gauche) permettant de minimiser la liste pour maximiser l'espace de travail.
- Viewer embarqué (mode iframe admin) : la barre latérale native du viewer 3D (contenant les réglages de canaux, outils et histogrammes) n'est plus masquée de force. Elle est désormais visible de manière permanente entre la liste des datasets et la vue 3D.
- Panneau de configuration (droite) : suppression de la section redondante des mini-histogrammes, ces derniers étant désormais accessibles directement via la barre latérale native du viewer.
- Cache : incrémentation de la version du script `viewer.js` (v3) dans le catalogue principal.
