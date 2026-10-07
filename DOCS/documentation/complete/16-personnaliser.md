# 16. Personnaliser et traduire

::: chapter-intro
- Lumen3D se **repeint à vos couleurs sans une ligne de code** : nom, vocabulaire, thème, pages, mentions légales. Tout tient dans quelques petits fichiers JSON du dossier `config/`.
- Le site parle **quatre langues** (anglais, français, espagnol, néerlandais) avec **1 943 textes** par langue ; ajouter une cinquième langue, c'est déposer un fichier.
- Le site respecte aussi les visiteurs : **thème clair ou sombre** sans clignotement, **simulation de daltonisme**, usage sur téléphone, et des **statistiques sans donnée personnelle**.
:::

::: see
Ce chapitre explique la **mécanique** : où vit chaque réglage et comment il arrive à l'écran. Le pas-à-pas de chaque onglet est dans le « Guide de l'administrateur » (chapitres 6 à 11) ; le survol est au chapitre 14.
:::

## 16.1 Une plateforme, plusieurs maisons

Lumen3D est né pour regarder des embryons de souris. Il sert aujourd'hui à d'autres objets : organes, échantillons, tissus. Le **moteur** ne change pas ; ce que les visiteurs lisent change.

::: analogy
**Un hôtel de chaîne.** Les murs, l'électricité et l'ascenseur sont les mêmes partout (le moteur). La réception, l'enseigne, le menu du restaurant et la décoration portent le nom de l'établissement (la configuration).
:::

Tout ce qui est propre à *votre* site se trouve dans le dossier **`config/`** :

![Le dossier config/ : chaque fichier, qui le lit, et ce que le visiteur en voit.](img/ch16/config-carte.svg){width=76%}

::: remember
`config/` est **public** : n'importe quel visiteur peut lire ces fichiers. On n'y met donc **jamais de secret** (les mots de passe vivent dans `api/`, jamais servi).
:::

### Les fichiers, un par un

| Fichier | Ce qu'il contient | Se modifie dans l'onglet… |
|--------|-------------------|-------------|
| `instance.json` | nom, vocabulaire, SEO, pied de page, menu, noms des types, variables | [Identité]{.ui}, [Types de données]{.ui}, [Pages]{.ui} |
| `theme.json` | les valeurs de couleur, police, arrondi que vous avez changées | [Apparence]{.ui} |
| `theme.css` | la feuille de style **compilée** à partir de `theme.json` | (généré, jamais à la main) |
| `legal.json` | les sections des mentions légales, par langue | [Mentions légales]{.ui} |
| `pages/<slug>.json` | une page par fichier : sa version publiée | [Pages]{.ui} |
| `defaults/neutral/` | les valeurs de départ neutres, livrées avec la plateforme | bouton [Réinitialiser]{.ui} |
| `uploads/` | les images envoyées depuis l'éditeur de pages | éditeur de pages |

À côté, hors de `config/` : les **brouillons** de pages vivent dans `api/page-drafts/` (privé, voir 16.6).

::: tech
**Mise à jour et valeurs de départ.** `instance.json`, `theme.json`, `theme.css`, `legal.json` et `pages/` figurent sur la liste de ce que la mise à jour de la plateforme ne touche jamais : vos réglages survivent. Les images envoyées ne font partie d'aucune version livrée, donc ne sont jamais remplacées. Les fichiers de `defaults/neutral/` voyagent, eux, avec chaque version.

**Le plancher sans fichier.** Si `instance.json` est introuvable ou illisible, le navigateur retombe sur un vocabulaire neutre intégré au code (« Lumen3D », « sample »). Le serveur, lui, laisse jouer les textes de repli écrits dans les pages. Le site ne casse pas.

**Images.** Elles sont limitées à 8 Mio, aux formats PNG, JPG, WebP, GIF et AVIF. Le **SVG est volontairement refusé** : servi depuis le même domaine, il pourrait contenir un script.
:::

## 16.2 `instance.json`, champ par champ

C'est le fichier le plus riche. Voici ce que chaque bloc commande réellement.

### Identité et organisation

| Champ | Où il apparaît | Se règle dans |
|-------|------------------|---------|
| `brand.name` | jeton `{brand}` ; titre de la page `page.html` | [Identité]{.ui} · *Nom de l'instance* |
| `brand.shortName` | jeton `{brandShort}` ; titre de l'administration | *Nom court* |
| `brand.productName` | jeton `{product}` | *Nom du produit* |
| `brand.monogram` | les lettres du logo de la barre du haut (accueil, À propos…) | *Monogramme* |
| `brand.logoEmoji` | l'icône du logo de l'Explorateur et du panneau d'administration | *Emoji logo* |
| `brand.organization` | **le texte à côté du logo** de la barre du haut ; jeton `{orgShort}` | *Organisation* |
| `brand.tagline` | jeton `{tagline}` (par langue) | *Accroche* |
| `org.name` | jeton `{org}` | (assistant de première installation) |

::: example
Dans la démonstration, la barre du haut affiche « **IRIBHM — ULB** » : c'est `brand.organization`, pas `brand.name` (« IRIBHM Microscopy Platform »). Le monogramme « **IR** » est dans la pastille verte.
:::

### Vocabulaire, référencement, pied de page, menu

| Champ | Où il apparaît | Se règle dans |
|-------|------------------|---------|
| `specimen.singular`, `specimen.plural` | jetons `{specimen}`, `{specimenPlural}` et leurs versions à majuscule | *Terminologie* (par langue) |
| `datasetTypes.<type>.label`, `.title` | badges, filtres, cartes de l'accueil | [Types de données]{.ui} |
| `seo.description`, `seo.keywords` | les balises `<meta>` de chaque page | *Accroche & SEO* |
| `pageTitles.<page>` | le titre d'onglet de chaque page (`home`, `explorer`, `viewer`, `compare`, `2d`, `about`, `admin`, `legal`) | (fichier) |
| `footer.copyright` | la ligne « © … » du pied de page | *Pied de page* |
| `nav.showExplorer`, `showCompare`, `showAbout` | affiche ou cache le lien dans la barre | *Navigation* |
| `nav.showLegal` | ajoute le lien [Mentions légales]{.ui} **dans le pied de page** | *Navigation* |
| `nav.customPages` | les pages que vous avez créées (`slug`, libellé, visible) | ajouté à la première publication |

::: note
**Décocher masque le lien, pas la page.** Si vous décochez [Afficher « Comparer »]{.ui}, l'adresse `compare.html` reste valide : seul le lien disparaît de la barre. Les pages que vous créez sont ajoutées à la suite des liens, dans l'ordre de la liste, avec le libellé dans la langue du visiteur.
:::

### Les deux champs qui n'ont pas (encore) de place à l'écran

