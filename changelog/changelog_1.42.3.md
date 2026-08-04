# Changelog — Plateforme Web v1.42.3

## [FIXED]

### La couverture des guides annonçait une version vieille de six crans

Le contenu des quatre guides était à jour de la v1.42.0, mais la page de garde affichait encore « Version 1.36.0 de la plateforme ». Le numéro n'est pas lu dans le document : il est posé par le générateur de PDF, qui n'avait pas suivi. Un lecteur ouvrant le fichier voyait donc un document daté d'avant les onglets Documentation et Pipeline qu'il décrit pourtant.

Les cinq PDF sont régénérés. La couverture annonce la bonne version dans les quatre langues, et la ligne de pied de document, qui elle était correcte, dit maintenant la même chose que la couverture.

### Le guide espagnol employait un vocabulaire que le panneau n'utilise pas

Trois formulations de l'édition espagnole ne correspondaient à aucune chaîne de l'écran : le champ **Nombre para mostrar** y était appelé « Nombre de visualización », le niveau de confiance **sandbox** était traduit en « aislado », et le message qui refuse la désactivation du dernier mode de rendu était cité dans un ordre de mots différent du vrai.

Le texte reprend les chaînes réelles de l'interface. Un opérateur hispanophone cherche à l'écran le mot qu'il vient de lire.

Les cinq documents publiés dans `DOCS/` sous le tampon `260804` sont remplacés par ces versions corrigées — même date, donc même version : c'est une correction, pas une nouvelle édition.

## [OPTIMIZED]

### Les contrôles automatiques repassent sur la totalité

531 pages auditées, aucun défaut de mise en page. Les quatre éditions passent le contrôle structurel : numérotation des chapitres, ancres de sommaire, images présentes, renvois valides. Les champs identifiant et mot de passe du PDF multilingue restent partagés — quatre emplacements, un seul champ : ce qu'on saisit dans la section anglaise apparaît dans les trois autres.
