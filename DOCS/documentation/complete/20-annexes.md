# 20. Annexes

::: chapter-intro
- Cinq annexes de **référence** : à consulter, pas à lire d'une traite.
- **A** : où est quoi dans le code. **B** : ce que votre navigateur retient et les paramètres d'adresse. **C** : ce que Lumen3D ne fait pas.
- **D** : tous les chiffres importants au même endroit, avec le chapitre qui les explique. **E** : l'histoire des versions.
:::

## 20.A Carte des modules

Lumen3D est écrit en JavaScript « simple » : pas de framework, pas de compilation. Chaque fichier a **un rôle** et porte un nom qui le dit. Cette annexe en est l'index, un fichier par ligne.

![Cinq familles de fichiers. Les pages orchestrent, les viewers dessinent, le noyau rend service, les workers calculent.](img/ch20/carte-modules.svg){width=100%}

::: analogy
**Un restaurant.** Les *pages* sont les serveurs qui prennent votre commande. Les *viewers* sont les cuisiniers qui dessinent le plat. Le *noyau* est la réserve, les couteaux et le plan de travail. Les *workers* sont la plonge, en coulisses : on ne la voit pas, mais rien ne sortirait sans elle.
:::

### Le noyau : `js/core/` (33 fichiers)

| Fichier | Ce qu'il fait, en clair | Chap. |
|---|---|---|
| `brick-loader.js` | va chercher les briques dans les packs, par lots, sans télécharger deux fois la même chose | 10 |
| `brick-decode-worker.js` | worker : décode les images WebP et redécoupe les mosaïques en briques | 10 |
| `svr-manager.js` | gère l'atlas 3D en mémoire graphique et son budget de mémoire | 10 |
| `catalog.js` | charge la liste des jeux de données, la filtre, la cherche, trouve les jeux liés | 3 |
| `utils.js` | boîte à outils commune : vocabulaire des types (3d, 2d, live), dates, barres d'échelle 1-2-5 | 1 |
| `tool-manager.js` | sait quel outil est actif (naviguer, couper, mesurer) et gère les raccourcis clavier | 12 |
| `volume-source-manager.js` | normalise la description des « sources » d'un jeu (briques, série temporelle) | 10 |
| `url-state.js` | écrit et relit l'état de la vue dans l'adresse (`#state=`) | 12 |
| `workspace-state.js` | enregistre et restaure l'espace de travail dans le navigateur | 12 |
| `measurement-store.js` | garde en mémoire les distances mesurées pendant la session | 12 |
| `export-manager.js` | moteur du Centre de téléchargement : espace de travail, mesures, métadonnées, citation | 12 |
| `display-presets.js` | fonds de l'affichage 3D : sombre, clair, papier, transparent, personnalisé | 9 |
| `slice-compositor.js` | recolore une coupe à partir de ses valeurs brutes, pour le Studio | 12 |
| `plane-loader.js` / `plane-codec.js` | lisent les plans XY du format 2 et définissent leur format PNG | 7, 17 |
| `plugin-registry.js` | découvre, charge et branche les plugins ; construit la barre d'outils | 15 |
| `plugin-trust.js` | vérifie l'empreinte d'un plugin et son niveau de confiance | 15 |
| `plugin-sandbox.js` | la cage (iframe isolée) des plugins tiers approuvés | 15 |
| `compat.js` | dit si un plugin est compatible avec la version de la plateforme | 15 |
| `i18n.js` | traductions : anglais, français, espagnol, néerlandais et langues ajoutées | 16 |
| `instance-config.js` | lit la configuration du site (nom, spécimen, textes) : la « marque blanche » | 16 |
| `theme.js` / `theme-boot.js` | bascule clair/sombre ; `theme-boot` l'applique avant le premier affichage | 16 |
| `colorblind.js` | huit simulations de daltonisme, appliquées à toute la page | 16 |
| `page-renderer.js` | dessine une page construite dans l'éditeur (sections, colonnes, widgets) | 16 |
| `page-templates.js` | contenu par défaut de la page À propos | 16 |
| `page-edit-frame.js` | mode édition en direct de l'éditeur de pages | 16 |
| `page-vars.js` | variables dans les textes de page (année, date, nombre de jeux…) | 16 |
| `page-background.js` | fonds animés des pages construites | 16 |
| `dialog.js` | petites fenêtres de choix (Confirmer / Annuler) ; Échap = annuler | 16 |
| `ui-actions.js` | gère les clics des boutons d'en-tête (la politique de sécurité interdit les gestionnaires dans le HTML) | 19 |
| `font-loader.js` | active les polices Google sans retarder le premier affichage | 19 |
| `perf-telemetry.js` | chronomètres de diagnostic, gardés sur place, jamais envoyés | 10 |

