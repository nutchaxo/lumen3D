# Changelog — Plateforme Web v1.41.0

## [ADDED]

### Mettre à jour un plugin depuis l'endroit où on le regarde

La mise à jour de plugins n'existait que dans l'onglet Mises à jour. Un opérateur qui ouvre **Plugins** ou **Catalogue** y voit pourtant exactement les mêmes plugins, et n'avait aucun moyen d'agir sans changer d'onglet. Les trois onglets offrent désormais la même action, avec la même règle : le bouton n'apparaît que si une version plus récente existe **et** qu'elle se déclare compatible avec la plateforme installée.

**Onglet Plugins** — chaque ligne concernée porte l'étiquette « màj disponible », le trajet `v1.0.0 → v1.1.0` et son bouton ; un bandeau compte les plugins à traiter et « Tout mettre à jour » apparaît au-delà d'un seul. Une version plus récente mais trop exigeante affiche sa raison au lieu d'un bouton.

**Onglet Catalogue** — les plugins à mettre à jour sortent de « Installés » dans une section **À mettre à jour** qui passe en premier : une mise à jour est datée, un plugin déjà installé ne l'est pas. La carte montre `v1.0.0 → v1.1.0` plutôt que la seule version du catalogue, et « Mettre à jour » se place à côté de « Désinstaller ».

### Une seule implémentation, pas trois

Les mécaniques communes vivent dans `js/pages/admin/plugin-update.js` : lecture du catalogue signé, mise en forme du trajet de versions, saisie du mot de passe, boucle de mise à jour, traduction des erreurs. Les trois onglets l'appellent ; aucun ne redérive « à jour ou non » depuis des chaînes de version — c'est le serveur qui tranche, une fois.

Un verrou au niveau du module empêche deux onglets d'échanger des dossiers de plugins en même temps.

### L'onglet Plugins n'attend pas le réseau

Le catalogue est sur GitHub : il est chargé **après** la liste des plugins, sans la bloquer. Activer et désactiver un plugin reste la fonction première de cet onglet et continue de fonctionner catalogue injoignable — les affordances de mise à jour apparaissent simplement quand (et si) la réponse arrive, sans message d'erreur pour une information accessoire.

## [FIXED]

### Un plugin installé et fonctionnel n'est plus étiqueté « incompatible »

Dans le Catalogue, le champ `compat` décrit la **dernière version publiée**, pas celle qui est sur le disque. Un plugin installé, chargé et parfaitement fonctionnel se voyait donc marqué « incompatible » dès que la version suivante du catalogue exigeait une plateforme plus récente — l'opérateur pouvait raisonnablement conclure que son plugin ne marchait plus.

Le badge est désormais réservé aux plugins **non installés**, où il dit vrai (« vous ne pouvez pas l'installer »). Pour un plugin installé, c'est la note de mise à jour bloquée qui porte l'information exacte : la version en place va bien, c'est la suivante qui attend.