::: warning
- **`org.url`** (*Lien de l'organisation*) et **`footer.links`** (*Pied de page → Liens*) se saisissent et se **mémorisent** bien dans `instance.json`, mais **aucune page livrée ne les affiche** aujourd'hui. Le pied de page montre le copyright, [À propos]{.ui}, [Contact]{.ui} et, si coché, [Mentions légales]{.ui}.
- Pour afficher un lien d'institution, utilisez une page de l'éditeur (widget [Liste de liens]{.ui} ou [Bandeau de logos]{.ui}).
:::

### Réglages sans écran d'administration

| Champ | À quoi il sert |
|--------|---------------------|
| `channelColorPresets` | la couleur de départ d'un canal d'après son nom (voir 16.8) |
| `variables` | vos variables personnalisées `{nom}` (gérées dans l'éditeur de pages, onglet Variables) |

::: note
Chaque fichier porte son identifiant de version (`"$schema": "lumen3d-instance/1"`, `lumen3d-theme/1`, `lumen3d-legal/1`).
:::

## 16.3 Comment une valeur arrive à l'écran

Le nom de votre institution apparaît à de nombreux endroits : dans l'onglet du navigateur, dans la barre du haut, dans la phrase d'accueil. Trois mécanismes se partagent le travail, **tous alimentés par le même fichier**.

![Trois chemins, un seul fichier : ils ne peuvent pas se contredire.](img/ch16/trois-canaux.svg){width=86%}

### ① Le serveur remplit l'en-tête

Dans chaque page HTML, le titre et les balises de description contiennent des **marqueurs** :

```html
<title>{{SITE:pageTitles.home|Lumen3D — 3D Imaging Data Viewer}}</title>
```

Avant d'envoyer la page, le serveur remplace `{{SITE:chemin|repli}}` par la valeur trouvée dans `instance.json`. S'il n'y a rien (ou pas une chaîne de caractères), il met le **texte de repli** écrit après la barre `|`.

::: why
**Pourquoi côté serveur ?** Les moteurs de recherche et les aperçus de liens (messageries, réseaux) lisent l'en-tête **sans exécuter de JavaScript**. Remplir l'en-tête avant l'envoi donne le bon titre dès le premier octet, sans clignotement.
:::

::: tech
- La valeur est **échappée** (`& < > "`) avant d'entrer dans la page : un nom contenant un chevron ne peut pas casser le HTML.
- Seules les **chaînes** sont substituées : une valeur « par langue » (`{ "en": …, "fr": … }`) n'est pas résolue ici (le serveur ne connaît pas la langue du visiteur) ; c'est le navigateur qui la résout ensuite.
- Le fichier est relu seulement quand il change (la date de modification sert de clé). Les deux serveurs (Python et PHP) appliquent la même règle.
:::

### ② Le navigateur remplit la page

Le logo, le pied de page et le menu portent des attributs `data-instance` :

```html
<span data-instance="brand.organization">Lumen3D</span>
<a data-instance-attr="title:brand.tagline">…</a>   <!-- variante pour un attribut -->
```

Au chargement, `InstanceConfig` lit `instance.json` et écrit les valeurs : `data-instance` remplit le **texte** d'un élément, `data-instance-attr` remplit des **attributs** (« attribut:chemin », séparés par des points-virgules ; les pages livrées n'en ont pas besoin aujourd'hui, mais le mécanisme est prêt). Il applique aussi les titres, les `<meta>` et les entrées du menu (`nav.*`).

::: tech
Le texte entre les balises est le **repli** : si le fichier est introuvable (hors ligne, installation neuve), la page affiche ce repli au lieu d'un trou. L'application peut être rappelée (après un changement de langue, ou quand l'aperçu de l'administration recharge la configuration).
:::

### ③ Les jetons dans les phrases

Les fichiers de langue **ne contiennent jamais** le mot « embryon ». Ils écrivent un **jeton** entre accolades, que `I18n.t()` remplace au moment d'afficher :

| Jeton | Vient de | Valeur dans la démonstration |
|-------|-----------|-------------|
| `{brand}` | `brand.name` | IRIBHM Microscopy Platform |
| `{brandShort}` | `brand.shortName` | Lumen3D |
| `{product}` | `brand.productName` | Lumen3D |
| `{tagline}` | `brand.tagline` | Confocal Imaging Data Viewer |
| `{org}` | `org.name`, sinon `brand.organization` | IRIBHM — Université Libre de Bruxelles |
| `{orgShort}` | `brand.organization`, sinon `org.name` | IRIBHM — ULB |
| `{specimen}`, `{specimenPlural}` | `specimen.singular`, `.plural` **dans la langue du visiteur** | embryon, embryons |
| `{Specimen}`, `{SpecimenPlural}` | les mêmes, **première lettre en capitale** | Embryon, Embryons |
| `{type3d}`, `{type2d}`, `{typeLive}` | le nom affiché de chaque type | 3D, 2D, Live |

Treize jetons au total. L'éditeur de pages les liste (onglet [Variables]{.ui}), avec un bouton pour copier chacun :

::: tech
**Ordre de résolution d'un jeton** : d'abord une valeur passée par le code appelant (`{count}`, `{name}`…), puis le jeton de l'instance, sinon l'accolade **reste telle quelle** à l'écran (un jeton inconnu se voit).

**Un piège évité.** Les noms de types par défaut vivent eux-mêmes dans les fichiers de langue (`types.3d.label`…). Les lire par `I18n.t()` ferait appeler `t()` par la fonction qui sert `t()` : une boucle sans fin. Le code lit donc cette chaîne par **`I18n.raw()`**, la même recherche *sans* remplacement de jetons.
:::

:::: cols-wide-left
::: col
::: example
La clé `landing.heroTitle` vaut `Explorez les {specimenPlural}` en français et `Explore {SpecimenPlural}` en anglais.

- avec `specimen.plural.fr = embryons` → « **Explorez les embryons** » ;
- si le laboratoire écrit « organoïdes » → « **Explorez les organoïdes** », sans toucher à un seul fichier de langue.
:::

Les mêmes jetons marchent dans les **textes de page** que vous écrivez (16.6). L'éditeur y ajoute les **variables dynamiques** : année, date, heure, et les compteurs du catalogue.
:::
::: col
![Les jetons de l'instance, vus de l'éditeur de pages (jeu de démonstration).](img/ch16/variables-marque.png){.shot width=100%}
:::
::::

### Une valeur « par langue »

Le nom d'un spécimen, une accroche, une description SEO : ces textes dépendent de la langue. Ils s'écrivent soit comme **une simple chaîne** (identique partout), soit comme un **objet par langue**.

![Une valeur par langue : on répond avec la langue du visiteur, sinon l'anglais, sinon la première trouvée.](img/ch16/localisable.svg){width=82%}

::: example
**Le néerlandais manquant.** Dans la démonstration, `specimen.plural` existe en anglais, français et espagnol, mais pas en néerlandais. Un visiteur néerlandais voit donc : « Verken **Embryos** » : la phrase est néerlandaise, le nom est le repli anglais, et il est en capitale car le jeton est `{SpecimenPlural}`.

Ce n'est pas une panne, c'est le repli qui fonctionne : la solution est de remplir la ligne **NL** dans l'onglet [Identité]{.ui}.
:::

![La page d'accueil dans les quatre langues. Le nom de l'objet suit la langue ; en néerlandais, il retombe sur l'anglais faute de saisie.](img/ch16/langues-accueil.png){.shot width=90%}

## 16.4 Les écrans de personnalisation

### L'onglet Identité

![L'onglet Identité & personnalisation (jeu de démonstration).](img/ch16/identite.png){.shot width=78%}

::: legend
| n | ce que c'est |
|--|----------------------|
| 1 | Carte **Identité** : noms, monogramme, emoji, organisation. |
| 2 | Carte **Terminologie** : le mot qui désigne vos objets d'étude, au singulier et au pluriel. |
| 3 | Carte **Accroche & SEO** : accroche, description et mots-clés, par langue. |
| 4 | Carte **Pied de page** : copyright (par langue) et liens (voir 16.2 : non affichés). |
| 5 | Carte **Navigation** : une case par entrée du menu public. [Mentions légales]{.ui} est décochée par défaut. |
| 6 | [Enregistrer]{.ui} : actif seulement quand un champ a changé. |
| 7 | Un champ **multilingue** : une ligne par langue disponible. Ici la ligne **NL** est vide. |
:::

Chaque champ multilingue montre **autant de lignes que la plateforme a de langues** : si vous ajoutez une langue (16.9), une ligne apparaît toute seule.

### L'onglet Types de données

![L'onglet Types de données.](img/ch16/types-donnees.png){.shot width=78%}

::: legend
| n | ce que c'est |
|--|----------------------|
| 1 | Le nombre de jeux de données de ce type (ici 5 jeux 3D). |
| 2 | **Nom court** : une ligne par langue. Vide = on garde la traduction par défaut. |
| 3 | **Titre long (page d'accueil)** : volet repliable, pour les grandes cartes. |
| 4 | [Noms par défaut]{.ui} : **vide** les champs (il faut ensuite enregistrer). |
| 5 | [Enregistrer]{.ui}. |
:::

Renommer « 3d » en « Volumes » change le **mot affiché**, jamais le dossier `DATA_WEB/3d/`, ni les adresses, ni les identifiants. La chaîne est : nom saisi → sinon traduction `types.<type>` → sinon l'identifiant lui-même.

::: tech
**Une bonne pratique du code.** Aucun écran n'écrit un nom de type en dur : tout passe par `Utils.datasetTypeLabel()` et `datasetTypeTitle()`. Un élément HTML qui porte `data-dataset-type="3d"` voit son texte réécrit par ce mécanisme, y compris à chaque changement de langue.
:::

### Pourquoi deux onglets ne s'écrasent pas

Trois onglets écrivent dans le même fichier `instance.json` : Identité, Types de données et l'éditeur de pages (variables, menu). Un onglet resté ouvert une heure ne doit pas effacer le travail des autres.

::: analogy
**Un cahier partagé.** Chacun écrit **sur ses propres lignes** : le serveur n'accepte de modifier que les « chemins » annoncés (`?merge=brand,specimen,…`) sur le document **tel qu'il est maintenant**, sous un verrou. Il n'y a pas de photocopie périmée.
:::

Pour les **pages**, une protection de plus : chaque lecture porte une **révision** (une empreinte du document). Un enregistrement qui arrive avec une révision périmée est **refusé** (409 « stale ») plutôt que d'écraser une version plus récente.

### L'assistant de première installation

À la toute première visite (aucun mot de passe n'existe), le panneau ouvre un assistant en **cinq étapes**. Seule la première est obligatoire.

::: steps
1. **Compte** : le mot de passe de l'administrateur.
2. **Identité** : nom de l'instance, organisation, nom de l'objet (singulier / pluriel).
3. **Thème** : une couleur de marque parmi six (vert, bleu, violet, turquoise, orange, carmin).
4. **Textes** : accroche et ligne de copyright.
5. **Plugins** : le catalogue signé (chapitre 15).
:::

À la fin, l'assistant n'écrit que ce qu'il a rempli : `brand` (le monogramme prend les deux premiers caractères du nom, en majuscules), `specimen`, éventuellement `org.name` et `footer.copyright`, puis les jetons de couleur choisis dans `theme.json`.

## 16.5 Le thème : couleurs, police, arrondis

Le look du site est piloté par des **variables CSS** (des « jetons » de style) : `--color-primary`, `--font-sans`, `--radius-md`… L'onglet [Apparence]{.ui} n'en modifie qu'une poignée, à dessein.

![L'onglet Apparence : cinq couleurs, une police, un arrondi, et un aperçu du vrai site.](img/ch16/apparence.png){.shot width=78%}

::: legend
| n | ce que c'est |
|--|----------------------|
| 1 | Les **cinq couleurs de marque** : primaire, accent, succès, erreur, avertissement. |
| 2 | La **police** : Inter (défaut), Système, Grotesque, Serif, Arrondie. |
| 3 | L'**arrondi des coins** : Standard, Net, Doux, Rond. |
| 4 | L'**aperçu en direct** : le vrai site dans un cadre, qui change instantanément. |
| 5 | [Enregistrer]{.ui} : rien n'est appliqué au site avant ce clic. |
:::

### Du clic à toutes les pages

![Le chemin d'un réglage de thème, et l'ordre des feuilles de style.](img/ch16/theme-pipeline.svg){width=86%}

::: remember
Le serveur ne laisse passer que des variables dont le nom commence par `--`, et retire de chaque valeur les caractères qui pourraient casser une feuille de style (`{ } ; < > \ @`) ; une valeur est coupée à 200 caractères. **Un thème mal saisi ne peut pas détruire la feuille entière.**
:::

La feuille `theme.css` est chargée **après** `themes.css` (le thème sombre/clair d'usine) et avant les feuilles de mise en page : elle **gagne** donc sur les valeurs d'usine, mais seulement pour ce que vous avez changé. Le reste continue de venir de `variables.css`.

### Une couleur, cinq réglages

Un seul sélecteur de couleur ne suffit pas : un bouton a besoin d'une teinte au survol, d'une teinte foncée, d'un fond discret. L'éditeur les **dérive** pour vous.

![Une couleur choisie (ici #2F6BFF) et ses dérivés.](img/ch16/theme-derives.svg){width=86%}

| Réglage | Calcul |
|-----------|-------------|
| `--color-primary-hover` | la clarté (HSL) **+ 8** points |
| `--color-primary-dark` | la clarté **− 10** points |
| `--color-primary-subtle` | la même couleur à **15 %** d'opacité (accent : 12 %) |
| `--color-primary-strong` | la couleur mélangée à **77 %** de noir (survol : 64 %) |

Succès, erreur et avertissement dérivent de la même façon (survol, fond discret à 12 %).

### Le contraste du texte blanc

Les boutons pleins portent du **texte blanc** sur `--color-primary-strong`. C'est la raison d'être du réglage « strong » : le vert d'usine (#00A654) ne donne que **3,19 : 1** sous du blanc, insuffisant pour du texte ; assombri, il passe à **5,05 : 1**. La règle WCAG AA demande **4,5 : 1**.

![Contraste du texte blanc sur le bouton, pour les six couleurs proposées par l'assistant.](img/ch16/contraste.svg){width=82%}

::: warning
Le calcul **assombrit** la couleur choisie, il ne vérifie rien. Les teintes déjà sombres s'en sortent ; **l'orange** (4,22) et **la turquoise** (3,61) restent **sous le seuil**. Après avoir changé la couleur primaire, regardez vos boutons dans les deux thèmes.
:::

::: tech
Le contraste est le rapport de luminance relative WCAG, `(L1 + 0,05) / (L2 + 0,05)`, où `L` est calculée sur les composantes RVB **linéarisées** (loi sRVB). Les chiffres ci-dessus sont recalculés par le script de la figure à partir des couleurs de l'assistant (`DOCS/documentation/img/ch16/make_figures.py`).
:::

### Clair ou sombre

Le thème **sombre** est le défaut, par choix : une image de fluorescence se lit mieux sur fond noir. Le visiteur bascule d'un clic ; son choix est mémorisé **dans son navigateur** (`iribhm-theme`).

![Le même site en thème sombre (à gauche) et clair (à droite).](img/ch16/theme-clair-sombre.png){.shot width=90%}

::: note
Le thème n'est **pas** calé sur le réglage du système au premier passage. Si le visiteur n'a **jamais** choisi, un changement du réglage clair/sombre de son système est suivi ; dès qu'il a choisi, c'est son choix qui compte.
:::

Chaque thème règle aussi `color-scheme` : les menus déroulants natifs, les barres de défilement et les sélecteurs de date prennent le bon aspect, sans texte clair sur fond blanc.

### Le fond du viewer 3D : un réglage à part

Le **fond du volume** ne suit pas le thème du site : c'est un réglage du viewer, dans la barre latérale ([Arrière-plan]{.ui}), mémorisé avec l'état de travail.

| Choix | Couleur |
|--------|----------------|
| [Sombre]{.ui} (défaut) | `#000000` |
| [Clair]{.ui} | `#f4f6fb` |
| [Papier]{.ui} | `#f8f5ec` |
| [Transparent]{.ui} | aucun fond (les exports en PNG gardent la transparence) |
| [Personnalisé]{.ui} | la couleur que vous choisissez (`#1a1d27` au départ) |

::: tip
Un fond **clair** ou **papier** convient aux figures imprimées. Un code de couleur invalide est refusé avec un avertissement en console : le viewer garde la couleur par défaut du choix plutôt que d'afficher une teinte au hasard.
:::

## 16.6 Le constructeur de pages

Accueil, À propos, ou toute page que vous créez (protocoles, équipe, contact…) se construisent **à la souris**, comme dans un logiciel de mise en page.

![Une page = des sections (bandes), des colonnes (douzièmes), des widgets (briques).](img/ch16/page-modele.svg){width=86%}

### Le modèle : sections, colonnes, widgets

- Une **section** est une bande de la page : fond, marges, largeur maximale.
- Une **colonne** y occupe de **1 à 12 douzièmes** ; une section a **6 colonnes au plus** dans l'éditeur. Sur téléphone, les colonnes **s'empilent**.
- Un **widget** est une brique de contenu. Il y en a **27 types**.

::: analogy
**Un journal.** La page est un numéro, les sections sont les bandeaux horizontaux, les colonnes sont les colonnes du journal, les widgets sont les articles, les photos et les encadrés.
:::

### Les 27 widgets

![Les 27 widgets, rangés comme dans la palette de l'éditeur.](img/ch16/widgets-27.svg){width=90%}

### Ce que fait chaque widget

| Widget | Ce que c'est, et ses réglages |
|-------|------------------------------|
| **Bases** | |
| [Titre]{.ui} | un titre de section ; niveau de titre et alignement |
| [Texte]{.ui} | un paragraphe ; mini-mise en forme `**gras**`, `*italique*`, `[lien](adresse)` |
| [Image]{.ui} | une image avec légende et lien ; cadrage (remplir ou contenir), largeur, hauteur, texte alternatif |
| [Icône]{.ui} | un pictogramme choisi dans la bibliothèque d'icônes (avec recherche) ; taille, couleur |
| [Bouton]{.ui} | libellé et lien ; variante, icône à gauche ou à droite, taille, contour, pleine largeur |
| [Badges]{.ui} | de petites étiquettes ; pastille colorée, police à chasse fixe, couleurs |
| **Contenu** | |
| [Héros]{.ui} | le grand bandeau d'accueil : titre, sous-titre, deux boutons, badge, halo décoratif, fond |
| [Bandeau d'action]{.ui} | un encart qui invite à cliquer : titre, sous-titre, deux boutons |
| [Carte icône]{.ui} | icône, image ou monogramme + titre + texte + lien ; disposition horizontale ou verticale |
| [Citation]{.ui} | texte, auteur, rôle, photo ; en barre ou en carte |
| [Galerie]{.ui} | des images en grille ; colonnes, légendes, zoom au survol |
| [Profil]{.ui} | une fiche de personne : nom, rôle, description, média |
| [Citation copiable]{.ui} | une référence avec bouton « copier » et un bloc repliable (BibTeX…) |
| [Compteur animé]{.ui} | un chiffre qui défile ; valeur fixe **ou** source du catalogue ; préfixe, suffixe |
| [Vidéo]{.ui} | un fichier `.mp4`/`.webm`, ou un lien YouTube/Vimeo qui s'ouvre **dans un nouvel onglet** ; image d'aperçu, boucle, lecture automatique muette |
| [Bandeau de logos]{.ui} | une rangée de logos partenaires ; désaturés avec couleur au survol, plaque claire |
| **Listes & données** | |
| [Accordéon / FAQ]{.ui} | des questions qui se déplient ; une seule ouverte à la fois, la première ouverte |
| [Frise chronologique]{.ui} | une suite d'étapes datées |
| [Statistiques]{.ui} | une rangée de chiffres clés ; valeur fixe **ou** compteur du catalogue (jeux de données, spécimens, cellules, régions) |
| [Derniers datasets]{.ui} | les cartes des jeux les plus récents ; nombre, colonnes, type et date affichés ou non |
| [Liste à icônes]{.ui} | une liste à puces illustrées ; verticale ou horizontale |
| [Onglets]{.ui} | du contenu réparti en onglets |
| [Liste de liens]{.ui} | des lignes séparées par des filets fins, avec une flèche : la façon sobre de présenter des liens |
| [Fiche d'informations]{.ui} | un tableau « libellé : valeur » |
| **Structure** | |
| [Séparateur]{.ui} | un trait ; épaisseur, largeur, style (plein, tirets, points), couleur |
| [Espace]{.ui} | un vide réglable de 0 à 400 pixels (32 par défaut) |
| [HTML]{.ui} | du HTML libre, **nettoyé par liste blanche** (voir ci-dessous) |

::: tech
**Sécurité du contenu.** Le texte est toujours écrit par `textContent` (jamais interprété comme du HTML). Le widget HTML passe par une **liste blanche** : les scripts, les gestionnaires d'événements, les SVG et les liens `javascript:` sont retirés ; chaque attribut `style` est filtré déclaration par déclaration (pas de `position: fixed`, pas de `z-index`, pas d'URL exotique). Les liens saisis refusent les schémas `javascript:`, `vbscript:`, `data:`. Les vidéos externes ne sont **pas** intégrées dans la page : la politique de sécurité du site interdit les cadres tiers, d'où le simple lien.
:::

### Le style d'un élément

Chaque **widget**, **colonne** et **section** a ses réglages de style, en sept familles :

| Famille | Ce qu'on y règle |
|-------|------------------------------|
| Texte | couleur (ou **dégradé** peint dans les lettres), taille, graisse, interligne, espacement des lettres, italique, majuscules, alignement |
| Fond & bordure | couleur ou image de fond, voile, arrondi, bordure (épaisseur, couleur, trait), ombre (légère, moyenne, grande, halo), opacité |
| Espacement | marges et marges intérieures, côté par côté ou liés |
| Taille | largeur maximale, hauteur minimale |
| Effets | survol : lévitation, halo ou zoom |
| Visibilité | masquer sur mobile, ou sur ordinateur |
| CSS personnalisé | quelques déclarations CSS, **assainies** avant d'être appliquées |

::: tech
Le style est compilé en CSS **en ligne** (attribut `style`), sans feuille de style injectée : la politique de sécurité interdit les `<style>` ajoutés après coup. Seules les règles qui ont vraiment besoin d'une feuille (le survol `:hover`, les masquages par taille d'écran `@media`) vivent dans `css/pages.css`, un fichier du site. Chaque valeur passe par un filtre qui retire de quoi sortir d'une déclaration.
:::

### Variables, jetons et fonds

- **Variables dynamiques** : `{year}`, `{date}`, `{time}`, et les compteurs `{datasetCount}`, `{specimenCount}`, `{cellCount}`, `{regionCount}` (calculés à l'affichage, dans la langue du visiteur).
- **Jetons de l'instance** : les treize du paragraphe 16.3 fonctionnent aussi dans les textes de page.
- **Vos variables** : un nom (une lettre, puis lettres, chiffres ou `_`, 32 caractères au plus) et une valeur, par langue si besoin. Si leur nom est celui d'une variable existante, la vôtre **gagne**.
- **Fonds animés** : dix préréglages (particules flottantes, vagues, aurore, ciel étoilé, grille pulsante, constellation, orbes, ondes du curseur, champ de force, halo). Cinq vivent seuls, cinq réagissent à la souris. Avec « réduire les animations » activé dans le système, un seul dessin **fixe** remplace l'animation.

::: tip
Les variables `{…}` marchent dans **tous** les textes de page, mais pas dans les fichiers de langue (qui n'ont que les jetons de l'instance).
:::

### Brouillon et publication

![Deux fichiers, deux publics : le brouillon est privé, la version publiée est publique.](img/ch16/brouillon-publication.svg){width=86%}

::: remember
**Rien n'est public avant [Publier]{.ui}.** Pendant que vous travaillez, les visiteurs voient l'ancienne version. Le brouillon est enregistré tout seul, mais il est rangé **hors de `config/`** : ce dossier se lit sans mot de passe, et l'éditeur enregistre environ une fois par seconde pendant que vous écrivez. Un brouillon laissé dans `config/` aurait permis à n'importe qui de regarder l'opérateur écrire.
:::

Cela pose aussi des règles de bon sens à l'éditeur :

- **« Publier »** enregistre d'abord le brouillon, puis le *promeut* en version publique.
- **« Défaut »** (pages d'origine) revient au modèle livré ; sur une page à vous, il abandonne le brouillon et revient à la version publiée.
- Un **seul onglet d'édition par page** : le second se tait jusqu'à ce que vous « repreniez la main ».
- L'éditeur retient **60 étapes** d'annulation / rétablissement.
- Au premier [Publier]{.ui} d'une page créée par vous, elle est ajoutée au **menu** automatiquement.

### L'éditeur à l'écran

L'éditeur s'ouvre **dans son propre onglet** (`admpan.html?editor=<page>`) : la **vraie** page apparaît dans un cadre, avec son vrai menu et son vrai thème ; l'éditeur ajoute une couche de poignées par-dessus.

![L'éditeur de pages, sur la page « À propos » (jeu de démonstration).](img/ch16/editeur.png){.shot width=90%}

::: legend
| n | ce que c'est |
|--|----------------------|
| 1 | La **page** en cours d'édition (la mention « intégrée » : elle utilise encore le modèle livré). |
| 2 | La **langue** que vous écrivez. |
| 3 | Les cinq volets : [Éléments]{.ui}, [Réglages]{.ui}, [Fond]{.ui}, [Traduire]{.ui}, [Variables]{.ui}. |
| 4 | La **palette** des 27 widgets, en quatre familles. Un clic ou un glisser. |
| 5 | L'aperçu **ordinateur / tablette / mobile**. |
| 6 | [Brouillon]{.ui} : enregistre sans publier. |
| 7 | [Publier]{.ui} : met votre version en ligne. |
| 8 | **La vraie page** : cliquez un élément pour le sélectionner. |
:::

Les widgets de la page sont décrits par le **même code** pour l'éditeur et pour le site (`PageRenderer`) : ce que vous voyez dans l'éditeur est exactement ce qui sera publié.

### Le modèle de la page À propos

Les pages **Accueil** et **À propos** existent d'origine. Tant que vous n'avez rien publié, la page affichée est un **modèle** écrit dans le même format que vos pages (`js/core/page-templates.js`). Il est à la fois :

- ce que **voient les visiteurs** (il n'y a plus de HTML de secours caché dans `about.html`) ;
- le **point de départ** de l'éditeur, qui l'ouvre avec la mention « Modèle de départ ».

Ses phrases sont déjà écrites en anglais, français et espagnol, avec des jetons (`{brandShort}`, `{SpecimenPlural}`, `{org}`, `{year}`…) : la page porte donc **votre** nom avant que vous n'ayez changé un mot.

### Traduire une page

L'onglet [Traduire]{.ui} liste **tous les textes** de la page, un champ par langue, et signale ceux qui manquent (« 24 textes · 7 traductions manquantes »). Il n'y a **aucune traduction automatique** : rien ne quitte votre serveur.

::: tip
Méthode conseillée : rédigez toute la page dans **une** langue, puis passez sur l'onglet Traduire. N'oubliez pas l'anglais : c'est le repli de toutes les autres langues.
:::

### Les limites

| Limite | Valeur |
|-----------|----------------|
| taille d'une page | 2 Mo |
| sections par page | 300 |
| colonnes par section | 12 côté serveur, 6 dans l'éditeur |
| widgets par colonne | 500 |
| largeur d'une colonne | 1 à 12 douzièmes |
| adresse d'une page (`slug`) | minuscules, chiffres, `-`, `_` ; 64 caractères au plus |

Un document hors limites est **refusé en entier**, jamais enregistré à moitié (seule la largeur d'une colonne est simplement ramenée entre 1 et 12). Une page supprimée ou inconnue ramène à l'accueil plutôt que d'afficher une page vide.

## 16.7 Les mentions légales

Un site public a besoin d'un **éditeur**, d'un **hébergeur**, d'une politique de **données**. L'onglet [Mentions légales]{.ui} est un éditeur volontairement simple : une liste de **sections**, chacune avec un titre et un texte, **par langue**.

![La page legal.html, telle qu'un visiteur la voit (modèle neutre, en français).](img/ch16/legal-public.png){.shot width=74%}

::: legend
| n | ce que c'est |
|--|----------------------|
| 1 | Le **titre** d'une section (« Éditeur du site »). |
| 2 | Le **texte** : un paragraphe par ligne blanche. Les `[crochets]` sont à remplacer par vos informations. |
:::

- Tant que vous n'avez rien publié, la page montre le **modèle neutre** livré (éditeur, protection des données, cookies et stockage local, propriété intellectuelle, avertissement, contact). Il est écrit en **anglais, français et espagnol**.
- Le texte est affiché par `textContent` : aucun HTML, aucune mise en forme, une section par bloc.
- Le lien n'apparaît dans le pied de page que si la case [Afficher « Mentions légales »]{.ui} est cochée (décochée par défaut).

::: warning
Ces textes sont des **points de départ**, pas des conseils juridiques. Faites-les relire pour votre pays. N'oubliez pas qu'un serveur web garde généralement un **journal d'accès** (adresses IP) selon sa configuration : c'est l'affaire de votre hébergeur, et elle se déclare ici (voir 16.11).
:::

## 16.8 D'où vient la couleur de départ d'un canal ?

Quand vous ouvrez un jeu de données, chaque canal apparaît déjà en couleur. D'où vient cette couleur ? Le chapitre 11 montre comment on la **change** ; voici d'où elle **vient**.

![La première réponse non vide l'emporte.](img/ch16/couleur-canal.svg){width=86%}

Le panneau prend la **première** réponse disponible :

1. les **réglages d'affichage** du jeu (`display_defaults`) ;
2. une liste `colors` (ancien format) ;
3. la couleur du canal dans `metadata.json` (`channels[i].color`) : celle que le **pipeline** écrit au départ, ou que l'**éditeur de datasets** a enregistrée ;
4. un **préréglage par nom** de l'instance ;
5. un **cycle neutre** : vert, bleu clair, magenta, rouge.

### Le préréglage par nom

Dans `instance.json`, une liste `channelColorPresets` associe un morceau de nom à une couleur :

```json
{ "match": "dapi",  "color": "#00AAFF" },
{ "match": "pecam", "color": "#FF00FF" }
```

Le nom du canal est mis en minuscules ; **le premier** `match` contenu dans le nom l'emporte. La démonstration en contient huit : `gfp` (vert), `dapi` et `hoechst` (bleu clair), `pecam` et `picam` (magenta), `rfp`, `mcherry` et `alexa` (rouge).

::: warning
Comme le pipeline écrit **toujours** une couleur (étape 3), les préréglages ne servent en pratique qu'aux jeux dont les métadonnées n'en ont pas. Ils n'ont pas d'écran d'administration : on les modifie dans `instance.json`.
:::

### Quatre listes de couleurs, quatre usages

| Où | Couleurs |
|-------|-----------------|
| le **pipeline** (`metadata.json`) | `#00FF00`, `#00AAFF`, `#FF00FF`, `#FF0000`, `#FFFF00`, `#00FFFF` |
| l'**éditeur de datasets** (si rien) | `#00FF66`, `#FF3DFF`, `#2F6BFF`, `#FF3030` |
| le **panneau de canaux** (cycle neutre) | `#00FF00`, `#00AAFF`, `#FF00FF`, `#FF0000` |
| la **vignette** du jeu (image de l'Explorateur) | vert, magenta, bleu, rouge, jaune, violet, cyan |

::: note
Ces listes ne sont pas synchronisées : elles servent à des moments différents. La couleur **qui compte** pour le visiteur est celle du panneau de canaux, qui part de `metadata.json`. Les 27 couleurs du sélecteur, elles, sont fixes (chapitre 11).
:::

## 16.9 Traduire : comment le site parle quatre langues

Le site public, le viewer, l'administration et même les mots de chaque outil sont traduits. Tout repose sur un **fichier par langue** et une seule fonction, `t('clé')`, qui rend le texte dans la langue du visiteur.

![Où vit chaque texte du site.](img/ch16/i18n-ou.svg){width=86%}

### Les chiffres

| | |
|---|---|
| langues livrées | **4** : anglais, français, espagnol, néerlandais |
| textes par langue | **1 943** (mesuré sur les quatre fichiers `lang/*.json`) |
| dictionnaires d'outils | **28**, soit 240 textes en anglais |
| langues de secours | l'**anglais**, toujours |

Les 1 943 textes se répartissent ainsi :

| Famille de clés | Textes | Ce qu'elle contient |
|--------|---|------------|
| `pages` | 485 | l'éditeur de pages |
| `admin` | 365 | le panneau d'administration |
| `viewer` | 182 | le viewer |
| `dupd` | 119 | l'onglet Mises à jour des données |
| `upl` + `upload` | 104 | l'import |
| `compare`, `about`, `studio`, `tips`… | 688 | le reste |

::: remember
Une clé d'une langue **existe dans les quatre**, avec les **mêmes jetons** `{…}`. Un test automatique le vérifie à chaque version (`tests/js/test_build_lang_parity.mjs`) : une clé manquante, vide ou dont les jetons changent fait échouer la livraison.
:::

### Quelle langue ? Quelle phrase ?

![À gauche : le choix de la langue au chargement. À droite : la recherche d'un texte.](img/ch16/i18n-choix.svg){width=86%}

- **Le choix.** La clé `iribhm-lang` du navigateur (écrite quand le visiteur clique dans le menu) ; sinon la langue du navigateur (« fr-BE » devient « fr ») ; sinon l'anglais.
- **Le chargement.** L'anglais est lu **d'abord** (toujours), puis la langue choisie. Si ce fichier échoue, l'interface reste en anglais.
- **La propagation.** Un clic dans le menu prévient les **autres pages ouvertes** de la même origine (événement `storage`) : dans Comparer, les panneaux embarqués changent de langue avec la page hôte.
- **Le document.** L'attribut `lang` de la page suit la langue ; `dir="rtl"` est posé pour une langue de droite à gauche (aucune n'est livrée).

![Le menu des langues de la barre du haut : un bouton par langue, avec son drapeau et son nom natif.](img/ch16/menu-langues.png){.shot width=74%}

::: legend
| n | ce que c'est |
|--|----------------------|
| 1 | Le bouton [Langue]{.ui}. |
| 2 | Le menu : généré **à partir des langues découvertes**, anglais en premier, puis ordre alphabétique. |
| 3 | Le filtre pour daltoniens (voir 16.10). |
| 4 | Le thème clair / sombre. |
:::

### La découverte des langues

La liste des langues **n'est écrite nulle part en dur** : on la découvre, de la plus à la moins directe.

::: steps
1. `GET api/languages.php` : le serveur liste les fichiers `lang/<code>.json` (le nom doit être de la forme `fr` ou `pt-BR`).
2. Sinon `lang/manifest.json`, l'index que le serveur Python **réécrit** quand la liste change, pour les hébergements statiques.
3. Sinon une liste de secours intégrée au code : anglais, français, espagnol.
:::

::: tech
L'anglais est **toujours ajouté** à la liste, même s'il manquait : le menu ne peut pas être vide. Le néerlandais n'est pas dans la liste de secours : si les deux découvertes échouent, il disparaît du menu.
:::

### Les cinq façons d'attacher un texte à un élément

Dans le HTML, un attribut dit quel texte affiche l'élément :

| Attribut | Ce qu'il remplit |
|--------|------------------|
| `data-i18n="clé"` | le texte de l'élément |
| `data-i18n-placeholder` | le texte grisé d'un champ de saisie |
| `data-i18n-title` | l'infobulle |
| `data-i18n-aria` | l'étiquette lue par un lecteur d'écran (`aria-label`) |
| `data-i18n-html` | un texte qui contient du balisage (rarement) |

Le remplacement n'a lieu que si la clé **existe** : sinon on garde le texte écrit dans la page (anglais), jamais une clé nue.

### Les mots des outils

Chaque plugin porte ses propres textes : `js/modules/<famille>/<id>/lang/<code>.json`. Au chargement, ils sont rangés **sous `plugins.<id>`** dans le même arbre que les textes de la plateforme.

- La liste des langues d'un plugin est déclarée dans son `plugin.json` (`i18nLanguages`) : on ne tente pas de charger un fichier qui n'existe pas.
- Pour chaque plugin, le **repli est son propre anglais**. Le plugin de capture d'écran « sandboxé » n'a pas d'espagnol ; un visiteur espagnol le voit en anglais, sans erreur.
- Sur le serveur Python, les dictionnaires voyagent **dans la réponse de découverte des plugins** (une requête de moins par plugin et par langue) ; ailleurs, ils sont lus fichier par fichier, et seulement l'anglais et la langue choisie.
- Un plugin qui offre une langue que la plateforme n'a pas ne l'ajoute pas au menu : seule la plateforme décide.

### Ajouter une langue

::: steps
1. **Copiez** `lang/en.json` en `lang/de.json` (exemple : l'allemand) et traduisez les **valeurs**, jamais les clés ni les `{jetons}`.
2. **Rechargez** : la langue apparaît dans le menu (le code `de` est déjà connu : « Deutsch », drapeau). Un code inconnu fonctionne aussi, avec son sigle en majuscules et un drapeau neutre.
3. **Plugins** : ajoutez `lang/de.json` aux outils que vous voulez traduire et complétez `i18nLanguages` ; sans cela, l'anglais.
4. **Vos contenus** : une ligne `DE` apparaît toute seule dans les onglets Identité, Types de données, Mentions légales et dans l'éditeur de pages.
5. **Vérifiez** avec `node tests/js/test_build_lang_parity.mjs` (clés, vides, jetons).
:::

::: note
Les langues qui s'écrivent de droite à gauche (l'arabe est connu du code) reçoivent `dir="rtl"`, mais aucune n'est livrée : la mise en page n'a pas été validée pour elles dans ce dépôt.
:::

### Que se passe-t-il si… ?

| Situation | Ce que voit le visiteur |
|----------|----------|
| une clé manque en français | le texte **anglais** |
| une clé manque aussi en anglais | la **clé elle-même** (« landing.heroTitle ») |
| `specimen.plural` n'a pas de ligne `nl` | le nom **anglais** dans la phrase néerlandaise |
| la valeur d'une langue est vide | l'anglais (une ligne vide compte comme absente) |
| le fichier d'une langue est illisible | l'interface reste en **anglais** |
| un plugin n'a pas la langue | l'anglais **du plugin** |
| un jeton `{xyz}` n'existe pas | `{xyz}` s'affiche tel quel |

## 16.10 Accessibilité, thème et mobile

L'accessibilité d'un outil d'imagerie a des limites (une image 3D reste une image). Voici ce que le code fait réellement.

### Avant le premier affichage : le thème

![Comment le thème clair arrive avant le premier affichage.](img/ch16/theme-boot.svg){width=86%}

::: tech
Un petit script bloquant (`theme-boot.js`, quelques lignes) est placé dans l'`<head>`, après les feuilles de style. Il lit la clé du thème et, si elle vaut « light », change l'attribut `data-theme` **avant** que la page soit peinte. Le panneau d'administration le charge avec sa propre clé (`adm-theme`).
:::

### Au clavier et avec un lecteur d'écran

- Un lien d'évitement **« Aller au contenu »** est le premier élément focalisable de chaque page publique (9 pages sur 10 : seule la page de démonstration de widgets, non livrée, n'en a pas) ; il mène au `<main id="main">`.
- Les boutons d'icônes portent un nom (`aria-label`, ou une infobulle traduite) ; le texte vient des fichiers de langue.
- Les fenêtres modales (`Dialog`) sont déclarées `aria-modal` ; quand elles offrent une issue « annuler », <kbd>Échap</kbd> ou un clic sur le fond la choisit. Leur texte est écrit par `textContent`.
- Les outils du viewer ont des raccourcis (V, C, M, I, D…) : voir le chapitre 12.
- Les feuilles de style contiennent 25 occurrences de `:focus-visible` : l'élément qui a le focus clavier est entouré.

### Mouvement réduit

Si le système demande « réduire les animations », **toutes** les animations et transitions CSS du site sont ramenées à presque zéro, et les fonds animés des pages deviennent un dessin fixe. Les mouvements de caméra du viewer (WebGL) ne sont pas du CSS : ils ne sont pas concernés.

### Le filtre pour daltoniens

Le bouton en forme d'œil de la barre du haut ouvre le menu **« Simulation des déficiences de la vision des couleurs »** : 9 choix en 5 groupes.

![Le menu de simulation : pour chaque choix, sept teintes de test déjà filtrées.](img/ch16/daltonisme-menu.png){.shot width=78%}

::: legend
| n | ce que c'est |
|--|----------------------|
| 1 | Le titre : c'est bien une **simulation**. |
| 2 | Le choix actif (ici « Désactivé »). |
| 3 | Deutéranopie : plus de sensibilité au vert. |
| 4 | Achromatopsie : plus aucune couleur. |
:::

| Groupe | Déficience complète | Déficience partielle |
|---|---|---|
| Rouge (protan) | protanopie | protanomalie |
| Vert (deutan) | deutéranopie | deutéranomalie |
| Bleu (tritan) | tritanopie | tritanomalie |
| Monochromatisme | achromatopsie | achromatomalie |

Le filtre s'applique à **toute la page**, y compris le viewer 3D, pour voir ce que verrait une personne atteinte :

![Le même embryon (jeu de démonstration) avec les canaux DAPI, Pecam1, Sox2, sous quatre simulations.](img/ch16/daltonisme-viewer.png){.shot width=90%}

::: example
Dans cette démonstration, le vert et le magenta de la vue normale deviennent, en protanopie et en deutéranopie, des **bleus et des beiges** : l'opposition rouge-vert qui séparait les deux marquages disparaît. En tritanopie, le vert devient cyan et le magenta rose. C'est exactement ce qu'une figure de publication doit vérifier.
:::

![Les mêmes sept teintes, calculées par le script d'après les matrices du code.](img/ch16/daltonisme-teintes.svg){width=82%}

::: tech
- **Le calcul.** Chaque simulation est une matrice 3×3 de **Machado, Oliveira et Fernandes (2009)**, appliquée à la lumière **linéaire** (`color-interpolation-filters="linearRGB"`). Les « …opies » sont la sévérité 1,0 (cône absent) ; les « …omalies », la sévérité 0,5. Chaque ligne fait 1 : un gris reste gris. L'achromatopsie remplace les trois canaux par la luminance (0,2126 R + 0,7152 V + 0,0722 B) ; l'achromatomalie en est le mélange à moitié.
- **Où il s'accroche.** Le filtre est posé sur l'élément racine `<html>`, pas sur `<body>` : un filtre sur un autre élément en ferait le référentiel de ses descendants `position: fixed` (barre du haut, fenêtres, notifications), qui défileraient avec la page.
- **Pendant le choix.** Le filtre de la page est levé tant que le menu est ouvert, pour que les aperçus (qui ont leur propre filtre) ne soient pas filtrés deux fois.
- **Mémoire.** La clé `iribhm-colorblind` du navigateur ; les panneaux de Comparer la suivent par l'événement `storage`.
:::

::: warning
**Ce n'est pas une correction.** Le filtre ne recolore pas la page pour la rendre lisible à une personne daltonienne : il **montre** ce qu'elle voit, pour que vous jugiez *vos* figures. Il n'y a pas non plus de palette « adaptée aux daltoniens » livrée : les couleurs de canaux sont libres. Conseil du chapitre 11 : préférez vert + magenta, ou bleu + jaune, au rouge + vert.
:::

::: note
La simulation est un effet d'**affichage** : les exports (capture, figure) sont faits à partir du rendu, pas de l'écran filtré. Pour juger une figure destinée à l'impression, exportez-la puis regardez l'image sous une simulation.
:::

### Sur téléphone et tablette

Le site est **utilisable sur téléphone**, avec des limites que le viewer ne peut pas lever.

![L'accueil, l'Explorateur, le viewer et son menu ☰, sur un écran de 390 pixels de large.](img/ch16/mobile.png){.shot width=90%}

- **Tactile.** Un doigt fait tourner le volume ; **deux doigts** le déplacent et le rapprochent (pincer). Aucune touche de modification n'est nécessaire.
- **Barre d'outils repliée.** Quand les boutons ne tiennent plus sur une ligne, ils se rangent derrière un bouton ☰ (troisième et quatrième images).
- **Poignées plus larges** sur les écrans tactiles : les poignées de l'histogramme passent de 12 à 22 pixels.
- **Accueil.** Sous 900 pixels, les liens de la barre disparaissent (la barre ne garde que langue, filtre et thème) ; on passe par les boutons de la page.
- **Studio.** Sous 720 pixels, ses panneaux s'empilent sous l'image.

::: warning
**Les limites sont celles du matériel.** Le viewer exige WebGL2 ; la mémoire graphique d'un téléphone est comptée au plus juste (chapitre 10). Un gros jeu à qualité maximale peut y être refusé avec un message : le site passe au niveau plus grossier plutôt que de planter.
:::

### Polices

La seule dépendance distante du site est **Google Fonts** (Inter, JetBrains Mono). Le lien est chargé **en différé** (`media="print"`, activé par `font-loader.js`) : la page ne l'attend pas pour s'afficher. Hors ligne ou si la police est bloquée, le navigateur utilise sa police sans empattement : le site reste lisible.

## 16.11 Les statistiques d'usage

Un laboratoire veut savoir si ses jeux de données sont regardés. Lumen3D le dit **sans rien savoir de vous**.

![Ce qui est compté, et ce qui n'est pas gardé.](img/ch16/stats-stockage.svg){width=86%}

### Ce qui est compté

| Compteur | Quand il monte |
|-------|---------------------|
| **Visites** | une fois par **session de navigation** (un onglet), à l'ouverture de l'**accueil** |
| **Vues** | une fois par session et par jeu de données, quand un jeu s'ouvre dans le viewer |
| **Téléchargements** | quand un fichier du dossier `download/` d'un jeu (celui que propose le Download Center) est servi **en entier** |

::: tech
- Les balises sont des requêtes `POST` envoyées par `navigator.sendBeacon`, sans attendre de réponse (elles survivent à la fermeture de l'onglet). Un `GET` est **refusé** (405) : une image tierce ne peut pas gonfler vos chiffres.
- « Une fois par session » veut dire : une clé de `sessionStorage` (`lumen_visit`, `lumen_view_<jeu>`) mémorise que c'est fait. Elle reste dans le navigateur et disparaît à la fermeture de l'onglet.
- Les **aperçus de l'administration** (`mode=admin`) ne comptent pas : modifier un jeu ne gonfle pas ses vues.
- Un visiteur qui arrive **directement** sur un jeu (lien reçu par courrier) compte une **vue** mais pas de **visite** : seule l'accueil compte les visites.
- Les téléchargements sont comptés **côté serveur Python**, au moment où le fichier est servi (une reprise partielle n'est pas recomptée). Les hébergements PHP ont l'entrée de comptage mais aucun code du dépôt ne l'appelle pour un téléchargement : leur compteur reste à zéro.
:::

### Ce qui est gardé : `api/stats.json`

Rien d'autre que des **nombres** et une date :

- `global` : visites, vues, téléchargements, et la date de départ (`since`) ;
- `daily` : une ligne par **jour** (jamais purgée) ;
- `datasets` : par jeu (`3d/Embryo-…`), ses vues, ses téléchargements, sa dernière consultation.

**Aucune adresse IP, aucun cookie, aucun identifiant de visiteur, aucun navigateur, aucun pays.** Le fichier est protégé des mises à jour (votre historique survit) et n'est jamais servi (il vit sous `api/`).

::: tech
- L'identifiant d'un jeu doit désigner un jeu qui **existe** : sinon la balise ne compte que globalement. Sans cette vérification, n'importe qui aurait pu ajouter des milliers de faux jeux au fichier.
- Les chiffres s'accumulent en mémoire et sont écrits **au plus toutes les 5 secondes**, à la lecture par l'administration et à l'arrêt du serveur ; l'écriture est atomique (un fichier temporaire remplace l'ancien).
:::

### Se protéger de la fraude : deux seaux à jetons

![Chaque balise coûte un jeton à deux seaux ; vide, elle reçoit 429.](img/ch16/limitation-debit.svg){width=86%}

::: analogy
**Un guichet à tickets.** Chaque visiteur a un petit carnet de 60 tickets, qui se recharge à raison d'un par seconde. Le guichet entier a un carnet de 600, rechargé de 20 par seconde. Sans ticket dans l'un ou l'autre, on n'est pas servi.
:::

L'adresse du visiteur sert **uniquement** à choisir un emplacement parmi 4 096 d'une table en mémoire (son empreinte SHA-256 est réduite à un numéro) ; elle n'est **ni écrite sur le disque, ni dans `stats.json`**. Même la table ne grandit jamais : deux adresses qui tombent sur le même emplacement repartent simplement d'un carnet neuf.

::: warning
Les compteurs ne gardent aucune donnée personnelle. Cela ne dit rien des **journaux d'accès** du serveur web lui-même (hébergeur, Apache…), qui peuvent contenir des adresses IP selon sa configuration : c'est à déclarer dans vos mentions légales (16.7).
:::

### Les lire

L'onglet [Statistiques]{.ui} présente trois cartes (avec le tracé des **30 derniers jours** dessiné à la main en SVG, sans bibliothèque de graphiques) et un tableau [Par dataset]{.ui} que l'on trie en cliquant un en-tête.

![L'onglet Statistiques (chiffres de test du jeu de démonstration).](img/ch16/stats.png){.shot width=78%}

::: legend
| n | ce que c'est |
|--|----------------------|
| 1 | **Visites** (ouvertures de l'accueil), avec la courbe des 30 derniers jours. |
| 2 | **Vues dataset** : l'indicateur le plus parlant. |
| 3 | **Téléchargements**. |
| 4 | Le détail par jeu : vues, téléchargements, dernière vue. Cliquez un en-tête pour trier. |
:::

Changer le **nom** d'un type de données ne change aucun de ces chiffres. Lors du passage à l'ancien vocabulaire des types, les compteurs des anciennes clés sont **additionnés** à ceux des nouvelles.

## 16.12 `PerfTelemetry` : le carnet de bord du viewer

À ne pas confondre avec les statistiques. **`PerfTelemetry`** est un chronomètre interne que le viewer remplit pour **diagnostiquer** ses performances.

![PerfTelemetry : un carnet de bord qui ne quitte jamais l'onglet.](img/ch16/perf-telemetrie.svg){width=86%}

::: remember
**Rien n'est envoyé nulle part.** Le carnet vit dans la mémoire de l'onglet, borné (3 000 durées, 5 000 événements, 500 mesures ouvertes à la fois), et disparaît quand l'onglet se ferme.
:::

### Ce que le viewer note

| Mesure | Ce qu'elle chronomètre |
|---------|------------------|
| `viewer.init` | l'ouverture de la page jusqu'au volume prêt |
| `viewer.timepoint.load` | le chargement d'un instant d'une série |
| `volume.load.bricks` | le chargement des briques d'une qualité |
| `texture.upload.prepare` | la préparation de la texture avant envoi à la carte graphique |
| `viewer.frame_time` | la fluidité : durée moyenne, médiane et 95ᵉ centile des images (toutes les 4 secondes, après 45 images) |
| `viewer.context_lost` / `restored` | une perte et une reprise du contexte graphique |

### Le lire

Dans la console du navigateur (F12) : `PerfTelemetry.getSummary()`. On obtient, **par opération**, le nombre d'occurrences, le minimum, la moyenne, le maximum, la médiane (p50) et le 95ᵉ centile (p95), plus les 80 derniers événements. C'est l'outil d'un développeur, pas d'un visiteur.

::: note
Seule la page du viewer charge `PerfTelemetry`. La ligne de progression que vous voyez en chargeant un volume (« 37 % — niveau 2 ») est une autre chose : un affichage, pas un journal.
:::

## 16.13 Récapitulatif

### Je veux… où dois-je aller ?

| Je veux… | J'utilise |
|-------------|-------------|
| changer le nom, l'organisation, le logo | [Identité]{.ui} |
| changer le mot « embryon » partout | [Identité]{.ui} › *Terminologie* |
| renommer « 3D », « 2D », « Live » | [Types de données]{.ui} |
| changer le vert du site, la police, les arrondis | [Apparence]{.ui} |
| modifier l'accueil, la page À propos | [Pages]{.ui} |
| créer une page « Protocoles » | [Pages]{.ui} › [Nouvelle page]{.ui} |
| rédiger les mentions légales | [Mentions légales]{.ui}, puis cocher la case dans [Identité]{.ui} |
| ajouter une langue | déposer `lang/<code>.json` |
| donner une couleur aux canaux d'après leur nom | `channelColorPresets` dans `instance.json` |
| savoir combien de personnes regardent mes données | [Statistiques]{.ui} |

### Les erreurs fréquentes, expliquées

| Constat | Explication |
|-----------|-------------|
| « Mon changement d'Apparence n'apparaît pas » | il n'est appliqué qu'après [Enregistrer]{.ui} ; videz le cache si le navigateur garde l'ancienne `theme.css` |
| « Le lien Mentions légales a disparu » | la case est décochée par défaut dans [Identité]{.ui} |
| « Mes liens de pied de page ne s'affichent pas » | voir 16.2 : ils sont enregistrés mais pas affichés |
| « Le néerlandais parle d'embryos » | la ligne **NL** de *Terminologie* est vide |
| « Ma page est sauvée mais invisible » | le brouillon est enregistré ; il faut [Publier]{.ui} |
| « L'éditeur dit que la page est ouverte ailleurs » | un autre onglet l'édite : reprenez la main ou fermez l'autre |

### Pour aller plus loin

::: see
- **Pas à pas** : Guide de l'administrateur, chapitres 6 (Types de données), 7 (Statistiques), 8 (Identité), 9 (Apparence), 10 (Pages), 11 (Mentions légales).
- **Les tests** qui verrouillent ce chapitre : `tests/js/test_build_lang_parity.mjs` (parité des langues), `tests/js/test_plugin_lang.mjs` (langues des plugins), `tests/test_dev_server_site.py` (magasin de configuration, marqueurs `{{SITE:…}}`, compilation du thème), `tests/js/test_admin_pages_save.mjs` (brouillon, révision, verrou), `tests/js/test_admin_branding_merge.mjs` (enregistrement par chemins), `tests/test_v3_minor_telemetry.py` (seaux à jetons).
- **La sécurité** de ces mécanismes (listes blanches, politique de sécurité du contenu, droits des fichiers) : chapitre 19. Les **plugins** et leurs langues : chapitre 15. Les **mises à jour** qui préservent `config/` : chapitre 18.
:::
