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
set "PP_VERSION=0.15.0"
set "PY_VERSION=3.12.8"
set "SCRIPTS=run_preprocess.py 1-ims_metadata.py 2-image_processor.py 3-chunk_packer.py 4-catalog_generator.py"
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

rem ---- Dependance optionnelle pour download/ : tifffile (OME-TIFF) ----------
:ensure_tifffile
%PY% -c "import tifffile" >nul 2>&1
if not errorlevel 1 exit /b 0
call :info "Dependance download/ manquante : tifffile (installation)..."
%PY% -m pip install --no-warn-script-location tifffile >nul 2>&1
%PY% -c "import tifffile" >nul 2>&1
if errorlevel 1 call :warnmsg "tifffile indisponible : l'OME-TIFF pourrait echouer."
exit /b 0


rem ---- Saisie des parametres -------------------------------------------------
:ask_params
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

rem Option : generer aussi le contenu de download/ (lourd : relit le .ims, OME-TIFF, zip)
set "WITH_DOWNLOADS="
set "_ans="
set /p "_ans=   Generer aussi les fichiers download/ (archive, OME-TIFF, MIP) ? [o/N] "
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


rem ---- Execution du pipeline -------------------------------------------------
:run_pipeline
echo.
call :info "Ctrl+C pendant le traitement : une confirmation sera demandee avant l'arret."
echo.
set "PYTHONUNBUFFERED=1"
set "PYTHONIOENCODING=utf-8"
set "EXTRA="
if defined WITH_DOWNLOADS (
    call :ensure_tifffile
    set "EXTRA=--with-downloads"
)
if defined FILTER (
    %PY% "!WORK!\!ENTRY!" --input "!INPUT!" --output "!OUTPUT!" --only "!FILTER!" !EXTRA!
) else (
    %PY% "!WORK!\!ENTRY!" --input "!INPUT!" --output "!OUTPUT!" !EXTRA!
)
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
:: ---- [0] run_preprocess.py (14091 octets) ----
#0#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwppbXBvcnQgYXJncGFyc2UKaW1wb3J0IGZubWF0Y2gKaW1w
#0#b3J0IGpzb24KaW1wb3J0IG9zCmltcG9ydCBzaHV0aWwKaW1wb3J0IHNpZ25hbAppbXBvcnQgc3Vi
#0#cHJvY2VzcwppbXBvcnQgc3lzCmltcG9ydCB0cmFjZWJhY2sKZnJvbSBkYXRldGltZSBpbXBvcnQg
#0#ZGF0ZXRpbWUKZnJvbSBwYXRobGliIGltcG9ydCBQYXRoCmltcG9ydCBudW1weSBhcyBucApmcm9t
#0#IFBJTCBpbXBvcnQgSW1hZ2UKCl9fdmVyc2lvbl9fID0gIjAuMTUuMCIKCiMg4pSA4pSAIFBhdGhz
#0#IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#0#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#0#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#0#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgApTQ1JJUFRfRElSID0gUGF0
#0#aChfX2ZpbGVfXykucmVzb2x2ZSgpLnBhcmVudApQWVRIT05fRVhFID0gc3lzLmV4ZWN1dGFibGUK
#0#CiMg4pSA4pSAIENvbnNvbGUgc3R5bGluZyAoZ3JhY2VmdWwgQU5TSTsgZGVncmFkZXMgdG8gcGxh
#0#aW4gb24gcmVkaXJlY3QgLyBuby1WVCkg4pSA4pSA4pSA4pSA4pSA4pSACmRlZiBfc3VwcG9ydHNf
#0#Y29sb3IoKSAtPiBib29sOgogICAgaWYgbm90IHN5cy5zdGRvdXQuaXNhdHR5KCk6CiAgICAgICAg
#0#cmV0dXJuIEZhbHNlCiAgICBpZiBvcy5uYW1lID09ICJudCI6CiAgICAgICAgdHJ5OgogICAgICAg
#0#ICAgICBpbXBvcnQgY3R5cGVzCiAgICAgICAgICAgIGsgPSBjdHlwZXMud2luZGxsLmtlcm5lbDMy
#0#CiAgICAgICAgICAgIGggPSBrLkdldFN0ZEhhbmRsZSgtMTEpCiAgICAgICAgICAgIG1vZGUgPSBj
#0#dHlwZXMuY191aW50MzIoKQogICAgICAgICAgICBpZiBub3Qgay5HZXRDb25zb2xlTW9kZShoLCBj
#0#dHlwZXMuYnlyZWYobW9kZSkpOgogICAgICAgICAgICAgICAgcmV0dXJuIEZhbHNlCiAgICAgICAg
#0#ICAgIGsuU2V0Q29uc29sZU1vZGUoaCwgbW9kZS52YWx1ZSB8IDB4MDAwNCkgICMgRU5BQkxFX1ZJ
#0#UlRVQUxfVEVSTUlOQUxfUFJPQ0VTU0lORwogICAgICAgIGV4Y2VwdCBFeGNlcHRpb246CiAgICAg
#0#ICAgICAgIHJldHVybiBGYWxzZQogICAgcmV0dXJuIFRydWUKCl9DT0xPUiA9IF9zdXBwb3J0c19j
#0#b2xvcigpCgpkZWYgX3N0eWxlKGNvZGU6IHN0ciwgdGV4dDogc3RyKSAtPiBzdHI6CiAgICByZXR1
#0#cm4gZiJcMDMzW3tjb2RlfW17dGV4dH1cMDMzWzBtIiBpZiBfQ09MT1IgZWxzZSB0ZXh0CgpkZWYg
#0#X2hkcihzKTogIHJldHVybiBfc3R5bGUoIjE7OTYiLCBzKSAgICMgYm9sZCBjeWFuCmRlZiBfb2so
#0#cyk6ICAgcmV0dXJuIF9zdHlsZSgiOTIiLCBzKSAgICAgIyBncmVlbgpkZWYgX2VycihzKTogIHJl
#0#dHVybiBfc3R5bGUoIjkxIiwgcykgICAgICMgcmVkCmRlZiBfd2FybihzKTogcmV0dXJuIF9zdHls
#0#ZSgiOTMiLCBzKSAgICAgIyB5ZWxsb3cKZGVmIF9kaW0ocyk6ICByZXR1cm4gX3N0eWxlKCI5MCIs
#0#IHMpICAgICAjIGdyZXkKCiMg4pSA4pSAIEdyYWNlZnVsIGludGVycnVwdGlvbiAoQ3RybCtDKSDi
#0#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#0#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#0#lIDilIDilIDilIDilIDilIDilIDilIAKIyBFYWNoIHN0ZXAgcnVucyBpbiBpdHMgT1dOIHByb2Nl
#0#c3MgZ3JvdXAsIHNvIGEgY29uc29sZSBDdHJsK0MgaXMgTk9UIGRlbGl2ZXJlZCB0bwojIHRoZSBj
#0#aGlsZCBkaXJlY3RseS4gVGhlIG9yY2hlc3RyYXRvciBpbnRlcmNlcHRzIFNJR0lOVCwgYXNrcyB0
#0#aGUgdXNlciB0byBjb25maXJtLAojIGFuZCBvbmx5IHRoZW4gdGVhcnMgdGhlIHJ1bm5pbmcgc3Rl
#0#cCAoYW5kIHRoZSB3b3JrZXIgcG9vbCBpdCBzcGF3bmVkKSBkb3duLgojIERlY2xpbmluZyB0aGUg
#0#cHJvbXB0IHJlc3VtZXMgdGhlIHN0ZXAgdHJhbnNwYXJlbnRseSDigJQgaXQgbmV2ZXIgcmVjZWl2
#0#ZWQgdGhlIHNpZ25hbC4KaWYgb3MubmFtZSA9PSAibnQiOgogICAgX1NURVBfU1BBV04gPSB7ImNy
#0#ZWF0aW9uZmxhZ3MiOiBzdWJwcm9jZXNzLkNSRUFURV9ORVdfUFJPQ0VTU19HUk9VUH0KZWxzZToK
#0#ICAgIF9TVEVQX1NQQVdOID0geyJzdGFydF9uZXdfc2Vzc2lvbiI6IFRydWV9CgpfY3VycmVudF9w
#0#cm9jID0gTm9uZSAgICAjIFBvcGVuIG9mIHRoZSBzdGVwIGN1cnJlbnRseSBydW5uaW5nIChvciBO
#0#b25lKQpfY29uZmlybWluZyA9IEZhbHNlICAgICAjIHJlLWVudHJhbmN5IGd1YXJkIGZvciB0aGUg
#0#Y29uZmlybWF0aW9uIHByb21wdAoKCmRlZiBfa2lsbF90cmVlKHByb2MpIC0+IE5vbmU6CiAgICAi
#0#IiJUZXJtaW5hdGUgYSBzdGVwIHByb2Nlc3MgYW5kIGV2ZXJ5IHdvcmtlciBpdCBzcGF3bmVkIChQ
#0#cm9jZXNzUG9vbEV4ZWN1dG9yKS4iIiIKICAgIGlmIHByb2MgaXMgTm9uZSBvciBwcm9jLnBvbGwo
#0#KSBpcyBub3QgTm9uZToKICAgICAgICByZXR1cm4KICAgIHRyeToKICAgICAgICBpZiBvcy5uYW1l
#0#ID09ICJudCI6CiAgICAgICAgICAgIHN1YnByb2Nlc3MucnVuKFsidGFza2tpbGwiLCAiL0YiLCAi
#0#L1QiLCAiL1BJRCIsIHN0cihwcm9jLnBpZCldLAogICAgICAgICAgICAgICAgICAgICAgICAgICBz
#0#dGRvdXQ9c3VicHJvY2Vzcy5ERVZOVUxMLCBzdGRlcnI9c3VicHJvY2Vzcy5ERVZOVUxMKQogICAg
#0#ICAgIGVsc2U6CiAgICAgICAgICAgIG9zLmtpbGxwZyhvcy5nZXRwZ2lkKHByb2MucGlkKSwgc2ln
#0#bmFsLlNJR1RFUk0pCiAgICBleGNlcHQgRXhjZXB0aW9uOgogICAgICAgIHBhc3MKICAgIHRyeToK
#0#ICAgICAgICBwcm9jLndhaXQodGltZW91dD0xMCkKICAgIGV4Y2VwdCBFeGNlcHRpb246CiAgICAg
#0#ICAgdHJ5OgogICAgICAgICAgICBwcm9jLmtpbGwoKQogICAgICAgIGV4Y2VwdCBFeGNlcHRpb246
#0#CiAgICAgICAgICAgIHBhc3MKCgpkZWYgX2luc3RhbGxfc2lnaW50X2hhbmRsZXIoKSAtPiBOb25l
#0#OgogICAgIiIiT24gQ3RybCtDLCBhc2sgZm9yIGNvbmZpcm1hdGlvbi4gQ29uZmlybSAtPiBhYm9y
#0#dCBjbGVhbmx5OyBkZWNsaW5lIC0+IHJlc3VtZS4iIiIKICAgIGRlZiBfaGFuZGxlcihzaWdudW0s
#0#IGZyYW1lKToKICAgICAgICBnbG9iYWwgX2NvbmZpcm1pbmcKICAgICAgICBpZiBfY29uZmlybWlu
#0#ZzoKICAgICAgICAgICAgIyBBIHNlY29uZCBDdHJsK0Mgd2hpbGUgdGhlIHByb21wdCBpcyB1cCBt
#0#ZWFuczogc3RvcCBub3csIGZvciBzdXJlLgogICAgICAgICAgICByYWlzZSBLZXlib2FyZEludGVy
#0#cnVwdAogICAgICAgIF9jb25maXJtaW5nID0gVHJ1ZQogICAgICAgIHRyeToKICAgICAgICAgICAg
#0#c3lzLnN0ZGVyci53cml0ZSgiXG4iKQogICAgICAgICAgICB0cnk6CiAgICAgICAgICAgICAgICBh
#0#bnN3ZXIgPSBpbnB1dChfd2FybigiWyFdIEFycmV0ZXIgbGUgcGlwZWxpbmUgZW4gY291cnMgPyAi
#0#KSArCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAiTGVzIGZpY2hpZXJzIHRlbXBvcmFp
#0#cmVzIHNlcm9udCBuZXR0b3llcy4gW28vTl0gIikKICAgICAgICAgICAgZXhjZXB0IEVPRkVycm9y
#0#OgogICAgICAgICAgICAgICAgYW5zd2VyID0gIm8iICAgIyBub24taW50ZXJhY3RpdmUgc3RkaW46
#0#IGNhbm5vdCBhc2sgLT4gc3RvcAogICAgICAgIGZpbmFsbHk6CiAgICAgICAgICAgIF9jb25maXJt
#0#aW5nID0gRmFsc2UKICAgICAgICBpZiBhbnN3ZXIuc3RyaXAoKS5sb3dlcigpIGluICgibyIsICJv
#0#dWkiLCAieSIsICJ5ZXMiKToKICAgICAgICAgICAgcmFpc2UgS2V5Ym9hcmRJbnRlcnJ1cHQKICAg
#0#ICAgICBwcmludChfZGltKCIgICAgcmVwcmlzZSBkdSB0cmFpdGVtZW50Li4uIikpCiAgICBzaWdu
#0#YWwuc2lnbmFsKHNpZ25hbC5TSUdJTlQsIF9oYW5kbGVyKQoKIyBIZXggY29sb3JzIHRvIFJHQiBt
#0#YXBwaW5nIGZvciBjb21wb3NpdGUgdGh1bWJuYWlsIChtYXRjaGVzIGNoYW5uZWwgY29sb3JzKQpU
#0#SFVNQl9DT0xPUlMgPSBbCiAgICAoMCwgMjU1LCAxMDIpLCAgICAjIGdyZWVuCiAgICAoMjU1LCA2
#0#MSwgMjU1KSwgICAjIG1hZ2VudGEKICAgICg0NywgMTA3LCAyNTUpLCAgICMgYmx1ZQogICAgKDI1
#0#NSwgNDgsIDQ4KSwgICAgIyByZWQKICAgICgyNTUsIDI1NSwgMCksICAgICMgeWVsbG93CiAgICAo
#0#MjU1LCAwLCAyNTUpLCAgICAjIHB1cnBsZQogICAgKDAsIDI1NSwgMjU1KSAgICAgIyBjeWFuCl0K
#0#CmRlZiBidWlsZF90aHVtYm5haWwodGVtcF9kaXI6IFBhdGgsIG91dHB1dF9kaXI6IFBhdGgsIHBy
#0#b2NfbWV0YTogZGljdCkgLT4gTm9uZToKICAgICIiIgogICAgQ29tcHV0ZXMgYSBNYXhpbXVtIElu
#0#dGVuc2l0eSBQcm9qZWN0aW9uIChNSVApIGZvciBlYWNoIGNoYW5uZWwgZnJvbSBwcm9jZXNzZWQK
#0#ICAgIGxvdy1yZXMgdm9sdW1lcyBhbmQgY29tcG9zaXRlcyB0aGVtIGludG8gYSBzdHVubmluZyBm
#0#YWxzZS1jb2xvciBSR0IgdGh1bWJuYWlsLgogICAgIiIiCiAgICBuX2NoID0gcHJvY19tZXRhWyJu
#0#X2NoYW5uZWxzIl0KICAgIGxvZF9sZXZlbHMgPSBwcm9jX21ldGFbImxvZF9sZXZlbHMiXQogICAg
#0#RCA9IHByb2NfbWV0YVsiZGVwdGgiXQogICAgCiAgICAjIFdlIHVzZSBMT0QxIG9yIExPRDIgdG8g
#0#c3BlZWQgdXAgTUlQIGNvbXB1dGF0aW9uIChtYXggNTEyLzEwMjQgd2lkdGgpCiAgICB0YXJnZXRf
#0#bG9kID0gMAogICAgZm9yIGxpIGluIGxvZF9sZXZlbHM6CiAgICAgICAgaWYgbWF4KGxpWyJ3aWR0
#0#aCJdLCBsaVsiaGVpZ2h0Il0pIDw9IDEwMjQ6CiAgICAgICAgICAgIHRhcmdldF9sb2QgPSBsaVsi
#0#bG9kIl0KICAgICAgICAgICAgYnJlYWsKICAgICAgICAgICAgCiAgICBsaSA9IGxvZF9sZXZlbHNb
#0#dGFyZ2V0X2xvZF0KICAgIHdfbG9kLCBoX2xvZCA9IGxpWyJ3aWR0aCJdLCBsaVsiaGVpZ2h0Il0K
#0#ICAgIAogICAgbWlwcyA9IFtdCiAgICBmb3IgYyBpbiByYW5nZShuX2NoKToKICAgICAgICBiaW5f
#0#ZmlsZSA9IHRlbXBfZGlyIC8gZiJ0MDAwX2N7Y31fbG9ke3RhcmdldF9sb2R9LmJpbiIKICAgICAg
#0#ICBpZiBub3QgYmluX2ZpbGUuZXhpc3RzKCk6CiAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAg
#0#IyBMb2FkIHByb2Nlc3NlZCB2b2x1bWUKICAgICAgICB2b2wgPSBucC5mcm9tZmlsZShzdHIoYmlu
#0#X2ZpbGUpLCBkdHlwZT1ucC51aW50OCkucmVzaGFwZSgoRCwgaF9sb2QsIHdfbG9kKSkKICAgICAg
#0#ICAjIENvbXB1dGUgTWF4aW11bSBJbnRlbnNpdHkgUHJvamVjdGlvbiBhbG9uZyBaIGF4aXMKICAg
#0#ICAgICBtaXAgPSB2b2wubWF4KGF4aXM9MCkKICAgICAgICBtaXBzLmFwcGVuZChtaXApCiAgICAg
#0#ICAgCiAgICBpZiBub3QgbWlwczoKICAgICAgICBwcmludCgiW1RIVU1CTkFJTF0gV2FybmluZzog
#0#Tm8gY2hhbm5lbCBiaW5hcnkgZmlsZXMgZm91bmQgdG8gYnVpbGQgdGh1bWJuYWlsLiIpCiAgICAg
#0#ICAgcmV0dXJuCgogICAgIyBDb21wb3NpdGUgTUlQcyBpbnRvIGZhbHNlLWNvbG9yIFJHQgogICAg
#0#Y29tcG9zaXRlID0gbnAuemVyb3MoKGhfbG9kLCB3X2xvZCwgMyksIGR0eXBlPW5wLmZsb2F0MzIp
#0#CiAgICBmb3IgaSwgbWlwIGluIGVudW1lcmF0ZShtaXBzKToKICAgICAgICByLCBnLCBiID0gVEhV
#0#TUJfQ09MT1JTW2kgJSBsZW4oVEhVTUJfQ09MT1JTKV0KICAgICAgICBub3JtID0gbWlwLmFzdHlw
#0#ZShucC5mbG9hdDMyKSAvIDI1NS4wCiAgICAgICAgY29tcG9zaXRlWzosIDosIDBdICs9IG5vcm0g
#0#KiByCiAgICAgICAgY29tcG9zaXRlWzosIDosIDFdICs9IG5vcm0gKiBnCiAgICAgICAgY29tcG9z
#0#aXRlWzosIDosIDJdICs9IG5vcm0gKiBiCgogICAgY29tcG9zaXRlID0gbnAuY2xpcChjb21wb3Np
#0#dGUsIDAsIDI1NSkuYXN0eXBlKG5wLnVpbnQ4KQogICAgaW1nID0gSW1hZ2UuZnJvbWFycmF5KGNv
#0#bXBvc2l0ZSwgbW9kZT0iUkdCIikKICAgIAogICAgIyBSZXNpemUgdG8gNTEyeDUxMiBwcmVzZXJ2
#0#aW5nIGFzcGVjdCByYXRpbwogICAgVEhVTUJfU0laRSA9IDUxMgogICAgc2NhbGUgPSBUSFVNQl9T
#0#SVpFIC8gbWF4KHdfbG9kLCBoX2xvZCkKICAgIG5ld193LCBuZXdfaCA9IG1heCgxLCByb3VuZCh3
#0#X2xvZCAqIHNjYWxlKSksIG1heCgxLCByb3VuZChoX2xvZCAqIHNjYWxlKSkKICAgIGltZyA9IGlt
#0#Zy5yZXNpemUoKG5ld193LCBuZXdfaCksIEltYWdlLlJlc2FtcGxpbmcuTEFOQ1pPUykKICAgIAog
#0#ICAgIyBQYWQgdG8gc3F1YXJlIHdpdGggZGFyayBiYWNrZ3JvdW5kICgjMDgwYTEyKQogICAgb3V0
#0#ID0gSW1hZ2UubmV3KCJSR0IiLCAoVEhVTUJfU0laRSwgVEhVTUJfU0laRSksICg4LCAxMCwgMTgp
#0#KQogICAgb2ZmX3ggPSAoVEhVTUJfU0laRSAtIG5ld193KSAvLyAyCiAgICBvZmZfeSA9IChUSFVN
#0#Ql9TSVpFIC0gbmV3X2gpIC8vIDIKICAgIG91dC5wYXN0ZShpbWcsIChvZmZfeCwgb2ZmX3kpKQog
#0#ICAgCiAgICB0aHVtYl9wYXRoID0gb3V0cHV0X2RpciAvICJ0aHVtYm5haWwud2VicCIKICAgIG91
#0#dC5zYXZlKHN0cih0aHVtYl9wYXRoKSwgIldFQlAiLCBxdWFsaXR5PTg4LCBtZXRob2Q9NikKICAg
#0#IHByaW50KGYiW1RIVU1CTkFJTF0gV3JvdGUgdGh1bWJuYWlsIHRvIHt0aHVtYl9wYXRofSIpCgpk
#0#ZWYgcnVuX3NjcmlwdChzY3JpcHRfcGF0aCwgKmFyZ3MsIGxhYmVsPU5vbmUpIC0+IE5vbmU6CiAg
#0#ICBnbG9iYWwgX2N1cnJlbnRfcHJvYwogICAgY21kID0gW1BZVEhPTl9FWEUsIHN0cihzY3JpcHRf
#0#cGF0aCksICphcmdzXQogICAgcHJpbnQoX2RpbShmIiAgIC0ge2xhYmVsIG9yIFBhdGgoc2NyaXB0
#0#X3BhdGgpLm5hbWV9IikpCiAgICBwcm9jID0gc3VicHJvY2Vzcy5Qb3BlbihjbWQsICoqX1NURVBf
#0#U1BBV04pCiAgICBfY3VycmVudF9wcm9jID0gcHJvYwogICAgdHJ5OgogICAgICAgIHJldCA9IHBy
#0#b2Mud2FpdCgpCiAgICBleGNlcHQgS2V5Ym9hcmRJbnRlcnJ1cHQ6CiAgICAgICAgIyBDb25maXJt
#0#ZWQgYWJvcnQgZHVyaW5nIHRoaXMgc3RlcDogdGVhciBkb3duIHRoZSBzdGVwIGFuZCBpdHMgd29y
#0#a2VyIHBvb2wuCiAgICAgICAgX2tpbGxfdHJlZShwcm9jKQogICAgICAgIHJhaXNlCiAgICBmaW5h
#0#bGx5OgogICAgICAgIF9jdXJyZW50X3Byb2MgPSBOb25lCiAgICBpZiByZXQgIT0gMDoKICAgICAg
#0#ICByYWlzZSBzdWJwcm9jZXNzLkNhbGxlZFByb2Nlc3NFcnJvcihyZXQsIGNtZCkKCgpkZWYgcnVu
#0#X3N0ZXAoc2NyaXB0X25hbWU6IHN0ciwgKmFyZ3MpIC0+IE5vbmU6CiAgICBydW5fc2NyaXB0KFND
#0#UklQVF9ESVIgLyBzY3JpcHRfbmFtZSwgKmFyZ3MpCgoKRE9XTkxPQURfU0NSSVBUX05BTUUgPSAi
#0#YnVpbGRfZG93bmxvYWRfYnVuZGxlcy5weSIKCmRlZiBfcmVzb2x2ZV9kb3dubG9hZF9zY3JpcHQo
#0#KToKICAgICIiIlRoZSBkb3dubG9hZC1idW5kbGUgdG9vbCBzaXRzIGluIHRvb2xzLyBpbiB0aGUg
#0#cmVwbywgYnV0IGlzIGV4dHJhY3RlZCBuZXh0CiAgICB0byB0aGlzIHNjcmlwdCBieSB0aGUgc2Vs
#0#Zi1jb250YWluZWQgbGF1bmNoZXIg4oCUIGFjY2VwdCBlaXRoZXIgbG9jYXRpb24uIiIiCiAgICBm
#0#b3IgY2FuZCBpbiAoU0NSSVBUX0RJUiAvIERPV05MT0FEX1NDUklQVF9OQU1FLAogICAgICAgICAg
#0#ICAgICAgIFNDUklQVF9ESVIucGFyZW50IC8gInRvb2xzIiAvIERPV05MT0FEX1NDUklQVF9OQU1F
#0#KToKICAgICAgICBpZiBjYW5kLmV4aXN0cygpOgogICAgICAgICAgICByZXR1cm4gY2FuZC5yZXNv
#0#bHZlKCkKICAgIHJldHVybiBOb25lCgpkZWYgcHJvY2Vzc19pbXNfZmlsZShpbXNfcGF0aDogUGF0
#0#aCwgb3V0cHV0X3Jvb3Q6IFBhdGgsIGlkeDogaW50ID0gMCwgdG90YWw6IGludCA9IDAsCiAgICAg
#0#ICAgICAgICAgICAgICAgIHdpdGhfZG93bmxvYWRzOiBib29sID0gRmFsc2UpIC0+IE5vbmU6CiAg
#0#ICBkYXRhc2V0X25hbWUgPSBpbXNfcGF0aC5zdGVtCiAgICBjb3VudGVyID0gZiJbe2lkeH0ve3Rv
#0#dGFsfV0gIiBpZiB0b3RhbCBlbHNlICIiCiAgICBwcmludCgpCiAgICBwcmludChfaGRyKGYiPj4g
#0#e2NvdW50ZXJ9e2RhdGFzZXRfbmFtZX0iKSkKICAgIHByaW50KF9kaW0oZiIgICBzb3VyY2UgOiB7
#0#aW1zX3BhdGh9IikpCiAgICB0MCA9IGRhdGV0aW1lLm5vdygpCiAgICAKICAgICMgU2V0dXAgZGly
#0#ZWN0b3JpZXMKICAgIHRlbXBfZGlyID0gb3V0cHV0X3Jvb3QgLyBmIi50ZW1wX3ByZXByb2Nlc3Nf
#0#e2RhdGFzZXRfbmFtZX0iCiAgICBpZiB0ZW1wX2Rpci5leGlzdHMoKToKICAgICAgICBzaHV0aWwu
#0#cm10cmVlKHRlbXBfZGlyKQogICAgdGVtcF9kaXIubWtkaXIocGFyZW50cz1UcnVlLCBleGlzdF9v
#0#az1UcnVlKQogICAgCiAgICB0cnk6CiAgICAgICAgIyBTdGVwIDE6IEV4dHJhY3Rpb24gb2YgbWV0
#0#YWRhdGEKICAgICAgICB0ZW1wX21ldGFfanNvbiA9IHRlbXBfZGlyIC8gIm1ldGEuanNvbiIKICAg
#0#ICAgICBydW5fc3RlcCgiMS1pbXNfbWV0YWRhdGEucHkiLCBzdHIoaW1zX3BhdGgpLCBzdHIodGVt
#0#cF9tZXRhX2pzb24pKQoKICAgICAgICAjIFRoZSBkYXRhc2V0IHR5cGUgZm9sbG93cyB0aGUgYWNx
#0#dWlzaXRpb246IGEgc3RhY2sgd2l0aCBtb3JlIHRoYW4gb25lCiAgICAgICAgIyB0aW1lcG9pbnQg
#0#aXMgYSB0aW1lbGFwc2UgYW5kIGJlbG9uZ3MgdW5kZXIgbGl2ZS8sIHdoaWNoIGlzIHdoYXQgZHJp
#0#dmVzIHRoZQogICAgICAgICMgdmlld2VyJ3MgdGltZWxpbmUuIFJlc29sdmVkIGhlcmUgYmVjYXVz
#0#ZSBvbmx5IHN0ZXAgMSBrbm93cyB0aGUgZnJhbWUgY291bnQuCiAgICAgICAgd2l0aCBvcGVuKHRl
#0#bXBfbWV0YV9qc29uLCAiciIsIGVuY29kaW5nPSJ1dGYtOCIpIGFzIGZtOgogICAgICAgICAgICBu
#0#X3RpbWVwb2ludHMgPSBpbnQoanNvbi5sb2FkKGZtKS5nZXQoIm5fdGltZXBvaW50cyIsIDEpIG9y
#0#IDEpCiAgICAgICAgdHlwZV9kaXIgPSAibGl2ZSIgaWYgbl90aW1lcG9pbnRzID4gMSBlbHNlICJm
#0#aXhlZCIKICAgICAgICBkYXRhc2V0X291dHB1dF9kaXIgPSBvdXRwdXRfcm9vdCAvIHR5cGVfZGly
#0#IC8gZGF0YXNldF9uYW1lCiAgICAgICAgaWYgZGF0YXNldF9vdXRwdXRfZGlyLmV4aXN0cygpOgog
#0#ICAgICAgICAgICBicmlja3NfZGlyID0gZGF0YXNldF9vdXRwdXRfZGlyIC8gImJyaWNrcyIKICAg
#0#ICAgICAgICAgaWYgYnJpY2tzX2Rpci5leGlzdHMoKToKICAgICAgICAgICAgICAgIHNodXRpbC5y
#0#bXRyZWUoYnJpY2tzX2RpcikKICAgICAgICBkYXRhc2V0X291dHB1dF9kaXIubWtkaXIocGFyZW50
#0#cz1UcnVlLCBleGlzdF9vaz1UcnVlKQogICAgICAgIGlmIG5fdGltZXBvaW50cyA+IDE6CiAgICAg
#0#ICAgICAgIHByaW50KF9kaW0oZiIgICB0eXBlICAgOiBsaXZlICh7bl90aW1lcG9pbnRzfSB0aW1l
#0#cG9pbnRzKSIpKQoKICAgICAgICAjIFN0ZXAgMjogTm9ybWFsaXphdGlvbiwgQmFja2dyb3VuZCBz
#0#dWJ0cmFjdGlvbiwgRG93bnNjYWxpbmcKICAgICAgICBydW5fc3RlcCgiMi1pbWFnZV9wcm9jZXNz
#0#b3IucHkiLCBzdHIoaW1zX3BhdGgpLCBzdHIodGVtcF9tZXRhX2pzb24pLCBzdHIodGVtcF9kaXIp
#0#KQogICAgICAgIAogICAgICAgICMgU3RlcCAzOiBDb21wdXRlIHRodW1ibmFpbCBNSVAKICAgICAg
#0#ICB3aXRoIG9wZW4odGVtcF9kaXIgLyAicHJvY2Vzc2luZ19tZXRhLmpzb24iLCAiciIsIGVuY29k
#0#aW5nPSJ1dGYtOCIpIGFzIGZtOgogICAgICAgICAgICBwcm9jX21ldGEgPSBqc29uLmxvYWQoZm0p
#0#CiAgICAgICAgYnVpbGRfdGh1bWJuYWlsKHRlbXBfZGlyLCBkYXRhc2V0X291dHB1dF9kaXIsIHBy
#0#b2NfbWV0YSkKICAgICAgICAKICAgICAgICAjIFN0ZXAgNDogQ2h1bmtpbmcgNjTCsyAmIFBhY2sg
#0#YnVpbGRpbmcKICAgICAgICBydW5fc3RlcCgiMy1jaHVua19wYWNrZXIucHkiLCBzdHIodGVtcF9k
#0#aXIpLCBzdHIoZGF0YXNldF9vdXRwdXRfZGlyKSkKICAgICAgICAKICAgICAgICAjIFN0ZXAgNTog
#0#Q2F0YWxvZyBtZXRhZGF0YSAoZGF0YXNldC5qc29uIC8gbWV0YWRhdGEuanNvbikKICAgICAgICBy
#0#dW5fc3RlcCgiNC1jYXRhbG9nX2dlbmVyYXRvci5weSIsIHN0cih0ZW1wX2RpciksIHN0cihkYXRh
#0#c2V0X291dHB1dF9kaXIpKQoKICAgICAgICAjIFN0ZXAgNiAob3B0aW9uYWwpOiBkb3dubG9hZC8g
#0#YnVuZGxlIOKAlCBhcmNoaXZlLCBvcmlnaW5hbCAuaW1zLCBPTUUtVElGRiwKICAgICAgICAjIHBl
#0#ci1jaGFubmVsIE1JUHMsIFJFQURNRS4gUnVucyBhZnRlciBzdGVwIDQgc28gbWV0YWRhdGEuanNv
#0#biBleGlzdHMuIFRoZQogICAgICAgICMgc291cmNlIC5pbXMgaXMgdGhlIG9uZSBiZWluZyBwcm9j
#0#ZXNzZWQsIHNvIHBvaW50IHRoZSB0b29sIGF0IGl0cyBmb2xkZXIuCiAgICAgICAgaWYgd2l0aF9k
#0#b3dubG9hZHM6CiAgICAgICAgICAgIGRsX3NjcmlwdCA9IF9yZXNvbHZlX2Rvd25sb2FkX3Njcmlw
#0#dCgpCiAgICAgICAgICAgIGlmIGRsX3NjcmlwdCBpcyBOb25lOgogICAgICAgICAgICAgICAgcHJp
#0#bnQoX3dhcm4oZiIgICBbIV0ge0RPV05MT0FEX1NDUklQVF9OQU1FfSBpbnRyb3V2YWJsZSDigJQg
#0#ZG93bmxvYWQvIGlnbm9yZSIpKQogICAgICAgICAgICBlbHNlOgogICAgICAgICAgICAgICAgcnVu
#0#X3NjcmlwdChkbF9zY3JpcHQsCiAgICAgICAgICAgICAgICAgICAgICAgICAgICItLWRhdGEtd2Vi
#0#Iiwgc3RyKG91dHB1dF9yb290KSwKICAgICAgICAgICAgICAgICAgICAgICAgICAgIi0tcmF3LWRp
#0#ciIsIHN0cihpbXNfcGF0aC5wYXJlbnQpLAogICAgICAgICAgICAgICAgICAgICAgICAgICAiLS1k
#0#YXRhc2V0cyIsIGRhdGFzZXRfbmFtZSwKICAgICAgICAgICAgICAgICAgICAgICAgICAgbGFiZWw9
#0#ImRvd25sb2FkLyAoYXJjaGl2ZSwgT01FLVRJRkYsIE1JUCkiKQoKICAgICAgICBlbGFwc2VkID0g
#0#KGRhdGV0aW1lLm5vdygpIC0gdDApLnRvdGFsX3NlY29uZHMoKQogICAgICAgIHByaW50KF9vayhm
#0#IiAgIFtPS10ge2RhdGFzZXRfbmFtZX0gdGVybWluZSBlbiB7ZWxhcHNlZDouMGZ9cyIpKQogICAg
#0#ZXhjZXB0IEV4Y2VwdGlvbiBhcyBlOgogICAgICAgIHByaW50KF9lcnIoZiIgICBbWF0ge2RhdGFz
#0#ZXRfbmFtZX0gOiB7ZX0iKSwgZmlsZT1zeXMuc3RkZXJyKQogICAgICAgIHRyYWNlYmFjay5wcmlu
#0#dF9leGMoKQogICAgZmluYWxseToKICAgICAgICAjIENsZWFuIHVwIHRlbXBvcmFyeSBwcm9jZXNz
#0#aW5nIGJpbmFyeSBmaWxlcyB0byBmcmVlIHNwYWNlLgogICAgICAgICMgaWdub3JlX2Vycm9yczog
#0#b24gYSBDdHJsK0MgdGVhcmRvd24gYSBqdXN0LWtpbGxlZCB3b3JrZXIgbWF5IHN0aWxsIGhvbGQg
#0#YQogICAgICAgICMgaGFuZGxlIGZvciBhIGZldyBtcyDigJQgbmV2ZXIgbGV0IGNsZWFudXAgbWFz
#0#ayB0aGUgaW50ZXJydXB0aW9uLgogICAgICAgIGlmIHRlbXBfZGlyLmV4aXN0cygpOgogICAgICAg
#0#ICAgICBzaHV0aWwucm10cmVlKHRlbXBfZGlyLCBpZ25vcmVfZXJyb3JzPVRydWUpCgpkZWYgbWFp
#0#bigpOgogICAgcGFyc2VyID0gYXJncGFyc2UuQXJndW1lbnRQYXJzZXIoZGVzY3JpcHRpb249IklS
#0#SUJITSBNaWNyb3Njb3B5IFByZXByb2Nlc3NpbmcgVW5pZmllZCBQaXBlbGluZSIpCiAgICBwYXJz
#0#ZXIuYWRkX2FyZ3VtZW50KCItLWlucHV0IiwgcmVxdWlyZWQ9VHJ1ZSwgaGVscD0iSW5wdXQgZGly
#0#ZWN0b3J5IGNvbnRhaW5pbmcgcmF3IC5pbXMgZmlsZXMuIikKICAgIHBhcnNlci5hZGRfYXJndW1l
#0#bnQoIi0tb3V0cHV0IiwgcmVxdWlyZWQ9VHJ1ZSwgaGVscD0iT3V0cHV0IERBVEFfV0VCIGRpcmVj
#0#dG9yeSBvZiB0aGUgd2ViIHBsYXRmb3JtLiIpCiAgICBwYXJzZXIuYWRkX2FyZ3VtZW50KCItLW9u
#0#bHkiLCBkZWZhdWx0PU5vbmUsIGhlbHA9Ikdsb2IgcGF0dGVybiB0byBmaWx0ZXIgZmlsZXMgdG8g
#0#cHJvY2VzcyAoZS5nLiAnKkU4KicpLiIpCiAgICBwYXJzZXIuYWRkX2FyZ3VtZW50KCItLXdpdGgt
#0#ZG93bmxvYWRzIiwgYWN0aW9uPSJzdG9yZV90cnVlIiwKICAgICAgICAgICAgICAgICAgICAgICAg
#0#aGVscD0iQWZ0ZXIgZWFjaCBkYXRhc2V0LCBhbHNvIGJ1aWxkIGl0cyBkb3dubG9hZC8gYnVuZGxl
#0#ICIKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAiKHdlYiBhcmNoaXZlLCBvcmlnaW5hbCAu
#0#aW1zLCBPTUUtVElGRiwgcGVyLWNoYW5uZWwgTUlQLCBSRUFETUUpLiIpCiAgICBhcmdzID0gcGFy
#0#c2VyLnBhcnNlX2FyZ3MoKQoKICAgIGlucHV0X2RpciA9IFBhdGgoYXJncy5pbnB1dCkKICAgIG91
#0#dHB1dF9kaXIgPSBQYXRoKGFyZ3Mub3V0cHV0KQoKICAgIGlmIG5vdCBpbnB1dF9kaXIuaXNfZGly
#0#KCk6CiAgICAgICAgc3lzLmV4aXQoZiJbRkFUQUxdIElucHV0IGRpcmVjdG9yeSBub3QgZm91bmQ6
#0#IHtpbnB1dF9kaXJ9IikKICAgICAgICAKICAgIG91dHB1dF9kaXIubWtkaXIocGFyZW50cz1UcnVl
#0#LCBleGlzdF9vaz1UcnVlKQoKICAgICMgR2xvYiBJTVMgZmlsZXMKICAgIGltc19maWxlcyA9IHNv
#0#cnRlZChpbnB1dF9kaXIuZ2xvYigiKi5pbXMiKSkKICAgIGlmIGFyZ3Mub25seToKICAgICAgICBp
#0#bXNfZmlsZXMgPSBbcCBmb3IgcCBpbiBpbXNfZmlsZXMgaWYgZm5tYXRjaC5mbm1hdGNoKHAubmFt
#0#ZSwgYXJncy5vbmx5KV0KCiAgICBpZiBub3QgaW1zX2ZpbGVzOgogICAgICAgIHByaW50KF93YXJu
#0#KGYiQXVjdW4gZmljaGllciAuaW1zIGNvcnJlc3BvbmRhbnQgZGFucyB7aW5wdXRfZGlyfSIpKQog
#0#ICAgICAgIHN5cy5leGl0KDApCgogICAgcHJpbnQoKQogICAgcHJpbnQoX2hkcigiICBQaXBlbGlu
#0#ZSBkZSBwcmVwcm9jZXNzaW5nICAiKSArIF9kaW0oZiJ2e19fdmVyc2lvbl9ffSIpKQogICAgcHJp
#0#bnQoX2RpbShmIiAgc291cmNlICAgICAgOiB7aW5wdXRfZGlyfSIpKQogICAgcHJpbnQoX2RpbShm
#0#IiAgZGVzdGluYXRpb24gOiB7b3V0cHV0X2Rpcn0iKSkKICAgIHByaW50KF9kaW0oZiIgIGRhdGFz
#0#ZXRzICAgIDoge2xlbihpbXNfZmlsZXMpfSAgIChmaWx0cmU6IHthcmdzLm9ubHkgb3IgJyonfSki
#0#KSkKICAgIHByaW50KF9kaW0oZiIgIGRvd25sb2FkLyAgIDogeydvdWknIGlmIGFyZ3Mud2l0aF9k
#0#b3dubG9hZHMgZWxzZSAnbm9uJ30iKSkKCiAgICAjIEdyYWNlZnVsIEN0cmwrQzogY29uZmlybSB3
#0#aXRoIHRoZSB1c2VyLCB0aGVuIHRlYXIgdGhlIHJ1bm5pbmcgc3RlcCBkb3duIGNsZWFubHkuCiAg
#0#ICBfaW5zdGFsbF9zaWdpbnRfaGFuZGxlcigpCgogICAgIyBPbmUgZGF0YXNldCBhdCBhIHRpbWUg
#0#KGJvdW5kZWQgUkFNKSDigJQgZWFjaCBzdGVwIGFscmVhZHkgbXVsdGl0aHJlYWRzIGludGVybmFs
#0#bHkuCiAgICBpbnRlcnJ1cHRlZCA9IEZhbHNlCiAgICBmb3IgaSwgaW1zX2ZpbGUgaW4gZW51bWVy
#0#YXRlKGltc19maWxlcyk6CiAgICAgICAgdHJ5OgogICAgICAgICAgICBwcm9jZXNzX2ltc19maWxl
#0#KGltc19maWxlLCBvdXRwdXRfZGlyLCBpICsgMSwgbGVuKGltc19maWxlcyksCiAgICAgICAgICAg
#0#ICAgICAgICAgICAgICAgICAgd2l0aF9kb3dubG9hZHM9YXJncy53aXRoX2Rvd25sb2FkcykKICAg
#0#ICAgICBleGNlcHQgS2V5Ym9hcmRJbnRlcnJ1cHQ6CiAgICAgICAgICAgIGludGVycnVwdGVkID0g
#0#VHJ1ZQogICAgICAgICAgICBicmVhawogICAgICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZXhjOgog
#0#ICAgICAgICAgICBwcmludChfZXJyKGYiICAgW1hdIHtpbXNfZmlsZS5uYW1lfSA6IHtleGN9Iikp
#0#CgogICAgaWYgaW50ZXJydXB0ZWQ6CiAgICAgICAgIyBSZW1vdmUgYW55IGhhbGYtd3JpdHRlbiB0
#0#ZW1wIGZvbGRlciBsZWZ0IGJ5IHRoZSBhYm9ydGVkIGRhdGFzZXQuCiAgICAgICAgZm9yIHN0cmF5
#0#IGluIG91dHB1dF9kaXIuZ2xvYigiLnRlbXBfcHJlcHJvY2Vzc18qIik6CiAgICAgICAgICAgIHNo
#0#dXRpbC5ybXRyZWUoc3RyYXksIGlnbm9yZV9lcnJvcnM9VHJ1ZSkKICAgICAgICBwcmludCgpCiAg
#0#ICAgICAgcHJpbnQoX3dhcm4oIiAgUGlwZWxpbmUgaW50ZXJyb21wdSBwYXIgbCd1dGlsaXNhdGV1
#0#ciAoQ3RybCtDKS4gRXRhdCBuZXR0b3llLiIpKQogICAgICAgIHN5cy5leGl0KDEzMCkKCiAgICBw
#0#cmludCgpCiAgICBwcmludChfb2soIiAgUGlwZWxpbmUgdGVybWluZS4iKSkKCmlmIF9fbmFtZV9f
#0#ID09ICJfX21haW5fXyI6CiAgICB0cnk6CiAgICAgICAgbWFpbigpCiAgICBleGNlcHQgS2V5Ym9h
#0#cmRJbnRlcnJ1cHQ6CiAgICAgICAgIyBDdHJsK0MgY29uZmlybWVkIG91dHNpZGUgYSBkYXRhc2V0
#0#IChlLmcuIGJldHdlZW4gc3RlcHMpIOKAlCBleGl0IGNsZWFubHkuCiAgICAgICAgcHJpbnQoX3dh
#0#cm4oIlxuWyFdIFBpcGVsaW5lIGFycmV0ZS4iKSwgZmlsZT1zeXMuc3RkZXJyKQogICAgICAgIHN5
#0#cy5leGl0KDEzMCkK
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
:: ---- [2] 2-image_processor.py (16576 octets) ----
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
#2#ZGVmIF9jb3JuZXJfc2FtcGxlcyh2b2wsIFcsIEgsIEQpOgogICAgIiIiVGhlIDggY29ybmVyIGN1
#2#YmVzIOKAlCBwdXJlIGNhbWVyYSBiYWNrZ3JvdW5kLCBubyBzcGVjaW1lbiB0aGVyZS4iIiIKICAg
#2#IGNvcm5lcl9zaXplID0gbWF4KDEsIG1pbigzMiwgVyAvLyA0LCBIIC8vIDQsIEQgLy8gNCkpCiAg
#2#ICBjb3JuZXJzID0gWwogICAgICAgIHZvbFs6Y29ybmVyX3NpemUsIDpjb3JuZXJfc2l6ZSwgOmNv
#2#cm5lcl9zaXplXSwKICAgICAgICB2b2xbOmNvcm5lcl9zaXplLCA6Y29ybmVyX3NpemUsIC1jb3Ju
#2#ZXJfc2l6ZTpdLAogICAgICAgIHZvbFs6Y29ybmVyX3NpemUsIC1jb3JuZXJfc2l6ZTosIDpjb3Ju
#2#ZXJfc2l6ZV0sCiAgICAgICAgdm9sWzpjb3JuZXJfc2l6ZSwgLWNvcm5lcl9zaXplOiwgLWNvcm5l
#2#cl9zaXplOl0sCiAgICAgICAgdm9sWy1jb3JuZXJfc2l6ZTosIDpjb3JuZXJfc2l6ZSwgOmNvcm5l
#2#cl9zaXplXSwKICAgICAgICB2b2xbLWNvcm5lcl9zaXplOiwgOmNvcm5lcl9zaXplLCAtY29ybmVy
#2#X3NpemU6XSwKICAgICAgICB2b2xbLWNvcm5lcl9zaXplOiwgLWNvcm5lcl9zaXplOiwgOmNvcm5l
#2#cl9zaXplXSwKICAgICAgICB2b2xbLWNvcm5lcl9zaXplOiwgLWNvcm5lcl9zaXplOiwgLWNvcm5l
#2#cl9zaXplOl0KICAgIF0KICAgIHJldHVybiBucC5jb25jYXRlbmF0ZShbYy5mbGF0dGVuKCkgZm9y
#2#IGMgaW4gY29ybmVyc10pCgoKZGVmIF9lc3RpbWF0ZV9nbG9iYWxfYm91bmRzKHJlczAsIHRwX2tl
#2#eXMsIGNfaWR4LCBXLCBILCBEKToKICAgICIiIlNoYXJlZCBbYmdfZmxvb3IsIHNpZ19tYXhdIHdp
#2#bmRvdyBmb3Igb25lIGNoYW5uZWwgb2YgYSB0aW1lbGFwc2UuCgogICAgTGV2ZWxsaW5nIGVhY2gg
#2#ZnJhbWUgYWdhaW5zdCBpdHMgb3duIHBlcmNlbnRpbGVzIG1ha2VzIHRoZSBzZXJpZXMgZmxpY2tl
#2#cjogYXMKICAgIHRoZSBzcGVjaW1lbiBibGVhY2hlcywgYSBwZXItZnJhbWUgd2luZG93IGtlZXBz
#2#IHJlLXN0cmV0Y2hpbmcgYSBmYWRpbmcgc2lnbmFsCiAgICBiYWNrIHRvIGZ1bGwgcmFuZ2UsIHNv
#2#IHRoZSBhcHBhcmVudCBicmlnaHRuZXNzIHN0YXlzIGNvbnN0YW50IHdoaWxlIHRoZSByZWFsCiAg
#2#ICBvbmUgY29sbGFwc2VzIOKAlCB2aXN1YWxseSB3cm9uZyBhbmQgcXVhbnRpdGF0aXZlbHkgbWlz
#2#bGVhZGluZy4gUG9vbGluZyB0aGUKICAgIGNvcm5lciBub2lzZSBhbmQgdGhlIHN1Yi1zYW1wbGVk
#2#IHNpZ25hbCBvdmVyIHNldmVyYWwgZnJhbWVzIHlpZWxkcyBPTkUgd2luZG93LAogICAgd2hpY2gg
#2#aXMgdGhlIHNhbWUgZXN0aW1hdG9yIHRoZSBzaW5nbGUtdGltZXBvaW50IHBhdGggdXNlcywganVz
#2#dCBldmFsdWF0ZWQgb24KICAgIHRoZSBwb29sZWQgc2VyaWVzLiBGcmFtZXMgdGhlbiBkaW0gZXhh
#2#Y3RseSBhcyBtdWNoIGFzIHRoZSBzcGVjaW1lbiByZWFsbHkgZGlkLgogICAgIiIiCiAgICBuX3Rw
#2#ID0gbGVuKHRwX2tleXMpCiAgICBjb3VudCA9IG1pbihHTE9CQUxfTk9STV9TQU1QTEVTLCBuX3Rw
#2#KQogICAgaWYgY291bnQgPj0gbl90cDoKICAgICAgICBzYW1wbGVfaWR4ID0gbGlzdChyYW5nZShu
#2#X3RwKSkKICAgIGVsc2U6CiAgICAgICAgc2FtcGxlX2lkeCA9IHNvcnRlZCh7aW50KHJvdW5kKGkg
#2#KiAobl90cCAtIDEpIC8gKGNvdW50IC0gMSkpKSBmb3IgaSBpbiByYW5nZShjb3VudCl9KQoKICAg
#2#IGNvcm5lcl9wb29sLCBzaWduYWxfcG9vbCA9IFtdLCBbXQogICAgcHJpbnQoZiJbUFJPQ0VTU10g
#2#R2xvYmFsIG5vcm1hbGl6YXRpb246IHNhbXBsaW5nIHRpbWVwb2ludHMge3NhbXBsZV9pZHh9IGZv
#2#ciBjaGFubmVsIHtjX2lkeH0uLi4iLAogICAgICAgICAgZmx1c2g9VHJ1ZSkKICAgIGZvciB0X2lk
#2#eCBpbiBzYW1wbGVfaWR4OgogICAgICAgIGNoX2tleXMgPSBzb3J0ZWQoW2sgZm9yIGsgaW4gcmVz
#2#MFt0cF9rZXlzW3RfaWR4XV0ua2V5cygpIGlmIGsuc3RhcnRzd2l0aCgiQ2hhbm5lbCIpXSwKICAg
#2#ICAgICAgICAgICAgICAgICAgICAgIGtleT1sYW1iZGEgeDogaW50KHguc3BsaXQoKVstMV0pKQog
#2#ICAgICAgIGlmIGNfaWR4ID49IGxlbihjaF9rZXlzKToKICAgICAgICAgICAgY29udGludWUKICAg
#2#ICAgICB2b2wgPSByZXMwW3RwX2tleXNbdF9pZHhdXVtjaF9rZXlzW2NfaWR4XV1bIkRhdGEiXVs6
#2#RCwgOkgsIDpXXS5hc3R5cGUobnAuZmxvYXQzMikKICAgICAgICBjb3JuZXJfcG9vbC5hcHBlbmQo
#2#X2Nvcm5lcl9zYW1wbGVzKHZvbCwgVywgSCwgRCkpCiAgICAgICAgc2lnbmFsX3Bvb2wuYXBwZW5k
#2#KHZvbFs6OjQsIDo6NCwgOjo0XS5mbGF0dGVuKCkpCiAgICAgICAgZGVsIHZvbAoKICAgIHBvb2xl
#2#ZCA9IG5wLmNvbmNhdGVuYXRlKHNpZ25hbF9wb29sKQogICAgYmdfZmxvb3IgPSBmbG9hdChucC5w
#2#ZXJjZW50aWxlKG5wLmNvbmNhdGVuYXRlKGNvcm5lcl9wb29sKSwgOTkuMCkpCgogICAgIyBXaGl0
#2#ZSBwb2ludCA9ICJzYXR1cmF0ZSB0aGUgYnJpZ2h0ZXN0IDAuMSAlIE9GIFRIRSBTSUdOQUwiLCBu
#2#b3Qgb2YgdGhlIHZvbHVtZS4KICAgICMgVGhlIHNpbmdsZS10aW1lcG9pbnQgcnVsZSB0YWtlcyB0
#2#aGUgOTkuOXRoIHBlcmNlbnRpbGUgb2YgZXZlcnkgdm94ZWwsIHdoaWNoCiAgICAjIGFzc3VtZXMg
#2#dGhlIHNwZWNpbWVuIGZpbGxzIGEgZ29vZCBzaGFyZSBvZiB0aGUgZnJhbWUuIEEgdGltZWxhcHNl
#2#IG9mIGEgc3BhcnNlCiAgICAjIGZsdW9yZXNjZW50IHN0cnVjdHVyZSBicmVha3MgdGhhdCBhc3N1
#2#bXB0aW9uOiBoZXJlIHRoZSBzaWduYWwgaXMgMC40ICUgb2YgdGhlCiAgICAjIHZveGVscywgc28g
#2#YSB3aG9sZS12b2x1bWUgcGVyY2VudGlsZSBzaXRzIGluc2lkZSB0aGUgYmFja2dyb3VuZCBhbmQg
#2#Y2xpcHMgMTUgJQogICAgIyBvZiB0aGUgcmVhbCBzaWduYWwgdG8gcHVyZSB3aGl0ZS4gUmFua2lu
#2#ZyBvbmx5IHRoZSB2b3hlbHMgYWJvdmUgdGhlIG5vaXNlIGZsb29yCiAgICAjIGtlZXBzIHRoZSBz
#2#YW1lIGludGVudCBhbmQgZHJvcHMgdGhlIGNsaXBwZWQgZnJhY3Rpb24gdG8gfjAuMDYgJS4KICAg
#2#IGFib3ZlID0gcG9vbGVkW3Bvb2xlZCA+IGJnX2Zsb29yXQogICAgaWYgYWJvdmUuc2l6ZSA+PSAx
#2#MDAwOgogICAgICAgIHNpZ19tYXggPSBmbG9hdChucC5wZXJjZW50aWxlKGFib3ZlLCA5OS45KSkK
#2#ICAgICAgICBiYXNpcyA9IGYie2Fib3ZlLnNpemV9IHZveGVscyBhYm92ZSB0aGUgbm9pc2UgZmxv
#2#b3IiCiAgICBlbHNlOgogICAgICAgIHNpZ19tYXggPSBmbG9hdChucC5wZXJjZW50aWxlKHBvb2xl
#2#ZCwgOTkuOSkpCiAgICAgICAgYmFzaXMgPSAid2hvbGUgdm9sdW1lICh0b28gbGl0dGxlIHNpZ25h
#2#bCB0byByYW5rKSIKICAgIHByaW50KGYiICAgIGdsb2JhbCBiZ19mbG9vcj17YmdfZmxvb3I6LjJm
#2#fSAgc2lnX21heD17c2lnX21heDouMmZ9ICIKICAgICAgICAgIGYiKHBvb2xlZCBvdmVyIHtsZW4o
#2#Y29ybmVyX3Bvb2wpfSB0aW1lcG9pbnRzLCB3aGl0ZSBwb2ludCBmcm9tIHtiYXNpc30pIiwgZmx1
#2#c2g9VHJ1ZSkKICAgIHJldHVybiBiZ19mbG9vciwgc2lnX21heAoKZGVmIHByb2Nlc3Nfel9ibG9j
#2#ayhhcmdzKToKICAgICIiIlNlbGVjdGl2ZSBNYXNrZWQgTWVkaWFuIEZpbHRlcmluZyArIFdpbmRv
#2#dyBMZXZlbGluZyBmb3Igb25lIFotYmxvY2suCgogICAgSW5zaWRlIHRoZSBzaWduYWwgbWFzayB0
#2#aGUgb3JpZ2luYWwgKHNoYXJwKSBiaW9sb2dpY2FsIHNpZ25hbCBpcyBrZXB0IGFzLWlzOwogICAg
#2#b3V0c2lkZSB0aGUgbWFzayB0aGUgYmFja2dyb3VuZCBpcyByZXBsYWNlZCBieSBhIDNEIG1lZGlh
#2#biAoc2l6ZT0zKSB0aGF0CiAgICBjcnVzaGVzIHNob3Qtbm9pc2UgYW5kIGlzb2xhdGVkIGhvdCBw
#2#aXhlbHMgd2l0aG91dCBibHVycmluZyB0aGUgY2VsbHMuIFRoZQogICAgYmxvY2sgY2FycmllcyBh
#2#IMKxMSBaIGhhbG8gc28gdGhlIG1lZGlhbiBzZWVzIHJlYWwgbmVpZ2hib3VycyBhY3Jvc3MgYmxv
#2#Y2sKICAgIHNlYW1zOyB0aGUgaGFsbyBpcyBzdHJpcHBlZCBiZWZvcmUgd3JpdGluZyBiYWNrLiBG
#2#aW5hbGx5IGEgV2luZG93IExldmVsaW5nIG1hcHMKICAgIFtiZ19mbG9vciwgc2lnX21heF0gLT4g
#2#WzAsIDI1NV0gKHVpbnQ4KSDigJQgYW55IHZhbHVlIDw9IGJnX2Zsb29yIGNvbGxhcHNlcyB0bwog
#2#ICAgYW4gYWJzb2x1dGUgMCwgZ3VhcmFudGVlaW5nIHB1cmUtYmxhY2sgZW1wdHkgc3BhY2UgZm9y
#2#IHRoZSBTVlIgYnJpY2sgcGFja2VyLgoKICAgIFRoZSB2b2x1bWUsIHRoZSBtYXNrIGFuZCB0aGUg
#2#b3V0cHV0IGJ1ZmZlciBsaXZlIGluIHNoYXJlZCBtZW1vcnk6IHRoZSB3b3JrZXIKICAgIHJlY2Vp
#2#dmVzIG9ubHkgbmFtZXMgYW5kIGluZGljZXMuIFNoaXBwaW5nIHRoZSBibG9ja3MgdGhlbXNlbHZl
#2#cyB0aHJvdWdoIHRoZQogICAgcHJvY2VzcyBwb29sIG1vdmVkIH4yODUgTUIgcGVyIHRpbWVwb2lu
#2#dCBhY3Jvc3MgV2luZG93cyBwaXBlcyBhbmQgZXhoYXVzdGVkIHRoZQogICAgT1MgKCJXaW5FcnJv
#2#ciAxNDUwOiBpbnN1ZmZpY2llbnQgc3lzdGVtIHJlc291cmNlcyIpIHRoZSBtb21lbnQgdGhlIHBp
#2#cGVsaW5lIGhhZAogICAgbW9yZSB0aGFuIG9uZSBmcmFtZSB0byBncmluZCB0aHJvdWdoLgogICAg
#2#IiIiCiAgICAodm9sX25hbWUsIG1hc2tfbmFtZSwgb3V0X25hbWUsIHNoYXBlLCB6X3N0YXJ0LCB6
#2#X2VuZCwKICAgICBoYWxvX2xvLCBoYWxvX2hpLCBiZ19mbG9vciwgc2lnX21heCkgPSBhcmdzCgog
#2#ICAgdm9sX3NobSA9IHNoYXJlZF9tZW1vcnkuU2hhcmVkTWVtb3J5KG5hbWU9dm9sX25hbWUpCiAg
#2#ICBtYXNrX3NobSA9IHNoYXJlZF9tZW1vcnkuU2hhcmVkTWVtb3J5KG5hbWU9bWFza19uYW1lKQog
#2#ICAgb3V0X3NobSA9IHNoYXJlZF9tZW1vcnkuU2hhcmVkTWVtb3J5KG5hbWU9b3V0X25hbWUpCiAg
#2#ICB0cnk6CiAgICAgICAgdm9sID0gbnAubmRhcnJheShzaGFwZSwgZHR5cGU9bnAuZmxvYXQzMiwg
#2#YnVmZmVyPXZvbF9zaG0uYnVmKQogICAgICAgIG1hc2sgPSBucC5uZGFycmF5KHNoYXBlLCBkdHlw
#2#ZT1ib29sLCBidWZmZXI9bWFza19zaG0uYnVmKQogICAgICAgIG91dCA9IG5wLm5kYXJyYXkoc2hh
#2#cGUsIGR0eXBlPW5wLnVpbnQ4LCBidWZmZXI9b3V0X3NobS5idWYpCgogICAgICAgIGlmIHNpZ19t
#2#YXggLSBiZ19mbG9vciA8PSAwLjA6CiAgICAgICAgICAgIHNpZ19tYXggPSBiZ19mbG9vciArIDEu
#2#MAoKICAgICAgICB6cywgemUgPSB6X3N0YXJ0IC0gaGFsb19sbywgel9lbmQgKyBoYWxvX2hpCiAg
#2#ICAgICAgYmxvY2tfZGF0YSA9IHZvbFt6czp6ZV0KICAgICAgICBibG9ja19tYXNrID0gbWFza1t6
#2#czp6ZV0KCiAgICAgICAgIyBNYXNrZWQgY29tcG9zaXRpbmc6IGtlZXAgc2lnbmFsIGluc2lkZSB0
#2#aGUgbWFzaywgc21vb3RoIHRoZSByZXN0CiAgICAgICAgc21vb3RoZWQgPSBtZWRpYW5fZmlsdGVy
#2#KGJsb2NrX2RhdGEsIHNpemU9MykKICAgICAgICBjb21wb3NpdGUgPSBucC53aGVyZShibG9ja19t
#2#YXNrLCBibG9ja19kYXRhLCBzbW9vdGhlZCkKCiAgICAgICAgIyBXaW5kb3cgTGV2ZWxpbmcgW2Jn
#2#X2Zsb29yLCBzaWdfbWF4XSAtPiBbMCwgMjU1XQogICAgICAgIGNsZWFuID0gbnAuY2xpcChjb21w
#2#b3NpdGUsIGJnX2Zsb29yLCBzaWdfbWF4KQogICAgICAgIG5vcm0gPSAoY2xlYW4gLSBiZ19mbG9v
#2#cikgLyAoc2lnX21heCAtIGJnX2Zsb29yKQogICAgICAgIGJsb2NrX3U4ID0gKG5vcm0gKiAyNTUu
#2#MCkuYXN0eXBlKG5wLnVpbnQ4KQoKICAgICAgICAjIFN0cmlwIHRoZSBaIGhhbG8gYmVmb3JlIHJl
#2#YXNzZW1ibHkKICAgICAgICB6X2hpID0gYmxvY2tfdTguc2hhcGVbMF0gLSBoYWxvX2hpCiAgICAg
#2#ICAgb3V0W3pfc3RhcnQ6el9lbmRdID0gYmxvY2tfdThbaGFsb19sbzp6X2hpXQogICAgICAgIHJl
#2#dHVybiB6X3N0YXJ0CiAgICBmaW5hbGx5OgogICAgICAgIHZvbF9zaG0uY2xvc2UoKQogICAgICAg
#2#IG1hc2tfc2htLmNsb3NlKCkKICAgICAgICBvdXRfc2htLmNsb3NlKCkKCmRlZiBwcm9jZXNzX2lt
#2#YWdlKGlucHV0X2ltczogUGF0aCwgbWV0YWRhdGFfanNvbjogUGF0aCwgdGVtcF9kaXI6IFBhdGgp
#2#OgogICAgd2l0aCBvcGVuKG1ldGFkYXRhX2pzb24sICJyIiwgZW5jb2Rpbmc9InV0Zi04IikgYXMg
#2#ZjoKICAgICAgICBtZXRhID0ganNvbi5sb2FkKGYpCiAgICAgICAgCiAgICBXLCBILCBEID0gbWV0
#2#YVsid2lkdGgiXSwgbWV0YVsiaGVpZ2h0Il0sIG1ldGFbImRlcHRoIl0KICAgIG5fY2ggPSBtZXRh
#2#WyJuX2NoYW5uZWxzIl0KICAgIG5fdHAgPSBtZXRhWyJuX3RpbWVwb2ludHMiXQogICAgCiAgICB0
#2#ZW1wX2Rpci5ta2RpcihwYXJlbnRzPVRydWUsIGV4aXN0X29rPVRydWUpCiAgICAKICAgICMgT3Bl
#2#biBJTVMgZmlsZQogICAgZl9pbXMgPSBoNXB5LkZpbGUoc3RyKGlucHV0X2ltcyksICJyIikKICAg
#2#IHJlczAgPSBmX2ltc1siRGF0YVNldCJdWyJSZXNvbHV0aW9uTGV2ZWwgMCJdCiAgICB0cF9rZXlz
#2#ID0gc29ydGVkKFtrIGZvciBrIGluIHJlczAua2V5cygpIGlmIGsuc3RhcnRzd2l0aCgiVGltZVBv
#2#aW50IildLCBrZXk9bGFtYmRhIHg6IGludCh4LnNwbGl0KClbLTFdKSkKICAgIAogICAgIyBXZSB3
#2#aWxsIHNhdmUgZG93bnNjYWxlZCBzaGFwZXMgaW4gcHJvY2Vzc2luZ19tZXRhLmpzb24KICAgIGxv
#2#ZF9pbmZvID0gW10KICAgIAogICAgIyBEZXRlcm1pbmUgZG93bnNjYWxpbmcgTE9EIGxldmVscwog
#2#ICAgbG9kID0gMAogICAgbG9kX2luZm8uYXBwZW5kKHsKICAgICAgICAibG9kIjogbG9kLAogICAg
#2#ICAgICJ3aWR0aCI6IFcsCiAgICAgICAgImhlaWdodCI6IEgsCiAgICAgICAgImRlcHRoIjogRAog
#2#ICAgfSkKICAgIAogICAgbWF4X2RpbSA9IG1heChXLCBIKQogICAgdGFyZ2V0X2RpbXMgPSBbXQog
#2#ICAgY3Vycl9kaW0gPSAyNTYKICAgIHdoaWxlIGN1cnJfZGltIDwgbWF4X2RpbToKICAgICAgICB0
#2#YXJnZXRfZGltcy5hcHBlbmQoY3Vycl9kaW0pCiAgICAgICAgY3Vycl9kaW0gKj0gMgogICAgICAg
#2#IAogICAgdGFyZ2V0X2RpbXMucmV2ZXJzZSgpCiAgICAKICAgIGZvciB0YXJnZXRfZGltIGluIHRh
#2#cmdldF9kaW1zOgogICAgICAgIGxvZCArPSAxCiAgICAgICAgbG9kX2luZm8uYXBwZW5kKHsKICAg
#2#ICAgICAgICAgImxvZCI6IGxvZCwKICAgICAgICAgICAgIndpZHRoIjogdGFyZ2V0X2RpbSwKICAg
#2#ICAgICAgICAgImhlaWdodCI6IHRhcmdldF9kaW0sCiAgICAgICAgICAgICJkZXB0aCI6IEQKICAg
#2#ICAgICB9KQogICAgICAgIAogICAgcHJpbnQoZiJbUFJPQ0VTU10gTE9EIGxldmVscyB0byBnZW5l
#2#cmF0ZToge2xlbihsb2RfaW5mbyl9IikKICAgIGZvciBsaSBpbiBsb2RfaW5mbzoKICAgICAgICBw
#2#cmludChmIiAgTE9EIHtsaVsnbG9kJ119OiB7bGlbJ3dpZHRoJ119eHtsaVsnaGVpZ2h0J119eHts
#2#aVsnZGVwdGgnXX0iKQoKICAgICMgQSB0aW1lbGFwc2UgaXMgbGV2ZWxsZWQgYWdhaW5zdCBPTkUg
#2#d2luZG93IHBlciBjaGFubmVsIChzZWUKICAgICMgX2VzdGltYXRlX2dsb2JhbF9ib3VuZHMpOyBh
#2#IHNpbmdsZS10aW1lcG9pbnQgZGF0YXNldCBrZWVwcyB0aGUgaGlzdG9yaWNhbAogICAgIyBwZXIt
#2#dm9sdW1lIGVzdGltYXRlIHNvIHByZXZpb3VzbHkgcHVibGlzaGVkIGRhdGFzZXRzIHJlcHJvY2Vz
#2#cyBpZGVudGljYWxseS4KICAgIGlzX3RpbWVsYXBzZSA9IG5fdHAgPiAxCiAgICBnbG9iYWxfYm91
#2#bmRzID0ge30KICAgIGlmIGlzX3RpbWVsYXBzZToKICAgICAgICBmb3IgY19pZHggaW4gcmFuZ2Uo
#2#bl9jaCk6CiAgICAgICAgICAgIGdsb2JhbF9ib3VuZHNbY19pZHhdID0gX2VzdGltYXRlX2dsb2Jh
#2#bF9ib3VuZHMocmVzMCwgdHBfa2V5cywgY19pZHgsIFcsIEgsIEQpCgogICAgIyBQZXItKHRpbWVw
#2#b2ludCwgY2hhbm5lbCkgYnJpZ2h0bmVzcyBvZiB0aGUgUkFXIHNpZ25hbCwgcmVjb3JkZWQgYnV0
#2#IG5ldmVyCiAgICAjIGJha2VkIGludG8gdGhlIHZveGVsczogYmxlYWNoaW5nIGNvcnJlY3Rpb24g
#2#c3RheXMgYSByZXZlcnNpYmxlIGRpc3BsYXkgY2hvaWNlLgogICAgc2lnbmFsX2xldmVscyA9IHt9
#2#CgogICAgc2hhcGUgPSAoRCwgSCwgVykKICAgIG5fdm94ZWxzID0gRCAqIEggKiBXCgogICAgZm9y
#2#IHRfaWR4LCB0cF9rZXkgaW4gZW51bWVyYXRlKHRwX2tleXMpOgogICAgICAgIGNoX2tleXMgPSBz
#2#b3J0ZWQoW2sgZm9yIGsgaW4gcmVzMFt0cF9rZXldLmtleXMoKSBpZiBrLnN0YXJ0c3dpdGgoIkNo
#2#YW5uZWwiKV0sIGtleT1sYW1iZGEgeDogaW50KHguc3BsaXQoKVstMV0pKQoKICAgICAgICBmb3Ig
#2#Y19pZHgsIGNoX2tleSBpbiBlbnVtZXJhdGUoY2hfa2V5cyk6CiAgICAgICAgICBwcmludChmIltQ
#2#Uk9DRVNTXSBQcm9jZXNzaW5nIENoYW5uZWwge2NfaWR4fSAoVCB7dF9pZHh9KS4uLiIsIGZsdXNo
#2#PVRydWUpCiAgICAgICAgICBkcyA9IHJlczBbdHBfa2V5XVtjaF9rZXldWyJEYXRhIl0KCiAgICAg
#2#ICAgICAjIFRoZSB2b2x1bWUsIGl0cyBtYXNrIGFuZCB0aGUgbGV2ZWxsZWQgb3V0cHV0IGFyZSBh
#2#bGxvY2F0ZWQgaW4gc2hhcmVkCiAgICAgICAgICAjIG1lbW9yeSBzbyB0aGUgd29ya2VyIHBvb2wg
#2#YWRkcmVzc2VzIHRoZW0gYnkgbmFtZSBpbnN0ZWFkIG9mIHBpY2tsaW5nCiAgICAgICAgICAjIHNs
#2#aWNlcyBhY3Jvc3MgcHJvY2VzcyBwaXBlcyAoc2VlIHByb2Nlc3Nfel9ibG9jaykuCiAgICAgICAg
#2#ICB3aXRoIEV4aXRTdGFjaygpIGFzIHN0YWNrOgogICAgICAgICAgICB2b2xfc2htID0gc2hhcmVk
#2#X21lbW9yeS5TaGFyZWRNZW1vcnkoY3JlYXRlPVRydWUsIHNpemU9bl92b3hlbHMgKiA0KQogICAg
#2#ICAgICAgICBtYXNrX3NobSA9IHNoYXJlZF9tZW1vcnkuU2hhcmVkTWVtb3J5KGNyZWF0ZT1UcnVl
#2#LCBzaXplPW5fdm94ZWxzKQogICAgICAgICAgICBvdXRfc2htID0gc2hhcmVkX21lbW9yeS5TaGFy
#2#ZWRNZW1vcnkoY3JlYXRlPVRydWUsIHNpemU9bl92b3hlbHMpCiAgICAgICAgICAgICMgRXhpdFN0
#2#YWNrIHVud2luZHMgTElGTywgc28gcmVnaXN0ZXJpbmcgdW5saW5rIGJlZm9yZSBjbG9zZSBiZWZv
#2#cmUgdGhlIHBvb2wKICAgICAgICAgICAgIyB0ZWFycyBkb3duIGluIHRoZSBvbmx5IG9yZGVyIHRo
#2#YXQgaXMgc2FmZTogd29ya2VycyBnb25lLCB0aGVuIHZpZXdzIGNsb3NlZCwKICAgICAgICAgICAg
#2#IyB0aGVuIHRoZSBibG9ja3MgcmVsZWFzZWQuIChTaGFyZWRNZW1vcnkgaXMgbm90IGEgY29udGV4
#2#dCBtYW5hZ2VyIGJlZm9yZSAzLjEzLikKICAgICAgICAgICAgZm9yIHNobSBpbiAodm9sX3NobSwg
#2#bWFza19zaG0sIG91dF9zaG0pOgogICAgICAgICAgICAgICAgc3RhY2suY2FsbGJhY2soc2htLnVu
#2#bGluaykKICAgICAgICAgICAgZm9yIHNobSBpbiAodm9sX3NobSwgbWFza19zaG0sIG91dF9zaG0p
#2#OgogICAgICAgICAgICAgICAgc3RhY2suY2FsbGJhY2soc2htLmNsb3NlKQogICAgICAgICAgICBl
#2#eGVjdXRvciA9IHN0YWNrLmVudGVyX2NvbnRleHQoUHJvY2Vzc1Bvb2xFeGVjdXRvcihtYXhfd29y
#2#a2Vycz1vcy5jcHVfY291bnQoKSkpCgogICAgICAgICAgICB2b2wgPSBucC5uZGFycmF5KHNoYXBl
#2#LCBkdHlwZT1ucC5mbG9hdDMyLCBidWZmZXI9dm9sX3NobS5idWYpCiAgICAgICAgICAgIG1hc2sg
#2#PSBucC5uZGFycmF5KHNoYXBlLCBkdHlwZT1ib29sLCBidWZmZXI9bWFza19zaG0uYnVmKQogICAg
#2#ICAgICAgICB2b2xfdTggPSBucC5uZGFycmF5KHNoYXBlLCBkdHlwZT1ucC51aW50OCwgYnVmZmVy
#2#PW91dF9zaG0uYnVmKQoKICAgICAgICAgICAgcHJpbnQoZiIgIExvYWRpbmcgM0Qgdm9sdW1lICh7
#2#V314e0h9eHtEfSkgaW4gbWVtb3J5IGFzIEZsb2F0MzIuLi4iLCBmbHVzaD1UcnVlKQogICAgICAg
#2#ICAgICAjIFJlYWQgZW50aXJlIHZvbHVtZSBkaXJlY3RseSB0byBhbGxvdyBoNXB5IEMtY29yZSB0
#2#byBvcHRpbWl6ZSBjaHVuayByZWFkcwogICAgICAgICAgICAjIEV4dHJlbWVseSBmYXN0IGNvbXBh
#2#cmVkIHRvIHJlYWRpbmcgc2xpY2UtYnktc2xpY2UgaW4gUHl0aG9uCiAgICAgICAgICAgIHZvbFs6
#2#XSA9IGRzWzpELCA6SCwgOlddCgogICAgICAgICAgICAjIOKUgOKUgOKUgCBTdGVwIDEgOiBCb3Vu
#2#ZCBlc3RpbWF0aW9uIChDb3JuZXIgU2FtcGxpbmcpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#2#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgICAgICAgICAjIGJnX2Zsb29yID0gOTl0
#2#aCBwZXJjZW50aWxlIG9mIHRoZSA4IHZvbHVtZSBjb3JuZXJzIChwdXJlIGNhbWVyYQogICAgICAg
#2#ICAgICAjIGJhY2tncm91bmQsIG5vIGVtYnJ5byB0aGVyZSk7IHNpZ19tYXggPSA5OS45dGggcGVy
#2#Y2VudGlsZSBvZiB0aGUKICAgICAgICAgICAgIyBnbG9iYWxseSBzdWItc2FtcGxlZCB2b2x1bWUg
#2#KHNhdHVyYXRlIHRoZSBicmlnaHRlc3QgMC4xICUpLgogICAgICAgICAgICBwcmludCgiICBTdGVw
#2#IDE6IEVzdGltYXRpb24gZGVzIGJvcm5lcyAoQ29ybmVyIFNhbXBsaW5nKS4uLiIsIGZsdXNoPVRy
#2#dWUpCiAgICAgICAgICAgIGRvd25fdm9sID0gdm9sWzo6NCwgOjo0LCA6OjRdCiAgICAgICAgICAg
#2#IGZyYW1lX3NpZyA9IGZsb2F0KG5wLnBlcmNlbnRpbGUoZG93bl92b2wsIDk5LjkpKQogICAgICAg
#2#ICAgICBpZiBpc190aW1lbGFwc2U6CiAgICAgICAgICAgICAgICBiZ19mbG9vciwgc2lnX21heCA9
#2#IGdsb2JhbF9ib3VuZHNbY19pZHhdCiAgICAgICAgICAgICAgICBwcmludChmIiAgICBib3JuZXMg
#2#Z2xvYmFsZXM6IGJnX2Zsb29yPXtiZ19mbG9vcjouMmZ9IHNpZ19tYXg9e3NpZ19tYXg6LjJmfSAi
#2#CiAgICAgICAgICAgICAgICAgICAgICBmIihzaWduYWwgcHJvcHJlIGEgY2V0dGUgZnJhbWU6IHtm
#2#cmFtZV9zaWc6LjJmfSkiLCBmbHVzaD1UcnVlKQogICAgICAgICAgICBlbHNlOgogICAgICAgICAg
#2#ICAgICAgY29ybmVyX2RhdGEgPSBfY29ybmVyX3NhbXBsZXModm9sLCBXLCBILCBEKQogICAgICAg
#2#ICAgICAgICAgYmdfZmxvb3IgPSBmbG9hdChucC5wZXJjZW50aWxlKGNvcm5lcl9kYXRhLCA5OS4w
#2#KSkKICAgICAgICAgICAgICAgIHByaW50KGYiICAgIGJnX2Zsb29yICg5OWUgY2VudGlsZSBkdSBi
#2#cnVpdCBkZXMgY29pbnMpOiB7YmdfZmxvb3I6LjJmfSIsIGZsdXNoPVRydWUpCiAgICAgICAgICAg
#2#ICAgICBzaWdfbWF4ID0gZnJhbWVfc2lnCiAgICAgICAgICAgICAgICBwcmludChmIiAgICBzaWdf
#2#bWF4ICg5OS45ZSBjZW50aWxlIGdsb2JhbCk6IHtzaWdfbWF4Oi4yZn0iLCBmbHVzaD1UcnVlKQog
#2#ICAgICAgICAgICBzaWduYWxfbGV2ZWxzW2YidHt0X2lkeDowM2R9X2N7Y19pZHh9Il0gPSByb3Vu
#2#ZChmcmFtZV9zaWcsIDQpCiAgICAgICAgICAgIGRlbCBkb3duX3ZvbAoKICAgICAgICAgICAgIyDi
#2#lIDilIDilIAgU3RlcCAyIDogU2lnbmFsIG1hc2sg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#2#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#2#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICAgICAgICAgICMgVGhy
#2#ZXNob2xkIDEwICUgYWJvdmUgdGhlIG5vaXNlIGZsb29yOyBhIG1vcnBob2xvZ2ljYWwgb3Blbmlu
#2#ZyBkcm9wcwogICAgICAgICAgICAjIGlzb2xhdGVkIGhvdCBwaXhlbHMgKHNvIHRoZXkgZ2V0IG1l
#2#ZGlhbi1jcnVzaGVkIGJlbG93KSwgdGhlbiBhCiAgICAgICAgICAgICMgMy1pdGVyYXRpb24gZGls
#2#YXRpb24gZ3VhcmRzIHRoZSBuYXR1cmFsIGZsdW9yZXNjZW50IGZhZGUtb3V0IGFyb3VuZAogICAg
#2#ICAgICAgICAjIHRoZSBiaW9sb2dpY2FsIHNpZ25hbCBzbyB0aGUgbWVkaWFuIGZpbHRlciBuZXZl
#2#ciBiaXRlcyBpbnRvIGNlbGxzLgogICAgICAgICAgICBwcmludCgiICBTdGVwIDI6IENvbnN0cnVj
#2#dGlvbiBkdSBtYXNxdWUgZGUgc2lnbmFsLi4uIiwgZmx1c2g9VHJ1ZSkKICAgICAgICAgICAgbnAu
#2#Z3JlYXRlcih2b2wsIGJnX2Zsb29yICogMS4xLCBvdXQ9bWFzaykKICAgICAgICAgICAgbWFza1s6
#2#XSA9IGJpbmFyeV9vcGVuaW5nKG1hc2ssIGl0ZXJhdGlvbnM9MSkKICAgICAgICAgICAgbWFza1s6
#2#XSA9IGJpbmFyeV9kaWxhdGlvbihtYXNrLCBpdGVyYXRpb25zPTMpCiAgICAgICAgICAgIHByaW50
#2#KGYiICAgIENvdXZlcnR1cmUgZHUgbWFzcXVlOiB7MTAwLjAgKiBtYXNrLm1lYW4oKTouMmZ9JSBk
#2#ZXMgdm94ZWxzIiwgZmx1c2g9VHJ1ZSkKCiAgICAgICAgICAgICMg4pSA4pSA4pSAIFN0ZXAgMyA6
#2#IE1hc2tlZCBtZWRpYW4gZmlsdGVyaW5nICsgV2luZG93IExldmVsaW5nIOKUgOKUgOKUgOKUgOKU
#2#gOKUgOKUgOKUgOKUgOKUgOKUgAogICAgICAgICAgICAjIFBhcmFsbGVsIG92ZXIgWi1ibG9ja3M7
#2#IGVhY2ggYmxvY2sgY2FycmllcyBhIMKxMSBaIGhhbG8gZm9yIHRoZQogICAgICAgICAgICAjIDNE
#2#IG1lZGlhbiBzbyB0aGVyZSBpcyBubyBzZWFtIGJldHdlZW4gYmxvY2tzLgogICAgICAgICAgICBw
#2#cmludCgiICBTdGVwIDM6IE1hc2tlZCBNZWRpYW4gRmlsdGVyaW5nICsgV2luZG93IExldmVsaW5n
#2#Li4uIiwgZmx1c2g9VHJ1ZSkKICAgICAgICAgICAgel9jaHVua19zaXplID0gbWF4KDQsIEQgLy8g
#2#KG9zLmNwdV9jb3VudCgpICogMikpCiAgICAgICAgICAgIHRhc2tzID0gW10KICAgICAgICAgICAg
#2#Zm9yIHpfc3RhcnQgaW4gcmFuZ2UoMCwgRCwgel9jaHVua19zaXplKToKICAgICAgICAgICAgICAg
#2#IHpfZW5kID0gbWluKHpfc3RhcnQgKyB6X2NodW5rX3NpemUsIEQpCiAgICAgICAgICAgICAgICBo
#2#YWxvX2xvID0gMSBpZiB6X3N0YXJ0ID4gMCBlbHNlIDAKICAgICAgICAgICAgICAgIGhhbG9faGkg
#2#PSAxIGlmIHpfZW5kIDwgRCBlbHNlIDAKICAgICAgICAgICAgICAgIHRhc2tzLmFwcGVuZCgodm9s
#2#X3NobS5uYW1lLCBtYXNrX3NobS5uYW1lLCBvdXRfc2htLm5hbWUsIHNoYXBlLAogICAgICAgICAg
#2#ICAgICAgICAgICAgICAgICAgICB6X3N0YXJ0LCB6X2VuZCwgaGFsb19sbywgaGFsb19oaSwgYmdf
#2#Zmxvb3IsIHNpZ19tYXgpKQoKICAgICAgICAgICAgZm9yIF8gaW4gdHFkbShleGVjdXRvci5tYXAo
#2#cHJvY2Vzc196X2Jsb2NrLCB0YXNrcyksIHRvdGFsPWxlbih0YXNrcyksCiAgICAgICAgICAgICAg
#2#ICAgICAgICAgICAgZGVzYz0iTWFza2VkIE1lZGlhbiArIExldmVsaW5nIiwgbGVhdmU9RmFsc2Us
#2#IGFzY2lpPVRydWUsIG1pbmludGVydmFsPTIuMCk6CiAgICAgICAgICAgICAgICBwYXNzCgogICAg
#2#ICAgICAgICAjIOKUgOKUgOKUgCBTdGVwIDQgOiBFeHBvcnRpbmcgZG93bnNjYWxlZCBMT0QgbGV2
#2#ZWxzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#2#gOKUgOKUgOKUgAogICAgICAgICAgICBwcmludCgiICBTdGVwIDQ6IEV4cG9ydGluZyBkb3duc2Nh
#2#bGVkIExPRCBsZXZlbHMuLi4iLCBmbHVzaD1UcnVlKQogICAgICAgICAgICBsb2RfZmlsZXMgPSB7
#2#fQogICAgICAgICAgICBmb3IgbGkgaW4gbG9kX2luZm86CiAgICAgICAgICAgICAgICBsb2RfbnVt
#2#ID0gbGlbImxvZCJdCiAgICAgICAgICAgICAgICBsb2RfZmlsZSA9IHRlbXBfZGlyIC8gZiJ0e3Rf
#2#aWR4OjAzZH1fY3tjX2lkeH1fbG9ke2xvZF9udW19LmJpbiIKICAgICAgICAgICAgICAgIGxvZF9m
#2#aWxlc1tsb2RfbnVtXSA9IG9wZW4obG9kX2ZpbGUsICJ3YiIpCgogICAgICAgICAgICBmb3IgeiBp
#2#biB0cWRtKHJhbmdlKEQpLCBkZXNjPSJFeHBvcnRpbmcgTE9EcyIsIGxlYXZlPUZhbHNlLCBhc2Np
#2#aT1UcnVlLCBtaW5pbnRlcnZhbD0yLjApOgogICAgICAgICAgICAgICAgc2xpY2VfdTggPSB2b2xf
#2#dThbel0KICAgICAgICAgICAgICAgICMgV3JpdGUgbmF0aXZlIExPRDAKICAgICAgICAgICAgICAg
#2#IGxvZF9maWxlc1swXS53cml0ZShzbGljZV91OC50b2J5dGVzKCkpCiAgICAgICAgICAgICAgICAj
#2#IFdyaXRlIGRvd25zY2FsZWQgTE9EcwogICAgICAgICAgICAgICAgcGlsX2ltZyA9IEltYWdlLmZy
#2#b21hcnJheShzbGljZV91OCwgbW9kZT0iTCIpCiAgICAgICAgICAgICAgICBmb3IgbGkgaW4gbG9k
#2#X2luZm9bMTpdOgogICAgICAgICAgICAgICAgICAgIGxvZF9udW0gPSBsaVsibG9kIl0KICAgICAg
#2#ICAgICAgICAgICAgICByZXNpemVkID0gcGlsX2ltZy5yZXNpemUoKGxpWyJ3aWR0aCJdLCBsaVsi
#2#aGVpZ2h0Il0pLCBJbWFnZS5SZXNhbXBsaW5nLkJJTElORUFSKQogICAgICAgICAgICAgICAgICAg
#2#IHJlc2l6ZWRfYXJyID0gbnAuYXNhcnJheShyZXNpemVkLCBkdHlwZT1ucC51aW50OCkKICAgICAg
#2#ICAgICAgICAgICAgICBsb2RfZmlsZXNbbG9kX251bV0ud3JpdGUocmVzaXplZF9hcnIudG9ieXRl
#2#cygpKQoKICAgICAgICAgICAgIyBDbG9zZSBhbGwgZmlsZSBoYW5kbGVzCiAgICAgICAgICAgIGZv
#2#ciBmX2hhbmRsZSBpbiBsb2RfZmlsZXMudmFsdWVzKCk6CiAgICAgICAgICAgICAgICBmX2hhbmRs
#2#ZS5jbG9zZSgpCiAgICAgICAgICAgICMgdm9sIC8gbWFzayAvIHZvbF91OCBhcmUgdmlld3Mgb24g
#2#dGhlIHNoYXJlZCBibG9ja3M7IEV4aXRTdGFjayBjbG9zZXMgYW5kCiAgICAgICAgICAgICMgdW5s
#2#aW5rcyB0aGVtIGFzIHRoZSBgd2l0aGAgdW53aW5kcy4gRHJvcCB0aGUgdmlld3MgZmlyc3Qgc28g
#2#bm8gbnVtcHkKICAgICAgICAgICAgIyBvYmplY3Qgc3RpbGwgcmVmZXJlbmNlcyBhIGJ1ZmZlciB0
#2#aGF0IGlzIGFib3V0IHRvIGJlIHJlbGVhc2VkLgogICAgICAgICAgICBkZWwgdm9sLCBtYXNrLCB2
#2#b2xfdTgKICAgICAgICAgICAgcHJpbnQoZiIgIENoYW5uZWwge2NfaWR4fSBwcm9jZXNzZWQgc3Vj
#2#Y2Vzc2Z1bGx5LiIpCgogICAgZl9pbXMuY2xvc2UoKQogICAgCiAgICAjIFNhdmUgdGhlIExPRCBp
#2#bmZvIGZvciBuZXh0IHN0ZXAKICAgIHdpdGggb3Blbih0ZW1wX2RpciAvICJwcm9jZXNzaW5nX21l
#2#dGEuanNvbiIsICJ3IiwgZW5jb2Rpbmc9InV0Zi04IikgYXMgZm06CiAgICAgICAganNvbi5kdW1w
#2#KHsKICAgICAgICAgICAgImxvZF9sZXZlbHMiOiBsb2RfaW5mbywKICAgICAgICAgICAgInZveGVs
#2#X3NpemUiOiBtZXRhWyJ2b3hlbF9zaXplIl0sCiAgICAgICAgICAgICJjaGFubmVsX25hbWVzIjog
#2#bWV0YVsiY2hhbm5lbF9uYW1lcyJdLAogICAgICAgICAgICAid2lkdGgiOiBXLAogICAgICAgICAg
#2#ICAiaGVpZ2h0IjogSCwKICAgICAgICAgICAgImRlcHRoIjogRCwKICAgICAgICAgICAgIm5fY2hh
#2#bm5lbHMiOiBuX2NoLAogICAgICAgICAgICAibl90aW1lcG9pbnRzIjogbl90cCwKICAgICAgICAg
#2#ICAgImV4dGVudCI6IG1ldGEuZ2V0KCJleHRlbnQiKSwKICAgICAgICAgICAgInRpbWVzdGFtcHMi
#2#OiBtZXRhLmdldCgidGltZXN0YW1wcyIpLAogICAgICAgICAgICAidGltZV9pbnRlcnZhbF9taW51
#2#dGVzIjogbWV0YS5nZXQoInRpbWVfaW50ZXJ2YWxfbWludXRlcyIpLAogICAgICAgICAgICAibm9y
#2#bWFsaXphdGlvbiI6IHsKICAgICAgICAgICAgICAgICJtb2RlIjogImdsb2JhbCIgaWYgaXNfdGlt
#2#ZWxhcHNlIGVsc2UgInBlci12b2x1bWUiLAogICAgICAgICAgICAgICAgImJvdW5kcyI6IHtmImN7
#2#Y30iOiB7ImJnRmxvb3IiOiByb3VuZChiWzBdLCA0KSwgInNpZ01heCI6IHJvdW5kKGJbMV0sIDQp
#2#fQogICAgICAgICAgICAgICAgICAgICAgICAgICBmb3IgYywgYiBpbiBnbG9iYWxfYm91bmRzLml0
#2#ZW1zKCl9LAogICAgICAgICAgICAgICAgInNpZ25hbExldmVscyI6IHNpZ25hbF9sZXZlbHMKICAg
#2#ICAgICAgICAgfQogICAgICAgIH0sIGZtLCBpbmRlbnQ9MikKCmlmIF9fbmFtZV9fID09ICJfX21h
#2#aW5fXyI6CiAgICBpZiBsZW4oc3lzLmFyZ3YpIDwgNDoKICAgICAgICBwcmludCgiVXNhZ2U6IHB5
#2#dGhvbiAyLWltYWdlX3Byb2Nlc3Nvci5weSA8aW5wdXRfaW1zPiA8bWV0YWRhdGFfanNvbj4gPHRl
#2#bXBfZGlyPiIpCiAgICAgICAgc3lzLmV4aXQoMSkKICAgICAgICAKICAgIGlucHV0X2ltcyA9IFBh
#2#dGgoc3lzLmFyZ3ZbMV0pCiAgICBtZXRhZGF0YV9qc29uID0gUGF0aChzeXMuYXJndlsyXSkKICAg
#2#IHRlbXBfZGlyID0gUGF0aChzeXMuYXJndlszXSkKICAgIAogICAgdHJ5OgogICAgICAgIHByb2Nl
#2#c3NfaW1hZ2UoaW5wdXRfaW1zLCBtZXRhZGF0YV9qc29uLCB0ZW1wX2RpcikKICAgICAgICBwcmlu
#2#dChmIltQUk9DRVNTXSBJbWFnZSBwcm9jZXNzaW5nIGNvbXBsZXRlLiIpCiAgICBleGNlcHQgRXhj
#2#ZXB0aW9uIGFzIGU6CiAgICAgICAgaW1wb3J0IHRyYWNlYmFjawogICAgICAgIHRyYWNlYmFjay5w
#2#cmludF9leGMoKQogICAgICAgIHByaW50KGYiW0VSUk9SXSBJbWFnZSBwcm9jZXNzaW5nIGZhaWxl
#2#ZDoge2V9IiwgZmlsZT1zeXMuc3RkZXJyKQogICAgICAgIHN5cy5leGl0KDEpCg==
:: ---- [3] 3-chunk_packer.py (13531 octets) ----
#3#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwppbXBvcnQganNvbgppbXBvcnQgbWF0aAppbXBvcnQgc3lz
#3#CmltcG9ydCBnemlwCmltcG9ydCBoYXNobGliCmZyb20gcGF0aGxpYiBpbXBvcnQgUGF0aAppbXBv
#3#cnQgbnVtcHkgYXMgbnAKZnJvbSBQSUwgaW1wb3J0IEltYWdlCmltcG9ydCBpbwpmcm9tIGNvbmN1
#3#cnJlbnQuZnV0dXJlcyBpbXBvcnQgUHJvY2Vzc1Bvb2xFeGVjdXRvcgppbXBvcnQgb3MKCmRlZiBw
#3#cm9jZXNzX2NodW5rKGFyZ3MpOgogICAgY2h1bmtfZGF0YSwgY2hfbWV0YSwgQlJJQ0tfU0laRSA9
#3#IGFyZ3MKICAgIG5vbl96ZXJvID0gbnAuY291bnRfbm9uemVybyhjaHVua19kYXRhKQogICAgdmFs
#3#aWRfdm94ZWxzID0gbWF4KDEsIGNoX21ldGFbInZhbGlkVm94ZWxDb3VudCJdKQogICAgb2NjID0g
#3#ZmxvYXQobm9uX3plcm8pIC8gZmxvYXQodmFsaWRfdm94ZWxzKQoKICAgIGlzX25vbl9lbXB0eSA9
#3#IG9jYyA+IDAuMDAwNQogICAgaWYgbm90IGlzX25vbl9lbXB0eToKICAgICAgICByZXR1cm4gKGNo
#3#X21ldGFbImlkeCJdLCBvY2MsIEZhbHNlLCBOb25lKQoKICAgIHBhZGRlZCA9IG5wLnplcm9zKChC
#3#UklDS19TSVpFLCBCUklDS19TSVpFLCBCUklDS19TSVpFKSwgZHR5cGU9bnAudWludDgpCiAgICBk
#3#LCBoLCB3ID0gY2h1bmtfZGF0YS5zaGFwZQogICAgcGFkZGVkWzpkLCA6aCwgOnddID0gY2h1bmtf
#3#ZGF0YQoKICAgIG1vc2FpYyA9IG5wLnplcm9zKCg1MTIsIDUxMiksIGR0eXBlPW5wLnVpbnQ4KQog
#3#ICAgZm9yIHogaW4gcmFuZ2UoNjQpOgogICAgICAgIHJvdyA9IHogLy8gOAogICAgICAgIGNvbCA9
#3#IHogJSA4CiAgICAgICAgbW9zYWljW3Jvdyo2NDoocm93KzEpKjY0LCBjb2wqNjQ6KGNvbCsxKSo2
#3#NF0gPSBwYWRkZWRbel0KCiAgICBpbWcgPSBJbWFnZS5mcm9tYXJyYXkobW9zYWljKQogICAgYnVm
#3#ID0gaW8uQnl0ZXNJTygpCiAgICBpbWcuc2F2ZShidWYsIGZvcm1hdD0iV0VCUCIsIGxvc3NsZXNz
#3#PVRydWUpCiAgICByZXR1cm4gKGNoX21ldGFbImlkeCJdLCBvY2MsIFRydWUsIGJ1Zi5nZXR2YWx1
#3#ZSgpKQoKCmRlZiBfcGFja190aW1lcG9pbnQodGVtcF9kaXI6IFBhdGgsIGJyaWNrc19kaXI6IFBh
#3#dGgsIHRfaWR4OiBpbnQsIGxvZF9sZXZlbHMsIG5fY2g6IGludCwKICAgICAgICAgICAgICAgICAg
#3#ICBleGVjdXRvciwgdHBfc3ViZGlyOiBzdHIpOgogICAgIiIiQnJpY2ssIGNvbXByZXNzIGFuZCBw
#3#YWNrIGV2ZXJ5IExPRCBvZiBhIHNpbmdsZSB0aW1lcG9pbnQuCgogICAgdHBfc3ViZGlyIGlzICcn
#3#IGZvciBhIHNpbmdsZS10aW1lcG9pbnQgKGZpeGVkKSBkYXRhc2V0IOKAlCB0aGUgcGFja3MgdGhl
#3#biBsYW5kCiAgICBkaXJlY3RseSB1bmRlciBicmlja3MvIGFuZCB0aGUgb3V0cHV0IGlzIGJ5dGUt
#3#aWRlbnRpY2FsIHRvIHRoZSBwcmUtNEQgcGlwZWxpbmUuCiAgICBGb3IgYSB0aW1lbGFwc2UgaXQg
#3#aXMgJ3QwMDAnLCAndDAwMScsIOKApiBhbmQgZWFjaCB0aW1lcG9pbnQgb3ducyBhIHNlbGYtY29u
#3#dGFpbmVkCiAgICBwYWNrIHRyZWUgd2hvc2UgYnJpY2tUb1BhY2sgdXJscyBzdGF5IHJlbGF0aXZl
#3#IHRvIHRoYXQgc3ViLWRpcmVjdG9yeSwgd2hpY2ggaXMKICAgIGV4YWN0bHkgd2hhdCB0aGUgdmll
#3#d2VyIGFwcGVuZHMgdG8gdGhlIGJyaWNrcyBiYXNlIHBhdGguCiAgICAiIiIKICAgIHRwX3Jvb3Qg
#3#PSBicmlja3NfZGlyIC8gdHBfc3ViZGlyIGlmIHRwX3N1YmRpciBlbHNlIGJyaWNrc19kaXIKICAg
#3#IHRwX3Jvb3QubWtkaXIocGFyZW50cz1UcnVlLCBleGlzdF9vaz1UcnVlKQoKICAgIEJSSUNLX1NJ
#3#WkUgPSA2NAogICAgQ0hVTktTX1BFUl9QQUNLID0gMTI4CgogICAgYnJpY2tfdG9fcGFjayA9IHt9
#3#CiAgICBwYWNrX2hhc2hlcyA9IHt9CiAgICBsZXZlbHNfbWFuaWZlc3QgPSBbXQoKICAgIGZvciBs
#3#aSBpbiBsb2RfbGV2ZWxzOgogICAgICAgIGxvZF9udW0gPSBsaVsibG9kIl0KICAgICAgICBXLCBI
#3#LCBEID0gbGlbIndpZHRoIl0sIGxpWyJoZWlnaHQiXSwgbGlbImRlcHRoIl0KCiAgICAgICAgbngg
#3#PSBtYXRoLmNlaWwoVyAvIEJSSUNLX1NJWkUpCiAgICAgICAgbnkgPSBtYXRoLmNlaWwoSCAvIEJS
#3#SUNLX1NJWkUpCiAgICAgICAgbnogPSBtYXRoLmNlaWwoRCAvIEJSSUNLX1NJWkUpCgogICAgICAg
#3#ICMgQnVpbGQgbG9naWNhbCBncmlkIG9mIGNodW5rcyBmb3IgdGhpcyBsZXZlbAogICAgICAgIGNo
#3#dW5rc19ncmlkID0gW10KICAgICAgICBmb3IgYnogaW4gcmFuZ2UobnopOgogICAgICAgICAgICBm
#3#b3IgYnkgaW4gcmFuZ2UobnkpOgogICAgICAgICAgICAgICAgZm9yIGJ4IGluIHJhbmdlKG54KToK
#3#ICAgICAgICAgICAgICAgICAgICBveCwgb3ksIG96ID0gYnggKiBCUklDS19TSVpFLCBieSAqIEJS
#3#SUNLX1NJWkUsIGJ6ICogQlJJQ0tfU0laRQogICAgICAgICAgICAgICAgICAgIGV3ID0gbWluKEJS
#3#SUNLX1NJWkUsIFcgLSBveCkKICAgICAgICAgICAgICAgICAgICBlaCA9IG1pbihCUklDS19TSVpF
#3#LCBIIC0gb3kpCiAgICAgICAgICAgICAgICAgICAgZWQgPSBtaW4oQlJJQ0tfU0laRSwgRCAtIG96
#3#KQogICAgICAgICAgICAgICAgICAgIGNodW5rc19ncmlkLmFwcGVuZCh7CiAgICAgICAgICAgICAg
#3#ICAgICAgICAgICJieCI6IGJ4LAogICAgICAgICAgICAgICAgICAgICAgICAiYnkiOiBieSwKICAg
#3#ICAgICAgICAgICAgICAgICAgICAgImJ6IjogYnosCiAgICAgICAgICAgICAgICAgICAgICAgICJt
#3#aW4iOiBbaW50KG94KSwgaW50KG95KSwgaW50KG96KV0sCiAgICAgICAgICAgICAgICAgICAgICAg
#3#ICJtYXgiOiBbaW50KG94ICsgZXcpLCBpbnQob3kgKyBlaCksIGludChveiArIGVkKV0sCiAgICAg
#3#ICAgICAgICAgICAgICAgICAgICJ2YWxpZFZveGVsQ291bnQiOiBpbnQoZXcgKiBlaCAqIGVkKQog
#3#ICAgICAgICAgICAgICAgICAgIH0pCgogICAgICAgICMgRW1wdHktc3BhY2Ugc2tpcHBpbmcgaXMg
#3#ZGVjaWRlZCBwZXIgdGltZXBvaW50OiBjZWxscyBtb3ZlLCBzbyB0aGUgb2NjdXBpZWQKICAgICAg
#3#ICAjIGJyaWNrIHNldCBsZWdpdGltYXRlbHkgZGlmZmVycyBmcm9tIG9uZSBmcmFtZSB0byB0aGUg
#3#bmV4dC4KICAgICAgICBCQUNLR1JPVU5EX1RIUkVTSE9MRCA9IDAKICAgICAgICBpc19jb3JlID0g
#3#W0ZhbHNlXSAqIGxlbihjaHVua3NfZ3JpZCkKICAgICAgICBmb3IgY19pZHggaW4gcmFuZ2Uobl9j
#3#aCk6CiAgICAgICAgICAgIGJpbl9maWxlID0gdGVtcF9kaXIgLyBmInR7dF9pZHg6MDNkfV9je2Nf
#3#aWR4fV9sb2R7bG9kX251bX0uYmluIgogICAgICAgICAgICBpZiBub3QgYmluX2ZpbGUuZXhpc3Rz
#3#KCk6CiAgICAgICAgICAgICAgICBjb250aW51ZQogICAgICAgICAgICB2b2x1bWVfZGF0YSA9IG5w
#3#Lm1lbW1hcCgKICAgICAgICAgICAgICAgIHN0cihiaW5fZmlsZSksCiAgICAgICAgICAgICAgICBk
#3#dHlwZT1ucC51aW50OCwKICAgICAgICAgICAgICAgIG1vZGU9InIiLAogICAgICAgICAgICAgICAg
#3#c2hhcGU9KEQsIEgsIFcpCiAgICAgICAgICAgICkKICAgICAgICAgICAgZm9yIGksIGNoIGluIGVu
#3#dW1lcmF0ZShjaHVua3NfZ3JpZCk6CiAgICAgICAgICAgICAgICBveCwgb3ksIG96ID0gY2hbIm1p
#3#biJdCiAgICAgICAgICAgICAgICBleCwgZXksIGV6ID0gY2hbIm1heCJdCiAgICAgICAgICAgICAg
#3#ICBjaHVua19zbGljZSA9IHZvbHVtZV9kYXRhW296OmV6LCBveTpleSwgb3g6ZXhdCiAgICAgICAg
#3#ICAgICAgICBpZiBjaHVua19zbGljZS5zaXplID4gMDoKICAgICAgICAgICAgICAgICAgICBpZiBu
#3#cC5tYXgoY2h1bmtfc2xpY2UpID4gQkFDS0dST1VORF9USFJFU0hPTEQ6CiAgICAgICAgICAgICAg
#3#ICAgICAgICAgIGlzX2NvcmVbaV0gPSBUcnVlCiAgICAgICAgICAgIGRlbCB2b2x1bWVfZGF0YQoK
#3#ICAgICAgICBjb3JlX2Nvb3JkcyA9IHNldCgpCiAgICAgICAgZm9yIGksIGNoIGluIGVudW1lcmF0
#3#ZShjaHVua3NfZ3JpZCk6CiAgICAgICAgICAgIGlmIGlzX2NvcmVbaV06CiAgICAgICAgICAgICAg
#3#ICBjb3JlX2Nvb3Jkcy5hZGQoKGNoWyJieCJdLCBjaFsiYnkiXSwgY2hbImJ6Il0pKQoKICAgICAg
#3#ICBhY3RpdmVfY29vcmRzID0gc2V0KCkKICAgICAgICBmb3IgKGJ4LCBieSwgYnopIGluIGNvcmVf
#3#Y29vcmRzOgogICAgICAgICAgICBmb3IgZHggaW4gKC0xLCAwLCAxKToKICAgICAgICAgICAgICAg
#3#IGZvciBkeSBpbiAoLTEsIDAsIDEpOgogICAgICAgICAgICAgICAgICAgIGZvciBkeiBpbiAoLTEs
#3#IDAsIDEpOgogICAgICAgICAgICAgICAgICAgICAgICBueF9jb29yZCA9IGJ4ICsgZHgKICAgICAg
#3#ICAgICAgICAgICAgICAgICAgbnlfY29vcmQgPSBieSArIGR5CiAgICAgICAgICAgICAgICAgICAg
#3#ICAgIG56X2Nvb3JkID0gYnogKyBkegogICAgICAgICAgICAgICAgICAgICAgICBpZiAwIDw9IG54
#3#X2Nvb3JkIDwgbnggYW5kIDAgPD0gbnlfY29vcmQgPCBueSBhbmQgMCA8PSBuel9jb29yZCA8IG56
#3#OgogICAgICAgICAgICAgICAgICAgICAgICAgICAgYWN0aXZlX2Nvb3Jkcy5hZGQoKG54X2Nvb3Jk
#3#LCBueV9jb29yZCwgbnpfY29vcmQpKQoKICAgICAgICBhY3RpdmVfY2h1bmtzX2dyaWQgPSBbY2gg
#3#Zm9yIGNoIGluIGNodW5rc19ncmlkIGlmIChjaFsiYngiXSwgY2hbImJ5Il0sIGNoWyJieiJdKSBp
#3#biBhY3RpdmVfY29vcmRzXQogICAgICAgIHByaW50KGYiW1BBQ0tFUl0ge3RwX3N1YmRpciBvciAn
#3#dDAwMCd9IExPRCB7bG9kX251bX06IEdyaWQge254fXh7bnl9eHtuen0gIgogICAgICAgICAgICAg
#3#IGYiKHtsZW4oY2h1bmtzX2dyaWQpfSBjaHVua3MsIHtsZW4oYWN0aXZlX2NodW5rc19ncmlkKX0g
#3#YWN0aXZlIGFmdGVyIHRocmVzaG9sZGluZykiKQoKICAgICAgICAjIFdlIHdpbGwgdHJhY2sgb2Nj
#3#dXBhbmN5IHVuaW9uIGFjcm9zcyBhbGwgY2hhbm5lbHMgZm9yIHRoZSBhY3RpdmUgY2h1bmsgZ3Jp
#3#ZAogICAgICAgIG9jY3VwYW5jeV91bmlvbiA9IFswLjBdICogbGVuKGFjdGl2ZV9jaHVua3NfZ3Jp
#3#ZCkKCiAgICAgICAgIyBGb3IgZWFjaCBjaGFubmVsLCBvcGVuIHRoZSBwcm9jZXNzZWQgcmF3IGJp
#3#bmFyeSB2b2x1bWUKICAgICAgICBmb3IgY19pZHggaW4gcmFuZ2Uobl9jaCk6CiAgICAgICAgICAg
#3#IGJpbl9maWxlID0gdGVtcF9kaXIgLyBmInR7dF9pZHg6MDNkfV9je2NfaWR4fV9sb2R7bG9kX251
#3#bX0uYmluIgoKICAgICAgICAgICAgaWYgbm90IGJpbl9maWxlLmV4aXN0cygpOgogICAgICAgICAg
#3#ICAgICAgcHJpbnQoZiJbV0FSTklOR10gUHJvY2Vzc2VkIGZpbGUgbm90IGZvdW5kOiB7YmluX2Zp
#3#bGV9IikKICAgICAgICAgICAgICAgIGNvbnRpbnVlCgogICAgICAgICAgICAjIE1lbW9yeSBtYXAg
#3#dGhlIHZvbHVtZQogICAgICAgICAgICB2b2x1bWVfZGF0YSA9IG5wLm1lbW1hcCgKICAgICAgICAg
#3#ICAgICAgIHN0cihiaW5fZmlsZSksCiAgICAgICAgICAgICAgICBkdHlwZT1ucC51aW50OCwKICAg
#3#ICAgICAgICAgICAgIG1vZGU9InIiLAogICAgICAgICAgICAgICAgc2hhcGU9KEQsIEgsIFcpCiAg
#3#ICAgICAgICAgICkKCiAgICAgICAgICAgICMgU2V0dXAgcGFja2VyIGZvciB0aGlzIExPRCArIENo
#3#YW5uZWwKICAgICAgICAgICAgY2hhbm5lbF9sb2RfZGlyID0gdHBfcm9vdCAvIGYibG9ke2xvZF9u
#3#dW19IiAvIGYiY3tjX2lkeH0iCiAgICAgICAgICAgIGNoYW5uZWxfbG9kX2Rpci5ta2RpcihwYXJl
#3#bnRzPVRydWUsIGV4aXN0X29rPVRydWUpCgogICAgICAgICAgICBjdXJyZW50X3BhY2tfaWR4ID0g
#3#MAogICAgICAgICAgICBjdXJyZW50X3BhY2tfZmlsZSA9IE5vbmUKICAgICAgICAgICAgY3VycmVu
#3#dF9wYWNrX29mZnNldCA9IDAKICAgICAgICAgICAgY2h1bmtzX2luX2N1cnJlbnRfcGFjayA9IDAK
#3#CiAgICAgICAgICAgIGRlZiBnZXRfcGFja19maWxlKGlkeCk6CiAgICAgICAgICAgICAgICBwX2Zp
#3#bGUgPSBjaGFubmVsX2xvZF9kaXIgLyBmInBhY2tfe2lkeDowMmR9LmJpbiIKICAgICAgICAgICAg
#3#ICAgIHJldHVybiBwX2ZpbGUsIG9wZW4ocF9maWxlLCAid2IiKQoKICAgICAgICAgICAgcGFja19m
#3#aWxlX3BhdGgsIGN1cnJlbnRfcGFja19maWxlID0gZ2V0X3BhY2tfZmlsZShjdXJyZW50X3BhY2tf
#3#aWR4KQoKICAgICAgICAgICAgIyBQcmVwYXJlIGFyZ3VtZW50cyBmb3IgbXVsdGlwcm9jZXNzaW5n
#3#CiAgICAgICAgICAgIHRhc2tzID0gW10KICAgICAgICAgICAgZm9yIGksIGNoIGluIGVudW1lcmF0
#3#ZShhY3RpdmVfY2h1bmtzX2dyaWQpOgogICAgICAgICAgICAgICAgY2hfbWV0YSA9IHsiaWR4Ijog
#3#aSwgImJ4IjogY2hbImJ4Il0sICJieSI6IGNoWyJieSJdLCAiYnoiOiBjaFsiYnoiXSwgInZhbGlk
#3#Vm94ZWxDb3VudCI6IGNoWyJ2YWxpZFZveGVsQ291bnQiXX0KICAgICAgICAgICAgICAgIG94LCBv
#3#eSwgb3ogPSBjaFsibWluIl0KICAgICAgICAgICAgICAgIGV4LCBleSwgZXogPSBjaFsibWF4Il0K
#3#ICAgICAgICAgICAgICAgIGNodW5rX2RhdGEgPSBucC5jb3B5KHZvbHVtZV9kYXRhW296OmV6LCBv
#3#eTpleSwgb3g6ZXhdKQogICAgICAgICAgICAgICAgdGFza3MuYXBwZW5kKChjaHVua19kYXRhLCBj
#3#aF9tZXRhLCBCUklDS19TSVpFKSkKCiAgICAgICAgICAgIGZyb20gdHFkbSBpbXBvcnQgdHFkbQog
#3#ICAgICAgICAgICAjIGV4ZWN1dG9yLm1hcCBwcmVzZXJ2ZXMgdGhlIG9yZGVyIG9mIGFjdGl2ZV9j
#3#aHVua3NfZ3JpZAogICAgICAgICAgICBmb3IgcmVzdWx0IGluIHRxZG0oZXhlY3V0b3IubWFwKHBy
#3#b2Nlc3NfY2h1bmssIHRhc2tzKSwgdG90YWw9bGVuKHRhc2tzKSwKICAgICAgICAgICAgICAgICAg
#3#ICAgICAgICAgICAgIGRlc2M9IkNvbXByZXNzaW5nIFdlYlAiLCBsZWF2ZT1GYWxzZSwgYXNjaWk9
#3#VHJ1ZSwgbWluaW50ZXJ2YWw9Mi4wKToKICAgICAgICAgICAgICAgIGlkeCwgb2NjLCBpc19ub25f
#3#ZW1wdHksIGNvbXByZXNzZWRfYnl0ZXMgPSByZXN1bHQKICAgICAgICAgICAgICAgIG9jY3VwYW5j
#3#eV91bmlvbltpZHhdID0gbWF4KG9jY3VwYW5jeV91bmlvbltpZHhdLCBvY2MpCgogICAgICAgICAg
#3#ICAgICAgaWYgaXNfbm9uX2VtcHR5OgogICAgICAgICAgICAgICAgICAgICMgQ2hlY2sgaWYgd2Ug
#3#bmVlZCB0byByb2xsIG92ZXIgdG8gYSBuZXcgcGFjayBmaWxlCiAgICAgICAgICAgICAgICAgICAg
#3#aWYgY2h1bmtzX2luX2N1cnJlbnRfcGFjayA+PSBDSFVOS1NfUEVSX1BBQ0s6CiAgICAgICAgICAg
#3#ICAgICAgICAgICAgIGN1cnJlbnRfcGFja19maWxlLmNsb3NlKCkKICAgICAgICAgICAgICAgICAg
#3#ICAgICAgIyBSZWNvcmQgaGFzaCBvZiBjb21wbGV0ZWQgcGFjawogICAgICAgICAgICAgICAgICAg
#3#ICAgICBwYWNrX3JlbF9wYXRoID0gcGFja19maWxlX3BhdGgucmVsYXRpdmVfdG8odHBfcm9vdCku
#3#YXNfcG9zaXgoKQogICAgICAgICAgICAgICAgICAgICAgICBwYWNrX2hhc2hlc1twYWNrX3JlbF9w
#3#YXRoXSA9IGhhc2hsaWIuc2hhMjU2KHBhY2tfZmlsZV9wYXRoLnJlYWRfYnl0ZXMoKSkuaGV4ZGln
#3#ZXN0KCkKCiAgICAgICAgICAgICAgICAgICAgICAgIGN1cnJlbnRfcGFja19pZHggKz0gMQogICAg
#3#ICAgICAgICAgICAgICAgICAgICBwYWNrX2ZpbGVfcGF0aCwgY3VycmVudF9wYWNrX2ZpbGUgPSBn
#3#ZXRfcGFja19maWxlKGN1cnJlbnRfcGFja19pZHgpCiAgICAgICAgICAgICAgICAgICAgICAgIGN1
#3#cnJlbnRfcGFja19vZmZzZXQgPSAwCiAgICAgICAgICAgICAgICAgICAgICAgIGNodW5rc19pbl9j
#3#dXJyZW50X3BhY2sgPSAwCgogICAgICAgICAgICAgICAgICAgICMgV3JpdGUgY29tcHJlc3NlZCBi
#3#eXRlcyB0byBjdXJyZW50IHBhY2sgZmlsZQogICAgICAgICAgICAgICAgICAgIGN1cnJlbnRfcGFj
#3#a19maWxlLndyaXRlKGNvbXByZXNzZWRfYnl0ZXMpCgogICAgICAgICAgICAgICAgICAgICMgU2F2
#3#ZSBtYXBwaW5nIGluIGJyaWNrVG9QYWNrCiAgICAgICAgICAgICAgICAgICAgY2ggPSBhY3RpdmVf
#3#Y2h1bmtzX2dyaWRbaWR4XQogICAgICAgICAgICAgICAgICAgIGJ4LCBieSwgYnogPSBjaFsiYngi
#3#XSwgY2hbImJ5Il0sIGNoWyJieiJdCiAgICAgICAgICAgICAgICAgICAgYnJpY2tfcmVsX2tleSA9
#3#IGYibG9ke2xvZF9udW19L2N7Y19pZHh9L3h7Yng6MDNkfV95e2J5OjAzZH1fentiejowM2R9Lndl
#3#YnAiCiAgICAgICAgICAgICAgICAgICAgcGFja19yZWxfcGF0aCA9IHBhY2tfZmlsZV9wYXRoLnJl
#3#bGF0aXZlX3RvKHRwX3Jvb3QpLmFzX3Bvc2l4KCkKCiAgICAgICAgICAgICAgICAgICAgYnJpY2tf
#3#dG9fcGFja1ticmlja19yZWxfa2V5XSA9IHsKICAgICAgICAgICAgICAgICAgICAgICAgInVybCI6
#3#IHBhY2tfcmVsX3BhdGgsCiAgICAgICAgICAgICAgICAgICAgICAgICJvZmZzZXQiOiBpbnQoY3Vy
#3#cmVudF9wYWNrX29mZnNldCksCiAgICAgICAgICAgICAgICAgICAgICAgICJsZW5ndGgiOiBpbnQo
#3#bGVuKGNvbXByZXNzZWRfYnl0ZXMpKQogICAgICAgICAgICAgICAgICAgIH0KCiAgICAgICAgICAg
#3#ICAgICAgICAgY3VycmVudF9wYWNrX29mZnNldCArPSBsZW4oY29tcHJlc3NlZF9ieXRlcykKICAg
#3#ICAgICAgICAgICAgICAgICBjaHVua3NfaW5fY3VycmVudF9wYWNrICs9IDEKCiAgICAgICAgICAg
#3#ICMgQ2xvc2UgdGhlIGZpbmFsIHBhY2sgZmlsZSBmb3IgdGhpcyBjaGFubmVsCiAgICAgICAgICAg
#3#IGlmIGN1cnJlbnRfcGFja19maWxlOgogICAgICAgICAgICAgICAgY3VycmVudF9wYWNrX2ZpbGUu
#3#Y2xvc2UoKQogICAgICAgICAgICAgICAgcGFja19yZWxfcGF0aCA9IHBhY2tfZmlsZV9wYXRoLnJl
#3#bGF0aXZlX3RvKHRwX3Jvb3QpLmFzX3Bvc2l4KCkKICAgICAgICAgICAgICAgIHBhY2tfaGFzaGVz
#3#W3BhY2tfcmVsX3BhdGhdID0gaGFzaGxpYi5zaGEyNTYocGFja19maWxlX3BhdGgucmVhZF9ieXRl
#3#cygpKS5oZXhkaWdlc3QoKQoKICAgICAgICAgICAgIyBDbG9zZSBtZW1tYXAgZmlsZSBoYW5kbGUK
#3#ICAgICAgICAgICAgZGVsIHZvbHVtZV9kYXRhCgogICAgICAgICMgQnVpbGQgbGV2ZWwgY2h1bmtz
#3#IGxpc3QgZm9yIG1hbmlmZXN0CiAgICAgICAgbWFuaWZlc3RfY2h1bmtzID0gW10KICAgICAgICBu
#3#b25fZW1wdHlfY291bnQgPSAwCiAgICAgICAgZm9yIGksIGNoIGluIGVudW1lcmF0ZShhY3RpdmVf
#3#Y2h1bmtzX2dyaWQpOgogICAgICAgICAgICBpc19ub25fZW1wdHkgPSBvY2N1cGFuY3lfdW5pb25b
#3#aV0gPiAwLjAwMDUKICAgICAgICAgICAgaWYgaXNfbm9uX2VtcHR5OgogICAgICAgICAgICAgICAg
#3#bm9uX2VtcHR5X2NvdW50ICs9IDEKICAgICAgICAgICAgbWFuaWZlc3RfY2h1bmtzLmFwcGVuZCh7
#3#CiAgICAgICAgICAgICAgICAiaWQiOiBmIntjaFsnYnonXX1fe2NoWydieSddfV97Y2hbJ2J4J119
#3#IiwKICAgICAgICAgICAgICAgICJtaW4iOiBjaFsibWluIl0sCiAgICAgICAgICAgICAgICAibWF4
#3#IjogY2hbIm1heCJdLAogICAgICAgICAgICAgICAgIm9jY3VwaWVkUmF0aW8iOiByb3VuZChvY2N1
#3#cGFuY3lfdW5pb25baV0sIDYpLAogICAgICAgICAgICAgICAgIm5vbkVtcHR5IjogaXNfbm9uX2Vt
#3#cHR5CiAgICAgICAgICAgIH0pCgogICAgICAgIGxldmVsc19tYW5pZmVzdC5hcHBlbmQoewogICAg
#3#ICAgICAgICAibGV2ZWwiOiBsb2RfbnVtLAogICAgICAgICAgICAic2NhbGUiOiAxLjAgLyAoMiAq
#3#KiBsb2RfbnVtKSwKICAgICAgICAgICAgImRpbWVuc2lvbnMiOiB7IngiOiBXLCAieSI6IEgsICJ6
#3#IjogRH0sCiAgICAgICAgICAgICJicmlja1NpemUiOiBCUklDS19TSVpFLAogICAgICAgICAgICAi
#3#Z3JpZFNpemUiOiB7IngiOiBueCwgInkiOiBueSwgInoiOiBuen0sCiAgICAgICAgICAgICJicmlj
#3#a0NvdW50IjogbGVuKGNodW5rc19ncmlkKSwKICAgICAgICAgICAgImNodW5rcyI6IG1hbmlmZXN0
#3#X2NodW5rcywKICAgICAgICAgICAgIm5vbkVtcHR5Q291bnQiOiBub25fZW1wdHlfY291bnQKICAg
#3#ICAgICB9KQoKICAgIHRyYW5zcG9ydCA9IHsKICAgICAgICAibW9kZSI6ICJwYWNrcyIsCiAgICAg
#3#ICAgImVuY29kaW5nIjogIndlYnAtbG9zc2xlc3MiLAogICAgICAgICJwYWNrU2l6ZSI6IENIVU5L
#3#U19QRVJfUEFDSywKICAgICAgICAiYnJpY2tUb1BhY2siOiBicmlja190b19wYWNrLAogICAgICAg
#3#ICJwYWNrSGFzaGVzIjogcGFja19oYXNoZXMKICAgIH0KICAgIHJldHVybiBsZXZlbHNfbWFuaWZl
#3#c3QsIHRyYW5zcG9ydAoKCmRlZiBidWlsZF9wYWNrcyh0ZW1wX2RpcjogUGF0aCwgb3V0cHV0X2Rp
#3#cjogUGF0aCk6CiAgICB3aXRoIG9wZW4odGVtcF9kaXIgLyAicHJvY2Vzc2luZ19tZXRhLmpzb24i
#3#LCAiciIsIGVuY29kaW5nPSJ1dGYtOCIpIGFzIGZtOgogICAgICAgIHByb2NfbWV0YSA9IGpzb24u
#3#bG9hZChmbSkKCiAgICBsb2RfbGV2ZWxzID0gcHJvY19tZXRhWyJsb2RfbGV2ZWxzIl0KICAgIG5f
#3#Y2ggPSBwcm9jX21ldGFbIm5fY2hhbm5lbHMiXQogICAgbl90cCA9IHByb2NfbWV0YVsibl90aW1l
#3#cG9pbnRzIl0KICAgIHZveGVsX3NpemUgPSBwcm9jX21ldGFbInZveGVsX3NpemUiXQogICAgY2hh
#3#bm5lbF9uYW1lcyA9IHByb2NfbWV0YVsiY2hhbm5lbF9uYW1lcyJdCgogICAgYnJpY2tzX2RpciA9
#3#IG91dHB1dF9kaXIgLyAiYnJpY2tzIgogICAgYnJpY2tzX2Rpci5ta2RpcihwYXJlbnRzPVRydWUs
#3#IGV4aXN0X29rPVRydWUpCgogICAgQlJJQ0tfU0laRSA9IDY0CiAgICBDSFVOS1NfUEVSX1BBQ0sg
#3#PSAxMjgKCiAgICBpc190aW1lbGFwc2UgPSBuX3RwID4gMQoKICAgICMgT25lIHByb2Nlc3MgcG9v
#3#bCBmb3IgdGhlIHdob2xlIHJ1bjogYSB0aW1lbGFwc2UgcGFja3Mgbl90cCB4IG5fbG9kIHggbl9j
#3#aAogICAgIyBiYXRjaGVzIGFuZCByZS1zcGF3bmluZyBhIHBvb2wgZm9yIGVhY2ggd291bGQgZG9t
#3#aW5hdGUgdGhlIHJ1bnRpbWUuCiAgICB3aXRoIFByb2Nlc3NQb29sRXhlY3V0b3IobWF4X3dvcmtl
#3#cnM9b3MuY3B1X2NvdW50KCkpIGFzIGV4ZWN1dG9yOgogICAgICAgIGlmIG5vdCBpc190aW1lbGFw
#3#c2U6CiAgICAgICAgICAgIGxldmVsc19tYW5pZmVzdCwgdHJhbnNwb3J0ID0gX3BhY2tfdGltZXBv
#3#aW50KAogICAgICAgICAgICAgICAgdGVtcF9kaXIsIGJyaWNrc19kaXIsIDAsIGxvZF9sZXZlbHMs
#3#IG5fY2gsIGV4ZWN1dG9yLCAiIgogICAgICAgICAgICApCiAgICAgICAgICAgIHRpbWVwb2ludHNf
#3#bWFuaWZlc3QgPSBOb25lCiAgICAgICAgZWxzZToKICAgICAgICAgICAgdGltZXBvaW50c19tYW5p
#3#ZmVzdCA9IHt9CiAgICAgICAgICAgIGxldmVsc19tYW5pZmVzdCA9IE5vbmUKICAgICAgICAgICAg
#3#dHJhbnNwb3J0ID0gTm9uZQogICAgICAgICAgICBmb3IgdF9pZHggaW4gcmFuZ2Uobl90cCk6CiAg
#3#ICAgICAgICAgICAgICBrZXkgPSBmInR7dF9pZHg6MDNkfSIKICAgICAgICAgICAgICAgIHByaW50
#3#KGYiW1BBQ0tFUl0gPT09IHRpbWVwb2ludCB7dF9pZHggKyAxfS97bl90cH0gKHtrZXl9KSA9PT0i
#3#KQogICAgICAgICAgICAgICAgdHBfbGV2ZWxzLCB0cF90cmFuc3BvcnQgPSBfcGFja190aW1lcG9p
#3#bnQoCiAgICAgICAgICAgICAgICAgICAgdGVtcF9kaXIsIGJyaWNrc19kaXIsIHRfaWR4LCBsb2Rf
#3#bGV2ZWxzLCBuX2NoLCBleGVjdXRvciwga2V5CiAgICAgICAgICAgICAgICApCiAgICAgICAgICAg
#3#ICAgICB0aW1lcG9pbnRzX21hbmlmZXN0W2tleV0gPSB7CiAgICAgICAgICAgICAgICAgICAgInBh
#3#dGgiOiBrZXksCiAgICAgICAgICAgICAgICAgICAgImNoYW5uZWxzIjogbl9jaCwKICAgICAgICAg
#3#ICAgICAgICAgICAibGV2ZWxzIjogdHBfbGV2ZWxzLAogICAgICAgICAgICAgICAgICAgICJicmlj
#3#a1RyYW5zcG9ydCI6IHRwX3RyYW5zcG9ydCwKICAgICAgICAgICAgICAgICAgICAiaGlzdG9ncmFt
#3#cyI6IFtdICAgIyBmaWxsZWQgYnkgc3RlcCA0CiAgICAgICAgICAgICAgICB9CiAgICAgICAgICAg
#3#ICAgICBpZiB0X2lkeCA9PSAwOgogICAgICAgICAgICAgICAgICAgICMgTWlycm9yZWQgYXQgdGhl
#3#IHRvcCBsZXZlbCBzbyBhIGNvbnN1bWVyIHRoYXQgaWdub3JlcyBgdGltZXBvaW50c2AKICAgICAg
#3#ICAgICAgICAgICAgICAjIHN0aWxsIG1vdW50cyBhIGNvaGVyZW50IChmaXJzdC1mcmFtZSkgZGF0
#3#YXNldCBpbnN0ZWFkIG9mIGZhaWxpbmcuCiAgICAgICAgICAgICAgICAgICAgbGV2ZWxzX21hbmlm
#3#ZXN0ID0gdHBfbGV2ZWxzCiAgICAgICAgICAgICAgICAgICAgdHJhbnNwb3J0ID0gdHBfdHJhbnNw
#3#b3J0CgogICAgIyBBc3NlbWJsZSBhbmQgd3JpdGUgbWFuaWZlc3QuanNvbgogICAgbWFuaWZlc3Qg
#3#PSB7CiAgICAgICAgInZlcnNpb24iOiAyLAogICAgICAgICJzY2hlbWEiOiAiaXJpYmhtLWJyaWNr
#3#cy12MiIsCiAgICAgICAgImRhdGFzZXQiOiBvdXRwdXRfZGlyLm5hbWUsCiAgICAgICAgImRhdGFz
#3#ZXRUeXBlIjogImxpdmUiIGlmIGlzX3RpbWVsYXBzZSBlbHNlICJmaXhlZCIsCiAgICAgICAgImNo
#3#YW5uZWxzIjogbl9jaCwKICAgICAgICAiYnJpY2tTaXplIjogQlJJQ0tfU0laRSwKICAgICAgICAi
#3#YnJpY2tQYWNraW5nIjogeyJtb2RlIjogImdyaWQiLCAiY29scyI6IDgsICJyb3dzIjogOH0sCiAg
#3#ICAgICAgInZveGVsU2l6ZSI6IHZveGVsX3NpemUsCiAgICAgICAgImNyZWF0ZWRBdCI6IF9faW1w
#3#b3J0X18oImRhdGV0aW1lIikuZGF0ZXRpbWUubm93KCkuaXNvZm9ybWF0KCksCiAgICAgICAgImxl
#3#dmVscyI6IGxldmVsc19tYW5pZmVzdCwKICAgICAgICAiaGlzdG9ncmFtcyI6IFtdLCAjIFdpbGwg
#3#YmUgcG9wdWxhdGVkIGJ5IHN0ZXAgNCBvciBkeW5hbWljIHNjYW4KICAgICAgICAiaGFzaGVzIjog
#3#e30sICAgICAjIExlZnQgZW1wdHkgYXMgd2UgdXNlIHBhY2sgdHJhbnNwb3J0CiAgICAgICAgInRp
#3#bWVwb2ludHMiOiB0aW1lcG9pbnRzX21hbmlmZXN0LAogICAgICAgICJicmlja1RyYW5zcG9ydCI6
#3#IHRyYW5zcG9ydAogICAgfQoKICAgIHdpdGggb3Blbihicmlja3NfZGlyIC8gIm1hbmlmZXN0Lmpz
#3#b24iLCAidyIsIGVuY29kaW5nPSJ1dGYtOCIpIGFzIGZtOgogICAgICAgIGpzb24uZHVtcChtYW5p
#3#ZmVzdCwgZm0sIGluZGVudD0yKQoKICAgIHByaW50KGYiW1BBQ0tFUl0gV3JvdGUgbWFuaWZlc3Qu
#3#anNvbiB0byB7YnJpY2tzX2RpciAvICdtYW5pZmVzdC5qc29uJ30iKQogICAgaWYgaXNfdGltZWxh
#3#cHNlOgogICAgICAgIHNpemVfbWIgPSAoYnJpY2tzX2RpciAvICJtYW5pZmVzdC5qc29uIikuc3Rh
#3#dCgpLnN0X3NpemUgLyAxZTYKICAgICAgICBwcmludChmIltQQUNLRVJdIHtuX3RwfSB0aW1lcG9p
#3#bnRzIGluZGV4ZWQsIG1hbmlmZXN0IHtzaXplX21iOi4yZn0gTUIiKQoKaWYgX19uYW1lX18gPT0g
#3#Il9fbWFpbl9fIjoKICAgIGlmIGxlbihzeXMuYXJndikgPCAzOgogICAgICAgIHByaW50KCJVc2Fn
#3#ZTogcHl0aG9uIDMtY2h1bmtfcGFja2VyLnB5IDx0ZW1wX2Rpcj4gPG91dHB1dF9kaXI+IikKICAg
#3#ICAgICBzeXMuZXhpdCgxKQoKICAgIHRlbXBfZGlyID0gUGF0aChzeXMuYXJndlsxXSkKICAgIG91
#3#dHB1dF9kaXIgPSBQYXRoKHN5cy5hcmd2WzJdKQoKICAgIHRyeToKICAgICAgICBidWlsZF9wYWNr
#3#cyh0ZW1wX2Rpciwgb3V0cHV0X2RpcikKICAgICAgICBwcmludChmIltQQUNLRVJdIENodW5rIHBh
#3#Y2thZ2luZyBjb21wbGV0ZS4iKQogICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBlOgogICAgICAgIGlt
#3#cG9ydCB0cmFjZWJhY2sKICAgICAgICB0cmFjZWJhY2sucHJpbnRfZXhjKCkKICAgICAgICBwcmlu
#3#dChmIltFUlJPUl0gQ2h1bmsgcGFja2FnaW5nIGZhaWxlZDoge2V9IiwgZmlsZT1zeXMuc3RkZXJy
#3#KQogICAgICAgIHN5cy5leGl0KDEpCg==
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
:: ---- [5] build_download_bundles.py (22203 octets) ----
#5#IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMw0KIiIiDQpidWlsZF9kb3dubG9hZF9idW5kbGVzLnB5IOKA
#5#lCBQb3B1bGF0ZSBlYWNoIGRhdGFzZXQncyBkb3dubG9hZC8gZm9sZGVyLg0KDQpGb3IgZXZlcnkg
#5#ZGF0YXNldCB1bmRlciBEQVRBX1dFQi88dHlwZT4vPGZvbGRlcj4vIHRoaXMgYnVpbGRzIHRoZSBm
#5#aWxlcyB0aGUNCkRvd25sb2FkIENlbnRlcidzIGZpbGUgZXhwbG9yZXIgKGFwaS9kb3dubG9hZHMp
#5#IHdpbGwgZXhwb3NlLCBpbiB0aGlzIG9yZGVyOg0KDQogIDEuIDxmb2xkZXI+X3dlYi56aXAgICDi
#5#gJQgYXJjaGl2ZSBvZiB0aGUgc2VydmVkL3ByZXByb2Nlc3NlZCBkYXRhc2V0IChicmlja3MvLA0K
#5#ICAgICAgICAgICAgICAgICAgICAgICAgICBtZXRhZGF0YS5qc29uLCB0aHVtYm5haWwud2VicCku
#5#IFRoZSBkb3dubG9hZC8gZm9sZGVyIGlzDQogICAgICAgICAgICAgICAgICAgICAgICAgIEVYQ0xV
#5#REVELCBzbyB0aGUgYXJjaGl2ZSBuZXZlciBjb250YWlucyB0aGUgb3RoZXINCiAgICAgICAgICAg
#5#ICAgICAgICAgICAgICAgZG93bmxvYWQgYXJ0ZWZhY3RzIChvciBpdHNlbGYpLiBCdWlsdCBGSVJT
#5#VC4NCiAgMi4gPGZvbGRlcj4uaW1zICAgICAgIOKAlCB0aGUgb3JpZ2luYWwgSW1hcmlzIGZpbGUs
#5#IHBsYWNlZCBieSBIQVJEIExJTksgKG5vIGJ5dGUNCiAgICAgICAgICAgICAgICAgICAgICAgICAg
#5#ZHVwbGljYXRpb247IFJBV19EQVRBIGFuZCBEQVRBX1dFQiBsaXZlIG9uIHRoZSBzYW1lDQogICAg
#5#ICAgICAgICAgICAgICAgICAgICAgIHZvbHVtZSkuIEZhbGxzIGJhY2sgdG8gYSBjb3B5IGFjcm9z
#5#cyB2b2x1bWVzLg0KICAzLiA8Zm9sZGVyPi5vbWUudGlmICAg4oCUIGEgbXVsdGktY2hhbm5lbCBP
#5#TUUtVElGRiAodWludDE2LCB2b3hlbC1jYWxpYnJhdGVkIGluDQogICAgICAgICAgICAgICAgICAg
#5#ICAgICAgIMK1bSwgY2hhbm5lbCBuYW1lcykgcmVjb25zdHJ1Y3RlZCBmcm9tIHRoZSAuaW1zIGlu
#5#dGVybmFsDQogICAgICAgICAgICAgICAgICAgICAgICAgIHJlc29sdXRpb24gcHlyYW1pZCBhdCB+
#5#VEFSR0VUX1BYIG9uIHRoZSBsb25nIFhZIHNpZGUuDQogIDQuIDxmb2xkZXI+X0N7bn1fPG5hbWU+
#5#X01JUC5wbmcg4oCUIHBlci1jaGFubmVsIG1heGltdW0taW50ZW5zaXR5IHByb2plY3Rpb24uDQog
#5#IDUuIFJFQURNRS50eHQgICAgICAgICDigJQgcHJvdmVuYW5jZSwgZGltZW5zaW9ucywgdm94ZWwg
#5#c2l6ZSwgY2hhbm5lbHMsIGNpdGF0aW9uLg0KDQpUaGUgLmltcyBpcyByZWFkIHN0cmFpZ2h0IGZy
#5#b20gdGhlIEltYXJpcyBIREY1IHB5cmFtaWQgKFJlc29sdXRpb25MZXZlbCBMKSwgc28NCm9ubHkg
#5#dGhlIGNob3NlbiAoc21hbGwpIGxldmVsIGlzIHRvdWNoZWQg4oCUIG5ldmVyIHRoZSBmdWxsLXJl
#5#c29sdXRpb24gbGV2ZWwgMC4NCg0KSWRlbXBvdGVudDogZXhpc3RpbmcgYXJ0ZWZhY3RzIGFyZSBz
#5#a2lwcGVkIHVubGVzcyAtLWZvcmNlLiBFYWNoIGRhdGFzZXQgaXMNCmlzb2xhdGVkIGluIHRyeS9l
#5#eGNlcHQgc28gb25lIGZhaWx1cmUgbmV2ZXIgYWJvcnRzIHRoZSBiYXRjaC4NCg0KVXNhZ2U6DQog
#5#IHB5IHRvb2xzL2J1aWxkX2Rvd25sb2FkX2J1bmRsZXMucHkgICAgICAgICAgICAgICAgICMgYWxs
#5#IGRhdGFzZXRzLCBhbGwgYXJ0ZWZhY3RzDQogIHB5IHRvb2xzL2J1aWxkX2Rvd25sb2FkX2J1bmRs
#5#ZXMucHkgLS1kYXRhc2V0cyBFOC0xICMgc3Vic3RyaW5nIGZpbHRlcg0KICBweSB0b29scy9idWls
#5#ZF9kb3dubG9hZF9idW5kbGVzLnB5IC0tZHJ5LXJ1bg0KICBweSB0b29scy9idWlsZF9kb3dubG9h
#5#ZF9idW5kbGVzLnB5IC0tbm8taW1zIC0tbm8tYXJjaGl2ZSAgICMgb25seSBUSUZGICsgTUlQDQog
#5#IHB5IHRvb2xzL2J1aWxkX2Rvd25sb2FkX2J1bmRsZXMucHkgLS10aWZmLXB4IDEwMjQgLS1mb3Jj
#5#ZQ0KIiIiDQpmcm9tIF9fZnV0dXJlX18gaW1wb3J0IGFubm90YXRpb25zDQoNCmltcG9ydCBhcmdw
#5#YXJzZQ0KaW1wb3J0IGpzb24NCmltcG9ydCBvcw0KaW1wb3J0IHJlDQppbXBvcnQgc2h1dGlsDQpp
#5#bXBvcnQgc3lzDQppbXBvcnQgdGVtcGZpbGUNCmltcG9ydCB0aW1lDQppbXBvcnQgemlwZmlsZQ0K
#5#ZnJvbSBwYXRobGliIGltcG9ydCBQYXRoDQoNCmltcG9ydCBudW1weSBhcyBucA0KDQojIOKUgOKU
#5#gCBQYXRocyAvIGNvbmZpZyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIDilIDilIDilIDilIDilIANClJPT1QgPSBQYXRoKF9fZmlsZV9fKS5yZXNvbHZlKCkucGFy
#5#ZW50LnBhcmVudCAgICAgICAgICAjIFdlYlBsYXRmb3JtIHJvb3QNCkRBVEFfV0VCID0gUk9PVCAv
#5#ICJEQVRBX1dFQiINCiMgV2hlcmUgdGhlIG9yaWdpbmFsIC5pbXMgZmlsZXMgbGl2ZSAoZG9uZS8g
#5#KyB0b2RvLyBhcmUgc2Nhbm5lZCByZWN1cnNpdmVseSkuDQpSQVdfREFUQV9ESVJTID0gWw0KICAg
#5#IFBhdGgociJDOlxVc2Vyc1xBZG1pbmlzdHJhdG9yXERlc2t0b3BcRml4ZWQgaW1hZ2VzIGZvciBk
#5#YXRhYmFzZVxSQVdfREFUQSIpLA0KXQ0KREFUQVNFVF9UWVBFUyA9ICgiZml4ZWQiLCAibGl2ZSIs
#5#ICJ0cmFja2luZyIpDQoNClRBUkdFVF9QWCA9IDIwNDggICAgICAgICAgICAgICAjIGRlc2lyZWQg
#5#bG9uZyBYWSBzaWRlIG9mIHRoZSBnZW5lcmF0ZWQgT01FLVRJRkYNCiMgSGFyZCBjZWlsaW5nIG9u
#5#IHRoZSBpbi1mbGlnaHQgdm9sdW1lIChDwrdawrdZwrdYwrcyIGJ5dGVzKTsgaWYgdGhlIGxldmVs
#5#IGNsb3Nlc3QgdG8NCiMgVEFSR0VUX1BYIGV4Y2VlZHMgdGhpcywgc3RlcCBkb3duIHRoZSBweXJh
#5#bWlkIHNvIHdlIG5ldmVyIGJsb3cgdXAgZGlzay9SQU0uDQpNQVhfVElGRl9CWVRFUyA9IDYgKiAx
#5#MDI0KiozDQoNCiMgRmFsc2UtY29sb3VyIGZhbGxiYWNrcyAobWlycm9yIHJ1bl9wcmVwcm9jZXNz
#5#LlRIVU1CX0NPTE9SUykgd2hlbiBhIGNoYW5uZWwgaGFzDQojIG5vIGRpc3BsYXkgY29sb3VyIGlu
#5#IG1ldGFkYXRhLmpzb24uDQpUSFVNQl9DT0xPUlMgPSBbDQogICAgKDAsIDI1NSwgMTAyKSwgKDI1
#5#NSwgNjEsIDI1NSksICg0NywgMTA3LCAyNTUpLCAoMjU1LCA0OCwgNDgpLA0KICAgICgyNTUsIDI1
#5#NSwgMCksICgyNTUsIDAsIDI1NSksICgwLCAyNTUsIDI1NSksDQpdDQoNCg0KIyDilIDilIAgSW1h
#5#cmlzIGF0dHJpYnV0ZSBkZWNvZGluZyAobWlycm9ycyBwcmVwcm9jZXNzLzEtaW1zX21ldGFkYXRh
#5#LmF0dHJfc3RyKSDilIDilIANCmRlZiBhdHRyX3N0cihncm91cCwga2V5LCBkZWZhdWx0PSIiKToN
#5#CiAgICBpZiBncm91cCBpcyBOb25lOg0KICAgICAgICByZXR1cm4gZGVmYXVsdA0KICAgIHYgPSBn
#5#cm91cC5hdHRycy5nZXQoa2V5LCBkZWZhdWx0KQ0KICAgIGlmIGlzaW5zdGFuY2UodiwgKGJ5dGVz
#5#LCBucC5ieXRlc18pKToNCiAgICAgICAgcmV0dXJuIHYuZGVjb2RlKCJ1dGYtOCIsIGVycm9ycz0i
#5#cmVwbGFjZSIpLnN0cmlwKCkNCiAgICBpZiBpc2luc3RhbmNlKHYsIG5wLm5kYXJyYXkpOg0KICAg
#5#ICAgICB0cnk6DQogICAgICAgICAgICByZXR1cm4gYiIiLmpvaW4oDQogICAgICAgICAgICAgICAg
#5#Ynl0ZXMoYykgaWYgaXNpbnN0YW5jZShjLCAoYnl0ZXMsIG5wLmJ5dGVzXykpIGVsc2UgYy50b2J5
#5#dGVzKCkNCiAgICAgICAgICAgICAgICBmb3IgYyBpbiB2DQogICAgICAgICAgICApLmRlY29kZSgi
#5#dXRmLTgiLCBlcnJvcnM9InJlcGxhY2UiKS5zdHJpcCgpDQogICAgICAgIGV4Y2VwdCBFeGNlcHRp
#5#b246DQogICAgICAgICAgICByZXR1cm4gIiIuam9pbigNCiAgICAgICAgICAgICAgICBjLmRlY29k
#5#ZSgidXRmLTgiLCBlcnJvcnM9InJlcGxhY2UiKSBpZiBpc2luc3RhbmNlKGMsIChieXRlcywgbnAu
#5#Ynl0ZXNfKSkgZWxzZSBzdHIoYykNCiAgICAgICAgICAgICAgICBmb3IgYyBpbiB2DQogICAgICAg
#5#ICAgICApLnN0cmlwKCkNCiAgICByZXR1cm4gc3RyKHYpLnN0cmlwKCkNCg0KDQpkZWYgYXR0cl9m
#5#bG9hdChncm91cCwga2V5LCBkZWZhdWx0PTAuMCk6DQogICAgdHJ5Og0KICAgICAgICByZXR1cm4g
#5#ZmxvYXQoYXR0cl9zdHIoZ3JvdXAsIGtleSwgc3RyKGRlZmF1bHQpKSkNCiAgICBleGNlcHQgKFR5
#5#cGVFcnJvciwgVmFsdWVFcnJvcik6DQogICAgICAgIHJldHVybiBkZWZhdWx0DQoNCg0KZGVmIGhl
#5#eF90b19yZ2IodmFsdWUsIGZhbGxiYWNrKToNCiAgICBtID0gcmUubWF0Y2gociJeIz8oWzAtOWEt
#5#ZkEtRl17Nn0pJCIsIHN0cih2YWx1ZSBvciAiIikuc3RyaXAoKSkNCiAgICBpZiBub3QgbToNCiAg
#5#ICAgICAgcmV0dXJuIGZhbGxiYWNrDQogICAgaCA9IG0uZ3JvdXAoMSkNCiAgICByZXR1cm4gKGlu
#5#dChoWzA6Ml0sIDE2KSwgaW50KGhbMjo0XSwgMTYpLCBpbnQoaFs0OjZdLCAxNikpDQoNCg0KIyDi
#5#lIDilIAgRGF0YXNldCBkaXNjb3Zlcnkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSADQpkZWYgX3JlYWRfbWV0YV9qc29uKGQpOg0KICAgICIiIlBlci1k
#5#YXRhc2V0IG1ldGFkYXRhLmpzb24g4oCUIHRoZSBhdXRob3JpdGF0aXZlIHNvdXJjZSBmb3IgY2hh
#5#bm5lbHMvdm94ZWxzLg0KICAgIHV0Zi04LXNpZyB0b2xlcmF0ZXMgYSBzdHJheSBCT00gKGhhbmQt
#5#ZWRpdGVkIGZpbGVzKSB3aXRob3V0IGJyZWFraW5nIHRoZSBwYXJzZS4iIiINCiAgICBwID0gZCAv
#5#ICJtZXRhZGF0YS5qc29uIg0KICAgIGlmIHAuZXhpc3RzKCk6DQogICAgICAgIHRyeToNCiAgICAg
#5#ICAgICAgIHJldHVybiBqc29uLmxvYWRzKHAucmVhZF90ZXh0KGVuY29kaW5nPSJ1dGYtOC1zaWci
#5#KSkNCiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbjoNCiAgICAgICAgICAgIHJldHVybiB7fQ0KICAg
#5#IHJldHVybiB7fQ0KDQoNCmRlZiBsb2FkX2RhdGFzZXRzKGZpbHRlcl9zdWJzdHI9Tm9uZSwgdHlw
#5#ZXM9REFUQVNFVF9UWVBFUyk6DQogICAgIiIiUmV0dXJuIFt7aWQsIHR5cGUsIGZvbGRlciwgZGly
#5#LCBtZXRhfV0sIGRyaXZlbiBieSBjYXRhbG9nLmpzb24gd2hlbiBwcmVzZW50Lg0KICAgIG1ldGFk
#5#YXRhLmpzb24gKHdyaXR0ZW4gYnkgdGhlIHByZXByb2Nlc3MgcGlwZWxpbmUpIHRha2VzIHByZWNl
#5#ZGVuY2UgZm9yIGBtZXRhYA0KICAgIHNvIHRoaXMgd29ya3MgZXZlbiB3aGVuIHJ1biByaWdodCBh
#5#ZnRlciBhIGRhdGFzZXQgaXMgYnVpbHQsIGJlZm9yZSBjYXRhbG9nLmpzb24NCiAgICBoYXMgYWdn
#5#cmVnYXRlZCBpdC4iIiINCiAgICBvdXQsIHNlZW4gPSBbXSwgc2V0KCkNCiAgICBjYXRhbG9nID0g
#5#REFUQV9XRUIgLyAiY2F0YWxvZy5qc29uIg0KICAgIGVudHJpZXMgPSBbXQ0KICAgIGlmIGNhdGFs
#5#b2cuZXhpc3RzKCk6DQogICAgICAgIHRyeToNCiAgICAgICAgICAgIGVudHJpZXMgPSBqc29uLmxv
#5#YWRzKGNhdGFsb2cucmVhZF90ZXh0KGVuY29kaW5nPSJ1dGYtOCIpKQ0KICAgICAgICBleGNlcHQg
#5#RXhjZXB0aW9uIGFzIGV4YzoNCiAgICAgICAgICAgIHByaW50KGYiW3dhcm5dIGNhdGFsb2cuanNv
#5#biB1bnJlYWRhYmxlICh7ZXhjfSk7IGZhbGxpbmcgYmFjayB0byBkaXIgc2NhbiIpDQogICAgZm9y
#5#IGUgaW4gZW50cmllczoNCiAgICAgICAgcGF0aCA9IGUuZ2V0KCJwYXRoIikgb3IgZS5nZXQoImlk
#5#Iikgb3IgIiINCiAgICAgICAgcGFydHMgPSBwYXRoLnNwbGl0KCIvIiwgMSkNCiAgICAgICAgaWYg
#5#bGVuKHBhcnRzKSAhPSAyOg0KICAgICAgICAgICAgY29udGludWUNCiAgICAgICAgdHlwLCBmb2xk
#5#ZXIgPSBwYXJ0cw0KICAgICAgICBkID0gREFUQV9XRUIgLyB0eXAgLyBmb2xkZXINCiAgICAgICAg
#5#aWYgdHlwIGluIHR5cGVzIGFuZCBkLmlzX2RpcigpOg0KICAgICAgICAgICAgb3V0LmFwcGVuZCh7
#5#ImlkIjogcGF0aCwgInR5cGUiOiB0eXAsICJmb2xkZXIiOiBmb2xkZXIsICJkaXIiOiBkLA0KICAg
#5#ICAgICAgICAgICAgICAgICAgICAgIm1ldGEiOiBfcmVhZF9tZXRhX2pzb24oZCkgb3IgZX0pDQog
#5#ICAgICAgICAgICBzZWVuLmFkZChwYXRoKQ0KICAgICMgZGlyLXNjYW4gZmFsbGJhY2sgZm9yIGFu
#5#eXRoaW5nIG5vdCBpbiB0aGUgY2F0YWxvZw0KICAgIGZvciB0eXAgaW4gdHlwZXM6DQogICAgICAg
#5#IGJhc2UgPSBEQVRBX1dFQiAvIHR5cA0KICAgICAgICBpZiBub3QgYmFzZS5pc19kaXIoKToNCiAg
#5#ICAgICAgICAgIGNvbnRpbnVlDQogICAgICAgIGZvciBkIGluIHNvcnRlZChiYXNlLml0ZXJkaXIo
#5#KSk6DQogICAgICAgICAgICBwaWQgPSBmInt0eXB9L3tkLm5hbWV9Ig0KICAgICAgICAgICAgaWYg
#5#ZC5pc19kaXIoKSBhbmQgcGlkIG5vdCBpbiBzZWVuOg0KICAgICAgICAgICAgICAgIG91dC5hcHBl
#5#bmQoeyJpZCI6IHBpZCwgInR5cGUiOiB0eXAsICJmb2xkZXIiOiBkLm5hbWUsICJkaXIiOiBkLA0K
#5#ICAgICAgICAgICAgICAgICAgICAgICAgICAgICJtZXRhIjogX3JlYWRfbWV0YV9qc29uKGQpfSkN
#5#CiAgICBpZiBmaWx0ZXJfc3Vic3RyOg0KICAgICAgICBvdXQgPSBbbyBmb3IgbyBpbiBvdXQgaWYg
#5#ZmlsdGVyX3N1YnN0ci5sb3dlcigpIGluIG9bImZvbGRlciJdLmxvd2VyKCldDQogICAgcmV0dXJu
#5#IG91dA0KDQoNCmRlZiBmaW5kX2ltcyhmb2xkZXIpOg0KICAgICIiIkxvY2F0ZSA8Zm9sZGVyPi5p
#5#bXMgaW4gYW55IGNvbmZpZ3VyZWQgUkFXX0RBVEEgZGlyIChyZWN1cnNpdmUpLiIiIg0KICAgIGZv
#5#ciBiYXNlIGluIFJBV19EQVRBX0RJUlM6DQogICAgICAgIGlmIG5vdCBiYXNlLmlzX2RpcigpOg0K
#5#ICAgICAgICAgICAgY29udGludWUNCiAgICAgICAgZXhhY3QgPSBsaXN0KGJhc2Uucmdsb2IoZiJ7
#5#Zm9sZGVyfS5pbXMiKSkNCiAgICAgICAgaWYgZXhhY3Q6DQogICAgICAgICAgICByZXR1cm4gZXhh
#5#Y3RbMF0NCiAgICByZXR1cm4gTm9uZQ0KDQoNCiMg4pSA4pSAIFN0ZXAgMSDigJQgYXJjaGl2ZSBv
#5#ZiB0aGUgcHJlcHJvY2Vzc2VkIGRhdGFzZXQgKGRvd25sb2FkLyBleGNsdWRlZCkg4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSADQpkZWYgYnVpbGRfYXJjaGl2ZShkc19kaXIsIGZvbGRlciwgb3V0X3BhdGgs
#5#IGZvcmNlLCBkcnkpOg0KICAgIGlmIG91dF9wYXRoLmV4aXN0cygpIGFuZCBub3QgZm9yY2U6DQog
#5#ICAgICAgIHJldHVybiAic2tpcCAoZXhpc3RzKSINCiAgICAjIENvbGxlY3QgdGhlIHNlcnZhYmxl
#5#IGZpbGVzIGZpcnN0OyB0aGUgZG93bmxvYWQvIGZvbGRlciBpcyBleGNsdWRlZCBzbyB0aGUNCiAg
#5#ICAjIGFyY2hpdmUgbmV2ZXIgY29udGFpbnMgdGhlIG90aGVyIGFydGVmYWN0cyAob3IgaXRzZWxm
#5#KS4NCiAgICBmaWxlcyA9IFtwIGZvciBwIGluIHNvcnRlZChkc19kaXIucmdsb2IoIioiKSkNCiAg
#5#ICAgICAgICAgICBpZiBwLmlzX2ZpbGUoKSBhbmQgcC5yZWxhdGl2ZV90byhkc19kaXIpLnBhcnRz
#5#WzoxXSAhPSAoImRvd25sb2FkIiwpXQ0KICAgIGlmIG5vdCBmaWxlczoNCiAgICAgICAgcmV0dXJu
#5#ICJza2lwIChubyB3ZWIgZGF0YSB5ZXQpIiAgICAgICAgIyB1bi1wcmVwcm9jZXNzZWQgZGF0YXNl
#5#dCDihpIgbm8gZW1wdHkgemlwDQogICAgaWYgZHJ5Og0KICAgICAgICByZXR1cm4gZiJ3b3VsZCBi
#5#dWlsZCAoe2xlbihmaWxlcyl9IGZpbGVzKSINCiAgICB0bXAgPSBvdXRfcGF0aC53aXRoX3N1ZmZp
#5#eChvdXRfcGF0aC5zdWZmaXggKyAiLnRtcCIpDQogICAgd2l0aCB6aXBmaWxlLlppcEZpbGUodG1w
#5#LCAidyIsIGNvbXByZXNzaW9uPXppcGZpbGUuWklQX1NUT1JFRCwgYWxsb3daaXA2ND1UcnVlKSBh
#5#cyB6ZjoNCiAgICAgICAgZm9yIHBhdGggaW4gZmlsZXM6DQogICAgICAgICAgICB6Zi53cml0ZShw
#5#YXRoLCBhcmNuYW1lPXN0cihQYXRoKGZvbGRlcikgLyBwYXRoLnJlbGF0aXZlX3RvKGRzX2Rpcikp
#5#KQ0KICAgIG9zLnJlcGxhY2UodG1wLCBvdXRfcGF0aCkNCiAgICByZXR1cm4gZiJ7bGVuKGZpbGVz
#5#KX0gZmlsZXMsIHtmbXRfc2l6ZShvdXRfcGF0aC5zdGF0KCkuc3Rfc2l6ZSl9Ig0KDQoNCiMg4pSA
#5#4pSAIFN0ZXAgMiDigJQgb3JpZ2luYWwgLmltcyB2aWEgaGFyZCBsaW5rIChjb3B5IGZhbGxiYWNr
#5#KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIANCmRlZiBwbGFjZV9pbXMoaW1zX3NyYywgb3V0X3BhdGgsIGZvcmNlLCBkcnkpOg0KICAg
#5#IGlmIG91dF9wYXRoLmV4aXN0cygpIGFuZCBub3QgZm9yY2U6DQogICAgICAgIHJldHVybiAic2tp
#5#cCAoZXhpc3RzKSINCiAgICBpZiBkcnk6DQogICAgICAgIHJldHVybiBmIndvdWxkIGxpbmsge2Zt
#5#dF9zaXplKGltc19zcmMuc3RhdCgpLnN0X3NpemUpfSINCiAgICBpZiBvdXRfcGF0aC5leGlzdHMo
#5#KToNCiAgICAgICAgb3V0X3BhdGgudW5saW5rKCkNCiAgICB0cnk6DQogICAgICAgIG9zLmxpbmso
#5#aW1zX3NyYywgb3V0X3BhdGgpICAgICAgICAgICAgICAgICAgICAgICMgaGFyZCBsaW5rLCAwIGV4
#5#dHJhIGJ5dGVzDQogICAgICAgIHJldHVybiBmImhhcmRsaW5rIHtmbXRfc2l6ZShvdXRfcGF0aC5z
#5#dGF0KCkuc3Rfc2l6ZSl9Ig0KICAgIGV4Y2VwdCBPU0Vycm9yOg0KICAgICAgICBzaHV0aWwuY29w
#5#eTIoaW1zX3NyYywgb3V0X3BhdGgpICAgICAgICAgICAgICAgICAjIGNyb3NzLXZvbHVtZSBmYWxs
#5#YmFjaw0KICAgICAgICByZXR1cm4gZiJjb3B5IHtmbXRfc2l6ZShvdXRfcGF0aC5zdGF0KCkuc3Rf
#5#c2l6ZSl9Ig0KDQoNCiMg4pSA4pSAIFN0ZXAgMy80IOKAlCBPTUUtVElGRiAoKyBwZXItY2hhbm5l
#5#bCBNSVApIGZyb20gdGhlIC5pbXMgcHlyYW1pZCDilIDilIDilIDilIDilIDilIDilIDilIDilIDi
#5#lIDilIANCmRlZiBsaXN0X2xldmVscyhmKToNCiAgICAiIiJbKEwsIFhyLCBZciwgWnIpXSBmcm9t
#5#IHRoZSBJbWFyaXMgUmVzb2x1dGlvbkxldmVsIGdyb3VwcyAocmVhbCBzaXplcykuIiIiDQogICAg
#5#ZGF0YXNldCA9IGZbIkRhdGFTZXQiXQ0KICAgIG91dCA9IFtdDQogICAgZm9yIGtleSBpbiBkYXRh
#5#c2V0LmtleXMoKToNCiAgICAgICAgaWYgbm90IGtleS5zdGFydHN3aXRoKCJSZXNvbHV0aW9uTGV2
#5#ZWwiKToNCiAgICAgICAgICAgIGNvbnRpbnVlDQogICAgICAgIEwgPSBpbnQoa2V5LnNwbGl0KClb
#5#LTFdKQ0KICAgICAgICB0cCA9IGRhdGFzZXRba2V5XS5nZXQoIlRpbWVQb2ludCAwIikNCiAgICAg
#5#ICAgaWYgdHAgaXMgTm9uZToNCiAgICAgICAgICAgIGNvbnRpbnVlDQogICAgICAgIGNoMCA9IHRw
#5#LmdldCgiQ2hhbm5lbCAwIikNCiAgICAgICAgaWYgY2gwIGlzIE5vbmU6DQogICAgICAgICAgICBj
#5#b250aW51ZQ0KICAgICAgICB4ciA9IGludChhdHRyX3N0cihjaDAsICJJbWFnZVNpemVYIiwgIjAi
#5#KSBvciAwKQ0KICAgICAgICB5ciA9IGludChhdHRyX3N0cihjaDAsICJJbWFnZVNpemVZIiwgIjAi
#5#KSBvciAwKQ0KICAgICAgICB6ciA9IGludChhdHRyX3N0cihjaDAsICJJbWFnZVNpemVaIiwgIjAi
#5#KSBvciAwKQ0KICAgICAgICBpZiBub3QgKHhyIGFuZCB5ciBhbmQgenIpOg0KICAgICAgICAgICAg
#5#ZGF0YSA9IGNoMC5nZXQoIkRhdGEiKQ0KICAgICAgICAgICAgaWYgZGF0YSBpcyBOb25lOg0KICAg
#5#ICAgICAgICAgICAgIGNvbnRpbnVlDQogICAgICAgICAgICB6ciwgeXIsIHhyID0gKHpyIG9yIGRh
#5#dGEuc2hhcGVbMF0sIHlyIG9yIGRhdGEuc2hhcGVbMV0sIHhyIG9yIGRhdGEuc2hhcGVbMl0pDQog
#5#ICAgICAgIG91dC5hcHBlbmQoKEwsIHhyLCB5ciwgenIpKQ0KICAgIHJldHVybiBzb3J0ZWQob3V0
#5#LCBrZXk9bGFtYmRhIGx2OiBsdlswXSkNCg0KDQpkZWYgaW1zX2NoYW5uZWxfbmFtZXMoZiwgbl9j
#5#aCk6DQogICAgIiIiQ2hhbm5lbCBkaXNwbGF5IG5hbWVzIGZyb20gRGF0YVNldEluZm8vQ2hhbm5l
#5#bCB7aX07ICcnIHdoZW4gbWlzc2luZyBvciBhDQogICAgZ2VuZXJpYyAnQ2hhbm5lbCBOJyBwbGFj
#5#ZWhvbGRlciwgc28gdGhlIGNhbGxlciBjYW4gZmFsbCBiYWNrIGNsZWFubHkuIiIiDQogICAgaW5m
#5#byA9IGYuZ2V0KCJEYXRhU2V0SW5mbyIsIHt9KQ0KICAgIG5hbWVzID0gW10NCiAgICBmb3IgaSBp
#5#biByYW5nZShuX2NoKToNCiAgICAgICAgY2ggPSBpbmZvLmdldChmIkNoYW5uZWwge2l9IikgaWYg
#5#aGFzYXR0cihpbmZvLCAiZ2V0IikgZWxzZSBOb25lDQogICAgICAgIG5tID0gcmUuc3ViKHIiXHgw
#5#MC4qIiwgIiIsIGF0dHJfc3RyKGNoLCAiTmFtZSIsICIiKSkuc3RyaXAoKSBpZiBjaCBpcyBub3Qg
#5#Tm9uZSBlbHNlICIiDQogICAgICAgIGlmIHJlLm1hdGNoKHIiXmNoKGFubmVsKT9ccypcZCskIiwg
#5#bm0sIHJlLklHTk9SRUNBU0UpOg0KICAgICAgICAgICAgbm0gPSAiIg0KICAgICAgICBuYW1lcy5h
#5#cHBlbmQobm0pDQogICAgcmV0dXJuIG5hbWVzDQoNCg0KZGVmIGNob29zZV9sZXZlbChsZXZlbHMs
#5#IG5fY2gsIHRhcmdldF9weCwgbWF4X2J5dGVzKToNCiAgICAiIiJMZXZlbCB3aG9zZSBsb25nIFhZ
#5#IHNpZGUgaXMgY2xvc2VzdCB0byB0YXJnZXRfcHgsIHN0ZXBwaW5nIHNtYWxsZXIgaWYgdGhlDQog
#5#ICAgaW4tZmxpZ2h0IHZvbHVtZSB3b3VsZCBleGNlZWQgbWF4X2J5dGVzLiIiIg0KICAgIGNob3Nl
#5#biA9IG1pbihsZXZlbHMsIGtleT1sYW1iZGEgbHY6IGFicyhtYXgobHZbMV0sIGx2WzJdKSAtIHRh
#5#cmdldF9weCkpDQogICAgd2hpbGUgY2hvc2VuWzFdICogY2hvc2VuWzJdICogY2hvc2VuWzNdICog
#5#bl9jaCAqIDIgPiBtYXhfYnl0ZXM6DQogICAgICAgIHNtYWxsZXIgPSBbbHYgZm9yIGx2IGluIGxl
#5#dmVscyBpZiBsdlswXSA+IGNob3NlblswXV0NCiAgICAgICAgaWYgbm90IHNtYWxsZXI6DQogICAg
#5#ICAgICAgICBicmVhaw0KICAgICAgICBjaG9zZW4gPSBtaW4oc21hbGxlciwga2V5PWxhbWJkYSBs
#5#djogbHZbMF0pDQogICAgcmV0dXJuIGNob3Nlbg0KDQoNCmRlZiBidWlsZF90aWZmX2FuZF9taXBz
#5#KGltc19zcmMsIGRzX2RpciwgZm9sZGVyLCBjaGFubmVsc19tZXRhLCB0aWZmX3BhdGgsDQogICAg
#5#ICAgICAgICAgICAgICAgICAgICBtaXBfcGF0aHNfZm9yLCB3YW50X3RpZmYsIHdhbnRfbWlwLCBm
#5#b3JjZSwgZHJ5KToNCiAgICAiIiJSZXR1cm5zIGEgc3RhdHVzIHN0cmluZy4gUmVhZHMgT05FIHB5
#5#cmFtaWQgbGV2ZWwgKOKJiFRBUkdFVF9QWCksIHN0cmVhbXMgaXQNCiAgICBpbnRvIGEgZGlzay1i
#5#YWNrZWQgbWVtbWFwIGluIHRoZSBzeXN0ZW0gdGVtcCBkaXIgKGxvdyBSQU0sIG5ldmVyIGxpdHRl
#5#cnMNCiAgICBkb3dubG9hZC8pLCB3cml0ZXMgYSBjYWxpYnJhdGVkIE9NRS1USUZGLCBhbmQgZW1p
#5#dHMgcGVyLWNoYW5uZWwgTUlQIFBOR3MuIiIiDQogICAgaW1wb3J0IGg1cHkNCg0KICAgIHRpZmZf
#5#ZG9uZSA9IHRpZmZfcGF0aC5leGlzdHMoKSBhbmQgbm90IGZvcmNlDQogICAgaWYgZHJ5Og0KICAg
#5#ICAgICByZXR1cm4gIndvdWxkIGJ1aWxkIHRpZmYrbWlwcyINCg0KICAgIHdpdGggaDVweS5GaWxl
#5#KHN0cihpbXNfc3JjKSwgInIiKSBhcyBmOg0KICAgICAgICBpbmZvID0gZi5nZXQoIkRhdGFTZXRJ
#5#bmZvIiwge30pLmdldCgiSW1hZ2UiLCBOb25lKQ0KICAgICAgICBsZXZlbHMgPSBsaXN0X2xldmVs
#5#cyhmKQ0KICAgICAgICBpZiBub3QgbGV2ZWxzOg0KICAgICAgICAgICAgcmV0dXJuICJubyByZXNv
#5#bHV0aW9uIGxldmVscyINCiAgICAgICAgdHAwID0gZlsiRGF0YVNldCJdWyJSZXNvbHV0aW9uTGV2
#5#ZWwgMCJdWyJUaW1lUG9pbnQgMCJdDQogICAgICAgIGNoX2tleXMgPSBzb3J0ZWQoW2sgZm9yIGsg
#5#aW4gdHAwLmtleXMoKSBpZiBrLnN0YXJ0c3dpdGgoIkNoYW5uZWwiKV0sDQogICAgICAgICAgICAg
#5#ICAgICAgICAgICAga2V5PWxhbWJkYSBzOiBpbnQocy5zcGxpdCgpWy0xXSkpDQogICAgICAgIG5f
#5#Y2ggPSBsZW4oY2hfa2V5cykNCg0KICAgICAgICAjIENoYW5uZWwgbmFtZXM6IHByZWZlciB0aGUg
#5#Y3VyYXRlZCBjYXRhbG9nIG5hbWUsIGVsc2UgdGhlIC5pbXMgbmFtZSwNCiAgICAgICAgIyBlbHNl
#5#IGEgZ2VuZXJpYyBwbGFjZWhvbGRlci4gQ29sb3VycyBjb21lIGZyb20gdGhlIGNhdGFsb2cgd2hl
#5#biBwcmVzZW50Lg0KICAgICAgICBjYXQgPSBfcGFkKGNoYW5uZWxzX21ldGEsIG5fY2gpDQogICAg
#5#ICAgIGltc19uYW1lcyA9IGltc19jaGFubmVsX25hbWVzKGYsIG5fY2gpDQogICAgICAgIGNoX25h
#5#bWVzID0gWyhjYXRbaV0uZ2V0KCJuYW1lIikgb3IgaW1zX25hbWVzW2ldIG9yIGYiQ2hhbm5lbCB7
#5#aSsxfSIpIGZvciBpIGluIHJhbmdlKG5fY2gpXQ0KDQogICAgICAgIEwsIFhyLCBZciwgWnIgPSBj
#5#aG9vc2VfbGV2ZWwobGV2ZWxzLCBuX2NoLCBUQVJHRVRfUFgsIE1BWF9USUZGX0JZVEVTKQ0KDQog
#5#ICAgICAgICMgUGh5c2ljYWwgZXh0ZW50IGlzIGxldmVsLWluZGVwZW5kZW50IOKGkiB2b3hlbCBz
#5#aXplID0gZXh0ZW50IC8gbGV2ZWwgZGltcy4NCiAgICAgICAgZXh0ID0gbGFtYmRhIGxvLCBoaTog
#5#KGF0dHJfZmxvYXQoaW5mbywgaGksIDEuMCkgLSBhdHRyX2Zsb2F0KGluZm8sIGxvLCAwLjApKQ0K
#5#ICAgICAgICB2b3ggPSAoDQogICAgICAgICAgICBleHQoIkV4dE1pbjAiLCAiRXh0TWF4MCIpIC8g
#5#bWF4KFhyLCAxKSwNCiAgICAgICAgICAgIGV4dCgiRXh0TWluMSIsICJFeHRNYXgxIikgLyBtYXgo
#5#WXIsIDEpLA0KICAgICAgICAgICAgZXh0KCJFeHRNaW4yIiwgIkV4dE1heDIiKSAvIG1heChaciwg
#5#MSksDQogICAgICAgICkNCg0KICAgICAgICBiYXNlID0gZlsiRGF0YVNldCJdW2YiUmVzb2x1dGlv
#5#bkxldmVsIHtMfSJdWyJUaW1lUG9pbnQgMCJdDQogICAgICAgIHRtcF9kaXIgPSBQYXRoKHRlbXBm
#5#aWxlLm1rZHRlbXAocHJlZml4PSJsdW1lbl9idW5kbGVfIikpDQogICAgICAgIG1lbW1hcF9wYXRo
#5#ID0gdG1wX2RpciAvIGYie2ZvbGRlcn0udm9sLmRhdCINCiAgICAgICAgYXJyID0gbnAubWVtbWFw
#5#KG1lbW1hcF9wYXRoLCBkdHlwZT1ucC51aW50MTYsIG1vZGU9IncrIiwgc2hhcGU9KG5fY2gsIFpy
#5#LCBZciwgWHIpKQ0KICAgICAgICBtaXBzID0gW10NCiAgICAgICAgdHJ5Og0KICAgICAgICAgICAg
#5#Zm9yIGNpLCBjayBpbiBlbnVtZXJhdGUoY2hfa2V5cyk6DQogICAgICAgICAgICAgICAgZGF0YSA9
#5#IGJhc2VbY2tdWyJEYXRhIl0NCiAgICAgICAgICAgICAgICBmb3IgeiBpbiByYW5nZShacik6ICAg
#5#ICAgICAgICAgICAgICAgICAgIyBwbGFuZS1ieS1wbGFuZSDihpIgbG93IFJBTQ0KICAgICAgICAg
#5#ICAgICAgICAgICBhcnJbY2ksIHpdID0gZGF0YVt6LCA6WXIsIDpYcl0NCiAgICAgICAgICAgICAg
#5#ICBtaXBzLmFwcGVuZChucC5hc2FycmF5KGFycltjaV0pLm1heChheGlzPTApKSAgIyB1aW50MTYg
#5#KFlyLFhyKQ0KICAgICAgICAgICAgYXJyLmZsdXNoKCkNCg0KICAgICAgICAgICAgc3RhdHVzID0g
#5#W10NCiAgICAgICAgICAgIGlmIHdhbnRfdGlmZiBhbmQgbm90IHRpZmZfZG9uZToNCiAgICAgICAg
#5#ICAgICAgICBpbXBvcnQgdGlmZmZpbGUNCiAgICAgICAgICAgICAgICB0bXBfdGlmID0gdGlmZl9w
#5#YXRoLndpdGhfc3VmZml4KCIudGlmLnRtcCIpDQogICAgICAgICAgICAgICAgdGlmZmZpbGUuaW13
#5#cml0ZSgNCiAgICAgICAgICAgICAgICAgICAgc3RyKHRtcF90aWYpLCBucC5hc2FycmF5KGFyciks
#5#IGJpZ3RpZmY9VHJ1ZSwgb21lPVRydWUsDQogICAgICAgICAgICAgICAgICAgIHBob3RvbWV0cmlj
#5#PSJtaW5pc2JsYWNrIiwgY29tcHJlc3Npb249InpsaWIiLA0KICAgICAgICAgICAgICAgICAgICBt
#5#ZXRhZGF0YT17DQogICAgICAgICAgICAgICAgICAgICAgICAiYXhlcyI6ICJDWllYIiwNCiAgICAg
#5#ICAgICAgICAgICAgICAgICAgICJQaHlzaWNhbFNpemVYIjogdm94WzBdLCAiUGh5c2ljYWxTaXpl
#5#WFVuaXQiOiAiwrVtIiwNCiAgICAgICAgICAgICAgICAgICAgICAgICJQaHlzaWNhbFNpemVZIjog
#5#dm94WzFdLCAiUGh5c2ljYWxTaXplWVVuaXQiOiAiwrVtIiwNCiAgICAgICAgICAgICAgICAgICAg
#5#ICAgICJQaHlzaWNhbFNpemVaIjogdm94WzJdLCAiUGh5c2ljYWxTaXplWlVuaXQiOiAiwrVtIiwN
#5#CiAgICAgICAgICAgICAgICAgICAgICAgICJDaGFubmVsIjogeyJOYW1lIjogY2hfbmFtZXN9LA0K
#5#ICAgICAgICAgICAgICAgICAgICB9LA0KICAgICAgICAgICAgICAgICkNCiAgICAgICAgICAgICAg
#5#ICBvcy5yZXBsYWNlKHRtcF90aWYsIHRpZmZfcGF0aCkNCiAgICAgICAgICAgICAgICBzdGF0dXMu
#5#YXBwZW5kKGYidGlmZiBMe0x9IHtYcn14e1lyfXh7WnJ9IHtmbXRfc2l6ZSh0aWZmX3BhdGguc3Rh
#5#dCgpLnN0X3NpemUpfSIpDQogICAgICAgICAgICBlbGlmIHdhbnRfdGlmZjoNCiAgICAgICAgICAg
#5#ICAgICBzdGF0dXMuYXBwZW5kKCJ0aWZmIHNraXAgKGV4aXN0cykiKQ0KDQogICAgICAgICAgICBp
#5#ZiB3YW50X21pcDoNCiAgICAgICAgICAgICAgICBmcm9tIFBJTCBpbXBvcnQgSW1hZ2UNCiAgICAg
#5#ICAgICAgICAgICBtYWRlID0gMA0KICAgICAgICAgICAgICAgIGZvciBjaSwgbWlwIGluIGVudW1l
#5#cmF0ZShtaXBzKToNCiAgICAgICAgICAgICAgICAgICAgb3V0ID0gbWlwX3BhdGhzX2ZvcihjaSwg
#5#Y2hfbmFtZXNbY2ldKQ0KICAgICAgICAgICAgICAgICAgICBpZiBvdXQuZXhpc3RzKCkgYW5kIG5v
#5#dCBmb3JjZToNCiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlDQogICAgICAgICAgICAg
#5#ICAgICAgIHJnYiA9IGhleF90b19yZ2IoY2F0W2NpXS5nZXQoImNvbG9yIiksIFRIVU1CX0NPTE9S
#5#U1tjaSAlIGxlbihUSFVNQl9DT0xPUlMpXSkNCiAgICAgICAgICAgICAgICAgICAgbm9ybSA9IF9h
#5#dXRvc2NhbGUobWlwKSAgICAgICAgICAgICAgIyAwLi4xIGZsb2F0DQogICAgICAgICAgICAgICAg
#5#ICAgIGltZyA9IG5wLnplcm9zKChtaXAuc2hhcGVbMF0sIG1pcC5zaGFwZVsxXSwgMyksIGR0eXBl
#5#PW5wLnVpbnQ4KQ0KICAgICAgICAgICAgICAgICAgICBmb3IgayBpbiByYW5nZSgzKToNCiAgICAg
#5#ICAgICAgICAgICAgICAgICAgIGltZ1s6LCA6LCBrXSA9IG5wLmNsaXAobm9ybSAqIHJnYltrXSwg
#5#MCwgMjU1KS5hc3R5cGUobnAudWludDgpDQogICAgICAgICAgICAgICAgICAgIEltYWdlLmZyb21h
#5#cnJheShpbWcsICJSR0IiKS5zYXZlKHN0cihvdXQpKQ0KICAgICAgICAgICAgICAgICAgICBtYWRl
#5#ICs9IDENCiAgICAgICAgICAgICAgICBzdGF0dXMuYXBwZW5kKGYie21hZGV9IE1JUCBwbmciKQ0K
#5#ICAgICAgICAgICAgcmV0dXJuICI7ICIuam9pbihzdGF0dXMpIG9yICJub3RoaW5nIHRvIGRvIg0K
#5#ICAgICAgICBmaW5hbGx5Og0KICAgICAgICAgICAgZGVsIGFycg0KICAgICAgICAgICAgc2h1dGls
#5#LnJtdHJlZSh0bXBfZGlyLCBpZ25vcmVfZXJyb3JzPVRydWUpDQoNCg0KZGVmIF9wYWQoY2hhbm5l
#5#bHNfbWV0YSwgbik6DQogICAgY20gPSBsaXN0KGNoYW5uZWxzX21ldGEgb3IgW10pDQogICAgd2hp
#5#bGUgbGVuKGNtKSA8IG46DQogICAgICAgIGNtLmFwcGVuZCh7fSkNCiAgICByZXR1cm4gY20NCg0K
#5#DQpkZWYgX2F1dG9zY2FsZShwbGFuZSk6DQogICAgIiIiUm9idXN0IDAuLjEgbm9ybWFsaXNhdGlv
#5#biAoMXN04oCTOTkuOXRoIHBlcmNlbnRpbGUpIGZvciBhIHVpbnQxNiBNSVAuIiIiDQogICAgcCA9
#5#IHBsYW5lLmFzdHlwZShucC5mbG9hdDMyKQ0KICAgIGxvID0gZmxvYXQobnAucGVyY2VudGlsZShw
#5#LCAxLjApKQ0KICAgIGhpID0gZmxvYXQobnAucGVyY2VudGlsZShwLCA5OS45KSkNCiAgICBpZiBo
#5#aSA8PSBsbzoNCiAgICAgICAgaGkgPSBmbG9hdChwLm1heCgpKSBvciAxLjANCiAgICAgICAgbG8g
#5#PSAwLjANCiAgICByZXR1cm4gbnAuY2xpcCgocCAtIGxvKSAvIChoaSAtIGxvKSwgMC4wLCAxLjAp
#5#DQoNCg0KIyDilIDilIAgU3RlcCA1IOKAlCBSRUFETUUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQpkZWYgd3JpdGVfcmVhZG1lKG91dF9w
#5#YXRoLCBkcywgaW1zX3NyYywgZm9yY2UsIGRyeSk6DQogICAgaWYgb3V0X3BhdGguZXhpc3RzKCkg
#5#YW5kIG5vdCBmb3JjZToNCiAgICAgICAgcmV0dXJuICJza2lwIChleGlzdHMpIg0KICAgIGlmIGRy
#5#eToNCiAgICAgICAgcmV0dXJuICJ3b3VsZCB3cml0ZSINCiAgICBtZXRhID0gZHNbIm1ldGEiXQ0K
#5#ICAgIGRpbXMgPSBtZXRhLmdldCgiZGltZW5zaW9ucyIsIHt9KQ0KICAgIHZveCA9IG1ldGEuZ2V0
#5#KCJ2b3hlbF9zaXplIiwge30pDQogICAgY2hhbnMgPSBtZXRhLmdldCgiY2hhbm5lbHMiLCBbXSkN
#5#CiAgICBsaW5lcyA9IFsNCiAgICAgICAgZiJEYXRhc2V0IDoge2RzWydmb2xkZXInXX0iLA0KICAg
#5#ICAgICBmIlR5cGUgICAgOiB7ZHNbJ3R5cGUnXX0iLA0KICAgICAgICBmIlN0YWdlICAgOiB7bWV0
#5#YS5nZXQoJ3N0YWdlJywgJz8nKX0gICAgRW1icnlvOiB7bWV0YS5nZXQoJ2VtYnJ5bycsICc/Jyl9
#5#IiwNCiAgICAgICAgIiIsDQogICAgICAgICJEaW1lbnNpb25zICh2b3hlbHMpIDogIg0KICAgICAg
#5#ICBmIlg9e2RpbXMuZ2V0KCd4JywnPycpfSAgWT17ZGltcy5nZXQoJ3knLCc/Jyl9ICBaPXtkaW1z
#5#LmdldCgneicsJz8nKX0gICINCiAgICAgICAgZiJDPXtkaW1zLmdldCgnYycsJz8nKX0gIFQ9e2Rp
#5#bXMuZ2V0KCd0JywnPycpfSIsDQogICAgICAgICJWb3hlbCBzaXplICjCtW0pICAgICA6ICINCiAg
#5#ICAgICAgZiJYPXt2b3guZ2V0KCd4JywnPycpfSAgWT17dm94LmdldCgneScsJz8nKX0gIFo9e3Zv
#5#eC5nZXQoJ3onLCc/Jyl9IiwNCiAgICAgICAgIiIsDQogICAgICAgICJDaGFubmVsczoiLA0KICAg
#5#IF0NCiAgICBmb3IgaSwgYyBpbiBlbnVtZXJhdGUoY2hhbnMpOg0KICAgICAgICBsaW5lcy5hcHBl
#5#bmQoZiIgIEN7aSsxfToge2MuZ2V0KCduYW1lJywnPycpfSAgY29sb3I9e2MuZ2V0KCdjb2xvcics
#5#Jz8nKX0gICINCiAgICAgICAgICAgICAgICAgICAgIGYiZ2FtbWE9e2MuZ2V0KCdnYW1tYScsJz8n
#5#KX0iKQ0KICAgIGxpbmVzICs9IFsNCiAgICAgICAgIiIsDQogICAgICAgICJGaWxlcyBpbiB0aGlz
#5#IGZvbGRlcjoiLA0KICAgICAgICBmIiAge2RzWydmb2xkZXInXX1fd2ViLnppcCAgIGFyY2hpdmUg
#5#b2YgdGhlIHdlYi9wcmVwcm9jZXNzZWQgZGF0YXNldCAiDQogICAgICAgICIoYnJpY2tzICsgbWV0
#5#YWRhdGEgKyB0aHVtYm5haWwpIiwNCiAgICAgICAgZiIgIHtkc1snZm9sZGVyJ119LmltcyAgICAg
#5#ICBvcmlnaW5hbCBJbWFyaXMgYWNxdWlzaXRpb24iDQogICAgICAgICsgKGYiICAoe2ZtdF9zaXpl
#5#KGltc19zcmMuc3RhdCgpLnN0X3NpemUpfSkiIGlmIGltc19zcmMgYW5kIGltc19zcmMuZXhpc3Rz
#5#KCkgZWxzZSAiIChub3QgYXZhaWxhYmxlKSIpLA0KICAgICAgICBmIiAge2RzWydmb2xkZXInXX0u
#5#b21lLnRpZiAgIG11bHRpLWNoYW5uZWwgT01FLVRJRkYgKMK1bS1jYWxpYnJhdGVkLCB+e1RBUkdF
#5#VF9QWH1weCksICINCiAgICAgICAgImZyb20gdGhlIC5pbXMgcHlyYW1pZCIsDQogICAgICAgIGYi
#5#ICB7ZHNbJ2ZvbGRlciddfV9DKl8qX01JUC5wbmcgICBwZXItY2hhbm5lbCBtYXhpbXVtLWludGVu
#5#c2l0eSBwcm9qZWN0aW9uIiwNCiAgICAgICAgIiIsDQogICAgICAgICJDaXRhdGlvbjogY2l0ZSB0
#5#aGUgSVJJQkhNIE1pY3Jvc2NvcHkgUGxhdGZvcm0gKEx1bWVuM0QsIElSSUJITSBAIFVMQikgYW5k
#5#ICINCiAgICAgICAgInRoZSBvcmlnaW5hbCBleHBlcmltZW50L3B1YmxpY2F0aW9uIHdoZW4gYXZh
#5#aWxhYmxlLiIsDQogICAgICAgIGYiR2VuZXJhdGVkOiB7dGltZS5zdHJmdGltZSgnJVktJW0tJWQg
#5#JUg6JU06JVMnKX0iLA0KICAgIF0NCiAgICBvdXRfcGF0aC53cml0ZV90ZXh0KCJcbiIuam9pbihs
#5#aW5lcyksIGVuY29kaW5nPSJ1dGYtOCIpDQogICAgcmV0dXJuICJvayINCg0KDQojIOKUgOKUgCBo
#5#ZWxwZXJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU
#5#gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KZGVmIGZtdF9zaXplKG4pOg0KICAgIG4g
#5#PSBmbG9hdChuKQ0KICAgIGZvciB1bml0IGluICgiQiIsICJLQiIsICJNQiIsICJHQiIsICJUQiIp
#5#Og0KICAgICAgICBpZiBuIDwgMTAyNCBvciB1bml0ID09ICJUQiI6DQogICAgICAgICAgICByZXR1
#5#cm4gZiJ7bjouMWZ9IHt1bml0fSIgaWYgdW5pdCAhPSAiQiIgZWxzZSBmIntpbnQobil9IEIiDQog
#5#ICAgICAgIG4gLz0gMTAyNA0KDQoNCiMg4pSA4pSAIG1haW4g4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA
#5#4pSA4pSA4pSA4pSADQpkZWYgcHJvY2VzcyhkcywgYXJncyk6DQogICAgZm9sZGVyID0gZHNbImZv
#5#bGRlciJdDQogICAgZGwgPSBkc1siZGlyIl0gLyAiZG93bmxvYWQiDQogICAgcHJpbnQoZiJcbj09
#5#PSB7ZHNbJ2lkJ119ID09PSIpDQogICAgaWYgbm90IGFyZ3MuZHJ5X3J1bjoNCiAgICAgICAgZGwu
#5#bWtkaXIocGFyZW50cz1UcnVlLCBleGlzdF9vaz1UcnVlKQ0KDQogICAgIyAxLiBhcmNoaXZlIEZJ
#5#UlNUIChkb3dubG9hZC8gaXMgZXhjbHVkZWQgcmVnYXJkbGVzcyBvZiBvcmRlcikNCiAgICBpZiBu
#5#b3QgYXJncy5ub19hcmNoaXZlOg0KICAgICAgICB0cnk6DQogICAgICAgICAgICBwcmludChmIiAg
#5#W2FyY2hpdmVdIHtidWlsZF9hcmNoaXZlKGRzWydkaXInXSwgZm9sZGVyLCBkbCAvIGYne2ZvbGRl
#5#cn1fd2ViLnppcCcsIGFyZ3MuZm9yY2UsIGFyZ3MuZHJ5X3J1bil9IikNCiAgICAgICAgZXhjZXB0
#5#IEV4Y2VwdGlvbiBhcyBleGM6DQogICAgICAgICAgICBwcmludChmIiAgW2FyY2hpdmVdIEZBSUxF
#5#RDoge2V4Y30iKQ0KDQogICAgaW1zX3NyYyA9IGZpbmRfaW1zKGZvbGRlcikNCiAgICBpZiBpbXNf
#5#c3JjIGlzIE5vbmUgYW5kIG5vdCAoYXJncy5ub19pbXMgYW5kIGFyZ3Mubm9fdGlmZik6DQogICAg
#5#ICAgIHByaW50KGYiICBbLmltc10gbm90IGZvdW5kIGluIFJBV19EQVRBIGZvciAne2ZvbGRlcn0n
#5#IOKAlCBza2lwcGluZyBpbXMvdGlmZi9taXAiKQ0KDQogICAgIyAyLiBvcmlnaW5hbCAuaW1zICho
#5#YXJkIGxpbmspDQogICAgaWYgbm90IGFyZ3Mubm9faW1zIGFuZCBpbXNfc3JjIGlzIG5vdCBOb25l
#5#Og0KICAgICAgICB0cnk6DQogICAgICAgICAgICBwcmludChmIiAgWy5pbXNdIHtwbGFjZV9pbXMo
#5#aW1zX3NyYywgZGwgLyBmJ3tmb2xkZXJ9LmltcycsIGFyZ3MuZm9yY2UsIGFyZ3MuZHJ5X3J1bil9
#5#IikNCiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBleGM6DQogICAgICAgICAgICBwcmludChm
#5#IiAgWy5pbXNdIEZBSUxFRDoge2V4Y30iKQ0KDQogICAgIyAzLzQuIE9NRS1USUZGICsgcGVyLWNo
#5#YW5uZWwgTUlQDQogICAgaWYgKG5vdCBhcmdzLm5vX3RpZmYgb3Igbm90IGFyZ3Mubm9fbWlwKSBh
#5#bmQgaW1zX3NyYyBpcyBub3QgTm9uZToNCiAgICAgICAgY2hhbm5lbHNfbWV0YSA9IGRzWyJtZXRh
#5#Il0uZ2V0KCJjaGFubmVscyIsIFtdKQ0KICAgICAgICBkZWYgbWlwX3BhdGgoY2ksIG5hbWUpOg0K
#5#ICAgICAgICAgICAgc2FmZSA9IHJlLnN1YihyIlteQS1aYS16MC05Ll8tXSsiLCAiXyIsIHN0cihu
#5#YW1lKSkuc3RyaXAoIl8iKSBvciBmIkN7Y2krMX0iDQogICAgICAgICAgICByZXR1cm4gZGwgLyBm
#5#Intmb2xkZXJ9X0N7Y2krMX1fe3NhZmV9X01JUC5wbmciDQogICAgICAgIHRyeToNCiAgICAgICAg
#5#ICAgIHByaW50KGYiICBbdGlmZi9taXBdIHtidWlsZF90aWZmX2FuZF9taXBzKGltc19zcmMsIGRz
#5#WydkaXInXSwgZm9sZGVyLCBjaGFubmVsc19tZXRhLCBkbCAvIGYne2ZvbGRlcn0ub21lLnRpZics
#5#IG1pcF9wYXRoLCBub3QgYXJncy5ub190aWZmLCBub3QgYXJncy5ub19taXAsIGFyZ3MuZm9yY2Us
#5#IGFyZ3MuZHJ5X3J1bil9IikNCiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBleGM6DQogICAg
#5#ICAgICAgICBwcmludChmIiAgW3RpZmYvbWlwXSBGQUlMRUQ6IHtleGN9IikNCg0KICAgICMgNS4g
#5#UkVBRE1FDQogICAgdHJ5Og0KICAgICAgICBwcmludChmIiAgW3JlYWRtZV0ge3dyaXRlX3JlYWRt
#5#ZShkbCAvICdSRUFETUUudHh0JywgZHMsIGltc19zcmMsIGFyZ3MuZm9yY2UsIGFyZ3MuZHJ5X3J1
#5#bil9IikNCiAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGV4YzoNCiAgICAgICAgcHJpbnQoZiIgIFty
#5#ZWFkbWVdIEZBSUxFRDoge2V4Y30iKQ0KDQoNCmRlZiBtYWluKCk6DQogICAgZ2xvYmFsIFRBUkdF
#5#VF9QWCwgREFUQV9XRUIsIFJBV19EQVRBX0RJUlMNCiAgICBhcCA9IGFyZ3BhcnNlLkFyZ3VtZW50
#5#UGFyc2VyKGRlc2NyaXB0aW9uPSJQb3B1bGF0ZSBlYWNoIGRhdGFzZXQncyBkb3dubG9hZC8gZm9s
#5#ZGVyLiIpDQogICAgYXAuYWRkX2FyZ3VtZW50KCItLWRhdGFzZXRzIiwgaGVscD0iY2FzZS1pbnNl
#5#bnNpdGl2ZSBzdWJzdHJpbmcgZmlsdGVyIG9uIGZvbGRlciBuYW1lIikNCiAgICBhcC5hZGRfYXJn
#5#dW1lbnQoIi0tdHlwZXMiLCBkZWZhdWx0PSIsIi5qb2luKERBVEFTRVRfVFlQRVMpLCBoZWxwPSJj
#5#b21tYSBsaXN0OiBmaXhlZCxsaXZlLHRyYWNraW5nIikNCiAgICBhcC5hZGRfYXJndW1lbnQoIi0t
#5#ZGF0YS13ZWIiLCBoZWxwPSJvdmVycmlkZSB0aGUgREFUQV9XRUIgZGlyZWN0b3J5IChkZWZhdWx0
#5#OiA8cmVwbz4vREFUQV9XRUIpIikNCiAgICBhcC5hZGRfYXJndW1lbnQoIi0tcmF3LWRpciIsIGhl
#5#bHA9ImRpcmVjdG9yeSB0byBzZWFyY2ggZmlyc3QgZm9yIHRoZSBzb3VyY2UgLmltcyAocHJlcGVu
#5#ZGVkIHRvIFJBV19EQVRBX0RJUlMpIikNCiAgICBhcC5hZGRfYXJndW1lbnQoIi0tdGlmZi1weCIs
#5#IHR5cGU9aW50LCBkZWZhdWx0PVRBUkdFVF9QWCwgaGVscD0idGFyZ2V0IGxvbmcgWFkgc2lkZSBv
#5#ZiB0aGUgT01FLVRJRkYiKQ0KICAgIGFwLmFkZF9hcmd1bWVudCgiLS1uby1hcmNoaXZlIiwgYWN0
#5#aW9uPSJzdG9yZV90cnVlIikNCiAgICBhcC5hZGRfYXJndW1lbnQoIi0tbm8taW1zIiwgYWN0aW9u
#5#PSJzdG9yZV90cnVlIikNCiAgICBhcC5hZGRfYXJndW1lbnQoIi0tbm8tdGlmZiIsIGFjdGlvbj0i
#5#c3RvcmVfdHJ1ZSIpDQogICAgYXAuYWRkX2FyZ3VtZW50KCItLW5vLW1pcCIsIGFjdGlvbj0ic3Rv
#5#cmVfdHJ1ZSIpDQogICAgYXAuYWRkX2FyZ3VtZW50KCItLWZvcmNlIiwgYWN0aW9uPSJzdG9yZV90
#5#cnVlIiwgaGVscD0icmVidWlsZCBhcnRlZmFjdHMgdGhhdCBhbHJlYWR5IGV4aXN0IikNCiAgICBh
#5#cC5hZGRfYXJndW1lbnQoIi0tZHJ5LXJ1biIsIGFjdGlvbj0ic3RvcmVfdHJ1ZSIpDQogICAgYXJn
#5#cyA9IGFwLnBhcnNlX2FyZ3MoKQ0KDQogICAgVEFSR0VUX1BYID0gYXJncy50aWZmX3B4DQogICAg
#5#aWYgYXJncy5kYXRhX3dlYjoNCiAgICAgICAgREFUQV9XRUIgPSBQYXRoKGFyZ3MuZGF0YV93ZWIp
#5#DQogICAgaWYgYXJncy5yYXdfZGlyOg0KICAgICAgICBSQVdfREFUQV9ESVJTID0gW1BhdGgoYXJn
#5#cy5yYXdfZGlyKV0gKyBSQVdfREFUQV9ESVJTDQogICAgdHlwZXMgPSB0dXBsZSh0LnN0cmlwKCkg
#5#Zm9yIHQgaW4gYXJncy50eXBlcy5zcGxpdCgiLCIpIGlmIHQuc3RyaXAoKSkNCg0KICAgIGRhdGFz
#5#ZXRzID0gbG9hZF9kYXRhc2V0cyhhcmdzLmRhdGFzZXRzLCB0eXBlcykNCiAgICBpZiBub3QgZGF0
#5#YXNldHM6DQogICAgICAgIHByaW50KCJObyBkYXRhc2V0cyBtYXRjaGVkLiIpDQogICAgICAgIHJl
#5#dHVybiAxDQogICAgcHJpbnQoZiJ7bGVuKGRhdGFzZXRzKX0gZGF0YXNldChzKSB0byBwcm9jZXNz
#5#ICINCiAgICAgICAgICBmIihhcmNoaXZlPXtub3QgYXJncy5ub19hcmNoaXZlfSBpbXM9e25vdCBh
#5#cmdzLm5vX2ltc30gIg0KICAgICAgICAgIGYidGlmZj17bm90IGFyZ3Mubm9fdGlmZn0gbWlwPXtu
#5#b3QgYXJncy5ub19taXB9IHRhcmdldD17VEFSR0VUX1BYfXB4ICINCiAgICAgICAgICBmImRyeV9y
#5#dW49e2FyZ3MuZHJ5X3J1bn0pIikNCiAgICB0MCA9IHRpbWUudGltZSgpDQogICAgZm9yIGRzIGlu
#5#IGRhdGFzZXRzOg0KICAgICAgICB0cnk6DQogICAgICAgICAgICBwcm9jZXNzKGRzLCBhcmdzKQ0K
#5#ICAgICAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGV4YzoNCiAgICAgICAgICAgIHByaW50KGYiICBb
#5#ZGF0YXNldF0gRkFJTEVEOiB7ZXhjfSIpDQogICAgcHJpbnQoZiJcbkRvbmUgaW4ge3RpbWUudGlt
#5#ZSgpIC0gdDA6LjBmfXMuIikNCiAgICByZXR1cm4gMA0KDQoNCmlmIF9fbmFtZV9fID09ICJfX21h
#5#aW5fXyI6DQogICAgc3lzLmV4aXQobWFpbigpKQ0K
