# Plateforme Web — v1.18.1

> **Sécurité et anti‑perte de données de l'éditeur de pages.** Ce correctif ferme une faille XSS
> `javascript:` sur les liens de plusieurs widgets, empêche deux façons de détruire du contenu publié
> (le bouton « Réinitialiser » d'une page personnalisée et une « suppression » qui n'en était pas une),
> et ajoute plusieurs garde‑fous : garde « travail non enregistré » aussi dans l'éditeur intégré,
> nouvelle page masquée du menu jusqu'à sa publication, et écritures de `instance.json` réconciliées
> pour ne plus écraser une édition concurrente. Rendu strictement identique pour les pages existantes.

## [FIXED]

### Sécurité — liens `javascript:` neutralisés partout ([js/core/page-renderer.js](../js/core/page-renderer.js))
- Le garde‑fou `_safeHref` (refuse `javascript:` / `vbscript:` / `data:`) existait mais **n'était appliqué qu'à la moitié** des widgets porteurs de liens. Les cinq points qui prenaient la valeur brute — **image**, **bouton**, **CTA du héros**, **lien de carte icône**, **CTA du bandeau d'action** — passent désormais tous par le même garde‑fou (helper `_hrefOr`). Un lien dangereux retombe sur `#` (ou aucun lien pour l'image) au lieu d'aboutir dans le DOM.
- **Assainisseur du widget HTML renforcé** : `href` / `xlink:href` / `formaction` rejettent aussi `vbscript:` et `data:` (`data:text/html` était un vecteur), et tout lien `target=_blank` reçoit `rel="noopener noreferrer"`. Les images `data:` légitimes restent autorisées.

### Anti‑perte de données ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js))
- **« Réinitialiser » ne détruit plus le contenu publié d'une page personnalisée.** Ce bouton envoyait un `reset` pour n'importe quelle page ; une page personnalisée n'ayant pas de modèle par défaut, cela effaçait **brouillon et version publiée**. Désormais il ne réinitialise au modèle que les pages intégrées (Accueil / À propos) ; pour une page personnalisée il devient **« Annuler brouillon »** et se contente d'abandonner les modifications non publiées pour revenir à la version en ligne. Le libellé et l'info‑bulle du bouton s'adaptent au type de page.
- **« Supprimer une page » supprime réellement la page.** L'ancienne suppression réécrivait le fichier en `{}` et le laissait accessible publiquement à `page.html?slug=…` (orphelins invisibles qui s'accumulaient). Un vrai `action=delete` retire maintenant le fichier `config/pages/<slug>.json` du disque (côté serveur Python **et** PHP, limité à `pages/…`).
- **Page introuvable → redirection.** [js/pages/page-view.js](../js/pages/page-view.js) : une page absente/supprimée (ou un orphelin `{}` hérité) n'affiche plus une coquille vide à une URL publique — elle redirige vers l'accueil (les modes aperçu et édition ne sont pas affectés).

## [ADDED]

### Garde‑fous d'édition ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js))
- **Garde « modifications non enregistrées » généralisé** : l'alerte avant fermeture/rechargement était posée uniquement dans l'onglet éditeur dédié ; elle couvre désormais aussi l'éditeur **intégré** (fallback quand la pop‑up est bloquée).
- **Nouvelle page masquée jusqu'à publication** : une page fraîchement créée n'apparaît plus dans le menu public avec un contenu vide — elle est ajoutée en `show:false` et **révélée automatiquement à la première publication**.
- **Écritures `instance.json` réconciliées** : création et suppression de page relisent d'abord le document (comme le faisait déjà le réglage de visibilité) pour ne pas écraser une édition d'identité/navigation faite en parallèle dans un autre onglet.

### Confort d'authoring
- **Ajout au clic cohérent avec le glisser‑déposer** : cliquer un élément de la palette quand un widget est sélectionné l'insère **juste après** la sélection (au lieu d'en fin de colonne), comme le fait un dépôt.
- **Focus clavier visible** ([css/pages.css](../css/pages.css)) : les cartes‑liens à effet de survol (derniers jeux de données, cartes icône, galerie) affichent le même effet et un contour net **au focus clavier**, plus seulement au survol souris.
- **Widget cassé visible en édition** ([js/core/page-renderer.js](../js/core/page-renderer.js)) : un widget mal configuré affiche un encadré d'erreur sélectionnable (avec `console.warn`) dans l'éditeur au lieu de disparaître ; sur une page publiée il continue de se retirer proprement.

## [OPTIMIZED]

- **Icônes Lucide regroupées** ([js/core/page-renderer.js](../js/core/page-renderer.js)) : les ~10 passes `createIcons` par widget sont fusionnées en **une seule** passe par rendu (coalescée), supprimant le scintillement et la rafale de minuteurs sur les pages riches.
