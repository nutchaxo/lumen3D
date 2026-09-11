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
set "PP_VERSION=0.18.0"
set "PY_VERSION=3.12.8"
set "SCRIPTS=run_preprocess.py 1-ims_metadata.py 2-image_processor.py 3-chunk_packer.py 4-catalog_generator.py 2d_importer.py"
set "ENTRY=run_preprocess.py"
set "REQUIRED_DEPS=numpy Pillow h5py scipy tqdm"
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

rem ---- build_download_bundles.py : tools/ du depot, sinon extraction (index 5) -
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
call :extract 5 "!WORK!\build_download_bundles.py"
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
:: ---- [0] run_preprocess.py (19472 octets) ----
#0#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMw0KaW1wb3J0IGFyZ3BhcnNlDQppbXBvcnQgZm5tYXRjaA0K
#0#aW1wb3J0IGpzb24NCmltcG9ydCBvcw0KaW1wb3J0IHNodXRpbA0KaW1wb3J0IHNpZ25hbA0KaW1w
#0#b3J0IHN1YnByb2Nlc3MNCmltcG9ydCBzeXMNCmltcG9ydCB0cmFjZWJhY2sNCmZyb20gZGF0ZXRp
#0#bWUgaW1wb3J0IGRhdGV0aW1lDQpmcm9tIHBhdGhsaWIgaW1wb3J0IFBhdGgNCmltcG9ydCBudW1w
#0#eSBhcyBucA0KZnJvbSBQSUwgaW1wb3J0IEltYWdlDQoNCl9fdmVyc2lvbl9fID0gIjAuMTguMCIN
#0#Cg0KIyDilIDilIAgUGF0aHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#0#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#0#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#0#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#0#DQpTQ1JJUFRfRElSID0gUGF0aChfX2ZpbGVfXykucmVzb2x2ZSgpLnBhcmVudA0KUFlUSE9OX0VY
#0#RSA9IHN5cy5leGVjdXRhYmxlDQoNCiMg4pSA4pSAIENvbnNvbGUgc3R5bGluZyAoZ3JhY2VmdWwg
#0#QU5TSTsgZGVncmFkZXMgdG8gcGxhaW4gb24gcmVkaXJlY3QgLyBuby1WVCkg4pSA4pSA4pSA4pSA
#0#4pSA4pSADQpkZWYgX3N1cHBvcnRzX2NvbG9yKCkgLT4gYm9vbDoNCiAgICBpZiBub3Qgc3lzLnN0
#0#ZG91dC5pc2F0dHkoKToNCiAgICAgICAgcmV0dXJuIEZhbHNlDQogICAgaWYgb3MubmFtZSA9PSAi
#0#bnQiOg0KICAgICAgICB0cnk6DQogICAgICAgICAgICBpbXBvcnQgY3R5cGVzDQogICAgICAgICAg
#0#ICBrID0gY3R5cGVzLndpbmRsbC5rZXJuZWwzMg0KICAgICAgICAgICAgaCA9IGsuR2V0U3RkSGFu
#0#ZGxlKC0xMSkNCiAgICAgICAgICAgIG1vZGUgPSBjdHlwZXMuY191aW50MzIoKQ0KICAgICAgICAg
#0#ICAgaWYgbm90IGsuR2V0Q29uc29sZU1vZGUoaCwgY3R5cGVzLmJ5cmVmKG1vZGUpKToNCiAgICAg
#0#ICAgICAgICAgICByZXR1cm4gRmFsc2UNCiAgICAgICAgICAgIGsuU2V0Q29uc29sZU1vZGUoaCwg
#0#bW9kZS52YWx1ZSB8IDB4MDAwNCkgICMgRU5BQkxFX1ZJUlRVQUxfVEVSTUlOQUxfUFJPQ0VTU0lO
#0#Rw0KICAgICAgICBleGNlcHQgRXhjZXB0aW9uOg0KICAgICAgICAgICAgcmV0dXJuIEZhbHNlDQog
#0#ICAgcmV0dXJuIFRydWUNCg0KX0NPTE9SID0gX3N1cHBvcnRzX2NvbG9yKCkNCg0KZGVmIF9zdHls
#0#ZShjb2RlOiBzdHIsIHRleHQ6IHN0cikgLT4gc3RyOg0KICAgIHJldHVybiBmIlwwMzNbe2NvZGV9
#0#bXt0ZXh0fVwwMzNbMG0iIGlmIF9DT0xPUiBlbHNlIHRleHQNCg0KZGVmIF9oZHIocyk6ICByZXR1
#0#cm4gX3N0eWxlKCIxOzk2IiwgcykgICAjIGJvbGQgY3lhbg0KZGVmIF9vayhzKTogICByZXR1cm4g
#0#X3N0eWxlKCI5MiIsIHMpICAgICAjIGdyZWVuDQpkZWYgX2VycihzKTogIHJldHVybiBfc3R5bGUo
#0#IjkxIiwgcykgICAgICMgcmVkDQpkZWYgX3dhcm4ocyk6IHJldHVybiBfc3R5bGUoIjkzIiwgcykg
#0#ICAgICMgeWVsbG93DQpkZWYgX2RpbShzKTogIHJldHVybiBfc3R5bGUoIjkwIiwgcykgICAgICMg
#0#Z3JleQ0KDQojIOKUgOKUgCBHcmFjZWZ1bCBpbnRlcnJ1cHRpb24gKEN0cmwrQykg4pSA4pSA4pSA
#0#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#0#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#0#4pSA4pSA4pSA4pSA4pSADQojIEVhY2ggc3RlcCBydW5zIGluIGl0cyBPV04gcHJvY2VzcyBncm91
#0#cCwgc28gYSBjb25zb2xlIEN0cmwrQyBpcyBOT1QgZGVsaXZlcmVkIHRvDQojIHRoZSBjaGlsZCBk
#0#aXJlY3RseS4gVGhlIG9yY2hlc3RyYXRvciBpbnRlcmNlcHRzIFNJR0lOVCwgYXNrcyB0aGUgdXNl
#0#ciB0byBjb25maXJtLA0KIyBhbmQgb25seSB0aGVuIHRlYXJzIHRoZSBydW5uaW5nIHN0ZXAgKGFu
#0#ZCB0aGUgd29ya2VyIHBvb2wgaXQgc3Bhd25lZCkgZG93bi4NCiMgRGVjbGluaW5nIHRoZSBwcm9t
#0#cHQgcmVzdW1lcyB0aGUgc3RlcCB0cmFuc3BhcmVudGx5IOKAlCBpdCBuZXZlciByZWNlaXZlZCB0
#0#aGUgc2lnbmFsLg0KaWYgb3MubmFtZSA9PSAibnQiOg0KICAgIF9TVEVQX1NQQVdOID0geyJjcmVh
#0#dGlvbmZsYWdzIjogc3VicHJvY2Vzcy5DUkVBVEVfTkVXX1BST0NFU1NfR1JPVVB9DQplbHNlOg0K
#0#ICAgIF9TVEVQX1NQQVdOID0geyJzdGFydF9uZXdfc2Vzc2lvbiI6IFRydWV9DQoNCl9jdXJyZW50
#0#X3Byb2MgPSBOb25lICAgICMgUG9wZW4gb2YgdGhlIHN0ZXAgY3VycmVudGx5IHJ1bm5pbmcgKG9y
#0#IE5vbmUpDQpfY29uZmlybWluZyA9IEZhbHNlICAgICAjIHJlLWVudHJhbmN5IGd1YXJkIGZvciB0
#0#aGUgY29uZmlybWF0aW9uIHByb21wdA0KDQoNCmRlZiBfa2lsbF90cmVlKHByb2MpIC0+IE5vbmU6
#0#DQogICAgIiIiVGVybWluYXRlIGEgc3RlcCBwcm9jZXNzIGFuZCBldmVyeSB3b3JrZXIgaXQgc3Bh
#0#d25lZCAoUHJvY2Vzc1Bvb2xFeGVjdXRvcikuIiIiDQogICAgaWYgcHJvYyBpcyBOb25lIG9yIHBy
#0#b2MucG9sbCgpIGlzIG5vdCBOb25lOg0KICAgICAgICByZXR1cm4NCiAgICB0cnk6DQogICAgICAg
#0#IGlmIG9zLm5hbWUgPT0gIm50IjoNCiAgICAgICAgICAgIHN1YnByb2Nlc3MucnVuKFsidGFza2tp
#0#bGwiLCAiL0YiLCAiL1QiLCAiL1BJRCIsIHN0cihwcm9jLnBpZCldLA0KICAgICAgICAgICAgICAg
#0#ICAgICAgICAgICAgc3Rkb3V0PXN1YnByb2Nlc3MuREVWTlVMTCwgc3RkZXJyPXN1YnByb2Nlc3Mu
#0#REVWTlVMTCkNCiAgICAgICAgZWxzZToNCiAgICAgICAgICAgIG9zLmtpbGxwZyhvcy5nZXRwZ2lk
#0#KHByb2MucGlkKSwgc2lnbmFsLlNJR1RFUk0pDQogICAgZXhjZXB0IEV4Y2VwdGlvbjoNCiAgICAg
#0#ICAgcGFzcw0KICAgIHRyeToNCiAgICAgICAgcHJvYy53YWl0KHRpbWVvdXQ9MTApDQogICAgZXhj
#0#ZXB0IEV4Y2VwdGlvbjoNCiAgICAgICAgdHJ5Og0KICAgICAgICAgICAgcHJvYy5raWxsKCkNCiAg
#0#ICAgICAgZXhjZXB0IEV4Y2VwdGlvbjoNCiAgICAgICAgICAgIHBhc3MNCg0KDQpkZWYgX2luc3Rh
#0#bGxfc2lnaW50X2hhbmRsZXIoKSAtPiBOb25lOg0KICAgICIiIk9uIEN0cmwrQywgYXNrIGZvciBj
#0#b25maXJtYXRpb24uIENvbmZpcm0gLT4gYWJvcnQgY2xlYW5seTsgZGVjbGluZSAtPiByZXN1bWUu
#0#IiIiDQogICAgZGVmIF9oYW5kbGVyKHNpZ251bSwgZnJhbWUpOg0KICAgICAgICBnbG9iYWwgX2Nv
#0#bmZpcm1pbmcNCiAgICAgICAgaWYgX2NvbmZpcm1pbmc6DQogICAgICAgICAgICAjIEEgc2Vjb25k
#0#IEN0cmwrQyB3aGlsZSB0aGUgcHJvbXB0IGlzIHVwIG1lYW5zOiBzdG9wIG5vdywgZm9yIHN1cmUu
#0#DQogICAgICAgICAgICByYWlzZSBLZXlib2FyZEludGVycnVwdA0KICAgICAgICBfY29uZmlybWlu
#0#ZyA9IFRydWUNCiAgICAgICAgdHJ5Og0KICAgICAgICAgICAgc3lzLnN0ZGVyci53cml0ZSgiXG4i
#0#KQ0KICAgICAgICAgICAgdHJ5Og0KICAgICAgICAgICAgICAgIGFuc3dlciA9IGlucHV0KF93YXJu
#0#KCJbIV0gQXJyZXRlciBsZSBwaXBlbGluZSBlbiBjb3VycyA/ICIpICsNCiAgICAgICAgICAgICAg
#0#ICAgICAgICAgICAgICAgICAiTGVzIGZpY2hpZXJzIHRlbXBvcmFpcmVzIHNlcm9udCBuZXR0b3ll
#0#cy4gW28vTl0gIikNCiAgICAgICAgICAgIGV4Y2VwdCBFT0ZFcnJvcjoNCiAgICAgICAgICAgICAg
#0#ICBhbnN3ZXIgPSAibyIgICAjIG5vbi1pbnRlcmFjdGl2ZSBzdGRpbjogY2Fubm90IGFzayAtPiBz
#0#dG9wDQogICAgICAgIGZpbmFsbHk6DQogICAgICAgICAgICBfY29uZmlybWluZyA9IEZhbHNlDQog
#0#ICAgICAgIGlmIGFuc3dlci5zdHJpcCgpLmxvd2VyKCkgaW4gKCJvIiwgIm91aSIsICJ5IiwgInll
#0#cyIpOg0KICAgICAgICAgICAgcmFpc2UgS2V5Ym9hcmRJbnRlcnJ1cHQNCiAgICAgICAgcHJpbnQo
#0#X2RpbSgiICAgIHJlcHJpc2UgZHUgdHJhaXRlbWVudC4uLiIpKQ0KICAgIHNpZ25hbC5zaWduYWwo
#0#c2lnbmFsLlNJR0lOVCwgX2hhbmRsZXIpDQoNCiMgSGV4IGNvbG9ycyB0byBSR0IgbWFwcGluZyBm
#0#b3IgY29tcG9zaXRlIHRodW1ibmFpbCAobWF0Y2hlcyBjaGFubmVsIGNvbG9ycykNClRIVU1CX0NP
#0#TE9SUyA9IFsNCiAgICAoMCwgMjU1LCAxMDIpLCAgICAjIGdyZWVuDQogICAgKDI1NSwgNjEsIDI1
#0#NSksICAgIyBtYWdlbnRhDQogICAgKDQ3LCAxMDcsIDI1NSksICAgIyBibHVlDQogICAgKDI1NSwg
#0#NDgsIDQ4KSwgICAgIyByZWQNCiAgICAoMjU1LCAyNTUsIDApLCAgICAjIHllbGxvdw0KICAgICgy
#0#NTUsIDAsIDI1NSksICAgICMgcHVycGxlDQogICAgKDAsIDI1NSwgMjU1KSAgICAgIyBjeWFuDQpd
#0#DQoNCmRlZiBidWlsZF90aHVtYm5haWwodGVtcF9kaXI6IFBhdGgsIG91dHB1dF9kaXI6IFBhdGgs
#0#IHByb2NfbWV0YTogZGljdCkgLT4gTm9uZToNCiAgICAiIiINCiAgICBDb21wdXRlcyBhIE1heGlt
#0#dW0gSW50ZW5zaXR5IFByb2plY3Rpb24gKE1JUCkgZm9yIGVhY2ggY2hhbm5lbCBmcm9tIHByb2Nl
#0#c3NlZA0KICAgIGxvdy1yZXMgdm9sdW1lcyBhbmQgY29tcG9zaXRlcyB0aGVtIGludG8gYSBzdHVu
#0#bmluZyBmYWxzZS1jb2xvciBSR0IgdGh1bWJuYWlsLg0KICAgICIiIg0KICAgIG5fY2ggPSBwcm9j
#0#X21ldGFbIm5fY2hhbm5lbHMiXQ0KICAgIGxvZF9sZXZlbHMgPSBwcm9jX21ldGFbImxvZF9sZXZl
#0#bHMiXQ0KICAgIEQgPSBwcm9jX21ldGFbImRlcHRoIl0NCiAgICANCiAgICAjIFdlIHVzZSBMT0Qx
#0#IG9yIExPRDIgdG8gc3BlZWQgdXAgTUlQIGNvbXB1dGF0aW9uIChtYXggNTEyLzEwMjQgd2lkdGgp
#0#DQogICAgdGFyZ2V0X2xvZCA9IDANCiAgICBmb3IgbGkgaW4gbG9kX2xldmVsczoNCiAgICAgICAg
#0#aWYgbWF4KGxpWyJ3aWR0aCJdLCBsaVsiaGVpZ2h0Il0pIDw9IDEwMjQ6DQogICAgICAgICAgICB0
#0#YXJnZXRfbG9kID0gbGlbImxvZCJdDQogICAgICAgICAgICBicmVhaw0KICAgICAgICAgICAgDQog
#0#ICAgbGkgPSBsb2RfbGV2ZWxzW3RhcmdldF9sb2RdDQogICAgd19sb2QsIGhfbG9kID0gbGlbIndp
#0#ZHRoIl0sIGxpWyJoZWlnaHQiXQ0KICAgIA0KICAgIG1pcHMgPSBbXQ0KICAgIGZvciBjIGluIHJh
#0#bmdlKG5fY2gpOg0KICAgICAgICBiaW5fZmlsZSA9IHRlbXBfZGlyIC8gZiJ0MDAwX2N7Y31fbG9k
#0#e3RhcmdldF9sb2R9LmJpbiINCiAgICAgICAgaWYgbm90IGJpbl9maWxlLmV4aXN0cygpOg0KICAg
#0#ICAgICAgICAgY29udGludWUNCiAgICAgICAgIyBMb2FkIHByb2Nlc3NlZCB2b2x1bWUNCiAgICAg
#0#ICAgdm9sID0gbnAuZnJvbWZpbGUoc3RyKGJpbl9maWxlKSwgZHR5cGU9bnAudWludDgpLnJlc2hh
#0#cGUoKEQsIGhfbG9kLCB3X2xvZCkpDQogICAgICAgICMgQ29tcHV0ZSBNYXhpbXVtIEludGVuc2l0
#0#eSBQcm9qZWN0aW9uIGFsb25nIFogYXhpcw0KICAgICAgICBtaXAgPSB2b2wubWF4KGF4aXM9MCkN
#0#CiAgICAgICAgbWlwcy5hcHBlbmQobWlwKQ0KICAgICAgICANCiAgICBpZiBub3QgbWlwczoNCiAg
#0#ICAgICAgcHJpbnQoIltUSFVNQk5BSUxdIFdhcm5pbmc6IE5vIGNoYW5uZWwgYmluYXJ5IGZpbGVz
#0#IGZvdW5kIHRvIGJ1aWxkIHRodW1ibmFpbC4iKQ0KICAgICAgICByZXR1cm4NCg0KICAgICMgQ29t
#0#cG9zaXRlIE1JUHMgaW50byBmYWxzZS1jb2xvciBSR0INCiAgICBjb21wb3NpdGUgPSBucC56ZXJv
#0#cygoaF9sb2QsIHdfbG9kLCAzKSwgZHR5cGU9bnAuZmxvYXQzMikNCiAgICBmb3IgaSwgbWlwIGlu
#0#IGVudW1lcmF0ZShtaXBzKToNCiAgICAgICAgciwgZywgYiA9IFRIVU1CX0NPTE9SU1tpICUgbGVu
#0#KFRIVU1CX0NPTE9SUyldDQogICAgICAgIG5vcm0gPSBtaXAuYXN0eXBlKG5wLmZsb2F0MzIpIC8g
#0#MjU1LjANCiAgICAgICAgY29tcG9zaXRlWzosIDosIDBdICs9IG5vcm0gKiByDQogICAgICAgIGNv
#0#bXBvc2l0ZVs6LCA6LCAxXSArPSBub3JtICogZw0KICAgICAgICBjb21wb3NpdGVbOiwgOiwgMl0g
#0#Kz0gbm9ybSAqIGINCg0KICAgIGNvbXBvc2l0ZSA9IG5wLmNsaXAoY29tcG9zaXRlLCAwLCAyNTUp
#0#LmFzdHlwZShucC51aW50OCkNCiAgICBpbWcgPSBJbWFnZS5mcm9tYXJyYXkoY29tcG9zaXRlLCBt
#0#b2RlPSJSR0IiKQ0KICAgIA0KICAgICMgUmVzaXplIHRvIDUxMng1MTIgcHJlc2VydmluZyBhc3Bl
#0#Y3QgcmF0aW8NCiAgICBUSFVNQl9TSVpFID0gNTEyDQogICAgc2NhbGUgPSBUSFVNQl9TSVpFIC8g
#0#bWF4KHdfbG9kLCBoX2xvZCkNCiAgICBuZXdfdywgbmV3X2ggPSBtYXgoMSwgcm91bmQod19sb2Qg
#0#KiBzY2FsZSkpLCBtYXgoMSwgcm91bmQoaF9sb2QgKiBzY2FsZSkpDQogICAgaW1nID0gaW1nLnJl
#0#c2l6ZSgobmV3X3csIG5ld19oKSwgSW1hZ2UuUmVzYW1wbGluZy5MQU5DWk9TKQ0KICAgIA0KICAg
#0#ICMgUGFkIHRvIHNxdWFyZSB3aXRoIGRhcmsgYmFja2dyb3VuZCAoIzA4MGExMikNCiAgICBvdXQg
#0#PSBJbWFnZS5uZXcoIlJHQiIsIChUSFVNQl9TSVpFLCBUSFVNQl9TSVpFKSwgKDgsIDEwLCAxOCkp
#0#DQogICAgb2ZmX3ggPSAoVEhVTUJfU0laRSAtIG5ld193KSAvLyAyDQogICAgb2ZmX3kgPSAoVEhV
#0#TUJfU0laRSAtIG5ld19oKSAvLyAyDQogICAgb3V0LnBhc3RlKGltZywgKG9mZl94LCBvZmZfeSkp
#0#DQogICAgDQogICAgdGh1bWJfcGF0aCA9IG91dHB1dF9kaXIgLyAidGh1bWJuYWlsLndlYnAiDQog
#0#ICAgb3V0LnNhdmUoc3RyKHRodW1iX3BhdGgpLCAiV0VCUCIsIHF1YWxpdHk9ODgsIG1ldGhvZD02
#0#KQ0KICAgIHByaW50KGYiW1RIVU1CTkFJTF0gV3JvdGUgdGh1bWJuYWlsIHRvIHt0aHVtYl9wYXRo
#0#fSIpDQoNCmRlZiBydW5fc2NyaXB0KHNjcmlwdF9wYXRoLCAqYXJncywgbGFiZWw9Tm9uZSkgLT4g
#0#Tm9uZToNCiAgICBnbG9iYWwgX2N1cnJlbnRfcHJvYw0KICAgIGNtZCA9IFtQWVRIT05fRVhFLCBz
#0#dHIoc2NyaXB0X3BhdGgpLCAqYXJnc10NCiAgICBwcmludChfZGltKGYiICAgLSB7bGFiZWwgb3Ig
#0#UGF0aChzY3JpcHRfcGF0aCkubmFtZX0iKSkNCiAgICBwcm9jID0gc3VicHJvY2Vzcy5Qb3Blbihj
#0#bWQsICoqX1NURVBfU1BBV04pDQogICAgX2N1cnJlbnRfcHJvYyA9IHByb2MNCiAgICB0cnk6DQog
#0#ICAgICAgIHJldCA9IHByb2Mud2FpdCgpDQogICAgZXhjZXB0IEtleWJvYXJkSW50ZXJydXB0Og0K
#0#ICAgICAgICAjIENvbmZpcm1lZCBhYm9ydCBkdXJpbmcgdGhpcyBzdGVwOiB0ZWFyIGRvd24gdGhl
#0#IHN0ZXAgYW5kIGl0cyB3b3JrZXIgcG9vbC4NCiAgICAgICAgX2tpbGxfdHJlZShwcm9jKQ0KICAg
#0#ICAgICByYWlzZQ0KICAgIGZpbmFsbHk6DQogICAgICAgIF9jdXJyZW50X3Byb2MgPSBOb25lDQog
#0#ICAgaWYgcmV0ICE9IDA6DQogICAgICAgIHJhaXNlIHN1YnByb2Nlc3MuQ2FsbGVkUHJvY2Vzc0Vy
#0#cm9yKHJldCwgY21kKQ0KDQoNCmRlZiBydW5fc3RlcChzY3JpcHRfbmFtZTogc3RyLCAqYXJncykg
#0#LT4gTm9uZToNCiAgICBydW5fc2NyaXB0KFNDUklQVF9ESVIgLyBzY3JpcHRfbmFtZSwgKmFyZ3Mp
#0#DQoNCg0KZGVmIGF0dGFjaF90cmFja2luZyhpbXNfcGF0aDogUGF0aCwgZGF0YXNldF9vdXRwdXRf
#0#ZGlyOiBQYXRoLCB0ZW1wX2RpcjogUGF0aCwNCiAgICAgICAgICAgICAgICAgICAgZGF0YXNldF9u
#0#YW1lOiBzdHIsIG1vZGU6IHN0cikgLT4gTm9uZToNCiAgICAiIiJGaW5kIHRoaXMgdm9sdW1lJ3Mg
#0#Y2VsbC10cmFja2luZyBhbmFseXNpcyBhbmQgYXR0YWNoIGl0IHRvIHRoZSBkYXRhc2V0Lg0KDQog
#0#ICAgVGhlIGFuYWx5c2lzIHJlYWNoZXMgdXMgaW4gb25lIG9mIHRocmVlIHNoYXBlcyDigJQgYSAu
#0#aW1hcmlzX3RyYWNrIGNvbnRhaW5lciwgdGhlIEltYXJpcw0KICAgIG9iamVjdHMgc3RpbGwgaW5z
#0#aWRlIHRoZSAuaW1zLCBvciB0aGUgc3RhdGlzdGljcyB3b3JrYm9vayBleHBvcnRlZCBiZXNpZGUg
#0#aXQg4oCUIHNvIHRoZQ0KICAgIHZvbHVtZSBpcyBub3QgdGhlIG9wZXJhdG9yJ3MgcHJvYmxlbTog
#0#d2hpY2hldmVyIGV4aXN0cyBpcyBmb3VuZCBhbmQgbm9ybWFsaXNlZC4gQQ0KICAgIHN5bnRoZXNp
#0#c2VkIGNvbnRhaW5lciBpcyB3cml0dGVuIHRvIHRoZSB0ZW1wIGRpcmVjdG9yeSwgbmV2ZXIgdG8g
#0#dGhlIGRhdGFzZXQsIHNvIHRoZQ0KICAgIHB1Ymxpc2hlZCB0cmVlIG9ubHkgZXZlciByZWNlaXZl
#0#cyB3aGF0IHRoZSBpbXBvcnRlciBwdXRzIHRoZXJlLg0KDQogICAgQSBmYWlsdXJlIGhlcmUgbmV2
#0#ZXIgZmFpbHMgdGhlIHZvbHVtZTogdGhlIGRhdGFzZXQgaXMgYWxyZWFkeSBjb21wbGV0ZSBhbmQg
#0#dXNhYmxlLCB0aGUNCiAgICB0cmFja2luZyBpcyBhbiBvdmVybGF5IG9uIHRvcCBvZiBpdC4NCiAg
#0#ICAiIiINCiAgICBpZiBtb2RlID09ICJvZmYiOg0KICAgICAgICByZXR1cm4NCiAgICAjIFRoZSBz
#0#dGFuZGFsb25lIC5iYXQgbGF1bmNoZXIgZW1iZWRzIHRoZSB2b2x1bWUgc3RlcHMgb25seTsgc2F5
#0#aW5nIG5vdGhpbmcgdGhlcmUgaXMNCiAgICAjIGNvcnJlY3QsIHdoaWxlIGEgbWlzc2luZyBtb2R1
#0#bGUgaW4gYSBidWlsZCB0aGF0IGRvZXMgc2hpcCBpdCBpcyB3b3J0aCByZXBvcnRpbmcuDQogICAg
#0#aWYgbm90IChTQ1JJUFRfRElSIC8gInRyYWNraW5nX3NvdXJjZXMucHkiKS5leGlzdHMoKToNCiAg
#0#ICAgICAgcmV0dXJuDQogICAgdHJ5Og0KICAgICAgICBpbXBvcnQgdHJhY2tpbmdfc291cmNlcw0K
#0#ICAgIGV4Y2VwdCBJbXBvcnRFcnJvciBhcyBleGM6DQogICAgICAgIHByaW50KF93YXJuKGYiICAg
#0#WyFdIHRyYWNraW5nIGlnbm9yZSA6IHtleGN9IikpDQogICAgICAgIHJldHVybg0KDQogICAgdHJ5
#0#Og0KICAgICAgICBpZiBtb2RlID09ICJhdXRvIjoNCiAgICAgICAgICAgIHJlc29sdmVkID0gdHJh
#0#Y2tpbmdfc291cmNlcy5yZXNvbHZlKGltc19wYXRoLCB0ZW1wX2RpciwgZGF0YXNldF9uYW1lKQ0K
#0#ICAgICAgICAgICAgaWYgcmVzb2x2ZWQgaXMgTm9uZToNCiAgICAgICAgICAgICAgICByZXR1cm4N
#0#CiAgICAgICAgICAgIGNvbnRhaW5lciwgX3NvdXJjZSwgX2dsYiA9IHJlc29sdmVkDQogICAgICAg
#0#IGVsc2U6DQogICAgICAgICAgICBzb3VyY2VfcGF0aCA9IFBhdGgobW9kZSkNCiAgICAgICAgICAg
#0#IGlmIG5vdCBzb3VyY2VfcGF0aC5pc19maWxlKCk6DQogICAgICAgICAgICAgICAgcHJpbnQoX3dh
#0#cm4oZiIgICBbIV0gdHJhY2tpbmcgaW50cm91dmFibGUgOiB7c291cmNlX3BhdGh9IikpDQogICAg
#0#ICAgICAgICAgICAgcmV0dXJuDQogICAgICAgICAgICBwcmludChfZGltKGYiICAgW1RSQUNLSU5H
#0#XSBzb3VyY2UgaW1wb3NlZSA6IHtzb3VyY2VfcGF0aC5uYW1lfSIpKQ0KICAgICAgICAgICAgY29u
#0#dGFpbmVyID0gdHJhY2tpbmdfc291cmNlcy5tYXRlcmlhbGl6ZShzb3VyY2VfcGF0aCwgdGVtcF9k
#0#aXIsIGRhdGFzZXRfbmFtZSkNCiAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGV4YzoNCiAgICAgICAg
#0#cHJpbnQoX3dhcm4oZiIgICBbIV0gdHJhY2tpbmcgbm9uIGV4cGxvaXRhYmxlIDoge2V4Y30iKSkN
#0#CiAgICAgICAgcmV0dXJuDQoNCiAgICB0cnk6DQogICAgICAgIHJ1bl9zdGVwKCI1LXRyYWNraW5n
#0#X2ltcG9ydGVyLnB5Iiwgc3RyKGNvbnRhaW5lciksIHN0cihkYXRhc2V0X291dHB1dF9kaXIpKQ0K
#0#ICAgIGV4Y2VwdCBzdWJwcm9jZXNzLkNhbGxlZFByb2Nlc3NFcnJvciBhcyBleGM6DQogICAgICAg
#0#IHByaW50KF93YXJuKGYiICAgWyFdIHJhdHRhY2hlbWVudCBkdSB0cmFja2luZyBlY2hvdWUgKGNv
#0#ZGUge2V4Yy5yZXR1cm5jb2RlfSkg4oCUICINCiAgICAgICAgICAgICAgICAgICAgZiJsZSB2b2x1
#0#bWUgcmVzdGUgdXRpbGlzYWJsZSIpKQ0KDQoNCkRPV05MT0FEX1NDUklQVF9OQU1FID0gImJ1aWxk
#0#X2Rvd25sb2FkX2J1bmRsZXMucHkiDQoNCmRlZiBfcmVzb2x2ZV9kb3dubG9hZF9zY3JpcHQoKToN
#0#CiAgICAiIiJUaGUgZG93bmxvYWQtYnVuZGxlIHRvb2wgc2l0cyBpbiB0b29scy8gaW4gdGhlIHJl
#0#cG8sIGJ1dCBpcyBleHRyYWN0ZWQgbmV4dA0KICAgIHRvIHRoaXMgc2NyaXB0IGJ5IHRoZSBzZWxm
#0#LWNvbnRhaW5lZCBsYXVuY2hlciDigJQgYWNjZXB0IGVpdGhlciBsb2NhdGlvbi4iIiINCiAgICBm
#0#b3IgY2FuZCBpbiAoU0NSSVBUX0RJUiAvIERPV05MT0FEX1NDUklQVF9OQU1FLA0KICAgICAgICAg
#0#ICAgICAgICBTQ1JJUFRfRElSLnBhcmVudCAvICJ0b29scyIgLyBET1dOTE9BRF9TQ1JJUFRfTkFN
#0#RSk6DQogICAgICAgIGlmIGNhbmQuZXhpc3RzKCk6DQogICAgICAgICAgICByZXR1cm4gY2FuZC5y
#0#ZXNvbHZlKCkNCiAgICByZXR1cm4gTm9uZQ0KDQpkZWYgcHJvY2Vzc19pbXNfZmlsZShpbXNfcGF0
#0#aDogUGF0aCwgb3V0cHV0X3Jvb3Q6IFBhdGgsIGlkeDogaW50ID0gMCwgdG90YWw6IGludCA9IDAs
#0#DQogICAgICAgICAgICAgICAgICAgICB3aXRoX2Rvd25sb2FkczogYm9vbCA9IEZhbHNlLCB0cmFj
#0#a2luZzogc3RyID0gImF1dG8iKSAtPiBOb25lOg0KICAgIGRhdGFzZXRfbmFtZSA9IGltc19wYXRo
#0#LnN0ZW0NCiAgICBjb3VudGVyID0gZiJbe2lkeH0ve3RvdGFsfV0gIiBpZiB0b3RhbCBlbHNlICIi
#0#DQogICAgcHJpbnQoKQ0KICAgIHByaW50KF9oZHIoZiI+PiB7Y291bnRlcn17ZGF0YXNldF9uYW1l
#0#fSIpKQ0KICAgIHByaW50KF9kaW0oZiIgICBzb3VyY2UgOiB7aW1zX3BhdGh9IikpDQogICAgdDAg
#0#PSBkYXRldGltZS5ub3coKQ0KICAgIA0KICAgICMgU2V0dXAgZGlyZWN0b3JpZXMNCiAgICB0ZW1w
#0#X2RpciA9IG91dHB1dF9yb290IC8gZiIudGVtcF9wcmVwcm9jZXNzX3tkYXRhc2V0X25hbWV9Ig0K
#0#ICAgIGlmIHRlbXBfZGlyLmV4aXN0cygpOg0KICAgICAgICBzaHV0aWwucm10cmVlKHRlbXBfZGly
#0#KQ0KICAgIHRlbXBfZGlyLm1rZGlyKHBhcmVudHM9VHJ1ZSwgZXhpc3Rfb2s9VHJ1ZSkNCg0KICAg
#0#ICMgQm91bmQgYmVmb3JlIHRoZSB0cnk6IHN0ZXAgMSBjYW4gZmFpbCwgYW5kIHRoZSByb2xsYmFj
#0#ayBoYW5kbGVyIG11c3Qgbm90IHR1cm4gYQ0KICAgICMgc3RlcC0xIGVycm9yIGludG8gYSBOYW1l
#0#RXJyb3IgdGhhdCBoaWRlcyBpdC4NCiAgICBicmlja3NfZGlyID0gTm9uZQ0KICAgIGJyaWNrc19y
#0#b2xsYmFjayA9IE5vbmUNCg0KICAgIHRyeToNCiAgICAgICAgIyBTdGVwIDE6IEV4dHJhY3Rpb24g
#0#b2YgbWV0YWRhdGENCiAgICAgICAgdGVtcF9tZXRhX2pzb24gPSB0ZW1wX2RpciAvICJtZXRhLmpz
#0#b24iDQogICAgICAgIHJ1bl9zdGVwKCIxLWltc19tZXRhZGF0YS5weSIsIHN0cihpbXNfcGF0aCks
#0#IHN0cih0ZW1wX21ldGFfanNvbikpDQoNCiAgICAgICAgIyBUaGUgZGF0YXNldCB0eXBlIGZvbGxv
#0#d3MgdGhlIGFjcXVpc2l0aW9uOiBhIHN0YWNrIHdpdGggbW9yZSB0aGFuIG9uZQ0KICAgICAgICAj
#0#IHRpbWVwb2ludCBpcyBhIHRpbWVsYXBzZSBhbmQgYmVsb25ncyB1bmRlciBsaXZlLywgd2hpY2gg
#0#aXMgd2hhdCBkcml2ZXMgdGhlDQogICAgICAgICMgdmlld2VyJ3MgdGltZWxpbmUuIFJlc29sdmVk
#0#IGhlcmUgYmVjYXVzZSBvbmx5IHN0ZXAgMSBrbm93cyB0aGUgZnJhbWUgY291bnQuDQogICAgICAg
#0#ICMgVGhlIGRpcmVjdG9yeSBuYW1lIElTIHRoZSBkYXRhc2V0IHR5cGUg4oCUIHN0ZXAgNCByZWFk
#0#cyBpdCBiYWNrIG9mZiBkaXNrLg0KICAgICAgICB3aXRoIG9wZW4odGVtcF9tZXRhX2pzb24sICJy
#0#IiwgZW5jb2Rpbmc9InV0Zi04IikgYXMgZm06DQogICAgICAgICAgICBuX3RpbWVwb2ludHMgPSBp
#0#bnQoanNvbi5sb2FkKGZtKS5nZXQoIm5fdGltZXBvaW50cyIsIDEpIG9yIDEpDQogICAgICAgIGRh
#0#dGFzZXRfdHlwZSA9ICJsaXZlIiBpZiBuX3RpbWVwb2ludHMgPiAxIGVsc2UgIjNkIg0KICAgICAg
#0#ICBkYXRhc2V0X291dHB1dF9kaXIgPSBvdXRwdXRfcm9vdCAvIGRhdGFzZXRfdHlwZSAvIGRhdGFz
#0#ZXRfbmFtZQ0KICAgICAgICAjIFRoZSBwcmV2aW91cyBicmlja3MgdXNlZCB0byBiZSBERUxFVEVE
#0#IGhlcmUsIGJlZm9yZSB0aGUgaGVhdnkgc3RlcCBldmVuIHJhbi4NCiAgICAgICAgIyBBbnkgZmFp
#0#bHVyZSBhZnRlciB0aGlzIHBvaW50IOKAlCBhbmQgc3RlcCAyIGNhbiBmYWlsIGZvciByZWFzb25z
#0#IHRoYXQgaGF2ZQ0KICAgICAgICAjIG5vdGhpbmcgdG8gZG8gd2l0aCB0aGUgZGF0YSwgc3VjaCBh
#0#cyBleGhhdXN0aW5nIHRoZSBXaW5kb3dzIGNvbW1pdCBsaW1pdCBvbiBhDQogICAgICAgICMgYnVz
#0#eSBtYWNoaW5lIOKAlCBsZWZ0IGFuIGFscmVhZHkgcHVibGlzaGVkIGRhdGFzZXQgd2l0aCBubyBi
#0#cmlja3MgYXQgYWxsIGFuZCBubw0KICAgICAgICAjIHdheSBiYWNrLiBUaGV5IGFyZSBub3cgbW92
#0#ZWQgYXNpZGUgYW5kIG9ubHkgZHJvcHBlZCBvbmNlIHRoZSBydW4gaGFzIHN1Y2NlZWRlZDsNCiAg
#0#ICAgICAgIyBvbiBmYWlsdXJlIHRoZXkgYXJlIHB1dCBiYWNrIChzZWUgdGhlIGV4Y2VwdC9maW5h
#0#bGx5IGJlbG93KS4NCiAgICAgICAgYnJpY2tzX2RpciA9IGRhdGFzZXRfb3V0cHV0X2RpciAvICJi
#0#cmlja3MiDQogICAgICAgIGJyaWNrc19yb2xsYmFjayA9IGRhdGFzZXRfb3V0cHV0X2RpciAvICJi
#0#cmlja3Mucm9sbGJhY2siDQogICAgICAgIGlmIGJyaWNrc19kaXIuZXhpc3RzKCk6DQogICAgICAg
#0#ICAgICBpZiBicmlja3Nfcm9sbGJhY2suZXhpc3RzKCk6DQogICAgICAgICAgICAgICAgc2h1dGls
#0#LnJtdHJlZShicmlja3Nfcm9sbGJhY2ssIGlnbm9yZV9lcnJvcnM9VHJ1ZSkNCiAgICAgICAgICAg
#0#IGJyaWNrc19kaXIucmVuYW1lKGJyaWNrc19yb2xsYmFjaykNCiAgICAgICAgZGF0YXNldF9vdXRw
#0#dXRfZGlyLm1rZGlyKHBhcmVudHM9VHJ1ZSwgZXhpc3Rfb2s9VHJ1ZSkNCiAgICAgICAgcHJpbnQo
#0#X2RpbShmIiAgIHR5cGUgICA6IHtkYXRhc2V0X3R5cGV9Ig0KICAgICAgICAgICAgICAgICAgICsg
#0#KGYiICh7bl90aW1lcG9pbnRzfSB0aW1lcG9pbnRzKSIgaWYgbl90aW1lcG9pbnRzID4gMSBlbHNl
#0#ICIiKSkpDQoNCiAgICAgICAgIyBTdGVwIDI6IE5vcm1hbGl6YXRpb24sIEJhY2tncm91bmQgc3Vi
#0#dHJhY3Rpb24sIERvd25zY2FsaW5nDQogICAgICAgIHJ1bl9zdGVwKCIyLWltYWdlX3Byb2Nlc3Nv
#0#ci5weSIsIHN0cihpbXNfcGF0aCksIHN0cih0ZW1wX21ldGFfanNvbiksIHN0cih0ZW1wX2Rpcikp
#0#DQogICAgICAgIA0KICAgICAgICAjIFN0ZXAgMzogQ29tcHV0ZSB0aHVtYm5haWwgTUlQDQogICAg
#0#ICAgIHdpdGggb3Blbih0ZW1wX2RpciAvICJwcm9jZXNzaW5nX21ldGEuanNvbiIsICJyIiwgZW5j
#0#b2Rpbmc9InV0Zi04IikgYXMgZm06DQogICAgICAgICAgICBwcm9jX21ldGEgPSBqc29uLmxvYWQo
#0#Zm0pDQogICAgICAgIGJ1aWxkX3RodW1ibmFpbCh0ZW1wX2RpciwgZGF0YXNldF9vdXRwdXRfZGly
#0#LCBwcm9jX21ldGEpDQogICAgICAgIA0KICAgICAgICAjIFN0ZXAgNDogQ2h1bmtpbmcgNjTCsyAm
#0#IFBhY2sgYnVpbGRpbmcNCiAgICAgICAgcnVuX3N0ZXAoIjMtY2h1bmtfcGFja2VyLnB5Iiwgc3Ry
#0#KHRlbXBfZGlyKSwgc3RyKGRhdGFzZXRfb3V0cHV0X2RpcikpDQogICAgICAgIA0KICAgICAgICAj
#0#IFN0ZXAgNTogQ2F0YWxvZyBtZXRhZGF0YSAoZGF0YXNldC5qc29uIC8gbWV0YWRhdGEuanNvbikN
#0#CiAgICAgICAgcnVuX3N0ZXAoIjQtY2F0YWxvZ19nZW5lcmF0b3IucHkiLCBzdHIodGVtcF9kaXIp
#0#LCBzdHIoZGF0YXNldF9vdXRwdXRfZGlyKSkNCg0KICAgICAgICAjIFN0ZXAgNjogY2VsbCB0cmFj
#0#a2luZywgd2hlbiB0aGUgYWNxdWlzaXRpb24gaGFzIG9uZS4gT25seSBhIHRpbWVsYXBzZSBjYW4g
#0#Y2FycnkNCiAgICAgICAgIyB0cmFqZWN0b3JpZXMsIGFuZCB0aGUgc3RlcCBuZWVkcyB0aGUgbWV0
#0#YWRhdGEuanNvbiBzdGVwIDQganVzdCB3cm90ZS4NCiAgICAgICAgaWYgbl90aW1lcG9pbnRzID4g
#0#MToNCiAgICAgICAgICAgIGF0dGFjaF90cmFja2luZyhpbXNfcGF0aCwgZGF0YXNldF9vdXRwdXRf
#0#ZGlyLCB0ZW1wX2RpciwgZGF0YXNldF9uYW1lLCB0cmFja2luZykNCg0KICAgICAgICAjIFN0ZXAg
#0#NyAob3B0aW9uYWwpOiBkb3dubG9hZC8gYnVuZGxlIOKAlCBhcmNoaXZlLCBvcmlnaW5hbCAuaW1z
#0#LCBJbWFnZUogVElGRiwNCiAgICAgICAgIyBwZXItY2hhbm5lbCBNSVBzLCBSRUFETUUuIFJ1bnMg
#0#YWZ0ZXIgc3RlcCA0IHNvIG1ldGFkYXRhLmpzb24gZXhpc3RzLiBUaGUNCiAgICAgICAgIyBzb3Vy
#0#Y2UgLmltcyBpcyB0aGUgb25lIGJlaW5nIHByb2Nlc3NlZCwgc28gcG9pbnQgdGhlIHRvb2wgYXQg
#0#aXRzIGZvbGRlci4NCiAgICAgICAgaWYgd2l0aF9kb3dubG9hZHM6DQogICAgICAgICAgICBkbF9z
#0#Y3JpcHQgPSBfcmVzb2x2ZV9kb3dubG9hZF9zY3JpcHQoKQ0KICAgICAgICAgICAgaWYgZGxfc2Ny
#0#aXB0IGlzIE5vbmU6DQogICAgICAgICAgICAgICAgcHJpbnQoX3dhcm4oZiIgICBbIV0ge0RPV05M
#0#T0FEX1NDUklQVF9OQU1FfSBpbnRyb3V2YWJsZSDigJQgZG93bmxvYWQvIGlnbm9yZSIpKQ0KICAg
#0#ICAgICAgICAgZWxzZToNCiAgICAgICAgICAgICAgICBydW5fc2NyaXB0KGRsX3NjcmlwdCwNCiAg
#0#ICAgICAgICAgICAgICAgICAgICAgICAgICItLWRhdGEtd2ViIiwgc3RyKG91dHB1dF9yb290KSwN
#0#CiAgICAgICAgICAgICAgICAgICAgICAgICAgICItLXJhdy1kaXIiLCBzdHIoaW1zX3BhdGgucGFy
#0#ZW50KSwNCiAgICAgICAgICAgICAgICAgICAgICAgICAgICItLWRhdGFzZXRzIiwgZGF0YXNldF9u
#0#YW1lLA0KICAgICAgICAgICAgICAgICAgICAgICAgICAgbGFiZWw9ImRvd25sb2FkLyAoYXJjaGl2
#0#ZSwgSW1hZ2VKIFRJRkYsIE1JUCkiKQ0KDQogICAgICAgICMgVGhlIHJ1biBwcm9kdWNlZCBhIGNv
#0#bXBsZXRlIGJyaWNrIHNldDogdGhlIHByZXZpb3VzIG9uZSBjYW4gZ28uDQogICAgICAgIGlmIGJy
#0#aWNrc19yb2xsYmFjayBpcyBub3QgTm9uZSBhbmQgYnJpY2tzX3JvbGxiYWNrLmV4aXN0cygpOg0K
#0#ICAgICAgICAgICAgc2h1dGlsLnJtdHJlZShicmlja3Nfcm9sbGJhY2ssIGlnbm9yZV9lcnJvcnM9
#0#VHJ1ZSkNCg0KICAgICAgICBlbGFwc2VkID0gKGRhdGV0aW1lLm5vdygpIC0gdDApLnRvdGFsX3Nl
#0#Y29uZHMoKQ0KICAgICAgICBwcmludChfb2soZiIgICBbT0tdIHtkYXRhc2V0X25hbWV9IHRlcm1p
#0#bmUgZW4ge2VsYXBzZWQ6LjBmfXMiKSkNCiAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGU6DQogICAg
#0#ICAgIHByaW50KF9lcnIoZiIgICBbWF0ge2RhdGFzZXRfbmFtZX0gOiB7ZX0iKSwgZmlsZT1zeXMu
#0#c3RkZXJyKQ0KICAgICAgICB0cmFjZWJhY2sucHJpbnRfZXhjKCkNCiAgICAgICAgIyBQdXQgdGhl
#0#IHByZXZpb3VzIGJyaWNrcyBiYWNrOiBhIGRhdGFzZXQgdGhhdCB3YXMgc2VydmluZyBiZWZvcmUg
#0#dGhpcyBydW4gbXVzdA0KICAgICAgICAjIHN0aWxsIGJlIHNlcnZpbmcgYWZ0ZXIgaXQgZmFpbGVk
#0#LiBBIHBhcnRpYWwgc2V0IGxlZnQgYnkgYW4gaW50ZXJydXB0ZWQgc3RlcCAzDQogICAgICAgICMg
#0#aXMgd29yc2UgdGhhbiB0aGUgb2xkIG9uZSDigJQgaXQgaXMgZGlzY2FyZGVkLg0KICAgICAgICB0
#0#cnk6DQogICAgICAgICAgICBpZiBicmlja3Nfcm9sbGJhY2sgaXMgbm90IE5vbmUgYW5kIGJyaWNr
#0#c19yb2xsYmFjay5leGlzdHMoKToNCiAgICAgICAgICAgICAgICBpZiBicmlja3NfZGlyLmV4aXN0
#0#cygpOg0KICAgICAgICAgICAgICAgICAgICBzaHV0aWwucm10cmVlKGJyaWNrc19kaXIsIGlnbm9y
#0#ZV9lcnJvcnM9VHJ1ZSkNCiAgICAgICAgICAgICAgICBicmlja3Nfcm9sbGJhY2sucmVuYW1lKGJy
#0#aWNrc19kaXIpDQogICAgICAgICAgICAgICAgcHJpbnQoX3dhcm4oZiIgICBbPF0gYnJpY2tzLyBw
#0#cmVjZWRlbnQgcmVzdGF1cmUgcG91ciB7ZGF0YXNldF9uYW1lfSIpLCBmaWxlPXN5cy5zdGRlcnIp
#0#DQogICAgICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgcmVzdG9yZV9lcnI6DQogICAgICAgICAgICBw
#0#cmludChfZXJyKGYiICAgWyFdIHJlc3RhdXJhdGlvbiBkZSBicmlja3MvIGltcG9zc2libGUgOiB7
#0#cmVzdG9yZV9lcnJ9IiksIGZpbGU9c3lzLnN0ZGVycikNCiAgICBmaW5hbGx5Og0KICAgICAgICAj
#0#IENsZWFuIHVwIHRlbXBvcmFyeSBwcm9jZXNzaW5nIGJpbmFyeSBmaWxlcyB0byBmcmVlIHNwYWNl
#0#Lg0KICAgICAgICAjIGlnbm9yZV9lcnJvcnM6IG9uIGEgQ3RybCtDIHRlYXJkb3duIGEganVzdC1r
#0#aWxsZWQgd29ya2VyIG1heSBzdGlsbCBob2xkIGENCiAgICAgICAgIyBoYW5kbGUgZm9yIGEgZmV3
#0#IG1zIOKAlCBuZXZlciBsZXQgY2xlYW51cCBtYXNrIHRoZSBpbnRlcnJ1cHRpb24uDQogICAgICAg
#0#IGlmIHRlbXBfZGlyLmV4aXN0cygpOg0KICAgICAgICAgICAgc2h1dGlsLnJtdHJlZSh0ZW1wX2Rp
#0#ciwgaWdub3JlX2Vycm9ycz1UcnVlKQ0KDQpkZWYgbWFpbigpOg0KICAgIHBhcnNlciA9IGFyZ3Bh
#0#cnNlLkFyZ3VtZW50UGFyc2VyKGRlc2NyaXB0aW9uPSJJUklCSE0gTWljcm9zY29weSBQcmVwcm9j
#0#ZXNzaW5nIFVuaWZpZWQgUGlwZWxpbmUiKQ0KICAgIHBhcnNlci5hZGRfYXJndW1lbnQoIi0taW5w
#0#dXQiLCByZXF1aXJlZD1UcnVlLCBoZWxwPSJJbnB1dCBkaXJlY3RvcnkgY29udGFpbmluZyByYXcg
#0#LmltcyBmaWxlcy4iKQ0KICAgIHBhcnNlci5hZGRfYXJndW1lbnQoIi0tb3V0cHV0IiwgcmVxdWly
#0#ZWQ9VHJ1ZSwgaGVscD0iT3V0cHV0IERBVEFfV0VCIGRpcmVjdG9yeSBvZiB0aGUgd2ViIHBsYXRm
#0#b3JtLiIpDQogICAgcGFyc2VyLmFkZF9hcmd1bWVudCgiLS1vbmx5IiwgZGVmYXVsdD1Ob25lLCBo
#0#ZWxwPSJHbG9iIHBhdHRlcm4gdG8gZmlsdGVyIGZpbGVzIHRvIHByb2Nlc3MgKGUuZy4gJypFOCon
#0#KS4iKQ0KICAgIHBhcnNlci5hZGRfYXJndW1lbnQoIi0td2l0aC1kb3dubG9hZHMiLCBhY3Rpb249
#0#InN0b3JlX3RydWUiLA0KICAgICAgICAgICAgICAgICAgICAgICAgaGVscD0iQWZ0ZXIgZWFjaCBk
#0#YXRhc2V0LCBhbHNvIGJ1aWxkIGl0cyBkb3dubG9hZC8gYnVuZGxlICINCiAgICAgICAgICAgICAg
#0#ICAgICAgICAgICAgICAgIih3ZWIgYXJjaGl2ZSwgb3JpZ2luYWwgLmltcywgSW1hZ2VKIFRJRkYs
#0#IHBlci1jaGFubmVsIE1JUCwgUkVBRE1FKS4iKQ0KICAgIHBhcnNlci5hZGRfYXJndW1lbnQoIi0t
#0#dHJhY2tpbmciLCBkZWZhdWx0PSJhdXRvIiwgbWV0YXZhcj0iYXV0b3xvZmZ8RklMRSIsDQogICAg
#0#ICAgICAgICAgICAgICAgICAgICBoZWxwPSJDZWxsIHRyYWNraW5nIGZvciB0aW1lbGFwc2UgZGF0
#0#YXNldHMuICdhdXRvJyAoZGVmYXVsdCkgbG9va3MgZm9yICINCiAgICAgICAgICAgICAgICAgICAg
#0#ICAgICAgICAgImEgLmltYXJpc190cmFjayBiZXNpZGUgdGhlIHZvbHVtZSwgdGhlbiB0aGUgSW1h
#0#cmlzIG9iamVjdHMgaW5zaWRlICINCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgInRoZSAu
#0#aW1zIGl0c2VsZiwgdGhlbiB0aGUgZXhwb3J0ZWQgLnhscy8ueGxzeCBzdGF0aXN0aWNzLiAnb2Zm
#0#JyAiDQogICAgICAgICAgICAgICAgICAgICAgICAgICAgICJza2lwcyBpdC4gQSBwYXRoIGZvcmNl
#0#cyB0aGF0IGZpbGUgZm9yIGV2ZXJ5IGRhdGFzZXQgcHJvY2Vzc2VkLiIpDQogICAgYXJncyA9IHBh
#0#cnNlci5wYXJzZV9hcmdzKCkNCg0KICAgIGlucHV0X2RpciA9IFBhdGgoYXJncy5pbnB1dCkNCiAg
#0#ICBvdXRwdXRfZGlyID0gUGF0aChhcmdzLm91dHB1dCkNCg0KICAgIGlmIG5vdCBpbnB1dF9kaXIu
#0#aXNfZGlyKCk6DQogICAgICAgIHN5cy5leGl0KGYiW0ZBVEFMXSBJbnB1dCBkaXJlY3Rvcnkgbm90
#0#IGZvdW5kOiB7aW5wdXRfZGlyfSIpDQogICAgICAgIA0KICAgIG91dHB1dF9kaXIubWtkaXIocGFy
#0#ZW50cz1UcnVlLCBleGlzdF9vaz1UcnVlKQ0KDQogICAgIyBHbG9iIElNUyBmaWxlcw0KICAgIGlt
#0#c19maWxlcyA9IHNvcnRlZChpbnB1dF9kaXIuZ2xvYigiKi5pbXMiKSkNCiAgICBpZiBhcmdzLm9u
#0#bHk6DQogICAgICAgIGltc19maWxlcyA9IFtwIGZvciBwIGluIGltc19maWxlcyBpZiBmbm1hdGNo
#0#LmZubWF0Y2gocC5uYW1lLCBhcmdzLm9ubHkpXQ0KDQogICAgaWYgbm90IGltc19maWxlczoNCiAg
#0#ICAgICAgcHJpbnQoX3dhcm4oZiJBdWN1biBmaWNoaWVyIC5pbXMgY29ycmVzcG9uZGFudCBkYW5z
#0#IHtpbnB1dF9kaXJ9IikpDQogICAgICAgIHN5cy5leGl0KDApDQoNCiAgICBwcmludCgpDQogICAg
#0#cHJpbnQoX2hkcigiICBQaXBlbGluZSBkZSBwcmVwcm9jZXNzaW5nICAiKSArIF9kaW0oZiJ2e19f
#0#dmVyc2lvbl9ffSIpKQ0KICAgIHByaW50KF9kaW0oZiIgIHNvdXJjZSAgICAgIDoge2lucHV0X2Rp
#0#cn0iKSkNCiAgICBwcmludChfZGltKGYiICBkZXN0aW5hdGlvbiA6IHtvdXRwdXRfZGlyfSIpKQ0K
#0#ICAgIHByaW50KF9kaW0oZiIgIGRhdGFzZXRzICAgIDoge2xlbihpbXNfZmlsZXMpfSAgIChmaWx0
#0#cmU6IHthcmdzLm9ubHkgb3IgJyonfSkiKSkNCiAgICBwcmludChfZGltKGYiICBkb3dubG9hZC8g
#0#ICA6IHsnb3VpJyBpZiBhcmdzLndpdGhfZG93bmxvYWRzIGVsc2UgJ25vbid9IikpDQogICAgcHJp
#0#bnQoX2RpbShmIiAgdHJhY2tpbmcgICAgOiB7YXJncy50cmFja2luZ30iKSkNCg0KICAgICMgR3Jh
#0#Y2VmdWwgQ3RybCtDOiBjb25maXJtIHdpdGggdGhlIHVzZXIsIHRoZW4gdGVhciB0aGUgcnVubmlu
#0#ZyBzdGVwIGRvd24gY2xlYW5seS4NCiAgICBfaW5zdGFsbF9zaWdpbnRfaGFuZGxlcigpDQoNCiAg
#0#ICAjIE9uZSBkYXRhc2V0IGF0IGEgdGltZSAoYm91bmRlZCBSQU0pIOKAlCBlYWNoIHN0ZXAgYWxy
#0#ZWFkeSBtdWx0aXRocmVhZHMgaW50ZXJuYWxseS4NCiAgICBpbnRlcnJ1cHRlZCA9IEZhbHNlDQog
#0#ICAgZm9yIGksIGltc19maWxlIGluIGVudW1lcmF0ZShpbXNfZmlsZXMpOg0KICAgICAgICB0cnk6
#0#DQogICAgICAgICAgICBwcm9jZXNzX2ltc19maWxlKGltc19maWxlLCBvdXRwdXRfZGlyLCBpICsg
#0#MSwgbGVuKGltc19maWxlcyksDQogICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGhfZG93
#0#bmxvYWRzPWFyZ3Mud2l0aF9kb3dubG9hZHMsIHRyYWNraW5nPWFyZ3MudHJhY2tpbmcpDQogICAg
#0#ICAgIGV4Y2VwdCBLZXlib2FyZEludGVycnVwdDoNCiAgICAgICAgICAgIGludGVycnVwdGVkID0g
#0#VHJ1ZQ0KICAgICAgICAgICAgYnJlYWsNCiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBleGM6
#0#DQogICAgICAgICAgICBwcmludChfZXJyKGYiICAgW1hdIHtpbXNfZmlsZS5uYW1lfSA6IHtleGN9
#0#IikpDQoNCiAgICBpZiBpbnRlcnJ1cHRlZDoNCiAgICAgICAgIyBSZW1vdmUgYW55IGhhbGYtd3Jp
#0#dHRlbiB0ZW1wIGZvbGRlciBsZWZ0IGJ5IHRoZSBhYm9ydGVkIGRhdGFzZXQuDQogICAgICAgIGZv
#0#ciBzdHJheSBpbiBvdXRwdXRfZGlyLmdsb2IoIi50ZW1wX3ByZXByb2Nlc3NfKiIpOg0KICAgICAg
#0#ICAgICAgc2h1dGlsLnJtdHJlZShzdHJheSwgaWdub3JlX2Vycm9ycz1UcnVlKQ0KICAgICAgICBw
#0#cmludCgpDQogICAgICAgIHByaW50KF93YXJuKCIgIFBpcGVsaW5lIGludGVycm9tcHUgcGFyIGwn
#0#dXRpbGlzYXRldXIgKEN0cmwrQykuIEV0YXQgbmV0dG95ZS4iKSkNCiAgICAgICAgc3lzLmV4aXQo
#0#MTMwKQ0KDQogICAgcHJpbnQoKQ0KICAgIHByaW50KF9vaygiICBQaXBlbGluZSB0ZXJtaW5lLiIp
#0#KQ0KDQppZiBfX25hbWVfXyA9PSAiX19tYWluX18iOg0KICAgIHRyeToNCiAgICAgICAgbWFpbigp
#0#DQogICAgZXhjZXB0IEtleWJvYXJkSW50ZXJydXB0Og0KICAgICAgICAjIEN0cmwrQyBjb25maXJt
#0#ZWQgb3V0c2lkZSBhIGRhdGFzZXQgKGUuZy4gYmV0d2VlbiBzdGVwcykg4oCUIGV4aXQgY2xlYW5s
#0#eS4NCiAgICAgICAgcHJpbnQoX3dhcm4oIlxuWyFdIFBpcGVsaW5lIGFycmV0ZS4iKSwgZmlsZT1z
#0#eXMuc3RkZXJyKQ0KICAgICAgICBzeXMuZXhpdCgxMzApDQo=
:: ---- [1] 1-ims_metadata.py (5623 octets) ----
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
#1#ICAgICAgICAgICApLnN0cmlwKCkKICAgIHJldHVybiBzdHIodikuc3RyaXAoKQoKZGVmIHJlYWRf
#1#aW1zX21ldGFkYXRhKGZpbGVfcGF0aDogUGF0aCkgLT4gZGljdDoKICAgIHdpdGggaDVweS5GaWxl
#1#KHN0cihmaWxlX3BhdGgpLCAiciIpIGFzIGY6CiAgICAgICAgaW5mbyA9IGYuZ2V0KCJEYXRhU2V0
#1#SW5mbyIsIHt9KS5nZXQoIkltYWdlIiwgTm9uZSkKICAgICAgICAKICAgICAgICB3aWR0aCA9IGlu
#1#dChhdHRyX3N0cihpbmZvLCAiWCIsICIxIikgb3IgMSkKICAgICAgICBoZWlnaHQgPSBpbnQoYXR0
#1#cl9zdHIoaW5mbywgIlkiLCAiMSIpIG9yIDEpCiAgICAgICAgZGVwdGggPSBpbnQoYXR0cl9zdHIo
#1#aW5mbywgIloiLCAiMSIpIG9yIDEpCgogICAgICAgIGRlZiBfZXh0KGtleSwgZmFsbGJhY2s9MC4w
#1#KToKICAgICAgICAgICAgdHJ5OgogICAgICAgICAgICAgICAgcmV0dXJuIGZsb2F0KGF0dHJfc3Ry
#1#KGluZm8sIGtleSwgc3RyKGZhbGxiYWNrKSkpCiAgICAgICAgICAgIGV4Y2VwdCBWYWx1ZUVycm9y
#1#OgogICAgICAgICAgICAgICAgcmV0dXJuIGZhbGxiYWNrCgogICAgICAgIGV4dF9taW5feCA9IF9l
#1#eHQoIkV4dE1pbjAiKQogICAgICAgIGV4dF9tYXhfeCA9IF9leHQoIkV4dE1heDAiLCAxLjApCiAg
#1#ICAgICAgZXh0X21pbl95ID0gX2V4dCgiRXh0TWluMSIpCiAgICAgICAgZXh0X21heF95ID0gX2V4
#1#dCgiRXh0TWF4MSIsIDEuMCkKICAgICAgICBleHRfbWluX3ogPSBfZXh0KCJFeHRNaW4yIikKICAg
#1#ICAgICBleHRfbWF4X3ogPSBfZXh0KCJFeHRNYXgyIiwgMS4wKQoKICAgICAgICB2b3hfeCA9IChl
#1#eHRfbWF4X3ggLSBleHRfbWluX3gpIC8gbWF4KHdpZHRoLCAxKQogICAgICAgIHZveF95ID0gKGV4
#1#dF9tYXhfeSAtIGV4dF9taW5feSkgLyBtYXgoaGVpZ2h0LCAxKQogICAgICAgIHZveF96ID0gKGV4
#1#dF9tYXhfeiAtIGV4dF9taW5feikgLyBtYXgoZGVwdGgsIDEpCgogICAgICAgIHJlczAgPSBmLmdl
#1#dCgiRGF0YVNldCIsIHt9KS5nZXQoIlJlc29sdXRpb25MZXZlbCAwIiwge30pCiAgICAgICAgdGlt
#1#ZXBvaW50cyA9IHNvcnRlZCgKICAgICAgICAgICAgW2sgZm9yIGsgaW4gcmVzMC5rZXlzKCkgaWYg
#1#ay5zdGFydHN3aXRoKCJUaW1lUG9pbnQiKV0sCiAgICAgICAgICAgIGtleT1sYW1iZGEgeDogaW50
#1#KHguc3BsaXQoKVstMV0pCiAgICAgICAgKQogICAgICAgIG5fdHAgPSBsZW4odGltZXBvaW50cykg
#1#b3IgMQoKICAgICAgICAjIEFjcXVpc2l0aW9uIGNsb2NrLiBJbWFyaXMgc3RvcmVzIG9uZSBhdHRy
#1#aWJ1dGUgcGVyIGZyYW1lIHVuZGVyCiAgICAgICAgIyBEYXRhU2V0SW5mby9UaW1lSW5mbyBhcyAi
#1#VGltZVBvaW50MSIuLiJUaW1lUG9pbnROIiAoMS1iYXNlZCksIGZvcm1hdHRlZAogICAgICAgICMg
#1#IllZWVktTU0tREQgSEg6TU06U1MubW1tIi4gQSB0aW1lbGFwc2Ugdmlld2VyIG5lZWRzIHRoZSBy
#1#ZWFsIHdhbGwtY2xvY2sKICAgICAgICAjIHRpbWVzLCBub3QganVzdCBmcmFtZSBpbmRpY2VzLCBh
#1#bmQgdGhlIG1lZGlhbiBpbnRlci1mcmFtZSBnYXAgaXMgd2hhdCB0aGUKICAgICAgICAjIFVJIGxh
#1#YmVscyB0aGUgYWNxdWlzaXRpb24gaW50ZXJ2YWwgd2l0aC4KICAgICAgICB0aW1lX2luZm8gPSBm
#1#LmdldCgiRGF0YVNldEluZm8iLCB7fSkuZ2V0KCJUaW1lSW5mbyIsIE5vbmUpCiAgICAgICAgdGlt
#1#ZXN0YW1wcyA9IFtdCiAgICAgICAgZm9yIGkgaW4gcmFuZ2UoMSwgbl90cCArIDEpOgogICAgICAg
#1#ICAgICBzdGFtcCA9IGF0dHJfc3RyKHRpbWVfaW5mbywgZiJUaW1lUG9pbnR7aX0iLCAiIikgaWYg
#1#dGltZV9pbmZvIGlzIG5vdCBOb25lIGVsc2UgIiIKICAgICAgICAgICAgdGltZXN0YW1wcy5hcHBl
#1#bmQoc3RhbXAgb3IgTm9uZSkKICAgICAgICBpbnRlcnZhbF9taW51dGVzID0gTm9uZQogICAgICAg
#1#IHBhcnNlZCA9IFtdCiAgICAgICAgZm9yIHN0YW1wIGluIHRpbWVzdGFtcHM6CiAgICAgICAgICAg
#1#IGlmIG5vdCBzdGFtcDoKICAgICAgICAgICAgICAgIHBhcnNlZC5hcHBlbmQoTm9uZSkKICAgICAg
#1#ICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAgICAgIHRyeToKICAgICAgICAgICAgICAgIHBhcnNl
#1#ZC5hcHBlbmQoZGF0ZXRpbWUuc3RycHRpbWUoc3RhbXAsICIlWS0lbS0lZCAlSDolTTolUy4lZiIp
#1#KQogICAgICAgICAgICBleGNlcHQgVmFsdWVFcnJvcjoKICAgICAgICAgICAgICAgIHRyeToKICAg
#1#ICAgICAgICAgICAgICAgICBwYXJzZWQuYXBwZW5kKGRhdGV0aW1lLnN0cnB0aW1lKHN0YW1wLCAi
#1#JVktJW0tJWQgJUg6JU06JVMiKSkKICAgICAgICAgICAgICAgIGV4Y2VwdCBWYWx1ZUVycm9yOgog
#1#ICAgICAgICAgICAgICAgICAgIHBhcnNlZC5hcHBlbmQoTm9uZSkKICAgICAgICBnYXBzID0gWyhi
#1#IC0gYSkudG90YWxfc2Vjb25kcygpIC8gNjAuMAogICAgICAgICAgICAgICAgZm9yIGEsIGIgaW4g
#1#emlwKHBhcnNlZCwgcGFyc2VkWzE6XSkgaWYgYSBpcyBub3QgTm9uZSBhbmQgYiBpcyBub3QgTm9u
#1#ZV0KICAgICAgICBpZiBnYXBzOgogICAgICAgICAgICBpbnRlcnZhbF9taW51dGVzID0gcm91bmQo
#1#ZmxvYXQobnAubWVkaWFuKGdhcHMpKSwgNCkKICAgICAgICB0aW1lc3RhbXBzX2lzbyA9IFtwLmlz
#1#b2Zvcm1hdCgpIGlmIHAgaXMgbm90IE5vbmUgZWxzZSBOb25lIGZvciBwIGluIHBhcnNlZF0KCiAg
#1#ICAgICAgY2hhbm5lbHMgPSBbXQogICAgICAgIGlmIHRpbWVwb2ludHM6CiAgICAgICAgICAgIHRw
#1#MCA9IHJlczBbdGltZXBvaW50c1swXV0KICAgICAgICAgICAgY2hhbm5lbHMgPSBzb3J0ZWQoCiAg
#1#ICAgICAgICAgICAgICBbayBmb3IgayBpbiB0cDAua2V5cygpIGlmIGsuc3RhcnRzd2l0aCgiQ2hh
#1#bm5lbCIpXSwKICAgICAgICAgICAgICAgIGtleT1sYW1iZGEgeDogaW50KHguc3BsaXQoKVstMV0p
#1#CiAgICAgICAgICAgICkKICAgICAgICBuX2NoID0gbGVuKGNoYW5uZWxzKSBvciAxCgogICAgICAg
#1#IGNoYW5uZWxfbmFtZXMgPSBbXQogICAgICAgIGZvciBpIGluIHJhbmdlKG5fY2gpOgogICAgICAg
#1#ICAgICBjaF9pbmZvID0gZi5nZXQoIkRhdGFTZXRJbmZvIiwge30pLmdldChmIkNoYW5uZWwge2l9
#1#IiwgTm9uZSkKICAgICAgICAgICAgbmFtZV9yYXcgPSBhdHRyX3N0cihjaF9pbmZvLCAiTmFtZSIs
#1#ICIiKSBpZiBjaF9pbmZvIGVsc2UgIiIKICAgICAgICAgICAgbmFtZSA9IHJlLnN1YihyJ1x4MDAu
#1#KicsICcnLCBuYW1lX3Jhdykuc3RyaXAoKQogICAgICAgICAgICBpZiBub3QgbmFtZSBvciByZS5t
#1#YXRjaChyIl5jaChhbm5lbCk/XHMqXGQrJCIsIG5hbWUsIHJlLklHTk9SRUNBU0UpOgogICAgICAg
#1#ICAgICAgICAgbmFtZSA9IGYiQ2hhbm5lbCB7aSsxfSIKICAgICAgICAgICAgY2hhbm5lbF9uYW1l
#1#cy5hcHBlbmQobmFtZSkKCiAgICAgICAgcmV0dXJuIHsKICAgICAgICAgICAgIndpZHRoIjogd2lk
#1#dGgsCiAgICAgICAgICAgICJoZWlnaHQiOiBoZWlnaHQsCiAgICAgICAgICAgICJkZXB0aCI6IGRl
#1#cHRoLAogICAgICAgICAgICAibl9jaGFubmVscyI6IG5fY2gsCiAgICAgICAgICAgICJuX3RpbWVw
#1#b2ludHMiOiBuX3RwLAogICAgICAgICAgICAidm94ZWxfc2l6ZSI6IHsKICAgICAgICAgICAgICAg
#1#ICJ4Ijogcm91bmQodm94X3gsIDYpLAogICAgICAgICAgICAgICAgInkiOiByb3VuZCh2b3hfeSwg
#1#NiksCiAgICAgICAgICAgICAgICAieiI6IHJvdW5kKHZveF96LCA2KQogICAgICAgICAgICB9LAog
#1#ICAgICAgICAgICAjIE1pY3Jvc2NvcGUgc3RhZ2UgZnJhbWUsIGluIHRoZSBhY3F1aXNpdGlvbiB1
#1#bml0ICh1bSkuIFRoaXMgaXMgdGhlIGZyYW1lCiAgICAgICAgICAgICMgSW1hcmlzLWRlcml2ZWQg
#1#b2JqZWN0IGNvb3JkaW5hdGVzIChzcG90cywgc3VyZmFjZXMsIGNlbGwgdHJhY2tzKSBsaXZlIGlu
#1#LAogICAgICAgICAgICAjIHNvIGl0IGlzIHdoYXQgYW4gb3ZlcmxheSBoYXMgdG8gYmUgcmVnaXN0
#1#ZXJlZCBhZ2FpbnN0LgogICAgICAgICAgICAiZXh0ZW50IjogewogICAgICAgICAgICAgICAgInVu
#1#aXQiOiBhdHRyX3N0cihpbmZvLCAiVW5pdCIsICJ1bSIpIG9yICJ1bSIsCiAgICAgICAgICAgICAg
#1#ICAibWluIjogW2V4dF9taW5feCwgZXh0X21pbl95LCBleHRfbWluX3pdLAogICAgICAgICAgICAg
#1#ICAgIm1heCI6IFtleHRfbWF4X3gsIGV4dF9tYXhfeSwgZXh0X21heF96XQogICAgICAgICAgICB9
#1#LAogICAgICAgICAgICAidGltZXN0YW1wcyI6IHRpbWVzdGFtcHNfaXNvLAogICAgICAgICAgICAi
#1#dGltZV9pbnRlcnZhbF9taW51dGVzIjogaW50ZXJ2YWxfbWludXRlcywKICAgICAgICAgICAgImNo
#1#YW5uZWxfbmFtZXMiOiBjaGFubmVsX25hbWVzCiAgICAgICAgfQoKaWYgX19uYW1lX18gPT0gIl9f
#1#bWFpbl9fIjoKICAgIGlmIGxlbihzeXMuYXJndikgPCAzOgogICAgICAgIHByaW50KCJVc2FnZTog
#1#cHl0aG9uIDEtaW1zX21ldGFkYXRhLnB5IDxpbnB1dF9pbXM+IDxvdXRwdXRfanNvbj4iKQogICAg
#1#ICAgIHN5cy5leGl0KDEpCiAgICAKICAgIGlucHV0X3BhdGggPSBQYXRoKHN5cy5hcmd2WzFdKQog
#1#ICAgb3V0cHV0X3BhdGggPSBQYXRoKHN5cy5hcmd2WzJdKQogICAgCiAgICB0cnk6CiAgICAgICAg
#1#bWV0YSA9IHJlYWRfaW1zX21ldGFkYXRhKGlucHV0X3BhdGgpCiAgICAgICAgd2l0aCBvcGVuKG91
#1#dHB1dF9wYXRoLCAidyIsIGVuY29kaW5nPSJ1dGYtOCIpIGFzIGY6CiAgICAgICAgICAgIGpzb24u
#1#ZHVtcChtZXRhLCBmLCBpbmRlbnQ9MikKICAgICAgICBwcmludChmIltNRVRBREFUQV0gRXh0cmFj
#1#dGVkIG1ldGFkYXRhIHRvIHtvdXRwdXRfcGF0aH0iKQogICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBl
#1#OgogICAgICAgIHByaW50KGYiW0VSUk9SXSBGYWlsZWQgdG8gcmVhZCBtZXRhZGF0YToge2V9Iiwg
#1#ZmlsZT1zeXMuc3RkZXJyKQogICAgICAgIHN5cy5leGl0KDEpCg==
:: ---- [2] 2-image_processor.py (18075 octets) ----
#2#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwppbXBvcnQganNvbgppbXBvcnQgc3lzCmZyb20gcGF0aGxp
#2#YiBpbXBvcnQgUGF0aAppbXBvcnQgaDVweQppbXBvcnQgbnVtcHkgYXMgbnAKZnJvbSBQSUwgaW1w
#2#b3J0IEltYWdlCmZyb20gc2NpcHkubmRpbWFnZSBpbXBvcnQgbWVkaWFuX2ZpbHRlciwgYmluYXJ5
#2#X29wZW5pbmcsIGJpbmFyeV9kaWxhdGlvbgpmcm9tIGNvbmN1cnJlbnQuZnV0dXJlcyBpbXBvcnQg
#2#UHJvY2Vzc1Bvb2xFeGVjdXRvcgpmcm9tIGNvbnRleHRsaWIgaW1wb3J0IEV4aXRTdGFjawpmcm9t
#2#IG11bHRpcHJvY2Vzc2luZyBpbXBvcnQgc2hhcmVkX21lbW9yeQppbXBvcnQgb3MKZnJvbSB0cWRt
#2#IGltcG9ydCB0cWRtCgpfX3ZlcnNpb25fXyA9ICIwLjE0LjAiCgojIEhvdyBtYW55IHRpbWVwb2lu
#2#dHMgYXJlIHNhbXBsZWQgdG8gZXN0YWJsaXNoIHRoZSBzaGFyZWQgd2luZG93IG9mIGEgdGltZWxh
#2#cHNlLgojIEV2ZW5seSBzcGFjZWQgb3ZlciB0aGUgc2VyaWVzIGFuZCBhbHdheXMgaW5jbHVkaW5n
#2#IHRoZSBmaXJzdCBhbmQgdGhlIGxhc3QgZnJhbWUuCkdMT0JBTF9OT1JNX1NBTVBMRVMgPSA4CgoK
#2#ZGVmIF93b3JrZXJfY291bnQoKSAtPiBpbnQ6CiAgICAiIiJTaXplIG9mIHRoZSBtZWRpYW4tZmls
#2#dGVyIHBvb2wuCgogICAgT25lIHdvcmtlciBwZXIgbG9naWNhbCBjb3JlIHNhdHVyYXRlcyB0aGUg
#2#Q1BVLCBidXQgZWFjaCBvbmUgYWxzbyBhbGxvY2F0ZXMgaXRzIG93bgogICAgZmxvYXQzMiBjb3Bp
#2#ZXMgb2YgYSBaLWJsb2NrIHBsdXMgdGhlIHNjaXB5IG1lZGlhbiB0ZW1wb3JhcmllcyDigJQgcm91
#2#Z2hseSBhIGdpZ2FieXRlCiAgICBhcGllY2Ugb24gYSBsYXJnZSBmaWVsZC4gQWRkZWQgdG8gdGhl
#2#IHRocmVlIHdob2xlLXZvbHVtZSBzaGFyZWQgYmxvY2tzIChmbG9hdDMyICsKICAgIGJvb2wgbWFz
#2#ayArIHVpbnQ4IG91dHB1dCksIGEgMjItY29yZSBtYWNoaW5lIGFza3MgZm9yIH4zMyBHaUIgb2Yg
#2#V2luZG93cyAqY29tbWl0KgogICAgYXQgb25jZSwgYW5kIGNvbW1pdCBpcyBib3VuZGVkIGJ5IFJB
#2#TSArIHBhZ2UgZmlsZSwgbm90IGJ5IGZyZWUgUkFNLgoKICAgIE1lYXN1cmVkIGZhaWx1cmU6IDM3
#2#ODl4Mzc4OXgxMjV4NGNoIG9uIGEgNjMuNSBHaUIgbWFjaGluZSB3aG9zZSBjb21taXQgbGltaXQg
#2#d2FzCiAgICA4OS42IEdpQiBidXQgd2hpY2ggaGFkIG9ubHkgMzYuMyBHaUIgb2YgaXQgZnJlZSAo
#2#b3RoZXIgc2VydmljZXMgcnVubmluZykuIFRoZSBwb29sCiAgICBkaWVkIGF0IGJsb2NrIDQgb2Yg
#2#MzIgd2l0aCBXaW5FcnJvciAxNDU1ICJ0aGUgcGFnaW5nIGZpbGUgaXMgdG9vIHNtYWxsIiwgYWZ0
#2#ZXIgdGhlCiAgICBvcmNoZXN0cmF0b3IgaGFkIGFscmVhZHkgY2xlYXJlZCB0aGUgZGF0YXNldCdz
#2#IGJyaWNrcyAtLSBhIHB1Ymxpc2hlZCBkYXRhc2V0IGxvc3QgdG8KICAgIGEgdHJhbnNpZW50IHJl
#2#c291cmNlIHNob3J0YWdlLgoKICAgIExVTUVOX1BSRVBST0NFU1NfV09SS0VSUyBjYXBzIHRoZSBw
#2#b29sIHNvIGEgYnVzeSBvciBzbWFsbGVyIG1hY2hpbmUgY2FuIHN0aWxsIGZpbmlzaC4KICAgIFVu
#2#c2V0LCB0aGUgYmVoYXZpb3VyIGlzIGV4YWN0bHkgYXMgYmVmb3JlOiBvbmUgd29ya2VyIHBlciBs
#2#b2dpY2FsIGNvcmUuCiAgICAiIiIKICAgIHJhdyA9IG9zLmVudmlyb24uZ2V0KCJMVU1FTl9QUkVQ
#2#Uk9DRVNTX1dPUktFUlMiLCAiIikuc3RyaXAoKQogICAgaWYgcmF3OgogICAgICAgIHRyeToKICAg
#2#ICAgICAgICAgbiA9IGludChyYXcpCiAgICAgICAgICAgIGlmIG4gPj0gMToKICAgICAgICAgICAg
#2#ICAgIHJldHVybiBtaW4obiwgb3MuY3B1X2NvdW50KCkgb3IgMSkKICAgICAgICAgICAgcHJpbnQo
#2#ZiJbUFJPQ0VTU10gTFVNRU5fUFJFUFJPQ0VTU19XT1JLRVJTPXtyYXchcn0gaWdub3JlIChkb2l0
#2#IGV0cmUgPj0gMSkiLCBmbHVzaD1UcnVlKQogICAgICAgIGV4Y2VwdCBWYWx1ZUVycm9yOgogICAg
#2#ICAgICAgICBwcmludChmIltQUk9DRVNTXSBMVU1FTl9QUkVQUk9DRVNTX1dPUktFUlM9e3JhdyFy
#2#fSBpZ25vcmUgKGVudGllciBhdHRlbmR1KSIsIGZsdXNoPVRydWUpCiAgICByZXR1cm4gb3MuY3B1
#2#X2NvdW50KCkgb3IgMQoKCmRlZiBfY29ybmVyX3NhbXBsZXModm9sLCBXLCBILCBEKToKICAgICIi
#2#IlRoZSA4IGNvcm5lciBjdWJlcyDigJQgcHVyZSBjYW1lcmEgYmFja2dyb3VuZCwgbm8gc3BlY2lt
#2#ZW4gdGhlcmUuIiIiCiAgICBjb3JuZXJfc2l6ZSA9IG1heCgxLCBtaW4oMzIsIFcgLy8gNCwgSCAv
#2#LyA0LCBEIC8vIDQpKQogICAgY29ybmVycyA9IFsKICAgICAgICB2b2xbOmNvcm5lcl9zaXplLCA6
#2#Y29ybmVyX3NpemUsIDpjb3JuZXJfc2l6ZV0sCiAgICAgICAgdm9sWzpjb3JuZXJfc2l6ZSwgOmNv
#2#cm5lcl9zaXplLCAtY29ybmVyX3NpemU6XSwKICAgICAgICB2b2xbOmNvcm5lcl9zaXplLCAtY29y
#2#bmVyX3NpemU6LCA6Y29ybmVyX3NpemVdLAogICAgICAgIHZvbFs6Y29ybmVyX3NpemUsIC1jb3Ju
#2#ZXJfc2l6ZTosIC1jb3JuZXJfc2l6ZTpdLAogICAgICAgIHZvbFstY29ybmVyX3NpemU6LCA6Y29y
#2#bmVyX3NpemUsIDpjb3JuZXJfc2l6ZV0sCiAgICAgICAgdm9sWy1jb3JuZXJfc2l6ZTosIDpjb3Ju
#2#ZXJfc2l6ZSwgLWNvcm5lcl9zaXplOl0sCiAgICAgICAgdm9sWy1jb3JuZXJfc2l6ZTosIC1jb3Ju
#2#ZXJfc2l6ZTosIDpjb3JuZXJfc2l6ZV0sCiAgICAgICAgdm9sWy1jb3JuZXJfc2l6ZTosIC1jb3Ju
#2#ZXJfc2l6ZTosIC1jb3JuZXJfc2l6ZTpdCiAgICBdCiAgICByZXR1cm4gbnAuY29uY2F0ZW5hdGUo
#2#W2MuZmxhdHRlbigpIGZvciBjIGluIGNvcm5lcnNdKQoKCmRlZiBfZXN0aW1hdGVfZ2xvYmFsX2Jv
#2#dW5kcyhyZXMwLCB0cF9rZXlzLCBjX2lkeCwgVywgSCwgRCk6CiAgICAiIiJTaGFyZWQgW2JnX2Zs
#2#b29yLCBzaWdfbWF4XSB3aW5kb3cgZm9yIG9uZSBjaGFubmVsIG9mIGEgdGltZWxhcHNlLgoKICAg
#2#IExldmVsbGluZyBlYWNoIGZyYW1lIGFnYWluc3QgaXRzIG93biBwZXJjZW50aWxlcyBtYWtlcyB0
#2#aGUgc2VyaWVzIGZsaWNrZXI6IGFzCiAgICB0aGUgc3BlY2ltZW4gYmxlYWNoZXMsIGEgcGVyLWZy
#2#YW1lIHdpbmRvdyBrZWVwcyByZS1zdHJldGNoaW5nIGEgZmFkaW5nIHNpZ25hbAogICAgYmFjayB0
#2#byBmdWxsIHJhbmdlLCBzbyB0aGUgYXBwYXJlbnQgYnJpZ2h0bmVzcyBzdGF5cyBjb25zdGFudCB3
#2#aGlsZSB0aGUgcmVhbAogICAgb25lIGNvbGxhcHNlcyDigJQgdmlzdWFsbHkgd3JvbmcgYW5kIHF1
#2#YW50aXRhdGl2ZWx5IG1pc2xlYWRpbmcuIFBvb2xpbmcgdGhlCiAgICBjb3JuZXIgbm9pc2UgYW5k
#2#IHRoZSBzdWItc2FtcGxlZCBzaWduYWwgb3ZlciBzZXZlcmFsIGZyYW1lcyB5aWVsZHMgT05FIHdp
#2#bmRvdywKICAgIHdoaWNoIGlzIHRoZSBzYW1lIGVzdGltYXRvciB0aGUgc2luZ2xlLXRpbWVwb2lu
#2#dCBwYXRoIHVzZXMsIGp1c3QgZXZhbHVhdGVkIG9uCiAgICB0aGUgcG9vbGVkIHNlcmllcy4gRnJh
#2#bWVzIHRoZW4gZGltIGV4YWN0bHkgYXMgbXVjaCBhcyB0aGUgc3BlY2ltZW4gcmVhbGx5IGRpZC4K
#2#ICAgICIiIgogICAgbl90cCA9IGxlbih0cF9rZXlzKQogICAgY291bnQgPSBtaW4oR0xPQkFMX05P
#2#Uk1fU0FNUExFUywgbl90cCkKICAgIGlmIGNvdW50ID49IG5fdHA6CiAgICAgICAgc2FtcGxlX2lk
#2#eCA9IGxpc3QocmFuZ2Uobl90cCkpCiAgICBlbHNlOgogICAgICAgIHNhbXBsZV9pZHggPSBzb3J0
#2#ZWQoe2ludChyb3VuZChpICogKG5fdHAgLSAxKSAvIChjb3VudCAtIDEpKSkgZm9yIGkgaW4gcmFu
#2#Z2UoY291bnQpfSkKCiAgICBjb3JuZXJfcG9vbCwgc2lnbmFsX3Bvb2wgPSBbXSwgW10KICAgIHBy
#2#aW50KGYiW1BST0NFU1NdIEdsb2JhbCBub3JtYWxpemF0aW9uOiBzYW1wbGluZyB0aW1lcG9pbnRz
#2#IHtzYW1wbGVfaWR4fSBmb3IgY2hhbm5lbCB7Y19pZHh9Li4uIiwKICAgICAgICAgIGZsdXNoPVRy
#2#dWUpCiAgICBmb3IgdF9pZHggaW4gc2FtcGxlX2lkeDoKICAgICAgICBjaF9rZXlzID0gc29ydGVk
#2#KFtrIGZvciBrIGluIHJlczBbdHBfa2V5c1t0X2lkeF1dLmtleXMoKSBpZiBrLnN0YXJ0c3dpdGgo
#2#IkNoYW5uZWwiKV0sCiAgICAgICAgICAgICAgICAgICAgICAgICBrZXk9bGFtYmRhIHg6IGludCh4
#2#LnNwbGl0KClbLTFdKSkKICAgICAgICBpZiBjX2lkeCA+PSBsZW4oY2hfa2V5cyk6CiAgICAgICAg
#2#ICAgIGNvbnRpbnVlCiAgICAgICAgdm9sID0gcmVzMFt0cF9rZXlzW3RfaWR4XV1bY2hfa2V5c1tj
#2#X2lkeF1dWyJEYXRhIl1bOkQsIDpILCA6V10uYXN0eXBlKG5wLmZsb2F0MzIpCiAgICAgICAgY29y
#2#bmVyX3Bvb2wuYXBwZW5kKF9jb3JuZXJfc2FtcGxlcyh2b2wsIFcsIEgsIEQpKQogICAgICAgIHNp
#2#Z25hbF9wb29sLmFwcGVuZCh2b2xbOjo0LCA6OjQsIDo6NF0uZmxhdHRlbigpKQogICAgICAgIGRl
#2#bCB2b2wKCiAgICBwb29sZWQgPSBucC5jb25jYXRlbmF0ZShzaWduYWxfcG9vbCkKICAgIGJnX2Zs
#2#b29yID0gZmxvYXQobnAucGVyY2VudGlsZShucC5jb25jYXRlbmF0ZShjb3JuZXJfcG9vbCksIDk5
#2#LjApKQoKICAgICMgV2hpdGUgcG9pbnQgPSAic2F0dXJhdGUgdGhlIGJyaWdodGVzdCAwLjEgJSBP
#2#RiBUSEUgU0lHTkFMIiwgbm90IG9mIHRoZSB2b2x1bWUuCiAgICAjIFRoZSBzaW5nbGUtdGltZXBv
#2#aW50IHJ1bGUgdGFrZXMgdGhlIDk5Ljl0aCBwZXJjZW50aWxlIG9mIGV2ZXJ5IHZveGVsLCB3aGlj
#2#aAogICAgIyBhc3N1bWVzIHRoZSBzcGVjaW1lbiBmaWxscyBhIGdvb2Qgc2hhcmUgb2YgdGhlIGZy
#2#YW1lLiBBIHRpbWVsYXBzZSBvZiBhIHNwYXJzZQogICAgIyBmbHVvcmVzY2VudCBzdHJ1Y3R1cmUg
#2#YnJlYWtzIHRoYXQgYXNzdW1wdGlvbjogaGVyZSB0aGUgc2lnbmFsIGlzIDAuNCAlIG9mIHRoZQog
#2#ICAgIyB2b3hlbHMsIHNvIGEgd2hvbGUtdm9sdW1lIHBlcmNlbnRpbGUgc2l0cyBpbnNpZGUgdGhl
#2#IGJhY2tncm91bmQgYW5kIGNsaXBzIDE1ICUKICAgICMgb2YgdGhlIHJlYWwgc2lnbmFsIHRvIHB1
#2#cmUgd2hpdGUuIFJhbmtpbmcgb25seSB0aGUgdm94ZWxzIGFib3ZlIHRoZSBub2lzZSBmbG9vcgog
#2#ICAgIyBrZWVwcyB0aGUgc2FtZSBpbnRlbnQgYW5kIGRyb3BzIHRoZSBjbGlwcGVkIGZyYWN0aW9u
#2#IHRvIH4wLjA2ICUuCiAgICBhYm92ZSA9IHBvb2xlZFtwb29sZWQgPiBiZ19mbG9vcl0KICAgIGlm
#2#IGFib3ZlLnNpemUgPj0gMTAwMDoKICAgICAgICBzaWdfbWF4ID0gZmxvYXQobnAucGVyY2VudGls
#2#ZShhYm92ZSwgOTkuOSkpCiAgICAgICAgYmFzaXMgPSBmInthYm92ZS5zaXplfSB2b3hlbHMgYWJv
#2#dmUgdGhlIG5vaXNlIGZsb29yIgogICAgZWxzZToKICAgICAgICBzaWdfbWF4ID0gZmxvYXQobnAu
#2#cGVyY2VudGlsZShwb29sZWQsIDk5LjkpKQogICAgICAgIGJhc2lzID0gIndob2xlIHZvbHVtZSAo
#2#dG9vIGxpdHRsZSBzaWduYWwgdG8gcmFuaykiCiAgICBwcmludChmIiAgICBnbG9iYWwgYmdfZmxv
#2#b3I9e2JnX2Zsb29yOi4yZn0gIHNpZ19tYXg9e3NpZ19tYXg6LjJmfSAiCiAgICAgICAgICBmIihw
#2#b29sZWQgb3ZlciB7bGVuKGNvcm5lcl9wb29sKX0gdGltZXBvaW50cywgd2hpdGUgcG9pbnQgZnJv
#2#bSB7YmFzaXN9KSIsIGZsdXNoPVRydWUpCiAgICByZXR1cm4gYmdfZmxvb3IsIHNpZ19tYXgKCmRl
#2#ZiBwcm9jZXNzX3pfYmxvY2soYXJncyk6CiAgICAiIiJTZWxlY3RpdmUgTWFza2VkIE1lZGlhbiBG
#2#aWx0ZXJpbmcgKyBXaW5kb3cgTGV2ZWxpbmcgZm9yIG9uZSBaLWJsb2NrLgoKICAgIEluc2lkZSB0
#2#aGUgc2lnbmFsIG1hc2sgdGhlIG9yaWdpbmFsIChzaGFycCkgYmlvbG9naWNhbCBzaWduYWwgaXMg
#2#a2VwdCBhcy1pczsKICAgIG91dHNpZGUgdGhlIG1hc2sgdGhlIGJhY2tncm91bmQgaXMgcmVwbGFj
#2#ZWQgYnkgYSAzRCBtZWRpYW4gKHNpemU9MykgdGhhdAogICAgY3J1c2hlcyBzaG90LW5vaXNlIGFu
#2#ZCBpc29sYXRlZCBob3QgcGl4ZWxzIHdpdGhvdXQgYmx1cnJpbmcgdGhlIGNlbGxzLiBUaGUKICAg
#2#IGJsb2NrIGNhcnJpZXMgYSDCsTEgWiBoYWxvIHNvIHRoZSBtZWRpYW4gc2VlcyByZWFsIG5laWdo
#2#Ym91cnMgYWNyb3NzIGJsb2NrCiAgICBzZWFtczsgdGhlIGhhbG8gaXMgc3RyaXBwZWQgYmVmb3Jl
#2#IHdyaXRpbmcgYmFjay4gRmluYWxseSBhIFdpbmRvdyBMZXZlbGluZyBtYXBzCiAgICBbYmdfZmxv
#2#b3IsIHNpZ19tYXhdIC0+IFswLCAyNTVdICh1aW50OCkg4oCUIGFueSB2YWx1ZSA8PSBiZ19mbG9v
#2#ciBjb2xsYXBzZXMgdG8KICAgIGFuIGFic29sdXRlIDAsIGd1YXJhbnRlZWluZyBwdXJlLWJsYWNr
#2#IGVtcHR5IHNwYWNlIGZvciB0aGUgU1ZSIGJyaWNrIHBhY2tlci4KCiAgICBUaGUgdm9sdW1lLCB0
#2#aGUgbWFzayBhbmQgdGhlIG91dHB1dCBidWZmZXIgbGl2ZSBpbiBzaGFyZWQgbWVtb3J5OiB0aGUg
#2#d29ya2VyCiAgICByZWNlaXZlcyBvbmx5IG5hbWVzIGFuZCBpbmRpY2VzLiBTaGlwcGluZyB0aGUg
#2#YmxvY2tzIHRoZW1zZWx2ZXMgdGhyb3VnaCB0aGUKICAgIHByb2Nlc3MgcG9vbCBtb3ZlZCB+Mjg1
#2#IE1CIHBlciB0aW1lcG9pbnQgYWNyb3NzIFdpbmRvd3MgcGlwZXMgYW5kIGV4aGF1c3RlZCB0aGUK
#2#ICAgIE9TICgiV2luRXJyb3IgMTQ1MDogaW5zdWZmaWNpZW50IHN5c3RlbSByZXNvdXJjZXMiKSB0
#2#aGUgbW9tZW50IHRoZSBwaXBlbGluZSBoYWQKICAgIG1vcmUgdGhhbiBvbmUgZnJhbWUgdG8gZ3Jp
#2#bmQgdGhyb3VnaC4KICAgICIiIgogICAgKHZvbF9uYW1lLCBtYXNrX25hbWUsIG91dF9uYW1lLCBz
#2#aGFwZSwgel9zdGFydCwgel9lbmQsCiAgICAgaGFsb19sbywgaGFsb19oaSwgYmdfZmxvb3IsIHNp
#2#Z19tYXgpID0gYXJncwoKICAgIHZvbF9zaG0gPSBzaGFyZWRfbWVtb3J5LlNoYXJlZE1lbW9yeShu
#2#YW1lPXZvbF9uYW1lKQogICAgbWFza19zaG0gPSBzaGFyZWRfbWVtb3J5LlNoYXJlZE1lbW9yeShu
#2#YW1lPW1hc2tfbmFtZSkKICAgIG91dF9zaG0gPSBzaGFyZWRfbWVtb3J5LlNoYXJlZE1lbW9yeShu
#2#YW1lPW91dF9uYW1lKQogICAgdHJ5OgogICAgICAgIHZvbCA9IG5wLm5kYXJyYXkoc2hhcGUsIGR0
#2#eXBlPW5wLmZsb2F0MzIsIGJ1ZmZlcj12b2xfc2htLmJ1ZikKICAgICAgICBtYXNrID0gbnAubmRh
#2#cnJheShzaGFwZSwgZHR5cGU9Ym9vbCwgYnVmZmVyPW1hc2tfc2htLmJ1ZikKICAgICAgICBvdXQg
#2#PSBucC5uZGFycmF5KHNoYXBlLCBkdHlwZT1ucC51aW50OCwgYnVmZmVyPW91dF9zaG0uYnVmKQoK
#2#ICAgICAgICBpZiBzaWdfbWF4IC0gYmdfZmxvb3IgPD0gMC4wOgogICAgICAgICAgICBzaWdfbWF4
#2#ID0gYmdfZmxvb3IgKyAxLjAKCiAgICAgICAgenMsIHplID0gel9zdGFydCAtIGhhbG9fbG8sIHpf
#2#ZW5kICsgaGFsb19oaQogICAgICAgIGJsb2NrX2RhdGEgPSB2b2xbenM6emVdCiAgICAgICAgYmxv
#2#Y2tfbWFzayA9IG1hc2tbenM6emVdCgogICAgICAgICMgTWFza2VkIGNvbXBvc2l0aW5nOiBrZWVw
#2#IHNpZ25hbCBpbnNpZGUgdGhlIG1hc2ssIHNtb290aCB0aGUgcmVzdAogICAgICAgIHNtb290aGVk
#2#ID0gbWVkaWFuX2ZpbHRlcihibG9ja19kYXRhLCBzaXplPTMpCiAgICAgICAgY29tcG9zaXRlID0g
#2#bnAud2hlcmUoYmxvY2tfbWFzaywgYmxvY2tfZGF0YSwgc21vb3RoZWQpCgogICAgICAgICMgV2lu
#2#ZG93IExldmVsaW5nIFtiZ19mbG9vciwgc2lnX21heF0gLT4gWzAsIDI1NV0KICAgICAgICBjbGVh
#2#biA9IG5wLmNsaXAoY29tcG9zaXRlLCBiZ19mbG9vciwgc2lnX21heCkKICAgICAgICBub3JtID0g
#2#KGNsZWFuIC0gYmdfZmxvb3IpIC8gKHNpZ19tYXggLSBiZ19mbG9vcikKICAgICAgICBibG9ja191
#2#OCA9IChub3JtICogMjU1LjApLmFzdHlwZShucC51aW50OCkKCiAgICAgICAgIyBTdHJpcCB0aGUg
#2#WiBoYWxvIGJlZm9yZSByZWFzc2VtYmx5CiAgICAgICAgel9oaSA9IGJsb2NrX3U4LnNoYXBlWzBd
#2#IC0gaGFsb19oaQogICAgICAgIG91dFt6X3N0YXJ0OnpfZW5kXSA9IGJsb2NrX3U4W2hhbG9fbG86
#2#el9oaV0KICAgICAgICByZXR1cm4gel9zdGFydAogICAgZmluYWxseToKICAgICAgICB2b2xfc2ht
#2#LmNsb3NlKCkKICAgICAgICBtYXNrX3NobS5jbG9zZSgpCiAgICAgICAgb3V0X3NobS5jbG9zZSgp
#2#CgpkZWYgcHJvY2Vzc19pbWFnZShpbnB1dF9pbXM6IFBhdGgsIG1ldGFkYXRhX2pzb246IFBhdGgs
#2#IHRlbXBfZGlyOiBQYXRoKToKICAgIHdpdGggb3BlbihtZXRhZGF0YV9qc29uLCAiciIsIGVuY29k
#2#aW5nPSJ1dGYtOCIpIGFzIGY6CiAgICAgICAgbWV0YSA9IGpzb24ubG9hZChmKQogICAgICAgIAog
#2#ICAgVywgSCwgRCA9IG1ldGFbIndpZHRoIl0sIG1ldGFbImhlaWdodCJdLCBtZXRhWyJkZXB0aCJd
#2#CiAgICBuX2NoID0gbWV0YVsibl9jaGFubmVscyJdCiAgICBuX3RwID0gbWV0YVsibl90aW1lcG9p
#2#bnRzIl0KICAgIAogICAgdGVtcF9kaXIubWtkaXIocGFyZW50cz1UcnVlLCBleGlzdF9vaz1UcnVl
#2#KQogICAgCiAgICAjIE9wZW4gSU1TIGZpbGUKICAgIGZfaW1zID0gaDVweS5GaWxlKHN0cihpbnB1
#2#dF9pbXMpLCAiciIpCiAgICByZXMwID0gZl9pbXNbIkRhdGFTZXQiXVsiUmVzb2x1dGlvbkxldmVs
#2#IDAiXQogICAgdHBfa2V5cyA9IHNvcnRlZChbayBmb3IgayBpbiByZXMwLmtleXMoKSBpZiBrLnN0
#2#YXJ0c3dpdGgoIlRpbWVQb2ludCIpXSwga2V5PWxhbWJkYSB4OiBpbnQoeC5zcGxpdCgpWy0xXSkp
#2#CiAgICAKICAgICMgV2Ugd2lsbCBzYXZlIGRvd25zY2FsZWQgc2hhcGVzIGluIHByb2Nlc3Npbmdf
#2#bWV0YS5qc29uCiAgICBsb2RfaW5mbyA9IFtdCiAgICAKICAgICMgRGV0ZXJtaW5lIGRvd25zY2Fs
#2#aW5nIExPRCBsZXZlbHMKICAgIGxvZCA9IDAKICAgIGxvZF9pbmZvLmFwcGVuZCh7CiAgICAgICAg
#2#ImxvZCI6IGxvZCwKICAgICAgICAid2lkdGgiOiBXLAogICAgICAgICJoZWlnaHQiOiBILAogICAg
#2#ICAgICJkZXB0aCI6IEQKICAgIH0pCiAgICAKICAgIG1heF9kaW0gPSBtYXgoVywgSCkKICAgIHRh
#2#cmdldF9kaW1zID0gW10KICAgIGN1cnJfZGltID0gMjU2CiAgICB3aGlsZSBjdXJyX2RpbSA8IG1h
#2#eF9kaW06CiAgICAgICAgdGFyZ2V0X2RpbXMuYXBwZW5kKGN1cnJfZGltKQogICAgICAgIGN1cnJf
#2#ZGltICo9IDIKICAgICAgICAKICAgIHRhcmdldF9kaW1zLnJldmVyc2UoKQogICAgCiAgICBmb3Ig
#2#dGFyZ2V0X2RpbSBpbiB0YXJnZXRfZGltczoKICAgICAgICBsb2QgKz0gMQogICAgICAgIGxvZF9p
#2#bmZvLmFwcGVuZCh7CiAgICAgICAgICAgICJsb2QiOiBsb2QsCiAgICAgICAgICAgICJ3aWR0aCI6
#2#IHRhcmdldF9kaW0sCiAgICAgICAgICAgICJoZWlnaHQiOiB0YXJnZXRfZGltLAogICAgICAgICAg
#2#ICAiZGVwdGgiOiBECiAgICAgICAgfSkKICAgICAgICAKICAgIHByaW50KGYiW1BST0NFU1NdIExP
#2#RCBsZXZlbHMgdG8gZ2VuZXJhdGU6IHtsZW4obG9kX2luZm8pfSIpCiAgICBmb3IgbGkgaW4gbG9k
#2#X2luZm86CiAgICAgICAgcHJpbnQoZiIgIExPRCB7bGlbJ2xvZCddfToge2xpWyd3aWR0aCddfXh7
#2#bGlbJ2hlaWdodCddfXh7bGlbJ2RlcHRoJ119IikKCiAgICAjIEEgdGltZWxhcHNlIGlzIGxldmVs
#2#bGVkIGFnYWluc3QgT05FIHdpbmRvdyBwZXIgY2hhbm5lbCAoc2VlCiAgICAjIF9lc3RpbWF0ZV9n
#2#bG9iYWxfYm91bmRzKTsgYSBzaW5nbGUtdGltZXBvaW50IGRhdGFzZXQga2VlcHMgdGhlIGhpc3Rv
#2#cmljYWwKICAgICMgcGVyLXZvbHVtZSBlc3RpbWF0ZSBzbyBwcmV2aW91c2x5IHB1Ymxpc2hlZCBk
#2#YXRhc2V0cyByZXByb2Nlc3MgaWRlbnRpY2FsbHkuCiAgICBpc190aW1lbGFwc2UgPSBuX3RwID4g
#2#MQogICAgZ2xvYmFsX2JvdW5kcyA9IHt9CiAgICBpZiBpc190aW1lbGFwc2U6CiAgICAgICAgZm9y
#2#IGNfaWR4IGluIHJhbmdlKG5fY2gpOgogICAgICAgICAgICBnbG9iYWxfYm91bmRzW2NfaWR4XSA9
#2#IF9lc3RpbWF0ZV9nbG9iYWxfYm91bmRzKHJlczAsIHRwX2tleXMsIGNfaWR4LCBXLCBILCBEKQoK
#2#ICAgICMgUGVyLSh0aW1lcG9pbnQsIGNoYW5uZWwpIGJyaWdodG5lc3Mgb2YgdGhlIFJBVyBzaWdu
#2#YWwsIHJlY29yZGVkIGJ1dCBuZXZlcgogICAgIyBiYWtlZCBpbnRvIHRoZSB2b3hlbHM6IGJsZWFj
#2#aGluZyBjb3JyZWN0aW9uIHN0YXlzIGEgcmV2ZXJzaWJsZSBkaXNwbGF5IGNob2ljZS4KICAgIHNp
#2#Z25hbF9sZXZlbHMgPSB7fQoKICAgIHNoYXBlID0gKEQsIEgsIFcpCiAgICBuX3ZveGVscyA9IEQg
#2#KiBIICogVwoKICAgIGZvciB0X2lkeCwgdHBfa2V5IGluIGVudW1lcmF0ZSh0cF9rZXlzKToKICAg
#2#ICAgICBjaF9rZXlzID0gc29ydGVkKFtrIGZvciBrIGluIHJlczBbdHBfa2V5XS5rZXlzKCkgaWYg
#2#ay5zdGFydHN3aXRoKCJDaGFubmVsIildLCBrZXk9bGFtYmRhIHg6IGludCh4LnNwbGl0KClbLTFd
#2#KSkKCiAgICAgICAgZm9yIGNfaWR4LCBjaF9rZXkgaW4gZW51bWVyYXRlKGNoX2tleXMpOgogICAg
#2#ICAgICAgcHJpbnQoZiJbUFJPQ0VTU10gUHJvY2Vzc2luZyBDaGFubmVsIHtjX2lkeH0gKFQge3Rf
#2#aWR4fSkuLi4iLCBmbHVzaD1UcnVlKQogICAgICAgICAgZHMgPSByZXMwW3RwX2tleV1bY2hfa2V5
#2#XVsiRGF0YSJdCgogICAgICAgICAgIyBUaGUgdm9sdW1lLCBpdHMgbWFzayBhbmQgdGhlIGxldmVs
#2#bGVkIG91dHB1dCBhcmUgYWxsb2NhdGVkIGluIHNoYXJlZAogICAgICAgICAgIyBtZW1vcnkgc28g
#2#dGhlIHdvcmtlciBwb29sIGFkZHJlc3NlcyB0aGVtIGJ5IG5hbWUgaW5zdGVhZCBvZiBwaWNrbGlu
#2#ZwogICAgICAgICAgIyBzbGljZXMgYWNyb3NzIHByb2Nlc3MgcGlwZXMgKHNlZSBwcm9jZXNzX3pf
#2#YmxvY2spLgogICAgICAgICAgd2l0aCBFeGl0U3RhY2soKSBhcyBzdGFjazoKICAgICAgICAgICAg
#2#dm9sX3NobSA9IHNoYXJlZF9tZW1vcnkuU2hhcmVkTWVtb3J5KGNyZWF0ZT1UcnVlLCBzaXplPW5f
#2#dm94ZWxzICogNCkKICAgICAgICAgICAgbWFza19zaG0gPSBzaGFyZWRfbWVtb3J5LlNoYXJlZE1l
#2#bW9yeShjcmVhdGU9VHJ1ZSwgc2l6ZT1uX3ZveGVscykKICAgICAgICAgICAgb3V0X3NobSA9IHNo
#2#YXJlZF9tZW1vcnkuU2hhcmVkTWVtb3J5KGNyZWF0ZT1UcnVlLCBzaXplPW5fdm94ZWxzKQogICAg
#2#ICAgICAgICAjIEV4aXRTdGFjayB1bndpbmRzIExJRk8sIHNvIHJlZ2lzdGVyaW5nIHVubGluayBi
#2#ZWZvcmUgY2xvc2UgYmVmb3JlIHRoZSBwb29sCiAgICAgICAgICAgICMgdGVhcnMgZG93biBpbiB0
#2#aGUgb25seSBvcmRlciB0aGF0IGlzIHNhZmU6IHdvcmtlcnMgZ29uZSwgdGhlbiB2aWV3cyBjbG9z
#2#ZWQsCiAgICAgICAgICAgICMgdGhlbiB0aGUgYmxvY2tzIHJlbGVhc2VkLiAoU2hhcmVkTWVtb3J5
#2#IGlzIG5vdCBhIGNvbnRleHQgbWFuYWdlciBiZWZvcmUgMy4xMy4pCiAgICAgICAgICAgIGZvciBz
#2#aG0gaW4gKHZvbF9zaG0sIG1hc2tfc2htLCBvdXRfc2htKToKICAgICAgICAgICAgICAgIHN0YWNr
#2#LmNhbGxiYWNrKHNobS51bmxpbmspCiAgICAgICAgICAgIGZvciBzaG0gaW4gKHZvbF9zaG0sIG1h
#2#c2tfc2htLCBvdXRfc2htKToKICAgICAgICAgICAgICAgIHN0YWNrLmNhbGxiYWNrKHNobS5jbG9z
#2#ZSkKICAgICAgICAgICAgZXhlY3V0b3IgPSBzdGFjay5lbnRlcl9jb250ZXh0KFByb2Nlc3NQb29s
#2#RXhlY3V0b3IobWF4X3dvcmtlcnM9X3dvcmtlcl9jb3VudCgpKSkKCiAgICAgICAgICAgIHZvbCA9
#2#IG5wLm5kYXJyYXkoc2hhcGUsIGR0eXBlPW5wLmZsb2F0MzIsIGJ1ZmZlcj12b2xfc2htLmJ1ZikK
#2#ICAgICAgICAgICAgbWFzayA9IG5wLm5kYXJyYXkoc2hhcGUsIGR0eXBlPWJvb2wsIGJ1ZmZlcj1t
#2#YXNrX3NobS5idWYpCiAgICAgICAgICAgIHZvbF91OCA9IG5wLm5kYXJyYXkoc2hhcGUsIGR0eXBl
#2#PW5wLnVpbnQ4LCBidWZmZXI9b3V0X3NobS5idWYpCgogICAgICAgICAgICBwcmludChmIiAgTG9h
#2#ZGluZyAzRCB2b2x1bWUgKHtXfXh7SH14e0R9KSBpbiBtZW1vcnkgYXMgRmxvYXQzMi4uLiIsIGZs
#2#dXNoPVRydWUpCiAgICAgICAgICAgICMgUmVhZCBlbnRpcmUgdm9sdW1lIGRpcmVjdGx5IHRvIGFs
#2#bG93IGg1cHkgQy1jb3JlIHRvIG9wdGltaXplIGNodW5rIHJlYWRzCiAgICAgICAgICAgICMgRXh0
#2#cmVtZWx5IGZhc3QgY29tcGFyZWQgdG8gcmVhZGluZyBzbGljZS1ieS1zbGljZSBpbiBQeXRob24K
#2#ICAgICAgICAgICAgdm9sWzpdID0gZHNbOkQsIDpILCA6V10KCiAgICAgICAgICAgICMg4pSA4pSA
#2#4pSAIFN0ZXAgMSA6IEJvdW5kIGVzdGltYXRpb24gKENvcm5lciBTYW1wbGluZykg4pSA4pSA4pSA
#2#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICAgICAgICAg
#2#ICMgYmdfZmxvb3IgPSA5OXRoIHBlcmNlbnRpbGUgb2YgdGhlIDggdm9sdW1lIGNvcm5lcnMgKHB1
#2#cmUgY2FtZXJhCiAgICAgICAgICAgICMgYmFja2dyb3VuZCwgbm8gZW1icnlvIHRoZXJlKTsgc2ln
#2#X21heCA9IDk5Ljl0aCBwZXJjZW50aWxlIG9mIHRoZQogICAgICAgICAgICAjIGdsb2JhbGx5IHN1
#2#Yi1zYW1wbGVkIHZvbHVtZSAoc2F0dXJhdGUgdGhlIGJyaWdodGVzdCAwLjEgJSkuCiAgICAgICAg
#2#ICAgIHByaW50KCIgIFN0ZXAgMTogRXN0aW1hdGlvbiBkZXMgYm9ybmVzIChDb3JuZXIgU2FtcGxp
#2#bmcpLi4uIiwgZmx1c2g9VHJ1ZSkKICAgICAgICAgICAgZG93bl92b2wgPSB2b2xbOjo0LCA6OjQs
#2#IDo6NF0KICAgICAgICAgICAgZnJhbWVfc2lnID0gZmxvYXQobnAucGVyY2VudGlsZShkb3duX3Zv
#2#bCwgOTkuOSkpCiAgICAgICAgICAgIGlmIGlzX3RpbWVsYXBzZToKICAgICAgICAgICAgICAgIGJn
#2#X2Zsb29yLCBzaWdfbWF4ID0gZ2xvYmFsX2JvdW5kc1tjX2lkeF0KICAgICAgICAgICAgICAgIHBy
#2#aW50KGYiICAgIGJvcm5lcyBnbG9iYWxlczogYmdfZmxvb3I9e2JnX2Zsb29yOi4yZn0gc2lnX21h
#2#eD17c2lnX21heDouMmZ9ICIKICAgICAgICAgICAgICAgICAgICAgIGYiKHNpZ25hbCBwcm9wcmUg
#2#YSBjZXR0ZSBmcmFtZToge2ZyYW1lX3NpZzouMmZ9KSIsIGZsdXNoPVRydWUpCiAgICAgICAgICAg
#2#IGVsc2U6CiAgICAgICAgICAgICAgICBjb3JuZXJfZGF0YSA9IF9jb3JuZXJfc2FtcGxlcyh2b2ws
#2#IFcsIEgsIEQpCiAgICAgICAgICAgICAgICBiZ19mbG9vciA9IGZsb2F0KG5wLnBlcmNlbnRpbGUo
#2#Y29ybmVyX2RhdGEsIDk5LjApKQogICAgICAgICAgICAgICAgcHJpbnQoZiIgICAgYmdfZmxvb3Ig
#2#KDk5ZSBjZW50aWxlIGR1IGJydWl0IGRlcyBjb2lucyk6IHtiZ19mbG9vcjouMmZ9IiwgZmx1c2g9
#2#VHJ1ZSkKICAgICAgICAgICAgICAgIHNpZ19tYXggPSBmcmFtZV9zaWcKICAgICAgICAgICAgICAg
#2#IHByaW50KGYiICAgIHNpZ19tYXggKDk5LjllIGNlbnRpbGUgZ2xvYmFsKToge3NpZ19tYXg6LjJm
#2#fSIsIGZsdXNoPVRydWUpCiAgICAgICAgICAgIHNpZ25hbF9sZXZlbHNbZiJ0e3RfaWR4OjAzZH1f
#2#Y3tjX2lkeH0iXSA9IHJvdW5kKGZyYW1lX3NpZywgNCkKICAgICAgICAgICAgZGVsIGRvd25fdm9s
#2#CgogICAgICAgICAgICAjIOKUgOKUgOKUgCBTdGVwIDIgOiBTaWduYWwgbWFzayDilIDilIDilIDi
#2#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#2#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAK
#2#ICAgICAgICAgICAgIyBUaHJlc2hvbGQgMTAgJSBhYm92ZSB0aGUgbm9pc2UgZmxvb3I7IGEgbW9y
#2#cGhvbG9naWNhbCBvcGVuaW5nIGRyb3BzCiAgICAgICAgICAgICMgaXNvbGF0ZWQgaG90IHBpeGVs
#2#cyAoc28gdGhleSBnZXQgbWVkaWFuLWNydXNoZWQgYmVsb3cpLCB0aGVuIGEKICAgICAgICAgICAg
#2#IyAzLWl0ZXJhdGlvbiBkaWxhdGlvbiBndWFyZHMgdGhlIG5hdHVyYWwgZmx1b3Jlc2NlbnQgZmFk
#2#ZS1vdXQgYXJvdW5kCiAgICAgICAgICAgICMgdGhlIGJpb2xvZ2ljYWwgc2lnbmFsIHNvIHRoZSBt
#2#ZWRpYW4gZmlsdGVyIG5ldmVyIGJpdGVzIGludG8gY2VsbHMuCiAgICAgICAgICAgIHByaW50KCIg
#2#IFN0ZXAgMjogQ29uc3RydWN0aW9uIGR1IG1hc3F1ZSBkZSBzaWduYWwuLi4iLCBmbHVzaD1UcnVl
#2#KQogICAgICAgICAgICBucC5ncmVhdGVyKHZvbCwgYmdfZmxvb3IgKiAxLjEsIG91dD1tYXNrKQog
#2#ICAgICAgICAgICBtYXNrWzpdID0gYmluYXJ5X29wZW5pbmcobWFzaywgaXRlcmF0aW9ucz0xKQog
#2#ICAgICAgICAgICBtYXNrWzpdID0gYmluYXJ5X2RpbGF0aW9uKG1hc2ssIGl0ZXJhdGlvbnM9MykK
#2#ICAgICAgICAgICAgcHJpbnQoZiIgICAgQ291dmVydHVyZSBkdSBtYXNxdWU6IHsxMDAuMCAqIG1h
#2#c2subWVhbigpOi4yZn0lIGRlcyB2b3hlbHMiLCBmbHVzaD1UcnVlKQoKICAgICAgICAgICAgIyDi
#2#lIDilIDilIAgU3RlcCAzIDogTWFza2VkIG1lZGlhbiBmaWx0ZXJpbmcgKyBXaW5kb3cgTGV2ZWxp
#2#bmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICAgICAgICAgICMgUGFyYWxs
#2#ZWwgb3ZlciBaLWJsb2NrczsgZWFjaCBibG9jayBjYXJyaWVzIGEgwrExIFogaGFsbyBmb3IgdGhl
#2#CiAgICAgICAgICAgICMgM0QgbWVkaWFuIHNvIHRoZXJlIGlzIG5vIHNlYW0gYmV0d2VlbiBibG9j
#2#a3MuCiAgICAgICAgICAgIHByaW50KCIgIFN0ZXAgMzogTWFza2VkIE1lZGlhbiBGaWx0ZXJpbmcg
#2#KyBXaW5kb3cgTGV2ZWxpbmcuLi4iLCBmbHVzaD1UcnVlKQogICAgICAgICAgICB6X2NodW5rX3Np
#2#emUgPSBtYXgoNCwgRCAvLyAob3MuY3B1X2NvdW50KCkgKiAyKSkKICAgICAgICAgICAgdGFza3Mg
#2#PSBbXQogICAgICAgICAgICBmb3Igel9zdGFydCBpbiByYW5nZSgwLCBELCB6X2NodW5rX3NpemUp
#2#OgogICAgICAgICAgICAgICAgel9lbmQgPSBtaW4oel9zdGFydCArIHpfY2h1bmtfc2l6ZSwgRCkK
#2#ICAgICAgICAgICAgICAgIGhhbG9fbG8gPSAxIGlmIHpfc3RhcnQgPiAwIGVsc2UgMAogICAgICAg
#2#ICAgICAgICAgaGFsb19oaSA9IDEgaWYgel9lbmQgPCBEIGVsc2UgMAogICAgICAgICAgICAgICAg
#2#dGFza3MuYXBwZW5kKCh2b2xfc2htLm5hbWUsIG1hc2tfc2htLm5hbWUsIG91dF9zaG0ubmFtZSwg
#2#c2hhcGUsCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHpfc3RhcnQsIHpfZW5kLCBoYWxv
#2#X2xvLCBoYWxvX2hpLCBiZ19mbG9vciwgc2lnX21heCkpCgogICAgICAgICAgICBmb3IgXyBpbiB0
#2#cWRtKGV4ZWN1dG9yLm1hcChwcm9jZXNzX3pfYmxvY2ssIHRhc2tzKSwgdG90YWw9bGVuKHRhc2tz
#2#KSwKICAgICAgICAgICAgICAgICAgICAgICAgICBkZXNjPSJNYXNrZWQgTWVkaWFuICsgTGV2ZWxp
#2#bmciLCBsZWF2ZT1GYWxzZSwgYXNjaWk9VHJ1ZSwgbWluaW50ZXJ2YWw9Mi4wKToKICAgICAgICAg
#2#ICAgICAgIHBhc3MKCiAgICAgICAgICAgICMg4pSA4pSA4pSAIFN0ZXAgNCA6IEV4cG9ydGluZyBk
#2#b3duc2NhbGVkIExPRCBsZXZlbHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#2#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICAgICAgICAgIHByaW50KCIgIFN0ZXAgNDog
#2#RXhwb3J0aW5nIGRvd25zY2FsZWQgTE9EIGxldmVscy4uLiIsIGZsdXNoPVRydWUpCiAgICAgICAg
#2#ICAgIGxvZF9maWxlcyA9IHt9CiAgICAgICAgICAgIGZvciBsaSBpbiBsb2RfaW5mbzoKICAgICAg
#2#ICAgICAgICAgIGxvZF9udW0gPSBsaVsibG9kIl0KICAgICAgICAgICAgICAgIGxvZF9maWxlID0g
#2#dGVtcF9kaXIgLyBmInR7dF9pZHg6MDNkfV9je2NfaWR4fV9sb2R7bG9kX251bX0uYmluIgogICAg
#2#ICAgICAgICAgICAgbG9kX2ZpbGVzW2xvZF9udW1dID0gb3Blbihsb2RfZmlsZSwgIndiIikKCiAg
#2#ICAgICAgICAgIGZvciB6IGluIHRxZG0ocmFuZ2UoRCksIGRlc2M9IkV4cG9ydGluZyBMT0RzIiwg
#2#bGVhdmU9RmFsc2UsIGFzY2lpPVRydWUsIG1pbmludGVydmFsPTIuMCk6CiAgICAgICAgICAgICAg
#2#ICBzbGljZV91OCA9IHZvbF91OFt6XQogICAgICAgICAgICAgICAgIyBXcml0ZSBuYXRpdmUgTE9E
#2#MAogICAgICAgICAgICAgICAgbG9kX2ZpbGVzWzBdLndyaXRlKHNsaWNlX3U4LnRvYnl0ZXMoKSkK
#2#ICAgICAgICAgICAgICAgICMgV3JpdGUgZG93bnNjYWxlZCBMT0RzCiAgICAgICAgICAgICAgICBw
#2#aWxfaW1nID0gSW1hZ2UuZnJvbWFycmF5KHNsaWNlX3U4LCBtb2RlPSJMIikKICAgICAgICAgICAg
#2#ICAgIGZvciBsaSBpbiBsb2RfaW5mb1sxOl06CiAgICAgICAgICAgICAgICAgICAgbG9kX251bSA9
#2#IGxpWyJsb2QiXQogICAgICAgICAgICAgICAgICAgIHJlc2l6ZWQgPSBwaWxfaW1nLnJlc2l6ZSgo
#2#bGlbIndpZHRoIl0sIGxpWyJoZWlnaHQiXSksIEltYWdlLlJlc2FtcGxpbmcuQklMSU5FQVIpCiAg
#2#ICAgICAgICAgICAgICAgICAgcmVzaXplZF9hcnIgPSBucC5hc2FycmF5KHJlc2l6ZWQsIGR0eXBl
#2#PW5wLnVpbnQ4KQogICAgICAgICAgICAgICAgICAgIGxvZF9maWxlc1tsb2RfbnVtXS53cml0ZShy
#2#ZXNpemVkX2Fyci50b2J5dGVzKCkpCgogICAgICAgICAgICAjIENsb3NlIGFsbCBmaWxlIGhhbmRs
#2#ZXMKICAgICAgICAgICAgZm9yIGZfaGFuZGxlIGluIGxvZF9maWxlcy52YWx1ZXMoKToKICAgICAg
#2#ICAgICAgICAgIGZfaGFuZGxlLmNsb3NlKCkKICAgICAgICAgICAgIyB2b2wgLyBtYXNrIC8gdm9s
#2#X3U4IGFyZSB2aWV3cyBvbiB0aGUgc2hhcmVkIGJsb2NrczsgRXhpdFN0YWNrIGNsb3NlcyBhbmQK
#2#ICAgICAgICAgICAgIyB1bmxpbmtzIHRoZW0gYXMgdGhlIGB3aXRoYCB1bndpbmRzLiBEcm9wIHRo
#2#ZSB2aWV3cyBmaXJzdCBzbyBubyBudW1weQogICAgICAgICAgICAjIG9iamVjdCBzdGlsbCByZWZl
#2#cmVuY2VzIGEgYnVmZmVyIHRoYXQgaXMgYWJvdXQgdG8gYmUgcmVsZWFzZWQuCiAgICAgICAgICAg
#2#IGRlbCB2b2wsIG1hc2ssIHZvbF91OAogICAgICAgICAgICBwcmludChmIiAgQ2hhbm5lbCB7Y19p
#2#ZHh9IHByb2Nlc3NlZCBzdWNjZXNzZnVsbHkuIikKCiAgICBmX2ltcy5jbG9zZSgpCiAgICAKICAg
#2#ICMgU2F2ZSB0aGUgTE9EIGluZm8gZm9yIG5leHQgc3RlcAogICAgd2l0aCBvcGVuKHRlbXBfZGly
#2#IC8gInByb2Nlc3NpbmdfbWV0YS5qc29uIiwgInciLCBlbmNvZGluZz0idXRmLTgiKSBhcyBmbToK
#2#ICAgICAgICBqc29uLmR1bXAoewogICAgICAgICAgICAibG9kX2xldmVscyI6IGxvZF9pbmZvLAog
#2#ICAgICAgICAgICAidm94ZWxfc2l6ZSI6IG1ldGFbInZveGVsX3NpemUiXSwKICAgICAgICAgICAg
#2#ImNoYW5uZWxfbmFtZXMiOiBtZXRhWyJjaGFubmVsX25hbWVzIl0sCiAgICAgICAgICAgICJ3aWR0
#2#aCI6IFcsCiAgICAgICAgICAgICJoZWlnaHQiOiBILAogICAgICAgICAgICAiZGVwdGgiOiBELAog
#2#ICAgICAgICAgICAibl9jaGFubmVscyI6IG5fY2gsCiAgICAgICAgICAgICJuX3RpbWVwb2ludHMi
#2#OiBuX3RwLAogICAgICAgICAgICAiZXh0ZW50IjogbWV0YS5nZXQoImV4dGVudCIpLAogICAgICAg
#2#ICAgICAidGltZXN0YW1wcyI6IG1ldGEuZ2V0KCJ0aW1lc3RhbXBzIiksCiAgICAgICAgICAgICJ0
#2#aW1lX2ludGVydmFsX21pbnV0ZXMiOiBtZXRhLmdldCgidGltZV9pbnRlcnZhbF9taW51dGVzIiks
#2#CiAgICAgICAgICAgICJub3JtYWxpemF0aW9uIjogewogICAgICAgICAgICAgICAgIm1vZGUiOiAi
#2#Z2xvYmFsIiBpZiBpc190aW1lbGFwc2UgZWxzZSAicGVyLXZvbHVtZSIsCiAgICAgICAgICAgICAg
#2#ICAiYm91bmRzIjoge2YiY3tjfSI6IHsiYmdGbG9vciI6IHJvdW5kKGJbMF0sIDQpLCAic2lnTWF4
#2#Ijogcm91bmQoYlsxXSwgNCl9CiAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvciBjLCBiIGlu
#2#IGdsb2JhbF9ib3VuZHMuaXRlbXMoKX0sCiAgICAgICAgICAgICAgICAic2lnbmFsTGV2ZWxzIjog
#2#c2lnbmFsX2xldmVscwogICAgICAgICAgICB9CiAgICAgICAgfSwgZm0sIGluZGVudD0yKQoKaWYg
#2#X19uYW1lX18gPT0gIl9fbWFpbl9fIjoKICAgIGlmIGxlbihzeXMuYXJndikgPCA0OgogICAgICAg
#2#IHByaW50KCJVc2FnZTogcHl0aG9uIDItaW1hZ2VfcHJvY2Vzc29yLnB5IDxpbnB1dF9pbXM+IDxt
#2#ZXRhZGF0YV9qc29uPiA8dGVtcF9kaXI+IikKICAgICAgICBzeXMuZXhpdCgxKQogICAgICAgIAog
#2#ICAgaW5wdXRfaW1zID0gUGF0aChzeXMuYXJndlsxXSkKICAgIG1ldGFkYXRhX2pzb24gPSBQYXRo
#2#KHN5cy5hcmd2WzJdKQogICAgdGVtcF9kaXIgPSBQYXRoKHN5cy5hcmd2WzNdKQogICAgCiAgICB0
#2#cnk6CiAgICAgICAgcHJvY2Vzc19pbWFnZShpbnB1dF9pbXMsIG1ldGFkYXRhX2pzb24sIHRlbXBf
#2#ZGlyKQogICAgICAgIHByaW50KGYiW1BST0NFU1NdIEltYWdlIHByb2Nlc3NpbmcgY29tcGxldGUu
#2#IikKICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZToKICAgICAgICBpbXBvcnQgdHJhY2ViYWNrCiAg
#2#ICAgICAgdHJhY2ViYWNrLnByaW50X2V4YygpCiAgICAgICAgcHJpbnQoZiJbRVJST1JdIEltYWdl
#2#IHByb2Nlc3NpbmcgZmFpbGVkOiB7ZX0iLCBmaWxlPXN5cy5zdGRlcnIpCiAgICAgICAgc3lzLmV4
#2#aXQoMSkK
:: ---- [3] 3-chunk_packer.py (16055 octets) ----
#3#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwppbXBvcnQganNvbgppbXBvcnQgbWF0aAppbXBvcnQgc3lz
#3#CmltcG9ydCBnemlwCmltcG9ydCBoYXNobGliCmZyb20gcGF0aGxpYiBpbXBvcnQgUGF0aAppbXBv
#3#cnQgbnVtcHkgYXMgbnAKZnJvbSBQSUwgaW1wb3J0IEltYWdlCmltcG9ydCBpbwpmcm9tIGNvbmN1
#3#cnJlbnQuZnV0dXJlcyBpbXBvcnQgUHJvY2Vzc1Bvb2xFeGVjdXRvcgppbXBvcnQgb3MKCiMgRW1w
#3#dHktc3BhY2Ugc2tpcHBpbmcgY291bnRzIHRoZSB2b3hlbHMgdGhlIFJFTkRFUkVSIGNhbiBkcmF3
#3#LCBub3QgdGhlIHZveGVscyB0aGF0CiMgYXJlIG1lcmVseSBub24temVyby4KIwojIFdpbmRvdyBs
#3#ZXZlbGluZyBpbiAyLWltYWdlX3Byb2Nlc3Nvci5weSBtYXBzIFtiZ19mbG9vciwgc2lnX21heF0g
#3#b250byBbMCwgMjU1XSwgc28gYQojIHZveGVsIHNpdHRpbmcgb25lIHN0ZXAgYWJvdmUgdGhlIG5v
#3#aXNlIGZsb29yIGxhbmRzIG9uIDEuIEJhY2tncm91bmQgbm9pc2Ugc3RyYWRkbGluZwojIGJnX2Zs
#3#b29yIHRoZXJlZm9yZSBhbHdheXMgbGVhdmVzIGEgc3BlY2tsZSBvZiAxcyDigJQgdGhhdCBpcyBh
#3#cml0aG1ldGljLCBub3QgYSBkZWZlY3QuCiMgQ291bnRpbmcgdGhvc2UgYXMgY29udGVudCBtYWRl
#3#IGEgYnJpY2sgdGhhdCBpcyA5Ny05OSAlIHplcm8gcGFzcyB0aGUgdGVzdDogbWVhc3VyZWQgb24K
#3#IyB0aGUgcHVibGlzaGVkIERlY2lkdWEgYnJpY2tzLCB0aGUgZWlnaHQgY29ybmVyIGJyaWNrcyBh
#3#cmUgOTYuOSAlLCA5OC41ICUgYW5kIDk4LjkgJQojIHplcm8gKDk5dGggcGVyY2VudGlsZSA9IDEp
#3#IGFuZCB3ZXJlIGFsbCBrZXB0LCB3aGljaCBpcyB3aHkgdGhhdCBkYXRhc2V0IHJlcG9ydHMgNzIw
#3#MAojIG5vbi1lbXB0eSBicmlja3Mgb3V0IG9mIDcyMDAgYW5kIGRvd25sb2FkcyB+NHggd2hhdCBh
#3#IGNvbXBhcmFibGUgb25lIGRvZXMuCiMKIyBUaGUgdmlld2VyIG5ldmVyIHNob3dzIHRob3NlIHZv
#3#eGVscy4gdm9sdW1lLXZpZXdlci5qczpfZmxvb3JzRnJvbU1hbmlmZXN0IGRlcml2ZXMgYQojIHBl
#3#ci1jaGFubmVsIGJhY2tncm91bmQgZmxvb3IgYW5kIGNsYW1wcyBpdCB0byBbNiwgNDhdIChpdCBy
#3#ZWFjaGVzIHRoZSBsb3cgZW5kIG9mIHRoYXQKIyBjbGFtcCB3aGVuZXZlciB0aGUgbWFuaWZlc3Qg
#3#Y2FycmllcyBubyBleHBsaWNpdCBiYWNrZ3JvdW5kRmxvb3IsIHdoaWNoIGlzIGV2ZXJ5CiMgZGF0
#3#YXNldCBwdWJsaXNoZWQgc28gZmFyKS4gQW55dGhpbmcgdW5kZXIgNiBpcyBjcnVzaGVkIHRvIHpl
#3#cm8gYnkgdGhlIExVVCBiZWZvcmUgdGhlCiMgcmF5IG1hcmNoZXIgZXZlciBzZWVzIGl0LiBDb3Vu
#3#dGluZyBmcm9tIDUgaXMgdGh1cyBzdHJpY3RseSBiZWxvdyB0aGUgc21hbGxlc3QgZmxvb3IKIyB0
#3#aGUgdmlld2VyIGNhbiBjaG9vc2U6IG5vIGJyaWNrIHRoYXQgY291bGQgY29udHJpYnV0ZSBhIHBp
#3#eGVsIGlzIGV2ZXIgZHJvcHBlZCwgYW5kIHRoZQojIHN0b3JlZCB2b3hlbHMgYXJlIHVudG91Y2hl
#3#ZCDigJQgb25seSB0aGUgaW5kZXggY2hhbmdlcy4KIyBUaGUgdGVzdCBpcyB0aGUgSU5URVJTRUNU
#3#SU9OIG9mIHRoZSBoaXN0b3JpYyByYXRpbyBhbmQgYSBkcmF3YWJpbGl0eSBjaGVjaywgc28gaXQg
#3#Y2FuCiMgb25seSBldmVyIGtlZXAgYSBzdWJzZXQgb2Ygd2hhdCBpdCBrZXB0IGJlZm9yZSwgYW5k
#3#IGV2ZXJ5dGhpbmcgaXQgbmV3bHkgZHJvcHMgaXMKIyBwcm92YWJseSBpbnZpc2libGU6IHplcm8g
#3#dm94ZWxzIGF0IG9yIGFib3ZlIHRoZSBmbG9vci4gUmVwbGF5aW5nIGl0IG92ZXIgZXZlcnkKIyBw
#3#dWJsaXNoZWQgYnJpY2sgb2YgYSBMT0Q6IERlY2lkdWEgbG9kMiBnb2VzIGZyb20gMTgzNiBrZXB0
#3#IHRvIDE0MzQgKC0yMS45ICUpLCBhbmQgdGhlCiMgaGVhbHRoeSBFbTEwIGxvZDIgZnJvbSA5MzIg
#3#dG8gOTMwICgtMC4yICUpIOKAlCB0aGUgY29ycmVjdGlvbiBsYW5kcyBvbiB0aGUgcGF0aG9sb2dp
#3#Y2FsCiMgZGF0YXNldCBhbmQgbGVhdmVzIHRoZSBzb3VuZCBvbmVzIGFsb25lLgojCiMgRHJvcHBp
#3#bmcgdGhlIHJhdGlvIGFuZCBrZWVwaW5nIG9ubHkgYGRyYXdhYmxlID4gMGAgd291bGQgdGFrZSBE
#3#ZWNpZHVhIGxvZDIgZG93biBhCiMgZnVydGhlciAyOTEgYnJpY2tzLCBidXQgZWFjaCBvZiB0aG9z
#3#ZSBzdGlsbCBob2xkcyB1cCB0byAxMzEgdm94ZWxzIHRoZSB2aWV3ZXIgV09VTEQKIyBkcmF3LiBE
#3#aXNjYXJkaW5nIG1lYXN1cmVkIHNpZ25hbCB0byBzYXZlIGJhbmR3aWR0aCBpcyBub3QgYSBjYWxs
#3#IHRoaXMgc2NyaXB0IGdldHMgdG8KIyBtYWtlIHNpbGVudGx5IChydWxlIDEuMSksIHNvIHRoZSBy
#3#YXRpbyBzdGF5cy4KRElTUExBWV9GTE9PUiA9IDUgICAgICAgICAgICMgdGhlIHZpZXdlcidzIExV
#3#VCBjcnVzaGVzIGV2ZXJ5dGhpbmcgYmVsb3cgNiB0byB6ZXJvCkVTU19NSU5fT0NDVVBBTkNZID0g
#3#MC4wMDA1ICAjIHVuY2hhbmdlZCBoaXN0b3JpYyB0b2xlcmFuY2UsIHN0aWxsIG1lYXN1cmVkIG9u
#3#IG5vbi16ZXJvCgoKZGVmIHByb2Nlc3NfY2h1bmsoYXJncyk6CiAgICBjaHVua19kYXRhLCBjaF9t
#3#ZXRhLCBCUklDS19TSVpFID0gYXJncwogICAgbm9uX3plcm8gPSBucC5jb3VudF9ub256ZXJvKGNo
#3#dW5rX2RhdGEpCiAgICB2YWxpZF92b3hlbHMgPSBtYXgoMSwgY2hfbWV0YVsidmFsaWRWb3hlbENv
#3#dW50Il0pCiAgICBvY2MgPSBmbG9hdChub25femVybykgLyBmbG9hdCh2YWxpZF92b3hlbHMpCgog
#3#ICAgIyBBIGJyaWNrIGhvbGRpbmcgbm90aGluZyBhdCBvciBhYm92ZSB0aGUgZGlzcGxheSBmbG9v
#3#ciBjYW5ub3QgY29udHJpYnV0ZSBhIHNpbmdsZQogICAgIyBwaXhlbDogaXQgaXMgZW1wdHkgaG93
#3#ZXZlciBtYW55IHF1YW50aXphdGlvbi1ub2lzZSAxcyBpdCBjYXJyaWVzLgogICAgaGFzX2RyYXdh
#3#YmxlID0gYm9vbChucC5hbnkoY2h1bmtfZGF0YSA+IERJU1BMQVlfRkxPT1IpKQoKICAgIGlzX25v
#3#bl9lbXB0eSA9IG9jYyA+IEVTU19NSU5fT0NDVVBBTkNZIGFuZCBoYXNfZHJhd2FibGUKICAgIGlm
#3#IG5vdCBpc19ub25fZW1wdHk6CiAgICAgICAgcmV0dXJuIChjaF9tZXRhWyJpZHgiXSwgMC4wIGlm
#3#IG5vdCBoYXNfZHJhd2FibGUgZWxzZSBvY2MsIEZhbHNlLCBOb25lKQoKICAgIHBhZGRlZCA9IG5w
#3#Lnplcm9zKChCUklDS19TSVpFLCBCUklDS19TSVpFLCBCUklDS19TSVpFKSwgZHR5cGU9bnAudWlu
#3#dDgpCiAgICBkLCBoLCB3ID0gY2h1bmtfZGF0YS5zaGFwZQogICAgcGFkZGVkWzpkLCA6aCwgOndd
#3#ID0gY2h1bmtfZGF0YQoKICAgIG1vc2FpYyA9IG5wLnplcm9zKCg1MTIsIDUxMiksIGR0eXBlPW5w
#3#LnVpbnQ4KQogICAgZm9yIHogaW4gcmFuZ2UoNjQpOgogICAgICAgIHJvdyA9IHogLy8gOAogICAg
#3#ICAgIGNvbCA9IHogJSA4CiAgICAgICAgbW9zYWljW3Jvdyo2NDoocm93KzEpKjY0LCBjb2wqNjQ6
#3#KGNvbCsxKSo2NF0gPSBwYWRkZWRbel0KCiAgICBpbWcgPSBJbWFnZS5mcm9tYXJyYXkobW9zYWlj
#3#KQogICAgYnVmID0gaW8uQnl0ZXNJTygpCiAgICBpbWcuc2F2ZShidWYsIGZvcm1hdD0iV0VCUCIs
#3#IGxvc3NsZXNzPVRydWUpCiAgICByZXR1cm4gKGNoX21ldGFbImlkeCJdLCBvY2MsIFRydWUsIGJ1
#3#Zi5nZXR2YWx1ZSgpKQoKCmRlZiBfcGFja190aW1lcG9pbnQodGVtcF9kaXI6IFBhdGgsIGJyaWNr
#3#c19kaXI6IFBhdGgsIHRfaWR4OiBpbnQsIGxvZF9sZXZlbHMsIG5fY2g6IGludCwKICAgICAgICAg
#3#ICAgICAgICAgICBleGVjdXRvciwgdHBfc3ViZGlyOiBzdHIpOgogICAgIiIiQnJpY2ssIGNvbXBy
#3#ZXNzIGFuZCBwYWNrIGV2ZXJ5IExPRCBvZiBhIHNpbmdsZSB0aW1lcG9pbnQuCgogICAgdHBfc3Vi
#3#ZGlyIGlzICcnIGZvciBhIHNpbmdsZS10aW1lcG9pbnQgKCczZCcpIGRhdGFzZXQg4oCUIHRoZSBw
#3#YWNrcyB0aGVuIGxhbmQKICAgIGRpcmVjdGx5IHVuZGVyIGJyaWNrcy8gYW5kIHRoZSBvdXRwdXQg
#3#aXMgYnl0ZS1pZGVudGljYWwgdG8gdGhlIHByZS00RCBwaXBlbGluZS4KICAgIEZvciBhIHRpbWVs
#3#YXBzZSBpdCBpcyAndDAwMCcsICd0MDAxJywg4oCmIGFuZCBlYWNoIHRpbWVwb2ludCBvd25zIGEg
#3#c2VsZi1jb250YWluZWQKICAgIHBhY2sgdHJlZSB3aG9zZSBicmlja1RvUGFjayB1cmxzIHN0YXkg
#3#cmVsYXRpdmUgdG8gdGhhdCBzdWItZGlyZWN0b3J5LCB3aGljaCBpcwogICAgZXhhY3RseSB3aGF0
#3#IHRoZSB2aWV3ZXIgYXBwZW5kcyB0byB0aGUgYnJpY2tzIGJhc2UgcGF0aC4KICAgICIiIgogICAg
#3#dHBfcm9vdCA9IGJyaWNrc19kaXIgLyB0cF9zdWJkaXIgaWYgdHBfc3ViZGlyIGVsc2UgYnJpY2tz
#3#X2RpcgogICAgdHBfcm9vdC5ta2RpcihwYXJlbnRzPVRydWUsIGV4aXN0X29rPVRydWUpCgogICAg
#3#QlJJQ0tfU0laRSA9IDY0CiAgICBDSFVOS1NfUEVSX1BBQ0sgPSAxMjgKCiAgICBicmlja190b19w
#3#YWNrID0ge30KICAgIHBhY2tfaGFzaGVzID0ge30KICAgIGxldmVsc19tYW5pZmVzdCA9IFtdCgog
#3#ICAgZm9yIGxpIGluIGxvZF9sZXZlbHM6CiAgICAgICAgbG9kX251bSA9IGxpWyJsb2QiXQogICAg
#3#ICAgIFcsIEgsIEQgPSBsaVsid2lkdGgiXSwgbGlbImhlaWdodCJdLCBsaVsiZGVwdGgiXQoKICAg
#3#ICAgICBueCA9IG1hdGguY2VpbChXIC8gQlJJQ0tfU0laRSkKICAgICAgICBueSA9IG1hdGguY2Vp
#3#bChIIC8gQlJJQ0tfU0laRSkKICAgICAgICBueiA9IG1hdGguY2VpbChEIC8gQlJJQ0tfU0laRSkK
#3#CiAgICAgICAgIyBCdWlsZCBsb2dpY2FsIGdyaWQgb2YgY2h1bmtzIGZvciB0aGlzIGxldmVsCiAg
#3#ICAgICAgY2h1bmtzX2dyaWQgPSBbXQogICAgICAgIGZvciBieiBpbiByYW5nZShueik6CiAgICAg
#3#ICAgICAgIGZvciBieSBpbiByYW5nZShueSk6CiAgICAgICAgICAgICAgICBmb3IgYnggaW4gcmFu
#3#Z2UobngpOgogICAgICAgICAgICAgICAgICAgIG94LCBveSwgb3ogPSBieCAqIEJSSUNLX1NJWkUs
#3#IGJ5ICogQlJJQ0tfU0laRSwgYnogKiBCUklDS19TSVpFCiAgICAgICAgICAgICAgICAgICAgZXcg
#3#PSBtaW4oQlJJQ0tfU0laRSwgVyAtIG94KQogICAgICAgICAgICAgICAgICAgIGVoID0gbWluKEJS
#3#SUNLX1NJWkUsIEggLSBveSkKICAgICAgICAgICAgICAgICAgICBlZCA9IG1pbihCUklDS19TSVpF
#3#LCBEIC0gb3opCiAgICAgICAgICAgICAgICAgICAgY2h1bmtzX2dyaWQuYXBwZW5kKHsKICAgICAg
#3#ICAgICAgICAgICAgICAgICAgImJ4IjogYngsCiAgICAgICAgICAgICAgICAgICAgICAgICJieSI6
#3#IGJ5LAogICAgICAgICAgICAgICAgICAgICAgICAiYnoiOiBieiwKICAgICAgICAgICAgICAgICAg
#3#ICAgICAgIm1pbiI6IFtpbnQob3gpLCBpbnQob3kpLCBpbnQob3opXSwKICAgICAgICAgICAgICAg
#3#ICAgICAgICAgIm1heCI6IFtpbnQob3ggKyBldyksIGludChveSArIGVoKSwgaW50KG96ICsgZWQp
#3#XSwKICAgICAgICAgICAgICAgICAgICAgICAgInZhbGlkVm94ZWxDb3VudCI6IGludChldyAqIGVo
#3#ICogZWQpCiAgICAgICAgICAgICAgICAgICAgfSkKCiAgICAgICAgIyBFbXB0eS1zcGFjZSBza2lw
#3#cGluZyBpcyBkZWNpZGVkIHBlciB0aW1lcG9pbnQ6IGNlbGxzIG1vdmUsIHNvIHRoZSBvY2N1cGll
#3#ZAogICAgICAgICMgYnJpY2sgc2V0IGxlZ2l0aW1hdGVseSBkaWZmZXJzIGZyb20gb25lIGZyYW1l
#3#IHRvIHRoZSBuZXh0LgogICAgICAgIEJBQ0tHUk9VTkRfVEhSRVNIT0xEID0gMAogICAgICAgIGlz
#3#X2NvcmUgPSBbRmFsc2VdICogbGVuKGNodW5rc19ncmlkKQogICAgICAgIGZvciBjX2lkeCBpbiBy
#3#YW5nZShuX2NoKToKICAgICAgICAgICAgYmluX2ZpbGUgPSB0ZW1wX2RpciAvIGYidHt0X2lkeDow
#3#M2R9X2N7Y19pZHh9X2xvZHtsb2RfbnVtfS5iaW4iCiAgICAgICAgICAgIGlmIG5vdCBiaW5fZmls
#3#ZS5leGlzdHMoKToKICAgICAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAgICAgIHZvbHVtZV9k
#3#YXRhID0gbnAubWVtbWFwKAogICAgICAgICAgICAgICAgc3RyKGJpbl9maWxlKSwKICAgICAgICAg
#3#ICAgICAgIGR0eXBlPW5wLnVpbnQ4LAogICAgICAgICAgICAgICAgbW9kZT0iciIsCiAgICAgICAg
#3#ICAgICAgICBzaGFwZT0oRCwgSCwgVykKICAgICAgICAgICAgKQogICAgICAgICAgICBmb3IgaSwg
#3#Y2ggaW4gZW51bWVyYXRlKGNodW5rc19ncmlkKToKICAgICAgICAgICAgICAgIG94LCBveSwgb3og
#3#PSBjaFsibWluIl0KICAgICAgICAgICAgICAgIGV4LCBleSwgZXogPSBjaFsibWF4Il0KICAgICAg
#3#ICAgICAgICAgIGNodW5rX3NsaWNlID0gdm9sdW1lX2RhdGFbb3o6ZXosIG95OmV5LCBveDpleF0K
#3#ICAgICAgICAgICAgICAgIGlmIGNodW5rX3NsaWNlLnNpemUgPiAwOgogICAgICAgICAgICAgICAg
#3#ICAgIGlmIG5wLm1heChjaHVua19zbGljZSkgPiBCQUNLR1JPVU5EX1RIUkVTSE9MRDoKICAgICAg
#3#ICAgICAgICAgICAgICAgICAgaXNfY29yZVtpXSA9IFRydWUKICAgICAgICAgICAgZGVsIHZvbHVt
#3#ZV9kYXRhCgogICAgICAgIGNvcmVfY29vcmRzID0gc2V0KCkKICAgICAgICBmb3IgaSwgY2ggaW4g
#3#ZW51bWVyYXRlKGNodW5rc19ncmlkKToKICAgICAgICAgICAgaWYgaXNfY29yZVtpXToKICAgICAg
#3#ICAgICAgICAgIGNvcmVfY29vcmRzLmFkZCgoY2hbImJ4Il0sIGNoWyJieSJdLCBjaFsiYnoiXSkp
#3#CgogICAgICAgIGFjdGl2ZV9jb29yZHMgPSBzZXQoKQogICAgICAgIGZvciAoYngsIGJ5LCBieikg
#3#aW4gY29yZV9jb29yZHM6CiAgICAgICAgICAgIGZvciBkeCBpbiAoLTEsIDAsIDEpOgogICAgICAg
#3#ICAgICAgICAgZm9yIGR5IGluICgtMSwgMCwgMSk6CiAgICAgICAgICAgICAgICAgICAgZm9yIGR6
#3#IGluICgtMSwgMCwgMSk6CiAgICAgICAgICAgICAgICAgICAgICAgIG54X2Nvb3JkID0gYnggKyBk
#3#eAogICAgICAgICAgICAgICAgICAgICAgICBueV9jb29yZCA9IGJ5ICsgZHkKICAgICAgICAgICAg
#3#ICAgICAgICAgICAgbnpfY29vcmQgPSBieiArIGR6CiAgICAgICAgICAgICAgICAgICAgICAgIGlm
#3#IDAgPD0gbnhfY29vcmQgPCBueCBhbmQgMCA8PSBueV9jb29yZCA8IG55IGFuZCAwIDw9IG56X2Nv
#3#b3JkIDwgbno6CiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhY3RpdmVfY29vcmRzLmFkZCgo
#3#bnhfY29vcmQsIG55X2Nvb3JkLCBuel9jb29yZCkpCgogICAgICAgIGFjdGl2ZV9jaHVua3NfZ3Jp
#3#ZCA9IFtjaCBmb3IgY2ggaW4gY2h1bmtzX2dyaWQgaWYgKGNoWyJieCJdLCBjaFsiYnkiXSwgY2hb
#3#ImJ6Il0pIGluIGFjdGl2ZV9jb29yZHNdCiAgICAgICAgcHJpbnQoZiJbUEFDS0VSXSB7dHBfc3Vi
#3#ZGlyIG9yICd0MDAwJ30gTE9EIHtsb2RfbnVtfTogR3JpZCB7bnh9eHtueX14e256fSAiCiAgICAg
#3#ICAgICAgICAgZiIoe2xlbihjaHVua3NfZ3JpZCl9IGNodW5rcywge2xlbihhY3RpdmVfY2h1bmtz
#3#X2dyaWQpfSBhY3RpdmUgYWZ0ZXIgdGhyZXNob2xkaW5nKSIpCgogICAgICAgICMgV2Ugd2lsbCB0
#3#cmFjayBvY2N1cGFuY3kgdW5pb24gYWNyb3NzIGFsbCBjaGFubmVscyBmb3IgdGhlIGFjdGl2ZSBj
#3#aHVuayBncmlkCiAgICAgICAgb2NjdXBhbmN5X3VuaW9uID0gWzAuMF0gKiBsZW4oYWN0aXZlX2No
#3#dW5rc19ncmlkKQoKICAgICAgICAjIEZvciBlYWNoIGNoYW5uZWwsIG9wZW4gdGhlIHByb2Nlc3Nl
#3#ZCByYXcgYmluYXJ5IHZvbHVtZQogICAgICAgIGZvciBjX2lkeCBpbiByYW5nZShuX2NoKToKICAg
#3#ICAgICAgICAgYmluX2ZpbGUgPSB0ZW1wX2RpciAvIGYidHt0X2lkeDowM2R9X2N7Y19pZHh9X2xv
#3#ZHtsb2RfbnVtfS5iaW4iCgogICAgICAgICAgICBpZiBub3QgYmluX2ZpbGUuZXhpc3RzKCk6CiAg
#3#ICAgICAgICAgICAgICBwcmludChmIltXQVJOSU5HXSBQcm9jZXNzZWQgZmlsZSBub3QgZm91bmQ6
#3#IHtiaW5fZmlsZX0iKQogICAgICAgICAgICAgICAgY29udGludWUKCiAgICAgICAgICAgICMgTWVt
#3#b3J5IG1hcCB0aGUgdm9sdW1lCiAgICAgICAgICAgIHZvbHVtZV9kYXRhID0gbnAubWVtbWFwKAog
#3#ICAgICAgICAgICAgICAgc3RyKGJpbl9maWxlKSwKICAgICAgICAgICAgICAgIGR0eXBlPW5wLnVp
#3#bnQ4LAogICAgICAgICAgICAgICAgbW9kZT0iciIsCiAgICAgICAgICAgICAgICBzaGFwZT0oRCwg
#3#SCwgVykKICAgICAgICAgICAgKQoKICAgICAgICAgICAgIyBTZXR1cCBwYWNrZXIgZm9yIHRoaXMg
#3#TE9EICsgQ2hhbm5lbAogICAgICAgICAgICBjaGFubmVsX2xvZF9kaXIgPSB0cF9yb290IC8gZiJs
#3#b2R7bG9kX251bX0iIC8gZiJje2NfaWR4fSIKICAgICAgICAgICAgY2hhbm5lbF9sb2RfZGlyLm1r
#3#ZGlyKHBhcmVudHM9VHJ1ZSwgZXhpc3Rfb2s9VHJ1ZSkKCiAgICAgICAgICAgIGN1cnJlbnRfcGFj
#3#a19pZHggPSAwCiAgICAgICAgICAgIGN1cnJlbnRfcGFja19maWxlID0gTm9uZQogICAgICAgICAg
#3#ICBjdXJyZW50X3BhY2tfb2Zmc2V0ID0gMAogICAgICAgICAgICBjaHVua3NfaW5fY3VycmVudF9w
#3#YWNrID0gMAoKICAgICAgICAgICAgZGVmIGdldF9wYWNrX2ZpbGUoaWR4KToKICAgICAgICAgICAg
#3#ICAgIHBfZmlsZSA9IGNoYW5uZWxfbG9kX2RpciAvIGYicGFja197aWR4OjAyZH0uYmluIgogICAg
#3#ICAgICAgICAgICAgcmV0dXJuIHBfZmlsZSwgb3BlbihwX2ZpbGUsICJ3YiIpCgogICAgICAgICAg
#3#ICBwYWNrX2ZpbGVfcGF0aCwgY3VycmVudF9wYWNrX2ZpbGUgPSBnZXRfcGFja19maWxlKGN1cnJl
#3#bnRfcGFja19pZHgpCgogICAgICAgICAgICAjIFByZXBhcmUgYXJndW1lbnRzIGZvciBtdWx0aXBy
#3#b2Nlc3NpbmcKICAgICAgICAgICAgdGFza3MgPSBbXQogICAgICAgICAgICBmb3IgaSwgY2ggaW4g
#3#ZW51bWVyYXRlKGFjdGl2ZV9jaHVua3NfZ3JpZCk6CiAgICAgICAgICAgICAgICBjaF9tZXRhID0g
#3#eyJpZHgiOiBpLCAiYngiOiBjaFsiYngiXSwgImJ5IjogY2hbImJ5Il0sICJieiI6IGNoWyJieiJd
#3#LCAidmFsaWRWb3hlbENvdW50IjogY2hbInZhbGlkVm94ZWxDb3VudCJdfQogICAgICAgICAgICAg
#3#ICAgb3gsIG95LCBveiA9IGNoWyJtaW4iXQogICAgICAgICAgICAgICAgZXgsIGV5LCBleiA9IGNo
#3#WyJtYXgiXQogICAgICAgICAgICAgICAgY2h1bmtfZGF0YSA9IG5wLmNvcHkodm9sdW1lX2RhdGFb
#3#b3o6ZXosIG95OmV5LCBveDpleF0pCiAgICAgICAgICAgICAgICB0YXNrcy5hcHBlbmQoKGNodW5r
#3#X2RhdGEsIGNoX21ldGEsIEJSSUNLX1NJWkUpKQoKICAgICAgICAgICAgZnJvbSB0cWRtIGltcG9y
#3#dCB0cWRtCiAgICAgICAgICAgICMgZXhlY3V0b3IubWFwIHByZXNlcnZlcyB0aGUgb3JkZXIgb2Yg
#3#YWN0aXZlX2NodW5rc19ncmlkCiAgICAgICAgICAgIGZvciByZXN1bHQgaW4gdHFkbShleGVjdXRv
#3#ci5tYXAocHJvY2Vzc19jaHVuaywgdGFza3MpLCB0b3RhbD1sZW4odGFza3MpLAogICAgICAgICAg
#3#ICAgICAgICAgICAgICAgICAgICAgZGVzYz0iQ29tcHJlc3NpbmcgV2ViUCIsIGxlYXZlPUZhbHNl
#3#LCBhc2NpaT1UcnVlLCBtaW5pbnRlcnZhbD0yLjApOgogICAgICAgICAgICAgICAgaWR4LCBvY2Ms
#3#IGlzX25vbl9lbXB0eSwgY29tcHJlc3NlZF9ieXRlcyA9IHJlc3VsdAogICAgICAgICAgICAgICAg
#3#b2NjdXBhbmN5X3VuaW9uW2lkeF0gPSBtYXgob2NjdXBhbmN5X3VuaW9uW2lkeF0sIG9jYykKCiAg
#3#ICAgICAgICAgICAgICBpZiBpc19ub25fZW1wdHk6CiAgICAgICAgICAgICAgICAgICAgIyBDaGVj
#3#ayBpZiB3ZSBuZWVkIHRvIHJvbGwgb3ZlciB0byBhIG5ldyBwYWNrIGZpbGUKICAgICAgICAgICAg
#3#ICAgICAgICBpZiBjaHVua3NfaW5fY3VycmVudF9wYWNrID49IENIVU5LU19QRVJfUEFDSzoKICAg
#3#ICAgICAgICAgICAgICAgICAgICAgY3VycmVudF9wYWNrX2ZpbGUuY2xvc2UoKQogICAgICAgICAg
#3#ICAgICAgICAgICAgICAjIFJlY29yZCBoYXNoIG9mIGNvbXBsZXRlZCBwYWNrCiAgICAgICAgICAg
#3#ICAgICAgICAgICAgIHBhY2tfcmVsX3BhdGggPSBwYWNrX2ZpbGVfcGF0aC5yZWxhdGl2ZV90byh0
#3#cF9yb290KS5hc19wb3NpeCgpCiAgICAgICAgICAgICAgICAgICAgICAgIHBhY2tfaGFzaGVzW3Bh
#3#Y2tfcmVsX3BhdGhdID0gaGFzaGxpYi5zaGEyNTYocGFja19maWxlX3BhdGgucmVhZF9ieXRlcygp
#3#KS5oZXhkaWdlc3QoKQoKICAgICAgICAgICAgICAgICAgICAgICAgY3VycmVudF9wYWNrX2lkeCAr
#3#PSAxCiAgICAgICAgICAgICAgICAgICAgICAgIHBhY2tfZmlsZV9wYXRoLCBjdXJyZW50X3BhY2tf
#3#ZmlsZSA9IGdldF9wYWNrX2ZpbGUoY3VycmVudF9wYWNrX2lkeCkKICAgICAgICAgICAgICAgICAg
#3#ICAgICAgY3VycmVudF9wYWNrX29mZnNldCA9IDAKICAgICAgICAgICAgICAgICAgICAgICAgY2h1
#3#bmtzX2luX2N1cnJlbnRfcGFjayA9IDAKCiAgICAgICAgICAgICAgICAgICAgIyBXcml0ZSBjb21w
#3#cmVzc2VkIGJ5dGVzIHRvIGN1cnJlbnQgcGFjayBmaWxlCiAgICAgICAgICAgICAgICAgICAgY3Vy
#3#cmVudF9wYWNrX2ZpbGUud3JpdGUoY29tcHJlc3NlZF9ieXRlcykKCiAgICAgICAgICAgICAgICAg
#3#ICAgIyBTYXZlIG1hcHBpbmcgaW4gYnJpY2tUb1BhY2sKICAgICAgICAgICAgICAgICAgICBjaCA9
#3#IGFjdGl2ZV9jaHVua3NfZ3JpZFtpZHhdCiAgICAgICAgICAgICAgICAgICAgYngsIGJ5LCBieiA9
#3#IGNoWyJieCJdLCBjaFsiYnkiXSwgY2hbImJ6Il0KICAgICAgICAgICAgICAgICAgICBicmlja19y
#3#ZWxfa2V5ID0gZiJsb2R7bG9kX251bX0vY3tjX2lkeH0veHtieDowM2R9X3l7Ynk6MDNkfV96e2J6
#3#OjAzZH0ud2VicCIKICAgICAgICAgICAgICAgICAgICBwYWNrX3JlbF9wYXRoID0gcGFja19maWxl
#3#X3BhdGgucmVsYXRpdmVfdG8odHBfcm9vdCkuYXNfcG9zaXgoKQoKICAgICAgICAgICAgICAgICAg
#3#ICBicmlja190b19wYWNrW2JyaWNrX3JlbF9rZXldID0gewogICAgICAgICAgICAgICAgICAgICAg
#3#ICAidXJsIjogcGFja19yZWxfcGF0aCwKICAgICAgICAgICAgICAgICAgICAgICAgIm9mZnNldCI6
#3#IGludChjdXJyZW50X3BhY2tfb2Zmc2V0KSwKICAgICAgICAgICAgICAgICAgICAgICAgImxlbmd0
#3#aCI6IGludChsZW4oY29tcHJlc3NlZF9ieXRlcykpCiAgICAgICAgICAgICAgICAgICAgfQoKICAg
#3#ICAgICAgICAgICAgICAgICBjdXJyZW50X3BhY2tfb2Zmc2V0ICs9IGxlbihjb21wcmVzc2VkX2J5
#3#dGVzKQogICAgICAgICAgICAgICAgICAgIGNodW5rc19pbl9jdXJyZW50X3BhY2sgKz0gMQoKICAg
#3#ICAgICAgICAgIyBDbG9zZSB0aGUgZmluYWwgcGFjayBmaWxlIGZvciB0aGlzIGNoYW5uZWwKICAg
#3#ICAgICAgICAgaWYgY3VycmVudF9wYWNrX2ZpbGU6CiAgICAgICAgICAgICAgICBjdXJyZW50X3Bh
#3#Y2tfZmlsZS5jbG9zZSgpCiAgICAgICAgICAgICAgICBwYWNrX3JlbF9wYXRoID0gcGFja19maWxl
#3#X3BhdGgucmVsYXRpdmVfdG8odHBfcm9vdCkuYXNfcG9zaXgoKQogICAgICAgICAgICAgICAgcGFj
#3#a19oYXNoZXNbcGFja19yZWxfcGF0aF0gPSBoYXNobGliLnNoYTI1NihwYWNrX2ZpbGVfcGF0aC5y
#3#ZWFkX2J5dGVzKCkpLmhleGRpZ2VzdCgpCgogICAgICAgICAgICAjIENsb3NlIG1lbW1hcCBmaWxl
#3#IGhhbmRsZQogICAgICAgICAgICBkZWwgdm9sdW1lX2RhdGEKCiAgICAgICAgIyBCdWlsZCBsZXZl
#3#bCBjaHVua3MgbGlzdCBmb3IgbWFuaWZlc3QKICAgICAgICBtYW5pZmVzdF9jaHVua3MgPSBbXQog
#3#ICAgICAgIG5vbl9lbXB0eV9jb3VudCA9IDAKICAgICAgICBmb3IgaSwgY2ggaW4gZW51bWVyYXRl
#3#KGFjdGl2ZV9jaHVua3NfZ3JpZCk6CiAgICAgICAgICAgIGlzX25vbl9lbXB0eSA9IG9jY3VwYW5j
#3#eV91bmlvbltpXSA+IEVTU19NSU5fT0NDVVBBTkNZCiAgICAgICAgICAgIGlmIGlzX25vbl9lbXB0
#3#eToKICAgICAgICAgICAgICAgIG5vbl9lbXB0eV9jb3VudCArPSAxCiAgICAgICAgICAgIG1hbmlm
#3#ZXN0X2NodW5rcy5hcHBlbmQoewogICAgICAgICAgICAgICAgImlkIjogZiJ7Y2hbJ2J6J119X3tj
#3#aFsnYnknXX1fe2NoWydieCddfSIsCiAgICAgICAgICAgICAgICAibWluIjogY2hbIm1pbiJdLAog
#3#ICAgICAgICAgICAgICAgIm1heCI6IGNoWyJtYXgiXSwKICAgICAgICAgICAgICAgICJvY2N1cGll
#3#ZFJhdGlvIjogcm91bmQob2NjdXBhbmN5X3VuaW9uW2ldLCA2KSwKICAgICAgICAgICAgICAgICJu
#3#b25FbXB0eSI6IGlzX25vbl9lbXB0eQogICAgICAgICAgICB9KQoKICAgICAgICBsZXZlbHNfbWFu
#3#aWZlc3QuYXBwZW5kKHsKICAgICAgICAgICAgImxldmVsIjogbG9kX251bSwKICAgICAgICAgICAg
#3#InNjYWxlIjogMS4wIC8gKDIgKiogbG9kX251bSksCiAgICAgICAgICAgICJkaW1lbnNpb25zIjog
#3#eyJ4IjogVywgInkiOiBILCAieiI6IER9LAogICAgICAgICAgICAiYnJpY2tTaXplIjogQlJJQ0tf
#3#U0laRSwKICAgICAgICAgICAgImdyaWRTaXplIjogeyJ4IjogbngsICJ5IjogbnksICJ6Ijogbnp9
#3#LAogICAgICAgICAgICAiYnJpY2tDb3VudCI6IGxlbihjaHVua3NfZ3JpZCksCiAgICAgICAgICAg
#3#ICJjaHVua3MiOiBtYW5pZmVzdF9jaHVua3MsCiAgICAgICAgICAgICJub25FbXB0eUNvdW50Ijog
#3#bm9uX2VtcHR5X2NvdW50CiAgICAgICAgfSkKCiAgICB0cmFuc3BvcnQgPSB7CiAgICAgICAgIm1v
#3#ZGUiOiAicGFja3MiLAogICAgICAgICJlbmNvZGluZyI6ICJ3ZWJwLWxvc3NsZXNzIiwKICAgICAg
#3#ICAicGFja1NpemUiOiBDSFVOS1NfUEVSX1BBQ0ssCiAgICAgICAgImJyaWNrVG9QYWNrIjogYnJp
#3#Y2tfdG9fcGFjaywKICAgICAgICAicGFja0hhc2hlcyI6IHBhY2tfaGFzaGVzCiAgICB9CiAgICBy
#3#ZXR1cm4gbGV2ZWxzX21hbmlmZXN0LCB0cmFuc3BvcnQKCgpkZWYgYnVpbGRfcGFja3ModGVtcF9k
#3#aXI6IFBhdGgsIG91dHB1dF9kaXI6IFBhdGgpOgogICAgd2l0aCBvcGVuKHRlbXBfZGlyIC8gInBy
#3#b2Nlc3NpbmdfbWV0YS5qc29uIiwgInIiLCBlbmNvZGluZz0idXRmLTgiKSBhcyBmbToKICAgICAg
#3#ICBwcm9jX21ldGEgPSBqc29uLmxvYWQoZm0pCgogICAgbG9kX2xldmVscyA9IHByb2NfbWV0YVsi
#3#bG9kX2xldmVscyJdCiAgICBuX2NoID0gcHJvY19tZXRhWyJuX2NoYW5uZWxzIl0KICAgIG5fdHAg
#3#PSBwcm9jX21ldGFbIm5fdGltZXBvaW50cyJdCiAgICB2b3hlbF9zaXplID0gcHJvY19tZXRhWyJ2
#3#b3hlbF9zaXplIl0KICAgIGNoYW5uZWxfbmFtZXMgPSBwcm9jX21ldGFbImNoYW5uZWxfbmFtZXMi
#3#XQoKICAgIGJyaWNrc19kaXIgPSBvdXRwdXRfZGlyIC8gImJyaWNrcyIKICAgIGJyaWNrc19kaXIu
#3#bWtkaXIocGFyZW50cz1UcnVlLCBleGlzdF9vaz1UcnVlKQoKICAgIEJSSUNLX1NJWkUgPSA2NAog
#3#ICAgQ0hVTktTX1BFUl9QQUNLID0gMTI4CgogICAgaXNfdGltZWxhcHNlID0gbl90cCA+IDEKCiAg
#3#ICAjIE9uZSBwcm9jZXNzIHBvb2wgZm9yIHRoZSB3aG9sZSBydW46IGEgdGltZWxhcHNlIHBhY2tz
#3#IG5fdHAgeCBuX2xvZCB4IG5fY2gKICAgICMgYmF0Y2hlcyBhbmQgcmUtc3Bhd25pbmcgYSBwb29s
#3#IGZvciBlYWNoIHdvdWxkIGRvbWluYXRlIHRoZSBydW50aW1lLgogICAgd2l0aCBQcm9jZXNzUG9v
#3#bEV4ZWN1dG9yKG1heF93b3JrZXJzPW9zLmNwdV9jb3VudCgpKSBhcyBleGVjdXRvcjoKICAgICAg
#3#ICBpZiBub3QgaXNfdGltZWxhcHNlOgogICAgICAgICAgICBsZXZlbHNfbWFuaWZlc3QsIHRyYW5z
#3#cG9ydCA9IF9wYWNrX3RpbWVwb2ludCgKICAgICAgICAgICAgICAgIHRlbXBfZGlyLCBicmlja3Nf
#3#ZGlyLCAwLCBsb2RfbGV2ZWxzLCBuX2NoLCBleGVjdXRvciwgIiIKICAgICAgICAgICAgKQogICAg
#3#ICAgICAgICB0aW1lcG9pbnRzX21hbmlmZXN0ID0gTm9uZQogICAgICAgIGVsc2U6CiAgICAgICAg
#3#ICAgIHRpbWVwb2ludHNfbWFuaWZlc3QgPSB7fQogICAgICAgICAgICBsZXZlbHNfbWFuaWZlc3Qg
#3#PSBOb25lCiAgICAgICAgICAgIHRyYW5zcG9ydCA9IE5vbmUKICAgICAgICAgICAgZm9yIHRfaWR4
#3#IGluIHJhbmdlKG5fdHApOgogICAgICAgICAgICAgICAga2V5ID0gZiJ0e3RfaWR4OjAzZH0iCiAg
#3#ICAgICAgICAgICAgICBwcmludChmIltQQUNLRVJdID09PSB0aW1lcG9pbnQge3RfaWR4ICsgMX0v
#3#e25fdHB9ICh7a2V5fSkgPT09IikKICAgICAgICAgICAgICAgIHRwX2xldmVscywgdHBfdHJhbnNw
#3#b3J0ID0gX3BhY2tfdGltZXBvaW50KAogICAgICAgICAgICAgICAgICAgIHRlbXBfZGlyLCBicmlj
#3#a3NfZGlyLCB0X2lkeCwgbG9kX2xldmVscywgbl9jaCwgZXhlY3V0b3IsIGtleQogICAgICAgICAg
#3#ICAgICAgKQogICAgICAgICAgICAgICAgdGltZXBvaW50c19tYW5pZmVzdFtrZXldID0gewogICAg
#3#ICAgICAgICAgICAgICAgICJwYXRoIjoga2V5LAogICAgICAgICAgICAgICAgICAgICJjaGFubmVs
#3#cyI6IG5fY2gsCiAgICAgICAgICAgICAgICAgICAgImxldmVscyI6IHRwX2xldmVscywKICAgICAg
#3#ICAgICAgICAgICAgICAiYnJpY2tUcmFuc3BvcnQiOiB0cF90cmFuc3BvcnQsCiAgICAgICAgICAg
#3#ICAgICAgICAgImhpc3RvZ3JhbXMiOiBbXSAgICMgZmlsbGVkIGJ5IHN0ZXAgNAogICAgICAgICAg
#3#ICAgICAgfQogICAgICAgICAgICAgICAgaWYgdF9pZHggPT0gMDoKICAgICAgICAgICAgICAgICAg
#3#ICAjIE1pcnJvcmVkIGF0IHRoZSB0b3AgbGV2ZWwgc28gYSBjb25zdW1lciB0aGF0IGlnbm9yZXMg
#3#YHRpbWVwb2ludHNgCiAgICAgICAgICAgICAgICAgICAgIyBzdGlsbCBtb3VudHMgYSBjb2hlcmVu
#3#dCAoZmlyc3QtZnJhbWUpIGRhdGFzZXQgaW5zdGVhZCBvZiBmYWlsaW5nLgogICAgICAgICAgICAg
#3#ICAgICAgIGxldmVsc19tYW5pZmVzdCA9IHRwX2xldmVscwogICAgICAgICAgICAgICAgICAgIHRy
#3#YW5zcG9ydCA9IHRwX3RyYW5zcG9ydAoKICAgICMgQXNzZW1ibGUgYW5kIHdyaXRlIG1hbmlmZXN0
#3#Lmpzb24KICAgIG1hbmlmZXN0ID0gewogICAgICAgICJ2ZXJzaW9uIjogMiwKICAgICAgICAic2No
#3#ZW1hIjogImlyaWJobS1icmlja3MtdjIiLAogICAgICAgICJkYXRhc2V0Ijogb3V0cHV0X2Rpci5u
#3#YW1lLAogICAgICAgICJkYXRhc2V0VHlwZSI6ICJsaXZlIiBpZiBpc190aW1lbGFwc2UgZWxzZSAi
#3#M2QiLAogICAgICAgICJjaGFubmVscyI6IG5fY2gsCiAgICAgICAgImJyaWNrU2l6ZSI6IEJSSUNL
#3#X1NJWkUsCiAgICAgICAgImJyaWNrUGFja2luZyI6IHsibW9kZSI6ICJncmlkIiwgImNvbHMiOiA4
#3#LCAicm93cyI6IDh9LAogICAgICAgICJ2b3hlbFNpemUiOiB2b3hlbF9zaXplLAogICAgICAgICJj
#3#cmVhdGVkQXQiOiBfX2ltcG9ydF9fKCJkYXRldGltZSIpLmRhdGV0aW1lLm5vdygpLmlzb2Zvcm1h
#3#dCgpLAogICAgICAgICJsZXZlbHMiOiBsZXZlbHNfbWFuaWZlc3QsCiAgICAgICAgImhpc3RvZ3Jh
#3#bXMiOiBbXSwgIyBXaWxsIGJlIHBvcHVsYXRlZCBieSBzdGVwIDQgb3IgZHluYW1pYyBzY2FuCiAg
#3#ICAgICAgImhhc2hlcyI6IHt9LCAgICAgIyBMZWZ0IGVtcHR5IGFzIHdlIHVzZSBwYWNrIHRyYW5z
#3#cG9ydAogICAgICAgICJ0aW1lcG9pbnRzIjogdGltZXBvaW50c19tYW5pZmVzdCwKICAgICAgICAi
#3#YnJpY2tUcmFuc3BvcnQiOiB0cmFuc3BvcnQKICAgIH0KCiAgICB3aXRoIG9wZW4oYnJpY2tzX2Rp
#3#ciAvICJtYW5pZmVzdC5qc29uIiwgInciLCBlbmNvZGluZz0idXRmLTgiKSBhcyBmbToKICAgICAg
#3#ICBqc29uLmR1bXAobWFuaWZlc3QsIGZtLCBpbmRlbnQ9MikKCiAgICBwcmludChmIltQQUNLRVJd
#3#IFdyb3RlIG1hbmlmZXN0Lmpzb24gdG8ge2JyaWNrc19kaXIgLyAnbWFuaWZlc3QuanNvbid9IikK
#3#ICAgIGlmIGlzX3RpbWVsYXBzZToKICAgICAgICBzaXplX21iID0gKGJyaWNrc19kaXIgLyAibWFu
#3#aWZlc3QuanNvbiIpLnN0YXQoKS5zdF9zaXplIC8gMWU2CiAgICAgICAgcHJpbnQoZiJbUEFDS0VS
#3#XSB7bl90cH0gdGltZXBvaW50cyBpbmRleGVkLCBtYW5pZmVzdCB7c2l6ZV9tYjouMmZ9IE1CIikK
#3#CmlmIF9fbmFtZV9fID09ICJfX21haW5fXyI6CiAgICBpZiBsZW4oc3lzLmFyZ3YpIDwgMzoKICAg
#3#ICAgICBwcmludCgiVXNhZ2U6IHB5dGhvbiAzLWNodW5rX3BhY2tlci5weSA8dGVtcF9kaXI+IDxv
#3#dXRwdXRfZGlyPiIpCiAgICAgICAgc3lzLmV4aXQoMSkKCiAgICB0ZW1wX2RpciA9IFBhdGgoc3lz
#3#LmFyZ3ZbMV0pCiAgICBvdXRwdXRfZGlyID0gUGF0aChzeXMuYXJndlsyXSkKCiAgICB0cnk6CiAg
#3#ICAgICAgYnVpbGRfcGFja3ModGVtcF9kaXIsIG91dHB1dF9kaXIpCiAgICAgICAgcHJpbnQoZiJb
#3#UEFDS0VSXSBDaHVuayBwYWNrYWdpbmcgY29tcGxldGUuIikKICAgIGV4Y2VwdCBFeGNlcHRpb24g
#3#YXMgZToKICAgICAgICBpbXBvcnQgdHJhY2ViYWNrCiAgICAgICAgdHJhY2ViYWNrLnByaW50X2V4
#3#YygpCiAgICAgICAgcHJpbnQoZiJbRVJST1JdIENodW5rIHBhY2thZ2luZyBmYWlsZWQ6IHtlfSIs
#3#IGZpbGU9c3lzLnN0ZGVycikKICAgICAgICBzeXMuZXhpdCgxKQo=
:: ---- [4] 4-catalog_generator.py (9662 octets) ----
#4#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwppbXBvcnQganNvbgppbXBvcnQgcmUKaW1wb3J0IHN5cwpm
#4#cm9tIHBhdGhsaWIgaW1wb3J0IFBhdGgKaW1wb3J0IG51bXB5IGFzIG5wCgpDT0xPUlMgPSBbIiMw
#4#MEZGMDAiLCAiIzAwQUFGRiIsICIjRkYwMEZGIiwgIiNGRjAwMDAiLCAiI0ZGRkYwMCIsICIjMDBG
#4#RkZGIl0KCmRlZiBfcGFyc2Vfc3RhZ2UobmFtZTogc3RyKToKICAgIGZvciBwYXR0ZXJuIGluIChy
#4#Ii0oRShcZCg/OlwuP1xkKyk/KSkoJHwtKSIsIHIiXihFKFxkKD86XC4/XGQrKT8pKSgtfCQpIik6
#4#CiAgICAgICAgbSA9IHJlLnNlYXJjaChwYXR0ZXJuLCBuYW1lLCByZS5JR05PUkVDQVNFKQogICAg
#4#ICAgIGlmIG06CiAgICAgICAgICAgIHJhdyA9IG0uZ3JvdXAoMikucmVwbGFjZSgiLiIsICIiKQog
#4#ICAgICAgICAgICBkaXNwbGF5ID0gZiJFe3Jhd30iIGlmIGxlbihyYXcpID09IDEgZWxzZSBmIkV7
#4#cmF3WzBdfS57cmF3WzE6XX0iCiAgICAgICAgICAgIG51bWVyaWMgPSBmbG9hdChyYXcpIGlmIGxl
#4#bihyYXcpID09IDEgZWxzZSBmbG9hdChmIntyYXdbMF19LntyYXdbMTpdfSIpCiAgICAgICAgICAg
#4#IHJldHVybiBkaXNwbGF5LCBudW1lcmljCiAgICByZXR1cm4gIlVua25vd24iLCAwLjAKCmRlZiBf
#4#cGFyc2VfZW1icnlvKG5hbWU6IHN0cik6CiAgICBtID0gcmUuc2VhcmNoKHIiLShFbVxkKyktIiwg
#4#bmFtZSwgcmUuSUdOT1JFQ0FTRSkKICAgIHJldHVybiBtLmdyb3VwKDEpIGlmIG0gZWxzZSBOb25l
#4#CgpkZWYgZ2VuZXJhdGVfY2F0YWxvZ19tZXRhZGF0YSh0ZW1wX2RpcjogUGF0aCwgb3V0cHV0X2Rp
#4#cjogUGF0aCk6CiAgICB3aXRoIG9wZW4odGVtcF9kaXIgLyAicHJvY2Vzc2luZ19tZXRhLmpzb24i
#4#LCAiciIsIGVuY29kaW5nPSJ1dGYtOCIpIGFzIGZtOgogICAgICAgIHByb2NfbWV0YSA9IGpzb24u
#4#bG9hZChmbSkKICAgICAgICAKICAgIGxvZF9sZXZlbHMgPSBwcm9jX21ldGFbImxvZF9sZXZlbHMi
#4#XQogICAgbl9jaCA9IHByb2NfbWV0YVsibl9jaGFubmVscyJdCiAgICBuX3RwID0gcHJvY19tZXRh
#4#WyJuX3RpbWVwb2ludHMiXQogICAgdm94ZWxfc2l6ZSA9IHByb2NfbWV0YVsidm94ZWxfc2l6ZSJd
#4#CiAgICBjaGFubmVsX25hbWVzID0gcHJvY19tZXRhWyJjaGFubmVsX25hbWVzIl0KICAgIFcgPSBw
#4#cm9jX21ldGFbIndpZHRoIl0KICAgIEggPSBwcm9jX21ldGFbImhlaWdodCJdCiAgICBEID0gcHJv
#4#Y19tZXRhWyJkZXB0aCJdCiAgICAKICAgICMgUGFyc2Ugc3RhZ2UgYW5kIGVtYnJ5byBmcm9tIGZv
#4#bGRlciBuYW1lCiAgICBkYXRhc2V0X25hbWUgPSBvdXRwdXRfZGlyLm5hbWUKICAgIHN0YWdlLCBz
#4#dGFnZV9udW0gPSBfcGFyc2Vfc3RhZ2UoZGF0YXNldF9uYW1lKQogICAgZW1icnlvID0gX3BhcnNl
#4#X2VtYnJ5byhkYXRhc2V0X25hbWUpCiAgICAKICAgICMgVGhlIGRpcmVjdG9yeSBhIGRhdGFzZXQg
#4#c2l0cyBpbiBJUyBpdHMgdHlwZSAoJzNkJywgJ2xpdmUnLCAndHJhY2tpbmcnKSwgc28gdGhlCiAg
#4#ICAjIHR5cGUsIHRoZSBpZCBhbmQgdGhlIGJ5dGUgcGF0aCBhbGwgZGVyaXZlIGZyb20gdGhlIHNh
#4#bWUgc3RyaW5nLgogICAgZGF0YXNldF90eXBlID0gb3V0cHV0X2Rpci5wYXJlbnQubmFtZQogICAg
#4#cmVsX3BhdGhfc3RyID0gZiJEQVRBX1dFQi97ZGF0YXNldF90eXBlfS97ZGF0YXNldF9uYW1lfSIK
#4#ICAgIAogICAgIyAxLiBDb21wdXRlIEhpc3RvZ3JhbXMgb24gdGhlIGhpZ2hlc3QgTE9EIGxldmVs
#4#IHRvIHNhdmUgdGltZSBhbmQgUkFNCiAgICBoaWdoZXN0X2xvZCA9IGxvZF9sZXZlbHNbLTFdWyJs
#4#b2QiXQogICAgbG9kX3cgPSBsb2RfbGV2ZWxzWy0xXVsid2lkdGgiXQogICAgbG9kX2ggPSBsb2Rf
#4#bGV2ZWxzWy0xXVsiaGVpZ2h0Il0KCiAgICBkZWYgX2hpc3RvZ3JhbXNfZm9yX3RpbWVwb2ludCh0
#4#X2lkeDogaW50KToKICAgICAgICBvdXQgPSBbXQogICAgICAgIGZvciBjX2lkeCBpbiByYW5nZShu
#4#X2NoKToKICAgICAgICAgICAgYmluX2ZpbGUgPSB0ZW1wX2RpciAvIGYidHt0X2lkeDowM2R9X2N7
#4#Y19pZHh9X2xvZHtoaWdoZXN0X2xvZH0uYmluIgogICAgICAgICAgICBpZiBiaW5fZmlsZS5leGlz
#4#dHMoKToKICAgICAgICAgICAgICAgIHZvbF9kYXRhID0gbnAuZnJvbWZpbGUoc3RyKGJpbl9maWxl
#4#KSwgZHR5cGU9bnAudWludDgpCiAgICAgICAgICAgICAgICBjb3VudHMsIGVkZ2VzID0gbnAuaGlz
#4#dG9ncmFtKHZvbF9kYXRhLCBiaW5zPTY0LCByYW5nZT0oMCwgMjU1KSkKCiAgICAgICAgICAgICAg
#4#ICBtZWFuX3ZhbCA9IGZsb2F0KHZvbF9kYXRhLm1lYW4oKSkgaWYgdm9sX2RhdGEuc2l6ZSBlbHNl
#4#IDAuMAogICAgICAgICAgICAgICAgc3RkX3ZhbCA9IGZsb2F0KHZvbF9kYXRhLnN0ZCgpKSBpZiB2
#4#b2xfZGF0YS5zaXplIGVsc2UgMC4wCiAgICAgICAgICAgICAgICBtYXhfdmFsID0gaW50KHZvbF9k
#4#YXRhLm1heCgpKSBpZiB2b2xfZGF0YS5zaXplIGVsc2UgMAoKICAgICAgICAgICAgICAgIG91dC5h
#4#cHBlbmQoewogICAgICAgICAgICAgICAgICAgICJjb3VudHMiOiBjb3VudHMuYXN0eXBlKG5wLmlu
#4#dDY0KS50b2xpc3QoKSwKICAgICAgICAgICAgICAgICAgICAiZWRnZXMiOiBlZGdlcy5hc3R5cGUo
#4#bnAuZmxvYXQ2NCkudG9saXN0KCksCiAgICAgICAgICAgICAgICAgICAgInRvdGFsIjogaW50KHZv
#4#bF9kYXRhLnNpemUpLAogICAgICAgICAgICAgICAgICAgICJtYXgiOiBtYXhfdmFsLAogICAgICAg
#4#ICAgICAgICAgICAgICJtZWFuIjogbWVhbl92YWwsCiAgICAgICAgICAgICAgICAgICAgInN0ZCI6
#4#IHN0ZF92YWwsCiAgICAgICAgICAgICAgICAgICAgImJhY2tncm91bmRGbG9vciI6IDAKICAgICAg
#4#ICAgICAgICAgIH0pCiAgICAgICAgICAgICAgICBkZWwgdm9sX2RhdGEKICAgICAgICAgICAgZWxz
#4#ZToKICAgICAgICAgICAgICAgIHByaW50KGYiW1dBUk5JTkddIEJpbiBmaWxlIGZvciBoaXN0b2dy
#4#YW0gbm90IGZvdW5kOiB7YmluX2ZpbGV9IikKICAgICAgICAgICAgICAgIG91dC5hcHBlbmQoewog
#4#ICAgICAgICAgICAgICAgICAgICJjb3VudHMiOiBbMF0gKiA2NCwKICAgICAgICAgICAgICAgICAg
#4#ICAiZWRnZXMiOiBsaXN0KHJhbmdlKDY1KSksCiAgICAgICAgICAgICAgICAgICAgInRvdGFsIjog
#4#MCwKICAgICAgICAgICAgICAgICAgICAibWF4IjogMCwKICAgICAgICAgICAgICAgICAgICAibWVh
#4#biI6IDAuMCwKICAgICAgICAgICAgICAgICAgICAic3RkIjogMC4wLAogICAgICAgICAgICAgICAg
#4#ICAgICJiYWNrZ3JvdW5kRmxvb3IiOiAwCiAgICAgICAgICAgICAgICB9KQogICAgICAgIHJldHVy
#4#biBvdXQKCiAgICBwcmludChmIltDQVRBTE9HXSBDb21wdXRpbmcgaGlzdG9ncmFtcyBvbiBMT0Qg
#4#e2hpZ2hlc3RfbG9kfSAoe2xvZF93fXh7bG9kX2h9eHtEfSkiCiAgICAgICAgICBmIntmJyBmb3Ig
#4#e25fdHB9IHRpbWVwb2ludHMnIGlmIG5fdHAgPiAxIGVsc2UgJyd9Li4uIikKICAgIGhpc3RvZ3Jh
#4#bXMgPSBfaGlzdG9ncmFtc19mb3JfdGltZXBvaW50KDApCgogICAgIyAyLiBVcGRhdGUgYnJpY2tz
#4#L21hbmlmZXN0Lmpzb24gd2l0aCBjYWxjdWxhdGVkIGhpc3RvZ3JhbXMKICAgIG1hbmlmZXN0X3Bh
#4#dGggPSBvdXRwdXRfZGlyIC8gImJyaWNrcyIgLyAibWFuaWZlc3QuanNvbiIKICAgIGlmIG1hbmlm
#4#ZXN0X3BhdGguZXhpc3RzKCk6CiAgICAgICAgd2l0aCBvcGVuKG1hbmlmZXN0X3BhdGgsICJyIiwg
#4#ZW5jb2Rpbmc9InV0Zi04IikgYXMgZjoKICAgICAgICAgICAgbWFuaWZlc3QgPSBqc29uLmxvYWQo
#4#ZikKICAgICAgICBtYW5pZmVzdFsiaGlzdG9ncmFtcyJdID0gaGlzdG9ncmFtcwogICAgICAgICMg
#4#QSB0aW1lbGFwc2UgY2FycmllcyBvbmUgaGlzdG9ncmFtIHNldCBwZXIgZnJhbWU6IHRoZSBjaGFu
#4#bmVsIHBhbmVsIHJlYWRzCiAgICAgICAgIyB0aGUgcm93IG9mIHRoZSB0aW1lcG9pbnQgb24gc2Ny
#4#ZWVuLCBhbmQgYSBzaGFyZWQgc2V0IHdvdWxkIG1pcy1zY2FsZSB0aGUKICAgICAgICAjIHNsaWRl
#4#cnMgYXMgdGhlIHNwZWNpbWVuIGJsZWFjaGVzLgogICAgICAgIHRwX21hbmlmZXN0ID0gbWFuaWZl
#4#c3QuZ2V0KCJ0aW1lcG9pbnRzIikKICAgICAgICBpZiBpc2luc3RhbmNlKHRwX21hbmlmZXN0LCBk
#4#aWN0KToKICAgICAgICAgICAgZm9yIHRfaWR4IGluIHJhbmdlKG5fdHApOgogICAgICAgICAgICAg
#4#ICAga2V5ID0gZiJ0e3RfaWR4OjAzZH0iCiAgICAgICAgICAgICAgICBpZiBrZXkgaW4gdHBfbWFu
#4#aWZlc3Q6CiAgICAgICAgICAgICAgICAgICAgdHBfbWFuaWZlc3Rba2V5XVsiaGlzdG9ncmFtcyJd
#4#ID0gKGhpc3RvZ3JhbXMgaWYgdF9pZHggPT0gMAogICAgICAgICAgICAgICAgICAgICAgICAgICAg
#4#ICAgICAgICAgICAgICAgICAgICAgICAgICBlbHNlIF9oaXN0b2dyYW1zX2Zvcl90aW1lcG9pbnQo
#4#dF9pZHgpKQogICAgICAgIHdpdGggb3BlbihtYW5pZmVzdF9wYXRoLCAidyIsIGVuY29kaW5nPSJ1
#4#dGYtOCIpIGFzIGY6CiAgICAgICAgICAgIGpzb24uZHVtcChtYW5pZmVzdCwgZiwgaW5kZW50PTIp
#4#CiAgICAgICAgcHJpbnQoZiJbQ0FUQUxPR10gSW5qZWN0ZWQgaGlzdG9ncmFtcyBpbnRvIG1hbmlm
#4#ZXN0Lmpzb24iKQogICAgZWxzZToKICAgICAgICBwcmludChmIltXQVJOSU5HXSBtYW5pZmVzdC5q
#4#c29uIG5vdCBmb3VuZCB0byB1cGRhdGUgaGlzdG9ncmFtcy4iKQoKICAgICMgMy4gQ2FsY3VsYXRl
#4#IFBoeXNpY2FsIENhbGlicmF0aW9uCiAgICB2eCA9IHZveGVsX3NpemVbIngiXQogICAgdnkgPSB2
#4#b3hlbF9zaXplWyJ5Il0KICAgIHZ6ID0gdm94ZWxfc2l6ZVsieiJdCgogICAgZXh0ZW50ID0gcHJv
#4#Y19tZXRhLmdldCgiZXh0ZW50Iikgb3Ige30KICAgIGV4dF9taW4gPSBleHRlbnQuZ2V0KCJtaW4i
#4#KSBvciBbMC4wLCAwLjAsIDAuMF0KICAgIGV4dF9tYXggPSBleHRlbnQuZ2V0KCJtYXgiKSBvciBb
#4#VyAqIHZ4LCBIICogdnksIEQgKiB2el0KCiAgICAjIFRoZSB2aWV3ZXIgbW9kZWxzIGRlcHRoIGFz
#4#IChELTEpIHotc3RlcHMgcGx1cyBvbmUgc2xpY2UgdGhpY2tuZXNzLCBhbmQgd2l0aG91dAogICAg
#4#IyBhbiBleHBsaWNpdCB2YWx1ZSBpdCBndWVzc2VzIHRoYXQgdGhpY2tuZXNzIGFzIG1pbih6U3Rl
#4#cCwgdm94ZWxYKSDigJQgd2hpY2ggZm9yIGFuCiAgICAjIGFuaXNvdHJvcGljIHN0YWNrIHVuZGVy
#4#LXJlcG9ydHMgdGhlIGRlcHRoIChoZXJlIDMyOS41MCB1bSBpbnN0ZWFkIG9mIHRoZSAzMzMuODcg
#4#dW0KICAgICMgSW1hcmlzIHN0YXRlcykuIERlY2xhcmluZyB0aGUgc2xpY2UgdGhpY2tuZXNzIGVx
#4#dWFsIHRvIHRoZSB6LXN0ZXAgcmVwcm9kdWNlcyB0aGUKICAgICMgbWljcm9zY29wZSdzIG93biBl
#4#eHRlbnQgZXhhY3RseSwgd2hpY2ggaXMgbWFuZGF0b3J5IGZvciBhbnl0aGluZyByZWdpc3RlcmVk
#4#IGluCiAgICAjIEltYXJpcyBjb29yZGluYXRlcyAoY2VsbCB0cmFja3MpIHRvIGxhbmQgb24gdGhl
#4#IHJpZ2h0IHZveGVscy4KICAgIHNsaWNlX3RoaWNrbmVzcyA9IChleHRfbWF4WzJdIC0gZXh0X21p
#4#blsyXSkgLyBtYXgoRCwgMSkKICAgIHBoeXNpY2FsX3NpemUgPSB7CiAgICAgICAgIngiOiBleHRf
#4#bWF4WzBdIC0gZXh0X21pblswXSwKICAgICAgICAieSI6IGV4dF9tYXhbMV0gLSBleHRfbWluWzFd
#4#LAogICAgICAgICJ6IjogZXh0X21heFsyXSAtIGV4dF9taW5bMl0sCiAgICAgICAgInNsaWNlVGhp
#4#Y2tuZXNzIjogc2xpY2VfdGhpY2tuZXNzLAogICAgICAgICJ2b3hlbFgiOiB2eCwKICAgICAgICAi
#4#dm94ZWxZIjogdnksCiAgICAgICAgInZveGVsWiI6IHZ6CiAgICB9CiAgICAKICAgIGludGVydmFs
#4#ID0gcHJvY19tZXRhLmdldCgidGltZV9pbnRlcnZhbF9taW51dGVzIikKICAgIHRpbWVzdGFtcHMg
#4#PSBwcm9jX21ldGEuZ2V0KCJ0aW1lc3RhbXBzIikgb3IgW10KCiAgICAjIFNldHVwIGRlZmF1bHQg
#4#Y2hhbm5lbHMgaW5mbyBmb3IgbWV0YWRhdGEuanNvbgogICAgY2hhbm5lbHNfaW5mbyA9IFtdCiAg
#4#ICBmb3IgaSBpbiByYW5nZShuX2NoKToKICAgICAgICBjaF9uYW1lID0gY2hhbm5lbF9uYW1lc1tp
#4#XSBpZiBpIDwgbGVuKGNoYW5uZWxfbmFtZXMpIGVsc2UgZiJDaGFubmVsIHtpKzF9IgogICAgICAg
#4#IGNoYW5uZWxzX2luZm8uYXBwZW5kKHsKICAgICAgICAgICAgIm5hbWUiOiBjaF9uYW1lLAogICAg
#4#ICAgICAgICAiY29sb3IiOiBDT0xPUlNbaSAlIGxlbihDT0xPUlMpXSwKICAgICAgICAgICAgIm1p
#4#biI6IDAuMCwKICAgICAgICAgICAgIm1heCI6IDEuMCwKICAgICAgICAgICAgImdhbW1hIjogMS4w
#4#CiAgICAgICAgfSkKCiAgICAjIEJ1aWxkIG1ldGFkYXRhLmpzb24KICAgIG1ldGFkYXRhID0gewog
#4#ICAgICAgICJpZCI6IGYie2RhdGFzZXRfdHlwZX0ve2RhdGFzZXRfbmFtZX0iLAogICAgICAgICJu
#4#YW1lIjogZGF0YXNldF9uYW1lLAogICAgICAgICJ0eXBlIjogZGF0YXNldF90eXBlLAogICAgICAg
#4#ICJzdGFnZSI6IHN0YWdlLAogICAgICAgICJzdGFnZU51bWVyaWMiOiBzdGFnZV9udW0sCiAgICAg
#4#ICAgImVtYnJ5byI6IGVtYnJ5bywKICAgICAgICAiZGltZW5zaW9ucyI6IHsKICAgICAgICAgICAg
#4#IngiOiBXLAogICAgICAgICAgICAieSI6IEgsCiAgICAgICAgICAgICJ6IjogRCwKICAgICAgICAg
#4#ICAgImMiOiBuX2NoLAogICAgICAgICAgICAidCI6IG5fdHAKICAgICAgICB9LAogICAgICAgICJ2
#4#b3hlbF9zaXplIjogdm94ZWxfc2l6ZSwKICAgICAgICAicGh5c2ljYWxTaXplVW0iOiBwaHlzaWNh
#4#bF9zaXplLAogICAgICAgICJvcHRpY2FsX3NlY3Rpb25fdGhpY2tuZXNzX3VtIjogcm91bmQoc2xp
#4#Y2VfdGhpY2tuZXNzLCA2KSwKICAgICAgICAiYWNxdWlzaXRpb25FeHRlbnRVbSI6IHsKICAgICAg
#4#ICAgICAgInVuaXQiOiBleHRlbnQuZ2V0KCJ1bml0IiwgInVtIiksCiAgICAgICAgICAgICJtaW4i
#4#OiBbZmxvYXQodikgZm9yIHYgaW4gZXh0X21pbl0sCiAgICAgICAgICAgICJtYXgiOiBbZmxvYXQo
#4#dikgZm9yIHYgaW4gZXh0X21heF0KICAgICAgICB9LAogICAgICAgICJjYWxpYnJhdGlvblN0YXR1
#4#cyI6ICJleGFjdCIgaWYgKHZ4IGFuZCB2eSBhbmQgdnopIGVsc2UgIm1ldGFkYXRhLW1pc3Npbmci
#4#LAogICAgICAgICJjYWxpYnJhdGlvbk5vdGUiOiAiVm94ZWwgbWV0YWRhdGEgd2FzIHN1Y2Nlc3Nm
#4#dWxseSBleHRyYWN0ZWQuIiBpZiAodnggYW5kIHZ5IGFuZCB2eikgZWxzZSAiQ2FsaWJyYXRpb24g
#4#bWV0YWRhdGEgbWlzc2luZy4iLAogICAgICAgICJjaGFubmVscyI6IGNoYW5uZWxzX2luZm8sCiAg
#4#ICAgICAgImNyZWF0ZWQiOiBfX2ltcG9ydF9fKCJkYXRldGltZSIpLmRhdGV0aW1lLm5vdygpLmlz
#4#b2Zvcm1hdCgpLAogICAgICAgICJsYXN0TW9kaWZpZWQiOiBfX2ltcG9ydF9fKCJkYXRldGltZSIp
#4#LmRhdGV0aW1lLm5vdygpLmlzb2Zvcm1hdCgpLAogICAgICAgICJjb25maWd1cmVkIjogVHJ1ZSwK
#4#ICAgICAgICAiZm9sZGVyTmFtZSI6IGRhdGFzZXRfbmFtZSwKICAgICAgICAiZGVzY3JpcHRpb24i
#4#OiAoCiAgICAgICAgICAgIGYiVGltZWxhcHNlIGNvbmZvY2FsIGFjcXVpc2l0aW9uOiB7c3RhZ2V9
#4#IGVtYnJ5bywge25fdHB9IHRpbWVwb2ludHMiCiAgICAgICAgICAgIGYie2YnIGV2ZXJ5IHtpbnRl
#4#cnZhbDpnfSBtaW4nIGlmIGludGVydmFsIGVsc2UgJyd9LCB7RH0gc2xpY2VzLCB7bl9jaH0gY2hh
#4#bm5lbHMuIgogICAgICAgICAgICBpZiBuX3RwID4gMSBlbHNlCiAgICAgICAgICAgIGYiQ29uZm9j
#4#YWwgaW1hZ2luZyBzdGFjazoge3N0YWdlfSBmaXhlZCBlbWJyeW8sIHtEfSBzbGljZXMsIHtuX2No
#4#fSBjaGFubmVscy4iCiAgICAgICAgKSwKICAgICAgICAidGh1bWJuYWlsIjogZiJ7cmVsX3BhdGhf
#4#c3RyfS90aHVtYm5haWwud2VicCIgaWYgKG91dHB1dF9kaXIgLyAidGh1bWJuYWlsLndlYnAiKS5l
#4#eGlzdHMoKSBlbHNlIE5vbmUsCiAgICAgICAgInZvbHVtZVNvdXJjZXMiOiBbCiAgICAgICAgICAg
#4#IHsKICAgICAgICAgICAgICAgICJraW5kIjogImJyaWNrcyIsCiAgICAgICAgICAgICAgICAibGFi
#4#ZWwiOiAiQ2h1bmtlZCBicmlja3MgKDY0wrMpIiwKICAgICAgICAgICAgICAgICJwcmlvcml0eSI6
#4#IC0xLAogICAgICAgICAgICAgICAgImF2YWlsYWJsZSI6IFRydWUsCiAgICAgICAgICAgICAgICAi
#4#bXVsdGlzY2FsZSI6IFRydWUsCiAgICAgICAgICAgICAgICAicGF0aCI6IHJlbF9wYXRoX3N0ciwK
#4#ICAgICAgICAgICAgICAgICJtYW5pZmVzdFBhdGgiOiBmIntyZWxfcGF0aF9zdHJ9L2JyaWNrcy9t
#4#YW5pZmVzdC5qc29uIgogICAgICAgICAgICB9CiAgICAgICAgXQogICAgfQoKICAgIGlmIG5fdHAg
#4#PiAxOgogICAgICAgIG5vcm0gPSBwcm9jX21ldGEuZ2V0KCJub3JtYWxpemF0aW9uIikgb3Ige30K
#4#ICAgICAgICBtZXRhZGF0YVsidGltZWxpbmUiXSA9IHsKICAgICAgICAgICAgImNvdW50Ijogbl90
#4#cCwKICAgICAgICAgICAgImludGVydmFsTWludXRlcyI6IGludGVydmFsLAogICAgICAgICAgICAi
#4#dGltZXN0YW1wcyI6IHRpbWVzdGFtcHMKICAgICAgICB9CiAgICAgICAgIyBQaG90b2JsZWFjaGlu
#4#ZyBpcyByZXBvcnRlZCwgbmV2ZXIgYmFrZWQgaW46IHRoZSB2b3hlbHMgc3RheSBvbiBvbmUgbGlu
#4#ZWFyCiAgICAgICAgIyB3aW5kb3cgKHNlZSAyLWltYWdlX3Byb2Nlc3Nvci5weSkgc28gYSBmcmFt
#4#ZSB0aGF0IGxvb2tzIGRpbW1lciByZWFsbHkgaXMKICAgICAgICAjIGRpbW1lci4gVGhlc2UgcGVy
#4#LWZyYW1lIHNpZ25hbCBsZXZlbHMgbGV0IHRoZSB2aWV3ZXIgb2ZmZXIgYW4gT1BUSU9OQUwsCiAg
#4#ICAgICAgIyByZXZlcnNpYmxlIGRpc3BsYXkgZ2FpbiBpbnN0ZWFkIG9mIHNpbGVudGx5IHJld3Jp
#4#dGluZyB0aGUgZGF0YS4KICAgICAgICBtZXRhZGF0YVsiaW50ZW5zaXR5Tm9ybWFsaXphdGlvbiJd
#4#ID0gewogICAgICAgICAgICAibW9kZSI6IG5vcm0uZ2V0KCJtb2RlIiwgImdsb2JhbCIpLAogICAg
#4#ICAgICAgICAiYm91bmRzIjogbm9ybS5nZXQoImJvdW5kcyIsIHt9KSwKICAgICAgICAgICAgInNp
#4#Z25hbExldmVscyI6IG5vcm0uZ2V0KCJzaWduYWxMZXZlbHMiLCB7fSkKICAgICAgICB9CgoKICAg
#4#IHdpdGggb3BlbihvdXRwdXRfZGlyIC8gIm1ldGFkYXRhLmpzb24iLCAidyIsIGVuY29kaW5nPSJ1
#4#dGYtOCIpIGFzIGZtOgogICAgICAgIGpzb24uZHVtcChtZXRhZGF0YSwgZm0sIGluZGVudD0yLCBl
#4#bnN1cmVfYXNjaWk9RmFsc2UpCiAgICAgICAgCiAgICBwcmludChmIltDQVRBTE9HXSBXcm90ZSBt
#4#ZXRhZGF0YS5qc29uIHRvIHtvdXRwdXRfZGlyIC8gJ21ldGFkYXRhLmpzb24nfSIpCgppZiBfX25h
#4#bWVfXyA9PSAiX19tYWluX18iOgogICAgaWYgbGVuKHN5cy5hcmd2KSA8IDM6CiAgICAgICAgcHJp
#4#bnQoIlVzYWdlOiBweXRob24gNC1jYXRhbG9nX2dlbmVyYXRvci5weSA8dGVtcF9kaXI+IDxvdXRw
#4#dXRfZGlyPiIpCiAgICAgICAgc3lzLmV4aXQoMSkKICAgICAgICAKICAgIHRlbXBfZGlyID0gUGF0
#4#aChzeXMuYXJndlsxXSkKICAgIG91dHB1dF9kaXIgPSBQYXRoKHN5cy5hcmd2WzJdKQogICAgCiAg
#4#ICB0cnk6CiAgICAgICAgZ2VuZXJhdGVfY2F0YWxvZ19tZXRhZGF0YSh0ZW1wX2Rpciwgb3V0cHV0
#4#X2RpcikKICAgICAgICBwcmludChmIltDQVRBTE9HXSBDYXRhbG9nIG1ldGFkYXRhIGdlbmVyYXRp
#4#b24gY29tcGxldGUuIikKICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZToKICAgICAgICBpbXBvcnQg
#4#dHJhY2ViYWNrCiAgICAgICAgdHJhY2ViYWNrLnByaW50X2V4YygpCiAgICAgICAgcHJpbnQoZiJb
#4#RVJST1JdIENhdGFsb2cgbWV0YWRhdGEgZ2VuZXJhdGlvbiBmYWlsZWQ6IHtlfSIsIGZpbGU9c3lz
#4#LnN0ZGVycikKICAgICAgICBzeXMuZXhpdCgxKQo=
:: ---- [5] 2d_importer.py (19877 octets) ----
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
#5#UElMIGltcG9ydCBJbWFnZQoKX192ZXJzaW9uX18gPSAiMC4xOC4wIgoKIyBUaGUgZGlyZWN0b3J5
#5#IGEgZGF0YXNldCBzaXRzIGluIElTIGl0cyB0eXBlOiBEQVRBX1dFQi8yZC88Zm9sZGVyPiBpcyBk
#5#YXRhc2V0ICcyZC88Zm9sZGVyPicuCkRBVEFTRVRfVFlQRSA9ICIyZCIKUFJFVklFV19MT05HX1NJ
#5#REUgPSA2NDAKVEhVTUJfU0laRSA9IDUxMgpUSFVNQl9CQUNLR1JPVU5EID0gKDgsIDEwLCAxOCkK
#5#TkFUSVZFX1FVQUxJVFkgPSA5MApQUkVWSUVXX1FVQUxJVFkgPSA4MAoKSUpfTUVUQURBVEFfVEFH
#5#ID0gNTA4MzkKSUpfTUVUQURBVEFfQ09VTlRTX1RBRyA9IDUwODM4ClhfUkVTT0xVVElPTl9UQUcg
#5#PSAyODIKSU1BR0VfREVTQ1JJUFRJT05fVEFHID0gMjcwCgojIEtleXMgdGhlIGxhYiBlZGl0cyBi
#5#eSBoYW5kIGluIHRoZSBhZG1pbiBwYW5lbC4gQSByZS1pbXBvcnQgcmVmcmVzaGVzIHdoYXQgdGhl
#5#CiMgZmlsZSBtZWFzdXJlcyBhbmQgbGVhdmVzIHRoZXNlIGFsb25lLgpDVVJBVEVEX0tFWVMgPSAo
#5#Im5hbWUiLCAiZGVzY3JpcHRpb24iLCAic3RhZ2UiLCAic3RhZ2VOdW1lcmljIiwgImVtYnJ5byIs
#5#ICJsaW5lIiwKICAgICAgICAgICAgICAgICJzdGFpbmluZyIsICJyZXBvcnRlciIsICJoaWRkZW4i
#5#LCAiZ2FsbGVyeSIsICJ0YWdzIiwgIm5vdGVzIiwgImNyZWF0ZWQiKQoKCiMg4pSA4pSAIEltYWdl
#5#SiBtZXRhZGF0YSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIDilIAKZGVmIHJlYWRfaWpfbWV0YWRhdGEoaW0pIC0+IGRpY3Q6CiAg
#5#ICAiIiJEZWNvZGUgdGhlIEltYWdlSiBwcml2YXRlIHRhZyBpbnRvIHsnaW5mbyc6IFtzdHJdLCAn
#5#bGFibCc6IFtzdHJdLAogICAgJ2x1dHMnOiBbYnl0ZXNdLCAncmFuZyc6IFtieXRlc119LiBBYnNl
#5#bnQgb3IgbWFsZm9ybWVkIOKGkiB7fS4iIiIKICAgIGJsb2IgPSBpbS50YWdfdjIuZ2V0KElKX01F
#5#VEFEQVRBX1RBRykKICAgIGNvdW50cyA9IGltLnRhZ192Mi5nZXQoSUpfTUVUQURBVEFfQ09VTlRT
#5#X1RBRykKICAgIGlmIG5vdCBibG9iIG9yIG5vdCBjb3VudHMgb3IgYnl0ZXMoYmxvYls6NF0pICE9
#5#IGIiSUpJSiI6CiAgICAgICAgcmV0dXJuIHt9CiAgICBibG9iID0gYnl0ZXMoYmxvYikKICAgIGhl
#5#YWRlcl9sZW4gPSBjb3VudHNbMF0KICAgIGtpbmRzID0gWyhibG9iW3A6cCArIDRdLCBzdHJ1Y3Qu
#5#dW5wYWNrKCI+SSIsIGJsb2JbcCArIDQ6cCArIDhdKVswXSkKICAgICAgICAgICAgIGZvciBwIGlu
#5#IHJhbmdlKDQsIGhlYWRlcl9sZW4sIDgpXQogICAgb3V0LCBwb3MsIGlkeCA9IHt9LCBoZWFkZXJf
#5#bGVuLCAxCiAgICBmb3Iga2luZCwgbiBpbiBraW5kczoKICAgICAgICBpdGVtcyA9IFtdCiAgICAg
#5#ICAgZm9yIF8gaW4gcmFuZ2Uobik6CiAgICAgICAgICAgIGlmIGlkeCA+PSBsZW4oY291bnRzKToK
#5#ICAgICAgICAgICAgICAgIHJldHVybiBvdXQKICAgICAgICAgICAgY2h1bmsgPSBibG9iW3Bvczpw
#5#b3MgKyBjb3VudHNbaWR4XV0KICAgICAgICAgICAgcG9zICs9IGNvdW50c1tpZHhdCiAgICAgICAg
#5#ICAgIGlkeCArPSAxCiAgICAgICAgICAgIGl0ZW1zLmFwcGVuZChjaHVuay5kZWNvZGUoInV0Zi0x
#5#Ni1iZSIsICJyZXBsYWNlIikKICAgICAgICAgICAgICAgICAgICAgICAgIGlmIGtpbmQgaW4gKGIi
#5#aW5mbyIsIGIibGFibCIpIGVsc2UgY2h1bmspCiAgICAgICAgb3V0W2tpbmQuZGVjb2RlKCJhc2Np
#5#aSIsICJyZXBsYWNlIildID0gaXRlbXMKICAgIHJldHVybiBvdXQKCgpkZWYgcmVhZF9wbGFuZXMo
#5#aW0pIC0+IGxpc3Q6CiAgICBwbGFuZXMgPSBbXQogICAgZm9yIGkgaW4gcmFuZ2UoZ2V0YXR0cihp
#5#bSwgIm5fZnJhbWVzIiwgMSkpOgogICAgICAgIGltLnNlZWsoaSkKICAgICAgICBwbGFuZXMuYXBw
#5#ZW5kKG5wLmFycmF5KGltKSkKICAgIGltLnNlZWsoMCkKICAgIHJldHVybiBwbGFuZXMKCgpkZWYg
#5#Y29tcG9zZV9yZ2IocGxhbmVzOiBsaXN0LCBsdXRzOiBsaXN0KSAtPiBucC5uZGFycmF5OgogICAg
#5#IiIiQWRkaXRpdmUgY29tcG9zaXRlLCBleGFjdGx5IHdoYXQgSW1hZ2VKJ3MgY29tcG9zaXRlIG1v
#5#ZGUgZGlzcGxheXM6CiAgICBvdXQgPSDOoyBsdXRfY1twbGFuZV9jXS4gUGxhaW4gUkdCIGFuZCBn
#5#cmV5c2NhbGUgZmlsZXMgcGFzcyBzdHJhaWdodCB0aHJvdWdoLiIiIgogICAgZmlyc3QgPSBwbGFu
#5#ZXNbMF0KICAgIGlmIGZpcnN0Lm5kaW0gPT0gMzoKICAgICAgICByZXR1cm4gbnAuYXNjb250aWd1
#5#b3VzYXJyYXkoZmlyc3RbOiwgOiwgOjNdKQogICAgYWNjID0gbnAuemVyb3MoZmlyc3Quc2hhcGUg
#5#KyAoMywpLCBkdHlwZT1ucC5mbG9hdDMyKQogICAgZm9yIGMsIHBsYW5lIGluIGVudW1lcmF0ZShw
#5#bGFuZXMpOgogICAgICAgIGx1dCA9IF9sdXRfdGFibGUobHV0cywgYywgbGVuKHBsYW5lcykpCiAg
#5#ICAgICAgYWNjICs9IGx1dFtfdG9fdWludDgocGxhbmUpXQogICAgcmV0dXJuIG5wLmNsaXAoYWNj
#5#LCAwLCAyNTUpLmFzdHlwZShucC51aW50OCkKCgpkZWYgX2x1dF90YWJsZShsdXRzOiBsaXN0LCBp
#5#bmRleDogaW50LCBuX3BsYW5lczogaW50KSAtPiBucC5uZGFycmF5OgogICAgIiIiMjU2w5czIGNv
#5#bG91ciB0YWJsZSBmb3IgcGxhbmUgYGluZGV4YC4gSW1hZ2VKIHN0b3JlcyBSLEcsQiByYW1wcyBv
#5#ZiAyNTYKICAgIGJ5dGVzIGVhY2g7IHdpdGhvdXQgTFVUcywgdGhyZWUgcGxhbmVzIGFyZSB0YWtl
#5#biBhcyBSL0cvQiwgb25lIGFzIGdyZXkuIiIiCiAgICBpZiBpbmRleCA8IGxlbihsdXRzKSBhbmQg
#5#bGVuKGx1dHNbaW5kZXhdKSA9PSA3Njg6CiAgICAgICAgcmF3ID0gbnAuZnJvbWJ1ZmZlcihsdXRz
#5#W2luZGV4XSwgZHR5cGU9bnAudWludDgpCiAgICAgICAgcmV0dXJuIHJhdy5yZXNoYXBlKDMsIDI1
#5#NikuVC5hc3R5cGUobnAuZmxvYXQzMikKICAgIHJhbXAgPSBucC5hcmFuZ2UoMjU2LCBkdHlwZT1u
#5#cC5mbG9hdDMyKQogICAgdGFibGUgPSBucC56ZXJvcygoMjU2LCAzKSwgZHR5cGU9bnAuZmxvYXQz
#5#MikKICAgIGlmIG5fcGxhbmVzID09IDM6CiAgICAgICAgdGFibGVbOiwgaW5kZXhdID0gcmFtcAog
#5#ICAgZWxzZToKICAgICAgICB0YWJsZVs6XSA9IHJhbXBbOiwgTm9uZV0KICAgIHJldHVybiB0YWJs
#5#ZQoKCmRlZiBfdG9fdWludDgocGxhbmU6IG5wLm5kYXJyYXkpIC0+IG5wLm5kYXJyYXk6CiAgICBp
#5#ZiBwbGFuZS5kdHlwZSA9PSBucC51aW50ODoKICAgICAgICByZXR1cm4gcGxhbmUKICAgIGhpID0g
#5#ZmxvYXQocGxhbmUubWF4KCkpIG9yIDEuMAogICAgcmV0dXJuIChwbGFuZS5hc3R5cGUobnAuZmxv
#5#YXQzMikgKiAoMjU1LjAgLyBoaSkpLmFzdHlwZShucC51aW50OCkKCgojIOKUgOKUgCBDYWxpYnJh
#5#dGlvbiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIDilIDilIDilIAKZGVmIHBpeGVsX3NpemVfdW0oaW0sIGRlc2NyaXB0
#5#aW9uOiBzdHIpIC0+IHR1cGxlOgogICAgIiIiKMK1bSBwZXIgcGl4ZWwsIHN0YXR1cykuIEltYWdl
#5#SiB3cml0ZXMgWFJlc29sdXRpb24gaW4gcGl4ZWxzIHBlciBgdW5pdGA7CiAgICB3ZSBvbmx5IHRy
#5#dXN0IGl0IHdoZW4gdGhlIHVuaXQgaXMgZGVjbGFyZWQgaW4gbWljcm9ucy4iIiIKICAgIHhyZXMg
#5#PSBpbS50YWdfdjIuZ2V0KFhfUkVTT0xVVElPTl9UQUcpCiAgICB1bml0ID0gcmUuc2VhcmNoKHIi
#5#XnVuaXQ9KFxTKykiLCBkZXNjcmlwdGlvbiwgcmUuTVVMVElMSU5FKQogICAgdW5pdCA9IHVuaXQu
#5#Z3JvdXAoMSkubG93ZXIoKSBpZiB1bml0IGVsc2UgIiIKICAgIGlmIHhyZXMgYW5kIGZsb2F0KHhy
#5#ZXMpID4gMCBhbmQgdW5pdCBpbiAoIm1pY3JvbiIsICJtaWNyb25zIiwgInVtIiwgIsK1bSIsICJc
#5#XHUwMGI1bSIpOgogICAgICAgIHJldHVybiAxLjAgLyBmbG9hdCh4cmVzKSwgImV4YWN0IgogICAg
#5#cmV0dXJuIE5vbmUsICJ1bmtub3duIgoKCiMg4pSA4pSAIExlaWNhIGJsb2NrIOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgApMRUlDQV9GSUVMRFMgPSB7CiAgICAiWm9vbSI6ICgiem9vbSIsIGZsb2F0KSwK
#5#ICAgICJNYWduaWZpY2F0aW9uIjogKCJtYWduaWZpY2F0aW9uIiwgZmxvYXQpLAogICAgIk9iamVj
#5#dGl2ZU5hbWUiOiAoIm9iamVjdGl2ZSIsIHN0ciksCiAgICAiTnVtZXJpY2FsQXBlcnR1cmUiOiAo
#5#Im51bWVyaWNhbEFwZXJ0dXJlIiwgZmxvYXQpLAogICAgIkV4cG9zdXJlVGltZSI6ICgiZXhwb3N1
#5#cmVTIiwgZmxvYXQpLAogICAgIkluZGl2aWR1YWxDYW1lcmFJbmZvfEdhaW4iOiAoImdhaW4iLCBm
#5#bG9hdCksCiAgICAiTWljcm9zY29wZU1vZGVsIjogKCJtaWNyb3Njb3BlIiwgc3RyKSwKICAgICJG
#5#dWxsQ2FtZXJhTmFtZSI6ICgiY2FtZXJhIiwgc3RyKSwKfQoKCmRlZiBsZWljYV9maWVsZHMoaW5m
#5#bzogc3RyLCBzZXJpZXM6IHN0cikgLT4gZGljdDoKICAgICIiIkFjcXVpc2l0aW9uIHNldHRpbmdz
#5#IG9mIG9uZSBzZXJpZXMuIFRoZSBMZWljYSBibG9jayByZXBlYXRzIGEga2V5IG9uY2UgcGVyCiAg
#5#ICBqb2IgYmxvY2sgKGBMRE1fQmxvY2tf4oCmYCkgYW5kIG9uY2UgYXQgdGhlIHRvcCBsZXZlbCBm
#5#b3IgdGhlIGV4cG9zdXJlIHRoYXQgd2FzCiAgICBhY3R1YWxseSB0YWtlbjsgdGhlIHRvcC1sZXZl
#5#bCBsaW5lIHdpbnMsIGZpcnN0IGJsb2NrIGxpbmUgYXMgZmFsbGJhY2suIiIiCiAgICAjIEV2ZXJ5
#5#IGxpbmUgb2YgYSBzZXJpZXMgc3RhcnRzIHdpdGggYDxzZXJpZXM+IEltYWdl4oCmYDsgdGhlIHRy
#5#YWlsaW5nICJJbWFnZSIKICAgICMga2VlcHMgYEU4LjAgeDMuMiAyNDA5MTNgIGZyb20gYWxzbyBt
#5#YXRjaGluZyBgRTguMCB4My4yIDI0MDkxMyAyYC4KICAgIHByZWZpeCA9IHNlcmllcyArICIgSW1h
#5#Z2UiCiAgICBsaW5lcyA9IFtsW2xlbihzZXJpZXMpICsgMTpdIGZvciBsIGluIGluZm8uc3BsaXRs
#5#aW5lcygpIGlmIGwuc3RhcnRzd2l0aChwcmVmaXgpXQogICAgb3V0ID0ge30KICAgIGZvciBzdWZm
#5#aXgsIChuYW1lLCBjYXN0KSBpbiBMRUlDQV9GSUVMRFMuaXRlbXMoKToKICAgICAgICB2YWx1ZSA9
#5#IF9waWNrX3ZhbHVlKGxpbmVzLCBzdWZmaXgpCiAgICAgICAgaWYgdmFsdWUgaXMgbm90IE5vbmU6
#5#CiAgICAgICAgICAgIG91dFtuYW1lXSA9IHZhbHVlIGlmIGNhc3QgaXMgc3RyIGVsc2UgX3NhZmVf
#5#ZmxvYXQodmFsdWUpCiAgICBpZiAiZXhwb3N1cmVTIiBpbiBvdXQ6CiAgICAgICAgb3V0WyJleHBv
#5#c3VyZU1zIl0gPSByb3VuZChvdXQucG9wKCJleHBvc3VyZVMiKSAqIDEwMDAuMCwgMykKICAgIGlm
#5#IG91dC5nZXQoImNhbWVyYSIpOgogICAgICAgIG91dFsiY2FtZXJhIl0gPSBvdXRbImNhbWVyYSJd
#5#LnNwbGl0KCItIilbMF0KICAgIHJldHVybiB7azogdiBmb3IgaywgdiBpbiBvdXQuaXRlbXMoKSBp
#5#ZiB2IG5vdCBpbiAoTm9uZSwgIiIsIDAuMCl9CgoKZGVmIF9waWNrX3ZhbHVlKGxpbmVzOiBsaXN0
#5#LCBzdWZmaXg6IHN0cik6CiAgICAiIiJMQVMgWCB3cml0ZXMgIjAiIGZvciBhIHNldHRpbmcgdGhh
#5#dCBkb2VzIG5vdCBhcHBseSB0byBhIGJsb2NrOyB0aG9zZQogICAgcGxhY2Vob2xkZXJzIG5ldmVy
#5#IGJlYXQgYSByZWFsIHZhbHVlLiIiIgogICAgaGl0cyA9IFsoaywgdi5zdHJpcCgpKSBmb3Igaywg
#5#XywgdiBpbiAobC5wYXJ0aXRpb24oIiA9ICIpIGZvciBsIGluIGxpbmVzKQogICAgICAgICAgICBp
#5#ZiBrLnJzdHJpcCgpLmVuZHN3aXRoKHN1ZmZpeCkgYW5kIHYuc3RyaXAoKSBub3QgaW4gKCIiLCAi
#5#MCIpXQogICAgaWYgbm90IGhpdHM6CiAgICAgICAgcmV0dXJuIE5vbmUKICAgIHRvcCA9IFt2IGZv
#5#ciBrLCB2IGluIGhpdHMgaWYgIkxETV9CbG9jayIgbm90IGluIGtdCiAgICByZXR1cm4gKHRvcCBv
#5#ciBbdiBmb3IgXywgdiBpbiBoaXRzXSlbMF0KCgpkZWYgX3NhZmVfZmxvYXQodGV4dDogc3RyKToK
#5#ICAgIHRyeToKICAgICAgICByZXR1cm4gZmxvYXQodGV4dCkKICAgIGV4Y2VwdCAoVHlwZUVycm9y
#5#LCBWYWx1ZUVycm9yKToKICAgICAgICByZXR1cm4gTm9uZQoKCiMg4pSA4pSAIEZpbGUtbmFtZSBj
#5#b252ZW50aW9ucyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIAKU1RBR0VfUlggPSByZS5jb21waWxlKHIiXGJFKFxkKD86Wy4sXVxkezEsMn0pPylcYiIpClpP
#5#T01fUlggPSByZS5jb21waWxlKHIiXGJ4KFxkKyg/OlsuLF1cZCspPylcYiIsIHJlLklHTk9SRUNB
#5#U0UpCkRBVEVfUlggPSByZS5jb21waWxlKHIiXGIoXGR7Nn0pXGIiKQpMSU5FX1JYID0gcmUuY29t
#5#cGlsZShyIlxiKFtBLVphLXowLTldK3hbQS1aYS16XVtBLVphLXowLTldKilcYiIpCgoKZGVmIHBh
#5#cnNlX2ZpbGVuYW1lKHN0ZW06IHN0ciwgbGluZV9vdmVycmlkZTogc3RyID0gTm9uZSkgLT4gZGlj
#5#dDoKICAgICIiImA8bGlmPiAtIDxzdGFnZT4geDx6b29tPiA8ZGlzc2VjdGlvbiB5eW1tZGQ+IFs8
#5#bj4gWzxtPl1dYCBhcyB0aGUgbGFiIG5hbWVzCiAgICBpdHMgZXhwb3J0cy4gTWlzc2luZyBwYXJ0
#5#cyBzdGF5IE5vbmU7IG5vdGhpbmcgaXMgaW52ZW50ZWQuIiIiCiAgICBsaWYsIHNlcCwgc2VyaWVz
#5#ID0gc3RlbS5wYXJ0aXRpb24oIi5saWYgLSAiKQogICAgaWYgbm90IHNlcDoKICAgICAgICBsaWYs
#5#IHNlcmllcyA9ICIiLCBzdGVtCiAgICBzdGFnZV9tID0gU1RBR0VfUlguc2VhcmNoKHNlcmllcykg
#5#b3IgU1RBR0VfUlguc2VhcmNoKGxpZikKICAgIHpvb21fbSA9IFpPT01fUlguc2VhcmNoKHNlcmll
#5#cykKICAgIGRhdGVzID0gW2QgZm9yIGQgaW4gREFURV9SWC5maW5kYWxsKHNlcmllcykgaWYgX3Zh
#5#bGlkX3l5bW1kZChkKV0KICAgIHRhaWwgPSBzZXJpZXNbem9vbV9tLmVuZCgpOl0gaWYgem9vbV9t
#5#IGVsc2UgIiIKICAgIGluZGV4ID0gIiAiLmpvaW4odCBmb3IgdCBpbiB0YWlsLnNwbGl0KCkgaWYg
#5#dC5pc2RpZ2l0KCkgYW5kIHQgbm90IGluIGRhdGVzKQogICAgbGluZV9tID0gTElORV9SWC5zZWFy
#5#Y2gobGlmKSBvciBMSU5FX1JYLnNlYXJjaChzZXJpZXMpCiAgICBzdGFnZSA9IHN0YWdlX20uZ3Jv
#5#dXAoMSkucmVwbGFjZSgiLCIsICIuIikgaWYgc3RhZ2VfbSBlbHNlIE5vbmUKICAgIHJldHVybiB7
#5#CiAgICAgICAgImxpZiI6IChsaWYgKyAiLmxpZiIpIGlmIGxpZiBlbHNlIE5vbmUsCiAgICAgICAg
#5#InNlcmllcyI6IHNlcmllcy5zdHJpcCgpLAogICAgICAgICJzdGFnZSI6IGYiRXtzdGFnZX0iIGlm
#5#IHN0YWdlIGVsc2UgTm9uZSwKICAgICAgICAic3RhZ2VOdW1lcmljIjogZmxvYXQoc3RhZ2UpIGlm
#5#IHN0YWdlIGVsc2UgTm9uZSwKICAgICAgICAiem9vbSI6IGZsb2F0KHpvb21fbS5ncm91cCgxKS5y
#5#ZXBsYWNlKCIsIiwgIi4iKSkgaWYgem9vbV9tIGVsc2UgTm9uZSwKICAgICAgICAiZGlzc2VjdGlv
#5#bkRhdGUiOiBfaXNvX2RhdGUoZGF0ZXNbMF0pIGlmIGRhdGVzIGVsc2UgTm9uZSwKICAgICAgICAi
#5#aW5kZXgiOiBpbmRleCBvciBOb25lLAogICAgICAgICJsaW5lIjogbGluZV9vdmVycmlkZSBvciAo
#5#bGluZV9tLmdyb3VwKDEpIGlmIGxpbmVfbSBlbHNlIE5vbmUpLAogICAgfQoKCmRlZiBfdmFsaWRf
#5#eXltbWRkKHRleHQ6IHN0cikgLT4gYm9vbDoKICAgIHRyeToKICAgICAgICBkYXRldGltZS5zdHJw
#5#dGltZSh0ZXh0LCAiJXklbSVkIikKICAgICAgICByZXR1cm4gVHJ1ZQogICAgZXhjZXB0IFZhbHVl
#5#RXJyb3I6CiAgICAgICAgcmV0dXJuIEZhbHNlCgoKZGVmIF9pc29fZGF0ZSh5eW1tZGQ6IHN0cikg
#5#LT4gc3RyOgogICAgcmV0dXJuIGRhdGV0aW1lLnN0cnB0aW1lKHl5bW1kZCwgIiV5JW0lZCIpLnN0
#5#cmZ0aW1lKCIlWS0lbS0lZCIpCgoKZGVmIGRhdGFzZXRfZm9sZGVyX25hbWUocGFyc2VkOiBkaWN0
#5#KSAtPiBzdHI6CiAgICAiIiJgPGxpbmU+LTxzdGFnZT4teDx6b29tPi08eXltbWRkPi08aW5kZXg+
#5#YCwgc3RhZ2Ugd2l0aG91dCBpdHMgZG90CiAgICAoRTcuNzUg4oaSIEU3NzUpIGFzIHRoZSBwbGF0
#5#Zm9ybSdzIG90aGVyIGRhdGFzZXRzIHNwZWxsIGl0LiIiIgogICAgcGFydHMgPSBbcGFyc2VkLmdl
#5#dCgibGluZSIpLAogICAgICAgICAgICAgcGFyc2VkWyJzdGFnZSJdLnJlcGxhY2UoIi4iLCAiIikg
#5#aWYgcGFyc2VkLmdldCgic3RhZ2UiKSBlbHNlIE5vbmUsCiAgICAgICAgICAgICBmInh7cGFyc2Vk
#5#Wyd6b29tJ106Z30iIGlmIHBhcnNlZC5nZXQoInpvb20iKSBlbHNlIE5vbmUsCiAgICAgICAgICAg
#5#ICBwYXJzZWRbImRpc3NlY3Rpb25EYXRlIl0ucmVwbGFjZSgiLSIsICIiKVsyOl0gaWYgcGFyc2Vk
#5#LmdldCgiZGlzc2VjdGlvbkRhdGUiKSBlbHNlIE5vbmUsCiAgICAgICAgICAgICBwYXJzZWQuZ2V0
#5#KCJpbmRleCIpXQogICAgaWYgbm90IChwYXJzZWQuZ2V0KCJ6b29tIikgb3IgcGFyc2VkLmdldCgi
#5#ZGlzc2VjdGlvbkRhdGUiKSk6CiAgICAgICAgcGFydHMuYXBwZW5kKHBhcnNlZC5nZXQoInNlcmll
#5#cyIpKQogICAgcmV0dXJuIHNsdWdpZnkoIi0iLmpvaW4ocCBmb3IgcCBpbiBwYXJ0cyBpZiBwKSkg
#5#b3IgInBob3RvZ3JhcGgiCgoKZGVmIHNsdWdpZnkodGV4dDogc3RyKSAtPiBzdHI6CiAgICByZXR1
#5#cm4gcmUuc3ViKHIiLXsyLH0iLCAiLSIsIHJlLnN1YihyIlteQS1aYS16MC05Ll8tXSsiLCAiLSIs
#5#IHRleHQpKS5zdHJpcCgiLS4iKQoKCiMg4pSA4pSAIE91dHB1dHMg4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSACmRlZiB3cml0ZV9pbWFnZXMocmdiOiBucC5uZGFycmF5LCBvdXRfZGly
#5#OiBQYXRoKSAtPiBkaWN0OgogICAgbmF0aXZlID0gSW1hZ2UuZnJvbWFycmF5KHJnYiwgbW9kZT0i
#5#UkdCIikKICAgIG5hdGl2ZS5zYXZlKG91dF9kaXIgLyAiaW1hZ2Uud2VicCIsICJXRUJQIiwgcXVh
#5#bGl0eT1OQVRJVkVfUVVBTElUWSwgbWV0aG9kPTYpCgogICAgcHJldmlldyA9IG5hdGl2ZS5jb3B5
#5#KCkKICAgIHByZXZpZXcudGh1bWJuYWlsKChQUkVWSUVXX0xPTkdfU0lERSwgUFJFVklFV19MT05H
#5#X1NJREUpLCBJbWFnZS5SZXNhbXBsaW5nLkxBTkNaT1MpCiAgICBwcmV2aWV3LnNhdmUob3V0X2Rp
#5#ciAvICJwcmV2aWV3LndlYnAiLCAiV0VCUCIsIHF1YWxpdHk9UFJFVklFV19RVUFMSVRZLCBtZXRo
#5#b2Q9NikKCiAgICBfd3JpdGVfc3F1YXJlX3RodW1ibmFpbChuYXRpdmUsIG91dF9kaXIgLyAidGh1
#5#bWJuYWlsLndlYnAiKQogICAgcmV0dXJuIHsibmF0aXZlIjogImltYWdlLndlYnAiLCAid2lkdGgi
#5#OiBuYXRpdmUud2lkdGgsICJoZWlnaHQiOiBuYXRpdmUuaGVpZ2h0LAogICAgICAgICAgICAicHJl
#5#dmlldyI6ICJwcmV2aWV3LndlYnAiLCAicHJldmlld1dpZHRoIjogcHJldmlldy53aWR0aCwKICAg
#5#ICAgICAgICAgInByZXZpZXdIZWlnaHQiOiBwcmV2aWV3LmhlaWdodH0KCgpkZWYgX3dyaXRlX3Nx
#5#dWFyZV90aHVtYm5haWwoaW1nOiBJbWFnZS5JbWFnZSwgcGF0aDogUGF0aCkgLT4gTm9uZToKICAg
#5#IHNjYWxlZCA9IGltZy5jb3B5KCkKICAgIHNjYWxlZC50aHVtYm5haWwoKFRIVU1CX1NJWkUsIFRI
#5#VU1CX1NJWkUpLCBJbWFnZS5SZXNhbXBsaW5nLkxBTkNaT1MpCiAgICBjYW52YXMgPSBJbWFnZS5u
#5#ZXcoIlJHQiIsIChUSFVNQl9TSVpFLCBUSFVNQl9TSVpFKSwgVEhVTUJfQkFDS0dST1VORCkKICAg
#5#IGNhbnZhcy5wYXN0ZShzY2FsZWQsICgoVEhVTUJfU0laRSAtIHNjYWxlZC53aWR0aCkgLy8gMiwg
#5#KFRIVU1CX1NJWkUgLSBzY2FsZWQuaGVpZ2h0KSAvLyAyKSkKICAgIGNhbnZhcy5zYXZlKHBhdGgs
#5#ICJXRUJQIiwgcXVhbGl0eT04OCwgbWV0aG9kPTYpCgoKZGVmIGJ1aWxkX21ldGFkYXRhKGZvbGRl
#5#cjogc3RyLCBwYXJzZWQ6IGRpY3QsIGltYWdlOiBkaWN0LCBweF91bSwgY2FsX3N0YXR1czogc3Ry
#5#LAogICAgICAgICAgICAgICAgICAgYWNxdWlzaXRpb246IGRpY3QsIHNvdXJjZTogUGF0aCwgc3Rh
#5#aW5pbmc6IHN0cikgLT4gZGljdDoKICAgIG5vdyA9IGRhdGV0aW1lLm5vdygpLmlzb2Zvcm1hdCgp
#5#CiAgICB3LCBoID0gaW1hZ2VbIndpZHRoIl0sIGltYWdlWyJoZWlnaHQiXQogICAgcGh5c2ljYWwg
#5#PSAoeyJ4Ijogcm91bmQodyAqIHB4X3VtLCAzKSwgInkiOiByb3VuZChoICogcHhfdW0sIDMpfSBp
#5#ZiBweF91bSBlbHNlIE5vbmUpCiAgICBzdGFnZV90eHQgPSBwYXJzZWRbInN0YWdlIl0gb3IgIlVu
#5#a25vd24iCiAgICByZXR1cm4gewogICAgICAgICJpZCI6IGYie0RBVEFTRVRfVFlQRX0ve2ZvbGRl
#5#cn0iLCAibmFtZSI6IGZvbGRlciwgInR5cGUiOiBEQVRBU0VUX1RZUEUsCiAgICAgICAgInN0YWdl
#5#Ijogc3RhZ2VfdHh0LCAic3RhZ2VOdW1lcmljIjogcGFyc2VkWyJzdGFnZU51bWVyaWMiXSBvciAw
#5#LjAsCiAgICAgICAgImVtYnJ5byI6IE5vbmUsICJsaW5lIjogcGFyc2VkLmdldCgibGluZSIpLCAi
#5#c3RhaW5pbmciOiBzdGFpbmluZyBvciAiIiwKICAgICAgICAiZGF0ZSI6IHBhcnNlZC5nZXQoImRp
#5#c3NlY3Rpb25EYXRlIiksCiAgICAgICAgImRpbWVuc2lvbnMiOiB7IngiOiB3LCAieSI6IGgsICJ6
#5#IjogMSwgImMiOiAzLCAidCI6IDF9LAogICAgICAgICJwaXhlbFNpemVVbSI6ICh7IngiOiByb3Vu
#5#ZChweF91bSwgNiksICJ5Ijogcm91bmQocHhfdW0sIDYpfSBpZiBweF91bSBlbHNlIE5vbmUpLAog
#5#ICAgICAgICJwaHlzaWNhbFNpemVVbSI6IHBoeXNpY2FsLAogICAgICAgICJjYWxpYnJhdGlvblN0
#5#YXR1cyI6IGNhbF9zdGF0dXMsCiAgICAgICAgImNhbGlicmF0aW9uTm90ZSI6ICgiUGl4ZWwgc2l6
#5#ZSByZWFkIGZyb20gdGhlIEltYWdlSiByZXNvbHV0aW9uIHRhZ3MgKG1pY3JvbnMpLiIKICAgICAg
#5#ICAgICAgICAgICAgICAgICAgICAgIGlmIGNhbF9zdGF0dXMgPT0gImV4YWN0IiBlbHNlCiAgICAg
#5#ICAgICAgICAgICAgICAgICAgICAgICAiTm8gY2FsaWJyYXRlZCByZXNvbHV0aW9uIGluIHRoZSBm
#5#aWxlIOKAlCBzY2FsZSBiYXIgYW5kIG1lYXN1cmVtZW50cyB1bmF2YWlsYWJsZS4iKSwKICAgICAg
#5#ICAiaW1hZ2UiOiBpbWFnZSwKICAgICAgICAiYWNxdWlzaXRpb24iOiB7Im1vZGFsaXR5IjogImJy
#5#aWdodGZpZWxkLXN0ZXJlbyIsICJzb3VyY2VGaWxlIjogc291cmNlLm5hbWUsCiAgICAgICAgICAg
#5#ICAgICAgICAgICAgICJsaWZGaWxlIjogcGFyc2VkLmdldCgibGlmIiksICJzZXJpZXMiOiBwYXJz
#5#ZWQuZ2V0KCJzZXJpZXMiKSwKICAgICAgICAgICAgICAgICAgICAgICAgImRpc3NlY3Rpb25EYXRl
#5#IjogcGFyc2VkLmdldCgiZGlzc2VjdGlvbkRhdGUiKSwKICAgICAgICAgICAgICAgICAgICAgICAg
#5#Inpvb21Ob21pbmFsIjogcGFyc2VkLmdldCgiem9vbSIpLCAqKmFjcXVpc2l0aW9ufSwKICAgICAg
#5#ICAiY2hhbm5lbHMiOiBbXSwKICAgICAgICAiZGVzY3JpcHRpb24iOiBfZGVzY3JpcHRpb24oc3Rh
#5#Z2VfdHh0LCBwYXJzZWQsIGFjcXVpc2l0aW9uKSwKICAgICAgICAiY3JlYXRlZCI6IG5vdywgImxh
#5#c3RNb2RpZmllZCI6IG5vdywgImNvbmZpZ3VyZWQiOiBUcnVlLAogICAgICAgICJmb2xkZXJOYW1l
#5#IjogZm9sZGVyLAogICAgICAgICJ0aHVtYm5haWwiOiBmIkRBVEFfV0VCL3tEQVRBU0VUX1RZUEV9
#5#L3tmb2xkZXJ9L3RodW1ibmFpbC53ZWJwIiwKICAgICAgICAiaGlkZGVuIjogRmFsc2UsCiAgICB9
#5#CgoKZGVmIF9kZXNjcmlwdGlvbihzdGFnZTogc3RyLCBwYXJzZWQ6IGRpY3QsIGFjcTogZGljdCkg
#5#LT4gc3RyOgogICAgYml0cyA9IFtmIkNvbG91ciBwaG90b2dyYXBoLCB7c3RhZ2V9IGVtYnJ5byJd
#5#CiAgICBpZiBwYXJzZWQuZ2V0KCJsaW5lIik6CiAgICAgICAgYml0cy5hcHBlbmQocGFyc2VkWyJs
#5#aW5lIl0pCiAgICBpZiBhY3EuZ2V0KCJtaWNyb3Njb3BlIik6CiAgICAgICAgYml0cy5hcHBlbmQo
#5#ZiJ7YWNxWydtaWNyb3Njb3BlJ119IHN0ZXJlb21pY3Jvc2NvcGUiKQogICAgaWYgcGFyc2VkLmdl
#5#dCgiem9vbSIpOgogICAgICAgIGJpdHMuYXBwZW5kKGYiem9vbSB4e3BhcnNlZFsnem9vbSddOmd9
#5#IikKICAgIHJldHVybiAiLCAiLmpvaW4oYml0cykgKyAiLiIKCgpkZWYgbWVyZ2VfY3VyYXRlZChl
#5#eGlzdGluZzogZGljdCwgZnJlc2g6IGRpY3QpIC0+IGRpY3Q6CiAgICAiIiJSZS1pbXBvcnQgcmVm
#5#cmVzaGVzIG1lYXN1cmVtZW50cywga2VlcHMgd2hhdCB0aGUgbGFiIGVkaXRlZC4iIiIKICAgIG1l
#5#cmdlZCA9IGRpY3QoZnJlc2gpCiAgICBmb3Iga2V5IGluIENVUkFURURfS0VZUzoKICAgICAgICBp
#5#ZiBrZXkgaW4gZXhpc3Rpbmc6CiAgICAgICAgICAgIG1lcmdlZFtrZXldID0gZXhpc3Rpbmdba2V5
#5#XQogICAgbWVyZ2VkWyJsYXN0TW9kaWZpZWQiXSA9IGZyZXNoWyJsYXN0TW9kaWZpZWQiXQogICAg
#5#cmV0dXJuIG1lcmdlZAoKCmRlZiB3cml0ZV9kb3dubG9hZChzb3VyY2U6IFBhdGgsIG91dF9kaXI6
#5#IFBhdGgsIG1ldGE6IGRpY3QpIC0+IE5vbmU6CiAgICBkbCA9IG91dF9kaXIgLyAiZG93bmxvYWQi
#5#CiAgICBkbC5ta2RpcihleGlzdF9vaz1UcnVlKQogICAgdGFyZ2V0ID0gZGwgLyBzb3VyY2UubmFt
#5#ZQogICAgaWYgdGFyZ2V0LmV4aXN0cygpOgogICAgICAgIHRhcmdldC51bmxpbmsoKQogICAgdHJ5
#5#OgogICAgICAgIG9zLmxpbmsoc291cmNlLCB0YXJnZXQpCiAgICBleGNlcHQgT1NFcnJvcjoKICAg
#5#ICAgICBzaHV0aWwuY29weTIoc291cmNlLCB0YXJnZXQpCiAgICAoZGwgLyAiUkVBRE1FLnR4dCIp
#5#LndyaXRlX3RleHQoX3JlYWRtZShzb3VyY2UsIG1ldGEpLCBlbmNvZGluZz0idXRmLTgiKQoKCmRl
#5#ZiBfcmVhZG1lKHNvdXJjZTogUGF0aCwgbWV0YTogZGljdCkgLT4gc3RyOgogICAgYWNxID0gbWV0
#5#YVsiYWNxdWlzaXRpb24iXQogICAgcHggPSBtZXRhLmdldCgicGl4ZWxTaXplVW0iKQogICAgbGlu
#5#ZXMgPSBbCiAgICAgICAgZiJ7bWV0YVsnbmFtZSddfSIsCiAgICAgICAgIj0iICogbGVuKG1ldGFb
#5#Im5hbWUiXSksCiAgICAgICAgIiIsCiAgICAgICAgZiJUeXBlICAgICAgICA6IDJEIHBob3RvZ3Jh
#5#cGggKHthY3EuZ2V0KCdtb2RhbGl0eScpfSkiLAogICAgICAgIGYiU3RhZ2UgICAgICAgOiB7bWV0
#5#YVsnc3RhZ2UnXX0iLAogICAgICAgIGYiTGluZSAgICAgICAgOiB7bWV0YS5nZXQoJ2xpbmUnKSBv
#5#ciAnLSd9IiwKICAgICAgICBmIlN0YWluaW5nICAgIDoge21ldGEuZ2V0KCdzdGFpbmluZycpIG9y
#5#ICctJ30iLAogICAgICAgIGYiSW1hZ2UgICAgICAgOiB7bWV0YVsnZGltZW5zaW9ucyddWyd4J119
#5#IHgge21ldGFbJ2RpbWVuc2lvbnMnXVsneSddfSBweCwgUkdCIDgtYml0IiwKICAgICAgICBmIlBp
#5#eGVsIHNpemUgIDoge3B4Wyd4J106LjRmfSB1bS9weCIgaWYgcHggZWxzZSAiUGl4ZWwgc2l6ZSAg
#5#OiB1bmtub3duIiwKICAgICAgICBmIlNvdXJjZSAgICAgIDoge3NvdXJjZS5uYW1lfSIsCiAgICAg
#5#ICAgZiJMSUYgZmlsZSAgICA6IHthY3EuZ2V0KCdsaWZGaWxlJykgb3IgJy0nfSAgKHNlcmllcyB7
#5#YWNxLmdldCgnc2VyaWVzJykgb3IgJy0nfSkiLAogICAgICAgIGYiTWljcm9zY29wZSAgOiB7YWNx
#5#LmdldCgnbWljcm9zY29wZScpIG9yICctJ30gIGNhbWVyYSB7YWNxLmdldCgnY2FtZXJhJykgb3Ig
#5#Jy0nfSIsCiAgICAgICAgZiJab29tICAgICAgICA6IHthY3EuZ2V0KCd6b29tJykgb3IgYWNxLmdl
#5#dCgnem9vbU5vbWluYWwnKSBvciAnLSd9IiwKICAgICAgICBmIkV4cG9zdXJlICAgIDoge2FjcS5n
#5#ZXQoJ2V4cG9zdXJlTXMnKSBvciAnLSd9IG1zLCBnYWluIHthY3EuZ2V0KCdnYWluJykgb3IgJy0n
#5#fSIsCiAgICAgICAgZiJEaXNzZWN0aW9uICA6IHthY3EuZ2V0KCdkaXNzZWN0aW9uRGF0ZScpIG9y
#5#ICctJ30iLAogICAgICAgICIiLAogICAgICAgICJUaGUgVElGRiBpcyB0aGUgdW50b3VjaGVkIElt
#5#YWdlSiBleHBvcnQ7IGltYWdlLndlYnAgYmVzaWRlIGl0IGlzIHRoZSIsCiAgICAgICAgImRpc3Bs
#5#YXkgY29weSB1c2VkIGJ5IHRoZSB2aWV3ZXIgKGxvc3N5LCBxdWFsaXR5IDkwKS4iLAogICAgXQog
#5#ICAgcmV0dXJuICJcbiIuam9pbihsaW5lcykgKyAiXG4iCgoKIyDilIDilIAgT3JjaGVzdHJhdGlv
#5#biDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIAKZGVmIGltcG9ydF90aWZmKHNvdXJjZTogUGF0aCwgb3V0cHV0X3Jv
#5#b3Q6IFBhdGgsIGFyZ3MpIC0+IFBhdGg6CiAgICB3aXRoIEltYWdlLm9wZW4oc291cmNlKSBhcyBp
#5#bToKICAgICAgICBpaiA9IHJlYWRfaWpfbWV0YWRhdGEoaW0pCiAgICAgICAgZGVzY3JpcHRpb24g
#5#PSBzdHIoaW0udGFnX3YyLmdldChJTUFHRV9ERVNDUklQVElPTl9UQUcsICIiKSkKICAgICAgICBw
#5#eF91bSwgY2FsX3N0YXR1cyA9IHBpeGVsX3NpemVfdW0oaW0sIGRlc2NyaXB0aW9uKQogICAgICAg
#5#IHJnYiA9IGNvbXBvc2VfcmdiKHJlYWRfcGxhbmVzKGltKSwgaWouZ2V0KCJsdXRzIiwgW10pKQoK
#5#ICAgIHBhcnNlZCA9IHBhcnNlX2ZpbGVuYW1lKHNvdXJjZS5zdGVtLCBhcmdzLmxpbmUpCiAgICBm
#5#b2xkZXIgPSBkYXRhc2V0X2ZvbGRlcl9uYW1lKHBhcnNlZCkKICAgIG91dF9kaXIgPSBvdXRwdXRf
#5#cm9vdCAvIERBVEFTRVRfVFlQRSAvIGZvbGRlcgogICAgbWV0YV9wYXRoID0gb3V0X2RpciAvICJt
#5#ZXRhZGF0YS5qc29uIgogICAgaWYgbWV0YV9wYXRoLmV4aXN0cygpIGFuZCBub3QgYXJncy5mb3Jj
#5#ZToKICAgICAgICBwcmludChmIiAgW3NraXBdIHtmb2xkZXJ9IGV4aXN0cyAodXNlIC0tZm9yY2Ug
#5#dG8gcmUtaW1wb3J0KSIpCiAgICAgICAgcmV0dXJuIG91dF9kaXIKICAgIG91dF9kaXIubWtkaXIo
#5#cGFyZW50cz1UcnVlLCBleGlzdF9vaz1UcnVlKQoKICAgIGltYWdlID0gd3JpdGVfaW1hZ2VzKHJn
#5#Yiwgb3V0X2RpcikKICAgIGluZm8gPSAoaWouZ2V0KCJpbmZvIikgb3IgWyIiXSlbMF0KICAgIHNl
#5#cmllcyA9IF9zZXJpZXNfbmFtZShpaiwgcGFyc2VkKQogICAgYWNxdWlzaXRpb24gPSBsZWljYV9m
#5#aWVsZHMoaW5mbywgc2VyaWVzKSBpZiBzZXJpZXMgZWxzZSB7fQogICAgZnJlc2ggPSBidWlsZF9t
#5#ZXRhZGF0YShmb2xkZXIsIHBhcnNlZCwgaW1hZ2UsIHB4X3VtLCBjYWxfc3RhdHVzLCBhY3F1aXNp
#5#dGlvbiwgc291cmNlLCBhcmdzLnN0YWluaW5nKQogICAgbWV0YSA9IG1lcmdlX2N1cmF0ZWQoX2xv
#5#YWRfanNvbihtZXRhX3BhdGgpLCBmcmVzaCkgaWYgbWV0YV9wYXRoLmV4aXN0cygpIGVsc2UgZnJl
#5#c2gKICAgIG1ldGFfcGF0aC53cml0ZV90ZXh0KGpzb24uZHVtcHMobWV0YSwgaW5kZW50PTIsIGVu
#5#c3VyZV9hc2NpaT1GYWxzZSksIGVuY29kaW5nPSJ1dGYtOCIpCiAgICBpZiBhcmdzLndpdGhfZG93
#5#bmxvYWRzOgogICAgICAgIHdyaXRlX2Rvd25sb2FkKHNvdXJjZSwgb3V0X2RpciwgbWV0YSkKCiAg
#5#ICBweF90eHQgPSBmIntweF91bTouM2Z9IHVtL3B4IiBpZiBweF91bSBlbHNlICJ1bmNhbGlicmF0
#5#ZWQiCiAgICBwcmludChmIiAgW29rXSB7Zm9sZGVyfSAge2ltYWdlWyd3aWR0aCddfXh7aW1hZ2Vb
#5#J2hlaWdodCddfSAge21ldGFbJ3N0YWdlJ119ICB7cHhfdHh0fSIpCiAgICByZXR1cm4gb3V0X2Rp
#5#cgoKCmRlZiBfc2VyaWVzX25hbWUoaWo6IGRpY3QsIHBhcnNlZDogZGljdCkgLT4gc3RyOgogICAg
#5#IiIiSW1hZ2VKIGxhYmVscyBlYWNoIHBsYW5lIGBjOjEvMyAtIDxzZXJpZXM+YDsgdGhlIExlaWNh
#5#IGJsb2NrIGlzIGtleWVkIGJ5CiAgICB0aGF0IHNlcmllcyBuYW1lLCB3aGljaCBpcyBhbHNvIHRo
#5#ZSBvbmUgdGhlIGxhYiBtYXkgaGF2ZSByZW5hbWVkIGluIExBUyBYLiIiIgogICAgbGFiZWxzID0g
#5#aWouZ2V0KCJsYWJsIikgb3IgW10KICAgIGlmIGxhYmVscyBhbmQgIiAtICIgaW4gbGFiZWxzWzBd
#5#OgogICAgICAgIHJldHVybiBsYWJlbHNbMF0uc3BsaXQoIiAtICIsIDEpWzFdLnN0cmlwKCkKICAg
#5#IHJldHVybiBwYXJzZWQuZ2V0KCJzZXJpZXMiKSBvciAiIgoKCmRlZiBfbG9hZF9qc29uKHBhdGg6
#5#IFBhdGgpIC0+IGRpY3Q6CiAgICB0cnk6CiAgICAgICAgcmV0dXJuIGpzb24ubG9hZHMocGF0aC5y
#5#ZWFkX3RleHQoZW5jb2Rpbmc9InV0Zi04IikpCiAgICBleGNlcHQgKE9TRXJyb3IsIFZhbHVlRXJy
#5#b3IpOgogICAgICAgIHJldHVybiB7fQoKCmRlZiBjb2xsZWN0X2lucHV0cyhpbnB1dF9wYXRoOiBQ
#5#YXRoLCBvbmx5OiBzdHIpIC0+IGxpc3Q6CiAgICBpZiBpbnB1dF9wYXRoLmlzX2ZpbGUoKToKICAg
#5#ICAgICBmaWxlcyA9IFtpbnB1dF9wYXRoXQogICAgZWxzZToKICAgICAgICBmaWxlcyA9IHNvcnRl
#5#ZChwIGZvciBwIGluIGlucHV0X3BhdGguaXRlcmRpcigpCiAgICAgICAgICAgICAgICAgICAgICAg
#5#aWYgcC5zdWZmaXgubG93ZXIoKSBpbiAoIi50aWYiLCAiLnRpZmYiKSBhbmQgcC5pc19maWxlKCkp
#5#CiAgICBpZiBvbmx5OgogICAgICAgIGZpbGVzID0gW2YgZm9yIGYgaW4gZmlsZXMgaWYgZm5tYXRj
#5#aC5mbm1hdGNoKGYubmFtZSwgb25seSldCiAgICByZXR1cm4gZmlsZXMKCgpkZWYgbWFpbigpIC0+
#5#IGludDoKICAgIGFwID0gYXJncGFyc2UuQXJndW1lbnRQYXJzZXIoZGVzY3JpcHRpb249IjJEIHBo
#5#b3RvZ3JhcGggaW1wb3J0ZXIgKG9uZSBUSUZGIOKGkiBvbmUgZGF0YXNldCkiKQogICAgYXAuYWRk
#5#X2FyZ3VtZW50KCItLWlucHV0IiwgcmVxdWlyZWQ9VHJ1ZSwgaGVscD0iRGlyZWN0b3J5IG9mIFRJ
#5#RkZzLCBvciBvbmUgVElGRi4iKQogICAgYXAuYWRkX2FyZ3VtZW50KCItLW91dHB1dCIsIHJlcXVp
#5#cmVkPVRydWUsIGhlbHA9IkRBVEFfV0VCIGRpcmVjdG9yeSBvZiB0aGUgd2ViIHBsYXRmb3JtLiIp
#5#CiAgICBhcC5hZGRfYXJndW1lbnQoIi0tb25seSIsIGRlZmF1bHQ9Tm9uZSwgaGVscD0iR2xvYiBv
#5#biB0aGUgZmlsZSBuYW1lIChlLmcuICcqRTguMConKS4iKQogICAgYXAuYWRkX2FyZ3VtZW50KCIt
#5#LWxpbmUiLCBkZWZhdWx0PU5vbmUsIGhlbHA9IlJlcG9ydGVyL3N0cmFpbiBsaW5lIGxhYmVsIChk
#5#ZWZhdWx0OiBwYXJzZWQgZnJvbSB0aGUgLmxpZiBuYW1lKS4iKQogICAgYXAuYWRkX2FyZ3VtZW50
#5#KCItLXN0YWluaW5nIiwgZGVmYXVsdD0iIiwgaGVscD0iU3RhaW5pbmcgbGFiZWwgc3RvcmVkIGlu
#5#IG1ldGFkYXRhIChlLmcuIFgtZ2FsKS4iKQogICAgYXAuYWRkX2FyZ3VtZW50KCItLXdpdGgtZG93
#5#bmxvYWRzIiwgYWN0aW9uPSJzdG9yZV90cnVlIiwgaGVscD0iUGxhY2UgdGhlIG9yaWdpbmFsIFRJ
#5#RkYgKyBSRUFETUUgdW5kZXIgZG93bmxvYWQvLiIpCiAgICBhcC5hZGRfYXJndW1lbnQoIi0tZm9y
#5#Y2UiLCBhY3Rpb249InN0b3JlX3RydWUiLCBoZWxwPSJSZS1pbXBvcnQgb3ZlciBhbiBleGlzdGlu
#5#ZyBkYXRhc2V0IChjdXJhdGlvbiBpcyBwcmVzZXJ2ZWQpLiIpCiAgICBhcmdzID0gYXAucGFyc2Vf
#5#YXJncygpCgogICAgZmlsZXMgPSBjb2xsZWN0X2lucHV0cyhQYXRoKGFyZ3MuaW5wdXQpLCBhcmdz
#5#Lm9ubHkpCiAgICBpZiBub3QgZmlsZXM6CiAgICAgICAgcHJpbnQoIlsyZF0gbm8gVElGRiBtYXRj
#5#aGVkLiIpCiAgICAgICAgcmV0dXJuIDEKICAgIHByaW50KGYiWzJkXSBpbXBvcnRlciB2e19fdmVy
#5#c2lvbl9ffSAtIHtsZW4oZmlsZXMpfSBmaWxlKHMpIC0+IHtQYXRoKGFyZ3Mub3V0cHV0KSAvIERB
#5#VEFTRVRfVFlQRX0iKQogICAgZmFpbHVyZXMgPSAwCiAgICBmb3Igc291cmNlIGluIGZpbGVzOgog
#5#ICAgICAgIHRyeToKICAgICAgICAgICAgaW1wb3J0X3RpZmYoc291cmNlLCBQYXRoKGFyZ3Mub3V0
#5#cHV0KSwgYXJncykKICAgICAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGV4YzogICMgb25lIGJhZCBl
#5#eHBvcnQgbXVzdCBub3Qgc3RvcCB0aGUgYmF0Y2gKICAgICAgICAgICAgZmFpbHVyZXMgKz0gMQog
#5#ICAgICAgICAgICBwcmludChmIiAgW2ZhaWxdIHtzb3VyY2UubmFtZX06IHtleGN9IikKICAgIHBy
#5#aW50KGYiWzJkXSBkb25lIC0ge2xlbihmaWxlcykgLSBmYWlsdXJlc30gaW1wb3J0ZWQsIHtmYWls
#5#dXJlc30gZmFpbGVkLiIpCiAgICByZXR1cm4gMSBpZiBmYWlsdXJlcyBlbHNlIDAKCgppZiBfX25h
#5#bWVfXyA9PSAiX19tYWluX18iOgogICAgc3lzLmV4aXQobWFpbigpKQo=
:: ---- [6] build_download_bundles.py (30552 octets) ----
#6#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwoiIiIKYnVpbGRfZG93bmxvYWRfYnVuZGxlcy5weSDigJQg
#6#UG9wdWxhdGUgZWFjaCBkYXRhc2V0J3MgZG93bmxvYWQvIGZvbGRlci4KCkZvciBldmVyeSBkYXRh
#6#c2V0IHVuZGVyIERBVEFfV0VCLzx0eXBlPi88Zm9sZGVyPi8gdGhpcyBidWlsZHMgdGhlIGZpbGVz
#6#IHRoZQpEb3dubG9hZCBDZW50ZXIncyBmaWxlIGV4cGxvcmVyIChhcGkvZG93bmxvYWRzKSB3aWxs
#6#IGV4cG9zZSwgaW4gdGhpcyBvcmRlcjoKCiAgMS4gPGZvbGRlcj5fd2ViLnppcCAgIOKAlCBhcmNo
#6#aXZlIG9mIHRoZSBzZXJ2ZWQvcHJlcHJvY2Vzc2VkIGRhdGFzZXQgKGJyaWNrcy8sCiAgICAgICAg
#6#ICAgICAgICAgICAgICAgICAgbWV0YWRhdGEuanNvbiwgdGh1bWJuYWlsLndlYnApLiBUaGUgZG93
#6#bmxvYWQvIGZvbGRlciBpcwogICAgICAgICAgICAgICAgICAgICAgICAgIEVYQ0xVREVELCBzbyB0
#6#aGUgYXJjaGl2ZSBuZXZlciBjb250YWlucyB0aGUgb3RoZXIKICAgICAgICAgICAgICAgICAgICAg
#6#ICAgICBkb3dubG9hZCBhcnRlZmFjdHMgKG9yIGl0c2VsZikuIEJ1aWx0IEZJUlNULgogIDIuIDxm
#6#b2xkZXI+LmltcyAgICAgICDigJQgdGhlIG9yaWdpbmFsIEltYXJpcyBmaWxlLCBwbGFjZWQgYnkg
#6#SEFSRCBMSU5LIChubyBieXRlCiAgICAgICAgICAgICAgICAgICAgICAgICAgZHVwbGljYXRpb247
#6#IFJBV19EQVRBIGFuZCBEQVRBX1dFQiBsaXZlIG9uIHRoZSBzYW1lCiAgICAgICAgICAgICAgICAg
#6#ICAgICAgICAgdm9sdW1lKS4gRmFsbHMgYmFjayB0byBhIGNvcHkgYWNyb3NzIHZvbHVtZXMuCiAg
#6#My4gPGZvbGRlcj4udGlmICAgICAgIOKAlCBhIG11bHRpLWNoYW5uZWwgSW1hZ2VKL0ZpamkgY29t
#6#cG9zaXRlIGh5cGVyc3RhY2sKICAgICAgICAgICAgICAgICAgICAgICAgICAobmF0aXZlIGJpdCBk
#6#ZXB0aCwgwrVtLWNhbGlicmF0ZWQsIHBlci1jaGFubmVsIGRpc3BsYXkKICAgICAgICAgICAgICAg
#6#ICAgICAgICAgICByYW5nZSArIExVVCkgcmVjb25zdHJ1Y3RlZCBmcm9tIHRoZSAuaW1zIGludGVy
#6#bmFsCiAgICAgICAgICAgICAgICAgICAgICAgICAgcmVzb2x1dGlvbiBweXJhbWlkIGF0IH5UQVJH
#6#RVRfUFggb24gdGhlIGxvbmcgWFkgc2lkZS4KICAgICAgICAgICAgICAgICAgICAgICAgICBJbWFn
#6#ZUogZmxhdm91ciByYXRoZXIgdGhhbiBPTUUgYmVjYXVzZSBPTUUtWE1MIGhhcyBubwogICAgICAg
#6#ICAgICAgICAgICAgICAgICAgIGRpc3BsYXktcmFuZ2UgZmllbGQ6IEJpby1Gb3JtYXRzIHRoZW4g
#6#b3BlbnMgdGhlIHN0YWNrCiAgICAgICAgICAgICAgICAgICAgICAgICAgYWNyb3NzIHRoZSBmdWxs
#6#IDAuLjY1NTM1IHN3ZWVwIGFuZCBldmVyeSBjaGFubmVsIHJlYWRzCiAgICAgICAgICAgICAgICAg
#6#ICAgICAgICAgYmxhY2sgdW50aWwgdGhlIHVzZXIgaGl0cyBSZXNldCBpbiBCcmlnaHRuZXNzL0Nv
#6#bnRyYXN0LgogICAgICAgICAgICAgICAgICAgICAgICAgIFRoZSAuaW1zIGJlc2lkZSBpdCBzdGF5
#6#cyB0aGUgaW50ZXJvcGVyYWJsZSBtYXN0ZXIuCiAgNC4gPGZvbGRlcj5fQ3tufV88bmFtZT5fTUlQ
#6#LnBuZyDigJQgcGVyLWNoYW5uZWwgbWF4aW11bS1pbnRlbnNpdHkgcHJvamVjdGlvbi4KICA1LiBS
#6#RUFETUUudHh0ICAgICAgICAg4oCUIHByb3ZlbmFuY2UsIGRpbWVuc2lvbnMsIHZveGVsIHNpemUs
#6#IGNoYW5uZWxzLCBjaXRhdGlvbi4KClRoZSAuaW1zIGlzIHJlYWQgc3RyYWlnaHQgZnJvbSB0aGUg
#6#SW1hcmlzIEhERjUgcHlyYW1pZCAoUmVzb2x1dGlvbkxldmVsIEwpLCBzbwpvbmx5IHRoZSBjaG9z
#6#ZW4gKHNtYWxsKSBsZXZlbCBpcyB0b3VjaGVkIOKAlCBuZXZlciB0aGUgZnVsbC1yZXNvbHV0aW9u
#6#IGxldmVsIDAuCgpJZGVtcG90ZW50OiBleGlzdGluZyBhcnRlZmFjdHMgYXJlIHNraXBwZWQgdW5s
#6#ZXNzIC0tZm9yY2UuIEVhY2ggZGF0YXNldCBpcwppc29sYXRlZCBpbiB0cnkvZXhjZXB0IHNvIG9u
#6#ZSBmYWlsdXJlIG5ldmVyIGFib3J0cyB0aGUgYmF0Y2guCgpVc2FnZToKICBweSB0b29scy9idWls
#6#ZF9kb3dubG9hZF9idW5kbGVzLnB5ICAgICAgICAgICAgICAgICAjIGFsbCBkYXRhc2V0cywgYWxs
#6#IGFydGVmYWN0cwogIHB5IHRvb2xzL2J1aWxkX2Rvd25sb2FkX2J1bmRsZXMucHkgLS1kYXRhc2V0
#6#cyBFOC0xICMgc3Vic3RyaW5nIGZpbHRlcgogIHB5IHRvb2xzL2J1aWxkX2Rvd25sb2FkX2J1bmRs
#6#ZXMucHkgLS1kcnktcnVuCiAgcHkgdG9vbHMvYnVpbGRfZG93bmxvYWRfYnVuZGxlcy5weSAtLW5v
#6#LWltcyAtLW5vLWFyY2hpdmUgICAjIG9ubHkgVElGRiArIE1JUAogIHB5IHRvb2xzL2J1aWxkX2Rv
#6#d25sb2FkX2J1bmRsZXMucHkgLS10aWZmLXB4IDEwMjQgLS1mb3JjZQoiIiIKZnJvbSBfX2Z1dHVy
#6#ZV9fIGltcG9ydCBhbm5vdGF0aW9ucwoKaW1wb3J0IGFyZ3BhcnNlCmltcG9ydCBqc29uCmltcG9y
#6#dCBvcwppbXBvcnQgcmUKaW1wb3J0IHNodXRpbAppbXBvcnQgc3lzCmltcG9ydCB0ZW1wZmlsZQpp
#6#bXBvcnQgdGltZQppbXBvcnQgd2FybmluZ3MKaW1wb3J0IHppcGZpbGUKZnJvbSBwYXRobGliIGlt
#6#cG9ydCBQYXRoCgppbXBvcnQgbnVtcHkgYXMgbnAKCiMg4pSA4pSAIFBhdGhzIC8gY29uZmlnIOKU
#6#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#6#gApST09UID0gUGF0aChfX2ZpbGVfXykucmVzb2x2ZSgpLnBhcmVudC5wYXJlbnQgICAgICAgICAg
#6#IyBXZWJQbGF0Zm9ybSByb290CkRBVEFfV0VCID0gUk9PVCAvICJEQVRBX1dFQiIKIyBXaGVyZSB0
#6#aGUgb3JpZ2luYWwgLmltcyBmaWxlcyBsaXZlIChkb25lLyArIHRvZG8vIGFyZSBzY2FubmVkIHJl
#6#Y3Vyc2l2ZWx5KS4KUkFXX0RBVEFfRElSUyA9IFsKICAgIFBhdGgociJDOlxVc2Vyc1xBZG1pbmlz
#6#dHJhdG9yXERlc2t0b3BcRml4ZWQgaW1hZ2VzIGZvciBkYXRhYmFzZVxSQVdfREFUQSIpLApdCkRB
#6#VEFTRVRfVFlQRVMgPSAoIjNkIiwgIjJkIiwgImxpdmUiLCAidHJhY2tpbmciKQoKVEFSR0VUX1BY
#6#ID0gMjA0OCAgICAgICAgICAgICAgICMgZGVzaXJlZCBsb25nIFhZIHNpZGUgb2YgdGhlIGdlbmVy
#6#YXRlZCBUSUZGCiMgSGFyZCBjZWlsaW5nIG9uIHRoZSBpbi1mbGlnaHQgdm9sdW1lIChDwrdawrdZ
#6#wrdYwrdpdGVtc2l6ZSk7IGlmIHRoZSBsZXZlbCBjbG9zZXN0IHRvCiMgVEFSR0VUX1BYIGV4Y2Vl
#6#ZHMgdGhpcywgc3RlcCBkb3duIHRoZSBweXJhbWlkIHNvIHdlIG5ldmVyIGJsb3cgdXAgZGlzay9S
#6#QU0uCiMgVGhpcyBpcyBOT1QgdGhlIGNsYXNzaWMtVElGRiA0IEdpQiBvZmZzZXQgbGltaXQ6IHRo
#6#YXQgb25lIGFwcGxpZXMgdG8gdGhlCiMgQ09NUFJFU1NFRCBmaWxlICh+NDUlIG9mIHRoZSByYXcg
#6#dm9sdW1lIGhlcmUpLCBzbyBjYXBwaW5nIHRoZSByYXcgdm9sdW1lIGF0IDQKIyBHaUIgd291bGQg
#6#Y29zdCByZWFsIHJlc29sdXRpb24g4oCUIGl0IGhhbHZlZCA0IG9mIHRoZSBsYWIncyAxNiBkYXRh
#6#c2V0cyB3aGVuCiMgdHJpZWQuIEFuIG92ZXJmbG93aW5nIHdyaXRlIGlzIGNhdWdodCBhbmQgcmV0
#6#cmllZCBvbmUgbGV2ZWwgY29hcnNlciBpbnN0ZWFkLgpNQVhfVElGRl9CWVRFUyA9IDYgKiAxMDI0
#6#KiozCgojIEZhbHNlLWNvbG91ciBmYWxsYmFja3MgKG1pcnJvciBydW5fcHJlcHJvY2Vzcy5USFVN
#6#Ql9DT0xPUlMpIHdoZW4gYSBjaGFubmVsIGhhcwojIG5vIGRpc3BsYXkgY29sb3VyIGluIG1ldGFk
#6#YXRhLmpzb24uClRIVU1CX0NPTE9SUyA9IFsKICAgICgwLCAyNTUsIDEwMiksICgyNTUsIDYxLCAy
#6#NTUpLCAoNDcsIDEwNywgMjU1KSwgKDI1NSwgNDgsIDQ4KSwKICAgICgyNTUsIDI1NSwgMCksICgy
#6#NTUsIDAsIDI1NSksICgwLCAyNTUsIDI1NSksCl0KCgojIOKUgOKUgCBJbWFyaXMgYXR0cmlidXRl
#6#IGRlY29kaW5nIChtaXJyb3JzIHByZXByb2Nlc3MvMS1pbXNfbWV0YWRhdGEuYXR0cl9zdHIpIOKU
#6#gOKUgApkZWYgYXR0cl9zdHIoZ3JvdXAsIGtleSwgZGVmYXVsdD0iIik6CiAgICBpZiBncm91cCBp
#6#cyBOb25lOgogICAgICAgIHJldHVybiBkZWZhdWx0CiAgICB2ID0gZ3JvdXAuYXR0cnMuZ2V0KGtl
#6#eSwgZGVmYXVsdCkKICAgIGlmIGlzaW5zdGFuY2UodiwgKGJ5dGVzLCBucC5ieXRlc18pKToKICAg
#6#ICAgICByZXR1cm4gdi5kZWNvZGUoInV0Zi04IiwgZXJyb3JzPSJyZXBsYWNlIikuc3RyaXAoKQog
#6#ICAgaWYgaXNpbnN0YW5jZSh2LCBucC5uZGFycmF5KToKICAgICAgICB0cnk6CiAgICAgICAgICAg
#6#IHJldHVybiBiIiIuam9pbigKICAgICAgICAgICAgICAgIGJ5dGVzKGMpIGlmIGlzaW5zdGFuY2Uo
#6#YywgKGJ5dGVzLCBucC5ieXRlc18pKSBlbHNlIGMudG9ieXRlcygpCiAgICAgICAgICAgICAgICBm
#6#b3IgYyBpbiB2CiAgICAgICAgICAgICkuZGVjb2RlKCJ1dGYtOCIsIGVycm9ycz0icmVwbGFjZSIp
#6#LnN0cmlwKCkKICAgICAgICBleGNlcHQgRXhjZXB0aW9uOgogICAgICAgICAgICByZXR1cm4gIiIu
#6#am9pbigKICAgICAgICAgICAgICAgIGMuZGVjb2RlKCJ1dGYtOCIsIGVycm9ycz0icmVwbGFjZSIp
#6#IGlmIGlzaW5zdGFuY2UoYywgKGJ5dGVzLCBucC5ieXRlc18pKSBlbHNlIHN0cihjKQogICAgICAg
#6#ICAgICAgICAgZm9yIGMgaW4gdgogICAgICAgICAgICApLnN0cmlwKCkKICAgIHJldHVybiBzdHIo
#6#dikuc3RyaXAoKQoKCmRlZiBhdHRyX2Zsb2F0KGdyb3VwLCBrZXksIGRlZmF1bHQ9MC4wKToKICAg
#6#IHRyeToKICAgICAgICByZXR1cm4gZmxvYXQoYXR0cl9zdHIoZ3JvdXAsIGtleSwgc3RyKGRlZmF1
#6#bHQpKSkKICAgIGV4Y2VwdCAoVHlwZUVycm9yLCBWYWx1ZUVycm9yKToKICAgICAgICByZXR1cm4g
#6#ZGVmYXVsdAoKCmRlZiBoZXhfdG9fcmdiKHZhbHVlLCBmYWxsYmFjayk6CiAgICBtID0gcmUubWF0
#6#Y2gociJeIz8oWzAtOWEtZkEtRl17Nn0pJCIsIHN0cih2YWx1ZSBvciAiIikuc3RyaXAoKSkKICAg
#6#IGlmIG5vdCBtOgogICAgICAgIHJldHVybiBmYWxsYmFjawogICAgaCA9IG0uZ3JvdXAoMSkKICAg
#6#IHJldHVybiAoaW50KGhbMDoyXSwgMTYpLCBpbnQoaFsyOjRdLCAxNiksIGludChoWzQ6Nl0sIDE2
#6#KSkKCgojIOKUgOKUgCBEYXRhc2V0IGRpc2NvdmVyeSDilIDilIDilIDilIDilIDilIDilIDilIDi
#6#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#6#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#6#lIDilIDilIDilIDilIDilIDilIDilIDilIAKZGVmIF9yZWFkX21ldGFfanNvbihkKToKICAgICIi
#6#IlBlci1kYXRhc2V0IG1ldGFkYXRhLmpzb24g4oCUIHRoZSBhdXRob3JpdGF0aXZlIHNvdXJjZSBm
#6#b3IgY2hhbm5lbHMvdm94ZWxzLgogICAgdXRmLTgtc2lnIHRvbGVyYXRlcyBhIHN0cmF5IEJPTSAo
#6#aGFuZC1lZGl0ZWQgZmlsZXMpIHdpdGhvdXQgYnJlYWtpbmcgdGhlIHBhcnNlLiIiIgogICAgcCA9
#6#IGQgLyAibWV0YWRhdGEuanNvbiIKICAgIGlmIHAuZXhpc3RzKCk6CiAgICAgICAgdHJ5OgogICAg
#6#ICAgICAgICByZXR1cm4ganNvbi5sb2FkcyhwLnJlYWRfdGV4dChlbmNvZGluZz0idXRmLTgtc2ln
#6#IikpCiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbjoKICAgICAgICAgICAgcmV0dXJuIHt9CiAgICBy
#6#ZXR1cm4ge30KCgpkZWYgbG9hZF9kYXRhc2V0cyhmaWx0ZXJfc3Vic3RyPU5vbmUsIHR5cGVzPURB
#6#VEFTRVRfVFlQRVMpOgogICAgIiIiUmV0dXJuIFt7aWQsIHR5cGUsIGZvbGRlciwgZGlyLCBtZXRh
#6#fV0sIGRyaXZlbiBieSBjYXRhbG9nLmpzb24gd2hlbiBwcmVzZW50LgogICAgbWV0YWRhdGEuanNv
#6#biAod3JpdHRlbiBieSB0aGUgcHJlcHJvY2VzcyBwaXBlbGluZSkgdGFrZXMgcHJlY2VkZW5jZSBm
#6#b3IgYG1ldGFgCiAgICBzbyB0aGlzIHdvcmtzIGV2ZW4gd2hlbiBydW4gcmlnaHQgYWZ0ZXIgYSBk
#6#YXRhc2V0IGlzIGJ1aWx0LCBiZWZvcmUgY2F0YWxvZy5qc29uCiAgICBoYXMgYWdncmVnYXRlZCBp
#6#dC4iIiIKICAgIG91dCwgc2VlbiA9IFtdLCBzZXQoKQogICAgY2F0YWxvZyA9IERBVEFfV0VCIC8g
#6#ImNhdGFsb2cuanNvbiIKICAgIGVudHJpZXMgPSBbXQogICAgaWYgY2F0YWxvZy5leGlzdHMoKToK
#6#ICAgICAgICB0cnk6CiAgICAgICAgICAgIGVudHJpZXMgPSBqc29uLmxvYWRzKGNhdGFsb2cucmVh
#6#ZF90ZXh0KGVuY29kaW5nPSJ1dGYtOCIpKQogICAgICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZXhj
#6#OgogICAgICAgICAgICBwcmludChmIlt3YXJuXSBjYXRhbG9nLmpzb24gdW5yZWFkYWJsZSAoe2V4
#6#Y30pOyBmYWxsaW5nIGJhY2sgdG8gZGlyIHNjYW4iKQogICAgZm9yIGUgaW4gZW50cmllczoKICAg
#6#ICAgICAjIEEgY2F0YWxvZyBlbnRyeSdzIGBpZGAgYW5kIGBwYXRoYCBhcmUgdGhlIHNhbWUgJzx0
#6#eXBlPi88Zm9sZGVyPicgc3RyaW5nOwogICAgICAgICMgdGhlIHR5cGUgc2VnbWVudCBpcyB0aGUg
#6#ZGlyZWN0b3J5IHVuZGVyIERBVEFfV0VCLgogICAgICAgIHBhdGggPSBlLmdldCgicGF0aCIpIG9y
#6#IGUuZ2V0KCJpZCIpIG9yICIiCiAgICAgICAgcGFydHMgPSBwYXRoLnNwbGl0KCIvIiwgMSkKICAg
#6#ICAgICBpZiBsZW4ocGFydHMpICE9IDI6CiAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAgdHlw
#6#LCBmb2xkZXIgPSBwYXJ0cwogICAgICAgIGQgPSBEQVRBX1dFQiAvIHR5cCAvIGZvbGRlcgogICAg
#6#ICAgIGlmIHR5cCBpbiB0eXBlcyBhbmQgZC5pc19kaXIoKToKICAgICAgICAgICAgb3V0LmFwcGVu
#6#ZCh7ImlkIjogcGF0aCwgInR5cGUiOiB0eXAsICJmb2xkZXIiOiBmb2xkZXIsICJkaXIiOiBkLAog
#6#ICAgICAgICAgICAgICAgICAgICAgICAibWV0YSI6IF9yZWFkX21ldGFfanNvbihkKSBvciBlfSkK
#6#ICAgICAgICAgICAgc2Vlbi5hZGQocGF0aCkKICAgICMgZGlyLXNjYW4gZmFsbGJhY2sgZm9yIGFu
#6#eXRoaW5nIG5vdCBpbiB0aGUgY2F0YWxvZwogICAgZm9yIHR5cCBpbiB0eXBlczoKICAgICAgICBi
#6#YXNlID0gREFUQV9XRUIgLyB0eXAKICAgICAgICBpZiBub3QgYmFzZS5pc19kaXIoKToKICAgICAg
#6#ICAgICAgY29udGludWUKICAgICAgICBmb3IgZCBpbiBzb3J0ZWQoYmFzZS5pdGVyZGlyKCkpOgog
#6#ICAgICAgICAgICBwaWQgPSBmInt0eXB9L3tkLm5hbWV9IgogICAgICAgICAgICBpZiBkLmlzX2Rp
#6#cigpIGFuZCBwaWQgbm90IGluIHNlZW46CiAgICAgICAgICAgICAgICBvdXQuYXBwZW5kKHsiaWQi
#6#OiBwaWQsICJ0eXBlIjogdHlwLCAiZm9sZGVyIjogZC5uYW1lLCAiZGlyIjogZCwKICAgICAgICAg
#6#ICAgICAgICAgICAgICAgICAgICJtZXRhIjogX3JlYWRfbWV0YV9qc29uKGQpfSkKICAgIGlmIGZp
#6#bHRlcl9zdWJzdHI6CiAgICAgICAgb3V0ID0gW28gZm9yIG8gaW4gb3V0IGlmIGZpbHRlcl9zdWJz
#6#dHIubG93ZXIoKSBpbiBvWyJmb2xkZXIiXS5sb3dlcigpXQogICAgcmV0dXJuIG91dAoKCmRlZiBm
#6#aW5kX2ltcyhmb2xkZXIpOgogICAgIiIiTG9jYXRlIDxmb2xkZXI+LmltcyBpbiBhbnkgY29uZmln
#6#dXJlZCBSQVdfREFUQSBkaXIgKHJlY3Vyc2l2ZSkuIiIiCiAgICBmb3IgYmFzZSBpbiBSQVdfREFU
#6#QV9ESVJTOgogICAgICAgIGlmIG5vdCBiYXNlLmlzX2RpcigpOgogICAgICAgICAgICBjb250aW51
#6#ZQogICAgICAgIGV4YWN0ID0gbGlzdChiYXNlLnJnbG9iKGYie2ZvbGRlcn0uaW1zIikpCiAgICAg
#6#ICAgaWYgZXhhY3Q6CiAgICAgICAgICAgIHJldHVybiBleGFjdFswXQogICAgcmV0dXJuIE5vbmUK
#6#CgojIOKUgOKUgCBTdGVwIDEg4oCUIGFyY2hpdmUgb2YgdGhlIHByZXByb2Nlc3NlZCBkYXRhc2V0
#6#IChkb3dubG9hZC8gZXhjbHVkZWQpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgApkZWYgYnVpbGRfYXJj
#6#aGl2ZShkc19kaXIsIGZvbGRlciwgb3V0X3BhdGgsIGZvcmNlLCBkcnkpOgogICAgaWYgb3V0X3Bh
#6#dGguZXhpc3RzKCkgYW5kIG5vdCBmb3JjZToKICAgICAgICByZXR1cm4gInNraXAgKGV4aXN0cyki
#6#CiAgICAjIENvbGxlY3QgdGhlIHNlcnZhYmxlIGZpbGVzIGZpcnN0OyB0aGUgZG93bmxvYWQvIGZv
#6#bGRlciBpcyBleGNsdWRlZCBzbyB0aGUKICAgICMgYXJjaGl2ZSBuZXZlciBjb250YWlucyB0aGUg
#6#b3RoZXIgYXJ0ZWZhY3RzIChvciBpdHNlbGYpLgogICAgZmlsZXMgPSBbcCBmb3IgcCBpbiBzb3J0
#6#ZWQoZHNfZGlyLnJnbG9iKCIqIikpCiAgICAgICAgICAgICBpZiBwLmlzX2ZpbGUoKSBhbmQgcC5y
#6#ZWxhdGl2ZV90byhkc19kaXIpLnBhcnRzWzoxXSAhPSAoImRvd25sb2FkIiwpXQogICAgaWYgbm90
#6#IGZpbGVzOgogICAgICAgIHJldHVybiAic2tpcCAobm8gd2ViIGRhdGEgeWV0KSIgICAgICAgICMg
#6#dW4tcHJlcHJvY2Vzc2VkIGRhdGFzZXQg4oaSIG5vIGVtcHR5IHppcAogICAgaWYgZHJ5OgogICAg
#6#ICAgIHJldHVybiBmIndvdWxkIGJ1aWxkICh7bGVuKGZpbGVzKX0gZmlsZXMpIgogICAgdG1wID0g
#6#b3V0X3BhdGgud2l0aF9zdWZmaXgob3V0X3BhdGguc3VmZml4ICsgIi50bXAiKQogICAgd2l0aCB6
#6#aXBmaWxlLlppcEZpbGUodG1wLCAidyIsIGNvbXByZXNzaW9uPXppcGZpbGUuWklQX1NUT1JFRCwg
#6#YWxsb3daaXA2ND1UcnVlKSBhcyB6ZjoKICAgICAgICBmb3IgcGF0aCBpbiBmaWxlczoKICAgICAg
#6#ICAgICAgemYud3JpdGUocGF0aCwgYXJjbmFtZT1zdHIoUGF0aChmb2xkZXIpIC8gcGF0aC5yZWxh
#6#dGl2ZV90byhkc19kaXIpKSkKICAgIG9zLnJlcGxhY2UodG1wLCBvdXRfcGF0aCkKICAgIHJldHVy
#6#biBmIntsZW4oZmlsZXMpfSBmaWxlcywge2ZtdF9zaXplKG91dF9wYXRoLnN0YXQoKS5zdF9zaXpl
#6#KX0iCgoKIyDilIDilIAgU3RlcCAyIOKAlCBvcmlnaW5hbCAuaW1zIHZpYSBoYXJkIGxpbmsgKGNv
#6#cHkgZmFsbGJhY2spIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgOKUgApkZWYgcGxhY2VfaW1zKGltc19zcmMsIG91dF9wYXRoLCBmb3JjZSwg
#6#ZHJ5KToKICAgIGlmIG91dF9wYXRoLmV4aXN0cygpIGFuZCBub3QgZm9yY2U6CiAgICAgICAgcmV0
#6#dXJuICJza2lwIChleGlzdHMpIgogICAgaWYgZHJ5OgogICAgICAgIHJldHVybiBmIndvdWxkIGxp
#6#bmsge2ZtdF9zaXplKGltc19zcmMuc3RhdCgpLnN0X3NpemUpfSIKICAgIGlmIG91dF9wYXRoLmV4
#6#aXN0cygpOgogICAgICAgIG91dF9wYXRoLnVubGluaygpCiAgICB0cnk6CiAgICAgICAgb3MubGlu
#6#ayhpbXNfc3JjLCBvdXRfcGF0aCkgICAgICAgICAgICAgICAgICAgICAgIyBoYXJkIGxpbmssIDAg
#6#ZXh0cmEgYnl0ZXMKICAgICAgICByZXR1cm4gZiJoYXJkbGluayB7Zm10X3NpemUob3V0X3BhdGgu
#6#c3RhdCgpLnN0X3NpemUpfSIKICAgIGV4Y2VwdCBPU0Vycm9yOgogICAgICAgIHNodXRpbC5jb3B5
#6#MihpbXNfc3JjLCBvdXRfcGF0aCkgICAgICAgICAgICAgICAgICMgY3Jvc3Mtdm9sdW1lIGZhbGxi
#6#YWNrCiAgICAgICAgcmV0dXJuIGYiY29weSB7Zm10X3NpemUob3V0X3BhdGguc3RhdCgpLnN0X3Np
#6#emUpfSIKCgojIOKUgOKUgCBTdGVwIDMvNCDigJQgSW1hZ2VKIFRJRkYgKCsgcGVyLWNoYW5uZWwg
#6#TUlQKSBmcm9tIHRoZSAuaW1zIHB5cmFtaWQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmRlZiBs
#6#aXN0X2xldmVscyhmKToKICAgICIiIlsoTCwgWHIsIFlyLCBacildIGZyb20gdGhlIEltYXJpcyBS
#6#ZXNvbHV0aW9uTGV2ZWwgZ3JvdXBzIChyZWFsIHNpemVzKS4iIiIKICAgIGRhdGFzZXQgPSBmWyJE
#6#YXRhU2V0Il0KICAgIG91dCA9IFtdCiAgICBmb3Iga2V5IGluIGRhdGFzZXQua2V5cygpOgogICAg
#6#ICAgIGlmIG5vdCBrZXkuc3RhcnRzd2l0aCgiUmVzb2x1dGlvbkxldmVsIik6CiAgICAgICAgICAg
#6#IGNvbnRpbnVlCiAgICAgICAgTCA9IGludChrZXkuc3BsaXQoKVstMV0pCiAgICAgICAgdHAgPSBk
#6#YXRhc2V0W2tleV0uZ2V0KCJUaW1lUG9pbnQgMCIpCiAgICAgICAgaWYgdHAgaXMgTm9uZToKICAg
#6#ICAgICAgICAgY29udGludWUKICAgICAgICBjaDAgPSB0cC5nZXQoIkNoYW5uZWwgMCIpCiAgICAg
#6#ICAgaWYgY2gwIGlzIE5vbmU6CiAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAgeHIgPSBpbnQo
#6#YXR0cl9zdHIoY2gwLCAiSW1hZ2VTaXplWCIsICIwIikgb3IgMCkKICAgICAgICB5ciA9IGludChh
#6#dHRyX3N0cihjaDAsICJJbWFnZVNpemVZIiwgIjAiKSBvciAwKQogICAgICAgIHpyID0gaW50KGF0
#6#dHJfc3RyKGNoMCwgIkltYWdlU2l6ZVoiLCAiMCIpIG9yIDApCiAgICAgICAgaWYgbm90ICh4ciBh
#6#bmQgeXIgYW5kIHpyKToKICAgICAgICAgICAgZGF0YSA9IGNoMC5nZXQoIkRhdGEiKQogICAgICAg
#6#ICAgICBpZiBkYXRhIGlzIE5vbmU6CiAgICAgICAgICAgICAgICBjb250aW51ZQogICAgICAgICAg
#6#ICB6ciwgeXIsIHhyID0gKHpyIG9yIGRhdGEuc2hhcGVbMF0sIHlyIG9yIGRhdGEuc2hhcGVbMV0s
#6#IHhyIG9yIGRhdGEuc2hhcGVbMl0pCiAgICAgICAgb3V0LmFwcGVuZCgoTCwgeHIsIHlyLCB6cikp
#6#CiAgICByZXR1cm4gc29ydGVkKG91dCwga2V5PWxhbWJkYSBsdjogbHZbMF0pCgoKZGVmIGltc19j
#6#aGFubmVsX25hbWVzKGYsIG5fY2gpOgogICAgIiIiQ2hhbm5lbCBkaXNwbGF5IG5hbWVzIGZyb20g
#6#RGF0YVNldEluZm8vQ2hhbm5lbCB7aX07ICcnIHdoZW4gbWlzc2luZyBvciBhCiAgICBnZW5lcmlj
#6#ICdDaGFubmVsIE4nIHBsYWNlaG9sZGVyLCBzbyB0aGUgY2FsbGVyIGNhbiBmYWxsIGJhY2sgY2xl
#6#YW5seS4iIiIKICAgIGluZm8gPSBmLmdldCgiRGF0YVNldEluZm8iLCB7fSkKICAgIG5hbWVzID0g
#6#W10KICAgIGZvciBpIGluIHJhbmdlKG5fY2gpOgogICAgICAgIGNoID0gaW5mby5nZXQoZiJDaGFu
#6#bmVsIHtpfSIpIGlmIGhhc2F0dHIoaW5mbywgImdldCIpIGVsc2UgTm9uZQogICAgICAgIG5tID0g
#6#cmUuc3ViKHIiXHgwMC4qIiwgIiIsIGF0dHJfc3RyKGNoLCAiTmFtZSIsICIiKSkuc3RyaXAoKSBp
#6#ZiBjaCBpcyBub3QgTm9uZSBlbHNlICIiCiAgICAgICAgaWYgcmUubWF0Y2gociJeY2goYW5uZWwp
#6#P1xzKlxkKyQiLCBubSwgcmUuSUdOT1JFQ0FTRSk6CiAgICAgICAgICAgIG5tID0gIiIKICAgICAg
#6#ICBuYW1lcy5hcHBlbmQobm0pCiAgICByZXR1cm4gbmFtZXMKCgpkZWYgY2hvb3NlX2xldmVsKGxl
#6#dmVscywgbl9jaCwgdGFyZ2V0X3B4LCBtYXhfYnl0ZXMsIGl0ZW1zaXplPTIpOgogICAgIiIiTGV2
#6#ZWwgd2hvc2UgbG9uZyBYWSBzaWRlIGlzIGNsb3Nlc3QgdG8gdGFyZ2V0X3B4LCBzdGVwcGluZyBz
#6#bWFsbGVyIGlmIHRoZQogICAgaW4tZmxpZ2h0IHZvbHVtZSB3b3VsZCBleGNlZWQgbWF4X2J5dGVz
#6#LiIiIgogICAgY2hvc2VuID0gbWluKGxldmVscywga2V5PWxhbWJkYSBsdjogYWJzKG1heChsdlsx
#6#XSwgbHZbMl0pIC0gdGFyZ2V0X3B4KSkKICAgIHdoaWxlIGNob3NlblsxXSAqIGNob3NlblsyXSAq
#6#IGNob3NlblszXSAqIG5fY2ggKiBpdGVtc2l6ZSA+IG1heF9ieXRlczoKICAgICAgICBzbWFsbGVy
#6#ID0gW2x2IGZvciBsdiBpbiBsZXZlbHMgaWYgbHZbMF0gPiBjaG9zZW5bMF1dCiAgICAgICAgaWYg
#6#bm90IHNtYWxsZXI6CiAgICAgICAgICAgIGJyZWFrCiAgICAgICAgY2hvc2VuID0gbWluKHNtYWxs
#6#ZXIsIGtleT1sYW1iZGEgbHY6IGx2WzBdKQogICAgcmV0dXJuIGNob3NlbgoKCmRlZiByYW1wX2x1
#6#dChyZ2IpOgogICAgIiIiQmxhY2vihpJjb2xvdXIgOC1iaXQgcmFtcC4gSW1hZ2VKIGFwcGxpZXMg
#6#b25lIHBlciBjaGFubmVsIGluIGNvbXBvc2l0ZSBtb2RlLAogICAgc28gdGhlIGRvd25sb2FkIG9w
#6#ZW5zIGluIHRoZSBzYW1lIGNvbG91cnMgdGhlIHBsYXRmb3JtIHNob3dzLiIiIgogICAgbHV0ID0g
#6#bnAuemVyb3MoKDMsIDI1NiksIGR0eXBlPW5wLnVpbnQ4KQogICAgZm9yIGsgaW4gcmFuZ2UoMyk6
#6#CiAgICAgICAgbHV0W2tdID0gbnAubGluc3BhY2UoMCwgcmdiW2tdLCAyNTYsIGR0eXBlPW5wLnVp
#6#bnQ4KQogICAgcmV0dXJuIGx1dAoKCmRlZiByYW5nZV9mcm9tX2hpc3QoaGlzdCwgbG9fcGN0PTEu
#6#MCwgaGlfcGN0PTk5LjkpOgogICAgIiIiRGlzcGxheSByYW5nZSBmcm9tIGFuIGV4YWN0IGludGVu
#6#c2l0eSBoaXN0b2dyYW0g4oCUIHRoZSBzYW1lIDFzdOKAkzk5Ljl0aAogICAgcGVyY2VudGlsZSB3
#6#aW5kb3cgX2F1dG9zY2FsZSBnaXZlcyB0aGUgTUlQIFBOR3MsIHNvIHRoZSBzdGFjayBvcGVucyBs
#6#b29raW5nCiAgICBsaWtlIHRoZW0gaW5zdGVhZCBvZiBhdCB0aGUgZGV0ZWN0b3IncyBmdWxsIHRo
#6#ZW9yZXRpY2FsIHN3ZWVwLiIiIgogICAgdG90YWwgPSBpbnQoaGlzdC5zdW0oKSkKICAgIGlmIHRv
#6#dGFsIDw9IDA6CiAgICAgICAgcmV0dXJuIDAuMCwgMS4wCiAgICBjZGYgPSBucC5jdW1zdW0oaGlz
#6#dCkKICAgIGxvID0gZmxvYXQobnAuc2VhcmNoc29ydGVkKGNkZiwgdG90YWwgKiBsb19wY3QgLyAx
#6#MDAuMCkpCiAgICBoaSA9IGZsb2F0KG5wLnNlYXJjaHNvcnRlZChjZGYsIHRvdGFsICogaGlfcGN0
#6#IC8gMTAwLjApKQogICAgaWYgaGkgPD0gbG86CiAgICAgICAgbnogPSBucC5ub256ZXJvKGhpc3Qp
#6#WzBdCiAgICAgICAgbG8sIGhpID0gMC4wLCAoZmxvYXQobnpbLTFdKSBpZiBsZW4obnopIGVsc2Ug
#6#MS4wKQogICAgcmV0dXJuIGxvLCBtYXgoaGksIGxvICsgMS4wKQoKCmRlZiB0aWZmX2luZm8oZm9s
#6#ZGVyLCBsZXZlbCwgY2hfbmFtZXMsIHZveCwgZHR5cGUpOgogICAgIiIiRnJlZS10ZXh0IGJsb2Nr
#6#IHN1cmZhY2VkIGJ5IEZpamkncyBJbWFnZSDilrggU2hvdyBJbmZvLiIiIgogICAgcmV0dXJuICJc
#6#biIuam9pbihbCiAgICAgICAgZiJEYXRhc2V0OiB7Zm9sZGVyfSIsCiAgICAgICAgZiJTb3VyY2U6
#6#IEltYXJpcyAuaW1zIFJlc29sdXRpb25MZXZlbCB7bGV2ZWx9LCBuYXRpdmUge2R0eXBlfSIsCiAg
#6#ICAgICAgZiJWb3hlbCBzaXplICh1bSk6IFg9e3ZveFswXTouNmd9IFk9e3ZveFsxXTouNmd9IFo9
#6#e3ZveFsyXTouNmd9IiwKICAgICAgICAiQ2hhbm5lbHM6ICIgKyAiLCAiLmpvaW4oZiJDe2kgKyAx
#6#fT17bn0iIGZvciBpLCBuIGluIGVudW1lcmF0ZShjaF9uYW1lcykpLAogICAgICAgICJWb3hlbCB2
#6#YWx1ZXMgYXJlIHRoZSByYXcgYWNxdWlzaXRpb24gaW50ZW5zaXRpZXM7IG9ubHkgdGhlIHN0b3Jl
#6#ZCAiCiAgICAgICAgImRpc3BsYXkgcmFuZ2UgaXMgc2NhbGVkIChJbWFnZSA+IEFkanVzdCA+IEJy
#6#aWdodG5lc3MvQ29udHJhc3QpLiIsCiAgICAgICAgIkx1bWVuM0QgLyBJUklCSE0gTWljcm9zY29w
#6#eSBQbGF0Zm9ybSIsCiAgICBdKQoKCmNsYXNzIFRpZmZUb29MYXJnZShSdW50aW1lRXJyb3IpOgog
#6#ICAgIiIiVGhlIHdyaXR0ZW4gc3RhY2sgb3ZlcmZsb3dlZCB0aGUgSW1hZ2VKIGZsYXZvdXIncyAz
#6#Mi1iaXQgb2Zmc2V0cy4iIiIKCgpkZWYgd3JpdGVfaW1hZ2VqX3RpZmYocGF0aCwgdm9sLCB2b3gs
#6#IG1ldGFkYXRhKToKICAgICIiIldyaXRlIHRoZSBjb21wb3NpdGUgaHlwZXJzdGFjaywgcmVmdXNp
#6#bmcgYSBzaWxlbnRseSB0cnVuY2F0ZWQgZmlsZTogdGhlCiAgICBJbWFnZUogZmxhdm91ciBpcyBj
#6#bGFzc2ljIFRJRkYgKDMyLWJpdCBvZmZzZXRzKSwgYW5kIHBhc3QgfjQgR2lCIHRpZmZmaWxlCiAg
#6#ICB3YXJucyBhbmQga2VlcHMgb25seSB0aGUgZmlyc3QgSUZELCB3aGljaCBubyByZWFkZXIgY2Fu
#6#IG9wZW4uIiIiCiAgICBpbXBvcnQgdGlmZmZpbGUKICAgIHdpdGggd2FybmluZ3MuY2F0Y2hfd2Fy
#6#bmluZ3MocmVjb3JkPVRydWUpIGFzIGNhdWdodDoKICAgICAgICB3YXJuaW5ncy5zaW1wbGVmaWx0
#6#ZXIoImFsd2F5cyIpCiAgICAgICAgdGlmZmZpbGUuaW13cml0ZSgKICAgICAgICAgICAgc3RyKHBh
#6#dGgpLCB2b2wsIGltYWdlaj1UcnVlLCBwaG90b21ldHJpYz0ibWluaXNibGFjayIsCiAgICAgICAg
#6#ICAgIGNvbXByZXNzaW9uPSJ6bGliIiwKICAgICAgICAgICAgcmVzb2x1dGlvbj0oMS4wIC8gKHZv
#6#eFswXSBvciAxLjApLCAxLjAgLyAodm94WzFdIG9yIDEuMCkpLAogICAgICAgICAgICByZXNvbHV0
#6#aW9udW5pdD0iTk9ORSIsIG1ldGFkYXRhPW1ldGFkYXRhLAogICAgICAgICkKICAgIGZvciB3IGlu
#6#IGNhdWdodDoKICAgICAgICBpZiAidHJ1bmNhdCIgaW4gc3RyKHcubWVzc2FnZSkubG93ZXIoKToK
#6#ICAgICAgICAgICAgcGF0aC51bmxpbmsobWlzc2luZ19vaz1UcnVlKQogICAgICAgICAgICByYWlz
#6#ZSBUaWZmVG9vTGFyZ2Uoc3RyKHcubWVzc2FnZSkpCgoKZGVmIGJ1aWxkX3RpZmZfYW5kX21pcHMo
#6#aW1zX3NyYywgZHNfZGlyLCBmb2xkZXIsIGNoYW5uZWxzX21ldGEsIHRpZmZfcGF0aCwKICAgICAg
#6#ICAgICAgICAgICAgICAgICAgbWlwX3BhdGhzX2Zvciwgd2FudF90aWZmLCB3YW50X21pcCwgZm9y
#6#Y2UsIGRyeSk6CiAgICAiIiJSZXR1cm5zIGEgc3RhdHVzIHN0cmluZy4gUmVhZHMgT05FIHB5cmFt
#6#aWQgbGV2ZWwgKOKJiFRBUkdFVF9QWCksIHN0cmVhbXMgaXQKICAgIGludG8gYSBkaXNrLWJhY2tl
#6#ZCBtZW1tYXAgaW4gdGhlIHN5c3RlbSB0ZW1wIGRpciAobG93IFJBTSwgbmV2ZXIgbGl0dGVycwog
#6#ICAgZG93bmxvYWQvKSwgd3JpdGVzIGEgY2FsaWJyYXRlZCBJbWFnZUogY29tcG9zaXRlIGh5cGVy
#6#c3RhY2ssIGFuZCBlbWl0cwogICAgcGVyLWNoYW5uZWwgTUlQIFBOR3MuIiIiCiAgICBpbXBvcnQg
#6#aDVweQoKICAgIHRpZmZfZG9uZSA9IHRpZmZfcGF0aC5leGlzdHMoKSBhbmQgbm90IGZvcmNlCiAg
#6#ICBpZiBkcnk6CiAgICAgICAgcmV0dXJuICJ3b3VsZCBidWlsZCB0aWZmK21pcHMiCgogICAgd2l0
#6#aCBoNXB5LkZpbGUoc3RyKGltc19zcmMpLCAiciIpIGFzIGY6CiAgICAgICAgaW5mbyA9IGYuZ2V0
#6#KCJEYXRhU2V0SW5mbyIsIHt9KS5nZXQoIkltYWdlIiwgTm9uZSkKICAgICAgICBsZXZlbHMgPSBs
#6#aXN0X2xldmVscyhmKQogICAgICAgIGlmIG5vdCBsZXZlbHM6CiAgICAgICAgICAgIHJldHVybiAi
#6#bm8gcmVzb2x1dGlvbiBsZXZlbHMiCiAgICAgICAgdHAwID0gZlsiRGF0YVNldCJdWyJSZXNvbHV0
#6#aW9uTGV2ZWwgMCJdWyJUaW1lUG9pbnQgMCJdCiAgICAgICAgY2hfa2V5cyA9IHNvcnRlZChbayBm
#6#b3IgayBpbiB0cDAua2V5cygpIGlmIGsuc3RhcnRzd2l0aCgiQ2hhbm5lbCIpXSwKICAgICAgICAg
#6#ICAgICAgICAgICAgICAgIGtleT1sYW1iZGEgczogaW50KHMuc3BsaXQoKVstMV0pKQogICAgICAg
#6#IG5fY2ggPSBsZW4oY2hfa2V5cykKCiAgICAgICAgIyBDaGFubmVsIG5hbWVzOiBwcmVmZXIgdGhl
#6#IGN1cmF0ZWQgY2F0YWxvZyBuYW1lLCBlbHNlIHRoZSAuaW1zIG5hbWUsCiAgICAgICAgIyBlbHNl
#6#IGEgZ2VuZXJpYyBwbGFjZWhvbGRlci4gQ29sb3VycyBjb21lIGZyb20gdGhlIGNhdGFsb2cgd2hl
#6#biBwcmVzZW50LgogICAgICAgIGNhdCA9IF9wYWQoY2hhbm5lbHNfbWV0YSwgbl9jaCkKICAgICAg
#6#ICBpbXNfbmFtZXMgPSBpbXNfY2hhbm5lbF9uYW1lcyhmLCBuX2NoKQogICAgICAgIGNoX25hbWVz
#6#ID0gWyhjYXRbaV0uZ2V0KCJuYW1lIikgb3IgaW1zX25hbWVzW2ldIG9yIGYiQ2hhbm5lbCB7aSsx
#6#fSIpIGZvciBpIGluIHJhbmdlKG5fY2gpXQoKICAgICAgICAjIFRoZSBhY3F1aXNpdGlvbidzIGJp
#6#dCBkZXB0aCBpcyBwcmVzZXJ2ZWQuIFByb21vdGluZyBhbiA4LWJpdCBhY3F1aXNpdGlvbgogICAg
#6#ICAgICMgdG8gdWludDE2IGxlYXZlcyBldmVyeSB2YWx1ZSBpbiB0aGUgYm90dG9tIDAuNCUgb2Yg
#6#dGhlIHJhbmdlLCB3aGljaCBhbnkKICAgICAgICAjIHJlYWRlciB0aGF0IHRydXN0cyB0aGUgZGVj
#6#bGFyZWQgZGVwdGggcmVuZGVycyBhcyBibGFjay4KICAgICAgICBkdHlwZSA9IG5wLmR0eXBlKHRw
#6#MFtjaF9rZXlzWzBdXVsiRGF0YSJdLmR0eXBlKQoKICAgICAgICBuZWVkX3ZvbCA9IHdhbnRfdGlm
#6#ZiBhbmQgbm90IHRpZmZfZG9uZQogICAgICAgIGlmIG5vdCBuZWVkX3ZvbCBhbmQgbm90IHdhbnRf
#6#bWlwOgogICAgICAgICAgICByZXR1cm4gInRpZmYgc2tpcCAoZXhpc3RzKSIgaWYgd2FudF90aWZm
#6#IGVsc2UgIm5vdGhpbmcgdG8gZG8iCgogICAgICAgICMgUGh5c2ljYWwgZXh0ZW50IGlzIGxldmVs
#6#LWluZGVwZW5kZW50IOKGkiB2b3hlbCBzaXplID0gZXh0ZW50IC8gbGV2ZWwgZGltcy4KICAgICAg
#6#ICBleHQgPSBsYW1iZGEgbG8sIGhpOiAoYXR0cl9mbG9hdChpbmZvLCBoaSwgMS4wKSAtIGF0dHJf
#6#ZmxvYXQoaW5mbywgbG8sIDAuMCkpCgogICAgICAgICMgQmVzdCBsZXZlbCBmaXJzdCwgdGhlbiBl
#6#dmVyeSBjb2Fyc2VyIG9uZS4gV2hldGhlciB0aGUgY29tcHJlc3NlZCBzdGFjawogICAgICAgICMg
#6#Y2xlYXJzIHRoZSBjbGFzc2ljLVRJRkYgb2Zmc2V0IGxpbWl0IGlzIG9ubHkga25vd2FibGUgYWZ0
#6#ZXIgd3JpdGluZyBpdCwKICAgICAgICAjIHNvIGFuIG92ZXJmbG93IHN0ZXBzIGRvd24gaW5zdGVh
#6#ZCBvZiBsZWF2aW5nIHRoZSBkYXRhc2V0IHdpdGggbm8gVElGRi4KICAgICAgICBiZXN0ID0gY2hv
#6#b3NlX2xldmVsKGxldmVscywgbl9jaCwgVEFSR0VUX1BYLCBNQVhfVElGRl9CWVRFUywgZHR5cGUu
#6#aXRlbXNpemUpCiAgICAgICAgY2FuZGlkYXRlcyA9IFtsdiBmb3IgbHYgaW4gbGV2ZWxzIGlmIGx2
#6#WzBdID49IGJlc3RbMF1dCgogICAgICAgICMgRXhhY3QgcGVyLWNoYW5uZWwgaGlzdG9ncmFtIOKG
#6#kiBkaXNwbGF5IHJhbmdlLiBPbmx5IHRoZSBpbnRlZ2VyIHR5cGVzIGdldAogICAgICAgICMgb25l
#6#OyBJbWFnZUogYWxyZWFkeSBhdXRvLXNjYWxlcyBmbG9hdCBpbWFnZXMgd2hlbiBpdCBvcGVucyB0
#6#aGVtLgogICAgICAgIG5iaW5zID0gKDEgPDwgKDggKiBkdHlwZS5pdGVtc2l6ZSkpIGlmIGR0eXBl
#6#LmtpbmQgPT0gInUiIGFuZCBkdHlwZS5pdGVtc2l6ZSA8PSAyIGVsc2UgMAoKICAgICAgICBzdGF0
#6#dXMsIG1pcHMgPSBbXSwgW10KICAgICAgICBmb3IgYXR0ZW1wdCwgKEwsIFhyLCBZciwgWnIpIGlu
#6#IGVudW1lcmF0ZShjYW5kaWRhdGVzKToKICAgICAgICAgICAgdm94ID0gKAogICAgICAgICAgICAg
#6#ICAgZXh0KCJFeHRNaW4wIiwgIkV4dE1heDAiKSAvIG1heChYciwgMSksCiAgICAgICAgICAgICAg
#6#ICBleHQoIkV4dE1pbjEiLCAiRXh0TWF4MSIpIC8gbWF4KFlyLCAxKSwKICAgICAgICAgICAgICAg
#6#IGV4dCgiRXh0TWluMiIsICJFeHRNYXgyIikgLyBtYXgoWnIsIDEpLAogICAgICAgICAgICApCiAg
#6#ICAgICAgICAgIGJhc2UgPSBmWyJEYXRhU2V0Il1bZiJSZXNvbHV0aW9uTGV2ZWwge0x9Il1bIlRp
#6#bWVQb2ludCAwIl0KICAgICAgICAgICAgaGlzdHMgPSAoW25wLnplcm9zKG5iaW5zLCBkdHlwZT1u
#6#cC5pbnQ2NCkgZm9yIF8gaW4gcmFuZ2Uobl9jaCldCiAgICAgICAgICAgICAgICAgICAgIGlmIG5l
#6#ZWRfdm9sIGFuZCBuYmlucyBlbHNlIE5vbmUpCiAgICAgICAgICAgIHRtcF9kaXIgPSBQYXRoKHRl
#6#bXBmaWxlLm1rZHRlbXAocHJlZml4PSJsdW1lbl9idW5kbGVfIikpCiAgICAgICAgICAgIGFyciwg
#6#bWlwcyA9IE5vbmUsIFtdCiAgICAgICAgICAgIHRyeToKICAgICAgICAgICAgICAgIGlmIG5lZWRf
#6#dm9sOgogICAgICAgICAgICAgICAgICAgICMgSW1hZ2VKIGh5cGVyc3RhY2sgYXhpcyBvcmRlciBp
#6#cyBUWkNZWCDihpIgKFosIEMsIFksIFgpIGF0IFQ9MS4KICAgICAgICAgICAgICAgICAgICBhcnIg
#6#PSBucC5tZW1tYXAodG1wX2RpciAvIGYie2ZvbGRlcn0udm9sLmRhdCIsIGR0eXBlPWR0eXBlLAog
#6#ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBtb2RlPSJ3KyIsIHNoYXBlPShaciwg
#6#bl9jaCwgWXIsIFhyKSkKICAgICAgICAgICAgICAgIGZvciBjaSwgY2sgaW4gZW51bWVyYXRlKGNo
#6#X2tleXMpOgogICAgICAgICAgICAgICAgICAgIGRhdGEgPSBiYXNlW2NrXVsiRGF0YSJdCiAgICAg
#6#ICAgICAgICAgICAgICAgbWlwID0gbnAuemVyb3MoKFlyLCBYciksIGR0eXBlPWR0eXBlKQogICAg
#6#ICAgICAgICAgICAgICAgIGZvciB6IGluIHJhbmdlKFpyKTogICAgICAgICAgICAgICAgICMgcGxh
#6#bmUtYnktcGxhbmUg4oaSIGxvdyBSQU0KICAgICAgICAgICAgICAgICAgICAgICAgcGxhbmUgPSBk
#6#YXRhW3osIDpZciwgOlhyXQogICAgICAgICAgICAgICAgICAgICAgICBpZiBhcnIgaXMgbm90IE5v
#6#bmU6CiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcnJbeiwgY2ldID0gcGxhbmUKICAgICAg
#6#ICAgICAgICAgICAgICAgICAgbnAubWF4aW11bShtaXAsIHBsYW5lLCBvdXQ9bWlwKSAgIyBNSVAg
#6#YWNjcnVlcyBpbiB0aGUgc2FtZSBwYXNzCiAgICAgICAgICAgICAgICAgICAgICAgIGlmIGhpc3Rz
#6#IGlzIG5vdCBOb25lOgogICAgICAgICAgICAgICAgICAgICAgICAgICAgaGlzdHNbY2ldICs9IG5w
#6#LmJpbmNvdW50KHBsYW5lLnJhdmVsKCksIG1pbmxlbmd0aD1uYmlucykKICAgICAgICAgICAgICAg
#6#ICAgICBtaXBzLmFwcGVuZChtaXApCgogICAgICAgICAgICAgICAgaWYgbm90IG5lZWRfdm9sOgog
#6#ICAgICAgICAgICAgICAgICAgIGJyZWFrICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICMg
#6#TUlQLW9ubHk6IG5vdGhpbmcgdG8gd3JpdGUKICAgICAgICAgICAgICAgIGFyci5mbHVzaCgpCgog
#6#ICAgICAgICAgICAgICAgcmFuZ2VzLCBsdXRzID0gW10sIFtdCiAgICAgICAgICAgICAgICBmb3Ig
#6#Y2kgaW4gcmFuZ2Uobl9jaCk6CiAgICAgICAgICAgICAgICAgICAgbHV0cy5hcHBlbmQocmFtcF9s
#6#dXQoaGV4X3RvX3JnYihjYXRbY2ldLmdldCgiY29sb3IiKSwKICAgICAgICAgICAgICAgICAgICAg
#6#ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFRIVU1CX0NPTE9SU1tjaSAlIGxlbihUSFVN
#6#Ql9DT0xPUlMpXSkpKQogICAgICAgICAgICAgICAgICAgIGlmIGhpc3RzIGlzIG5vdCBOb25lOgog
#6#ICAgICAgICAgICAgICAgICAgICAgICByYW5nZXMuZXh0ZW5kKHJhbmdlX2Zyb21faGlzdChoaXN0
#6#c1tjaV0pKQogICAgICAgICAgICAgICAgbWV0YSA9IHsKICAgICAgICAgICAgICAgICAgICAiYXhl
#6#cyI6ICJaQ1lYIiwgInNwYWNpbmciOiB2b3hbMl0sICJ1bml0IjogInVtIiwKICAgICAgICAgICAg
#6#ICAgICAgICAibW9kZSI6ICJjb21wb3NpdGUiLCAiTFVUcyI6IGx1dHMsCiAgICAgICAgICAgICAg
#6#ICAgICAgIkxhYmVscyI6IFtjaF9uYW1lc1tjXSBmb3IgXyBpbiByYW5nZShacikgZm9yIGMgaW4g
#6#cmFuZ2Uobl9jaCldLAogICAgICAgICAgICAgICAgICAgICJJbmZvIjogdGlmZl9pbmZvKGZvbGRl
#6#ciwgTCwgY2hfbmFtZXMsIHZveCwgZHR5cGUpLAogICAgICAgICAgICAgICAgfQogICAgICAgICAg
#6#ICAgICAgaWYgcmFuZ2VzOgogICAgICAgICAgICAgICAgICAgIG1ldGFbIlJhbmdlcyJdID0gdHVw
#6#bGUocmFuZ2VzKQogICAgICAgICAgICAgICAgdG1wX3RpZiA9IHRpZmZfcGF0aC53aXRoX3N1ZmZp
#6#eCgiLnRpZi50bXAiKQogICAgICAgICAgICAgICAgdHJ5OgogICAgICAgICAgICAgICAgICAgIHdy
#6#aXRlX2ltYWdlal90aWZmKHRtcF90aWYsIG5wLmFzYXJyYXkoYXJyKSwgdm94LCBtZXRhKQogICAg
#6#ICAgICAgICAgICAgZXhjZXB0IFRpZmZUb29MYXJnZSBhcyBleGM6CiAgICAgICAgICAgICAgICAg
#6#ICAgaWYgYXR0ZW1wdCArIDEgPj0gbGVuKGNhbmRpZGF0ZXMpOgogICAgICAgICAgICAgICAgICAg
#6#ICAgICByYWlzZSBSdW50aW1lRXJyb3IoCiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmIm5v
#6#IHB5cmFtaWQgbGV2ZWwgZml0cyBhbiBJbWFnZUogVElGRiAoe2V4Y30pIikgZnJvbSBleGMKICAg
#6#ICAgICAgICAgICAgICAgICBwcmludChmIiAgW3RpZmZdIEx7TH0ge1hyfXh7WXJ9eHtacn0gb3Zl
#6#cmZsb3dzIHRoZSBJbWFnZUogVElGRiAiCiAgICAgICAgICAgICAgICAgICAgICAgICAgZiJvZmZz
#6#ZXQgbGltaXQg4oCUIHJldHJ5aW5nIG9uZSBsZXZlbCBjb2Fyc2VyIikKICAgICAgICAgICAgICAg
#6#ICAgICBjb250aW51ZQogICAgICAgICAgICAgICAgb3MucmVwbGFjZSh0bXBfdGlmLCB0aWZmX3Bh
#6#dGgpCiAgICAgICAgICAgICAgICBzdGF0dXMuYXBwZW5kKGYidGlmZiBMe0x9IHtYcn14e1lyfXh7
#6#WnJ9IHtkdHlwZX0gIgogICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmIntmbXRfc2l6ZSh0
#6#aWZmX3BhdGguc3RhdCgpLnN0X3NpemUpfSIpCiAgICAgICAgICAgICAgICBicmVhawogICAgICAg
#6#ICAgICBmaW5hbGx5OgogICAgICAgICAgICAgICAgIyBXaW5kb3dzIHJlZnVzZXMgdG8gdW5saW5r
#6#IGEgZmlsZSB0aGF0IGlzIHN0aWxsIG1hcHBlZCwgYW5kIGEKICAgICAgICAgICAgICAgICMgcmFp
#6#c2VkIGV4Y2VwdGlvbiBrZWVwcyB0aGUgbnAuYXNhcnJheSgpIHZpZXcgYWxpdmUgaW4gaXRzCiAg
#6#ICAgICAgICAgICAgICAjIHRyYWNlYmFjayDigJQgc28gZHJvcCB0aGUgbWFwcGluZyBleHBsaWNp
#6#dGx5IG9yIHRoZSBtdWx0aS1HaUIKICAgICAgICAgICAgICAgICMgc2NyYXRjaCBmaWxlIHN1cnZp
#6#dmVzIHRoZSBydW4uCiAgICAgICAgICAgICAgICBpZiBhcnIgaXMgbm90IE5vbmU6CiAgICAgICAg
#6#ICAgICAgICAgICAgdHJ5OgogICAgICAgICAgICAgICAgICAgICAgICBhcnIuX21tYXAuY2xvc2Uo
#6#KQogICAgICAgICAgICAgICAgICAgIGV4Y2VwdCBFeGNlcHRpb246CiAgICAgICAgICAgICAgICAg
#6#ICAgICAgIHBhc3MKICAgICAgICAgICAgICAgIGRlbCBhcnIKICAgICAgICAgICAgICAgIHNodXRp
#6#bC5ybXRyZWUodG1wX2RpciwgaWdub3JlX2Vycm9ycz1UcnVlKQoKICAgICAgICBpZiB3YW50X3Rp
#6#ZmYgYW5kIG5vdCBuZWVkX3ZvbDoKICAgICAgICAgICAgc3RhdHVzLmFwcGVuZCgidGlmZiBza2lw
#6#IChleGlzdHMpIikKCiAgICAgICAgaWYgd2FudF9taXA6CiAgICAgICAgICAgIGZyb20gUElMIGlt
#6#cG9ydCBJbWFnZQogICAgICAgICAgICBtYWRlID0gMAogICAgICAgICAgICBmb3IgY2ksIG1pcCBp
#6#biBlbnVtZXJhdGUobWlwcyk6CiAgICAgICAgICAgICAgICBvdXQgPSBtaXBfcGF0aHNfZm9yKGNp
#6#LCBjaF9uYW1lc1tjaV0pCiAgICAgICAgICAgICAgICBpZiBvdXQuZXhpc3RzKCkgYW5kIG5vdCBm
#6#b3JjZToKICAgICAgICAgICAgICAgICAgICBjb250aW51ZQogICAgICAgICAgICAgICAgcmdiID0g
#6#aGV4X3RvX3JnYihjYXRbY2ldLmdldCgiY29sb3IiKSwgVEhVTUJfQ09MT1JTW2NpICUgbGVuKFRI
#6#VU1CX0NPTE9SUyldKQogICAgICAgICAgICAgICAgbm9ybSA9IF9hdXRvc2NhbGUobWlwKSAgICAg
#6#ICAgICAgICAgICAgICMgMC4uMSBmbG9hdAogICAgICAgICAgICAgICAgaW1nID0gbnAuemVyb3Mo
#6#KG1pcC5zaGFwZVswXSwgbWlwLnNoYXBlWzFdLCAzKSwgZHR5cGU9bnAudWludDgpCiAgICAgICAg
#6#ICAgICAgICBmb3IgayBpbiByYW5nZSgzKToKICAgICAgICAgICAgICAgICAgICBpbWdbOiwgOiwg
#6#a10gPSBucC5jbGlwKG5vcm0gKiByZ2Jba10sIDAsIDI1NSkuYXN0eXBlKG5wLnVpbnQ4KQogICAg
#6#ICAgICAgICAgICAgSW1hZ2UuZnJvbWFycmF5KGltZywgIlJHQiIpLnNhdmUoc3RyKG91dCkpCiAg
#6#ICAgICAgICAgICAgICBtYWRlICs9IDEKICAgICAgICAgICAgc3RhdHVzLmFwcGVuZChmInttYWRl
#6#fSBNSVAgcG5nIikKICAgICAgICByZXR1cm4gIjsgIi5qb2luKHN0YXR1cykgb3IgIm5vdGhpbmcg
#6#dG8gZG8iCgoKZGVmIF9wYWQoY2hhbm5lbHNfbWV0YSwgbik6CiAgICBjbSA9IGxpc3QoY2hhbm5l
#6#bHNfbWV0YSBvciBbXSkKICAgIHdoaWxlIGxlbihjbSkgPCBuOgogICAgICAgIGNtLmFwcGVuZCh7
#6#fSkKICAgIHJldHVybiBjbQoKCmRlZiBfYXV0b3NjYWxlKHBsYW5lKToKICAgICIiIlJvYnVzdCAw
#6#Li4xIG5vcm1hbGlzYXRpb24gKDFzdOKAkzk5Ljl0aCBwZXJjZW50aWxlKSBmb3IgYSBNSVAgb2Yg
#6#YW55IGRlcHRoLiIiIgogICAgcCA9IHBsYW5lLmFzdHlwZShucC5mbG9hdDMyKQogICAgbG8gPSBm
#6#bG9hdChucC5wZXJjZW50aWxlKHAsIDEuMCkpCiAgICBoaSA9IGZsb2F0KG5wLnBlcmNlbnRpbGUo
#6#cCwgOTkuOSkpCiAgICBpZiBoaSA8PSBsbzoKICAgICAgICBoaSA9IGZsb2F0KHAubWF4KCkpIG9y
#6#IDEuMAogICAgICAgIGxvID0gMC4wCiAgICByZXR1cm4gbnAuY2xpcCgocCAtIGxvKSAvIChoaSAt
#6#IGxvKSwgMC4wLCAxLjApCgoKIyDilIDilIAgU3RlcCA1IOKAlCBSRUFETUUg4pSA4pSA4pSA4pSA
#6#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#6#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#6#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmRlZiB3cml0ZV9y
#6#ZWFkbWUob3V0X3BhdGgsIGRzLCBpbXNfc3JjLCBmb3JjZSwgZHJ5KToKICAgIGlmIG91dF9wYXRo
#6#LmV4aXN0cygpIGFuZCBub3QgZm9yY2U6CiAgICAgICAgcmV0dXJuICJza2lwIChleGlzdHMpIgog
#6#ICAgaWYgZHJ5OgogICAgICAgIHJldHVybiAid291bGQgd3JpdGUiCiAgICBsaW5lcyA9IF9yZWFk
#6#bWVfcGhvdG8oZHMpIGlmIGRzWyJ0eXBlIl0gPT0gIjJkIiBlbHNlIF9yZWFkbWVfdm9sdW1lKGRz
#6#LCBpbXNfc3JjKQogICAgbGluZXMgKz0gWwogICAgICAgICIiLAogICAgICAgICJDaXRhdGlvbjog
#6#Y2l0ZSB0aGUgSVJJQkhNIE1pY3Jvc2NvcHkgUGxhdGZvcm0gKEx1bWVuM0QsIElSSUJITSBAIFVM
#6#QikgYW5kICIKICAgICAgICAidGhlIG9yaWdpbmFsIGV4cGVyaW1lbnQvcHVibGljYXRpb24gd2hl
#6#biBhdmFpbGFibGUuIiwKICAgICAgICBmIkdlbmVyYXRlZDoge3RpbWUuc3RyZnRpbWUoJyVZLSVt
#6#LSVkICVIOiVNOiVTJyl9IiwKICAgIF0KICAgIG91dF9wYXRoLndyaXRlX3RleHQoIlxuIi5qb2lu
#6#KGxpbmVzKSwgZW5jb2Rpbmc9InV0Zi04IikKICAgIHJldHVybiAib2siCgoKZGVmIF9yZWFkbWVf
#6#cGhvdG8oZHMpOgogICAgIiIiQSAnMmQnIGRhdGFzZXQgaXMgb25lIGNhbGlicmF0ZWQgcGhvdG9n
#6#cmFwaDogbm8gdm94ZWxzLCBubyBjaGFubmVscywgYW5kIG5vCiAgICAuaW1zIHRvIHJlLXJlYWQg
#6#4oCUIHRoZSBvcmlnaW5hbCBUSUZGIGJlc2lkZSBpdCBjb21lcyBmcm9tIHRoZSBpbXBvcnRlci4i
#6#IiIKICAgIG1ldGEgPSBkc1sibWV0YSJdCiAgICBkaW1zID0gbWV0YS5nZXQoImRpbWVuc2lvbnMi
#6#LCB7fSkKICAgIHB4ID0gKG1ldGEuZ2V0KCJwaXhlbFNpemVVbSIpIG9yIHt9KS5nZXQoIngiKQog
#6#ICAgYWNxID0gbWV0YS5nZXQoImFjcXVpc2l0aW9uIiwge30pCiAgICByZXR1cm4gWwogICAgICAg
#6#IGYiRGF0YXNldCA6IHtkc1snZm9sZGVyJ119IiwKICAgICAgICBmIlR5cGUgICAgOiB7ZHNbJ3R5
#6#cGUnXX0gKGNhbGlicmF0ZWQgcGhvdG9ncmFwaCkiLAogICAgICAgIGYiU3RhZ2UgICA6IHttZXRh
#6#LmdldCgnc3RhZ2UnLCAnPycpfSAgICBMaW5lOiB7bWV0YS5nZXQoJ2xpbmUnKSBvciAnPyd9Igog
#6#ICAgICAgIGYiICAgIFN0YWluaW5nOiB7bWV0YS5nZXQoJ3N0YWluaW5nJykgb3IgJz8nfSIsCiAg
#6#ICAgICAgIiIsCiAgICAgICAgZiJJbWFnZSAgICAgIDoge2RpbXMuZ2V0KCd4JywnPycpfSB4IHtk
#6#aW1zLmdldCgneScsJz8nKX0gcHgsIFJHQiA4LWJpdCIsCiAgICAgICAgIlBpeGVsIHNpemUgOiAi
#6#ICsgKGYie3B4Oi40Zn0gdW0vcHgiIGlmIGlzaW5zdGFuY2UocHgsIChpbnQsIGZsb2F0KSkgZWxz
#6#ZSAidW5rbm93biIpLAogICAgICAgIGYiTWljcm9zY29wZSA6IHthY3EuZ2V0KCdtaWNyb3Njb3Bl
#6#Jykgb3IgJy0nfSAgICBjYW1lcmEge2FjcS5nZXQoJ2NhbWVyYScpIG9yICctJ30iLAogICAgICAg
#6#IGYiU291cmNlICAgICA6IHthY3EuZ2V0KCdzb3VyY2VGaWxlJykgb3IgJy0nfSIsCiAgICAgICAg
#6#IiIsCiAgICAgICAgIkZpbGVzIGluIHRoaXMgZm9sZGVyOiIsCiAgICAgICAgZiIgIHtkc1snZm9s
#6#ZGVyJ119X3dlYi56aXAgICBhcmNoaXZlIG9mIHRoZSB3ZWIgZGF0YXNldCAiCiAgICAgICAgIihp
#6#bWFnZS53ZWJwICsgcHJldmlldy53ZWJwICsgdGh1bWJuYWlsICsgbWV0YWRhdGEpIiwKICAgICAg
#6#ICAiICA8b3JpZ2luYWw+LnRpZiAgICAgICAgICAgdW50b3VjaGVkIEltYWdlSi9MZWljYSBleHBv
#6#cnQsIHByZXNlbnQgd2hlbiB0aGUgIgogICAgICAgICJpbXBvcnQgcmFuIHdpdGggLS13aXRoLWRv
#6#d25sb2FkcyIsCiAgICBdCgoKZGVmIF9yZWFkbWVfdm9sdW1lKGRzLCBpbXNfc3JjKToKICAgIG1l
#6#dGEgPSBkc1sibWV0YSJdCiAgICBkaW1zID0gbWV0YS5nZXQoImRpbWVuc2lvbnMiLCB7fSkKICAg
#6#IHZveCA9IG1ldGEuZ2V0KCJ2b3hlbF9zaXplIiwge30pCiAgICBjaGFucyA9IG1ldGEuZ2V0KCJj
#6#aGFubmVscyIsIFtdKQogICAgbGluZXMgPSBbCiAgICAgICAgZiJEYXRhc2V0IDoge2RzWydmb2xk
#6#ZXInXX0iLAogICAgICAgIGYiVHlwZSAgICA6IHtkc1sndHlwZSddfSIsCiAgICAgICAgZiJTdGFn
#6#ZSAgIDoge21ldGEuZ2V0KCdzdGFnZScsICc/Jyl9ICAgIEVtYnJ5bzoge21ldGEuZ2V0KCdlbWJy
#6#eW8nLCAnPycpfSIsCiAgICAgICAgIiIsCiAgICAgICAgIkRpbWVuc2lvbnMgKHZveGVscykgOiAi
#6#CiAgICAgICAgZiJYPXtkaW1zLmdldCgneCcsJz8nKX0gIFk9e2RpbXMuZ2V0KCd5JywnPycpfSAg
#6#Wj17ZGltcy5nZXQoJ3onLCc/Jyl9ICAiCiAgICAgICAgZiJDPXtkaW1zLmdldCgnYycsJz8nKX0g
#6#IFQ9e2RpbXMuZ2V0KCd0JywnPycpfSIsCiAgICAgICAgIlZveGVsIHNpemUgKMK1bSkgICAgIDog
#6#IgogICAgICAgIGYiWD17dm94LmdldCgneCcsJz8nKX0gIFk9e3ZveC5nZXQoJ3knLCc/Jyl9ICBa
#6#PXt2b3guZ2V0KCd6JywnPycpfSIsCiAgICAgICAgIiIsCiAgICAgICAgIkNoYW5uZWxzOiIsCiAg
#6#ICBdCiAgICBmb3IgaSwgYyBpbiBlbnVtZXJhdGUoY2hhbnMpOgogICAgICAgIGxpbmVzLmFwcGVu
#6#ZChmIiAgQ3tpKzF9OiB7Yy5nZXQoJ25hbWUnLCc/Jyl9ICBjb2xvcj17Yy5nZXQoJ2NvbG9yJywn
#6#PycpfSAgIgogICAgICAgICAgICAgICAgICAgICBmImdhbW1hPXtjLmdldCgnZ2FtbWEnLCc/Jyl9
#6#IikKICAgIGxpbmVzICs9IFsKICAgICAgICAiIiwKICAgICAgICAiRmlsZXMgaW4gdGhpcyBmb2xk
#6#ZXI6IiwKICAgICAgICBmIiAge2RzWydmb2xkZXInXX1fd2ViLnppcCAgIGFyY2hpdmUgb2YgdGhl
#6#IHdlYi9wcmVwcm9jZXNzZWQgZGF0YXNldCAiCiAgICAgICAgIihicmlja3MgKyBtZXRhZGF0YSAr
#6#IHRodW1ibmFpbCkiLAogICAgICAgIGYiICB7ZHNbJ2ZvbGRlciddfS5pbXMgICAgICAgb3JpZ2lu
#6#YWwgSW1hcmlzIGFjcXVpc2l0aW9uIgogICAgICAgICsgKGYiICAoe2ZtdF9zaXplKGltc19zcmMu
#6#c3RhdCgpLnN0X3NpemUpfSkiIGlmIGltc19zcmMgYW5kIGltc19zcmMuZXhpc3RzKCkgZWxzZSAi
#6#IChub3QgYXZhaWxhYmxlKSIpLAogICAgICAgIGYiICB7ZHNbJ2ZvbGRlciddfS50aWYgICAgICAg
#6#bXVsdGktY2hhbm5lbCBJbWFnZUovRmlqaSBjb21wb3NpdGUgaHlwZXJzdGFjayAiCiAgICAgICAg
#6#ZiIobmF0aXZlIGJpdCBkZXB0aCwgwrVtLWNhbGlicmF0ZWQsIH57VEFSR0VUX1BYfXB4KSwgZnJv
#6#bSB0aGUgLmltcyBweXJhbWlkIiwKICAgICAgICBmIiAge2RzWydmb2xkZXInXX1fQypfKl9NSVAu
#6#cG5nICAgcGVyLWNoYW5uZWwgbWF4aW11bS1pbnRlbnNpdHkgcHJvamVjdGlvbiIsCiAgICBdCiAg
#6#ICByZXR1cm4gbGluZXMKCgojIOKUgOKUgCBoZWxwZXJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#6#gApkZWYgZm10X3NpemUobik6CiAgICBuID0gZmxvYXQobikKICAgIGZvciB1bml0IGluICgiQiIs
#6#ICJLQiIsICJNQiIsICJHQiIsICJUQiIpOgogICAgICAgIGlmIG4gPCAxMDI0IG9yIHVuaXQgPT0g
#6#IlRCIjoKICAgICAgICAgICAgcmV0dXJuIGYie246LjFmfSB7dW5pdH0iIGlmIHVuaXQgIT0gIkIi
#6#IGVsc2UgZiJ7aW50KG4pfSBCIgogICAgICAgIG4gLz0gMTAyNAoKCiMg4pSA4pSAIG1haW4g4pSA
#6#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#6#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#6#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#6#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmRlZiBwcm9jZXNzKGRzLCBhcmdzKToKICAg
#6#IGZvbGRlciA9IGRzWyJmb2xkZXIiXQogICAgZGwgPSBkc1siZGlyIl0gLyAiZG93bmxvYWQiCiAg
#6#ICBwcmludChmIlxuPT09IHtkc1snaWQnXX0gPT09IikKICAgIGlmIG5vdCBhcmdzLmRyeV9ydW46
#6#CiAgICAgICAgZGwubWtkaXIocGFyZW50cz1UcnVlLCBleGlzdF9vaz1UcnVlKQoKICAgICMgMS4g
#6#YXJjaGl2ZSBGSVJTVCAoZG93bmxvYWQvIGlzIGV4Y2x1ZGVkIHJlZ2FyZGxlc3Mgb2Ygb3JkZXIp
#6#CiAgICBpZiBub3QgYXJncy5ub19hcmNoaXZlOgogICAgICAgIHRyeToKICAgICAgICAgICAgcHJp
#6#bnQoZiIgIFthcmNoaXZlXSB7YnVpbGRfYXJjaGl2ZShkc1snZGlyJ10sIGZvbGRlciwgZGwgLyBm
#6#J3tmb2xkZXJ9X3dlYi56aXAnLCBhcmdzLmZvcmNlLCBhcmdzLmRyeV9ydW4pfSIpCiAgICAgICAg
#6#ZXhjZXB0IEV4Y2VwdGlvbiBhcyBleGM6CiAgICAgICAgICAgIHByaW50KGYiICBbYXJjaGl2ZV0g
#6#RkFJTEVEOiB7ZXhjfSIpCgogICAgIyBBIHBob3RvZ3JhcGggaGFzIG5vIC5pbXMgdG8gcmUtcmVh
#6#ZDogc3RlcHMgMi00IGFyZSBtZWFuaW5nbGVzcywgYW5kIGl0cwogICAgIyBvcmlnaW5hbCBUSUZG
#6#ICsgUkVBRE1FIGFyZSBwbGFjZWQgYnkgcHJlcHJvY2Vzcy8yZF9pbXBvcnRlci5weS4KICAgICMg
#6#VGhlIFJFQURNRSBpcyBuZXZlciBmb3JjZWQgaGVyZSwgc28gdGhlIGltcG9ydGVyJ3MgcmljaGVy
#6#IG9uZSBhbHdheXMgd2lucy4KICAgIGlmIGRzWyJ0eXBlIl0gPT0gIjJkIjoKICAgICAgICB0cnk6
#6#CiAgICAgICAgICAgIHByaW50KGYiICBbcmVhZG1lXSB7d3JpdGVfcmVhZG1lKGRsIC8gJ1JFQURN
#6#RS50eHQnLCBkcywgTm9uZSwgRmFsc2UsIGFyZ3MuZHJ5X3J1bil9IikKICAgICAgICBleGNlcHQg
#6#RXhjZXB0aW9uIGFzIGV4YzoKICAgICAgICAgICAgcHJpbnQoZiIgIFtyZWFkbWVdIEZBSUxFRDog
#6#e2V4Y30iKQogICAgICAgIHJldHVybgoKICAgIGltc19zcmMgPSBmaW5kX2ltcyhmb2xkZXIpCiAg
#6#ICBpZiBpbXNfc3JjIGlzIE5vbmUgYW5kIG5vdCAoYXJncy5ub19pbXMgYW5kIGFyZ3Mubm9fdGlm
#6#Zik6CiAgICAgICAgcHJpbnQoZiIgIFsuaW1zXSBub3QgZm91bmQgaW4gUkFXX0RBVEEgZm9yICd7
#6#Zm9sZGVyfScg4oCUIHNraXBwaW5nIGltcy90aWZmL21pcCIpCgogICAgIyAyLiBvcmlnaW5hbCAu
#6#aW1zIChoYXJkIGxpbmspCiAgICBpZiBub3QgYXJncy5ub19pbXMgYW5kIGltc19zcmMgaXMgbm90
#6#IE5vbmU6CiAgICAgICAgdHJ5OgogICAgICAgICAgICBwcmludChmIiAgWy5pbXNdIHtwbGFjZV9p
#6#bXMoaW1zX3NyYywgZGwgLyBmJ3tmb2xkZXJ9LmltcycsIGFyZ3MuZm9yY2UsIGFyZ3MuZHJ5X3J1
#6#bil9IikKICAgICAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGV4YzoKICAgICAgICAgICAgcHJpbnQo
#6#ZiIgIFsuaW1zXSBGQUlMRUQ6IHtleGN9IikKCiAgICAjIDMvNC4gSW1hZ2VKIGNvbXBvc2l0ZSBU
#6#SUZGICsgcGVyLWNoYW5uZWwgTUlQCiAgICBpZiAobm90IGFyZ3Mubm9fdGlmZiBvciBub3QgYXJn
#6#cy5ub19taXApIGFuZCBpbXNfc3JjIGlzIG5vdCBOb25lOgogICAgICAgIGNoYW5uZWxzX21ldGEg
#6#PSBkc1sibWV0YSJdLmdldCgiY2hhbm5lbHMiLCBbXSkKICAgICAgICB0aWZmX291dCA9IGRsIC8g
#6#ZiJ7Zm9sZGVyfS50aWYiCiAgICAgICAgZGVmIG1pcF9wYXRoKGNpLCBuYW1lKToKICAgICAgICAg
#6#ICAgc2FmZSA9IHJlLnN1YihyIlteQS1aYS16MC05Ll8tXSsiLCAiXyIsIHN0cihuYW1lKSkuc3Ry
#6#aXAoIl8iKSBvciBmIkN7Y2krMX0iCiAgICAgICAgICAgIHJldHVybiBkbCAvIGYie2ZvbGRlcn1f
#6#Q3tjaSsxfV97c2FmZX1fTUlQLnBuZyIKICAgICAgICB0cnk6CiAgICAgICAgICAgIHByaW50KGYi
#6#ICBbdGlmZi9taXBdIHtidWlsZF90aWZmX2FuZF9taXBzKGltc19zcmMsIGRzWydkaXInXSwgZm9s
#6#ZGVyLCBjaGFubmVsc19tZXRhLCB0aWZmX291dCwgbWlwX3BhdGgsIG5vdCBhcmdzLm5vX3RpZmYs
#6#IG5vdCBhcmdzLm5vX21pcCwgYXJncy5mb3JjZSwgYXJncy5kcnlfcnVuKX0iKQogICAgICAgIGV4
#6#Y2VwdCBFeGNlcHRpb24gYXMgZXhjOgogICAgICAgICAgICBwcmludChmIiAgW3RpZmYvbWlwXSBG
#6#QUlMRUQ6IHtleGN9IikKICAgICAgICAjIERyb3AgdGhlIHN1cGVyc2VkZWQgT01FLVRJRkYgb25s
#6#eSBvbmNlIGl0cyByZXBsYWNlbWVudCBpcyBvbiBkaXNrIOKAlAogICAgICAgICMgbGVmdCBpbiBw
#6#bGFjZSBpdCBzdGF5cyB0aGUgZmlsZSBvcGVyYXRvcnMgZG93bmxvYWQsIGFuZCBpdCBvcGVucyBi
#6#bGFjay4KICAgICAgICBsZWdhY3kgPSBkbCAvIGYie2ZvbGRlcn0ub21lLnRpZiIKICAgICAgICBp
#6#ZiBsZWdhY3kuZXhpc3RzKCkgYW5kIHRpZmZfb3V0LmV4aXN0cygpIGFuZCBub3QgYXJncy5kcnlf
#6#cnVuOgogICAgICAgICAgICBsZWdhY3kudW5saW5rKCkKICAgICAgICAgICAgcHJpbnQoZiIgIFt0
#6#aWZmXSByZW1vdmVkIHN1cGVyc2VkZWQge2xlZ2FjeS5uYW1lfSIpCgogICAgIyA1LiBSRUFETUUK
#6#ICAgIHRyeToKICAgICAgICBwcmludChmIiAgW3JlYWRtZV0ge3dyaXRlX3JlYWRtZShkbCAvICdS
#6#RUFETUUudHh0JywgZHMsIGltc19zcmMsIGFyZ3MuZm9yY2UsIGFyZ3MuZHJ5X3J1bil9IikKICAg
#6#IGV4Y2VwdCBFeGNlcHRpb24gYXMgZXhjOgogICAgICAgIHByaW50KGYiICBbcmVhZG1lXSBGQUlM
#6#RUQ6IHtleGN9IikKCgpkZWYgbWFpbigpOgogICAgZ2xvYmFsIFRBUkdFVF9QWCwgREFUQV9XRUIs
#6#IFJBV19EQVRBX0RJUlMKICAgIGFwID0gYXJncGFyc2UuQXJndW1lbnRQYXJzZXIoZGVzY3JpcHRp
#6#b249IlBvcHVsYXRlIGVhY2ggZGF0YXNldCdzIGRvd25sb2FkLyBmb2xkZXIuIikKICAgIGFwLmFk
#6#ZF9hcmd1bWVudCgiLS1kYXRhc2V0cyIsIGhlbHA9ImNhc2UtaW5zZW5zaXRpdmUgc3Vic3RyaW5n
#6#IGZpbHRlciBvbiBmb2xkZXIgbmFtZSIpCiAgICBhcC5hZGRfYXJndW1lbnQoIi0tdHlwZXMiLCBk
#6#ZWZhdWx0PSIsIi5qb2luKERBVEFTRVRfVFlQRVMpLAogICAgICAgICAgICAgICAgICAgIGhlbHA9
#6#ImNvbW1hIGxpc3Q6IDNkLDJkLGxpdmUsdHJhY2tpbmcgKGEgMmQgZGF0YXNldCBnZXRzIHRoZSAi
#6#CiAgICAgICAgICAgICAgICAgICAgICAgICAid2ViIGFyY2hpdmUgb25seSDigJQgaXRzIG9yaWdp
#6#bmFsIFRJRkYgYW5kIFJFQURNRSBjb21lIGZyb20gdGhlIGltcG9ydGVyKSIpCiAgICBhcC5hZGRf
#6#YXJndW1lbnQoIi0tZGF0YS13ZWIiLCBoZWxwPSJvdmVycmlkZSB0aGUgREFUQV9XRUIgZGlyZWN0
#6#b3J5IChkZWZhdWx0OiA8cmVwbz4vREFUQV9XRUIpIikKICAgIGFwLmFkZF9hcmd1bWVudCgiLS1y
#6#YXctZGlyIiwgaGVscD0iZGlyZWN0b3J5IHRvIHNlYXJjaCBmaXJzdCBmb3IgdGhlIHNvdXJjZSAu
#6#aW1zIChwcmVwZW5kZWQgdG8gUkFXX0RBVEFfRElSUykiKQogICAgYXAuYWRkX2FyZ3VtZW50KCIt
#6#LXRpZmYtcHgiLCB0eXBlPWludCwgZGVmYXVsdD1UQVJHRVRfUFgsIGhlbHA9InRhcmdldCBsb25n
#6#IFhZIHNpZGUgb2YgdGhlIFRJRkYiKQogICAgYXAuYWRkX2FyZ3VtZW50KCItLW5vLWFyY2hpdmUi
#6#LCBhY3Rpb249InN0b3JlX3RydWUiKQogICAgYXAuYWRkX2FyZ3VtZW50KCItLW5vLWltcyIsIGFj
#6#dGlvbj0ic3RvcmVfdHJ1ZSIpCiAgICBhcC5hZGRfYXJndW1lbnQoIi0tbm8tdGlmZiIsIGFjdGlv
#6#bj0ic3RvcmVfdHJ1ZSIpCiAgICBhcC5hZGRfYXJndW1lbnQoIi0tbm8tbWlwIiwgYWN0aW9uPSJz
#6#dG9yZV90cnVlIikKICAgIGFwLmFkZF9hcmd1bWVudCgiLS1mb3JjZSIsIGFjdGlvbj0ic3RvcmVf
#6#dHJ1ZSIsIGhlbHA9InJlYnVpbGQgYXJ0ZWZhY3RzIHRoYXQgYWxyZWFkeSBleGlzdCIpCiAgICBh
#6#cC5hZGRfYXJndW1lbnQoIi0tZHJ5LXJ1biIsIGFjdGlvbj0ic3RvcmVfdHJ1ZSIpCiAgICBhcmdz
#6#ID0gYXAucGFyc2VfYXJncygpCgogICAgVEFSR0VUX1BYID0gYXJncy50aWZmX3B4CiAgICBpZiBh
#6#cmdzLmRhdGFfd2ViOgogICAgICAgIERBVEFfV0VCID0gUGF0aChhcmdzLmRhdGFfd2ViKQogICAg
#6#aWYgYXJncy5yYXdfZGlyOgogICAgICAgIFJBV19EQVRBX0RJUlMgPSBbUGF0aChhcmdzLnJhd19k
#6#aXIpXSArIFJBV19EQVRBX0RJUlMKICAgIHR5cGVzID0gdHVwbGUodC5zdHJpcCgpIGZvciB0IGlu
#6#IGFyZ3MudHlwZXMuc3BsaXQoIiwiKSBpZiB0LnN0cmlwKCkpCgogICAgZGF0YXNldHMgPSBsb2Fk
#6#X2RhdGFzZXRzKGFyZ3MuZGF0YXNldHMsIHR5cGVzKQogICAgaWYgbm90IGRhdGFzZXRzOgogICAg
#6#ICAgIHByaW50KCJObyBkYXRhc2V0cyBtYXRjaGVkLiIpCiAgICAgICAgcmV0dXJuIDEKICAgIHBy
#6#aW50KGYie2xlbihkYXRhc2V0cyl9IGRhdGFzZXQocykgdG8gcHJvY2VzcyAiCiAgICAgICAgICBm
#6#IihhcmNoaXZlPXtub3QgYXJncy5ub19hcmNoaXZlfSBpbXM9e25vdCBhcmdzLm5vX2ltc30gIgog
#6#ICAgICAgICAgZiJ0aWZmPXtub3QgYXJncy5ub190aWZmfSBtaXA9e25vdCBhcmdzLm5vX21pcH0g
#6#dGFyZ2V0PXtUQVJHRVRfUFh9cHggIgogICAgICAgICAgZiJkcnlfcnVuPXthcmdzLmRyeV9ydW59
#6#KSIpCiAgICB0MCA9IHRpbWUudGltZSgpCiAgICBmb3IgZHMgaW4gZGF0YXNldHM6CiAgICAgICAg
#6#dHJ5OgogICAgICAgICAgICBwcm9jZXNzKGRzLCBhcmdzKQogICAgICAgIGV4Y2VwdCBFeGNlcHRp
#6#b24gYXMgZXhjOgogICAgICAgICAgICBwcmludChmIiAgW2RhdGFzZXRdIEZBSUxFRDoge2V4Y30i
#6#KQogICAgcHJpbnQoZiJcbkRvbmUgaW4ge3RpbWUudGltZSgpIC0gdDA6LjBmfXMuIikKICAgIHJl
#6#dHVybiAwCgoKaWYgX19uYW1lX18gPT0gIl9fbWFpbl9fIjoKICAgIHN5cy5leGl0KG1haW4oKSkK
