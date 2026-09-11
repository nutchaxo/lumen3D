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
set "PP_VERSION=0.17.2"
set "PY_VERSION=3.12.8"
set "SCRIPTS=run_preprocess.py 1-ims_metadata.py 2-image_processor.py 3-chunk_packer.py 4-catalog_generator.py wholemount_importer.py"
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
rem  LOD, tracking), les photographies whole-mount par wholemount_importer.py --
rem  une image, rien a decouper. Les deux scripts sont embarques dans ce .bat.
:ask_params
echo.
echo      !ACC![1]!R! Volumes Imaris             !DIM!(.ims, dossier fixed\)!R!
echo      !ACC![2]!R! Photographies whole-mount  !DIM!(.tif, dossier wholemount\)!R!
echo.
set "MODE=volumes"
set "_ans="
set /p "_ans=   Type de donnees [1] : "
if "!_ans!"=="2" set "MODE=wholemount"
if "!MODE!"=="wholemount" goto :ask_wholemount

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


rem ---- Saisie des parametres : photographies whole-mount ---------------------
:ask_wholemount
:ask_wm_input
echo.
set "INPUT="
set /p "INPUT=   Dossier des fichiers .tif : "
if not defined INPUT (
    call :warnmsg "Veuillez saisir un dossier."
    goto :ask_wm_input
)
set INPUT=!INPUT:"=!
if not exist "!INPUT!\" (
    call :warnmsg "Dossier introuvable : !INPUT!"
    goto :ask_wm_input
)
set "TIFCOUNT=0"
for %%F in ("!INPUT!\*.tif" "!INPUT!\*.tiff") do set /a TIFCOUNT+=1
if "!TIFCOUNT!"=="0" (
    call :warnmsg "Aucun fichier .tif detecte dans ce dossier."
    set "_ans="
    set /p "_ans=   Continuer quand meme ? [o/N] "
    if /i not "!_ans!"=="o" goto :ask_wm_input
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
echo      Sortie     : !OUTPUT!\wholemount
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
if "!MODE!"=="wholemount" goto :run_wholemount
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
:run_wholemount
if defined WITH_DOWNLOADS set "EXTRA=--with-downloads"
if defined FORCE set EXTRA=!EXTRA! --force
if defined LINE set EXTRA=!EXTRA! --line "!LINE!"
%PY% "!WORK!\wholemount_importer.py" --input "!INPUT!" --output "!OUTPUT!" --staining "!STAINING!" !EXTRA!

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
:: ---- [0] run_preprocess.py (19350 octets) ----
#0#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMw0KaW1wb3J0IGFyZ3BhcnNlDQppbXBvcnQgZm5tYXRjaA0K
#0#aW1wb3J0IGpzb24NCmltcG9ydCBvcw0KaW1wb3J0IHNodXRpbA0KaW1wb3J0IHNpZ25hbA0KaW1w
#0#b3J0IHN1YnByb2Nlc3MNCmltcG9ydCBzeXMNCmltcG9ydCB0cmFjZWJhY2sNCmZyb20gZGF0ZXRp
#0#bWUgaW1wb3J0IGRhdGV0aW1lDQpmcm9tIHBhdGhsaWIgaW1wb3J0IFBhdGgNCmltcG9ydCBudW1w
#0#eSBhcyBucA0KZnJvbSBQSUwgaW1wb3J0IEltYWdlDQoNCl9fdmVyc2lvbl9fID0gIjAuMTcuMiIN
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
#0#IHdpdGggb3Blbih0ZW1wX21ldGFfanNvbiwgInIiLCBlbmNvZGluZz0idXRmLTgiKSBhcyBmbToN
#0#CiAgICAgICAgICAgIG5fdGltZXBvaW50cyA9IGludChqc29uLmxvYWQoZm0pLmdldCgibl90aW1l
#0#cG9pbnRzIiwgMSkgb3IgMSkNCiAgICAgICAgdHlwZV9kaXIgPSAibGl2ZSIgaWYgbl90aW1lcG9p
#0#bnRzID4gMSBlbHNlICJmaXhlZCINCiAgICAgICAgZGF0YXNldF9vdXRwdXRfZGlyID0gb3V0cHV0
#0#X3Jvb3QgLyB0eXBlX2RpciAvIGRhdGFzZXRfbmFtZQ0KICAgICAgICAjIFRoZSBwcmV2aW91cyBi
#0#cmlja3MgdXNlZCB0byBiZSBERUxFVEVEIGhlcmUsIGJlZm9yZSB0aGUgaGVhdnkgc3RlcCBldmVu
#0#IHJhbi4NCiAgICAgICAgIyBBbnkgZmFpbHVyZSBhZnRlciB0aGlzIHBvaW50IOKAlCBhbmQgc3Rl
#0#cCAyIGNhbiBmYWlsIGZvciByZWFzb25zIHRoYXQgaGF2ZQ0KICAgICAgICAjIG5vdGhpbmcgdG8g
#0#ZG8gd2l0aCB0aGUgZGF0YSwgc3VjaCBhcyBleGhhdXN0aW5nIHRoZSBXaW5kb3dzIGNvbW1pdCBs
#0#aW1pdCBvbiBhDQogICAgICAgICMgYnVzeSBtYWNoaW5lIOKAlCBsZWZ0IGFuIGFscmVhZHkgcHVi
#0#bGlzaGVkIGRhdGFzZXQgd2l0aCBubyBicmlja3MgYXQgYWxsIGFuZCBubw0KICAgICAgICAjIHdh
#0#eSBiYWNrLiBUaGV5IGFyZSBub3cgbW92ZWQgYXNpZGUgYW5kIG9ubHkgZHJvcHBlZCBvbmNlIHRo
#0#ZSBydW4gaGFzIHN1Y2NlZWRlZDsNCiAgICAgICAgIyBvbiBmYWlsdXJlIHRoZXkgYXJlIHB1dCBi
#0#YWNrIChzZWUgdGhlIGV4Y2VwdC9maW5hbGx5IGJlbG93KS4NCiAgICAgICAgYnJpY2tzX2RpciA9
#0#IGRhdGFzZXRfb3V0cHV0X2RpciAvICJicmlja3MiDQogICAgICAgIGJyaWNrc19yb2xsYmFjayA9
#0#IGRhdGFzZXRfb3V0cHV0X2RpciAvICJicmlja3Mucm9sbGJhY2siDQogICAgICAgIGlmIGJyaWNr
#0#c19kaXIuZXhpc3RzKCk6DQogICAgICAgICAgICBpZiBicmlja3Nfcm9sbGJhY2suZXhpc3RzKCk6
#0#DQogICAgICAgICAgICAgICAgc2h1dGlsLnJtdHJlZShicmlja3Nfcm9sbGJhY2ssIGlnbm9yZV9l
#0#cnJvcnM9VHJ1ZSkNCiAgICAgICAgICAgIGJyaWNrc19kaXIucmVuYW1lKGJyaWNrc19yb2xsYmFj
#0#aykNCiAgICAgICAgZGF0YXNldF9vdXRwdXRfZGlyLm1rZGlyKHBhcmVudHM9VHJ1ZSwgZXhpc3Rf
#0#b2s9VHJ1ZSkNCiAgICAgICAgaWYgbl90aW1lcG9pbnRzID4gMToNCiAgICAgICAgICAgIHByaW50
#0#KF9kaW0oZiIgICB0eXBlICAgOiBsaXZlICh7bl90aW1lcG9pbnRzfSB0aW1lcG9pbnRzKSIpKQ0K
#0#DQogICAgICAgICMgU3RlcCAyOiBOb3JtYWxpemF0aW9uLCBCYWNrZ3JvdW5kIHN1YnRyYWN0aW9u
#0#LCBEb3duc2NhbGluZw0KICAgICAgICBydW5fc3RlcCgiMi1pbWFnZV9wcm9jZXNzb3IucHkiLCBz
#0#dHIoaW1zX3BhdGgpLCBzdHIodGVtcF9tZXRhX2pzb24pLCBzdHIodGVtcF9kaXIpKQ0KICAgICAg
#0#ICANCiAgICAgICAgIyBTdGVwIDM6IENvbXB1dGUgdGh1bWJuYWlsIE1JUA0KICAgICAgICB3aXRo
#0#IG9wZW4odGVtcF9kaXIgLyAicHJvY2Vzc2luZ19tZXRhLmpzb24iLCAiciIsIGVuY29kaW5nPSJ1
#0#dGYtOCIpIGFzIGZtOg0KICAgICAgICAgICAgcHJvY19tZXRhID0ganNvbi5sb2FkKGZtKQ0KICAg
#0#ICAgICBidWlsZF90aHVtYm5haWwodGVtcF9kaXIsIGRhdGFzZXRfb3V0cHV0X2RpciwgcHJvY19t
#0#ZXRhKQ0KICAgICAgICANCiAgICAgICAgIyBTdGVwIDQ6IENodW5raW5nIDY0wrMgJiBQYWNrIGJ1
#0#aWxkaW5nDQogICAgICAgIHJ1bl9zdGVwKCIzLWNodW5rX3BhY2tlci5weSIsIHN0cih0ZW1wX2Rp
#0#ciksIHN0cihkYXRhc2V0X291dHB1dF9kaXIpKQ0KICAgICAgICANCiAgICAgICAgIyBTdGVwIDU6
#0#IENhdGFsb2cgbWV0YWRhdGEgKGRhdGFzZXQuanNvbiAvIG1ldGFkYXRhLmpzb24pDQogICAgICAg
#0#IHJ1bl9zdGVwKCI0LWNhdGFsb2dfZ2VuZXJhdG9yLnB5Iiwgc3RyKHRlbXBfZGlyKSwgc3RyKGRh
#0#dGFzZXRfb3V0cHV0X2RpcikpDQoNCiAgICAgICAgIyBTdGVwIDY6IGNlbGwgdHJhY2tpbmcsIHdo
#0#ZW4gdGhlIGFjcXVpc2l0aW9uIGhhcyBvbmUuIE9ubHkgYSB0aW1lbGFwc2UgY2FuIGNhcnJ5DQog
#0#ICAgICAgICMgdHJhamVjdG9yaWVzLCBhbmQgdGhlIHN0ZXAgbmVlZHMgdGhlIG1ldGFkYXRhLmpz
#0#b24gc3RlcCA0IGp1c3Qgd3JvdGUuDQogICAgICAgIGlmIG5fdGltZXBvaW50cyA+IDE6DQogICAg
#0#ICAgICAgICBhdHRhY2hfdHJhY2tpbmcoaW1zX3BhdGgsIGRhdGFzZXRfb3V0cHV0X2RpciwgdGVt
#0#cF9kaXIsIGRhdGFzZXRfbmFtZSwgdHJhY2tpbmcpDQoNCiAgICAgICAgIyBTdGVwIDcgKG9wdGlv
#0#bmFsKTogZG93bmxvYWQvIGJ1bmRsZSDigJQgYXJjaGl2ZSwgb3JpZ2luYWwgLmltcywgSW1hZ2VK
#0#IFRJRkYsDQogICAgICAgICMgcGVyLWNoYW5uZWwgTUlQcywgUkVBRE1FLiBSdW5zIGFmdGVyIHN0
#0#ZXAgNCBzbyBtZXRhZGF0YS5qc29uIGV4aXN0cy4gVGhlDQogICAgICAgICMgc291cmNlIC5pbXMg
#0#aXMgdGhlIG9uZSBiZWluZyBwcm9jZXNzZWQsIHNvIHBvaW50IHRoZSB0b29sIGF0IGl0cyBmb2xk
#0#ZXIuDQogICAgICAgIGlmIHdpdGhfZG93bmxvYWRzOg0KICAgICAgICAgICAgZGxfc2NyaXB0ID0g
#0#X3Jlc29sdmVfZG93bmxvYWRfc2NyaXB0KCkNCiAgICAgICAgICAgIGlmIGRsX3NjcmlwdCBpcyBO
#0#b25lOg0KICAgICAgICAgICAgICAgIHByaW50KF93YXJuKGYiICAgWyFdIHtET1dOTE9BRF9TQ1JJ
#0#UFRfTkFNRX0gaW50cm91dmFibGUg4oCUIGRvd25sb2FkLyBpZ25vcmUiKSkNCiAgICAgICAgICAg
#0#IGVsc2U6DQogICAgICAgICAgICAgICAgcnVuX3NjcmlwdChkbF9zY3JpcHQsDQogICAgICAgICAg
#0#ICAgICAgICAgICAgICAgICAiLS1kYXRhLXdlYiIsIHN0cihvdXRwdXRfcm9vdCksDQogICAgICAg
#0#ICAgICAgICAgICAgICAgICAgICAiLS1yYXctZGlyIiwgc3RyKGltc19wYXRoLnBhcmVudCksDQog
#0#ICAgICAgICAgICAgICAgICAgICAgICAgICAiLS1kYXRhc2V0cyIsIGRhdGFzZXRfbmFtZSwNCiAg
#0#ICAgICAgICAgICAgICAgICAgICAgICAgIGxhYmVsPSJkb3dubG9hZC8gKGFyY2hpdmUsIEltYWdl
#0#SiBUSUZGLCBNSVApIikNCg0KICAgICAgICAjIFRoZSBydW4gcHJvZHVjZWQgYSBjb21wbGV0ZSBi
#0#cmljayBzZXQ6IHRoZSBwcmV2aW91cyBvbmUgY2FuIGdvLg0KICAgICAgICBpZiBicmlja3Nfcm9s
#0#bGJhY2sgaXMgbm90IE5vbmUgYW5kIGJyaWNrc19yb2xsYmFjay5leGlzdHMoKToNCiAgICAgICAg
#0#ICAgIHNodXRpbC5ybXRyZWUoYnJpY2tzX3JvbGxiYWNrLCBpZ25vcmVfZXJyb3JzPVRydWUpDQoN
#0#CiAgICAgICAgZWxhcHNlZCA9IChkYXRldGltZS5ub3coKSAtIHQwKS50b3RhbF9zZWNvbmRzKCkN
#0#CiAgICAgICAgcHJpbnQoX29rKGYiICAgW09LXSB7ZGF0YXNldF9uYW1lfSB0ZXJtaW5lIGVuIHtl
#0#bGFwc2VkOi4wZn1zIikpDQogICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBlOg0KICAgICAgICBwcmlu
#0#dChfZXJyKGYiICAgW1hdIHtkYXRhc2V0X25hbWV9IDoge2V9IiksIGZpbGU9c3lzLnN0ZGVycikN
#0#CiAgICAgICAgdHJhY2ViYWNrLnByaW50X2V4YygpDQogICAgICAgICMgUHV0IHRoZSBwcmV2aW91
#0#cyBicmlja3MgYmFjazogYSBkYXRhc2V0IHRoYXQgd2FzIHNlcnZpbmcgYmVmb3JlIHRoaXMgcnVu
#0#IG11c3QNCiAgICAgICAgIyBzdGlsbCBiZSBzZXJ2aW5nIGFmdGVyIGl0IGZhaWxlZC4gQSBwYXJ0
#0#aWFsIHNldCBsZWZ0IGJ5IGFuIGludGVycnVwdGVkIHN0ZXAgMw0KICAgICAgICAjIGlzIHdvcnNl
#0#IHRoYW4gdGhlIG9sZCBvbmUg4oCUIGl0IGlzIGRpc2NhcmRlZC4NCiAgICAgICAgdHJ5Og0KICAg
#0#ICAgICAgICAgaWYgYnJpY2tzX3JvbGxiYWNrIGlzIG5vdCBOb25lIGFuZCBicmlja3Nfcm9sbGJh
#0#Y2suZXhpc3RzKCk6DQogICAgICAgICAgICAgICAgaWYgYnJpY2tzX2Rpci5leGlzdHMoKToNCiAg
#0#ICAgICAgICAgICAgICAgICAgc2h1dGlsLnJtdHJlZShicmlja3NfZGlyLCBpZ25vcmVfZXJyb3Jz
#0#PVRydWUpDQogICAgICAgICAgICAgICAgYnJpY2tzX3JvbGxiYWNrLnJlbmFtZShicmlja3NfZGly
#0#KQ0KICAgICAgICAgICAgICAgIHByaW50KF93YXJuKGYiICAgWzxdIGJyaWNrcy8gcHJlY2VkZW50
#0#IHJlc3RhdXJlIHBvdXIge2RhdGFzZXRfbmFtZX0iKSwgZmlsZT1zeXMuc3RkZXJyKQ0KICAgICAg
#0#ICBleGNlcHQgRXhjZXB0aW9uIGFzIHJlc3RvcmVfZXJyOg0KICAgICAgICAgICAgcHJpbnQoX2Vy
#0#cihmIiAgIFshXSByZXN0YXVyYXRpb24gZGUgYnJpY2tzLyBpbXBvc3NpYmxlIDoge3Jlc3RvcmVf
#0#ZXJyfSIpLCBmaWxlPXN5cy5zdGRlcnIpDQogICAgZmluYWxseToNCiAgICAgICAgIyBDbGVhbiB1
#0#cCB0ZW1wb3JhcnkgcHJvY2Vzc2luZyBiaW5hcnkgZmlsZXMgdG8gZnJlZSBzcGFjZS4NCiAgICAg
#0#ICAgIyBpZ25vcmVfZXJyb3JzOiBvbiBhIEN0cmwrQyB0ZWFyZG93biBhIGp1c3Qta2lsbGVkIHdv
#0#cmtlciBtYXkgc3RpbGwgaG9sZCBhDQogICAgICAgICMgaGFuZGxlIGZvciBhIGZldyBtcyDigJQg
#0#bmV2ZXIgbGV0IGNsZWFudXAgbWFzayB0aGUgaW50ZXJydXB0aW9uLg0KICAgICAgICBpZiB0ZW1w
#0#X2Rpci5leGlzdHMoKToNCiAgICAgICAgICAgIHNodXRpbC5ybXRyZWUodGVtcF9kaXIsIGlnbm9y
#0#ZV9lcnJvcnM9VHJ1ZSkNCg0KZGVmIG1haW4oKToNCiAgICBwYXJzZXIgPSBhcmdwYXJzZS5Bcmd1
#0#bWVudFBhcnNlcihkZXNjcmlwdGlvbj0iSVJJQkhNIE1pY3Jvc2NvcHkgUHJlcHJvY2Vzc2luZyBV
#0#bmlmaWVkIFBpcGVsaW5lIikNCiAgICBwYXJzZXIuYWRkX2FyZ3VtZW50KCItLWlucHV0IiwgcmVx
#0#dWlyZWQ9VHJ1ZSwgaGVscD0iSW5wdXQgZGlyZWN0b3J5IGNvbnRhaW5pbmcgcmF3IC5pbXMgZmls
#0#ZXMuIikNCiAgICBwYXJzZXIuYWRkX2FyZ3VtZW50KCItLW91dHB1dCIsIHJlcXVpcmVkPVRydWUs
#0#IGhlbHA9Ik91dHB1dCBEQVRBX1dFQiBkaXJlY3Rvcnkgb2YgdGhlIHdlYiBwbGF0Zm9ybS4iKQ0K
#0#ICAgIHBhcnNlci5hZGRfYXJndW1lbnQoIi0tb25seSIsIGRlZmF1bHQ9Tm9uZSwgaGVscD0iR2xv
#0#YiBwYXR0ZXJuIHRvIGZpbHRlciBmaWxlcyB0byBwcm9jZXNzIChlLmcuICcqRTgqJykuIikNCiAg
#0#ICBwYXJzZXIuYWRkX2FyZ3VtZW50KCItLXdpdGgtZG93bmxvYWRzIiwgYWN0aW9uPSJzdG9yZV90
#0#cnVlIiwNCiAgICAgICAgICAgICAgICAgICAgICAgIGhlbHA9IkFmdGVyIGVhY2ggZGF0YXNldCwg
#0#YWxzbyBidWlsZCBpdHMgZG93bmxvYWQvIGJ1bmRsZSAiDQogICAgICAgICAgICAgICAgICAgICAg
#0#ICAgICAgICIod2ViIGFyY2hpdmUsIG9yaWdpbmFsIC5pbXMsIEltYWdlSiBUSUZGLCBwZXItY2hh
#0#bm5lbCBNSVAsIFJFQURNRSkuIikNCiAgICBwYXJzZXIuYWRkX2FyZ3VtZW50KCItLXRyYWNraW5n
#0#IiwgZGVmYXVsdD0iYXV0byIsIG1ldGF2YXI9ImF1dG98b2ZmfEZJTEUiLA0KICAgICAgICAgICAg
#0#ICAgICAgICAgICAgaGVscD0iQ2VsbCB0cmFja2luZyBmb3IgdGltZWxhcHNlIGRhdGFzZXRzLiAn
#0#YXV0bycgKGRlZmF1bHQpIGxvb2tzIGZvciAiDQogICAgICAgICAgICAgICAgICAgICAgICAgICAg
#0#ICJhIC5pbWFyaXNfdHJhY2sgYmVzaWRlIHRoZSB2b2x1bWUsIHRoZW4gdGhlIEltYXJpcyBvYmpl
#0#Y3RzIGluc2lkZSAiDQogICAgICAgICAgICAgICAgICAgICAgICAgICAgICJ0aGUgLmltcyBpdHNl
#0#bGYsIHRoZW4gdGhlIGV4cG9ydGVkIC54bHMvLnhsc3ggc3RhdGlzdGljcy4gJ29mZicgIg0KICAg
#0#ICAgICAgICAgICAgICAgICAgICAgICAgICAic2tpcHMgaXQuIEEgcGF0aCBmb3JjZXMgdGhhdCBm
#0#aWxlIGZvciBldmVyeSBkYXRhc2V0IHByb2Nlc3NlZC4iKQ0KICAgIGFyZ3MgPSBwYXJzZXIucGFy
#0#c2VfYXJncygpDQoNCiAgICBpbnB1dF9kaXIgPSBQYXRoKGFyZ3MuaW5wdXQpDQogICAgb3V0cHV0
#0#X2RpciA9IFBhdGgoYXJncy5vdXRwdXQpDQoNCiAgICBpZiBub3QgaW5wdXRfZGlyLmlzX2Rpcigp
#0#Og0KICAgICAgICBzeXMuZXhpdChmIltGQVRBTF0gSW5wdXQgZGlyZWN0b3J5IG5vdCBmb3VuZDog
#0#e2lucHV0X2Rpcn0iKQ0KICAgICAgICANCiAgICBvdXRwdXRfZGlyLm1rZGlyKHBhcmVudHM9VHJ1
#0#ZSwgZXhpc3Rfb2s9VHJ1ZSkNCg0KICAgICMgR2xvYiBJTVMgZmlsZXMNCiAgICBpbXNfZmlsZXMg
#0#PSBzb3J0ZWQoaW5wdXRfZGlyLmdsb2IoIiouaW1zIikpDQogICAgaWYgYXJncy5vbmx5Og0KICAg
#0#ICAgICBpbXNfZmlsZXMgPSBbcCBmb3IgcCBpbiBpbXNfZmlsZXMgaWYgZm5tYXRjaC5mbm1hdGNo
#0#KHAubmFtZSwgYXJncy5vbmx5KV0NCg0KICAgIGlmIG5vdCBpbXNfZmlsZXM6DQogICAgICAgIHBy
#0#aW50KF93YXJuKGYiQXVjdW4gZmljaGllciAuaW1zIGNvcnJlc3BvbmRhbnQgZGFucyB7aW5wdXRf
#0#ZGlyfSIpKQ0KICAgICAgICBzeXMuZXhpdCgwKQ0KDQogICAgcHJpbnQoKQ0KICAgIHByaW50KF9o
#0#ZHIoIiAgUGlwZWxpbmUgZGUgcHJlcHJvY2Vzc2luZyAgIikgKyBfZGltKGYidntfX3ZlcnNpb25f
#0#X30iKSkNCiAgICBwcmludChfZGltKGYiICBzb3VyY2UgICAgICA6IHtpbnB1dF9kaXJ9IikpDQog
#0#ICAgcHJpbnQoX2RpbShmIiAgZGVzdGluYXRpb24gOiB7b3V0cHV0X2Rpcn0iKSkNCiAgICBwcmlu
#0#dChfZGltKGYiICBkYXRhc2V0cyAgICA6IHtsZW4oaW1zX2ZpbGVzKX0gICAoZmlsdHJlOiB7YXJn
#0#cy5vbmx5IG9yICcqJ30pIikpDQogICAgcHJpbnQoX2RpbShmIiAgZG93bmxvYWQvICAgOiB7J291
#0#aScgaWYgYXJncy53aXRoX2Rvd25sb2FkcyBlbHNlICdub24nfSIpKQ0KICAgIHByaW50KF9kaW0o
#0#ZiIgIHRyYWNraW5nICAgIDoge2FyZ3MudHJhY2tpbmd9IikpDQoNCiAgICAjIEdyYWNlZnVsIEN0
#0#cmwrQzogY29uZmlybSB3aXRoIHRoZSB1c2VyLCB0aGVuIHRlYXIgdGhlIHJ1bm5pbmcgc3RlcCBk
#0#b3duIGNsZWFubHkuDQogICAgX2luc3RhbGxfc2lnaW50X2hhbmRsZXIoKQ0KDQogICAgIyBPbmUg
#0#ZGF0YXNldCBhdCBhIHRpbWUgKGJvdW5kZWQgUkFNKSDigJQgZWFjaCBzdGVwIGFscmVhZHkgbXVs
#0#dGl0aHJlYWRzIGludGVybmFsbHkuDQogICAgaW50ZXJydXB0ZWQgPSBGYWxzZQ0KICAgIGZvciBp
#0#LCBpbXNfZmlsZSBpbiBlbnVtZXJhdGUoaW1zX2ZpbGVzKToNCiAgICAgICAgdHJ5Og0KICAgICAg
#0#ICAgICAgcHJvY2Vzc19pbXNfZmlsZShpbXNfZmlsZSwgb3V0cHV0X2RpciwgaSArIDEsIGxlbihp
#0#bXNfZmlsZXMpLA0KICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoX2Rvd25sb2Fkcz1h
#0#cmdzLndpdGhfZG93bmxvYWRzLCB0cmFja2luZz1hcmdzLnRyYWNraW5nKQ0KICAgICAgICBleGNl
#0#cHQgS2V5Ym9hcmRJbnRlcnJ1cHQ6DQogICAgICAgICAgICBpbnRlcnJ1cHRlZCA9IFRydWUNCiAg
#0#ICAgICAgICAgIGJyZWFrDQogICAgICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZXhjOg0KICAgICAg
#0#ICAgICAgcHJpbnQoX2VycihmIiAgIFtYXSB7aW1zX2ZpbGUubmFtZX0gOiB7ZXhjfSIpKQ0KDQog
#0#ICAgaWYgaW50ZXJydXB0ZWQ6DQogICAgICAgICMgUmVtb3ZlIGFueSBoYWxmLXdyaXR0ZW4gdGVt
#0#cCBmb2xkZXIgbGVmdCBieSB0aGUgYWJvcnRlZCBkYXRhc2V0Lg0KICAgICAgICBmb3Igc3RyYXkg
#0#aW4gb3V0cHV0X2Rpci5nbG9iKCIudGVtcF9wcmVwcm9jZXNzXyoiKToNCiAgICAgICAgICAgIHNo
#0#dXRpbC5ybXRyZWUoc3RyYXksIGlnbm9yZV9lcnJvcnM9VHJ1ZSkNCiAgICAgICAgcHJpbnQoKQ0K
#0#ICAgICAgICBwcmludChfd2FybigiICBQaXBlbGluZSBpbnRlcnJvbXB1IHBhciBsJ3V0aWxpc2F0
#0#ZXVyIChDdHJsK0MpLiBFdGF0IG5ldHRveWUuIikpDQogICAgICAgIHN5cy5leGl0KDEzMCkNCg0K
#0#ICAgIHByaW50KCkNCiAgICBwcmludChfb2soIiAgUGlwZWxpbmUgdGVybWluZS4iKSkNCg0KaWYg
#0#X19uYW1lX18gPT0gIl9fbWFpbl9fIjoNCiAgICB0cnk6DQogICAgICAgIG1haW4oKQ0KICAgIGV4
#0#Y2VwdCBLZXlib2FyZEludGVycnVwdDoNCiAgICAgICAgIyBDdHJsK0MgY29uZmlybWVkIG91dHNp
#0#ZGUgYSBkYXRhc2V0IChlLmcuIGJldHdlZW4gc3RlcHMpIOKAlCBleGl0IGNsZWFubHkuDQogICAg
#0#ICAgIHByaW50KF93YXJuKCJcblshXSBQaXBlbGluZSBhcnJldGUuIiksIGZpbGU9c3lzLnN0ZGVy
#0#cikNCiAgICAgICAgc3lzLmV4aXQoMTMwKQ0K
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
:: ---- [3] 3-chunk_packer.py (16059 octets) ----
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
#3#ZGlyIGlzICcnIGZvciBhIHNpbmdsZS10aW1lcG9pbnQgKGZpeGVkKSBkYXRhc2V0IOKAlCB0aGUg
#3#cGFja3MgdGhlbiBsYW5kCiAgICBkaXJlY3RseSB1bmRlciBicmlja3MvIGFuZCB0aGUgb3V0cHV0
#3#IGlzIGJ5dGUtaWRlbnRpY2FsIHRvIHRoZSBwcmUtNEQgcGlwZWxpbmUuCiAgICBGb3IgYSB0aW1l
#3#bGFwc2UgaXQgaXMgJ3QwMDAnLCAndDAwMScsIOKApiBhbmQgZWFjaCB0aW1lcG9pbnQgb3ducyBh
#3#IHNlbGYtY29udGFpbmVkCiAgICBwYWNrIHRyZWUgd2hvc2UgYnJpY2tUb1BhY2sgdXJscyBzdGF5
#3#IHJlbGF0aXZlIHRvIHRoYXQgc3ViLWRpcmVjdG9yeSwgd2hpY2ggaXMKICAgIGV4YWN0bHkgd2hh
#3#dCB0aGUgdmlld2VyIGFwcGVuZHMgdG8gdGhlIGJyaWNrcyBiYXNlIHBhdGguCiAgICAiIiIKICAg
#3#IHRwX3Jvb3QgPSBicmlja3NfZGlyIC8gdHBfc3ViZGlyIGlmIHRwX3N1YmRpciBlbHNlIGJyaWNr
#3#c19kaXIKICAgIHRwX3Jvb3QubWtkaXIocGFyZW50cz1UcnVlLCBleGlzdF9vaz1UcnVlKQoKICAg
#3#IEJSSUNLX1NJWkUgPSA2NAogICAgQ0hVTktTX1BFUl9QQUNLID0gMTI4CgogICAgYnJpY2tfdG9f
#3#cGFjayA9IHt9CiAgICBwYWNrX2hhc2hlcyA9IHt9CiAgICBsZXZlbHNfbWFuaWZlc3QgPSBbXQoK
#3#ICAgIGZvciBsaSBpbiBsb2RfbGV2ZWxzOgogICAgICAgIGxvZF9udW0gPSBsaVsibG9kIl0KICAg
#3#ICAgICBXLCBILCBEID0gbGlbIndpZHRoIl0sIGxpWyJoZWlnaHQiXSwgbGlbImRlcHRoIl0KCiAg
#3#ICAgICAgbnggPSBtYXRoLmNlaWwoVyAvIEJSSUNLX1NJWkUpCiAgICAgICAgbnkgPSBtYXRoLmNl
#3#aWwoSCAvIEJSSUNLX1NJWkUpCiAgICAgICAgbnogPSBtYXRoLmNlaWwoRCAvIEJSSUNLX1NJWkUp
#3#CgogICAgICAgICMgQnVpbGQgbG9naWNhbCBncmlkIG9mIGNodW5rcyBmb3IgdGhpcyBsZXZlbAog
#3#ICAgICAgIGNodW5rc19ncmlkID0gW10KICAgICAgICBmb3IgYnogaW4gcmFuZ2UobnopOgogICAg
#3#ICAgICAgICBmb3IgYnkgaW4gcmFuZ2UobnkpOgogICAgICAgICAgICAgICAgZm9yIGJ4IGluIHJh
#3#bmdlKG54KToKICAgICAgICAgICAgICAgICAgICBveCwgb3ksIG96ID0gYnggKiBCUklDS19TSVpF
#3#LCBieSAqIEJSSUNLX1NJWkUsIGJ6ICogQlJJQ0tfU0laRQogICAgICAgICAgICAgICAgICAgIGV3
#3#ID0gbWluKEJSSUNLX1NJWkUsIFcgLSBveCkKICAgICAgICAgICAgICAgICAgICBlaCA9IG1pbihC
#3#UklDS19TSVpFLCBIIC0gb3kpCiAgICAgICAgICAgICAgICAgICAgZWQgPSBtaW4oQlJJQ0tfU0la
#3#RSwgRCAtIG96KQogICAgICAgICAgICAgICAgICAgIGNodW5rc19ncmlkLmFwcGVuZCh7CiAgICAg
#3#ICAgICAgICAgICAgICAgICAgICJieCI6IGJ4LAogICAgICAgICAgICAgICAgICAgICAgICAiYnki
#3#OiBieSwKICAgICAgICAgICAgICAgICAgICAgICAgImJ6IjogYnosCiAgICAgICAgICAgICAgICAg
#3#ICAgICAgICJtaW4iOiBbaW50KG94KSwgaW50KG95KSwgaW50KG96KV0sCiAgICAgICAgICAgICAg
#3#ICAgICAgICAgICJtYXgiOiBbaW50KG94ICsgZXcpLCBpbnQob3kgKyBlaCksIGludChveiArIGVk
#3#KV0sCiAgICAgICAgICAgICAgICAgICAgICAgICJ2YWxpZFZveGVsQ291bnQiOiBpbnQoZXcgKiBl
#3#aCAqIGVkKQogICAgICAgICAgICAgICAgICAgIH0pCgogICAgICAgICMgRW1wdHktc3BhY2Ugc2tp
#3#cHBpbmcgaXMgZGVjaWRlZCBwZXIgdGltZXBvaW50OiBjZWxscyBtb3ZlLCBzbyB0aGUgb2NjdXBp
#3#ZWQKICAgICAgICAjIGJyaWNrIHNldCBsZWdpdGltYXRlbHkgZGlmZmVycyBmcm9tIG9uZSBmcmFt
#3#ZSB0byB0aGUgbmV4dC4KICAgICAgICBCQUNLR1JPVU5EX1RIUkVTSE9MRCA9IDAKICAgICAgICBp
#3#c19jb3JlID0gW0ZhbHNlXSAqIGxlbihjaHVua3NfZ3JpZCkKICAgICAgICBmb3IgY19pZHggaW4g
#3#cmFuZ2Uobl9jaCk6CiAgICAgICAgICAgIGJpbl9maWxlID0gdGVtcF9kaXIgLyBmInR7dF9pZHg6
#3#MDNkfV9je2NfaWR4fV9sb2R7bG9kX251bX0uYmluIgogICAgICAgICAgICBpZiBub3QgYmluX2Zp
#3#bGUuZXhpc3RzKCk6CiAgICAgICAgICAgICAgICBjb250aW51ZQogICAgICAgICAgICB2b2x1bWVf
#3#ZGF0YSA9IG5wLm1lbW1hcCgKICAgICAgICAgICAgICAgIHN0cihiaW5fZmlsZSksCiAgICAgICAg
#3#ICAgICAgICBkdHlwZT1ucC51aW50OCwKICAgICAgICAgICAgICAgIG1vZGU9InIiLAogICAgICAg
#3#ICAgICAgICAgc2hhcGU9KEQsIEgsIFcpCiAgICAgICAgICAgICkKICAgICAgICAgICAgZm9yIGks
#3#IGNoIGluIGVudW1lcmF0ZShjaHVua3NfZ3JpZCk6CiAgICAgICAgICAgICAgICBveCwgb3ksIG96
#3#ID0gY2hbIm1pbiJdCiAgICAgICAgICAgICAgICBleCwgZXksIGV6ID0gY2hbIm1heCJdCiAgICAg
#3#ICAgICAgICAgICBjaHVua19zbGljZSA9IHZvbHVtZV9kYXRhW296OmV6LCBveTpleSwgb3g6ZXhd
#3#CiAgICAgICAgICAgICAgICBpZiBjaHVua19zbGljZS5zaXplID4gMDoKICAgICAgICAgICAgICAg
#3#ICAgICBpZiBucC5tYXgoY2h1bmtfc2xpY2UpID4gQkFDS0dST1VORF9USFJFU0hPTEQ6CiAgICAg
#3#ICAgICAgICAgICAgICAgICAgIGlzX2NvcmVbaV0gPSBUcnVlCiAgICAgICAgICAgIGRlbCB2b2x1
#3#bWVfZGF0YQoKICAgICAgICBjb3JlX2Nvb3JkcyA9IHNldCgpCiAgICAgICAgZm9yIGksIGNoIGlu
#3#IGVudW1lcmF0ZShjaHVua3NfZ3JpZCk6CiAgICAgICAgICAgIGlmIGlzX2NvcmVbaV06CiAgICAg
#3#ICAgICAgICAgICBjb3JlX2Nvb3Jkcy5hZGQoKGNoWyJieCJdLCBjaFsiYnkiXSwgY2hbImJ6Il0p
#3#KQoKICAgICAgICBhY3RpdmVfY29vcmRzID0gc2V0KCkKICAgICAgICBmb3IgKGJ4LCBieSwgYnop
#3#IGluIGNvcmVfY29vcmRzOgogICAgICAgICAgICBmb3IgZHggaW4gKC0xLCAwLCAxKToKICAgICAg
#3#ICAgICAgICAgIGZvciBkeSBpbiAoLTEsIDAsIDEpOgogICAgICAgICAgICAgICAgICAgIGZvciBk
#3#eiBpbiAoLTEsIDAsIDEpOgogICAgICAgICAgICAgICAgICAgICAgICBueF9jb29yZCA9IGJ4ICsg
#3#ZHgKICAgICAgICAgICAgICAgICAgICAgICAgbnlfY29vcmQgPSBieSArIGR5CiAgICAgICAgICAg
#3#ICAgICAgICAgICAgIG56X2Nvb3JkID0gYnogKyBkegogICAgICAgICAgICAgICAgICAgICAgICBp
#3#ZiAwIDw9IG54X2Nvb3JkIDwgbnggYW5kIDAgPD0gbnlfY29vcmQgPCBueSBhbmQgMCA8PSBuel9j
#3#b29yZCA8IG56OgogICAgICAgICAgICAgICAgICAgICAgICAgICAgYWN0aXZlX2Nvb3Jkcy5hZGQo
#3#KG54X2Nvb3JkLCBueV9jb29yZCwgbnpfY29vcmQpKQoKICAgICAgICBhY3RpdmVfY2h1bmtzX2dy
#3#aWQgPSBbY2ggZm9yIGNoIGluIGNodW5rc19ncmlkIGlmIChjaFsiYngiXSwgY2hbImJ5Il0sIGNo
#3#WyJieiJdKSBpbiBhY3RpdmVfY29vcmRzXQogICAgICAgIHByaW50KGYiW1BBQ0tFUl0ge3RwX3N1
#3#YmRpciBvciAndDAwMCd9IExPRCB7bG9kX251bX06IEdyaWQge254fXh7bnl9eHtuen0gIgogICAg
#3#ICAgICAgICAgIGYiKHtsZW4oY2h1bmtzX2dyaWQpfSBjaHVua3MsIHtsZW4oYWN0aXZlX2NodW5r
#3#c19ncmlkKX0gYWN0aXZlIGFmdGVyIHRocmVzaG9sZGluZykiKQoKICAgICAgICAjIFdlIHdpbGwg
#3#dHJhY2sgb2NjdXBhbmN5IHVuaW9uIGFjcm9zcyBhbGwgY2hhbm5lbHMgZm9yIHRoZSBhY3RpdmUg
#3#Y2h1bmsgZ3JpZAogICAgICAgIG9jY3VwYW5jeV91bmlvbiA9IFswLjBdICogbGVuKGFjdGl2ZV9j
#3#aHVua3NfZ3JpZCkKCiAgICAgICAgIyBGb3IgZWFjaCBjaGFubmVsLCBvcGVuIHRoZSBwcm9jZXNz
#3#ZWQgcmF3IGJpbmFyeSB2b2x1bWUKICAgICAgICBmb3IgY19pZHggaW4gcmFuZ2Uobl9jaCk6CiAg
#3#ICAgICAgICAgIGJpbl9maWxlID0gdGVtcF9kaXIgLyBmInR7dF9pZHg6MDNkfV9je2NfaWR4fV9s
#3#b2R7bG9kX251bX0uYmluIgoKICAgICAgICAgICAgaWYgbm90IGJpbl9maWxlLmV4aXN0cygpOgog
#3#ICAgICAgICAgICAgICAgcHJpbnQoZiJbV0FSTklOR10gUHJvY2Vzc2VkIGZpbGUgbm90IGZvdW5k
#3#OiB7YmluX2ZpbGV9IikKICAgICAgICAgICAgICAgIGNvbnRpbnVlCgogICAgICAgICAgICAjIE1l
#3#bW9yeSBtYXAgdGhlIHZvbHVtZQogICAgICAgICAgICB2b2x1bWVfZGF0YSA9IG5wLm1lbW1hcCgK
#3#ICAgICAgICAgICAgICAgIHN0cihiaW5fZmlsZSksCiAgICAgICAgICAgICAgICBkdHlwZT1ucC51
#3#aW50OCwKICAgICAgICAgICAgICAgIG1vZGU9InIiLAogICAgICAgICAgICAgICAgc2hhcGU9KEQs
#3#IEgsIFcpCiAgICAgICAgICAgICkKCiAgICAgICAgICAgICMgU2V0dXAgcGFja2VyIGZvciB0aGlz
#3#IExPRCArIENoYW5uZWwKICAgICAgICAgICAgY2hhbm5lbF9sb2RfZGlyID0gdHBfcm9vdCAvIGYi
#3#bG9ke2xvZF9udW19IiAvIGYiY3tjX2lkeH0iCiAgICAgICAgICAgIGNoYW5uZWxfbG9kX2Rpci5t
#3#a2RpcihwYXJlbnRzPVRydWUsIGV4aXN0X29rPVRydWUpCgogICAgICAgICAgICBjdXJyZW50X3Bh
#3#Y2tfaWR4ID0gMAogICAgICAgICAgICBjdXJyZW50X3BhY2tfZmlsZSA9IE5vbmUKICAgICAgICAg
#3#ICAgY3VycmVudF9wYWNrX29mZnNldCA9IDAKICAgICAgICAgICAgY2h1bmtzX2luX2N1cnJlbnRf
#3#cGFjayA9IDAKCiAgICAgICAgICAgIGRlZiBnZXRfcGFja19maWxlKGlkeCk6CiAgICAgICAgICAg
#3#ICAgICBwX2ZpbGUgPSBjaGFubmVsX2xvZF9kaXIgLyBmInBhY2tfe2lkeDowMmR9LmJpbiIKICAg
#3#ICAgICAgICAgICAgIHJldHVybiBwX2ZpbGUsIG9wZW4ocF9maWxlLCAid2IiKQoKICAgICAgICAg
#3#ICAgcGFja19maWxlX3BhdGgsIGN1cnJlbnRfcGFja19maWxlID0gZ2V0X3BhY2tfZmlsZShjdXJy
#3#ZW50X3BhY2tfaWR4KQoKICAgICAgICAgICAgIyBQcmVwYXJlIGFyZ3VtZW50cyBmb3IgbXVsdGlw
#3#cm9jZXNzaW5nCiAgICAgICAgICAgIHRhc2tzID0gW10KICAgICAgICAgICAgZm9yIGksIGNoIGlu
#3#IGVudW1lcmF0ZShhY3RpdmVfY2h1bmtzX2dyaWQpOgogICAgICAgICAgICAgICAgY2hfbWV0YSA9
#3#IHsiaWR4IjogaSwgImJ4IjogY2hbImJ4Il0sICJieSI6IGNoWyJieSJdLCAiYnoiOiBjaFsiYnoi
#3#XSwgInZhbGlkVm94ZWxDb3VudCI6IGNoWyJ2YWxpZFZveGVsQ291bnQiXX0KICAgICAgICAgICAg
#3#ICAgIG94LCBveSwgb3ogPSBjaFsibWluIl0KICAgICAgICAgICAgICAgIGV4LCBleSwgZXogPSBj
#3#aFsibWF4Il0KICAgICAgICAgICAgICAgIGNodW5rX2RhdGEgPSBucC5jb3B5KHZvbHVtZV9kYXRh
#3#W296OmV6LCBveTpleSwgb3g6ZXhdKQogICAgICAgICAgICAgICAgdGFza3MuYXBwZW5kKChjaHVu
#3#a19kYXRhLCBjaF9tZXRhLCBCUklDS19TSVpFKSkKCiAgICAgICAgICAgIGZyb20gdHFkbSBpbXBv
#3#cnQgdHFkbQogICAgICAgICAgICAjIGV4ZWN1dG9yLm1hcCBwcmVzZXJ2ZXMgdGhlIG9yZGVyIG9m
#3#IGFjdGl2ZV9jaHVua3NfZ3JpZAogICAgICAgICAgICBmb3IgcmVzdWx0IGluIHRxZG0oZXhlY3V0
#3#b3IubWFwKHByb2Nlc3NfY2h1bmssIHRhc2tzKSwgdG90YWw9bGVuKHRhc2tzKSwKICAgICAgICAg
#3#ICAgICAgICAgICAgICAgICAgICAgIGRlc2M9IkNvbXByZXNzaW5nIFdlYlAiLCBsZWF2ZT1GYWxz
#3#ZSwgYXNjaWk9VHJ1ZSwgbWluaW50ZXJ2YWw9Mi4wKToKICAgICAgICAgICAgICAgIGlkeCwgb2Nj
#3#LCBpc19ub25fZW1wdHksIGNvbXByZXNzZWRfYnl0ZXMgPSByZXN1bHQKICAgICAgICAgICAgICAg
#3#IG9jY3VwYW5jeV91bmlvbltpZHhdID0gbWF4KG9jY3VwYW5jeV91bmlvbltpZHhdLCBvY2MpCgog
#3#ICAgICAgICAgICAgICAgaWYgaXNfbm9uX2VtcHR5OgogICAgICAgICAgICAgICAgICAgICMgQ2hl
#3#Y2sgaWYgd2UgbmVlZCB0byByb2xsIG92ZXIgdG8gYSBuZXcgcGFjayBmaWxlCiAgICAgICAgICAg
#3#ICAgICAgICAgaWYgY2h1bmtzX2luX2N1cnJlbnRfcGFjayA+PSBDSFVOS1NfUEVSX1BBQ0s6CiAg
#3#ICAgICAgICAgICAgICAgICAgICAgIGN1cnJlbnRfcGFja19maWxlLmNsb3NlKCkKICAgICAgICAg
#3#ICAgICAgICAgICAgICAgIyBSZWNvcmQgaGFzaCBvZiBjb21wbGV0ZWQgcGFjawogICAgICAgICAg
#3#ICAgICAgICAgICAgICBwYWNrX3JlbF9wYXRoID0gcGFja19maWxlX3BhdGgucmVsYXRpdmVfdG8o
#3#dHBfcm9vdCkuYXNfcG9zaXgoKQogICAgICAgICAgICAgICAgICAgICAgICBwYWNrX2hhc2hlc1tw
#3#YWNrX3JlbF9wYXRoXSA9IGhhc2hsaWIuc2hhMjU2KHBhY2tfZmlsZV9wYXRoLnJlYWRfYnl0ZXMo
#3#KSkuaGV4ZGlnZXN0KCkKCiAgICAgICAgICAgICAgICAgICAgICAgIGN1cnJlbnRfcGFja19pZHgg
#3#Kz0gMQogICAgICAgICAgICAgICAgICAgICAgICBwYWNrX2ZpbGVfcGF0aCwgY3VycmVudF9wYWNr
#3#X2ZpbGUgPSBnZXRfcGFja19maWxlKGN1cnJlbnRfcGFja19pZHgpCiAgICAgICAgICAgICAgICAg
#3#ICAgICAgIGN1cnJlbnRfcGFja19vZmZzZXQgPSAwCiAgICAgICAgICAgICAgICAgICAgICAgIGNo
#3#dW5rc19pbl9jdXJyZW50X3BhY2sgPSAwCgogICAgICAgICAgICAgICAgICAgICMgV3JpdGUgY29t
#3#cHJlc3NlZCBieXRlcyB0byBjdXJyZW50IHBhY2sgZmlsZQogICAgICAgICAgICAgICAgICAgIGN1
#3#cnJlbnRfcGFja19maWxlLndyaXRlKGNvbXByZXNzZWRfYnl0ZXMpCgogICAgICAgICAgICAgICAg
#3#ICAgICMgU2F2ZSBtYXBwaW5nIGluIGJyaWNrVG9QYWNrCiAgICAgICAgICAgICAgICAgICAgY2gg
#3#PSBhY3RpdmVfY2h1bmtzX2dyaWRbaWR4XQogICAgICAgICAgICAgICAgICAgIGJ4LCBieSwgYnog
#3#PSBjaFsiYngiXSwgY2hbImJ5Il0sIGNoWyJieiJdCiAgICAgICAgICAgICAgICAgICAgYnJpY2tf
#3#cmVsX2tleSA9IGYibG9ke2xvZF9udW19L2N7Y19pZHh9L3h7Yng6MDNkfV95e2J5OjAzZH1fenti
#3#ejowM2R9LndlYnAiCiAgICAgICAgICAgICAgICAgICAgcGFja19yZWxfcGF0aCA9IHBhY2tfZmls
#3#ZV9wYXRoLnJlbGF0aXZlX3RvKHRwX3Jvb3QpLmFzX3Bvc2l4KCkKCiAgICAgICAgICAgICAgICAg
#3#ICAgYnJpY2tfdG9fcGFja1ticmlja19yZWxfa2V5XSA9IHsKICAgICAgICAgICAgICAgICAgICAg
#3#ICAgInVybCI6IHBhY2tfcmVsX3BhdGgsCiAgICAgICAgICAgICAgICAgICAgICAgICJvZmZzZXQi
#3#OiBpbnQoY3VycmVudF9wYWNrX29mZnNldCksCiAgICAgICAgICAgICAgICAgICAgICAgICJsZW5n
#3#dGgiOiBpbnQobGVuKGNvbXByZXNzZWRfYnl0ZXMpKQogICAgICAgICAgICAgICAgICAgIH0KCiAg
#3#ICAgICAgICAgICAgICAgICAgY3VycmVudF9wYWNrX29mZnNldCArPSBsZW4oY29tcHJlc3NlZF9i
#3#eXRlcykKICAgICAgICAgICAgICAgICAgICBjaHVua3NfaW5fY3VycmVudF9wYWNrICs9IDEKCiAg
#3#ICAgICAgICAgICMgQ2xvc2UgdGhlIGZpbmFsIHBhY2sgZmlsZSBmb3IgdGhpcyBjaGFubmVsCiAg
#3#ICAgICAgICAgIGlmIGN1cnJlbnRfcGFja19maWxlOgogICAgICAgICAgICAgICAgY3VycmVudF9w
#3#YWNrX2ZpbGUuY2xvc2UoKQogICAgICAgICAgICAgICAgcGFja19yZWxfcGF0aCA9IHBhY2tfZmls
#3#ZV9wYXRoLnJlbGF0aXZlX3RvKHRwX3Jvb3QpLmFzX3Bvc2l4KCkKICAgICAgICAgICAgICAgIHBh
#3#Y2tfaGFzaGVzW3BhY2tfcmVsX3BhdGhdID0gaGFzaGxpYi5zaGEyNTYocGFja19maWxlX3BhdGgu
#3#cmVhZF9ieXRlcygpKS5oZXhkaWdlc3QoKQoKICAgICAgICAgICAgIyBDbG9zZSBtZW1tYXAgZmls
#3#ZSBoYW5kbGUKICAgICAgICAgICAgZGVsIHZvbHVtZV9kYXRhCgogICAgICAgICMgQnVpbGQgbGV2
#3#ZWwgY2h1bmtzIGxpc3QgZm9yIG1hbmlmZXN0CiAgICAgICAgbWFuaWZlc3RfY2h1bmtzID0gW10K
#3#ICAgICAgICBub25fZW1wdHlfY291bnQgPSAwCiAgICAgICAgZm9yIGksIGNoIGluIGVudW1lcmF0
#3#ZShhY3RpdmVfY2h1bmtzX2dyaWQpOgogICAgICAgICAgICBpc19ub25fZW1wdHkgPSBvY2N1cGFu
#3#Y3lfdW5pb25baV0gPiBFU1NfTUlOX09DQ1VQQU5DWQogICAgICAgICAgICBpZiBpc19ub25fZW1w
#3#dHk6CiAgICAgICAgICAgICAgICBub25fZW1wdHlfY291bnQgKz0gMQogICAgICAgICAgICBtYW5p
#3#ZmVzdF9jaHVua3MuYXBwZW5kKHsKICAgICAgICAgICAgICAgICJpZCI6IGYie2NoWydieiddfV97
#3#Y2hbJ2J5J119X3tjaFsnYngnXX0iLAogICAgICAgICAgICAgICAgIm1pbiI6IGNoWyJtaW4iXSwK
#3#ICAgICAgICAgICAgICAgICJtYXgiOiBjaFsibWF4Il0sCiAgICAgICAgICAgICAgICAib2NjdXBp
#3#ZWRSYXRpbyI6IHJvdW5kKG9jY3VwYW5jeV91bmlvbltpXSwgNiksCiAgICAgICAgICAgICAgICAi
#3#bm9uRW1wdHkiOiBpc19ub25fZW1wdHkKICAgICAgICAgICAgfSkKCiAgICAgICAgbGV2ZWxzX21h
#3#bmlmZXN0LmFwcGVuZCh7CiAgICAgICAgICAgICJsZXZlbCI6IGxvZF9udW0sCiAgICAgICAgICAg
#3#ICJzY2FsZSI6IDEuMCAvICgyICoqIGxvZF9udW0pLAogICAgICAgICAgICAiZGltZW5zaW9ucyI6
#3#IHsieCI6IFcsICJ5IjogSCwgInoiOiBEfSwKICAgICAgICAgICAgImJyaWNrU2l6ZSI6IEJSSUNL
#3#X1NJWkUsCiAgICAgICAgICAgICJncmlkU2l6ZSI6IHsieCI6IG54LCAieSI6IG55LCAieiI6IG56
#3#fSwKICAgICAgICAgICAgImJyaWNrQ291bnQiOiBsZW4oY2h1bmtzX2dyaWQpLAogICAgICAgICAg
#3#ICAiY2h1bmtzIjogbWFuaWZlc3RfY2h1bmtzLAogICAgICAgICAgICAibm9uRW1wdHlDb3VudCI6
#3#IG5vbl9lbXB0eV9jb3VudAogICAgICAgIH0pCgogICAgdHJhbnNwb3J0ID0gewogICAgICAgICJt
#3#b2RlIjogInBhY2tzIiwKICAgICAgICAiZW5jb2RpbmciOiAid2VicC1sb3NzbGVzcyIsCiAgICAg
#3#ICAgInBhY2tTaXplIjogQ0hVTktTX1BFUl9QQUNLLAogICAgICAgICJicmlja1RvUGFjayI6IGJy
#3#aWNrX3RvX3BhY2ssCiAgICAgICAgInBhY2tIYXNoZXMiOiBwYWNrX2hhc2hlcwogICAgfQogICAg
#3#cmV0dXJuIGxldmVsc19tYW5pZmVzdCwgdHJhbnNwb3J0CgoKZGVmIGJ1aWxkX3BhY2tzKHRlbXBf
#3#ZGlyOiBQYXRoLCBvdXRwdXRfZGlyOiBQYXRoKToKICAgIHdpdGggb3Blbih0ZW1wX2RpciAvICJw
#3#cm9jZXNzaW5nX21ldGEuanNvbiIsICJyIiwgZW5jb2Rpbmc9InV0Zi04IikgYXMgZm06CiAgICAg
#3#ICAgcHJvY19tZXRhID0ganNvbi5sb2FkKGZtKQoKICAgIGxvZF9sZXZlbHMgPSBwcm9jX21ldGFb
#3#ImxvZF9sZXZlbHMiXQogICAgbl9jaCA9IHByb2NfbWV0YVsibl9jaGFubmVscyJdCiAgICBuX3Rw
#3#ID0gcHJvY19tZXRhWyJuX3RpbWVwb2ludHMiXQogICAgdm94ZWxfc2l6ZSA9IHByb2NfbWV0YVsi
#3#dm94ZWxfc2l6ZSJdCiAgICBjaGFubmVsX25hbWVzID0gcHJvY19tZXRhWyJjaGFubmVsX25hbWVz
#3#Il0KCiAgICBicmlja3NfZGlyID0gb3V0cHV0X2RpciAvICJicmlja3MiCiAgICBicmlja3NfZGly
#3#Lm1rZGlyKHBhcmVudHM9VHJ1ZSwgZXhpc3Rfb2s9VHJ1ZSkKCiAgICBCUklDS19TSVpFID0gNjQK
#3#ICAgIENIVU5LU19QRVJfUEFDSyA9IDEyOAoKICAgIGlzX3RpbWVsYXBzZSA9IG5fdHAgPiAxCgog
#3#ICAgIyBPbmUgcHJvY2VzcyBwb29sIGZvciB0aGUgd2hvbGUgcnVuOiBhIHRpbWVsYXBzZSBwYWNr
#3#cyBuX3RwIHggbl9sb2QgeCBuX2NoCiAgICAjIGJhdGNoZXMgYW5kIHJlLXNwYXduaW5nIGEgcG9v
#3#bCBmb3IgZWFjaCB3b3VsZCBkb21pbmF0ZSB0aGUgcnVudGltZS4KICAgIHdpdGggUHJvY2Vzc1Bv
#3#b2xFeGVjdXRvcihtYXhfd29ya2Vycz1vcy5jcHVfY291bnQoKSkgYXMgZXhlY3V0b3I6CiAgICAg
#3#ICAgaWYgbm90IGlzX3RpbWVsYXBzZToKICAgICAgICAgICAgbGV2ZWxzX21hbmlmZXN0LCB0cmFu
#3#c3BvcnQgPSBfcGFja190aW1lcG9pbnQoCiAgICAgICAgICAgICAgICB0ZW1wX2RpciwgYnJpY2tz
#3#X2RpciwgMCwgbG9kX2xldmVscywgbl9jaCwgZXhlY3V0b3IsICIiCiAgICAgICAgICAgICkKICAg
#3#ICAgICAgICAgdGltZXBvaW50c19tYW5pZmVzdCA9IE5vbmUKICAgICAgICBlbHNlOgogICAgICAg
#3#ICAgICB0aW1lcG9pbnRzX21hbmlmZXN0ID0ge30KICAgICAgICAgICAgbGV2ZWxzX21hbmlmZXN0
#3#ID0gTm9uZQogICAgICAgICAgICB0cmFuc3BvcnQgPSBOb25lCiAgICAgICAgICAgIGZvciB0X2lk
#3#eCBpbiByYW5nZShuX3RwKToKICAgICAgICAgICAgICAgIGtleSA9IGYidHt0X2lkeDowM2R9Igog
#3#ICAgICAgICAgICAgICAgcHJpbnQoZiJbUEFDS0VSXSA9PT0gdGltZXBvaW50IHt0X2lkeCArIDF9
#3#L3tuX3RwfSAoe2tleX0pID09PSIpCiAgICAgICAgICAgICAgICB0cF9sZXZlbHMsIHRwX3RyYW5z
#3#cG9ydCA9IF9wYWNrX3RpbWVwb2ludCgKICAgICAgICAgICAgICAgICAgICB0ZW1wX2RpciwgYnJp
#3#Y2tzX2RpciwgdF9pZHgsIGxvZF9sZXZlbHMsIG5fY2gsIGV4ZWN1dG9yLCBrZXkKICAgICAgICAg
#3#ICAgICAgICkKICAgICAgICAgICAgICAgIHRpbWVwb2ludHNfbWFuaWZlc3Rba2V5XSA9IHsKICAg
#3#ICAgICAgICAgICAgICAgICAicGF0aCI6IGtleSwKICAgICAgICAgICAgICAgICAgICAiY2hhbm5l
#3#bHMiOiBuX2NoLAogICAgICAgICAgICAgICAgICAgICJsZXZlbHMiOiB0cF9sZXZlbHMsCiAgICAg
#3#ICAgICAgICAgICAgICAgImJyaWNrVHJhbnNwb3J0IjogdHBfdHJhbnNwb3J0LAogICAgICAgICAg
#3#ICAgICAgICAgICJoaXN0b2dyYW1zIjogW10gICAjIGZpbGxlZCBieSBzdGVwIDQKICAgICAgICAg
#3#ICAgICAgIH0KICAgICAgICAgICAgICAgIGlmIHRfaWR4ID09IDA6CiAgICAgICAgICAgICAgICAg
#3#ICAgIyBNaXJyb3JlZCBhdCB0aGUgdG9wIGxldmVsIHNvIGEgY29uc3VtZXIgdGhhdCBpZ25vcmVz
#3#IGB0aW1lcG9pbnRzYAogICAgICAgICAgICAgICAgICAgICMgc3RpbGwgbW91bnRzIGEgY29oZXJl
#3#bnQgKGZpcnN0LWZyYW1lKSBkYXRhc2V0IGluc3RlYWQgb2YgZmFpbGluZy4KICAgICAgICAgICAg
#3#ICAgICAgICBsZXZlbHNfbWFuaWZlc3QgPSB0cF9sZXZlbHMKICAgICAgICAgICAgICAgICAgICB0
#3#cmFuc3BvcnQgPSB0cF90cmFuc3BvcnQKCiAgICAjIEFzc2VtYmxlIGFuZCB3cml0ZSBtYW5pZmVz
#3#dC5qc29uCiAgICBtYW5pZmVzdCA9IHsKICAgICAgICAidmVyc2lvbiI6IDIsCiAgICAgICAgInNj
#3#aGVtYSI6ICJpcmliaG0tYnJpY2tzLXYyIiwKICAgICAgICAiZGF0YXNldCI6IG91dHB1dF9kaXIu
#3#bmFtZSwKICAgICAgICAiZGF0YXNldFR5cGUiOiAibGl2ZSIgaWYgaXNfdGltZWxhcHNlIGVsc2Ug
#3#ImZpeGVkIiwKICAgICAgICAiY2hhbm5lbHMiOiBuX2NoLAogICAgICAgICJicmlja1NpemUiOiBC
#3#UklDS19TSVpFLAogICAgICAgICJicmlja1BhY2tpbmciOiB7Im1vZGUiOiAiZ3JpZCIsICJjb2xz
#3#IjogOCwgInJvd3MiOiA4fSwKICAgICAgICAidm94ZWxTaXplIjogdm94ZWxfc2l6ZSwKICAgICAg
#3#ICAiY3JlYXRlZEF0IjogX19pbXBvcnRfXygiZGF0ZXRpbWUiKS5kYXRldGltZS5ub3coKS5pc29m
#3#b3JtYXQoKSwKICAgICAgICAibGV2ZWxzIjogbGV2ZWxzX21hbmlmZXN0LAogICAgICAgICJoaXN0
#3#b2dyYW1zIjogW10sICMgV2lsbCBiZSBwb3B1bGF0ZWQgYnkgc3RlcCA0IG9yIGR5bmFtaWMgc2Nh
#3#bgogICAgICAgICJoYXNoZXMiOiB7fSwgICAgICMgTGVmdCBlbXB0eSBhcyB3ZSB1c2UgcGFjayB0
#3#cmFuc3BvcnQKICAgICAgICAidGltZXBvaW50cyI6IHRpbWVwb2ludHNfbWFuaWZlc3QsCiAgICAg
#3#ICAgImJyaWNrVHJhbnNwb3J0IjogdHJhbnNwb3J0CiAgICB9CgogICAgd2l0aCBvcGVuKGJyaWNr
#3#c19kaXIgLyAibWFuaWZlc3QuanNvbiIsICJ3IiwgZW5jb2Rpbmc9InV0Zi04IikgYXMgZm06CiAg
#3#ICAgICAganNvbi5kdW1wKG1hbmlmZXN0LCBmbSwgaW5kZW50PTIpCgogICAgcHJpbnQoZiJbUEFD
#3#S0VSXSBXcm90ZSBtYW5pZmVzdC5qc29uIHRvIHticmlja3NfZGlyIC8gJ21hbmlmZXN0Lmpzb24n
#3#fSIpCiAgICBpZiBpc190aW1lbGFwc2U6CiAgICAgICAgc2l6ZV9tYiA9IChicmlja3NfZGlyIC8g
#3#Im1hbmlmZXN0Lmpzb24iKS5zdGF0KCkuc3Rfc2l6ZSAvIDFlNgogICAgICAgIHByaW50KGYiW1BB
#3#Q0tFUl0ge25fdHB9IHRpbWVwb2ludHMgaW5kZXhlZCwgbWFuaWZlc3Qge3NpemVfbWI6LjJmfSBN
#3#QiIpCgppZiBfX25hbWVfXyA9PSAiX19tYWluX18iOgogICAgaWYgbGVuKHN5cy5hcmd2KSA8IDM6
#3#CiAgICAgICAgcHJpbnQoIlVzYWdlOiBweXRob24gMy1jaHVua19wYWNrZXIucHkgPHRlbXBfZGly
#3#PiA8b3V0cHV0X2Rpcj4iKQogICAgICAgIHN5cy5leGl0KDEpCgogICAgdGVtcF9kaXIgPSBQYXRo
#3#KHN5cy5hcmd2WzFdKQogICAgb3V0cHV0X2RpciA9IFBhdGgoc3lzLmFyZ3ZbMl0pCgogICAgdHJ5
#3#OgogICAgICAgIGJ1aWxkX3BhY2tzKHRlbXBfZGlyLCBvdXRwdXRfZGlyKQogICAgICAgIHByaW50
#3#KGYiW1BBQ0tFUl0gQ2h1bmsgcGFja2FnaW5nIGNvbXBsZXRlLiIpCiAgICBleGNlcHQgRXhjZXB0
#3#aW9uIGFzIGU6CiAgICAgICAgaW1wb3J0IHRyYWNlYmFjawogICAgICAgIHRyYWNlYmFjay5wcmlu
#3#dF9leGMoKQogICAgICAgIHByaW50KGYiW0VSUk9SXSBDaHVuayBwYWNrYWdpbmcgZmFpbGVkOiB7
#3#ZX0iLCBmaWxlPXN5cy5zdGRlcnIpCiAgICAgICAgc3lzLmV4aXQoMSkK
:: ---- [4] 4-catalog_generator.py (9557 octets) ----
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
#4#X2VtYnJ5byhkYXRhc2V0X25hbWUpCiAgICAKICAgICMgUGF0aCByZWxhdGl2ZSB0byBEQVRBX1dF
#4#QiByb290CiAgICAjIGUuZy4sICJmaXhlZC9FZ2ZsNy4uLiIKICAgIHR5cGVfZGlyID0gb3V0cHV0
#4#X2Rpci5wYXJlbnQubmFtZQogICAgcmVsX3BhdGhfc3RyID0gZiJEQVRBX1dFQi97dHlwZV9kaXJ9
#4#L3tkYXRhc2V0X25hbWV9IgogICAgCiAgICAjIDEuIENvbXB1dGUgSGlzdG9ncmFtcyBvbiB0aGUg
#4#aGlnaGVzdCBMT0QgbGV2ZWwgdG8gc2F2ZSB0aW1lIGFuZCBSQU0KICAgIGhpZ2hlc3RfbG9kID0g
#4#bG9kX2xldmVsc1stMV1bImxvZCJdCiAgICBsb2RfdyA9IGxvZF9sZXZlbHNbLTFdWyJ3aWR0aCJd
#4#CiAgICBsb2RfaCA9IGxvZF9sZXZlbHNbLTFdWyJoZWlnaHQiXQoKICAgIGRlZiBfaGlzdG9ncmFt
#4#c19mb3JfdGltZXBvaW50KHRfaWR4OiBpbnQpOgogICAgICAgIG91dCA9IFtdCiAgICAgICAgZm9y
#4#IGNfaWR4IGluIHJhbmdlKG5fY2gpOgogICAgICAgICAgICBiaW5fZmlsZSA9IHRlbXBfZGlyIC8g
#4#ZiJ0e3RfaWR4OjAzZH1fY3tjX2lkeH1fbG9ke2hpZ2hlc3RfbG9kfS5iaW4iCiAgICAgICAgICAg
#4#IGlmIGJpbl9maWxlLmV4aXN0cygpOgogICAgICAgICAgICAgICAgdm9sX2RhdGEgPSBucC5mcm9t
#4#ZmlsZShzdHIoYmluX2ZpbGUpLCBkdHlwZT1ucC51aW50OCkKICAgICAgICAgICAgICAgIGNvdW50
#4#cywgZWRnZXMgPSBucC5oaXN0b2dyYW0odm9sX2RhdGEsIGJpbnM9NjQsIHJhbmdlPSgwLCAyNTUp
#4#KQoKICAgICAgICAgICAgICAgIG1lYW5fdmFsID0gZmxvYXQodm9sX2RhdGEubWVhbigpKSBpZiB2
#4#b2xfZGF0YS5zaXplIGVsc2UgMC4wCiAgICAgICAgICAgICAgICBzdGRfdmFsID0gZmxvYXQodm9s
#4#X2RhdGEuc3RkKCkpIGlmIHZvbF9kYXRhLnNpemUgZWxzZSAwLjAKICAgICAgICAgICAgICAgIG1h
#4#eF92YWwgPSBpbnQodm9sX2RhdGEubWF4KCkpIGlmIHZvbF9kYXRhLnNpemUgZWxzZSAwCgogICAg
#4#ICAgICAgICAgICAgb3V0LmFwcGVuZCh7CiAgICAgICAgICAgICAgICAgICAgImNvdW50cyI6IGNv
#4#dW50cy5hc3R5cGUobnAuaW50NjQpLnRvbGlzdCgpLAogICAgICAgICAgICAgICAgICAgICJlZGdl
#4#cyI6IGVkZ2VzLmFzdHlwZShucC5mbG9hdDY0KS50b2xpc3QoKSwKICAgICAgICAgICAgICAgICAg
#4#ICAidG90YWwiOiBpbnQodm9sX2RhdGEuc2l6ZSksCiAgICAgICAgICAgICAgICAgICAgIm1heCI6
#4#IG1heF92YWwsCiAgICAgICAgICAgICAgICAgICAgIm1lYW4iOiBtZWFuX3ZhbCwKICAgICAgICAg
#4#ICAgICAgICAgICAic3RkIjogc3RkX3ZhbCwKICAgICAgICAgICAgICAgICAgICAiYmFja2dyb3Vu
#4#ZEZsb29yIjogMAogICAgICAgICAgICAgICAgfSkKICAgICAgICAgICAgICAgIGRlbCB2b2xfZGF0
#4#YQogICAgICAgICAgICBlbHNlOgogICAgICAgICAgICAgICAgcHJpbnQoZiJbV0FSTklOR10gQmlu
#4#IGZpbGUgZm9yIGhpc3RvZ3JhbSBub3QgZm91bmQ6IHtiaW5fZmlsZX0iKQogICAgICAgICAgICAg
#4#ICAgb3V0LmFwcGVuZCh7CiAgICAgICAgICAgICAgICAgICAgImNvdW50cyI6IFswXSAqIDY0LAog
#4#ICAgICAgICAgICAgICAgICAgICJlZGdlcyI6IGxpc3QocmFuZ2UoNjUpKSwKICAgICAgICAgICAg
#4#ICAgICAgICAidG90YWwiOiAwLAogICAgICAgICAgICAgICAgICAgICJtYXgiOiAwLAogICAgICAg
#4#ICAgICAgICAgICAgICJtZWFuIjogMC4wLAogICAgICAgICAgICAgICAgICAgICJzdGQiOiAwLjAs
#4#CiAgICAgICAgICAgICAgICAgICAgImJhY2tncm91bmRGbG9vciI6IDAKICAgICAgICAgICAgICAg
#4#IH0pCiAgICAgICAgcmV0dXJuIG91dAoKICAgIHByaW50KGYiW0NBVEFMT0ddIENvbXB1dGluZyBo
#4#aXN0b2dyYW1zIG9uIExPRCB7aGlnaGVzdF9sb2R9ICh7bG9kX3d9eHtsb2RfaH14e0R9KSIKICAg
#4#ICAgICAgIGYie2YnIGZvciB7bl90cH0gdGltZXBvaW50cycgaWYgbl90cCA+IDEgZWxzZSAnJ30u
#4#Li4iKQogICAgaGlzdG9ncmFtcyA9IF9oaXN0b2dyYW1zX2Zvcl90aW1lcG9pbnQoMCkKCiAgICAj
#4#IDIuIFVwZGF0ZSBicmlja3MvbWFuaWZlc3QuanNvbiB3aXRoIGNhbGN1bGF0ZWQgaGlzdG9ncmFt
#4#cwogICAgbWFuaWZlc3RfcGF0aCA9IG91dHB1dF9kaXIgLyAiYnJpY2tzIiAvICJtYW5pZmVzdC5q
#4#c29uIgogICAgaWYgbWFuaWZlc3RfcGF0aC5leGlzdHMoKToKICAgICAgICB3aXRoIG9wZW4obWFu
#4#aWZlc3RfcGF0aCwgInIiLCBlbmNvZGluZz0idXRmLTgiKSBhcyBmOgogICAgICAgICAgICBtYW5p
#4#ZmVzdCA9IGpzb24ubG9hZChmKQogICAgICAgIG1hbmlmZXN0WyJoaXN0b2dyYW1zIl0gPSBoaXN0
#4#b2dyYW1zCiAgICAgICAgIyBBIHRpbWVsYXBzZSBjYXJyaWVzIG9uZSBoaXN0b2dyYW0gc2V0IHBl
#4#ciBmcmFtZTogdGhlIGNoYW5uZWwgcGFuZWwgcmVhZHMKICAgICAgICAjIHRoZSByb3cgb2YgdGhl
#4#IHRpbWVwb2ludCBvbiBzY3JlZW4sIGFuZCBhIHNoYXJlZCBzZXQgd291bGQgbWlzLXNjYWxlIHRo
#4#ZQogICAgICAgICMgc2xpZGVycyBhcyB0aGUgc3BlY2ltZW4gYmxlYWNoZXMuCiAgICAgICAgdHBf
#4#bWFuaWZlc3QgPSBtYW5pZmVzdC5nZXQoInRpbWVwb2ludHMiKQogICAgICAgIGlmIGlzaW5zdGFu
#4#Y2UodHBfbWFuaWZlc3QsIGRpY3QpOgogICAgICAgICAgICBmb3IgdF9pZHggaW4gcmFuZ2Uobl90
#4#cCk6CiAgICAgICAgICAgICAgICBrZXkgPSBmInR7dF9pZHg6MDNkfSIKICAgICAgICAgICAgICAg
#4#IGlmIGtleSBpbiB0cF9tYW5pZmVzdDoKICAgICAgICAgICAgICAgICAgICB0cF9tYW5pZmVzdFtr
#4#ZXldWyJoaXN0b2dyYW1zIl0gPSAoaGlzdG9ncmFtcyBpZiB0X2lkeCA9PSAwCiAgICAgICAgICAg
#4#ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVsc2UgX2hpc3RvZ3Jh
#4#bXNfZm9yX3RpbWVwb2ludCh0X2lkeCkpCiAgICAgICAgd2l0aCBvcGVuKG1hbmlmZXN0X3BhdGgs
#4#ICJ3IiwgZW5jb2Rpbmc9InV0Zi04IikgYXMgZjoKICAgICAgICAgICAganNvbi5kdW1wKG1hbmlm
#4#ZXN0LCBmLCBpbmRlbnQ9MikKICAgICAgICBwcmludChmIltDQVRBTE9HXSBJbmplY3RlZCBoaXN0
#4#b2dyYW1zIGludG8gbWFuaWZlc3QuanNvbiIpCiAgICBlbHNlOgogICAgICAgIHByaW50KGYiW1dB
#4#Uk5JTkddIG1hbmlmZXN0Lmpzb24gbm90IGZvdW5kIHRvIHVwZGF0ZSBoaXN0b2dyYW1zLiIpCgog
#4#ICAgIyAzLiBDYWxjdWxhdGUgUGh5c2ljYWwgQ2FsaWJyYXRpb24KICAgIHZ4ID0gdm94ZWxfc2l6
#4#ZVsieCJdCiAgICB2eSA9IHZveGVsX3NpemVbInkiXQogICAgdnogPSB2b3hlbF9zaXplWyJ6Il0K
#4#CiAgICBleHRlbnQgPSBwcm9jX21ldGEuZ2V0KCJleHRlbnQiKSBvciB7fQogICAgZXh0X21pbiA9
#4#IGV4dGVudC5nZXQoIm1pbiIpIG9yIFswLjAsIDAuMCwgMC4wXQogICAgZXh0X21heCA9IGV4dGVu
#4#dC5nZXQoIm1heCIpIG9yIFtXICogdngsIEggKiB2eSwgRCAqIHZ6XQoKICAgICMgVGhlIHZpZXdl
#4#ciBtb2RlbHMgZGVwdGggYXMgKEQtMSkgei1zdGVwcyBwbHVzIG9uZSBzbGljZSB0aGlja25lc3Ms
#4#IGFuZCB3aXRob3V0CiAgICAjIGFuIGV4cGxpY2l0IHZhbHVlIGl0IGd1ZXNzZXMgdGhhdCB0aGlj
#4#a25lc3MgYXMgbWluKHpTdGVwLCB2b3hlbFgpIOKAlCB3aGljaCBmb3IgYW4KICAgICMgYW5pc290
#4#cm9waWMgc3RhY2sgdW5kZXItcmVwb3J0cyB0aGUgZGVwdGggKGhlcmUgMzI5LjUwIHVtIGluc3Rl
#4#YWQgb2YgdGhlIDMzMy44NyB1bQogICAgIyBJbWFyaXMgc3RhdGVzKS4gRGVjbGFyaW5nIHRoZSBz
#4#bGljZSB0aGlja25lc3MgZXF1YWwgdG8gdGhlIHotc3RlcCByZXByb2R1Y2VzIHRoZQogICAgIyBt
#4#aWNyb3Njb3BlJ3Mgb3duIGV4dGVudCBleGFjdGx5LCB3aGljaCBpcyBtYW5kYXRvcnkgZm9yIGFu
#4#eXRoaW5nIHJlZ2lzdGVyZWQgaW4KICAgICMgSW1hcmlzIGNvb3JkaW5hdGVzIChjZWxsIHRyYWNr
#4#cykgdG8gbGFuZCBvbiB0aGUgcmlnaHQgdm94ZWxzLgogICAgc2xpY2VfdGhpY2tuZXNzID0gKGV4
#4#dF9tYXhbMl0gLSBleHRfbWluWzJdKSAvIG1heChELCAxKQogICAgcGh5c2ljYWxfc2l6ZSA9IHsK
#4#ICAgICAgICAieCI6IGV4dF9tYXhbMF0gLSBleHRfbWluWzBdLAogICAgICAgICJ5IjogZXh0X21h
#4#eFsxXSAtIGV4dF9taW5bMV0sCiAgICAgICAgInoiOiBleHRfbWF4WzJdIC0gZXh0X21pblsyXSwK
#4#ICAgICAgICAic2xpY2VUaGlja25lc3MiOiBzbGljZV90aGlja25lc3MsCiAgICAgICAgInZveGVs
#4#WCI6IHZ4LAogICAgICAgICJ2b3hlbFkiOiB2eSwKICAgICAgICAidm94ZWxaIjogdnoKICAgIH0K
#4#ICAgIAogICAgaW50ZXJ2YWwgPSBwcm9jX21ldGEuZ2V0KCJ0aW1lX2ludGVydmFsX21pbnV0ZXMi
#4#KQogICAgdGltZXN0YW1wcyA9IHByb2NfbWV0YS5nZXQoInRpbWVzdGFtcHMiKSBvciBbXQoKICAg
#4#ICMgU2V0dXAgZGVmYXVsdCBjaGFubmVscyBpbmZvIGZvciBtZXRhZGF0YS5qc29uCiAgICBjaGFu
#4#bmVsc19pbmZvID0gW10KICAgIGZvciBpIGluIHJhbmdlKG5fY2gpOgogICAgICAgIGNoX25hbWUg
#4#PSBjaGFubmVsX25hbWVzW2ldIGlmIGkgPCBsZW4oY2hhbm5lbF9uYW1lcykgZWxzZSBmIkNoYW5u
#4#ZWwge2krMX0iCiAgICAgICAgY2hhbm5lbHNfaW5mby5hcHBlbmQoewogICAgICAgICAgICAibmFt
#4#ZSI6IGNoX25hbWUsCiAgICAgICAgICAgICJjb2xvciI6IENPTE9SU1tpICUgbGVuKENPTE9SUyld
#4#LAogICAgICAgICAgICAibWluIjogMC4wLAogICAgICAgICAgICAibWF4IjogMS4wLAogICAgICAg
#4#ICAgICAiZ2FtbWEiOiAxLjAKICAgICAgICB9KQoKICAgICMgQnVpbGQgbWV0YWRhdGEuanNvbgog
#4#ICAgbWV0YWRhdGEgPSB7CiAgICAgICAgImlkIjogZiJ7dHlwZV9kaXJ9L3tkYXRhc2V0X25hbWV9
#4#IiwKICAgICAgICAibmFtZSI6IGRhdGFzZXRfbmFtZSwKICAgICAgICAidHlwZSI6IHR5cGVfZGly
#4#LAogICAgICAgICJzdGFnZSI6IHN0YWdlLAogICAgICAgICJzdGFnZU51bWVyaWMiOiBzdGFnZV9u
#4#dW0sCiAgICAgICAgImVtYnJ5byI6IGVtYnJ5bywKICAgICAgICAiZGltZW5zaW9ucyI6IHsKICAg
#4#ICAgICAgICAgIngiOiBXLAogICAgICAgICAgICAieSI6IEgsCiAgICAgICAgICAgICJ6IjogRCwK
#4#ICAgICAgICAgICAgImMiOiBuX2NoLAogICAgICAgICAgICAidCI6IG5fdHAKICAgICAgICB9LAog
#4#ICAgICAgICJ2b3hlbF9zaXplIjogdm94ZWxfc2l6ZSwKICAgICAgICAicGh5c2ljYWxTaXplVW0i
#4#OiBwaHlzaWNhbF9zaXplLAogICAgICAgICJvcHRpY2FsX3NlY3Rpb25fdGhpY2tuZXNzX3VtIjog
#4#cm91bmQoc2xpY2VfdGhpY2tuZXNzLCA2KSwKICAgICAgICAiYWNxdWlzaXRpb25FeHRlbnRVbSI6
#4#IHsKICAgICAgICAgICAgInVuaXQiOiBleHRlbnQuZ2V0KCJ1bml0IiwgInVtIiksCiAgICAgICAg
#4#ICAgICJtaW4iOiBbZmxvYXQodikgZm9yIHYgaW4gZXh0X21pbl0sCiAgICAgICAgICAgICJtYXgi
#4#OiBbZmxvYXQodikgZm9yIHYgaW4gZXh0X21heF0KICAgICAgICB9LAogICAgICAgICJjYWxpYnJh
#4#dGlvblN0YXR1cyI6ICJleGFjdCIgaWYgKHZ4IGFuZCB2eSBhbmQgdnopIGVsc2UgIm1ldGFkYXRh
#4#LW1pc3NpbmciLAogICAgICAgICJjYWxpYnJhdGlvbk5vdGUiOiAiVm94ZWwgbWV0YWRhdGEgd2Fz
#4#IHN1Y2Nlc3NmdWxseSBleHRyYWN0ZWQuIiBpZiAodnggYW5kIHZ5IGFuZCB2eikgZWxzZSAiQ2Fs
#4#aWJyYXRpb24gbWV0YWRhdGEgbWlzc2luZy4iLAogICAgICAgICJjaGFubmVscyI6IGNoYW5uZWxz
#4#X2luZm8sCiAgICAgICAgImNyZWF0ZWQiOiBfX2ltcG9ydF9fKCJkYXRldGltZSIpLmRhdGV0aW1l
#4#Lm5vdygpLmlzb2Zvcm1hdCgpLAogICAgICAgICJsYXN0TW9kaWZpZWQiOiBfX2ltcG9ydF9fKCJk
#4#YXRldGltZSIpLmRhdGV0aW1lLm5vdygpLmlzb2Zvcm1hdCgpLAogICAgICAgICJjb25maWd1cmVk
#4#IjogVHJ1ZSwKICAgICAgICAiZm9sZGVyTmFtZSI6IGRhdGFzZXRfbmFtZSwKICAgICAgICAiZGVz
#4#Y3JpcHRpb24iOiAoCiAgICAgICAgICAgIGYiVGltZWxhcHNlIGNvbmZvY2FsIGFjcXVpc2l0aW9u
#4#OiB7c3RhZ2V9IGVtYnJ5bywge25fdHB9IHRpbWVwb2ludHMiCiAgICAgICAgICAgIGYie2YnIGV2
#4#ZXJ5IHtpbnRlcnZhbDpnfSBtaW4nIGlmIGludGVydmFsIGVsc2UgJyd9LCB7RH0gc2xpY2VzLCB7
#4#bl9jaH0gY2hhbm5lbHMuIgogICAgICAgICAgICBpZiBuX3RwID4gMSBlbHNlCiAgICAgICAgICAg
#4#IGYiQ29uZm9jYWwgaW1hZ2luZyBzdGFjazoge3N0YWdlfSBmaXhlZCBlbWJyeW8sIHtEfSBzbGlj
#4#ZXMsIHtuX2NofSBjaGFubmVscy4iCiAgICAgICAgKSwKICAgICAgICAidGh1bWJuYWlsIjogZiJ7
#4#cmVsX3BhdGhfc3RyfS90aHVtYm5haWwud2VicCIgaWYgKG91dHB1dF9kaXIgLyAidGh1bWJuYWls
#4#LndlYnAiKS5leGlzdHMoKSBlbHNlIE5vbmUsCiAgICAgICAgInZvbHVtZVNvdXJjZXMiOiBbCiAg
#4#ICAgICAgICAgIHsKICAgICAgICAgICAgICAgICJraW5kIjogImJyaWNrcyIsCiAgICAgICAgICAg
#4#ICAgICAibGFiZWwiOiAiQ2h1bmtlZCBicmlja3MgKDY0wrMpIiwKICAgICAgICAgICAgICAgICJw
#4#cmlvcml0eSI6IC0xLAogICAgICAgICAgICAgICAgImF2YWlsYWJsZSI6IFRydWUsCiAgICAgICAg
#4#ICAgICAgICAibXVsdGlzY2FsZSI6IFRydWUsCiAgICAgICAgICAgICAgICAicGF0aCI6IHJlbF9w
#4#YXRoX3N0ciwKICAgICAgICAgICAgICAgICJtYW5pZmVzdFBhdGgiOiBmIntyZWxfcGF0aF9zdHJ9
#4#L2JyaWNrcy9tYW5pZmVzdC5qc29uIgogICAgICAgICAgICB9CiAgICAgICAgXQogICAgfQoKICAg
#4#IGlmIG5fdHAgPiAxOgogICAgICAgIG5vcm0gPSBwcm9jX21ldGEuZ2V0KCJub3JtYWxpemF0aW9u
#4#Iikgb3Ige30KICAgICAgICBtZXRhZGF0YVsidGltZWxpbmUiXSA9IHsKICAgICAgICAgICAgImNv
#4#dW50Ijogbl90cCwKICAgICAgICAgICAgImludGVydmFsTWludXRlcyI6IGludGVydmFsLAogICAg
#4#ICAgICAgICAidGltZXN0YW1wcyI6IHRpbWVzdGFtcHMKICAgICAgICB9CiAgICAgICAgIyBQaG90
#4#b2JsZWFjaGluZyBpcyByZXBvcnRlZCwgbmV2ZXIgYmFrZWQgaW46IHRoZSB2b3hlbHMgc3RheSBv
#4#biBvbmUgbGluZWFyCiAgICAgICAgIyB3aW5kb3cgKHNlZSAyLWltYWdlX3Byb2Nlc3Nvci5weSkg
#4#c28gYSBmcmFtZSB0aGF0IGxvb2tzIGRpbW1lciByZWFsbHkgaXMKICAgICAgICAjIGRpbW1lci4g
#4#VGhlc2UgcGVyLWZyYW1lIHNpZ25hbCBsZXZlbHMgbGV0IHRoZSB2aWV3ZXIgb2ZmZXIgYW4gT1BU
#4#SU9OQUwsCiAgICAgICAgIyByZXZlcnNpYmxlIGRpc3BsYXkgZ2FpbiBpbnN0ZWFkIG9mIHNpbGVu
#4#dGx5IHJld3JpdGluZyB0aGUgZGF0YS4KICAgICAgICBtZXRhZGF0YVsiaW50ZW5zaXR5Tm9ybWFs
#4#aXphdGlvbiJdID0gewogICAgICAgICAgICAibW9kZSI6IG5vcm0uZ2V0KCJtb2RlIiwgImdsb2Jh
#4#bCIpLAogICAgICAgICAgICAiYm91bmRzIjogbm9ybS5nZXQoImJvdW5kcyIsIHt9KSwKICAgICAg
#4#ICAgICAgInNpZ25hbExldmVscyI6IG5vcm0uZ2V0KCJzaWduYWxMZXZlbHMiLCB7fSkKICAgICAg
#4#ICB9CgoKICAgIHdpdGggb3BlbihvdXRwdXRfZGlyIC8gIm1ldGFkYXRhLmpzb24iLCAidyIsIGVu
#4#Y29kaW5nPSJ1dGYtOCIpIGFzIGZtOgogICAgICAgIGpzb24uZHVtcChtZXRhZGF0YSwgZm0sIGlu
#4#ZGVudD0yLCBlbnN1cmVfYXNjaWk9RmFsc2UpCiAgICAgICAgCiAgICBwcmludChmIltDQVRBTE9H
#4#XSBXcm90ZSBtZXRhZGF0YS5qc29uIHRvIHtvdXRwdXRfZGlyIC8gJ21ldGFkYXRhLmpzb24nfSIp
#4#CgppZiBfX25hbWVfXyA9PSAiX19tYWluX18iOgogICAgaWYgbGVuKHN5cy5hcmd2KSA8IDM6CiAg
#4#ICAgICAgcHJpbnQoIlVzYWdlOiBweXRob24gNC1jYXRhbG9nX2dlbmVyYXRvci5weSA8dGVtcF9k
#4#aXI+IDxvdXRwdXRfZGlyPiIpCiAgICAgICAgc3lzLmV4aXQoMSkKICAgICAgICAKICAgIHRlbXBf
#4#ZGlyID0gUGF0aChzeXMuYXJndlsxXSkKICAgIG91dHB1dF9kaXIgPSBQYXRoKHN5cy5hcmd2WzJd
#4#KQogICAgCiAgICB0cnk6CiAgICAgICAgZ2VuZXJhdGVfY2F0YWxvZ19tZXRhZGF0YSh0ZW1wX2Rp
#4#ciwgb3V0cHV0X2RpcikKICAgICAgICBwcmludChmIltDQVRBTE9HXSBDYXRhbG9nIG1ldGFkYXRh
#4#IGdlbmVyYXRpb24gY29tcGxldGUuIikKICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZToKICAgICAg
#4#ICBpbXBvcnQgdHJhY2ViYWNrCiAgICAgICAgdHJhY2ViYWNrLnByaW50X2V4YygpCiAgICAgICAg
#4#cHJpbnQoZiJbRVJST1JdIENhdGFsb2cgbWV0YWRhdGEgZ2VuZXJhdGlvbiBmYWlsZWQ6IHtlfSIs
#4#IGZpbGU9c3lzLnN0ZGVycikKICAgICAgICBzeXMuZXhpdCgxKQo=
:: ---- [5] wholemount_importer.py (19847 octets) ----
#5#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwoiIiIKV2hvbGVtb3VudCBpbXBvcnRlciDigJQgb25lIGNv
#5#bG91ciBwaG90b2dyYXBoIOKGkiBvbmUgYHdob2xlbW91bnRgIGRhdGFzZXQuCgpJbnB1dCA6IDJE
#5#IFRJRkZzIGFzIGV4cG9ydGVkIGJ5IEltYWdlSi9GaWppIGZyb20gYSBMZWljYSAubGlmIChhIGNv
#5#bXBvc2l0ZSBvZgogICAgICAgIHRocmVlIDgtYml0IHBsYW5lcyB3aXRoIFJlZC9HcmVlbi9CbHVl
#5#IExVVHMpLCBwbGFpbiBSR0IgVElGRnMsIG9yIHNpbmdsZQogICAgICAgIGdyZXlzY2FsZSBUSUZG
#5#cy4gTm8gWiwgbm8gVDogYSB3aG9sZW1vdW50IGlzIGEgcGljdHVyZSwgbm90IGEgdm9sdW1lLgpP
#5#dXRwdXQ6IERBVEFfV0VCL3dob2xlbW91bnQvPGRhdGFzZXQ+LwogICAgICAgICAgaW1hZ2Uud2Vi
#5#cCAgICAgIG5hdGl2ZSByZXNvbHV0aW9uLCB3aGF0IHRoZSB2aWV3ZXIgc2hvd3Mgb25jZSBsb2Fk
#5#ZWQKICAgICAgICAgIHByZXZpZXcud2VicCAgICBsb25nIHNpZGUgNjQwIHB4LCBwYWludGVkIGZp
#5#cnN0IHNvIHRoZSBwYWdlIG5ldmVyIHdhaXRzCiAgICAgICAgICB0aHVtYm5haWwud2VicCAgNTEy
#5#wrIgcGFkZGVkIHNxdWFyZSwgdGhlIGV4cGxvcmVyL2NhdGFsb2cgY29udmVudGlvbgogICAgICAg
#5#ICAgbWV0YWRhdGEuanNvbiAgIHR5cGUgIndob2xlbW91bnQiIOKAlCBzdGFnZSwgcGl4ZWwgc2l6
#5#ZSwgYWNxdWlzaXRpb24KICAgICAgICAgIGRvd25sb2FkLyAgICAgICAoLS13aXRoLWRvd25sb2Fk
#5#cykgdGhlIG9yaWdpbmFsIFRJRkYgKyBSRUFETUUudHh0CgpFdmVyeXRoaW5nIG1lYXN1cmFibGUg
#5#aXMgcmVhZCBmcm9tIHRoZSBmaWxlLCBuZXZlciBndWVzc2VkOiB0aGUgcGl4ZWwgc2l6ZSBjb21l
#5#cwpmcm9tIHRoZSBUSUZGIHJlc29sdXRpb24gdGFncyAoSW1hZ2VKIHdyaXRlcyB0aGVtIGluIG1p
#5#Y3JvbnMpIGFuZCB0aGUgYWNxdWlzaXRpb24KZmllbGRzIGZyb20gdGhlIExlaWNhIGJsb2NrIElt
#5#YWdlSiBlbWJlZHMuIFdoYXQgdGhlIGZpbGUgY2Fubm90IHRlbGwg4oCUIHRoZQpyZXBvcnRlciBs
#5#aW5lLCB0aGUgc3RhaW5pbmcg4oCUIGlzIHRha2VuIGZyb20gdGhlIGNvbW1hbmQgbGluZSBhbmQg
#5#cHJlc2VydmVkIG9uCnJlLWltcG9ydCBzbyBsYWIgY3VyYXRpb24gaXMgbmV2ZXIgb3ZlcndyaXR0
#5#ZW4gKHNlZSBgbWVyZ2VfY3VyYXRlZGApLgoKICAgIHB5dGhvbiB3aG9sZW1vdW50X2ltcG9ydGVy
#5#LnB5IC0taW5wdXQgPGRpcnxmaWxlLnRpZj4gLS1vdXRwdXQgREFUQV9XRUIgXAogICAgICAgIFst
#5#LWxpbmUgRExMNHhDRDFdIFstLXN0YWluaW5nIFgtZ2FsXSBbLS1vbmx5ICIqRTguMCoiXSBbLS13
#5#aXRoLWRvd25sb2Fkc10gWy0tZm9yY2VdCiIiIgppbXBvcnQgYXJncGFyc2UKaW1wb3J0IGZubWF0
#5#Y2gKaW1wb3J0IGpzb24KaW1wb3J0IG9zCmltcG9ydCByZQppbXBvcnQgc2h1dGlsCmltcG9ydCBz
#5#dHJ1Y3QKaW1wb3J0IHN5cwpmcm9tIGRhdGV0aW1lIGltcG9ydCBkYXRldGltZQpmcm9tIHBhdGhs
#5#aWIgaW1wb3J0IFBhdGgKCmltcG9ydCBudW1weSBhcyBucApmcm9tIFBJTCBpbXBvcnQgSW1hZ2UK
#5#Cl9fdmVyc2lvbl9fID0gIjAuMTcuMCIKClRZUEVfRElSID0gIndob2xlbW91bnQiClBSRVZJRVdf
#5#TE9OR19TSURFID0gNjQwClRIVU1CX1NJWkUgPSA1MTIKVEhVTUJfQkFDS0dST1VORCA9ICg4LCAx
#5#MCwgMTgpCk5BVElWRV9RVUFMSVRZID0gOTAKUFJFVklFV19RVUFMSVRZID0gODAKCklKX01FVEFE
#5#QVRBX1RBRyA9IDUwODM5CklKX01FVEFEQVRBX0NPVU5UU19UQUcgPSA1MDgzOApYX1JFU09MVVRJ
#5#T05fVEFHID0gMjgyCklNQUdFX0RFU0NSSVBUSU9OX1RBRyA9IDI3MAoKIyBLZXlzIHRoZSBsYWIg
#5#ZWRpdHMgYnkgaGFuZCBpbiB0aGUgYWRtaW4gcGFuZWwuIEEgcmUtaW1wb3J0IHJlZnJlc2hlcyB3
#5#aGF0IHRoZQojIGZpbGUgbWVhc3VyZXMgYW5kIGxlYXZlcyB0aGVzZSBhbG9uZS4KQ1VSQVRFRF9L
#5#RVlTID0gKCJuYW1lIiwgImRlc2NyaXB0aW9uIiwgInN0YWdlIiwgInN0YWdlTnVtZXJpYyIsICJl
#5#bWJyeW8iLCAibGluZSIsCiAgICAgICAgICAgICAgICAic3RhaW5pbmciLCAicmVwb3J0ZXIiLCAi
#5#aGlkZGVuIiwgImdhbGxlcnkiLCAidGFncyIsICJub3RlcyIsICJjcmVhdGVkIikKCgojIOKUgOKU
#5#gCBJbWFnZUogbWV0YWRhdGEg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmRlZiByZWFkX2lqX21ldGFkYXRhKGltKSAtPiBk
#5#aWN0OgogICAgIiIiRGVjb2RlIHRoZSBJbWFnZUogcHJpdmF0ZSB0YWcgaW50byB7J2luZm8nOiBb
#5#c3RyXSwgJ2xhYmwnOiBbc3RyXSwKICAgICdsdXRzJzogW2J5dGVzXSwgJ3JhbmcnOiBbYnl0ZXNd
#5#fS4gQWJzZW50IG9yIG1hbGZvcm1lZCDihpIge30uIiIiCiAgICBibG9iID0gaW0udGFnX3YyLmdl
#5#dChJSl9NRVRBREFUQV9UQUcpCiAgICBjb3VudHMgPSBpbS50YWdfdjIuZ2V0KElKX01FVEFEQVRB
#5#X0NPVU5UU19UQUcpCiAgICBpZiBub3QgYmxvYiBvciBub3QgY291bnRzIG9yIGJ5dGVzKGJsb2Jb
#5#OjRdKSAhPSBiIklKSUoiOgogICAgICAgIHJldHVybiB7fQogICAgYmxvYiA9IGJ5dGVzKGJsb2Ip
#5#CiAgICBoZWFkZXJfbGVuID0gY291bnRzWzBdCiAgICBraW5kcyA9IFsoYmxvYltwOnAgKyA0XSwg
#5#c3RydWN0LnVucGFjaygiPkkiLCBibG9iW3AgKyA0OnAgKyA4XSlbMF0pCiAgICAgICAgICAgICBm
#5#b3IgcCBpbiByYW5nZSg0LCBoZWFkZXJfbGVuLCA4KV0KICAgIG91dCwgcG9zLCBpZHggPSB7fSwg
#5#aGVhZGVyX2xlbiwgMQogICAgZm9yIGtpbmQsIG4gaW4ga2luZHM6CiAgICAgICAgaXRlbXMgPSBb
#5#XQogICAgICAgIGZvciBfIGluIHJhbmdlKG4pOgogICAgICAgICAgICBpZiBpZHggPj0gbGVuKGNv
#5#dW50cyk6CiAgICAgICAgICAgICAgICByZXR1cm4gb3V0CiAgICAgICAgICAgIGNodW5rID0gYmxv
#5#Yltwb3M6cG9zICsgY291bnRzW2lkeF1dCiAgICAgICAgICAgIHBvcyArPSBjb3VudHNbaWR4XQog
#5#ICAgICAgICAgICBpZHggKz0gMQogICAgICAgICAgICBpdGVtcy5hcHBlbmQoY2h1bmsuZGVjb2Rl
#5#KCJ1dGYtMTYtYmUiLCAicmVwbGFjZSIpCiAgICAgICAgICAgICAgICAgICAgICAgICBpZiBraW5k
#5#IGluIChiImluZm8iLCBiImxhYmwiKSBlbHNlIGNodW5rKQogICAgICAgIG91dFtraW5kLmRlY29k
#5#ZSgiYXNjaWkiLCAicmVwbGFjZSIpXSA9IGl0ZW1zCiAgICByZXR1cm4gb3V0CgoKZGVmIHJlYWRf
#5#cGxhbmVzKGltKSAtPiBsaXN0OgogICAgcGxhbmVzID0gW10KICAgIGZvciBpIGluIHJhbmdlKGdl
#5#dGF0dHIoaW0sICJuX2ZyYW1lcyIsIDEpKToKICAgICAgICBpbS5zZWVrKGkpCiAgICAgICAgcGxh
#5#bmVzLmFwcGVuZChucC5hcnJheShpbSkpCiAgICBpbS5zZWVrKDApCiAgICByZXR1cm4gcGxhbmVz
#5#CgoKZGVmIGNvbXBvc2VfcmdiKHBsYW5lczogbGlzdCwgbHV0czogbGlzdCkgLT4gbnAubmRhcnJh
#5#eToKICAgICIiIkFkZGl0aXZlIGNvbXBvc2l0ZSwgZXhhY3RseSB3aGF0IEltYWdlSidzIGNvbXBv
#5#c2l0ZSBtb2RlIGRpc3BsYXlzOgogICAgb3V0ID0gzqMgbHV0X2NbcGxhbmVfY10uIFBsYWluIFJH
#5#QiBhbmQgZ3JleXNjYWxlIGZpbGVzIHBhc3Mgc3RyYWlnaHQgdGhyb3VnaC4iIiIKICAgIGZpcnN0
#5#ID0gcGxhbmVzWzBdCiAgICBpZiBmaXJzdC5uZGltID09IDM6CiAgICAgICAgcmV0dXJuIG5wLmFz
#5#Y29udGlndW91c2FycmF5KGZpcnN0WzosIDosIDozXSkKICAgIGFjYyA9IG5wLnplcm9zKGZpcnN0
#5#LnNoYXBlICsgKDMsKSwgZHR5cGU9bnAuZmxvYXQzMikKICAgIGZvciBjLCBwbGFuZSBpbiBlbnVt
#5#ZXJhdGUocGxhbmVzKToKICAgICAgICBsdXQgPSBfbHV0X3RhYmxlKGx1dHMsIGMsIGxlbihwbGFu
#5#ZXMpKQogICAgICAgIGFjYyArPSBsdXRbX3RvX3VpbnQ4KHBsYW5lKV0KICAgIHJldHVybiBucC5j
#5#bGlwKGFjYywgMCwgMjU1KS5hc3R5cGUobnAudWludDgpCgoKZGVmIF9sdXRfdGFibGUobHV0czog
#5#bGlzdCwgaW5kZXg6IGludCwgbl9wbGFuZXM6IGludCkgLT4gbnAubmRhcnJheToKICAgICIiIjI1
#5#NsOXMyBjb2xvdXIgdGFibGUgZm9yIHBsYW5lIGBpbmRleGAuIEltYWdlSiBzdG9yZXMgUixHLEIg
#5#cmFtcHMgb2YgMjU2CiAgICBieXRlcyBlYWNoOyB3aXRob3V0IExVVHMsIHRocmVlIHBsYW5lcyBh
#5#cmUgdGFrZW4gYXMgUi9HL0IsIG9uZSBhcyBncmV5LiIiIgogICAgaWYgaW5kZXggPCBsZW4obHV0
#5#cykgYW5kIGxlbihsdXRzW2luZGV4XSkgPT0gNzY4OgogICAgICAgIHJhdyA9IG5wLmZyb21idWZm
#5#ZXIobHV0c1tpbmRleF0sIGR0eXBlPW5wLnVpbnQ4KQogICAgICAgIHJldHVybiByYXcucmVzaGFw
#5#ZSgzLCAyNTYpLlQuYXN0eXBlKG5wLmZsb2F0MzIpCiAgICByYW1wID0gbnAuYXJhbmdlKDI1Niwg
#5#ZHR5cGU9bnAuZmxvYXQzMikKICAgIHRhYmxlID0gbnAuemVyb3MoKDI1NiwgMyksIGR0eXBlPW5w
#5#LmZsb2F0MzIpCiAgICBpZiBuX3BsYW5lcyA9PSAzOgogICAgICAgIHRhYmxlWzosIGluZGV4XSA9
#5#IHJhbXAKICAgIGVsc2U6CiAgICAgICAgdGFibGVbOl0gPSByYW1wWzosIE5vbmVdCiAgICByZXR1
#5#cm4gdGFibGUKCgpkZWYgX3RvX3VpbnQ4KHBsYW5lOiBucC5uZGFycmF5KSAtPiBucC5uZGFycmF5
#5#OgogICAgaWYgcGxhbmUuZHR5cGUgPT0gbnAudWludDg6CiAgICAgICAgcmV0dXJuIHBsYW5lCiAg
#5#ICBoaSA9IGZsb2F0KHBsYW5lLm1heCgpKSBvciAxLjAKICAgIHJldHVybiAocGxhbmUuYXN0eXBl
#5#KG5wLmZsb2F0MzIpICogKDI1NS4wIC8gaGkpKS5hc3R5cGUobnAudWludDgpCgoKIyDilIDilIAg
#5#Q2FsaWJyYXRpb24g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmRlZiBwaXhlbF9zaXplX3VtKGltLCBk
#5#ZXNjcmlwdGlvbjogc3RyKSAtPiB0dXBsZToKICAgICIiIijCtW0gcGVyIHBpeGVsLCBzdGF0dXMp
#5#LiBJbWFnZUogd3JpdGVzIFhSZXNvbHV0aW9uIGluIHBpeGVscyBwZXIgYHVuaXRgOwogICAgd2Ug
#5#b25seSB0cnVzdCBpdCB3aGVuIHRoZSB1bml0IGlzIGRlY2xhcmVkIGluIG1pY3JvbnMuIiIiCiAg
#5#ICB4cmVzID0gaW0udGFnX3YyLmdldChYX1JFU09MVVRJT05fVEFHKQogICAgdW5pdCA9IHJlLnNl
#5#YXJjaChyIl51bml0PShcUyspIiwgZGVzY3JpcHRpb24sIHJlLk1VTFRJTElORSkKICAgIHVuaXQg
#5#PSB1bml0Lmdyb3VwKDEpLmxvd2VyKCkgaWYgdW5pdCBlbHNlICIiCiAgICBpZiB4cmVzIGFuZCBm
#5#bG9hdCh4cmVzKSA+IDAgYW5kIHVuaXQgaW4gKCJtaWNyb24iLCAibWljcm9ucyIsICJ1bSIsICLC
#5#tW0iLCAiXFx1MDBiNW0iKToKICAgICAgICByZXR1cm4gMS4wIC8gZmxvYXQoeHJlcyksICJleGFj
#5#dCIKICAgIHJldHVybiBOb25lLCAidW5rbm93biIKCgojIOKUgOKUgCBMZWljYSBibG9jayDilIDi
#5#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIAKTEVJQ0FfRklFTERTID0gewogICAgIlpvb20iOiAoInpvb20iLCBm
#5#bG9hdCksCiAgICAiTWFnbmlmaWNhdGlvbiI6ICgibWFnbmlmaWNhdGlvbiIsIGZsb2F0KSwKICAg
#5#ICJPYmplY3RpdmVOYW1lIjogKCJvYmplY3RpdmUiLCBzdHIpLAogICAgIk51bWVyaWNhbEFwZXJ0
#5#dXJlIjogKCJudW1lcmljYWxBcGVydHVyZSIsIGZsb2F0KSwKICAgICJFeHBvc3VyZVRpbWUiOiAo
#5#ImV4cG9zdXJlUyIsIGZsb2F0KSwKICAgICJJbmRpdmlkdWFsQ2FtZXJhSW5mb3xHYWluIjogKCJn
#5#YWluIiwgZmxvYXQpLAogICAgIk1pY3Jvc2NvcGVNb2RlbCI6ICgibWljcm9zY29wZSIsIHN0ciks
#5#CiAgICAiRnVsbENhbWVyYU5hbWUiOiAoImNhbWVyYSIsIHN0ciksCn0KCgpkZWYgbGVpY2FfZmll
#5#bGRzKGluZm86IHN0ciwgc2VyaWVzOiBzdHIpIC0+IGRpY3Q6CiAgICAiIiJBY3F1aXNpdGlvbiBz
#5#ZXR0aW5ncyBvZiBvbmUgc2VyaWVzLiBUaGUgTGVpY2EgYmxvY2sgcmVwZWF0cyBhIGtleSBvbmNl
#5#IHBlcgogICAgam9iIGJsb2NrIChgTERNX0Jsb2NrX+KApmApIGFuZCBvbmNlIGF0IHRoZSB0b3Ag
#5#bGV2ZWwgZm9yIHRoZSBleHBvc3VyZSB0aGF0IHdhcwogICAgYWN0dWFsbHkgdGFrZW47IHRoZSB0
#5#b3AtbGV2ZWwgbGluZSB3aW5zLCBmaXJzdCBibG9jayBsaW5lIGFzIGZhbGxiYWNrLiIiIgogICAg
#5#IyBFdmVyeSBsaW5lIG9mIGEgc2VyaWVzIHN0YXJ0cyB3aXRoIGA8c2VyaWVzPiBJbWFnZeKApmA7
#5#IHRoZSB0cmFpbGluZyAiSW1hZ2UiCiAgICAjIGtlZXBzIGBFOC4wIHgzLjIgMjQwOTEzYCBmcm9t
#5#IGFsc28gbWF0Y2hpbmcgYEU4LjAgeDMuMiAyNDA5MTMgMmAuCiAgICBwcmVmaXggPSBzZXJpZXMg
#5#KyAiIEltYWdlIgogICAgbGluZXMgPSBbbFtsZW4oc2VyaWVzKSArIDE6XSBmb3IgbCBpbiBpbmZv
#5#LnNwbGl0bGluZXMoKSBpZiBsLnN0YXJ0c3dpdGgocHJlZml4KV0KICAgIG91dCA9IHt9CiAgICBm
#5#b3Igc3VmZml4LCAobmFtZSwgY2FzdCkgaW4gTEVJQ0FfRklFTERTLml0ZW1zKCk6CiAgICAgICAg
#5#dmFsdWUgPSBfcGlja192YWx1ZShsaW5lcywgc3VmZml4KQogICAgICAgIGlmIHZhbHVlIGlzIG5v
#5#dCBOb25lOgogICAgICAgICAgICBvdXRbbmFtZV0gPSB2YWx1ZSBpZiBjYXN0IGlzIHN0ciBlbHNl
#5#IF9zYWZlX2Zsb2F0KHZhbHVlKQogICAgaWYgImV4cG9zdXJlUyIgaW4gb3V0OgogICAgICAgIG91
#5#dFsiZXhwb3N1cmVNcyJdID0gcm91bmQob3V0LnBvcCgiZXhwb3N1cmVTIikgKiAxMDAwLjAsIDMp
#5#CiAgICBpZiBvdXQuZ2V0KCJjYW1lcmEiKToKICAgICAgICBvdXRbImNhbWVyYSJdID0gb3V0WyJj
#5#YW1lcmEiXS5zcGxpdCgiLSIpWzBdCiAgICByZXR1cm4ge2s6IHYgZm9yIGssIHYgaW4gb3V0Lml0
#5#ZW1zKCkgaWYgdiBub3QgaW4gKE5vbmUsICIiLCAwLjApfQoKCmRlZiBfcGlja192YWx1ZShsaW5l
#5#czogbGlzdCwgc3VmZml4OiBzdHIpOgogICAgIiIiTEFTIFggd3JpdGVzICIwIiBmb3IgYSBzZXR0
#5#aW5nIHRoYXQgZG9lcyBub3QgYXBwbHkgdG8gYSBibG9jazsgdGhvc2UKICAgIHBsYWNlaG9sZGVy
#5#cyBuZXZlciBiZWF0IGEgcmVhbCB2YWx1ZS4iIiIKICAgIGhpdHMgPSBbKGssIHYuc3RyaXAoKSkg
#5#Zm9yIGssIF8sIHYgaW4gKGwucGFydGl0aW9uKCIgPSAiKSBmb3IgbCBpbiBsaW5lcykKICAgICAg
#5#ICAgICAgaWYgay5yc3RyaXAoKS5lbmRzd2l0aChzdWZmaXgpIGFuZCB2LnN0cmlwKCkgbm90IGlu
#5#ICgiIiwgIjAiKV0KICAgIGlmIG5vdCBoaXRzOgogICAgICAgIHJldHVybiBOb25lCiAgICB0b3Ag
#5#PSBbdiBmb3IgaywgdiBpbiBoaXRzIGlmICJMRE1fQmxvY2siIG5vdCBpbiBrXQogICAgcmV0dXJu
#5#ICh0b3Agb3IgW3YgZm9yIF8sIHYgaW4gaGl0c10pWzBdCgoKZGVmIF9zYWZlX2Zsb2F0KHRleHQ6
#5#IHN0cik6CiAgICB0cnk6CiAgICAgICAgcmV0dXJuIGZsb2F0KHRleHQpCiAgICBleGNlcHQgKFR5
#5#cGVFcnJvciwgVmFsdWVFcnJvcik6CiAgICAgICAgcmV0dXJuIE5vbmUKCgojIOKUgOKUgCBGaWxl
#5#LW5hbWUgY29udmVudGlvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSAClNUQUdFX1JYID0gcmUuY29tcGlsZShyIlxiRShcZCg/OlsuLF1cZHsxLDJ9KT8p
#5#XGIiKQpaT09NX1JYID0gcmUuY29tcGlsZShyIlxieChcZCsoPzpbLixdXGQrKT8pXGIiLCByZS5J
#5#R05PUkVDQVNFKQpEQVRFX1JYID0gcmUuY29tcGlsZShyIlxiKFxkezZ9KVxiIikKTElORV9SWCA9
#5#IHJlLmNvbXBpbGUociJcYihbQS1aYS16MC05XSt4W0EtWmEtel1bQS1aYS16MC05XSopXGIiKQoK
#5#CmRlZiBwYXJzZV9maWxlbmFtZShzdGVtOiBzdHIsIGxpbmVfb3ZlcnJpZGU6IHN0ciA9IE5vbmUp
#5#IC0+IGRpY3Q6CiAgICAiIiJgPGxpZj4gLSA8c3RhZ2U+IHg8em9vbT4gPGRpc3NlY3Rpb24geXlt
#5#bWRkPiBbPG4+IFs8bT5dXWAgYXMgdGhlIGxhYiBuYW1lcwogICAgaXRzIGV4cG9ydHMuIE1pc3Np
#5#bmcgcGFydHMgc3RheSBOb25lOyBub3RoaW5nIGlzIGludmVudGVkLiIiIgogICAgbGlmLCBzZXAs
#5#IHNlcmllcyA9IHN0ZW0ucGFydGl0aW9uKCIubGlmIC0gIikKICAgIGlmIG5vdCBzZXA6CiAgICAg
#5#ICAgbGlmLCBzZXJpZXMgPSAiIiwgc3RlbQogICAgc3RhZ2VfbSA9IFNUQUdFX1JYLnNlYXJjaChz
#5#ZXJpZXMpIG9yIFNUQUdFX1JYLnNlYXJjaChsaWYpCiAgICB6b29tX20gPSBaT09NX1JYLnNlYXJj
#5#aChzZXJpZXMpCiAgICBkYXRlcyA9IFtkIGZvciBkIGluIERBVEVfUlguZmluZGFsbChzZXJpZXMp
#5#IGlmIF92YWxpZF95eW1tZGQoZCldCiAgICB0YWlsID0gc2VyaWVzW3pvb21fbS5lbmQoKTpdIGlm
#5#IHpvb21fbSBlbHNlICIiCiAgICBpbmRleCA9ICIgIi5qb2luKHQgZm9yIHQgaW4gdGFpbC5zcGxp
#5#dCgpIGlmIHQuaXNkaWdpdCgpIGFuZCB0IG5vdCBpbiBkYXRlcykKICAgIGxpbmVfbSA9IExJTkVf
#5#Ulguc2VhcmNoKGxpZikgb3IgTElORV9SWC5zZWFyY2goc2VyaWVzKQogICAgc3RhZ2UgPSBzdGFn
#5#ZV9tLmdyb3VwKDEpLnJlcGxhY2UoIiwiLCAiLiIpIGlmIHN0YWdlX20gZWxzZSBOb25lCiAgICBy
#5#ZXR1cm4gewogICAgICAgICJsaWYiOiAobGlmICsgIi5saWYiKSBpZiBsaWYgZWxzZSBOb25lLAog
#5#ICAgICAgICJzZXJpZXMiOiBzZXJpZXMuc3RyaXAoKSwKICAgICAgICAic3RhZ2UiOiBmIkV7c3Rh
#5#Z2V9IiBpZiBzdGFnZSBlbHNlIE5vbmUsCiAgICAgICAgInN0YWdlTnVtZXJpYyI6IGZsb2F0KHN0
#5#YWdlKSBpZiBzdGFnZSBlbHNlIE5vbmUsCiAgICAgICAgInpvb20iOiBmbG9hdCh6b29tX20uZ3Jv
#5#dXAoMSkucmVwbGFjZSgiLCIsICIuIikpIGlmIHpvb21fbSBlbHNlIE5vbmUsCiAgICAgICAgImRp
#5#c3NlY3Rpb25EYXRlIjogX2lzb19kYXRlKGRhdGVzWzBdKSBpZiBkYXRlcyBlbHNlIE5vbmUsCiAg
#5#ICAgICAgImluZGV4IjogaW5kZXggb3IgTm9uZSwKICAgICAgICAibGluZSI6IGxpbmVfb3ZlcnJp
#5#ZGUgb3IgKGxpbmVfbS5ncm91cCgxKSBpZiBsaW5lX20gZWxzZSBOb25lKSwKICAgIH0KCgpkZWYg
#5#X3ZhbGlkX3l5bW1kZCh0ZXh0OiBzdHIpIC0+IGJvb2w6CiAgICB0cnk6CiAgICAgICAgZGF0ZXRp
#5#bWUuc3RycHRpbWUodGV4dCwgIiV5JW0lZCIpCiAgICAgICAgcmV0dXJuIFRydWUKICAgIGV4Y2Vw
#5#dCBWYWx1ZUVycm9yOgogICAgICAgIHJldHVybiBGYWxzZQoKCmRlZiBfaXNvX2RhdGUoeXltbWRk
#5#OiBzdHIpIC0+IHN0cjoKICAgIHJldHVybiBkYXRldGltZS5zdHJwdGltZSh5eW1tZGQsICIleSVt
#5#JWQiKS5zdHJmdGltZSgiJVktJW0tJWQiKQoKCmRlZiBkYXRhc2V0X2ZvbGRlcl9uYW1lKHBhcnNl
#5#ZDogZGljdCkgLT4gc3RyOgogICAgIiIiYDxsaW5lPi08c3RhZ2U+LXg8em9vbT4tPHl5bW1kZD4t
#5#PGluZGV4PmAsIHN0YWdlIHdpdGhvdXQgaXRzIGRvdAogICAgKEU3Ljc1IOKGkiBFNzc1KSBhcyB0
#5#aGUgcGxhdGZvcm0ncyBvdGhlciBkYXRhc2V0cyBzcGVsbCBpdC4iIiIKICAgIHBhcnRzID0gW3Bh
#5#cnNlZC5nZXQoImxpbmUiKSwKICAgICAgICAgICAgIHBhcnNlZFsic3RhZ2UiXS5yZXBsYWNlKCIu
#5#IiwgIiIpIGlmIHBhcnNlZC5nZXQoInN0YWdlIikgZWxzZSBOb25lLAogICAgICAgICAgICAgZiJ4
#5#e3BhcnNlZFsnem9vbSddOmd9IiBpZiBwYXJzZWQuZ2V0KCJ6b29tIikgZWxzZSBOb25lLAogICAg
#5#ICAgICAgICAgcGFyc2VkWyJkaXNzZWN0aW9uRGF0ZSJdLnJlcGxhY2UoIi0iLCAiIilbMjpdIGlm
#5#IHBhcnNlZC5nZXQoImRpc3NlY3Rpb25EYXRlIikgZWxzZSBOb25lLAogICAgICAgICAgICAgcGFy
#5#c2VkLmdldCgiaW5kZXgiKV0KICAgIGlmIG5vdCAocGFyc2VkLmdldCgiem9vbSIpIG9yIHBhcnNl
#5#ZC5nZXQoImRpc3NlY3Rpb25EYXRlIikpOgogICAgICAgIHBhcnRzLmFwcGVuZChwYXJzZWQuZ2V0
#5#KCJzZXJpZXMiKSkKICAgIHJldHVybiBzbHVnaWZ5KCItIi5qb2luKHAgZm9yIHAgaW4gcGFydHMg
#5#aWYgcCkpIG9yICJ3aG9sZW1vdW50IgoKCmRlZiBzbHVnaWZ5KHRleHQ6IHN0cikgLT4gc3RyOgog
#5#ICAgcmV0dXJuIHJlLnN1YihyIi17Mix9IiwgIi0iLCByZS5zdWIociJbXkEtWmEtejAtOS5fLV0r
#5#IiwgIi0iLCB0ZXh0KSkuc3RyaXAoIi0uIikKCgojIOKUgOKUgCBPdXRwdXRzIOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgApkZWYgd3JpdGVfaW1hZ2VzKHJnYjogbnAubmRhcnJheSwg
#5#b3V0X2RpcjogUGF0aCkgLT4gZGljdDoKICAgIG5hdGl2ZSA9IEltYWdlLmZyb21hcnJheShyZ2Is
#5#IG1vZGU9IlJHQiIpCiAgICBuYXRpdmUuc2F2ZShvdXRfZGlyIC8gImltYWdlLndlYnAiLCAiV0VC
#5#UCIsIHF1YWxpdHk9TkFUSVZFX1FVQUxJVFksIG1ldGhvZD02KQoKICAgIHByZXZpZXcgPSBuYXRp
#5#dmUuY29weSgpCiAgICBwcmV2aWV3LnRodW1ibmFpbCgoUFJFVklFV19MT05HX1NJREUsIFBSRVZJ
#5#RVdfTE9OR19TSURFKSwgSW1hZ2UuUmVzYW1wbGluZy5MQU5DWk9TKQogICAgcHJldmlldy5zYXZl
#5#KG91dF9kaXIgLyAicHJldmlldy53ZWJwIiwgIldFQlAiLCBxdWFsaXR5PVBSRVZJRVdfUVVBTElU
#5#WSwgbWV0aG9kPTYpCgogICAgX3dyaXRlX3NxdWFyZV90aHVtYm5haWwobmF0aXZlLCBvdXRfZGly
#5#IC8gInRodW1ibmFpbC53ZWJwIikKICAgIHJldHVybiB7Im5hdGl2ZSI6ICJpbWFnZS53ZWJwIiwg
#5#IndpZHRoIjogbmF0aXZlLndpZHRoLCAiaGVpZ2h0IjogbmF0aXZlLmhlaWdodCwKICAgICAgICAg
#5#ICAgInByZXZpZXciOiAicHJldmlldy53ZWJwIiwgInByZXZpZXdXaWR0aCI6IHByZXZpZXcud2lk
#5#dGgsCiAgICAgICAgICAgICJwcmV2aWV3SGVpZ2h0IjogcHJldmlldy5oZWlnaHR9CgoKZGVmIF93
#5#cml0ZV9zcXVhcmVfdGh1bWJuYWlsKGltZzogSW1hZ2UuSW1hZ2UsIHBhdGg6IFBhdGgpIC0+IE5v
#5#bmU6CiAgICBzY2FsZWQgPSBpbWcuY29weSgpCiAgICBzY2FsZWQudGh1bWJuYWlsKChUSFVNQl9T
#5#SVpFLCBUSFVNQl9TSVpFKSwgSW1hZ2UuUmVzYW1wbGluZy5MQU5DWk9TKQogICAgY2FudmFzID0g
#5#SW1hZ2UubmV3KCJSR0IiLCAoVEhVTUJfU0laRSwgVEhVTUJfU0laRSksIFRIVU1CX0JBQ0tHUk9V
#5#TkQpCiAgICBjYW52YXMucGFzdGUoc2NhbGVkLCAoKFRIVU1CX1NJWkUgLSBzY2FsZWQud2lkdGgp
#5#IC8vIDIsIChUSFVNQl9TSVpFIC0gc2NhbGVkLmhlaWdodCkgLy8gMikpCiAgICBjYW52YXMuc2F2
#5#ZShwYXRoLCAiV0VCUCIsIHF1YWxpdHk9ODgsIG1ldGhvZD02KQoKCmRlZiBidWlsZF9tZXRhZGF0
#5#YShmb2xkZXI6IHN0ciwgcGFyc2VkOiBkaWN0LCBpbWFnZTogZGljdCwgcHhfdW0sIGNhbF9zdGF0
#5#dXM6IHN0ciwKICAgICAgICAgICAgICAgICAgIGFjcXVpc2l0aW9uOiBkaWN0LCBzb3VyY2U6IFBh
#5#dGgsIHN0YWluaW5nOiBzdHIpIC0+IGRpY3Q6CiAgICBub3cgPSBkYXRldGltZS5ub3coKS5pc29m
#5#b3JtYXQoKQogICAgdywgaCA9IGltYWdlWyJ3aWR0aCJdLCBpbWFnZVsiaGVpZ2h0Il0KICAgIHBo
#5#eXNpY2FsID0gKHsieCI6IHJvdW5kKHcgKiBweF91bSwgMyksICJ5Ijogcm91bmQoaCAqIHB4X3Vt
#5#LCAzKX0gaWYgcHhfdW0gZWxzZSBOb25lKQogICAgc3RhZ2VfdHh0ID0gcGFyc2VkWyJzdGFnZSJd
#5#IG9yICJVbmtub3duIgogICAgcmV0dXJuIHsKICAgICAgICAiaWQiOiBmb2xkZXIsICJuYW1lIjog
#5#Zm9sZGVyLCAidHlwZSI6ICJ3aG9sZW1vdW50IiwKICAgICAgICAic3RhZ2UiOiBzdGFnZV90eHQs
#5#ICJzdGFnZU51bWVyaWMiOiBwYXJzZWRbInN0YWdlTnVtZXJpYyJdIG9yIDAuMCwKICAgICAgICAi
#5#ZW1icnlvIjogTm9uZSwgImxpbmUiOiBwYXJzZWQuZ2V0KCJsaW5lIiksICJzdGFpbmluZyI6IHN0
#5#YWluaW5nIG9yICIiLAogICAgICAgICJkYXRlIjogcGFyc2VkLmdldCgiZGlzc2VjdGlvbkRhdGUi
#5#KSwKICAgICAgICAiZGltZW5zaW9ucyI6IHsieCI6IHcsICJ5IjogaCwgInoiOiAxLCAiYyI6IDMs
#5#ICJ0IjogMX0sCiAgICAgICAgInBpeGVsU2l6ZVVtIjogKHsieCI6IHJvdW5kKHB4X3VtLCA2KSwg
#5#InkiOiByb3VuZChweF91bSwgNil9IGlmIHB4X3VtIGVsc2UgTm9uZSksCiAgICAgICAgInBoeXNp
#5#Y2FsU2l6ZVVtIjogcGh5c2ljYWwsCiAgICAgICAgImNhbGlicmF0aW9uU3RhdHVzIjogY2FsX3N0
#5#YXR1cywKICAgICAgICAiY2FsaWJyYXRpb25Ob3RlIjogKCJQaXhlbCBzaXplIHJlYWQgZnJvbSB0
#5#aGUgSW1hZ2VKIHJlc29sdXRpb24gdGFncyAobWljcm9ucykuIgogICAgICAgICAgICAgICAgICAg
#5#ICAgICAgICAgaWYgY2FsX3N0YXR1cyA9PSAiZXhhY3QiIGVsc2UKICAgICAgICAgICAgICAgICAg
#5#ICAgICAgICAgICJObyBjYWxpYnJhdGVkIHJlc29sdXRpb24gaW4gdGhlIGZpbGUg4oCUIHNjYWxl
#5#IGJhciBhbmQgbWVhc3VyZW1lbnRzIHVuYXZhaWxhYmxlLiIpLAogICAgICAgICJpbWFnZSI6IGlt
#5#YWdlLAogICAgICAgICJhY3F1aXNpdGlvbiI6IHsibW9kYWxpdHkiOiAiYnJpZ2h0ZmllbGQtc3Rl
#5#cmVvIiwgInNvdXJjZUZpbGUiOiBzb3VyY2UubmFtZSwKICAgICAgICAgICAgICAgICAgICAgICAg
#5#ImxpZkZpbGUiOiBwYXJzZWQuZ2V0KCJsaWYiKSwgInNlcmllcyI6IHBhcnNlZC5nZXQoInNlcmll
#5#cyIpLAogICAgICAgICAgICAgICAgICAgICAgICAiZGlzc2VjdGlvbkRhdGUiOiBwYXJzZWQuZ2V0
#5#KCJkaXNzZWN0aW9uRGF0ZSIpLAogICAgICAgICAgICAgICAgICAgICAgICAiem9vbU5vbWluYWwi
#5#OiBwYXJzZWQuZ2V0KCJ6b29tIiksICoqYWNxdWlzaXRpb259LAogICAgICAgICJjaGFubmVscyI6
#5#IFtdLAogICAgICAgICJkZXNjcmlwdGlvbiI6IF9kZXNjcmlwdGlvbihzdGFnZV90eHQsIHBhcnNl
#5#ZCwgYWNxdWlzaXRpb24pLAogICAgICAgICJjcmVhdGVkIjogbm93LCAibGFzdE1vZGlmaWVkIjog
#5#bm93LCAiY29uZmlndXJlZCI6IFRydWUsCiAgICAgICAgImZvbGRlck5hbWUiOiBmb2xkZXIsCiAg
#5#ICAgICAgInRodW1ibmFpbCI6IGYiREFUQV9XRUIve1RZUEVfRElSfS97Zm9sZGVyfS90aHVtYm5h
#5#aWwud2VicCIsCiAgICAgICAgImhpZGRlbiI6IEZhbHNlLAogICAgfQoKCmRlZiBfZGVzY3JpcHRp
#5#b24oc3RhZ2U6IHN0ciwgcGFyc2VkOiBkaWN0LCBhY3E6IGRpY3QpIC0+IHN0cjoKICAgIGJpdHMg
#5#PSBbZiJXaG9sZS1tb3VudCBjb2xvdXIgcGhvdG9ncmFwaCwge3N0YWdlfSBlbWJyeW8iXQogICAg
#5#aWYgcGFyc2VkLmdldCgibGluZSIpOgogICAgICAgIGJpdHMuYXBwZW5kKHBhcnNlZFsibGluZSJd
#5#KQogICAgaWYgYWNxLmdldCgibWljcm9zY29wZSIpOgogICAgICAgIGJpdHMuYXBwZW5kKGYie2Fj
#5#cVsnbWljcm9zY29wZSddfSBzdGVyZW9taWNyb3Njb3BlIikKICAgIGlmIHBhcnNlZC5nZXQoInpv
#5#b20iKToKICAgICAgICBiaXRzLmFwcGVuZChmInpvb20geHtwYXJzZWRbJ3pvb20nXTpnfSIpCiAg
#5#ICByZXR1cm4gIiwgIi5qb2luKGJpdHMpICsgIi4iCgoKZGVmIG1lcmdlX2N1cmF0ZWQoZXhpc3Rp
#5#bmc6IGRpY3QsIGZyZXNoOiBkaWN0KSAtPiBkaWN0OgogICAgIiIiUmUtaW1wb3J0IHJlZnJlc2hl
#5#cyBtZWFzdXJlbWVudHMsIGtlZXBzIHdoYXQgdGhlIGxhYiBlZGl0ZWQuIiIiCiAgICBtZXJnZWQg
#5#PSBkaWN0KGZyZXNoKQogICAgZm9yIGtleSBpbiBDVVJBVEVEX0tFWVM6CiAgICAgICAgaWYga2V5
#5#IGluIGV4aXN0aW5nOgogICAgICAgICAgICBtZXJnZWRba2V5XSA9IGV4aXN0aW5nW2tleV0KICAg
#5#IG1lcmdlZFsibGFzdE1vZGlmaWVkIl0gPSBmcmVzaFsibGFzdE1vZGlmaWVkIl0KICAgIHJldHVy
#5#biBtZXJnZWQKCgpkZWYgd3JpdGVfZG93bmxvYWQoc291cmNlOiBQYXRoLCBvdXRfZGlyOiBQYXRo
#5#LCBtZXRhOiBkaWN0KSAtPiBOb25lOgogICAgZGwgPSBvdXRfZGlyIC8gImRvd25sb2FkIgogICAg
#5#ZGwubWtkaXIoZXhpc3Rfb2s9VHJ1ZSkKICAgIHRhcmdldCA9IGRsIC8gc291cmNlLm5hbWUKICAg
#5#IGlmIHRhcmdldC5leGlzdHMoKToKICAgICAgICB0YXJnZXQudW5saW5rKCkKICAgIHRyeToKICAg
#5#ICAgICBvcy5saW5rKHNvdXJjZSwgdGFyZ2V0KQogICAgZXhjZXB0IE9TRXJyb3I6CiAgICAgICAg
#5#c2h1dGlsLmNvcHkyKHNvdXJjZSwgdGFyZ2V0KQogICAgKGRsIC8gIlJFQURNRS50eHQiKS53cml0
#5#ZV90ZXh0KF9yZWFkbWUoc291cmNlLCBtZXRhKSwgZW5jb2Rpbmc9InV0Zi04IikKCgpkZWYgX3Jl
#5#YWRtZShzb3VyY2U6IFBhdGgsIG1ldGE6IGRpY3QpIC0+IHN0cjoKICAgIGFjcSA9IG1ldGFbImFj
#5#cXVpc2l0aW9uIl0KICAgIHB4ID0gbWV0YS5nZXQoInBpeGVsU2l6ZVVtIikKICAgIGxpbmVzID0g
#5#WwogICAgICAgIGYie21ldGFbJ25hbWUnXX0iLAogICAgICAgICI9IiAqIGxlbihtZXRhWyJuYW1l
#5#Il0pLAogICAgICAgICIiLAogICAgICAgIGYiVHlwZSAgICAgICAgOiB3aG9sZW1vdW50IHBob3Rv
#5#Z3JhcGggKHthY3EuZ2V0KCdtb2RhbGl0eScpfSkiLAogICAgICAgIGYiU3RhZ2UgICAgICAgOiB7
#5#bWV0YVsnc3RhZ2UnXX0iLAogICAgICAgIGYiTGluZSAgICAgICAgOiB7bWV0YS5nZXQoJ2xpbmUn
#5#KSBvciAnLSd9IiwKICAgICAgICBmIlN0YWluaW5nICAgIDoge21ldGEuZ2V0KCdzdGFpbmluZycp
#5#IG9yICctJ30iLAogICAgICAgIGYiSW1hZ2UgICAgICAgOiB7bWV0YVsnZGltZW5zaW9ucyddWyd4
#5#J119IHgge21ldGFbJ2RpbWVuc2lvbnMnXVsneSddfSBweCwgUkdCIDgtYml0IiwKICAgICAgICBm
#5#IlBpeGVsIHNpemUgIDoge3B4Wyd4J106LjRmfSB1bS9weCIgaWYgcHggZWxzZSAiUGl4ZWwgc2l6
#5#ZSAgOiB1bmtub3duIiwKICAgICAgICBmIlNvdXJjZSAgICAgIDoge3NvdXJjZS5uYW1lfSIsCiAg
#5#ICAgICAgZiJMSUYgZmlsZSAgICA6IHthY3EuZ2V0KCdsaWZGaWxlJykgb3IgJy0nfSAgKHNlcmll
#5#cyB7YWNxLmdldCgnc2VyaWVzJykgb3IgJy0nfSkiLAogICAgICAgIGYiTWljcm9zY29wZSAgOiB7
#5#YWNxLmdldCgnbWljcm9zY29wZScpIG9yICctJ30gIGNhbWVyYSB7YWNxLmdldCgnY2FtZXJhJykg
#5#b3IgJy0nfSIsCiAgICAgICAgZiJab29tICAgICAgICA6IHthY3EuZ2V0KCd6b29tJykgb3IgYWNx
#5#LmdldCgnem9vbU5vbWluYWwnKSBvciAnLSd9IiwKICAgICAgICBmIkV4cG9zdXJlICAgIDoge2Fj
#5#cS5nZXQoJ2V4cG9zdXJlTXMnKSBvciAnLSd9IG1zLCBnYWluIHthY3EuZ2V0KCdnYWluJykgb3Ig
#5#Jy0nfSIsCiAgICAgICAgZiJEaXNzZWN0aW9uICA6IHthY3EuZ2V0KCdkaXNzZWN0aW9uRGF0ZScp
#5#IG9yICctJ30iLAogICAgICAgICIiLAogICAgICAgICJUaGUgVElGRiBpcyB0aGUgdW50b3VjaGVk
#5#IEltYWdlSiBleHBvcnQ7IGltYWdlLndlYnAgYmVzaWRlIGl0IGlzIHRoZSIsCiAgICAgICAgImRp
#5#c3BsYXkgY29weSB1c2VkIGJ5IHRoZSB2aWV3ZXIgKGxvc3N5LCBxdWFsaXR5IDkwKS4iLAogICAg
#5#XQogICAgcmV0dXJuICJcbiIuam9pbihsaW5lcykgKyAiXG4iCgoKIyDilIDilIAgT3JjaGVzdHJh
#5#dGlvbiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIDilIAKZGVmIGltcG9ydF90aWZmKHNvdXJjZTogUGF0aCwgb3V0cHV0
#5#X3Jvb3Q6IFBhdGgsIGFyZ3MpIC0+IFBhdGg6CiAgICB3aXRoIEltYWdlLm9wZW4oc291cmNlKSBh
#5#cyBpbToKICAgICAgICBpaiA9IHJlYWRfaWpfbWV0YWRhdGEoaW0pCiAgICAgICAgZGVzY3JpcHRp
#5#b24gPSBzdHIoaW0udGFnX3YyLmdldChJTUFHRV9ERVNDUklQVElPTl9UQUcsICIiKSkKICAgICAg
#5#ICBweF91bSwgY2FsX3N0YXR1cyA9IHBpeGVsX3NpemVfdW0oaW0sIGRlc2NyaXB0aW9uKQogICAg
#5#ICAgIHJnYiA9IGNvbXBvc2VfcmdiKHJlYWRfcGxhbmVzKGltKSwgaWouZ2V0KCJsdXRzIiwgW10p
#5#KQoKICAgIHBhcnNlZCA9IHBhcnNlX2ZpbGVuYW1lKHNvdXJjZS5zdGVtLCBhcmdzLmxpbmUpCiAg
#5#ICBmb2xkZXIgPSBkYXRhc2V0X2ZvbGRlcl9uYW1lKHBhcnNlZCkKICAgIG91dF9kaXIgPSBvdXRw
#5#dXRfcm9vdCAvIFRZUEVfRElSIC8gZm9sZGVyCiAgICBtZXRhX3BhdGggPSBvdXRfZGlyIC8gIm1l
#5#dGFkYXRhLmpzb24iCiAgICBpZiBtZXRhX3BhdGguZXhpc3RzKCkgYW5kIG5vdCBhcmdzLmZvcmNl
#5#OgogICAgICAgIHByaW50KGYiICBbc2tpcF0ge2ZvbGRlcn0gZXhpc3RzICh1c2UgLS1mb3JjZSB0
#5#byByZS1pbXBvcnQpIikKICAgICAgICByZXR1cm4gb3V0X2RpcgogICAgb3V0X2Rpci5ta2Rpcihw
#5#YXJlbnRzPVRydWUsIGV4aXN0X29rPVRydWUpCgogICAgaW1hZ2UgPSB3cml0ZV9pbWFnZXMocmdi
#5#LCBvdXRfZGlyKQogICAgaW5mbyA9IChpai5nZXQoImluZm8iKSBvciBbIiJdKVswXQogICAgc2Vy
#5#aWVzID0gX3Nlcmllc19uYW1lKGlqLCBwYXJzZWQpCiAgICBhY3F1aXNpdGlvbiA9IGxlaWNhX2Zp
#5#ZWxkcyhpbmZvLCBzZXJpZXMpIGlmIHNlcmllcyBlbHNlIHt9CiAgICBmcmVzaCA9IGJ1aWxkX21l
#5#dGFkYXRhKGZvbGRlciwgcGFyc2VkLCBpbWFnZSwgcHhfdW0sIGNhbF9zdGF0dXMsIGFjcXVpc2l0
#5#aW9uLCBzb3VyY2UsIGFyZ3Muc3RhaW5pbmcpCiAgICBtZXRhID0gbWVyZ2VfY3VyYXRlZChfbG9h
#5#ZF9qc29uKG1ldGFfcGF0aCksIGZyZXNoKSBpZiBtZXRhX3BhdGguZXhpc3RzKCkgZWxzZSBmcmVz
#5#aAogICAgbWV0YV9wYXRoLndyaXRlX3RleHQoanNvbi5kdW1wcyhtZXRhLCBpbmRlbnQ9MiwgZW5z
#5#dXJlX2FzY2lpPUZhbHNlKSwgZW5jb2Rpbmc9InV0Zi04IikKICAgIGlmIGFyZ3Mud2l0aF9kb3du
#5#bG9hZHM6CiAgICAgICAgd3JpdGVfZG93bmxvYWQoc291cmNlLCBvdXRfZGlyLCBtZXRhKQoKICAg
#5#IHB4X3R4dCA9IGYie3B4X3VtOi4zZn0gdW0vcHgiIGlmIHB4X3VtIGVsc2UgInVuY2FsaWJyYXRl
#5#ZCIKICAgIHByaW50KGYiICBbb2tdIHtmb2xkZXJ9ICB7aW1hZ2VbJ3dpZHRoJ119eHtpbWFnZVsn
#5#aGVpZ2h0J119ICB7bWV0YVsnc3RhZ2UnXX0gIHtweF90eHR9IikKICAgIHJldHVybiBvdXRfZGly
#5#CgoKZGVmIF9zZXJpZXNfbmFtZShpajogZGljdCwgcGFyc2VkOiBkaWN0KSAtPiBzdHI6CiAgICAi
#5#IiJJbWFnZUogbGFiZWxzIGVhY2ggcGxhbmUgYGM6MS8zIC0gPHNlcmllcz5gOyB0aGUgTGVpY2Eg
#5#YmxvY2sgaXMga2V5ZWQgYnkKICAgIHRoYXQgc2VyaWVzIG5hbWUsIHdoaWNoIGlzIGFsc28gdGhl
#5#IG9uZSB0aGUgbGFiIG1heSBoYXZlIHJlbmFtZWQgaW4gTEFTIFguIiIiCiAgICBsYWJlbHMgPSBp
#5#ai5nZXQoImxhYmwiKSBvciBbXQogICAgaWYgbGFiZWxzIGFuZCAiIC0gIiBpbiBsYWJlbHNbMF06
#5#CiAgICAgICAgcmV0dXJuIGxhYmVsc1swXS5zcGxpdCgiIC0gIiwgMSlbMV0uc3RyaXAoKQogICAg
#5#cmV0dXJuIHBhcnNlZC5nZXQoInNlcmllcyIpIG9yICIiCgoKZGVmIF9sb2FkX2pzb24ocGF0aDog
#5#UGF0aCkgLT4gZGljdDoKICAgIHRyeToKICAgICAgICByZXR1cm4ganNvbi5sb2FkcyhwYXRoLnJl
#5#YWRfdGV4dChlbmNvZGluZz0idXRmLTgiKSkKICAgIGV4Y2VwdCAoT1NFcnJvciwgVmFsdWVFcnJv
#5#cik6CiAgICAgICAgcmV0dXJuIHt9CgoKZGVmIGNvbGxlY3RfaW5wdXRzKGlucHV0X3BhdGg6IFBh
#5#dGgsIG9ubHk6IHN0cikgLT4gbGlzdDoKICAgIGlmIGlucHV0X3BhdGguaXNfZmlsZSgpOgogICAg
#5#ICAgIGZpbGVzID0gW2lucHV0X3BhdGhdCiAgICBlbHNlOgogICAgICAgIGZpbGVzID0gc29ydGVk
#5#KHAgZm9yIHAgaW4gaW5wdXRfcGF0aC5pdGVyZGlyKCkKICAgICAgICAgICAgICAgICAgICAgICBp
#5#ZiBwLnN1ZmZpeC5sb3dlcigpIGluICgiLnRpZiIsICIudGlmZiIpIGFuZCBwLmlzX2ZpbGUoKSkK
#5#ICAgIGlmIG9ubHk6CiAgICAgICAgZmlsZXMgPSBbZiBmb3IgZiBpbiBmaWxlcyBpZiBmbm1hdGNo
#5#LmZubWF0Y2goZi5uYW1lLCBvbmx5KV0KICAgIHJldHVybiBmaWxlcwoKCmRlZiBtYWluKCkgLT4g
#5#aW50OgogICAgYXAgPSBhcmdwYXJzZS5Bcmd1bWVudFBhcnNlcihkZXNjcmlwdGlvbj0iV2hvbGVt
#5#b3VudCBwaG90b2dyYXBoIGltcG9ydGVyIChvbmUgVElGRiDihpIgb25lIGRhdGFzZXQpIikKICAg
#5#IGFwLmFkZF9hcmd1bWVudCgiLS1pbnB1dCIsIHJlcXVpcmVkPVRydWUsIGhlbHA9IkRpcmVjdG9y
#5#eSBvZiBUSUZGcywgb3Igb25lIFRJRkYuIikKICAgIGFwLmFkZF9hcmd1bWVudCgiLS1vdXRwdXQi
#5#LCByZXF1aXJlZD1UcnVlLCBoZWxwPSJEQVRBX1dFQiBkaXJlY3Rvcnkgb2YgdGhlIHdlYiBwbGF0
#5#Zm9ybS4iKQogICAgYXAuYWRkX2FyZ3VtZW50KCItLW9ubHkiLCBkZWZhdWx0PU5vbmUsIGhlbHA9
#5#Ikdsb2Igb24gdGhlIGZpbGUgbmFtZSAoZS5nLiAnKkU4LjAqJykuIikKICAgIGFwLmFkZF9hcmd1
#5#bWVudCgiLS1saW5lIiwgZGVmYXVsdD1Ob25lLCBoZWxwPSJSZXBvcnRlci9zdHJhaW4gbGluZSBs
#5#YWJlbCAoZGVmYXVsdDogcGFyc2VkIGZyb20gdGhlIC5saWYgbmFtZSkuIikKICAgIGFwLmFkZF9h
#5#cmd1bWVudCgiLS1zdGFpbmluZyIsIGRlZmF1bHQ9IiIsIGhlbHA9IlN0YWluaW5nIGxhYmVsIHN0
#5#b3JlZCBpbiBtZXRhZGF0YSAoZS5nLiBYLWdhbCkuIikKICAgIGFwLmFkZF9hcmd1bWVudCgiLS13
#5#aXRoLWRvd25sb2FkcyIsIGFjdGlvbj0ic3RvcmVfdHJ1ZSIsIGhlbHA9IlBsYWNlIHRoZSBvcmln
#5#aW5hbCBUSUZGICsgUkVBRE1FIHVuZGVyIGRvd25sb2FkLy4iKQogICAgYXAuYWRkX2FyZ3VtZW50
#5#KCItLWZvcmNlIiwgYWN0aW9uPSJzdG9yZV90cnVlIiwgaGVscD0iUmUtaW1wb3J0IG92ZXIgYW4g
#5#ZXhpc3RpbmcgZGF0YXNldCAoY3VyYXRpb24gaXMgcHJlc2VydmVkKS4iKQogICAgYXJncyA9IGFw
#5#LnBhcnNlX2FyZ3MoKQoKICAgIGZpbGVzID0gY29sbGVjdF9pbnB1dHMoUGF0aChhcmdzLmlucHV0
#5#KSwgYXJncy5vbmx5KQogICAgaWYgbm90IGZpbGVzOgogICAgICAgIHByaW50KCJbd2hvbGVtb3Vu
#5#dF0gbm8gVElGRiBtYXRjaGVkLiIpCiAgICAgICAgcmV0dXJuIDEKICAgIHByaW50KGYiW3dob2xl
#5#bW91bnRdIGltcG9ydGVyIHZ7X192ZXJzaW9uX199IC0ge2xlbihmaWxlcyl9IGZpbGUocykgLT4g
#5#e1BhdGgoYXJncy5vdXRwdXQpIC8gVFlQRV9ESVJ9IikKICAgIGZhaWx1cmVzID0gMAogICAgZm9y
#5#IHNvdXJjZSBpbiBmaWxlczoKICAgICAgICB0cnk6CiAgICAgICAgICAgIGltcG9ydF90aWZmKHNv
#5#dXJjZSwgUGF0aChhcmdzLm91dHB1dCksIGFyZ3MpCiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbiBh
#5#cyBleGM6ICAjIG9uZSBiYWQgZXhwb3J0IG11c3Qgbm90IHN0b3AgdGhlIGJhdGNoCiAgICAgICAg
#5#ICAgIGZhaWx1cmVzICs9IDEKICAgICAgICAgICAgcHJpbnQoZiIgIFtmYWlsXSB7c291cmNlLm5h
#5#bWV9OiB7ZXhjfSIpCiAgICBwcmludChmIlt3aG9sZW1vdW50XSBkb25lIC0ge2xlbihmaWxlcykg
#5#LSBmYWlsdXJlc30gaW1wb3J0ZWQsIHtmYWlsdXJlc30gZmFpbGVkLiIpCiAgICByZXR1cm4gMSBp
#5#ZiBmYWlsdXJlcyBlbHNlIDAKCgppZiBfX25hbWVfXyA9PSAiX19tYWluX18iOgogICAgc3lzLmV4
#5#aXQobWFpbigpKQo=
:: ---- [6] build_download_bundles.py (30454 octets) ----
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
#6#VEFTRVRfVFlQRVMgPSAoImZpeGVkIiwgImxpdmUiLCAidHJhY2tpbmciLCAid2hvbGVtb3VudCIp
#6#CgpUQVJHRVRfUFggPSAyMDQ4ICAgICAgICAgICAgICAgIyBkZXNpcmVkIGxvbmcgWFkgc2lkZSBv
#6#ZiB0aGUgZ2VuZXJhdGVkIFRJRkYKIyBIYXJkIGNlaWxpbmcgb24gdGhlIGluLWZsaWdodCB2b2x1
#6#bWUgKEPCt1rCt1nCt1jCt2l0ZW1zaXplKTsgaWYgdGhlIGxldmVsIGNsb3Nlc3QgdG8KIyBUQVJH
#6#RVRfUFggZXhjZWVkcyB0aGlzLCBzdGVwIGRvd24gdGhlIHB5cmFtaWQgc28gd2UgbmV2ZXIgYmxv
#6#dyB1cCBkaXNrL1JBTS4KIyBUaGlzIGlzIE5PVCB0aGUgY2xhc3NpYy1USUZGIDQgR2lCIG9mZnNl
#6#dCBsaW1pdDogdGhhdCBvbmUgYXBwbGllcyB0byB0aGUKIyBDT01QUkVTU0VEIGZpbGUgKH40NSUg
#6#b2YgdGhlIHJhdyB2b2x1bWUgaGVyZSksIHNvIGNhcHBpbmcgdGhlIHJhdyB2b2x1bWUgYXQgNAoj
#6#IEdpQiB3b3VsZCBjb3N0IHJlYWwgcmVzb2x1dGlvbiDigJQgaXQgaGFsdmVkIDQgb2YgdGhlIGxh
#6#YidzIDE2IGRhdGFzZXRzIHdoZW4KIyB0cmllZC4gQW4gb3ZlcmZsb3dpbmcgd3JpdGUgaXMgY2F1
#6#Z2h0IGFuZCByZXRyaWVkIG9uZSBsZXZlbCBjb2Fyc2VyIGluc3RlYWQuCk1BWF9USUZGX0JZVEVT
#6#ID0gNiAqIDEwMjQqKjMKCiMgRmFsc2UtY29sb3VyIGZhbGxiYWNrcyAobWlycm9yIHJ1bl9wcmVw
#6#cm9jZXNzLlRIVU1CX0NPTE9SUykgd2hlbiBhIGNoYW5uZWwgaGFzCiMgbm8gZGlzcGxheSBjb2xv
#6#dXIgaW4gbWV0YWRhdGEuanNvbi4KVEhVTUJfQ09MT1JTID0gWwogICAgKDAsIDI1NSwgMTAyKSwg
#6#KDI1NSwgNjEsIDI1NSksICg0NywgMTA3LCAyNTUpLCAoMjU1LCA0OCwgNDgpLAogICAgKDI1NSwg
#6#MjU1LCAwKSwgKDI1NSwgMCwgMjU1KSwgKDAsIDI1NSwgMjU1KSwKXQoKCiMg4pSA4pSAIEltYXJp
#6#cyBhdHRyaWJ1dGUgZGVjb2RpbmcgKG1pcnJvcnMgcHJlcHJvY2Vzcy8xLWltc19tZXRhZGF0YS5h
#6#dHRyX3N0cikg4pSA4pSACmRlZiBhdHRyX3N0cihncm91cCwga2V5LCBkZWZhdWx0PSIiKToKICAg
#6#IGlmIGdyb3VwIGlzIE5vbmU6CiAgICAgICAgcmV0dXJuIGRlZmF1bHQKICAgIHYgPSBncm91cC5h
#6#dHRycy5nZXQoa2V5LCBkZWZhdWx0KQogICAgaWYgaXNpbnN0YW5jZSh2LCAoYnl0ZXMsIG5wLmJ5
#6#dGVzXykpOgogICAgICAgIHJldHVybiB2LmRlY29kZSgidXRmLTgiLCBlcnJvcnM9InJlcGxhY2Ui
#6#KS5zdHJpcCgpCiAgICBpZiBpc2luc3RhbmNlKHYsIG5wLm5kYXJyYXkpOgogICAgICAgIHRyeToK
#6#ICAgICAgICAgICAgcmV0dXJuIGIiIi5qb2luKAogICAgICAgICAgICAgICAgYnl0ZXMoYykgaWYg
#6#aXNpbnN0YW5jZShjLCAoYnl0ZXMsIG5wLmJ5dGVzXykpIGVsc2UgYy50b2J5dGVzKCkKICAgICAg
#6#ICAgICAgICAgIGZvciBjIGluIHYKICAgICAgICAgICAgKS5kZWNvZGUoInV0Zi04IiwgZXJyb3Jz
#6#PSJyZXBsYWNlIikuc3RyaXAoKQogICAgICAgIGV4Y2VwdCBFeGNlcHRpb246CiAgICAgICAgICAg
#6#IHJldHVybiAiIi5qb2luKAogICAgICAgICAgICAgICAgYy5kZWNvZGUoInV0Zi04IiwgZXJyb3Jz
#6#PSJyZXBsYWNlIikgaWYgaXNpbnN0YW5jZShjLCAoYnl0ZXMsIG5wLmJ5dGVzXykpIGVsc2Ugc3Ry
#6#KGMpCiAgICAgICAgICAgICAgICBmb3IgYyBpbiB2CiAgICAgICAgICAgICkuc3RyaXAoKQogICAg
#6#cmV0dXJuIHN0cih2KS5zdHJpcCgpCgoKZGVmIGF0dHJfZmxvYXQoZ3JvdXAsIGtleSwgZGVmYXVs
#6#dD0wLjApOgogICAgdHJ5OgogICAgICAgIHJldHVybiBmbG9hdChhdHRyX3N0cihncm91cCwga2V5
#6#LCBzdHIoZGVmYXVsdCkpKQogICAgZXhjZXB0IChUeXBlRXJyb3IsIFZhbHVlRXJyb3IpOgogICAg
#6#ICAgIHJldHVybiBkZWZhdWx0CgoKZGVmIGhleF90b19yZ2IodmFsdWUsIGZhbGxiYWNrKToKICAg
#6#IG0gPSByZS5tYXRjaChyIl4jPyhbMC05YS1mQS1GXXs2fSkkIiwgc3RyKHZhbHVlIG9yICIiKS5z
#6#dHJpcCgpKQogICAgaWYgbm90IG06CiAgICAgICAgcmV0dXJuIGZhbGxiYWNrCiAgICBoID0gbS5n
#6#cm91cCgxKQogICAgcmV0dXJuIChpbnQoaFswOjJdLCAxNiksIGludChoWzI6NF0sIDE2KSwgaW50
#6#KGhbNDo2XSwgMTYpKQoKCiMg4pSA4pSAIERhdGFzZXQgZGlzY292ZXJ5IOKUgOKUgOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgApkZWYgX3JlYWRfbWV0YV9qc29u
#6#KGQpOgogICAgIiIiUGVyLWRhdGFzZXQgbWV0YWRhdGEuanNvbiDigJQgdGhlIGF1dGhvcml0YXRp
#6#dmUgc291cmNlIGZvciBjaGFubmVscy92b3hlbHMuCiAgICB1dGYtOC1zaWcgdG9sZXJhdGVzIGEg
#6#c3RyYXkgQk9NIChoYW5kLWVkaXRlZCBmaWxlcykgd2l0aG91dCBicmVha2luZyB0aGUgcGFyc2Uu
#6#IiIiCiAgICBwID0gZCAvICJtZXRhZGF0YS5qc29uIgogICAgaWYgcC5leGlzdHMoKToKICAgICAg
#6#ICB0cnk6CiAgICAgICAgICAgIHJldHVybiBqc29uLmxvYWRzKHAucmVhZF90ZXh0KGVuY29kaW5n
#6#PSJ1dGYtOC1zaWciKSkKICAgICAgICBleGNlcHQgRXhjZXB0aW9uOgogICAgICAgICAgICByZXR1
#6#cm4ge30KICAgIHJldHVybiB7fQoKCmRlZiBsb2FkX2RhdGFzZXRzKGZpbHRlcl9zdWJzdHI9Tm9u
#6#ZSwgdHlwZXM9REFUQVNFVF9UWVBFUyk6CiAgICAiIiJSZXR1cm4gW3tpZCwgdHlwZSwgZm9sZGVy
#6#LCBkaXIsIG1ldGF9XSwgZHJpdmVuIGJ5IGNhdGFsb2cuanNvbiB3aGVuIHByZXNlbnQuCiAgICBt
#6#ZXRhZGF0YS5qc29uICh3cml0dGVuIGJ5IHRoZSBwcmVwcm9jZXNzIHBpcGVsaW5lKSB0YWtlcyBw
#6#cmVjZWRlbmNlIGZvciBgbWV0YWAKICAgIHNvIHRoaXMgd29ya3MgZXZlbiB3aGVuIHJ1biByaWdo
#6#dCBhZnRlciBhIGRhdGFzZXQgaXMgYnVpbHQsIGJlZm9yZSBjYXRhbG9nLmpzb24KICAgIGhhcyBh
#6#Z2dyZWdhdGVkIGl0LiIiIgogICAgb3V0LCBzZWVuID0gW10sIHNldCgpCiAgICBjYXRhbG9nID0g
#6#REFUQV9XRUIgLyAiY2F0YWxvZy5qc29uIgogICAgZW50cmllcyA9IFtdCiAgICBpZiBjYXRhbG9n
#6#LmV4aXN0cygpOgogICAgICAgIHRyeToKICAgICAgICAgICAgZW50cmllcyA9IGpzb24ubG9hZHMo
#6#Y2F0YWxvZy5yZWFkX3RleHQoZW5jb2Rpbmc9InV0Zi04IikpCiAgICAgICAgZXhjZXB0IEV4Y2Vw
#6#dGlvbiBhcyBleGM6CiAgICAgICAgICAgIHByaW50KGYiW3dhcm5dIGNhdGFsb2cuanNvbiB1bnJl
#6#YWRhYmxlICh7ZXhjfSk7IGZhbGxpbmcgYmFjayB0byBkaXIgc2NhbiIpCiAgICBmb3IgZSBpbiBl
#6#bnRyaWVzOgogICAgICAgIHBhdGggPSBlLmdldCgicGF0aCIpIG9yIGUuZ2V0KCJpZCIpIG9yICIi
#6#CiAgICAgICAgcGFydHMgPSBwYXRoLnNwbGl0KCIvIiwgMSkKICAgICAgICBpZiBsZW4ocGFydHMp
#6#ICE9IDI6CiAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAgdHlwLCBmb2xkZXIgPSBwYXJ0cwog
#6#ICAgICAgIGQgPSBEQVRBX1dFQiAvIHR5cCAvIGZvbGRlcgogICAgICAgIGlmIHR5cCBpbiB0eXBl
#6#cyBhbmQgZC5pc19kaXIoKToKICAgICAgICAgICAgb3V0LmFwcGVuZCh7ImlkIjogcGF0aCwgInR5
#6#cGUiOiB0eXAsICJmb2xkZXIiOiBmb2xkZXIsICJkaXIiOiBkLAogICAgICAgICAgICAgICAgICAg
#6#ICAgICAibWV0YSI6IF9yZWFkX21ldGFfanNvbihkKSBvciBlfSkKICAgICAgICAgICAgc2Vlbi5h
#6#ZGQocGF0aCkKICAgICMgZGlyLXNjYW4gZmFsbGJhY2sgZm9yIGFueXRoaW5nIG5vdCBpbiB0aGUg
#6#Y2F0YWxvZwogICAgZm9yIHR5cCBpbiB0eXBlczoKICAgICAgICBiYXNlID0gREFUQV9XRUIgLyB0
#6#eXAKICAgICAgICBpZiBub3QgYmFzZS5pc19kaXIoKToKICAgICAgICAgICAgY29udGludWUKICAg
#6#ICAgICBmb3IgZCBpbiBzb3J0ZWQoYmFzZS5pdGVyZGlyKCkpOgogICAgICAgICAgICBwaWQgPSBm
#6#Int0eXB9L3tkLm5hbWV9IgogICAgICAgICAgICBpZiBkLmlzX2RpcigpIGFuZCBwaWQgbm90IGlu
#6#IHNlZW46CiAgICAgICAgICAgICAgICBvdXQuYXBwZW5kKHsiaWQiOiBwaWQsICJ0eXBlIjogdHlw
#6#LCAiZm9sZGVyIjogZC5uYW1lLCAiZGlyIjogZCwKICAgICAgICAgICAgICAgICAgICAgICAgICAg
#6#ICJtZXRhIjogX3JlYWRfbWV0YV9qc29uKGQpfSkKICAgIGlmIGZpbHRlcl9zdWJzdHI6CiAgICAg
#6#ICAgb3V0ID0gW28gZm9yIG8gaW4gb3V0IGlmIGZpbHRlcl9zdWJzdHIubG93ZXIoKSBpbiBvWyJm
#6#b2xkZXIiXS5sb3dlcigpXQogICAgcmV0dXJuIG91dAoKCmRlZiBmaW5kX2ltcyhmb2xkZXIpOgog
#6#ICAgIiIiTG9jYXRlIDxmb2xkZXI+LmltcyBpbiBhbnkgY29uZmlndXJlZCBSQVdfREFUQSBkaXIg
#6#KHJlY3Vyc2l2ZSkuIiIiCiAgICBmb3IgYmFzZSBpbiBSQVdfREFUQV9ESVJTOgogICAgICAgIGlm
#6#IG5vdCBiYXNlLmlzX2RpcigpOgogICAgICAgICAgICBjb250aW51ZQogICAgICAgIGV4YWN0ID0g
#6#bGlzdChiYXNlLnJnbG9iKGYie2ZvbGRlcn0uaW1zIikpCiAgICAgICAgaWYgZXhhY3Q6CiAgICAg
#6#ICAgICAgIHJldHVybiBleGFjdFswXQogICAgcmV0dXJuIE5vbmUKCgojIOKUgOKUgCBTdGVwIDEg
#6#4oCUIGFyY2hpdmUgb2YgdGhlIHByZXByb2Nlc3NlZCBkYXRhc2V0IChkb3dubG9hZC8gZXhjbHVk
#6#ZWQpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgApkZWYgYnVpbGRfYXJjaGl2ZShkc19kaXIsIGZvbGRl
#6#ciwgb3V0X3BhdGgsIGZvcmNlLCBkcnkpOgogICAgaWYgb3V0X3BhdGguZXhpc3RzKCkgYW5kIG5v
#6#dCBmb3JjZToKICAgICAgICByZXR1cm4gInNraXAgKGV4aXN0cykiCiAgICAjIENvbGxlY3QgdGhl
#6#IHNlcnZhYmxlIGZpbGVzIGZpcnN0OyB0aGUgZG93bmxvYWQvIGZvbGRlciBpcyBleGNsdWRlZCBz
#6#byB0aGUKICAgICMgYXJjaGl2ZSBuZXZlciBjb250YWlucyB0aGUgb3RoZXIgYXJ0ZWZhY3RzIChv
#6#ciBpdHNlbGYpLgogICAgZmlsZXMgPSBbcCBmb3IgcCBpbiBzb3J0ZWQoZHNfZGlyLnJnbG9iKCIq
#6#IikpCiAgICAgICAgICAgICBpZiBwLmlzX2ZpbGUoKSBhbmQgcC5yZWxhdGl2ZV90byhkc19kaXIp
#6#LnBhcnRzWzoxXSAhPSAoImRvd25sb2FkIiwpXQogICAgaWYgbm90IGZpbGVzOgogICAgICAgIHJl
#6#dHVybiAic2tpcCAobm8gd2ViIGRhdGEgeWV0KSIgICAgICAgICMgdW4tcHJlcHJvY2Vzc2VkIGRh
#6#dGFzZXQg4oaSIG5vIGVtcHR5IHppcAogICAgaWYgZHJ5OgogICAgICAgIHJldHVybiBmIndvdWxk
#6#IGJ1aWxkICh7bGVuKGZpbGVzKX0gZmlsZXMpIgogICAgdG1wID0gb3V0X3BhdGgud2l0aF9zdWZm
#6#aXgob3V0X3BhdGguc3VmZml4ICsgIi50bXAiKQogICAgd2l0aCB6aXBmaWxlLlppcEZpbGUodG1w
#6#LCAidyIsIGNvbXByZXNzaW9uPXppcGZpbGUuWklQX1NUT1JFRCwgYWxsb3daaXA2ND1UcnVlKSBh
#6#cyB6ZjoKICAgICAgICBmb3IgcGF0aCBpbiBmaWxlczoKICAgICAgICAgICAgemYud3JpdGUocGF0
#6#aCwgYXJjbmFtZT1zdHIoUGF0aChmb2xkZXIpIC8gcGF0aC5yZWxhdGl2ZV90byhkc19kaXIpKSkK
#6#ICAgIG9zLnJlcGxhY2UodG1wLCBvdXRfcGF0aCkKICAgIHJldHVybiBmIntsZW4oZmlsZXMpfSBm
#6#aWxlcywge2ZtdF9zaXplKG91dF9wYXRoLnN0YXQoKS5zdF9zaXplKX0iCgoKIyDilIDilIAgU3Rl
#6#cCAyIOKAlCBvcmlnaW5hbCAuaW1zIHZpYSBoYXJkIGxpbmsgKGNvcHkgZmFsbGJhY2spIOKUgOKU
#6#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgApk
#6#ZWYgcGxhY2VfaW1zKGltc19zcmMsIG91dF9wYXRoLCBmb3JjZSwgZHJ5KToKICAgIGlmIG91dF9w
#6#YXRoLmV4aXN0cygpIGFuZCBub3QgZm9yY2U6CiAgICAgICAgcmV0dXJuICJza2lwIChleGlzdHMp
#6#IgogICAgaWYgZHJ5OgogICAgICAgIHJldHVybiBmIndvdWxkIGxpbmsge2ZtdF9zaXplKGltc19z
#6#cmMuc3RhdCgpLnN0X3NpemUpfSIKICAgIGlmIG91dF9wYXRoLmV4aXN0cygpOgogICAgICAgIG91
#6#dF9wYXRoLnVubGluaygpCiAgICB0cnk6CiAgICAgICAgb3MubGluayhpbXNfc3JjLCBvdXRfcGF0
#6#aCkgICAgICAgICAgICAgICAgICAgICAgIyBoYXJkIGxpbmssIDAgZXh0cmEgYnl0ZXMKICAgICAg
#6#ICByZXR1cm4gZiJoYXJkbGluayB7Zm10X3NpemUob3V0X3BhdGguc3RhdCgpLnN0X3NpemUpfSIK
#6#ICAgIGV4Y2VwdCBPU0Vycm9yOgogICAgICAgIHNodXRpbC5jb3B5MihpbXNfc3JjLCBvdXRfcGF0
#6#aCkgICAgICAgICAgICAgICAgICMgY3Jvc3Mtdm9sdW1lIGZhbGxiYWNrCiAgICAgICAgcmV0dXJu
#6#IGYiY29weSB7Zm10X3NpemUob3V0X3BhdGguc3RhdCgpLnN0X3NpemUpfSIKCgojIOKUgOKUgCBT
#6#dGVwIDMvNCDigJQgSW1hZ2VKIFRJRkYgKCsgcGVyLWNoYW5uZWwgTUlQKSBmcm9tIHRoZSAuaW1z
#6#IHB5cmFtaWQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmRlZiBsaXN0X2xldmVscyhmKToKICAg
#6#ICIiIlsoTCwgWHIsIFlyLCBacildIGZyb20gdGhlIEltYXJpcyBSZXNvbHV0aW9uTGV2ZWwgZ3Jv
#6#dXBzIChyZWFsIHNpemVzKS4iIiIKICAgIGRhdGFzZXQgPSBmWyJEYXRhU2V0Il0KICAgIG91dCA9
#6#IFtdCiAgICBmb3Iga2V5IGluIGRhdGFzZXQua2V5cygpOgogICAgICAgIGlmIG5vdCBrZXkuc3Rh
#6#cnRzd2l0aCgiUmVzb2x1dGlvbkxldmVsIik6CiAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAg
#6#TCA9IGludChrZXkuc3BsaXQoKVstMV0pCiAgICAgICAgdHAgPSBkYXRhc2V0W2tleV0uZ2V0KCJU
#6#aW1lUG9pbnQgMCIpCiAgICAgICAgaWYgdHAgaXMgTm9uZToKICAgICAgICAgICAgY29udGludWUK
#6#ICAgICAgICBjaDAgPSB0cC5nZXQoIkNoYW5uZWwgMCIpCiAgICAgICAgaWYgY2gwIGlzIE5vbmU6
#6#CiAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAgeHIgPSBpbnQoYXR0cl9zdHIoY2gwLCAiSW1h
#6#Z2VTaXplWCIsICIwIikgb3IgMCkKICAgICAgICB5ciA9IGludChhdHRyX3N0cihjaDAsICJJbWFn
#6#ZVNpemVZIiwgIjAiKSBvciAwKQogICAgICAgIHpyID0gaW50KGF0dHJfc3RyKGNoMCwgIkltYWdl
#6#U2l6ZVoiLCAiMCIpIG9yIDApCiAgICAgICAgaWYgbm90ICh4ciBhbmQgeXIgYW5kIHpyKToKICAg
#6#ICAgICAgICAgZGF0YSA9IGNoMC5nZXQoIkRhdGEiKQogICAgICAgICAgICBpZiBkYXRhIGlzIE5v
#6#bmU6CiAgICAgICAgICAgICAgICBjb250aW51ZQogICAgICAgICAgICB6ciwgeXIsIHhyID0gKHpy
#6#IG9yIGRhdGEuc2hhcGVbMF0sIHlyIG9yIGRhdGEuc2hhcGVbMV0sIHhyIG9yIGRhdGEuc2hhcGVb
#6#Ml0pCiAgICAgICAgb3V0LmFwcGVuZCgoTCwgeHIsIHlyLCB6cikpCiAgICByZXR1cm4gc29ydGVk
#6#KG91dCwga2V5PWxhbWJkYSBsdjogbHZbMF0pCgoKZGVmIGltc19jaGFubmVsX25hbWVzKGYsIG5f
#6#Y2gpOgogICAgIiIiQ2hhbm5lbCBkaXNwbGF5IG5hbWVzIGZyb20gRGF0YVNldEluZm8vQ2hhbm5l
#6#bCB7aX07ICcnIHdoZW4gbWlzc2luZyBvciBhCiAgICBnZW5lcmljICdDaGFubmVsIE4nIHBsYWNl
#6#aG9sZGVyLCBzbyB0aGUgY2FsbGVyIGNhbiBmYWxsIGJhY2sgY2xlYW5seS4iIiIKICAgIGluZm8g
#6#PSBmLmdldCgiRGF0YVNldEluZm8iLCB7fSkKICAgIG5hbWVzID0gW10KICAgIGZvciBpIGluIHJh
#6#bmdlKG5fY2gpOgogICAgICAgIGNoID0gaW5mby5nZXQoZiJDaGFubmVsIHtpfSIpIGlmIGhhc2F0
#6#dHIoaW5mbywgImdldCIpIGVsc2UgTm9uZQogICAgICAgIG5tID0gcmUuc3ViKHIiXHgwMC4qIiwg
#6#IiIsIGF0dHJfc3RyKGNoLCAiTmFtZSIsICIiKSkuc3RyaXAoKSBpZiBjaCBpcyBub3QgTm9uZSBl
#6#bHNlICIiCiAgICAgICAgaWYgcmUubWF0Y2gociJeY2goYW5uZWwpP1xzKlxkKyQiLCBubSwgcmUu
#6#SUdOT1JFQ0FTRSk6CiAgICAgICAgICAgIG5tID0gIiIKICAgICAgICBuYW1lcy5hcHBlbmQobm0p
#6#CiAgICByZXR1cm4gbmFtZXMKCgpkZWYgY2hvb3NlX2xldmVsKGxldmVscywgbl9jaCwgdGFyZ2V0
#6#X3B4LCBtYXhfYnl0ZXMsIGl0ZW1zaXplPTIpOgogICAgIiIiTGV2ZWwgd2hvc2UgbG9uZyBYWSBz
#6#aWRlIGlzIGNsb3Nlc3QgdG8gdGFyZ2V0X3B4LCBzdGVwcGluZyBzbWFsbGVyIGlmIHRoZQogICAg
#6#aW4tZmxpZ2h0IHZvbHVtZSB3b3VsZCBleGNlZWQgbWF4X2J5dGVzLiIiIgogICAgY2hvc2VuID0g
#6#bWluKGxldmVscywga2V5PWxhbWJkYSBsdjogYWJzKG1heChsdlsxXSwgbHZbMl0pIC0gdGFyZ2V0
#6#X3B4KSkKICAgIHdoaWxlIGNob3NlblsxXSAqIGNob3NlblsyXSAqIGNob3NlblszXSAqIG5fY2gg
#6#KiBpdGVtc2l6ZSA+IG1heF9ieXRlczoKICAgICAgICBzbWFsbGVyID0gW2x2IGZvciBsdiBpbiBs
#6#ZXZlbHMgaWYgbHZbMF0gPiBjaG9zZW5bMF1dCiAgICAgICAgaWYgbm90IHNtYWxsZXI6CiAgICAg
#6#ICAgICAgIGJyZWFrCiAgICAgICAgY2hvc2VuID0gbWluKHNtYWxsZXIsIGtleT1sYW1iZGEgbHY6
#6#IGx2WzBdKQogICAgcmV0dXJuIGNob3NlbgoKCmRlZiByYW1wX2x1dChyZ2IpOgogICAgIiIiQmxh
#6#Y2vihpJjb2xvdXIgOC1iaXQgcmFtcC4gSW1hZ2VKIGFwcGxpZXMgb25lIHBlciBjaGFubmVsIGlu
#6#IGNvbXBvc2l0ZSBtb2RlLAogICAgc28gdGhlIGRvd25sb2FkIG9wZW5zIGluIHRoZSBzYW1lIGNv
#6#bG91cnMgdGhlIHBsYXRmb3JtIHNob3dzLiIiIgogICAgbHV0ID0gbnAuemVyb3MoKDMsIDI1Niks
#6#IGR0eXBlPW5wLnVpbnQ4KQogICAgZm9yIGsgaW4gcmFuZ2UoMyk6CiAgICAgICAgbHV0W2tdID0g
#6#bnAubGluc3BhY2UoMCwgcmdiW2tdLCAyNTYsIGR0eXBlPW5wLnVpbnQ4KQogICAgcmV0dXJuIGx1
#6#dAoKCmRlZiByYW5nZV9mcm9tX2hpc3QoaGlzdCwgbG9fcGN0PTEuMCwgaGlfcGN0PTk5LjkpOgog
#6#ICAgIiIiRGlzcGxheSByYW5nZSBmcm9tIGFuIGV4YWN0IGludGVuc2l0eSBoaXN0b2dyYW0g4oCU
#6#IHRoZSBzYW1lIDFzdOKAkzk5Ljl0aAogICAgcGVyY2VudGlsZSB3aW5kb3cgX2F1dG9zY2FsZSBn
#6#aXZlcyB0aGUgTUlQIFBOR3MsIHNvIHRoZSBzdGFjayBvcGVucyBsb29raW5nCiAgICBsaWtlIHRo
#6#ZW0gaW5zdGVhZCBvZiBhdCB0aGUgZGV0ZWN0b3IncyBmdWxsIHRoZW9yZXRpY2FsIHN3ZWVwLiIi
#6#IgogICAgdG90YWwgPSBpbnQoaGlzdC5zdW0oKSkKICAgIGlmIHRvdGFsIDw9IDA6CiAgICAgICAg
#6#cmV0dXJuIDAuMCwgMS4wCiAgICBjZGYgPSBucC5jdW1zdW0oaGlzdCkKICAgIGxvID0gZmxvYXQo
#6#bnAuc2VhcmNoc29ydGVkKGNkZiwgdG90YWwgKiBsb19wY3QgLyAxMDAuMCkpCiAgICBoaSA9IGZs
#6#b2F0KG5wLnNlYXJjaHNvcnRlZChjZGYsIHRvdGFsICogaGlfcGN0IC8gMTAwLjApKQogICAgaWYg
#6#aGkgPD0gbG86CiAgICAgICAgbnogPSBucC5ub256ZXJvKGhpc3QpWzBdCiAgICAgICAgbG8sIGhp
#6#ID0gMC4wLCAoZmxvYXQobnpbLTFdKSBpZiBsZW4obnopIGVsc2UgMS4wKQogICAgcmV0dXJuIGxv
#6#LCBtYXgoaGksIGxvICsgMS4wKQoKCmRlZiB0aWZmX2luZm8oZm9sZGVyLCBsZXZlbCwgY2hfbmFt
#6#ZXMsIHZveCwgZHR5cGUpOgogICAgIiIiRnJlZS10ZXh0IGJsb2NrIHN1cmZhY2VkIGJ5IEZpamkn
#6#cyBJbWFnZSDilrggU2hvdyBJbmZvLiIiIgogICAgcmV0dXJuICJcbiIuam9pbihbCiAgICAgICAg
#6#ZiJEYXRhc2V0OiB7Zm9sZGVyfSIsCiAgICAgICAgZiJTb3VyY2U6IEltYXJpcyAuaW1zIFJlc29s
#6#dXRpb25MZXZlbCB7bGV2ZWx9LCBuYXRpdmUge2R0eXBlfSIsCiAgICAgICAgZiJWb3hlbCBzaXpl
#6#ICh1bSk6IFg9e3ZveFswXTouNmd9IFk9e3ZveFsxXTouNmd9IFo9e3ZveFsyXTouNmd9IiwKICAg
#6#ICAgICAiQ2hhbm5lbHM6ICIgKyAiLCAiLmpvaW4oZiJDe2kgKyAxfT17bn0iIGZvciBpLCBuIGlu
#6#IGVudW1lcmF0ZShjaF9uYW1lcykpLAogICAgICAgICJWb3hlbCB2YWx1ZXMgYXJlIHRoZSByYXcg
#6#YWNxdWlzaXRpb24gaW50ZW5zaXRpZXM7IG9ubHkgdGhlIHN0b3JlZCAiCiAgICAgICAgImRpc3Bs
#6#YXkgcmFuZ2UgaXMgc2NhbGVkIChJbWFnZSA+IEFkanVzdCA+IEJyaWdodG5lc3MvQ29udHJhc3Qp
#6#LiIsCiAgICAgICAgIkx1bWVuM0QgLyBJUklCSE0gTWljcm9zY29weSBQbGF0Zm9ybSIsCiAgICBd
#6#KQoKCmNsYXNzIFRpZmZUb29MYXJnZShSdW50aW1lRXJyb3IpOgogICAgIiIiVGhlIHdyaXR0ZW4g
#6#c3RhY2sgb3ZlcmZsb3dlZCB0aGUgSW1hZ2VKIGZsYXZvdXIncyAzMi1iaXQgb2Zmc2V0cy4iIiIK
#6#CgpkZWYgd3JpdGVfaW1hZ2VqX3RpZmYocGF0aCwgdm9sLCB2b3gsIG1ldGFkYXRhKToKICAgICIi
#6#IldyaXRlIHRoZSBjb21wb3NpdGUgaHlwZXJzdGFjaywgcmVmdXNpbmcgYSBzaWxlbnRseSB0cnVu
#6#Y2F0ZWQgZmlsZTogdGhlCiAgICBJbWFnZUogZmxhdm91ciBpcyBjbGFzc2ljIFRJRkYgKDMyLWJp
#6#dCBvZmZzZXRzKSwgYW5kIHBhc3QgfjQgR2lCIHRpZmZmaWxlCiAgICB3YXJucyBhbmQga2VlcHMg
#6#b25seSB0aGUgZmlyc3QgSUZELCB3aGljaCBubyByZWFkZXIgY2FuIG9wZW4uIiIiCiAgICBpbXBv
#6#cnQgdGlmZmZpbGUKICAgIHdpdGggd2FybmluZ3MuY2F0Y2hfd2FybmluZ3MocmVjb3JkPVRydWUp
#6#IGFzIGNhdWdodDoKICAgICAgICB3YXJuaW5ncy5zaW1wbGVmaWx0ZXIoImFsd2F5cyIpCiAgICAg
#6#ICAgdGlmZmZpbGUuaW13cml0ZSgKICAgICAgICAgICAgc3RyKHBhdGgpLCB2b2wsIGltYWdlaj1U
#6#cnVlLCBwaG90b21ldHJpYz0ibWluaXNibGFjayIsCiAgICAgICAgICAgIGNvbXByZXNzaW9uPSJ6
#6#bGliIiwKICAgICAgICAgICAgcmVzb2x1dGlvbj0oMS4wIC8gKHZveFswXSBvciAxLjApLCAxLjAg
#6#LyAodm94WzFdIG9yIDEuMCkpLAogICAgICAgICAgICByZXNvbHV0aW9udW5pdD0iTk9ORSIsIG1l
#6#dGFkYXRhPW1ldGFkYXRhLAogICAgICAgICkKICAgIGZvciB3IGluIGNhdWdodDoKICAgICAgICBp
#6#ZiAidHJ1bmNhdCIgaW4gc3RyKHcubWVzc2FnZSkubG93ZXIoKToKICAgICAgICAgICAgcGF0aC51
#6#bmxpbmsobWlzc2luZ19vaz1UcnVlKQogICAgICAgICAgICByYWlzZSBUaWZmVG9vTGFyZ2Uoc3Ry
#6#KHcubWVzc2FnZSkpCgoKZGVmIGJ1aWxkX3RpZmZfYW5kX21pcHMoaW1zX3NyYywgZHNfZGlyLCBm
#6#b2xkZXIsIGNoYW5uZWxzX21ldGEsIHRpZmZfcGF0aCwKICAgICAgICAgICAgICAgICAgICAgICAg
#6#bWlwX3BhdGhzX2Zvciwgd2FudF90aWZmLCB3YW50X21pcCwgZm9yY2UsIGRyeSk6CiAgICAiIiJS
#6#ZXR1cm5zIGEgc3RhdHVzIHN0cmluZy4gUmVhZHMgT05FIHB5cmFtaWQgbGV2ZWwgKOKJiFRBUkdF
#6#VF9QWCksIHN0cmVhbXMgaXQKICAgIGludG8gYSBkaXNrLWJhY2tlZCBtZW1tYXAgaW4gdGhlIHN5
#6#c3RlbSB0ZW1wIGRpciAobG93IFJBTSwgbmV2ZXIgbGl0dGVycwogICAgZG93bmxvYWQvKSwgd3Jp
#6#dGVzIGEgY2FsaWJyYXRlZCBJbWFnZUogY29tcG9zaXRlIGh5cGVyc3RhY2ssIGFuZCBlbWl0cwog
#6#ICAgcGVyLWNoYW5uZWwgTUlQIFBOR3MuIiIiCiAgICBpbXBvcnQgaDVweQoKICAgIHRpZmZfZG9u
#6#ZSA9IHRpZmZfcGF0aC5leGlzdHMoKSBhbmQgbm90IGZvcmNlCiAgICBpZiBkcnk6CiAgICAgICAg
#6#cmV0dXJuICJ3b3VsZCBidWlsZCB0aWZmK21pcHMiCgogICAgd2l0aCBoNXB5LkZpbGUoc3RyKGlt
#6#c19zcmMpLCAiciIpIGFzIGY6CiAgICAgICAgaW5mbyA9IGYuZ2V0KCJEYXRhU2V0SW5mbyIsIHt9
#6#KS5nZXQoIkltYWdlIiwgTm9uZSkKICAgICAgICBsZXZlbHMgPSBsaXN0X2xldmVscyhmKQogICAg
#6#ICAgIGlmIG5vdCBsZXZlbHM6CiAgICAgICAgICAgIHJldHVybiAibm8gcmVzb2x1dGlvbiBsZXZl
#6#bHMiCiAgICAgICAgdHAwID0gZlsiRGF0YVNldCJdWyJSZXNvbHV0aW9uTGV2ZWwgMCJdWyJUaW1l
#6#UG9pbnQgMCJdCiAgICAgICAgY2hfa2V5cyA9IHNvcnRlZChbayBmb3IgayBpbiB0cDAua2V5cygp
#6#IGlmIGsuc3RhcnRzd2l0aCgiQ2hhbm5lbCIpXSwKICAgICAgICAgICAgICAgICAgICAgICAgIGtl
#6#eT1sYW1iZGEgczogaW50KHMuc3BsaXQoKVstMV0pKQogICAgICAgIG5fY2ggPSBsZW4oY2hfa2V5
#6#cykKCiAgICAgICAgIyBDaGFubmVsIG5hbWVzOiBwcmVmZXIgdGhlIGN1cmF0ZWQgY2F0YWxvZyBu
#6#YW1lLCBlbHNlIHRoZSAuaW1zIG5hbWUsCiAgICAgICAgIyBlbHNlIGEgZ2VuZXJpYyBwbGFjZWhv
#6#bGRlci4gQ29sb3VycyBjb21lIGZyb20gdGhlIGNhdGFsb2cgd2hlbiBwcmVzZW50LgogICAgICAg
#6#IGNhdCA9IF9wYWQoY2hhbm5lbHNfbWV0YSwgbl9jaCkKICAgICAgICBpbXNfbmFtZXMgPSBpbXNf
#6#Y2hhbm5lbF9uYW1lcyhmLCBuX2NoKQogICAgICAgIGNoX25hbWVzID0gWyhjYXRbaV0uZ2V0KCJu
#6#YW1lIikgb3IgaW1zX25hbWVzW2ldIG9yIGYiQ2hhbm5lbCB7aSsxfSIpIGZvciBpIGluIHJhbmdl
#6#KG5fY2gpXQoKICAgICAgICAjIFRoZSBhY3F1aXNpdGlvbidzIGJpdCBkZXB0aCBpcyBwcmVzZXJ2
#6#ZWQuIFByb21vdGluZyBhbiA4LWJpdCBhY3F1aXNpdGlvbgogICAgICAgICMgdG8gdWludDE2IGxl
#6#YXZlcyBldmVyeSB2YWx1ZSBpbiB0aGUgYm90dG9tIDAuNCUgb2YgdGhlIHJhbmdlLCB3aGljaCBh
#6#bnkKICAgICAgICAjIHJlYWRlciB0aGF0IHRydXN0cyB0aGUgZGVjbGFyZWQgZGVwdGggcmVuZGVy
#6#cyBhcyBibGFjay4KICAgICAgICBkdHlwZSA9IG5wLmR0eXBlKHRwMFtjaF9rZXlzWzBdXVsiRGF0
#6#YSJdLmR0eXBlKQoKICAgICAgICBuZWVkX3ZvbCA9IHdhbnRfdGlmZiBhbmQgbm90IHRpZmZfZG9u
#6#ZQogICAgICAgIGlmIG5vdCBuZWVkX3ZvbCBhbmQgbm90IHdhbnRfbWlwOgogICAgICAgICAgICBy
#6#ZXR1cm4gInRpZmYgc2tpcCAoZXhpc3RzKSIgaWYgd2FudF90aWZmIGVsc2UgIm5vdGhpbmcgdG8g
#6#ZG8iCgogICAgICAgICMgUGh5c2ljYWwgZXh0ZW50IGlzIGxldmVsLWluZGVwZW5kZW50IOKGkiB2
#6#b3hlbCBzaXplID0gZXh0ZW50IC8gbGV2ZWwgZGltcy4KICAgICAgICBleHQgPSBsYW1iZGEgbG8s
#6#IGhpOiAoYXR0cl9mbG9hdChpbmZvLCBoaSwgMS4wKSAtIGF0dHJfZmxvYXQoaW5mbywgbG8sIDAu
#6#MCkpCgogICAgICAgICMgQmVzdCBsZXZlbCBmaXJzdCwgdGhlbiBldmVyeSBjb2Fyc2VyIG9uZS4g
#6#V2hldGhlciB0aGUgY29tcHJlc3NlZCBzdGFjawogICAgICAgICMgY2xlYXJzIHRoZSBjbGFzc2lj
#6#LVRJRkYgb2Zmc2V0IGxpbWl0IGlzIG9ubHkga25vd2FibGUgYWZ0ZXIgd3JpdGluZyBpdCwKICAg
#6#ICAgICAjIHNvIGFuIG92ZXJmbG93IHN0ZXBzIGRvd24gaW5zdGVhZCBvZiBsZWF2aW5nIHRoZSBk
#6#YXRhc2V0IHdpdGggbm8gVElGRi4KICAgICAgICBiZXN0ID0gY2hvb3NlX2xldmVsKGxldmVscywg
#6#bl9jaCwgVEFSR0VUX1BYLCBNQVhfVElGRl9CWVRFUywgZHR5cGUuaXRlbXNpemUpCiAgICAgICAg
#6#Y2FuZGlkYXRlcyA9IFtsdiBmb3IgbHYgaW4gbGV2ZWxzIGlmIGx2WzBdID49IGJlc3RbMF1dCgog
#6#ICAgICAgICMgRXhhY3QgcGVyLWNoYW5uZWwgaGlzdG9ncmFtIOKGkiBkaXNwbGF5IHJhbmdlLiBP
#6#bmx5IHRoZSBpbnRlZ2VyIHR5cGVzIGdldAogICAgICAgICMgb25lOyBJbWFnZUogYWxyZWFkeSBh
#6#dXRvLXNjYWxlcyBmbG9hdCBpbWFnZXMgd2hlbiBpdCBvcGVucyB0aGVtLgogICAgICAgIG5iaW5z
#6#ID0gKDEgPDwgKDggKiBkdHlwZS5pdGVtc2l6ZSkpIGlmIGR0eXBlLmtpbmQgPT0gInUiIGFuZCBk
#6#dHlwZS5pdGVtc2l6ZSA8PSAyIGVsc2UgMAoKICAgICAgICBzdGF0dXMsIG1pcHMgPSBbXSwgW10K
#6#ICAgICAgICBmb3IgYXR0ZW1wdCwgKEwsIFhyLCBZciwgWnIpIGluIGVudW1lcmF0ZShjYW5kaWRh
#6#dGVzKToKICAgICAgICAgICAgdm94ID0gKAogICAgICAgICAgICAgICAgZXh0KCJFeHRNaW4wIiwg
#6#IkV4dE1heDAiKSAvIG1heChYciwgMSksCiAgICAgICAgICAgICAgICBleHQoIkV4dE1pbjEiLCAi
#6#RXh0TWF4MSIpIC8gbWF4KFlyLCAxKSwKICAgICAgICAgICAgICAgIGV4dCgiRXh0TWluMiIsICJF
#6#eHRNYXgyIikgLyBtYXgoWnIsIDEpLAogICAgICAgICAgICApCiAgICAgICAgICAgIGJhc2UgPSBm
#6#WyJEYXRhU2V0Il1bZiJSZXNvbHV0aW9uTGV2ZWwge0x9Il1bIlRpbWVQb2ludCAwIl0KICAgICAg
#6#ICAgICAgaGlzdHMgPSAoW25wLnplcm9zKG5iaW5zLCBkdHlwZT1ucC5pbnQ2NCkgZm9yIF8gaW4g
#6#cmFuZ2Uobl9jaCldCiAgICAgICAgICAgICAgICAgICAgIGlmIG5lZWRfdm9sIGFuZCBuYmlucyBl
#6#bHNlIE5vbmUpCiAgICAgICAgICAgIHRtcF9kaXIgPSBQYXRoKHRlbXBmaWxlLm1rZHRlbXAocHJl
#6#Zml4PSJsdW1lbl9idW5kbGVfIikpCiAgICAgICAgICAgIGFyciwgbWlwcyA9IE5vbmUsIFtdCiAg
#6#ICAgICAgICAgIHRyeToKICAgICAgICAgICAgICAgIGlmIG5lZWRfdm9sOgogICAgICAgICAgICAg
#6#ICAgICAgICMgSW1hZ2VKIGh5cGVyc3RhY2sgYXhpcyBvcmRlciBpcyBUWkNZWCDihpIgKFosIEMs
#6#IFksIFgpIGF0IFQ9MS4KICAgICAgICAgICAgICAgICAgICBhcnIgPSBucC5tZW1tYXAodG1wX2Rp
#6#ciAvIGYie2ZvbGRlcn0udm9sLmRhdCIsIGR0eXBlPWR0eXBlLAogICAgICAgICAgICAgICAgICAg
#6#ICAgICAgICAgICAgICAgICBtb2RlPSJ3KyIsIHNoYXBlPShaciwgbl9jaCwgWXIsIFhyKSkKICAg
#6#ICAgICAgICAgICAgIGZvciBjaSwgY2sgaW4gZW51bWVyYXRlKGNoX2tleXMpOgogICAgICAgICAg
#6#ICAgICAgICAgIGRhdGEgPSBiYXNlW2NrXVsiRGF0YSJdCiAgICAgICAgICAgICAgICAgICAgbWlw
#6#ID0gbnAuemVyb3MoKFlyLCBYciksIGR0eXBlPWR0eXBlKQogICAgICAgICAgICAgICAgICAgIGZv
#6#ciB6IGluIHJhbmdlKFpyKTogICAgICAgICAgICAgICAgICMgcGxhbmUtYnktcGxhbmUg4oaSIGxv
#6#dyBSQU0KICAgICAgICAgICAgICAgICAgICAgICAgcGxhbmUgPSBkYXRhW3osIDpZciwgOlhyXQog
#6#ICAgICAgICAgICAgICAgICAgICAgICBpZiBhcnIgaXMgbm90IE5vbmU6CiAgICAgICAgICAgICAg
#6#ICAgICAgICAgICAgICBhcnJbeiwgY2ldID0gcGxhbmUKICAgICAgICAgICAgICAgICAgICAgICAg
#6#bnAubWF4aW11bShtaXAsIHBsYW5lLCBvdXQ9bWlwKSAgIyBNSVAgYWNjcnVlcyBpbiB0aGUgc2Ft
#6#ZSBwYXNzCiAgICAgICAgICAgICAgICAgICAgICAgIGlmIGhpc3RzIGlzIG5vdCBOb25lOgogICAg
#6#ICAgICAgICAgICAgICAgICAgICAgICAgaGlzdHNbY2ldICs9IG5wLmJpbmNvdW50KHBsYW5lLnJh
#6#dmVsKCksIG1pbmxlbmd0aD1uYmlucykKICAgICAgICAgICAgICAgICAgICBtaXBzLmFwcGVuZCht
#6#aXApCgogICAgICAgICAgICAgICAgaWYgbm90IG5lZWRfdm9sOgogICAgICAgICAgICAgICAgICAg
#6#IGJyZWFrICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICMgTUlQLW9ubHk6IG5vdGhpbmcg
#6#dG8gd3JpdGUKICAgICAgICAgICAgICAgIGFyci5mbHVzaCgpCgogICAgICAgICAgICAgICAgcmFu
#6#Z2VzLCBsdXRzID0gW10sIFtdCiAgICAgICAgICAgICAgICBmb3IgY2kgaW4gcmFuZ2Uobl9jaCk6
#6#CiAgICAgICAgICAgICAgICAgICAgbHV0cy5hcHBlbmQocmFtcF9sdXQoaGV4X3RvX3JnYihjYXRb
#6#Y2ldLmdldCgiY29sb3IiKSwKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg
#6#ICAgICAgICAgICAgIFRIVU1CX0NPTE9SU1tjaSAlIGxlbihUSFVNQl9DT0xPUlMpXSkpKQogICAg
#6#ICAgICAgICAgICAgICAgIGlmIGhpc3RzIGlzIG5vdCBOb25lOgogICAgICAgICAgICAgICAgICAg
#6#ICAgICByYW5nZXMuZXh0ZW5kKHJhbmdlX2Zyb21faGlzdChoaXN0c1tjaV0pKQogICAgICAgICAg
#6#ICAgICAgbWV0YSA9IHsKICAgICAgICAgICAgICAgICAgICAiYXhlcyI6ICJaQ1lYIiwgInNwYWNp
#6#bmciOiB2b3hbMl0sICJ1bml0IjogInVtIiwKICAgICAgICAgICAgICAgICAgICAibW9kZSI6ICJj
#6#b21wb3NpdGUiLCAiTFVUcyI6IGx1dHMsCiAgICAgICAgICAgICAgICAgICAgIkxhYmVscyI6IFtj
#6#aF9uYW1lc1tjXSBmb3IgXyBpbiByYW5nZShacikgZm9yIGMgaW4gcmFuZ2Uobl9jaCldLAogICAg
#6#ICAgICAgICAgICAgICAgICJJbmZvIjogdGlmZl9pbmZvKGZvbGRlciwgTCwgY2hfbmFtZXMsIHZv
#6#eCwgZHR5cGUpLAogICAgICAgICAgICAgICAgfQogICAgICAgICAgICAgICAgaWYgcmFuZ2VzOgog
#6#ICAgICAgICAgICAgICAgICAgIG1ldGFbIlJhbmdlcyJdID0gdHVwbGUocmFuZ2VzKQogICAgICAg
#6#ICAgICAgICAgdG1wX3RpZiA9IHRpZmZfcGF0aC53aXRoX3N1ZmZpeCgiLnRpZi50bXAiKQogICAg
#6#ICAgICAgICAgICAgdHJ5OgogICAgICAgICAgICAgICAgICAgIHdyaXRlX2ltYWdlal90aWZmKHRt
#6#cF90aWYsIG5wLmFzYXJyYXkoYXJyKSwgdm94LCBtZXRhKQogICAgICAgICAgICAgICAgZXhjZXB0
#6#IFRpZmZUb29MYXJnZSBhcyBleGM6CiAgICAgICAgICAgICAgICAgICAgaWYgYXR0ZW1wdCArIDEg
#6#Pj0gbGVuKGNhbmRpZGF0ZXMpOgogICAgICAgICAgICAgICAgICAgICAgICByYWlzZSBSdW50aW1l
#6#RXJyb3IoCiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmIm5vIHB5cmFtaWQgbGV2ZWwgZml0
#6#cyBhbiBJbWFnZUogVElGRiAoe2V4Y30pIikgZnJvbSBleGMKICAgICAgICAgICAgICAgICAgICBw
#6#cmludChmIiAgW3RpZmZdIEx7TH0ge1hyfXh7WXJ9eHtacn0gb3ZlcmZsb3dzIHRoZSBJbWFnZUog
#6#VElGRiAiCiAgICAgICAgICAgICAgICAgICAgICAgICAgZiJvZmZzZXQgbGltaXQg4oCUIHJldHJ5
#6#aW5nIG9uZSBsZXZlbCBjb2Fyc2VyIikKICAgICAgICAgICAgICAgICAgICBjb250aW51ZQogICAg
#6#ICAgICAgICAgICAgb3MucmVwbGFjZSh0bXBfdGlmLCB0aWZmX3BhdGgpCiAgICAgICAgICAgICAg
#6#ICBzdGF0dXMuYXBwZW5kKGYidGlmZiBMe0x9IHtYcn14e1lyfXh7WnJ9IHtkdHlwZX0gIgogICAg
#6#ICAgICAgICAgICAgICAgICAgICAgICAgICBmIntmbXRfc2l6ZSh0aWZmX3BhdGguc3RhdCgpLnN0
#6#X3NpemUpfSIpCiAgICAgICAgICAgICAgICBicmVhawogICAgICAgICAgICBmaW5hbGx5OgogICAg
#6#ICAgICAgICAgICAgIyBXaW5kb3dzIHJlZnVzZXMgdG8gdW5saW5rIGEgZmlsZSB0aGF0IGlzIHN0
#6#aWxsIG1hcHBlZCwgYW5kIGEKICAgICAgICAgICAgICAgICMgcmFpc2VkIGV4Y2VwdGlvbiBrZWVw
#6#cyB0aGUgbnAuYXNhcnJheSgpIHZpZXcgYWxpdmUgaW4gaXRzCiAgICAgICAgICAgICAgICAjIHRy
#6#YWNlYmFjayDigJQgc28gZHJvcCB0aGUgbWFwcGluZyBleHBsaWNpdGx5IG9yIHRoZSBtdWx0aS1H
#6#aUIKICAgICAgICAgICAgICAgICMgc2NyYXRjaCBmaWxlIHN1cnZpdmVzIHRoZSBydW4uCiAgICAg
#6#ICAgICAgICAgICBpZiBhcnIgaXMgbm90IE5vbmU6CiAgICAgICAgICAgICAgICAgICAgdHJ5Ogog
#6#ICAgICAgICAgICAgICAgICAgICAgICBhcnIuX21tYXAuY2xvc2UoKQogICAgICAgICAgICAgICAg
#6#ICAgIGV4Y2VwdCBFeGNlcHRpb246CiAgICAgICAgICAgICAgICAgICAgICAgIHBhc3MKICAgICAg
#6#ICAgICAgICAgIGRlbCBhcnIKICAgICAgICAgICAgICAgIHNodXRpbC5ybXRyZWUodG1wX2Rpciwg
#6#aWdub3JlX2Vycm9ycz1UcnVlKQoKICAgICAgICBpZiB3YW50X3RpZmYgYW5kIG5vdCBuZWVkX3Zv
#6#bDoKICAgICAgICAgICAgc3RhdHVzLmFwcGVuZCgidGlmZiBza2lwIChleGlzdHMpIikKCiAgICAg
#6#ICAgaWYgd2FudF9taXA6CiAgICAgICAgICAgIGZyb20gUElMIGltcG9ydCBJbWFnZQogICAgICAg
#6#ICAgICBtYWRlID0gMAogICAgICAgICAgICBmb3IgY2ksIG1pcCBpbiBlbnVtZXJhdGUobWlwcyk6
#6#CiAgICAgICAgICAgICAgICBvdXQgPSBtaXBfcGF0aHNfZm9yKGNpLCBjaF9uYW1lc1tjaV0pCiAg
#6#ICAgICAgICAgICAgICBpZiBvdXQuZXhpc3RzKCkgYW5kIG5vdCBmb3JjZToKICAgICAgICAgICAg
#6#ICAgICAgICBjb250aW51ZQogICAgICAgICAgICAgICAgcmdiID0gaGV4X3RvX3JnYihjYXRbY2ld
#6#LmdldCgiY29sb3IiKSwgVEhVTUJfQ09MT1JTW2NpICUgbGVuKFRIVU1CX0NPTE9SUyldKQogICAg
#6#ICAgICAgICAgICAgbm9ybSA9IF9hdXRvc2NhbGUobWlwKSAgICAgICAgICAgICAgICAgICMgMC4u
#6#MSBmbG9hdAogICAgICAgICAgICAgICAgaW1nID0gbnAuemVyb3MoKG1pcC5zaGFwZVswXSwgbWlw
#6#LnNoYXBlWzFdLCAzKSwgZHR5cGU9bnAudWludDgpCiAgICAgICAgICAgICAgICBmb3IgayBpbiBy
#6#YW5nZSgzKToKICAgICAgICAgICAgICAgICAgICBpbWdbOiwgOiwga10gPSBucC5jbGlwKG5vcm0g
#6#KiByZ2Jba10sIDAsIDI1NSkuYXN0eXBlKG5wLnVpbnQ4KQogICAgICAgICAgICAgICAgSW1hZ2Uu
#6#ZnJvbWFycmF5KGltZywgIlJHQiIpLnNhdmUoc3RyKG91dCkpCiAgICAgICAgICAgICAgICBtYWRl
#6#ICs9IDEKICAgICAgICAgICAgc3RhdHVzLmFwcGVuZChmInttYWRlfSBNSVAgcG5nIikKICAgICAg
#6#ICByZXR1cm4gIjsgIi5qb2luKHN0YXR1cykgb3IgIm5vdGhpbmcgdG8gZG8iCgoKZGVmIF9wYWQo
#6#Y2hhbm5lbHNfbWV0YSwgbik6CiAgICBjbSA9IGxpc3QoY2hhbm5lbHNfbWV0YSBvciBbXSkKICAg
#6#IHdoaWxlIGxlbihjbSkgPCBuOgogICAgICAgIGNtLmFwcGVuZCh7fSkKICAgIHJldHVybiBjbQoK
#6#CmRlZiBfYXV0b3NjYWxlKHBsYW5lKToKICAgICIiIlJvYnVzdCAwLi4xIG5vcm1hbGlzYXRpb24g
#6#KDFzdOKAkzk5Ljl0aCBwZXJjZW50aWxlKSBmb3IgYSBNSVAgb2YgYW55IGRlcHRoLiIiIgogICAg
#6#cCA9IHBsYW5lLmFzdHlwZShucC5mbG9hdDMyKQogICAgbG8gPSBmbG9hdChucC5wZXJjZW50aWxl
#6#KHAsIDEuMCkpCiAgICBoaSA9IGZsb2F0KG5wLnBlcmNlbnRpbGUocCwgOTkuOSkpCiAgICBpZiBo
#6#aSA8PSBsbzoKICAgICAgICBoaSA9IGZsb2F0KHAubWF4KCkpIG9yIDEuMAogICAgICAgIGxvID0g
#6#MC4wCiAgICByZXR1cm4gbnAuY2xpcCgocCAtIGxvKSAvIChoaSAtIGxvKSwgMC4wLCAxLjApCgoK
#6#IyDilIDilIAgU3RlcCA1IOKAlCBSRUFETUUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#6#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#6#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#6#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmRlZiB3cml0ZV9yZWFkbWUob3V0X3BhdGgsIGRz
#6#LCBpbXNfc3JjLCBmb3JjZSwgZHJ5KToKICAgIGlmIG91dF9wYXRoLmV4aXN0cygpIGFuZCBub3Qg
#6#Zm9yY2U6CiAgICAgICAgcmV0dXJuICJza2lwIChleGlzdHMpIgogICAgaWYgZHJ5OgogICAgICAg
#6#IHJldHVybiAid291bGQgd3JpdGUiCiAgICBsaW5lcyA9IF9yZWFkbWVfcGhvdG8oZHMpIGlmIGRz
#6#WyJ0eXBlIl0gPT0gIndob2xlbW91bnQiIGVsc2UgX3JlYWRtZV92b2x1bWUoZHMsIGltc19zcmMp
#6#CiAgICBsaW5lcyArPSBbCiAgICAgICAgIiIsCiAgICAgICAgIkNpdGF0aW9uOiBjaXRlIHRoZSBJ
#6#UklCSE0gTWljcm9zY29weSBQbGF0Zm9ybSAoTHVtZW4zRCwgSVJJQkhNIEAgVUxCKSBhbmQgIgog
#6#ICAgICAgICJ0aGUgb3JpZ2luYWwgZXhwZXJpbWVudC9wdWJsaWNhdGlvbiB3aGVuIGF2YWlsYWJs
#6#ZS4iLAogICAgICAgIGYiR2VuZXJhdGVkOiB7dGltZS5zdHJmdGltZSgnJVktJW0tJWQgJUg6JU06
#6#JVMnKX0iLAogICAgXQogICAgb3V0X3BhdGgud3JpdGVfdGV4dCgiXG4iLmpvaW4obGluZXMpLCBl
#6#bmNvZGluZz0idXRmLTgiKQogICAgcmV0dXJuICJvayIKCgpkZWYgX3JlYWRtZV9waG90byhkcyk6
#6#CiAgICAiIiJBIHdob2xlbW91bnQgaXMgb25lIGNhbGlicmF0ZWQgcGhvdG9ncmFwaDogbm8gdm94
#6#ZWxzLCBubyBjaGFubmVscywgYW5kIG5vCiAgICAuaW1zIHRvIHJlLXJlYWQg4oCUIHRoZSBvcmln
#6#aW5hbCBUSUZGIGJlc2lkZSBpdCBjb21lcyBmcm9tIHRoZSBpbXBvcnRlci4iIiIKICAgIG1ldGEg
#6#PSBkc1sibWV0YSJdCiAgICBkaW1zID0gbWV0YS5nZXQoImRpbWVuc2lvbnMiLCB7fSkKICAgIHB4
#6#ID0gKG1ldGEuZ2V0KCJwaXhlbFNpemVVbSIpIG9yIHt9KS5nZXQoIngiKQogICAgYWNxID0gbWV0
#6#YS5nZXQoImFjcXVpc2l0aW9uIiwge30pCiAgICByZXR1cm4gWwogICAgICAgIGYiRGF0YXNldCA6
#6#IHtkc1snZm9sZGVyJ119IiwKICAgICAgICBmIlR5cGUgICAgOiB7ZHNbJ3R5cGUnXX0gKHdob2xl
#6#LW1vdW50IHBob3RvZ3JhcGgpIiwKICAgICAgICBmIlN0YWdlICAgOiB7bWV0YS5nZXQoJ3N0YWdl
#6#JywgJz8nKX0gICAgTGluZToge21ldGEuZ2V0KCdsaW5lJykgb3IgJz8nfSIKICAgICAgICBmIiAg
#6#ICBTdGFpbmluZzoge21ldGEuZ2V0KCdzdGFpbmluZycpIG9yICc/J30iLAogICAgICAgICIiLAog
#6#ICAgICAgIGYiSW1hZ2UgICAgICA6IHtkaW1zLmdldCgneCcsJz8nKX0geCB7ZGltcy5nZXQoJ3kn
#6#LCc/Jyl9IHB4LCBSR0IgOC1iaXQiLAogICAgICAgICJQaXhlbCBzaXplIDogIiArIChmIntweDou
#6#NGZ9IHVtL3B4IiBpZiBpc2luc3RhbmNlKHB4LCAoaW50LCBmbG9hdCkpIGVsc2UgInVua25vd24i
#6#KSwKICAgICAgICBmIk1pY3Jvc2NvcGUgOiB7YWNxLmdldCgnbWljcm9zY29wZScpIG9yICctJ30g
#6#ICAgY2FtZXJhIHthY3EuZ2V0KCdjYW1lcmEnKSBvciAnLSd9IiwKICAgICAgICBmIlNvdXJjZSAg
#6#ICAgOiB7YWNxLmdldCgnc291cmNlRmlsZScpIG9yICctJ30iLAogICAgICAgICIiLAogICAgICAg
#6#ICJGaWxlcyBpbiB0aGlzIGZvbGRlcjoiLAogICAgICAgIGYiICB7ZHNbJ2ZvbGRlciddfV93ZWIu
#6#emlwICAgYXJjaGl2ZSBvZiB0aGUgd2ViIGRhdGFzZXQgIgogICAgICAgICIoaW1hZ2Uud2VicCAr
#6#IHByZXZpZXcud2VicCArIHRodW1ibmFpbCArIG1ldGFkYXRhKSIsCiAgICAgICAgIiAgPG9yaWdp
#6#bmFsPi50aWYgICAgICAgICAgIHVudG91Y2hlZCBJbWFnZUovTGVpY2EgZXhwb3J0LCBwcmVzZW50
#6#IHdoZW4gdGhlICIKICAgICAgICAiaW1wb3J0IHJhbiB3aXRoIC0td2l0aC1kb3dubG9hZHMiLAog
#6#ICAgXQoKCmRlZiBfcmVhZG1lX3ZvbHVtZShkcywgaW1zX3NyYyk6CiAgICBtZXRhID0gZHNbIm1l
#6#dGEiXQogICAgZGltcyA9IG1ldGEuZ2V0KCJkaW1lbnNpb25zIiwge30pCiAgICB2b3ggPSBtZXRh
#6#LmdldCgidm94ZWxfc2l6ZSIsIHt9KQogICAgY2hhbnMgPSBtZXRhLmdldCgiY2hhbm5lbHMiLCBb
#6#XSkKICAgIGxpbmVzID0gWwogICAgICAgIGYiRGF0YXNldCA6IHtkc1snZm9sZGVyJ119IiwKICAg
#6#ICAgICBmIlR5cGUgICAgOiB7ZHNbJ3R5cGUnXX0iLAogICAgICAgIGYiU3RhZ2UgICA6IHttZXRh
#6#LmdldCgnc3RhZ2UnLCAnPycpfSAgICBFbWJyeW86IHttZXRhLmdldCgnZW1icnlvJywgJz8nKX0i
#6#LAogICAgICAgICIiLAogICAgICAgICJEaW1lbnNpb25zICh2b3hlbHMpIDogIgogICAgICAgIGYi
#6#WD17ZGltcy5nZXQoJ3gnLCc/Jyl9ICBZPXtkaW1zLmdldCgneScsJz8nKX0gIFo9e2RpbXMuZ2V0
#6#KCd6JywnPycpfSAgIgogICAgICAgIGYiQz17ZGltcy5nZXQoJ2MnLCc/Jyl9ICBUPXtkaW1zLmdl
#6#dCgndCcsJz8nKX0iLAogICAgICAgICJWb3hlbCBzaXplICjCtW0pICAgICA6ICIKICAgICAgICBm
#6#Ilg9e3ZveC5nZXQoJ3gnLCc/Jyl9ICBZPXt2b3guZ2V0KCd5JywnPycpfSAgWj17dm94LmdldCgn
#6#eicsJz8nKX0iLAogICAgICAgICIiLAogICAgICAgICJDaGFubmVsczoiLAogICAgXQogICAgZm9y
#6#IGksIGMgaW4gZW51bWVyYXRlKGNoYW5zKToKICAgICAgICBsaW5lcy5hcHBlbmQoZiIgIEN7aSsx
#6#fToge2MuZ2V0KCduYW1lJywnPycpfSAgY29sb3I9e2MuZ2V0KCdjb2xvcicsJz8nKX0gICIKICAg
#6#ICAgICAgICAgICAgICAgICAgZiJnYW1tYT17Yy5nZXQoJ2dhbW1hJywnPycpfSIpCiAgICBsaW5l
#6#cyArPSBbCiAgICAgICAgIiIsCiAgICAgICAgIkZpbGVzIGluIHRoaXMgZm9sZGVyOiIsCiAgICAg
#6#ICAgZiIgIHtkc1snZm9sZGVyJ119X3dlYi56aXAgICBhcmNoaXZlIG9mIHRoZSB3ZWIvcHJlcHJv
#6#Y2Vzc2VkIGRhdGFzZXQgIgogICAgICAgICIoYnJpY2tzICsgbWV0YWRhdGEgKyB0aHVtYm5haWwp
#6#IiwKICAgICAgICBmIiAge2RzWydmb2xkZXInXX0uaW1zICAgICAgIG9yaWdpbmFsIEltYXJpcyBh
#6#Y3F1aXNpdGlvbiIKICAgICAgICArIChmIiAgKHtmbXRfc2l6ZShpbXNfc3JjLnN0YXQoKS5zdF9z
#6#aXplKX0pIiBpZiBpbXNfc3JjIGFuZCBpbXNfc3JjLmV4aXN0cygpIGVsc2UgIiAobm90IGF2YWls
#6#YWJsZSkiKSwKICAgICAgICBmIiAge2RzWydmb2xkZXInXX0udGlmICAgICAgIG11bHRpLWNoYW5u
#6#ZWwgSW1hZ2VKL0ZpamkgY29tcG9zaXRlIGh5cGVyc3RhY2sgIgogICAgICAgIGYiKG5hdGl2ZSBi
#6#aXQgZGVwdGgsIMK1bS1jYWxpYnJhdGVkLCB+e1RBUkdFVF9QWH1weCksIGZyb20gdGhlIC5pbXMg
#6#cHlyYW1pZCIsCiAgICAgICAgZiIgIHtkc1snZm9sZGVyJ119X0MqXypfTUlQLnBuZyAgIHBlci1j
#6#aGFubmVsIG1heGltdW0taW50ZW5zaXR5IHByb2plY3Rpb24iLAogICAgXQogICAgcmV0dXJuIGxp
#6#bmVzCgoKIyDilIDilIAgaGVscGVycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#6#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#6#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#6#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKZGVmIGZtdF9z
#6#aXplKG4pOgogICAgbiA9IGZsb2F0KG4pCiAgICBmb3IgdW5pdCBpbiAoIkIiLCAiS0IiLCAiTUIi
#6#LCAiR0IiLCAiVEIiKToKICAgICAgICBpZiBuIDwgMTAyNCBvciB1bml0ID09ICJUQiI6CiAgICAg
#6#ICAgICAgIHJldHVybiBmIntuOi4xZn0ge3VuaXR9IiBpZiB1bml0ICE9ICJCIiBlbHNlIGYie2lu
#6#dChuKX0gQiIKICAgICAgICBuIC89IDEwMjQKCgojIOKUgOKUgCBtYWluIOKUgOKUgOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#6#gOKUgOKUgOKUgOKUgOKUgOKUgApkZWYgcHJvY2VzcyhkcywgYXJncyk6CiAgICBmb2xkZXIgPSBk
#6#c1siZm9sZGVyIl0KICAgIGRsID0gZHNbImRpciJdIC8gImRvd25sb2FkIgogICAgcHJpbnQoZiJc
#6#bj09PSB7ZHNbJ2lkJ119ID09PSIpCiAgICBpZiBub3QgYXJncy5kcnlfcnVuOgogICAgICAgIGRs
#6#Lm1rZGlyKHBhcmVudHM9VHJ1ZSwgZXhpc3Rfb2s9VHJ1ZSkKCiAgICAjIDEuIGFyY2hpdmUgRklS
#6#U1QgKGRvd25sb2FkLyBpcyBleGNsdWRlZCByZWdhcmRsZXNzIG9mIG9yZGVyKQogICAgaWYgbm90
#6#IGFyZ3Mubm9fYXJjaGl2ZToKICAgICAgICB0cnk6CiAgICAgICAgICAgIHByaW50KGYiICBbYXJj
#6#aGl2ZV0ge2J1aWxkX2FyY2hpdmUoZHNbJ2RpciddLCBmb2xkZXIsIGRsIC8gZid7Zm9sZGVyfV93
#6#ZWIuemlwJywgYXJncy5mb3JjZSwgYXJncy5kcnlfcnVuKX0iKQogICAgICAgIGV4Y2VwdCBFeGNl
#6#cHRpb24gYXMgZXhjOgogICAgICAgICAgICBwcmludChmIiAgW2FyY2hpdmVdIEZBSUxFRDoge2V4
#6#Y30iKQoKICAgICMgQSBwaG90b2dyYXBoIGhhcyBubyAuaW1zIHRvIHJlLXJlYWQ6IHN0ZXBzIDIt
#6#NCBhcmUgbWVhbmluZ2xlc3MsIGFuZCBpdHMKICAgICMgb3JpZ2luYWwgVElGRiArIFJFQURNRSBh
#6#cmUgcGxhY2VkIGJ5IHByZXByb2Nlc3Mvd2hvbGVtb3VudF9pbXBvcnRlci5weS4KICAgICMgVGhl
#6#IFJFQURNRSBpcyBuZXZlciBmb3JjZWQgaGVyZSwgc28gdGhlIGltcG9ydGVyJ3MgcmljaGVyIG9u
#6#ZSBhbHdheXMgd2lucy4KICAgIGlmIGRzWyJ0eXBlIl0gPT0gIndob2xlbW91bnQiOgogICAgICAg
#6#IHRyeToKICAgICAgICAgICAgcHJpbnQoZiIgIFtyZWFkbWVdIHt3cml0ZV9yZWFkbWUoZGwgLyAn
#6#UkVBRE1FLnR4dCcsIGRzLCBOb25lLCBGYWxzZSwgYXJncy5kcnlfcnVuKX0iKQogICAgICAgIGV4
#6#Y2VwdCBFeGNlcHRpb24gYXMgZXhjOgogICAgICAgICAgICBwcmludChmIiAgW3JlYWRtZV0gRkFJ
#6#TEVEOiB7ZXhjfSIpCiAgICAgICAgcmV0dXJuCgogICAgaW1zX3NyYyA9IGZpbmRfaW1zKGZvbGRl
#6#cikKICAgIGlmIGltc19zcmMgaXMgTm9uZSBhbmQgbm90IChhcmdzLm5vX2ltcyBhbmQgYXJncy5u
#6#b190aWZmKToKICAgICAgICBwcmludChmIiAgWy5pbXNdIG5vdCBmb3VuZCBpbiBSQVdfREFUQSBm
#6#b3IgJ3tmb2xkZXJ9JyDigJQgc2tpcHBpbmcgaW1zL3RpZmYvbWlwIikKCiAgICAjIDIuIG9yaWdp
#6#bmFsIC5pbXMgKGhhcmQgbGluaykKICAgIGlmIG5vdCBhcmdzLm5vX2ltcyBhbmQgaW1zX3NyYyBp
#6#cyBub3QgTm9uZToKICAgICAgICB0cnk6CiAgICAgICAgICAgIHByaW50KGYiICBbLmltc10ge3Bs
#6#YWNlX2ltcyhpbXNfc3JjLCBkbCAvIGYne2ZvbGRlcn0uaW1zJywgYXJncy5mb3JjZSwgYXJncy5k
#6#cnlfcnVuKX0iKQogICAgICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZXhjOgogICAgICAgICAgICBw
#6#cmludChmIiAgWy5pbXNdIEZBSUxFRDoge2V4Y30iKQoKICAgICMgMy80LiBJbWFnZUogY29tcG9z
#6#aXRlIFRJRkYgKyBwZXItY2hhbm5lbCBNSVAKICAgIGlmIChub3QgYXJncy5ub190aWZmIG9yIG5v
#6#dCBhcmdzLm5vX21pcCkgYW5kIGltc19zcmMgaXMgbm90IE5vbmU6CiAgICAgICAgY2hhbm5lbHNf
#6#bWV0YSA9IGRzWyJtZXRhIl0uZ2V0KCJjaGFubmVscyIsIFtdKQogICAgICAgIHRpZmZfb3V0ID0g
#6#ZGwgLyBmIntmb2xkZXJ9LnRpZiIKICAgICAgICBkZWYgbWlwX3BhdGgoY2ksIG5hbWUpOgogICAg
#6#ICAgICAgICBzYWZlID0gcmUuc3ViKHIiW15BLVphLXowLTkuXy1dKyIsICJfIiwgc3RyKG5hbWUp
#6#KS5zdHJpcCgiXyIpIG9yIGYiQ3tjaSsxfSIKICAgICAgICAgICAgcmV0dXJuIGRsIC8gZiJ7Zm9s
#6#ZGVyfV9De2NpKzF9X3tzYWZlfV9NSVAucG5nIgogICAgICAgIHRyeToKICAgICAgICAgICAgcHJp
#6#bnQoZiIgIFt0aWZmL21pcF0ge2J1aWxkX3RpZmZfYW5kX21pcHMoaW1zX3NyYywgZHNbJ2Rpcidd
#6#LCBmb2xkZXIsIGNoYW5uZWxzX21ldGEsIHRpZmZfb3V0LCBtaXBfcGF0aCwgbm90IGFyZ3Mubm9f
#6#dGlmZiwgbm90IGFyZ3Mubm9fbWlwLCBhcmdzLmZvcmNlLCBhcmdzLmRyeV9ydW4pfSIpCiAgICAg
#6#ICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBleGM6CiAgICAgICAgICAgIHByaW50KGYiICBbdGlmZi9t
#6#aXBdIEZBSUxFRDoge2V4Y30iKQogICAgICAgICMgRHJvcCB0aGUgc3VwZXJzZWRlZCBPTUUtVElG
#6#RiBvbmx5IG9uY2UgaXRzIHJlcGxhY2VtZW50IGlzIG9uIGRpc2sg4oCUCiAgICAgICAgIyBsZWZ0
#6#IGluIHBsYWNlIGl0IHN0YXlzIHRoZSBmaWxlIG9wZXJhdG9ycyBkb3dubG9hZCwgYW5kIGl0IG9w
#6#ZW5zIGJsYWNrLgogICAgICAgIGxlZ2FjeSA9IGRsIC8gZiJ7Zm9sZGVyfS5vbWUudGlmIgogICAg
#6#ICAgIGlmIGxlZ2FjeS5leGlzdHMoKSBhbmQgdGlmZl9vdXQuZXhpc3RzKCkgYW5kIG5vdCBhcmdz
#6#LmRyeV9ydW46CiAgICAgICAgICAgIGxlZ2FjeS51bmxpbmsoKQogICAgICAgICAgICBwcmludChm
#6#IiAgW3RpZmZdIHJlbW92ZWQgc3VwZXJzZWRlZCB7bGVnYWN5Lm5hbWV9IikKCiAgICAjIDUuIFJF
#6#QURNRQogICAgdHJ5OgogICAgICAgIHByaW50KGYiICBbcmVhZG1lXSB7d3JpdGVfcmVhZG1lKGRs
#6#IC8gJ1JFQURNRS50eHQnLCBkcywgaW1zX3NyYywgYXJncy5mb3JjZSwgYXJncy5kcnlfcnVuKX0i
#6#KQogICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBleGM6CiAgICAgICAgcHJpbnQoZiIgIFtyZWFkbWVd
#6#IEZBSUxFRDoge2V4Y30iKQoKCmRlZiBtYWluKCk6CiAgICBnbG9iYWwgVEFSR0VUX1BYLCBEQVRB
#6#X1dFQiwgUkFXX0RBVEFfRElSUwogICAgYXAgPSBhcmdwYXJzZS5Bcmd1bWVudFBhcnNlcihkZXNj
#6#cmlwdGlvbj0iUG9wdWxhdGUgZWFjaCBkYXRhc2V0J3MgZG93bmxvYWQvIGZvbGRlci4iKQogICAg
#6#YXAuYWRkX2FyZ3VtZW50KCItLWRhdGFzZXRzIiwgaGVscD0iY2FzZS1pbnNlbnNpdGl2ZSBzdWJz
#6#dHJpbmcgZmlsdGVyIG9uIGZvbGRlciBuYW1lIikKICAgIGFwLmFkZF9hcmd1bWVudCgiLS10eXBl
#6#cyIsIGRlZmF1bHQ9IiwiLmpvaW4oREFUQVNFVF9UWVBFUyksCiAgICAgICAgICAgICAgICAgICAg
#6#aGVscD0iY29tbWEgbGlzdDogZml4ZWQsbGl2ZSx0cmFja2luZyx3aG9sZW1vdW50IChhIHdob2xl
#6#bW91bnQgZ2V0cyB0aGUgIgogICAgICAgICAgICAgICAgICAgICAgICAgIndlYiBhcmNoaXZlIG9u
#6#bHkg4oCUIGl0cyBvcmlnaW5hbCBUSUZGIGFuZCBSRUFETUUgY29tZSBmcm9tIHRoZSBpbXBvcnRl
#6#cikiKQogICAgYXAuYWRkX2FyZ3VtZW50KCItLWRhdGEtd2ViIiwgaGVscD0ib3ZlcnJpZGUgdGhl
#6#IERBVEFfV0VCIGRpcmVjdG9yeSAoZGVmYXVsdDogPHJlcG8+L0RBVEFfV0VCKSIpCiAgICBhcC5h
#6#ZGRfYXJndW1lbnQoIi0tcmF3LWRpciIsIGhlbHA9ImRpcmVjdG9yeSB0byBzZWFyY2ggZmlyc3Qg
#6#Zm9yIHRoZSBzb3VyY2UgLmltcyAocHJlcGVuZGVkIHRvIFJBV19EQVRBX0RJUlMpIikKICAgIGFw
#6#LmFkZF9hcmd1bWVudCgiLS10aWZmLXB4IiwgdHlwZT1pbnQsIGRlZmF1bHQ9VEFSR0VUX1BYLCBo
#6#ZWxwPSJ0YXJnZXQgbG9uZyBYWSBzaWRlIG9mIHRoZSBUSUZGIikKICAgIGFwLmFkZF9hcmd1bWVu
#6#dCgiLS1uby1hcmNoaXZlIiwgYWN0aW9uPSJzdG9yZV90cnVlIikKICAgIGFwLmFkZF9hcmd1bWVu
#6#dCgiLS1uby1pbXMiLCBhY3Rpb249InN0b3JlX3RydWUiKQogICAgYXAuYWRkX2FyZ3VtZW50KCIt
#6#LW5vLXRpZmYiLCBhY3Rpb249InN0b3JlX3RydWUiKQogICAgYXAuYWRkX2FyZ3VtZW50KCItLW5v
#6#LW1pcCIsIGFjdGlvbj0ic3RvcmVfdHJ1ZSIpCiAgICBhcC5hZGRfYXJndW1lbnQoIi0tZm9yY2Ui
#6#LCBhY3Rpb249InN0b3JlX3RydWUiLCBoZWxwPSJyZWJ1aWxkIGFydGVmYWN0cyB0aGF0IGFscmVh
#6#ZHkgZXhpc3QiKQogICAgYXAuYWRkX2FyZ3VtZW50KCItLWRyeS1ydW4iLCBhY3Rpb249InN0b3Jl
#6#X3RydWUiKQogICAgYXJncyA9IGFwLnBhcnNlX2FyZ3MoKQoKICAgIFRBUkdFVF9QWCA9IGFyZ3Mu
#6#dGlmZl9weAogICAgaWYgYXJncy5kYXRhX3dlYjoKICAgICAgICBEQVRBX1dFQiA9IFBhdGgoYXJn
#6#cy5kYXRhX3dlYikKICAgIGlmIGFyZ3MucmF3X2RpcjoKICAgICAgICBSQVdfREFUQV9ESVJTID0g
#6#W1BhdGgoYXJncy5yYXdfZGlyKV0gKyBSQVdfREFUQV9ESVJTCiAgICB0eXBlcyA9IHR1cGxlKHQu
#6#c3RyaXAoKSBmb3IgdCBpbiBhcmdzLnR5cGVzLnNwbGl0KCIsIikgaWYgdC5zdHJpcCgpKQoKICAg
#6#IGRhdGFzZXRzID0gbG9hZF9kYXRhc2V0cyhhcmdzLmRhdGFzZXRzLCB0eXBlcykKICAgIGlmIG5v
#6#dCBkYXRhc2V0czoKICAgICAgICBwcmludCgiTm8gZGF0YXNldHMgbWF0Y2hlZC4iKQogICAgICAg
#6#IHJldHVybiAxCiAgICBwcmludChmIntsZW4oZGF0YXNldHMpfSBkYXRhc2V0KHMpIHRvIHByb2Nl
#6#c3MgIgogICAgICAgICAgZiIoYXJjaGl2ZT17bm90IGFyZ3Mubm9fYXJjaGl2ZX0gaW1zPXtub3Qg
#6#YXJncy5ub19pbXN9ICIKICAgICAgICAgIGYidGlmZj17bm90IGFyZ3Mubm9fdGlmZn0gbWlwPXtu
#6#b3QgYXJncy5ub19taXB9IHRhcmdldD17VEFSR0VUX1BYfXB4ICIKICAgICAgICAgIGYiZHJ5X3J1
#6#bj17YXJncy5kcnlfcnVufSkiKQogICAgdDAgPSB0aW1lLnRpbWUoKQogICAgZm9yIGRzIGluIGRh
#6#dGFzZXRzOgogICAgICAgIHRyeToKICAgICAgICAgICAgcHJvY2VzcyhkcywgYXJncykKICAgICAg
#6#ICBleGNlcHQgRXhjZXB0aW9uIGFzIGV4YzoKICAgICAgICAgICAgcHJpbnQoZiIgIFtkYXRhc2V0
#6#XSBGQUlMRUQ6IHtleGN9IikKICAgIHByaW50KGYiXG5Eb25lIGluIHt0aW1lLnRpbWUoKSAtIHQw
#6#Oi4wZn1zLiIpCiAgICByZXR1cm4gMAoKCmlmIF9fbmFtZV9fID09ICJfX21haW5fXyI6CiAgICBz
#6#eXMuZXhpdChtYWluKCkpCg==
