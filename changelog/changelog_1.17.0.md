# Plateforme Web — v1.17.0

> **L'éditeur de pages passe un cap : fonds animés, traduction centralisée et variables.** Un nouveau
> menu **Fond** propose 10 animations prédéfinies (5 passives, 5 réactives à la souris), toutes discrètes,
> fluides et paramétrables au clic. Un onglet **Traduire** rassemble tous les textes de la page avec une
> colonne par langue du site et une sauvegarde automatique. Un onglet **Variables** liste les `{variables}`
> utilisables dans les textes — dynamiques (heure, date, compteurs) ou fixes (définies par l'admin).
> Au passage : le menu couleur se replie enfin au re-clic, les dégradés de texte suivent l'alignement,
> chaque encart de statistiques a ses propres couleurs et « Derniers éléments » retrouve ses vignettes.

## [ADDED]
- **Fonds de page animés** ([js/core/page-background.js](../js/core/page-background.js), nouvel onglet **Fond** de l'éditeur) — 10 préréglages visuellement distincts, élégants et discrets :
  - **Passifs** : Particules flottantes, Vagues, Aurore, Ciel étoilé, Grille pulsante.
  - **Réactifs à la souris** : Constellation, Orbes parallaxe, Ondes du curseur, Champ de force, Halo lumineux.
  - Chaque préréglage expose ses paramètres (couleurs — avec le sélecteur riche —, quantité, taille, vitesse, amplitude, rayon, fréquence, opacité…) réglés **entièrement au clic** ; l'aperçu se met à jour en direct dans l'éditeur.
  - Techniquement : un seul canvas 2D derrière le contenu (`z-index:-1`), résolution des couleurs `var(--…)`/`color-mix` du thème, DPR plafonné à 2, pause automatique quand l'onglet est masqué, **une image statique si « réduire les animations » est activé**, aucun listener/rAF résiduel après démontage. Le fond est **par page** (stocké avec le brouillon/publication, `source.background`) et s'applique sur `page.html`, l'accueil et À propos (pages surchargées).
- **Onglet « Traduire »** ([js/pages/admin/pages-translate.js](../js/pages/admin/pages-translate.js)) — tous les textes de la page (titre de page, titres, paragraphes, boutons, FAQ, frises, alt d'images, libellés de stats…) réunis en une liste, **une entrée par langue disponible sur le site** (détection dynamique : 5 fichiers de langue ⇒ 5 colonnes). Compteur « X textes · Y traductions manquantes », entrées incomplètes ouvertes et marquées ⚠, **sauvegarde automatique** (brouillon, debounce 1,2 s) — publiez quand tout est prêt.
- **Variables `{nom}`** ([js/core/page-vars.js](../js/core/page-vars.js) + onglet **Variables**, [js/pages/admin/pages-variables.js](../js/pages/admin/pages-variables.js)) — tout texte de page peut contenir `{variable}` :
  - **Dynamiques** ⚡ (calculées au rendu) : `{year}`, `{date}`, `{time}`, `{datasetCount}`, `{specimenCount}`, `{cellCount}`, `{regionCount}`.
  - **De marque** (onglet Identité) : `{brand}`, `{specimen}`, … déjà existantes, désormais listées.
  - **Fixes** : créées par l'admin (ex. `{lastPubli}` = lien de la dernière publication), modifiables à tout moment dans l'onglet — chaque page qui les référence se met à jour. Persistées dans `config/instance.json`.
  - Chaque ligne de l'onglet copie `{nom}` dans le presse-papier au clic, avec badge dynamique/fixe et aperçu de la valeur actuelle.
- **Statistiques : couleurs par encart** — chaque stat peut définir son propre fond (couleur/dégradé), sa couleur de valeur (dégradé possible) et de libellé, avec repli sur les réglages globaux du widget.
- **« Derniers éléments » : vraies cartes** — vignette du dataset (`thumbnail`), nom, badge de type et date formatée ; hauteur de vignette réglable et méta masquable. (Régression « blocs de texte cliquables » corrigée.)

## [OPTIMIZED]
- **Barre latérale de l'éditeur réorganisée** en 5 onglets : Éléments · Réglages · Fond · Traduire · Variables.
- **i18n** : ~80 nouvelles clés en parité complète en/fr/es (presets et paramètres de fond, panneaux Traduire/Variables, nouveaux réglages de widgets).

## [FIXED]
- **Le menu couleur ne se repliait pas au re-clic** — la règle `.pbc-pop { display:flex }` l'emportait sur l'attribut `hidden` (les styles auteur battent le style UA quelle que soit la spécificité) ; ajout de `.pbc-pop[hidden] { display:none }`. Le chevron tourne aussi correctement (Lucide remplace le `<i>` par un `<svg>`, la rotation vise désormais un `<span>` conteneur stable).
- **Dégradés de texte mal centrés sur alignement gauche/droite** — `background-clip:text` peint sur la boîte de l'élément (pleine largeur) : le dégradé restait « centré ». La boîte épouse désormais le texte (`width:fit-content`) et se positionne par marges selon l'alignement (héros, titres, texte riche, valeurs de stats).

### Robustesse (revue adverse pré-publication)
- **Sauvegarde auto vs publication** — une sauvegarde auto de traduction en attente ne peut plus atterrir *après* une publication et écraser la version publiée : l'auto-save est annulée au début de chaque opération explicite (Brouillon, Publier, Défaut) et lors d'un changement de page.
- **Sauvegarde des variables ↔ onglet Identité** — l'onglet éditeur, ouvert dans son propre onglet et qui ne rechargeait jamais `instance.json`, réconcilie désormais les clés qu'il ne possède pas (marque, navigation, thème) avant d'écrire, pour ne plus écraser une modification d'Identité faite en parallèle.
- **Drapeau « non enregistré »** — l'auto-save ne désarme plus la protection de fermeture si une édition est survenue pendant l'envoi (compteur de génération d'édition) ; une valeur de variable est enregistrée immédiatement à la perte de focus.
- **Variables `{constructor}` / `{toString}`** — l'interpolation utilise une table sans prototype : les noms hérités d'`Object.prototype` ne sont plus résolus (plus de `[native code]` injecté dans le texte public).
- **Fond animé** — dimensionnement du canvas sur la zone visible hors barre de défilement (plus de rendu étiré ni de curseur décalé) ; densité de la grille plafonnée pour tenir le budget d'image sur écran 4K.
