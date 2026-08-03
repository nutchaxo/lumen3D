# Changelog — Plateforme Web v1.34.1

## [ADDED]

### Guide de l'administrateur illustré (`DOCS/admin-guide/`)

Un manuel complet du panneau d'administration, écrit pour un opérateur non-développeur qui n'a jamais ouvert le panneau — la documentation existante (`DOCS/update-system/`, `DOCS/plugin-sandbox/`, `DOCS/whitelabel/`) s'adresse à un implémenteur et ne couvrait pas cet usage.

* **`GUIDE-ADMINISTRATEUR.md`** — 13 chapitres, un par onglet du panneau, plus trois annexes (première installation, résolution de problèmes, glossaire). Chaque écran est décrit champ par champ, avec la conséquence de chaque action côté site public. Emplacement réservé, en tête de document, pour que l'opérateur y inscrive les identifiants à la main.
* **`img/` — 39 captures d'écran annotées** prises sur une instance réelle (datasets réels, volume rendu en WebGL2), avec encadrés, flèches et pastilles numérotées composés dans la page avant capture. Rendu en 2× : lisibles au zoom.
* Deux sujets traités en profondeur, à la demande : le **système de plugins** (les trois emplacements, les niveaux de confiance et l'empreinte de contenu, la procédure d'approbation avec ré-authentification, l'arbitrage bac-à-sable / in-page) et l'**éditeur de pages** (modèle section → colonne → élément, les 27 widgets, les onglets Contenu/Style/Avancé, brouillon vs publication, traduction, variables, raccourcis clavier).

`DOCS/*` étant ignoré par défaut, `.gitignore` gagne une exception `!DOCS/admin-guide/` — même schéma que les trois dossiers de documentation déjà suivis.

Les captures sont quantifiées sur palette adaptative lorsque l'écart au fichier d'origine reste imperceptible (erreur moyenne mesurée ≤ 0,7/255), et ré-encodées sans perte sinon : 14,0 Mo → 5,2 Mo.
