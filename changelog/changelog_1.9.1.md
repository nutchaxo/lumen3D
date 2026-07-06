# Plateforme Web — v1.9.1

> **White-label — identité & mentions légales (Objectif 2b, 1re partie).** Deux nouveaux onglets admin
> permettent de personnaliser **sans code** : **Identité** (marque, terminologie de l'échantillon,
> SEO, pied de page, navigation — avec **champs multilingues**) et **Mentions légales** (texte éditable
> par section, multilingue, mise en page fixe) rendu par une nouvelle page publique `legal.html`.
> Suite de l'éditeur de thème [v1.9.0](changelog_1.9.0.md). Voir [DOCS/whitelabel/PLAN.md](../DOCS/whitelabel/PLAN.md) §3.3–3.4.

## [ADDED]
- **Onglet « Identité »** ([js/pages/admin/tab-branding.js](../js/pages/admin/tab-branding.js)) — édite `config/instance.json` via `/api/site.php` : identité (nom d'instance/court/produit, monogramme, emoji logo, organisation, lien org), **terminologie de l'échantillon** (singulier/pluriel), accroche & SEO (description, mots-clés), pied de page (copyright + liste de liens éditable), et **navigation** (afficher/masquer Explorer/Comparer/Suivi/À propos/Mentions légales). Les champs naturellement dépendants de la langue (terminologie, accroche, SEO, copyright) sont édités comme **champs localisés** (une saisie par locale disponible) — conformément à l'exigence multilingue ; les champs d'identité (noms propres, URL) restent à valeur unique. À l'enregistrement, les pages publiques reflètent le changement au chargement suivant (tête injectée par le serveur + `data-instance`).
- **Onglet « Mentions légales »** ([js/pages/admin/tab-legal.js](../js/pages/admin/tab-legal.js)) — éditeur purement textuel : liste de sections (titre + corps), **multilingue** via un sélecteur de « langue d'édition » (une langue à la fois pour un texte long lisible), ajout/suppression de section. Persiste `config/legal.json`.
- **Page publique `legal.html` + rendu** ([legal.html](../legal.html), [js/pages/legal.js](../js/pages/legal.js)) — mise en page fixe (chrome de marque via `data-instance`, tête injectée), rend `config/legal.json` : titres en `<h2>`, corps découpé en paragraphes sur les lignes vides, **`textContent` uniquement** (aucune injection HTML). Locale courante avec repli `en` ; re-rendu au changement de langue. Reliée depuis la nav quand `nav.showLegal` est activé.
- **Clés i18n `branding.*`/`legal.*` + `admin.navBranding`/`admin.navLegal`** ([lang/en.json](../lang/en.json), [lang/fr.json](../lang/fr.json), [lang/es.json](../lang/es.json)) — en/fr/es, **parité 824 clés** vérifiée.

## Notes
- **Vérification** : le panneau admin **démarre** avec les 8 onglets (datasets, stats, plugins, sécurité, mises à jour, **identité**, apparence, **légal**) — graphe de modules ESM valide, aucune erreur. `legal.html` rend correctement (tête injectée, marque/pied de page liés, état vide affiché quand aucune section). Parité i18n re-vérifiée (824 × 3). Le flux d'édition/enregistrement est protégé par l'authentification admin — à exercer connecté.
- **Sécurité** : le rendu légal utilise `textContent` (pas `innerHTML`) — le texte opérateur ne peut pas injecter de balise. Les écritures passent par `/api/site.php` (session + CSRF) ; `config/*.json` restent publics mais protégés de l'auto-update (`_UPDATE_PROTECT`).
- **À propos (about.html)** : ses blocs de contenu scientifique restent en place ; ils deviendront éditables via le **constructeur de pages par blocs** (prochaine version).

[Versioning] Plateforme Web → v1.9.1. changelog_1.9.1.md généré.
