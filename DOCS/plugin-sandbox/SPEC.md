# Spec d'implémentation — Isolation des plugins tiers (Trust Gate + Sandbox postMessage)

**Cible** : Plateforme Web Lumen3D → **v1.6.0**. Composant : `Plateforme Web` (changelog `changelog/changelog_1.6.0.md`).
**Prérequis** : v1.5.0 (self-updater, `platformCompat`, quarantaine de plugins). Baseline navigateur : `crypto.subtle` (https/localhost), `iframe srcdoc`, `structuredClone`. Serveur : stdlib Python uniquement (aucune crypto asymétrique). Windows-first, offline-capable.

**Modèle de menace** : un `index.js` de plugin s'exécute aujourd'hui avec les pleins privilèges de page (accès à `moduleCtx`, au DOM, et fetch same-origin crédentialé vers `/api/auth.php`). Un plugin tiers = prise de contrôle totale (lire l'admin, falsifier un prompt mot de passe, exfiltrer, piloter l'API admin). Objectif : **le code non vérifié ne s'exécute jamais dans la page**, et le code vérifié-mais-cloisonné n'obtient qu'une API capability étroite.

---

## Partie 0 — Principe directeur (issu du red-team, non négociable)

> **La grille de confiance n'est PAS une fonction du registry. C'est l'environnement d'exécution (CSP).**

Deux findings **critiques** imposent ce cadrage :

1. **RT-C2 (client-only enforcement)** : tant qu'un seul script in-page peut faire `s=document.createElement('script'); s.src=…; body.appendChild(s)` ou `eval(await (await fetch(url)).text())`, le refus d'injection par `PluginRegistry.loadModules` est cosmétique. **Le vrai confinement vient d'une CSP stricte** (`script-src 'self' <hashes CDN épinglés>`, sans `'unsafe-inline'`/`'unsafe-eval'`, `object-src 'none'`, `base-uri 'self'`) qui rend l'iframe sandbox (origine null) la **seule** voie d'exécution de code non-approuvé.
2. **RT-C1 / RT-C4 (TOCTOU) & fail-open dev-mode** : le hash doit porter sur **les octets exécutés**, pas sur un fichier relu ; et l'absence de `version.json` ne doit **jamais** ouvrir la grille de confiance (contrairement à la grille compat).

Ces deux principes sont **baked-in** dans tout ce qui suit.

---

## Partie 1 — Trust Gate

### 1.1. Fichiers touchés

| Fichier | Nature | Rôle |
|---|---|---|
| `js/core/plugin-trust.js` | **NOUVEAU** IIFE `PluginTrust` (classic script, global `window`) | Calcul du tier côté client : hash canonique, comparaison à `version.json.files` (bundled) et au store d'approbation (approved). |
| `js/core/plugin-registry.js` | MODIFIÉ | `loadModules()` : trust-lane après la compat-gate ; `_loadScript` remplacé par une injection **byte-exacte** (textContent/Blob URL + `integrity`). |
| `api/plugin-trust.json` | **NOUVEAU** store serveur | `{ "version": 1, "approvals": [ { path, sha256, mode, caps, at, by } ] }`. Écrit seulement par les endpoints authentifiés (atomic, 0600). |
| `dev_server.py` | MODIFIÉ | Endpoints `plugin_trust`/`approve_plugin`/`revoke_plugin` ; exclusion des non-fiables de `/api/plugins` ; ajout à `_UPDATE_PROTECT` + `_is_forbidden_static` ; strip d'un `plugin-trust.json` embarqué dans une release ; header CSP. |
| `api/plugins.php`, `api/auth.php`/`api/admin.php` (PHP) | MODIFIÉ | Miroir PHP des mêmes routes + exclusion. |
| `api/.htaccess` | MODIFIÉ | Deny `plugin-trust.json` (déjà couvert par le deny global `api/`, mais explicité). |
| `js/pages/admin/tab-plugins.js` | MODIFIÉ | UI d'approbation : liste tier+hash+caps, prévisualisation du source, bouton approve/revoke avec re-auth. |
| `version.json` (généré par `tools/build_release.py`) | INCHANGÉ de forme | Source de vérité `bundled` (déjà content-addressed via `files` map + `_verify_tree_manifest`). |
| CSP : `viewer.html`, `compare.html`, `tracking.html`, `explorer.html`, `index.html`, `about.html` (`<meta http-equiv>`) + `dev_server.py`/PHP (header) | MODIFIÉ | Confinement d'exécution (voir 1.6). |

### 1.2. Hash canonique (résout RT-H4 — mismatch client/serveur)

**Règle unique, versionnée** — schéma `"lumen-plugin-trust/1"` :

- Le hash d'**un fichier** = `sha256` sur ses **octets bruts tels que servis**. Aucune normalisation : pas de strip BOM, pas de conversion CRLF↔LF, pas de re-décodage UTF-8.
  - **Client** : `crypto.subtle.digest('SHA-256', new Uint8Array(await resp.arrayBuffer()))` — **jamais** `await resp.text()` re-encodé (le repo est Windows-first, CRLF/BOM feraient diverger). Fetch en `cache:'no-store'`.
  - **Serveur** : `_sha256_file(path)` existant (lecture binaire brute).
