# Plateforme Web — v1.0.6

## [FIXED]
- **CRIT-01** — `compare.html` : suppression du bloc dupliqué/corrompu (lignes 473–667). Le document contenait un second `<head>`/`<body>` et une re-copie intégrale du layout après les premiers `<script>`, ainsi qu'une liste de `<script>` scindée et partiellement dupliquée. Le fichier est désormais un document HTML unique et bien formé (un seul `<head>`, `<body>`, `<style>`, liste de scripts unique). Évite un double parsing et un comportement DOM indéterminé sur la page de comparaison.
- Test : `tests/test_compare_html.py` (intégrité structurelle : unicité head/body/style/doctype, absence de scripts dupliqués, présence des scripts essentiels).