### Les viewers : `js/viewers/` (5 fichiers)

| Fichier | Ce qu'il fait, en clair | Chap. |
|---|---|---|
| `volume-viewer.js` | le cœur : la scène 3D, le lancer de rayons, la caméra, les captures | 9 |
| `volume-slicer.js` | calcule une coupe plane (droite ou oblique) dans le volume | 12 |
| `volume-grid.js` | grille de référence, repère d'axes et barre d'échelle 3D | 12 |
| `tracking-overlay.js` | dessine les cellules suivies d'un timelapse par-dessus le volume | 12 |
| `2d-viewer.js` | dessine une photographie 2D (zoom, déplacement, échelle) | 12 |

### Les composants : `js/components/` (5 fichiers)

| Fichier | Ce qu'il fait, en clair | Chap. |
|---|---|---|
| `channel-panel.js` | le panneau des canaux : couleur, fenêtre, gamma, opacité | 11 |
| `decomposition-panel.js` | l'interface « Décomposer par canal » | 12 |
| `studio-editor.js` | le Studio : annoter et exporter une figure | 12 |
| `timeline.js` | la frise temporelle et le lecteur de séries | 12 |
| `dataset-gallery.js` | la galerie d'images rattachées à un jeu, avec son agrandissement | 12 |

### Les workers : `js/workers/` (9 fichiers)

Un worker est un employé d'arrière-plan : il travaille sans bloquer l'écran (chapitre 2).

| Fichier | Ce qu'il fait, en clair | Chap. |
|---|---|---|
| `gaussian-blur-worker.js` | flou gaussien d'un canal, plan par plan | 11 |
| `plane-decode-worker.js` | décode les tuiles PNG des plans XY | 7 |
| `studio-plane-worker.js` / `studio-plane-ops.js` | maximum par canal sur une épaisseur ; les calculs purs sont dans `ops` | 12 |
| `pixel-2d-worker.js` / `pixel-ops-2d.js` | réglages d'affichage et isolement du marquage d'une photographie ; calculs purs dans `ops` | 12 |
| `tracks-load-worker.js` | prépare les tables de suivi cellulaire (entiers 32 bits) | 12 |
| `upload-worker.js` | envoie les fichiers d'un import : lecture, empreinte, envoi, reprises | 17 |
| `migration-worker.js` | exécute les unités d'une conversion de format côté navigateur | 17 |

### Les pages : `js/pages/` (10 fichiers)

| Fichier | Ce qu'il fait, en clair | Chap. |
|---|---|---|
| `viewer.js` | la page principale : assemble tout pour un volume 3D ou une série | 3 |
| `2d.js` | la page des photographies 2D | 12 |
| `explorer.js` | la grille de jeux de données, ses filtres et la recherche | 3 |
| `compare.js` | la page Comparer : jusqu'à quatre panneaux synchronisés | 12 |
| `compare-policy.js` | choisit la qualité de chaque panneau pour tenir dans un budget commun | 12 |
| `landing.js` | la page d'accueil | 3 |
| `about.js` / `legal.js` / `page-view.js` | À propos, Mentions légales, pages personnalisées | 3, 16 |
| `admpan.js` | la page d'administration (démarre le module `shell`) | 14 |

### L'administration : `js/pages/admin/` (27 fichiers)

