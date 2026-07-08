# Changelog v0.12.44 — Migration de ChannelPanel & Render Mode (Phases 4 et 5)

## [ADDED]
- **Système modulaire des canaux** : L'interface du panneau des canaux (`channel-panel.js`) est désormais dynamiquement peuplée par les plugins enregistrés sous le placement `channels`.
- **Nouveau module `channels/histogram`** : Gère l'affichage de l'histogramme des intensités, l'édition des seuils (Min/Max/Gamma), les actions rapides (Auto, Soft, Contrast, Reset) et le filtre passe-haut ("Ignore low").
- **Nouveau module `channels/gaussian-filter`** : Isole la logique du slider de débruitage (Filtre gaussien σ) par canal.

## [OPTIMIZED]
- **Render Mode dynamique** : Les options de rendu (Fluorescence, Structure) sont désormais chargées de façon dynamique à partir des plugins shaders (via `PluginRegistry.listByPlacement('shaders')`) dans le `<select>` de la barre latérale.
- **Délégation d'état** : Les plugins UI des canaux partagent l'accès et les callbacks vers l'état interne (`_channels`, `_histograms`) de façon encapsulée via la méthode `bindChannelUI`.

## [FIXED]
- **Nettoyage de code hérité** : Confirmation de la suppression des anciennes fonctions codées en dur (`_renderHistogram`, `_bindHistogramDrag`, `_autoRangeFromHistogram`, `_clipHistogramForDisplay`, etc.) dans `channel-panel.js` pour éviter la redondance et finaliser le refactoring de la Phase 4.
