# Plateforme Web — v1.0.9

## [FIXED]
- **ELE-08 (SEC-010)** — `dev_server.py` : suppression du mot de passe admin par défaut codé en dur (`iribhm2024`) et passage du hachage SHA-256 **non salé** à **PBKDF2-HMAC-SHA256 salé** (200 000 itérations). Au premier lancement, un mot de passe aléatoire est généré et affiché une seule fois ; seul son hash salé est persisté. La vérification reste rétro-compatible des anciens hash `password_sha256` (les installations existantes continuent de fonctionner ; ré-exécuter `--set-password` pour migrer).
- Test : `tests/test_dev_server_auth.py` (round-trip PBKDF2, sel aléatoire, compat legacy, absence de défaut codé en dur).
