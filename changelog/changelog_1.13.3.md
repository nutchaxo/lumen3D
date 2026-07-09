# Plateforme Web — v1.13.3

> **Legal affiché par défaut dans les footers, visibilité des pages perso, et atténuation des HTTP 429.**
> Suite de correctifs après test réel : la page Legal n'apparaissait dans aucun footer, la visibilité des
> pages personnalisées n'était pas réglable depuis l'éditeur, et le viewer échouait en 429 (rate-limit de
> l'hébergeur) faute de mise en cache des assets statiques.

## [FIXED]
- **Legal visible dans le footer par défaut** ([js/core/instance-config.js](../js/core/instance-config.js), [config/defaults/neutral/instance.json](../config/defaults/neutral/instance.json)) — `nav.showLegal` passe à **`true` par défaut** (défaut neutre + fallback `InstanceConfig`), donc le lien « Mentions légales » apparaît dans le pied de page dès l'installation (déplacé du header vers le footer en v1.13.2). Vérifié : lien dans le footer, absent de la navbar.
- **Footer ajouté à la page Explorer** ([explorer.html](../explorer.html)) — la page de navigation des données n'avait pas de footer ; le lien Legal y apparaît maintenant. Les vues plein écran (viewer, compare, tracking) restent sans footer (par conception).
- **Visibilité des pages personnalisées dans l'éditeur** ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js)) — l'onglet Pages affiche désormais une bascule **« Visible dans le menu »** pour chaque page personnalisée (écrit `nav.customPages[].show`, propagé au menu public). Pour les pages intégrées, un rappel indique que leur visibilité se règle dans l'onglet Identité › Navigation.

## [OPTIMIZED]
- **Cache des assets statiques (atténue les HTTP 429)** ([.htaccess](../.htaccess)) — la plateforme charge ~25 fichiers JS + CSS + polices par page (pas de bundler). Sans cache, chaque navigation re-télécharge tout, et sur les hébergeurs à limitation de débit agressive ce pic renvoie **HTTP 429** (le viewer/l'admin ne démarrent plus). Ajout d'en-têtes `Cache-Control`/`Expires` (mod_headers/mod_expires) pour que les JS/CSS/images/polices soient mis en cache une fois (les URLs portent `?v=…`, donc un cache long est sûr), réduisant le volume de requêtes d'un ordre de grandeur sur les navigations. Le HTML garde son `no-store` (nonce CSP par requête) ; les JSON de config restent revalidés. Note : ceci n'élimine pas le pic du **tout premier** chargement — un hébergeur au rate-limit très strict peut encore le déclencher ; le vrai correctif côté hôte reste d'assouplir la limite.

[Versioning] Plateforme Web → v1.13.3. changelog_1.13.3.md généré.
