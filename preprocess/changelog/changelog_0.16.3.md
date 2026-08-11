# Changelog v0.16.3 (Outil de Preprocessing)

## [FIXED]
* **Un traitement qui échoue ne détruit plus le dataset qu'il était censé mettre à jour.** `run_preprocess.py` supprimait `bricks/` *avant* de lancer l'étape 2 — la plus longue et la plus gourmande. Toute erreur survenant ensuite laissait un dataset déjà publié sans aucune brique, sans retour possible.

  Constaté en conditions réelles sur `Egfl7eGFP-Em3-Decidua` : l'étape 2 s'est arrêtée au bloc 4 sur 32 du filtre médian sur `OSError [WinError 1455] — le fichier de pagination est insuffisant`, et le dataset s'est retrouvé vide. La cause n'avait rien à voir avec les données : la machine (63,5 Gio de RAM, limite de commit 89,6 Gio) n'avait que 36,3 Gio de commit libre, et le pool réclamait ~33 Gio d'un coup.

  Les briques existantes sont désormais **déplacées** vers `bricks.rollback/`, supprimées seulement une fois le traitement terminé avec succès, et **remises en place automatiquement** si quoi que ce soit échoue. Un jeu partiel laissé par une étape 3 interrompue est écarté au profit de l'ancien, qui lui est complet. Les deux chemins sont liés avant le `try` pour qu'une erreur dès l'étape 1 ne se transforme pas en `NameError` masquant l'erreur réelle.

## [OPTIMIZED]
* **La taille du pool de l'étape 2 est réglable.** `2-image_processor.py` lançait `ProcessPoolExecutor(max_workers=os.cpu_count())` en dur. Chaque worker alloue ses propres copies float32 d'un bloc Z et les temporaires de `scipy.median_filter` — de l'ordre du gigaoctet sur un grand champ. Sur une machine à 22 cœurs, en plus des trois blocs partagés couvrant le volume entier (float32 + masque booléen + sortie uint8), la demande de *commit* Windows atteint ~33 Gio simultanés. Or le commit est borné par RAM + fichier de pagination, pas par la RAM libre : une machine par ailleurs chargée échoue alors que `htop` semble tranquille.

  `LUMEN_PREPROCESS_WORKERS` plafonne le pool. Non définie, le comportement est **strictement inchangé** — un worker par cœur logique. À 8 workers, le même dataset qui échouait est passé en 900 s.

  ```bash
  LUMEN_PREPROCESS_WORKERS=8 python run_preprocess.py --input <dir> --output DATA_WEB --only "*Decidua*"
  ```

## [KNOWN]
* **Un repassage écrase la curation du `metadata.json`.** `4-catalog_generator.py` ne relit jamais le fichier existant : il en écrit un neuf depuis les métadonnées d'acquisition. Tout ce que le labo a réglé est perdu — noms de canaux, couleurs, gamma, min/max, canaux actifs, stade, embryon.

  Mesuré sur Decidua : les canaux `DAPI / GFP / Dextran / Pecam1` sont redevenus `DAPI / AF488 / R-Red / AF647`, DAPI est passé du bleu `#00AAFF` au vert `#00FF00`, Pecam1 du magenta au rouge, tous les gamma sont retombés à 1.0 et le stade est devenu « Unknown ». À l'écran, la couverture ne bouge pas (22,8 % contre 23,2 %) mais l'équilibre des couleurs est méconnaissable.

  La curation reste récupérable dans le `metadata.json` embarqué dans `download/<dataset>_web.zip` quand celui-ci existe (c'est le cas des 15 datasets publiés à ce jour), mais la restauration est manuelle. **Tant que ce point n'est pas corrigé, un repassage en masse du catalogue est déconseillé** : il faudrait restaurer chaque dataset à la main, et un dataset sans `_web.zip` serait perdu. Le correctif attendu est une fusion : conserver les champs curés d'un `metadata.json` présent et ne rafraîchir que ce que le pipeline possède réellement.
