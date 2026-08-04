# Changelog — Plateforme Web v1.42.2

## [FIXED]

### Deux libellés du panneau restaient en français quelle que soit la langue

Un administrateur qui met le panneau en anglais, en espagnol ou en néerlandais y trouvait quand même du français à deux endroits. Ce ne sont pas des traductions manquantes : ce sont des textes qui ne passaient pas du tout par le système de traduction.

**Les étiquettes de confiance de l'onglet Plugins.** Le badge posé à côté du nom de chaque plugin — `intégré`, `dev`, `approuvé`, `sandbox`, `non fiable` — était écrit en dur dans le code de l'onglet, dans une table qui associait directement un tier à sa classe CSS et à son mot français. Le mot était affiché tel quel, sans passer par `t()`. Les cinq étiquettes deviennent des clés (`admin.trustBundled`, `admin.trustDev`, `admin.trustApproved`, `admin.trustSandbox`, `admin.trustUntrusted`), renseignées dans les quatre dictionnaires ; la table conserve le français comme valeur de repli, conformément à l'usage du panneau.

Les mots retenus sont **ceux du guide de l'administrateur**, langue par langue, pour que la documentation et l'écran disent la même chose : `bundled` / `approved` / `sandbox` / `untrusted` en anglais, `integrado` / `aprobado` / `no fiable` en espagnol, `ingebouwd` / `goedgekeurd` / `niet vertrouwd` en néerlandais. C'est le tableau du chapitre 5.4 qui fait référence — un opérateur qui lit « approved » dans le guide voit désormais « approved » dans le panneau.

**Le champ de recherche de la palette d'éléments.** L'éditeur de pages demandait bien sa traduction (`pages.searchWidgets`), mais la clé n'existait dans aucun des quatre fichiers de langue : les quatre langues retombaient donc sur la valeur de repli, qui est française. La clé est ajoutée partout, avec le libellé du chapitre 12.4 de chaque guide.

Vérification faite dans le panneau, sur les quatre langues : les cinq tiers de confiance s'affichent traduits, avec la classe CSS d'origine (l'étiquette « non fiable » reste rouge) et sans interrupteur sur un plugin non fiable. Parité des clés confirmée entre `en`, `fr`, `es` et `nl`.
