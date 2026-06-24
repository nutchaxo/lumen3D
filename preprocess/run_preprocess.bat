@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title IRIBHM - Pipeline de Preprocessing

rem ============================================================================
rem  Lanceur interactif du pipeline de preprocessing IRIBHM / Lumen3D
rem  - Demande les dossiers d'entree/sortie et un filtre optionnel
rem  - Detecte automatiquement un interpreteur Python 3 (py / python / python3)
rem  - Verifie les dependances et propose de les installer au besoin
rem  - Aucun chemin absolu : tout est relatif a l'emplacement de ce .bat
rem ============================================================================

set "RC=0"

rem --- Dossier de ce script (sans backslash final) ---
set "PREP_DIR=%~dp0"
if "%PREP_DIR:~-1%"=="\" set "PREP_DIR=%PREP_DIR:~0,-1%"

set "PIPELINE=%PREP_DIR%\run_preprocess.py"
if not exist "%PIPELINE%" (
    echo [ERREUR] Introuvable : %PIPELINE%
    echo Placez ce .bat dans le dossier "preprocess", a cote de run_preprocess.py.
    goto :fail
)

echo ============================================================================
echo   IRIBHM Microscopy - Pipeline de Preprocessing
echo ============================================================================
echo.

rem --- [1/4] Detection d'un interpreteur Python 3 ---
echo [1/4] Recherche d'un interpreteur Python 3...
set "PY="
for %%C in (1 2 3 4) do (
    if "%%C"=="1" set "CAND=py -3"
    if "%%C"=="2" set "CAND=python"
    if "%%C"=="3" set "CAND=python3"
    if "%%C"=="4" set "CAND=py"
    if not defined PY (
        !CAND! -c "import sys; sys.exit(0 if sys.version_info[0]==3 else 1)" >nul 2>&1
        if !errorlevel! equ 0 set "PY=!CAND!"
    )
)
if not defined PY (
    echo [ERREUR] Aucun interpreteur Python 3 trouve dans le PATH.
    echo Installez Python 3 depuis https://www.python.org/ puis relancez ce script.
    goto :fail
)
for /f "tokens=*" %%V in ('%PY% --version 2^>^&1') do set "PYVER=%%V"
echo       OK : %PY%  ^(!PYVER!^)
echo.

rem --- [2/4] Verification des dependances ---
echo [2/4] Verification des dependances Python...
%PY% -c "import numpy, PIL, h5py, scipy, tqdm" >nul 2>&1
if errorlevel 1 (
    echo       Des modules requis sont manquants ^(numpy, Pillow, h5py, scipy, tqdm^).
    set "DOINSTALL="
    set /p "DOINSTALL=      Les installer maintenant via pip ? [O/n] "
    if /i "!DOINSTALL!"=="n" (
        echo [ERREUR] Dependances manquantes, abandon.
        goto :fail
    )
    echo       Installation en cours...
    %PY% -m pip install numpy Pillow h5py scipy tqdm
    if errorlevel 1 (
        echo [ERREUR] L'installation des dependances a echoue.
        echo Essayez manuellement : %PY% -m pip install -r "%PREP_DIR%\requirements.txt"
        goto :fail
    )
    %PY% -c "import numpy, PIL, h5py, scipy, tqdm" >nul 2>&1
    if errorlevel 1 (
        echo [ERREUR] Les dependances restent introuvables apres installation.
        goto :fail
    )
)
echo       OK : toutes les dependances sont presentes.
echo.

rem --- [3/4] Saisie des parametres ---
echo [3/4] Parametres du traitement
echo.

rem Dossier d'entree (.ims) - obligatoire et doit exister
:ask_input
set "INPUT="
set /p "INPUT=  Dossier contenant les fichiers .ims : "
if not defined INPUT (
    echo   ^> Veuillez saisir un dossier.
    goto :ask_input
)
rem Retrait des guillemets eventuels (chemin colle depuis le menu "Copier en tant que chemin").
rem Pas de guillemets autour du set, sinon le " recherche casse l'analyse ; on ne le
rem fait qu'une fois la variable definie (sur une variable vide, !VAR:"=! renvoie "=).
set INPUT=!INPUT:"=!
if not exist "!INPUT!\" (
    echo   ^> Dossier introuvable : !INPUT!
    goto :ask_input
)

rem Comptage rapide des .ims presents
set "IMSCOUNT=0"
for %%F in ("!INPUT!\*.ims") do set /a IMSCOUNT+=1
if "!IMSCOUNT!"=="0" (
    echo   ^> Attention : aucun fichier .ims detecte dans ce dossier.
    set "CONFIRMEMPTY="
    set /p "CONFIRMEMPTY=  Continuer quand meme ? [o/N] "
    if /i not "!CONFIRMEMPTY!"=="o" goto :ask_input
) else (
    echo   ^> !IMSCOUNT! fichier^(s^) .ims detecte^(s^).
)
echo.

rem Dossier de sortie (DATA_WEB) - defaut relatif au depot
for %%I in ("%PREP_DIR%\..\DATA_WEB") do set "DEFAULT_OUT=%%~fI"
set "OUTPUT="
set /p "OUTPUT=  Dossier de sortie DATA_WEB [Entree = !DEFAULT_OUT!] : "
if defined OUTPUT set OUTPUT=!OUTPUT:"=!
if not defined OUTPUT set "OUTPUT=!DEFAULT_OUT!"
echo.

rem Filtre optionnel (glob applique aux noms de fichiers)
set "FILTER="
set /p "FILTER=  Filtre optionnel (glob, ex: *E8* ) [Entree = tous] : "
if defined FILTER set FILTER=!FILTER:"=!
echo.

rem --- Recapitulatif avant lancement ---
echo ============================================================================
echo   Recapitulatif
echo ----------------------------------------------------------------------------
echo   Python  : %PY%
echo   Entree  : !INPUT!
echo   Sortie  : !OUTPUT!
if defined FILTER (
    echo   Filtre  : !FILTER!
) else (
    echo   Filtre  : tous les fichiers
)
echo ============================================================================
set "GO="
set /p "GO=  Lancer le traitement ? [O/n] "
if /i "!GO!"=="n" (
    echo Abandon a la demande de l'utilisateur.
    goto :end
)
echo.

rem --- [4/4] Execution du pipeline ---
echo [4/4] Execution du pipeline...
echo.
rem Sortie non bufferisee + UTF-8 pour une progression propre en temps reel
set "PYTHONUNBUFFERED=1"
set "PYTHONIOENCODING=utf-8"

if defined FILTER (
    %PY% "%PIPELINE%" --input "!INPUT!" --output "!OUTPUT!" --only "!FILTER!"
) else (
    %PY% "%PIPELINE%" --input "!INPUT!" --output "!OUTPUT!"
)
set "RC=!errorlevel!"

echo.
echo ============================================================================
if "!RC!"=="0" (
    echo   Traitement termine avec succes.
) else (
    echo   Le pipeline s'est termine avec le code d'erreur !RC!.
)
echo ============================================================================
goto :end

:fail
set "RC=1"

:end
echo.
pause
endlocal & exit /b %RC%
