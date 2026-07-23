# Plateforme Web — v1.20.0

> **Bibliothèque de médias : téléversez vos images.** Fini le collage d'URL — chaque champ image de
> l'éditeur (image, galerie, carte icône, avatar de citation, profil, image de fond de section/
> colonne) ouvre désormais un sélecteur avec **téléversement par glisser‑déposer**, une **bibliothèque**
> des images déjà envoyées, un champ URL, et un aperçu miniature. Un opérateur non‑technique peut enfin
> placer son propre logo ou ses photos sans les héberger ailleurs.

## [ADDED]

### Sélecteur de média ([js/pages/admin/pages-controls.js](../js/pages/admin/pages-controls.js))
- Nouveau type de contrôle **`media`** : miniature d'aperçu + champ URL + bouton d'ouverture d'un panneau avec :
  - **Zone de téléversement** (clic ou glisser‑déposer d'un fichier image) ;
  - **Bibliothèque** des images déjà téléversées (grille cliquable, les plus récentes d'abord) ;
  - **Champ URL** pour coller un lien externe, et un bouton **Retirer l'image**.
- Le panneau se ferme au clic extérieur / Échap et expose `aria-haspopup` / `aria-expanded` (cohérent avec les autres sélecteurs).
- **Tous les champs image** de l'éditeur passent au sélecteur ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js)) : widget Image, Galerie, Carte icône, avatar de Citation, Profil, et **image de fond** de section/colonne.

### API de médias ([dev_server.py](../dev_server.py) + [api/media.php](../api/media.php))
- Nouveau point d'entrée `/api/media.php` (jumeaux Python **et** PHP) :
  - `list` — liste les images téléversées (session admin) ;
  - `upload` — reçoit l'image en base64, la valide et l'écrit (session admin + CSRF) ;
  - `delete` — supprime une image (session admin + CSRF).
- Les fichiers sont stockés dans le dossier **public** `config/uploads/` (donc servis aux pages publiques et **préservés lors des mises à jour**, `config/` étant protégé).
- **Garde‑fous** : extensions **raster uniquement** (png, jpg, jpeg, webp, gif, avif ; **SVG exclu** car il peut porter du script), nom de fichier assaini (slug + extension), gestion des collisions (`-1`, `-2`…), et **plafond de 8 Mo** par image.
