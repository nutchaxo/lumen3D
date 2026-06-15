# Changelog — Plateforme Web v0.12.41

**Date :** 2026-06-15

---

## [OPTIMIZED]

### Optimisation du point de rupture et contournement du cache navigateur (`viewer.html` et `viewer.css`)

**Fichiers :**
- [viewer.css](file:///c:/Users/Administrator/Desktop/WebPlatform/css/viewer.css)
- [viewer.html](file:///c:/Users/Administrator/Desktop/WebPlatform/viewer.html)

**Améliorations :**
- **Ajustement du breakpoint à `1024px` :** Le point de rupture pour l'affichage du menu hamburger a été augmenté à `1024px` (au lieu de `860px`). Cela garantit que la barre d'outils est remplacée par le menu hamburger dès que la largeur de l'écran force le premier repliement (split) des clusters d'outils en ligne, évitant ainsi d'avoir 2 lignes de boutons et 1 ligne de titre.
- **Contournement du cache (cache-busting) :** Mise à jour des paramètres de requête de version dans les imports de feuilles de style de [viewer.html](file:///c:/Users/Administrator/Desktop/WebPlatform/viewer.html) (`css/viewer.css?v=0.12.41` et `css/tools.css?v=0.12.41`). Cela force le navigateur de l'utilisateur à récupérer immédiatement la dernière version des styles CSS sans utiliser une version obsolète mise en cache.
