# Plateforme Web — v1.22.0

> **Trois nouveaux widgets, validation serveur, et gestion des colonnes.** L'éditeur gagne les widgets
> **Onglets**, **Compteur animé** et **Vidéo** ; les pages sont désormais **validées côté serveur** avant
> écriture (taille, structure, `schemaVersion`) ; et chaque **colonne** dispose d'une barre d'outils
> dans la page (déplacer, dupliquer, supprimer).

## [ADDED]

### Trois nouveaux widgets ([js/core/page-renderer.js](../js/core/page-renderer.js) — 21 → 24 types)
- **Onglets** — plusieurs volets de contenu commutables (complète l'Accordéon), avec couleur d'onglet actif réglable.
- **Compteur animé** — un nombre qui **s'anime de 0 à la valeur cible** à l'entrée dans la vue (`IntersectionObserver`), avec préfixe/suffixe (`+`, `%`, `k`…), taille et couleur. Filet de sécurité : la valeur finale s'affiche même si l'onglet est en arrière‑plan (jamais bloqué à 0).
- **Vidéo** — un fichier **auto‑hébergé** (`.mp4`/`.webm`) rendu en lecteur `<video>` natif, ou un lien **YouTube/Vimeo** présenté comme une vignette « ▶ » qui ouvre la vidéo dans un nouvel onglet (la CSP interdit l'iframe inline — l'intégration directe nécessiterait d'autoriser un `frame-src`, laissé de côté par sécurité).

### Barre d'outils de colonne ([js/core/page-edit-frame.js](../js/core/page-edit-frame.js) + [js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js))
- Chaque colonne affiche au survol une barre : **déplacer** ← / →, **réglages**, **dupliquer**, **supprimer** — comme les sections et les widgets. La duplication clone la colonne (nouveaux identifiants) et rééquilibre les largeurs.

## [FIXED]

### Validation des pages côté serveur ([dev_server.py](../dev_server.py) + [api/site.php](../api/site.php))
- Avant écriture, un document de page est **validé structurellement** (règle 1.4 : rejeter un document malformé plutôt que l'écrire à moitié) : **plafond de 2 Mo**, forme `{title?, draft?, published?}`, nombres de sections/colonnes/widgets **bornés**, largeur de colonne **1–12** (bornée), chaque widget doit être un objet typé. Un document invalide renvoie **400** au lieu d'être partiellement enregistré.
- **Rétro‑compatible** : les documents hérités `{blocks:[]}` passent (laissés au normaliseur du moteur de rendu) et les **types de widgets inconnus sont acceptés** (compatibilité ascendante — le moteur de rendu les gère). Un champ **`schemaVersion`** est apposé pour ancrer les futures migrations.

> Évolutions futures identifiées mais non incluses ici : réordonnancement des sections au glisser, modale
> de création de page (à la place de `prompt()`), historique de versions, renommage d'URL, bordures/arrondis
> par côté, et widget Tableau.
