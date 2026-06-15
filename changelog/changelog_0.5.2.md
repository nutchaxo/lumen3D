# Plateforme Web v0.5.2 — 2026-06-04

## [OPTIMIZED] Filtre gaussien ~95% plus rapide (cache + Web Worker)

### Architecture avant (v0.5.1) — lente
```
Slider σ → 208 requêtes réseau (WebP) → décodage image → blur CPU (main thread) → copie texture
Temps : 20-60 secondes, UI gelée
```

### Architecture après (v0.5.2) — rapide
```
Chargement initial : slices → cache rawChannelData[] (pixels bruts mono-canal)
Slider σ → copie cache → transfert Web Worker (zero-copy) → blur CPU (thread séparé) → retour texture
Temps : 1-3 secondes, UI fluide (rendu 3D continu)
```

### Détails techniques

**Cache des données brutes (`rawChannelData`)**
- Lors du chargement du volume, chaque pixel décodé est sauvegardé dans un 
  buffer mono-canal `Uint8Array(width × height × depth)` par canal.
- Taille mémoire : ~(width × height × depth) octets par canal
  (ex: 1024×1024×104 = ~110 MB par canal en qualité high).
- Élimine 100% des requêtes réseau au changement de sigma.

**Web Worker (`js/workers/gaussian-blur-worker.js`)**
- Thread JavaScript séparé dédié au calcul du blur gaussien.
- Algorithme : 3 passes de box blur (moyenne glissante H/V), O(n) par pixel.
- Transfert zero-copy via `Transferable` (pas de sérialisation du buffer).
- Mécanisme `taskId` pour invalider les résultats obsolètes (changements rapides).
- Notification de progression toutes les 20 slices.

**Résultat**
- Le modèle 3D reste visible et interactif pendant le calcul du blur.
- Pas de flash noir, pas de gel de l'interface.
- Le résultat est écrit directement dans le buffer RGBA de la texture existante,
  puis `texture.needsUpdate = true` déclenche un upload GPU.

## [ADDED] Fichier `js/workers/gaussian-blur-worker.js`
- Worker autonome avec l'algorithme de blur gaussien complet.
- Fonctionne sur des données mono-canal (Float32 interne, Uint8 E/S).
