# Changelog v1.49.2 (Plateforme Web)

## [FIXED]
* **Panneau de la vue divisée : la barre latérale du second panneau se replie sans transition.** Dans une iframe masquée ou ralentie par le navigateur, la transition de largeur de 0,25 s ne se terminait pas toujours et laissait un fantôme de 320 px à côté de la photographie. En mode sans en-tête (`hideHeader=true`, aperçu admin et vue divisée), la barre latérale n'est plus animée : l'état replié s'applique immédiatement.