| Fichier | Ce qu'il fait, en clair | Chap. |
|---|---|---|
| `shell.js` / `shared.js` / `bus.js` | le cadre (menu, thème, connexion), les outils communs (requêtes, messages) et la messagerie entre onglets | 14 |
| `tab-datasets.js` | l'onglet [Datasets]{.ui} : liste, éditeur, orientation, galerie | 14 |
| `tab-upload.js`, `upload-manager.js`, `upload-dock.js` | l'onglet [Import]{.ui}, son orchestrateur et la pastille flottante | 17 |
| `tab-dataset-updates.js`, `migration-runner.js` | [Mises à jour des données]{.ui} et son moteur (dont le régulateur de requêtes) | 17 |
| `tab-dataset-types.js` | [Types de données]{.ui} : renommer 3d, 2d, live | 16 |
| `tab-branding.js`, `tab-appearance.js`, `tab-legal.js` | [Identité]{.ui}, [Apparence]{.ui}, [Mentions légales]{.ui} | 16 |
| `tab-pages.js` + `pages-controls.js`, `pages-translate.js`, `pages-variables.js` | l'éditeur de pages et ses panneaux | 16 |
| `tab-plugins.js`, `tab-marketplace.js`, `plugin-update.js` | [Plugins]{.ui}, [Catalogue]{.ui} et la règle commune de mise à jour des plugins | 15 |
| `tab-updates.js`, `tab-changelog.js`, `markdown.js` | [Mises à jour]{.ui}, la page des notes de version, le lecteur de Markdown | 18 |
| `tab-pipeline.js`, `tab-docs.js`, `tab-security.js`, `tab-stats.js` | [Pipeline]{.ui}, [Documentation]{.ui}, [Sécurité]{.ui}, [Statistiques]{.ui} | 14 |

### Hors de `js/`

