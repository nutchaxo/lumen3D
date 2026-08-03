# Changelog — Plateforme Web v1.38.1

## [FIXED]

### Guide de l'administrateur — trois défauts de mise en page dans les PDF

* **Couvertures débordant sur la page suivante.** `@page :first { margin: 0 }` ne s'applique qu'à la page 1. Dans l'édition combinée, les trois couvertures de langue suivantes héritaient donc des marges normales (16 mm + 18 mm), et leur bloc de 297 mm dépassait de 34 mm sur la page d'après — d'où la bande sombre et le « Version 1.36.0 » orphelins. Les couvertures utilisent maintenant une **page nommée** (`@page cover { margin: 0 }`), valable quelle que soit leur position.
* **`---` affiché en toutes lettres.** Le séparateur `---` suivi d'un second `---` n'est pas deux traits horizontaux : c'est un **titre setext** dont le texte est `---`. Python-Markdown le rendait donc en `<h2>---</h2>`. Les quatre guides passent à un seul `---`, forme non ambiguë qui donne le même résultat sur GitHub et dans le PDF.
* **Page ne contenant que la fin du sommaire.** Le sommaire dépassait de trois lignes en anglais et en espagnol. Il occupe désormais sa propre page : le résultat ne dépend plus de la longueur des intitulés, qui varie d'une langue à l'autre.

Une tentative intermédiaire masquait le trait précédant le sommaire avec `hr + h2.toc-head { display: none }` — ce sélecteur désigne le **titre**, pas le trait. Le titre « Sommaire » disparaissait, et avec lui son saut de page, puisqu'un élément en `display:none` ne génère aucune boîte. Corrigé en `hr:has(+ h2.toc-head)`.

### Contrôle automatique des pages

`check_pdf.py` parcourt les cinq PDF page par page et signale : pages blanches, pages quasi vides, débordement en bord de page, `---` littéral, titre orphelin en bas de page, image plus large que la colonne de texte.

La détection de débordement s'appuie sur les **pixels rendus**, pas sur `get_drawings()` : celui-ci renvoie les rectangles dans un repère non transformé et produisait quatre faux positifs par document sur des pages parfaitement correctes.

Résultat sur les 492 pages des cinq documents : **aucun défaut**.
