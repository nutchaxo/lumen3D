# Changelog Plateforme Web - v1.0.2

### [ADDED]
- **Visuals** : Nouveau plugin `orientation-axes` permettant d'afficher un triple axe d'orientation interactif et déplaçable (A/P en vert, D/V en bleu, L/R en rouge) pour l'embryon.
- **Admin Panel** : Ajout d'une fonctionnalité de calibration 3D dans le panneau d'administration. Il est désormais possible de définir l'orientation de l'embryon directement depuis la vue "Paramètres d'affichage" sans bouton de sauvegarde supplémentaire (l'orientation est interceptée asynchrone lors de la sauvegarde globale du dataset).

### [OPTIMIZED]
- **Architecture** : Le système de calibration communique avec le viewer via des `postMessage` gérés directement par le plugin `orientation-axes`, ce qui évite de polluer le code natif de rendu (`VolumeViewer`).
