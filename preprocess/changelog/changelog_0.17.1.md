# Changelog v0.17.1 (Outil de Preprocessing)

## [ADDED]
* **Entrée `[3]` du lanceur du pack : import de photographies whole-mount.** `RUN.bat` demande le dossier des TIFF, la coloration (X-gal par défaut), la lignée (sinon lue dans le nom du `.lif`), s'il faut joindre l'original dans `download\` et s'il faut réimporter les datasets déjà présents (la curation est conservée), puis appelle `wholemount_importer.py`. Les anciens choix passent en `[4]` (rattacher un tracking) et `[5]` (vérifier l'environnement) ; le LISEZ-MOI du pack suit. L'importeur lui-même est inchangé.
