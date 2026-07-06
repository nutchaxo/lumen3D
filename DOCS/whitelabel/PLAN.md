# PLAN — Généralisation « white-label » de Lumen3D

> **But** : transformer Lumen3D d'un visualiseur mono‑usage (embryons de souris, IRIBHM/ULB)
> en un **produit générique réutilisable** que n'importe quelle équipe peut installer pour
> visualiser SES propres images 3D, personnaliser sans code, et étendre via un catalogue de
> plugins signés. Aucun domaine biologique présumé par défaut.
>
> Ce document est la **spécification maîtresse** (au même niveau que `DOCS/update-system/SPEC.md`).
> Il découle d'un audit ligne‑à‑ligne des 7 sous‑systèmes porteurs. Il respecte strictement les
> conventions existantes : pas d'ESM hors panneau admin, pas de bundler/build, IIFE globales par
> nom nu, CSP stricte à nonce, jumeaux Python/PHP, écritures atomiques, `_UPDATE_PROTECT`,
> versioning + changelog autonome.

---

## 0. Principe directeur — « Moteur » vs « Contenu de l'étude »

On sépare nettement **deux couches** :

| Couche | Nature | Qui l'édite | Où elle vit |
|---|---|---|---|
| **Moteur de visualisation** | Générique, sans domaine : ray‑marcher, streaming de bricks, outils, plugins, i18n de l'UI, thème par tokens | Développeur (nous) | `js/`, `css/`, `*.html` (squelettes neutres) |
| **Configuration d'instance** (le « contenu de l'étude ») | Spécifique au déploiement : marque, terminologie, textes des pages, thème, blocs d'accueil, mentions légales, facettes de métadonnées | **Opérateur, depuis l'admin, sans code** | `config/*.json` (public, servi) + `api/*.json` (secrets) |

**Règle d'or** : le moteur ne contient **aucune** chaîne métier en dur. Tout ce qui est
aujourd'hui « embryon / souris / IRIBHM / ULB / DAPI‑GFP‑Pecam1 / E8.5 / Em1 » devient de la
**donnée de configuration éditable**, avec un **défaut neutre** livré par défaut.

L'instance IRIBHM actuelle n'est plus « le code », mais **une configuration parmi d'autres**
(voir §7 Migration : son contenu devient sa propre `config/`, protégée des mises à jour).

---

## 1. La couche « Configuration d'instance » (fondation transverse)

### 1.1. Artefacts de configuration

Tous **publics** (le navigateur doit les lire pour rendre les pages), donc placés hors de `api/`
(qui est bloqué du service HTTP). Emplacement retenu : un nouveau dossier `config/` à la racine,
servi en statique comme `lang/` et `DATA_WEB/catalog.json`.

| Fichier | Contenu | Édité par |
|---|---|---|
| `config/instance.json` | Identité (nom produit, nom instance, organisation), terminologie (`specimen` sing/plur, `org`, `productName`), SEO (`description`, `keywords`), pied de page (copyright, liens), navigation (pages activées + ordre), facettes de métadonnées, presets couleur de canaux, définitions de statistiques, chemins des logos | `tab-branding` + wizard |
| `config/theme.json` | Tokens de thème : palette (`--color-primary`, `--color-accent`, …), police, échelle d'espacement, variantes clair/sombre des surfaces | `tab-appearance` + wizard |
| `config/theme.css` | **Généré** par le serveur à partir de `theme.json` : un seul bloc `:root{ --token:val; }` (+ `[data-theme=…]` pour les surfaces). Chargé par `<link>` après `themes.css` | (auto) |
| `config/pages/<page>.json` | Layout par blocs de chaque page éditable (`home`, `about`, pages custom), au format `{ draft:{blocks:[…]}, published:{blocks:[…]}, updatedAt }`, textes **inline multi‑locale** | `tab-pages` (constructeur de blocs) |
| `config/legal.json` | Sections de mentions légales / confidentialité (texte pur, multi‑locale) | `tab-legal` |
| `config/defaults/neutral/*` | **Gabarits neutres** (instance/theme/pages/legal white‑label) — utilisés par le wizard et le bouton « revenir au défaut » | (livré, lecture seule) |
| `assets/branding/*` | Logos, favicon, monogramme référencés par chemin depuis `instance.json` | (remplaçables) |

