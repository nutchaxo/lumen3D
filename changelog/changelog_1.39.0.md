# Changelog — Plateforme Web v1.39.0

## [ADDED]

### Onglet Documentation — la bibliothèque de documents, servie depuis GitHub

Un douzième onglet dans le panneau : **Documentation**. Il liste les documents publiés dans le dossier `DOCS/` du dépôt, permet de les lire sans quitter le panneau et de les télécharger.

Les documents ne sont **pas** embarqués dans la release. Corriger un guide se résume à déposer un fichier dans `DOCS/` : toutes les installations le voient au chargement suivant, sans mise à jour de la plateforme ni redéploiement.

### La nomenclature porte les métadonnées

Aucun index à tenir à jour, aucun fichier de description : **le nom du fichier suffit**.

```
260803 - GUIDE-ADMIN - FR.pdf
└─┬──┘   └────┬────┘   └┬┘
  │           │         └── langue
  │           └──────────── identifiant, stable d'une version et d'une langue à l'autre
  └──────────────────────── date YYMMDD, c'est la version
```

* **La date** classe et versionne : la plus récente est proposée, les précédentes restent accessibles sous « Versions précédentes ». Les dates impossibles sont rejetées (`260899` n'est pas une date) plutôt que devinées.
* **L'identifiant** est ce qui fait que deux fichiers sont le même document. Les espaces sont admis (`PROCEDURE SAUVEGARDE`).
* **La langue** décide de ce qui s'ouvre : celle de l'interface, sinon l'anglais, sinon `MULTI`, sinon la première disponible — jamais un panneau vide parce qu'une traduction manque. Les cinq cas de repli sont vérifiés en navigateur.

Un fichier qui ne suit pas la règle est **signalé comme ignoré** dans le panneau, pas absorbé en silence : une faute de frappe se voit, au lieu de faire disparaître un document. `README.md` et les fichiers cachés font exception — le README documente justement la règle.

### Ce qui passe par le serveur, et pourquoi

Le catalogue (`docs_list`) et les fichiers eux-mêmes (`docs_download`) transitent par le serveur, jumeaux Python et PHP :

* `raw.githubusercontent` renvoie les documents en `octet-stream` : le navigateur les téléchargerait au lieu de les afficher ;
* un cadre vers une autre origine serait refusé par la CSP stricte ;
* le nom demandé est validé **contre la règle de nommage et contre le catalogue courant** : le relais ne peut pas servir à tirer un chemin arbitraire du dépôt à travers une session admin.

Le catalogue est mis en cache dix minutes (l'API GitHub non authentifiée autorise 60 appels par heure) ; le bouton **Actualiser** contourne le cache. La lecture se fait sur la branche `main` : un opérateur ne voit que des documents publiés, jamais un brouillon en cours.

### Affichage : la garantie est côté serveur

`docs_download` ne répond `inline` que pour `pdf`, `png`, `jpg`, `txt`, `md`, et sert le texte en `text/plain`. **HTML et SVG en sont volontairement exclus** : tous deux peuvent porter du script, et un document vient d'un dépôt — l'afficher sur notre origine le ferait tourner à côté de la session admin. Ces types se téléchargent, et le bouton « Lire » ne leur est pas proposé.

Le cadre d'aperçu n'est donc **pas** bacs-à-sablé : rien de ce qui peut l'atteindre ne s'exécute dans notre origine, et l'attribut `sandbox` aurait pu casser le lecteur PDF intégré du navigateur — c'est-à-dire la fonctionnalité elle-même. Vérifié en navigateur réel : le cadre est bien pris en charge par le lecteur PDF de Chrome (`contentType: application/pdf`, `pdf_embedder`). L'aperçu paraissait blanc en Chromium *headless* simplement parce que celui-ci n'embarque aucun lecteur PDF.

L'onglet est traduit dans les quatre langues (parité vérifiée : 1441 clés partout).

`DOCS/README.md` décrit la règle de nommage pour la personne qui publiera le prochain document ; `.gitignore` cesse d'ignorer `DOCS/*.pdf` et `DOCS/*.md`.
