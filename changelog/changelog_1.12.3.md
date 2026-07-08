# Plateforme Web — v1.12.3

> **Installation white-label — le compte admin passe à l'assistant.** L'installateur ne crée plus le compte
> administrateur : il ne fait que préparer l'infrastructure, puis l'**assistant guidé** de la plateforme
> (identité + thème + textes + compte + plugins) se lance à la première visite. La release embarque les
> **défauts neutres** de config pour qu'une install fraîche démarre sans identité imposée.

## [FIXED]
- **`install.php` ne crée plus le compte administrateur** ([install.php](../install.php)) — l'étape de configuration ne collecte plus de nom d'utilisateur / mot de passe et n'écrit plus `api/admin_credential.json`. Elle prépare uniquement l'infrastructure (`api/.htaccess` + dossiers `DATA_WEB/*` + `catalog.json`), puis marque l'état `configured`. Conséquence : après installation, `needsSetup` reste vrai → **l'assistant de première installation complet** (compte + identité + thème + textes + sélecteur de plugins) se lance à l'ouverture du panneau d'administration. `handle_finalize` n'exige plus la présence du credential ; `is_locked()` verrouille sur le `LOCK_FILE` (l'absence de credential = « installation peut continuer »). Étape front-end réduite à un bouton « Préparer et terminer » + note explicative ; libellés (`cfg_title`/`cfg_sub`/`cfg_account_note`/`btn_finish`/`done_sub`) mis à jour en FR + EN.

## [ADDED]
- **La release embarque les défauts de config neutres** ([tools/build_release.py](../tools/build_release.py)) — `config/` ajouté à `ROOT_DIRS` ; `is_excluded` ship `config/defaults/**` (identité neutre) + le `config/theme.css` généré vide (évite un 404 avant la première sauvegarde), mais **exclut** la config opérateur (`config/instance.json` / `theme.json` / `legal.json` / `config/pages/*`). Une install fraîche démarre donc **neutre** et reçoit son identité de l'assistant, sans traîner la config IRIBHM.

[Versioning] Plateforme Web → v1.12.3. changelog_1.12.3.md généré.