Secrets **inchangés**, sous `api/` (bloqué du service) : `admin_credential.json`, `plugin-trust.json`, `disabled-plugins.json`, `stats.json`.

### 1.2. Chargement (côté client)

Nouveau singleton **`js/core/instance-config.js`** (IIFE classique, nom nu `InstanceConfig`,
chargé **tôt**, avant i18n et avant tout rendu de page — modèle `catalog.js`) :

```
InstanceConfig.load()      // fetch config/instance.json cache-busté, tolérant (fallback défaut neutre embarqué)
InstanceConfig.get(path,d) // accès pointé
InstanceConfig.tokens()    // { brand, productName, specimen, specimenPlural, org, … } pour l'i18n
InstanceConfig.applyDom(root)  // remplit les [data-instance="brand.name"] (jumeau de data-i18n)
```

Ordre de boot (chaque page) : `InstanceConfig.load()` → `I18n.init()` (voit les tokens) →
`InstanceConfig.applyDom()` + `I18n.translateDOM()` → rendu.

### 1.3. Injection dans le `<head>` et le chrome (SEO + zéro flash)

`<title>` / `<meta>` / marque du header ne sont **pas** couverts par le scan `data-i18n` et un
`document.title=` en JS provoque le bug « double source ». Solution :

* **Injection serveur** : `dev_server.py:_serve_html` réécrit déjà `{{CSP_NONCE}}`. On ajoute des
  placeholders `{{INSTANCE_TITLE}}`, `{{INSTANCE_DESC}}`, `{{INSTANCE_BRAND}}`, `{{INSTANCE_THEME_LINK}}`
  remplis depuis `instance.json` au moment du service. **Jumeau obligatoire** dans
  `api/_html_server.php:lumen_serve_html` (+ `_serve.php`, `router.php`).
* **Repli hôtes statiques** (`fast_server.py`, `python -m http.server`) : un mini‑script de boot
  nonce'é remplit `document.title` + `data-instance` depuis `InstanceConfig` si les placeholders
  ne sont pas résolus. Léger flash acceptable sur ces hôtes non‑recommandés.
* On **supprime** les `document.title = 'IRIBHM…'` en dur de `landing.js:21`, `about.js:15`,
  `explorer.js:24` (ils écrasent le `<title>` injecté).

### 1.4. Persistance serveur (jumeaux Python + PHP)

Nouveau point d'API admin **`/api/site.php`** (Python natif + `api/site.php`), suivant EXACTEMENT
le patron `_load_disabled_plugins`/`_save_disabled_plugins` + `_save_dataset` (merge‑write) :

* `GET  ?action=get&doc=instance|theme|pages/<p>|legal` → renvoie le JSON (lecture publique OK pour
  le contenu ; écriture protégée).
* `POST ?action=save&doc=…` (auth session + `X-CSRF-Token`, ajouté à `WRITE_ACTIONS` / `_is_write_action`
  côté Python et `admin_require_write()` côté PHP) → `_atomic_write` (temp + `os.replace` sous `_WRITE_LOCK`) ;
  PHP `admin_write_json` (tempnam + rename).
* `POST ?action=publish&doc=pages/<p>` → copie `draft`→`published`, régénère si besoin.
* `POST ?action=reset&doc=…` → réécrit depuis `config/defaults/neutral/…`.
* `theme.json` sauvegardé ⇒ le serveur **régénère `config/theme.css`** (bloc `:root`), écrit atomiquement.

**Invariants de durabilité** :
* Ajouter `config/` (au moins `instance.json`, `theme.json`, `theme.css`, `pages/`, `legal.json`) à
  **`_UPDATE_PROTECT`** (Python, ~l.1096) + équivalent PHP, sinon une mise à jour plateforme écrase
  la personnalisation de l'opérateur (piège déjà vécu, cf. CLAUDE.md §9).
* `config/` étant **public**, ne JAMAIS y mettre de secret. Les gabarits `config/defaults/` sont
  livrés dans le zip de release ; les fichiers `config/*` **actifs** de l'opérateur ne le sont pas
  (voir §7) → ils survivent aux updates car absents du manifest de release.

