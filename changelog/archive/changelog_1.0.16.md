# Plateforme Web — v1.0.16

## [FIXED]
- **ELE-06 (SEC-008)** — **Subresource Integrity (SRI)** ajoutée à toutes les dépendances CDN versionnées dans les pages HTML (`integrity="sha384-…"` + `crossorigin="anonymous"`) : Lucide 0.344.0, Three.js 0.147.0 et 0.167.0 (+ OrbitControls, GLTFLoader), Plotly 2.27.0, OpenSeadragon 3.0.0. Hashes calculés sur les fichiers épinglés (immuables). Protège contre une altération CDN / compromission supply-chain. Le CSS Google Fonts est exclu (généré dynamiquement, SRI non applicable).
- Test : `tests/test_sri.py` — présence de l'intégrité sur tous les scripts CDN + **vérification réseau** que chaque hash correspond aux octets réellement servis par le CDN (skip gracieux hors-ligne).
