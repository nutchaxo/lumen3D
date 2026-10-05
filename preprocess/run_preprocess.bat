@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title IRIBHM - Pipeline de Preprocessing

rem #############################################################################
rem #  LANCEUR AUTONOME DU PIPELINE DE PREPROCESSING IRIBHM / Lumen3D
rem #  Fichier .bat auto-suffisant : il embarque les scripts Python du pipeline,
rem #  detecte (ou installe localement) un Python utilisable, installe les
rem #  dependances, puis lance le traitement. Aucun chemin absolu, tout est
rem #  relatif au dossier de ce .bat.
rem #
rem #  GENERE automatiquement par build_launcher.py -- NE PAS editer a la main :
rem #  modifiez les .py / le template puis relancez le generateur.
rem #############################################################################

rem ===== Configuration (injectee par le generateur) ===========================
set "PP_VERSION=0.19.0"
set "PY_VERSION=3.12.8"
set "SCRIPTS=run_preprocess.py 1-ims_metadata.py 2-image_processor.py 3-chunk_packer.py 4-catalog_generator.py 2d_importer.py 5-tracking_importer.py tracking_sources.py"
set "ENTRY=run_preprocess.py"
set "REQUIRED_DEPS=numpy==2.5.1 Pillow==11.1.0 h5py==3.16.0 scipy==1.16.0 tqdm==4.67.1"
set "IMPORT_CHECK=import numpy, PIL, h5py, scipy, tqdm"
set "PY_URL=https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip"
set "GETPIP_URL=https://bootstrap.pypa.io/get-pip.py"

rem ===== Couleurs ANSI (capture du caractere ESC 0x1B) ========================
for /f %%a in ('echo prompt $E ^| cmd') do set "E=%%a"
set "R=!E![0m"
set "TITLE=!E![1;96m"
set "ACC=!E![96m"
set "OK=!E![92m"
set "ERR=!E![91m"
set "WARN=!E![93m"
set "DIM=!E![90m"
set "BOLD=!E![1m"

rem ===== Chemins (relatifs au .bat) ===========================================
set "BATDIR=%~dp0"
if "!BATDIR:~-1!"=="\" set "BATDIR=!BATDIR:~0,-1!"
set "WORK=!BATDIR!"
set "RUNTIME=!BATDIR!\.runtime"
set "PYDIR=!RUNTIME!\python"
set "LOCALPY=!PYDIR!\python.exe"

set "PY="
set "RC=0"
set "FORCE_LOCAL="
set "FORCE_EXTRACT="
set "MODE=run"

rem ===== Analyse des arguments ================================================
:parse_args
if "%~1"=="" goto :after_args
if /i "%~1"=="--check"       set "MODE=check"        & shift & goto :parse_args
if /i "%~1"=="--force-local" set "FORCE_LOCAL=1"     & shift & goto :parse_args
if /i "%~1"=="--extract" (
    set "MODE=extract"
    set "FORCE_EXTRACT=1"
    if not "%~2"=="" set "WORK=%~2"
    shift & shift & goto :parse_args
)
if /i "%~1"=="--help"  goto :show_help
if /i "%~1"=="-h"      goto :show_help
echo Argument inconnu : %~1
goto :show_help
:after_args

call :banner

rem ===== Mode extraction seule ================================================
if "!MODE!"=="extract" (
    call :ensure_scripts
    if errorlevel 1 goto :fatal
    echo.
    echo !OK!Scripts extraits dans!R! !WORK!
    goto :end
)

rem ===== [1/5] Scripts du pipeline ============================================
call :step 1 5 "Scripts du pipeline"
call :ensure_scripts
if errorlevel 1 goto :fatal

rem ===== [2/5] Environnement Python ===========================================
call :step 2 5 "Environnement Python"
call :ensure_python
if errorlevel 1 goto :fatal

rem ===== [3/5] Dependances Python =============================================
call :step 3 5 "Dependances Python"
call :ensure_deps
if errorlevel 1 goto :fatal

if "!MODE!"=="check" (
    echo.
    echo !OK!Environnement pret.!R! Python : !DIM!!PY!!R!
    goto :end
)

rem ===== [4/5] Parametres =====================================================
call :step 4 5 "Parametres du traitement"
call :ask_params
if errorlevel 2 goto :end
if errorlevel 1 goto :fatal

rem ===== [5/5] Execution ======================================================
call :step 5 5 "Execution du pipeline"
call :run_pipeline
goto :end


rem ############################################################################
rem #  SOUS-ROUTINES
rem ############################################################################

:banner
echo.
echo !TITLE!================================================================================!R!
echo !TITLE!   IRIBHM MICROSCOPY  ^|  Pipeline de Preprocessing  ^|  v!PP_VERSION!!R!
echo !TITLE!================================================================================!R!
exit /b 0

:step
rem %~1 = numero, %~2 = total, %~3 = titre
echo.
echo !ACC![%~1/%~2]!R! !BOLD!%~3!R!
echo !DIM!--------------------------------------------------------------------------------!R!
exit /b 0

:ok
echo    !OK![OK]!R! %~1
exit /b 0

:info
echo    !DIM!-!R!  %~1
exit /b 0

:warnmsg
echo    !WARN![*]!R! %~1
exit /b 0

:errmsg
echo    !ERR![X]!R! %~1
exit /b 0


rem ---- Verifie/extrait les scripts du pipeline (par nom seulement) -----------
:ensure_scripts
set "_idx=-1"
set "_fail=0"
for %%S in (!SCRIPTS!) do (
    set /a "_idx+=1"
    set "_dst=!WORK!\%%S"
    if exist "!_dst!" if not "!FORCE_EXTRACT!"=="1" (
        call :info "%%S !DIM!(present, conserve)!R!"
        set "_skip=1"
    )
    if not "!_skip!"=="1" (
        call :extract !_idx! "!_dst!"
        if exist "!_dst!" (
            call :ok "%%S !DIM!(extrait)!R!"
        ) else (
            call :errmsg "%%S : extraction impossible"
            set "_fail=1"
        )
    )
    set "_skip="
)
if "!_fail!"=="1" exit /b 1
call :ensure_download_script
exit /b 0

rem ---- build_download_bundles.py : tools/ du depot, sinon extraction (dernier bloc)
:ensure_download_script
if not "!FORCE_EXTRACT!"=="1" (
    if exist "!BATDIR!\..\tools\build_download_bundles.py" (
        call :info "build_download_bundles.py !DIM!(tools/, conserve)!R!"
        exit /b 0
    )
    if exist "!WORK!\build_download_bundles.py" (
        call :info "build_download_bundles.py !DIM!(present, conserve)!R!"
        exit /b 0
    )
)
call :extract 8 "!WORK!\build_download_bundles.py"
if exist "!WORK!\build_download_bundles.py" (
    call :ok "build_download_bundles.py !DIM!(extrait)!R!"
) else (
    call :warnmsg "build_download_bundles.py indisponible (option download/ desactivee)."
)
exit /b 0

rem ---- Decode un bloc base64 embarque (index %~1) vers le fichier %~2 --------
:extract
set "_b64=%TEMP%\_iribhm_extract_%~1.b64"
if exist "!_b64!" del "!_b64!" >nul 2>&1
> "!_b64!" (
    for /f "usebackq tokens=1* delims=#" %%a in (`findstr /b /c:"#%~1#" "%~f0"`) do echo(%%b
)
certutil -decode "!_b64!" "%~2" >nul 2>&1
del "!_b64!" >nul 2>&1
exit /b 0


rem ---- Garantit un Python 3 utilisable (PY) ---------------------------------
:ensure_python
rem 1) runtime local deja installe ?
if exist "!LOCALPY!" (
    call :py_works "!LOCALPY!"
    if not errorlevel 1 (
        set PY="!LOCALPY!"
        call :ok "Python local : !DIM!!LOCALPY!!R!"
        exit /b 0
    )
)
rem 2) Python systeme (sauf si --force-local)
if not "!FORCE_LOCAL!"=="1" (
    for %%C in ("py -3" "python" "python3" "py") do (
        if not defined PY (
            call :py_works %%~C
            if not errorlevel 1 set "PY=%%~C"
        )
    )
    if defined PY (
        for /f "tokens=*" %%V in ('!PY! --version 2^>^&1') do set "PYVER=%%V"
        call :ok "Python systeme : !DIM!!PY! (!PYVER!)!R!"
        exit /b 0
    )
)
rem 3) aucun Python : proposer l'installation locale
call :warnmsg "Aucun Python utilisable trouve sur ce poste."
call :info "Un Python !PY_VERSION! autonome peut etre installe ici :"
echo        !DIM!!PYDIR!!R!
set "_ans="
set /p "_ans=   Telecharger et installer ce Python local ? [O/n] "
if /i "!_ans!"=="n" (
    call :errmsg "Python requis : operation annulee."
    exit /b 1
)
call :install_python
if errorlevel 1 exit /b 1
set PY="!LOCALPY!"
call :ok "Python local installe : !DIM!!LOCALPY!!R!"
exit /b 0

rem ---- Teste qu'une invocation est bien un Python 3 -------------------------
:py_works
%* -c "import sys; sys.exit(0 if sys.version_info[0]==3 else 1)" >nul 2>&1
exit /b !errorlevel!

rem ---- Telecharge + installe un Python embarquable local + pip --------------
:install_python
if not exist "!RUNTIME!" mkdir "!RUNTIME!" >nul 2>&1
if not exist "!PYDIR!"   mkdir "!PYDIR!"   >nul 2>&1
set "_zip=!RUNTIME!\python-embed.zip"
call :info "Telechargement de Python !PY_VERSION!..."
curl -L --fail -o "!_zip!" "!PY_URL!"
if errorlevel 1 (
    call :errmsg "Echec du telechargement de Python."
    exit /b 1
)
call :info "Extraction..."
tar -xf "!_zip!" -C "!PYDIR!" >nul 2>&1
if errorlevel 1 (
    powershell -NoProfile -Command "Expand-Archive -Force -LiteralPath '!_zip!' -DestinationPath '!PYDIR!'" >nul 2>&1
)
del "!_zip!" >nul 2>&1
if not exist "!LOCALPY!" (
    call :errmsg "Extraction de Python invalide."
    exit /b 1
)
rem Activer les site-packages (decommenter 'import site' dans le fichier ._pth)
for %%P in ("!PYDIR!\python*._pth") do (
    powershell -NoProfile -Command "$f='%%~fP'; (Get-Content -LiteralPath $f) -replace '^\s*#\s*import\s+site','import site' | Set-Content -LiteralPath $f" >nul 2>&1
)
rem Amorcer pip
set "_getpip=!RUNTIME!\get-pip.py"
call :info "Installation de pip..."
curl -L --fail -o "!_getpip!" "!GETPIP_URL!"
if errorlevel 1 (
    call :errmsg "Echec du telechargement de get-pip.py."
    exit /b 1
)
"!LOCALPY!" "!_getpip!" --no-warn-script-location
set "_piprc=!errorlevel!"
del "!_getpip!" >nul 2>&1
if not "!_piprc!"=="0" (
    call :errmsg "Echec de l'installation de pip."
    exit /b 1
)
exit /b 0


rem ---- Garantit les dependances Python --------------------------------------
:ensure_deps
%PY% -c "!IMPORT_CHECK!" >nul 2>&1
if not errorlevel 1 (
    call :ok "Dependances presentes : !DIM!!REQUIRED_DEPS!!R!"
    exit /b 0
)
call :warnmsg "Dependances manquantes : !REQUIRED_DEPS!"
rem S'assurer que pip est disponible
%PY% -m pip --version >nul 2>&1
if errorlevel 1 %PY% -m ensurepip --default-pip >nul 2>&1
set "_ans="
set /p "_ans=   Installer les dependances maintenant ? [O/n] "
if /i "!_ans!"=="n" (
    call :errmsg "Dependances requises : operation annulee."
    exit /b 1
)
call :info "Installation (cela peut prendre quelques minutes)..."
%PY% -m pip install --no-warn-script-location !REQUIRED_DEPS!
if errorlevel 1 (
    call :errmsg "Echec de l'installation des dependances."
    exit /b 1
)
%PY% -c "!IMPORT_CHECK!" >nul 2>&1
if errorlevel 1 (
    call :errmsg "Dependances toujours introuvables apres installation."
    exit /b 1
)
call :ok "Dependances installees."
exit /b 0

rem ---- Dependance optionnelle pour download/ : tifffile (TIFF ImageJ) -------
:ensure_tifffile
%PY% -c "import tifffile" >nul 2>&1
if not errorlevel 1 exit /b 0
call :info "Dependance download/ manquante : tifffile (installation)..."
%PY% -m pip install --no-warn-script-location tifffile >nul 2>&1
%PY% -c "import tifffile" >nul 2>&1
if errorlevel 1 call :warnmsg "tifffile indisponible : le TIFF pourrait echouer."
exit /b 0


rem ---- Saisie des parametres -------------------------------------------------
rem  Deux chaines distinctes : les volumes passent par run_preprocess.py (briques,
rem  LOD, tracking), les photographies par 2d_importer.py -- une image, rien a
rem  decouper. Les deux scripts sont embarques dans ce .bat.
:ask_params
echo.
echo      !ACC![1]!R! Volumes Imaris    !DIM!(.ims, dossier 3d\ ou live\)!R!
echo      !ACC![2]!R! Photographies 2D  !DIM!(.tif, dossier 2d\)!R!
echo.
set "MODE=volumes"
set "_ans="
set /p "_ans=   Type de donnees [1] : "
if "!_ans!"=="2" set "MODE=2d"
if "!MODE!"=="2d" goto :ask_2d

:ask_input
echo.
set "INPUT="
set /p "INPUT=   Dossier des fichiers .ims : "
if not defined INPUT (
    call :warnmsg "Veuillez saisir un dossier."
    goto :ask_input
)
set INPUT=!INPUT:"=!
if not exist "!INPUT!\" (
    call :warnmsg "Dossier introuvable : !INPUT!"
    goto :ask_input
)
set "IMSCOUNT=0"
for %%F in ("!INPUT!\*.ims") do set /a IMSCOUNT+=1
if "!IMSCOUNT!"=="0" (
    call :warnmsg "Aucun fichier .ims detecte dans ce dossier."
    set "_ans="
    set /p "_ans=   Continuer quand meme ? [o/N] "
    if /i not "!_ans!"=="o" goto :ask_input
) else (
    call :ok "!IMSCOUNT! fichier(s) .ims detecte(s)."
)

for %%I in ("!BATDIR!\..\DATA_WEB") do set "DEFAULT_OUT=%%~fI"
set "OUTPUT="
set /p "OUTPUT=   Dossier de sortie DATA_WEB [Entree = !DEFAULT_OUT!] : "
if defined OUTPUT set OUTPUT=!OUTPUT:"=!
if not defined OUTPUT set "OUTPUT=!DEFAULT_OUT!"

set "FILTER="
set /p "FILTER=   Filtre optionnel (glob, ex: *E8*) [Entree = tous] : "
if defined FILTER set FILTER=!FILTER:"=!

rem Option : generer aussi le contenu de download/ (lourd : relit le .ims, TIFF, zip)
set "WITH_DOWNLOADS="
set "_ans="
set /p "_ans=   Generer aussi les fichiers download/ (archive, TIFF ImageJ, MIP) ? [o/N] "
if /i "!_ans!"=="o" set "WITH_DOWNLOADS=1"

echo.
echo !DIM!--------------------------------------------------------------------------------!R!
echo    !BOLD!Recapitulatif!R!
echo      Python   : !PY!
echo      Entree   : !INPUT!
echo      Sortie   : !OUTPUT!
if defined FILTER (echo      Filtre   : !FILTER!) else (echo      Filtre   : tous les fichiers)
if defined WITH_DOWNLOADS (echo      Download/ : oui) else (echo      Download/ : non)
echo !DIM!--------------------------------------------------------------------------------!R!
set "_ans="
set /p "_ans=   Lancer le traitement ? [O/n] "
if /i "!_ans!"=="n" (
    call :info "Abandon a la demande de l'utilisateur."
    exit /b 2
)
exit /b 0


rem ---- Saisie des parametres : photographies 2D ------------------------------
:ask_2d
:ask_2d_input
echo.
set "INPUT="
set /p "INPUT=   Dossier des fichiers .tif : "
if not defined INPUT (
    call :warnmsg "Veuillez saisir un dossier."
    goto :ask_2d_input
)
set INPUT=!INPUT:"=!
if not exist "!INPUT!\" (
    call :warnmsg "Dossier introuvable : !INPUT!"
    goto :ask_2d_input
)
set "TIFCOUNT=0"
for %%F in ("!INPUT!\*.tif" "!INPUT!\*.tiff") do set /a TIFCOUNT+=1
if "!TIFCOUNT!"=="0" (
    call :warnmsg "Aucun fichier .tif detecte dans ce dossier."
    set "_ans="
    set /p "_ans=   Continuer quand meme ? [o/N] "
    if /i not "!_ans!"=="o" goto :ask_2d_input
) else (
    call :ok "!TIFCOUNT! fichier(s) .tif detecte(s)."
)

for %%I in ("!BATDIR!\..\DATA_WEB") do set "DEFAULT_OUT=%%~fI"
set "OUTPUT="
set /p "OUTPUT=   Dossier de sortie DATA_WEB [Entree = !DEFAULT_OUT!] : "
if defined OUTPUT set OUTPUT=!OUTPUT:"=!
if not defined OUTPUT set "OUTPUT=!DEFAULT_OUT!"

set "STAINING=X-gal"
set "_ans="
set /p "_ans=   Coloration [!STAINING!] : "
if not "!_ans!"=="" set "STAINING=!_ans!"

set "LINE="
set /p "LINE=   Lignee (Entree = lue dans le nom du .lif) : "
if defined LINE set LINE=!LINE:"=!

rem Le TIFF d'origine est simplement lie (hardlink) dans download/ : aucun cout disque.
set "WITH_DOWNLOADS="
set "_ans="
set /p "_ans=   Copier le TIFF d'origine dans download/ ? [o/N] "
if /i "!_ans!"=="o" set "WITH_DOWNLOADS=1"

set "FORCE="
set "_ans="
set /p "_ans=   Reimporter les datasets deja presents (curation conservee) ? [o/N] "
if /i "!_ans!"=="o" set "FORCE=1"

echo.
echo !DIM!--------------------------------------------------------------------------------!R!
echo    !BOLD!Recapitulatif!R!
echo      Python     : !PY!
echo      Entree     : !INPUT!
echo      Sortie     : !OUTPUT!\2d
echo      Coloration : !STAINING!
if defined LINE (echo      Lignee     : !LINE!) else (echo      Lignee     : lue dans le nom du fichier)
if defined WITH_DOWNLOADS (echo      Download/  : oui) else (echo      Download/  : non)
echo !DIM!--------------------------------------------------------------------------------!R!
set "_ans="
set /p "_ans=   Lancer l'import ? [O/n] "
if /i "!_ans!"=="n" (
    call :info "Abandon a la demande de l'utilisateur."
    exit /b 2
)
exit /b 0


rem ---- Execution du pipeline -------------------------------------------------
:run_pipeline
echo.
call :info "Ctrl+C pendant le traitement : une confirmation sera demandee avant l'arret."
echo.
set "PYTHONUNBUFFERED=1"
set "PYTHONIOENCODING=utf-8"
set "EXTRA="
if "!MODE!"=="2d" goto :run_2d
if defined WITH_DOWNLOADS (
    call :ensure_tifffile
    set "EXTRA=--with-downloads"
)
if defined FILTER (
    %PY% "!WORK!\!ENTRY!" --input "!INPUT!" --output "!OUTPUT!" --only "!FILTER!" !EXTRA!
) else (
    %PY% "!WORK!\!ENTRY!" --input "!INPUT!" --output "!OUTPUT!" !EXTRA!
)
goto :run_report

rem  L'importeur n'ecrit que des .webp : tifffile n'est pas requis ici.
:run_2d
if defined WITH_DOWNLOADS set "EXTRA=--with-downloads"
if defined FORCE set EXTRA=!EXTRA! --force
if defined LINE set EXTRA=!EXTRA! --line "!LINE!"
%PY% "!WORK!\2d_importer.py" --input "!INPUT!" --output "!OUTPUT!" --staining "!STAINING!" !EXTRA!

:run_report
set "RC=!errorlevel!"
echo.
if "!RC!"=="0" (
    echo !OK!================================================================================!R!
    echo !OK!  Traitement termine avec succes.!R!
    echo !OK!================================================================================!R!
) else if "!RC!"=="130" (
    echo !WARN!================================================================================!R!
    echo !WARN!  Pipeline interrompu par l'utilisateur (Ctrl+C). Etat nettoye.!R!
    echo !WARN!================================================================================!R!
) else (
    echo !ERR!================================================================================!R!
    echo !ERR!  Le pipeline s'est termine avec le code d'erreur !RC!.!R!
    echo !ERR!================================================================================!R!
)
exit /b 0


:show_help
echo.
echo Usage : %~nx0 [options]
echo.
echo   (aucun)          Lance le pipeline en mode interactif.
echo   --check          Verifie scripts + Python + dependances, puis quitte.
echo   --extract [dir]  Extrait les scripts embarques (defaut : dossier du .bat).
echo   --force-local    Ignore le Python systeme, utilise/installe le Python local.
echo   --help, -h       Affiche cette aide.
goto :end


:fatal
echo.
call :errmsg "Arret : l'environnement n'a pas pu etre prepare."
set "RC=1"
goto :end


:end
echo.
pause
endlocal & exit /b %RC%

rem ############################################################################
rem #  DONNEES EMBARQUEES (scripts Python encodes en base64)
rem #  Ne jamais executer : le flux s'arrete a 'exit /b' ci-dessus.
rem #  Format : lignes "#<index>#<base64>", un index par script (ordre SCRIPTS).
rem ############################################################################
:: ---- [0] run_preprocess.py (32667 octets) ----
#0#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwppbXBvcnQgYXJncGFyc2UKaW1wb3J0IGZubWF0Y2gKaW1w
#0#b3J0IGhhc2hsaWIKaW1wb3J0IGltcG9ydGxpYi51dGlsCmltcG9ydCBqc29uCmltcG9ydCBvcwpp
#0#bXBvcnQgcmUKaW1wb3J0IHNodXRpbAppbXBvcnQgc2lnbmFsCmltcG9ydCBzdWJwcm9jZXNzCmlt
#0#cG9ydCBzeXMKaW1wb3J0IHRpbWUKaW1wb3J0IHRyYWNlYmFjawpmcm9tIGRhdGV0aW1lIGltcG9y
#0#dCBkYXRldGltZQpmcm9tIHBhdGhsaWIgaW1wb3J0IFBhdGgKCl9fdmVyc2lvbl9fID0gIjAuMTku
#0#MCIKCiMg4pSA4pSAIFBhdGhzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#0#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#0#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#0#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#0#gApTQ1JJUFRfRElSID0gUGF0aChfX2ZpbGVfXykucmVzb2x2ZSgpLnBhcmVudApQWVRIT05fRVhF
#0#ID0gc3lzLmV4ZWN1dGFibGUKCgojIOKUgOKUgCBTaGFyZWQgcGlwZWxpbmUgaGVscGVycyDilIDi
#0#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#0#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#0#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKIyBUaGUgbnVtYmVyZWQgc3Rl
#0#cHMgYW5kIHRoZSAyRCBpbXBvcnRlciBpbXBvcnQgdGhlc2UgZnJvbSBoZXJlIHJhdGhlciB0aGFu
#0#IGZyb20gYQojIG1vZHVsZSBvZiB0aGVpciBvd246IGV2ZXJ5IHdheSB0aGUgcGlwZWxpbmUgaXMg
#0#ZGlzdHJpYnV0ZWQgKHRoZSByZXBvc2l0b3J5LCB0aGUKIyBzZWxmLWNvbnRhaW5lZCAuYmF0IGxh
#0#dW5jaGVyLCB0aGUgZG93bmxvYWRhYmxlIHBpcGVsaW5lIHBhY2spIHNoaXBzIHRoaXMgZmlsZSBi
#0#ZXNpZGUKIyB0aGUgc3RlcHMsIHNvIGEgaGVscGVyIGxpdmluZyBoZXJlIGNhbiBuZXZlciBiZSBt
#0#aXNzaW5nIHdoZXJlIGEgc3RlcCBydW5zLgoKIyBXaW5kb3dzJyBXYWl0Rm9yTXVsdGlwbGVPYmpl
#0#Y3RzIGNhcHMgYSBQcm9jZXNzUG9vbEV4ZWN1dG9yIGF0IDYxIHdvcmtlcnM7IGFza2luZyBmb3IK
#0#IyBtb3JlIHJhaXNlcyBWYWx1ZUVycm9yIGJlZm9yZSBhIHNpbmdsZSB0YXNrIHJ1bnMuCl9XSU5E
#0#T1dTX01BWF9XT1JLRVJTID0gNjEKCgpkZWYgd29ya2VyX2NvdW50KCkgLT4gaW50OgogICAgIiIi
#0#U2l6ZSBvZiBhIHN0ZXAncyBwcm9jZXNzIHBvb2wuCgogICAgT25lIHdvcmtlciBwZXIgbG9naWNh
#0#bCBjb3JlIHNhdHVyYXRlcyB0aGUgQ1BVLCBidXQgZWFjaCB3b3JrZXIgYWxzbyBob2xkcyBpdHMg
#0#b3duCiAgICB3b3JraW5nIHNldCAoYSB0aWxlIG9mIHRoZSB2b2x1bWUgYmVpbmcgbGV2ZWxsZWQs
#0#IGEgYmF0Y2ggb2YgYnJpY2tzIGJlaW5nIGVuY29kZWQpLgogICAgQ29tbWl0IG9uIFdpbmRvd3Mg
#0#aXMgYm91bmRlZCBieSBSQU0gKyBwYWdlIGZpbGUsIG5vdCBieSBmcmVlIFJBTTogdGhlIG1lYXN1
#0#cmVkCiAgICBmYWlsdXJlIHdhcyAzNzg5eDM3ODl4MTI1eDRjaCBvbiBhIDYzLjUgR2lCIG1hY2hp
#0#bmUgd2l0aCAzNi4zIEdpQiBvZiBjb21taXQgZnJlZSwKICAgIHdoZXJlIHRoZSBwb29sIGRpZWQg
#0#d2l0aCBXaW5FcnJvciAxNDU1ICJ0aGUgcGFnaW5nIGZpbGUgaXMgdG9vIHNtYWxsIi4KCiAgICBM
#0#VU1FTl9QUkVQUk9DRVNTX1dPUktFUlMgY2FwcyB0aGUgcG9vbCBzbyBhIGJ1c3kgb3Igc21hbGxl
#0#ciBtYWNoaW5lIGNhbiBzdGlsbCBmaW5pc2guCiAgICBVbnNldCwgb25lIHdvcmtlciBwZXIgbG9n
#0#aWNhbCBjb3JlICg2MSBhdCBtb3N0IG9uIFdpbmRvd3MpLgogICAgIiIiCiAgICBjb3JlcyA9IG9z
#0#LmNwdV9jb3VudCgpIG9yIDEKICAgIGNlaWxpbmcgPSBtaW4oY29yZXMsIF9XSU5ET1dTX01BWF9X
#0#T1JLRVJTKSBpZiBvcy5uYW1lID09ICJudCIgZWxzZSBjb3JlcwogICAgcmF3ID0gb3MuZW52aXJv
#0#bi5nZXQoIkxVTUVOX1BSRVBST0NFU1NfV09SS0VSUyIsICIiKS5zdHJpcCgpCiAgICBpZiByYXc6
#0#CiAgICAgICAgdHJ5OgogICAgICAgICAgICBuID0gaW50KHJhdykKICAgICAgICAgICAgaWYgbiA+
#0#PSAxOgogICAgICAgICAgICAgICAgcmV0dXJuIG1pbihuLCBjZWlsaW5nKQogICAgICAgICAgICBw
#0#cmludChmIltQUk9DRVNTXSBMVU1FTl9QUkVQUk9DRVNTX1dPUktFUlM9e3JhdyFyfSBpZ25vcmUg
#0#KGRvaXQgZXRyZSA+PSAxKSIsIGZsdXNoPVRydWUpCiAgICAgICAgZXhjZXB0IFZhbHVlRXJyb3I6
#0#CiAgICAgICAgICAgIHByaW50KGYiW1BST0NFU1NdIExVTUVOX1BSRVBST0NFU1NfV09SS0VSUz17
#0#cmF3IXJ9IGlnbm9yZSAoZW50aWVyIGF0dGVuZHUpIiwgZmx1c2g9VHJ1ZSkKICAgIHJldHVybiBj
#0#ZWlsaW5nCgoKZGVmIF9yZXRyeV9vcyhhY3Rpb24sIGF0dGVtcHRzOiBpbnQgPSA0MCwgZGVsYXk6
#0#IGZsb2F0ID0gMC4xKToKICAgICIiIlJ1biBhIHJlbmFtZS9yZXBsYWNlLCByZXRyeWluZyB3aGls
#0#ZSBXaW5kb3dzIHJlcG9ydHMgdGhlIHRhcmdldCBidXN5LgoKICAgIFRoZSB3ZWIgc2VydmVyIG9w
#0#ZW5zIG1ldGFkYXRhLmpzb24gYW5kIHBhY2sgZmlsZXMgZm9yIHJlYWRpbmcgd2l0aG91dAogICAg
#0#RklMRV9TSEFSRV9ERUxFVEUsIHNvIHJlcGxhY2luZyBvciByZW5hbWluZyB0aGVtIGZhaWxzIGZv
#0#ciB0aGUgZmV3IG1pbGxpc2Vjb25kcwogICAgYSByZXF1ZXN0IGhvbGRzIHRoZW0uIFRoYXQgaXMg
#0#YSB3YWl0LCBub3QgYW4gZXJyb3IuCiAgICAiIiIKICAgIGZvciBhdHRlbXB0IGluIHJhbmdlKGF0
#0#dGVtcHRzKToKICAgICAgICB0cnk6CiAgICAgICAgICAgIHJldHVybiBhY3Rpb24oKQogICAgICAg
#0#IGV4Y2VwdCBQZXJtaXNzaW9uRXJyb3I6CiAgICAgICAgICAgIGlmIGF0dGVtcHQgPT0gYXR0ZW1w
#0#dHMgLSAxOgogICAgICAgICAgICAgICAgcmFpc2UKICAgICAgICAgICAgdGltZS5zbGVlcChkZWxh
#0#eSkKCgpkZWYgYXRvbWljX3dyaXRlX2J5dGVzKHBhdGgsIGRhdGE6IGJ5dGVzKSAtPiBOb25lOgog
#0#ICAgIiIiV3JpdGUgYSBmaWxlIHNvIGEgcmVhZGVyIHNlZXMgZWl0aGVyIHRoZSBvbGQgY29udGVu
#0#dCBvciB0aGUgbmV3IG9uZSwgbmV2ZXIgYQogICAgdHJ1bmNhdGVkIG1peDogdGhlIGJ5dGVzIGdv
#0#IHRvIGEgdGVtcG9yYXJ5IHNpYmxpbmcsIGFyZSBmbHVzaGVkIHRvIGRpc2ssIGFuZAogICAgcmVw
#0#bGFjZSB0aGUgdGFyZ2V0IGluIG9uZSByZW5hbWUuIiIiCiAgICBwYXRoID0gUGF0aChwYXRoKQog
#0#ICAgdG1wID0gcGF0aC53aXRoX25hbWUoZiIue3BhdGgubmFtZX0ue29zLmdldHBpZCgpfS50bXAi
#0#KQogICAgdHJ5OgogICAgICAgIHdpdGggb3Blbih0bXAsICJ3YiIpIGFzIGZoOgogICAgICAgICAg
#0#ICBmaC53cml0ZShkYXRhKQogICAgICAgICAgICBmaC5mbHVzaCgpCiAgICAgICAgICAgIG9zLmZz
#0#eW5jKGZoLmZpbGVubygpKQogICAgICAgIF9yZXRyeV9vcyhsYW1iZGE6IG9zLnJlcGxhY2UodG1w
#0#LCBwYXRoKSkKICAgIGV4Y2VwdCBCYXNlRXhjZXB0aW9uOgogICAgICAgIHRyeToKICAgICAgICAg
#0#ICAgdG1wLnVubGluaygpCiAgICAgICAgZXhjZXB0IE9TRXJyb3I6CiAgICAgICAgICAgIHBhc3MK
#0#ICAgICAgICByYWlzZQoKCmRlZiBhdG9taWNfd3JpdGVfdGV4dChwYXRoLCB0ZXh0OiBzdHIpIC0+
#0#IE5vbmU6CiAgICBhdG9taWNfd3JpdGVfYnl0ZXMocGF0aCwgdGV4dC5lbmNvZGUoInV0Zi04Iikp
#0#CgoKZGVmIGF0b21pY193cml0ZV9qc29uKHBhdGgsIG9iaiwgKipkdW1wX2t3YXJncykgLT4gTm9u
#0#ZToKICAgIGF0b21pY193cml0ZV90ZXh0KHBhdGgsIGpzb24uZHVtcHMob2JqLCAqKmR1bXBfa3dh
#0#cmdzKSkKCgojIEtleXMgdGhlIGxhYiBlZGl0cyBpbiB0aGUgYWRtaW4gcGFuZWwgKG9yIGF0dGFj
#0#aGVzIGFmdGVyd2FyZHMpLiBSZS1wcm9jZXNzaW5nIGEKIyBkYXRhc2V0IHJlZnJlc2hlcyB3aGF0
#0#IHRoZSBhY3F1aXNpdGlvbiBtZWFzdXJlcyBhbmQgbGVhdmVzIHRoZXNlIGFsb25lOyBvbmUgbGlz
#0#dCBmb3IKIyB0aGUgdm9sdW1lIHBpcGVsaW5lIGFuZCB0aGUgMkQgaW1wb3J0ZXIgc28gYm90aCBw
#0#YXRocyBwcm90ZWN0IHRoZSBzYW1lIGN1cmF0aW9uLgpDVVJBVEVEX0tFWVMgPSAoCiAgICAibmFt
#0#ZSIsICJkZXNjcmlwdGlvbiIsICJzdGFnZSIsICJzdGFnZU51bWVyaWMiLCAiZW1icnlvIiwgImxp
#0#bmUiLCAic3RhaW5pbmciLAogICAgInJlcG9ydGVyIiwgImhpZGRlbiIsICJnYWxsZXJ5IiwgInRh
#0#Z3MiLCAibm90ZXMiLCAiY3JlYXRlZCIsCiAgICAib3JpZW50YXRpb24iLCAib3JpZW50YXRpb25B
#0#eGVzIiwgInVwc2lkZURvd24iLCAiZGVmYXVsdFZpZXciLCAiZXhwb3N1cmUiLAogICAgImxpbmtl
#0#ZFRyYWNraW5nSWQiLCAicmVsYXRlZElkcyIsCikKCgpkZWYgbWVyZ2VfY3VyYXRlZChleGlzdGlu
#0#ZzogZGljdCwgZnJlc2g6IGRpY3QpIC0+IGRpY3Q6CiAgICAiIiJNZXRhZGF0YSBmb3IgYSByZS1w
#0#cm9jZXNzZWQgZGF0YXNldDogd2hhdCB0aGUgZmlsZSBtZWFzdXJlcyBjb21lcyBmcm9tIGBmcmVz
#0#aGAsCiAgICBldmVyeSBjdXJhdGVkIGtleSBmcm9tIGBleGlzdGluZ2AsIGFuZCBhbnkga2V5IGBm
#0#cmVzaGAgZG9lcyBub3QgcHJvZHVjZSBhdCBhbGwKICAgIChhZGRlZCBieSB0aGUgYWRtaW4gcGFu
#0#ZWwgb3IgYSBsYXRlciBzdGVwLCBlLmcuIGEgdHJhY2tpbmcgYmxvY2spIGlzIGNhcnJpZWQgb3Zl
#0#cgogICAgcmF0aGVyIHRoYW4gZHJvcHBlZC4gQSBoaWRkZW4gZGF0YXNldCB0aGVyZWZvcmUgc3Rh
#0#eXMgaGlkZGVuLiIiIgogICAgaWYgbm90IGlzaW5zdGFuY2UoZXhpc3RpbmcsIGRpY3QpIG9yIG5v
#0#dCBleGlzdGluZzoKICAgICAgICByZXR1cm4gZGljdChmcmVzaCkKICAgIG1lcmdlZCA9IGRpY3Qo
#0#ZnJlc2gpCiAgICBmb3Iga2V5IGluIENVUkFURURfS0VZUzoKICAgICAgICBpZiBrZXkgaW4gZXhp
#0#c3Rpbmc6CiAgICAgICAgICAgIG1lcmdlZFtrZXldID0gZXhpc3Rpbmdba2V5XQogICAgZm9yIGtl
#0#eSwgdmFsdWUgaW4gZXhpc3RpbmcuaXRlbXMoKToKICAgICAgICBpZiBrZXkgbm90IGluIG1lcmdl
#0#ZDoKICAgICAgICAgICAgbWVyZ2VkW2tleV0gPSB2YWx1ZQogICAgaWYgImxhc3RNb2RpZmllZCIg
#0#aW4gZnJlc2g6CiAgICAgICAgbWVyZ2VkWyJsYXN0TW9kaWZpZWQiXSA9IGZyZXNoWyJsYXN0TW9k
#0#aWZpZWQiXQogICAgcmV0dXJuIG1lcmdlZAoKCmRlZiByZWFkX2pzb25fZmlsZShwYXRoKSAtPiBk
#0#aWN0OgogICAgIiIiQSBKU09OIG9iamVjdCBmcm9tIGRpc2ssIG9yIHt9IHdoZW4gdGhlIGZpbGUg
#0#aXMgYWJzZW50IG9yIHVucmVhZGFibGUuIHV0Zi04LXNpZwogICAgdG9sZXJhdGVzIHRoZSBCT00g
#0#YSBoYW5kIGVkaXQgaW4gTm90ZXBhZCBsZWF2ZXMgYmVoaW5kLiIiIgogICAgdHJ5OgogICAgICAg
#0#IGRvYyA9IGpzb24ubG9hZHMoUGF0aChwYXRoKS5yZWFkX3RleHQoZW5jb2Rpbmc9InV0Zi04LXNp
#0#ZyIpKQogICAgZXhjZXB0IChPU0Vycm9yLCBWYWx1ZUVycm9yKToKICAgICAgICByZXR1cm4ge30K
#0#ICAgIHJldHVybiBkb2MgaWYgaXNpbnN0YW5jZShkb2MsIGRpY3QpIGVsc2Uge30KCgpkZWYgc2x1
#0#Z2lmeSh0ZXh0OiBzdHIpIC0+IHN0cjoKICAgICIiIkEgZm9sZGVyIG5hbWUgdGhhdCBzdXJ2aXZl
#0#cyBhIFVSTCB1bmVzY2FwZWQ6IGAjYCB3b3VsZCB0cnVuY2F0ZSBpdCwgYCVgIHdvdWxkIGJlCiAg
#0#ICBkZWNvZGVkLCBgP2AvYCtgL3NwYWNlcy9ub24tQVNDSUkgZGVwZW5kIG9uIHdobyBlbmNvZGVz
#0#IHRoZW0sIGFuZCBXaW5kb3dzIHN0cmlwcyBhCiAgICB0cmFpbGluZyBkb3Qgb3Igc3BhY2UuIiIi
#0#CiAgICByZXR1cm4gcmUuc3ViKHIiLXsyLH0iLCAiLSIsIHJlLnN1YihyIlteQS1aYS16MC05Ll8t
#0#XSsiLCAiLSIsIHRleHQpKS5zdHJpcCgiLS4iKQoKCmRlZiB0aHVtYm5haWxfbG9kKGxvZF9sZXZl
#0#bHMpIC0+IGludDoKICAgICIiIlRoZSBmaW5lc3QgTE9EIHdob3NlIGxvbmcgc2lkZSBpcyBhdCBt
#0#b3N0IDEwMjQgcHgg4oCUIHdoYXQgdGhlIHRodW1ibmFpbCBNSVAgcmVhZHMuIiIiCiAgICBmb3Ig
#0#bGkgaW4gbG9kX2xldmVsczoKICAgICAgICBpZiBtYXgobGlbIndpZHRoIl0sIGxpWyJoZWlnaHQi
#0#XSkgPD0gMTAyNDoKICAgICAgICAgICAgcmV0dXJuIGxpWyJsb2QiXQogICAgcmV0dXJuIDAKCgpk
#0#ZWYgbG9hZF9zdGVwKHNjcmlwdF9uYW1lOiBzdHIsIG1vZHVsZV9uYW1lOiBzdHIpOgogICAgIiIi
#0#SW1wb3J0IGEgbnVtYmVyZWQgc3RlcCAoaXRzIGZpbGUgbmFtZSBpcyBub3QgYSBQeXRob24gaWRl
#0#bnRpZmllcikgYXMgYSBtb2R1bGUuIiIiCiAgICBzcGVjID0gaW1wb3J0bGliLnV0aWwuc3BlY19m
#0#cm9tX2ZpbGVfbG9jYXRpb24obW9kdWxlX25hbWUsIHN0cihTQ1JJUFRfRElSIC8gc2NyaXB0X25h
#0#bWUpKQogICAgbW9kdWxlID0gaW1wb3J0bGliLnV0aWwubW9kdWxlX2Zyb21fc3BlYyhzcGVjKQog
#0#ICAgc3BlYy5sb2FkZXIuZXhlY19tb2R1bGUobW9kdWxlKQogICAgcmV0dXJuIG1vZHVsZQoKIyDi
#0#lIDilIAgQ29uc29sZSBzdHlsaW5nIChncmFjZWZ1bCBBTlNJOyBkZWdyYWRlcyB0byBwbGFpbiBv
#0#biByZWRpcmVjdCAvIG5vLVZUKSDilIDilIDilIDilIDilIDilIAKZGVmIF9zdXBwb3J0c19jb2xv
#0#cigpIC0+IGJvb2w6CiAgICBpZiBub3Qgc3lzLnN0ZG91dC5pc2F0dHkoKToKICAgICAgICByZXR1
#0#cm4gRmFsc2UKICAgIGlmIG9zLm5hbWUgPT0gIm50IjoKICAgICAgICB0cnk6CiAgICAgICAgICAg
#0#IGltcG9ydCBjdHlwZXMKICAgICAgICAgICAgayA9IGN0eXBlcy53aW5kbGwua2VybmVsMzIKICAg
#0#ICAgICAgICAgaCA9IGsuR2V0U3RkSGFuZGxlKC0xMSkKICAgICAgICAgICAgbW9kZSA9IGN0eXBl
#0#cy5jX3VpbnQzMigpCiAgICAgICAgICAgIGlmIG5vdCBrLkdldENvbnNvbGVNb2RlKGgsIGN0eXBl
#0#cy5ieXJlZihtb2RlKSk6CiAgICAgICAgICAgICAgICByZXR1cm4gRmFsc2UKICAgICAgICAgICAg
#0#ay5TZXRDb25zb2xlTW9kZShoLCBtb2RlLnZhbHVlIHwgMHgwMDA0KSAgIyBFTkFCTEVfVklSVFVB
#0#TF9URVJNSU5BTF9QUk9DRVNTSU5HCiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbjoKICAgICAgICAg
#0#ICAgcmV0dXJuIEZhbHNlCiAgICByZXR1cm4gVHJ1ZQoKX0NPTE9SID0gX3N1cHBvcnRzX2NvbG9y
#0#KCkKCmRlZiBfc3R5bGUoY29kZTogc3RyLCB0ZXh0OiBzdHIpIC0+IHN0cjoKICAgIHJldHVybiBm
#0#IlwwMzNbe2NvZGV9bXt0ZXh0fVwwMzNbMG0iIGlmIF9DT0xPUiBlbHNlIHRleHQKCmRlZiBfaGRy
#0#KHMpOiAgcmV0dXJuIF9zdHlsZSgiMTs5NiIsIHMpICAgIyBib2xkIGN5YW4KZGVmIF9vayhzKTog
#0#ICByZXR1cm4gX3N0eWxlKCI5MiIsIHMpICAgICAjIGdyZWVuCmRlZiBfZXJyKHMpOiAgcmV0dXJu
#0#IF9zdHlsZSgiOTEiLCBzKSAgICAgIyByZWQKZGVmIF93YXJuKHMpOiByZXR1cm4gX3N0eWxlKCI5
#0#MyIsIHMpICAgICAjIHllbGxvdwpkZWYgX2RpbShzKTogIHJldHVybiBfc3R5bGUoIjkwIiwgcykg
#0#ICAgICMgZ3JleQoKIyDilIDilIAgR3JhY2VmdWwgaW50ZXJydXB0aW9uIChDdHJsK0MpIOKUgOKU
#0#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#0#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#0#gOKUgOKUgOKUgOKUgOKUgOKUgAojIEVhY2ggc3RlcCBydW5zIGluIGl0cyBPV04gcHJvY2VzcyBn
#0#cm91cCwgc28gYSBjb25zb2xlIEN0cmwrQyBpcyBOT1QgZGVsaXZlcmVkIHRvCiMgdGhlIGNoaWxk
#0#IGRpcmVjdGx5LiBUaGUgb3JjaGVzdHJhdG9yIGludGVyY2VwdHMgU0lHSU5ULCBhc2tzIHRoZSB1
#0#c2VyIHRvIGNvbmZpcm0sCiMgYW5kIG9ubHkgdGhlbiB0ZWFycyB0aGUgcnVubmluZyBzdGVwIChh
#0#bmQgdGhlIHdvcmtlciBwb29sIGl0IHNwYXduZWQpIGRvd24uCiMgRGVjbGluaW5nIHRoZSBwcm9t
#0#cHQgcmVzdW1lcyB0aGUgc3RlcCB0cmFuc3BhcmVudGx5IOKAlCBpdCBuZXZlciByZWNlaXZlZCB0
#0#aGUgc2lnbmFsLgppZiBvcy5uYW1lID09ICJudCI6CiAgICBfU1RFUF9TUEFXTiA9IHsiY3JlYXRp
#0#b25mbGFncyI6IHN1YnByb2Nlc3MuQ1JFQVRFX05FV19QUk9DRVNTX0dST1VQfQplbHNlOgogICAg
#0#X1NURVBfU1BBV04gPSB7InN0YXJ0X25ld19zZXNzaW9uIjogVHJ1ZX0KCl9jdXJyZW50X3Byb2Mg
#0#PSBOb25lICAgICMgUG9wZW4gb2YgdGhlIHN0ZXAgY3VycmVudGx5IHJ1bm5pbmcgKG9yIE5vbmUp
#0#Cl9jb25maXJtaW5nID0gRmFsc2UgICAgICMgcmUtZW50cmFuY3kgZ3VhcmQgZm9yIHRoZSBjb25m
#0#aXJtYXRpb24gcHJvbXB0CgoKZGVmIF9raWxsX3RyZWUocHJvYykgLT4gTm9uZToKICAgICIiIlRl
#0#cm1pbmF0ZSBhIHN0ZXAgcHJvY2VzcyBhbmQgZXZlcnkgd29ya2VyIGl0IHNwYXduZWQgKFByb2Nl
#0#c3NQb29sRXhlY3V0b3IpLiIiIgogICAgaWYgcHJvYyBpcyBOb25lIG9yIHByb2MucG9sbCgpIGlz
#0#IG5vdCBOb25lOgogICAgICAgIHJldHVybgogICAgdHJ5OgogICAgICAgIGlmIG9zLm5hbWUgPT0g
#0#Im50IjoKICAgICAgICAgICAgc3VicHJvY2Vzcy5ydW4oWyJ0YXNra2lsbCIsICIvRiIsICIvVCIs
#0#ICIvUElEIiwgc3RyKHByb2MucGlkKV0sCiAgICAgICAgICAgICAgICAgICAgICAgICAgIHN0ZG91
#0#dD1zdWJwcm9jZXNzLkRFVk5VTEwsIHN0ZGVycj1zdWJwcm9jZXNzLkRFVk5VTEwpCiAgICAgICAg
#0#ZWxzZToKICAgICAgICAgICAgb3Mua2lsbHBnKG9zLmdldHBnaWQocHJvYy5waWQpLCBzaWduYWwu
#0#U0lHVEVSTSkKICAgIGV4Y2VwdCBFeGNlcHRpb246CiAgICAgICAgcGFzcwogICAgdHJ5OgogICAg
#0#ICAgIHByb2Mud2FpdCh0aW1lb3V0PTEwKQogICAgZXhjZXB0IEV4Y2VwdGlvbjoKICAgICAgICB0
#0#cnk6CiAgICAgICAgICAgIHByb2Mua2lsbCgpCiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbjoKICAg
#0#ICAgICAgICAgcGFzcwoKCmRlZiBfaW5zdGFsbF9zaWdpbnRfaGFuZGxlcigpIC0+IE5vbmU6CiAg
#0#ICAiIiJPbiBDdHJsK0MsIGFzayBmb3IgY29uZmlybWF0aW9uLiBDb25maXJtIC0+IGFib3J0IGNs
#0#ZWFubHk7IGRlY2xpbmUgLT4gcmVzdW1lLiIiIgogICAgZGVmIF9oYW5kbGVyKHNpZ251bSwgZnJh
#0#bWUpOgogICAgICAgIGdsb2JhbCBfY29uZmlybWluZwogICAgICAgIGlmIF9jb25maXJtaW5nOgog
#0#ICAgICAgICAgICAjIEEgc2Vjb25kIEN0cmwrQyB3aGlsZSB0aGUgcHJvbXB0IGlzIHVwIG1lYW5z
#0#OiBzdG9wIG5vdywgZm9yIHN1cmUuCiAgICAgICAgICAgIHJhaXNlIEtleWJvYXJkSW50ZXJydXB0
#0#CiAgICAgICAgX2NvbmZpcm1pbmcgPSBUcnVlCiAgICAgICAgdHJ5OgogICAgICAgICAgICBzeXMu
#0#c3RkZXJyLndyaXRlKCJcbiIpCiAgICAgICAgICAgIHRyeToKICAgICAgICAgICAgICAgIGFuc3dl
#0#ciA9IGlucHV0KF93YXJuKCJbIV0gQXJyZXRlciBsZSBwaXBlbGluZSBlbiBjb3VycyA/ICIpICsK
#0#ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICJMZXMgZmljaGllcnMgdGVtcG9yYWlyZXMg
#0#c2Vyb250IG5ldHRveWVzLiBbby9OXSAiKQogICAgICAgICAgICBleGNlcHQgRU9GRXJyb3I6CiAg
#0#ICAgICAgICAgICAgICBhbnN3ZXIgPSAibyIgICAjIG5vbi1pbnRlcmFjdGl2ZSBzdGRpbjogY2Fu
#0#bm90IGFzayAtPiBzdG9wCiAgICAgICAgZmluYWxseToKICAgICAgICAgICAgX2NvbmZpcm1pbmcg
#0#PSBGYWxzZQogICAgICAgIGlmIGFuc3dlci5zdHJpcCgpLmxvd2VyKCkgaW4gKCJvIiwgIm91aSIs
#0#ICJ5IiwgInllcyIpOgogICAgICAgICAgICByYWlzZSBLZXlib2FyZEludGVycnVwdAogICAgICAg
#0#IHByaW50KF9kaW0oIiAgICByZXByaXNlIGR1IHRyYWl0ZW1lbnQuLi4iKSkKICAgIHNpZ25hbC5z
#0#aWduYWwoc2lnbmFsLlNJR0lOVCwgX2hhbmRsZXIpCgojIEhleCBjb2xvcnMgdG8gUkdCIG1hcHBp
#0#bmcgZm9yIGNvbXBvc2l0ZSB0aHVtYm5haWwgKG1hdGNoZXMgY2hhbm5lbCBjb2xvcnMpClRIVU1C
#0#X0NPTE9SUyA9IFsKICAgICgwLCAyNTUsIDEwMiksICAgICMgZ3JlZW4KICAgICgyNTUsIDYxLCAy
#0#NTUpLCAgICMgbWFnZW50YQogICAgKDQ3LCAxMDcsIDI1NSksICAgIyBibHVlCiAgICAoMjU1LCA0
#0#OCwgNDgpLCAgICAjIHJlZAogICAgKDI1NSwgMjU1LCAwKSwgICAgIyB5ZWxsb3cKICAgICgyNTUs
#0#IDAsIDI1NSksICAgICMgcHVycGxlCiAgICAoMCwgMjU1LCAyNTUpICAgICAjIGN5YW4KXQoKZGVm
#0#IGJ1aWxkX3RodW1ibmFpbCh0ZW1wX2RpcjogUGF0aCwgb3V0cHV0X2RpcjogUGF0aCwgcHJvY19t
#0#ZXRhOiBkaWN0KSAtPiBOb25lOgogICAgIiIiCiAgICBDb21wdXRlcyBhIE1heGltdW0gSW50ZW5z
#0#aXR5IFByb2plY3Rpb24gKE1JUCkgZm9yIGVhY2ggY2hhbm5lbCBmcm9tIHByb2Nlc3NlZAogICAg
#0#bG93LXJlcyB2b2x1bWVzIGFuZCBjb21wb3NpdGVzIHRoZW0gaW50byBhIHN0dW5uaW5nIGZhbHNl
#0#LWNvbG9yIFJHQiB0aHVtYm5haWwuCiAgICAiIiIKICAgIGltcG9ydCBudW1weSBhcyBucAogICAg
#0#ZnJvbSBQSUwgaW1wb3J0IEltYWdlCgogICAgbl9jaCA9IHByb2NfbWV0YVsibl9jaGFubmVscyJd
#0#CiAgICBsb2RfbGV2ZWxzID0gcHJvY19tZXRhWyJsb2RfbGV2ZWxzIl0KICAgIEQgPSBwcm9jX21l
#0#dGFbImRlcHRoIl0KCiAgICAjIEEgTE9EIG9mIGF0IG1vc3QgMTAyNCBweCBrZWVwcyB0aGUgTUlQ
#0#IGNoZWFwOyBzdGVwIDIga2VlcHMgZXhhY3RseSB0aGlzIGxldmVsIG9mCiAgICAjIHRoZSBmaXJz
#0#dCB0aW1lcG9pbnQgb24gZGlzayBmb3IgaXQuCiAgICB0YXJnZXRfbG9kID0gdGh1bWJuYWlsX2xv
#0#ZChsb2RfbGV2ZWxzKQogICAgbGkgPSBsb2RfbGV2ZWxzW3RhcmdldF9sb2RdCiAgICB3X2xvZCwg
#0#aF9sb2QgPSBsaVsid2lkdGgiXSwgbGlbImhlaWdodCJdCiAgICAKICAgIG1pcHMgPSBbXQogICAg
#0#Zm9yIGMgaW4gcmFuZ2Uobl9jaCk6CiAgICAgICAgYmluX2ZpbGUgPSB0ZW1wX2RpciAvIGYidDAw
#0#MF9je2N9X2xvZHt0YXJnZXRfbG9kfS5iaW4iCiAgICAgICAgaWYgbm90IGJpbl9maWxlLmV4aXN0
#0#cygpOgogICAgICAgICAgICBjb250aW51ZQogICAgICAgICMgTG9hZCBwcm9jZXNzZWQgdm9sdW1l
#0#CiAgICAgICAgdm9sID0gbnAuZnJvbWZpbGUoc3RyKGJpbl9maWxlKSwgZHR5cGU9bnAudWludDgp
#0#LnJlc2hhcGUoKEQsIGhfbG9kLCB3X2xvZCkpCiAgICAgICAgIyBDb21wdXRlIE1heGltdW0gSW50
#0#ZW5zaXR5IFByb2plY3Rpb24gYWxvbmcgWiBheGlzCiAgICAgICAgbWlwID0gdm9sLm1heChheGlz
#0#PTApCiAgICAgICAgbWlwcy5hcHBlbmQobWlwKQogICAgICAgIAogICAgaWYgbm90IG1pcHM6CiAg
#0#ICAgICAgcHJpbnQoIltUSFVNQk5BSUxdIFdhcm5pbmc6IE5vIGNoYW5uZWwgYmluYXJ5IGZpbGVz
#0#IGZvdW5kIHRvIGJ1aWxkIHRodW1ibmFpbC4iKQogICAgICAgIHJldHVybgoKICAgICMgQ29tcG9z
#0#aXRlIE1JUHMgaW50byBmYWxzZS1jb2xvciBSR0IKICAgIGNvbXBvc2l0ZSA9IG5wLnplcm9zKCho
#0#X2xvZCwgd19sb2QsIDMpLCBkdHlwZT1ucC5mbG9hdDMyKQogICAgZm9yIGksIG1pcCBpbiBlbnVt
#0#ZXJhdGUobWlwcyk6CiAgICAgICAgciwgZywgYiA9IFRIVU1CX0NPTE9SU1tpICUgbGVuKFRIVU1C
#0#X0NPTE9SUyldCiAgICAgICAgbm9ybSA9IG1pcC5hc3R5cGUobnAuZmxvYXQzMikgLyAyNTUuMAog
#0#ICAgICAgIGNvbXBvc2l0ZVs6LCA6LCAwXSArPSBub3JtICogcgogICAgICAgIGNvbXBvc2l0ZVs6
#0#LCA6LCAxXSArPSBub3JtICogZwogICAgICAgIGNvbXBvc2l0ZVs6LCA6LCAyXSArPSBub3JtICog
#0#YgoKICAgIGNvbXBvc2l0ZSA9IG5wLmNsaXAoY29tcG9zaXRlLCAwLCAyNTUpLmFzdHlwZShucC51
#0#aW50OCkKICAgIGltZyA9IEltYWdlLmZyb21hcnJheShjb21wb3NpdGUsIG1vZGU9IlJHQiIpCiAg
#0#ICAKICAgICMgUmVzaXplIHRvIDUxMng1MTIgcHJlc2VydmluZyBhc3BlY3QgcmF0aW8KICAgIFRI
#0#VU1CX1NJWkUgPSA1MTIKICAgIHNjYWxlID0gVEhVTUJfU0laRSAvIG1heCh3X2xvZCwgaF9sb2Qp
#0#CiAgICBuZXdfdywgbmV3X2ggPSBtYXgoMSwgcm91bmQod19sb2QgKiBzY2FsZSkpLCBtYXgoMSwg
#0#cm91bmQoaF9sb2QgKiBzY2FsZSkpCiAgICBpbWcgPSBpbWcucmVzaXplKChuZXdfdywgbmV3X2gp
#0#LCBJbWFnZS5SZXNhbXBsaW5nLkxBTkNaT1MpCiAgICAKICAgICMgUGFkIHRvIHNxdWFyZSB3aXRo
#0#IGRhcmsgYmFja2dyb3VuZCAoIzA4MGExMikKICAgIG91dCA9IEltYWdlLm5ldygiUkdCIiwgKFRI
#0#VU1CX1NJWkUsIFRIVU1CX1NJWkUpLCAoOCwgMTAsIDE4KSkKICAgIG9mZl94ID0gKFRIVU1CX1NJ
#0#WkUgLSBuZXdfdykgLy8gMgogICAgb2ZmX3kgPSAoVEhVTUJfU0laRSAtIG5ld19oKSAvLyAyCiAg
#0#ICBvdXQucGFzdGUoaW1nLCAob2ZmX3gsIG9mZl95KSkKICAgIAogICAgdGh1bWJfcGF0aCA9IG91
#0#dHB1dF9kaXIgLyAidGh1bWJuYWlsLndlYnAiCiAgICBvdXQuc2F2ZShzdHIodGh1bWJfcGF0aCks
#0#ICJXRUJQIiwgcXVhbGl0eT04OCwgbWV0aG9kPTYpCiAgICBwcmludChmIltUSFVNQk5BSUxdIFdy
#0#b3RlIHRodW1ibmFpbCB0byB7dGh1bWJfcGF0aH0iKQoKZGVmIHJ1bl9zY3JpcHQoc2NyaXB0X3Bh
#0#dGgsICphcmdzLCBsYWJlbD1Ob25lKSAtPiBOb25lOgogICAgZ2xvYmFsIF9jdXJyZW50X3Byb2MK
#0#ICAgIGNtZCA9IFtQWVRIT05fRVhFLCBzdHIoc2NyaXB0X3BhdGgpLCAqYXJnc10KICAgIHByaW50
#0#KF9kaW0oZiIgICAtIHtsYWJlbCBvciBQYXRoKHNjcmlwdF9wYXRoKS5uYW1lfSIpKQogICAgcHJv
#0#YyA9IHN1YnByb2Nlc3MuUG9wZW4oY21kLCAqKl9TVEVQX1NQQVdOKQogICAgX2N1cnJlbnRfcHJv
#0#YyA9IHByb2MKICAgIHRyeToKICAgICAgICByZXQgPSBwcm9jLndhaXQoKQogICAgZXhjZXB0IEtl
#0#eWJvYXJkSW50ZXJydXB0OgogICAgICAgICMgQ29uZmlybWVkIGFib3J0IGR1cmluZyB0aGlzIHN0
#0#ZXA6IHRlYXIgZG93biB0aGUgc3RlcCBhbmQgaXRzIHdvcmtlciBwb29sLgogICAgICAgIF9raWxs
#0#X3RyZWUocHJvYykKICAgICAgICByYWlzZQogICAgZmluYWxseToKICAgICAgICBfY3VycmVudF9w
#0#cm9jID0gTm9uZQogICAgaWYgcmV0ICE9IDA6CiAgICAgICAgcmFpc2Ugc3VicHJvY2Vzcy5DYWxs
#0#ZWRQcm9jZXNzRXJyb3IocmV0LCBjbWQpCgoKZGVmIHJ1bl9zdGVwKHNjcmlwdF9uYW1lOiBzdHIs
#0#ICphcmdzKSAtPiBOb25lOgogICAgcnVuX3NjcmlwdChTQ1JJUFRfRElSIC8gc2NyaXB0X25hbWUs
#0#ICphcmdzKQoKCmRlZiBhdHRhY2hfdHJhY2tpbmcoaW1zX3BhdGg6IFBhdGgsIGRhdGFzZXRfb3V0
#0#cHV0X2RpcjogUGF0aCwgdGVtcF9kaXI6IFBhdGgsCiAgICAgICAgICAgICAgICAgICAgZGF0YXNl
#0#dF9uYW1lOiBzdHIsIG1vZGU6IHN0cikgLT4gTm9uZToKICAgICIiIkZpbmQgdGhpcyB2b2x1bWUn
#0#cyBjZWxsLXRyYWNraW5nIGFuYWx5c2lzIGFuZCBhdHRhY2ggaXQgdG8gdGhlIGRhdGFzZXQuCgog
#0#ICAgVGhlIGFuYWx5c2lzIHJlYWNoZXMgdXMgaW4gb25lIG9mIHRocmVlIHNoYXBlcyDigJQgYSAu
#0#aW1hcmlzX3RyYWNrIGNvbnRhaW5lciwgdGhlIEltYXJpcwogICAgb2JqZWN0cyBzdGlsbCBpbnNp
#0#ZGUgdGhlIC5pbXMsIG9yIHRoZSBzdGF0aXN0aWNzIHdvcmtib29rIGV4cG9ydGVkIGJlc2lkZSBp
#0#dCDigJQgc28gdGhlCiAgICB2b2x1bWUgaXMgbm90IHRoZSBvcGVyYXRvcidzIHByb2JsZW06IHdo
#0#aWNoZXZlciBleGlzdHMgaXMgZm91bmQgYW5kIG5vcm1hbGlzZWQuIEEKICAgIHN5bnRoZXNpc2Vk
#0#IGNvbnRhaW5lciBpcyB3cml0dGVuIHRvIHRoZSB0ZW1wIGRpcmVjdG9yeSwgbmV2ZXIgdG8gdGhl
#0#IGRhdGFzZXQsIHNvIHRoZQogICAgcHVibGlzaGVkIHRyZWUgb25seSBldmVyIHJlY2VpdmVzIHdo
#0#YXQgdGhlIGltcG9ydGVyIHB1dHMgdGhlcmUuCgogICAgQSBmYWlsdXJlIGhlcmUgbmV2ZXIgZmFp
#0#bHMgdGhlIHZvbHVtZTogdGhlIGRhdGFzZXQgaXMgYWxyZWFkeSBjb21wbGV0ZSBhbmQgdXNhYmxl
#0#LCB0aGUKICAgIHRyYWNraW5nIGlzIGFuIG92ZXJsYXkgb24gdG9wIG9mIGl0LgogICAgIiIiCiAg
#0#ICBpZiBtb2RlID09ICJvZmYiOgogICAgICAgIHJldHVybgogICAgaWYgbm90IChTQ1JJUFRfRElS
#0#IC8gInRyYWNraW5nX3NvdXJjZXMucHkiKS5leGlzdHMoKToKICAgICAgICBwcmludChfd2Fybigi
#0#ICAgWyFdIHRyYWNraW5nIGlnbm9yZSA6IHRyYWNraW5nX3NvdXJjZXMucHkgYWJzZW50IGRlIGNl
#0#dHRlIGluc3RhbGxhdGlvbiAiCiAgICAgICAgICAgICAgICAgICAgImR1IHBpcGVsaW5lIOKAlCBs
#0#ZSB0aW1lbGFwc2UgZXN0IHB1YmxpZSBzYW5zIHRyYWplY3RvaXJlcyIpKQogICAgICAgIHJldHVy
#0#bgogICAgdHJ5OgogICAgICAgIGltcG9ydCB0cmFja2luZ19zb3VyY2VzCiAgICBleGNlcHQgSW1w
#0#b3J0RXJyb3IgYXMgZXhjOgogICAgICAgIHByaW50KF93YXJuKGYiICAgWyFdIHRyYWNraW5nIGln
#0#bm9yZSA6IHtleGN9IikpCiAgICAgICAgcmV0dXJuCgogICAgIyBUaGUgbGFiJ3MgYW5hbHlzaXMg
#0#Y29kZSwgaW1wb3J0ZWQgaW4gVEhJUyBwcm9jZXNzIGJ5IHRyYWNraW5nX3NvdXJjZXMsIHBpbnMg
#0#dGhlCiAgICAjIEJMQVMvT3Blbk1QIHRocmVhZCB2YXJpYWJsZXMgdG8gMSBhdCBpbXBvcnQuIEV2
#0#ZXJ5IGxhdGVyIHN0ZXAgaW5oZXJpdHMgdGhlCiAgICAjIG9yY2hlc3RyYXRvcidzIGVudmlyb25t
#0#ZW50LCBzbyB0aGV5IGFyZSBwdXQgYmFjayBvbmNlIHRoZSBhbmFseXNpcyBoYXMgcnVuLgogICAg
#0#c2F2ZWRfZW52ID0ge2s6IG9zLmVudmlyb24uZ2V0KGspIGZvciBrIGluIF9USFJFQURfRU5WX1ZB
#0#UlN9CiAgICB0cnk6CiAgICAgICAgaWYgbW9kZSA9PSAiYXV0byI6CiAgICAgICAgICAgIHJlc29s
#0#dmVkID0gdHJhY2tpbmdfc291cmNlcy5yZXNvbHZlKGltc19wYXRoLCB0ZW1wX2RpciwgZGF0YXNl
#0#dF9uYW1lKQogICAgICAgICAgICBpZiByZXNvbHZlZCBpcyBOb25lOgogICAgICAgICAgICAgICAg
#0#cmV0dXJuCiAgICAgICAgICAgIGNvbnRhaW5lciwgX3NvdXJjZSwgX2dsYiA9IHJlc29sdmVkCiAg
#0#ICAgICAgZWxzZToKICAgICAgICAgICAgc291cmNlX3BhdGggPSBQYXRoKG1vZGUpCiAgICAgICAg
#0#ICAgIGlmIG5vdCBzb3VyY2VfcGF0aC5pc19maWxlKCk6CiAgICAgICAgICAgICAgICBwcmludChf
#0#d2FybihmIiAgIFshXSB0cmFja2luZyBpbnRyb3V2YWJsZSA6IHtzb3VyY2VfcGF0aH0iKSkKICAg
#0#ICAgICAgICAgICAgIHJldHVybgogICAgICAgICAgICBwcmludChfZGltKGYiICAgW1RSQUNLSU5H
#0#XSBzb3VyY2UgaW1wb3NlZSA6IHtzb3VyY2VfcGF0aC5uYW1lfSIpKQogICAgICAgICAgICBjb250
#0#YWluZXIgPSB0cmFja2luZ19zb3VyY2VzLm1hdGVyaWFsaXplKHNvdXJjZV9wYXRoLCB0ZW1wX2Rp
#0#ciwgZGF0YXNldF9uYW1lKQogICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBleGM6CiAgICAgICAgcHJp
#0#bnQoX3dhcm4oZiIgICBbIV0gdHJhY2tpbmcgbm9uIGV4cGxvaXRhYmxlIDoge2V4Y30iKSkKICAg
#0#ICAgICByZXR1cm4KICAgIGZpbmFsbHk6CiAgICAgICAgZm9yIGtleSwgdmFsdWUgaW4gc2F2ZWRf
#0#ZW52Lml0ZW1zKCk6CiAgICAgICAgICAgIGlmIHZhbHVlIGlzIE5vbmU6CiAgICAgICAgICAgICAg
#0#ICBvcy5lbnZpcm9uLnBvcChrZXksIE5vbmUpCiAgICAgICAgICAgIGVsc2U6CiAgICAgICAgICAg
#0#ICAgICBvcy5lbnZpcm9uW2tleV0gPSB2YWx1ZQoKICAgIHRyeToKICAgICAgICBydW5fc3RlcCgi
#0#NS10cmFja2luZ19pbXBvcnRlci5weSIsIHN0cihjb250YWluZXIpLCBzdHIoZGF0YXNldF9vdXRw
#0#dXRfZGlyKSkKICAgIGV4Y2VwdCBzdWJwcm9jZXNzLkNhbGxlZFByb2Nlc3NFcnJvciBhcyBleGM6
#0#CiAgICAgICAgcHJpbnQoX3dhcm4oZiIgICBbIV0gcmF0dGFjaGVtZW50IGR1IHRyYWNraW5nIGVj
#0#aG91ZSAoY29kZSB7ZXhjLnJldHVybmNvZGV9KSDigJQgIgogICAgICAgICAgICAgICAgICAgIGYi
#0#bGUgdm9sdW1lIHJlc3RlIHV0aWxpc2FibGUiKSkKCgpfVEhSRUFEX0VOVl9WQVJTID0gKCJPTVBf
#0#TlVNX1RIUkVBRFMiLCAiT1BFTkJMQVNfTlVNX1RIUkVBRFMiLCAiTUtMX05VTV9USFJFQURTIiwK
#0#ICAgICAgICAgICAgICAgICAgICAiVkVDTElCX01BWElNVU1fVEhSRUFEUyIsICJOVU1FWFBSX05V
#0#TV9USFJFQURTIikKCgpET1dOTE9BRF9TQ1JJUFRfTkFNRSA9ICJidWlsZF9kb3dubG9hZF9idW5k
#0#bGVzLnB5IgoKZGVmIF9yZXNvbHZlX2Rvd25sb2FkX3NjcmlwdCgpOgogICAgIiIiVGhlIGRvd25s
#0#b2FkLWJ1bmRsZSB0b29sIHNpdHMgaW4gdG9vbHMvIGluIHRoZSByZXBvLCBidXQgaXMgZXh0cmFj
#0#dGVkIG5leHQKICAgIHRvIHRoaXMgc2NyaXB0IGJ5IHRoZSBzZWxmLWNvbnRhaW5lZCBsYXVuY2hl
#0#ciDigJQgYWNjZXB0IGVpdGhlciBsb2NhdGlvbi4iIiIKICAgIGZvciBjYW5kIGluIChTQ1JJUFRf
#0#RElSIC8gRE9XTkxPQURfU0NSSVBUX05BTUUsCiAgICAgICAgICAgICAgICAgU0NSSVBUX0RJUi5w
#0#YXJlbnQgLyAidG9vbHMiIC8gRE9XTkxPQURfU0NSSVBUX05BTUUpOgogICAgICAgIGlmIGNhbmQu
#0#ZXhpc3RzKCk6CiAgICAgICAgICAgIHJldHVybiBjYW5kLnJlc29sdmUoKQogICAgcmV0dXJuIE5v
#0#bmUKCiMg4pSA4pSAIFB1Ymxpc2hpbmcgYSBkYXRhc2V0IChhbGwgb3Igbm90aGluZykg4pSA4pSA
#0#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#0#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiMgQSBy
#0#dW4gYnVpbGRzIHRoZSB3aG9sZSBkYXRhc2V0IGluIGEgcHJpdmF0ZSBzdGFnaW5nIHRyZWUgdW5k
#0#ZXIgdGhlIHRlbXAgZGlyZWN0b3J5CiMgKHNhbWUgdm9sdW1lIGFzIERBVEFfV0VCLCBzbyBwdWJs
#0#aXNoaW5nIGlzIGEgaGFuZGZ1bCBvZiByZW5hbWVzKS4gVGhlIHB1Ymxpc2hlZAojIGRhdGFzZXQg
#0#a2VlcHMgc2VydmluZyBpdHMgcHJldmlvdXMgYnJpY2tzIGZvciB0aGUgd2hvbGUgbXVsdGktaG91
#0#ciBydW4sIGFuZCBhIHJ1bgojIHRoYXQgZmFpbHMgYXQgYW55IHBvaW50IGJlZm9yZSB0aGUgc3dh
#0#cCBsZWF2ZXMgaXQgZXhhY3RseSBhcyBpdCB3YXMuCiMKIyBFbnRyaWVzIHRoZSBwaXBlbGluZSBv
#0#d25zIGluc2lkZSBhIGRhdGFzZXQgZm9sZGVyLiBFdmVyeXRoaW5nIGVsc2UgdGhlcmUg4oCUIGRv
#0#d25sb2FkLywKIyBnYWxsZXJ5LywgYW55IGZpbGUgdGhlIG9wZXJhdG9yIGRyb3BwZWQgaW4g4oCU
#0#IGlzIG5ldmVyIHRvdWNoZWQuClBJUEVMSU5FX0VOVFJJRVMgPSAoImJyaWNrcyIsICJ0aHVtYm5h
#0#aWwud2VicCIpClRSQUNLSU5HX0VOVFJJRVMgPSAoInRyYWNrcy5qc29uIiwgInRyYWNrcy5qc29u
#0#Lmd6IiwgIm1vZGVsLmdsYiIpClNXQVBfU1VGRklYID0gIi5wcmUtc3dhcCIKU1dBUF9NQVJLRVIg
#0#PSAiLnN3YXAtaW4tcHJvZ3Jlc3MiCkxFR0FDWV9ST0xMQkFDSyA9ICJicmlja3Mucm9sbGJhY2si
#0#CgoKZGVmIF9zaGEyNTZfZmlsZShwYXRoOiBQYXRoKSAtPiBzdHI6CiAgICBoID0gaGFzaGxpYi5z
#0#aGEyNTYoKQogICAgd2l0aCBvcGVuKHBhdGgsICJyYiIpIGFzIGZoOgogICAgICAgIGZvciBibG9j
#0#ayBpbiBpdGVyKGxhbWJkYTogZmgucmVhZCgxIDw8IDIwKSwgYiIiKToKICAgICAgICAgICAgaC51
#0#cGRhdGUoYmxvY2spCiAgICByZXR1cm4gaC5oZXhkaWdlc3QoKQoKCmRlZiBfcmVtb3ZlX3BhdGgo
#0#cGF0aDogUGF0aCkgLT4gTm9uZToKICAgIGlmIHBhdGguaXNfZGlyKCkgYW5kIG5vdCBwYXRoLmlz
#0#X3N5bWxpbmsoKToKICAgICAgICBzaHV0aWwucm10cmVlKHBhdGgsIGlnbm9yZV9lcnJvcnM9VHJ1
#0#ZSkKICAgIGVsc2U6CiAgICAgICAgdHJ5OgogICAgICAgICAgICBwYXRoLnVubGluaygpCiAgICAg
#0#ICAgZXhjZXB0IEZpbGVOb3RGb3VuZEVycm9yOgogICAgICAgICAgICBwYXNzCgoKZGVmIF9yZW5h
#0#bWUoc3JjOiBQYXRoLCBkc3Q6IFBhdGgpIC0+IE5vbmU6CiAgICBfcmV0cnlfb3MobGFtYmRhOiBv
#0#cy5yZW5hbWUoc3JjLCBkc3QpKQoKCmRlZiByZWNvdmVyX2ludGVycnVwdGVkX3B1Ymxpc2goZmlu
#0#YWxfZGlyOiBQYXRoKSAtPiBOb25lOgogICAgIiIiRmluaXNoIG9yIHVuZG8gYSBzd2FwIGEgY3Jh
#0#c2ggaW50ZXJydXB0ZWQsIHNvIGEgZGF0YXNldCBpcyBuZXZlciBsZWZ0IG1peGluZwogICAgdHdv
#0#IHJ1bnMuIFRoZSBtYXJrZXIgcmVjb3JkcyB0aGUgaGFzaCBvZiB0aGUgbWV0YWRhdGEuanNvbiBi
#0#ZWluZyBpbnN0YWxsZWQ6IGlmCiAgICB0aGF0IGZpbGUgaXMgaW4gcGxhY2UgdGhlIHN3YXAgaGFk
#0#IGNvbW1pdHRlZCBhbmQgb25seSB0aGUgb2xkIGNvcGllcyByZW1haW4gdG8KICAgIGJlIGRyb3Bw
#0#ZWQ7IG90aGVyd2lzZSB0aGUgb2xkIGVudHJpZXMgZ28gYmFjayB3aGVyZSB0aGV5IHdlcmUuIiIi
#0#CiAgICBtYXJrZXIgPSBmaW5hbF9kaXIgLyBTV0FQX01BUktFUgogICAgaWYgbWFya2VyLmlzX2Zp
#0#bGUoKToKICAgICAgICBpbmZvID0gcmVhZF9qc29uX2ZpbGUobWFya2VyKQogICAgICAgIG1ldGEg
#0#PSBmaW5hbF9kaXIgLyAibWV0YWRhdGEuanNvbiIKICAgICAgICBjb21taXR0ZWQgPSBib29sKGlu
#0#Zm8uZ2V0KCJtZXRhZGF0YVNoYTI1NiIpKSBhbmQgbWV0YS5pc19maWxlKCkgXAogICAgICAgICAg
#0#ICBhbmQgX3NoYTI1Nl9maWxlKG1ldGEpID09IGluZm9bIm1ldGFkYXRhU2hhMjU2Il0KICAgICAg
#0#ICBmb3IgZW50cnkgaW4gaW5mby5nZXQoImVudHJpZXMiKSBvciBbXToKICAgICAgICAgICAgb2xk
#0#ID0gZmluYWxfZGlyIC8gKGVudHJ5ICsgU1dBUF9TVUZGSVgpCiAgICAgICAgICAgIGlmIG5vdCBv
#0#bGQuZXhpc3RzKCk6CiAgICAgICAgICAgICAgICBjb250aW51ZQogICAgICAgICAgICBpZiBjb21t
#0#aXR0ZWQ6CiAgICAgICAgICAgICAgICBfcmVtb3ZlX3BhdGgob2xkKQogICAgICAgICAgICBlbHNl
#0#OgogICAgICAgICAgICAgICAgY3VycmVudCA9IGZpbmFsX2RpciAvIGVudHJ5CiAgICAgICAgICAg
#0#ICAgICBpZiBjdXJyZW50LmV4aXN0cygpOgogICAgICAgICAgICAgICAgICAgIF9yZW1vdmVfcGF0
#0#aChjdXJyZW50KQogICAgICAgICAgICAgICAgX3JlbmFtZShvbGQsIGN1cnJlbnQpCiAgICAgICAg
#0#bWFya2VyLnVubGluaygpCiAgICAgICAgcHJpbnQoX3dhcm4oZiIgICBbPF0gcHVibGljYXRpb24g
#0#aW50ZXJyb21wdWUgZGUge2ZpbmFsX2Rpci5uYW1lfSAiCiAgICAgICAgICAgICAgICAgICAgZiJ7
#0#J3Rlcm1pbmVlJyBpZiBjb21taXR0ZWQgZWxzZSAnYW5udWxlZSd9IikpCiAgICAjIEEgcnVuIG9m
#0#IGFuIGVhcmxpZXIgcGlwZWxpbmUgdmVyc2lvbiBtb3ZlZCBicmlja3MvIGFzaWRlIGZvciBpdHMg
#0#d2hvbGUgZHVyYXRpb24KICAgICMgYW5kIGNvdWxkIGJlIGtpbGxlZCBiZWZvcmUgcHV0dGluZyB0
#0#aGVtIGJhY2suCiAgICBsZWdhY3kgPSBmaW5hbF9kaXIgLyBMRUdBQ1lfUk9MTEJBQ0sKICAgIGlm
#0#IGxlZ2FjeS5pc19kaXIoKSBhbmQgbm90IChmaW5hbF9kaXIgLyAiYnJpY2tzIikuZXhpc3RzKCk6
#0#CiAgICAgICAgX3JlbmFtZShsZWdhY3ksIGZpbmFsX2RpciAvICJicmlja3MiKQogICAgICAgIHBy
#0#aW50KF93YXJuKGYiICAgWzxdIGJyaWNrcy8gcHJlY2VkZW50IHJlc3RhdXJlIHBvdXIge2ZpbmFs
#0#X2Rpci5uYW1lfSIpKQoKCmRlZiBfbWVyZ2Vfd2l0aF9wdWJsaXNoZWQoc3RhZ2VfZGlyOiBQYXRo
#0#LCBmaW5hbF9kaXI6IFBhdGgpIC0+IE5vbmU6CiAgICAiIiJSZS1hcHBseSB0aGUgY3VyYXRpb24g
#0#b2YgdGhlIHB1Ymxpc2hlZCBtZXRhZGF0YS5qc29uIGF0IHRoZSBsYXN0IG1vbWVudDogdGhlCiAg
#0#ICBvcGVyYXRvciBtYXkgaGF2ZSBlZGl0ZWQgaXQgKGhpZGRlbiBpdCwgcmVjYWxpYnJhdGVkIGl0
#0#KSB3aGlsZSB0aGUgcnVuIHdhcyBidXN5LiIiIgogICAgcHVibGlzaGVkID0gZmluYWxfZGlyIC8g
#0#Im1ldGFkYXRhLmpzb24iCiAgICBpZiBub3QgcHVibGlzaGVkLmlzX2ZpbGUoKToKICAgICAgICBy
#0#ZXR1cm4KICAgIGV4aXN0aW5nID0gcmVhZF9qc29uX2ZpbGUocHVibGlzaGVkKQogICAgaWYgbm90
#0#IGV4aXN0aW5nOgogICAgICAgIHJldHVybgogICAgY2F0YWxvZyA9IGxvYWRfc3RlcCgiNC1jYXRh
#0#bG9nX2dlbmVyYXRvci5weSIsICJsdW1lbl9jYXRhbG9nX2dlbmVyYXRvciIpCiAgICBzdGFnZWQg
#0#PSBzdGFnZV9kaXIgLyAibWV0YWRhdGEuanNvbiIKICAgIG1lcmdlZCA9IGNhdGFsb2cubWVyZ2Vf
#0#dm9sdW1lX21ldGFkYXRhKGV4aXN0aW5nLCByZWFkX2pzb25fZmlsZShzdGFnZWQpKQogICAgYXRv
#0#bWljX3dyaXRlX2pzb24oc3RhZ2VkLCBtZXJnZWQsIGluZGVudD0yLCBlbnN1cmVfYXNjaWk9RmFs
#0#c2UpCgoKZGVmIHB1Ymxpc2hfZGF0YXNldChzdGFnZV9kaXI6IFBhdGgsIGZpbmFsX2RpcjogUGF0
#0#aCkgLT4gTm9uZToKICAgICIiIk1vdmUgYSBjb21wbGV0ZSBzdGFnZWQgZGF0YXNldCBpbnRvIERB
#0#VEFfV0VCLCBtZXRhZGF0YS5qc29uIGxhc3QuCgogICAgQSBuZXcgZGF0YXNldCBhcHBlYXJzIGlu
#0#IG9uZSByZW5hbWUuIEFuIGV4aXN0aW5nIG9uZSBoYXMgaXRzIHBpcGVsaW5lIGVudHJpZXMKICAg
#0#IHN3YXBwZWQ6IHRoZSBvbGQgb25lcyBhcmUgcmVuYW1lZCBhc2lkZSwgdGhlIG5ldyBvbmVzIG1v
#0#dmVkIGluLCB0aGVuIG1ldGFkYXRhLmpzb24KICAgIGlzIHJlcGxhY2VkIOKAlCB0aGUgY29tbWl0
#0#IHBvaW50LiBBbnkgZmFpbHVyZSBiZWZvcmUgaXQgcHV0cyBldmVyeXRoaW5nIGJhY2suCiAgICAi
#0#IiIKICAgIHN0YWdlZF9tZXRhID0gc3RhZ2VfZGlyIC8gIm1ldGFkYXRhLmpzb24iCiAgICBpZiBu
#0#b3Qgc3RhZ2VkX21ldGEuaXNfZmlsZSgpOgogICAgICAgIHJhaXNlIFJ1bnRpbWVFcnJvcihmIntz
#0#dGFnZV9kaXJ9IG4nYSBwYXMgZGUgbWV0YWRhdGEuanNvbiDigJQgcmllbiBhIHB1YmxpZXIiKQoK
#0#ICAgIGlmIG5vdCBmaW5hbF9kaXIuZXhpc3RzKCk6CiAgICAgICAgZmluYWxfZGlyLnBhcmVudC5t
#0#a2RpcihwYXJlbnRzPVRydWUsIGV4aXN0X29rPVRydWUpCiAgICAgICAgX3JlbmFtZShzdGFnZV9k
#0#aXIsIGZpbmFsX2RpcikKICAgICAgICByZXR1cm4KCiAgICByZWNvdmVyX2ludGVycnVwdGVkX3B1
#0#Ymxpc2goZmluYWxfZGlyKQogICAgX21lcmdlX3dpdGhfcHVibGlzaGVkKHN0YWdlX2RpciwgZmlu
#0#YWxfZGlyKQoKICAgIGVudHJpZXMgPSBbZSBmb3IgZSBpbiBQSVBFTElORV9FTlRSSUVTIGlmIChz
#0#dGFnZV9kaXIgLyBlKS5leGlzdHMoKV0KICAgIGlmIChzdGFnZV9kaXIgLyAidHJhY2tzLmpzb24i
#0#KS5leGlzdHMoKToKICAgICAgICAjIEEgbmV3bHkgYXR0YWNoZWQgdHJhY2tpbmcgcmVwbGFjZXMg
#0#dGhlIHdob2xlIHByZXZpb3VzIHNldCwgaW5jbHVkaW5nIGEgc3VyZmFjZQogICAgICAgICMgdGhl
#0#IG5ldyBhbmFseXNpcyBubyBsb25nZXIgaGFzLgogICAgICAgIGVudHJpZXMgKz0gbGlzdChUUkFD
#0#S0lOR19FTlRSSUVTKQogICAgbWFya2VyID0gZmluYWxfZGlyIC8gU1dBUF9NQVJLRVIKICAgIGF0
#0#b21pY193cml0ZV9qc29uKG1hcmtlciwgeyJtZXRhZGF0YVNoYTI1NiI6IF9zaGEyNTZfZmlsZShz
#0#dGFnZWRfbWV0YSksICJlbnRyaWVzIjogZW50cmllc30pCgogICAgbW92ZWRfYXNpZGUsIGluc3Rh
#0#bGxlZCA9IFtdLCBbXQogICAgdHJ5OgogICAgICAgIGZvciBlbnRyeSBpbiBlbnRyaWVzOgogICAg
#0#ICAgICAgICBjdXJyZW50ID0gZmluYWxfZGlyIC8gZW50cnkKICAgICAgICAgICAgaWYgY3VycmVu
#0#dC5leGlzdHMoKToKICAgICAgICAgICAgICAgIHN0YWxlID0gZmluYWxfZGlyIC8gKGVudHJ5ICsg
#0#U1dBUF9TVUZGSVgpCiAgICAgICAgICAgICAgICBpZiBzdGFsZS5leGlzdHMoKToKICAgICAgICAg
#0#ICAgICAgICAgICBfcmVtb3ZlX3BhdGgoc3RhbGUpCiAgICAgICAgICAgICAgICBfcmVuYW1lKGN1
#0#cnJlbnQsIHN0YWxlKQogICAgICAgICAgICAgICAgbW92ZWRfYXNpZGUuYXBwZW5kKGVudHJ5KQog
#0#ICAgICAgIGZvciBlbnRyeSBpbiBlbnRyaWVzOgogICAgICAgICAgICBpZiAoc3RhZ2VfZGlyIC8g
#0#ZW50cnkpLmV4aXN0cygpOgogICAgICAgICAgICAgICAgX3JlbmFtZShzdGFnZV9kaXIgLyBlbnRy
#0#eSwgZmluYWxfZGlyIC8gZW50cnkpCiAgICAgICAgICAgICAgICBpbnN0YWxsZWQuYXBwZW5kKGVu
#0#dHJ5KQogICAgICAgIF9yZXRyeV9vcyhsYW1iZGE6IG9zLnJlcGxhY2Uoc3RhZ2VkX21ldGEsIGZp
#0#bmFsX2RpciAvICJtZXRhZGF0YS5qc29uIikpCiAgICBleGNlcHQgQmFzZUV4Y2VwdGlvbjoKICAg
#0#ICAgICBmb3IgZW50cnkgaW4gcmV2ZXJzZWQoaW5zdGFsbGVkKToKICAgICAgICAgICAgdHJ5Ogog
#0#ICAgICAgICAgICAgICAgX3JlbmFtZShmaW5hbF9kaXIgLyBlbnRyeSwgc3RhZ2VfZGlyIC8gZW50
#0#cnkpCiAgICAgICAgICAgIGV4Y2VwdCBPU0Vycm9yOgogICAgICAgICAgICAgICAgX3JlbW92ZV9w
#0#YXRoKGZpbmFsX2RpciAvIGVudHJ5KQogICAgICAgIGZvciBlbnRyeSBpbiByZXZlcnNlZChtb3Zl
#0#ZF9hc2lkZSk6CiAgICAgICAgICAgIF9yZW5hbWUoZmluYWxfZGlyIC8gKGVudHJ5ICsgU1dBUF9T
#0#VUZGSVgpLCBmaW5hbF9kaXIgLyBlbnRyeSkKICAgICAgICBtYXJrZXIudW5saW5rKCkKICAgICAg
#0#ICByYWlzZQogICAgbWFya2VyLnVubGluaygpCiAgICBmb3IgZW50cnkgaW4gbW92ZWRfYXNpZGU6
#0#CiAgICAgICAgX3JlbW92ZV9wYXRoKGZpbmFsX2RpciAvIChlbnRyeSArIFNXQVBfU1VGRklYKSkK
#0#ICAgIGlmIChmaW5hbF9kaXIgLyBMRUdBQ1lfUk9MTEJBQ0spLmV4aXN0cygpOgogICAgICAgIF9y
#0#ZW1vdmVfcGF0aChmaW5hbF9kaXIgLyBMRUdBQ1lfUk9MTEJBQ0spCgoKZGVmIGRhdGFzZXRfZm9s
#0#ZGVyX25hbWUoc3RlbTogc3RyLCB0eXBlX2RpcjogUGF0aCkgLT4gc3RyOgogICAgIiIiVGhlIGRh
#0#dGFzZXQgZm9sZGVyIGZvciBhIHNvdXJjZSBmaWxlLiBBIG5hbWUgdGhhdCBpcyBub3QgVVJMLXNh
#0#ZmUgaXMKICAgIHNsdWdpZmllZCwgdW5sZXNzIGEgZGF0YXNldCB3YXMgYWxyZWFkeSBwdWJsaXNo
#0#ZWQgdW5kZXIgdGhlIHJhdyBuYW1lIOKAlCBpdHMgaWQsCiAgICBsaW5rcyBhbmQgY3VyYXRpb24g
#0#c3RheSB3aGVyZSB0aGV5IGFyZS4iIiIKICAgIHNsdWcgPSBzbHVnaWZ5KHN0ZW0pIG9yICJkYXRh
#0#c2V0IgogICAgaWYgc2x1ZyAhPSBzdGVtIGFuZCAodHlwZV9kaXIgLyBzdGVtKS5pc19kaXIoKToK
#0#ICAgICAgICByZXR1cm4gc3RlbQogICAgcmV0dXJuIHNsdWcKCgpkZWYgcHJvY2Vzc19pbXNfZmls
#0#ZShpbXNfcGF0aDogUGF0aCwgb3V0cHV0X3Jvb3Q6IFBhdGgsIGlkeDogaW50ID0gMCwgdG90YWw6
#0#IGludCA9IDAsCiAgICAgICAgICAgICAgICAgICAgIHdpdGhfZG93bmxvYWRzOiBib29sID0gRmFs
#0#c2UsIHRyYWNraW5nOiBzdHIgPSAiYXV0byIpIC0+IGJvb2w6CiAgICAiIiJSdW4gdGhlIHdob2xl
#0#IHBpcGVsaW5lIG9uIG9uZSAuaW1zLiBSZXR1cm5zIFRydWUgb25jZSB0aGUgZGF0YXNldCBpcyBw
#0#dWJsaXNoZWQuIiIiCiAgICBkaXNwbGF5X25hbWUgPSBpbXNfcGF0aC5zdGVtCiAgICBjb3VudGVy
#0#ID0gZiJbe2lkeH0ve3RvdGFsfV0gIiBpZiB0b3RhbCBlbHNlICIiCiAgICBwcmludCgpCiAgICBw
#0#cmludChfaGRyKGYiPj4ge2NvdW50ZXJ9e2Rpc3BsYXlfbmFtZX0iKSkKICAgIHByaW50KF9kaW0o
#0#ZiIgICBzb3VyY2UgOiB7aW1zX3BhdGh9IikpCiAgICB0MCA9IGRhdGV0aW1lLm5vdygpCgogICAg
#0#dGVtcF9kaXIgPSBvdXRwdXRfcm9vdCAvIGYiLnRlbXBfcHJlcHJvY2Vzc197c2x1Z2lmeShkaXNw
#0#bGF5X25hbWUpIG9yICdkYXRhc2V0J30iCiAgICBpZiB0ZW1wX2Rpci5leGlzdHMoKToKICAgICAg
#0#ICBzaHV0aWwucm10cmVlKHRlbXBfZGlyKQogICAgdGVtcF9kaXIubWtkaXIocGFyZW50cz1UcnVl
#0#LCBleGlzdF9vaz1UcnVlKQoKICAgIHB1Ymxpc2hlZCA9IE5vbmUKICAgIHRyeToKICAgICAgICAj
#0#IFN0ZXAgMTogRXh0cmFjdGlvbiBvZiBtZXRhZGF0YQogICAgICAgIHRlbXBfbWV0YV9qc29uID0g
#0#dGVtcF9kaXIgLyAibWV0YS5qc29uIgogICAgICAgIHJ1bl9zdGVwKCIxLWltc19tZXRhZGF0YS5w
#0#eSIsIHN0cihpbXNfcGF0aCksIHN0cih0ZW1wX21ldGFfanNvbikpCgogICAgICAgICMgVGhlIGRh
#0#dGFzZXQgdHlwZSBmb2xsb3dzIHRoZSBhY3F1aXNpdGlvbjogYSBzdGFjayB3aXRoIG1vcmUgdGhh
#0#biBvbmUKICAgICAgICAjIHRpbWVwb2ludCBpcyBhIHRpbWVsYXBzZSBhbmQgYmVsb25ncyB1bmRl
#0#ciBsaXZlLywgd2hpY2ggaXMgd2hhdCBkcml2ZXMgdGhlCiAgICAgICAgIyB2aWV3ZXIncyB0aW1l
#0#bGluZS4gUmVzb2x2ZWQgaGVyZSBiZWNhdXNlIG9ubHkgc3RlcCAxIGtub3dzIHRoZSBmcmFtZSBj
#0#b3VudC4KICAgICAgICAjIFRoZSBkaXJlY3RvcnkgbmFtZSBJUyB0aGUgZGF0YXNldCB0eXBlIOKA
#0#lCBzdGVwIDQgcmVhZHMgaXQgYmFjayBvZmYgZGlzay4KICAgICAgICB3aXRoIG9wZW4odGVtcF9t
#0#ZXRhX2pzb24sICJyIiwgZW5jb2Rpbmc9InV0Zi04IikgYXMgZm06CiAgICAgICAgICAgIG5fdGlt
#0#ZXBvaW50cyA9IGludChqc29uLmxvYWQoZm0pLmdldCgibl90aW1lcG9pbnRzIiwgMSkgb3IgMSkK
#0#ICAgICAgICBkYXRhc2V0X3R5cGUgPSAibGl2ZSIgaWYgbl90aW1lcG9pbnRzID4gMSBlbHNlICIz
#0#ZCIKICAgICAgICBkYXRhc2V0X25hbWUgPSBkYXRhc2V0X2ZvbGRlcl9uYW1lKGRpc3BsYXlfbmFt
#0#ZSwgb3V0cHV0X3Jvb3QgLyBkYXRhc2V0X3R5cGUpCiAgICAgICAgZmluYWxfZGlyID0gb3V0cHV0
#0#X3Jvb3QgLyBkYXRhc2V0X3R5cGUgLyBkYXRhc2V0X25hbWUKICAgICAgICBpZiBmaW5hbF9kaXIu
#0#ZXhpc3RzKCk6CiAgICAgICAgICAgICMgQSBwcmV2aW91cyBydW4ga2lsbGVkIG1pZC1wdWJsaXNo
#0#OiBwdXQgdGhlIGRhdGFzZXQgYmFjayBpbiBvbmUgcGllY2Ugbm93LAogICAgICAgICAgICAjIG5v
#0#dCBob3VycyBmcm9tIG5vdyB3aGVuIHRoaXMgcnVuIHB1Ymxpc2hlcy4KICAgICAgICAgICAgcmVj
#0#b3Zlcl9pbnRlcnJ1cHRlZF9wdWJsaXNoKGZpbmFsX2RpcikKICAgICAgICBzdGFnZV9kaXIgPSB0
#0#ZW1wX2RpciAvICJzdGFnZSIgLyBkYXRhc2V0X3R5cGUgLyBkYXRhc2V0X25hbWUKICAgICAgICBz
#0#dGFnZV9kaXIubWtkaXIocGFyZW50cz1UcnVlKQogICAgICAgIHByaW50KF9kaW0oZiIgICB0eXBl
#0#ICAgOiB7ZGF0YXNldF90eXBlfSIKICAgICAgICAgICAgICAgICAgICsgKGYiICh7bl90aW1lcG9p
#0#bnRzfSB0aW1lcG9pbnRzKSIgaWYgbl90aW1lcG9pbnRzID4gMSBlbHNlICIiKSkpCiAgICAgICAg
#0#aWYgZGF0YXNldF9uYW1lICE9IGRpc3BsYXlfbmFtZToKICAgICAgICAgICAgcHJpbnQoX2RpbShm
#0#IiAgIGRvc3NpZXI6IHtkYXRhc2V0X25hbWV9IChub20gc291cmNlIG5vbiB1dGlsaXNhYmxlIHRl
#0#bCBxdWVsIGRhbnMgdW5lIFVSTCkiKSkKCiAgICAgICAgIyBTdGVwIDI6IE5vcm1hbGl6YXRpb24s
#0#IEJhY2tncm91bmQgc3VidHJhY3Rpb24sIERvd25zY2FsaW5nIOKAlCBlYWNoIHRpbWVwb2ludCBp
#0#cwogICAgICAgICMgcGFja2VkIGludG8gdGhlIHN0YWdpbmcgdHJlZSBhcyBzb29uIGFzIGl0IGlz
#0#IGxldmVsbGVkLCBzbyB0aGUgdGVtcG9yYXJ5CiAgICAgICAgIyBkaXNrIG5ldmVyIGhvbGRzIG1v
#0#cmUgdGhhbiBvbmUgZnJhbWUncyBMT0Qgc2V0LgogICAgICAgIHJ1bl9zdGVwKCIyLWltYWdlX3By
#0#b2Nlc3Nvci5weSIsIHN0cihpbXNfcGF0aCksIHN0cih0ZW1wX21ldGFfanNvbiksIHN0cih0ZW1w
#0#X2RpciksCiAgICAgICAgICAgICAgICAgIi0tcGFjay1pbnRvIiwgc3RyKHN0YWdlX2RpcikpCgog
#0#ICAgICAgICMgU3RlcCAzOiBDb21wdXRlIHRodW1ibmFpbCBNSVAKICAgICAgICB3aXRoIG9wZW4o
#0#dGVtcF9kaXIgLyAicHJvY2Vzc2luZ19tZXRhLmpzb24iLCAiciIsIGVuY29kaW5nPSJ1dGYtOCIp
#0#IGFzIGZtOgogICAgICAgICAgICBwcm9jX21ldGEgPSBqc29uLmxvYWQoZm0pCiAgICAgICAgYnVp
#0#bGRfdGh1bWJuYWlsKHRlbXBfZGlyLCBzdGFnZV9kaXIsIHByb2NfbWV0YSkKCiAgICAgICAgIyBT
#0#dGVwIDQ6IENodW5raW5nIDY0wrMgJiBQYWNrIGJ1aWxkaW5nIChtYW5pZmVzdCBvZiB0aGUgcGFj
#0#a3Mgc3RlcCAyIHdyb3RlKQogICAgICAgIHJ1bl9zdGVwKCIzLWNodW5rX3BhY2tlci5weSIsIHN0
#0#cih0ZW1wX2RpciksIHN0cihzdGFnZV9kaXIpKQoKICAgICAgICAjIFN0ZXAgNTogQ2F0YWxvZyBt
#0#ZXRhZGF0YSwgbWVyZ2VkIHdpdGggdGhlIGN1cmF0aW9uIG9mIHRoZSBwdWJsaXNoZWQgb25lCiAg
#0#ICAgICAgcnVuX3N0ZXAoIjQtY2F0YWxvZ19nZW5lcmF0b3IucHkiLCBzdHIodGVtcF9kaXIpLCBz
#0#dHIoc3RhZ2VfZGlyKSwKICAgICAgICAgICAgICAgICAiLS1leGlzdGluZyIsIHN0cihmaW5hbF9k
#0#aXIgLyAibWV0YWRhdGEuanNvbiIpLAogICAgICAgICAgICAgICAgICItLWRpc3BsYXktbmFtZSIs
#0#IGRpc3BsYXlfbmFtZSkKCiAgICAgICAgIyBTdGVwIDY6IGNlbGwgdHJhY2tpbmcsIHdoZW4gdGhl
#0#IGFjcXVpc2l0aW9uIGhhcyBvbmUuIE9ubHkgYSB0aW1lbGFwc2UgY2FuIGNhcnJ5CiAgICAgICAg
#0#IyB0cmFqZWN0b3JpZXMsIGFuZCB0aGUgc3RlcCBuZWVkcyB0aGUgbWV0YWRhdGEuanNvbiBzdGVw
#0#IDQganVzdCB3cm90ZS4KICAgICAgICBpZiBuX3RpbWVwb2ludHMgPiAxOgogICAgICAgICAgICBh
#0#dHRhY2hfdHJhY2tpbmcoaW1zX3BhdGgsIHN0YWdlX2RpciwgdGVtcF9kaXIsIGRhdGFzZXRfbmFt
#0#ZSwgdHJhY2tpbmcpCgogICAgICAgIHB1Ymxpc2hfZGF0YXNldChzdGFnZV9kaXIsIGZpbmFsX2Rp
#0#cikKICAgICAgICBwdWJsaXNoZWQgPSBmaW5hbF9kaXIKICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMg
#0#ZToKICAgICAgICBwcmludChfZXJyKGYiICAgW1hdIHtkaXNwbGF5X25hbWV9IDoge2V9IiksIGZp
#0#bGU9c3lzLnN0ZGVycikKICAgICAgICB0cmFjZWJhY2sucHJpbnRfZXhjKCkKICAgICAgICBwcmlu
#0#dChfd2FybigiICAgWzxdIGxlIGRhdGFzZXQgcHVibGllIChzJ2lsIGV4aXN0ZSkgZXN0IGluY2hh
#0#bmdlIiksIGZpbGU9c3lzLnN0ZGVycikKICAgIGZpbmFsbHk6CiAgICAgICAgIyBpZ25vcmVfZXJy
#0#b3JzOiBvbiBhIEN0cmwrQyB0ZWFyZG93biBhIGp1c3Qta2lsbGVkIHdvcmtlciBtYXkgc3RpbGwg
#0#aG9sZCBhCiAgICAgICAgIyBoYW5kbGUgZm9yIGEgZmV3IG1zIOKAlCBuZXZlciBsZXQgY2xlYW51
#0#cCBtYXNrIHRoZSBpbnRlcnJ1cHRpb24uCiAgICAgICAgaWYgdGVtcF9kaXIuZXhpc3RzKCk6CiAg
#0#ICAgICAgICAgIHNodXRpbC5ybXRyZWUodGVtcF9kaXIsIGlnbm9yZV9lcnJvcnM9VHJ1ZSkKCiAg
#0#ICBpZiBwdWJsaXNoZWQgaXMgTm9uZToKICAgICAgICByZXR1cm4gRmFsc2UKCiAgICAjIFN0ZXAg
#0#NyAob3B0aW9uYWwpOiBkb3dubG9hZC8gYnVuZGxlIOKAlCBhcmNoaXZlLCBvcmlnaW5hbCAuaW1z
#0#LCBJbWFnZUogVElGRiwKICAgICMgcGVyLWNoYW5uZWwgTUlQcywgUkVBRE1FLiBBbiBleHRyYSBv
#0#biB0b3Agb2YgYSBkYXRhc2V0IHRoYXQgaXMgYWxyZWFkeQogICAgIyBwdWJsaXNoZWQgYW5kIGNv
#0#bXBsZXRlOiBpdHMgZmFpbHVyZSBpcyByZXBvcnRlZCBhbmQgbmV2ZXIgdW5kb2VzIHRoZSBkYXRh
#0#c2V0LgogICAgaWYgd2l0aF9kb3dubG9hZHM6CiAgICAgICAgZGxfc2NyaXB0ID0gX3Jlc29sdmVf
#0#ZG93bmxvYWRfc2NyaXB0KCkKICAgICAgICBpZiBkbF9zY3JpcHQgaXMgTm9uZToKICAgICAgICAg
#0#ICAgcHJpbnQoX3dhcm4oZiIgICBbIV0ge0RPV05MT0FEX1NDUklQVF9OQU1FfSBpbnRyb3V2YWJs
#0#ZSDigJQgZG93bmxvYWQvIGlnbm9yZSIpKQogICAgICAgIGVsc2U6CiAgICAgICAgICAgIHRyeToK
#0#ICAgICAgICAgICAgICAgIHJ1bl9zY3JpcHQoZGxfc2NyaXB0LAogICAgICAgICAgICAgICAgICAg
#0#ICAgICAgICAiLS1kYXRhLXdlYiIsIHN0cihvdXRwdXRfcm9vdCksCiAgICAgICAgICAgICAgICAg
#0#ICAgICAgICAgICItLXJhdy1kaXIiLCBzdHIoaW1zX3BhdGgucGFyZW50KSwKICAgICAgICAgICAg
#0#ICAgICAgICAgICAgICAgIi0tZGF0YXNldCIsIGYie3B1Ymxpc2hlZC5wYXJlbnQubmFtZX0ve3B1
#0#Ymxpc2hlZC5uYW1lfSIsCiAgICAgICAgICAgICAgICAgICAgICAgICAgICItLWltcyIsIHN0cihp
#0#bXNfcGF0aCksCiAgICAgICAgICAgICAgICAgICAgICAgICAgIGxhYmVsPSJkb3dubG9hZC8gKGFy
#0#Y2hpdmUsIEltYWdlSiBUSUZGLCBNSVApIikKICAgICAgICAgICAgZXhjZXB0IHN1YnByb2Nlc3Mu
#0#Q2FsbGVkUHJvY2Vzc0Vycm9yIGFzIGV4YzoKICAgICAgICAgICAgICAgIHByaW50KF93YXJuKGYi
#0#ICAgWyFdIGRvd25sb2FkLyBpbmNvbXBsZXQgKGNvZGUge2V4Yy5yZXR1cm5jb2RlfSkg4oCUICIK
#0#ICAgICAgICAgICAgICAgICAgICAgICAgICAgIGYibGUgZGF0YXNldCBwdWJsaWUgcmVzdGUgdXRp
#0#bGlzYWJsZSIpKQoKICAgIGVsYXBzZWQgPSAoZGF0ZXRpbWUubm93KCkgLSB0MCkudG90YWxfc2Vj
#0#b25kcygpCiAgICBwcmludChfb2soZiIgICBbT0tdIHtkaXNwbGF5X25hbWV9IHRlcm1pbmUgZW4g
#0#e2VsYXBzZWQ6LjBmfXMiKSkKICAgIHJldHVybiBUcnVlCgoKZGVmIF9mb2xkZXJfY29sbGlzaW9u
#0#cyhpbXNfZmlsZXMpIC0+IGRpY3Q6CiAgICAiIiJTb3VyY2UgZmlsZXMgd2hvc2UgZm9sZGVyIG5h
#0#bWVzIHdvdWxkIGNvaW5jaWRlIChXaW5kb3dzIGZvbGRlcnMgaWdub3JlIGNhc2UpLAogICAgbWFw
#0#cGVkIHRvIHRoZSBlYXJsaWVyIGZpbGUgdGhhdCBjbGFpbXMgdGhlIG5hbWUuIiIiCiAgICBjbGFp
#0#bWVkLCBjbGFzaGVzID0ge30sIHt9CiAgICBmb3IgcGF0aCBpbiBpbXNfZmlsZXM6CiAgICAgICAg
#0#a2V5ID0gKHNsdWdpZnkocGF0aC5zdGVtKSBvciAiZGF0YXNldCIpLmNhc2Vmb2xkKCkKICAgICAg
#0#ICBpZiBrZXkgaW4gY2xhaW1lZDoKICAgICAgICAgICAgY2xhc2hlc1twYXRoXSA9IGNsYWltZWRb
#0#a2V5XQogICAgICAgIGVsc2U6CiAgICAgICAgICAgIGNsYWltZWRba2V5XSA9IHBhdGgKICAgIHJl
#0#dHVybiBjbGFzaGVzCgoKZGVmIG1haW4oKToKICAgIHBhcnNlciA9IGFyZ3BhcnNlLkFyZ3VtZW50
#0#UGFyc2VyKGRlc2NyaXB0aW9uPSJJUklCSE0gTWljcm9zY29weSBQcmVwcm9jZXNzaW5nIFVuaWZp
#0#ZWQgUGlwZWxpbmUiKQogICAgcGFyc2VyLmFkZF9hcmd1bWVudCgiLS1pbnB1dCIsIHJlcXVpcmVk
#0#PVRydWUsIGhlbHA9IklucHV0IGRpcmVjdG9yeSBjb250YWluaW5nIHJhdyAuaW1zIGZpbGVzLiIp
#0#CiAgICBwYXJzZXIuYWRkX2FyZ3VtZW50KCItLW91dHB1dCIsIHJlcXVpcmVkPVRydWUsIGhlbHA9
#0#Ik91dHB1dCBEQVRBX1dFQiBkaXJlY3Rvcnkgb2YgdGhlIHdlYiBwbGF0Zm9ybS4iKQogICAgcGFy
#0#c2VyLmFkZF9hcmd1bWVudCgiLS1vbmx5IiwgZGVmYXVsdD1Ob25lLCBoZWxwPSJHbG9iIHBhdHRl
#0#cm4gdG8gZmlsdGVyIGZpbGVzIHRvIHByb2Nlc3MgKGUuZy4gJypFOConKS4iKQogICAgcGFyc2Vy
#0#LmFkZF9hcmd1bWVudCgiLS13aXRoLWRvd25sb2FkcyIsIGFjdGlvbj0ic3RvcmVfdHJ1ZSIsCiAg
#0#ICAgICAgICAgICAgICAgICAgICAgIGhlbHA9IkFmdGVyIGVhY2ggZGF0YXNldCwgYWxzbyBidWls
#0#ZCBpdHMgZG93bmxvYWQvIGJ1bmRsZSAiCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIih3
#0#ZWIgYXJjaGl2ZSwgb3JpZ2luYWwgLmltcywgSW1hZ2VKIFRJRkYsIHBlci1jaGFubmVsIE1JUCwg
#0#UkVBRE1FKS4iKQogICAgcGFyc2VyLmFkZF9hcmd1bWVudCgiLS10cmFja2luZyIsIGRlZmF1bHQ9
#0#ImF1dG8iLCBtZXRhdmFyPSJhdXRvfG9mZnxGSUxFIiwKICAgICAgICAgICAgICAgICAgICAgICAg
#0#aGVscD0iQ2VsbCB0cmFja2luZyBmb3IgdGltZWxhcHNlIGRhdGFzZXRzLiAnYXV0bycgKGRlZmF1
#0#bHQpIGxvb2tzIGZvciAiCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgImEgLmltYXJpc190
#0#cmFjayBiZXNpZGUgdGhlIHZvbHVtZSwgdGhlbiB0aGUgSW1hcmlzIG9iamVjdHMgaW5zaWRlICIK
#0#ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAidGhlIC5pbXMgaXRzZWxmLCB0aGVuIHRoZSBl
#0#eHBvcnRlZCAueGxzLy54bHN4IHN0YXRpc3RpY3MuICdvZmYnICIKICAgICAgICAgICAgICAgICAg
#0#ICAgICAgICAgICAic2tpcHMgaXQuIEEgcGF0aCBmb3JjZXMgdGhhdCBmaWxlIGZvciBldmVyeSBk
#0#YXRhc2V0IHByb2Nlc3NlZC4iKQogICAgYXJncyA9IHBhcnNlci5wYXJzZV9hcmdzKCkKCiAgICBp
#0#bnB1dF9kaXIgPSBQYXRoKGFyZ3MuaW5wdXQpCiAgICBvdXRwdXRfZGlyID0gUGF0aChhcmdzLm91
#0#dHB1dCkKCiAgICBpZiBub3QgaW5wdXRfZGlyLmlzX2RpcigpOgogICAgICAgIHN5cy5leGl0KGYi
#0#W0ZBVEFMXSBJbnB1dCBkaXJlY3Rvcnkgbm90IGZvdW5kOiB7aW5wdXRfZGlyfSIpCiAgICAgICAg
#0#CiAgICBvdXRwdXRfZGlyLm1rZGlyKHBhcmVudHM9VHJ1ZSwgZXhpc3Rfb2s9VHJ1ZSkKCiAgICAj
#0#IEdsb2IgSU1TIGZpbGVzCiAgICBpbXNfZmlsZXMgPSBzb3J0ZWQoaW5wdXRfZGlyLmdsb2IoIiou
#0#aW1zIikpCiAgICBpZiBhcmdzLm9ubHk6CiAgICAgICAgaW1zX2ZpbGVzID0gW3AgZm9yIHAgaW4g
#0#aW1zX2ZpbGVzIGlmIGZubWF0Y2guZm5tYXRjaChwLm5hbWUsIGFyZ3Mub25seSldCgogICAgaWYg
#0#bm90IGltc19maWxlczoKICAgICAgICBwcmludChfd2FybihmIkF1Y3VuIGZpY2hpZXIgLmltcyBj
#0#b3JyZXNwb25kYW50IGRhbnMge2lucHV0X2Rpcn0iKSkKICAgICAgICBzeXMuZXhpdCgwKQoKICAg
#0#IHByaW50KCkKICAgIHByaW50KF9oZHIoIiAgUGlwZWxpbmUgZGUgcHJlcHJvY2Vzc2luZyAgIikg
#0#KyBfZGltKGYidntfX3ZlcnNpb25fX30iKSkKICAgIHByaW50KF9kaW0oZiIgIHNvdXJjZSAgICAg
#0#IDoge2lucHV0X2Rpcn0iKSkKICAgIHByaW50KF9kaW0oZiIgIGRlc3RpbmF0aW9uIDoge291dHB1
#0#dF9kaXJ9IikpCiAgICBwcmludChfZGltKGYiICBkYXRhc2V0cyAgICA6IHtsZW4oaW1zX2ZpbGVz
#0#KX0gICAoZmlsdHJlOiB7YXJncy5vbmx5IG9yICcqJ30pIikpCiAgICBwcmludChfZGltKGYiICBk
#0#b3dubG9hZC8gICA6IHsnb3VpJyBpZiBhcmdzLndpdGhfZG93bmxvYWRzIGVsc2UgJ25vbid9Iikp
#0#CiAgICBwcmludChfZGltKGYiICB0cmFja2luZyAgICA6IHthcmdzLnRyYWNraW5nfSIpKQoKICAg
#0#ICMgR3JhY2VmdWwgQ3RybCtDOiBjb25maXJtIHdpdGggdGhlIHVzZXIsIHRoZW4gdGVhciB0aGUg
#0#cnVubmluZyBzdGVwIGRvd24gY2xlYW5seS4KICAgIF9pbnN0YWxsX3NpZ2ludF9oYW5kbGVyKCkK
#0#CiAgICAjIFR3byBpbnB1dHMgdGhhdCB3b3VsZCBsYW5kIGluIHRoZSBzYW1lIGZvbGRlciBtdXN0
#0#IG5vdCBvdmVyd3JpdGUgZWFjaCBvdGhlcjogdGhlCiAgICAjIGZpcnN0IG9uZSBjbGFpbXMgdGhl
#0#IG5hbWUsIHRoZSBzZWNvbmQgaXMgcmVmdXNlZCBhbmQgbmFtZWQuCiAgICBjbGFzaGVzID0gX2Zv
#0#bGRlcl9jb2xsaXNpb25zKGltc19maWxlcykKCiAgICAjIE9uZSBkYXRhc2V0IGF0IGEgdGltZSAo
#0#Ym91bmRlZCBSQU0pIOKAlCBlYWNoIHN0ZXAgYWxyZWFkeSBtdWx0aXRocmVhZHMgaW50ZXJuYWxs
#0#eS4KICAgIGludGVycnVwdGVkID0gRmFsc2UKICAgIGZhaWxlZCA9IFtdCiAgICBmb3IgaSwgaW1z
#0#X2ZpbGUgaW4gZW51bWVyYXRlKGltc19maWxlcyk6CiAgICAgICAgaWYgaW1zX2ZpbGUgaW4gY2xh
#0#c2hlczoKICAgICAgICAgICAgcHJpbnQoX2VycihmIiAgIFtYXSB7aW1zX2ZpbGUubmFtZX0gOiBt
#0#ZW1lIGRvc3NpZXIgZGUgZGVzdGluYXRpb24gcXVlICIKICAgICAgICAgICAgICAgICAgICAgICBm
#0#IntjbGFzaGVzW2ltc19maWxlXS5uYW1lfSDigJQgcmVub21tZXogbCd1biBkZXMgZGV1eCBmaWNo
#0#aWVycyIpKQogICAgICAgICAgICBmYWlsZWQuYXBwZW5kKGltc19maWxlLm5hbWUpCiAgICAgICAg
#0#ICAgIGNvbnRpbnVlCiAgICAgICAgdHJ5OgogICAgICAgICAgICBvayA9IHByb2Nlc3NfaW1zX2Zp
#0#bGUoaW1zX2ZpbGUsIG91dHB1dF9kaXIsIGkgKyAxLCBsZW4oaW1zX2ZpbGVzKSwKICAgICAgICAg
#0#ICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGhfZG93bmxvYWRzPWFyZ3Mud2l0aF9kb3dubG9h
#0#ZHMsIHRyYWNraW5nPWFyZ3MudHJhY2tpbmcpCiAgICAgICAgICAgIGlmIG5vdCBvazoKICAgICAg
#0#ICAgICAgICAgIGZhaWxlZC5hcHBlbmQoaW1zX2ZpbGUubmFtZSkKICAgICAgICBleGNlcHQgS2V5
#0#Ym9hcmRJbnRlcnJ1cHQ6CiAgICAgICAgICAgIGludGVycnVwdGVkID0gVHJ1ZQogICAgICAgICAg
#0#ICBicmVhawogICAgICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZXhjOgogICAgICAgICAgICBwcmlu
#0#dChfZXJyKGYiICAgW1hdIHtpbXNfZmlsZS5uYW1lfSA6IHtleGN9IikpCiAgICAgICAgICAgIGZh
#0#aWxlZC5hcHBlbmQoaW1zX2ZpbGUubmFtZSkKCiAgICBpZiBpbnRlcnJ1cHRlZDoKICAgICAgICAj
#0#IFJlbW92ZSBhbnkgaGFsZi13cml0dGVuIHRlbXAgZm9sZGVyIGxlZnQgYnkgdGhlIGFib3J0ZWQg
#0#ZGF0YXNldC4KICAgICAgICBmb3Igc3RyYXkgaW4gb3V0cHV0X2Rpci5nbG9iKCIudGVtcF9wcmVw
#0#cm9jZXNzXyoiKToKICAgICAgICAgICAgc2h1dGlsLnJtdHJlZShzdHJheSwgaWdub3JlX2Vycm9y
#0#cz1UcnVlKQogICAgICAgIHByaW50KCkKICAgICAgICBwcmludChfd2FybigiICBQaXBlbGluZSBp
#0#bnRlcnJvbXB1IHBhciBsJ3V0aWxpc2F0ZXVyIChDdHJsK0MpLiBFdGF0IG5ldHRveWUuIikpCiAg
#0#ICAgICAgc3lzLmV4aXQoMTMwKQoKICAgIHByaW50KCkKICAgIGlmIGZhaWxlZDoKICAgICAgICBw
#0#cmludChfZXJyKGYiICBQaXBlbGluZSB0ZXJtaW5lIDoge2xlbihmYWlsZWQpfSBkYXRhc2V0KHMp
#0#IGVuIGVjaGVjIOKAlCAiICsgIiwgIi5qb2luKGZhaWxlZCkpKQogICAgICAgIHN5cy5leGl0KDEp
#0#CiAgICBwcmludChfb2soIiAgUGlwZWxpbmUgdGVybWluZS4iKSkKCmlmIF9fbmFtZV9fID09ICJf
#0#X21haW5fXyI6CiAgICB0cnk6CiAgICAgICAgbWFpbigpCiAgICBleGNlcHQgS2V5Ym9hcmRJbnRl
#0#cnJ1cHQ6CiAgICAgICAgIyBDdHJsK0MgY29uZmlybWVkIG91dHNpZGUgYSBkYXRhc2V0IChlLmcu
#0#IGJldHdlZW4gc3RlcHMpIOKAlCBleGl0IGNsZWFubHkuCiAgICAgICAgcHJpbnQoX3dhcm4oIlxu
#0#WyFdIFBpcGVsaW5lIGFycmV0ZS4iKSwgZmlsZT1zeXMuc3RkZXJyKQogICAgICAgIHN5cy5leGl0
#0#KDEzMCkK
:: ---- [1] 1-ims_metadata.py (6848 octets) ----
#1#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwppbXBvcnQganNvbgppbXBvcnQgcmUKaW1wb3J0IHN5cwpm
#1#cm9tIGRhdGV0aW1lIGltcG9ydCBkYXRldGltZQpmcm9tIHBhdGhsaWIgaW1wb3J0IFBhdGgKaW1w
#1#b3J0IGg1cHkKaW1wb3J0IG51bXB5IGFzIG5wCgpkZWYgYXR0cl9zdHIoZ3JvdXAsIGtleSwgZGVm
#1#YXVsdD0iIik6CiAgICBpZiBncm91cCBpcyBOb25lOgogICAgICAgIHJldHVybiBkZWZhdWx0CiAg
#1#ICB2ID0gZ3JvdXAuYXR0cnMuZ2V0KGtleSwgZGVmYXVsdCkKICAgIGlmIGlzaW5zdGFuY2Uodiwg
#1#KGJ5dGVzLCBucC5ieXRlc18pKToKICAgICAgICByZXR1cm4gdi5kZWNvZGUoInV0Zi04IiwgZXJy
#1#b3JzPSJyZXBsYWNlIikuc3RyaXAoKQogICAgaWYgaXNpbnN0YW5jZSh2LCBucC5uZGFycmF5KToK
#1#ICAgICAgICB0cnk6CiAgICAgICAgICAgIHJldHVybiBiIiIuam9pbihieXRlcyhjKSBpZiBpc2lu
#1#c3RhbmNlKGMsIChieXRlcywgbnAuYnl0ZXNfKSkKICAgICAgICAgICAgICAgICAgICAgICAgICAg
#1#IGVsc2UgYy50b2J5dGVzKCkgZm9yIGMgaW4gdgogICAgICAgICAgICAgICAgICAgICAgICAgICAp
#1#LmRlY29kZSgidXRmLTgiLCBlcnJvcnM9InJlcGxhY2UiKS5zdHJpcCgpCiAgICAgICAgZXhjZXB0
#1#IEV4Y2VwdGlvbjoKICAgICAgICAgICAgcmV0dXJuICIiLmpvaW4oCiAgICAgICAgICAgICAgICAo
#1#Yy5kZWNvZGUoInV0Zi04IiwgZXJyb3JzPSJyZXBsYWNlIikgaWYgaXNpbnN0YW5jZShjLCAoYnl0
#1#ZXMsIG5wLmJ5dGVzXykpIGVsc2Ugc3RyKGMpKQogICAgICAgICAgICAgICAgZm9yIGMgaW4gdgog
#1#ICAgICAgICAgICApLnN0cmlwKCkKICAgIHJldHVybiBzdHIodikuc3RyaXAoKQoKIyBJbWFyaXMg
#1#d3JpdGVzIHRoZSBleHRlbnQgaW4gdGhlIHVuaXQgb2YgRGF0YVNldEluZm8vSW1hZ2U6VW5pdDsg
#1#ZXZlcnl0aGluZyBkb3duc3RyZWFtCiMgKHZveGVsIHNpemVzLCBzY2FsZSBiYXJzLCB0cmFja2lu
#1#ZyByZWdpc3RyYXRpb24pIGlzIGluIG1pY3JvbWV0cmVzLgpVTklUX1RPX1VNID0geyJ1bSI6IDEu
#1#MCwgIsK1bSI6IDEuMCwgIs68bSI6IDEuMCwgIm1pY3JvbiI6IDEuMCwgIm1pY3JvbnMiOiAxLjAs
#1#CiAgICAgICAgICAgICAgIm1pY3JvbWV0ZXIiOiAxLjAsICJtaWNyb21ldHJlIjogMS4wLCAibm0i
#1#OiAxZS0zLCAibW0iOiAxZTMsICJtIjogMWU2fQoKCmRlZiByZWFkX2ltc19tZXRhZGF0YShmaWxl
#1#X3BhdGg6IFBhdGgpIC0+IGRpY3Q6CiAgICB3aXRoIGg1cHkuRmlsZShzdHIoZmlsZV9wYXRoKSwg
#1#InIiKSBhcyBmOgogICAgICAgIGluZm8gPSBmLmdldCgiRGF0YVNldEluZm8iLCB7fSkuZ2V0KCJJ
#1#bWFnZSIsIE5vbmUpCiAgICAgICAgCiAgICAgICAgd2lkdGggPSBpbnQoYXR0cl9zdHIoaW5mbywg
#1#IlgiLCAiMSIpIG9yIDEpCiAgICAgICAgaGVpZ2h0ID0gaW50KGF0dHJfc3RyKGluZm8sICJZIiwg
#1#IjEiKSBvciAxKQogICAgICAgIGRlcHRoID0gaW50KGF0dHJfc3RyKGluZm8sICJaIiwgIjEiKSBv
#1#ciAxKQoKICAgICAgICAjIFRoZSBleHRlbnQgaXMgdGhlIG9ubHkgY2FsaWJyYXRpb24gYW4gLmlt
#1#cyBjYXJyaWVzOiB2b3hlbCA9IChFeHRNYXggLSBFeHRNaW4pIC8gTi4KICAgICAgICAjIEFuIGF0
#1#dHJpYnV0ZSB0aGF0IGlzIGFic2VudCBvciB1bnJlYWRhYmxlIG11c3Qgbm90IGJlIHJlcGxhY2Vk
#1#IGJ5IGEgZ3Vlc3MKICAgICAgICAjICgwIGFuZCAxIHVzZWQgdG8gc3RhbmQgaW4sIGdpdmluZyBh
#1#IHZveGVsIG9mIDEvTiB1bSBsYWJlbGxlZCAiZXhhY3QiKSwgc28gYQogICAgICAgICMgbWlzc2lu
#1#ZyBheGlzIGxlYXZlcyB0aGUgd2hvbGUgY2FsaWJyYXRpb24gdW5kZWNsYXJlZC4KICAgICAgICBk
#1#ZWYgX2V4dChrZXkpOgogICAgICAgICAgICByYXcgPSBhdHRyX3N0cihpbmZvLCBrZXksICIiKQog
#1#ICAgICAgICAgICB0cnk6CiAgICAgICAgICAgICAgICByZXR1cm4gZmxvYXQocmF3KSBpZiByYXcg
#1#IT0gIiIgZWxzZSBOb25lCiAgICAgICAgICAgIGV4Y2VwdCBWYWx1ZUVycm9yOgogICAgICAgICAg
#1#ICAgICAgcmV0dXJuIE5vbmUKCiAgICAgICAgZXh0X21pbiA9IFtfZXh0KCJFeHRNaW4wIiksIF9l
#1#eHQoIkV4dE1pbjEiKSwgX2V4dCgiRXh0TWluMiIpXQogICAgICAgIGV4dF9tYXggPSBbX2V4dCgi
#1#RXh0TWF4MCIpLCBfZXh0KCJFeHRNYXgxIiksIF9leHQoIkV4dE1heDIiKV0KICAgICAgICB1bml0
#1#X3JhdyA9IGF0dHJfc3RyKGluZm8sICJVbml0IiwgInVtIikgb3IgInVtIgogICAgICAgIHRvX3Vt
#1#ID0gVU5JVF9UT19VTS5nZXQodW5pdF9yYXcuc3RyaXAoKS5sb3dlcigpKQogICAgICAgIGNhbGli
#1#cmF0ZWQgPSB0b191bSBpcyBub3QgTm9uZSBhbmQgTm9uZSBub3QgaW4gZXh0X21pbiBhbmQgTm9u
#1#ZSBub3QgaW4gZXh0X21heAogICAgICAgIGlmIGNhbGlicmF0ZWQ6CiAgICAgICAgICAgIGV4dF9t
#1#aW4gPSBbdiAqIHRvX3VtIGZvciB2IGluIGV4dF9taW5dCiAgICAgICAgICAgIGV4dF9tYXggPSBb
#1#diAqIHRvX3VtIGZvciB2IGluIGV4dF9tYXhdCiAgICAgICAgICAgIHZveF94ID0gKGV4dF9tYXhb
#1#MF0gLSBleHRfbWluWzBdKSAvIG1heCh3aWR0aCwgMSkKICAgICAgICAgICAgdm94X3kgPSAoZXh0
#1#X21heFsxXSAtIGV4dF9taW5bMV0pIC8gbWF4KGhlaWdodCwgMSkKICAgICAgICAgICAgdm94X3og
#1#PSAoZXh0X21heFsyXSAtIGV4dF9taW5bMl0pIC8gbWF4KGRlcHRoLCAxKQogICAgICAgIGVsc2U6
#1#CiAgICAgICAgICAgIGlmIHRvX3VtIGlzIE5vbmU6CiAgICAgICAgICAgICAgICBwcmludChmIltN
#1#RVRBREFUQV0gdW5pdGUgZCdleHRlbnQgaW5jb25udWUge3VuaXRfcmF3IXJ9IDogY2FsaWJyYXRp
#1#b24gaWdub3JlZSIsCiAgICAgICAgICAgICAgICAgICAgICBmaWxlPXN5cy5zdGRlcnIpCiAgICAg
#1#ICAgICAgIGVsc2U6CiAgICAgICAgICAgICAgICBwcmludCgiW01FVEFEQVRBXSBFeHRNaW4vRXh0
#1#TWF4IGluY29tcGxldHMgOiBjYWxpYnJhdGlvbiBub24gZGVjbGFyZWUiLAogICAgICAgICAgICAg
#1#ICAgICAgICAgZmlsZT1zeXMuc3RkZXJyKQogICAgICAgICAgICB2b3hfeCA9IHZveF95ID0gdm94
#1#X3ogPSAwLjAKCiAgICAgICAgcmVzMCA9IGYuZ2V0KCJEYXRhU2V0Iiwge30pLmdldCgiUmVzb2x1
#1#dGlvbkxldmVsIDAiLCB7fSkKICAgICAgICB0aW1lcG9pbnRzID0gc29ydGVkKAogICAgICAgICAg
#1#ICBbayBmb3IgayBpbiByZXMwLmtleXMoKSBpZiBrLnN0YXJ0c3dpdGgoIlRpbWVQb2ludCIpXSwK
#1#ICAgICAgICAgICAga2V5PWxhbWJkYSB4OiBpbnQoeC5zcGxpdCgpWy0xXSkKICAgICAgICApCiAg
#1#ICAgICAgbl90cCA9IGxlbih0aW1lcG9pbnRzKSBvciAxCgogICAgICAgICMgQWNxdWlzaXRpb24g
#1#Y2xvY2suIEltYXJpcyBzdG9yZXMgb25lIGF0dHJpYnV0ZSBwZXIgZnJhbWUgdW5kZXIKICAgICAg
#1#ICAjIERhdGFTZXRJbmZvL1RpbWVJbmZvIGFzICJUaW1lUG9pbnQxIi4uIlRpbWVQb2ludE4iICgx
#1#LWJhc2VkKSwgZm9ybWF0dGVkCiAgICAgICAgIyAiWVlZWS1NTS1ERCBISDpNTTpTUy5tbW0iLiBB
#1#IHRpbWVsYXBzZSB2aWV3ZXIgbmVlZHMgdGhlIHJlYWwgd2FsbC1jbG9jawogICAgICAgICMgdGlt
#1#ZXMsIG5vdCBqdXN0IGZyYW1lIGluZGljZXMsIGFuZCB0aGUgbWVkaWFuIGludGVyLWZyYW1lIGdh
#1#cCBpcyB3aGF0IHRoZQogICAgICAgICMgVUkgbGFiZWxzIHRoZSBhY3F1aXNpdGlvbiBpbnRlcnZh
#1#bCB3aXRoLgogICAgICAgIHRpbWVfaW5mbyA9IGYuZ2V0KCJEYXRhU2V0SW5mbyIsIHt9KS5nZXQo
#1#IlRpbWVJbmZvIiwgTm9uZSkKICAgICAgICB0aW1lc3RhbXBzID0gW10KICAgICAgICBmb3IgaSBp
#1#biByYW5nZSgxLCBuX3RwICsgMSk6CiAgICAgICAgICAgIHN0YW1wID0gYXR0cl9zdHIodGltZV9p
#1#bmZvLCBmIlRpbWVQb2ludHtpfSIsICIiKSBpZiB0aW1lX2luZm8gaXMgbm90IE5vbmUgZWxzZSAi
#1#IgogICAgICAgICAgICB0aW1lc3RhbXBzLmFwcGVuZChzdGFtcCBvciBOb25lKQogICAgICAgIGlu
#1#dGVydmFsX21pbnV0ZXMgPSBOb25lCiAgICAgICAgcGFyc2VkID0gW10KICAgICAgICBmb3Igc3Rh
#1#bXAgaW4gdGltZXN0YW1wczoKICAgICAgICAgICAgaWYgbm90IHN0YW1wOgogICAgICAgICAgICAg
#1#ICAgcGFyc2VkLmFwcGVuZChOb25lKQogICAgICAgICAgICAgICAgY29udGludWUKICAgICAgICAg
#1#ICAgdHJ5OgogICAgICAgICAgICAgICAgcGFyc2VkLmFwcGVuZChkYXRldGltZS5zdHJwdGltZShz
#1#dGFtcCwgIiVZLSVtLSVkICVIOiVNOiVTLiVmIikpCiAgICAgICAgICAgIGV4Y2VwdCBWYWx1ZUVy
#1#cm9yOgogICAgICAgICAgICAgICAgdHJ5OgogICAgICAgICAgICAgICAgICAgIHBhcnNlZC5hcHBl
#1#bmQoZGF0ZXRpbWUuc3RycHRpbWUoc3RhbXAsICIlWS0lbS0lZCAlSDolTTolUyIpKQogICAgICAg
#1#ICAgICAgICAgZXhjZXB0IFZhbHVlRXJyb3I6CiAgICAgICAgICAgICAgICAgICAgcGFyc2VkLmFw
#1#cGVuZChOb25lKQogICAgICAgIGdhcHMgPSBbKGIgLSBhKS50b3RhbF9zZWNvbmRzKCkgLyA2MC4w
#1#CiAgICAgICAgICAgICAgICBmb3IgYSwgYiBpbiB6aXAocGFyc2VkLCBwYXJzZWRbMTpdKSBpZiBh
#1#IGlzIG5vdCBOb25lIGFuZCBiIGlzIG5vdCBOb25lXQogICAgICAgIGlmIGdhcHM6CiAgICAgICAg
#1#ICAgIGludGVydmFsX21pbnV0ZXMgPSByb3VuZChmbG9hdChucC5tZWRpYW4oZ2FwcykpLCA0KQog
#1#ICAgICAgIHRpbWVzdGFtcHNfaXNvID0gW3AuaXNvZm9ybWF0KCkgaWYgcCBpcyBub3QgTm9uZSBl
#1#bHNlIE5vbmUgZm9yIHAgaW4gcGFyc2VkXQoKICAgICAgICBjaGFubmVscyA9IFtdCiAgICAgICAg
#1#aWYgdGltZXBvaW50czoKICAgICAgICAgICAgdHAwID0gcmVzMFt0aW1lcG9pbnRzWzBdXQogICAg
#1#ICAgICAgICBjaGFubmVscyA9IHNvcnRlZCgKICAgICAgICAgICAgICAgIFtrIGZvciBrIGluIHRw
#1#MC5rZXlzKCkgaWYgay5zdGFydHN3aXRoKCJDaGFubmVsIildLAogICAgICAgICAgICAgICAga2V5
#1#PWxhbWJkYSB4OiBpbnQoeC5zcGxpdCgpWy0xXSkKICAgICAgICAgICAgKQogICAgICAgIG5fY2gg
#1#PSBsZW4oY2hhbm5lbHMpIG9yIDEKCiAgICAgICAgY2hhbm5lbF9uYW1lcyA9IFtdCiAgICAgICAg
#1#Zm9yIGkgaW4gcmFuZ2Uobl9jaCk6CiAgICAgICAgICAgIGNoX2luZm8gPSBmLmdldCgiRGF0YVNl
#1#dEluZm8iLCB7fSkuZ2V0KGYiQ2hhbm5lbCB7aX0iLCBOb25lKQogICAgICAgICAgICBuYW1lX3Jh
#1#dyA9IGF0dHJfc3RyKGNoX2luZm8sICJOYW1lIiwgIiIpIGlmIGNoX2luZm8gZWxzZSAiIgogICAg
#1#ICAgICAgICBuYW1lID0gcmUuc3ViKHInXHgwMC4qJywgJycsIG5hbWVfcmF3KS5zdHJpcCgpCiAg
#1#ICAgICAgICAgIGlmIG5vdCBuYW1lIG9yIHJlLm1hdGNoKHIiXmNoKGFubmVsKT9ccypcZCskIiwg
#1#bmFtZSwgcmUuSUdOT1JFQ0FTRSk6CiAgICAgICAgICAgICAgICBuYW1lID0gZiJDaGFubmVsIHtp
#1#KzF9IgogICAgICAgICAgICBjaGFubmVsX25hbWVzLmFwcGVuZChuYW1lKQoKICAgICAgICByZXR1
#1#cm4gewogICAgICAgICAgICAid2lkdGgiOiB3aWR0aCwKICAgICAgICAgICAgImhlaWdodCI6IGhl
#1#aWdodCwKICAgICAgICAgICAgImRlcHRoIjogZGVwdGgsCiAgICAgICAgICAgICJuX2NoYW5uZWxz
#1#Ijogbl9jaCwKICAgICAgICAgICAgIm5fdGltZXBvaW50cyI6IG5fdHAsCiAgICAgICAgICAgICJ2
#1#b3hlbF9zaXplIjogewogICAgICAgICAgICAgICAgIngiOiByb3VuZCh2b3hfeCwgNiksCiAgICAg
#1#ICAgICAgICAgICAieSI6IHJvdW5kKHZveF95LCA2KSwKICAgICAgICAgICAgICAgICJ6Ijogcm91
#1#bmQodm94X3osIDYpCiAgICAgICAgICAgIH0sCiAgICAgICAgICAgICMgTWljcm9zY29wZSBzdGFn
#1#ZSBmcmFtZSwgaW4gdGhlIGFjcXVpc2l0aW9uIHVuaXQgKHVtKS4gVGhpcyBpcyB0aGUgZnJhbWUK
#1#ICAgICAgICAgICAgIyBJbWFyaXMtZGVyaXZlZCBvYmplY3QgY29vcmRpbmF0ZXMgKHNwb3RzLCBz
#1#dXJmYWNlcywgY2VsbCB0cmFja3MpIGxpdmUgaW4sCiAgICAgICAgICAgICMgc28gaXQgaXMgd2hh
#1#dCBhbiBvdmVybGF5IGhhcyB0byBiZSByZWdpc3RlcmVkIGFnYWluc3QuCiAgICAgICAgICAgICJl
#1#eHRlbnQiOiAoewogICAgICAgICAgICAgICAgInVuaXQiOiAidW0iLAogICAgICAgICAgICAgICAg
#1#Im1pbiI6IGV4dF9taW4sCiAgICAgICAgICAgICAgICAibWF4IjogZXh0X21heAogICAgICAgICAg
#1#ICB9IGlmIGNhbGlicmF0ZWQgZWxzZSBOb25lKSwKICAgICAgICAgICAgInRpbWVzdGFtcHMiOiB0
#1#aW1lc3RhbXBzX2lzbywKICAgICAgICAgICAgInRpbWVfaW50ZXJ2YWxfbWludXRlcyI6IGludGVy
#1#dmFsX21pbnV0ZXMsCiAgICAgICAgICAgICJjaGFubmVsX25hbWVzIjogY2hhbm5lbF9uYW1lcwog
#1#ICAgICAgIH0KCmlmIF9fbmFtZV9fID09ICJfX21haW5fXyI6CiAgICBpZiBsZW4oc3lzLmFyZ3Yp
#1#IDwgMzoKICAgICAgICBwcmludCgiVXNhZ2U6IHB5dGhvbiAxLWltc19tZXRhZGF0YS5weSA8aW5w
#1#dXRfaW1zPiA8b3V0cHV0X2pzb24+IikKICAgICAgICBzeXMuZXhpdCgxKQogICAgCiAgICBpbnB1
#1#dF9wYXRoID0gUGF0aChzeXMuYXJndlsxXSkKICAgIG91dHB1dF9wYXRoID0gUGF0aChzeXMuYXJn
#1#dlsyXSkKICAgIAogICAgdHJ5OgogICAgICAgIG1ldGEgPSByZWFkX2ltc19tZXRhZGF0YShpbnB1
#1#dF9wYXRoKQogICAgICAgIHdpdGggb3BlbihvdXRwdXRfcGF0aCwgInciLCBlbmNvZGluZz0idXRm
#1#LTgiKSBhcyBmOgogICAgICAgICAgICBqc29uLmR1bXAobWV0YSwgZiwgaW5kZW50PTIpCiAgICAg
#1#ICAgcHJpbnQoZiJbTUVUQURBVEFdIEV4dHJhY3RlZCBtZXRhZGF0YSB0byB7b3V0cHV0X3BhdGh9
#1#IikKICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZToKICAgICAgICBwcmludChmIltFUlJPUl0gRmFp
#1#bGVkIHRvIHJlYWQgbWV0YWRhdGE6IHtlfSIsIGZpbGU9c3lzLnN0ZGVycikKICAgICAgICBzeXMu
#1#ZXhpdCgxKQo=
:: ---- [2] 2-image_processor.py (25878 octets) ----
#2#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwppbXBvcnQgYXJncGFyc2UKaW1wb3J0IGltcG9ydGxpYi51
#2#dGlsCmltcG9ydCBqc29uCmltcG9ydCBtYXRoCmltcG9ydCBvcwppbXBvcnQgc3lzCmZyb20gcGF0
#2#aGxpYiBpbXBvcnQgUGF0aAppbXBvcnQgaDVweQppbXBvcnQgbnVtcHkgYXMgbnAKZnJvbSBQSUwg
#2#aW1wb3J0IEltYWdlCmZyb20gc2NpcHkubmRpbWFnZSBpbXBvcnQgbWVkaWFuX2ZpbHRlciwgYmlu
#2#YXJ5X29wZW5pbmcsIGJpbmFyeV9kaWxhdGlvbgpmcm9tIGNvbmN1cnJlbnQuZnV0dXJlcyBpbXBv
#2#cnQgUHJvY2Vzc1Bvb2xFeGVjdXRvcgpmcm9tIHRxZG0gaW1wb3J0IHRxZG0KCkhFUkUgPSBQYXRo
#2#KF9fZmlsZV9fKS5yZXNvbHZlKCkucGFyZW50CmlmIHN0cihIRVJFKSBub3QgaW4gc3lzLnBhdGg6
#2#CiAgICBzeXMucGF0aC5pbnNlcnQoMCwgc3RyKEhFUkUpKQpmcm9tIHJ1bl9wcmVwcm9jZXNzIGlt
#2#cG9ydCB3b3JrZXJfY291bnQsIHRodW1ibmFpbF9sb2QsIGF0b21pY193cml0ZV9qc29uICAjIG5v
#2#cWE6IEU0MDIKCl9fdmVyc2lvbl9fID0gIjAuMTQuMCIKCiMgSG93IG1hbnkgdGltZXBvaW50cyBh
#2#cmUgc2FtcGxlZCB0byBlc3RhYmxpc2ggdGhlIHNoYXJlZCB3aW5kb3cgb2YgYSB0aW1lbGFwc2Uu
#2#CiMgRXZlbmx5IHNwYWNlZCBvdmVyIHRoZSBzZXJpZXMgYW5kIGFsd2F5cyBpbmNsdWRpbmcgdGhl
#2#IGZpcnN0IGFuZCB0aGUgbGFzdCBmcmFtZS4KR0xPQkFMX05PUk1fU0FNUExFUyA9IDgKCiMg4pSA
#2#4pSAIFN0cmVhbWluZyBnZW9tZXRyeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#2#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#2#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#2#lIDilIDilIDilIDilIDilIDilIDilIAKIyBBIGNoYW5uZWwgaXMgbmV2ZXIgaGVsZCB3aG9sZSBp
#2#biBtZW1vcnkuIEl0IGlzIHJlYWQgZnJvbSB0aGUgLmltcyBpbiB0aWxlczsgZWFjaAojIHRpbGUg
#2#aXMgbGV2ZWxsZWQgaW5kZXBlbmRlbnRseSBhbmQgd3JpdHRlbiBzdHJhaWdodCBpbnRvIHRoZSBM
#2#T0QwIGZpbGUuCiMKIyBFeGFjdG5lc3Mgb2YgYSB0aWxlIGFnYWluc3QgdGhlIHdob2xlLXZvbHVt
#2#ZSBjb21wdXRhdGlvbjogZXZlcnkgb3BlcmF0aW9uIGlzIGxvY2FsLgojICAgKiB0aGUgc2lnbmFs
#2#IG1hc2sgaXMgYmluYXJ5X29wZW5pbmcoaXRlcmF0aW9ucz0xKSDigJQgb25lIGVyb3Npb24gdGhl
#2#biBvbmUgZGlsYXRpb24g4oCUCiMgICAgIGZvbGxvd2VkIGJ5IGJpbmFyeV9kaWxhdGlvbihpdGVy
#2#YXRpb25zPTMpLCBhbGwgd2l0aCB0aGUgNi1jb25uZWN0ZWQgY3Jvc3MuIEVhY2gKIyAgICAgZXJv
#2#c2lvbi9kaWxhdGlvbiBsb29rcyBvbmUgdm94ZWwgYXdheSwgc28gYSB2YWx1ZSBjb21wdXRlZCBh
#2#dCBhIHRpbGUgZWRnZSB0aGF0IGhhcwojICAgICBubyByZWFsIG5laWdoYm91cnMgYmV5b25kIGl0
#2#IGNhbiBiZSB3cm9uZyB0aGVyZSwgYW5kIHRoZSBlcnJvciBtb3ZlcyBpbndhcmQgYnkgb25lCiMg
#2#ICAgIHZveGVsIHBlciBvcGVyYXRpb246IDEgKyAxICsgMyA9IDUgdm94ZWxzLiBBIGhhbG8gb2Yg
#2#TUFTS19IQUxPID0gNSByZWFsIHZveGVscwojICAgICBhcm91bmQgdGhlIGNvcmUgdGhlcmVmb3Jl
#2#IHlpZWxkcyB0aGUgZXhhY3Qgd2hvbGUtdm9sdW1lIG1hc2sgaW5zaWRlIHRoZSBjb3JlOwojICAg
#2#KiB0aGUgM3gzeDMgbWVkaWFuIHJlYWRzIG9uZSB2b3hlbCBhd2F5LCB3aGljaCB0aGUgc2FtZSBo
#2#YWxvIGNvdmVyczsKIyAgICogd2luZG93IGxldmVsaW5nIGlzIHBlciB2b3hlbC4KIyBBdCBhIGZh
#2#Y2Ugb2YgdGhlIFZPTFVNRSB0aGUgdGlsZSBoYXMgbm8gaGFsbywgaXRzIGFycmF5IGVkZ2UgaXMg
#2#dGhlIHZvbHVtZSBlZGdlLCBhbmQKIyBzY2lweSBhcHBsaWVzIHRoZSBzYW1lIGJvcmRlciBydWxl
#2#IGl0IGFwcGxpZXMgdG8gdGhlIHdob2xlIHZvbHVtZSAoYm9yZGVyX3ZhbHVlPTAgZm9yCiMgdGhl
#2#IG1vcnBob2xvZ3ksICdyZWZsZWN0JyBmb3IgdGhlIG1lZGlhbikuIFRoZSBvdXRwdXQgaXMgdGhl
#2#cmVmb3JlIGJ5dGUtaWRlbnRpY2FsIHRvCiMgbGV2ZWxsaW5nIHRoZSB3aG9sZSBjaGFubmVsIGF0
#2#IG9uY2UsIHdoYXRldmVyIHRoZSB0aWxpbmcuCk1BU0tfSEFMTyA9IDUKU1VCU0FNUExFX1NURVAg
#2#PSA0ICAgICAgICAgICAgIyB3aGl0ZSBwb2ludCByYW5rcyB2b2xbOjo0LCA6OjQsIDo6NF0KREVG
#2#QVVMVF9USUxFX01WT1ggPSAyNCAgICAgICAgIyB2b3hlbHMgcGVyIHRpbGUgSU5DTFVESU5HIGl0
#2#cyBoYWxvLCBpbiBtaWxsaW9ucwoKIyBSb3VnaCBwZXItd29ya2VyIGNvc3Qgb2YgYSB0aWxlOiB0
#2#aGUgcmF3IHJlYWQgKDIgQiBmb3IgdWludDE2KSwgaXRzIGZsb2F0MzIgY29weSAoNCksCiMgdGhl
#2#IG1hc2sgYW5kIGl0cyBtb3JwaG9sb2d5IHRlbXBvcmFyaWVzICh+MyksIHRoZSBtZWRpYW4sIGNv
#2#bXBvc2l0ZSwgY2xpcCBhbmQgbm9ybQojIGFycmF5cyAofjE2KSDigJQgfjI1IEIgcGVyIHZveGVs
#2#LCBzbyB0aGUgZGVmYXVsdCB0aWxlIGNvc3RzIH42MDAgTUIgcGVyIHdvcmtlci4KCgpkZWYgX3Rp
#2#bGVfYnVkZ2V0KCkgLT4gaW50OgogICAgcmF3ID0gb3MuZW52aXJvbi5nZXQoIkxVTUVOX1BSRVBS
#2#T0NFU1NfVElMRV9NVk9YIiwgIiIpLnN0cmlwKCkKICAgIGlmIHJhdzoKICAgICAgICB0cnk6CiAg
#2#ICAgICAgICAgIHZhbHVlID0gZmxvYXQocmF3KQogICAgICAgICAgICBpZiB2YWx1ZSA+IDA6CiAg
#2#ICAgICAgICAgICAgICByZXR1cm4gbWF4KDEsIGludCh2YWx1ZSAqIDEwMjQgKiAxMDI0KSkKICAg
#2#ICAgICBleGNlcHQgVmFsdWVFcnJvcjoKICAgICAgICAgICAgcGFzcwogICAgICAgIHByaW50KGYi
#2#W1BST0NFU1NdIExVTUVOX1BSRVBST0NFU1NfVElMRV9NVk9YPXtyYXchcn0gaWdub3JlIChub21i
#2#cmUgPiAwIGF0dGVuZHUpIiwgZmx1c2g9VHJ1ZSkKICAgIHJldHVybiBERUZBVUxUX1RJTEVfTVZP
#2#WCAqIDEwMjQgKiAxMDI0CgoKZGVmIHBsYW5fdGlsZXMoc2hhcGUsIGhhbG86IGludCwgYnVkZ2V0
#2#OiBpbnQpOgogICAgIiIiQ29yZSBib3hlcyAoejAsIHoxLCB5MCwgeTEsIHgwLCB4MSkgY292ZXJp
#2#bmcgdGhlIHZvbHVtZSwgZWFjaCB3aXRoIGl0cyBoYWxvCiAgICB1bmRlciBgYnVkZ2V0YCB2b3hl
#2#bHMuIFdob2xlIHBsYW5lcyBhcmUgcHJlZmVycmVkIChvbmUgY29udGlndW91cyByZWFkIHBlciBz
#2#bGFiKTsKICAgIFkgdGhlbiBYIGFyZSBzcGxpdCBvbmx5IHdoZW4gYSBwbGFuZSBzbGFiIGRvZXMg
#2#bm90IGZpdC4iIiIKICAgIEQsIEgsIFcgPSBzaGFwZQoKICAgIGRlZiBjb3N0KGN6LCBjeSwgY3gp
#2#OgogICAgICAgIHJldHVybiBtaW4oRCwgY3ogKyAyICogaGFsbykgKiBtaW4oSCwgY3kgKyAyICog
#2#aGFsbykgKiBtaW4oVywgY3ggKyAyICogaGFsbykKCiAgICBjeiwgY3ksIGN4ID0gbWluKEQsIDY0
#2#KSwgSCwgVwogICAgd2hpbGUgY29zdChjeiwgY3ksIGN4KSA+IGJ1ZGdldDoKICAgICAgICBpZiBj
#2#eSA+PSBjeCBhbmQgY3kgPiAzMjoKICAgICAgICAgICAgY3kgPSAtKC1jeSAvLyAyKQogICAgICAg
#2#IGVsaWYgY3ggPiAzMjoKICAgICAgICAgICAgY3ggPSAtKC1jeCAvLyAyKQogICAgICAgIGVsaWYg
#2#Y3ogPiA0OgogICAgICAgICAgICBjeiA9IC0oLWN6IC8vIDIpCiAgICAgICAgZWxzZToKICAgICAg
#2#ICAgICAgYnJlYWsKICAgIHJldHVybiBbKHosIG1pbih6ICsgY3osIEQpLCB5LCBtaW4oeSArIGN5
#2#LCBIKSwgeCwgbWluKHggKyBjeCwgVykpCiAgICAgICAgICAgIGZvciB6IGluIHJhbmdlKDAsIEQs
#2#IGN6KSBmb3IgeSBpbiByYW5nZSgwLCBILCBjeSkgZm9yIHggaW4gcmFuZ2UoMCwgVywgY3gpXQoK
#2#CmRlZiBfaGFsb19ib3goYm94LCBzaGFwZSwgaGFsbyk6CiAgICB6MCwgejEsIHkwLCB5MSwgeDAs
#2#IHgxID0gYm94CiAgICBELCBILCBXID0gc2hhcGUKICAgIHJldHVybiAobWF4KDAsIHowIC0gaGFs
#2#byksIG1pbihELCB6MSArIGhhbG8pLCBtYXgoMCwgeTAgLSBoYWxvKSwgbWluKEgsIHkxICsgaGFs
#2#byksCiAgICAgICAgICAgIG1heCgwLCB4MCAtIGhhbG8pLCBtaW4oVywgeDEgKyBoYWxvKSkKCgpk
#2#ZWYgY29ybmVyX2JveGVzKHNoYXBlKToKICAgICIiIlRoZSA4IGNvcm5lciBjdWJlcyDigJQgcHVy
#2#ZSBjYW1lcmEgYmFja2dyb3VuZCwgbm8gc3BlY2ltZW4gdGhlcmUuIEVhY2ggaXMga2VwdCBhcwog
#2#ICAgaXRzIG93biBib3g6IHdoZW4gdGhlIHZvbHVtZSBpcyB0aGlubmVyIHRoYW4gdHdvIGN1YmVz
#2#IHRoZXkgb3ZlcmxhcCwgYW5kIHRoZQogICAgd2hvbGUtdm9sdW1lIGVzdGltYXRvciBjb3VudGVk
#2#IHRob3NlIHZveGVscyBvbmNlIHBlciBjdWJlLiIiIgogICAgRCwgSCwgVyA9IHNoYXBlCiAgICBj
#2#cyA9IG1heCgxLCBtaW4oMzIsIFcgLy8gNCwgSCAvLyA0LCBEIC8vIDQpKQogICAgenMgPSAoKDAs
#2#IG1pbihjcywgRCkpLCAobWF4KDAsIEQgLSBjcyksIEQpKQogICAgeXMgPSAoKDAsIG1pbihjcywg
#2#SCkpLCAobWF4KDAsIEggLSBjcyksIEgpKQogICAgeHMgPSAoKDAsIG1pbihjcywgVykpLCAobWF4
#2#KDAsIFcgLSBjcyksIFcpKQogICAgcmV0dXJuIFsoelswXSwgelsxXSwgeVswXSwgeVsxXSwgeFsw
#2#XSwgeFsxXSkgZm9yIHogaW4genMgZm9yIHkgaW4geXMgZm9yIHggaW4geHNdCgoKZGVmIF9pbnRl
#2#cnNlY3QoYSwgYik6CiAgICBib3ggPSAobWF4KGFbMF0sIGJbMF0pLCBtaW4oYVsxXSwgYlsxXSks
#2#IG1heChhWzJdLCBiWzJdKSwgbWluKGFbM10sIGJbM10pLAogICAgICAgICAgIG1heChhWzRdLCBi
#2#WzRdKSwgbWluKGFbNV0sIGJbNV0pKQogICAgcmV0dXJuIGJveCBpZiBib3hbMF0gPCBib3hbMV0g
#2#YW5kIGJveFsyXSA8IGJveFszXSBhbmQgYm94WzRdIDwgYm94WzVdIGVsc2UgTm9uZQoKCmRlZiBf
#2#c3RyaWRlZChibG9jaywgb3JpZ2luKToKICAgICIiIlRoZSB2b3hlbHMgb2YgYGJsb2NrYCAod2hv
#2#c2UgZmlyc3Qgdm94ZWwgc2l0cyBhdCB2b2x1bWUgaW5kZXggYG9yaWdpbmApIHRoYXQKICAgIHZv
#2#bFs6OjQsIDo6NCwgOjo0XSBzZWxlY3RzIOKAlCB0aGUgc2FtZSBsYXR0aWNlIHdoYXRldmVyIHRo
#2#ZSB0aWxpbmcuIiIiCiAgICB6MCwgeTAsIHgwID0gb3JpZ2luCiAgICBzID0gU1VCU0FNUExFX1NU
#2#RVAKICAgIHJldHVybiBibG9ja1soLXowKSAlIHM6OnMsICgteTApICUgczo6cywgKC14MCkgJSBz
#2#OjpzXQoKCmRlZiBzdWJzYW1wbGVfc2l6ZShzaGFwZSkgLT4gaW50OgogICAgcmV0dXJuIG1hdGgu
#2#cHJvZCgtKC1uIC8vIFNVQlNBTVBMRV9TVEVQKSBmb3IgbiBpbiBzaGFwZSkKCgojIOKUgOKUgCBX
#2#b3JrZXIgc2lkZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#2#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#2#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#2#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKIyBXb3JrZXJzIHJlYWQgdGhlIC5pbXMg
#2#dGhlbXNlbHZlcyAob25lIG9wZW4gaGFuZGxlIHBlciBwcm9jZXNzLCByZXVzZWQgYWNyb3NzIHRp
#2#bGVzKQojIGFuZCB3cml0ZSB0aGVpciBvdXRwdXQgaW50byB0aGUgTE9EIGZpbGVzIHRocm91Z2gg
#2#bWVtb3J5IG1hcHMsIHNvIG5vdGhpbmcgaGVhdmllcgojIHRoYW4gYSB0aWxlIGJveCBjcm9zc2Vz
#2#IGEgcHJvY2VzcyBwaXBlLgpfSDVfRklMRVMgPSB7fQoKCmRlZiBfaDVfZGF0YXNldChwYXRoOiBz
#2#dHIsIG5hbWU6IHN0cik6CiAgICBmID0gX0g1X0ZJTEVTLmdldChwYXRoKQogICAgaWYgZiBpcyBO
#2#b25lOgogICAgICAgICMgQSBsYXJnZXIgY2h1bmsgY2FjaGUga2VlcHMgYSBjaHVuayBkZWNvbXBy
#2#ZXNzZWQgd2hpbGUgdGhlIG5laWdoYm91cmluZyB0aWxlCiAgICAgICAgIyByb3dzIG9mIHRoZSBz
#2#YW1lIGNodW5rIGFyZSByZWFkLgogICAgICAgIGYgPSBoNXB5LkZpbGUocGF0aCwgInIiLCByZGNj
#2#X25ieXRlcz02NCAqIDEwMjQgKiAxMDI0KQogICAgICAgIF9INV9GSUxFU1twYXRoXSA9IGYKICAg
#2#IHJldHVybiBmW25hbWVdCgoKZGVmIF9jbG9zZV9oNV9maWxlcygpOgogICAgZm9yIGYgaW4gX0g1
#2#X0ZJTEVTLnZhbHVlcygpOgogICAgICAgIHRyeToKICAgICAgICAgICAgZi5jbG9zZSgpCiAgICAg
#2#ICAgZXhjZXB0IEV4Y2VwdGlvbjoKICAgICAgICAgICAgcGFzcwogICAgX0g1X0ZJTEVTLmNsZWFy
#2#KCkKCgpkZWYgc2FtcGxlX3RpbGUoYXJncyk6CiAgICAiIiJQYXNzIDEgb3ZlciBvbmUgdGlsZTog
#2#aXRzIHNoYXJlIG9mIHRoZSB3aGl0ZS1wb2ludCBzdWJzYW1wbGUgYW5kIG9mIHRoZSBjb3JuZXIK
#2#ICAgIGN1YmVzLCBhcyBmbG9hdDMyIGV4YWN0bHkgYXMgdGhlIHdob2xlLXZvbHVtZSBlc3RpbWF0
#2#b3Igc2F3IHRoZW0uIiIiCiAgICBwYXRoLCBuYW1lLCBzaGFwZSwgYm94ID0gYXJncwogICAgejAs
#2#IHoxLCB5MCwgeTEsIHgwLCB4MSA9IGJveAogICAgYmxvY2sgPSBfaDVfZGF0YXNldChwYXRoLCBu
#2#YW1lKVt6MDp6MSwgeTA6eTEsIHgwOngxXQogICAgc3ViID0gX3N0cmlkZWQoYmxvY2ssICh6MCwg
#2#eTAsIHgwKSkuYXN0eXBlKG5wLmZsb2F0MzIpLnJhdmVsKCkKICAgIGNvcm5lcnMgPSBbXQogICAg
#2#Zm9yIGNiIGluIGNvcm5lcl9ib3hlcyhzaGFwZSk6CiAgICAgICAgcGFydCA9IF9pbnRlcnNlY3Qo
#2#Ym94LCBjYikKICAgICAgICBpZiBwYXJ0IGlzIG5vdCBOb25lOgogICAgICAgICAgICBjb3JuZXJz
#2#LmFwcGVuZChibG9ja1twYXJ0WzBdIC0gejA6cGFydFsxXSAtIHowLCBwYXJ0WzJdIC0geTA6cGFy
#2#dFszXSAtIHkwLAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJ0WzRdIC0geDA6
#2#cGFydFs1XSAtIHgwXS5hc3R5cGUobnAuZmxvYXQzMikucmF2ZWwoKSkKICAgIGNvcm5lciA9IG5w
#2#LmNvbmNhdGVuYXRlKGNvcm5lcnMpIGlmIGNvcm5lcnMgZWxzZSBucC5lbXB0eSgwLCBucC5mbG9h
#2#dDMyKQogICAgcmV0dXJuIHN1YiwgY29ybmVyCgoKZGVmIGxldmVsX3RpbGUoYXJncyk6CiAgICAi
#2#IiJTZWxlY3RpdmUgTWFza2VkIE1lZGlhbiBGaWx0ZXJpbmcgKyBXaW5kb3cgTGV2ZWxpbmcgZm9y
#2#IG9uZSB0aWxlLgoKICAgIEluc2lkZSB0aGUgc2lnbmFsIG1hc2sgdGhlIG9yaWdpbmFsIChzaGFy
#2#cCkgYmlvbG9naWNhbCBzaWduYWwgaXMga2VwdCBhcy1pczsKICAgIG91dHNpZGUgdGhlIG1hc2sg
#2#dGhlIGJhY2tncm91bmQgaXMgcmVwbGFjZWQgYnkgYSAzRCBtZWRpYW4gKHNpemU9MykgdGhhdCBj
#2#cnVzaGVzCiAgICBzaG90LW5vaXNlIGFuZCBpc29sYXRlZCBob3QgcGl4ZWxzIHdpdGhvdXQgYmx1
#2#cnJpbmcgdGhlIGNlbGxzLiBXaW5kb3cgTGV2ZWxpbmcgdGhlbgogICAgbWFwcyBbYmdfZmxvb3Is
#2#IHNpZ19tYXhdIC0+IFswLCAyNTVdICh1aW50OCkg4oCUIGFueSB2YWx1ZSA8PSBiZ19mbG9vciBj
#2#b2xsYXBzZXMgdG8gYW4KICAgIGFic29sdXRlIDAsIGd1YXJhbnRlZWluZyBwdXJlLWJsYWNrIGVt
#2#cHR5IHNwYWNlIGZvciB0aGUgU1ZSIGJyaWNrIHBhY2tlci4KCiAgICBUaGUgdGlsZSBpcyByZWFk
#2#IHdpdGggaXRzIGhhbG8gKHNlZSBNQVNLX0hBTE8pIGFuZCBvbmx5IGl0cyBjb3JlIGlzIHdyaXR0
#2#ZW4uCiAgICBSZXR1cm5zIHRoZSBudW1iZXIgb2YgbWFza2VkIHZveGVscyBpbiB0aGUgY29yZSBh
#2#bmQsIHdoZW4gYXNrZWQsIHRoZSBjb3JlJ3Mgc2hhcmUKICAgIG9mIHRoZSB3aGl0ZS1wb2ludCBz
#2#dWJzYW1wbGUuCiAgICAiIiIKICAgIChwYXRoLCBuYW1lLCBzaGFwZSwgYm94LCBiZ19mbG9vciwg
#2#c2lnX21heCwgbG9kMF9wYXRoLCB3YW50X3N1YnNhbXBsZSkgPSBhcmdzCiAgICB6MCwgejEsIHkw
#2#LCB5MSwgeDAsIHgxID0gYm94CiAgICBoejAsIGh6MSwgaHkwLCBoeTEsIGh4MCwgaHgxID0gX2hh
#2#bG9fYm94KGJveCwgc2hhcGUsIE1BU0tfSEFMTykKCiAgICB2b2wgPSBfaDVfZGF0YXNldChwYXRo
#2#LCBuYW1lKVtoejA6aHoxLCBoeTA6aHkxLCBoeDA6aHgxXS5hc3R5cGUobnAuZmxvYXQzMikKCiAg
#2#ICAjIFNpZ25hbCBtYXNrOiB0aHJlc2hvbGQgMTAgJSBhYm92ZSB0aGUgbm9pc2UgZmxvb3I7IGEg
#2#bW9ycGhvbG9naWNhbCBvcGVuaW5nIGRyb3BzCiAgICAjIGlzb2xhdGVkIGhvdCBwaXhlbHMgKHNv
#2#IHRoZXkgZ2V0IG1lZGlhbi1jcnVzaGVkIGJlbG93KSwgdGhlbiBhIDMtaXRlcmF0aW9uCiAgICAj
#2#IGRpbGF0aW9uIGd1YXJkcyB0aGUgbmF0dXJhbCBmbHVvcmVzY2VudCBmYWRlLW91dCBhcm91bmQg
#2#dGhlIGJpb2xvZ2ljYWwgc2lnbmFsIHNvCiAgICAjIHRoZSBtZWRpYW4gZmlsdGVyIG5ldmVyIGJp
#2#dGVzIGludG8gY2VsbHMuCiAgICBtYXNrID0gbnAuZ3JlYXRlcih2b2wsIGJnX2Zsb29yICogMS4x
#2#KQogICAgbWFzayA9IGJpbmFyeV9vcGVuaW5nKG1hc2ssIGl0ZXJhdGlvbnM9MSkKICAgIG1hc2sg
#2#PSBiaW5hcnlfZGlsYXRpb24obWFzaywgaXRlcmF0aW9ucz0zKQoKICAgIGN6MCwgY3oxID0gejAg
#2#LSBoejAsIHoxIC0gaHowCiAgICBjeTAsIGN5MSA9IHkwIC0gaHkwLCB5MSAtIGh5MAogICAgY3gw
#2#LCBjeDEgPSB4MCAtIGh4MCwgeDEgLSBoeDAKICAgIGNvcmUgPSAoc2xpY2UoY3owLCBjejEpLCBz
#2#bGljZShjeTAsIGN5MSksIHNsaWNlKGN4MCwgY3gxKSkKCiAgICAjIFRoZSBtZWRpYW4gb2YgYSBj
#2#b3JlIHZveGVsIHJlYWRzIG9uZSB2b3hlbCBhcm91bmQgaXQ6IGZpbHRlciB0aGUgY29yZSBwbHVz
#2#IHRoYXQKICAgICMgcmluZyBvbmx5IChjbGlwcGVkIGF0IHRoZSB0aWxlLCB3aGljaCBpcyB0aGUg
#2#dm9sdW1lIGVkZ2Ugd2hlcmV2ZXIgbm8gaGFsbyBleGlzdHMpLgogICAgbXowLCBteTAsIG14MCA9
#2#IG1heCgwLCBjejAgLSAxKSwgbWF4KDAsIGN5MCAtIDEpLCBtYXgoMCwgY3gwIC0gMSkKICAgIHJp
#2#bmcgPSB2b2xbbXowOm1pbih2b2wuc2hhcGVbMF0sIGN6MSArIDEpLCBteTA6bWluKHZvbC5zaGFw
#2#ZVsxXSwgY3kxICsgMSksCiAgICAgICAgICAgICAgIG14MDptaW4odm9sLnNoYXBlWzJdLCBjeDEg
#2#KyAxKV0KICAgIHNtb290aGVkID0gbWVkaWFuX2ZpbHRlcihyaW5nLCBzaXplPTMpW2N6MCAtIG16
#2#MDpjejEgLSBtejAsIGN5MCAtIG15MDpjeTEgLSBteTAsCiAgICAgICAgICAgICAgICAgICAgICAg
#2#ICAgICAgICAgICAgICAgICAgICBjeDAgLSBteDA6Y3gxIC0gbXgwXQogICAgYmxvY2tfZGF0YSA9
#2#IHZvbFtjb3JlXQogICAgYmxvY2tfbWFzayA9IG1hc2tbY29yZV0KICAgIGNvbXBvc2l0ZSA9IG5w
#2#LndoZXJlKGJsb2NrX21hc2ssIGJsb2NrX2RhdGEsIHNtb290aGVkKQoKICAgIGlmIHNpZ19tYXgg
#2#LSBiZ19mbG9vciA8PSAwLjA6CiAgICAgICAgc2lnX21heCA9IGJnX2Zsb29yICsgMS4wCiAgICAj
#2#IFdpbmRvdyBMZXZlbGluZyBbYmdfZmxvb3IsIHNpZ19tYXhdIC0+IFswLCAyNTVdCiAgICBjbGVh
#2#biA9IG5wLmNsaXAoY29tcG9zaXRlLCBiZ19mbG9vciwgc2lnX21heCkKICAgIG5vcm0gPSAoY2xl
#2#YW4gLSBiZ19mbG9vcikgLyAoc2lnX21heCAtIGJnX2Zsb29yKQogICAgYmxvY2tfdTggPSAobm9y
#2#bSAqIDI1NS4wKS5hc3R5cGUobnAudWludDgpCgogICAgb3V0ID0gbnAubWVtbWFwKGxvZDBfcGF0
#2#aCwgZHR5cGU9bnAudWludDgsIG1vZGU9InIrIiwgc2hhcGU9c2hhcGUpCiAgICB0cnk6CiAgICAg
#2#ICAgb3V0W3owOnoxLCB5MDp5MSwgeDA6eDFdID0gYmxvY2tfdTgKICAgICAgICBvdXQuZmx1c2go
#2#KQogICAgZmluYWxseToKICAgICAgICBkZWwgb3V0CgogICAgc3ViID0gX3N0cmlkZWQoYmxvY2tf
#2#ZGF0YSwgKHowLCB5MCwgeDApKS5yYXZlbCgpLmNvcHkoKSBpZiB3YW50X3N1YnNhbXBsZSBlbHNl
#2#IE5vbmUKICAgIHJldHVybiBpbnQobnAuY291bnRfbm9uemVybyhibG9ja19tYXNrKSksIHN1YgoK
#2#CmRlZiBkb3duc2NhbGVfcGxhbmVzKGFyZ3MpOgogICAgIiIiV3JpdGUgcGxhbmVzIFt6MCwgejEp
#2#IG9mIGV2ZXJ5IHJlZHVjZWQgTE9EIGZyb20gdGhlIGxldmVsbGVkIExPRDAgcGxhbmVzLiIiIgog
#2#ICAgbG9kMF9wYXRoLCBzaGFwZSwgejAsIHoxLCB0YXJnZXRzID0gYXJncwogICAgRCwgSCwgVyA9
#2#IHNoYXBlCiAgICBzcmMgPSBucC5tZW1tYXAobG9kMF9wYXRoLCBkdHlwZT1ucC51aW50OCwgbW9k
#2#ZT0iciIsIHNoYXBlPXNoYXBlKQogICAgb3V0cyA9IFsodywgaCwgbnAubWVtbWFwKHAsIGR0eXBl
#2#PW5wLnVpbnQ4LCBtb2RlPSJyKyIsIHNoYXBlPShELCBoLCB3KSkpCiAgICAgICAgICAgIGZvciAo
#2#dywgaCwgcCkgaW4gdGFyZ2V0c10KICAgIHRyeToKICAgICAgICBmb3IgeiBpbiByYW5nZSh6MCwg
#2#ejEpOgogICAgICAgICAgICBwaWxfaW1nID0gSW1hZ2UuZnJvbWFycmF5KG5wLmFycmF5KHNyY1t6
#2#XSkpCiAgICAgICAgICAgIGZvciAodywgaCwgZHN0KSBpbiBvdXRzOgogICAgICAgICAgICAgICAg
#2#cmVzaXplZCA9IHBpbF9pbWcucmVzaXplKCh3LCBoKSwgSW1hZ2UuUmVzYW1wbGluZy5CSUxJTkVB
#2#UikKICAgICAgICAgICAgICAgIGRzdFt6XSA9IG5wLmFzYXJyYXkocmVzaXplZCwgZHR5cGU9bnAu
#2#dWludDgpCiAgICAgICAgZm9yIChfLCBfLCBkc3QpIGluIG91dHM6CiAgICAgICAgICAgIGRzdC5m
#2#bHVzaCgpCiAgICBmaW5hbGx5OgogICAgICAgIGRlbCBzcmMKICAgICAgICBvdXRzLmNsZWFyKCkK
#2#ICAgIHJldHVybiB6MSAtIHowCgoKIyDilIDilIAgVGhlIDMtY2h1bmtfcGFja2VyIG1vZHVsZSwg
#2#Zm9yIHBhY2tpbmcgZWFjaCB0aW1lcG9pbnQgYXMgc29vbiBhcyBpdCBpcyBsZXZlbGxlZCDilIAK
#2#X1BBQ0tFUiA9IE5vbmUKCgpkZWYgX3BhY2tlcigpOgogICAgZ2xvYmFsIF9QQUNLRVIKICAgIGlm
#2#IF9QQUNLRVIgaXMgTm9uZToKICAgICAgICBzcGVjID0gaW1wb3J0bGliLnV0aWwuc3BlY19mcm9t
#2#X2ZpbGVfbG9jYXRpb24oImx1bWVuX2NodW5rX3BhY2tlciIsCiAgICAgICAgICAgICAgICAgICAg
#2#ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHN0cihIRVJFIC8gIjMtY2h1bmtfcGFj
#2#a2VyLnB5IikpCiAgICAgICAgbW9kdWxlID0gaW1wb3J0bGliLnV0aWwubW9kdWxlX2Zyb21fc3Bl
#2#YyhzcGVjKQogICAgICAgIHNwZWMubG9hZGVyLmV4ZWNfbW9kdWxlKG1vZHVsZSkKICAgICAgICBf
#2#UEFDS0VSID0gbW9kdWxlCiAgICByZXR1cm4gX1BBQ0tFUgoKCiMgVGhlIHBhY2tlcidzIHdvcmtl
#2#ciBmdW5jdGlvbnMgYXJlIHJlYWNoZWQgdGhyb3VnaCB0aGVzZSBtb2R1bGUtbGV2ZWwgd3JhcHBl
#2#cnM6IGEKIyBwcm9jZXNzIHBvb2wgY2FuIG9ubHkgY2FsbCBhIGZ1bmN0aW9uIGl0cyB3b3JrZXJz
#2#IGNhbiBpbXBvcnQgYnkgbmFtZSwgYW5kIHRoaXMgZmlsZQojIGlzIHRoZSBvbmUgdGhleSBpbXBv
#2#cnQuCmRlZiBlbmNvZGVfYnJpY2tfYmF0Y2goYXJncyk6CiAgICByZXR1cm4gX3BhY2tlcigpLmVu
#2#Y29kZV9icmlja19iYXRjaChhcmdzKQoKCmRlZiBsYXllcl9tYXhfZ3JpZChhcmdzKToKICAgIHJl
#2#dHVybiBfcGFja2VyKCkubGF5ZXJfbWF4X2dyaWQoYXJncykKCgojIOKUgOKUgCBNYWluIHNpZGUg
#2#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#2#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#2#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#2#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmRlZiBfcnVuKGV4ZWN1dG9yLCBmbiwgdGFza3Ms
#2#IGRlc2MpOgogICAgcmVzdWx0cyA9IGV4ZWN1dG9yLm1hcChmbiwgdGFza3MpIGlmIGV4ZWN1dG9y
#2#IGlzIG5vdCBOb25lIGVsc2UgbWFwKGZuLCB0YXNrcykKICAgIHJldHVybiBsaXN0KHRxZG0ocmVz
#2#dWx0cywgdG90YWw9bGVuKHRhc2tzKSwgZGVzYz1kZXNjLCBsZWF2ZT1GYWxzZSwgYXNjaWk9VHJ1
#2#ZSwKICAgICAgICAgICAgICAgICAgICAgbWluaW50ZXJ2YWw9Mi4wKSkKCgpkZWYgc2FtcGxlX2No
#2#YW5uZWwoZXhlY3V0b3IsIHBhdGgsIG5hbWUsIHNoYXBlKToKICAgICIiIldoaXRlLXBvaW50IHN1
#2#YnNhbXBsZSBhbmQgY29ybmVyIHNhbXBsZXMgb2Ygb25lIGNoYW5uZWwgdm9sdW1lLCBpbiBvbmUg
#2#cGFzcy4iIiIKICAgIHRpbGVzID0gcGxhbl90aWxlcyhzaGFwZSwgMCwgX3RpbGVfYnVkZ2V0KCkp
#2#CiAgICBzdWIgPSBucC5lbXB0eShzdWJzYW1wbGVfc2l6ZShzaGFwZSksIGR0eXBlPW5wLmZsb2F0
#2#MzIpCiAgICBjb3JuZXJzLCBjdXJzb3IgPSBbXSwgMAogICAgZm9yIHBhcnQsIGNvcm5lciBpbiBf
#2#cnVuKGV4ZWN1dG9yLCBzYW1wbGVfdGlsZSwgWyhwYXRoLCBuYW1lLCBzaGFwZSwgYikgZm9yIGIg
#2#aW4gdGlsZXNdLAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICJTYW1wbGluZyIpOgogICAg
#2#ICAgIHN1YltjdXJzb3I6Y3Vyc29yICsgcGFydC5zaXplXSA9IHBhcnQKICAgICAgICBjdXJzb3Ig
#2#Kz0gcGFydC5zaXplCiAgICAgICAgY29ybmVycy5hcHBlbmQoY29ybmVyKQogICAgcmV0dXJuIHN1
#2#Yls6Y3Vyc29yXSwgbnAuY29uY2F0ZW5hdGUoY29ybmVycykKCgpkZWYgX2VzdGltYXRlX2dsb2Jh
#2#bF9ib3VuZHMoZXhlY3V0b3IsIHBhdGgsIHJlczAsIHRwX2tleXMsIGNfaWR4LCBzaGFwZSk6CiAg
#2#ICAiIiJTaGFyZWQgW2JnX2Zsb29yLCBzaWdfbWF4XSB3aW5kb3cgZm9yIG9uZSBjaGFubmVsIG9m
#2#IGEgdGltZWxhcHNlLgoKICAgIExldmVsbGluZyBlYWNoIGZyYW1lIGFnYWluc3QgaXRzIG93biBw
#2#ZXJjZW50aWxlcyBtYWtlcyB0aGUgc2VyaWVzIGZsaWNrZXI6IGFzCiAgICB0aGUgc3BlY2ltZW4g
#2#YmxlYWNoZXMsIGEgcGVyLWZyYW1lIHdpbmRvdyBrZWVwcyByZS1zdHJldGNoaW5nIGEgZmFkaW5n
#2#IHNpZ25hbAogICAgYmFjayB0byBmdWxsIHJhbmdlLCBzbyB0aGUgYXBwYXJlbnQgYnJpZ2h0bmVz
#2#cyBzdGF5cyBjb25zdGFudCB3aGlsZSB0aGUgcmVhbAogICAgb25lIGNvbGxhcHNlcyDigJQgdmlz
#2#dWFsbHkgd3JvbmcgYW5kIHF1YW50aXRhdGl2ZWx5IG1pc2xlYWRpbmcuIFBvb2xpbmcgdGhlCiAg
#2#ICBjb3JuZXIgbm9pc2UgYW5kIHRoZSBzdWItc2FtcGxlZCBzaWduYWwgb3ZlciBzZXZlcmFsIGZy
#2#YW1lcyB5aWVsZHMgT05FIHdpbmRvdywKICAgIHdoaWNoIGlzIHRoZSBzYW1lIGVzdGltYXRvciB0
#2#aGUgc2luZ2xlLXRpbWVwb2ludCBwYXRoIHVzZXMsIGp1c3QgZXZhbHVhdGVkIG9uCiAgICB0aGUg
#2#cG9vbGVkIHNlcmllcy4gRnJhbWVzIHRoZW4gZGltIGV4YWN0bHkgYXMgbXVjaCBhcyB0aGUgc3Bl
#2#Y2ltZW4gcmVhbGx5IGRpZC4KICAgICIiIgogICAgbl90cCA9IGxlbih0cF9rZXlzKQogICAgY291
#2#bnQgPSBtaW4oR0xPQkFMX05PUk1fU0FNUExFUywgbl90cCkKICAgIGlmIGNvdW50ID49IG5fdHA6
#2#CiAgICAgICAgc2FtcGxlX2lkeCA9IGxpc3QocmFuZ2Uobl90cCkpCiAgICBlbHNlOgogICAgICAg
#2#IHNhbXBsZV9pZHggPSBzb3J0ZWQoe2ludChyb3VuZChpICogKG5fdHAgLSAxKSAvIChjb3VudCAt
#2#IDEpKSkgZm9yIGkgaW4gcmFuZ2UoY291bnQpfSkKCiAgICBjb3JuZXJfcG9vbCwgc2lnbmFsX3Bv
#2#b2wgPSBbXSwgW10KICAgIHByaW50KGYiW1BST0NFU1NdIEdsb2JhbCBub3JtYWxpemF0aW9uOiBz
#2#YW1wbGluZyB0aW1lcG9pbnRzIHtzYW1wbGVfaWR4fSBmb3IgY2hhbm5lbCB7Y19pZHh9Li4uIiwK
#2#ICAgICAgICAgIGZsdXNoPVRydWUpCiAgICBmb3IgdF9pZHggaW4gc2FtcGxlX2lkeDoKICAgICAg
#2#ICBjaF9rZXlzID0gc29ydGVkKFtrIGZvciBrIGluIHJlczBbdHBfa2V5c1t0X2lkeF1dLmtleXMo
#2#KSBpZiBrLnN0YXJ0c3dpdGgoIkNoYW5uZWwiKV0sCiAgICAgICAgICAgICAgICAgICAgICAgICBr
#2#ZXk9bGFtYmRhIHg6IGludCh4LnNwbGl0KClbLTFdKSkKICAgICAgICBpZiBjX2lkeCA+PSBsZW4o
#2#Y2hfa2V5cyk6CiAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAgbmFtZSA9IHJlczBbdHBfa2V5
#2#c1t0X2lkeF1dW2NoX2tleXNbY19pZHhdXVsiRGF0YSJdLm5hbWUKICAgICAgICBzdWIsIGNvcm5l
#2#ciA9IHNhbXBsZV9jaGFubmVsKGV4ZWN1dG9yLCBwYXRoLCBuYW1lLCBzaGFwZSkKICAgICAgICBj
#2#b3JuZXJfcG9vbC5hcHBlbmQoY29ybmVyKQogICAgICAgIHNpZ25hbF9wb29sLmFwcGVuZChzdWIp
#2#CgogICAgcG9vbGVkID0gbnAuY29uY2F0ZW5hdGUoc2lnbmFsX3Bvb2wpCiAgICBiZ19mbG9vciA9
#2#IGZsb2F0KG5wLnBlcmNlbnRpbGUobnAuY29uY2F0ZW5hdGUoY29ybmVyX3Bvb2wpLCA5OS4wKSkK
#2#CiAgICAjIFdoaXRlIHBvaW50ID0gInNhdHVyYXRlIHRoZSBicmlnaHRlc3QgMC4xICUgT0YgVEhF
#2#IFNJR05BTCIsIG5vdCBvZiB0aGUgdm9sdW1lLgogICAgIyBUaGUgc2luZ2xlLXRpbWVwb2ludCBy
#2#dWxlIHRha2VzIHRoZSA5OS45dGggcGVyY2VudGlsZSBvZiBldmVyeSB2b3hlbCwgd2hpY2gKICAg
#2#ICMgYXNzdW1lcyB0aGUgc3BlY2ltZW4gZmlsbHMgYSBnb29kIHNoYXJlIG9mIHRoZSBmcmFtZS4g
#2#QSB0aW1lbGFwc2Ugb2YgYSBzcGFyc2UKICAgICMgZmx1b3Jlc2NlbnQgc3RydWN0dXJlIGJyZWFr
#2#cyB0aGF0IGFzc3VtcHRpb246IGhlcmUgdGhlIHNpZ25hbCBpcyAwLjQgJSBvZiB0aGUKICAgICMg
#2#dm94ZWxzLCBzbyBhIHdob2xlLXZvbHVtZSBwZXJjZW50aWxlIHNpdHMgaW5zaWRlIHRoZSBiYWNr
#2#Z3JvdW5kIGFuZCBjbGlwcyAxNSAlCiAgICAjIG9mIHRoZSByZWFsIHNpZ25hbCB0byBwdXJlIHdo
#2#aXRlLiBSYW5raW5nIG9ubHkgdGhlIHZveGVscyBhYm92ZSB0aGUgbm9pc2UgZmxvb3IKICAgICMg
#2#a2VlcHMgdGhlIHNhbWUgaW50ZW50IGFuZCBkcm9wcyB0aGUgY2xpcHBlZCBmcmFjdGlvbiB0byB+
#2#MC4wNiAlLgogICAgYWJvdmUgPSBwb29sZWRbcG9vbGVkID4gYmdfZmxvb3JdCiAgICBpZiBhYm92
#2#ZS5zaXplID49IDEwMDA6CiAgICAgICAgc2lnX21heCA9IGZsb2F0KG5wLnBlcmNlbnRpbGUoYWJv
#2#dmUsIDk5LjkpKQogICAgICAgIGJhc2lzID0gZiJ7YWJvdmUuc2l6ZX0gdm94ZWxzIGFib3ZlIHRo
#2#ZSBub2lzZSBmbG9vciIKICAgIGVsc2U6CiAgICAgICAgc2lnX21heCA9IGZsb2F0KG5wLnBlcmNl
#2#bnRpbGUocG9vbGVkLCA5OS45KSkKICAgICAgICBiYXNpcyA9ICJ3aG9sZSB2b2x1bWUgKHRvbyBs
#2#aXR0bGUgc2lnbmFsIHRvIHJhbmspIgogICAgcHJpbnQoZiIgICAgZ2xvYmFsIGJnX2Zsb29yPXti
#2#Z19mbG9vcjouMmZ9ICBzaWdfbWF4PXtzaWdfbWF4Oi4yZn0gIgogICAgICAgICAgZiIocG9vbGVk
#2#IG92ZXIge2xlbihjb3JuZXJfcG9vbCl9IHRpbWVwb2ludHMsIHdoaXRlIHBvaW50IGZyb20ge2Jh
#2#c2lzfSkiLCBmbHVzaD1UcnVlKQogICAgX3dhcm5fd2luZG93KGJnX2Zsb29yLCBzaWdfbWF4LCBw
#2#b29sZWQpCiAgICByZXR1cm4gYmdfZmxvb3IsIHNpZ19tYXgKCgpkZWYgX3dhcm5fd2luZG93KGJn
#2#X2Zsb29yOiBmbG9hdCwgc2lnX21heDogZmxvYXQsIHN1YnNhbXBsZSkgLT4gTm9uZToKICAgICIi
#2#IlNheSBzbyB3aGVuIHRoZSB3aW5kb3cgaXMgc3VzcGVjdC4gTm90aGluZyBpcyBjaGFuZ2VkOiB0
#2#aGUgd2luZG93IGlzIHdoYXQgdGhlCiAgICBlc3RpbWF0b3IgZ2l2ZXMsIGFuZCBjaGFuZ2luZyBp
#2#dCBzaWxlbnRseSB3b3VsZCBtYWtlIHR3byBydW5zIG9mIG9uZSBmaWxlIGRpZmZlci4iIiIKICAg
#2#IGlmIHNpZ19tYXggLSBiZ19mbG9vciA8PSBtYXgoMS4wLCAwLjAxICogYWJzKGJnX2Zsb29yKSk6
#2#CiAgICAgICAgcHJpbnQoZiIgICAgWyFdIGZlbmV0cmUgcXVhc2kgbnVsbGUgKHNpZ19tYXggLSBi
#2#Z19mbG9vciA9IHtzaWdfbWF4IC0gYmdfZmxvb3I6LjNnfSkgOiAiCiAgICAgICAgICAgICAgZiJz
#2#aWduYWwgdHJlcyBlcGFycywgbGUgdm9sdW1lIHNlcmEgcHJlc3F1ZSBiaW5haXJlIiwgZmx1c2g9
#2#VHJ1ZSkKICAgIGlmIHN1YnNhbXBsZSBpcyBub3QgTm9uZSBhbmQgc3Vic2FtcGxlLnNpemU6CiAg
#2#ICAgICAgbWVkaWFuID0gZmxvYXQobnAubWVkaWFuKHN1YnNhbXBsZSkpCiAgICAgICAgaWYgYmdf
#2#Zmxvb3IgPiBtZWRpYW4gKiAxLjUgYW5kIGJnX2Zsb29yIC0gbWVkaWFuID4gMi4wOgogICAgICAg
#2#ICAgICBwcmludChmIiAgICBbIV0gYnJ1aXQgZGVzIGNvaW5zICh7YmdfZmxvb3I6LjJmfSkgYmll
#2#biBhdS1kZXNzdXMgZGUgbGEgbWVkaWFuZSBkdSB2b2x1bWUgIgogICAgICAgICAgICAgICAgICBm
#2#Iih7bWVkaWFuOi4yZn0pIDogdW4gY29pbiB0b3VjaGUgcGV1dC1ldHJlIGwnZWNoYW50aWxsb24g
#2#KHR1aWxlcywgcm9nbmFnZSkgIgogICAgICAgICAgICAgICAgICBmImV0IGxlIHNpZ25hbCBmYWli
#2#bGUgc2VyYSBjb3VwZSIsIGZsdXNoPVRydWUpCgoKZGVmIF9hbGxvY2F0ZShwYXRoOiBQYXRoLCBz
#2#aXplOiBpbnQpIC0+IE5vbmU6CiAgICB3aXRoIG9wZW4ocGF0aCwgIndiIikgYXMgZmg6CiAgICAg
#2#ICAgZmgudHJ1bmNhdGUoc2l6ZSkKCgpkZWYgbG9kX2xhZGRlcihXOiBpbnQsIEg6IGludCwgRDog
#2#aW50KToKICAgICIiIkxPRDAgYXQgbmF0aXZlIHNpemUsIHRoZW4gc3F1YXJlIDI1NsK3Ml5rIGxl
#2#dmVscyBiZWxvdyBtYXgoVywgSCksIGNvYXJzZXN0IGxhc3QuIiIiCiAgICBsb2RfaW5mbyA9IFt7
#2#ImxvZCI6IDAsICJ3aWR0aCI6IFcsICJoZWlnaHQiOiBILCAiZGVwdGgiOiBEfV0KICAgIG1heF9k
#2#aW0gPSBtYXgoVywgSCkKICAgIHRhcmdldF9kaW1zID0gW10KICAgIGN1cnJfZGltID0gMjU2CiAg
#2#ICB3aGlsZSBjdXJyX2RpbSA8IG1heF9kaW06CiAgICAgICAgdGFyZ2V0X2RpbXMuYXBwZW5kKGN1
#2#cnJfZGltKQogICAgICAgIGN1cnJfZGltICo9IDIKICAgIHRhcmdldF9kaW1zLnJldmVyc2UoKQog
#2#ICAgZm9yIGxvZCwgdGFyZ2V0X2RpbSBpbiBlbnVtZXJhdGUodGFyZ2V0X2RpbXMsIHN0YXJ0PTEp
#2#OgogICAgICAgIGxvZF9pbmZvLmFwcGVuZCh7ImxvZCI6IGxvZCwgIndpZHRoIjogdGFyZ2V0X2Rp
#2#bSwgImhlaWdodCI6IHRhcmdldF9kaW0sICJkZXB0aCI6IER9KQogICAgcmV0dXJuIGxvZF9pbmZv
#2#CgoKZGVmIHByb2Nlc3NfY2hhbm5lbChleGVjdXRvciwgcGF0aCwgbmFtZSwgc2hhcGUsIGxvZF9p
#2#bmZvLCB0ZW1wX2RpciwgdF9pZHgsIGNfaWR4LAogICAgICAgICAgICAgICAgICAgIGJvdW5kcz1O
#2#b25lKToKICAgICIiIkxldmVsIG9uZSBjaGFubmVsIG9mIG9uZSB0aW1lcG9pbnQgaW50byBpdHMg
#2#TE9EIGZpbGVzLiBgYm91bmRzYCBpcyB0aGUgc2hhcmVkCiAgICB3aW5kb3cgb2YgYSB0aW1lbGFw
#2#c2U7IHdpdGhvdXQgaXQgdGhlIHdpbmRvdyBjb21lcyBmcm9tIHRoaXMgdm9sdW1lLiBSZXR1cm5z
#2#IHRoZQogICAgOTkuOXRoIHBlcmNlbnRpbGUgb2YgdGhlIHJhdyBzdWJzYW1wbGUgKHRoZSBmcmFt
#2#ZSdzIHNpZ25hbCBsZXZlbCkuIiIiCiAgICBELCBILCBXID0gc2hhcGUKICAgIG5fdm94ZWxzID0g
#2#RCAqIEggKiBXCiAgICB3YW50X3N1YnNhbXBsZSA9IGJvdW5kcyBpcyBub3QgTm9uZQoKICAgICMg
#2#4pSA4pSA4pSAIFN0ZXAgMSA6IEJvdW5kIGVzdGltYXRpb24gKENvcm5lciBTYW1wbGluZykg4pSA
#2#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#2#4pSA4pSACiAgICAjIGJnX2Zsb29yID0gOTl0aCBwZXJjZW50aWxlIG9mIHRoZSA4IHZvbHVtZSBj
#2#b3JuZXJzIChwdXJlIGNhbWVyYSBiYWNrZ3JvdW5kLAogICAgIyBubyBlbWJyeW8gdGhlcmUpOyBz
#2#aWdfbWF4ID0gOTkuOXRoIHBlcmNlbnRpbGUgb2YgdGhlIGdsb2JhbGx5IHN1Yi1zYW1wbGVkCiAg
#2#ICAjIHZvbHVtZSAoc2F0dXJhdGUgdGhlIGJyaWdodGVzdCAwLjEgJSkuCiAgICBwcmludCgiICBT
#2#dGVwIDE6IEVzdGltYXRpb24gZGVzIGJvcm5lcyAoQ29ybmVyIFNhbXBsaW5nKS4uLiIsIGZsdXNo
#2#PVRydWUpCiAgICBpZiBib3VuZHMgaXMgTm9uZToKICAgICAgICBzdWIsIGNvcm5lcl9kYXRhID0g
#2#c2FtcGxlX2NoYW5uZWwoZXhlY3V0b3IsIHBhdGgsIG5hbWUsIHNoYXBlKQogICAgICAgIGJnX2Zs
#2#b29yID0gZmxvYXQobnAucGVyY2VudGlsZShjb3JuZXJfZGF0YSwgOTkuMCkpCiAgICAgICAgcHJp
#2#bnQoZiIgICAgYmdfZmxvb3IgKDk5ZSBjZW50aWxlIGR1IGJydWl0IGRlcyBjb2lucyk6IHtiZ19m
#2#bG9vcjouMmZ9IiwgZmx1c2g9VHJ1ZSkKICAgICAgICBmcmFtZV9zaWcgPSBmbG9hdChucC5wZXJj
#2#ZW50aWxlKHN1YiwgOTkuOSkpCiAgICAgICAgc2lnX21heCA9IGZyYW1lX3NpZwogICAgICAgIHBy
#2#aW50KGYiICAgIHNpZ19tYXggKDk5LjllIGNlbnRpbGUgZ2xvYmFsKToge3NpZ19tYXg6LjJmfSIs
#2#IGZsdXNoPVRydWUpCiAgICAgICAgX3dhcm5fd2luZG93KGJnX2Zsb29yLCBzaWdfbWF4LCBzdWIp
#2#CiAgICAgICAgZGVsIHN1YiwgY29ybmVyX2RhdGEKICAgIGVsc2U6CiAgICAgICAgYmdfZmxvb3Is
#2#IHNpZ19tYXggPSBib3VuZHMKCiAgICAjIOKUgOKUgOKUgCBTdGVwcyAyLTMgOiBzaWduYWwgbWFz
#2#aywgbWFza2VkIG1lZGlhbiwgd2luZG93IGxldmVsaW5nLCBwZXIgdGlsZSDilIAKICAgIHByaW50
#2#KCIgIFN0ZXAgMi0zOiBNYXNxdWUgZGUgc2lnbmFsICsgTWFza2VkIE1lZGlhbiBGaWx0ZXJpbmcg
#2#KyBXaW5kb3cgTGV2ZWxpbmcuLi4iLAogICAgICAgICAgZmx1c2g9VHJ1ZSkKICAgIGxvZDAgPSB0
#2#ZW1wX2RpciAvIGYidHt0X2lkeDowM2R9X2N7Y19pZHh9X2xvZDAuYmluIgogICAgX2FsbG9jYXRl
#2#KGxvZDAsIG5fdm94ZWxzKQogICAgdGlsZXMgPSBwbGFuX3RpbGVzKHNoYXBlLCBNQVNLX0hBTE8s
#2#IF90aWxlX2J1ZGdldCgpKQogICAgdGFza3MgPSBbKHBhdGgsIG5hbWUsIHNoYXBlLCBib3gsIGJn
#2#X2Zsb29yLCBzaWdfbWF4LCBzdHIobG9kMCksIHdhbnRfc3Vic2FtcGxlKQogICAgICAgICAgICAg
#2#Zm9yIGJveCBpbiB0aWxlc10KICAgIG1hc2tlZCwgcGFydHMgPSAwLCBbXQogICAgZm9yIGNvdW50
#2#LCBwYXJ0IGluIF9ydW4oZXhlY3V0b3IsIGxldmVsX3RpbGUsIHRhc2tzLCAiTWFza2VkIE1lZGlh
#2#biArIExldmVsaW5nIik6CiAgICAgICAgbWFza2VkICs9IGNvdW50CiAgICAgICAgaWYgcGFydCBp
#2#cyBub3QgTm9uZToKICAgICAgICAgICAgcGFydHMuYXBwZW5kKHBhcnQpCiAgICBwcmludChmIiAg
#2#ICBDb3V2ZXJ0dXJlIGR1IG1hc3F1ZTogezEwMC4wICogbWFza2VkIC8gbWF4KDEsIG5fdm94ZWxz
#2#KTouMmZ9JSBkZXMgdm94ZWxzIiwKICAgICAgICAgIGZsdXNoPVRydWUpCiAgICBpZiB3YW50X3N1
#2#YnNhbXBsZToKICAgICAgICBmcmFtZV9zaWcgPSBmbG9hdChucC5wZXJjZW50aWxlKG5wLmNvbmNh
#2#dGVuYXRlKHBhcnRzKSwgOTkuOSkpCiAgICAgICAgcHJpbnQoZiIgICAgYm9ybmVzIGdsb2JhbGVz
#2#OiBiZ19mbG9vcj17YmdfZmxvb3I6LjJmfSBzaWdfbWF4PXtzaWdfbWF4Oi4yZn0gIgogICAgICAg
#2#ICAgICAgIGYiKHNpZ25hbCBwcm9wcmUgYSBjZXR0ZSBmcmFtZToge2ZyYW1lX3NpZzouMmZ9KSIs
#2#IGZsdXNoPVRydWUpCiAgICAgICAgZGVsIHBhcnRzCgogICAgIyDilIDilIDilIAgU3RlcCA0IDog
#2#RXhwb3J0aW5nIGRvd25zY2FsZWQgTE9EIGxldmVscyDilIDilIDilIDilIDilIDilIDilIDilIDi
#2#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICAgIHBy
#2#aW50KCIgIFN0ZXAgNDogRXhwb3J0aW5nIGRvd25zY2FsZWQgTE9EIGxldmVscy4uLiIsIGZsdXNo
#2#PVRydWUpCiAgICB0YXJnZXRzID0gW10KICAgIGZvciBsaSBpbiBsb2RfaW5mb1sxOl06CiAgICAg
#2#ICAgcCA9IHRlbXBfZGlyIC8gZiJ0e3RfaWR4OjAzZH1fY3tjX2lkeH1fbG9ke2xpWydsb2QnXX0u
#2#YmluIgogICAgICAgIF9hbGxvY2F0ZShwLCBsaVsid2lkdGgiXSAqIGxpWyJoZWlnaHQiXSAqIEQp
#2#CiAgICAgICAgdGFyZ2V0cy5hcHBlbmQoKGxpWyJ3aWR0aCJdLCBsaVsiaGVpZ2h0Il0sIHN0cihw
#2#KSkpCiAgICBpZiB0YXJnZXRzOgogICAgICAgIHN0ZXAgPSBtYXgoMSwgLSgtRCAvLyAoNCAqIHdv
#2#cmtlcl9jb3VudCgpKSkpCiAgICAgICAgX3J1bihleGVjdXRvciwgZG93bnNjYWxlX3BsYW5lcywK
#2#ICAgICAgICAgICAgIFsoc3RyKGxvZDApLCBzaGFwZSwgeiwgbWluKHogKyBzdGVwLCBEKSwgdGFy
#2#Z2V0cykgZm9yIHogaW4gcmFuZ2UoMCwgRCwgc3RlcCldLAogICAgICAgICAgICAgIkV4cG9ydGlu
#2#ZyBMT0RzIikKICAgIHByaW50KGYiICBDaGFubmVsIHtjX2lkeH0gcHJvY2Vzc2VkIHN1Y2Nlc3Nm
#2#dWxseS4iKQogICAgcmV0dXJuIGZyYW1lX3NpZwoKCmRlZiBfZHJvcF9wYWNrZWRfZmlsZXModGVt
#2#cF9kaXI6IFBhdGgsIHRfaWR4OiBpbnQsIG5fY2g6IGludCwgbG9kX2luZm8pIC0+IE5vbmU6CiAg
#2#ICAiIiJPbmNlIGEgdGltZXBvaW50IGlzIGluIGl0cyBwYWNrcyBvbmx5IHR3byBvZiBpdHMgTE9E
#2#IGZpbGVzIGFyZSBzdGlsbCByZWFkOiB0aGUKICAgIGNvYXJzZXN0IG9uZSAoaGlzdG9ncmFtcywg
#2#c3RlcCAzKSBhbmQsIGZvciB0aGUgZmlyc3QgZnJhbWUsIHRoZSB0aHVtYm5haWwgbGV2ZWwuIiIi
#2#CiAgICBrZWVwID0ge2xvZF9pbmZvWy0xXVsibG9kIl19CiAgICBpZiB0X2lkeCA9PSAwOgogICAg
#2#ICAgIGtlZXAuYWRkKHRodW1ibmFpbF9sb2QobG9kX2luZm8pKQogICAgZm9yIGNfaWR4IGluIHJh
#2#bmdlKG5fY2gpOgogICAgICAgIGZvciBsaSBpbiBsb2RfaW5mbzoKICAgICAgICAgICAgaWYgbGlb
#2#ImxvZCJdIGluIGtlZXA6CiAgICAgICAgICAgICAgICBjb250aW51ZQogICAgICAgICAgICBwID0g
#2#dGVtcF9kaXIgLyBmInR7dF9pZHg6MDNkfV9je2NfaWR4fV9sb2R7bGlbJ2xvZCddfS5iaW4iCiAg
#2#ICAgICAgICAgIHRyeToKICAgICAgICAgICAgICAgIHAudW5saW5rKCkKICAgICAgICAgICAgZXhj
#2#ZXB0IEZpbGVOb3RGb3VuZEVycm9yOgogICAgICAgICAgICAgICAgcGFzcwogICAgICAgICAgICBl
#2#eGNlcHQgUGVybWlzc2lvbkVycm9yOgogICAgICAgICAgICAgICAgcHJpbnQoZiJbUFJPQ0VTU10g
#2#e3AubmFtZX0gZW5jb3JlIG91dmVydCwgc3VwcHJpbWUgZW4gZmluIGRlIHRyYWl0ZW1lbnQiLCBm
#2#bHVzaD1UcnVlKQoKCmRlZiBwcm9jZXNzX2ltYWdlKGlucHV0X2ltczogUGF0aCwgbWV0YWRhdGFf
#2#anNvbjogUGF0aCwgdGVtcF9kaXI6IFBhdGgsIHBhY2tfaW50bzogUGF0aCA9IE5vbmUsCiAgICAg
#2#ICAgICAgICAgICAgIGV4ZWN1dG9yPU5vbmUpOgogICAgIiIiTGV2ZWwgZXZlcnkgKHRpbWVwb2lu
#2#dCwgY2hhbm5lbCkgb2YgYW4gLmltcyBpbnRvIHRlbXAgTE9EIGZpbGVzLgoKICAgIFdpdGggYHBh
#2#Y2tfaW50b2AgKGEgZGF0YXNldCBkaXJlY3RvcnkpIGVhY2ggdGltZXBvaW50IGlzIHBhY2tlZCBp
#2#bnRvIGl0cyBicmlja3MvIGFzCiAgICBzb29uIGFzIGFsbCBpdHMgY2hhbm5lbHMgYXJlIGxldmVs
#2#bGVkLCBhbmQgaXRzIExPRCBmaWxlcyBhcmUgZGVsZXRlZDogdGhlIHRlbXBvcmFyeQogICAgZGlz
#2#ayB0aGVuIGhvbGRzIG9uZSBmcmFtZSBhdCBhIHRpbWUgaW5zdGVhZCBvZiB0aGUgd2hvbGUgYWNx
#2#dWlzaXRpb24uIGBleGVjdXRvcmAKICAgIGRlZmF1bHRzIHRvIG9uZSBwcm9jZXNzIHBvb2wgZm9y
#2#IHRoZSB3aG9sZSBydW4uCiAgICAiIiIKICAgIHdpdGggb3BlbihtZXRhZGF0YV9qc29uLCAiciIs
#2#IGVuY29kaW5nPSJ1dGYtOCIpIGFzIGY6CiAgICAgICAgbWV0YSA9IGpzb24ubG9hZChmKQoKICAg
#2#IFcsIEgsIEQgPSBtZXRhWyJ3aWR0aCJdLCBtZXRhWyJoZWlnaHQiXSwgbWV0YVsiZGVwdGgiXQog
#2#ICAgbl9jaCA9IG1ldGFbIm5fY2hhbm5lbHMiXQogICAgbl90cCA9IG1ldGFbIm5fdGltZXBvaW50
#2#cyJdCiAgICBzaGFwZSA9IChELCBILCBXKQogICAgdGVtcF9kaXIubWtkaXIocGFyZW50cz1UcnVl
#2#LCBleGlzdF9vaz1UcnVlKQogICAgcGF0aCA9IHN0cihpbnB1dF9pbXMpCgogICAgbG9kX2luZm8g
#2#PSBsb2RfbGFkZGVyKFcsIEgsIEQpCiAgICBwcmludChmIltQUk9DRVNTXSBMT0QgbGV2ZWxzIHRv
#2#IGdlbmVyYXRlOiB7bGVuKGxvZF9pbmZvKX0iKQogICAgZm9yIGxpIGluIGxvZF9pbmZvOgogICAg
#2#ICAgIHByaW50KGYiICBMT0Qge2xpWydsb2QnXX06IHtsaVsnd2lkdGgnXX14e2xpWydoZWlnaHQn
#2#XX14e2xpWydkZXB0aCddfSIpCgogICAgb3duX3Bvb2wgPSBleGVjdXRvciBpcyBOb25lCiAgICBp
#2#ZiBvd25fcG9vbDoKICAgICAgICBleGVjdXRvciA9IFByb2Nlc3NQb29sRXhlY3V0b3IobWF4X3dv
#2#cmtlcnM9d29ya2VyX2NvdW50KCkpCgogICAgZl9pbXMgPSBoNXB5LkZpbGUocGF0aCwgInIiKQog
#2#ICAgdHJ5OgogICAgICAgIHJlczAgPSBmX2ltc1siRGF0YVNldCJdWyJSZXNvbHV0aW9uTGV2ZWwg
#2#MCJdCiAgICAgICAgdHBfa2V5cyA9IHNvcnRlZChbayBmb3IgayBpbiByZXMwLmtleXMoKSBpZiBr
#2#LnN0YXJ0c3dpdGgoIlRpbWVQb2ludCIpXSwKICAgICAgICAgICAgICAgICAgICAgICAgIGtleT1s
#2#YW1iZGEgeDogaW50KHguc3BsaXQoKVstMV0pKQoKICAgICAgICAjIEEgdGltZWxhcHNlIGlzIGxl
#2#dmVsbGVkIGFnYWluc3QgT05FIHdpbmRvdyBwZXIgY2hhbm5lbCAoc2VlCiAgICAgICAgIyBfZXN0
#2#aW1hdGVfZ2xvYmFsX2JvdW5kcyk7IGEgc2luZ2xlLXRpbWVwb2ludCBkYXRhc2V0IGtlZXBzIHRo
#2#ZSBoaXN0b3JpY2FsCiAgICAgICAgIyBwZXItdm9sdW1lIGVzdGltYXRlIHNvIHByZXZpb3VzbHkg
#2#cHVibGlzaGVkIGRhdGFzZXRzIHJlcHJvY2VzcyBpZGVudGljYWxseS4KICAgICAgICBpc190aW1l
#2#bGFwc2UgPSBuX3RwID4gMQogICAgICAgIGdsb2JhbF9ib3VuZHMgPSB7fQogICAgICAgIGlmIGlz
#2#X3RpbWVsYXBzZToKICAgICAgICAgICAgZm9yIGNfaWR4IGluIHJhbmdlKG5fY2gpOgogICAgICAg
#2#ICAgICAgICAgZ2xvYmFsX2JvdW5kc1tjX2lkeF0gPSBfZXN0aW1hdGVfZ2xvYmFsX2JvdW5kcyhl
#2#eGVjdXRvciwgcGF0aCwgcmVzMCwgdHBfa2V5cywKICAgICAgICAgICAgICAgICAgICAgICAgICAg
#2#ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY19pZHgsIHNoYXBlKQoKICAgICAg
#2#ICAjIFBlci0odGltZXBvaW50LCBjaGFubmVsKSBicmlnaHRuZXNzIG9mIHRoZSBSQVcgc2lnbmFs
#2#LCByZWNvcmRlZCBidXQgbmV2ZXIKICAgICAgICAjIGJha2VkIGludG8gdGhlIHZveGVsczogYmxl
#2#YWNoaW5nIGNvcnJlY3Rpb24gc3RheXMgYSByZXZlcnNpYmxlIGRpc3BsYXkgY2hvaWNlLgogICAg
#2#ICAgIHNpZ25hbF9sZXZlbHMgPSB7fQogICAgICAgIGJyaWNrc19kaXIgPSBQYXRoKHBhY2tfaW50
#2#bykgLyAiYnJpY2tzIiBpZiBwYWNrX2ludG8gZWxzZSBOb25lCgogICAgICAgIGZvciB0X2lkeCwg
#2#dHBfa2V5IGluIGVudW1lcmF0ZSh0cF9rZXlzKToKICAgICAgICAgICAgY2hfa2V5cyA9IHNvcnRl
#2#ZChbayBmb3IgayBpbiByZXMwW3RwX2tleV0ua2V5cygpIGlmIGsuc3RhcnRzd2l0aCgiQ2hhbm5l
#2#bCIpXSwKICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk9bGFtYmRhIHg6IGludCh4LnNw
#2#bGl0KClbLTFdKSkKICAgICAgICAgICAgZm9yIGNfaWR4LCBjaF9rZXkgaW4gZW51bWVyYXRlKGNo
#2#X2tleXMpOgogICAgICAgICAgICAgICAgcHJpbnQoZiJbUFJPQ0VTU10gUHJvY2Vzc2luZyBDaGFu
#2#bmVsIHtjX2lkeH0gKFQge3RfaWR4fSkuLi4iLCBmbHVzaD1UcnVlKQogICAgICAgICAgICAgICAg
#2#bmFtZSA9IHJlczBbdHBfa2V5XVtjaF9rZXldWyJEYXRhIl0ubmFtZQogICAgICAgICAgICAgICAg
#2#ZnJhbWVfc2lnID0gcHJvY2Vzc19jaGFubmVsKGV4ZWN1dG9yLCBwYXRoLCBuYW1lLCBzaGFwZSwg
#2#bG9kX2luZm8sIHRlbXBfZGlyLAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg
#2#ICAgICAgIHRfaWR4LCBjX2lkeCwgZ2xvYmFsX2JvdW5kcy5nZXQoY19pZHgpKQogICAgICAgICAg
#2#ICAgICAgc2lnbmFsX2xldmVsc1tmInR7dF9pZHg6MDNkfV9je2NfaWR4fSJdID0gcm91bmQoZnJh
#2#bWVfc2lnLCA0KQoKICAgICAgICAgICAgaWYgYnJpY2tzX2RpciBpcyBub3QgTm9uZToKICAgICAg
#2#ICAgICAgICAgIGtleSA9IGYidHt0X2lkeDowM2R9IiBpZiBpc190aW1lbGFwc2UgZWxzZSAiIgog
#2#ICAgICAgICAgICAgICAgbGV2ZWxzLCB0cmFuc3BvcnQgPSBfcGFja2VyKCkucGFja190aW1lcG9p
#2#bnQoCiAgICAgICAgICAgICAgICAgICAgdGVtcF9kaXIsIGJyaWNrc19kaXIsIHRfaWR4LCBsb2Rf
#2#aW5mbywgbl9jaCwgZXhlY3V0b3IsIGtleSwKICAgICAgICAgICAgICAgICAgICBlbmNvZGVfZm49
#2#ZW5jb2RlX2JyaWNrX2JhdGNoLCBsYXllcl9mbj1sYXllcl9tYXhfZ3JpZCkKICAgICAgICAgICAg
#2#ICAgIGF0b21pY193cml0ZV9qc29uKHRlbXBfZGlyIC8gZiJwYWNrX3R7dF9pZHg6MDNkfS5qc29u
#2#IiwKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsibGV2ZWxzIjogbGV2ZWxzLCAi
#2#YnJpY2tUcmFuc3BvcnQiOiB0cmFuc3BvcnR9LAogICAgICAgICAgICAgICAgICAgICAgICAgICAg
#2#ICAgICAgc2VwYXJhdG9ycz0oIiwiLCAiOiIpKQogICAgICAgICAgICAgICAgX2Ryb3BfcGFja2Vk
#2#X2ZpbGVzKHRlbXBfZGlyLCB0X2lkeCwgbl9jaCwgbG9kX2luZm8pCiAgICBmaW5hbGx5OgogICAg
#2#ICAgIGZfaW1zLmNsb3NlKCkKICAgICAgICBfY2xvc2VfaDVfZmlsZXMoKQogICAgICAgIGlmIG93
#2#bl9wb29sOgogICAgICAgICAgICBleGVjdXRvci5zaHV0ZG93bigpCgogICAgIyBTYXZlIHRoZSBM
#2#T0QgaW5mbyBmb3IgbmV4dCBzdGVwCiAgICBhdG9taWNfd3JpdGVfanNvbih0ZW1wX2RpciAvICJw
#2#cm9jZXNzaW5nX21ldGEuanNvbiIsIHsKICAgICAgICAibG9kX2xldmVscyI6IGxvZF9pbmZvLAog
#2#ICAgICAgICJ2b3hlbF9zaXplIjogbWV0YVsidm94ZWxfc2l6ZSJdLAogICAgICAgICJjaGFubmVs
#2#X25hbWVzIjogbWV0YVsiY2hhbm5lbF9uYW1lcyJdLAogICAgICAgICJ3aWR0aCI6IFcsCiAgICAg
#2#ICAgImhlaWdodCI6IEgsCiAgICAgICAgImRlcHRoIjogRCwKICAgICAgICAibl9jaGFubmVscyI6
#2#IG5fY2gsCiAgICAgICAgIm5fdGltZXBvaW50cyI6IG5fdHAsCiAgICAgICAgImV4dGVudCI6IG1l
#2#dGEuZ2V0KCJleHRlbnQiKSwKICAgICAgICAidGltZXN0YW1wcyI6IG1ldGEuZ2V0KCJ0aW1lc3Rh
#2#bXBzIiksCiAgICAgICAgInRpbWVfaW50ZXJ2YWxfbWludXRlcyI6IG1ldGEuZ2V0KCJ0aW1lX2lu
#2#dGVydmFsX21pbnV0ZXMiKSwKICAgICAgICAibm9ybWFsaXphdGlvbiI6IHsKICAgICAgICAgICAg
#2#Im1vZGUiOiAiZ2xvYmFsIiBpZiBpc190aW1lbGFwc2UgZWxzZSAicGVyLXZvbHVtZSIsCiAgICAg
#2#ICAgICAgICJib3VuZHMiOiB7ZiJje2N9IjogeyJiZ0Zsb29yIjogcm91bmQoYlswXSwgNCksICJz
#2#aWdNYXgiOiByb3VuZChiWzFdLCA0KX0KICAgICAgICAgICAgICAgICAgICAgICBmb3IgYywgYiBp
#2#biBnbG9iYWxfYm91bmRzLml0ZW1zKCl9LAogICAgICAgICAgICAic2lnbmFsTGV2ZWxzIjogc2ln
#2#bmFsX2xldmVscwogICAgICAgIH0KICAgIH0sIGluZGVudD0yKQoKCmlmIF9fbmFtZV9fID09ICJf
#2#X21haW5fXyI6CiAgICBhcCA9IGFyZ3BhcnNlLkFyZ3VtZW50UGFyc2VyKGRlc2NyaXB0aW9uPSJM
#2#ZXZlbCBhbiAuaW1zIGludG8gdGVtcG9yYXJ5IExPRCB2b2x1bWVzLiIpCiAgICBhcC5hZGRfYXJn
#2#dW1lbnQoImlucHV0X2ltcyIpCiAgICBhcC5hZGRfYXJndW1lbnQoIm1ldGFkYXRhX2pzb24iKQog
#2#ICAgYXAuYWRkX2FyZ3VtZW50KCJ0ZW1wX2RpciIpCiAgICBhcC5hZGRfYXJndW1lbnQoIi0tcGFj
#2#ay1pbnRvIiwgZGVmYXVsdD1Ob25lLAogICAgICAgICAgICAgICAgICAgIGhlbHA9ImRhdGFzZXQg
#2#ZGlyZWN0b3J5OiBwYWNrIGVhY2ggdGltZXBvaW50IGludG8gaXRzIGJyaWNrcy8gYXMgc29vbiBh
#2#cyAiCiAgICAgICAgICAgICAgICAgICAgICAgICAiaXQgaXMgbGV2ZWxsZWQsIHRoZW4gZGVsZXRl
#2#IGl0cyB0ZW1wb3JhcnkgTE9EIGZpbGVzIikKICAgIGFyZ3MgPSBhcC5wYXJzZV9hcmdzKCkKCiAg
#2#ICB0cnk6CiAgICAgICAgcHJvY2Vzc19pbWFnZShQYXRoKGFyZ3MuaW5wdXRfaW1zKSwgUGF0aChh
#2#cmdzLm1ldGFkYXRhX2pzb24pLCBQYXRoKGFyZ3MudGVtcF9kaXIpLAogICAgICAgICAgICAgICAg
#2#ICAgICAgUGF0aChhcmdzLnBhY2tfaW50bykgaWYgYXJncy5wYWNrX2ludG8gZWxzZSBOb25lKQog
#2#ICAgICAgIHByaW50KGYiW1BST0NFU1NdIEltYWdlIHByb2Nlc3NpbmcgY29tcGxldGUuIikKICAg
#2#IGV4Y2VwdCBFeGNlcHRpb24gYXMgZToKICAgICAgICBpbXBvcnQgdHJhY2ViYWNrCiAgICAgICAg
#2#dHJhY2ViYWNrLnByaW50X2V4YygpCiAgICAgICAgcHJpbnQoZiJbRVJST1JdIEltYWdlIHByb2Nl
#2#c3NpbmcgZmFpbGVkOiB7ZX0iLCBmaWxlPXN5cy5zdGRlcnIpCiAgICAgICAgc3lzLmV4aXQoMSkK
:: ---- [3] 3-chunk_packer.py (20149 octets) ----
#3#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwppbXBvcnQgaGFzaGxpYgppbXBvcnQgaW8KaW1wb3J0IGl0
#3#ZXJ0b29scwppbXBvcnQgbWF0aAppbXBvcnQgb3MKaW1wb3J0IHN5cwpmcm9tIGNvbGxlY3Rpb25z
#3#IGltcG9ydCBkZXF1ZQpmcm9tIGNvbmN1cnJlbnQuZnV0dXJlcyBpbXBvcnQgUHJvY2Vzc1Bvb2xF
#3#eGVjdXRvcgpmcm9tIHBhdGhsaWIgaW1wb3J0IFBhdGgKaW1wb3J0IG51bXB5IGFzIG5wCmZyb20g
#3#UElMIGltcG9ydCBJbWFnZQoKSEVSRSA9IFBhdGgoX19maWxlX18pLnJlc29sdmUoKS5wYXJlbnQK
#3#aWYgc3RyKEhFUkUpIG5vdCBpbiBzeXMucGF0aDoKICAgIHN5cy5wYXRoLmluc2VydCgwLCBzdHIo
#3#SEVSRSkpCmZyb20gcnVuX3ByZXByb2Nlc3MgaW1wb3J0IHdvcmtlcl9jb3VudCwgYXRvbWljX3dy
#3#aXRlX2pzb24sIHJlYWRfanNvbl9maWxlICAjIG5vcWE6IEU0MDIKCiMgRW1wdHktc3BhY2Ugc2tp
#3#cHBpbmcgY291bnRzIHRoZSB2b3hlbHMgdGhlIFJFTkRFUkVSIGNhbiBkcmF3LCBub3QgdGhlIHZv
#3#eGVscyB0aGF0CiMgYXJlIG1lcmVseSBub24temVyby4KIwojIFdpbmRvdyBsZXZlbGluZyBpbiAy
#3#LWltYWdlX3Byb2Nlc3Nvci5weSBtYXBzIFtiZ19mbG9vciwgc2lnX21heF0gb250byBbMCwgMjU1
#3#XSwgc28gYQojIHZveGVsIHNpdHRpbmcgb25lIHN0ZXAgYWJvdmUgdGhlIG5vaXNlIGZsb29yIGxh
#3#bmRzIG9uIDEuIEJhY2tncm91bmQgbm9pc2Ugc3RyYWRkbGluZwojIGJnX2Zsb29yIHRoZXJlZm9y
#3#ZSBhbHdheXMgbGVhdmVzIGEgc3BlY2tsZSBvZiAxcyDigJQgdGhhdCBpcyBhcml0aG1ldGljLCBu
#3#b3QgYSBkZWZlY3QuCiMgQ291bnRpbmcgdGhvc2UgYXMgY29udGVudCBtYWRlIGEgYnJpY2sgdGhh
#3#dCBpcyA5Ny05OSAlIHplcm8gcGFzcyB0aGUgdGVzdDogbWVhc3VyZWQgb24KIyB0aGUgcHVibGlz
#3#aGVkIERlY2lkdWEgYnJpY2tzLCB0aGUgZWlnaHQgY29ybmVyIGJyaWNrcyBhcmUgOTYuOSAlLCA5
#3#OC41ICUgYW5kIDk4LjkgJQojIHplcm8gKDk5dGggcGVyY2VudGlsZSA9IDEpIGFuZCB3ZXJlIGFs
#3#bCBrZXB0LCB3aGljaCBpcyB3aHkgdGhhdCBkYXRhc2V0IHJlcG9ydHMgNzIwMAojIG5vbi1lbXB0
#3#eSBicmlja3Mgb3V0IG9mIDcyMDAgYW5kIGRvd25sb2FkcyB+NHggd2hhdCBhIGNvbXBhcmFibGUg
#3#b25lIGRvZXMuCiMKIyBUaGUgdmlld2VyIG5ldmVyIHNob3dzIHRob3NlIHZveGVscy4gdm9sdW1l
#3#LXZpZXdlci5qczpfZmxvb3JzRnJvbU1hbmlmZXN0IGRlcml2ZXMgYQojIHBlci1jaGFubmVsIGJh
#3#Y2tncm91bmQgZmxvb3IgYW5kIGNsYW1wcyBpdCB0byBbNiwgNDhdIChpdCByZWFjaGVzIHRoZSBs
#3#b3cgZW5kIG9mIHRoYXQKIyBjbGFtcCB3aGVuZXZlciB0aGUgbWFuaWZlc3QgY2FycmllcyBubyBl
#3#eHBsaWNpdCBiYWNrZ3JvdW5kRmxvb3IsIHdoaWNoIGlzIGV2ZXJ5CiMgZGF0YXNldCBwdWJsaXNo
#3#ZWQgc28gZmFyKS4gQW55dGhpbmcgdW5kZXIgNiBpcyBjcnVzaGVkIHRvIHplcm8gYnkgdGhlIExV
#3#VCBiZWZvcmUgdGhlCiMgcmF5IG1hcmNoZXIgZXZlciBzZWVzIGl0LiBBIHZveGVsIGFib3ZlIERJ
#3#U1BMQVlfRkxPT1IgPSA1IGlzIHRoZXJlZm9yZSAiZHJhd2FibGUiLgojCiMgQSBicmljayBpcyBr
#3#ZXB0IHdoZW4gQk9USCBob2xkOgojICAgKGEpIGl0IGhhcyBhdCBsZWFzdCBvbmUgZHJhd2FibGUg
#3#dm94ZWwg4oCUIGEgYnJpY2sgd2l0aG91dCBvbmUgY2Fubm90IGNvbnRyaWJ1dGUgYQojICAgICAg
#3#IHNpbmdsZSBwaXhlbCwgaG93ZXZlciBtYW55IHF1YW50aXphdGlvbi1ub2lzZSAxcyBpdCBjYXJy
#3#aWVzOwojICAgKGIpIGl0cyBub24temVybyB2b3hlbHMgKGRyYXdhYmxlIG9uZXMgQU5EIG5vaXNl
#3#IDFzKSBleGNlZWQgRVNTX01JTl9PQ0NVUEFOQ1kgb2YgaXRzCiMgICAgICAgdmFsaWQgdm94ZWxz
#3#IOKAlCB0aGUgaGlzdG9yaWMgYmFuZHdpZHRoIHRvbGVyYW5jZSwgMC4wMDA1IHggNjReMyA9IDEz
#3#MSB2b3hlbHMgZm9yCiMgICAgICAgYSBmdWxsIGJyaWNrLgojIChiKSBpcyBhIGRlbGliZXJhdGUg
#3#dHJhZGUtb2ZmLCBub3QgYSBub2lzZSBmaWx0ZXI6IGEgYnJpY2sgaG9sZGluZyBhIGZldyBicmln
#3#aHQgdm94ZWxzCiMgb2YgYSB0aGluIHZlc3NlbCB0aXAgb3IgYW4gaXNvbGF0ZWQgY2VsbCAoYW5k
#3#IGxpdHRsZSBub2lzZSBhcm91bmQgdGhlbSkgZmFpbHMgaXQgYW5kIGlzCiMgZHJvcHBlZCwgc28g
#3#YXQgbW9zdCAxMzEgZHJhd2FibGUgdm94ZWxzIHBlciBicmljayBhcmUgZ2l2ZW4gdXAgdG8gc2F2
#3#ZSBhIGRvd25sb2FkLgojIFJlcGxheWluZyB0aGUgcnVsZSBvdmVyIGV2ZXJ5IHB1Ymxpc2hlZCBi
#3#cmljayBvZiBhIExPRCwgKGEpIGFsb25lIHRvb2sgRGVjaWR1YSBsb2QyCiMgZnJvbSAxODM2IGtl
#3#cHQgYnJpY2tzIHRvIDE0MzQgYW5kIHRoZSBoZWFsdGh5IEVtMTAgbG9kMiBmcm9tIDkzMiB0byA5
#3#MzA7IGRyb3BwaW5nIChiKQojIHdvdWxkIGtlZXAgMjkxIE1PUkUgRGVjaWR1YSBsb2QyIGJyaWNr
#3#cywgZWFjaCBob2xkaW5nIGF0IG1vc3QgMTMxIGRyYXdhYmxlIHZveGVscy4KIyBUaGUgcGFja2Vy
#3#IHJlcG9ydHMsIHBlciBMT0QsIGhvdyBtYW55IGJyaWNrcyB3aXRoIGRyYXdhYmxlIHZveGVscyAo
#3#YikgZHJvcHBlZCBhbmQgaG93CiMgbWFueSBzdWNoIHZveGVscyB0aGV5IGhlbGQuIExVTUVOX0VT
#3#U19NSU5fT0NDVVBBTkNZIG92ZXJyaWRlcyB0aGUgdG9sZXJhbmNlICgwIGtlZXBzCiMgZXZlcnkg
#3#YnJpY2sgd2l0aCBhIGRyYXdhYmxlIHZveGVsKTsgdW5zZXQsIHRoZSBvdXRwdXQgaXMgdGhlIGhp
#3#c3RvcmljIG9uZS4KRElTUExBWV9GTE9PUiA9IDUgICAgICAgICAgICMgdGhlIHZpZXdlcidzIExV
#3#VCBjcnVzaGVzIGV2ZXJ5dGhpbmcgYmVsb3cgNiB0byB6ZXJvCgoKZGVmIF9lc3NfbWluX29jY3Vw
#3#YW5jeSgpIC0+IGZsb2F0OgogICAgcmF3ID0gb3MuZW52aXJvbi5nZXQoIkxVTUVOX0VTU19NSU5f
#3#T0NDVVBBTkNZIiwgIiIpLnN0cmlwKCkKICAgIGlmIHJhdzoKICAgICAgICB0cnk6CiAgICAgICAg
#3#ICAgIHZhbHVlID0gZmxvYXQocmF3KQogICAgICAgICAgICBpZiAwLjAgPD0gdmFsdWUgPCAxLjA6
#3#CiAgICAgICAgICAgICAgICByZXR1cm4gdmFsdWUKICAgICAgICBleGNlcHQgVmFsdWVFcnJvcjoK
#3#ICAgICAgICAgICAgcGFzcwogICAgICAgIHByaW50KGYiW1BBQ0tFUl0gTFVNRU5fRVNTX01JTl9P
#3#Q0NVUEFOQ1k9e3JhdyFyfSBpZ25vcmUgKDAgPD0geCA8IDEgYXR0ZW5kdSkiLCBmbHVzaD1UcnVl
#3#KQogICAgcmV0dXJuIDAuMDAwNQoKCkVTU19NSU5fT0NDVVBBTkNZID0gX2Vzc19taW5fb2NjdXBh
#3#bmN5KCkKCkJSSUNLX1NJWkUgPSA2NApDSFVOS1NfUEVSX1BBQ0sgPSAxMjgKQlJJQ0tTX1BFUl9U
#3#QVNLID0gMTYgICAgICAgICMgYnJpY2tzIGEgd29ya2VyIHJlYWRzIGFuZCBlbmNvZGVzIHBlciB0
#3#YXNrCgoKZGVmIHByb2Nlc3NfY2h1bmsoYXJncyk6CiAgICBjaHVua19kYXRhLCBjaF9tZXRhLCBC
#3#UklDS19TSVpFID0gYXJncwogICAgbm9uX3plcm8gPSBucC5jb3VudF9ub256ZXJvKGNodW5rX2Rh
#3#dGEpCiAgICB2YWxpZF92b3hlbHMgPSBtYXgoMSwgY2hfbWV0YVsidmFsaWRWb3hlbENvdW50Il0p
#3#CiAgICBvY2MgPSBmbG9hdChub25femVybykgLyBmbG9hdCh2YWxpZF92b3hlbHMpCgogICAgIyBB
#3#IGJyaWNrIGhvbGRpbmcgbm90aGluZyBhdCBvciBhYm92ZSB0aGUgZGlzcGxheSBmbG9vciBjYW5u
#3#b3QgY29udHJpYnV0ZSBhIHNpbmdsZQogICAgIyBwaXhlbDogaXQgaXMgZW1wdHkgaG93ZXZlciBt
#3#YW55IHF1YW50aXphdGlvbi1ub2lzZSAxcyBpdCBjYXJyaWVzLgogICAgaGFzX2RyYXdhYmxlID0g
#3#Ym9vbChucC5hbnkoY2h1bmtfZGF0YSA+IERJU1BMQVlfRkxPT1IpKQoKICAgIGlzX25vbl9lbXB0
#3#eSA9IG9jYyA+IEVTU19NSU5fT0NDVVBBTkNZIGFuZCBoYXNfZHJhd2FibGUKICAgIGlmIG5vdCBp
#3#c19ub25fZW1wdHk6CiAgICAgICAgcmV0dXJuIChjaF9tZXRhWyJpZHgiXSwgMC4wIGlmIG5vdCBo
#3#YXNfZHJhd2FibGUgZWxzZSBvY2MsIEZhbHNlLCBOb25lKQoKICAgIHBhZGRlZCA9IG5wLnplcm9z
#3#KChCUklDS19TSVpFLCBCUklDS19TSVpFLCBCUklDS19TSVpFKSwgZHR5cGU9bnAudWludDgpCiAg
#3#ICBkLCBoLCB3ID0gY2h1bmtfZGF0YS5zaGFwZQogICAgcGFkZGVkWzpkLCA6aCwgOnddID0gY2h1
#3#bmtfZGF0YQoKICAgIG1vc2FpYyA9IG5wLnplcm9zKCg1MTIsIDUxMiksIGR0eXBlPW5wLnVpbnQ4
#3#KQogICAgZm9yIHogaW4gcmFuZ2UoNjQpOgogICAgICAgIHJvdyA9IHogLy8gOAogICAgICAgIGNv
#3#bCA9IHogJSA4CiAgICAgICAgbW9zYWljW3Jvdyo2NDoocm93KzEpKjY0LCBjb2wqNjQ6KGNvbCsx
#3#KSo2NF0gPSBwYWRkZWRbel0KCiAgICBpbWcgPSBJbWFnZS5mcm9tYXJyYXkobW9zYWljKQogICAg
#3#YnVmID0gaW8uQnl0ZXNJTygpCiAgICBpbWcuc2F2ZShidWYsIGZvcm1hdD0iV0VCUCIsIGxvc3Ns
#3#ZXNzPVRydWUpCiAgICByZXR1cm4gKGNoX21ldGFbImlkeCJdLCBvY2MsIFRydWUsIGJ1Zi5nZXR2
#3#YWx1ZSgpKQoKCiMg4pSA4pSAIFdvcmtlciB0YXNrczogdGhleSByZWFkIHRoZSBMT0QgZmlsZSB0
#3#aGVtc2VsdmVzLCBzbyBubyB2b3hlbCBjcm9zc2VzIGEgcGlwZSDilIAKZGVmIGVuY29kZV9icmlj
#3#a19iYXRjaChhcmdzKToKICAgICIiIkVuY29kZSBhIHJ1biBvZiBicmlja3Mgb2Ygb25lIChMT0Qs
#3#IGNoYW5uZWwpIGZpbGUuCgogICAgaXRlbXM6IFsoaWR4LCAoejAsIHoxLCB5MCwgeTEsIHgwLCB4
#3#MSksIHZhbGlkVm94ZWxDb3VudCldLiBSZXR1cm5zLCBwZXIgYnJpY2ssCiAgICBwcm9jZXNzX2No
#3#dW5rJ3MgKGlkeCwgb2NjLCBrZXB0LCBieXRlcykgcGx1cyB0aGUgbnVtYmVyIG9mIGRyYXdhYmxl
#3#IHZveGVscyBhIGRyb3BwZWQKICAgIGJyaWNrIGhlbGQgKDAgZm9yIGEga2VwdCBvbmUpLgogICAg
#3#IiIiCiAgICBiaW5fcGF0aCwgc2hhcGUsIGl0ZW1zID0gYXJncwogICAgdm9sID0gbnAubWVtbWFw
#3#KGJpbl9wYXRoLCBkdHlwZT1ucC51aW50OCwgbW9kZT0iciIsIHNoYXBlPXR1cGxlKHNoYXBlKSkK
#3#ICAgIG91dCA9IFtdCiAgICB0cnk6CiAgICAgICAgZm9yIGlkeCwgKHowLCB6MSwgeTAsIHkxLCB4
#3#MCwgeDEpLCB2YWxpZCBpbiBpdGVtczoKICAgICAgICAgICAgY2h1bmsgPSBucC5hcnJheSh2b2xb
#3#ejA6ejEsIHkwOnkxLCB4MDp4MV0pCiAgICAgICAgICAgIGlkeCwgb2NjLCBrZXB0LCBkYXRhID0g
#3#cHJvY2Vzc19jaHVuaygoY2h1bmssIHsiaWR4IjogaWR4LCAidmFsaWRWb3hlbENvdW50IjogdmFs
#3#aWR9LAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIEJS
#3#SUNLX1NJWkUpKQogICAgICAgICAgICBkcm9wcGVkID0gMCBpZiBrZXB0IG9yIG9jYyA8PSAwLjAg
#3#ZWxzZSBpbnQobnAuY291bnRfbm9uemVybyhjaHVuayA+IERJU1BMQVlfRkxPT1IpKQogICAgICAg
#3#ICAgICBvdXQuYXBwZW5kKChpZHgsIG9jYywga2VwdCwgZGF0YSwgZHJvcHBlZCkpCiAgICBmaW5h
#3#bGx5OgogICAgICAgIGRlbCB2b2wKICAgIHJldHVybiBvdXQKCgpkZWYgbGF5ZXJfbWF4X2dyaWQo
#3#YXJncyk6CiAgICAiIiJQZXItYnJpY2sgbWF4aW11bSBvZiBvbmUgNjQtcGxhbmUgYnJpY2sgbGF5
#3#ZXIgb2YgYSBMT0QgZmlsZSwgcmVhZCBwbGFuZSBieSBwbGFuZToKICAgIGEgKG55LCBueCkgdWlu
#3#dDggZ3JpZC4iIiIKICAgIGJpbl9wYXRoLCBzaGFwZSwgYnogPSBhcmdzCiAgICBELCBILCBXID0g
#3#c2hhcGUKICAgIHZvbCA9IG5wLm1lbW1hcChiaW5fcGF0aCwgZHR5cGU9bnAudWludDgsIG1vZGU9
#3#InIiLCBzaGFwZT0oRCwgSCwgVykpCiAgICB5cyA9IG5wLmFyYW5nZSgwLCBILCBCUklDS19TSVpF
#3#KQogICAgeHMgPSBucC5hcmFuZ2UoMCwgVywgQlJJQ0tfU0laRSkKICAgIGdyaWQgPSBucC56ZXJv
#3#cygobGVuKHlzKSwgbGVuKHhzKSksIGR0eXBlPW5wLnVpbnQ4KQogICAgdHJ5OgogICAgICAgIGZv
#3#ciB6IGluIHJhbmdlKGJ6ICogQlJJQ0tfU0laRSwgbWluKEQsIChieiArIDEpICogQlJJQ0tfU0la
#3#RSkpOgogICAgICAgICAgICBwbGFuZSA9IG5wLmFzYXJyYXkodm9sW3pdKQogICAgICAgICAgICBu
#3#cC5tYXhpbXVtKGdyaWQsIG5wLm1heGltdW0ucmVkdWNlYXQobnAubWF4aW11bS5yZWR1Y2VhdChw
#3#bGFuZSwgeXMsIGF4aXM9MCksCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg
#3#ICAgICAgICAgICB4cywgYXhpcz0xKSwgb3V0PWdyaWQpCiAgICBmaW5hbGx5OgogICAgICAgIGRl
#3#bCB2b2wKICAgIHJldHVybiBncmlkCgoKX0RPTkUgPSBvYmplY3QoKQoKCmRlZiBvcmRlcmVkX3Jl
#3#c3VsdHMoZXhlY3V0b3IsIGZuLCB0YXNrcywgd2luZG93OiBpbnQpOgogICAgIiIiUmVzdWx0cyBv
#3#ZiBmbiBvdmVyIHRhc2tzLCBpbiBvcmRlciwgd2l0aCBhdCBtb3N0IGB3aW5kb3dgIHRhc2tzIHN1
#3#Ym1pdHRlZCBhaGVhZCDigJQKICAgIHRoZSBlbmNvZGVkIGJyaWNrcyBvZiBhIHdob2xlIExPRCBu
#3#ZXZlciBxdWV1ZSB1cCBpbiBtZW1vcnkgYXQgb25jZS4iIiIKICAgIGlmIGV4ZWN1dG9yIGlzIE5v
#3#bmU6CiAgICAgICAgeWllbGQgZnJvbSBtYXAoZm4sIHRhc2tzKQogICAgICAgIHJldHVybgogICAg
#3#aXQgPSBpdGVyKHRhc2tzKQogICAgcGVuZGluZyA9IGRlcXVlKGV4ZWN1dG9yLnN1Ym1pdChmbiwg
#3#dCkgZm9yIHQgaW4gaXRlcnRvb2xzLmlzbGljZShpdCwgd2luZG93KSkKICAgIHdoaWxlIHBlbmRp
#3#bmc6CiAgICAgICAgcmVzdWx0ID0gcGVuZGluZy5wb3BsZWZ0KCkucmVzdWx0KCkKICAgICAgICBu
#3#eHQgPSBuZXh0KGl0LCBfRE9ORSkKICAgICAgICBpZiBueHQgaXMgbm90IF9ET05FOgogICAgICAg
#3#ICAgICBwZW5kaW5nLmFwcGVuZChleGVjdXRvci5zdWJtaXQoZm4sIG54dCkpCiAgICAgICAgeWll
#3#bGQgcmVzdWx0CgoKY2xhc3MgX1BhY2tXcml0ZXI6CiAgICAiIiJBcHBlbmRzIGJyaWNrcyB0byBw
#3#YWNrX05OLmJpbiBmaWxlcyBvZiBvbmUgKExPRCwgY2hhbm5lbCksIHJvbGxpbmcgb3ZlciBldmVy
#3#eQogICAgQ0hVTktTX1BFUl9QQUNLIGJyaWNrcyBhbmQgaGFzaGluZyBlYWNoIHBhY2sgYXMgaXQg
#3#aXMgd3JpdHRlbi4iIiIKCiAgICBkZWYgX19pbml0X18oc2VsZiwgY2hhbm5lbF9kaXI6IFBhdGgs
#3#IHRwX3Jvb3Q6IFBhdGgsIHBhY2tfaGFzaGVzOiBkaWN0KToKICAgICAgICBzZWxmLmRpciA9IGNo
#3#YW5uZWxfZGlyCiAgICAgICAgc2VsZi5yb290ID0gdHBfcm9vdAogICAgICAgIHNlbGYuaGFzaGVz
#3#ID0gcGFja19oYXNoZXMKICAgICAgICBzZWxmLmlkeCA9IC0xCiAgICAgICAgc2VsZi5fb3Blbl9u
#3#ZXh0KCkKCiAgICBkZWYgX29wZW5fbmV4dChzZWxmKToKICAgICAgICBzZWxmLmlkeCArPSAxCiAg
#3#ICAgICAgc2VsZi5wYXRoID0gc2VsZi5kaXIgLyBmInBhY2tfe3NlbGYuaWR4OjAyZH0uYmluIgog
#3#ICAgICAgIHNlbGYuZmggPSBvcGVuKHNlbGYucGF0aCwgIndiIikKICAgICAgICBzZWxmLnNoYSA9
#3#IGhhc2hsaWIuc2hhMjU2KCkKICAgICAgICBzZWxmLm9mZnNldCA9IDAKICAgICAgICBzZWxmLmNv
#3#dW50ID0gMAoKICAgIGRlZiBfZmluaXNoKHNlbGYpOgogICAgICAgIHNlbGYuZmguY2xvc2UoKQog
#3#ICAgICAgIHNlbGYuaGFzaGVzW3NlbGYucGF0aC5yZWxhdGl2ZV90byhzZWxmLnJvb3QpLmFzX3Bv
#3#c2l4KCldID0gc2VsZi5zaGEuaGV4ZGlnZXN0KCkKCiAgICBkZWYgYWRkKHNlbGYsIGRhdGE6IGJ5
#3#dGVzKSAtPiBkaWN0OgogICAgICAgIGlmIHNlbGYuY291bnQgPj0gQ0hVTktTX1BFUl9QQUNLOgog
#3#ICAgICAgICAgICBzZWxmLl9maW5pc2goKQogICAgICAgICAgICBzZWxmLl9vcGVuX25leHQoKQog
#3#ICAgICAgIHNlbGYuZmgud3JpdGUoZGF0YSkKICAgICAgICBzZWxmLnNoYS51cGRhdGUoZGF0YSkK
#3#ICAgICAgICBlbnRyeSA9IHsidXJsIjogc2VsZi5wYXRoLnJlbGF0aXZlX3RvKHNlbGYucm9vdCku
#3#YXNfcG9zaXgoKSwKICAgICAgICAgICAgICAgICAib2Zmc2V0IjogaW50KHNlbGYub2Zmc2V0KSwg
#3#Imxlbmd0aCI6IGludChsZW4oZGF0YSkpfQogICAgICAgIHNlbGYub2Zmc2V0ICs9IGxlbihkYXRh
#3#KQogICAgICAgIHNlbGYuY291bnQgKz0gMQogICAgICAgIHJldHVybiBlbnRyeQoKICAgIGRlZiBj
#3#bG9zZShzZWxmKToKICAgICAgICBzZWxmLl9maW5pc2goKQoKCmRlZiBwYWNrX3RpbWVwb2ludCh0
#3#ZW1wX2RpcjogUGF0aCwgYnJpY2tzX2RpcjogUGF0aCwgdF9pZHg6IGludCwgbG9kX2xldmVscywg
#3#bl9jaDogaW50LAogICAgICAgICAgICAgICAgICAgZXhlY3V0b3IsIHRwX3N1YmRpcjogc3RyLCBl
#3#bmNvZGVfZm49Tm9uZSwgbGF5ZXJfZm49Tm9uZSk6CiAgICAiIiJCcmljaywgY29tcHJlc3MgYW5k
#3#IHBhY2sgZXZlcnkgTE9EIG9mIGEgc2luZ2xlIHRpbWVwb2ludC4KCiAgICB0cF9zdWJkaXIgaXMg
#3#JycgZm9yIGEgc2luZ2xlLXRpbWVwb2ludCAoJzNkJykgZGF0YXNldCDigJQgdGhlIHBhY2tzIHRo
#3#ZW4gbGFuZAogICAgZGlyZWN0bHkgdW5kZXIgYnJpY2tzLyBhbmQgdGhlIG91dHB1dCBpcyBieXRl
#3#LWlkZW50aWNhbCB0byB0aGUgcHJlLTREIHBpcGVsaW5lLgogICAgRm9yIGEgdGltZWxhcHNlIGl0
#3#IGlzICd0MDAwJywgJ3QwMDEnLCDigKYgYW5kIGVhY2ggdGltZXBvaW50IG93bnMgYSBzZWxmLWNv
#3#bnRhaW5lZAogICAgcGFjayB0cmVlIHdob3NlIGJyaWNrVG9QYWNrIHVybHMgc3RheSByZWxhdGl2
#3#ZSB0byB0aGF0IHN1Yi1kaXJlY3RvcnksIHdoaWNoIGlzCiAgICBleGFjdGx5IHdoYXQgdGhlIHZp
#3#ZXdlciBhcHBlbmRzIHRvIHRoZSBicmlja3MgYmFzZSBwYXRoLgoKICAgIGVuY29kZV9mbiAvIGxh
#3#eWVyX2ZuIGFyZSB0aGlzIG1vZHVsZSdzIGVuY29kZV9icmlja19iYXRjaCAvIGxheWVyX21heF9n
#3#cmlkLCBvcgogICAgd3JhcHBlcnMgYSBjYWxsZXIncyBwb29sIGNhbiBpbXBvcnQgYnkgbmFtZS4K
#3#ICAgICIiIgogICAgZW5jb2RlX2ZuID0gZW5jb2RlX2ZuIG9yIGVuY29kZV9icmlja19iYXRjaAog
#3#ICAgbGF5ZXJfZm4gPSBsYXllcl9mbiBvciBsYXllcl9tYXhfZ3JpZAogICAgd2luZG93ID0gMiAq
#3#IChnZXRhdHRyKGV4ZWN1dG9yLCAiX21heF93b3JrZXJzIiwgMSkgb3IgMSkKCiAgICB0cF9yb290
#3#ID0gYnJpY2tzX2RpciAvIHRwX3N1YmRpciBpZiB0cF9zdWJkaXIgZWxzZSBicmlja3NfZGlyCiAg
#3#ICB0cF9yb290Lm1rZGlyKHBhcmVudHM9VHJ1ZSwgZXhpc3Rfb2s9VHJ1ZSkKCiAgICBicmlja190
#3#b19wYWNrID0ge30KICAgIHBhY2tfaGFzaGVzID0ge30KICAgIGxldmVsc19tYW5pZmVzdCA9IFtd
#3#CgogICAgZnJvbSB0cWRtIGltcG9ydCB0cWRtCiAgICBmb3IgbGkgaW4gbG9kX2xldmVsczoKICAg
#3#ICAgICBsb2RfbnVtID0gbGlbImxvZCJdCiAgICAgICAgVywgSCwgRCA9IGxpWyJ3aWR0aCJdLCBs
#3#aVsiaGVpZ2h0Il0sIGxpWyJkZXB0aCJdCiAgICAgICAgc2hhcGUgPSAoRCwgSCwgVykKCiAgICAg
#3#ICAgbnggPSBtYXRoLmNlaWwoVyAvIEJSSUNLX1NJWkUpCiAgICAgICAgbnkgPSBtYXRoLmNlaWwo
#3#SCAvIEJSSUNLX1NJWkUpCiAgICAgICAgbnogPSBtYXRoLmNlaWwoRCAvIEJSSUNLX1NJWkUpCgog
#3#ICAgICAgICMgQnVpbGQgbG9naWNhbCBncmlkIG9mIGNodW5rcyBmb3IgdGhpcyBsZXZlbAogICAg
#3#ICAgIGNodW5rc19ncmlkID0gW10KICAgICAgICBmb3IgYnogaW4gcmFuZ2UobnopOgogICAgICAg
#3#ICAgICBmb3IgYnkgaW4gcmFuZ2UobnkpOgogICAgICAgICAgICAgICAgZm9yIGJ4IGluIHJhbmdl
#3#KG54KToKICAgICAgICAgICAgICAgICAgICBveCwgb3ksIG96ID0gYnggKiBCUklDS19TSVpFLCBi
#3#eSAqIEJSSUNLX1NJWkUsIGJ6ICogQlJJQ0tfU0laRQogICAgICAgICAgICAgICAgICAgIGV3ID0g
#3#bWluKEJSSUNLX1NJWkUsIFcgLSBveCkKICAgICAgICAgICAgICAgICAgICBlaCA9IG1pbihCUklD
#3#S19TSVpFLCBIIC0gb3kpCiAgICAgICAgICAgICAgICAgICAgZWQgPSBtaW4oQlJJQ0tfU0laRSwg
#3#RCAtIG96KQogICAgICAgICAgICAgICAgICAgIGNodW5rc19ncmlkLmFwcGVuZCh7CiAgICAgICAg
#3#ICAgICAgICAgICAgICAgICJieCI6IGJ4LAogICAgICAgICAgICAgICAgICAgICAgICAiYnkiOiBi
#3#eSwKICAgICAgICAgICAgICAgICAgICAgICAgImJ6IjogYnosCiAgICAgICAgICAgICAgICAgICAg
#3#ICAgICJtaW4iOiBbaW50KG94KSwgaW50KG95KSwgaW50KG96KV0sCiAgICAgICAgICAgICAgICAg
#3#ICAgICAgICJtYXgiOiBbaW50KG94ICsgZXcpLCBpbnQob3kgKyBlaCksIGludChveiArIGVkKV0s
#3#CiAgICAgICAgICAgICAgICAgICAgICAgICJ2YWxpZFZveGVsQ291bnQiOiBpbnQoZXcgKiBlaCAq
#3#IGVkKQogICAgICAgICAgICAgICAgICAgIH0pCgogICAgICAgIGJpbl9maWxlcyA9IHtjOiB0ZW1w
#3#X2RpciAvIGYidHt0X2lkeDowM2R9X2N7Y31fbG9ke2xvZF9udW19LmJpbiIgZm9yIGMgaW4gcmFu
#3#Z2Uobl9jaCl9CgogICAgICAgICMgT25seSBhIGJyaWNrIHdpdGggYSBkcmF3YWJsZSB2b3hlbCBp
#3#biBTT01FIGNoYW5uZWwgY2FuIGJlIGtlcHQgaW4gYW55IGNoYW5uZWwKICAgICAgICAjIChydWxl
#3#IChhKSBhYm92ZSksIHNvIG9ubHkgdGhvc2UgYXJlIHJlYWQsIGVuY29kZWQgYW5kIGxpc3RlZC4g
#3#RW1wdHktc3BhY2UKICAgICAgICAjIHNraXBwaW5nIGlzIGRlY2lkZWQgcGVyIHRpbWVwb2ludDog
#3#Y2VsbHMgbW92ZSwgc28gdGhlIG9jY3VwaWVkIGJyaWNrIHNldAogICAgICAgICMgbGVnaXRpbWF0
#3#ZWx5IGRpZmZlcnMgZnJvbSBvbmUgZnJhbWUgdG8gdGhlIG5leHQuCiAgICAgICAgZHJhd2FibGUg
#3#PSBucC56ZXJvcygobnosIG55LCBueCksIGR0eXBlPWJvb2wpCiAgICAgICAgbGF5ZXJfdGFza3Mg
#3#PSBbKHN0cihwKSwgc2hhcGUsIGJ6KSBmb3IgYywgcCBpbiBiaW5fZmlsZXMuaXRlbXMoKSBpZiBw
#3#LmV4aXN0cygpCiAgICAgICAgICAgICAgICAgICAgICAgZm9yIGJ6IGluIHJhbmdlKG56KV0KICAg
#3#ICAgICBmb3IgKF8sIF8sIGJ6KSwgZ3JpZCBpbiB6aXAobGF5ZXJfdGFza3MsIG9yZGVyZWRfcmVz
#3#dWx0cyhleGVjdXRvciwgbGF5ZXJfZm4sCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg
#3#ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGF5ZXJfdGFza3MsIHdpbmRvdykpOgog
#3#ICAgICAgICAgICBkcmF3YWJsZVtiel0gfD0gZ3JpZCA+IERJU1BMQVlfRkxPT1IKCiAgICAgICAg
#3#YWN0aXZlX2NodW5rc19ncmlkID0gW2NoIGZvciBjaCBpbiBjaHVua3NfZ3JpZCBpZiBkcmF3YWJs
#3#ZVtjaFsiYnoiXSwgY2hbImJ5Il0sIGNoWyJieCJdXV0KICAgICAgICBwcmludChmIltQQUNLRVJd
#3#IHt0cF9zdWJkaXIgb3IgJ3QwMDAnfSBMT0Qge2xvZF9udW19OiBHcmlkIHtueH14e255fXh7bnp9
#3#ICIKICAgICAgICAgICAgICBmIih7bGVuKGNodW5rc19ncmlkKX0gY2h1bmtzLCB7bGVuKGFjdGl2
#3#ZV9jaHVua3NfZ3JpZCl9IHdpdGggZHJhd2FibGUgdm94ZWxzKSIpCgogICAgICAgICMgV2Ugd2ls
#3#bCB0cmFjayBvY2N1cGFuY3kgdW5pb24gYWNyb3NzIGFsbCBjaGFubmVscyBmb3IgdGhlIGFjdGl2
#3#ZSBjaHVuayBncmlkCiAgICAgICAgb2NjdXBhbmN5X3VuaW9uID0gWzAuMF0gKiBsZW4oYWN0aXZl
#3#X2NodW5rc19ncmlkKQogICAgICAgIGRyb3BwZWRfYnJpY2tzID0gZHJvcHBlZF92b3hlbHMgPSAw
#3#CgogICAgICAgIGl0ZW1zID0gWyhpLCAoY2hbIm1pbiJdWzJdLCBjaFsibWF4Il1bMl0sIGNoWyJt
#3#aW4iXVsxXSwgY2hbIm1heCJdWzFdLAogICAgICAgICAgICAgICAgICAgICAgY2hbIm1pbiJdWzBd
#3#LCBjaFsibWF4Il1bMF0pLCBjaFsidmFsaWRWb3hlbENvdW50Il0pCiAgICAgICAgICAgICAgICAg
#3#Zm9yIGksIGNoIGluIGVudW1lcmF0ZShhY3RpdmVfY2h1bmtzX2dyaWQpXQoKICAgICAgICBmb3Ig
#3#Y19pZHggaW4gcmFuZ2Uobl9jaCk6CiAgICAgICAgICAgIGJpbl9maWxlID0gYmluX2ZpbGVzW2Nf
#3#aWR4XQogICAgICAgICAgICBpZiBub3QgYmluX2ZpbGUuZXhpc3RzKCk6CiAgICAgICAgICAgICAg
#3#ICBwcmludChmIltXQVJOSU5HXSBQcm9jZXNzZWQgZmlsZSBub3QgZm91bmQ6IHtiaW5fZmlsZX0i
#3#KQogICAgICAgICAgICAgICAgY29udGludWUKCiAgICAgICAgICAgIGNoYW5uZWxfbG9kX2RpciA9
#3#IHRwX3Jvb3QgLyBmImxvZHtsb2RfbnVtfSIgLyBmImN7Y19pZHh9IgogICAgICAgICAgICBjaGFu
#3#bmVsX2xvZF9kaXIubWtkaXIocGFyZW50cz1UcnVlLCBleGlzdF9vaz1UcnVlKQogICAgICAgICAg
#3#ICB3cml0ZXIgPSBfUGFja1dyaXRlcihjaGFubmVsX2xvZF9kaXIsIHRwX3Jvb3QsIHBhY2tfaGFz
#3#aGVzKQoKICAgICAgICAgICAgdGFza3MgPSBbKHN0cihiaW5fZmlsZSksIHNoYXBlLCBpdGVtc1tr
#3#OmsgKyBCUklDS1NfUEVSX1RBU0tdKQogICAgICAgICAgICAgICAgICAgICBmb3IgayBpbiByYW5n
#3#ZSgwLCBsZW4oaXRlbXMpLCBCUklDS1NfUEVSX1RBU0spXQogICAgICAgICAgICB0cnk6CiAgICAg
#3#ICAgICAgICAgICBmb3IgYmF0Y2ggaW4gdHFkbShvcmRlcmVkX3Jlc3VsdHMoZXhlY3V0b3IsIGVu
#3#Y29kZV9mbiwgdGFza3MsIHdpbmRvdyksCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg
#3#ICB0b3RhbD1sZW4odGFza3MpLCBkZXNjPSJDb21wcmVzc2luZyBXZWJQIiwgbGVhdmU9RmFsc2Us
#3#CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc2NpaT1UcnVlLCBtaW5pbnRlcnZh
#3#bD0yLjApOgogICAgICAgICAgICAgICAgICAgIGZvciBpZHgsIG9jYywgaXNfbm9uX2VtcHR5LCBj
#3#b21wcmVzc2VkX2J5dGVzLCBkcm9wcGVkIGluIGJhdGNoOgogICAgICAgICAgICAgICAgICAgICAg
#3#ICBvY2N1cGFuY3lfdW5pb25baWR4XSA9IG1heChvY2N1cGFuY3lfdW5pb25baWR4XSwgb2NjKQog
#3#ICAgICAgICAgICAgICAgICAgICAgICBpZiBpc19ub25fZW1wdHk6CiAgICAgICAgICAgICAgICAg
#3#ICAgICAgICAgICBjaCA9IGFjdGl2ZV9jaHVua3NfZ3JpZFtpZHhdCiAgICAgICAgICAgICAgICAg
#3#ICAgICAgICAgICBieCwgYnksIGJ6ID0gY2hbImJ4Il0sIGNoWyJieSJdLCBjaFsiYnoiXQogICAg
#3#ICAgICAgICAgICAgICAgICAgICAgICAgYnJpY2tfcmVsX2tleSA9IGYibG9ke2xvZF9udW19L2N7
#3#Y19pZHh9L3h7Yng6MDNkfV95e2J5OjAzZH1fentiejowM2R9LndlYnAiCiAgICAgICAgICAgICAg
#3#ICAgICAgICAgICAgICBicmlja190b19wYWNrW2JyaWNrX3JlbF9rZXldID0gd3JpdGVyLmFkZChj
#3#b21wcmVzc2VkX2J5dGVzKQogICAgICAgICAgICAgICAgICAgICAgICBlbGlmIGRyb3BwZWQ6CiAg
#3#ICAgICAgICAgICAgICAgICAgICAgICAgICBkcm9wcGVkX2JyaWNrcyArPSAxCiAgICAgICAgICAg
#3#ICAgICAgICAgICAgICAgICBkcm9wcGVkX3ZveGVscyArPSBkcm9wcGVkCiAgICAgICAgICAgIGZp
#3#bmFsbHk6CiAgICAgICAgICAgICAgICB3cml0ZXIuY2xvc2UoKQoKICAgICAgICBpZiBkcm9wcGVk
#3#X2JyaWNrczoKICAgICAgICAgICAgcHJpbnQoZiJbUEFDS0VSXSAgIHRvbGVyYW5jZSBFU1MgKHtF
#3#U1NfTUlOX09DQ1VQQU5DWTpnfSkgOiB7ZHJvcHBlZF9icmlja3N9IGJyaWNrKHMpICIKICAgICAg
#3#ICAgICAgICAgICAgZiJlY2FydGVlKHMpIG1hbGdyZSB7ZHJvcHBlZF92b3hlbHN9IHZveGVsKHMp
#3#IGFmZmljaGFibGUocykgKHRvdXRlcyB2b2llcykiKQoKICAgICAgICAjIEJ1aWxkIGxldmVsIGNo
#3#dW5rcyBsaXN0IGZvciBtYW5pZmVzdAogICAgICAgIG1hbmlmZXN0X2NodW5rcyA9IFtdCiAgICAg
#3#ICAgbm9uX2VtcHR5X2NvdW50ID0gMAogICAgICAgIGZvciBpLCBjaCBpbiBlbnVtZXJhdGUoYWN0
#3#aXZlX2NodW5rc19ncmlkKToKICAgICAgICAgICAgaXNfbm9uX2VtcHR5ID0gb2NjdXBhbmN5X3Vu
#3#aW9uW2ldID4gRVNTX01JTl9PQ0NVUEFOQ1kKICAgICAgICAgICAgaWYgaXNfbm9uX2VtcHR5Ogog
#3#ICAgICAgICAgICAgICAgbm9uX2VtcHR5X2NvdW50ICs9IDEKICAgICAgICAgICAgbWFuaWZlc3Rf
#3#Y2h1bmtzLmFwcGVuZCh7CiAgICAgICAgICAgICAgICAiaWQiOiBmIntjaFsnYnonXX1fe2NoWydi
#3#eSddfV97Y2hbJ2J4J119IiwKICAgICAgICAgICAgICAgICJtaW4iOiBjaFsibWluIl0sCiAgICAg
#3#ICAgICAgICAgICAibWF4IjogY2hbIm1heCJdLAogICAgICAgICAgICAgICAgIm9jY3VwaWVkUmF0
#3#aW8iOiByb3VuZChvY2N1cGFuY3lfdW5pb25baV0sIDYpLAogICAgICAgICAgICAgICAgIm5vbkVt
#3#cHR5IjogaXNfbm9uX2VtcHR5CiAgICAgICAgICAgIH0pCgogICAgICAgIGxldmVsc19tYW5pZmVz
#3#dC5hcHBlbmQoewogICAgICAgICAgICAibGV2ZWwiOiBsb2RfbnVtLAogICAgICAgICAgICAic2Nh
#3#bGUiOiAxLjAgLyAoMiAqKiBsb2RfbnVtKSwKICAgICAgICAgICAgImRpbWVuc2lvbnMiOiB7Ingi
#3#OiBXLCAieSI6IEgsICJ6IjogRH0sCiAgICAgICAgICAgICJicmlja1NpemUiOiBCUklDS19TSVpF
#3#LAogICAgICAgICAgICAiZ3JpZFNpemUiOiB7IngiOiBueCwgInkiOiBueSwgInoiOiBuen0sCiAg
#3#ICAgICAgICAgICJicmlja0NvdW50IjogbGVuKGNodW5rc19ncmlkKSwKICAgICAgICAgICAgImNo
#3#dW5rcyI6IG1hbmlmZXN0X2NodW5rcywKICAgICAgICAgICAgIm5vbkVtcHR5Q291bnQiOiBub25f
#3#ZW1wdHlfY291bnQKICAgICAgICB9KQoKICAgIHRyYW5zcG9ydCA9IHsKICAgICAgICAibW9kZSI6
#3#ICJwYWNrcyIsCiAgICAgICAgImVuY29kaW5nIjogIndlYnAtbG9zc2xlc3MiLAogICAgICAgICJw
#3#YWNrU2l6ZSI6IENIVU5LU19QRVJfUEFDSywKICAgICAgICAiYnJpY2tUb1BhY2siOiBicmlja190
#3#b19wYWNrLAogICAgICAgICJwYWNrSGFzaGVzIjogcGFja19oYXNoZXMKICAgIH0KICAgIHJldHVy
#3#biBsZXZlbHNfbWFuaWZlc3QsIHRyYW5zcG9ydAoKCmRlZiBoaXN0b2dyYW1zX2Zvcl90aW1lcG9p
#3#bnQodGVtcF9kaXI6IFBhdGgsIHRfaWR4OiBpbnQsIG5fY2g6IGludCwgbG9kX251bTogaW50KToK
#3#ICAgICIiIlBlci1jaGFubmVsIDY0LWJpbiBoaXN0b2dyYW0gb2Ygb25lIHRpbWVwb2ludCwgb24g
#3#aXRzIGNvYXJzZXN0IExPRC4iIiIKICAgIG91dCA9IFtdCiAgICBmb3IgY19pZHggaW4gcmFuZ2Uo
#3#bl9jaCk6CiAgICAgICAgYmluX2ZpbGUgPSB0ZW1wX2RpciAvIGYidHt0X2lkeDowM2R9X2N7Y19p
#3#ZHh9X2xvZHtsb2RfbnVtfS5iaW4iCiAgICAgICAgaWYgYmluX2ZpbGUuZXhpc3RzKCk6CiAgICAg
#3#ICAgICAgIHZvbF9kYXRhID0gbnAuZnJvbWZpbGUoc3RyKGJpbl9maWxlKSwgZHR5cGU9bnAudWlu
#3#dDgpCiAgICAgICAgICAgIGNvdW50cywgZWRnZXMgPSBucC5oaXN0b2dyYW0odm9sX2RhdGEsIGJp
#3#bnM9NjQsIHJhbmdlPSgwLCAyNTUpKQoKICAgICAgICAgICAgbWVhbl92YWwgPSBmbG9hdCh2b2xf
#3#ZGF0YS5tZWFuKCkpIGlmIHZvbF9kYXRhLnNpemUgZWxzZSAwLjAKICAgICAgICAgICAgc3RkX3Zh
#3#bCA9IGZsb2F0KHZvbF9kYXRhLnN0ZCgpKSBpZiB2b2xfZGF0YS5zaXplIGVsc2UgMC4wCiAgICAg
#3#ICAgICAgIG1heF92YWwgPSBpbnQodm9sX2RhdGEubWF4KCkpIGlmIHZvbF9kYXRhLnNpemUgZWxz
#3#ZSAwCgogICAgICAgICAgICBvdXQuYXBwZW5kKHsKICAgICAgICAgICAgICAgICJjb3VudHMiOiBj
#3#b3VudHMuYXN0eXBlKG5wLmludDY0KS50b2xpc3QoKSwKICAgICAgICAgICAgICAgICJlZGdlcyI6
#3#IGVkZ2VzLmFzdHlwZShucC5mbG9hdDY0KS50b2xpc3QoKSwKICAgICAgICAgICAgICAgICJ0b3Rh
#3#bCI6IGludCh2b2xfZGF0YS5zaXplKSwKICAgICAgICAgICAgICAgICJtYXgiOiBtYXhfdmFsLAog
#3#ICAgICAgICAgICAgICAgIm1lYW4iOiBtZWFuX3ZhbCwKICAgICAgICAgICAgICAgICJzdGQiOiBz
#3#dGRfdmFsLAogICAgICAgICAgICAgICAgImJhY2tncm91bmRGbG9vciI6IDAKICAgICAgICAgICAg
#3#fSkKICAgICAgICAgICAgZGVsIHZvbF9kYXRhCiAgICAgICAgZWxzZToKICAgICAgICAgICAgcHJp
#3#bnQoZiJbV0FSTklOR10gQmluIGZpbGUgZm9yIGhpc3RvZ3JhbSBub3QgZm91bmQ6IHtiaW5fZmls
#3#ZX0iKQogICAgICAgICAgICBvdXQuYXBwZW5kKHsKICAgICAgICAgICAgICAgICJjb3VudHMiOiBb
#3#MF0gKiA2NCwKICAgICAgICAgICAgICAgICJlZGdlcyI6IGxpc3QocmFuZ2UoNjUpKSwKICAgICAg
#3#ICAgICAgICAgICJ0b3RhbCI6IDAsCiAgICAgICAgICAgICAgICAibWF4IjogMCwKICAgICAgICAg
#3#ICAgICAgICJtZWFuIjogMC4wLAogICAgICAgICAgICAgICAgInN0ZCI6IDAuMCwKICAgICAgICAg
#3#ICAgICAgICJiYWNrZ3JvdW5kRmxvb3IiOiAwCiAgICAgICAgICAgIH0pCiAgICByZXR1cm4gb3V0
#3#CgoKZGVmIGJ1aWxkX3BhY2tzKHRlbXBfZGlyOiBQYXRoLCBvdXRwdXRfZGlyOiBQYXRoKToKICAg
#3#IHByb2NfbWV0YSA9IHJlYWRfanNvbl9maWxlKHRlbXBfZGlyIC8gInByb2Nlc3NpbmdfbWV0YS5q
#3#c29uIikKICAgIGlmIG5vdCBwcm9jX21ldGE6CiAgICAgICAgcmFpc2UgRmlsZU5vdEZvdW5kRXJy
#3#b3IoZiJ7dGVtcF9kaXIgLyAncHJvY2Vzc2luZ19tZXRhLmpzb24nfSBhYnNlbnQgb3UgaWxsaXNp
#3#YmxlIikKCiAgICBsb2RfbGV2ZWxzID0gcHJvY19tZXRhWyJsb2RfbGV2ZWxzIl0KICAgIG5fY2gg
#3#PSBwcm9jX21ldGFbIm5fY2hhbm5lbHMiXQogICAgbl90cCA9IHByb2NfbWV0YVsibl90aW1lcG9p
#3#bnRzIl0KICAgIHZveGVsX3NpemUgPSBwcm9jX21ldGFbInZveGVsX3NpemUiXQoKICAgIGJyaWNr
#3#c19kaXIgPSBvdXRwdXRfZGlyIC8gImJyaWNrcyIKICAgIGJyaWNrc19kaXIubWtkaXIocGFyZW50
#3#cz1UcnVlLCBleGlzdF9vaz1UcnVlKQoKICAgIGlzX3RpbWVsYXBzZSA9IG5fdHAgPiAxCiAgICBj
#3#b2Fyc2VzdCA9IGxvZF9sZXZlbHNbLTFdWyJsb2QiXQoKICAgICMgQSB0aW1lcG9pbnQgc3RlcCAy
#3#IGFscmVhZHkgcGFja2VkICgtLXBhY2staW50bykgaXMgb25seSBpbmRleGVkIGhlcmU7IGFueXRo
#3#aW5nCiAgICAjIGVsc2UgaXMgcGFja2VkIG5vdywgdGhyb3VnaCBvbmUgcHJvY2VzcyBwb29sIGZv
#3#ciB0aGUgd2hvbGUgcnVuLgogICAgZXhlY3V0b3IgPSBOb25lCiAgICBwZXJfdHAgPSBbXQogICAg
#3#dHJ5OgogICAgICAgIGZvciB0X2lkeCBpbiByYW5nZShuX3RwKToKICAgICAgICAgICAga2V5ID0g
#3#ZiJ0e3RfaWR4OjAzZH0iCiAgICAgICAgICAgIHBhY2tlZCA9IHJlYWRfanNvbl9maWxlKHRlbXBf
#3#ZGlyIC8gZiJwYWNrX3trZXl9Lmpzb24iKQogICAgICAgICAgICBpZiBwYWNrZWQ6CiAgICAgICAg
#3#ICAgICAgICBsZXZlbHMsIHRyYW5zcG9ydCA9IHBhY2tlZFsibGV2ZWxzIl0sIHBhY2tlZFsiYnJp
#3#Y2tUcmFuc3BvcnQiXQogICAgICAgICAgICBlbHNlOgogICAgICAgICAgICAgICAgaWYgZXhlY3V0
#3#b3IgaXMgTm9uZToKICAgICAgICAgICAgICAgICAgICBleGVjdXRvciA9IFByb2Nlc3NQb29sRXhl
#3#Y3V0b3IobWF4X3dvcmtlcnM9d29ya2VyX2NvdW50KCkpCiAgICAgICAgICAgICAgICBpZiBpc190
#3#aW1lbGFwc2U6CiAgICAgICAgICAgICAgICAgICAgcHJpbnQoZiJbUEFDS0VSXSA9PT0gdGltZXBv
#3#aW50IHt0X2lkeCArIDF9L3tuX3RwfSAoe2tleX0pID09PSIpCiAgICAgICAgICAgICAgICBsZXZl
#3#bHMsIHRyYW5zcG9ydCA9IHBhY2tfdGltZXBvaW50KHRlbXBfZGlyLCBicmlja3NfZGlyLCB0X2lk
#3#eCwgbG9kX2xldmVscywKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg
#3#ICAgICAgICAgbl9jaCwgZXhlY3V0b3IsIGtleSBpZiBpc190aW1lbGFwc2UgZWxzZSAiIikKICAg
#3#ICAgICAgICAgcGVyX3RwLmFwcGVuZCgoa2V5LCBsZXZlbHMsIHRyYW5zcG9ydCwKICAgICAgICAg
#3#ICAgICAgICAgICAgICAgICAgaGlzdG9ncmFtc19mb3JfdGltZXBvaW50KHRlbXBfZGlyLCB0X2lk
#3#eCwgbl9jaCwgY29hcnNlc3QpKSkKICAgIGZpbmFsbHk6CiAgICAgICAgaWYgZXhlY3V0b3IgaXMg
#3#bm90IE5vbmU6CiAgICAgICAgICAgIGV4ZWN1dG9yLnNodXRkb3duKCkKCiAgICBpZiBub3QgaXNf
#3#dGltZWxhcHNlOgogICAgICAgIF8sIGxldmVsc19tYW5pZmVzdCwgdHJhbnNwb3J0LCBoaXN0b2dy
#3#YW1zID0gcGVyX3RwWzBdCiAgICAgICAgdGltZXBvaW50c19tYW5pZmVzdCA9IE5vbmUKICAgIGVs
#3#c2U6CiAgICAgICAgdGltZXBvaW50c19tYW5pZmVzdCA9IHt9CiAgICAgICAgZm9yIGtleSwgbGV2
#3#ZWxzLCB0cF90cmFuc3BvcnQsIGhpc3QgaW4gcGVyX3RwOgogICAgICAgICAgICAjIEEgdGltZWxh
#3#cHNlIGNhcnJpZXMgb25lIGhpc3RvZ3JhbSBzZXQgcGVyIGZyYW1lOiB0aGUgY2hhbm5lbCBwYW5l
#3#bCByZWFkcwogICAgICAgICAgICAjIHRoZSByb3cgb2YgdGhlIHRpbWVwb2ludCBvbiBzY3JlZW4s
#3#IGFuZCBhIHNoYXJlZCBzZXQgd291bGQgbWlzLXNjYWxlIHRoZQogICAgICAgICAgICAjIHNsaWRl
#3#cnMgYXMgdGhlIHNwZWNpbWVuIGJsZWFjaGVzLgogICAgICAgICAgICB0aW1lcG9pbnRzX21hbmlm
#3#ZXN0W2tleV0gPSB7CiAgICAgICAgICAgICAgICAicGF0aCI6IGtleSwKICAgICAgICAgICAgICAg
#3#ICJjaGFubmVscyI6IG5fY2gsCiAgICAgICAgICAgICAgICAibGV2ZWxzIjogbGV2ZWxzLAogICAg
#3#ICAgICAgICAgICAgImJyaWNrVHJhbnNwb3J0IjogdHBfdHJhbnNwb3J0LAogICAgICAgICAgICAg
#3#ICAgImhpc3RvZ3JhbXMiOiBoaXN0CiAgICAgICAgICAgIH0KICAgICAgICAjIE1pcnJvcmVkIGF0
#3#IHRoZSB0b3AgbGV2ZWwgc28gYSBjb25zdW1lciB0aGF0IGlnbm9yZXMgYHRpbWVwb2ludHNgIHN0
#3#aWxsCiAgICAgICAgIyBtb3VudHMgYSBjb2hlcmVudCAoZmlyc3QtZnJhbWUpIGRhdGFzZXQgaW5z
#3#dGVhZCBvZiBmYWlsaW5nLgogICAgICAgIF8sIGxldmVsc19tYW5pZmVzdCwgdHJhbnNwb3J0LCBo
#3#aXN0b2dyYW1zID0gcGVyX3RwWzBdCgogICAgbWFuaWZlc3QgPSB7CiAgICAgICAgInZlcnNpb24i
#3#OiAyLAogICAgICAgICJzY2hlbWEiOiAiaXJpYmhtLWJyaWNrcy12MiIsCiAgICAgICAgImRhdGFz
#3#ZXQiOiBvdXRwdXRfZGlyLm5hbWUsCiAgICAgICAgImRhdGFzZXRUeXBlIjogImxpdmUiIGlmIGlz
#3#X3RpbWVsYXBzZSBlbHNlICIzZCIsCiAgICAgICAgImNoYW5uZWxzIjogbl9jaCwKICAgICAgICAi
#3#YnJpY2tTaXplIjogQlJJQ0tfU0laRSwKICAgICAgICAiYnJpY2tQYWNraW5nIjogeyJtb2RlIjog
#3#ImdyaWQiLCAiY29scyI6IDgsICJyb3dzIjogOH0sCiAgICAgICAgInZveGVsU2l6ZSI6IHZveGVs
#3#X3NpemUsCiAgICAgICAgImNyZWF0ZWRBdCI6IF9faW1wb3J0X18oImRhdGV0aW1lIikuZGF0ZXRp
#3#bWUubm93KCkuaXNvZm9ybWF0KCksCiAgICAgICAgImxldmVscyI6IGxldmVsc19tYW5pZmVzdCwK
#3#ICAgICAgICAiaGlzdG9ncmFtcyI6IGhpc3RvZ3JhbXMsCiAgICAgICAgImhhc2hlcyI6IHt9LCAg
#3#ICAgIyBMZWZ0IGVtcHR5IGFzIHdlIHVzZSBwYWNrIHRyYW5zcG9ydAogICAgICAgICJ0aW1lcG9p
#3#bnRzIjogdGltZXBvaW50c19tYW5pZmVzdCwKICAgICAgICAiYnJpY2tUcmFuc3BvcnQiOiB0cmFu
#3#c3BvcnQKICAgIH0KCiAgICAjIENvbXBhY3Q6IHRoZSBicm93c2VyIGRvd25sb2FkcyBhbmQgcGFy
#3#c2VzIHRoZSBtYW5pZmVzdCBiZWZvcmUgdGhlIGZpcnN0IGZyYW1lLAogICAgIyBhbmQgaW5kZW50
#3#YXRpb24gYWxvbmUgZG91YmxlZCBpdCAoMjMgTUIgLT4gMTEgTUIgb24gdGhlIGxhcmdlc3QgZGF0
#3#YXNldCkuCiAgICBtYW5pZmVzdF9wYXRoID0gYnJpY2tzX2RpciAvICJtYW5pZmVzdC5qc29uIgog
#3#ICAgYXRvbWljX3dyaXRlX2pzb24obWFuaWZlc3RfcGF0aCwgbWFuaWZlc3QsIHNlcGFyYXRvcnM9
#3#KCIsIiwgIjoiKSkKCiAgICBzaXplX21iID0gbWFuaWZlc3RfcGF0aC5zdGF0KCkuc3Rfc2l6ZSAv
#3#IDFlNgogICAgcHJpbnQoZiJbUEFDS0VSXSBXcm90ZSBtYW5pZmVzdC5qc29uIHRvIHttYW5pZmVz
#3#dF9wYXRofSAoe3NpemVfbWI6LjJmfSBNQikiKQogICAgaWYgaXNfdGltZWxhcHNlOgogICAgICAg
#3#IHByaW50KGYiW1BBQ0tFUl0ge25fdHB9IHRpbWVwb2ludHMgaW5kZXhlZCIpCgoKaWYgX19uYW1l
#3#X18gPT0gIl9fbWFpbl9fIjoKICAgIGlmIGxlbihzeXMuYXJndikgPCAzOgogICAgICAgIHByaW50
#3#KCJVc2FnZTogcHl0aG9uIDMtY2h1bmtfcGFja2VyLnB5IDx0ZW1wX2Rpcj4gPG91dHB1dF9kaXI+
#3#IikKICAgICAgICBzeXMuZXhpdCgxKQoKICAgIHRlbXBfZGlyID0gUGF0aChzeXMuYXJndlsxXSkK
#3#ICAgIG91dHB1dF9kaXIgPSBQYXRoKHN5cy5hcmd2WzJdKQoKICAgIHRyeToKICAgICAgICBidWls
#3#ZF9wYWNrcyh0ZW1wX2Rpciwgb3V0cHV0X2RpcikKICAgICAgICBwcmludChmIltQQUNLRVJdIENo
#3#dW5rIHBhY2thZ2luZyBjb21wbGV0ZS4iKQogICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBlOgogICAg
#3#ICAgIGltcG9ydCB0cmFjZWJhY2sKICAgICAgICB0cmFjZWJhY2sucHJpbnRfZXhjKCkKICAgICAg
#3#ICBwcmludChmIltFUlJPUl0gQ2h1bmsgcGFja2FnaW5nIGZhaWxlZDoge2V9IiwgZmlsZT1zeXMu
#3#c3RkZXJyKQogICAgICAgIHN5cy5leGl0KDEpCg==
:: ---- [4] 4-catalog_generator.py (13527 octets) ----
#4#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwppbXBvcnQgYXJncGFyc2UKaW1wb3J0IGpzb24KaW1wb3J0
#4#IHJlCmltcG9ydCBzeXMKZnJvbSBkYXRldGltZSBpbXBvcnQgZGF0ZXRpbWUKZnJvbSBwYXRobGli
#4#IGltcG9ydCBQYXRoCgpIRVJFID0gUGF0aChfX2ZpbGVfXykucmVzb2x2ZSgpLnBhcmVudAppZiBz
#4#dHIoSEVSRSkgbm90IGluIHN5cy5wYXRoOgogICAgc3lzLnBhdGguaW5zZXJ0KDAsIHN0cihIRVJF
#4#KSkKZnJvbSBydW5fcHJlcHJvY2VzcyBpbXBvcnQgbWVyZ2VfY3VyYXRlZCwgYXRvbWljX3dyaXRl
#4#X2pzb24sIHJlYWRfanNvbl9maWxlICAjIG5vcWE6IEU0MDIKCkNPTE9SUyA9IFsiIzAwRkYwMCIs
#4#ICIjMDBBQUZGIiwgIiNGRjAwRkYiLCAiI0ZGMDAwMCIsICIjRkZGRjAwIiwgIiMwMEZGRkYiXQoK
#4#IyBFbWJyeW9uaWMtZGF5IHRva2VuIG9mIHRoZSBsYWIncyBmaWxlIG5hbWVzLCBhZnRlciBhIHNl
#4#cGFyYXRvciAob3IgYXQgdGhlIHN0YXJ0KToKIyAgIEU4LTUsIEUxMC01ICAgICAgICBkYXksIGRh
#4#c2gsIGZyYWN0aW9uIGRpZ2l0cyAgICAgIC0+IEU4LjUsIEUxMC41CiMgICBFMTAuNSwgRTgsMjUg
#4#ICAgICAgZGF5LCBkb3QvY29tbWEsIGZyYWN0aW9uIGRpZ2l0cyAtPiBFMTAuNSwgRTguMjUKIyAg
#4#IEU4NSwgRTgyNSwgRTEwNSAgICBjb21wYWN0IGRpZ2l0cyAgICAgICAgICAgICAgICAgIC0+IEU4
#4#LjUsIEU4LjI1LCBFMTAuNQojICAgRTgsIEUxMCAgICAgICAgICAgIGEgd2hvbGUgZGF5ICAgICAg
#4#ICAgICAgICAgICAgICAgLT4gRTgsIEUxMAojIE1vdXNlIGRldmVsb3BtZW50IHJ1bnMgdG8gRTE5
#4#LCBzbyBhIGNvbXBhY3QgdG9rZW4gc3RhcnRpbmcgd2l0aCAxMC0xOSBpcyBhIHR3by1kaWdpdAoj
#4#IGRheSAoRTEwNSA9IEUxMC41LCBFMTIgPSBFMTIpOyBhbnkgb3RoZXIgaXMgYSBvbmUtZGlnaXQg
#4#ZGF5IGZvbGxvd2VkIGJ5IGl0cyBmcmFjdGlvbgojIChFOTUgPSBFOS41LCBFODAgPSBFOC4wKS4g
#4#QWZ0ZXIgYSBkYXNoIG9ubHkgdGhlIGZyYWN0aW9ucyBhIHN0YWdlIGlzIGFjdHVhbGx5IHdyaXR0
#4#ZW4KIyB3aXRoICguMjUsIC41LCAuNzUpIGFyZSByZWFkIGFzIG9uZTogaW4gIkU4LTEtREFQSSIg
#4#b3IgIkU5NS0yLS4uLiIgdGhlIG51bWJlciBhZnRlciB0aGUKIyBzdGFnZSBpcyB0aGUgZW1icnlv
#4#LCBhcyB0aGUgbGFiJ3Mgb3duIGN1cmF0aW9uIG9mIHRob3NlIGRhdGFzZXRzIHJlY29yZHMgaXQu
#4#Cl9TVEFHRV9SWCA9IHJlLmNvbXBpbGUociIoPzpefFstXyBdKUUoXGR7MSwzfSkoPzooWy4sXSko
#4#XGR7MSwyfSl8LSgyNXw1fDc1KSk/KD89JHxbLV8gXSkiLAogICAgICAgICAgICAgICAgICAgICAg
#4#IHJlLklHTk9SRUNBU0UpCl9FTUJSWU9fUlggPSByZS5jb21waWxlKHIiKD86XnxbLV8gXSkoRW1c
#4#ZCspKD89JHxbLV8gXSkiLCByZS5JR05PUkVDQVNFKQpfU1RBR0VfRU1CUllPX05VTUJFUl9SWCA9
#4#IHJlLmNvbXBpbGUociIoPzpefFstXyBdKUVbXGQuLF0rLShcZHsxLDJ9KSg/PSR8Wy1fIF0pIiwg
#4#cmUuSUdOT1JFQ0FTRSkKCgpkZWYgX3NwbGl0X2NvbXBhY3QoZGlnaXRzOiBzdHIpOgogICAgaWYg
#4#bGVuKGRpZ2l0cykgPT0gMToKICAgICAgICByZXR1cm4gZGlnaXRzLCAiIgogICAgaWYgZGlnaXRz
#4#WzBdID09ICIxIiBhbmQgbGVuKGRpZ2l0cykgPj0gMjoKICAgICAgICByZXR1cm4gZGlnaXRzWzoy
#4#XSwgZGlnaXRzWzI6XQogICAgcmV0dXJuIGRpZ2l0c1swXSwgZGlnaXRzWzE6XQoKCmRlZiBfcGFy
#4#c2Vfc3RhZ2UobmFtZTogc3RyKToKICAgICIiIihkaXNwbGF5LCBudW1lcmljKSBvZiB0aGUgZW1i
#4#cnlvbmljIGRheSBlbmNvZGVkIGluIGEgZGF0YXNldCBuYW1lLCBvcgogICAgKCJVbmtub3duIiwg
#4#MC4wKSB3aGVuIHRoZSBuYW1lIGNhcnJpZXMgbm9uZS4iIiIKICAgIG0gPSBfU1RBR0VfUlguc2Vh
#4#cmNoKG5hbWUpCiAgICBpZiBub3QgbToKICAgICAgICByZXR1cm4gIlVua25vd24iLCAwLjAKICAg
#4#IGRpZ2l0cywgc2VwLCBzZXBfZnJhYywgZGFzaF9mcmFjID0gbS5ncm91cHMoKQogICAgaWYgc2Vw
#4#OgogICAgICAgIGRheSwgZnJhYyA9IGRpZ2l0cywgc2VwX2ZyYWMKICAgIGVsaWYgZGFzaF9mcmFj
#4#OgogICAgICAgIGRheSwgZnJhYyA9IGRpZ2l0cywgZGFzaF9mcmFjCiAgICBlbHNlOgogICAgICAg
#4#IGRheSwgZnJhYyA9IF9zcGxpdF9jb21wYWN0KGRpZ2l0cykKICAgIGRheSA9IHN0cihpbnQoZGF5
#4#KSkKICAgIGRpc3BsYXkgPSBmIkV7ZGF5fS57ZnJhY30iIGlmIGZyYWMgZWxzZSBmIkV7ZGF5fSIK
#4#ICAgIHJldHVybiBkaXNwbGF5LCBmbG9hdChmIntkYXl9LntmcmFjfSIpIGlmIGZyYWMgZWxzZSBm
#4#bG9hdChkYXkpCgoKZGVmIF9wYXJzZV9lbWJyeW8obmFtZTogc3RyKToKICAgICIiIkVtYnJ5byBs
#4#YWJlbDogYW4gZXhwbGljaXQgYEVtPG4+YCB0b2tlbiBhbnl3aGVyZSBpbiB0aGUgbmFtZSwgZWxz
#4#ZSB0aGUgbnVtYmVyCiAgICB0aGF0IGRpcmVjdGx5IGZvbGxvd3MgdGhlIHN0YWdlIChgRTk1LTEt
#4#Li4uYCBpcyBlbWJyeW8gMSkuIiIiCiAgICBtID0gX0VNQlJZT19SWC5zZWFyY2gobmFtZSkKICAg
#4#IGlmIG06CiAgICAgICAgcmV0dXJuIG0uZ3JvdXAoMSkKICAgIHN0YWdlID0gX1NUQUdFX1JYLnNl
#4#YXJjaChuYW1lKQogICAgaWYgc3RhZ2UgYW5kIG5vdCBzdGFnZS5ncm91cCg0KToKICAgICAgICBu
#4#ID0gX1NUQUdFX0VNQlJZT19OVU1CRVJfUlguc2VhcmNoKG5hbWUsIHN0YWdlLnN0YXJ0KCkpCiAg
#4#ICAgICAgaWYgbiBhbmQgbi5zdGFydCgpID09IHN0YWdlLnN0YXJ0KCk6CiAgICAgICAgICAgIHJl
#4#dHVybiBmIkVte2ludChuLmdyb3VwKDEpKX0iCiAgICByZXR1cm4gTm9uZQoKCmRlZiBfY2FsaWJy
#4#YXRlZCh2cykgLT4gYm9vbDoKICAgIHJldHVybiBpc2luc3RhbmNlKHZzLCBkaWN0KSBhbmQgYWxs
#4#KGlzaW5zdGFuY2UodnMuZ2V0KGEpLCAoaW50LCBmbG9hdCkpIGFuZCB2cy5nZXQoYSkgPiAwCiAg
#4#ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb3IgYSBpbiAoIngiLCAieSIs
#4#ICJ6IikpCgoKZGVmIG1lcmdlX2NoYW5uZWxzKGV4aXN0aW5nLCBmcmVzaCk6CiAgICAiIiJEaXNw
#4#bGF5IHNldHRpbmdzIHRoZSBsYWIgY2hvc2UgcGVyIGNoYW5uZWwgKGNvbG91ciwgd2luZG93LCBn
#4#YW1tYSwgbmFtZSkgc3Vydml2ZSBhCiAgICByZS1ydW4gYXMgbG9uZyBhcyB0aGUgYWNxdWlzaXRp
#4#b24gc3RpbGwgaGFzIHRoZSBzYW1lIG51bWJlciBvZiBjaGFubmVsczsgYSBjaGFuZ2VkCiAgICBj
#4#aGFubmVsIHNldCBzdGFydHMgZnJvbSB0aGUgZGVmYXVsdHMsIHNpbmNlIHRoZSBvbGQgc2V0dGlu
#4#Z3MgYmVsb25nIHRvIG90aGVyIGRhdGEuIiIiCiAgICBpZiBub3QgaXNpbnN0YW5jZShleGlzdGlu
#4#ZywgbGlzdCkgb3IgbGVuKGV4aXN0aW5nKSAhPSBsZW4oZnJlc2gpOgogICAgICAgIHJldHVybiBm
#4#cmVzaAogICAgbWVyZ2VkID0gW10KICAgIGZvciBvbGQsIG5ldyBpbiB6aXAoZXhpc3RpbmcsIGZy
#4#ZXNoKToKICAgICAgICBtZXJnZWQuYXBwZW5kKHsqKm5ldywgKipvbGR9IGlmIGlzaW5zdGFuY2Uo
#4#b2xkLCBkaWN0KSBlbHNlIG5ldykKICAgIHJldHVybiBtZXJnZWQKCgpDQUxJQlJBVElPTl9LRVlT
#4#ID0gKCJ2b3hlbF9zaXplIiwgInBoeXNpY2FsU2l6ZVVtIiwgIm9wdGljYWxfc2VjdGlvbl90aGlj
#4#a25lc3NfdW0iLAogICAgICAgICAgICAgICAgICAgICJjYWxpYnJhdGlvblN0YXR1cyIsICJjYWxp
#4#YnJhdGlvbk5vdGUiKQoKCmRlZiBtZXJnZV92b2x1bWVfbWV0YWRhdGEoZXhpc3Rpbmc6IGRpY3Qs
#4#IGZyZXNoOiBkaWN0KSAtPiBkaWN0OgogICAgIiIibWV0YWRhdGEuanNvbiBvZiBhIHJlLXByb2Nl
#4#c3NlZCB2b2x1bWU6IG1lYXN1cmVkIGZhY3RzIGZyb20gdGhpcyBydW4sIHRoZSBsYWIncwogICAg
#4#Y3VyYXRpb24gZnJvbSB0aGUgcHVibGlzaGVkIGZpbGUgKHNlZSBydW5fcHJlcHJvY2Vzcy5DVVJB
#4#VEVEX0tFWVMpLiIiIgogICAgbWVyZ2VkID0gbWVyZ2VfY3VyYXRlZChleGlzdGluZywgZnJlc2gp
#4#CiAgICBpZiBub3QgZXhpc3Rpbmc6CiAgICAgICAgcmV0dXJuIG1lcmdlZAogICAgbWVyZ2VkWyJj
#4#aGFubmVscyJdID0gbWVyZ2VfY2hhbm5lbHMoZXhpc3RpbmcuZ2V0KCJjaGFubmVscyIpLCBmcmVz
#4#aC5nZXQoImNoYW5uZWxzIikgb3IgW10pCiAgICAjIEEgZmlsZSB3aXRob3V0IGNhbGlicmF0aW9u
#4#IGNhbm5vdCBtZWFzdXJlIGl0OiBhIGNhbGlicmF0aW9uIHRoZSBvcGVyYXRvciBlbnRlcmVkIGJ5
#4#CiAgICAjIGhhbmQgaXMga2VwdCByYXRoZXIgdGhhbiByZXBsYWNlZCBieSAibWlzc2luZyIuIFRo
#4#ZSAxL04gdW0gInZveGVsIiBlYXJsaWVyIHZlcnNpb25zCiAgICAjIGRlcml2ZWQgZnJvbSBhIG1p
#4#c3NpbmcgZXh0ZW50IChhbmQgbGFiZWxsZWQgZXhhY3QpIGlzIG5vdCBvbmUuCiAgICB2cyA9IGV4
#4#aXN0aW5nLmdldCgidm94ZWxfc2l6ZSIpCiAgICBkaW1zID0gZnJlc2guZ2V0KCJkaW1lbnNpb25z
#4#Iikgb3Ige30KICAgIHBsYWNlaG9sZGVyID0gX2NhbGlicmF0ZWQodnMpIGFuZCBhbGwoCiAgICAg
#4#ICAgZGltcy5nZXQoYSkgYW5kIGFicyh2c1thXSAtIHJvdW5kKDEuMCAvIGRpbXNbYV0sIDYpKSA8
#4#IDFlLTEyIGZvciBhIGluICgieCIsICJ5IiwgInoiKSkKICAgIGlmIChmcmVzaC5nZXQoImNhbGli
#4#cmF0aW9uU3RhdHVzIikgPT0gIm1ldGFkYXRhLW1pc3NpbmciIGFuZCBfY2FsaWJyYXRlZCh2cykK
#4#ICAgICAgICAgICAgYW5kIG5vdCBwbGFjZWhvbGRlcik6CiAgICAgICAgZm9yIGtleSBpbiBDQUxJ
#4#QlJBVElPTl9LRVlTOgogICAgICAgICAgICBpZiBrZXkgaW4gZXhpc3Rpbmc6CiAgICAgICAgICAg
#4#ICAgICBtZXJnZWRba2V5XSA9IGV4aXN0aW5nW2tleV0KICAgIHJldHVybiBtZXJnZWQKCgpkZWYg
#4#Z2VuZXJhdGVfY2F0YWxvZ19tZXRhZGF0YSh0ZW1wX2RpcjogUGF0aCwgb3V0cHV0X2RpcjogUGF0
#4#aCwgZXhpc3RpbmdfcGF0aDogUGF0aCA9IE5vbmUsCiAgICAgICAgICAgICAgICAgICAgICAgICAg
#4#ICAgIGRpc3BsYXlfbmFtZTogc3RyID0gTm9uZSk6CiAgICB3aXRoIG9wZW4odGVtcF9kaXIgLyAi
#4#cHJvY2Vzc2luZ19tZXRhLmpzb24iLCAiciIsIGVuY29kaW5nPSJ1dGYtOCIpIGFzIGZtOgogICAg
#4#ICAgIHByb2NfbWV0YSA9IGpzb24ubG9hZChmbSkKCiAgICBsb2RfbGV2ZWxzID0gcHJvY19tZXRh
#4#WyJsb2RfbGV2ZWxzIl0KICAgIG5fY2ggPSBwcm9jX21ldGFbIm5fY2hhbm5lbHMiXQogICAgbl90
#4#cCA9IHByb2NfbWV0YVsibl90aW1lcG9pbnRzIl0KICAgIHZveGVsX3NpemUgPSBwcm9jX21ldGFb
#4#InZveGVsX3NpemUiXQogICAgY2hhbm5lbF9uYW1lcyA9IHByb2NfbWV0YVsiY2hhbm5lbF9uYW1l
#4#cyJdCiAgICBXID0gcHJvY19tZXRhWyJ3aWR0aCJdCiAgICBIID0gcHJvY19tZXRhWyJoZWlnaHQi
#4#XQogICAgRCA9IHByb2NfbWV0YVsiZGVwdGgiXQoKICAgICMgVGhlIGZvbGRlciBpcyB0aGUgZGF0
#4#YXNldCdzIGlkOyB0aGUgbmFtZSBzaG93biBkZWZhdWx0cyB0byB0aGUgc291cmNlIGZpbGUncyBv
#4#d24KICAgICMgbmFtZSwgd2hpY2ggdGhlIGZvbGRlciBtYXkgaGF2ZSBoYWQgdG8gc2FuaXRpc2Uu
#4#CiAgICBkYXRhc2V0X25hbWUgPSBvdXRwdXRfZGlyLm5hbWUKICAgIHNob3duX25hbWUgPSBkaXNw
#4#bGF5X25hbWUgb3IgZGF0YXNldF9uYW1lCiAgICBzdGFnZSwgc3RhZ2VfbnVtID0gX3BhcnNlX3N0
#4#YWdlKHNob3duX25hbWUpCiAgICBlbWJyeW8gPSBfcGFyc2VfZW1icnlvKHNob3duX25hbWUpCgog
#4#ICAgIyBUaGUgZGlyZWN0b3J5IGEgZGF0YXNldCBzaXRzIGluIElTIGl0cyB0eXBlICgnM2QnLCAn
#4#bGl2ZScpLCBzbyB0aGUgdHlwZSwgdGhlIGlkCiAgICAjIGFuZCB0aGUgYnl0ZSBwYXRoIGFsbCBk
#4#ZXJpdmUgZnJvbSB0aGUgc2FtZSBzdHJpbmcuCiAgICBkYXRhc2V0X3R5cGUgPSBvdXRwdXRfZGly
#4#LnBhcmVudC5uYW1lCiAgICByZWxfcGF0aF9zdHIgPSBmIkRBVEFfV0VCL3tkYXRhc2V0X3R5cGV9
#4#L3tkYXRhc2V0X25hbWV9IgoKICAgICMgSGlzdG9ncmFtcyBhcmUgd3JpdHRlbiBieSBzdGVwIDMg
#4#d2l0aCB0aGUgbWFuaWZlc3QuIEEgbWFuaWZlc3QgcHJvZHVjZWQgYnkgYW4KICAgICMgb2xkZXIg
#4#c3RlcCAzIHN0aWxsIGhhcyBhbiBlbXB0eSBsaXN0OyBpdCBpcyBjb21wbGV0ZWQgaGVyZS4KICAg
#4#IG1hbmlmZXN0X3BhdGggPSBvdXRwdXRfZGlyIC8gImJyaWNrcyIgLyAibWFuaWZlc3QuanNvbiIK
#4#ICAgIG1hbmlmZXN0ID0gcmVhZF9qc29uX2ZpbGUobWFuaWZlc3RfcGF0aCkKICAgIGlmIG1hbmlm
#4#ZXN0IGFuZCBub3QgbWFuaWZlc3QuZ2V0KCJoaXN0b2dyYW1zIik6CiAgICAgICAgX2luamVjdF9o
#4#aXN0b2dyYW1zKHRlbXBfZGlyLCBtYW5pZmVzdF9wYXRoLCBtYW5pZmVzdCwgbG9kX2xldmVscywg
#4#bl9jaCwgbl90cCkKICAgIGVsaWYgbm90IG1hbmlmZXN0OgogICAgICAgIHByaW50KGYiW1dBUk5J
#4#TkddIG1hbmlmZXN0Lmpzb24gbm90IGZvdW5kIHRvIHVwZGF0ZSBoaXN0b2dyYW1zLiIpCgogICAg
#4#IyBDYWxpYnJhdGlvbi4gdm94ZWwgPSBleHRlbnQgLyBOIChzdGVwIDEpOyB3aXRob3V0IGFuIGV4
#4#dGVudCB0aGUgY2FsaWJyYXRpb24gaXMKICAgICMgdW5kZWNsYXJlZCBhbmQgZXZlcnkgZGVyaXZl
#4#ZCBzaXplIGlzIDAgcmF0aGVyIHRoYW4gYSBndWVzcy4KICAgIHZ4ID0gdm94ZWxfc2l6ZVsieCJd
#4#CiAgICB2eSA9IHZveGVsX3NpemVbInkiXQogICAgdnogPSB2b3hlbF9zaXplWyJ6Il0KICAgIGNh
#4#bGlicmF0ZWQgPSBib29sKHZ4IGFuZCB2eSBhbmQgdnopCgogICAgZXh0ZW50ID0gcHJvY19tZXRh
#4#LmdldCgiZXh0ZW50Iikgb3Ige30KICAgIGV4dF9taW4gPSBleHRlbnQuZ2V0KCJtaW4iKSBvciBb
#4#MC4wLCAwLjAsIDAuMF0KICAgIGV4dF9tYXggPSBleHRlbnQuZ2V0KCJtYXgiKSBvciBbVyAqIHZ4
#4#LCBIICogdnksIEQgKiB2el0KCiAgICAjIFRoZSB2aWV3ZXIgbW9kZWxzIGRlcHRoIGFzIChELTEp
#4#IHotc3RlcHMgcGx1cyBvbmUgc2xpY2UgdGhpY2tuZXNzLCBhbmQgd2l0aG91dAogICAgIyBhbiBl
#4#eHBsaWNpdCB2YWx1ZSBpdCBndWVzc2VzIHRoYXQgdGhpY2tuZXNzIGFzIG1pbih6U3RlcCwgdm94
#4#ZWxYKSDigJQgd2hpY2ggZm9yIGFuCiAgICAjIGFuaXNvdHJvcGljIHN0YWNrIHVuZGVyLXJlcG9y
#4#dHMgdGhlIGRlcHRoIChoZXJlIDMyOS41MCB1bSBpbnN0ZWFkIG9mIHRoZSAzMzMuODcgdW0KICAg
#4#ICMgSW1hcmlzIHN0YXRlcykuIERlY2xhcmluZyB0aGUgc2xpY2UgdGhpY2tuZXNzIGVxdWFsIHRv
#4#IHRoZSB6LXN0ZXAgcmVwcm9kdWNlcyB0aGUKICAgICMgbWljcm9zY29wZSdzIG93biBleHRlbnQg
#4#ZXhhY3RseSwgd2hpY2ggaXMgbWFuZGF0b3J5IGZvciBhbnl0aGluZyByZWdpc3RlcmVkIGluCiAg
#4#ICAjIEltYXJpcyBjb29yZGluYXRlcyAoY2VsbCB0cmFja3MpIHRvIGxhbmQgb24gdGhlIHJpZ2h0
#4#IHZveGVscy4KICAgIHNsaWNlX3RoaWNrbmVzcyA9IChleHRfbWF4WzJdIC0gZXh0X21pblsyXSkg
#4#LyBtYXgoRCwgMSkKICAgIHBoeXNpY2FsX3NpemUgPSB7CiAgICAgICAgIngiOiBleHRfbWF4WzBd
#4#IC0gZXh0X21pblswXSwKICAgICAgICAieSI6IGV4dF9tYXhbMV0gLSBleHRfbWluWzFdLAogICAg
#4#ICAgICJ6IjogZXh0X21heFsyXSAtIGV4dF9taW5bMl0sCiAgICAgICAgInNsaWNlVGhpY2tuZXNz
#4#Ijogc2xpY2VfdGhpY2tuZXNzLAogICAgICAgICJ2b3hlbFgiOiB2eCwKICAgICAgICAidm94ZWxZ
#4#IjogdnksCiAgICAgICAgInZveGVsWiI6IHZ6CiAgICB9CgogICAgaW50ZXJ2YWwgPSBwcm9jX21l
#4#dGEuZ2V0KCJ0aW1lX2ludGVydmFsX21pbnV0ZXMiKQogICAgdGltZXN0YW1wcyA9IHByb2NfbWV0
#4#YS5nZXQoInRpbWVzdGFtcHMiKSBvciBbXQoKICAgICMgU2V0dXAgZGVmYXVsdCBjaGFubmVscyBp
#4#bmZvIGZvciBtZXRhZGF0YS5qc29uCiAgICBjaGFubmVsc19pbmZvID0gW10KICAgIGZvciBpIGlu
#4#IHJhbmdlKG5fY2gpOgogICAgICAgIGNoX25hbWUgPSBjaGFubmVsX25hbWVzW2ldIGlmIGkgPCBs
#4#ZW4oY2hhbm5lbF9uYW1lcykgZWxzZSBmIkNoYW5uZWwge2krMX0iCiAgICAgICAgY2hhbm5lbHNf
#4#aW5mby5hcHBlbmQoewogICAgICAgICAgICAibmFtZSI6IGNoX25hbWUsCiAgICAgICAgICAgICJj
#4#b2xvciI6IENPTE9SU1tpICUgbGVuKENPTE9SUyldLAogICAgICAgICAgICAibWluIjogMC4wLAog
#4#ICAgICAgICAgICAibWF4IjogMS4wLAogICAgICAgICAgICAiZ2FtbWEiOiAxLjAKICAgICAgICB9
#4#KQoKICAgIG5vdyA9IGRhdGV0aW1lLm5vdygpLmlzb2Zvcm1hdCgpCiAgICBtZXRhZGF0YSA9IHsK
#4#ICAgICAgICAiaWQiOiBmIntkYXRhc2V0X3R5cGV9L3tkYXRhc2V0X25hbWV9IiwKICAgICAgICAi
#4#bmFtZSI6IHNob3duX25hbWUsCiAgICAgICAgInR5cGUiOiBkYXRhc2V0X3R5cGUsCiAgICAgICAg
#4#InN0YWdlIjogc3RhZ2UsCiAgICAgICAgInN0YWdlTnVtZXJpYyI6IHN0YWdlX251bSwKICAgICAg
#4#ICAiZW1icnlvIjogZW1icnlvLAogICAgICAgICJkaW1lbnNpb25zIjogewogICAgICAgICAgICAi
#4#eCI6IFcsCiAgICAgICAgICAgICJ5IjogSCwKICAgICAgICAgICAgInoiOiBELAogICAgICAgICAg
#4#ICAiYyI6IG5fY2gsCiAgICAgICAgICAgICJ0Ijogbl90cAogICAgICAgIH0sCiAgICAgICAgInZv
#4#eGVsX3NpemUiOiB2b3hlbF9zaXplLAogICAgICAgICJwaHlzaWNhbFNpemVVbSI6IHBoeXNpY2Fs
#4#X3NpemUsCiAgICAgICAgIm9wdGljYWxfc2VjdGlvbl90aGlja25lc3NfdW0iOiByb3VuZChzbGlj
#4#ZV90aGlja25lc3MsIDYpLAogICAgICAgICJhY3F1aXNpdGlvbkV4dGVudFVtIjogewogICAgICAg
#4#ICAgICAidW5pdCI6IGV4dGVudC5nZXQoInVuaXQiLCAidW0iKSwKICAgICAgICAgICAgIm1pbiI6
#4#IFtmbG9hdCh2KSBmb3IgdiBpbiBleHRfbWluXSwKICAgICAgICAgICAgIm1heCI6IFtmbG9hdCh2
#4#KSBmb3IgdiBpbiBleHRfbWF4XQogICAgICAgIH0sCiAgICAgICAgImNhbGlicmF0aW9uU3RhdHVz
#4#IjogImV4YWN0IiBpZiBjYWxpYnJhdGVkIGVsc2UgIm1ldGFkYXRhLW1pc3NpbmciLAogICAgICAg
#4#ICJjYWxpYnJhdGlvbk5vdGUiOiAoIlZveGVsIG1ldGFkYXRhIHdhcyBzdWNjZXNzZnVsbHkgZXh0
#4#cmFjdGVkLiIgaWYgY2FsaWJyYXRlZCBlbHNlCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAi
#4#Q2FsaWJyYXRpb24gbWV0YWRhdGEgbWlzc2luZzogdGhlIGZpbGUgZGVjbGFyZXMgbm8gdXNhYmxl
#4#IGV4dGVudC4iKSwKICAgICAgICAiY2hhbm5lbHMiOiBjaGFubmVsc19pbmZvLAogICAgICAgICJj
#4#cmVhdGVkIjogbm93LAogICAgICAgICJsYXN0TW9kaWZpZWQiOiBub3csCiAgICAgICAgImNvbmZp
#4#Z3VyZWQiOiBUcnVlLAogICAgICAgICJmb2xkZXJOYW1lIjogZGF0YXNldF9uYW1lLAogICAgICAg
#4#ICJkZXNjcmlwdGlvbiI6ICgKICAgICAgICAgICAgZiJUaW1lbGFwc2UgY29uZm9jYWwgYWNxdWlz
#4#aXRpb246IHtzdGFnZX0gZW1icnlvLCB7bl90cH0gdGltZXBvaW50cyIKICAgICAgICAgICAgZiJ7
#4#ZicgZXZlcnkge2ludGVydmFsOmd9IG1pbicgaWYgaW50ZXJ2YWwgZWxzZSAnJ30sIHtEfSBzbGlj
#4#ZXMsIHtuX2NofSBjaGFubmVscy4iCiAgICAgICAgICAgIGlmIG5fdHAgPiAxIGVsc2UKICAgICAg
#4#ICAgICAgZiJDb25mb2NhbCBpbWFnaW5nIHN0YWNrOiB7c3RhZ2V9IGZpeGVkIGVtYnJ5bywge0R9
#4#IHNsaWNlcywge25fY2h9IGNoYW5uZWxzLiIKICAgICAgICApLAogICAgICAgICJ0aHVtYm5haWwi
#4#OiBmIntyZWxfcGF0aF9zdHJ9L3RodW1ibmFpbC53ZWJwIiBpZiAob3V0cHV0X2RpciAvICJ0aHVt
#4#Ym5haWwud2VicCIpLmV4aXN0cygpIGVsc2UgTm9uZSwKICAgICAgICAidm9sdW1lU291cmNlcyI6
#4#IFsKICAgICAgICAgICAgewogICAgICAgICAgICAgICAgImtpbmQiOiAiYnJpY2tzIiwKICAgICAg
#4#ICAgICAgICAgICJsYWJlbCI6ICJDaHVua2VkIGJyaWNrcyAoNjTCsykiLAogICAgICAgICAgICAg
#4#ICAgInByaW9yaXR5IjogLTEsCiAgICAgICAgICAgICAgICAiYXZhaWxhYmxlIjogVHJ1ZSwKICAg
#4#ICAgICAgICAgICAgICJtdWx0aXNjYWxlIjogVHJ1ZSwKICAgICAgICAgICAgICAgICJwYXRoIjog
#4#cmVsX3BhdGhfc3RyLAogICAgICAgICAgICAgICAgIm1hbmlmZXN0UGF0aCI6IGYie3JlbF9wYXRo
#4#X3N0cn0vYnJpY2tzL21hbmlmZXN0Lmpzb24iCiAgICAgICAgICAgIH0KICAgICAgICBdCiAgICB9
#4#CgogICAgaWYgbl90cCA+IDE6CiAgICAgICAgbm9ybSA9IHByb2NfbWV0YS5nZXQoIm5vcm1hbGl6
#4#YXRpb24iKSBvciB7fQogICAgICAgIG1ldGFkYXRhWyJ0aW1lbGluZSJdID0gewogICAgICAgICAg
#4#ICAiY291bnQiOiBuX3RwLAogICAgICAgICAgICAiaW50ZXJ2YWxNaW51dGVzIjogaW50ZXJ2YWws
#4#CiAgICAgICAgICAgICJ0aW1lc3RhbXBzIjogdGltZXN0YW1wcwogICAgICAgIH0KICAgICAgICAj
#4#IFBob3RvYmxlYWNoaW5nIGlzIHJlcG9ydGVkLCBuZXZlciBiYWtlZCBpbjogdGhlIHZveGVscyBz
#4#dGF5IG9uIG9uZSBsaW5lYXIKICAgICAgICAjIHdpbmRvdyAoc2VlIDItaW1hZ2VfcHJvY2Vzc29y
#4#LnB5KSBzbyBhIGZyYW1lIHRoYXQgbG9va3MgZGltbWVyIHJlYWxseSBpcwogICAgICAgICMgZGlt
#4#bWVyLiBUaGVzZSBwZXItZnJhbWUgc2lnbmFsIGxldmVscyBsZXQgdGhlIHZpZXdlciBvZmZlciBh
#4#biBPUFRJT05BTCwKICAgICAgICAjIHJldmVyc2libGUgZGlzcGxheSBnYWluIGluc3RlYWQgb2Yg
#4#c2lsZW50bHkgcmV3cml0aW5nIHRoZSBkYXRhLgogICAgICAgIG1ldGFkYXRhWyJpbnRlbnNpdHlO
#4#b3JtYWxpemF0aW9uIl0gPSB7CiAgICAgICAgICAgICJtb2RlIjogbm9ybS5nZXQoIm1vZGUiLCAi
#4#Z2xvYmFsIiksCiAgICAgICAgICAgICJib3VuZHMiOiBub3JtLmdldCgiYm91bmRzIiwge30pLAog
#4#ICAgICAgICAgICAic2lnbmFsTGV2ZWxzIjogbm9ybS5nZXQoInNpZ25hbExldmVscyIsIHt9KQog
#4#ICAgICAgIH0KCiAgICAjIFJlLXByb2Nlc3Npbmcga2VlcHMgd2hhdCB0aGUgbGFiIGN1cmF0ZWQg
#4#aW4gdGhlIGFkbWluIHBhbmVsIOKAlCBvcmllbnRhdGlvbiwgZGlzcGxheQogICAgIyBzZXR0aW5n
#4#cywgaGFuZC1jb3JyZWN0ZWQgc3RhZ2UsIGhpZGRlbiBmbGFnLCBnYWxsZXJ54oCmIChtZXJnZV92
#4#b2x1bWVfbWV0YWRhdGEpLgogICAgZXhpc3RpbmcgPSByZWFkX2pzb25fZmlsZShleGlzdGluZ19w
#4#YXRoIGlmIGV4aXN0aW5nX3BhdGggZWxzZSBvdXRwdXRfZGlyIC8gIm1ldGFkYXRhLmpzb24iKQog
#4#ICAgaWYgZXhpc3Rpbmc6CiAgICAgICAgbWV0YWRhdGEgPSBtZXJnZV92b2x1bWVfbWV0YWRhdGEo
#4#ZXhpc3RpbmcsIG1ldGFkYXRhKQogICAgICAgIHByaW50KGYiW0NBVEFMT0ddIEN1cmF0aW9uIG9m
#4#IHRoZSBwdWJsaXNoZWQgbWV0YWRhdGEuanNvbiBrZXB0IikKCiAgICBhdG9taWNfd3JpdGVfanNv
#4#bihvdXRwdXRfZGlyIC8gIm1ldGFkYXRhLmpzb24iLCBtZXRhZGF0YSwgaW5kZW50PTIsIGVuc3Vy
#4#ZV9hc2NpaT1GYWxzZSkKICAgIHByaW50KGYiW0NBVEFMT0ddIFdyb3RlIG1ldGFkYXRhLmpzb24g
#4#dG8ge291dHB1dF9kaXIgLyAnbWV0YWRhdGEuanNvbid9IikKCgpkZWYgX2luamVjdF9oaXN0b2dy
#4#YW1zKHRlbXBfZGlyLCBtYW5pZmVzdF9wYXRoLCBtYW5pZmVzdCwgbG9kX2xldmVscywgbl9jaCwg
#4#bl90cCk6CiAgICBpbXBvcnQgaW1wb3J0bGliLnV0aWwKICAgIHNwZWMgPSBpbXBvcnRsaWIudXRp
#4#bC5zcGVjX2Zyb21fZmlsZV9sb2NhdGlvbigibHVtZW5fY2h1bmtfcGFja2VyIiwKICAgICAgICAg
#4#ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzdHIoSEVSRSAvICIzLWNo
#4#dW5rX3BhY2tlci5weSIpKQogICAgcGFja2VyID0gaW1wb3J0bGliLnV0aWwubW9kdWxlX2Zyb21f
#4#c3BlYyhzcGVjKQogICAgc3BlYy5sb2FkZXIuZXhlY19tb2R1bGUocGFja2VyKQogICAgY29hcnNl
#4#c3QgPSBsb2RfbGV2ZWxzWy0xXVsibG9kIl0KICAgIHByaW50KGYiW0NBVEFMT0ddIENvbXB1dGlu
#4#ZyBoaXN0b2dyYW1zIG9uIExPRCB7Y29hcnNlc3R9IgogICAgICAgICAgZiJ7ZicgZm9yIHtuX3Rw
#4#fSB0aW1lcG9pbnRzJyBpZiBuX3RwID4gMSBlbHNlICcnfS4uLiIpCiAgICBoaXN0b2dyYW1zID0g
#4#cGFja2VyLmhpc3RvZ3JhbXNfZm9yX3RpbWVwb2ludCh0ZW1wX2RpciwgMCwgbl9jaCwgY29hcnNl
#4#c3QpCiAgICBtYW5pZmVzdFsiaGlzdG9ncmFtcyJdID0gaGlzdG9ncmFtcwogICAgdHBfbWFuaWZl
#4#c3QgPSBtYW5pZmVzdC5nZXQoInRpbWVwb2ludHMiKQogICAgaWYgaXNpbnN0YW5jZSh0cF9tYW5p
#4#ZmVzdCwgZGljdCk6CiAgICAgICAgZm9yIHRfaWR4IGluIHJhbmdlKG5fdHApOgogICAgICAgICAg
#4#ICBrZXkgPSBmInR7dF9pZHg6MDNkfSIKICAgICAgICAgICAgaWYga2V5IGluIHRwX21hbmlmZXN0
#4#OgogICAgICAgICAgICAgICAgdHBfbWFuaWZlc3Rba2V5XVsiaGlzdG9ncmFtcyJdID0gKAogICAg
#4#ICAgICAgICAgICAgICAgIGhpc3RvZ3JhbXMgaWYgdF9pZHggPT0gMAogICAgICAgICAgICAgICAg
#4#ICAgIGVsc2UgcGFja2VyLmhpc3RvZ3JhbXNfZm9yX3RpbWVwb2ludCh0ZW1wX2RpciwgdF9pZHgs
#4#IG5fY2gsIGNvYXJzZXN0KSkKICAgIGF0b21pY193cml0ZV9qc29uKG1hbmlmZXN0X3BhdGgsIG1h
#4#bmlmZXN0LCBzZXBhcmF0b3JzPSgiLCIsICI6IikpCiAgICBwcmludChmIltDQVRBTE9HXSBJbmpl
#4#Y3RlZCBoaXN0b2dyYW1zIGludG8gbWFuaWZlc3QuanNvbiIpCgoKaWYgX19uYW1lX18gPT0gIl9f
#4#bWFpbl9fIjoKICAgIGFwID0gYXJncGFyc2UuQXJndW1lbnRQYXJzZXIoZGVzY3JpcHRpb249Ildy
#4#aXRlIGEgdm9sdW1lIGRhdGFzZXQncyBtZXRhZGF0YS5qc29uLiIpCiAgICBhcC5hZGRfYXJndW1l
#4#bnQoInRlbXBfZGlyIikKICAgIGFwLmFkZF9hcmd1bWVudCgib3V0cHV0X2RpciIpCiAgICBhcC5h
#4#ZGRfYXJndW1lbnQoIi0tZXhpc3RpbmciLCBkZWZhdWx0PU5vbmUsCiAgICAgICAgICAgICAgICAg
#4#ICAgaGVscD0icHVibGlzaGVkIG1ldGFkYXRhLmpzb24gd2hvc2UgY3VyYXRpb24gaXMga2VwdCAi
#4#CiAgICAgICAgICAgICAgICAgICAgICAgICAiKGRlZmF1bHQ6IDxvdXRwdXRfZGlyPi9tZXRhZGF0
#4#YS5qc29uKSIpCiAgICBhcC5hZGRfYXJndW1lbnQoIi0tZGlzcGxheS1uYW1lIiwgZGVmYXVsdD1O
#4#b25lLAogICAgICAgICAgICAgICAgICAgIGhlbHA9Im5hbWUgc2hvd24gZm9yIHRoZSBkYXRhc2V0
#4#IChkZWZhdWx0OiB0aGUgZm9sZGVyIG5hbWUpIikKICAgIGFyZ3MgPSBhcC5wYXJzZV9hcmdzKCkK
#4#CiAgICB0cnk6CiAgICAgICAgZ2VuZXJhdGVfY2F0YWxvZ19tZXRhZGF0YShQYXRoKGFyZ3MudGVt
#4#cF9kaXIpLCBQYXRoKGFyZ3Mub3V0cHV0X2RpciksCiAgICAgICAgICAgICAgICAgICAgICAgICAg
#4#ICAgICAgICBQYXRoKGFyZ3MuZXhpc3RpbmcpIGlmIGFyZ3MuZXhpc3RpbmcgZWxzZSBOb25lLAog
#4#ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXJncy5kaXNwbGF5X25hbWUpCiAgICAg
#4#ICAgcHJpbnQoZiJbQ0FUQUxPR10gQ2F0YWxvZyBtZXRhZGF0YSBnZW5lcmF0aW9uIGNvbXBsZXRl
#4#LiIpCiAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGU6CiAgICAgICAgaW1wb3J0IHRyYWNlYmFjawog
#4#ICAgICAgIHRyYWNlYmFjay5wcmludF9leGMoKQogICAgICAgIHByaW50KGYiW0VSUk9SXSBDYXRh
#4#bG9nIG1ldGFkYXRhIGdlbmVyYXRpb24gZmFpbGVkOiB7ZX0iLCBmaWxlPXN5cy5zdGRlcnIpCiAg
#4#ICAgICAgc3lzLmV4aXQoMSkK
:: ---- [5] 2d_importer.py (23502 octets) ----
#5#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwoiIiIKMkQgaW1wb3J0ZXIg4oCUIG9uZSBjb2xvdXIgcGhv
#5#dG9ncmFwaCDihpIgb25lIGAyZGAgZGF0YXNldC4KCklucHV0IDogMkQgVElGRnMgYXMgZXhwb3J0
#5#ZWQgYnkgSW1hZ2VKL0ZpamkgZnJvbSBhIExlaWNhIC5saWYgKGEgY29tcG9zaXRlIG9mCiAgICAg
#5#ICAgdGhyZWUgOC1iaXQgcGxhbmVzIHdpdGggUmVkL0dyZWVuL0JsdWUgTFVUcyksIHBsYWluIFJH
#5#QiBUSUZGcywgb3Igc2luZ2xlCiAgICAgICAgZ3JleXNjYWxlIFRJRkZzLiBObyBaLCBubyBUOiBh
#5#IDJEIGRhdGFzZXQgaXMgYSBwaWN0dXJlLCBub3QgYSB2b2x1bWUuCk91dHB1dDogREFUQV9XRUIv
#5#MmQvPGRhdGFzZXQ+LwogICAgICAgICAgaW1hZ2Uud2VicCAgICAgIG5hdGl2ZSByZXNvbHV0aW9u
#5#LCB3aGF0IHRoZSB2aWV3ZXIgc2hvd3Mgb25jZSBsb2FkZWQKICAgICAgICAgIHByZXZpZXcud2Vi
#5#cCAgICBsb25nIHNpZGUgNjQwIHB4LCBwYWludGVkIGZpcnN0IHNvIHRoZSBwYWdlIG5ldmVyIHdh
#5#aXRzCiAgICAgICAgICB0aHVtYm5haWwud2VicCAgNTEywrIgcGFkZGVkIHNxdWFyZSwgdGhlIGV4
#5#cGxvcmVyL2NhdGFsb2cgY29udmVudGlvbgogICAgICAgICAgbWV0YWRhdGEuanNvbiAgIHR5cGUg
#5#IjJkIiDigJQgc3RhZ2UsIHBpeGVsIHNpemUsIGFjcXVpc2l0aW9uCiAgICAgICAgICBkb3dubG9h
#5#ZC8gICAgICAgKC0td2l0aC1kb3dubG9hZHMpIHRoZSBvcmlnaW5hbCBUSUZGICsgUkVBRE1FLnR4
#5#dAoKRXZlcnl0aGluZyBtZWFzdXJhYmxlIGlzIHJlYWQgZnJvbSB0aGUgZmlsZSwgbmV2ZXIgZ3Vl
#5#c3NlZDogdGhlIHBpeGVsIHNpemUgY29tZXMKZnJvbSB0aGUgVElGRiByZXNvbHV0aW9uIHRhZ3Mg
#5#KEltYWdlSiB3cml0ZXMgdGhlbSBpbiBtaWNyb25zKSBhbmQgdGhlIGFjcXVpc2l0aW9uCmZpZWxk
#5#cyBmcm9tIHRoZSBMZWljYSBibG9jayBJbWFnZUogZW1iZWRzLiBXaGF0IHRoZSBmaWxlIGNhbm5v
#5#dCB0ZWxsIOKAlCB0aGUKcmVwb3J0ZXIgbGluZSwgdGhlIHN0YWluaW5nIOKAlCBpcyB0YWtlbiBm
#5#cm9tIHRoZSBjb21tYW5kIGxpbmUgYW5kIHByZXNlcnZlZCBvbgpyZS1pbXBvcnQgc28gbGFiIGN1
#5#cmF0aW9uIGlzIG5ldmVyIG92ZXJ3cml0dGVuIChzZWUgYG1lcmdlX2N1cmF0ZWRgKS4KCiAgICBw
#5#eXRob24gMmRfaW1wb3J0ZXIucHkgLS1pbnB1dCA8ZGlyfGZpbGUudGlmPiAtLW91dHB1dCBEQVRB
#5#X1dFQiBcCiAgICAgICAgWy0tbGluZSBETEw0eENEMV0gWy0tc3RhaW5pbmcgWC1nYWxdIFstLW9u
#5#bHkgIipFOC4wKiJdIFstLXdpdGgtZG93bmxvYWRzXSBbLS1mb3JjZV0KIiIiCmltcG9ydCBhcmdw
#5#YXJzZQppbXBvcnQgZm5tYXRjaAppbXBvcnQganNvbgppbXBvcnQgb3MKaW1wb3J0IHJlCmltcG9y
#5#dCBzaHV0aWwKaW1wb3J0IHN0cnVjdAppbXBvcnQgc3lzCmZyb20gZGF0ZXRpbWUgaW1wb3J0IGRh
#5#dGV0aW1lCmZyb20gcGF0aGxpYiBpbXBvcnQgUGF0aAoKaW1wb3J0IG51bXB5IGFzIG5wCmZyb20g
#5#UElMIGltcG9ydCBJbWFnZQoKSEVSRSA9IFBhdGgoX19maWxlX18pLnJlc29sdmUoKS5wYXJlbnQK
#5#aWYgc3RyKEhFUkUpIG5vdCBpbiBzeXMucGF0aDoKICAgIHN5cy5wYXRoLmluc2VydCgwLCBzdHIo
#5#SEVSRSkpCiMgT25lIGN1cmF0ZWQta2V5IGxpc3QgYW5kIG9uZSBtZXJnZSBydWxlIGZvciB0aGUg
#5#cGhvdG9ncmFwaCBpbXBvcnRlciBhbmQgdGhlIHZvbHVtZQojIHBpcGVsaW5lLCBzbyBhIHJlLWlt
#5#cG9ydCBwcm90ZWN0cyBleGFjdGx5IHdoYXQgdGhlIGFkbWluIHBhbmVsIGxldHMgdGhlIGxhYiBl
#5#ZGl0Lgpmcm9tIHJ1bl9wcmVwcm9jZXNzIGltcG9ydCBDVVJBVEVEX0tFWVMsIG1lcmdlX2N1cmF0
#5#ZWQsIGF0b21pY193cml0ZV90ZXh0ICAjIG5vcWE6IEU0MDIsRjQwMQoKX192ZXJzaW9uX18gPSAi
#5#MC4xOC4wIgoKIyBUaGUgZGlyZWN0b3J5IGEgZGF0YXNldCBzaXRzIGluIElTIGl0cyB0eXBlOiBE
#5#QVRBX1dFQi8yZC88Zm9sZGVyPiBpcyBkYXRhc2V0ICcyZC88Zm9sZGVyPicuCkRBVEFTRVRfVFlQ
#5#RSA9ICIyZCIKUFJFVklFV19MT05HX1NJREUgPSA2NDAKVEhVTUJfU0laRSA9IDUxMgpUSFVNQl9C
#5#QUNLR1JPVU5EID0gKDgsIDEwLCAxOCkKTkFUSVZFX1FVQUxJVFkgPSA5MApQUkVWSUVXX1FVQUxJ
#5#VFkgPSA4MAoKIyBXZWJQIHN0b3JlcyBlYWNoIHNpZGUgb24gMTQgYml0cy4KV0VCUF9NQVhfU0lE
#5#RSA9IDE2MzgzCgpJSl9NRVRBREFUQV9UQUcgPSA1MDgzOQpJSl9NRVRBREFUQV9DT1VOVFNfVEFH
#5#ID0gNTA4MzgKWF9SRVNPTFVUSU9OX1RBRyA9IDI4MgpZX1JFU09MVVRJT05fVEFHID0gMjgzCklN
#5#QUdFX0RFU0NSSVBUSU9OX1RBRyA9IDI3MAoKCiMg4pSA4pSAIEltYWdlSiBtZXRhZGF0YSDilIDi
#5#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIAKZGVmIHJlYWRfaWpfbWV0YWRhdGEoaW0pIC0+IGRpY3Q6CiAgICAiIiJEZWNvZGUgdGhl
#5#IEltYWdlSiBwcml2YXRlIHRhZyBpbnRvIHsnaW5mbyc6IFtzdHJdLCAnbGFibCc6IFtzdHJdLAog
#5#ICAgJ2x1dHMnOiBbYnl0ZXNdLCAncmFuZyc6IFtieXRlc119LiBBYnNlbnQgb3IgbWFsZm9ybWVk
#5#IOKGkiB7fS4iIiIKICAgIGJsb2IgPSBpbS50YWdfdjIuZ2V0KElKX01FVEFEQVRBX1RBRykKICAg
#5#IGNvdW50cyA9IGltLnRhZ192Mi5nZXQoSUpfTUVUQURBVEFfQ09VTlRTX1RBRykKICAgIGlmIG5v
#5#dCBibG9iIG9yIG5vdCBjb3VudHMgb3IgYnl0ZXMoYmxvYls6NF0pICE9IGIiSUpJSiI6CiAgICAg
#5#ICAgcmV0dXJuIHt9CiAgICBibG9iID0gYnl0ZXMoYmxvYikKICAgIGhlYWRlcl9sZW4gPSBjb3Vu
#5#dHNbMF0KICAgIGtpbmRzID0gWyhibG9iW3A6cCArIDRdLCBzdHJ1Y3QudW5wYWNrKCI+SSIsIGJs
#5#b2JbcCArIDQ6cCArIDhdKVswXSkKICAgICAgICAgICAgIGZvciBwIGluIHJhbmdlKDQsIGhlYWRl
#5#cl9sZW4sIDgpXQogICAgb3V0LCBwb3MsIGlkeCA9IHt9LCBoZWFkZXJfbGVuLCAxCiAgICBmb3Ig
#5#a2luZCwgbiBpbiBraW5kczoKICAgICAgICBpdGVtcyA9IFtdCiAgICAgICAgZm9yIF8gaW4gcmFu
#5#Z2Uobik6CiAgICAgICAgICAgIGlmIGlkeCA+PSBsZW4oY291bnRzKToKICAgICAgICAgICAgICAg
#5#IHJldHVybiBvdXQKICAgICAgICAgICAgY2h1bmsgPSBibG9iW3Bvczpwb3MgKyBjb3VudHNbaWR4
#5#XV0KICAgICAgICAgICAgcG9zICs9IGNvdW50c1tpZHhdCiAgICAgICAgICAgIGlkeCArPSAxCiAg
#5#ICAgICAgICAgIGl0ZW1zLmFwcGVuZChjaHVuay5kZWNvZGUoInV0Zi0xNi1iZSIsICJyZXBsYWNl
#5#IikKICAgICAgICAgICAgICAgICAgICAgICAgIGlmIGtpbmQgaW4gKGIiaW5mbyIsIGIibGFibCIp
#5#IGVsc2UgY2h1bmspCiAgICAgICAgb3V0W2tpbmQuZGVjb2RlKCJhc2NpaSIsICJyZXBsYWNlIild
#5#ID0gaXRlbXMKICAgIHJldHVybiBvdXQKCgpkZWYgcmVhZF9wbGFuZXMoaW0sIGRlc2NyaXB0aW9u
#5#OiBzdHIgPSAiIikgLT4gbGlzdDoKICAgICIiIlRoZSBjb2xvdXIgcGxhbmVzIG9mIHRoZSBwaWN0
#5#dXJlLiBBbiBJbWFnZUogaHlwZXJzdGFjayBzdG9yZXMgaXRzIHBhZ2VzIGluCiAgICBjaGFubmVs
#5#LWZhc3Rlc3Qgb3JkZXIsIHNvIHRoZSBmaXJzdCBgY2hhbm5lbHM9YCBwYWdlcyBhcmUgb25lIGNv
#5#bXBsZXRlIGNvbXBvc2l0ZTsKICAgIHRoZSBmdXJ0aGVyIHBhZ2VzIG9mIGEgWiBvciBUIHN0YWNr
#5#IGFyZSBvdGhlciBwaWN0dXJlcywgbm90IG1vcmUgY29sb3VyLCBhbmQgYWRkaW5nCiAgICB0aGVt
#5#IGluIHdvdWxkIGJsZW5kIHNldmVyYWwgaW1hZ2VzIGludG8gb25lLiIiIgogICAgbl9mcmFtZXMg
#5#PSBnZXRhdHRyKGltLCAibl9mcmFtZXMiLCAxKQogICAgbSA9IHJlLnNlYXJjaChyIl5jaGFubmVs
#5#cz0oXGQrKSIsIGRlc2NyaXB0aW9uLCByZS5NVUxUSUxJTkUpCiAgICBuX3BsYW5lcyA9IG1pbihu
#5#X2ZyYW1lcywgaW50KG0uZ3JvdXAoMSkpKSBpZiBtIGVsc2Ugbl9mcmFtZXMKICAgIGlmIG5fcGxh
#5#bmVzIDwgbl9mcmFtZXM6CiAgICAgICAgcHJpbnQoZiIgIFtub3RlXSB7bl9mcmFtZXN9IHBhZ2Vz
#5#LCBjb21wb3NpdGUgb2YgdGhlIGZpcnN0IHtuX3BsYW5lc30gKGNoYW5uZWxzPXtuX3BsYW5lc30p
#5#OyAiCiAgICAgICAgICAgICAgZiJ0aGUgb3RoZXIgc2xpY2VzL2ZyYW1lcyBhcmUgbm90IHBhcnQg
#5#b2YgdGhpcyBwaWN0dXJlIikKICAgIHBsYW5lcyA9IFtdCiAgICBmb3IgaSBpbiByYW5nZShuX3Bs
#5#YW5lcyk6CiAgICAgICAgaW0uc2VlayhpKQogICAgICAgIHBsYW5lcy5hcHBlbmQobnAuYXJyYXko
#5#aW0pKQogICAgaW0uc2VlaygwKQogICAgcmV0dXJuIHBsYW5lcwoKCmRlZiBjb21wb3NlX3JnYihw
#5#bGFuZXM6IGxpc3QsIGx1dHM6IGxpc3QpIC0+IG5wLm5kYXJyYXk6CiAgICAiIiJBZGRpdGl2ZSBj
#5#b21wb3NpdGUsIGV4YWN0bHkgd2hhdCBJbWFnZUoncyBjb21wb3NpdGUgbW9kZSBkaXNwbGF5czoK
#5#ICAgIG91dCA9IM6jIGx1dF9jW3BsYW5lX2NdLiBQbGFpbiBSR0IgYW5kIGdyZXlzY2FsZSBmaWxl
#5#cyBwYXNzIHN0cmFpZ2h0IHRocm91Z2guIiIiCiAgICBmaXJzdCA9IHBsYW5lc1swXQogICAgaWYg
#5#Zmlyc3QubmRpbSA9PSAzOgogICAgICAgIHJldHVybiBucC5hc2NvbnRpZ3VvdXNhcnJheShmaXJz
#5#dFs6LCA6LCA6M10pCiAgICBhY2MgPSBucC56ZXJvcyhmaXJzdC5zaGFwZSArICgzLCksIGR0eXBl
#5#PW5wLmZsb2F0MzIpCiAgICBmb3IgYywgcGxhbmUgaW4gZW51bWVyYXRlKHBsYW5lcyk6CiAgICAg
#5#ICAgbHV0ID0gX2x1dF90YWJsZShsdXRzLCBjLCBsZW4ocGxhbmVzKSkKICAgICAgICBhY2MgKz0g
#5#bHV0W190b191aW50OChwbGFuZSldCiAgICByZXR1cm4gbnAuY2xpcChhY2MsIDAsIDI1NSkuYXN0
#5#eXBlKG5wLnVpbnQ4KQoKCmRlZiBfbHV0X3RhYmxlKGx1dHM6IGxpc3QsIGluZGV4OiBpbnQsIG5f
#5#cGxhbmVzOiBpbnQpIC0+IG5wLm5kYXJyYXk6CiAgICAiIiIyNTbDlzMgY29sb3VyIHRhYmxlIGZv
#5#ciBwbGFuZSBgaW5kZXhgLiBJbWFnZUogc3RvcmVzIFIsRyxCIHJhbXBzIG9mIDI1NgogICAgYnl0
#5#ZXMgZWFjaDsgd2l0aG91dCBMVVRzLCB0aHJlZSBwbGFuZXMgYXJlIHRha2VuIGFzIFIvRy9CLCBv
#5#bmUgYXMgZ3JleS4iIiIKICAgIGlmIGluZGV4IDwgbGVuKGx1dHMpIGFuZCBsZW4obHV0c1tpbmRl
#5#eF0pID09IDc2ODoKICAgICAgICByYXcgPSBucC5mcm9tYnVmZmVyKGx1dHNbaW5kZXhdLCBkdHlw
#5#ZT1ucC51aW50OCkKICAgICAgICByZXR1cm4gcmF3LnJlc2hhcGUoMywgMjU2KS5ULmFzdHlwZShu
#5#cC5mbG9hdDMyKQogICAgcmFtcCA9IG5wLmFyYW5nZSgyNTYsIGR0eXBlPW5wLmZsb2F0MzIpCiAg
#5#ICB0YWJsZSA9IG5wLnplcm9zKCgyNTYsIDMpLCBkdHlwZT1ucC5mbG9hdDMyKQogICAgaWYgbl9w
#5#bGFuZXMgPT0gMzoKICAgICAgICB0YWJsZVs6LCBpbmRleF0gPSByYW1wCiAgICBlbHNlOgogICAg
#5#ICAgIHRhYmxlWzpdID0gcmFtcFs6LCBOb25lXQogICAgcmV0dXJuIHRhYmxlCgoKZGVmIF90b191
#5#aW50OChwbGFuZTogbnAubmRhcnJheSkgLT4gbnAubmRhcnJheToKICAgIGlmIHBsYW5lLmR0eXBl
#5#ID09IG5wLnVpbnQ4OgogICAgICAgIHJldHVybiBwbGFuZQogICAgaGkgPSBmbG9hdChwbGFuZS5t
#5#YXgoKSkgb3IgMS4wCiAgICByZXR1cm4gKHBsYW5lLmFzdHlwZShucC5mbG9hdDMyKSAqICgyNTUu
#5#MCAvIGhpKSkuYXN0eXBlKG5wLnVpbnQ4KQoKCiMg4pSA4pSAIENhbGlicmF0aW9uIOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgApkZWYgcGl4ZWxfc2l6ZV91bShpbSwgZGVzY3JpcHRpb246IHN0cikgLT4g
#5#dHVwbGU6CiAgICAiIiIoKMK1bSBwZXIgcGl4ZWwgYWxvbmcgeCwgYWxvbmcgeSksIHN0YXR1cyku
#5#IEltYWdlSiB3cml0ZXMgWC9ZUmVzb2x1dGlvbiBpbiBwaXhlbHMKICAgIHBlciBgdW5pdGA7IHdl
#5#IG9ubHkgdHJ1c3QgdGhlbSB3aGVuIHRoZSB1bml0IGlzIGRlY2xhcmVkIGluIG1pY3JvbnMuIEEg
#5#ZmlsZSB3aXRoCiAgICBYUmVzb2x1dGlvbiBhbG9uZSBoYXMgc3F1YXJlIHBpeGVscy4iIiIKICAg
#5#IHhyZXMgPSBpbS50YWdfdjIuZ2V0KFhfUkVTT0xVVElPTl9UQUcpCiAgICB5cmVzID0gaW0udGFn
#5#X3YyLmdldChZX1JFU09MVVRJT05fVEFHKSBvciB4cmVzCiAgICB1bml0ID0gcmUuc2VhcmNoKHIi
#5#XnVuaXQ9KFxTKykiLCBkZXNjcmlwdGlvbiwgcmUuTVVMVElMSU5FKQogICAgdW5pdCA9IHVuaXQu
#5#Z3JvdXAoMSkubG93ZXIoKSBpZiB1bml0IGVsc2UgIiIKICAgIGlmIHhyZXMgYW5kIGZsb2F0KHhy
#5#ZXMpID4gMCBhbmQgdW5pdCBpbiBNSUNST05fVU5JVFM6CiAgICAgICAgeSA9IGZsb2F0KHlyZXMp
#5#IGlmIHlyZXMgYW5kIGZsb2F0KHlyZXMpID4gMCBlbHNlIGZsb2F0KHhyZXMpCiAgICAgICAgcmV0
#5#dXJuICgxLjAgLyBmbG9hdCh4cmVzKSwgMS4wIC8geSksICJleGFjdCIKICAgIHJldHVybiBOb25l
#5#LCAidW5rbm93biIKCgpNSUNST05fVU5JVFMgPSAoIm1pY3JvbiIsICJtaWNyb25zIiwgInVtIiwg
#5#Ilx1MDBiNW0iLCAiXHUwM2JjbSIsICJcXHUwMGI1bSIpCgoKIyDilIDilIAgTGVpY2EgYmxvY2sg
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSACkxFSUNBX0ZJRUxEUyA9IHsKICAgICJab29tIjogKCJ6b29t
#5#IiwgZmxvYXQpLAogICAgIk1hZ25pZmljYXRpb24iOiAoIm1hZ25pZmljYXRpb24iLCBmbG9hdCks
#5#CiAgICAiT2JqZWN0aXZlTmFtZSI6ICgib2JqZWN0aXZlIiwgc3RyKSwKICAgICJOdW1lcmljYWxB
#5#cGVydHVyZSI6ICgibnVtZXJpY2FsQXBlcnR1cmUiLCBmbG9hdCksCiAgICAiRXhwb3N1cmVUaW1l
#5#IjogKCJleHBvc3VyZVMiLCBmbG9hdCksCiAgICAiSW5kaXZpZHVhbENhbWVyYUluZm98R2FpbiI6
#5#ICgiZ2FpbiIsIGZsb2F0KSwKICAgICJNaWNyb3Njb3BlTW9kZWwiOiAoIm1pY3Jvc2NvcGUiLCBz
#5#dHIpLAogICAgIkZ1bGxDYW1lcmFOYW1lIjogKCJjYW1lcmEiLCBzdHIpLAp9CgoKZGVmIGxlaWNh
#5#X2ZpZWxkcyhpbmZvOiBzdHIsIHNlcmllczogc3RyKSAtPiBkaWN0OgogICAgIiIiQWNxdWlzaXRp
#5#b24gc2V0dGluZ3Mgb2Ygb25lIHNlcmllcy4gVGhlIExlaWNhIGJsb2NrIHJlcGVhdHMgYSBrZXkg
#5#b25jZSBwZXIKICAgIGpvYiBibG9jayAoYExETV9CbG9ja1/igKZgKSBhbmQgb25jZSBhdCB0aGUg
#5#dG9wIGxldmVsIGZvciB0aGUgZXhwb3N1cmUgdGhhdCB3YXMKICAgIGFjdHVhbGx5IHRha2VuOyB0
#5#aGUgdG9wLWxldmVsIGxpbmUgd2lucywgZmlyc3QgYmxvY2sgbGluZSBhcyBmYWxsYmFjay4iIiIK
#5#ICAgICMgRXZlcnkgbGluZSBvZiBhIHNlcmllcyBzdGFydHMgd2l0aCBgPHNlcmllcz4gSW1hZ2Xi
#5#gKZgOyB0aGUgdHJhaWxpbmcgIkltYWdlIgogICAgIyBrZWVwcyBgRTguMCB4My4yIDI0MDkxM2Ag
#5#ZnJvbSBhbHNvIG1hdGNoaW5nIGBFOC4wIHgzLjIgMjQwOTEzIDJgLgogICAgcHJlZml4ID0gc2Vy
#5#aWVzICsgIiBJbWFnZSIKICAgIGxpbmVzID0gW2xbbGVuKHNlcmllcykgKyAxOl0gZm9yIGwgaW4g
#5#aW5mby5zcGxpdGxpbmVzKCkgaWYgbC5zdGFydHN3aXRoKHByZWZpeCldCiAgICBvdXQgPSB7fQog
#5#ICAgZm9yIHN1ZmZpeCwgKG5hbWUsIGNhc3QpIGluIExFSUNBX0ZJRUxEUy5pdGVtcygpOgogICAg
#5#ICAgIHZhbHVlID0gX3BpY2tfdmFsdWUobGluZXMsIHN1ZmZpeCkKICAgICAgICBpZiB2YWx1ZSBp
#5#cyBub3QgTm9uZToKICAgICAgICAgICAgb3V0W25hbWVdID0gdmFsdWUgaWYgY2FzdCBpcyBzdHIg
#5#ZWxzZSBfc2FmZV9mbG9hdCh2YWx1ZSkKICAgIGlmICJleHBvc3VyZVMiIGluIG91dDoKICAgICAg
#5#ICBvdXRbImV4cG9zdXJlTXMiXSA9IHJvdW5kKG91dC5wb3AoImV4cG9zdXJlUyIpICogMTAwMC4w
#5#LCAzKQogICAgaWYgb3V0LmdldCgiY2FtZXJhIik6CiAgICAgICAgb3V0WyJjYW1lcmEiXSA9IG91
#5#dFsiY2FtZXJhIl0uc3BsaXQoIi0iKVswXQogICAgcmV0dXJuIHtrOiB2IGZvciBrLCB2IGluIG91
#5#dC5pdGVtcygpIGlmIHYgbm90IGluIChOb25lLCAiIiwgMC4wKX0KCgpkZWYgX3BpY2tfdmFsdWUo
#5#bGluZXM6IGxpc3QsIHN1ZmZpeDogc3RyKToKICAgICIiIkxBUyBYIHdyaXRlcyAiMCIgZm9yIGEg
#5#c2V0dGluZyB0aGF0IGRvZXMgbm90IGFwcGx5IHRvIGEgYmxvY2s7IHRob3NlCiAgICBwbGFjZWhv
#5#bGRlcnMgbmV2ZXIgYmVhdCBhIHJlYWwgdmFsdWUuIiIiCiAgICBoaXRzID0gWyhrLCB2LnN0cmlw
#5#KCkpIGZvciBrLCBfLCB2IGluIChsLnBhcnRpdGlvbigiID0gIikgZm9yIGwgaW4gbGluZXMpCiAg
#5#ICAgICAgICAgIGlmIGsucnN0cmlwKCkuZW5kc3dpdGgoc3VmZml4KSBhbmQgdi5zdHJpcCgpIG5v
#5#dCBpbiAoIiIsICIwIildCiAgICBpZiBub3QgaGl0czoKICAgICAgICByZXR1cm4gTm9uZQogICAg
#5#dG9wID0gW3YgZm9yIGssIHYgaW4gaGl0cyBpZiAiTERNX0Jsb2NrIiBub3QgaW4ga10KICAgIHJl
#5#dHVybiAodG9wIG9yIFt2IGZvciBfLCB2IGluIGhpdHNdKVswXQoKCmRlZiBfc2FmZV9mbG9hdCh0
#5#ZXh0OiBzdHIpOgogICAgdHJ5OgogICAgICAgIHJldHVybiBmbG9hdCh0ZXh0KQogICAgZXhjZXB0
#5#IChUeXBlRXJyb3IsIFZhbHVlRXJyb3IpOgogICAgICAgIHJldHVybiBOb25lCgoKIyDilIDilIAg
#5#RmlsZS1uYW1lIGNvbnZlbnRpb25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgApkZWYgX2xvYWRfc3RhZ2VfcGFyc2VyKCk6CiAgICAiIiJUaGUgdm9sdW1l
#5#IHBpcGVsaW5lJ3MgZW1icnlvbmljLWRheSBwYXJzZXIgKDQtY2F0YWxvZ19nZW5lcmF0b3IuX3Bh
#5#cnNlX3N0YWdlKSwgc28KICAgIGEgcGhvdG9ncmFwaCBhbmQgYSB2b2x1bWUgb2YgdGhlIHNhbWUg
#5#ZW1icnlvIHJlYWQgb25lIHN0YWdlIGZyb20gb25lIHNwZWxsaW5nCiAgICAoRTgtNSwgRTguNSwg
#5#RTg1IC0+IEU4LjU7IEUxMC01LCBFMTAuNSwgRTEwNSAtPiBFMTAuNSkuIiIiCiAgICBpbXBvcnQg
#5#aW1wb3J0bGliLnV0aWwKICAgIHNwZWMgPSBpbXBvcnRsaWIudXRpbC5zcGVjX2Zyb21fZmlsZV9s
#5#b2NhdGlvbigibHVtZW5fY2F0YWxvZ19nZW5lcmF0b3IiLAogICAgICAgICAgICAgICAgICAgICAg
#5#ICAgICAgICAgICAgICAgICAgICAgICAgICAgIHN0cihIRVJFIC8gIjQtY2F0YWxvZ19nZW5lcmF0
#5#b3IucHkiKSkKICAgIG1vZHVsZSA9IGltcG9ydGxpYi51dGlsLm1vZHVsZV9mcm9tX3NwZWMoc3Bl
#5#YykKICAgIHNwZWMubG9hZGVyLmV4ZWNfbW9kdWxlKG1vZHVsZSkKICAgIHJldHVybiBtb2R1bGUu
#5#X3BhcnNlX3N0YWdlCgoKX1BBUlNFX1NUQUdFID0gX2xvYWRfc3RhZ2VfcGFyc2VyKCkKCgpkZWYg
#5#X3N0YWdlX29mKHRleHQ6IHN0cik6CiAgICAiIiIoZGlzcGxheSwgbnVtZXJpYykgb2YgdGhlIHN0
#5#YWdlIHRva2VuIGluIGB0ZXh0YCwgb3IgTm9uZSB3aGVuIGl0IGNhcnJpZXMgbm9uZS4iIiIKICAg
#5#ICMgQnJhY2tldHMgY291bnQgYXMgc2VwYXJhdG9ycywgYXMgdGhleSBkaWQgZm9yIHRoZSBwaG90
#5#b2dyYXBoJ3MgZm9ybWVyIFxiIHJ1bGUuCiAgICBkaXNwbGF5LCBudW1lcmljID0gX1BBUlNFX1NU
#5#QUdFKHJlLnN1YihyIlsoKVxbXF1dIiwgIiAiLCB0ZXh0IG9yICIiKSkKICAgIHJldHVybiBOb25l
#5#IGlmIGRpc3BsYXkgPT0gIlVua25vd24iIGVsc2UgKGRpc3BsYXksIG51bWVyaWMpCgoKWk9PTV9S
#5#WCA9IHJlLmNvbXBpbGUociJcYngoXGQrKD86Wy4sXVxkKyk/KVxiIiwgcmUuSUdOT1JFQ0FTRSkK
#5#REFURV9SWCA9IHJlLmNvbXBpbGUociJcYihcZHs2fSlcYiIpCkxJTkVfUlggPSByZS5jb21waWxl
#5#KHIiXGIoW0EtWmEtejAtOV0reFtBLVphLXpdW0EtWmEtejAtOV0qKVxiIikKCgpkZWYgcGFyc2Vf
#5#ZmlsZW5hbWUoc3RlbTogc3RyLCBsaW5lX292ZXJyaWRlOiBzdHIgPSBOb25lKSAtPiBkaWN0Ogog
#5#ICAgIiIiYDxsaWY+IC0gPHN0YWdlPiB4PHpvb20+IDxkaXNzZWN0aW9uIHl5bW1kZD4gWzxuPiBb
#5#PG0+XV1gIGFzIHRoZSBsYWIgbmFtZXMKICAgIGl0cyBleHBvcnRzLiBNaXNzaW5nIHBhcnRzIHN0
#5#YXkgTm9uZTsgbm90aGluZyBpcyBpbnZlbnRlZC4iIiIKICAgIGxpZiwgc2VwLCBzZXJpZXMgPSBz
#5#dGVtLnBhcnRpdGlvbigiLmxpZiAtICIpCiAgICBpZiBub3Qgc2VwOgogICAgICAgIGxpZiwgc2Vy
#5#aWVzID0gIiIsIHN0ZW0KICAgIHN0YWdlID0gX3N0YWdlX29mKHNlcmllcykgb3IgX3N0YWdlX29m
#5#KGxpZikKICAgIHpvb21fbSA9IFpPT01fUlguc2VhcmNoKHNlcmllcykKICAgIGRhdGVzID0gW2Qg
#5#Zm9yIGQgaW4gREFURV9SWC5maW5kYWxsKHNlcmllcykgaWYgX3ZhbGlkX3l5bW1kZChkKV0KICAg
#5#IHRhaWwgPSBzZXJpZXNbem9vbV9tLmVuZCgpOl0gaWYgem9vbV9tIGVsc2UgIiIKICAgIGluZGV4
#5#ID0gIiAiLmpvaW4odCBmb3IgdCBpbiB0YWlsLnNwbGl0KCkgaWYgdC5pc2RpZ2l0KCkgYW5kIHQg
#5#bm90IGluIGRhdGVzKQogICAgbGluZV9tID0gTElORV9SWC5zZWFyY2gobGlmKSBvciBMSU5FX1JY
#5#LnNlYXJjaChzZXJpZXMpCiAgICByZXR1cm4gewogICAgICAgICJsaWYiOiAobGlmICsgIi5saWYi
#5#KSBpZiBsaWYgZWxzZSBOb25lLAogICAgICAgICJzZXJpZXMiOiBzZXJpZXMuc3RyaXAoKSwKICAg
#5#ICAgICAic3RhZ2UiOiBzdGFnZVswXSBpZiBzdGFnZSBlbHNlIE5vbmUsCiAgICAgICAgInN0YWdl
#5#TnVtZXJpYyI6IHN0YWdlWzFdIGlmIHN0YWdlIGVsc2UgTm9uZSwKICAgICAgICAiem9vbSI6IGZs
#5#b2F0KHpvb21fbS5ncm91cCgxKS5yZXBsYWNlKCIsIiwgIi4iKSkgaWYgem9vbV9tIGVsc2UgTm9u
#5#ZSwKICAgICAgICAiZGlzc2VjdGlvbkRhdGUiOiBfaXNvX2RhdGUoZGF0ZXNbMF0pIGlmIGRhdGVz
#5#IGVsc2UgTm9uZSwKICAgICAgICAiaW5kZXgiOiBpbmRleCBvciBOb25lLAogICAgICAgICJsaW5l
#5#IjogbGluZV9vdmVycmlkZSBvciAobGluZV9tLmdyb3VwKDEpIGlmIGxpbmVfbSBlbHNlIE5vbmUp
#5#LAogICAgfQoKCmRlZiBfdmFsaWRfeXltbWRkKHRleHQ6IHN0cikgLT4gYm9vbDoKICAgIHRyeToK
#5#ICAgICAgICBkYXRldGltZS5zdHJwdGltZSh0ZXh0LCAiJXklbSVkIikKICAgICAgICByZXR1cm4g
#5#VHJ1ZQogICAgZXhjZXB0IFZhbHVlRXJyb3I6CiAgICAgICAgcmV0dXJuIEZhbHNlCgoKZGVmIF9p
#5#c29fZGF0ZSh5eW1tZGQ6IHN0cikgLT4gc3RyOgogICAgcmV0dXJuIGRhdGV0aW1lLnN0cnB0aW1l
#5#KHl5bW1kZCwgIiV5JW0lZCIpLnN0cmZ0aW1lKCIlWS0lbS0lZCIpCgoKZGVmIGRhdGFzZXRfZm9s
#5#ZGVyX25hbWUocGFyc2VkOiBkaWN0KSAtPiBzdHI6CiAgICAiIiJgPGxpbmU+LTxzdGFnZT4teDx6
#5#b29tPi08eXltbWRkPi08aW5kZXg+YCwgc3RhZ2Ugd2l0aG91dCBpdHMgZG90CiAgICAoRTcuNzUg
#5#4oaSIEU3NzUpIGFzIHRoZSBwbGF0Zm9ybSdzIG90aGVyIGRhdGFzZXRzIHNwZWxsIGl0LiIiIgog
#5#ICAgcGFydHMgPSBbcGFyc2VkLmdldCgibGluZSIpLAogICAgICAgICAgICAgcGFyc2VkWyJzdGFn
#5#ZSJdLnJlcGxhY2UoIi4iLCAiIikgaWYgcGFyc2VkLmdldCgic3RhZ2UiKSBlbHNlIE5vbmUsCiAg
#5#ICAgICAgICAgICBmInh7cGFyc2VkWyd6b29tJ106Z30iIGlmIHBhcnNlZC5nZXQoInpvb20iKSBl
#5#bHNlIE5vbmUsCiAgICAgICAgICAgICBwYXJzZWRbImRpc3NlY3Rpb25EYXRlIl0ucmVwbGFjZSgi
#5#LSIsICIiKVsyOl0gaWYgcGFyc2VkLmdldCgiZGlzc2VjdGlvbkRhdGUiKSBlbHNlIE5vbmUsCiAg
#5#ICAgICAgICAgICBwYXJzZWQuZ2V0KCJpbmRleCIpXQogICAgaWYgbm90IChwYXJzZWQuZ2V0KCJ6
#5#b29tIikgb3IgcGFyc2VkLmdldCgiZGlzc2VjdGlvbkRhdGUiKSk6CiAgICAgICAgcGFydHMuYXBw
#5#ZW5kKHBhcnNlZC5nZXQoInNlcmllcyIpKQogICAgcmV0dXJuIHNsdWdpZnkoIi0iLmpvaW4ocCBm
#5#b3IgcCBpbiBwYXJ0cyBpZiBwKSkgb3IgInBob3RvZ3JhcGgiCgoKZGVmIHNsdWdpZnkodGV4dDog
#5#c3RyKSAtPiBzdHI6CiAgICByZXR1cm4gcmUuc3ViKHIiLXsyLH0iLCAiLSIsIHJlLnN1YihyIlte
#5#QS1aYS16MC05Ll8tXSsiLCAiLSIsIHRleHQpKS5zdHJpcCgiLS4iKQoKCiMg4pSA4pSAIE91dHB1
#5#dHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmRlZiB3cml0ZV9pbWFnZXMocmdi
#5#OiBucC5uZGFycmF5LCBvdXRfZGlyOiBQYXRoLCBsb3NzbGVzczogYm9vbCA9IEZhbHNlKSAtPiBk
#5#aWN0OgogICAgaCwgdyA9IHJnYi5zaGFwZVs6Ml0KICAgIGlmIG1heCh3LCBoKSA+IFdFQlBfTUFY
#5#X1NJREU6CiAgICAgICAgcmFpc2UgVmFsdWVFcnJvcihmInt3fXh7aH0gcHg6IFdlYlAgaXMgbGlt
#5#aXRlZCB0byB7V0VCUF9NQVhfU0lERX0gcHggcGVyIHNpZGUg4oCUICIKICAgICAgICAgICAgICAg
#5#ICAgICAgICAgIGYicmVkdWNlIHRoZSBleHBvcnQgYmVmb3JlIGltcG9ydGluZyBpdCIpCiAgICBu
#5#YXRpdmUgPSBJbWFnZS5mcm9tYXJyYXkocmdiLCBtb2RlPSJSR0IiKQogICAgIyBMb3NzeSBXZWJQ
#5#IGFsd2F5cyBzdWJzYW1wbGVzIGNocm9tYSA0OjI6MCwgd2hpY2ggcGVydHVyYnMgdGhlIHBlci1w
#5#aXhlbCBCL1IgcmF0aW8KICAgICMgdGhlIHN0YWluIGlzb2xhdGlvbiByZWFkcyBhdCBzaGFycCBl
#5#ZGdlczsgLS1sb3NzbGVzcyBrZWVwcyBldmVyeSBwaXhlbCBleGFjdC4KICAgIGlmIGxvc3NsZXNz
#5#OgogICAgICAgIG5hdGl2ZS5zYXZlKG91dF9kaXIgLyAiaW1hZ2Uud2VicCIsICJXRUJQIiwgbG9z
#5#c2xlc3M9VHJ1ZSwgbWV0aG9kPTYpCiAgICBlbHNlOgogICAgICAgIG5hdGl2ZS5zYXZlKG91dF9k
#5#aXIgLyAiaW1hZ2Uud2VicCIsICJXRUJQIiwgcXVhbGl0eT1OQVRJVkVfUVVBTElUWSwgbWV0aG9k
#5#PTYpCgogICAgcHJldmlldyA9IG5hdGl2ZS5jb3B5KCkKICAgIHByZXZpZXcudGh1bWJuYWlsKChQ
#5#UkVWSUVXX0xPTkdfU0lERSwgUFJFVklFV19MT05HX1NJREUpLCBJbWFnZS5SZXNhbXBsaW5nLkxB
#5#TkNaT1MpCiAgICBwcmV2aWV3LnNhdmUob3V0X2RpciAvICJwcmV2aWV3LndlYnAiLCAiV0VCUCIs
#5#IHF1YWxpdHk9UFJFVklFV19RVUFMSVRZLCBtZXRob2Q9NikKCiAgICBfd3JpdGVfc3F1YXJlX3Ro
#5#dW1ibmFpbChuYXRpdmUsIG91dF9kaXIgLyAidGh1bWJuYWlsLndlYnAiKQogICAgcmV0dXJuIHsi
#5#bmF0aXZlIjogImltYWdlLndlYnAiLCAid2lkdGgiOiBuYXRpdmUud2lkdGgsICJoZWlnaHQiOiBu
#5#YXRpdmUuaGVpZ2h0LAogICAgICAgICAgICAicHJldmlldyI6ICJwcmV2aWV3LndlYnAiLCAicHJl
#5#dmlld1dpZHRoIjogcHJldmlldy53aWR0aCwKICAgICAgICAgICAgInByZXZpZXdIZWlnaHQiOiBw
#5#cmV2aWV3LmhlaWdodH0KCgpkZWYgX3dyaXRlX3NxdWFyZV90aHVtYm5haWwoaW1nOiBJbWFnZS5J
#5#bWFnZSwgcGF0aDogUGF0aCkgLT4gTm9uZToKICAgIHNjYWxlZCA9IGltZy5jb3B5KCkKICAgIHNj
#5#YWxlZC50aHVtYm5haWwoKFRIVU1CX1NJWkUsIFRIVU1CX1NJWkUpLCBJbWFnZS5SZXNhbXBsaW5n
#5#LkxBTkNaT1MpCiAgICBjYW52YXMgPSBJbWFnZS5uZXcoIlJHQiIsIChUSFVNQl9TSVpFLCBUSFVN
#5#Ql9TSVpFKSwgVEhVTUJfQkFDS0dST1VORCkKICAgIGNhbnZhcy5wYXN0ZShzY2FsZWQsICgoVEhV
#5#TUJfU0laRSAtIHNjYWxlZC53aWR0aCkgLy8gMiwgKFRIVU1CX1NJWkUgLSBzY2FsZWQuaGVpZ2h0
#5#KSAvLyAyKSkKICAgIGNhbnZhcy5zYXZlKHBhdGgsICJXRUJQIiwgcXVhbGl0eT04OCwgbWV0aG9k
#5#PTYpCgoKZGVmIGJ1aWxkX21ldGFkYXRhKGZvbGRlcjogc3RyLCBwYXJzZWQ6IGRpY3QsIGltYWdl
#5#OiBkaWN0LCBweF91bSwgY2FsX3N0YXR1czogc3RyLAogICAgICAgICAgICAgICAgICAgYWNxdWlz
#5#aXRpb246IGRpY3QsIHNvdXJjZTogUGF0aCwgc3RhaW5pbmc6IHN0cikgLT4gZGljdDoKICAgIG5v
#5#dyA9IGRhdGV0aW1lLm5vdygpLmlzb2Zvcm1hdCgpCiAgICB3LCBoID0gaW1hZ2VbIndpZHRoIl0s
#5#IGltYWdlWyJoZWlnaHQiXQogICAgcHhfeCwgcHhfeSA9IHB4X3VtIGlmIHB4X3VtIGVsc2UgKE5v
#5#bmUsIE5vbmUpCiAgICBwaHlzaWNhbCA9ICh7IngiOiByb3VuZCh3ICogcHhfeCwgMyksICJ5Ijog
#5#cm91bmQoaCAqIHB4X3ksIDMpfSBpZiBweF91bSBlbHNlIE5vbmUpCiAgICBzdGFnZV90eHQgPSBw
#5#YXJzZWRbInN0YWdlIl0gb3IgIlVua25vd24iCiAgICByZXR1cm4gewogICAgICAgICJpZCI6IGYi
#5#e0RBVEFTRVRfVFlQRX0ve2ZvbGRlcn0iLCAibmFtZSI6IGZvbGRlciwgInR5cGUiOiBEQVRBU0VU
#5#X1RZUEUsCiAgICAgICAgInN0YWdlIjogc3RhZ2VfdHh0LCAic3RhZ2VOdW1lcmljIjogcGFyc2Vk
#5#WyJzdGFnZU51bWVyaWMiXSBvciAwLjAsCiAgICAgICAgImVtYnJ5byI6IE5vbmUsICJsaW5lIjog
#5#cGFyc2VkLmdldCgibGluZSIpLCAic3RhaW5pbmciOiBzdGFpbmluZyBvciAiIiwKICAgICAgICAi
#5#ZGF0ZSI6IHBhcnNlZC5nZXQoImRpc3NlY3Rpb25EYXRlIiksCiAgICAgICAgImRpbWVuc2lvbnMi
#5#OiB7IngiOiB3LCAieSI6IGgsICJ6IjogMSwgImMiOiAzLCAidCI6IDF9LAogICAgICAgICJwaXhl
#5#bFNpemVVbSI6ICh7IngiOiByb3VuZChweF94LCA2KSwgInkiOiByb3VuZChweF95LCA2KX0gaWYg
#5#cHhfdW0gZWxzZSBOb25lKSwKICAgICAgICAicGh5c2ljYWxTaXplVW0iOiBwaHlzaWNhbCwKICAg
#5#ICAgICAiY2FsaWJyYXRpb25TdGF0dXMiOiBjYWxfc3RhdHVzLAogICAgICAgICJjYWxpYnJhdGlv
#5#bk5vdGUiOiAoIlBpeGVsIHNpemUgcmVhZCBmcm9tIHRoZSBJbWFnZUogcmVzb2x1dGlvbiB0YWdz
#5#IChtaWNyb25zKS4iCiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiBjYWxfc3RhdHVzID09
#5#ICJleGFjdCIgZWxzZQogICAgICAgICAgICAgICAgICAgICAgICAgICAgIk5vIGNhbGlicmF0ZWQg
#5#cmVzb2x1dGlvbiBpbiB0aGUgZmlsZSDigJQgc2NhbGUgYmFyIGFuZCBtZWFzdXJlbWVudHMgdW5h
#5#dmFpbGFibGUuIiksCiAgICAgICAgImltYWdlIjogaW1hZ2UsCiAgICAgICAgImFjcXVpc2l0aW9u
#5#IjogeyJtb2RhbGl0eSI6ICJicmlnaHRmaWVsZC1zdGVyZW8iLCAic291cmNlRmlsZSI6IHNvdXJj
#5#ZS5uYW1lLAogICAgICAgICAgICAgICAgICAgICAgICAibGlmRmlsZSI6IHBhcnNlZC5nZXQoImxp
#5#ZiIpLCAic2VyaWVzIjogcGFyc2VkLmdldCgic2VyaWVzIiksCiAgICAgICAgICAgICAgICAgICAg
#5#ICAgICJkaXNzZWN0aW9uRGF0ZSI6IHBhcnNlZC5nZXQoImRpc3NlY3Rpb25EYXRlIiksCiAgICAg
#5#ICAgICAgICAgICAgICAgICAgICJ6b29tTm9taW5hbCI6IHBhcnNlZC5nZXQoInpvb20iKSwgKiph
#5#Y3F1aXNpdGlvbn0sCiAgICAgICAgImNoYW5uZWxzIjogW10sCiAgICAgICAgImRlc2NyaXB0aW9u
#5#IjogX2Rlc2NyaXB0aW9uKHN0YWdlX3R4dCwgcGFyc2VkLCBhY3F1aXNpdGlvbiksCiAgICAgICAg
#5#ImNyZWF0ZWQiOiBub3csICJsYXN0TW9kaWZpZWQiOiBub3csICJjb25maWd1cmVkIjogVHJ1ZSwK
#5#ICAgICAgICAiZm9sZGVyTmFtZSI6IGZvbGRlciwKICAgICAgICAidGh1bWJuYWlsIjogZiJEQVRB
#5#X1dFQi97REFUQVNFVF9UWVBFfS97Zm9sZGVyfS90aHVtYm5haWwud2VicCIsCiAgICAgICAgImhp
#5#ZGRlbiI6IEZhbHNlLAogICAgfQoKCmRlZiBfZGVzY3JpcHRpb24oc3RhZ2U6IHN0ciwgcGFyc2Vk
#5#OiBkaWN0LCBhY3E6IGRpY3QpIC0+IHN0cjoKICAgIGJpdHMgPSBbZiJDb2xvdXIgcGhvdG9ncmFw
#5#aCwge3N0YWdlfSBlbWJyeW8iXQogICAgaWYgcGFyc2VkLmdldCgibGluZSIpOgogICAgICAgIGJp
#5#dHMuYXBwZW5kKHBhcnNlZFsibGluZSJdKQogICAgaWYgYWNxLmdldCgibWljcm9zY29wZSIpOgog
#5#ICAgICAgIGJpdHMuYXBwZW5kKGYie2FjcVsnbWljcm9zY29wZSddfSBzdGVyZW9taWNyb3Njb3Bl
#5#IikKICAgIGlmIHBhcnNlZC5nZXQoInpvb20iKToKICAgICAgICBiaXRzLmFwcGVuZChmInpvb20g
#5#eHtwYXJzZWRbJ3pvb20nXTpnfSIpCiAgICByZXR1cm4gIiwgIi5qb2luKGJpdHMpICsgIi4iCgoK
#5#ZGVmIHdyaXRlX2Rvd25sb2FkKHNvdXJjZTogUGF0aCwgb3V0X2RpcjogUGF0aCwgbWV0YTogZGlj
#5#dCwgbG9zc2xlc3M6IGJvb2wgPSBGYWxzZSkgLT4gTm9uZToKICAgIGRsID0gb3V0X2RpciAvICJk
#5#b3dubG9hZCIKICAgIGRsLm1rZGlyKGV4aXN0X29rPVRydWUpCiAgICB0YXJnZXQgPSBkbCAvIHNv
#5#dXJjZS5uYW1lCiAgICBpZiB0YXJnZXQuZXhpc3RzKCk6CiAgICAgICAgdGFyZ2V0LnVubGluaygp
#5#CiAgICB0cnk6CiAgICAgICAgb3MubGluayhzb3VyY2UsIHRhcmdldCkKICAgIGV4Y2VwdCBPU0Vy
#5#cm9yOgogICAgICAgIHNodXRpbC5jb3B5Mihzb3VyY2UsIHRhcmdldCkKICAgIChkbCAvICJSRUFE
#5#TUUudHh0Iikud3JpdGVfdGV4dChfcmVhZG1lKHNvdXJjZSwgbWV0YSwgbG9zc2xlc3MpLCBlbmNv
#5#ZGluZz0idXRmLTgiKQoKCmRlZiBfcmVhZG1lKHNvdXJjZTogUGF0aCwgbWV0YTogZGljdCwgbG9z
#5#c2xlc3M6IGJvb2wgPSBGYWxzZSkgLT4gc3RyOgogICAgYWNxID0gbWV0YVsiYWNxdWlzaXRpb24i
#5#XQogICAgcHggPSBtZXRhLmdldCgicGl4ZWxTaXplVW0iKQogICAgbGluZXMgPSBbCiAgICAgICAg
#5#ZiJ7bWV0YVsnbmFtZSddfSIsCiAgICAgICAgIj0iICogbGVuKG1ldGFbIm5hbWUiXSksCiAgICAg
#5#ICAgIiIsCiAgICAgICAgZiJUeXBlICAgICAgICA6IDJEIHBob3RvZ3JhcGggKHthY3EuZ2V0KCdt
#5#b2RhbGl0eScpfSkiLAogICAgICAgIGYiU3RhZ2UgICAgICAgOiB7bWV0YVsnc3RhZ2UnXX0iLAog
#5#ICAgICAgIGYiTGluZSAgICAgICAgOiB7bWV0YS5nZXQoJ2xpbmUnKSBvciAnLSd9IiwKICAgICAg
#5#ICBmIlN0YWluaW5nICAgIDoge21ldGEuZ2V0KCdzdGFpbmluZycpIG9yICctJ30iLAogICAgICAg
#5#IGYiSW1hZ2UgICAgICAgOiB7bWV0YVsnZGltZW5zaW9ucyddWyd4J119IHgge21ldGFbJ2RpbWVu
#5#c2lvbnMnXVsneSddfSBweCwgUkdCIDgtYml0IiwKICAgICAgICBmIlBpeGVsIHNpemUgIDoge3B4
#5#Wyd4J106LjRmfSB1bS9weCIgaWYgcHggZWxzZSAiUGl4ZWwgc2l6ZSAgOiB1bmtub3duIiwKICAg
#5#ICAgICBmIlNvdXJjZSAgICAgIDoge3NvdXJjZS5uYW1lfSIsCiAgICAgICAgZiJMSUYgZmlsZSAg
#5#ICA6IHthY3EuZ2V0KCdsaWZGaWxlJykgb3IgJy0nfSAgKHNlcmllcyB7YWNxLmdldCgnc2VyaWVz
#5#Jykgb3IgJy0nfSkiLAogICAgICAgIGYiTWljcm9zY29wZSAgOiB7YWNxLmdldCgnbWljcm9zY29w
#5#ZScpIG9yICctJ30gIGNhbWVyYSB7YWNxLmdldCgnY2FtZXJhJykgb3IgJy0nfSIsCiAgICAgICAg
#5#ZiJab29tICAgICAgICA6IHthY3EuZ2V0KCd6b29tJykgb3IgYWNxLmdldCgnem9vbU5vbWluYWwn
#5#KSBvciAnLSd9IiwKICAgICAgICBmIkV4cG9zdXJlICAgIDoge2FjcS5nZXQoJ2V4cG9zdXJlTXMn
#5#KSBvciAnLSd9IG1zLCBnYWluIHthY3EuZ2V0KCdnYWluJykgb3IgJy0nfSIsCiAgICAgICAgZiJE
#5#aXNzZWN0aW9uICA6IHthY3EuZ2V0KCdkaXNzZWN0aW9uRGF0ZScpIG9yICctJ30iLAogICAgICAg
#5#ICIiLAogICAgICAgICJUaGUgVElGRiBpcyB0aGUgdW50b3VjaGVkIEltYWdlSiBleHBvcnQ7IGlt
#5#YWdlLndlYnAgYmVzaWRlIGl0IGlzIHRoZSIsCiAgICAgICAgImRpc3BsYXkgY29weSB1c2VkIGJ5
#5#IHRoZSB2aWV3ZXIiCiAgICAgICAgKyAoIiAobG9zc2xlc3MpLiIgaWYgbG9zc2xlc3MgZWxzZSAi
#5#IChsb3NzeSwgcXVhbGl0eSA5MCkuIiksCiAgICBdCiAgICByZXR1cm4gIlxuIi5qb2luKGxpbmVz
#5#KSArICJcbiIKCgojIOKUgOKUgCBPcmNoZXN0cmF0aW9uIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgApkZWYgaW1w
#5#b3J0X3RpZmYoc291cmNlOiBQYXRoLCBvdXRwdXRfcm9vdDogUGF0aCwgYXJncywgY2xhaW1lZDog
#5#ZGljdCA9IE5vbmUpIC0+IFBhdGg6CiAgICB3aXRoIEltYWdlLm9wZW4oc291cmNlKSBhcyBpbToK
#5#ICAgICAgICBpaiA9IHJlYWRfaWpfbWV0YWRhdGEoaW0pCiAgICAgICAgZGVzY3JpcHRpb24gPSBz
#5#dHIoaW0udGFnX3YyLmdldChJTUFHRV9ERVNDUklQVElPTl9UQUcsICIiKSkKICAgICAgICBweF91
#5#bSwgY2FsX3N0YXR1cyA9IHBpeGVsX3NpemVfdW0oaW0sIGRlc2NyaXB0aW9uKQogICAgICAgIHJn
#5#YiA9IGNvbXBvc2VfcmdiKHJlYWRfcGxhbmVzKGltLCBkZXNjcmlwdGlvbiksIGlqLmdldCgibHV0
#5#cyIsIFtdKSkKCiAgICBwYXJzZWQgPSBwYXJzZV9maWxlbmFtZShzb3VyY2Uuc3RlbSwgYXJncy5s
#5#aW5lKQogICAgZm9sZGVyID0gZGF0YXNldF9mb2xkZXJfbmFtZShwYXJzZWQpCiAgICBvdXRfZGly
#5#ID0gb3V0cHV0X3Jvb3QgLyBEQVRBU0VUX1RZUEUgLyBmb2xkZXIKICAgIG1ldGFfcGF0aCA9IG91
#5#dF9kaXIgLyAibWV0YWRhdGEuanNvbiIKCiAgICAjIFR3byBkaWZmZXJlbnQgVElGRnMgY2FuIGRl
#5#c2NyaWJlIHRoZW1zZWx2ZXMgaWRlbnRpY2FsbHkgKHNhbWUgbGluZSwgc3RhZ2UsIHpvb20sCiAg
#5#ICAjIGRhdGUgYW5kIGluZGV4KTsgdGhlIHNlY29uZCBtdXN0IG5laXRoZXIgYmUgc2tpcHBlZCBh
#5#cyAiYWxyZWFkeSBpbXBvcnRlZCIgbm9yCiAgICAjIG92ZXJ3cml0ZSB0aGUgZmlyc3QuCiAgICBp
#5#ZiBjbGFpbWVkIGlzIG5vdCBOb25lOgogICAgICAgIGtleSA9IGZvbGRlci5jYXNlZm9sZCgpCiAg
#5#ICAgICAgaWYga2V5IGluIGNsYWltZWQgYW5kIGNsYWltZWRba2V5XSAhPSBzb3VyY2U6CiAgICAg
#5#ICAgICAgIHJhaXNlIFZhbHVlRXJyb3IoZiJzYW1lIGRhdGFzZXQgZm9sZGVyIHtmb2xkZXJ9IGFz
#5#IHtjbGFpbWVkW2tleV0ubmFtZX0g4oCUICIKICAgICAgICAgICAgICAgICAgICAgICAgICAgICBm
#5#InJlbmFtZSBvbmUgb2YgdGhlIHR3byBmaWxlcyIpCiAgICAgICAgY2xhaW1lZFtrZXldID0gc291
#5#cmNlCiAgICBleGlzdGluZyA9IF9sb2FkX2pzb24obWV0YV9wYXRoKSBpZiBtZXRhX3BhdGguZXhp
#5#c3RzKCkgZWxzZSB7fQogICAgcHJldmlvdXNfc291cmNlID0gKGV4aXN0aW5nLmdldCgiYWNxdWlz
#5#aXRpb24iKSBvciB7fSkuZ2V0KCJzb3VyY2VGaWxlIikKICAgIGlmIHByZXZpb3VzX3NvdXJjZSBh
#5#bmQgcHJldmlvdXNfc291cmNlICE9IHNvdXJjZS5uYW1lOgogICAgICAgIHJhaXNlIFZhbHVlRXJy
#5#b3IoZiJ7Zm9sZGVyfSBhbHJlYWR5IGhvbGRzIHtwcmV2aW91c19zb3VyY2V9LCBhIGRpZmZlcmVu
#5#dCBmaWxlIOKAlCAiCiAgICAgICAgICAgICAgICAgICAgICAgICBmInJlbmFtZSBvbmUgb2YgdGhl
#5#IHR3byBmaWxlcyIpCiAgICBpZiBtZXRhX3BhdGguZXhpc3RzKCkgYW5kIG5vdCBhcmdzLmZvcmNl
#5#OgogICAgICAgIHByaW50KGYiICBbc2tpcF0ge2ZvbGRlcn0gZXhpc3RzICh1c2UgLS1mb3JjZSB0
#5#byByZS1pbXBvcnQpIikKICAgICAgICByZXR1cm4gb3V0X2RpcgogICAgb3V0X2Rpci5ta2Rpcihw
#5#YXJlbnRzPVRydWUsIGV4aXN0X29rPVRydWUpCgogICAgbG9zc2xlc3MgPSBib29sKGdldGF0dHIo
#5#YXJncywgImxvc3NsZXNzIiwgRmFsc2UpKQogICAgaW1hZ2UgPSB3cml0ZV9pbWFnZXMocmdiLCBv
#5#dXRfZGlyLCBsb3NzbGVzcz1sb3NzbGVzcykKICAgIGluZm8gPSAoaWouZ2V0KCJpbmZvIikgb3Ig
#5#WyIiXSlbMF0KICAgIHNlcmllcyA9IF9zZXJpZXNfbmFtZShpaiwgcGFyc2VkKQogICAgYWNxdWlz
#5#aXRpb24gPSBsZWljYV9maWVsZHMoaW5mbywgc2VyaWVzKSBpZiBzZXJpZXMgZWxzZSB7fQogICAg
#5#ZnJlc2ggPSBidWlsZF9tZXRhZGF0YShmb2xkZXIsIHBhcnNlZCwgaW1hZ2UsIHB4X3VtLCBjYWxf
#5#c3RhdHVzLCBhY3F1aXNpdGlvbiwgc291cmNlLCBhcmdzLnN0YWluaW5nKQogICAgbWV0YSA9IG1l
#5#cmdlX2N1cmF0ZWQoZXhpc3RpbmcsIGZyZXNoKQogICAgIyBtZXRhZGF0YS5qc29uIGlzIHdyaXR0
#5#ZW4gbGFzdCwgYXRvbWljYWxseTogYSBoYWxmIGltcG9ydCBpcyBuZXZlciBtb3VudGVkLgogICAg
#5#YXRvbWljX3dyaXRlX3RleHQobWV0YV9wYXRoLCBqc29uLmR1bXBzKG1ldGEsIGluZGVudD0yLCBl
#5#bnN1cmVfYXNjaWk9RmFsc2UpKQogICAgaWYgYXJncy53aXRoX2Rvd25sb2FkczoKICAgICAgICB3
#5#cml0ZV9kb3dubG9hZChzb3VyY2UsIG91dF9kaXIsIG1ldGEsIGxvc3NsZXNzKQoKICAgIGlmIG5v
#5#dCBweF91bToKICAgICAgICBweF90eHQgPSAidW5jYWxpYnJhdGVkIgogICAgZWxpZiBweF91bVsw
#5#XSA9PSBweF91bVsxXToKICAgICAgICBweF90eHQgPSBmIntweF91bVswXTouM2Z9IHVtL3B4Igog
#5#ICAgZWxzZToKICAgICAgICBweF90eHQgPSBmIntweF91bVswXTouM2Z9IHgge3B4X3VtWzFdOi4z
#5#Zn0gdW0vcHgiCiAgICBwcmludChmIiAgW29rXSB7Zm9sZGVyfSAge2ltYWdlWyd3aWR0aCddfXh7
#5#aW1hZ2VbJ2hlaWdodCddfSAge21ldGFbJ3N0YWdlJ119ICB7cHhfdHh0fSIpCiAgICByZXR1cm4g
#5#b3V0X2RpcgoKCmRlZiBfc2VyaWVzX25hbWUoaWo6IGRpY3QsIHBhcnNlZDogZGljdCkgLT4gc3Ry
#5#OgogICAgIiIiSW1hZ2VKIGxhYmVscyBlYWNoIHBsYW5lIGBjOjEvMyAtIDxzZXJpZXM+YDsgdGhl
#5#IExlaWNhIGJsb2NrIGlzIGtleWVkIGJ5CiAgICB0aGF0IHNlcmllcyBuYW1lLCB3aGljaCBpcyBh
#5#bHNvIHRoZSBvbmUgdGhlIGxhYiBtYXkgaGF2ZSByZW5hbWVkIGluIExBUyBYLiIiIgogICAgbGFi
#5#ZWxzID0gaWouZ2V0KCJsYWJsIikgb3IgW10KICAgIGlmIGxhYmVscyBhbmQgIiAtICIgaW4gbGFi
#5#ZWxzWzBdOgogICAgICAgIHJldHVybiBsYWJlbHNbMF0uc3BsaXQoIiAtICIsIDEpWzFdLnN0cmlw
#5#KCkKICAgIHJldHVybiBwYXJzZWQuZ2V0KCJzZXJpZXMiKSBvciAiIgoKCmRlZiBfbG9hZF9qc29u
#5#KHBhdGg6IFBhdGgpIC0+IGRpY3Q6CiAgICB0cnk6CiAgICAgICAgcmV0dXJuIGpzb24ubG9hZHMo
#5#cGF0aC5yZWFkX3RleHQoZW5jb2Rpbmc9InV0Zi04IikpCiAgICBleGNlcHQgKE9TRXJyb3IsIFZh
#5#bHVlRXJyb3IpOgogICAgICAgIHJldHVybiB7fQoKCmRlZiBjb2xsZWN0X2lucHV0cyhpbnB1dF9w
#5#YXRoOiBQYXRoLCBvbmx5OiBzdHIpIC0+IGxpc3Q6CiAgICBpZiBpbnB1dF9wYXRoLmlzX2ZpbGUo
#5#KToKICAgICAgICBmaWxlcyA9IFtpbnB1dF9wYXRoXQogICAgZWxzZToKICAgICAgICBmaWxlcyA9
#5#IHNvcnRlZChwIGZvciBwIGluIGlucHV0X3BhdGguaXRlcmRpcigpCiAgICAgICAgICAgICAgICAg
#5#ICAgICAgaWYgcC5zdWZmaXgubG93ZXIoKSBpbiAoIi50aWYiLCAiLnRpZmYiKSBhbmQgcC5pc19m
#5#aWxlKCkpCiAgICBpZiBvbmx5OgogICAgICAgIGZpbGVzID0gW2YgZm9yIGYgaW4gZmlsZXMgaWYg
#5#Zm5tYXRjaC5mbm1hdGNoKGYubmFtZSwgb25seSldCiAgICByZXR1cm4gZmlsZXMKCgpkZWYgbWFp
#5#bigpIC0+IGludDoKICAgIGFwID0gYXJncGFyc2UuQXJndW1lbnRQYXJzZXIoZGVzY3JpcHRpb249
#5#IjJEIHBob3RvZ3JhcGggaW1wb3J0ZXIgKG9uZSBUSUZGIOKGkiBvbmUgZGF0YXNldCkiKQogICAg
#5#YXAuYWRkX2FyZ3VtZW50KCItLWlucHV0IiwgcmVxdWlyZWQ9VHJ1ZSwgaGVscD0iRGlyZWN0b3J5
#5#IG9mIFRJRkZzLCBvciBvbmUgVElGRi4iKQogICAgYXAuYWRkX2FyZ3VtZW50KCItLW91dHB1dCIs
#5#IHJlcXVpcmVkPVRydWUsIGhlbHA9IkRBVEFfV0VCIGRpcmVjdG9yeSBvZiB0aGUgd2ViIHBsYXRm
#5#b3JtLiIpCiAgICBhcC5hZGRfYXJndW1lbnQoIi0tb25seSIsIGRlZmF1bHQ9Tm9uZSwgaGVscD0i
#5#R2xvYiBvbiB0aGUgZmlsZSBuYW1lIChlLmcuICcqRTguMConKS4iKQogICAgYXAuYWRkX2FyZ3Vt
#5#ZW50KCItLWxpbmUiLCBkZWZhdWx0PU5vbmUsIGhlbHA9IlJlcG9ydGVyL3N0cmFpbiBsaW5lIGxh
#5#YmVsIChkZWZhdWx0OiBwYXJzZWQgZnJvbSB0aGUgLmxpZiBuYW1lKS4iKQogICAgYXAuYWRkX2Fy
#5#Z3VtZW50KCItLXN0YWluaW5nIiwgZGVmYXVsdD0iIiwgaGVscD0iU3RhaW5pbmcgbGFiZWwgc3Rv
#5#cmVkIGluIG1ldGFkYXRhIChlLmcuIFgtZ2FsKS4iKQogICAgYXAuYWRkX2FyZ3VtZW50KCItLXdp
#5#dGgtZG93bmxvYWRzIiwgYWN0aW9uPSJzdG9yZV90cnVlIiwgaGVscD0iUGxhY2UgdGhlIG9yaWdp
#5#bmFsIFRJRkYgKyBSRUFETUUgdW5kZXIgZG93bmxvYWQvLiIpCiAgICBhcC5hZGRfYXJndW1lbnQo
#5#Ii0tZm9yY2UiLCBhY3Rpb249InN0b3JlX3RydWUiLCBoZWxwPSJSZS1pbXBvcnQgb3ZlciBhbiBl
#5#eGlzdGluZyBkYXRhc2V0IChjdXJhdGlvbiBpcyBwcmVzZXJ2ZWQpLiIpCiAgICBhcC5hZGRfYXJn
#5#dW1lbnQoIi0tbG9zc2xlc3MiLCBhY3Rpb249InN0b3JlX3RydWUiLAogICAgICAgICAgICAgICAg
#5#ICAgIGhlbHA9IlN0b3JlIHRoZSBuYXRpdmUgaW1hZ2UgbG9zc2xlc3NseSAobGFyZ2VyOyBrZWVw
#5#cyB0aGUgY29sb3VyIHJhdGlvcyAiCiAgICAgICAgICAgICAgICAgICAgICAgICAidGhlIHN0YWlu
#5#IGlzb2xhdGlvbiBtZWFzdXJlcyBleGFjdCBhdCBldmVyeSBwaXhlbCkuIikKICAgIGFyZ3MgPSBh
#5#cC5wYXJzZV9hcmdzKCkKCiAgICBmaWxlcyA9IGNvbGxlY3RfaW5wdXRzKFBhdGgoYXJncy5pbnB1
#5#dCksIGFyZ3Mub25seSkKICAgIGlmIG5vdCBmaWxlczoKICAgICAgICBwcmludCgiWzJkXSBubyBU
#5#SUZGIG1hdGNoZWQuIikKICAgICAgICByZXR1cm4gMQogICAgcHJpbnQoZiJbMmRdIGltcG9ydGVy
#5#IHZ7X192ZXJzaW9uX199IC0ge2xlbihmaWxlcyl9IGZpbGUocykgLT4ge1BhdGgoYXJncy5vdXRw
#5#dXQpIC8gREFUQVNFVF9UWVBFfSIpCiAgICBmYWlsdXJlcyA9IDAKICAgIGNsYWltZWQgPSB7fQog
#5#ICAgZm9yIHNvdXJjZSBpbiBmaWxlczoKICAgICAgICB0cnk6CiAgICAgICAgICAgIGltcG9ydF90
#5#aWZmKHNvdXJjZSwgUGF0aChhcmdzLm91dHB1dCksIGFyZ3MsIGNsYWltZWQpCiAgICAgICAgZXhj
#5#ZXB0IEV4Y2VwdGlvbiBhcyBleGM6ICAjIG9uZSBiYWQgZXhwb3J0IG11c3Qgbm90IHN0b3AgdGhl
#5#IGJhdGNoCiAgICAgICAgICAgIGZhaWx1cmVzICs9IDEKICAgICAgICAgICAgcHJpbnQoZiIgIFtm
#5#YWlsXSB7c291cmNlLm5hbWV9OiB7ZXhjfSIpCiAgICBwcmludChmIlsyZF0gZG9uZSAtIHtsZW4o
#5#ZmlsZXMpIC0gZmFpbHVyZXN9IGltcG9ydGVkLCB7ZmFpbHVyZXN9IGZhaWxlZC4iKQogICAgcmV0
#5#dXJuIDEgaWYgZmFpbHVyZXMgZWxzZSAwCgoKaWYgX19uYW1lX18gPT0gIl9fbWFpbl9fIjoKICAg
#5#IHN5cy5leGl0KG1haW4oKSkK
:: ---- [6] 5-tracking_importer.py (22830 octets) ----
#6#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwoiIiJBdHRhY2ggYW4gSW1hcmlzIGNlbGwtdHJhY2tpbmcg
#6#YW5hbHlzaXMgdG8gYSBwcmVwcm9jZXNzZWQgdm9sdW1lIGRhdGFzZXQuCgpBY2NlcHRzIHRoZSBh
#6#bmFseXNpcyBpbiBhbnkgb2YgdGhlIHRocmVlIHNoYXBlcyBpdCBleGlzdHMgaW4g4oCUIGEgYC5p
#6#bWFyaXNfdHJhY2tgIGNvbnRhaW5lcgooZ3ppcCArIEpTT04sIHNpZ25hdHVyZSBJTUFSSVNfVFJB
#6#Q0tFUl9WMSkgcHJvZHVjZWQgYnkgdGhlIGxhYidzIEltYXJpcyBhbmFseXNpcyBzY3JpcHRzLAp0
#6#aGUgYC5pbXNgIHZvbHVtZSBpdHNlbGYgKGl0cyBTY2VuZTggU3BvdHMvVHJhY2tzIG9iamVjdHMp
#6#LCBvciB0aGUgYC54bHNgL2AueGxzeGAgc3RhdGlzdGljcwp3b3JrYm9vayBleHBvcnRlZCBmcm9t
#6#IEltYXJpczsgdGhlIGxhc3QgdHdvIGFyZSBub3JtYWxpc2VkIGJ5IGB0cmFja2luZ19zb3VyY2Vz
#6#LnB5YC4gV3JpdGVzLAppbnRvIHRoZSBkYXRhc2V0IGRpcmVjdG9yeToKCiAgICB0cmFja3MuanNv
#6#blsuZ3pdICAgdHJhamVjdG9yaWVzIGluIHRoZSBzY2hlbWEgdGhlIHZpZXdlciBjb25zdW1lcwog
#6#ICAgbW9kZWwuZ2xiICAgICAgICAgIHRoZSBwcmUtYmFrZWQgcG9wdWxhdGlvbiBzdXJmYWNlcywg
#6#aWYgb25lIHdhcyBleHBvcnRlZAoKYW5kIGluamVjdHMgaW50byBgbWV0YWRhdGEuanNvbmAgYSBg
#6#cmVnaXN0cmF0aW9uYCBibG9jayBob2xkaW5nIHRoZSBwZXItdGltZXBvaW50CnJpZ2lkIHRyYW5z
#6#Zm9ybSB0aGF0IG1hcHMgUkFXIGFjcXVpc2l0aW9uIGNvb3JkaW5hdGVzIG9udG8gdGhlIFNUQUJJ
#6#TElTRUQgZnJhbWUuCgpXaHkgdGhlIHRyYW5zZm9ybSBtYXR0ZXJzCi0tLS0tLS0tLS0tLS0tLS0t
#6#LS0tLS0tLS0KVGhlIHRyYWNraW5nIGlzIHN0YWJpbGlzZWQgKHRoZSBhbmFseXNpcyByZW1vdmVz
#6#IHRoZSBzcGVjaW1lbidzIGdsb2JhbCBtb3Rpb24gYnkgYQpzZXF1ZW50aWFsIEthYnNjaCBhbGln
#6#bm1lbnQpIGJ1dCB0aGUgaW1hZ2VzIGFyZSBub3QuIEJlY2F1c2UgdGhhdCBzdGFiaWxpc2F0aW9u
#6#IGlzIGEKcmlnaWQgYm9keSBtb3Rpb24sIHRoZSB2ZXJ5IHNhbWUgdHJhbnNmb3JtIHJlLWV4cHJl
#6#c3NlcyB0aGUgaW1hZ2Ugdm9sdW1lIGluIHRoZQpzdGFiaWxpc2VkIGZyYW1lIOKAlCBzbyB0aGUg
#6#dmlld2VyIGNhbiBvdmVybGF5IHRyYWNrcyBvbiBpbWFnZXMgYnkgd2FycGluZyB0aGUgc2FtcGxp
#6#bmcKY29vcmRpbmF0ZXMsIHdpdGggbm8gdm94ZWwgcmVzYW1wbGluZyBhbmQgbm8gbG9zcy4KClRo
#6#ZSB0cmFuc2Zvcm0gaXMgdGFrZW4gZnJvbSB0aGUgY29udGFpbmVyIHdoZW4gdGhlIGV4cG9ydGVy
#6#IGRlY2xhcmVkIGl0LCBhbmQgb3RoZXJ3aXNlCnJlY292ZXJlZCBieSBvcnRob2dvbmFsIFByb2Ny
#6#dXN0ZXMgb24gdGhlIHJhdy9zdGFiaWxpc2VkIHBvaW50IHBhaXJzLCB3aGljaCBpcyBleGFjdAp3
#6#aGVuZXZlciB0aGUgc3RhYmlsaXNhdGlvbiByZWFsbHkgd2FzIHJpZ2lkLiBUaGUgcmVzaWR1YWwg
#6#b2YgdGhhdCBmaXQgaXMgcmVjb3JkZWQgYW5kCnN1cmZhY2VkIGluIHRoZSBRQyBzdW1tYXJ5OiBp
#6#ZiBpdCBpcyBub3QgfjAsIHRoZSBzdGFiaWxpc2F0aW9uIHdhcyBOT1QgYSByaWdpZCBtb3Rpb24K
#6#YW5kIG11c3Qgbm90IGJlIHB1c2hlZCBvbnRvIHRoZSBpbWFnZXMuCiIiIgppbXBvcnQgYXJncGFy
#6#c2UKaW1wb3J0IGd6aXAKaW1wb3J0IGpzb24KaW1wb3J0IG1hdGgKaW1wb3J0IG9zCmltcG9ydCBz
#6#aHV0aWwKaW1wb3J0IHN5cwpmcm9tIGNvbGxlY3Rpb25zIGltcG9ydCBDb3VudGVyLCBPcmRlcmVk
#6#RGljdApmcm9tIGRhdGV0aW1lIGltcG9ydCBkYXRldGltZQpmcm9tIHBhdGhsaWIgaW1wb3J0IFBh
#6#dGgKCmltcG9ydCBudW1weSBhcyBucAoKSEVSRSA9IFBhdGgoX19maWxlX18pLnJlc29sdmUoKS5w
#6#YXJlbnQKaWYgc3RyKEhFUkUpIG5vdCBpbiBzeXMucGF0aDoKICAgIHN5cy5wYXRoLmluc2VydCgw
#6#LCBzdHIoSEVSRSkpCmZyb20gcnVuX3ByZXByb2Nlc3MgaW1wb3J0IGF0b21pY193cml0ZV9ieXRl
#6#cywgYXRvbWljX3dyaXRlX2pzb24gICMgbm9xYTogRTQwMgoKX192ZXJzaW9uX18gPSAiMC4yLjAi
#6#CgpTSUdOQVRVUkUgPSAiSU1BUklTX1RSQUNLRVJfVjEiCiMgQSBQcm9jcnVzdGVzIGZpdCByZXNp
#6#ZHVhbCB1bmRlciB0aGlzIGlzIG1hY2hpbmUgbm9pc2U6IHRoZSBzdGFiaWxpc2F0aW9uIGlzIHJp
#6#Z2lkIGFuZAojIHRoZSByZWNvdmVyZWQgbWF0cml4IGNhbiBiZSBhcHBsaWVkIHRvIHRoZSBpbWFn
#6#ZXMuIEFib3ZlIGl0LCB3ZSByZWZ1c2UgdG8gY2xhaW0gc28uClJJR0lEX1RPTEVSQU5DRV9VTSA9
#6#IDAuMDUKTUlOX0ZJVF9QT0lOVFMgPSA0CgoKZGVmIF9zaWcodmFsdWUsIGRpZ2l0cz00KToKICAg
#6#ICIiIlJvdW5kIHRvIHNpZ25pZmljYW50IGRpZ2l0czogYSByZXNpZHVhbCBvZiAxLjJlLTEyIGlz
#6#IHRoZSBoZWFkbGluZSBRQyByZXN1bHQgYW5kCiAgICBmaXhlZC1kZWNpbWFsIHJvdW5kaW5nIHdv
#6#dWxkIGZsYXR0ZW4gaXQgdG8gYSBtZWFuaW5nbGVzcyAwLjAuIiIiCiAgICBpZiB2YWx1ZSBpcyBO
#6#b25lOgogICAgICAgIHJldHVybiBOb25lCiAgICByZXR1cm4gZmxvYXQoZiJ7ZmxvYXQodmFsdWUp
#6#Oi57ZGlnaXRzfWd9IikKCgpkZWYgX2xvYWRfc291cmNlKHBhdGg6IFBhdGgpIC0+IGRpY3Q6CiAg
#6#ICAiIiJSZWFkIHRoZSB0cmFja2luZywgd2hhdGV2ZXIgc2hhcGUgdGhlIG9wZXJhdG9yIHBvaW50
#6#ZWQgdXMgYXQuCgogICAgQSBgYC5pbWFyaXNfdHJhY2tgYCBpcyBwYXJzZWQgaGVyZSBzbyB0aGUg
#6#Y29tbW9uIHBhdGggc3RheXMgZGVwZW5kZW5jeS1mcmVlOyB0aGUgcmF3CiAgICBJbWFyaXMgc2hh
#6#cGVzICguaW1zIG9iamVjdHMsIGV4cG9ydGVkIC54bHMvLnhsc3gpIGFyZSBub3JtYWxpc2VkIGJ5
#6#IHRyYWNraW5nX3NvdXJjZXMsCiAgICB3aGljaCBuZWVkcyBwYW5kYXMgYW5kIHRoZSB0cmFja2lu
#6#ZyBwaXBlbGluZSdzIG93biBhbmFseXNpcyBjb2RlLgogICAgIiIiCiAgICBpZiBwYXRoLnN1ZmZp
#6#eC5sb3dlcigpID09ICIuaW1hcmlzX3RyYWNrIjoKICAgICAgICByZXR1cm4gX3JlYWRfY29udGFp
#6#bmVyKHBhdGgpCiAgICB0cnk6CiAgICAgICAgaW1wb3J0IHRyYWNraW5nX3NvdXJjZXMKICAgIGV4
#6#Y2VwdCBJbXBvcnRFcnJvciBhcyBleGM6CiAgICAgICAgcmFpc2UgUnVudGltZUVycm9yKAogICAg
#6#ICAgICAgICBmIntwYXRoLm5hbWV9OiBsYSBsZWN0dXJlIGRlIGNlIGZvcm1hdCBkZW1hbmRlIHRy
#6#YWNraW5nX3NvdXJjZXMucHkgKHtleGN9KSIpIGZyb20gZXhjCiAgICByZXR1cm4gdHJhY2tpbmdf
#6#c291cmNlcy5sb2FkX2RvY3VtZW50KHBhdGgpCgoKZGVmIF9yZWFkX2NvbnRhaW5lcihwYXRoOiBQ
#6#YXRoKSAtPiBkaWN0OgogICAgIiIiTG9hZCB0aGUgZ3ppcCtKU09OIGNvbnRhaW5lciwgdG9sZXJh
#6#dGluZyB0aGUgb3B0aW9uYWwgdGV4dCBzaWduYXR1cmUgbGluZS4iIiIKICAgIHdpdGggZ3ppcC5v
#6#cGVuKHBhdGgsICJyYiIpIGFzIGZoOgogICAgICAgIGJsb2IgPSBmaC5yZWFkKCkKICAgIGhlYWQg
#6#PSBibG9iWzo2NF0KICAgIGlmIGhlYWQuc3RhcnRzd2l0aChTSUdOQVRVUkUuZW5jb2RlKCkpOgog
#6#ICAgICAgIG5sID0gYmxvYi5pbmRleChiIlxuIikKICAgICAgICBibG9iID0gYmxvYltubCArIDE6
#6#XQogICAgZG9jID0ganNvbi5sb2FkcyhibG9iLmRlY29kZSgidXRmLTgiKSkKICAgIGlmIGRvYy5n
#6#ZXQoInNpZ25hdHVyZSIpICE9IFNJR05BVFVSRToKICAgICAgICByYWlzZSBWYWx1ZUVycm9yKGYi
#6#e3BhdGgubmFtZX06IG5vdCBhbiB7U0lHTkFUVVJFfSBjb250YWluZXIgIgogICAgICAgICAgICAg
#6#ICAgICAgICAgICAgZiIoc2lnbmF0dXJlPXtkb2MuZ2V0KCdzaWduYXR1cmUnKSFyfSkiKQogICAg
#6#aWYgbm90IGlzaW5zdGFuY2UoZG9jLmdldCgiZGF0YSIpLCBkaWN0KToKICAgICAgICByYWlzZSBW
#6#YWx1ZUVycm9yKGYie3BhdGgubmFtZX06IG1pc3NpbmcgJ2RhdGEnIG9iamVjdCIpCiAgICByZXR1
#6#cm4gZG9jCgoKZGVmIF9wcm9jcnVzdGVzKEE6IG5wLm5kYXJyYXksIEI6IG5wLm5kYXJyYXkpOgog
#6#ICAgIiIiTGVhc3Qtc3F1YXJlcyByb3RhdGlvbit0cmFuc2xhdGlvbiB3aXRoIEIgfj0gQSBAIFIu
#6#VCArIGIsIGRldChSKSA9ICsxLiIiIgogICAgY2EsIGNiID0gQS5tZWFuKDApLCBCLm1lYW4oMCkK
#6#ICAgIFUsIF8sIFZ0ID0gbnAubGluYWxnLnN2ZCgoQSAtIGNhKS5UIEAgKEIgLSBjYikpCiAgICBE
#6#ID0gbnAuZGlhZyhbMS4wLCAxLjAsIGZsb2F0KG5wLnNpZ24obnAubGluYWxnLmRldChWdC5UIEAg
#6#VS5UKSkpXSkKICAgIFIgPSBWdC5UIEAgRCBAIFUuVAogICAgcmV0dXJuIFIsIGNiIC0gUiBAIGNh
#6#CgoKZGVmIF9tYXRyaXhfY29sdW1uX21ham9yKFI6IG5wLm5kYXJyYXksIGI6IG5wLm5kYXJyYXkp
#6#OgogICAgIiIiVEhSRUUuTWF0cml4NC5mcm9tQXJyYXkoKSBjb25zdW1lcyBjb2x1bW4tbWFqb3Ig
#6#b3JkZXIuIiIiCiAgICBtID0gbnAuZXllKDQpCiAgICBtWzozLCA6M10gPSBSCiAgICBtWzozLCAz
#6#XSA9IGIKICAgIHJldHVybiBbcm91bmQoZmxvYXQodiksIDkpIGZvciB2IGluIG0uVC5yZXNoYXBl
#6#KC0xKV0KCgpkZWYgX3JvdGF0aW9uX2RlZ3JlZXMoUjogbnAubmRhcnJheSkgLT4gZmxvYXQ6CiAg
#6#ICByZXR1cm4gZmxvYXQobnAuZGVncmVlcyhucC5hcmNjb3MobnAuY2xpcCgobnAudHJhY2UoUikg
#6#LSAxLjApIC8gMi4wLCAtMS4wLCAxLjApKSkpCgoKZGVmIF92YWxpZGF0ZV9jZWxscyhjZWxscykg
#6#LT4gTm9uZToKICAgICIiIlJlamVjdCBhIG1hbGZvcm1lZCBjb250YWluZXIgb3V0cmlnaHQgcmF0
#6#aGVyIHRoYW4gbW91bnQgaXQgaGFsZi13YXkuIiIiCiAgICBpZiBub3QgaXNpbnN0YW5jZShjZWxs
#6#cywgbGlzdCkgb3Igbm90IGNlbGxzOgogICAgICAgIHJhaXNlIFZhbHVlRXJyb3IoImRhdGEuY2Vs
#6#bHMgbXVzdCBiZSBhIG5vbi1lbXB0eSBhcnJheSIpCiAgICBmb3IgaSwgYyBpbiBlbnVtZXJhdGUo
#6#Y2VsbHMpOgogICAgICAgIGZvciBrZXkgaW4gKCJpZCIsICJ0IiwgIngiLCAieSIsICJ6Iik6CiAg
#6#ICAgICAgICAgIGlmIGtleSBub3QgaW4gYzoKICAgICAgICAgICAgICAgIHJhaXNlIFZhbHVlRXJy
#6#b3IoZiJjZWxsICN7aX06IG1pc3NpbmcgcmVxdWlyZWQgZmllbGQgJ3trZXl9JyIpCiAgICAgICAg
#6#biA9IGxlbihjWyJ0Il0pCiAgICAgICAgZm9yIGtleSBpbiAoIngiLCAieSIsICJ6Iik6CiAgICAg
#6#ICAgICAgIGlmIGxlbihjW2tleV0pICE9IG46CiAgICAgICAgICAgICAgICByYWlzZSBWYWx1ZUVy
#6#cm9yKGYiY2VsbCAje2l9IChpZD17Y1snaWQnXX0pOiAne2tleX0nIGhhcyB7bGVuKGNba2V5XSl9
#6#ICIKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZiJ2YWx1ZXMgZm9yIHtufSB0aW1l
#6#cG9pbnRzIikKICAgICAgICBmb3Iga2V5IGluICgieF9yYXciLCAieV9yYXciLCAiel9yYXciKToK
#6#ICAgICAgICAgICAgaWYga2V5IGluIGMgYW5kIGxlbihjW2tleV0pICE9IG46CiAgICAgICAgICAg
#6#ICAgICByYWlzZSBWYWx1ZUVycm9yKGYiY2VsbCAje2l9IChpZD17Y1snaWQnXX0pOiAne2tleX0n
#6#IGxlbmd0aCBtaXNtYXRjaCIpCgoKZGVmIF9zcGxpdF9pZHModmFsdWUpIC0+IGxpc3Q6CiAgICAi
#6#IiJMaW5lYWdlIGZpZWxkcyBjb21lIHRocm91Z2ggYXMgJycgfCAnMjQnIHwgJzI0LzI1Jy4iIiIK
#6#ICAgIGlmIHZhbHVlIGlzIE5vbmU6CiAgICAgICAgcmV0dXJuIFtdCiAgICB0ZXh0ID0gc3RyKHZh
#6#bHVlKS5zdHJpcCgpCiAgICBpZiBub3QgdGV4dCBvciB0ZXh0Lmxvd2VyKCkgaW4gKCJuYW4iLCAi
#6#bm9uZSIpOgogICAgICAgIHJldHVybiBbXQogICAgcmV0dXJuIFtwYXJ0LnN0cmlwKCkgZm9yIHBh
#6#cnQgaW4gdGV4dC5yZXBsYWNlKCIsIiwgIi8iKS5zcGxpdCgiLyIpIGlmIHBhcnQuc3RyaXAoKV0K
#6#CgpkZWYgYnVpbGRfdHJhY2tzX2RvY3VtZW50KGRvYzogZGljdCk6CiAgICAiIiJDb252ZXJ0IHRo
#6#ZSBjb250YWluZXIgaW50byB0aGUgdmlld2VyJ3MgdHJhY2tzLmpzb24gc2NoZW1hLiIiIgogICAg
#6#ZGF0YSA9IGRvY1siZGF0YSJdCiAgICBjZWxscyA9IGRhdGFbImNlbGxzIl0KICAgIF92YWxpZGF0
#6#ZV9jZWxscyhjZWxscykKCiAgICB0aW1lcG9pbnRzID0gc29ydGVkKGZsb2F0KHQpIGZvciB0IGlu
#6#IGRhdGEuZ2V0KCJ0aW1lcG9pbnRzIiwgW10pKQogICAgaWYgbm90IHRpbWVwb2ludHM6CiAgICAg
#6#ICAgdGltZXBvaW50cyA9IHNvcnRlZCh7ZmxvYXQodCkgZm9yIGMgaW4gY2VsbHMgZm9yIHQgaW4g
#6#Y1sidCJdfSkKCiAgICBvdXRfY2VsbHMgPSBPcmRlcmVkRGljdCgpCiAgICBoYXNfcmF3ID0gRmFs
#6#c2UKICAgIGZvciBjIGluIGNlbGxzOgogICAgICAgIGNpZCA9IHN0cihjWyJpZCJdKQogICAgICAg
#6#IHBvc2l0aW9ucywgcmF3X3Bvc2l0aW9ucywgbWFya2VycyA9IHt9LCB7fSwge30KICAgICAgICBt
#6#YXJrZXJfbGlzdCA9IGMuZ2V0KCJtYXJrZXJfY29sb3IiKSBvciBbXQogICAgICAgIGNlbGxfaGFz
#6#X3JhdyA9IGFsbChrIGluIGMgZm9yIGsgaW4gKCJ4X3JhdyIsICJ5X3JhdyIsICJ6X3JhdyIpKQog
#6#ICAgICAgIGhhc19yYXcgPSBoYXNfcmF3IG9yIGNlbGxfaGFzX3JhdwogICAgICAgIGZvciBpLCB0
#6#IGluIGVudW1lcmF0ZShjWyJ0Il0pOgogICAgICAgICAgICBrZXkgPSBzdHIoaW50KHQpKSBpZiBm
#6#bG9hdCh0KS5pc19pbnRlZ2VyKCkgZWxzZSBzdHIoZmxvYXQodCkpCiAgICAgICAgICAgIHBvc2l0
#6#aW9uc1trZXldID0gW2Zsb2F0KGNbIngiXVtpXSksIGZsb2F0KGNbInkiXVtpXSksIGZsb2F0KGNb
#6#InoiXVtpXSldCiAgICAgICAgICAgIGlmIGNlbGxfaGFzX3JhdzoKICAgICAgICAgICAgICAgIHJh
#6#d19wb3NpdGlvbnNba2V5XSA9IFtmbG9hdChjWyJ4X3JhdyJdW2ldKSwgZmxvYXQoY1sieV9yYXci
#6#XVtpXSksIGZsb2F0KGNbInpfcmF3Il1baV0pXQogICAgICAgICAgICBtYXJrZXIgPSBtYXJrZXJf
#6#bGlzdFtpXSBpZiBpIDwgbGVuKG1hcmtlcl9saXN0KSBlbHNlICIiCiAgICAgICAgICAgIGlmIG1h
#6#cmtlcjoKICAgICAgICAgICAgICAgIG1hcmtlcnNba2V5XSA9IG1hcmtlcgoKICAgICAgICBkYXVn
#6#aHRlcnMgPSBfc3BsaXRfaWRzKGMuZ2V0KCJkYXVnaHRlcl9jZWxscyIpKQogICAgICAgIHBhcmVu
#6#dHMgPSBfc3BsaXRfaWRzKGMuZ2V0KCJwYXJlbnRfY2VsbCIpKQogICAgICAgIGVudHJ5ID0gewog
#6#ICAgICAgICAgICAiaWQiOiBjaWQsCiAgICAgICAgICAgICJ0cmFja19pZCI6IGMuZ2V0KCJ0cmFj
#6#a19pZCIpLAogICAgICAgICAgICAicmVnaW9uIjogYy5nZXQoInJlZ2lvbiIpIG9yICJVbmtub3du
#6#IiwKICAgICAgICAgICAgImNvbG9yIjogYy5nZXQoImNvbG9yIiksCiAgICAgICAgICAgICJwb3Np
#6#dGlvbnMiOiBwb3NpdGlvbnMsCiAgICAgICAgICAgICJwYXJlbnQiOiBwYXJlbnRzWzBdIGlmIHBh
#6#cmVudHMgZWxzZSAiIiwKICAgICAgICAgICAgImRhdWdodGVycyI6IGRhdWdodGVycywKICAgICAg
#6#ICAgICAgImlzX21pdG9zaXMiOiBib29sKGRhdWdodGVycyksCiAgICAgICAgICAgICMgQSBjZWxs
#6#IHRoYXQgaW5oZXJpdHMgZnJvbSB0d28gbW90aGVycyBpcyBhIGZ1c2lvbiwgbm90IGEgZGl2aXNp
#6#b24uCiAgICAgICAgICAgICJpc19mdXNpb24iOiBsZW4ocGFyZW50cykgPiAxLAogICAgICAgIH0K
#6#ICAgICAgICBpZiBjZWxsX2hhc19yYXc6CiAgICAgICAgICAgIGVudHJ5WyJyYXdfcG9zaXRpb25z
#6#Il0gPSByYXdfcG9zaXRpb25zCiAgICAgICAgaWYgbWFya2VyczoKICAgICAgICAgICAgZW50cnlb
#6#Im1hcmtlcnMiXSA9IG1hcmtlcnMKICAgICAgICBvdXRfY2VsbHNbY2lkXSA9IGVudHJ5CgogICAg
#6#dHJhY2tzID0gewogICAgICAgICJzY2hlbWEiOiAiaXJpYmhtLXRyYWNrcy12MSIsCiAgICAgICAg
#6#InNvdXJjZSI6IGRvYy5nZXQoImRhdGFzZXRfbmFtZSIpLAogICAgICAgICJzb3VyY2VJZCI6IGRv
#6#Yy5nZXQoImRhdGFzZXRfaWQiKSwKICAgICAgICAiZ2VuZXJhdGVkIjogZG9jLmdldCgiZGF0ZV9n
#6#ZW5lcmF0aW9uIiksCiAgICAgICAgInRpbWVwb2ludHMiOiB0aW1lcG9pbnRzLAogICAgICAgICJj
#6#ZWxscyI6IG91dF9jZWxscywKICAgIH0KICAgIGlmIGlzaW5zdGFuY2UoZGF0YS5nZXQoImxheW91
#6#dCIpLCBkaWN0KToKICAgICAgICB0cmFja3NbImxheW91dCJdID0gZGF0YVsibGF5b3V0Il0KICAg
#6#IHJldHVybiB0cmFja3MsIGhhc19yYXcKCgpkZWYgc29sdmVfcmVnaXN0cmF0aW9uKGRvYzogZGlj
#6#dCwgdGltZXBvaW50X29mZnNldDogaW50KToKICAgICIiIlBlci10aW1lcG9pbnQgcmlnaWQgdHJh
#6#bnNmb3JtIG1hcHBpbmcgcmF3IGFjcXVpc2l0aW9uIGNvb3JkcyAtPiBzdGFiaWxpc2VkIGZyYW1l
#6#LiIiIgogICAgZGF0YSA9IGRvY1siZGF0YSJdCiAgICBjZWxscyA9IGRhdGFbImNlbGxzIl0KCiAg
#6#ICBkZWNsYXJlZCA9IHt9CiAgICBzdGFiX2Jsb2NrID0gZGF0YS5nZXQoInN0YWJpbGl6YXRpb24i
#6#KQogICAgaWYgaXNpbnN0YW5jZShzdGFiX2Jsb2NrLCBkaWN0KToKICAgICAgICBmb3Igcm93IGlu
#6#IHN0YWJfYmxvY2suZ2V0KCJ0cmFuc2Zvcm1zIiwgW10pIG9yIFtdOgogICAgICAgICAgICBpZiBy
#6#b3cuZ2V0KCJtYXRyaXgiKSBhbmQgcm93LmdldCgidCIpIGlzIG5vdCBOb25lOgogICAgICAgICAg
#6#ICAgICAgZGVjbGFyZWRbZmxvYXQocm93WyJ0Il0pXSA9IHJvdwoKICAgIHBhaXJzID0ge30KICAg
#6#IGZvciBjIGluIGNlbGxzOgogICAgICAgIGlmIG5vdCBhbGwoayBpbiBjIGZvciBrIGluICgieF9y
#6#YXciLCAieV9yYXciLCAiel9yYXciKSk6CiAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAgZm9y
#6#IGksIHQgaW4gZW51bWVyYXRlKGNbInQiXSk6CiAgICAgICAgICAgIHBhaXJzLnNldGRlZmF1bHQo
#6#ZmxvYXQodCksIFtdKS5hcHBlbmQoKAogICAgICAgICAgICAgICAgKGNbInhfcmF3Il1baV0sIGNb
#6#InlfcmF3Il1baV0sIGNbInpfcmF3Il1baV0pLAogICAgICAgICAgICAgICAgKGNbIngiXVtpXSwg
#6#Y1sieSJdW2ldLCBjWyJ6Il1baV0pLAogICAgICAgICAgICApKQoKICAgIGlmIG5vdCBwYWlycyBh
#6#bmQgbm90IGRlY2xhcmVkOgogICAgICAgIHJldHVybiBOb25lCgogICAgdHJhbnNmb3Jtcywgd2Fy
#6#bmluZ3MgPSBbXSwgW10KICAgIHdvcnN0ID0gMC4wCiAgICByZXNpZHVhbHMgPSBbXQogICAgaWRl
#6#bnRpdHlfYWZ0ZXJfZHJpZnQgPSBbXQogICAgZm9yIHQgaW4gc29ydGVkKHNldChwYWlycykgfCBz
#6#ZXQoZGVjbGFyZWQpKToKICAgICAgICByb3cgPSB7CiAgICAgICAgICAgICJ0IjogdCwKICAgICAg
#6#ICAgICAgImluZGV4IjogaW50KHJvdW5kKHQpKSArIHRpbWVwb2ludF9vZmZzZXQsCiAgICAgICAg
#6#fQogICAgICAgIGlmIHQgaW4gZGVjbGFyZWQ6CiAgICAgICAgICAgIHNyYyA9IGRlY2xhcmVkW3Rd
#6#CiAgICAgICAgICAgIHJvdy51cGRhdGUoewogICAgICAgICAgICAgICAgIm1hdHJpeCI6IFtmbG9h
#6#dCh2KSBmb3IgdiBpbiBzcmNbIm1hdHJpeCJdXSwKICAgICAgICAgICAgICAgICJyb3RhdGlvbkRl
#6#ZyI6IHNyYy5nZXQoInJvdGF0aW9uRGVnIiksCiAgICAgICAgICAgICAgICAidHJhbnNsYXRpb25V
#6#bSI6IHNyYy5nZXQoInRyYW5zbGF0aW9uVW0iKSwKICAgICAgICAgICAgICAgICJuUG9pbnRzIjog
#6#c3JjLmdldCgiblJlZnMiKSwKICAgICAgICAgICAgICAgICJyZXNpZHVhbFVtIjogc3JjLmdldCgi
#6#bWF4UmVzaWR1YWxVbSIpLAogICAgICAgICAgICAgICAgInNvdXJjZSI6ICJkZWNsYXJlZCIsCiAg
#6#ICAgICAgICAgICAgICAiZXhhY3QiOiBUcnVlLAogICAgICAgICAgICB9KQogICAgICAgICAgICB0
#6#cmFuc2Zvcm1zLmFwcGVuZChyb3cpCiAgICAgICAgICAgIGNvbnRpbnVlCgogICAgICAgIFAgPSBu
#6#cC5hcnJheShbcFswXSBmb3IgcCBpbiBwYWlyc1t0XV0sIGZsb2F0KQogICAgICAgIFEgPSBucC5h
#6#cnJheShbcFsxXSBmb3IgcCBpbiBwYWlyc1t0XV0sIGZsb2F0KQogICAgICAgIGlmIGxlbihQKSA8
#6#IE1JTl9GSVRfUE9JTlRTOgogICAgICAgICAgICB3YXJuaW5ncy5hcHBlbmQoZiJ0PXt0Omd9OiBv
#6#bmx5IHtsZW4oUCl9IHBhaXJlZCBwb2ludHMsIHRyYW5zZm9ybSBub3Qgc29sdmFibGUiKQogICAg
#6#ICAgICAgICByb3cudXBkYXRlKHsibWF0cml4IjogTm9uZSwgIm5Qb2ludHMiOiBpbnQobGVuKFAp
#6#KSwgInJlc2lkdWFsVW0iOiBOb25lLAogICAgICAgICAgICAgICAgICAgICAgICAic291cmNlIjog
#6#InVuc29sdmVkIiwgImV4YWN0IjogRmFsc2V9KQogICAgICAgICAgICB0cmFuc2Zvcm1zLmFwcGVu
#6#ZChyb3cpCiAgICAgICAgICAgIGNvbnRpbnVlCgogICAgICAgIFIsIGIgPSBfcHJvY3J1c3RlcyhQ
#6#LCBRKQogICAgICAgIHJlc2lkdWFsID0gZmxvYXQobnAuc3FydCgoKChQIEAgUi5UKSArIGIgLSBR
#6#KSAqKiAyKS5zdW0oMSkubWVhbigpKSkKICAgICAgICB3b3JzdCA9IG1heCh3b3JzdCwgcmVzaWR1
#6#YWwpCiAgICAgICAgcmVzaWR1YWxzLmFwcGVuZChyZXNpZHVhbCkKICAgICAgICByb3QgPSBfcm90
#6#YXRpb25fZGVncmVlcyhSKQogICAgICAgIHJvdy51cGRhdGUoewogICAgICAgICAgICAibWF0cml4
#6#IjogX21hdHJpeF9jb2x1bW5fbWFqb3IoUiwgYiksCiAgICAgICAgICAgICJyb3RhdGlvbkRlZyI6
#6#IHJvdW5kKHJvdCwgNCksCiAgICAgICAgICAgICJ0cmFuc2xhdGlvblVtIjogW3JvdW5kKGZsb2F0
#6#KHYpLCA2KSBmb3IgdiBpbiBiXSwKICAgICAgICAgICAgIm5Qb2ludHMiOiBpbnQobGVuKFApKSwK
#6#ICAgICAgICAgICAgInJlc2lkdWFsVW0iOiBfc2lnKHJlc2lkdWFsKSwKICAgICAgICAgICAgInNv
#6#dXJjZSI6ICJwcm9jcnVzdGVzIiwKICAgICAgICAgICAgImV4YWN0IjogcmVzaWR1YWwgPD0gUklH
#6#SURfVE9MRVJBTkNFX1VNLAogICAgICAgIH0pCiAgICAgICAgIyBUaGUgYW5hbHlzaXMgc2tpcHMg
#6#dGhlIGFsaWdubWVudCB3aGVuIHRvbyBmZXcgcmVmZXJlbmNlIGNlbGxzIGFyZSBzaGFyZWQgd2l0
#6#aAogICAgICAgICMgdGhlIHByZXZpb3VzIGZyYW1lLCB3aGljaCBsZWF2ZXMgdGhhdCBmcmFtZSBp
#6#biBSQVcgc3BhY2Ug4oCUIGFuIGlkZW50aXR5IHNpdHRpbmcKICAgICAgICAjIGluIHRoZSBtaWRk
#6#bGUgb2YgYSBkcmlmdGluZyBzZXJpZXMuIFNpbGVudCwgYW5kIGl0IGJyZWFrcyB0aGUgb3Zlcmxh
#6#eSBmb3IgdGhhdAogICAgICAgICMgZnJhbWUsIHNvIGl0IGlzIHJlcG9ydGVkIHJhdGhlciB0aGFu
#6#IHBhcGVyZWQgb3Zlci4KICAgICAgICBpZiByb3QgPCAxZS02IGFuZCBucC5hbGxjbG9zZShiLCAw
#6#LjAsIGF0b2w9MWUtNik6CiAgICAgICAgICAgIGlkZW50aXR5X2FmdGVyX2RyaWZ0LmFwcGVuZCh0
#6#KQogICAgICAgIHRyYW5zZm9ybXMuYXBwZW5kKHJvdykKCiAgICBzb2x2ZWQgPSBbciBmb3IgciBp
#6#biB0cmFuc2Zvcm1zIGlmIHIuZ2V0KCJtYXRyaXgiKV0KICAgIGlmIGxlbihpZGVudGl0eV9hZnRl
#6#cl9kcmlmdCkgPiAxOgogICAgICAgIGludGVyaW9yID0gW3QgZm9yIHQgaW4gaWRlbnRpdHlfYWZ0
#6#ZXJfZHJpZnQgaWYgdCAhPSBtaW4ocGFpcnMpXQogICAgICAgIGlmIGludGVyaW9yOgogICAgICAg
#6#ICAgICB3YXJuaW5ncy5hcHBlbmQoCiAgICAgICAgICAgICAgICAiaWRlbnRpdHkgdHJhbnNmb3Jt
#6#IG9uIG5vbi1yZWZlcmVuY2UgdGltZXBvaW50cyAiCiAgICAgICAgICAgICAgICArICIsICIuam9p
#6#bihmInt0Omd9IiBmb3IgdCBpbiBpbnRlcmlvcikKICAgICAgICAgICAgICAgICsgIiDigJQgdGhl
#6#IGFuYWx5c2lzIGxpa2VseSBza2lwcGVkIHRoZWlyIGFsaWdubWVudCAodG9vIGZldyByZWZlcmVu
#6#Y2UgIgogICAgICAgICAgICAgICAgICAiY2VsbHMpOyB0aG9zZSBmcmFtZXMgc3RheSBpbiByYXcg
#6#c3BhY2UiKQogICAgcmlnaWQgPSBib29sKHNvbHZlZCkgYW5kIHdvcnN0IDw9IFJJR0lEX1RPTEVS
#6#QU5DRV9VTQogICAgaWYgbm90IHJpZ2lkIGFuZCByZXNpZHVhbHM6CiAgICAgICAgd2FybmluZ3Mu
#6#YXBwZW5kKGYibWF4IFByb2NydXN0ZXMgcmVzaWR1YWwge3dvcnN0Oi40Z30gdW0gZXhjZWVkcyB0
#6#aGUgIgogICAgICAgICAgICAgICAgICAgICAgICBmIntSSUdJRF9UT0xFUkFOQ0VfVU19IHVtIHJp
#6#Z2lkIHRvbGVyYW5jZSDigJQgdGhlIHN0YWJpbGlzYXRpb24gaXMgIgogICAgICAgICAgICAgICAg
#6#ICAgICAgICBmIm5vdCBhIHJpZ2lkIG1vdGlvbiBhbmQgbXVzdCBub3QgYmUgYXBwbGllZCB0byB0
#6#aGUgaW1hZ2VzIikKCiAgICByZXR1cm4gewogICAgICAgICJtZXRob2QiOiAidHJhY2tpbmctZGVj
#6#bGFyZWQiIGlmIGRlY2xhcmVkIGVsc2UgInRyYWNraW5nLXByb2NydXN0ZXMiLAogICAgICAgICJj
#6#b29yZGluYXRlU3BhY2UiOiAiYWNxdWlzaXRpb24tdW0iLAogICAgICAgICJjb252ZW50aW9uIjog
#6#InBfc3RhYmlsaXplZCA9IE0gLiBwX3JhdyA7IG1hdHJpeCBpcyBjb2x1bW4tbWFqb3IgZm9yIFRI
#6#UkVFLk1hdHJpeDQuZnJvbUFycmF5IiwKICAgICAgICAidGltZXBvaW50T2Zmc2V0IjogdGltZXBv
#6#aW50X29mZnNldCwKICAgICAgICAiYXBwbGllZFRvVm9sdW1lIjogcmlnaWQsCiAgICAgICAgInRy
#6#YW5zZm9ybXMiOiB0cmFuc2Zvcm1zLAogICAgICAgICJxY1N1bW1hcnkiOiB7CiAgICAgICAgICAg
#6#ICJyaWdpZCI6IHJpZ2lkLAogICAgICAgICAgICAidG9sZXJhbmNlVW0iOiBSSUdJRF9UT0xFUkFO
#6#Q0VfVU0sCiAgICAgICAgICAgICJtYXhSZXNpZHVhbFVtIjogX3NpZyh3b3JzdCkgaWYgcmVzaWR1
#6#YWxzIGVsc2UgTm9uZSwKICAgICAgICAgICAgIm1lYW5SZXNpZHVhbFVtIjogX3NpZyhmbG9hdChu
#6#cC5tZWFuKHJlc2lkdWFscykpKSBpZiByZXNpZHVhbHMgZWxzZSBOb25lLAogICAgICAgICAgICAi
#6#dGltZXBvaW50c1NvbHZlZCI6IGxlbihzb2x2ZWQpLAogICAgICAgICAgICAidGltZXBvaW50c1Rv
#6#dGFsIjogbGVuKHRyYW5zZm9ybXMpLAogICAgICAgICAgICAid2FybmluZ3MiOiB3YXJuaW5ncywK
#6#ICAgICAgICB9LAogICAgfQoKCmRlZiBfb2NjdXBpZWRfYm94ZXNfdW0oZGF0YXNldF9kaXI6IFBh
#6#dGgsIGV4dGVudDogZGljdCwgZGltczogZGljdCk6CiAgICAiIiJQZXItdGltZXBvaW50IGJvdW5k
#6#aW5nIGJveCwgaW4gdW0sIG9mIHRoZSBicmlja3MgdGhhdCBhY3R1YWxseSBob2xkIHNpZ25hbC4K
#6#CiAgICBSZWFkIGZyb20gYnJpY2tzL21hbmlmZXN0Lmpzb24sIHdoaWNoIGFscmVhZHkgcmVjb3Jk
#6#cyBgbm9uRW1wdHlgIHBlciBicmljayBhZnRlcgogICAgZW1wdHktc3BhY2Ugc2tpcHBpbmcuIFVz
#6#aW5nIHRoZSBvY2N1cGllZCByZWdpb24gcmF0aGVyIHRoYW4gdGhlIHdob2xlIGFjcXVpc2l0aW9u
#6#CiAgICBib3ggbWF0dGVyczogdGhlIHN0YWJpbGlzZWQgc3BlY2ltZW4gYmFyZWx5IG1vdmVzLCBz
#6#byBpdHMgdW5pb24gc3RheXMgdGlnaHQsIHdoaWxlCiAgICB0aGUgdW5pb24gb2YgdGhlIGZ1bGwg
#6#aW1hZ2VkIGJveGVzIGlzIHNldmVyYWwgdGltZXMgbGFyZ2VyIGFuZCB3b3VsZCBtYWtlIHRoZQog
#6#ICAgcmVuZGVyZXIgc3dlZXAgbW9zdGx5IGVtcHR5IHNwYWNlLgogICAgIiIiCiAgICBtYW5pZmVz
#6#dF9wYXRoID0gZGF0YXNldF9kaXIgLyAiYnJpY2tzIiAvICJtYW5pZmVzdC5qc29uIgogICAgaWYg
#6#bm90IG1hbmlmZXN0X3BhdGguZXhpc3RzKCkgb3Igbm90IGV4dGVudCBvciBub3QgZGltczoKICAg
#6#ICAgICByZXR1cm4gTm9uZQogICAgd2l0aCBvcGVuKG1hbmlmZXN0X3BhdGgsICJyIiwgZW5jb2Rp
#6#bmc9InV0Zi04IikgYXMgZmg6CiAgICAgICAgbWFuaWZlc3QgPSBqc29uLmxvYWQoZmgpCgogICAg
#6#bG8gPSBucC5hcnJheShleHRlbnRbIm1pbiJdLCBmbG9hdCkKICAgIGhpID0gbnAuYXJyYXkoZXh0
#6#ZW50WyJtYXgiXSwgZmxvYXQpCiAgICBncmlkID0gbnAuYXJyYXkoW2RpbXMuZ2V0KCJ4IiwgMSks
#6#IGRpbXMuZ2V0KCJ5IiwgMSksIGRpbXMuZ2V0KCJ6IiwgMSldLCBmbG9hdCkKICAgIHZveGVsID0g
#6#KGhpIC0gbG8pIC8gbnAubWF4aW11bShncmlkLCAxLjApCgogICAgZGVmIGJveF9mcm9tX2xldmVs
#6#cyhsZXZlbHMpOgogICAgICAgIGxldmVsID0gbmV4dCgobCBmb3IgbCBpbiBsZXZlbHMgb3IgW10g
#6#aWYgbC5nZXQoImxldmVsIikgPT0gMCksIE5vbmUpCiAgICAgICAgaWYgbm90IGxldmVsOgogICAg
#6#ICAgICAgICByZXR1cm4gTm9uZQogICAgICAgIG1pbnMsIG1heHMgPSBbXSwgW10KICAgICAgICBm
#6#b3IgY2h1bmsgaW4gbGV2ZWwuZ2V0KCJjaHVua3MiLCBbXSk6CiAgICAgICAgICAgIGlmIGNodW5r
#6#LmdldCgibm9uRW1wdHkiKSBpcyBGYWxzZToKICAgICAgICAgICAgICAgIGNvbnRpbnVlCiAgICAg
#6#ICAgICAgIG1pbnMuYXBwZW5kKGNodW5rWyJtaW4iXSkKICAgICAgICAgICAgbWF4cy5hcHBlbmQo
#6#Y2h1bmtbIm1heCJdKQogICAgICAgIGlmIG5vdCBtaW5zOgogICAgICAgICAgICByZXR1cm4gTm9u
#6#ZQogICAgICAgIHJldHVybiAobG8gKyBucC5hcnJheShtaW5zLCBmbG9hdCkubWluKDApICogdm94
#6#ZWwsCiAgICAgICAgICAgICAgICBsbyArIG5wLmFycmF5KG1heHMsIGZsb2F0KS5tYXgoMCkgKiB2
#6#b3hlbCkKCiAgICByb3dzID0gbWFuaWZlc3QuZ2V0KCJ0aW1lcG9pbnRzIikKICAgIGlmIGlzaW5z
#6#dGFuY2Uocm93cywgZGljdCk6CiAgICAgICAgb3V0ID0ge30KICAgICAgICBmb3Iga2V5LCByb3cg
#6#aW4gcm93cy5pdGVtcygpOgogICAgICAgICAgICBib3ggPSBib3hfZnJvbV9sZXZlbHMocm93Lmdl
#6#dCgibGV2ZWxzIikgb3IgbWFuaWZlc3QuZ2V0KCJsZXZlbHMiKSkKICAgICAgICAgICAgaWYgYm94
#6#OgogICAgICAgICAgICAgICAgb3V0W2ludChrZXlbMTpdKSBpZiBrZXkuc3RhcnRzd2l0aCgidCIp
#6#IGVsc2UgaW50KGtleSldID0gYm94CiAgICAgICAgcmV0dXJuIG91dCBvciBOb25lCiAgICBib3gg
#6#PSBib3hfZnJvbV9sZXZlbHMobWFuaWZlc3QuZ2V0KCJsZXZlbHMiKSkKICAgIHJldHVybiB7MDog
#6#Ym94fSBpZiBib3ggZWxzZSBOb25lCgoKZGVmIF9pbWFnZV9ib3hfdW5pb24ocmVnaXN0cmF0aW9u
#6#OiBkaWN0LCBleHRlbnQ6IGRpY3QsIG9jY3VwaWVkPU5vbmUpOgogICAgIiIiVW5pb24sIG92ZXIg
#6#ZXZlcnkgdGltZXBvaW50LCBvZiB0aGUgaW1hZ2VkIGNvbnRlbnQgY2FycmllZCBpbnRvIHN0YWJp
#6#bGlzZWQgc3BhY2UuCgogICAgSW4gc3RhYmlsaXNlZCBtb2RlIHRoZSBzcGVjaW1lbiBzdGFuZHMg
#6#c3RpbGwgYW5kIHRoZSBpbWFnZWQgYm94IG1vdmVzIGFyb3VuZCBpdCwgc28KICAgIHRoZSBib3gg
#6#dGhlIHJlbmRlcmVyIG11c3QgY292ZXIgaXMgdGhpcyB1bmlvbiByYXRoZXIgdGhhbiB0aGUgYWNx
#6#dWlzaXRpb24gYm94LgogICAgRmFsbHMgYmFjayB0byB0aGUgZnVsbCBhY3F1aXNpdGlvbiBib3gg
#6#d2hlbiBicmljayBvY2N1cGFuY3kgaXMgdW5hdmFpbGFibGUuCiAgICAiIiIKICAgIGlmIG5vdCBy
#6#ZWdpc3RyYXRpb24gb3Igbm90IGV4dGVudDoKICAgICAgICByZXR1cm4gTm9uZQogICAgZGVmYXVs
#6#dF9sbyA9IG5wLmFycmF5KGV4dGVudFsibWluIl0sIGZsb2F0KQogICAgZGVmYXVsdF9oaSA9IG5w
#6#LmFycmF5KGV4dGVudFsibWF4Il0sIGZsb2F0KQogICAgcHRzID0gW10KICAgIGZvciByb3cgaW4g
#6#cmVnaXN0cmF0aW9uWyJ0cmFuc2Zvcm1zIl06CiAgICAgICAgbSA9IHJvdy5nZXQoIm1hdHJpeCIp
#6#CiAgICAgICAgaWYgbm90IG06CiAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAgYm94ID0gKG9j
#6#Y3VwaWVkIG9yIHt9KS5nZXQocm93LmdldCgiaW5kZXgiKSkKICAgICAgICBibG8sIGJoaSA9IGJv
#6#eCBpZiBib3ggZWxzZSAoZGVmYXVsdF9sbywgZGVmYXVsdF9oaSkKICAgICAgICBjb3JuZXJzID0g
#6#bnAuYXJyYXkoW1t4LCB5LCB6XSBmb3IgeCBpbiAoYmxvWzBdLCBiaGlbMF0pCiAgICAgICAgICAg
#6#ICAgICAgICAgICAgICAgICBmb3IgeSBpbiAoYmxvWzFdLCBiaGlbMV0pIGZvciB6IGluIChibG9b
#6#Ml0sIGJoaVsyXSldKQogICAgICAgIE0gPSBucC5hcnJheShtLCBmbG9hdCkucmVzaGFwZSg0LCA0
#6#KS5UCiAgICAgICAgcHRzLmFwcGVuZChjb3JuZXJzIEAgTVs6MywgOjNdLlQgKyBNWzozLCAzXSkK
#6#ICAgIGlmIG5vdCBwdHM6CiAgICAgICAgcmV0dXJuIE5vbmUKICAgIGFsbHAgPSBucC52c3RhY2so
#6#cHRzKQogICAgcmV0dXJuIHsKICAgICAgICAibWluIjogW3JvdW5kKGZsb2F0KHYpLCA0KSBmb3Ig
#6#diBpbiBhbGxwLm1pbigwKV0sCiAgICAgICAgIm1heCI6IFtyb3VuZChmbG9hdCh2KSwgNCkgZm9y
#6#IHYgaW4gYWxscC5tYXgoMCldLAogICAgICAgICJiYXNpcyI6ICJvY2N1cGllZC1icmlja3MiIGlm
#6#IG9jY3VwaWVkIGVsc2UgImFjcXVpc2l0aW9uLWJveCIsCiAgICB9CgoKZGVmIF9ib3VuZHMocG9p
#6#bnRzKToKICAgIGlmIG5vdCBwb2ludHM6CiAgICAgICAgcmV0dXJuIE5vbmUKICAgIGFyciA9IG5w
#6#LmFycmF5KHBvaW50cywgZmxvYXQpCiAgICByZXR1cm4geyJtaW4iOiBbcm91bmQoZmxvYXQodiks
#6#IDQpIGZvciB2IGluIGFyci5taW4oMCldLAogICAgICAgICAgICAibWF4IjogW3JvdW5kKGZsb2F0
#6#KHYpLCA0KSBmb3IgdiBpbiBhcnIubWF4KDApXX0KCgpkZWYgaW1wb3J0X3RyYWNraW5nKHRyYWNr
#6#X3BhdGg6IFBhdGgsIGRhdGFzZXRfZGlyOiBQYXRoLCBnbGJfcGF0aDogUGF0aCA9IE5vbmUsCiAg
#6#ICAgICAgICAgICAgICAgICAgdGltZXBvaW50X29mZnNldDogaW50ID0gLTEsIHdyaXRlX2d6aXA6
#6#IGJvb2wgPSBUcnVlKToKICAgIGRvYyA9IF9sb2FkX3NvdXJjZSh0cmFja19wYXRoKQogICAgdHJh
#6#Y2tzLCBoYXNfcmF3ID0gYnVpbGRfdHJhY2tzX2RvY3VtZW50KGRvYykKCiAgICBtZXRhZGF0YV9w
#6#YXRoID0gZGF0YXNldF9kaXIgLyAibWV0YWRhdGEuanNvbiIKICAgIGlmIG5vdCBtZXRhZGF0YV9w
#6#YXRoLmV4aXN0cygpOgogICAgICAgIHJhaXNlIEZpbGVOb3RGb3VuZEVycm9yKGYie21ldGFkYXRh
#6#X3BhdGh9IG5vdCBmb3VuZCDigJQgcnVuIHRoZSB2b2x1bWUgcGlwZWxpbmUgZmlyc3QiKQogICAg
#6#d2l0aCBvcGVuKG1ldGFkYXRhX3BhdGgsICJyIiwgZW5jb2Rpbmc9InV0Zi04IikgYXMgZmg6CiAg
#6#ICAgICAgbWV0YWRhdGEgPSBqc29uLmxvYWQoZmgpCgogICAgcmVnaXN0cmF0aW9uID0gc29sdmVf
#6#cmVnaXN0cmF0aW9uKGRvYywgdGltZXBvaW50X29mZnNldCkKICAgIGlmIHJlZ2lzdHJhdGlvbiBp
#6#cyBOb25lOgogICAgICAgIHByaW50KCJbVFJBQ0tJTkddIE5vIHJhdy9zdGFiaWxpc2VkIHBhaXJz
#6#IGFuZCBubyBkZWNsYXJlZCB0cmFuc2Zvcm06ICIKICAgICAgICAgICAgICAidGhlIG92ZXJsYXkg
#6#d2lsbCBiZSBhdmFpbGFibGUgYnV0IHRoZSB2b2x1bWUgY2Fubm90IGJlIHN0YWJpbGlzZWQuIikK
#6#CiAgICAjIC0tLSBXcml0ZSB0cmFja3MuanNvbiAoKyAuZ3opIC0tLQogICAgcGF5bG9hZCA9IGpz
#6#b24uZHVtcHModHJhY2tzLCBlbnN1cmVfYXNjaWk9RmFsc2UsIHNlcGFyYXRvcnM9KCIsIiwgIjoi
#6#KSkKICAgIGF0b21pY193cml0ZV9ieXRlcyhkYXRhc2V0X2RpciAvICJ0cmFja3MuanNvbiIsIHBh
#6#eWxvYWQuZW5jb2RlKCJ1dGYtOCIpKQogICAgZ3pfbm90ZSA9ICIiCiAgICBpZiB3cml0ZV9nemlw
#6#OgogICAgICAgICMgbXRpbWU9MDogdGhlIGFyY2hpdmUgZGVwZW5kcyBvbiB0aGUgdHJhY2tzIGFs
#6#b25lLCBub3Qgb24gdGhlIGhvdXIgaXQgd2FzIG1hZGUuCiAgICAgICAgYXRvbWljX3dyaXRlX2J5
#6#dGVzKGRhdGFzZXRfZGlyIC8gInRyYWNrcy5qc29uLmd6IiwKICAgICAgICAgICAgICAgICAgICAg
#6#ICAgICAgZ3ppcC5jb21wcmVzcyhwYXlsb2FkLmVuY29kZSgidXRmLTgiKSwgY29tcHJlc3NsZXZl
#6#bD05LCBtdGltZT0wKSkKICAgICAgICBnel9ub3RlID0gZiIsIHsoZGF0YXNldF9kaXIgLyAndHJh
#6#Y2tzLmpzb24uZ3onKS5zdGF0KCkuc3Rfc2l6ZS8xZTY6LjJmfSBNQiBnemlwcGVkIgogICAgcHJp
#6#bnQoZiJbVFJBQ0tJTkddIHRyYWNrcy5qc29uOiB7bGVuKHRyYWNrc1snY2VsbHMnXSl9IGNlbGxz
#6#LCAiCiAgICAgICAgICBmIntsZW4odHJhY2tzWyd0aW1lcG9pbnRzJ10pfSB0aW1lcG9pbnRzLCB7
#6#bGVuKHBheWxvYWQpLzFlNjouMmZ9IE1Ce2d6X25vdGV9IikKCiAgICAjIC0tLSBDb3B5IHRoZSBz
#6#dXJmYWNlIEdMQiAtLS0KICAgIHN1cmZhY2VfcmVsID0gTm9uZQogICAgaWYgZ2xiX3BhdGggaXMg
#6#Tm9uZToKICAgICAgICBjYW5kaWRhdGUgPSB0cmFja19wYXRoLndpdGhfc3VmZml4KCIuZ2xiIikK
#6#ICAgICAgICBnbGJfcGF0aCA9IGNhbmRpZGF0ZSBpZiBjYW5kaWRhdGUuZXhpc3RzKCkgZWxzZSBO
#6#b25lCiAgICBpZiBnbGJfcGF0aCBhbmQgZ2xiX3BhdGguZXhpc3RzKCk6CiAgICAgICAgc3RhZ2Vk
#6#ID0gZGF0YXNldF9kaXIgLyAiLm1vZGVsLmdsYi50bXAiCiAgICAgICAgc2h1dGlsLmNvcHkyKGds
#6#Yl9wYXRoLCBzdGFnZWQpCiAgICAgICAgb3MucmVwbGFjZShzdGFnZWQsIGRhdGFzZXRfZGlyIC8g
#6#Im1vZGVsLmdsYiIpCiAgICAgICAgc3VyZmFjZV9yZWwgPSAibW9kZWwuZ2xiIgogICAgICAgIHBy
#6#aW50KGYiW1RSQUNLSU5HXSBtb2RlbC5nbGI6IHsoZGF0YXNldF9kaXIgLyAnbW9kZWwuZ2xiJyku
#6#c3RhdCgpLnN0X3NpemUvMWU2Oi4xZn0gTUIiKQogICAgZWxzZToKICAgICAgICBwcmludCgiW1RS
#6#QUNLSU5HXSBubyBzdXJmYWNlIEdMQiBmb3VuZCDigJQgdGhlIG92ZXJsYXkgd2lsbCByZW5kZXIg
#6#Y2VsbHMgYW5kIHRyYWlscyBvbmx5IikKCiAgICAjIC0tLSBSZWdpb24gaW52ZW50b3J5IChkcml2
#6#ZXMgdGhlIGxlZ2VuZCBhbmQgdGhlIHJlZ2lvbiBjb2xvdXIgcGFsZXR0ZSkgLS0tCiAgICByZWdp
#6#b25fY291bnRzID0gQ291bnRlcihjWyJyZWdpb24iXSBmb3IgYyBpbiB0cmFja3NbImNlbGxzIl0u
#6#dmFsdWVzKCkpCiAgICByZWdpb25fY29sb3JzID0ge30KICAgIGZvciBjIGluIHRyYWNrc1siY2Vs
#6#bHMiXS52YWx1ZXMoKToKICAgICAgICByZWdpb25fY29sb3JzLnNldGRlZmF1bHQoY1sicmVnaW9u
#6#Il0sIGMuZ2V0KCJjb2xvciIpKQoKICAgIHN0YWJfcHRzLCByYXdfcHRzID0gW10sIFtdCiAgICBm
#6#b3IgYyBpbiB0cmFja3NbImNlbGxzIl0udmFsdWVzKCk6CiAgICAgICAgc3RhYl9wdHMuZXh0ZW5k
#6#KGNbInBvc2l0aW9ucyJdLnZhbHVlcygpKQogICAgICAgIHJhd19wdHMuZXh0ZW5kKChjLmdldCgi
#6#cmF3X3Bvc2l0aW9ucyIpIG9yIHt9KS52YWx1ZXMoKSkKCiAgICBtZXRhZGF0YVsidHJhY2tpbmci
#6#XSA9IHsKICAgICAgICAic2NoZW1hIjogImlyaWJobS10cmFja3MtdjEiLAogICAgICAgICJzb3Vy
#6#Y2UiOiB0cmFja19wYXRoLm5hbWUsCiAgICAgICAgInNvdXJjZURhdGFzZXQiOiBkb2MuZ2V0KCJk
#6#YXRhc2V0X25hbWUiKSwKICAgICAgICAiZ2VuZXJhdGVkIjogZG9jLmdldCgiZGF0ZV9nZW5lcmF0
#6#aW9uIiksCiAgICAgICAgImltcG9ydGVkIjogZGF0ZXRpbWUubm93KCkuaXNvZm9ybWF0KCksCiAg
#6#ICAgICAgInRyYWNrc1BhdGgiOiAidHJhY2tzLmpzb24iLAogICAgICAgICJzdXJmYWNlUGF0aCI6
#6#IHN1cmZhY2VfcmVsLAogICAgICAgICJjZWxsQ291bnQiOiBsZW4odHJhY2tzWyJjZWxscyJdKSwK
#6#ICAgICAgICAidGltZXBvaW50Q291bnQiOiBsZW4odHJhY2tzWyJ0aW1lcG9pbnRzIl0pLAogICAg
#6#ICAgICJoYXNSYXdDb29yZGluYXRlcyI6IGhhc19yYXcsCiAgICAgICAgIm1pdG9zaXNDb3VudCI6
#6#IHN1bSgxIGZvciBjIGluIHRyYWNrc1siY2VsbHMiXS52YWx1ZXMoKSBpZiBjWyJpc19taXRvc2lz
#6#Il0pLAogICAgICAgICJmdXNpb25Db3VudCI6IHN1bSgxIGZvciBjIGluIHRyYWNrc1siY2VsbHMi
#6#XS52YWx1ZXMoKSBpZiBjWyJpc19mdXNpb24iXSksCiAgICAgICAgInJlZ2lvbnMiOiBbeyJuYW1l
#6#IjogbmFtZSwgImNlbGxzIjogbiwgImNvbG9yIjogcmVnaW9uX2NvbG9ycy5nZXQobmFtZSl9CiAg
#6#ICAgICAgICAgICAgICAgICAgZm9yIG5hbWUsIG4gaW4gcmVnaW9uX2NvdW50cy5tb3N0X2NvbW1v
#6#bigpXSwKICAgICAgICAiYm91bmRzVW0iOiB7InN0YWJpbGl6ZWQiOiBfYm91bmRzKHN0YWJfcHRz
#6#KSwgInJhdyI6IF9ib3VuZHMocmF3X3B0cyl9LAogICAgfQogICAgIyBXaGljaCBvZiB0aGUgdGhy
#6#ZWUgc2hhcGVzIHRoZSB0cmFja2luZyBhY3R1YWxseSBjYW1lIGZyb20sIGFuZCBob3cgaXRzIGNs
#6#YXNzaWZpY2F0aW9uCiAgICAjIHdhcyByZXNvbHZlZCDigJQgdGhlIGFuc3dlciBpcyBub3QgcmVj
#6#b3ZlcmFibGUgZnJvbSB0cmFja3MuanNvbiBhZnRlcndhcmRzLgogICAgcHJvdmVuYW5jZSA9IChk
#6#b2MuZ2V0KCJkYXRhIikgb3Ige30pLmdldCgicHJvdmVuYW5jZSIpCiAgICBpZiBpc2luc3RhbmNl
#6#KHByb3ZlbmFuY2UsIGRpY3QpOgogICAgICAgIG1ldGFkYXRhWyJ0cmFja2luZyJdWyJwcm92ZW5h
#6#bmNlIl0gPSBwcm92ZW5hbmNlCgogICAgaWYgcmVnaXN0cmF0aW9uOgogICAgICAgIGV4dGVudCA9
#6#IG1ldGFkYXRhLmdldCgiYWNxdWlzaXRpb25FeHRlbnRVbSIpCiAgICAgICAgb2NjdXBpZWQgPSBf
#6#b2NjdXBpZWRfYm94ZXNfdW0oZGF0YXNldF9kaXIsIGV4dGVudCwgbWV0YWRhdGEuZ2V0KCJkaW1l
#6#bnNpb25zIikpCiAgICAgICAgdW5pb24gPSBfaW1hZ2VfYm94X3VuaW9uKHJlZ2lzdHJhdGlvbiwg
#6#ZXh0ZW50LCBvY2N1cGllZCkKICAgICAgICBpZiB1bmlvbjoKICAgICAgICAgICAgcmVnaXN0cmF0
#6#aW9uWyJpbWFnZUJveFVuaW9uVW0iXSA9IHVuaW9uCiAgICAgICAgICAgIHNwYW4gPSBbdW5pb25b
#6#Im1heCJdW2ldIC0gdW5pb25bIm1pbiJdW2ldIGZvciBpIGluIHJhbmdlKDMpXQogICAgICAgICAg
#6#ICBhY3EgPSBbZXh0ZW50WyJtYXgiXVtpXSAtIGV4dGVudFsibWluIl1baV0gZm9yIGkgaW4gcmFu
#6#Z2UoMyldCiAgICAgICAgICAgIHJhdGlvID0gKHNwYW5bMF0gKiBzcGFuWzFdICogc3BhblsyXSkg
#6#LyBtYXgoYWNxWzBdICogYWNxWzFdICogYWNxWzJdLCAxZS05KQogICAgICAgICAgICBwcmludChm
#6#IltUUkFDS0lOR10gZGlzcGxheSBib3ggKHt1bmlvblsnYmFzaXMnXX0pOiAiCiAgICAgICAgICAg
#6#ICAgICAgIGYie3NwYW5bMF06LjBmfSB4IHtzcGFuWzFdOi4wZn0geCB7c3BhblsyXTouMGZ9IHVt
#6#LCAiCiAgICAgICAgICAgICAgICAgIGYie3JhdGlvOi4yZn14IHRoZSBhY3F1aXNpdGlvbiB2b2x1
#6#bWUiKQogICAgICAgIG1ldGFkYXRhWyJyZWdpc3RyYXRpb24iXSA9IHJlZ2lzdHJhdGlvbgoKICAg
#6#ICAgICBxYyA9IHJlZ2lzdHJhdGlvblsicWNTdW1tYXJ5Il0KICAgICAgICB2ZXJkaWN0ID0gInJp
#6#Z2lkZSAoZXhhY3RlKSIgaWYgcWNbInJpZ2lkIl0gZWxzZSAiTk9OIHJpZ2lkZSIKICAgICAgICBw
#6#cmludChmIltUUkFDS0lOR10gcmVnaXN0cmF0aW9uOiB7cWNbJ3RpbWVwb2ludHNTb2x2ZWQnXX0v
#6#e3FjWyd0aW1lcG9pbnRzVG90YWwnXX0gIgogICAgICAgICAgICAgIGYidGltZXBvaW50cywgcmVz
#6#aWR1IG1heCB7cWNbJ21heFJlc2lkdWFsVW0nXTouM2d9IHVtIC0+IHt2ZXJkaWN0fSIpCiAgICAg
#6#ICAgZm9yIHcgaW4gcWNbIndhcm5pbmdzIl06CiAgICAgICAgICAgIHByaW50KGYiW1RSQUNLSU5H
#6#XSAgIFshXSB7d30iKQoKICAgIG1ldGFkYXRhWyJsYXN0TW9kaWZpZWQiXSA9IGRhdGV0aW1lLm5v
#6#dygpLmlzb2Zvcm1hdCgpCiAgICBhdG9taWNfd3JpdGVfanNvbihtZXRhZGF0YV9wYXRoLCBtZXRh
#6#ZGF0YSwgaW5kZW50PTIsIGVuc3VyZV9hc2NpaT1GYWxzZSkKICAgIHByaW50KGYiW1RSQUNLSU5H
#6#XSBVcGRhdGVkIHttZXRhZGF0YV9wYXRofSIpCiAgICByZXR1cm4gbWV0YWRhdGEKCgpkZWYgbWFp
#6#bigpOgogICAgYXAgPSBhcmdwYXJzZS5Bcmd1bWVudFBhcnNlcigKICAgICAgICBkZXNjcmlwdGlv
#6#bj0iQXR0YWNoIGFuIEltYXJpcyBjZWxsLXRyYWNraW5nIGFuYWx5c2lzIHRvIGEgcHJlcHJvY2Vz
#6#c2VkIHZvbHVtZSBkYXRhc2V0LiIpCiAgICBhcC5hZGRfYXJndW1lbnQoInRyYWNrIiwgaGVscD0i
#6#cGF0aCB0byB0aGUgYW5hbHlzaXM6IGEgLmltYXJpc190cmFjayBjb250YWluZXIsIHRoZSAuaW1z
#6#ICIKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICJpdHNlbGYgKEltYXJpcyBvYmpl
#6#Y3RzIGFyZSByZWFkIGZyb20gU2NlbmU4KSwgb3IgdGhlICIKICAgICAgICAgICAgICAgICAgICAg
#6#ICAgICAgICAgICAgICIueGxzLy54bHN4IHN0YXRpc3RpY3Mgd29ya2Jvb2sgZXhwb3J0ZWQgZnJv
#6#bSBJbWFyaXMiKQogICAgYXAuYWRkX2FyZ3VtZW50KCJkYXRhc2V0IiwgaGVscD0iZGF0YXNldCBk
#6#aXJlY3RvcnksIGUuZy4gREFUQV9XRUIvbGl2ZS88bmFtZT4iKQogICAgYXAuYWRkX2FyZ3VtZW50
#6#KCItLWdsYiIsIGRlZmF1bHQ9Tm9uZSwKICAgICAgICAgICAgICAgICAgICBoZWxwPSJzdXJmYWNl
#6#IEdMQiB0byBhdHRhY2ggKGRlZmF1bHQ6IDx0cmFjaz4uZ2xiIG5leHQgdG8gdGhlIGNvbnRhaW5l
#6#cikiKQogICAgYXAuYWRkX2FyZ3VtZW50KCItLXRpbWVwb2ludC1vZmZzZXQiLCB0eXBlPWludCwg
#6#ZGVmYXVsdD0tMSwKICAgICAgICAgICAgICAgICAgICBoZWxwPSJhZGRlZCB0byB0aGUgdHJhY2tp
#6#bmcgdGltZXBvaW50IHRvIGdldCB0aGUgdm9sdW1lIGZyYW1lIGluZGV4ICIKICAgICAgICAgICAg
#6#ICAgICAgICAgICAgICIoZGVmYXVsdCAtMTogSW1hcmlzIGNvdW50cyBmcmFtZXMgZnJvbSAxLCB0
#6#aGUgYnJpY2sgcHlyYW1pZCBmcm9tIDApIikKICAgIGFwLmFkZF9hcmd1bWVudCgiLS1uby1nemlw
#6#IiwgYWN0aW9uPSJzdG9yZV90cnVlIiwgaGVscD0ic2tpcCB3cml0aW5nIHRyYWNrcy5qc29uLmd6
#6#IikKICAgIGFyZ3MgPSBhcC5wYXJzZV9hcmdzKCkKCiAgICB0cnk6CiAgICAgICAgaW1wb3J0X3Ry
#6#YWNraW5nKFBhdGgoYXJncy50cmFjayksIFBhdGgoYXJncy5kYXRhc2V0KSwKICAgICAgICAgICAg
#6#ICAgICAgICAgICAgUGF0aChhcmdzLmdsYikgaWYgYXJncy5nbGIgZWxzZSBOb25lLAogICAgICAg
#6#ICAgICAgICAgICAgICAgICB0aW1lcG9pbnRfb2Zmc2V0PWFyZ3MudGltZXBvaW50X29mZnNldCwK
#6#ICAgICAgICAgICAgICAgICAgICAgICAgd3JpdGVfZ3ppcD1ub3QgYXJncy5ub19nemlwKQogICAg
#6#ICAgIHByaW50KCJbVFJBQ0tJTkddIEltcG9ydCBjb21wbGV0ZS4iKQogICAgZXhjZXB0IEV4Y2Vw
#6#dGlvbiBhcyBleGM6CiAgICAgICAgaW1wb3J0IHRyYWNlYmFjawogICAgICAgIHRyYWNlYmFjay5w
#6#cmludF9leGMoKQogICAgICAgIHByaW50KGYiW0VSUk9SXSBUcmFja2luZyBpbXBvcnQgZmFpbGVk
#6#OiB7ZXhjfSIsIGZpbGU9c3lzLnN0ZGVycikKICAgICAgICBzeXMuZXhpdCgxKQoKCmlmIF9fbmFt
#6#ZV9fID09ICJfX21haW5fXyI6CiAgICBtYWluKCkK
:: ---- [7] tracking_sources.py (34884 octets) ----
#7#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwoiIiJGaW5kIHRoZSBjZWxsLXRyYWNraW5nIGFuYWx5c2lz
#7#IHRoYXQgYmVsb25ncyB0byBhbiAuaW1zIHZvbHVtZSwgd2hhdGV2ZXIgc2hhcGUgaXQgY2FtZSBp
#7#bi4KClRocmVlIHNoYXBlcyBleGlzdCBpbiB0aGUgbGFiLCBhbmQgYSBkYXRhc2V0IG1heSBjYXJy
#7#eSBhbnkgb25lIG9mIHRoZW06CgogIDEuIGBgPHN0ZW0+LmltYXJpc190cmFja2BgICAgdGhlIHRy
#7#YWNraW5nIHBpcGVsaW5lJ3Mgb3duIG91dHB1dCAoZ3ppcCtKU09OIGNvbnRhaW5lcikuCiAgICAg
#7#ICAgICAgICAgICAgICAgICAgICAgICAgICBBbHJlYWR5IGNhcnJpZXMgc3RhYmlsaXNlZCBBTkQg
#7#cmF3IGNvb3JkaW5hdGVzLCBsaW5lYWdlIGFuZAogICAgICAgICAgICAgICAgICAgICAgICAgICAg
#7#ICAgZXZlbnQgbWFya2VycywgYW5kIHVzdWFsbHkgYSBzaWJsaW5nIGBgPHN0ZW0+LmdsYmBgIHN1
#7#cmZhY2UuCiAgMi4gdGhlIGBgLmltc2BgIGl0c2VsZiAgICAgICBJbWFyaXMga2VlcHMgaXRzIFNw
#7#b3RzL1RyYWNrcyBvYmplY3RzIGluIGBgU2NlbmU4L0NvbnRlbnRgYC4KICAgICAgICAgICAgICAg
#7#ICAgICAgICAgICAgICAgIE5vdGhpbmcgaGFzIHRvIHNpdCBuZXh0IHRvIHRoZSB2b2x1bWUgZm9y
#7#IHRoaXMgdG8gd29yay4KICAzLiBgYDxzdGVtPi54bHNgYCAvIGBgLnhsc3hgYCB0aGUgSW1hcmlz
#7#ICJleHBvcnQgc3RhdGlzdGljcyBvbiBhbGwgdGFicyIgd29ya2Jvb2ssIHdob3NlCiAgICAgICAg
#7#ICAgICAgICAgICAgICAgICAgICAgICBgYFBvc2l0aW9uYGAgc2hlZXQgaG9sZHMgb25lIHJvdyBw
#7#ZXIgc3BvdCBwZXIgdGltZXBvaW50LgoKUHJlZmVyZW5jZSBvcmRlciBpcyAoMSkgPiAoMikgPiAo
#7#Myk6IHRoZSBjb250YWluZXIgaXMgdGhlIHJpY2hlc3QgKGl0IGlzIGEgZmluaXNoZWQgYW5hbHlz
#7#aXMsCnN1cmZhY2VzIGluY2x1ZGVkKSwgU2NlbmU4IGNvbWVzIG5leHQgYmVjYXVzZSBpdCBpcyAq
#7#aW5zaWRlKiB0aGUgdm9sdW1lIOKAlCBubyBzaWRlY2FyIHRvIGxvc2UsCm5vIHNoZWV0LW5hbWUg
#7#YW1iaWd1aXR5IOKAlCBhbmQgdGhlIHdvcmtib29rIGxhc3QsIGFzIHRoZSBmYWxsYmFjayBmb3Ig
#7#dm9sdW1lcyB3aG9zZSBTY2VuZTgKb2JqZWN0cyB3ZXJlIHN0cmlwcGVkIG9yIG5ldmVyIHNhdmVk
#7#LgoKU291cmNlcyAoMikgYW5kICgzKSBhcmUgcmF3IG9ic2VydmF0aW9uczogdGhleSBjYXJyeSBz
#7#cG90IHBvc2l0aW9ucywgdHJhY2sgbWVtYmVyc2hpcCBhbmQgYQpjbGFzc2lmaWNhdGlvbiwgYnV0
#7#IG5vIHVuaXF1ZSBjZWxsIGlkZW50aXR5LCBubyBsaW5lYWdlIGFuZCBubyBzdGFiaWxpc2F0aW9u
#7#LiBUaG9zZSBhcmUKcHJvZHVjZWQgaGVyZSBieSBjYWxsaW5nIHRoZSBsYWIncyBvd24gYW5hbHlz
#7#aXMgY29kZSAoYGBTQ1JJUFRTL0FuYWx5c2lzLnB5YGApIHJhdGhlciB0aGFuIGEKc2Vjb25kIGlt
#7#cGxlbWVudGF0aW9uIOKAlCBhIGRhdGFzZXQgbXVzdCB5aWVsZCB0aGUgc2FtZSB0cmFja3Mgd2hl
#7#dGhlciBpdCB3ZW50IHRocm91Z2ggdGhlCnRyYWNraW5nIHBpcGVsaW5lIG9yIHRocm91Z2ggdGhp
#7#cyBzaG9ydGN1dC4gVGhlIHBvcHVsYXRpb24gc3VyZmFjZXMgYXJlIE5PVCByZWJ1aWx0IGhlcmU6
#7#Cm9ubHkgYSBjb250YWluZXIgKDEpIGNhbiBicmluZyBhIGBgbW9kZWwuZ2xiYGA7IGEgZGF0YXNl
#7#dCBhdHRhY2hlZCBmcm9tICgyKSBvciAoMykgZ2V0cwpjZWxscyBhbmQgdHJhaWxzLCBhbmQgaXRz
#7#IHN1cmZhY2UgbGF5ZXIgc3RheXMgZW1wdHkgdW50aWwgdGhlIHRyYWNraW5nIHBpcGVsaW5lIGlz
#7#IHJ1bi4KCkNMSSAoZGlhZ25vc3RpY3MpOgogICAgcHl0aG9uIHRyYWNraW5nX3NvdXJjZXMucHkg
#7#PGZpbGUuaW1zfGZpbGUueGxzfGZpbGUueGxzeD4gWy0tbGlzdF0gWy0tb3V0IDxjb250YWluZXI+
#7#XQoiIiIKaW1wb3J0IGFyZ3BhcnNlCmltcG9ydCBnemlwCmltcG9ydCBpbXBvcnRsaWIudXRpbApp
#7#bXBvcnQganNvbgppbXBvcnQgb3MKaW1wb3J0IHN5cwppbXBvcnQgdXVpZApmcm9tIGRhdGV0aW1l
#7#IGltcG9ydCBkYXRldGltZQpmcm9tIHBhdGhsaWIgaW1wb3J0IFBhdGgKCmltcG9ydCBudW1weSBh
#7#cyBucAoKX192ZXJzaW9uX18gPSAiMC4xLjAiCgpTSUdOQVRVUkUgPSAiSU1BUklTX1RSQUNLRVJf
#7#VjEiClNDUklQVF9ESVIgPSBQYXRoKF9fZmlsZV9fKS5yZXNvbHZlKCkucGFyZW50CgpDT05UQUlO
#7#RVJfU1VGRklYID0gIi5pbWFyaXNfdHJhY2siCkVYQ0VMX1NVRkZJWEVTID0gKCIueGxzIiwgIi54
#7#bHN4IiwgIi54bHNtIikKCiMgSW1hcmlzIG51bWJlcnMgYWNxdWlzaXRpb24gZnJhbWVzIGZyb20g
#7#MSBpbiBldmVyeSBzdGF0aXN0aWNzIGV4cG9ydCwgYW5kIHRoZSB3aG9sZQojIGRvd25zdHJlYW0g
#7#Y2hhaW4gKHRoZSBjb250YWluZXJzIHRoZSB0cmFja2luZyBwaXBlbGluZSB3cml0ZXMsIHRoZSBp
#7#bXBvcnRlcidzIGRlZmF1bHQKIyAtLXRpbWVwb2ludC1vZmZzZXQgb2YgLTEpIGlzIGJ1aWx0IG9u
#7#IHRoYXQuIFNjZW5lOCBpbmRleGVzIGl0cyB0aW1lcG9pbnRzIGZyb20gMCwgc28gdGhlCiMgb25s
#7#eSBwbGFjZSB0aGUgdHdvIGNvbnZlbnRpb25zIG1lZXQgaXMgaGVyZS4KU0NFTkU4X1RJTUVfQkFT
#7#RSA9IDEKCiMgQ29sdW1uIGhlYWRlcnMgSW1hcmlzIGVtaXRzIG9uIHRoZSBQb3NpdGlvbiBzaGVl
#7#dCB0aGF0IGFyZSBuZXZlciB0aGUgY2xhc3NpZmljYXRpb24uCiMgV2hhdGV2ZXIgc2luZ2xlIGhl
#7#YWRlciBpcyBsZWZ0IG92ZXIgSVMgdGhlIGNsYXNzaWZpY2F0aW9uLCB3aG9zZSBuYW1lIHRoZSBi
#7#aW9sb2dpc3QgY2hvc2UKIyAoIlJlZ2lvbiIsICJTZXQgMSIsICJQb2ludCBMb2NhdGlvbnMiLCAi
#7#RW5kb3RoZWxpYWwgY2VsbHMiLCDigKYgYWxsIHNlZW4gaW4gdGhlIHdpbGQpLgpfUE9TSVRJT05f
#7#UkVTRVJWRUQgPSB7CiAgICAicG9zaXRpb24geCIsICJwb3NpdGlvbiB5IiwgInBvc2l0aW9uIHoi
#7#LCAidW5pdCIsICJjYXRlZ29yeSIsICJjb2xsZWN0aW9uIiwKICAgICJ0aW1lIiwgInRpbWUgaW5k
#7#ZXgiLCAidHJhY2tpZCIsICJ0cmFjayBpZCIsICJpZCIsICJiaXJ0aCIsICJkZWF0aCIsCiAgICAi
#7#cmVmZXJlbmNlZnJhbWUiLCAicmVmZXJlbmNlIGZyYW1lIiwgImNsYXNzIiwgImltYWdlIiwgImNo
#7#YW5uZWwiLCAibGV2ZWwiLAp9CgoKIyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#7#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#7#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#7#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#7#lIDilIDilIDilIDilIDilIDilIDilIDilIAKIyAgRGlzY292ZXJ5CiMg4pSA4pSA4pSA4pSA4pSA
#7#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#7#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#7#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#7#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgpjbGFzcyBUcmFj
#7#a2luZ1NvdXJjZToKICAgICIiIk9uZSBjYW5kaWRhdGUgdHJhY2tpbmcgYW5hbHlzaXMgZm9yIGEg
#7#ZGF0YXNldC4iIiIKCiAgICAjOiBwcmVmZXJlbmNlIG9yZGVyLCBsb3dlc3QgZmlyc3QKICAgIFJB
#7#TksgPSB7ImNvbnRhaW5lciI6IDAsICJzY2VuZTgiOiAxLCAiZXhjZWwiOiAyfQoKICAgIGRlZiBf
#7#X2luaXRfXyhzZWxmLCBraW5kOiBzdHIsIHBhdGg6IFBhdGgsIGRldGFpbDogc3RyID0gIiIsIGds
#7#YjogUGF0aCA9IE5vbmUpOgogICAgICAgIHNlbGYua2luZCA9IGtpbmQKICAgICAgICBzZWxmLnBh
#7#dGggPSBQYXRoKHBhdGgpCiAgICAgICAgc2VsZi5kZXRhaWwgPSBkZXRhaWwKICAgICAgICBzZWxm
#7#LmdsYiA9IFBhdGgoZ2xiKSBpZiBnbGIgZWxzZSBOb25lCgogICAgQHByb3BlcnR5CiAgICBkZWYg
#7#cmFuayhzZWxmKSAtPiBpbnQ6CiAgICAgICAgcmV0dXJuIHNlbGYuUkFOSy5nZXQoc2VsZi5raW5k
#7#LCA5OSkKCiAgICBkZWYgZGVzY3JpYmUoc2VsZikgLT4gc3RyOgogICAgICAgIGxhYmVsID0geyJj
#7#b250YWluZXIiOiAiY29udGVuZXVyIC5pbWFyaXNfdHJhY2siLAogICAgICAgICAgICAgICAgICJz
#7#Y2VuZTgiOiAib2JqZXRzIEltYXJpcyBlbWJhcnF1ZXMgKFNjZW5lOCkiLAogICAgICAgICAgICAg
#7#ICAgICJleGNlbCI6ICJjbGFzc2V1ciBzdGF0aXN0aXF1ZXMgSW1hcmlzIn0uZ2V0KHNlbGYua2lu
#7#ZCwgc2VsZi5raW5kKQogICAgICAgIHN1ZmZpeCA9IGYiIOKAlCB7c2VsZi5kZXRhaWx9IiBpZiBz
#7#ZWxmLmRldGFpbCBlbHNlICIiCiAgICAgICAgcmV0dXJuIGYie2xhYmVsfToge3NlbGYucGF0aC5u
#7#YW1lfXtzdWZmaXh9IgoKICAgIGRlZiBfX3JlcHJfXyhzZWxmKToKICAgICAgICByZXR1cm4gZiI8
#7#VHJhY2tpbmdTb3VyY2Uge3NlbGYua2luZH0ge3NlbGYucGF0aC5uYW1lfT4iCgoKZGVmIF9zaWRl
#7#Y2FyX2NhbmRpZGF0ZXMoaW1zX3BhdGg6IFBhdGgsIHN1ZmZpeGVzKToKICAgICIiIkZpbGVzIHNo
#7#YXJpbmcgdGhlIHZvbHVtZSdzIHN0ZW0sIGJlc2lkZSBpdCBvciBpbiBhIGZvbGRlciBuYW1lZCBh
#7#ZnRlciBpdC4KCiAgICBUaGUgbGFiIHNoaXBzIGFuYWx5c2VzIGVpdGhlciBmbGF0IG5leHQgdG8g
#7#dGhlIC5pbXMgb3IgZ3JvdXBlZCBvbmUtZm9sZGVyLXBlci1zYW1wbGUKICAgICh0aGF0IGlzIGhv
#7#dyBgYElOUFVUIFNUQVRJU1RJQ1MuemlwYGAgdW5wYWNrcyksIHNvIGJvdGggbGF5b3V0cyBhcmUg
#7#c2VhcmNoZWQuCiAgICAiIiIKICAgIHN0ZW0gPSBpbXNfcGF0aC5zdGVtCiAgICBzZWVuLCBvdXQg
#7#PSBzZXQoKSwgW10KICAgIGZvciBiYXNlIGluIChpbXNfcGF0aC5wYXJlbnQsIGltc19wYXRoLnBh
#7#cmVudCAvIHN0ZW0pOgogICAgICAgIGlmIG5vdCBiYXNlLmlzX2RpcigpOgogICAgICAgICAgICBj
#7#b250aW51ZQogICAgICAgIGZvciBzdWZmaXggaW4gc3VmZml4ZXM6CiAgICAgICAgICAgIGZvciBj
#7#YW5kIGluIChiYXNlIC8gZiJ7c3RlbX17c3VmZml4fSIsIGJhc2UgLyBmIntzdGVtfV9hbmFseXNp
#7#c3tzdWZmaXh9Iik6CiAgICAgICAgICAgICAgICBpZiBjYW5kLmlzX2ZpbGUoKSBhbmQgY2FuZCBu
#7#b3QgaW4gc2VlbjoKICAgICAgICAgICAgICAgICAgICBzZWVuLmFkZChjYW5kKQogICAgICAgICAg
#7#ICAgICAgICAgIG91dC5hcHBlbmQoY2FuZCkKICAgIHJldHVybiBvdXQKCgpkZWYgZGlzY292ZXIo
#7#aW1zX3BhdGgpIC0+IGxpc3Q6CiAgICAiIiJFdmVyeSB0cmFja2luZyBzb3VyY2UgdGhhdCBleGlz
#7#dHMgZm9yIHRoaXMgdm9sdW1lLCBiZXN0IGZpcnN0LiIiIgogICAgaW1zX3BhdGggPSBQYXRoKGlt
#7#c19wYXRoKQogICAgZm91bmQgPSBbXQoKICAgIGZvciBjYW5kIGluIF9zaWRlY2FyX2NhbmRpZGF0
#7#ZXMoaW1zX3BhdGgsIChDT05UQUlORVJfU1VGRklYLCkpOgogICAgICAgIGdsYiA9IGNhbmQud2l0
#7#aF9zdWZmaXgoIi5nbGIiKQogICAgICAgIGZvdW5kLmFwcGVuZChUcmFja2luZ1NvdXJjZSgiY29u
#7#dGFpbmVyIiwgY2FuZCwKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgInN1cmZh
#7#Y2VzIC5nbGIgaW5jbHVzZXMiIGlmIGdsYi5leGlzdHMoKSBlbHNlICIiLAogICAgICAgICAgICAg
#7#ICAgICAgICAgICAgICAgICAgICAgICBnbGIgaWYgZ2xiLmV4aXN0cygpIGVsc2UgTm9uZSkpCgog
#7#ICAgaWYgaW1zX3BhdGguc3VmZml4Lmxvd2VyKCkgPT0gIi5pbXMiOgogICAgICAgIHN1bW1hcnkg
#7#PSBwcm9iZV9zY2VuZTgoaW1zX3BhdGgpCiAgICAgICAgaWYgc3VtbWFyeToKICAgICAgICAgICAg
#7#Zm91bmQuYXBwZW5kKFRyYWNraW5nU291cmNlKCJzY2VuZTgiLCBpbXNfcGF0aCwgc3VtbWFyeSkp
#7#CgogICAgZm9yIGNhbmQgaW4gX3NpZGVjYXJfY2FuZGlkYXRlcyhpbXNfcGF0aCwgRVhDRUxfU1VG
#7#RklYRVMpOgogICAgICAgIGZvdW5kLmFwcGVuZChUcmFja2luZ1NvdXJjZSgiZXhjZWwiLCBjYW5k
#7#KSkKCiAgICBmb3VuZC5zb3J0KGtleT1sYW1iZGEgczogcy5yYW5rKQogICAgcmV0dXJuIGZvdW5k
#7#CgoKIyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#7#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#7#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#7#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#7#lIDilIDilIAKIyAgU291cmNlIDIg4oCUIEltYXJpcyBTY2VuZTggb2JqZWN0cywgcmVhZCBzdHJh
#7#aWdodCBvdXQgb2YgdGhlIC5pbXMKIyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#7#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#7#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#7#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#7#lIDilIDilIDilIDilIDilIDilIDilIDilIAKCmRlZiBfaDVfdGV4dCh2YWx1ZSkgLT4gc3RyOgog
#7#ICAgIiIiSW1hcmlzIHdyaXRlcyBzdHJpbmdzIGJvdGggYXMgb25lIGJ5dGUgYmxvYiBhbmQgYXMg
#7#YW4gYXJyYXkgb2Ygc2luZ2xlIGNoYXJhY3RlcnMuIiIiCiAgICBpZiBpc2luc3RhbmNlKHZhbHVl
#7#LCAoYnl0ZXMsIG5wLmJ5dGVzXykpOgogICAgICAgIHJldHVybiB2YWx1ZS5kZWNvZGUoInV0Zi04
#7#IiwgInJlcGxhY2UiKS5zdHJpcCgpCiAgICBpZiBpc2luc3RhbmNlKHZhbHVlLCBucC5uZGFycmF5
#7#KToKICAgICAgICBwYXJ0cyA9IFtieXRlcyhjKSBpZiBpc2luc3RhbmNlKGMsIChieXRlcywgbnAu
#7#Ynl0ZXNfKSkgZWxzZSBzdHIoYykuZW5jb2RlKCJ1dGYtOCIpCiAgICAgICAgICAgICAgICAgZm9y
#7#IGMgaW4gdmFsdWUucmF2ZWwoKV0KICAgICAgICByZXR1cm4gYiIiLmpvaW4ocGFydHMpLmRlY29k
#7#ZSgidXRmLTgiLCAicmVwbGFjZSIpLnN0cmlwKCkKICAgIHJldHVybiBzdHIodmFsdWUpLnN0cmlw
#7#KCkKCgpkZWYgX3BpY2tfcG9pbnRzX2dyb3VwKGNvbnRlbnQpOgogICAgIiIiVGhlIFNwb3RzIG9i
#7#amVjdCBob2xkaW5nIHRoZSB0cmFja2luZy4gSW1hcmlzIGFsbG93cyBzZXZlcmFsOyB0YWtlIHRo
#7#ZSBsYXJnZXN0LiIiIgogICAgYmVzdCA9IE5vbmUKICAgIGZvciBuYW1lIGluIGNvbnRlbnQua2V5
#7#cygpOgogICAgICAgIGdyb3VwID0gY29udGVudC5nZXQobmFtZSkKICAgICAgICBpZiBub3QgaGFz
#7#YXR0cihncm91cCwgImtleXMiKSBvciAiU3BvdCIgbm90IGluIGdyb3VwOgogICAgICAgICAgICBj
#7#b250aW51ZQogICAgICAgIG5fc3BvdHMgPSBpbnQoZ3JvdXBbIlNwb3QiXS5zaGFwZVswXSkKICAg
#7#ICAgICBpZiBuX3Nwb3RzIGFuZCAoYmVzdCBpcyBOb25lIG9yIG5fc3BvdHMgPiBiZXN0WzFdKToK
#7#ICAgICAgICAgICAgYmVzdCA9IChuYW1lLCBuX3Nwb3RzLCBncm91cCkKICAgIHJldHVybiBiZXN0
#7#CgoKZGVmIF90cmFja190YWJsZV9uYW1lcyhncm91cCk6CiAgICAiIiJEYXRhc2V0IG5hbWVzIG9m
#7#IHRoZSB0cmFjayB0YWJsZXMsIGFzIGRlY2xhcmVkIGJ5IE1haW5UcmFja1RhYmxlLgoKICAgIElt
#7#YXJpcyB3cml0ZXMgYGBUcmFjazBgYC9gYFRyYWNrT2JqZWN0MGBgL2BgVHJhY2tFZGdlMGBgIGlu
#7#IHByYWN0aWNlLCBidXQgdGhlIG5hbWVzIGFyZQogICAgZGF0YSwgbm90IGNvbnZlbnRpb24g4oCU
#7#IE1haW5UcmFja1RhYmxlIGlzIHRoZSBpbmRleCB0aGF0IHJlc29sdmVzIHRoZW0uCiAgICAiIiIK
#7#ICAgIHRhYmxlID0gZ3JvdXAuZ2V0KCJNYWluVHJhY2tUYWJsZSIpCiAgICBpZiB0YWJsZSBpcyBu
#7#b3QgTm9uZSBhbmQgdGFibGUuc2hhcGVbMF06CiAgICAgICAgcm93ID0gdGFibGVbMF0KICAgICAg
#7#ICBuYW1lcyA9IChfaDVfdGV4dChyb3dbMV0pLCBfaDVfdGV4dChyb3dbMl0pLCBfaDVfdGV4dChy
#7#b3dbM10pKQogICAgICAgIGlmIGFsbChuIGluIGdyb3VwIGZvciBuIGluIG5hbWVzKToKICAgICAg
#7#ICAgICAgcmV0dXJuIG5hbWVzCiAgICBpZiAiVHJhY2swIiBpbiBncm91cCBhbmQgIlRyYWNrT2Jq
#7#ZWN0MCIgaW4gZ3JvdXA6CiAgICAgICAgcmV0dXJuICgiVHJhY2swIiwgIlRyYWNrT2JqZWN0MCIs
#7#ICJUcmFja0VkZ2UwIikKICAgIHJldHVybiBOb25lCgoKZGVmIHByb2JlX3NjZW5lOChpbXNfcGF0
#7#aCkgLT4gc3RyOgogICAgIiIiT25lLWxpbmUgc3VtbWFyeSBvZiB0aGUgdHJhY2tpbmcgaW5zaWRl
#7#IGFuIC5pbXMsIG9yICIiIHdoZW4gdGhlcmUgaXMgbm9uZS4iIiIKICAgIHRyeToKICAgICAgICBp
#7#bXBvcnQgaDVweQogICAgZXhjZXB0IEltcG9ydEVycm9yOgogICAgICAgIHJldHVybiAiIgogICAg
#7#dHJ5OgogICAgICAgIHdpdGggaDVweS5GaWxlKHN0cihpbXNfcGF0aCksICJyIikgYXMgZjoKICAg
#7#ICAgICAgICAgY29udGVudCA9IGYuZ2V0KCJTY2VuZTgvQ29udGVudCIpCiAgICAgICAgICAgIGlm
#7#IGNvbnRlbnQgaXMgTm9uZToKICAgICAgICAgICAgICAgIHJldHVybiAiIgogICAgICAgICAgICBw
#7#aWNrZWQgPSBfcGlja19wb2ludHNfZ3JvdXAoY29udGVudCkKICAgICAgICAgICAgaWYgcGlja2Vk
#7#IGlzIE5vbmU6CiAgICAgICAgICAgICAgICByZXR1cm4gIiIKICAgICAgICAgICAgbmFtZSwgbl9z
#7#cG90cywgZ3JvdXAgPSBwaWNrZWQKICAgICAgICAgICAgbmFtZXMgPSBfdHJhY2tfdGFibGVfbmFt
#7#ZXMoZ3JvdXApCiAgICAgICAgICAgIGlmIG5vdCBuYW1lczoKICAgICAgICAgICAgICAgIHJldHVy
#7#biAiIgogICAgICAgICAgICBuX3RyYWNrcyA9IGludChncm91cFtuYW1lc1swXV0uc2hhcGVbMF0p
#7#CiAgICAgICAgICAgIGlmIG5vdCBuX3RyYWNrczoKICAgICAgICAgICAgICAgIHJldHVybiAiIgog
#7#ICAgICAgICAgICBuX3RwID0gaW50KGdyb3VwWyJTcG90VGltZU9mZnNldCJdLnNoYXBlWzBdKSBp
#7#ZiAiU3BvdFRpbWVPZmZzZXQiIGluIGdyb3VwIGVsc2UgMAogICAgICAgICAgICBvYmpfbmFtZSA9
#7#IF9oNV90ZXh0KGdyb3VwLmF0dHJzLmdldCgiTmFtZSIsIG5hbWUpKQogICAgICAgICAgICByZXR1
#7#cm4gZiJ7bl9zcG90c30gc3BvdHMsIHtuX3RyYWNrc30gcGlzdGVzLCB7bl90cH0gdGltZXBvaW50
#7#cyAoe29ial9uYW1lfSkiCiAgICBleGNlcHQgRXhjZXB0aW9uOgogICAgICAgIHJldHVybiAiIgoK
#7#CmRlZiBfc2NlbmU4X2xhYmVscyhncm91cCwgc3BvdF9pZHM6IHNldCwgdHJhY2tfaWRzOiBzZXQp
#7#OgogICAgIiIiUmVzb2x2ZSB0aGUgYmlvbG9naXN0J3MgY2xhc3NpZmljYXRpb24gaW50byBgYG9i
#7#amVjdCBpZCAtPiBsYWJlbGBgLgoKICAgIEltYXJpcyBzdG9yZXMgaXQgYXMgYSBmbGF0LCBjdW11
#7#bGF0aXZlIGluZGV4OiBMYWJlbFZhbHVlcyBob2xkcyBldmVyeSBsYWJlbCBvZiBldmVyeQogICAg
#7#Z3JvdXAgYmFjayB0byBiYWNrLCBMYWJlbEdyb3VwTmFtZXMgY2xvc2VzIGVhY2ggZ3JvdXAgd2l0
#7#aCBhbiBlbmQgb2Zmc2V0LCBhbmQgTGFiZWxTZXRzCiAgICBjbG9zZXMgZWFjaCAobGFiZWxzLCBv
#7#YmplY3RzKSBhc3NpZ25tZW50IHRoZSBzYW1lIHdheS4gQSBncm91cCBpcyBhcHBsaWVkIGVpdGhl
#7#ciB0bwogICAgc3BvdHMgb3IgdG8gdHJhY2tzLCBhbmQgYm90aCB1c3VhbGx5IGV4aXN0ICgiUG9p
#7#bnQgTG9jYXRpb25zIiAvICJUcmFjayBMb2NhdGlvbnMiKS4KICAgICIiIgogICAgZGVmIF9yb3dz
#7#KG5hbWUpOgogICAgICAgIGRzID0gZ3JvdXAuZ2V0KG5hbWUpCiAgICAgICAgcmV0dXJuIGRzWzpd
#7#IGlmIGRzIGlzIG5vdCBOb25lIGFuZCBkcy5zaGFwZVswXSBlbHNlIFtdCgogICAgdmFsdWVzID0g
#7#W19oNV90ZXh0KHJbMF0pIGZvciByIGluIF9yb3dzKCJMYWJlbFZhbHVlcyIpXQogICAgaWYgbm90
#7#IHZhbHVlczoKICAgICAgICByZXR1cm4ge30sIHt9CgogICAgZ3JvdXBfb2ZfbGFiZWwsIHByZXYg
#7#PSB7fSwgMAogICAgZm9yIHJvdyBpbiBfcm93cygiTGFiZWxHcm91cE5hbWVzIik6CiAgICAgICAg
#7#Z25hbWUsIGVuZCA9IF9oNV90ZXh0KHJvd1swXSksIGludChyb3dbMV0pCiAgICAgICAgZm9yIGkg
#7#aW4gcmFuZ2UocHJldiwgbWluKGVuZCwgbGVuKHZhbHVlcykpKToKICAgICAgICAgICAgZ3JvdXBf
#7#b2ZfbGFiZWxbaV0gPSBnbmFtZQogICAgICAgIHByZXYgPSBlbmQKCiAgICBsYWJlbF9pZHMgPSBb
#7#aW50KHJbMF0pIGZvciByIGluIF9yb3dzKCJMYWJlbFNldExhYmVsSURzIildCiAgICBvYmplY3Rf
#7#aWRzID0gW2ludChyWzBdKSBmb3IgciBpbiBfcm93cygiTGFiZWxTZXRPYmplY3RJRHMiKV0KCiAg
#7#ICBzcG90X2xhYmVscywgdHJhY2tfbGFiZWxzID0ge30sIHt9CiAgICBwcmV2X2wgPSBwcmV2X28g
#7#PSAwCiAgICBmb3Igcm93IGluIF9yb3dzKCJMYWJlbFNldHMiKToKICAgICAgICBlbmRfbCwgZW5k
#7#X28gPSBpbnQocm93WzBdKSwgaW50KHJvd1sxXSkKICAgICAgICBvYmpzID0gb2JqZWN0X2lkc1tw
#7#cmV2X286ZW5kX29dCiAgICAgICAgZm9yIGxpIGluIGxhYmVsX2lkc1twcmV2X2w6ZW5kX2xdOgog
#7#ICAgICAgICAgICBpZiBsaSA+PSBsZW4odmFsdWVzKToKICAgICAgICAgICAgICAgIGNvbnRpbnVl
#7#CiAgICAgICAgICAgIGduYW1lID0gZ3JvdXBfb2ZfbGFiZWwuZ2V0KGxpLCAiIikKICAgICAgICAg
#7#ICAgbmFtZSA9IHZhbHVlc1tsaV0KICAgICAgICAgICAgZm9yIG9iaiBpbiBvYmpzOgogICAgICAg
#7#ICAgICAgICAgdGFyZ2V0ID0gc3BvdF9sYWJlbHMgaWYgb2JqIGluIHNwb3RfaWRzIGVsc2UgKHRy
#7#YWNrX2xhYmVscyBpZiBvYmogaW4gdHJhY2tfaWRzIGVsc2UgTm9uZSkKICAgICAgICAgICAgICAg
#7#IGlmIHRhcmdldCBpcyBOb25lOgogICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAg
#7#ICAgICAgICB0YXJnZXQuc2V0ZGVmYXVsdChnbmFtZSwge30pLnNldGRlZmF1bHQob2JqLCBuYW1l
#7#KQogICAgICAgIHByZXZfbCwgcHJldl9vID0gZW5kX2wsIGVuZF9vCgogICAgIyBBIGdyb3VwIGNs
#7#YXNzaWZpZXMgc3BvdHMgb3IgdHJhY2tzLCBuZXZlciBib3RoLiBJbWFyaXMga2VlcHMgdGhlIHR3
#7#byBpZCBzcGFjZXMKICAgICMgZGlzam9pbnQsIGJ1dCBhbiBpZCBzZWVuIGluIGJvdGggd291bGQg
#7#b3RoZXJ3aXNlIHNwbGl0IG9uZSBncm91cCBhY3Jvc3MgdGhlIHR3bwogICAgIyB0YWJsZXMgYW5k
#7#IHNocmluayBpdDsgdGhlIHNpZGUgaG9sZGluZyB0aGUgbW9zdCBvYmplY3RzIGlzIHRoZSBncm91
#7#cCdzIHJlYWwgdGFyZ2V0LgogICAgZm9yIGduYW1lIGluIHNldChzcG90X2xhYmVscykgJiBzZXQo
#7#dHJhY2tfbGFiZWxzKToKICAgICAgICBpZiBsZW4oc3BvdF9sYWJlbHNbZ25hbWVdKSA+PSBsZW4o
#7#dHJhY2tfbGFiZWxzW2duYW1lXSk6CiAgICAgICAgICAgIHRyYWNrX2xhYmVscy5wb3AoZ25hbWUp
#7#CiAgICAgICAgZWxzZToKICAgICAgICAgICAgc3BvdF9sYWJlbHMucG9wKGduYW1lKQogICAgcmV0
#7#dXJuIHNwb3RfbGFiZWxzLCB0cmFja19sYWJlbHMKCgpkZWYgcmVhZF9zY2VuZTgoaW1zX3BhdGgp
#7#IC0+IGRpY3Q6CiAgICAiIiJGbGF0IHBlci1zcG90IHRhYmxlIHJlYWQgZnJvbSB0aGUgLmltcyBp
#7#dHNlbGYuIFJldHVybnMgTm9uZSB3aGVuIHRoZXJlIGlzIG5vIHRyYWNraW5nLiIiIgogICAgaW1w
#7#b3J0IGg1cHkKCiAgICBpbXNfcGF0aCA9IFBhdGgoaW1zX3BhdGgpCiAgICB3aXRoIGg1cHkuRmls
#7#ZShzdHIoaW1zX3BhdGgpLCAiciIpIGFzIGY6CiAgICAgICAgY29udGVudCA9IGYuZ2V0KCJTY2Vu
#7#ZTgvQ29udGVudCIpCiAgICAgICAgaWYgY29udGVudCBpcyBOb25lOgogICAgICAgICAgICByZXR1
#7#cm4gTm9uZQogICAgICAgIHBpY2tlZCA9IF9waWNrX3BvaW50c19ncm91cChjb250ZW50KQogICAg
#7#ICAgIGlmIHBpY2tlZCBpcyBOb25lOgogICAgICAgICAgICByZXR1cm4gTm9uZQogICAgICAgIG9i
#7#al9rZXksIF8sIGdyb3VwID0gcGlja2VkCiAgICAgICAgbmFtZXMgPSBfdHJhY2tfdGFibGVfbmFt
#7#ZXMoZ3JvdXApCiAgICAgICAgaWYgbm90IG5hbWVzOgogICAgICAgICAgICByZXR1cm4gTm9uZQog
#7#ICAgICAgIHRyYWNrX25hbWUsIHRyYWNrb2JqX25hbWUsIF9lZGdlX25hbWUgPSBuYW1lcwoKICAg
#7#ICAgICBzcG90ID0gZ3JvdXBbIlNwb3QiXVs6XQogICAgICAgIGlmIG5vdCBsZW4oc3BvdCk6CiAg
#7#ICAgICAgICAgIHJldHVybiBOb25lCiAgICAgICAgdHJhY2tzID0gZ3JvdXBbdHJhY2tfbmFtZV1b
#7#Ol0KICAgICAgICBpZiBub3QgbGVuKHRyYWNrcyk6CiAgICAgICAgICAgIHJldHVybiBOb25lCiAg
#7#ICAgICAgdHJhY2tfb2JqZWN0cyA9IGdyb3VwW3RyYWNrb2JqX25hbWVdWzpdCiAgICAgICAgdGlt
#7#ZV9vZmZzZXRzID0gZ3JvdXBbIlNwb3RUaW1lT2Zmc2V0Il1bOl0gaWYgIlNwb3RUaW1lT2Zmc2V0
#7#IiBpbiBncm91cCBlbHNlIFtdCgogICAgICAgICMgU3BvdCAtPiB0aW1lcG9pbnQuIFNwb3RUaW1l
#7#T2Zmc2V0IHNsaWNlcyB0aGUgU3BvdCB0YWJsZSBQT1NJVElPTkFMTFksIG9uZSBzbGljZSBwZXIK
#7#ICAgICAgICAjIGZyYW1lOyBzcG90IGlkcyBhcmUgbm90IG9yZGVyZWQgYW5kIG11c3Qgbm90IGJl
#7#IHVzZWQgYXMgaW5kaWNlcyBoZXJlLgogICAgICAgIHRpbWVfb2Zfc3BvdCA9IHt9CiAgICAgICAg
#7#Zm9yIHJvdyBpbiB0aW1lX29mZnNldHM6CiAgICAgICAgICAgIGZyYW1lLCBiZWdpbiwgZW5kID0g
#7#aW50KHJvd1swXSksIGludChyb3dbMV0pLCBpbnQocm93WzJdKQogICAgICAgICAgICBmb3IgcyBp
#7#biBzcG90W2JlZ2luOmVuZF06CiAgICAgICAgICAgICAgICB0aW1lX29mX3Nwb3RbaW50KHNbMF0p
#7#XSA9IGZyYW1lICsgU0NFTkU4X1RJTUVfQkFTRQoKICAgICAgICAjIFNwb3QgLT4gdHJhY2ssIHNh
#7#bWUgcG9zaXRpb25hbCBzbGljaW5nIGludG8gdGhlIHRyYWNrLW9iamVjdCB0YWJsZS4KICAgICAg
#7#ICB0cmFja19vZl9zcG90ID0ge30KICAgICAgICBmb3Igcm93IGluIHRyYWNrczoKICAgICAgICAg
#7#ICAgdGlkLCBiZWdpbiwgZW5kID0gaW50KHJvd1swXSksIGludChyb3dbMV0pLCBpbnQocm93WzJd
#7#KQogICAgICAgICAgICBmb3Igb2JqIGluIHRyYWNrX29iamVjdHNbYmVnaW46ZW5kXToKICAgICAg
#7#ICAgICAgICAgIHRyYWNrX29mX3Nwb3RbaW50KG9ialswXSldID0gdGlkCgogICAgICAgIHNwb3Rf
#7#aWRzID0ge2ludChzWzBdKSBmb3IgcyBpbiBzcG90fQogICAgICAgIHRyYWNrX2lkcyA9IHtpbnQo
#7#dFswXSkgZm9yIHQgaW4gdHJhY2tzfQogICAgICAgIHNwb3RfbGFiZWxzLCB0cmFja19sYWJlbHMg
#7#PSBfc2NlbmU4X2xhYmVscyhncm91cCwgc3BvdF9pZHMsIHRyYWNrX2lkcykKCiAgICAgICAgIyBB
#7#IHNwb3QtbGV2ZWwgY2xhc3NpZmljYXRpb24gaXMgdGhlIGdyb3VuZCB0cnV0aDsgYSB0cmFjay1s
#7#ZXZlbCBvbmUgaXMgc2Vjb25kIGJlc3QKICAgICAgICAjIChpdCBwYWludHMgZXZlcnkgc3BvdCBv
#7#ZiBhIHRyYWNrIHdpdGggdGhlIHRyYWNrJ3MgbGFiZWwpLiBXaWRlc3QgY292ZXJhZ2Ugd2lucy4K
#7#ICAgICAgICByZWdpb25fb2Zfc3BvdCwgcmVnaW9uX3NvdXJjZSA9IHt9LCBOb25lCiAgICAgICAg
#7#aWYgc3BvdF9sYWJlbHM6CiAgICAgICAgICAgIGduYW1lLCBtYXBwaW5nID0gbWF4KHNwb3RfbGFi
#7#ZWxzLml0ZW1zKCksIGtleT1sYW1iZGEga3Y6IGxlbihrdlsxXSkpCiAgICAgICAgICAgIHJlZ2lv
#7#bl9vZl9zcG90ID0gZGljdChtYXBwaW5nKQogICAgICAgICAgICByZWdpb25fc291cmNlID0gZiJ7
#7#Z25hbWV9IChzcG90cykiCiAgICAgICAgZWxpZiB0cmFja19sYWJlbHM6CiAgICAgICAgICAgIGdu
#7#YW1lLCBtYXBwaW5nID0gbWF4KHRyYWNrX2xhYmVscy5pdGVtcygpLCBrZXk9bGFtYmRhIGt2OiBs
#7#ZW4oa3ZbMV0pKQogICAgICAgICAgICByZWdpb25fb2Zfc3BvdCA9IHtzaWQ6IG1hcHBpbmdbdGlk
#7#XSBmb3Igc2lkLCB0aWQgaW4gdHJhY2tfb2Zfc3BvdC5pdGVtcygpIGlmIHRpZCBpbiBtYXBwaW5n
#7#fQogICAgICAgICAgICByZWdpb25fc291cmNlID0gZiJ7Z25hbWV9IChwaXN0ZXMpIgoKICAgICAg
#7#ICByb3dzID0gW10KICAgICAgICB1bnRpbWVkID0gMAogICAgICAgIGZvciBzIGluIHNwb3Q6CiAg
#7#ICAgICAgICAgIHNpZCA9IGludChzWzBdKQogICAgICAgICAgICBmcmFtZSA9IHRpbWVfb2Zfc3Bv
#7#dC5nZXQoc2lkKQogICAgICAgICAgICBpZiBmcmFtZSBpcyBOb25lOgogICAgICAgICAgICAgICAg
#7#dW50aW1lZCArPSAxCiAgICAgICAgICAgICAgICBjb250aW51ZQogICAgICAgICAgICByb3dzLmFw
#7#cGVuZCh7CiAgICAgICAgICAgICAgICAiY2VsbF9pZCI6IHNpZCwKICAgICAgICAgICAgICAgICJ0
#7#aW1lcG9pbnQiOiBmbG9hdChmcmFtZSksCiAgICAgICAgICAgICAgICAieCI6IGZsb2F0KHNbMV0p
#7#LAogICAgICAgICAgICAgICAgInkiOiBmbG9hdChzWzJdKSwKICAgICAgICAgICAgICAgICJ6Ijog
#7#ZmxvYXQoc1szXSksCiAgICAgICAgICAgICAgICAidHJhY2tfaWQiOiB0cmFja19vZl9zcG90Lmdl
#7#dChzaWQpLAogICAgICAgICAgICAgICAgInJlZ2lvbiI6IHJlZ2lvbl9vZl9zcG90LmdldChzaWQs
#7#ICJVbmtub3duIiksCiAgICAgICAgICAgIH0pCgogICAgcmV0dXJuIHsKICAgICAgICAicm93cyI6
#7#IHJvd3MsCiAgICAgICAgInJlZ2lvblNvdXJjZSI6IHJlZ2lvbl9zb3VyY2UsCiAgICAgICAgIndh
#7#cm5pbmdzIjogKFtmInt1bnRpbWVkfSBzcG90cyBzYW5zIHRpbWVwb2ludCBpZ25vcmVzIl0gaWYg
#7#dW50aW1lZCBlbHNlIFtdKSwKICAgICAgICAicHJvdmVuYW5jZSI6IHsKICAgICAgICAgICAgImtp
#7#bmQiOiAic2NlbmU4IiwKICAgICAgICAgICAgImZpbGUiOiBpbXNfcGF0aC5uYW1lLAogICAgICAg
#7#ICAgICAib2JqZWN0Ijogb2JqX2tleSwKICAgICAgICAgICAgInNwb3RzIjogbGVuKHJvd3MpLAog
#7#ICAgICAgICAgICAidHJhY2tzIjogbGVuKHRyYWNrcyksCiAgICAgICAgICAgICJyZWdpb25Db2x1
#7#bW4iOiByZWdpb25fc291cmNlLAogICAgICAgICAgICAidGltZUJhc2UiOiBTQ0VORThfVElNRV9C
#7#QVNFLAogICAgICAgIH0sCiAgICB9CgoKIyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#7#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#7#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#7#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#7#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKIyAgU291cmNlIDMg4oCUIHRoZSBJbWFyaXMg
#7#c3RhdGlzdGljcyB3b3JrYm9vawojIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#7#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#7#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#7#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#7#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKZGVmIF9yZWFkX3dvcmtib29rKHBhdGg6IFBhdGgp
#7#OgogICAgIiIiWyhzaGVldCBuYW1lLCBbcm93cyBvZiB2YWx1ZXNdKV0gZm9yIC54bHMgKEJJRkYp
#7#IGFuZCAueGxzeCBhbGlrZS4iIiIKICAgIHN1ZmZpeCA9IHBhdGguc3VmZml4Lmxvd2VyKCkKICAg
#7#IGlmIHN1ZmZpeCA9PSAiLnhscyI6CiAgICAgICAgdHJ5OgogICAgICAgICAgICBpbXBvcnQgeGxy
#7#ZAogICAgICAgIGV4Y2VwdCBJbXBvcnRFcnJvciBhcyBleGM6CiAgICAgICAgICAgIHJhaXNlIFJ1
#7#bnRpbWVFcnJvcigKICAgICAgICAgICAgICAgICJsZWN0dXJlIGQndW4gLnhscyBJbWFyaXMgOiBs
#7#ZSBwYXF1ZXQgJ3hscmQnIGVzdCByZXF1aXMgKHBpcCBpbnN0YWxsIHhscmQpIgogICAgICAgICAg
#7#ICApIGZyb20gZXhjCiAgICAgICAgYm9vayA9IHhscmQub3Blbl93b3JrYm9vayhzdHIocGF0aCks
#7#IG9uX2RlbWFuZD1UcnVlKQogICAgICAgIHRyeToKICAgICAgICAgICAgZm9yIGluZGV4LCBuYW1l
#7#IGluIGVudW1lcmF0ZShib29rLnNoZWV0X25hbWVzKCkpOgogICAgICAgICAgICAgICAgc2hlZXQg
#7#PSBib29rLnNoZWV0X2J5X2luZGV4KGluZGV4KQogICAgICAgICAgICAgICAgeWllbGQgbmFtZSwg
#7#W3NoZWV0LnJvd192YWx1ZXMocikgZm9yIHIgaW4gcmFuZ2Uoc2hlZXQubnJvd3MpXQogICAgICAg
#7#ICAgICAgICAgYm9vay51bmxvYWRfc2hlZXQoaW5kZXgpCiAgICAgICAgZmluYWxseToKICAgICAg
#7#ICAgICAgYm9vay5yZWxlYXNlX3Jlc291cmNlcygpCiAgICAgICAgcmV0dXJuCgogICAgdHJ5Ogog
#7#ICAgICAgIGltcG9ydCBvcGVucHl4bAogICAgZXhjZXB0IEltcG9ydEVycm9yIGFzIGV4YzoKICAg
#7#ICAgICByYWlzZSBSdW50aW1lRXJyb3IoCiAgICAgICAgICAgICJsZWN0dXJlIGQndW4gLnhsc3gg
#7#SW1hcmlzIDogbGUgcGFxdWV0ICdvcGVucHl4bCcgZXN0IHJlcXVpcyAocGlwIGluc3RhbGwgb3Bl
#7#bnB5eGwpIgogICAgICAgICkgZnJvbSBleGMKICAgIGJvb2sgPSBvcGVucHl4bC5sb2FkX3dvcmti
#7#b29rKHN0cihwYXRoKSwgcmVhZF9vbmx5PVRydWUsIGRhdGFfb25seT1UcnVlKQogICAgdHJ5Ogog
#7#ICAgICAgIGZvciBzaGVldCBpbiBib29rLndvcmtzaGVldHM6CiAgICAgICAgICAgIHlpZWxkIHNo
#7#ZWV0LnRpdGxlLCBbbGlzdChyb3cpIGZvciByb3cgaW4gc2hlZXQuaXRlcl9yb3dzKHZhbHVlc19v
#7#bmx5PVRydWUpXQogICAgZmluYWxseToKICAgICAgICBib29rLmNsb3NlKCkKCgpkZWYgX2hlYWRl
#7#cl9pbmRleChyb3dzLCBuZWVkbGVzKToKICAgICIiIlJvdyBpbmRleCBvZiB0aGUgaGVhZGVyIGxp
#7#bmUsIHNlYXJjaGVkIGluIHRoZSBmaXJzdCBmZXcgcm93cy4KCiAgICBJbWFyaXMgcHJlZml4ZXMg
#7#ZWFjaCBzaGVldCB3aXRoIGl0cyBvd24gdGl0bGUgbGluZSwgc28gdGhlIGhlYWRlciBpcyBvbiBy
#7#b3cgMiB0aGVyZSwKICAgIHdoaWxlIGEgaGFuZC1mbGF0dGVuZWQgdGFibGUgaGFzIGl0IG9uIHJv
#7#dyAxLiBCb3RoIGFyZSBhY2NlcHRlZC4KICAgICIiIgogICAgZm9yIGksIHJvdyBpbiBlbnVtZXJh
#7#dGUocm93c1s6Nl0pOgogICAgICAgIGNlbGxzID0ge3N0cihjKS5zdHJpcCgpLmxvd2VyKCkgZm9y
#7#IGMgaW4gcm93IGlmIGMgaXMgbm90IE5vbmV9CiAgICAgICAgaWYgYWxsKG4gaW4gY2VsbHMgZm9y
#7#IG4gaW4gbmVlZGxlcyk6CiAgICAgICAgICAgIHJldHVybiBpCiAgICByZXR1cm4gTm9uZQoKCmRl
#7#ZiBfcGlja19wb3NpdGlvbl9zaGVldChwYXRoOiBQYXRoKToKICAgICIiIlRoZSBzaGVldCBjYXJy
#7#eWluZyBvbmUgcm93IHBlciBzcG90IHBlciB0aW1lcG9pbnQsIHBsdXMgaXRzIGhlYWRlciByb3cu
#7#IiIiCiAgICBmYWxsYmFjayA9IE5vbmUKICAgIGZvciBuYW1lLCByb3dzIGluIF9yZWFkX3dvcmti
#7#b29rKHBhdGgpOgogICAgICAgIGlmIG5vdCByb3dzOgogICAgICAgICAgICBjb250aW51ZQogICAg
#7#ICAgIGhlYWQgPSBfaGVhZGVyX2luZGV4KHJvd3MsICgicG9zaXRpb24geCIsICJwb3NpdGlvbiB5
#7#IiwgInBvc2l0aW9uIHoiKSkKICAgICAgICBpZiBoZWFkIGlzIG5vdCBOb25lOgogICAgICAgICAg
#7#ICByZXR1cm4gbmFtZSwgcm93cywgaGVhZCwgImltYXJpcy1zdGF0aXN0aWNzIgogICAgICAgIGlm
#7#IGZhbGxiYWNrIGlzIE5vbmU6CiAgICAgICAgICAgIGhlYWQgPSBfaGVhZGVyX2luZGV4KHJvd3Ms
#7#ICgieCIsICJ5IiwgInoiKSkKICAgICAgICAgICAgaWYgaGVhZCBpcyBub3QgTm9uZToKICAgICAg
#7#ICAgICAgICAgIGZhbGxiYWNrID0gKG5hbWUsIHJvd3MsIGhlYWQsICJmbGF0LXRhYmxlIikKICAg
#7#IHJldHVybiBmYWxsYmFjayBpZiBmYWxsYmFjayBlbHNlIChOb25lLCBOb25lLCBOb25lLCBOb25l
#7#KQoKCmRlZiByZWFkX2V4Y2VsKHBhdGgpIC0+IGRpY3Q6CiAgICAiIiJGbGF0IHBlci1zcG90IHRh
#7#YmxlIHJlYWQgZnJvbSBhbiBJbWFyaXMgc3RhdGlzdGljcyB3b3JrYm9vay4iIiIKICAgIHBhdGgg
#7#PSBQYXRoKHBhdGgpCiAgICBzaGVldF9uYW1lLCByb3dzLCBoZWFkLCBsYXlvdXQgPSBfcGlja19w
#7#b3NpdGlvbl9zaGVldChwYXRoKQogICAgaWYgcm93cyBpcyBOb25lOgogICAgICAgIHJhaXNlIFZh
#7#bHVlRXJyb3IoZiJ7cGF0aC5uYW1lfTogYXVjdW5lIGZldWlsbGUgZGUgcG9zaXRpb25zIChQb3Np
#7#dGlvbiBYL1kvWikgdHJvdXZlZSIpCgogICAgaGVhZGVyID0gW3N0cihjKS5zdHJpcCgpIGlmIGMg
#7#aXMgbm90IE5vbmUgZWxzZSAiIiBmb3IgYyBpbiByb3dzW2hlYWRdXQogICAgbG93ZXIgPSBbaC5s
#7#b3dlcigpIGZvciBoIGluIGhlYWRlcl0KCiAgICBkZWYgY29sKCphbGlhc2VzKToKICAgICAgICBm
#7#b3IgYWxpYXMgaW4gYWxpYXNlczoKICAgICAgICAgICAgaWYgYWxpYXMgaW4gbG93ZXI6CiAgICAg
#7#ICAgICAgICAgICByZXR1cm4gbG93ZXIuaW5kZXgoYWxpYXMpCiAgICAgICAgcmV0dXJuIE5vbmUK
#7#CiAgICBpeCA9IGNvbCgicG9zaXRpb24geCIsICJ4IiwgInhfdW0iKQogICAgaXkgPSBjb2woInBv
#7#c2l0aW9uIHkiLCAieSIsICJ5X3VtIikKICAgIGl6ID0gY29sKCJwb3NpdGlvbiB6IiwgInoiLCAi
#7#el91bSIpCiAgICBpdCA9IGNvbCgidGltZSIsICJ0aW1lcG9pbnQiLCAidGltZSBpbmRleCIsICJm
#7#cmFtZSIsICJ0IikKICAgIGlpZCA9IGNvbCgiaWQiLCAiY2VsbF9pZCIsICJzcG90X2lkIiwgIm9i
#7#amVjdF9pZCIpCiAgICBpdHJhY2sgPSBjb2woInRyYWNraWQiLCAidHJhY2tfaWQiLCAidHJhY2sg
#7#aWQiKQoKICAgIGlmIE5vbmUgaW4gKGl4LCBpeSwgaXopOgogICAgICAgIHJhaXNlIFZhbHVlRXJy
#7#b3IoZiJ7cGF0aC5uYW1lfSAvIHtzaGVldF9uYW1lfTogY29sb25uZXMgZGUgcG9zaXRpb24gaW50
#7#cm91dmFibGVzIikKCiAgICAjIFdoYXRldmVyIGhlYWRlciBJbWFyaXMgZGlkIG5vdCBwdXQgdGhl
#7#cmUgaXRzZWxmIGlzIHRoZSBiaW9sb2dpc3QncyBjbGFzc2lmaWNhdGlvbi4KICAgIGlyZWcgPSBj
#7#b2woInJlZ2lvbiIsICJncm91cCIsICJwb3B1bGF0aW9uIiwgImNsYXNzIikKICAgIHJlZ2lvbl9u
#7#YW1lID0gaGVhZGVyW2lyZWddIGlmIGlyZWcgaXMgbm90IE5vbmUgZWxzZSBOb25lCiAgICBpZiBp
#7#cmVnIGlzIE5vbmU6CiAgICAgICAgZm9yIGksIG5hbWUgaW4gZW51bWVyYXRlKGxvd2VyKToKICAg
#7#ICAgICAgICAgaWYgbmFtZSBhbmQgbmFtZSBub3QgaW4gX1BPU0lUSU9OX1JFU0VSVkVEOgogICAg
#7#ICAgICAgICAgICAgaXJlZywgcmVnaW9uX25hbWUgPSBpLCBoZWFkZXJbaV0KICAgICAgICAgICAg
#7#ICAgIGJyZWFrCgogICAgb3V0LCBza2lwcGVkID0gW10sIDAKICAgIGZvciByYXcgaW4gcm93c1to
#7#ZWFkICsgMTpdOgogICAgICAgIGlmIHJhdyBpcyBOb25lIG9yIGxlbihyYXcpIDw9IG1heChpeCwg
#7#aXksIGl6KToKICAgICAgICAgICAgc2tpcHBlZCArPSAxCiAgICAgICAgICAgIGNvbnRpbnVlCiAg
#7#ICAgICAgdHJ5OgogICAgICAgICAgICB4LCB5LCB6ID0gZmxvYXQocmF3W2l4XSksIGZsb2F0KHJh
#7#d1tpeV0pLCBmbG9hdChyYXdbaXpdKQogICAgICAgIGV4Y2VwdCAoVHlwZUVycm9yLCBWYWx1ZUVy
#7#cm9yKToKICAgICAgICAgICAgc2tpcHBlZCArPSAxCiAgICAgICAgICAgIGNvbnRpbnVlCiAgICAg
#7#ICAgZW50cnkgPSB7IngiOiB4LCAieSI6IHksICJ6Ijogen0KICAgICAgICBlbnRyeVsidGltZXBv
#7#aW50Il0gPSBfYXNfZmxvYXQocmF3W2l0XSkgaWYgaXQgaXMgbm90IE5vbmUgZWxzZSAxLjAKICAg
#7#ICAgICBlbnRyeVsiY2VsbF9pZCJdID0gX2FzX2Zsb2F0KHJhd1tpaWRdKSBpZiBpaWQgaXMgbm90
#7#IE5vbmUgZWxzZSBmbG9hdChsZW4ob3V0KSArIDEpCiAgICAgICAgZW50cnlbInRyYWNrX2lkIl0g
#7#PSBfYXNfZmxvYXQocmF3W2l0cmFja10pIGlmIGl0cmFjayBpcyBub3QgTm9uZSBlbHNlIE5vbmUK
#7#ICAgICAgICByZWdpb24gPSByYXdbaXJlZ10gaWYgaXJlZyBpcyBub3QgTm9uZSBhbmQgaXJlZyA8
#7#IGxlbihyYXcpIGVsc2UgTm9uZQogICAgICAgIGVudHJ5WyJyZWdpb24iXSA9IHN0cihyZWdpb24p
#7#LnN0cmlwKCkgaWYgcmVnaW9uIG5vdCBpbiAoTm9uZSwgIiIpIGVsc2UgIlVua25vd24iCiAgICAg
#7#ICAgaWYgZW50cnlbInRpbWVwb2ludCJdIGlzIE5vbmUgb3IgZW50cnlbImNlbGxfaWQiXSBpcyBO
#7#b25lOgogICAgICAgICAgICBza2lwcGVkICs9IDEKICAgICAgICAgICAgY29udGludWUKICAgICAg
#7#ICBvdXQuYXBwZW5kKGVudHJ5KQoKICAgIGlmIG5vdCBvdXQ6CiAgICAgICAgcmFpc2UgVmFsdWVF
#7#cnJvcihmIntwYXRoLm5hbWV9IC8ge3NoZWV0X25hbWV9OiBhdWN1bmUgbGlnbmUgZXhwbG9pdGFi
#7#bGUiKQoKICAgIHdhcm5pbmdzID0gW2Yie3NraXBwZWR9IGxpZ25lcyBpZ25vcmVlcyAodmFsZXVy
#7#cyBtYW5xdWFudGVzKSJdIGlmIHNraXBwZWQgZWxzZSBbXQogICAgIyBUaGUgdGltZSBjb2x1bW4g
#7#aXMgcmVhZCBhcyBhIGZyYW1lIGluZGV4LiBJbWFyaXMgd3JpdGVzIG9uZSB0aGVyZTsgYSB3b3Jr
#7#Ym9vayB3aG9zZQogICAgIyB0aW1lcyBhcmUgZnJhY3Rpb25hbCB3YXMgZXhwb3J0ZWQgaW4gc2Vj
#7#b25kcyBvciBob3VycyBhbmQgd291bGQgYmUgbWlzcGxhY2VkLgogICAgZnJhY3Rpb25hbCA9IHN1
#7#bSgxIGZvciBlIGluIG91dCBpZiBmbG9hdChlWyJ0aW1lcG9pbnQiXSkgIT0gaW50KGVbInRpbWVw
#7#b2ludCJdKSkKICAgIGlmIGZyYWN0aW9uYWw6CiAgICAgICAgd2FybmluZ3MuYXBwZW5kKGYie2Zy
#7#YWN0aW9uYWx9IHZhbGV1cnMgZGUgdGVtcHMgbm9uIGVudGllcmVzIGRhbnMgJ3toZWFkZXJbaXRd
#7#fScgOiAiCiAgICAgICAgICAgICAgICAgICAgICAgIGYibGEgY29sb25uZSBlc3QgbHVlIGNvbW1l
#7#IHVuIG51bWVybyBkZSBmcmFtZSDigJQgdmVyaWZpZXogbCdleHBvcnQiKQoKICAgIHJldHVybiB7
#7#CiAgICAgICAgInJvd3MiOiBvdXQsCiAgICAgICAgInJlZ2lvblNvdXJjZSI6IHJlZ2lvbl9uYW1l
#7#LAogICAgICAgICJ3YXJuaW5ncyI6IHdhcm5pbmdzLAogICAgICAgICJwcm92ZW5hbmNlIjogewog
#7#ICAgICAgICAgICAia2luZCI6ICJleGNlbCIsCiAgICAgICAgICAgICJmaWxlIjogcGF0aC5uYW1l
#7#LAogICAgICAgICAgICAic2hlZXQiOiBzaGVldF9uYW1lLAogICAgICAgICAgICAibGF5b3V0Ijog
#7#bGF5b3V0LAogICAgICAgICAgICAic3BvdHMiOiBsZW4ob3V0KSwKICAgICAgICAgICAgInJlZ2lv
#7#bkNvbHVtbiI6IHJlZ2lvbl9uYW1lLAogICAgICAgIH0sCiAgICB9CgoKZGVmIF9hc19mbG9hdCh2
#7#YWx1ZSk6CiAgICBpZiB2YWx1ZSBpcyBOb25lIG9yIHZhbHVlID09ICIiOgogICAgICAgIHJldHVy
#7#biBOb25lCiAgICB0cnk6CiAgICAgICAgcmV0dXJuIGZsb2F0KHZhbHVlKQogICAgZXhjZXB0IChU
#7#eXBlRXJyb3IsIFZhbHVlRXJyb3IpOgogICAgICAgIHJldHVybiBOb25lCgoKIyDilIDilIDilIDi
#7#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#7#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#7#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#7#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKIyAgUmF3
#7#IHRhYmxlIC0+IElNQVJJU19UUkFDS0VSX1YxIGNvbnRhaW5lcgojIOKUgOKUgOKUgOKUgOKUgOKU
#7#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#7#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#7#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#7#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKX0FOQUxZU0lTX01P
#7#RFVMRSA9IE5vbmUKCgpkZWYgX2FuYWx5c2lzX2RpcnMoKToKICAgIGVudiA9IG9zLmVudmlyb24u
#7#Z2V0KCJMVU1FTjNEX1RSQUNLSU5HX1NDUklQVFMiKQogICAgaWYgZW52OgogICAgICAgIHlpZWxk
#7#IFBhdGgoZW52KQogICAgeWllbGQgU0NSSVBUX0RJUi5wYXJlbnQgLyAiU0NSSVBUUyIgICAgICAg
#7#ICAgICAgICMgcmVwbyBsYXlvdXQKICAgIHlpZWxkIFNDUklQVF9ESVIucGFyZW50IC8gInRyYWNr
#7#aW5nIiAvICJTQ1JJUFRTIiAgIyBwaXBlbGluZSBidW5kbGUgbGF5b3V0CiAgICB5aWVsZCBTQ1JJ
#7#UFRfRElSIC8gIlNDUklQVFMiCgoKZGVmIGxvYWRfYW5hbHlzaXMoKToKICAgICIiIkltcG9ydCB0
#7#aGUgbGFiJ3MgQW5hbHlzaXMucHkgYXMgYSBsaWJyYXJ5LgoKICAgIENlbGwgaWRlbnRpdHkgYWNy
#7#b3NzIGEgZGl2aXNpb24sIGxpbmVhZ2UgYW5kIHRoZSBLYWJzY2ggc3RhYmlsaXNhdGlvbiBhcmUg
#7#c2NpZW50aWZpYwogICAgY2hvaWNlcyB0aGF0IGFscmVhZHkgaGF2ZSBvbmUgaW1wbGVtZW50YXRp
#7#b247IGEgZGF0YXNldCB0YWtlbiB0aHJvdWdoIHRoaXMgc2hvcnRjdXQgbXVzdAogICAgY29tZSBv
#7#dXQgaWRlbnRpY2FsIHRvIG9uZSB0YWtlbiB0aHJvdWdoIHRoZSB0cmFja2luZyBwaXBlbGluZSwg
#7#c28gdGhhdCBpbXBsZW1lbnRhdGlvbiBpcwogICAgaW1wb3J0ZWQgcmF0aGVyIHRoYW4gbWlycm9y
#7#ZWQuCiAgICAiIiIKICAgIGdsb2JhbCBfQU5BTFlTSVNfTU9EVUxFCiAgICBpZiBfQU5BTFlTSVNf
#7#TU9EVUxFIGlzIG5vdCBOb25lOgogICAgICAgIHJldHVybiBfQU5BTFlTSVNfTU9EVUxFCgogICAg
#7#Zm9yIGRpcmVjdG9yeSBpbiBfYW5hbHlzaXNfZGlycygpOgogICAgICAgIHNjcmlwdCA9IGRpcmVj
#7#dG9yeSAvICJBbmFseXNpcy5weSIKICAgICAgICBpZiBub3Qgc2NyaXB0LmlzX2ZpbGUoKToKICAg
#7#ICAgICAgICAgY29udGludWUKICAgICAgICAjIGV4cG9ydF9odG1sLnB5IGlzIGltcG9ydGVkIGJ5
#7#IEFuYWx5c2lzLnB5IGFzIGEgdG9wLWxldmVsIHNpYmxpbmcuCiAgICAgICAgc3lzLnBhdGguaW5z
#7#ZXJ0KDAsIHN0cihkaXJlY3RvcnkucmVzb2x2ZSgpKSkKICAgICAgICB0cnk6CiAgICAgICAgICAg
#7#IHNwZWMgPSBpbXBvcnRsaWIudXRpbC5zcGVjX2Zyb21fZmlsZV9sb2NhdGlvbigibHVtZW5fdHJh
#7#Y2tpbmdfYW5hbHlzaXMiLCBzdHIoc2NyaXB0KSkKICAgICAgICAgICAgbW9kdWxlID0gaW1wb3J0
#7#bGliLnV0aWwubW9kdWxlX2Zyb21fc3BlYyhzcGVjKQogICAgICAgICAgICBzeXMubW9kdWxlcy5z
#7#ZXRkZWZhdWx0KCJsdW1lbl90cmFja2luZ19hbmFseXNpcyIsIG1vZHVsZSkKICAgICAgICAgICAg
#7#c3BlYy5sb2FkZXIuZXhlY19tb2R1bGUobW9kdWxlKQogICAgICAgIGV4Y2VwdCBFeGNlcHRpb24g
#7#YXMgZXhjOgogICAgICAgICAgICBzeXMucGF0aC5wb3AoMCkKICAgICAgICAgICAgcmFpc2UgUnVu
#7#dGltZUVycm9yKGYie3NjcmlwdH0gbidhIHBhcyBwdSBldHJlIGltcG9ydGUgOiB7ZXhjfSIpIGZy
#7#b20gZXhjCiAgICAgICAgX0FOQUxZU0lTX01PRFVMRSA9IG1vZHVsZQogICAgICAgIHJldHVybiBt
#7#b2R1bGUKCiAgICByYWlzZSBSdW50aW1lRXJyb3IoCiAgICAgICAgIkFuYWx5c2lzLnB5IGludHJv
#7#dXZhYmxlIChjaGVyY2hlIGRhbnMgIgogICAgICAgICsgIiwgIi5qb2luKHN0cihkKSBmb3IgZCBp
#7#biBfYW5hbHlzaXNfZGlycygpKQogICAgICAgICsgIikuIERlZmluaXNzZXogTFVNRU4zRF9UUkFD
#7#S0lOR19TQ1JJUFRTIHN1ciBsZSBkb3NzaWVyIFNDUklQVFMgZHUgcGlwZWxpbmUgZGUgdHJhY2tp
#7#bmcuIgogICAgKQoKCmRlZiBfcGFkZGVkX3JhbmdlKHZtaW4sIHZtYXgsIHBhZD0wLjA1KToKICAg
#7#IHNwYW4gPSB2bWF4IC0gdm1pbgogICAgaWYgc3BhbiA9PSAwOgogICAgICAgIHNwYW4gPSAxCiAg
#7#ICByZXR1cm4gW2Zsb2F0KHZtaW4gLSBzcGFuICogcGFkKSwgZmxvYXQodm1heCArIHNwYW4gKiBw
#7#YWQpXQoKCmRlZiBidWlsZF9jb250YWluZXIodGFibGU6IGRpY3QsIGRhdGFzZXRfbmFtZTogc3Ry
#7#LCB2ZXJib3NlOiBib29sID0gVHJ1ZSkgLT4gZGljdDoKICAgICIiIlR1cm4gYSBmbGF0IHBlci1z
#7#cG90IHRhYmxlIGludG8gYW4gSU1BUklTX1RSQUNLRVJfVjEgZG9jdW1lbnQuCgogICAgTWlycm9y
#7#cywgc3RlcCBmb3Igc3RlcCwgd2hhdCBgYEFuYWx5c2lzLnByb2Nlc3Nfc2FtcGxlYGAgZG9lcyBi
#7#ZXR3ZWVuIHJlYWRpbmcgdGhlIHdvcmtib29rCiAgICBhbmQgY2FsbGluZyBgYGV4cG9ydF9odG1s
#7#LmV4cG9ydF9pbWFyaXNfdHJhY2tgYCDigJQgd2hpY2ggaXMgdGhlIHNjaGVtYSB3cml0dGVuIGhl
#7#cmUuCiAgICAiIiIKICAgIHRyeToKICAgICAgICBpbXBvcnQgcGFuZGFzIGFzIHBkCiAgICBleGNl
#7#cHQgSW1wb3J0RXJyb3IgYXMgZXhjOgogICAgICAgIHJhaXNlIFJ1bnRpbWVFcnJvcigKICAgICAg
#7#ICAgICAgImwnZXh0cmFjdGlvbiBkdSB0cmFja2luZyBkZXB1aXMgdW4gLmltcy8ueGxzIGRlbWFu
#7#ZGUgJ3BhbmRhcycgKHBpcCBpbnN0YWxsIHBhbmRhcykiCiAgICAgICAgKSBmcm9tIGV4YwoKICAg
#7#IEEgPSBsb2FkX2FuYWx5c2lzKCkKCiAgICBkZiA9IHBkLkRhdGFGcmFtZSh0YWJsZVsicm93cyJd
#7#LCBjb2x1bW5zPVsiY2VsbF9pZCIsICJ0aW1lcG9pbnQiLCAieCIsICJ5IiwgInoiLAogICAgICAg
#7#ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgInRyYWNrX2lkIiwgInJlZ2lv
#7#biJdKQogICAgZGYgPSBBLnN0YW5kYXJkaXplX2lucHV0X2RhdGFmcmFtZShkZiwgc2FtcGxlX25h
#7#bWU9ZGF0YXNldF9uYW1lKQogICAgZGYgPSBBLmFzc2lnbl9zeW50aGV0aWNfdHJhY2tfaWRzKGRm
#7#KQoKICAgIGFzc2lnbmVyID0gQS5DZWxsSURBc3NpZ25lcigpCiAgICByZXN1bHQgPSBhc3NpZ25l
#7#ci5hc3NpZ25faWRzKGRmKQoKICAgIHJlc3VsdFsibWFya2VyX2NvbG9yIl0gPSAiIgogICAgZm9y
#7#IHRwLCBjaWQgaW4gYXNzaWduZXIubWl0b3Npc19tYXJrZXJzOgogICAgICAgIHJlc3VsdC5sb2Nb
#7#KHJlc3VsdFsidGltZXBvaW50Il0gPT0gdHApICYgKHJlc3VsdFsidW5pcXVlX2NlbGxfaWQiXSA9
#7#PSBjaWQpLCAibWFya2VyX2NvbG9yIl0gPSAicmVkIgogICAgZm9yIHRwLCBjaWQgaW4gYXNzaWdu
#7#ZXIuZnVzaW9uX21hcmtlcnM6CiAgICAgICAgcmVzdWx0LmxvY1socmVzdWx0WyJ0aW1lcG9pbnQi
#7#XSA9PSB0cCkgJiAocmVzdWx0WyJ1bmlxdWVfY2VsbF9pZCJdID09IGNpZCksICJtYXJrZXJfY29s
#7#b3IiXSA9ICJibGFjayIKCiAgICBpZiB2ZXJib3NlOgogICAgICAgIHByaW50KGYiICBbVFJBQ0tJ
#7#TkddIHtsZW4ocmVzdWx0KX0gc3BvdHMsIHtyZXN1bHRbJ3RyYWNrX2lkJ10ubnVuaXF1ZSgpfSBw
#7#aXN0ZXMsICIKICAgICAgICAgICAgICBmIntyZXN1bHRbJ3VuaXF1ZV9jZWxsX2lkJ10ubnVuaXF1
#7#ZSgpfSBjZWxsdWxlcywgIgogICAgICAgICAgICAgIGYie2xlbihhc3NpZ25lci5kYXVnaHRlcl9t
#7#YXApfSBtaXRvc2VzIikKICAgIHJlc3VsdCwgX2RpYWdub3N0aWNzID0gQS5zdGFiaWxpemVfY29v
#7#cmRpbmF0ZXMocmVzdWx0LCBhc3NpZ25lcikKCiAgICBwYWxldHRlID0gQS5SRUdJT05fUEFMRVRU
#7#RQogICAgcmVnaW9ucyA9IHNvcnRlZCh7c3RyKHIpIGZvciByIGluIHJlc3VsdFsicmVnaW9uIl0u
#7#dW5pcXVlKCl9LCBrZXk9c3RyKQogICAgcmVnaW9uX2NvbG9ycyA9IHtyOiBwYWxldHRlW2kgJSBs
#7#ZW4ocGFsZXR0ZSldIGZvciBpLCByIGluIGVudW1lcmF0ZShyZWdpb25zKX0KCiAgICBjZWxscyA9
#7#IFtdCiAgICBmb3IgY2lkLCBncnAgaW4gcmVzdWx0Lmdyb3VwYnkoInVuaXF1ZV9jZWxsX2lkIik6
#7#CiAgICAgICAgZ3JwID0gZ3JwLnNvcnRfdmFsdWVzKCJ0aW1lcG9pbnQiKQogICAgICAgIHJlZ2lv
#7#biA9IHN0cihncnBbInJlZ2lvbiJdLmlsb2NbMF0pCiAgICAgICAgcGFyZW50cyA9IGdycFsicGFy
#7#ZW50X2NlbGwiXS5kcm9wbmEoKQogICAgICAgIGRhdWdodGVycyA9IGdycFsiZGF1Z2h0ZXJfY2Vs
#7#bHMiXS5kcm9wbmEoKQogICAgICAgIGNlbGxzLmFwcGVuZCh7CiAgICAgICAgICAgICJpZCI6IGlu
#7#dChjaWQpLAogICAgICAgICAgICAidHJhY2tfaWQiOiBpbnQoZ3JwWyJ0cmFja19pZCJdLmlsb2Nb
#7#MF0pIGlmIGdycFsidHJhY2tfaWQiXS5ub3RuYSgpLmFueSgpIGVsc2UgTm9uZSwKICAgICAgICAg
#7#ICAgInJlZ2lvbiI6IHJlZ2lvbiwKICAgICAgICAgICAgImNvbG9yIjogcmVnaW9uX2NvbG9yc1ty
#7#ZWdpb25dLAogICAgICAgICAgICAidCI6IFtmbG9hdCh2KSBmb3IgdiBpbiBncnBbInRpbWVwb2lu
#7#dCJdXSwKICAgICAgICAgICAgIngiOiBbZmxvYXQodikgZm9yIHYgaW4gZ3JwWyJ4X3N0YWIiXV0s
#7#CiAgICAgICAgICAgICJ5IjogW2Zsb2F0KHYpIGZvciB2IGluIGdycFsieV9zdGFiIl1dLAogICAg
#7#ICAgICAgICAieiI6IFtmbG9hdCh2KSBmb3IgdiBpbiBncnBbInpfc3RhYiJdXSwKICAgICAgICAg
#7#ICAgInhfcmF3IjogW2Zsb2F0KHYpIGZvciB2IGluIGdycFsieCJdXSwKICAgICAgICAgICAgInlf
#7#cmF3IjogW2Zsb2F0KHYpIGZvciB2IGluIGdycFsieSJdXSwKICAgICAgICAgICAgInpfcmF3Ijog
#7#W2Zsb2F0KHYpIGZvciB2IGluIGdycFsieiJdXSwKICAgICAgICAgICAgIm1hcmtlcl9jb2xvciI6
#7#IGxpc3QoZ3JwWyJtYXJrZXJfY29sb3IiXSksCiAgICAgICAgICAgICJwYXJlbnRfY2VsbCI6IHN0
#7#cihwYXJlbnRzLmlsb2NbMF0pIGlmIGxlbihwYXJlbnRzKSBlbHNlICIiLAogICAgICAgICAgICAi
#7#ZGF1Z2h0ZXJfY2VsbHMiOiBzdHIoZGF1Z2h0ZXJzLmlsb2NbMF0pIGlmIGxlbihkYXVnaHRlcnMp
#7#IGVsc2UgIiIsCiAgICAgICAgfSkKCiAgICBwcm92ZW5hbmNlID0gZGljdCh0YWJsZS5nZXQoInBy
#7#b3ZlbmFuY2UiKSBvciB7fSkKICAgIHByb3ZlbmFuY2UudXBkYXRlKHsKICAgICAgICAiZXh0cmFj
#7#dGVkQnkiOiBmInRyYWNraW5nX3NvdXJjZXMucHkge19fdmVyc2lvbl9ffSIsCiAgICAgICAgImNl
#7#bGxzIjogbGVuKGNlbGxzKSwKICAgICAgICAic3RhYmlsaXphdGlvbiI6ICJzZXF1ZW50aWFsLWth
#7#YnNjaCAoQW5hbHlzaXMuc3RhYmlsaXplX2Nvb3JkaW5hdGVzKSIsCiAgICB9KQoKICAgIHJldHVy
#7#biB7CiAgICAgICAgInNpZ25hdHVyZSI6IFNJR05BVFVSRSwKICAgICAgICAiZGF0YXNldF9pZCI6
#7#IHN0cih1dWlkLnV1aWQ0KCkpLAogICAgICAgICJkYXRhc2V0X25hbWUiOiBkYXRhc2V0X25hbWUs
#7#CiAgICAgICAgImRhdGVfZ2VuZXJhdGlvbiI6IGRhdGV0aW1lLm5vdygpLmlzb2Zvcm1hdCgpLAog
#7#ICAgICAgICJkYXRhIjogewogICAgICAgICAgICAidGltZXBvaW50cyI6IHNvcnRlZChmbG9hdCh0
#7#KSBmb3IgdCBpbiByZXN1bHRbInRpbWVwb2ludCJdLnVuaXF1ZSgpKSwKICAgICAgICAgICAgImNl
#7#bGxzIjogY2VsbHMsCiAgICAgICAgICAgICJsYXlvdXQiOiB7CiAgICAgICAgICAgICAgICAieF9y
#7#YW5nZSI6IF9wYWRkZWRfcmFuZ2UocmVzdWx0WyJ4X3N0YWIiXS5taW4oKSwgcmVzdWx0WyJ4X3N0
#7#YWIiXS5tYXgoKSksCiAgICAgICAgICAgICAgICAieV9yYW5nZSI6IF9wYWRkZWRfcmFuZ2UocmVz
#7#dWx0WyJ5X3N0YWIiXS5taW4oKSwgcmVzdWx0WyJ5X3N0YWIiXS5tYXgoKSksCiAgICAgICAgICAg
#7#ICAgICAiel9yYW5nZSI6IF9wYWRkZWRfcmFuZ2UocmVzdWx0WyJ6X3N0YWIiXS5taW4oKSwgcmVz
#7#dWx0WyJ6X3N0YWIiXS5tYXgoKSksCiAgICAgICAgICAgIH0sCiAgICAgICAgICAgICJwcm92ZW5h
#7#bmNlIjogcHJvdmVuYW5jZSwKICAgICAgICB9LAogICAgfQoKCmRlZiB3cml0ZV9jb250YWluZXIo
#7#ZG9jOiBkaWN0LCBwYXRoKSAtPiBQYXRoOgogICAgcGF0aCA9IFBhdGgocGF0aCkKICAgIHBhdGgu
#7#cGFyZW50Lm1rZGlyKHBhcmVudHM9VHJ1ZSwgZXhpc3Rfb2s9VHJ1ZSkKICAgIHdpdGggZ3ppcC5v
#7#cGVuKHN0cihwYXRoKSwgIndiIikgYXMgZmg6CiAgICAgICAgZmgud3JpdGUoU0lHTkFUVVJFLmVu
#7#Y29kZSgpICsgYiJcbiIpCiAgICAgICAgZmgud3JpdGUoanNvbi5kdW1wcyhkb2MsIGVuc3VyZV9h
#7#c2NpaT1GYWxzZSwgc2VwYXJhdG9ycz0oIiwiLCAiOiIpKS5lbmNvZGUoInV0Zi04IikpCiAgICBy
#7#ZXR1cm4gcGF0aAoKCiMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#7#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#7#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#7#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#7#4pSA4pSA4pSA4pSA4pSA4pSACiMgIFRvcCBsZXZlbAojIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#7#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#7#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#7#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#7#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKZGVmIHJlYWRfc291cmNlKHNv
#7#dXJjZTogVHJhY2tpbmdTb3VyY2UpIC0+IGRpY3Q6CiAgICBpZiBzb3VyY2Uua2luZCA9PSAic2Nl
#7#bmU4IjoKICAgICAgICByZXR1cm4gcmVhZF9zY2VuZTgoc291cmNlLnBhdGgpCiAgICBpZiBzb3Vy
#7#Y2Uua2luZCA9PSAiZXhjZWwiOgogICAgICAgIHJldHVybiByZWFkX2V4Y2VsKHNvdXJjZS5wYXRo
#7#KQogICAgcmFpc2UgVmFsdWVFcnJvcihmInNvdXJjZSB7c291cmNlLmtpbmR9IGlzIGFscmVhZHkg
#7#YSBjb250YWluZXIiKQoKCmRlZiBfbWVyZ2VfcmVnaW9uc19mcm9tX2V4Y2VsKHRhYmxlOiBkaWN0
#7#LCBpbXNfcGF0aDogUGF0aCwgdmVyYm9zZTogYm9vbCkgLT4gTm9uZToKICAgICIiIkZpbGwgaW4g
#7#YSBtaXNzaW5nIGNsYXNzaWZpY2F0aW9uIGZyb20gYSBzaWRlY2FyIHdvcmtib29rLCBtYXRjaGVk
#7#IG9uIHNwb3QgaWQuCgogICAgQSB2b2x1bWUgY2FuIGhvbGQgaXRzIFNwb3RzIG9iamVjdHMgd2hp
#7#bGUgdGhlIGNsYXNzaWZpY2F0aW9uIHdhcyBvbmx5IGV2ZXIgYXBwbGllZCBpbiB0aGUKICAgIGNv
#7#cHkgdGhlIGJpb2xvZ2lzdCBleHBvcnRlZCBzdGF0aXN0aWNzIGZyb20uIFRoZSBpZHMgYXJlIElt
#7#YXJpcyBvYmplY3QgaWRzIGFuZCBpZGVudGlmeQogICAgdGhlIHNhbWUgc3BvdHMgYWNyb3NzIGJv
#7#dGggZmlsZXMsIHNvIHRoZSBsYWJlbHMgY2FuIGJlIGNhcnJpZWQgb3ZlciB3aXRob3V0IHRvdWNo
#7#aW5nIGEKICAgIHNpbmdsZSBjb29yZGluYXRlLgogICAgIiIiCiAgICBpZiB0YWJsZS5nZXQoInJl
#7#Z2lvblNvdXJjZSIpOgogICAgICAgIHJldHVybgogICAgZm9yIGNhbmQgaW4gX3NpZGVjYXJfY2Fu
#7#ZGlkYXRlcyhpbXNfcGF0aCwgRVhDRUxfU1VGRklYRVMpOgogICAgICAgIHRyeToKICAgICAgICAg
#7#ICAgc2lkZSA9IHJlYWRfZXhjZWwoY2FuZCkKICAgICAgICBleGNlcHQgRXhjZXB0aW9uOgogICAg
#7#ICAgICAgICBjb250aW51ZQogICAgICAgIGlmIGxlbihzaWRlWyJyb3dzIl0pICE9IGxlbih0YWJs
#7#ZVsicm93cyJdKSBhbmQgdmVyYm9zZToKICAgICAgICAgICAgcHJpbnQoZiIgIFtUUkFDS0lOR10g
#7#WyFdIHtjYW5kLm5hbWV9IGNvbXB0ZSB7bGVuKHNpZGVbJ3Jvd3MnXSl9IHNwb3RzLCBsJ29iamV0
#7#IEltYXJpcyAiCiAgICAgICAgICAgICAgICAgIGYiZHUgdm9sdW1lIHtsZW4odGFibGVbJ3Jvd3Mn
#7#XSl9IDogbGUgY2xhc3NldXIgbidlc3QgcGV1dC1ldHJlIHBhcyBhIGpvdXIiKQogICAgICAgIGlm
#7#IG5vdCBzaWRlLmdldCgicmVnaW9uU291cmNlIik6CiAgICAgICAgICAgIGNvbnRpbnVlCiAgICAg
#7#ICAgbGFiZWxzID0ge2ludChyWyJjZWxsX2lkIl0pOiByWyJyZWdpb24iXSBmb3IgciBpbiBzaWRl
#7#WyJyb3dzIl0gaWYgci5nZXQoInJlZ2lvbiIpfQogICAgICAgIGhpdHMgPSAwCiAgICAgICAgZm9y
#7#IHJvdyBpbiB0YWJsZVsicm93cyJdOgogICAgICAgICAgICBsYWJlbCA9IGxhYmVscy5nZXQoaW50
#7#KHJvd1siY2VsbF9pZCJdKSkKICAgICAgICAgICAgaWYgbGFiZWwgYW5kIGxhYmVsICE9ICJVbmtu
#7#b3duIjoKICAgICAgICAgICAgICAgIHJvd1sicmVnaW9uIl0gPSBsYWJlbAogICAgICAgICAgICAg
#7#ICAgaGl0cyArPSAxCiAgICAgICAgaWYgaGl0czoKICAgICAgICAgICAgdGFibGVbInJlZ2lvblNv
#7#dXJjZSJdID0gZiJ7c2lkZVsncmVnaW9uU291cmNlJ119ICh2aWEge2NhbmQubmFtZX0pIgogICAg
#7#ICAgICAgICB0YWJsZVsicHJvdmVuYW5jZSJdWyJyZWdpb25Db2x1bW4iXSA9IHRhYmxlWyJyZWdp
#7#b25Tb3VyY2UiXQogICAgICAgICAgICB0YWJsZVsicHJvdmVuYW5jZSJdWyJyZWdpb25GaWxlIl0g
#7#PSBjYW5kLm5hbWUKICAgICAgICAgICAgaWYgdmVyYm9zZToKICAgICAgICAgICAgICAgIHByaW50
#7#KGYiICBbVFJBQ0tJTkddIGNsYXNzaWZpY2F0aW9uIHJlcHJpc2UgZGUge2NhbmQubmFtZX0gIgog
#7#ICAgICAgICAgICAgICAgICAgICAgZiIoe2hpdHN9L3tsZW4odGFibGVbJ3Jvd3MnXSl9IHNwb3Rz
#7#KSIpCiAgICAgICAgICAgIHJldHVybgoKCmRlZiByZXNvbHZlKGltc19wYXRoLCB3b3JrZGlyLCBk
#7#YXRhc2V0X25hbWU9Tm9uZSwgdmVyYm9zZT1UcnVlKToKICAgICIiIlJldHVybiBgYChjb250YWlu
#7#ZXIgcGF0aCwgc291cmNlLCBnbGIgcGF0aClgYCBmb3IgYSB2b2x1bWUsIG9yIE5vbmUgaWYgaXQg
#7#aGFzIG5vIHRyYWNraW5nLgoKICAgIEEgYGAuaW1hcmlzX3RyYWNrYGAgaXMgdXNlZCBhcyBpdCBz
#7#dGFuZHM7IHRoZSBvdGhlciB0d28gc291cmNlcyBhcmUgY29udmVydGVkIGludG8gb25lLAogICAg
#7#d3JpdHRlbiB1bmRlciBgYHdvcmtkaXJgYCBzbyB0aGUgZGF0YXNldCBkaXJlY3Rvcnkgb25seSBl
#7#dmVyIHJlY2VpdmVzIHdoYXQgdGhlIGltcG9ydGVyCiAgICBwdXRzIHRoZXJlLgogICAgIiIiCiAg
#7#ICBpbXNfcGF0aCA9IFBhdGgoaW1zX3BhdGgpCiAgICBkYXRhc2V0X25hbWUgPSBkYXRhc2V0X25h
#7#bWUgb3IgaW1zX3BhdGguc3RlbQogICAgc291cmNlcyA9IGRpc2NvdmVyKGltc19wYXRoKQogICAg
#7#aWYgbm90IHNvdXJjZXM6CiAgICAgICAgcmV0dXJuIE5vbmUKCiAgICBlcnJvcnMgPSBbXQogICAg
#7#Zm9yIHNvdXJjZSBpbiBzb3VyY2VzOgogICAgICAgIHRyeToKICAgICAgICAgICAgaWYgc291cmNl
#7#LmtpbmQgPT0gImNvbnRhaW5lciI6CiAgICAgICAgICAgICAgICBpZiB2ZXJib3NlOgogICAgICAg
#7#ICAgICAgICAgICAgIHByaW50KGYiICBbVFJBQ0tJTkddIHNvdXJjZSA6IHtzb3VyY2UuZGVzY3Jp
#7#YmUoKX0iKQogICAgICAgICAgICAgICAgcmV0dXJuIHNvdXJjZS5wYXRoLCBzb3VyY2UsIHNvdXJj
#7#ZS5nbGIKICAgICAgICAgICAgaWYgdmVyYm9zZToKICAgICAgICAgICAgICAgIHByaW50KGYiICBb
#7#VFJBQ0tJTkddIHNvdXJjZSA6IHtzb3VyY2UuZGVzY3JpYmUoKX0iKQogICAgICAgICAgICB0YWJs
#7#ZSA9IHJlYWRfc291cmNlKHNvdXJjZSkKICAgICAgICAgICAgaWYgbm90IHRhYmxlIG9yIG5vdCB0
#7#YWJsZS5nZXQoInJvd3MiKToKICAgICAgICAgICAgICAgIGVycm9ycy5hcHBlbmQoZiJ7c291cmNl
#7#LmtpbmR9OiBhdWN1bmUgZG9ubmVlIGV4cGxvaXRhYmxlIikKICAgICAgICAgICAgICAgIGNvbnRp
#7#bnVlCiAgICAgICAgICAgIGlmIHNvdXJjZS5raW5kID09ICJzY2VuZTgiOgogICAgICAgICAgICAg
#7#ICAgX21lcmdlX3JlZ2lvbnNfZnJvbV9leGNlbCh0YWJsZSwgaW1zX3BhdGgsIHZlcmJvc2UpCiAg
#7#ICAgICAgICAgIGZvciB3YXJuaW5nIGluIHRhYmxlLmdldCgid2FybmluZ3MiKSBvciBbXToKICAg
#7#ICAgICAgICAgICAgIHByaW50KGYiICBbVFJBQ0tJTkddIFshXSB7d2FybmluZ30iKQogICAgICAg
#7#ICAgICBpZiB2ZXJib3NlIGFuZCB0YWJsZS5nZXQoInJlZ2lvblNvdXJjZSIpOgogICAgICAgICAg
#7#ICAgICAgcHJpbnQoZiIgIFtUUkFDS0lOR10gY2xhc3NpZmljYXRpb24gOiB7dGFibGVbJ3JlZ2lv
#7#blNvdXJjZSddfSIpCiAgICAgICAgICAgIGRvYyA9IGJ1aWxkX2NvbnRhaW5lcih0YWJsZSwgZGF0
#7#YXNldF9uYW1lLCB2ZXJib3NlPXZlcmJvc2UpCiAgICAgICAgICAgIG91dCA9IHdyaXRlX2NvbnRh
#7#aW5lcihkb2MsIFBhdGgod29ya2RpcikgLyBmIntkYXRhc2V0X25hbWV9e0NPTlRBSU5FUl9TVUZG
#7#SVh9IikKICAgICAgICAgICAgcmV0dXJuIG91dCwgc291cmNlLCBOb25lCiAgICAgICAgZXhjZXB0
#7#IEV4Y2VwdGlvbiBhcyBleGM6CiAgICAgICAgICAgIGVycm9ycy5hcHBlbmQoZiJ7c291cmNlLmtp
#7#bmR9OiB7ZXhjfSIpCiAgICAgICAgICAgIGlmIHZlcmJvc2U6CiAgICAgICAgICAgICAgICBwcmlu
#7#dChmIiAgW1RSQUNLSU5HXSBbIV0ge3NvdXJjZS5raW5kfSBpbnV0aWxpc2FibGUgOiB7ZXhjfSIp
#7#CgogICAgaWYgZXJyb3JzIGFuZCB2ZXJib3NlOgogICAgICAgIHByaW50KCIgIFtUUkFDS0lOR10g
#7#WyFdIGF1Y3VuZSBzb3VyY2UgZXhwbG9pdGFibGUiKQogICAgcmV0dXJuIE5vbmUKCgpkZWYgbWF0
#7#ZXJpYWxpemUocGF0aCwgd29ya2RpciwgZGF0YXNldF9uYW1lPU5vbmUpIC0+IFBhdGg6CiAgICAi
#7#IiJQYXRoIHRvIGEgcmVhZHktdG8taW1wb3J0IGNvbnRhaW5lciBmb3IgYW4gb3BlcmF0b3ItZGVz
#7#aWduYXRlZCBmaWxlLgoKICAgIEEgYGAuaW1hcmlzX3RyYWNrYGAgaXMgaGFuZGVkIGJhY2sgdW50
#7#b3VjaGVkOyBhbnl0aGluZyBlbHNlIGlzIGNvbnZlcnRlZCB1bmRlciBgYHdvcmtkaXJgYC4KICAg
#7#ICIiIgogICAgcGF0aCA9IFBhdGgocGF0aCkKICAgIGlmIHBhdGguc3VmZml4Lmxvd2VyKCkgPT0g
#7#Q09OVEFJTkVSX1NVRkZJWDoKICAgICAgICByZXR1cm4gcGF0aAogICAgZGF0YXNldF9uYW1lID0g
#7#ZGF0YXNldF9uYW1lIG9yIHBhdGguc3RlbQogICAgZG9jID0gbG9hZF9kb2N1bWVudChwYXRoKQog
#7#ICAgcmV0dXJuIHdyaXRlX2NvbnRhaW5lcihkb2MsIFBhdGgod29ya2RpcikgLyBmIntkYXRhc2V0
#7#X25hbWV9e0NPTlRBSU5FUl9TVUZGSVh9IikKCgpkZWYgbG9hZF9kb2N1bWVudChwYXRoKSAtPiBk
#7#aWN0OgogICAgIiIiUmVhZCBhbnkgc3VwcG9ydGVkIHRyYWNraW5nIGlucHV0IGludG8gYW4gSU1B
#7#UklTX1RSQUNLRVJfVjEgZG9jdW1lbnQuIiIiCiAgICBwYXRoID0gUGF0aChwYXRoKQogICAgaWYg
#7#cGF0aC5zdWZmaXgubG93ZXIoKSA9PSBDT05UQUlORVJfU1VGRklYOgogICAgICAgIHdpdGggZ3pp
#7#cC5vcGVuKHN0cihwYXRoKSwgInJiIikgYXMgZmg6CiAgICAgICAgICAgIGJsb2IgPSBmaC5yZWFk
#7#KCkKICAgICAgICBpZiBibG9iLnN0YXJ0c3dpdGgoU0lHTkFUVVJFLmVuY29kZSgpKToKICAgICAg
#7#ICAgICAgYmxvYiA9IGJsb2JbYmxvYi5pbmRleChiIlxuIikgKyAxOl0KICAgICAgICByZXR1cm4g
#7#anNvbi5sb2FkcyhibG9iLmRlY29kZSgidXRmLTgiKSkKCiAgICBpZiBwYXRoLnN1ZmZpeC5sb3dl
#7#cigpID09ICIuaW1zIjoKICAgICAgICB0YWJsZSA9IHJlYWRfc2NlbmU4KHBhdGgpCiAgICAgICAg
#7#aWYgbm90IHRhYmxlOgogICAgICAgICAgICByYWlzZSBWYWx1ZUVycm9yKGYie3BhdGgubmFtZX06
#7#IGF1Y3VuIG9iamV0IGRlIHRyYWNraW5nIGRhbnMgU2NlbmU4IikKICAgICAgICBfbWVyZ2VfcmVn
#7#aW9uc19mcm9tX2V4Y2VsKHRhYmxlLCBwYXRoLCB2ZXJib3NlPVRydWUpCiAgICBlbGlmIHBhdGgu
#7#c3VmZml4Lmxvd2VyKCkgaW4gRVhDRUxfU1VGRklYRVM6CiAgICAgICAgdGFibGUgPSByZWFkX2V4
#7#Y2VsKHBhdGgpCiAgICBlbHNlOgogICAgICAgIHJhaXNlIFZhbHVlRXJyb3IoZiJ7cGF0aC5uYW1l
#7#fTogZm9ybWF0IG5vbiBzdXBwb3J0ZSAiCiAgICAgICAgICAgICAgICAgICAgICAgICBmIiguaW1h
#7#cmlzX3RyYWNrLCAuaW1zLCB7JywgJy5qb2luKEVYQ0VMX1NVRkZJWEVTKX0pIikKCiAgICBmb3Ig
#7#d2FybmluZyBpbiB0YWJsZS5nZXQoIndhcm5pbmdzIikgb3IgW106CiAgICAgICAgcHJpbnQoZiJb
#7#VFJBQ0tJTkddIFshXSB7d2FybmluZ30iKQogICAgcmV0dXJuIGJ1aWxkX2NvbnRhaW5lcih0YWJs
#7#ZSwgcGF0aC5zdGVtKQoKCmRlZiBtYWluKCk6CiAgICBhcCA9IGFyZ3BhcnNlLkFyZ3VtZW50UGFy
#7#c2VyKAogICAgICAgIGRlc2NyaXB0aW9uPSJEZXRlY3RlIGV0IG5vcm1hbGlzZSBsJ2FuYWx5c2Ug
#7#ZGUgdHJhY2tpbmcgYXNzb2NpZWUgYSB1biB2b2x1bWUgSW1hcmlzLiIpCiAgICBhcC5hZGRfYXJn
#7#dW1lbnQoImlucHV0IiwgaGVscD0iLmltcywgLnhscy8ueGxzeCBvdSAuaW1hcmlzX3RyYWNrIikK
#7#ICAgIGFwLmFkZF9hcmd1bWVudCgiLS1saXN0IiwgYWN0aW9uPSJzdG9yZV90cnVlIiwKICAgICAg
#7#ICAgICAgICAgICAgICBoZWxwPSJsaXN0ZXIgbGVzIHNvdXJjZXMgZGV0ZWN0ZWVzIHNhbnMgcmll
#7#biBjb252ZXJ0aXIiKQogICAgYXAuYWRkX2FyZ3VtZW50KCItLW91dCIsIGRlZmF1bHQ9Tm9uZSwK
#7#ICAgICAgICAgICAgICAgICAgICBoZWxwPSJlY3JpcmUgbGUgY29udGVuZXVyIC5pbWFyaXNfdHJh
#7#Y2sgbm9ybWFsaXNlIGEgY2UgY2hlbWluIikKICAgIGFyZ3MgPSBhcC5wYXJzZV9hcmdzKCkKCiAg
#7#ICBwYXRoID0gUGF0aChhcmdzLmlucHV0KQogICAgaWYgYXJncy5saXN0OgogICAgICAgIHNvdXJj
#7#ZXMgPSBkaXNjb3ZlcihwYXRoKQogICAgICAgIGlmIG5vdCBzb3VyY2VzOgogICAgICAgICAgICBw
#7#cmludCgiQXVjdW5lIHNvdXJjZSBkZSB0cmFja2luZyBkZXRlY3RlZS4iKQogICAgICAgICAgICBy
#7#ZXR1cm4gMQogICAgICAgIGZvciBpLCBzb3VyY2UgaW4gZW51bWVyYXRlKHNvdXJjZXMsIDEpOgog
#7#ICAgICAgICAgICBwcmludChmIiAge2l9LiB7c291cmNlLmRlc2NyaWJlKCl9IikKICAgICAgICBy
#7#ZXR1cm4gMAoKICAgIGRvYyA9IGxvYWRfZG9jdW1lbnQocGF0aCkKICAgIGRhdGEgPSBkb2NbImRh
#7#dGEiXQogICAgcHJpbnQoZiJjZWxsdWxlcyAgIDoge2xlbihkYXRhWydjZWxscyddKX0iKQogICAg
#7#cHJpbnQoZiJ0aW1lcG9pbnRzIDoge2xlbihkYXRhWyd0aW1lcG9pbnRzJ10pfSAoe2RhdGFbJ3Rp
#7#bWVwb2ludHMnXVswXTpnfS4ue2RhdGFbJ3RpbWVwb2ludHMnXVstMV06Z30pIikKICAgIHByb3Yg
#7#PSBkYXRhLmdldCgicHJvdmVuYW5jZSIpIG9yIHt9CiAgICBpZiBwcm92OgogICAgICAgIHByaW50
#7#KCJwcm92ZW5hbmNlIDogIiArICIsICIuam9pbihmIntrfT17dn0iIGZvciBrLCB2IGluIHByb3Yu
#7#aXRlbXMoKSkpCiAgICBpZiBhcmdzLm91dDoKICAgICAgICB3cml0ZV9jb250YWluZXIoZG9jLCBh
#7#cmdzLm91dCkKICAgICAgICBwcmludChmImVjcml0ICAgICAgOiB7YXJncy5vdXR9IikKICAgIHJl
#7#dHVybiAwCgoKaWYgX19uYW1lX18gPT0gIl9fbWFpbl9fIjoKICAgIHN5cy5leGl0KG1haW4oKSkK
:: ---- [8] build_download_bundles.py (32704 octets) ----
#8#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwoiIiIKYnVpbGRfZG93bmxvYWRfYnVuZGxlcy5weSDigJQg
#8#UG9wdWxhdGUgZWFjaCBkYXRhc2V0J3MgZG93bmxvYWQvIGZvbGRlci4KCkZvciBldmVyeSBkYXRh
#8#c2V0IHVuZGVyIERBVEFfV0VCLzx0eXBlPi88Zm9sZGVyPi8gdGhpcyBidWlsZHMgdGhlIGZpbGVz
#8#IHRoZQpEb3dubG9hZCBDZW50ZXIncyBmaWxlIGV4cGxvcmVyIChhcGkvZG93bmxvYWRzKSB3aWxs
#8#IGV4cG9zZSwgaW4gdGhpcyBvcmRlcjoKCiAgMS4gPGZvbGRlcj5fd2ViLnppcCAgIOKAlCBhcmNo
#8#aXZlIG9mIHRoZSBzZXJ2ZWQvcHJlcHJvY2Vzc2VkIGRhdGFzZXQgKGJyaWNrcy8sCiAgICAgICAg
#8#ICAgICAgICAgICAgICAgICAgbWV0YWRhdGEuanNvbiwgdGh1bWJuYWlsLndlYnApLiBUaGUgZG93
#8#bmxvYWQvIGZvbGRlciBpcwogICAgICAgICAgICAgICAgICAgICAgICAgIEVYQ0xVREVELCBzbyB0
#8#aGUgYXJjaGl2ZSBuZXZlciBjb250YWlucyB0aGUgb3RoZXIKICAgICAgICAgICAgICAgICAgICAg
#8#ICAgICBkb3dubG9hZCBhcnRlZmFjdHMgKG9yIGl0c2VsZikuIEJ1aWx0IEZJUlNULgogIDIuIDxm
#8#b2xkZXI+LmltcyAgICAgICDigJQgdGhlIG9yaWdpbmFsIEltYXJpcyBmaWxlLCBwbGFjZWQgYnkg
#8#SEFSRCBMSU5LIChubyBieXRlCiAgICAgICAgICAgICAgICAgICAgICAgICAgZHVwbGljYXRpb247
#8#IFJBV19EQVRBIGFuZCBEQVRBX1dFQiBsaXZlIG9uIHRoZSBzYW1lCiAgICAgICAgICAgICAgICAg
#8#ICAgICAgICAgdm9sdW1lKS4gRmFsbHMgYmFjayB0byBhIGNvcHkgYWNyb3NzIHZvbHVtZXMuCiAg
#8#My4gPGZvbGRlcj4udGlmICAgICAgIOKAlCBhIG11bHRpLWNoYW5uZWwgSW1hZ2VKL0ZpamkgY29t
#8#cG9zaXRlIGh5cGVyc3RhY2sKICAgICAgICAgICAgICAgICAgICAgICAgICAobmF0aXZlIGJpdCBk
#8#ZXB0aCwgwrVtLWNhbGlicmF0ZWQsIHBlci1jaGFubmVsIGRpc3BsYXkKICAgICAgICAgICAgICAg
#8#ICAgICAgICAgICByYW5nZSArIExVVCkgcmVjb25zdHJ1Y3RlZCBmcm9tIHRoZSAuaW1zIGludGVy
#8#bmFsCiAgICAgICAgICAgICAgICAgICAgICAgICAgcmVzb2x1dGlvbiBweXJhbWlkIGF0IH5UQVJH
#8#RVRfUFggb24gdGhlIGxvbmcgWFkgc2lkZS4KICAgICAgICAgICAgICAgICAgICAgICAgICBJbWFn
#8#ZUogZmxhdm91ciByYXRoZXIgdGhhbiBPTUUgYmVjYXVzZSBPTUUtWE1MIGhhcyBubwogICAgICAg
#8#ICAgICAgICAgICAgICAgICAgIGRpc3BsYXktcmFuZ2UgZmllbGQ6IEJpby1Gb3JtYXRzIHRoZW4g
#8#b3BlbnMgdGhlIHN0YWNrCiAgICAgICAgICAgICAgICAgICAgICAgICAgYWNyb3NzIHRoZSBmdWxs
#8#IDAuLjY1NTM1IHN3ZWVwIGFuZCBldmVyeSBjaGFubmVsIHJlYWRzCiAgICAgICAgICAgICAgICAg
#8#ICAgICAgICAgYmxhY2sgdW50aWwgdGhlIHVzZXIgaGl0cyBSZXNldCBpbiBCcmlnaHRuZXNzL0Nv
#8#bnRyYXN0LgogICAgICAgICAgICAgICAgICAgICAgICAgIFRoZSAuaW1zIGJlc2lkZSBpdCBzdGF5
#8#cyB0aGUgaW50ZXJvcGVyYWJsZSBtYXN0ZXIuCiAgNC4gPGZvbGRlcj5fQ3tufV88bmFtZT5fTUlQ
#8#LnBuZyDigJQgcGVyLWNoYW5uZWwgbWF4aW11bS1pbnRlbnNpdHkgcHJvamVjdGlvbi4KICA1LiBS
#8#RUFETUUudHh0ICAgICAgICAg4oCUIHByb3ZlbmFuY2UsIGRpbWVuc2lvbnMsIHZveGVsIHNpemUs
#8#IGNoYW5uZWxzLCBjaXRhdGlvbi4KClRoZSAuaW1zIGlzIHJlYWQgc3RyYWlnaHQgZnJvbSB0aGUg
#8#SW1hcmlzIEhERjUgcHlyYW1pZCAoUmVzb2x1dGlvbkxldmVsIEwpLCBzbwpvbmx5IHRoZSBjaG9z
#8#ZW4gKHNtYWxsKSBsZXZlbCBpcyB0b3VjaGVkIOKAlCBuZXZlciB0aGUgZnVsbC1yZXNvbHV0aW9u
#8#IGxldmVsIDAuCgpBIHRpbWVsYXBzZSAoJ2xpdmUnKSBrZWVwcyBldmVyeSBmcmFtZSBpbiBpdHMg
#8#LmltcyBhbmQgaXRzIHdlYiBhcmNoaXZlOyB0aGUgVElGRiBhbmQKdGhlIE1JUHMgYXJlIE9ORSBm
#8#cmFtZSBvZiBpdCDigJQgdGhlIGZpcnN0IHVubGVzcyAtLXRpbWVwb2ludCBzYXlzIG90aGVyd2lz
#8#ZSDigJQgYW5kIHRoZQpSRUFETUUgc2F5cyB3aGljaC4gT25lIGZyYW1lIGtlZXBzIHRoZSBUSUZG
#8#IHRoZSBzaXplIG9mIGEgZml4ZWQgc3RhY2snczsgdGhlIC5pbXMgYmVzaWRlCml0IGlzIHRoZSBj
#8#b21wbGV0ZSBhY3F1aXNpdGlvbi4KCklkZW1wb3RlbnQ6IGV4aXN0aW5nIGFydGVmYWN0cyBhcmUg
#8#c2tpcHBlZCB1bmxlc3MgLS1mb3JjZS4gRWFjaCBkYXRhc2V0IGlzCmlzb2xhdGVkIGluIHRyeS9l
#8#eGNlcHQgc28gb25lIGZhaWx1cmUgbmV2ZXIgYWJvcnRzIHRoZSBiYXRjaC4KClVzYWdlOgogIHB5
#8#IHRvb2xzL2J1aWxkX2Rvd25sb2FkX2J1bmRsZXMucHkgICAgICAgICAgICAgICAgICMgYWxsIGRh
#8#dGFzZXRzLCBhbGwgYXJ0ZWZhY3RzCiAgcHkgdG9vbHMvYnVpbGRfZG93bmxvYWRfYnVuZGxlcy5w
#8#eSAtLWRhdGFzZXRzIEU4LTEgIyBzdWJzdHJpbmcgZmlsdGVyCiAgcHkgdG9vbHMvYnVpbGRfZG93
#8#bmxvYWRfYnVuZGxlcy5weSAtLWRyeS1ydW4KICBweSB0b29scy9idWlsZF9kb3dubG9hZF9idW5k
#8#bGVzLnB5IC0tbm8taW1zIC0tbm8tYXJjaGl2ZSAgICMgb25seSBUSUZGICsgTUlQCiAgcHkgdG9v
#8#bHMvYnVpbGRfZG93bmxvYWRfYnVuZGxlcy5weSAtLXRpZmYtcHggMTAyNCAtLWZvcmNlCiAgcHkg
#8#dG9vbHMvYnVpbGRfZG93bmxvYWRfYnVuZGxlcy5weSAtLWRhdGFzZXQgbGl2ZS88Zm9sZGVyPiAt
#8#LXRpbWVwb2ludCAxMgoiIiIKZnJvbSBfX2Z1dHVyZV9fIGltcG9ydCBhbm5vdGF0aW9ucwoKaW1w
#8#b3J0IGFyZ3BhcnNlCmltcG9ydCBqc29uCmltcG9ydCBvcwppbXBvcnQgcmUKaW1wb3J0IHNodXRp
#8#bAppbXBvcnQgc3lzCmltcG9ydCB0ZW1wZmlsZQppbXBvcnQgdGltZQppbXBvcnQgd2FybmluZ3MK
#8#aW1wb3J0IHppcGZpbGUKZnJvbSBwYXRobGliIGltcG9ydCBQYXRoCgppbXBvcnQgbnVtcHkgYXMg
#8#bnAKCiMg4pSA4pSAIFBhdGhzIC8gY29uZmlnIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#8#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#8#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#8#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgApST09UID0gUGF0aChfX2ZpbGVfXykucmVz
#8#b2x2ZSgpLnBhcmVudC5wYXJlbnQgICAgICAgICAgIyBXZWJQbGF0Zm9ybSByb290CkRBVEFfV0VC
#8#ID0gUk9PVCAvICJEQVRBX1dFQiIKIyBXaGVyZSB0aGUgb3JpZ2luYWwgLmltcyBmaWxlcyBsaXZl
#8#IChkb25lLyArIHRvZG8vIGFyZSBzY2FubmVkIHJlY3Vyc2l2ZWx5KTogdGhlCiMgbGFiJ3Mgd29y
#8#a3N0YXRpb24gZGVmYXVsdCwgTFVNRU5fUkFXX0RBVEFfRElSUyAob3MucGF0aHNlcC1zZXBhcmF0
#8#ZWQpIHdoZW4gc2V0LCBhbmQKIyAtLXJhdy1kaXIgaW4gZnJvbnQgb2YgZWl0aGVyLgpSQVdfREFU
#8#QV9ESVJTID0gWwogICAgUGF0aChyIkM6XFVzZXJzXEFkbWluaXN0cmF0b3JcRGVza3RvcFxGaXhl
#8#ZCBpbWFnZXMgZm9yIGRhdGFiYXNlXFJBV19EQVRBIiksCl0KaWYgb3MuZW52aXJvbi5nZXQoIkxV
#8#TUVOX1JBV19EQVRBX0RJUlMiKToKICAgIFJBV19EQVRBX0RJUlMgPSBbUGF0aChwKSBmb3IgcCBp
#8#biBvcy5lbnZpcm9uWyJMVU1FTl9SQVdfREFUQV9ESVJTIl0uc3BsaXQob3MucGF0aHNlcCkgaWYg
#8#cF0KREFUQVNFVF9UWVBFUyA9ICgiM2QiLCAiMmQiLCAibGl2ZSIpCgpUQVJHRVRfUFggPSAyMDQ4
#8#ICAgICAgICAgICAgICAgIyBkZXNpcmVkIGxvbmcgWFkgc2lkZSBvZiB0aGUgZ2VuZXJhdGVkIFRJ
#8#RkYKIyBIYXJkIGNlaWxpbmcgb24gdGhlIGluLWZsaWdodCB2b2x1bWUgKEPCt1rCt1nCt1jCt2l0
#8#ZW1zaXplKTsgaWYgdGhlIGxldmVsIGNsb3Nlc3QgdG8KIyBUQVJHRVRfUFggZXhjZWVkcyB0aGlz
#8#LCBzdGVwIGRvd24gdGhlIHB5cmFtaWQgc28gd2UgbmV2ZXIgYmxvdyB1cCBkaXNrL1JBTS4KIyBU
#8#aGlzIGlzIE5PVCB0aGUgY2xhc3NpYy1USUZGIDQgR2lCIG9mZnNldCBsaW1pdDogdGhhdCBvbmUg
#8#YXBwbGllcyB0byB0aGUKIyBDT01QUkVTU0VEIGZpbGUgKH40NSUgb2YgdGhlIHJhdyB2b2x1bWUg
#8#aGVyZSksIHNvIGNhcHBpbmcgdGhlIHJhdyB2b2x1bWUgYXQgNAojIEdpQiB3b3VsZCBjb3N0IHJl
#8#YWwgcmVzb2x1dGlvbiDigJQgaXQgaGFsdmVkIDQgb2YgdGhlIGxhYidzIDE2IGRhdGFzZXRzIHdo
#8#ZW4KIyB0cmllZC4gQW4gb3ZlcmZsb3dpbmcgd3JpdGUgaXMgY2F1Z2h0IGFuZCByZXRyaWVkIG9u
#8#ZSBsZXZlbCBjb2Fyc2VyIGluc3RlYWQuCk1BWF9USUZGX0JZVEVTID0gNiAqIDEwMjQqKjMKCiMg
#8#RmFsc2UtY29sb3VyIGZhbGxiYWNrcyAobWlycm9yIHJ1bl9wcmVwcm9jZXNzLlRIVU1CX0NPTE9S
#8#Uykgd2hlbiBhIGNoYW5uZWwgaGFzCiMgbm8gZGlzcGxheSBjb2xvdXIgaW4gbWV0YWRhdGEuanNv
#8#bi4KVEhVTUJfQ09MT1JTID0gWwogICAgKDAsIDI1NSwgMTAyKSwgKDI1NSwgNjEsIDI1NSksICg0
#8#NywgMTA3LCAyNTUpLCAoMjU1LCA0OCwgNDgpLAogICAgKDI1NSwgMjU1LCAwKSwgKDI1NSwgMCwg
#8#MjU1KSwgKDAsIDI1NSwgMjU1KSwKXQoKCiMg4pSA4pSAIEltYXJpcyBhdHRyaWJ1dGUgZGVjb2Rp
#8#bmcgKG1pcnJvcnMgcHJlcHJvY2Vzcy8xLWltc19tZXRhZGF0YS5hdHRyX3N0cikg4pSA4pSACmRl
#8#ZiBhdHRyX3N0cihncm91cCwga2V5LCBkZWZhdWx0PSIiKToKICAgIGlmIGdyb3VwIGlzIE5vbmU6
#8#CiAgICAgICAgcmV0dXJuIGRlZmF1bHQKICAgIHYgPSBncm91cC5hdHRycy5nZXQoa2V5LCBkZWZh
#8#dWx0KQogICAgaWYgaXNpbnN0YW5jZSh2LCAoYnl0ZXMsIG5wLmJ5dGVzXykpOgogICAgICAgIHJl
#8#dHVybiB2LmRlY29kZSgidXRmLTgiLCBlcnJvcnM9InJlcGxhY2UiKS5zdHJpcCgpCiAgICBpZiBp
#8#c2luc3RhbmNlKHYsIG5wLm5kYXJyYXkpOgogICAgICAgIHRyeToKICAgICAgICAgICAgcmV0dXJu
#8#IGIiIi5qb2luKAogICAgICAgICAgICAgICAgYnl0ZXMoYykgaWYgaXNpbnN0YW5jZShjLCAoYnl0
#8#ZXMsIG5wLmJ5dGVzXykpIGVsc2UgYy50b2J5dGVzKCkKICAgICAgICAgICAgICAgIGZvciBjIGlu
#8#IHYKICAgICAgICAgICAgKS5kZWNvZGUoInV0Zi04IiwgZXJyb3JzPSJyZXBsYWNlIikuc3RyaXAo
#8#KQogICAgICAgIGV4Y2VwdCBFeGNlcHRpb246CiAgICAgICAgICAgIHJldHVybiAiIi5qb2luKAog
#8#ICAgICAgICAgICAgICAgYy5kZWNvZGUoInV0Zi04IiwgZXJyb3JzPSJyZXBsYWNlIikgaWYgaXNp
#8#bnN0YW5jZShjLCAoYnl0ZXMsIG5wLmJ5dGVzXykpIGVsc2Ugc3RyKGMpCiAgICAgICAgICAgICAg
#8#ICBmb3IgYyBpbiB2CiAgICAgICAgICAgICkuc3RyaXAoKQogICAgcmV0dXJuIHN0cih2KS5zdHJp
#8#cCgpCgoKZGVmIGF0dHJfZmxvYXQoZ3JvdXAsIGtleSwgZGVmYXVsdD0wLjApOgogICAgdHJ5Ogog
#8#ICAgICAgIHJldHVybiBmbG9hdChhdHRyX3N0cihncm91cCwga2V5LCBzdHIoZGVmYXVsdCkpKQog
#8#ICAgZXhjZXB0IChUeXBlRXJyb3IsIFZhbHVlRXJyb3IpOgogICAgICAgIHJldHVybiBkZWZhdWx0
#8#CgoKZGVmIGhleF90b19yZ2IodmFsdWUsIGZhbGxiYWNrKToKICAgIG0gPSByZS5tYXRjaChyIl4j
#8#PyhbMC05YS1mQS1GXXs2fSkkIiwgc3RyKHZhbHVlIG9yICIiKS5zdHJpcCgpKQogICAgaWYgbm90
#8#IG06CiAgICAgICAgcmV0dXJuIGZhbGxiYWNrCiAgICBoID0gbS5ncm91cCgxKQogICAgcmV0dXJu
#8#IChpbnQoaFswOjJdLCAxNiksIGludChoWzI6NF0sIDE2KSwgaW50KGhbNDo2XSwgMTYpKQoKCiMg
#8#4pSA4pSAIERhdGFzZXQgZGlzY292ZXJ5IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#8#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#8#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#8#gOKUgOKUgOKUgOKUgOKUgOKUgApkZWYgX3JlYWRfbWV0YV9qc29uKGQpOgogICAgIiIiUGVyLWRh
#8#dGFzZXQgbWV0YWRhdGEuanNvbiDigJQgdGhlIGF1dGhvcml0YXRpdmUgc291cmNlIGZvciBjaGFu
#8#bmVscy92b3hlbHMuCiAgICB1dGYtOC1zaWcgdG9sZXJhdGVzIGEgc3RyYXkgQk9NIChoYW5kLWVk
#8#aXRlZCBmaWxlcykgd2l0aG91dCBicmVha2luZyB0aGUgcGFyc2UuIiIiCiAgICBwID0gZCAvICJt
#8#ZXRhZGF0YS5qc29uIgogICAgaWYgcC5leGlzdHMoKToKICAgICAgICB0cnk6CiAgICAgICAgICAg
#8#IHJldHVybiBqc29uLmxvYWRzKHAucmVhZF90ZXh0KGVuY29kaW5nPSJ1dGYtOC1zaWciKSkKICAg
#8#ICAgICBleGNlcHQgRXhjZXB0aW9uOgogICAgICAgICAgICByZXR1cm4ge30KICAgIHJldHVybiB7
#8#fQoKCmRlZiBsb2FkX2RhdGFzZXRzKGZpbHRlcl9zdWJzdHI9Tm9uZSwgdHlwZXM9REFUQVNFVF9U
#8#WVBFUywgZXhhY3RfaWQ9Tm9uZSk6CiAgICAiIiJSZXR1cm4gW3tpZCwgdHlwZSwgZm9sZGVyLCBk
#8#aXIsIG1ldGF9XSBmb3IgdGhlIGRhdGFzZXQgZm9sZGVycyB1bmRlciBEQVRBX1dFQi4KICAgIFRo
#8#ZSBjYXRhbG9nIGlzIGdlbmVyYXRlZCBwZXIgcmVxdWVzdCBmcm9tIHRoZXNlIHNhbWUgbWV0YWRh
#8#dGEuanNvbiBmaWxlcywgc28gdGhlCiAgICBmb2xkZXJzIGFyZSB0aGUgb25seSBpbmRleCB0aGVy
#8#ZSBpcy4gYGV4YWN0X2lkYCAoJzx0eXBlPi88Zm9sZGVyPicpIHNlbGVjdHMgb25lCiAgICBkYXRh
#8#c2V0OyBgZmlsdGVyX3N1YnN0cmAgbWF0Y2hlcyBmb2xkZXIgbmFtZXMgbG9vc2VseS4iIiIKICAg
#8#IG91dCA9IFtdCiAgICBmb3IgdHlwIGluIHR5cGVzOgogICAgICAgIGJhc2UgPSBEQVRBX1dFQiAv
#8#IHR5cAogICAgICAgIGlmIG5vdCBiYXNlLmlzX2RpcigpOgogICAgICAgICAgICBjb250aW51ZQog
#8#ICAgICAgIGZvciBkIGluIHNvcnRlZChiYXNlLml0ZXJkaXIoKSk6CiAgICAgICAgICAgIGlmIGQu
#8#aXNfZGlyKCkgYW5kIG5vdCBkLm5hbWUuc3RhcnRzd2l0aCgiLiIpOgogICAgICAgICAgICAgICAg
#8#b3V0LmFwcGVuZCh7ImlkIjogZiJ7dHlwfS97ZC5uYW1lfSIsICJ0eXBlIjogdHlwLCAiZm9sZGVy
#8#IjogZC5uYW1lLCAiZGlyIjogZCwKICAgICAgICAgICAgICAgICAgICAgICAgICAgICJtZXRhIjog
#8#X3JlYWRfbWV0YV9qc29uKGQpfSkKICAgIGlmIGV4YWN0X2lkOgogICAgICAgIG91dCA9IFtvIGZv
#8#ciBvIGluIG91dCBpZiBvWyJpZCJdID09IGV4YWN0X2lkXQogICAgaWYgZmlsdGVyX3N1YnN0cjoK
#8#ICAgICAgICBvdXQgPSBbbyBmb3IgbyBpbiBvdXQgaWYgZmlsdGVyX3N1YnN0ci5sb3dlcigpIGlu
#8#IG9bImZvbGRlciJdLmxvd2VyKCldCiAgICByZXR1cm4gb3V0CgoKZGVmIGZpbmRfaW1zKGZvbGRl
#8#cik6CiAgICAiIiJMb2NhdGUgPGZvbGRlcj4uaW1zIGluIGFueSBjb25maWd1cmVkIFJBV19EQVRB
#8#IGRpciAocmVjdXJzaXZlKS4iIiIKICAgIGZvciBiYXNlIGluIFJBV19EQVRBX0RJUlM6CiAgICAg
#8#ICAgaWYgbm90IGJhc2UuaXNfZGlyKCk6CiAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAgZXhh
#8#Y3QgPSBsaXN0KGJhc2Uucmdsb2IoZiJ7Zm9sZGVyfS5pbXMiKSkKICAgICAgICBpZiBleGFjdDoK
#8#ICAgICAgICAgICAgcmV0dXJuIGV4YWN0WzBdCiAgICByZXR1cm4gTm9uZQoKCiMg4pSA4pSAIFN0
#8#ZXAgMSDigJQgYXJjaGl2ZSBvZiB0aGUgcHJlcHJvY2Vzc2VkIGRhdGFzZXQgKGRvd25sb2FkLyBl
#8#eGNsdWRlZCkg4pSA4pSA4pSA4pSA4pSA4pSA4pSACmRlZiBidWlsZF9hcmNoaXZlKGRzX2Rpciwg
#8#Zm9sZGVyLCBvdXRfcGF0aCwgZm9yY2UsIGRyeSk6CiAgICBpZiBvdXRfcGF0aC5leGlzdHMoKSBh
#8#bmQgbm90IGZvcmNlOgogICAgICAgIHJldHVybiAic2tpcCAoZXhpc3RzKSIKICAgICMgQ29sbGVj
#8#dCB0aGUgc2VydmFibGUgZmlsZXMgZmlyc3Q7IHRoZSBkb3dubG9hZC8gZm9sZGVyIGlzIGV4Y2x1
#8#ZGVkIHNvIHRoZQogICAgIyBhcmNoaXZlIG5ldmVyIGNvbnRhaW5zIHRoZSBvdGhlciBhcnRlZmFj
#8#dHMgKG9yIGl0c2VsZikuCiAgICBmaWxlcyA9IFtwIGZvciBwIGluIHNvcnRlZChkc19kaXIucmds
#8#b2IoIioiKSkKICAgICAgICAgICAgIGlmIHAuaXNfZmlsZSgpIGFuZCBub3QgX2V4Y2x1ZGVkX2Zy
#8#b21fYXJjaGl2ZShwLnJlbGF0aXZlX3RvKGRzX2RpcikpXQogICAgaWYgbm90IGZpbGVzOgogICAg
#8#ICAgIHJldHVybiAic2tpcCAobm8gd2ViIGRhdGEgeWV0KSIgICAgICAgICMgdW4tcHJlcHJvY2Vz
#8#c2VkIGRhdGFzZXQg4oaSIG5vIGVtcHR5IHppcAogICAgaWYgZHJ5OgogICAgICAgIHJldHVybiBm
#8#IndvdWxkIGJ1aWxkICh7bGVuKGZpbGVzKX0gZmlsZXMpIgogICAgdG1wID0gb3V0X3BhdGgud2l0
#8#aF9zdWZmaXgob3V0X3BhdGguc3VmZml4ICsgIi50bXAiKQogICAgd2l0aCB6aXBmaWxlLlppcEZp
#8#bGUodG1wLCAidyIsIGNvbXByZXNzaW9uPXppcGZpbGUuWklQX1NUT1JFRCwgYWxsb3daaXA2ND1U
#8#cnVlKSBhcyB6ZjoKICAgICAgICBmb3IgcGF0aCBpbiBmaWxlczoKICAgICAgICAgICAgemYud3Jp
#8#dGUocGF0aCwgYXJjbmFtZT1zdHIoUGF0aChmb2xkZXIpIC8gcGF0aC5yZWxhdGl2ZV90byhkc19k
#8#aXIpKSkKICAgIG9zLnJlcGxhY2UodG1wLCBvdXRfcGF0aCkKICAgIHJldHVybiBmIntsZW4oZmls
#8#ZXMpfSBmaWxlcywge2ZtdF9zaXplKG91dF9wYXRoLnN0YXQoKS5zdF9zaXplKX0iCgoKZGVmIF9l
#8#eGNsdWRlZF9mcm9tX2FyY2hpdmUocmVsOiBQYXRoKSAtPiBib29sOgogICAgIiIiZG93bmxvYWQv
#8#ICh0aGUgb3RoZXIgYXJ0ZWZhY3RzLCBhbmQgdGhlIGFyY2hpdmUgaXRzZWxmKSwgZG90ZmlsZXMg
#8#KHRlbXBvcmFyeQogICAgZmlsZXMsIGEgcHVibGlzaCBtYXJrZXIpIGFuZCB0aGUgb2xkIGVudHJp
#8#ZXMgYSBwdWJsaXNoIHNldHMgYXNpZGUuIiIiCiAgICBmaXJzdCA9IHJlbC5wYXJ0c1swXQogICAg
#8#cmV0dXJuIChmaXJzdCA9PSAiZG93bmxvYWQiIG9yIGFueShwYXJ0LnN0YXJ0c3dpdGgoIi4iKSBm
#8#b3IgcGFydCBpbiByZWwucGFydHMpCiAgICAgICAgICAgIG9yIGZpcnN0LmVuZHN3aXRoKCIucHJl
#8#LXN3YXAiKSBvciBmaXJzdCA9PSAiYnJpY2tzLnJvbGxiYWNrIikKCgojIOKUgOKUgCBTdGVwIDIg
#8#4oCUIG9yaWdpbmFsIC5pbXMgdmlhIGhhcmQgbGluayAoY29weSBmYWxsYmFjaykg4pSA4pSA4pSA
#8#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmRlZiBw
#8#bGFjZV9pbXMoaW1zX3NyYywgb3V0X3BhdGgsIGZvcmNlLCBkcnkpOgogICAgaWYgb3V0X3BhdGgu
#8#ZXhpc3RzKCkgYW5kIG5vdCBmb3JjZToKICAgICAgICByZXR1cm4gInNraXAgKGV4aXN0cykiCiAg
#8#ICBpZiBkcnk6CiAgICAgICAgcmV0dXJuIGYid291bGQgbGluayB7Zm10X3NpemUoaW1zX3NyYy5z
#8#dGF0KCkuc3Rfc2l6ZSl9IgogICAgaWYgb3V0X3BhdGguZXhpc3RzKCk6CiAgICAgICAgb3V0X3Bh
#8#dGgudW5saW5rKCkKICAgIHRyeToKICAgICAgICBvcy5saW5rKGltc19zcmMsIG91dF9wYXRoKSAg
#8#ICAgICAgICAgICAgICAgICAgICAjIGhhcmQgbGluaywgMCBleHRyYSBieXRlcwogICAgICAgIHJl
#8#dHVybiBmImhhcmRsaW5rIHtmbXRfc2l6ZShvdXRfcGF0aC5zdGF0KCkuc3Rfc2l6ZSl9IgogICAg
#8#ZXhjZXB0IE9TRXJyb3I6CiAgICAgICAgc2h1dGlsLmNvcHkyKGltc19zcmMsIG91dF9wYXRoKSAg
#8#ICAgICAgICAgICAgICAgIyBjcm9zcy12b2x1bWUgZmFsbGJhY2sKICAgICAgICByZXR1cm4gZiJj
#8#b3B5IHtmbXRfc2l6ZShvdXRfcGF0aC5zdGF0KCkuc3Rfc2l6ZSl9IgoKCiMg4pSA4pSAIFN0ZXAg
#8#My80IOKAlCBJbWFnZUogVElGRiAoKyBwZXItY2hhbm5lbCBNSVApIGZyb20gdGhlIC5pbXMgcHly
#8#YW1pZCDilIDilIDilIDilIDilIDilIDilIDilIAKZGVmIGxpc3RfbGV2ZWxzKGYsIHRpbWVwb2lu
#8#dD0wKToKICAgICIiIlsoTCwgWHIsIFlyLCBacildIGZyb20gdGhlIEltYXJpcyBSZXNvbHV0aW9u
#8#TGV2ZWwgZ3JvdXBzIChyZWFsIHNpemVzKS4iIiIKICAgIGRhdGFzZXQgPSBmWyJEYXRhU2V0Il0K
#8#ICAgIG91dCA9IFtdCiAgICBmb3Iga2V5IGluIGRhdGFzZXQua2V5cygpOgogICAgICAgIGlmIG5v
#8#dCBrZXkuc3RhcnRzd2l0aCgiUmVzb2x1dGlvbkxldmVsIik6CiAgICAgICAgICAgIGNvbnRpbnVl
#8#CiAgICAgICAgTCA9IGludChrZXkuc3BsaXQoKVstMV0pCiAgICAgICAgdHAgPSBkYXRhc2V0W2tl
#8#eV0uZ2V0KGYiVGltZVBvaW50IHt0aW1lcG9pbnR9IikKICAgICAgICBpZiB0cCBpcyBOb25lOgog
#8#ICAgICAgICAgICBjb250aW51ZQogICAgICAgIGNoMCA9IHRwLmdldCgiQ2hhbm5lbCAwIikKICAg
#8#ICAgICBpZiBjaDAgaXMgTm9uZToKICAgICAgICAgICAgY29udGludWUKICAgICAgICB4ciA9IGlu
#8#dChhdHRyX3N0cihjaDAsICJJbWFnZVNpemVYIiwgIjAiKSBvciAwKQogICAgICAgIHlyID0gaW50
#8#KGF0dHJfc3RyKGNoMCwgIkltYWdlU2l6ZVkiLCAiMCIpIG9yIDApCiAgICAgICAgenIgPSBpbnQo
#8#YXR0cl9zdHIoY2gwLCAiSW1hZ2VTaXplWiIsICIwIikgb3IgMCkKICAgICAgICBpZiBub3QgKHhy
#8#IGFuZCB5ciBhbmQgenIpOgogICAgICAgICAgICBkYXRhID0gY2gwLmdldCgiRGF0YSIpCiAgICAg
#8#ICAgICAgIGlmIGRhdGEgaXMgTm9uZToKICAgICAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAg
#8#ICAgIHpyLCB5ciwgeHIgPSAoenIgb3IgZGF0YS5zaGFwZVswXSwgeXIgb3IgZGF0YS5zaGFwZVsx
#8#XSwgeHIgb3IgZGF0YS5zaGFwZVsyXSkKICAgICAgICBvdXQuYXBwZW5kKChMLCB4ciwgeXIsIHpy
#8#KSkKICAgIHJldHVybiBzb3J0ZWQob3V0LCBrZXk9bGFtYmRhIGx2OiBsdlswXSkKCgpkZWYgaW1z
#8#X2NoYW5uZWxfbmFtZXMoZiwgbl9jaCk6CiAgICAiIiJDaGFubmVsIGRpc3BsYXkgbmFtZXMgZnJv
#8#bSBEYXRhU2V0SW5mby9DaGFubmVsIHtpfTsgJycgd2hlbiBtaXNzaW5nIG9yIGEKICAgIGdlbmVy
#8#aWMgJ0NoYW5uZWwgTicgcGxhY2Vob2xkZXIsIHNvIHRoZSBjYWxsZXIgY2FuIGZhbGwgYmFjayBj
#8#bGVhbmx5LiIiIgogICAgaW5mbyA9IGYuZ2V0KCJEYXRhU2V0SW5mbyIsIHt9KQogICAgbmFtZXMg
#8#PSBbXQogICAgZm9yIGkgaW4gcmFuZ2Uobl9jaCk6CiAgICAgICAgY2ggPSBpbmZvLmdldChmIkNo
#8#YW5uZWwge2l9IikgaWYgaGFzYXR0cihpbmZvLCAiZ2V0IikgZWxzZSBOb25lCiAgICAgICAgbm0g
#8#PSByZS5zdWIociJceDAwLioiLCAiIiwgYXR0cl9zdHIoY2gsICJOYW1lIiwgIiIpKS5zdHJpcCgp
#8#IGlmIGNoIGlzIG5vdCBOb25lIGVsc2UgIiIKICAgICAgICBpZiByZS5tYXRjaChyIl5jaChhbm5l
#8#bCk/XHMqXGQrJCIsIG5tLCByZS5JR05PUkVDQVNFKToKICAgICAgICAgICAgbm0gPSAiIgogICAg
#8#ICAgIG5hbWVzLmFwcGVuZChubSkKICAgIHJldHVybiBuYW1lcwoKCmRlZiBjaG9vc2VfbGV2ZWwo
#8#bGV2ZWxzLCBuX2NoLCB0YXJnZXRfcHgsIG1heF9ieXRlcywgaXRlbXNpemU9Mik6CiAgICAiIiJM
#8#ZXZlbCB3aG9zZSBsb25nIFhZIHNpZGUgaXMgY2xvc2VzdCB0byB0YXJnZXRfcHgsIHN0ZXBwaW5n
#8#IHNtYWxsZXIgaWYgdGhlCiAgICBpbi1mbGlnaHQgdm9sdW1lIHdvdWxkIGV4Y2VlZCBtYXhfYnl0
#8#ZXMuIiIiCiAgICBjaG9zZW4gPSBtaW4obGV2ZWxzLCBrZXk9bGFtYmRhIGx2OiBhYnMobWF4KGx2
#8#WzFdLCBsdlsyXSkgLSB0YXJnZXRfcHgpKQogICAgd2hpbGUgY2hvc2VuWzFdICogY2hvc2VuWzJd
#8#ICogY2hvc2VuWzNdICogbl9jaCAqIGl0ZW1zaXplID4gbWF4X2J5dGVzOgogICAgICAgIHNtYWxs
#8#ZXIgPSBbbHYgZm9yIGx2IGluIGxldmVscyBpZiBsdlswXSA+IGNob3NlblswXV0KICAgICAgICBp
#8#ZiBub3Qgc21hbGxlcjoKICAgICAgICAgICAgYnJlYWsKICAgICAgICBjaG9zZW4gPSBtaW4oc21h
#8#bGxlciwga2V5PWxhbWJkYSBsdjogbHZbMF0pCiAgICByZXR1cm4gY2hvc2VuCgoKZGVmIHJhbXBf
#8#bHV0KHJnYik6CiAgICAiIiJCbGFja+KGkmNvbG91ciA4LWJpdCByYW1wLiBJbWFnZUogYXBwbGll
#8#cyBvbmUgcGVyIGNoYW5uZWwgaW4gY29tcG9zaXRlIG1vZGUsCiAgICBzbyB0aGUgZG93bmxvYWQg
#8#b3BlbnMgaW4gdGhlIHNhbWUgY29sb3VycyB0aGUgcGxhdGZvcm0gc2hvd3MuIiIiCiAgICBsdXQg
#8#PSBucC56ZXJvcygoMywgMjU2KSwgZHR5cGU9bnAudWludDgpCiAgICBmb3IgayBpbiByYW5nZSgz
#8#KToKICAgICAgICBsdXRba10gPSBucC5saW5zcGFjZSgwLCByZ2Jba10sIDI1NiwgZHR5cGU9bnAu
#8#dWludDgpCiAgICByZXR1cm4gbHV0CgoKZGVmIHJhbmdlX2Zyb21faGlzdChoaXN0LCBsb19wY3Q9
#8#MS4wLCBoaV9wY3Q9OTkuOSk6CiAgICAiIiJEaXNwbGF5IHJhbmdlIGZyb20gYW4gZXhhY3QgaW50
#8#ZW5zaXR5IGhpc3RvZ3JhbSDigJQgdGhlIHNhbWUgMXN04oCTOTkuOXRoCiAgICBwZXJjZW50aWxl
#8#IHdpbmRvdyBfYXV0b3NjYWxlIGdpdmVzIHRoZSBNSVAgUE5Hcywgc28gdGhlIHN0YWNrIG9wZW5z
#8#IGxvb2tpbmcKICAgIGxpa2UgdGhlbSBpbnN0ZWFkIG9mIGF0IHRoZSBkZXRlY3RvcidzIGZ1bGwg
#8#dGhlb3JldGljYWwgc3dlZXAuIiIiCiAgICB0b3RhbCA9IGludChoaXN0LnN1bSgpKQogICAgaWYg
#8#dG90YWwgPD0gMDoKICAgICAgICByZXR1cm4gMC4wLCAxLjAKICAgIGNkZiA9IG5wLmN1bXN1bSho
#8#aXN0KQogICAgbG8gPSBmbG9hdChucC5zZWFyY2hzb3J0ZWQoY2RmLCB0b3RhbCAqIGxvX3BjdCAv
#8#IDEwMC4wKSkKICAgIGhpID0gZmxvYXQobnAuc2VhcmNoc29ydGVkKGNkZiwgdG90YWwgKiBoaV9w
#8#Y3QgLyAxMDAuMCkpCiAgICBpZiBoaSA8PSBsbzoKICAgICAgICBueiA9IG5wLm5vbnplcm8oaGlz
#8#dClbMF0KICAgICAgICBsbywgaGkgPSAwLjAsIChmbG9hdChuelstMV0pIGlmIGxlbihueikgZWxz
#8#ZSAxLjApCiAgICByZXR1cm4gbG8sIG1heChoaSwgbG8gKyAxLjApCgoKZGVmIHRpZmZfaW5mbyhm
#8#b2xkZXIsIGxldmVsLCBjaF9uYW1lcywgdm94LCBkdHlwZSwgZnJhbWU9Tm9uZSk6CiAgICAiIiJG
#8#cmVlLXRleHQgYmxvY2sgc3VyZmFjZWQgYnkgRmlqaSdzIEltYWdlIOKWuCBTaG93IEluZm8uIGBm
#8#cmFtZWAgaXMKICAgICh0aW1lcG9pbnQgaW5kZXgsIHRpbWVwb2ludCBjb3VudCkgZm9yIG9uZSBm
#8#cmFtZSBvZiBhIHRpbWVsYXBzZS4iIiIKICAgIHJldHVybiAiXG4iLmpvaW4oWwogICAgICAgIGYi
#8#RGF0YXNldDoge2ZvbGRlcn0iLAogICAgICAgIGYiU291cmNlOiBJbWFyaXMgLmltcyBSZXNvbHV0
#8#aW9uTGV2ZWwge2xldmVsfSwgbmF0aXZlIHtkdHlwZX0iCiAgICAgICAgKyAoZiIsIHRpbWVwb2lu
#8#dCB7ZnJhbWVbMF19IG9mIDAuLntmcmFtZVsxXSAtIDF9IiBpZiBmcmFtZSBlbHNlICIiKSwKICAg
#8#ICAgICBmIlZveGVsIHNpemUgKHVtKTogWD17dm94WzBdOi42Z30gWT17dm94WzFdOi42Z30gWj17
#8#dm94WzJdOi42Z30iLAogICAgICAgICJDaGFubmVsczogIiArICIsICIuam9pbihmIkN7aSArIDF9
#8#PXtufSIgZm9yIGksIG4gaW4gZW51bWVyYXRlKGNoX25hbWVzKSksCiAgICAgICAgIlZveGVsIHZh
#8#bHVlcyBhcmUgdGhlIHJhdyBhY3F1aXNpdGlvbiBpbnRlbnNpdGllczsgb25seSB0aGUgc3RvcmVk
#8#ICIKICAgICAgICAiZGlzcGxheSByYW5nZSBpcyBzY2FsZWQgKEltYWdlID4gQWRqdXN0ID4gQnJp
#8#Z2h0bmVzcy9Db250cmFzdCkuIiwKICAgICAgICAiTHVtZW4zRCAvIElSSUJITSBNaWNyb3Njb3B5
#8#IFBsYXRmb3JtIiwKICAgIF0pCgoKY2xhc3MgVGlmZlRvb0xhcmdlKFJ1bnRpbWVFcnJvcik6CiAg
#8#ICAiIiJUaGUgd3JpdHRlbiBzdGFjayBvdmVyZmxvd2VkIHRoZSBJbWFnZUogZmxhdm91cidzIDMy
#8#LWJpdCBvZmZzZXRzLiIiIgoKCmRlZiB3cml0ZV9pbWFnZWpfdGlmZihwYXRoLCB2b2wsIHZveCwg
#8#bWV0YWRhdGEpOgogICAgIiIiV3JpdGUgdGhlIGNvbXBvc2l0ZSBoeXBlcnN0YWNrLCByZWZ1c2lu
#8#ZyBhIHNpbGVudGx5IHRydW5jYXRlZCBmaWxlOiB0aGUKICAgIEltYWdlSiBmbGF2b3VyIGlzIGNs
#8#YXNzaWMgVElGRiAoMzItYml0IG9mZnNldHMpLCBhbmQgcGFzdCB+NCBHaUIgdGlmZmZpbGUKICAg
#8#IHdhcm5zIGFuZCBrZWVwcyBvbmx5IHRoZSBmaXJzdCBJRkQsIHdoaWNoIG5vIHJlYWRlciBjYW4g
#8#b3Blbi4iIiIKICAgIGltcG9ydCB0aWZmZmlsZQogICAgd2l0aCB3YXJuaW5ncy5jYXRjaF93YXJu
#8#aW5ncyhyZWNvcmQ9VHJ1ZSkgYXMgY2F1Z2h0OgogICAgICAgIHdhcm5pbmdzLnNpbXBsZWZpbHRl
#8#cigiYWx3YXlzIikKICAgICAgICB0aWZmZmlsZS5pbXdyaXRlKAogICAgICAgICAgICBzdHIocGF0
#8#aCksIHZvbCwgaW1hZ2VqPVRydWUsIHBob3RvbWV0cmljPSJtaW5pc2JsYWNrIiwKICAgICAgICAg
#8#ICAgY29tcHJlc3Npb249InpsaWIiLAogICAgICAgICAgICByZXNvbHV0aW9uPSgxLjAgLyAodm94
#8#WzBdIG9yIDEuMCksIDEuMCAvICh2b3hbMV0gb3IgMS4wKSksCiAgICAgICAgICAgIHJlc29sdXRp
#8#b251bml0PSJOT05FIiwgbWV0YWRhdGE9bWV0YWRhdGEsCiAgICAgICAgKQogICAgZm9yIHcgaW4g
#8#Y2F1Z2h0OgogICAgICAgIGlmICJ0cnVuY2F0IiBpbiBzdHIody5tZXNzYWdlKS5sb3dlcigpOgog
#8#ICAgICAgICAgICBwYXRoLnVubGluayhtaXNzaW5nX29rPVRydWUpCiAgICAgICAgICAgIHJhaXNl
#8#IFRpZmZUb29MYXJnZShzdHIody5tZXNzYWdlKSkKCgpkZWYgX3RpbWVwb2ludF9jb3VudChmKSAt
#8#PiBpbnQ6CiAgICByZXMwID0gZlsiRGF0YVNldCJdWyJSZXNvbHV0aW9uTGV2ZWwgMCJdCiAgICBy
#8#ZXR1cm4gc3VtKDEgZm9yIGsgaW4gcmVzMC5rZXlzKCkgaWYgay5zdGFydHN3aXRoKCJUaW1lUG9p
#8#bnQiKSkgb3IgMQoKCmRlZiBfc2xhYl9wbGFuZXMoZGF0YSwgenIpIC0+IGludDoKICAgICIiIlBs
#8#YW5lcyByZWFkIHBlciBIREY1IGNhbGw6IG9uZSBjaHVuayBsYXllciwgc28gZWFjaCBjb21wcmVz
#8#c2VkIGNodW5rIGlzCiAgICBkZWNvbXByZXNzZWQgb25jZSBpbnN0ZWFkIG9mIG9uY2UgcGVyIHBs
#8#YW5lIGl0IHNwYW5zLiIiIgogICAgY2h1bmtzID0gZ2V0YXR0cihkYXRhLCAiY2h1bmtzIiwgTm9u
#8#ZSkKICAgIHJldHVybiBtYXgoMSwgbWluKHpyLCBjaHVua3NbMF0gaWYgY2h1bmtzIGVsc2UgMTYp
#8#KQoKCmRlZiBidWlsZF90aWZmX2FuZF9taXBzKGltc19zcmMsIGRzX2RpciwgZm9sZGVyLCBjaGFu
#8#bmVsc19tZXRhLCB0aWZmX3BhdGgsCiAgICAgICAgICAgICAgICAgICAgICAgIG1pcF9wYXRoc19m
#8#b3IsIHdhbnRfdGlmZiwgd2FudF9taXAsIGZvcmNlLCBkcnksIHRpbWVwb2ludD0wKToKICAgICIi
#8#IlJldHVybnMgYSBzdGF0dXMgc3RyaW5nLiBSZWFkcyBPTkUgcHlyYW1pZCBsZXZlbCAo4omIVEFS
#8#R0VUX1BYKSBvZiBPTkUgdGltZXBvaW50LAogICAgc3RyZWFtcyBpdCBpbnRvIGEgZGlzay1iYWNr
#8#ZWQgbWVtbWFwIGluIHRoZSBzeXN0ZW0gdGVtcCBkaXIgKGxvdyBSQU0sIG5ldmVyIGxpdHRlcnMK
#8#ICAgIGRvd25sb2FkLyksIHdyaXRlcyBhIGNhbGlicmF0ZWQgSW1hZ2VKIGNvbXBvc2l0ZSBoeXBl
#8#cnN0YWNrLCBhbmQgZW1pdHMgcGVyLWNoYW5uZWwKICAgIE1JUCBQTkdzLiIiIgogICAgaW1wb3J0
#8#IGg1cHkKCiAgICB0aWZmX2RvbmUgPSB0aWZmX3BhdGguZXhpc3RzKCkgYW5kIG5vdCBmb3JjZQog
#8#ICAgaWYgZHJ5OgogICAgICAgIHJldHVybiAid291bGQgYnVpbGQgdGlmZittaXBzIgoKICAgIHdp
#8#dGggaDVweS5GaWxlKHN0cihpbXNfc3JjKSwgInIiLCByZGNjX25ieXRlcz02NCAqIDEwMjQgKiAx
#8#MDI0KSBhcyBmOgogICAgICAgIGluZm8gPSBmLmdldCgiRGF0YVNldEluZm8iLCB7fSkuZ2V0KCJJ
#8#bWFnZSIsIE5vbmUpCiAgICAgICAgbl90cCA9IF90aW1lcG9pbnRfY291bnQoZikKICAgICAgICBp
#8#ZiBub3QgMCA8PSB0aW1lcG9pbnQgPCBuX3RwOgogICAgICAgICAgICByZXR1cm4gZiJ0aW1lcG9p
#8#bnQge3RpbWVwb2ludH0gb3V0IG9mIHJhbmdlICgwLi57bl90cCAtIDF9KSIKICAgICAgICBmcmFt
#8#ZSA9ICh0aW1lcG9pbnQsIG5fdHApIGlmIG5fdHAgPiAxIGVsc2UgTm9uZQogICAgICAgIGxldmVs
#8#cyA9IGxpc3RfbGV2ZWxzKGYsIHRpbWVwb2ludCkKICAgICAgICBpZiBub3QgbGV2ZWxzOgogICAg
#8#ICAgICAgICByZXR1cm4gIm5vIHJlc29sdXRpb24gbGV2ZWxzIgogICAgICAgIHRwMCA9IGZbIkRh
#8#dGFTZXQiXVsiUmVzb2x1dGlvbkxldmVsIDAiXVtmIlRpbWVQb2ludCB7dGltZXBvaW50fSJdCiAg
#8#ICAgICAgY2hfa2V5cyA9IHNvcnRlZChbayBmb3IgayBpbiB0cDAua2V5cygpIGlmIGsuc3RhcnRz
#8#d2l0aCgiQ2hhbm5lbCIpXSwKICAgICAgICAgICAgICAgICAgICAgICAgIGtleT1sYW1iZGEgczog
#8#aW50KHMuc3BsaXQoKVstMV0pKQogICAgICAgIG5fY2ggPSBsZW4oY2hfa2V5cykKCiAgICAgICAg
#8#IyBDaGFubmVsIG5hbWVzOiBwcmVmZXIgdGhlIGN1cmF0ZWQgY2F0YWxvZyBuYW1lLCBlbHNlIHRo
#8#ZSAuaW1zIG5hbWUsCiAgICAgICAgIyBlbHNlIGEgZ2VuZXJpYyBwbGFjZWhvbGRlci4gQ29sb3Vy
#8#cyBjb21lIGZyb20gdGhlIGNhdGFsb2cgd2hlbiBwcmVzZW50LgogICAgICAgIGNhdCA9IF9wYWQo
#8#Y2hhbm5lbHNfbWV0YSwgbl9jaCkKICAgICAgICBpbXNfbmFtZXMgPSBpbXNfY2hhbm5lbF9uYW1l
#8#cyhmLCBuX2NoKQogICAgICAgIGNoX25hbWVzID0gWyhjYXRbaV0uZ2V0KCJuYW1lIikgb3IgaW1z
#8#X25hbWVzW2ldIG9yIGYiQ2hhbm5lbCB7aSsxfSIpIGZvciBpIGluIHJhbmdlKG5fY2gpXQoKICAg
#8#ICAgICAjIFRoZSBhY3F1aXNpdGlvbidzIGJpdCBkZXB0aCBpcyBwcmVzZXJ2ZWQuIFByb21vdGlu
#8#ZyBhbiA4LWJpdCBhY3F1aXNpdGlvbgogICAgICAgICMgdG8gdWludDE2IGxlYXZlcyBldmVyeSB2
#8#YWx1ZSBpbiB0aGUgYm90dG9tIDAuNCUgb2YgdGhlIHJhbmdlLCB3aGljaCBhbnkKICAgICAgICAj
#8#IHJlYWRlciB0aGF0IHRydXN0cyB0aGUgZGVjbGFyZWQgZGVwdGggcmVuZGVycyBhcyBibGFjay4K
#8#ICAgICAgICBkdHlwZSA9IG5wLmR0eXBlKHRwMFtjaF9rZXlzWzBdXVsiRGF0YSJdLmR0eXBlKQoK
#8#ICAgICAgICBuZWVkX3ZvbCA9IHdhbnRfdGlmZiBhbmQgbm90IHRpZmZfZG9uZQogICAgICAgIGlm
#8#IG5vdCBuZWVkX3ZvbCBhbmQgbm90IHdhbnRfbWlwOgogICAgICAgICAgICByZXR1cm4gInRpZmYg
#8#c2tpcCAoZXhpc3RzKSIgaWYgd2FudF90aWZmIGVsc2UgIm5vdGhpbmcgdG8gZG8iCgogICAgICAg
#8#ICMgUGh5c2ljYWwgZXh0ZW50IGlzIGxldmVsLWluZGVwZW5kZW50IOKGkiB2b3hlbCBzaXplID0g
#8#ZXh0ZW50IC8gbGV2ZWwgZGltcy4KICAgICAgICBleHQgPSBsYW1iZGEgbG8sIGhpOiAoYXR0cl9m
#8#bG9hdChpbmZvLCBoaSwgMS4wKSAtIGF0dHJfZmxvYXQoaW5mbywgbG8sIDAuMCkpCgogICAgICAg
#8#ICMgQmVzdCBsZXZlbCBmaXJzdCwgdGhlbiBldmVyeSBjb2Fyc2VyIG9uZS4gV2hldGhlciB0aGUg
#8#Y29tcHJlc3NlZCBzdGFjawogICAgICAgICMgY2xlYXJzIHRoZSBjbGFzc2ljLVRJRkYgb2Zmc2V0
#8#IGxpbWl0IGlzIG9ubHkga25vd2FibGUgYWZ0ZXIgd3JpdGluZyBpdCwKICAgICAgICAjIHNvIGFu
#8#IG92ZXJmbG93IHN0ZXBzIGRvd24gaW5zdGVhZCBvZiBsZWF2aW5nIHRoZSBkYXRhc2V0IHdpdGgg
#8#bm8gVElGRi4KICAgICAgICBiZXN0ID0gY2hvb3NlX2xldmVsKGxldmVscywgbl9jaCwgVEFSR0VU
#8#X1BYLCBNQVhfVElGRl9CWVRFUywgZHR5cGUuaXRlbXNpemUpCiAgICAgICAgY2FuZGlkYXRlcyA9
#8#IFtsdiBmb3IgbHYgaW4gbGV2ZWxzIGlmIGx2WzBdID49IGJlc3RbMF1dCgogICAgICAgICMgRXhh
#8#Y3QgcGVyLWNoYW5uZWwgaGlzdG9ncmFtIOKGkiBkaXNwbGF5IHJhbmdlLiBPbmx5IHRoZSBpbnRl
#8#Z2VyIHR5cGVzIGdldAogICAgICAgICMgb25lOyBJbWFnZUogYWxyZWFkeSBhdXRvLXNjYWxlcyBm
#8#bG9hdCBpbWFnZXMgd2hlbiBpdCBvcGVucyB0aGVtLgogICAgICAgIG5iaW5zID0gKDEgPDwgKDgg
#8#KiBkdHlwZS5pdGVtc2l6ZSkpIGlmIGR0eXBlLmtpbmQgPT0gInUiIGFuZCBkdHlwZS5pdGVtc2l6
#8#ZSA8PSAyIGVsc2UgMAoKICAgICAgICBzdGF0dXMsIG1pcHMgPSBbXSwgW10KICAgICAgICBmb3Ig
#8#YXR0ZW1wdCwgKEwsIFhyLCBZciwgWnIpIGluIGVudW1lcmF0ZShjYW5kaWRhdGVzKToKICAgICAg
#8#ICAgICAgdm94ID0gKAogICAgICAgICAgICAgICAgZXh0KCJFeHRNaW4wIiwgIkV4dE1heDAiKSAv
#8#IG1heChYciwgMSksCiAgICAgICAgICAgICAgICBleHQoIkV4dE1pbjEiLCAiRXh0TWF4MSIpIC8g
#8#bWF4KFlyLCAxKSwKICAgICAgICAgICAgICAgIGV4dCgiRXh0TWluMiIsICJFeHRNYXgyIikgLyBt
#8#YXgoWnIsIDEpLAogICAgICAgICAgICApCiAgICAgICAgICAgIGJhc2UgPSBmWyJEYXRhU2V0Il1b
#8#ZiJSZXNvbHV0aW9uTGV2ZWwge0x9Il1bZiJUaW1lUG9pbnQge3RpbWVwb2ludH0iXQogICAgICAg
#8#ICAgICBoaXN0cyA9IChbbnAuemVyb3MobmJpbnMsIGR0eXBlPW5wLmludDY0KSBmb3IgXyBpbiBy
#8#YW5nZShuX2NoKV0KICAgICAgICAgICAgICAgICAgICAgaWYgbmVlZF92b2wgYW5kIG5iaW5zIGVs
#8#c2UgTm9uZSkKICAgICAgICAgICAgdG1wX2RpciA9IFBhdGgodGVtcGZpbGUubWtkdGVtcChwcmVm
#8#aXg9Imx1bWVuX2J1bmRsZV8iKSkKICAgICAgICAgICAgYXJyLCBtaXBzID0gTm9uZSwgW10KICAg
#8#ICAgICAgICAgdHJ5OgogICAgICAgICAgICAgICAgaWYgbmVlZF92b2w6CiAgICAgICAgICAgICAg
#8#ICAgICAgIyBJbWFnZUogaHlwZXJzdGFjayBheGlzIG9yZGVyIGlzIFRaQ1lYIOKGkiAoWiwgQywg
#8#WSwgWCkgYXQgVD0xLgogICAgICAgICAgICAgICAgICAgIGFyciA9IG5wLm1lbW1hcCh0bXBfZGly
#8#IC8gZiJ7Zm9sZGVyfS52b2wuZGF0IiwgZHR5cGU9ZHR5cGUsCiAgICAgICAgICAgICAgICAgICAg
#8#ICAgICAgICAgICAgICAgIG1vZGU9IncrIiwgc2hhcGU9KFpyLCBuX2NoLCBZciwgWHIpKQogICAg
#8#ICAgICAgICAgICAgZm9yIGNpLCBjayBpbiBlbnVtZXJhdGUoY2hfa2V5cyk6CiAgICAgICAgICAg
#8#ICAgICAgICAgZGF0YSA9IGJhc2VbY2tdWyJEYXRhIl0KICAgICAgICAgICAgICAgICAgICBtaXAg
#8#PSBucC56ZXJvcygoWXIsIFhyKSwgZHR5cGU9ZHR5cGUpCiAgICAgICAgICAgICAgICAgICAgc3Rl
#8#cCA9IF9zbGFiX3BsYW5lcyhkYXRhLCBacikKICAgICAgICAgICAgICAgICAgICBmb3IgejAgaW4g
#8#cmFuZ2UoMCwgWnIsIHN0ZXApOiAgICAgICAgIyBvbmUgY2h1bmsgbGF5ZXIgYXQgYSB0aW1lIOKG
#8#kiBsb3cgUkFNCiAgICAgICAgICAgICAgICAgICAgICAgIHNsYWIgPSBkYXRhW3owOm1pbih6MCAr
#8#IHN0ZXAsIFpyKSwgOllyLCA6WHJdCiAgICAgICAgICAgICAgICAgICAgICAgIGZvciBrLCBwbGFu
#8#ZSBpbiBlbnVtZXJhdGUoc2xhYik6CiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiBhcnIg
#8#aXMgbm90IE5vbmU6CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXJyW3owICsgaywg
#8#Y2ldID0gcGxhbmUKICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5wLm1heGltdW0obWlwLCBw
#8#bGFuZSwgb3V0PW1pcCkgICMgTUlQIGFjY3J1ZXMgaW4gdGhlIHNhbWUgcGFzcwogICAgICAgICAg
#8#ICAgICAgICAgICAgICAgICAgaWYgaGlzdHMgaXMgbm90IE5vbmU6CiAgICAgICAgICAgICAgICAg
#8#ICAgICAgICAgICAgICAgaGlzdHNbY2ldICs9IG5wLmJpbmNvdW50KHBsYW5lLnJhdmVsKCksIG1p
#8#bmxlbmd0aD1uYmlucykKICAgICAgICAgICAgICAgICAgICAgICAgZGVsIHNsYWIKICAgICAgICAg
#8#ICAgICAgICAgICBtaXBzLmFwcGVuZChtaXApCgogICAgICAgICAgICAgICAgaWYgbm90IG5lZWRf
#8#dm9sOgogICAgICAgICAgICAgICAgICAgIGJyZWFrICAgICAgICAgICAgICAgICAgICAgICAgICAg
#8#ICAgICMgTUlQLW9ubHk6IG5vdGhpbmcgdG8gd3JpdGUKICAgICAgICAgICAgICAgIGFyci5mbHVz
#8#aCgpCgogICAgICAgICAgICAgICAgcmFuZ2VzLCBsdXRzID0gW10sIFtdCiAgICAgICAgICAgICAg
#8#ICBmb3IgY2kgaW4gcmFuZ2Uobl9jaCk6CiAgICAgICAgICAgICAgICAgICAgbHV0cy5hcHBlbmQo
#8#cmFtcF9sdXQoaGV4X3RvX3JnYihjYXRbY2ldLmdldCgiY29sb3IiKSwKICAgICAgICAgICAgICAg
#8#ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFRIVU1CX0NPTE9SU1tjaSAlIGxl
#8#bihUSFVNQl9DT0xPUlMpXSkpKQogICAgICAgICAgICAgICAgICAgIGlmIGhpc3RzIGlzIG5vdCBO
#8#b25lOgogICAgICAgICAgICAgICAgICAgICAgICByYW5nZXMuZXh0ZW5kKHJhbmdlX2Zyb21faGlz
#8#dChoaXN0c1tjaV0pKQogICAgICAgICAgICAgICAgbWV0YSA9IHsKICAgICAgICAgICAgICAgICAg
#8#ICAiYXhlcyI6ICJaQ1lYIiwgInNwYWNpbmciOiB2b3hbMl0sICJ1bml0IjogInVtIiwKICAgICAg
#8#ICAgICAgICAgICAgICAibW9kZSI6ICJjb21wb3NpdGUiLCAiTFVUcyI6IGx1dHMsCiAgICAgICAg
#8#ICAgICAgICAgICAgIkxhYmVscyI6IFtjaF9uYW1lc1tjXSBmb3IgXyBpbiByYW5nZShacikgZm9y
#8#IGMgaW4gcmFuZ2Uobl9jaCldLAogICAgICAgICAgICAgICAgICAgICJJbmZvIjogdGlmZl9pbmZv
#8#KGZvbGRlciwgTCwgY2hfbmFtZXMsIHZveCwgZHR5cGUsIGZyYW1lKSwKICAgICAgICAgICAgICAg
#8#IH0KICAgICAgICAgICAgICAgIGlmIHJhbmdlczoKICAgICAgICAgICAgICAgICAgICBtZXRhWyJS
#8#YW5nZXMiXSA9IHR1cGxlKHJhbmdlcykKICAgICAgICAgICAgICAgIHRtcF90aWYgPSB0aWZmX3Bh
#8#dGgud2l0aF9zdWZmaXgoIi50aWYudG1wIikKICAgICAgICAgICAgICAgIHRyeToKICAgICAgICAg
#8#ICAgICAgICAgICB3cml0ZV9pbWFnZWpfdGlmZih0bXBfdGlmLCBucC5hc2FycmF5KGFyciksIHZv
#8#eCwgbWV0YSkKICAgICAgICAgICAgICAgIGV4Y2VwdCBUaWZmVG9vTGFyZ2UgYXMgZXhjOgogICAg
#8#ICAgICAgICAgICAgICAgIGlmIGF0dGVtcHQgKyAxID49IGxlbihjYW5kaWRhdGVzKToKICAgICAg
#8#ICAgICAgICAgICAgICAgICAgcmFpc2UgUnVudGltZUVycm9yKAogICAgICAgICAgICAgICAgICAg
#8#ICAgICAgICAgZiJubyBweXJhbWlkIGxldmVsIGZpdHMgYW4gSW1hZ2VKIFRJRkYgKHtleGN9KSIp
#8#IGZyb20gZXhjCiAgICAgICAgICAgICAgICAgICAgcHJpbnQoZiIgIFt0aWZmXSBMe0x9IHtYcn14
#8#e1lyfXh7WnJ9IG92ZXJmbG93cyB0aGUgSW1hZ2VKIFRJRkYgIgogICAgICAgICAgICAgICAgICAg
#8#ICAgICAgIGYib2Zmc2V0IGxpbWl0IOKAlCByZXRyeWluZyBvbmUgbGV2ZWwgY29hcnNlciIpCiAg
#8#ICAgICAgICAgICAgICAgICAgY29udGludWUKICAgICAgICAgICAgICAgIG9zLnJlcGxhY2UodG1w
#8#X3RpZiwgdGlmZl9wYXRoKQogICAgICAgICAgICAgICAgc3RhdHVzLmFwcGVuZChmInRpZmYgTHtM
#8#fSB7WHJ9eHtZcn14e1pyfSB7ZHR5cGV9ICIKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg
#8#KyAoZiJ0e3RpbWVwb2ludH0gIiBpZiBmcmFtZSBlbHNlICIiKQogICAgICAgICAgICAgICAgICAg
#8#ICAgICAgICAgICArIGYie2ZtdF9zaXplKHRpZmZfcGF0aC5zdGF0KCkuc3Rfc2l6ZSl9IikKICAg
#8#ICAgICAgICAgICAgIGJyZWFrCiAgICAgICAgICAgIGZpbmFsbHk6CiAgICAgICAgICAgICAgICAj
#8#IFdpbmRvd3MgcmVmdXNlcyB0byB1bmxpbmsgYSBmaWxlIHRoYXQgaXMgc3RpbGwgbWFwcGVkLCBh
#8#bmQgYQogICAgICAgICAgICAgICAgIyByYWlzZWQgZXhjZXB0aW9uIGtlZXBzIHRoZSBucC5hc2Fy
#8#cmF5KCkgdmlldyBhbGl2ZSBpbiBpdHMKICAgICAgICAgICAgICAgICMgdHJhY2ViYWNrIOKAlCBz
#8#byBkcm9wIHRoZSBtYXBwaW5nIGV4cGxpY2l0bHkgb3IgdGhlIG11bHRpLUdpQgogICAgICAgICAg
#8#ICAgICAgIyBzY3JhdGNoIGZpbGUgc3Vydml2ZXMgdGhlIHJ1bi4KICAgICAgICAgICAgICAgIGlm
#8#IGFyciBpcyBub3QgTm9uZToKICAgICAgICAgICAgICAgICAgICB0cnk6CiAgICAgICAgICAgICAg
#8#ICAgICAgICAgIGFyci5fbW1hcC5jbG9zZSgpCiAgICAgICAgICAgICAgICAgICAgZXhjZXB0IEV4
#8#Y2VwdGlvbjoKICAgICAgICAgICAgICAgICAgICAgICAgcGFzcwogICAgICAgICAgICAgICAgZGVs
#8#IGFycgogICAgICAgICAgICAgICAgc2h1dGlsLnJtdHJlZSh0bXBfZGlyLCBpZ25vcmVfZXJyb3Jz
#8#PVRydWUpCgogICAgICAgIGlmIHdhbnRfdGlmZiBhbmQgbm90IG5lZWRfdm9sOgogICAgICAgICAg
#8#ICBzdGF0dXMuYXBwZW5kKCJ0aWZmIHNraXAgKGV4aXN0cykiKQoKICAgICAgICBpZiB3YW50X21p
#8#cDoKICAgICAgICAgICAgZnJvbSBQSUwgaW1wb3J0IEltYWdlCiAgICAgICAgICAgIG1hZGUgPSAw
#8#CiAgICAgICAgICAgIGZvciBjaSwgbWlwIGluIGVudW1lcmF0ZShtaXBzKToKICAgICAgICAgICAg
#8#ICAgIG91dCA9IG1pcF9wYXRoc19mb3IoY2ksIGNoX25hbWVzW2NpXSkKICAgICAgICAgICAgICAg
#8#IGlmIG91dC5leGlzdHMoKSBhbmQgbm90IGZvcmNlOgogICAgICAgICAgICAgICAgICAgIGNvbnRp
#8#bnVlCiAgICAgICAgICAgICAgICByZ2IgPSBoZXhfdG9fcmdiKGNhdFtjaV0uZ2V0KCJjb2xvciIp
#8#LCBUSFVNQl9DT0xPUlNbY2kgJSBsZW4oVEhVTUJfQ09MT1JTKV0pCiAgICAgICAgICAgICAgICBu
#8#b3JtID0gX2F1dG9zY2FsZShtaXApICAgICAgICAgICAgICAgICAgIyAwLi4xIGZsb2F0CiAgICAg
#8#ICAgICAgICAgICBpbWcgPSBucC56ZXJvcygobWlwLnNoYXBlWzBdLCBtaXAuc2hhcGVbMV0sIDMp
#8#LCBkdHlwZT1ucC51aW50OCkKICAgICAgICAgICAgICAgIGZvciBrIGluIHJhbmdlKDMpOgogICAg
#8#ICAgICAgICAgICAgICAgIGltZ1s6LCA6LCBrXSA9IG5wLmNsaXAobm9ybSAqIHJnYltrXSwgMCwg
#8#MjU1KS5hc3R5cGUobnAudWludDgpCiAgICAgICAgICAgICAgICBJbWFnZS5mcm9tYXJyYXkoaW1n
#8#LCAiUkdCIikuc2F2ZShzdHIob3V0KSkKICAgICAgICAgICAgICAgIG1hZGUgKz0gMQogICAgICAg
#8#ICAgICBzdGF0dXMuYXBwZW5kKGYie21hZGV9IE1JUCBwbmciKQogICAgICAgIHJldHVybiAiOyAi
#8#LmpvaW4oc3RhdHVzKSBvciAibm90aGluZyB0byBkbyIKCgpkZWYgX3BhZChjaGFubmVsc19tZXRh
#8#LCBuKToKICAgIGNtID0gbGlzdChjaGFubmVsc19tZXRhIG9yIFtdKQogICAgd2hpbGUgbGVuKGNt
#8#KSA8IG46CiAgICAgICAgY20uYXBwZW5kKHt9KQogICAgcmV0dXJuIGNtCgoKZGVmIF9hdXRvc2Nh
#8#bGUocGxhbmUpOgogICAgIiIiUm9idXN0IDAuLjEgbm9ybWFsaXNhdGlvbiAoMXN04oCTOTkuOXRo
#8#IHBlcmNlbnRpbGUpIGZvciBhIE1JUCBvZiBhbnkgZGVwdGguIiIiCiAgICBwID0gcGxhbmUuYXN0
#8#eXBlKG5wLmZsb2F0MzIpCiAgICBsbyA9IGZsb2F0KG5wLnBlcmNlbnRpbGUocCwgMS4wKSkKICAg
#8#IGhpID0gZmxvYXQobnAucGVyY2VudGlsZShwLCA5OS45KSkKICAgIGlmIGhpIDw9IGxvOgogICAg
#8#ICAgIGhpID0gZmxvYXQocC5tYXgoKSkgb3IgMS4wCiAgICAgICAgbG8gPSAwLjAKICAgIHJldHVy
#8#biBucC5jbGlwKChwIC0gbG8pIC8gKGhpIC0gbG8pLCAwLjAsIDEuMCkKCgojIOKUgOKUgCBTdGVw
#8#IDUg4oCUIFJFQURNRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#8#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#8#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#8#lIDilIDilIDilIDilIAKZGVmIHdyaXRlX3JlYWRtZShvdXRfcGF0aCwgZHMsIGltc19zcmMsIGZv
#8#cmNlLCBkcnksIHRpbWVwb2ludD0wKToKICAgIGlmIG91dF9wYXRoLmV4aXN0cygpIGFuZCBub3Qg
#8#Zm9yY2U6CiAgICAgICAgcmV0dXJuICJza2lwIChleGlzdHMpIgogICAgaWYgZHJ5OgogICAgICAg
#8#IHJldHVybiAid291bGQgd3JpdGUiCiAgICBsaW5lcyA9IF9yZWFkbWVfcGhvdG8oZHMpIGlmIGRz
#8#WyJ0eXBlIl0gPT0gIjJkIiBlbHNlIF9yZWFkbWVfdm9sdW1lKGRzLCBpbXNfc3JjLCB0aW1lcG9p
#8#bnQpCiAgICBsaW5lcyArPSBbCiAgICAgICAgIiIsCiAgICAgICAgIkNpdGF0aW9uOiBjaXRlIHRo
#8#ZSBJUklCSE0gTWljcm9zY29weSBQbGF0Zm9ybSAoTHVtZW4zRCwgSVJJQkhNIEAgVUxCKSBhbmQg
#8#IgogICAgICAgICJ0aGUgb3JpZ2luYWwgZXhwZXJpbWVudC9wdWJsaWNhdGlvbiB3aGVuIGF2YWls
#8#YWJsZS4iLAogICAgICAgIGYiR2VuZXJhdGVkOiB7dGltZS5zdHJmdGltZSgnJVktJW0tJWQgJUg6
#8#JU06JVMnKX0iLAogICAgXQogICAgb3V0X3BhdGgud3JpdGVfdGV4dCgiXG4iLmpvaW4obGluZXMp
#8#LCBlbmNvZGluZz0idXRmLTgiKQogICAgcmV0dXJuICJvayIKCgpkZWYgX3JlYWRtZV9waG90byhk
#8#cyk6CiAgICAiIiJBICcyZCcgZGF0YXNldCBpcyBvbmUgY2FsaWJyYXRlZCBwaG90b2dyYXBoOiBu
#8#byB2b3hlbHMsIG5vIGNoYW5uZWxzLCBhbmQgbm8KICAgIC5pbXMgdG8gcmUtcmVhZCDigJQgdGhl
#8#IG9yaWdpbmFsIFRJRkYgYmVzaWRlIGl0IGNvbWVzIGZyb20gdGhlIGltcG9ydGVyLiIiIgogICAg
#8#bWV0YSA9IGRzWyJtZXRhIl0KICAgIGRpbXMgPSBtZXRhLmdldCgiZGltZW5zaW9ucyIsIHt9KQog
#8#ICAgcHggPSAobWV0YS5nZXQoInBpeGVsU2l6ZVVtIikgb3Ige30pLmdldCgieCIpCiAgICBhY3Eg
#8#PSBtZXRhLmdldCgiYWNxdWlzaXRpb24iLCB7fSkKICAgIHJldHVybiBbCiAgICAgICAgZiJEYXRh
#8#c2V0IDoge2RzWydmb2xkZXInXX0iLAogICAgICAgIGYiVHlwZSAgICA6IHtkc1sndHlwZSddfSAo
#8#Y2FsaWJyYXRlZCBwaG90b2dyYXBoKSIsCiAgICAgICAgZiJTdGFnZSAgIDoge21ldGEuZ2V0KCdz
#8#dGFnZScsICc/Jyl9ICAgIExpbmU6IHttZXRhLmdldCgnbGluZScpIG9yICc/J30iCiAgICAgICAg
#8#ZiIgICAgU3RhaW5pbmc6IHttZXRhLmdldCgnc3RhaW5pbmcnKSBvciAnPyd9IiwKICAgICAgICAi
#8#IiwKICAgICAgICBmIkltYWdlICAgICAgOiB7ZGltcy5nZXQoJ3gnLCc/Jyl9IHgge2RpbXMuZ2V0
#8#KCd5JywnPycpfSBweCwgUkdCIDgtYml0IiwKICAgICAgICAiUGl4ZWwgc2l6ZSA6ICIgKyAoZiJ7
#8#cHg6LjRmfSB1bS9weCIgaWYgaXNpbnN0YW5jZShweCwgKGludCwgZmxvYXQpKSBlbHNlICJ1bmtu
#8#b3duIiksCiAgICAgICAgZiJNaWNyb3Njb3BlIDoge2FjcS5nZXQoJ21pY3Jvc2NvcGUnKSBvciAn
#8#LSd9ICAgIGNhbWVyYSB7YWNxLmdldCgnY2FtZXJhJykgb3IgJy0nfSIsCiAgICAgICAgZiJTb3Vy
#8#Y2UgICAgIDoge2FjcS5nZXQoJ3NvdXJjZUZpbGUnKSBvciAnLSd9IiwKICAgICAgICAiIiwKICAg
#8#ICAgICAiRmlsZXMgaW4gdGhpcyBmb2xkZXI6IiwKICAgICAgICBmIiAge2RzWydmb2xkZXInXX1f
#8#d2ViLnppcCAgIGFyY2hpdmUgb2YgdGhlIHdlYiBkYXRhc2V0ICIKICAgICAgICAiKGltYWdlLndl
#8#YnAgKyBwcmV2aWV3LndlYnAgKyB0aHVtYm5haWwgKyBtZXRhZGF0YSkiLAogICAgICAgICIgIDxv
#8#cmlnaW5hbD4udGlmICAgICAgICAgICB1bnRvdWNoZWQgSW1hZ2VKL0xlaWNhIGV4cG9ydCwgcHJl
#8#c2VudCB3aGVuIHRoZSAiCiAgICAgICAgImltcG9ydCByYW4gd2l0aCAtLXdpdGgtZG93bmxvYWRz
#8#IiwKICAgIF0KCgpkZWYgX3JlYWRtZV92b2x1bWUoZHMsIGltc19zcmMsIHRpbWVwb2ludD0wKToK
#8#ICAgIG1ldGEgPSBkc1sibWV0YSJdCiAgICBkaW1zID0gbWV0YS5nZXQoImRpbWVuc2lvbnMiLCB7
#8#fSkKICAgIHZveCA9IG1ldGEuZ2V0KCJ2b3hlbF9zaXplIiwge30pCiAgICBjaGFucyA9IG1ldGEu
#8#Z2V0KCJjaGFubmVscyIsIFtdKQogICAgbGluZXMgPSBbCiAgICAgICAgZiJEYXRhc2V0IDoge2Rz
#8#Wydmb2xkZXInXX0iLAogICAgICAgIGYiVHlwZSAgICA6IHtkc1sndHlwZSddfSIsCiAgICAgICAg
#8#ZiJTdGFnZSAgIDoge21ldGEuZ2V0KCdzdGFnZScsICc/Jyl9ICAgIEVtYnJ5bzoge21ldGEuZ2V0
#8#KCdlbWJyeW8nLCAnPycpfSIsCiAgICAgICAgIiIsCiAgICAgICAgIkRpbWVuc2lvbnMgKHZveGVs
#8#cykgOiAiCiAgICAgICAgZiJYPXtkaW1zLmdldCgneCcsJz8nKX0gIFk9e2RpbXMuZ2V0KCd5Jywn
#8#PycpfSAgWj17ZGltcy5nZXQoJ3onLCc/Jyl9ICAiCiAgICAgICAgZiJDPXtkaW1zLmdldCgnYycs
#8#Jz8nKX0gIFQ9e2RpbXMuZ2V0KCd0JywnPycpfSIsCiAgICAgICAgIlZveGVsIHNpemUgKMK1bSkg
#8#ICAgIDogIgogICAgICAgIGYiWD17dm94LmdldCgneCcsJz8nKX0gIFk9e3ZveC5nZXQoJ3knLCc/
#8#Jyl9ICBaPXt2b3guZ2V0KCd6JywnPycpfSIsCiAgICAgICAgIiIsCiAgICAgICAgIkNoYW5uZWxz
#8#OiIsCiAgICBdCiAgICBmb3IgaSwgYyBpbiBlbnVtZXJhdGUoY2hhbnMpOgogICAgICAgIGxpbmVz
#8#LmFwcGVuZChmIiAgQ3tpKzF9OiB7Yy5nZXQoJ25hbWUnLCc/Jyl9ICBjb2xvcj17Yy5nZXQoJ2Nv
#8#bG9yJywnPycpfSAgIgogICAgICAgICAgICAgICAgICAgICBmImdhbW1hPXtjLmdldCgnZ2FtbWEn
#8#LCc/Jyl9IikKICAgIG5fdHAgPSBkaW1zLmdldCgidCIpIGlmIGlzaW5zdGFuY2UoZGltcy5nZXQo
#8#InQiKSwgaW50KSBlbHNlIDEKICAgIG9uZV9mcmFtZSA9IGYiIOKAlCB0aW1lcG9pbnQge3RpbWVw
#8#b2ludH0gb2YgMC4ue25fdHAgLSAxfSBvbmx5IiBpZiBuX3RwID4gMSBlbHNlICIiCiAgICBsaW5l
#8#cyArPSBbCiAgICAgICAgIiIsCiAgICAgICAgIkZpbGVzIGluIHRoaXMgZm9sZGVyOiIsCiAgICAg
#8#ICAgZiIgIHtkc1snZm9sZGVyJ119X3dlYi56aXAgICBhcmNoaXZlIG9mIHRoZSB3ZWIvcHJlcHJv
#8#Y2Vzc2VkIGRhdGFzZXQgIgogICAgICAgICIoYnJpY2tzICsgbWV0YWRhdGEgKyB0aHVtYm5haWwi
#8#ICsgKCIsIGV2ZXJ5IHRpbWVwb2ludCkiIGlmIG5fdHAgPiAxIGVsc2UgIikiKSwKICAgICAgICBm
#8#IiAge2RzWydmb2xkZXInXX0uaW1zICAgICAgIG9yaWdpbmFsIEltYXJpcyBhY3F1aXNpdGlvbiIK
#8#ICAgICAgICArIChmIiAgKHtmbXRfc2l6ZShpbXNfc3JjLnN0YXQoKS5zdF9zaXplKX0pIiBpZiBp
#8#bXNfc3JjIGFuZCBpbXNfc3JjLmV4aXN0cygpIGVsc2UgIiAobm90IGF2YWlsYWJsZSkiKSwKICAg
#8#ICAgICBmIiAge2RzWydmb2xkZXInXX0udGlmICAgICAgIG11bHRpLWNoYW5uZWwgSW1hZ2VKL0Zp
#8#amkgY29tcG9zaXRlIGh5cGVyc3RhY2sgIgogICAgICAgIGYiKG5hdGl2ZSBiaXQgZGVwdGgsIMK1
#8#bS1jYWxpYnJhdGVkLCB+e1RBUkdFVF9QWH1weCksIGZyb20gdGhlIC5pbXMgcHlyYW1pZHtvbmVf
#8#ZnJhbWV9IiwKICAgICAgICBmIiAge2RzWydmb2xkZXInXX1fQypfKl9NSVAucG5nICAgcGVyLWNo
#8#YW5uZWwgbWF4aW11bS1pbnRlbnNpdHkgcHJvamVjdGlvbntvbmVfZnJhbWV9IiwKICAgIF0KICAg
#8#IGlmIG5fdHAgPiAxOgogICAgICAgIGxpbmVzLmFwcGVuZChmIiAgVGhlIC5pbXMgaG9sZHMgYWxs
#8#IHtuX3RwfSB0aW1lcG9pbnRzLiIpCiAgICByZXR1cm4gbGluZXMKCgojIOKUgOKUgCBoZWxwZXJz
#8#IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#8#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#8#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#8#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgApkZWYgZm10X3NpemUobik6CiAgICBuID0gZmxvYXQo
#8#bikKICAgIGZvciB1bml0IGluICgiQiIsICJLQiIsICJNQiIsICJHQiIsICJUQiIpOgogICAgICAg
#8#IGlmIG4gPCAxMDI0IG9yIHVuaXQgPT0gIlRCIjoKICAgICAgICAgICAgcmV0dXJuIGYie246LjFm
#8#fSB7dW5pdH0iIGlmIHVuaXQgIT0gIkIiIGVsc2UgZiJ7aW50KG4pfSBCIgogICAgICAgIG4gLz0g
#8#MTAyNAoKCiMg4pSA4pSAIG1haW4g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#8#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#8#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#8#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmRl
#8#ZiBwcm9jZXNzKGRzLCBhcmdzKToKICAgIGZvbGRlciA9IGRzWyJmb2xkZXIiXQogICAgZGwgPSBk
#8#c1siZGlyIl0gLyAiZG93bmxvYWQiCiAgICBwcmludChmIlxuPT09IHtkc1snaWQnXX0gPT09IikK
#8#ICAgIGlmIG5vdCBhcmdzLmRyeV9ydW46CiAgICAgICAgZGwubWtkaXIocGFyZW50cz1UcnVlLCBl
#8#eGlzdF9vaz1UcnVlKQoKICAgICMgMS4gYXJjaGl2ZSBGSVJTVCAoZG93bmxvYWQvIGlzIGV4Y2x1
#8#ZGVkIHJlZ2FyZGxlc3Mgb2Ygb3JkZXIpCiAgICBpZiBub3QgYXJncy5ub19hcmNoaXZlOgogICAg
#8#ICAgIHRyeToKICAgICAgICAgICAgcHJpbnQoZiIgIFthcmNoaXZlXSB7YnVpbGRfYXJjaGl2ZShk
#8#c1snZGlyJ10sIGZvbGRlciwgZGwgLyBmJ3tmb2xkZXJ9X3dlYi56aXAnLCBhcmdzLmZvcmNlLCBh
#8#cmdzLmRyeV9ydW4pfSIpCiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBleGM6CiAgICAgICAg
#8#ICAgIHByaW50KGYiICBbYXJjaGl2ZV0gRkFJTEVEOiB7ZXhjfSIpCgogICAgIyBBIHBob3RvZ3Jh
#8#cGggaGFzIG5vIC5pbXMgdG8gcmUtcmVhZDogc3RlcHMgMi00IGFyZSBtZWFuaW5nbGVzcywgYW5k
#8#IGl0cwogICAgIyBvcmlnaW5hbCBUSUZGICsgUkVBRE1FIGFyZSBwbGFjZWQgYnkgcHJlcHJvY2Vz
#8#cy8yZF9pbXBvcnRlci5weS4KICAgICMgVGhlIFJFQURNRSBpcyBuZXZlciBmb3JjZWQgaGVyZSwg
#8#c28gdGhlIGltcG9ydGVyJ3MgcmljaGVyIG9uZSBhbHdheXMgd2lucy4KICAgIGlmIGRzWyJ0eXBl
#8#Il0gPT0gIjJkIjoKICAgICAgICB0cnk6CiAgICAgICAgICAgIHByaW50KGYiICBbcmVhZG1lXSB7
#8#d3JpdGVfcmVhZG1lKGRsIC8gJ1JFQURNRS50eHQnLCBkcywgTm9uZSwgRmFsc2UsIGFyZ3MuZHJ5
#8#X3J1bil9IikKICAgICAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGV4YzoKICAgICAgICAgICAgcHJp
#8#bnQoZiIgIFtyZWFkbWVdIEZBSUxFRDoge2V4Y30iKQogICAgICAgIHJldHVybgoKICAgIGltc19z
#8#cmMgPSBQYXRoKGFyZ3MuaW1zKSBpZiBnZXRhdHRyKGFyZ3MsICJpbXMiLCBOb25lKSBlbHNlIGZp
#8#bmRfaW1zKGZvbGRlcikKICAgIGlmIGltc19zcmMgaXMgTm9uZSBhbmQgbm90IChhcmdzLm5vX2lt
#8#cyBhbmQgYXJncy5ub190aWZmKToKICAgICAgICBwcmludChmIiAgWy5pbXNdIG5vdCBmb3VuZCBp
#8#biBSQVdfREFUQSBmb3IgJ3tmb2xkZXJ9JyDigJQgc2tpcHBpbmcgaW1zL3RpZmYvbWlwIikKCiAg
#8#ICAjIDIuIG9yaWdpbmFsIC5pbXMgKGhhcmQgbGluaykKICAgIGlmIG5vdCBhcmdzLm5vX2ltcyBh
#8#bmQgaW1zX3NyYyBpcyBub3QgTm9uZToKICAgICAgICB0cnk6CiAgICAgICAgICAgIHByaW50KGYi
#8#ICBbLmltc10ge3BsYWNlX2ltcyhpbXNfc3JjLCBkbCAvIGYne2ZvbGRlcn0uaW1zJywgYXJncy5m
#8#b3JjZSwgYXJncy5kcnlfcnVuKX0iKQogICAgICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZXhjOgog
#8#ICAgICAgICAgICBwcmludChmIiAgWy5pbXNdIEZBSUxFRDoge2V4Y30iKQoKICAgICMgMy80LiBJ
#8#bWFnZUogY29tcG9zaXRlIFRJRkYgKyBwZXItY2hhbm5lbCBNSVAKICAgIGlmIChub3QgYXJncy5u
#8#b190aWZmIG9yIG5vdCBhcmdzLm5vX21pcCkgYW5kIGltc19zcmMgaXMgbm90IE5vbmU6CiAgICAg
#8#ICAgY2hhbm5lbHNfbWV0YSA9IGRzWyJtZXRhIl0uZ2V0KCJjaGFubmVscyIsIFtdKQogICAgICAg
#8#IHRpZmZfb3V0ID0gZGwgLyBmIntmb2xkZXJ9LnRpZiIKICAgICAgICBkZWYgbWlwX3BhdGgoY2ks
#8#IG5hbWUpOgogICAgICAgICAgICBzYWZlID0gcmUuc3ViKHIiW15BLVphLXowLTkuXy1dKyIsICJf
#8#Iiwgc3RyKG5hbWUpKS5zdHJpcCgiXyIpIG9yIGYiQ3tjaSsxfSIKICAgICAgICAgICAgcmV0dXJu
#8#IGRsIC8gZiJ7Zm9sZGVyfV9De2NpKzF9X3tzYWZlfV9NSVAucG5nIgogICAgICAgIHRyeToKICAg
#8#ICAgICAgICAgcHJpbnQoZiIgIFt0aWZmL21pcF0ge2J1aWxkX3RpZmZfYW5kX21pcHMoaW1zX3Ny
#8#YywgZHNbJ2RpciddLCBmb2xkZXIsIGNoYW5uZWxzX21ldGEsIHRpZmZfb3V0LCBtaXBfcGF0aCwg
#8#bm90IGFyZ3Mubm9fdGlmZiwgbm90IGFyZ3Mubm9fbWlwLCBhcmdzLmZvcmNlLCBhcmdzLmRyeV9y
#8#dW4sIGFyZ3MudGltZXBvaW50KX0iKQogICAgICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZXhjOgog
#8#ICAgICAgICAgICBwcmludChmIiAgW3RpZmYvbWlwXSBGQUlMRUQ6IHtleGN9IikKICAgICAgICAj
#8#IERyb3AgdGhlIHN1cGVyc2VkZWQgT01FLVRJRkYgb25seSBvbmNlIGl0cyByZXBsYWNlbWVudCBp
#8#cyBvbiBkaXNrIOKAlAogICAgICAgICMgbGVmdCBpbiBwbGFjZSBpdCBzdGF5cyB0aGUgZmlsZSBv
#8#cGVyYXRvcnMgZG93bmxvYWQsIGFuZCBpdCBvcGVucyBibGFjay4KICAgICAgICBsZWdhY3kgPSBk
#8#bCAvIGYie2ZvbGRlcn0ub21lLnRpZiIKICAgICAgICBpZiBsZWdhY3kuZXhpc3RzKCkgYW5kIHRp
#8#ZmZfb3V0LmV4aXN0cygpIGFuZCBub3QgYXJncy5kcnlfcnVuOgogICAgICAgICAgICBsZWdhY3ku
#8#dW5saW5rKCkKICAgICAgICAgICAgcHJpbnQoZiIgIFt0aWZmXSByZW1vdmVkIHN1cGVyc2VkZWQg
#8#e2xlZ2FjeS5uYW1lfSIpCgogICAgIyA1LiBSRUFETUUKICAgIHRyeToKICAgICAgICBwcmludChm
#8#IiAgW3JlYWRtZV0ge3dyaXRlX3JlYWRtZShkbCAvICdSRUFETUUudHh0JywgZHMsIGltc19zcmMs
#8#IGFyZ3MuZm9yY2UsIGFyZ3MuZHJ5X3J1biwgYXJncy50aW1lcG9pbnQpfSIpCiAgICBleGNlcHQg
#8#RXhjZXB0aW9uIGFzIGV4YzoKICAgICAgICBwcmludChmIiAgW3JlYWRtZV0gRkFJTEVEOiB7ZXhj
#8#fSIpCgoKZGVmIG1haW4oKToKICAgIGdsb2JhbCBUQVJHRVRfUFgsIERBVEFfV0VCLCBSQVdfREFU
#8#QV9ESVJTCiAgICBhcCA9IGFyZ3BhcnNlLkFyZ3VtZW50UGFyc2VyKGRlc2NyaXB0aW9uPSJQb3B1
#8#bGF0ZSBlYWNoIGRhdGFzZXQncyBkb3dubG9hZC8gZm9sZGVyLiIpCiAgICBhcC5hZGRfYXJndW1l
#8#bnQoIi0tZGF0YXNldHMiLCBoZWxwPSJjYXNlLWluc2Vuc2l0aXZlIHN1YnN0cmluZyBmaWx0ZXIg
#8#b24gZm9sZGVyIG5hbWUiKQogICAgYXAuYWRkX2FyZ3VtZW50KCItLWRhdGFzZXQiLCBoZWxwPSJl
#8#eGFjdGx5IG9uZSBkYXRhc2V0LCBhcyAnPHR5cGU+Lzxmb2xkZXI+JyIpCiAgICBhcC5hZGRfYXJn
#8#dW1lbnQoIi0taW1zIiwgaGVscD0idGhlIGRhdGFzZXQncyBzb3VyY2UgLmltcyAoZGVmYXVsdDog
#8#c2VhcmNoZWQgaW4gdGhlIHJhdyBkaXJzKSIpCiAgICBhcC5hZGRfYXJndW1lbnQoIi0tdGltZXBv
#8#aW50IiwgdHlwZT1pbnQsIGRlZmF1bHQ9MCwKICAgICAgICAgICAgICAgICAgICBoZWxwPSJmcmFt
#8#ZSBvZiBhIHRpbWVsYXBzZSB0aGUgVElGRiBhbmQgTUlQcyBzaG93IChkZWZhdWx0IDApIikKICAg
#8#IGFwLmFkZF9hcmd1bWVudCgiLS10eXBlcyIsIGRlZmF1bHQ9IiwiLmpvaW4oREFUQVNFVF9UWVBF
#8#UyksCiAgICAgICAgICAgICAgICAgICAgaGVscD0iY29tbWEgbGlzdDogM2QsMmQsbGl2ZSAoYSAy
#8#ZCBkYXRhc2V0IGdldHMgdGhlICIKICAgICAgICAgICAgICAgICAgICAgICAgICJ3ZWIgYXJjaGl2
#8#ZSBvbmx5IOKAlCBpdHMgb3JpZ2luYWwgVElGRiBhbmQgUkVBRE1FIGNvbWUgZnJvbSB0aGUgaW1w
#8#b3J0ZXIpIikKICAgIGFwLmFkZF9hcmd1bWVudCgiLS1kYXRhLXdlYiIsIGhlbHA9Im92ZXJyaWRl
#8#IHRoZSBEQVRBX1dFQiBkaXJlY3RvcnkgKGRlZmF1bHQ6IDxyZXBvPi9EQVRBX1dFQikiKQogICAg
#8#YXAuYWRkX2FyZ3VtZW50KCItLXJhdy1kaXIiLCBoZWxwPSJkaXJlY3RvcnkgdG8gc2VhcmNoIGZp
#8#cnN0IGZvciB0aGUgc291cmNlIC5pbXMgKHByZXBlbmRlZCB0byBSQVdfREFUQV9ESVJTKSIpCiAg
#8#ICBhcC5hZGRfYXJndW1lbnQoIi0tdGlmZi1weCIsIHR5cGU9aW50LCBkZWZhdWx0PVRBUkdFVF9Q
#8#WCwgaGVscD0idGFyZ2V0IGxvbmcgWFkgc2lkZSBvZiB0aGUgVElGRiIpCiAgICBhcC5hZGRfYXJn
#8#dW1lbnQoIi0tbm8tYXJjaGl2ZSIsIGFjdGlvbj0ic3RvcmVfdHJ1ZSIpCiAgICBhcC5hZGRfYXJn
#8#dW1lbnQoIi0tbm8taW1zIiwgYWN0aW9uPSJzdG9yZV90cnVlIikKICAgIGFwLmFkZF9hcmd1bWVu
#8#dCgiLS1uby10aWZmIiwgYWN0aW9uPSJzdG9yZV90cnVlIikKICAgIGFwLmFkZF9hcmd1bWVudCgi
#8#LS1uby1taXAiLCBhY3Rpb249InN0b3JlX3RydWUiKQogICAgYXAuYWRkX2FyZ3VtZW50KCItLWZv
#8#cmNlIiwgYWN0aW9uPSJzdG9yZV90cnVlIiwgaGVscD0icmVidWlsZCBhcnRlZmFjdHMgdGhhdCBh
#8#bHJlYWR5IGV4aXN0IikKICAgIGFwLmFkZF9hcmd1bWVudCgiLS1kcnktcnVuIiwgYWN0aW9uPSJz
#8#dG9yZV90cnVlIikKICAgIGFyZ3MgPSBhcC5wYXJzZV9hcmdzKCkKCiAgICBUQVJHRVRfUFggPSBh
#8#cmdzLnRpZmZfcHgKICAgIGlmIGFyZ3MuZGF0YV93ZWI6CiAgICAgICAgREFUQV9XRUIgPSBQYXRo
#8#KGFyZ3MuZGF0YV93ZWIpCiAgICBpZiBhcmdzLnJhd19kaXI6CiAgICAgICAgUkFXX0RBVEFfRElS
#8#UyA9IFtQYXRoKGFyZ3MucmF3X2RpcildICsgUkFXX0RBVEFfRElSUwogICAgdHlwZXMgPSB0dXBs
#8#ZSh0LnN0cmlwKCkgZm9yIHQgaW4gYXJncy50eXBlcy5zcGxpdCgiLCIpIGlmIHQuc3RyaXAoKSkK
#8#CiAgICBkYXRhc2V0cyA9IGxvYWRfZGF0YXNldHMoYXJncy5kYXRhc2V0cywgdHlwZXMsIGV4YWN0
#8#X2lkPWFyZ3MuZGF0YXNldCkKICAgIGlmIG5vdCBkYXRhc2V0czoKICAgICAgICBwcmludCgiTm8g
#8#ZGF0YXNldHMgbWF0Y2hlZC4iKQogICAgICAgIHJldHVybiAxCiAgICBwcmludChmIntsZW4oZGF0
#8#YXNldHMpfSBkYXRhc2V0KHMpIHRvIHByb2Nlc3MgIgogICAgICAgICAgZiIoYXJjaGl2ZT17bm90
#8#IGFyZ3Mubm9fYXJjaGl2ZX0gaW1zPXtub3QgYXJncy5ub19pbXN9ICIKICAgICAgICAgIGYidGlm
#8#Zj17bm90IGFyZ3Mubm9fdGlmZn0gbWlwPXtub3QgYXJncy5ub19taXB9IHRhcmdldD17VEFSR0VU
#8#X1BYfXB4ICIKICAgICAgICAgIGYiZHJ5X3J1bj17YXJncy5kcnlfcnVufSkiKQogICAgdDAgPSB0
#8#aW1lLnRpbWUoKQogICAgZm9yIGRzIGluIGRhdGFzZXRzOgogICAgICAgIHRyeToKICAgICAgICAg
#8#ICAgcHJvY2VzcyhkcywgYXJncykKICAgICAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGV4YzoKICAg
#8#ICAgICAgICAgcHJpbnQoZiIgIFtkYXRhc2V0XSBGQUlMRUQ6IHtleGN9IikKICAgIHByaW50KGYi
#8#XG5Eb25lIGluIHt0aW1lLnRpbWUoKSAtIHQwOi4wZn1zLiIpCiAgICByZXR1cm4gMAoKCmlmIF9f
#8#bmFtZV9fID09ICJfX21haW5fXyI6CiAgICBzeXMuZXhpdChtYWluKCkpCg==