---

## 2. Objectif 1 — Découpler le moteur du contenu métier

### 2.1. Dé‑hardcoder le HTML (les 8 pages)

* Remplacer les chaînes de marque en dur par un binding déclaratif **`data-instance="brand.name"`**
  / `data-instance-attr="…"` (jumeau conceptuel de `data-i18n`), rempli par `InstanceConfig.applyDom()`.
  Cible : navbar brand, badges, monogramme (`landing.js:30` `'IR'`), pied de page, liens org.
* `<title>` / `<meta description|keywords>` : placeholders serveur (§1.3).
* **Nouveau chrome partagé optionnel** : comme il n'y a pas de build, on garde les squelettes par
  page mais on centralise leur *contenu* via `data-instance` + injection serveur → un seul point de
  vérité (fin de la duplication x8).

### 2.2. Dé‑domaniser l'i18n (sans tripler les éditions)

Problème : les clés métier sont mêlées à l'UI et **dupliquées en/fr/es**. Solution :

* **Substitution de tokens dans `I18n.t()`** : injecter automatiquement `{brand}`, `{productName}`,
  `{specimen}`, `{specimenPlural}`, `{org}` (issus de `InstanceConfig.tokens()`) dans chaque
  résolution (fusionnés avec les params explicites). `i18n.js` supporte déjà des params (`tp`).
* **Généraliser les clés** en/fr/es en lockstep : `landing.heroTitle: "Explore {specimenPlural}"`,
  `landing.statsEmbryos` → `landing.statCardLabel` neutre, `explorer.filterStage` → label de facette
  configurable, `viewer.measureDesc`/`tracking.*` « embryo surface » → `{specimen}`, `admin.loginTitle`
  → `"{brand} Admin"`, etc. Les nouveaux libellés ne contiennent plus « embryo/IRIBHM ».
* Conséquence : changer de marque/spécimen = éditer `instance.json` **une fois**, pas 3 fichiers de
  langue. Les `lang/*.json` restent développeur/traducteur (chrome UI générique).
* `catalog._relationLabel/_relationDescription` (anglais en dur, `catalog.js:211‑231`) → passer par
  `I18n.t()`.

### 2.3. Dé‑domaniser le JS (hypothèses biologiques)

| Couplage | Fichier | Généralisation |
|---|---|---|
| `getStats()` → `totalEmbryos/totalRegions` + ids DOM `stat-embryos` | `catalog.js:156‑177`, `index.html`, `about.html` | Statistiques **définies en config** : `stats:[{id,i18nKey,source:'count'|'distinct'|'sum',field}]`. `getStats()` calcule génériquement ; cartes rendues depuis la config (plus d'ids fixes) |
| Parsing/format « stage » `E8.5` + id `Em<n>` | `utils.js:74‑108`, `catalog.js:_stageNumber/getStages` | **Facettes de métadonnées configurables** : `facets:[{id,label,type:'ordinal|nominal',pattern,format}]`. L'explorer génère ses filtres depuis les facettes. Aucune facette configurée ⇒ le filtre disparaît proprement |
| `_colorForChannel` gfp/dapi/pecam/… → couleurs | `channel-panel.js:380‑387` | Table `channelColorPresets` (sous‑chaîne→couleur) en config ; fallback `DEFAULT_COLORS`. Défaut neutre générique ; config IRIBHM reproduit l'aspect actuel |
| Types `fixed/live/tracking` | explorer/catalog/URL | On garde l'**identité** de type (elle pilote le comportement viewer + l'arborescence `DATA_WEB/`), mais **titre/description/icône deviennent config** (`datasetTypes:[{id,i18nKey,icon}]`) |
| Formulaire admin Stage/Embryo en dur | `admpan.html:290‑309`, `tab-datasets.js` | Champs de métadonnées **générés depuis un schéma config** (`metadataFields:[{id,label,placeholder,type}]`) ; Stage/Embryo deviennent des champs déclaratifs optionnels |

### 2.4. Défaut neutre vs préservation IRIBHM

