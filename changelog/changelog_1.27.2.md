# Changelog v1.27.2 (Plateforme Web)

> Correctif urgent : la v1.27.1 empêchait **tout** dataset en bricks de se charger.

## [FIXED]
* **Le chargement de volume était cassé pour tous les datasets** (régression introduite en v1.27.1). Le cache de manifeste ajouté à cette version était déclaré **après le `return` de l'IIFE** de `volume-viewer.js`. Les déclarations de *fonction* y sont hissées — d'où l'absence d'erreur de syntaxe et un fichier qui parse — mais un `const` placé là **n'est jamais exécuté** : la liaison reste dans sa zone morte temporelle et la première lecture lève `Cannot access '_manifestCache' before initialization`.
  * Conséquence : `loadBrickedVolumeStream` échouait à chaque appel, le viewer repliait silencieusement sur une pile de slices qui n'existe pas pour ces datasets, et affichait « No volume slices could be loaded ». Cela touchait **les 15 datasets `fixed` autant que le dataset 4D**, puisque le cache est consulté pour tout dataset en bricks.
  * La déclaration rejoint l'état de module en tête d'IIFE, avec un commentaire expliquant le piège.

## [ADDED]
* **Garde-fou contre cette classe d'erreur** (`tests/test_no_tdz_after_iife_return.py`). Il scanne `js/{core,viewers,pages,components}` et échoue si un `const`/`let` de portée module apparaît entre le `return` d'une IIFE et sa fermeture. Le scan s'arrête à `})();` pour ne pas signaler le code de premier niveau qui suit. Vérifié dans les deux sens : il passe sur l'arbre corrigé, et il détecte bien la faute réintroduite volontairement.

## [NOTE]
La CI n'exécute pas la suite de tests (`.github/workflows/*.yml` ne lance que `check_version.py` et `dev_server.py --check`), donc ce garde-fou ne bloquera pas une publication tant que ce n'est pas branché. Une isolation défectueuse préexistante entre tests (`test_max_version_from_changelog` échoue en suite complète, passe seul) devra être corrigée d'abord.
