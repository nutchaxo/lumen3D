# Plateforme Web v0.4.11

**Date :** 01 Juin 2026

### [FIXED]
- **Bug de rotation avec l'outil de mesure :** L'activation de l'outil de mesure ne bloque plus la rotation. Il est désormais possible de pivoter l'embryon 3D tout en plaçant des points (un simple clic pose un marqueur, tandis qu'un clic maintenu permet de faire tourner le modèle).
- **Synchronisation d'URL dans la vue Compare :** Résolution d'une *race condition* où la synchronisation périodique de l'URL écrasait prématurément le *workspace state* partagé si certains panneaux (iframes) n'étaient pas encore totalement chargés. La caméra et les mesures sont désormais restaurées parfaitement depuis le lien copié.
- **Mise à jour visuelle asynchrone :** L'application d'un état de caméra via URL force désormais systématiquement un rafraîchissement immédiat du rendu 3D, supprimant les décalages visuels à l'ouverture d'un fichier via un lien partagé.
