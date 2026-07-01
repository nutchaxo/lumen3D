# Plateforme Web — v1.4.1

> **Correctif : création du mot de passe admin impossible sous le repli PHP.** Au premier accès au panneau d'administration, l'écran de création affichait « Échec de la création du mot de passe. » et la connexion échouait de la même manière — uniquement sur les hôtes servis par PHP (`api/*.php`, nouveau lanceur `start_php_server.bat` / `router.php`). Le serveur de dev Python n'était pas concerné. Cause : une `TypeError` PHP 8 non capturée dans le compteur anti-force-brute quand son fichier d'état n'existe pas encore. Vérifié cette fois **avec un runtime PHP réel** (PHP 8.3), ce qui manquait à la v1.4.0 (parité PHP écrite à l'aveugle).

## [FIXED]
- **`setup` / `login` fataux au premier lancement (repli PHP)** ([api/auth.php](../api/auth.php)) — `bf_load()` faisait `json_decode(@file_get_contents($LOCKOUT_FILE), true)`. Tant qu'aucune tentative n'a été enregistrée, le fichier de verrouillage (`sys_get_temp_dir()/iribhm_admin_lockout_*.json`) n'existe pas : `file_get_contents` renvoie `false` (le `@` masque l'avertissement de fichier absent, **pas** l'erreur de type), et en PHP 8 `json_decode(false, …)` lève une **`TypeError` non capturée**. La réponse devenait alors une page d'erreur HTML au lieu du JSON attendu → `JSON.parse` côté client échoue → message générique « Échec de la création du mot de passe. ». L'action `status` (seule à ne pas appeler `bf_locked()`) fonctionnait, d'où un panneau qui s'affiche mais dont setup/login échouent. Corrigé en gardant le retour `false` avant le décodage (`$raw !== false ? json_decode(...) : null`). Les garanties inchangées : création exclusive (`fopen('x')` → `409 already_configured` au second setup), verrouillage anti-force-brute, hash PBKDF2 interopérable.

## Notes
- Reproduit puis vérifié avec **PHP 8.3.31** via `php -S` + `router.php` (le montage réel du lanceur `start_php_server.bat`) : setup → `200 {ok:true}` + coffre `api/admin_credential.json` créé ; second setup → `409 already_configured` ; login bon mot de passe → `200` ; mauvais mot de passe → `401` (plus de fatale). Fichier de test supprimé après vérification.
- Aucun autre `json_decode(file_get_contents(...))` de l'API n'est vulnérable : les autres lisent `php://input` (toujours une chaîne, jamais `false`) et `admin_read_json()` garde déjà le cas `false`.

[Versioning] Plateforme Web → v1.4.1. changelog_1.4.1.md généré.
