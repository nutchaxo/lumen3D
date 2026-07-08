# Isolation des plugins tiers — documentation technique (v1.6.0)

> Ce qui a été construit et comment ça marche. La conception détaillée + les 12
> invariants sont dans [SPEC.md](SPEC.md).

## Le problème

Un `index.js` de plugin s'exécutait avec les **pleins privilèges de la page** : accès au
DOM, au `ViewerContext` (`Object.create(ctx)`), et fetch same-origin crédentialé vers
`/api/auth.php`. Un plugin tiers = prise de contrôle totale. On ne peut pas rendre du code
tiers arbitraire à la fois « pleinement intégré » et « sûr » — donc deux leviers.

## Levier 1 — Gate de confiance (le correctif racine)

**Le code non approuvé ne s'exécute jamais en page.** Le serveur est l'autorité : il classe
chaque plugin et vouche un hash que le client re-vérifie.

| Tier | Condition | Exécution |
|---|---|---|
| `bundled` | tous les fichiers du dossier sont dans `version.json.files` avec le bon sha256 (match de **contenu**) | in-page |
| `dev` | checkout `.git` **présent** ou `--dev-trust-local` (signal *positif*, jamais l'absence de `version.json`) | in-page |
| `approved-trusted` | approbation opérateur épinglée au hash, `mode:trusted` | in-page |
| `sandboxed` | approbation opérateur épinglée au hash, `mode:sandboxed` | iframe (levier 2) |
| `untrusted` | défaut | **non chargé**, exclu de la découverte |

**Hash canonique** (`lumen-plugin-trust/1`) — `sha256(scheme + "\n" + tri("relpath:sha256(octets bruts)"))` — trois jumeaux (`js/core/plugin-trust.js`, `dev_server.py`, `api/_admin_lib.php`) validés byte-exact (CRLF/BOM) par [tests/plugin-trust-vector.json](../../tests/plugin-trust-vector.json).

**Anti-TOCTOU (INV-2)** : `loadModules` fetch les octets **une fois**, les hashe, et exécute **ces** octets via un **Blob-URL** (`_execTrustedInPage`) — jamais un `<script src>` qui re-fetcherait des octets potentiellement modifiés.

**Approbation (INV-4)** : `POST /api/admin.php?action=approve_plugin` exige session + CSRF **+ ré-authentification mot de passe** ; le serveur relit et re-hashe lui-même le disque et exige `client==serveur`. L'approbation épingle le hash + le jeu de capabilities. Store `api/plugin-trust.json` : jamais servi en HTTP, dans `_UPDATE_PROTECT`, et **rejeté de tout artefact de release** (une release ne peut pré-approuver — INV-5).

## Levier 2 — Bac à sable (défense en profondeur)

Un plugin `sandboxed` (tools action/toggle uniquement en v1) tourne dans une
`<iframe sandbox="allow-scripts">` **sans** `allow-same-origin` → origine null : pas de DOM
parent, pas de cookies, pas de localStorage, pas de fetch crédentialé. CSP interne
`default-src 'none'; connect-src 'none'` → **aucune exfiltration réseau**, pas de Worker.

**Pont RPC** (`js/core/plugin-sandbox.js`) :
- Authentification par **identité de fenêtre** (`_hosts` = `Map<Window,entry>` clé sur
  `iframe.contentWindow`), pas par l'origine ; `origin==='null'` en filtre secondaire ;
  **jeton per-frame** en 3ᵉ facteur ; discriminant de namespace `lumen-plugin` (INV-12,
  jamais confondu avec `SYNC_*` de `compare.js`).
- **Broker de capabilities** : chaque appel du plugin (`toolbar.addButton`, `ui.toast`,
  `ui.download`, `viewer.getCanvasBlob`, `viewer.getInfo`, `viewer.setRenderMode`,
  `channels.getState`, `events.subscribe`) est validé + mappé vers un **adaptateur étroit**
  (jamais le `moduleCtx` brut). Lectures projetées en objets plains à whitelist (jamais
  d'objet THREE vivant).
- **Durcissements** : rate-limit token-bucket (INV-10), `ui.download` gesture-gated (INV-11,
  ≤1,5 s après un clic réel, 1 par activate), heartbeat (kill au 3ᵉ pong manqué), compteur
  d'abus, déstructuration par nom (anti-pollution de prototype, INV-9).

Plugin de référence : [js/modules/tools/screenshot-sandboxed/](../../js/modules/tools/screenshot-sandboxed/) — capture + télécharge sans jamais toucher `document`/`ExportManager`/`ctx`.

## CSP (le verrou d'exécution, INV-1)

Sans CSP stricte, le refus d'injection côté client est contournable par tout script in-page.
La CSP est **enforcée** : `dev_server.py` (`_serve_html` + `_csp_policy`) injecte un **nonce
par requête** (`{{CSP_NONCE}}` → nonce) et pose `Content-Security-Policy: script-src 'self'
'nonce-…' <CDN>` — **sans** `unsafe-inline`/`unsafe-eval`/`blob:`. Les handlers inline sont
remplacés par une délégation `data-action` ([js/core/ui-actions.js](../../js/core/ui-actions.js)) ;
le `<script>` Blob-URL d'un plugin trusté passe par le **nonce de page** (donc `blob:` reste
hors `script-src` → un script in-page compromis ne peut pas injecter un blob non-noncé).
Hôtes PHP/statiques (pas d'injection per-request) : placeholder inerte, enforcing réservé au
serveur Python. **Piège corrigé** : `const Theme = …` en script classique est un binding
lexical global, PAS `window.Theme` — `ui-actions.js` référence les noms nus.

## Périmètre v1.6 (franchise)

- **Complet + testé** : gate de confiance (autorité serveur + jumeau client + parité de hash
  tri-implémentation), broker RPC (validation testée headless : identité, rate-limit, cap
  interdite, gesture-gate), UX d'approbation.
- **À vérifier en navigateur réel** : le bac à sample (messagerie iframe, CSP interne) et
  l'UX d'approbation — l'environnement de préview headless ne boote pas le viewer WebGL.
- **Différé** : CSP enforcing (nécessite de noncer les scripts inline des pages) ;
  authenticité par signature Ed25519 (pas de crypto asymétrique en stdlib) — l'authenticité
  vient de HTTPS-vers-first-party + sha256 comme l'updater ; sandboxing des channels/shaders
  (bloqué à tools action/toggle).

## Comment approuver un plugin tiers

1. Déposer le plugin dans `js/modules/tools/<id>/`. En prod il apparaît `untrusted` (non chargé).
2. Panneau admin → Plugins → « Approuver (bac à sable) » ou « Approuver (in-page) ».
3. Vérifier l'empreinte affichée, confirmer avec le mot de passe admin.
4. Recharger le viewer. Le plugin est épinglé à ce hash exact ; toute modification le re-quarantine.
