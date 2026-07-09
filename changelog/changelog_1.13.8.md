# Plateforme Web — v1.13.8

> **Rafraîchissement de la documentation (README) sur tout le dépôt.** Un audit vérifié
> a montré que le `README.md` racine était figé à l'état ~v1.2.0 : il décrivait une
> fonctionnalité supprimée, une auth admin et un algorithme de preprocessing obsolètes,
> et ignorait tous les sous-systèmes livrés depuis (auto-updater, sécurité/CSP, white-label,
> marketplace). Correctifs ci-dessous.

## [FIXED]
- **`README.md` racine réécrit** ([README.md](../README.md)) — corrige les erreurs factuelles vérifiées : suppression de la section « 2D DeepZoom Mode » (fonctionnalité retirée en v1.2.1) ; auth admin `api/config.json` (SHA-256) → `api/admin_credential.json` (PBKDF2 salé, écran de setup au 1er lancement, pas de mot de passe par défaut) ; « Otsu thresholding » → échantillonnage percentile aux coins (Otsu retiré en preprocess v0.12.0) ; plugins « one-line manifest update » → auto-découverte sans manifeste ; retrait de la mention `DOCS/perf_baseline_*.json` (supprimés du dépôt). Cadrage produit **white-label réutilisable** (IRIBHM/ULB = déploiement d'origine). Ajout des sous-systèmes manquants : auto-updater Blue-Green + `install.php` + releases signées Ed25519 ; libs vendored self-hostées (`js/vendor/`, offline/no-CDN) + CSP stricte à nonce + trust gate + sandbox iframe ; couche white-label `config/` + éditeurs no-code + wizard de setup ; marketplace de plugins signé. Arbre de fichiers mis à jour (`config/`, `marketplace/`, `tools/`, `DOCS/`, `js/vendor/`, `js/pages/admin/`, `page.html`, `legal.html`, `install.php`, `ed25519_pure.py`) — chaque chemin vérifié présent.
- **`changelog/README.md`** ([changelog/README.md](README.md)) — la règle « Niveau plat = les deux lignes mineures les plus récentes » contredisait l'état réel (11 lignes mineures à plat, de 1.3.0 à 1.13.x ; seul ≤ 1.2.x est archivé). Reformulée pour décrire la pratique effective.
- **`preprocess/README.md` synchronisé** ([preprocess/README.md](../preprocess/README.md)) — était une release en retard (v0.14.0). Version → v0.14.1 (badge + pied de page) ; documentation de la feature v0.14.1 « download bundles » jusqu'ici absente : flag CLI `--with-downloads`, lanceur `.bat` embarquant **6 scripts** (pas 5) et posant **4 questions** (pas 3), `tools/build_download_bundles.py` + dossier `download/` ajoutés à la carte des fichiers et à l'arbre de sortie, ordre d'orchestration, dépendance optionnelle `tifffile` (OME-TIFF).
- **`preprocess/requirements.txt`** ([preprocess/requirements.txt](../preprocess/requirements.txt)) — bug réel : le fichier omettait `h5py` (importé par les scripts 1 et 2) → `pip install -r` plantait sur `import h5py`, et listait 5 paquets inutilisés (`nd2`, `czifile`, `openpyxl`, `dask`, `PyWavelets`). Aligné sur le set réel du pipeline (`h5py numpy scipy Pillow tqdm`, miroir de `build_launcher.py:DEPS`), avec `tifffile` en optionnel commenté.

[Versioning] Plateforme Web → v1.13.8. changelog_1.13.8.md généré.