| Fichier | Ce qu'il fait, en clair | Chap. |
|---|---|---|
| `dev_server.py` | le serveur Python : sert les pages et fait aussi le travail de l'administration | 2, 18 |
| `api/*.php` et `router.php` | le serveur jumeau en PHP, pour les hébergements sans Python | 2, 18 |
| `fast_server.py` | un serveur statique rapide, sans administration (tests de performance) | 2 |
| `upload_staging.py` | le moteur d'import (liste blanche, journal, validation, publication) | 17 |
| `dataset_migrations.py` | les conversions de format de données, côté Python | 17 |
| `ed25519_pure.py` | vérificateur de signatures Ed25519, en Python pur | 19 |
| `js/migrations/` | les trois conversions (`m002`, `m003`, `m004`) côté navigateur, et un bloc de test de vitesse | 17 |
| `js/modules/` | les plugins : `tools/` (barre d'outils), `channels/` (panneau des canaux), `shaders/` (modes de rendu) | 12, 15 |
| `js/vendor/` | les bibliothèques tierces, hébergées sur place (Three.js, Lucide, Plotly) | 2 |
| `preprocess/` | le pipeline de préparation, en Python | 4 à 8 |
| `tests/`, `tools/` | la suite de tests (201 fichiers) et les outils de publication | 18 |

## 20.B Mémoires du navigateur et paramètres d'adresse {.page}

Un navigateur offre plusieurs « tiroirs » où un site peut ranger de petites choses. Lumen3D en utilise **quatre** et n'y met jamais de donnée d'étude.

![Quatre endroits où vit une information.](img/ch20/memoires.svg){width=100%}

::: note
Tout accès à ces tiroirs est protégé : en navigation privée, ou si le stockage est bloqué, la page fonctionne, simplement sans mémoire (chapitre 19). Vider les données du site efface tout ce qui suit sans rien casser.
:::

### B.1 Ce que ce navigateur retient (`localStorage`)

| Clé | Ce qu'elle garde |
|---|---|
| `iribhm-theme` | le thème choisi, clair ou sombre |
| `iribhm-lang` | la langue de l'interface |
| `iribhm-colorblind` | le filtre de simulation de daltonisme |
| `iribhm.workspace.<portée>.<id>` | l'espace de travail enregistré d'un jeu (caméra, canaux, outils), en JSON ; `<id>` est du type `3d/Nom-du-jeu` |
| `iribhm.viewer.zScale.<id>` | l'étirement d'affichage en Z, jeu par jeu |
| `iribhm.viewer.playbackFps` | la vitesse de lecture préférée des séries temporelles (une seule pour le viewer) |
| `iribhm-gallery-dock` | l'état de la galerie : ouverte, large ou réduite en pastille |
| `lumen3d.gpuContextLosses` | les dates des dernières pertes de contexte graphique (8 au plus) : chaque perte de la semaine divise le budget par deux |
| `lumen3d.vramBudgetMB` | **réglage d'opérateur** : impose un budget de mémoire graphique, en Mo. Jamais écrit par le site (chapitre 10) |
| `adm-theme`, `adm-sidebar-collapsed` | thème et menu replié du panneau d'administration |
| `adm-upload-dock-size` | taille de la pastille d'import |
| `lumen-dupd-ds-executor`, `lumen-dupd-speedtest`, `lumen-dupd-log` | conversions de données : exécutant choisi par jeu, dernier test de vitesse, journal des 20 dernières opérations |

::: tip
Pour qu'un budget graphique trop prudent (après plusieurs pertes de contexte) revienne à la normale, supprimez `lumen3d.gpuContextLosses` dans les outils du navigateur, ou attendez une semaine.
:::

### B.2 Ce que cet onglet retient (`sessionStorage`) et le cookie

| Nom | Rôle |
|---|---|
| `lumen_visit` | « la visite a déjà été comptée » : un compteur de visites par session, pas par page |
| `lumen_view_<id>` | « la vue de ce jeu a déjà été comptée » (les aperçus de l'administration ne comptent pas) |
| `lumenWidgetClip` | presse-papiers d'un widget copié dans l'éditeur de pages |
| cookie `admpan_token` | la session d'administration : 8 heures, invisible aux scripts (`HttpOnly`). Les visiteurs n'en reçoivent pas |

### B.3 Les paramètres d'adresse

Ils se placent après `?` (par exemple `viewer.html?id=3d/Embryo-E95-Em2-Pecam1-Sox2&quality=high`).

| Page | Paramètre | Sens |
|---|---|---|
| `viewer.html`, `2d.html` | `id=<type>/<dossier>` | le jeu à ouvrir |
| `viewer.html` | `quality=` | `preview` (256), `balanced` (512), `high` (1024), `2048x2048`, `4096x4096` ou `native` ; les formes `512x512`, `1024x1024`, `low`, `medium` sont acceptées |
| `viewer.html`, `2d.html` | `hideHeader=true` | page « sans bandeau » : c'est ainsi qu'un panneau de Comparer l'intègre |
| idem | `panelIndex=<n>` | numéro du panneau dans Comparer |
| idem | `mode=admin` | aperçu de l'administration : la vue n'est **pas** comptée dans les statistiques |
| idem | `path=<type>/<dossier>` ou `staging:<type>/<dossier>` | avec `mode=admin` : ouvrir un jeu pas encore publié |
| `explorer.html` | `type=3d`, `2d` ou `live` | pré-coche le filtre de type |
| `compare.html` | `add=<id>` (répétable) | jeux à mettre dans les panneaux (quatre au plus) |
| `page.html` | `slug=<nom>` | la page personnalisée à afficher |
| `page.html`, `about.html`, `index.html` | `preview=draft` | affiche le brouillon plutôt que la version publiée |
| `page.html` | `edit=1` | mode édition (utilisé dans l'éditeur de pages) |
| `admpan.html` | `editor=<slug>` | ouvre l'éditeur de pages seul sur cette page |
| `admpan.html` | `changelog=1` | la page des notes de version, sans le panneau |
| toutes les pages de vue | `#state=…` | **la vue complète**, compressée ; écrite toute seule quand vous changez quelque chose, au plus une fois par seconde |

::: tech
`#state=` est un JSON compressé (deflate) puis écrit en base64. Il peut contenir caméra, canaux, outils, mesures et état des plugins. Plafonds : 64 Kio écrits dans l'adresse, 2 Mio de texte lus, 16 Mio une fois décompressé (protection contre les « bombes »). Un lien trop gros ou altéré est ignoré. Les paramètres d'une page embarquée dans Comparer sont posés par Comparer lui-même.
:::

## 20.C Ce que Lumen3D ne fait pas {.page}

Un bon outil dit ce qu'il ne sait pas faire. Voici les limites **assumées**, vérifiées dans le code.

![Huit choses que Lumen3D ne fait pas.](img/ch20/limites.svg){width=100%}

| Limite | Pourquoi, et que faire |
|---|---|
| **Pas de quantification calibrée de l'intensité** | Le pipeline ramène 12 ou 16 bits sur 0–255 entre un fond et un signal estimés ; les gris affichés sont **relatifs** (chapitres 5 et 11). Pour comparer des intensités entre échantillons, revenez au fichier Imaris d'origine |
| **Pas d'objets plus fins qu'environ 3 voxels** | Le nettoyage retire les points isolés puis lisse le fond par une médiane : un point, un fil ou une feuille d'un ou deux voxels d'épaisseur est effacé, même brillant (chapitre 5, § 5.10). Vérifiez dans le fichier Imaris d'origine |
| **4 canaux affichés au maximum** | Les volumes sont chargés dans une texture à quatre composantes (rouge, vert, bleu, alpha). Le pipeline écrit tous les canaux ; le viewer dessine les quatre premiers (chapitre 11) |
| **Pas de déconvolution, pas de correction de champ plat** | Le pipeline soustrait un fond et règle une fenêtre ; il ne corrige ni le flou de l'objectif (fonction d'étalement) ni l'éclairage inégal |
| **Pas de segmentation, pas de détection de cellules** | Le suivi cellulaire est **lu** dans l'analyse faite sous Imaris, jamais recalculé (chapitre 8) |
| **Pas d'édition de vos voxels** | Le viewer lit les données et ne les modifie pas ; flou, fenêtre ou gamma sont des réglages d'**affichage**. Le seul changement de valeur est la réduction 16 → 8 bits du pipeline (chapitre 6) |
| **Pas de compensation du photoblanchiment** | Le pipeline en **mesure** le niveau par image, mais aucun réglage du viewer ne l'utilise : une série qui s'éteint s'affiche plus sombre (chapitre 5) |
| **Mesures non enregistrées sur le serveur** | Elles vivent en mémoire pendant la session et dans le lien ou l'espace de travail que vous enregistrez (chapitre 12) |
| **Pas de statistiques de région** | Distances, coupes, figures : oui. Volume d'une structure ou intensité moyenne d'une zone : non |
| **Un seul compte d'administration** | Le public n'a pas de compte ; l'administrateur est unique, protégé par un mot de passe (chapitre 19) |
| **WebGL2 obligatoire** | Sans textures 3D, les briques ne peuvent pas être affichées : un message l'explique (chapitre 19). Sur un mobile, la mémoire graphique limite la qualité |
| **Entrées : fichiers Imaris `.ims` et photographies TIFF** | D'autres formats de microscope doivent d'abord être convertis ; les photographies attendent le TIFF exporté par ImageJ/Fiji depuis un fichier Leica (chapitre 4) |
| **Pas de pyramide d'images 2D** | Une photographie est un seul fichier WebP natif accompagné d'un aperçu ; l'ancien visualiseur à tuiles a été supprimé |

::: warning
« Ne le fait pas » ne veut pas dire « le fait mal ». Si votre question scientifique demande l'une de ces fonctions, faites-la dans l'outil d'analyse adapté, puis utilisez Lumen3D pour **montrer** le résultat.
:::

## 20.D Chiffres clés de la plateforme {.page}

Toutes les constantes importantes, regroupées. La dernière colonne dit où l'idée est expliquée.

### D.1 Les données

| Constante | Valeur | Chap. |
|---|---|---|
| Brique | 64³ voxels utiles ; 66³ stockés avec 1 voxel de bordure (format 4) | 7 |
| Mosaïque d'une brique | 9 × 8 coupes de 66² : une image WebP sans perte de 594 × 528 px | 7 |
| Pack | au plus 64 briques ou 16 Mio, par super-blocs de 4 × 4 × 4 briques | 7 |
| Niveaux de détail | divisés par deux en X et Y ; en Z seulement tant que vz ≤ 1,5 × vxy | 6, 7 |
| Format de données courant | 4 (les formats 1 à 3 sont convertis en place) | 7, 17 |
| Plan XY (format 2) | un fichier par plan ; tuiles PNG de 512 × 512 | 7, 17 |
| Projection par couche (format 3) | une projection d'intensité maximale par couche de 64 plans | 7 |
| Taille maximale acceptée | 2²⁰ voxels par axe ; 64 canaux au plus acceptés, **4 affichés** | 19 |
| Réduction de profondeur | 16 ou 12 bits → 8 bits (une seule perte du pipeline) | 5, 6 |

### D.2 Le nettoyage du fond (pipeline)

| Constante | Valeur | Chap. |
|---|---|---|
| Plancher de fond `bg_floor` | 99e percentile des 8 cubes de coin | 5 |
| Saturation `sig_max` | 99,9e percentile (d'un voxel sur 4) | 5 |
| Seuil du masque | plus de 1,1 × `bg_floor` | 5 |
| Nettoyage du masque | ouverture, puis dilatation × 3 | 5 |
| Série temporelle | `sig_max` calculé sur les seuls voxels au-dessus du fond, s'ils sont au moins 1 000 | 5 |

### D.3 Le streaming et la mémoire graphique

| Constante | Valeur | Chap. |
|---|---|---|
| Chargements simultanés de briques | 24 | 10 |
| Corps de pack simultanés | 4 | 10 |
| Mémoire de packs compressés gardés | 192 Mio (packs) · 64 Mio (plages) · 32 Mio (préchargement) | 10 |
| Anticipation | 64 Mio d'avance sur la brique décodée | 10 |
| Délais d'attente | 30 s sans réponse (téléchargement) · 30 s (décodage) | 10, 19 |
| Essais d'une brique | 3, avec 0,5 s puis 1 s d'attente | 19 |
| Remplacements d'un worker | 3 au plus, puis décodage dans la page | 19 |
| Qualité 512 | niveau le plus fin dont le plus grand côté XY est ≤ 768 voxels | 10 |
| Qualité 1024 | idem ≤ 1 536 voxels | 10 |
| Atlas | jusqu'à 8 pages | 10 |
| Budget graphique : rendu logiciel | 256 Mio | 10 |
| Budget graphique : carte intégrée | 0,5 · 1 · 2 Gio selon la mémoire de l'appareil | 10 |
| Budget graphique : carte dédiée | 3 ou 4 Gio | 10 |
| Budget graphique : inconnue | 1 ou 2 Gio | 10 |
| Perte de contexte graphique | budget ÷ 2 par perte de la semaine (plancher 256 Mio) | 19 |
| Garde-fou | 3 pertes en moins de 120 s : plus de rechargement automatique | 19 |
| Comparer | 4 panneaux au plus ; budget commun 1,5 Gio ; 180 s pour qu'un panneau se stabilise | 12 |

### D.4 Le rendu

| Constante | Valeur | Chap. |
|---|---|---|
| Échantillons par rayon (au repos) | `clamp(6·10⁹ / pixels, 256, 4096)` | 9 |
| Image visée | 16,7 ms (60 images/s) ; on dégrade au-delà de 1,3×, on remonte sous 1,1× | 9 |
| Image au repos trop lente | au-delà de 200 ms, le plafond d'échantillons est réduit | 9 |
| Garde-fou Windows (TDR) | un calcul graphique de plus de 2 s environ réinitialise la carte | 9 |

### D.5 Sécurité et accès

| Constante | Valeur | Chap. |
|---|---|---|
| Mot de passe | 8 caractères au moins ; PBKDF2-HMAC-SHA256, 600 000 tours | 19 |
| Échecs de connexion | 10 en 15 minutes depuis une adresse → blocage de 15 minutes ; plafond global de 200 par fenêtre | 19 |
| Session d'administration | 8 heures ; fermée à chaque changement de mot de passe | 19 |
| Lien `#state=` | 64 Kio écrits · 2 Mio lus · 16 Mio décompressés | 12, 20.B |
| Galerie d'un jeu | 40 images, 8 Mio chacune | 14 |
| Compteurs de visites | par adresse : 60 en rafale puis 1 par seconde ; global : 600 puis 20 par seconde ; 4 096 emplacements | 19 |

### D.6 Import, conversions et mises à jour

| Constante | Valeur | Chap. |
|---|---|---|
| Morceau d'import | 8 Mio (entre 256 Kio et 16 Mio) ; 4 envois en parallèle | 17 |
| Essais d'un morceau | 6, attente 1 s doublée jusqu'à 30 s ; sonde réseau 2 s à 15 s | 19 |
| Délai d'une requête d'import | au moins 60 s (jusqu'à 50 Ko/s au plancher) | 17 |
| Régulateur de requêtes (conversions) | 6 en vol, 0,5 à 6 par seconde (départ à 4), pause de 5 s à 60 s | 17 |
| Briques lues par requête | 128 | 17 |
| Corps d'une unité de conversion | 32 Mio au plus (hôtes PHP) | 17 |
| Unité de conversion | une couche de 64 plans × un canal × une tuile de 512² (8 × 8 briques) | 17 |
| Sonde de santé après mise à jour (Python) | environ 30 s | 18 |
| Plugins au catalogue signé | 28 | 15 |
| Fichiers de tests | 201 (un processus par fichier) | 18 |

## 20.E Versions et historique {.page}

La plateforme web et le pipeline de préparation sont deux logiciels, avec **deux numéros** indépendants. Chaque version a une note, `changelog/changelog_X.Y.Z.md` pour la plateforme et `preprocess/changelog/` pour le pipeline.

![Les grandes étapes de la plateforme et du pipeline.](img/ch20/chronologie.svg){width=100%}

::: note
La version de la plateforme n'existe que dans le **nom du dernier fichier de notes** : pour passer à une nouvelle version, on ajoute une note. La version du serveur Python (`dev_server.py`) est un troisième numéro, distinct et plus ancien : elle suit l'outil serveur, pas la plateforme.
:::

### E.1 Plateforme web

| Version | Ce qu'elle apporte |
|---|---|
| 1.3 – 1.4 | Centre de téléchargement en explorateur de fichiers ; refonte complète du panneau d'administration |
| **1.5** | **Première version publique sur GitHub** : mise à jour sûre par échange de dossiers avec retour arrière, sonde de santé, installeur en un fichier, compatibilité plugin ↔ plateforme |
| 1.6 | Isolation des plugins tiers : confiance, bac à sable, politique de sécurité stricte, bibliothèques hébergées sur place |
| 1.7 | Versions signées (Ed25519), politique de sécurité aussi sur les hébergements PHP, durcissement du bac à sable |
| 1.8 – 1.13 | Marque blanche : configuration du site, assistant de premier lancement, catalogue de plugins signé (1.12), éditeur de pages sections → colonnes → widgets (1.13) |
| 1.14 | Mise à jour des hébergements PHP (1.14.2) |
| 1.25 | La page À propos devient une page modifiable |
| 1.31 | Le suivi cellulaire est enfin dessiné dans le viewer |
| 1.43 – 1.44 | Import d'un jeu depuis le navigateur, par paliers et reprenable ; pack Pipeline téléchargeable comme une version |
| 1.45 – 1.49 | Galerie d'images par jeu ; viewer de photographies 2D (1.47) |
| 1.51 | Un seul vocabulaire de types : `3d`, `2d`, `live` |
| 1.53 – 1.54 | Le suivi cellulaire devient une couche d'une série (1.53) ; Comparer pilote les vraies pages (1.54) |
| 1.55 – 1.56 | Poses de caméra et explorateur Z-stack ; export de la vue 3D, rotation des annotations, recoloration des canaux dans le Studio |
| **1.57** | « Vague d'audit » : streaming réécrit en lots, budget de mémoire graphique, version signée et suite de tests obligatoire à chaque publication |
| **1.58** | Mises à jour des données : conversion en place d'un jeu vers le format 2 |
| **1.59** | Formats 3 et 4 (briques v3 avec bordure, `index.bin`, détail au zoom) ; exécutant choisi par jeu et test de vitesse (1.59.1) ; régulateur de requêtes (1.59.2) ; huit fois moins de requêtes (1.59.3) |

### E.2 Pipeline de préparation

| Version | Ce qu'elle apporte |
|---|---|
| 0.12 – 0.13 | Seuil d'Otsu abandonné (0.12.0) ; fond estimé par percentile des coins et débruitage par masque (0.12.13 à 0.13.0) |
| 0.14 | Lanceur autonome en un seul fichier |
| 0.15 – 0.16 | Vraies séries 4D ; suivi cellulaire rattaché tout seul |
| 0.17 – 0.18 | Importeur de photographies ; nouveau vocabulaire de types |
| 0.19 | Publication « tout ou rien » en zone d'attente, avec reprise après interruption |
| 0.20 | Plans XY écrits directement (format 2) |
| **0.21** | Format 4 écrit directement, identique octet pour octet à la conversion ; saut exact de l'espace vide |

::: remember
Version actuelle de ce document : plateforme **1.59.3**, pipeline **0.21.0**, format de données **4**.
:::
