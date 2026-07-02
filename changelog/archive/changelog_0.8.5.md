# Changelog 0.8.5

[OPTIMIZED]
- Centralisation de l'édition des canaux : la section redondante "Canaux" (sliders, sélecteurs de couleur) a été totalement supprimée du panneau de droite (configuration globale) de l'administration.
- Panneau d'administration : il écoute désormais de manière réactive l'état interne de la barre d'outils du Viewer embarqué. Toute modification d'un canal (couleur, visibilité, plage) déclenche automatiquement une mise à jour silencieuse de l'état "non sauvegardé" du panneau Admin. Lors d'une sauvegarde, les données proviennent exclusivement du viewer.

[ADDED]
- Menu du Viewer (Barre latérale) : le nom du canal n'est plus un texte statique, mais est désormais affiché dans un champ textuel (`<input type="text">`). Il est maintenant possible de renommer ses canaux directement en cliquant sur leurs noms depuis le Viewer. Le changement est immédiatement synchronisé avec le parent (Admin).
