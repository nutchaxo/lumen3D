# Plateforme Web — v1.10.1

> **White-label — installation guidée (Objectif 3).** L'écran de première installation devient un
> **assistant multi-étapes** : compte administrateur → identité (nom, organisation, terminologie) →
> thème (couleur de marque) → textes essentiels (accroche, pied de page). Seule l'étape « compte » est
> obligatoire ; les étapes suivantes **amorcent** `config/instance.json` + `config/theme.json` via
> l'endpoint authentifié, et peuvent être passées (« Passer »). Objectif : la plateforme la plus simple
> possible à mettre en route. Voir [DOCS/whitelabel/PLAN.md](../DOCS/whitelabel/PLAN.md) §4.

## [ADDED]
- **Assistant d'installation multi-étapes** ([admpan.html](../admpan.html), [js/pages/admin/shell.js](../js/pages/admin/shell.js)) — l'écran `#setup-screen` (affiché quand aucun `api/admin_credential.json` n'existe) présente 4 étapes avec un indicateur de progression : **(1) Compte** (identifiant + mot de passe, création `create-exclusive` → session authentifiée) ; **(2) Identité** (nom de l'instance → `brand.name/shortName/productName/monogram`, organisation, `specimen` singulier/pluriel) ; **(3) Thème** (6 pastilles de couleur de marque pré-calculées) ; **(4) Textes** (accroche, copyright). À la fin, `finishWizard` écrit `config/instance.json` (fusionné) + `config/theme.json` (préréglage) via `/api/site.php` (session + CSRF), recharge `InstanceConfig`, puis entre dans le panneau. « Passer » finalise dès l'étape 2. Le flux fonctionne sur hôte **Python et PHP** (il pilote `/api/auth.php` + `/api/site.php`, tous deux jumelés).
- **Clés i18n `wizard.*`** ([lang/en.json](../lang/en.json), [lang/fr.json](../lang/fr.json), [lang/es.json](../lang/es.json)) — en/fr/es, **parité 907 clés**.

## [OPTIMIZED]
- **Minimum de mot de passe unifié à 8** ([dev_server.py](../dev_server.py) `_setup_credential`/`_change_credential`/`--set-password`, [api/_admin_lib.php](../api/_admin_lib.php) `admin_setup_credential`/`admin_change_credential`) — l'installation HTTP et le CLI passent de 4 à **8 caractères**, alignés sur `install.php` (`MIN_PASSWORD`) et sur la validation client de l'assistant. Fin de la divergence 4-vs-8.

## Notes
- **Vérification** : le panneau admin **démarre** (réécriture de `shell.js` valide, aucune erreur de module) ; la structure de l'assistant est présente (4 étapes, indicateur, boutons Suivant/Retour/Passer, pastilles de thème). Le minimum de mot de passe à 8 est appliqué côté Python (setup/change/CLI) et PHP (`_admin_lib.php`). Le **flux interactif complet de première installation** (création du compte → étapes → amorçage de la config) s'exerce sur une **installation vierge** (sans identifiant) — l'assistant mirroir fidèlement le flux `setup` éprouvé et réutilise l'endpoint `site.php` déjà vérifié.
- **Détection de première installation inchangée** : `needsSetup` reste basé sur l'absence de `api/admin_credential.json` — un déploiement déjà configuré ne ré-entre jamais dans l'assistant.
- **install.php** : le one-file installer crée le compte + l'arborescence `DATA_WEB` (min mot de passe déjà à 8) ; les déploiements ainsi initialisés personnalisent l'identité/le thème/les pages via les onglets admin (l'assistant guidé cible le premier lancement sans identifiant pré-créé). L'ajout des étapes de branding directement dans l'UI de `install.php` est un raffinement ultérieur.

[Versioning] Plateforme Web → v1.10.1. changelog_1.10.1.md généré.
