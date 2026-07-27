# Plateforme Web — v1.23.1

> **La carte « Permissions des fichiers » annonçait un échec alors que le serveur travaillait
> correctement.** Le code de l'onglet Sécurité lisait la réponse de l'API au mauvais endroit
> (`r.data` alors que `apiFetch()` renvoie déjà l'objet JSON) : quel que soit le résultat réel,
> l'état s'affichait « indisponible » et la réparation « échouée ». Les deux appels étaient pourtant
> traités normalement côté serveur.

## [FIXED]

### Onglet Sécurité — lecture de la réponse d'API ([js/pages/admin/tab-security.js](../js/pages/admin/tab-security.js))
- Passage à `apiFetchStatus()` (qui renvoie bien `{ ok, status, data }`) pour les deux actions `permissions_status` et `repair_permissions`. La carte affiche de nouveau l'utilisateur PHP, le propriétaire du site et les modes en vigueur, et la réparation rapporte le nombre réel d'entrées corrigées.
- **Les messages d'échec portent désormais le statut HTTP et le code d'erreur** (`… (HTTP 400 — Unknown action)`). Un « indisponible » nu ne dit rien ; avec le statut, on distingue immédiatement un point d'entrée absent (fichier `api/admin.php` non mis à jour ou servi depuis l'opcache) d'une erreur d'exécution.

### Le parcours des permissions ne meurt plus sur un dossier illisible ([api/_admin_lib.php](../api/_admin_lib.php), [install.php](../install.php))
- `RecursiveDirectoryIterator` **lève une exception** sur un dossier que PHP ne peut pas ouvrir, ce qui interrompait toute la requête au milieu du parcours (réponse 500, donc « échec » sans explication). Les trois parcours (`admin_apply_tree_modes`, `mkt_modes_recursive`, `apply_tree_modes` de l'installeur) utilisent maintenant `CATCH_GET_CHILD` : le sous-arbre illisible est ignoré, le reste est traité.

### Vérifié
- Les deux points d'entrée appelés en session admin réelle renvoient le JSON attendu (`{"posix":…,"split":…,"dirMode":…}` et `{"fixed":…,"failed":…,"scanned":…}`).
- Carte montée dans un navigateur avec un double de `shared.js` rejouant ces réponses exactes : affichage « PHP (www-data) ≠ propriétaire du site (ulbuser) — les fichiers créés utilisent 0777 / 0666 », puis clic sur *Réparer* → « 1423 entrées corrigées (2 échecs). »
- Scénario d'erreur rejoué : « État des permissions indisponible. (HTTP 400 — Unknown action) » et « Échec de la réparation des permissions. (HTTP 500) ».
