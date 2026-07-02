# Plateforme Web v0.4.12

**Date :** 01 Juin 2026

### [FIXED]
- **Bug de la vue 3D figée en mode Mesure :** Correction d'une erreur fatale dans la boucle de rendu 3D. Lorsqu'une mesure était placée, une erreur de typage invisible gelait définitivement l'affichage (rendant impossible toute rotation sur la vue), bien que les données soient bien enregistrées (ce qui faisait apparaître la mesure seulement après changement d'outil/actualisation de l'interface HTML). La 3D reste désormais fluide et les mesures apparaissent instantanément lors du clic.
- **Restauration de la caméra via l'URL :** Résolution du bug où l'application forçait un zoom/cadrage par défaut à la fin du chargement d'un modèle 3D. Désormais, si un lien URL contient une position de caméra partagée, l'application bloque le "reset" automatique et préserve l'orientation exacte du partage.
