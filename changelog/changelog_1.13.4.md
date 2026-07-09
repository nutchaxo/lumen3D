# Plateforme Web — v1.13.4

> **Correctif racine du HTTP 429 : bundling des scripts au build de release.** Le viewer chargeait ~35
> fichiers JS séparés par page ; sur les hébergeurs à limitation de débit agressive, cette rafale renvoyait
> **429** et le JS ne se chargeait jamais (viewer bloqué sur « Loading dataset… »). La release concatène
> désormais les scripts d'application de chaque page en **un seul bundle**, ramenant ~35 requêtes à ~3.

## [OPTIMIZED]
- **Bundling des scripts par page au build de release** ([tools/build_release.py](../tools/build_release.py)) — origine réelle du 429 identifiée : depuis le durcissement CSP (v1.6.0) les bibliothèques (Three.js ~600 Ko, Plotly, Lucide) sont **auto-hébergées** au lieu d'être chargées depuis des CDN externes ; combiné à ~6 fichiers JS ajoutés (white-label/sécurité), le viewer faisait **~35 requêtes, toutes vers l'hôte** (contre ~10 avant, les grosses libs venant du CDN d'un autre domaine non compté par le rate-limit). Le build concatène maintenant les scripts **locaux** (`js/…` hors `js/vendor/…`) de chaque page classique (index, explorer, viewer, compare, tracking, about, legal, page, widgets) en **`js/bundle/<page>.js`** et réécrit la page pour ne charger qu'**un** fichier — soit ~3 requêtes (bundle + libs vendor partagées). Sémantique préservée : les `const` de niveau supérieur restent dans la portée lexicale globale partagée (concaténées ou non), et le tag du bundle porte `nonce="{{CSP_NONCE}}"` pour les 3 scripts qui lisent `document.currentScript.nonce` (colorblind/plugin-registry/plugin-sandbox). **Aucun changement en dev** (le dépôt garde ses fichiers séparés) ; `admpan.html` est exclu (graphe de modules ESM non concaténable). Combiné aux en-têtes de cache (`.htaccess`, v1.13.3), le volume de requêtes vers l'hôte chute drastiquement.

[Versioning] Plateforme Web → v1.13.4. changelog_1.13.4.md généré.
