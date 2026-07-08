## v0.8.18

### [FIXED]
- Correction critique de la corruption de l'état WebGL qui rendait le 3ème canal invisible (écran noir partiel). Le bind `null` lors de l'upload asynchrone des bricks écrasait silencieusement le cache des unités de texture de Three.js. L'ancien `TEXTURE_BINDING_3D` est désormais correctement sauvegardé et restauré après chaque transfert VRAM.
- Résolution des erreurs `GL_INVALID_OPERATION: glTexImage3DRobustANGLE: Texture is immutable` en retirant l'appel manuel redondant à `texImage3D`. Three.js alloue déjà la mémoire (`texStorage3D`) via `initTexture()`.
- Nettoyage des logs de diagnostic.
