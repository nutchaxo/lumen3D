# Plateforme Web — v1.4.3

> **Bouton afficher / masquer par embryon dans l'onglet Datasets.** Chaque dataset de la liste porte désormais un bouton œil pour basculer sa visibilité dans l'explorer public d'un seul clic, sans avoir à l'ouvrir. Conforme à la demande : **aucun bouton de suppression** — le retrait d'un dataset reste une opération sur les fichiers.

## [ADDED]
- **Bascule de visibilité par dataset dans la liste** ([js/pages/admin/tab-datasets.js](../js/pages/admin/tab-datasets.js), [css/admpan.css](../css/admpan.css), [lang/en.json](../lang/en.json), [lang/fr.json](../lang/fr.json), [lang/es.json](../lang/es.json)) — un bouton œil sur chaque ligne : `eye` quand le dataset est visible (clic → masquer), `eye-off` ambré quand il est masqué (clic → afficher). Le clic est isolé (`stopPropagation` sur click **et** Enter/Espace) pour **ne pas** ouvrir/sélectionner le dataset. La logique de visibilité est factorisée dans `applyVisibility(id, hidden)`, partagée par le bouton de liste et la case à cocher du panneau de config : elle poste `set_visibility`, met à jour l'entrée en mémoire, synchronise l'éditeur ouvert si c'est le même dataset (miroir dans `draft`/`original` pour éviter un faux « non sauvegardé »), re-rend la liste et affiche un toast. Deux clés i18n ajoutées en parité EN/FR/ES (`admin.hideDataset`, `admin.showDataset`). Aucune commande de suppression n'est exposée (choix explicite : la suppression passe par les fichiers).

## Notes
- Vérifié au navigateur (serveur Python, 1280×900, authentifié) : les 17 datasets affichent le bouton (icône Lucide rendue) ; clic → dataset masqué (`is-hidden`, `eye-off`, badge « masqué », titre « Afficher dans l'explorer », `POST set_visibility` → 200) ; re-clic → visible ; le panneau de config **reste fermé** et aucune ligne n'est sélectionnée (isolation du clic confirmée) ; état restauré tout-visible en fin de test.
- La case à cocher « Visibilité » du panneau de config existante réutilise la même `applyVisibility` (comportement inchangé).

[Versioning] Plateforme Web → v1.4.3. changelog_1.4.3.md généré.
