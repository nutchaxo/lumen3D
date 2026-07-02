# Plateforme Web - v0.4.6

## [FIXED]
- **Bug d'affichage Modale :** Correction du positionnement de la fenêtre modale des daltonismes qui s'affichait tout en bas de l'écran. Ce comportement était causé par l'application globale du filtre SVG sur la balise `<body>` qui cassait le contexte de positionnement `fixed`. La modale est désormais injectée à la racine du DOM (`<html>`) hors de l'influence du filtre de `<body>`, garantissant son centrage parfait au milieu de la fenêtre de navigation en toute circonstance.
