# 15. Les plugins, la confiance et le catalogue signé

::: chapter-intro
- Presque tout ce que vous faites dans le viewer (mesurer, capturer, régler un histogramme, choisir un mode de rendu) est fourni par un **plugin** : un petit dossier que la plateforme découvre, vérifie puis branche.
- Un plugin est du **code d'un tiers**. Lumen3D le traite comme une application de téléphone : il faut **vérifier son identité à l'installation**, lui accorder des **permissions précises**, et pouvoir l'**enfermer**.
- Ce chapitre explique les deux faces du système : **comment un plugin fonctionne** (§15.1 à §15.11) et **pourquoi on peut lui faire confiance** (§15.12 à §15.19).
:::

::: analogy
**Un smartphone et sa boutique d'applications.** La plateforme est le téléphone. Un plugin est une application. Le catalogue signé est la boutique officielle : chaque application y porte un sceau. À l'installation, le téléphone contrôle le sceau (signature), l'empreinte du fichier (hash) et la compatibilité avec sa version (platformCompat). Il enferme ensuite l'application dans un bac à sable et ne lui donne que les permissions demandées (capacités).
:::

Le chapitre 12 explique **comment utiliser** chaque outil, le chapitre 13 ce qu'il y a **sous le capot** de chacun, le chapitre 14 **les écrans** de l'administration. Ici, on regarde **le système qui les porte tous**.

## 15.1 Qu'est-ce qu'un plugin ?

Un plugin est un **dossier** rangé dans `js/modules/<placement>/<id>/`. Il contient trois sortes de fichiers.

![Un dossier, trois sortes de fichiers, trois destinations possibles.](img/ch15/anatomie.svg){width=100%}

| Fichier | Rôle | Analogie |
|---|---|---|
| `plugin.json` | Qui je suis, où je me place, ce que j'exige | La carte d'identité |
| `index.js` | Ce que je fais (appelle `PluginRegistry.implement`) | Le savoir-faire |
| `lang/<code>.json` | Mes textes en français, anglais, espagnol, néerlandais… | Le mode d'emploi traduit |

Le **dossier parent** décide de ce que devient le plugin. C'est son **placement**.

| Placement | Ce que le visiteur voit | Nombre au catalogue |
|---|---|---|
| `tools` | Un bouton de la barre d'outils (ou un outil exclusif) | 23 |
| `channels` | Un réglage sous chaque canal de fluorescence | 2 |
| `shaders` | Une entrée du menu [Mode de rendu]{.ui} | 3 |

Total : **28 plugins**, exactement les 28 entrées du catalogue signé (§15.17).

::: note
**Découverte automatique.** Pas de liste à modifier : on dépose un dossier, il apparaît ; on le retire, il disparaît. La liste est reconstruite à chaque chargement de page (§15.3).
:::

## 15.2 La carte d'identité : `plugin.json` champ par champ

Voici le `plugin.json` réel de l'outil de mesure (ses champs sont expliqués dans le tableau suivant).

```json
{
  "id": "measure-distance",   "name": "Measure Distance",   "version": "1.1.4",
  "platformCompat": ">=1.53.0",
  "dataTypes": ["3d", "live", "2d"],   "contexts": ["page", "panel"],
  "creator": "IRIBHM",   "placement": "tools",
  "group": "tools",   "subtype": "tool",   "icon": "ruler",   "order": 20,
  "tool": "measure",   "shortcut": "m",
  "description": "Pick two 3D surface points to measure calibrated physical distance in µm.",
  "i18nTitle": "title",   "i18nLanguages": ["en", "fr", "es", "nl"]
}
```

