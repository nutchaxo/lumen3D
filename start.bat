@echo off
echo Lancement du serveur web local...
echo Le site web va s'ouvrir dans votre navigateur par defaut.
echo Appuyez sur Ctrl+C dans cette fenetre pour arreter le serveur.
echo.

:: Ouvre le navigateur sur la page d'accueil
start http://localhost:8000

:: Lance le serveur web Python en utilisant l'environnement conda local
.conda\python.exe -m http.server 8000

pause
