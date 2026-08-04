# Changelog — Plateforme Web v1.41.1

## [FIXED]

### Le menu du pack de traitement affiche à nouveau ses deux premières entrées

Au lancement de `RUN.bat`, le menu final n'offrait plus que les choix `[3]`, `[4]` et `[0]` : les deux entrées principales — le préprocessing des volumes Imaris et l'analyse de tracking — étaient remplacées par deux lignes d'erreur Windows, « La syntaxe du nom de fichier, de répertoire ou de volume est incorrecte. » Les touches `1` et `2` restaient acceptées, mais plus rien ne disait qu'elles existaient, et le pack semblait cassé au premier écran.

Les deux lignes concernées décrivaient le trajet des données (`.ims -> output\`, `Excel -> tracking\OUTPUT\`). `cmd.exe` repère les redirections **avant** l'expansion retardée : le `>` de la flèche était lu comme un opérateur, la cible devenait le jeton suivant jusqu'à la parenthèse — `output\`, puis `tracking\OUTPUT\` — et un chemin terminé par une barre oblique inverse n'est pas un nom de fichier valide. L'ouverture échouait, donc l'`echo` entier était abandonné : d'où une erreur exactement là où la ligne aurait dû s'afficher.

Les flèches sont désormais échappées (`-^>`). Le menu retrouve ses cinq entrées, avec le même texte qu'auparavant. Correction dans le gabarit `tools/pipeline_bundle/RUN.bat.in`, donc dans le `RUN.bat` de chaque pack reconstruit — éditions légère et complète.
