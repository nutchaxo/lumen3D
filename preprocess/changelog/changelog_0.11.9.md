# Changelog - Outil de Preprocessing

## v0.11.9

### [OPTIMIZED]
- **Deep Learning Early Stopping :** Le modèle Noise2Void (N2V) ne s'entraîne plus sur un nombre fixe de 100 époques. Il implémente désormais un système complet de "Early Stopping" avec une `patience` de 10 époques et un `min_delta` de 1e-6. Si la Log Loss de validation sur les pixels masqués se stabilise, l'entraînement s'interrompt prématurément. Cela évite le sur-apprentissage (overfitting) et accélère drastiquement le pipeline si le modèle converge très vite.
