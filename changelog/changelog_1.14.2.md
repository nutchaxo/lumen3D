# Plateforme Web — v1.14.2

> **L'éditeur s'ouvre dans son propre onglet (vrai modèle Elementor), la page Accueil n'est plus
> « vide » dans l'éditeur, et — surtout — les hébergements PHP peuvent enfin se mettre à jour en un
> clic.** Jusqu'ici `update_apply` répondait `unsupported_on_php` : sur un mutualisé, chaque correctif
> exigeait de vider le dossier et de réinstaller (c'est pourquoi le correctif v1.14.1 des menus
> déroulants n'était jamais arrivé chez l'opérateur).

## [ADDED]
- **Mise à jour en un clic sur hébergement PHP** ([api/_admin_lib.php](../api/_admin_lib.php) `admin_update_apply_php`, [api/admin.php](../api/admin.php)) — le serveur Python se met à jour par bascule Blue-Green car il doit redémarrer un processus ; PHP est par-requête (rien à redémarrer), donc la mise à jour devient : télécharger le zip de release → vérifier (sha256 via `SHA256SUMS`, + signature Ed25519 **fail-closed** quand la clé `LUMEN_RELEASE_PUBKEY` est épinglée — jumelle de `dev_server._RELEASE_PUBKEY_HEX` / `install.php`) → extraction en zone de transit **sous la racine web** (même volume, pas d'EXDEV) → remplacement fichier par fichier en sautant l'état opérateur (`admin_update_protected` : `config/instance.json|theme.json|theme.css|legal.json`, `config/pages/`, `DATA_WEB/`, `js/modules/` (plugins installés), credentials/trust, + fichiers Python inutiles sur PHP). Synchrone (~6 s pour 344 fichiers) : la réponse porte directement le résultat. Testé bout-en-bout sur un site isolé : 1.14.0 → 1.14.1, config opérateur intacte, aucun résidu, l'API répond après s'être remplacée elle-même.
- **Remplacement robuste des fichiers occupés** — l'ancien fichier est d'abord **renommé de côté** (`*.lumen-old`, autorisé même ouvert) pour libérer le nom atomiquement ; si le nom reste bloqué (verrou antivirus…), le nouveau fichier est parqué en `*.lumen-new` et `admin_update_finish_pending()` (appelé en tête d'`admin.php`/`auth.php`, no-op sans marqueur) finalise l'échange à la requête suivante, en sautant le script en cours d'exécution.
- **Éditeur de pages dans son propre onglet** ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js), [shell.js](../js/pages/admin/shell.js), [css/admin-shell.css](../css/admin-shell.css)) — « Modifier avec l'éditeur » ouvre `admpan.html?editor=<slug>` dans un **nouvel onglet** : le shell admin masque sa barre latérale et sa barre du haut (`body.adm-editor-only`) et démarre directement sur l'éditeur pleine-fenêtre (page réelle dans l'iframe + panneau Éléments/Réglages à gauche) — exactement le modèle Elementor demandé. Le sélecteur de page met l'URL à jour (`?editor=…`) ; « Quitter » ferme l'onglet ; popup bloquée → repli sur l'éditeur plein écran dans l'admin.

## [FIXED]
- **« Blank page » en ouvrant Accueil / À propos dans l'éditeur** ([tab-pages.js](../js/pages/admin/tab-pages.js)) — les pages intégrées n'ont aucune section stockée (leur défaut est du HTML statique), l'éditeur s'ouvrait donc sur une surface vide — faux et déroutant (la vraie page d'accueil est tout sauf vide). L'éditeur **charge automatiquement le modèle de départ** (héros + derniers datasets / titre + texte) quand aucune version par blocs n'existe, avec une notice « Modèle de départ — la page publiée garde sa mise en page intégrée tant que vous ne publiez pas ». Rien n'est enregistré tant que l'opérateur ne sauvegarde/publie pas.
- **Onglet Mises à jour : résultat synchrone** ([tab-updates.js](../js/pages/admin/tab-updates.js)) — quand `update_apply` répond avec `applied` (hôte PHP), l'UI affiche la réussite et recharge la page (le HTML frais référence les assets `?v=<version>` → tout le cache est busté d'un coup, grâce au stamping v1.14.1).

> **Dernière étape manuelle pour les hôtes PHP déjà installés (≤ v1.14.1)** : leur `api/` ne contient pas
> encore ce code — écraser le dossier `api/` avec celui du zip v1.14.2 (sans supprimer le dossier :
> `admin_credential.json` doit rester), puis Mises à jour → « Mettre à jour ». Toutes les mises à jour
> suivantes se font en un clic.

[Versioning] Plateforme Web → v1.14.2. changelog_1.14.2.md généré.
