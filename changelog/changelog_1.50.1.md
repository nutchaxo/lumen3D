# Changelog v1.50.1 (Plateforme Web)

## [FIXED]
* **Les cinq outils réservés aux photographies (dont « Vue divisée ») apparaissaient dans la barre d'outils des volumes 3D et Live.** Le filtre par type de données de `PluginRegistry.loadModules()` n'était appliqué que si la page passait un `dataType` — et seule la page des photographies le faisait. Le visualiseur de volumes ne passait rien, donc *tous* les plugins découverts y étaient injectés, y compris `split-view`, `figure-panel`, `calibrated-grid`, `display-adjust` et `orientation-2d`, dont les API cibles (vue physique, superpositions 2D, recadrage d'image) n'existent pas dans le rendu volumique.

  Le filtre devient valable **dans les deux sens** : un plugin qui déclare ses `dataTypes` est pris au mot — il est chargé sur ces types et sur aucun autre. Un plugin qui n'en déclare aucun est antérieur au champ et a été écrit pour le visualiseur de volumes ; seule une page qui le demande explicitement (`allowUndeclaredDataTypes`) le charge. `viewer.js` passe désormais `dataType: datasetMeta.type` avec cette option, ce qui conserve intégralement ses plugins historiques et ceux du catalogue installés sans `dataTypes`. Aucun nom de type n'est codé en dur dans le registre : la valeur vient de la fiche du jeu de données.

  Corollaire : `screenshot`, `presentation-mode`, `download-center` et `measure-distance` déclarent maintenant aussi `tracking`, sans quoi l'aperçu d'un jeu de données de suivi cellulaire (que le panneau d'administration ouvre dans `viewer.html`) les aurait perdus.

  Vérifié dans le navigateur : sur un volume `fixed` puis `live`, le groupe « Dispositions » ne contient plus que `presentation-mode`, `decompose-channels` et `zstack-browser`, et les cinq outils 2D sont écartés sans mise en quarantaine ; sur une photographie, les neuf plugins attendus — « Vue divisée » comprise — restent chargés.

## [ADDED]
* **`tests/js/test_plugin_datatype_gate.mjs`** — couvre les trois cas du filtre (plugin déclarant le type, plugin déclarant un autre type, plugin n'en déclarant aucun) sur un hôte strict, sur le visualiseur de volumes et sans `dataType` du tout, et vérifie qu'un plugin écarté n'est pas mis en quarantaine.
* **`tests/js/test_plugin_autonomy.mjs` et `test_plugin_workspace_preinit.mjs` réparés.** Les deux étaient rouges depuis l'arrivée de la porte de confiance : `loadModules()` refuse d'injecter du code non vérifié quand `PluginTrust` est absent (échec fermé, voulu), et les deux bancs d'essai ne le simulaient pas. Ils fournissent désormais un verdict `dev` de substitution et atteignent à nouveau le registre lui-même.
