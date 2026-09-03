# Changelog v1.48.1 (Plateforme Web)

## [FIXED]
* **Le panneau admin ne démarrait plus après la mise à jour 1.48.0.** `js/pages/admin/tab-datasets.js` contenait deux fois les fonctions `dimsLabel` et `toggleVolumeSections` (un bloc appliqué en double lors de la préparation de la 1.48.0). En module ES, une déclaration dupliquée est une erreur de syntaxe : le module était rejeté et tout le panneau restait noir, avant même l'écran de connexion. Le doublon est retiré ; tous les modules du panneau sont désormais vérifiés en mode module ES (`node --check` sur une copie `.mjs`), ce que la vérification en script classique ne détectait pas.
