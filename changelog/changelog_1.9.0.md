# Plateforme Web — v1.9.0

> **White-label — éditeur de thème (Objectif 2a).** Premier outil de personnalisation sans code : un
> **éditeur de thème** dans le panneau admin permet à l'opérateur de régler la palette de marque, la
> police et l'arrondi des coins du **site public**, avec **aperçu en direct** et **retour au défaut**.
> Les réglages sont compilés côté serveur en une feuille `config/theme.css` servie (chargée après
> `themes.css` sur chaque page publique) — persistance sans flash, CSP-propre (pas de `<style>`
> injecté). Jumeaux Python **et** PHP. Bump de la ligne mineure (Y) : nouveau sous-système admin.

## [ADDED]
- **Éditeur de thème — onglet « Apparence »** ([js/pages/admin/tab-appearance.js](../js/pages/admin/tab-appearance.js), [admpan.html](../admpan.html), [js/pages/admpan.js](../js/pages/admpan.js)) — nouvel onglet ESM du panneau admin. Contrôles curés : **5 couleurs de marque** (primaire, accent, succès, erreur, avertissement) via sélecteurs de couleur ; chaque couleur pilote automatiquement sa **rampe dérivée** (hover +8 % clarté, dark −10 %, `-subtle` en rgba) pour rester cohérente ; **police** (Inter/Système/Grotesque/Serif/Arrondie) ; **arrondi des coins** (Standard/Net/Doux/Rond). **Aperçu en direct** dans une iframe même-origine de la page publique : les modifications non enregistrées sont appliquées via **CSSOM `setProperty`** sur le `<html>` de l'iframe (attribut `style` → autorisé par `style-src-attr`), jamais un `<style>` injecté (bloqué par `style-src-elem`). Seuls les tokens réellement modifiés sont écrits ; les autres retombent sur `css/variables.css`. Boutons **Enregistrer** / **Réinitialiser** (retour au défaut neutre).
- **Store de thème + compilation CSS** ([config/theme.json](../config/theme.json), [config/theme.css](../config/theme.css), [config/defaults/neutral/theme.json](../config/defaults/neutral/theme.json)) — `config/theme.json` (`{tokens, dark, light}`) est **compilé** par le serveur en `config/theme.css` : un bloc `:root{…}` (tokens structurels) + `[data-theme="dark|light"]{…}` (surfaces), chargé par `<link>` **après** `themes.css` sur les 7 pages publiques (donc il gagne la cascade). L'instance IRIBHM ship des overrides **vides** → aspect par défaut inchangé. Clés i18n `appearance.*` + `admin.navAppearance` ajoutées en **en/fr/es** (parité 769 clés).

## [OPTIMIZED]
- **Endpoint `/api/site.php` — hook thème (jumeaux Python + PHP)** ([dev_server.py](../dev_server.py) `_generate_theme_css`/`_regenerate_theme_css`, [api/site.php](../api/site.php) `site_generate_theme_css`) — sur `save`/`reset` du doc `theme`, le serveur régénère `config/theme.css` atomiquement (0644, public). **Scrub des valeurs CSS** : les caractères pouvant s'échapper d'une déclaration (`{ } ; < > \ @`) sont retirés et la valeur est plafonnée à 200 car., de sorte qu'une entrée opérateur ne peut jamais corrompre la feuille (une nouvelle règle CSS ne peut pas être injectée). Noms de tokens validés (`^--[A-Za-z0-9-]+$`). `_atomic_write` gagne un paramètre `mode` (0644 pour la config publique, vs 0600 des secrets `api/`).

## Notes
- **Vérification** : flux `save → génération → reset` testé au niveau serveur (Python) — l'override `--color-primary:#ff0000` est bien compilé dans `config/theme.css` puis effacé au reset ; le scrub neutralise un `red; } body{…}` injecté (plus de `;{}`). Le panneau admin **démarre** avec l'onglet Apparence enregistré (graphe de modules ESM valide, aucune erreur). `config/theme.css` servi (200, `text/css`) et lié sur les pages publiques ; parité i18n re-vérifiée (769 clés × 3). Le flux UI interactif (édition en direct, enregistrement) est protégé par l'authentification admin — à exercer par l'opérateur connecté.
- **Portée du thème** : l'éditeur cible les tokens de `variables.css` (palette de marque, police, arrondis). Les quelques `#hex` en dur (texte forcé blanc/sombre sur boutons colorés, options `<select>` — cf. limitations connues du système de thème) ne suivent pas encore une re-palette extrême ; leur tokenisation est un raffinement ultérieur. L'échelle d'espacement complète n'est pas exposée (impact moindre, complexité multi-tokens).
- **Police** : les familles proposées dégradent proprement vers des polices système sans charger de nouveau fichier ; le support de familles Google arbitraires (avec injection du `<link>` fonts) est un ajout futur (le CSP autorise déjà `fonts.googleapis.com`).
- Feuille de route : [DOCS/whitelabel/PLAN.md](../DOCS/whitelabel/PLAN.md) §3.1.

[Versioning] Plateforme Web → v1.9.0. changelog_1.9.0.md généré.
