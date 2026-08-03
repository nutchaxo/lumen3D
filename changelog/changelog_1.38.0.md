# Changelog — Plateforme Web v1.38.0

## [ADDED]

### Le guide de l'administrateur en quatre langues

Le guide existait en français seulement. Il existe maintenant en **français, anglais, néerlandais et espagnol**, chacun avec **son propre jeu de 39 captures d'écran** — l'interface capturée dans la langue du guide, et les encadrés d'annotation composés dans cette langue avant la prise de vue.

**Livraison en deux formats**, comme demandé :

* **Quatre PDF séparés** (`pdf/GUIDE-ADMIN-{FR,EN,NL,ES}.pdf`, ~7,7 Mo chacun) — un fichier à envoyer par langue, sous la limite habituelle des pièces jointes.
* **Un PDF combiné** (`pdf/GUIDE-ADMIN-MULTI.pdf`, 247 pages) qui s'ouvre sur une **page de choix de langue** dont les quatre boutons sont des liens internes, doublée de **signets PDF** pour les lecteurs qui n'affichent pas la couverture. L'anglais est placé en premier : qui ignore la page de garde et fait défiler tombe dessus.

> Le format PDF n'a aucun mécanisme de détection de la langue du lecteur — pas d'équivalent d'`Accept-Language`. Les calques (OCG) permettraient un vrai basculement mais ne sont pilotables que dans Acrobat, pas dans Chrome, Edge, Firefox ni l'Aperçu macOS ; le JavaScript embarqué est ignoré par tous les navigateurs. La page de choix à liens internes est la seule approche qui fonctionne dans **tous** les lecteurs, et c'est celle retenue.

### Outillage

* `labels.py` — les 101 libellés d'annotation dans les quatre langues (404 chaînes), vérifiés complets.
* `capture.py` — un seul harnais paramétré par langue produit les 39 captures d'un jeu. Les onglets de l'éditeur sont désormais cliqués **par leur libellé traduit**, lu dans `lang/<code>.json`, et non par position : la barre latérale mélange onglets et fil d'Ariane, et les boutons masqués s'intercalent, donc un index devient faux dès qu'une sélection change.
* `build_pdf.py` — génère les cinq PDF. Dans l'édition combinée, chaque langue reçoit un préfixe d'identifiant de section pour que les quatre sommaires cliquables cohabitent sans collision d'ancres.

Les captures sont quantifiées sur palette adaptative quand l'écart au fichier d'origine reste imperceptible : 13,5 Mo → 5,0 Mo par jeu. Dans les PDF elles sont ramenées à 2150 px, ce qui reste au-delà de 300 DPI sur la largeur utile d'une A4.

## [FIXED]

* `GUIDE-ADMINISTRATEUR.pdf` à la racine du dossier est supprimé : il est remplacé par `pdf/GUIDE-ADMIN-FR.pdf`, au même titre que les trois autres langues.
* Le pied de page du guide français annonçait la version 1.34.0 ; il annonce la version courante, comme les trois autres.
