# Changelog v1.44.2 (Plateforme Web)

## [ADDED]
* **« Isoler le canal » est devenu un interrupteur.** Le bouton n'avait pas de retour : il éteignait tous les autres canaux et s'arrêtait là. Pour revoir l'ensemble il fallait rallumer chaque case à la main, une par une. Un deuxième appui sur le même bouton rétablit maintenant l'affichage.

  Ce qui est rétabli est l'état exact d'avant l'isolement, pas « tout allumé » : un canal que l'opérateur avait délibérément éteint — le bruité, le PMT en transmission — reste éteint en sortant du solo. Le cliché de visibilité n'est pris qu'au **premier** isolement : enchaîner solo canal 1 → solo canal 2 → sortie ramène la vue de départ, et non le canal 1 seul. Si plus rien n'était visible au moment de l'isolement, la sortie rallume tout plutôt que de rendre un écran noir.

  Toute modification manuelle d'une case pendant qu'un solo est actif périme le cliché : le solo se désarme, et l'appui suivant réisole à partir de la nouvelle vue. Charger un dataset ou restaurer un espace de travail le désarme aussi — les deux réécrivent chaque indicateur de visibilité.

  Le bouton se verrouille visuellement quand le solo est actif (fond actif, `aria-pressed`), sans quoi le second appui — celui qui ramène tout — n'a l'air de rien faire. Son infobulle bascule sur « Afficher tous les canaux » dans les quatre langues, clé i18n comprise, pour qu'un changement de langue ne la fige pas sur l'ancien libellé.
