# Plateforme Web — v1.14.4

> **Le bouton « Publier » de l'éditeur ne semblait « rien faire ».** En réalité, ouvrir une page
> intégrée (Accueil/À propos) sans la modifier puis cliquer sur Publier ouvrait une boîte de dialogue de
> confirmation (« … remplacera la mise en page intégrée… Continuer ? ») ; cliquer **Annuler** annulait la
> publication sans rien afficher — d'où l'impression que le bouton était inerte. Et quand la publication
> réussissait, le petit toast en bas à droite passait facilement inaperçu dans l'éditeur plein écran.

## [FIXED]
- **« Publier » sans effet visible** ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js)) — suppression de la confirmation bloquante avant publication (introduite en v1.14.2) : elle allait à l'encontre de l'intention — on est justement dans l'éditeur pour remplacer la page — et une annulation faisait échouer la publication en silence. La publication est de toute façon **réversible en un clic** (« Défaut »), et depuis la v1.14.3 le modèle de départ est fidèle à la vraie page (le « garde-fou » n'a plus lieu d'être). Le bouton donne maintenant un **retour clair et dans le contexte** : « Publication… » pendant l'appel, puis « Publié ✓ » pendant ~2,5 s (en plus du toast), donc l'action est toujours visible même en plein écran. La publication elle-même fonctionnait déjà (save → publish, vérifié sur serveur Python ET PHP).

[Versioning] Plateforme Web → v1.14.4. changelog_1.14.4.md généré.
