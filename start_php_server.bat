@echo off
title Lumen3D - Serveur PHP (fermer cette fenetre arrete le serveur)
setlocal

set "PORT=8082"
set "ROOT=%~dp0"

:: Cherche php.exe dans le PATH, sinon retombe sur l'install portable connue
where php >nul 2>nul
if %errorlevel%==0 (
    set "PHP_EXE=php"
) else if exist "C:\php-portable\php.exe" (
    set "PHP_EXE=C:\php-portable\php.exe"
) else (
    echo [ERREUR] PHP introuvable ^(ni dans le PATH, ni dans C:\php-portable^).
    echo Installez PHP ou modifiez ce script pour pointer vers votre php.exe.
    pause
    exit /b 1
)

echo Lumen3D - serveur PHP
echo Racine du site : %ROOT%
echo Adresse        : http://localhost:%PORT%/
echo.
echo Fermez cette fenetre ^(ou Ctrl+C^) pour arreter le serveur.
echo.

:: Ouvre le navigateur sur la page d'accueil
start http://localhost:%PORT%/

:: Lance le serveur PHP au premier plan de cette console : le processus est
:: rattache a cette fenetre, donc la fermer (ou Ctrl+C) termine aussi le serveur.
"%PHP_EXE%" -S 127.0.0.1:%PORT% -t "%ROOT%." "%ROOT%router.php"

echo.
echo Serveur arrete.
pause
