# Changelog 0.8.2

[FIXED]
- Panneau Admin: Le viewer 3D de l'aperçu ne s'affiche plus "coincé" à 150px de hauteur en haut de l'écran. Le layout a été corrigé pour occuper tout l'espace disponible (correction de la propriété `display: flex`).
- Panneau Admin: Le viewer réussit maintenant à identifier correctement le dataset en cours d'édition (il ne retourne plus d'erreur "Dataset not found in the catalog") en utilisant le format d'identifiant correct (sans préfixe `fixed/` ou `live/`) pour interroger le catalogue et en utilisant le chemin original complet pour la solution de secours (fallback).
- Cache: Le paramètre de version dans `viewer.html` a été mis à jour pour s'assurer que les navigateurs téléchargent la dernière version de `viewer.js` au lieu d'utiliser le cache.
