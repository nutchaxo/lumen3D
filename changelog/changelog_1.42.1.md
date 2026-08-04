# Changelog — Plateforme Web v1.42.1

## [FIXED]

### Le guide de l'administrateur rattrape six versions de plateforme

Le guide décrivait le panneau tel qu'il était en v1.36.0. Depuis, quatre versions ont changé ce que voit l'opérateur, et le document ne le disait pas. Les quatre éditions — française, anglaise, néerlandaise, espagnole — sont à jour de la v1.42.0.

**Nouveau chapitre 10 — Documentation.** L'onglet ajouté en v1.39.0 n'avait aucun chapitre. Il en a un : d'où viennent les documents (du dépôt, pas de l'installation — donc un guide corrigé arrive sans mise à jour du site), comment la langue est choisie, comment retrouver une version précédente, ce qui s'affiche dans le panneau et ce qui se télécharge, et la règle de nommage pour publier. Les chapitres 10 à 13 deviennent 11 à 14, avec leurs sous-sections, leurs entrées de sommaire, leurs ancres et tous les renvois.

**Mise à jour des plugins** (v1.40.0, v1.41.0) — la fonction existe dans trois onglets et n'était documentée nulle part. Nouvelles sections **5.6**, **6.2** et **8.4**, chacune renvoyant aux deux autres : c'est la même action, faite là où l'opérateur regarde. Toutes énoncent la règle qui décide de l'apparition du bouton — une version plus récente existe **et** elle se déclare compatible — et le fait que la copie qui fonctionne est mise de côté, pas supprimée, jusqu'à ce que la nouvelle soit posée et approuvée.

**Chapitre 9 — Pipeline** réécrit sur la structure actuelle de l'onglet : la carte « Le principe » et son schéma en quatre étapes, le choix d'édition ramené à une seule question, et l'explication des deux numéros de version qui ne se suivent plus (le pack porte celle du préprocessing depuis la v1.42.0, pas celle du site).

**Corrections de fond**, toutes vérifiées contre le code :

* le menu compte **12** rubriques, pas 11 ;
* l'onglet Mises à jour affiche **deux** numéros de version — la ligne « Serveur de dev » a disparu en v1.40.0 — et une ligne sans valeur n'est pas affichée du tout ;
* le Catalogue a **quatre** sections, « À mettre à jour » venant en premier ;
* l'étiquette `incompatible` ne concerne plus que les plugins **non installés** : un plugin installé qui fonctionne ne la porte pas, seule sa version suivante peut attendre ;
* la mention « signature vérifiée » est conditionnelle — un serveur sans clé affiche « non signé » ;
* le bouton **Révoquer** n'existe que sur un plugin approuvé par l'opérateur, jamais sur un plugin intégré ;
* l'interrupteur d'activation est **absent** sur un plugin non fiable et **grisé** sur un plugin protégé ou incompatible ;
* les plugins ne sont pas livrés avec le site, ils s'installent à la demande — le chapitre 5.7 le dit maintenant, et liste le 17ᵉ plugin qui manquait au tableau.

Les captures sont refaites dans les quatre langues pour les onglets Mises à jour, Plugins, Catalogue, Pipeline, la barre latérale et le nouvel onglet Documentation : 43 par langue, 172 au total. L'état « mise à jour disponible » n'est pas simulé — trois plugins du catalogue signé en avaient réellement une.

Un contrôle automatique vérifie ce qu'une relecture ne voit pas : numérotation des chapitres, sous-sections rattachées au bon chapitre, ancres de sommaire résolvant vers un titre réel, images pointant vers le dossier de leur langue et présentes sur le disque, renvois vers un chapitre existant, version en pied de document. Les quatre éditions passent ; les 531 pages des cinq PDF passent aussi le contrôle de mise en page.

## [ADDED]

### Deuxième version publiée dans la bibliothèque

`260804 - GUIDE-ADMIN - {FR,EN,NL,ES,MULTI}.pdf` rejoint la version du 3 août dans `DOCS/`. L'onglet Documentation propose la plus récente et range l'autre sous « Versions précédentes (1) » — vérifié dans le panneau, pour les cinq langues.
