# Changelog v0.13.2 (Outil de Preprocessing)

## [ADDED]
* **Arrêt propre du pipeline sur Ctrl+C (`run_preprocess.py`)** — une interruption clavier ne tue plus brutalement le traitement : l'orchestrateur intercepte `SIGINT` et **demande confirmation** (`Arreter le pipeline en cours ? ... [o/N]`).
  * **Refus (`n` / Entrée)** : le traitement **reprend de façon transparente** — l'étape en cours n'a jamais reçu le signal (voir ci-dessous), aucune perte de progression.
  * **Confirmation (`o` / `oui` / `y`)** : l'étape Python en cours **et tout son pool de workers** sont arrêtés proprement (`taskkill /F /T` sous Windows, `killpg` sous POSIX), les dossiers temporaires `.temp_preprocess_*` sont nettoyés, et le programme sort avec le code **130**.
  * **Double Ctrl+C** (pendant l'invite) ou **stdin non interactif** : arrêt immédiat, sans rester bloqué sur la question.
* **Relais dans le lanceur `run_preprocess.bat`** — message dédié quand le pipeline renvoie le code 130 (« Pipeline interrompu par l'utilisateur (Ctrl+C). Etat nettoye. ») et rappel avant lancement qu'une confirmation sera demandée.

## [OPTIMIZED]
* **Isolation des étapes en groupe de processus dédié** — chaque étape est lancée via `subprocess.Popen` avec `CREATE_NEW_PROCESS_GROUP` (Windows) / `start_new_session=True` (POSIX). Le Ctrl+C de la console n'est donc **pas** délivré directement à l'enfant : c'est l'orchestrateur qui décide de le laisser tourner (reprise) ou de le démanteler (confirmation), ce qui rend la reprise réellement sûre.
* **Boucle de traitement séquentialisée** — le `ThreadPoolExecutor(max_workers=1)` (séquentiel par définition, mais opaque à la gestion de signal) est remplacé par une boucle directe sur le thread principal. Sémantique inchangée (un dataset à la fois, parallélisme conservé *à l'intérieur* de chaque étape), mais `SIGINT` est désormais traité de manière déterministe.

## [VERIFIED]
* Tests unitaires des mécaniques d'arrêt (14/14) : `_kill_tree` supprime bien l'étape **et ses 3 workers `ProcessPoolExecutor`** ; la logique de confirmation couvre `o`/`oui`/`y`/` O `/`n`/vide/EOF ; `main()` sort en 130 et purge les `.temp_preprocess_*` résiduels. Câblage `SIGINT → handler` validé par `raise_signal` réel (reprise sans exception sur refus, `KeyboardInterrupt` sur confirmation). Branche `else if` du `.bat` validée pour les codes 0 / 130 / autre.
