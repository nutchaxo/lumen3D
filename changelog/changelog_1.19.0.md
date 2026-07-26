# Plateforme Web — v1.19.0

> **L'éditeur de pages devient sûr et confortable.** Cette version apporte les grands manques
> attendus d'un éditeur à la Elementor : **annuler / rétablir** (Ctrl+Z / Ctrl+Maj+Z), une
> **sauvegarde automatique** du brouillon avec indicateur d'état, des **raccourcis clavier**, et une
> **palette utilisable au clavier**. Le glisser‑déposer gagne le **défilement automatique** près des
> bords et ne peut plus se bloquer (gestion du `pointercancel`), l'éditeur ne **saute plus** à chaque
> frappe, et les sélecteurs de couleur/icône se **ferment** enfin au clic extérieur ou avec Échap.

## [ADDED]

### Annuler / Rétablir ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js))
- **Historique borné** (60 pas) du modèle de travail : chaque changement de structure est capturé aussitôt, les saisies de texte sont regroupées (une rafale de frappe = un seul pas d'annulation).
- **Boutons Annuler / Rétablir** dans la barre de l'éditeur + raccourcis **Ctrl/Cmd+Z** et **Ctrl/Cmd+Maj+Z** (ou Ctrl+Y). Les boutons se désactivent aux extrémités de l'historique.
- Rend **toutes les suppressions réversibles** — supprimer un widget par erreur n'est plus définitif.

### Sauvegarde automatique + état ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js))
- Le **brouillon** se sauvegarde automatiquement (débounce) après chaque modification — plus seulement dans l'onglet Traduire. La publication reste un acte volontaire.
- **Indicateur d'état** dans la barre : « ● Non enregistré » puis « ✓ Enregistré à HH:MM ».
- Le **garde « travail non enregistré »** couvre désormais l'éditeur intégré **et** la navigation entre onglets de l'admin (plus seulement l'onglet Datasets).

### Raccourcis clavier (éditeur) ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js))
- **Ctrl/Cmd+S** enregistre le brouillon · **Suppr / Retour arrière** supprime le widget sélectionné · **Ctrl/Cmd+D** le duplique · **Échap** désélectionne. Neutralisés pendant la saisie dans un champ.

### Accessibilité
- **Palette utilisable au clavier** : ajouter un élément avec **Entrée / Espace** sur un bouton de la palette (auparavant seul le pointeur fonctionnait — bloquant pour la navigation clavier).
- **Champ de recherche** en haut de la palette pour filtrer les 21 éléments par nom.
- **Sélecteurs couleur/icône** : fermeture au **clic extérieur** et à **Échap**, plus `aria-haspopup` / `aria-expanded` sur le déclencheur et `role="dialog"` sur le panneau — fini les popovers qui s'empilent.
- **Rôles ARIA** : `role="radiogroup"`/`radio` + `aria-checked` sur les contrôles segmentés, `role="tablist"`/`tab` + `aria-selected` sur les onglets Contenu · Style · Avancé.

## [FIXED]

### Robustesse du glisser‑déposer ([js/core/page-edit-frame.js](../js/core/page-edit-frame.js))
- **`pointercancel` géré** pour le déplacement de widget et le redimensionnement de colonnes : un clic droit, une interruption tactile ou une perte de focus ne laisse plus le curseur bloqué en « saisie », l'indicateur affiché et un dépôt/redimension fantôme au clic suivant. Le nettoyage est partagé et ne valide rien en cas d'annulation.
- **Défilement automatique** près du haut/bas de la fenêtre pendant un glisser (réordonnancement **et** dépôt depuis la palette) : on peut enfin déposer un élément dans une colonne située sous la ligne de flottaison d'une page haute.

## [OPTIMIZED]

- **Plus de saut de vue à chaque frappe** ([js/core/page-edit-frame.js](../js/core/page-edit-frame.js)) : la position de défilement est préservée lors du re‑rendu complet de la surface d'édition, au lieu de ramener la vue en haut à chaque caractère saisi.
