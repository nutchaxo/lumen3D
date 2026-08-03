# Changelog — Plateforme Web v1.34.3

## [FIXED]

### Guide de l'administrateur — corrections issues de la relecture

* **Les réglages de canaux étaient donnés comme non enregistrés.** Le guide décrivait l'aperçu de l'onglet Datasets comme un bac à sable sans effet. C'est faux : `tab-datasets.js` écoute `SYNC_CHANNELS` et `SYNC_EXPOSURE`, reporte nom, couleur, min/max, gamma et visibilité de chaque canal dans le brouillon, marque la fiche modifiée, et **Sauvegarder** les écrit dans `metadata.json`. §3.2 rectifié — ce qui est repris, ce qui ne l'est pas, et pourquoi la pastille « Modifications non sauvegardées » peut apparaître sans qu'on croie avoir rien touché — et nouvelle **§3.4 « Configurer les canaux »** avec sa capture annotée. Chapitre 3 renuméroté.
* **Les mini-barres d'outils de l'éditeur** étaient décrites comme une barre unique à cinq icônes. Depuis v1.34.2 l'arbitrage donne la barre au bloc le plus intérieur sous le curseur, et chaque niveau a la sienne : élément (déplacer / dupliquer / supprimer), colonne (déplacer latéralement / réglages / dupliquer / supprimer), section (monter / descendre / ajouter une colonne / réglages / dupliquer / supprimer). §11.5 réécrit sur ces trois niveaux, avec le rappel que le fil d'Ariane évite d'avoir à viser la bonne zone de survol.
* **Capture de l'orientation** : le menu latéral du viewer recouvrait les repères A et D. Le panneau est replié avant la prise de vue et le cadrage suit le volume — les six repères A/P, D/V, L/R sont lisibles.
* **Capture de l'onglet Plugins** : les repères 1 et 2 figuraient dans la légende mais pas sur l'image. `.adm-card:nth-of-type(1)` ne désignait rien — `:nth-of-type` compte tous les frères de même balise, or un `<div>` d'en-tête précède les cartes. Sélection par index de correspondance à la place.
* **Capture d'une ligne de plugin** : la flèche du repère 3 traversait l'élément du repère 2, et les cadres posés sur des `<div>` pleine largeur n'indiquaient pas de quels mots il s'agissait. Libellés répartis sans croisement, cibles textuelles mesurées au `Range` plutôt qu'à la boîte de l'élément.
* **Captures de l'éditeur** (`editor-selected`, `editor-widget-toolbar`) refaites : elles montraient les deux barres superposées corrigées en v1.34.2.
* **Page blanche dans le PDF** : un `<hr>` placé juste avant un `<h1>` était renvoyé seul sur une page par le saut de page du titre. Masqué — le titre porte déjà son propre séparateur.

## [ADDED]

* **Identifiants saisissables directement dans le PDF.** L'emplacement réservé de §1.2 devient un vrai formulaire (deux champs AcroForm) : l'opérateur tape ses identifiants dans le document et l'enregistre, au lieu de l'imprimer pour les écrire à la main.
