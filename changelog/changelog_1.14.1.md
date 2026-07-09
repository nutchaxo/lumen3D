# Plateforme Web — v1.14.1

> **Cache-busting automatique des CSS/JS — fini le « j'ai mis à jour mais rien ne change ».**
> Après une mise à jour, le navigateur pouvait continuer à servir l'ANCIEN JavaScript de l'admin et
> l'ANCIENNE CSS pendant jusqu'à 7 jours : la page Pages affichait l'ancien éditeur (au lieu de
> l'éditeur pleine page v1.14.0) et les menus déroulants `<select>` restaient illisibles (le correctif
> v1.13.7 était pourtant présent sur le disque). Cause : la CSS et surtout les **modules ESM de
> l'admin** étaient référencés **sans numéro de version** dans l'URL, alors que le `.htaccess` les met
> en cache 7 jours. Les `?v=` posés à la main sur quelques balises dérivaient et ne couvraient pas les
> `import` ESM.

## [FIXED]
- **CSS/JS servis périmés après une mise à jour** ([tools/build_release.py](../tools/build_release.py)) — la construction de release **estampille désormais `?v=<version>` automatiquement** sur **chaque** URL locale de CSS et de JS dans le HTML, **et** sur **chaque spécificateur d'`import` ESM de l'admin** (`js/pages/admpan.js` + `js/pages/admin/*.js`, invisibles depuis le HTML). Un changement de version change donc **toutes** les URL d'assets → le navigateur ne peut plus servir un ancien fichier depuis son cache long. Conserve l'avantage du cache long (`.htaccess` `max-age=604800`) tout en garantissant la fraîcheur après chaque mise à jour. Exclusions : `js/vendor/**` (immuable + SRI) et `js/bundle/**` (déjà hashé par contenu). `config/theme.css` reste busté par le serveur via son mtime (pour les changements de thème en direct).
- **Menus déroulants `<select>` illisibles DANS LE PANEL ADMIN** ([css/admin-shell.css](../css/admin-shell.css)) — le correctif v1.13.7 vivait dans `themes.css`/`base.css`, mais le panel d'administration ne charge **que** `admpan.css` + `admin-shell.css` (jamais `themes.css`) : la liaison `color-scheme` ne l'atteignait donc pas et ses `<select>` restaient illisibles (popup blanc + texte clair sur OS clair). Ajout de la même liaison au thème de l'app dans `admin-shell.css` (`color-scheme: dark` sous `[data-theme="dark"]`, `light` sous `[data-theme="light"]`, sur `:root`) + couleurs d'`option` explicites par thème. Vérifié : `color-scheme` calculé de l'admin = `dark`/`light` selon `data-theme`. (Ce correctif n'apparaît que grâce au cache-busting ci-dessus.)

## [OPTIMIZED]
- **Récupération automatique à la prochaine mise à jour** — `*.html` est servi en `no-store` (nonce CSP par requête), donc dès qu'un hôte applique une release estampillée, le HTML frais référence des URL d'assets neuves et tout le graphe (CSS + entrée admin + modules ESM importés) est re-téléchargé une fois, sans intervention. Fonctionne sur hôte statique, PHP/Apache et le serveur Python.

> **Note pour l'opérateur déjà bloqué sur une version antérieure :** un **rechargement forcé** (Ctrl+Shift+R, ou Cmd+Shift+R) de la page d'administration suffit à voir immédiatement la version déjà installée. À partir de la v1.14.1, ce n'est plus nécessaire : la mise à jour suivante rafraîchit tout automatiquement.

[Versioning] Plateforme Web → v1.14.1. changelog_1.14.1.md généré.
