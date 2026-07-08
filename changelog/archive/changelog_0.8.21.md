# Changelog 0.8.21

### [FIXED]
- Correction d'un bug majeur qui empêchait le Web Worker de télécharger les briques de données 3D (`Failed to fetch`). Le serveur Python dupliquait les en-têtes CORS (`Access-Control-Allow-Origin: *`) lors des requêtes preflight `OPTIONS`. Chrome rejetait strictement ces requêtes, bloquant ainsi le flux de données en mode cross-origin/local.
