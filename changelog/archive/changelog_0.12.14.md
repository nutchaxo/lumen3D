# Changelog 0.12.14 (Plateforme Web)

## [OPTIMIZED]
- **Optimisation majeure de la boucle d'extraction des pixels :** Réécriture complète des boucles d'unpacking (mode grid 3D et mode fallback 1D) dans `brick-decode-worker.js` et `brick-loader.js`. Élimination de toutes les opérations arithmétiques redondantes, des accès répétés aux propriétés des objets hôtes (comme `bmp.width`) et du filtre logique OR (`|| 0`) au sein de la boucle interne pour permettre une compilation JIT V8 optimale.
- **Optimisation des opérations Canvas 2D :** Remplacement de `ctx.clearRect(...)` par `ctx.globalCompositeOperation = 'copy'` sur le contexte de l'OffscreenCanvas. Cela permet de copier directement les nouveaux pixels (y compris le canal alpha) sur le canvas réutilisé sans avoir à effacer préalablement la mémoire, évitant ainsi le bleeding de pixels et l'overhead d'un appel clear.

## [FIXED]
- **Nettoyage strict de la mémoire GPU / VRAM :** Rétablissement de `bmp.close()` immédiatement après l'appel synchrone `ctx.getImageData(...)`. Comme `getImageData` bloque le CPU jusqu'à ce que la lecture GPU soit achevée, le drawImage est pleinement exécuté et la ressource peut être libérée immédiatement sans provoquer la race condition d'affichage (textures striées) observée précédemment dans Chromium.
- **Cache-Busting :** Passage du paramètre de version à `v137` dans `viewer.html` pour forcer le rechargement immédiat des fichiers JS mis à jour par le navigateur.
