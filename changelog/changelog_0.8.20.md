## v0.8.20

### [FIXED]
- Ajout des en-têtes CORS (`Access-Control-Allow-Origin: *`) sur le serveur de développement pour l'ensemble des fichiers statiques (notamment les briques `.bin` / `.bin.gz`). Cela résout les erreurs `Failed to fetch` lors de l'accès à la plateforme via un port différent (comme lors de l'utilisation du serveur de développement Vite/React sur le port 5173 ou autre).