* `config/defaults/neutral/*` = white‑label pur (aucune biologie), **livré**.
* La `config/*` **committée dans ce dépôt** = **IRIBHM** (l'instance vivante de l'utilisateur reste
  identique tant qu'on n'a rien neutralisé côté serveur). Voir §7 pour le mécanisme release qui
  distribue le neutre sans blanchir l'instance de l'utilisateur.

---

## 3. Objectif 2 — Éditeur de pages + personnalisation (depuis l'admin)

Toutes les nouvelles capacités sont des **onglets admin** (modules ESM enregistrés dans `admpan.js`,
patron `registerTab` + cycle `mount/activate/relabel`, plumbing `shared.js` : `apiFetch`/CSRF/`toast`/
`t()`/`escHtml`/`refreshIcons`, garde « unsaved » via `bus.js`). Regroupés dans une section
« Personnalisation » de la barre latérale.

### 3.1. `tab-appearance.js` — Éditeur de thème

* Contrôles : sélecteurs de couleur pour la palette (`--color-primary/-accent/-green/-error/…`),
  sélecteur de **police**, échelle d'espacement, réglages surfaces clair/sombre.
* **Aperçu en direct** : `document.documentElement.style.setProperty('--token', val)` (attribut style
  inline → autorisé par `style-src-attr 'unsafe-inline'`, **pas** de `<style>` injecté qui serait
  bloqué par `style-src-elem` sans nonce).
* **Persistance sans flash + CSP‑safe** : Save → `config/theme.json` → serveur régénère
  `config/theme.css` → toutes les pages le chargent via `<link rel=stylesheet href="config/theme.css">`
  placé **après** `themes.css` (origine `self` → autorisé par `style-src-elem 'self'`, pas de nonce).
  Le `<link>` est ajouté aux 8 pages (fichier existant, `:root{}` vide par défaut → pas de 404).
* **Tokeniser les échappées** en dur (`components.css` blanc/sombre forcé, `base.css:184‑191` options
  de `<select>`) via `--text-on-primary`, `--select-option-fg/-bg`, sinon une palette très différente
  rend des libellés illisibles.
* **Police** : famille via token + soit self‑host `@font-face` sous `assets/fonts/` (`font-src 'self'`),
  soit choix parmi les familles Google déjà autorisées. Unifier le `<link>` Google Fonts dupliqué et
  incohérent sur les 8 pages.
* Bouton « Réinitialiser au thème par défaut » → `reset&doc=theme`.

### 3.2. `tab-pages.js` — Constructeur de pages par blocs (esprit Elementor)

**Modèle de données** — une page = liste ordonnée de **blocs** :

```
{ id, type, props:{…}, style:{align,size,spacing,…(tokens)}, text:{ en:"…", fr:"…", … }, children:[…] }
```

**Types de blocs** :
* *Statiques* : `heading`, `richtext`, `image`, `divider`, `spacer`, `button`, `hero`, `columns`
  (conteneur layout), `gallery`, `cta`, `html` (brut, réservé opérateur de confiance, **assaini**).
* *Widgets dynamiques* : `stat-grid` (nombre de datasets / compteurs configurables),
  `latest-datasets` (dernières entrées), `dataset-carousel`, `counter`. Ils tirent leurs données de
  `Catalog`.

**UI éditeur** (vanilla, sans lib) : palette de blocs à gauche (ajouter) · liste centrale des blocs
avec **glisser‑déposer pour réordonner** + éditeurs inline · panneau de réglages à droite pour le bloc
sélectionné. **Draft / Published**. **Aperçu en direct** dans une **iframe même‑origine** de la page
publique en mode brouillon (`?preview=draft` + `postMessage`, exactement comme `tab-datasets`).
Boutons **Publier**, **Aperçu**, **Revenir au défaut**.

**Rendu public** — nouveau `js/core/page-renderer.js` (IIFE classique) : sur `home`/`about`/pages
custom, fetch `config/pages/<page>.json`, rend la liste de blocs dans un conteneur de montage. Lit
`published` (ou `draft` si `?preview=draft` **et** session admin valide). Rich text **assaini** vers un
sous‑ensemble sûr (pas de `<script>`, cf. avertissement `data-i18n-html`/XSS du recon). Sélection de
locale avec repli `en`.

