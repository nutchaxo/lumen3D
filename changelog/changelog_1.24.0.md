# Plateforme Web — v1.24.0

> **Les permissions des fichiers créés sont désormais héritées du dossier racine du site.**
> La v1.23.0 ne regardait qu'une chose : PHP tourne-t-il sous un utilisateur différent du
> propriétaire du site ? Un hébergement réel a montré la limite de ce raisonnement — sur celui de
> l'ULB, PHP **est** le propriétaire (`web1945`), donc aucun décalage détecté, aucun élargissement…
> et pourtant l'opérateur ne pouvait toujours rien téléverser. La racine y est en **`0770`** : le
> compte SFTP est un utilisateur *différent* du **même groupe**. Créer en `0755`/`0644` l'enfermait
> dehors aussi sûrement qu'un décalage de propriétaire.

## [CHANGED]

### Héritage du mode de la racine ([api/_admin_lib.php](../api/_admin_lib.php), [install.php](../install.php), [dev_server.py](../dev_server.py))
- Nouvelle règle, appliquée par les trois jumeaux (`admin_base_modes` / `base_modes` / `_base_modes`) : **dossiers = mode de la racine** (avec `u+rwx` garanti), **fichiers = même mode privé du bit d'exécution**. La racine est ce que l'hébergeur a configuré : elle encode déjà la façon dont ce site est partagé.
- Escalade en *world-writable* conservée **uniquement** pour le cas que l'héritage ne couvre pas : une racine n'accordant l'écriture qu'à son propriétaire, alors que PHP n'est pas ce propriétaire.
- Effet concret :

  | Racine | PHP = propriétaire ? | Dossiers / fichiers créés |
  |---|---|---|
  | `0770` (cas ULB) | oui | **`0770` / `0660`** — groupe, aucun accès « autres » |
  | `0755` | oui | `0755` / `0644` — inchangé |
  | `0775` | oui ou non | `0775` / `0664` |
  | `0755` | non | `0777` / `0666` — seul cas d'élargissement |
  | `0700` | oui | `0700` / `0600` — un site privé le reste |

- Bénéfice de sécurité : là où la v1.23.0 posait `0777`/`0666` sur un hébergement mutualisé, la v1.24.0 pose `0770`/`0660` — **aucune permission pour « autres »**, donc plus rien d'inscriptible par les autres locataires de la machine.

### Carte « Permissions des fichiers » plus explicite ([js/pages/admin/tab-security.js](../js/pages/admin/tab-security.js))
- Affiche maintenant le **groupe** du site et le **mode de la racine**, en plus de l'utilisateur PHP et du propriétaire : « PHP tourne sous le propriétaire du site (`web1945:client`) — racine en `0770`, fichiers créés en `0770` / `0660` ». C'est la lecture directe de la règle appliquée.
- `permissions_status` renvoie `siteGroup` et `groupWritable` (jumeaux PHP et Python).
- Traductions FR / EN / ES mises à jour (231 clés `admin`, parité vérifiée).

### Vérifié
- Table de vérité des six configurations d'hébergement réelles (dont `0770` propriétaire = PHP, et `0755` avec propriétaire tiers) : modes conformes au tableau ci-dessus.
- `dev_server.py --check` OK, lint PHP OK, syntaxe ESM OK.
- *Non vérifiable sur cette machine* : l'application effective des bits POSIX (Windows). La carte du panneau donne le verdict sur l'hôte réel.
