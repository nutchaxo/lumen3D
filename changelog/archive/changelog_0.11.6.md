## v0.11.6

### [ADDED]
- Nouveau pipeline de preprocessing biologique haute qualité :
  - **Étape 1 : Débruitage SOTA** via la transformée de stabilisation de la variance d'Anscombe ($2\sqrt{x + 3/8}$) suivie d'un filtrage par ondelettes (`skimage.restoration.denoise_wavelet`) et d'une transformée d'Anscombe inverse. Cette méthode élimine le bruit de photons (Poisson) tout en conservant la netteté des structures biologiques et des contours.
  - **Étape 2 : Correction de fond BaSiC** monocanal, estimant et soustrayant le *Dark-field* (projection minimale lissée par filtre Gaussien de $\sigma = 50.0$) et corrigeant le *Flat-field* (projection médiane lissée par filtre Gaussien de $\sigma = 50.0$ après soustraction du dark-field).
  - **Étape 3 : Masque "Anti-Trous"** calculé par un seuillage global d'Otsu sur le signal non nul, suivi d'un remplissage de cavités topologiques slice par slice (`scipy.ndimage.binary_fill_holes`) et d'une fermeture morphologique (`scipy.ndimage.binary_closing` avec un élément structurant de $5 \times 5$).
  - **Étape 4 : Multiplication matricielle** et normalisation dynamique robuste entre les percentiles [0.1%, 99.9%] des pixels masqués non nuls pour un étirement optimal sur 8-bits.
- Ajout de `PyWavelets>=1.4.0` au fichier `requirements.txt`.