**Pages éditables** : `home` (index) et `about` deviennent full‑blocs. `explorer`/`viewer` restent des
pages moteur (non éditées par blocs) mais leurs intitulés/intro viennent de `instance.json`.

**Choisir quels blocs afficher + comment nommer les entités** = ordre/visibilité des blocs +
terminologie `specimen` (§2.2).

**Stretch avancé (optionnel, à cadrer)** : **pages custom + éditeur de menu de navigation** — l'opérateur
crée des pages supplémentaires (`config/pages/<slug>.json`) et les ajoute à la nav. Servi par une page
générique `page.html?slug=…` rendue par `page-renderer.js`. C'est le « vraiment poussé » façon
Elementor ; proposé mais isolable si on veut livrer plus tôt.

### 3.3. `tab-branding.js` — Identité & terminologie

Champs : nom produit / nom instance / organisation, terminologie `specimen` (sing/plur), SEO
(`description`, `keywords`), pied de page (copyright, liens), logos (upload → `assets/branding/`),
navigation (pages activées + ordre), presets couleur de canaux, définitions de stats, schéma de champs
de métadonnées, facettes. Persiste `config/instance.json`.

### 3.4. `tab-legal.js` — Mentions légales

Éditeur texte par section (mentions, confidentialité, conditions), **multi‑locale**, mise en page fixe.
Persiste `config/legal.json`. Rendu par une nouvelle page `legal.html` (layout fixe lisant le JSON).

### 3.5. Aperçu / brouillon / retour au défaut (transverse)

* **Draft/Published** natif pour les pages (§3.2) et « reset » pour thème/pages/branding/legal via
  `config/defaults/neutral`.
* Garde « unsaved » (`bus.js setDirtyGuard/setUnsaved`) sur tous les éditeurs à état.

---

## 4. Objectif 3 — Installation minimale et guidée (wizard)

**Détection fresh‑install inchangée** : `needsSetup = absence de api/admin_credential.json` (ne pas y
mêler `instance.json`, sinon un déploiement legacy ré‑entrerait en setup après upgrade — cf. risque
recon). Un déploiement legacy (cred présent, pas d'`instance.json`) = **configuré** ; le moteur prend
alors les défauts neutres embarqués, l'opérateur personnalise ensuite via les onglets.

**Wizard multi‑étapes** (dans la branche `setup` de `shell.js showGate`, UI façon stepper
`install.php`, une étape visible à la fois) :

1. **Compte admin** — username + mot de passe (unifier le minimum à **8**, aujourd'hui 4 côté HTTP vs 8
   côté `install.php`). Écrit `api/admin_credential.json` create‑exclusive (`O_EXCL`/`fopen 'x'`).
2. **Identité de l'instance** — nom produit/instance, organisation, terminologie `specimen` sing/plur.
3. **Thème de départ** — choix d'un **preset de palette** + défaut clair/sombre + couleur d'accent +
   police. Écrit `config/theme.json` (+ génère `theme.css`).
4. **Textes essentiels** — tagline/hero, pied de page/copyright, intro About optionnelle.
5. **Terminer** — écrit `config/instance.json`, seed `config/pages/*` et `config/legal.json` depuis
   `config/defaults/neutral`, s'assure de l'arborescence `DATA_WEB/{fixed,live,tracking}` +
   `catalog.json` vide (ce que fait déjà `install.php` mais pas un `dev_server.py` neuf).

**Jumeaux** : logique `needsSetup`/configure triplée (`dev_server.py`, `api/auth.php`, `install.php`) →
mise à jour en lockstep. `install.php` gagne les mêmes étapes 2‑4 (il fait déjà 1). Endpoint configure
rate‑limité via le même `_BRUTE`.

**Le plus simple possible à installer** (exigence n°1) : `install.php` déposé seul → wizard
prérequis→download release signée→extraction→**compte + identité + thème + textes**→lock. Un seul
fichier à déposer, puis tout depuis l'admin.

---

## 5. Objectif 4 — Catalogue de plugins first‑party (curé & signé)

Réutilise **intégralement** la machinerie release/trust/sandbox existante ; **aucune** nouvelle
exécution de code arbitraire non vérifié.

### 5.1. Ce qui existe déjà (à réemployer tel quel)
Chaîne d'authenticité fail‑closed (clé Ed25519 épinglée → `SHA256SUMS.sig` → sha256 par fichier via
`version.json`), extraction zip durcie (`_extract_release` / `install.php zip_preflight`), resolver de
compat 3‑jumeaux (`compat.js`/`_compat_satisfies`/PHP), trust gate à hash épinglé
(`plugin-trust.json`, INV‑4/INV‑5), sandbox iframe capabilities (`plugin-sandbox.js`), découverte
folder‑driven (`/api/plugins`→`manifest.json`→embarqué), révocation live (`_TRUST_EPOCH`).

