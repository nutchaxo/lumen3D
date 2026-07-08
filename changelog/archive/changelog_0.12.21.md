# Changelog 0.12.21 (Plateforme Web)

## [OPTIMIZED]
- **Suppression du goulot d'étranglement WebGL texSubImage3D pendant le streaming :** C'était le véritable goulot d'étranglement de l'application. Auparavant, à chaque fois qu'un chunk était chargé, un appel synchrone à `gl.texSubImage3D` était effectué pour l'envoyer au GPU. Multiplié par 3 697 chunks, cela générait des milliers d'opérations de synchronisation CPU/GPU bloquantes, créant la lenteur et la saturation GPU observées. J'ai modifié le pipeline pour que les briques chargées soient copiées uniquement dans le tampon mémoire CPU (`tex.image.data`) à l'aide d'opérations `targetData.set(...)` ultra-rapides (< 0.02ms par brique). Les textures 3D complètes ne sont désormais envoyées en une seule fois au GPU (`tex.needsUpdate = true`) qu'une fois la totalité des briques chargées, éliminant tout lag et saturation du GPU pendant le chargement.

## [FIXED]
- **Cache-Busting :** Incrément du cache-buster global à `v144` dans `viewer.html` pour invalider le cache des navigateurs.