Le chargeur n'**exige** que l'`id` (et qu'il soit égal au nom du dossier). Tout le reste a une valeur par défaut raisonnable.

| Champ | Ce qu'il dit | Valeurs et règles |
|---|---|---|
| `id` | Identité unique | **Égal au nom du dossier** (`[A-Za-z0-9_][A-Za-z0-9._-]*`), sinon quarantaine |
| `name`, `creator`, `description` | Texte d'affichage (carte du catalogue, onglet Plugins) | Libre |
| `version` | Version **du plugin** (SemVer) | Le catalogue la compare pour proposer une mise à jour |
| `placement` | Où il se place | `tools`, `channels` ou `shaders` ; doit **égaler le dossier parent** |
| `platformCompat` | Versions de la plateforme acceptées | Intervalle ou liste (§15.15) ; absent = compatible |
| `dataTypes` | Types de données couverts | `3d`, `2d`, `live` ; **absent** = ancien plugin du viewer de volumes |
| `contexts` | Où il sait vivre | `page` (page complète) et/ou `panel` (page embarquée) ; **absent** = `page` seulement |
| `requires` | Sources dont il a besoin | `bricks`, `webstack`, `tracking` ; le bouton reste **caché** tant qu'elles manquent |
| `group` | Grappe de la barre d'outils | `tools`, `export`, `visuals`, `layouts` |
| `subtype` | Sorte de bouton | `tool`, `toggle`, `action` (canaux : `per-channel`) |
| `icon` | Pictogramme | Nom d'une icône **Lucide** |
| `order` | Place dans la grappe | Croissant ; **999** si absent |
| `tool` | Nom de l'outil exclusif | Défaut = l'`id` ; seulement pour `subtype: "tool"` |
| `shortcut` | Raccourci clavier | Une touche, pour un outil exclusif (`m` pour la mesure, `c` pour la coupe) |
| `buttonId` | Identifiant HTML du bouton | Simple jeton, accepté seulement si aucun autre élément ne le porte |
| `i18nTitle`, `i18nAria` | Clés du libellé et du texte d'accessibilité | Cherchées dans `lang/<code>.json` du plugin |
| `i18nLanguages` | Langues livrées | Le serveur la **recalcule** d'après le dossier `lang/` |
| `renderModeValue`, `default` | Modes de rendu seulement | Numéro de mode du lancer de rayons (0, 1, 2) ; `default: true` = mode choisi à l'ouverture |
| `sandbox`, `sandboxCapabilities` | Plugin écrit pour le bac à sable | §15.14 |

::: warning
**Un champ `trust` dans `plugin.json` est ignoré.** Le plugin est écrit par un tiers : s'il pouvait déclarer lui-même son niveau de confiance, la vérification n'aurait plus de sens. Le registre **supprime** ce champ et ne lit le verdict que de la réponse du serveur.
:::

## 15.3 Comment la plateforme trouve les plugins

![Trois sources par ordre de préférence, puis cinq étapes toujours dans le même ordre.](img/ch15/decouverte.svg){width=100%}

La page demande la liste à `PluginRegistry.discover()`. Trois sources, la première qui répond gagne.

1. **Le serveur** (`api/plugins.php`, puis `api/plugins` : l'adresse `.php` est essayée en premier car elle fonctionne sur les deux types de serveur). Il répond avec, pour chaque plugin, le `plugin.json` **complet**, les traductions déjà incluses et le **verdict de confiance** (§15.12).
2. **Le fichier `js/modules/manifest.json`** : des triplets `{chemin, placement, id}` seulement. Le serveur le **réécrit** à chaque découverte, pour qu'un hébergement purement statique hérite d'une liste à jour.
3. **La liste embarquée** dans le code : 17 chemins du noyau historique. C'est un filet : même si tout le reste échoue, le viewer démarre.

Le serveur **filtre** avant de répondre : il retire les plugins désactivés par l'administrateur, les plugins **incompatibles** et les plugins **non fiables**. Un plugin non fiable n'est donc même pas candidat au chargement.

::: why
**Pourquoi tout attendre avant de dessiner ?** Si la barre d'outils était dessinée avant la fin du chargement des plugins, elle apparaîtrait vide. Cette règle a été violée une fois (version 0.12.45) : le résultat était un viewer sans outils. Depuis, `discover` et `loadModules` sont **toujours terminés** avant la construction de la moindre interface.
:::

::: tech
Un dossier n'est pris en compte que si son nom respecte `^[A-Za-z0-9_][A-Za-z0-9._-]*$` (aucun `..`, aucune barre oblique) et si son `plugin.json` est lisible et ne contredit pas le dossier parent. Sinon il est **ignoré silencieusement** par le serveur. Les tableaux de traductions ne sont joints que si l'anglais est présent. La réponse porte aussi `devTrust` (le mode développeur est-il actif ?) et `trustEpoch` (§15.14).
:::

## 15.4 Le chargement : sept barrières

Une fois la liste en main, `loadModules` examine chaque plugin à travers une série de contrôles. Les quatre premiers sont des **choix** (ce plugin vise-t-il cette page ?), les suivants sont des **sécurités**.

![Chaque plugin franchit les barrières dans l'ordre ; à droite, ce qui arrive à ceux qui échouent.](img/ch15/barrieres.svg){width=74%}

Deux sortes d'échec, à ne pas confondre :

- **Laissé de côté** (barrières 3 et 4) : le plugin n'est pas fait pour cette page. Un outil de photographie 2D n'a rien à faire sur un volume 3D. Ce n'est **pas une faute** : seul un message d'information apparaît dans la console.
- **Mis en quarantaine** : quelque chose ne va pas. La raison est notée dans un registre (`PluginRegistry.getQuarantined()`) et un avertissement apparaît dans la console du navigateur.

::: tech
**Raisons de quarantaine** (champ `reason`) : `meta-unreachable` (plugin.json introuvable), `invalid-meta` (JSON illisible, id absent ou différent du dossier, placement incohérent, plugin.json modifié pendant la vérification), `incompatible`, `untrusted`, `trust-unavailable` (le module de confiance n'est pas chargé : par prudence rien n'est exécuté), `sandbox-unsupported-placement`, `sandbox-unavailable`, `sandbox-boot-failed`, `script-failed` (index.js ne se charge pas), `no-impl` (index.js n'a jamais appelé `implement`), `init-failed` (init a levé une exception), `revoked` (approbation retirée à chaud), `load-error` (autre exception).
:::

::: remember
**Un plugin en panne ne coûte jamais le viewer.** Chaque plugin est chargé, initialisé et activé dans son propre `try/catch`, et une barrière globale entoure toute la phase des plugins : même si tout ce sous-système échouait, le canvas 3D démarrerait.
:::

## 15.5 Qui se charge où ? `dataTypes` et `contexts`

Deux champs de `plugin.json` décident si le plugin est pris sur une page donnée.

:::: cols
::: col
**`dataTypes`** : le **type** de dataset (`3d`, `2d`, `live`).

- Si présent : le plugin tourne sur ces types et **sur aucun autre**.
- Si absent : c'est un ancien plugin écrit pour le viewer de volumes ; seul le viewer 3D / live l'accepte (jamais la page 2D).
:::
::: col
**`contexts`** : la **situation** de la page.

- `page` : page complète, avec sa barre d'outils.
- `panel` : page **embarquée** sans barre (panneau de Comparer, volet de vue divisée, aperçu de l'admin).
- Si absent : `page` seulement (**refus par défaut** dans une page embarquée).
:::
::::

![Résultat réel pour les 28 plugins, calculé d'après leurs plugin.json.](img/ch15/matrice.svg){width=100%}

| Page | Plugins chargés |
|---|---|
| Volume 3D, page complète | **18** |
| Volume 3D, dans un panneau | **12** |
| Timelapse (live), page complète | **23** |
| Timelapse (live), dans un panneau | **15** |
| Photographie 2D, page complète | **9** |
| Photographie 2D, dans un panneau | **4** |

**Dix plugins sont « page seulement »** : Chunk Debug, Decompose by Channel, Download Center, Figure Panel Builder, Presentation Mode, Screenshot, Screenshot (sandboxed), Split View, Tracking Charts, Cell Distance. Un panneau de 300 pixels ne peut pas accueillir un plein écran, un menu modal ou une vue divisée dans la vue divisée. **Ce n'est pas une panne** : l'administrateur le voit aussi dans l'aperçu de l'onglet Datasets.

::: example
Sur la page 2D, le viewer demande `dataType = 2d`. `measure-distance` déclare `["3d","live","2d"]` : pris. `zstack-browser` ne déclare rien : un ancien plugin du viewer de volumes, donc **refusé** par la page 2D (qui n'accepte pas les plugins sans `dataTypes`). `calibrated-grid` déclare `["2d"]` : pris sur la 2D, absent du volume 3D.
:::

## 15.6 Le cycle de vie d'un plugin

![De l'enregistrement à la fin de la page, avec la quarantaine comme issue de secours.](img/ch15/cycle-vie.svg){width=100%}

Un plugin est un objet que `index.js` remet au registre : `PluginRegistry.implement('mon-id', { … })`. Les crochets, tous facultatifs :

| Crochet | Appelé quand | Détail |
|---|---|---|
| `prepare(ctx)` | Avant le premier chargement de briques | État **initial** de la scène (ex. Orientation Axes applique la vue par défaut). Synchrone |
| `init(ctx)` | Après le chargement du volume | Reçoit son contexte (§15.7) ; peut renvoyer son instance |
| `activate()` | Clic sur le bouton, ou changement de mode de rendu | Renvoie `{ active, icon }` pour une bascule |
| `deactivate()` | Désactivation | Retour à l'état « initialized » |
| `getState()` / `setState(s)` | Sauvegarde / restauration de l'espace de travail | Les états de tous les plugins sont rassemblés dans un seul objet |
| `reset()` | [Réinitialiser l'espace de travail]{.ui} | Seuls les plugins qui le déclarent sont touchés |
| `onLanguageChange()` | Changement de langue | Repeindre les textes dynamiques |
| `getExports()` / `getGraph()` | Ouverture du Centre de téléchargement | §15.9 |
| `dispose()` | Fin de page | Libérer les ressources |

Les trois **sortes de bouton** (`subtype`) se comportent différemment.

| `subtype` | Comportement | Exemple |
|---|---|---|
| `action` | Un clic, une fonction, rien à retenir | Screenshot |
| `toggle` | Allumé / éteint, l'état est mémorisé et rendu au bouton | Toggle Grid |
| `tool` | **Outil exclusif** : un seul actif à la fois (géré par `ToolManager`) | Measure Distance |

::: example
Voici le plugin Toggle Grid (version condensée). Chaque clic fait passer la grille d'« aucune » à « normale » puis « fine ».

```js
PluginRegistry.implement('toggle-grid', {
  init(ctx) { this._ctx = ctx; this._mode = 0; return this; },
  activate() {
    this._mode = (this._mode + 1) % 3;
    VolumeViewer.setGridMode(this._mode);
    return { active: this._mode > 0 };       // le bouton s'allume
  },
  getState() { return { gridMode: this._mode }; },
  setState(s) {
    this._mode = s.gridMode;
    VolumeViewer.setGridMode(this._mode);
    PluginRegistry.syncToolbarButton('toggle-grid', { active: this._mode > 0 });
  },
  reset() { this.setState({ gridMode: 0 }); }
});
```
:::

Les **plugins de canal** et de **mode de rendu** ont des contrats propres : un plugin de canal fournit `getChannelUI(canal)` (le HTML) puis `bindChannelUI(…)` (les écouteurs) ; un plugin de mode de rendu se contente de son `activate()`, qui règle le mode du lancer de rayons (chapitre 9).

## 15.7 Ce que reçoit un plugin : l'objet `ctx`

À l'`init`, la page remet à chaque plugin un **contexte** : une façade qui lui donne accès à ce dont il a besoin, rien de plus.

![Les douze rubriques du contexte d'un plugin.](img/ch15/contexte.svg){width=100%}

| Rubrique | Ce qu'elle offre |
|---|---|
| `ctx.viewer` | Modes de rendu, coupes, vues, grille et axes, mesures, `renderNow()` (rendre l'image tout de suite avant de lire le canvas) |
| `ctx.dataset` | `getMeta()` (le `metadata.json`), `getId()`, `getBasePath()` ; sur la page 2D aussi la collection et `open(id)` |
| `ctx.channels` | L'état des canaux (couleur, fenêtre, gamma) |
| `ctx.measurements` | Les mesures mémorisées par dataset et par domaine |
| `ctx.ui` | `toast`, `addSidebarSection`, `addCanvasPanel`, `getCanvas`, `openStudio`… |
| `ctx.tools` | L'outil exclusif courant, `activate`, `onChange` |
| `ctx.tracking` | Le suivi cellulaire d'un timelapse (ci-dessous) |
| `ctx.workspace` | Lire / appliquer l'espace de travail |
| `ctx.i18n` | `t('clé')` : cherche `plugins.<id>.clé`, repli automatique sur l'anglais |
| `ctx.slicer` | Le plan de coupe oblique |
| `ctx.iframe` | Savoir si la page est embarquée ; `postMessage` vers l'hôte |
| Divers | `getCanvasBlob`, `getCustomExports`, `getGraph` |

Chaque plugin reçoit **sa propre copie** du contexte : seule la rubrique `i18n` diffère, car elle est liée à l'identifiant du plugin.

::: tech
**Le contexte de la page 2D** a la même forme, avec les fonctions d'une photographie : `viewer.getView/setView`, `addOverlay`, `setOrientation`, `setAdjustments`, `getPhysicalView`, `getNativeCanvas`, et `ui.openStudioWith`. Un plugin qui s'adresse aux deux pages lit donc ses fonctions avec précaution (`ctx.viewer.renderNow?.()`).
:::

### Le suivi cellulaire : `ctx.tracking`

Les cinq plugins de suivi ne lisent jamais `tracks.json` eux-mêmes. La page en garde **une seule copie** (sous forme de tableaux compacts à 32 bits) et la leur prête.

| Fonction | Rôle |
|---|---|
| `isAvailable()`, `whenLoaded()` | Le dataset a-t-il un suivi ? Attendre qu'il soit chargé |
| `positionUm(cellule, image, options, sortie)` | Position d'une cellule, en µm, à une image donnée |
| `cellsAt(image)` | Les cellules présentes à cette image |
| `pick(x, y)` | Cellule sous le curseur (−1 si rien) |
| `select(c)`, `getSelected()` | **Une seule sélection partagée** par tous les plugins |
| `getOptions()`, `setOptions({ neighborThresholdUm })` | Rayon de voisinage (5 à 500 µm) partagé |
| `on('loaded' · 'frame' · 'refresh' · 'selection' · 'options' · 'style', rappel)` | S'abonner ; renvoie la fonction de désabonnement |

Résultat : cliquer une cellule dans l'Inspecteur la sélectionne aussi dans les trajectoires et les graphiques, sans qu'ils se parlent.

### Les textes d'un plugin

Un plugin apporte ses traductions dans `lang/<code>.json`. Elles sont greffées dans l'arbre de traduction de la plateforme sous `plugins.<id>`. Si une langue manque, c'est **l'anglais** qui s'affiche : un plugin livré en anglais seul reste utilisable partout.

## 15.8 La barre d'outils est fabriquée, pas écrite

Le fichier `viewer.html` ne contient **aucun bouton de plugin**. Il contient quatre **grappes** vides : [Outils]{.ui}, [Exporter]{.ui}, [Visuels]{.ui}, [Dispositions]{.ui}, plus un bouton statique « Navigation ». `buildToolbarButtons` crée ensuite un bouton par plugin d'outils, d'après son `plugin.json`.

![Les 23 plugins d'outils, rangés d'après leur champ group, triés d'après order.](img/ch15/barre-outils.svg){width=100%}

Pour chaque plugin, le constructeur :

1. choisit la **grappe** d'après `group` (un groupe sans grappe sur la page : avertissement, bouton ignoré) ;
2. crée un bouton **outil exclusif** (`subtype: "tool"`, relié par `data-tool`) ou un bouton d'**action / bascule** (relié par `data-plugin-id`) ;
3. pose le pictogramme `icon`, l'infobulle `i18nTitle` (traduite et retraduite à chaque changement de langue) et le texte d'accessibilité ;
4. **cache** le bouton si `requires` n'est pas satisfait (`tracking` : le dataset a un bloc de suivi ; `bricks` / `webstack` : la source existe) ;
5. enregistre le raccourci `shortcut` auprès de `ToolManager`.

Résultat : **la barre change d'un dataset à l'autre**, sans une ligne de code de page.

![Barre d'outils d'un volume 3D (jeu de démonstration).](img/ch15/barre-3d.png){.shot width=100%}

![Barre d'un timelapse suivi : trois outils de plus (inspecteur, distance, graphiques) et deux bascules de suivi (jeu de démonstration).](img/ch15/barre-live.png){.shot width=100%}

![Barre d'une photographie 2D : les cinq plugins 2D remplacent les outils de volume (jeu de démonstration).](img/ch15/barre-2d.png){.shot width=100%}

::: tip
**Votre barre est différente de celle du manuel ?** C'est normal : l'administrateur a installé d'autres plugins (chapitre 14) ou en a désactivé. Un bouton absent n'est jamais une panne du viewer.
:::

## 15.9 Plugins et espace de travail, exports, pages embarquées

### Espace de travail

`getState()` de chaque plugin est rassemblé dans le **même objet** que la caméra et les canaux : c'est ce que gardent [Sauvegarder]{.ui} et [Restaurer]{.ui} du Centre de téléchargement, et ce que contient l'adresse `#state=…`. Un plugin sans `getState` n'est pas affecté. Un plugin encore « registered » (pas encore initialisé) est sauté.

### Exports

`getExports()` renvoie une liste d'entrées `{ action, handler, … }` que le Centre de téléchargement ajoute à ses propres exports. `getGraph()` renvoie un graphique à l'écran (Plotly) que le Centre sait exporter. Le registre **collecte** ces réponses en ignorant tout plugin qui lève une exception : **un export défectueux ne fait jamais perdre les exports de la plateforme**.

### Pages embarquées (Comparer, vue divisée, aperçu)

Une page embarquée n'a pas de barre d'outils visible. Elle **décrit** donc ce qu'elle offre : `describeToolbar()` liste les outils exclusifs et les bascules (avec leur état courant) des seuls plugins qui acceptent le contexte `panel`. L'hôte (la page Comparer) **dessine ses propres boutons** à partir de cette description, puis envoie `PLUGIN_ACTIVATE` ou `SET_TOOL` ; l'état revient par `syncToolbarButton`. Le détail du protocole est au chapitre 13.

## 15.10 Les 28 plugins du catalogue

**Modes de rendu** (placement `shaders`, chargés partout).

| Plugin | En une ligne |
|---|---|
| Fluorescence | Rendu par défaut : chaque canal émet sa couleur (mode 1) |
| Natural Fluorescence | Émission-absorption : les structures denses masquent ce qui est derrière (mode 2) |
| Structure (DVR) | Rendu volumique avec profondeur et occlusion (mode 0) |

**Canaux** (placement `channels`).

| Plugin | En une ligne |
|---|---|
| Histogram Controls | Histogramme d'intensité par canal et curseurs min / max / gamma |
| Gaussian Filter | Flou gaussien 2D dans le plan, par canal |

**Outils de volume** (`3d` et `live`).

| Plugin | Contexte | En une ligne |
|---|---|---|
| Slice through Volume | page + panneau | Coupe plane orientable ; la coupe prend le canvas |
| Z-Stack Browser | page + panneau | Parcourir les coupes (exclusif avec la coupe oblique) |
| Measure Distance | page + panneau | Deux points → distance en µm |
| Decompose by Channel | page | Un canal par panneau |
| Orientation Axes | page + panneau | Gizmo d'orientation et vue par défaut |
| Toggle Grid · Toggle Axes · Hide/Show 3D Volume | page + panneau | Grille, axes, volume |
| Chunk Debug | page | Frontières des briques (exige `bricks`) |

**Outils communs à tous les types.**

| Plugin | Contexte | En une ligne |
|---|---|---|
| Download Center | page | Fichiers, mesures, métadonnées, figures, espace de travail |
| Screenshot | page | Capture PNG de la vue |
| Screenshot (sandboxed) | page | La même, **en bac à sable** (plugin de référence) |
| Presentation Mode | page | Plein écran sans interface |

**Outils de photographie 2D** (`2d`).

| Plugin | Contexte | En une ligne |
|---|---|---|
| Calibrated Grid | page + panneau | Grille physique 1-2-5 en µm ou mm |
| Display Adjustments | page + panneau | Luminosité, contraste, gamma, balance, aplatissement |
| Orientation 2D | page + panneau | Rotation et miroir |
| Split View | page | Deuxième photographie côte à côte |
| Figure Panel Builder | page | Composer une planche de plusieurs photographies |

**Outils de suivi cellulaire** (`live`, exigent `tracking`).

| Plugin | Contexte | En une ligne |
|---|---|---|
| Tracking Trails | page + panneau | Trajectoires sur le volume |
| Tracking Surface | page + panneau | Surface de l'échantillon (`model.glb`) |
| Cell Inspector | page + panneau | Métriques, lignée, voisins, champ de vitesse |
| Tracking Charts | page | Graphiques de population, vitesse, mitoses |
| Cell Distance | page | Distance entre deux cellules |

## 15.11 Écrire un plugin

::: steps
1. Créez `js/modules/tools/mon-plugin/` (le nom du dossier est l'`id`).
2. Écrivez `plugin.json` (au moins `id`, `placement`, `group`, `subtype`, `icon`, `order`).
3. Écrivez `index.js` avec `PluginRegistry.implement('mon-plugin', { … })`.
4. Ajoutez `lang/en.json` (obligatoire comme repli), puis les autres langues.
5. Rechargez la page : le bouton apparaît. Sur un site de production, il porte d'abord l'étiquette **non fiable** : approuvez-le (§15.12).
:::

Exemple complet : un bouton qui affiche le nom du dataset.

```json
{ "id": "hello-dataset", "name": "Hello Dataset", "version": "1.0.0",
  "platformCompat": ">=1.53.0", "placement": "tools",
  "group": "export", "subtype": "action", "icon": "info", "order": 90,
  "dataTypes": ["3d", "live"], "contexts": ["page"], "creator": "Mon labo",
  "description": "Affiche le nom du dataset ouvert.",
  "i18nTitle": "title", "i18nLanguages": ["en", "fr"] }
```

```js
PluginRegistry.implement('hello-dataset', {
  init(ctx) { this._ctx = ctx; return this; },
  activate() {
    const meta = this._ctx.dataset.getMeta();
    this._ctx.ui.toast(this._ctx.i18n.t('hello') + ' ' + meta.name);
    return { active: false };                 // une action : pas d'état
  },
  dispose() { this._ctx = null; }
});
```

Avec `lang/en.json` : `{ "title": "Say hello", "hello": "Dataset:" }`.

::: see
Le guide complet pour les auteurs (contrats des canaux et des modes de rendu, exemples d'outils exclusifs, bonnes pratiques) est `DOCS/plugins/guide-creation-plugins.pdf` (source `.tex` dans le même dossier). Les tests des règles de ce chapitre : `tests/js/test_plugin_context_gate.mjs`, `test_plugin_datatype_gate.mjs`, `test_plugin_autonomy.mjs`, `test_plugin_lang.mjs`.
:::

## 15.12 Pourquoi se méfier d'un plugin {.page}

Un plugin est un fichier JavaScript : **du vrai code qui s'exécute dans le navigateur de vos visiteurs et de l'administrateur**. Avant la version 1.6.0, un plugin avait les **pleins pouvoirs de la page** : accès à toute l'interface, aux cookies, et même aux appels réservés à l'administration. Un plugin malveillant aurait pu prendre le contrôle du site.

Depuis, la règle est **inversée** : *un plugin n'a pas le droit de s'exécuter tant qu'on ne l'a pas reconnu.*

![Le serveur applique ces quatre questions dans l'ordre ; la première réponse « oui » donne le niveau de confiance.](img/ch15/arbre-confiance.svg){width=100%}

Les cinq niveaux, du plus au moins confiant :

| Niveau | Comment on l'obtient | Où il tourne |
|---|---|---|
| `bundled` (« intégré ») | Chaque fichier du dossier figure, avec **la même empreinte**, dans le `version.json` d'une release | Dans la page |
| `sandboxed` (« sandbox ») | L'opérateur l'a approuvé en mode **bac à sable** (ou le plugin déclare `sandbox: true`) | Dans une **iframe** isolée |
| `dev` | Le serveur a été lancé avec `--dev-trust-local` | Dans la page |
| `approved-trusted` (« approuvé ») | L'opérateur l'a approuvé en mode **in-page** | Dans la page |
| `untrusted` (« non fiable ») | **Tout le reste** | **Nulle part** |

Trois précisions sur l'arbre :

- La confiance dépend du **contenu** des fichiers, jamais de leur chemin ni de l'absence d'un fichier. Un plugin qui porterait le même nom qu'un plugin officiel mais un contenu différent n'est **pas** `bundled`.
- Une approbation « bac à sable » **gagne** sur le mode développeur : si l'opérateur a choisi d'enfermer un plugin, une machine de développement ne le libère pas.
- Le niveau `dev` est un **signal positif** de l'opérateur (un drapeau). La présence d'un dossier `.git` n'en est pas un : une installation de production derrière un relais lui ressemble exactement. Sans le drapeau, un clone Git n'a **aucun** plugin local de confiance.

::: remember
**Le serveur est l'autorité.** Il classe, le navigateur **revérifie**. Le plugin, lui, n'a aucune voix dans l'affaire.
:::

## 15.13 L'empreinte : une signature du contenu exact

Pour reconnaître un plugin, le système calcule son **empreinte** (hash) : un nombre de 64 chiffres hexadécimaux, propre à son contenu.

![Du contenu aux 64 caractères, et pourquoi un seul espace change tout (exemple réel).](img/ch15/empreinte.svg){width=100%}

::: analogy
**Un sceau de cire numérique.** Changez une virgule de la lettre : le sceau ne correspond plus. Impossible de fabriquer deux plugins différents qui donnent la même empreinte.
:::

Les règles exactes (identiques dans les trois implémentations : JavaScript, Python, PHP) :

1. Chaque fichier d'extension `.js`, `.json`, `.mjs`, `.css` ou `.html` du dossier reçoit son SHA-256, calculé sur les **octets bruts** tels que servis (aucune conversion de fin de ligne ni de BOM). Les fichiers cachés (point initial) sont ignorés ; les images ne comptent pas.
2. On forme les lignes `chemin:empreinte`, **triées** par chemin.
3. L'empreinte du plugin est le SHA-256 de `lumen-plugin-trust/1` + saut de ligne + ces lignes.

Les **traductions** (`lang/*.json`) comptent : modifier une phrase change l'empreinte. Un jeu de vecteurs de test (`tests/plugin-trust-vector.json`) vérifie que les trois implémentations donnent exactement le même résultat, y compris sur les cas piégeux (fins de ligne Windows, BOM).

### Anti-TOCTOU : ce qui est vérifié est ce qui s'exécute

::: why
**TOCTOU** signifie « time of check, time of use » : on vérifie un fichier, **puis** on l'exécute, et dans l'intervalle il a changé. C'est la ruse classique : présenter un fichier propre au contrôleur, un fichier piégé à l'exécution.
:::

Lumen3D la ferme ainsi :

1. Le navigateur télécharge les octets de chaque fichier **une seule fois**, sans cache pour tout ce qui peut s'exécuter.
2. Il recalcule l'empreinte sur **ces** octets et la compare au verdict du serveur. Différente : `untrusted`, le plugin n'est pas exécuté.
3. Il exécute **ces mêmes octets**, via une adresse temporaire `Blob`, jamais en redemandant le fichier par son URL.
4. Le `plugin.json` qui a façonné la barre et les barrières doit être le document qui a été haché, sinon quarantaine.

::: tech
Trois cas particuliers, par honnêteté. (1) Sur une adresse **non sécurisée** (HTTP sur une IP de réseau local), le navigateur ne fournit pas `crypto.subtle` : il ne peut pas recalculer l'empreinte et se fie alors au verdict du serveur, avec un avertissement en console. (2) Sur un hébergement **statique** sans autorité de confiance, seuls les plugins `bundled` sont reconnus, par comparaison avec `version.json`. (3) Sans module de confiance chargé, rien n'est exécuté (échec fermé).
:::

## 15.14 L'approbation de l'opérateur, et le bac à sable

### Approuver : lier un OUI à un contenu précis

Quand un plugin est déposé à la main (par FTP, par exemple), il est `untrusted`. L'administrateur l'approuve dans l'onglet [Plugins]{.ui} (chapitre 14) : [Approuver (bac à sable)]{.ui} ou [Approuver (in-page)]{.ui}.

L'approbation est **épinglée** :

- le serveur **recalcule lui-même** l'empreinte sur le disque et exige qu'elle égale celle que l'opérateur a vue (sinon « le contenu du plugin a changé ») ;
- l'opérateur **retape son mot de passe** : approuver est la seule action qui laisse du code étranger s'exécuter ;
- elle enregistre aussi les **capacités** accordées (§ suivant) ;
- elle est écrite dans `api/plugin-trust.json` : `{ chemin, sha256, mode, caps, date, auteur }`.

Si le contenu **ou** les capacités demandées changent, l'approbation devient **caduque** (« approbation annulée : contenu ou capacités modifiés ») et le plugin redevient `untrusted`. Le message n'est pas une panne : c'est le système qui fait son travail.

::: tech
Le fichier `api/plugin-trust.json` n'est **jamais servi** en HTTP, il est protégé contre les mises à jour, et une release qui en contiendrait un est **refusée** : une version piégée ne peut donc pas pré-approuver un plugin d'attaque. Chaque approbation, révocation, installation ou désinstallation incrémente un compteur, `trustEpoch`.
:::

### Révocation à chaud

Un viewer **déjà ouvert** interroge le serveur (`api/health`, toutes les 8 secondes et au retour sur l'onglet). Si `trustEpoch` a changé, il redemande la liste des plugins reconnus ; tout plugin en bac à sable qui n'y figure plus est **détruit sur-le-champ** et son bouton disparaît.

Pour un plugin « in-page », on ne peut pas défaire du code déjà exécuté : la révocation prend effet **au prochain chargement**. Et sur un hébergement PHP, qui n'émet pas `trustEpoch`, la révocation vaut aussi au prochain chargement seulement.

### Le bac à sable : un guichet blindé avec un interphone

![Une iframe sans rien, un interphone surveillé, huit messages types.](img/ch15/bac-a-sable.svg){width=100%}

::: analogy
**Un guichet blindé.** Le plugin travaille dans une cabine fermée. Il ne voit pas la salle (le DOM), n'a pas de téléphone (aucun réseau). Il dispose d'un interphone : il pose une question, le guichetier (la page) vérifie qu'il en a le droit, puis lui répond avec **une copie** de l'information, jamais l'original.
:::

**La cabine** : une `<iframe sandbox="allow-scripts">` **sans** `allow-same-origin`. Le navigateur lui donne une origine « null » : pas d'accès au DOM de la page, aux cookies, au stockage, ni aux appels d'administration. Une politique interne (`default-src 'none'`, `connect-src 'none'`) interdit tout réseau, tout worker, tout sous-cadre. Un test de l'intégration continue refuse toute modification qui ajouterait `allow-same-origin`.

**L'interphone** : `postMessage` dans un espace de noms `lumen-plugin`, jamais confondu avec les messages entre pages. Chaque message porte `{ ns, v, dir, id, plugin, token, type, payload }`.

**Le seul objet du plugin** : `window.LumenPlugin`.

| Appel du plugin | Capacité requise | Effet |
|---|---|---|
| `addButton({label, icon})` | `toolbar.addButton` | Déclare son bouton |
| `toast(texte)` | `ui.toast` | Message (200 caractères au plus) |
| `getInfo()` | `viewer.getInfo` | Nom, dimensions, voxel, nombre de canaux |
| `getCanvasBlob(opts)` | `viewer.getCanvasBlob` | Image PNG ou JPEG de la vue (une requête à la fois) |
| `download(nom, type, données)` | `ui.download` | Téléchargement, **sur vrai clic seulement** |
| `setRenderMode(mode)` | `viewer.setRenderMode` | Changer de mode de rendu (modes connus seulement) |
| `getChannels()` | `channels.getState` | Copie de l'état des canaux |
| `on('render' · 'channels-updated' · 'camera', f)` | `events.subscribe` | Recevoir des événements, sous forme de **copies à plat** |
| `saveState(s)`, `t('clé')` | (aucune) | Mémoire pour l'espace de travail (256 Kio au plus), traduction |

Le plugin déclare dans `sandboxCapabilities` ce dont il a besoin ; l'opérateur en accorde un sous-ensemble ; les capacités **effectives** sont l'**intersection** de trois listes : ce que le disque déclare, ce que l'opérateur a approuvé, et la liste fermée des huit capacités du tableau.

**Les contrôles à chaque message reçu**, dans cet ordre :

1. l'espace de noms est `lumen-plugin` ;
2. la **fenêtre émettrice** est celle d'une cabine connue (c'est l'authentification principale : on se fie à l'identité de la fenêtre, pas à l'origine déclarée) ;
3. l'origine est bien « null » ;
4. la forme du message et le **jeton** aléatoire du cadre sont corrects ;
5. le **débit** est respecté : réserve de 40 messages, recharge de 20 par seconde ;
6. la capacité demandée a été **accordée** ; sinon réponse `forbidden`.

**Les garde-fous de durée de vie** :

| Garde-fou | Valeur |
|---|---|
| Démarrage de la cabine (`init`) | 10 s au plus, sinon destruction |
| Battement de cœur (`ping`) | toutes les 1,5 s ; cabine détruite après environ 6 s sans réponse |
| Abus (messages invalides ou interdits) | plus de 50 en 10 s : destruction |
| Téléchargement | un par activation, dans les 1,5 s d'un vrai clic, 32 Mio au plus, types PNG / JPEG / JSON / CSV / texte, extension imposée par le type |

::: warning
**Seuls les outils « action » et « bascule » peuvent être enfermés.** Un mode de rendu compile du code GLSL sur la carte graphique à chaque image : il n'y a aucune frontière asynchrone derrière laquelle une cabine pourrait se placer. Un plugin de canal reçoit directement un morceau du DOM de la page, exactement le privilège que le bac à sable retire. Ces deux placements restent donc **en confiance totale** (réservés aux plugins officiels), et approuver l'un d'eux en bac à sable le met en quarantaine.
:::

::: note
Un plugin déclaré `sandbox: true` **tourne toujours dans la cabine**, quel que soit son niveau de confiance. Inversement, un plugin écrit pour la page (qui appelle `PluginRegistry`) ne peut pas fonctionner dans la cabine, qui n'a que le SDK. Le plugin de référence est `screenshot-sandboxed` : il capture et télécharge sans jamais toucher au DOM ni au contexte.
:::

## 15.15 La compatibilité : `platformCompat`

Un plugin dit avec quelles versions de la plateforme il fonctionne. Si la plateforme change de version, ce champ évite qu'un plugin trop ancien (ou trop récent) casse l'interface.

| Déclaration | Sens | Plateforme 1.59.2 |
|---|---|---|
| absent | Pas de contrainte | compatible |
| `"*"` ou `"x"` | N'importe quelle version | compatible |
| `">=1.53.0"` | Au moins cette version | compatible |
| `">=1.60.0"` | | **refusé** |
| `"^1.4.0"` | De 1.4.0 inclus à 2.0.0 exclu | compatible |
| `"~1.58.0"` | De 1.58.0 inclus à 1.59.0 exclu | **refusé** |
| `"1.x"` ou `"1.59"` | Préfixe | compatible |
| `["1.58", "1.59.x"]` | Liste : **l'une** des valeurs suffit | compatible |
| `">=1.51.0 <1.59.0"` | Plusieurs comparateurs : **tous** doivent tenir | **refusé** |
| `">=banane"`, `42` | Illisible | **refusé** |

Règles : une chaîne séparée par des espaces est un **ET** ; un tableau est un **OU** (valeurs « nues » seulement, sans opérateur) ; trois chiffres = version exacte, moins de chiffres = préfixe ; un suffixe `-rc1` est ignoré.

::: remember
**Illisible = incompatible** (échec fermé). Une déclaration qu'on ne sait pas lire ne laisse jamais passer. La **seule** exception : si la version de la plateforme est inconnue (un clone sans `version.json` ni serveur de développement), la barrière est neutralisée et le dit dans sa raison.
:::

::: tech
**Trois jumeaux, un seul comportement** : `js/core/compat.js` (navigateur), `dev_server.py` (`_compat_satisfies`), `api/_admin_lib.php` (`admin_compat_satisfies`). Ils sont tous validés contre `tests/compat-vector.json` (44 cas) ; toute modification de sémantique doit passer les trois. La version de la plateforme est lue dans `version.json` (releases), sinon dans `api/health` (serveur de développement).
:::

## 15.16 Mettre à jour la plateforme : l'effacement réversible

![Avant, après, plus tard : un plugin incompatible n'est jamais supprimé.](img/ch15/mise-a-jour.svg){width=100%}

Quand l'administrateur prépare une mise à jour (chapitre 18), le **rapport de vérification** applique `platformCompat` à la version **cible**, plugin par plugin, **avant** toute installation :

- **compatibles** : rien à faire ;
- **mis en quarantaine** (`willQuarantine`) : ils ne fonctionneraient plus ;
- **blocage** : si plus **aucun mode de rendu** ne resterait compatible, le viewer serait inutilisable : la mise à jour ne peut pas être confirmée.

Après le basculement, rien n'est supprimé. La découverte **refiltre à chaque requête** : un plugin incompatible disparaît de la liste (ses fichiers restent), et **revient tout seul** dès qu'une version compatible du plugin ou de la plateforme est installée. Un plugin déposé à la main par l'opérateur survit à la mise à jour : seuls les fichiers de la **release précédente** sont remplacés.

::: note
Les plugins officiels ne **voyagent pas** avec la plateforme : une installation neuve démarre sans plugin et les installe depuis le catalogue (§15.17). La compatibilité est ce qui fait que cette séparation reste sûre.
:::

## 15.17 Le catalogue signé : la boutique officielle {.page}

Le **catalogue** est la liste des plugins que la plateforme propose d'installer, depuis l'onglet [Catalogue]{.ui} ou depuis l'assistant de première installation (les plugins « recommandés » y sont pré-cochés). Il est **curé** : seul l'éditeur de la plateforme y publie.

![L'onglet Plugins de l'administration : trois cartes (outils, canaux, modes de rendu), un interrupteur et un niveau de confiance par plugin (« dev » sur cette machine de démonstration).](img/ch15/admin-plugins.png){.shot width=66%}

![L'onglet Catalogue : « signature vérifiée » en haut, une carte par plugin avec son mode (« confiance totale » ou « bac à sable »).](img/ch15/admin-catalogue.png){.shot width=66%}

### Ce que contient le catalogue

Un fichier `marketplace-catalog.json`, signé par `marketplace-catalog.json.sig`. Il porte `version`, un **numéro de série** (`serial`), la date d'émission (`issuedAt`) et une entrée par plugin :

| Champ d'une entrée | Rôle |
|---|---|
| `id`, `name`, `placement`, `subtype`, `description`, `creator` | La carte affichée |
| `latestVersion`, `platformCompat` | Dernière version, compatibilité |
| `sandboxCapabilities`, `recommended` | Capacités demandées ; pré-coché ou non à la première installation |
| `assetUrl`, `sumsUrl`, `sigUrl` | Où trouver le zip, ses empreintes et leur signature |
| `sha256` | L'empreinte **du zip** (authentifiée par la signature du catalogue) |

Chaque plugin est publié sous forme d'un zip **déterministe** (entrées triées, date fixée à 1980, droits 0644 : le même contenu donne toujours les mêmes octets) accompagné de `SHA256SUMS`, `SHA256SUMS.sig` et `version.json`.

### Deux clés, jamais la même

![Deux chaînes de signatures indépendantes : un compromis de l'une ne donne rien sur l'autre.](img/ch15/chaine-signatures.svg){width=100%}

::: analogy
**Deux sceaux de cire différents.** L'un authentifie les lettres officielles du logiciel, l'autre celles de la boutique. Dérober ou perdre l'un ne permet pas de contrefaire l'autre, et on peut en changer un sans toucher à l'autre.
:::

- La signature est une signature **Ed25519** (norme RFC 8032), vérifiée par un module écrit pour l'occasion, sans dépendance, en Python ; en PHP par la bibliothèque libsodium.
- La **clé privée** (la graine) ne quitte jamais l'éditeur : variable d'environnement ou fichier hors du dépôt Git.
- La **clé publique** est **épinglée dans le code source** (`dev_server.py`, `api/_admin_lib.php`, `install.php` pour les releases) : elle voyage avec chaque version et survit aux mises à jour. Un serveur ne fait confiance qu'à ce qui se vérifie avec cette clé précise.
- Clé **vide** dans le code : la signature n'est pas prouvable, seule l'empreinte est contrôlée, avec un avertissement. **Clé renseignée** : une signature manquante ou fausse **refuse** le catalogue.

### Anti-retour-arrière : le numéro de série

Un catalogue périmé mais encore **validement signé** pourrait servir à réinstaller une version d'un plugin dont on a corrigé une faille. Chaque publication **augmente** donc le `serial`. Chaque serveur retient le plus haut numéro accepté (`api/marketplace-state.json`) et **refuse** un catalogue de numéro inférieur. Seul un catalogue dont la signature est prouvée peut faire monter ce compteur : un faux numéro gigantesque ne peut pas figer un serveur.

L'administrateur voit alors « Catalogue refusé : il est plus ancien… » : il n'y a rien à faire de son côté.

::: example
Au moment de la rédaction, le catalogue du dépôt est au `serial` 2. Un serveur qui a accepté le 2 refusera un catalogue de serial 1, même si sa signature est parfaitement valide.
:::

## 15.18 Installer, mettre à jour, désinstaller

![Dix contrôles ; à la moindre erreur, tout est remis comme avant.](img/ch15/installation.svg){width=100%}

L'installation est lancée **par l'opérateur** (mot de passe re-saisi), jamais automatiquement. Les étapes, dans l'ordre du code :

1. mot de passe vérifié ;
2. le catalogue est téléchargé (1 Mio au plus) et sa **signature** vérifiée ;
3. son **serial** est comparé au plus haut déjà vu ;
4. l'entrée est trouvée, `platformCompat` est comparée à la version de la plateforme (« incompatible » sinon) ;
5. le zip est téléchargé, **8 Mio au plus** ;
6. son SHA-256 doit égaler celui du **catalogue signé** ; sans clé, il est comparé à `SHA256SUMS` (lui-même vérifié) ;
7. **extraction durcie** : pas plus de 500 entrées ni 24 Mio, aucun chemin absolu, avec `..`, avec antislash ou lecteur ; seules les extensions de fichiers de plugin sont admises (jamais `.php`, `.py`, ni fichier caché : le dossier est servi au web) ;
8. `plugin.json` : l'`id` et le `placement` doivent égaler ceux du catalogue ;
9. le dossier est installé ; en cas de **mise à jour**, l'ancienne copie est **mise de côté**, pas supprimée ;
10. le serveur **recalcule l'empreinte** du dossier installé et **approuve** le plugin : `bac à sable` s'il déclare `sandbox: true` (ou s'il est un outil avec capacités), sinon `in-page`.

Si **n'importe quelle** étape échoue, le dossier `js/modules/` est remis **exactement** dans l'état initial, y compris l'ancienne version en cas de mise à jour.

**Désinstaller** supprime le dossier **et** l'approbation. L'opération est idempotente, et refuse de retirer le **dernier mode de rendu** actif.

::: warning
Un plugin « de confiance totale » installé depuis le catalogue **s'exécute dans la page**. Il est approuvé parce que **l'éditeur l'a signé et que le serveur a vérifié la signature**, pas parce qu'il serait inoffensif. C'est aussi pourquoi le catalogue n'est jamais ouvert à des tiers.
:::

## 15.19 Publier un plugin (côté éditeur)

Une seule commande prépare et publie :

```text
python tools/publish_plugin.py chemin/vers/mon-plugin --push
```

Elle empaquette et signe le plugin, ajoute son entrée au catalogue, **augmente le `serial`**, **re-signe** le catalogue puis, avec `--push`, ne committe que le dossier `marketplace/`. Un plugin n'est **en ligne** que lorsque ces fichiers sont sur la branche `main` (le catalogue est servi depuis GitHub, branche `main`). L'outil refuse une graine dont la clé publique n'est pas celle épinglée dans le code, car tous les serveurs rejetteraient le catalogue.

Autres options : `--recommended false` (publié mais non pré-coché), `--remove <id>` (dépublier), `--resign` (réémettre le catalogue sous le serial suivant).

Pour changer un plugin déjà publié : **augmenter `version`** (et relever `platformCompat` si le plugin utilise sans repli une fonction récente du noyau). Republier un contenu inchangé ne produit rien.

## 15.20 Les modules du noyau qui font fonctionner tout cela

Aucun de ces fichiers n'est un plugin : ils font **tourner** les plugins.

| Module | Rôle |
|---|---|
| `js/core/plugin-registry.js` (`PluginRegistry`) | Découverte, barrières, cycle de vie, barre d'outils, quarantaine, révocation à chaud, état de l'espace de travail |
| `js/core/plugin-trust.js` (`PluginTrust`) | Empreinte, relecture des octets, verdict (jumeau client du serveur) |
| `js/core/plugin-sandbox.js` (`PluginSandbox`) | Créer les cabines, courtier de capacités, débit, battement de cœur |
| `js/core/compat.js` (`Compat`) | Résolveur de `platformCompat` ; version de la plateforme |
| `js/core/tool-manager.js` (`ToolManager`) | **Un seul outil exclusif** actif à la fois ; raccourcis clavier ; défauts `v`/Échap (navigation), `c` (coupe), `m` (mesure) |
| `js/core/ui-actions.js` (`UiActions`) | Boutons d'en-tête par attribut `data-action` plutôt que par code dans le HTML (la politique de sécurité interdit le code en ligne) |
| `js/core/i18n.js` (`I18n`) | Greffe les dictionnaires de plugin sous `plugins.<id>`, repli sur l'anglais |
| `js/core/export-manager.js`, `workspace-state.js` | Consommateurs de `getExports()` et de `getState()` |
| `js/components/channel-panel.js` | Hôte des plugins de canal (`getChannelUI`, `bindChannelUI`) |
| `js/pages/viewer.js`, `js/pages/2d.js` | Fabriquent le `ctx` et appellent le registre dans l'ordre du §15.3 |

Côté serveur : `dev_server.py` (`_list_plugins`, `_classify_plugin`, `_approve_plugin`, `_marketplace_*`, `_install_marketplace_plugin`) et leurs jumeaux PHP dans `api/_admin_lib.php` et `api/plugins.php`. La **liste** des modules utilitaires non liés aux plugins (`Utils`, `Catalog`…) est dans l'annexe du chapitre 20.

## 15.21 Un plugin ne s'affiche pas : que vérifier ?

::: steps
1. Ouvrez la **console** du navigateur : chaque quarantaine y écrit `[PluginRegistry] Quarantined "tools/…" (raison): détail`.
2. Raison `untrusted` : onglet [Plugins]{.ui}, approuvez-le (ou il a changé depuis son approbation).
3. Raison `incompatible` : comparez son `platformCompat` à votre version (§15.15).
4. Pas de message de quarantaine, juste « left out » : il ne vise pas cette page (`dataTypes`, `contexts`, §15.5).
5. Bouton absent mais plugin chargé : un `requires` non satisfait (pas de suivi, pas de briques), ou un `group` sans grappe.
6. Absent de l'onglet Plugins : le dossier est mal nommé, ou son `plugin.json` est illisible ou contredit le dossier parent.
:::

::: remember
- Un plugin = un dossier (`plugin.json` + `index.js` + `lang/`) ; le **dossier parent** fixe son placement.
- La page **découvre, filtre, vérifie, puis initialise**, toujours dans cet ordre ; un plugin en panne ne coûte jamais le viewer.
- **Refus par défaut** : un plugin n'est exécuté que s'il est `bundled`, approuvé, ou le mode développeur est actif.
- L'approbation est **liée au contenu exact** (empreinte) et aux capacités ; ce qui est vérifié est ce qui est exécuté.
- Le **bac à sable** enferme les outils d'action et de bascule ; les canaux et modes de rendu restent en confiance totale.
- Le **catalogue** est signé par **sa propre clé**, protégé contre le retour en arrière (serial), et installé **tout ou rien**.
:::
