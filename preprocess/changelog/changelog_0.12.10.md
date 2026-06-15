# Changelog v0.12.10

## Plateforme Web

### [FIXED]
- **Bug Critique** : Correction de l'erreur de syntaxe (`missing ) after argument list`) injectée lors de la précédente mise à jour du `brick-loader.js` (Ligne 601) à cause d'une regex défaillante dans les scripts de patching. Le chargement WebP asynchrone est maintenant fonctionnel avec les logs de performance activés.
