# Plateforme Web — v1.14.6

> **La cause RÉELLE du « Publier ne change rien » : sur les hébergements PHP, rien n'était enregistré.**
> L'éditeur affichait bien « Publié ✓ », mais après un rechargement les modifications disparaissaient —
> parce que la sauvegarde écrivait un tableau vide. Débogué et reproduit sur un vrai serveur PHP, corrigé,
> vérifié bout-en-bout.

## [FIXED]
- **Les pages publiées ne se sauvegardaient pas sur hôte PHP** ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js)) — pour une page **sans version enregistrée**, `GET /api/site.php?action=get` renvoie `[]` (tableau vide) sur PHP, alors que le serveur de dev Python renvoie `{}` (objet). Côté client, `typeof [] === 'object'` : le document courant `_doc` devenait donc un **tableau**. Ensuite `_doc.draft = { sections }` posait une propriété nommée sur ce tableau — et **`JSON.stringify` d'un tableau ignore les propriétés nommées** → le corps envoyé à `save` était `"[]"`, donc rien n'était écrit ; `publish` recopiait alors un brouillon vide. « Publié ✓ » s'affichait (les deux appels réussissaient), mais le disque restait vide → au rechargement, la page repartait sur le modèle de départ et les modifs semblaient perdues. **C'est précisément pourquoi ça marchait sur le serveur Python (qui renvoie `{}`) et pas sur PHP.** Correctif : `_doc` est normalisé en véritable objet (`!Array.isArray`), avec une garde supplémentaire dans `saveDraft`/`publish`. **Reproduit sur un serveur php-portable réel (GET → `[]`), puis vérifié : éditer → publier → le brouillon ET la version publiée s'écrivent (5 sections), rechargement de l'éditeur = les modifs restent, et `index.html` affiche bien la version éditée.**

> Note : les hôtes Python (`dev_server.py`) n'étaient pas affectés (ils renvoient `{}`). Le correctif est
> côté client, donc il couvre **tous** les hôtes quel que soit le format renvoyé.

[Versioning] Plateforme Web → v1.14.6. changelog_1.14.6.md généré.
