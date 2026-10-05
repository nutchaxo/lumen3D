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
set "PP_VERSION=0.20.0"
set "PY_VERSION=3.12.8"
set "SCRIPTS=run_preprocess.py 1-ims_metadata.py 2-image_processor.py 3-chunk_packer.py 4-catalog_generator.py planes_writer.py 2d_importer.py 5-tracking_importer.py tracking_sources.py"
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
call :extract 9 "!WORK!\build_download_bundles.py"
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
:: ---- [0] run_preprocess.py (32677 octets) ----
#0#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwppbXBvcnQgYXJncGFyc2UKaW1wb3J0IGZubWF0Y2gKaW1w
#0#b3J0IGhhc2hsaWIKaW1wb3J0IGltcG9ydGxpYi51dGlsCmltcG9ydCBqc29uCmltcG9ydCBvcwpp
#0#bXBvcnQgcmUKaW1wb3J0IHNodXRpbAppbXBvcnQgc2lnbmFsCmltcG9ydCBzdWJwcm9jZXNzCmlt
#0#cG9ydCBzeXMKaW1wb3J0IHRpbWUKaW1wb3J0IHRyYWNlYmFjawpmcm9tIGRhdGV0aW1lIGltcG9y
#0#dCBkYXRldGltZQpmcm9tIHBhdGhsaWIgaW1wb3J0IFBhdGgKCl9fdmVyc2lvbl9fID0gIjAuMjAu
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
#0#IGlzIG5ldmVyIHRvdWNoZWQuClBJUEVMSU5FX0VOVFJJRVMgPSAoImJyaWNrcyIsICJwbGFuZXMi
#0#LCAidGh1bWJuYWlsLndlYnAiKQpUUkFDS0lOR19FTlRSSUVTID0gKCJ0cmFja3MuanNvbiIsICJ0
#0#cmFja3MuanNvbi5neiIsICJtb2RlbC5nbGIiKQpTV0FQX1NVRkZJWCA9ICIucHJlLXN3YXAiClNX
#0#QVBfTUFSS0VSID0gIi5zd2FwLWluLXByb2dyZXNzIgpMRUdBQ1lfUk9MTEJBQ0sgPSAiYnJpY2tz
#0#LnJvbGxiYWNrIgoKCmRlZiBfc2hhMjU2X2ZpbGUocGF0aDogUGF0aCkgLT4gc3RyOgogICAgaCA9
#0#IGhhc2hsaWIuc2hhMjU2KCkKICAgIHdpdGggb3BlbihwYXRoLCAicmIiKSBhcyBmaDoKICAgICAg
#0#ICBmb3IgYmxvY2sgaW4gaXRlcihsYW1iZGE6IGZoLnJlYWQoMSA8PCAyMCksIGIiIik6CiAgICAg
#0#ICAgICAgIGgudXBkYXRlKGJsb2NrKQogICAgcmV0dXJuIGguaGV4ZGlnZXN0KCkKCgpkZWYgX3Jl
#0#bW92ZV9wYXRoKHBhdGg6IFBhdGgpIC0+IE5vbmU6CiAgICBpZiBwYXRoLmlzX2RpcigpIGFuZCBu
#0#b3QgcGF0aC5pc19zeW1saW5rKCk6CiAgICAgICAgc2h1dGlsLnJtdHJlZShwYXRoLCBpZ25vcmVf
#0#ZXJyb3JzPVRydWUpCiAgICBlbHNlOgogICAgICAgIHRyeToKICAgICAgICAgICAgcGF0aC51bmxp
#0#bmsoKQogICAgICAgIGV4Y2VwdCBGaWxlTm90Rm91bmRFcnJvcjoKICAgICAgICAgICAgcGFzcwoK
#0#CmRlZiBfcmVuYW1lKHNyYzogUGF0aCwgZHN0OiBQYXRoKSAtPiBOb25lOgogICAgX3JldHJ5X29z
#0#KGxhbWJkYTogb3MucmVuYW1lKHNyYywgZHN0KSkKCgpkZWYgcmVjb3Zlcl9pbnRlcnJ1cHRlZF9w
#0#dWJsaXNoKGZpbmFsX2RpcjogUGF0aCkgLT4gTm9uZToKICAgICIiIkZpbmlzaCBvciB1bmRvIGEg
#0#c3dhcCBhIGNyYXNoIGludGVycnVwdGVkLCBzbyBhIGRhdGFzZXQgaXMgbmV2ZXIgbGVmdCBtaXhp
#0#bmcKICAgIHR3byBydW5zLiBUaGUgbWFya2VyIHJlY29yZHMgdGhlIGhhc2ggb2YgdGhlIG1ldGFk
#0#YXRhLmpzb24gYmVpbmcgaW5zdGFsbGVkOiBpZgogICAgdGhhdCBmaWxlIGlzIGluIHBsYWNlIHRo
#0#ZSBzd2FwIGhhZCBjb21taXR0ZWQgYW5kIG9ubHkgdGhlIG9sZCBjb3BpZXMgcmVtYWluIHRvCiAg
#0#ICBiZSBkcm9wcGVkOyBvdGhlcndpc2UgdGhlIG9sZCBlbnRyaWVzIGdvIGJhY2sgd2hlcmUgdGhl
#0#eSB3ZXJlLiIiIgogICAgbWFya2VyID0gZmluYWxfZGlyIC8gU1dBUF9NQVJLRVIKICAgIGlmIG1h
#0#cmtlci5pc19maWxlKCk6CiAgICAgICAgaW5mbyA9IHJlYWRfanNvbl9maWxlKG1hcmtlcikKICAg
#0#ICAgICBtZXRhID0gZmluYWxfZGlyIC8gIm1ldGFkYXRhLmpzb24iCiAgICAgICAgY29tbWl0dGVk
#0#ID0gYm9vbChpbmZvLmdldCgibWV0YWRhdGFTaGEyNTYiKSkgYW5kIG1ldGEuaXNfZmlsZSgpIFwK
#0#ICAgICAgICAgICAgYW5kIF9zaGEyNTZfZmlsZShtZXRhKSA9PSBpbmZvWyJtZXRhZGF0YVNoYTI1
#0#NiJdCiAgICAgICAgZm9yIGVudHJ5IGluIGluZm8uZ2V0KCJlbnRyaWVzIikgb3IgW106CiAgICAg
#0#ICAgICAgIG9sZCA9IGZpbmFsX2RpciAvIChlbnRyeSArIFNXQVBfU1VGRklYKQogICAgICAgICAg
#0#ICBpZiBub3Qgb2xkLmV4aXN0cygpOgogICAgICAgICAgICAgICAgY29udGludWUKICAgICAgICAg
#0#ICAgaWYgY29tbWl0dGVkOgogICAgICAgICAgICAgICAgX3JlbW92ZV9wYXRoKG9sZCkKICAgICAg
#0#ICAgICAgZWxzZToKICAgICAgICAgICAgICAgIGN1cnJlbnQgPSBmaW5hbF9kaXIgLyBlbnRyeQog
#0#ICAgICAgICAgICAgICAgaWYgY3VycmVudC5leGlzdHMoKToKICAgICAgICAgICAgICAgICAgICBf
#0#cmVtb3ZlX3BhdGgoY3VycmVudCkKICAgICAgICAgICAgICAgIF9yZW5hbWUob2xkLCBjdXJyZW50
#0#KQogICAgICAgIG1hcmtlci51bmxpbmsoKQogICAgICAgIHByaW50KF93YXJuKGYiICAgWzxdIHB1
#0#YmxpY2F0aW9uIGludGVycm9tcHVlIGRlIHtmaW5hbF9kaXIubmFtZX0gIgogICAgICAgICAgICAg
#0#ICAgICAgIGYieyd0ZXJtaW5lZScgaWYgY29tbWl0dGVkIGVsc2UgJ2FubnVsZWUnfSIpKQogICAg
#0#IyBBIHJ1biBvZiBhbiBlYXJsaWVyIHBpcGVsaW5lIHZlcnNpb24gbW92ZWQgYnJpY2tzLyBhc2lk
#0#ZSBmb3IgaXRzIHdob2xlIGR1cmF0aW9uCiAgICAjIGFuZCBjb3VsZCBiZSBraWxsZWQgYmVmb3Jl
#0#IHB1dHRpbmcgdGhlbSBiYWNrLgogICAgbGVnYWN5ID0gZmluYWxfZGlyIC8gTEVHQUNZX1JPTExC
#0#QUNLCiAgICBpZiBsZWdhY3kuaXNfZGlyKCkgYW5kIG5vdCAoZmluYWxfZGlyIC8gImJyaWNrcyIp
#0#LmV4aXN0cygpOgogICAgICAgIF9yZW5hbWUobGVnYWN5LCBmaW5hbF9kaXIgLyAiYnJpY2tzIikK
#0#ICAgICAgICBwcmludChfd2FybihmIiAgIFs8XSBicmlja3MvIHByZWNlZGVudCByZXN0YXVyZSBw
#0#b3VyIHtmaW5hbF9kaXIubmFtZX0iKSkKCgpkZWYgX21lcmdlX3dpdGhfcHVibGlzaGVkKHN0YWdl
#0#X2RpcjogUGF0aCwgZmluYWxfZGlyOiBQYXRoKSAtPiBOb25lOgogICAgIiIiUmUtYXBwbHkgdGhl
#0#IGN1cmF0aW9uIG9mIHRoZSBwdWJsaXNoZWQgbWV0YWRhdGEuanNvbiBhdCB0aGUgbGFzdCBtb21l
#0#bnQ6IHRoZQogICAgb3BlcmF0b3IgbWF5IGhhdmUgZWRpdGVkIGl0IChoaWRkZW4gaXQsIHJlY2Fs
#0#aWJyYXRlZCBpdCkgd2hpbGUgdGhlIHJ1biB3YXMgYnVzeS4iIiIKICAgIHB1Ymxpc2hlZCA9IGZp
#0#bmFsX2RpciAvICJtZXRhZGF0YS5qc29uIgogICAgaWYgbm90IHB1Ymxpc2hlZC5pc19maWxlKCk6
#0#CiAgICAgICAgcmV0dXJuCiAgICBleGlzdGluZyA9IHJlYWRfanNvbl9maWxlKHB1Ymxpc2hlZCkK
#0#ICAgIGlmIG5vdCBleGlzdGluZzoKICAgICAgICByZXR1cm4KICAgIGNhdGFsb2cgPSBsb2FkX3N0
#0#ZXAoIjQtY2F0YWxvZ19nZW5lcmF0b3IucHkiLCAibHVtZW5fY2F0YWxvZ19nZW5lcmF0b3IiKQog
#0#ICAgc3RhZ2VkID0gc3RhZ2VfZGlyIC8gIm1ldGFkYXRhLmpzb24iCiAgICBtZXJnZWQgPSBjYXRh
#0#bG9nLm1lcmdlX3ZvbHVtZV9tZXRhZGF0YShleGlzdGluZywgcmVhZF9qc29uX2ZpbGUoc3RhZ2Vk
#0#KSkKICAgIGF0b21pY193cml0ZV9qc29uKHN0YWdlZCwgbWVyZ2VkLCBpbmRlbnQ9MiwgZW5zdXJl
#0#X2FzY2lpPUZhbHNlKQoKCmRlZiBwdWJsaXNoX2RhdGFzZXQoc3RhZ2VfZGlyOiBQYXRoLCBmaW5h
#0#bF9kaXI6IFBhdGgpIC0+IE5vbmU6CiAgICAiIiJNb3ZlIGEgY29tcGxldGUgc3RhZ2VkIGRhdGFz
#0#ZXQgaW50byBEQVRBX1dFQiwgbWV0YWRhdGEuanNvbiBsYXN0LgoKICAgIEEgbmV3IGRhdGFzZXQg
#0#YXBwZWFycyBpbiBvbmUgcmVuYW1lLiBBbiBleGlzdGluZyBvbmUgaGFzIGl0cyBwaXBlbGluZSBl
#0#bnRyaWVzCiAgICBzd2FwcGVkOiB0aGUgb2xkIG9uZXMgYXJlIHJlbmFtZWQgYXNpZGUsIHRoZSBu
#0#ZXcgb25lcyBtb3ZlZCBpbiwgdGhlbiBtZXRhZGF0YS5qc29uCiAgICBpcyByZXBsYWNlZCDigJQg
#0#dGhlIGNvbW1pdCBwb2ludC4gQW55IGZhaWx1cmUgYmVmb3JlIGl0IHB1dHMgZXZlcnl0aGluZyBi
#0#YWNrLgogICAgIiIiCiAgICBzdGFnZWRfbWV0YSA9IHN0YWdlX2RpciAvICJtZXRhZGF0YS5qc29u
#0#IgogICAgaWYgbm90IHN0YWdlZF9tZXRhLmlzX2ZpbGUoKToKICAgICAgICByYWlzZSBSdW50aW1l
#0#RXJyb3IoZiJ7c3RhZ2VfZGlyfSBuJ2EgcGFzIGRlIG1ldGFkYXRhLmpzb24g4oCUIHJpZW4gYSBw
#0#dWJsaWVyIikKCiAgICBpZiBub3QgZmluYWxfZGlyLmV4aXN0cygpOgogICAgICAgIGZpbmFsX2Rp
#0#ci5wYXJlbnQubWtkaXIocGFyZW50cz1UcnVlLCBleGlzdF9vaz1UcnVlKQogICAgICAgIF9yZW5h
#0#bWUoc3RhZ2VfZGlyLCBmaW5hbF9kaXIpCiAgICAgICAgcmV0dXJuCgogICAgcmVjb3Zlcl9pbnRl
#0#cnJ1cHRlZF9wdWJsaXNoKGZpbmFsX2RpcikKICAgIF9tZXJnZV93aXRoX3B1Ymxpc2hlZChzdGFn
#0#ZV9kaXIsIGZpbmFsX2RpcikKCiAgICBlbnRyaWVzID0gW2UgZm9yIGUgaW4gUElQRUxJTkVfRU5U
#0#UklFUyBpZiAoc3RhZ2VfZGlyIC8gZSkuZXhpc3RzKCldCiAgICBpZiAoc3RhZ2VfZGlyIC8gInRy
#0#YWNrcy5qc29uIikuZXhpc3RzKCk6CiAgICAgICAgIyBBIG5ld2x5IGF0dGFjaGVkIHRyYWNraW5n
#0#IHJlcGxhY2VzIHRoZSB3aG9sZSBwcmV2aW91cyBzZXQsIGluY2x1ZGluZyBhIHN1cmZhY2UKICAg
#0#ICAgICAjIHRoZSBuZXcgYW5hbHlzaXMgbm8gbG9uZ2VyIGhhcy4KICAgICAgICBlbnRyaWVzICs9
#0#IGxpc3QoVFJBQ0tJTkdfRU5UUklFUykKICAgIG1hcmtlciA9IGZpbmFsX2RpciAvIFNXQVBfTUFS
#0#S0VSCiAgICBhdG9taWNfd3JpdGVfanNvbihtYXJrZXIsIHsibWV0YWRhdGFTaGEyNTYiOiBfc2hh
#0#MjU2X2ZpbGUoc3RhZ2VkX21ldGEpLCAiZW50cmllcyI6IGVudHJpZXN9KQoKICAgIG1vdmVkX2Fz
#0#aWRlLCBpbnN0YWxsZWQgPSBbXSwgW10KICAgIHRyeToKICAgICAgICBmb3IgZW50cnkgaW4gZW50
#0#cmllczoKICAgICAgICAgICAgY3VycmVudCA9IGZpbmFsX2RpciAvIGVudHJ5CiAgICAgICAgICAg
#0#IGlmIGN1cnJlbnQuZXhpc3RzKCk6CiAgICAgICAgICAgICAgICBzdGFsZSA9IGZpbmFsX2RpciAv
#0#IChlbnRyeSArIFNXQVBfU1VGRklYKQogICAgICAgICAgICAgICAgaWYgc3RhbGUuZXhpc3RzKCk6
#0#CiAgICAgICAgICAgICAgICAgICAgX3JlbW92ZV9wYXRoKHN0YWxlKQogICAgICAgICAgICAgICAg
#0#X3JlbmFtZShjdXJyZW50LCBzdGFsZSkKICAgICAgICAgICAgICAgIG1vdmVkX2FzaWRlLmFwcGVu
#0#ZChlbnRyeSkKICAgICAgICBmb3IgZW50cnkgaW4gZW50cmllczoKICAgICAgICAgICAgaWYgKHN0
#0#YWdlX2RpciAvIGVudHJ5KS5leGlzdHMoKToKICAgICAgICAgICAgICAgIF9yZW5hbWUoc3RhZ2Vf
#0#ZGlyIC8gZW50cnksIGZpbmFsX2RpciAvIGVudHJ5KQogICAgICAgICAgICAgICAgaW5zdGFsbGVk
#0#LmFwcGVuZChlbnRyeSkKICAgICAgICBfcmV0cnlfb3MobGFtYmRhOiBvcy5yZXBsYWNlKHN0YWdl
#0#ZF9tZXRhLCBmaW5hbF9kaXIgLyAibWV0YWRhdGEuanNvbiIpKQogICAgZXhjZXB0IEJhc2VFeGNl
#0#cHRpb246CiAgICAgICAgZm9yIGVudHJ5IGluIHJldmVyc2VkKGluc3RhbGxlZCk6CiAgICAgICAg
#0#ICAgIHRyeToKICAgICAgICAgICAgICAgIF9yZW5hbWUoZmluYWxfZGlyIC8gZW50cnksIHN0YWdl
#0#X2RpciAvIGVudHJ5KQogICAgICAgICAgICBleGNlcHQgT1NFcnJvcjoKICAgICAgICAgICAgICAg
#0#IF9yZW1vdmVfcGF0aChmaW5hbF9kaXIgLyBlbnRyeSkKICAgICAgICBmb3IgZW50cnkgaW4gcmV2
#0#ZXJzZWQobW92ZWRfYXNpZGUpOgogICAgICAgICAgICBfcmVuYW1lKGZpbmFsX2RpciAvIChlbnRy
#0#eSArIFNXQVBfU1VGRklYKSwgZmluYWxfZGlyIC8gZW50cnkpCiAgICAgICAgbWFya2VyLnVubGlu
#0#aygpCiAgICAgICAgcmFpc2UKICAgIG1hcmtlci51bmxpbmsoKQogICAgZm9yIGVudHJ5IGluIG1v
#0#dmVkX2FzaWRlOgogICAgICAgIF9yZW1vdmVfcGF0aChmaW5hbF9kaXIgLyAoZW50cnkgKyBTV0FQ
#0#X1NVRkZJWCkpCiAgICBpZiAoZmluYWxfZGlyIC8gTEVHQUNZX1JPTExCQUNLKS5leGlzdHMoKToK
#0#ICAgICAgICBfcmVtb3ZlX3BhdGgoZmluYWxfZGlyIC8gTEVHQUNZX1JPTExCQUNLKQoKCmRlZiBk
#0#YXRhc2V0X2ZvbGRlcl9uYW1lKHN0ZW06IHN0ciwgdHlwZV9kaXI6IFBhdGgpIC0+IHN0cjoKICAg
#0#ICIiIlRoZSBkYXRhc2V0IGZvbGRlciBmb3IgYSBzb3VyY2UgZmlsZS4gQSBuYW1lIHRoYXQgaXMg
#0#bm90IFVSTC1zYWZlIGlzCiAgICBzbHVnaWZpZWQsIHVubGVzcyBhIGRhdGFzZXQgd2FzIGFscmVh
#0#ZHkgcHVibGlzaGVkIHVuZGVyIHRoZSByYXcgbmFtZSDigJQgaXRzIGlkLAogICAgbGlua3MgYW5k
#0#IGN1cmF0aW9uIHN0YXkgd2hlcmUgdGhleSBhcmUuIiIiCiAgICBzbHVnID0gc2x1Z2lmeShzdGVt
#0#KSBvciAiZGF0YXNldCIKICAgIGlmIHNsdWcgIT0gc3RlbSBhbmQgKHR5cGVfZGlyIC8gc3RlbSku
#0#aXNfZGlyKCk6CiAgICAgICAgcmV0dXJuIHN0ZW0KICAgIHJldHVybiBzbHVnCgoKZGVmIHByb2Nl
#0#c3NfaW1zX2ZpbGUoaW1zX3BhdGg6IFBhdGgsIG91dHB1dF9yb290OiBQYXRoLCBpZHg6IGludCA9
#0#IDAsIHRvdGFsOiBpbnQgPSAwLAogICAgICAgICAgICAgICAgICAgICB3aXRoX2Rvd25sb2Fkczog
#0#Ym9vbCA9IEZhbHNlLCB0cmFja2luZzogc3RyID0gImF1dG8iKSAtPiBib29sOgogICAgIiIiUnVu
#0#IHRoZSB3aG9sZSBwaXBlbGluZSBvbiBvbmUgLmltcy4gUmV0dXJucyBUcnVlIG9uY2UgdGhlIGRh
#0#dGFzZXQgaXMgcHVibGlzaGVkLiIiIgogICAgZGlzcGxheV9uYW1lID0gaW1zX3BhdGguc3RlbQog
#0#ICAgY291bnRlciA9IGYiW3tpZHh9L3t0b3RhbH1dICIgaWYgdG90YWwgZWxzZSAiIgogICAgcHJp
#0#bnQoKQogICAgcHJpbnQoX2hkcihmIj4+IHtjb3VudGVyfXtkaXNwbGF5X25hbWV9IikpCiAgICBw
#0#cmludChfZGltKGYiICAgc291cmNlIDoge2ltc19wYXRofSIpKQogICAgdDAgPSBkYXRldGltZS5u
#0#b3coKQoKICAgIHRlbXBfZGlyID0gb3V0cHV0X3Jvb3QgLyBmIi50ZW1wX3ByZXByb2Nlc3Nfe3Ns
#0#dWdpZnkoZGlzcGxheV9uYW1lKSBvciAnZGF0YXNldCd9IgogICAgaWYgdGVtcF9kaXIuZXhpc3Rz
#0#KCk6CiAgICAgICAgc2h1dGlsLnJtdHJlZSh0ZW1wX2RpcikKICAgIHRlbXBfZGlyLm1rZGlyKHBh
#0#cmVudHM9VHJ1ZSwgZXhpc3Rfb2s9VHJ1ZSkKCiAgICBwdWJsaXNoZWQgPSBOb25lCiAgICB0cnk6
#0#CiAgICAgICAgIyBTdGVwIDE6IEV4dHJhY3Rpb24gb2YgbWV0YWRhdGEKICAgICAgICB0ZW1wX21l
#0#dGFfanNvbiA9IHRlbXBfZGlyIC8gIm1ldGEuanNvbiIKICAgICAgICBydW5fc3RlcCgiMS1pbXNf
#0#bWV0YWRhdGEucHkiLCBzdHIoaW1zX3BhdGgpLCBzdHIodGVtcF9tZXRhX2pzb24pKQoKICAgICAg
#0#ICAjIFRoZSBkYXRhc2V0IHR5cGUgZm9sbG93cyB0aGUgYWNxdWlzaXRpb246IGEgc3RhY2sgd2l0
#0#aCBtb3JlIHRoYW4gb25lCiAgICAgICAgIyB0aW1lcG9pbnQgaXMgYSB0aW1lbGFwc2UgYW5kIGJl
#0#bG9uZ3MgdW5kZXIgbGl2ZS8sIHdoaWNoIGlzIHdoYXQgZHJpdmVzIHRoZQogICAgICAgICMgdmll
#0#d2VyJ3MgdGltZWxpbmUuIFJlc29sdmVkIGhlcmUgYmVjYXVzZSBvbmx5IHN0ZXAgMSBrbm93cyB0
#0#aGUgZnJhbWUgY291bnQuCiAgICAgICAgIyBUaGUgZGlyZWN0b3J5IG5hbWUgSVMgdGhlIGRhdGFz
#0#ZXQgdHlwZSDigJQgc3RlcCA0IHJlYWRzIGl0IGJhY2sgb2ZmIGRpc2suCiAgICAgICAgd2l0aCBv
#0#cGVuKHRlbXBfbWV0YV9qc29uLCAiciIsIGVuY29kaW5nPSJ1dGYtOCIpIGFzIGZtOgogICAgICAg
#0#ICAgICBuX3RpbWVwb2ludHMgPSBpbnQoanNvbi5sb2FkKGZtKS5nZXQoIm5fdGltZXBvaW50cyIs
#0#IDEpIG9yIDEpCiAgICAgICAgZGF0YXNldF90eXBlID0gImxpdmUiIGlmIG5fdGltZXBvaW50cyA+
#0#IDEgZWxzZSAiM2QiCiAgICAgICAgZGF0YXNldF9uYW1lID0gZGF0YXNldF9mb2xkZXJfbmFtZShk
#0#aXNwbGF5X25hbWUsIG91dHB1dF9yb290IC8gZGF0YXNldF90eXBlKQogICAgICAgIGZpbmFsX2Rp
#0#ciA9IG91dHB1dF9yb290IC8gZGF0YXNldF90eXBlIC8gZGF0YXNldF9uYW1lCiAgICAgICAgaWYg
#0#ZmluYWxfZGlyLmV4aXN0cygpOgogICAgICAgICAgICAjIEEgcHJldmlvdXMgcnVuIGtpbGxlZCBt
#0#aWQtcHVibGlzaDogcHV0IHRoZSBkYXRhc2V0IGJhY2sgaW4gb25lIHBpZWNlIG5vdywKICAgICAg
#0#ICAgICAgIyBub3QgaG91cnMgZnJvbSBub3cgd2hlbiB0aGlzIHJ1biBwdWJsaXNoZXMuCiAgICAg
#0#ICAgICAgIHJlY292ZXJfaW50ZXJydXB0ZWRfcHVibGlzaChmaW5hbF9kaXIpCiAgICAgICAgc3Rh
#0#Z2VfZGlyID0gdGVtcF9kaXIgLyAic3RhZ2UiIC8gZGF0YXNldF90eXBlIC8gZGF0YXNldF9uYW1l
#0#CiAgICAgICAgc3RhZ2VfZGlyLm1rZGlyKHBhcmVudHM9VHJ1ZSkKICAgICAgICBwcmludChfZGlt
#0#KGYiICAgdHlwZSAgIDoge2RhdGFzZXRfdHlwZX0iCiAgICAgICAgICAgICAgICAgICArIChmIiAo
#0#e25fdGltZXBvaW50c30gdGltZXBvaW50cykiIGlmIG5fdGltZXBvaW50cyA+IDEgZWxzZSAiIikp
#0#KQogICAgICAgIGlmIGRhdGFzZXRfbmFtZSAhPSBkaXNwbGF5X25hbWU6CiAgICAgICAgICAgIHBy
#0#aW50KF9kaW0oZiIgICBkb3NzaWVyOiB7ZGF0YXNldF9uYW1lfSAobm9tIHNvdXJjZSBub24gdXRp
#0#bGlzYWJsZSB0ZWwgcXVlbCBkYW5zIHVuZSBVUkwpIikpCgogICAgICAgICMgU3RlcCAyOiBOb3Jt
#0#YWxpemF0aW9uLCBCYWNrZ3JvdW5kIHN1YnRyYWN0aW9uLCBEb3duc2NhbGluZyDigJQgZWFjaCB0
#0#aW1lcG9pbnQgaXMKICAgICAgICAjIHBhY2tlZCBpbnRvIHRoZSBzdGFnaW5nIHRyZWUgYXMgc29v
#0#biBhcyBpdCBpcyBsZXZlbGxlZCwgc28gdGhlIHRlbXBvcmFyeQogICAgICAgICMgZGlzayBuZXZl
#0#ciBob2xkcyBtb3JlIHRoYW4gb25lIGZyYW1lJ3MgTE9EIHNldC4KICAgICAgICBydW5fc3RlcCgi
#0#Mi1pbWFnZV9wcm9jZXNzb3IucHkiLCBzdHIoaW1zX3BhdGgpLCBzdHIodGVtcF9tZXRhX2pzb24p
#0#LCBzdHIodGVtcF9kaXIpLAogICAgICAgICAgICAgICAgICItLXBhY2staW50byIsIHN0cihzdGFn
#0#ZV9kaXIpKQoKICAgICAgICAjIFN0ZXAgMzogQ29tcHV0ZSB0aHVtYm5haWwgTUlQCiAgICAgICAg
#0#d2l0aCBvcGVuKHRlbXBfZGlyIC8gInByb2Nlc3NpbmdfbWV0YS5qc29uIiwgInIiLCBlbmNvZGlu
#0#Zz0idXRmLTgiKSBhcyBmbToKICAgICAgICAgICAgcHJvY19tZXRhID0ganNvbi5sb2FkKGZtKQog
#0#ICAgICAgIGJ1aWxkX3RodW1ibmFpbCh0ZW1wX2Rpciwgc3RhZ2VfZGlyLCBwcm9jX21ldGEpCgog
#0#ICAgICAgICMgU3RlcCA0OiBDaHVua2luZyA2NMKzICYgUGFjayBidWlsZGluZyAobWFuaWZlc3Qg
#0#b2YgdGhlIHBhY2tzIHN0ZXAgMiB3cm90ZSkKICAgICAgICBydW5fc3RlcCgiMy1jaHVua19wYWNr
#0#ZXIucHkiLCBzdHIodGVtcF9kaXIpLCBzdHIoc3RhZ2VfZGlyKSkKCiAgICAgICAgIyBTdGVwIDU6
#0#IENhdGFsb2cgbWV0YWRhdGEsIG1lcmdlZCB3aXRoIHRoZSBjdXJhdGlvbiBvZiB0aGUgcHVibGlz
#0#aGVkIG9uZQogICAgICAgIHJ1bl9zdGVwKCI0LWNhdGFsb2dfZ2VuZXJhdG9yLnB5Iiwgc3RyKHRl
#0#bXBfZGlyKSwgc3RyKHN0YWdlX2RpciksCiAgICAgICAgICAgICAgICAgIi0tZXhpc3RpbmciLCBz
#0#dHIoZmluYWxfZGlyIC8gIm1ldGFkYXRhLmpzb24iKSwKICAgICAgICAgICAgICAgICAiLS1kaXNw
#0#bGF5LW5hbWUiLCBkaXNwbGF5X25hbWUpCgogICAgICAgICMgU3RlcCA2OiBjZWxsIHRyYWNraW5n
#0#LCB3aGVuIHRoZSBhY3F1aXNpdGlvbiBoYXMgb25lLiBPbmx5IGEgdGltZWxhcHNlIGNhbiBjYXJy
#0#eQogICAgICAgICMgdHJhamVjdG9yaWVzLCBhbmQgdGhlIHN0ZXAgbmVlZHMgdGhlIG1ldGFkYXRh
#0#Lmpzb24gc3RlcCA0IGp1c3Qgd3JvdGUuCiAgICAgICAgaWYgbl90aW1lcG9pbnRzID4gMToKICAg
#0#ICAgICAgICAgYXR0YWNoX3RyYWNraW5nKGltc19wYXRoLCBzdGFnZV9kaXIsIHRlbXBfZGlyLCBk
#0#YXRhc2V0X25hbWUsIHRyYWNraW5nKQoKICAgICAgICBwdWJsaXNoX2RhdGFzZXQoc3RhZ2VfZGly
#0#LCBmaW5hbF9kaXIpCiAgICAgICAgcHVibGlzaGVkID0gZmluYWxfZGlyCiAgICBleGNlcHQgRXhj
#0#ZXB0aW9uIGFzIGU6CiAgICAgICAgcHJpbnQoX2VycihmIiAgIFtYXSB7ZGlzcGxheV9uYW1lfSA6
#0#IHtlfSIpLCBmaWxlPXN5cy5zdGRlcnIpCiAgICAgICAgdHJhY2ViYWNrLnByaW50X2V4YygpCiAg
#0#ICAgICAgcHJpbnQoX3dhcm4oIiAgIFs8XSBsZSBkYXRhc2V0IHB1YmxpZSAocydpbCBleGlzdGUp
#0#IGVzdCBpbmNoYW5nZSIpLCBmaWxlPXN5cy5zdGRlcnIpCiAgICBmaW5hbGx5OgogICAgICAgICMg
#0#aWdub3JlX2Vycm9yczogb24gYSBDdHJsK0MgdGVhcmRvd24gYSBqdXN0LWtpbGxlZCB3b3JrZXIg
#0#bWF5IHN0aWxsIGhvbGQgYQogICAgICAgICMgaGFuZGxlIGZvciBhIGZldyBtcyDigJQgbmV2ZXIg
#0#bGV0IGNsZWFudXAgbWFzayB0aGUgaW50ZXJydXB0aW9uLgogICAgICAgIGlmIHRlbXBfZGlyLmV4
#0#aXN0cygpOgogICAgICAgICAgICBzaHV0aWwucm10cmVlKHRlbXBfZGlyLCBpZ25vcmVfZXJyb3Jz
#0#PVRydWUpCgogICAgaWYgcHVibGlzaGVkIGlzIE5vbmU6CiAgICAgICAgcmV0dXJuIEZhbHNlCgog
#0#ICAgIyBTdGVwIDcgKG9wdGlvbmFsKTogZG93bmxvYWQvIGJ1bmRsZSDigJQgYXJjaGl2ZSwgb3Jp
#0#Z2luYWwgLmltcywgSW1hZ2VKIFRJRkYsCiAgICAjIHBlci1jaGFubmVsIE1JUHMsIFJFQURNRS4g
#0#QW4gZXh0cmEgb24gdG9wIG9mIGEgZGF0YXNldCB0aGF0IGlzIGFscmVhZHkKICAgICMgcHVibGlz
#0#aGVkIGFuZCBjb21wbGV0ZTogaXRzIGZhaWx1cmUgaXMgcmVwb3J0ZWQgYW5kIG5ldmVyIHVuZG9l
#0#cyB0aGUgZGF0YXNldC4KICAgIGlmIHdpdGhfZG93bmxvYWRzOgogICAgICAgIGRsX3NjcmlwdCA9
#0#IF9yZXNvbHZlX2Rvd25sb2FkX3NjcmlwdCgpCiAgICAgICAgaWYgZGxfc2NyaXB0IGlzIE5vbmU6
#0#CiAgICAgICAgICAgIHByaW50KF93YXJuKGYiICAgWyFdIHtET1dOTE9BRF9TQ1JJUFRfTkFNRX0g
#0#aW50cm91dmFibGUg4oCUIGRvd25sb2FkLyBpZ25vcmUiKSkKICAgICAgICBlbHNlOgogICAgICAg
#0#ICAgICB0cnk6CiAgICAgICAgICAgICAgICBydW5fc2NyaXB0KGRsX3NjcmlwdCwKICAgICAgICAg
#0#ICAgICAgICAgICAgICAgICAgIi0tZGF0YS13ZWIiLCBzdHIob3V0cHV0X3Jvb3QpLAogICAgICAg
#0#ICAgICAgICAgICAgICAgICAgICAiLS1yYXctZGlyIiwgc3RyKGltc19wYXRoLnBhcmVudCksCiAg
#0#ICAgICAgICAgICAgICAgICAgICAgICAgICItLWRhdGFzZXQiLCBmIntwdWJsaXNoZWQucGFyZW50
#0#Lm5hbWV9L3twdWJsaXNoZWQubmFtZX0iLAogICAgICAgICAgICAgICAgICAgICAgICAgICAiLS1p
#0#bXMiLCBzdHIoaW1zX3BhdGgpLAogICAgICAgICAgICAgICAgICAgICAgICAgICBsYWJlbD0iZG93
#0#bmxvYWQvIChhcmNoaXZlLCBJbWFnZUogVElGRiwgTUlQKSIpCiAgICAgICAgICAgIGV4Y2VwdCBz
#0#dWJwcm9jZXNzLkNhbGxlZFByb2Nlc3NFcnJvciBhcyBleGM6CiAgICAgICAgICAgICAgICBwcmlu
#0#dChfd2FybihmIiAgIFshXSBkb3dubG9hZC8gaW5jb21wbGV0IChjb2RlIHtleGMucmV0dXJuY29k
#0#ZX0pIOKAlCAiCiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmImxlIGRhdGFzZXQgcHVibGll
#0#IHJlc3RlIHV0aWxpc2FibGUiKSkKCiAgICBlbGFwc2VkID0gKGRhdGV0aW1lLm5vdygpIC0gdDAp
#0#LnRvdGFsX3NlY29uZHMoKQogICAgcHJpbnQoX29rKGYiICAgW09LXSB7ZGlzcGxheV9uYW1lfSB0
#0#ZXJtaW5lIGVuIHtlbGFwc2VkOi4wZn1zIikpCiAgICByZXR1cm4gVHJ1ZQoKCmRlZiBfZm9sZGVy
#0#X2NvbGxpc2lvbnMoaW1zX2ZpbGVzKSAtPiBkaWN0OgogICAgIiIiU291cmNlIGZpbGVzIHdob3Nl
#0#IGZvbGRlciBuYW1lcyB3b3VsZCBjb2luY2lkZSAoV2luZG93cyBmb2xkZXJzIGlnbm9yZSBjYXNl
#0#KSwKICAgIG1hcHBlZCB0byB0aGUgZWFybGllciBmaWxlIHRoYXQgY2xhaW1zIHRoZSBuYW1lLiIi
#0#IgogICAgY2xhaW1lZCwgY2xhc2hlcyA9IHt9LCB7fQogICAgZm9yIHBhdGggaW4gaW1zX2ZpbGVz
#0#OgogICAgICAgIGtleSA9IChzbHVnaWZ5KHBhdGguc3RlbSkgb3IgImRhdGFzZXQiKS5jYXNlZm9s
#0#ZCgpCiAgICAgICAgaWYga2V5IGluIGNsYWltZWQ6CiAgICAgICAgICAgIGNsYXNoZXNbcGF0aF0g
#0#PSBjbGFpbWVkW2tleV0KICAgICAgICBlbHNlOgogICAgICAgICAgICBjbGFpbWVkW2tleV0gPSBw
#0#YXRoCiAgICByZXR1cm4gY2xhc2hlcwoKCmRlZiBtYWluKCk6CiAgICBwYXJzZXIgPSBhcmdwYXJz
#0#ZS5Bcmd1bWVudFBhcnNlcihkZXNjcmlwdGlvbj0iSVJJQkhNIE1pY3Jvc2NvcHkgUHJlcHJvY2Vz
#0#c2luZyBVbmlmaWVkIFBpcGVsaW5lIikKICAgIHBhcnNlci5hZGRfYXJndW1lbnQoIi0taW5wdXQi
#0#LCByZXF1aXJlZD1UcnVlLCBoZWxwPSJJbnB1dCBkaXJlY3RvcnkgY29udGFpbmluZyByYXcgLmlt
#0#cyBmaWxlcy4iKQogICAgcGFyc2VyLmFkZF9hcmd1bWVudCgiLS1vdXRwdXQiLCByZXF1aXJlZD1U
#0#cnVlLCBoZWxwPSJPdXRwdXQgREFUQV9XRUIgZGlyZWN0b3J5IG9mIHRoZSB3ZWIgcGxhdGZvcm0u
#0#IikKICAgIHBhcnNlci5hZGRfYXJndW1lbnQoIi0tb25seSIsIGRlZmF1bHQ9Tm9uZSwgaGVscD0i
#0#R2xvYiBwYXR0ZXJuIHRvIGZpbHRlciBmaWxlcyB0byBwcm9jZXNzIChlLmcuICcqRTgqJykuIikK
#0#ICAgIHBhcnNlci5hZGRfYXJndW1lbnQoIi0td2l0aC1kb3dubG9hZHMiLCBhY3Rpb249InN0b3Jl
#0#X3RydWUiLAogICAgICAgICAgICAgICAgICAgICAgICBoZWxwPSJBZnRlciBlYWNoIGRhdGFzZXQs
#0#IGFsc28gYnVpbGQgaXRzIGRvd25sb2FkLyBidW5kbGUgIgogICAgICAgICAgICAgICAgICAgICAg
#0#ICAgICAgICIod2ViIGFyY2hpdmUsIG9yaWdpbmFsIC5pbXMsIEltYWdlSiBUSUZGLCBwZXItY2hh
#0#bm5lbCBNSVAsIFJFQURNRSkuIikKICAgIHBhcnNlci5hZGRfYXJndW1lbnQoIi0tdHJhY2tpbmci
#0#LCBkZWZhdWx0PSJhdXRvIiwgbWV0YXZhcj0iYXV0b3xvZmZ8RklMRSIsCiAgICAgICAgICAgICAg
#0#ICAgICAgICAgIGhlbHA9IkNlbGwgdHJhY2tpbmcgZm9yIHRpbWVsYXBzZSBkYXRhc2V0cy4gJ2F1
#0#dG8nIChkZWZhdWx0KSBsb29rcyBmb3IgIgogICAgICAgICAgICAgICAgICAgICAgICAgICAgICJh
#0#IC5pbWFyaXNfdHJhY2sgYmVzaWRlIHRoZSB2b2x1bWUsIHRoZW4gdGhlIEltYXJpcyBvYmplY3Rz
#0#IGluc2lkZSAiCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgInRoZSAuaW1zIGl0c2VsZiwg
#0#dGhlbiB0aGUgZXhwb3J0ZWQgLnhscy8ueGxzeCBzdGF0aXN0aWNzLiAnb2ZmJyAiCiAgICAgICAg
#0#ICAgICAgICAgICAgICAgICAgICAgInNraXBzIGl0LiBBIHBhdGggZm9yY2VzIHRoYXQgZmlsZSBm
#0#b3IgZXZlcnkgZGF0YXNldCBwcm9jZXNzZWQuIikKICAgIGFyZ3MgPSBwYXJzZXIucGFyc2VfYXJn
#0#cygpCgogICAgaW5wdXRfZGlyID0gUGF0aChhcmdzLmlucHV0KQogICAgb3V0cHV0X2RpciA9IFBh
#0#dGgoYXJncy5vdXRwdXQpCgogICAgaWYgbm90IGlucHV0X2Rpci5pc19kaXIoKToKICAgICAgICBz
#0#eXMuZXhpdChmIltGQVRBTF0gSW5wdXQgZGlyZWN0b3J5IG5vdCBmb3VuZDoge2lucHV0X2Rpcn0i
#0#KQogICAgICAgIAogICAgb3V0cHV0X2Rpci5ta2RpcihwYXJlbnRzPVRydWUsIGV4aXN0X29rPVRy
#0#dWUpCgogICAgIyBHbG9iIElNUyBmaWxlcwogICAgaW1zX2ZpbGVzID0gc29ydGVkKGlucHV0X2Rp
#0#ci5nbG9iKCIqLmltcyIpKQogICAgaWYgYXJncy5vbmx5OgogICAgICAgIGltc19maWxlcyA9IFtw
#0#IGZvciBwIGluIGltc19maWxlcyBpZiBmbm1hdGNoLmZubWF0Y2gocC5uYW1lLCBhcmdzLm9ubHkp
#0#XQoKICAgIGlmIG5vdCBpbXNfZmlsZXM6CiAgICAgICAgcHJpbnQoX3dhcm4oZiJBdWN1biBmaWNo
#0#aWVyIC5pbXMgY29ycmVzcG9uZGFudCBkYW5zIHtpbnB1dF9kaXJ9IikpCiAgICAgICAgc3lzLmV4
#0#aXQoMCkKCiAgICBwcmludCgpCiAgICBwcmludChfaGRyKCIgIFBpcGVsaW5lIGRlIHByZXByb2Nl
#0#c3NpbmcgICIpICsgX2RpbShmInZ7X192ZXJzaW9uX199IikpCiAgICBwcmludChfZGltKGYiICBz
#0#b3VyY2UgICAgICA6IHtpbnB1dF9kaXJ9IikpCiAgICBwcmludChfZGltKGYiICBkZXN0aW5hdGlv
#0#biA6IHtvdXRwdXRfZGlyfSIpKQogICAgcHJpbnQoX2RpbShmIiAgZGF0YXNldHMgICAgOiB7bGVu
#0#KGltc19maWxlcyl9ICAgKGZpbHRyZToge2FyZ3Mub25seSBvciAnKid9KSIpKQogICAgcHJpbnQo
#0#X2RpbShmIiAgZG93bmxvYWQvICAgOiB7J291aScgaWYgYXJncy53aXRoX2Rvd25sb2FkcyBlbHNl
#0#ICdub24nfSIpKQogICAgcHJpbnQoX2RpbShmIiAgdHJhY2tpbmcgICAgOiB7YXJncy50cmFja2lu
#0#Z30iKSkKCiAgICAjIEdyYWNlZnVsIEN0cmwrQzogY29uZmlybSB3aXRoIHRoZSB1c2VyLCB0aGVu
#0#IHRlYXIgdGhlIHJ1bm5pbmcgc3RlcCBkb3duIGNsZWFubHkuCiAgICBfaW5zdGFsbF9zaWdpbnRf
#0#aGFuZGxlcigpCgogICAgIyBUd28gaW5wdXRzIHRoYXQgd291bGQgbGFuZCBpbiB0aGUgc2FtZSBm
#0#b2xkZXIgbXVzdCBub3Qgb3ZlcndyaXRlIGVhY2ggb3RoZXI6IHRoZQogICAgIyBmaXJzdCBvbmUg
#0#Y2xhaW1zIHRoZSBuYW1lLCB0aGUgc2Vjb25kIGlzIHJlZnVzZWQgYW5kIG5hbWVkLgogICAgY2xh
#0#c2hlcyA9IF9mb2xkZXJfY29sbGlzaW9ucyhpbXNfZmlsZXMpCgogICAgIyBPbmUgZGF0YXNldCBh
#0#dCBhIHRpbWUgKGJvdW5kZWQgUkFNKSDigJQgZWFjaCBzdGVwIGFscmVhZHkgbXVsdGl0aHJlYWRz
#0#IGludGVybmFsbHkuCiAgICBpbnRlcnJ1cHRlZCA9IEZhbHNlCiAgICBmYWlsZWQgPSBbXQogICAg
#0#Zm9yIGksIGltc19maWxlIGluIGVudW1lcmF0ZShpbXNfZmlsZXMpOgogICAgICAgIGlmIGltc19m
#0#aWxlIGluIGNsYXNoZXM6CiAgICAgICAgICAgIHByaW50KF9lcnIoZiIgICBbWF0ge2ltc19maWxl
#0#Lm5hbWV9IDogbWVtZSBkb3NzaWVyIGRlIGRlc3RpbmF0aW9uIHF1ZSAiCiAgICAgICAgICAgICAg
#0#ICAgICAgICAgZiJ7Y2xhc2hlc1tpbXNfZmlsZV0ubmFtZX0g4oCUIHJlbm9tbWV6IGwndW4gZGVz
#0#IGRldXggZmljaGllcnMiKSkKICAgICAgICAgICAgZmFpbGVkLmFwcGVuZChpbXNfZmlsZS5uYW1l
#0#KQogICAgICAgICAgICBjb250aW51ZQogICAgICAgIHRyeToKICAgICAgICAgICAgb2sgPSBwcm9j
#0#ZXNzX2ltc19maWxlKGltc19maWxlLCBvdXRwdXRfZGlyLCBpICsgMSwgbGVuKGltc19maWxlcyks
#0#CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoX2Rvd25sb2Fkcz1hcmdzLndp
#0#dGhfZG93bmxvYWRzLCB0cmFja2luZz1hcmdzLnRyYWNraW5nKQogICAgICAgICAgICBpZiBub3Qg
#0#b2s6CiAgICAgICAgICAgICAgICBmYWlsZWQuYXBwZW5kKGltc19maWxlLm5hbWUpCiAgICAgICAg
#0#ZXhjZXB0IEtleWJvYXJkSW50ZXJydXB0OgogICAgICAgICAgICBpbnRlcnJ1cHRlZCA9IFRydWUK
#0#ICAgICAgICAgICAgYnJlYWsKICAgICAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGV4YzoKICAgICAg
#0#ICAgICAgcHJpbnQoX2VycihmIiAgIFtYXSB7aW1zX2ZpbGUubmFtZX0gOiB7ZXhjfSIpKQogICAg
#0#ICAgICAgICBmYWlsZWQuYXBwZW5kKGltc19maWxlLm5hbWUpCgogICAgaWYgaW50ZXJydXB0ZWQ6
#0#CiAgICAgICAgIyBSZW1vdmUgYW55IGhhbGYtd3JpdHRlbiB0ZW1wIGZvbGRlciBsZWZ0IGJ5IHRo
#0#ZSBhYm9ydGVkIGRhdGFzZXQuCiAgICAgICAgZm9yIHN0cmF5IGluIG91dHB1dF9kaXIuZ2xvYigi
#0#LnRlbXBfcHJlcHJvY2Vzc18qIik6CiAgICAgICAgICAgIHNodXRpbC5ybXRyZWUoc3RyYXksIGln
#0#bm9yZV9lcnJvcnM9VHJ1ZSkKICAgICAgICBwcmludCgpCiAgICAgICAgcHJpbnQoX3dhcm4oIiAg
#0#UGlwZWxpbmUgaW50ZXJyb21wdSBwYXIgbCd1dGlsaXNhdGV1ciAoQ3RybCtDKS4gRXRhdCBuZXR0
#0#b3llLiIpKQogICAgICAgIHN5cy5leGl0KDEzMCkKCiAgICBwcmludCgpCiAgICBpZiBmYWlsZWQ6
#0#CiAgICAgICAgcHJpbnQoX2VycihmIiAgUGlwZWxpbmUgdGVybWluZSA6IHtsZW4oZmFpbGVkKX0g
#0#ZGF0YXNldChzKSBlbiBlY2hlYyDigJQgIiArICIsICIuam9pbihmYWlsZWQpKSkKICAgICAgICBz
#0#eXMuZXhpdCgxKQogICAgcHJpbnQoX29rKCIgIFBpcGVsaW5lIHRlcm1pbmUuIikpCgppZiBfX25h
#0#bWVfXyA9PSAiX19tYWluX18iOgogICAgdHJ5OgogICAgICAgIG1haW4oKQogICAgZXhjZXB0IEtl
#0#eWJvYXJkSW50ZXJydXB0OgogICAgICAgICMgQ3RybCtDIGNvbmZpcm1lZCBvdXRzaWRlIGEgZGF0
#0#YXNldCAoZS5nLiBiZXR3ZWVuIHN0ZXBzKSDigJQgZXhpdCBjbGVhbmx5LgogICAgICAgIHByaW50
#0#KF93YXJuKCJcblshXSBQaXBlbGluZSBhcnJldGUuIiksIGZpbGU9c3lzLnN0ZGVycikKICAgICAg
#0#ICBzeXMuZXhpdCgxMzApCg==
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
:: ---- [3] 3-chunk_packer.py (22098 octets) ----
#3#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMw0KaW1wb3J0IGhhc2hsaWINCmltcG9ydCBpbw0KaW1wb3J0
#3#IGl0ZXJ0b29scw0KaW1wb3J0IG1hdGgNCmltcG9ydCBvcw0KaW1wb3J0IHN5cw0KZnJvbSBjb2xs
#3#ZWN0aW9ucyBpbXBvcnQgZGVxdWUNCmZyb20gY29uY3VycmVudC5mdXR1cmVzIGltcG9ydCBQcm9j
#3#ZXNzUG9vbEV4ZWN1dG9yDQpmcm9tIHBhdGhsaWIgaW1wb3J0IFBhdGgNCmltcG9ydCBudW1weSBh
#3#cyBucA0KZnJvbSBQSUwgaW1wb3J0IEltYWdlDQoNCkhFUkUgPSBQYXRoKF9fZmlsZV9fKS5yZXNv
#3#bHZlKCkucGFyZW50DQppZiBzdHIoSEVSRSkgbm90IGluIHN5cy5wYXRoOg0KICAgIHN5cy5wYXRo
#3#Lmluc2VydCgwLCBzdHIoSEVSRSkpDQpmcm9tIHJ1bl9wcmVwcm9jZXNzIGltcG9ydCB3b3JrZXJf
#3#Y291bnQsIGF0b21pY193cml0ZV9qc29uLCByZWFkX2pzb25fZmlsZSAgIyBub3FhOiBFNDAyDQpp
#3#bXBvcnQgcGxhbmVzX3dyaXRlciAgIyBub3FhOiBFNDAyDQoNCiMgRW1wdHktc3BhY2Ugc2tpcHBp
#3#bmcgY291bnRzIHRoZSB2b3hlbHMgdGhlIFJFTkRFUkVSIGNhbiBkcmF3LCBub3QgdGhlIHZveGVs
#3#cyB0aGF0DQojIGFyZSBtZXJlbHkgbm9uLXplcm8uDQojDQojIFdpbmRvdyBsZXZlbGluZyBpbiAy
#3#LWltYWdlX3Byb2Nlc3Nvci5weSBtYXBzIFtiZ19mbG9vciwgc2lnX21heF0gb250byBbMCwgMjU1
#3#XSwgc28gYQ0KIyB2b3hlbCBzaXR0aW5nIG9uZSBzdGVwIGFib3ZlIHRoZSBub2lzZSBmbG9vciBs
#3#YW5kcyBvbiAxLiBCYWNrZ3JvdW5kIG5vaXNlIHN0cmFkZGxpbmcNCiMgYmdfZmxvb3IgdGhlcmVm
#3#b3JlIGFsd2F5cyBsZWF2ZXMgYSBzcGVja2xlIG9mIDFzIOKAlCB0aGF0IGlzIGFyaXRobWV0aWMs
#3#IG5vdCBhIGRlZmVjdC4NCiMgQ291bnRpbmcgdGhvc2UgYXMgY29udGVudCBtYWRlIGEgYnJpY2sg
#3#dGhhdCBpcyA5Ny05OSAlIHplcm8gcGFzcyB0aGUgdGVzdDogbWVhc3VyZWQgb24NCiMgdGhlIHB1
#3#Ymxpc2hlZCBEZWNpZHVhIGJyaWNrcywgdGhlIGVpZ2h0IGNvcm5lciBicmlja3MgYXJlIDk2Ljkg
#3#JSwgOTguNSAlIGFuZCA5OC45ICUNCiMgemVybyAoOTl0aCBwZXJjZW50aWxlID0gMSkgYW5kIHdl
#3#cmUgYWxsIGtlcHQsIHdoaWNoIGlzIHdoeSB0aGF0IGRhdGFzZXQgcmVwb3J0cyA3MjAwDQojIG5v
#3#bi1lbXB0eSBicmlja3Mgb3V0IG9mIDcyMDAgYW5kIGRvd25sb2FkcyB+NHggd2hhdCBhIGNvbXBh
#3#cmFibGUgb25lIGRvZXMuDQojDQojIFRoZSB2aWV3ZXIgbmV2ZXIgc2hvd3MgdGhvc2Ugdm94ZWxz
#3#LiB2b2x1bWUtdmlld2VyLmpzOl9mbG9vcnNGcm9tTWFuaWZlc3QgZGVyaXZlcyBhDQojIHBlci1j
#3#aGFubmVsIGJhY2tncm91bmQgZmxvb3IgYW5kIGNsYW1wcyBpdCB0byBbNiwgNDhdIChpdCByZWFj
#3#aGVzIHRoZSBsb3cgZW5kIG9mIHRoYXQNCiMgY2xhbXAgd2hlbmV2ZXIgdGhlIG1hbmlmZXN0IGNh
#3#cnJpZXMgbm8gZXhwbGljaXQgYmFja2dyb3VuZEZsb29yLCB3aGljaCBpcyBldmVyeQ0KIyBkYXRh
#3#c2V0IHB1Ymxpc2hlZCBzbyBmYXIpLiBBbnl0aGluZyB1bmRlciA2IGlzIGNydXNoZWQgdG8gemVy
#3#byBieSB0aGUgTFVUIGJlZm9yZSB0aGUNCiMgcmF5IG1hcmNoZXIgZXZlciBzZWVzIGl0LiBBIHZv
#3#eGVsIGFib3ZlIERJU1BMQVlfRkxPT1IgPSA1IGlzIHRoZXJlZm9yZSAiZHJhd2FibGUiLg0KIw0K
#3#IyBBIGJyaWNrIGlzIGtlcHQgd2hlbiBCT1RIIGhvbGQ6DQojICAgKGEpIGl0IGhhcyBhdCBsZWFz
#3#dCBvbmUgZHJhd2FibGUgdm94ZWwg4oCUIGEgYnJpY2sgd2l0aG91dCBvbmUgY2Fubm90IGNvbnRy
#3#aWJ1dGUgYQ0KIyAgICAgICBzaW5nbGUgcGl4ZWwsIGhvd2V2ZXIgbWFueSBxdWFudGl6YXRpb24t
#3#bm9pc2UgMXMgaXQgY2FycmllczsNCiMgICAoYikgaXRzIG5vbi16ZXJvIHZveGVscyAoZHJhd2Fi
#3#bGUgb25lcyBBTkQgbm9pc2UgMXMpIGV4Y2VlZCBFU1NfTUlOX09DQ1VQQU5DWSBvZiBpdHMNCiMg
#3#ICAgICAgdmFsaWQgdm94ZWxzIOKAlCB0aGUgaGlzdG9yaWMgYmFuZHdpZHRoIHRvbGVyYW5jZSwg
#3#MC4wMDA1IHggNjReMyA9IDEzMSB2b3hlbHMgZm9yDQojICAgICAgIGEgZnVsbCBicmljay4NCiMg
#3#KGIpIGlzIGEgZGVsaWJlcmF0ZSB0cmFkZS1vZmYsIG5vdCBhIG5vaXNlIGZpbHRlcjogYSBicmlj
#3#ayBob2xkaW5nIGEgZmV3IGJyaWdodCB2b3hlbHMNCiMgb2YgYSB0aGluIHZlc3NlbCB0aXAgb3Ig
#3#YW4gaXNvbGF0ZWQgY2VsbCAoYW5kIGxpdHRsZSBub2lzZSBhcm91bmQgdGhlbSkgZmFpbHMgaXQg
#3#YW5kIGlzDQojIGRyb3BwZWQsIHNvIGF0IG1vc3QgMTMxIGRyYXdhYmxlIHZveGVscyBwZXIgYnJp
#3#Y2sgYXJlIGdpdmVuIHVwIHRvIHNhdmUgYSBkb3dubG9hZC4NCiMgUmVwbGF5aW5nIHRoZSBydWxl
#3#IG92ZXIgZXZlcnkgcHVibGlzaGVkIGJyaWNrIG9mIGEgTE9ELCAoYSkgYWxvbmUgdG9vayBEZWNp
#3#ZHVhIGxvZDINCiMgZnJvbSAxODM2IGtlcHQgYnJpY2tzIHRvIDE0MzQgYW5kIHRoZSBoZWFsdGh5
#3#IEVtMTAgbG9kMiBmcm9tIDkzMiB0byA5MzA7IGRyb3BwaW5nIChiKQ0KIyB3b3VsZCBrZWVwIDI5
#3#MSBNT1JFIERlY2lkdWEgbG9kMiBicmlja3MsIGVhY2ggaG9sZGluZyBhdCBtb3N0IDEzMSBkcmF3
#3#YWJsZSB2b3hlbHMuDQojIFRoZSBwYWNrZXIgcmVwb3J0cywgcGVyIExPRCwgaG93IG1hbnkgYnJp
#3#Y2tzIHdpdGggZHJhd2FibGUgdm94ZWxzIChiKSBkcm9wcGVkIGFuZCBob3cNCiMgbWFueSBzdWNo
#3#IHZveGVscyB0aGV5IGhlbGQuIExVTUVOX0VTU19NSU5fT0NDVVBBTkNZIG92ZXJyaWRlcyB0aGUg
#3#dG9sZXJhbmNlICgwIGtlZXBzDQojIGV2ZXJ5IGJyaWNrIHdpdGggYSBkcmF3YWJsZSB2b3hlbCk7
#3#IHVuc2V0LCB0aGUgb3V0cHV0IGlzIHRoZSBoaXN0b3JpYyBvbmUuDQpESVNQTEFZX0ZMT09SID0g
#3#NSAgICAgICAgICAgIyB0aGUgdmlld2VyJ3MgTFVUIGNydXNoZXMgZXZlcnl0aGluZyBiZWxvdyA2
#3#IHRvIHplcm8NCg0KDQpkZWYgX2Vzc19taW5fb2NjdXBhbmN5KCkgLT4gZmxvYXQ6DQogICAgcmF3
#3#ID0gb3MuZW52aXJvbi5nZXQoIkxVTUVOX0VTU19NSU5fT0NDVVBBTkNZIiwgIiIpLnN0cmlwKCkN
#3#CiAgICBpZiByYXc6DQogICAgICAgIHRyeToNCiAgICAgICAgICAgIHZhbHVlID0gZmxvYXQocmF3
#3#KQ0KICAgICAgICAgICAgaWYgMC4wIDw9IHZhbHVlIDwgMS4wOg0KICAgICAgICAgICAgICAgIHJl
#3#dHVybiB2YWx1ZQ0KICAgICAgICBleGNlcHQgVmFsdWVFcnJvcjoNCiAgICAgICAgICAgIHBhc3MN
#3#CiAgICAgICAgcHJpbnQoZiJbUEFDS0VSXSBMVU1FTl9FU1NfTUlOX09DQ1VQQU5DWT17cmF3IXJ9
#3#IGlnbm9yZSAoMCA8PSB4IDwgMSBhdHRlbmR1KSIsIGZsdXNoPVRydWUpDQogICAgcmV0dXJuIDAu
#3#MDAwNQ0KDQoNCkVTU19NSU5fT0NDVVBBTkNZID0gX2Vzc19taW5fb2NjdXBhbmN5KCkNCg0KQlJJ
#3#Q0tfU0laRSA9IDY0DQpDSFVOS1NfUEVSX1BBQ0sgPSAxMjgNCkJSSUNLU19QRVJfVEFTSyA9IDE2
#3#ICAgICAgICAjIGJyaWNrcyBhIHdvcmtlciByZWFkcyBhbmQgZW5jb2RlcyBwZXIgdGFzaw0KDQoN
#3#CmRlZiBwcm9jZXNzX2NodW5rKGFyZ3MpOg0KICAgIGNodW5rX2RhdGEsIGNoX21ldGEsIEJSSUNL
#3#X1NJWkUgPSBhcmdzDQogICAgbm9uX3plcm8gPSBucC5jb3VudF9ub256ZXJvKGNodW5rX2RhdGEp
#3#DQogICAgdmFsaWRfdm94ZWxzID0gbWF4KDEsIGNoX21ldGFbInZhbGlkVm94ZWxDb3VudCJdKQ0K
#3#ICAgIG9jYyA9IGZsb2F0KG5vbl96ZXJvKSAvIGZsb2F0KHZhbGlkX3ZveGVscykNCg0KICAgICMg
#3#QSBicmljayBob2xkaW5nIG5vdGhpbmcgYXQgb3IgYWJvdmUgdGhlIGRpc3BsYXkgZmxvb3IgY2Fu
#3#bm90IGNvbnRyaWJ1dGUgYSBzaW5nbGUNCiAgICAjIHBpeGVsOiBpdCBpcyBlbXB0eSBob3dldmVy
#3#IG1hbnkgcXVhbnRpemF0aW9uLW5vaXNlIDFzIGl0IGNhcnJpZXMuDQogICAgaGFzX2RyYXdhYmxl
#3#ID0gYm9vbChucC5hbnkoY2h1bmtfZGF0YSA+IERJU1BMQVlfRkxPT1IpKQ0KDQogICAgaXNfbm9u
#3#X2VtcHR5ID0gb2NjID4gRVNTX01JTl9PQ0NVUEFOQ1kgYW5kIGhhc19kcmF3YWJsZQ0KICAgIGlm
#3#IG5vdCBpc19ub25fZW1wdHk6DQogICAgICAgIHJldHVybiAoY2hfbWV0YVsiaWR4Il0sIDAuMCBp
#3#ZiBub3QgaGFzX2RyYXdhYmxlIGVsc2Ugb2NjLCBGYWxzZSwgTm9uZSkNCg0KICAgIHBhZGRlZCA9
#3#IG5wLnplcm9zKChCUklDS19TSVpFLCBCUklDS19TSVpFLCBCUklDS19TSVpFKSwgZHR5cGU9bnAu
#3#dWludDgpDQogICAgZCwgaCwgdyA9IGNodW5rX2RhdGEuc2hhcGUNCiAgICBwYWRkZWRbOmQsIDpo
#3#LCA6d10gPSBjaHVua19kYXRhDQoNCiAgICBtb3NhaWMgPSBucC56ZXJvcygoNTEyLCA1MTIpLCBk
#3#dHlwZT1ucC51aW50OCkNCiAgICBmb3IgeiBpbiByYW5nZSg2NCk6DQogICAgICAgIHJvdyA9IHog
#3#Ly8gOA0KICAgICAgICBjb2wgPSB6ICUgOA0KICAgICAgICBtb3NhaWNbcm93KjY0Oihyb3crMSkq
#3#NjQsIGNvbCo2NDooY29sKzEpKjY0XSA9IHBhZGRlZFt6XQ0KDQogICAgaW1nID0gSW1hZ2UuZnJv
#3#bWFycmF5KG1vc2FpYykNCiAgICBidWYgPSBpby5CeXRlc0lPKCkNCiAgICBpbWcuc2F2ZShidWYs
#3#IGZvcm1hdD0iV0VCUCIsIGxvc3NsZXNzPVRydWUpDQogICAgcmV0dXJuIChjaF9tZXRhWyJpZHgi
#3#XSwgb2NjLCBUcnVlLCBidWYuZ2V0dmFsdWUoKSkNCg0KDQojIOKUgOKUgCBXb3JrZXIgdGFza3M6
#3#IHRoZXkgcmVhZCB0aGUgTE9EIGZpbGUgdGhlbXNlbHZlcywgc28gbm8gdm94ZWwgY3Jvc3NlcyBh
#3#IHBpcGUg4pSADQpkZWYgZW5jb2RlX2JyaWNrX2JhdGNoKGFyZ3MpOg0KICAgICIiIkVuY29kZSBh
#3#IHJ1biBvZiBicmlja3Mgb2Ygb25lIChMT0QsIGNoYW5uZWwpIGZpbGUuDQoNCiAgICBpdGVtczog
#3#WyhpZHgsICh6MCwgejEsIHkwLCB5MSwgeDAsIHgxKSwgdmFsaWRWb3hlbENvdW50KV0uIFJldHVy
#3#bnMsIHBlciBicmljaywNCiAgICBwcm9jZXNzX2NodW5rJ3MgKGlkeCwgb2NjLCBrZXB0LCBieXRl
#3#cykgcGx1cyB0aGUgbnVtYmVyIG9mIGRyYXdhYmxlIHZveGVscyBhIGRyb3BwZWQNCiAgICBicmlj
#3#ayBoZWxkICgwIGZvciBhIGtlcHQgb25lKS4NCiAgICAiIiINCiAgICBiaW5fcGF0aCwgc2hhcGUs
#3#IGl0ZW1zID0gYXJncw0KICAgIHZvbCA9IG5wLm1lbW1hcChiaW5fcGF0aCwgZHR5cGU9bnAudWlu
#3#dDgsIG1vZGU9InIiLCBzaGFwZT10dXBsZShzaGFwZSkpDQogICAgb3V0ID0gW10NCiAgICB0cnk6
#3#DQogICAgICAgIGZvciBpZHgsICh6MCwgejEsIHkwLCB5MSwgeDAsIHgxKSwgdmFsaWQgaW4gaXRl
#3#bXM6DQogICAgICAgICAgICBjaHVuayA9IG5wLmFycmF5KHZvbFt6MDp6MSwgeTA6eTEsIHgwOngx
#3#XSkNCiAgICAgICAgICAgIGlkeCwgb2NjLCBrZXB0LCBkYXRhID0gcHJvY2Vzc19jaHVuaygoY2h1
#3#bmssIHsiaWR4IjogaWR4LCAidmFsaWRWb3hlbENvdW50IjogdmFsaWR9LA0KICAgICAgICAgICAg
#3#ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBCUklDS19TSVpFKSkNCiAgICAg
#3#ICAgICAgIGRyb3BwZWQgPSAwIGlmIGtlcHQgb3Igb2NjIDw9IDAuMCBlbHNlIGludChucC5jb3Vu
#3#dF9ub256ZXJvKGNodW5rID4gRElTUExBWV9GTE9PUikpDQogICAgICAgICAgICBvdXQuYXBwZW5k
#3#KChpZHgsIG9jYywga2VwdCwgZGF0YSwgZHJvcHBlZCkpDQogICAgZmluYWxseToNCiAgICAgICAg
#3#ZGVsIHZvbA0KICAgIHJldHVybiBvdXQNCg0KDQpkZWYgbGF5ZXJfbWF4X2dyaWQoYXJncyk6DQog
#3#ICAgIiIiUGVyLWJyaWNrIG1heGltdW0gb2Ygb25lIDY0LXBsYW5lIGJyaWNrIGxheWVyIG9mIGEg
#3#TE9EIGZpbGUsIHJlYWQgcGxhbmUgYnkgcGxhbmU6DQogICAgYSAobnksIG54KSB1aW50OCBncmlk
#3#LiIiIg0KICAgIGJpbl9wYXRoLCBzaGFwZSwgYnogPSBhcmdzDQogICAgRCwgSCwgVyA9IHNoYXBl
#3#DQogICAgdm9sID0gbnAubWVtbWFwKGJpbl9wYXRoLCBkdHlwZT1ucC51aW50OCwgbW9kZT0iciIs
#3#IHNoYXBlPShELCBILCBXKSkNCiAgICB5cyA9IG5wLmFyYW5nZSgwLCBILCBCUklDS19TSVpFKQ0K
#3#ICAgIHhzID0gbnAuYXJhbmdlKDAsIFcsIEJSSUNLX1NJWkUpDQogICAgZ3JpZCA9IG5wLnplcm9z
#3#KChsZW4oeXMpLCBsZW4oeHMpKSwgZHR5cGU9bnAudWludDgpDQogICAgdHJ5Og0KICAgICAgICBm
#3#b3IgeiBpbiByYW5nZShieiAqIEJSSUNLX1NJWkUsIG1pbihELCAoYnogKyAxKSAqIEJSSUNLX1NJ
#3#WkUpKToNCiAgICAgICAgICAgIHBsYW5lID0gbnAuYXNhcnJheSh2b2xbel0pDQogICAgICAgICAg
#3#ICBucC5tYXhpbXVtKGdyaWQsIG5wLm1heGltdW0ucmVkdWNlYXQobnAubWF4aW11bS5yZWR1Y2Vh
#3#dChwbGFuZSwgeXMsIGF4aXM9MCksDQogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg
#3#ICAgICAgICAgICAgICAgeHMsIGF4aXM9MSksIG91dD1ncmlkKQ0KICAgIGZpbmFsbHk6DQogICAg
#3#ICAgIGRlbCB2b2wNCiAgICByZXR1cm4gZ3JpZA0KDQoNCl9ET05FID0gb2JqZWN0KCkNCg0KDQpk
#3#ZWYgb3JkZXJlZF9yZXN1bHRzKGV4ZWN1dG9yLCBmbiwgdGFza3MsIHdpbmRvdzogaW50KToNCiAg
#3#ICAiIiJSZXN1bHRzIG9mIGZuIG92ZXIgdGFza3MsIGluIG9yZGVyLCB3aXRoIGF0IG1vc3QgYHdp
#3#bmRvd2AgdGFza3Mgc3VibWl0dGVkIGFoZWFkIOKAlA0KICAgIHRoZSBlbmNvZGVkIGJyaWNrcyBv
#3#ZiBhIHdob2xlIExPRCBuZXZlciBxdWV1ZSB1cCBpbiBtZW1vcnkgYXQgb25jZS4iIiINCiAgICBp
#3#ZiBleGVjdXRvciBpcyBOb25lOg0KICAgICAgICB5aWVsZCBmcm9tIG1hcChmbiwgdGFza3MpDQog
#3#ICAgICAgIHJldHVybg0KICAgIGl0ID0gaXRlcih0YXNrcykNCiAgICBwZW5kaW5nID0gZGVxdWUo
#3#ZXhlY3V0b3Iuc3VibWl0KGZuLCB0KSBmb3IgdCBpbiBpdGVydG9vbHMuaXNsaWNlKGl0LCB3aW5k
#3#b3cpKQ0KICAgIHdoaWxlIHBlbmRpbmc6DQogICAgICAgIHJlc3VsdCA9IHBlbmRpbmcucG9wbGVm
#3#dCgpLnJlc3VsdCgpDQogICAgICAgIG54dCA9IG5leHQoaXQsIF9ET05FKQ0KICAgICAgICBpZiBu
#3#eHQgaXMgbm90IF9ET05FOg0KICAgICAgICAgICAgcGVuZGluZy5hcHBlbmQoZXhlY3V0b3Iuc3Vi
#3#bWl0KGZuLCBueHQpKQ0KICAgICAgICB5aWVsZCByZXN1bHQNCg0KDQpjbGFzcyBfUGFja1dyaXRl
#3#cjoNCiAgICAiIiJBcHBlbmRzIGJyaWNrcyB0byBwYWNrX05OLmJpbiBmaWxlcyBvZiBvbmUgKExP
#3#RCwgY2hhbm5lbCksIHJvbGxpbmcgb3ZlciBldmVyeQ0KICAgIENIVU5LU19QRVJfUEFDSyBicmlj
#3#a3MgYW5kIGhhc2hpbmcgZWFjaCBwYWNrIGFzIGl0IGlzIHdyaXR0ZW4uIiIiDQoNCiAgICBkZWYg
#3#X19pbml0X18oc2VsZiwgY2hhbm5lbF9kaXI6IFBhdGgsIHRwX3Jvb3Q6IFBhdGgsIHBhY2tfaGFz
#3#aGVzOiBkaWN0KToNCiAgICAgICAgc2VsZi5kaXIgPSBjaGFubmVsX2Rpcg0KICAgICAgICBzZWxm
#3#LnJvb3QgPSB0cF9yb290DQogICAgICAgIHNlbGYuaGFzaGVzID0gcGFja19oYXNoZXMNCiAgICAg
#3#ICAgc2VsZi5pZHggPSAtMQ0KICAgICAgICBzZWxmLl9vcGVuX25leHQoKQ0KDQogICAgZGVmIF9v
#3#cGVuX25leHQoc2VsZik6DQogICAgICAgIHNlbGYuaWR4ICs9IDENCiAgICAgICAgc2VsZi5wYXRo
#3#ID0gc2VsZi5kaXIgLyBmInBhY2tfe3NlbGYuaWR4OjAyZH0uYmluIg0KICAgICAgICBzZWxmLmZo
#3#ID0gb3BlbihzZWxmLnBhdGgsICJ3YiIpDQogICAgICAgIHNlbGYuc2hhID0gaGFzaGxpYi5zaGEy
#3#NTYoKQ0KICAgICAgICBzZWxmLm9mZnNldCA9IDANCiAgICAgICAgc2VsZi5jb3VudCA9IDANCg0K
#3#ICAgIGRlZiBfZmluaXNoKHNlbGYpOg0KICAgICAgICBzZWxmLmZoLmNsb3NlKCkNCiAgICAgICAg
#3#c2VsZi5oYXNoZXNbc2VsZi5wYXRoLnJlbGF0aXZlX3RvKHNlbGYucm9vdCkuYXNfcG9zaXgoKV0g
#3#PSBzZWxmLnNoYS5oZXhkaWdlc3QoKQ0KDQogICAgZGVmIGFkZChzZWxmLCBkYXRhOiBieXRlcykg
#3#LT4gZGljdDoNCiAgICAgICAgaWYgc2VsZi5jb3VudCA+PSBDSFVOS1NfUEVSX1BBQ0s6DQogICAg
#3#ICAgICAgICBzZWxmLl9maW5pc2goKQ0KICAgICAgICAgICAgc2VsZi5fb3Blbl9uZXh0KCkNCiAg
#3#ICAgICAgc2VsZi5maC53cml0ZShkYXRhKQ0KICAgICAgICBzZWxmLnNoYS51cGRhdGUoZGF0YSkN
#3#CiAgICAgICAgZW50cnkgPSB7InVybCI6IHNlbGYucGF0aC5yZWxhdGl2ZV90byhzZWxmLnJvb3Qp
#3#LmFzX3Bvc2l4KCksDQogICAgICAgICAgICAgICAgICJvZmZzZXQiOiBpbnQoc2VsZi5vZmZzZXQp
#3#LCAibGVuZ3RoIjogaW50KGxlbihkYXRhKSl9DQogICAgICAgIHNlbGYub2Zmc2V0ICs9IGxlbihk
#3#YXRhKQ0KICAgICAgICBzZWxmLmNvdW50ICs9IDENCiAgICAgICAgcmV0dXJuIGVudHJ5DQoNCiAg
#3#ICBkZWYgY2xvc2Uoc2VsZik6DQogICAgICAgIHNlbGYuX2ZpbmlzaCgpDQoNCg0KZGVmIHBhY2tf
#3#dGltZXBvaW50KHRlbXBfZGlyOiBQYXRoLCBicmlja3NfZGlyOiBQYXRoLCB0X2lkeDogaW50LCBs
#3#b2RfbGV2ZWxzLCBuX2NoOiBpbnQsDQogICAgICAgICAgICAgICAgICAgZXhlY3V0b3IsIHRwX3N1
#3#YmRpcjogc3RyLCBlbmNvZGVfZm49Tm9uZSwgbGF5ZXJfZm49Tm9uZSwgcGxhbmVzX2ZuPU5vbmUp
#3#Og0KICAgICIiIkJyaWNrLCBjb21wcmVzcyBhbmQgcGFjayBldmVyeSBMT0Qgb2YgYSBzaW5nbGUg
#3#dGltZXBvaW50Lg0KDQogICAgdHBfc3ViZGlyIGlzICcnIGZvciBhIHNpbmdsZS10aW1lcG9pbnQg
#3#KCczZCcpIGRhdGFzZXQg4oCUIHRoZSBwYWNrcyB0aGVuIGxhbmQNCiAgICBkaXJlY3RseSB1bmRl
#3#ciBicmlja3MvIGFuZCB0aGUgb3V0cHV0IGlzIGJ5dGUtaWRlbnRpY2FsIHRvIHRoZSBwcmUtNEQg
#3#cGlwZWxpbmUuDQogICAgRm9yIGEgdGltZWxhcHNlIGl0IGlzICd0MDAwJywgJ3QwMDEnLCDigKYg
#3#YW5kIGVhY2ggdGltZXBvaW50IG93bnMgYSBzZWxmLWNvbnRhaW5lZA0KICAgIHBhY2sgdHJlZSB3
#3#aG9zZSBicmlja1RvUGFjayB1cmxzIHN0YXkgcmVsYXRpdmUgdG8gdGhhdCBzdWItZGlyZWN0b3J5
#3#LCB3aGljaCBpcw0KICAgIGV4YWN0bHkgd2hhdCB0aGUgdmlld2VyIGFwcGVuZHMgdG8gdGhlIGJy
#3#aWNrcyBiYXNlIHBhdGguDQoNCiAgICBlbmNvZGVfZm4gLyBsYXllcl9mbiBhcmUgdGhpcyBtb2R1
#3#bGUncyBlbmNvZGVfYnJpY2tfYmF0Y2ggLyBsYXllcl9tYXhfZ3JpZCwgb3INCiAgICB3cmFwcGVy
#3#cyBhIGNhbGxlcidzIHBvb2wgY2FuIGltcG9ydCBieSBuYW1lLg0KDQogICAgVGhlIG5hdGl2ZSBs
#3#ZXZlbCBpcyBhbHNvIHJlLWN1dCBpbnRvIFhZIHBsYW5lcyAocGxhbmVzX3dyaXRlciwgZGF0YXNl
#3#dCBmb3JtYXQgMikNCiAgICB1bmRlciA8ZGF0YXNldD4vcGxhbmVzLzx0cF9zdWJkaXI+LCBmcm9t
#3#IHRoZSBzYW1lIExPRDAgZmlsZSBhbmQgbWFza2VkIGJ5IHRoZSBzYW1lDQogICAga2VwdC1icmlj
#3#ayBpbmRleCwgd2hpbGUgdGhhdCBmaWxlIGlzIHN0aWxsIG9uIGRpc2suIFRoZWlyIG1hbmlmZXN0
#3#Lmpzb24gaXMgd3JpdHRlbg0KICAgIGJ5IGJ1aWxkX3BhY2tzIG9uY2UgYnJpY2tzL21hbmlmZXN0
#3#Lmpzb24gaGFzIGl0cyBmaW5hbCBieXRlcy4NCiAgICAiIiINCiAgICBlbmNvZGVfZm4gPSBlbmNv
#3#ZGVfZm4gb3IgZW5jb2RlX2JyaWNrX2JhdGNoDQogICAgbGF5ZXJfZm4gPSBsYXllcl9mbiBvciBs
#3#YXllcl9tYXhfZ3JpZA0KICAgIHBsYW5lc19mbiA9IHBsYW5lc19mbiBvciBwbGFuZXNfd3JpdGVy
#3#LndyaXRlX3BsYW5lX3Rhc2sNCiAgICB3aW5kb3cgPSAyICogKGdldGF0dHIoZXhlY3V0b3IsICJf
#3#bWF4X3dvcmtlcnMiLCAxKSBvciAxKQ0KDQogICAgdHBfcm9vdCA9IGJyaWNrc19kaXIgLyB0cF9z
#3#dWJkaXIgaWYgdHBfc3ViZGlyIGVsc2UgYnJpY2tzX2Rpcg0KICAgIHRwX3Jvb3QubWtkaXIocGFy
#3#ZW50cz1UcnVlLCBleGlzdF9vaz1UcnVlKQ0KDQogICAgYnJpY2tfdG9fcGFjayA9IHt9DQogICAg
#3#cGFja19oYXNoZXMgPSB7fQ0KICAgIGxldmVsc19tYW5pZmVzdCA9IFtdDQoNCiAgICBmcm9tIHRx
#3#ZG0gaW1wb3J0IHRxZG0NCiAgICBmb3IgbGkgaW4gbG9kX2xldmVsczoNCiAgICAgICAgbG9kX251
#3#bSA9IGxpWyJsb2QiXQ0KICAgICAgICBXLCBILCBEID0gbGlbIndpZHRoIl0sIGxpWyJoZWlnaHQi
#3#XSwgbGlbImRlcHRoIl0NCiAgICAgICAgc2hhcGUgPSAoRCwgSCwgVykNCg0KICAgICAgICBueCA9
#3#IG1hdGguY2VpbChXIC8gQlJJQ0tfU0laRSkNCiAgICAgICAgbnkgPSBtYXRoLmNlaWwoSCAvIEJS
#3#SUNLX1NJWkUpDQogICAgICAgIG56ID0gbWF0aC5jZWlsKEQgLyBCUklDS19TSVpFKQ0KDQogICAg
#3#ICAgICMgQnVpbGQgbG9naWNhbCBncmlkIG9mIGNodW5rcyBmb3IgdGhpcyBsZXZlbA0KICAgICAg
#3#ICBjaHVua3NfZ3JpZCA9IFtdDQogICAgICAgIGZvciBieiBpbiByYW5nZShueik6DQogICAgICAg
#3#ICAgICBmb3IgYnkgaW4gcmFuZ2UobnkpOg0KICAgICAgICAgICAgICAgIGZvciBieCBpbiByYW5n
#3#ZShueCk6DQogICAgICAgICAgICAgICAgICAgIG94LCBveSwgb3ogPSBieCAqIEJSSUNLX1NJWkUs
#3#IGJ5ICogQlJJQ0tfU0laRSwgYnogKiBCUklDS19TSVpFDQogICAgICAgICAgICAgICAgICAgIGV3
#3#ID0gbWluKEJSSUNLX1NJWkUsIFcgLSBveCkNCiAgICAgICAgICAgICAgICAgICAgZWggPSBtaW4o
#3#QlJJQ0tfU0laRSwgSCAtIG95KQ0KICAgICAgICAgICAgICAgICAgICBlZCA9IG1pbihCUklDS19T
#3#SVpFLCBEIC0gb3opDQogICAgICAgICAgICAgICAgICAgIGNodW5rc19ncmlkLmFwcGVuZCh7DQog
#3#ICAgICAgICAgICAgICAgICAgICAgICAiYngiOiBieCwNCiAgICAgICAgICAgICAgICAgICAgICAg
#3#ICJieSI6IGJ5LA0KICAgICAgICAgICAgICAgICAgICAgICAgImJ6IjogYnosDQogICAgICAgICAg
#3#ICAgICAgICAgICAgICAibWluIjogW2ludChveCksIGludChveSksIGludChveildLA0KICAgICAg
#3#ICAgICAgICAgICAgICAgICAgIm1heCI6IFtpbnQob3ggKyBldyksIGludChveSArIGVoKSwgaW50
#3#KG96ICsgZWQpXSwNCiAgICAgICAgICAgICAgICAgICAgICAgICJ2YWxpZFZveGVsQ291bnQiOiBp
#3#bnQoZXcgKiBlaCAqIGVkKQ0KICAgICAgICAgICAgICAgICAgICB9KQ0KDQogICAgICAgIGJpbl9m
#3#aWxlcyA9IHtjOiB0ZW1wX2RpciAvIGYidHt0X2lkeDowM2R9X2N7Y31fbG9ke2xvZF9udW19LmJp
#3#biIgZm9yIGMgaW4gcmFuZ2Uobl9jaCl9DQoNCiAgICAgICAgIyBPbmx5IGEgYnJpY2sgd2l0aCBh
#3#IGRyYXdhYmxlIHZveGVsIGluIFNPTUUgY2hhbm5lbCBjYW4gYmUga2VwdCBpbiBhbnkgY2hhbm5l
#3#bA0KICAgICAgICAjIChydWxlIChhKSBhYm92ZSksIHNvIG9ubHkgdGhvc2UgYXJlIHJlYWQsIGVu
#3#Y29kZWQgYW5kIGxpc3RlZC4gRW1wdHktc3BhY2UNCiAgICAgICAgIyBza2lwcGluZyBpcyBkZWNp
#3#ZGVkIHBlciB0aW1lcG9pbnQ6IGNlbGxzIG1vdmUsIHNvIHRoZSBvY2N1cGllZCBicmljayBzZXQN
#3#CiAgICAgICAgIyBsZWdpdGltYXRlbHkgZGlmZmVycyBmcm9tIG9uZSBmcmFtZSB0byB0aGUgbmV4
#3#dC4NCiAgICAgICAgZHJhd2FibGUgPSBucC56ZXJvcygobnosIG55LCBueCksIGR0eXBlPWJvb2wp
#3#DQogICAgICAgIGxheWVyX3Rhc2tzID0gWyhzdHIocCksIHNoYXBlLCBieikgZm9yIGMsIHAgaW4g
#3#YmluX2ZpbGVzLml0ZW1zKCkgaWYgcC5leGlzdHMoKQ0KICAgICAgICAgICAgICAgICAgICAgICBm
#3#b3IgYnogaW4gcmFuZ2UobnopXQ0KICAgICAgICBmb3IgKF8sIF8sIGJ6KSwgZ3JpZCBpbiB6aXAo
#3#bGF5ZXJfdGFza3MsIG9yZGVyZWRfcmVzdWx0cyhleGVjdXRvciwgbGF5ZXJfZm4sDQogICAgICAg
#3#ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg
#3#IGxheWVyX3Rhc2tzLCB3aW5kb3cpKToNCiAgICAgICAgICAgIGRyYXdhYmxlW2J6XSB8PSBncmlk
#3#ID4gRElTUExBWV9GTE9PUg0KDQogICAgICAgIGFjdGl2ZV9jaHVua3NfZ3JpZCA9IFtjaCBmb3Ig
#3#Y2ggaW4gY2h1bmtzX2dyaWQgaWYgZHJhd2FibGVbY2hbImJ6Il0sIGNoWyJieSJdLCBjaFsiYngi
#3#XV1dDQogICAgICAgIHByaW50KGYiW1BBQ0tFUl0ge3RwX3N1YmRpciBvciAndDAwMCd9IExPRCB7
#3#bG9kX251bX06IEdyaWQge254fXh7bnl9eHtuen0gIg0KICAgICAgICAgICAgICBmIih7bGVuKGNo
#3#dW5rc19ncmlkKX0gY2h1bmtzLCB7bGVuKGFjdGl2ZV9jaHVua3NfZ3JpZCl9IHdpdGggZHJhd2Fi
#3#bGUgdm94ZWxzKSIpDQoNCiAgICAgICAgIyBXZSB3aWxsIHRyYWNrIG9jY3VwYW5jeSB1bmlvbiBh
#3#Y3Jvc3MgYWxsIGNoYW5uZWxzIGZvciB0aGUgYWN0aXZlIGNodW5rIGdyaWQNCiAgICAgICAgb2Nj
#3#dXBhbmN5X3VuaW9uID0gWzAuMF0gKiBsZW4oYWN0aXZlX2NodW5rc19ncmlkKQ0KICAgICAgICBk
#3#cm9wcGVkX2JyaWNrcyA9IGRyb3BwZWRfdm94ZWxzID0gMA0KDQogICAgICAgIGl0ZW1zID0gWyhp
#3#LCAoY2hbIm1pbiJdWzJdLCBjaFsibWF4Il1bMl0sIGNoWyJtaW4iXVsxXSwgY2hbIm1heCJdWzFd
#3#LA0KICAgICAgICAgICAgICAgICAgICAgIGNoWyJtaW4iXVswXSwgY2hbIm1heCJdWzBdKSwgY2hb
#3#InZhbGlkVm94ZWxDb3VudCJdKQ0KICAgICAgICAgICAgICAgICBmb3IgaSwgY2ggaW4gZW51bWVy
#3#YXRlKGFjdGl2ZV9jaHVua3NfZ3JpZCldDQoNCiAgICAgICAgZm9yIGNfaWR4IGluIHJhbmdlKG5f
#3#Y2gpOg0KICAgICAgICAgICAgYmluX2ZpbGUgPSBiaW5fZmlsZXNbY19pZHhdDQogICAgICAgICAg
#3#ICBpZiBub3QgYmluX2ZpbGUuZXhpc3RzKCk6DQogICAgICAgICAgICAgICAgcHJpbnQoZiJbV0FS
#3#TklOR10gUHJvY2Vzc2VkIGZpbGUgbm90IGZvdW5kOiB7YmluX2ZpbGV9IikNCiAgICAgICAgICAg
#3#ICAgICBjb250aW51ZQ0KDQogICAgICAgICAgICBjaGFubmVsX2xvZF9kaXIgPSB0cF9yb290IC8g
#3#ZiJsb2R7bG9kX251bX0iIC8gZiJje2NfaWR4fSINCiAgICAgICAgICAgIGNoYW5uZWxfbG9kX2Rp
#3#ci5ta2RpcihwYXJlbnRzPVRydWUsIGV4aXN0X29rPVRydWUpDQogICAgICAgICAgICB3cml0ZXIg
#3#PSBfUGFja1dyaXRlcihjaGFubmVsX2xvZF9kaXIsIHRwX3Jvb3QsIHBhY2tfaGFzaGVzKQ0KDQog
#3#ICAgICAgICAgICB0YXNrcyA9IFsoc3RyKGJpbl9maWxlKSwgc2hhcGUsIGl0ZW1zW2s6ayArIEJS
#3#SUNLU19QRVJfVEFTS10pDQogICAgICAgICAgICAgICAgICAgICBmb3IgayBpbiByYW5nZSgwLCBs
#3#ZW4oaXRlbXMpLCBCUklDS1NfUEVSX1RBU0spXQ0KICAgICAgICAgICAgdHJ5Og0KICAgICAgICAg
#3#ICAgICAgIGZvciBiYXRjaCBpbiB0cWRtKG9yZGVyZWRfcmVzdWx0cyhleGVjdXRvciwgZW5jb2Rl
#3#X2ZuLCB0YXNrcywgd2luZG93KSwNCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0
#3#b3RhbD1sZW4odGFza3MpLCBkZXNjPSJDb21wcmVzc2luZyBXZWJQIiwgbGVhdmU9RmFsc2UsDQog
#3#ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNjaWk9VHJ1ZSwgbWluaW50ZXJ2YWw9
#3#Mi4wKToNCiAgICAgICAgICAgICAgICAgICAgZm9yIGlkeCwgb2NjLCBpc19ub25fZW1wdHksIGNv
#3#bXByZXNzZWRfYnl0ZXMsIGRyb3BwZWQgaW4gYmF0Y2g6DQogICAgICAgICAgICAgICAgICAgICAg
#3#ICBvY2N1cGFuY3lfdW5pb25baWR4XSA9IG1heChvY2N1cGFuY3lfdW5pb25baWR4XSwgb2NjKQ0K
#3#ICAgICAgICAgICAgICAgICAgICAgICAgaWYgaXNfbm9uX2VtcHR5Og0KICAgICAgICAgICAgICAg
#3#ICAgICAgICAgICAgIGNoID0gYWN0aXZlX2NodW5rc19ncmlkW2lkeF0NCiAgICAgICAgICAgICAg
#3#ICAgICAgICAgICAgICBieCwgYnksIGJ6ID0gY2hbImJ4Il0sIGNoWyJieSJdLCBjaFsiYnoiXQ0K
#3#ICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyaWNrX3JlbF9rZXkgPSBmImxvZHtsb2RfbnVt
#3#fS9je2NfaWR4fS94e2J4OjAzZH1feXtieTowM2R9X3p7Yno6MDNkfS53ZWJwIg0KICAgICAgICAg
#3#ICAgICAgICAgICAgICAgICAgIGJyaWNrX3RvX3BhY2tbYnJpY2tfcmVsX2tleV0gPSB3cml0ZXIu
#3#YWRkKGNvbXByZXNzZWRfYnl0ZXMpDQogICAgICAgICAgICAgICAgICAgICAgICBlbGlmIGRyb3Bw
#3#ZWQ6DQogICAgICAgICAgICAgICAgICAgICAgICAgICAgZHJvcHBlZF9icmlja3MgKz0gMQ0KICAg
#3#ICAgICAgICAgICAgICAgICAgICAgICAgIGRyb3BwZWRfdm94ZWxzICs9IGRyb3BwZWQNCiAgICAg
#3#ICAgICAgIGZpbmFsbHk6DQogICAgICAgICAgICAgICAgd3JpdGVyLmNsb3NlKCkNCg0KICAgICAg
#3#ICBpZiBkcm9wcGVkX2JyaWNrczoNCiAgICAgICAgICAgIHByaW50KGYiW1BBQ0tFUl0gICB0b2xl
#3#cmFuY2UgRVNTICh7RVNTX01JTl9PQ0NVUEFOQ1k6Z30pIDoge2Ryb3BwZWRfYnJpY2tzfSBicmlj
#3#ayhzKSAiDQogICAgICAgICAgICAgICAgICBmImVjYXJ0ZWUocykgbWFsZ3JlIHtkcm9wcGVkX3Zv
#3#eGVsc30gdm94ZWwocykgYWZmaWNoYWJsZShzKSAodG91dGVzIHZvaWVzKSIpDQoNCiAgICAgICAg
#3#IyBCdWlsZCBsZXZlbCBjaHVua3MgbGlzdCBmb3IgbWFuaWZlc3QNCiAgICAgICAgbWFuaWZlc3Rf
#3#Y2h1bmtzID0gW10NCiAgICAgICAgbm9uX2VtcHR5X2NvdW50ID0gMA0KICAgICAgICBmb3IgaSwg
#3#Y2ggaW4gZW51bWVyYXRlKGFjdGl2ZV9jaHVua3NfZ3JpZCk6DQogICAgICAgICAgICBpc19ub25f
#3#ZW1wdHkgPSBvY2N1cGFuY3lfdW5pb25baV0gPiBFU1NfTUlOX09DQ1VQQU5DWQ0KICAgICAgICAg
#3#ICAgaWYgaXNfbm9uX2VtcHR5Og0KICAgICAgICAgICAgICAgIG5vbl9lbXB0eV9jb3VudCArPSAx
#3#DQogICAgICAgICAgICBtYW5pZmVzdF9jaHVua3MuYXBwZW5kKHsNCiAgICAgICAgICAgICAgICAi
#3#aWQiOiBmIntjaFsnYnonXX1fe2NoWydieSddfV97Y2hbJ2J4J119IiwNCiAgICAgICAgICAgICAg
#3#ICAibWluIjogY2hbIm1pbiJdLA0KICAgICAgICAgICAgICAgICJtYXgiOiBjaFsibWF4Il0sDQog
#3#ICAgICAgICAgICAgICAgIm9jY3VwaWVkUmF0aW8iOiByb3VuZChvY2N1cGFuY3lfdW5pb25baV0s
#3#IDYpLA0KICAgICAgICAgICAgICAgICJub25FbXB0eSI6IGlzX25vbl9lbXB0eQ0KICAgICAgICAg
#3#ICAgfSkNCg0KICAgICAgICBsZXZlbHNfbWFuaWZlc3QuYXBwZW5kKHsNCiAgICAgICAgICAgICJs
#3#ZXZlbCI6IGxvZF9udW0sDQogICAgICAgICAgICAic2NhbGUiOiAxLjAgLyAoMiAqKiBsb2RfbnVt
#3#KSwNCiAgICAgICAgICAgICJkaW1lbnNpb25zIjogeyJ4IjogVywgInkiOiBILCAieiI6IER9LA0K
#3#ICAgICAgICAgICAgImJyaWNrU2l6ZSI6IEJSSUNLX1NJWkUsDQogICAgICAgICAgICAiZ3JpZFNp
#3#emUiOiB7IngiOiBueCwgInkiOiBueSwgInoiOiBuen0sDQogICAgICAgICAgICAiYnJpY2tDb3Vu
#3#dCI6IGxlbihjaHVua3NfZ3JpZCksDQogICAgICAgICAgICAiY2h1bmtzIjogbWFuaWZlc3RfY2h1
#3#bmtzLA0KICAgICAgICAgICAgIm5vbkVtcHR5Q291bnQiOiBub25fZW1wdHlfY291bnQNCiAgICAg
#3#ICAgfSkNCg0KICAgIGxvZDAgPSBuZXh0KChsaSBmb3IgbGkgaW4gbG9kX2xldmVscyBpZiBsaVsi
#3#bG9kIl0gPT0gMCksIE5vbmUpDQogICAgaWYgbG9kMCBpcyBub3QgTm9uZToNCiAgICAgICAgcGxh
#3#bmVzX3Jvb3QgPSBicmlja3NfZGlyLnBhcmVudCAvICJwbGFuZXMiDQogICAgICAgIHBsYW5lc19k
#3#aXIgPSBwbGFuZXNfcm9vdCAvIHRwX3N1YmRpciBpZiB0cF9zdWJkaXIgZWxzZSBwbGFuZXNfcm9v
#3#dA0KICAgICAgICBmaWxlcyA9IFt0ZW1wX2RpciAvIGYidHt0X2lkeDowM2R9X2N7Y31fbG9kMC5i
#3#aW4iIGZvciBjIGluIHJhbmdlKG5fY2gpXQ0KICAgICAgICB0YXNrcyA9IHBsYW5lc193cml0ZXIu
#3#cGxhbmVfdGFza3MoZmlsZXMsIChsb2QwWyJ3aWR0aCJdLCBsb2QwWyJoZWlnaHQiXSwgbG9kMFsi
#3#ZGVwdGgiXSksDQogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmlj
#3#a190b19wYWNrLCBwbGFuZXNfZGlyKQ0KICAgICAgICB3cml0dGVuID0gMA0KICAgICAgICBmb3Ig
#3#X3osIHNpemUgaW4gdHFkbShvcmRlcmVkX3Jlc3VsdHMoZXhlY3V0b3IsIHBsYW5lc19mbiwgdGFz
#3#a3MsIHdpbmRvdyksDQogICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRvdGFsPWxlbih0YXNr
#3#cyksIGRlc2M9IlBsYW5zIFhZIChQTkcpIiwgbGVhdmU9RmFsc2UsDQogICAgICAgICAgICAgICAg
#3#ICAgICAgICAgICAgIGFzY2lpPVRydWUsIG1pbmludGVydmFsPTIuMCk6DQogICAgICAgICAgICB3
#3#cml0dGVuICs9IHNpemUNCiAgICAgICAgcHJpbnQoZiJbUEFDS0VSXSB7dHBfc3ViZGlyIG9yICd0
#3#MDAwJ30gcGxhbnMgWFkgOiB7bGVuKHRhc2tzKX0gcGxhbihzKSwgIg0KICAgICAgICAgICAgICBm
#3#Int3cml0dGVuIC8gMWU2Oi4xZn0gTUIiKQ0KDQogICAgdHJhbnNwb3J0ID0gew0KICAgICAgICAi
#3#bW9kZSI6ICJwYWNrcyIsDQogICAgICAgICJlbmNvZGluZyI6ICJ3ZWJwLWxvc3NsZXNzIiwNCiAg
#3#ICAgICAgInBhY2tTaXplIjogQ0hVTktTX1BFUl9QQUNLLA0KICAgICAgICAiYnJpY2tUb1BhY2si
#3#OiBicmlja190b19wYWNrLA0KICAgICAgICAicGFja0hhc2hlcyI6IHBhY2tfaGFzaGVzDQogICAg
#3#fQ0KICAgIHJldHVybiBsZXZlbHNfbWFuaWZlc3QsIHRyYW5zcG9ydA0KDQoNCmRlZiBoaXN0b2dy
#3#YW1zX2Zvcl90aW1lcG9pbnQodGVtcF9kaXI6IFBhdGgsIHRfaWR4OiBpbnQsIG5fY2g6IGludCwg
#3#bG9kX251bTogaW50KToNCiAgICAiIiJQZXItY2hhbm5lbCA2NC1iaW4gaGlzdG9ncmFtIG9mIG9u
#3#ZSB0aW1lcG9pbnQsIG9uIGl0cyBjb2Fyc2VzdCBMT0QuIiIiDQogICAgb3V0ID0gW10NCiAgICBm
#3#b3IgY19pZHggaW4gcmFuZ2Uobl9jaCk6DQogICAgICAgIGJpbl9maWxlID0gdGVtcF9kaXIgLyBm
#3#InR7dF9pZHg6MDNkfV9je2NfaWR4fV9sb2R7bG9kX251bX0uYmluIg0KICAgICAgICBpZiBiaW5f
#3#ZmlsZS5leGlzdHMoKToNCiAgICAgICAgICAgIHZvbF9kYXRhID0gbnAuZnJvbWZpbGUoc3RyKGJp
#3#bl9maWxlKSwgZHR5cGU9bnAudWludDgpDQogICAgICAgICAgICBjb3VudHMsIGVkZ2VzID0gbnAu
#3#aGlzdG9ncmFtKHZvbF9kYXRhLCBiaW5zPTY0LCByYW5nZT0oMCwgMjU1KSkNCg0KICAgICAgICAg
#3#ICAgbWVhbl92YWwgPSBmbG9hdCh2b2xfZGF0YS5tZWFuKCkpIGlmIHZvbF9kYXRhLnNpemUgZWxz
#3#ZSAwLjANCiAgICAgICAgICAgIHN0ZF92YWwgPSBmbG9hdCh2b2xfZGF0YS5zdGQoKSkgaWYgdm9s
#3#X2RhdGEuc2l6ZSBlbHNlIDAuMA0KICAgICAgICAgICAgbWF4X3ZhbCA9IGludCh2b2xfZGF0YS5t
#3#YXgoKSkgaWYgdm9sX2RhdGEuc2l6ZSBlbHNlIDANCg0KICAgICAgICAgICAgb3V0LmFwcGVuZCh7
#3#DQogICAgICAgICAgICAgICAgImNvdW50cyI6IGNvdW50cy5hc3R5cGUobnAuaW50NjQpLnRvbGlz
#3#dCgpLA0KICAgICAgICAgICAgICAgICJlZGdlcyI6IGVkZ2VzLmFzdHlwZShucC5mbG9hdDY0KS50
#3#b2xpc3QoKSwNCiAgICAgICAgICAgICAgICAidG90YWwiOiBpbnQodm9sX2RhdGEuc2l6ZSksDQog
#3#ICAgICAgICAgICAgICAgIm1heCI6IG1heF92YWwsDQogICAgICAgICAgICAgICAgIm1lYW4iOiBt
#3#ZWFuX3ZhbCwNCiAgICAgICAgICAgICAgICAic3RkIjogc3RkX3ZhbCwNCiAgICAgICAgICAgICAg
#3#ICAiYmFja2dyb3VuZEZsb29yIjogMA0KICAgICAgICAgICAgfSkNCiAgICAgICAgICAgIGRlbCB2
#3#b2xfZGF0YQ0KICAgICAgICBlbHNlOg0KICAgICAgICAgICAgcHJpbnQoZiJbV0FSTklOR10gQmlu
#3#IGZpbGUgZm9yIGhpc3RvZ3JhbSBub3QgZm91bmQ6IHtiaW5fZmlsZX0iKQ0KICAgICAgICAgICAg
#3#b3V0LmFwcGVuZCh7DQogICAgICAgICAgICAgICAgImNvdW50cyI6IFswXSAqIDY0LA0KICAgICAg
#3#ICAgICAgICAgICJlZGdlcyI6IGxpc3QocmFuZ2UoNjUpKSwNCiAgICAgICAgICAgICAgICAidG90
#3#YWwiOiAwLA0KICAgICAgICAgICAgICAgICJtYXgiOiAwLA0KICAgICAgICAgICAgICAgICJtZWFu
#3#IjogMC4wLA0KICAgICAgICAgICAgICAgICJzdGQiOiAwLjAsDQogICAgICAgICAgICAgICAgImJh
#3#Y2tncm91bmRGbG9vciI6IDANCiAgICAgICAgICAgIH0pDQogICAgcmV0dXJuIG91dA0KDQoNCmRl
#3#ZiBidWlsZF9wYWNrcyh0ZW1wX2RpcjogUGF0aCwgb3V0cHV0X2RpcjogUGF0aCk6DQogICAgcHJv
#3#Y19tZXRhID0gcmVhZF9qc29uX2ZpbGUodGVtcF9kaXIgLyAicHJvY2Vzc2luZ19tZXRhLmpzb24i
#3#KQ0KICAgIGlmIG5vdCBwcm9jX21ldGE6DQogICAgICAgIHJhaXNlIEZpbGVOb3RGb3VuZEVycm9y
#3#KGYie3RlbXBfZGlyIC8gJ3Byb2Nlc3NpbmdfbWV0YS5qc29uJ30gYWJzZW50IG91IGlsbGlzaWJs
#3#ZSIpDQoNCiAgICBsb2RfbGV2ZWxzID0gcHJvY19tZXRhWyJsb2RfbGV2ZWxzIl0NCiAgICBuX2No
#3#ID0gcHJvY19tZXRhWyJuX2NoYW5uZWxzIl0NCiAgICBuX3RwID0gcHJvY19tZXRhWyJuX3RpbWVw
#3#b2ludHMiXQ0KICAgIHZveGVsX3NpemUgPSBwcm9jX21ldGFbInZveGVsX3NpemUiXQ0KDQogICAg
#3#YnJpY2tzX2RpciA9IG91dHB1dF9kaXIgLyAiYnJpY2tzIg0KICAgIGJyaWNrc19kaXIubWtkaXIo
#3#cGFyZW50cz1UcnVlLCBleGlzdF9vaz1UcnVlKQ0KDQogICAgaXNfdGltZWxhcHNlID0gbl90cCA+
#3#IDENCiAgICBjb2Fyc2VzdCA9IGxvZF9sZXZlbHNbLTFdWyJsb2QiXQ0KDQogICAgIyBBIHRpbWVw
#3#b2ludCBzdGVwIDIgYWxyZWFkeSBwYWNrZWQgKC0tcGFjay1pbnRvKSBpcyBvbmx5IGluZGV4ZWQg
#3#aGVyZTsgYW55dGhpbmcNCiAgICAjIGVsc2UgaXMgcGFja2VkIG5vdywgdGhyb3VnaCBvbmUgcHJv
#3#Y2VzcyBwb29sIGZvciB0aGUgd2hvbGUgcnVuLg0KICAgIGV4ZWN1dG9yID0gTm9uZQ0KICAgIHBl
#3#cl90cCA9IFtdDQogICAgdHJ5Og0KICAgICAgICBmb3IgdF9pZHggaW4gcmFuZ2Uobl90cCk6DQog
#3#ICAgICAgICAgICBrZXkgPSBmInR7dF9pZHg6MDNkfSINCiAgICAgICAgICAgIHBhY2tlZCA9IHJl
#3#YWRfanNvbl9maWxlKHRlbXBfZGlyIC8gZiJwYWNrX3trZXl9Lmpzb24iKQ0KICAgICAgICAgICAg
#3#aWYgcGFja2VkOg0KICAgICAgICAgICAgICAgIGxldmVscywgdHJhbnNwb3J0ID0gcGFja2VkWyJs
#3#ZXZlbHMiXSwgcGFja2VkWyJicmlja1RyYW5zcG9ydCJdDQogICAgICAgICAgICBlbHNlOg0KICAg
#3#ICAgICAgICAgICAgIGlmIGV4ZWN1dG9yIGlzIE5vbmU6DQogICAgICAgICAgICAgICAgICAgIGV4
#3#ZWN1dG9yID0gUHJvY2Vzc1Bvb2xFeGVjdXRvcihtYXhfd29ya2Vycz13b3JrZXJfY291bnQoKSkN
#3#CiAgICAgICAgICAgICAgICBpZiBpc190aW1lbGFwc2U6DQogICAgICAgICAgICAgICAgICAgIHBy
#3#aW50KGYiW1BBQ0tFUl0gPT09IHRpbWVwb2ludCB7dF9pZHggKyAxfS97bl90cH0gKHtrZXl9KSA9
#3#PT0iKQ0KICAgICAgICAgICAgICAgIGxldmVscywgdHJhbnNwb3J0ID0gcGFja190aW1lcG9pbnQo
#3#dGVtcF9kaXIsIGJyaWNrc19kaXIsIHRfaWR4LCBsb2RfbGV2ZWxzLA0KICAgICAgICAgICAgICAg
#3#ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbl9jaCwgZXhlY3V0b3IsIGtleSBp
#3#ZiBpc190aW1lbGFwc2UgZWxzZSAiIikNCiAgICAgICAgICAgIHBlcl90cC5hcHBlbmQoKGtleSwg
#3#bGV2ZWxzLCB0cmFuc3BvcnQsDQogICAgICAgICAgICAgICAgICAgICAgICAgICBoaXN0b2dyYW1z
#3#X2Zvcl90aW1lcG9pbnQodGVtcF9kaXIsIHRfaWR4LCBuX2NoLCBjb2Fyc2VzdCkpKQ0KICAgIGZp
#3#bmFsbHk6DQogICAgICAgIGlmIGV4ZWN1dG9yIGlzIG5vdCBOb25lOg0KICAgICAgICAgICAgZXhl
#3#Y3V0b3Iuc2h1dGRvd24oKQ0KDQogICAgaWYgbm90IGlzX3RpbWVsYXBzZToNCiAgICAgICAgXywg
#3#bGV2ZWxzX21hbmlmZXN0LCB0cmFuc3BvcnQsIGhpc3RvZ3JhbXMgPSBwZXJfdHBbMF0NCiAgICAg
#3#ICAgdGltZXBvaW50c19tYW5pZmVzdCA9IE5vbmUNCiAgICBlbHNlOg0KICAgICAgICB0aW1lcG9p
#3#bnRzX21hbmlmZXN0ID0ge30NCiAgICAgICAgZm9yIGtleSwgbGV2ZWxzLCB0cF90cmFuc3BvcnQs
#3#IGhpc3QgaW4gcGVyX3RwOg0KICAgICAgICAgICAgIyBBIHRpbWVsYXBzZSBjYXJyaWVzIG9uZSBo
#3#aXN0b2dyYW0gc2V0IHBlciBmcmFtZTogdGhlIGNoYW5uZWwgcGFuZWwgcmVhZHMNCiAgICAgICAg
#3#ICAgICMgdGhlIHJvdyBvZiB0aGUgdGltZXBvaW50IG9uIHNjcmVlbiwgYW5kIGEgc2hhcmVkIHNl
#3#dCB3b3VsZCBtaXMtc2NhbGUgdGhlDQogICAgICAgICAgICAjIHNsaWRlcnMgYXMgdGhlIHNwZWNp
#3#bWVuIGJsZWFjaGVzLg0KICAgICAgICAgICAgdGltZXBvaW50c19tYW5pZmVzdFtrZXldID0gew0K
#3#ICAgICAgICAgICAgICAgICJwYXRoIjoga2V5LA0KICAgICAgICAgICAgICAgICJjaGFubmVscyI6
#3#IG5fY2gsDQogICAgICAgICAgICAgICAgImxldmVscyI6IGxldmVscywNCiAgICAgICAgICAgICAg
#3#ICAiYnJpY2tUcmFuc3BvcnQiOiB0cF90cmFuc3BvcnQsDQogICAgICAgICAgICAgICAgImhpc3Rv
#3#Z3JhbXMiOiBoaXN0DQogICAgICAgICAgICB9DQogICAgICAgICMgTWlycm9yZWQgYXQgdGhlIHRv
#3#cCBsZXZlbCBzbyBhIGNvbnN1bWVyIHRoYXQgaWdub3JlcyBgdGltZXBvaW50c2Agc3RpbGwNCiAg
#3#ICAgICAgIyBtb3VudHMgYSBjb2hlcmVudCAoZmlyc3QtZnJhbWUpIGRhdGFzZXQgaW5zdGVhZCBv
#3#ZiBmYWlsaW5nLg0KICAgICAgICBfLCBsZXZlbHNfbWFuaWZlc3QsIHRyYW5zcG9ydCwgaGlzdG9n
#3#cmFtcyA9IHBlcl90cFswXQ0KDQogICAgbWFuaWZlc3QgPSB7DQogICAgICAgICJ2ZXJzaW9uIjog
#3#MiwNCiAgICAgICAgInNjaGVtYSI6ICJpcmliaG0tYnJpY2tzLXYyIiwNCiAgICAgICAgImRhdGFz
#3#ZXQiOiBvdXRwdXRfZGlyLm5hbWUsDQogICAgICAgICJkYXRhc2V0VHlwZSI6ICJsaXZlIiBpZiBp
#3#c190aW1lbGFwc2UgZWxzZSAiM2QiLA0KICAgICAgICAiY2hhbm5lbHMiOiBuX2NoLA0KICAgICAg
#3#ICAiYnJpY2tTaXplIjogQlJJQ0tfU0laRSwNCiAgICAgICAgImJyaWNrUGFja2luZyI6IHsibW9k
#3#ZSI6ICJncmlkIiwgImNvbHMiOiA4LCAicm93cyI6IDh9LA0KICAgICAgICAidm94ZWxTaXplIjog
#3#dm94ZWxfc2l6ZSwNCiAgICAgICAgImNyZWF0ZWRBdCI6IF9faW1wb3J0X18oImRhdGV0aW1lIiku
#3#ZGF0ZXRpbWUubm93KCkuaXNvZm9ybWF0KCksDQogICAgICAgICJsZXZlbHMiOiBsZXZlbHNfbWFu
#3#aWZlc3QsDQogICAgICAgICJoaXN0b2dyYW1zIjogaGlzdG9ncmFtcywNCiAgICAgICAgImhhc2hl
#3#cyI6IHt9LCAgICAgIyBMZWZ0IGVtcHR5IGFzIHdlIHVzZSBwYWNrIHRyYW5zcG9ydA0KICAgICAg
#3#ICAidGltZXBvaW50cyI6IHRpbWVwb2ludHNfbWFuaWZlc3QsDQogICAgICAgICJicmlja1RyYW5z
#3#cG9ydCI6IHRyYW5zcG9ydA0KICAgIH0NCg0KICAgICMgQ29tcGFjdDogdGhlIGJyb3dzZXIgZG93
#3#bmxvYWRzIGFuZCBwYXJzZXMgdGhlIG1hbmlmZXN0IGJlZm9yZSB0aGUgZmlyc3QgZnJhbWUsDQog
#3#ICAgIyBhbmQgaW5kZW50YXRpb24gYWxvbmUgZG91YmxlZCBpdCAoMjMgTUIgLT4gMTEgTUIgb24g
#3#dGhlIGxhcmdlc3QgZGF0YXNldCkuDQogICAgbWFuaWZlc3RfcGF0aCA9IGJyaWNrc19kaXIgLyAi
#3#bWFuaWZlc3QuanNvbiINCiAgICBhdG9taWNfd3JpdGVfanNvbihtYW5pZmVzdF9wYXRoLCBtYW5p
#3#ZmVzdCwgc2VwYXJhdG9ycz0oIiwiLCAiOiIpKQ0KDQogICAgc2l6ZV9tYiA9IG1hbmlmZXN0X3Bh
#3#dGguc3RhdCgpLnN0X3NpemUgLyAxZTYNCiAgICBwcmludChmIltQQUNLRVJdIFdyb3RlIG1hbmlm
#3#ZXN0Lmpzb24gdG8ge21hbmlmZXN0X3BhdGh9ICh7c2l6ZV9tYjouMmZ9IE1CKSIpDQogICAgcGxh
#3#bmVzX3dyaXRlci53cml0ZV9tYW5pZmVzdHMob3V0cHV0X2RpcikNCiAgICBwcmludChmIltQQUNL
#3#RVJdIHBsYW5lcy8gOiBtYW5pZmVzdChzKSBlY3JpdChzKSwgZm9ybWF0IHtwbGFuZXNfd3JpdGVy
#3#LkZPUk1BVF9WRVJTSU9OfSIpDQogICAgaWYgaXNfdGltZWxhcHNlOg0KICAgICAgICBwcmludChm
#3#IltQQUNLRVJdIHtuX3RwfSB0aW1lcG9pbnRzIGluZGV4ZWQiKQ0KDQoNCmlmIF9fbmFtZV9fID09
#3#ICJfX21haW5fXyI6DQogICAgaWYgbGVuKHN5cy5hcmd2KSA8IDM6DQogICAgICAgIHByaW50KCJV
#3#c2FnZTogcHl0aG9uIDMtY2h1bmtfcGFja2VyLnB5IDx0ZW1wX2Rpcj4gPG91dHB1dF9kaXI+IikN
#3#CiAgICAgICAgc3lzLmV4aXQoMSkNCg0KICAgIHRlbXBfZGlyID0gUGF0aChzeXMuYXJndlsxXSkN
#3#CiAgICBvdXRwdXRfZGlyID0gUGF0aChzeXMuYXJndlsyXSkNCg0KICAgIHRyeToNCiAgICAgICAg
#3#YnVpbGRfcGFja3ModGVtcF9kaXIsIG91dHB1dF9kaXIpDQogICAgICAgIHByaW50KGYiW1BBQ0tF
#3#Ul0gQ2h1bmsgcGFja2FnaW5nIGNvbXBsZXRlLiIpDQogICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBl
#3#Og0KICAgICAgICBpbXBvcnQgdHJhY2ViYWNrDQogICAgICAgIHRyYWNlYmFjay5wcmludF9leGMo
#3#KQ0KICAgICAgICBwcmludChmIltFUlJPUl0gQ2h1bmsgcGFja2FnaW5nIGZhaWxlZDoge2V9Iiwg
#3#ZmlsZT1zeXMuc3RkZXJyKQ0KICAgICAgICBzeXMuZXhpdCgxKQ0K
:: ---- [4] 4-catalog_generator.py (14497 octets) ----
#4#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMw0KaW1wb3J0IGFyZ3BhcnNlDQppbXBvcnQganNvbg0KaW1w
#4#b3J0IHJlDQppbXBvcnQgc3lzDQpmcm9tIGRhdGV0aW1lIGltcG9ydCBkYXRldGltZQ0KZnJvbSBw
#4#YXRobGliIGltcG9ydCBQYXRoDQoNCkhFUkUgPSBQYXRoKF9fZmlsZV9fKS5yZXNvbHZlKCkucGFy
#4#ZW50DQppZiBzdHIoSEVSRSkgbm90IGluIHN5cy5wYXRoOg0KICAgIHN5cy5wYXRoLmluc2VydCgw
#4#LCBzdHIoSEVSRSkpDQpmcm9tIHJ1bl9wcmVwcm9jZXNzIGltcG9ydCBtZXJnZV9jdXJhdGVkLCBh
#4#dG9taWNfd3JpdGVfanNvbiwgcmVhZF9qc29uX2ZpbGUgICMgbm9xYTogRTQwMg0KaW1wb3J0IHBs
#4#YW5lc193cml0ZXIgICMgbm9xYTogRTQwMg0KDQpDT0xPUlMgPSBbIiMwMEZGMDAiLCAiIzAwQUFG
#4#RiIsICIjRkYwMEZGIiwgIiNGRjAwMDAiLCAiI0ZGRkYwMCIsICIjMDBGRkZGIl0NCg0KIyBFbWJy
#4#eW9uaWMtZGF5IHRva2VuIG9mIHRoZSBsYWIncyBmaWxlIG5hbWVzLCBhZnRlciBhIHNlcGFyYXRv
#4#ciAob3IgYXQgdGhlIHN0YXJ0KToNCiMgICBFOC01LCBFMTAtNSAgICAgICAgZGF5LCBkYXNoLCBm
#4#cmFjdGlvbiBkaWdpdHMgICAgICAtPiBFOC41LCBFMTAuNQ0KIyAgIEUxMC41LCBFOCwyNSAgICAg
#4#ICBkYXksIGRvdC9jb21tYSwgZnJhY3Rpb24gZGlnaXRzIC0+IEUxMC41LCBFOC4yNQ0KIyAgIEU4
#4#NSwgRTgyNSwgRTEwNSAgICBjb21wYWN0IGRpZ2l0cyAgICAgICAgICAgICAgICAgIC0+IEU4LjUs
#4#IEU4LjI1LCBFMTAuNQ0KIyAgIEU4LCBFMTAgICAgICAgICAgICBhIHdob2xlIGRheSAgICAgICAg
#4#ICAgICAgICAgICAgIC0+IEU4LCBFMTANCiMgTW91c2UgZGV2ZWxvcG1lbnQgcnVucyB0byBFMTks
#4#IHNvIGEgY29tcGFjdCB0b2tlbiBzdGFydGluZyB3aXRoIDEwLTE5IGlzIGEgdHdvLWRpZ2l0DQoj
#4#IGRheSAoRTEwNSA9IEUxMC41LCBFMTIgPSBFMTIpOyBhbnkgb3RoZXIgaXMgYSBvbmUtZGlnaXQg
#4#ZGF5IGZvbGxvd2VkIGJ5IGl0cyBmcmFjdGlvbg0KIyAoRTk1ID0gRTkuNSwgRTgwID0gRTguMCku
#4#IEFmdGVyIGEgZGFzaCBvbmx5IHRoZSBmcmFjdGlvbnMgYSBzdGFnZSBpcyBhY3R1YWxseSB3cml0
#4#dGVuDQojIHdpdGggKC4yNSwgLjUsIC43NSkgYXJlIHJlYWQgYXMgb25lOiBpbiAiRTgtMS1EQVBJ
#4#IiBvciAiRTk1LTItLi4uIiB0aGUgbnVtYmVyIGFmdGVyIHRoZQ0KIyBzdGFnZSBpcyB0aGUgZW1i
#4#cnlvLCBhcyB0aGUgbGFiJ3Mgb3duIGN1cmF0aW9uIG9mIHRob3NlIGRhdGFzZXRzIHJlY29yZHMg
#4#aXQuDQpfU1RBR0VfUlggPSByZS5jb21waWxlKHIiKD86XnxbLV8gXSlFKFxkezEsM30pKD86KFsu
#4#LF0pKFxkezEsMn0pfC0oMjV8NXw3NSkpPyg/PSR8Wy1fIF0pIiwNCiAgICAgICAgICAgICAgICAg
#4#ICAgICAgcmUuSUdOT1JFQ0FTRSkNCl9FTUJSWU9fUlggPSByZS5jb21waWxlKHIiKD86XnxbLV8g
#4#XSkoRW1cZCspKD89JHxbLV8gXSkiLCByZS5JR05PUkVDQVNFKQ0KX1NUQUdFX0VNQlJZT19OVU1C
#4#RVJfUlggPSByZS5jb21waWxlKHIiKD86XnxbLV8gXSlFW1xkLixdKy0oXGR7MSwyfSkoPz0kfFst
#4#XyBdKSIsIHJlLklHTk9SRUNBU0UpDQoNCg0KZGVmIF9zcGxpdF9jb21wYWN0KGRpZ2l0czogc3Ry
#4#KToNCiAgICBpZiBsZW4oZGlnaXRzKSA9PSAxOg0KICAgICAgICByZXR1cm4gZGlnaXRzLCAiIg0K
#4#ICAgIGlmIGRpZ2l0c1swXSA9PSAiMSIgYW5kIGxlbihkaWdpdHMpID49IDI6DQogICAgICAgIHJl
#4#dHVybiBkaWdpdHNbOjJdLCBkaWdpdHNbMjpdDQogICAgcmV0dXJuIGRpZ2l0c1swXSwgZGlnaXRz
#4#WzE6XQ0KDQoNCmRlZiBfcGFyc2Vfc3RhZ2UobmFtZTogc3RyKToNCiAgICAiIiIoZGlzcGxheSwg
#4#bnVtZXJpYykgb2YgdGhlIGVtYnJ5b25pYyBkYXkgZW5jb2RlZCBpbiBhIGRhdGFzZXQgbmFtZSwg
#4#b3INCiAgICAoIlVua25vd24iLCAwLjApIHdoZW4gdGhlIG5hbWUgY2FycmllcyBub25lLiIiIg0K
#4#ICAgIG0gPSBfU1RBR0VfUlguc2VhcmNoKG5hbWUpDQogICAgaWYgbm90IG06DQogICAgICAgIHJl
#4#dHVybiAiVW5rbm93biIsIDAuMA0KICAgIGRpZ2l0cywgc2VwLCBzZXBfZnJhYywgZGFzaF9mcmFj
#4#ID0gbS5ncm91cHMoKQ0KICAgIGlmIHNlcDoNCiAgICAgICAgZGF5LCBmcmFjID0gZGlnaXRzLCBz
#4#ZXBfZnJhYw0KICAgIGVsaWYgZGFzaF9mcmFjOg0KICAgICAgICBkYXksIGZyYWMgPSBkaWdpdHMs
#4#IGRhc2hfZnJhYw0KICAgIGVsc2U6DQogICAgICAgIGRheSwgZnJhYyA9IF9zcGxpdF9jb21wYWN0
#4#KGRpZ2l0cykNCiAgICBkYXkgPSBzdHIoaW50KGRheSkpDQogICAgZGlzcGxheSA9IGYiRXtkYXl9
#4#LntmcmFjfSIgaWYgZnJhYyBlbHNlIGYiRXtkYXl9Ig0KICAgIHJldHVybiBkaXNwbGF5LCBmbG9h
#4#dChmIntkYXl9LntmcmFjfSIpIGlmIGZyYWMgZWxzZSBmbG9hdChkYXkpDQoNCg0KZGVmIF9wYXJz
#4#ZV9lbWJyeW8obmFtZTogc3RyKToNCiAgICAiIiJFbWJyeW8gbGFiZWw6IGFuIGV4cGxpY2l0IGBF
#4#bTxuPmAgdG9rZW4gYW55d2hlcmUgaW4gdGhlIG5hbWUsIGVsc2UgdGhlIG51bWJlcg0KICAgIHRo
#4#YXQgZGlyZWN0bHkgZm9sbG93cyB0aGUgc3RhZ2UgKGBFOTUtMS0uLi5gIGlzIGVtYnJ5byAxKS4i
#4#IiINCiAgICBtID0gX0VNQlJZT19SWC5zZWFyY2gobmFtZSkNCiAgICBpZiBtOg0KICAgICAgICBy
#4#ZXR1cm4gbS5ncm91cCgxKQ0KICAgIHN0YWdlID0gX1NUQUdFX1JYLnNlYXJjaChuYW1lKQ0KICAg
#4#IGlmIHN0YWdlIGFuZCBub3Qgc3RhZ2UuZ3JvdXAoNCk6DQogICAgICAgIG4gPSBfU1RBR0VfRU1C
#4#UllPX05VTUJFUl9SWC5zZWFyY2gobmFtZSwgc3RhZ2Uuc3RhcnQoKSkNCiAgICAgICAgaWYgbiBh
#4#bmQgbi5zdGFydCgpID09IHN0YWdlLnN0YXJ0KCk6DQogICAgICAgICAgICByZXR1cm4gZiJFbXtp
#4#bnQobi5ncm91cCgxKSl9Ig0KICAgIHJldHVybiBOb25lDQoNCg0KZGVmIF9jYWxpYnJhdGVkKHZz
#4#KSAtPiBib29sOg0KICAgIHJldHVybiBpc2luc3RhbmNlKHZzLCBkaWN0KSBhbmQgYWxsKGlzaW5z
#4#dGFuY2UodnMuZ2V0KGEpLCAoaW50LCBmbG9hdCkpIGFuZCB2cy5nZXQoYSkgPiAwDQogICAgICAg
#4#ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9yIGEgaW4gKCJ4IiwgInkiLCAieiIp
#4#KQ0KDQoNCmRlZiBtZXJnZV9jaGFubmVscyhleGlzdGluZywgZnJlc2gpOg0KICAgICIiIkRpc3Bs
#4#YXkgc2V0dGluZ3MgdGhlIGxhYiBjaG9zZSBwZXIgY2hhbm5lbCAoY29sb3VyLCB3aW5kb3csIGdh
#4#bW1hLCBuYW1lKSBzdXJ2aXZlIGENCiAgICByZS1ydW4gYXMgbG9uZyBhcyB0aGUgYWNxdWlzaXRp
#4#b24gc3RpbGwgaGFzIHRoZSBzYW1lIG51bWJlciBvZiBjaGFubmVsczsgYSBjaGFuZ2VkDQogICAg
#4#Y2hhbm5lbCBzZXQgc3RhcnRzIGZyb20gdGhlIGRlZmF1bHRzLCBzaW5jZSB0aGUgb2xkIHNldHRp
#4#bmdzIGJlbG9uZyB0byBvdGhlciBkYXRhLiIiIg0KICAgIGlmIG5vdCBpc2luc3RhbmNlKGV4aXN0
#4#aW5nLCBsaXN0KSBvciBsZW4oZXhpc3RpbmcpICE9IGxlbihmcmVzaCk6DQogICAgICAgIHJldHVy
#4#biBmcmVzaA0KICAgIG1lcmdlZCA9IFtdDQogICAgZm9yIG9sZCwgbmV3IGluIHppcChleGlzdGlu
#4#ZywgZnJlc2gpOg0KICAgICAgICBtZXJnZWQuYXBwZW5kKHsqKm5ldywgKipvbGR9IGlmIGlzaW5z
#4#dGFuY2Uob2xkLCBkaWN0KSBlbHNlIG5ldykNCiAgICByZXR1cm4gbWVyZ2VkDQoNCg0KQ0FMSUJS
#4#QVRJT05fS0VZUyA9ICgidm94ZWxfc2l6ZSIsICJwaHlzaWNhbFNpemVVbSIsICJvcHRpY2FsX3Nl
#4#Y3Rpb25fdGhpY2tuZXNzX3VtIiwNCiAgICAgICAgICAgICAgICAgICAgImNhbGlicmF0aW9uU3Rh
#4#dHVzIiwgImNhbGlicmF0aW9uTm90ZSIpDQoNCg0KZGVmIG1lcmdlX3ZvbHVtZV9tZXRhZGF0YShl
#4#eGlzdGluZzogZGljdCwgZnJlc2g6IGRpY3QpIC0+IGRpY3Q6DQogICAgIiIibWV0YWRhdGEuanNv
#4#biBvZiBhIHJlLXByb2Nlc3NlZCB2b2x1bWU6IG1lYXN1cmVkIGZhY3RzIGZyb20gdGhpcyBydW4s
#4#IHRoZSBsYWIncw0KICAgIGN1cmF0aW9uIGZyb20gdGhlIHB1Ymxpc2hlZCBmaWxlIChzZWUgcnVu
#4#X3ByZXByb2Nlc3MuQ1VSQVRFRF9LRVlTKS4iIiINCiAgICBtZXJnZWQgPSBtZXJnZV9jdXJhdGVk
#4#KGV4aXN0aW5nLCBmcmVzaCkNCiAgICBpZiBub3QgZXhpc3Rpbmc6DQogICAgICAgIHJldHVybiBt
#4#ZXJnZWQNCiAgICBtZXJnZWRbImNoYW5uZWxzIl0gPSBtZXJnZV9jaGFubmVscyhleGlzdGluZy5n
#4#ZXQoImNoYW5uZWxzIiksIGZyZXNoLmdldCgiY2hhbm5lbHMiKSBvciBbXSkNCiAgICAjIEEgZmls
#4#ZSB3aXRob3V0IGNhbGlicmF0aW9uIGNhbm5vdCBtZWFzdXJlIGl0OiBhIGNhbGlicmF0aW9uIHRo
#4#ZSBvcGVyYXRvciBlbnRlcmVkIGJ5DQogICAgIyBoYW5kIGlzIGtlcHQgcmF0aGVyIHRoYW4gcmVw
#4#bGFjZWQgYnkgIm1pc3NpbmciLiBUaGUgMS9OIHVtICJ2b3hlbCIgZWFybGllciB2ZXJzaW9ucw0K
#4#ICAgICMgZGVyaXZlZCBmcm9tIGEgbWlzc2luZyBleHRlbnQgKGFuZCBsYWJlbGxlZCBleGFjdCkg
#4#aXMgbm90IG9uZS4NCiAgICB2cyA9IGV4aXN0aW5nLmdldCgidm94ZWxfc2l6ZSIpDQogICAgZGlt
#4#cyA9IGZyZXNoLmdldCgiZGltZW5zaW9ucyIpIG9yIHt9DQogICAgcGxhY2Vob2xkZXIgPSBfY2Fs
#4#aWJyYXRlZCh2cykgYW5kIGFsbCgNCiAgICAgICAgZGltcy5nZXQoYSkgYW5kIGFicyh2c1thXSAt
#4#IHJvdW5kKDEuMCAvIGRpbXNbYV0sIDYpKSA8IDFlLTEyIGZvciBhIGluICgieCIsICJ5IiwgInoi
#4#KSkNCiAgICBpZiAoZnJlc2guZ2V0KCJjYWxpYnJhdGlvblN0YXR1cyIpID09ICJtZXRhZGF0YS1t
#4#aXNzaW5nIiBhbmQgX2NhbGlicmF0ZWQodnMpDQogICAgICAgICAgICBhbmQgbm90IHBsYWNlaG9s
#4#ZGVyKToNCiAgICAgICAgZm9yIGtleSBpbiBDQUxJQlJBVElPTl9LRVlTOg0KICAgICAgICAgICAg
#4#aWYga2V5IGluIGV4aXN0aW5nOg0KICAgICAgICAgICAgICAgIG1lcmdlZFtrZXldID0gZXhpc3Rp
#4#bmdba2V5XQ0KICAgIHJldHVybiBtZXJnZWQNCg0KDQpkZWYgZ2VuZXJhdGVfY2F0YWxvZ19tZXRh
#4#ZGF0YSh0ZW1wX2RpcjogUGF0aCwgb3V0cHV0X2RpcjogUGF0aCwgZXhpc3RpbmdfcGF0aDogUGF0
#4#aCA9IE5vbmUsDQogICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkaXNwbGF5X25hbWU6IHN0
#4#ciA9IE5vbmUpOg0KICAgIHdpdGggb3Blbih0ZW1wX2RpciAvICJwcm9jZXNzaW5nX21ldGEuanNv
#4#biIsICJyIiwgZW5jb2Rpbmc9InV0Zi04IikgYXMgZm06DQogICAgICAgIHByb2NfbWV0YSA9IGpz
#4#b24ubG9hZChmbSkNCg0KICAgIGxvZF9sZXZlbHMgPSBwcm9jX21ldGFbImxvZF9sZXZlbHMiXQ0K
#4#ICAgIG5fY2ggPSBwcm9jX21ldGFbIm5fY2hhbm5lbHMiXQ0KICAgIG5fdHAgPSBwcm9jX21ldGFb
#4#Im5fdGltZXBvaW50cyJdDQogICAgdm94ZWxfc2l6ZSA9IHByb2NfbWV0YVsidm94ZWxfc2l6ZSJd
#4#DQogICAgY2hhbm5lbF9uYW1lcyA9IHByb2NfbWV0YVsiY2hhbm5lbF9uYW1lcyJdDQogICAgVyA9
#4#IHByb2NfbWV0YVsid2lkdGgiXQ0KICAgIEggPSBwcm9jX21ldGFbImhlaWdodCJdDQogICAgRCA9
#4#IHByb2NfbWV0YVsiZGVwdGgiXQ0KDQogICAgIyBUaGUgZm9sZGVyIGlzIHRoZSBkYXRhc2V0J3Mg
#4#aWQ7IHRoZSBuYW1lIHNob3duIGRlZmF1bHRzIHRvIHRoZSBzb3VyY2UgZmlsZSdzIG93bg0KICAg
#4#ICMgbmFtZSwgd2hpY2ggdGhlIGZvbGRlciBtYXkgaGF2ZSBoYWQgdG8gc2FuaXRpc2UuDQogICAg
#4#ZGF0YXNldF9uYW1lID0gb3V0cHV0X2Rpci5uYW1lDQogICAgc2hvd25fbmFtZSA9IGRpc3BsYXlf
#4#bmFtZSBvciBkYXRhc2V0X25hbWUNCiAgICBzdGFnZSwgc3RhZ2VfbnVtID0gX3BhcnNlX3N0YWdl
#4#KHNob3duX25hbWUpDQogICAgZW1icnlvID0gX3BhcnNlX2VtYnJ5byhzaG93bl9uYW1lKQ0KDQog
#4#ICAgIyBUaGUgZGlyZWN0b3J5IGEgZGF0YXNldCBzaXRzIGluIElTIGl0cyB0eXBlICgnM2QnLCAn
#4#bGl2ZScpLCBzbyB0aGUgdHlwZSwgdGhlIGlkDQogICAgIyBhbmQgdGhlIGJ5dGUgcGF0aCBhbGwg
#4#ZGVyaXZlIGZyb20gdGhlIHNhbWUgc3RyaW5nLg0KICAgIGRhdGFzZXRfdHlwZSA9IG91dHB1dF9k
#4#aXIucGFyZW50Lm5hbWUNCiAgICByZWxfcGF0aF9zdHIgPSBmIkRBVEFfV0VCL3tkYXRhc2V0X3R5
#4#cGV9L3tkYXRhc2V0X25hbWV9Ig0KDQogICAgIyBIaXN0b2dyYW1zIGFyZSB3cml0dGVuIGJ5IHN0
#4#ZXAgMyB3aXRoIHRoZSBtYW5pZmVzdC4gQSBtYW5pZmVzdCBwcm9kdWNlZCBieSBhbg0KICAgICMg
#4#b2xkZXIgc3RlcCAzIHN0aWxsIGhhcyBhbiBlbXB0eSBsaXN0OyBpdCBpcyBjb21wbGV0ZWQgaGVy
#4#ZS4NCiAgICBtYW5pZmVzdF9wYXRoID0gb3V0cHV0X2RpciAvICJicmlja3MiIC8gIm1hbmlmZXN0
#4#Lmpzb24iDQogICAgbWFuaWZlc3QgPSByZWFkX2pzb25fZmlsZShtYW5pZmVzdF9wYXRoKQ0KICAg
#4#IGlmIG1hbmlmZXN0IGFuZCBub3QgbWFuaWZlc3QuZ2V0KCJoaXN0b2dyYW1zIik6DQogICAgICAg
#4#IF9pbmplY3RfaGlzdG9ncmFtcyh0ZW1wX2RpciwgbWFuaWZlc3RfcGF0aCwgbWFuaWZlc3QsIGxv
#4#ZF9sZXZlbHMsIG5fY2gsIG5fdHApDQogICAgZWxpZiBub3QgbWFuaWZlc3Q6DQogICAgICAgIHBy
#4#aW50KGYiW1dBUk5JTkddIG1hbmlmZXN0Lmpzb24gbm90IGZvdW5kIHRvIHVwZGF0ZSBoaXN0b2dy
#4#YW1zLiIpDQoNCiAgICAjIENhbGlicmF0aW9uLiB2b3hlbCA9IGV4dGVudCAvIE4gKHN0ZXAgMSk7
#4#IHdpdGhvdXQgYW4gZXh0ZW50IHRoZSBjYWxpYnJhdGlvbiBpcw0KICAgICMgdW5kZWNsYXJlZCBh
#4#bmQgZXZlcnkgZGVyaXZlZCBzaXplIGlzIDAgcmF0aGVyIHRoYW4gYSBndWVzcy4NCiAgICB2eCA9
#4#IHZveGVsX3NpemVbIngiXQ0KICAgIHZ5ID0gdm94ZWxfc2l6ZVsieSJdDQogICAgdnogPSB2b3hl
#4#bF9zaXplWyJ6Il0NCiAgICBjYWxpYnJhdGVkID0gYm9vbCh2eCBhbmQgdnkgYW5kIHZ6KQ0KDQog
#4#ICAgZXh0ZW50ID0gcHJvY19tZXRhLmdldCgiZXh0ZW50Iikgb3Ige30NCiAgICBleHRfbWluID0g
#4#ZXh0ZW50LmdldCgibWluIikgb3IgWzAuMCwgMC4wLCAwLjBdDQogICAgZXh0X21heCA9IGV4dGVu
#4#dC5nZXQoIm1heCIpIG9yIFtXICogdngsIEggKiB2eSwgRCAqIHZ6XQ0KDQogICAgIyBUaGUgdmll
#4#d2VyIG1vZGVscyBkZXB0aCBhcyAoRC0xKSB6LXN0ZXBzIHBsdXMgb25lIHNsaWNlIHRoaWNrbmVz
#4#cywgYW5kIHdpdGhvdXQNCiAgICAjIGFuIGV4cGxpY2l0IHZhbHVlIGl0IGd1ZXNzZXMgdGhhdCB0
#4#aGlja25lc3MgYXMgbWluKHpTdGVwLCB2b3hlbFgpIOKAlCB3aGljaCBmb3IgYW4NCiAgICAjIGFu
#4#aXNvdHJvcGljIHN0YWNrIHVuZGVyLXJlcG9ydHMgdGhlIGRlcHRoIChoZXJlIDMyOS41MCB1bSBp
#4#bnN0ZWFkIG9mIHRoZSAzMzMuODcgdW0NCiAgICAjIEltYXJpcyBzdGF0ZXMpLiBEZWNsYXJpbmcg
#4#dGhlIHNsaWNlIHRoaWNrbmVzcyBlcXVhbCB0byB0aGUgei1zdGVwIHJlcHJvZHVjZXMgdGhlDQog
#4#ICAgIyBtaWNyb3Njb3BlJ3Mgb3duIGV4dGVudCBleGFjdGx5LCB3aGljaCBpcyBtYW5kYXRvcnkg
#4#Zm9yIGFueXRoaW5nIHJlZ2lzdGVyZWQgaW4NCiAgICAjIEltYXJpcyBjb29yZGluYXRlcyAoY2Vs
#4#bCB0cmFja3MpIHRvIGxhbmQgb24gdGhlIHJpZ2h0IHZveGVscy4NCiAgICBzbGljZV90aGlja25l
#4#c3MgPSAoZXh0X21heFsyXSAtIGV4dF9taW5bMl0pIC8gbWF4KEQsIDEpDQogICAgcGh5c2ljYWxf
#4#c2l6ZSA9IHsNCiAgICAgICAgIngiOiBleHRfbWF4WzBdIC0gZXh0X21pblswXSwNCiAgICAgICAg
#4#InkiOiBleHRfbWF4WzFdIC0gZXh0X21pblsxXSwNCiAgICAgICAgInoiOiBleHRfbWF4WzJdIC0g
#4#ZXh0X21pblsyXSwNCiAgICAgICAgInNsaWNlVGhpY2tuZXNzIjogc2xpY2VfdGhpY2tuZXNzLA0K
#4#ICAgICAgICAidm94ZWxYIjogdngsDQogICAgICAgICJ2b3hlbFkiOiB2eSwNCiAgICAgICAgInZv
#4#eGVsWiI6IHZ6DQogICAgfQ0KDQogICAgaW50ZXJ2YWwgPSBwcm9jX21ldGEuZ2V0KCJ0aW1lX2lu
#4#dGVydmFsX21pbnV0ZXMiKQ0KICAgIHRpbWVzdGFtcHMgPSBwcm9jX21ldGEuZ2V0KCJ0aW1lc3Rh
#4#bXBzIikgb3IgW10NCg0KICAgICMgU2V0dXAgZGVmYXVsdCBjaGFubmVscyBpbmZvIGZvciBtZXRh
#4#ZGF0YS5qc29uDQogICAgY2hhbm5lbHNfaW5mbyA9IFtdDQogICAgZm9yIGkgaW4gcmFuZ2Uobl9j
#4#aCk6DQogICAgICAgIGNoX25hbWUgPSBjaGFubmVsX25hbWVzW2ldIGlmIGkgPCBsZW4oY2hhbm5l
#4#bF9uYW1lcykgZWxzZSBmIkNoYW5uZWwge2krMX0iDQogICAgICAgIGNoYW5uZWxzX2luZm8uYXBw
#4#ZW5kKHsNCiAgICAgICAgICAgICJuYW1lIjogY2hfbmFtZSwNCiAgICAgICAgICAgICJjb2xvciI6
#4#IENPTE9SU1tpICUgbGVuKENPTE9SUyldLA0KICAgICAgICAgICAgIm1pbiI6IDAuMCwNCiAgICAg
#4#ICAgICAgICJtYXgiOiAxLjAsDQogICAgICAgICAgICAiZ2FtbWEiOiAxLjANCiAgICAgICAgfSkN
#4#Cg0KICAgICMgRm9ybWF0IDIgPSB0aGUgWFkgcGxhbmVzIHN0ZXAgMyB3cm90ZSAocGxhbmVzX3dy
#4#aXRlcikuIENsYWltZWQgb25seSB3aGVuIGV2ZXJ5DQogICAgIyB0cmVlIG5hbWVzIHRoZSBicmlj
#4#a3MgbWFuaWZlc3QgYXMgaXQgc3RhbmRzIG5vdzsgb3RoZXJ3aXNlIHRoZSBkYXRhc2V0IHJlYWRz
#4#IGFzDQogICAgIyBmb3JtYXQgMSBhbmQgdGhlIGFkbWluJ3MgRGF0YSB1cGRhdGVzIHRhYiBwcm9k
#4#dWNlcyB0aGUgcGxhbmVzLg0KICAgIGZvcm1hdF92ZXJzaW9uID0gKHBsYW5lc193cml0ZXIuRk9S
#4#TUFUX1ZFUlNJT04gaWYgcGxhbmVzX3dyaXRlci5wbGFuZXNfY29tcGxldGUob3V0cHV0X2RpcikN
#4#CiAgICAgICAgICAgICAgICAgICAgICBlbHNlIDEpDQoNCiAgICBub3cgPSBkYXRldGltZS5ub3co
#4#KS5pc29mb3JtYXQoKQ0KICAgIG1ldGFkYXRhID0gew0KICAgICAgICAiaWQiOiBmIntkYXRhc2V0
#4#X3R5cGV9L3tkYXRhc2V0X25hbWV9IiwNCiAgICAgICAgImZvcm1hdFZlcnNpb24iOiBmb3JtYXRf
#4#dmVyc2lvbiwNCiAgICAgICAgIm5hbWUiOiBzaG93bl9uYW1lLA0KICAgICAgICAidHlwZSI6IGRh
#4#dGFzZXRfdHlwZSwNCiAgICAgICAgInN0YWdlIjogc3RhZ2UsDQogICAgICAgICJzdGFnZU51bWVy
#4#aWMiOiBzdGFnZV9udW0sDQogICAgICAgICJlbWJyeW8iOiBlbWJyeW8sDQogICAgICAgICJkaW1l
#4#bnNpb25zIjogew0KICAgICAgICAgICAgIngiOiBXLA0KICAgICAgICAgICAgInkiOiBILA0KICAg
#4#ICAgICAgICAgInoiOiBELA0KICAgICAgICAgICAgImMiOiBuX2NoLA0KICAgICAgICAgICAgInQi
#4#OiBuX3RwDQogICAgICAgIH0sDQogICAgICAgICJ2b3hlbF9zaXplIjogdm94ZWxfc2l6ZSwNCiAg
#4#ICAgICAgInBoeXNpY2FsU2l6ZVVtIjogcGh5c2ljYWxfc2l6ZSwNCiAgICAgICAgIm9wdGljYWxf
#4#c2VjdGlvbl90aGlja25lc3NfdW0iOiByb3VuZChzbGljZV90aGlja25lc3MsIDYpLA0KICAgICAg
#4#ICAiYWNxdWlzaXRpb25FeHRlbnRVbSI6IHsNCiAgICAgICAgICAgICJ1bml0IjogZXh0ZW50Lmdl
#4#dCgidW5pdCIsICJ1bSIpLA0KICAgICAgICAgICAgIm1pbiI6IFtmbG9hdCh2KSBmb3IgdiBpbiBl
#4#eHRfbWluXSwNCiAgICAgICAgICAgICJtYXgiOiBbZmxvYXQodikgZm9yIHYgaW4gZXh0X21heF0N
#4#CiAgICAgICAgfSwNCiAgICAgICAgImNhbGlicmF0aW9uU3RhdHVzIjogImV4YWN0IiBpZiBjYWxp
#4#YnJhdGVkIGVsc2UgIm1ldGFkYXRhLW1pc3NpbmciLA0KICAgICAgICAiY2FsaWJyYXRpb25Ob3Rl
#4#IjogKCJWb3hlbCBtZXRhZGF0YSB3YXMgc3VjY2Vzc2Z1bGx5IGV4dHJhY3RlZC4iIGlmIGNhbGli
#4#cmF0ZWQgZWxzZQ0KICAgICAgICAgICAgICAgICAgICAgICAgICAgICJDYWxpYnJhdGlvbiBtZXRh
#4#ZGF0YSBtaXNzaW5nOiB0aGUgZmlsZSBkZWNsYXJlcyBubyB1c2FibGUgZXh0ZW50LiIpLA0KICAg
#4#ICAgICAiY2hhbm5lbHMiOiBjaGFubmVsc19pbmZvLA0KICAgICAgICAiY3JlYXRlZCI6IG5vdywN
#4#CiAgICAgICAgImxhc3RNb2RpZmllZCI6IG5vdywNCiAgICAgICAgImNvbmZpZ3VyZWQiOiBUcnVl
#4#LA0KICAgICAgICAiZm9sZGVyTmFtZSI6IGRhdGFzZXRfbmFtZSwNCiAgICAgICAgImRlc2NyaXB0
#4#aW9uIjogKA0KICAgICAgICAgICAgZiJUaW1lbGFwc2UgY29uZm9jYWwgYWNxdWlzaXRpb246IHtz
#4#dGFnZX0gZW1icnlvLCB7bl90cH0gdGltZXBvaW50cyINCiAgICAgICAgICAgIGYie2YnIGV2ZXJ5
#4#IHtpbnRlcnZhbDpnfSBtaW4nIGlmIGludGVydmFsIGVsc2UgJyd9LCB7RH0gc2xpY2VzLCB7bl9j
#4#aH0gY2hhbm5lbHMuIg0KICAgICAgICAgICAgaWYgbl90cCA+IDEgZWxzZQ0KICAgICAgICAgICAg
#4#ZiJDb25mb2NhbCBpbWFnaW5nIHN0YWNrOiB7c3RhZ2V9IGZpeGVkIGVtYnJ5bywge0R9IHNsaWNl
#4#cywge25fY2h9IGNoYW5uZWxzLiINCiAgICAgICAgKSwNCiAgICAgICAgInRodW1ibmFpbCI6IGYi
#4#e3JlbF9wYXRoX3N0cn0vdGh1bWJuYWlsLndlYnAiIGlmIChvdXRwdXRfZGlyIC8gInRodW1ibmFp
#4#bC53ZWJwIikuZXhpc3RzKCkgZWxzZSBOb25lLA0KICAgICAgICAidm9sdW1lU291cmNlcyI6IFsN
#4#CiAgICAgICAgICAgIHsNCiAgICAgICAgICAgICAgICAia2luZCI6ICJicmlja3MiLA0KICAgICAg
#4#ICAgICAgICAgICJsYWJlbCI6ICJDaHVua2VkIGJyaWNrcyAoNjTCsykiLA0KICAgICAgICAgICAg
#4#ICAgICJwcmlvcml0eSI6IC0xLA0KICAgICAgICAgICAgICAgICJhdmFpbGFibGUiOiBUcnVlLA0K
#4#ICAgICAgICAgICAgICAgICJtdWx0aXNjYWxlIjogVHJ1ZSwNCiAgICAgICAgICAgICAgICAicGF0
#4#aCI6IHJlbF9wYXRoX3N0ciwNCiAgICAgICAgICAgICAgICAibWFuaWZlc3RQYXRoIjogZiJ7cmVs
#4#X3BhdGhfc3RyfS9icmlja3MvbWFuaWZlc3QuanNvbiINCiAgICAgICAgICAgIH0NCiAgICAgICAg
#4#XQ0KICAgIH0NCg0KICAgIGlmIG5fdHAgPiAxOg0KICAgICAgICBub3JtID0gcHJvY19tZXRhLmdl
#4#dCgibm9ybWFsaXphdGlvbiIpIG9yIHt9DQogICAgICAgIG1ldGFkYXRhWyJ0aW1lbGluZSJdID0g
#4#ew0KICAgICAgICAgICAgImNvdW50Ijogbl90cCwNCiAgICAgICAgICAgICJpbnRlcnZhbE1pbnV0
#4#ZXMiOiBpbnRlcnZhbCwNCiAgICAgICAgICAgICJ0aW1lc3RhbXBzIjogdGltZXN0YW1wcw0KICAg
#4#ICAgICB9DQogICAgICAgICMgUGhvdG9ibGVhY2hpbmcgaXMgcmVwb3J0ZWQsIG5ldmVyIGJha2Vk
#4#IGluOiB0aGUgdm94ZWxzIHN0YXkgb24gb25lIGxpbmVhcg0KICAgICAgICAjIHdpbmRvdyAoc2Vl
#4#IDItaW1hZ2VfcHJvY2Vzc29yLnB5KSBzbyBhIGZyYW1lIHRoYXQgbG9va3MgZGltbWVyIHJlYWxs
#4#eSBpcw0KICAgICAgICAjIGRpbW1lci4gVGhlc2UgcGVyLWZyYW1lIHNpZ25hbCBsZXZlbHMgbGV0
#4#IHRoZSB2aWV3ZXIgb2ZmZXIgYW4gT1BUSU9OQUwsDQogICAgICAgICMgcmV2ZXJzaWJsZSBkaXNw
#4#bGF5IGdhaW4gaW5zdGVhZCBvZiBzaWxlbnRseSByZXdyaXRpbmcgdGhlIGRhdGEuDQogICAgICAg
#4#IG1ldGFkYXRhWyJpbnRlbnNpdHlOb3JtYWxpemF0aW9uIl0gPSB7DQogICAgICAgICAgICAibW9k
#4#ZSI6IG5vcm0uZ2V0KCJtb2RlIiwgImdsb2JhbCIpLA0KICAgICAgICAgICAgImJvdW5kcyI6IG5v
#4#cm0uZ2V0KCJib3VuZHMiLCB7fSksDQogICAgICAgICAgICAic2lnbmFsTGV2ZWxzIjogbm9ybS5n
#4#ZXQoInNpZ25hbExldmVscyIsIHt9KQ0KICAgICAgICB9DQoNCiAgICAjIFJlLXByb2Nlc3Npbmcg
#4#a2VlcHMgd2hhdCB0aGUgbGFiIGN1cmF0ZWQgaW4gdGhlIGFkbWluIHBhbmVsIOKAlCBvcmllbnRh
#4#dGlvbiwgZGlzcGxheQ0KICAgICMgc2V0dGluZ3MsIGhhbmQtY29ycmVjdGVkIHN0YWdlLCBoaWRk
#4#ZW4gZmxhZywgZ2FsbGVyeeKApiAobWVyZ2Vfdm9sdW1lX21ldGFkYXRhKS4NCiAgICBleGlzdGlu
#4#ZyA9IHJlYWRfanNvbl9maWxlKGV4aXN0aW5nX3BhdGggaWYgZXhpc3RpbmdfcGF0aCBlbHNlIG91
#4#dHB1dF9kaXIgLyAibWV0YWRhdGEuanNvbiIpDQogICAgaWYgZXhpc3Rpbmc6DQogICAgICAgIG1l
#4#dGFkYXRhID0gbWVyZ2Vfdm9sdW1lX21ldGFkYXRhKGV4aXN0aW5nLCBtZXRhZGF0YSkNCiAgICAg
#4#ICAgcHJpbnQoZiJbQ0FUQUxPR10gQ3VyYXRpb24gb2YgdGhlIHB1Ymxpc2hlZCBtZXRhZGF0YS5q
#4#c29uIGtlcHQiKQ0KDQogICAgYXRvbWljX3dyaXRlX2pzb24ob3V0cHV0X2RpciAvICJtZXRhZGF0
#4#YS5qc29uIiwgbWV0YWRhdGEsIGluZGVudD0yLCBlbnN1cmVfYXNjaWk9RmFsc2UpDQogICAgcHJp
#4#bnQoZiJbQ0FUQUxPR10gV3JvdGUgbWV0YWRhdGEuanNvbiB0byB7b3V0cHV0X2RpciAvICdtZXRh
#4#ZGF0YS5qc29uJ30iKQ0KDQoNCmRlZiBfaW5qZWN0X2hpc3RvZ3JhbXModGVtcF9kaXIsIG1hbmlm
#4#ZXN0X3BhdGgsIG1hbmlmZXN0LCBsb2RfbGV2ZWxzLCBuX2NoLCBuX3RwKToNCiAgICBpbXBvcnQg
#4#aW1wb3J0bGliLnV0aWwNCiAgICBzcGVjID0gaW1wb3J0bGliLnV0aWwuc3BlY19mcm9tX2ZpbGVf
#4#bG9jYXRpb24oImx1bWVuX2NodW5rX3BhY2tlciIsDQogICAgICAgICAgICAgICAgICAgICAgICAg
#4#ICAgICAgICAgICAgICAgICAgICAgICAgIHN0cihIRVJFIC8gIjMtY2h1bmtfcGFja2VyLnB5Iikp
#4#DQogICAgcGFja2VyID0gaW1wb3J0bGliLnV0aWwubW9kdWxlX2Zyb21fc3BlYyhzcGVjKQ0KICAg
#4#IHNwZWMubG9hZGVyLmV4ZWNfbW9kdWxlKHBhY2tlcikNCiAgICBjb2Fyc2VzdCA9IGxvZF9sZXZl
#4#bHNbLTFdWyJsb2QiXQ0KICAgIHByaW50KGYiW0NBVEFMT0ddIENvbXB1dGluZyBoaXN0b2dyYW1z
#4#IG9uIExPRCB7Y29hcnNlc3R9Ig0KICAgICAgICAgIGYie2YnIGZvciB7bl90cH0gdGltZXBvaW50
#4#cycgaWYgbl90cCA+IDEgZWxzZSAnJ30uLi4iKQ0KICAgIGhpc3RvZ3JhbXMgPSBwYWNrZXIuaGlz
#4#dG9ncmFtc19mb3JfdGltZXBvaW50KHRlbXBfZGlyLCAwLCBuX2NoLCBjb2Fyc2VzdCkNCiAgICBt
#4#YW5pZmVzdFsiaGlzdG9ncmFtcyJdID0gaGlzdG9ncmFtcw0KICAgIHRwX21hbmlmZXN0ID0gbWFu
#4#aWZlc3QuZ2V0KCJ0aW1lcG9pbnRzIikNCiAgICBpZiBpc2luc3RhbmNlKHRwX21hbmlmZXN0LCBk
#4#aWN0KToNCiAgICAgICAgZm9yIHRfaWR4IGluIHJhbmdlKG5fdHApOg0KICAgICAgICAgICAga2V5
#4#ID0gZiJ0e3RfaWR4OjAzZH0iDQogICAgICAgICAgICBpZiBrZXkgaW4gdHBfbWFuaWZlc3Q6DQog
#4#ICAgICAgICAgICAgICAgdHBfbWFuaWZlc3Rba2V5XVsiaGlzdG9ncmFtcyJdID0gKA0KICAgICAg
#4#ICAgICAgICAgICAgICBoaXN0b2dyYW1zIGlmIHRfaWR4ID09IDANCiAgICAgICAgICAgICAgICAg
#4#ICAgZWxzZSBwYWNrZXIuaGlzdG9ncmFtc19mb3JfdGltZXBvaW50KHRlbXBfZGlyLCB0X2lkeCwg
#4#bl9jaCwgY29hcnNlc3QpKQ0KICAgIGF0b21pY193cml0ZV9qc29uKG1hbmlmZXN0X3BhdGgsIG1h
#4#bmlmZXN0LCBzZXBhcmF0b3JzPSgiLCIsICI6IikpDQogICAgcHJpbnQoZiJbQ0FUQUxPR10gSW5q
#4#ZWN0ZWQgaGlzdG9ncmFtcyBpbnRvIG1hbmlmZXN0Lmpzb24iKQ0KICAgICMgVGhlIHBsYW5lcyBy
#4#ZWNvcmQgdGhlIGJyaWNrcyBtYW5pZmVzdCdzIHNoYTI1NjogZm9sbG93IGl0cyBuZXcgYnl0ZXMu
#4#DQogICAgaWYgKG1hbmlmZXN0X3BhdGgucGFyZW50LnBhcmVudCAvICJwbGFuZXMiKS5pc19kaXIo
#4#KToNCiAgICAgICAgcGxhbmVzX3dyaXRlci53cml0ZV9tYW5pZmVzdHMobWFuaWZlc3RfcGF0aC5w
#4#YXJlbnQucGFyZW50KQ0KDQoNCmlmIF9fbmFtZV9fID09ICJfX21haW5fXyI6DQogICAgYXAgPSBh
#4#cmdwYXJzZS5Bcmd1bWVudFBhcnNlcihkZXNjcmlwdGlvbj0iV3JpdGUgYSB2b2x1bWUgZGF0YXNl
#4#dCdzIG1ldGFkYXRhLmpzb24uIikNCiAgICBhcC5hZGRfYXJndW1lbnQoInRlbXBfZGlyIikNCiAg
#4#ICBhcC5hZGRfYXJndW1lbnQoIm91dHB1dF9kaXIiKQ0KICAgIGFwLmFkZF9hcmd1bWVudCgiLS1l
#4#eGlzdGluZyIsIGRlZmF1bHQ9Tm9uZSwNCiAgICAgICAgICAgICAgICAgICAgaGVscD0icHVibGlz
#4#aGVkIG1ldGFkYXRhLmpzb24gd2hvc2UgY3VyYXRpb24gaXMga2VwdCAiDQogICAgICAgICAgICAg
#4#ICAgICAgICAgICAgIihkZWZhdWx0OiA8b3V0cHV0X2Rpcj4vbWV0YWRhdGEuanNvbikiKQ0KICAg
#4#IGFwLmFkZF9hcmd1bWVudCgiLS1kaXNwbGF5LW5hbWUiLCBkZWZhdWx0PU5vbmUsDQogICAgICAg
#4#ICAgICAgICAgICAgIGhlbHA9Im5hbWUgc2hvd24gZm9yIHRoZSBkYXRhc2V0IChkZWZhdWx0OiB0
#4#aGUgZm9sZGVyIG5hbWUpIikNCiAgICBhcmdzID0gYXAucGFyc2VfYXJncygpDQoNCiAgICB0cnk6
#4#DQogICAgICAgIGdlbmVyYXRlX2NhdGFsb2dfbWV0YWRhdGEoUGF0aChhcmdzLnRlbXBfZGlyKSwg
#4#UGF0aChhcmdzLm91dHB1dF9kaXIpLA0KICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg
#4#IFBhdGgoYXJncy5leGlzdGluZykgaWYgYXJncy5leGlzdGluZyBlbHNlIE5vbmUsDQogICAgICAg
#4#ICAgICAgICAgICAgICAgICAgICAgICAgICAgYXJncy5kaXNwbGF5X25hbWUpDQogICAgICAgIHBy
#4#aW50KGYiW0NBVEFMT0ddIENhdGFsb2cgbWV0YWRhdGEgZ2VuZXJhdGlvbiBjb21wbGV0ZS4iKQ0K
#4#ICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZToNCiAgICAgICAgaW1wb3J0IHRyYWNlYmFjaw0KICAg
#4#ICAgICB0cmFjZWJhY2sucHJpbnRfZXhjKCkNCiAgICAgICAgcHJpbnQoZiJbRVJST1JdIENhdGFs
#4#b2cgbWV0YWRhdGEgZ2VuZXJhdGlvbiBmYWlsZWQ6IHtlfSIsIGZpbGU9c3lzLnN0ZGVycikNCiAg
#4#ICAgICAgc3lzLmV4aXQoMSkNCg==
:: ---- [5] planes_writer.py (15910 octets) ----
#5#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMw0KIiIiRm9ybWF0IDIgb2YgYSB2b2x1bWUgZGF0YXNldDog
#5#dGhlIG5hdGl2ZSBsZXZlbCAoTE9EMCkgcmUtY3V0IGludG8gWFkgcGxhbmVzLg0KDQpOb3JtYXRp
#5#dmUgY29udHJhY3Q6IERPQ1MvZGF0YXNldC1taWdyYXRpb25zL1NQRUMubWQgwqczLiBGb3IgZXZl
#5#cnkgYnJpY2sgdHJlZSBvZiBhDQpkYXRhc2V0IChgYnJpY2tzL2Agb2YgYSAnM2QnIG9uZSwgZWFj
#5#aCBgYnJpY2tzL3ROTk4vYCBvZiBhICdsaXZlJyBvbmUpIGEgc2libGluZyB0cmVlDQpgcGxhbmVz
#5#L2AgKGBwbGFuZXMvdE5OTi9gKSBob2xkcyBvbmUgcGFjayBwZXIgejoNCg0KICAgIHpOTk5OTi5i
#5#aW4gICBsaXR0bGUtZW5kaWFuDQogICAgICAwICAiTFBMTiIgICAgICAgICAgICBtYWdpYw0KICAg
#5#ICAgNCAgdTE2ICB2ZXJzaW9uID0gMQ0KICAgICAgNiAgdTE2ICBDICAgICAgICAgICAgY2hhbm5l
#5#bHMNCiAgICAgIDggIHUxNiAgVFggICAgICAgICAgIHRpbGVzIGFsb25nIHggID0gY2VpbChYIC8g
#5#NTEyKQ0KICAgICAxMCAgdTE2ICBUWSAgICAgICAgICAgdGlsZXMgYWxvbmcgeSAgPSBjZWlsKFkg
#5#LyA1MTIpDQogICAgIDEyICB1MzIgIHoNCiAgICAgMTYgIEPCt1RZwrdUWCDDlyB7IHU2NCBvZmZz
#5#ZXQgZnJvbSB0aGUgc3RhcnQgb2YgdGhlIGZpbGUsIHUzMiBsZW5ndGggfSwgYy1tYWpvciwgdGhl
#5#bg0KICAgICAgICAgdHksIHRoZW4gdHg7IGxlbmd0aCAwID0gYW4gYWxsLXplcm8gdGlsZSB3aXRo
#5#b3V0IHBheWxvYWQgKG9mZnNldCAwKQ0KICAgICB0aGVuIHRoZSB0aWxlIHBheWxvYWRzIGluIGVu
#5#dHJ5IG9yZGVyLCBubyBwYWRkaW5nDQoNCmFuZCBvbmUgYG1hbmlmZXN0Lmpzb25gIGRlc2NyaWJp
#5#bmcgdGhlIHRyZWUuIEEgdGlsZSBpcyBhIGdyZXlzY2FsZSBQTkcgKGNvbG91ciB0eXBlIDAsDQpi
#5#aXQgZGVwdGggOCwgbm8gYW5jaWxsYXJ5IGNodW5rKSB3aG9zZSBwaXhlbCAoeCwgeSkgaXMgdGhl
#5#IHN0b3JlZCB1aW50OCB2b3hlbCBvZiBjaGFubmVsDQpjIGF0ICh0eMK3NTEyICsgeCwgdHnCtzUx
#5#MiArIHksIHopOiBleGFjdGx5IHdoYXQgdGhlIGJyaWNrIGRlY29kZXIgeWllbGRzIGZvciB0aGF0
#5#IHZveGVsLg0KQSB2b3hlbCBvZiBhIGJyaWNrIHRoZSBtYW5pZmVzdCBkb2VzIG5vdCBsaXN0IGZv
#5#ciB0aGF0IGNoYW5uZWwgKGRyb3BwZWQgYnkgZW1wdHktc3BhY2UNCnNraXBwaW5nKSBpcyAwLCBz
#5#byB0aGUgcGxhbmVzIGFuZCB0aGUgYnJpY2tzIG5ldmVyIGRpc2FncmVlLg0KDQpUaGUgbWlncmF0
#5#aW9uIG9mIGFuIGFscmVhZHkgcHVibGlzaGVkIGRhdGFzZXQgKGRhdGFzZXRfbWlncmF0aW9ucy5w
#5#eSwgc2VydmVyIHNpZGUsIGFuZA0KdGhlIGJyb3dzZXIgZXhlY3V0b3IpIHByb2R1Y2VzIHRoZSBz
#5#YW1lIHRyZWUuIFRoaXMgZmlsZSBpcyBhIHN0YW5kYWxvbmUgY29weSBvZiB0aGUNCmNvZGVjIG9u
#5#IHB1cnBvc2U6IHRoZSBwaXBlbGluZSBwYWNrIHNoaXBzIHdpdGhvdXQgdGhlIHdlYiBwbGF0Zm9y
#5#bSwgYW5kIHRoZSBwYXJpdHkgdGVzdA0KKHRlc3RzL3Rlc3RfbWlnX3BpcGVfcGFyaXR5LnB5KSBo
#5#b2xkcyB0aGUgdHdvIGNvcGllcyB0b2dldGhlci4NCg0KT25seSBudW1weSBhbmQgemxpYiBhcmUg
#5#bmVlZGVkLg0KIiIiDQppbXBvcnQgaGFzaGxpYg0KaW1wb3J0IGpzb24NCmltcG9ydCBtYXRoDQpp
#5#bXBvcnQgb3MNCmltcG9ydCByZQ0KaW1wb3J0IHN0cnVjdA0KaW1wb3J0IHRpbWUNCmltcG9ydCB6
#5#bGliDQpmcm9tIGRhdGV0aW1lIGltcG9ydCBkYXRldGltZSwgdGltZXpvbmUNCmZyb20gcGF0aGxp
#5#YiBpbXBvcnQgUGF0aA0KDQppbXBvcnQgbnVtcHkgYXMgbnANCg0KU0NIRU1BID0gImx1bWVuLXBs
#5#YW5lcy12MSINCkZPUk1BVF9WRVJTSU9OID0gMg0KQ09ERUMgPSAicG5nLWdyYXk4Ig0KVElMRSA9
#5#IDUxMg0KQlJJQ0sgPSA2NA0KQlJJQ0tTX1BFUl9USUxFID0gVElMRSAvLyBCUklDSw0KUEFDS19N
#5#QUdJQyA9IGIiTFBMTiINClBBQ0tfVkVSU0lPTiA9IDENClBBQ0tfRklYRURfQllURVMgPSAxNg0K
#5#UEFDS19FTlRSWV9CWVRFUyA9IDEyDQpQQUNLX1BBVFRFUk4gPSAient6fS5iaW4iDQpaTElCX0xF
#5#VkVMID0gNg0KUE5HX1NJR05BVFVSRSA9IGIiXHg4OVBOR1xyXG5ceDFhXG4iDQoNCl9CUklDS19L
#5#RVkgPSByZS5jb21waWxlKHIiXmxvZDAvYyhcZCspL3goXGQrKV95KFxkKylfeihcZCspXC53ZWJw
#5#JCIpDQoNCg0KIyDilIDilIAgQ29kZWMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSADQpkZWYgX3BuZ19jaHVuayhraW5kOiBieXRlcywgZGF0YTogYnl0ZXMpIC0+IGJ5dGVz
#5#Og0KICAgIHJldHVybiAoc3RydWN0LnBhY2soIj5JIiwgbGVuKGRhdGEpKSArIGtpbmQgKyBkYXRh
#5#DQogICAgICAgICAgICArIHN0cnVjdC5wYWNrKCI+SSIsIHpsaWIuY3JjMzIoa2luZCArIGRhdGEp
#5#ICYgMHhGRkZGRkZGRikpDQoNCg0KZGVmIHBuZ19ncmF5OCh0aWxlOiBucC5uZGFycmF5KSAtPiBi
#5#eXRlczoNCiAgICAiIiJBIChoLCB3KSB1aW50OCBhcnJheSBhcyBhIFBORzogSUhEUiwgb25lIElE
#5#QVQsIElFTkQsIG5vdGhpbmcgZWxzZS4NCg0KICAgIEZpbHRlciAwIChOb25lKSBvbiBldmVyeSBy
#5#b3csIHRoZW4gemxpYiAoUkZDIDE5NTApIGF0IGxldmVsIDYsIGJ5dGUtaWRlbnRpY2FsIHRvDQog
#5#ICAgZGF0YXNldF9taWdyYXRpb25zLnBuZ19ncmF5OC4gTm9uZSwgbm90IFN1Yjogc2hvdCBub2lz
#5#ZSBkb21pbmF0ZXMgcmVhbCBMT0QwIHBsYW5lcyBhbmQNCiAgICBhIGhvcml6b250YWwgZGlmZmVy
#5#ZW5jZSBkb3VibGVzIGl0cyBlbnRyb3B5OyBvdmVyIDIyNjQgbGFiIHRpbGVzIFN1YiB3YXMgNCAl
#5#IGxhcmdlciBpbg0KICAgIHRvdGFsLCA3MCAlIG9uIGEgc3BhcnNlIHRpbWVsYXBzZS4NCiAgICAi
#5#IiINCiAgICB0aWxlID0gbnAuYXNjb250aWd1b3VzYXJyYXkodGlsZSwgZHR5cGU9bnAudWludDgp
#5#DQogICAgaWYgdGlsZS5uZGltICE9IDIgb3IgdGlsZS5zaGFwZVswXSA8IDEgb3IgdGlsZS5zaGFw
#5#ZVsxXSA8IDE6DQogICAgICAgIHJhaXNlIFZhbHVlRXJyb3IoZiJwbmdfZ3JheTg6IGV4cGVjdGVk
#5#IGEgbm9uLWVtcHR5IDItRCB0aWxlLCBnb3Qge3RpbGUuc2hhcGV9IikNCiAgICBoLCB3ID0gdGls
#5#ZS5zaGFwZQ0KICAgIGZpbHRlcmVkID0gbnAuemVyb3MoKGgsIHcgKyAxKSwgZHR5cGU9bnAudWlu
#5#dDgpDQogICAgZmlsdGVyZWRbOiwgMTpdID0gdGlsZQ0KICAgIGloZHIgPSBzdHJ1Y3QucGFjaygi
#5#PklJQkJCQkIiLCB3LCBoLCA4LCAwLCAwLCAwLCAwKQ0KICAgIHJldHVybiAoUE5HX1NJR05BVFVS
#5#RSArIF9wbmdfY2h1bmsoYiJJSERSIiwgaWhkcikNCiAgICAgICAgICAgICsgX3BuZ19jaHVuayhi
#5#IklEQVQiLCB6bGliLmNvbXByZXNzKGZpbHRlcmVkLnRvYnl0ZXMoKSwgWkxJQl9MRVZFTCkpDQog
#5#ICAgICAgICAgICArIF9wbmdfY2h1bmsoYiJJRU5EIiwgYiIiKSkNCg0KDQpkZWYgcG5nX2hlYWRl
#5#cihkYXRhOiBieXRlcyk6DQogICAgIiIiKHdpZHRoLCBoZWlnaHQsIGJpdCBkZXB0aCwgY29sb3Vy
#5#IHR5cGUsIGludGVybGFjZSkgb2YgYSBQTkcncyBJSERSLCBvciBOb25lLiIiIg0KICAgIGlmIGxl
#5#bihkYXRhKSA8IDMzIG9yIGRhdGFbOjhdICE9IFBOR19TSUdOQVRVUkUgb3IgZGF0YVsxMjoxNl0g
#5#IT0gYiJJSERSIiBcDQogICAgICAgICAgICBvciBzdHJ1Y3QudW5wYWNrKCI+SSIsIGRhdGFbODox
#5#Ml0pWzBdICE9IDEzOg0KICAgICAgICByZXR1cm4gTm9uZQ0KICAgIHcsIGgsIGRlcHRoLCBjdHlw
#5#ZSwgX2NvbXAsIF9maWx0LCBpbnRlcmxhY2UgPSBzdHJ1Y3QudW5wYWNrKCI+SUlCQkJCQiIsIGRh
#5#dGFbMTY6MjldKQ0KICAgIHJldHVybiB3LCBoLCBkZXB0aCwgY3R5cGUsIGludGVybGFjZQ0KDQoN
#5#CmRlZiBoZWFkZXJfYnl0ZXMoY2hhbm5lbHM6IGludCwgdGlsZXNfeDogaW50LCB0aWxlc195OiBp
#5#bnQpIC0+IGludDoNCiAgICByZXR1cm4gUEFDS19GSVhFRF9CWVRFUyArIFBBQ0tfRU5UUllfQllU
#5#RVMgKiBjaGFubmVscyAqIHRpbGVzX3kgKiB0aWxlc194DQoNCg0KZGVmIGJ1aWxkX3BsYW5lX3Bh
#5#Y2soejogaW50LCBjaGFubmVsczogaW50LCB0aWxlc194OiBpbnQsIHRpbGVzX3k6IGludCwgcGF5
#5#bG9hZHMpIC0+IGJ5dGVzOg0KICAgICIiIk9uZSB6Tk5OTk4uYmluLiBwYXlsb2FkczogQ8K3VFnC
#5#t1RYIGJ5dGUgc3RyaW5ncyBpbiBlbnRyeSBvcmRlciAoYywgdHksIHR4KSwgYW4NCiAgICBlbXB0
#5#eSBvbmUgZm9yIGFuIGFsbC16ZXJvIHRpbGUuIiIiDQogICAgbiA9IGNoYW5uZWxzICogdGlsZXNf
#5#eSAqIHRpbGVzX3gNCiAgICBpZiBsZW4ocGF5bG9hZHMpICE9IG46DQogICAgICAgIHJhaXNlIFZh
#5#bHVlRXJyb3IoZiJidWlsZF9wbGFuZV9wYWNrOiB7bGVuKHBheWxvYWRzKX0gcGF5bG9hZHMgZm9y
#5#IHtufSB0aWxlcyIpDQogICAgZm9yIHYgaW4gKGNoYW5uZWxzLCB0aWxlc194LCB0aWxlc195KToN
#5#CiAgICAgICAgaWYgbm90IDEgPD0gdiA8PSAweEZGRkY6DQogICAgICAgICAgICByYWlzZSBWYWx1
#5#ZUVycm9yKCJidWlsZF9wbGFuZV9wYWNrOiBjb3VudCBvdXQgb2YgdTE2IHJhbmdlIikNCiAgICBo
#5#ZWFkID0gYnl0ZWFycmF5KGhlYWRlcl9ieXRlcyhjaGFubmVscywgdGlsZXNfeCwgdGlsZXNfeSkp
#5#DQogICAgc3RydWN0LnBhY2tfaW50bygiPDRzSEhISEkiLCBoZWFkLCAwLCBQQUNLX01BR0lDLCBQ
#5#QUNLX1ZFUlNJT04sIGNoYW5uZWxzLCB0aWxlc194LA0KICAgICAgICAgICAgICAgICAgICAgdGls
#5#ZXNfeSwgeikNCiAgICBvZmZzZXQgPSBsZW4oaGVhZCkNCiAgICBmb3IgaSwgZGF0YSBpbiBlbnVt
#5#ZXJhdGUocGF5bG9hZHMpOg0KICAgICAgICBsZW5ndGggPSBsZW4oZGF0YSkNCiAgICAgICAgc3Ry
#5#dWN0LnBhY2tfaW50bygiPFFJIiwgaGVhZCwgUEFDS19GSVhFRF9CWVRFUyArIGkgKiBQQUNLX0VO
#5#VFJZX0JZVEVTLA0KICAgICAgICAgICAgICAgICAgICAgICAgIG9mZnNldCBpZiBsZW5ndGggZWxz
#5#ZSAwLCBsZW5ndGgpDQogICAgICAgIG9mZnNldCArPSBsZW5ndGgNCiAgICByZXR1cm4gYnl0ZXMo
#5#aGVhZCkgKyBiIiIuam9pbihwYXlsb2FkcykNCg0KDQpkZWYgcGFyc2VfcGxhbmVfcGFja19oZWFk
#5#ZXIoZGF0YTogYnl0ZXMpIC0+IGRpY3Q6DQogICAgaWYgbGVuKGRhdGEpIDwgUEFDS19GSVhFRF9C
#5#WVRFUyBvciBkYXRhWzo0XSAhPSBQQUNLX01BR0lDOg0KICAgICAgICByYWlzZSBWYWx1ZUVycm9y
#5#KCJwbGFuZSBwYWNrOiBiYWQgbWFnaWMiKQ0KICAgIF9tLCB2ZXJzaW9uLCBjaGFubmVscywgdGls
#5#ZXNfeCwgdGlsZXNfeSwgeiA9IHN0cnVjdC51bnBhY2tfZnJvbSgiPDRzSEhISEkiLCBkYXRhLCAw
#5#KQ0KICAgIGlmIHZlcnNpb24gIT0gUEFDS19WRVJTSU9OOg0KICAgICAgICByYWlzZSBWYWx1ZUVy
#5#cm9yKGYicGxhbmUgcGFjazogdW5zdXBwb3J0ZWQgdmVyc2lvbiB7dmVyc2lvbn0iKQ0KICAgIG4g
#5#PSBjaGFubmVscyAqIHRpbGVzX3kgKiB0aWxlc194DQogICAgaWYgbGVuKGRhdGEpIDwgaGVhZGVy
#5#X2J5dGVzKGNoYW5uZWxzLCB0aWxlc194LCB0aWxlc195KToNCiAgICAgICAgcmFpc2UgVmFsdWVF
#5#cnJvcigicGxhbmUgcGFjazogc2hvcnQgaGVhZGVyIikNCiAgICBlbnRyaWVzID0gW3N0cnVjdC51
#5#bnBhY2tfZnJvbSgiPFFJIiwgZGF0YSwgUEFDS19GSVhFRF9CWVRFUyArIGkgKiBQQUNLX0VOVFJZ
#5#X0JZVEVTKQ0KICAgICAgICAgICAgICAgZm9yIGkgaW4gcmFuZ2UobildDQogICAgcmV0dXJuIHsi
#5#dmVyc2lvbiI6IHZlcnNpb24sICJjaGFubmVscyI6IGNoYW5uZWxzLCAidGlsZXNYIjogdGlsZXNf
#5#eCwgInRpbGVzWSI6IHRpbGVzX3ksDQogICAgICAgICAgICAieiI6IHosICJlbnRyaWVzIjogZW50
#5#cmllc30NCg0KDQpkZWYgcGFja19uYW1lKHo6IGludCkgLT4gc3RyOg0KICAgIHJldHVybiBQQUNL
#5#X1BBVFRFUk4ucmVwbGFjZSgie3p9IiwgZiJ7ejowNWR9IikNCg0KDQojIOKUgOKUgCBXaGljaCBi
#5#cmlja3MgYSBjaGFubmVsIGtlcHQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQpkZWYg
#5#a2VwdF9ncmlkKGJyaWNrX3RvX3BhY2s6IGRpY3QsIGNoYW5uZWxzOiBpbnQsIGRpbXMpIC0+IG5w
#5#Lm5kYXJyYXk6DQogICAgIiIiKEMsIG56LCBueSwgbngpIGJvb2w6IGJyaWNrIChieCwgYnksIGJ6
#5#KSBvZiBjaGFubmVsIGMgaXMgaW4gdGhlIExPRDAgaW5kZXguDQoNCiAgICBSZWFkIGZyb20gdGhl
#5#IHRyYW5zcG9ydCdzIGJyaWNrVG9QYWNrIOKAlCB0aGUgaW5kZXggdGhlIHZpZXdlciBpdHNlbGYg
#5#ZGVjb2RlcyDigJQgc28gYQ0KICAgIGJyaWNrIHRoZSBwYWNrZXIgZHJvcHBlZCBpbiBvbmUgY2hh
#5#bm5lbCBhbmQga2VwdCBpbiBhbm90aGVyIHJlYWRzIDAgb25seSB3aGVyZSB0aGUNCiAgICB2aWV3
#5#ZXIgcmVhZHMgMC4NCiAgICAiIiINCiAgICB4LCB5LCB6ID0gZGltcw0KICAgIGdyaWQgPSBucC56
#5#ZXJvcygoY2hhbm5lbHMsIG1hdGguY2VpbCh6IC8gQlJJQ0spLCBtYXRoLmNlaWwoeSAvIEJSSUNL
#5#KSwNCiAgICAgICAgICAgICAgICAgICAgIG1hdGguY2VpbCh4IC8gQlJJQ0spKSwgZHR5cGU9Ym9v
#5#bCkNCiAgICBmb3Iga2V5IGluIGJyaWNrX3RvX3BhY2s6DQogICAgICAgIG0gPSBfQlJJQ0tfS0VZ
#5#Lm1hdGNoKGtleSkNCiAgICAgICAgaWYgbm90IG06DQogICAgICAgICAgICBjb250aW51ZQ0KICAg
#5#ICAgICBjLCBieCwgYnksIGJ6ID0gKGludChnKSBmb3IgZyBpbiBtLmdyb3VwcygpKQ0KICAgICAg
#5#ICBpZiBjIDwgY2hhbm5lbHMgYW5kIGJ6IDwgZ3JpZC5zaGFwZVsxXSBhbmQgYnkgPCBncmlkLnNo
#5#YXBlWzJdIGFuZCBieCA8IGdyaWQuc2hhcGVbM106DQogICAgICAgICAgICBncmlkW2MsIGJ6LCBi
#5#eSwgYnhdID0gVHJ1ZQ0KICAgIHJldHVybiBncmlkDQoNCg0KIyDilIDilIAgV3JpdGluZyBvbmUg
#5#dHJlZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIANCmRlZiBfYXRvbWljX3dyaXRlKHBhdGg6IFBhdGgsIGRhdGE6IGJ5dGVzKSAt
#5#PiBOb25lOg0KICAgIHRtcCA9IHBhdGgud2l0aF9uYW1lKGYiLntwYXRoLm5hbWV9Lntvcy5nZXRw
#5#aWQoKX0udG1wIikNCiAgICB0cnk6DQogICAgICAgIHdpdGggb3Blbih0bXAsICJ3YiIpIGFzIGZo
#5#Og0KICAgICAgICAgICAgZmgud3JpdGUoZGF0YSkNCiAgICAgICAgICAgIGZoLmZsdXNoKCkNCiAg
#5#ICAgICAgICAgIG9zLmZzeW5jKGZoLmZpbGVubygpKQ0KICAgICAgICBmb3IgYXR0ZW1wdCBpbiBy
#5#YW5nZSg0MCk6DQogICAgICAgICAgICB0cnk6DQogICAgICAgICAgICAgICAgb3MucmVwbGFjZSh0
#5#bXAsIHBhdGgpDQogICAgICAgICAgICAgICAgYnJlYWsNCiAgICAgICAgICAgIGV4Y2VwdCBQZXJt
#5#aXNzaW9uRXJyb3I6DQogICAgICAgICAgICAgICAgaWYgYXR0ZW1wdCA9PSAzOToNCiAgICAgICAg
#5#ICAgICAgICAgICAgcmFpc2UNCiAgICAgICAgICAgICAgICB0aW1lLnNsZWVwKDAuMSkNCiAgICBl
#5#eGNlcHQgQmFzZUV4Y2VwdGlvbjoNCiAgICAgICAgdHJ5Og0KICAgICAgICAgICAgdG1wLnVubGlu
#5#aygpDQogICAgICAgIGV4Y2VwdCBPU0Vycm9yOg0KICAgICAgICAgICAgcGFzcw0KICAgICAgICBy
#5#YWlzZQ0KDQoNCmRlZiBwbGFuZV9wYWNrX2Zvcl96KHo6IGludCwgcGxhbmVzLCBrZWVwX2xheWVy
#5#OiBucC5uZGFycmF5LCB3aWR0aDogaW50LCBoZWlnaHQ6IGludCkgLT4gYnl0ZXM6DQogICAgIiIi
#5#VGhlIHBhY2sgb2Ygb25lIHogZnJvbSBpdHMgQyBwbGFuZXMuDQoNCiAgICBwbGFuZXM6IEMgYXJy
#5#YXlzIChoZWlnaHQsIHdpZHRoKSB1aW50OCwgb3IgTm9uZSBmb3IgYSBjaGFubmVsIHdpdGhvdXQg
#5#ZGF0YS4NCiAgICBrZWVwX2xheWVyOiAoQywgbnksIG54KSBib29sLCB0aGUga2VwdCBicmlja3Mg
#5#b2YgdGhpcyB6J3MgYnJpY2sgbGF5ZXI7IHRoZSB2b3hlbHMgb2YNCiAgICBldmVyeSBvdGhlciBi
#5#cmljayBhcmUgemVyb2VkLiBBIHRpbGUgdGhhdCBpcyBlbnRpcmVseSB6ZXJvIGdldHMgbGVuZ3Ro
#5#IDAgYW5kIG5vDQogICAgcGF5bG9hZCDigJQgd2hhdCBib3RoIG1pZ3JhdGlvbiBleGVjdXRvcnMg
#5#cHJvZHVjZSwgc28gYSBwaXBlbGluZSB0cmVlIGFuZCBhIG1pZ3JhdGVkDQogICAgb25lIGFyZSBi
#5#eXRlLWlkZW50aWNhbC4NCiAgICAiIiINCiAgICBjaGFubmVscyA9IGxlbihwbGFuZXMpDQogICAg
#5#dGlsZXNfeCwgdGlsZXNfeSA9IG1hdGguY2VpbCh3aWR0aCAvIFRJTEUpLCBtYXRoLmNlaWwoaGVp
#5#Z2h0IC8gVElMRSkNCiAgICBwYXlsb2FkcyA9IFtdDQogICAgZm9yIGMgaW4gcmFuZ2UoY2hhbm5l
#5#bHMpOg0KICAgICAgICBwbGFuZSA9IHBsYW5lc1tjXQ0KICAgICAgICBrZWVwID0ga2VlcF9sYXll
#5#cltjXQ0KICAgICAgICBpZiBwbGFuZSBpcyBub3QgTm9uZSBhbmQgbm90IGtlZXAuYWxsKCk6DQog
#5#ICAgICAgICAgICBtYXNrID0gbnAucmVwZWF0KG5wLnJlcGVhdChrZWVwLCBCUklDSywgYXhpcz0w
#5#KSwgQlJJQ0ssIGF4aXM9MSlbOmhlaWdodCwgOndpZHRoXQ0KICAgICAgICAgICAgcGxhbmUgPSBu
#5#cC53aGVyZShtYXNrLCBwbGFuZSwgbnAudWludDgoMCkpDQogICAgICAgIGZvciB0eSBpbiByYW5n
#5#ZSh0aWxlc195KToNCiAgICAgICAgICAgIGZvciB0eCBpbiByYW5nZSh0aWxlc194KToNCiAgICAg
#5#ICAgICAgICAgICB0aWxlID0gTm9uZSBpZiBwbGFuZSBpcyBOb25lIGVsc2UgICAgICAgICAgICAg
#5#ICAgICAgICBwbGFuZVt0eSAqIFRJTEU6bWluKGhlaWdodCwgKHR5ICsgMSkgKiBUSUxFKSwgdHgg
#5#KiBUSUxFOm1pbih3aWR0aCwgKHR4ICsgMSkgKiBUSUxFKV0NCiAgICAgICAgICAgICAgICBwYXls
#5#b2Fkcy5hcHBlbmQocG5nX2dyYXk4KHRpbGUpIGlmIHRpbGUgaXMgbm90IE5vbmUgYW5kIHRpbGUu
#5#YW55KCkgZWxzZSBiIiIpDQogICAgcmV0dXJuIGJ1aWxkX3BsYW5lX3BhY2soeiwgY2hhbm5lbHMs
#5#IHRpbGVzX3gsIHRpbGVzX3ksIHBheWxvYWRzKQ0KDQoNCmRlZiB3cml0ZV9wbGFuZV90YXNrKGFy
#5#Z3MpOg0KICAgICIiIldvcmtlciB0YXNrOiB3cml0ZSBwbGFuZXMvek5OTk5OLmJpbiBmb3Igb25l
#5#IHogb2Ygb25lIHRyZWUuDQoNCiAgICBhcmdzID0gKGxvZDAgZmlsZSBwZXIgY2hhbm5lbCAoc3Ry
#5#LCBvciBOb25lIHdoZW4gYSBjaGFubmVsIGhhcyBubyBkYXRhKSwNCiAgICAgICAgICAgIChELCBI
#5#LCBXKSwgeiwga2VlcF9sYXllciAoQywgbnksIG54KSBib29sLCBvdXRwdXQgZGlyZWN0b3J5KS4N
#5#CiAgICBFYWNoIHdvcmtlciByZWFkcyBvbmx5IGl0cyBvd24gcGxhbmUgb2YgZWFjaCBjaGFubmVs
#5#IG91dCBvZiB0aGUgTE9EMCBmaWxlcywgc28NCiAgICBubyB2b3hlbCBjcm9zc2VzIGEgcGlwZSBh
#5#bmQgdGhlIHJlc2lkZW50IHNldCBpcyBDIHBsYW5lcy4gUmV0dXJucyAoeiwgYnl0ZXMpLg0KICAg
#5#ICIiIg0KICAgIHBhdGhzLCBzaGFwZSwgeiwga2VlcF9sYXllciwgb3V0X2RpciA9IGFyZ3MNCiAg
#5#ICBELCBILCBXID0gc2hhcGUNCiAgICBwbGFuZXMgPSBbXQ0KICAgIGZvciBwIGluIHBhdGhzOg0K
#5#ICAgICAgICBpZiBwIGlzIE5vbmU6DQogICAgICAgICAgICBwbGFuZXMuYXBwZW5kKE5vbmUpDQog
#5#ICAgICAgICAgICBjb250aW51ZQ0KICAgICAgICB2b2wgPSBucC5tZW1tYXAocCwgZHR5cGU9bnAu
#5#dWludDgsIG1vZGU9InIiLCBzaGFwZT0oRCwgSCwgVykpDQogICAgICAgIHRyeToNCiAgICAgICAg
#5#ICAgIHBsYW5lcy5hcHBlbmQobnAuYXJyYXkodm9sW3pdKSkNCiAgICAgICAgZmluYWxseToNCiAg
#5#ICAgICAgICAgIGRlbCB2b2wNCiAgICBkYXRhID0gcGxhbmVfcGFja19mb3Jfeih6LCBwbGFuZXMs
#5#IGtlZXBfbGF5ZXIsIFcsIEgpDQogICAgX2F0b21pY193cml0ZShQYXRoKG91dF9kaXIpIC8gcGFj
#5#a19uYW1lKHopLCBkYXRhKQ0KICAgIHJldHVybiB6LCBsZW4oZGF0YSkNCg0KDQpkZWYgcGxhbmVf
#5#dGFza3MobG9kMF9maWxlcywgZGltcywgYnJpY2tfdG9fcGFjazogZGljdCwgb3V0X2RpcjogUGF0
#5#aCk6DQogICAgIiIiVGFza3MgZm9yIHdyaXRlX3BsYW5lX3Rhc2sgY292ZXJpbmcgZXZlcnkgeiBv
#5#ZiBvbmUgdHJlZSwgaW4geiBvcmRlci4NCg0KICAgIGxvZDBfZmlsZXM6IHBlciBjaGFubmVsLCB0
#5#aGUgKEQsIEgsIFcpIHVpbnQ4IExPRDAgZmlsZSBvciBOb25lOyBkaW1zID0gKFgsIFksIFopLg0K
#5#ICAgICIiIg0KICAgIFgsIFksIFogPSBkaW1zDQogICAgY2hhbm5lbHMgPSBsZW4obG9kMF9maWxl
#5#cykNCiAgICBrZWVwID0ga2VwdF9ncmlkKGJyaWNrX3RvX3BhY2ssIGNoYW5uZWxzLCBkaW1zKQ0K
#5#ICAgIG91dF9kaXIgPSBQYXRoKG91dF9kaXIpDQogICAgb3V0X2Rpci5ta2RpcihwYXJlbnRzPVRy
#5#dWUsIGV4aXN0X29rPVRydWUpDQogICAgcGF0aHMgPSBbc3RyKHApIGlmIHAgaXMgbm90IE5vbmUg
#5#YW5kIFBhdGgocCkuZXhpc3RzKCkgZWxzZSBOb25lIGZvciBwIGluIGxvZDBfZmlsZXNdDQogICAg
#5#cmV0dXJuIFsocGF0aHMsIChaLCBZLCBYKSwgeiwga2VlcFs6LCB6IC8vIEJSSUNLXS5jb3B5KCks
#5#IHN0cihvdXRfZGlyKSkNCiAgICAgICAgICAgIGZvciB6IGluIHJhbmdlKFopXQ0KDQoNCiMg4pSA
#5#4pSAIFRoZSB0cmVlIG1hbmlmZXN0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KZGVmIGJyaWNrX3RyZWVzKGJyaWNrc19tYW5pZmVz
#5#dDogZGljdCk6DQogICAgIiIiWyh0cmVlIGtleSBvciAnJywgTE9EMCBkaW1zIChYLCBZLCBaKSwg
#5#Y2hhbm5lbHMpXSBvZiBhIGJyaWNrcyBtYW5pZmVzdCDigJQgb25lDQogICAgZW50cnkgZm9yIGEg
#5#JzNkJyBkYXRhc2V0LCBvbmUgcGVyIHRpbWVwb2ludCBmb3IgYSAnbGl2ZScgb25lLiIiIg0KICAg
#5#IGNoYW5uZWxzID0gaW50KGJyaWNrc19tYW5pZmVzdC5nZXQoImNoYW5uZWxzIikgb3IgMCkNCg0K
#5#ICAgIGRlZiBsb2QwKGxldmVscyk6DQogICAgICAgIGZvciBsdiBpbiBsZXZlbHMgb3IgW106DQog
#5#ICAgICAgICAgICBpZiBpbnQobHYuZ2V0KCJsZXZlbCIsIC0xKSkgPT0gMDoNCiAgICAgICAgICAg
#5#ICAgICBkID0gbHZbImRpbWVuc2lvbnMiXQ0KICAgICAgICAgICAgICAgIHJldHVybiBpbnQoZFsi
#5#eCJdKSwgaW50KGRbInkiXSksIGludChkWyJ6Il0pDQogICAgICAgIHJhaXNlIFZhbHVlRXJyb3Io
#5#ImJyaWNrcyBtYW5pZmVzdDogbm8gTE9EMCBsZXZlbCIpDQoNCiAgICB0aW1lcG9pbnRzID0gYnJp
#5#Y2tzX21hbmlmZXN0LmdldCgidGltZXBvaW50cyIpDQogICAgaWYgaXNpbnN0YW5jZSh0aW1lcG9p
#5#bnRzLCBkaWN0KSBhbmQgdGltZXBvaW50czoNCiAgICAgICAgcmV0dXJuIFsoa2V5LCBsb2QwKHJv
#5#dy5nZXQoImxldmVscyIpIG9yIGJyaWNrc19tYW5pZmVzdC5nZXQoImxldmVscyIpKSwNCiAgICAg
#5#ICAgICAgICAgICAgaW50KHJvdy5nZXQoImNoYW5uZWxzIikgb3IgY2hhbm5lbHMpKQ0KICAgICAg
#5#ICAgICAgICAgIGZvciBrZXksIHJvdyBpbiBzb3J0ZWQodGltZXBvaW50cy5pdGVtcygpKV0NCiAg
#5#ICByZXR1cm4gWygiIiwgbG9kMChicmlja3NfbWFuaWZlc3QuZ2V0KCJsZXZlbHMiKSksIGNoYW5u
#5#ZWxzKV0NCg0KDQpkZWYgdHJlZV9tYW5pZmVzdChkaW1zLCBjaGFubmVsczogaW50LCBtYW5pZmVz
#5#dF9zaGEyNTY6IHN0ciwgcHJvZHVjZXI6IHN0ciA9ICJwaXBlbGluZSIsDQogICAgICAgICAgICAg
#5#ICAgICBjcmVhdGVkX2F0OiBzdHIgPSBOb25lKSAtPiBkaWN0Og0KICAgIFgsIFksIFogPSBkaW1z
#5#DQogICAgdGlsZXNfeCwgdGlsZXNfeSA9IG1hdGguY2VpbChYIC8gVElMRSksIG1hdGguY2VpbChZ
#5#IC8gVElMRSkNCiAgICByZXR1cm4gew0KICAgICAgICAic2NoZW1hIjogU0NIRU1BLA0KICAgICAg
#5#ICAiZm9ybWF0VmVyc2lvbiI6IEZPUk1BVF9WRVJTSU9OLA0KICAgICAgICAibGV2ZWwiOiAwLA0K
#5#ICAgICAgICAiZGltZW5zaW9ucyI6IHsieCI6IFgsICJ5IjogWSwgInoiOiBafSwNCiAgICAgICAg
#5#ImNoYW5uZWxzIjogY2hhbm5lbHMsDQogICAgICAgICJ0aWxlU2l6ZSI6IFRJTEUsDQogICAgICAg
#5#ICJ0aWxlcyI6IHsieCI6IHRpbGVzX3gsICJ5IjogdGlsZXNfeX0sDQogICAgICAgICJjb2RlYyI6
#5#IENPREVDLA0KICAgICAgICAicGFja1BhdHRlcm4iOiBQQUNLX1BBVFRFUk4sDQogICAgICAgICJo
#5#ZWFkZXJCeXRlcyI6IGhlYWRlcl9ieXRlcyhjaGFubmVscywgdGlsZXNfeCwgdGlsZXNfeSksDQog
#5#ICAgICAgICJzb3VyY2UiOiB7Im1hbmlmZXN0U2hhMjU2IjogbWFuaWZlc3Rfc2hhMjU2fSwNCiAg
#5#ICAgICAgInByb2R1Y2VyIjogcHJvZHVjZXIsDQogICAgICAgICJjcmVhdGVkQXQiOiBjcmVhdGVk
#5#X2F0IG9yIGRhdGV0aW1lLm5vdyh0aW1lem9uZS51dGMpLnN0cmZ0aW1lKCIlWS0lbS0lZFQlSDol
#5#TTolU1oiKSwNCiAgICB9DQoNCg0KZGVmIF9jaGVja190cmVlX3BhY2tzKHRyZWVfZGlyOiBQYXRo
#5#LCBkaW1zLCBjaGFubmVsczogaW50KSAtPiBOb25lOg0KICAgICIiIkV2ZXJ5IHpOTk5OTi5iaW4g
#5#b2YgdGhlIHRyZWUgaXMgdGhlcmUgd2l0aCB0aGUgaGVhZGVyIHRoaXMgdHJlZSBpbXBsaWVzLiIi
#5#Ig0KICAgIFgsIFksIFogPSBkaW1zDQogICAgdGlsZXNfeCwgdGlsZXNfeSA9IG1hdGguY2VpbChY
#5#IC8gVElMRSksIG1hdGguY2VpbChZIC8gVElMRSkNCiAgICBuZWVkID0gaGVhZGVyX2J5dGVzKGNo
#5#YW5uZWxzLCB0aWxlc194LCB0aWxlc195KQ0KICAgIGZvciB6IGluIHJhbmdlKFopOg0KICAgICAg
#5#ICBwYXRoID0gdHJlZV9kaXIgLyBwYWNrX25hbWUoeikNCiAgICAgICAgdHJ5Og0KICAgICAgICAg
#5#ICAgc2l6ZSA9IHBhdGguc3RhdCgpLnN0X3NpemUNCiAgICAgICAgICAgIHdpdGggb3BlbihwYXRo
#5#LCAicmIiKSBhcyBmaDoNCiAgICAgICAgICAgICAgICBoZWFkID0gcGFyc2VfcGxhbmVfcGFja19o
#5#ZWFkZXIoZmgucmVhZChuZWVkKSkNCiAgICAgICAgZXhjZXB0IChPU0Vycm9yLCBWYWx1ZUVycm9y
#5#KSBhcyBleGM6DQogICAgICAgICAgICByYWlzZSBSdW50aW1lRXJyb3IoZiJ7cGF0aH06IHBsYW4g
#5#aWxsaXNpYmxlICh7ZXhjfSkiKSBmcm9tIGV4Yw0KICAgICAgICBpZiAoaGVhZFsiY2hhbm5lbHMi
#5#XSwgaGVhZFsidGlsZXNYIl0sIGhlYWRbInRpbGVzWSJdLCBoZWFkWyJ6Il0pICE9IFwNCiAgICAg
#5#ICAgICAgICAgICAoY2hhbm5lbHMsIHRpbGVzX3gsIHRpbGVzX3ksIHopOg0KICAgICAgICAgICAg
#5#cmFpc2UgUnVudGltZUVycm9yKGYie3BhdGh9OiBlbi10ZXRlIGluY29oZXJlbnQgYXZlYyBsJ2Fy
#5#YnJlIikNCiAgICAgICAgZW5kID0gbWF4KChvZmYgKyBsbiBmb3Igb2ZmLCBsbiBpbiBoZWFkWyJl
#5#bnRyaWVzIl0gaWYgbG4pLCBkZWZhdWx0PW5lZWQpDQogICAgICAgIGlmIGVuZCAhPSBzaXplOg0K
#5#ICAgICAgICAgICAgcmFpc2UgUnVudGltZUVycm9yKGYie3BhdGh9OiB0YWlsbGUge3NpemV9ICE9
#5#IHtlbmR9IGF0dGVuZHVlIikNCg0KDQpkZWYgd3JpdGVfbWFuaWZlc3RzKGRhdGFzZXRfZGlyLCBw
#5#cm9kdWNlcjogc3RyID0gInBpcGVsaW5lIikgLT4gbGlzdDoNCiAgICAiIiJXcml0ZSBwbGFuZXNb
#5#L3ROTk5dL21hbmlmZXN0Lmpzb24gZm9yIGV2ZXJ5IHRyZWUgb2YgYSBkYXRhc2V0IHdob3NlIHBh
#5#Y2tzIGV4aXN0Lg0KDQogICAgQ2FsbGVkIG9uY2UgYnJpY2tzL21hbmlmZXN0Lmpzb24gaG9sZHMg
#5#aXRzIGZpbmFsIGJ5dGVzIChhbmQgYWdhaW4gd2hlbmV2ZXIgYSBsYXRlcg0KICAgIHN0ZXAgcmV3
#5#cml0ZXMgaXQpLCBzaW5jZSBlYWNoIHRyZWUgcmVjb3JkcyB0aGF0IGZpbGUncyBzaGEyNTYuIFJh
#5#aXNlcyB3aGVuIGEgdHJlZQ0KICAgIGlzIGluY29tcGxldGU6IGEgZGF0YXNldCBpcyBuZXZlciBw
#5#dWJsaXNoZWQgY2xhaW1pbmcgcGxhbmVzIGl0IGRvZXMgbm90IGhhdmUuDQogICAgIiIiDQogICAg
#5#ZGF0YXNldF9kaXIgPSBQYXRoKGRhdGFzZXRfZGlyKQ0KICAgIHJhdyA9IChkYXRhc2V0X2RpciAv
#5#ICJicmlja3MiIC8gIm1hbmlmZXN0Lmpzb24iKS5yZWFkX2J5dGVzKCkNCiAgICBzaGEgPSBoYXNo
#5#bGliLnNoYTI1NihyYXcpLmhleGRpZ2VzdCgpDQogICAgd3JpdHRlbiA9IFtdDQogICAgZm9yIGtl
#5#eSwgZGltcywgY2hhbm5lbHMgaW4gYnJpY2tfdHJlZXMoanNvbi5sb2FkcyhyYXcuZGVjb2RlKCJ1
#5#dGYtOCIpKSk6DQogICAgICAgIHRyZWVfZGlyID0gZGF0YXNldF9kaXIgLyAicGxhbmVzIiAvIGtl
#5#eSBpZiBrZXkgZWxzZSBkYXRhc2V0X2RpciAvICJwbGFuZXMiDQogICAgICAgIF9jaGVja190cmVl
#5#X3BhY2tzKHRyZWVfZGlyLCBkaW1zLCBjaGFubmVscykNCiAgICAgICAgZG9jID0gdHJlZV9tYW5p
#5#ZmVzdChkaW1zLCBjaGFubmVscywgc2hhLCBwcm9kdWNlcikNCiAgICAgICAgX2F0b21pY193cml0
#5#ZSh0cmVlX2RpciAvICJtYW5pZmVzdC5qc29uIiwNCiAgICAgICAgICAgICAgICAgICAgICBqc29u
#5#LmR1bXBzKGRvYywgc2VwYXJhdG9ycz0oIiwiLCAiOiIpKS5lbmNvZGUoInV0Zi04IikpDQogICAg
#5#ICAgIHdyaXR0ZW4uYXBwZW5kKHRyZWVfZGlyIC8gIm1hbmlmZXN0Lmpzb24iKQ0KICAgIHJldHVy
#5#biB3cml0dGVuDQoNCg0KZGVmIHBsYW5lc19jb21wbGV0ZShkYXRhc2V0X2RpcikgLT4gYm9vbDoN
#5#CiAgICAiIiJUcnVlIHdoZW4gZXZlcnkgYnJpY2sgdHJlZSBoYXMgYSBwbGFuZXMgbWFuaWZlc3Qg
#5#bmFtaW5nIHRoZSBjdXJyZW50IGJyaWNrcw0KICAgIG1hbmlmZXN0IOKAlCB0aGUgY29uZGl0aW9u
#5#IGZvciBhIGRhdGFzZXQgdG8gY2xhaW0gZm9ybWF0VmVyc2lvbiAyLiIiIg0KICAgIGRhdGFzZXRf
#5#ZGlyID0gUGF0aChkYXRhc2V0X2RpcikNCiAgICB0cnk6DQogICAgICAgIHJhdyA9IChkYXRhc2V0
#5#X2RpciAvICJicmlja3MiIC8gIm1hbmlmZXN0Lmpzb24iKS5yZWFkX2J5dGVzKCkNCiAgICAgICAg
#5#c2hhID0gaGFzaGxpYi5zaGEyNTYocmF3KS5oZXhkaWdlc3QoKQ0KICAgICAgICB0cmVlcyA9IGJy
#5#aWNrX3RyZWVzKGpzb24ubG9hZHMocmF3LmRlY29kZSgidXRmLTgiKSkpDQogICAgZXhjZXB0IChP
#5#U0Vycm9yLCBWYWx1ZUVycm9yLCBLZXlFcnJvciwgVHlwZUVycm9yKToNCiAgICAgICAgcmV0dXJu
#5#IEZhbHNlDQogICAgZm9yIGtleSwgZGltcywgY2hhbm5lbHMgaW4gdHJlZXM6DQogICAgICAgIHRy
#5#ZWVfZGlyID0gZGF0YXNldF9kaXIgLyAicGxhbmVzIiAvIGtleSBpZiBrZXkgZWxzZSBkYXRhc2V0
#5#X2RpciAvICJwbGFuZXMiDQogICAgICAgIHRyeToNCiAgICAgICAgICAgIGRvYyA9IGpzb24ubG9h
#5#ZHMoKHRyZWVfZGlyIC8gIm1hbmlmZXN0Lmpzb24iKS5yZWFkX3RleHQoZW5jb2Rpbmc9InV0Zi04
#5#IikpDQogICAgICAgIGV4Y2VwdCAoT1NFcnJvciwgVmFsdWVFcnJvcik6DQogICAgICAgICAgICBy
#5#ZXR1cm4gRmFsc2UNCiAgICAgICAgWCwgWSwgWiA9IGRpbXMNCiAgICAgICAgaWYgKGRvYy5nZXQo
#5#InNjaGVtYSIpICE9IFNDSEVNQSBvciBkb2MuZ2V0KCJjb2RlYyIpICE9IENPREVDDQogICAgICAg
#5#ICAgICAgICAgb3IgZG9jLmdldCgiZGltZW5zaW9ucyIpICE9IHsieCI6IFgsICJ5IjogWSwgInoi
#5#OiBafQ0KICAgICAgICAgICAgICAgIG9yIGRvYy5nZXQoImNoYW5uZWxzIikgIT0gY2hhbm5lbHMN
#5#CiAgICAgICAgICAgICAgICBvciAoZG9jLmdldCgic291cmNlIikgb3Ige30pLmdldCgibWFuaWZl
#5#c3RTaGEyNTYiKSAhPSBzaGEpOg0KICAgICAgICAgICAgcmV0dXJuIEZhbHNlDQogICAgcmV0dXJu
#5#IFRydWUNCg==
:: ---- [6] 2d_importer.py (23502 octets) ----
#6#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwoiIiIKMkQgaW1wb3J0ZXIg4oCUIG9uZSBjb2xvdXIgcGhv
#6#dG9ncmFwaCDihpIgb25lIGAyZGAgZGF0YXNldC4KCklucHV0IDogMkQgVElGRnMgYXMgZXhwb3J0
#6#ZWQgYnkgSW1hZ2VKL0ZpamkgZnJvbSBhIExlaWNhIC5saWYgKGEgY29tcG9zaXRlIG9mCiAgICAg
#6#ICAgdGhyZWUgOC1iaXQgcGxhbmVzIHdpdGggUmVkL0dyZWVuL0JsdWUgTFVUcyksIHBsYWluIFJH
#6#QiBUSUZGcywgb3Igc2luZ2xlCiAgICAgICAgZ3JleXNjYWxlIFRJRkZzLiBObyBaLCBubyBUOiBh
#6#IDJEIGRhdGFzZXQgaXMgYSBwaWN0dXJlLCBub3QgYSB2b2x1bWUuCk91dHB1dDogREFUQV9XRUIv
#6#MmQvPGRhdGFzZXQ+LwogICAgICAgICAgaW1hZ2Uud2VicCAgICAgIG5hdGl2ZSByZXNvbHV0aW9u
#6#LCB3aGF0IHRoZSB2aWV3ZXIgc2hvd3Mgb25jZSBsb2FkZWQKICAgICAgICAgIHByZXZpZXcud2Vi
#6#cCAgICBsb25nIHNpZGUgNjQwIHB4LCBwYWludGVkIGZpcnN0IHNvIHRoZSBwYWdlIG5ldmVyIHdh
#6#aXRzCiAgICAgICAgICB0aHVtYm5haWwud2VicCAgNTEywrIgcGFkZGVkIHNxdWFyZSwgdGhlIGV4
#6#cGxvcmVyL2NhdGFsb2cgY29udmVudGlvbgogICAgICAgICAgbWV0YWRhdGEuanNvbiAgIHR5cGUg
#6#IjJkIiDigJQgc3RhZ2UsIHBpeGVsIHNpemUsIGFjcXVpc2l0aW9uCiAgICAgICAgICBkb3dubG9h
#6#ZC8gICAgICAgKC0td2l0aC1kb3dubG9hZHMpIHRoZSBvcmlnaW5hbCBUSUZGICsgUkVBRE1FLnR4
#6#dAoKRXZlcnl0aGluZyBtZWFzdXJhYmxlIGlzIHJlYWQgZnJvbSB0aGUgZmlsZSwgbmV2ZXIgZ3Vl
#6#c3NlZDogdGhlIHBpeGVsIHNpemUgY29tZXMKZnJvbSB0aGUgVElGRiByZXNvbHV0aW9uIHRhZ3Mg
#6#KEltYWdlSiB3cml0ZXMgdGhlbSBpbiBtaWNyb25zKSBhbmQgdGhlIGFjcXVpc2l0aW9uCmZpZWxk
#6#cyBmcm9tIHRoZSBMZWljYSBibG9jayBJbWFnZUogZW1iZWRzLiBXaGF0IHRoZSBmaWxlIGNhbm5v
#6#dCB0ZWxsIOKAlCB0aGUKcmVwb3J0ZXIgbGluZSwgdGhlIHN0YWluaW5nIOKAlCBpcyB0YWtlbiBm
#6#cm9tIHRoZSBjb21tYW5kIGxpbmUgYW5kIHByZXNlcnZlZCBvbgpyZS1pbXBvcnQgc28gbGFiIGN1
#6#cmF0aW9uIGlzIG5ldmVyIG92ZXJ3cml0dGVuIChzZWUgYG1lcmdlX2N1cmF0ZWRgKS4KCiAgICBw
#6#eXRob24gMmRfaW1wb3J0ZXIucHkgLS1pbnB1dCA8ZGlyfGZpbGUudGlmPiAtLW91dHB1dCBEQVRB
#6#X1dFQiBcCiAgICAgICAgWy0tbGluZSBETEw0eENEMV0gWy0tc3RhaW5pbmcgWC1nYWxdIFstLW9u
#6#bHkgIipFOC4wKiJdIFstLXdpdGgtZG93bmxvYWRzXSBbLS1mb3JjZV0KIiIiCmltcG9ydCBhcmdw
#6#YXJzZQppbXBvcnQgZm5tYXRjaAppbXBvcnQganNvbgppbXBvcnQgb3MKaW1wb3J0IHJlCmltcG9y
#6#dCBzaHV0aWwKaW1wb3J0IHN0cnVjdAppbXBvcnQgc3lzCmZyb20gZGF0ZXRpbWUgaW1wb3J0IGRh
#6#dGV0aW1lCmZyb20gcGF0aGxpYiBpbXBvcnQgUGF0aAoKaW1wb3J0IG51bXB5IGFzIG5wCmZyb20g
#6#UElMIGltcG9ydCBJbWFnZQoKSEVSRSA9IFBhdGgoX19maWxlX18pLnJlc29sdmUoKS5wYXJlbnQK
#6#aWYgc3RyKEhFUkUpIG5vdCBpbiBzeXMucGF0aDoKICAgIHN5cy5wYXRoLmluc2VydCgwLCBzdHIo
#6#SEVSRSkpCiMgT25lIGN1cmF0ZWQta2V5IGxpc3QgYW5kIG9uZSBtZXJnZSBydWxlIGZvciB0aGUg
#6#cGhvdG9ncmFwaCBpbXBvcnRlciBhbmQgdGhlIHZvbHVtZQojIHBpcGVsaW5lLCBzbyBhIHJlLWlt
#6#cG9ydCBwcm90ZWN0cyBleGFjdGx5IHdoYXQgdGhlIGFkbWluIHBhbmVsIGxldHMgdGhlIGxhYiBl
#6#ZGl0Lgpmcm9tIHJ1bl9wcmVwcm9jZXNzIGltcG9ydCBDVVJBVEVEX0tFWVMsIG1lcmdlX2N1cmF0
#6#ZWQsIGF0b21pY193cml0ZV90ZXh0ICAjIG5vcWE6IEU0MDIsRjQwMQoKX192ZXJzaW9uX18gPSAi
#6#MC4xOC4wIgoKIyBUaGUgZGlyZWN0b3J5IGEgZGF0YXNldCBzaXRzIGluIElTIGl0cyB0eXBlOiBE
#6#QVRBX1dFQi8yZC88Zm9sZGVyPiBpcyBkYXRhc2V0ICcyZC88Zm9sZGVyPicuCkRBVEFTRVRfVFlQ
#6#RSA9ICIyZCIKUFJFVklFV19MT05HX1NJREUgPSA2NDAKVEhVTUJfU0laRSA9IDUxMgpUSFVNQl9C
#6#QUNLR1JPVU5EID0gKDgsIDEwLCAxOCkKTkFUSVZFX1FVQUxJVFkgPSA5MApQUkVWSUVXX1FVQUxJ
#6#VFkgPSA4MAoKIyBXZWJQIHN0b3JlcyBlYWNoIHNpZGUgb24gMTQgYml0cy4KV0VCUF9NQVhfU0lE
#6#RSA9IDE2MzgzCgpJSl9NRVRBREFUQV9UQUcgPSA1MDgzOQpJSl9NRVRBREFUQV9DT1VOVFNfVEFH
#6#ID0gNTA4MzgKWF9SRVNPTFVUSU9OX1RBRyA9IDI4MgpZX1JFU09MVVRJT05fVEFHID0gMjgzCklN
#6#QUdFX0RFU0NSSVBUSU9OX1RBRyA9IDI3MAoKCiMg4pSA4pSAIEltYWdlSiBtZXRhZGF0YSDilIDi
#6#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#6#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#6#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#6#lIDilIAKZGVmIHJlYWRfaWpfbWV0YWRhdGEoaW0pIC0+IGRpY3Q6CiAgICAiIiJEZWNvZGUgdGhl
#6#IEltYWdlSiBwcml2YXRlIHRhZyBpbnRvIHsnaW5mbyc6IFtzdHJdLCAnbGFibCc6IFtzdHJdLAog
#6#ICAgJ2x1dHMnOiBbYnl0ZXNdLCAncmFuZyc6IFtieXRlc119LiBBYnNlbnQgb3IgbWFsZm9ybWVk
#6#IOKGkiB7fS4iIiIKICAgIGJsb2IgPSBpbS50YWdfdjIuZ2V0KElKX01FVEFEQVRBX1RBRykKICAg
#6#IGNvdW50cyA9IGltLnRhZ192Mi5nZXQoSUpfTUVUQURBVEFfQ09VTlRTX1RBRykKICAgIGlmIG5v
#6#dCBibG9iIG9yIG5vdCBjb3VudHMgb3IgYnl0ZXMoYmxvYls6NF0pICE9IGIiSUpJSiI6CiAgICAg
#6#ICAgcmV0dXJuIHt9CiAgICBibG9iID0gYnl0ZXMoYmxvYikKICAgIGhlYWRlcl9sZW4gPSBjb3Vu
#6#dHNbMF0KICAgIGtpbmRzID0gWyhibG9iW3A6cCArIDRdLCBzdHJ1Y3QudW5wYWNrKCI+SSIsIGJs
#6#b2JbcCArIDQ6cCArIDhdKVswXSkKICAgICAgICAgICAgIGZvciBwIGluIHJhbmdlKDQsIGhlYWRl
#6#cl9sZW4sIDgpXQogICAgb3V0LCBwb3MsIGlkeCA9IHt9LCBoZWFkZXJfbGVuLCAxCiAgICBmb3Ig
#6#a2luZCwgbiBpbiBraW5kczoKICAgICAgICBpdGVtcyA9IFtdCiAgICAgICAgZm9yIF8gaW4gcmFu
#6#Z2Uobik6CiAgICAgICAgICAgIGlmIGlkeCA+PSBsZW4oY291bnRzKToKICAgICAgICAgICAgICAg
#6#IHJldHVybiBvdXQKICAgICAgICAgICAgY2h1bmsgPSBibG9iW3Bvczpwb3MgKyBjb3VudHNbaWR4
#6#XV0KICAgICAgICAgICAgcG9zICs9IGNvdW50c1tpZHhdCiAgICAgICAgICAgIGlkeCArPSAxCiAg
#6#ICAgICAgICAgIGl0ZW1zLmFwcGVuZChjaHVuay5kZWNvZGUoInV0Zi0xNi1iZSIsICJyZXBsYWNl
#6#IikKICAgICAgICAgICAgICAgICAgICAgICAgIGlmIGtpbmQgaW4gKGIiaW5mbyIsIGIibGFibCIp
#6#IGVsc2UgY2h1bmspCiAgICAgICAgb3V0W2tpbmQuZGVjb2RlKCJhc2NpaSIsICJyZXBsYWNlIild
#6#ID0gaXRlbXMKICAgIHJldHVybiBvdXQKCgpkZWYgcmVhZF9wbGFuZXMoaW0sIGRlc2NyaXB0aW9u
#6#OiBzdHIgPSAiIikgLT4gbGlzdDoKICAgICIiIlRoZSBjb2xvdXIgcGxhbmVzIG9mIHRoZSBwaWN0
#6#dXJlLiBBbiBJbWFnZUogaHlwZXJzdGFjayBzdG9yZXMgaXRzIHBhZ2VzIGluCiAgICBjaGFubmVs
#6#LWZhc3Rlc3Qgb3JkZXIsIHNvIHRoZSBmaXJzdCBgY2hhbm5lbHM9YCBwYWdlcyBhcmUgb25lIGNv
#6#bXBsZXRlIGNvbXBvc2l0ZTsKICAgIHRoZSBmdXJ0aGVyIHBhZ2VzIG9mIGEgWiBvciBUIHN0YWNr
#6#IGFyZSBvdGhlciBwaWN0dXJlcywgbm90IG1vcmUgY29sb3VyLCBhbmQgYWRkaW5nCiAgICB0aGVt
#6#IGluIHdvdWxkIGJsZW5kIHNldmVyYWwgaW1hZ2VzIGludG8gb25lLiIiIgogICAgbl9mcmFtZXMg
#6#PSBnZXRhdHRyKGltLCAibl9mcmFtZXMiLCAxKQogICAgbSA9IHJlLnNlYXJjaChyIl5jaGFubmVs
#6#cz0oXGQrKSIsIGRlc2NyaXB0aW9uLCByZS5NVUxUSUxJTkUpCiAgICBuX3BsYW5lcyA9IG1pbihu
#6#X2ZyYW1lcywgaW50KG0uZ3JvdXAoMSkpKSBpZiBtIGVsc2Ugbl9mcmFtZXMKICAgIGlmIG5fcGxh
#6#bmVzIDwgbl9mcmFtZXM6CiAgICAgICAgcHJpbnQoZiIgIFtub3RlXSB7bl9mcmFtZXN9IHBhZ2Vz
#6#LCBjb21wb3NpdGUgb2YgdGhlIGZpcnN0IHtuX3BsYW5lc30gKGNoYW5uZWxzPXtuX3BsYW5lc30p
#6#OyAiCiAgICAgICAgICAgICAgZiJ0aGUgb3RoZXIgc2xpY2VzL2ZyYW1lcyBhcmUgbm90IHBhcnQg
#6#b2YgdGhpcyBwaWN0dXJlIikKICAgIHBsYW5lcyA9IFtdCiAgICBmb3IgaSBpbiByYW5nZShuX3Bs
#6#YW5lcyk6CiAgICAgICAgaW0uc2VlayhpKQogICAgICAgIHBsYW5lcy5hcHBlbmQobnAuYXJyYXko
#6#aW0pKQogICAgaW0uc2VlaygwKQogICAgcmV0dXJuIHBsYW5lcwoKCmRlZiBjb21wb3NlX3JnYihw
#6#bGFuZXM6IGxpc3QsIGx1dHM6IGxpc3QpIC0+IG5wLm5kYXJyYXk6CiAgICAiIiJBZGRpdGl2ZSBj
#6#b21wb3NpdGUsIGV4YWN0bHkgd2hhdCBJbWFnZUoncyBjb21wb3NpdGUgbW9kZSBkaXNwbGF5czoK
#6#ICAgIG91dCA9IM6jIGx1dF9jW3BsYW5lX2NdLiBQbGFpbiBSR0IgYW5kIGdyZXlzY2FsZSBmaWxl
#6#cyBwYXNzIHN0cmFpZ2h0IHRocm91Z2guIiIiCiAgICBmaXJzdCA9IHBsYW5lc1swXQogICAgaWYg
#6#Zmlyc3QubmRpbSA9PSAzOgogICAgICAgIHJldHVybiBucC5hc2NvbnRpZ3VvdXNhcnJheShmaXJz
#6#dFs6LCA6LCA6M10pCiAgICBhY2MgPSBucC56ZXJvcyhmaXJzdC5zaGFwZSArICgzLCksIGR0eXBl
#6#PW5wLmZsb2F0MzIpCiAgICBmb3IgYywgcGxhbmUgaW4gZW51bWVyYXRlKHBsYW5lcyk6CiAgICAg
#6#ICAgbHV0ID0gX2x1dF90YWJsZShsdXRzLCBjLCBsZW4ocGxhbmVzKSkKICAgICAgICBhY2MgKz0g
#6#bHV0W190b191aW50OChwbGFuZSldCiAgICByZXR1cm4gbnAuY2xpcChhY2MsIDAsIDI1NSkuYXN0
#6#eXBlKG5wLnVpbnQ4KQoKCmRlZiBfbHV0X3RhYmxlKGx1dHM6IGxpc3QsIGluZGV4OiBpbnQsIG5f
#6#cGxhbmVzOiBpbnQpIC0+IG5wLm5kYXJyYXk6CiAgICAiIiIyNTbDlzMgY29sb3VyIHRhYmxlIGZv
#6#ciBwbGFuZSBgaW5kZXhgLiBJbWFnZUogc3RvcmVzIFIsRyxCIHJhbXBzIG9mIDI1NgogICAgYnl0
#6#ZXMgZWFjaDsgd2l0aG91dCBMVVRzLCB0aHJlZSBwbGFuZXMgYXJlIHRha2VuIGFzIFIvRy9CLCBv
#6#bmUgYXMgZ3JleS4iIiIKICAgIGlmIGluZGV4IDwgbGVuKGx1dHMpIGFuZCBsZW4obHV0c1tpbmRl
#6#eF0pID09IDc2ODoKICAgICAgICByYXcgPSBucC5mcm9tYnVmZmVyKGx1dHNbaW5kZXhdLCBkdHlw
#6#ZT1ucC51aW50OCkKICAgICAgICByZXR1cm4gcmF3LnJlc2hhcGUoMywgMjU2KS5ULmFzdHlwZShu
#6#cC5mbG9hdDMyKQogICAgcmFtcCA9IG5wLmFyYW5nZSgyNTYsIGR0eXBlPW5wLmZsb2F0MzIpCiAg
#6#ICB0YWJsZSA9IG5wLnplcm9zKCgyNTYsIDMpLCBkdHlwZT1ucC5mbG9hdDMyKQogICAgaWYgbl9w
#6#bGFuZXMgPT0gMzoKICAgICAgICB0YWJsZVs6LCBpbmRleF0gPSByYW1wCiAgICBlbHNlOgogICAg
#6#ICAgIHRhYmxlWzpdID0gcmFtcFs6LCBOb25lXQogICAgcmV0dXJuIHRhYmxlCgoKZGVmIF90b191
#6#aW50OChwbGFuZTogbnAubmRhcnJheSkgLT4gbnAubmRhcnJheToKICAgIGlmIHBsYW5lLmR0eXBl
#6#ID09IG5wLnVpbnQ4OgogICAgICAgIHJldHVybiBwbGFuZQogICAgaGkgPSBmbG9hdChwbGFuZS5t
#6#YXgoKSkgb3IgMS4wCiAgICByZXR1cm4gKHBsYW5lLmFzdHlwZShucC5mbG9hdDMyKSAqICgyNTUu
#6#MCAvIGhpKSkuYXN0eXBlKG5wLnVpbnQ4KQoKCiMg4pSA4pSAIENhbGlicmF0aW9uIOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgApkZWYgcGl4ZWxfc2l6ZV91bShpbSwgZGVzY3JpcHRpb246IHN0cikgLT4g
#6#dHVwbGU6CiAgICAiIiIoKMK1bSBwZXIgcGl4ZWwgYWxvbmcgeCwgYWxvbmcgeSksIHN0YXR1cyku
#6#IEltYWdlSiB3cml0ZXMgWC9ZUmVzb2x1dGlvbiBpbiBwaXhlbHMKICAgIHBlciBgdW5pdGA7IHdl
#6#IG9ubHkgdHJ1c3QgdGhlbSB3aGVuIHRoZSB1bml0IGlzIGRlY2xhcmVkIGluIG1pY3JvbnMuIEEg
#6#ZmlsZSB3aXRoCiAgICBYUmVzb2x1dGlvbiBhbG9uZSBoYXMgc3F1YXJlIHBpeGVscy4iIiIKICAg
#6#IHhyZXMgPSBpbS50YWdfdjIuZ2V0KFhfUkVTT0xVVElPTl9UQUcpCiAgICB5cmVzID0gaW0udGFn
#6#X3YyLmdldChZX1JFU09MVVRJT05fVEFHKSBvciB4cmVzCiAgICB1bml0ID0gcmUuc2VhcmNoKHIi
#6#XnVuaXQ9KFxTKykiLCBkZXNjcmlwdGlvbiwgcmUuTVVMVElMSU5FKQogICAgdW5pdCA9IHVuaXQu
#6#Z3JvdXAoMSkubG93ZXIoKSBpZiB1bml0IGVsc2UgIiIKICAgIGlmIHhyZXMgYW5kIGZsb2F0KHhy
#6#ZXMpID4gMCBhbmQgdW5pdCBpbiBNSUNST05fVU5JVFM6CiAgICAgICAgeSA9IGZsb2F0KHlyZXMp
#6#IGlmIHlyZXMgYW5kIGZsb2F0KHlyZXMpID4gMCBlbHNlIGZsb2F0KHhyZXMpCiAgICAgICAgcmV0
#6#dXJuICgxLjAgLyBmbG9hdCh4cmVzKSwgMS4wIC8geSksICJleGFjdCIKICAgIHJldHVybiBOb25l
#6#LCAidW5rbm93biIKCgpNSUNST05fVU5JVFMgPSAoIm1pY3JvbiIsICJtaWNyb25zIiwgInVtIiwg
#6#Ilx1MDBiNW0iLCAiXHUwM2JjbSIsICJcXHUwMGI1bSIpCgoKIyDilIDilIAgTGVpY2EgYmxvY2sg
#6#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#6#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#6#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#6#4pSA4pSA4pSA4pSA4pSA4pSA4pSACkxFSUNBX0ZJRUxEUyA9IHsKICAgICJab29tIjogKCJ6b29t
#6#IiwgZmxvYXQpLAogICAgIk1hZ25pZmljYXRpb24iOiAoIm1hZ25pZmljYXRpb24iLCBmbG9hdCks
#6#CiAgICAiT2JqZWN0aXZlTmFtZSI6ICgib2JqZWN0aXZlIiwgc3RyKSwKICAgICJOdW1lcmljYWxB
#6#cGVydHVyZSI6ICgibnVtZXJpY2FsQXBlcnR1cmUiLCBmbG9hdCksCiAgICAiRXhwb3N1cmVUaW1l
#6#IjogKCJleHBvc3VyZVMiLCBmbG9hdCksCiAgICAiSW5kaXZpZHVhbENhbWVyYUluZm98R2FpbiI6
#6#ICgiZ2FpbiIsIGZsb2F0KSwKICAgICJNaWNyb3Njb3BlTW9kZWwiOiAoIm1pY3Jvc2NvcGUiLCBz
#6#dHIpLAogICAgIkZ1bGxDYW1lcmFOYW1lIjogKCJjYW1lcmEiLCBzdHIpLAp9CgoKZGVmIGxlaWNh
#6#X2ZpZWxkcyhpbmZvOiBzdHIsIHNlcmllczogc3RyKSAtPiBkaWN0OgogICAgIiIiQWNxdWlzaXRp
#6#b24gc2V0dGluZ3Mgb2Ygb25lIHNlcmllcy4gVGhlIExlaWNhIGJsb2NrIHJlcGVhdHMgYSBrZXkg
#6#b25jZSBwZXIKICAgIGpvYiBibG9jayAoYExETV9CbG9ja1/igKZgKSBhbmQgb25jZSBhdCB0aGUg
#6#dG9wIGxldmVsIGZvciB0aGUgZXhwb3N1cmUgdGhhdCB3YXMKICAgIGFjdHVhbGx5IHRha2VuOyB0
#6#aGUgdG9wLWxldmVsIGxpbmUgd2lucywgZmlyc3QgYmxvY2sgbGluZSBhcyBmYWxsYmFjay4iIiIK
#6#ICAgICMgRXZlcnkgbGluZSBvZiBhIHNlcmllcyBzdGFydHMgd2l0aCBgPHNlcmllcz4gSW1hZ2Xi
#6#gKZgOyB0aGUgdHJhaWxpbmcgIkltYWdlIgogICAgIyBrZWVwcyBgRTguMCB4My4yIDI0MDkxM2Ag
#6#ZnJvbSBhbHNvIG1hdGNoaW5nIGBFOC4wIHgzLjIgMjQwOTEzIDJgLgogICAgcHJlZml4ID0gc2Vy
#6#aWVzICsgIiBJbWFnZSIKICAgIGxpbmVzID0gW2xbbGVuKHNlcmllcykgKyAxOl0gZm9yIGwgaW4g
#6#aW5mby5zcGxpdGxpbmVzKCkgaWYgbC5zdGFydHN3aXRoKHByZWZpeCldCiAgICBvdXQgPSB7fQog
#6#ICAgZm9yIHN1ZmZpeCwgKG5hbWUsIGNhc3QpIGluIExFSUNBX0ZJRUxEUy5pdGVtcygpOgogICAg
#6#ICAgIHZhbHVlID0gX3BpY2tfdmFsdWUobGluZXMsIHN1ZmZpeCkKICAgICAgICBpZiB2YWx1ZSBp
#6#cyBub3QgTm9uZToKICAgICAgICAgICAgb3V0W25hbWVdID0gdmFsdWUgaWYgY2FzdCBpcyBzdHIg
#6#ZWxzZSBfc2FmZV9mbG9hdCh2YWx1ZSkKICAgIGlmICJleHBvc3VyZVMiIGluIG91dDoKICAgICAg
#6#ICBvdXRbImV4cG9zdXJlTXMiXSA9IHJvdW5kKG91dC5wb3AoImV4cG9zdXJlUyIpICogMTAwMC4w
#6#LCAzKQogICAgaWYgb3V0LmdldCgiY2FtZXJhIik6CiAgICAgICAgb3V0WyJjYW1lcmEiXSA9IG91
#6#dFsiY2FtZXJhIl0uc3BsaXQoIi0iKVswXQogICAgcmV0dXJuIHtrOiB2IGZvciBrLCB2IGluIG91
#6#dC5pdGVtcygpIGlmIHYgbm90IGluIChOb25lLCAiIiwgMC4wKX0KCgpkZWYgX3BpY2tfdmFsdWUo
#6#bGluZXM6IGxpc3QsIHN1ZmZpeDogc3RyKToKICAgICIiIkxBUyBYIHdyaXRlcyAiMCIgZm9yIGEg
#6#c2V0dGluZyB0aGF0IGRvZXMgbm90IGFwcGx5IHRvIGEgYmxvY2s7IHRob3NlCiAgICBwbGFjZWhv
#6#bGRlcnMgbmV2ZXIgYmVhdCBhIHJlYWwgdmFsdWUuIiIiCiAgICBoaXRzID0gWyhrLCB2LnN0cmlw
#6#KCkpIGZvciBrLCBfLCB2IGluIChsLnBhcnRpdGlvbigiID0gIikgZm9yIGwgaW4gbGluZXMpCiAg
#6#ICAgICAgICAgIGlmIGsucnN0cmlwKCkuZW5kc3dpdGgoc3VmZml4KSBhbmQgdi5zdHJpcCgpIG5v
#6#dCBpbiAoIiIsICIwIildCiAgICBpZiBub3QgaGl0czoKICAgICAgICByZXR1cm4gTm9uZQogICAg
#6#dG9wID0gW3YgZm9yIGssIHYgaW4gaGl0cyBpZiAiTERNX0Jsb2NrIiBub3QgaW4ga10KICAgIHJl
#6#dHVybiAodG9wIG9yIFt2IGZvciBfLCB2IGluIGhpdHNdKVswXQoKCmRlZiBfc2FmZV9mbG9hdCh0
#6#ZXh0OiBzdHIpOgogICAgdHJ5OgogICAgICAgIHJldHVybiBmbG9hdCh0ZXh0KQogICAgZXhjZXB0
#6#IChUeXBlRXJyb3IsIFZhbHVlRXJyb3IpOgogICAgICAgIHJldHVybiBOb25lCgoKIyDilIDilIAg
#6#RmlsZS1uYW1lIGNvbnZlbnRpb25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgApkZWYgX2xvYWRfc3RhZ2VfcGFyc2VyKCk6CiAgICAiIiJUaGUgdm9sdW1l
#6#IHBpcGVsaW5lJ3MgZW1icnlvbmljLWRheSBwYXJzZXIgKDQtY2F0YWxvZ19nZW5lcmF0b3IuX3Bh
#6#cnNlX3N0YWdlKSwgc28KICAgIGEgcGhvdG9ncmFwaCBhbmQgYSB2b2x1bWUgb2YgdGhlIHNhbWUg
#6#ZW1icnlvIHJlYWQgb25lIHN0YWdlIGZyb20gb25lIHNwZWxsaW5nCiAgICAoRTgtNSwgRTguNSwg
#6#RTg1IC0+IEU4LjU7IEUxMC01LCBFMTAuNSwgRTEwNSAtPiBFMTAuNSkuIiIiCiAgICBpbXBvcnQg
#6#aW1wb3J0bGliLnV0aWwKICAgIHNwZWMgPSBpbXBvcnRsaWIudXRpbC5zcGVjX2Zyb21fZmlsZV9s
#6#b2NhdGlvbigibHVtZW5fY2F0YWxvZ19nZW5lcmF0b3IiLAogICAgICAgICAgICAgICAgICAgICAg
#6#ICAgICAgICAgICAgICAgICAgICAgICAgICAgIHN0cihIRVJFIC8gIjQtY2F0YWxvZ19nZW5lcmF0
#6#b3IucHkiKSkKICAgIG1vZHVsZSA9IGltcG9ydGxpYi51dGlsLm1vZHVsZV9mcm9tX3NwZWMoc3Bl
#6#YykKICAgIHNwZWMubG9hZGVyLmV4ZWNfbW9kdWxlKG1vZHVsZSkKICAgIHJldHVybiBtb2R1bGUu
#6#X3BhcnNlX3N0YWdlCgoKX1BBUlNFX1NUQUdFID0gX2xvYWRfc3RhZ2VfcGFyc2VyKCkKCgpkZWYg
#6#X3N0YWdlX29mKHRleHQ6IHN0cik6CiAgICAiIiIoZGlzcGxheSwgbnVtZXJpYykgb2YgdGhlIHN0
#6#YWdlIHRva2VuIGluIGB0ZXh0YCwgb3IgTm9uZSB3aGVuIGl0IGNhcnJpZXMgbm9uZS4iIiIKICAg
#6#ICMgQnJhY2tldHMgY291bnQgYXMgc2VwYXJhdG9ycywgYXMgdGhleSBkaWQgZm9yIHRoZSBwaG90
#6#b2dyYXBoJ3MgZm9ybWVyIFxiIHJ1bGUuCiAgICBkaXNwbGF5LCBudW1lcmljID0gX1BBUlNFX1NU
#6#QUdFKHJlLnN1YihyIlsoKVxbXF1dIiwgIiAiLCB0ZXh0IG9yICIiKSkKICAgIHJldHVybiBOb25l
#6#IGlmIGRpc3BsYXkgPT0gIlVua25vd24iIGVsc2UgKGRpc3BsYXksIG51bWVyaWMpCgoKWk9PTV9S
#6#WCA9IHJlLmNvbXBpbGUociJcYngoXGQrKD86Wy4sXVxkKyk/KVxiIiwgcmUuSUdOT1JFQ0FTRSkK
#6#REFURV9SWCA9IHJlLmNvbXBpbGUociJcYihcZHs2fSlcYiIpCkxJTkVfUlggPSByZS5jb21waWxl
#6#KHIiXGIoW0EtWmEtejAtOV0reFtBLVphLXpdW0EtWmEtejAtOV0qKVxiIikKCgpkZWYgcGFyc2Vf
#6#ZmlsZW5hbWUoc3RlbTogc3RyLCBsaW5lX292ZXJyaWRlOiBzdHIgPSBOb25lKSAtPiBkaWN0Ogog
#6#ICAgIiIiYDxsaWY+IC0gPHN0YWdlPiB4PHpvb20+IDxkaXNzZWN0aW9uIHl5bW1kZD4gWzxuPiBb
#6#PG0+XV1gIGFzIHRoZSBsYWIgbmFtZXMKICAgIGl0cyBleHBvcnRzLiBNaXNzaW5nIHBhcnRzIHN0
#6#YXkgTm9uZTsgbm90aGluZyBpcyBpbnZlbnRlZC4iIiIKICAgIGxpZiwgc2VwLCBzZXJpZXMgPSBz
#6#dGVtLnBhcnRpdGlvbigiLmxpZiAtICIpCiAgICBpZiBub3Qgc2VwOgogICAgICAgIGxpZiwgc2Vy
#6#aWVzID0gIiIsIHN0ZW0KICAgIHN0YWdlID0gX3N0YWdlX29mKHNlcmllcykgb3IgX3N0YWdlX29m
#6#KGxpZikKICAgIHpvb21fbSA9IFpPT01fUlguc2VhcmNoKHNlcmllcykKICAgIGRhdGVzID0gW2Qg
#6#Zm9yIGQgaW4gREFURV9SWC5maW5kYWxsKHNlcmllcykgaWYgX3ZhbGlkX3l5bW1kZChkKV0KICAg
#6#IHRhaWwgPSBzZXJpZXNbem9vbV9tLmVuZCgpOl0gaWYgem9vbV9tIGVsc2UgIiIKICAgIGluZGV4
#6#ID0gIiAiLmpvaW4odCBmb3IgdCBpbiB0YWlsLnNwbGl0KCkgaWYgdC5pc2RpZ2l0KCkgYW5kIHQg
#6#bm90IGluIGRhdGVzKQogICAgbGluZV9tID0gTElORV9SWC5zZWFyY2gobGlmKSBvciBMSU5FX1JY
#6#LnNlYXJjaChzZXJpZXMpCiAgICByZXR1cm4gewogICAgICAgICJsaWYiOiAobGlmICsgIi5saWYi
#6#KSBpZiBsaWYgZWxzZSBOb25lLAogICAgICAgICJzZXJpZXMiOiBzZXJpZXMuc3RyaXAoKSwKICAg
#6#ICAgICAic3RhZ2UiOiBzdGFnZVswXSBpZiBzdGFnZSBlbHNlIE5vbmUsCiAgICAgICAgInN0YWdl
#6#TnVtZXJpYyI6IHN0YWdlWzFdIGlmIHN0YWdlIGVsc2UgTm9uZSwKICAgICAgICAiem9vbSI6IGZs
#6#b2F0KHpvb21fbS5ncm91cCgxKS5yZXBsYWNlKCIsIiwgIi4iKSkgaWYgem9vbV9tIGVsc2UgTm9u
#6#ZSwKICAgICAgICAiZGlzc2VjdGlvbkRhdGUiOiBfaXNvX2RhdGUoZGF0ZXNbMF0pIGlmIGRhdGVz
#6#IGVsc2UgTm9uZSwKICAgICAgICAiaW5kZXgiOiBpbmRleCBvciBOb25lLAogICAgICAgICJsaW5l
#6#IjogbGluZV9vdmVycmlkZSBvciAobGluZV9tLmdyb3VwKDEpIGlmIGxpbmVfbSBlbHNlIE5vbmUp
#6#LAogICAgfQoKCmRlZiBfdmFsaWRfeXltbWRkKHRleHQ6IHN0cikgLT4gYm9vbDoKICAgIHRyeToK
#6#ICAgICAgICBkYXRldGltZS5zdHJwdGltZSh0ZXh0LCAiJXklbSVkIikKICAgICAgICByZXR1cm4g
#6#VHJ1ZQogICAgZXhjZXB0IFZhbHVlRXJyb3I6CiAgICAgICAgcmV0dXJuIEZhbHNlCgoKZGVmIF9p
#6#c29fZGF0ZSh5eW1tZGQ6IHN0cikgLT4gc3RyOgogICAgcmV0dXJuIGRhdGV0aW1lLnN0cnB0aW1l
#6#KHl5bW1kZCwgIiV5JW0lZCIpLnN0cmZ0aW1lKCIlWS0lbS0lZCIpCgoKZGVmIGRhdGFzZXRfZm9s
#6#ZGVyX25hbWUocGFyc2VkOiBkaWN0KSAtPiBzdHI6CiAgICAiIiJgPGxpbmU+LTxzdGFnZT4teDx6
#6#b29tPi08eXltbWRkPi08aW5kZXg+YCwgc3RhZ2Ugd2l0aG91dCBpdHMgZG90CiAgICAoRTcuNzUg
#6#4oaSIEU3NzUpIGFzIHRoZSBwbGF0Zm9ybSdzIG90aGVyIGRhdGFzZXRzIHNwZWxsIGl0LiIiIgog
#6#ICAgcGFydHMgPSBbcGFyc2VkLmdldCgibGluZSIpLAogICAgICAgICAgICAgcGFyc2VkWyJzdGFn
#6#ZSJdLnJlcGxhY2UoIi4iLCAiIikgaWYgcGFyc2VkLmdldCgic3RhZ2UiKSBlbHNlIE5vbmUsCiAg
#6#ICAgICAgICAgICBmInh7cGFyc2VkWyd6b29tJ106Z30iIGlmIHBhcnNlZC5nZXQoInpvb20iKSBl
#6#bHNlIE5vbmUsCiAgICAgICAgICAgICBwYXJzZWRbImRpc3NlY3Rpb25EYXRlIl0ucmVwbGFjZSgi
#6#LSIsICIiKVsyOl0gaWYgcGFyc2VkLmdldCgiZGlzc2VjdGlvbkRhdGUiKSBlbHNlIE5vbmUsCiAg
#6#ICAgICAgICAgICBwYXJzZWQuZ2V0KCJpbmRleCIpXQogICAgaWYgbm90IChwYXJzZWQuZ2V0KCJ6
#6#b29tIikgb3IgcGFyc2VkLmdldCgiZGlzc2VjdGlvbkRhdGUiKSk6CiAgICAgICAgcGFydHMuYXBw
#6#ZW5kKHBhcnNlZC5nZXQoInNlcmllcyIpKQogICAgcmV0dXJuIHNsdWdpZnkoIi0iLmpvaW4ocCBm
#6#b3IgcCBpbiBwYXJ0cyBpZiBwKSkgb3IgInBob3RvZ3JhcGgiCgoKZGVmIHNsdWdpZnkodGV4dDog
#6#c3RyKSAtPiBzdHI6CiAgICByZXR1cm4gcmUuc3ViKHIiLXsyLH0iLCAiLSIsIHJlLnN1YihyIlte
#6#QS1aYS16MC05Ll8tXSsiLCAiLSIsIHRleHQpKS5zdHJpcCgiLS4iKQoKCiMg4pSA4pSAIE91dHB1
#6#dHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#6#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#6#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#6#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmRlZiB3cml0ZV9pbWFnZXMocmdi
#6#OiBucC5uZGFycmF5LCBvdXRfZGlyOiBQYXRoLCBsb3NzbGVzczogYm9vbCA9IEZhbHNlKSAtPiBk
#6#aWN0OgogICAgaCwgdyA9IHJnYi5zaGFwZVs6Ml0KICAgIGlmIG1heCh3LCBoKSA+IFdFQlBfTUFY
#6#X1NJREU6CiAgICAgICAgcmFpc2UgVmFsdWVFcnJvcihmInt3fXh7aH0gcHg6IFdlYlAgaXMgbGlt
#6#aXRlZCB0byB7V0VCUF9NQVhfU0lERX0gcHggcGVyIHNpZGUg4oCUICIKICAgICAgICAgICAgICAg
#6#ICAgICAgICAgIGYicmVkdWNlIHRoZSBleHBvcnQgYmVmb3JlIGltcG9ydGluZyBpdCIpCiAgICBu
#6#YXRpdmUgPSBJbWFnZS5mcm9tYXJyYXkocmdiLCBtb2RlPSJSR0IiKQogICAgIyBMb3NzeSBXZWJQ
#6#IGFsd2F5cyBzdWJzYW1wbGVzIGNocm9tYSA0OjI6MCwgd2hpY2ggcGVydHVyYnMgdGhlIHBlci1w
#6#aXhlbCBCL1IgcmF0aW8KICAgICMgdGhlIHN0YWluIGlzb2xhdGlvbiByZWFkcyBhdCBzaGFycCBl
#6#ZGdlczsgLS1sb3NzbGVzcyBrZWVwcyBldmVyeSBwaXhlbCBleGFjdC4KICAgIGlmIGxvc3NsZXNz
#6#OgogICAgICAgIG5hdGl2ZS5zYXZlKG91dF9kaXIgLyAiaW1hZ2Uud2VicCIsICJXRUJQIiwgbG9z
#6#c2xlc3M9VHJ1ZSwgbWV0aG9kPTYpCiAgICBlbHNlOgogICAgICAgIG5hdGl2ZS5zYXZlKG91dF9k
#6#aXIgLyAiaW1hZ2Uud2VicCIsICJXRUJQIiwgcXVhbGl0eT1OQVRJVkVfUVVBTElUWSwgbWV0aG9k
#6#PTYpCgogICAgcHJldmlldyA9IG5hdGl2ZS5jb3B5KCkKICAgIHByZXZpZXcudGh1bWJuYWlsKChQ
#6#UkVWSUVXX0xPTkdfU0lERSwgUFJFVklFV19MT05HX1NJREUpLCBJbWFnZS5SZXNhbXBsaW5nLkxB
#6#TkNaT1MpCiAgICBwcmV2aWV3LnNhdmUob3V0X2RpciAvICJwcmV2aWV3LndlYnAiLCAiV0VCUCIs
#6#IHF1YWxpdHk9UFJFVklFV19RVUFMSVRZLCBtZXRob2Q9NikKCiAgICBfd3JpdGVfc3F1YXJlX3Ro
#6#dW1ibmFpbChuYXRpdmUsIG91dF9kaXIgLyAidGh1bWJuYWlsLndlYnAiKQogICAgcmV0dXJuIHsi
#6#bmF0aXZlIjogImltYWdlLndlYnAiLCAid2lkdGgiOiBuYXRpdmUud2lkdGgsICJoZWlnaHQiOiBu
#6#YXRpdmUuaGVpZ2h0LAogICAgICAgICAgICAicHJldmlldyI6ICJwcmV2aWV3LndlYnAiLCAicHJl
#6#dmlld1dpZHRoIjogcHJldmlldy53aWR0aCwKICAgICAgICAgICAgInByZXZpZXdIZWlnaHQiOiBw
#6#cmV2aWV3LmhlaWdodH0KCgpkZWYgX3dyaXRlX3NxdWFyZV90aHVtYm5haWwoaW1nOiBJbWFnZS5J
#6#bWFnZSwgcGF0aDogUGF0aCkgLT4gTm9uZToKICAgIHNjYWxlZCA9IGltZy5jb3B5KCkKICAgIHNj
#6#YWxlZC50aHVtYm5haWwoKFRIVU1CX1NJWkUsIFRIVU1CX1NJWkUpLCBJbWFnZS5SZXNhbXBsaW5n
#6#LkxBTkNaT1MpCiAgICBjYW52YXMgPSBJbWFnZS5uZXcoIlJHQiIsIChUSFVNQl9TSVpFLCBUSFVN
#6#Ql9TSVpFKSwgVEhVTUJfQkFDS0dST1VORCkKICAgIGNhbnZhcy5wYXN0ZShzY2FsZWQsICgoVEhV
#6#TUJfU0laRSAtIHNjYWxlZC53aWR0aCkgLy8gMiwgKFRIVU1CX1NJWkUgLSBzY2FsZWQuaGVpZ2h0
#6#KSAvLyAyKSkKICAgIGNhbnZhcy5zYXZlKHBhdGgsICJXRUJQIiwgcXVhbGl0eT04OCwgbWV0aG9k
#6#PTYpCgoKZGVmIGJ1aWxkX21ldGFkYXRhKGZvbGRlcjogc3RyLCBwYXJzZWQ6IGRpY3QsIGltYWdl
#6#OiBkaWN0LCBweF91bSwgY2FsX3N0YXR1czogc3RyLAogICAgICAgICAgICAgICAgICAgYWNxdWlz
#6#aXRpb246IGRpY3QsIHNvdXJjZTogUGF0aCwgc3RhaW5pbmc6IHN0cikgLT4gZGljdDoKICAgIG5v
#6#dyA9IGRhdGV0aW1lLm5vdygpLmlzb2Zvcm1hdCgpCiAgICB3LCBoID0gaW1hZ2VbIndpZHRoIl0s
#6#IGltYWdlWyJoZWlnaHQiXQogICAgcHhfeCwgcHhfeSA9IHB4X3VtIGlmIHB4X3VtIGVsc2UgKE5v
#6#bmUsIE5vbmUpCiAgICBwaHlzaWNhbCA9ICh7IngiOiByb3VuZCh3ICogcHhfeCwgMyksICJ5Ijog
#6#cm91bmQoaCAqIHB4X3ksIDMpfSBpZiBweF91bSBlbHNlIE5vbmUpCiAgICBzdGFnZV90eHQgPSBw
#6#YXJzZWRbInN0YWdlIl0gb3IgIlVua25vd24iCiAgICByZXR1cm4gewogICAgICAgICJpZCI6IGYi
#6#e0RBVEFTRVRfVFlQRX0ve2ZvbGRlcn0iLCAibmFtZSI6IGZvbGRlciwgInR5cGUiOiBEQVRBU0VU
#6#X1RZUEUsCiAgICAgICAgInN0YWdlIjogc3RhZ2VfdHh0LCAic3RhZ2VOdW1lcmljIjogcGFyc2Vk
#6#WyJzdGFnZU51bWVyaWMiXSBvciAwLjAsCiAgICAgICAgImVtYnJ5byI6IE5vbmUsICJsaW5lIjog
#6#cGFyc2VkLmdldCgibGluZSIpLCAic3RhaW5pbmciOiBzdGFpbmluZyBvciAiIiwKICAgICAgICAi
#6#ZGF0ZSI6IHBhcnNlZC5nZXQoImRpc3NlY3Rpb25EYXRlIiksCiAgICAgICAgImRpbWVuc2lvbnMi
#6#OiB7IngiOiB3LCAieSI6IGgsICJ6IjogMSwgImMiOiAzLCAidCI6IDF9LAogICAgICAgICJwaXhl
#6#bFNpemVVbSI6ICh7IngiOiByb3VuZChweF94LCA2KSwgInkiOiByb3VuZChweF95LCA2KX0gaWYg
#6#cHhfdW0gZWxzZSBOb25lKSwKICAgICAgICAicGh5c2ljYWxTaXplVW0iOiBwaHlzaWNhbCwKICAg
#6#ICAgICAiY2FsaWJyYXRpb25TdGF0dXMiOiBjYWxfc3RhdHVzLAogICAgICAgICJjYWxpYnJhdGlv
#6#bk5vdGUiOiAoIlBpeGVsIHNpemUgcmVhZCBmcm9tIHRoZSBJbWFnZUogcmVzb2x1dGlvbiB0YWdz
#6#IChtaWNyb25zKS4iCiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiBjYWxfc3RhdHVzID09
#6#ICJleGFjdCIgZWxzZQogICAgICAgICAgICAgICAgICAgICAgICAgICAgIk5vIGNhbGlicmF0ZWQg
#6#cmVzb2x1dGlvbiBpbiB0aGUgZmlsZSDigJQgc2NhbGUgYmFyIGFuZCBtZWFzdXJlbWVudHMgdW5h
#6#dmFpbGFibGUuIiksCiAgICAgICAgImltYWdlIjogaW1hZ2UsCiAgICAgICAgImFjcXVpc2l0aW9u
#6#IjogeyJtb2RhbGl0eSI6ICJicmlnaHRmaWVsZC1zdGVyZW8iLCAic291cmNlRmlsZSI6IHNvdXJj
#6#ZS5uYW1lLAogICAgICAgICAgICAgICAgICAgICAgICAibGlmRmlsZSI6IHBhcnNlZC5nZXQoImxp
#6#ZiIpLCAic2VyaWVzIjogcGFyc2VkLmdldCgic2VyaWVzIiksCiAgICAgICAgICAgICAgICAgICAg
#6#ICAgICJkaXNzZWN0aW9uRGF0ZSI6IHBhcnNlZC5nZXQoImRpc3NlY3Rpb25EYXRlIiksCiAgICAg
#6#ICAgICAgICAgICAgICAgICAgICJ6b29tTm9taW5hbCI6IHBhcnNlZC5nZXQoInpvb20iKSwgKiph
#6#Y3F1aXNpdGlvbn0sCiAgICAgICAgImNoYW5uZWxzIjogW10sCiAgICAgICAgImRlc2NyaXB0aW9u
#6#IjogX2Rlc2NyaXB0aW9uKHN0YWdlX3R4dCwgcGFyc2VkLCBhY3F1aXNpdGlvbiksCiAgICAgICAg
#6#ImNyZWF0ZWQiOiBub3csICJsYXN0TW9kaWZpZWQiOiBub3csICJjb25maWd1cmVkIjogVHJ1ZSwK
#6#ICAgICAgICAiZm9sZGVyTmFtZSI6IGZvbGRlciwKICAgICAgICAidGh1bWJuYWlsIjogZiJEQVRB
#6#X1dFQi97REFUQVNFVF9UWVBFfS97Zm9sZGVyfS90aHVtYm5haWwud2VicCIsCiAgICAgICAgImhp
#6#ZGRlbiI6IEZhbHNlLAogICAgfQoKCmRlZiBfZGVzY3JpcHRpb24oc3RhZ2U6IHN0ciwgcGFyc2Vk
#6#OiBkaWN0LCBhY3E6IGRpY3QpIC0+IHN0cjoKICAgIGJpdHMgPSBbZiJDb2xvdXIgcGhvdG9ncmFw
#6#aCwge3N0YWdlfSBlbWJyeW8iXQogICAgaWYgcGFyc2VkLmdldCgibGluZSIpOgogICAgICAgIGJp
#6#dHMuYXBwZW5kKHBhcnNlZFsibGluZSJdKQogICAgaWYgYWNxLmdldCgibWljcm9zY29wZSIpOgog
#6#ICAgICAgIGJpdHMuYXBwZW5kKGYie2FjcVsnbWljcm9zY29wZSddfSBzdGVyZW9taWNyb3Njb3Bl
#6#IikKICAgIGlmIHBhcnNlZC5nZXQoInpvb20iKToKICAgICAgICBiaXRzLmFwcGVuZChmInpvb20g
#6#eHtwYXJzZWRbJ3pvb20nXTpnfSIpCiAgICByZXR1cm4gIiwgIi5qb2luKGJpdHMpICsgIi4iCgoK
#6#ZGVmIHdyaXRlX2Rvd25sb2FkKHNvdXJjZTogUGF0aCwgb3V0X2RpcjogUGF0aCwgbWV0YTogZGlj
#6#dCwgbG9zc2xlc3M6IGJvb2wgPSBGYWxzZSkgLT4gTm9uZToKICAgIGRsID0gb3V0X2RpciAvICJk
#6#b3dubG9hZCIKICAgIGRsLm1rZGlyKGV4aXN0X29rPVRydWUpCiAgICB0YXJnZXQgPSBkbCAvIHNv
#6#dXJjZS5uYW1lCiAgICBpZiB0YXJnZXQuZXhpc3RzKCk6CiAgICAgICAgdGFyZ2V0LnVubGluaygp
#6#CiAgICB0cnk6CiAgICAgICAgb3MubGluayhzb3VyY2UsIHRhcmdldCkKICAgIGV4Y2VwdCBPU0Vy
#6#cm9yOgogICAgICAgIHNodXRpbC5jb3B5Mihzb3VyY2UsIHRhcmdldCkKICAgIChkbCAvICJSRUFE
#6#TUUudHh0Iikud3JpdGVfdGV4dChfcmVhZG1lKHNvdXJjZSwgbWV0YSwgbG9zc2xlc3MpLCBlbmNv
#6#ZGluZz0idXRmLTgiKQoKCmRlZiBfcmVhZG1lKHNvdXJjZTogUGF0aCwgbWV0YTogZGljdCwgbG9z
#6#c2xlc3M6IGJvb2wgPSBGYWxzZSkgLT4gc3RyOgogICAgYWNxID0gbWV0YVsiYWNxdWlzaXRpb24i
#6#XQogICAgcHggPSBtZXRhLmdldCgicGl4ZWxTaXplVW0iKQogICAgbGluZXMgPSBbCiAgICAgICAg
#6#ZiJ7bWV0YVsnbmFtZSddfSIsCiAgICAgICAgIj0iICogbGVuKG1ldGFbIm5hbWUiXSksCiAgICAg
#6#ICAgIiIsCiAgICAgICAgZiJUeXBlICAgICAgICA6IDJEIHBob3RvZ3JhcGggKHthY3EuZ2V0KCdt
#6#b2RhbGl0eScpfSkiLAogICAgICAgIGYiU3RhZ2UgICAgICAgOiB7bWV0YVsnc3RhZ2UnXX0iLAog
#6#ICAgICAgIGYiTGluZSAgICAgICAgOiB7bWV0YS5nZXQoJ2xpbmUnKSBvciAnLSd9IiwKICAgICAg
#6#ICBmIlN0YWluaW5nICAgIDoge21ldGEuZ2V0KCdzdGFpbmluZycpIG9yICctJ30iLAogICAgICAg
#6#IGYiSW1hZ2UgICAgICAgOiB7bWV0YVsnZGltZW5zaW9ucyddWyd4J119IHgge21ldGFbJ2RpbWVu
#6#c2lvbnMnXVsneSddfSBweCwgUkdCIDgtYml0IiwKICAgICAgICBmIlBpeGVsIHNpemUgIDoge3B4
#6#Wyd4J106LjRmfSB1bS9weCIgaWYgcHggZWxzZSAiUGl4ZWwgc2l6ZSAgOiB1bmtub3duIiwKICAg
#6#ICAgICBmIlNvdXJjZSAgICAgIDoge3NvdXJjZS5uYW1lfSIsCiAgICAgICAgZiJMSUYgZmlsZSAg
#6#ICA6IHthY3EuZ2V0KCdsaWZGaWxlJykgb3IgJy0nfSAgKHNlcmllcyB7YWNxLmdldCgnc2VyaWVz
#6#Jykgb3IgJy0nfSkiLAogICAgICAgIGYiTWljcm9zY29wZSAgOiB7YWNxLmdldCgnbWljcm9zY29w
#6#ZScpIG9yICctJ30gIGNhbWVyYSB7YWNxLmdldCgnY2FtZXJhJykgb3IgJy0nfSIsCiAgICAgICAg
#6#ZiJab29tICAgICAgICA6IHthY3EuZ2V0KCd6b29tJykgb3IgYWNxLmdldCgnem9vbU5vbWluYWwn
#6#KSBvciAnLSd9IiwKICAgICAgICBmIkV4cG9zdXJlICAgIDoge2FjcS5nZXQoJ2V4cG9zdXJlTXMn
#6#KSBvciAnLSd9IG1zLCBnYWluIHthY3EuZ2V0KCdnYWluJykgb3IgJy0nfSIsCiAgICAgICAgZiJE
#6#aXNzZWN0aW9uICA6IHthY3EuZ2V0KCdkaXNzZWN0aW9uRGF0ZScpIG9yICctJ30iLAogICAgICAg
#6#ICIiLAogICAgICAgICJUaGUgVElGRiBpcyB0aGUgdW50b3VjaGVkIEltYWdlSiBleHBvcnQ7IGlt
#6#YWdlLndlYnAgYmVzaWRlIGl0IGlzIHRoZSIsCiAgICAgICAgImRpc3BsYXkgY29weSB1c2VkIGJ5
#6#IHRoZSB2aWV3ZXIiCiAgICAgICAgKyAoIiAobG9zc2xlc3MpLiIgaWYgbG9zc2xlc3MgZWxzZSAi
#6#IChsb3NzeSwgcXVhbGl0eSA5MCkuIiksCiAgICBdCiAgICByZXR1cm4gIlxuIi5qb2luKGxpbmVz
#6#KSArICJcbiIKCgojIOKUgOKUgCBPcmNoZXN0cmF0aW9uIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgApkZWYgaW1w
#6#b3J0X3RpZmYoc291cmNlOiBQYXRoLCBvdXRwdXRfcm9vdDogUGF0aCwgYXJncywgY2xhaW1lZDog
#6#ZGljdCA9IE5vbmUpIC0+IFBhdGg6CiAgICB3aXRoIEltYWdlLm9wZW4oc291cmNlKSBhcyBpbToK
#6#ICAgICAgICBpaiA9IHJlYWRfaWpfbWV0YWRhdGEoaW0pCiAgICAgICAgZGVzY3JpcHRpb24gPSBz
#6#dHIoaW0udGFnX3YyLmdldChJTUFHRV9ERVNDUklQVElPTl9UQUcsICIiKSkKICAgICAgICBweF91
#6#bSwgY2FsX3N0YXR1cyA9IHBpeGVsX3NpemVfdW0oaW0sIGRlc2NyaXB0aW9uKQogICAgICAgIHJn
#6#YiA9IGNvbXBvc2VfcmdiKHJlYWRfcGxhbmVzKGltLCBkZXNjcmlwdGlvbiksIGlqLmdldCgibHV0
#6#cyIsIFtdKSkKCiAgICBwYXJzZWQgPSBwYXJzZV9maWxlbmFtZShzb3VyY2Uuc3RlbSwgYXJncy5s
#6#aW5lKQogICAgZm9sZGVyID0gZGF0YXNldF9mb2xkZXJfbmFtZShwYXJzZWQpCiAgICBvdXRfZGly
#6#ID0gb3V0cHV0X3Jvb3QgLyBEQVRBU0VUX1RZUEUgLyBmb2xkZXIKICAgIG1ldGFfcGF0aCA9IG91
#6#dF9kaXIgLyAibWV0YWRhdGEuanNvbiIKCiAgICAjIFR3byBkaWZmZXJlbnQgVElGRnMgY2FuIGRl
#6#c2NyaWJlIHRoZW1zZWx2ZXMgaWRlbnRpY2FsbHkgKHNhbWUgbGluZSwgc3RhZ2UsIHpvb20sCiAg
#6#ICAjIGRhdGUgYW5kIGluZGV4KTsgdGhlIHNlY29uZCBtdXN0IG5laXRoZXIgYmUgc2tpcHBlZCBh
#6#cyAiYWxyZWFkeSBpbXBvcnRlZCIgbm9yCiAgICAjIG92ZXJ3cml0ZSB0aGUgZmlyc3QuCiAgICBp
#6#ZiBjbGFpbWVkIGlzIG5vdCBOb25lOgogICAgICAgIGtleSA9IGZvbGRlci5jYXNlZm9sZCgpCiAg
#6#ICAgICAgaWYga2V5IGluIGNsYWltZWQgYW5kIGNsYWltZWRba2V5XSAhPSBzb3VyY2U6CiAgICAg
#6#ICAgICAgIHJhaXNlIFZhbHVlRXJyb3IoZiJzYW1lIGRhdGFzZXQgZm9sZGVyIHtmb2xkZXJ9IGFz
#6#IHtjbGFpbWVkW2tleV0ubmFtZX0g4oCUICIKICAgICAgICAgICAgICAgICAgICAgICAgICAgICBm
#6#InJlbmFtZSBvbmUgb2YgdGhlIHR3byBmaWxlcyIpCiAgICAgICAgY2xhaW1lZFtrZXldID0gc291
#6#cmNlCiAgICBleGlzdGluZyA9IF9sb2FkX2pzb24obWV0YV9wYXRoKSBpZiBtZXRhX3BhdGguZXhp
#6#c3RzKCkgZWxzZSB7fQogICAgcHJldmlvdXNfc291cmNlID0gKGV4aXN0aW5nLmdldCgiYWNxdWlz
#6#aXRpb24iKSBvciB7fSkuZ2V0KCJzb3VyY2VGaWxlIikKICAgIGlmIHByZXZpb3VzX3NvdXJjZSBh
#6#bmQgcHJldmlvdXNfc291cmNlICE9IHNvdXJjZS5uYW1lOgogICAgICAgIHJhaXNlIFZhbHVlRXJy
#6#b3IoZiJ7Zm9sZGVyfSBhbHJlYWR5IGhvbGRzIHtwcmV2aW91c19zb3VyY2V9LCBhIGRpZmZlcmVu
#6#dCBmaWxlIOKAlCAiCiAgICAgICAgICAgICAgICAgICAgICAgICBmInJlbmFtZSBvbmUgb2YgdGhl
#6#IHR3byBmaWxlcyIpCiAgICBpZiBtZXRhX3BhdGguZXhpc3RzKCkgYW5kIG5vdCBhcmdzLmZvcmNl
#6#OgogICAgICAgIHByaW50KGYiICBbc2tpcF0ge2ZvbGRlcn0gZXhpc3RzICh1c2UgLS1mb3JjZSB0
#6#byByZS1pbXBvcnQpIikKICAgICAgICByZXR1cm4gb3V0X2RpcgogICAgb3V0X2Rpci5ta2Rpcihw
#6#YXJlbnRzPVRydWUsIGV4aXN0X29rPVRydWUpCgogICAgbG9zc2xlc3MgPSBib29sKGdldGF0dHIo
#6#YXJncywgImxvc3NsZXNzIiwgRmFsc2UpKQogICAgaW1hZ2UgPSB3cml0ZV9pbWFnZXMocmdiLCBv
#6#dXRfZGlyLCBsb3NzbGVzcz1sb3NzbGVzcykKICAgIGluZm8gPSAoaWouZ2V0KCJpbmZvIikgb3Ig
#6#WyIiXSlbMF0KICAgIHNlcmllcyA9IF9zZXJpZXNfbmFtZShpaiwgcGFyc2VkKQogICAgYWNxdWlz
#6#aXRpb24gPSBsZWljYV9maWVsZHMoaW5mbywgc2VyaWVzKSBpZiBzZXJpZXMgZWxzZSB7fQogICAg
#6#ZnJlc2ggPSBidWlsZF9tZXRhZGF0YShmb2xkZXIsIHBhcnNlZCwgaW1hZ2UsIHB4X3VtLCBjYWxf
#6#c3RhdHVzLCBhY3F1aXNpdGlvbiwgc291cmNlLCBhcmdzLnN0YWluaW5nKQogICAgbWV0YSA9IG1l
#6#cmdlX2N1cmF0ZWQoZXhpc3RpbmcsIGZyZXNoKQogICAgIyBtZXRhZGF0YS5qc29uIGlzIHdyaXR0
#6#ZW4gbGFzdCwgYXRvbWljYWxseTogYSBoYWxmIGltcG9ydCBpcyBuZXZlciBtb3VudGVkLgogICAg
#6#YXRvbWljX3dyaXRlX3RleHQobWV0YV9wYXRoLCBqc29uLmR1bXBzKG1ldGEsIGluZGVudD0yLCBl
#6#bnN1cmVfYXNjaWk9RmFsc2UpKQogICAgaWYgYXJncy53aXRoX2Rvd25sb2FkczoKICAgICAgICB3
#6#cml0ZV9kb3dubG9hZChzb3VyY2UsIG91dF9kaXIsIG1ldGEsIGxvc3NsZXNzKQoKICAgIGlmIG5v
#6#dCBweF91bToKICAgICAgICBweF90eHQgPSAidW5jYWxpYnJhdGVkIgogICAgZWxpZiBweF91bVsw
#6#XSA9PSBweF91bVsxXToKICAgICAgICBweF90eHQgPSBmIntweF91bVswXTouM2Z9IHVtL3B4Igog
#6#ICAgZWxzZToKICAgICAgICBweF90eHQgPSBmIntweF91bVswXTouM2Z9IHgge3B4X3VtWzFdOi4z
#6#Zn0gdW0vcHgiCiAgICBwcmludChmIiAgW29rXSB7Zm9sZGVyfSAge2ltYWdlWyd3aWR0aCddfXh7
#6#aW1hZ2VbJ2hlaWdodCddfSAge21ldGFbJ3N0YWdlJ119ICB7cHhfdHh0fSIpCiAgICByZXR1cm4g
#6#b3V0X2RpcgoKCmRlZiBfc2VyaWVzX25hbWUoaWo6IGRpY3QsIHBhcnNlZDogZGljdCkgLT4gc3Ry
#6#OgogICAgIiIiSW1hZ2VKIGxhYmVscyBlYWNoIHBsYW5lIGBjOjEvMyAtIDxzZXJpZXM+YDsgdGhl
#6#IExlaWNhIGJsb2NrIGlzIGtleWVkIGJ5CiAgICB0aGF0IHNlcmllcyBuYW1lLCB3aGljaCBpcyBh
#6#bHNvIHRoZSBvbmUgdGhlIGxhYiBtYXkgaGF2ZSByZW5hbWVkIGluIExBUyBYLiIiIgogICAgbGFi
#6#ZWxzID0gaWouZ2V0KCJsYWJsIikgb3IgW10KICAgIGlmIGxhYmVscyBhbmQgIiAtICIgaW4gbGFi
#6#ZWxzWzBdOgogICAgICAgIHJldHVybiBsYWJlbHNbMF0uc3BsaXQoIiAtICIsIDEpWzFdLnN0cmlw
#6#KCkKICAgIHJldHVybiBwYXJzZWQuZ2V0KCJzZXJpZXMiKSBvciAiIgoKCmRlZiBfbG9hZF9qc29u
#6#KHBhdGg6IFBhdGgpIC0+IGRpY3Q6CiAgICB0cnk6CiAgICAgICAgcmV0dXJuIGpzb24ubG9hZHMo
#6#cGF0aC5yZWFkX3RleHQoZW5jb2Rpbmc9InV0Zi04IikpCiAgICBleGNlcHQgKE9TRXJyb3IsIFZh
#6#bHVlRXJyb3IpOgogICAgICAgIHJldHVybiB7fQoKCmRlZiBjb2xsZWN0X2lucHV0cyhpbnB1dF9w
#6#YXRoOiBQYXRoLCBvbmx5OiBzdHIpIC0+IGxpc3Q6CiAgICBpZiBpbnB1dF9wYXRoLmlzX2ZpbGUo
#6#KToKICAgICAgICBmaWxlcyA9IFtpbnB1dF9wYXRoXQogICAgZWxzZToKICAgICAgICBmaWxlcyA9
#6#IHNvcnRlZChwIGZvciBwIGluIGlucHV0X3BhdGguaXRlcmRpcigpCiAgICAgICAgICAgICAgICAg
#6#ICAgICAgaWYgcC5zdWZmaXgubG93ZXIoKSBpbiAoIi50aWYiLCAiLnRpZmYiKSBhbmQgcC5pc19m
#6#aWxlKCkpCiAgICBpZiBvbmx5OgogICAgICAgIGZpbGVzID0gW2YgZm9yIGYgaW4gZmlsZXMgaWYg
#6#Zm5tYXRjaC5mbm1hdGNoKGYubmFtZSwgb25seSldCiAgICByZXR1cm4gZmlsZXMKCgpkZWYgbWFp
#6#bigpIC0+IGludDoKICAgIGFwID0gYXJncGFyc2UuQXJndW1lbnRQYXJzZXIoZGVzY3JpcHRpb249
#6#IjJEIHBob3RvZ3JhcGggaW1wb3J0ZXIgKG9uZSBUSUZGIOKGkiBvbmUgZGF0YXNldCkiKQogICAg
#6#YXAuYWRkX2FyZ3VtZW50KCItLWlucHV0IiwgcmVxdWlyZWQ9VHJ1ZSwgaGVscD0iRGlyZWN0b3J5
#6#IG9mIFRJRkZzLCBvciBvbmUgVElGRi4iKQogICAgYXAuYWRkX2FyZ3VtZW50KCItLW91dHB1dCIs
#6#IHJlcXVpcmVkPVRydWUsIGhlbHA9IkRBVEFfV0VCIGRpcmVjdG9yeSBvZiB0aGUgd2ViIHBsYXRm
#6#b3JtLiIpCiAgICBhcC5hZGRfYXJndW1lbnQoIi0tb25seSIsIGRlZmF1bHQ9Tm9uZSwgaGVscD0i
#6#R2xvYiBvbiB0aGUgZmlsZSBuYW1lIChlLmcuICcqRTguMConKS4iKQogICAgYXAuYWRkX2FyZ3Vt
#6#ZW50KCItLWxpbmUiLCBkZWZhdWx0PU5vbmUsIGhlbHA9IlJlcG9ydGVyL3N0cmFpbiBsaW5lIGxh
#6#YmVsIChkZWZhdWx0OiBwYXJzZWQgZnJvbSB0aGUgLmxpZiBuYW1lKS4iKQogICAgYXAuYWRkX2Fy
#6#Z3VtZW50KCItLXN0YWluaW5nIiwgZGVmYXVsdD0iIiwgaGVscD0iU3RhaW5pbmcgbGFiZWwgc3Rv
#6#cmVkIGluIG1ldGFkYXRhIChlLmcuIFgtZ2FsKS4iKQogICAgYXAuYWRkX2FyZ3VtZW50KCItLXdp
#6#dGgtZG93bmxvYWRzIiwgYWN0aW9uPSJzdG9yZV90cnVlIiwgaGVscD0iUGxhY2UgdGhlIG9yaWdp
#6#bmFsIFRJRkYgKyBSRUFETUUgdW5kZXIgZG93bmxvYWQvLiIpCiAgICBhcC5hZGRfYXJndW1lbnQo
#6#Ii0tZm9yY2UiLCBhY3Rpb249InN0b3JlX3RydWUiLCBoZWxwPSJSZS1pbXBvcnQgb3ZlciBhbiBl
#6#eGlzdGluZyBkYXRhc2V0IChjdXJhdGlvbiBpcyBwcmVzZXJ2ZWQpLiIpCiAgICBhcC5hZGRfYXJn
#6#dW1lbnQoIi0tbG9zc2xlc3MiLCBhY3Rpb249InN0b3JlX3RydWUiLAogICAgICAgICAgICAgICAg
#6#ICAgIGhlbHA9IlN0b3JlIHRoZSBuYXRpdmUgaW1hZ2UgbG9zc2xlc3NseSAobGFyZ2VyOyBrZWVw
#6#cyB0aGUgY29sb3VyIHJhdGlvcyAiCiAgICAgICAgICAgICAgICAgICAgICAgICAidGhlIHN0YWlu
#6#IGlzb2xhdGlvbiBtZWFzdXJlcyBleGFjdCBhdCBldmVyeSBwaXhlbCkuIikKICAgIGFyZ3MgPSBh
#6#cC5wYXJzZV9hcmdzKCkKCiAgICBmaWxlcyA9IGNvbGxlY3RfaW5wdXRzKFBhdGgoYXJncy5pbnB1
#6#dCksIGFyZ3Mub25seSkKICAgIGlmIG5vdCBmaWxlczoKICAgICAgICBwcmludCgiWzJkXSBubyBU
#6#SUZGIG1hdGNoZWQuIikKICAgICAgICByZXR1cm4gMQogICAgcHJpbnQoZiJbMmRdIGltcG9ydGVy
#6#IHZ7X192ZXJzaW9uX199IC0ge2xlbihmaWxlcyl9IGZpbGUocykgLT4ge1BhdGgoYXJncy5vdXRw
#6#dXQpIC8gREFUQVNFVF9UWVBFfSIpCiAgICBmYWlsdXJlcyA9IDAKICAgIGNsYWltZWQgPSB7fQog
#6#ICAgZm9yIHNvdXJjZSBpbiBmaWxlczoKICAgICAgICB0cnk6CiAgICAgICAgICAgIGltcG9ydF90
#6#aWZmKHNvdXJjZSwgUGF0aChhcmdzLm91dHB1dCksIGFyZ3MsIGNsYWltZWQpCiAgICAgICAgZXhj
#6#ZXB0IEV4Y2VwdGlvbiBhcyBleGM6ICAjIG9uZSBiYWQgZXhwb3J0IG11c3Qgbm90IHN0b3AgdGhl
#6#IGJhdGNoCiAgICAgICAgICAgIGZhaWx1cmVzICs9IDEKICAgICAgICAgICAgcHJpbnQoZiIgIFtm
#6#YWlsXSB7c291cmNlLm5hbWV9OiB7ZXhjfSIpCiAgICBwcmludChmIlsyZF0gZG9uZSAtIHtsZW4o
#6#ZmlsZXMpIC0gZmFpbHVyZXN9IGltcG9ydGVkLCB7ZmFpbHVyZXN9IGZhaWxlZC4iKQogICAgcmV0
#6#dXJuIDEgaWYgZmFpbHVyZXMgZWxzZSAwCgoKaWYgX19uYW1lX18gPT0gIl9fbWFpbl9fIjoKICAg
#6#IHN5cy5leGl0KG1haW4oKSkK
:: ---- [7] 5-tracking_importer.py (22830 octets) ----
#7#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwoiIiJBdHRhY2ggYW4gSW1hcmlzIGNlbGwtdHJhY2tpbmcg
#7#YW5hbHlzaXMgdG8gYSBwcmVwcm9jZXNzZWQgdm9sdW1lIGRhdGFzZXQuCgpBY2NlcHRzIHRoZSBh
#7#bmFseXNpcyBpbiBhbnkgb2YgdGhlIHRocmVlIHNoYXBlcyBpdCBleGlzdHMgaW4g4oCUIGEgYC5p
#7#bWFyaXNfdHJhY2tgIGNvbnRhaW5lcgooZ3ppcCArIEpTT04sIHNpZ25hdHVyZSBJTUFSSVNfVFJB
#7#Q0tFUl9WMSkgcHJvZHVjZWQgYnkgdGhlIGxhYidzIEltYXJpcyBhbmFseXNpcyBzY3JpcHRzLAp0
#7#aGUgYC5pbXNgIHZvbHVtZSBpdHNlbGYgKGl0cyBTY2VuZTggU3BvdHMvVHJhY2tzIG9iamVjdHMp
#7#LCBvciB0aGUgYC54bHNgL2AueGxzeGAgc3RhdGlzdGljcwp3b3JrYm9vayBleHBvcnRlZCBmcm9t
#7#IEltYXJpczsgdGhlIGxhc3QgdHdvIGFyZSBub3JtYWxpc2VkIGJ5IGB0cmFja2luZ19zb3VyY2Vz
#7#LnB5YC4gV3JpdGVzLAppbnRvIHRoZSBkYXRhc2V0IGRpcmVjdG9yeToKCiAgICB0cmFja3MuanNv
#7#blsuZ3pdICAgdHJhamVjdG9yaWVzIGluIHRoZSBzY2hlbWEgdGhlIHZpZXdlciBjb25zdW1lcwog
#7#ICAgbW9kZWwuZ2xiICAgICAgICAgIHRoZSBwcmUtYmFrZWQgcG9wdWxhdGlvbiBzdXJmYWNlcywg
#7#aWYgb25lIHdhcyBleHBvcnRlZAoKYW5kIGluamVjdHMgaW50byBgbWV0YWRhdGEuanNvbmAgYSBg
#7#cmVnaXN0cmF0aW9uYCBibG9jayBob2xkaW5nIHRoZSBwZXItdGltZXBvaW50CnJpZ2lkIHRyYW5z
#7#Zm9ybSB0aGF0IG1hcHMgUkFXIGFjcXVpc2l0aW9uIGNvb3JkaW5hdGVzIG9udG8gdGhlIFNUQUJJ
#7#TElTRUQgZnJhbWUuCgpXaHkgdGhlIHRyYW5zZm9ybSBtYXR0ZXJzCi0tLS0tLS0tLS0tLS0tLS0t
#7#LS0tLS0tLS0KVGhlIHRyYWNraW5nIGlzIHN0YWJpbGlzZWQgKHRoZSBhbmFseXNpcyByZW1vdmVz
#7#IHRoZSBzcGVjaW1lbidzIGdsb2JhbCBtb3Rpb24gYnkgYQpzZXF1ZW50aWFsIEthYnNjaCBhbGln
#7#bm1lbnQpIGJ1dCB0aGUgaW1hZ2VzIGFyZSBub3QuIEJlY2F1c2UgdGhhdCBzdGFiaWxpc2F0aW9u
#7#IGlzIGEKcmlnaWQgYm9keSBtb3Rpb24sIHRoZSB2ZXJ5IHNhbWUgdHJhbnNmb3JtIHJlLWV4cHJl
#7#c3NlcyB0aGUgaW1hZ2Ugdm9sdW1lIGluIHRoZQpzdGFiaWxpc2VkIGZyYW1lIOKAlCBzbyB0aGUg
#7#dmlld2VyIGNhbiBvdmVybGF5IHRyYWNrcyBvbiBpbWFnZXMgYnkgd2FycGluZyB0aGUgc2FtcGxp
#7#bmcKY29vcmRpbmF0ZXMsIHdpdGggbm8gdm94ZWwgcmVzYW1wbGluZyBhbmQgbm8gbG9zcy4KClRo
#7#ZSB0cmFuc2Zvcm0gaXMgdGFrZW4gZnJvbSB0aGUgY29udGFpbmVyIHdoZW4gdGhlIGV4cG9ydGVy
#7#IGRlY2xhcmVkIGl0LCBhbmQgb3RoZXJ3aXNlCnJlY292ZXJlZCBieSBvcnRob2dvbmFsIFByb2Ny
#7#dXN0ZXMgb24gdGhlIHJhdy9zdGFiaWxpc2VkIHBvaW50IHBhaXJzLCB3aGljaCBpcyBleGFjdAp3
#7#aGVuZXZlciB0aGUgc3RhYmlsaXNhdGlvbiByZWFsbHkgd2FzIHJpZ2lkLiBUaGUgcmVzaWR1YWwg
#7#b2YgdGhhdCBmaXQgaXMgcmVjb3JkZWQgYW5kCnN1cmZhY2VkIGluIHRoZSBRQyBzdW1tYXJ5OiBp
#7#ZiBpdCBpcyBub3QgfjAsIHRoZSBzdGFiaWxpc2F0aW9uIHdhcyBOT1QgYSByaWdpZCBtb3Rpb24K
#7#YW5kIG11c3Qgbm90IGJlIHB1c2hlZCBvbnRvIHRoZSBpbWFnZXMuCiIiIgppbXBvcnQgYXJncGFy
#7#c2UKaW1wb3J0IGd6aXAKaW1wb3J0IGpzb24KaW1wb3J0IG1hdGgKaW1wb3J0IG9zCmltcG9ydCBz
#7#aHV0aWwKaW1wb3J0IHN5cwpmcm9tIGNvbGxlY3Rpb25zIGltcG9ydCBDb3VudGVyLCBPcmRlcmVk
#7#RGljdApmcm9tIGRhdGV0aW1lIGltcG9ydCBkYXRldGltZQpmcm9tIHBhdGhsaWIgaW1wb3J0IFBh
#7#dGgKCmltcG9ydCBudW1weSBhcyBucAoKSEVSRSA9IFBhdGgoX19maWxlX18pLnJlc29sdmUoKS5w
#7#YXJlbnQKaWYgc3RyKEhFUkUpIG5vdCBpbiBzeXMucGF0aDoKICAgIHN5cy5wYXRoLmluc2VydCgw
#7#LCBzdHIoSEVSRSkpCmZyb20gcnVuX3ByZXByb2Nlc3MgaW1wb3J0IGF0b21pY193cml0ZV9ieXRl
#7#cywgYXRvbWljX3dyaXRlX2pzb24gICMgbm9xYTogRTQwMgoKX192ZXJzaW9uX18gPSAiMC4yLjAi
#7#CgpTSUdOQVRVUkUgPSAiSU1BUklTX1RSQUNLRVJfVjEiCiMgQSBQcm9jcnVzdGVzIGZpdCByZXNp
#7#ZHVhbCB1bmRlciB0aGlzIGlzIG1hY2hpbmUgbm9pc2U6IHRoZSBzdGFiaWxpc2F0aW9uIGlzIHJp
#7#Z2lkIGFuZAojIHRoZSByZWNvdmVyZWQgbWF0cml4IGNhbiBiZSBhcHBsaWVkIHRvIHRoZSBpbWFn
#7#ZXMuIEFib3ZlIGl0LCB3ZSByZWZ1c2UgdG8gY2xhaW0gc28uClJJR0lEX1RPTEVSQU5DRV9VTSA9
#7#IDAuMDUKTUlOX0ZJVF9QT0lOVFMgPSA0CgoKZGVmIF9zaWcodmFsdWUsIGRpZ2l0cz00KToKICAg
#7#ICIiIlJvdW5kIHRvIHNpZ25pZmljYW50IGRpZ2l0czogYSByZXNpZHVhbCBvZiAxLjJlLTEyIGlz
#7#IHRoZSBoZWFkbGluZSBRQyByZXN1bHQgYW5kCiAgICBmaXhlZC1kZWNpbWFsIHJvdW5kaW5nIHdv
#7#dWxkIGZsYXR0ZW4gaXQgdG8gYSBtZWFuaW5nbGVzcyAwLjAuIiIiCiAgICBpZiB2YWx1ZSBpcyBO
#7#b25lOgogICAgICAgIHJldHVybiBOb25lCiAgICByZXR1cm4gZmxvYXQoZiJ7ZmxvYXQodmFsdWUp
#7#Oi57ZGlnaXRzfWd9IikKCgpkZWYgX2xvYWRfc291cmNlKHBhdGg6IFBhdGgpIC0+IGRpY3Q6CiAg
#7#ICAiIiJSZWFkIHRoZSB0cmFja2luZywgd2hhdGV2ZXIgc2hhcGUgdGhlIG9wZXJhdG9yIHBvaW50
#7#ZWQgdXMgYXQuCgogICAgQSBgYC5pbWFyaXNfdHJhY2tgYCBpcyBwYXJzZWQgaGVyZSBzbyB0aGUg
#7#Y29tbW9uIHBhdGggc3RheXMgZGVwZW5kZW5jeS1mcmVlOyB0aGUgcmF3CiAgICBJbWFyaXMgc2hh
#7#cGVzICguaW1zIG9iamVjdHMsIGV4cG9ydGVkIC54bHMvLnhsc3gpIGFyZSBub3JtYWxpc2VkIGJ5
#7#IHRyYWNraW5nX3NvdXJjZXMsCiAgICB3aGljaCBuZWVkcyBwYW5kYXMgYW5kIHRoZSB0cmFja2lu
#7#ZyBwaXBlbGluZSdzIG93biBhbmFseXNpcyBjb2RlLgogICAgIiIiCiAgICBpZiBwYXRoLnN1ZmZp
#7#eC5sb3dlcigpID09ICIuaW1hcmlzX3RyYWNrIjoKICAgICAgICByZXR1cm4gX3JlYWRfY29udGFp
#7#bmVyKHBhdGgpCiAgICB0cnk6CiAgICAgICAgaW1wb3J0IHRyYWNraW5nX3NvdXJjZXMKICAgIGV4
#7#Y2VwdCBJbXBvcnRFcnJvciBhcyBleGM6CiAgICAgICAgcmFpc2UgUnVudGltZUVycm9yKAogICAg
#7#ICAgICAgICBmIntwYXRoLm5hbWV9OiBsYSBsZWN0dXJlIGRlIGNlIGZvcm1hdCBkZW1hbmRlIHRy
#7#YWNraW5nX3NvdXJjZXMucHkgKHtleGN9KSIpIGZyb20gZXhjCiAgICByZXR1cm4gdHJhY2tpbmdf
#7#c291cmNlcy5sb2FkX2RvY3VtZW50KHBhdGgpCgoKZGVmIF9yZWFkX2NvbnRhaW5lcihwYXRoOiBQ
#7#YXRoKSAtPiBkaWN0OgogICAgIiIiTG9hZCB0aGUgZ3ppcCtKU09OIGNvbnRhaW5lciwgdG9sZXJh
#7#dGluZyB0aGUgb3B0aW9uYWwgdGV4dCBzaWduYXR1cmUgbGluZS4iIiIKICAgIHdpdGggZ3ppcC5v
#7#cGVuKHBhdGgsICJyYiIpIGFzIGZoOgogICAgICAgIGJsb2IgPSBmaC5yZWFkKCkKICAgIGhlYWQg
#7#PSBibG9iWzo2NF0KICAgIGlmIGhlYWQuc3RhcnRzd2l0aChTSUdOQVRVUkUuZW5jb2RlKCkpOgog
#7#ICAgICAgIG5sID0gYmxvYi5pbmRleChiIlxuIikKICAgICAgICBibG9iID0gYmxvYltubCArIDE6
#7#XQogICAgZG9jID0ganNvbi5sb2FkcyhibG9iLmRlY29kZSgidXRmLTgiKSkKICAgIGlmIGRvYy5n
#7#ZXQoInNpZ25hdHVyZSIpICE9IFNJR05BVFVSRToKICAgICAgICByYWlzZSBWYWx1ZUVycm9yKGYi
#7#e3BhdGgubmFtZX06IG5vdCBhbiB7U0lHTkFUVVJFfSBjb250YWluZXIgIgogICAgICAgICAgICAg
#7#ICAgICAgICAgICAgZiIoc2lnbmF0dXJlPXtkb2MuZ2V0KCdzaWduYXR1cmUnKSFyfSkiKQogICAg
#7#aWYgbm90IGlzaW5zdGFuY2UoZG9jLmdldCgiZGF0YSIpLCBkaWN0KToKICAgICAgICByYWlzZSBW
#7#YWx1ZUVycm9yKGYie3BhdGgubmFtZX06IG1pc3NpbmcgJ2RhdGEnIG9iamVjdCIpCiAgICByZXR1
#7#cm4gZG9jCgoKZGVmIF9wcm9jcnVzdGVzKEE6IG5wLm5kYXJyYXksIEI6IG5wLm5kYXJyYXkpOgog
#7#ICAgIiIiTGVhc3Qtc3F1YXJlcyByb3RhdGlvbit0cmFuc2xhdGlvbiB3aXRoIEIgfj0gQSBAIFIu
#7#VCArIGIsIGRldChSKSA9ICsxLiIiIgogICAgY2EsIGNiID0gQS5tZWFuKDApLCBCLm1lYW4oMCkK
#7#ICAgIFUsIF8sIFZ0ID0gbnAubGluYWxnLnN2ZCgoQSAtIGNhKS5UIEAgKEIgLSBjYikpCiAgICBE
#7#ID0gbnAuZGlhZyhbMS4wLCAxLjAsIGZsb2F0KG5wLnNpZ24obnAubGluYWxnLmRldChWdC5UIEAg
#7#VS5UKSkpXSkKICAgIFIgPSBWdC5UIEAgRCBAIFUuVAogICAgcmV0dXJuIFIsIGNiIC0gUiBAIGNh
#7#CgoKZGVmIF9tYXRyaXhfY29sdW1uX21ham9yKFI6IG5wLm5kYXJyYXksIGI6IG5wLm5kYXJyYXkp
#7#OgogICAgIiIiVEhSRUUuTWF0cml4NC5mcm9tQXJyYXkoKSBjb25zdW1lcyBjb2x1bW4tbWFqb3Ig
#7#b3JkZXIuIiIiCiAgICBtID0gbnAuZXllKDQpCiAgICBtWzozLCA6M10gPSBSCiAgICBtWzozLCAz
#7#XSA9IGIKICAgIHJldHVybiBbcm91bmQoZmxvYXQodiksIDkpIGZvciB2IGluIG0uVC5yZXNoYXBl
#7#KC0xKV0KCgpkZWYgX3JvdGF0aW9uX2RlZ3JlZXMoUjogbnAubmRhcnJheSkgLT4gZmxvYXQ6CiAg
#7#ICByZXR1cm4gZmxvYXQobnAuZGVncmVlcyhucC5hcmNjb3MobnAuY2xpcCgobnAudHJhY2UoUikg
#7#LSAxLjApIC8gMi4wLCAtMS4wLCAxLjApKSkpCgoKZGVmIF92YWxpZGF0ZV9jZWxscyhjZWxscykg
#7#LT4gTm9uZToKICAgICIiIlJlamVjdCBhIG1hbGZvcm1lZCBjb250YWluZXIgb3V0cmlnaHQgcmF0
#7#aGVyIHRoYW4gbW91bnQgaXQgaGFsZi13YXkuIiIiCiAgICBpZiBub3QgaXNpbnN0YW5jZShjZWxs
#7#cywgbGlzdCkgb3Igbm90IGNlbGxzOgogICAgICAgIHJhaXNlIFZhbHVlRXJyb3IoImRhdGEuY2Vs
#7#bHMgbXVzdCBiZSBhIG5vbi1lbXB0eSBhcnJheSIpCiAgICBmb3IgaSwgYyBpbiBlbnVtZXJhdGUo
#7#Y2VsbHMpOgogICAgICAgIGZvciBrZXkgaW4gKCJpZCIsICJ0IiwgIngiLCAieSIsICJ6Iik6CiAg
#7#ICAgICAgICAgIGlmIGtleSBub3QgaW4gYzoKICAgICAgICAgICAgICAgIHJhaXNlIFZhbHVlRXJy
#7#b3IoZiJjZWxsICN7aX06IG1pc3NpbmcgcmVxdWlyZWQgZmllbGQgJ3trZXl9JyIpCiAgICAgICAg
#7#biA9IGxlbihjWyJ0Il0pCiAgICAgICAgZm9yIGtleSBpbiAoIngiLCAieSIsICJ6Iik6CiAgICAg
#7#ICAgICAgIGlmIGxlbihjW2tleV0pICE9IG46CiAgICAgICAgICAgICAgICByYWlzZSBWYWx1ZUVy
#7#cm9yKGYiY2VsbCAje2l9IChpZD17Y1snaWQnXX0pOiAne2tleX0nIGhhcyB7bGVuKGNba2V5XSl9
#7#ICIKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZiJ2YWx1ZXMgZm9yIHtufSB0aW1l
#7#cG9pbnRzIikKICAgICAgICBmb3Iga2V5IGluICgieF9yYXciLCAieV9yYXciLCAiel9yYXciKToK
#7#ICAgICAgICAgICAgaWYga2V5IGluIGMgYW5kIGxlbihjW2tleV0pICE9IG46CiAgICAgICAgICAg
#7#ICAgICByYWlzZSBWYWx1ZUVycm9yKGYiY2VsbCAje2l9IChpZD17Y1snaWQnXX0pOiAne2tleX0n
#7#IGxlbmd0aCBtaXNtYXRjaCIpCgoKZGVmIF9zcGxpdF9pZHModmFsdWUpIC0+IGxpc3Q6CiAgICAi
#7#IiJMaW5lYWdlIGZpZWxkcyBjb21lIHRocm91Z2ggYXMgJycgfCAnMjQnIHwgJzI0LzI1Jy4iIiIK
#7#ICAgIGlmIHZhbHVlIGlzIE5vbmU6CiAgICAgICAgcmV0dXJuIFtdCiAgICB0ZXh0ID0gc3RyKHZh
#7#bHVlKS5zdHJpcCgpCiAgICBpZiBub3QgdGV4dCBvciB0ZXh0Lmxvd2VyKCkgaW4gKCJuYW4iLCAi
#7#bm9uZSIpOgogICAgICAgIHJldHVybiBbXQogICAgcmV0dXJuIFtwYXJ0LnN0cmlwKCkgZm9yIHBh
#7#cnQgaW4gdGV4dC5yZXBsYWNlKCIsIiwgIi8iKS5zcGxpdCgiLyIpIGlmIHBhcnQuc3RyaXAoKV0K
#7#CgpkZWYgYnVpbGRfdHJhY2tzX2RvY3VtZW50KGRvYzogZGljdCk6CiAgICAiIiJDb252ZXJ0IHRo
#7#ZSBjb250YWluZXIgaW50byB0aGUgdmlld2VyJ3MgdHJhY2tzLmpzb24gc2NoZW1hLiIiIgogICAg
#7#ZGF0YSA9IGRvY1siZGF0YSJdCiAgICBjZWxscyA9IGRhdGFbImNlbGxzIl0KICAgIF92YWxpZGF0
#7#ZV9jZWxscyhjZWxscykKCiAgICB0aW1lcG9pbnRzID0gc29ydGVkKGZsb2F0KHQpIGZvciB0IGlu
#7#IGRhdGEuZ2V0KCJ0aW1lcG9pbnRzIiwgW10pKQogICAgaWYgbm90IHRpbWVwb2ludHM6CiAgICAg
#7#ICAgdGltZXBvaW50cyA9IHNvcnRlZCh7ZmxvYXQodCkgZm9yIGMgaW4gY2VsbHMgZm9yIHQgaW4g
#7#Y1sidCJdfSkKCiAgICBvdXRfY2VsbHMgPSBPcmRlcmVkRGljdCgpCiAgICBoYXNfcmF3ID0gRmFs
#7#c2UKICAgIGZvciBjIGluIGNlbGxzOgogICAgICAgIGNpZCA9IHN0cihjWyJpZCJdKQogICAgICAg
#7#IHBvc2l0aW9ucywgcmF3X3Bvc2l0aW9ucywgbWFya2VycyA9IHt9LCB7fSwge30KICAgICAgICBt
#7#YXJrZXJfbGlzdCA9IGMuZ2V0KCJtYXJrZXJfY29sb3IiKSBvciBbXQogICAgICAgIGNlbGxfaGFz
#7#X3JhdyA9IGFsbChrIGluIGMgZm9yIGsgaW4gKCJ4X3JhdyIsICJ5X3JhdyIsICJ6X3JhdyIpKQog
#7#ICAgICAgIGhhc19yYXcgPSBoYXNfcmF3IG9yIGNlbGxfaGFzX3JhdwogICAgICAgIGZvciBpLCB0
#7#IGluIGVudW1lcmF0ZShjWyJ0Il0pOgogICAgICAgICAgICBrZXkgPSBzdHIoaW50KHQpKSBpZiBm
#7#bG9hdCh0KS5pc19pbnRlZ2VyKCkgZWxzZSBzdHIoZmxvYXQodCkpCiAgICAgICAgICAgIHBvc2l0
#7#aW9uc1trZXldID0gW2Zsb2F0KGNbIngiXVtpXSksIGZsb2F0KGNbInkiXVtpXSksIGZsb2F0KGNb
#7#InoiXVtpXSldCiAgICAgICAgICAgIGlmIGNlbGxfaGFzX3JhdzoKICAgICAgICAgICAgICAgIHJh
#7#d19wb3NpdGlvbnNba2V5XSA9IFtmbG9hdChjWyJ4X3JhdyJdW2ldKSwgZmxvYXQoY1sieV9yYXci
#7#XVtpXSksIGZsb2F0KGNbInpfcmF3Il1baV0pXQogICAgICAgICAgICBtYXJrZXIgPSBtYXJrZXJf
#7#bGlzdFtpXSBpZiBpIDwgbGVuKG1hcmtlcl9saXN0KSBlbHNlICIiCiAgICAgICAgICAgIGlmIG1h
#7#cmtlcjoKICAgICAgICAgICAgICAgIG1hcmtlcnNba2V5XSA9IG1hcmtlcgoKICAgICAgICBkYXVn
#7#aHRlcnMgPSBfc3BsaXRfaWRzKGMuZ2V0KCJkYXVnaHRlcl9jZWxscyIpKQogICAgICAgIHBhcmVu
#7#dHMgPSBfc3BsaXRfaWRzKGMuZ2V0KCJwYXJlbnRfY2VsbCIpKQogICAgICAgIGVudHJ5ID0gewog
#7#ICAgICAgICAgICAiaWQiOiBjaWQsCiAgICAgICAgICAgICJ0cmFja19pZCI6IGMuZ2V0KCJ0cmFj
#7#a19pZCIpLAogICAgICAgICAgICAicmVnaW9uIjogYy5nZXQoInJlZ2lvbiIpIG9yICJVbmtub3du
#7#IiwKICAgICAgICAgICAgImNvbG9yIjogYy5nZXQoImNvbG9yIiksCiAgICAgICAgICAgICJwb3Np
#7#dGlvbnMiOiBwb3NpdGlvbnMsCiAgICAgICAgICAgICJwYXJlbnQiOiBwYXJlbnRzWzBdIGlmIHBh
#7#cmVudHMgZWxzZSAiIiwKICAgICAgICAgICAgImRhdWdodGVycyI6IGRhdWdodGVycywKICAgICAg
#7#ICAgICAgImlzX21pdG9zaXMiOiBib29sKGRhdWdodGVycyksCiAgICAgICAgICAgICMgQSBjZWxs
#7#IHRoYXQgaW5oZXJpdHMgZnJvbSB0d28gbW90aGVycyBpcyBhIGZ1c2lvbiwgbm90IGEgZGl2aXNp
#7#b24uCiAgICAgICAgICAgICJpc19mdXNpb24iOiBsZW4ocGFyZW50cykgPiAxLAogICAgICAgIH0K
#7#ICAgICAgICBpZiBjZWxsX2hhc19yYXc6CiAgICAgICAgICAgIGVudHJ5WyJyYXdfcG9zaXRpb25z
#7#Il0gPSByYXdfcG9zaXRpb25zCiAgICAgICAgaWYgbWFya2VyczoKICAgICAgICAgICAgZW50cnlb
#7#Im1hcmtlcnMiXSA9IG1hcmtlcnMKICAgICAgICBvdXRfY2VsbHNbY2lkXSA9IGVudHJ5CgogICAg
#7#dHJhY2tzID0gewogICAgICAgICJzY2hlbWEiOiAiaXJpYmhtLXRyYWNrcy12MSIsCiAgICAgICAg
#7#InNvdXJjZSI6IGRvYy5nZXQoImRhdGFzZXRfbmFtZSIpLAogICAgICAgICJzb3VyY2VJZCI6IGRv
#7#Yy5nZXQoImRhdGFzZXRfaWQiKSwKICAgICAgICAiZ2VuZXJhdGVkIjogZG9jLmdldCgiZGF0ZV9n
#7#ZW5lcmF0aW9uIiksCiAgICAgICAgInRpbWVwb2ludHMiOiB0aW1lcG9pbnRzLAogICAgICAgICJj
#7#ZWxscyI6IG91dF9jZWxscywKICAgIH0KICAgIGlmIGlzaW5zdGFuY2UoZGF0YS5nZXQoImxheW91
#7#dCIpLCBkaWN0KToKICAgICAgICB0cmFja3NbImxheW91dCJdID0gZGF0YVsibGF5b3V0Il0KICAg
#7#IHJldHVybiB0cmFja3MsIGhhc19yYXcKCgpkZWYgc29sdmVfcmVnaXN0cmF0aW9uKGRvYzogZGlj
#7#dCwgdGltZXBvaW50X29mZnNldDogaW50KToKICAgICIiIlBlci10aW1lcG9pbnQgcmlnaWQgdHJh
#7#bnNmb3JtIG1hcHBpbmcgcmF3IGFjcXVpc2l0aW9uIGNvb3JkcyAtPiBzdGFiaWxpc2VkIGZyYW1l
#7#LiIiIgogICAgZGF0YSA9IGRvY1siZGF0YSJdCiAgICBjZWxscyA9IGRhdGFbImNlbGxzIl0KCiAg
#7#ICBkZWNsYXJlZCA9IHt9CiAgICBzdGFiX2Jsb2NrID0gZGF0YS5nZXQoInN0YWJpbGl6YXRpb24i
#7#KQogICAgaWYgaXNpbnN0YW5jZShzdGFiX2Jsb2NrLCBkaWN0KToKICAgICAgICBmb3Igcm93IGlu
#7#IHN0YWJfYmxvY2suZ2V0KCJ0cmFuc2Zvcm1zIiwgW10pIG9yIFtdOgogICAgICAgICAgICBpZiBy
#7#b3cuZ2V0KCJtYXRyaXgiKSBhbmQgcm93LmdldCgidCIpIGlzIG5vdCBOb25lOgogICAgICAgICAg
#7#ICAgICAgZGVjbGFyZWRbZmxvYXQocm93WyJ0Il0pXSA9IHJvdwoKICAgIHBhaXJzID0ge30KICAg
#7#IGZvciBjIGluIGNlbGxzOgogICAgICAgIGlmIG5vdCBhbGwoayBpbiBjIGZvciBrIGluICgieF9y
#7#YXciLCAieV9yYXciLCAiel9yYXciKSk6CiAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAgZm9y
#7#IGksIHQgaW4gZW51bWVyYXRlKGNbInQiXSk6CiAgICAgICAgICAgIHBhaXJzLnNldGRlZmF1bHQo
#7#ZmxvYXQodCksIFtdKS5hcHBlbmQoKAogICAgICAgICAgICAgICAgKGNbInhfcmF3Il1baV0sIGNb
#7#InlfcmF3Il1baV0sIGNbInpfcmF3Il1baV0pLAogICAgICAgICAgICAgICAgKGNbIngiXVtpXSwg
#7#Y1sieSJdW2ldLCBjWyJ6Il1baV0pLAogICAgICAgICAgICApKQoKICAgIGlmIG5vdCBwYWlycyBh
#7#bmQgbm90IGRlY2xhcmVkOgogICAgICAgIHJldHVybiBOb25lCgogICAgdHJhbnNmb3Jtcywgd2Fy
#7#bmluZ3MgPSBbXSwgW10KICAgIHdvcnN0ID0gMC4wCiAgICByZXNpZHVhbHMgPSBbXQogICAgaWRl
#7#bnRpdHlfYWZ0ZXJfZHJpZnQgPSBbXQogICAgZm9yIHQgaW4gc29ydGVkKHNldChwYWlycykgfCBz
#7#ZXQoZGVjbGFyZWQpKToKICAgICAgICByb3cgPSB7CiAgICAgICAgICAgICJ0IjogdCwKICAgICAg
#7#ICAgICAgImluZGV4IjogaW50KHJvdW5kKHQpKSArIHRpbWVwb2ludF9vZmZzZXQsCiAgICAgICAg
#7#fQogICAgICAgIGlmIHQgaW4gZGVjbGFyZWQ6CiAgICAgICAgICAgIHNyYyA9IGRlY2xhcmVkW3Rd
#7#CiAgICAgICAgICAgIHJvdy51cGRhdGUoewogICAgICAgICAgICAgICAgIm1hdHJpeCI6IFtmbG9h
#7#dCh2KSBmb3IgdiBpbiBzcmNbIm1hdHJpeCJdXSwKICAgICAgICAgICAgICAgICJyb3RhdGlvbkRl
#7#ZyI6IHNyYy5nZXQoInJvdGF0aW9uRGVnIiksCiAgICAgICAgICAgICAgICAidHJhbnNsYXRpb25V
#7#bSI6IHNyYy5nZXQoInRyYW5zbGF0aW9uVW0iKSwKICAgICAgICAgICAgICAgICJuUG9pbnRzIjog
#7#c3JjLmdldCgiblJlZnMiKSwKICAgICAgICAgICAgICAgICJyZXNpZHVhbFVtIjogc3JjLmdldCgi
#7#bWF4UmVzaWR1YWxVbSIpLAogICAgICAgICAgICAgICAgInNvdXJjZSI6ICJkZWNsYXJlZCIsCiAg
#7#ICAgICAgICAgICAgICAiZXhhY3QiOiBUcnVlLAogICAgICAgICAgICB9KQogICAgICAgICAgICB0
#7#cmFuc2Zvcm1zLmFwcGVuZChyb3cpCiAgICAgICAgICAgIGNvbnRpbnVlCgogICAgICAgIFAgPSBu
#7#cC5hcnJheShbcFswXSBmb3IgcCBpbiBwYWlyc1t0XV0sIGZsb2F0KQogICAgICAgIFEgPSBucC5h
#7#cnJheShbcFsxXSBmb3IgcCBpbiBwYWlyc1t0XV0sIGZsb2F0KQogICAgICAgIGlmIGxlbihQKSA8
#7#IE1JTl9GSVRfUE9JTlRTOgogICAgICAgICAgICB3YXJuaW5ncy5hcHBlbmQoZiJ0PXt0Omd9OiBv
#7#bmx5IHtsZW4oUCl9IHBhaXJlZCBwb2ludHMsIHRyYW5zZm9ybSBub3Qgc29sdmFibGUiKQogICAg
#7#ICAgICAgICByb3cudXBkYXRlKHsibWF0cml4IjogTm9uZSwgIm5Qb2ludHMiOiBpbnQobGVuKFAp
#7#KSwgInJlc2lkdWFsVW0iOiBOb25lLAogICAgICAgICAgICAgICAgICAgICAgICAic291cmNlIjog
#7#InVuc29sdmVkIiwgImV4YWN0IjogRmFsc2V9KQogICAgICAgICAgICB0cmFuc2Zvcm1zLmFwcGVu
#7#ZChyb3cpCiAgICAgICAgICAgIGNvbnRpbnVlCgogICAgICAgIFIsIGIgPSBfcHJvY3J1c3RlcyhQ
#7#LCBRKQogICAgICAgIHJlc2lkdWFsID0gZmxvYXQobnAuc3FydCgoKChQIEAgUi5UKSArIGIgLSBR
#7#KSAqKiAyKS5zdW0oMSkubWVhbigpKSkKICAgICAgICB3b3JzdCA9IG1heCh3b3JzdCwgcmVzaWR1
#7#YWwpCiAgICAgICAgcmVzaWR1YWxzLmFwcGVuZChyZXNpZHVhbCkKICAgICAgICByb3QgPSBfcm90
#7#YXRpb25fZGVncmVlcyhSKQogICAgICAgIHJvdy51cGRhdGUoewogICAgICAgICAgICAibWF0cml4
#7#IjogX21hdHJpeF9jb2x1bW5fbWFqb3IoUiwgYiksCiAgICAgICAgICAgICJyb3RhdGlvbkRlZyI6
#7#IHJvdW5kKHJvdCwgNCksCiAgICAgICAgICAgICJ0cmFuc2xhdGlvblVtIjogW3JvdW5kKGZsb2F0
#7#KHYpLCA2KSBmb3IgdiBpbiBiXSwKICAgICAgICAgICAgIm5Qb2ludHMiOiBpbnQobGVuKFApKSwK
#7#ICAgICAgICAgICAgInJlc2lkdWFsVW0iOiBfc2lnKHJlc2lkdWFsKSwKICAgICAgICAgICAgInNv
#7#dXJjZSI6ICJwcm9jcnVzdGVzIiwKICAgICAgICAgICAgImV4YWN0IjogcmVzaWR1YWwgPD0gUklH
#7#SURfVE9MRVJBTkNFX1VNLAogICAgICAgIH0pCiAgICAgICAgIyBUaGUgYW5hbHlzaXMgc2tpcHMg
#7#dGhlIGFsaWdubWVudCB3aGVuIHRvbyBmZXcgcmVmZXJlbmNlIGNlbGxzIGFyZSBzaGFyZWQgd2l0
#7#aAogICAgICAgICMgdGhlIHByZXZpb3VzIGZyYW1lLCB3aGljaCBsZWF2ZXMgdGhhdCBmcmFtZSBp
#7#biBSQVcgc3BhY2Ug4oCUIGFuIGlkZW50aXR5IHNpdHRpbmcKICAgICAgICAjIGluIHRoZSBtaWRk
#7#bGUgb2YgYSBkcmlmdGluZyBzZXJpZXMuIFNpbGVudCwgYW5kIGl0IGJyZWFrcyB0aGUgb3Zlcmxh
#7#eSBmb3IgdGhhdAogICAgICAgICMgZnJhbWUsIHNvIGl0IGlzIHJlcG9ydGVkIHJhdGhlciB0aGFu
#7#IHBhcGVyZWQgb3Zlci4KICAgICAgICBpZiByb3QgPCAxZS02IGFuZCBucC5hbGxjbG9zZShiLCAw
#7#LjAsIGF0b2w9MWUtNik6CiAgICAgICAgICAgIGlkZW50aXR5X2FmdGVyX2RyaWZ0LmFwcGVuZCh0
#7#KQogICAgICAgIHRyYW5zZm9ybXMuYXBwZW5kKHJvdykKCiAgICBzb2x2ZWQgPSBbciBmb3IgciBp
#7#biB0cmFuc2Zvcm1zIGlmIHIuZ2V0KCJtYXRyaXgiKV0KICAgIGlmIGxlbihpZGVudGl0eV9hZnRl
#7#cl9kcmlmdCkgPiAxOgogICAgICAgIGludGVyaW9yID0gW3QgZm9yIHQgaW4gaWRlbnRpdHlfYWZ0
#7#ZXJfZHJpZnQgaWYgdCAhPSBtaW4ocGFpcnMpXQogICAgICAgIGlmIGludGVyaW9yOgogICAgICAg
#7#ICAgICB3YXJuaW5ncy5hcHBlbmQoCiAgICAgICAgICAgICAgICAiaWRlbnRpdHkgdHJhbnNmb3Jt
#7#IG9uIG5vbi1yZWZlcmVuY2UgdGltZXBvaW50cyAiCiAgICAgICAgICAgICAgICArICIsICIuam9p
#7#bihmInt0Omd9IiBmb3IgdCBpbiBpbnRlcmlvcikKICAgICAgICAgICAgICAgICsgIiDigJQgdGhl
#7#IGFuYWx5c2lzIGxpa2VseSBza2lwcGVkIHRoZWlyIGFsaWdubWVudCAodG9vIGZldyByZWZlcmVu
#7#Y2UgIgogICAgICAgICAgICAgICAgICAiY2VsbHMpOyB0aG9zZSBmcmFtZXMgc3RheSBpbiByYXcg
#7#c3BhY2UiKQogICAgcmlnaWQgPSBib29sKHNvbHZlZCkgYW5kIHdvcnN0IDw9IFJJR0lEX1RPTEVS
#7#QU5DRV9VTQogICAgaWYgbm90IHJpZ2lkIGFuZCByZXNpZHVhbHM6CiAgICAgICAgd2FybmluZ3Mu
#7#YXBwZW5kKGYibWF4IFByb2NydXN0ZXMgcmVzaWR1YWwge3dvcnN0Oi40Z30gdW0gZXhjZWVkcyB0
#7#aGUgIgogICAgICAgICAgICAgICAgICAgICAgICBmIntSSUdJRF9UT0xFUkFOQ0VfVU19IHVtIHJp
#7#Z2lkIHRvbGVyYW5jZSDigJQgdGhlIHN0YWJpbGlzYXRpb24gaXMgIgogICAgICAgICAgICAgICAg
#7#ICAgICAgICBmIm5vdCBhIHJpZ2lkIG1vdGlvbiBhbmQgbXVzdCBub3QgYmUgYXBwbGllZCB0byB0
#7#aGUgaW1hZ2VzIikKCiAgICByZXR1cm4gewogICAgICAgICJtZXRob2QiOiAidHJhY2tpbmctZGVj
#7#bGFyZWQiIGlmIGRlY2xhcmVkIGVsc2UgInRyYWNraW5nLXByb2NydXN0ZXMiLAogICAgICAgICJj
#7#b29yZGluYXRlU3BhY2UiOiAiYWNxdWlzaXRpb24tdW0iLAogICAgICAgICJjb252ZW50aW9uIjog
#7#InBfc3RhYmlsaXplZCA9IE0gLiBwX3JhdyA7IG1hdHJpeCBpcyBjb2x1bW4tbWFqb3IgZm9yIFRI
#7#UkVFLk1hdHJpeDQuZnJvbUFycmF5IiwKICAgICAgICAidGltZXBvaW50T2Zmc2V0IjogdGltZXBv
#7#aW50X29mZnNldCwKICAgICAgICAiYXBwbGllZFRvVm9sdW1lIjogcmlnaWQsCiAgICAgICAgInRy
#7#YW5zZm9ybXMiOiB0cmFuc2Zvcm1zLAogICAgICAgICJxY1N1bW1hcnkiOiB7CiAgICAgICAgICAg
#7#ICJyaWdpZCI6IHJpZ2lkLAogICAgICAgICAgICAidG9sZXJhbmNlVW0iOiBSSUdJRF9UT0xFUkFO
#7#Q0VfVU0sCiAgICAgICAgICAgICJtYXhSZXNpZHVhbFVtIjogX3NpZyh3b3JzdCkgaWYgcmVzaWR1
#7#YWxzIGVsc2UgTm9uZSwKICAgICAgICAgICAgIm1lYW5SZXNpZHVhbFVtIjogX3NpZyhmbG9hdChu
#7#cC5tZWFuKHJlc2lkdWFscykpKSBpZiByZXNpZHVhbHMgZWxzZSBOb25lLAogICAgICAgICAgICAi
#7#dGltZXBvaW50c1NvbHZlZCI6IGxlbihzb2x2ZWQpLAogICAgICAgICAgICAidGltZXBvaW50c1Rv
#7#dGFsIjogbGVuKHRyYW5zZm9ybXMpLAogICAgICAgICAgICAid2FybmluZ3MiOiB3YXJuaW5ncywK
#7#ICAgICAgICB9LAogICAgfQoKCmRlZiBfb2NjdXBpZWRfYm94ZXNfdW0oZGF0YXNldF9kaXI6IFBh
#7#dGgsIGV4dGVudDogZGljdCwgZGltczogZGljdCk6CiAgICAiIiJQZXItdGltZXBvaW50IGJvdW5k
#7#aW5nIGJveCwgaW4gdW0sIG9mIHRoZSBicmlja3MgdGhhdCBhY3R1YWxseSBob2xkIHNpZ25hbC4K
#7#CiAgICBSZWFkIGZyb20gYnJpY2tzL21hbmlmZXN0Lmpzb24sIHdoaWNoIGFscmVhZHkgcmVjb3Jk
#7#cyBgbm9uRW1wdHlgIHBlciBicmljayBhZnRlcgogICAgZW1wdHktc3BhY2Ugc2tpcHBpbmcuIFVz
#7#aW5nIHRoZSBvY2N1cGllZCByZWdpb24gcmF0aGVyIHRoYW4gdGhlIHdob2xlIGFjcXVpc2l0aW9u
#7#CiAgICBib3ggbWF0dGVyczogdGhlIHN0YWJpbGlzZWQgc3BlY2ltZW4gYmFyZWx5IG1vdmVzLCBz
#7#byBpdHMgdW5pb24gc3RheXMgdGlnaHQsIHdoaWxlCiAgICB0aGUgdW5pb24gb2YgdGhlIGZ1bGwg
#7#aW1hZ2VkIGJveGVzIGlzIHNldmVyYWwgdGltZXMgbGFyZ2VyIGFuZCB3b3VsZCBtYWtlIHRoZQog
#7#ICAgcmVuZGVyZXIgc3dlZXAgbW9zdGx5IGVtcHR5IHNwYWNlLgogICAgIiIiCiAgICBtYW5pZmVz
#7#dF9wYXRoID0gZGF0YXNldF9kaXIgLyAiYnJpY2tzIiAvICJtYW5pZmVzdC5qc29uIgogICAgaWYg
#7#bm90IG1hbmlmZXN0X3BhdGguZXhpc3RzKCkgb3Igbm90IGV4dGVudCBvciBub3QgZGltczoKICAg
#7#ICAgICByZXR1cm4gTm9uZQogICAgd2l0aCBvcGVuKG1hbmlmZXN0X3BhdGgsICJyIiwgZW5jb2Rp
#7#bmc9InV0Zi04IikgYXMgZmg6CiAgICAgICAgbWFuaWZlc3QgPSBqc29uLmxvYWQoZmgpCgogICAg
#7#bG8gPSBucC5hcnJheShleHRlbnRbIm1pbiJdLCBmbG9hdCkKICAgIGhpID0gbnAuYXJyYXkoZXh0
#7#ZW50WyJtYXgiXSwgZmxvYXQpCiAgICBncmlkID0gbnAuYXJyYXkoW2RpbXMuZ2V0KCJ4IiwgMSks
#7#IGRpbXMuZ2V0KCJ5IiwgMSksIGRpbXMuZ2V0KCJ6IiwgMSldLCBmbG9hdCkKICAgIHZveGVsID0g
#7#KGhpIC0gbG8pIC8gbnAubWF4aW11bShncmlkLCAxLjApCgogICAgZGVmIGJveF9mcm9tX2xldmVs
#7#cyhsZXZlbHMpOgogICAgICAgIGxldmVsID0gbmV4dCgobCBmb3IgbCBpbiBsZXZlbHMgb3IgW10g
#7#aWYgbC5nZXQoImxldmVsIikgPT0gMCksIE5vbmUpCiAgICAgICAgaWYgbm90IGxldmVsOgogICAg
#7#ICAgICAgICByZXR1cm4gTm9uZQogICAgICAgIG1pbnMsIG1heHMgPSBbXSwgW10KICAgICAgICBm
#7#b3IgY2h1bmsgaW4gbGV2ZWwuZ2V0KCJjaHVua3MiLCBbXSk6CiAgICAgICAgICAgIGlmIGNodW5r
#7#LmdldCgibm9uRW1wdHkiKSBpcyBGYWxzZToKICAgICAgICAgICAgICAgIGNvbnRpbnVlCiAgICAg
#7#ICAgICAgIG1pbnMuYXBwZW5kKGNodW5rWyJtaW4iXSkKICAgICAgICAgICAgbWF4cy5hcHBlbmQo
#7#Y2h1bmtbIm1heCJdKQogICAgICAgIGlmIG5vdCBtaW5zOgogICAgICAgICAgICByZXR1cm4gTm9u
#7#ZQogICAgICAgIHJldHVybiAobG8gKyBucC5hcnJheShtaW5zLCBmbG9hdCkubWluKDApICogdm94
#7#ZWwsCiAgICAgICAgICAgICAgICBsbyArIG5wLmFycmF5KG1heHMsIGZsb2F0KS5tYXgoMCkgKiB2
#7#b3hlbCkKCiAgICByb3dzID0gbWFuaWZlc3QuZ2V0KCJ0aW1lcG9pbnRzIikKICAgIGlmIGlzaW5z
#7#dGFuY2Uocm93cywgZGljdCk6CiAgICAgICAgb3V0ID0ge30KICAgICAgICBmb3Iga2V5LCByb3cg
#7#aW4gcm93cy5pdGVtcygpOgogICAgICAgICAgICBib3ggPSBib3hfZnJvbV9sZXZlbHMocm93Lmdl
#7#dCgibGV2ZWxzIikgb3IgbWFuaWZlc3QuZ2V0KCJsZXZlbHMiKSkKICAgICAgICAgICAgaWYgYm94
#7#OgogICAgICAgICAgICAgICAgb3V0W2ludChrZXlbMTpdKSBpZiBrZXkuc3RhcnRzd2l0aCgidCIp
#7#IGVsc2UgaW50KGtleSldID0gYm94CiAgICAgICAgcmV0dXJuIG91dCBvciBOb25lCiAgICBib3gg
#7#PSBib3hfZnJvbV9sZXZlbHMobWFuaWZlc3QuZ2V0KCJsZXZlbHMiKSkKICAgIHJldHVybiB7MDog
#7#Ym94fSBpZiBib3ggZWxzZSBOb25lCgoKZGVmIF9pbWFnZV9ib3hfdW5pb24ocmVnaXN0cmF0aW9u
#7#OiBkaWN0LCBleHRlbnQ6IGRpY3QsIG9jY3VwaWVkPU5vbmUpOgogICAgIiIiVW5pb24sIG92ZXIg
#7#ZXZlcnkgdGltZXBvaW50LCBvZiB0aGUgaW1hZ2VkIGNvbnRlbnQgY2FycmllZCBpbnRvIHN0YWJp
#7#bGlzZWQgc3BhY2UuCgogICAgSW4gc3RhYmlsaXNlZCBtb2RlIHRoZSBzcGVjaW1lbiBzdGFuZHMg
#7#c3RpbGwgYW5kIHRoZSBpbWFnZWQgYm94IG1vdmVzIGFyb3VuZCBpdCwgc28KICAgIHRoZSBib3gg
#7#dGhlIHJlbmRlcmVyIG11c3QgY292ZXIgaXMgdGhpcyB1bmlvbiByYXRoZXIgdGhhbiB0aGUgYWNx
#7#dWlzaXRpb24gYm94LgogICAgRmFsbHMgYmFjayB0byB0aGUgZnVsbCBhY3F1aXNpdGlvbiBib3gg
#7#d2hlbiBicmljayBvY2N1cGFuY3kgaXMgdW5hdmFpbGFibGUuCiAgICAiIiIKICAgIGlmIG5vdCBy
#7#ZWdpc3RyYXRpb24gb3Igbm90IGV4dGVudDoKICAgICAgICByZXR1cm4gTm9uZQogICAgZGVmYXVs
#7#dF9sbyA9IG5wLmFycmF5KGV4dGVudFsibWluIl0sIGZsb2F0KQogICAgZGVmYXVsdF9oaSA9IG5w
#7#LmFycmF5KGV4dGVudFsibWF4Il0sIGZsb2F0KQogICAgcHRzID0gW10KICAgIGZvciByb3cgaW4g
#7#cmVnaXN0cmF0aW9uWyJ0cmFuc2Zvcm1zIl06CiAgICAgICAgbSA9IHJvdy5nZXQoIm1hdHJpeCIp
#7#CiAgICAgICAgaWYgbm90IG06CiAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAgYm94ID0gKG9j
#7#Y3VwaWVkIG9yIHt9KS5nZXQocm93LmdldCgiaW5kZXgiKSkKICAgICAgICBibG8sIGJoaSA9IGJv
#7#eCBpZiBib3ggZWxzZSAoZGVmYXVsdF9sbywgZGVmYXVsdF9oaSkKICAgICAgICBjb3JuZXJzID0g
#7#bnAuYXJyYXkoW1t4LCB5LCB6XSBmb3IgeCBpbiAoYmxvWzBdLCBiaGlbMF0pCiAgICAgICAgICAg
#7#ICAgICAgICAgICAgICAgICBmb3IgeSBpbiAoYmxvWzFdLCBiaGlbMV0pIGZvciB6IGluIChibG9b
#7#Ml0sIGJoaVsyXSldKQogICAgICAgIE0gPSBucC5hcnJheShtLCBmbG9hdCkucmVzaGFwZSg0LCA0
#7#KS5UCiAgICAgICAgcHRzLmFwcGVuZChjb3JuZXJzIEAgTVs6MywgOjNdLlQgKyBNWzozLCAzXSkK
#7#ICAgIGlmIG5vdCBwdHM6CiAgICAgICAgcmV0dXJuIE5vbmUKICAgIGFsbHAgPSBucC52c3RhY2so
#7#cHRzKQogICAgcmV0dXJuIHsKICAgICAgICAibWluIjogW3JvdW5kKGZsb2F0KHYpLCA0KSBmb3Ig
#7#diBpbiBhbGxwLm1pbigwKV0sCiAgICAgICAgIm1heCI6IFtyb3VuZChmbG9hdCh2KSwgNCkgZm9y
#7#IHYgaW4gYWxscC5tYXgoMCldLAogICAgICAgICJiYXNpcyI6ICJvY2N1cGllZC1icmlja3MiIGlm
#7#IG9jY3VwaWVkIGVsc2UgImFjcXVpc2l0aW9uLWJveCIsCiAgICB9CgoKZGVmIF9ib3VuZHMocG9p
#7#bnRzKToKICAgIGlmIG5vdCBwb2ludHM6CiAgICAgICAgcmV0dXJuIE5vbmUKICAgIGFyciA9IG5w
#7#LmFycmF5KHBvaW50cywgZmxvYXQpCiAgICByZXR1cm4geyJtaW4iOiBbcm91bmQoZmxvYXQodiks
#7#IDQpIGZvciB2IGluIGFyci5taW4oMCldLAogICAgICAgICAgICAibWF4IjogW3JvdW5kKGZsb2F0
#7#KHYpLCA0KSBmb3IgdiBpbiBhcnIubWF4KDApXX0KCgpkZWYgaW1wb3J0X3RyYWNraW5nKHRyYWNr
#7#X3BhdGg6IFBhdGgsIGRhdGFzZXRfZGlyOiBQYXRoLCBnbGJfcGF0aDogUGF0aCA9IE5vbmUsCiAg
#7#ICAgICAgICAgICAgICAgICAgdGltZXBvaW50X29mZnNldDogaW50ID0gLTEsIHdyaXRlX2d6aXA6
#7#IGJvb2wgPSBUcnVlKToKICAgIGRvYyA9IF9sb2FkX3NvdXJjZSh0cmFja19wYXRoKQogICAgdHJh
#7#Y2tzLCBoYXNfcmF3ID0gYnVpbGRfdHJhY2tzX2RvY3VtZW50KGRvYykKCiAgICBtZXRhZGF0YV9w
#7#YXRoID0gZGF0YXNldF9kaXIgLyAibWV0YWRhdGEuanNvbiIKICAgIGlmIG5vdCBtZXRhZGF0YV9w
#7#YXRoLmV4aXN0cygpOgogICAgICAgIHJhaXNlIEZpbGVOb3RGb3VuZEVycm9yKGYie21ldGFkYXRh
#7#X3BhdGh9IG5vdCBmb3VuZCDigJQgcnVuIHRoZSB2b2x1bWUgcGlwZWxpbmUgZmlyc3QiKQogICAg
#7#d2l0aCBvcGVuKG1ldGFkYXRhX3BhdGgsICJyIiwgZW5jb2Rpbmc9InV0Zi04IikgYXMgZmg6CiAg
#7#ICAgICAgbWV0YWRhdGEgPSBqc29uLmxvYWQoZmgpCgogICAgcmVnaXN0cmF0aW9uID0gc29sdmVf
#7#cmVnaXN0cmF0aW9uKGRvYywgdGltZXBvaW50X29mZnNldCkKICAgIGlmIHJlZ2lzdHJhdGlvbiBp
#7#cyBOb25lOgogICAgICAgIHByaW50KCJbVFJBQ0tJTkddIE5vIHJhdy9zdGFiaWxpc2VkIHBhaXJz
#7#IGFuZCBubyBkZWNsYXJlZCB0cmFuc2Zvcm06ICIKICAgICAgICAgICAgICAidGhlIG92ZXJsYXkg
#7#d2lsbCBiZSBhdmFpbGFibGUgYnV0IHRoZSB2b2x1bWUgY2Fubm90IGJlIHN0YWJpbGlzZWQuIikK
#7#CiAgICAjIC0tLSBXcml0ZSB0cmFja3MuanNvbiAoKyAuZ3opIC0tLQogICAgcGF5bG9hZCA9IGpz
#7#b24uZHVtcHModHJhY2tzLCBlbnN1cmVfYXNjaWk9RmFsc2UsIHNlcGFyYXRvcnM9KCIsIiwgIjoi
#7#KSkKICAgIGF0b21pY193cml0ZV9ieXRlcyhkYXRhc2V0X2RpciAvICJ0cmFja3MuanNvbiIsIHBh
#7#eWxvYWQuZW5jb2RlKCJ1dGYtOCIpKQogICAgZ3pfbm90ZSA9ICIiCiAgICBpZiB3cml0ZV9nemlw
#7#OgogICAgICAgICMgbXRpbWU9MDogdGhlIGFyY2hpdmUgZGVwZW5kcyBvbiB0aGUgdHJhY2tzIGFs
#7#b25lLCBub3Qgb24gdGhlIGhvdXIgaXQgd2FzIG1hZGUuCiAgICAgICAgYXRvbWljX3dyaXRlX2J5
#7#dGVzKGRhdGFzZXRfZGlyIC8gInRyYWNrcy5qc29uLmd6IiwKICAgICAgICAgICAgICAgICAgICAg
#7#ICAgICAgZ3ppcC5jb21wcmVzcyhwYXlsb2FkLmVuY29kZSgidXRmLTgiKSwgY29tcHJlc3NsZXZl
#7#bD05LCBtdGltZT0wKSkKICAgICAgICBnel9ub3RlID0gZiIsIHsoZGF0YXNldF9kaXIgLyAndHJh
#7#Y2tzLmpzb24uZ3onKS5zdGF0KCkuc3Rfc2l6ZS8xZTY6LjJmfSBNQiBnemlwcGVkIgogICAgcHJp
#7#bnQoZiJbVFJBQ0tJTkddIHRyYWNrcy5qc29uOiB7bGVuKHRyYWNrc1snY2VsbHMnXSl9IGNlbGxz
#7#LCAiCiAgICAgICAgICBmIntsZW4odHJhY2tzWyd0aW1lcG9pbnRzJ10pfSB0aW1lcG9pbnRzLCB7
#7#bGVuKHBheWxvYWQpLzFlNjouMmZ9IE1Ce2d6X25vdGV9IikKCiAgICAjIC0tLSBDb3B5IHRoZSBz
#7#dXJmYWNlIEdMQiAtLS0KICAgIHN1cmZhY2VfcmVsID0gTm9uZQogICAgaWYgZ2xiX3BhdGggaXMg
#7#Tm9uZToKICAgICAgICBjYW5kaWRhdGUgPSB0cmFja19wYXRoLndpdGhfc3VmZml4KCIuZ2xiIikK
#7#ICAgICAgICBnbGJfcGF0aCA9IGNhbmRpZGF0ZSBpZiBjYW5kaWRhdGUuZXhpc3RzKCkgZWxzZSBO
#7#b25lCiAgICBpZiBnbGJfcGF0aCBhbmQgZ2xiX3BhdGguZXhpc3RzKCk6CiAgICAgICAgc3RhZ2Vk
#7#ID0gZGF0YXNldF9kaXIgLyAiLm1vZGVsLmdsYi50bXAiCiAgICAgICAgc2h1dGlsLmNvcHkyKGds
#7#Yl9wYXRoLCBzdGFnZWQpCiAgICAgICAgb3MucmVwbGFjZShzdGFnZWQsIGRhdGFzZXRfZGlyIC8g
#7#Im1vZGVsLmdsYiIpCiAgICAgICAgc3VyZmFjZV9yZWwgPSAibW9kZWwuZ2xiIgogICAgICAgIHBy
#7#aW50KGYiW1RSQUNLSU5HXSBtb2RlbC5nbGI6IHsoZGF0YXNldF9kaXIgLyAnbW9kZWwuZ2xiJyku
#7#c3RhdCgpLnN0X3NpemUvMWU2Oi4xZn0gTUIiKQogICAgZWxzZToKICAgICAgICBwcmludCgiW1RS
#7#QUNLSU5HXSBubyBzdXJmYWNlIEdMQiBmb3VuZCDigJQgdGhlIG92ZXJsYXkgd2lsbCByZW5kZXIg
#7#Y2VsbHMgYW5kIHRyYWlscyBvbmx5IikKCiAgICAjIC0tLSBSZWdpb24gaW52ZW50b3J5IChkcml2
#7#ZXMgdGhlIGxlZ2VuZCBhbmQgdGhlIHJlZ2lvbiBjb2xvdXIgcGFsZXR0ZSkgLS0tCiAgICByZWdp
#7#b25fY291bnRzID0gQ291bnRlcihjWyJyZWdpb24iXSBmb3IgYyBpbiB0cmFja3NbImNlbGxzIl0u
#7#dmFsdWVzKCkpCiAgICByZWdpb25fY29sb3JzID0ge30KICAgIGZvciBjIGluIHRyYWNrc1siY2Vs
#7#bHMiXS52YWx1ZXMoKToKICAgICAgICByZWdpb25fY29sb3JzLnNldGRlZmF1bHQoY1sicmVnaW9u
#7#Il0sIGMuZ2V0KCJjb2xvciIpKQoKICAgIHN0YWJfcHRzLCByYXdfcHRzID0gW10sIFtdCiAgICBm
#7#b3IgYyBpbiB0cmFja3NbImNlbGxzIl0udmFsdWVzKCk6CiAgICAgICAgc3RhYl9wdHMuZXh0ZW5k
#7#KGNbInBvc2l0aW9ucyJdLnZhbHVlcygpKQogICAgICAgIHJhd19wdHMuZXh0ZW5kKChjLmdldCgi
#7#cmF3X3Bvc2l0aW9ucyIpIG9yIHt9KS52YWx1ZXMoKSkKCiAgICBtZXRhZGF0YVsidHJhY2tpbmci
#7#XSA9IHsKICAgICAgICAic2NoZW1hIjogImlyaWJobS10cmFja3MtdjEiLAogICAgICAgICJzb3Vy
#7#Y2UiOiB0cmFja19wYXRoLm5hbWUsCiAgICAgICAgInNvdXJjZURhdGFzZXQiOiBkb2MuZ2V0KCJk
#7#YXRhc2V0X25hbWUiKSwKICAgICAgICAiZ2VuZXJhdGVkIjogZG9jLmdldCgiZGF0ZV9nZW5lcmF0
#7#aW9uIiksCiAgICAgICAgImltcG9ydGVkIjogZGF0ZXRpbWUubm93KCkuaXNvZm9ybWF0KCksCiAg
#7#ICAgICAgInRyYWNrc1BhdGgiOiAidHJhY2tzLmpzb24iLAogICAgICAgICJzdXJmYWNlUGF0aCI6
#7#IHN1cmZhY2VfcmVsLAogICAgICAgICJjZWxsQ291bnQiOiBsZW4odHJhY2tzWyJjZWxscyJdKSwK
#7#ICAgICAgICAidGltZXBvaW50Q291bnQiOiBsZW4odHJhY2tzWyJ0aW1lcG9pbnRzIl0pLAogICAg
#7#ICAgICJoYXNSYXdDb29yZGluYXRlcyI6IGhhc19yYXcsCiAgICAgICAgIm1pdG9zaXNDb3VudCI6
#7#IHN1bSgxIGZvciBjIGluIHRyYWNrc1siY2VsbHMiXS52YWx1ZXMoKSBpZiBjWyJpc19taXRvc2lz
#7#Il0pLAogICAgICAgICJmdXNpb25Db3VudCI6IHN1bSgxIGZvciBjIGluIHRyYWNrc1siY2VsbHMi
#7#XS52YWx1ZXMoKSBpZiBjWyJpc19mdXNpb24iXSksCiAgICAgICAgInJlZ2lvbnMiOiBbeyJuYW1l
#7#IjogbmFtZSwgImNlbGxzIjogbiwgImNvbG9yIjogcmVnaW9uX2NvbG9ycy5nZXQobmFtZSl9CiAg
#7#ICAgICAgICAgICAgICAgICAgZm9yIG5hbWUsIG4gaW4gcmVnaW9uX2NvdW50cy5tb3N0X2NvbW1v
#7#bigpXSwKICAgICAgICAiYm91bmRzVW0iOiB7InN0YWJpbGl6ZWQiOiBfYm91bmRzKHN0YWJfcHRz
#7#KSwgInJhdyI6IF9ib3VuZHMocmF3X3B0cyl9LAogICAgfQogICAgIyBXaGljaCBvZiB0aGUgdGhy
#7#ZWUgc2hhcGVzIHRoZSB0cmFja2luZyBhY3R1YWxseSBjYW1lIGZyb20sIGFuZCBob3cgaXRzIGNs
#7#YXNzaWZpY2F0aW9uCiAgICAjIHdhcyByZXNvbHZlZCDigJQgdGhlIGFuc3dlciBpcyBub3QgcmVj
#7#b3ZlcmFibGUgZnJvbSB0cmFja3MuanNvbiBhZnRlcndhcmRzLgogICAgcHJvdmVuYW5jZSA9IChk
#7#b2MuZ2V0KCJkYXRhIikgb3Ige30pLmdldCgicHJvdmVuYW5jZSIpCiAgICBpZiBpc2luc3RhbmNl
#7#KHByb3ZlbmFuY2UsIGRpY3QpOgogICAgICAgIG1ldGFkYXRhWyJ0cmFja2luZyJdWyJwcm92ZW5h
#7#bmNlIl0gPSBwcm92ZW5hbmNlCgogICAgaWYgcmVnaXN0cmF0aW9uOgogICAgICAgIGV4dGVudCA9
#7#IG1ldGFkYXRhLmdldCgiYWNxdWlzaXRpb25FeHRlbnRVbSIpCiAgICAgICAgb2NjdXBpZWQgPSBf
#7#b2NjdXBpZWRfYm94ZXNfdW0oZGF0YXNldF9kaXIsIGV4dGVudCwgbWV0YWRhdGEuZ2V0KCJkaW1l
#7#bnNpb25zIikpCiAgICAgICAgdW5pb24gPSBfaW1hZ2VfYm94X3VuaW9uKHJlZ2lzdHJhdGlvbiwg
#7#ZXh0ZW50LCBvY2N1cGllZCkKICAgICAgICBpZiB1bmlvbjoKICAgICAgICAgICAgcmVnaXN0cmF0
#7#aW9uWyJpbWFnZUJveFVuaW9uVW0iXSA9IHVuaW9uCiAgICAgICAgICAgIHNwYW4gPSBbdW5pb25b
#7#Im1heCJdW2ldIC0gdW5pb25bIm1pbiJdW2ldIGZvciBpIGluIHJhbmdlKDMpXQogICAgICAgICAg
#7#ICBhY3EgPSBbZXh0ZW50WyJtYXgiXVtpXSAtIGV4dGVudFsibWluIl1baV0gZm9yIGkgaW4gcmFu
#7#Z2UoMyldCiAgICAgICAgICAgIHJhdGlvID0gKHNwYW5bMF0gKiBzcGFuWzFdICogc3BhblsyXSkg
#7#LyBtYXgoYWNxWzBdICogYWNxWzFdICogYWNxWzJdLCAxZS05KQogICAgICAgICAgICBwcmludChm
#7#IltUUkFDS0lOR10gZGlzcGxheSBib3ggKHt1bmlvblsnYmFzaXMnXX0pOiAiCiAgICAgICAgICAg
#7#ICAgICAgIGYie3NwYW5bMF06LjBmfSB4IHtzcGFuWzFdOi4wZn0geCB7c3BhblsyXTouMGZ9IHVt
#7#LCAiCiAgICAgICAgICAgICAgICAgIGYie3JhdGlvOi4yZn14IHRoZSBhY3F1aXNpdGlvbiB2b2x1
#7#bWUiKQogICAgICAgIG1ldGFkYXRhWyJyZWdpc3RyYXRpb24iXSA9IHJlZ2lzdHJhdGlvbgoKICAg
#7#ICAgICBxYyA9IHJlZ2lzdHJhdGlvblsicWNTdW1tYXJ5Il0KICAgICAgICB2ZXJkaWN0ID0gInJp
#7#Z2lkZSAoZXhhY3RlKSIgaWYgcWNbInJpZ2lkIl0gZWxzZSAiTk9OIHJpZ2lkZSIKICAgICAgICBw
#7#cmludChmIltUUkFDS0lOR10gcmVnaXN0cmF0aW9uOiB7cWNbJ3RpbWVwb2ludHNTb2x2ZWQnXX0v
#7#e3FjWyd0aW1lcG9pbnRzVG90YWwnXX0gIgogICAgICAgICAgICAgIGYidGltZXBvaW50cywgcmVz
#7#aWR1IG1heCB7cWNbJ21heFJlc2lkdWFsVW0nXTouM2d9IHVtIC0+IHt2ZXJkaWN0fSIpCiAgICAg
#7#ICAgZm9yIHcgaW4gcWNbIndhcm5pbmdzIl06CiAgICAgICAgICAgIHByaW50KGYiW1RSQUNLSU5H
#7#XSAgIFshXSB7d30iKQoKICAgIG1ldGFkYXRhWyJsYXN0TW9kaWZpZWQiXSA9IGRhdGV0aW1lLm5v
#7#dygpLmlzb2Zvcm1hdCgpCiAgICBhdG9taWNfd3JpdGVfanNvbihtZXRhZGF0YV9wYXRoLCBtZXRh
#7#ZGF0YSwgaW5kZW50PTIsIGVuc3VyZV9hc2NpaT1GYWxzZSkKICAgIHByaW50KGYiW1RSQUNLSU5H
#7#XSBVcGRhdGVkIHttZXRhZGF0YV9wYXRofSIpCiAgICByZXR1cm4gbWV0YWRhdGEKCgpkZWYgbWFp
#7#bigpOgogICAgYXAgPSBhcmdwYXJzZS5Bcmd1bWVudFBhcnNlcigKICAgICAgICBkZXNjcmlwdGlv
#7#bj0iQXR0YWNoIGFuIEltYXJpcyBjZWxsLXRyYWNraW5nIGFuYWx5c2lzIHRvIGEgcHJlcHJvY2Vz
#7#c2VkIHZvbHVtZSBkYXRhc2V0LiIpCiAgICBhcC5hZGRfYXJndW1lbnQoInRyYWNrIiwgaGVscD0i
#7#cGF0aCB0byB0aGUgYW5hbHlzaXM6IGEgLmltYXJpc190cmFjayBjb250YWluZXIsIHRoZSAuaW1z
#7#ICIKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICJpdHNlbGYgKEltYXJpcyBvYmpl
#7#Y3RzIGFyZSByZWFkIGZyb20gU2NlbmU4KSwgb3IgdGhlICIKICAgICAgICAgICAgICAgICAgICAg
#7#ICAgICAgICAgICAgICIueGxzLy54bHN4IHN0YXRpc3RpY3Mgd29ya2Jvb2sgZXhwb3J0ZWQgZnJv
#7#bSBJbWFyaXMiKQogICAgYXAuYWRkX2FyZ3VtZW50KCJkYXRhc2V0IiwgaGVscD0iZGF0YXNldCBk
#7#aXJlY3RvcnksIGUuZy4gREFUQV9XRUIvbGl2ZS88bmFtZT4iKQogICAgYXAuYWRkX2FyZ3VtZW50
#7#KCItLWdsYiIsIGRlZmF1bHQ9Tm9uZSwKICAgICAgICAgICAgICAgICAgICBoZWxwPSJzdXJmYWNl
#7#IEdMQiB0byBhdHRhY2ggKGRlZmF1bHQ6IDx0cmFjaz4uZ2xiIG5leHQgdG8gdGhlIGNvbnRhaW5l
#7#cikiKQogICAgYXAuYWRkX2FyZ3VtZW50KCItLXRpbWVwb2ludC1vZmZzZXQiLCB0eXBlPWludCwg
#7#ZGVmYXVsdD0tMSwKICAgICAgICAgICAgICAgICAgICBoZWxwPSJhZGRlZCB0byB0aGUgdHJhY2tp
#7#bmcgdGltZXBvaW50IHRvIGdldCB0aGUgdm9sdW1lIGZyYW1lIGluZGV4ICIKICAgICAgICAgICAg
#7#ICAgICAgICAgICAgICIoZGVmYXVsdCAtMTogSW1hcmlzIGNvdW50cyBmcmFtZXMgZnJvbSAxLCB0
#7#aGUgYnJpY2sgcHlyYW1pZCBmcm9tIDApIikKICAgIGFwLmFkZF9hcmd1bWVudCgiLS1uby1nemlw
#7#IiwgYWN0aW9uPSJzdG9yZV90cnVlIiwgaGVscD0ic2tpcCB3cml0aW5nIHRyYWNrcy5qc29uLmd6
#7#IikKICAgIGFyZ3MgPSBhcC5wYXJzZV9hcmdzKCkKCiAgICB0cnk6CiAgICAgICAgaW1wb3J0X3Ry
#7#YWNraW5nKFBhdGgoYXJncy50cmFjayksIFBhdGgoYXJncy5kYXRhc2V0KSwKICAgICAgICAgICAg
#7#ICAgICAgICAgICAgUGF0aChhcmdzLmdsYikgaWYgYXJncy5nbGIgZWxzZSBOb25lLAogICAgICAg
#7#ICAgICAgICAgICAgICAgICB0aW1lcG9pbnRfb2Zmc2V0PWFyZ3MudGltZXBvaW50X29mZnNldCwK
#7#ICAgICAgICAgICAgICAgICAgICAgICAgd3JpdGVfZ3ppcD1ub3QgYXJncy5ub19nemlwKQogICAg
#7#ICAgIHByaW50KCJbVFJBQ0tJTkddIEltcG9ydCBjb21wbGV0ZS4iKQogICAgZXhjZXB0IEV4Y2Vw
#7#dGlvbiBhcyBleGM6CiAgICAgICAgaW1wb3J0IHRyYWNlYmFjawogICAgICAgIHRyYWNlYmFjay5w
#7#cmludF9leGMoKQogICAgICAgIHByaW50KGYiW0VSUk9SXSBUcmFja2luZyBpbXBvcnQgZmFpbGVk
#7#OiB7ZXhjfSIsIGZpbGU9c3lzLnN0ZGVycikKICAgICAgICBzeXMuZXhpdCgxKQoKCmlmIF9fbmFt
#7#ZV9fID09ICJfX21haW5fXyI6CiAgICBtYWluKCkK
:: ---- [8] tracking_sources.py (34884 octets) ----
#8#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwoiIiJGaW5kIHRoZSBjZWxsLXRyYWNraW5nIGFuYWx5c2lz
#8#IHRoYXQgYmVsb25ncyB0byBhbiAuaW1zIHZvbHVtZSwgd2hhdGV2ZXIgc2hhcGUgaXQgY2FtZSBp
#8#bi4KClRocmVlIHNoYXBlcyBleGlzdCBpbiB0aGUgbGFiLCBhbmQgYSBkYXRhc2V0IG1heSBjYXJy
#8#eSBhbnkgb25lIG9mIHRoZW06CgogIDEuIGBgPHN0ZW0+LmltYXJpc190cmFja2BgICAgdGhlIHRy
#8#YWNraW5nIHBpcGVsaW5lJ3Mgb3duIG91dHB1dCAoZ3ppcCtKU09OIGNvbnRhaW5lcikuCiAgICAg
#8#ICAgICAgICAgICAgICAgICAgICAgICAgICBBbHJlYWR5IGNhcnJpZXMgc3RhYmlsaXNlZCBBTkQg
#8#cmF3IGNvb3JkaW5hdGVzLCBsaW5lYWdlIGFuZAogICAgICAgICAgICAgICAgICAgICAgICAgICAg
#8#ICAgZXZlbnQgbWFya2VycywgYW5kIHVzdWFsbHkgYSBzaWJsaW5nIGBgPHN0ZW0+LmdsYmBgIHN1
#8#cmZhY2UuCiAgMi4gdGhlIGBgLmltc2BgIGl0c2VsZiAgICAgICBJbWFyaXMga2VlcHMgaXRzIFNw
#8#b3RzL1RyYWNrcyBvYmplY3RzIGluIGBgU2NlbmU4L0NvbnRlbnRgYC4KICAgICAgICAgICAgICAg
#8#ICAgICAgICAgICAgICAgIE5vdGhpbmcgaGFzIHRvIHNpdCBuZXh0IHRvIHRoZSB2b2x1bWUgZm9y
#8#IHRoaXMgdG8gd29yay4KICAzLiBgYDxzdGVtPi54bHNgYCAvIGBgLnhsc3hgYCB0aGUgSW1hcmlz
#8#ICJleHBvcnQgc3RhdGlzdGljcyBvbiBhbGwgdGFicyIgd29ya2Jvb2ssIHdob3NlCiAgICAgICAg
#8#ICAgICAgICAgICAgICAgICAgICAgICBgYFBvc2l0aW9uYGAgc2hlZXQgaG9sZHMgb25lIHJvdyBw
#8#ZXIgc3BvdCBwZXIgdGltZXBvaW50LgoKUHJlZmVyZW5jZSBvcmRlciBpcyAoMSkgPiAoMikgPiAo
#8#Myk6IHRoZSBjb250YWluZXIgaXMgdGhlIHJpY2hlc3QgKGl0IGlzIGEgZmluaXNoZWQgYW5hbHlz
#8#aXMsCnN1cmZhY2VzIGluY2x1ZGVkKSwgU2NlbmU4IGNvbWVzIG5leHQgYmVjYXVzZSBpdCBpcyAq
#8#aW5zaWRlKiB0aGUgdm9sdW1lIOKAlCBubyBzaWRlY2FyIHRvIGxvc2UsCm5vIHNoZWV0LW5hbWUg
#8#YW1iaWd1aXR5IOKAlCBhbmQgdGhlIHdvcmtib29rIGxhc3QsIGFzIHRoZSBmYWxsYmFjayBmb3Ig
#8#dm9sdW1lcyB3aG9zZSBTY2VuZTgKb2JqZWN0cyB3ZXJlIHN0cmlwcGVkIG9yIG5ldmVyIHNhdmVk
#8#LgoKU291cmNlcyAoMikgYW5kICgzKSBhcmUgcmF3IG9ic2VydmF0aW9uczogdGhleSBjYXJyeSBz
#8#cG90IHBvc2l0aW9ucywgdHJhY2sgbWVtYmVyc2hpcCBhbmQgYQpjbGFzc2lmaWNhdGlvbiwgYnV0
#8#IG5vIHVuaXF1ZSBjZWxsIGlkZW50aXR5LCBubyBsaW5lYWdlIGFuZCBubyBzdGFiaWxpc2F0aW9u
#8#LiBUaG9zZSBhcmUKcHJvZHVjZWQgaGVyZSBieSBjYWxsaW5nIHRoZSBsYWIncyBvd24gYW5hbHlz
#8#aXMgY29kZSAoYGBTQ1JJUFRTL0FuYWx5c2lzLnB5YGApIHJhdGhlciB0aGFuIGEKc2Vjb25kIGlt
#8#cGxlbWVudGF0aW9uIOKAlCBhIGRhdGFzZXQgbXVzdCB5aWVsZCB0aGUgc2FtZSB0cmFja3Mgd2hl
#8#dGhlciBpdCB3ZW50IHRocm91Z2ggdGhlCnRyYWNraW5nIHBpcGVsaW5lIG9yIHRocm91Z2ggdGhp
#8#cyBzaG9ydGN1dC4gVGhlIHBvcHVsYXRpb24gc3VyZmFjZXMgYXJlIE5PVCByZWJ1aWx0IGhlcmU6
#8#Cm9ubHkgYSBjb250YWluZXIgKDEpIGNhbiBicmluZyBhIGBgbW9kZWwuZ2xiYGA7IGEgZGF0YXNl
#8#dCBhdHRhY2hlZCBmcm9tICgyKSBvciAoMykgZ2V0cwpjZWxscyBhbmQgdHJhaWxzLCBhbmQgaXRz
#8#IHN1cmZhY2UgbGF5ZXIgc3RheXMgZW1wdHkgdW50aWwgdGhlIHRyYWNraW5nIHBpcGVsaW5lIGlz
#8#IHJ1bi4KCkNMSSAoZGlhZ25vc3RpY3MpOgogICAgcHl0aG9uIHRyYWNraW5nX3NvdXJjZXMucHkg
#8#PGZpbGUuaW1zfGZpbGUueGxzfGZpbGUueGxzeD4gWy0tbGlzdF0gWy0tb3V0IDxjb250YWluZXI+
#8#XQoiIiIKaW1wb3J0IGFyZ3BhcnNlCmltcG9ydCBnemlwCmltcG9ydCBpbXBvcnRsaWIudXRpbApp
#8#bXBvcnQganNvbgppbXBvcnQgb3MKaW1wb3J0IHN5cwppbXBvcnQgdXVpZApmcm9tIGRhdGV0aW1l
#8#IGltcG9ydCBkYXRldGltZQpmcm9tIHBhdGhsaWIgaW1wb3J0IFBhdGgKCmltcG9ydCBudW1weSBh
#8#cyBucAoKX192ZXJzaW9uX18gPSAiMC4xLjAiCgpTSUdOQVRVUkUgPSAiSU1BUklTX1RSQUNLRVJf
#8#VjEiClNDUklQVF9ESVIgPSBQYXRoKF9fZmlsZV9fKS5yZXNvbHZlKCkucGFyZW50CgpDT05UQUlO
#8#RVJfU1VGRklYID0gIi5pbWFyaXNfdHJhY2siCkVYQ0VMX1NVRkZJWEVTID0gKCIueGxzIiwgIi54
#8#bHN4IiwgIi54bHNtIikKCiMgSW1hcmlzIG51bWJlcnMgYWNxdWlzaXRpb24gZnJhbWVzIGZyb20g
#8#MSBpbiBldmVyeSBzdGF0aXN0aWNzIGV4cG9ydCwgYW5kIHRoZSB3aG9sZQojIGRvd25zdHJlYW0g
#8#Y2hhaW4gKHRoZSBjb250YWluZXJzIHRoZSB0cmFja2luZyBwaXBlbGluZSB3cml0ZXMsIHRoZSBp
#8#bXBvcnRlcidzIGRlZmF1bHQKIyAtLXRpbWVwb2ludC1vZmZzZXQgb2YgLTEpIGlzIGJ1aWx0IG9u
#8#IHRoYXQuIFNjZW5lOCBpbmRleGVzIGl0cyB0aW1lcG9pbnRzIGZyb20gMCwgc28gdGhlCiMgb25s
#8#eSBwbGFjZSB0aGUgdHdvIGNvbnZlbnRpb25zIG1lZXQgaXMgaGVyZS4KU0NFTkU4X1RJTUVfQkFT
#8#RSA9IDEKCiMgQ29sdW1uIGhlYWRlcnMgSW1hcmlzIGVtaXRzIG9uIHRoZSBQb3NpdGlvbiBzaGVl
#8#dCB0aGF0IGFyZSBuZXZlciB0aGUgY2xhc3NpZmljYXRpb24uCiMgV2hhdGV2ZXIgc2luZ2xlIGhl
#8#YWRlciBpcyBsZWZ0IG92ZXIgSVMgdGhlIGNsYXNzaWZpY2F0aW9uLCB3aG9zZSBuYW1lIHRoZSBi
#8#aW9sb2dpc3QgY2hvc2UKIyAoIlJlZ2lvbiIsICJTZXQgMSIsICJQb2ludCBMb2NhdGlvbnMiLCAi
#8#RW5kb3RoZWxpYWwgY2VsbHMiLCDigKYgYWxsIHNlZW4gaW4gdGhlIHdpbGQpLgpfUE9TSVRJT05f
#8#UkVTRVJWRUQgPSB7CiAgICAicG9zaXRpb24geCIsICJwb3NpdGlvbiB5IiwgInBvc2l0aW9uIHoi
#8#LCAidW5pdCIsICJjYXRlZ29yeSIsICJjb2xsZWN0aW9uIiwKICAgICJ0aW1lIiwgInRpbWUgaW5k
#8#ZXgiLCAidHJhY2tpZCIsICJ0cmFjayBpZCIsICJpZCIsICJiaXJ0aCIsICJkZWF0aCIsCiAgICAi
#8#cmVmZXJlbmNlZnJhbWUiLCAicmVmZXJlbmNlIGZyYW1lIiwgImNsYXNzIiwgImltYWdlIiwgImNo
#8#YW5uZWwiLCAibGV2ZWwiLAp9CgoKIyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#8#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#8#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#8#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#8#lIDilIDilIDilIDilIDilIDilIDilIDilIAKIyAgRGlzY292ZXJ5CiMg4pSA4pSA4pSA4pSA4pSA
#8#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#8#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#8#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#8#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACgpjbGFzcyBUcmFj
#8#a2luZ1NvdXJjZToKICAgICIiIk9uZSBjYW5kaWRhdGUgdHJhY2tpbmcgYW5hbHlzaXMgZm9yIGEg
#8#ZGF0YXNldC4iIiIKCiAgICAjOiBwcmVmZXJlbmNlIG9yZGVyLCBsb3dlc3QgZmlyc3QKICAgIFJB
#8#TksgPSB7ImNvbnRhaW5lciI6IDAsICJzY2VuZTgiOiAxLCAiZXhjZWwiOiAyfQoKICAgIGRlZiBf
#8#X2luaXRfXyhzZWxmLCBraW5kOiBzdHIsIHBhdGg6IFBhdGgsIGRldGFpbDogc3RyID0gIiIsIGds
#8#YjogUGF0aCA9IE5vbmUpOgogICAgICAgIHNlbGYua2luZCA9IGtpbmQKICAgICAgICBzZWxmLnBh
#8#dGggPSBQYXRoKHBhdGgpCiAgICAgICAgc2VsZi5kZXRhaWwgPSBkZXRhaWwKICAgICAgICBzZWxm
#8#LmdsYiA9IFBhdGgoZ2xiKSBpZiBnbGIgZWxzZSBOb25lCgogICAgQHByb3BlcnR5CiAgICBkZWYg
#8#cmFuayhzZWxmKSAtPiBpbnQ6CiAgICAgICAgcmV0dXJuIHNlbGYuUkFOSy5nZXQoc2VsZi5raW5k
#8#LCA5OSkKCiAgICBkZWYgZGVzY3JpYmUoc2VsZikgLT4gc3RyOgogICAgICAgIGxhYmVsID0geyJj
#8#b250YWluZXIiOiAiY29udGVuZXVyIC5pbWFyaXNfdHJhY2siLAogICAgICAgICAgICAgICAgICJz
#8#Y2VuZTgiOiAib2JqZXRzIEltYXJpcyBlbWJhcnF1ZXMgKFNjZW5lOCkiLAogICAgICAgICAgICAg
#8#ICAgICJleGNlbCI6ICJjbGFzc2V1ciBzdGF0aXN0aXF1ZXMgSW1hcmlzIn0uZ2V0KHNlbGYua2lu
#8#ZCwgc2VsZi5raW5kKQogICAgICAgIHN1ZmZpeCA9IGYiIOKAlCB7c2VsZi5kZXRhaWx9IiBpZiBz
#8#ZWxmLmRldGFpbCBlbHNlICIiCiAgICAgICAgcmV0dXJuIGYie2xhYmVsfToge3NlbGYucGF0aC5u
#8#YW1lfXtzdWZmaXh9IgoKICAgIGRlZiBfX3JlcHJfXyhzZWxmKToKICAgICAgICByZXR1cm4gZiI8
#8#VHJhY2tpbmdTb3VyY2Uge3NlbGYua2luZH0ge3NlbGYucGF0aC5uYW1lfT4iCgoKZGVmIF9zaWRl
#8#Y2FyX2NhbmRpZGF0ZXMoaW1zX3BhdGg6IFBhdGgsIHN1ZmZpeGVzKToKICAgICIiIkZpbGVzIHNo
#8#YXJpbmcgdGhlIHZvbHVtZSdzIHN0ZW0sIGJlc2lkZSBpdCBvciBpbiBhIGZvbGRlciBuYW1lZCBh
#8#ZnRlciBpdC4KCiAgICBUaGUgbGFiIHNoaXBzIGFuYWx5c2VzIGVpdGhlciBmbGF0IG5leHQgdG8g
#8#dGhlIC5pbXMgb3IgZ3JvdXBlZCBvbmUtZm9sZGVyLXBlci1zYW1wbGUKICAgICh0aGF0IGlzIGhv
#8#dyBgYElOUFVUIFNUQVRJU1RJQ1MuemlwYGAgdW5wYWNrcyksIHNvIGJvdGggbGF5b3V0cyBhcmUg
#8#c2VhcmNoZWQuCiAgICAiIiIKICAgIHN0ZW0gPSBpbXNfcGF0aC5zdGVtCiAgICBzZWVuLCBvdXQg
#8#PSBzZXQoKSwgW10KICAgIGZvciBiYXNlIGluIChpbXNfcGF0aC5wYXJlbnQsIGltc19wYXRoLnBh
#8#cmVudCAvIHN0ZW0pOgogICAgICAgIGlmIG5vdCBiYXNlLmlzX2RpcigpOgogICAgICAgICAgICBj
#8#b250aW51ZQogICAgICAgIGZvciBzdWZmaXggaW4gc3VmZml4ZXM6CiAgICAgICAgICAgIGZvciBj
#8#YW5kIGluIChiYXNlIC8gZiJ7c3RlbX17c3VmZml4fSIsIGJhc2UgLyBmIntzdGVtfV9hbmFseXNp
#8#c3tzdWZmaXh9Iik6CiAgICAgICAgICAgICAgICBpZiBjYW5kLmlzX2ZpbGUoKSBhbmQgY2FuZCBu
#8#b3QgaW4gc2VlbjoKICAgICAgICAgICAgICAgICAgICBzZWVuLmFkZChjYW5kKQogICAgICAgICAg
#8#ICAgICAgICAgIG91dC5hcHBlbmQoY2FuZCkKICAgIHJldHVybiBvdXQKCgpkZWYgZGlzY292ZXIo
#8#aW1zX3BhdGgpIC0+IGxpc3Q6CiAgICAiIiJFdmVyeSB0cmFja2luZyBzb3VyY2UgdGhhdCBleGlz
#8#dHMgZm9yIHRoaXMgdm9sdW1lLCBiZXN0IGZpcnN0LiIiIgogICAgaW1zX3BhdGggPSBQYXRoKGlt
#8#c19wYXRoKQogICAgZm91bmQgPSBbXQoKICAgIGZvciBjYW5kIGluIF9zaWRlY2FyX2NhbmRpZGF0
#8#ZXMoaW1zX3BhdGgsIChDT05UQUlORVJfU1VGRklYLCkpOgogICAgICAgIGdsYiA9IGNhbmQud2l0
#8#aF9zdWZmaXgoIi5nbGIiKQogICAgICAgIGZvdW5kLmFwcGVuZChUcmFja2luZ1NvdXJjZSgiY29u
#8#dGFpbmVyIiwgY2FuZCwKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgInN1cmZh
#8#Y2VzIC5nbGIgaW5jbHVzZXMiIGlmIGdsYi5leGlzdHMoKSBlbHNlICIiLAogICAgICAgICAgICAg
#8#ICAgICAgICAgICAgICAgICAgICAgICBnbGIgaWYgZ2xiLmV4aXN0cygpIGVsc2UgTm9uZSkpCgog
#8#ICAgaWYgaW1zX3BhdGguc3VmZml4Lmxvd2VyKCkgPT0gIi5pbXMiOgogICAgICAgIHN1bW1hcnkg
#8#PSBwcm9iZV9zY2VuZTgoaW1zX3BhdGgpCiAgICAgICAgaWYgc3VtbWFyeToKICAgICAgICAgICAg
#8#Zm91bmQuYXBwZW5kKFRyYWNraW5nU291cmNlKCJzY2VuZTgiLCBpbXNfcGF0aCwgc3VtbWFyeSkp
#8#CgogICAgZm9yIGNhbmQgaW4gX3NpZGVjYXJfY2FuZGlkYXRlcyhpbXNfcGF0aCwgRVhDRUxfU1VG
#8#RklYRVMpOgogICAgICAgIGZvdW5kLmFwcGVuZChUcmFja2luZ1NvdXJjZSgiZXhjZWwiLCBjYW5k
#8#KSkKCiAgICBmb3VuZC5zb3J0KGtleT1sYW1iZGEgczogcy5yYW5rKQogICAgcmV0dXJuIGZvdW5k
#8#CgoKIyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#8#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#8#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#8#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#8#lIDilIDilIAKIyAgU291cmNlIDIg4oCUIEltYXJpcyBTY2VuZTggb2JqZWN0cywgcmVhZCBzdHJh
#8#aWdodCBvdXQgb2YgdGhlIC5pbXMKIyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#8#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#8#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#8#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#8#lIDilIDilIDilIDilIDilIDilIDilIDilIAKCmRlZiBfaDVfdGV4dCh2YWx1ZSkgLT4gc3RyOgog
#8#ICAgIiIiSW1hcmlzIHdyaXRlcyBzdHJpbmdzIGJvdGggYXMgb25lIGJ5dGUgYmxvYiBhbmQgYXMg
#8#YW4gYXJyYXkgb2Ygc2luZ2xlIGNoYXJhY3RlcnMuIiIiCiAgICBpZiBpc2luc3RhbmNlKHZhbHVl
#8#LCAoYnl0ZXMsIG5wLmJ5dGVzXykpOgogICAgICAgIHJldHVybiB2YWx1ZS5kZWNvZGUoInV0Zi04
#8#IiwgInJlcGxhY2UiKS5zdHJpcCgpCiAgICBpZiBpc2luc3RhbmNlKHZhbHVlLCBucC5uZGFycmF5
#8#KToKICAgICAgICBwYXJ0cyA9IFtieXRlcyhjKSBpZiBpc2luc3RhbmNlKGMsIChieXRlcywgbnAu
#8#Ynl0ZXNfKSkgZWxzZSBzdHIoYykuZW5jb2RlKCJ1dGYtOCIpCiAgICAgICAgICAgICAgICAgZm9y
#8#IGMgaW4gdmFsdWUucmF2ZWwoKV0KICAgICAgICByZXR1cm4gYiIiLmpvaW4ocGFydHMpLmRlY29k
#8#ZSgidXRmLTgiLCAicmVwbGFjZSIpLnN0cmlwKCkKICAgIHJldHVybiBzdHIodmFsdWUpLnN0cmlw
#8#KCkKCgpkZWYgX3BpY2tfcG9pbnRzX2dyb3VwKGNvbnRlbnQpOgogICAgIiIiVGhlIFNwb3RzIG9i
#8#amVjdCBob2xkaW5nIHRoZSB0cmFja2luZy4gSW1hcmlzIGFsbG93cyBzZXZlcmFsOyB0YWtlIHRo
#8#ZSBsYXJnZXN0LiIiIgogICAgYmVzdCA9IE5vbmUKICAgIGZvciBuYW1lIGluIGNvbnRlbnQua2V5
#8#cygpOgogICAgICAgIGdyb3VwID0gY29udGVudC5nZXQobmFtZSkKICAgICAgICBpZiBub3QgaGFz
#8#YXR0cihncm91cCwgImtleXMiKSBvciAiU3BvdCIgbm90IGluIGdyb3VwOgogICAgICAgICAgICBj
#8#b250aW51ZQogICAgICAgIG5fc3BvdHMgPSBpbnQoZ3JvdXBbIlNwb3QiXS5zaGFwZVswXSkKICAg
#8#ICAgICBpZiBuX3Nwb3RzIGFuZCAoYmVzdCBpcyBOb25lIG9yIG5fc3BvdHMgPiBiZXN0WzFdKToK
#8#ICAgICAgICAgICAgYmVzdCA9IChuYW1lLCBuX3Nwb3RzLCBncm91cCkKICAgIHJldHVybiBiZXN0
#8#CgoKZGVmIF90cmFja190YWJsZV9uYW1lcyhncm91cCk6CiAgICAiIiJEYXRhc2V0IG5hbWVzIG9m
#8#IHRoZSB0cmFjayB0YWJsZXMsIGFzIGRlY2xhcmVkIGJ5IE1haW5UcmFja1RhYmxlLgoKICAgIElt
#8#YXJpcyB3cml0ZXMgYGBUcmFjazBgYC9gYFRyYWNrT2JqZWN0MGBgL2BgVHJhY2tFZGdlMGBgIGlu
#8#IHByYWN0aWNlLCBidXQgdGhlIG5hbWVzIGFyZQogICAgZGF0YSwgbm90IGNvbnZlbnRpb24g4oCU
#8#IE1haW5UcmFja1RhYmxlIGlzIHRoZSBpbmRleCB0aGF0IHJlc29sdmVzIHRoZW0uCiAgICAiIiIK
#8#ICAgIHRhYmxlID0gZ3JvdXAuZ2V0KCJNYWluVHJhY2tUYWJsZSIpCiAgICBpZiB0YWJsZSBpcyBu
#8#b3QgTm9uZSBhbmQgdGFibGUuc2hhcGVbMF06CiAgICAgICAgcm93ID0gdGFibGVbMF0KICAgICAg
#8#ICBuYW1lcyA9IChfaDVfdGV4dChyb3dbMV0pLCBfaDVfdGV4dChyb3dbMl0pLCBfaDVfdGV4dChy
#8#b3dbM10pKQogICAgICAgIGlmIGFsbChuIGluIGdyb3VwIGZvciBuIGluIG5hbWVzKToKICAgICAg
#8#ICAgICAgcmV0dXJuIG5hbWVzCiAgICBpZiAiVHJhY2swIiBpbiBncm91cCBhbmQgIlRyYWNrT2Jq
#8#ZWN0MCIgaW4gZ3JvdXA6CiAgICAgICAgcmV0dXJuICgiVHJhY2swIiwgIlRyYWNrT2JqZWN0MCIs
#8#ICJUcmFja0VkZ2UwIikKICAgIHJldHVybiBOb25lCgoKZGVmIHByb2JlX3NjZW5lOChpbXNfcGF0
#8#aCkgLT4gc3RyOgogICAgIiIiT25lLWxpbmUgc3VtbWFyeSBvZiB0aGUgdHJhY2tpbmcgaW5zaWRl
#8#IGFuIC5pbXMsIG9yICIiIHdoZW4gdGhlcmUgaXMgbm9uZS4iIiIKICAgIHRyeToKICAgICAgICBp
#8#bXBvcnQgaDVweQogICAgZXhjZXB0IEltcG9ydEVycm9yOgogICAgICAgIHJldHVybiAiIgogICAg
#8#dHJ5OgogICAgICAgIHdpdGggaDVweS5GaWxlKHN0cihpbXNfcGF0aCksICJyIikgYXMgZjoKICAg
#8#ICAgICAgICAgY29udGVudCA9IGYuZ2V0KCJTY2VuZTgvQ29udGVudCIpCiAgICAgICAgICAgIGlm
#8#IGNvbnRlbnQgaXMgTm9uZToKICAgICAgICAgICAgICAgIHJldHVybiAiIgogICAgICAgICAgICBw
#8#aWNrZWQgPSBfcGlja19wb2ludHNfZ3JvdXAoY29udGVudCkKICAgICAgICAgICAgaWYgcGlja2Vk
#8#IGlzIE5vbmU6CiAgICAgICAgICAgICAgICByZXR1cm4gIiIKICAgICAgICAgICAgbmFtZSwgbl9z
#8#cG90cywgZ3JvdXAgPSBwaWNrZWQKICAgICAgICAgICAgbmFtZXMgPSBfdHJhY2tfdGFibGVfbmFt
#8#ZXMoZ3JvdXApCiAgICAgICAgICAgIGlmIG5vdCBuYW1lczoKICAgICAgICAgICAgICAgIHJldHVy
#8#biAiIgogICAgICAgICAgICBuX3RyYWNrcyA9IGludChncm91cFtuYW1lc1swXV0uc2hhcGVbMF0p
#8#CiAgICAgICAgICAgIGlmIG5vdCBuX3RyYWNrczoKICAgICAgICAgICAgICAgIHJldHVybiAiIgog
#8#ICAgICAgICAgICBuX3RwID0gaW50KGdyb3VwWyJTcG90VGltZU9mZnNldCJdLnNoYXBlWzBdKSBp
#8#ZiAiU3BvdFRpbWVPZmZzZXQiIGluIGdyb3VwIGVsc2UgMAogICAgICAgICAgICBvYmpfbmFtZSA9
#8#IF9oNV90ZXh0KGdyb3VwLmF0dHJzLmdldCgiTmFtZSIsIG5hbWUpKQogICAgICAgICAgICByZXR1
#8#cm4gZiJ7bl9zcG90c30gc3BvdHMsIHtuX3RyYWNrc30gcGlzdGVzLCB7bl90cH0gdGltZXBvaW50
#8#cyAoe29ial9uYW1lfSkiCiAgICBleGNlcHQgRXhjZXB0aW9uOgogICAgICAgIHJldHVybiAiIgoK
#8#CmRlZiBfc2NlbmU4X2xhYmVscyhncm91cCwgc3BvdF9pZHM6IHNldCwgdHJhY2tfaWRzOiBzZXQp
#8#OgogICAgIiIiUmVzb2x2ZSB0aGUgYmlvbG9naXN0J3MgY2xhc3NpZmljYXRpb24gaW50byBgYG9i
#8#amVjdCBpZCAtPiBsYWJlbGBgLgoKICAgIEltYXJpcyBzdG9yZXMgaXQgYXMgYSBmbGF0LCBjdW11
#8#bGF0aXZlIGluZGV4OiBMYWJlbFZhbHVlcyBob2xkcyBldmVyeSBsYWJlbCBvZiBldmVyeQogICAg
#8#Z3JvdXAgYmFjayB0byBiYWNrLCBMYWJlbEdyb3VwTmFtZXMgY2xvc2VzIGVhY2ggZ3JvdXAgd2l0
#8#aCBhbiBlbmQgb2Zmc2V0LCBhbmQgTGFiZWxTZXRzCiAgICBjbG9zZXMgZWFjaCAobGFiZWxzLCBv
#8#YmplY3RzKSBhc3NpZ25tZW50IHRoZSBzYW1lIHdheS4gQSBncm91cCBpcyBhcHBsaWVkIGVpdGhl
#8#ciB0bwogICAgc3BvdHMgb3IgdG8gdHJhY2tzLCBhbmQgYm90aCB1c3VhbGx5IGV4aXN0ICgiUG9p
#8#bnQgTG9jYXRpb25zIiAvICJUcmFjayBMb2NhdGlvbnMiKS4KICAgICIiIgogICAgZGVmIF9yb3dz
#8#KG5hbWUpOgogICAgICAgIGRzID0gZ3JvdXAuZ2V0KG5hbWUpCiAgICAgICAgcmV0dXJuIGRzWzpd
#8#IGlmIGRzIGlzIG5vdCBOb25lIGFuZCBkcy5zaGFwZVswXSBlbHNlIFtdCgogICAgdmFsdWVzID0g
#8#W19oNV90ZXh0KHJbMF0pIGZvciByIGluIF9yb3dzKCJMYWJlbFZhbHVlcyIpXQogICAgaWYgbm90
#8#IHZhbHVlczoKICAgICAgICByZXR1cm4ge30sIHt9CgogICAgZ3JvdXBfb2ZfbGFiZWwsIHByZXYg
#8#PSB7fSwgMAogICAgZm9yIHJvdyBpbiBfcm93cygiTGFiZWxHcm91cE5hbWVzIik6CiAgICAgICAg
#8#Z25hbWUsIGVuZCA9IF9oNV90ZXh0KHJvd1swXSksIGludChyb3dbMV0pCiAgICAgICAgZm9yIGkg
#8#aW4gcmFuZ2UocHJldiwgbWluKGVuZCwgbGVuKHZhbHVlcykpKToKICAgICAgICAgICAgZ3JvdXBf
#8#b2ZfbGFiZWxbaV0gPSBnbmFtZQogICAgICAgIHByZXYgPSBlbmQKCiAgICBsYWJlbF9pZHMgPSBb
#8#aW50KHJbMF0pIGZvciByIGluIF9yb3dzKCJMYWJlbFNldExhYmVsSURzIildCiAgICBvYmplY3Rf
#8#aWRzID0gW2ludChyWzBdKSBmb3IgciBpbiBfcm93cygiTGFiZWxTZXRPYmplY3RJRHMiKV0KCiAg
#8#ICBzcG90X2xhYmVscywgdHJhY2tfbGFiZWxzID0ge30sIHt9CiAgICBwcmV2X2wgPSBwcmV2X28g
#8#PSAwCiAgICBmb3Igcm93IGluIF9yb3dzKCJMYWJlbFNldHMiKToKICAgICAgICBlbmRfbCwgZW5k
#8#X28gPSBpbnQocm93WzBdKSwgaW50KHJvd1sxXSkKICAgICAgICBvYmpzID0gb2JqZWN0X2lkc1tw
#8#cmV2X286ZW5kX29dCiAgICAgICAgZm9yIGxpIGluIGxhYmVsX2lkc1twcmV2X2w6ZW5kX2xdOgog
#8#ICAgICAgICAgICBpZiBsaSA+PSBsZW4odmFsdWVzKToKICAgICAgICAgICAgICAgIGNvbnRpbnVl
#8#CiAgICAgICAgICAgIGduYW1lID0gZ3JvdXBfb2ZfbGFiZWwuZ2V0KGxpLCAiIikKICAgICAgICAg
#8#ICAgbmFtZSA9IHZhbHVlc1tsaV0KICAgICAgICAgICAgZm9yIG9iaiBpbiBvYmpzOgogICAgICAg
#8#ICAgICAgICAgdGFyZ2V0ID0gc3BvdF9sYWJlbHMgaWYgb2JqIGluIHNwb3RfaWRzIGVsc2UgKHRy
#8#YWNrX2xhYmVscyBpZiBvYmogaW4gdHJhY2tfaWRzIGVsc2UgTm9uZSkKICAgICAgICAgICAgICAg
#8#IGlmIHRhcmdldCBpcyBOb25lOgogICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAg
#8#ICAgICAgICB0YXJnZXQuc2V0ZGVmYXVsdChnbmFtZSwge30pLnNldGRlZmF1bHQob2JqLCBuYW1l
#8#KQogICAgICAgIHByZXZfbCwgcHJldl9vID0gZW5kX2wsIGVuZF9vCgogICAgIyBBIGdyb3VwIGNs
#8#YXNzaWZpZXMgc3BvdHMgb3IgdHJhY2tzLCBuZXZlciBib3RoLiBJbWFyaXMga2VlcHMgdGhlIHR3
#8#byBpZCBzcGFjZXMKICAgICMgZGlzam9pbnQsIGJ1dCBhbiBpZCBzZWVuIGluIGJvdGggd291bGQg
#8#b3RoZXJ3aXNlIHNwbGl0IG9uZSBncm91cCBhY3Jvc3MgdGhlIHR3bwogICAgIyB0YWJsZXMgYW5k
#8#IHNocmluayBpdDsgdGhlIHNpZGUgaG9sZGluZyB0aGUgbW9zdCBvYmplY3RzIGlzIHRoZSBncm91
#8#cCdzIHJlYWwgdGFyZ2V0LgogICAgZm9yIGduYW1lIGluIHNldChzcG90X2xhYmVscykgJiBzZXQo
#8#dHJhY2tfbGFiZWxzKToKICAgICAgICBpZiBsZW4oc3BvdF9sYWJlbHNbZ25hbWVdKSA+PSBsZW4o
#8#dHJhY2tfbGFiZWxzW2duYW1lXSk6CiAgICAgICAgICAgIHRyYWNrX2xhYmVscy5wb3AoZ25hbWUp
#8#CiAgICAgICAgZWxzZToKICAgICAgICAgICAgc3BvdF9sYWJlbHMucG9wKGduYW1lKQogICAgcmV0
#8#dXJuIHNwb3RfbGFiZWxzLCB0cmFja19sYWJlbHMKCgpkZWYgcmVhZF9zY2VuZTgoaW1zX3BhdGgp
#8#IC0+IGRpY3Q6CiAgICAiIiJGbGF0IHBlci1zcG90IHRhYmxlIHJlYWQgZnJvbSB0aGUgLmltcyBp
#8#dHNlbGYuIFJldHVybnMgTm9uZSB3aGVuIHRoZXJlIGlzIG5vIHRyYWNraW5nLiIiIgogICAgaW1w
#8#b3J0IGg1cHkKCiAgICBpbXNfcGF0aCA9IFBhdGgoaW1zX3BhdGgpCiAgICB3aXRoIGg1cHkuRmls
#8#ZShzdHIoaW1zX3BhdGgpLCAiciIpIGFzIGY6CiAgICAgICAgY29udGVudCA9IGYuZ2V0KCJTY2Vu
#8#ZTgvQ29udGVudCIpCiAgICAgICAgaWYgY29udGVudCBpcyBOb25lOgogICAgICAgICAgICByZXR1
#8#cm4gTm9uZQogICAgICAgIHBpY2tlZCA9IF9waWNrX3BvaW50c19ncm91cChjb250ZW50KQogICAg
#8#ICAgIGlmIHBpY2tlZCBpcyBOb25lOgogICAgICAgICAgICByZXR1cm4gTm9uZQogICAgICAgIG9i
#8#al9rZXksIF8sIGdyb3VwID0gcGlja2VkCiAgICAgICAgbmFtZXMgPSBfdHJhY2tfdGFibGVfbmFt
#8#ZXMoZ3JvdXApCiAgICAgICAgaWYgbm90IG5hbWVzOgogICAgICAgICAgICByZXR1cm4gTm9uZQog
#8#ICAgICAgIHRyYWNrX25hbWUsIHRyYWNrb2JqX25hbWUsIF9lZGdlX25hbWUgPSBuYW1lcwoKICAg
#8#ICAgICBzcG90ID0gZ3JvdXBbIlNwb3QiXVs6XQogICAgICAgIGlmIG5vdCBsZW4oc3BvdCk6CiAg
#8#ICAgICAgICAgIHJldHVybiBOb25lCiAgICAgICAgdHJhY2tzID0gZ3JvdXBbdHJhY2tfbmFtZV1b
#8#Ol0KICAgICAgICBpZiBub3QgbGVuKHRyYWNrcyk6CiAgICAgICAgICAgIHJldHVybiBOb25lCiAg
#8#ICAgICAgdHJhY2tfb2JqZWN0cyA9IGdyb3VwW3RyYWNrb2JqX25hbWVdWzpdCiAgICAgICAgdGlt
#8#ZV9vZmZzZXRzID0gZ3JvdXBbIlNwb3RUaW1lT2Zmc2V0Il1bOl0gaWYgIlNwb3RUaW1lT2Zmc2V0
#8#IiBpbiBncm91cCBlbHNlIFtdCgogICAgICAgICMgU3BvdCAtPiB0aW1lcG9pbnQuIFNwb3RUaW1l
#8#T2Zmc2V0IHNsaWNlcyB0aGUgU3BvdCB0YWJsZSBQT1NJVElPTkFMTFksIG9uZSBzbGljZSBwZXIK
#8#ICAgICAgICAjIGZyYW1lOyBzcG90IGlkcyBhcmUgbm90IG9yZGVyZWQgYW5kIG11c3Qgbm90IGJl
#8#IHVzZWQgYXMgaW5kaWNlcyBoZXJlLgogICAgICAgIHRpbWVfb2Zfc3BvdCA9IHt9CiAgICAgICAg
#8#Zm9yIHJvdyBpbiB0aW1lX29mZnNldHM6CiAgICAgICAgICAgIGZyYW1lLCBiZWdpbiwgZW5kID0g
#8#aW50KHJvd1swXSksIGludChyb3dbMV0pLCBpbnQocm93WzJdKQogICAgICAgICAgICBmb3IgcyBp
#8#biBzcG90W2JlZ2luOmVuZF06CiAgICAgICAgICAgICAgICB0aW1lX29mX3Nwb3RbaW50KHNbMF0p
#8#XSA9IGZyYW1lICsgU0NFTkU4X1RJTUVfQkFTRQoKICAgICAgICAjIFNwb3QgLT4gdHJhY2ssIHNh
#8#bWUgcG9zaXRpb25hbCBzbGljaW5nIGludG8gdGhlIHRyYWNrLW9iamVjdCB0YWJsZS4KICAgICAg
#8#ICB0cmFja19vZl9zcG90ID0ge30KICAgICAgICBmb3Igcm93IGluIHRyYWNrczoKICAgICAgICAg
#8#ICAgdGlkLCBiZWdpbiwgZW5kID0gaW50KHJvd1swXSksIGludChyb3dbMV0pLCBpbnQocm93WzJd
#8#KQogICAgICAgICAgICBmb3Igb2JqIGluIHRyYWNrX29iamVjdHNbYmVnaW46ZW5kXToKICAgICAg
#8#ICAgICAgICAgIHRyYWNrX29mX3Nwb3RbaW50KG9ialswXSldID0gdGlkCgogICAgICAgIHNwb3Rf
#8#aWRzID0ge2ludChzWzBdKSBmb3IgcyBpbiBzcG90fQogICAgICAgIHRyYWNrX2lkcyA9IHtpbnQo
#8#dFswXSkgZm9yIHQgaW4gdHJhY2tzfQogICAgICAgIHNwb3RfbGFiZWxzLCB0cmFja19sYWJlbHMg
#8#PSBfc2NlbmU4X2xhYmVscyhncm91cCwgc3BvdF9pZHMsIHRyYWNrX2lkcykKCiAgICAgICAgIyBB
#8#IHNwb3QtbGV2ZWwgY2xhc3NpZmljYXRpb24gaXMgdGhlIGdyb3VuZCB0cnV0aDsgYSB0cmFjay1s
#8#ZXZlbCBvbmUgaXMgc2Vjb25kIGJlc3QKICAgICAgICAjIChpdCBwYWludHMgZXZlcnkgc3BvdCBv
#8#ZiBhIHRyYWNrIHdpdGggdGhlIHRyYWNrJ3MgbGFiZWwpLiBXaWRlc3QgY292ZXJhZ2Ugd2lucy4K
#8#ICAgICAgICByZWdpb25fb2Zfc3BvdCwgcmVnaW9uX3NvdXJjZSA9IHt9LCBOb25lCiAgICAgICAg
#8#aWYgc3BvdF9sYWJlbHM6CiAgICAgICAgICAgIGduYW1lLCBtYXBwaW5nID0gbWF4KHNwb3RfbGFi
#8#ZWxzLml0ZW1zKCksIGtleT1sYW1iZGEga3Y6IGxlbihrdlsxXSkpCiAgICAgICAgICAgIHJlZ2lv
#8#bl9vZl9zcG90ID0gZGljdChtYXBwaW5nKQogICAgICAgICAgICByZWdpb25fc291cmNlID0gZiJ7
#8#Z25hbWV9IChzcG90cykiCiAgICAgICAgZWxpZiB0cmFja19sYWJlbHM6CiAgICAgICAgICAgIGdu
#8#YW1lLCBtYXBwaW5nID0gbWF4KHRyYWNrX2xhYmVscy5pdGVtcygpLCBrZXk9bGFtYmRhIGt2OiBs
#8#ZW4oa3ZbMV0pKQogICAgICAgICAgICByZWdpb25fb2Zfc3BvdCA9IHtzaWQ6IG1hcHBpbmdbdGlk
#8#XSBmb3Igc2lkLCB0aWQgaW4gdHJhY2tfb2Zfc3BvdC5pdGVtcygpIGlmIHRpZCBpbiBtYXBwaW5n
#8#fQogICAgICAgICAgICByZWdpb25fc291cmNlID0gZiJ7Z25hbWV9IChwaXN0ZXMpIgoKICAgICAg
#8#ICByb3dzID0gW10KICAgICAgICB1bnRpbWVkID0gMAogICAgICAgIGZvciBzIGluIHNwb3Q6CiAg
#8#ICAgICAgICAgIHNpZCA9IGludChzWzBdKQogICAgICAgICAgICBmcmFtZSA9IHRpbWVfb2Zfc3Bv
#8#dC5nZXQoc2lkKQogICAgICAgICAgICBpZiBmcmFtZSBpcyBOb25lOgogICAgICAgICAgICAgICAg
#8#dW50aW1lZCArPSAxCiAgICAgICAgICAgICAgICBjb250aW51ZQogICAgICAgICAgICByb3dzLmFw
#8#cGVuZCh7CiAgICAgICAgICAgICAgICAiY2VsbF9pZCI6IHNpZCwKICAgICAgICAgICAgICAgICJ0
#8#aW1lcG9pbnQiOiBmbG9hdChmcmFtZSksCiAgICAgICAgICAgICAgICAieCI6IGZsb2F0KHNbMV0p
#8#LAogICAgICAgICAgICAgICAgInkiOiBmbG9hdChzWzJdKSwKICAgICAgICAgICAgICAgICJ6Ijog
#8#ZmxvYXQoc1szXSksCiAgICAgICAgICAgICAgICAidHJhY2tfaWQiOiB0cmFja19vZl9zcG90Lmdl
#8#dChzaWQpLAogICAgICAgICAgICAgICAgInJlZ2lvbiI6IHJlZ2lvbl9vZl9zcG90LmdldChzaWQs
#8#ICJVbmtub3duIiksCiAgICAgICAgICAgIH0pCgogICAgcmV0dXJuIHsKICAgICAgICAicm93cyI6
#8#IHJvd3MsCiAgICAgICAgInJlZ2lvblNvdXJjZSI6IHJlZ2lvbl9zb3VyY2UsCiAgICAgICAgIndh
#8#cm5pbmdzIjogKFtmInt1bnRpbWVkfSBzcG90cyBzYW5zIHRpbWVwb2ludCBpZ25vcmVzIl0gaWYg
#8#dW50aW1lZCBlbHNlIFtdKSwKICAgICAgICAicHJvdmVuYW5jZSI6IHsKICAgICAgICAgICAgImtp
#8#bmQiOiAic2NlbmU4IiwKICAgICAgICAgICAgImZpbGUiOiBpbXNfcGF0aC5uYW1lLAogICAgICAg
#8#ICAgICAib2JqZWN0Ijogb2JqX2tleSwKICAgICAgICAgICAgInNwb3RzIjogbGVuKHJvd3MpLAog
#8#ICAgICAgICAgICAidHJhY2tzIjogbGVuKHRyYWNrcyksCiAgICAgICAgICAgICJyZWdpb25Db2x1
#8#bW4iOiByZWdpb25fc291cmNlLAogICAgICAgICAgICAidGltZUJhc2UiOiBTQ0VORThfVElNRV9C
#8#QVNFLAogICAgICAgIH0sCiAgICB9CgoKIyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#8#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#8#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#8#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#8#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKIyAgU291cmNlIDMg4oCUIHRoZSBJbWFyaXMg
#8#c3RhdGlzdGljcyB3b3JrYm9vawojIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#8#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#8#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#8#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#8#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKZGVmIF9yZWFkX3dvcmtib29rKHBhdGg6IFBhdGgp
#8#OgogICAgIiIiWyhzaGVldCBuYW1lLCBbcm93cyBvZiB2YWx1ZXNdKV0gZm9yIC54bHMgKEJJRkYp
#8#IGFuZCAueGxzeCBhbGlrZS4iIiIKICAgIHN1ZmZpeCA9IHBhdGguc3VmZml4Lmxvd2VyKCkKICAg
#8#IGlmIHN1ZmZpeCA9PSAiLnhscyI6CiAgICAgICAgdHJ5OgogICAgICAgICAgICBpbXBvcnQgeGxy
#8#ZAogICAgICAgIGV4Y2VwdCBJbXBvcnRFcnJvciBhcyBleGM6CiAgICAgICAgICAgIHJhaXNlIFJ1
#8#bnRpbWVFcnJvcigKICAgICAgICAgICAgICAgICJsZWN0dXJlIGQndW4gLnhscyBJbWFyaXMgOiBs
#8#ZSBwYXF1ZXQgJ3hscmQnIGVzdCByZXF1aXMgKHBpcCBpbnN0YWxsIHhscmQpIgogICAgICAgICAg
#8#ICApIGZyb20gZXhjCiAgICAgICAgYm9vayA9IHhscmQub3Blbl93b3JrYm9vayhzdHIocGF0aCks
#8#IG9uX2RlbWFuZD1UcnVlKQogICAgICAgIHRyeToKICAgICAgICAgICAgZm9yIGluZGV4LCBuYW1l
#8#IGluIGVudW1lcmF0ZShib29rLnNoZWV0X25hbWVzKCkpOgogICAgICAgICAgICAgICAgc2hlZXQg
#8#PSBib29rLnNoZWV0X2J5X2luZGV4KGluZGV4KQogICAgICAgICAgICAgICAgeWllbGQgbmFtZSwg
#8#W3NoZWV0LnJvd192YWx1ZXMocikgZm9yIHIgaW4gcmFuZ2Uoc2hlZXQubnJvd3MpXQogICAgICAg
#8#ICAgICAgICAgYm9vay51bmxvYWRfc2hlZXQoaW5kZXgpCiAgICAgICAgZmluYWxseToKICAgICAg
#8#ICAgICAgYm9vay5yZWxlYXNlX3Jlc291cmNlcygpCiAgICAgICAgcmV0dXJuCgogICAgdHJ5Ogog
#8#ICAgICAgIGltcG9ydCBvcGVucHl4bAogICAgZXhjZXB0IEltcG9ydEVycm9yIGFzIGV4YzoKICAg
#8#ICAgICByYWlzZSBSdW50aW1lRXJyb3IoCiAgICAgICAgICAgICJsZWN0dXJlIGQndW4gLnhsc3gg
#8#SW1hcmlzIDogbGUgcGFxdWV0ICdvcGVucHl4bCcgZXN0IHJlcXVpcyAocGlwIGluc3RhbGwgb3Bl
#8#bnB5eGwpIgogICAgICAgICkgZnJvbSBleGMKICAgIGJvb2sgPSBvcGVucHl4bC5sb2FkX3dvcmti
#8#b29rKHN0cihwYXRoKSwgcmVhZF9vbmx5PVRydWUsIGRhdGFfb25seT1UcnVlKQogICAgdHJ5Ogog
#8#ICAgICAgIGZvciBzaGVldCBpbiBib29rLndvcmtzaGVldHM6CiAgICAgICAgICAgIHlpZWxkIHNo
#8#ZWV0LnRpdGxlLCBbbGlzdChyb3cpIGZvciByb3cgaW4gc2hlZXQuaXRlcl9yb3dzKHZhbHVlc19v
#8#bmx5PVRydWUpXQogICAgZmluYWxseToKICAgICAgICBib29rLmNsb3NlKCkKCgpkZWYgX2hlYWRl
#8#cl9pbmRleChyb3dzLCBuZWVkbGVzKToKICAgICIiIlJvdyBpbmRleCBvZiB0aGUgaGVhZGVyIGxp
#8#bmUsIHNlYXJjaGVkIGluIHRoZSBmaXJzdCBmZXcgcm93cy4KCiAgICBJbWFyaXMgcHJlZml4ZXMg
#8#ZWFjaCBzaGVldCB3aXRoIGl0cyBvd24gdGl0bGUgbGluZSwgc28gdGhlIGhlYWRlciBpcyBvbiBy
#8#b3cgMiB0aGVyZSwKICAgIHdoaWxlIGEgaGFuZC1mbGF0dGVuZWQgdGFibGUgaGFzIGl0IG9uIHJv
#8#dyAxLiBCb3RoIGFyZSBhY2NlcHRlZC4KICAgICIiIgogICAgZm9yIGksIHJvdyBpbiBlbnVtZXJh
#8#dGUocm93c1s6Nl0pOgogICAgICAgIGNlbGxzID0ge3N0cihjKS5zdHJpcCgpLmxvd2VyKCkgZm9y
#8#IGMgaW4gcm93IGlmIGMgaXMgbm90IE5vbmV9CiAgICAgICAgaWYgYWxsKG4gaW4gY2VsbHMgZm9y
#8#IG4gaW4gbmVlZGxlcyk6CiAgICAgICAgICAgIHJldHVybiBpCiAgICByZXR1cm4gTm9uZQoKCmRl
#8#ZiBfcGlja19wb3NpdGlvbl9zaGVldChwYXRoOiBQYXRoKToKICAgICIiIlRoZSBzaGVldCBjYXJy
#8#eWluZyBvbmUgcm93IHBlciBzcG90IHBlciB0aW1lcG9pbnQsIHBsdXMgaXRzIGhlYWRlciByb3cu
#8#IiIiCiAgICBmYWxsYmFjayA9IE5vbmUKICAgIGZvciBuYW1lLCByb3dzIGluIF9yZWFkX3dvcmti
#8#b29rKHBhdGgpOgogICAgICAgIGlmIG5vdCByb3dzOgogICAgICAgICAgICBjb250aW51ZQogICAg
#8#ICAgIGhlYWQgPSBfaGVhZGVyX2luZGV4KHJvd3MsICgicG9zaXRpb24geCIsICJwb3NpdGlvbiB5
#8#IiwgInBvc2l0aW9uIHoiKSkKICAgICAgICBpZiBoZWFkIGlzIG5vdCBOb25lOgogICAgICAgICAg
#8#ICByZXR1cm4gbmFtZSwgcm93cywgaGVhZCwgImltYXJpcy1zdGF0aXN0aWNzIgogICAgICAgIGlm
#8#IGZhbGxiYWNrIGlzIE5vbmU6CiAgICAgICAgICAgIGhlYWQgPSBfaGVhZGVyX2luZGV4KHJvd3Ms
#8#ICgieCIsICJ5IiwgInoiKSkKICAgICAgICAgICAgaWYgaGVhZCBpcyBub3QgTm9uZToKICAgICAg
#8#ICAgICAgICAgIGZhbGxiYWNrID0gKG5hbWUsIHJvd3MsIGhlYWQsICJmbGF0LXRhYmxlIikKICAg
#8#IHJldHVybiBmYWxsYmFjayBpZiBmYWxsYmFjayBlbHNlIChOb25lLCBOb25lLCBOb25lLCBOb25l
#8#KQoKCmRlZiByZWFkX2V4Y2VsKHBhdGgpIC0+IGRpY3Q6CiAgICAiIiJGbGF0IHBlci1zcG90IHRh
#8#YmxlIHJlYWQgZnJvbSBhbiBJbWFyaXMgc3RhdGlzdGljcyB3b3JrYm9vay4iIiIKICAgIHBhdGgg
#8#PSBQYXRoKHBhdGgpCiAgICBzaGVldF9uYW1lLCByb3dzLCBoZWFkLCBsYXlvdXQgPSBfcGlja19w
#8#b3NpdGlvbl9zaGVldChwYXRoKQogICAgaWYgcm93cyBpcyBOb25lOgogICAgICAgIHJhaXNlIFZh
#8#bHVlRXJyb3IoZiJ7cGF0aC5uYW1lfTogYXVjdW5lIGZldWlsbGUgZGUgcG9zaXRpb25zIChQb3Np
#8#dGlvbiBYL1kvWikgdHJvdXZlZSIpCgogICAgaGVhZGVyID0gW3N0cihjKS5zdHJpcCgpIGlmIGMg
#8#aXMgbm90IE5vbmUgZWxzZSAiIiBmb3IgYyBpbiByb3dzW2hlYWRdXQogICAgbG93ZXIgPSBbaC5s
#8#b3dlcigpIGZvciBoIGluIGhlYWRlcl0KCiAgICBkZWYgY29sKCphbGlhc2VzKToKICAgICAgICBm
#8#b3IgYWxpYXMgaW4gYWxpYXNlczoKICAgICAgICAgICAgaWYgYWxpYXMgaW4gbG93ZXI6CiAgICAg
#8#ICAgICAgICAgICByZXR1cm4gbG93ZXIuaW5kZXgoYWxpYXMpCiAgICAgICAgcmV0dXJuIE5vbmUK
#8#CiAgICBpeCA9IGNvbCgicG9zaXRpb24geCIsICJ4IiwgInhfdW0iKQogICAgaXkgPSBjb2woInBv
#8#c2l0aW9uIHkiLCAieSIsICJ5X3VtIikKICAgIGl6ID0gY29sKCJwb3NpdGlvbiB6IiwgInoiLCAi
#8#el91bSIpCiAgICBpdCA9IGNvbCgidGltZSIsICJ0aW1lcG9pbnQiLCAidGltZSBpbmRleCIsICJm
#8#cmFtZSIsICJ0IikKICAgIGlpZCA9IGNvbCgiaWQiLCAiY2VsbF9pZCIsICJzcG90X2lkIiwgIm9i
#8#amVjdF9pZCIpCiAgICBpdHJhY2sgPSBjb2woInRyYWNraWQiLCAidHJhY2tfaWQiLCAidHJhY2sg
#8#aWQiKQoKICAgIGlmIE5vbmUgaW4gKGl4LCBpeSwgaXopOgogICAgICAgIHJhaXNlIFZhbHVlRXJy
#8#b3IoZiJ7cGF0aC5uYW1lfSAvIHtzaGVldF9uYW1lfTogY29sb25uZXMgZGUgcG9zaXRpb24gaW50
#8#cm91dmFibGVzIikKCiAgICAjIFdoYXRldmVyIGhlYWRlciBJbWFyaXMgZGlkIG5vdCBwdXQgdGhl
#8#cmUgaXRzZWxmIGlzIHRoZSBiaW9sb2dpc3QncyBjbGFzc2lmaWNhdGlvbi4KICAgIGlyZWcgPSBj
#8#b2woInJlZ2lvbiIsICJncm91cCIsICJwb3B1bGF0aW9uIiwgImNsYXNzIikKICAgIHJlZ2lvbl9u
#8#YW1lID0gaGVhZGVyW2lyZWddIGlmIGlyZWcgaXMgbm90IE5vbmUgZWxzZSBOb25lCiAgICBpZiBp
#8#cmVnIGlzIE5vbmU6CiAgICAgICAgZm9yIGksIG5hbWUgaW4gZW51bWVyYXRlKGxvd2VyKToKICAg
#8#ICAgICAgICAgaWYgbmFtZSBhbmQgbmFtZSBub3QgaW4gX1BPU0lUSU9OX1JFU0VSVkVEOgogICAg
#8#ICAgICAgICAgICAgaXJlZywgcmVnaW9uX25hbWUgPSBpLCBoZWFkZXJbaV0KICAgICAgICAgICAg
#8#ICAgIGJyZWFrCgogICAgb3V0LCBza2lwcGVkID0gW10sIDAKICAgIGZvciByYXcgaW4gcm93c1to
#8#ZWFkICsgMTpdOgogICAgICAgIGlmIHJhdyBpcyBOb25lIG9yIGxlbihyYXcpIDw9IG1heChpeCwg
#8#aXksIGl6KToKICAgICAgICAgICAgc2tpcHBlZCArPSAxCiAgICAgICAgICAgIGNvbnRpbnVlCiAg
#8#ICAgICAgdHJ5OgogICAgICAgICAgICB4LCB5LCB6ID0gZmxvYXQocmF3W2l4XSksIGZsb2F0KHJh
#8#d1tpeV0pLCBmbG9hdChyYXdbaXpdKQogICAgICAgIGV4Y2VwdCAoVHlwZUVycm9yLCBWYWx1ZUVy
#8#cm9yKToKICAgICAgICAgICAgc2tpcHBlZCArPSAxCiAgICAgICAgICAgIGNvbnRpbnVlCiAgICAg
#8#ICAgZW50cnkgPSB7IngiOiB4LCAieSI6IHksICJ6Ijogen0KICAgICAgICBlbnRyeVsidGltZXBv
#8#aW50Il0gPSBfYXNfZmxvYXQocmF3W2l0XSkgaWYgaXQgaXMgbm90IE5vbmUgZWxzZSAxLjAKICAg
#8#ICAgICBlbnRyeVsiY2VsbF9pZCJdID0gX2FzX2Zsb2F0KHJhd1tpaWRdKSBpZiBpaWQgaXMgbm90
#8#IE5vbmUgZWxzZSBmbG9hdChsZW4ob3V0KSArIDEpCiAgICAgICAgZW50cnlbInRyYWNrX2lkIl0g
#8#PSBfYXNfZmxvYXQocmF3W2l0cmFja10pIGlmIGl0cmFjayBpcyBub3QgTm9uZSBlbHNlIE5vbmUK
#8#ICAgICAgICByZWdpb24gPSByYXdbaXJlZ10gaWYgaXJlZyBpcyBub3QgTm9uZSBhbmQgaXJlZyA8
#8#IGxlbihyYXcpIGVsc2UgTm9uZQogICAgICAgIGVudHJ5WyJyZWdpb24iXSA9IHN0cihyZWdpb24p
#8#LnN0cmlwKCkgaWYgcmVnaW9uIG5vdCBpbiAoTm9uZSwgIiIpIGVsc2UgIlVua25vd24iCiAgICAg
#8#ICAgaWYgZW50cnlbInRpbWVwb2ludCJdIGlzIE5vbmUgb3IgZW50cnlbImNlbGxfaWQiXSBpcyBO
#8#b25lOgogICAgICAgICAgICBza2lwcGVkICs9IDEKICAgICAgICAgICAgY29udGludWUKICAgICAg
#8#ICBvdXQuYXBwZW5kKGVudHJ5KQoKICAgIGlmIG5vdCBvdXQ6CiAgICAgICAgcmFpc2UgVmFsdWVF
#8#cnJvcihmIntwYXRoLm5hbWV9IC8ge3NoZWV0X25hbWV9OiBhdWN1bmUgbGlnbmUgZXhwbG9pdGFi
#8#bGUiKQoKICAgIHdhcm5pbmdzID0gW2Yie3NraXBwZWR9IGxpZ25lcyBpZ25vcmVlcyAodmFsZXVy
#8#cyBtYW5xdWFudGVzKSJdIGlmIHNraXBwZWQgZWxzZSBbXQogICAgIyBUaGUgdGltZSBjb2x1bW4g
#8#aXMgcmVhZCBhcyBhIGZyYW1lIGluZGV4LiBJbWFyaXMgd3JpdGVzIG9uZSB0aGVyZTsgYSB3b3Jr
#8#Ym9vayB3aG9zZQogICAgIyB0aW1lcyBhcmUgZnJhY3Rpb25hbCB3YXMgZXhwb3J0ZWQgaW4gc2Vj
#8#b25kcyBvciBob3VycyBhbmQgd291bGQgYmUgbWlzcGxhY2VkLgogICAgZnJhY3Rpb25hbCA9IHN1
#8#bSgxIGZvciBlIGluIG91dCBpZiBmbG9hdChlWyJ0aW1lcG9pbnQiXSkgIT0gaW50KGVbInRpbWVw
#8#b2ludCJdKSkKICAgIGlmIGZyYWN0aW9uYWw6CiAgICAgICAgd2FybmluZ3MuYXBwZW5kKGYie2Zy
#8#YWN0aW9uYWx9IHZhbGV1cnMgZGUgdGVtcHMgbm9uIGVudGllcmVzIGRhbnMgJ3toZWFkZXJbaXRd
#8#fScgOiAiCiAgICAgICAgICAgICAgICAgICAgICAgIGYibGEgY29sb25uZSBlc3QgbHVlIGNvbW1l
#8#IHVuIG51bWVybyBkZSBmcmFtZSDigJQgdmVyaWZpZXogbCdleHBvcnQiKQoKICAgIHJldHVybiB7
#8#CiAgICAgICAgInJvd3MiOiBvdXQsCiAgICAgICAgInJlZ2lvblNvdXJjZSI6IHJlZ2lvbl9uYW1l
#8#LAogICAgICAgICJ3YXJuaW5ncyI6IHdhcm5pbmdzLAogICAgICAgICJwcm92ZW5hbmNlIjogewog
#8#ICAgICAgICAgICAia2luZCI6ICJleGNlbCIsCiAgICAgICAgICAgICJmaWxlIjogcGF0aC5uYW1l
#8#LAogICAgICAgICAgICAic2hlZXQiOiBzaGVldF9uYW1lLAogICAgICAgICAgICAibGF5b3V0Ijog
#8#bGF5b3V0LAogICAgICAgICAgICAic3BvdHMiOiBsZW4ob3V0KSwKICAgICAgICAgICAgInJlZ2lv
#8#bkNvbHVtbiI6IHJlZ2lvbl9uYW1lLAogICAgICAgIH0sCiAgICB9CgoKZGVmIF9hc19mbG9hdCh2
#8#YWx1ZSk6CiAgICBpZiB2YWx1ZSBpcyBOb25lIG9yIHZhbHVlID09ICIiOgogICAgICAgIHJldHVy
#8#biBOb25lCiAgICB0cnk6CiAgICAgICAgcmV0dXJuIGZsb2F0KHZhbHVlKQogICAgZXhjZXB0IChU
#8#eXBlRXJyb3IsIFZhbHVlRXJyb3IpOgogICAgICAgIHJldHVybiBOb25lCgoKIyDilIDilIDilIDi
#8#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#8#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#8#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#8#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKIyAgUmF3
#8#IHRhYmxlIC0+IElNQVJJU19UUkFDS0VSX1YxIGNvbnRhaW5lcgojIOKUgOKUgOKUgOKUgOKUgOKU
#8#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#8#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#8#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#8#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKX0FOQUxZU0lTX01P
#8#RFVMRSA9IE5vbmUKCgpkZWYgX2FuYWx5c2lzX2RpcnMoKToKICAgIGVudiA9IG9zLmVudmlyb24u
#8#Z2V0KCJMVU1FTjNEX1RSQUNLSU5HX1NDUklQVFMiKQogICAgaWYgZW52OgogICAgICAgIHlpZWxk
#8#IFBhdGgoZW52KQogICAgeWllbGQgU0NSSVBUX0RJUi5wYXJlbnQgLyAiU0NSSVBUUyIgICAgICAg
#8#ICAgICAgICMgcmVwbyBsYXlvdXQKICAgIHlpZWxkIFNDUklQVF9ESVIucGFyZW50IC8gInRyYWNr
#8#aW5nIiAvICJTQ1JJUFRTIiAgIyBwaXBlbGluZSBidW5kbGUgbGF5b3V0CiAgICB5aWVsZCBTQ1JJ
#8#UFRfRElSIC8gIlNDUklQVFMiCgoKZGVmIGxvYWRfYW5hbHlzaXMoKToKICAgICIiIkltcG9ydCB0
#8#aGUgbGFiJ3MgQW5hbHlzaXMucHkgYXMgYSBsaWJyYXJ5LgoKICAgIENlbGwgaWRlbnRpdHkgYWNy
#8#b3NzIGEgZGl2aXNpb24sIGxpbmVhZ2UgYW5kIHRoZSBLYWJzY2ggc3RhYmlsaXNhdGlvbiBhcmUg
#8#c2NpZW50aWZpYwogICAgY2hvaWNlcyB0aGF0IGFscmVhZHkgaGF2ZSBvbmUgaW1wbGVtZW50YXRp
#8#b247IGEgZGF0YXNldCB0YWtlbiB0aHJvdWdoIHRoaXMgc2hvcnRjdXQgbXVzdAogICAgY29tZSBv
#8#dXQgaWRlbnRpY2FsIHRvIG9uZSB0YWtlbiB0aHJvdWdoIHRoZSB0cmFja2luZyBwaXBlbGluZSwg
#8#c28gdGhhdCBpbXBsZW1lbnRhdGlvbiBpcwogICAgaW1wb3J0ZWQgcmF0aGVyIHRoYW4gbWlycm9y
#8#ZWQuCiAgICAiIiIKICAgIGdsb2JhbCBfQU5BTFlTSVNfTU9EVUxFCiAgICBpZiBfQU5BTFlTSVNf
#8#TU9EVUxFIGlzIG5vdCBOb25lOgogICAgICAgIHJldHVybiBfQU5BTFlTSVNfTU9EVUxFCgogICAg
#8#Zm9yIGRpcmVjdG9yeSBpbiBfYW5hbHlzaXNfZGlycygpOgogICAgICAgIHNjcmlwdCA9IGRpcmVj
#8#dG9yeSAvICJBbmFseXNpcy5weSIKICAgICAgICBpZiBub3Qgc2NyaXB0LmlzX2ZpbGUoKToKICAg
#8#ICAgICAgICAgY29udGludWUKICAgICAgICAjIGV4cG9ydF9odG1sLnB5IGlzIGltcG9ydGVkIGJ5
#8#IEFuYWx5c2lzLnB5IGFzIGEgdG9wLWxldmVsIHNpYmxpbmcuCiAgICAgICAgc3lzLnBhdGguaW5z
#8#ZXJ0KDAsIHN0cihkaXJlY3RvcnkucmVzb2x2ZSgpKSkKICAgICAgICB0cnk6CiAgICAgICAgICAg
#8#IHNwZWMgPSBpbXBvcnRsaWIudXRpbC5zcGVjX2Zyb21fZmlsZV9sb2NhdGlvbigibHVtZW5fdHJh
#8#Y2tpbmdfYW5hbHlzaXMiLCBzdHIoc2NyaXB0KSkKICAgICAgICAgICAgbW9kdWxlID0gaW1wb3J0
#8#bGliLnV0aWwubW9kdWxlX2Zyb21fc3BlYyhzcGVjKQogICAgICAgICAgICBzeXMubW9kdWxlcy5z
#8#ZXRkZWZhdWx0KCJsdW1lbl90cmFja2luZ19hbmFseXNpcyIsIG1vZHVsZSkKICAgICAgICAgICAg
#8#c3BlYy5sb2FkZXIuZXhlY19tb2R1bGUobW9kdWxlKQogICAgICAgIGV4Y2VwdCBFeGNlcHRpb24g
#8#YXMgZXhjOgogICAgICAgICAgICBzeXMucGF0aC5wb3AoMCkKICAgICAgICAgICAgcmFpc2UgUnVu
#8#dGltZUVycm9yKGYie3NjcmlwdH0gbidhIHBhcyBwdSBldHJlIGltcG9ydGUgOiB7ZXhjfSIpIGZy
#8#b20gZXhjCiAgICAgICAgX0FOQUxZU0lTX01PRFVMRSA9IG1vZHVsZQogICAgICAgIHJldHVybiBt
#8#b2R1bGUKCiAgICByYWlzZSBSdW50aW1lRXJyb3IoCiAgICAgICAgIkFuYWx5c2lzLnB5IGludHJv
#8#dXZhYmxlIChjaGVyY2hlIGRhbnMgIgogICAgICAgICsgIiwgIi5qb2luKHN0cihkKSBmb3IgZCBp
#8#biBfYW5hbHlzaXNfZGlycygpKQogICAgICAgICsgIikuIERlZmluaXNzZXogTFVNRU4zRF9UUkFD
#8#S0lOR19TQ1JJUFRTIHN1ciBsZSBkb3NzaWVyIFNDUklQVFMgZHUgcGlwZWxpbmUgZGUgdHJhY2tp
#8#bmcuIgogICAgKQoKCmRlZiBfcGFkZGVkX3JhbmdlKHZtaW4sIHZtYXgsIHBhZD0wLjA1KToKICAg
#8#IHNwYW4gPSB2bWF4IC0gdm1pbgogICAgaWYgc3BhbiA9PSAwOgogICAgICAgIHNwYW4gPSAxCiAg
#8#ICByZXR1cm4gW2Zsb2F0KHZtaW4gLSBzcGFuICogcGFkKSwgZmxvYXQodm1heCArIHNwYW4gKiBw
#8#YWQpXQoKCmRlZiBidWlsZF9jb250YWluZXIodGFibGU6IGRpY3QsIGRhdGFzZXRfbmFtZTogc3Ry
#8#LCB2ZXJib3NlOiBib29sID0gVHJ1ZSkgLT4gZGljdDoKICAgICIiIlR1cm4gYSBmbGF0IHBlci1z
#8#cG90IHRhYmxlIGludG8gYW4gSU1BUklTX1RSQUNLRVJfVjEgZG9jdW1lbnQuCgogICAgTWlycm9y
#8#cywgc3RlcCBmb3Igc3RlcCwgd2hhdCBgYEFuYWx5c2lzLnByb2Nlc3Nfc2FtcGxlYGAgZG9lcyBi
#8#ZXR3ZWVuIHJlYWRpbmcgdGhlIHdvcmtib29rCiAgICBhbmQgY2FsbGluZyBgYGV4cG9ydF9odG1s
#8#LmV4cG9ydF9pbWFyaXNfdHJhY2tgYCDigJQgd2hpY2ggaXMgdGhlIHNjaGVtYSB3cml0dGVuIGhl
#8#cmUuCiAgICAiIiIKICAgIHRyeToKICAgICAgICBpbXBvcnQgcGFuZGFzIGFzIHBkCiAgICBleGNl
#8#cHQgSW1wb3J0RXJyb3IgYXMgZXhjOgogICAgICAgIHJhaXNlIFJ1bnRpbWVFcnJvcigKICAgICAg
#8#ICAgICAgImwnZXh0cmFjdGlvbiBkdSB0cmFja2luZyBkZXB1aXMgdW4gLmltcy8ueGxzIGRlbWFu
#8#ZGUgJ3BhbmRhcycgKHBpcCBpbnN0YWxsIHBhbmRhcykiCiAgICAgICAgKSBmcm9tIGV4YwoKICAg
#8#IEEgPSBsb2FkX2FuYWx5c2lzKCkKCiAgICBkZiA9IHBkLkRhdGFGcmFtZSh0YWJsZVsicm93cyJd
#8#LCBjb2x1bW5zPVsiY2VsbF9pZCIsICJ0aW1lcG9pbnQiLCAieCIsICJ5IiwgInoiLAogICAgICAg
#8#ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgInRyYWNrX2lkIiwgInJlZ2lv
#8#biJdKQogICAgZGYgPSBBLnN0YW5kYXJkaXplX2lucHV0X2RhdGFmcmFtZShkZiwgc2FtcGxlX25h
#8#bWU9ZGF0YXNldF9uYW1lKQogICAgZGYgPSBBLmFzc2lnbl9zeW50aGV0aWNfdHJhY2tfaWRzKGRm
#8#KQoKICAgIGFzc2lnbmVyID0gQS5DZWxsSURBc3NpZ25lcigpCiAgICByZXN1bHQgPSBhc3NpZ25l
#8#ci5hc3NpZ25faWRzKGRmKQoKICAgIHJlc3VsdFsibWFya2VyX2NvbG9yIl0gPSAiIgogICAgZm9y
#8#IHRwLCBjaWQgaW4gYXNzaWduZXIubWl0b3Npc19tYXJrZXJzOgogICAgICAgIHJlc3VsdC5sb2Nb
#8#KHJlc3VsdFsidGltZXBvaW50Il0gPT0gdHApICYgKHJlc3VsdFsidW5pcXVlX2NlbGxfaWQiXSA9
#8#PSBjaWQpLCAibWFya2VyX2NvbG9yIl0gPSAicmVkIgogICAgZm9yIHRwLCBjaWQgaW4gYXNzaWdu
#8#ZXIuZnVzaW9uX21hcmtlcnM6CiAgICAgICAgcmVzdWx0LmxvY1socmVzdWx0WyJ0aW1lcG9pbnQi
#8#XSA9PSB0cCkgJiAocmVzdWx0WyJ1bmlxdWVfY2VsbF9pZCJdID09IGNpZCksICJtYXJrZXJfY29s
#8#b3IiXSA9ICJibGFjayIKCiAgICBpZiB2ZXJib3NlOgogICAgICAgIHByaW50KGYiICBbVFJBQ0tJ
#8#TkddIHtsZW4ocmVzdWx0KX0gc3BvdHMsIHtyZXN1bHRbJ3RyYWNrX2lkJ10ubnVuaXF1ZSgpfSBw
#8#aXN0ZXMsICIKICAgICAgICAgICAgICBmIntyZXN1bHRbJ3VuaXF1ZV9jZWxsX2lkJ10ubnVuaXF1
#8#ZSgpfSBjZWxsdWxlcywgIgogICAgICAgICAgICAgIGYie2xlbihhc3NpZ25lci5kYXVnaHRlcl9t
#8#YXApfSBtaXRvc2VzIikKICAgIHJlc3VsdCwgX2RpYWdub3N0aWNzID0gQS5zdGFiaWxpemVfY29v
#8#cmRpbmF0ZXMocmVzdWx0LCBhc3NpZ25lcikKCiAgICBwYWxldHRlID0gQS5SRUdJT05fUEFMRVRU
#8#RQogICAgcmVnaW9ucyA9IHNvcnRlZCh7c3RyKHIpIGZvciByIGluIHJlc3VsdFsicmVnaW9uIl0u
#8#dW5pcXVlKCl9LCBrZXk9c3RyKQogICAgcmVnaW9uX2NvbG9ycyA9IHtyOiBwYWxldHRlW2kgJSBs
#8#ZW4ocGFsZXR0ZSldIGZvciBpLCByIGluIGVudW1lcmF0ZShyZWdpb25zKX0KCiAgICBjZWxscyA9
#8#IFtdCiAgICBmb3IgY2lkLCBncnAgaW4gcmVzdWx0Lmdyb3VwYnkoInVuaXF1ZV9jZWxsX2lkIik6
#8#CiAgICAgICAgZ3JwID0gZ3JwLnNvcnRfdmFsdWVzKCJ0aW1lcG9pbnQiKQogICAgICAgIHJlZ2lv
#8#biA9IHN0cihncnBbInJlZ2lvbiJdLmlsb2NbMF0pCiAgICAgICAgcGFyZW50cyA9IGdycFsicGFy
#8#ZW50X2NlbGwiXS5kcm9wbmEoKQogICAgICAgIGRhdWdodGVycyA9IGdycFsiZGF1Z2h0ZXJfY2Vs
#8#bHMiXS5kcm9wbmEoKQogICAgICAgIGNlbGxzLmFwcGVuZCh7CiAgICAgICAgICAgICJpZCI6IGlu
#8#dChjaWQpLAogICAgICAgICAgICAidHJhY2tfaWQiOiBpbnQoZ3JwWyJ0cmFja19pZCJdLmlsb2Nb
#8#MF0pIGlmIGdycFsidHJhY2tfaWQiXS5ub3RuYSgpLmFueSgpIGVsc2UgTm9uZSwKICAgICAgICAg
#8#ICAgInJlZ2lvbiI6IHJlZ2lvbiwKICAgICAgICAgICAgImNvbG9yIjogcmVnaW9uX2NvbG9yc1ty
#8#ZWdpb25dLAogICAgICAgICAgICAidCI6IFtmbG9hdCh2KSBmb3IgdiBpbiBncnBbInRpbWVwb2lu
#8#dCJdXSwKICAgICAgICAgICAgIngiOiBbZmxvYXQodikgZm9yIHYgaW4gZ3JwWyJ4X3N0YWIiXV0s
#8#CiAgICAgICAgICAgICJ5IjogW2Zsb2F0KHYpIGZvciB2IGluIGdycFsieV9zdGFiIl1dLAogICAg
#8#ICAgICAgICAieiI6IFtmbG9hdCh2KSBmb3IgdiBpbiBncnBbInpfc3RhYiJdXSwKICAgICAgICAg
#8#ICAgInhfcmF3IjogW2Zsb2F0KHYpIGZvciB2IGluIGdycFsieCJdXSwKICAgICAgICAgICAgInlf
#8#cmF3IjogW2Zsb2F0KHYpIGZvciB2IGluIGdycFsieSJdXSwKICAgICAgICAgICAgInpfcmF3Ijog
#8#W2Zsb2F0KHYpIGZvciB2IGluIGdycFsieiJdXSwKICAgICAgICAgICAgIm1hcmtlcl9jb2xvciI6
#8#IGxpc3QoZ3JwWyJtYXJrZXJfY29sb3IiXSksCiAgICAgICAgICAgICJwYXJlbnRfY2VsbCI6IHN0
#8#cihwYXJlbnRzLmlsb2NbMF0pIGlmIGxlbihwYXJlbnRzKSBlbHNlICIiLAogICAgICAgICAgICAi
#8#ZGF1Z2h0ZXJfY2VsbHMiOiBzdHIoZGF1Z2h0ZXJzLmlsb2NbMF0pIGlmIGxlbihkYXVnaHRlcnMp
#8#IGVsc2UgIiIsCiAgICAgICAgfSkKCiAgICBwcm92ZW5hbmNlID0gZGljdCh0YWJsZS5nZXQoInBy
#8#b3ZlbmFuY2UiKSBvciB7fSkKICAgIHByb3ZlbmFuY2UudXBkYXRlKHsKICAgICAgICAiZXh0cmFj
#8#dGVkQnkiOiBmInRyYWNraW5nX3NvdXJjZXMucHkge19fdmVyc2lvbl9ffSIsCiAgICAgICAgImNl
#8#bGxzIjogbGVuKGNlbGxzKSwKICAgICAgICAic3RhYmlsaXphdGlvbiI6ICJzZXF1ZW50aWFsLWth
#8#YnNjaCAoQW5hbHlzaXMuc3RhYmlsaXplX2Nvb3JkaW5hdGVzKSIsCiAgICB9KQoKICAgIHJldHVy
#8#biB7CiAgICAgICAgInNpZ25hdHVyZSI6IFNJR05BVFVSRSwKICAgICAgICAiZGF0YXNldF9pZCI6
#8#IHN0cih1dWlkLnV1aWQ0KCkpLAogICAgICAgICJkYXRhc2V0X25hbWUiOiBkYXRhc2V0X25hbWUs
#8#CiAgICAgICAgImRhdGVfZ2VuZXJhdGlvbiI6IGRhdGV0aW1lLm5vdygpLmlzb2Zvcm1hdCgpLAog
#8#ICAgICAgICJkYXRhIjogewogICAgICAgICAgICAidGltZXBvaW50cyI6IHNvcnRlZChmbG9hdCh0
#8#KSBmb3IgdCBpbiByZXN1bHRbInRpbWVwb2ludCJdLnVuaXF1ZSgpKSwKICAgICAgICAgICAgImNl
#8#bGxzIjogY2VsbHMsCiAgICAgICAgICAgICJsYXlvdXQiOiB7CiAgICAgICAgICAgICAgICAieF9y
#8#YW5nZSI6IF9wYWRkZWRfcmFuZ2UocmVzdWx0WyJ4X3N0YWIiXS5taW4oKSwgcmVzdWx0WyJ4X3N0
#8#YWIiXS5tYXgoKSksCiAgICAgICAgICAgICAgICAieV9yYW5nZSI6IF9wYWRkZWRfcmFuZ2UocmVz
#8#dWx0WyJ5X3N0YWIiXS5taW4oKSwgcmVzdWx0WyJ5X3N0YWIiXS5tYXgoKSksCiAgICAgICAgICAg
#8#ICAgICAiel9yYW5nZSI6IF9wYWRkZWRfcmFuZ2UocmVzdWx0WyJ6X3N0YWIiXS5taW4oKSwgcmVz
#8#dWx0WyJ6X3N0YWIiXS5tYXgoKSksCiAgICAgICAgICAgIH0sCiAgICAgICAgICAgICJwcm92ZW5h
#8#bmNlIjogcHJvdmVuYW5jZSwKICAgICAgICB9LAogICAgfQoKCmRlZiB3cml0ZV9jb250YWluZXIo
#8#ZG9jOiBkaWN0LCBwYXRoKSAtPiBQYXRoOgogICAgcGF0aCA9IFBhdGgocGF0aCkKICAgIHBhdGgu
#8#cGFyZW50Lm1rZGlyKHBhcmVudHM9VHJ1ZSwgZXhpc3Rfb2s9VHJ1ZSkKICAgIHdpdGggZ3ppcC5v
#8#cGVuKHN0cihwYXRoKSwgIndiIikgYXMgZmg6CiAgICAgICAgZmgud3JpdGUoU0lHTkFUVVJFLmVu
#8#Y29kZSgpICsgYiJcbiIpCiAgICAgICAgZmgud3JpdGUoanNvbi5kdW1wcyhkb2MsIGVuc3VyZV9h
#8#c2NpaT1GYWxzZSwgc2VwYXJhdG9ycz0oIiwiLCAiOiIpKS5lbmNvZGUoInV0Zi04IikpCiAgICBy
#8#ZXR1cm4gcGF0aAoKCiMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#8#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#8#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#8#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#8#4pSA4pSA4pSA4pSA4pSA4pSACiMgIFRvcCBsZXZlbAojIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#8#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#8#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#8#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#8#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKZGVmIHJlYWRfc291cmNlKHNv
#8#dXJjZTogVHJhY2tpbmdTb3VyY2UpIC0+IGRpY3Q6CiAgICBpZiBzb3VyY2Uua2luZCA9PSAic2Nl
#8#bmU4IjoKICAgICAgICByZXR1cm4gcmVhZF9zY2VuZTgoc291cmNlLnBhdGgpCiAgICBpZiBzb3Vy
#8#Y2Uua2luZCA9PSAiZXhjZWwiOgogICAgICAgIHJldHVybiByZWFkX2V4Y2VsKHNvdXJjZS5wYXRo
#8#KQogICAgcmFpc2UgVmFsdWVFcnJvcihmInNvdXJjZSB7c291cmNlLmtpbmR9IGlzIGFscmVhZHkg
#8#YSBjb250YWluZXIiKQoKCmRlZiBfbWVyZ2VfcmVnaW9uc19mcm9tX2V4Y2VsKHRhYmxlOiBkaWN0
#8#LCBpbXNfcGF0aDogUGF0aCwgdmVyYm9zZTogYm9vbCkgLT4gTm9uZToKICAgICIiIkZpbGwgaW4g
#8#YSBtaXNzaW5nIGNsYXNzaWZpY2F0aW9uIGZyb20gYSBzaWRlY2FyIHdvcmtib29rLCBtYXRjaGVk
#8#IG9uIHNwb3QgaWQuCgogICAgQSB2b2x1bWUgY2FuIGhvbGQgaXRzIFNwb3RzIG9iamVjdHMgd2hp
#8#bGUgdGhlIGNsYXNzaWZpY2F0aW9uIHdhcyBvbmx5IGV2ZXIgYXBwbGllZCBpbiB0aGUKICAgIGNv
#8#cHkgdGhlIGJpb2xvZ2lzdCBleHBvcnRlZCBzdGF0aXN0aWNzIGZyb20uIFRoZSBpZHMgYXJlIElt
#8#YXJpcyBvYmplY3QgaWRzIGFuZCBpZGVudGlmeQogICAgdGhlIHNhbWUgc3BvdHMgYWNyb3NzIGJv
#8#dGggZmlsZXMsIHNvIHRoZSBsYWJlbHMgY2FuIGJlIGNhcnJpZWQgb3ZlciB3aXRob3V0IHRvdWNo
#8#aW5nIGEKICAgIHNpbmdsZSBjb29yZGluYXRlLgogICAgIiIiCiAgICBpZiB0YWJsZS5nZXQoInJl
#8#Z2lvblNvdXJjZSIpOgogICAgICAgIHJldHVybgogICAgZm9yIGNhbmQgaW4gX3NpZGVjYXJfY2Fu
#8#ZGlkYXRlcyhpbXNfcGF0aCwgRVhDRUxfU1VGRklYRVMpOgogICAgICAgIHRyeToKICAgICAgICAg
#8#ICAgc2lkZSA9IHJlYWRfZXhjZWwoY2FuZCkKICAgICAgICBleGNlcHQgRXhjZXB0aW9uOgogICAg
#8#ICAgICAgICBjb250aW51ZQogICAgICAgIGlmIGxlbihzaWRlWyJyb3dzIl0pICE9IGxlbih0YWJs
#8#ZVsicm93cyJdKSBhbmQgdmVyYm9zZToKICAgICAgICAgICAgcHJpbnQoZiIgIFtUUkFDS0lOR10g
#8#WyFdIHtjYW5kLm5hbWV9IGNvbXB0ZSB7bGVuKHNpZGVbJ3Jvd3MnXSl9IHNwb3RzLCBsJ29iamV0
#8#IEltYXJpcyAiCiAgICAgICAgICAgICAgICAgIGYiZHUgdm9sdW1lIHtsZW4odGFibGVbJ3Jvd3Mn
#8#XSl9IDogbGUgY2xhc3NldXIgbidlc3QgcGV1dC1ldHJlIHBhcyBhIGpvdXIiKQogICAgICAgIGlm
#8#IG5vdCBzaWRlLmdldCgicmVnaW9uU291cmNlIik6CiAgICAgICAgICAgIGNvbnRpbnVlCiAgICAg
#8#ICAgbGFiZWxzID0ge2ludChyWyJjZWxsX2lkIl0pOiByWyJyZWdpb24iXSBmb3IgciBpbiBzaWRl
#8#WyJyb3dzIl0gaWYgci5nZXQoInJlZ2lvbiIpfQogICAgICAgIGhpdHMgPSAwCiAgICAgICAgZm9y
#8#IHJvdyBpbiB0YWJsZVsicm93cyJdOgogICAgICAgICAgICBsYWJlbCA9IGxhYmVscy5nZXQoaW50
#8#KHJvd1siY2VsbF9pZCJdKSkKICAgICAgICAgICAgaWYgbGFiZWwgYW5kIGxhYmVsICE9ICJVbmtu
#8#b3duIjoKICAgICAgICAgICAgICAgIHJvd1sicmVnaW9uIl0gPSBsYWJlbAogICAgICAgICAgICAg
#8#ICAgaGl0cyArPSAxCiAgICAgICAgaWYgaGl0czoKICAgICAgICAgICAgdGFibGVbInJlZ2lvblNv
#8#dXJjZSJdID0gZiJ7c2lkZVsncmVnaW9uU291cmNlJ119ICh2aWEge2NhbmQubmFtZX0pIgogICAg
#8#ICAgICAgICB0YWJsZVsicHJvdmVuYW5jZSJdWyJyZWdpb25Db2x1bW4iXSA9IHRhYmxlWyJyZWdp
#8#b25Tb3VyY2UiXQogICAgICAgICAgICB0YWJsZVsicHJvdmVuYW5jZSJdWyJyZWdpb25GaWxlIl0g
#8#PSBjYW5kLm5hbWUKICAgICAgICAgICAgaWYgdmVyYm9zZToKICAgICAgICAgICAgICAgIHByaW50
#8#KGYiICBbVFJBQ0tJTkddIGNsYXNzaWZpY2F0aW9uIHJlcHJpc2UgZGUge2NhbmQubmFtZX0gIgog
#8#ICAgICAgICAgICAgICAgICAgICAgZiIoe2hpdHN9L3tsZW4odGFibGVbJ3Jvd3MnXSl9IHNwb3Rz
#8#KSIpCiAgICAgICAgICAgIHJldHVybgoKCmRlZiByZXNvbHZlKGltc19wYXRoLCB3b3JrZGlyLCBk
#8#YXRhc2V0X25hbWU9Tm9uZSwgdmVyYm9zZT1UcnVlKToKICAgICIiIlJldHVybiBgYChjb250YWlu
#8#ZXIgcGF0aCwgc291cmNlLCBnbGIgcGF0aClgYCBmb3IgYSB2b2x1bWUsIG9yIE5vbmUgaWYgaXQg
#8#aGFzIG5vIHRyYWNraW5nLgoKICAgIEEgYGAuaW1hcmlzX3RyYWNrYGAgaXMgdXNlZCBhcyBpdCBz
#8#dGFuZHM7IHRoZSBvdGhlciB0d28gc291cmNlcyBhcmUgY29udmVydGVkIGludG8gb25lLAogICAg
#8#d3JpdHRlbiB1bmRlciBgYHdvcmtkaXJgYCBzbyB0aGUgZGF0YXNldCBkaXJlY3Rvcnkgb25seSBl
#8#dmVyIHJlY2VpdmVzIHdoYXQgdGhlIGltcG9ydGVyCiAgICBwdXRzIHRoZXJlLgogICAgIiIiCiAg
#8#ICBpbXNfcGF0aCA9IFBhdGgoaW1zX3BhdGgpCiAgICBkYXRhc2V0X25hbWUgPSBkYXRhc2V0X25h
#8#bWUgb3IgaW1zX3BhdGguc3RlbQogICAgc291cmNlcyA9IGRpc2NvdmVyKGltc19wYXRoKQogICAg
#8#aWYgbm90IHNvdXJjZXM6CiAgICAgICAgcmV0dXJuIE5vbmUKCiAgICBlcnJvcnMgPSBbXQogICAg
#8#Zm9yIHNvdXJjZSBpbiBzb3VyY2VzOgogICAgICAgIHRyeToKICAgICAgICAgICAgaWYgc291cmNl
#8#LmtpbmQgPT0gImNvbnRhaW5lciI6CiAgICAgICAgICAgICAgICBpZiB2ZXJib3NlOgogICAgICAg
#8#ICAgICAgICAgICAgIHByaW50KGYiICBbVFJBQ0tJTkddIHNvdXJjZSA6IHtzb3VyY2UuZGVzY3Jp
#8#YmUoKX0iKQogICAgICAgICAgICAgICAgcmV0dXJuIHNvdXJjZS5wYXRoLCBzb3VyY2UsIHNvdXJj
#8#ZS5nbGIKICAgICAgICAgICAgaWYgdmVyYm9zZToKICAgICAgICAgICAgICAgIHByaW50KGYiICBb
#8#VFJBQ0tJTkddIHNvdXJjZSA6IHtzb3VyY2UuZGVzY3JpYmUoKX0iKQogICAgICAgICAgICB0YWJs
#8#ZSA9IHJlYWRfc291cmNlKHNvdXJjZSkKICAgICAgICAgICAgaWYgbm90IHRhYmxlIG9yIG5vdCB0
#8#YWJsZS5nZXQoInJvd3MiKToKICAgICAgICAgICAgICAgIGVycm9ycy5hcHBlbmQoZiJ7c291cmNl
#8#LmtpbmR9OiBhdWN1bmUgZG9ubmVlIGV4cGxvaXRhYmxlIikKICAgICAgICAgICAgICAgIGNvbnRp
#8#bnVlCiAgICAgICAgICAgIGlmIHNvdXJjZS5raW5kID09ICJzY2VuZTgiOgogICAgICAgICAgICAg
#8#ICAgX21lcmdlX3JlZ2lvbnNfZnJvbV9leGNlbCh0YWJsZSwgaW1zX3BhdGgsIHZlcmJvc2UpCiAg
#8#ICAgICAgICAgIGZvciB3YXJuaW5nIGluIHRhYmxlLmdldCgid2FybmluZ3MiKSBvciBbXToKICAg
#8#ICAgICAgICAgICAgIHByaW50KGYiICBbVFJBQ0tJTkddIFshXSB7d2FybmluZ30iKQogICAgICAg
#8#ICAgICBpZiB2ZXJib3NlIGFuZCB0YWJsZS5nZXQoInJlZ2lvblNvdXJjZSIpOgogICAgICAgICAg
#8#ICAgICAgcHJpbnQoZiIgIFtUUkFDS0lOR10gY2xhc3NpZmljYXRpb24gOiB7dGFibGVbJ3JlZ2lv
#8#blNvdXJjZSddfSIpCiAgICAgICAgICAgIGRvYyA9IGJ1aWxkX2NvbnRhaW5lcih0YWJsZSwgZGF0
#8#YXNldF9uYW1lLCB2ZXJib3NlPXZlcmJvc2UpCiAgICAgICAgICAgIG91dCA9IHdyaXRlX2NvbnRh
#8#aW5lcihkb2MsIFBhdGgod29ya2RpcikgLyBmIntkYXRhc2V0X25hbWV9e0NPTlRBSU5FUl9TVUZG
#8#SVh9IikKICAgICAgICAgICAgcmV0dXJuIG91dCwgc291cmNlLCBOb25lCiAgICAgICAgZXhjZXB0
#8#IEV4Y2VwdGlvbiBhcyBleGM6CiAgICAgICAgICAgIGVycm9ycy5hcHBlbmQoZiJ7c291cmNlLmtp
#8#bmR9OiB7ZXhjfSIpCiAgICAgICAgICAgIGlmIHZlcmJvc2U6CiAgICAgICAgICAgICAgICBwcmlu
#8#dChmIiAgW1RSQUNLSU5HXSBbIV0ge3NvdXJjZS5raW5kfSBpbnV0aWxpc2FibGUgOiB7ZXhjfSIp
#8#CgogICAgaWYgZXJyb3JzIGFuZCB2ZXJib3NlOgogICAgICAgIHByaW50KCIgIFtUUkFDS0lOR10g
#8#WyFdIGF1Y3VuZSBzb3VyY2UgZXhwbG9pdGFibGUiKQogICAgcmV0dXJuIE5vbmUKCgpkZWYgbWF0
#8#ZXJpYWxpemUocGF0aCwgd29ya2RpciwgZGF0YXNldF9uYW1lPU5vbmUpIC0+IFBhdGg6CiAgICAi
#8#IiJQYXRoIHRvIGEgcmVhZHktdG8taW1wb3J0IGNvbnRhaW5lciBmb3IgYW4gb3BlcmF0b3ItZGVz
#8#aWduYXRlZCBmaWxlLgoKICAgIEEgYGAuaW1hcmlzX3RyYWNrYGAgaXMgaGFuZGVkIGJhY2sgdW50
#8#b3VjaGVkOyBhbnl0aGluZyBlbHNlIGlzIGNvbnZlcnRlZCB1bmRlciBgYHdvcmtkaXJgYC4KICAg
#8#ICIiIgogICAgcGF0aCA9IFBhdGgocGF0aCkKICAgIGlmIHBhdGguc3VmZml4Lmxvd2VyKCkgPT0g
#8#Q09OVEFJTkVSX1NVRkZJWDoKICAgICAgICByZXR1cm4gcGF0aAogICAgZGF0YXNldF9uYW1lID0g
#8#ZGF0YXNldF9uYW1lIG9yIHBhdGguc3RlbQogICAgZG9jID0gbG9hZF9kb2N1bWVudChwYXRoKQog
#8#ICAgcmV0dXJuIHdyaXRlX2NvbnRhaW5lcihkb2MsIFBhdGgod29ya2RpcikgLyBmIntkYXRhc2V0
#8#X25hbWV9e0NPTlRBSU5FUl9TVUZGSVh9IikKCgpkZWYgbG9hZF9kb2N1bWVudChwYXRoKSAtPiBk
#8#aWN0OgogICAgIiIiUmVhZCBhbnkgc3VwcG9ydGVkIHRyYWNraW5nIGlucHV0IGludG8gYW4gSU1B
#8#UklTX1RSQUNLRVJfVjEgZG9jdW1lbnQuIiIiCiAgICBwYXRoID0gUGF0aChwYXRoKQogICAgaWYg
#8#cGF0aC5zdWZmaXgubG93ZXIoKSA9PSBDT05UQUlORVJfU1VGRklYOgogICAgICAgIHdpdGggZ3pp
#8#cC5vcGVuKHN0cihwYXRoKSwgInJiIikgYXMgZmg6CiAgICAgICAgICAgIGJsb2IgPSBmaC5yZWFk
#8#KCkKICAgICAgICBpZiBibG9iLnN0YXJ0c3dpdGgoU0lHTkFUVVJFLmVuY29kZSgpKToKICAgICAg
#8#ICAgICAgYmxvYiA9IGJsb2JbYmxvYi5pbmRleChiIlxuIikgKyAxOl0KICAgICAgICByZXR1cm4g
#8#anNvbi5sb2FkcyhibG9iLmRlY29kZSgidXRmLTgiKSkKCiAgICBpZiBwYXRoLnN1ZmZpeC5sb3dl
#8#cigpID09ICIuaW1zIjoKICAgICAgICB0YWJsZSA9IHJlYWRfc2NlbmU4KHBhdGgpCiAgICAgICAg
#8#aWYgbm90IHRhYmxlOgogICAgICAgICAgICByYWlzZSBWYWx1ZUVycm9yKGYie3BhdGgubmFtZX06
#8#IGF1Y3VuIG9iamV0IGRlIHRyYWNraW5nIGRhbnMgU2NlbmU4IikKICAgICAgICBfbWVyZ2VfcmVn
#8#aW9uc19mcm9tX2V4Y2VsKHRhYmxlLCBwYXRoLCB2ZXJib3NlPVRydWUpCiAgICBlbGlmIHBhdGgu
#8#c3VmZml4Lmxvd2VyKCkgaW4gRVhDRUxfU1VGRklYRVM6CiAgICAgICAgdGFibGUgPSByZWFkX2V4
#8#Y2VsKHBhdGgpCiAgICBlbHNlOgogICAgICAgIHJhaXNlIFZhbHVlRXJyb3IoZiJ7cGF0aC5uYW1l
#8#fTogZm9ybWF0IG5vbiBzdXBwb3J0ZSAiCiAgICAgICAgICAgICAgICAgICAgICAgICBmIiguaW1h
#8#cmlzX3RyYWNrLCAuaW1zLCB7JywgJy5qb2luKEVYQ0VMX1NVRkZJWEVTKX0pIikKCiAgICBmb3Ig
#8#d2FybmluZyBpbiB0YWJsZS5nZXQoIndhcm5pbmdzIikgb3IgW106CiAgICAgICAgcHJpbnQoZiJb
#8#VFJBQ0tJTkddIFshXSB7d2FybmluZ30iKQogICAgcmV0dXJuIGJ1aWxkX2NvbnRhaW5lcih0YWJs
#8#ZSwgcGF0aC5zdGVtKQoKCmRlZiBtYWluKCk6CiAgICBhcCA9IGFyZ3BhcnNlLkFyZ3VtZW50UGFy
#8#c2VyKAogICAgICAgIGRlc2NyaXB0aW9uPSJEZXRlY3RlIGV0IG5vcm1hbGlzZSBsJ2FuYWx5c2Ug
#8#ZGUgdHJhY2tpbmcgYXNzb2NpZWUgYSB1biB2b2x1bWUgSW1hcmlzLiIpCiAgICBhcC5hZGRfYXJn
#8#dW1lbnQoImlucHV0IiwgaGVscD0iLmltcywgLnhscy8ueGxzeCBvdSAuaW1hcmlzX3RyYWNrIikK
#8#ICAgIGFwLmFkZF9hcmd1bWVudCgiLS1saXN0IiwgYWN0aW9uPSJzdG9yZV90cnVlIiwKICAgICAg
#8#ICAgICAgICAgICAgICBoZWxwPSJsaXN0ZXIgbGVzIHNvdXJjZXMgZGV0ZWN0ZWVzIHNhbnMgcmll
#8#biBjb252ZXJ0aXIiKQogICAgYXAuYWRkX2FyZ3VtZW50KCItLW91dCIsIGRlZmF1bHQ9Tm9uZSwK
#8#ICAgICAgICAgICAgICAgICAgICBoZWxwPSJlY3JpcmUgbGUgY29udGVuZXVyIC5pbWFyaXNfdHJh
#8#Y2sgbm9ybWFsaXNlIGEgY2UgY2hlbWluIikKICAgIGFyZ3MgPSBhcC5wYXJzZV9hcmdzKCkKCiAg
#8#ICBwYXRoID0gUGF0aChhcmdzLmlucHV0KQogICAgaWYgYXJncy5saXN0OgogICAgICAgIHNvdXJj
#8#ZXMgPSBkaXNjb3ZlcihwYXRoKQogICAgICAgIGlmIG5vdCBzb3VyY2VzOgogICAgICAgICAgICBw
#8#cmludCgiQXVjdW5lIHNvdXJjZSBkZSB0cmFja2luZyBkZXRlY3RlZS4iKQogICAgICAgICAgICBy
#8#ZXR1cm4gMQogICAgICAgIGZvciBpLCBzb3VyY2UgaW4gZW51bWVyYXRlKHNvdXJjZXMsIDEpOgog
#8#ICAgICAgICAgICBwcmludChmIiAge2l9LiB7c291cmNlLmRlc2NyaWJlKCl9IikKICAgICAgICBy
#8#ZXR1cm4gMAoKICAgIGRvYyA9IGxvYWRfZG9jdW1lbnQocGF0aCkKICAgIGRhdGEgPSBkb2NbImRh
#8#dGEiXQogICAgcHJpbnQoZiJjZWxsdWxlcyAgIDoge2xlbihkYXRhWydjZWxscyddKX0iKQogICAg
#8#cHJpbnQoZiJ0aW1lcG9pbnRzIDoge2xlbihkYXRhWyd0aW1lcG9pbnRzJ10pfSAoe2RhdGFbJ3Rp
#8#bWVwb2ludHMnXVswXTpnfS4ue2RhdGFbJ3RpbWVwb2ludHMnXVstMV06Z30pIikKICAgIHByb3Yg
#8#PSBkYXRhLmdldCgicHJvdmVuYW5jZSIpIG9yIHt9CiAgICBpZiBwcm92OgogICAgICAgIHByaW50
#8#KCJwcm92ZW5hbmNlIDogIiArICIsICIuam9pbihmIntrfT17dn0iIGZvciBrLCB2IGluIHByb3Yu
#8#aXRlbXMoKSkpCiAgICBpZiBhcmdzLm91dDoKICAgICAgICB3cml0ZV9jb250YWluZXIoZG9jLCBh
#8#cmdzLm91dCkKICAgICAgICBwcmludChmImVjcml0ICAgICAgOiB7YXJncy5vdXR9IikKICAgIHJl
#8#dHVybiAwCgoKaWYgX19uYW1lX18gPT0gIl9fbWFpbl9fIjoKICAgIHN5cy5leGl0KG1haW4oKSkK
:: ---- [9] build_download_bundles.py (32704 octets) ----
#9#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwoiIiIKYnVpbGRfZG93bmxvYWRfYnVuZGxlcy5weSDigJQg
#9#UG9wdWxhdGUgZWFjaCBkYXRhc2V0J3MgZG93bmxvYWQvIGZvbGRlci4KCkZvciBldmVyeSBkYXRh
#9#c2V0IHVuZGVyIERBVEFfV0VCLzx0eXBlPi88Zm9sZGVyPi8gdGhpcyBidWlsZHMgdGhlIGZpbGVz
#9#IHRoZQpEb3dubG9hZCBDZW50ZXIncyBmaWxlIGV4cGxvcmVyIChhcGkvZG93bmxvYWRzKSB3aWxs
#9#IGV4cG9zZSwgaW4gdGhpcyBvcmRlcjoKCiAgMS4gPGZvbGRlcj5fd2ViLnppcCAgIOKAlCBhcmNo
#9#aXZlIG9mIHRoZSBzZXJ2ZWQvcHJlcHJvY2Vzc2VkIGRhdGFzZXQgKGJyaWNrcy8sCiAgICAgICAg
#9#ICAgICAgICAgICAgICAgICAgbWV0YWRhdGEuanNvbiwgdGh1bWJuYWlsLndlYnApLiBUaGUgZG93
#9#bmxvYWQvIGZvbGRlciBpcwogICAgICAgICAgICAgICAgICAgICAgICAgIEVYQ0xVREVELCBzbyB0
#9#aGUgYXJjaGl2ZSBuZXZlciBjb250YWlucyB0aGUgb3RoZXIKICAgICAgICAgICAgICAgICAgICAg
#9#ICAgICBkb3dubG9hZCBhcnRlZmFjdHMgKG9yIGl0c2VsZikuIEJ1aWx0IEZJUlNULgogIDIuIDxm
#9#b2xkZXI+LmltcyAgICAgICDigJQgdGhlIG9yaWdpbmFsIEltYXJpcyBmaWxlLCBwbGFjZWQgYnkg
#9#SEFSRCBMSU5LIChubyBieXRlCiAgICAgICAgICAgICAgICAgICAgICAgICAgZHVwbGljYXRpb247
#9#IFJBV19EQVRBIGFuZCBEQVRBX1dFQiBsaXZlIG9uIHRoZSBzYW1lCiAgICAgICAgICAgICAgICAg
#9#ICAgICAgICAgdm9sdW1lKS4gRmFsbHMgYmFjayB0byBhIGNvcHkgYWNyb3NzIHZvbHVtZXMuCiAg
#9#My4gPGZvbGRlcj4udGlmICAgICAgIOKAlCBhIG11bHRpLWNoYW5uZWwgSW1hZ2VKL0ZpamkgY29t
#9#cG9zaXRlIGh5cGVyc3RhY2sKICAgICAgICAgICAgICAgICAgICAgICAgICAobmF0aXZlIGJpdCBk
#9#ZXB0aCwgwrVtLWNhbGlicmF0ZWQsIHBlci1jaGFubmVsIGRpc3BsYXkKICAgICAgICAgICAgICAg
#9#ICAgICAgICAgICByYW5nZSArIExVVCkgcmVjb25zdHJ1Y3RlZCBmcm9tIHRoZSAuaW1zIGludGVy
#9#bmFsCiAgICAgICAgICAgICAgICAgICAgICAgICAgcmVzb2x1dGlvbiBweXJhbWlkIGF0IH5UQVJH
#9#RVRfUFggb24gdGhlIGxvbmcgWFkgc2lkZS4KICAgICAgICAgICAgICAgICAgICAgICAgICBJbWFn
#9#ZUogZmxhdm91ciByYXRoZXIgdGhhbiBPTUUgYmVjYXVzZSBPTUUtWE1MIGhhcyBubwogICAgICAg
#9#ICAgICAgICAgICAgICAgICAgIGRpc3BsYXktcmFuZ2UgZmllbGQ6IEJpby1Gb3JtYXRzIHRoZW4g
#9#b3BlbnMgdGhlIHN0YWNrCiAgICAgICAgICAgICAgICAgICAgICAgICAgYWNyb3NzIHRoZSBmdWxs
#9#IDAuLjY1NTM1IHN3ZWVwIGFuZCBldmVyeSBjaGFubmVsIHJlYWRzCiAgICAgICAgICAgICAgICAg
#9#ICAgICAgICAgYmxhY2sgdW50aWwgdGhlIHVzZXIgaGl0cyBSZXNldCBpbiBCcmlnaHRuZXNzL0Nv
#9#bnRyYXN0LgogICAgICAgICAgICAgICAgICAgICAgICAgIFRoZSAuaW1zIGJlc2lkZSBpdCBzdGF5
#9#cyB0aGUgaW50ZXJvcGVyYWJsZSBtYXN0ZXIuCiAgNC4gPGZvbGRlcj5fQ3tufV88bmFtZT5fTUlQ
#9#LnBuZyDigJQgcGVyLWNoYW5uZWwgbWF4aW11bS1pbnRlbnNpdHkgcHJvamVjdGlvbi4KICA1LiBS
#9#RUFETUUudHh0ICAgICAgICAg4oCUIHByb3ZlbmFuY2UsIGRpbWVuc2lvbnMsIHZveGVsIHNpemUs
#9#IGNoYW5uZWxzLCBjaXRhdGlvbi4KClRoZSAuaW1zIGlzIHJlYWQgc3RyYWlnaHQgZnJvbSB0aGUg
#9#SW1hcmlzIEhERjUgcHlyYW1pZCAoUmVzb2x1dGlvbkxldmVsIEwpLCBzbwpvbmx5IHRoZSBjaG9z
#9#ZW4gKHNtYWxsKSBsZXZlbCBpcyB0b3VjaGVkIOKAlCBuZXZlciB0aGUgZnVsbC1yZXNvbHV0aW9u
#9#IGxldmVsIDAuCgpBIHRpbWVsYXBzZSAoJ2xpdmUnKSBrZWVwcyBldmVyeSBmcmFtZSBpbiBpdHMg
#9#LmltcyBhbmQgaXRzIHdlYiBhcmNoaXZlOyB0aGUgVElGRiBhbmQKdGhlIE1JUHMgYXJlIE9ORSBm
#9#cmFtZSBvZiBpdCDigJQgdGhlIGZpcnN0IHVubGVzcyAtLXRpbWVwb2ludCBzYXlzIG90aGVyd2lz
#9#ZSDigJQgYW5kIHRoZQpSRUFETUUgc2F5cyB3aGljaC4gT25lIGZyYW1lIGtlZXBzIHRoZSBUSUZG
#9#IHRoZSBzaXplIG9mIGEgZml4ZWQgc3RhY2snczsgdGhlIC5pbXMgYmVzaWRlCml0IGlzIHRoZSBj
#9#b21wbGV0ZSBhY3F1aXNpdGlvbi4KCklkZW1wb3RlbnQ6IGV4aXN0aW5nIGFydGVmYWN0cyBhcmUg
#9#c2tpcHBlZCB1bmxlc3MgLS1mb3JjZS4gRWFjaCBkYXRhc2V0IGlzCmlzb2xhdGVkIGluIHRyeS9l
#9#eGNlcHQgc28gb25lIGZhaWx1cmUgbmV2ZXIgYWJvcnRzIHRoZSBiYXRjaC4KClVzYWdlOgogIHB5
#9#IHRvb2xzL2J1aWxkX2Rvd25sb2FkX2J1bmRsZXMucHkgICAgICAgICAgICAgICAgICMgYWxsIGRh
#9#dGFzZXRzLCBhbGwgYXJ0ZWZhY3RzCiAgcHkgdG9vbHMvYnVpbGRfZG93bmxvYWRfYnVuZGxlcy5w
#9#eSAtLWRhdGFzZXRzIEU4LTEgIyBzdWJzdHJpbmcgZmlsdGVyCiAgcHkgdG9vbHMvYnVpbGRfZG93
#9#bmxvYWRfYnVuZGxlcy5weSAtLWRyeS1ydW4KICBweSB0b29scy9idWlsZF9kb3dubG9hZF9idW5k
#9#bGVzLnB5IC0tbm8taW1zIC0tbm8tYXJjaGl2ZSAgICMgb25seSBUSUZGICsgTUlQCiAgcHkgdG9v
#9#bHMvYnVpbGRfZG93bmxvYWRfYnVuZGxlcy5weSAtLXRpZmYtcHggMTAyNCAtLWZvcmNlCiAgcHkg
#9#dG9vbHMvYnVpbGRfZG93bmxvYWRfYnVuZGxlcy5weSAtLWRhdGFzZXQgbGl2ZS88Zm9sZGVyPiAt
#9#LXRpbWVwb2ludCAxMgoiIiIKZnJvbSBfX2Z1dHVyZV9fIGltcG9ydCBhbm5vdGF0aW9ucwoKaW1w
#9#b3J0IGFyZ3BhcnNlCmltcG9ydCBqc29uCmltcG9ydCBvcwppbXBvcnQgcmUKaW1wb3J0IHNodXRp
#9#bAppbXBvcnQgc3lzCmltcG9ydCB0ZW1wZmlsZQppbXBvcnQgdGltZQppbXBvcnQgd2FybmluZ3MK
#9#aW1wb3J0IHppcGZpbGUKZnJvbSBwYXRobGliIGltcG9ydCBQYXRoCgppbXBvcnQgbnVtcHkgYXMg
#9#bnAKCiMg4pSA4pSAIFBhdGhzIC8gY29uZmlnIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#9#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#9#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#9#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgApST09UID0gUGF0aChfX2ZpbGVfXykucmVz
#9#b2x2ZSgpLnBhcmVudC5wYXJlbnQgICAgICAgICAgIyBXZWJQbGF0Zm9ybSByb290CkRBVEFfV0VC
#9#ID0gUk9PVCAvICJEQVRBX1dFQiIKIyBXaGVyZSB0aGUgb3JpZ2luYWwgLmltcyBmaWxlcyBsaXZl
#9#IChkb25lLyArIHRvZG8vIGFyZSBzY2FubmVkIHJlY3Vyc2l2ZWx5KTogdGhlCiMgbGFiJ3Mgd29y
#9#a3N0YXRpb24gZGVmYXVsdCwgTFVNRU5fUkFXX0RBVEFfRElSUyAob3MucGF0aHNlcC1zZXBhcmF0
#9#ZWQpIHdoZW4gc2V0LCBhbmQKIyAtLXJhdy1kaXIgaW4gZnJvbnQgb2YgZWl0aGVyLgpSQVdfREFU
#9#QV9ESVJTID0gWwogICAgUGF0aChyIkM6XFVzZXJzXEFkbWluaXN0cmF0b3JcRGVza3RvcFxGaXhl
#9#ZCBpbWFnZXMgZm9yIGRhdGFiYXNlXFJBV19EQVRBIiksCl0KaWYgb3MuZW52aXJvbi5nZXQoIkxV
#9#TUVOX1JBV19EQVRBX0RJUlMiKToKICAgIFJBV19EQVRBX0RJUlMgPSBbUGF0aChwKSBmb3IgcCBp
#9#biBvcy5lbnZpcm9uWyJMVU1FTl9SQVdfREFUQV9ESVJTIl0uc3BsaXQob3MucGF0aHNlcCkgaWYg
#9#cF0KREFUQVNFVF9UWVBFUyA9ICgiM2QiLCAiMmQiLCAibGl2ZSIpCgpUQVJHRVRfUFggPSAyMDQ4
#9#ICAgICAgICAgICAgICAgIyBkZXNpcmVkIGxvbmcgWFkgc2lkZSBvZiB0aGUgZ2VuZXJhdGVkIFRJ
#9#RkYKIyBIYXJkIGNlaWxpbmcgb24gdGhlIGluLWZsaWdodCB2b2x1bWUgKEPCt1rCt1nCt1jCt2l0
#9#ZW1zaXplKTsgaWYgdGhlIGxldmVsIGNsb3Nlc3QgdG8KIyBUQVJHRVRfUFggZXhjZWVkcyB0aGlz
#9#LCBzdGVwIGRvd24gdGhlIHB5cmFtaWQgc28gd2UgbmV2ZXIgYmxvdyB1cCBkaXNrL1JBTS4KIyBU
#9#aGlzIGlzIE5PVCB0aGUgY2xhc3NpYy1USUZGIDQgR2lCIG9mZnNldCBsaW1pdDogdGhhdCBvbmUg
#9#YXBwbGllcyB0byB0aGUKIyBDT01QUkVTU0VEIGZpbGUgKH40NSUgb2YgdGhlIHJhdyB2b2x1bWUg
#9#aGVyZSksIHNvIGNhcHBpbmcgdGhlIHJhdyB2b2x1bWUgYXQgNAojIEdpQiB3b3VsZCBjb3N0IHJl
#9#YWwgcmVzb2x1dGlvbiDigJQgaXQgaGFsdmVkIDQgb2YgdGhlIGxhYidzIDE2IGRhdGFzZXRzIHdo
#9#ZW4KIyB0cmllZC4gQW4gb3ZlcmZsb3dpbmcgd3JpdGUgaXMgY2F1Z2h0IGFuZCByZXRyaWVkIG9u
#9#ZSBsZXZlbCBjb2Fyc2VyIGluc3RlYWQuCk1BWF9USUZGX0JZVEVTID0gNiAqIDEwMjQqKjMKCiMg
#9#RmFsc2UtY29sb3VyIGZhbGxiYWNrcyAobWlycm9yIHJ1bl9wcmVwcm9jZXNzLlRIVU1CX0NPTE9S
#9#Uykgd2hlbiBhIGNoYW5uZWwgaGFzCiMgbm8gZGlzcGxheSBjb2xvdXIgaW4gbWV0YWRhdGEuanNv
#9#bi4KVEhVTUJfQ09MT1JTID0gWwogICAgKDAsIDI1NSwgMTAyKSwgKDI1NSwgNjEsIDI1NSksICg0
#9#NywgMTA3LCAyNTUpLCAoMjU1LCA0OCwgNDgpLAogICAgKDI1NSwgMjU1LCAwKSwgKDI1NSwgMCwg
#9#MjU1KSwgKDAsIDI1NSwgMjU1KSwKXQoKCiMg4pSA4pSAIEltYXJpcyBhdHRyaWJ1dGUgZGVjb2Rp
#9#bmcgKG1pcnJvcnMgcHJlcHJvY2Vzcy8xLWltc19tZXRhZGF0YS5hdHRyX3N0cikg4pSA4pSACmRl
#9#ZiBhdHRyX3N0cihncm91cCwga2V5LCBkZWZhdWx0PSIiKToKICAgIGlmIGdyb3VwIGlzIE5vbmU6
#9#CiAgICAgICAgcmV0dXJuIGRlZmF1bHQKICAgIHYgPSBncm91cC5hdHRycy5nZXQoa2V5LCBkZWZh
#9#dWx0KQogICAgaWYgaXNpbnN0YW5jZSh2LCAoYnl0ZXMsIG5wLmJ5dGVzXykpOgogICAgICAgIHJl
#9#dHVybiB2LmRlY29kZSgidXRmLTgiLCBlcnJvcnM9InJlcGxhY2UiKS5zdHJpcCgpCiAgICBpZiBp
#9#c2luc3RhbmNlKHYsIG5wLm5kYXJyYXkpOgogICAgICAgIHRyeToKICAgICAgICAgICAgcmV0dXJu
#9#IGIiIi5qb2luKAogICAgICAgICAgICAgICAgYnl0ZXMoYykgaWYgaXNpbnN0YW5jZShjLCAoYnl0
#9#ZXMsIG5wLmJ5dGVzXykpIGVsc2UgYy50b2J5dGVzKCkKICAgICAgICAgICAgICAgIGZvciBjIGlu
#9#IHYKICAgICAgICAgICAgKS5kZWNvZGUoInV0Zi04IiwgZXJyb3JzPSJyZXBsYWNlIikuc3RyaXAo
#9#KQogICAgICAgIGV4Y2VwdCBFeGNlcHRpb246CiAgICAgICAgICAgIHJldHVybiAiIi5qb2luKAog
#9#ICAgICAgICAgICAgICAgYy5kZWNvZGUoInV0Zi04IiwgZXJyb3JzPSJyZXBsYWNlIikgaWYgaXNp
#9#bnN0YW5jZShjLCAoYnl0ZXMsIG5wLmJ5dGVzXykpIGVsc2Ugc3RyKGMpCiAgICAgICAgICAgICAg
#9#ICBmb3IgYyBpbiB2CiAgICAgICAgICAgICkuc3RyaXAoKQogICAgcmV0dXJuIHN0cih2KS5zdHJp
#9#cCgpCgoKZGVmIGF0dHJfZmxvYXQoZ3JvdXAsIGtleSwgZGVmYXVsdD0wLjApOgogICAgdHJ5Ogog
#9#ICAgICAgIHJldHVybiBmbG9hdChhdHRyX3N0cihncm91cCwga2V5LCBzdHIoZGVmYXVsdCkpKQog
#9#ICAgZXhjZXB0IChUeXBlRXJyb3IsIFZhbHVlRXJyb3IpOgogICAgICAgIHJldHVybiBkZWZhdWx0
#9#CgoKZGVmIGhleF90b19yZ2IodmFsdWUsIGZhbGxiYWNrKToKICAgIG0gPSByZS5tYXRjaChyIl4j
#9#PyhbMC05YS1mQS1GXXs2fSkkIiwgc3RyKHZhbHVlIG9yICIiKS5zdHJpcCgpKQogICAgaWYgbm90
#9#IG06CiAgICAgICAgcmV0dXJuIGZhbGxiYWNrCiAgICBoID0gbS5ncm91cCgxKQogICAgcmV0dXJu
#9#IChpbnQoaFswOjJdLCAxNiksIGludChoWzI6NF0sIDE2KSwgaW50KGhbNDo2XSwgMTYpKQoKCiMg
#9#4pSA4pSAIERhdGFzZXQgZGlzY292ZXJ5IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#9#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#9#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#9#gOKUgOKUgOKUgOKUgOKUgOKUgApkZWYgX3JlYWRfbWV0YV9qc29uKGQpOgogICAgIiIiUGVyLWRh
#9#dGFzZXQgbWV0YWRhdGEuanNvbiDigJQgdGhlIGF1dGhvcml0YXRpdmUgc291cmNlIGZvciBjaGFu
#9#bmVscy92b3hlbHMuCiAgICB1dGYtOC1zaWcgdG9sZXJhdGVzIGEgc3RyYXkgQk9NIChoYW5kLWVk
#9#aXRlZCBmaWxlcykgd2l0aG91dCBicmVha2luZyB0aGUgcGFyc2UuIiIiCiAgICBwID0gZCAvICJt
#9#ZXRhZGF0YS5qc29uIgogICAgaWYgcC5leGlzdHMoKToKICAgICAgICB0cnk6CiAgICAgICAgICAg
#9#IHJldHVybiBqc29uLmxvYWRzKHAucmVhZF90ZXh0KGVuY29kaW5nPSJ1dGYtOC1zaWciKSkKICAg
#9#ICAgICBleGNlcHQgRXhjZXB0aW9uOgogICAgICAgICAgICByZXR1cm4ge30KICAgIHJldHVybiB7
#9#fQoKCmRlZiBsb2FkX2RhdGFzZXRzKGZpbHRlcl9zdWJzdHI9Tm9uZSwgdHlwZXM9REFUQVNFVF9U
#9#WVBFUywgZXhhY3RfaWQ9Tm9uZSk6CiAgICAiIiJSZXR1cm4gW3tpZCwgdHlwZSwgZm9sZGVyLCBk
#9#aXIsIG1ldGF9XSBmb3IgdGhlIGRhdGFzZXQgZm9sZGVycyB1bmRlciBEQVRBX1dFQi4KICAgIFRo
#9#ZSBjYXRhbG9nIGlzIGdlbmVyYXRlZCBwZXIgcmVxdWVzdCBmcm9tIHRoZXNlIHNhbWUgbWV0YWRh
#9#dGEuanNvbiBmaWxlcywgc28gdGhlCiAgICBmb2xkZXJzIGFyZSB0aGUgb25seSBpbmRleCB0aGVy
#9#ZSBpcy4gYGV4YWN0X2lkYCAoJzx0eXBlPi88Zm9sZGVyPicpIHNlbGVjdHMgb25lCiAgICBkYXRh
#9#c2V0OyBgZmlsdGVyX3N1YnN0cmAgbWF0Y2hlcyBmb2xkZXIgbmFtZXMgbG9vc2VseS4iIiIKICAg
#9#IG91dCA9IFtdCiAgICBmb3IgdHlwIGluIHR5cGVzOgogICAgICAgIGJhc2UgPSBEQVRBX1dFQiAv
#9#IHR5cAogICAgICAgIGlmIG5vdCBiYXNlLmlzX2RpcigpOgogICAgICAgICAgICBjb250aW51ZQog
#9#ICAgICAgIGZvciBkIGluIHNvcnRlZChiYXNlLml0ZXJkaXIoKSk6CiAgICAgICAgICAgIGlmIGQu
#9#aXNfZGlyKCkgYW5kIG5vdCBkLm5hbWUuc3RhcnRzd2l0aCgiLiIpOgogICAgICAgICAgICAgICAg
#9#b3V0LmFwcGVuZCh7ImlkIjogZiJ7dHlwfS97ZC5uYW1lfSIsICJ0eXBlIjogdHlwLCAiZm9sZGVy
#9#IjogZC5uYW1lLCAiZGlyIjogZCwKICAgICAgICAgICAgICAgICAgICAgICAgICAgICJtZXRhIjog
#9#X3JlYWRfbWV0YV9qc29uKGQpfSkKICAgIGlmIGV4YWN0X2lkOgogICAgICAgIG91dCA9IFtvIGZv
#9#ciBvIGluIG91dCBpZiBvWyJpZCJdID09IGV4YWN0X2lkXQogICAgaWYgZmlsdGVyX3N1YnN0cjoK
#9#ICAgICAgICBvdXQgPSBbbyBmb3IgbyBpbiBvdXQgaWYgZmlsdGVyX3N1YnN0ci5sb3dlcigpIGlu
#9#IG9bImZvbGRlciJdLmxvd2VyKCldCiAgICByZXR1cm4gb3V0CgoKZGVmIGZpbmRfaW1zKGZvbGRl
#9#cik6CiAgICAiIiJMb2NhdGUgPGZvbGRlcj4uaW1zIGluIGFueSBjb25maWd1cmVkIFJBV19EQVRB
#9#IGRpciAocmVjdXJzaXZlKS4iIiIKICAgIGZvciBiYXNlIGluIFJBV19EQVRBX0RJUlM6CiAgICAg
#9#ICAgaWYgbm90IGJhc2UuaXNfZGlyKCk6CiAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAgZXhh
#9#Y3QgPSBsaXN0KGJhc2Uucmdsb2IoZiJ7Zm9sZGVyfS5pbXMiKSkKICAgICAgICBpZiBleGFjdDoK
#9#ICAgICAgICAgICAgcmV0dXJuIGV4YWN0WzBdCiAgICByZXR1cm4gTm9uZQoKCiMg4pSA4pSAIFN0
#9#ZXAgMSDigJQgYXJjaGl2ZSBvZiB0aGUgcHJlcHJvY2Vzc2VkIGRhdGFzZXQgKGRvd25sb2FkLyBl
#9#eGNsdWRlZCkg4pSA4pSA4pSA4pSA4pSA4pSA4pSACmRlZiBidWlsZF9hcmNoaXZlKGRzX2Rpciwg
#9#Zm9sZGVyLCBvdXRfcGF0aCwgZm9yY2UsIGRyeSk6CiAgICBpZiBvdXRfcGF0aC5leGlzdHMoKSBh
#9#bmQgbm90IGZvcmNlOgogICAgICAgIHJldHVybiAic2tpcCAoZXhpc3RzKSIKICAgICMgQ29sbGVj
#9#dCB0aGUgc2VydmFibGUgZmlsZXMgZmlyc3Q7IHRoZSBkb3dubG9hZC8gZm9sZGVyIGlzIGV4Y2x1
#9#ZGVkIHNvIHRoZQogICAgIyBhcmNoaXZlIG5ldmVyIGNvbnRhaW5zIHRoZSBvdGhlciBhcnRlZmFj
#9#dHMgKG9yIGl0c2VsZikuCiAgICBmaWxlcyA9IFtwIGZvciBwIGluIHNvcnRlZChkc19kaXIucmds
#9#b2IoIioiKSkKICAgICAgICAgICAgIGlmIHAuaXNfZmlsZSgpIGFuZCBub3QgX2V4Y2x1ZGVkX2Zy
#9#b21fYXJjaGl2ZShwLnJlbGF0aXZlX3RvKGRzX2RpcikpXQogICAgaWYgbm90IGZpbGVzOgogICAg
#9#ICAgIHJldHVybiAic2tpcCAobm8gd2ViIGRhdGEgeWV0KSIgICAgICAgICMgdW4tcHJlcHJvY2Vz
#9#c2VkIGRhdGFzZXQg4oaSIG5vIGVtcHR5IHppcAogICAgaWYgZHJ5OgogICAgICAgIHJldHVybiBm
#9#IndvdWxkIGJ1aWxkICh7bGVuKGZpbGVzKX0gZmlsZXMpIgogICAgdG1wID0gb3V0X3BhdGgud2l0
#9#aF9zdWZmaXgob3V0X3BhdGguc3VmZml4ICsgIi50bXAiKQogICAgd2l0aCB6aXBmaWxlLlppcEZp
#9#bGUodG1wLCAidyIsIGNvbXByZXNzaW9uPXppcGZpbGUuWklQX1NUT1JFRCwgYWxsb3daaXA2ND1U
#9#cnVlKSBhcyB6ZjoKICAgICAgICBmb3IgcGF0aCBpbiBmaWxlczoKICAgICAgICAgICAgemYud3Jp
#9#dGUocGF0aCwgYXJjbmFtZT1zdHIoUGF0aChmb2xkZXIpIC8gcGF0aC5yZWxhdGl2ZV90byhkc19k
#9#aXIpKSkKICAgIG9zLnJlcGxhY2UodG1wLCBvdXRfcGF0aCkKICAgIHJldHVybiBmIntsZW4oZmls
#9#ZXMpfSBmaWxlcywge2ZtdF9zaXplKG91dF9wYXRoLnN0YXQoKS5zdF9zaXplKX0iCgoKZGVmIF9l
#9#eGNsdWRlZF9mcm9tX2FyY2hpdmUocmVsOiBQYXRoKSAtPiBib29sOgogICAgIiIiZG93bmxvYWQv
#9#ICh0aGUgb3RoZXIgYXJ0ZWZhY3RzLCBhbmQgdGhlIGFyY2hpdmUgaXRzZWxmKSwgZG90ZmlsZXMg
#9#KHRlbXBvcmFyeQogICAgZmlsZXMsIGEgcHVibGlzaCBtYXJrZXIpIGFuZCB0aGUgb2xkIGVudHJp
#9#ZXMgYSBwdWJsaXNoIHNldHMgYXNpZGUuIiIiCiAgICBmaXJzdCA9IHJlbC5wYXJ0c1swXQogICAg
#9#cmV0dXJuIChmaXJzdCA9PSAiZG93bmxvYWQiIG9yIGFueShwYXJ0LnN0YXJ0c3dpdGgoIi4iKSBm
#9#b3IgcGFydCBpbiByZWwucGFydHMpCiAgICAgICAgICAgIG9yIGZpcnN0LmVuZHN3aXRoKCIucHJl
#9#LXN3YXAiKSBvciBmaXJzdCA9PSAiYnJpY2tzLnJvbGxiYWNrIikKCgojIOKUgOKUgCBTdGVwIDIg
#9#4oCUIG9yaWdpbmFsIC5pbXMgdmlhIGhhcmQgbGluayAoY29weSBmYWxsYmFjaykg4pSA4pSA4pSA
#9#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmRlZiBw
#9#bGFjZV9pbXMoaW1zX3NyYywgb3V0X3BhdGgsIGZvcmNlLCBkcnkpOgogICAgaWYgb3V0X3BhdGgu
#9#ZXhpc3RzKCkgYW5kIG5vdCBmb3JjZToKICAgICAgICByZXR1cm4gInNraXAgKGV4aXN0cykiCiAg
#9#ICBpZiBkcnk6CiAgICAgICAgcmV0dXJuIGYid291bGQgbGluayB7Zm10X3NpemUoaW1zX3NyYy5z
#9#dGF0KCkuc3Rfc2l6ZSl9IgogICAgaWYgb3V0X3BhdGguZXhpc3RzKCk6CiAgICAgICAgb3V0X3Bh
#9#dGgudW5saW5rKCkKICAgIHRyeToKICAgICAgICBvcy5saW5rKGltc19zcmMsIG91dF9wYXRoKSAg
#9#ICAgICAgICAgICAgICAgICAgICAjIGhhcmQgbGluaywgMCBleHRyYSBieXRlcwogICAgICAgIHJl
#9#dHVybiBmImhhcmRsaW5rIHtmbXRfc2l6ZShvdXRfcGF0aC5zdGF0KCkuc3Rfc2l6ZSl9IgogICAg
#9#ZXhjZXB0IE9TRXJyb3I6CiAgICAgICAgc2h1dGlsLmNvcHkyKGltc19zcmMsIG91dF9wYXRoKSAg
#9#ICAgICAgICAgICAgICAgIyBjcm9zcy12b2x1bWUgZmFsbGJhY2sKICAgICAgICByZXR1cm4gZiJj
#9#b3B5IHtmbXRfc2l6ZShvdXRfcGF0aC5zdGF0KCkuc3Rfc2l6ZSl9IgoKCiMg4pSA4pSAIFN0ZXAg
#9#My80IOKAlCBJbWFnZUogVElGRiAoKyBwZXItY2hhbm5lbCBNSVApIGZyb20gdGhlIC5pbXMgcHly
#9#YW1pZCDilIDilIDilIDilIDilIDilIDilIDilIAKZGVmIGxpc3RfbGV2ZWxzKGYsIHRpbWVwb2lu
#9#dD0wKToKICAgICIiIlsoTCwgWHIsIFlyLCBacildIGZyb20gdGhlIEltYXJpcyBSZXNvbHV0aW9u
#9#TGV2ZWwgZ3JvdXBzIChyZWFsIHNpemVzKS4iIiIKICAgIGRhdGFzZXQgPSBmWyJEYXRhU2V0Il0K
#9#ICAgIG91dCA9IFtdCiAgICBmb3Iga2V5IGluIGRhdGFzZXQua2V5cygpOgogICAgICAgIGlmIG5v
#9#dCBrZXkuc3RhcnRzd2l0aCgiUmVzb2x1dGlvbkxldmVsIik6CiAgICAgICAgICAgIGNvbnRpbnVl
#9#CiAgICAgICAgTCA9IGludChrZXkuc3BsaXQoKVstMV0pCiAgICAgICAgdHAgPSBkYXRhc2V0W2tl
#9#eV0uZ2V0KGYiVGltZVBvaW50IHt0aW1lcG9pbnR9IikKICAgICAgICBpZiB0cCBpcyBOb25lOgog
#9#ICAgICAgICAgICBjb250aW51ZQogICAgICAgIGNoMCA9IHRwLmdldCgiQ2hhbm5lbCAwIikKICAg
#9#ICAgICBpZiBjaDAgaXMgTm9uZToKICAgICAgICAgICAgY29udGludWUKICAgICAgICB4ciA9IGlu
#9#dChhdHRyX3N0cihjaDAsICJJbWFnZVNpemVYIiwgIjAiKSBvciAwKQogICAgICAgIHlyID0gaW50
#9#KGF0dHJfc3RyKGNoMCwgIkltYWdlU2l6ZVkiLCAiMCIpIG9yIDApCiAgICAgICAgenIgPSBpbnQo
#9#YXR0cl9zdHIoY2gwLCAiSW1hZ2VTaXplWiIsICIwIikgb3IgMCkKICAgICAgICBpZiBub3QgKHhy
#9#IGFuZCB5ciBhbmQgenIpOgogICAgICAgICAgICBkYXRhID0gY2gwLmdldCgiRGF0YSIpCiAgICAg
#9#ICAgICAgIGlmIGRhdGEgaXMgTm9uZToKICAgICAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAg
#9#ICAgIHpyLCB5ciwgeHIgPSAoenIgb3IgZGF0YS5zaGFwZVswXSwgeXIgb3IgZGF0YS5zaGFwZVsx
#9#XSwgeHIgb3IgZGF0YS5zaGFwZVsyXSkKICAgICAgICBvdXQuYXBwZW5kKChMLCB4ciwgeXIsIHpy
#9#KSkKICAgIHJldHVybiBzb3J0ZWQob3V0LCBrZXk9bGFtYmRhIGx2OiBsdlswXSkKCgpkZWYgaW1z
#9#X2NoYW5uZWxfbmFtZXMoZiwgbl9jaCk6CiAgICAiIiJDaGFubmVsIGRpc3BsYXkgbmFtZXMgZnJv
#9#bSBEYXRhU2V0SW5mby9DaGFubmVsIHtpfTsgJycgd2hlbiBtaXNzaW5nIG9yIGEKICAgIGdlbmVy
#9#aWMgJ0NoYW5uZWwgTicgcGxhY2Vob2xkZXIsIHNvIHRoZSBjYWxsZXIgY2FuIGZhbGwgYmFjayBj
#9#bGVhbmx5LiIiIgogICAgaW5mbyA9IGYuZ2V0KCJEYXRhU2V0SW5mbyIsIHt9KQogICAgbmFtZXMg
#9#PSBbXQogICAgZm9yIGkgaW4gcmFuZ2Uobl9jaCk6CiAgICAgICAgY2ggPSBpbmZvLmdldChmIkNo
#9#YW5uZWwge2l9IikgaWYgaGFzYXR0cihpbmZvLCAiZ2V0IikgZWxzZSBOb25lCiAgICAgICAgbm0g
#9#PSByZS5zdWIociJceDAwLioiLCAiIiwgYXR0cl9zdHIoY2gsICJOYW1lIiwgIiIpKS5zdHJpcCgp
#9#IGlmIGNoIGlzIG5vdCBOb25lIGVsc2UgIiIKICAgICAgICBpZiByZS5tYXRjaChyIl5jaChhbm5l
#9#bCk/XHMqXGQrJCIsIG5tLCByZS5JR05PUkVDQVNFKToKICAgICAgICAgICAgbm0gPSAiIgogICAg
#9#ICAgIG5hbWVzLmFwcGVuZChubSkKICAgIHJldHVybiBuYW1lcwoKCmRlZiBjaG9vc2VfbGV2ZWwo
#9#bGV2ZWxzLCBuX2NoLCB0YXJnZXRfcHgsIG1heF9ieXRlcywgaXRlbXNpemU9Mik6CiAgICAiIiJM
#9#ZXZlbCB3aG9zZSBsb25nIFhZIHNpZGUgaXMgY2xvc2VzdCB0byB0YXJnZXRfcHgsIHN0ZXBwaW5n
#9#IHNtYWxsZXIgaWYgdGhlCiAgICBpbi1mbGlnaHQgdm9sdW1lIHdvdWxkIGV4Y2VlZCBtYXhfYnl0
#9#ZXMuIiIiCiAgICBjaG9zZW4gPSBtaW4obGV2ZWxzLCBrZXk9bGFtYmRhIGx2OiBhYnMobWF4KGx2
#9#WzFdLCBsdlsyXSkgLSB0YXJnZXRfcHgpKQogICAgd2hpbGUgY2hvc2VuWzFdICogY2hvc2VuWzJd
#9#ICogY2hvc2VuWzNdICogbl9jaCAqIGl0ZW1zaXplID4gbWF4X2J5dGVzOgogICAgICAgIHNtYWxs
#9#ZXIgPSBbbHYgZm9yIGx2IGluIGxldmVscyBpZiBsdlswXSA+IGNob3NlblswXV0KICAgICAgICBp
#9#ZiBub3Qgc21hbGxlcjoKICAgICAgICAgICAgYnJlYWsKICAgICAgICBjaG9zZW4gPSBtaW4oc21h
#9#bGxlciwga2V5PWxhbWJkYSBsdjogbHZbMF0pCiAgICByZXR1cm4gY2hvc2VuCgoKZGVmIHJhbXBf
#9#bHV0KHJnYik6CiAgICAiIiJCbGFja+KGkmNvbG91ciA4LWJpdCByYW1wLiBJbWFnZUogYXBwbGll
#9#cyBvbmUgcGVyIGNoYW5uZWwgaW4gY29tcG9zaXRlIG1vZGUsCiAgICBzbyB0aGUgZG93bmxvYWQg
#9#b3BlbnMgaW4gdGhlIHNhbWUgY29sb3VycyB0aGUgcGxhdGZvcm0gc2hvd3MuIiIiCiAgICBsdXQg
#9#PSBucC56ZXJvcygoMywgMjU2KSwgZHR5cGU9bnAudWludDgpCiAgICBmb3IgayBpbiByYW5nZSgz
#9#KToKICAgICAgICBsdXRba10gPSBucC5saW5zcGFjZSgwLCByZ2Jba10sIDI1NiwgZHR5cGU9bnAu
#9#dWludDgpCiAgICByZXR1cm4gbHV0CgoKZGVmIHJhbmdlX2Zyb21faGlzdChoaXN0LCBsb19wY3Q9
#9#MS4wLCBoaV9wY3Q9OTkuOSk6CiAgICAiIiJEaXNwbGF5IHJhbmdlIGZyb20gYW4gZXhhY3QgaW50
#9#ZW5zaXR5IGhpc3RvZ3JhbSDigJQgdGhlIHNhbWUgMXN04oCTOTkuOXRoCiAgICBwZXJjZW50aWxl
#9#IHdpbmRvdyBfYXV0b3NjYWxlIGdpdmVzIHRoZSBNSVAgUE5Hcywgc28gdGhlIHN0YWNrIG9wZW5z
#9#IGxvb2tpbmcKICAgIGxpa2UgdGhlbSBpbnN0ZWFkIG9mIGF0IHRoZSBkZXRlY3RvcidzIGZ1bGwg
#9#dGhlb3JldGljYWwgc3dlZXAuIiIiCiAgICB0b3RhbCA9IGludChoaXN0LnN1bSgpKQogICAgaWYg
#9#dG90YWwgPD0gMDoKICAgICAgICByZXR1cm4gMC4wLCAxLjAKICAgIGNkZiA9IG5wLmN1bXN1bSho
#9#aXN0KQogICAgbG8gPSBmbG9hdChucC5zZWFyY2hzb3J0ZWQoY2RmLCB0b3RhbCAqIGxvX3BjdCAv
#9#IDEwMC4wKSkKICAgIGhpID0gZmxvYXQobnAuc2VhcmNoc29ydGVkKGNkZiwgdG90YWwgKiBoaV9w
#9#Y3QgLyAxMDAuMCkpCiAgICBpZiBoaSA8PSBsbzoKICAgICAgICBueiA9IG5wLm5vbnplcm8oaGlz
#9#dClbMF0KICAgICAgICBsbywgaGkgPSAwLjAsIChmbG9hdChuelstMV0pIGlmIGxlbihueikgZWxz
#9#ZSAxLjApCiAgICByZXR1cm4gbG8sIG1heChoaSwgbG8gKyAxLjApCgoKZGVmIHRpZmZfaW5mbyhm
#9#b2xkZXIsIGxldmVsLCBjaF9uYW1lcywgdm94LCBkdHlwZSwgZnJhbWU9Tm9uZSk6CiAgICAiIiJG
#9#cmVlLXRleHQgYmxvY2sgc3VyZmFjZWQgYnkgRmlqaSdzIEltYWdlIOKWuCBTaG93IEluZm8uIGBm
#9#cmFtZWAgaXMKICAgICh0aW1lcG9pbnQgaW5kZXgsIHRpbWVwb2ludCBjb3VudCkgZm9yIG9uZSBm
#9#cmFtZSBvZiBhIHRpbWVsYXBzZS4iIiIKICAgIHJldHVybiAiXG4iLmpvaW4oWwogICAgICAgIGYi
#9#RGF0YXNldDoge2ZvbGRlcn0iLAogICAgICAgIGYiU291cmNlOiBJbWFyaXMgLmltcyBSZXNvbHV0
#9#aW9uTGV2ZWwge2xldmVsfSwgbmF0aXZlIHtkdHlwZX0iCiAgICAgICAgKyAoZiIsIHRpbWVwb2lu
#9#dCB7ZnJhbWVbMF19IG9mIDAuLntmcmFtZVsxXSAtIDF9IiBpZiBmcmFtZSBlbHNlICIiKSwKICAg
#9#ICAgICBmIlZveGVsIHNpemUgKHVtKTogWD17dm94WzBdOi42Z30gWT17dm94WzFdOi42Z30gWj17
#9#dm94WzJdOi42Z30iLAogICAgICAgICJDaGFubmVsczogIiArICIsICIuam9pbihmIkN7aSArIDF9
#9#PXtufSIgZm9yIGksIG4gaW4gZW51bWVyYXRlKGNoX25hbWVzKSksCiAgICAgICAgIlZveGVsIHZh
#9#bHVlcyBhcmUgdGhlIHJhdyBhY3F1aXNpdGlvbiBpbnRlbnNpdGllczsgb25seSB0aGUgc3RvcmVk
#9#ICIKICAgICAgICAiZGlzcGxheSByYW5nZSBpcyBzY2FsZWQgKEltYWdlID4gQWRqdXN0ID4gQnJp
#9#Z2h0bmVzcy9Db250cmFzdCkuIiwKICAgICAgICAiTHVtZW4zRCAvIElSSUJITSBNaWNyb3Njb3B5
#9#IFBsYXRmb3JtIiwKICAgIF0pCgoKY2xhc3MgVGlmZlRvb0xhcmdlKFJ1bnRpbWVFcnJvcik6CiAg
#9#ICAiIiJUaGUgd3JpdHRlbiBzdGFjayBvdmVyZmxvd2VkIHRoZSBJbWFnZUogZmxhdm91cidzIDMy
#9#LWJpdCBvZmZzZXRzLiIiIgoKCmRlZiB3cml0ZV9pbWFnZWpfdGlmZihwYXRoLCB2b2wsIHZveCwg
#9#bWV0YWRhdGEpOgogICAgIiIiV3JpdGUgdGhlIGNvbXBvc2l0ZSBoeXBlcnN0YWNrLCByZWZ1c2lu
#9#ZyBhIHNpbGVudGx5IHRydW5jYXRlZCBmaWxlOiB0aGUKICAgIEltYWdlSiBmbGF2b3VyIGlzIGNs
#9#YXNzaWMgVElGRiAoMzItYml0IG9mZnNldHMpLCBhbmQgcGFzdCB+NCBHaUIgdGlmZmZpbGUKICAg
#9#IHdhcm5zIGFuZCBrZWVwcyBvbmx5IHRoZSBmaXJzdCBJRkQsIHdoaWNoIG5vIHJlYWRlciBjYW4g
#9#b3Blbi4iIiIKICAgIGltcG9ydCB0aWZmZmlsZQogICAgd2l0aCB3YXJuaW5ncy5jYXRjaF93YXJu
#9#aW5ncyhyZWNvcmQ9VHJ1ZSkgYXMgY2F1Z2h0OgogICAgICAgIHdhcm5pbmdzLnNpbXBsZWZpbHRl
#9#cigiYWx3YXlzIikKICAgICAgICB0aWZmZmlsZS5pbXdyaXRlKAogICAgICAgICAgICBzdHIocGF0
#9#aCksIHZvbCwgaW1hZ2VqPVRydWUsIHBob3RvbWV0cmljPSJtaW5pc2JsYWNrIiwKICAgICAgICAg
#9#ICAgY29tcHJlc3Npb249InpsaWIiLAogICAgICAgICAgICByZXNvbHV0aW9uPSgxLjAgLyAodm94
#9#WzBdIG9yIDEuMCksIDEuMCAvICh2b3hbMV0gb3IgMS4wKSksCiAgICAgICAgICAgIHJlc29sdXRp
#9#b251bml0PSJOT05FIiwgbWV0YWRhdGE9bWV0YWRhdGEsCiAgICAgICAgKQogICAgZm9yIHcgaW4g
#9#Y2F1Z2h0OgogICAgICAgIGlmICJ0cnVuY2F0IiBpbiBzdHIody5tZXNzYWdlKS5sb3dlcigpOgog
#9#ICAgICAgICAgICBwYXRoLnVubGluayhtaXNzaW5nX29rPVRydWUpCiAgICAgICAgICAgIHJhaXNl
#9#IFRpZmZUb29MYXJnZShzdHIody5tZXNzYWdlKSkKCgpkZWYgX3RpbWVwb2ludF9jb3VudChmKSAt
#9#PiBpbnQ6CiAgICByZXMwID0gZlsiRGF0YVNldCJdWyJSZXNvbHV0aW9uTGV2ZWwgMCJdCiAgICBy
#9#ZXR1cm4gc3VtKDEgZm9yIGsgaW4gcmVzMC5rZXlzKCkgaWYgay5zdGFydHN3aXRoKCJUaW1lUG9p
#9#bnQiKSkgb3IgMQoKCmRlZiBfc2xhYl9wbGFuZXMoZGF0YSwgenIpIC0+IGludDoKICAgICIiIlBs
#9#YW5lcyByZWFkIHBlciBIREY1IGNhbGw6IG9uZSBjaHVuayBsYXllciwgc28gZWFjaCBjb21wcmVz
#9#c2VkIGNodW5rIGlzCiAgICBkZWNvbXByZXNzZWQgb25jZSBpbnN0ZWFkIG9mIG9uY2UgcGVyIHBs
#9#YW5lIGl0IHNwYW5zLiIiIgogICAgY2h1bmtzID0gZ2V0YXR0cihkYXRhLCAiY2h1bmtzIiwgTm9u
#9#ZSkKICAgIHJldHVybiBtYXgoMSwgbWluKHpyLCBjaHVua3NbMF0gaWYgY2h1bmtzIGVsc2UgMTYp
#9#KQoKCmRlZiBidWlsZF90aWZmX2FuZF9taXBzKGltc19zcmMsIGRzX2RpciwgZm9sZGVyLCBjaGFu
#9#bmVsc19tZXRhLCB0aWZmX3BhdGgsCiAgICAgICAgICAgICAgICAgICAgICAgIG1pcF9wYXRoc19m
#9#b3IsIHdhbnRfdGlmZiwgd2FudF9taXAsIGZvcmNlLCBkcnksIHRpbWVwb2ludD0wKToKICAgICIi
#9#IlJldHVybnMgYSBzdGF0dXMgc3RyaW5nLiBSZWFkcyBPTkUgcHlyYW1pZCBsZXZlbCAo4omIVEFS
#9#R0VUX1BYKSBvZiBPTkUgdGltZXBvaW50LAogICAgc3RyZWFtcyBpdCBpbnRvIGEgZGlzay1iYWNr
#9#ZWQgbWVtbWFwIGluIHRoZSBzeXN0ZW0gdGVtcCBkaXIgKGxvdyBSQU0sIG5ldmVyIGxpdHRlcnMK
#9#ICAgIGRvd25sb2FkLyksIHdyaXRlcyBhIGNhbGlicmF0ZWQgSW1hZ2VKIGNvbXBvc2l0ZSBoeXBl
#9#cnN0YWNrLCBhbmQgZW1pdHMgcGVyLWNoYW5uZWwKICAgIE1JUCBQTkdzLiIiIgogICAgaW1wb3J0
#9#IGg1cHkKCiAgICB0aWZmX2RvbmUgPSB0aWZmX3BhdGguZXhpc3RzKCkgYW5kIG5vdCBmb3JjZQog
#9#ICAgaWYgZHJ5OgogICAgICAgIHJldHVybiAid291bGQgYnVpbGQgdGlmZittaXBzIgoKICAgIHdp
#9#dGggaDVweS5GaWxlKHN0cihpbXNfc3JjKSwgInIiLCByZGNjX25ieXRlcz02NCAqIDEwMjQgKiAx
#9#MDI0KSBhcyBmOgogICAgICAgIGluZm8gPSBmLmdldCgiRGF0YVNldEluZm8iLCB7fSkuZ2V0KCJJ
#9#bWFnZSIsIE5vbmUpCiAgICAgICAgbl90cCA9IF90aW1lcG9pbnRfY291bnQoZikKICAgICAgICBp
#9#ZiBub3QgMCA8PSB0aW1lcG9pbnQgPCBuX3RwOgogICAgICAgICAgICByZXR1cm4gZiJ0aW1lcG9p
#9#bnQge3RpbWVwb2ludH0gb3V0IG9mIHJhbmdlICgwLi57bl90cCAtIDF9KSIKICAgICAgICBmcmFt
#9#ZSA9ICh0aW1lcG9pbnQsIG5fdHApIGlmIG5fdHAgPiAxIGVsc2UgTm9uZQogICAgICAgIGxldmVs
#9#cyA9IGxpc3RfbGV2ZWxzKGYsIHRpbWVwb2ludCkKICAgICAgICBpZiBub3QgbGV2ZWxzOgogICAg
#9#ICAgICAgICByZXR1cm4gIm5vIHJlc29sdXRpb24gbGV2ZWxzIgogICAgICAgIHRwMCA9IGZbIkRh
#9#dGFTZXQiXVsiUmVzb2x1dGlvbkxldmVsIDAiXVtmIlRpbWVQb2ludCB7dGltZXBvaW50fSJdCiAg
#9#ICAgICAgY2hfa2V5cyA9IHNvcnRlZChbayBmb3IgayBpbiB0cDAua2V5cygpIGlmIGsuc3RhcnRz
#9#d2l0aCgiQ2hhbm5lbCIpXSwKICAgICAgICAgICAgICAgICAgICAgICAgIGtleT1sYW1iZGEgczog
#9#aW50KHMuc3BsaXQoKVstMV0pKQogICAgICAgIG5fY2ggPSBsZW4oY2hfa2V5cykKCiAgICAgICAg
#9#IyBDaGFubmVsIG5hbWVzOiBwcmVmZXIgdGhlIGN1cmF0ZWQgY2F0YWxvZyBuYW1lLCBlbHNlIHRo
#9#ZSAuaW1zIG5hbWUsCiAgICAgICAgIyBlbHNlIGEgZ2VuZXJpYyBwbGFjZWhvbGRlci4gQ29sb3Vy
#9#cyBjb21lIGZyb20gdGhlIGNhdGFsb2cgd2hlbiBwcmVzZW50LgogICAgICAgIGNhdCA9IF9wYWQo
#9#Y2hhbm5lbHNfbWV0YSwgbl9jaCkKICAgICAgICBpbXNfbmFtZXMgPSBpbXNfY2hhbm5lbF9uYW1l
#9#cyhmLCBuX2NoKQogICAgICAgIGNoX25hbWVzID0gWyhjYXRbaV0uZ2V0KCJuYW1lIikgb3IgaW1z
#9#X25hbWVzW2ldIG9yIGYiQ2hhbm5lbCB7aSsxfSIpIGZvciBpIGluIHJhbmdlKG5fY2gpXQoKICAg
#9#ICAgICAjIFRoZSBhY3F1aXNpdGlvbidzIGJpdCBkZXB0aCBpcyBwcmVzZXJ2ZWQuIFByb21vdGlu
#9#ZyBhbiA4LWJpdCBhY3F1aXNpdGlvbgogICAgICAgICMgdG8gdWludDE2IGxlYXZlcyBldmVyeSB2
#9#YWx1ZSBpbiB0aGUgYm90dG9tIDAuNCUgb2YgdGhlIHJhbmdlLCB3aGljaCBhbnkKICAgICAgICAj
#9#IHJlYWRlciB0aGF0IHRydXN0cyB0aGUgZGVjbGFyZWQgZGVwdGggcmVuZGVycyBhcyBibGFjay4K
#9#ICAgICAgICBkdHlwZSA9IG5wLmR0eXBlKHRwMFtjaF9rZXlzWzBdXVsiRGF0YSJdLmR0eXBlKQoK
#9#ICAgICAgICBuZWVkX3ZvbCA9IHdhbnRfdGlmZiBhbmQgbm90IHRpZmZfZG9uZQogICAgICAgIGlm
#9#IG5vdCBuZWVkX3ZvbCBhbmQgbm90IHdhbnRfbWlwOgogICAgICAgICAgICByZXR1cm4gInRpZmYg
#9#c2tpcCAoZXhpc3RzKSIgaWYgd2FudF90aWZmIGVsc2UgIm5vdGhpbmcgdG8gZG8iCgogICAgICAg
#9#ICMgUGh5c2ljYWwgZXh0ZW50IGlzIGxldmVsLWluZGVwZW5kZW50IOKGkiB2b3hlbCBzaXplID0g
#9#ZXh0ZW50IC8gbGV2ZWwgZGltcy4KICAgICAgICBleHQgPSBsYW1iZGEgbG8sIGhpOiAoYXR0cl9m
#9#bG9hdChpbmZvLCBoaSwgMS4wKSAtIGF0dHJfZmxvYXQoaW5mbywgbG8sIDAuMCkpCgogICAgICAg
#9#ICMgQmVzdCBsZXZlbCBmaXJzdCwgdGhlbiBldmVyeSBjb2Fyc2VyIG9uZS4gV2hldGhlciB0aGUg
#9#Y29tcHJlc3NlZCBzdGFjawogICAgICAgICMgY2xlYXJzIHRoZSBjbGFzc2ljLVRJRkYgb2Zmc2V0
#9#IGxpbWl0IGlzIG9ubHkga25vd2FibGUgYWZ0ZXIgd3JpdGluZyBpdCwKICAgICAgICAjIHNvIGFu
#9#IG92ZXJmbG93IHN0ZXBzIGRvd24gaW5zdGVhZCBvZiBsZWF2aW5nIHRoZSBkYXRhc2V0IHdpdGgg
#9#bm8gVElGRi4KICAgICAgICBiZXN0ID0gY2hvb3NlX2xldmVsKGxldmVscywgbl9jaCwgVEFSR0VU
#9#X1BYLCBNQVhfVElGRl9CWVRFUywgZHR5cGUuaXRlbXNpemUpCiAgICAgICAgY2FuZGlkYXRlcyA9
#9#IFtsdiBmb3IgbHYgaW4gbGV2ZWxzIGlmIGx2WzBdID49IGJlc3RbMF1dCgogICAgICAgICMgRXhh
#9#Y3QgcGVyLWNoYW5uZWwgaGlzdG9ncmFtIOKGkiBkaXNwbGF5IHJhbmdlLiBPbmx5IHRoZSBpbnRl
#9#Z2VyIHR5cGVzIGdldAogICAgICAgICMgb25lOyBJbWFnZUogYWxyZWFkeSBhdXRvLXNjYWxlcyBm
#9#bG9hdCBpbWFnZXMgd2hlbiBpdCBvcGVucyB0aGVtLgogICAgICAgIG5iaW5zID0gKDEgPDwgKDgg
#9#KiBkdHlwZS5pdGVtc2l6ZSkpIGlmIGR0eXBlLmtpbmQgPT0gInUiIGFuZCBkdHlwZS5pdGVtc2l6
#9#ZSA8PSAyIGVsc2UgMAoKICAgICAgICBzdGF0dXMsIG1pcHMgPSBbXSwgW10KICAgICAgICBmb3Ig
#9#YXR0ZW1wdCwgKEwsIFhyLCBZciwgWnIpIGluIGVudW1lcmF0ZShjYW5kaWRhdGVzKToKICAgICAg
#9#ICAgICAgdm94ID0gKAogICAgICAgICAgICAgICAgZXh0KCJFeHRNaW4wIiwgIkV4dE1heDAiKSAv
#9#IG1heChYciwgMSksCiAgICAgICAgICAgICAgICBleHQoIkV4dE1pbjEiLCAiRXh0TWF4MSIpIC8g
#9#bWF4KFlyLCAxKSwKICAgICAgICAgICAgICAgIGV4dCgiRXh0TWluMiIsICJFeHRNYXgyIikgLyBt
#9#YXgoWnIsIDEpLAogICAgICAgICAgICApCiAgICAgICAgICAgIGJhc2UgPSBmWyJEYXRhU2V0Il1b
#9#ZiJSZXNvbHV0aW9uTGV2ZWwge0x9Il1bZiJUaW1lUG9pbnQge3RpbWVwb2ludH0iXQogICAgICAg
#9#ICAgICBoaXN0cyA9IChbbnAuemVyb3MobmJpbnMsIGR0eXBlPW5wLmludDY0KSBmb3IgXyBpbiBy
#9#YW5nZShuX2NoKV0KICAgICAgICAgICAgICAgICAgICAgaWYgbmVlZF92b2wgYW5kIG5iaW5zIGVs
#9#c2UgTm9uZSkKICAgICAgICAgICAgdG1wX2RpciA9IFBhdGgodGVtcGZpbGUubWtkdGVtcChwcmVm
#9#aXg9Imx1bWVuX2J1bmRsZV8iKSkKICAgICAgICAgICAgYXJyLCBtaXBzID0gTm9uZSwgW10KICAg
#9#ICAgICAgICAgdHJ5OgogICAgICAgICAgICAgICAgaWYgbmVlZF92b2w6CiAgICAgICAgICAgICAg
#9#ICAgICAgIyBJbWFnZUogaHlwZXJzdGFjayBheGlzIG9yZGVyIGlzIFRaQ1lYIOKGkiAoWiwgQywg
#9#WSwgWCkgYXQgVD0xLgogICAgICAgICAgICAgICAgICAgIGFyciA9IG5wLm1lbW1hcCh0bXBfZGly
#9#IC8gZiJ7Zm9sZGVyfS52b2wuZGF0IiwgZHR5cGU9ZHR5cGUsCiAgICAgICAgICAgICAgICAgICAg
#9#ICAgICAgICAgICAgICAgIG1vZGU9IncrIiwgc2hhcGU9KFpyLCBuX2NoLCBZciwgWHIpKQogICAg
#9#ICAgICAgICAgICAgZm9yIGNpLCBjayBpbiBlbnVtZXJhdGUoY2hfa2V5cyk6CiAgICAgICAgICAg
#9#ICAgICAgICAgZGF0YSA9IGJhc2VbY2tdWyJEYXRhIl0KICAgICAgICAgICAgICAgICAgICBtaXAg
#9#PSBucC56ZXJvcygoWXIsIFhyKSwgZHR5cGU9ZHR5cGUpCiAgICAgICAgICAgICAgICAgICAgc3Rl
#9#cCA9IF9zbGFiX3BsYW5lcyhkYXRhLCBacikKICAgICAgICAgICAgICAgICAgICBmb3IgejAgaW4g
#9#cmFuZ2UoMCwgWnIsIHN0ZXApOiAgICAgICAgIyBvbmUgY2h1bmsgbGF5ZXIgYXQgYSB0aW1lIOKG
#9#kiBsb3cgUkFNCiAgICAgICAgICAgICAgICAgICAgICAgIHNsYWIgPSBkYXRhW3owOm1pbih6MCAr
#9#IHN0ZXAsIFpyKSwgOllyLCA6WHJdCiAgICAgICAgICAgICAgICAgICAgICAgIGZvciBrLCBwbGFu
#9#ZSBpbiBlbnVtZXJhdGUoc2xhYik6CiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiBhcnIg
#9#aXMgbm90IE5vbmU6CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXJyW3owICsgaywg
#9#Y2ldID0gcGxhbmUKICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5wLm1heGltdW0obWlwLCBw
#9#bGFuZSwgb3V0PW1pcCkgICMgTUlQIGFjY3J1ZXMgaW4gdGhlIHNhbWUgcGFzcwogICAgICAgICAg
#9#ICAgICAgICAgICAgICAgICAgaWYgaGlzdHMgaXMgbm90IE5vbmU6CiAgICAgICAgICAgICAgICAg
#9#ICAgICAgICAgICAgICAgaGlzdHNbY2ldICs9IG5wLmJpbmNvdW50KHBsYW5lLnJhdmVsKCksIG1p
#9#bmxlbmd0aD1uYmlucykKICAgICAgICAgICAgICAgICAgICAgICAgZGVsIHNsYWIKICAgICAgICAg
#9#ICAgICAgICAgICBtaXBzLmFwcGVuZChtaXApCgogICAgICAgICAgICAgICAgaWYgbm90IG5lZWRf
#9#dm9sOgogICAgICAgICAgICAgICAgICAgIGJyZWFrICAgICAgICAgICAgICAgICAgICAgICAgICAg
#9#ICAgICMgTUlQLW9ubHk6IG5vdGhpbmcgdG8gd3JpdGUKICAgICAgICAgICAgICAgIGFyci5mbHVz
#9#aCgpCgogICAgICAgICAgICAgICAgcmFuZ2VzLCBsdXRzID0gW10sIFtdCiAgICAgICAgICAgICAg
#9#ICBmb3IgY2kgaW4gcmFuZ2Uobl9jaCk6CiAgICAgICAgICAgICAgICAgICAgbHV0cy5hcHBlbmQo
#9#cmFtcF9sdXQoaGV4X3RvX3JnYihjYXRbY2ldLmdldCgiY29sb3IiKSwKICAgICAgICAgICAgICAg
#9#ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFRIVU1CX0NPTE9SU1tjaSAlIGxl
#9#bihUSFVNQl9DT0xPUlMpXSkpKQogICAgICAgICAgICAgICAgICAgIGlmIGhpc3RzIGlzIG5vdCBO
#9#b25lOgogICAgICAgICAgICAgICAgICAgICAgICByYW5nZXMuZXh0ZW5kKHJhbmdlX2Zyb21faGlz
#9#dChoaXN0c1tjaV0pKQogICAgICAgICAgICAgICAgbWV0YSA9IHsKICAgICAgICAgICAgICAgICAg
#9#ICAiYXhlcyI6ICJaQ1lYIiwgInNwYWNpbmciOiB2b3hbMl0sICJ1bml0IjogInVtIiwKICAgICAg
#9#ICAgICAgICAgICAgICAibW9kZSI6ICJjb21wb3NpdGUiLCAiTFVUcyI6IGx1dHMsCiAgICAgICAg
#9#ICAgICAgICAgICAgIkxhYmVscyI6IFtjaF9uYW1lc1tjXSBmb3IgXyBpbiByYW5nZShacikgZm9y
#9#IGMgaW4gcmFuZ2Uobl9jaCldLAogICAgICAgICAgICAgICAgICAgICJJbmZvIjogdGlmZl9pbmZv
#9#KGZvbGRlciwgTCwgY2hfbmFtZXMsIHZveCwgZHR5cGUsIGZyYW1lKSwKICAgICAgICAgICAgICAg
#9#IH0KICAgICAgICAgICAgICAgIGlmIHJhbmdlczoKICAgICAgICAgICAgICAgICAgICBtZXRhWyJS
#9#YW5nZXMiXSA9IHR1cGxlKHJhbmdlcykKICAgICAgICAgICAgICAgIHRtcF90aWYgPSB0aWZmX3Bh
#9#dGgud2l0aF9zdWZmaXgoIi50aWYudG1wIikKICAgICAgICAgICAgICAgIHRyeToKICAgICAgICAg
#9#ICAgICAgICAgICB3cml0ZV9pbWFnZWpfdGlmZih0bXBfdGlmLCBucC5hc2FycmF5KGFyciksIHZv
#9#eCwgbWV0YSkKICAgICAgICAgICAgICAgIGV4Y2VwdCBUaWZmVG9vTGFyZ2UgYXMgZXhjOgogICAg
#9#ICAgICAgICAgICAgICAgIGlmIGF0dGVtcHQgKyAxID49IGxlbihjYW5kaWRhdGVzKToKICAgICAg
#9#ICAgICAgICAgICAgICAgICAgcmFpc2UgUnVudGltZUVycm9yKAogICAgICAgICAgICAgICAgICAg
#9#ICAgICAgICAgZiJubyBweXJhbWlkIGxldmVsIGZpdHMgYW4gSW1hZ2VKIFRJRkYgKHtleGN9KSIp
#9#IGZyb20gZXhjCiAgICAgICAgICAgICAgICAgICAgcHJpbnQoZiIgIFt0aWZmXSBMe0x9IHtYcn14
#9#e1lyfXh7WnJ9IG92ZXJmbG93cyB0aGUgSW1hZ2VKIFRJRkYgIgogICAgICAgICAgICAgICAgICAg
#9#ICAgICAgIGYib2Zmc2V0IGxpbWl0IOKAlCByZXRyeWluZyBvbmUgbGV2ZWwgY29hcnNlciIpCiAg
#9#ICAgICAgICAgICAgICAgICAgY29udGludWUKICAgICAgICAgICAgICAgIG9zLnJlcGxhY2UodG1w
#9#X3RpZiwgdGlmZl9wYXRoKQogICAgICAgICAgICAgICAgc3RhdHVzLmFwcGVuZChmInRpZmYgTHtM
#9#fSB7WHJ9eHtZcn14e1pyfSB7ZHR5cGV9ICIKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg
#9#KyAoZiJ0e3RpbWVwb2ludH0gIiBpZiBmcmFtZSBlbHNlICIiKQogICAgICAgICAgICAgICAgICAg
#9#ICAgICAgICAgICArIGYie2ZtdF9zaXplKHRpZmZfcGF0aC5zdGF0KCkuc3Rfc2l6ZSl9IikKICAg
#9#ICAgICAgICAgICAgIGJyZWFrCiAgICAgICAgICAgIGZpbmFsbHk6CiAgICAgICAgICAgICAgICAj
#9#IFdpbmRvd3MgcmVmdXNlcyB0byB1bmxpbmsgYSBmaWxlIHRoYXQgaXMgc3RpbGwgbWFwcGVkLCBh
#9#bmQgYQogICAgICAgICAgICAgICAgIyByYWlzZWQgZXhjZXB0aW9uIGtlZXBzIHRoZSBucC5hc2Fy
#9#cmF5KCkgdmlldyBhbGl2ZSBpbiBpdHMKICAgICAgICAgICAgICAgICMgdHJhY2ViYWNrIOKAlCBz
#9#byBkcm9wIHRoZSBtYXBwaW5nIGV4cGxpY2l0bHkgb3IgdGhlIG11bHRpLUdpQgogICAgICAgICAg
#9#ICAgICAgIyBzY3JhdGNoIGZpbGUgc3Vydml2ZXMgdGhlIHJ1bi4KICAgICAgICAgICAgICAgIGlm
#9#IGFyciBpcyBub3QgTm9uZToKICAgICAgICAgICAgICAgICAgICB0cnk6CiAgICAgICAgICAgICAg
#9#ICAgICAgICAgIGFyci5fbW1hcC5jbG9zZSgpCiAgICAgICAgICAgICAgICAgICAgZXhjZXB0IEV4
#9#Y2VwdGlvbjoKICAgICAgICAgICAgICAgICAgICAgICAgcGFzcwogICAgICAgICAgICAgICAgZGVs
#9#IGFycgogICAgICAgICAgICAgICAgc2h1dGlsLnJtdHJlZSh0bXBfZGlyLCBpZ25vcmVfZXJyb3Jz
#9#PVRydWUpCgogICAgICAgIGlmIHdhbnRfdGlmZiBhbmQgbm90IG5lZWRfdm9sOgogICAgICAgICAg
#9#ICBzdGF0dXMuYXBwZW5kKCJ0aWZmIHNraXAgKGV4aXN0cykiKQoKICAgICAgICBpZiB3YW50X21p
#9#cDoKICAgICAgICAgICAgZnJvbSBQSUwgaW1wb3J0IEltYWdlCiAgICAgICAgICAgIG1hZGUgPSAw
#9#CiAgICAgICAgICAgIGZvciBjaSwgbWlwIGluIGVudW1lcmF0ZShtaXBzKToKICAgICAgICAgICAg
#9#ICAgIG91dCA9IG1pcF9wYXRoc19mb3IoY2ksIGNoX25hbWVzW2NpXSkKICAgICAgICAgICAgICAg
#9#IGlmIG91dC5leGlzdHMoKSBhbmQgbm90IGZvcmNlOgogICAgICAgICAgICAgICAgICAgIGNvbnRp
#9#bnVlCiAgICAgICAgICAgICAgICByZ2IgPSBoZXhfdG9fcmdiKGNhdFtjaV0uZ2V0KCJjb2xvciIp
#9#LCBUSFVNQl9DT0xPUlNbY2kgJSBsZW4oVEhVTUJfQ09MT1JTKV0pCiAgICAgICAgICAgICAgICBu
#9#b3JtID0gX2F1dG9zY2FsZShtaXApICAgICAgICAgICAgICAgICAgIyAwLi4xIGZsb2F0CiAgICAg
#9#ICAgICAgICAgICBpbWcgPSBucC56ZXJvcygobWlwLnNoYXBlWzBdLCBtaXAuc2hhcGVbMV0sIDMp
#9#LCBkdHlwZT1ucC51aW50OCkKICAgICAgICAgICAgICAgIGZvciBrIGluIHJhbmdlKDMpOgogICAg
#9#ICAgICAgICAgICAgICAgIGltZ1s6LCA6LCBrXSA9IG5wLmNsaXAobm9ybSAqIHJnYltrXSwgMCwg
#9#MjU1KS5hc3R5cGUobnAudWludDgpCiAgICAgICAgICAgICAgICBJbWFnZS5mcm9tYXJyYXkoaW1n
#9#LCAiUkdCIikuc2F2ZShzdHIob3V0KSkKICAgICAgICAgICAgICAgIG1hZGUgKz0gMQogICAgICAg
#9#ICAgICBzdGF0dXMuYXBwZW5kKGYie21hZGV9IE1JUCBwbmciKQogICAgICAgIHJldHVybiAiOyAi
#9#LmpvaW4oc3RhdHVzKSBvciAibm90aGluZyB0byBkbyIKCgpkZWYgX3BhZChjaGFubmVsc19tZXRh
#9#LCBuKToKICAgIGNtID0gbGlzdChjaGFubmVsc19tZXRhIG9yIFtdKQogICAgd2hpbGUgbGVuKGNt
#9#KSA8IG46CiAgICAgICAgY20uYXBwZW5kKHt9KQogICAgcmV0dXJuIGNtCgoKZGVmIF9hdXRvc2Nh
#9#bGUocGxhbmUpOgogICAgIiIiUm9idXN0IDAuLjEgbm9ybWFsaXNhdGlvbiAoMXN04oCTOTkuOXRo
#9#IHBlcmNlbnRpbGUpIGZvciBhIE1JUCBvZiBhbnkgZGVwdGguIiIiCiAgICBwID0gcGxhbmUuYXN0
#9#eXBlKG5wLmZsb2F0MzIpCiAgICBsbyA9IGZsb2F0KG5wLnBlcmNlbnRpbGUocCwgMS4wKSkKICAg
#9#IGhpID0gZmxvYXQobnAucGVyY2VudGlsZShwLCA5OS45KSkKICAgIGlmIGhpIDw9IGxvOgogICAg
#9#ICAgIGhpID0gZmxvYXQocC5tYXgoKSkgb3IgMS4wCiAgICAgICAgbG8gPSAwLjAKICAgIHJldHVy
#9#biBucC5jbGlwKChwIC0gbG8pIC8gKGhpIC0gbG8pLCAwLjAsIDEuMCkKCgojIOKUgOKUgCBTdGVw
#9#IDUg4oCUIFJFQURNRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#9#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#9#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#9#lIDilIDilIDilIDilIAKZGVmIHdyaXRlX3JlYWRtZShvdXRfcGF0aCwgZHMsIGltc19zcmMsIGZv
#9#cmNlLCBkcnksIHRpbWVwb2ludD0wKToKICAgIGlmIG91dF9wYXRoLmV4aXN0cygpIGFuZCBub3Qg
#9#Zm9yY2U6CiAgICAgICAgcmV0dXJuICJza2lwIChleGlzdHMpIgogICAgaWYgZHJ5OgogICAgICAg
#9#IHJldHVybiAid291bGQgd3JpdGUiCiAgICBsaW5lcyA9IF9yZWFkbWVfcGhvdG8oZHMpIGlmIGRz
#9#WyJ0eXBlIl0gPT0gIjJkIiBlbHNlIF9yZWFkbWVfdm9sdW1lKGRzLCBpbXNfc3JjLCB0aW1lcG9p
#9#bnQpCiAgICBsaW5lcyArPSBbCiAgICAgICAgIiIsCiAgICAgICAgIkNpdGF0aW9uOiBjaXRlIHRo
#9#ZSBJUklCSE0gTWljcm9zY29weSBQbGF0Zm9ybSAoTHVtZW4zRCwgSVJJQkhNIEAgVUxCKSBhbmQg
#9#IgogICAgICAgICJ0aGUgb3JpZ2luYWwgZXhwZXJpbWVudC9wdWJsaWNhdGlvbiB3aGVuIGF2YWls
#9#YWJsZS4iLAogICAgICAgIGYiR2VuZXJhdGVkOiB7dGltZS5zdHJmdGltZSgnJVktJW0tJWQgJUg6
#9#JU06JVMnKX0iLAogICAgXQogICAgb3V0X3BhdGgud3JpdGVfdGV4dCgiXG4iLmpvaW4obGluZXMp
#9#LCBlbmNvZGluZz0idXRmLTgiKQogICAgcmV0dXJuICJvayIKCgpkZWYgX3JlYWRtZV9waG90byhk
#9#cyk6CiAgICAiIiJBICcyZCcgZGF0YXNldCBpcyBvbmUgY2FsaWJyYXRlZCBwaG90b2dyYXBoOiBu
#9#byB2b3hlbHMsIG5vIGNoYW5uZWxzLCBhbmQgbm8KICAgIC5pbXMgdG8gcmUtcmVhZCDigJQgdGhl
#9#IG9yaWdpbmFsIFRJRkYgYmVzaWRlIGl0IGNvbWVzIGZyb20gdGhlIGltcG9ydGVyLiIiIgogICAg
#9#bWV0YSA9IGRzWyJtZXRhIl0KICAgIGRpbXMgPSBtZXRhLmdldCgiZGltZW5zaW9ucyIsIHt9KQog
#9#ICAgcHggPSAobWV0YS5nZXQoInBpeGVsU2l6ZVVtIikgb3Ige30pLmdldCgieCIpCiAgICBhY3Eg
#9#PSBtZXRhLmdldCgiYWNxdWlzaXRpb24iLCB7fSkKICAgIHJldHVybiBbCiAgICAgICAgZiJEYXRh
#9#c2V0IDoge2RzWydmb2xkZXInXX0iLAogICAgICAgIGYiVHlwZSAgICA6IHtkc1sndHlwZSddfSAo
#9#Y2FsaWJyYXRlZCBwaG90b2dyYXBoKSIsCiAgICAgICAgZiJTdGFnZSAgIDoge21ldGEuZ2V0KCdz
#9#dGFnZScsICc/Jyl9ICAgIExpbmU6IHttZXRhLmdldCgnbGluZScpIG9yICc/J30iCiAgICAgICAg
#9#ZiIgICAgU3RhaW5pbmc6IHttZXRhLmdldCgnc3RhaW5pbmcnKSBvciAnPyd9IiwKICAgICAgICAi
#9#IiwKICAgICAgICBmIkltYWdlICAgICAgOiB7ZGltcy5nZXQoJ3gnLCc/Jyl9IHgge2RpbXMuZ2V0
#9#KCd5JywnPycpfSBweCwgUkdCIDgtYml0IiwKICAgICAgICAiUGl4ZWwgc2l6ZSA6ICIgKyAoZiJ7
#9#cHg6LjRmfSB1bS9weCIgaWYgaXNpbnN0YW5jZShweCwgKGludCwgZmxvYXQpKSBlbHNlICJ1bmtu
#9#b3duIiksCiAgICAgICAgZiJNaWNyb3Njb3BlIDoge2FjcS5nZXQoJ21pY3Jvc2NvcGUnKSBvciAn
#9#LSd9ICAgIGNhbWVyYSB7YWNxLmdldCgnY2FtZXJhJykgb3IgJy0nfSIsCiAgICAgICAgZiJTb3Vy
#9#Y2UgICAgIDoge2FjcS5nZXQoJ3NvdXJjZUZpbGUnKSBvciAnLSd9IiwKICAgICAgICAiIiwKICAg
#9#ICAgICAiRmlsZXMgaW4gdGhpcyBmb2xkZXI6IiwKICAgICAgICBmIiAge2RzWydmb2xkZXInXX1f
#9#d2ViLnppcCAgIGFyY2hpdmUgb2YgdGhlIHdlYiBkYXRhc2V0ICIKICAgICAgICAiKGltYWdlLndl
#9#YnAgKyBwcmV2aWV3LndlYnAgKyB0aHVtYm5haWwgKyBtZXRhZGF0YSkiLAogICAgICAgICIgIDxv
#9#cmlnaW5hbD4udGlmICAgICAgICAgICB1bnRvdWNoZWQgSW1hZ2VKL0xlaWNhIGV4cG9ydCwgcHJl
#9#c2VudCB3aGVuIHRoZSAiCiAgICAgICAgImltcG9ydCByYW4gd2l0aCAtLXdpdGgtZG93bmxvYWRz
#9#IiwKICAgIF0KCgpkZWYgX3JlYWRtZV92b2x1bWUoZHMsIGltc19zcmMsIHRpbWVwb2ludD0wKToK
#9#ICAgIG1ldGEgPSBkc1sibWV0YSJdCiAgICBkaW1zID0gbWV0YS5nZXQoImRpbWVuc2lvbnMiLCB7
#9#fSkKICAgIHZveCA9IG1ldGEuZ2V0KCJ2b3hlbF9zaXplIiwge30pCiAgICBjaGFucyA9IG1ldGEu
#9#Z2V0KCJjaGFubmVscyIsIFtdKQogICAgbGluZXMgPSBbCiAgICAgICAgZiJEYXRhc2V0IDoge2Rz
#9#Wydmb2xkZXInXX0iLAogICAgICAgIGYiVHlwZSAgICA6IHtkc1sndHlwZSddfSIsCiAgICAgICAg
#9#ZiJTdGFnZSAgIDoge21ldGEuZ2V0KCdzdGFnZScsICc/Jyl9ICAgIEVtYnJ5bzoge21ldGEuZ2V0
#9#KCdlbWJyeW8nLCAnPycpfSIsCiAgICAgICAgIiIsCiAgICAgICAgIkRpbWVuc2lvbnMgKHZveGVs
#9#cykgOiAiCiAgICAgICAgZiJYPXtkaW1zLmdldCgneCcsJz8nKX0gIFk9e2RpbXMuZ2V0KCd5Jywn
#9#PycpfSAgWj17ZGltcy5nZXQoJ3onLCc/Jyl9ICAiCiAgICAgICAgZiJDPXtkaW1zLmdldCgnYycs
#9#Jz8nKX0gIFQ9e2RpbXMuZ2V0KCd0JywnPycpfSIsCiAgICAgICAgIlZveGVsIHNpemUgKMK1bSkg
#9#ICAgIDogIgogICAgICAgIGYiWD17dm94LmdldCgneCcsJz8nKX0gIFk9e3ZveC5nZXQoJ3knLCc/
#9#Jyl9ICBaPXt2b3guZ2V0KCd6JywnPycpfSIsCiAgICAgICAgIiIsCiAgICAgICAgIkNoYW5uZWxz
#9#OiIsCiAgICBdCiAgICBmb3IgaSwgYyBpbiBlbnVtZXJhdGUoY2hhbnMpOgogICAgICAgIGxpbmVz
#9#LmFwcGVuZChmIiAgQ3tpKzF9OiB7Yy5nZXQoJ25hbWUnLCc/Jyl9ICBjb2xvcj17Yy5nZXQoJ2Nv
#9#bG9yJywnPycpfSAgIgogICAgICAgICAgICAgICAgICAgICBmImdhbW1hPXtjLmdldCgnZ2FtbWEn
#9#LCc/Jyl9IikKICAgIG5fdHAgPSBkaW1zLmdldCgidCIpIGlmIGlzaW5zdGFuY2UoZGltcy5nZXQo
#9#InQiKSwgaW50KSBlbHNlIDEKICAgIG9uZV9mcmFtZSA9IGYiIOKAlCB0aW1lcG9pbnQge3RpbWVw
#9#b2ludH0gb2YgMC4ue25fdHAgLSAxfSBvbmx5IiBpZiBuX3RwID4gMSBlbHNlICIiCiAgICBsaW5l
#9#cyArPSBbCiAgICAgICAgIiIsCiAgICAgICAgIkZpbGVzIGluIHRoaXMgZm9sZGVyOiIsCiAgICAg
#9#ICAgZiIgIHtkc1snZm9sZGVyJ119X3dlYi56aXAgICBhcmNoaXZlIG9mIHRoZSB3ZWIvcHJlcHJv
#9#Y2Vzc2VkIGRhdGFzZXQgIgogICAgICAgICIoYnJpY2tzICsgbWV0YWRhdGEgKyB0aHVtYm5haWwi
#9#ICsgKCIsIGV2ZXJ5IHRpbWVwb2ludCkiIGlmIG5fdHAgPiAxIGVsc2UgIikiKSwKICAgICAgICBm
#9#IiAge2RzWydmb2xkZXInXX0uaW1zICAgICAgIG9yaWdpbmFsIEltYXJpcyBhY3F1aXNpdGlvbiIK
#9#ICAgICAgICArIChmIiAgKHtmbXRfc2l6ZShpbXNfc3JjLnN0YXQoKS5zdF9zaXplKX0pIiBpZiBp
#9#bXNfc3JjIGFuZCBpbXNfc3JjLmV4aXN0cygpIGVsc2UgIiAobm90IGF2YWlsYWJsZSkiKSwKICAg
#9#ICAgICBmIiAge2RzWydmb2xkZXInXX0udGlmICAgICAgIG11bHRpLWNoYW5uZWwgSW1hZ2VKL0Zp
#9#amkgY29tcG9zaXRlIGh5cGVyc3RhY2sgIgogICAgICAgIGYiKG5hdGl2ZSBiaXQgZGVwdGgsIMK1
#9#bS1jYWxpYnJhdGVkLCB+e1RBUkdFVF9QWH1weCksIGZyb20gdGhlIC5pbXMgcHlyYW1pZHtvbmVf
#9#ZnJhbWV9IiwKICAgICAgICBmIiAge2RzWydmb2xkZXInXX1fQypfKl9NSVAucG5nICAgcGVyLWNo
#9#YW5uZWwgbWF4aW11bS1pbnRlbnNpdHkgcHJvamVjdGlvbntvbmVfZnJhbWV9IiwKICAgIF0KICAg
#9#IGlmIG5fdHAgPiAxOgogICAgICAgIGxpbmVzLmFwcGVuZChmIiAgVGhlIC5pbXMgaG9sZHMgYWxs
#9#IHtuX3RwfSB0aW1lcG9pbnRzLiIpCiAgICByZXR1cm4gbGluZXMKCgojIOKUgOKUgCBoZWxwZXJz
#9#IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#9#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#9#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#9#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgApkZWYgZm10X3NpemUobik6CiAgICBuID0gZmxvYXQo
#9#bikKICAgIGZvciB1bml0IGluICgiQiIsICJLQiIsICJNQiIsICJHQiIsICJUQiIpOgogICAgICAg
#9#IGlmIG4gPCAxMDI0IG9yIHVuaXQgPT0gIlRCIjoKICAgICAgICAgICAgcmV0dXJuIGYie246LjFm
#9#fSB7dW5pdH0iIGlmIHVuaXQgIT0gIkIiIGVsc2UgZiJ7aW50KG4pfSBCIgogICAgICAgIG4gLz0g
#9#MTAyNAoKCiMg4pSA4pSAIG1haW4g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#9#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#9#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#9#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmRl
#9#ZiBwcm9jZXNzKGRzLCBhcmdzKToKICAgIGZvbGRlciA9IGRzWyJmb2xkZXIiXQogICAgZGwgPSBk
#9#c1siZGlyIl0gLyAiZG93bmxvYWQiCiAgICBwcmludChmIlxuPT09IHtkc1snaWQnXX0gPT09IikK
#9#ICAgIGlmIG5vdCBhcmdzLmRyeV9ydW46CiAgICAgICAgZGwubWtkaXIocGFyZW50cz1UcnVlLCBl
#9#eGlzdF9vaz1UcnVlKQoKICAgICMgMS4gYXJjaGl2ZSBGSVJTVCAoZG93bmxvYWQvIGlzIGV4Y2x1
#9#ZGVkIHJlZ2FyZGxlc3Mgb2Ygb3JkZXIpCiAgICBpZiBub3QgYXJncy5ub19hcmNoaXZlOgogICAg
#9#ICAgIHRyeToKICAgICAgICAgICAgcHJpbnQoZiIgIFthcmNoaXZlXSB7YnVpbGRfYXJjaGl2ZShk
#9#c1snZGlyJ10sIGZvbGRlciwgZGwgLyBmJ3tmb2xkZXJ9X3dlYi56aXAnLCBhcmdzLmZvcmNlLCBh
#9#cmdzLmRyeV9ydW4pfSIpCiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBleGM6CiAgICAgICAg
#9#ICAgIHByaW50KGYiICBbYXJjaGl2ZV0gRkFJTEVEOiB7ZXhjfSIpCgogICAgIyBBIHBob3RvZ3Jh
#9#cGggaGFzIG5vIC5pbXMgdG8gcmUtcmVhZDogc3RlcHMgMi00IGFyZSBtZWFuaW5nbGVzcywgYW5k
#9#IGl0cwogICAgIyBvcmlnaW5hbCBUSUZGICsgUkVBRE1FIGFyZSBwbGFjZWQgYnkgcHJlcHJvY2Vz
#9#cy8yZF9pbXBvcnRlci5weS4KICAgICMgVGhlIFJFQURNRSBpcyBuZXZlciBmb3JjZWQgaGVyZSwg
#9#c28gdGhlIGltcG9ydGVyJ3MgcmljaGVyIG9uZSBhbHdheXMgd2lucy4KICAgIGlmIGRzWyJ0eXBl
#9#Il0gPT0gIjJkIjoKICAgICAgICB0cnk6CiAgICAgICAgICAgIHByaW50KGYiICBbcmVhZG1lXSB7
#9#d3JpdGVfcmVhZG1lKGRsIC8gJ1JFQURNRS50eHQnLCBkcywgTm9uZSwgRmFsc2UsIGFyZ3MuZHJ5
#9#X3J1bil9IikKICAgICAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGV4YzoKICAgICAgICAgICAgcHJp
#9#bnQoZiIgIFtyZWFkbWVdIEZBSUxFRDoge2V4Y30iKQogICAgICAgIHJldHVybgoKICAgIGltc19z
#9#cmMgPSBQYXRoKGFyZ3MuaW1zKSBpZiBnZXRhdHRyKGFyZ3MsICJpbXMiLCBOb25lKSBlbHNlIGZp
#9#bmRfaW1zKGZvbGRlcikKICAgIGlmIGltc19zcmMgaXMgTm9uZSBhbmQgbm90IChhcmdzLm5vX2lt
#9#cyBhbmQgYXJncy5ub190aWZmKToKICAgICAgICBwcmludChmIiAgWy5pbXNdIG5vdCBmb3VuZCBp
#9#biBSQVdfREFUQSBmb3IgJ3tmb2xkZXJ9JyDigJQgc2tpcHBpbmcgaW1zL3RpZmYvbWlwIikKCiAg
#9#ICAjIDIuIG9yaWdpbmFsIC5pbXMgKGhhcmQgbGluaykKICAgIGlmIG5vdCBhcmdzLm5vX2ltcyBh
#9#bmQgaW1zX3NyYyBpcyBub3QgTm9uZToKICAgICAgICB0cnk6CiAgICAgICAgICAgIHByaW50KGYi
#9#ICBbLmltc10ge3BsYWNlX2ltcyhpbXNfc3JjLCBkbCAvIGYne2ZvbGRlcn0uaW1zJywgYXJncy5m
#9#b3JjZSwgYXJncy5kcnlfcnVuKX0iKQogICAgICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZXhjOgog
#9#ICAgICAgICAgICBwcmludChmIiAgWy5pbXNdIEZBSUxFRDoge2V4Y30iKQoKICAgICMgMy80LiBJ
#9#bWFnZUogY29tcG9zaXRlIFRJRkYgKyBwZXItY2hhbm5lbCBNSVAKICAgIGlmIChub3QgYXJncy5u
#9#b190aWZmIG9yIG5vdCBhcmdzLm5vX21pcCkgYW5kIGltc19zcmMgaXMgbm90IE5vbmU6CiAgICAg
#9#ICAgY2hhbm5lbHNfbWV0YSA9IGRzWyJtZXRhIl0uZ2V0KCJjaGFubmVscyIsIFtdKQogICAgICAg
#9#IHRpZmZfb3V0ID0gZGwgLyBmIntmb2xkZXJ9LnRpZiIKICAgICAgICBkZWYgbWlwX3BhdGgoY2ks
#9#IG5hbWUpOgogICAgICAgICAgICBzYWZlID0gcmUuc3ViKHIiW15BLVphLXowLTkuXy1dKyIsICJf
#9#Iiwgc3RyKG5hbWUpKS5zdHJpcCgiXyIpIG9yIGYiQ3tjaSsxfSIKICAgICAgICAgICAgcmV0dXJu
#9#IGRsIC8gZiJ7Zm9sZGVyfV9De2NpKzF9X3tzYWZlfV9NSVAucG5nIgogICAgICAgIHRyeToKICAg
#9#ICAgICAgICAgcHJpbnQoZiIgIFt0aWZmL21pcF0ge2J1aWxkX3RpZmZfYW5kX21pcHMoaW1zX3Ny
#9#YywgZHNbJ2RpciddLCBmb2xkZXIsIGNoYW5uZWxzX21ldGEsIHRpZmZfb3V0LCBtaXBfcGF0aCwg
#9#bm90IGFyZ3Mubm9fdGlmZiwgbm90IGFyZ3Mubm9fbWlwLCBhcmdzLmZvcmNlLCBhcmdzLmRyeV9y
#9#dW4sIGFyZ3MudGltZXBvaW50KX0iKQogICAgICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZXhjOgog
#9#ICAgICAgICAgICBwcmludChmIiAgW3RpZmYvbWlwXSBGQUlMRUQ6IHtleGN9IikKICAgICAgICAj
#9#IERyb3AgdGhlIHN1cGVyc2VkZWQgT01FLVRJRkYgb25seSBvbmNlIGl0cyByZXBsYWNlbWVudCBp
#9#cyBvbiBkaXNrIOKAlAogICAgICAgICMgbGVmdCBpbiBwbGFjZSBpdCBzdGF5cyB0aGUgZmlsZSBv
#9#cGVyYXRvcnMgZG93bmxvYWQsIGFuZCBpdCBvcGVucyBibGFjay4KICAgICAgICBsZWdhY3kgPSBk
#9#bCAvIGYie2ZvbGRlcn0ub21lLnRpZiIKICAgICAgICBpZiBsZWdhY3kuZXhpc3RzKCkgYW5kIHRp
#9#ZmZfb3V0LmV4aXN0cygpIGFuZCBub3QgYXJncy5kcnlfcnVuOgogICAgICAgICAgICBsZWdhY3ku
#9#dW5saW5rKCkKICAgICAgICAgICAgcHJpbnQoZiIgIFt0aWZmXSByZW1vdmVkIHN1cGVyc2VkZWQg
#9#e2xlZ2FjeS5uYW1lfSIpCgogICAgIyA1LiBSRUFETUUKICAgIHRyeToKICAgICAgICBwcmludChm
#9#IiAgW3JlYWRtZV0ge3dyaXRlX3JlYWRtZShkbCAvICdSRUFETUUudHh0JywgZHMsIGltc19zcmMs
#9#IGFyZ3MuZm9yY2UsIGFyZ3MuZHJ5X3J1biwgYXJncy50aW1lcG9pbnQpfSIpCiAgICBleGNlcHQg
#9#RXhjZXB0aW9uIGFzIGV4YzoKICAgICAgICBwcmludChmIiAgW3JlYWRtZV0gRkFJTEVEOiB7ZXhj
#9#fSIpCgoKZGVmIG1haW4oKToKICAgIGdsb2JhbCBUQVJHRVRfUFgsIERBVEFfV0VCLCBSQVdfREFU
#9#QV9ESVJTCiAgICBhcCA9IGFyZ3BhcnNlLkFyZ3VtZW50UGFyc2VyKGRlc2NyaXB0aW9uPSJQb3B1
#9#bGF0ZSBlYWNoIGRhdGFzZXQncyBkb3dubG9hZC8gZm9sZGVyLiIpCiAgICBhcC5hZGRfYXJndW1l
#9#bnQoIi0tZGF0YXNldHMiLCBoZWxwPSJjYXNlLWluc2Vuc2l0aXZlIHN1YnN0cmluZyBmaWx0ZXIg
#9#b24gZm9sZGVyIG5hbWUiKQogICAgYXAuYWRkX2FyZ3VtZW50KCItLWRhdGFzZXQiLCBoZWxwPSJl
#9#eGFjdGx5IG9uZSBkYXRhc2V0LCBhcyAnPHR5cGU+Lzxmb2xkZXI+JyIpCiAgICBhcC5hZGRfYXJn
#9#dW1lbnQoIi0taW1zIiwgaGVscD0idGhlIGRhdGFzZXQncyBzb3VyY2UgLmltcyAoZGVmYXVsdDog
#9#c2VhcmNoZWQgaW4gdGhlIHJhdyBkaXJzKSIpCiAgICBhcC5hZGRfYXJndW1lbnQoIi0tdGltZXBv
#9#aW50IiwgdHlwZT1pbnQsIGRlZmF1bHQ9MCwKICAgICAgICAgICAgICAgICAgICBoZWxwPSJmcmFt
#9#ZSBvZiBhIHRpbWVsYXBzZSB0aGUgVElGRiBhbmQgTUlQcyBzaG93IChkZWZhdWx0IDApIikKICAg
#9#IGFwLmFkZF9hcmd1bWVudCgiLS10eXBlcyIsIGRlZmF1bHQ9IiwiLmpvaW4oREFUQVNFVF9UWVBF
#9#UyksCiAgICAgICAgICAgICAgICAgICAgaGVscD0iY29tbWEgbGlzdDogM2QsMmQsbGl2ZSAoYSAy
#9#ZCBkYXRhc2V0IGdldHMgdGhlICIKICAgICAgICAgICAgICAgICAgICAgICAgICJ3ZWIgYXJjaGl2
#9#ZSBvbmx5IOKAlCBpdHMgb3JpZ2luYWwgVElGRiBhbmQgUkVBRE1FIGNvbWUgZnJvbSB0aGUgaW1w
#9#b3J0ZXIpIikKICAgIGFwLmFkZF9hcmd1bWVudCgiLS1kYXRhLXdlYiIsIGhlbHA9Im92ZXJyaWRl
#9#IHRoZSBEQVRBX1dFQiBkaXJlY3RvcnkgKGRlZmF1bHQ6IDxyZXBvPi9EQVRBX1dFQikiKQogICAg
#9#YXAuYWRkX2FyZ3VtZW50KCItLXJhdy1kaXIiLCBoZWxwPSJkaXJlY3RvcnkgdG8gc2VhcmNoIGZp
#9#cnN0IGZvciB0aGUgc291cmNlIC5pbXMgKHByZXBlbmRlZCB0byBSQVdfREFUQV9ESVJTKSIpCiAg
#9#ICBhcC5hZGRfYXJndW1lbnQoIi0tdGlmZi1weCIsIHR5cGU9aW50LCBkZWZhdWx0PVRBUkdFVF9Q
#9#WCwgaGVscD0idGFyZ2V0IGxvbmcgWFkgc2lkZSBvZiB0aGUgVElGRiIpCiAgICBhcC5hZGRfYXJn
#9#dW1lbnQoIi0tbm8tYXJjaGl2ZSIsIGFjdGlvbj0ic3RvcmVfdHJ1ZSIpCiAgICBhcC5hZGRfYXJn
#9#dW1lbnQoIi0tbm8taW1zIiwgYWN0aW9uPSJzdG9yZV90cnVlIikKICAgIGFwLmFkZF9hcmd1bWVu
#9#dCgiLS1uby10aWZmIiwgYWN0aW9uPSJzdG9yZV90cnVlIikKICAgIGFwLmFkZF9hcmd1bWVudCgi
#9#LS1uby1taXAiLCBhY3Rpb249InN0b3JlX3RydWUiKQogICAgYXAuYWRkX2FyZ3VtZW50KCItLWZv
#9#cmNlIiwgYWN0aW9uPSJzdG9yZV90cnVlIiwgaGVscD0icmVidWlsZCBhcnRlZmFjdHMgdGhhdCBh
#9#bHJlYWR5IGV4aXN0IikKICAgIGFwLmFkZF9hcmd1bWVudCgiLS1kcnktcnVuIiwgYWN0aW9uPSJz
#9#dG9yZV90cnVlIikKICAgIGFyZ3MgPSBhcC5wYXJzZV9hcmdzKCkKCiAgICBUQVJHRVRfUFggPSBh
#9#cmdzLnRpZmZfcHgKICAgIGlmIGFyZ3MuZGF0YV93ZWI6CiAgICAgICAgREFUQV9XRUIgPSBQYXRo
#9#KGFyZ3MuZGF0YV93ZWIpCiAgICBpZiBhcmdzLnJhd19kaXI6CiAgICAgICAgUkFXX0RBVEFfRElS
#9#UyA9IFtQYXRoKGFyZ3MucmF3X2RpcildICsgUkFXX0RBVEFfRElSUwogICAgdHlwZXMgPSB0dXBs
#9#ZSh0LnN0cmlwKCkgZm9yIHQgaW4gYXJncy50eXBlcy5zcGxpdCgiLCIpIGlmIHQuc3RyaXAoKSkK
#9#CiAgICBkYXRhc2V0cyA9IGxvYWRfZGF0YXNldHMoYXJncy5kYXRhc2V0cywgdHlwZXMsIGV4YWN0
#9#X2lkPWFyZ3MuZGF0YXNldCkKICAgIGlmIG5vdCBkYXRhc2V0czoKICAgICAgICBwcmludCgiTm8g
#9#ZGF0YXNldHMgbWF0Y2hlZC4iKQogICAgICAgIHJldHVybiAxCiAgICBwcmludChmIntsZW4oZGF0
#9#YXNldHMpfSBkYXRhc2V0KHMpIHRvIHByb2Nlc3MgIgogICAgICAgICAgZiIoYXJjaGl2ZT17bm90
#9#IGFyZ3Mubm9fYXJjaGl2ZX0gaW1zPXtub3QgYXJncy5ub19pbXN9ICIKICAgICAgICAgIGYidGlm
#9#Zj17bm90IGFyZ3Mubm9fdGlmZn0gbWlwPXtub3QgYXJncy5ub19taXB9IHRhcmdldD17VEFSR0VU
#9#X1BYfXB4ICIKICAgICAgICAgIGYiZHJ5X3J1bj17YXJncy5kcnlfcnVufSkiKQogICAgdDAgPSB0
#9#aW1lLnRpbWUoKQogICAgZm9yIGRzIGluIGRhdGFzZXRzOgogICAgICAgIHRyeToKICAgICAgICAg
#9#ICAgcHJvY2VzcyhkcywgYXJncykKICAgICAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGV4YzoKICAg
#9#ICAgICAgICAgcHJpbnQoZiIgIFtkYXRhc2V0XSBGQUlMRUQ6IHtleGN9IikKICAgIHByaW50KGYi
#9#XG5Eb25lIGluIHt0aW1lLnRpbWUoKSAtIHQwOi4wZn1zLiIpCiAgICByZXR1cm4gMAoKCmlmIF9f
#9#bmFtZV9fID09ICJfX21haW5fXyI6CiAgICBzeXMuZXhpdChtYWluKCkpCg==
