# Changelog — Plateforme Web v1.42.0

## [FIXED]

### Le pack de traitement porte enfin sa propre version

Le pack téléchargé depuis l'onglet Pipeline s'appelait `lumen3d-pipeline-leger-1.41.0.zip`, alors que la plateforme annonçait partout ailleurs — onglet Mises à jour compris — un pipeline de préprocessing en **v0.15.0**. Deux numéros pour une seule chose, dont un forcément faux.

Le pack était nommé d'après la version de la **plateforme web**, qui n'a rien à voir avec ce qu'il contient. Or le pack *est* l'outil de preprocessing : il porte désormais la version de ce composant, `preprocess/run_preprocess.py:__version__`. Un pack construit aujourd'hui s'appelle `lumen3d-pipeline-leger-0.15.0.zip`, se décompresse dans un dossier du même nom, et affiche `pack v0.15.0` dans la bannière de `RUN.bat`. La version de la plateforme avec laquelle il a été livré reste inscrite dans son `VERSION.json` (`platformVersion`), pour la traçabilité.

Conséquence à traiter au passage : les deux lignes de version ne progressent plus ensemble, donc *choisir le pack le plus récent* ne peut plus se faire sur le nom de fichier — `0.15.0` succède à `1.41.0`. C'est un cas réel, pas théorique : sur un hébergement PHP, la mise à jour recopie la nouvelle version par-dessus l'arborescence sans effacer ce que la précédente y avait laissé, et les deux packs cohabitent. Le serveur choisit maintenant celui qui déclare *la version de plateforme installée ici*, puis le plus récemment écrit, et seulement en dernier recours le numéro du nom (`dev_server.py:_pipeline_local` et son jumeau `api/_admin_lib.php:admin_pipeline_local`, couverts par `tests/test_pipeline_pack.{py,php}`).

En dev, le pack est aussi reconstruit dès que sa version ne correspond plus aux sources du pipeline, au lieu de resservir l'archive de la veille. Et une construction ne laisse plus qu'un seul pack par édition dans son dossier de sortie.

## [OPTIMIZED]

### Onglet Pipeline : un schéma plutôt qu'une notice

La page tenait en trois cartes de texte — treize puces décrivant le contenu du pack, les deux éditions et la marche à suivre — qu'il fallait lire en entier pour prendre la seule décision qui compte : quelle édition télécharger.

Elle est maintenant schématique et tient dans un écran :

* **Le principe** en quatre cases reliées — fichiers bruts → `RUN.bat` → jeu de données → `DATA_WEB\` — suivies de trois pastilles pour ce que le pack embarque (deux pipelines, exemples, contrôle d'intégrité).
* **Le choix d'édition** posé en une phrase (« le poste a-t-il accès à internet ? »), puis deux fiches comparables ligne à ligne : taille, internet, Python. L'édition légère passe en premier et porte la marque *Recommandé*; la taille réelle du pack remplace l'estimation dès qu'elle est connue.
* **L'utilisation** en trois étapes numérotées, les contraintes de terrain (l'intervalle dans le nom du fichier Excel, la mémoire vive) réunies dans une note.

La version du pack est affichée là où elle se lit d'un coup d'œil — `pipeline v0.15.0` en tête de carte — avec la plateforme d'origine juste en dessous, pour que la question qui a mené à ce correctif ne se repose pas.

Textes complets en français, anglais, espagnol et néerlandais; l'unité de taille suit la langue (`Mo` / `MB`).
