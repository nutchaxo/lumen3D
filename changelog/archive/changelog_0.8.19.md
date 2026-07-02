## v0.8.19

### [OPTIMIZED]
- Restauration des performances et des 60 FPS lors du streaming haute résolution.
- Remplacement de l'appel bloquant `gl.getParameter(gl.TEXTURE_BINDING_3D)` par l'API native `renderer.state.bindTexture` de Three.js. L'ancienne méthode provoquait un "GPU pipeline stall" (interruption de la synchronisation CPU-GPU) à chaque brique chargée, écroulant les performances lors du chargement des images de plusieurs gigaoctets.
