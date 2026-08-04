# Changelog — Plateforme Web v1.42.4

## [FIXED]

### Un 404 sur `/api/plugins` à chaque chargement de page sur un hébergement PHP

Sur une installation Apache/PHP — donc sur le site de production — la console de l'opérateur affichait `GET /api/plugins 404 (Not Found)` à l'ouverture de chaque page portant le viewer, immédiatement suivi de `[PluginRegistry] Discovered N plugins via api/plugins.php`. La découverte des plugins fonctionnait : le 404 était une requête perdue, pas une panne. Mais il polluait la console à chaque navigation, et un 404 permanent dans les journaux masque les vraies erreurs — en particulier pendant une lecture 4D, où l'on a besoin d'y voir clair.

**La cause est l'ordre des routes sondées.** `PluginRegistry.discover()` essaie trois sources dans l'ordre : l'endpoint de découverte, le manifeste statique, puis la liste embarquée. L'endpoint était sondé d'abord sous sa forme sans extension (`api/plugins`), qui n'existe que sur le serveur de développement Python ; sur Apache, aucun fichier ne répond à cette URL et la requête part en 404 avant que le code ne retombe sur `api/plugins.php` — la route qui allait de toute façon répondre.

Or `dev_server.py` route **les deux** formes (`/api/plugins` et `/api/plugins.php`). La variante `.php` est donc la seule URL qui résout sur les deux types d'hébergement : la sonder en premier supprime le 404 côté Apache sans rien changer côté Python. Les deux entrées sont conservées, simplement inversées ; le manifeste statique reste le dernier recours pour un hôte sans PHP.

C'est exactement le correctif déjà appliqué à la découverte des langues : `I18n.discoverLanguages()` sonde `api/languages.php` avant `api/languages`, pour cette raison précise et avec ce commentaire. `plugin-registry.js` n'avait jamais été aligné. Il l'est désormais, et le commentaire renvoie à son jumeau pour que les deux ne redivergent pas.

Vérifié sur les deux hébergements, dans le navigateur : une seule requête `api/plugins.php` en 200, aucun 404, et la barre d'outils construite à l'identique (11 boutons de plugin et 3 pastilles d'outil). Le champ `trustEpoch` continue d'arriver sur le serveur Python, donc la surveillance des révocations de confiance reste active.