- Le hash d'**un plugin** (multi-fichiers) = hash de la **liste triée** `"<relpath>:<hexhash>"` jointe par `\n`, préfixée du schéma :
  ```
  pluginHash = sha256( "lumen-plugin-trust/1\n" + sorted(["plugin.json:<h>", "index.js:<h>", …]).join("\n") )
  ```
  Concaténer les octets des fichiers est **interdit** (ambigu sur l'ordre/séparateur — RT-H4).
- **CRLF garanti stable** : le serveur sert les `.js`/`.json` de plugin en binaire brut (pas de translation), gzip transparent désactivé pour ces chemins, de sorte que `fetch` navigateur et `_sha256_file` voient les **mêmes octets**.
- **Vecteur de test** : `tests/plugin-trust-vector.json` (paires `bytes → hexhash` + un `pluginHash` de référence), rejoué par **client** (`tests/test_plugin_trust.js`, Node) **et serveur** (`tests/test_plugin_trust.py`). Même patron que `tests/compat-vector.json`.

**Fail-closed crypto (RT edge `hash-unavailable`)** : sur origine non-sécurisée (`http://` non-localhost), `crypto.subtle` est `undefined` → `PluginTrust.evaluate` ne peut hasher → tier **`untrusted`** (jamais fail-open). Surfacé en admin comme raison `hash-unavailable`.

### 1.3. Classification (`PluginTrust.evaluate(meta, basePath, files)`)

Retourne un objet `{ tier, hash, mode?, caps?, reason }` avec `tier ∈ {'bundled','dev','approved-trusted','sandboxed','untrusted'}`.

Ordre d'évaluation (le premier qui statue gagne) :

1. **`bundled` — match de CONTENU, jamais de chemin (résout RT-H6)** :
   - Charger `version.json` (root, content-addressed, servi par HTTPS/first-party — même modèle de confiance que l'updater).
   - Un plugin est `bundled` **ssi** *tous* ses fichiers (`plugin.json`, `index.js`, et tout autre fichier du dossier) sont **des clés de `version.json.files`** ET leur `sha256` on-disk **égale** le digest enregistré. Réutilise la logique de `_verify_tree_manifest`.
   - **Un seul fichier** du dossier absent de la manifest, ou avec un digest divergent, ou un fichier « en plus » (ex. `helper.js` déposé à côté d'un `index.js` bundled) ⇒ **pas bundled** ⇒ on continue l'évaluation. Ferme la dependency-confusion (attaquant qui écrase `tools/screenshot/index.js`).

2. **`dev` — signal POSITIF non-forgeable, jamais l'absence de fichier (résout RT-C4, critique)** :
   - **Découplé de la compat-gate.** L'absence de `version.json` rend la compat-gate inerte (inchangé, `compat.js`) mais **NE** met **PAS** la trust-gate en dev-mode.
   - Le mode dev n'existe que si le **serveur** l'affirme : `dev_server.py --dev-trust-local` estampille `devTrust:true` dans la réponse `/api/plugins` (et dans `/api/health`). `PluginTrust` lit ce flag ; il n'est jamais dérivé côté client d'une absence de fichier.
   - Sur un host statique (pas d'endpoint) : **pas** de dev-mode possible → tier retombe sur bundled/approved/untrusted.
   - Effet : supprimer `version.json` sur une prod (qui répond `/api/health` avec une vraie version release et `devTrust:false`) est un **signal de sabotage**, pas un dev-mode — la trust-gate reste fail-closed.

3. **`approved-trusted` / `sandboxed`** :
   - Chercher dans le store (obtenu via l'endpoint `plugin_trust`, voir 1.5) une approbation pour ce `path`.
   - Recomputer le `pluginHash` on-disk (via 1.2) et exiger `== approval.sha256`. Divergence ⇒ approbation **annulée** (code modifié depuis l'approbation) ⇒ continuer.
   - `caps effectives = intersection(disque `sandboxCapabilities` ∪ défaut, `approval.caps`, allowlist hôte globale)`. Si `disque ⊄ approval.caps` ⇒ approbation annulée (résout RT-H6-caps : le consentement porte sur un jeu de caps précis).
   - `approval.mode === 'trusted'` ⇒ `approved-trusted` (in-page). `=== 'sandboxed'` ⇒ `sandboxed`.

4. **`untrusted`** (défaut) : rien ne correspond ⇒ non chargé in-page ; quarantiné `untrusted-unapproved`, surfacé en admin.

**Invariant clé (résout RT-C1/RT-Rev)** : la classification **et** l'exécution se font sur **les mêmes octets, en un seul pas, juste avant l'exécution** — pas de phase « discovery » séparée qui hasherait un fichier ensuite relu. Concrètement, `loadModules` fetch les octets **une fois**, hashe **ces** octets, et exécute **ces mêmes** octets (voir 1.4).

### 1.4. Point d'application CLIENT (`plugin-registry.js`)

Insertion dans `loadModules()` **après** la compat-gate (`Compat.satisfies`, l.190-196) et **avant** toute injection. La contrainte v0.12.45 (loadModules entièrement `await`é avant `buildToolbarButtons`) est préservée : `spawn()` est `await`é dans la promesse par-plugin, elle-même dans le `Promise.all(loadPromises)`.

```js
// Fetch UNE fois les octets qu'on va hasher ET exécuter (anti-TOCTOU RT-C1).
const idxBytes  = new Uint8Array(await (await fetch(`${basePath}/${modPath}/index.js`,   {cache:'no-store'})).arrayBuffer());
const jsonBytes = new Uint8Array(await (await fetch(`${basePath}/${modPath}/plugin.json`, {cache:'no-store'})).arrayBuffer());
// (les fichiers supplémentaires du dossier sont énumérés via meta._files fourni par /api/plugins ; sur host statique, bundled/approved exigent que le dossier ne contienne QUE index.js+plugin.json — sinon untrusted.)

const verdict = await PluginTrust.evaluate(meta, basePath, { 'index.js': idxBytes, 'plugin.json': jsonBytes });

if (verdict.tier === 'untrusted') { _quarantine(modPath, 'untrusted-unapproved', verdict.reason); return; }

if (verdict.tier === 'sandboxed') {
  // Seuls les tools action/toggle sont sandbox-éligibles en v1 (voir Partie 2 §2.0).
  if (expectedPlacement !== 'tools' || (meta.subtype !== 'action' && meta.subtype !== 'toggle')) {
    _quarantine(modPath, 'sandbox-unsupported-placement', `placement=${expectedPlacement} subtype=${meta.subtype}`);
    return;
  }
  meta._sandboxCaps = verdict.caps;                 // caps effectives, déjà intersectées
  const code = new TextDecoder('utf-8').decode(idxBytes); // srcdoc = string, JAMAIS <script src>
  try {
    const shim = await PluginSandbox.spawn(meta, verdict.hash, code); // re-hash interne (RT-C1-sandbox)
    _modules.set(meta.id, { meta, impl: shim, instance: shim, state: 'initialized' });
  } catch (e) { _quarantine(modPath, 'sandbox-boot-failed', String(e)); }
  return;
}

// bundled / dev / approved-trusted → exécution IN-PAGE des octets DÉJÀ hashés (pas de re-fetch).
if (!await _execTrustedInPage(meta, idxBytes, verdict.hash)) {
  _modules.delete(meta.id);
  _quarantine(modPath, 'script-failed', 'index.js failed to load or parse');
}
```

**`_execTrustedInPage` remplace `_loadScript` (résout RT-C1, critique)** — n'injecte **jamais** par URL après hashing :

```js
function _execTrustedInPage(meta, bytes, hash) {
  return new Promise((resolve) => {
    const blob = new Blob([bytes], { type: 'text/javascript' });
    const url  = URL.createObjectURL(blob);          // exécute EXACTEMENT les octets hashés
    const s = document.createElement('script');
    s.src = url;
    s.setAttribute('integrity', `sha256-${_b64(hash)}`); // 2e barrière : le navigateur refuse un mismatch
    s.setAttribute('nonce', _pageNonce);              // requis par la CSP stricte (voir 1.6)
    s.onload  = () => { URL.revokeObjectURL(url); resolve(true); };
    s.onerror = () => { URL.revokeObjectURL(url); resolve(false); };
    document.body.appendChild(s);
  });
}
```
*(Note SRI+blob : `integrity` sur un blob-URL est honoré par Chromium/Firefox modernes ; il double la garantie « octets hashés == octets exécutés ». Le `nonce` est celui de la page, per-load, jamais exposé au code plugin.)*

### 1.5. Point d'application SERVEUR (`dev_server.py` + PHP)

Le serveur est une **deuxième barrière indépendante**, pas la seule (RT-C2 : le vrai confinement est la CSP).

- **Exclusion à la découverte** — `_serve_plugins()` (l.2130) : le filtre existant (`disabled` + `_compat_satisfies`) gagne une clause de confiance. Un plugin `untrusted` (ni bundled par `version.json`, ni approuvé dans `plugin-trust.json`, avec re-hash on-disk vérifié) est **exclu** de la liste `/api/plugins` **et** du `manifest.json` réécrit. C'est **UX/défense-en-profondeur, pas le contrôle de sécurité** (RT-Rev : un GET statique direct du fichier reste possible — c'est la CSP qui contient l'exécution).
- **Vue admin** — `_admin_plugins()` (l.504) : renvoie **tous** les plugins annotés `{ trust:{tier,hash,mode,caps,reason}, ... }`, y compris untrusted, pour l'écran d'approbation.
- **Endpoints** (sur `/api/admin.php`, dispatch dans `_handle_api`, l.2397) :

  | Action | Méthode | Auth | Comportement |
  |---|---|---|---|
  | `plugin_trust` | GET | session | Liste `plugin-trust.json` (approbations : path, sha256, mode, caps, at, by). |
  | `approve_plugin` | POST | session **+ CSRF + RE-AUTH mot de passe** (RT-M-approve) | `{ path, sha256, mode∈{trusted,sandboxed}, caps[] }`. |
  | `revoke_plugin` | POST | session + CSRF | `{ path }` → retire l'entrée, atomic-write. |

  **`approve_plugin` — durcissement (résout RT-H « approve A serve B » + RT-M re-auth)** :
  1. **Re-authentification** : comme `change_password`, exige le mot de passe courant dans le body (`_verify_password`), pas seulement une session vivante. Empêche un code in-page compromis (bundled) disposant d'une session admin de s'auto-approuver (RT-M-approve). Rate-limité + journalisé (`logs/`).
  2. Le serveur **relit lui-même** le fichier depuis le disque et recompute `pluginHash` (jamais le sha256 soumis par le client comme vérité).
  3. Exige `client_sha256 == serveur_sha256_ondisk` : opérateur et serveur s'accordent sur l'identité exacte des octets. Divergence ⇒ `409 hash-mismatch` (l'opérateur a revu X, le disque est Y — refus).
  4. Persiste `{ path, sha256:<serveur>, mode, caps, at, by:<username> }` via `_atomic_write` (0600).
  5. **Bloque** `mode:'trusted'` (approbation in-page) si le host est **statique-seulement** (pas d'endpoint) — non applicable ici (l'endpoint EST l'API), mais documenté : un déploiement pur-statique ne peut accorder que ce que `version.json` liste ; l'approbation opérateur exige un host Python/PHP.

- **`plugin-trust.json` — protection du store (résout RT-H-store)** :
  - Ajouté à `_UPDATE_PROTECT` (l.783, à côté de `api/quarantined-plugins.json`) → l'updater ne le touche jamais (pas de reset silencieux des approbations).
  - **Strippé de tout artefact release** dans `_build_plan` / `_verify_tree_manifest` : une release qui embarque un `api/plugin-trust.json` est **rejetée** (empêche une release malveillante de pré-approuver un plugin attaquant).
  - Jamais servi en HTTP : déjà couvert par `_is_forbidden_static` (deny global `api/`, l.410) ; explicité dans `api/.htaccess`.
  - Écrit **uniquement** par `approve_plugin`/`revoke_plugin` (jamais par un writer de dataset ou un chemin générique).

### 1.6. Confinement d'exécution — CSP (résout RT-C2, critique)

Sans ceci, la Partie 1 client est contournable par n'importe quel script in-page.

> **CORRECTION (comme construit v1.6.0 — remplace le plan initial ci-dessous)** : la
> CSP enforcing est émise en **en-tête HTTP uniquement**, par `dev_server.py:_serve_html`,
> qui injecte un **nonce par requête** (`{{CSP_NONCE}}` → nonce) — un nonce ne peut pas
> être figé dans une balise `<meta>` statique. Les pages portent seulement
> `<meta name="csp-nonce">` (lu par le client, inerte sans en-tête). Un hôte **PHP/statique**
> (Apache, `php -S`, `python -m http.server`, S3) **n'a donc PAS de CSP enforcing** → le
> refus client des plugins non-fiables y est contournable (RT-C2) ; le confinement fort
> ne tient que sous le serveur Python (recommander ce serveur, ou un reverse-proxy HTTPS
> injectant un nonce). Les libs sont **self-hostées** (`js/vendor/`) → `script-src 'self'
> 'nonce-…'`, aucun hôte CDN. Le plan « deux formes » initial (ci-dessous) était incorrect.

Politique (page principale) :
```
default-src 'self';
script-src 'self' 'nonce-<PAGE_NONCE>'
  https://unpkg.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com;
  /* hashes/URLs CDN épinglés — Three, Lucide, OpenSeadragon (déjà SRI dans viewer.html) */
object-src 'none';
base-uri 'self';
frame-src 'self';            /* CORRECTION (comme construit) : frame-src ne régit que le CHARGEMENT de l'iframe. Une frame srcdoc HÉRITE de la CSP parente, donc ses scripts inline sont aussi soumis au script-src parent → ils doivent porter le NONCE DE PAGE (voir plugin-sandbox.js:spawn). Libs finalement self-hostées (js/vendor/), pas de CDN dans script-src. */
connect-src 'self';
/* PAS de 'unsafe-inline', PAS de 'unsafe-eval' */
```
- Le `PAGE_NONCE` est per-load (`crypto.getRandomValues`), stampé sur tous les `<script>` légitimes (y compris les blob-URLs de plugins trusted, §1.4) et **jamais** exposé au code plugin.
- **`eval`/`new Function` éliminés** de la surface trusted (grep de CI ; aucun usage actuel côté viewer d'après l'audit du code).
- Effet : même un `index.js` bundled compromis ne peut plus faire `eval(fetch(...))` ni injecter un `<script src>` non-nonce ; la seule voie pour du code non-approuvé devient l'iframe sandbox (origine null).

---

## Partie 2 — Sandbox (lane défense-en-profondeur)

### 2.0. Périmètre (frontière critique)

- **Seuls** les plugins `placement:'tools'` de `subtype ∈ {'action','toggle'}` sont sandbox-éligibles. Les `channels` (`getChannelUI` renvoie du HTML injecté synchrone, `bindChannelUI` câble des handlers sur des nœuds DOM vivants) et `shaders` (objet GLSL/material synchrone) ne peuvent pas franchir une frontière postMessage async ⇒ un tel plugin qui résout en tier `sandboxed` est **quarantiné** `sandbox-unsupported-placement` (jamais chargé in-page silencieusement).
- **Nouveau fichier** : `js/core/plugin-sandbox.js` — IIFE `PluginSandbox` (classic script), chargé **juste après** `plugin-registry.js` dans `viewer.html`, `compare.html`, `tracking.html` (pas dans `admpan.html`).

### 2.1. Topologie & iframe

- Un `<iframe>` **par plugin** (jamais partagé — RT-M-spoof), appendé à un conteneur caché `#plugin-sandbox-hosts` (créé paresseusement : `position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none`). Aucun DOM visible : un tool éligible (screenshot) ne produit sa sortie que via capabilities.
- Attributs : `sandbox="allow-scripts"` **uniquement** (surtout **PAS** `allow-same-origin` → origine null/opaque : pas de DOM parent, pas de cookies, pas de localStorage, pas de fetch crédentialé vers `/api/auth.php` ; **PAS** `allow-forms`/`allow-popups`/`allow-top-navigation`/`allow-modals`/`allow-popups-to-escape-sandbox`). `referrerpolicy="no-referrer"`.
- **`allow-same-origin` interdit à jamais** : test CI qui grep les attributs d'iframe et échoue s'il apparaît (RT-M-escalation).
- Chargé via **`srcdoc`** (jamais `src`) — l'hôte assemble le document en string, le code plugin est une string que l'hôte contrôle, jamais un `<script src>` same-origin.

### 2.2. srcdoc & CSP interne (`_buildSrcdoc(meta, code, nonce, token)`)

```html
<!DOCTYPE html><meta charset=utf-8>
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  script-src 'nonce-NONCE';
  connect-src 'none'; img-src 'none'; style-src 'none';
  font-src 'none'; media-src 'none'; child-src 'none';
  worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'">
<script nonce="NONCE">/* BOOTSTRAP host-authored — voir 2.5 */</script>
<script nonce="NONCE">/* CODE PLUGIN (string verbatim) */</script>
```

- **`connect-src 'none'` = la directive porteuse** (RT-M-CSP) : tue l'exfiltration même si la frame acquérait une origine. **Invariant testé** : `connect-src 'none'` ne doit jamais être relâché ; si un plugin a besoin de données distantes (ex. une colormap), l'hôte les fetch et les passe par RPC — jamais d'ouverture de `connect-src`.
- **`worker-src 'none'` + `child-src 'none'` + `frame-src 'none'`** (RT-M-worker) : empêchent la frame de spawner un Worker ou une frame imbriquée pour busy-looper. `default-src 'none'` les couvrirait par fallback, mais on les rend **explicites** pour qu'un futur `default-src` relâché ne les rouvre pas.
- **La `<meta>` CSP est en PREMIER**, avant le bootstrap : le premier script inline s'exécute au parse ; l'ordre garantit que la CSP est active.
- Le `nonce` est per-spawn (`crypto.getRandomValues` hex). Le code plugin ne peut pas le lire (attribut strippé post-parse par le navigateur) ⇒ ne peut injecter un 2e script nonce'd. **Documenté (RT-M-CSP)** : `script-src 'nonce'` est de l'**hygiène, pas une frontière** — la frontière réelle est *(origine null) + (connect-src 'none') + (pas de allow-same-origin)*. Le code plugin s'exécute déjà avec tous les privilèges *dans la frame* ; le nonce ne fait qu'empêcher l'ajout de nouveaux scripts.

### 2.3. Enveloppe RPC

Structured-cloneable, `postMessage`. **Discriminant `ns` en toute première ligne** (RT-M-bus, isole du protocole `SYNC_*` de `compare.js`) :

```ts
interface Env {
  ns: 'lumen-plugin';          // rejet immédiat si absent
  v: 1;
  dir: 'req' | 'res' | 'evt' | 'sys';
  id: number;                  // monotone PAR ÉMETTEUR ; corrèle req↔res
  plugin: string;              // === entry.meta.id
  token: string;               // jeton de handshake per-frame (3e facteur, RT-L-origin)
  type: string;
  payload?: any;               // toujours untrusted côté récepteur
  ok?: boolean;
  error?: { code: string; message?: string };
}
```
- `dir:'evt'` (hôte→frame : render/channels/camera) et `dir:'sys'` (lifecycle : `ready`/`init`/`init-done`/`activate`/`deactivate`/`dispose`/`teardown`/`i18n`/`ping`/`pong`) ne portent pas de réponse.
- `req` expire par défaut à **8 s** → reject `{code:'timeout'}`.

### 2.4. Validation hôte (`_onMessage(event)`) — cœur sécurité

**Lookup par identité de fenêtre, pas par pluginId (résout RT-M-identity)** : `_hosts` est un `Map<Window, entry>` (clé = `frame.contentWindow` capturé **une fois, juste après `appendChild`**), doublé d'un `Map<pluginId, entry>` pour les autres usages. `_onMessage` est **O(1)** (pas de scan linéaire — évite l'amplification DoS de RT-M-identity sur compare.html).

```js
function _onMessage(event) {
  // (0) discriminant AVANT toute logique (RT-M-bus) : ignore SYNC_*/APPLY_WORKSPACE_STATE, etc.
  const env = event.data;
  if (!env || env.ns !== 'lumen-plugin' || env.v !== 1) return;

  // (a) IDENTITÉ DE SOURCE — authentificateur PRIMAIRE et UNIQUE (RT-L-origin).
  const entry = _hosts.get(event.source);          // Map<Window,entry>, O(1)
  if (!entry) return;                              // source inconnue → drop silencieux (pas d'oracle)

  // (b) ORIGINE — filtre SECONDAIRE. Frame srcdoc sandbox-sans-same-origin ⇒ 'null' (string).
  //     On N'ACCEPTE PAS location.origin (RT-L-origin : évite qu'une iframe viewer
  //     same-origin sur compare.html puisse forger un envelope si (a) régressait).
  if (event.origin !== 'null') return;

  // (c) forme + appartenance
  if (typeof env.id !== 'number' || env.plugin !== entry.meta.id ||
      typeof env.type !== 'string' || env.token !== entry.token) { _abuse(entry); return; } // token = 3e facteur

  // (d) allowlist par-type
  if (env.dir === 'req') {
    if (!entry.allowedReq.has(env.type)) { _send(entry, 'res', env.type, {ok:false, error:{code:'forbidden'}}, env.id); _abuse(entry); return; }
    // (rate-limit AVANT le handler — voir 2.6)
    _handleReq(entry, env);
  } else if (env.dir === 'res' || env.dir === 'sys') {
    _handleSysOrRes(entry, env);
  }
  // (e) tout handler re-valide payload : types/plages, strings length-cap ; aucune fonction ne survit au clone.
}
```

- **`token`** : chaque frame reçoit un token aléatoire embarqué dans son srcdoc bootstrap et le rejoue dans chaque enveloppe. Un forgeur (même same-origin) devrait aussi connaître le token (RT-L-origin, 3e facteur).
- **Origine `null` seule = insuffisant** : toutes les frames opaques la partagent → l'identité de source est autoritative (rejeté si `event.source` absent de `_hosts`).

### 2.5. Bootstrap (host-authored, ~90 lignes) & SDK `window.LumenPlugin`

Le bootstrap (string in-frame) :
1. Lit `NONCE`/`TOKEN` **injectés par l'hôte comme littéraux dans le string** (pas via DOM).
2. Installe un `message` listener qui valide `event.source === parent` et `env.ns==='lumen-plugin'`.
3. Poste `{dir:'sys',type:'ready',payload:{sdk:1},token:TOKEN}` à `parent`.
4. Sur `sys:init` (reçoit `{meta<subset>, capabilities[], initialState, i18n}`), construit `window.LumenPlugin`, appelle l'impl enregistrée, invoque `init(sdkCtx)`, poste `sys:init-done{buttons:[…]}`.

**SDK plugin-facing** :
```js
LumenPlugin.register(impl)                    // {init,activate,deactivate,getState,setState,dispose}
LumenPlugin.addButton({label,icon,onClick})   // → id local ; déclare le bouton à l'hôte
LumenPlugin.toast(msg)                         // req 'ui.toast'
LumenPlugin.download(filename,mime,data)       // data:Uint8Array|string → req 'ui.download' (SDK base64-encode)
LumenPlugin.getCanvasBlob(opts)                // req 'viewer.getCanvasBlob' → Uint8Array (SDK base64-decode)
LumenPlugin.setRenderMode(mode); getInfo(); getChannels()
LumenPlugin.on(topic,cb) / off(topic,cb)       // souscription evt
LumenPlugin.t(key)                             // dict i18n local (init-fourni), zéro round-trip
```
Chaque `req` renvoie une Promise résolue par la map `id↔resolver` du SDK. `sys:activate` de l'hôte → le SDK appelle `impl.activate` et reposte son retour (ex. `{active:true}` pour un toggle).

### 2.6. API capability (l'hôte broke chaque appel vers `moduleCtx`)

Table maître `_globalAllowlist` ; les caps effectives d'un plugin = `meta._sandboxCaps` (déjà intersectées §1.3). Défaut si `sandboxCapabilities` absent : `['toolbar.addButton','ui.toast','viewer.getInfo']` (inoffensif) — **affiché à l'opérateur** à l'approbation (RT-H-caps : consentement éclairé).

| Capability | Map vers `moduleCtx` | Projection / garde |
|---|---|---|
| `toolbar.addButton({label,icon,buttonId?})` | flux `buildToolbarButtons` via meta shim | **`label`/`icon` en `textContent` + icon depuis allowlist Lucide** — jamais innerHTML (RT-M-escalation). |
| `ui.toast(msg≤200)` | `moduleCtx.ui.toast` | string length-cap. |
| `ui.download({filename≤128, mime∈allowlist, dataB64/text})` | décode + `ExportManager.downloadBlob` | mime ∈ `['image/png','image/jpeg','application/json','text/csv','text/plain']` ; taille ≤32 MB ; **gesture-gate obligatoire** (voir infra, RT-M-gesture). |
| `viewer.getCanvasBlob({mime,quality})` | `moduleCtx.getCanvasBlob` (= `_getFigureBlob`) | renvoie `{dataB64}` (l'hôte fait blob→base64), jamais le Blob. **1 seul in-flight/frame + coalescing + budget bytes/s** (RT-H-DoS). |
| `viewer.setRenderMode(mode)` | `moduleCtx.viewer.setRenderMode` | `mode` ∈ ids shader connus (whitelist) ; jamais passé à un compile de shader. |
| `viewer.getInfo()` | snapshot | `{datasetId,name,dims,voxelSize,channelCount,renderMode}` — **objet plain neuf, whitelist explicite** (RT-L-snapshot). Jamais `getMeta()`, renderer/scene/camera/material (objets THREE vivants — **jamais** exposés). |
| `channels.getState()` | `moduleCtx.channels.getState` | **projection whitelist** `[{index,color,gamma,min,max,visible}]` — construite host-side, jamais le retour vivant de `ChannelPanel.getState()` (qui peut contenir callbacks/DOM → `DataCloneError` sinon). |
| `events.subscribe(topic)` / `unsubscribe` | listeners réels host-side (enregistrés une fois) | `topic ∈ ['render','channels-updated','camera','plane-spec']` ; fan-out **debouncé**, payload whitelist (camera → `{position,target}` nombres seuls, jamais d'objet THREE). |

**Durcissements bakés-in dans le broker** :

- **Anti-pollution de prototype (RT-M-proto)** : chaque handler **déstructure par nom** les champs attendus (`const {label, icon} = payload`) et re-valide type/longueur. **Jamais** de spread/`Object.assign`/deep-merge du payload. Les maps (dict i18n, `setState`) sont bâties avec `Object.create(null)` en copiant **uniquement** les clés string, avec rejet explicite de `__proto__`/`constructor`/`prototype`. Les objets de config/allowlist hôte sont `Object.freeze`. Un `setState` est stocké **opaque, par valeur**, jamais fusionné dans une config vivante.
- **Projection + try/catch clone (RT-L-snapshot)** : chaque capability read projette un objet plain neuf à whitelist explicite **avant** `postMessage` ; l'envoi de chaque réponse est enveloppé try/catch → un `DataCloneError` devient `{ok:false,error:{code:'internal'}}` (pas d'exception hôte non-catchée).
- **Post ciblé, jamais broadcast (RT-H-leak)** : toute réponse/evt part **uniquement** vers `entry.frame.contentWindow.postMessage(env,'*')`. `'*'` est inévitable (origine null non-nommable) mais le ciblage garantit qu'une seule frame reçoit. **Sérialiseur à whitelist de clés top-level par type de message** : le sérialiseur `res`/`evt`/`sys` refuse d'émettre tout champ non listé — règle **runtime**, pas discipline manuelle. **Aucun secret** (nonce, session admin) ne transite jamais hôte→frame ; le payload `init` ne contient que dataset public + i18n. Plafond de sensibilité = les pixels canvas ; aucune capability ne renvoie de donnée cross-dataset ou admin au lane sandbox.

**Gesture-gate `ui.download` (v1, RT-M-gesture)** : l'hôte n'honore `ui.download` que s'il arrive **≤1500 ms** après un `sys:activate` **que l'hôte a lui-même envoyé** (vrai clic toolbar). `entry.lastActivateAt` suivi ; hors fenêtre → `{code:'no-gesture'}`. **1 download max par activate.** Empêche l'auto-download sur `evt:'render'`.

**Rate-limiting TOUTES requêtes (v1, RT-H-DoS, critique)** : token-bucket **par frame** (ex. 20 req/s, burst 40) sur **toute** requête bien-formée (pas seulement les rejets). Au-delà → `{code:'busy'}`. `getCanvasBlob` : **1 in-flight/frame** + coalescing + budget octets/s. Le blob→base64 tourne **hors main-thread** (`OffscreenCanvas.convertToBlob` dans un worker hôte, ou `FileReader`) pour ne pas janker le rendu 60 FPS même en usage légitime (règle 1.2 « main thread inviolable »).

**Compteur d'abus (RT-M-abuse)** : messages malformés/forbidden comptés ; > 50 en 10 s → `kill(id,'abuse')` + quarantaine `sandbox-abuse`.

**Heartbeat watchdog (v1, PAS déféré — RT-M-worker, medium)** : l'hôte envoie `sys:ping` toutes les ~1,5 s ; une frame qui rate **K=3** `pong` consécutifs est tuée (`kill(id,'heartbeat')`). Une frame en busy-loop main-thread ne peut pas répondre → détection fiable. (Une frame srcdoc origine-null ne reçoit **pas** garanti un thread OS séparé sur tous les moteurs ; le heartbeat est le backstop obligatoire.)

### 2.7. Cycle de vie & intégration registry

**`PluginSandbox` API publique** :
```
spawn(meta, expectedHash, code) → Promise<shimImpl>   // crée l'iframe, handshake, renvoie le shim
bindContext(moduleCtx)                                // upgrade le ctx capability (RT edge moduleCtx-timing)
kill(pluginId, reason); killAll(); isSandboxed(pluginId) → bool
```

**`spawn()`** :
1. Crée `#plugin-sandbox-hosts` (paresseux).
2. **Re-hash obligatoire (RT-C1-sandbox)** : recompute `pluginHash` sur `code` (les octets fetchés) ; si `≠ expectedHash` → throw `hash-mismatch-at-load` (le registry quarantine). Lie les caps accordées aux octets exécutés.
3. Mint `nonce` + `token`, build srcdoc, crée l'iframe, **`appendChild`**, capture `frame.contentWindow` **immédiatement après append** (RT-M-identity), stocke `entry` dans `_hosts` (par Window **et** par id) **avant** que la frame ne puisse poster.
4. `await 'ready'` (sinon `SPAWN_TIMEOUT=10s` → reject → quarantaine `sandbox-boot-failed`) → envoie `sys:init` (meta subset + caps + i18n) → `await 'init-done'` (porte les boutons déclarés) → résout avec le shim.
5. Les boutons déclarés sont posés sur la meta du shim **avant** `buildToolbarButtons` → le bouton du tool sandboxé apparaît dans la même passe que les tools in-page.

**Shim enregistré dans `_modules`** (le reste du registry est inchangé — `activate`/`deactivate`/`buildToolbarButtons`/`getWorkspaceState`/`disposeAll` fonctionnent tels quels) :
```js
{ init(ctx){ return this; },                                 // no-op : le vrai init a eu lieu in-frame au spawn
  activate(){ PluginSandbox._send(entry,'sys','activate'); return this._lastToggle; },
  deactivate(){ PluginSandbox._send(entry,'sys','deactivate'); },
  getState(){ return this._cachedState; },                   // tiré via 'sys:get-state' async, caché
  setState(s){ PluginSandbox._send(entry,'sys','set-state',s); },
  dispose(){ PluginSandbox.kill(entry.meta.id,'dispose'); } }
```

**Timing `moduleCtx` (RT edge)** : `moduleCtx` est bâti **après** le chargement du volume, mais `loadModules`/`spawn` tournent **avant**. Résolution : `spawn` reçoit un `hostCtx` minimal (dataset id/name/basePath + i18n) suffisant pour `init`+`addButton` ; `PluginSandbox.bindContext(moduleCtx)` est appelé dans `initAll` (juste avant `bindToolbarButtons`, l.402) pour installer le vrai `_hostCap` **avant** qu'un `activate()` (toujours post-init, sur clic) ne puisse tirer. Les requêtes capability arrivant avant `bindContext` sont mises en file et flushées, ou rejetées `{code:'not-ready'}` et retentées par le SDK.

**Routing clic (tradeoff toggle async documenté)** : clic toolbar → `bindToolbarButtons` handler → `activate(id)` (sync, lit `result.active` pour flipper `btn-solid`) → `shim.activate` renvoie `_lastToggle` caché **immédiatement**, la frame pousse ensuite `evt:'button-state'{active}` qui affine l'icône au tick suivant. Lag visuel ≤1 frame, jamais bloquant.

**Langue** : `registry.onLanguageChange` → `shim.onLanguageChange` → hôte envoie `evt:'i18n'` (dict rafraîchi) → SDK swap son dict local → le plugin peut re-render son label via `toolbar.setLabel`.

**Teardown (`kill`/`killAll`, câblé à `disposeAll` + `beforeunload`)** :
- `sys:teardown` best-effort → `frame.remove()`.
- `for (p of entry.pending) { clearTimeout(p.timer); p.reject({code:'torn-down'}) }`.
- **`kill` supprime l'entrée `_hosts` (par Window et id) AVANT `frame.remove()`** (RT-M-identity : les messages en vol trouvent alors une source inconnue → drop).
- Le listener `window 'message'` unique (installé au 1er spawn, **guard anti-double-add**) n'est retiré qu'en `killAll`.
- Désabonne les listeners events réels de l'hôte quand le dernier souscripteur d'un topic part.
- Hygiène GPU : le sandbox ne détient aucun objet THREE (seuls base64/JSON franchissent) → rien à `.dispose()` au-delà de l'iframe.

**Révocation runtime (RT-Rev)** : le broker interroge une **époque de confiance monotone** (champ `trustEpoch` dans `/api/health`, incrémenté à chaque `approve`/`revoke`) ; toute frame dont l'approbation a été révoquée est teardownée (iframe disposée). À défaut : documenté « la révocation prend effet au prochain chargement » + signal admin « recharger tous les viewers ».

### 2.8. Plugin d'exemple — `js/modules/tools/screenshot-sandboxed/`

`plugin.json` :
```json
{ "id":"screenshot-sandboxed", "placement":"tools", "group":"export",
  "subtype":"action", "icon":"camera", "order":30,
  "sandbox":true,
  "sandboxCapabilities":["toolbar.addButton","viewer.getCanvasBlob","viewer.getInfo","ui.download"],
  "i18nTitle":"title", "i18nLanguages":["en","fr"],
  "platformCompat":">=1.6.0" }
```

`index.js` (ne touche **jamais** `ExportManager` ni `document` — contraste avec `js/modules/tools/screenshot/index.js` qui appelle `ExportManager.downloadBlob` in-page) :
```js
LumenPlugin.register({
  async init(){
    this.btn = LumenPlugin.addButton({ label: LumenPlugin.t('title'), icon: 'camera' });
  },
  async activate(){                                   // dans la fenêtre gesture (déclenché par le clic hôte)
    const bytes = await LumenPlugin.getCanvasBlob({ mime:'image/png', quality:0.95 }); // Uint8Array
    const info  = await LumenPlugin.getInfo();
    await LumenPlugin.download(`${info.name||'viewer'}_screenshot.png`, 'image/png', bytes);
    return { active:false };                           // action, pas un toggle persistant
  },
  dispose(){}
});
```

---

## Partie 3 — Invariants de sécurité (et leur application)

| # | Invariant | Application |
|---|---|---|
| **INV-1** | **Le code non-approuvé ne s'exécute jamais dans la page.** | CSP `script-src 'self' 'nonce-X' <CDN>` (§1.6) : rien d'inline/eval/injecté-sans-nonce ne tourne. Le lane sandbox (origine null) est la seule voie pour du non-approuvé. Client refuse d'injecter `untrusted` ; serveur l'exclut de la découverte (défense-en-profondeur). |
| **INV-2** | **Octets hashés == octets exécutés (anti-TOCTOU).** | `loadModules` fetch une fois, hashe ces octets, exécute **ces** octets via Blob-URL + `integrity=sha256-…` (§1.4). Sandbox : re-hash de `code` dans `spawn` avant srcdoc (§2.7). Aucune relecture par URL après hashing. |
| **INV-3** | **La confiance ne dérive jamais d'un chemin ni de l'absence d'un fichier.** | `bundled` = match de contenu contre `version.json.files` (tous fichiers, digests) — pas de trust par chemin (§1.3). `dev` = flag serveur positif `--dev-trust-local`, jamais l'absence de `version.json` (fail-closed, §1.3). |
| **INV-4** | **Le consentement opérateur porte sur des octets ET un jeu de caps précis.** | `approve_plugin` re-lit le disque, recompute le hash serveur, exige `client==serveur`, re-auth mot de passe (§1.5). Caps enregistrées ; à la charge, `caps effectives = ∩(disque, approved, allowlist)` ; `disque ⊄ approved` ⇒ approbation annulée (§1.3). UI affiche caps effectives + source. |
| **INV-5** | **Le store de confiance est inaccessible en HTTP, protégé de l'updater, non pré-semable par une release.** | `api/plugin-trust.json` : couvert par `_is_forbidden_static` (§1.5) + `.htaccess` ; ajouté à `_UPDATE_PROTECT` ; strippé/rejeté de tout artefact release ; écrit seulement par approve/revoke (atomic, 0600). |
| **INV-6** | **La frame sandbox n'a ni DOM parent, ni cookies, ni fetch crédentialé, ni exfil réseau.** | `sandbox="allow-scripts"` sans `allow-same-origin` (origine null) ; CSP interne `connect-src 'none'` (invariant testé, jamais relâché) + `default-src 'none'` + worker/child/frame-src `'none'` (§2.2). `allow-same-origin` interdit (test CI grep). |
| **INV-7** | **L'authentification d'un message RPC repose sur l'identité de source, pas l'origine.** | `_hosts.get(event.source)` (Map<Window>, O(1)) est l'authentificateur primaire+unique ; `origin==='null'` filtre secondaire ; `token` per-frame = 3e facteur ; `location.origin` **jamais** accepté (§2.4, RT-L-origin). Test : envelope valide + `event.source` ≠ contentWindow ⇒ rejeté même si `origin===location.origin`. |
| **INV-8** | **Aucun secret ni donnée non-due ne franchit hôte→frame ; réponses ciblées.** | Post uniquement vers `entry.frame.contentWindow` (jamais broadcast) ; sérialiseur à whitelist de clés top-level par type ; payload `init` = dataset public + i18n seulement ; plafond = pixels canvas (§2.6). |
| **INV-9** | **Le payload plugin ne peut pas polluer le realm hôte.** | Handlers déstructurent par nom, re-valident, ne spread/merge jamais ; maps via `Object.create(null)` + rejet `__proto__`/`constructor`/`prototype` ; configs `Object.freeze` ; `setState` opaque par valeur (§2.6, RT-M-proto). |
| **INV-10** | **Une frame ne peut pas figer le rendu 60 FPS ni DoS le main-thread.** | Token-bucket toutes-requêtes + `getCanvasBlob` 1-in-flight + budget octets/s + blob→base64 hors main-thread ; heartbeat (K=3 pong ratés → kill) ; compteur d'abus (>50/10s → kill) (§2.6, RT-H-DoS/RT-M-worker). |
| **INV-11** | **Un download sandbox est toujours initié par un clic.** | Gesture-gate : `ui.download` honoré seulement ≤1500 ms après un `sys:activate` émis par l'hôte, 1 max par activate (§2.6, RT-M-gesture). |
| **INV-12** | **Le bus RPC ne se confond jamais avec le protocole `SYNC_*` de la plateforme.** | `_onMessage` rejette en 1re ligne tout sans `ns==='lumen-plugin'` ; Map par Window garantit qu'aucune fenêtre plateforme n'est une entrée sandbox ; ajout d'un discriminant `ns` aux messages `SYNC_*` (§2.4, RT-M-bus). |

---

## Partie 4 — Ordre de build & hors-scope

### 4.1. Ordre de build (chaque étape testable indépendamment)

1. **Hash canonique + vecteur de test** (`js/core/plugin-trust.js` partiel, `tests/plugin-trust-vector.json`, `tests/test_plugin_trust.{js,py}`). Aucune UI. Valide INV-2/INV-3 hashing avant tout câblage. *(bump v1.6.0 amorcé)*
2. **CSP** (§1.6) sur toutes les `*.html` + header serveur, nonce per-load, purge `eval`/`new Function`, blob-URL + `integrity` dans `_execTrustedInPage`. **C'est la fondation (INV-1)** — sans elle, tout le reste est contournable (RT-C2). Vérifier que le viewer boote encore (plugins bundled via blob-URL nonce'd).
3. **Trust-lane client** dans `loadModules` (§1.4) : `bundled`/`dev`/`untrusted` seulement (pas encore de sandbox). Un plugin non-listé dans `version.json` sans endpoint dev → quarantiné. Valide INV-3.
4. **Store + endpoints serveur** (`api/plugin-trust.json`, `plugin_trust`/`approve_plugin`/`revoke_plugin`, re-auth, protection updater/HTTP/release-strip, exclusion découverte) + miroir PHP. Valide INV-4/INV-5. `approved-trusted` devient fonctionnel.
5. **`PluginSandbox`** (`js/core/plugin-sandbox.js`) : topologie iframe, srcdoc+CSP interne, enveloppe, `_onMessage` (INV-6/7/8/12), bootstrap+SDK, handshake `spawn`/`bindContext`, shim. Un plugin `sandboxed` boote et déclare son bouton.
6. **Broker capabilities** (§2.6) : caps une par une, avec **dès la première** le rate-limit, la projection whitelist, l'anti-pollution, le post ciblé, le gesture-gate, le heartbeat (INV-9/10/11). `screenshot-sandboxed` fonctionne bout-en-bout.
7. **UI admin** (`tab-plugins.js`) : liste tier+hash+caps, prévisualisation source, approve/revoke avec re-auth, affichage caps effectives (RT-H-caps).
8. **Révocation runtime** (`trustEpoch`, teardown) — INV (RT-Rev).
9. **Changelog `changelog/changelog_1.6.0.md`** (`[ADDED]` trust gate + sandbox, `[OPTIMIZED]` blob-URL exec, `[FIXED]` — néant nouveau) + notice `[Versioning] Plateforme Web → v1.6.0`.

### 4.2. Portée des placements (décision d'architecture, pas une lacune)

Seuls les `tools` `subtype ∈ {action,toggle}` sont sandbox-éligibles. Ce n'est **pas** un raccourci d'implémentation — c'est une frontière imposée par la nature de chaque placement. Un plugin tiers qui résout `sandboxed` dans un autre placement est **quarantiné** avec un motif spécifique (`plugin-registry.js` §trust gate), jamais chargé in-page en douce.

- **`shaders` — sandbox impossible, in-page-trust obligatoire (permanent).** Un shader plugin fournit du GLSL compilé **synchroniquement** dans le material du volume, puis exécuté sur le **GPU à chaque frame** avec accès direct à la texture 3D. Il n'existe aucune frontière RPC async derrière laquelle une iframe null-origin pourrait s'intercaler : le compilateur de shader exige la source GLSL au moment (synchrone) du compile, et le code tourne ensuite hors JS. Un shader tiers ne peut donc être exécuté que si l'opérateur lui accorde la **confiance in-page** (tier `approved`). Il n'y a pas de v2 qui lève ça — c'est structurel. (La seule isolation théorique serait une validation/sanitization GLSL, non fiable et hors sujet.)

- **`channels` — différé par conception (chemin déclaratif esquissé).** L'API channel-panel remet au plugin le **nœud DOM vivant de l'item de canal** : `getChannelUI(channel)` renvoie du HTML injecté **synchroniquement** dans l'`innerHTML`, et `bindChannelUI(idx, ch, itemEl, api)` câble des handlers **sur ce DOM**. C'est exactement le privilège que le sandbox retire. Sandboxer proprement suppose un **sous-système parallèle déclaratif** — le plugin ne renvoie plus de DOM mais un *schéma JSON* de contrôles, que l'hôte rend lui-même et dont il route les événements par RPC — **plus** une surface de capabilities d'effet-canal (lire les stats d'un canal, pousser gamma/couleur/min-max, demander une passe worker par canal) qui **n'existe pas encore**. Construire ce framework **sans aucun consommateur** (histogram + gaussian-filter sont bundled, in-page) violerait la règle projet « pas de placeholder, robuste et final » : ce serait de l'infrastructure spéculative non exerçable de bout en bout. Il est donc **délibérément différé** jusqu'à l'apparition d'un vrai channel plugin tiers.

  Design retenu pour ce jour-là (à implémenter tel quel) :
  1. capability `channels.declareUI` → la frame renvoie **une fois** (à l'init) un schéma `{ perChannel: [ {type:'slider'|'toggle'|'button'|'label', key, label, min?, max?, step?, default?} ] }` ;
  2. l'hôte rend ces contrôles depuis une **whitelist de types** (aucun HTML tiers ; anti-injection par construction), un jeu par canal ;
  3. les interactions → RPC `dir:'req' type:'channel.control'` `{channelIndex, key, value}` vers la frame ;
  4. réponses/effets via des capabilities d'effet-canal étroites et projetées (jamais le retour vivant de `ChannelPanel`), sur le modèle exact de `channels.getState` (RT-L-snapshot).

  Le rendu host-side du schéma se greffe en **chemin additif** dans `channel-panel.js` (`getChannelUI`/`bindChannelUI` restent pour les plugins in-page) : aucun régression sur histogram/gaussian.
- **Authenticité Ed25519 / clé éditeur** : pas de crypto asymétrique en stdlib Python. L'authenticité vient de HTTPS-vers-first-party + sha256 (même modèle que l'updater). Un vérificateur Ed25519 pure-Python vendored pourrait épingler une clé éditeur plus tard — hors-scope sauf si trivial ; le sandbox est robuste sans (origine null + caps étroites).
- **Approbation `trusted` sur host pur-statique** : impossible (les endpoints exigent Python/PHP). Un pur-statique n'exécute in-page que ce que `version.json` liste ; le reste est sandbox-only ou désactivé.
- **`structuredClone` de secours** : baseline moderne assumée ; l'algorithme de clone structuré est de toute façon intégré à `postMessage`. Repli JSON possible si un moteur cible en manque.

---

## Annexe — Ancrages code réels

- Intégration client : `js/core/plugin-registry.js` — `loadModules()` (l.141), après `Compat.satisfies` (l.190) ; `_loadScript` (l.251) **remplacé** par `_execTrustedInPage` ; `discover()` (l.119) inchangé ; `_quarantine` (l.63) réutilisé.
- Contexte capability : `js/pages/viewer.js` `moduleCtx` (l.316) — `getCanvasBlob:_getFigureBlob` (l.382), `viewer.setRenderMode` (l.327), `channels.getState` (l.353), `ui.toast`→`ExportManager.toast` (l.365) ; `initAll` (l.402)/`bindToolbarButtons` (l.403) : point d'appel `PluginSandbox.bindContext`.
- Compat (modèle fail-open à **ne pas** copier pour la confiance) : `js/core/compat.js` `satisfies()` (l.101), `platformVersion()` (l.148).
- Serveur : `dev_server.py` — `_serve_plugins()` (l.2130, filtre trust), `_admin_plugins()` (l.504), `_handle_api`/`/api/admin.php` (l.2397, nouvelles actions), `_authorize_write` (l.396, re-auth pattern via `change_password` l.2303), `_UPDATE_PROTECT` (l.783), `_is_forbidden_static` (l.410), `_verify_tree_manifest` (l.1371, réutilisé pour `bundled`), `_sha256_file` (l.930).
- Plugin de référence in-page à **répliquer sans privilège** : `js/modules/tools/screenshot/index.js` (appel `ExportManager.downloadBlob` l.17-18 → remplacé par `ui.download` brokeré).
- Chargement scripts : `viewer.html` l.455 (`plugin-registry.js`) → insérer `plugin-sandbox.js` juste après ; CSP `<meta>` en tête des `*.html`.

**Livrables nouveaux fichiers** : `js/core/plugin-trust.js`, `js/core/plugin-sandbox.js`, `api/plugin-trust.json`, `js/modules/tools/screenshot-sandboxed/{plugin.json,index.js,lang/{en,fr}.json}`, `tests/plugin-trust-vector.json`, `tests/test_plugin_trust.{js,py}`, `changelog/changelog_1.6.0.md`.

[Versioning] Plateforme Web → v1.6.0 (spec seulement — aucun code écrit ; changelog à générer au moment du build).