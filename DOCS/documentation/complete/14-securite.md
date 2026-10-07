# 14. Sécurité et fiabilité

::: chapter-intro
- Lumen3D protège le panneau d'administration, le code exécuté dans les pages et les fichiers déposés. Chaque protection a une **raison simple**.
- Aucune donnée d'étude n'est envoyée à un tiers et la plateforme fonctionne **hors ligne**.
- La fiabilité repose sur des publications **tout ou rien** et sur une suite d'environ **200 fichiers de tests** qui bloque toute version défectueuse.
:::

## 14.1 Le mot de passe administrateur

Il n'existe **aucun mot de passe par défaut** : le premier visiteur du panneau crée le compte (8 caractères minimum), et cette création ne peut jamais écraser un compte existant.

![Du mot de passe à l'empreinte, et les protections contre les essais répétés.](img/ch14/mot-de-passe.svg){width=100%}

::: analogy
**Une empreinte digitale.** Le serveur garde l'empreinte de votre mot de passe, pas le mot de passe. Avec une empreinte on peut reconnaître la bonne personne, mais on ne peut pas refabriquer le doigt.
:::

- L'empreinte est calculée par **PBKDF2-HMAC-SHA256**, avec un sel propre au compte et 600 000 tours : volontairement lent pour décourager les essais en masse.
- Après **10 échecs** en 15 minutes depuis une même adresse, l'accès est bloqué 15 minutes. Les échecs sont comptés **avant** la vérification, et un mauvais identifiant coûte le même temps qu'un mauvais mot de passe.
- Une session dure **8 heures**. Changer le mot de passe ferme toutes les autres sessions.
- Toute modification passe aussi par un jeton anti-falsification (CSRF).

## 14.2 La politique de sécurité du contenu (CSP)

::: analogy
**Une liste d'invités à l'entrée.** À chaque chargement de page, le serveur tire un code secret (le « nonce ») et le remet aux scripts du site. Le navigateur ne laisse entrer que ceux qui le présentent.
:::

![Le nonce, une liste d'invités renouvelée à chaque chargement.](img/ch14/csp.svg){width=100%}

La politique est **appliquée** (et non simplement observée). Les bibliothèques (Three.js, Lucide, Plotly) sont hébergées par le site lui-même : aucun script ne vient d'ailleurs.

## 14.3 Les fichiers importés ne sont jamais servis

![Le trajet d'un fichier importé jusqu'à sa publication.](img/ch14/import-prive.svg){width=100%}

- Les fichiers arrivent dans `uploads/`, un dossier **inaccessible par URL** (quatre verrous indépendants).
- Une **liste blanche** refuse avant écriture tout ce que le pipeline ne produit pas : pas de `.php`, de `.js`, de fichier caché, de chemin remontant (`..`).
- Seule une **publication explicite**, après validation, déplace le dataset vers `DATA_WEB/`. Ce dossier interdit l'exécution de scripts.

## 14.4 Les plugins : confiance et cage

![Niveaux de confiance, approbation liée à une empreinte, bac à sable.](img/ch14/plugins.svg){width=100%}

::: why
Un plugin est du code. Le laisser entrer sans contrôle serait comme donner un double des clés à un inconnu. Par défaut, un plugin non reconnu **n'est pas chargé**.
:::

- Votre approbation est liée au **contenu exact** du plugin (empreinte) : modifié, il perd sa confiance.
- Un plugin déclare aussi avec quelles versions de la plateforme il est compatible : en cas de doute, il est écarté.

## 14.5 Versions et catalogue signés

::: analogy
**Un sceau de cire.** Seul l'éditeur possède le sceau (la clé privée). Tout le monde peut vérifier qu'une lettre le porte (clé publique), mais personne ne peut en fabriquer un faux.
:::

![La chaîne de confiance d'une mise à jour : signature, vérification, refus.](img/ch14/signatures.svg){width=100%}

- La signature est une **Ed25519**. La clé publique est **intégrée au code** du serveur : une clé fournie avec le téléchargement ne serait pas fiable.
- Une version sans signature valable est **refusée** : le programme de mise à jour n'applique que l'archive nommée d'après la version et listée dans la liste signée.
- Le catalogue de plugins a **sa propre clé** et un numéro de série croissant, pour qu'on ne puisse pas réinstaller une ancienne version corrigée depuis.

## 14.6 Vos données restent chez vous

- **Aucune donnée d'étude** n'est envoyée à un tiers.
- **Hors ligne** : tout le code est hébergé sur le serveur. Seules les polices Google Fonts sont chargées à distance. GitHub n'est contacté que par l'administrateur, pour vérifier les mises à jour.
- Les statistiques sont de simples compteurs (visites, vues, téléchargements), limités en débit côté serveur.

## 14.7 Fiabilité

| Risque | Protection |
|---|---|
| Une mise à jour casse le site | bascule vérifiée, retour automatique, sauvegarde préalable |
| Une publication s'interrompt | **tout ou rien** : le pipeline construit tout à l'écart et publie par un renommage ; une interruption est rattrapée au lancement suivant |
| Une coupure réseau pendant un import | reprise au bloc près |
| Une brique corrompue | signalée et ignorée, jamais envoyée à la carte graphique |
| Une régression dans le code | environ **200 fichiers de tests** doivent passer avant chaque version |

::: remember
Chaque version est **testée en entier** avant d'être signée et publiée. Une version qui échoue aux tests ne peut tout simplement pas sortir.
:::
