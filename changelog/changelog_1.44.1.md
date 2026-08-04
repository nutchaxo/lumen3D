# Changelog v1.44.1 (Plateforme Web)

## [FIXED]
* **« Verify » déclarait manquants les packs d'un timelapse entièrement transféré.** Un import de dataset `live` se terminait, annonçait « intégrité vérifiée » fichier par fichier, puis refusait la publication en listant `missing_pack:lod0/c0/pack_00.bin`, `lod1/c0/…`, `lod2/c0/…` — un par canal et par niveau de détail. Aucun de ces fichiers ne manquait.

  L'index `brickToPack` du manifeste donne des URL **relatives au dossier du timepoint** : `js/core/brick-loader.js` les résout contre `.../bricks/t007`, jamais contre `bricks/`. Le contrôle croisé, lui, résolvait `bricks/<url>` sans préfixe — il cherchait donc la disposition d'un dataset `fixed` à l'intérieur d'un timelapse, où les packs vivent sous `bricks/tNNN/`. Il parcourt maintenant les timepoints un par un en préfixant chaque index du `path` de sa frame, exactement comme le viewer.

  L'index à la racine du manifeste étant une **copie de celui de la première frame**, il n'est plus consulté que si le manifeste ne déclare aucun timepoint. Le réutiliser pour les autres frames inventerait des troncatures : chaque frame empaquette ses propres briques à ses propres offsets. Une frame qui n'indexe rien n'est donc l'objet d'aucune affirmation — ses fichiers restent couverts par leurs empreintes individuelles et par le contrôle des fichiers incomplets.

  Ce que le contrôle attrape reste intact et vérifié sur un vrai timelapse sorti du pipeline : un timepoint absent du disque, un pack tronqué, une traversée de chemin dans `path` comme dans `url`, et le chemin plat d'un dataset `fixed`. Les deux implémentations (`upload_staging.py` et le jumeau `api/_upload_lib.php`) rendent des verdicts identiques sur ces huit cas.
