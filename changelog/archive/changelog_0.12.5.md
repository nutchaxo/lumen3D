## [FIXED]
- **Correction Critique de Performance (Main Thread Stalling) :** Le décodage des chunks WebP était exécuté sur le thread principal (Javascript `getImageData` sur Canvas), ce qui gelait complètement l'affichage et annulait les bénéfices du SVR.
- Le paramètre `isRaw` dans `brick-loader.js` a été mis à jour pour router correctement les fichiers `webp-lossless` vers le Web Worker. Le décodage se fait désormais en arrière-plan avec un transfert mémoire "zéro-copie" (`ArrayBuffer transfer`), rendant l'affichage des LOD 512 et 1024 véritablement fluide et non-bloquant.
