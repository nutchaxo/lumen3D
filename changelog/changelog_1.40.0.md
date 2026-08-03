# Changelog — Plateforme Web v1.40.0

## [ADDED]

### Mettre à jour les plugins depuis l'onglet Mises à jour

« Qu'est-ce qui a besoin d'être mis à jour ici ? » est **une** question, pas deux. L'onglet Mises à jour porte désormais, sous la mise à jour de la plateforme, une carte **Mises à jour des plugins**.

Elle compare ce qui est installé au catalogue signé — la même source que l'onglet Catalogue, donc les deux onglets ne peuvent pas se contredire sur la version d'un plugin — et n'offre le bouton que pour les plugins qui remplissent **les deux** conditions : une version plus récente existe, **et** elle se déclare compatible avec la plateforme en place.

Chaque ligne affiche le trajet (`v1.0.0 → v1.2.0`). Un bouton **Tout mettre à jour** apparaît dès qu'il y a plusieurs plugins à traiter : un seul mot de passe couvre le lot, l'opérateur ayant autorisé l'acte et non chaque échange de fichier.

### Les mises à jour bloquées sont montrées, pas escamotées

Un plugin dont la nouvelle version exige une plateforme plus récente apparaît dans une seconde liste, « Mises à jour qui attendent la plateforme », avec la raison. Le faire disparaître se lirait comme « rien à mettre à jour » — et l'opérateur chercherait longtemps pourquoi son plugin reste en retard.

### Une mise à jour ratée ne coûte pas le plugin

Le chemin d'installation existant a été étendu plutôt que dupliqué : `_install_marketplace_plugin(..., upgrade=True)` (jumeau PHP `mkt_install(..., true)`). Téléchargement, vérification sha256 / Ed25519 fail-closed, extraction durcie, approbation ré-épinglée sur les octets réellement posés : rien de tout cela ne change.

Ce qui change, c'est la bascule. La copie qui fonctionne est **mise de côté**, pas supprimée, jusqu'à ce que la nouvelle soit posée *et* approuvée. Tout échec après ce point la remet en place. Un opérateur qui demande une mise à jour ne peut pas se retrouver avec moins qu'avant.

Vérifié de bout en bout contre le catalogue réel : détection, téléchargement, vérification, bascule, approbation ré-épinglée, restauration après échec simulé, refus (404) d'une mise à jour d'un plugin absent, aucun dossier temporaire laissé derrière.

Nouvelle action `update_plugin` (POST, ré-authentifiée, CSRF), jumeaux Python et PHP.

## [FIXED]

### Les « Versions installées » ne montrent plus de version qui n'existe pas

La carte affichait trois chiffres, dont un que personne n'installe : **la version du serveur de développement**. Elle versionne l'outil qui sert les fichiers, dérive volontairement de la plateforme, et n'a aucun équivalent sur un hébergement PHP — juxtaposée à la version de la plateforme, elle ne pouvait que faire conclure que l'une des deux était fausse. Elle disparaît (`admin.devServer` retiré des quatre langues).

Une case sans valeur n'est plus affichée « — » : elle n'est pas affichée du tout.

### « Préprocessing » désigne enfin le pipeline téléchargeable

Le chiffre venait de `preprocess/run_preprocess.py`, un fichier que **la release ne contient pas**. Sur un hébergement, la carte annonçait donc « — » pour un pipeline pourtant proposé au téléchargement dans l'onglet Pipeline.

La version est maintenant lue dans le `VERSION.json` que le pack embarque (`_pipeline_pack_versions`, jumeau PHP `admin_pipeline_pack_versions`) : c'est la version du pipeline que l'opérateur peut réellement obtenir, et sur un hébergement c'est la seule copie présente. Le nom du fichier ne pouvait pas répondre — il ne code que la version de la plateforme. Repli sur les sources dans une copie de développement où aucun pack n'a encore été construit ; l'onglet est renommé « Pipeline de préprocessing » pour dire de quoi il s'agit.

### `_version_tuple` comparait « 1.4 » comme antérieur à « 1.4.0 »

Le jumeau Python ne complétait pas à trois composantes, contrairement à `admin_version_tuple` en PHP. Une version en deux parties se serait donc lue comme plus ancienne que sa propre écriture en trois parties — et aurait inventé une mise à jour à partir de rien, précisément dans la comparaison que cette version introduit.