### 5.2. Pièces nouvelles
1. **Clé de signature** (aujourd'hui **vide** partout : `_RELEASE_PUBKEY_HEX=""`, `install.php $PINNED_PUBKEY=''`) :
   exécuter `tools/gen_signing_key.py`, committer la clé publique en **source**. **Recommandation :
   clé marketplace séparée** `_MARKETPLACE_PUBKEY_HEX` (+ jumeau PHP) pour découpler l'autorité de
   signature des plugins de celle des releases cœur (rotation indépendante). *Décision opérateur.*
2. **Index catalogue signé** `marketplace-catalog.json` — hébergé comme asset de release d'un dépôt
   marketplace, **signé** avec la clé épinglée : `[{id,name,placement,subtype,description,creator,icon,
   platformCompat,sandboxCapabilities,repo,latestVersion,assetUrl,sumsUrl,sigUrl,sha256}]`. L'opérateur
   fait confiance à la **liste** parce qu'elle est signée ; chaque release plugin est vérifiée
   indépendamment. (Piège recon : un catalogue non signé = point de compromission unique.)
3. **Builder par plugin** `tools/build_plugin_release.py` (clone de `build_release.py`, allowlist =
   le seul dossier plugin) → `plugin-<id>-<ver>.zip` + `version.json` + `SHA256SUMS` + `.sig` ; CI signe
   avec `LUMEN_SIGNING_KEY`. Zip déterministe (timestamp 1980, entrées triées) pour sha256 stable.
4. **Endpoint install** `POST /api/admin.php?action=install_plugin {catalogId}` (auth+CSRF+**ré‑auth mot
   de passe**, comme `_approve_plugin`). Pipeline réutilisant l'existant : vérifier sig catalogue →
   download zip → vérifier `SHA256SUMS.sig` (fail‑closed) → vérifier sha256 du zip → extraction durcie →
   vérifier `version.json` par fichier → valider `plugin.json` id/placement → **gate compat** → move
   atomique vers `js/modules/<placement>/<id>/` → **enregistrer l'approbation** dans `plugin-trust.json`
   via le chemin `_approve_plugin` (le serveur **recalcule le hash sur disque**, mode issu du flag
   sandbox du catalogue) → bump `_TRUST_EPOCH` + régén `manifest.json`. Le plugin atterrit **approuvé**
   (pas « untrusted »), re‑vérifié par `loadModules` au prochain chargement viewer.
5. **Endpoint uninstall** `POST …?action=uninstall_plugin {path}` → `_safe_plugin_path` → garde
   « dernier shader » → delete dossier → `_revoke_plugin` → bump epoch (téardown sandbox live) → régén manifest.
6. **Namespacing** des plugins marketplace (préfixe créateur / chemin dédié) pour qu'une future release
   cœur ne puisse pas écraser une copie opérateur (collision `_build_plan`).
7. **Onglet `tab-marketplace.js`** (clone du patron `tab-updates`) : fetch catalogue signé, cartes
   name/creator/compat + **capacités demandées** (façon prompt d'app‑store), bouton Install (progress
   verify→download→extract comme l'updater), split installés/disponibles/incompatibles (annoté compat),
   Uninstall. **Ré‑consentement** si une mise à jour de plugin élargit ses capacités.
8. **Parité PHP** : implémenter verify+extract via `install.php release_signature_ok`/`zip_preflight`,
   **ou** documenter le marketplace comme `dev_server`‑only (cohérent avec `update_apply` non supporté
   en PHP). *Décision.*
9. **Explicite dans l'UI** : seuls `tools/action|toggle` sont sandboxables ; **shaders/channels =
   confiance in‑page totale** (barre de risque plus haute). Badge de niveau de confiance par plugin.

### 5.3. Invariants de sécurité à préserver
INV‑4 (hash recalculé serveur après le move final, jamais celui déclaré) · INV‑5 (un artefact ne porte
JAMAIS `plugin-trust.json` ; l'endpoint est l'unique rédacteur d'approbation) · fail‑closed sur toute
échec de vérif (arbre intact, jamais de montage partiel) · clé publique en source (car `dev_server.py`
hors `_UPDATE_PROTECT`) · Ed25519 stdlib‑only (`ed25519_pure.py`) / libsodium PHP, aucune dépendance.

---

## 6. Contraintes transverses (respectées partout)

* **Pas d'ESM hors admin** : `instance-config.js`, `page-renderer.js`, `site-chrome` = IIFE classiques
  par nom nu, gardés `typeof X !== 'undefined'`, jamais `window.X`. Les onglets admin = ESM via `admpan.js`.
* **Pas de build** : tout est fetch runtime ou injecté serveur ; jamais de templating compile‑time.
* **CSP stricte à nonce** : aucun `<style>`/`<script>` inline sans nonce ; thème via `<link>` servi +
  CSSOM (`style-src-attr`) ; aucun CDN ; `_csp_policy` (Py) et `lumen_csp_policy` (PHP) restent identiques.
* **Jumeaux** : chaque endpoint en `dev_server.py` **et** `api/*.php` (+ manifest statique si pertinent
  pour la découverte). Router `datasets.php` a déjà un `rebuild_catalog` divergent → router les
  nouvelles écritures par `_admin_lib.php`.
* **Écritures atomiques** : `_atomic_write` (Py) / `admin_write_json` (PHP) exclusivement.
* **`_UPDATE_PROTECT`** : ajouter tous les `config/*` opérateur (Py + PHP) + `api/*.json`.
* **i18n parité en/fr/es** : préférer la substitution de tokens config à l'ajout de clés parallèles.
* **Sécurité path** : valider tout id/sous‑chemin (`_safe_dataset_dir`/`_safe_plugin_path` / PHP `admin_safe_dataset`).
* **Versioning autonome** : chaque changement bump la plateforme Web via un nouveau
  `changelog/changelog_X.Y.Z.md` (`[ADDED]`/`[OPTIMIZED]`/`[FIXED]`) + ligne `[Versioning]` finale.
* **Git** : tout sur `dev`, commits directs, pas de sous‑branches/worktrees ; `main` seulement sur
  demande explicite.

---

## 7. Migration IRIBHM (ne rien casser)

1. **Extraire** tout le contenu IRIBHM actuel (HTML/i18n/JS) vers `config/*` → committé comme la `config/`
   par défaut du dépôt. L'instance vivante reste identique.
2. **Créer** `config/defaults/neutral/*` = white‑label pur.
3. **Release build** : `tools/build_release.py` **exclut `config/*` opérateur** du zip et y injecte
   `config/defaults/neutral/*` comme `config/*` livré (ou laisse le wizard seeder le neutre). Ainsi le
   **produit distribué est neutre** ; l'instance IRIBHM garde son identité via sa `config/` locale
   protégée (absente du manifest ⇒ jamais écrasée par update, comme les plugins side‑loaded).
4. **Legacy guard** : `needsSetup` reste sur l'absence de credential ; un déploiement IRIBHM déjà
   configuré ne ré‑entre pas en wizard.
5. **Preprocessing** (`4-catalog_generator.py` regex stage/embryo) = source amont des conventions
   `E8.5`/`Em<n>`. **Hors scope Web** mais à noter : pour un découplage total du domaine, rendre ces
   regex configurables (composant versionné séparé). Proposé en option.

---

## 8. Feuille de route par phases (chaque phase livrable & rétro‑compatible)

| Phase | Contenu | Version cible |
|---|---|---|
| **0 — Fondations** | `instance-config.js` + store `config/` public + `/api/site.php` (+ PHP) + injection `_serve_html` (+ PHP) + `_UPDATE_PROTECT` + défauts neutres + substitution tokens i18n | **web v1.8.0** |
| **1 — Découplage (Obj 1)** | dé‑hardcode HTML (`data-instance`), dé‑domanise i18n (en/fr/es), dé‑domanise JS (stats/facettes/couleurs canaux/relations), branding assets, schéma champs métadonnées admin. Défaut neutre + config IRIBHM préservée | **web v1.8.x** |
| **2 — Éditeur de thème (Obj 2a)** | `tab-appearance` + `config/theme.json`→`theme.css` servi + tokeniser les échappées + pipeline police | **web v1.9.0** |
| **3 — Constructeur de pages + légal + branding (Obj 2b)** | modèle de blocs, `page-renderer.js`, `tab-pages` (draft/preview/publish/reset), `tab-branding`, `tab-legal`, `legal.html` ; pages custom + menu (stretch) | **web v1.9.x / v1.10.0** |
| **4 — Wizard d'installation (Obj 3)** | wizard multi‑étapes, unif. mot de passe, seed neutre, dirs data, parité `auth.php`/`install.php` | **web v1.10.x** |
| **5 — Marketplace (Obj 4)** | keying Ed25519, format catalogue signé + signer, `build_plugin_release.py`, endpoints install/uninstall, `tab-marketplace`, parité PHP | **web v1.11.0** |

Bump **Y** justifié (nouveaux sous‑systèmes majeurs). Chaque phase ajoute son changelog.

---

## 9. Décisions arrêtées (validées par l'opérateur, 2026-07-05)

1. **Clé de signature marketplace** → **clé dédiée `_MARKETPLACE_PUBKEY_HEX`** séparée de la clé de
   release cœur (autorité de signature des plugins découplée, rotation indépendante).
2. **Emplacement du store config** → **nouveau dossier public `config/` à la racine**.
3. **Modèle de contenu éditable** → **blocs avec textes inline multi‑locale** dans `config/pages/*`.
   Contrainte confirmée : à chaque saisie de texte, l'éditeur DOIT permettre de saisir la valeur
   dans **plusieurs langues** (un champ par locale disponible, repli `en`).
4. **Pages custom + éditeur de menu** → **tout inclus, rien différé** — livrable achevé attendu.
5. **Parité PHP** → **priorité absolue au PHP** : la plateforme doit fonctionner à 100 % sur un
   hôte PHP. Chaque endpoint (config, thème, pages, wizard, **marketplace**) a une implémentation PHP
   de premier plan (pas un repli). *(Note : l'auto-pivot Blue-Green de l'updater reste `dev_server`
   uniquement par nature — l'install marketplace, elle, est portée en PHP via `install.php`.)*
6. **Découplage du preprocessing** → **laissé aux scripts Python séparés** (hors scope Web).

---

## 10. Risques & mitigations (synthèse)

* **Double‑source des titres** → injection serveur + suppression des `document.title=` JS.
* **Triplication i18n** → substitution de tokens config plutôt que clés parallèles.
* **CSP bloque le `<style>` injecté** → thème via `<link>` servi + CSSOM, jamais de `<style>` runtime.
* **Écrasement par update** → `config/*` dans `_UPDATE_PROTECT` + exclus du zip release (survivent).
* **Facette « stage » porteuse** (filtres/tri/related) → chemin « facette désactivée » propre.
* **Régression visuelle** (couleurs canaux) → défaut config reproduisant l'aspect IRIBHM.
* **Twin‑drift Python/PHP** → chaque endpoint dans les deux ; router par `_admin_lib.php`.
* **Marketplace = RCE potentiel** → catalogue signé + release signée fail‑closed + trust gate +
  sandbox ; clé épinglée obligatoire (aujourd'hui vide) ; INV‑4/INV‑5 respectés.
* **Legacy re‑setup** → `needsSetup` sur credential uniquement + garde legacy.
* **XSS rich‑text** → assainissement du contenu opérateur (sous‑ensemble sûr).
```
