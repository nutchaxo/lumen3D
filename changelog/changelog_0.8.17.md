## v0.8.17

### [FIXED]
- Correction des avertissements `warning X4008: floating point division by zero` dans le shader (ajout de sécurités contre les divisions par des vecteurs de direction ou pas de lancer de rayon nuls).

### [ADDED]
- Ajout de logs d'inspection détaillés pour l'activation des canaux (uniforms liés) et les re-compilations des shaders (état des directives ENABLE_CHANNEL_*).
- Ajout de logs au niveau du transfert VRAM (`texSubImage3D`) ciblant le troisième canal (Ch2) afin d'identifier la perte d'affichage.
