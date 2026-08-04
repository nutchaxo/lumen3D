# Changelog — Plateforme Web v1.42.5

## [OPTIMIZED]

### Les packs de bricks ne repartaient d'aucune consigne de cache

Un dataset natif, c'est ~650 Mo répartis sur une septantaine de fichiers `pack_NN.bin`. Ces fichiers ne portaient **aucun** en-tête `Cache-Control` : la règle de cache du `.htaccess` couvre `js|css|webp|png|woff2…` et met les `.json` en revalidation, mais l'extension `.bin` n'était dans aucune des deux listes.

Aucun en-tête ne veut pas dire « pas de cache » — cela veut dire que la décision revient au **cache heuristique** du navigateur, qui réutilise une réponse *sans rien revalider* pendant environ 10 % de son âge (une journée environ pour ces fichiers). C'était donc le pire des deux mondes : un comportement non déterministe, et un volume potentiellement périmé en silence après un re-prétraitement du dataset.

Un `max-age` long n'était pas la réponse non plus. Les URL de packs ne portent pas de `?v=` — le loader construit `…/bricks/lodN/cM/pack_KK.bin` à partir du manifeste — donc re-prétraiter un dataset sous le même nom aurait servi les **anciens** voxels pendant une semaine. Un volume à moitié à jour, c'est de la science silencieusement fausse (règle 1.1).

`no-cache` est le bon compromis : le corps de la réponse est conservé sur disque et réutilisé, mais uniquement après une requête conditionnelle à laquelle le serveur répond `304`. Une revisite coûte un aller-retour par pack au lieu de ~11 Mo, et un dataset re-prétraité est repris dès le chargement suivant (l'ETag change). La règle est posée sur `.bin`, `.rgba` et `.gz` — les trois transports de bricks.

Appliqué aux deux serveurs : le `.htaccess` racine (Apache, la production) et `dev_server.py` (`end_headers`), qui ne posait la consigne que pour `.json`/`.js`. Le jumeau Python utilise `no-cache` seul, et non le trio `no-store` des routes d'API : ces fichiers doivent être **stockés** puis revalidés, pas refusés.

**Mesuré dans le navigateur, et le résultat est partiel — il faut le savoir.** Revisite d'un même pack, en octets réellement transférés :

| Taille du pack | Revisite | En cache |
|---|---|---|
| 1,7 Mo (lod3) | 300 o | oui |
| 6,2 Mo (lod2) | 300 o | oui |
| 7,5 Mo | 7,5 Mo | **non** |
| 9,5 Mo | 9,5 Mo | **non** |
| 12,9 Mo (lod0) | 12,9 Mo | **non** |

L'en-tête fonctionne parfaitement — jusqu'à ~6,5 Mo. Au-delà, Chrome **refuse de stocker l'entrée** : sa limite par ressource vaut environ un huitième de la taille de son cache disque, soit ~6,5 Mo sur le profil testé. Aucun en-tête ne peut contourner cela ; c'est une limite de stockage, pas une question de politique.

Concrètement : les paliers d'aperçu (lod3, lod2) — ceux que tout le monde charge en ouvrant un dataset — ne se retéléchargent plus. Le natif et le palier 2048, dont les packs pèsent 10 à 13 Mo, restent retéléchargés intégralement à chaque visite.

Les rendre cachables suppose des packs plus petits, donc `CHUNKS_PER_PACK` (128 dans `preprocess/3-chunk_packer.py`, ce qui donne ces 10-13 Mo) ramené autour de 48 pour viser ~4 Mo — et un re-prétraitement de tous les datasets pour que cela s'applique à l'existant. Ce n'est pas fait ici.
