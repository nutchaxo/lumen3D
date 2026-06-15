# Changelog v0.8.0 — Plateforme Web

## [ADDED]
- Panel admin complet (`/admpan.html`) avec authentification sécurisée
- 3 colonnes : liste datasets / preview viewer / config form
- Édition complète des métadonnées : nom, stade, embryon, description, lignée
- Cards canaux avec sliders min/max/gamma, color picker, toggle actif
- Mini-histogrammes par canal (depuis `bricks/manifest.json` si disponible)
- Calibration physique (voxel X/Y/Z µm)
- Preview live du viewer dans une iframe avec sync canaux via `postMessage`
- Rebuild catalog depuis l'interface
- Filtrage de la liste par type (fixed/live) et recherche textuelle

## [ADDED] PHP API (`api/`)
- `api/auth.php` — sessions PHP, bcrypt, lockout 5 tentatives / 15 min
- `api/datasets.php` — list/get/save/rebuild_catalog
- `api/config.php` — credentials (admin/iribhm2024)
- `api/.htaccess` — protection config.php

## [ADDED] Dev Server Python (`dev_server.py`)
- Remplace `http.server` simple pour le développement local
- Gère les routes API auth + datasets en Python pur (stdlib, pas de Flask)
- Sessions en mémoire avec brute-force protection
- Credentials dans `api/config.json` (SHA-256, généré automatiquement)
- `python dev_server.py --set-password` pour changer les identifiants

## [OPTIMIZED]
- CSS admin panel aligné avec la structure HTML (résolution du bug mismatch)
- Classes `.config-topbar`, `.config-field`, `.config-label`, `.config-input` ajoutées
- `#admin-app` démarre avec `display:none` (fix bug double affichage login/admin)
- `checkAuth()` wrappé avec try/catch (fix `501` sur http.server Python)
- Selectors JS corrigés pour matcher la structure HTML réelle

## [FIXED]
- Fix critique : CSS utilisait `.admin-main` (classe) mais HTML avait `#admin-main` (ID)
- Fix : login screen non full-screen car admin app visible en dessous
- Fix : `POST 501` car Python http.server ne supporte pas les requêtes POST
- Fix : anciennes processus Python bloqués depuis le 1 juin (3 jours) tués

## [OPTIMIZED] Preprocessing IMS
- Fix critique parsing attributs HDF5 : IMS stocke les strings comme `[b'3', b'7', b'8', b'9']`
- `attr_str()` reconstruit la chaîne en joinant les bytes individuels
